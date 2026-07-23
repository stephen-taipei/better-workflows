import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

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

export async function publishPluginCache({ sourceRoot, cacheRoot }) {
  const before = await checkPluginCache({ sourceRoot, cacheRoot });
  if (before.ok) return { ...before, applied: false, noOp: true };
  if (before.status === "drifted") {
    throw new Error(
      `Refusing to overwrite immutable cache version ${before.version}; bump the plugin build version`
    );
  }
  const resolvedCacheRoot = path.resolve(cacheRoot);
  await mkdir(resolvedCacheRoot, { recursive: true, mode: 0o700 });
  await assertDirectoryNotSymlink(resolvedCacheRoot);
  const lockPath = path.join(resolvedCacheRoot, `.${before.version}.publish.lock`);
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") {
      throw new Error(`Plugin cache publication is already in progress for ${before.version}`);
    }
    throw error;
  });
  const stage = path.join(resolvedCacheRoot, `.${before.version}.stage-${randomUUID()}`);
  let publishedTarget = false;
  let publishedPath = null;
  try {
    await lock.writeFile(
      `${JSON.stringify({ version: before.version, pid: process.pid, createdAt: new Date().toISOString() })}\n`
    );
    await lock.sync();
    const lockedBefore = await checkPluginCache({ sourceRoot, cacheRoot });
    if (
      lockedBefore.version !== before.version ||
      lockedBefore.target !== before.target
    ) {
      throw new Error(
        `Plugin source version changed while acquiring publication lock: ${before.version} -> ${lockedBefore.version}`
      );
    }
    if (lockedBefore.ok) return { ...lockedBefore, applied: false, noOp: true };
    if (lockedBefore.status !== "missing") {
      throw new Error(
        `Refusing to overwrite immutable cache version ${lockedBefore.version}; bump the plugin build version`
      );
    }
    await mkdir(stage, { mode: 0o700 });
    await copyBundle(path.resolve(sourceRoot), stage);
    const stagedManifest = await createBundleManifest(stage);
    const stagedDigest = digestObject(stagedManifest);
    if (stagedDigest !== lockedBefore.sourceDigest) {
      throw new Error("Staged plugin cache digest does not match source");
    }
    if (await bundleDigest(sourceRoot) !== lockedBefore.sourceDigest) {
      throw new Error("Plugin source changed during cache staging");
    }
    if (await pathExists(lockedBefore.target)) {
      throw new Error(`Plugin cache target appeared during publication: ${lockedBefore.target}`);
    }
    await rename(stage, lockedBefore.target);
    publishedTarget = true;
    publishedPath = lockedBefore.target;
    const targetDigest = await bundleDigest(lockedBefore.target);
    const finalSourceDigest = await bundleDigest(sourceRoot);
    if (
      targetDigest !== lockedBefore.sourceDigest ||
      finalSourceDigest !== lockedBefore.sourceDigest
    ) {
      throw new Error("Published plugin cache failed final source and target verification");
    }
    const after = await checkPluginCache({ sourceRoot, cacheRoot });
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
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Plugin cache publication failed and target rollback also failed: ${publishedPath}`
      );
    }
    throw error;
  } finally {
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}
