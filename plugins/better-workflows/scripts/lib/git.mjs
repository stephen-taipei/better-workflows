import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, execBoundGit, sha256 } from "./core.mjs";
import { isExactGitAbsence, readRawLocalConfigValues } from "./autonomy-snapshot.mjs";
const SOURCE_GIT_EXECUTABLE = "/usr/bin/git";
const SOURCE_GIT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const SOURCE_GIT_TIMEOUT_MS = 30_000;
const SOURCE_GIT_MAX_BUFFER = 4 * 1024 * 1024;
const MANAGED_RECIPE_ARTIFACT_ROOT = ".codex/better-workflows/artifacts";
const MANAGED_RECIPE_ARTIFACT_MARKER = `${MANAGED_RECIPE_ARTIFACT_ROOT}/.gitignore`;
const MANAGED_RECIPE_ARTIFACT_MARKER_BYTES = "*\n!.gitignore\n";

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
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null"
  };
}

function gitFailureDetail(error) {
  const message = String(error?.message ?? "").trim();
  const stderr = Buffer.isBuffer(error?.stderr)
    ? error.stderr.toString("utf8").trim()
    : String(error?.stderr ?? "").trim();
  if (!message) return stderr || "unknown failure";
  if (!stderr || message.includes(stderr)) return message;
  return `${message}: ${stderr}`;
}

function optionalSourceGitOutput(result, label, { absentCodes = [1] } = {}) {
  if (result?.ok === true) return result.stdout;
  if (isExactGitAbsence(result, { absentCodes })) return null;
  const detail = String(result?.stderr || result?.code || "unknown failure").trim();
  throw new Error(`${label} failed: ${detail}`);
}

export function parseOptionalSourceSymbolicRef(output, label = "Source binding symbolic-ref read") {
  if (output === null) return null;
  if (typeof output !== "string" || !/^refs\/[^\x00-\x20\x7f]+\n$/.test(output)) {
    throw new Error(`${label} returned malformed success output`);
  }
  return output.slice(0, -1);
}

export function parseOptionalSourceCommitRevision(output, label = "Source binding revision read") {
  if (output === null) return null;
  if (typeof output !== "string" || !/^[a-f0-9]{40}\n$/i.test(output)) {
    throw new Error(`${label} returned malformed success output`);
  }
  return output.slice(0, -1);
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
    const detail = gitFailureDetail(error);
    if (allowFailure) {
      return {
        ok: false,
        stdout: error.stdout ?? (encoding === "buffer" ? Buffer.alloc(0) : ""),
        stderr: encoding === "buffer" ? Buffer.from(detail) : detail,
        code: error.code,
        signal: error.signal ?? null,
        timedOut: error.code === "ETIMEDOUT",
        outputExceeded: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      };
    }
    const failure = new Error(`git ${args.join(" ")} failed: ${detail}`);
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

export function parseGitWorktreeProbeOutput(stdout) {
  if (stdout === "true\n") return true;
  if (stdout === "false\n") return false;
  throw new Error("Git worktree probe returned malformed success output");
}

export async function isGitRepository(cwd, {
  runGit = sourceGit
} = {}) {
  let expectedWorkTree;
  try {
    expectedWorkTree = await findCanonicalWorktree(cwd);
  } catch (error) {
    if (error?.code === "SBW_GIT_METADATA_NOT_FOUND") return false;
    throw error;
  }
  const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], {
    workTree: expectedWorkTree
  });
  if (result?.ok !== true) throw new Error("Git worktree probe returned an indeterminate result");
  return parseGitWorktreeProbeOutput(result.stdout);
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
  const error = new Error(`Git worktree metadata was not found above ${path.resolve(cwd)}`);
  error.code = "SBW_GIT_METADATA_NOT_FOUND";
  throw error;
}

