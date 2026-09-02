import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdtemp, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteJson,
  digestObject,
  execBoundProcess,
  nowIso,
  pluginRoot,
  safeJoin,
  sha256
} from "./core.mjs";

const REGISTRY_PATH = path.join(pluginRoot(), "config", "host-support-v1.json");
const HOST_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUPPORT_TIERS = new Set(["tier1", "preview", "unsupported"]);
const CAPABILITY_STATUSES = new Set(["native", "core-bridge", "unavailable", "unverified"]);
const PLATFORM_TO_OS = new Map([
  ["darwin", "macos"],
  ["linux", "linux"],
  ["win32", "windows"]
]);
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAX_DISTRIBUTION_FILES = 4096;
const MAX_DISTRIBUTION_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DISTRIBUTION_BYTES = 64 * 1024 * 1024;
const CONFORMANCE_PROBE_KINDS = new Set([
  "native-contract",
  "cli-validate",
  "isolated-install",
  "cli-validate-install"
]);
const CONFORMANCE_PROBE_TOKEN = "{distributionRoot}";
const DISTRIBUTION_ROOTS = new Set(["plugin", "repository"]);
const V4_TIER_ONE_CONTRACTS = Object.freeze({
  codex: {
    executable: "codex",
    package: { name: "@openai/codex", version: "0.150.1" },
    manifestPath: ".codex-plugin/plugin.json",
    distributionRoot: "plugin",
    helperPath: "scripts/sbw.mjs",
    probe: { kind: "native-contract", arguments: [], installArguments: null, installedManifestPath: null }
  },
  "claude-code": {
    executable: "claude",
    package: { name: "@anthropic-ai/claude-code", version: "2.1.247" },
    manifestPath: ".claude-plugin/plugin.json",
    distributionRoot: "plugin",
    helperPath: "scripts/sbw.mjs",
    probe: { kind: "cli-validate", arguments: ["plugin", "validate", CONFORMANCE_PROBE_TOKEN, "--strict"], installArguments: null, installedManifestPath: null }
  },
  "gemini-cli": {
    executable: "gemini",
    package: { name: "@google/gemini-cli", version: "0.57.0" },
    manifestPath: "gemini-extension.json",
    distributionRoot: "repository",
    helperPath: "plugins/better-workflows/scripts/sbw.mjs",
    probe: {
      kind: "cli-validate-install",
      arguments: ["extensions", "validate", CONFORMANCE_PROBE_TOKEN],
      installArguments: ["extensions", "install", CONFORMANCE_PROBE_TOKEN, "--consent"],
      installedManifestPath: ".gemini/extensions/better-workflows/gemini-extension.json"
    }
  },
  "qwen-code": {
    executable: "qwen",
    package: { name: "@qwen-code/qwen-code", version: "0.22.2" },
    manifestPath: "qwen-extension.json",
    distributionRoot: "repository",
    helperPath: "plugins/better-workflows/scripts/sbw.mjs",
    probe: {
      kind: "isolated-install",
      arguments: ["extensions", "install", CONFORMANCE_PROBE_TOKEN, "--consent"],
      installArguments: null,
      installedManifestPath: ".qwen/extensions/better-workflows/qwen-extension.json"
    }
  }
});

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function uniqueRecords(records, label) {
  const ids = new Set();
  for (const record of records) {
    if (!record || typeof record.id !== "string" || !HOST_ID.test(record.id)) {
      throw new Error(`${label} contains an invalid id`);
    }
    if (ids.has(record.id)) throw new Error(`${label} contains duplicate id: ${record.id}`);
    ids.add(record.id);
  }
  return ids;
}

