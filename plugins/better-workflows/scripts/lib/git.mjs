import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256 } from "./core.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, args, { allowFailure = false, maxBuffer = 32 * 1024 * 1024 } = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
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
    throw new Error(`git ${args.join(" ")} failed: ${error.stderr ?? error.message}`);
  }
}

export async function isGitRepository(cwd) {
  const result = await git(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  return result.ok && result.stdout.trim() === "true";
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
  const result = await git(cwd, ["rev-parse", "--git-path", name]);
  return path.resolve(cwd, result.stdout.trim());
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