async function validateConfiguredWorktree(cwd, expectedWorkTree) {
  const values = await readRawLocalConfigValues(
    (args, options) => git(cwd, args, {
      ...options,
      isolatedConfig: true,
      isolatedEnvironment: true,
      workTree: expectedWorkTree
    }),
    "core.worktree",
    { maxBuffer: SOURCE_GIT_MAX_BUFFER, label: "Git core.worktree configuration" }
  );
  for (const value of values) {
    if (!value) throw new Error("Git core.worktree configuration contains an empty value");
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

async function untrackedMetadata(cwd, paths, exclusions, budget) {
  // Untracked paths are part of the mutable source surface. Hash their bytes
  // with the same bounded policy as tracked scope files; names, sizes, and
  // mtimes alone cannot distinguish same-path content replacement.
  return digestPaths(cwd, paths, budget, exclusions);
}

async function gitPath(cwd, name) {
  const expectedWorkTree = await findCanonicalWorktree(cwd);
  await validateConfiguredWorktree(cwd, expectedWorkTree);
  const result = await git(cwd, [
    "--no-replace-objects",
    `--work-tree=${expectedWorkTree}`,
    "-c", "core.fsmonitor=false",
    "-c", "credential.helper=",
    "rev-parse", "--git-path", name
  ], { isolatedEnvironment: true });
  return path.resolve(cwd, result.stdout.trim());
}

async function localConfigValues(cwd, key) {
  return readRawLocalConfigValues(
    (args, options) => sourceGit(cwd, args, options),
    key,
    { maxBuffer: SOURCE_GIT_MAX_BUFFER, label: "Source binding" }
  );
}

export async function hiddenIndexEntries(cwd, { isolatedConfig = false } = {}) {
  const result = await sourceGit(cwd, ["ls-files", "-v", "-z"]);
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

async function assertNoLegacyGrafts(gitDir, gitCommonDir) {
  const directories = [...new Set([gitDir, gitCommonDir])];
  for (const directory of directories) {
    const graftsPath = path.join(directory, "info", "grafts");
    try {
      await lstat(graftsPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Legacy Git graft ancestry metadata is not allowed: ${graftsPath}`);
  }
}

async function gitAuthorityLayout(cwd) {
  const [gitDirResult, gitCommonDirResult, shallowResult] = await Promise.all([
    sourceGit(cwd, ["rev-parse", "--git-dir"]),
    sourceGit(cwd, ["rev-parse", "--git-common-dir"]),
    sourceGit(cwd, ["rev-parse", "--is-shallow-repository"])
  ]);
  const shallowRepository = shallowResult.stdout.trim();
  if (!new Set(["true", "false"]).has(shallowRepository)) {
    throw new Error("Git shallow repository state is indeterminate");
  }
  return {
    gitDir: await realpath(path.resolve(cwd, gitDirResult.stdout.trim())),
    gitCommonDir: await realpath(path.resolve(cwd, gitCommonDirResult.stdout.trim())),
    shallowRepository: shallowRepository === "true"
  };
}

function assertCompleteGitAncestry(layout) {
  if (layout.shallowRepository) {
    throw new Error("Shallow Git repositories are not allowed for immutable ancestry proofs");
  }
}

export async function assertSourceGitAncestryAuthority(cwd) {
  const repository = path.resolve(cwd);
  if (!(await isGitRepository(repository))) throw new Error(`Not a Git repository: ${repository}`);
  const layout = await gitAuthorityLayout(repository);
  await assertNoLegacyGrafts(layout.gitDir, layout.gitCommonDir);
  assertCompleteGitAncestry(layout);
  return layout;
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
  const result = await sourceGit(cwd, ["ls-files", "-s", "-z"]);
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
  const result = await sourceGit(cwd, ["ls-files", "-z", "--", ".gitattributes", ":(glob)**/.gitattributes"]);
  return digestPaths(cwd, result.stdout.split("\0").filter(Boolean), budget, []);
}

async function highRiskIgnored(cwd, requested, budget) {
  const paths = requested.map((item) => normalizeRelative(cwd, item));
  return digestPaths(cwd, paths, budget, []);
}

async function managedIgnoredSourceSurfaces(cwd) {
  const tracked = await sourceGit(
    cwd,
    ["ls-files", "--error-unmatch", "--", MANAGED_RECIPE_ARTIFACT_MARKER],
    { allowFailure: true }
  );
  if (tracked.ok !== true) {
    if (isExactGitAbsence(tracked, { absentCodes: [1] })) return [];
    throw new Error("Managed recipe artifact marker tracking is indeterminate");
  }
  if (tracked.stdout !== `${MANAGED_RECIPE_ARTIFACT_MARKER}\n`) {
    throw new Error("Managed recipe artifact marker tracking returned malformed output");
  }
  const markerPath = path.join(cwd, ...MANAGED_RECIPE_ARTIFACT_MARKER.split("/"));
  const info = await lstat(markerPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("Managed recipe artifact marker is not a safe regular file");
  }
  const bytes = await readFile(markerPath, "utf8");
  if (bytes !== MANAGED_RECIPE_ARTIFACT_MARKER_BYTES) {
    throw new Error("Managed recipe artifact marker policy changed");
  }
  return [{
    path: MANAGED_RECIPE_ARTIFACT_ROOT,
    marker: MANAGED_RECIPE_ARTIFACT_MARKER,
    markerDigest: sha256(bytes),
    policy: "ignored-recipe-artifacts-v1"
  }];
}

function normalizeManagedIgnoredStatus(stdout, surfaces) {
  if (typeof stdout !== "string") throw new Error("Source binding status returned non-text output");
  const parts = stdout.split("\0");
  if (parts.at(-1) === "") parts.pop();
  const managedRoots = new Set(surfaces.map((surface) => surface.path));
  const retained = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (!record) throw new Error("Source binding status returned an empty porcelain record");
    if (record.startsWith("2 ")) {
      const original = parts[index + 1];
      if (original === undefined) throw new Error("Source binding status returned a malformed rename record");
      retained.push(record, original);
      index += 1;
      continue;
    }
    if (record.startsWith("! ")) {
      const relative = record.slice(2).replace(/\/$/, "");
      if ([...managedRoots].some((root) => relative === root || relative.startsWith(`${root}/`))) {
        continue;
      }
    }
    retained.push(record);
  }
  return retained.length > 0 ? `${retained.join("\0")}\0` : "";
}

export async function normalizeSourceBindingWorktreeStatus(cwd, stdout) {
  return normalizeManagedIgnoredStatus(stdout, await managedIgnoredSourceSurfaces(cwd));
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
    const [headResult, rootResult, authorityLayout] = await Promise.all([
      sourceGit(repository, ["rev-parse", "HEAD"]),
      sourceGit(repository, ["rev-parse", "--show-toplevel"]),
      gitAuthorityLayout(repository)
    ]);
    const headRevision = headResult.stdout.trim();
    const repositoryRoot = await realpath(rootResult.stdout.trim());
    const { gitDir, gitCommonDir, shallowRepository } = authorityLayout;
    const [gitDirInfo, gitCommonDirInfo] = await Promise.all([lstat(gitDir), lstat(gitCommonDir)]);
    return {
      headRevision,
      repositoryRoot,
      gitDir: directoryIdentity(gitDir, gitDirInfo),
      gitCommonDir: directoryIdentity(gitCommonDir, gitCommonDirInfo),
      shallowRepository
    };
  };
  const initialLayout = await captureLayout();
  if (initialLayout.repositoryRoot !== expectedRepositoryRoot) {
    throw new Error("Source binding Git worktree root does not match the canonical repository root");
  }
  await assertNoLegacyGrafts(initialLayout.gitDir.path, initialLayout.gitCommonDir.path);
  assertCompleteGitAncestry(initialLayout);

  const managedIgnoredSurfaces = await managedIgnoredSourceSurfaces(repository);
  const rawWorktreeStatus = (await sourceGit(repository, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored"])).stdout;
  const worktreeStatus = normalizeManagedIgnoredStatus(rawWorktreeStatus, managedIgnoredSurfaces);
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
  const headRefResult = await sourceGit(repository, ["symbolic-ref", "-q", "HEAD"], { allowFailure: true });
  const originHeadRefResult = await sourceGit(repository, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { allowFailure: true });
  const headRefOutput = optionalSourceGitOutput(headRefResult, "Source binding HEAD symbolic-ref read");
  const originHeadRefOutput = optionalSourceGitOutput(originHeadRefResult, "Source binding origin/HEAD symbolic-ref read");
  const headRef = parseOptionalSourceSymbolicRef(headRefOutput, "Source binding HEAD symbolic-ref read");
  const originHeadRef = parseOptionalSourceSymbolicRef(originHeadRefOutput, "Source binding origin/HEAD symbolic-ref read");
  let resolvedBaseRevision = null;
  if (baseRevision) {
    const resolved = await sourceGit(
      repository,
      ["rev-parse", "--verify", "--quiet", `${String(baseRevision)}^{commit}`],
      { allowFailure: true }
    );
    const resolvedOutput = optionalSourceGitOutput(resolved, "Source binding base revision read", {
      absentCodes: [1]
    });
    resolvedBaseRevision = parseOptionalSourceCommitRevision(resolvedOutput, "Source binding base revision read");
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
  const finalManagedIgnoredSurfaces = await managedIgnoredSourceSurfaces(repository);
  const finalRawWorktreeStatus = (await sourceGit(repository, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored"])).stdout;
  const finalWorktreeStatus = normalizeManagedIgnoredStatus(finalRawWorktreeStatus, finalManagedIgnoredSurfaces);
  const finalHiddenIndex = await hiddenIndexEntries(repository, { isolatedConfig: true });
  const finalOriginUrls = await localConfigValues(repository, "remote.origin.url");
  const finalOriginPushUrls = await localConfigValues(repository, "remote.origin.pushurl");
  const finalHeadRefResult = await sourceGit(repository, ["symbolic-ref", "-q", "HEAD"], { allowFailure: true });
  const finalOriginHeadRefResult = await sourceGit(repository, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { allowFailure: true });
  const finalHeadRefOutput = optionalSourceGitOutput(finalHeadRefResult, "Source binding final HEAD symbolic-ref read");
  const finalOriginHeadRefOutput = optionalSourceGitOutput(finalOriginHeadRefResult, "Source binding final origin/HEAD symbolic-ref read");
  const finalHeadRef = parseOptionalSourceSymbolicRef(finalHeadRefOutput, "Source binding final HEAD symbolic-ref read");
  const finalOriginHeadRef = parseOptionalSourceSymbolicRef(finalOriginHeadRefOutput, "Source binding final origin/HEAD symbolic-ref read");
  const finalLayout = await captureLayout();
  await assertNoLegacyGrafts(finalLayout.gitDir.path, finalLayout.gitCommonDir.path);
  assertCompleteGitAncestry(finalLayout);
  const sameOrigin = JSON.stringify({ fetchUrls: originUrls, pushUrls: originPushUrls }) ===
    JSON.stringify({ fetchUrls: finalOriginUrls, pushUrls: finalOriginPushUrls });
  if (
    finalLayout.headRevision !== headRevision ||
    finalLayout.repositoryRoot !== repositoryRoot ||
    JSON.stringify(finalLayout.gitDir) !== JSON.stringify(initialLayout.gitDir) ||
    JSON.stringify(finalLayout.gitCommonDir) !== JSON.stringify(initialLayout.gitCommonDir) ||
    finalWorktreeStatus !== worktreeStatus ||
    finalHiddenIndex.digest !== hiddenIndex.digest ||
    canonicalJson(finalManagedIgnoredSurfaces) !== canonicalJson(managedIgnoredSurfaces) ||
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
    diffManifestDigest,
    ...(managedIgnoredSurfaces.length > 0 ? { managedIgnoredSurfaces } : {})
  };
  return { ...stable, digest: sha256(canonicalJson(stable)) };
}

export function validateSubmoduleStatusOutput(stdout) {
  if (typeof stdout !== "string") throw new Error("Git submodule status returned non-text success output");
  if (stdout === "") return stdout;
  if (!stdout.endsWith("\n") || stdout.includes("\0") || stdout.includes("\r")) {
    throw new Error("Git submodule status returned malformed success output");
  }
  for (const line of stdout.slice(0, -1).split("\n")) {
    if (!/^[ +\-U][a-f0-9]{40,64} [^\0\r\n]+$/i.test(line)) {
      throw new Error("Git submodule status returned malformed success output");
    }
  }
  return stdout;
}

export async function captureStrictSubmoduleStatus(runGit, repository) {
  const result = await runGit(repository, ["submodule", "status", "--recursive"]);
  if (result?.ok !== true) throw new Error("Git submodule status returned an indeterminate result");
  const stdout = validateSubmoduleStatusOutput(result.stdout);
  return {
    available: true,
    digest: sha256(stdout),
    value: stdout.trim()
  };
}

export async function captureSentinel(cwd, contract, defaults, {
  afterInitialAuthorityCheck = null,
  beforeFinalAuthorityCheck = null
} = {}) {
  const repository = path.resolve(cwd);
  const initialAuthorityLayout = await assertSourceGitAncestryAuthority(repository);
  if (afterInitialAuthorityCheck) await afterInitialAuthorityCheck(initialAuthorityLayout);
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
  const status = await sourceGit(repository, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  const head = (await sourceGit(repository, ["rev-parse", "HEAD"])).stdout.trim();
  const indexPath = await gitPath(repository, "index");
  const index = await digestOptionalFile(indexPath, Number.MAX_SAFE_INTEGER);
  const tracked = await sourceGit(repository, ["ls-files", "-z", "--", ...scopes]);
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
    budget
  );
  const submodules = await captureStrictSubmoduleStatus(sourceGit, repository);
  const symlinks = await trackedSymlinks(repository);
  const attributes = await attributesDigest(repository, budget);
  const authorityMetadata = await hooksAndConfig(repository);
  const ignored = await highRiskIgnored(repository, contract.highRiskIgnored ?? [], budget);
  if (beforeFinalAuthorityCheck) await beforeFinalAuthorityCheck();
  const finalAuthorityLayout = await assertSourceGitAncestryAuthority(repository);
  if (canonicalJson(finalAuthorityLayout) !== canonicalJson(initialAuthorityLayout)) {
    throw new Error("Sentinel Git authority layout changed during stable snapshot capture");
  }
  const stable = {
    schemaVersion: 1,
    cwd: repository,
    head,
    indexDigest: index.digest ?? sha256(canonicalJson(index)),
    statusDigest: sha256(status.stdout),
    scopes,
    scopeDigest,
    untracked,
    submodules,
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