function validateRegistry(registry) {
  exactKeys(
    registry,
    ["schemaVersion", "id", "recommended", "operatingSystems", "capabilityDefinitions", "hosts"],
    "Host support registry"
  );
  if (registry.schemaVersion !== 1 || registry.id !== "host-support-v1") {
    throw new Error("Host support registry identity is invalid");
  }
  if (!Array.isArray(registry.operatingSystems) || !Array.isArray(registry.capabilityDefinitions) || !Array.isArray(registry.hosts)) {
    throw new Error("Host support registry collections must be arrays");
  }
  const osIds = uniqueRecords(registry.operatingSystems, "operatingSystems");
  const capabilityIds = uniqueRecords(registry.capabilityDefinitions, "capabilityDefinitions");
  const hostIds = uniqueRecords(registry.hosts, "hosts");
  exactKeys(registry.recommended, ["hostId", "osId", "label", "reason"], "recommended");
  if (!hostIds.has(registry.recommended.hostId) || !osIds.has(registry.recommended.osId)) {
    throw new Error("Recommended host or operating system does not exist");
  }
  if (registry.recommended.hostId !== "codex" || registry.recommended.osId !== "macos") {
    throw new Error("host-support-v1 reference experience must remain macOS + Codex");
  }
  for (const operatingSystem of registry.operatingSystems) {
    exactKeys(operatingSystem, ["id", "displayName", "nodePlatform", "releaseStatus"], `operatingSystems.${operatingSystem.id}`);
    if (!SUPPORT_TIERS.has(operatingSystem.releaseStatus)) {
      throw new Error(`Invalid operating-system support tier: ${operatingSystem.id}`);
    }
    if (operatingSystem.id === "windows" && operatingSystem.releaseStatus === "tier1") {
      throw new Error("Windows must remain Preview for the v4.0.0 support contract");
    }
  }
  for (const capability of registry.capabilityDefinitions) {
    exactKeys(capability, ["id", "displayName"], `capabilityDefinitions.${capability.id}`);
  }
  for (const host of registry.hosts) {
    exactKeys(
      host,
      [
        "id",
        "displayName",
        "supportTier",
        "executable",
        "conformancePackage",
        "conformanceProbe",
        "distributionRoot",
        "helperPath",
        "manifestPath",
        "extensionMechanism",
        "officialDocumentation",
        "osSupport",
        "capabilities",
        "limitations"
      ],
      `hosts.${host.id}`
    );
    if (!SUPPORT_TIERS.has(host.supportTier)) throw new Error(`Invalid support tier for ${host.id}`);
    if (typeof host.executable !== "string" || !host.executable || host.executable.includes(path.sep)) {
      throw new Error(`Host executable must be a command name: ${host.id}`);
    }
    if (host.supportTier === "tier1") {
      exactKeys(host.conformancePackage, ["name", "version"], `hosts.${host.id}.conformancePackage`);
      if (!/^@[a-z0-9._-]+\/[a-z0-9._-]+$/.test(host.conformancePackage.name) || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(host.conformancePackage.version)) {
        throw new Error(`Tier 1 conformance package is invalid: ${host.id}`);
      }
      const releaseContract = V4_TIER_ONE_CONTRACTS[host.id];
      if (!releaseContract || host.executable !== releaseContract.executable ||
          host.conformancePackage.name !== releaseContract.package.name ||
          host.conformancePackage.version !== releaseContract.package.version ||
          host.manifestPath !== releaseContract.manifestPath ||
          host.distributionRoot !== releaseContract.distributionRoot ||
          host.helperPath !== releaseContract.helperPath ||
          digestObject(host.conformanceProbe) !== digestObject(releaseContract.probe)) {
        throw new Error(`Tier 1 v4.0.0 release contract drifted: ${host.id}`);
      }
      exactKeys(
        host.conformanceProbe,
        ["kind", "arguments", "installArguments", "installedManifestPath"],
        `hosts.${host.id}.conformanceProbe`
      );
      if (!CONFORMANCE_PROBE_KINDS.has(host.conformanceProbe.kind) ||
          !Array.isArray(host.conformanceProbe.arguments) || host.conformanceProbe.arguments.length > 8 ||
          host.conformanceProbe.arguments.some((argument) => typeof argument !== "string" || !argument || argument.includes("\0"))) {
        throw new Error(`Tier 1 conformance probe is invalid: ${host.id}`);
      }
      if (!DISTRIBUTION_ROOTS.has(host.distributionRoot) ||
          typeof host.helperPath !== "string" || !host.helperPath ||
          path.isAbsolute(host.helperPath) || host.helperPath.includes("..")) {
        throw new Error(`Tier 1 distribution root or helper path is invalid: ${host.id}`);
      }
      const rootTokens = host.conformanceProbe.arguments.filter((argument) => argument === CONFORMANCE_PROBE_TOKEN).length;
      if (host.conformanceProbe.kind === "native-contract") {
        if (host.conformanceProbe.arguments.length !== 0 ||
            host.conformanceProbe.installArguments !== null ||
            host.conformanceProbe.installedManifestPath !== null) {
          throw new Error(`Native conformance probe must not execute a host command: ${host.id}`);
        }
      } else if (rootTokens !== 1) {
        throw new Error(`Host conformance probe must bind exactly one distribution root: ${host.id}`);
      }
      if (host.conformanceProbe.kind === "cli-validate-install") {
        if (!Array.isArray(host.conformanceProbe.installArguments) ||
            host.conformanceProbe.installArguments.length > 8 ||
            host.conformanceProbe.installArguments.some((argument) => typeof argument !== "string" || !argument || argument.includes("\0")) ||
            host.conformanceProbe.installArguments.filter((argument) => argument === CONFORMANCE_PROBE_TOKEN).length !== 1) {
          throw new Error(`Validate-and-install probe must bind one distribution root in each phase: ${host.id}`);
        }
      } else if (host.conformanceProbe.installArguments !== null) {
        throw new Error(`Only validate-and-install probes can declare install arguments: ${host.id}`);
      }
      if (host.conformanceProbe.kind === "isolated-install" || host.conformanceProbe.kind === "cli-validate-install") {
        if (typeof host.conformanceProbe.installedManifestPath !== "string" ||
            path.isAbsolute(host.conformanceProbe.installedManifestPath) ||
            host.conformanceProbe.installedManifestPath.includes("..")) {
          throw new Error(`Isolated host conformance manifest path is unsafe: ${host.id}`);
        }
      } else if (host.conformanceProbe.installedManifestPath !== null) {
        throw new Error(`Non-installing conformance probe cannot declare an installed manifest: ${host.id}`);
      }
    } else if (host.conformancePackage !== null || host.conformanceProbe !== null ||
        host.distributionRoot !== null || host.helperPath !== null) {
      throw new Error(`Preview or unsupported hosts cannot declare release conformance: ${host.id}`);
    }
    if (host.supportTier === "preview" && host.manifestPath !== `compatibility/preview/${host.id}.json`) {
      throw new Error(`Preview host compatibility manifest is missing: ${host.id}`);
    }
    if (host.manifestPath !== null && (typeof host.manifestPath !== "string" || path.isAbsolute(host.manifestPath) || host.manifestPath.includes(".."))) {
      throw new Error(`Host manifest path is unsafe: ${host.id}`);
    }
    exactKeys(host.osSupport, [...osIds], `hosts.${host.id}.osSupport`);
    for (const [osId, tier] of Object.entries(host.osSupport)) {
      if (!SUPPORT_TIERS.has(tier)) throw new Error(`Invalid ${host.id}/${osId} support tier`);
      if (osId === "windows" && tier === "tier1") throw new Error(`${host.id}/windows cannot be Tier 1 in v4.0.0`);
    }
    if (host.supportTier === "tier1" &&
        (host.osSupport.macos !== "tier1" || host.osSupport.linux !== "tier1" || host.osSupport.windows !== "preview")) {
      throw new Error(`Tier 1 v4.0.0 operating-system contract drifted: ${host.id}`);
    }
    exactKeys(host.capabilities, [...capabilityIds], `hosts.${host.id}.capabilities`);
    for (const status of Object.values(host.capabilities)) {
      if (!CAPABILITY_STATUSES.has(status)) throw new Error(`Invalid capability status for ${host.id}`);
    }
    if (!Array.isArray(host.limitations) || host.limitations.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`Host limitations must be non-empty strings: ${host.id}`);
    }
  }
  const tierOneIds = registry.hosts.filter((host) => host.supportTier === "tier1").map((host) => host.id).sort();
  if (JSON.stringify(tierOneIds) !== JSON.stringify(["claude-code", "codex", "gemini-cli", "qwen-code"])) {
    throw new Error("v4.0.0 Tier 1 hosts must be Codex, Claude Code, Gemini CLI, and Qwen Code");
  }
  return registry;
}

