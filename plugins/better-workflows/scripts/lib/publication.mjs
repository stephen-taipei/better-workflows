import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  realpath,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { captureSourceBinding, hiddenIndexEntries } from "./git.mjs";

const execFileAsync = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, options, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
      return;
    }
    resolve({ stdout, stderr });
  });
});

function sha256(value) {
  const hash = createHash("sha256");
  hash.update(Buffer.isBuffer(value) ? value : String(value));
  return hash.digest("hex");
}

function digestObject(value) {
  return sha256(JSON.stringify(value));
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function repositoryRootForSource(root) {
  const resolvedSource = await realpath(path.resolve(root));
  return realpath((await execFileAsync("git", [
    "-C", resolvedSource, "rev-parse", "--show-toplevel"
  ], { encoding: "utf8" })).stdout.trim());
}

async function assertDirectoryNotSymlink(target) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Unsafe cache directory: ${target}`);
  }
}

async function readRegularFile(target, { requireSingleLink = true } = {}) {
  const handle = await open(
    target,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || (requireSingleLink && info.nlink !== 1)) {
      throw new Error(`Unsafe plugin bundle file: ${target}`);
    }
    return { info, contents: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    return false;
  }
}

async function readPublicationLock(lockPath, { allowHardlink = false } = {}) {
  try {
    const opened = await readRegularFile(lockPath, { requireSingleLink: !allowHardlink });
    return JSON.parse(opened.contents.toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function reclaimStalePublicationLock(lockPath, version) {
  const existing = await readPublicationLock(lockPath);
  if (!existing) {
    if (await pathExists(lockPath)) {
      throw new Error(`Plugin cache publication lock owner cannot be proven absent for ${version}`);
    }
    return false;
  }
  if (!Number.isInteger(existing.pid) || existing.pid < 1) {
    throw new Error(`Plugin cache publication lock owner cannot be proven absent for ${version}`);
  }
  if (processIsAlive(existing.pid)) {
    throw new Error(`Plugin cache publication is already in progress for ${version}`);
  }
  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await link(lockPath, stalePath);
    const current = await readPublicationLock(lockPath, { allowHardlink: true });
    const sameOwner = current &&
      current.pid === existing.pid &&
      current.createdAt === existing.createdAt &&
      (current.ownerToken ?? null) === (existing.ownerToken ?? null);
    if (sameOwner) await unlink(lockPath);
    return sameOwner;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  } finally {
    await unlink(stalePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function acquirePublicationLock(lockPath, version) {
  let reclaimed = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const ownerToken = randomUUID();
      await writeFile(lockPath, `${JSON.stringify({
        version,
        pid: process.pid,
        ownerToken,
        createdAt: new Date().toISOString()
      })}\n`, { flag: "wx", mode: 0o600 });
      return { ownerToken, close: async () => undefined, reclaimed };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const didReclaim = await reclaimStalePublicationLock(lockPath, version);
      reclaimed ||= didReclaim;
      if (!didReclaim && attempt === 1) {
        throw new Error(`Plugin cache publication lock could not be acquired for ${version}`);
      }
    }
  }
  throw new Error(`Plugin cache publication lock could not be acquired for ${version}`);
}

async function releasePublicationLock(lockPath, ownerToken) {
  const current = await readPublicationLock(lockPath);
  if (!current || current.ownerToken !== ownerToken) return;
  await unlink(lockPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function removeStalePublicationArtifacts(cacheRoot, version) {
  const prefix = `.${version}.`;
  const entries = await readdir(cacheRoot);
  for (const entry of entries) {
    if (
      entry.startsWith(`${prefix}stage-`) ||
      entry.startsWith(`${prefix}snapshot-`) ||
      entry.startsWith(`${prefix}archive-`)
    ) {
      await rm(path.join(cacheRoot, entry), { recursive: true, force: true });
    }
  }
}

async function assertPublishableSource(root) {
  const sourceRoot = await realpath(path.resolve(root));
  let repositoryRoot;
  try {
    repositoryRoot = await repositoryRootForSource(sourceRoot);
  } catch {
    return;
  }
  const relativeRoot = path.relative(repositoryRoot, sourceRoot).replaceAll(path.sep, "/");
  if (!relativeRoot || relativeRoot.startsWith("../") || path.isAbsolute(relativeRoot)) return;
  try {
    await execFileAsync("git", ["-C", repositoryRoot, "ls-files", "--error-unmatch", "--", `${relativeRoot}/.codex-plugin/plugin.json`], { encoding: "utf8" });
  } catch {
    // Temporary test fixtures without a tracked plugin manifest are not publishable sources.
    return;
  }
  const worktreeStatus = (await execFileAsync("git", [
    "-C", repositoryRoot, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored", "--", relativeRoot
  ], { encoding: "utf8" })).stdout;
  if (worktreeStatus.length > 0) {
    throw new Error(`Plugin cache source is not a clean committed tree: ${relativeRoot}`);
  }
  const hidden = await hiddenIndexEntries(repositoryRoot);
  const hiddenPluginEntries = hidden.records.filter((item) => item.path === relativeRoot || item.path.startsWith(`${relativeRoot}/`));
  if (hiddenPluginEntries.length > 0) {
    throw new Error(`Plugin cache source contains hidden tracked index flags: ${hiddenPluginEntries.map((item) => `${item.status} ${item.path}`).join(", ")}`);
  }
  const tracked = (await execFileAsync("git", ["-C", repositoryRoot, "ls-files", "-z", "--", relativeRoot], { encoding: "utf8" })).stdout
    .split("\0").filter(Boolean);
  const [untrackedResult, ignoredResult] = await Promise.all([
    execFileAsync("git", ["-C", repositoryRoot, "ls-files", "--others", "--exclude-standard", "-z", "--", relativeRoot], { encoding: "utf8" }),
    execFileAsync("git", ["-C", repositoryRoot, "ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", relativeRoot], { encoding: "utf8" })
  ]);
  const unexpected = [...new Set([
    ...untrackedResult.stdout.split("\0").filter(Boolean),
    ...ignoredResult.stdout.split("\0").filter(Boolean)
  ])].sort();
  if (unexpected.length > 0) {
    throw new Error(`Plugin cache source contains untracked or ignored files: ${unexpected.join(", ")}`);
  }
  for (const file of tracked) {
    const absolute = path.join(repositoryRoot, file);
    const info = await lstat(absolute).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) throw new Error(`Plugin cache source is missing tracked file: ${file}`);
  }
}

export async function createBundleManifest(root, relative = "") {
  const directory = path.resolve(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const records = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Plugin bundle contains a symlink: ${childRelative}`);
    if (info.isDirectory()) {
      records.push(...await createBundleManifest(root, childRelative));
    } else if (info.isFile()) {
      const opened = await readRegularFile(absolute);
      records.push({
        path: childRelative,
        size: opened.info.size,
        mode: opened.info.mode & 0o777,
        digest: sha256(opened.contents)
      });
    } else {
      throw new Error(`Plugin bundle contains an unsupported entry: ${childRelative}`);
    }
  }
  return records;
}

