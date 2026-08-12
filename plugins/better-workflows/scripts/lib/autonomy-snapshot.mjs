import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import path from "node:path";
import { validateAutonomyBinding } from "./autonomy.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

export function autonomyBoundaryError(reason, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.autonomyReason = reason;
  if (cause?.code !== undefined) error.code = cause.code;
  if (cause?.signal !== undefined) error.signal = cause.signal;
  return error;
}

export function isExactGitAbsence(result, { absentCodes = [1] } = {}) {
  return result?.ok === false && absentCodes.includes(Number(result.code)) && result.signal == null &&
    !result.timedOut && !result.outputExceeded;
}

export async function readRawLocalConfigValues(runGit, key, {
  maxBuffer,
  timeoutMs,
  label = "Git configuration"
} = {}) {
  const result = await runGit(["config", "--null", "--local", "--no-includes", "--get-all", key], {
    allowFailure: true,
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
  if (!result.ok) {
    if (isExactGitAbsence(result)) return [];
    const detail = String(result.stderr || result.code || "unknown failure").trim();
    const error = new Error(`${label} could not read raw local ${key}: ${detail}`);
    error.code = result.code;
    error.signal = result.signal;
    throw error;
  }
  if (typeof result.stdout !== "string") throw new Error(`${label} returned non-text ${key} values`);
  if (!result.stdout.endsWith("\0")) throw new Error(`${label} returned unterminated raw local ${key} values`);
  const values = result.stdout.slice(0, -1).split("\0");
  if (values.some((value) => /[\r\n]/.test(value))) {
    throw new Error(`${label} contains an invalid raw local ${key} value`);
  }
  return values;
}

export function canonicalGovernedGithubRepository(remote) {
  if (typeof remote !== "string" || remote !== remote.trim() || !remote) return null;
  let parsed;
  try {
    parsed = new URL(remote);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.port && parsed.port !== "443")) return null;
  const pathname = parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
  const parts = pathname.split("/");
  if (parts.length !== 3 || parts[0] !== "" || !SAFE_COMPONENT.test(parts[1])) return null;
  const repository = parts[2].endsWith(".git") ? parts[2].slice(0, -4) : parts[2];
  if (!SAFE_COMPONENT.test(repository)) return null;
  return `github.com/${parts[1]}/${repository}`;
}

export async function currentAutonomyBranchFromGit(runGit, options = {}) {
  const result = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    allowFailure: true,
    ...options
  });
  if (!result.ok) {
    if (isExactGitAbsence(result)) return null;
    const error = new Error(`Autonomy branch lookup failed: ${String(result.stderr || result.code || "unknown failure").trim()}`);
    error.code = result.code;
    error.signal = result.signal;
    throw error;
  }
  if (typeof result.stdout !== "string" || !/^[^\0\r\n]+\n$/.test(result.stdout)) {
    throw new Error("Autonomy branch lookup returned malformed success output");
  }
  return result.stdout.slice(0, -1);
}

export async function resolveGovernedGithubRepository(runGit, options = {}) {
  const fetchUrls = await readRawLocalConfigValues(runGit, "remote.origin.url", {
    ...options,
    label: options.label ?? "Autonomy repository binding"
  });
  const pushUrls = await readRawLocalConfigValues(runGit, "remote.origin.pushurl", {
    ...options,
    label: options.label ?? "Autonomy repository binding"
  });
  if (fetchUrls.length !== 1 || pushUrls.length > 1) {
    throw new Error("bounded-autopilot-v1 requires one raw local origin and at most one raw push URL");
  }
  const repository = canonicalGovernedGithubRepository(fetchUrls[0]);
  const pushRepository = pushUrls.length === 0
    ? repository
    : canonicalGovernedGithubRepository(pushUrls[0]);
  if (!repository || pushRepository !== repository) {
    throw new Error("bounded-autopilot-v1 requires matching credential-free HTTPS GitHub fetch and push repositories");
  }
  const remoteBinding = { fetchUrls, pushUrls };
  return {
    repository,
    fetchUrls,
    pushUrls,
    remoteBindingDigest: sha256(canonical(remoteBinding))
  };
}