export async function loadHostSupportRegistry({ registryPath = REGISTRY_PATH } = {}) {
  return validateRegistry(JSON.parse(await readFile(registryPath, "utf8")));
}

export function normalizeHostOs(platform = process.platform) {
  return PLATFORM_TO_OS.get(platform) ?? "unsupported";
}

function findHost(registry, hostId) {
  const host = registry.hosts.find((candidate) => candidate.id === hostId);
  if (!host) throw new Error(`Unknown Better Workflows host: ${hostId}`);
  return host;
}

function findOperatingSystem(registry, osId) {
  const operatingSystem = registry.operatingSystems.find((candidate) => candidate.id === osId);
  if (!operatingSystem) throw new Error(`Unknown Better Workflows operating system: ${osId}`);
  return operatingSystem;
}

async function executableIdentity(command, env = process.env) {
  const candidates = String(env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      const resolvedPath = await realpath(candidate);
      const info = await lstat(resolvedPath);
      if (!info.isFile() || info.size > MAX_EXECUTABLE_BYTES) continue;
      return {
        command,
        path: candidate,
        resolvedPath,
        size: info.size,
        mode: info.mode & 0o777,
        digest: sha256(await readFile(resolvedPath))
      };
    } catch {
      // Continue through PATH without invoking the candidate.
    }
  }
  return null;
}

async function hostDistributionRoot(host, root = pluginRoot()) {
  const resolvedPluginRoot = await realpath(root);
  if (host.distributionRoot === "plugin" || host.distributionRoot === null) return resolvedPluginRoot;
  if (host.distributionRoot !== "repository") {
    throw new Error(`Unknown host distribution root: ${host.id}`);
  }
  const repositoryRoot = await realpath(path.resolve(resolvedPluginRoot, "..", ".."));
  const expectedPluginRoot = await realpath(path.join(repositoryRoot, "plugins", "better-workflows"));
  if (expectedPluginRoot !== resolvedPluginRoot) {
    throw new Error(`Repository distribution layout is invalid: ${host.id}`);
  }
  return repositoryRoot;
}