export async function bundleDigest(root) {
  await assertPublishableSource(root);
  return digestObject(await createBundleManifest(root));
}

function manifestDiff(source, target) {
  const sourceMap = new Map(source.map((record) => [record.path, record]));
  const targetMap = new Map(target.map((record) => [record.path, record]));
  const missing = [...sourceMap.keys()].filter((name) => !targetMap.has(name)).sort();
  const extra = [...targetMap.keys()].filter((name) => !sourceMap.has(name)).sort();
  const changed = [...sourceMap.keys()]
    .filter((name) => {
      const targetRecord = targetMap.get(name);
      return targetRecord && JSON.stringify(sourceMap.get(name)) !== JSON.stringify(targetRecord);
    })
    .sort();
  return { missing, extra, changed };
}

async function pluginVersion(sourceRoot) {
  const manifestPath = path.join(sourceRoot, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse((await readRegularFile(manifestPath)).contents.toString("utf8"));
  if (typeof manifest.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(manifest.version)) {
    throw new Error("Plugin manifest version is missing or unsafe");
  }
  return manifest.version;
}

export async function checkPluginCache({ sourceRoot, cacheRoot }) {
  const resolvedSource = path.resolve(sourceRoot);
  const resolvedCacheRoot = path.resolve(cacheRoot);
  await assertDirectoryNotSymlink(resolvedSource);
  await assertPublishableSource(resolvedSource);
  const version = await pluginVersion(resolvedSource);
  const target = path.join(resolvedCacheRoot, version);
  const sourceManifest = await createBundleManifest(resolvedSource);
  const sourceDigest = digestObject(sourceManifest);
  if (!(await pathExists(target))) {
    return {
      ok: false,
      status: "missing",
      version,
      sourceRoot: resolvedSource,
      target,
      sourceDigest,
      targetDigest: null,
      diff: { missing: sourceManifest.map((record) => record.path), extra: [], changed: [] }
    };
  }
  await assertDirectoryNotSymlink(target);
  const targetManifest = await createBundleManifest(target);
  const targetDigest = digestObject(targetManifest);
  const diff = manifestDiff(sourceManifest, targetManifest);
  return {
    ok: sourceDigest === targetDigest,
    status: sourceDigest === targetDigest ? "identical" : "drifted",
    version,
    sourceRoot: resolvedSource,
    target,
    sourceDigest,
    targetDigest,
    diff
  };
}

async function copyBundle(sourceRoot, targetRoot, relative = "") {
  const sourceDirectory = path.resolve(sourceRoot, relative);
  const targetDirectory = path.resolve(targetRoot, relative);
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await chmod(targetDirectory, 0o700);
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = path.join(relative, entry.name);
    const source = path.join(sourceRoot, childRelative);
    const target = path.join(targetRoot, childRelative);
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error(`Refusing to publish symlink: ${childRelative}`);
    if (info.isDirectory()) {
      await copyBundle(sourceRoot, targetRoot, childRelative);
    } else if (info.isFile()) {
      const opened = await readRegularFile(source);
      const targetHandle = await open(target, "wx", opened.info.mode & 0o777);
      try {
        await targetHandle.writeFile(opened.contents);
        await targetHandle.sync();
      } finally {
        await targetHandle.close();
      }
      await chmod(target, opened.info.mode & 0o777);
    } else {
      throw new Error(`Refusing to publish unsupported entry: ${childRelative}`);
    }
  }
}

