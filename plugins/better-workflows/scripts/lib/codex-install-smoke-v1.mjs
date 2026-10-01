// SPDX-License-Identifier: AGPL-3.0-only
// A local installation check. This receipt has no release or signer authority.
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { digestObject, execBoundProcess, safeJoin, sha256 } from "./core.mjs";

const PLUGIN_ID = "better-workflows@better-workflows";
const PLUGIN_NAME = "better-workflows";
const MAX_FILES = 4096;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

function fail(message) {
  throw new Error(`Codex isolated install smoke: ${message}`);
}

function parseJson(output, label) {
  let value;
  try { value = JSON.parse(output); } catch { fail(`${label} returned invalid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} returned a non-object`);
  return value;
}

async function requireDirectory(target, label) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`${label} is not a plain directory`);
  return target;
}

async function rejectSymlinkComponents(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("source path is outside the repository");
  }
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink()) fail("source path contains a symlink");
  }
}

async function requireExecutable(target) {
  if (typeof target !== "string" || !path.isAbsolute(target)) fail("codex executable must be absolute");
  const resolved = await realpath(target);
  const info = await lstat(resolved);
  if (!info.isFile() || (info.mode & 0o111) === 0) fail("codex executable is not a regular executable");
  return resolved;
}

async function inventoryBundle(root) {
  await requireDirectory(root, "plugin bundle");
  const records = [];
  let fileCount = 0;
  let totalBytes = 0;
  const visit = async (relative) => {
    const target = relative ? safeJoin(root, ...relative.split("/")) : root;
    const names = (await readdir(target)).sort((a, b) => a.localeCompare(b, "en"));
    for (const name of names) {
      if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) fail("bundle entry name is invalid");
      const child = relative ? `${relative}/${name}` : name;
      const info = await lstat(safeJoin(root, ...child.split("/")));
      if (info.isSymbolicLink()) fail(`bundle contains a symlink: ${child}`);
      if (info.isDirectory()) {
        records.push({ path: child, kind: "directory" });
        await visit(child);
      } else if (info.isFile() && info.nlink === 1) {
        if (info.size > MAX_FILE_BYTES) fail(`bundle file exceeds size bound: ${child}`);
        const bytes = await readFile(safeJoin(root, ...child.split("/")));
        if (bytes.length !== info.size) fail(`bundle file changed during read: ${child}`);
        fileCount += 1;
        totalBytes += bytes.length;
        if (fileCount > MAX_FILES || totalBytes > MAX_BUNDLE_BYTES) fail("bundle exceeds inventory bounds");
        records.push({ path: child, kind: "file", bytes: bytes.length, digest: sha256(bytes) });
      } else {
        fail(`bundle contains an unsafe entry: ${child}`);
      }
    }
  };
  await visit("");
  return { digest: digestObject(records), fileCount, totalBytes, records };
}

function assertAutoOnly(bundle) {
  const skills = bundle.records.filter((entry) => entry.path.startsWith("skills/"))
    .map((entry) => entry.path);
  const templates = bundle.records.filter((entry) => entry.path.startsWith("templates/"))
    .map((entry) => entry.path);
  if (JSON.stringify(skills) !== JSON.stringify(["skills/auto", "skills/auto/SKILL.md"]) ||
      JSON.stringify(templates) !== JSON.stringify(["templates/auto.json"])) {
    fail("installed public skills or templates are not exactly Auto");
  }
}

export async function inspectCodexPublicBundleV1(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) fail("repositoryRoot must be absolute");
  const repository = await realpath(repositoryRoot);
  await requireDirectory(repository, "repository root");
  const plugin = safeJoin(repository, "plugins", PLUGIN_NAME);
  const marketplacePath = safeJoin(repository, ".agents", "plugins", "marketplace.json");
  await rejectSymlinkComponents(repository, plugin);
  await rejectSymlinkComponents(repository, marketplacePath);
  const marketplace = parseJson(await readFile(marketplacePath, "utf8"), "marketplace manifest");
  if (marketplace.name !== PLUGIN_NAME || !Array.isArray(marketplace.plugins) ||
      marketplace.plugins.length !== 1 || marketplace.plugins[0]?.name !== PLUGIN_NAME ||
      marketplace.plugins[0]?.source?.source !== "local" ||
      marketplace.plugins[0]?.source?.path !== `./plugins/${PLUGIN_NAME}`) {
    fail("local marketplace does not bind the exact public plugin");
  }
  const source = await inventoryBundle(plugin);
  assertAutoOnly(source);
  const manifest = parseJson(await readFile(safeJoin(plugin, ".codex-plugin", "plugin.json"), "utf8"), "plugin manifest");
  if (manifest.name !== PLUGIN_NAME || manifest.skills !== "./skills/" ||
      typeof manifest.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(manifest.version)) {
    fail("public plugin manifest is invalid");
  }
  return { repository, source, manifest };
}