async function regularFileIdentity(root, relativePath, label, maxBytes = 256 * 1024) {
  const target = safeJoin(root, ...relativePath.split("/"));
  const relative = path.relative(path.resolve(root), target);
  let current = path.resolve(root);
  const components = relative.split(path.sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`${label} crosses a symbolic link`);
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`${label} has a non-directory ancestor`);
    }
  }
  if (await realpath(target) !== target) throw new Error(`${label} does not resolve to its bound path`);
  const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) {
      throw new Error(`${label} is unsafe`);
    }
    const contents = await handle.readFile();
    return { path: target, digest: sha256(contents), contents };
  } finally {
    await handle.close();
  }
}

async function manifestIdentity(host, root) {
  if (host.manifestPath === null) return null;
  const identity = await regularFileIdentity(root, host.manifestPath, `Host manifest ${host.id}`);
  return {
    path: identity.path,
    digest: identity.digest,
    manifest: JSON.parse(identity.contents.toString("utf8"))
  };
}

function hostComponentPath(host, manifest) {
  if (host.id === "codex") return manifest.skills;
  if (host.id === "claude-code") return "skills";
  if (host.id === "gemini-cli" || host.id === "qwen-code") return manifest.contextFileName;
  if (host.supportTier === "preview") return manifest.contextFileName;
  return null;
}

async function distributionBundleIdentity(root, host, manifestIdentityValue) {
  if (host.distributionRoot !== "repository" || !manifestIdentityValue) return null;
  const componentPath = hostComponentPath(host, manifestIdentityValue.manifest);
  if (typeof componentPath !== "string" || !componentPath.trim()) {
    throw new Error(`Host distribution component is unavailable: ${host.id}`);
  }
  const records = new Map();
  let totalBytes = 0;
  const addFile = async (relativePath) => {
    const portablePath = relativePath.split(path.sep).join("/");
    if (records.has(portablePath)) return;
    const identity = await regularFileIdentity(
      root,
      portablePath,
      `Host distribution file ${host.id}`,
      MAX_DISTRIBUTION_FILE_BYTES
    );
    const size = identity.contents.length;
    totalBytes += size;
    if (records.size + 1 > MAX_DISTRIBUTION_FILES || totalBytes > MAX_DISTRIBUTION_BYTES) {
      throw new Error(`Host distribution exceeds the conformance inventory bound: ${host.id}`);
    }
    records.set(portablePath, { path: portablePath, size, digest: identity.digest });
  };
  const walk = async (relativePath) => {
    const portablePath = relativePath.split(path.sep).join("/");
    const target = safeJoin(root, ...portablePath.split("/"));
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Host distribution crosses a symbolic link: ${host.id}`);
    if (info.isFile()) {
      await addFile(portablePath);
      return;
    }
    if (!info.isDirectory()) throw new Error(`Host distribution contains a non-file entry: ${host.id}`);
    const names = (await readdir(target)).sort((left, right) => left.localeCompare(right, "en"));
    for (const name of names) await walk(path.posix.join(portablePath, name));
  };
  await addFile(host.manifestPath);
  await addFile(componentPath);
  await walk("plugins/better-workflows");
  const files = [...records.values()].sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    digest: digestObject(files),
    fileCount: files.length,
    totalBytes
  };
}

async function manifestCompatibilityBlockers(host, manifestIdentityValue, distributionRoot, root = pluginRoot()) {
  if (!manifestIdentityValue) return [];
  const blockers = [];
  const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const manifest = manifestIdentityValue.manifest;
  if (manifest.version !== packageManifest.version && host.id !== "codex") blockers.push("host-manifest-version-mismatch");
  if (host.id === "codex" && !String(manifest.version ?? "").startsWith(`${packageManifest.version}+codex.`)) {
    blockers.push("host-manifest-version-mismatch");
  }
  if (host.supportTier === "preview" && (
    manifest.schemaVersion !== 1 ||
    manifest.id !== "better-workflows-preview-host-pack" ||
    manifest.hostId !== host.id ||
    manifest.supportTier !== "preview" ||
    manifest.entrypoint !== "scripts/sbw.mjs"
  )) {
    blockers.push("preview-host-manifest-invalid");
  }
  if (host.supportTier === "preview" && manifest.entrypoint === "scripts/sbw.mjs") {
    try {
      await regularFileIdentity(distributionRoot, manifest.entrypoint, `Preview host entrypoint ${host.id}`, 8 * 1024 * 1024);
    } catch {
      blockers.push("preview-host-entrypoint-missing");
    }
  }
  const componentPath = hostComponentPath(host, manifest);
  if (typeof componentPath !== "string" || !componentPath.trim() || path.isAbsolute(componentPath) || componentPath.includes("..")) {
    blockers.push("host-component-path-invalid");
    return blockers;
  }
  const target = path.resolve(distributionRoot, componentPath);
  const relative = path.relative(path.resolve(distributionRoot), target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    blockers.push("host-component-path-invalid");
    return blockers;
  }
  try {
    const info = await lstat(target);
    const expectedDirectory = host.id === "codex" || host.id === "claude-code";
    if (info.isSymbolicLink() || (expectedDirectory ? !info.isDirectory() : !info.isFile())) {
      blockers.push("host-component-missing");
    }
  } catch {
    blockers.push("host-component-missing");
  }
  return blockers;
}

export async function hostList() {
  const registry = await loadHostSupportRegistry();
  return {
    schemaVersion: 1,
    registryId: registry.id,
    registryDigest: digestObject(registry),
    recommended: registry.recommended,
    operatingSystems: registry.operatingSystems,
    hosts: registry.hosts
  };
}

export async function hostDoctor({
  hostId = "codex",
  osId = normalizeHostOs(),
  env = process.env
} = {}) {
  const checkedAt = nowIso();
  const registry = await loadHostSupportRegistry();
  const host = findHost(registry, hostId);
  const operatingSystem = findOperatingSystem(registry, osId);
  const executable = await executableIdentity(host.executable, env);
  const distributionRoot = await hostDistributionRoot(host);
  const manifest = await manifestIdentity(host, distributionRoot);
  const supportTier = host.osSupport[osId];
  const blockers = [];
  if (!executable) blockers.push("host-executable-missing");
  if (host.manifestPath !== null && !manifest) blockers.push("host-manifest-missing");
  blockers.push(...await manifestCompatibilityBlockers(host, manifest, distributionRoot));
  if (supportTier === "unsupported") blockers.push("host-os-unsupported");
  return {
    schemaVersion: 1,
    checkedAt,
    ok: blockers.length === 0,
    hostId,
    osId,
    supportTier,
    recommended: hostId === registry.recommended.hostId && osId === registry.recommended.osId,
    host,
    operatingSystem,
    executable,
    distribution: host.distributionRoot === null ? null : {
      root: distributionRoot,
      rootKind: host.distributionRoot,
      helperPath: host.helperPath
    },
    manifest: manifest ? { path: manifest.path, digest: manifest.digest, version: manifest.manifest.version ?? null } : null,
    blockers,
    registryDigest: digestObject(registry)
  };
}

function containsExactVersion(output, expectedVersion) {
  const escaped = String(expectedVersion).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^0-9A-Za-z])${escaped}(?:$|[^0-9A-Za-z])`).test(output);
}

