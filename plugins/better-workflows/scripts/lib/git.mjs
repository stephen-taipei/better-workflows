import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, execBoundGit, sha256 } from "./core.mjs";
const SOURCE_GIT_EXECUTABLE = "/usr/bin/git";
const SOURCE_GIT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const SOURCE_GIT_TIMEOUT_MS = 30_000;
const SOURCE_GIT_MAX_BUFFER = 4 * 1024 * 1024;

function isolatedGitEnvironment() {
  return {
    PATH: SOURCE_GIT_PATH,
    HOME: "/var/empty",
    LANG: "C",
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1"
  };
}

async function git(cwd, args, {
  allowFailure = false,
  isolatedConfig = false,
  isolatedEnvironment = false,
  timeoutMs = SOURCE_GIT_TIMEOUT_MS,
  maxBuffer = 32 * 1024 * 1024,
  encoding = "utf8",
  workTree = null
} = {}) {
  try {
    const commandArgs = isolatedConfig
      ? [
          "--no-replace-objects",
          ...(workTree === null ? [] : [`--work-tree=${workTree}`]),
          "-c", "core.fsmonitor=false",
          "-c", "core.hooksPath=/dev/null",
          "-c", "credential.helper=",
          ...args
        ]
      : args;
    const environment = isolatedConfig || isolatedEnvironment
      ? isolatedGitEnvironment()
      : { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    const result = await execBoundGit(SOURCE_GIT_EXECUTABLE, commandArgs, {
      cwd,
      env: environment,
      timeoutMs: Math.min(timeoutMs, SOURCE_GIT_TIMEOUT_MS),
      maxBuffer: Math.min(maxBuffer, SOURCE_GIT_MAX_BUFFER),
      encoding
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (allowFailure) {
      return {
        ok: false,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message,
        code: error.code
      };
    }
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const failure = new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`);
    failure.code = error.code;
    failure.signal = error.signal;
    failure.stdout = error.stdout;
    failure.stderr = error.stderr;
    throw failure;
  }
}

function sourceGit(cwd, args, options = {}) {
  const { validateWorktree = true, workTree = null, ...gitOptions } = options;
  return (async () => {
    const expectedWorkTree = workTree ?? await findCanonicalWorktree(cwd);
    if (validateWorktree) await validateConfiguredWorktree(cwd, expectedWorkTree);
    return git(cwd, args, { ...gitOptions, workTree: expectedWorkTree, isolatedConfig: true });
  })();
}

export function runSourceGit(cwd, args, options = {}) {
  return sourceGit(cwd, args, options);
}

export async function canonicalSourceRoot(cwd) {
  const expectedWorkTree = await findCanonicalWorktree(cwd);
  await validateConfiguredWorktree(cwd, expectedWorkTree);
  return expectedWorkTree;
}

export async function isGitRepository(cwd) {
  try {
    const result = await sourceGit(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
    return result.ok && result.stdout.trim() === "true";
  } catch (error) {
    // A repository-local core.worktree redirect is an authority violation,
    // not evidence that the path simply is not a repository.  Preserve the
    // failure so callers such as captureSourceBinding fail closed instead of
    // silently returning null and allowing a redirected worktree to pass.
    if (/^Git core\.worktree configuration/.test(String(error?.message ?? error))) {
      throw error;
    }
    return false;
  }
}

async function findCanonicalWorktree(cwd) {
  let cursor = await realpath(path.resolve(cwd));
  for (;;) {
    const gitPath = path.join(cursor, ".git");
    try {
      const info = await lstat(gitPath);
      if (info.isDirectory() || info.isFile()) return cursor;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`Git worktree metadata was not found above ${path.resolve(cwd)}`);
}

async function validateConfiguredWorktree(cwd, expectedWorkTree) {
  const result = await git(cwd, ["config", "--local", "--no-includes", "--get-all", "core.worktree"], {
    allowFailure: true,
    isolatedConfig: true,
    isolatedEnvironment: true,
    workTree: expectedWorkTree,
    validateWorktree: false
  });
  if (!result.ok) return;
  const values = String(result.stdout).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  for (const value of values) {
    if (/^[\0\r\n]/.test(value)) throw new Error("Git core.worktree configuration contains an invalid value");
    const configured = path.isAbsolute(value) ? path.resolve(value) : path.resolve(expectedWorkTree, value);
    let resolved;
    try {
      resolved = await realpath(configured);
    } catch {
      throw new Error("Git core.worktree configuration does not resolve to the expected worktree");
    }
    if (resolved !== expectedWorkTree) {
      throw new Error(`Git core.worktree configuration redirects away from ${expectedWorkTree}`);
    }
  }
}

function normalizeRelative(cwd, candidate) {
  const absolute = path.resolve(cwd, candidate);
  const relative = path.relative(cwd, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Scope escapes repository: ${candidate}`);
  }
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function excluded(relative, exclusions) {
  const normalized = relative.replace(/^\.\//, "");
  return exclusions.some((entry) => {
    const pattern = String(entry).replace(/^\.\//, "").replace(/\/$/, "");
    if (!pattern) return false;
    if (pattern.includes("*")) {
      const escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replaceAll("**", "::DOUBLE_STAR::")
        .replaceAll("*", "[^/]*")
        .replaceAll("::DOUBLE_STAR::", ".*");
      return new RegExp(`(^|/)${escaped}($|/)`).test(normalized);
    }
    return normalized === pattern || normalized.startsWith(`${pattern}/`) || normalized.includes(`/${pattern}/`);
  });
}

async function metadata(target) {
  const info = await lstat(target);
  const result = {
    mode: info.mode,
    size: info.size,
    mtimeMs: Math.trunc(info.mtimeMs),
    type: info.isSymbolicLink()
      ? "symlink"
      : info.isDirectory()
        ? "directory"
        : info.isFile()
          ? "file"
          : "other"
  };
  if (info.isSymbolicLink()) result.target = await readlink(target);
  return result;
}

async function digestFile(target, maxBytes) {
  const info = await lstat(target);
  if (info.isSymbolicLink()) {
    return { type: "symlink", target: await readlink(target), size: info.size, bytesHashed: 0 };
  }
  if (!info.isFile()) return { type: "other", size: info.size, bytesHashed: 0 };
  if (info.size > maxBytes) {
    return {
      type: "file",
      size: info.size,
      mtimeMs: Math.trunc(info.mtimeMs),
      skipped: "single-file-budget",
      bytesHashed: 0
    };
  }
  const contents = await readFile(target);
  return {
    type: "file",
    size: info.size,
    digest: sha256(contents),
    lfsPointer: contents
      .subarray(0, 128)
      .toString("utf8")
      .startsWith("version https://git-lfs.github.com/spec/v1"),
    bytesHashed: contents.byteLength
  };
}

async function digestPaths(cwd, relativePaths, budget, exclusions) {
  const records = [];
  const skipped = [];
  let bytes = 0;
  let count = 0;
  for (const relative of [...new Set(relativePaths)].sort()) {
    if (!relative || excluded(relative, exclusions)) {
      if (relative) skipped.push({ path: relative, reason: "volatile-exclusion" });
      continue;
    }
    count += 1;
    if (count > budget.maxFiles) {
      skipped.push({ path: relative, reason: "file-count-budget" });
      continue;
    }
    const absolute = path.resolve(cwd, relative);
    if (!absolute.startsWith(`${path.resolve(cwd)}${path.sep}`) && absolute !== path.resolve(cwd)) {
      throw new Error(`Path escapes repository: ${relative}`);
    }
    let record;
    try {
      record = await digestFile(absolute, budget.maxSingleFileBytes);
    } catch (error) {
      if (error.code === "ENOENT") {
        record = { type: "missing", bytesHashed: 0 };
      } else {
        throw error;
      }
    }
    if (bytes + record.bytesHashed > budget.maxBytes) {
      skipped.push({ path: relative, reason: "total-byte-budget" });
      records.push({
        path: relative,
        type: record.type,
        size: record.size,
        skipped: "total-byte-budget"
      });
      continue;
    }
    bytes += record.bytesHashed;
    delete record.bytesHashed;
    records.push({ path: relative, ...record });
  }
  return {
    digest: sha256(canonicalJson(records)),
    records,
    skipped,
    bytesHashed: bytes,
    complete: skipped.every((item) => item.reason === "volatile-exclusion")
  };
}

function parseUntracked(statusOutput) {
  return statusOutput
    .split("\0")
    .filter((record) => record.startsWith("? "))
    .map((record) => record.slice(2));
}

async function untrackedMetadata(cwd, paths, exclusions, maxFiles) {
  const records = [];
  const skipped = [];
  for (const relative of [...new Set(paths)].sort()) {
    if (excluded(relative, exclusions)) {
      skipped.push({ path: relative, reason: "volatile-exclusion" });
      continue;
    }
    if (records.length >= maxFiles) {
      skipped.push({ path: relative, reason: "file-count-budget" });
      continue;
    }
    try {
      records.push({ path: relative, ...(await metadata(path.resolve(cwd, relative))) });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      records.push({ path: relative, type: "missing" });
    }
  }
  return { records, skipped, digest: sha256(canonicalJson(records)) };
}

async function gitPath(cwd, name) {
  const result = await git(cwd, ["--no-replace-objects", "rev-parse", "--git-path", name], {
    isolatedEnvironment: true
  });
  return path.resolve(cwd, result.stdout.trim());
}

async function localConfigValues(cwd, key) {
  const result = await sourceGit(cwd, ["config", "--local", "--no-includes", "--get-all", key], {
    allowFailure: true
  });
  if (!result.ok) return [];
  const values = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (values.some((value) => /[\0\r\n]/.test(value))) {
    throw new Error(`Source binding contains an invalid local Git value for ${key}`);
  }
  return values;
}

export async function hiddenIndexEntries(cwd, { isolatedConfig = false } = {}) {
  const result = await git(cwd, ["ls-files", "-v", "-z"], { isolatedConfig });
  const records = [];
  for (const entry of result.stdout.split("\0").filter(Boolean)) {
    const status = entry[0];
    const relative = entry.startsWith(`${status} `) ? entry.slice(2) : null;
    if (!relative || !["h", "s", "S"].includes(status)) continue;
    records.push({ path: relative, status });
  }
  records.sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));
  return { records, digest: sha256(canonicalJson(records)) };
}

async function digestOptionalFile(target, maxBytes = 1024 * 1024) {
  try {
    return await digestFile(target, maxBytes);
  } catch (error) {
    if (error.code === "ENOENT") return { type: "missing" };
    throw error;
  }
}

async function hooksAndConfig(cwd) {
  const configPath = await gitPath(cwd, "config");
  const hooksPath = await gitPath(cwd, "hooks");
  const config = await digestOptionalFile(configPath);
  const hooks = [];
  try {
    for (const entry of (await readdir(hooksPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      hooks.push({
        name: entry.name,
        ...(await digestOptionalFile(path.join(hooksPath, entry.name)))
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    config: { path: path.relative(cwd, configPath), ...config },
    hooks,
    digest: sha256(canonicalJson({ config, hooks }))
  };
}

async function trackedSymlinks(cwd) {
  const result = await git(cwd, ["ls-files", "-s", "-z"]);
  const records = [];
  for (const entry of result.stdout.split("\0").filter(Boolean)) {
    const match = entry.match(/^(\d{6}) ([a-f0-9]+) (\d+)\t(.+)$/s);
    if (!match || match[1] !== "120000") continue;
    const relative = match[4];
    let target = null;
    try {
      target = await readlink(path.resolve(cwd, relative));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    records.push({ path: relative, indexObject: match[2], target });
  }
  return { records, digest: sha256(canonicalJson(records)) };
}

async function attributesDigest(cwd, budget) {
  const result = await git(cwd, ["ls-files", "-z", "--", ".gitattributes", ":(glob)**/.gitattributes"]);
  return digestPaths(cwd, result.stdout.split("\0").filter(Boolean), budget, []);
}

async function highRiskIgnored(cwd, requested, budget) {
  const paths = requested.map((item) => normalizeRelative(cwd, item));
  return digestPaths(cwd, paths, budget, []);
}

export async function captureSourceBinding(cwd, {
  baseRevision = null,
  requireClean = false,
  beforeFinalCheck = null
} = {}) {
  const repository = await realpath(path.resolve(cwd));
  if (!(await isGitRepository(repository))) return null;
  const expectedRepositoryRoot = await findCanonicalWorktree(repository);

  if (beforeFinalCheck !== null && typeof beforeFinalCheck !== "function") {
    throw new Error("Source binding final-check hook must be a function");
  }

  const directoryIdentity = (target, info) => ({
    path: target,
    device: Number.isSafeInteger(info.dev) ? info.dev : null,
    inode: Number.isSafeInteger(info.ino) ? info.ino : null
  });
  const captureLayout = async () => {
    const headRevision = (await sourceGit(repository, ["rev-parse", "HEAD"])).stdout.trim();
    const repositoryRoot = await realpath((await sourceGit(repository, ["rev-parse", "--show-toplevel"])).stdout.trim());
    const gitDir = await realpath(path.resolve(repository, (await sourceGit(repository, ["rev-parse", "--git-dir"])).stdout.trim()));
    const gitCommonDir = await realpath(path.resolve(repository, (await sourceGit(repository, ["rev-parse", "--git-common-dir"])).stdout.trim()));
    const [gitDirInfo, gitCommonDirInfo] = await Promise.all([lstat(gitDir), lstat(gitCommonDir)]);
    return {
      headRevision,
      repositoryRoot,
      gitDir: directoryIdentity(gitDir, gitDirInfo),
      gitCommonDir: directoryIdentity(gitCommonDir, gitCommonDirInfo)
    };
  };
  const initialLayout = await captureLayout();
  if (initialLayout.repositoryRoot !== expectedRepositoryRoot) {
    throw new Error("Source binding Git worktree root does not match the canonical repository root");
  }

  const worktreeStatus = (await sourceGit(repository, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored"])).stdout;
  const hiddenIndex = await hiddenIndexEntries(repository, { isolatedConfig: true });
  const worktreeClean = worktreeStatus.length === 0 && hiddenIndex.records.length === 0;
  if (requireClean && !worktreeClean) {
    throw new Error("Source binding requires a clean index, tracked worktree, untracked surface, and ignored surface; visible tracked index flags are required");
  }
  const headRevision = initialLayout.headRevision;
  const repositoryRoot = initialLayout.repositoryRoot;
  const gitDir = initialLayout.gitDir.path;
  const gitCommonDir = initialLayout.gitCommonDir.path;
  const originUrls = await localConfigValues(repository, "remote.origin.url");
  const originPushUrls = await localConfigValues(repository, "remote.origin.pushurl");
  const headRef = (await sourceGit(repository, ["symbolic-ref", "-q", "HEAD"], { allowFailure: true })).stdout.trim() || null;
  const originHeadRef = (await sourceGit(repository, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { allowFailure: true })).stdout.trim() || null;
  let resolvedBaseRevision = null;
  if (baseRevision) {
    const resolved = await sourceGit(
      repository,
      ["rev-parse", "--verify", `${String(baseRevision)}^{commit}`],
      { allowFailure: true }
    );
    if (resolved.ok) resolvedBaseRevision = resolved.stdout.trim();
  }
  const committedDiff = resolvedBaseRevision
    ? (await sourceGit(repository, [
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-z",
        resolvedBaseRevision,
        headRevision,
        "--"
      ])).stdout
    : "";
  const committedModeManifest = resolvedBaseRevision
    ? (await sourceGit(repository, [
        "diff-tree",
        "--no-commit-id",
        "--raw",
        "-r",
        "-z",
        resolvedBaseRevision,
        headRevision,
        "--"
      ])).stdout
    : "";
  if (beforeFinalCheck) await beforeFinalCheck({ repository, headRevision });
  const finalWorktreeStatus = (await sourceGit(repository, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored"])).stdout;
  const finalHiddenIndex = await hiddenIndexEntries(repository, { isolatedConfig: true });
  const finalOriginUrls = await localConfigValues(repository, "remote.origin.url");
  const finalOriginPushUrls = await localConfigValues(repository, "remote.origin.pushurl");
  const finalHeadRef = (await sourceGit(repository, ["symbolic-ref", "-q", "HEAD"], { allowFailure: true })).stdout.trim() || null;
  const finalOriginHeadRef = (await sourceGit(repository, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { allowFailure: true })).stdout.trim() || null;
  const finalLayout = await captureLayout();
  const sameOrigin = JSON.stringify({ fetchUrls: originUrls, pushUrls: originPushUrls }) ===
    JSON.stringify({ fetchUrls: finalOriginUrls, pushUrls: finalOriginPushUrls });
  if (
    finalLayout.headRevision !== headRevision ||
    finalLayout.repositoryRoot !== repositoryRoot ||
    JSON.stringify(finalLayout.gitDir) !== JSON.stringify(initialLayout.gitDir) ||
    JSON.stringify(finalLayout.gitCommonDir) !== JSON.stringify(initialLayout.gitCommonDir) ||
    finalWorktreeStatus !== worktreeStatus ||
    finalHiddenIndex.digest !== hiddenIndex.digest ||
    !sameOrigin ||
    finalHeadRef !== headRef ||
    finalOriginHeadRef !== originHeadRef
  ) {
    throw new Error("Source binding changed during stable snapshot capture");
  }
  const diffManifest = {
    schemaVersion: 2,
    baseRevision: resolvedBaseRevision,
    headRevision,
    committedDiff,
    committedModeManifest,
    headRef,
    originHeadRef
  };
  const diffManifestDigest = sha256(canonicalJson(diffManifest));
  const stable = {
    schemaVersion: 3,
    cwd: repository,
    repositoryRoot,
    gitDir: initialLayout.gitDir,
    gitCommonDir: initialLayout.gitCommonDir,
    originIdentity: {
      present: originUrls.length > 0,
      fetchUrls: originUrls,
      pushUrls: originPushUrls,
      digest: originUrls.length > 0 || originPushUrls.length > 0
        ? sha256(canonicalJson({ fetchUrls: originUrls, pushUrls: originPushUrls }))
        : null
    },
    symbolicRefs: { head: headRef, originHead: originHeadRef },
    baseRevision: resolvedBaseRevision,
    headRevision,
    worktreeClean,
    worktreeStatusDigest: sha256(worktreeStatus),
    hiddenIndexDigest: hiddenIndex.digest,
    hiddenIndexCount: hiddenIndex.records.length,
    diffManifestDigest
  };
  return { ...stable, digest: sha256(canonicalJson(stable)) };
}

export async function captureSentinel(cwd, contract, defaults) {
  const repository = path.resolve(cwd);
  if (!(await isGitRepository(repository))) throw new Error(`Not a Git repository: ${repository}`);
  const exclusions = [
    ...(defaults.sentinel.volatileExclusions ?? []),
    ...(contract.volatileExclusions ?? [])
  ];
  const budget = {
    maxFiles: defaults.sentinel.maxFiles,
    maxBytes: defaults.sentinel.maxBytes,
    maxSingleFileBytes: defaults.sentinel.maxSingleFileBytes
  };
  const scopes = contract.scope.include.map((item) => normalizeRelative(repository, item));
  const status = await git(repository, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  const head = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
  const indexPath = await gitPath(repository, "index");
  const index = await digestOptionalFile(indexPath, Number.MAX_SAFE_INTEGER);
  const tracked = await git(repository, ["ls-files", "-z", "--", ...scopes]);
  const scopeDigest = await digestPaths(
    repository,
    tracked.stdout.split("\0").filter(Boolean),
    budget,
    exclusions
  );
  const untracked = await untrackedMetadata(
    repository,
    parseUntracked(status.stdout),
    exclusions,
    budget.maxFiles
  );
  const submodules = await git(repository, ["submodule", "status", "--recursive"], {
    allowFailure: true
  });
  const symlinks = await trackedSymlinks(repository);
  const attributes = await attributesDigest(repository, budget);
  const authorityMetadata = await hooksAndConfig(repository);
  const ignored = await highRiskIgnored(repository, contract.highRiskIgnored ?? [], budget);
  const stable = {
    schemaVersion: 1,
    cwd: repository,
    head,
    indexDigest: index.digest ?? sha256(canonicalJson(index)),
    statusDigest: sha256(status.stdout),
    scopes,
    scopeDigest,
    untracked,
    submodules: {
      available: submodules.ok,
      digest: sha256(submodules.stdout),
      value: submodules.stdout.trim()
    },
    symlinks,
    attributes,
    authorityMetadata,
    highRiskIgnored: ignored,
    exclusions
  };
  const skipped = [
    ...scopeDigest.skipped,
    ...untracked.skipped,
    ...attributes.skipped,
    ...ignored.skipped
  ];
  return {
    ...stable,
    checkedAt: new Date().toISOString(),
    complete:
      scopeDigest.complete &&
      attributes.complete &&
      ignored.complete &&
      untracked.skipped.every((item) => item.reason === "volatile-exclusion"),
    skipped,
    digest: sha256(canonicalJson(stable))
  };
}

export function compareSentinels(before, after) {
  if (before.digest === after.digest) return { same: true, changed: [] };
  const ignored = new Set(["digest", "checkedAt", "complete", "skipped"]);
  const changed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (ignored.has(key)) continue;
    if (canonicalJson(before[key]) !== canonicalJson(after[key])) changed.push(key);
  }
  return { same: false, changed };
}