function validateExpectedSourceBinding(value) {
  if (value === null || value === undefined) return null;
  const keys = [
    "pluginBundleDigest",
    "sourceBaselineRevision",
    "sourceBindingDigest",
    "sourceHeadRevision"
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== keys.sort().join("\0") ||
      !/^[a-f0-9]{40}$/.test(value.sourceBaselineRevision) ||
      !/^[a-f0-9]{40}$/.test(value.sourceHeadRevision) ||
      !/^[a-f0-9]{64}$/.test(value.sourceBindingDigest) ||
      !/^[a-f0-9]{64}$/.test(value.pluginBundleDigest)) {
    throw new Error("Plugin cache publication expected source binding is structurally invalid");
  }
  return value;
}

function publicationMarkerPath(cacheRoot, version) {
  return path.join(path.resolve(cacheRoot), `${version}.ready.json`);
}

async function readPublicationMarker(cacheRoot, version) {
  const target = publicationMarkerPath(cacheRoot, version);
  try {
    const opened = await readRegularFile(target);
    return JSON.parse(opened.contents.toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writePublicationMarker({
  cacheRoot,
  version,
  state,
  targetDigest,
  sourceDigest,
  sourceBaselineRevision = null,
  sourceHeadRevision = null,
  sourceBindingDigest = null,
  pluginBundleDigest = null,
  runId = null,
  attemptId = null,
  providerReceiptDigest = null
}) {
  if (!["pending", "ready"].includes(state)) {
    throw new Error("Plugin cache publication marker state is invalid");
  }
  const root = path.resolve(cacheRoot);
  await assertDirectoryNotSymlink(root);
  const target = publicationMarkerPath(root, version);
  const temporary = `${target}.tmp-${randomUUID()}`;
  const value = {
    schemaVersion: 2,
    state,
    version,
    target: path.join(root, version),
    targetDigest,
    sourceDigest,
    sourceBaselineRevision,
    sourceHeadRevision,
    sourceBindingDigest,
    pluginBundleDigest,
    runId,
    attemptId,
    providerReceiptDigest,
    updatedAt: new Date().toISOString()
  };
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target).catch(async (error) => {
    await unlink(temporary).catch(() => undefined);
    throw error;
  });
  return value;
}

export async function markPluginCacheReady({
  cacheRoot,
  version,
  target,
  targetDigest,
  sourceDigest,
  sourceBaselineRevision,
  sourceHeadRevision,
  sourceBindingDigest,
  pluginBundleDigest,
  runId = null,
  attemptId = null,
  providerReceiptDigest = null
}) {
  const root = path.resolve(cacheRoot);
  if (target !== path.join(root, version)) {
    throw new Error("Plugin cache ready marker target is not canonical");
  }
  const actualTargetDigest = await bundleDigest(target);
  if (actualTargetDigest !== targetDigest) {
    throw new Error("Plugin cache ready marker target digest does not match the published target");
  }
  const existing = await readPublicationMarker(root, version);
  if (existing && existing.state !== "pending" && existing.state !== "ready") {
    throw new Error("Plugin cache ready marker has an invalid prior state");
  }
  if (existing?.state === "pending" && existing.targetDigest !== targetDigest) {
    throw new Error("Plugin cache ready marker is bound to a different target digest");
  }
  for (const [field, expected] of [
    ["sourceDigest", sourceDigest],
    ["sourceBaselineRevision", sourceBaselineRevision],
    ["sourceHeadRevision", sourceHeadRevision],
    ["sourceBindingDigest", sourceBindingDigest],
    ["pluginBundleDigest", pluginBundleDigest],
    ["runId", runId],
    ["attemptId", attemptId],
    ["providerReceiptDigest", providerReceiptDigest]
  ]) {
    if (
      existing?.[field] !== null &&
      existing?.[field] !== undefined &&
      expected !== null &&
      expected !== undefined &&
      existing[field] !== expected
    ) {
      throw new Error(`Plugin cache ready marker ${field} binding changed`);
    }
  }
  return writePublicationMarker({
    cacheRoot: root,
    version,
    state: "ready",
    targetDigest,
    sourceDigest,
    sourceBaselineRevision,
    sourceHeadRevision,
    sourceBindingDigest,
    pluginBundleDigest,
    runId,
    attemptId,
    providerReceiptDigest
  });
}

export async function removeUnreadyPluginCachePublication({ cacheRoot, version, target, targetDigest }) {
  const root = path.resolve(cacheRoot);
  if (target !== path.join(root, version)) {
    throw new Error("Plugin cache cleanup target is not canonical");
  }
  const marker = await readPublicationMarker(root, version);
  if (!marker || marker.state !== "pending" || marker.targetDigest !== targetDigest) {
    throw new Error("Refusing to remove a cache target without its pending publication marker");
  }
  const actualTargetDigest = await bundleDigest(target);
  if (actualTargetDigest !== targetDigest) {
    throw new Error("Refusing to remove a cache target whose digest changed");
  }
  await rm(target, { recursive: true, force: false });
  await unlink(publicationMarkerPath(root, version));
  return { removed: true, target, marker: publicationMarkerPath(root, version) };
}

export async function verifyPluginCacheReady({
  cacheRoot,
  version,
  target,
  targetDigest,
  sourceDigest = null,
  sourceBaselineRevision = null,
  sourceHeadRevision = null,
  sourceBindingDigest = null,
  pluginBundleDigest = null,
  runId = null,
  attemptId = null,
  providerReceiptDigest = null
}) {
  const root = path.resolve(cacheRoot);
  if (target !== path.join(root, version)) {
    throw new Error("Plugin cache readiness target is not canonical");
  }
  const marker = await readPublicationMarker(root, version);
  if (!marker || marker.state !== "ready" || marker.target !== target || marker.targetDigest !== targetDigest) {
    throw new Error("Plugin cache readiness marker is absent or stale");
  }
  for (const [field, expected] of [
    ["sourceDigest", sourceDigest],
    ["sourceBaselineRevision", sourceBaselineRevision],
    ["sourceHeadRevision", sourceHeadRevision],
    ["sourceBindingDigest", sourceBindingDigest],
    ["pluginBundleDigest", pluginBundleDigest],
    ["runId", runId],
    ["attemptId", attemptId],
    ["providerReceiptDigest", providerReceiptDigest]
  ]) {
    if (expected !== null && marker[field] !== expected) {
      throw new Error(`Plugin cache readiness marker ${field} binding changed`);
    }
  }
  const actualTargetDigest = await bundleDigest(target);
  if (actualTargetDigest !== targetDigest) {
    throw new Error("Plugin cache readiness target digest changed");
  }
  return { ok: true, marker, targetDigest: actualTargetDigest };
}

async function assertExpectedSourceBinding(sourceRoot, expected, bundle = null) {
  if (!expected) return { sourceBinding: null, bundleDigest: bundle ?? await bundleDigest(sourceRoot) };
  // Source bindings are repository-level records. Publishing is invoked with the
  // plugin subtree, but capturing that subtree would bind the digest to a
  // different cwd and reject a valid handoff.
  const sourceBinding = await captureSourceBinding(await repositoryRootForSource(sourceRoot), {
    baseRevision: expected.sourceBaselineRevision,
    requireClean: true
  });
  if (!sourceBinding || sourceBinding.headRevision !== expected.sourceHeadRevision || sourceBinding.digest !== expected.sourceBindingDigest) {
    throw new Error("Plugin cache publication source binding changed after self-improve handoff");
  }
  const resolvedBundle = bundle ?? await bundleDigest(sourceRoot);
  if (resolvedBundle !== expected.pluginBundleDigest) {
    throw new Error("Plugin cache publication plugin bundle changed after self-improve handoff");
  }
  return { sourceBinding, bundleDigest: resolvedBundle };
}

async function createCommittedSourceSnapshot(sourceRoot, expected, cacheRoot, version) {
  const repositoryRoot = await repositoryRootForSource(sourceRoot);
  const resolvedSource = await realpath(path.resolve(sourceRoot));
  const relativeRoot = path.relative(repositoryRoot, resolvedSource).replaceAll(path.sep, "/");
  if (!relativeRoot || relativeRoot.startsWith("../") || path.isAbsolute(relativeRoot)) {
    throw new Error("Plugin cache source is not a repository-relative tree");
  }
  const snapshotRoot = path.join(cacheRoot, `.${version}.snapshot-${randomUUID()}`);
  const archivePath = path.join(cacheRoot, `.${version}.archive-${randomUUID()}.tar`);
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  try {
    await execFileAsync("git", [
      "-C", repositoryRoot,
      "archive",
      "--format=tar",
      `--output=${archivePath}`,
      expected.sourceHeadRevision,
      "--",
      relativeRoot
    ], { encoding: "utf8" });
    await execFileAsync("/usr/bin/tar", ["-xf", archivePath, "-C", snapshotRoot], {
      encoding: "utf8"
    });
    const snapshotSource = path.join(snapshotRoot, relativeRoot);
    await assertDirectoryNotSymlink(snapshotSource);
    const snapshotDigest = await bundleDigest(snapshotSource);
    if (snapshotDigest !== expected.pluginBundleDigest) {
      throw new Error("Committed plugin cache snapshot does not match self-improve handoff");
    }
    return { snapshotRoot, snapshotSource };
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await unlink(archivePath).catch(() => undefined);
  }
}

export async function publishPluginCache({
  sourceRoot,
  cacheRoot,
  expectedSourceBinding = null,
  beforeRename = null,
  publicationIdentity = null
}) {
  const expected = validateExpectedSourceBinding(expectedSourceBinding);
  if (beforeRename !== null && typeof beforeRename !== "function") {
    throw new Error("Plugin cache publication beforeRename hook must be a function");
  }
  if (publicationIdentity !== null && (
    !publicationIdentity ||
    typeof publicationIdentity.runId !== "string" ||
    !publicationIdentity.runId ||
    typeof publicationIdentity.attemptId !== "string" ||
    !publicationIdentity.attemptId
  )) {
    throw new Error("Plugin cache publication identity must bind a run and action attempt");
  }
  await assertExpectedSourceBinding(sourceRoot, expected);
  const before = await checkPluginCache({ sourceRoot, cacheRoot });
  if (before.ok) {
    if (expected) {
      const marker = await readPublicationMarker(cacheRoot, before.version);
      if (marker?.state === "pending") {
        throw new Error("Plugin cache version has an incomplete pending publication");
      }
    }
    await assertExpectedSourceBinding(sourceRoot, expected);
    return { ...before, applied: false, noOp: true };
  }
  if (before.status === "drifted") {
    throw new Error(
      `Refusing to overwrite immutable cache version ${before.version}; bump the plugin build version`
    );
  }
  const resolvedCacheRoot = path.resolve(cacheRoot);
  await mkdir(resolvedCacheRoot, { recursive: true, mode: 0o700 });
  await assertDirectoryNotSymlink(resolvedCacheRoot);
  const lockPath = path.join(resolvedCacheRoot, `.${before.version}.publish.lock`);
  const lockState = await acquirePublicationLock(lockPath, before.version);
  const lock = lockState;
  if (lockState.reclaimed) await removeStalePublicationArtifacts(resolvedCacheRoot, before.version);
  const stage = path.join(resolvedCacheRoot, `.${before.version}.stage-${randomUUID()}`);
  let snapshotRoot = null;
  let publishedTarget = false;
  let publishedPath = null;
  try {
    const lockedBefore = await checkPluginCache({ sourceRoot, cacheRoot });
    if (
      lockedBefore.version !== before.version ||
      lockedBefore.target !== before.target
    ) {
      throw new Error(
        `Plugin source version changed while acquiring publication lock: ${before.version} -> ${lockedBefore.version}`
      );
    }
    await assertExpectedSourceBinding(sourceRoot, expected, lockedBefore.sourceDigest);
    if (lockedBefore.ok) {
      if (expected) {
        const marker = await readPublicationMarker(resolvedCacheRoot, lockedBefore.version);
        if (marker?.state === "pending") {
          throw new Error("Plugin cache version has an incomplete pending publication");
        }
      }
      await assertExpectedSourceBinding(sourceRoot, expected);
      return { ...lockedBefore, applied: false, noOp: true };
    }
    if (lockedBefore.status !== "missing") {
      throw new Error(
        `Refusing to overwrite immutable cache version ${lockedBefore.version}; bump the plugin build version`
      );
    }
    await mkdir(stage, { mode: 0o700 });
    const snapshot = expected
      ? await createCommittedSourceSnapshot(sourceRoot, expected, resolvedCacheRoot, before.version)
      : null;
    snapshotRoot = snapshot?.snapshotRoot ?? null;
    await copyBundle(snapshot?.snapshotSource ?? path.resolve(sourceRoot), stage);
    const stagedManifest = await createBundleManifest(stage);
    const stagedDigest = digestObject(stagedManifest);
    const expectedBundleDigest = expected?.pluginBundleDigest ?? lockedBefore.sourceDigest;
    if (stagedDigest !== expectedBundleDigest) {
      throw new Error("Staged plugin cache digest does not match source");
    }
    const stagedSource = expected ? await assertExpectedSourceBinding(sourceRoot, expected) : null;
    if (stagedSource && stagedSource.bundleDigest !== expectedBundleDigest) {
      throw new Error("Plugin source changed during cache staging");
    }
    if (await pathExists(lockedBefore.target)) {
      throw new Error(`Plugin cache target appeared during publication: ${lockedBefore.target}`);
    }
    await assertExpectedSourceBinding(sourceRoot, expected, expectedBundleDigest);
    await writePublicationMarker({
      cacheRoot: resolvedCacheRoot,
      version: lockedBefore.version,
      state: "pending",
      targetDigest: expectedBundleDigest,
      sourceDigest: expectedBundleDigest,
      sourceBaselineRevision: expected?.sourceBaselineRevision ?? null,
      sourceHeadRevision: expected?.sourceHeadRevision ?? null,
      sourceBindingDigest: expected?.sourceBindingDigest ?? null,
      pluginBundleDigest: expected?.pluginBundleDigest ?? expectedBundleDigest,
      runId: publicationIdentity?.runId ?? null,
      attemptId: publicationIdentity?.attemptId ?? null
    });
    if (beforeRename) await beforeRename({ target: lockedBefore.target, sourceBinding: expected });
    await rename(stage, lockedBefore.target);
    publishedTarget = true;
    publishedPath = lockedBefore.target;
    const targetDigest = await bundleDigest(lockedBefore.target);
    if (targetDigest !== expectedBundleDigest) {
      throw new Error("Published plugin cache failed exact target verification");
    }
    await assertExpectedSourceBinding(sourceRoot, expected, targetDigest);
    // An expected handoff is an immutable commit snapshot. The source checkout
    // may advance after the last pre-rename check; that cannot change the bytes
    // already staged from the reviewed commit. Provider reconciliation performs
    // the live source-binding check before declaring the action successful.
    const after = expected
      ? {
          ...lockedBefore,
          ok: true,
          status: "identical",
          sourceDigest: expectedBundleDigest,
          targetDigest,
          diff: { missing: [], extra: [], changed: [] }
        }
      : await checkPluginCache({ sourceRoot, cacheRoot });
    if (!after.ok) throw new Error("Published plugin cache failed exact verification");
    return { ...after, applied: true, noOp: false };
  } catch (error) {
    let rollbackError = null;
    if (publishedTarget) {
      try {
        await rm(publishedPath, { recursive: true, force: false });
      } catch (candidate) {
        rollbackError = candidate;
      }
    }
    await unlink(publicationMarkerPath(resolvedCacheRoot, before.version)).catch(() => undefined);
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Plugin cache publication failed and target rollback also failed: ${publishedPath}`
      );
    }
    throw error;
  } finally {
    if (snapshotRoot) await rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
    await lock.close().catch(() => undefined);
    await releasePublicationLock(lockPath, lock.ownerToken);
  }
}

export async function recoverPendingPluginCachePublication({
  sourceRoot,
  cacheRoot,
  expectedSourceBinding,
  runId,
  attemptId
}) {
  const expected = validateExpectedSourceBinding(expectedSourceBinding);
  if (!expected || typeof runId !== "string" || !runId || typeof attemptId !== "string" || !attemptId) {
    throw new Error("Pending plugin cache recovery requires an exact source binding, run, and action attempt");
  }
  await assertExpectedSourceBinding(sourceRoot, expected);
  const current = await checkPluginCache({ sourceRoot, cacheRoot });
  if (!current.ok || current.status !== "identical") {
    throw new Error("Pending plugin cache recovery requires an exact published target");
  }
  const marker = await readPublicationMarker(cacheRoot, current.version);
  if (
    !marker ||
    marker.state !== "pending" ||
    marker.target !== current.target ||
    marker.targetDigest !== current.targetDigest ||
    marker.sourceDigest !== expected.pluginBundleDigest ||
    marker.sourceBaselineRevision !== expected.sourceBaselineRevision ||
    marker.sourceHeadRevision !== expected.sourceHeadRevision ||
    marker.sourceBindingDigest !== expected.sourceBindingDigest ||
    marker.pluginBundleDigest !== expected.pluginBundleDigest ||
    marker.runId !== runId ||
    marker.attemptId !== attemptId
  ) {
    throw new Error("Pending plugin cache publication marker is not bound to this action attempt");
  }
  const resolvedCacheRoot = path.resolve(cacheRoot);
  const reclaimed = await reclaimStalePublicationLock(
    path.join(resolvedCacheRoot, `.${current.version}.publish.lock`),
    current.version
  );
  if (reclaimed) await removeStalePublicationArtifacts(resolvedCacheRoot, current.version);
  return { ...current, applied: true, noOp: false, recovered: true, status: "identical" };
}
