import { stat } from "node:fs/promises";
import path from "node:path";
import { execBoundGitHubCli, execBoundProcess } from "./core.mjs";
import { runSourceGit } from "./git.mjs";

const CONTROLLED_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export function canonicalGithubRepository(remote) {
  const raw = String(remote ?? "").trim().replace(/\.git$/, "");
  const ssh = raw.match(/^([^@]+)@([^:]+):(.+)$/);
  if (ssh) return ssh[2].toLowerCase() === "github.com" ? `github.com/${ssh[3]}` : null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
        (parsed.port && parsed.port !== "443") || parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.length === 2 ? `github.com/${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}

async function rawLocalValues(cwd, key) {
  const result = await runSourceGit(cwd, ["config", "--local", "--no-includes", "--get-all", key], {
    allowFailure: true,
    maxBuffer: DEFAULT_MAX_BUFFER
  });
  if (!result.ok) return [];
  const values = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (values.some((value) => /[\0\r\n]/.test(value))) {
    throw new Error(`Autonomy repository binding contains an invalid ${key} value`);
  }
  return values;
}

export async function resolveAutonomyRepository(cwd) {
  const fetchUrls = await rawLocalValues(cwd, "remote.origin.url");
  const pushUrls = await rawLocalValues(cwd, "remote.origin.pushurl");
  if (fetchUrls.length !== 1 || pushUrls.length > 1) {
    throw new Error("bounded-autopilot-v1 requires one raw local origin and at most one raw push URL");
  }
  const repository = canonicalGithubRepository(fetchUrls[0]);
  const pushRepository = pushUrls.length === 0 ? repository : canonicalGithubRepository(pushUrls[0]);
  if (!repository || pushRepository !== repository) {
    throw new Error("bounded-autopilot-v1 requires matching canonical GitHub fetch and push repositories");
  }
  return repository;
}

export async function currentAutonomyBranch(cwd, options = {}) {
  const result = await runSourceGit(cwd, ["branch", "--show-current"], {
    maxBuffer: DEFAULT_MAX_BUFFER,
    ...options
  });
  return result.stdout.trim() || null;
}

export async function captureAutonomyBindingContext(cwd, pathScope) {
  const branch = await currentAutonomyBranch(cwd);
  if (!branch) throw new Error("bounded-autopilot-v1 requires a named codex/* branch");
  const repository = await resolveAutonomyRepository(cwd);
  return { repository, branch, pathScope };
}

function outputLimitExceeded(error) {
  return error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer|output exceeded/i.test(String(error?.message ?? ""));
}

export async function inspectAutonomyWorktree(cwd, { limits, pathScope }) {
  const maxBuffer = limits.maxDiffBytes + 1;
  let statusOutput;
  try {
    statusOutput = (await runSourceGit(cwd, ["status", "--short", "--untracked-files=all"], {
      maxBuffer
    })).stdout.trim();
  } catch (error) {
    if (outputLimitExceeded(error)) return { ok: false, reason: "diff-byte-limit" };
    throw error;
  }
  const changedFiles = statusOutput ? statusOutput.split("\n").filter(Boolean).length : 0;
  if (changedFiles > limits.maxFiles) return { ok: false, reason: "diff-file-limit" };
  let trackedDiff;
  try {
    trackedDiff = await runSourceGit(cwd, ["diff", "--binary", "HEAD"], {
      encoding: "buffer",
      maxBuffer
    });
  } catch (error) {
    if (outputLimitExceeded(error)) return { ok: false, reason: "diff-byte-limit" };
    throw error;
  }
  const pathResults = await Promise.all([
    runSourceGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer", maxBuffer }),
    runSourceGit(cwd, ["diff", "--name-only", "-z", "HEAD"], { encoding: "buffer", maxBuffer })
  ]).catch((error) => {
    if (outputLimitExceeded(error)) return null;
    throw error;
  });
  if (!pathResults) return { ok: false, reason: "diff-byte-limit" };
  const [untrackedResult, trackedPathsResult] = pathResults;
  const untracked = untrackedResult.stdout.toString("utf8").split("\0").filter(Boolean);
  const trackedPaths = trackedPathsResult.stdout.toString("utf8").split("\0").filter(Boolean);
  const changedPaths = [...new Set([...trackedPaths, ...untracked])];
  const pathAllowed = (relative) => pathScope.includes(".") || pathScope.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
  if (changedPaths.some((relative) => !pathAllowed(relative))) return { ok: false, reason: "path-outside-autonomy-scope" };
  let untrackedBytes = 0;
  for (const relative of untracked) {
    const file = path.resolve(cwd, relative);
    const info = await stat(file);
    if (info.isFile()) untrackedBytes += info.size;
    if (trackedDiff.stdout.byteLength + untrackedBytes > limits.maxDiffBytes) {
      return { ok: false, reason: "diff-byte-limit" };
    }
  }
  return { ok: true, changedFiles, changedPaths };
}

export async function readBoundHostStatus(hostTrustTool, cwd, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const result = await execBoundProcess(process.execPath, [hostTrustTool, "status"], {
    cwd,
    env: { PATH: CONTROLLED_PATH, HOME: "/var/empty", LANG: "C", LC_ALL: "C" },
    timeoutMs,
    maxBuffer: DEFAULT_MAX_BUFFER,
    encoding: "utf8",
    label: "Bound host status"
  });
  return JSON.parse(result.stdout);
}

export async function probeAutonomyGithubCredential(cwd, executablePath, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return execBoundGitHubCli(executablePath, ["auth", "status", "--hostname", "github.com"], {
    cwd,
    env: {},
    timeoutMs,
    maxBuffer: DEFAULT_MAX_BUFFER,
    encoding: "utf8"
  });
}

export async function runAutonomyGitCommandForTest(cwd, args, options = {}) {
  return runSourceGit(cwd, args, options);
}