function outputLimitExceeded(error) {
  return error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer|output exceeded/i.test(String(error?.message ?? ""));
}

function splitNulUtf8(value, label) {
  if (!Buffer.isBuffer(value)) throw new Error(`${label} must be returned as bytes`);
  const records = [];
  let offset = 0;
  while (offset < value.length) {
    const end = value.indexOf(0, offset);
    if (end < 0) throw new Error(`${label} is not NUL terminated`);
    const bytes = value.subarray(offset, end);
    if (bytes.length > 0) {
      const decoded = bytes.toString("utf8");
      if (!Buffer.from(decoded, "utf8").equals(bytes)) throw new Error(`${label} contains a non-UTF-8 path`);
      records.push(decoded);
    }
    offset = end + 1;
  }
  return records;
}

function isAllowedPath(relative, pathScope) {
  return pathScope.includes(".") || pathScope.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
}

function resolveContainedPath(cwd, relative) {
  if (typeof relative !== "string" || !relative || relative.startsWith("/") || relative.includes("\0") ||
      relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Autonomy diff contains an unsafe relative path");
  }
  const repository = path.resolve(cwd);
  const target = path.resolve(repository, relative);
  if (!target.startsWith(`${repository}${path.sep}`)) throw new Error("Autonomy diff path escapes the repository");
  return target;
}

export async function inspectAutonomyChanges(cwd, { limits, pathScope, runGit }) {
  const maxBuffer = limits.maxDiffBytes + 1;
  let trackedDiff;
  let pathResults;
  try {
    [trackedDiff, ...pathResults] = await Promise.all([
      runGit(["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"], { encoding: "buffer", maxBuffer }),
      runGit(["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer", maxBuffer }),
      runGit(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD"], { encoding: "buffer", maxBuffer })
    ]);
  } catch (error) {
    if (outputLimitExceeded(error)) return { ok: false, reason: "diff-byte-limit" };
    throw error;
  }
  const untracked = splitNulUtf8(pathResults[0].stdout, "Autonomy untracked path list");
  const trackedPaths = splitNulUtf8(pathResults[1].stdout, "Autonomy tracked path list");
  const changedPaths = [...new Set([...trackedPaths, ...untracked])].sort();
  if (changedPaths.length > limits.maxFiles) return { ok: false, reason: "diff-file-limit" };
  if (changedPaths.some((relative) => !isAllowedPath(relative, pathScope))) {
    return { ok: false, reason: "path-outside-autonomy-scope" };
  }
  let totalDiffBytes = trackedDiff.stdout.byteLength;
  const untrackedManifest = [];
  for (const relative of [...new Set(untracked)].sort()) {
    const target = resolveContainedPath(cwd, relative);
    const info = await lstat(target);
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw autonomyBoundaryError("git-diff-preflight-unavailable", `Autonomy untracked path has an unsupported file type: ${relative}`);
    }
    if (totalDiffBytes + info.size > limits.maxDiffBytes) return { ok: false, reason: "diff-byte-limit" };
    let bytes;
    if (info.isSymbolicLink()) {
      bytes = Buffer.from(await readlink(target), "utf8");
    } else {
      const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) throw new Error(`Autonomy untracked path changed type during capture: ${relative}`);
        if (totalDiffBytes + opened.size > limits.maxDiffBytes) return { ok: false, reason: "diff-byte-limit" };
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
    }
    totalDiffBytes += bytes.byteLength;
    if (totalDiffBytes > limits.maxDiffBytes) return { ok: false, reason: "diff-byte-limit" };
    untrackedManifest.push({
      path: relative,
      type: info.isSymbolicLink() ? "symlink" : "file",
      bytes: bytes.byteLength,
      digest: sha256(bytes)
    });
  }
  return {
    ok: true,
    changedFiles: changedPaths.length,
    changedPaths,
    trackedDiffBytes: trackedDiff.stdout.byteLength,
    trackedDiffDigest: sha256(trackedDiff.stdout),
    untrackedManifest,
    totalDiffBytes
  };
}