async function versionProbe(executable, expectedVersion = null) {
  if (!executable) return { ok: false, reason: "host-executable-missing" };
  const controlledPath = path.dirname(executable.resolvedPath);
  const runtimeInfo = await lstat(process.execPath);
  if (!runtimeInfo.isFile() || runtimeInfo.size > MAX_EXECUTABLE_BYTES) {
    return { ok: false, reason: "node-runtime-identity-invalid" };
  }
  const runtime = {
    path: process.execPath,
    size: runtimeInfo.size,
    digest: sha256(await readFile(process.execPath))
  };
  try {
    const result = await execBoundProcess(executable.resolvedPath, ["--version"], {
      cwd: os.tmpdir(),
      env: {
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${controlledPath}`,
        HOME: "/var/empty",
        LANG: "C",
        LC_ALL: "C",
        NO_COLOR: "1",
        CI: "1"
      },
      timeoutMs: 10_000,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
      label: "Host version probe"
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(0, 512);
    const versionMatched = expectedVersion === null || containsExactVersion(output, expectedVersion);
    return {
      ok: versionMatched,
      runtime,
      expectedVersion,
      versionMatched,
      outputDigest: sha256(output),
      output,
      ...(versionMatched ? {} : { reason: "host-version-output-does-not-match-pinned-package" })
    };
  } catch (error) {
    return { ok: false, runtime, expectedVersion, versionMatched: false, reason: String(error.message).slice(0, 512) };
  }
}

function finalizeExtensionProbe(payload) {
  return { ...payload, probeDigest: digestObject(payload) };
}

async function extensionConformanceProbe(host, executable, root = pluginRoot()) {
  const specification = host.conformanceProbe;
  if (specification === null) {
    return finalizeExtensionProbe({
      kind: "not-required",
      result: "PASS",
      reason: "Preview hosts do not produce release-eligible extension probes"
    });
  }
  const resolvedRoot = await hostDistributionRoot(host, root);
  const sourceManifest = await manifestIdentity(host, resolvedRoot);
  const sourceHelper = await regularFileIdentity(
    resolvedRoot,
    host.helperPath,
    `Host helper ${host.id}`,
    8 * 1024 * 1024
  );
  const sourceBundle = await distributionBundleIdentity(resolvedRoot, host, sourceManifest);
  if (specification.kind === "native-contract") {
    return finalizeExtensionProbe({
      kind: specification.kind,
      result: sourceManifest ? "PASS" : "FAIL",
      manifestDigest: sourceManifest?.digest ?? null,
      helperDigest: sourceHelper.digest,
      installedManifestDigest: null,
      installedHelperDigest: null,
      componentDigest: null,
      installedComponentDigest: null,
      bundleDigest: null,
      bundleFileCount: null,
      bundleBytes: null,
      installedBundleDigest: null,
      installedBundleFileCount: null,
      installedBundleBytes: null,
      reason: sourceManifest ? "Codex native plugin contract is present" : "host-manifest-missing"
    });
  }
  if (!executable) {
    return finalizeExtensionProbe({
      kind: specification.kind,
      result: "FAIL",
      manifestDigest: sourceManifest?.digest ?? null,
      helperDigest: sourceHelper.digest,
      outputDigest: null,
      installedManifestDigest: null,
      installedHelperDigest: null,
      componentDigest: null,
      installedComponentDigest: null,
      bundleDigest: sourceBundle?.digest ?? null,
      bundleFileCount: sourceBundle?.fileCount ?? null,
      bundleBytes: sourceBundle?.totalBytes ?? null,
      installedBundleDigest: null,
      installedBundleFileCount: null,
      installedBundleBytes: null,
      reason: "host-executable-missing"
    });
  }
  const probeHome = await realpath(await mkdtemp(path.join(os.tmpdir(), `sbw-${host.id}-extension-`)));
  try {
    const probeEnvironment = {
      PATH: [path.dirname(process.execPath), path.dirname(executable.resolvedPath), "/usr/bin", "/bin"].join(path.delimiter),
      HOME: probeHome,
      XDG_CONFIG_HOME: path.join(probeHome, ".config"),
      LANG: "C",
      LC_ALL: "C",
      CI: "1",
      NO_COLOR: "1",
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
    };
    const runPhase = async (rawArguments, phase) => {
      const args = rawArguments.map((argument) => (
        argument === CONFORMANCE_PROBE_TOKEN ? resolvedRoot : argument
      ));
      const result = await execBoundProcess(executable.resolvedPath, args, {
        cwd: resolvedRoot,
        env: probeEnvironment,
        timeoutMs: 30_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
        label: `Host extension probe ${host.id} ${phase}`
      });
      return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    };
    const outputs = [await runPhase(specification.arguments, "primary")];
    if (specification.kind === "cli-validate-install") {
      outputs.push(await runPhase(specification.installArguments, "install"));
    }
    const output = outputs.join("\n");
    let installedManifestDigest = null;
    let installedHelperDigest = null;
    let componentDigest = null;
    let installedComponentDigest = null;
    let installedBundle = null;
    if (specification.installedManifestPath !== null) {
      if (!sourceManifest) throw new Error("Host source manifest is missing");
      const installedManifestFile = await regularFileIdentity(
        probeHome,
        specification.installedManifestPath,
        `Installed host manifest ${host.id}`
      );
      const installedManifest = JSON.parse(installedManifestFile.contents.toString("utf8"));
      if (digestObject(installedManifest) !== digestObject(sourceManifest.manifest)) {
        throw new Error("Installed host manifest differs from the source-bound manifest");
      }
      installedManifestDigest = installedManifestFile.digest;
      const installedRoot = path.posix.dirname(specification.installedManifestPath);
      const installedHelper = await regularFileIdentity(
        probeHome,
        path.posix.join(installedRoot, host.helperPath),
        `Installed host helper ${host.id}`,
        8 * 1024 * 1024
      );
      if (installedHelper.digest !== sourceHelper.digest) {
        throw new Error("Installed host helper differs from the source-bound helper");
      }
      installedHelperDigest = installedHelper.digest;
      const componentPath = hostComponentPath(host, sourceManifest.manifest);
      if (typeof componentPath !== "string" || !componentPath || path.isAbsolute(componentPath) || componentPath.includes("..")) {
        throw new Error("Installed host component path is invalid");
      }
      const sourceComponent = await regularFileIdentity(
        resolvedRoot,
        componentPath,
        `Host component ${host.id}`,
        2 * 1024 * 1024
      );
      const installedComponent = await regularFileIdentity(
        probeHome,
        path.posix.join(installedRoot, componentPath),
        `Installed host component ${host.id}`,
        2 * 1024 * 1024
      );
      if (installedComponent.digest !== sourceComponent.digest) {
        throw new Error("Installed host component differs from the source-bound component");
      }
      componentDigest = sourceComponent.digest;
      installedComponentDigest = installedComponent.digest;
      try {
        installedBundle = await distributionBundleIdentity(
          path.join(probeHome, installedRoot),
          host,
          { manifest: installedManifest }
        );
      } catch (error) {
        throw new Error(`Installed host bundle could not be inventoried: ${error.message}`);
      }
      if (!sourceBundle || installedBundle.digest !== sourceBundle.digest ||
          installedBundle.fileCount !== sourceBundle.fileCount || installedBundle.totalBytes !== sourceBundle.totalBytes) {
        throw new Error("Installed host bundle differs from the complete source-bound distribution");
      }
    }
    return finalizeExtensionProbe({
      kind: specification.kind,
      result: "PASS",
      manifestDigest: sourceManifest?.digest ?? null,
      helperDigest: sourceHelper.digest,
      argumentsDigest: digestObject({
        primary: specification.arguments,
        install: specification.installArguments
      }),
      outputDigest: sha256(output),
      installedManifestDigest,
      installedHelperDigest,
      componentDigest,
      installedComponentDigest,
      bundleDigest: sourceBundle?.digest ?? null,
      bundleFileCount: sourceBundle?.fileCount ?? null,
      bundleBytes: sourceBundle?.totalBytes ?? null,
      installedBundleDigest: installedBundle?.digest ?? null,
      installedBundleFileCount: installedBundle?.fileCount ?? null,
      installedBundleBytes: installedBundle?.totalBytes ?? null,
      reason: specification.installedManifestPath === null
        ? "Official host extension validation completed in an isolated home"
        : "Official host extension validation and installed bundle verification completed in an isolated home"
    });
  } catch (error) {
    const reason = String(error.message)
      .replaceAll(resolvedRoot, CONFORMANCE_PROBE_TOKEN)
      .replaceAll(probeHome, "{probeHome}")
      .slice(0, 512);
    return finalizeExtensionProbe({
      kind: specification.kind,
      result: "FAIL",
      manifestDigest: sourceManifest?.digest ?? null,
      helperDigest: sourceHelper.digest,
      argumentsDigest: digestObject({
        primary: specification.arguments,
        install: specification.installArguments
      }),
      outputDigest: null,
      installedManifestDigest: null,
      installedHelperDigest: null,
      componentDigest: null,
      installedComponentDigest: null,
      bundleDigest: sourceBundle?.digest ?? null,
      bundleFileCount: sourceBundle?.fileCount ?? null,
      bundleBytes: sourceBundle?.totalBytes ?? null,
      installedBundleDigest: null,
      installedBundleFileCount: null,
      installedBundleBytes: null,
      reason
    });
  } finally {
    await rm(probeHome, { recursive: true, force: false });
  }
}

export async function hostConformance({
  hostId = "codex",
  osId = normalizeHostOs(),
  stateRoot = null,
  writeReceipt = false,
  env = process.env
} = {}) {
  const doctor = await hostDoctor({ hostId, osId, env });
  const registry = await loadHostSupportRegistry();
  const host = findHost(registry, hostId);
  if (doctor.registryDigest !== digestObject(registry) || digestObject(doctor.host) !== digestObject(host)) {
    throw new Error("Host conformance registry changed between doctor and probe");
  }
  const probe = await versionProbe(doctor.executable, host.conformancePackage?.version ?? null);
  const extensionProbe = await extensionConformanceProbe(host, doctor.executable);
  if (host.supportTier === "tier1" &&
      (doctor.manifest?.digest ?? null) !== (extensionProbe.manifestDigest ?? null)) {
    throw new Error("Host conformance manifest changed between doctor and extension probe");
  }
  const commonCapabilityIds = ["task-contract", "typed-evidence", "replay", "action-gate", "task-worktree"];
  const capabilities = commonCapabilityIds.map((capabilityId) => {
    const declared = host.capabilities[capabilityId];
    const passed = doctor.ok && probe.ok && extensionProbe.result === "PASS" && (declared === "native" || declared === "core-bridge");
    return {
      id: capabilityId,
      declared,
      result: passed ? "PASS" : "FAIL",
      reason: passed
        ? host.supportTier === "tier1"
          ? "Pinned host runtime, official extension probe, and host-neutral core bridge passed"
          : "Local host runtime, published Preview compatibility pack, and host-neutral core bridge smoke check passed"
        : doctor.blockers[0] ?? probe.reason ?? extensionProbe.reason ?? "capability unavailable"
    };
  });
  const payload = {
    schemaVersion: 1,
    kind: "HostCapabilityReceipt",
    producedAt: nowIso(),
    hostId,
    osId,
    supportTier: doctor.supportTier,
    registryId: registry.id,
    registryDigest: doctor.registryDigest,
    executable: doctor.executable,
    manifest: doctor.manifest,
    versionProbe: probe,
    extensionProbe,
    capabilities,
    result: doctor.ok && probe.ok && extensionProbe.result === "PASS" && capabilities.every((capability) => capability.result === "PASS") ? "PASS" : "FAIL",
    authentication: {
      status: "local-executable-binding",
      releaseEligible: false,
      requirement: "v4.0.0 release requires a CI/provider-authenticated envelope around this exact receipt digest"
    }
  };
  const receipt = { ...payload, receiptDigest: digestObject(payload) };
  let receiptPath = null;
  if (writeReceipt) {
    if (!stateRoot) throw new Error("Writing a conformance receipt requires a state root");
    receiptPath = safeJoin(stateRoot, "host-conformance", hostId, osId, `${receipt.receiptDigest}.json`);
    await atomicWriteJson(stateRoot, receiptPath, receipt);
  }
  return { ...receipt, receiptPath };
}

export async function releaseConformanceMatrix() {
  const registry = await loadHostSupportRegistry();
  return registry.hosts
    .filter((host) => host.supportTier === "tier1")
    .flatMap((host) => ["macos", "linux"].map((osId) => ({
      hostId: host.id,
      osId,
      runner: osId === "macos" ? "macos-15" : "ubuntu-latest",
      packageName: host.conformancePackage.name,
      packageVersion: host.conformancePackage.version,
      executable: host.executable
    })))
    .sort((left, right) => `${left.hostId}/${left.osId}`.localeCompare(`${right.hostId}/${right.osId}`, "en"));
}

export function renderHostSupportMarkdown(registry) {
  const tierOne = registry.hosts.filter((host) => host.supportTier === "tier1").map((host) => host.displayName).join(", ");
  const preview = registry.hosts.filter((host) => host.supportTier === "preview").map((host) => host.displayName).join(", ");
  const capabilityIds = registry.capabilityDefinitions.map((capability) => capability.id);
  const coreIds = capabilityIds.slice(0, 5);
  const nativeIds = capabilityIds.slice(5);
  const groups = new Map();
  for (const host of registry.hosts) {
    const key = JSON.stringify({ supportTier: host.supportTier, capabilities: host.capabilities });
    const current = groups.get(key) ?? { hosts: [], host };
    current.hosts.push(host.displayName);
    groups.set(key, current);
  }
  const summarize = (host, ids) => ids.map((id) => `${id}: ${host.capabilities[id]}`).join("; ");
  const capabilityRows = [...groups.values()].map(({ hosts, host }) => (
    `| ${hosts.join(", ")} | ${host.supportTier} | ${summarize(host, coreIds)} | ${summarize(host, nativeIds)} |`
  ));
  return [
    "| Level | AI hosts | Operating systems | Promise |",
    "| --- | --- | --- | --- |",
    `| Recommended reference | **${registry.recommended.label}** | macOS | Deepest native integration and complete reference UX |`,
    `| Tier 1 | ${tierOne} | macOS, Linux | Shared core safety semantics; host-native UX may differ |`,
    `| Preview | ${preview} | macOS, Linux | [Manual compatibility pack](plugins/better-workflows/compatibility/preview/INSTRUCTIONS.md) with published limitations |`,
    "| OS Preview | All listed hosts | Windows | Not covered by the v4.0.0 Tier 1 guarantee |",
    "",
    "Capability status: `native` = host-native integration; `core-bridge` = shared Better Workflows control layer; `unverified` and `unavailable` are not equivalent to support.",
    "",
    "| AI hosts | Support | Core control plane | Native and host-specific surfaces |",
    "| --- | --- | --- | --- |",
    ...capabilityRows
  ].join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderHostSupportHtml(registry) {
  const rows = registry.hosts.map((host) => {
    const os = Object.entries(host.osSupport)
      .map(([osId, tier]) => `${osId}: ${tier}`)
      .join(" · ");
    const reference = host.id === registry.recommended.hostId ? " <strong>Recommended on macOS</strong>" : "";
    return `<tr><th scope="row">${escapeHtml(host.displayName)}${reference}</th><td>${escapeHtml(host.supportTier)}</td><td>${escapeHtml(os)}</td><td>${escapeHtml(host.extensionMechanism)}</td></tr>`;
  }).join("");
  const capabilityHeaders = registry.capabilityDefinitions
    .map((capability) => `<th scope="col">${escapeHtml(capability.id)}</th>`)
    .join("");
  const capabilityRows = registry.hosts.map((host) => (
    `<tr><th scope="row">${escapeHtml(host.displayName)}</th>${registry.capabilityDefinitions.map((capability) => (
      `<td><code>${escapeHtml(host.capabilities[capability.id])}</code></td>`
    )).join("")}</tr>`
  )).join("");
  return [
    `<table class="support-matrix"><thead><tr><th>AI host</th><th>Support</th><th>OS coverage</th><th>Integration</th></tr></thead><tbody>${rows}</tbody></table>`,
    '<p class="capability-legend"><code>native</code> = host-native · <code>core-bridge</code> = shared control layer · <code>unverified</code>/<code>unavailable</code> are explicit limits.</p>',
    `<table class="capability-matrix"><thead><tr><th scope="col">AI host</th>${capabilityHeaders}</tr></thead><tbody>${capabilityRows}</tbody></table>`
  ].join("");
}