export function assertCodexInstallSmokeReceiptV1(receipt, { source, manifest, codexVersion, nodeVersion }) {
  const keys = [
    "schemaVersion", "kind", "result", "codexVersion", "nodeVersion", "pluginId", "pluginVersion",
    "sourceBundleDigest", "installedBundleDigest", "bundleFileCount", "bundleBytes",
    "installedCliTemplateIds", "persistence", "releaseAuthority"
  ];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(keys.sort()) ||
      receipt.schemaVersion !== 1 || receipt.kind !== "CodexIsolatedInstallSmokeV1" || receipt.result !== "PASS" ||
      receipt.codexVersion !== codexVersion || receipt.nodeVersion !== nodeVersion ||
      receipt.pluginId !== PLUGIN_ID || receipt.pluginVersion !== manifest.version ||
      receipt.sourceBundleDigest !== source.digest || receipt.installedBundleDigest !== source.digest ||
      receipt.bundleFileCount !== source.fileCount || receipt.bundleBytes !== source.totalBytes ||
      JSON.stringify(receipt.installedCliTemplateIds) !== JSON.stringify(["auto"]) ||
      receipt.persistence !== "ephemeral-isolated-home" || receipt.releaseAuthority !== "none") {
    fail("receipt does not bind the pinned CLI and exact public Auto bundle");
  }
  return source.digest;
}

export async function runCodexInstallSmokeV1({ repositoryRoot, codexExecutable, nodeExecutable = process.execPath }) {
  const { repository, source, manifest } = await inspectCodexPublicBundleV1(repositoryRoot);
  const codex = await requireExecutable(codexExecutable);
  const node = await requireExecutable(nodeExecutable);
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "sbw-codex-install-smoke-")));
  const taskHome = path.join(scratch, "home");
  const codexHome = path.join(scratch, "codex-home");
  try {
    await mkdir(taskHome, { mode: 0o700 });
    await mkdir(codexHome, { mode: 0o700 });
  } catch (cause) {
    await rm(scratch, { recursive: true, force: true });
    throw new Error("Codex isolated install scratch initialization failed", { cause });
  }
  const environment = {
    PATH: [path.dirname(node), path.dirname(codex), "/usr/bin", "/bin"].join(path.delimiter),
    HOME: taskHome,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: path.join(taskHome, ".config"),
    LANG: "C",
    LC_ALL: "C",
    CI: "1",
    NO_COLOR: "1",
    SBW_STATE_ROOT: path.join(scratch, "sbw-state"),
    SBW_HOST_ID: "codex"
  };
  const run = async (executable, args, label) => {
    const result = await execBoundProcess(executable, args, {
      cwd: repository,
      env: environment,
      timeoutMs: 30_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      label
    });
    return result.stdout;
  };
  let passed = false;
  try {
    const codexVersionOutput = (await run(codex, ["--version"], "Codex version probe")).trim();
    if (!/^codex-cli \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(codexVersionOutput)) fail("Codex version is malformed");
    const addedMarketplace = parseJson(await run(codex, ["plugin", "marketplace", "add", repository, "--json"], "Codex marketplace add"), "marketplace add");
    if (addedMarketplace.marketplaceName !== PLUGIN_NAME || addedMarketplace.installedRoot !== repository || addedMarketplace.alreadyAdded !== false) {
      fail("isolated marketplace identity differs from the source repository");
    }
    const addedPlugin = parseJson(await run(codex, ["plugin", "add", PLUGIN_ID, "--json"], "Codex plugin add"), "plugin add");
    const expectedInstalled = safeJoin(codexHome, "plugins", "cache", PLUGIN_NAME, PLUGIN_NAME, manifest.version);
    if (addedPlugin.pluginId !== PLUGIN_ID || addedPlugin.version !== manifest.version ||
        addedPlugin.installedPath !== expectedInstalled) fail("installed plugin identity differs from the public manifest");
    const list = parseJson(await run(codex, ["plugin", "list", "--json"], "Codex installed plugin list"), "plugin list");
    if (!Array.isArray(list.installed) || list.installed.length !== 1 ||
        list.installed[0]?.pluginId !== PLUGIN_ID || list.installed[0]?.version !== manifest.version ||
        list.installed[0]?.installed !== true || list.installed[0]?.enabled !== true) {
      fail("isolated Codex installation is missing or ambiguous");
    }
    if (await realpath(expectedInstalled) !== expectedInstalled) fail("installed plugin path is not canonical");
    const installed = await inventoryBundle(expectedInstalled);
    assertAutoOnly(installed);
    if (installed.digest !== source.digest || installed.fileCount !== source.fileCount || installed.totalBytes !== source.totalBytes) {
      fail("installed bundle differs from the source bundle");
    }
    const templates = parseJson(await run(node, [safeJoin(expectedInstalled, "scripts", "sbw.mjs"), "templates"], "Installed Auto CLI"), "installed Auto CLI");
    if (templates.ok !== true || !Array.isArray(templates.templates) || templates.templates.length !== 1 ||
        templates.templates[0]?.name !== "auto") fail("installed CLI did not select only Auto");
    passed = true;
    return Object.freeze({
      schemaVersion: 1,
      kind: "CodexIsolatedInstallSmokeV1",
      result: "PASS",
      codexVersion: codexVersionOutput,
      nodeVersion: process.versions.node,
      pluginId: PLUGIN_ID,
      pluginVersion: manifest.version,
      sourceBundleDigest: source.digest,
      installedBundleDigest: installed.digest,
      bundleFileCount: installed.fileCount,
      bundleBytes: installed.totalBytes,
      installedCliTemplateIds: ["auto"],
      persistence: "ephemeral-isolated-home",
      releaseAuthority: "none"
    });
  } catch (cause) {
    const error = new Error(`Codex isolated install smoke failed; inspection root: ${scratch}`, { cause });
    error.code = "ECODEX_INSTALL_SMOKE";
    error.inspectionRoot = scratch;
    throw error;
  } finally {
    if (passed) await rm(scratch, { recursive: true, force: false });
  }
}