async function captureAutonomySnapshotPass(cwd, binding, sourceBindingDigest, runGit, sentinelDigest) {
  let branch;
  let remote;
  let head;
  let inspection;
  try {
    [branch, remote, head, inspection] = await Promise.all([
      currentAutonomyBranchFromGit(runGit),
      resolveGovernedGithubRepository(runGit),
      runGit(["rev-parse", "--verify", "HEAD^{commit}"]),
      inspectAutonomyChanges(cwd, { limits: binding.limits, pathScope: binding.pathScope, runGit })
    ]);
  } catch (error) {
    if (error.autonomyReason) throw error;
    throw autonomyBoundaryError("git-preflight-unavailable", `Autonomy snapshot capture failed: ${error.message}`, error);
  }
  if (!branch || !/^codex\/[A-Za-z0-9._/-]+$/.test(branch)) {
    throw autonomyBoundaryError("branch-outside-autonomy-scope", "Autonomy snapshot requires a named codex/* branch");
  }
  if (binding.branch !== null && binding.branch !== branch) {
    throw autonomyBoundaryError("branch-binding-drift", "Autonomy snapshot branch differs from the TaskContract binding");
  }
  if (binding.repository !== null && binding.repository !== remote.repository) {
    throw autonomyBoundaryError("repository-binding-drift", "Autonomy snapshot repository differs from the TaskContract binding");
  }
  if (!inspection.ok) throw autonomyBoundaryError(inspection.reason, `Autonomy snapshot rejected: ${inspection.reason}`);
  const value = {
    schemaVersion: 1,
    profileId: binding.id,
    profileDigest: binding.profileDigest,
    sourceBindingDigest,
    sentinelDigest,
    branch,
    repository: remote.repository,
    remoteBindingDigest: remote.remoteBindingDigest,
    pathScope: [...binding.pathScope],
    limits: {
      maxFiles: binding.limits.maxFiles,
      maxDiffBytes: binding.limits.maxDiffBytes,
      maxCommits: binding.limits.maxCommits
    },
    headRevision: head.stdout.trim(),
    changedFiles: inspection.changedFiles,
    changedPaths: inspection.changedPaths,
    trackedDiffBytes: inspection.trackedDiffBytes,
    trackedDiffDigest: inspection.trackedDiffDigest,
    untrackedManifest: inspection.untrackedManifest,
    totalDiffBytes: inspection.totalDiffBytes
  };
  return value;
}

export async function captureBoundedAutonomySnapshot(cwd, binding, sourceBindingDigest, runGit, {
  sentinelDigest = null,
  beforeFinalCheck = null,
  afterFinalCheck = null
} = {}) {
  validateAutonomyBinding(binding);
  if (!SHA256.test(sourceBindingDigest ?? "")) throw new Error("Autonomy snapshot requires an immutable source binding digest");
  if (sentinelDigest !== null && !SHA256.test(sentinelDigest)) {
    throw new Error("Autonomy snapshot sentinel digest is invalid");
  }
  const first = await captureAutonomySnapshotPass(cwd, binding, sourceBindingDigest, runGit, sentinelDigest);
  if (beforeFinalCheck) await beforeFinalCheck(first);
  const second = await captureAutonomySnapshotPass(cwd, binding, sourceBindingDigest, runGit, sentinelDigest);
  if (afterFinalCheck) await afterFinalCheck(second);
  if (canonical(first) !== canonical(second)) {
    throw autonomyBoundaryError("autonomy-snapshot-drift", "Autonomy repository state changed during bounded snapshot capture");
  }
  return { ...second, digest: sha256(canonical(second)) };
}
