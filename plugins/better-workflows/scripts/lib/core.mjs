import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAutonomyAction,
  autonomyProfileDigest,
  buildAutonomyDecisionReceipt,
  decideAutonomyAction,
  loadAutonomyProfile,
  validateAutonomyBinding
} from "./autonomy.mjs";
import {
  canonicalGovernedGithubRepository,
  captureBoundedAutonomySnapshot,
  isExactGitAbsence,
  parseNulNameStatusPaths,
  readRawLocalConfigValues
} from "./autonomy-snapshot.mjs";
import { REVIEW_POLICIES, quorumReviewEnabled, reviewKernelEnabled, validateReviewProfile } from "./review-policy.mjs";

const BOUND_GIT_EXECUTABLE = "/usr/bin/git";
const BOUND_GIT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const BOUND_GITHUB_CLI_TIMEOUT_MS = 30_000;
const BOUND_GITHUB_CLI_MAX_BUFFER = 1024 * 1024;
const BOUND_GIT_TIMEOUT_MS = 30_000;
const BOUND_GIT_MAX_BUFFER = 4 * 1024 * 1024;
// The in-process supervisor force-kills its dedicated group after 100 ms. A
// short parent grace keeps the cleanup proof bounded without adding a full
// second of idle latency to every successful Git/provider call.
const BOUND_PROCESS_GROUP_CLEANUP_GRACE_MS = 250;
const BOUND_TIMEOUT_PROCESS_GROUP_CLEANUP_GRACE_MS = 1_000;
const BOUND_CREDENTIAL_ROOT = process.platform === "darwin" ? "/private/tmp" : "/tmp";
export const BOUND_CREDENTIAL_WORKSPACE_ROOT = BOUND_CREDENTIAL_ROOT;
const DEV_DELIVERY_TEMPLATES = new Set(["pr-to-dev", "pr-to-dev-agent-quorum"]);
function isDevDeliveryTemplate(template) {
  return DEV_DELIVERY_TEMPLATES.has(template);
}

// Keep a verified process-group leader alive until every bounded provider
// descendant has been terminated.  The supervisor reports the target's exit
// status through fd 3, then waits for the parent teardown signal.  The final
// SIGKILL is issued from inside the still-live group, so the parent never
// signals a recycled numeric PGID after the direct target has exited.
const BOUND_PROCESS_SUPERVISOR_SOURCE = [
  "const fs = require('node:fs');",
  "const { spawn } = require('node:child_process');",
  "const target = process.argv[1];",
  "const targetArgs = JSON.parse(process.argv[2]);",
  "const cwd = process.argv[3];",
  "let forceScheduled = false;",
  "let reported = false;",
  "const parentPid = process.ppid;",
  "const forceKill = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} };",
  "const scheduleForceKill = () => { if (forceScheduled) return; forceScheduled = true; setTimeout(forceKill, 100); };",
  "for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) process.on(signal, scheduleForceKill);",
  "const watchdog = setInterval(() => { if (process.ppid !== parentPid) { forceKill(); } }, 25);",
  "watchdog.unref();",
  "const report = (code, signal) => { if (reported) return; reported = true; try { fs.writeSync(3, JSON.stringify({ schemaVersion: 1, code: code ?? null, signal: signal ?? null }) + '\\n'); } catch {} };",
  "let child;",
  "try { child = spawn(target, targetArgs, { cwd, env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ignore'] }); } catch { report(126, null); }",
  "child?.once('error', () => report(126, null));",
  "child?.once('close', (code, signal) => report(code, signal));",
  "setInterval(() => {}, 1000);"
].join(" ");

function boundGitAuthorityEnvironment() {
  return {
    PATH: BOUND_GIT_PATH,
    HOME: "/var/empty",
    LANG: "C",
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null"
  };
}

function boundProcessGroupIsAlive(pid, killFn = process.kill) {
  if (!pid) return false;
  // The supervisor is the stable group leader.  If it is gone, a successful
  // signal-zero check on `-pid` could refer to an unrelated recycled group;
  // fail closed instead of signalling that numeric identity.
  try {
    killFn(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  try {
    killFn(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitForBoundProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (boundProcessGroupIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !boundProcessGroupIsAlive(pid);
}

function terminateBoundChild(child, killFn = process.kill) {
  if (!child?.pid || !boundProcessGroupIsAlive(child.pid, killFn)) return false;
  const signalTarget = process.platform === "win32" ? child.pid : -child.pid;
  try {
    killFn(signalTarget, "SIGTERM");
    return true;
  } catch {
    if (process.platform !== "win32") return false;
    try { child.kill("SIGTERM"); return true; } catch { return false; }
  }
}

function killBoundChild(child, killFn = process.kill) {
  if (!child?.pid || !boundProcessGroupIsAlive(child.pid, killFn)) return false;
  const signalTarget = process.platform === "win32" ? child.pid : -child.pid;
  try {
    killFn(signalTarget, "SIGKILL");
    return true;
  } catch {
    if (process.platform !== "win32") return false;
    try { child.kill("SIGKILL"); return true; } catch { return false; }
  }
}

// Test-only seam: cleanup must fail closed when the stable supervisor leader
// is no longer provable, rather than signalling a recycled numeric PGID.
export function terminateBoundChildForTest(pid, signal, killFn) {
  return terminateBoundChild({ pid, kill: () => undefined }, killFn);
}

function execBoundChildProcess(executablePath, args, {
  cwd,
  env,
  timeoutMs,
  maxBuffer,
  encoding = "utf8",
  label = "Bound process"
} = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return Promise.reject(new Error(`${label} requires an explicit controlled environment`));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BOUND_GIT_TIMEOUT_MS) {
    return Promise.reject(new Error(`${label} timeout is outside the fixed bounded policy`));
  }
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > BOUND_GIT_MAX_BUFFER) {
    return Promise.reject(new Error(`${label} output limit is outside the fixed bounded policy`));
  }
  return new Promise((resolve, reject) => {
    const supervised = process.platform !== "win32";
    const supervisorCwd = cwd ?? process.cwd();
    const child = spawn(
      supervised ? process.execPath : executablePath,
      supervised
        ? ["-e", BOUND_PROCESS_SUPERVISOR_SOURCE, executablePath, JSON.stringify(args), supervisorCwd]
        : args,
      {
      cwd: supervisorCwd,
      env,
      detached: true,
      stdio: supervised ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      windowsHide: true
      }
    );
    const stdout = [];
    const stderr = [];
    const supervisor = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    let cleanupPromise = null;
    let supervisorResult = null;
    let supervisorProtocolError = null;
    let supervisorBuffer = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const cleanupProcessGroup = () => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        // Preserve the historical timeout grace: callers may use the fixed
        // deadline as a cancellation signal while the target is still
        // flushing bounded diagnostics (including a child PID receipt).
        const graceMs = timedOut ? BOUND_TIMEOUT_PROCESS_GROUP_CLEANUP_GRACE_MS : BOUND_PROCESS_GROUP_CLEANUP_GRACE_MS;
        // Check before every signal.  Once the original group is gone, the
        // numeric pid may be reused by an unrelated process group; signaling
        // that id would cross the credential boundary.
        if (!boundProcessGroupIsAlive(child.pid)) return true;
        terminateBoundChild(child);
        if (await waitForBoundProcessGroupExit(child.pid, graceMs)) return true;
        if (!boundProcessGroupIsAlive(child.pid)) return true;
        killBoundChild(child);
        return waitForBoundProcessGroupExit(child.pid, graceMs);
      })();
      return cleanupPromise;
    };
    const terminate = () => {
      void cleanupProcessGroup();
    };
    const collect = (target, chunk) => {
      const bytes = Buffer.byteLength(chunk);
      outputBytes += bytes;
      if (outputBytes > maxBuffer) {
        outputExceeded = true;
        terminate();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.stdio[3]?.on("data", (chunk) => {
      supervisor.push(chunk);
      supervisorBuffer += chunk.toString("utf8");
      let newline;
      while ((newline = supervisorBuffer.indexOf("\n")) >= 0) {
        const line = supervisorBuffer.slice(0, newline);
        supervisorBuffer = supervisorBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
              Object.keys(parsed).sort().join("\0") !== "code\0schemaVersion\0signal" ||
              parsed.schemaVersion !== 1 ||
              (!Number.isInteger(parsed.code) && parsed.code !== null) ||
              (parsed.signal !== null && typeof parsed.signal !== "string")) {
            throw new Error("invalid supervisor result");
          }
          supervisorResult = parsed;
          void cleanupProcessGroup();
        } catch (error) {
          supervisorProtocolError = new Error(`${label} supervisor result was invalid: ${error.message}`);
          void cleanupProcessGroup();
        }
      }
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    deadline.unref?.();
    child.once("error", (error) => {
      clearTimeout(deadline);
      finish(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      void (async () => {
        const groupTerminated = await cleanupProcessGroup();
        if (supervised) {
          try {
            const supervisorBytes = Buffer.concat(supervisor);
            if (supervisorProtocolError) throw supervisorProtocolError;
            if (!supervisorResult && supervisorBytes.length === 0 && (timedOut || outputExceeded)) {
              supervisorResult = null;
            } else if (!supervisorResult) {
              supervisorResult = JSON.parse(supervisorBytes.toString("utf8"));
            }
            if (supervisorResult !== null && (supervisorResult.schemaVersion !== 1 ||
                (!Number.isInteger(supervisorResult.code) && supervisorResult.code !== null) ||
                (supervisorResult.signal !== null && typeof supervisorResult.signal !== "string"))) {
              throw new Error("Bound process supervisor returned an invalid result");
            }
          } catch (error) {
            const failure = new Error(`${label} supervisor result was unavailable: ${error.message}`);
            failure.code = "EPROCESSGROUP";
            finish(failure);
            return;
          }
        }
        const output = {
          // Keep Git object output byte-for-byte when the caller explicitly
          // requests binary mode.  The default text path remains unchanged.
          stdout: encoding === null || encoding === "buffer" ? Buffer.concat(stdout) : Buffer.concat(stdout).toString(encoding),
          stderr: encoding === null || encoding === "buffer" ? Buffer.concat(stderr) : Buffer.concat(stderr).toString(encoding),
          code: supervisorResult?.code ?? code,
          signal: supervisorResult ? supervisorResult.signal : signal,
          groupTerminated
        };
        if (!groupTerminated) {
          const error = new Error(`${label} child process group did not terminate within the cleanup deadline`);
          error.code = "EPROCESSGROUP";
          error.stdout = output.stdout;
          error.stderr = output.stderr;
          finish(error);
          return;
        }
        if (timedOut) {
          const error = new Error(`${label} timed out after ${timeoutMs}ms`);
          error.code = "ETIMEDOUT";
          error.stdout = output.stdout;
          error.stderr = output.stderr;
          finish(error);
          return;
        }
        if (outputExceeded) {
          const error = new Error(`${label} output exceeded ${maxBuffer} bytes`);
          error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          error.stdout = output.stdout;
          error.stderr = output.stderr;
          finish(error);
          return;
        }
        if (output.code !== 0 || output.signal !== null) {
          const error = new Error(`${label} failed${output.signal ? ` with ${output.signal}` : ` with exit ${output.code}`}`);
          error.code = output.code ?? output.signal ?? "EUNKNOWN";
          error.signal = output.signal;
          error.stdout = output.stdout;
          error.stderr = output.stderr;
          finish(error);
          return;
        }
        finish(null, output);
      })().catch((error) => finish(error));
    });
  });
}

export function execBoundGitHubCli(executablePath, args, {
  cwd,
  env,
  timeoutMs = BOUND_GITHUB_CLI_TIMEOUT_MS,
  maxBuffer = BOUND_GITHUB_CLI_MAX_BUFFER,
  encoding = "utf8"
} = {}) {
  const boundedEnvironment = normalizeBoundGitHubEnvironment(env);
  return execBoundChildProcess(executablePath, args, {
    cwd,
    env: boundedEnvironment,
    timeoutMs,
    maxBuffer,
    encoding,
    label: "Bound GitHub CLI"
  });
}

export function execBoundProcess(executablePath, args, {
  cwd,
  env,
  timeoutMs = BOUND_GIT_TIMEOUT_MS,
  maxBuffer = BOUND_GIT_MAX_BUFFER,
  encoding = "utf8",
  label = "Bound process"
} = {}) {
  return execBoundChildProcess(executablePath, args, {
    cwd,
    env,
    timeoutMs,
    maxBuffer,
    encoding,
    label
  });
}

export function execBoundGit(executablePath, args, {
  cwd,
  env,
  timeoutMs = BOUND_GIT_TIMEOUT_MS,
  maxBuffer = BOUND_GIT_MAX_BUFFER,
  encoding = "utf8"
} = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return Promise.reject(new Error("Bound Git requires an explicit isolated environment"));
  }
  return execBoundChildProcess(executablePath, args, {
    cwd,
    env,
    timeoutMs,
    maxBuffer,
    encoding,
    label: "Bound Git"
  });
}

// Compatibility name used by the bounded-process regression suite.
export const execBoundGitProcess = execBoundGit;

async function assertTrustedCredentialRoot() {
  const expected = path.resolve(BOUND_CREDENTIAL_ROOT);
  if (expected !== BOUND_CREDENTIAL_ROOT) throw new Error("Bound credential root must be canonical");
  const resolved = await realpath(BOUND_CREDENTIAL_ROOT);
  if (resolved !== BOUND_CREDENTIAL_ROOT) throw new Error("Bound credential root must not be a symlink");
  const info = await lstat(BOUND_CREDENTIAL_ROOT);
  const mode = info.mode & 0o7777;
  const stickyWorldWritable = (mode & 0o002) !== 0 && (mode & 0o1000) !== 0;
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || ((mode & 0o002) !== 0 && !stickyWorldWritable)) {
    throw new Error("Bound credential root is not a trusted root-owned temporary directory");
  }
}

export async function assertBoundCredentialWorkspace(directory, credentialFile = null) {
  await assertTrustedCredentialRoot();
  if (typeof directory !== "string" || path.resolve(directory) !== directory || path.dirname(directory) !== BOUND_CREDENTIAL_ROOT) {
    throw new Error("Bound credential workspace path is not directly under the trusted temporary root");
  }
  const directoryInfo = await lstat(directory);
  if (await realpath(directory) !== directory || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
      directoryInfo.uid !== (process.getuid?.() ?? directoryInfo.uid) || (directoryInfo.mode & 0o077) !== 0) {
    throw new Error("Bound credential workspace is unsafe");
  }
  if (credentialFile !== null) {
    if (typeof credentialFile !== "string" || path.resolve(credentialFile) !== credentialFile || path.dirname(credentialFile) !== directory) {
      throw new Error("Bound credential file path is not inside the trusted workspace");
    }
    const credentialInfo = await lstat(credentialFile);
    if (await realpath(credentialFile) !== credentialFile || !credentialInfo.isFile() || credentialInfo.isSymbolicLink() ||
        credentialInfo.nlink !== 1 || credentialInfo.uid !== (process.getuid?.() ?? credentialInfo.uid) ||
        (credentialInfo.mode & 0o077) !== 0) {
      throw new Error("Bound credential file is unsafe");
    }
  }
}

async function execBoundGitAuthority(cwd, args, {
  allowFailure = false,
  timeoutMs = BOUND_GIT_TIMEOUT_MS,
  maxBuffer = BOUND_GIT_MAX_BUFFER,
  encoding = "utf8"
} = {}) {
  try {
    const canonicalWorktree = await realpath(path.resolve(cwd));
    const result = await execBoundGit(BOUND_GIT_EXECUTABLE, [
      "--no-replace-objects",
      `--work-tree=${canonicalWorktree}`,
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null",
      "-c", "credential.helper=",
      ...args
    ], {
      cwd,
      env: boundGitAuthorityEnvironment(),
      timeoutMs: Math.min(timeoutMs, BOUND_GIT_TIMEOUT_MS),
      maxBuffer: Math.min(maxBuffer, BOUND_GIT_MAX_BUFFER),
      encoding
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const message = String(error?.message ?? "").trim();
    const rawStderr = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString("utf8").trim()
      : String(error?.stderr ?? "").trim();
    const detail = !message
      ? rawStderr || "unknown failure"
      : !rawStderr || message.includes(rawStderr)
        ? message
        : `${message}: ${rawStderr}`;
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
    const failure = new Error(`Bound Git authority command failed: ${detail}`);
    failure.code = error.code;
    failure.signal = error.signal;
    failure.stdout = error.stdout;
    failure.stderr = error.stderr;
    throw failure;
  }
}

export function optionalBoundGitAuthorityOutput(result, label, { absentCodes = [1] } = {}) {
  if (result?.ok === true) return result.stdout;
  if (isExactGitAbsence(result, { absentCodes })) return null;
  const detail = result?.outputExceeded
    ? "output limit exceeded"
    : result?.timedOut
      ? "timeout"
      : result?.signal
        ? `signal ${result.signal}`
        : String(result?.stderr || result?.code || "unknown failure").trim();
  throw new Error(`${label} failed: ${detail}`);
}

export async function resolveOptionalBoundBranchRevision(runGit, ref, label = "Git branch ref lookup") {
  const presence = await runGit(["show-ref", "--verify", "--quiet", ref], { allowFailure: true });
  const presenceOutput = optionalBoundGitAuthorityOutput(presence, label);
  if (presenceOutput === null) return null;
  if (presenceOutput !== "") throw new Error(`${label} returned malformed success output`);
  const resolved = await runGit(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (resolved?.ok !== true || typeof resolved.stdout !== "string" || !/^[a-f0-9]{40}\n$/i.test(resolved.stdout)) {
    throw new Error(`${label} returned a malformed commit revision`);
  }
  return resolved.stdout.slice(0, -1);
}

async function rawLocalGitValues(cwd, key) {
  return readRawLocalConfigValues(
    (args, options) => execBoundGitAuthority(cwd, args, options),
    key,
    { maxBuffer: BOUND_GIT_MAX_BUFFER, label: "Git authority" }
  );
}

async function currentOriginRemoteBinding(cwd) {
  const fetchUrls = await rawLocalGitValues(cwd, "remote.origin.url");
  const pushUrls = await rawLocalGitValues(cwd, "remote.origin.pushurl");
  return {
    fetchUrls,
    pushUrls,
    digest: fetchUrls.length > 0 || pushUrls.length > 0
      ? sha256(canonicalJson({ fetchUrls, pushUrls }))
      : null
  };
}

export async function captureAutonomyReadinessSnapshot(cwd, binding, sourceBindingDigest, options = {}) {
  const { assertSourceGitAncestryAuthority } = await import("./git.mjs");
  const before = await assertSourceGitAncestryAuthority(cwd);
  const snapshot = await captureBoundedAutonomySnapshot(
    cwd,
    binding,
    sourceBindingDigest,
    (args, gitOptions) => execBoundGitAuthority(cwd, args, gitOptions),
    options
  );
  const after = await assertSourceGitAncestryAuthority(cwd);
  if (digestObject(before) !== digestObject(after)) {
    throw new Error("Bounded autonomy Git ancestry authority changed during snapshot capture");
  }
  return snapshot;
}

function assertNoAmbientGitAuthorityOverrides() {
  const dangerous = Object.keys(process.env).filter((key) => (
    key === "GIT_CONFIG_COUNT" || key === "GIT_CONFIG_PARAMETERS" ||
    key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_") ||
    [
      "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
      "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
      "GIT_REPLACE_REF_BASE", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE"
    ].includes(key)
  )).sort();
  if (dangerous.length > 0) {
    throw new Error(`Git authority rejects ambient routing or configuration overrides: ${dangerous.join(",")}`);
  }
}

export const VERSION = "3.4.14";
export const MODES = new Set(["auto", "direct", "verified", "deep", "critical"]);
export const RUN_STATES = new Set([
  "pending",
  "running",
  "blocked",
  "completed",
  "failed_retryable",
  "failed_terminal",
  "stale",
  "no_op",
  "cancelled_superseded",
  "cancelled_evidence_sufficient",
  "blocked_external_reviewer",
  "inconclusive",
  "indeterminate"
]);
export const FINDING_STATES = new Set([
  "open",
  "resolved",
  "accepted-risk",
  "rejected-with-evidence"
]);
const TERMINAL_RUN_STATES = new Set([
  "completed",
  "failed_terminal",
  "no_op",
  "cancelled_superseded",
  "cancelled_evidence_sufficient"
]);

const RUN_ID = /^sbw-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[a-f0-9]{40}$/i;
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULTS_PATH = path.join(PLUGIN_ROOT, "config", "defaults.json");
const DESTRUCTIVE_CLEANUP_ACTIONS = new Set([
  "actions.cancel",
  "pr.close",
  "branch.delete",
  "worktree.cleanup"
]);
// GitHub's workflow-dispatch API accepts a mutable branch/tag ref and does not
// bind the provider invocation atomically to the revision resolved during
// preflight. Keep this side-effecting adapter fail-closed until an immutable
// provider binding exists; post-dispatch head observation cannot undo a run
// started from an unauthorized workflow revision.
const UNSUPPORTED_GOVERNED_ACTIONS = new Set(["actions.dispatch"]);
const DEFERRED_ACTION_CANONICAL = new Map([
  ["actions.dispatch", "workflow.dispatch"],
  ["workflow.dispatch", "workflow.dispatch"],
  ["deploy", "deploy"],
  ["release", "release"],
  ["branch.promote", "branch.promote"]
]);
const OWNED_RESOURCE_CREATION_ACTIONS = new Set([
  "branch.create",
  "worktree.create",
  "pr.create"
]);
const OWNED_RESOURCE_CREATION_SCHEMAS = {
  "branch.create": {
    providers: new Set(["git"]),
    pattern: /^branch:[A-Za-z0-9._/-]+$/,
    prove: (receipt, resource) => (
      receipt.ref === resource.slice("branch:".length) &&
      typeof receipt.revision === "string" &&
      /^[a-f0-9]{7,64}$/i.test(receipt.revision)
    )
  },
  "worktree.create": {
    providers: new Set(["git"]),
    pattern: /^worktree:.+$/,
    prove: (receipt, resource) => (
      receipt.path === resource.slice("worktree:".length) &&
      typeof receipt.revision === "string" &&
      /^[a-f0-9]{7,64}$/i.test(receipt.revision)
    )
  },
  "pr.create": {
    providers: new Set(["github-cli"]),
    pattern: /^pull\/(?:new|\d+)$/,
    prove: (receipt, resource) => (
      Number.isInteger(receipt.number) &&
      (resource === "pull/new" || receipt.number === Number(resource.slice("pull/".length))) &&
      typeof receipt.head === "string" && receipt.head.length > 0 &&
      typeof receipt.base === "string" && receipt.base.length > 0 &&
      typeof receipt.url === "string" && receipt.url.length > 0
    )
  }
};

function ownedResourceCleared(entry, actions) {
  return actions.some((action) => {
    const providerReceipt = action.receipt?.providerReceipt;
    if (
      action.resource === entry.resource &&
      DESTRUCTIVE_CLEANUP_ACTIONS.has(action.action) &&
      action.status === "spent" &&
      action.outcome === "success" &&
      providerReceipt?.resource === entry.resource
    ) return true;
    const pullRequest = /^pull\/(\d+)$/.exec(entry.resource ?? "");
    return Boolean(
      pullRequest &&
      action.action === "pr.merge" &&
      action.resource === entry.resource &&
      action.status === "spent" &&
      action.outcome === "success" &&
      providerReceipt?.pr === Number(pullRequest[1]) &&
      providerReceipt?.state === "MERGED"
    );
  });
}

function ownedResourceCreationActionDigest(action) {
  return digestObject({
    attemptId: action.attemptId,
    action: action.action,
    resource: action.resource,
    outcome: action.outcome,
    receipt: action.receipt
  });
}
const OWNED_RESOURCE = /^[^\0\r\n]{1,512}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const WORKFLOW_FILE = /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?:yml|yaml)$/;
const WORKFLOW_REF = /^[A-Za-z0-9._\/-]{1,128}$/;
const WORKFLOW_REF_IDENTITY = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/;
const WORKFLOW_INPUT_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const WORKFLOW_INPUT_VALUE = /^[^\0\r\n]{0,4096}$/;
const WORKFLOW_INPUT_SENSITIVE_KEY = /(?:^|[_-])(?:token|secret|password|passwd|credential|private[_-]?key|api[_-]?key|access[_-]?key|client[_-]?secret|authorization|bearer|cookie|session)(?:$|[_-])/i;
export const CREDENTIAL_SHAPED_VALUE_PATTERN = /(?:-----BEGIN [^-]+ PRIVATE KEY-----|(?:^|\b)(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AKIA|ASIA|AIDA|AROA|sk_(?:live|test)_|rk_(?:live|test)_|sq0atp-|ya29\.|AIza[A-Za-z0-9_-]{20,}|dop_v1_|lin_api_|npm_|pypi-AgEI|(?:cap|token)[_-])[A-Za-z0-9._~+\/-]{8,}|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{20,}|(?:^|[\s,;])(?:token|secret|password|passwd|api[_-]?key|access[_-]?key)\s*[:=]\s*\S+|^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$|^[A-Za-z0-9+/=_-]{32,}$|^(?=[^\s]{32,}$)(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9])[^\s]+$)/i;
const WORKFLOW_INPUT_SECRET_VALUE = CREDENTIAL_SHAPED_VALUE_PATTERN;
export const CREDENTIAL_SHAPED_LITERAL_PATTERN = /(?:-----BEGIN [^-]+ PRIVATE KEY-----|(?<![A-Za-z0-9_-])(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AKIA|ASIA|AIDA|AROA|sk_(?:live|test)_|rk_(?:live|test)_|sq0atp-|ya29\.|AIza[A-Za-z0-9_-]{20,}|dop_v1_|lin_api_|npm_|pypi-AgEI|(?:cap|token)[_-])[A-Za-z0-9._~+\/-]{8,}(?![A-Za-z0-9._~+\/-])|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{20,})/i;

export function isCredentialShapedValue(value) {
  return typeof value === "string" && CREDENTIAL_SHAPED_VALUE_PATTERN.test(value);
}

export function hasCredentialShapedMaterial(value) {
  return typeof value === "string" && CREDENTIAL_SHAPED_LITERAL_PATTERN.test(value);
}
const WORKFLOW_INPUT_PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const WORKFLOW_DISPATCH_NONCE_INPUT = "sbw_dispatch_nonce";
const WORKFLOW_DISPATCH_EXPECTED_REVISION_INPUT = "sbw_expected_revision";
const WORKFLOW_DISPATCH_NONCE = /^[a-f0-9]{32}$/;
const WORKFLOW_DISPATCH_NONCE_EXPRESSION = /\$\{\{\s*(?:inputs|github\.event\.inputs)\.sbw_dispatch_nonce\s*\}\}/;

function workflowInputKeyIsSensitive(key) {
  const separatedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return WORKFLOW_INPUT_SENSITIVE_KEY.test(key) || WORKFLOW_INPUT_SENSITIVE_KEY.test(separatedKey);
}

function workflowConclusionIsSuccess(value) {
  return typeof value === "string" && value.toLowerCase() === "success";
}

function workflowConclusionIsNonSuccess(value) {
  return typeof value === "string" && value.length > 0 && !workflowConclusionIsSuccess(value);
}

function workflowDispatchConclusionMatchesOutcome(status, conclusion, outcome) {
  if (outcome === "success") {
    return status === "completed" && workflowConclusionIsSuccess(conclusion);
  }
  if (outcome === "failure") {
    return status === "completed" && workflowConclusionIsNonSuccess(conclusion);
  }
  return false;
}
const GIT_PUSH_RESOURCE = /^remote:([A-Za-z0-9._-]+):(refs\/heads\/[A-Za-z0-9._/-]+)$/;
const EXECUTABLE_ACTION_PROVIDERS = new Set([
  "git.push:git",
  "pr.create:github-cli",
  "pr.merge:github-cli"
]);

export function isExecutableActionProvider(action, provider) {
  return EXECUTABLE_ACTION_PROVIDERS.has(`${action}:${provider}`);
}

const ACTION_PROVIDER_RECEIPT_SCHEMAS = {
  "branch.create:git": { proofKind: "git-branch-create" },
  "worktree.create:git": { proofKind: "git-worktree-create" },
  "git.commit:git": { proofKind: "git-commit" },
  "git.push:git": { proofKind: "git-push" },
  "branch.delete:git": { proofKind: "git-branch-delete" },
  "pr.create:github-cli": { proofKind: "github-pr-create" },
  "issue.create:github-cli": { proofKind: "github-issue-create" },
  "pr.close:github-cli": { proofKind: "github-pr-close" },
  "actions.cancel:github-cli": { proofKind: "github-actions-cancel" },
  "actions.dispatch:github-cli": { proofKind: "github-actions-dispatch" },
  "pr.merge:github-cli": { proofKind: "github-pr-merge" },
  "remote.sync:git": { proofKind: "git-remote-sync" },
  "worktree.cleanup:git": { proofKind: "git-worktree-cleanup" },
  "recipe.promote:local-workspace": { proofKind: "local-workspace:recipe.promote" },
  "artifact.promote:local-workspace": { proofKind: "local-workspace:artifact.promote" },
  "plugin.cache.publish:local-workspace": { proofKind: "local-workspace:plugin.cache.publish" }
};
const PROVIDER_EXECUTION_SCHEMA_VERSION = 1;

function assertSupportedGovernedAction(action) {
  if (UNSUPPORTED_GOVERNED_ACTIONS.has(action)) {
    throw new Error(`Governed action requires an unimplemented provider adapter: ${action}`);
  }
}

function canonicalDeferredAction(action) {
  return DEFERRED_ACTION_CANONICAL.get(action) ?? action;
}

function isDeferredGovernedAction(contract, action) {
  const deferredActions = Array.isArray(contract?.deferredActions) ? contract.deferredActions : [];
  const canonical = canonicalDeferredAction(action);
  return deferredActions.some((item) => canonicalDeferredAction(item) === canonical);
}

export function assertActionIsNotDeferred(contract, action) {
  if (isDeferredGovernedAction(contract, action)) {
    throw new Error(`Governed action is deferred until its provider adapter is implemented: ${action}`);
  }
}
export function pluginRoot() {
  return PLUGIN_ROOT;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(value) {
  const hash = createHash("sha256");
  hash.update(Buffer.isBuffer(value) ? value : String(value));
  return hash.digest("hex");
}

export function buildGitPushActionBinding({
  remote,
  pushUrl,
  remoteRepository,
  sourceBindingDigest,
  sourceRemoteBindingDigest,
  expectedBranch,
  expectedRevision,
  providerExecutable
}) {
  const ref = `refs/heads/${expectedBranch}`;
  return {
    remote,
    pushUrl,
    remoteRepository,
    pushUrlDigest: sha256(pushUrl),
    sourceBindingDigest,
    sourceRemoteBindingDigest,
    expectedBranch,
    expectedRevision,
    providerExecutable,
    pushCommand: ["git", "push", "--porcelain", pushUrl, `${expectedRevision}:${ref}`]
  };
}

export function buildPrMergeActionBinding({
  prior = {},
  pullRequest,
  reviewedHead,
  remoteRevision,
  targetRef = null,
  providerExecutable,
  repository
}) {
  return {
    ...prior,
    pullRequest,
    reviewedHead,
    remoteRevision,
    ...(targetRef ? { targetRef } : {}),
    mergeMethod: "merge",
    adminBypass: false,
    providerExecutable,
    mergeRepository: repository,
    mergeCommand: [
      "gh",
      "pr",
      "merge",
      String(pullRequest),
      "--repo",
      repository,
      "--match-head-commit",
      reviewedHead,
      "--merge",
      "--delete-branch=false"
    ]
  };
}

export function resolveGitPushExecutionBinding(record) {
  const [, resourceRemote, resourceRef] = GIT_PUSH_RESOURCE.exec(record.resource) ?? [];
  const expectedRef = `refs/heads/${record.expectedBranch}`;
  const expectedCommand = [
    "git",
    "push",
    "--porcelain",
    record.pushUrl,
    `${record.expectedRevision}:${expectedRef}`
  ];
  if (
    !resourceRemote ||
    record.remote !== resourceRemote ||
    typeof record.pushUrl !== "string" ||
    !record.pushUrl ||
    record.pushUrlDigest !== sha256(record.pushUrl) ||
    repositoryIdentity(record.pushUrl) !== record.remoteRepository ||
    !SHA256_DIGEST.test(record.sourceBindingDigest ?? "") ||
    !SHA256_DIGEST.test(record.sourceRemoteBindingDigest ?? "") ||
    resourceRef !== expectedRef ||
    JSON.stringify(record.pushCommand) !== JSON.stringify(expectedCommand)
  ) {
    throw new Error("Git push execution binding is inconsistent with the governed resource");
  }
  return { remote: resourceRemote, pushUrl: record.pushUrl, ref: resourceRef, command: expectedCommand };
}

export function buildBoundGitPushArgs(expectedCommand, credentialFile, gitExecutablePath = BOUND_GIT_EXECUTABLE) {
  if (!Array.isArray(expectedCommand) || expectedCommand[0] !== "git" || expectedCommand[1] !== "push" ||
      typeof credentialFile !== "string" || credentialFile.includes("\0") || !path.isAbsolute(credentialFile) ||
      path.resolve(credentialFile) !== credentialFile || gitExecutablePath !== BOUND_GIT_EXECUTABLE) {
    throw new Error("Bound Git push requires a canonical command and credential file");
  }
  // Git interprets a helper containing arguments through a shell. Preserve the
  // exact canonical file as one shell word even when TMPDIR contains spaces,
  // quotes, command substitutions, or other metacharacters.
  const quotedCredentialFile = `'${credentialFile.replaceAll("'", "'\\''")}'`;
  const credentialHelper = `!${BOUND_GIT_EXECUTABLE} credential-store --file=${quotedCredentialFile}`;
  return [
    "--no-replace-objects",
    "-c", "core.bare=true",
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "http.followRedirects=false",
    "-c", "http.proxy=",
    "-c", "http.sslVerify=true",
    "-c", "credential.helper=",
    "-c", `credential.helper=${credentialHelper}`,
    "-c", "credential.useHttpPath=true",
    "-c", "credential.interactive=false",
    "-c", "core.askPass=/usr/bin/false",
    "-c", "core.hooksPath=/dev/null",
    ...expectedCommand.slice(1)
  ];
}

export function buildBoundGitPushEnvironment({ isolatedHome, gitDirectory, objectDirectory }) {
  for (const [label, value] of Object.entries({ isolatedHome, gitDirectory, objectDirectory })) {
    if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
      throw new Error(`Bound Git push ${label} must be a canonical absolute path`);
    }
  }
  if (objectDirectory.includes(path.delimiter)) throw new Error("Bound Git push object directory cannot contain a path-list delimiter");
  return {
    PATH: BOUND_GIT_PATH,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    TMPDIR: isolatedHome,
    LC_ALL: "C",
    GIT_DIR: gitDirectory,
    GIT_COMMON_DIR: gitDirectory,
    GIT_OBJECT_DIRECTORY: path.join(gitDirectory, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirectory,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sorted(value));
}

export function digestObject(value) {
  return sha256(canonicalJson(value));
}

export function getStateRoot(env = process.env) {
  if (env.SBW_STATE_ROOT) return path.resolve(env.SBW_STATE_ROOT);
  const codexHome = env.CODEX_HOME
    ? path.resolve(env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sbw");
}

export function getCodexPluginCacheRoot(env = process.env) {
  const codexHome = env.CODEX_HOME
    ? path.resolve(env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  return path.join(codexHome, "plugins", "cache", "better-workflows", "better-workflows");
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

export async function ensurePrivateDir(target) {
  if (await pathExists(target)) {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink directory: ${target}`);
    if (!info.isDirectory()) throw new Error(`Expected directory: ${target}`);
  } else {
    await mkdir(target, { recursive: true, mode: 0o700 });
  }
  await chmod(target, 0o700);
  return target;
}

export function safeJoin(root, ...parts) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...parts);
  const relative = path.relative(resolvedRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes root: ${target}`);
  }
  return target;
}

export async function assertNoSymlinkUnder(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = safeJoin(resolvedRoot, path.relative(resolvedRoot, path.resolve(target)));
  await ensurePrivateDir(resolvedRoot);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!(await pathExists(current))) break;
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink path component: ${current}`);
  }
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWriteJson(root, target, value) {
  const parent = path.dirname(target);
  await assertNoSymlinkUnder(root, parent);
  await ensurePrivateDir(parent);
  const temp = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temp, 0o600);
  await rename(temp, target);
  await chmod(target, 0o600);
  await fsyncDirectory(parent);
}

export async function readJson(root, target) {
  await assertNoSymlinkUnder(root, target);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error(`Unsafe JSON path: ${target}`);
  }
  return JSON.parse(await readFile(target, "utf8"));
}

export async function appendJournal(root, runDir, event, details = {}) {
  const target = safeJoin(runDir, "journal.jsonl");
  await assertNoSymlinkUnder(root, target);
  if (await pathExists(target)) {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`Unsafe journal path: ${target}`);
    }
  }
  const record = {
    at: nowIso(),
    event,
    ...details
  };
  const handle = await open(target, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(target, 0o600);
  return record;
}

async function readJournalRecords(root, runDir) {
  const target = safeJoin(runDir, "journal.jsonl");
  await assertNoSymlinkUnder(root, target);
  if (!(await pathExists(target))) return [];
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error(`Unsafe journal path: ${target}`);
  }
  return (await readFile(target, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function appendJournalOnceForAttempt(root, runDir, event, attemptId, details = {}) {
  const target = safeJoin(runDir, "journal.jsonl");
  await assertNoSymlinkUnder(root, target);
  if (await pathExists(target)) {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`Unsafe journal path: ${target}`);
    }
    const records = (await readFile(target, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (records.some((record) => (
      record.event === event && [record.attemptId, record.actionAttemptId].includes(attemptId)
    ))) return null;
  }
  return appendJournal(root, runDir, event, { attemptId, ...details });
}

export async function loadDefaults() {
  return JSON.parse(await readFile(DEFAULTS_PATH, "utf8"));
}

function riskValue(value) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0 || number > 3) {
    throw new Error("Risk dimensions must be integers from 0 to 3");
  }
  return number;
}

export function routeMode(contract, requested = "auto") {
  if (!MODES.has(requested)) throw new Error(`Unknown mode: ${requested}`);
  if (requested !== "auto") return requested;
  const risk = contract.risk ?? {};
  const values = [
    riskValue(risk.risk),
    riskValue(risk.uncertainty),
    riskValue(risk.blastRadius),
    riskValue(risk.irreversibility),
    riskValue(risk.evidenceGap)
  ];
  const [baseRisk, , blastRadius, irreversibility] = values;
  const score = values.reduce((sum, value) => sum + value, 0);
  if (irreversibility >= 3 || (baseRisk >= 3 && blastRadius >= 2) || score >= 11) return "critical";
  if (score >= 7) return "deep";
  if (score >= 3) return "verified";
  return "direct";
}

export function validateContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("TaskContract must be an object");
  }
  if (![1, 2].includes(contract.schemaVersion)) {
    throw new Error("TaskContract.schemaVersion must be 1 or 2");
  }
  if (typeof contract.goal !== "string" || !contract.goal.trim()) {
    throw new Error("TaskContract.goal is required");
  }
  if (typeof contract.template !== "string" || !contract.template) {
    throw new Error("TaskContract.template is required");
  }
  if (contract.selfImprovePurpose !== undefined) {
    if (!new Set(["ordinary", "evaluator-migration", "safety-remediation-v1", "quality-remediation-v1"]).has(contract.selfImprovePurpose)) {
      throw new Error("TaskContract.selfImprovePurpose is invalid");
    }
    if (contract.template !== "self-improve-ops") {
      throw new Error("TaskContract.selfImprovePurpose is only valid for self-improve-ops");
    }
  }
  if (!contract.scope || !Array.isArray(contract.scope.include) || contract.scope.include.length === 0) {
    throw new Error("TaskContract.scope.include must be a non-empty array");
  }
  contract.scope.include = canonicalizeScope(contract.scope.include);
  if (contract.scope.exclude !== undefined) {
    if (!Array.isArray(contract.scope.exclude)) throw new Error("TaskContract.scope.exclude must be an array");
    contract.scope.exclude = contract.scope.exclude.length === 0 ? [] : canonicalizeScope(contract.scope.exclude);
  }
  if (!Array.isArray(contract.acceptance) || contract.acceptance.length === 0) {
    throw new Error("TaskContract.acceptance must be a non-empty array");
  }
  if (!Array.isArray(contract.requiredEvidence)) {
    throw new Error("TaskContract.requiredEvidence must be an array");
  }
  const requiredEvidence = new Set();
  for (const kind of contract.requiredEvidence) {
    if (typeof kind !== "string" || !SAFE_ID.test(kind)) {
      throw new Error("Every required evidence kind must be a safe id");
    }
    if (requiredEvidence.has(kind)) throw new Error(`Duplicate required evidence kind: ${kind}`);
    requiredEvidence.add(kind);
  }
  const acceptanceIds = new Set();
  for (const item of contract.acceptance) {
    if (!item || typeof item.id !== "string" || !SAFE_ID.test(item.id)) {
      throw new Error("Every acceptance item needs a safe id");
    }
    if (acceptanceIds.has(item.id)) throw new Error(`Duplicate acceptance id: ${item.id}`);
    acceptanceIds.add(item.id);
    if (typeof item.description !== "string" || !item.description.trim()) {
      throw new Error(`Acceptance item ${item.id} needs a description`);
    }
  }
  if (!["public", "internal", "confidential", "regulated"].includes(contract.sensitivity)) {
    throw new Error("TaskContract.sensitivity is invalid");
  }
  for (const key of ["risk", "uncertainty", "blastRadius", "irreversibility", "evidenceGap"]) {
    riskValue(contract.risk?.[key]);
  }
  if (contract.authority?.rootOnlyMutation !== true) {
    throw new Error("TaskContract must require rootOnlyMutation");
  }
  if (contract.autonomyProfile !== undefined) {
    validateAutonomyBinding(contract.autonomyProfile);
    if (contract.template !== "pr-to-dev") {
      throw new Error("TaskContract bounded-autopilot-v1 is only valid for pr-to-dev delivery");
    }
    const externalSideEffects = new Set(contract.authority?.externalSideEffects ?? []);
    const allowedAutonomyActions = new Set(["git.commit", "plugin.cache.publish", "git.push", "pr.create"]);
    if ([...externalSideEffects].some((action) => !allowedAutonomyActions.has(action))) {
      throw new Error("TaskContract autonomy authority contains an action outside bounded-autopilot-v1");
    }
    if (digestObject(contract.scope.include) !== digestObject(contract.autonomyProfile.pathScope)) {
      throw new Error("TaskContract autonomy path scope must match the run scope exactly");
    }
  }
  if (contract.schemaVersion === 2) {
    const controlPlane = contract.controlPlane;
    if (!controlPlane || typeof controlPlane !== "object" || Array.isArray(controlPlane)) {
      throw new Error("TaskContract v2.controlPlane is required");
    }
    const policies = {
      evidencePolicy: new Set(["typed-v1"]),
      ledgerPolicy: new Set(["ledger-v1"]),
      reviewPolicy: new Set(REVIEW_POLICIES),
      designPacketPolicy: new Set(["none", "pilot-v1"]),
      refinementPolicy: new Set(["none", "pilot-v1"]),
      deliberationPolicy: new Set(["none", "allowed-v1"])
    };
    for (const [key, allowed] of Object.entries(policies)) {
      if (!allowed.has(controlPlane[key])) {
        throw new Error(`TaskContract v2.controlPlane.${key} is invalid`);
      }
    }
    const reviewEnabled = controlPlane.reviewPolicy !== "none";
    if (reviewEnabled && contract.reviewProfile === undefined) {
      throw new Error("TaskContract review-enabled policy requires reviewProfile");
    }
    if (!reviewEnabled && contract.reviewProfile !== undefined) {
      throw new Error("TaskContract cannot weaken template control-plane policy: reviewProfile is not allowed when review policy is none");
    }
    if (contract.reviewProfile !== undefined) {
      validateReviewProfile(contract.reviewProfile, {
        template: contract.template,
        reviewPolicy: controlPlane.reviewPolicy
      });
    }
    const baseControlPlaneKeys = [
      "evidencePolicy",
      "ledgerPolicy",
      "reviewPolicy",
      "designPacketPolicy",
      "refinementPolicy",
      "deliberationPolicy"
    ];
    const kernelEnabled = reviewKernelEnabled(controlPlane.reviewPolicy);
    const allowedControlPlaneKeys = new Set([
      ...baseControlPlaneKeys,
      ...(kernelEnabled ? ["workUnitPolicy", "reviewLanes"] : [])
    ]);
    const unknownControlPlaneKeys = Object.keys(controlPlane).filter((key) => !allowedControlPlaneKeys.has(key));
    if (unknownControlPlaneKeys.length > 0) {
      throw new Error(`TaskContract v2.controlPlane has unknown fields: ${unknownControlPlaneKeys.join(", ")}`);
    }
    if (kernelEnabled) {
      if (contract.template !== "self-improve-ops") {
        throw new Error("TaskContract code-v2-pilot is restricted to self-improve-ops");
      }
      if (controlPlane.workUnitPolicy !== "diff-files-v1") {
        throw new Error("TaskContract code-v2-pilot requires diff-files-v1 work units");
      }
      if (!Array.isArray(controlPlane.reviewLanes) || controlPlane.reviewLanes.length < 2 || controlPlane.reviewLanes.length > 5) {
        throw new Error("TaskContract code-v2-pilot requires two to five review lanes");
      }
      const laneIds = new Set();
      for (const lane of controlPlane.reviewLanes) {
        if (
          !lane || typeof lane !== "object" || Array.isArray(lane) ||
          Object.keys(lane).sort().join("\0") !== ["contextProfile", "id", "required", "role"].join("\0") ||
          typeof lane.id !== "string" || !SAFE_ID.test(lane.id) || laneIds.has(lane.id) || lane.role !== "finder" ||
          !["context-rich", "low-context", "adversarial", "mechanical"].includes(lane.contextProfile) ||
          typeof lane.required !== "boolean"
        ) throw new Error("TaskContract code-v2-pilot review lane is invalid or duplicated");
        laneIds.add(lane.id);
      }
      const requiredLanes = controlPlane.reviewLanes.filter((lane) => lane.required);
      if (requiredLanes.length < 2 || requiredLanes.every((lane) => lane.contextProfile === "low-context")) {
        throw new Error("TaskContract code-v2-pilot requires two required lanes including a non-low-context lane");
      }
    }
    if (!Array.isArray(contract.executionStages) || contract.executionStages.length === 0) {
      throw new Error("TaskContract v2.executionStages must be a non-empty array");
    }
    const stageIds = new Set();
    const stageBudgets = { regular: 3, review: 5, "side-effect": 1, authorization: 1 };
    for (const stage of contract.executionStages) {
      if (!stage || typeof stage.id !== "string" || !SAFE_ID.test(stage.id)) {
        throw new Error("Every TaskContract v2 execution stage needs a safe id");
      }
      if (stageIds.has(stage.id)) throw new Error(`Duplicate execution stage id: ${stage.id}`);
      stageIds.add(stage.id);
      if (!Array.isArray(stage.dependsOn ?? [])) throw new Error(`Stage ${stage.id} dependsOn must be an array`);
      if (!Array.isArray(stage.requiredEvidence ?? [])) {
        throw new Error(`Stage ${stage.id} requiredEvidence must be an array`);
      }
      const kind = String(stage.kind ?? "regular");
      if (!(kind in stageBudgets)) throw new Error(`Stage ${stage.id} kind is invalid`);
      if (stage.attemptBudget !== stageBudgets[kind]) {
        throw new Error(`Stage ${stage.id} must use the ${kind} attempt budget of ${stageBudgets[kind]}`);
      }
    }
    for (const stage of contract.executionStages) {
      for (const dependency of stage.dependsOn ?? []) {
        if (!stageIds.has(dependency)) throw new Error(`Stage ${stage.id} has unknown dependency: ${dependency}`);
      }
    }
    if (contract.actionStages !== undefined) {
      if (!contract.actionStages || typeof contract.actionStages !== "object" || Array.isArray(contract.actionStages)) {
        throw new Error("TaskContract v2.actionStages must be an object");
      }
      const actionGates = contract.actionGates ?? {};
      for (const [action, stageId] of Object.entries(contract.actionStages)) {
        if (!Object.hasOwn(actionGates, action)) {
          throw new Error(`TaskContract v2 action stage has no action gate: ${action}`);
        }
        if (typeof stageId !== "string" || !stageIds.has(stageId)) {
          throw new Error(`TaskContract v2 action stage is unknown: ${action}`);
        }
      }
      for (const action of Object.keys(contract.actionGates ?? {})) {
        if (!Object.hasOwn(contract.actionStages, action)) {
          throw new Error(`TaskContract v2 action gate has no execution stage: ${action}`);
        }
      }
    } else if (Object.keys(contract.actionGates ?? {}).length > 0) {
      throw new Error("TaskContract v2 action gates require actionStages");
    }
    if (contract.deferredActions !== undefined) {
      if (!Array.isArray(contract.deferredActions)) {
        throw new Error("TaskContract v2.deferredActions must be an array");
      }
      const activeActions = new Set(Object.keys(contract.actionStages ?? {}).map(canonicalDeferredAction));
      const deferredActions = new Set();
      for (const action of contract.deferredActions) {
        if (typeof action !== "string" || !SAFE_ID.test(action)) {
          throw new Error("Every deferred action must be a safe id");
        }
        const canonical = canonicalDeferredAction(action);
        if (deferredActions.has(canonical)) {
          throw new Error(`TaskContract v2 deferred action aliases must be unique: ${action}`);
        }
        deferredActions.add(canonical);
        if (activeActions.has(canonical)) {
          throw new Error(`TaskContract v2 action cannot be both active and deferred: ${action}`);
        }
      }
    }
    if (contract.acceptanceEvidence !== undefined) {
      if (!contract.acceptanceEvidence || typeof contract.acceptanceEvidence !== "object") {
        throw new Error("TaskContract v2.acceptanceEvidence must be an object");
      }
      for (const item of contract.acceptance) {
        const required = contract.acceptanceEvidence[item.id];
        if (!Array.isArray(required) || required.length === 0) {
          throw new Error(`TaskContract v2 acceptanceEvidence is missing ${item.id}`);
        }
      }
    }
  }
  return contract;
}

export function canonicalizeScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) throw new Error("Scope must be a non-empty array");
  const normalized = [...new Set(scope.map((item) => String(item).replaceAll("\\", "/")))].sort();
  for (const item of normalized) {
    const segments = item.split("/");
    if (
      !item ||
      item !== "." && item.startsWith("./") ||
      item.startsWith("/") ||
      item.startsWith(":") ||
      /[*?\[\]]/.test(item) ||
      segments.some((segment) => segment === ".." || (segment === "." && item !== ".")) ||
      item.includes("//") ||
      item.endsWith("/")
    ) {
      throw new Error(`Scope contains a non-literal relative path: ${item}`);
    }
  }
  return normalized;
}

export function buildContract({
  template,
  templateDefinition,
  goal,
  scope = ["."],
  risk = {},
  sensitivity = "internal",
  authority = [],
  agyAllowed = false,
  agySanitized = false,
  volatileExclusions = [],
  highRiskIgnored = [],
  remoteRevision = null,
  selfImprovePurpose = null,
  autonomyProfile = null
}) {
  const acceptance = templateDefinition.acceptance ?? [
    { id: "task-complete", description: "The requested task is complete.", critical: true }
  ];
  const requiredEvidence = templateDefinition.requiredEvidence ?? [];
  const isV2 = templateDefinition.controlPlane && Array.isArray(templateDefinition.executionStages);
  const acceptanceEvidence = Object.fromEntries(
    acceptance.map((item) => [item.id, [...requiredEvidence]])
  );
  const externalSideEffects = [...new Set([
    ...authority,
    ...(autonomyProfile ? ["git.commit", "plugin.cache.publish", "git.push", "pr.create"] : [])
  ])];
  return validateContract({
    schemaVersion: isV2 ? 2 : 1,
    goal,
    template,
    scope: { include: scope, exclude: [] },
    acceptance,
    requiredEvidence,
    authority: {
      rootOnlyMutation: true,
      externalSideEffects
    },
    risk: {
      risk: riskValue(risk.risk),
      uncertainty: riskValue(risk.uncertainty),
      blastRadius: riskValue(risk.blastRadius),
      irreversibility: riskValue(risk.irreversibility),
      evidenceGap: riskValue(risk.evidenceGap)
    },
    sensitivity,
    agy: { allowed: Boolean(agyAllowed), sanitized: Boolean(agySanitized) },
    volatileExclusions,
    highRiskIgnored,
    remoteRevision,
    ...(selfImprovePurpose !== null ? { selfImprovePurpose } : {}),
    ...(autonomyProfile !== null ? { autonomyProfile } : {}),
    ...(isV2
      ? {
          controlPlane: structuredClone(templateDefinition.controlPlane),
          ...(templateDefinition.reviewProfile
            ? { reviewProfile: structuredClone(templateDefinition.reviewProfile) }
            : {}),
          executionStages: structuredClone(templateDefinition.executionStages),
          actionGates: structuredClone(templateDefinition.actionGates ?? {}),
          ...(templateDefinition.actionStages
            ? { actionStages: structuredClone(templateDefinition.actionStages) }
            : {}),
          ...(templateDefinition.deferredActions
            ? { deferredActions: structuredClone(templateDefinition.deferredActions) }
            : {}),
          acceptanceEvidence
        }
      : {})
  });
}

function generateRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `sbw-${stamp}-${randomBytes(6).toString("hex")}`;
}

export function runDirectory(root, runId) {
  if (!RUN_ID.test(runId)) throw new Error(`Invalid run id: ${runId}`);
  return safeJoin(root, "runs", runId);
}

export async function ensureStateRoot(root = getStateRoot()) {
  await ensurePrivateDir(root);
  await ensurePrivateDir(safeJoin(root, "runs"));
  return root;
}

export async function createRun({ root = getStateRoot(), contract, requestedMode = "auto", cwd, baselineRevision = null }) {
  validateContract(contract);
  const mode = routeMode(contract, requestedMode);
  if (mode === "direct") {
    return { runId: null, mode, direct: true, contractDigest: digestObject(contract) };
  }
  await ensureStateRoot(root);
  let runId;
  let runDir;
  let stagingDir;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    runId = generateRunId();
    runDir = runDirectory(root, runId);
    stagingDir = safeJoin(root, "runs", `.creating-${runId}`);
    try {
      await mkdir(stagingDir, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || attempt === 7) throw error;
    }
  }
  try {
    await chmod(stagingDir, 0o700);
    for (const child of ["evidence", "findings", "sentinels", "actions"]) {
      await ensurePrivateDir(safeJoin(stagingDir, child));
    }
    const createdAt = nowIso();
    const { captureSourceBinding } = await import("./git.mjs");
    const sourceBinding = await captureSourceBinding(path.resolve(cwd), {
      baseRevision: baselineRevision ?? contract.remoteRevision ?? null,
      requireClean: contract.template === "self-improve-ops" || Boolean(contract.upstreamSelfImproveRunId)
    });
    const manifest = {
      schemaVersion: 1,
      runId,
      version: VERSION,
      template: contract.template,
      mode,
      requestedMode,
      cwd: path.resolve(cwd),
      baselineRevision,
      evaluationPurpose: contract.selfImprovePurpose ?? "ordinary",
      pluginCacheRoot: getCodexPluginCacheRoot(),
      sourceBinding,
      ...(contract.autonomyProfile
        ? {
            autonomyProfile: {
              ...contract.autonomyProfile,
              sourceBindingDigest: sourceBinding.digest,
              sourceHeadRevision: sourceBinding.headRevision
            }
          }
        : {}),
      createdAt,
      contractDigest: digestObject(contract),
      authority: {
        rootOnlyMutation: true,
        nativeSubagentsAreTrustedContract: true
      },
      ownedResources: []
    };
    const state = {
      schemaVersion: 1,
      runId,
      status: "running",
      mode,
      createdAt,
      updatedAt: createdAt,
      lastSentinel: null,
      lastSentinelVerified: false,
      lastSentinelComplete: false,
      autonomy: contract.autonomyProfile
        ? {
            profileId: contract.autonomyProfile.id,
            profileDigest: contract.autonomyProfile.profileDigest,
            expiresAt: contract.autonomyProfile.expiresAt,
            status: "unpreflighted",
            blockedReason: "preflight-required",
            resumeFromStage: null
          }
        : null,
      sideEffects: []
    };
    await atomicWriteJson(root, safeJoin(stagingDir, "contract.json"), contract);
    await atomicWriteJson(root, safeJoin(stagingDir, "manifest.json"), manifest);
    await atomicWriteJson(root, safeJoin(stagingDir, "state.json"), state);
    if (contract.schemaVersion === 2) {
      const { initializeLedger } = await import("./ledger.mjs");
      await initializeLedger(root, stagingDir, contract, runId);
    }
    await appendJournal(root, stagingDir, "run.created", { mode, requestedMode });
    await rename(stagingDir, runDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { runId, mode, direct: false, contractDigest: digestObject(contract) };
}

export async function loadRun(root, runId) {
  const runDir = runDirectory(root, runId);
  await assertNoSymlinkUnder(root, runDir);
  return {
    runDir,
    manifest: await readJson(root, safeJoin(runDir, "manifest.json")),
    contract: await readJson(root, safeJoin(runDir, "contract.json")),
    state: await readJson(root, safeJoin(runDir, "state.json"))
  };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function withRunLock(root, runId, callback, options = {}) {
  const runDir = runDirectory(root, runId);
  const lockPath = safeJoin(runDir, ".lease");
  const token = randomBytes(24).toString("hex");
  const ttlMs = options.ttlMs ?? 60_000;
  let acquired = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({
          token,
          pid: process.pid,
          host: os.hostname(),
          createdAt: nowIso(),
          expiresAt: new Date(Date.now() + ttlMs).toISOString()
        })}\n`
      );
      await handle.sync();
      await handle.close();
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readJson(root, lockPath).catch(() => null);
      const expired = existing && Date.parse(existing.expiresAt) < Date.now();
      if (!expired || existing?.host !== os.hostname() || processAlive(existing?.pid)) {
        if (expired && existing?.host && existing.host !== os.hostname()) {
          throw new Error(`Run lease expired on host ${existing.host}; refusing cross-host lease reclamation`);
        }
        throw new Error(`Run is leased by pid ${existing?.pid ?? "unknown"}`);
      }
      await rename(lockPath, safeJoin(runDir, `.lease.stale.${randomUUID()}`));
    }
  }
  if (!acquired) throw new Error("Unable to acquire run lease");
  try {
    return await callback({ token, runDir });
  } finally {
    const existing = await readJson(root, lockPath).catch(() => null);
    if (existing?.token === token) await unlink(lockPath).catch(() => undefined);
  }
}

export function assertProviderReceiptShape(record, providerReceipt, outcome = record.outcome) {
  const commonValid = (
    providerReceipt &&
    typeof providerReceipt === "object" &&
    !Array.isArray(providerReceipt) &&
    typeof providerReceipt.executionId === "string" &&
    providerReceipt.executionId.length > 0 &&
    typeof providerReceipt.proofKind === "string" &&
    providerReceipt.proofKind.length > 0 &&
    typeof providerReceipt.requestDigest === "string" &&
    SHA256_DIGEST.test(providerReceipt.requestDigest) &&
    typeof providerReceipt.responseDigest === "string" &&
    SHA256_DIGEST.test(providerReceipt.responseDigest) &&
    typeof providerReceipt.verifiedAt === "string" &&
    !Number.isNaN(Date.parse(providerReceipt.verifiedAt)) &&
    typeof providerReceipt.terminalState === "string" &&
    providerReceipt.terminalState.length > 0
  );
  if (!commonValid) throw new Error("Provider receipt lacks a structured execution proof");
  if (record.action === "actions.dispatch" && !workflowResourceMatchesFile(record)) {
    throw new Error("GitHub Actions dispatch receipt resource is not bound to workflowFile");
  }
  if (record.action === "actions.dispatch") {
    const notSentShapeComplete = (
      providerReceipt.created === false &&
      providerReceipt.dispatchState === "not-sent" &&
      record.providerInvocation?.provider === "github-cli" &&
      outcome === "failure" &&
      providerReceipt.terminalState === "failure" &&
      typeof providerReceipt.repository === "string" &&
      providerReceipt.repository === canonicalGitHubRepository(record.dispatchRepository) &&
      typeof providerReceipt.workflowFile === "string" && providerReceipt.workflowFile === record.workflowFile &&
      typeof providerReceipt.ref === "string" && providerReceipt.ref === record.dispatchRef &&
      typeof providerReceipt.dispatchNonce === "string" && providerReceipt.dispatchNonce === record.dispatchNonce &&
      typeof providerReceipt.dispatchInputsDigest === "string" && SHA256_DIGEST.test(providerReceipt.dispatchInputsDigest) &&
      typeof providerReceipt.workflowDispatchCapabilityDigest === "string" &&
      providerReceipt.workflowDispatchCapabilityDigest === record.workflowDispatchCapabilityDigest &&
      typeof providerReceipt.invocationId === "string" && providerReceipt.invocationId === record.providerInvocation?.id &&
      typeof providerReceipt.errorDigest === "string" && SHA256_DIGEST.test(providerReceipt.errorDigest) &&
      providerReceipt.responseDigest === digestObject(actionsDispatchNotSentReceiptResponse(record, record.providerInvocation))
    );
    if (notSentShapeComplete) {
      if (providerReceipt.proofKind !== "github-actions-dispatch") {
        throw new Error("GitHub Actions not-sent proof kind is invalid");
      }
    } else {
      const dispatchShapeComplete = (
        providerReceipt.created === true &&
        typeof providerReceipt.runId === "string" &&
        /^\d+$/.test(providerReceipt.runId) &&
        typeof providerReceipt.url === "string" && providerReceipt.url.length > 0 &&
        typeof providerReceipt.repository === "string" &&
        providerReceipt.repository === canonicalGitHubRepository(record.dispatchRepository) &&
        typeof providerReceipt.workflowName === "string" && providerReceipt.workflowName.length > 0 &&
        typeof providerReceipt.workflowFile === "string" && providerReceipt.workflowFile === record.workflowFile &&
        typeof providerReceipt.ref === "string" && providerReceipt.ref === record.dispatchRef &&
        typeof providerReceipt.headSha === "string" && SHA.test(providerReceipt.headSha) &&
        providerReceipt.headSha === record.remoteRevision &&
        typeof providerReceipt.dispatchNonce === "string" && providerReceipt.dispatchNonce === record.dispatchNonce &&
        typeof providerReceipt.displayTitle === "string" && providerReceipt.displayTitle.includes(record.dispatchNonce) &&
        typeof providerReceipt.dispatchInputsDigest === "string" && SHA256_DIGEST.test(providerReceipt.dispatchInputsDigest) &&
        typeof providerReceipt.workflowDispatchCapabilityDigest === "string" &&
        providerReceipt.workflowDispatchCapabilityDigest === record.workflowDispatchCapabilityDigest &&
        typeof providerReceipt.invocationId === "string" && providerReceipt.invocationId === record.providerInvocation?.id
      );
      if (!dispatchShapeComplete) throw new Error("GitHub Actions dispatch proof is incomplete");
      if (
        outcome === "unknown" &&
        providerReceipt.status === "completed" &&
        typeof providerReceipt.conclusion === "string" &&
        providerReceipt.conclusion.length > 0
      ) {
        throw new Error("Completed GitHub Actions dispatch receipt cannot remain unknown");
      }
      if (outcome === "unknown" && providerReceipt.terminalState !== "unknown") {
        throw new Error("Unknown GitHub Actions dispatch outcome must remain indeterminate");
      }
      if (outcome !== "unknown" && !workflowDispatchConclusionMatchesOutcome(
        providerReceipt.status,
        providerReceipt.conclusion,
        outcome
      )) {
        throw new Error(
          outcome === "success"
            ? "Successful GitHub Actions dispatch receipt requires completed success"
            : "Failed GitHub Actions dispatch receipt requires completed non-success"
        );
      }
      if (outcome !== "unknown" && providerReceipt.terminalState !== outcome) {
        throw new Error("GitHub Actions dispatch receipt terminal state does not match its outcome");
      }
    }
  }
  if (outcome === "success" && providerReceipt.terminalState !== "success") {
    throw new Error("Successful provider receipt must have terminalState success");
  }
  const schema = ACTION_PROVIDER_RECEIPT_SCHEMAS[`${record.action}:${record.provider}`];
  if (outcome === "success" && !schema) {
    throw new Error("Successful action requires an approved provider-specific receipt schema");
  }
  if (schema && providerReceipt.proofKind !== schema.proofKind) {
    throw new Error("Provider receipt proof kind does not match the action and provider");
  }
  if (!schema && providerReceipt.proofKind !== `${record.provider}:${record.action}`) {
    throw new Error("Provider receipt proof kind does not match the action and provider");
  }
  if (OWNED_RESOURCE_CREATION_ACTIONS.has(record.action) && outcome === "success") {
    const proof = providerReceipt.creationProof;
    if (
      !proof ||
      typeof proof !== "object" ||
      Array.isArray(proof) ||
      proof.attemptId !== record.attemptId ||
      proof.idempotencyKey !== record.idempotencyKey ||
      typeof proof.marker !== "string" ||
      proof.marker !== `sbw:${record.attemptId}:${record.idempotencyKey}`
    ) {
      throw new Error("Owned resource creation requires a provider-native idempotency proof");
    }
  }
  if (
    outcome === "success" &&
    record.action === "branch.create" &&
    (!providerReceipt.created || typeof providerReceipt.ref !== "string" || !providerReceipt.ref ||
      typeof providerReceipt.revision !== "string" || !/^[a-f0-9]{7,64}$/i.test(providerReceipt.revision))
  ) {
    throw new Error("Git branch creation proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "worktree.create" &&
    (!providerReceipt.created || typeof providerReceipt.path !== "string" || !providerReceipt.path ||
      typeof providerReceipt.revision !== "string" || !/^[a-f0-9]{7,64}$/i.test(providerReceipt.revision))
  ) {
    throw new Error("Git worktree creation proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "git.commit" &&
    (!providerReceipt.created || typeof providerReceipt.revision !== "string" ||
      !/^[a-f0-9]{7,64}$/i.test(providerReceipt.revision))
  ) {
    throw new Error("Git commit proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "git.push" &&
    (!providerReceipt.pushed || !GIT_PUSH_RESOURCE.test(record.resource) ||
      providerReceipt.remote !== GIT_PUSH_RESOURCE.exec(record.resource)?.[1] ||
      providerReceipt.ref !== GIT_PUSH_RESOURCE.exec(record.resource)?.[2] ||
      providerReceipt.remoteRepository !== record.remoteRepository ||
      providerReceipt.pushUrlDigest !== record.pushUrlDigest ||
      providerReceipt.sourceBindingDigest !== record.sourceBindingDigest ||
      providerReceipt.sourceRemoteBindingDigest !== record.sourceRemoteBindingDigest ||
      providerReceipt.expectedBranch !== record.expectedBranch ||
      providerReceipt.expectedRevision !== record.expectedRevision ||
      providerReceipt.localRevision !== record.expectedRevision ||
      typeof providerReceipt.revision !== "string" || !/^[a-f0-9]{7,64}$/i.test(providerReceipt.revision))
  ) {
    throw new Error("Git push proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "branch.delete" &&
    (!providerReceipt.deleted || typeof providerReceipt.ref !== "string" || !providerReceipt.ref ||
      (record.resource.startsWith("branch:") && providerReceipt.ref !== record.resource.slice("branch:".length)))
  ) {
    throw new Error("Git branch deletion proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "pr.create" &&
    (!providerReceipt.created || !Number.isInteger(providerReceipt.number) ||
      typeof providerReceipt.head !== "string" || !providerReceipt.head ||
      typeof providerReceipt.base !== "string" || !providerReceipt.base ||
      (record.expectedHead !== undefined &&
        (!SHA.test(record.expectedHead) || providerReceipt.head !== record.expectedHead)) ||
      (record.targetRef && providerReceipt.base !== record.targetRef) ||
      typeof providerReceipt.url !== "string" || !providerReceipt.url)
  ) {
    throw new Error("GitHub pull request creation proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "issue.create" &&
    (!providerReceipt.created || !Number.isInteger(providerReceipt.number) ||
      typeof providerReceipt.repository !== "string" || !providerReceipt.repository ||
      typeof providerReceipt.url !== "string" || !providerReceipt.url)
  ) {
    throw new Error("GitHub issue creation proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "pr.merge" &&
    (!Number.isInteger(providerReceipt.pr) ||
      providerReceipt.pr !== Number(String(record.resource).replace(/^pull\//, "")) ||
      providerReceipt.state !== "MERGED" ||
      typeof providerReceipt.repository !== "string" || !providerReceipt.repository ||
      typeof providerReceipt.baseRefName !== "string" || !providerReceipt.baseRefName ||
      (record.targetRef && providerReceipt.baseRefName !== record.targetRef) ||
      providerReceipt.mergeMethod !== record.mergeMethod ||
      providerReceipt.adminBypass !== false ||
      providerReceipt.invocationId !== record.providerInvocation?.id ||
      JSON.stringify(providerReceipt.mergeCommand) !== JSON.stringify(record.mergeCommand) ||
      typeof providerReceipt.head !== "string" || !providerReceipt.head ||
      typeof providerReceipt.mergeCommit !== "string" || !providerReceipt.mergeCommit ||
      providerReceipt.mergeBase !== record.remoteRevision ||
      providerReceipt.mergeHead !== record.reviewedHead ||
      (record.mergeRepository && providerReceipt.repository !== record.mergeRepository) ||
      providerReceipt.providerExecutableDigest !== record.providerExecutable?.digest)
  ) {
    throw new Error("GitHub pull request merge proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "pr.close" &&
    (!Number.isInteger(providerReceipt.pr) ||
      providerReceipt.pr !== Number(String(record.resource).replace(/^pull\//, "")) ||
      providerReceipt.state !== "CLOSED" ||
      typeof providerReceipt.repository !== "string" || !providerReceipt.repository)
  ) {
    throw new Error("GitHub pull request close proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "actions.cancel" &&
    (!providerReceipt.cancelled || typeof providerReceipt.runId !== "string" || !providerReceipt.runId ||
      providerReceipt.terminalState !== "cancelled" || providerReceipt.conclusion !== "CANCELLED")
  ) {
    throw new Error("GitHub Actions cancellation proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "remote.sync" &&
    (typeof providerReceipt.ref !== "string" || !providerReceipt.ref ||
      providerReceipt.ref !== record.resource ||
      providerReceipt.remote !== record.remote ||
      typeof providerReceipt.repository !== "string" || !providerReceipt.repository ||
      providerReceipt.remoteRepository !== record.remoteRepository ||
      providerReceipt.remoteUrlDigest !== record.remoteUrlDigest ||
      providerReceipt.sourceBindingDigest !== record.sourceBindingDigest ||
      providerReceipt.sourceRemoteBindingDigest !== record.sourceRemoteBindingDigest ||
      typeof providerReceipt.providerRevision !== "string" ||
      !/^[a-f0-9]{7,64}$/i.test(providerReceipt.providerRevision) ||
      typeof providerReceipt.localRevision !== "string" ||
      !/^[a-f0-9]{7,64}$/i.test(providerReceipt.localRevision))
  ) {
    throw new Error("Git remote synchronization proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "worktree.cleanup" &&
    (!providerReceipt.removed || typeof providerReceipt.path !== "string" || !providerReceipt.path)
  ) {
    throw new Error("Git worktree cleanup proof is incomplete");
  }
  if (
    outcome === "success" &&
    OWNED_RESOURCE_CREATION_ACTIONS.has(record.action) &&
    typeof record.attemptId === "string" &&
    (!record.creationPrecondition ||
      record.creationPrecondition.state !== "absent" ||
      providerReceipt.creationPreconditionDigest !== digestObject(record.creationPrecondition))
  ) {
    throw new Error("Owned resource creation proof is not bound to the reserved absent precondition");
  }
}

async function reserveProviderExecution(root, record, executionId, outcome = record.outcome) {
  const directory = safeJoin(root, "provider-executions");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = safeJoin(directory, `${sha256(executionId)}.json`);
  const reservations = await listJsonRecords(root, directory);
  const sameAttempt = reservations.filter((item) => (
    item?.runId === record.runId &&
    item?.attemptId === record.attemptId &&
    item?.tokenHash === record.tokenHash
  ));
  if (sameAttempt.some((item) => (
    item.schemaVersion !== PROVIDER_EXECUTION_SCHEMA_VERSION ||
    typeof item.executionId !== "string" ||
    !["unknown", "success", "failure"].includes(item.outcome)
  ))) {
    throw new Error("Legacy provider execution reservation cannot be recovered; preserve the reservation");
  }
  if (sameAttempt.some((item) => item.action !== record.action)) {
    throw new Error("Provider execution identity is bound to a different action");
  }
  const actionReservations = sameAttempt.filter((item) => item.action === record.action);
  const exact = actionReservations.find((item) => item.executionId === executionId);
  if (exact) {
    if (exact.supersededBy && exact.supersededBy !== executionId) {
      throw new Error("Provider execution identity was superseded by another identity");
    }
    if (exact.outcome === outcome) return;
    const canResolveSameIdentity = (
      OWNED_RESOURCE_CREATION_ACTIONS.has(record.action) &&
      record.outcome === "unknown" &&
      exact.outcome === "unknown" &&
      ["success", "failure"].includes(outcome)
    );
    if (canResolveSameIdentity) {
      await atomicWriteJson(root, target, {
        ...exact,
        outcome,
        terminalAt: nowIso()
      });
      return;
    }
    throw new Error("Provider execution identity is already bound to a different terminal outcome");
  }
  const terminal = actionReservations.find((item) => ["success", "failure"].includes(item.outcome));
  const unknown = actionReservations.find((item) => item.outcome === "unknown");
  const canSupersedeUnknown = (
    OWNED_RESOURCE_CREATION_ACTIONS.has(record.action) &&
    record.outcome === "unknown" &&
    ["success", "failure"].includes(outcome) &&
    unknown &&
    (!unknown.supersededBy || unknown.supersededBy === executionId)
  );
  if (actionReservations.length > 0 && terminal && terminal.executionId !== executionId) {
    throw new Error("Provider execution identity is already bound to this action attempt");
  }
  if (actionReservations.length > 0 && !canSupersedeUnknown) {
    throw new Error("Provider execution identity is already bound to this action attempt");
  }
  if (canSupersedeUnknown && unknown.supersededBy !== executionId) {
    await atomicWriteJson(root, safeJoin(directory, `${sha256(unknown.executionId)}.json`), {
      ...unknown,
      supersededBy: executionId,
      supersededAt: nowIso()
    });
  }
  try {
    const handle = await open(target, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ schemaVersion: PROVIDER_EXECUTION_SCHEMA_VERSION, executionId, runId: record.runId, attemptId: record.attemptId, tokenHash: record.tokenHash, action: record.action, outcome, recordedAt: nowIso() })}\n`);
    await handle.sync();
    await handle.close();
  } catch (error) {
    if (error.code === "EEXIST") {
      const existing = await readJson(root, target).catch(() => null);
      if (
        existing?.schemaVersion !== PROVIDER_EXECUTION_SCHEMA_VERSION ||
        !["unknown", "success", "failure"].includes(existing?.outcome)
      ) {
        throw new Error("Legacy provider execution reservation cannot be recovered; preserve the reservation");
      }
      if (
        existing?.executionId === executionId &&
        existing?.runId === record.runId &&
        existing?.attemptId === record.attemptId &&
        existing?.tokenHash === record.tokenHash &&
        existing?.action === record.action
      ) return;
      throw new Error("Provider execution identity is already reserved globally");
    }
    throw error;
  }
}

function validateCreationReservationIdentity(identity) {
  if (
    !identity ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    typeof identity.provider !== "string" || !identity.provider ||
    typeof identity.repository !== "string" || !identity.repository ||
    typeof identity.action !== "string" || !identity.action ||
    typeof identity.resource !== "string" || !OWNED_RESOURCE.test(identity.resource)
  ) {
    throw new Error("Owned resource creation requires a canonical provider repository reservation identity");
  }
  return {
    provider: identity.provider,
    repository: identity.repository,
    action: identity.action,
    resource: identity.resource
  };
}

export function creationReservationKey(identity) {
  return digestObject(validateCreationReservationIdentity(identity));
}

function creationReservationPath(root, identity) {
  return safeJoin(root, "creation-reservations", `${creationReservationKey(identity)}.json`);
}

function legacyCreationReservationPath(root, resource) {
  return safeJoin(root, "creation-reservations", `${sha256(resource)}.json`);
}

function creationReservationLeasePath(root, identity) {
  return safeJoin(root, "creation-reservations", `.${creationReservationKey(identity)}.lease`);
}

async function withCreationReservationLock(root, identity, callback, options = {}) {
  const reservationIdentity = validateCreationReservationIdentity(identity);
  const directory = safeJoin(root, "creation-reservations");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = creationReservationLeasePath(root, reservationIdentity);
  const reservationKey = creationReservationKey(reservationIdentity);
  const token = randomBytes(24).toString("hex");
  const ttlMs = options.ttlMs ?? 60_000;
  let acquired = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({
        token,
        pid: process.pid,
        host: os.hostname(),
        reservationKey,
        ...reservationIdentity,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString()
      })}\n`);
      await handle.sync();
      await handle.close();
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readJson(root, lockPath).catch(() => null);
      const expired = existing && Date.parse(existing.expiresAt) < Date.now();
      if (!expired || existing?.host !== os.hostname() || processAlive(existing?.pid)) {
        if (expired && existing?.host && existing.host !== os.hostname()) {
          throw new Error(`Creation reservation lease expired on host ${existing.host}; refusing cross-host lease reclamation`);
        }
        throw new Error(`Creation resource is leased by pid ${existing?.pid ?? "unknown"}`);
      }
      await rename(lockPath, safeJoin(directory, `.${reservationKey}.lease.stale.${randomUUID()}`));
    }
  }
  if (!acquired) throw new Error("Unable to acquire creation reservation lease");
  try {
    return await callback();
  } finally {
    const existing = await readJson(root, lockPath).catch(() => null);
    if (existing?.token === token) await unlink(lockPath).catch(() => undefined);
  }
}

async function reserveCreationResource(root, runId, identity, tokenHash, expiresAt) {
  const reservationIdentity = validateCreationReservationIdentity(identity);
  return withCreationReservationLock(root, reservationIdentity, async () => {
    const legacyTarget = legacyCreationReservationPath(root, reservationIdentity.resource);
    if (await pathExists(legacyTarget)) {
      throw new Error("Legacy unscoped creation reservation requires explicit reconciliation");
    }
    const target = creationReservationPath(root, reservationIdentity);
    const existing = await readJson(root, target).catch(() => null);
    const existingAction = existing?.runId && existing?.tokenHash
      ? await readJson(root, safeJoin(runDirectory(root, existing.runId), "actions", `${existing.tokenHash}.json`)).catch(() => null)
      : null;
    const expiredIssued = (
      existingAction?.status === "issued" &&
      Number.isFinite(Date.parse(existing?.expiresAt ?? "")) &&
      Date.parse(existing.expiresAt) <= Date.now()
    );
    const knownFailure = existingAction?.status === "spent" && existingAction?.outcome === "failure";
    if (existing && !expiredIssued && !knownFailure) {
      throw new Error("Owned resource creation is already reserved by another action for this provider repository");
    }
    if (existing) await unlink(target);
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({
        ...reservationIdentity,
        reservationKey: creationReservationKey(reservationIdentity),
        runId,
        tokenHash,
        reservedAt: nowIso(),
        expiresAt
      })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

async function releaseCreationResource(root, runId, identity, tokenHash = null) {
  if (!identity) return;
  const reservationIdentity = validateCreationReservationIdentity(identity);
  return withCreationReservationLock(root, reservationIdentity, async () => {
    const target = creationReservationPath(root, reservationIdentity);
    const reservation = await readJson(root, target).catch(() => null);
    if (
      reservation?.runId === runId &&
      (tokenHash === null || reservation.tokenHash === tokenHash)
    ) await unlink(target).catch(() => undefined);
  });
}

async function assertCreationReservation(root, runId, identity, tokenHash, expiresAt) {
  const reservationIdentity = validateCreationReservationIdentity(identity);
  const reservation = await readJson(root, creationReservationPath(root, reservationIdentity)).catch(() => null);
  if (
    reservation?.reservationKey !== creationReservationKey(reservationIdentity) ||
    reservation?.provider !== reservationIdentity.provider ||
    reservation?.repository !== reservationIdentity.repository ||
    reservation?.action !== reservationIdentity.action ||
    reservation?.resource !== reservationIdentity.resource ||
    reservation?.runId !== runId ||
    reservation.tokenHash !== tokenHash ||
    reservation.expiresAt !== expiresAt ||
    Date.parse(reservation.expiresAt ?? "") <= Date.now()
  ) {
    throw new Error("Action token creation reservation is missing, expired, or rebound");
  }
  return reservation;
}

function creationProviderResource(creationReceipt) {
  assertSupportedGovernedAction(creationReceipt.action);
  const providerResource = creationReceipt.creationResource ?? creationReceipt.resource;
  if (typeof providerResource !== "string" || !OWNED_RESOURCE.test(providerResource)) {
    throw new Error("Owned resource creation provider resource is invalid");
  }
  if (creationReceipt.action === "pr.create" && providerResource !== "pull/new") {
    throw new Error("Owned pull request creation must bind its provider action to pull/new");
  }
  return providerResource;
}

async function registerOwnedResourceLocked(root, runId, run, runDir, { resource, creationReceipt }) {
  assertSupportedGovernedAction(creationReceipt.action);
  const providerResource = creationProviderResource(creationReceipt);
  if (
    creationReceipt.runId !== runId ||
    creationReceipt.ownerRunId !== runId ||
    creationReceipt.resource !== resource ||
    typeof creationReceipt.action !== "string" ||
    !creationReceipt.action ||
    !OWNED_RESOURCE_CREATION_ACTIONS.has(creationReceipt.action) ||
    typeof creationReceipt.attemptId !== "string" ||
    !creationReceipt.attemptId ||
    typeof creationReceipt.idempotencyKey !== "string" ||
    !creationReceipt.idempotencyKey ||
    typeof creationReceipt.remoteRevision !== "string" ||
    !creationReceipt.remoteRevision ||
    creationReceipt.outcome !== "success" ||
    typeof creationReceipt.provider !== "string" ||
    !creationReceipt.provider ||
    typeof creationReceipt.createdAt !== "string" ||
    Number.isNaN(Date.parse(creationReceipt.createdAt)) ||
    !Object.hasOwn(creationReceipt, "providerReceipt") ||
    !creationReceipt.providerReceipt ||
    typeof creationReceipt.providerReceipt !== "object" ||
    creationReceipt.providerReceipt.created !== true ||
    creationReceipt.providerReceipt.action !== creationReceipt.action ||
    creationReceipt.providerReceipt.resource !== providerResource ||
    creationReceipt.providerReceipt.outcome !== "success" ||
    creationReceipt.providerReceipt.runId !== runId ||
    creationReceipt.providerReceipt.attemptId !== creationReceipt.attemptId ||
    creationReceipt.providerReceipt.idempotencyKey !== creationReceipt.idempotencyKey ||
    creationReceipt.providerReceipt.remoteRevision !== creationReceipt.remoteRevision ||
    typeof creationReceipt.providerReceipt.executionId !== "string" ||
    !creationReceipt.providerReceipt.executionId
  ) {
    throw new Error("Owned resource creation receipt is not bound to this run and resource");
  }
  const receiptDigest = digestObject(creationReceipt);
  const manifestPath = safeJoin(runDir, "manifest.json");
  const manifest = await readJson(root, manifestPath);
  const schema = OWNED_RESOURCE_CREATION_SCHEMAS[creationReceipt.action];
  assertProviderReceiptShape({
    action: creationReceipt.action,
    provider: creationReceipt.provider,
    resource: providerResource
  }, creationReceipt.providerReceipt);
  if (
    !schema ||
    !schema.providers.has(creationReceipt.provider) ||
    !schema.pattern.test(resource) ||
    creationReceipt.providerReceipt.provider !== creationReceipt.provider ||
    !schema.prove(creationReceipt.providerReceipt, resource)
  ) {
    throw new Error("Owned resource creation receipt lacks action-specific provider creation proof");
  }
  const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
  const creationAction = actions.find((action) => (
    action.attemptId === creationReceipt.attemptId &&
    action.status === "spent" &&
    action.outcome === "success" &&
    action.action === creationReceipt.action &&
    action.provider === creationReceipt.provider &&
    action.resource === providerResource &&
    digestObject(action.receipt?.providerReceipt) === digestObject(creationReceipt.providerReceipt)
  ));
  if (!creationAction) {
    throw new Error("Owned resource registration requires a reconciled successful run action");
  }
  if (creationReceipt.action === "pr.create" && !SHA.test(creationAction.expectedHead ?? "")) {
    throw new Error("Owned pull request registration requires an exact expected source head");
  }
  assertProviderReceiptShape({
    action: creationReceipt.action,
    provider: creationReceipt.provider,
    resource: providerResource,
    expectedHead: creationAction.expectedHead
  }, creationReceipt.providerReceipt);
  const creationReservation = validateCreationReservationIdentity(creationAction.creationReservation);
  const reservation = await readJson(root, creationReservationPath(root, creationReservation)).catch(() => null);
  if (reservation?.runId !== runId || reservation.tokenHash !== creationAction.tokenHash) {
    throw new Error("Owned resource registration requires an exclusive creation reservation");
  }
  await verifyProviderReceipt(
    manifest,
    {
      action: creationReceipt.action,
      provider: creationReceipt.provider,
      resource: providerResource,
      outcome: "success",
      runId,
      remoteRevision: creationReceipt.remoteRevision,
      idempotencyKey: creationReceipt.idempotencyKey,
      attemptId: creationReceipt.attemptId,
      spentAt: creationAction.spentAt,
      providerAuthorization: creationAction.providerAuthorization,
      providerExecutable: creationAction.providerExecutable,
      createRepository: creationAction.createRepository,
      creationPrecondition: creationAction.creationPrecondition,
      targetRef: creationAction.targetRef,
      expectedHead: creationAction.expectedHead,
      treeDigest: creationAction.treeDigest
    },
    { providerReceipt: creationReceipt.providerReceipt }
  );
  if (!Array.isArray(manifest.ownedResources)) {
    throw new Error("Run manifest has no owned resource registry");
  }
  const existing = manifest.ownedResources.find((item) => item?.resource === resource);
  if (existing) {
    if (existing.ownerRunId !== runId || existing.receiptDigest !== receiptDigest) {
      throw new Error("Owned resource registration is immutable");
    }
    await releaseCreationResource(root, runId, creationReservation, creationAction.tokenHash);
    return existing;
  }
  const entry = {
    resource,
    creationResource: providerResource,
    ownerRunId: runId,
    receiptDigest,
    creationAttemptId: creationReceipt.attemptId,
    creationActionDigest: ownedResourceCreationActionDigest(creationAction),
    creationReservation,
    registeredAt: nowIso()
  };
  const nextManifest = {
    ...manifest,
    ownedResources: [...manifest.ownedResources, entry]
  };
  await atomicWriteJson(root, manifestPath, nextManifest);
  await appendJournal(root, runDir, "resource.registered", entry);
  await releaseCreationResource(root, runId, creationReservation, creationAction.tokenHash);
  return entry;
}

export async function registerOwnedResource(root, runId, { resource, creationReceipt }) {
  if (typeof resource !== "string" || !OWNED_RESOURCE.test(resource)) {
    throw new Error("Owned resource identity is invalid");
  }
  if (!creationReceipt || typeof creationReceipt !== "object" || Array.isArray(creationReceipt)) {
    throw new Error("Owned resource creation receipt is required");
  }
  assertSupportedGovernedAction(creationReceipt.action);
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Owned resource registration");
    return registerOwnedResourceLocked(root, runId, run, runDir, { resource, creationReceipt });
  });
}

export async function bindLegacyRunTemplate(
  root,
  runId,
  { templateDigest, actionGates, requiredEvidence, reviewProfile }
) {
  if (typeof templateDigest !== "string" || templateDigest.length < 16) {
    throw new Error("Legacy run migration requires a template digest");
  }
  if (!Array.isArray(requiredEvidence) || requiredEvidence.length === 0) {
    throw new Error("Legacy run migration requires template evidence minimums");
  }
  return withRunLock(root, runId, async ({ runDir }) => {
    const contractPath = safeJoin(runDir, "contract.json");
    const manifestPath = safeJoin(runDir, "manifest.json");
    const statePath = safeJoin(runDir, "state.json");
    const contract = await readJson(root, contractPath);
    const manifest = await readJson(root, manifestPath);
    const state = await readJson(root, statePath);
    const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
    const unsupportedAction = actions.find((action) => UNSUPPORTED_GOVERNED_ACTIONS.has(action.action));
    if (unsupportedAction) {
      throw new Error(`Legacy run contains quarantined governed action: ${unsupportedAction.action}`);
    }
    const currentEvidence = new Set(contract.requiredEvidence ?? []);
    const missingEvidence = requiredEvidence.filter((kind) => !currentEvidence.has(kind));
    const reviewPolicy = contract.schemaVersion === 2 ? contract.controlPlane?.reviewPolicy : "none";
    const reviewEnabled = contract.schemaVersion === 2 && reviewPolicy !== "none";
    const reviewProfileDrift = reviewEnabled
      ? !reviewProfile || !contract.reviewProfile || digestObject(contract.reviewProfile) !== digestObject(reviewProfile)
      : contract.reviewProfile !== undefined;
    if (
      contract.templateDigest === templateDigest &&
      contract.actionGates &&
      missingEvidence.length === 0 &&
      !reviewProfileDrift
    ) {
      return { migrated: false, contract, manifest, state };
    }
    const knownLegacyVersion = ["1.0.0", "2.0.1", "2.1.0", "2.5.0", "2.6.0"].includes(manifest.version);
    const [currentMajor, currentMinor, currentPatch] = VERSION.split(".").map(Number);
    const normalizedManifestVersion = String(manifest.version ?? "").split("+")[0];
    const currentFamilyMatch = new RegExp(`^${currentMajor}\\.${currentMinor}\\.(\\d+)$`).exec(normalizedManifestVersion);
    const currentFamilyVersion = currentFamilyMatch && Number(currentFamilyMatch[1]) <= currentPatch;
    if (!knownLegacyVersion && !currentFamilyVersion) {
      throw new Error(
        `Run ${runId} lacks current template minimums but was not created by a migratable workflow version`
      );
    }
    if (reviewEnabled) {
      if (!reviewProfile) {
        throw new Error("Legacy run migration requires the current reviewProfile");
      }
      validateReviewProfile(reviewProfile, {
        template: contract.template,
        reviewPolicy
      });
    } else if (reviewProfileDrift) {
      throw new Error("Legacy run migration rejects reviewProfile when review policy is none");
    }
    const nextContract = {
      ...contract,
      templateDigest,
      actionGates: structuredClone(actionGates ?? {}),
      requiredEvidence: [...new Set([...(contract.requiredEvidence ?? []), ...requiredEvidence])],
      ...(reviewEnabled ? { reviewProfile: structuredClone(reviewProfile) } : {})
    };
    const migratedAt = nowIso();
    const nextManifest = {
      ...manifest,
      version: VERSION,
      migratedFromVersion: manifest.version,
      migratedAt,
      contractDigest: digestObject(nextContract)
    };
    const nextState = {
      ...state,
      status: "stale",
      updatedAt: migratedAt,
      lastSentinelVerified: false,
      lastSentinelComplete: false,
      migration: {
        kind: "legacy-template-binding",
        fromVersion: manifest.version,
        toVersion: VERSION,
        migratedAt
      }
    };
    const ledgerPath = safeJoin(runDir, "ledger.json");
    if (await pathExists(ledgerPath)) {
      const ledger = await readJson(root, ledgerPath);
      if (ledger.schemaVersion !== 1 || !Array.isArray(nextContract.executionStages)) {
        throw new Error("Legacy binding cannot safely reconcile the execution ledger");
      }
      const expectedTasks = nextContract.executionStages.map((stage) => ({
        id: String(stage.id),
        goal: String(stage.goal ?? stage.description ?? stage.id),
        dependencies: [...(stage.dependsOn ?? stage.dependencies ?? [])].map(String),
        requiredEvidence: [...(stage.requiredEvidence ?? [])].map(String),
        attemptBudget: Number(stage.attemptBudget ?? 3),
        kind: String(stage.kind ?? "regular")
      }));
      if (digestObject(ledger.tasks ?? []) !== digestObject(expectedTasks)) {
        throw new Error("Legacy binding cannot reconcile execution-stage identity drift");
      }
      await atomicWriteJson(root, ledgerPath, {
        ...ledger,
        contractDigest: nextManifest.contractDigest
      });
    }
    await atomicWriteJson(root, contractPath, nextContract);
    await atomicWriteJson(root, manifestPath, nextManifest);
    await atomicWriteJson(root, statePath, nextState);
    await appendJournal(root, runDir, "run.migrated", nextState.migration);
    return {
      migrated: true,
      contract: nextContract,
      manifest: nextManifest,
      state: nextState
    };
  });
}

export async function updateState(root, runId, mutator, event = "state.updated") {
  return withRunLock(root, runId, async ({ runDir }) => {
    const target = safeJoin(runDir, "state.json");
    const current = await readJson(root, target);
    assertMutableRun({ state: current }, "Run state");
    const next = await mutator(structuredClone(current));
    if (!RUN_STATES.has(next.status)) throw new Error(`Invalid run state: ${next.status}`);
    await assertNoPendingProviderExecution(root, runId, runDir, next.status);
    next.updatedAt = nowIso();
    await atomicWriteJson(root, target, next);
    await appendJournal(root, runDir, event, { from: current.status, to: next.status });
    return next;
  });
}

export async function rebindSourceBinding(root, runId, reason) {
  const normalizedReason = String(reason ?? "").trim();
  if (!normalizedReason || normalizedReason.length > 512 || /[\0\r\n]/.test(normalizedReason)) {
    throw new Error("Source binding rebind requires a concise reason without newlines");
  }
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Source binding rebind");
    const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
    if (actions.length > 0 || (run.state.sideEffects ?? []).length > 0) {
      throw new Error("Source binding rebind is only allowed before side effects are issued");
    }
    const readOptionalDirectory = async (target) => readdir(target, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const packageEntries = await readOptionalDirectory(safeJoin(runDir, "review-packages"));
    const reviewFindingEntries = await readOptionalDirectory(safeJoin(runDir, "review-findings"));
    const findingEntries = await readOptionalDirectory(safeJoin(runDir, "findings"));
    if (
      packageEntries.some((entry) => entry.isFile()) ||
      reviewFindingEntries.some((entry) => entry.isFile()) ||
      findingEntries.some((entry) => entry.isFile())
    ) {
      throw new Error("Source binding rebind is only allowed before independent review begins");
    }
    const { captureSourceBinding } = await import("./git.mjs");
    const current = await captureSourceBinding(run.manifest.cwd, {
      baseRevision: run.manifest.sourceBinding?.baseRevision ?? run.contract.remoteRevision ?? null,
      requireClean: true
    });
    if (!current) throw new Error("Source binding is unavailable for this workspace");
    if (current.digest === run.manifest.sourceBinding?.digest) {
      return { ok: true, rebound: false, sourceBinding: current, state: run.state };
    }
    const reboundAt = nowIso();
    const nextManifest = {
      ...run.manifest,
      sourceBinding: current,
      ...(run.contract.autonomyProfile
        ? {
            autonomyProfile: {
              ...run.manifest.autonomyProfile,
              sourceBindingDigest: current.digest,
              sourceHeadRevision: current.headRevision
            }
          }
        : {}),
      sourceBindingHistory: [
        ...(Array.isArray(run.manifest.sourceBindingHistory) ? run.manifest.sourceBindingHistory : []),
        {
          from: run.manifest.sourceBinding?.digest ?? null,
          to: current.digest,
          headRevision: current.headRevision,
          reason: normalizedReason,
          at: reboundAt
        }
      ],
      updatedAt: reboundAt
    };
    const evidence = await listJsonRecords(root, safeJoin(runDir, "evidence"));
    for (const record of evidence) {
      if (record.status === "complete" && record.stale !== true) {
        const next = {
          ...record,
          stale: true,
          freshnessCheckedAt: reboundAt,
          staleReason: "source-binding-rebound"
        };
        await writeEvidenceFreshnessTransition(root, runDir, record, next, {
          kind: "source-binding-rebound",
          from: run.manifest.sourceBinding?.digest ?? null,
          to: current.digest,
          headRevision: current.headRevision,
          reason: normalizedReason
        });
      }
    }
    if (run.contract.schemaVersion === 2 && run.contract.controlPlane?.ledgerPolicy === "ledger-v1") {
      const { initializeLedger } = await import("./ledger.mjs");
      await initializeLedger(root, runDir, run.contract, runId);
    }
    const nextState = {
      ...run.state,
      status: "running",
      lastSentinel: null,
      lastSentinelVerified: false,
      lastSentinelComplete: false,
      ...(run.contract.autonomyProfile
        ? {
            autonomy: {
              ...run.state.autonomy,
              status: "blocked",
              snapshot: null,
              blockedReason: "source-binding-drift",
              requiredAuthority: "autonomy.preflight",
              resumeFromStage: "preflight"
            }
          }
        : {}),
      sourceBindingReboundAt: reboundAt,
      updatedAt: reboundAt
    };
    await atomicWriteJson(root, safeJoin(runDir, "manifest.json"), nextManifest);
    await atomicWriteJson(root, safeJoin(runDir, "state.json"), nextState);
    await appendJournal(root, runDir, "source-binding.rebound", {
      from: run.manifest.sourceBinding?.digest ?? null,
      to: current.digest,
      headRevision: current.headRevision,
      reason: normalizedReason
    });
    return { ok: true, rebound: true, sourceBinding: current, state: nextState };
  });
}

export function assertMutableRun(run, operation = "Run mutation") {
  const status = run?.state?.status ?? run?.status;
  if (TERMINAL_RUN_STATES.has(status)) {
    throw new Error(`${operation} cannot mutate a terminal run`);
  }
}

async function assertNoPendingProviderExecution(root, runId, runDir, nextStatus) {
  if (!TERMINAL_RUN_STATES.has(nextStatus)) return;
  const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
  const pending = actions.find((action) => (
    action.status === "spent" &&
    ["pending", "unknown"].includes(action.outcome) &&
    EXECUTABLE_ACTION_PROVIDERS.has(`${action.action}:${action.provider}`)
  ));
  if (pending) {
    throw new Error(`Run status transition blocked while provider action ${pending.attemptId ?? pending.tokenHash} is pending reconciliation`);
  }
}

export async function setRunStatus(root, runId, status, details = {}) {
  if (!RUN_STATES.has(status)) throw new Error(`Invalid run state: ${status}`);
  return updateState(
    root,
    runId,
    (state) => Object.assign(state, details, { status }),
    "run.status"
  );
}

export async function completeRun(root, runId, completionDecision) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const target = safeJoin(runDir, "state.json");
    const current = await readJson(root, target);
    assertMutableRun({ state: current }, "Run completion");
    const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
    const contract = await readJson(root, safeJoin(runDir, "contract.json"));
    const { captureSentinel } = await import("./git.mjs");
    const freshSentinel = await captureSentinel(manifest.cwd, contract, await loadDefaults());
    if (!freshSentinel.complete || freshSentinel.digest !== current.lastSentinel?.digest) {
      const next = {
        ...current,
        status: "inconclusive",
        lastSentinelVerified: false,
        lastSentinelComplete: false,
        completionBlockers: [
          ...(freshSentinel.complete ? [] : ["bounded-sentinel-incomplete"]),
          ...(freshSentinel.digest === current.lastSentinel?.digest ? [] : ["current-sentinel-drift"])
        ],
        sentinelDrift: freshSentinel.digest === current.lastSentinel?.digest
          ? current.sentinelDrift ?? null
          : { label: current.lastSentinel?.label ?? null, digest: freshSentinel.digest }
      };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "run.status", { from: current.status, to: next.status });
      return { ok: false, status: next.status, blockers: next.completionBlockers, state: next };
    }
    const result = await evaluateCompletion(root, runId);
    if (!result.ok) {
      const next = {
        ...current,
        status: "inconclusive",
        completionBlockers: result.blockers,
        updatedAt: nowIso()
      };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "run.status", { from: current.status, to: next.status });
      return { ok: false, status: next.status, blockers: result.blockers, state: next };
    }
    const terminalSentinel = await captureSentinel(manifest.cwd, contract, await loadDefaults());
    if (!terminalSentinel.complete || terminalSentinel.digest !== freshSentinel.digest) {
      const blockers = [
        ...(terminalSentinel.complete ? [] : ["bounded-sentinel-incomplete"]),
        ...(terminalSentinel.digest === freshSentinel.digest ? [] : ["current-sentinel-drift"])
      ];
      const next = {
        ...current,
        status: "inconclusive",
        lastSentinelVerified: false,
        lastSentinelComplete: false,
        completionBlockers: blockers,
        sentinelDrift: { label: current.lastSentinel?.label ?? null, digest: terminalSentinel.digest }
      };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "run.status", { from: current.status, to: next.status });
      return { ok: false, status: next.status, blockers, state: next };
    }
    const terminalResult = await evaluateCompletion(root, runId);
    if (!terminalResult.ok) {
      const next = {
        ...current,
        status: "inconclusive",
        completionBlockers: terminalResult.blockers,
        updatedAt: nowIso()
      };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "run.status", { from: current.status, to: next.status });
      return { ok: false, status: next.status, blockers: terminalResult.blockers, state: next };
    }
    const reviewDigest = contract.schemaVersion === 2 && contract.controlPlane?.reviewPolicy !== "none"
      ? digestObject(await (async () => {
        const { reviewStatus } = await import("./review.mjs");
        return reviewStatus(root, runId);
      })())
      : null;
    const finalWriteSentinel = await captureSentinel(manifest.cwd, contract, await loadDefaults());
    if (!finalWriteSentinel.complete || finalWriteSentinel.digest !== terminalSentinel.digest) {
      const blockers = [
        ...(finalWriteSentinel.complete ? [] : ["bounded-sentinel-incomplete"]),
        ...(finalWriteSentinel.digest === terminalSentinel.digest ? [] : ["current-sentinel-drift"])
      ];
      const next = {
        ...current,
        status: "inconclusive",
        lastSentinelVerified: false,
        lastSentinelComplete: false,
        completionBlockers: blockers,
        sentinelDrift: { label: current.lastSentinel?.label ?? null, digest: finalWriteSentinel.digest }
      };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "run.status", { from: current.status, to: next.status });
      return { ok: false, status: next.status, blockers, state: next };
    }
    const finalDecision = {
      ...completionDecision,
      evaluatedAt: nowIso(),
      evidenceDigest: digestObject(terminalResult.evidence.map((item) => ({
        id: item.id,
        kind: item.kind,
        sourceDigest: item.sourceDigest,
        stale: item.stale === true
      }))),
      evidenceSupersessionDigest: digestObject(terminalResult.evidenceSupersessions ?? []),
      ledgerDigest: contract.schemaVersion === 2
        ? digestObject(await readJson(root, safeJoin(runDir, "ledger.json")))
        : null,
      reviewDigest,
      sentinelDigest: finalWriteSentinel.digest
    };
    await assertNoPendingProviderExecution(root, runId, runDir, "completed");
    const next = {
      ...current,
      status: "completed",
      completedAt: finalDecision.evaluatedAt,
      completionBlockers: [],
      completionDecision: finalDecision,
      updatedAt: nowIso()
    };
    await atomicWriteJson(root, target, next);
    await appendJournal(root, runDir, "run.status", { from: current.status, to: next.status });
    return { ok: true, state: next };
  });
}

function validateRecordId(id, kind) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) throw new Error(`Invalid ${kind} id`);
}

export async function addEvidence(root, runId, record) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const boundRun = await loadRun(root, runId);
    assertMutableRun(boundRun, "Evidence");
    if (boundRun.contract.schemaVersion === 2) {
      await listIdentityBoundJsonRecords(root, safeJoin(runDir, "evidence"), "Evidence");
    }
    const admitted = boundRun.contract.schemaVersion === 2
      ? await (await import("./evidence.mjs")).admitTypedEvidence(record, { ...boundRun, root, requireReconciled: false })
      : record;
    validateRecordId(admitted.id, "evidence");
    if (admitted.status !== "complete") throw new Error("Evidence status must be complete");
    if (typeof admitted.kind !== "string" || typeof admitted.summary !== "string") {
      throw new Error("Evidence kind and summary are required");
    }
    if (!Array.isArray(admitted.acceptanceIds)) throw new Error("Evidence acceptanceIds must be an array");
    if (typeof admitted.sourceDigest !== "string" || admitted.sourceDigest.length < 16) {
      throw new Error("Evidence sourceDigest is required");
    }
    const target = safeJoin(runDir, "evidence", `${admitted.id}.json`);
    if (await pathExists(target)) throw new Error(`Evidence already exists: ${record.id}`);
    const value = {
      schemaVersion: 1,
      stale: false,
      createdAt: nowIso(),
      dependencies: {},
      producer: {},
      ...admitted
    };
    await atomicWriteJson(root, target, value);
    await appendJournal(root, runDir, "evidence.added", {
      evidenceId: admitted.id,
      evidenceDigest: digestObject(value),
      immutableEvidenceDigest: digestObject(evidenceImmutableProjection(value))
    });
    return value;
  });
}

function validateFinding(record) {
  validateRecordId(record.id, "finding");
  if (!["P0", "P1", "P2"].includes(record.severity)) throw new Error("Finding severity is invalid");
  if (!FINDING_STATES.has(record.status)) throw new Error("Finding status is invalid");
  if (typeof record.summary !== "string" || !record.summary.trim()) {
    throw new Error("Finding summary is required");
  }
  if (record.status === "accepted-risk") {
    if (record.severity === "P0") throw new Error("P0 findings cannot be accepted as risk");
    if (!record.owner || !record.reason || !record.expiry) {
      throw new Error("Accepted risk requires owner, reason, and expiry");
    }
    if (Date.parse(record.expiry) <= Date.now()) throw new Error("Accepted risk expiry must be in the future");
  }
  if (["resolved", "rejected-with-evidence"].includes(record.status) && !record.evidenceId) {
    throw new Error("Resolved or rejected findings require evidenceId");
  }
  return record;
}

async function assertFindingEvidence(root, run, runDir, record) {
  if (!["resolved", "rejected-with-evidence"].includes(record.status)) return;
  if (run.contract.schemaVersion !== 2) {
    throw new Error("Resolved or rejected findings require typed evidence");
  }
  const evidence = (await listEffectiveEvidenceRecords(root, run.manifest.runId, { run })).find(
    (item) => item.id === record.evidenceId
  );
  if (
    !evidence ||
    evidence.schemaVersion !== 2 ||
    evidence.stale === true ||
    !evidence.typedAdmission
  ) {
    throw new Error("Finding disposition requires current typed evidence");
  }
  const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
  await validateTypedEvidenceRecord(evidence, {
    manifest: run.manifest,
    contract: run.contract,
    root,
    runDir,
    requireReconciled: true
  });
  const payload = evidence.receipt?.payload;
  if (!Array.isArray(payload?.findingIds) || !payload.findingIds.includes(record.id)) {
    throw new Error("Finding disposition evidence is not bound to the finding");
  }
}

export async function addFinding(root, runId, record, { update = false } = {}) {
  validateFinding(record);
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Finding");
    await assertFindingEvidence(root, run, runDir, record);
    const target = safeJoin(runDir, "findings", `${record.id}.json`);
    const exists = await pathExists(target);
    if (exists && !update) throw new Error(`Finding already exists: ${record.id}`);
    if (!exists && update) throw new Error(`Finding does not exist: ${record.id}`);
    const value = {
      schemaVersion: 1,
      createdAt: exists ? (await readJson(root, target)).createdAt : nowIso(),
      updatedAt: nowIso(),
      ...record
    };
    await atomicWriteJson(root, target, value);
    await appendJournal(root, runDir, update ? "finding.updated" : "finding.added", {
      findingId: record.id,
      status: record.status
    });
    return value;
  });
}

export async function listJsonRecords(root, directory) {
  if (!(await pathExists(directory))) return [];
  await assertNoSymlinkUnder(root, directory);
  const entries = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(entries.map((name) => readJson(root, safeJoin(directory, name))));
}

async function listIdentityBoundJsonRecords(root, directory, label) {
  if (!(await pathExists(directory))) return [];
  await assertNoSymlinkUnder(root, directory);
  const entries = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const records = await Promise.all(entries.map(async (name) => ({
    name,
    record: await readJson(root, safeJoin(directory, name))
  })));
  const ids = new Set();
  for (const { record } of records) {
    validateRecordId(record?.id, label.toLowerCase());
    if (ids.has(record.id)) throw new Error(`${label} record id is duplicated: ${record.id}`);
    ids.add(record.id);
  }
  for (const { name, record } of records) {
    if (name !== `${record.id}.json`) {
      throw new Error(`${label} filename does not match record id: ${name}`);
    }
  }
  return records.map(({ record }) => record);
}

const EVIDENCE_SUPERSESSION_SCHEMA_VERSION = 1;
const EVIDENCE_SUPERSESSION_KEYS = new Set([
  "schemaVersion",
  "id",
  "runId",
  "supersededEvidence",
  "replacementEvidence",
  "action",
  "contractDigest",
  "sourceBindingDigest",
  "policyDigest",
  "reason",
  "actor",
  "createdAt"
]);
const EVIDENCE_SUPERSESSION_INPUT_KEYS = new Set([
  "schemaVersion",
  "id",
  "supersededEvidenceId",
  "supersededEvidenceDigest",
  "replacementEvidenceId",
  "replacementEvidenceDigest",
  "actionAttemptId",
  "reason"
]);
const EVIDENCE_SUPERSESSION_ACTION_KEYS = new Set([
  "attemptId",
  "action",
  "provider",
  "resource",
  "idempotencyKey",
  "remoteRevision",
  "providerExecutionId"
]);
const EVIDENCE_DEPENDENCY_KEYS = new Set([
  "contractDigest",
  "workflowVersion",
  "files",
  "sourceBindingDigest",
  "sourceSentinelDigest",
  "policyDigest",
  "promptDigest",
  "model",
  "reviewBinding",
  "remoteRevision"
]);
const EVIDENCE_FRESHNESS_EVENT = "evidence.freshness-transition";
const EVIDENCE_FRESHNESS_PROTOCOL_VERSION = 2;
const EVIDENCE_INVALIDATION_PARENT_SCHEMA_VERSION = 1;

function assertExactObjectKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`${label} keys are invalid`);
  }
}

function actionProofIdentity(record) {
  const proof = record?.receipt?.payload?.actionProof;
  if (!proof || proof.schemaVersion !== 1) {
    throw new Error("Evidence supersession requires a provider action proof");
  }
  return {
    attemptId: proof.actionAttemptId,
    action: proof.action,
    provider: proof.provider,
    resource: proof.resource,
    idempotencyKey: proof.idempotencyKey,
    remoteRevision: proof.remoteRevision,
    providerExecutionId: proof.providerExecutionId
  };
}

function canonicalEvidencePolicyDigest(contract) {
  return digestObject({
    authority: contract.authority,
    sensitivity: contract.sensitivity,
    volatileExclusions: contract.volatileExclusions,
    highRiskIgnored: contract.highRiskIgnored
  });
}

function evidenceImmutableProjection(record) {
  const projection = structuredClone(record);
  delete projection.stale;
  delete projection.freshnessCheckedAt;
  delete projection.currentDependencyFiles;
  delete projection.staleReason;
  return projection;
}

function evidenceFreshnessState(record) {
  return {
    stale: record.stale === true,
    freshnessCheckedAt: record.freshnessCheckedAt ?? null,
    currentDependencyFiles: record.currentDependencyFiles ?? null,
    staleReason: record.staleReason ?? null
  };
}

function evidenceFreshnessPatch(record) {
  const currentDependencyFilesPresent = Object.hasOwn(record, "currentDependencyFiles");
  const staleReasonPresent = Object.hasOwn(record, "staleReason");
  return {
    stale: record.stale === true,
    freshnessCheckedAt: Object.hasOwn(record, "freshnessCheckedAt")
      ? record.freshnessCheckedAt
      : null,
    currentDependencyFilesPresent,
    currentDependencyFiles: currentDependencyFilesPresent
      ? structuredClone(record.currentDependencyFiles)
      : null,
    staleReasonPresent,
    staleReason: staleReasonPresent ? record.staleReason : null
  };
}

function applyEvidenceFreshnessPatch(record, patch) {
  assertExactObjectKeys(
    patch,
    new Set([
      "stale",
      "freshnessCheckedAt",
      "currentDependencyFilesPresent",
      "currentDependencyFiles",
      "staleReasonPresent",
      "staleReason"
    ]),
    "Evidence freshness patch"
  );
  if (
    typeof patch.stale !== "boolean" ||
    (patch.freshnessCheckedAt !== null && (
      typeof patch.freshnessCheckedAt !== "string" ||
      !Number.isFinite(Date.parse(patch.freshnessCheckedAt))
    )) ||
    typeof patch.currentDependencyFilesPresent !== "boolean" ||
    (patch.currentDependencyFilesPresent
      ? !Array.isArray(patch.currentDependencyFiles)
      : patch.currentDependencyFiles !== null) ||
    typeof patch.staleReasonPresent !== "boolean" ||
    (patch.staleReasonPresent
      ? typeof patch.staleReason !== "string" || patch.staleReason.length === 0
      : patch.staleReason !== null)
  ) {
    throw new Error("Evidence freshness patch is invalid");
  }
  const next = evidenceImmutableProjection(record);
  next.stale = patch.stale;
  if (patch.freshnessCheckedAt !== null) next.freshnessCheckedAt = patch.freshnessCheckedAt;
  if (patch.currentDependencyFilesPresent) {
    next.currentDependencyFiles = structuredClone(patch.currentDependencyFiles);
  }
  if (patch.staleReasonPresent) next.staleReason = patch.staleReason;
  return next;
}

function evidenceFreshnessTransitionBinding(recordId, entry) {
  const binding = {
    evidenceId: recordId,
    previousEvidenceDigest: entry.previousEvidenceDigest,
    evidenceDigest: entry.evidenceDigest,
    immutableEvidenceDigest: entry.immutableEvidenceDigest,
    freshnessState: entry.freshnessState,
    cause: entry.cause
  };
  if (entry.protocolVersion === EVIDENCE_FRESHNESS_PROTOCOL_VERSION) {
    return {
      protocolVersion: EVIDENCE_FRESHNESS_PROTOCOL_VERSION,
      ...binding,
      freshnessPatch: entry.freshnessPatch
    };
  }
  if (entry.protocolVersion !== undefined) {
    throw new Error(`Evidence freshness protocol is unsupported: ${recordId}`);
  }
  return binding;
}

function evidenceAdmissionJournalBinding(record, journal, { allowPending = false } = {}) {
  const added = journal.filter((entry) => entry.event === "evidence.added" && entry.evidenceId === record.id);
  if (
    added.length !== 1 ||
    !SHA256_DIGEST.test(added[0].evidenceDigest ?? "") ||
    !SHA256_DIGEST.test(added[0].immutableEvidenceDigest ?? "")
  ) {
    throw new Error(`Evidence admission journal binding is missing or ambiguous: ${record.id}`);
  }
  const immutableEvidenceDigest = digestObject(evidenceImmutableProjection(record));
  if (added[0].immutableEvidenceDigest !== immutableEvidenceDigest) {
    throw new Error(`Evidence immutable admission binding changed: ${record.id}`);
  }
  let headDigest = added[0].evidenceDigest;
  let lastTransition = null;
  const transitions = journal.filter((candidate) => (
    candidate.event === EVIDENCE_FRESHNESS_EVENT && candidate.evidenceId === record.id
  ));
  for (const entry of transitions) {
    const transitionBinding = evidenceFreshnessTransitionBinding(record.id, entry);
    if (
      entry.previousEvidenceDigest !== headDigest ||
      !SHA256_DIGEST.test(entry.evidenceDigest ?? "") ||
      entry.immutableEvidenceDigest !== immutableEvidenceDigest ||
      entry.transitionDigest !== digestObject(transitionBinding)
    ) {
      throw new Error(`Evidence freshness journal chain is invalid: ${record.id}`);
    }
    if (
      entry.protocolVersion === EVIDENCE_FRESHNESS_PROTOCOL_VERSION &&
      digestObject(applyEvidenceFreshnessPatch(record, entry.freshnessPatch)) !== entry.evidenceDigest
    ) {
      throw new Error(`Evidence freshness patch does not reproduce the journal digest: ${record.id}`);
    }
    headDigest = entry.evidenceDigest;
    lastTransition = entry;
  }
  const recordDigest = digestObject(record);
  let pendingTransition = null;
  if (
    headDigest !== recordDigest &&
    allowPending &&
    lastTransition?.protocolVersion === EVIDENCE_FRESHNESS_PROTOCOL_VERSION &&
    lastTransition.previousEvidenceDigest === recordDigest
  ) {
    pendingTransition = lastTransition;
  } else if (headDigest !== recordDigest) {
    throw new Error(`Evidence bytes do not match the append-only freshness journal: ${record.id}`);
  }
  return {
    immutableEvidenceDigest,
    headDigest: pendingTransition ? recordDigest : headDigest,
    lastTransition: pendingTransition ? transitions.at(-2) ?? null : lastTransition,
    pendingTransition
  };
}

function sameEvidenceFreshnessSemantics(left, right) {
  return digestObject({
    stale: left.stale === true,
    currentDependencyFiles: left.currentDependencyFiles ?? null,
    staleReason: left.staleReason ?? null
  }) === digestObject({
    stale: right.stale === true,
    currentDependencyFiles: right.currentDependencyFiles ?? null,
    staleReason: right.staleReason ?? null
  });
}

async function writeEvidenceFreshnessTransition(
  root,
  runDir,
  current,
  next,
  cause,
  { onPrepared = null } = {}
) {
  const journal = await readJournalRecords(root, runDir);
  const binding = evidenceAdmissionJournalBinding(current, journal, { allowPending: true });
  if (binding.pendingTransition) {
    const pending = binding.pendingTransition;
    if (
      digestObject(pending.cause) !== digestObject(cause) ||
      pending.immutableEvidenceDigest !== binding.immutableEvidenceDigest
    ) {
      throw new Error(`Evidence freshness transition has a conflicting pending intent: ${current.id}`);
    }
    const recovered = applyEvidenceFreshnessPatch(current, pending.freshnessPatch);
    if (digestObject(recovered) !== pending.evidenceDigest) {
      throw new Error(`Evidence freshness pending transition cannot be recovered: ${current.id}`);
    }
    await atomicWriteJson(root, safeJoin(runDir, "evidence", `${current.id}.json`), recovered);
    if (!sameEvidenceFreshnessSemantics(recovered, next)) {
      return writeEvidenceFreshnessTransition(root, runDir, recovered, next, cause);
    }
    return { record: recovered, transition: pending, recovered: true };
  }
  const immutableEvidenceDigest = digestObject(evidenceImmutableProjection(next));
  if (immutableEvidenceDigest !== binding.immutableEvidenceDigest) {
    throw new Error(`Evidence freshness transition attempted to mutate admitted bytes: ${current.id}`);
  }
  const freshnessPatch = evidenceFreshnessPatch(next);
  const canonicalNext = applyEvidenceFreshnessPatch(current, freshnessPatch);
  const transitionBinding = {
    protocolVersion: EVIDENCE_FRESHNESS_PROTOCOL_VERSION,
    evidenceId: current.id,
    previousEvidenceDigest: digestObject(current),
    evidenceDigest: digestObject(canonicalNext),
    immutableEvidenceDigest,
    freshnessState: evidenceFreshnessState(canonicalNext),
    cause,
    freshnessPatch
  };
  const transition = await appendJournal(root, runDir, EVIDENCE_FRESHNESS_EVENT, {
    ...transitionBinding,
    transitionDigest: digestObject(transitionBinding)
  });
  if (onPrepared) await onPrepared(transition);
  await atomicWriteJson(root, safeJoin(runDir, "evidence", `${current.id}.json`), canonicalNext);
  return { record: canonicalNext, transition, recovered: false };
}

async function assertEvidenceSupersessionIdentity(run, target, replacement) {
  if (
    target.kind !== "provider-reconciliation" ||
    replacement.kind !== "provider-reconciliation" ||
    target.schemaVersion !== 2 ||
    replacement.schemaVersion !== 2 ||
    !target.typedAdmission ||
    !replacement.typedAdmission ||
    target.status !== "complete" ||
    replacement.status !== "complete" ||
    target.stale === true ||
    replacement.stale === true
  ) {
    throw new Error("Evidence supersession only supports current typed provider-reconciliation records");
  }
  const targetIdentity = actionProofIdentity(target);
  const replacementIdentity = actionProofIdentity(replacement);
  if (
    !SAFE_ID.test(String(replacementIdentity.attemptId ?? "")) ||
    Object.values(replacementIdentity).some((value) => typeof value !== "string" || !value)
  ) {
    throw new Error("Evidence supersession provider action identity is incomplete");
  }
  if (digestObject(targetIdentity) !== digestObject(replacementIdentity)) {
    throw new Error("Evidence supersession requires the same provider action attempt");
  }
  if (
    targetIdentity.remoteRevision !== (run.contract.remoteRevision ?? null) ||
    target.receipt?.inputBinding?.remoteRevision !== (run.contract.remoteRevision ?? null) ||
    replacement.receipt?.inputBinding?.remoteRevision !== (run.contract.remoteRevision ?? null)
  ) {
    throw new Error("Evidence supersession provider action remote revision is stale");
  }
  for (const [label, record] of [["target", target], ["replacement", replacement]]) {
    assertExactObjectKeys(record.dependencies, EVIDENCE_DEPENDENCY_KEYS, `Evidence supersession ${label} dependencies`);
  }
  if (digestObject(target.dependencies) !== digestObject(replacement.dependencies)) {
    throw new Error("Evidence supersession source or policy binding changed");
  }
  if ([target, replacement].some((record) => (
    record.dependencies.promptDigest !== null ||
    record.dependencies.model !== null ||
    record.dependencies.reviewBinding !== null
  ))) {
    throw new Error("Evidence supersession provider reconciliation dependencies are not canonical");
  }
  if (
    target.typedAdmission.contractId !== replacement.typedAdmission.contractId ||
    target.typedAdmission.contractVersion !== replacement.typedAdmission.contractVersion ||
    target.typedAdmission.producer !== replacement.typedAdmission.producer ||
    digestObject(target.receipt?.producer ?? null) !== digestObject(replacement.receipt?.producer ?? null) ||
    digestObject(target.receipt?.inputBinding ?? null) !== digestObject(replacement.receipt?.inputBinding ?? null) ||
    digestObject(target.dependencyInputs ?? null) !== digestObject(replacement.dependencyInputs ?? null)
  ) {
    throw new Error("Evidence supersession admission provenance changed");
  }
  if (
    !SHA256_DIGEST.test(target.dependencies?.contractDigest ?? "") ||
    !SHA256_DIGEST.test(target.dependencies?.policyDigest ?? "") ||
    target.dependencies?.workflowVersion !== VERSION ||
    target.dependencies?.remoteRevision !== targetIdentity.remoteRevision ||
    (
      target.dependencies?.sourceBindingDigest !== null &&
      !SHA256_DIGEST.test(target.dependencies?.sourceBindingDigest ?? "")
    )
  ) {
    throw new Error("Evidence supersession requires complete current source and policy dependencies");
  }
  for (const [label, record] of [["target", target], ["replacement", replacement]]) {
    const freshness = await currentEvidenceFreshness(run, record);
    if (freshness.stale || digestObject(record.dependencies) !== digestObject(freshness.expectedDependencies)) {
      throw new Error(`Evidence supersession ${label} is not bound to the current canonical dependency projection`);
    }
  }
  return replacementIdentity;
}

async function fingerprintEvidenceDependency(cwd, candidate) {
  const absolute = path.resolve(cwd, candidate);
  const relative = path.relative(cwd, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Evidence dependency escapes workspace: ${candidate}`);
  }
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      return { path: relative || ".", type: "symlink", target: await readlink(absolute), mode: info.mode };
    }
    if (!info.isFile()) {
      return {
        path: relative || ".",
        type: info.isDirectory() ? "directory" : "other",
        mode: info.mode,
        mtimeMs: Math.trunc(info.mtimeMs)
      };
    }
    const contents = await readFile(absolute);
    return {
      path: relative || ".",
      type: "file",
      mode: info.mode,
      size: info.size,
      digest: sha256(contents)
    };
  } catch (error) {
    if (error.code === "ENOENT") return { path: relative || ".", type: "missing" };
    throw error;
  }
}

async function currentEvidenceFreshness(run, record) {
  const { loadEvidenceContracts } = await import("./evidence.mjs");
  const contracts = await loadEvidenceContracts();
  const sourceKind = record.sourceKind ?? record.kind;
  const kind = sourceKind === "independent-critic" || sourceKind === "evaluation-migration"
    ? (sourceKind === "independent-critic" ? "patch-review" : "evaluation-suite")
    : sourceKind;
  const definition = contracts[kind];
  const sourceBindingRequired = definition?.freshnessBinding?.includes("sourceBindingDigest") === true;
  const sourceSentinelRequired = definition?.freshnessBinding?.includes("sourceSentinelDigest") === true;
  let sourceBinding = null;
  if (sourceBindingRequired && run.manifest.sourceBinding) {
    const { captureSourceBinding } = await import("./git.mjs");
    sourceBinding = await captureSourceBinding(run.manifest.cwd, {
      baseRevision: run.manifest.sourceBinding.baseRevision,
      requireClean: run.manifest.template === "self-improve-ops"
    });
  }
  const inputBinding = record.receipt?.inputBinding;
  const dependencyInputsValid = Boolean(
    record.dependencyInputs &&
    typeof record.dependencyInputs === "object" &&
    !Array.isArray(record.dependencyInputs) &&
    Object.keys(record.dependencyInputs).length === 1 &&
    Object.hasOwn(record.dependencyInputs, "files") &&
    Array.isArray(record.dependencyInputs.files) &&
    record.dependencyInputs.files.every((candidate) => typeof candidate === "string" && candidate.length > 0)
  );
  let stale =
    run.manifest.contractDigest !== digestObject(run.contract) ||
    record.dependencies?.contractDigest !== run.manifest.contractDigest ||
    record.dependencies?.workflowVersion !== VERSION ||
    (sourceBindingRequired && (!sourceBinding || record.dependencies?.sourceBindingDigest !== sourceBinding.digest)) ||
    (!sourceBindingRequired && (record.dependencies?.sourceBindingDigest ?? null) !== null) ||
    (sourceSentinelRequired && record.dependencies?.sourceSentinelDigest !== run.state.lastSentinel?.digest) ||
    (!sourceSentinelRequired && (record.dependencies?.sourceSentinelDigest ?? null) !== null) ||
    (record.schemaVersion === 2 && (
      record.dependencies?.policyDigest !== canonicalEvidencePolicyDigest(run.contract) ||
      (record.dependencies?.remoteRevision ?? null) !== (run.contract.remoteRevision ?? null) ||
      !inputBinding ||
      inputBinding.runId !== run.manifest.runId ||
      inputBinding.contractDigest !== digestObject(run.contract) ||
      (inputBinding.remoteRevision ?? null) !== (run.contract.remoteRevision ?? null)
    ));
  if (!dependencyInputsValid) {
    return {
      stale: true,
      currentDependencyFiles: [],
      expectedDependencies: null,
      projectionDigest: digestObject({ invalidDependencyInputs: true })
    };
  }
  const current = [];
  for (const candidate of record.dependencyInputs.files) {
    current.push(await fingerprintEvidenceDependency(run.manifest.cwd, candidate));
  }
  if (digestObject(current) !== digestObject(record.dependencies?.files ?? [])) stale = true;
  const canonicalReviewDependencies = kind === "provider-reconciliation"
    ? { promptDigest: null, model: null, reviewBinding: null }
    : {
        promptDigest: record.dependencies?.promptDigest ?? null,
        model: record.dependencies?.model ?? null,
        reviewBinding: record.dependencies?.reviewBinding ?? null
      };
  const expectedDependencies = {
    contractDigest: run.manifest.contractDigest,
    workflowVersion: VERSION,
    files: current,
    sourceBindingDigest: sourceBindingRequired ? run.manifest.sourceBinding?.digest ?? null : null,
    sourceSentinelDigest: sourceSentinelRequired ? run.state.lastSentinel?.digest ?? null : null,
    policyDigest: canonicalEvidencePolicyDigest(run.contract),
    ...canonicalReviewDependencies,
    remoteRevision: run.contract.remoteRevision ?? null
  };
  if (digestObject(record.dependencies ?? null) !== digestObject(expectedDependencies)) stale = true;
  const projectionDigest = digestObject({
    dependencyInputs: record.dependencyInputs,
    expectedDependencies,
    currentSourceBindingDigest: sourceBinding?.digest ?? null
  });
  return { stale, currentDependencyFiles: current, expectedDependencies, projectionDigest };
}

export async function assertCurrentEvidenceFreshness(run, record, context = "Evidence") {
  const freshness = await currentEvidenceFreshness(run, record);
  if (freshness.stale) {
    throw new Error(`${context} is stale: ${record?.id ?? "unknown"}`);
  }
  return freshness;
}

function autonomousInvalidationChildren(journal, attemptId, recordsById = null) {
  const transitions = journal.filter((entry) => (
    entry.event === EVIDENCE_FRESHNESS_EVENT &&
    entry.protocolVersion === EVIDENCE_FRESHNESS_PROTOCOL_VERSION &&
    entry.cause?.kind === "autonomous-commit-reconciled" &&
    entry.cause.actionAttemptId === attemptId
  ));
  const children = transitions.map((entry) => {
    if (recordsById && !recordsById.has(entry.evidenceId)) {
      throw new Error(`Evidence invalidation journal references missing evidence: ${entry.evidenceId}`);
    }
    if (
      !SHA256_DIGEST.test(entry.evidenceDigest ?? "") ||
      !SHA256_DIGEST.test(entry.transitionDigest ?? "")
    ) {
      throw new Error(`Evidence invalidation child binding is invalid: ${entry.evidenceId ?? "unknown"}`);
    }
    return {
      evidenceId: entry.evidenceId,
      evidenceDigest: entry.evidenceDigest,
      transitionDigest: entry.transitionDigest
    };
  }).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  if (new Set(children.map((child) => child.evidenceId)).size !== children.length) {
    throw new Error(`Evidence invalidation has duplicate child transitions: ${attemptId}`);
  }
  return children;
}

function evidenceInvalidationParentBinding(attemptId, children) {
  return {
    schemaVersion: EVIDENCE_INVALIDATION_PARENT_SCHEMA_VERSION,
    actionAttemptId: attemptId,
    reason: "autonomous-commit-reconciled",
    invalidated: children.length,
    children
  };
}

function validateEvidenceInvalidationParent(journal, attemptId, recordsById = null) {
  const children = autonomousInvalidationChildren(journal, attemptId, recordsById);
  if (children.length === 0) {
    throw new Error(`Evidence invalidation has no bound child transitions: ${attemptId}`);
  }
  const parents = journal.filter((entry) => (
    entry.event === "evidence.invalidated" && entry.actionAttemptId === attemptId
  ));
  if (parents.length !== 1) {
    throw new Error(`Evidence invalidation journal parent is missing or ambiguous: ${attemptId}`);
  }
  const expected = evidenceInvalidationParentBinding(attemptId, children);
  const parent = parents[0];
  if (
    parent.schemaVersion !== expected.schemaVersion ||
    parent.reason !== expected.reason ||
    parent.invalidated !== expected.invalidated ||
    digestObject(parent.children) !== digestObject(expected.children) ||
    parent.invalidationDigest !== digestObject(expected)
  ) {
    throw new Error(`Evidence invalidation journal parent binding is invalid: ${attemptId}`);
  }
  return { parent, children, binding: expected };
}

async function appendEvidenceInvalidationParent(root, runDir, attemptId) {
  const journal = await readJournalRecords(root, runDir);
  const children = autonomousInvalidationChildren(journal, attemptId);
  if (children.length === 0) return null;
  const existing = journal.filter((entry) => (
    entry.event === "evidence.invalidated" && entry.actionAttemptId === attemptId
  ));
  const binding = evidenceInvalidationParentBinding(attemptId, children);
  if (existing.length === 0) {
    return appendJournal(root, runDir, "evidence.invalidated", {
      ...binding,
      invalidationDigest: digestObject(binding)
    });
  }
  return validateEvidenceInvalidationParent(journal, attemptId).parent;
}

async function assertEvidenceJournalProvenance(root, run, records, journal) {
  const bindings = new Map();
  for (const record of records) {
    try {
      bindings.set(record.id, evidenceAdmissionJournalBinding(record, journal));
    } catch (error) {
      const label = record.stale === true ? "stale" : "admission";
      throw new Error(`Evidence ${label} provenance is invalid: ${record.id ?? "unknown"}: ${error.message}`);
    }
  }
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const autonomousInvalidationAttemptIds = new Set([
    ...journal.filter((entry) => (
      entry.event === EVIDENCE_FRESHNESS_EVENT &&
      entry.protocolVersion === EVIDENCE_FRESHNESS_PROTOCOL_VERSION &&
      entry.cause?.kind === "autonomous-commit-reconciled"
    )).map((entry) => entry.cause.actionAttemptId),
    ...journal.filter((entry) => (
      entry.event === "evidence.invalidated" && entry.schemaVersion !== undefined
    )).map((entry) => entry.actionAttemptId)
  ]);
  const invalidationsByAttempt = new Map();
  for (const attemptId of autonomousInvalidationAttemptIds) {
    if (typeof attemptId !== "string" || !SAFE_ID.test(attemptId)) {
      throw new Error("Evidence invalidation action attempt binding is invalid");
    }
    invalidationsByAttempt.set(
      attemptId,
      validateEvidenceInvalidationParent(journal, attemptId, recordsById)
    );
  }
  for (const record of records) {
    if (record.stale !== true) continue;
    let authorized = false;
    const binding = bindings.get(record.id);
    const transition = binding?.lastTransition;
    if (
      transition?.freshnessState?.stale === true &&
      transition.freshnessState.freshnessCheckedAt === record.freshnessCheckedAt &&
      transition.freshnessState.staleReason === (record.staleReason ?? null) &&
      digestObject(transition.freshnessState.currentDependencyFiles) === digestObject(record.currentDependencyFiles ?? null)
    ) {
      if (transition.cause?.kind === "source-binding-rebound") {
        authorized = journal.some((entry) => (
          entry.event === "source-binding.rebound" &&
          entry.from === transition.cause.from &&
          entry.to === transition.cause.to &&
          entry.headRevision === transition.cause.headRevision &&
          entry.reason === transition.cause.reason
        ));
      } else if (transition.cause?.kind === "autonomous-commit-reconciled") {
        if (transition.protocolVersion === EVIDENCE_FRESHNESS_PROTOCOL_VERSION) {
          const invalidation = invalidationsByAttempt.get(transition.cause.actionAttemptId);
          authorized = invalidation.children.some((child) => (
            child.evidenceId === record.id &&
            child.evidenceDigest === transition.evidenceDigest &&
            child.transitionDigest === transition.transitionDigest
          ));
        } else {
          authorized = journal.some((entry) => (
            entry.event === "evidence.invalidated" &&
            entry.schemaVersion === undefined &&
            entry.actionAttemptId === transition.cause.actionAttemptId &&
            entry.reason === "autonomous-commit-reconciled"
          ));
        }
      } else if (transition.cause?.kind === "dependency-refresh") {
        authorized = (await currentEvidenceFreshness(run, record)).stale;
      }
    }
    if (!authorized) {
      throw new Error(`Evidence stale provenance is invalid: ${record.id ?? "unknown"}`);
    }
  }
}

async function validateEvidenceSupersessionRecord(root, run, recordsById, journal, record) {
  assertExactObjectKeys(record, EVIDENCE_SUPERSESSION_KEYS, "Evidence supersession record");
  if (record.schemaVersion !== EVIDENCE_SUPERSESSION_SCHEMA_VERSION) {
    throw new Error("Evidence supersession schemaVersion must be 1");
  }
  validateRecordId(record.id, "evidence supersession");
  if (record.runId !== run.manifest.runId || record.actor !== "root") {
    throw new Error("Evidence supersession run or actor binding is invalid");
  }
  if (typeof record.reason !== "string" || record.reason.trim().length < 12 || record.reason.length > 512) {
    throw new Error("Evidence supersession reason must be 12 to 512 characters");
  }
  if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) {
    throw new Error("Evidence supersession createdAt is invalid");
  }
  for (const [label, binding] of [
    ["superseded", record.supersededEvidence],
    ["replacement", record.replacementEvidence]
  ]) {
    assertExactObjectKeys(binding, new Set(["id", "digest"]), `Evidence supersession ${label} binding`);
    validateRecordId(binding.id, `${label} evidence`);
    if (!SHA256_DIGEST.test(binding.digest)) {
      throw new Error(`Evidence supersession ${label} digest is invalid`);
    }
  }
  if (record.supersededEvidence.id === record.replacementEvidence.id) {
    throw new Error("Evidence supersession target and replacement must differ");
  }
  assertExactObjectKeys(record.action, EVIDENCE_SUPERSESSION_ACTION_KEYS, "Evidence supersession action binding");
  for (const value of Object.values(record.action)) {
    if (typeof value !== "string" || !value) throw new Error("Evidence supersession action binding is incomplete");
  }
  if (
    record.contractDigest !== run.manifest.contractDigest ||
    record.contractDigest !== digestObject(run.contract) ||
    record.sourceBindingDigest !== (run.manifest.sourceBinding?.digest ?? null)
  ) {
    throw new Error("Evidence supersession contract or source binding is stale");
  }
  const target = recordsById.get(record.supersededEvidence.id);
  const replacement = recordsById.get(record.replacementEvidence.id);
  if (!target || !replacement) throw new Error("Evidence supersession target or replacement is missing");
  if (
    digestObject(target) !== record.supersededEvidence.digest ||
    digestObject(replacement) !== record.replacementEvidence.digest
  ) {
    throw new Error("Evidence supersession evidence digest changed");
  }
  const targetCreatedAt = Date.parse(target.createdAt ?? "");
  const replacementCreatedAt = Date.parse(replacement.createdAt ?? "");
  const supersededAt = Date.parse(record.createdAt);
  if (
    !Number.isFinite(targetCreatedAt) ||
    !Number.isFinite(replacementCreatedAt) ||
    targetCreatedAt > replacementCreatedAt ||
    replacementCreatedAt > supersededAt
  ) {
    throw new Error("Evidence supersession chronology is invalid");
  }
  const identity = await assertEvidenceSupersessionIdentity(run, target, replacement);
  if (digestObject(identity) !== digestObject(record.action)) {
    throw new Error("Evidence supersession action binding changed");
  }
  if (
    record.policyDigest !== (replacement.dependencies?.policyDigest ?? null) ||
    record.policyDigest !== (target.dependencies?.policyDigest ?? null)
  ) {
    throw new Error("Evidence supersession policy binding changed");
  }
  const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
  await validateTypedEvidenceRecord(target, {
    manifest: run.manifest,
    contract: run.contract,
    state: run.state,
    requireReconciled: false
  });
  let targetStillValid = true;
  try {
    await validateTypedEvidenceRecord(target, {
      manifest: run.manifest,
      contract: run.contract,
      state: run.state,
      root,
      runDir: run.runDir,
      requireReconciled: true
    });
  } catch {
    targetStillValid = false;
  }
  if (targetStillValid) throw new Error("Evidence supersession cannot replace already-valid evidence");
  await validateTypedEvidenceRecord(replacement, {
    manifest: run.manifest,
    contract: run.contract,
    state: run.state,
    root,
    runDir: run.runDir,
    requireReconciled: true
  });
  const recordDigest = digestObject(record);
  const matchingJournal = journal.filter((entry) => (
    entry.event === "evidence.superseded" &&
    entry.supersessionId === record.id &&
    entry.supersessionDigest === recordDigest &&
    entry.supersededEvidenceId === record.supersededEvidence.id &&
    entry.supersededEvidenceDigest === record.supersededEvidence.digest &&
    entry.replacementEvidenceId === record.replacementEvidence.id &&
    entry.replacementEvidenceDigest === record.replacementEvidence.digest &&
    entry.actionAttemptId === record.action.attemptId &&
    typeof entry.at === "string" &&
    Date.parse(entry.at) >= supersededAt
  ));
  if (matchingJournal.length !== 1) {
    throw new Error("Evidence supersession journal binding is missing or ambiguous");
  }
  return { record, target, replacement };
}

async function loadEvidenceSupersessions(root, run, records) {
  const directory = safeJoin(run.runDir, "evidence-supersessions");
  const journal = await readJournalRecords(root, run.runDir);
  await assertEvidenceJournalProvenance(root, run, records, journal);
  const supersessions = await listIdentityBoundJsonRecords(root, directory, "Evidence supersession");
  const journalEntries = journal.filter((entry) => entry.event === "evidence.superseded");
  if (supersessions.length === 0 && journalEntries.length === 0) {
    return { records: [], supersededIds: new Set(), journal };
  }
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const validated = [];
  const supersededIds = new Set();
  const replacementIds = new Set();
  for (const supersession of supersessions) {
    const result = await validateEvidenceSupersessionRecord(root, run, recordsById, journal, supersession);
    const targetId = result.record.supersededEvidence.id;
    const replacementId = result.record.replacementEvidence.id;
    if (supersededIds.has(targetId) || replacementIds.has(replacementId)) {
      throw new Error("Evidence supersession is duplicated or conflicting");
    }
    if (replacementIds.has(targetId) || supersededIds.has(replacementId)) {
      throw new Error("Evidence supersession chains or cycles are forbidden");
    }
    supersededIds.add(targetId);
    replacementIds.add(replacementId);
    validated.push(result.record);
  }
  if (journalEntries.length !== validated.length) {
    throw new Error("Evidence supersession journal contains an unbound event");
  }
  return { records: validated, supersededIds, journal };
}

export async function loadEffectiveEvidenceState(root, runId, { run: suppliedRun = null } = {}) {
  const run = suppliedRun ?? await loadRun(root, runId);
  const records = run.contract.schemaVersion === 2
    ? await listIdentityBoundJsonRecords(root, safeJoin(run.runDir, "evidence"), "Evidence")
    : await listJsonRecords(root, safeJoin(run.runDir, "evidence"));
  if (run.contract.schemaVersion !== 2) {
    const journal = await readJournalRecords(root, run.runDir);
    const usesCanonicalFreshnessProtocol = journal.some((entry) => (
      entry.event === EVIDENCE_FRESHNESS_EVENT && entry.protocolVersion !== undefined
    ));
    if (usesCanonicalFreshnessProtocol) {
      await assertEvidenceJournalProvenance(root, run, records, journal);
    }
    return { records, supersessions: [] };
  }
  const { records: supersessions, supersededIds } = await loadEvidenceSupersessions(root, run, records);
  return {
    records: records.filter((record) => !supersededIds.has(record.id)),
    supersessions
  };
}

async function currentEvidenceSupersessionFreshnessDigest(root, run) {
  const evidence = await listIdentityBoundJsonRecords(root, safeJoin(run.runDir, "evidence"), "Evidence");
  const supersessionState = await loadEvidenceSupersessions(root, run, evidence);
  const recordsById = new Map(evidence.map((record) => [record.id, record]));
  const projection = [];
  for (const supersession of supersessionState.records) {
    for (const role of ["supersededEvidence", "replacementEvidence"]) {
      const binding = supersession[role];
      const record = recordsById.get(binding.id);
      const freshness = await currentEvidenceFreshness(run, record);
      if (freshness.stale) {
        throw new Error(`Action token denied by stale immutable supersession evidence: ${record.id}`);
      }
      projection.push({
        supersessionId: supersession.id,
        supersessionDigest: digestObject(supersession),
        role,
        evidenceId: record.id,
        evidenceDigest: digestObject(record),
        freshnessProjectionDigest: freshness.projectionDigest
      });
    }
  }
  return digestObject(projection);
}

export async function currentActionEvidenceGateBinding(root, runId, run, action) {
  const configuredGate = run.contract.actionGates?.[action];
  if (!Array.isArray(configuredGate) || configuredGate.length === 0) {
    throw new Error(`No pre-action evidence gate is defined for: ${action}`);
  }
  const gateKinds = new Set(configuredGate);
  let currentSourceBindingDigest = null;
  if (run.manifest.sourceBinding) {
    const { captureSourceBinding } = await import("./git.mjs");
    const currentSourceBinding = await captureSourceBinding(run.manifest.cwd, {
      baseRevision: run.manifest.sourceBinding.baseRevision,
      requireClean: false
    });
    currentSourceBindingDigest = currentSourceBinding.digest;
  }
  const effective = await loadEffectiveEvidenceState(root, runId, { run });
  const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
  const selected = [];
  for (const record of effective.records.filter((item) => gateKinds.has(item.kind))) {
    if (
      record.schemaVersion !== 2 ||
      !record.typedAdmission ||
      record.status !== "complete" ||
      record.stale === true
    ) continue;
    await validateTypedEvidenceRecord(record, {
      manifest: run.manifest,
      contract: run.contract,
      state: run.state,
      root,
      runDir: run.runDir,
      requireReconciled: true
    });
    const freshness = await assertCurrentEvidenceFreshness(
      run,
      record,
      "Action token configured evidence gate"
    );
    selected.push({
      kind: record.kind,
      evidenceId: record.id,
      evidenceDigest: digestObject(record),
      admissionDigest: digestObject(record.typedAdmission),
      dependencyBindingDigest: digestObject(record.dependencies ?? null),
      expectedDependencyDigest: digestObject(freshness.expectedDependencies),
      currentDependencyFilesDigest: digestObject(freshness.currentDependencyFiles),
      freshnessProjectionDigest: freshness.projectionDigest
    });
  }
  selected.sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.evidenceId.localeCompare(right.evidenceId)
  ));
  const available = new Set(selected.map((item) => item.kind));
  const missing = configuredGate.filter((kind) => !available.has(kind));
  if (missing.length > 0) {
    throw new Error(`Action token missing evidence: ${missing.join(", ")}`);
  }
  const supersessions = [...effective.supersessions]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((record) => ({ id: record.id, digest: digestObject(record) }));
  const projection = {
    schemaVersion: 1,
    runId,
    action,
    configuredGate: [...configuredGate],
    contractDigest: digestObject(run.contract),
    authorityDigest: digestObject(run.contract.authority ?? null),
    policyDigest: canonicalEvidencePolicyDigest(run.contract),
    sourceBindingDigest: run.manifest.sourceBinding?.digest ?? null,
    currentSourceBindingDigest,
    sourceSentinelDigest: run.state.lastSentinel?.digest ?? null,
    remoteRevision: run.contract.remoteRevision ?? null,
    workflowVersion: VERSION,
    effectiveSupersessions: supersessions,
    evidence: selected
  };
  return {
    configuredGate: [...configuredGate],
    digest: digestObject(projection),
    projection
  };
}

export async function assertAutonomousCommitEvidenceInvalidationSafe(
  root,
  runId,
  { run: suppliedRun = null } = {}
) {
  const run = suppliedRun ?? await loadRun(root, runId);
  if (run.contract.schemaVersion !== 2) return { ok: true, supersessionIds: [] };
  const supersessions = await listIdentityBoundJsonRecords(
    root,
    safeJoin(run.runDir, "evidence-supersessions"),
    "Evidence supersession"
  );
  const journal = await readJournalRecords(root, run.runDir);
  const journalIds = journal
    .filter((entry) => entry.event === "evidence.superseded")
    .map((entry) => entry.supersessionId);
  if (supersessions.length === 0 && journalIds.length === 0) {
    return { ok: true, supersessionIds: [] };
  }
  const supersessionIds = [...new Set([
    ...supersessions.map((record) => record.id),
    ...journalIds
  ])].sort();
  throw new Error(
    `Autonomous Git commit reconciliation cannot invalidate supersession-bound evidence without mutating admitted bytes: ${supersessionIds.join(", ")}`
  );
}

export async function listEffectiveEvidenceRecords(root, runId, options = {}) {
  return (await loadEffectiveEvidenceState(root, runId, options)).records;
}

export async function refreshEvidence(root, runId) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Evidence freshness");
    const evidence = run.contract.schemaVersion === 2
      ? await listIdentityBoundJsonRecords(root, safeJoin(runDir, "evidence"), "Evidence")
      : await listJsonRecords(root, safeJoin(runDir, "evidence"));
    const supersessionState = run.contract.schemaVersion === 2
      ? await loadEvidenceSupersessions(root, run, evidence)
      : { records: [] };
    const immutableIds = new Set(supersessionState.records.flatMap((record) => [
      record.supersededEvidence.id,
      record.replacementEvidence.id
    ]));
    const stale = [];
    const fresh = [];
    const immutableStale = [];
    for (const record of evidence) {
      const freshness = await currentEvidenceFreshness(run, record);
      if (immutableIds.has(record.id)) {
        if (freshness.stale) immutableStale.push(record.id);
      } else {
        const checkedAt = nowIso();
        const next = {
          ...record,
          stale: freshness.stale,
          freshnessCheckedAt: checkedAt,
          currentDependencyFiles: freshness.currentDependencyFiles
        };
        if (freshness.stale) next.staleReason = "dependency-freshness-check";
        else delete next.staleReason;
        await writeEvidenceFreshnessTransition(root, runDir, record, next, { kind: "dependency-refresh" });
      }
      (freshness.stale ? stale : fresh).push(record.id);
    }
    return {
      stale,
      fresh,
      immutableEvidenceIds: [...immutableIds].sort(),
      immutableStale: immutableStale.sort()
    };
  });
}

export async function supersedeEvidence(root, runId, input) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Evidence supersession");
    if (run.contract.schemaVersion !== 2) {
      throw new Error("Evidence supersession requires a TaskContract v2 run");
    }
    assertExactObjectKeys(input, EVIDENCE_SUPERSESSION_INPUT_KEYS, "Evidence supersession input");
    if (input.schemaVersion !== EVIDENCE_SUPERSESSION_SCHEMA_VERSION) {
      throw new Error("Evidence supersession input schemaVersion must be 1");
    }
    validateRecordId(input.id, "evidence supersession");
    validateRecordId(input.supersededEvidenceId, "superseded evidence");
    validateRecordId(input.replacementEvidenceId, "replacement evidence");
    if (!SHA256_DIGEST.test(input.supersededEvidenceDigest) || !SHA256_DIGEST.test(input.replacementEvidenceDigest)) {
      throw new Error("Evidence supersession input digests are invalid");
    }
    if (typeof input.actionAttemptId !== "string" || !SAFE_ID.test(input.actionAttemptId)) {
      throw new Error("Evidence supersession actionAttemptId is required");
    }
    if (typeof input.reason !== "string" || input.reason.trim().length < 12 || input.reason.length > 512) {
      throw new Error("Evidence supersession reason must be 12 to 512 characters");
    }
    const evidence = await listIdentityBoundJsonRecords(root, safeJoin(runDir, "evidence"), "Evidence");
    const evidenceJournal = await readJournalRecords(root, runDir);
    await assertEvidenceJournalProvenance(root, run, evidence, evidenceJournal);
    const recordsById = new Map(evidence.map((record) => [record.id, record]));
    const target = recordsById.get(input.supersededEvidenceId);
    const replacement = recordsById.get(input.replacementEvidenceId);
    if (!target || !replacement) throw new Error("Evidence supersession target or replacement is missing");
    if (
      digestObject(target) !== input.supersededEvidenceDigest ||
      digestObject(replacement) !== input.replacementEvidenceDigest
    ) {
      throw new Error("Evidence supersession input digest does not match persisted evidence");
    }
    const action = await assertEvidenceSupersessionIdentity(run, target, replacement);
    if (action.attemptId !== input.actionAttemptId) {
      throw new Error("Evidence supersession actionAttemptId changed");
    }
    await listIdentityBoundJsonRecords(
      root,
      safeJoin(runDir, "evidence-supersessions"),
      "Evidence supersession"
    );
    const targetPath = safeJoin(runDir, "evidence-supersessions", `${input.id}.json`);
    let record;
    if (await pathExists(targetPath)) {
      record = await readJson(root, targetPath);
      if (
        record.supersededEvidence?.id !== target.id ||
        record.supersededEvidence?.digest !== input.supersededEvidenceDigest ||
        record.replacementEvidence?.id !== replacement.id ||
        record.replacementEvidence?.digest !== input.replacementEvidenceDigest ||
        record.action?.attemptId !== input.actionAttemptId ||
        record.reason !== input.reason
      ) {
        throw new Error(`Evidence supersession already exists: ${input.id}`);
      }
    } else {
      const existingSupersessions = await loadEvidenceSupersessions(root, run, evidence);
      if (
        existingSupersessions.records.some((existing) => (
          existing.supersededEvidence.id === target.id ||
          existing.replacementEvidence.id === target.id ||
          existing.supersededEvidence.id === replacement.id ||
          existing.replacementEvidence.id === replacement.id
        ))
      ) {
        throw new Error("Evidence supersession target or replacement is already bound");
      }
      record = {
        schemaVersion: EVIDENCE_SUPERSESSION_SCHEMA_VERSION,
        id: input.id,
        runId,
        supersededEvidence: { id: target.id, digest: input.supersededEvidenceDigest },
        replacementEvidence: { id: replacement.id, digest: input.replacementEvidenceDigest },
        action,
        contractDigest: run.manifest.contractDigest,
        sourceBindingDigest: run.manifest.sourceBinding?.digest ?? null,
        policyDigest: replacement.dependencies?.policyDigest ?? null,
        reason: input.reason,
        actor: "root",
        createdAt: nowIso()
      };
      await atomicWriteJson(root, targetPath, record);
    }
    const journal = await readJournalRecords(root, runDir);
    const recordDigest = digestObject(record);
    const journalDetails = {
      supersessionId: record.id,
      supersessionDigest: recordDigest,
      supersededEvidenceId: record.supersededEvidence.id,
      supersededEvidenceDigest: record.supersededEvidence.digest,
      replacementEvidenceId: record.replacementEvidence.id,
      replacementEvidenceDigest: record.replacementEvidence.digest,
      actionAttemptId: record.action.attemptId
    };
    const existingJournal = journal.filter((entry) => entry.event === "evidence.superseded" && entry.supersessionId === record.id);
    if (existingJournal.length === 0) {
      await validateEvidenceSupersessionRecord(
        root,
        run,
        recordsById,
        [...journal, { event: "evidence.superseded", at: nowIso(), ...journalDetails }],
        record
      );
      await appendJournal(root, runDir, "evidence.superseded", journalDetails);
    } else if (existingJournal.length !== 1 || existingJournal[0].supersessionDigest !== recordDigest) {
      throw new Error("Evidence supersession journal binding conflicts with the persisted record");
    }
    const refreshed = await loadEvidenceSupersessions(root, run, evidence);
    if (!refreshed.records.some((item) => item.id === record.id)) {
      throw new Error("Evidence supersession was not admitted by canonical replay");
    }
    return record;
  });
}

export async function evaluateCompletion(root, runId) {
  const { runDir, manifest, contract, state } = await loadRun(root, runId);
  let evidence = [];
  let evidenceSupersessions = [];
  const findings = await listJsonRecords(root, safeJoin(runDir, "findings"));
  const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
  const blockers = [];
  try {
    const effective = await loadEffectiveEvidenceState(root, runId, {
      run: { runDir, manifest, contract, state }
    });
    evidence = effective.records;
    evidenceSupersessions = effective.supersessions;
  } catch (error) {
    blockers.push(`invalid-evidence-supersession:${error.message}`);
    evidence = await listJsonRecords(root, safeJoin(runDir, "evidence"));
  }
  for (const action of actions) {
    if (UNSUPPORTED_GOVERNED_ACTIONS.has(action.action)) {
      blockers.push(`unsupported-governed-action:${action.action}`);
    }
    if (isDeferredGovernedAction(contract, action.action)) {
      blockers.push(`deferred-governed-action:${action.action}`);
    }
  }
  let completionReview = null;
  let admittedEvidence = evidence;
  if (manifest.sourceBinding) {
    try {
      const { captureSourceBinding } = await import("./git.mjs");
      const currentSourceBinding = await captureSourceBinding(manifest.cwd, {
        baseRevision: manifest.sourceBinding.baseRevision,
        requireClean: manifest.template === "self-improve-ops"
      });
      if (!currentSourceBinding || currentSourceBinding.digest !== manifest.sourceBinding.digest) {
        blockers.push("source-binding-drift");
      }
    } catch {
      blockers.push("source-binding-unavailable");
    }
  }
  for (const finding of findings) {
    if (["P0", "P1"].includes(finding.severity) && finding.status === "open") {
      blockers.push(`open-${finding.severity}:${finding.id}`);
    }
    if (
      finding.status === "accepted-risk" &&
      (!finding.owner || !finding.reason || Date.parse(finding.expiry) <= Date.now())
    ) {
      blockers.push(`invalid-accepted-risk:${finding.id}`);
    }
  }
  const availableEvidence = new Set(
    evidence
      .filter((item) => item.status === "complete" && !item.stale)
      .map((item) => item.kind)
  );
  if (contract.schemaVersion === 2) {
    const { isTypedEvidence, typedEvidenceKinds, validateTypedEvidenceRecord } = await import("./evidence.mjs");
    const validTypedEvidence = [];
    for (const record of evidence) {
      if (record.status === "complete" && !record.stale && !isTypedEvidence(record)) {
        blockers.push(`untyped-v2-evidence:${record.id}`);
      }
      if (isTypedEvidence(record) && !record.stale) {
        try {
          await validateTypedEvidenceRecord(record, { manifest, contract, state, root, runDir, requireReconciled: true });
          if (record.kind === "required-checks") {
            const mergeGated = contract.actionGates?.["pr.merge"]?.includes("required-checks") === true;
            if (!mergeGated) {
              if (record.receipt.payload.humanApproval !== undefined) {
                throw new Error("Non-merge required-check completion cannot carry PR merge human approval");
              }
              await verifyRequiredChecksProvider(
                manifest.cwd,
                record.receipt.payload,
                record.receipt.payload.providerExecutable
              );
            } else {
              const mergeAction = assertPersistedSuccessfulMergeActionForRequiredChecks(actions, record, {
                runId,
                contractDigest: digestObject(contract),
                repository: record.receipt.payload.repository
              });
              const { assertReviewContinuity } = await import("./review.mjs");
              await assertReviewContinuity(root, runId, {
                packageId: mergeAction.reviewPackageId,
                head: mergeAction.reviewedHead,
                continuityDigest: mergeAction.reviewContinuityDigest
              });
              const checkVerification = await verifyRequiredChecksProvider(
                manifest.cwd,
                record.receipt.payload,
                mergeAction.providerExecutable
              );
              const providerExecutablePath = await verifyRecordedGitHubProvider(manifest, mergeAction);
              const liveAuthorization = await verifyGitHubProviderAuthorization(
                manifest.cwd,
                record.receipt.payload.repository,
                providerExecutablePath
              );
              if (digestObject(liveAuthorization) !== digestObject(mergeAction.providerAuthorization)) {
                throw new Error("Governed PR merge completion provider actor or permission changed");
              }
              await verifyProviderReceipt(manifest, { ...mergeAction, outcome: "success" }, mergeAction.receipt, contract);
              const remoteAuthorization = assertPersistedMergeHumanAuthorizationEvidence(
                mergeAction,
                evidence,
                checkVerification,
                { actor: liveAuthorization.actor, repository: record.receipt.payload.repository }
              );
              if (remoteAuthorization) {
                await validateTypedEvidenceRecord(remoteAuthorization, {
                  manifest,
                  contract,
                  root,
                  runDir,
                  requireReconciled: true
                });
              }
            }
          }
          validTypedEvidence.push(record);
        } catch (error) {
          blockers.push(`invalid-typed-evidence:${record.id ?? "unknown"}`);
        }
      }
    }
    admittedEvidence = validTypedEvidence;
    const typedKinds = typedEvidenceKinds(validTypedEvidence);
    for (const kind of contract.requiredEvidence) {
      if (!typedKinds.has(kind)) blockers.push(`missing-typed-evidence:${kind}`);
    }
    const acceptanceEvidence = contract.acceptanceEvidence ?? {};
    for (const item of contract.acceptance) {
      const required = acceptanceEvidence[item.id] ?? contract.requiredEvidence;
      if (required.some((kind) => !typedKinds.has(kind))) {
        blockers.push(`missing-typed-acceptance:${item.id}`);
      }
    }
    if (contract.controlPlane?.ledgerPolicy === "ledger-v1") {
      const { deriveLedgerStatus } = await import("./ledger.mjs");
      const ledger = await deriveLedgerStatus(root, runId);
      for (const blocker of ledger.blockers) blockers.push(`ledger:${blocker}`);
      if (!ledger.complete) blockers.push("ledger:not-complete");
    }
    if (contract.controlPlane?.reviewPolicy !== "none") {
      const { reviewStatus } = await import("./review.mjs");
      const review = await reviewStatus(root, runId);
      completionReview = review;
      if (!review.scopedClosed) blockers.push("review:scoped-closure-required");
      if (!review.broadReviewComplete) blockers.push("review:final-broad-review-required");
      if (review.openHigh.length > 0) blockers.push("review:open-high-findings");
    }
  } else {
    const covered = new Set(
      evidence
        .filter((item) => item.status === "complete" && !item.stale)
        .flatMap((item) => item.acceptanceIds)
    );
    for (const item of contract.acceptance) {
      if (!covered.has(item.id)) blockers.push(`missing-acceptance:${item.id}`);
    }
  }
  for (const kind of contract.requiredEvidence) {
    if (!availableEvidence.has(kind)) blockers.push(`missing-required-evidence:${kind}`);
  }
  if (!state.lastSentinelVerified) blockers.push("current-sentinel-not-verified");
  if (state.lastSentinelComplete !== true) blockers.push("bounded-sentinel-incomplete");
  if (["stale", "indeterminate", "inconclusive", "blocked_external_reviewer"].includes(state.status)) {
    blockers.push(`run-state:${state.status}`);
  }
  if (actions.some((action) => action.status !== "spent" || ["unknown", "pending", "failure"].includes(action.outcome))) {
    blockers.push("side-effect-not-reconciled");
  }
  if (
    isDevDeliveryTemplate(contract.template) &&
    availableEvidence.has("remote-sync") &&
    !actions.some((action) => (
      action.action === "remote.sync" &&
      action.status === "spent" &&
      action.outcome === "success" &&
      action.resource === "refs/heads/dev" &&
      action.receipt?.providerReceipt?.providerRevision === action.mergeCommit &&
      action.receipt?.providerReceipt?.localRevision === action.mergeCommit
    ))
  ) {
    blockers.push("missing-reconciled-action:remote.sync");
  }
  if (
    contract.upstreamSelfImproveRunId &&
    contract.requiredEvidence.includes("cache-publication") &&
    !actions.some((action) => (
      action.action === "plugin.cache.publish" &&
      action.provider === "local-workspace" &&
      action.status === "spent" &&
      action.outcome === "success" &&
      action.receipt?.providerReceipt &&
      Array.isArray(action.receipt.evidenceIds) &&
      action.receipt.evidenceIds.some((evidenceId) => evidence.some((item) => (
        item.id === evidenceId &&
        item.kind === "cache-publication" &&
        item.status === "complete" &&
        item.stale !== true
      )))
    ))
  ) {
    blockers.push("missing-reconciled-action:plugin.cache.publish");
  }
  if (contract.upstreamSelfImproveRunId && contract.requiredEvidence.includes("cache-publication")) {
    const cachePublicationAction = actions.find((action) => (
      action.action === "plugin.cache.publish" &&
      action.provider === "local-workspace" &&
      action.status === "spent" &&
      action.outcome === "success" &&
      action.receipt?.providerReceipt
    ));
    if (cachePublicationAction) {
      try {
        const { verifyPluginCacheReady } = await import("./publication.mjs");
        const providerReceipt = cachePublicationAction.receipt.providerReceipt;
        if (
          cachePublicationAction.cacheRoot !== getCodexPluginCacheRoot() ||
          cachePublicationAction.cacheRoot !== providerReceipt.cacheRoot ||
          run.manifest?.pluginCacheRoot !== cachePublicationAction.cacheRoot
        ) {
          throw new Error("Plugin cache completion root drift");
        }
        await verifyPluginCacheReady({
          cacheRoot: providerReceipt.cacheRoot,
          version: providerReceipt.version,
          target: providerReceipt.target,
          targetDigest: providerReceipt.targetDigest,
          sourceDigest: providerReceipt.sourceDigest,
          sourceBaselineRevision: providerReceipt.sourceBaselineRevision,
          sourceHeadRevision: providerReceipt.sourceHeadRevision,
          sourceBindingDigest: providerReceipt.sourceBindingDigest,
          pluginBundleDigest: providerReceipt.pluginBundleDigest,
          runId: cachePublicationAction.runId,
          attemptId: cachePublicationAction.attemptId,
          providerReceiptDigest: digestObject(providerReceipt)
        });
      } catch {
        blockers.push("plugin-cache-live-state-stale");
      }
    }
  }
  if (isDevDeliveryTemplate(contract.template)) {
    const remoteSyncAction = actions.find((action) => (
      action.action === "remote.sync" &&
      action.status === "spent" &&
      action.outcome === "success" &&
      action.resource === "refs/heads/dev" &&
      action.receipt?.providerReceipt
    ));
    if (remoteSyncAction) {
      try {
        await verifyProviderReceipt(manifest, { ...remoteSyncAction, outcome: "success" }, remoteSyncAction.receipt);
      } catch {
        blockers.push("remote-sync-live-state-stale");
      }
    }
  }
  const { isIndependentCriticEvidence } = await import("./evidence.mjs");
  const { isQuorumEvidence, changedPathsFromDiffManifest } = await import("./quorum.mjs");
  const { reviewPackageDigest } = await import("./review.mjs");
  const hasLegacyIndependentCritic = admittedEvidence.some((item) => isIndependentCriticEvidence(item, {
    reviewPackage: completionReview?.package,
    sentinelDigest: state.lastSentinel?.digest
  }));
  const hasKernelIndependentCritic = Boolean(
    reviewKernelEnabled(contract.controlPlane?.reviewPolicy) &&
    completionReview?.kernel?.convergence?.axesComplete &&
    completionReview.kernel.axes.filter((axis) => (
      completionReview.package.reviewLanes.some((lane) => lane.required && lane.id === axis.axisId) &&
      axis.providerExecution?.modelAssurance === "host-signed-attestation" &&
      axis.providerExecution?.trustAttested === true
    )).length >= 2
  );
  const hasQuorumEvidence = quorumReviewEnabled(contract.controlPlane?.reviewPolicy) && admittedEvidence.some((item) => isQuorumEvidence(item, {
    registryCwd: manifest.cwd,
    expected: {
      runId,
      sourceBindingDigest: manifest.sourceBinding?.digest,
      sourceSentinelDigest: state.lastSentinel?.digest,
      contractDigest: digestObject(contract),
      templateDigest: contract.templateDigest,
      reviewPackageId: completionReview?.package?.packageId ?? undefined,
      ...(completionReview?.package ? {
        reviewPackageDigest: reviewPackageDigest(completionReview.package),
        base: completionReview.package.base,
        head: completionReview.package.head,
        mergeBase: completionReview.package.mergeBase,
        changedPaths: changedPathsFromDiffManifest(completionReview.package.diffManifest)
      } : {})
    }
  }));
  const hasIndependentCritic = hasLegacyIndependentCritic || hasKernelIndependentCritic || hasQuorumEvidence;
  if (["deep", "critical"].includes(manifest.mode) && !hasIndependentCritic) {
    blockers.push("missing-independent-critic");
  }
  if (
    manifest.mode === "critical" &&
    contract.agy?.required === true &&
    !admittedEvidence.some((item) => isIndependentCriticEvidence(item, {
      reviewPackage: completionReview?.package,
      sentinelDigest: state.lastSentinel?.digest
    }) && item.receipt?.producer?.provider === "agy")
  ) {
    blockers.push("missing-required-agy-critic");
  }
  return { ok: blockers.length === 0, blockers, evidence, evidenceSupersessions, findings, actions };
}

function assertCleanupResourceBinding(manifest, runId, request, cleanupPlan, actions = []) {
  const payload = cleanupPlan?.receipt?.payload;
  if (
    !payload ||
    payload.ownerRunId !== runId ||
    payload.action !== request.action ||
    !Array.isArray(payload.resources)
  ) {
    throw new Error("Action token denied until cleanup resources are bound to this run and action");
  }
  const registry = Array.isArray(manifest.ownedResources)
    ? manifest.ownedResources.filter((entry) => entry && typeof entry === "object")
    : [];
  for (const entry of registry) {
    const creationAction = actions.find((action) => (
      action.attemptId === entry.creationAttemptId &&
      entry.creationActionDigest === ownedResourceCreationActionDigest(action)
    ));
    if (!creationAction) {
      throw new Error("Action token denied until every owned resource has an immutable creation action");
    }
    assertSupportedGovernedAction(creationAction.action);
  }
  const registered = registry.find((entry) => entry.resource === request.resource);
  if (!registered || registered.ownerRunId !== runId || typeof registered.receiptDigest !== "string") {
    throw new Error("Action token denied until the cleanup resource has an immutable creation receipt");
  }
  const resources = payload.resources;
  const planned = resources.find((entry) => entry?.resource === request.resource);
  if (!planned || planned.ownerRunId !== runId || planned.receiptDigest !== registered.receiptDigest) {
    throw new Error("Action token denied until the cleanup plan matches the immutable resource registry");
  }
  for (const entry of resources) {
    const entryRegistered = registry.find((candidate) => candidate.resource === entry?.resource);
    if (
      !entryRegistered ||
      entry.ownerRunId !== runId ||
      entry.receiptDigest !== entryRegistered.receiptDigest ||
      typeof entry.resource !== "string" ||
      !OWNED_RESOURCE.test(entry.resource)
    ) {
      throw new Error("Action token denied until every cleanup resource is registry-bound");
    }
  }
}

function assertRunOwnedPullRequest(manifest, actions, runId, resource) {
  const match = /^pull\/([1-9]\d*)$/.exec(String(resource ?? ""));
  const pullRequest = match ? Number(match[1]) : null;
  const registry = Array.isArray(manifest.ownedResources)
    ? manifest.ownedResources.filter((entry) => entry && typeof entry === "object")
    : [];
  const registered = registry.find((entry) => entry.resource === resource);
  const creationAction = registered
    ? actions.find((action) => (
        action.action === "pr.create" &&
        action.provider === "github-cli" &&
        action.resource === "pull/new" &&
        action.status === "spent" &&
        action.outcome === "success" &&
        action.ownedResource === resource &&
        action.attemptId === registered.creationAttemptId &&
        registered.creationActionDigest === ownedResourceCreationActionDigest(action)
      ))
    : null;
  const providerReceipt = creationAction?.receipt?.providerReceipt;
  if (
    !pullRequest ||
    !registered ||
    registered.ownerRunId !== runId ||
    registered.creationResource !== "pull/new" ||
    typeof registered.receiptDigest !== "string" ||
    !creationAction ||
    providerReceipt?.created !== true ||
    providerReceipt.resource !== "pull/new" ||
    providerReceipt.number !== pullRequest
  ) {
    throw new Error("Action token denied until PR is an immutable run-owned canonical pull request");
  }
  return registered;
}

function repositoryIdentity(value) {
  const raw = String(value ?? "").trim().replace(/\.git$/, "");
  if (!raw) return "";
  const ssh = raw.match(/^([^@]+)@([^:]+):(.+)$/);
  if (ssh) return `${ssh[2].toLowerCase()}/${ssh[3]}`;
  try {
    const parsed = new URL(raw);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return raw.toLowerCase();
  }
}

export async function resolveGitPushDestination(cwd, remote) {
  assertNoAmbientGitAuthorityOverrides();
  if (typeof remote !== "string" || !remote || /[\r\n]/.test(remote)) {
    throw new Error("Git push destination requires one canonical remote name");
  }
  if (remote !== "origin") {
    throw new Error("Governed Git push requires the source-bound origin remote");
  }
  const remoteBinding = await currentOriginRemoteBinding(cwd);
  const selectedUrls = remoteBinding.pushUrls.length > 0 ? remoteBinding.pushUrls : remoteBinding.fetchUrls;
  if (selectedUrls.length !== 1 || remoteBinding.fetchUrls.length !== 1) {
    throw new Error("Git push destination is ambiguous; exactly one raw origin URL and effective push URL are required");
  }
  const pushUrl = selectedUrls[0];
  const remoteRepository = canonicalGovernedGithubRepository(pushUrl);
  if (!remoteRepository) {
    throw new Error("Git push destination requires one credential-safe canonical HTTPS GitHub repository URL");
  }
  return {
    remote,
    pushUrl,
    pushUrlDigest: sha256(pushUrl),
    remoteRepository,
    sourceRemoteBindingDigest: remoteBinding.digest
  };
}

export async function resolveGitFetchOrigin(cwd) {
  assertNoAmbientGitAuthorityOverrides();
  const remoteBinding = await currentOriginRemoteBinding(cwd);
  if (remoteBinding.fetchUrls.length !== 1) {
    throw new Error("Git fetch authority requires exactly one raw local origin URL");
  }
  const remoteUrl = remoteBinding.fetchUrls[0];
  let parsed;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new Error("Git fetch authority requires one parseable HTTPS origin URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.port && parsed.port !== "443")) {
    throw new Error("Git fetch authority requires a credential-safe HTTPS origin URL");
  }
  const remoteRepository = repositoryIdentity(remoteUrl);
  if (!remoteRepository) throw new Error("Git fetch authority requires a canonical origin repository identity");
  return {
    remote: "origin",
    remoteUrl,
    remoteUrlDigest: sha256(remoteUrl),
    remoteRepository,
    sourceRemoteBindingDigest: remoteBinding.digest
  };
}

async function currentRepositoryIdentity(cwd) {
  const remoteBinding = await currentOriginRemoteBinding(cwd);
  if (remoteBinding.fetchUrls.length !== 1) {
    throw new Error("Repository identity requires exactly one raw local origin URL");
  }
  const identity = repositoryIdentity(remoteBinding.fetchUrls[0]);
  if (!identity) throw new Error("PR merge requires a canonical origin repository identity");
  return identity;
}

export async function assertCurrentGitPushSourceBinding(manifest, expectedDigest = manifest?.sourceBinding?.digest) {
  if (!manifest?.sourceBinding || manifest.sourceBinding.schemaVersion !== 3 ||
      !SHA256_DIGEST.test(expectedDigest ?? "") ||
      !SHA256_DIGEST.test(manifest.sourceBinding.originIdentity?.digest ?? "")) {
    throw new Error("Governed Git push requires a schema-3 source binding with raw origin and push URL identity");
  }
  const { captureSourceBinding } = await import("./git.mjs");
  const current = await captureSourceBinding(manifest.cwd, {
    baseRevision: manifest.sourceBinding.baseRevision,
    requireClean: true
  });
  if (!current || current.digest !== expectedDigest ||
      current.originIdentity?.digest !== manifest.sourceBinding.originIdentity.digest) {
    throw new Error("Governed Git push denied because the immutable source or raw remote binding changed");
  }
  return current;
}

async function currentGitProviderIdentity(cwd) {
  const commonDirectory = (await execBoundGitAuthority(cwd, ["rev-parse", "--git-common-dir"])).stdout.trim();
  if (!commonDirectory) throw new Error("Git provider identity requires a common repository directory");
  return realpath(path.isAbsolute(commonDirectory) ? commonDirectory : path.resolve(cwd, commonDirectory));
}

export async function currentProviderExecutableIdentity(command) {
  const candidates = path.isAbsolute(command)
    ? [command]
    : [...new Set((process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.resolve(directory, command)))];
  for (const candidate of candidates) {
    try {
      const target = await realpath(candidate);
      const info = await lstat(target);
      if (!info.isFile() || (info.mode & 0o111) === 0) continue;
      return { path: target, digest: sha256(await readFile(target)) };
    } catch {
      // Continue scanning PATH entries without invoking an ambient resolver.
    }
  }
  throw new Error(`Provider executable is not available: ${command}`);
}

async function verifyRecordedExecutable(expected, command, label) {
  if (!expected || typeof expected.path !== "string" || !path.isAbsolute(expected.path) ||
      typeof expected.digest !== "string" || !SHA256_DIGEST.test(expected.digest)) {
    throw new Error(`${label} requires an absolute recorded executable identity`);
  }
  const executable = await currentProviderExecutableIdentity(command);
  if (digestObject(executable) !== digestObject(expected)) {
    throw new Error(`The governed provider executable changed before the ${label.toLowerCase()}`);
  }
  return executable;
}

async function verifyRecordedGitHubExecutable(record, field = "providerExecutable") {
  return verifyRecordedExecutable(
    record?.[field],
    "gh",
    "GitHub provider probe"
  );
}

async function verifyRecordedGitHubProvider(manifest, record) {
  const executable = await verifyRecordedGitHubExecutable(
    record,
    record.providerAuthorizationExecutable ? "providerAuthorizationExecutable" : "providerExecutable"
  );
  const repository = record.providerAuthorization?.repository ?? record.createRepository;
  if (typeof repository !== "string" || !repository.startsWith("github.com/")) {
    throw new Error("Provider receipt recovery requires a canonical GitHub repository binding");
  }
  if (await currentRepositoryIdentity(manifest.cwd) !== repository) {
    throw new Error("Provider receipt recovery denied because the origin repository changed");
  }
  const authorization = await verifyGitHubProviderAuthorization(manifest.cwd, repository, executable.path);
  if (!record.providerAuthorization || digestObject(authorization) !== digestObject(record.providerAuthorization)) {
    throw new Error("Provider receipt recovery denied because the GitHub actor or permissions changed");
  }
  return executable.path;
}

export function buildPrCreateCommand(record) {
  if (
    !record ||
    record.action !== "pr.create" ||
    record.provider !== "github-cli" ||
    record.resource !== "pull/new" ||
    typeof record.createRepository !== "string" || !record.createRepository.startsWith("github.com/") ||
    typeof record.targetRef !== "string" || !record.targetRef ||
    typeof record.headBranch !== "string" || !record.headBranch ||
    typeof record.prTitle !== "string" || !record.prTitle ||
    typeof record.prBodyPrefix !== "string" || !record.prBodyPrefix ||
    typeof record.attemptId !== "string" || !record.attemptId ||
    typeof record.idempotencyKey !== "string" || !record.idempotencyKey
  ) {
    throw new Error("PR creation command binding is incomplete");
  }
  const marker = `sbw:${record.attemptId}:${record.idempotencyKey}`;
  return [
    "gh",
    "pr",
    "create",
    "--repo",
    record.createRepository,
    "--base",
    record.targetRef,
    "--head",
    record.headBranch,
    "--title",
    record.prTitle,
    "--body",
    `${record.prBodyPrefix}\n\n<!-- ${marker} -->`
  ];
}

function normalizeWorkflowInputs(value, { allowedPublicInputNames } = {}) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub Actions workflow inputs must be an object");
  }
  const publicInputNames = new Set(
    Array.isArray(allowedPublicInputNames) ? allowedPublicInputNames : []
  );
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 20) throw new Error("GitHub Actions workflow inputs are limited to 20 fields");
  const normalized = Object.create(null);
  for (const [key, rawValue] of entries) {
    if (!WORKFLOW_INPUT_KEY.test(key) || WORKFLOW_INPUT_PROTOTYPE_KEYS.has(key)) {
      throw new Error(`GitHub Actions workflow input key is invalid: ${key}`);
    }
    if (rawValue !== null && !["string", "number", "boolean"].includes(typeof rawValue)) {
      throw new Error(`GitHub Actions workflow input value must be a scalar: ${key}`);
    }
    if (typeof rawValue === "number" && !Number.isFinite(rawValue)) {
      throw new Error(`GitHub Actions workflow input value is not finite: ${key}`);
    }
    const inputValue = String(rawValue ?? "");
    if (!WORKFLOW_INPUT_VALUE.test(inputValue)) {
      throw new Error(`GitHub Actions workflow input value is invalid: ${key}`);
    }
    const isProviderCorrelationInput = [
      WORKFLOW_DISPATCH_NONCE_INPUT,
      WORKFLOW_DISPATCH_EXPECTED_REVISION_INPUT
    ].includes(key);
    if (!isProviderCorrelationInput && publicInputNames && !publicInputNames.has(key)) {
      throw new Error(`GitHub Actions workflow input must be explicitly public in the bound workflow: ${key}`);
    }
    if (!isProviderCorrelationInput &&
        (workflowInputKeyIsSensitive(key) || WORKFLOW_INPUT_SECRET_VALUE.test(inputValue))) {
      throw new Error(`GitHub Actions workflow input must be non-sensitive: ${key}`);
    }
    normalized[key] = inputValue;
  }
  if (Object.keys(normalized).length !== entries.length ||
      entries.some(([key]) => !Object.hasOwn(normalized, key))) {
    throw new Error("GitHub Actions workflow input normalization lost an accepted key");
  }
  return normalized;
}

function stripWorkflowYamlComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "'") {
      if (character === "'" && value[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        quote = null;
      }
      continue;
    }
    if (quote === '"') {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function workflowKeyLine(line) {
  const match = /^(\s*)(?:(['"])([A-Za-z0-9_-]+)\2|([A-Za-z0-9_-]+))\s*:(.*)$/.exec(line);
  return match ? { indent: match[1].length, key: match[3] ?? match[4], value: stripWorkflowYamlComment(match[5]) } : null;
}

function workflowYamlStructuralLine(line) {
  return String(line ?? "")
    .replace(/"(?:\\.|[^"\\])*"/g, "\"\"")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/\s+#.*$/, "");
}

function assertSupportedWorkflowYaml(lines) {
  for (const { raw, parsed } of lines) {
    const structural = workflowYamlStructuralLine(raw);
    if (/(?:^|[\s,:{\[(])(?:&[A-Za-z_][A-Za-z0-9_-]*|\*[A-Za-z_][A-Za-z0-9_-]*)(?=$|[\s,}\]])/.test(structural) ||
        /(?:^|\s)<<\s*:/.test(structural)) {
      throw new Error("GitHub Actions workflow anchors, aliases, and merge keys are unsupported");
    }
    if (parsed?.value && /^(?:[|>](?:[+-]?[1-9]?|[1-9]?[+-]?))$/.test(parsed.value)) {
      throw new Error("GitHub Actions workflow block scalars are unsupported for capability attestation");
    }
    if (parsed?.value && /^[\[{]/.test(parsed.value.trim())) {
      throw new Error("GitHub Actions workflow flow mappings and sequences are unsupported for capability attestation");
    }
    if (parsed?.value && /^![A-Za-z_]/.test(parsed.value.trim())) {
      throw new Error("GitHub Actions workflow YAML tags are unsupported for capability attestation");
    }
  }
}

function assertCompleteDirectMapping(lines, start, end, parentIndent, label) {
  const candidates = [];
  for (let index = Math.max(0, start + 1); index < end; index += 1) {
    const raw = String(lines[index]?.raw ?? "");
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.match(/^\s*/)?.[0].length ?? 0;
    if (indent > parentIndent) candidates.push({ index, indent, parsed: lines[index].parsed });
  }
  if (candidates.length === 0) return;
  const childIndent = Math.min(...candidates.map(({ indent }) => indent));
  for (const candidate of candidates.filter(({ indent }) => indent === childIndent)) {
    if (!candidate.parsed || candidate.parsed.indent !== childIndent) {
      throw new Error(`GitHub Actions workflow contains an unsupported or unparsed ${label} mapping entry`);
    }
  }
}

function assertWorkflowMappingHeader(entry, label) {
  if (entry?.parsed?.value) {
    throw new Error(`GitHub Actions workflow ${label} must use a nested mapping`);
  }
}

function directWorkflowEntries(lines, start, end, parentIndent) {
  const entries = lines
    .map(({ parsed }, index) => ({ parsed, index }))
    .filter(({ parsed, index }) => index > start && index < end && parsed && parsed.indent > parentIndent);
  if (entries.length === 0) return [];
  const childIndent = Math.min(...entries.map(({ parsed }) => parsed.indent));
  return entries.filter(({ parsed }) => parsed.indent === childIndent);
}

function assertUniqueWorkflowEntries(entries, label) {
  const seen = new Set();
  for (const { parsed } of entries) {
    if (seen.has(parsed.key)) throw new Error(`GitHub Actions workflow has duplicate ${label} key: ${parsed.key}`);
    seen.add(parsed.key);
  }
}

function unquoteWorkflowScalar(value) {
  const text = String(value ?? "").trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function assertReservedWorkflowInputSchema(lines, inputIndex, inputEnd, inputKey) {
  const header = lines[inputIndex]?.parsed;
  if (!header || header.value) {
    throw new Error(`GitHub Actions reserved input ${inputKey} must use a nested string schema`);
  }
  const children = directWorkflowEntries(lines, inputIndex, inputEnd, header.indent);
  assertUniqueWorkflowEntries(children, `reserved input ${inputKey}`);
  const required = children.find(({ parsed }) => parsed.key === "required")?.parsed.value;
  const type = children.find(({ parsed }) => parsed.key === "type")?.parsed.value;
  if (unquoteWorkflowScalar(required) !== "true" || unquoteWorkflowScalar(type) !== "string") {
    throw new Error(`GitHub Actions reserved input ${inputKey} must declare required: true and type: string`);
  }
  if (children.some(({ parsed }) => ["options", "choice", "boolean", "number"].includes(parsed.key))) {
    throw new Error(`GitHub Actions reserved input ${inputKey} has an incompatible schema`);
  }
}

function workflowInputIsExplicitlyPublic(lines, inputIndex, inputEnd) {
  const header = lines[inputIndex]?.parsed;
  if (!header || header.value) return false;
  const children = directWorkflowEntries(lines, inputIndex, inputEnd, header.indent);
  const description = children.find(({ parsed }) => parsed.key === "description")?.parsed.value;
  return /^public(?:\s|:|$)/i.test(unquoteWorkflowScalar(description));
}

function workflowInputBlockEnd(inputEntries, inputIndex, inputsStop) {
  return inputEntries.find(({ index }) => index > inputIndex)?.index ?? inputsStop;
}

function assertWorkflowConcurrencyDoesNotCancelRuns(lines, topEntries) {
  const concurrencyIndex = topEntries.find(({ parsed }) => parsed.key === "concurrency")?.index ?? -1;
  if (concurrencyIndex < 0) return;
  const header = topEntries.find(({ index }) => index === concurrencyIndex);
  assertWorkflowMappingHeader(header, "concurrency block");
  const indent = header.parsed.indent;
  const end = lines.findIndex(({ parsed }, index) => index > concurrencyIndex && parsed && parsed.indent <= indent);
  const stop = end < 0 ? lines.length : end;
  assertCompleteDirectMapping(lines, concurrencyIndex, stop, indent, "concurrency block");
  const entries = directWorkflowEntries(lines, concurrencyIndex, stop, indent);
  assertUniqueWorkflowEntries(entries, "concurrency block");
  const cancel = entries.find(({ parsed }) => parsed.key === "cancel-in-progress");
  if (cancel && unquoteWorkflowScalar(cancel.parsed.value).toLowerCase() !== "false") {
    throw new Error("GitHub Actions workflow concurrency must not enable cancel-in-progress for governed dispatch");
  }
}

function isExactWorkflowRevisionGate(value) {
  if (typeof value !== "string" || value.includes("#")) return false;
  const trimmed = value.trim();
  const wrapped = trimmed.startsWith("${{") || trimmed.endsWith("}}");
  if (wrapped && (!trimmed.startsWith("${{") || !trimmed.endsWith("}}"))) return false;
  const expression = (wrapped ? trimmed.slice(3, -2) : trimmed).trim();
  if (expression.includes("${{") || expression.includes("}}")) return false;
  return new Set([
    "github.sha == inputs.sbw_expected_revision",
    "github.sha == github.event.inputs.sbw_expected_revision",
    "inputs.sbw_expected_revision == github.sha",
    "github.event.inputs.sbw_expected_revision == github.sha"
  ]).has(expression);
}

export function validateWorkflowDispatchCapability(content, workflowFile, revision) {
  if (typeof content !== "string" || !content) {
    throw new Error(`GitHub Actions workflow ${workflowFile} has no readable content`);
  }
  const lines = content.split(/\r?\n/).map((line) => ({
    raw: line,
    parsed: line.trimStart().startsWith("#") ? null : workflowKeyLine(line)
  }));
  assertSupportedWorkflowYaml(lines);
  assertCompleteDirectMapping(lines, -1, lines.length, -1, "top-level");
  const topEntries = directWorkflowEntries(lines, -1, lines.length, -1);
  assertUniqueWorkflowEntries(topEntries, "top-level");
  assertWorkflowConcurrencyDoesNotCancelRuns(lines, topEntries);
  const topOn = topEntries.find(({ parsed }) => parsed.key === "on")?.index ?? -1;
  if (topOn < 0) throw new Error("GitHub Actions workflow must declare a top-level on block");
  assertWorkflowMappingHeader(topEntries.find(({ index }) => index === topOn), "on block");
  const onIndent = lines[topOn].parsed.indent;
  const onEnd = lines.findIndex(({ parsed }, index) => index > topOn && parsed && parsed.indent <= onIndent);
  const onStop = onEnd < 0 ? lines.length : onEnd;
  assertCompleteDirectMapping(lines, topOn, onStop, onIndent, "on block");
  const onEntries = directWorkflowEntries(lines, topOn, onStop, onIndent);
  assertUniqueWorkflowEntries(onEntries, "on block");
  const dispatchIndex = onEntries.find(({ parsed }) => parsed.key === "workflow_dispatch")?.index ?? -1;
  if (dispatchIndex < 0) throw new Error("GitHub Actions workflow must declare workflow_dispatch");
  assertWorkflowMappingHeader(onEntries.find(({ index }) => index === dispatchIndex), "workflow_dispatch");
  const dispatchIndent = lines[dispatchIndex].parsed.indent;
  const dispatchEnd = lines.findIndex(({ parsed }, index) => (
    index > dispatchIndex && index < onStop && parsed && parsed.indent <= dispatchIndent
  ));
  const dispatchStop = dispatchEnd < 0 ? onStop : dispatchEnd;
  assertCompleteDirectMapping(lines, dispatchIndex, dispatchStop, dispatchIndent, "workflow_dispatch");
  const dispatchEntries = directWorkflowEntries(lines, dispatchIndex, dispatchStop, dispatchIndent);
  assertUniqueWorkflowEntries(dispatchEntries, "workflow_dispatch");
  const inputsIndex = dispatchEntries.find(({ parsed }) => parsed.key === "inputs")?.index ?? -1;
  if (inputsIndex < 0) throw new Error("GitHub Actions workflow_dispatch must declare inputs");
  assertWorkflowMappingHeader(dispatchEntries.find(({ index }) => index === inputsIndex), "workflow_dispatch inputs");
  const inputsIndent = lines[inputsIndex].parsed.indent;
  const inputsEnd = lines.findIndex(({ parsed }, index) => (
    index > inputsIndex && index < dispatchStop && parsed && parsed.indent <= inputsIndent
  ));
  const inputsStop = inputsEnd < 0 ? dispatchStop : inputsEnd;
  assertCompleteDirectMapping(lines, inputsIndex, inputsStop, inputsIndent, "workflow_dispatch input");
  const inputEntries = directWorkflowEntries(lines, inputsIndex, inputsStop, inputsIndent);
  assertUniqueWorkflowEntries(inputEntries, "workflow_dispatch input");
  const nonceIndex = inputEntries.find(({ parsed }) => parsed.key === WORKFLOW_DISPATCH_NONCE_INPUT)?.index ?? -1;
  if (nonceIndex < 0) {
    throw new Error(`GitHub Actions workflow_dispatch must declare the reserved ${WORKFLOW_DISPATCH_NONCE_INPUT} input`);
  }
  const expectedRevisionIndex = inputEntries.find(({ parsed }) => parsed.key === WORKFLOW_DISPATCH_EXPECTED_REVISION_INPUT)?.index ?? -1;
  if (expectedRevisionIndex < 0) {
    throw new Error(`GitHub Actions workflow_dispatch must declare the reserved ${WORKFLOW_DISPATCH_EXPECTED_REVISION_INPUT} input`);
  }
  // Validate every input's direct child mapping before interpreting any
  // ordinary input.  The provider's YAML parser rejects duplicate keys and
  // malformed children; the capability attestor must do the same instead of
  // letting find(...) select one ambiguous declaration.
  for (const inputEntry of inputEntries) {
    if (![WORKFLOW_DISPATCH_NONCE_INPUT, WORKFLOW_DISPATCH_EXPECTED_REVISION_INPUT].includes(inputEntry.parsed.key)) {
      assertWorkflowMappingHeader(inputEntry, `workflow_dispatch input ${inputEntry.parsed.key}`);
    }
    const inputEnd = workflowInputBlockEnd(inputEntries, inputEntry.index, inputsStop);
    assertCompleteDirectMapping(
      lines,
      inputEntry.index,
      inputEnd,
      inputEntry.parsed.indent,
      `workflow_dispatch input ${inputEntry.parsed.key}`
    );
    const inputChildren = directWorkflowEntries(lines, inputEntry.index, inputEnd, inputEntry.parsed.indent);
    assertUniqueWorkflowEntries(inputChildren, `workflow_dispatch input ${inputEntry.parsed.key}`);
  }
  assertReservedWorkflowInputSchema(
    lines,
    nonceIndex,
    workflowInputBlockEnd(inputEntries, nonceIndex, inputsStop),
    WORKFLOW_DISPATCH_NONCE_INPUT
  );
  assertReservedWorkflowInputSchema(
    lines,
    expectedRevisionIndex,
    workflowInputBlockEnd(inputEntries, expectedRevisionIndex, inputsStop),
    WORKFLOW_DISPATCH_EXPECTED_REVISION_INPUT
  );
  const publicInputNames = inputEntries
    .filter(({ parsed }) => ![
      WORKFLOW_DISPATCH_NONCE_INPUT,
      WORKFLOW_DISPATCH_EXPECTED_REVISION_INPUT
    ].includes(parsed.key))
    .filter(({ index }) => workflowInputIsExplicitlyPublic(
      lines,
      index,
      workflowInputBlockEnd(inputEntries, index, inputsStop)
    ))
    .map(({ parsed }) => parsed.key)
    .sort();
  const runName = topEntries.find(({ parsed }) => parsed.key === "run-name");
  if (!runName || !WORKFLOW_DISPATCH_NONCE_EXPRESSION.test(runName.parsed.value)) {
    throw new Error(`GitHub Actions workflow run-name must expose ${WORKFLOW_DISPATCH_NONCE_INPUT}`);
  }
  const jobs = topEntries.find(({ parsed }) => parsed.key === "jobs")?.index ?? -1;
  if (jobs < 0) throw new Error("GitHub Actions workflow must declare a top-level jobs block");
  assertWorkflowMappingHeader(topEntries.find(({ index }) => index === jobs), "jobs block");
  const jobsIndent = lines[jobs].parsed.indent;
  const jobsEnd = lines.findIndex(({ parsed }, index) => index > jobs && parsed && parsed.indent <= jobsIndent);
  const jobsStop = jobsEnd < 0 ? lines.length : jobsEnd;
  assertCompleteDirectMapping(lines, jobs, jobsStop, jobsIndent, "jobs");
  const jobHeaders = directWorkflowEntries(lines, jobs, jobsStop, jobsIndent);
  assertUniqueWorkflowEntries(jobHeaders, "jobs");
  if (jobHeaders.length === 0) throw new Error("GitHub Actions workflow must declare at least one job");
  for (const [position, header] of jobHeaders.entries()) {
    assertWorkflowMappingHeader(header, `job ${header.parsed.key}`);
    const blockEnd = jobHeaders[position + 1]?.index ?? jobsStop;
    assertCompleteDirectMapping(lines, header.index, blockEnd, header.parsed.indent, `job ${header.parsed.key}`);
    const jobEntries = directWorkflowEntries(lines, header.index, blockEnd, header.parsed.indent);
    assertUniqueWorkflowEntries(jobEntries, `job ${header.parsed.key}`);
    const gateLines = jobEntries.filter(({ parsed }) => parsed.key === "if");
    if (gateLines.length !== 1 || !isExactWorkflowRevisionGate(gateLines[0]?.parsed.value)) {
      throw new Error(`Every GitHub Actions job must have an exact ${WORKFLOW_DISPATCH_EXPECTED_REVISION_INPUT} gate`);
    }
  }
  return {
    schemaVersion: 1,
    workflowFile,
    revision,
    nonceInput: WORKFLOW_DISPATCH_NONCE_INPUT,
    expectedRevisionInput: WORKFLOW_DISPATCH_EXPECTED_REVISION_INPUT,
    publicInputNames,
    runNameNonce: true,
    expectedRevisionGate: true,
    contentDigest: sha256(content)
  };
}

async function readBoundWorkflowDispatchCapability(cwd, workflowFile, revision) {
  if (!SHA.test(String(revision ?? ""))) {
    throw new Error("GitHub Actions workflow capability requires an exact target revision");
  }
  const canonicalFile = canonicalWorkflowFile(workflowFile);
  const content = (await execBoundGitAuthority(cwd, ["show", `${revision}:${canonicalFile}`])).stdout;
  return validateWorkflowDispatchCapability(content, canonicalFile, revision);
}

function canonicalGitHubRepositoryPath(value) {
  const repository = typeof value === "string" && value.startsWith("github.com/")
    ? value.slice("github.com/".length)
    : value;
  if (typeof repository !== "string" || !/^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.test(repository)) {
    throw new Error("GitHub Actions dispatch requires an owner/repository binding");
  }
  return repository;
}

function canonicalGitHubRepository(value) {
  return `github.com/${canonicalGitHubRepositoryPath(value)}`;
}

function canonicalWorkflowFile(value) {
  if (typeof value !== "string" || !WORKFLOW_FILE.test(value)) {
    throw new Error("GitHub Actions dispatch requires a repository workflow file under .github/workflows");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("GitHub Actions workflow file path contains an unsafe segment");
  }
  return value;
}

function canonicalWorkflowResource(value) {
  if (typeof value !== "string" || !value.startsWith("workflow:")) {
    throw new Error("GitHub Actions dispatch resources must use workflow:<.github/workflows file>");
  }
  const workflowFile = canonicalWorkflowFile(value.slice("workflow:".length));
  return `workflow:${workflowFile}`;
}

function workflowResourceMatchesFile(record) {
  if (!record || typeof record.resource !== "string" || typeof record.workflowFile !== "string") return false;
  try {
    return canonicalWorkflowResource(record.resource) === `workflow:${canonicalWorkflowFile(record.workflowFile)}`;
  } catch {
    return false;
  }
}

function canonicalWorkflowRef(value) {
  if (typeof value !== "string" || !WORKFLOW_REF.test(value)) {
    throw new Error("GitHub Actions dispatch requires an exact branch or tag scope");
  }
  if (SHA.test(value)) {
    throw new Error("GitHub Actions dispatch scope must be a branch or tag ref, not a raw commit SHA");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || value.includes("@{")) {
    throw new Error("GitHub Actions dispatch ref contains an unsafe segment");
  }
  if (value.startsWith("refs/") && !WORKFLOW_REF_IDENTITY.test(value)) {
    throw new Error("GitHub Actions dispatch scope must use refs/heads or refs/tags");
  }
  return value;
}

function canonicalWorkflowDispatchIdentity(value) {
  const ref = canonicalWorkflowRef(value);
  if (!WORKFLOW_REF_IDENTITY.test(ref)) {
    throw new Error("GitHub Actions dispatch requires a fully qualified refs/heads or refs/tags identity");
  }
  return ref;
}

export function workflowDispatchObservationRef(value) {
  const ref = canonicalWorkflowDispatchIdentity(value);
  return ref.slice(ref.indexOf("/", "refs/".length) + 1);
}

function actionsDispatchReceiptRequest(record) {
  return {
    action: record.action,
    provider: record.provider,
    resource: record.resource,
    remoteRevision: record.remoteRevision,
    repository: canonicalGitHubRepository(record.dispatchRepository),
    workflowFile: record.workflowFile,
    ref: record.dispatchRef,
    dispatchNonce: record.dispatchNonce,
    dispatchInputsDigest: record.dispatchInputsDigest,
    workflowDispatchCapabilityDigest: record.workflowDispatchCapabilityDigest,
    providerExecutable: record.providerExecutable
  };
}

function actionsDispatchNotSentReceiptResponse(record, invocation) {
  return {
    dispatchState: "not-sent",
    invocationId: invocation?.id ?? null,
    exitCode: invocation?.exitCode ?? null,
    errorDigest: invocation?.errorDigest ?? null,
    commandDigest: digestObject(record.dispatchCommand),
    providerExecutableDigest: digestObject(record.providerExecutable),
    providerAuthorizationExecutableDigest: digestObject(record.providerAuthorizationExecutable),
    providerAuthorizationDigest: digestObject(record.providerAuthorization),
    startedAt: invocation?.startedAt ?? null,
    finishedAt: invocation?.finishedAt ?? null
  };
}

export function buildActionsDispatchCommand(record) {
  if (
    !record ||
    record.action !== "actions.dispatch" ||
    record.provider !== "github-cli" ||
    typeof record.dispatchRepository !== "string" ||
      !canonicalGitHubRepositoryPath(record.dispatchRepository) ||
    typeof record.dispatchRef !== "string" ||
      canonicalWorkflowDispatchIdentity(record.dispatchRef) !== record.dispatchRef
  ) {
    throw new Error("GitHub Actions dispatch command binding is incomplete");
  }
  if (record.dispatchRef.startsWith("refs/tags/")) {
    throw new Error("GitHub Actions dispatch tag refs are unsupported by branch-bound observation");
  }
  const workflowFile = canonicalWorkflowFile(record.workflowFile);
  if (!workflowResourceMatchesFile(record) || record.resource !== `workflow:${workflowFile}`) {
    throw new Error("GitHub Actions dispatch command resource is not bound to workflowFile");
  }
  const inputs = normalizeWorkflowInputs(record.dispatchInputs, {
    allowedPublicInputNames: record.workflowDispatchCapability?.publicInputNames
  });
  if (!WORKFLOW_DISPATCH_NONCE.test(String(record.dispatchNonce ?? "")) ||
      inputs[WORKFLOW_DISPATCH_NONCE_INPUT] !== record.dispatchNonce ||
      inputs[WORKFLOW_DISPATCH_EXPECTED_REVISION_INPUT] !== record.remoteRevision) {
    throw new Error("GitHub Actions dispatch command is missing its provider-correlation nonce binding");
  }
  if (record.dispatchInputsDigest !== digestObject(inputs)) {
    throw new Error("GitHub Actions dispatch input digest does not match the fixed command binding");
  }
  const command = [
    "gh",
    "workflow",
    "run",
    workflowFile,
    "--repo",
    canonicalGitHubRepositoryPath(record.dispatchRepository),
    "--ref",
    workflowDispatchObservationRef(record.dispatchRef)
  ];
  for (const [key, value] of Object.entries(inputs)) {
    command.push("--raw-field", `${key}=${value}`);
  }
  return command;
}

export function buildActionsDispatchProviderReceipt(record, outcome = "success") {
  if (!["success", "failure", "unknown"].includes(outcome)) {
    throw new Error("GitHub Actions dispatch receipt outcome is invalid");
  }
  if (!workflowResourceMatchesFile(record)) {
    throw new Error("GitHub Actions dispatch receipt resource is not bound to workflowFile");
  }
  if (record?.providerInvocation?.dispatchState === "not-sent") {
    if (outcome !== "failure") {
      throw new Error("A not-sent GitHub Actions dispatch can only reconcile as terminal failure");
    }
    const invocation = record.providerInvocation;
    if (typeof invocation.id !== "string" || typeof invocation.errorDigest !== "string" ||
        !SHA256_DIGEST.test(invocation.errorDigest) || typeof invocation.startedAt !== "string" ||
        typeof invocation.finishedAt !== "string") {
      throw new Error("GitHub Actions not-sent provider invocation is incomplete");
    }
    const repository = canonicalGitHubRepository(record.dispatchRepository);
    const response = actionsDispatchNotSentReceiptResponse(record, invocation);
    return {
      action: record.action,
      provider: record.provider,
      resource: record.resource,
      outcome,
      attemptId: record.attemptId,
      idempotencyKey: record.idempotencyKey,
      remoteRevision: record.remoteRevision,
      executionId: `github:${repository}:actions.dispatch:not-sent:${record.runId}:${record.attemptId}`,
      proofKind: "github-actions-dispatch",
      requestDigest: digestObject(actionsDispatchReceiptRequest(record)),
      responseDigest: digestObject(response),
      verifiedAt: nowIso(),
      terminalState: "failure",
      created: false,
      dispatchState: "not-sent",
      repository,
      workflowFile: record.workflowFile,
      ref: record.dispatchRef,
      dispatchNonce: record.dispatchNonce,
      dispatchInputsDigest: record.dispatchInputsDigest,
      workflowDispatchCapabilityDigest: record.workflowDispatchCapabilityDigest,
      invocationId: invocation.id,
      errorDigest: invocation.errorDigest
    };
  }
  if (!record?.providerInvocation?.workflowRun) {
    throw new Error("GitHub Actions dispatch provider invocation lacks an observed workflow run");
  }
  const run = record.providerInvocation.workflowRun;
  const runId = String(run.databaseId ?? run.runId ?? "");
  if (!/^\d+$/.test(runId) || typeof run.workflowName !== "string" || !run.workflowName ||
      typeof run.url !== "string" || !run.url || typeof run.headSha !== "string" || !SHA.test(run.headSha) ||
      run.headSha !== record.remoteRevision ||
      !WORKFLOW_DISPATCH_NONCE.test(String(record.dispatchNonce ?? "")) ||
      typeof run.displayTitle !== "string" || !run.displayTitle.includes(record.dispatchNonce) ||
      run.status !== "completed" || typeof run.conclusion !== "string" || !run.conclusion) {
    throw new Error("GitHub Actions dispatch provider invocation is incomplete");
  }
  const repository = canonicalGitHubRepository(record.dispatchRepository);
  if (!workflowDispatchConclusionMatchesOutcome(run.status, run.conclusion, outcome)) {
    throw new Error(
      outcome === "success"
        ? "Successful GitHub Actions dispatch receipt requires a successful workflow conclusion"
        : outcome === "failure"
          ? "Failed GitHub Actions dispatch receipt requires a completed non-success workflow conclusion"
          : "Completed GitHub Actions dispatch receipt cannot remain unknown"
    );
  }
  const response = {
    runId,
    workflowName: run.workflowName,
    url: run.url,
    status: run.status,
    conclusion: run.conclusion,
    headSha: run.headSha,
    displayTitle: run.displayTitle,
    dispatchNonce: record.dispatchNonce,
    workflowDispatchCapabilityDigest: record.workflowDispatchCapabilityDigest
  };
  const executionId = `github:${repository}:actions.dispatch:${runId}`;
  return {
    action: record.action,
    provider: record.provider,
    resource: record.resource,
    outcome,
    runId,
    attemptId: record.attemptId,
    idempotencyKey: record.idempotencyKey,
    remoteRevision: record.remoteRevision,
    executionId,
    proofKind: "github-actions-dispatch",
    requestDigest: digestObject(actionsDispatchReceiptRequest(record)),
    responseDigest: digestObject(response),
    verifiedAt: nowIso(),
    terminalState: outcome === "success" ? "success" : "failure",
    created: true,
    repository,
    workflowName: run.workflowName,
    workflowFile: record.workflowFile,
    ref: record.dispatchRef,
    url: run.url,
    status: run.status,
    conclusion: run.conclusion,
    headSha: run.headSha,
    displayTitle: run.displayTitle,
    dispatchNonce: record.dispatchNonce,
    dispatchInputsDigest: record.dispatchInputsDigest,
    workflowDispatchCapabilityDigest: record.workflowDispatchCapabilityDigest,
    invocationId: record.providerInvocation.id
  };
}

export async function readBoundGitHubCredential(executablePath, { homePath = os.homedir() } = {}) {
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath) ||
      path.resolve(executablePath) !== executablePath || typeof homePath !== "string" ||
      !path.isAbsolute(homePath) || path.resolve(homePath) !== homePath) {
    throw new Error("Bound GitHub credential acquisition requires canonical executable and home paths");
  }
  const target = await realpath(executablePath);
  const info = await lstat(target);
  if (target !== executablePath || !info.isFile() || (info.mode & 0o111) === 0) {
    throw new Error("Bound GitHub credential executable is unsafe");
  }
  const result = await execBoundGitHubCli(executablePath, ["auth", "token", "--hostname", "github.com"], {
    env: boundGitHubEnvironment(homePath)
  });
  const token = result.stdout.trim();
  if (!token || /[\r\n\0]/.test(token)) throw new Error("GitHub CLI did not return one bounded token");
  return { username: "x-access-token", password: token, source: "github-cli-auth-token" };
}

async function resolveBoundGitObjectDirectory(cwd, isolatedHome, gitExecutablePath) {
  if (gitExecutablePath !== BOUND_GIT_EXECUTABLE) throw new Error("Bound Git object lookup requires /usr/bin/git");
  const result = await execBoundGit(gitExecutablePath, [
    "--no-replace-objects",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "rev-parse", "--git-path", "objects"
  ], {
    cwd,
    env: {
      PATH: BOUND_GIT_PATH,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: isolatedHome,
      TMPDIR: isolatedHome,
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0"
    },
    timeoutMs: BOUND_GIT_TIMEOUT_MS,
    maxBuffer: BOUND_GIT_MAX_BUFFER,
  });
  const resolved = await realpath(path.resolve(cwd, result.stdout.trim()));
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || resolved.includes(path.delimiter)) {
    throw new Error("Bound Git push source object directory is unsafe");
  }
  return resolved;
}

export async function withBoundGitCredential(cwd, remoteUrl, credential, gitExecutablePath, callback) {
  if (typeof callback !== "function" || typeof credential?.username !== "string" || !credential.username ||
      typeof credential?.password !== "string" || !credential.password || gitExecutablePath !== BOUND_GIT_EXECUTABLE) {
    throw new Error("Bound Git credential is incomplete");
  }
  const parsed = new URL(remoteUrl);
  parsed.username = credential.username;
  parsed.password = credential.password;
  await assertTrustedCredentialRoot();
  const directory = await mkdtemp(path.join(BOUND_CREDENTIAL_ROOT, "sbw-git-credential-"));
  const credentialFile = path.join(directory, "credentials");
  const gitDirectory = path.join(directory, "git-dir");
  try {
    await chmod(directory, 0o700);
    await assertBoundCredentialWorkspace(directory);
    const objectDirectory = await resolveBoundGitObjectDirectory(cwd, directory, gitExecutablePath);
    await mkdir(path.join(gitDirectory, "objects", "info"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(gitDirectory, "objects", "pack"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(gitDirectory, "refs", "heads"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(gitDirectory, "refs", "tags"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(gitDirectory, "HEAD"), "ref: refs/heads/bound-empty\n", { mode: 0o600, flag: "wx" });
    await writeFile(credentialFile, `${parsed.toString()}\n`, { mode: 0o600, flag: "wx" });
    await assertBoundCredentialWorkspace(directory, credentialFile);
    return await callback({ credentialFile, isolatedHome: directory, gitDirectory, objectDirectory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyGitHubCredentialActor(cwd, remoteUrl, repository, githubExecutablePath) {
  let parsed;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new Error("Git push credential binding requires a parseable HTTPS remote");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw new Error("Git push credential binding requires the canonical github.com HTTPS remote");
  }
  const homePath = os.homedir();
  const credential = await readBoundGitHubCredential(githubExecutablePath, { homePath });
  if (typeof credential.username !== "string" || !credential.username ||
      typeof credential.password !== "string" || !credential.password) {
    throw new Error("Bound GitHub CLI did not return an HTTPS credential");
  }
  // Keep actor and repository authorization on the already bounded `gh api`
  // path. Its fixed executable, hostname, environment, timeout and output
  // policy prevent ambient NODE_TLS_REJECT_UNAUTHORIZED/proxy/configuration
  // state from weakening this credential binding.
  const user = await readBoundGitHubApi(cwd, githubExecutablePath, "user", { credential, homePath });
  const repositoryPath = repository.slice("github.com/".length);
  const metadata = await readBoundGitHubApi(cwd, githubExecutablePath, `repos/${repositoryPath}`, { credential, homePath });
  const permissions = metadata.permissions ?? {};
  if (
    typeof user.login !== "string" || !user.login ||
    !Number.isInteger(user.id) ||
    metadata.full_name !== repositoryPath ||
    permissions.push !== true
  ) {
    throw new Error("Git credential is not bound to a GitHub actor with repository push permission");
  }
  return {
    credential,
    actor: user.login,
    actorId: user.id,
    permissions: {
      admin: permissions.admin === true,
      maintain: permissions.maintain === true,
      push: permissions.push === true
    },
    source: credential.source
  };
}

async function captureCreationPrecondition(cwd, action, resource, providerExecutablePath = null, repository = null) {
  if (action === "branch.create") {
    const ref = resource.slice("branch:".length);
    const revision = await resolveOptionalBoundBranchRevision(
      (args, options) => execBoundGitAuthority(cwd, args, options),
      `refs/heads/${ref}`,
      "Git branch creation precondition"
    );
    if (revision !== null) {
      return { action, resource, state: "present", revision };
    }
    return { action, resource, state: "absent", ref };
  }
  if (action === "worktree.create") {
    const worktreePath = resource.slice("worktree:".length);
    const output = (await execBoundGitAuthority(cwd, ["worktree", "list", "--porcelain"])).stdout;
    const present = output.split(/\n\n+/).some((block) => block.split("\n").some((line) => line === `worktree ${worktreePath}`));
    return { action, resource, state: present || await pathExists(path.resolve(cwd, worktreePath)) ? "present" : "absent", path: worktreePath };
  }
  if (action === "pr.create") {
    if (resource === "pull/new") {
      return { action, resource, state: "absent", number: null };
    }
    const number = Number(resource.slice("pull/".length));
    if (typeof repository !== "string" || !repository.startsWith("github.com/")) {
      throw new Error("GitHub PR precondition requires a source-bound repository");
    }
    try {
      const actual = JSON.parse((await execBoundGitHubCli(providerExecutablePath, ["pr", "view", String(number), "--repo", repository, "--json", "number,state"], {
        cwd,
      })).stdout);
      return { action, resource, state: "present", number: actual.number, status: actual.state };
    } catch (error) {
      if (error.code !== 1) throw error;
      return { action, resource, state: "absent", number };
    }
  }
  if (action === "actions.dispatch" && resource.startsWith("run:")) {
    const runId = resource.slice("run:".length);
    if (typeof repository !== "string" || !repository.startsWith("github.com/")) {
      throw new Error("GitHub Actions precondition requires a source-bound repository");
    }
    try {
      const actual = JSON.parse((await execBoundGitHubCli(providerExecutablePath, ["run", "view", runId, "--repo", repository, "--json", "databaseId,status"], {
        cwd,
      })).stdout);
      return { action, resource, state: "present", runId: String(actual.databaseId), status: actual.status };
    } catch (error) {
      if (error.code !== 1) throw error;
      return { action, resource, state: "absent", runId };
    }
  }
  return null;
}

async function verifyFailedCreationAbsence(manifest, record) {
  if (!OWNED_RESOURCE_CREATION_ACTIONS.has(record.action)) return null;
  const cwd = manifest.cwd;
  if (record.action === "pr.create" && record.provider === "github-cli") {
    const providerExecutablePath = await verifyRecordedGitHubProvider(manifest, record);
    const repository = record.createRepository ?? record.providerAuthorization?.repository;
    if (!repository || await currentRepositoryIdentity(cwd) !== repository) {
      throw new Error("Failed PR creation reconciliation repository changed after authorization");
    }
    const repositoryPath = repository.startsWith("github.com/")
      ? repository.slice("github.com/".length)
      : repository;
    const repositoryOwner = repositoryPath.split("/")[0];
    if (!repositoryOwner || !record.headBranch || !record.targetRef) {
      throw new Error("Failed PR creation reconciliation requires a canonical repository owner, head, and base");
    }
    const endpoint = [
      `repos/${repositoryPath}/pulls?state=all`,
      `head=${encodeURIComponent(`${repositoryOwner}:${record.headBranch}`)}`,
      `base=${encodeURIComponent(record.targetRef)}`,
      "per_page=100"
    ].join("&");
    const command = [providerExecutablePath, "api", "--paginate", "--slurp", endpoint];
    const output = await execBoundGitHubCli(providerExecutablePath, command.slice(1), { cwd });
    let pages;
    try {
      pages = JSON.parse(output.stdout);
    } catch {
      throw new Error("Failed PR creation reconciliation did not return structured provider absence data");
    }
    const pageList = Array.isArray(pages) && pages.every((page) => Array.isArray(page))
      ? pages
      : Array.isArray(pages)
        ? [pages]
        : null;
    if (!pageList) {
      throw new Error("Failed PR creation reconciliation provider absence data is not a paginated array");
    }
    const actual = pageList.flat().map((pullRequest) => {
      const normalized = {
        number: pullRequest?.number,
        headRefOid: pullRequest?.headRefOid ?? pullRequest?.head?.sha,
        baseRefName: pullRequest?.baseRefName ?? pullRequest?.base?.ref,
        url: pullRequest?.url ?? pullRequest?.html_url
      };
      if (
        !Number.isInteger(normalized.number) ||
        typeof normalized.headRefOid !== "string" ||
        !normalized.headRefOid ||
        typeof normalized.baseRefName !== "string" ||
        !normalized.baseRefName ||
        typeof normalized.url !== "string" ||
        !normalized.url
      ) {
        throw new Error("Failed PR creation reconciliation provider response contains an incomplete pull request");
      }
      return normalized;
    });
    if (!Array.isArray(actual)) {
      throw new Error("Failed PR creation reconciliation provider absence data is not an array");
    }
    if (actual.length > 0) {
      throw new Error("Failed PR creation reconciliation found an existing pull request; preserve the reservation and reconcile the provider outcome");
    }
    return {
      schemaVersion: 1,
      proofKind: "github-pr-create-absence",
      repository,
      headBranch: record.headBranch,
      targetRef: record.targetRef,
      expectedHead: record.expectedHead,
      command,
      observed: actual,
      responseDigest: digestObject(actual),
      observedAt: nowIso(),
      absent: true
    };
  }
  const precondition = await captureCreationPrecondition(
    cwd,
    record.action,
    record.resource,
    record.provider === "github-cli" ? record.providerExecutable?.path : null,
    record.createRepository ?? record.providerAuthorization?.repository
  );
  if (precondition?.state !== "absent") {
    throw new Error("Failed owned-resource creation reconciliation found an existing provider resource; preserve the reservation and reconcile the provider outcome");
  }
  return {
    schemaVersion: 1,
    proofKind: `${record.provider}-${record.action}-absence`,
    resource: record.resource,
    observed: precondition,
    responseDigest: digestObject(precondition),
    observedAt: nowIso(),
    absent: true
  };
}

async function verifyGitHubProviderAuthorization(cwd, repository, executablePath) {
  if (!repository.startsWith("github.com/")) throw new Error("GitHub provider authorization requires a GitHub repository");
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath)) {
    throw new Error("GitHub provider authorization requires an absolute executable path");
  }
  const repositoryPath = repository.slice("github.com/".length);
  const actor = await readBoundGitHubApi(cwd, executablePath, "user");
  const metadata = await readBoundGitHubApi(cwd, executablePath, `repos/${repositoryPath}`);
  const permissions = metadata.permissions ?? {};
  const authorization = {
    provider: "github-cli",
    actor: actor.login,
    repository,
    permissions: {
      admin: permissions.admin === true,
      maintain: permissions.maintain === true,
      push: permissions.push === true
    }
  };
  if (
    typeof authorization.actor !== "string" || !authorization.actor ||
    metadata.full_name !== repositoryPath ||
    !Object.values(authorization.permissions).some(Boolean)
  ) {
    throw new Error("GitHub provider authorization is not bound to an authenticated actor with repository access");
  }
  return authorization;
}

function boundGitHubEnvironment(homePath = os.homedir()) {
  if (typeof homePath !== "string" || !path.isAbsolute(homePath) || path.resolve(homePath) !== homePath) {
    throw new Error("Bound GitHub CLI HOME must be an absolute canonical path");
  }
  const configHome = path.join(homePath, ".config");
  const env = {
    PATH: BOUND_GIT_PATH,
    HOME: homePath,
    XDG_CONFIG_HOME: configHome,
    GH_CONFIG_DIR: path.join(configHome, "gh"),
    GH_HOST: "github.com",
    LANG: "C",
    LC_ALL: "C",
    GH_PROMPT_DISABLED: "1"
  };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    if (typeof process.env[key] === "string" && process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function normalizeBoundGitHubEnvironment(candidate) {
  const base = boundGitHubEnvironment(candidate?.HOME ?? os.homedir());
  const allowed = new Set([
    "PATH", "HOME", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GH_HOST", "LANG", "LC_ALL", "GH_PROMPT_DISABLED",
    "GH_TOKEN", "GITHUB_TOKEN"
  ]);
  if (candidate !== undefined && (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))) {
    throw new Error("Bound GitHub CLI environment must be an object");
  }
  for (const key of Object.keys(candidate ?? {})) {
    if (!allowed.has(key)) throw new Error(`Bound GitHub CLI environment rejects ambient key ${key}`);
  }
  for (const key of ["PATH", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GH_HOST", "LANG", "LC_ALL", "GH_PROMPT_DISABLED"]) {
    if (candidate?.[key] !== undefined && candidate[key] !== base[key]) {
      throw new Error(`Bound GitHub CLI environment rejects mutable ${key}`);
    }
  }
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    if (candidate?.[key] !== undefined && (typeof candidate[key] !== "string" || !candidate[key] || /[\0\r\n]/.test(candidate[key]))) {
      throw new Error(`Bound GitHub CLI environment contains an invalid ${key}`);
    }
  }
  return {
    ...base,
    ...(candidate?.GH_TOKEN ? { GH_TOKEN: candidate.GH_TOKEN } : {}),
    ...(candidate?.GITHUB_TOKEN ? { GITHUB_TOKEN: candidate.GITHUB_TOKEN } : {})
  };
}

function boundGitHubCredentialEnvironment(homePath, credential) {
  if (typeof credential?.password !== "string" || !credential.password || /[\0\r\n]/.test(credential.password)) {
    throw new Error("Bound GitHub API credential is incomplete");
  }
  const env = boundGitHubEnvironment(homePath);
  // Remove every ambient token source before installing the exact token that
  // was captured for the subsequent Git operation.  This prevents `gh api`
  // from authenticating as a different actor than the credential-bearing
  // dry-run/push.
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  env.GH_TOKEN = credential.password;
  return env;
}

function isAuthoritativeGitHubNotFound(error) {
  if (error?.code !== 1) return false;
  const detail = [error?.stderr, error?.stdout, error?.message]
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? ""))
    .join("\n");
  return /\bHTTP\s*404\b|\b404\s+Not\s+Found\b/i.test(detail);
}

export async function readBoundGitHubApi(cwd, executablePath, endpoint, {
  credential = null,
  homePath = os.homedir(),
  allowNotFound = false
} = {}) {
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath) ||
      typeof endpoint !== "string" || !endpoint || /[\0\r\n]/.test(endpoint)) {
    throw new Error("Bound GitHub API request requires an absolute executable and canonical endpoint");
  }
  let result;
  try {
    result = await execBoundGitHubCli(executablePath, ["api", endpoint, "--hostname", "github.com"], {
      cwd,
      env: credential
        ? boundGitHubCredentialEnvironment(homePath, credential)
        : boundGitHubEnvironment(homePath)
    });
  } catch (error) {
    if (allowNotFound && isAuthoritativeGitHubNotFound(error)) return null;
    throw error;
  }
  return JSON.parse(result.stdout);
}

async function readBoundGitHubRefRevision(cwd, repository, ref, executablePath) {
  if (!repository.startsWith("github.com/") || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new Error("Bound GitHub ref observation requires a canonical repository and branch ref");
  }
  const repositoryPath = repository.slice("github.com/".length);
  const actual = await readBoundGitHubApi(
    cwd,
    executablePath,
    `repos/${repositoryPath}/git/ref/${ref.slice("refs/".length)}`
  );
  const revision = actual?.object?.sha;
  if (!/^[a-f0-9]{40}$/i.test(revision ?? "")) {
    throw new Error("Bound GitHub ref observation did not return an exact revision");
  }
  return revision;
}

export function githubDispatchRefEndpoint(repository, dispatchRef) {
  if (!repository.startsWith("github.com/")) {
    throw new Error("Bound GitHub workflow dispatch ref observation requires a canonical repository and ref");
  }
  const ref = canonicalWorkflowDispatchIdentity(dispatchRef);
  const [, kind, name] = ref.match(/^refs\/(heads|tags)\/(.+)$/);
  const repositoryPath = repository.slice("github.com/".length);
  return `repos/${repositoryPath}/git/ref/${kind}/${encodeURIComponent(name)}`;
}

async function readBoundGitHubDispatchRefRevision(cwd, repository, dispatchRef, executablePath) {
  const actual = await readBoundGitHubApi(
    cwd,
    executablePath,
    githubDispatchRefEndpoint(repository, dispatchRef)
  );
  const repositoryPath = repository.slice("github.com/".length);
  const revision = await resolveGitHubDispatchObjectRevision(
    actual?.object,
    async (tagSha) => readBoundGitHubApi(cwd, executablePath, `repos/${repositoryPath}/git/tags/${tagSha}`)
  );
  if (!SHA.test(revision ?? "")) {
    throw new Error("Bound GitHub workflow dispatch ref observation did not return an exact commit revision");
  }
  return revision;
}

export async function resolveGitHubDispatchObjectRevision(object, readTagObject) {
  let current = object;
  const seen = new Set();
  for (let depth = 0; depth <= 8; depth += 1) {
    const revision = current?.sha;
    if ((current?.type === undefined || current.type === "commit") && SHA.test(revision ?? "")) {
      return revision;
    }
    if (current?.type !== "tag" || !SHA.test(revision ?? "")) {
      throw new Error("Bound GitHub workflow dispatch ref observation returned a non-commit object");
    }
    if (seen.has(revision)) {
      throw new Error("Bound GitHub workflow dispatch tag resolution detected a cycle");
    }
    seen.add(revision);
    const tagObject = await readTagObject(revision);
    current = tagObject?.object;
  }
  throw new Error("Bound GitHub workflow dispatch tag resolution exceeded the maximum depth");
}

async function readOptionalBoundGitHubDispatchRefRevision(cwd, repository, dispatchRef, executablePath) {
  const actual = await readBoundGitHubApi(
    cwd,
    executablePath,
    githubDispatchRefEndpoint(repository, dispatchRef),
    { allowNotFound: true }
  );
  if (actual === null) return null;
  const repositoryPath = repository.slice("github.com/".length);
  const revision = await resolveGitHubDispatchObjectRevision(
    actual?.object,
    async (tagSha) => readBoundGitHubApi(cwd, executablePath, `repos/${repositoryPath}/git/tags/${tagSha}`)
  );
  if (!SHA.test(revision ?? "")) {
    throw new Error("Bound GitHub workflow dispatch ref observation did not return an exact commit revision");
  }
  return revision;
}

async function resolveBoundGitHubDispatchRef(cwd, repository, requestedRef, executablePath) {
  const ref = canonicalWorkflowRef(requestedRef);
  if (WORKFLOW_REF_IDENTITY.test(ref)) {
    return {
      ref,
      revision: await readBoundGitHubDispatchRefRevision(cwd, repository, ref, executablePath)
    };
  }
  const candidates = [];
  for (const kind of ["heads", "tags"]) {
    const candidateRef = `refs/${kind}/${ref}`;
    const revision = await readOptionalBoundGitHubDispatchRefRevision(cwd, repository, candidateRef, executablePath);
    if (revision !== null) candidates.push({ ref: candidateRef, revision });
  }
  if (candidates.length === 0) {
    throw new Error("GitHub Actions dispatch scope did not resolve to a branch or tag ref");
  }
  if (candidates.length > 1) {
    throw new Error("GitHub Actions dispatch scope is ambiguous between a branch and tag ref");
  }
  return candidates[0];
}

async function verifyGitPushCredential(
  cwd,
  { remote, pushUrl, pushUrlDigest, ref, revision, repository, sourceRemoteBindingDigest },
  expectedActor = null,
  {
    includeCredential = false,
    githubExecutablePath,
    gitExecutablePath = BOUND_GIT_EXECUTABLE
  } = {}
) {
  if (!repository.startsWith("github.com/")) {
    throw new Error("Git push authorization requires a GitHub-bound controlled push provider");
  }
  const destination = await resolveGitPushDestination(cwd, remote);
  if (
    destination.pushUrl !== pushUrl ||
    destination.pushUrlDigest !== pushUrlDigest ||
    destination.remoteRepository !== repository ||
    destination.sourceRemoteBindingDigest !== sourceRemoteBindingDigest
  ) {
    throw new Error("Git push credential binding does not match the authorized effective destination");
  }
  if (gitExecutablePath !== BOUND_GIT_EXECUTABLE || typeof githubExecutablePath !== "string") {
    throw new Error("Git push credential verification requires fixed Git and bound GitHub CLI executables");
  }
  const credentialActor = await verifyGitHubCredentialActor(cwd, pushUrl, repository, githubExecutablePath);
  const dryRunCommand = ["git", "push", "--dry-run", "--porcelain", pushUrl, `${revision}:${ref}`];
  await withBoundGitCredential(cwd, pushUrl, credentialActor.credential, gitExecutablePath, (context) =>
    execBoundGit(gitExecutablePath, buildBoundGitPushArgs(dryRunCommand, context.credentialFile, gitExecutablePath), {
      cwd,
      env: buildBoundGitPushEnvironment(context),
      timeoutMs: BOUND_GIT_TIMEOUT_MS,
      maxBuffer: BOUND_GIT_MAX_BUFFER
    })
  );
  if (expectedActor && credentialActor.actor !== expectedActor) {
    throw new Error("Git push credential actor does not match the authorized GitHub actor");
  }
  const binding = {
    provider: "git",
    repository,
    remote,
    pushUrlDigest,
    sourceRemoteBindingDigest,
    ref,
    revision,
    credentialCheck: "github-cli-token-actor",
    actor: credentialActor.actor,
    actorId: credentialActor.actorId,
    permissions: credentialActor.permissions,
    credentialSource: credentialActor.source
  };
  return includeCredential ? { binding, credential: credentialActor.credential } : binding;
}

async function verifyPullRequestBeforeMerge(cwd, record, providerExecutablePath = record.providerExecutable?.path) {
  if (record.targetRef === "dev" && !/^[a-f0-9]{40}$/i.test(record.remoteRevision ?? "")) {
    throw new Error("Protected dev merge requires the exact reviewed base revision");
  }
  const repository = await currentRepositoryIdentity(cwd);
  if (record.mergeRepository && repository !== record.mergeRepository) {
    throw new Error("PR merge origin repository changed after authorization");
  }
  if (!repository.startsWith("github.com/")) throw new Error("PR merge requires a GitHub repository");
  if (typeof providerExecutablePath !== "string" || !path.isAbsolute(providerExecutablePath)) {
    throw new Error("PR merge provider state requires an absolute recorded executable");
  }
  const actual = JSON.parse((await execBoundGitHubCli(providerExecutablePath, [
    "api", `repos/${repository.slice("github.com/".length)}/pulls/${record.pullRequest}`
  ], { cwd })).stdout);
  if (
      actual.number !== record.pullRequest ||
    actual.state !== "open" ||
    actual.head?.sha !== record.reviewedHead ||
    (record.targetRef && actual.base?.ref !== record.targetRef) ||
    (record.remoteRevision && actual.base?.sha !== record.remoteRevision) ||
    actual.mergeable !== true ||
    actual.mergeable_state !== "clean"
  ) {
    throw new Error("Live pull request state is not an exact clean merge candidate");
  }
}

async function verifyMergeProviderAtInvocation(root, runId, record, manifest) {
  if (record.reviewPackageId) {
    const { assertReviewContinuity } = await import("./review.mjs");
    await assertReviewContinuity(root, runId, {
      packageId: record.reviewPackageId,
      head: record.reviewedHead,
      continuityDigest: record.reviewContinuityDigest
    });
  }
  const providerExecutablePath = await verifyRecordedGitHubProvider(manifest, record);
  const repository = await currentRepositoryIdentity(manifest.cwd);
  if (repository !== record.mergeRepository) {
    throw new Error("PR merge provider repository changed before invocation");
  }
  const authorization = await verifyGitHubProviderAuthorization(manifest.cwd, repository, providerExecutablePath);
  if (digestObject(authorization) !== digestObject(record.providerAuthorization)) {
    throw new Error("PR merge provider actor or permission changed before invocation");
  }
  await verifyPullRequestBeforeMerge(manifest.cwd, record, providerExecutablePath);
  const run = await loadRun(root, runId);
  if (!run.contract.actionGates?.[record.action]?.includes("required-checks")) return authorization;
  const evidence = await listEffectiveEvidenceRecords(root, runId, { run });
  const requiredChecks = assertPersistedRequiredChecksEvidence(record, evidence, { repository });
  const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
  await validateTypedEvidenceRecord(requiredChecks, {
    manifest: run.manifest,
    contract: run.contract,
    root,
    runDir: run.runDir,
    requireReconciled: true
  });
  const checkVerification = await verifyRequiredChecksProvider(
    manifest.cwd,
    requiredChecks.receipt.payload,
    record.providerExecutable
  );
  const mergeAuthorization = assertPersistedMergeHumanAuthorizationEvidence(
    record,
    evidence,
    checkVerification,
    { actor: authorization.actor, repository }
  );
  if (mergeAuthorization) {
    await validateTypedEvidenceRecord(mergeAuthorization, {
      manifest: run.manifest,
      contract: run.contract,
      root,
      runDir: run.runDir,
      requireReconciled: true
    });
  }
  return authorization;
}

async function verifyCreateProviderAtInvocation(record, manifest) {
  const providerExecutablePath = await verifyRecordedGitHubProvider(manifest, record);
  const repository = await currentRepositoryIdentity(manifest.cwd);
  if (repository !== record.createRepository) {
    throw new Error("PR creation provider repository changed before invocation");
  }
  const authorization = await verifyGitHubProviderAuthorization(manifest.cwd, repository, providerExecutablePath);
  if (digestObject(authorization) !== digestObject(record.providerAuthorization)) {
    throw new Error("PR creation provider actor or permission changed before invocation");
  }
  const currentHead = (await execBoundGitAuthority(manifest.cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  const currentBranch = (await execBoundGitAuthority(manifest.cwd, ["branch", "--show-current"])).stdout.trim();
  if (currentHead !== record.expectedHead || currentBranch !== record.headBranch) {
    throw new Error("PR creation candidate changed before invocation");
  }
  const branchRef = `refs/heads/${record.headBranch}`;
  const remoteHead = await readBoundGitHubRefRevision(
    manifest.cwd,
    repository,
    branchRef,
    providerExecutablePath
  );
  if (remoteHead !== record.expectedHead) {
    throw new Error("PR creation requires the pushed candidate branch to match the reviewed head");
  }
  const targetRef = `refs/heads/${record.targetRef}`;
  const remoteBase = await readBoundGitHubRefRevision(
    manifest.cwd,
    repository,
    targetRef,
    providerExecutablePath
  );
  if (record.remoteRevision && remoteBase !== record.remoteRevision) {
    throw new Error("PR creation target branch changed before invocation");
  }
  return authorization;
}

function assertRecomputedProviderReceipt(receipt, request, response, executionId) {
  if (
    receipt.requestDigest !== digestObject(request) ||
    receipt.responseDigest !== digestObject(response) ||
    receipt.executionId !== executionId
  ) {
    throw new Error("Provider receipt digests or execution identity do not match the observed provider result");
  }
}

async function verifyPluginCachePublicationReceipt(manifest, record, providerReceipt) {
  const { captureSourceBinding } = await import("./git.mjs");
  const { bundleDigest, checkPluginCache } = await import("./publication.mjs");
  const repositoryRoot = await realpath(path.resolve(manifest.cwd));
  const sourceRoot = path.join(repositoryRoot, "plugins", "better-workflows");
  const expectedCacheRoot = record.cacheRoot;
  if (
    providerReceipt.sourceRoot !== sourceRoot ||
    manifest.pluginCacheRoot !== expectedCacheRoot ||
    expectedCacheRoot !== getCodexPluginCacheRoot() ||
    typeof providerReceipt.cacheRoot !== "string" ||
    !path.isAbsolute(providerReceipt.cacheRoot) ||
    path.resolve(providerReceipt.cacheRoot) !== providerReceipt.cacheRoot ||
    providerReceipt.cacheRoot !== expectedCacheRoot ||
    providerReceipt.resource !== `plugin-cache:${providerReceipt.sourceHeadRevision}`
  ) {
    throw new Error("Plugin cache publication receipt is not bound to the canonical source, installed cache root, and resource");
  }
  const cacheRootInfo = await lstat(providerReceipt.cacheRoot).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!cacheRootInfo || cacheRootInfo.isSymbolicLink() || !cacheRootInfo.isDirectory()) {
    throw new Error("Plugin cache publication receipt cache root is missing or unsafe");
  }
  if (await realpath(providerReceipt.cacheRoot) !== providerReceipt.cacheRoot) {
    throw new Error("Plugin cache publication receipt cache root is not canonical");
  }
  const expectedFields = [
    "sourceBaselineRevision",
    "sourceHeadRevision",
    "sourceBindingDigest",
    "pluginBundleDigest"
  ];
  if (
    !SHA.test(providerReceipt.sourceBaselineRevision) ||
    !SHA.test(providerReceipt.sourceHeadRevision) ||
    expectedFields.slice(2).some((field) => !SHA256_DIGEST.test(providerReceipt[field])) ||
    typeof providerReceipt.version !== "string" ||
    typeof providerReceipt.target !== "string" ||
    providerReceipt.target !== path.join(providerReceipt.cacheRoot, providerReceipt.version)
  ) {
    throw new Error("Plugin cache publication receipt source or target binding is invalid");
  }
  const sourceBinding = await captureSourceBinding(repositoryRoot, {
    baseRevision: providerReceipt.sourceBaselineRevision,
    requireClean: true
  });
  if (
    sourceBinding.headRevision !== providerReceipt.sourceHeadRevision ||
    sourceBinding.digest !== providerReceipt.sourceBindingDigest
  ) {
    throw new Error("Plugin cache publication provider reconciliation detected source drift");
  }
  const actualBundleDigest = await bundleDigest(sourceRoot);
  if (actualBundleDigest !== providerReceipt.pluginBundleDigest) {
    throw new Error("Plugin cache publication provider reconciliation detected bundle drift");
  }
  const cache = await checkPluginCache({ sourceRoot, cacheRoot: providerReceipt.cacheRoot });
  if (
    !cache.ok ||
    cache.version !== providerReceipt.version ||
    cache.target !== providerReceipt.target ||
    cache.sourceDigest !== providerReceipt.sourceDigest ||
    cache.targetDigest !== providerReceipt.targetDigest
  ) {
    throw new Error("Plugin cache publication provider reconciliation does not match the live cache");
  }
  const request = {
    action: record.action,
    provider: record.provider,
    resource: record.resource,
    remoteRevision: record.remoteRevision,
    idempotencyKey: record.idempotencyKey,
    sourceRoot,
    cacheRoot: providerReceipt.cacheRoot,
    sourceBaselineRevision: providerReceipt.sourceBaselineRevision,
    sourceHeadRevision: providerReceipt.sourceHeadRevision,
    sourceBindingDigest: providerReceipt.sourceBindingDigest,
    pluginBundleDigest: providerReceipt.pluginBundleDigest
  };
  const response = {
    applied: providerReceipt.applied === true,
    noOp: providerReceipt.noOp === true,
    status: cache.status,
    version: providerReceipt.version,
    target: providerReceipt.target,
    sourceDigest: cache.sourceDigest,
    targetDigest: cache.targetDigest
  };
  assertRecomputedProviderReceipt(
    providerReceipt,
    request,
    response,
    `local-workspace:plugin.cache.publish:${record.attemptId}`
  );
}

async function verifyOwnedResourceCreationProof(manifest, record, providerReceipt) {
  if (!OWNED_RESOURCE_CREATION_ACTIONS.has(record.action) || record.outcome !== "success") return;
  const providerExecutablePath = record.provider === "github-cli"
    ? await verifyRecordedGitHubProvider(manifest, record)
    : null;
  const proof = providerReceipt.creationProof;
  const marker = `sbw:${record.attemptId}:${record.idempotencyKey}`;
  const spentAt = Date.parse(record.spentAt ?? "");
  if (!Number.isFinite(spentAt)) throw new Error("Owned resource creation action lacks a valid consumed timestamp");
  if (record.action === "pr.create" && record.provider === "github-cli" && providerReceipt.ownershipTransfer) {
    await verifyTransferredPullRequestOwnership(manifest, record, providerReceipt, providerExecutablePath);
    return providerExecutablePath;
  }
  if (proof.marker !== marker || proof.attemptId !== record.attemptId || proof.idempotencyKey !== record.idempotencyKey) {
    throw new Error("Owned resource provider-native marker is not bound to the consumed action");
  }
  // GitHub and Git provider timestamps are commonly second-granular.
  const minimumObservedAt = spentAt - 2000;
  const assertObservedAt = (value, label) => {
    const observedAt = Date.parse(value ?? "");
    if (!Number.isFinite(observedAt) || observedAt < minimumObservedAt) {
      throw new Error(`${label} was not created after the action was consumed`);
    }
    return observedAt;
  };
  if (record.action === "branch.create" && record.provider === "git") {
    const ref = record.resource.slice("branch:".length);
    const actual = (await execBoundGitAuthority(manifest.cwd, ["rev-parse", "--verify", `refs/heads/${ref}^{commit}`])).stdout.trim();
    const reflog = (await execBoundGitAuthority(manifest.cwd, [
      "reflog", "show", "--date=iso-strict", "--format=%H%x00%gs%x00%gd", "-1", `refs/heads/${ref}`
    ])).stdout.trim();
    const [revision, subject, selector] = reflog.split("\0");
    const observedAt = selector?.match(/@\{(.+)\}$/)?.[1] ?? "";
    if (
      actual !== providerReceipt.revision ||
      revision !== actual ||
      !subject?.includes(marker) ||
      !Number.isFinite(Date.parse(observedAt)) ||
      Date.parse(observedAt) < minimumObservedAt ||
      proof.providerObjectId !== `${ref}:${actual}`
    ) {
      throw new Error("Git branch creation proof is missing the provider-native marked reflog event");
    }
    return;
  }
  if (record.action === "worktree.create" && record.provider === "git") {
    const worktreePath = record.resource.slice("worktree:".length);
    const output = (await execBoundGitAuthority(manifest.cwd, ["worktree", "list", "--porcelain"])).stdout;
    const match = output.split(/\n\n+/).map((block) => Object.fromEntries(
      block.split("\n").filter(Boolean).map((line) => {
        const separator = line.indexOf(" ");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
    )).find((item) => item.worktree === worktreePath);
    if (!match || match.HEAD !== providerReceipt.revision || proof.providerObjectId !== `${worktreePath}:${match.HEAD}`) {
      throw new Error("Git worktree creation proof does not match the live provider object");
    }
    const markerValue = (await execBoundGitAuthority(manifest.cwd, [
      "-C", worktreePath, "config", "--local", "--no-includes", "--get", "sbw.creation-marker"
    ])).stdout.trim();
    const attemptValue = (await execBoundGitAuthority(manifest.cwd, [
      "-C", worktreePath, "config", "--local", "--no-includes", "--get", "sbw.action-attempt"
    ])).stdout.trim();
    const worktreeMtime = (await stat(path.resolve(manifest.cwd, worktreePath))).mtimeMs;
    assertObservedAt(proof.observedAt, "Git worktree");
    if (markerValue !== marker || attemptValue !== record.attemptId || worktreeMtime < minimumObservedAt) {
      throw new Error("Git worktree creation proof lacks the provider-native marker and creation timestamp");
    }
    return;
  }
  if (record.action === "pr.create" && record.provider === "github-cli") {
    const repository = record.createRepository ?? record.providerAuthorization?.repository;
    if (!repository || await currentRepositoryIdentity(manifest.cwd) !== repository || repository !== record.providerAuthorization?.repository) {
      throw new Error("GitHub pull request creation proof repository is not bound to the authorized repository");
    }
    const actual = JSON.parse((await execBoundGitHubCli(providerExecutablePath, [
      "api", `repos/${repository.slice("github.com/".length)}/pulls/${providerReceipt.number}`
    ], { cwd: manifest.cwd })).stdout);
    const createdAt = assertObservedAt(actual.created_at, "GitHub pull request");
    const actor = record.providerAuthorization?.actor;
    if (
      actual.node_id !== proof.providerObjectId ||
      actual.user?.login !== actor ||
      (record.expectedHead && actual.head?.sha !== record.expectedHead) ||
      typeof actual.body !== "string" ||
      !actual.body.includes(`<!-- ${marker} -->`) ||
      providerReceipt.url !== actual.html_url ||
      proof.observedAt !== actual.created_at ||
      createdAt < minimumObservedAt
    ) {
      throw new Error("GitHub pull request creation proof lacks provider-native actor, timestamp, or idempotency marker");
    }
    return providerExecutablePath;
  }
  if (record.action === "actions.dispatch" && record.provider === "github-cli") {
    const actual = JSON.parse((await execBoundGitHubCli(providerExecutablePath, [
      "run", "view", String(providerReceipt.runId), "--json",
      "databaseId,workflowName,url,status,conclusion,headSha,createdAt,displayTitle,actor"
    ], { cwd: manifest.cwd })).stdout);
    const createdAt = assertObservedAt(actual.createdAt, "GitHub Actions run");
    if (
      String(actual.databaseId) !== String(proof.providerObjectId) ||
      actual.actor?.login !== record.providerAuthorization?.actor ||
      typeof actual.displayTitle !== "string" ||
      !actual.displayTitle.includes(marker) ||
      actual.headSha !== record.remoteRevision ||
      proof.observedAt !== actual.createdAt ||
      createdAt < minimumObservedAt
    ) {
      throw new Error("GitHub Actions creation proof lacks provider-native actor, timestamp, or idempotency marker");
    }
    return providerExecutablePath;
  }
}

function ownershipTransferAuthorizationPayload(transfer, record, repository, number) {
  return {
    schemaVersion: 1,
    kind: "host-signed-ownership-transfer-authorization",
    sourceRunId: transfer.sourceRunId,
    sourceResource: `pull/${number}`,
    sourceAttemptId: transfer.sourceAttemptId,
    sourceActionDigest: transfer.sourceActionDigest,
    sourceMarker: transfer.sourceMarker,
    targetRunId: record.runId,
    targetAttemptId: record.attemptId,
    repository,
    number
  };
}

export async function verifyTransferredPullRequestOwnership(manifest, record, providerReceipt, providerExecutablePath) {
  const transfer = providerReceipt.ownershipTransfer;
  if (!transfer || typeof transfer !== "object" || Array.isArray(transfer)) {
    throw new Error("Transferred pull request ownership proof is missing");
  }
  const repository = record.createRepository ?? record.providerAuthorization?.repository;
  const sourceResource = `pull/${providerReceipt.number}`;
  const authorizationPayload = ownershipTransferAuthorizationPayload(
    transfer,
    record,
    repository,
    providerReceipt.number
  );
  const authorizationAttestation = transfer.authorizationAttestation;
  if (
    transfer.schemaVersion !== 1 ||
    Object.hasOwn(transfer, "authorization") ||
    transfer.targetRunId !== record.runId ||
    transfer.targetAttemptId !== record.attemptId ||
    typeof transfer.sourceRunId !== "string" ||
    transfer.sourceRunId === record.runId ||
    transfer.sourceResource !== sourceResource ||
    typeof transfer.sourceAttemptId !== "string" ||
    typeof transfer.sourceMarker !== "string" ||
    !transfer.sourceMarker.startsWith("sbw:") ||
    typeof transfer.sourceActionDigest !== "string" ||
    !SHA256_DIGEST.test(transfer.sourceActionDigest) ||
    typeof transfer.authorizationDigest !== "string" ||
    transfer.authorizationDigest !== digestObject(authorizationPayload) ||
    typeof transfer.transferredAt !== "string" ||
    !Number.isFinite(Date.parse(transfer.transferredAt)) ||
    !authorizationAttestation ||
    typeof authorizationAttestation !== "object" ||
    Array.isArray(authorizationAttestation) ||
    Object.keys(authorizationAttestation).sort().join("\0") !== "attestationDigest\0fileDigest\0path" ||
    typeof authorizationAttestation.path !== "string" ||
    !path.isAbsolute(authorizationAttestation.path) ||
    path.resolve(authorizationAttestation.path) !== authorizationAttestation.path ||
    !SHA256_DIGEST.test(authorizationAttestation.attestationDigest ?? "") ||
    !SHA256_DIGEST.test(authorizationAttestation.fileDigest ?? "")
  ) {
    throw new Error("Transferred pull request ownership proof is malformed or lacks a host-signed authorization receipt");
  }
  const authorizationBinding = {
    base: record.remoteRevision,
    head: providerReceipt.head,
    instructionDigest: transfer.authorizationDigest,
    model: "ownership-transfer-authorization",
    packageId: `ownership-transfer-${transfer.authorizationDigest}`,
    promptDigest: transfer.authorizationDigest,
    reviewDigest: transfer.authorizationDigest,
    reviewerId: "better-workflows-ownership-transfer",
    runId: record.runId,
    sentinelDigest: record.treeDigest
  };
  if (
    !SHA.test(authorizationBinding.base) ||
    !SHA.test(authorizationBinding.head) ||
    !SHA256_DIGEST.test(authorizationBinding.sentinelDigest ?? "")
  ) {
    throw new Error("Transferred pull request ownership authorization is missing exact action bindings");
  }
  const { verifyTrustedNativeCriticAttestation } = await import("./providers.mjs");
  const attestation = await verifyTrustedNativeCriticAttestation({
    attestationPath: authorizationAttestation.path,
    workspaceRoot: manifest.cwd,
    binding: authorizationBinding
  });
  const authorizationFileDigest = sha256(await readFile(authorizationAttestation.path));
  if (
    authorizationFileDigest !== authorizationAttestation.fileDigest ||
    attestation.attestationDigest !== authorizationAttestation.attestationDigest
  ) {
    throw new Error("Transferred pull request ownership authorization receipt digest changed");
  }
  const transferredAt = Date.parse(transfer.transferredAt);
  const issuedAt = Date.parse(attestation.issuedAt ?? "");
  const expiresAt = Date.parse(attestation.expiresAt ?? "");
  if (
    !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) ||
    issuedAt > transferredAt || expiresAt <= transferredAt ||
    transferredAt > Date.now() + 300_000
  ) {
    throw new Error("Transferred pull request ownership authorization receipt is expired or was issued after transfer");
  }
  const root = getStateRoot();
  const sourceRun = await loadRun(root, transfer.sourceRunId);
  if (!["cancelled_superseded", "cancelled_evidence_sufficient"].includes(sourceRun.state.status)) {
    throw new Error("Transferred pull request ownership requires a terminal superseded source run");
  }
  const sourceRegistered = sourceRun.manifest.ownedResources?.find((entry) => (
    entry?.resource === sourceResource && entry.ownerRunId === transfer.sourceRunId
  ));
  if (
    sourceRun.contract.remoteRevision !== record.remoteRevision ||
    sourceRun.manifest.sourceBinding?.originIdentity?.digest !== manifest.sourceBinding?.originIdentity?.digest ||
    !sourceRegistered ||
    typeof sourceRegistered.receiptDigest !== "string" ||
    typeof sourceRegistered.creationActionDigest !== "string"
  ) {
    throw new Error("Transferred pull request ownership source run or registry is not bound to the target repository");
  }
  const sourceActions = await listJsonRecords(root, safeJoin(sourceRun.runDir, "actions"));
  const sourceAction = sourceActions.find((action) => (
    action.attemptId === transfer.sourceAttemptId &&
    action.action === "pr.create" &&
    action.provider === "github-cli" &&
    action.status === "spent" &&
    action.outcome === "success" &&
    action.ownedResource === sourceResource
  ));
  const sourceProviderReceipt = sourceAction?.receipt?.providerReceipt;
  const sourceMarker = sourceProviderReceipt?.ownershipTransfer?.sourceMarker ?? sourceProviderReceipt?.creationProof?.marker;
  if (
    !sourceAction ||
    digestObject(sourceAction) !== transfer.sourceActionDigest ||
    !sourceProviderReceipt ||
    sourceProviderReceipt.number !== providerReceipt.number ||
    sourceProviderReceipt.url !== providerReceipt.url ||
    sourceProviderReceipt.base !== providerReceipt.base ||
    sourceProviderReceipt.provider !== "github-cli" ||
    sourceMarker !== transfer.sourceMarker ||
    typeof sourceProviderReceipt.head !== "string" ||
    !SHA.test(sourceProviderReceipt.head)
  ) {
    throw new Error("Transferred pull request ownership source receipt is not bound to the provider object");
  }
  if (
    sourceRegistered.creationAttemptId !== sourceAction.attemptId ||
    sourceRegistered.creationActionDigest !== ownedResourceCreationActionDigest(sourceAction)
  ) {
    throw new Error("Transferred pull request ownership source registry is not bound to its immutable creation receipt");
  }
  if (
    !repository ||
    await currentRepositoryIdentity(manifest.cwd) !== repository ||
    repository !== record.providerAuthorization?.repository
  ) {
    throw new Error("Transferred pull request ownership repository changed after authorization");
  }
  const actual = JSON.parse((await execBoundGitHubCli(providerExecutablePath, [
    "api", `repos/${repository.slice("github.com/".length)}/pulls/${providerReceipt.number}`
  ], { cwd: manifest.cwd })).stdout);
  const currentMarker = `<!-- ${transfer.sourceMarker} -->`;
  if (
    actual.node_id !== providerReceipt.creationProof?.providerObjectId ||
    actual.user?.login !== record.providerAuthorization?.actor ||
    actual.head?.sha !== providerReceipt.head ||
    (record.expectedHead && actual.head?.sha !== record.expectedHead) ||
    actual.base?.ref !== providerReceipt.base ||
    (record.targetRef && actual.base?.ref !== record.targetRef) ||
    actual.html_url !== providerReceipt.url ||
    typeof actual.body !== "string" ||
    !actual.body.includes(currentMarker) ||
    actual.state !== "open"
  ) {
    throw new Error("Transferred pull request ownership proof does not match the live provider object");
  }
  const ancestry = await execBoundGitAuthority(manifest.cwd, [
    "merge-base", "--is-ancestor", sourceProviderReceipt.head, providerReceipt.head
  ]).catch(() => null);
  if (!ancestry) {
    throw new Error("Transferred pull request ownership requires the target head to descend from the source head");
  }
  if (providerReceipt.creationProof?.observedAt !== actual.created_at) {
    throw new Error("Transferred pull request ownership proof timestamp does not match the provider object");
  }
}

async function verifyProviderReceipt(manifest, record, receipt, contract = null) {
  const shouldVerifyDispatchFailure = (
    record.action === "actions.dispatch" &&
    record.provider === "github-cli" &&
    record.outcome === "failure"
  );
  const shouldVerifyDispatchRun = (
    record.action === "actions.dispatch" &&
    record.provider === "github-cli" &&
    record.providerInvocation?.workflowRun
  );
  if (record.outcome !== "success" && !shouldVerifyDispatchFailure && !shouldVerifyDispatchRun) return;
  const providerReceipt = receipt.providerReceipt;
  const cwd = manifest.cwd;
  const key = `${record.action}:${record.provider}`;
  if (key === "actions.dispatch:github-cli" && providerReceipt.dispatchState === "not-sent") {
    if (record.outcome !== "failure" || record.providerInvocation?.provider !== "github-cli" ||
        record.providerInvocation?.dispatchState !== "not-sent" ||
        providerReceipt.invocationId !== record.providerInvocation?.id ||
        providerReceipt.errorDigest !== record.providerInvocation?.errorDigest ||
        providerReceipt.responseDigest !== digestObject(actionsDispatchNotSentReceiptResponse(record, record.providerInvocation))) {
      throw new Error("GitHub Actions not-sent proof is not bound to the host preflight invocation");
    }
    assertRecomputedProviderReceipt(
      providerReceipt,
      actionsDispatchReceiptRequest(record),
      actionsDispatchNotSentReceiptResponse(record, record.providerInvocation),
      `github:${canonicalGitHubRepository(record.dispatchRepository)}:actions.dispatch:not-sent:${record.runId}:${record.attemptId}`
    );
    return;
  }
  if (key === "git.push:git" || key === "remote.sync:git") {
    const currentSourceBinding = await assertCurrentGitPushSourceBinding(manifest, record.sourceBindingDigest);
    if (
      currentSourceBinding.digest !== record.sourceBindingDigest ||
      providerReceipt.sourceBindingDigest !== currentSourceBinding.digest ||
      currentSourceBinding.originIdentity?.digest !== record.sourceRemoteBindingDigest ||
      providerReceipt.sourceRemoteBindingDigest !== currentSourceBinding.originIdentity?.digest
    ) {
      throw new Error("Git provider reconciliation denied because the immutable source or raw remote binding changed");
    }
  }
  if (key === "plugin.cache.publish:local-workspace") {
    await verifyPluginCachePublicationReceipt(manifest, record, providerReceipt);
    return;
  }
  const providerExecutablePath = record.provider === "github-cli"
    ? record.providerAuthorization
      ? await verifyRecordedGitHubProvider(manifest, record)
      : (await verifyRecordedGitHubExecutable(record)).path
    : await verifyOwnedResourceCreationProof(manifest, record, providerReceipt);
  if (key === "recipe.promote:local-workspace" || key === "artifact.promote:local-workspace") {
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, idempotencyKey: record.idempotencyKey },
      { kind: providerReceipt.kind, digest: providerReceipt.digest },
      `local-workspace:${record.action}:${record.attemptId}`
    );
    return;
  }
  if (key === "branch.create:git") {
    const expectedRef = record.resource.startsWith("branch:")
      ? record.resource.slice("branch:".length)
      : null;
    if (!expectedRef || providerReceipt.ref !== expectedRef) {
      throw new Error("Git branch creation proof is not bound to the requested resource");
    }
    const actual = (await execBoundGitAuthority(cwd, [
      "rev-parse", "--verify", `refs/heads/${providerReceipt.ref}^{commit}`
    ])).stdout.trim();
    const repository = await currentGitProviderIdentity(cwd);
    const response = { ref: providerReceipt.ref, revision: actual };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `git:${repository}:branch.create:${providerReceipt.ref}:${actual}`
    );
    if (actual !== providerReceipt.revision) throw new Error("Git branch creation proof does not match provider state");
    return;
  }
  if (key === "worktree.create:git") {
    const expectedPath = record.resource.startsWith("worktree:")
      ? record.resource.slice("worktree:".length)
      : null;
    if (!expectedPath || providerReceipt.path !== expectedPath) {
      throw new Error("Git worktree creation proof is not bound to the requested resource");
    }
    const output = (await execBoundGitAuthority(cwd, ["worktree", "list", "--porcelain"])).stdout;
    const blocks = output.split(/\n\n+/).map((block) => Object.fromEntries(
      block.split("\n").filter(Boolean).map((line) => {
        const separator = line.indexOf(" ");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
    ));
    const match = blocks.find((item) => item.worktree === providerReceipt.path);
    if (!match || match.HEAD !== providerReceipt.revision) {
      throw new Error("Git worktree creation proof does not match provider state");
    }
    const repository = await currentGitProviderIdentity(cwd);
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      { path: providerReceipt.path, revision: match.HEAD },
      `git:${repository}:worktree.create:${providerReceipt.path}:${match.HEAD}`
    );
    return;
  }
  if (key === "git.commit:git") {
    const actual = (await execBoundGitAuthority(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    const repository = await currentGitProviderIdentity(cwd);
    const response = { repository, revision: actual };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `git:${repository}:git.commit:${actual}`
    );
    if (actual !== providerReceipt.revision || (record.resource.startsWith("commit:") && actual !== record.resource.slice("commit:".length))) {
      throw new Error("Git commit proof does not match provider state");
    }
    if (record.autonomyDecision?.decision === "auto-approved") {
      if (!contract?.autonomyProfile) {
        throw new Error("Autonomous Git commit proof requires its bounded TaskContract");
      }
      await verifyAutonomousCommitTransition(manifest, contract, record);
    }
    return;
  }
  if (key === "git.push:git") {
    const [, remote, ref] = GIT_PUSH_RESOURCE.exec(record.resource) ?? [];
    const currentSourceBinding = await assertCurrentGitPushSourceBinding(manifest, record.sourceBindingDigest);
    if (currentSourceBinding.originIdentity.digest !== record.sourceRemoteBindingDigest) {
      throw new Error("Git push proof does not match the current complete source binding");
    }
    const destination = await resolveGitPushDestination(cwd, remote);
    if (
      destination.pushUrl !== record.pushUrl ||
      destination.pushUrlDigest !== record.pushUrlDigest ||
      destination.remoteRepository !== record.remoteRepository ||
      destination.sourceRemoteBindingDigest !== record.sourceRemoteBindingDigest
    ) {
      throw new Error("Git push proof does not match the effective destination bound when the action token was issued");
    }
    const githubExecutablePath = await verifyRecordedGitHubProvider(manifest, record);
    const revision = await readBoundGitHubRefRevision(cwd, destination.remoteRepository, ref, githubExecutablePath);
    const repository = destination.remoteRepository;
    const pushUrlDigest = destination.pushUrlDigest;
    const localRevision = (await execBoundGitAuthority(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
    if (localRevision !== record.expectedRevision || revision !== record.expectedRevision) {
      throw new Error("Git push proof does not match the candidate commit bound when the action token was issued");
    }
    const response = {
      repository,
      remote,
      ref,
      revision,
      localRevision,
      expectedBranch: record.expectedBranch,
      expectedRevision: record.expectedRevision,
      pushUrlDigest,
      sourceBindingDigest: record.sourceBindingDigest,
      sourceRemoteBindingDigest: record.sourceRemoteBindingDigest
    };
    assertRecomputedProviderReceipt(
      providerReceipt,
      {
        action: record.action,
        provider: record.provider,
        resource: record.resource,
        remoteRevision: record.remoteRevision,
        repository,
        remote,
        ref,
        remoteRepository: record.remoteRepository,
        pushUrlDigest: record.pushUrlDigest,
        sourceBindingDigest: record.sourceBindingDigest,
        sourceRemoteBindingDigest: record.sourceRemoteBindingDigest,
        expectedBranch: record.expectedBranch,
        expectedRevision: record.expectedRevision
      },
      response,
      `git:${repository}:${remote}:git.push:${ref}:${revision}`
    );
    if (
      revision !== providerReceipt.revision ||
      providerReceipt.localRevision !== localRevision ||
      providerReceipt.expectedBranch !== record.expectedBranch ||
      providerReceipt.expectedRevision !== record.expectedRevision
    ) throw new Error("Git push proof does not match provider state");
    return;
  }
  if (key === "branch.delete:git") {
    const expectedRef = record.resource.startsWith("branch:") ? record.resource.slice("branch:".length) : null;
    if (!expectedRef || providerReceipt.ref !== expectedRef) throw new Error("Git branch deletion proof is not bound to the requested resource");
    const repository = await currentGitProviderIdentity(cwd);
    const presentRevision = await resolveOptionalBoundBranchRevision(
      (args, options) => execBoundGitAuthority(cwd, args, options),
      `refs/heads/${expectedRef}`,
      "Git branch deletion verification"
    );
    if (presentRevision !== null) throw new Error("Git branch deletion proof does not match provider state");
    const response = { ref: expectedRef, deleted: true };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `git:${repository}:branch.delete:${expectedRef}`
    );
    return;
  }
  if (key === "pr.create:github-cli") {
    const actual = JSON.parse((await execBoundGitHubCli(providerExecutablePath, [
      "pr", "view", String(providerReceipt.number), "--json", "number,headRefOid,baseRefName,url"
    ], { cwd })).stdout);
    const repository = record.createRepository ?? record.providerAuthorization?.repository;
    if (!repository || await currentRepositoryIdentity(cwd) !== repository) {
      throw new Error("GitHub pull request creation proof repository changed after authorization");
    }
    const response = {
      number: actual.number,
      head: actual.headRefOid,
      base: actual.baseRefName,
      url: actual.url
    };
    if (providerReceipt.ownershipTransfer) {
      await verifyTransferredPullRequestOwnership(manifest, record, providerReceipt, providerExecutablePath);
    }
    const request = {
      action: record.action,
      provider: record.provider,
      resource: record.resource,
      remoteRevision: record.remoteRevision,
      repository,
      targetRef: record.targetRef ?? null,
      expectedHead: record.expectedHead ?? null,
      ...(providerReceipt.ownershipTransfer ? { ownershipTransfer: providerReceipt.ownershipTransfer } : {})
    };
    assertRecomputedProviderReceipt(
      providerReceipt,
      request,
      response,
      providerReceipt.ownershipTransfer
        ? `github:${repository}:pr.transfer:${record.runId}:${record.attemptId}:${actual.number}:${actual.headRefOid}`
        : `github:${repository}:pr.create:${actual.number}:${actual.headRefOid}`
    );
    if (
      (record.resource !== "pull/new" && actual.number !== Number(String(record.resource).replace(/^pull\//, ""))) ||
      actual.number !== providerReceipt.number ||
      actual.headRefOid !== providerReceipt.head ||
      (record.expectedHead && actual.headRefOid !== record.expectedHead) ||
      actual.baseRefName !== providerReceipt.base ||
      (record.targetRef && actual.baseRefName !== record.targetRef) ||
      actual.url !== providerReceipt.url
    ) throw new Error("GitHub pull request creation proof does not match provider state");
    return;
  }
  if (key === "issue.create:github-cli") {
    const actual = JSON.parse((await execBoundGitHubCli(providerExecutablePath, [
      "issue", "view", String(providerReceipt.number), "--json", "number,state,url"
    ], { cwd })).stdout);
    const repository = await currentRepositoryIdentity(cwd);
    const response = { number: actual.number, state: actual.state, url: actual.url };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `github:${repository}:issue.create:${actual.number}`
    );
    if (
      actual.number !== providerReceipt.number ||
      actual.url !== providerReceipt.url ||
      providerReceipt.repository !== repository ||
      (record.resource.startsWith("issue/") && actual.number !== Number(record.resource.slice("issue/".length)))
    ) throw new Error("GitHub issue creation proof does not match provider state");
    return;
  }
  if (key === "actions.dispatch:github-cli") {
    if (!workflowResourceMatchesFile(record)) {
      throw new Error("GitHub Actions dispatch proof resource is not bound to workflowFile");
    }
    const actual = JSON.parse((await execBoundGitHubCli(providerExecutablePath, [
      "run", "view", String(providerReceipt.runId), "--repo", canonicalGitHubRepositoryPath(record.dispatchRepository), "--json", "databaseId,workflowName,url,status,conclusion,headSha,displayTitle"
    ], { cwd })).stdout);
    const repository = await currentRepositoryIdentity(cwd);
    if (repository !== canonicalGitHubRepository(record.dispatchRepository)) {
      throw new Error("GitHub Actions dispatch proof repository changed after authorization");
    }
    const response = {
      runId: String(actual.databaseId),
      workflowName: actual.workflowName,
      url: actual.url,
      status: actual.status,
      conclusion: actual.conclusion,
      headSha: actual.headSha,
      displayTitle: actual.displayTitle,
      dispatchNonce: record.dispatchNonce,
      workflowDispatchCapabilityDigest: record.workflowDispatchCapabilityDigest
    };
    assertRecomputedProviderReceipt(
      providerReceipt,
      actionsDispatchReceiptRequest(record),
      response,
      `github:${repository}:actions.dispatch:${actual.databaseId}`
    );
    const liveConclusionMatchesOutcome = record.outcome === "unknown"
      ? actual.status !== "completed" || typeof actual.conclusion !== "string" || actual.conclusion.length === 0
      : workflowDispatchConclusionMatchesOutcome(actual.status, actual.conclusion, record.outcome);
    if (
      String(actual.databaseId) !== String(providerReceipt.runId) ||
      actual.url !== providerReceipt.url ||
      !liveConclusionMatchesOutcome ||
      actual.headSha !== record.remoteRevision ||
      typeof actual.displayTitle !== "string" ||
      !WORKFLOW_DISPATCH_NONCE.test(String(record.dispatchNonce ?? "")) ||
      !actual.displayTitle.includes(record.dispatchNonce) ||
      actual.workflowName !== providerReceipt.workflowName ||
      providerReceipt.repository !== repository ||
      providerReceipt.workflowFile !== record.workflowFile ||
      providerReceipt.ref !== record.dispatchRef ||
      providerReceipt.dispatchNonce !== record.dispatchNonce ||
      providerReceipt.displayTitle !== actual.displayTitle ||
      providerReceipt.workflowDispatchCapabilityDigest !== record.workflowDispatchCapabilityDigest ||
      providerReceipt.dispatchInputsDigest !== record.dispatchInputsDigest ||
      providerReceipt.invocationId !== record.providerInvocation?.id
    ) throw new Error("GitHub Actions dispatch proof does not match provider state");
    return;
  }
  if (key === "actions.cancel:github-cli") {
    const actual = JSON.parse((await execBoundGitHubCli(providerExecutablePath, [
      "run", "view", String(providerReceipt.runId), "--json", "databaseId,status,conclusion,url"
    ], { cwd })).stdout);
    const repository = await currentRepositoryIdentity(cwd);
    const response = {
      runId: String(actual.databaseId),
      status: actual.status,
      conclusion: actual.conclusion,
      url: actual.url
    };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `github:${repository}:actions.cancel:${actual.databaseId}`
    );
    if (String(actual.databaseId) !== String(providerReceipt.runId) || actual.status !== "completed" || actual.conclusion !== "CANCELLED") {
      throw new Error("GitHub Actions cancellation proof does not match provider state");
    }
    return;
  }
  if (key === "pr.close:github-cli") {
    const actual = JSON.parse((await execBoundGitHubCli(providerExecutablePath, [
      "pr", "view", String(providerReceipt.pr), "--json", "number,state,url"
    ], { cwd })).stdout);
    const repository = await currentRepositoryIdentity(cwd);
    const response = { number: actual.number, state: actual.state, url: actual.url };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `github:${repository}:pr.close:${actual.number}`
    );
    if (actual.number !== providerReceipt.pr || actual.state !== "CLOSED" || providerReceipt.repository !== repository) {
      throw new Error("GitHub pull request close proof does not match provider state");
    }
    return;
  }
  if (key === "pr.merge:github-cli") {
    const actual = JSON.parse((await execBoundGitHubCli(providerExecutablePath, [
      "pr", "view", String(providerReceipt.pr), "--json", "number,state,headRefOid,baseRefName,mergeCommit"
    ], { cwd })).stdout);
    const mergeCommit = typeof actual.mergeCommit === "string" ? actual.mergeCommit : actual.mergeCommit?.oid;
    const repository = await currentRepositoryIdentity(cwd);
    const mergeDetails = JSON.parse((await execBoundGitHubCli(providerExecutablePath, [
      "api", `repos/${repository.slice("github.com/".length)}/commits/${mergeCommit}`
    ], { cwd })).stdout);
    const mergeParents = Array.isArray(mergeDetails.parents)
      ? mergeDetails.parents.map((parent) => parent?.sha).filter(Boolean)
      : [];
    const mergeBase = mergeParents[0];
    const mergeHead = mergeParents[1];
    const response = {
      number: actual.number,
      state: actual.state,
      head: actual.headRefOid,
      baseRefName: actual.baseRefName,
      mergeCommit,
      mergeBase,
      mergeHead,
      mergeParentCount: mergeParents.length,
      providerExecutableDigest: record.providerExecutable?.digest
    };
    assertRecomputedProviderReceipt(
      providerReceipt,
      {
        action: record.action,
        provider: record.provider,
        resource: record.resource,
        remoteRevision: record.remoteRevision,
        repository,
        pr: actual.number,
        targetRef: record.targetRef ?? null,
        mergeMethod: record.mergeMethod,
        adminBypass: record.adminBypass,
        providerExecutable: record.providerExecutable,
        mergeRepository: record.mergeRepository,
        mergeCommand: record.mergeCommand
      },
      response,
      `github:${repository}:pr.merge:${actual.number}:${mergeCommit}`
    );
    if (
      actual.number !== Number(String(record.resource).replace(/^pull\//, "")) ||
      actual.number !== providerReceipt.pr ||
      actual.state !== "MERGED" ||
      actual.headRefOid !== providerReceipt.head ||
      actual.baseRefName !== providerReceipt.baseRefName ||
      mergeCommit !== providerReceipt.mergeCommit ||
      providerReceipt.repository !== repository ||
      providerReceipt.mergeBase !== record.remoteRevision ||
      mergeBase !== record.remoteRevision ||
      mergeParents.length !== 2 ||
      providerReceipt.mergeHead !== record.reviewedHead ||
      mergeHead !== record.reviewedHead ||
      providerReceipt.providerExecutableDigest !== record.providerExecutable?.digest
    ) throw new Error("GitHub pull request merge proof does not match provider state");
    return;
  }
  if (key === "remote.sync:git") {
    if (isDevDeliveryTemplate(manifest.template) && record.resource !== "refs/heads/dev") {
      throw new Error("pr-to-dev remote synchronization is restricted to refs/heads/dev");
    }
    const branchRef = /^refs\/heads\/(.+)$/.exec(record.resource)?.[1];
    if (!branchRef) throw new Error("Git remote synchronization resource must be refs/heads/<branch>");
    const currentSourceBinding = await assertCurrentGitPushSourceBinding(manifest, record.sourceBindingDigest);
    if (currentSourceBinding.originIdentity.digest !== record.sourceRemoteBindingDigest) {
      throw new Error("Git remote synchronization proof does not match the current complete source binding");
    }
    const destination = await resolveGitFetchOrigin(cwd);
    const { remoteRepository, remoteUrlDigest, sourceRemoteBindingDigest } = destination;
    if (
      record.remote !== destination.remote ||
      remoteRepository !== record.remoteRepository ||
      remoteUrlDigest !== record.remoteUrlDigest ||
      sourceRemoteBindingDigest !== record.sourceRemoteBindingDigest
    ) {
      throw new Error("Git remote synchronization proof does not match the origin bound when the action token was issued");
    }
    const githubExecutablePath = await verifyRecordedGitHubProvider(manifest, record);
    const providerRevision = await readBoundGitHubRefRevision(
      cwd,
      remoteRepository,
      record.resource,
      githubExecutablePath
    );
    const localRevision = (await execBoundGitAuthority(cwd, [
      "rev-parse", "--verify", `refs/heads/${branchRef}^{commit}`
    ])).stdout.trim();
    const repository = await currentGitProviderIdentity(cwd);
    const response = {
      repository,
      ref: record.resource,
      remote: record.remote,
      remoteRepository,
      remoteUrlDigest,
      sourceBindingDigest: record.sourceBindingDigest,
      sourceRemoteBindingDigest,
      providerRevision,
      localRevision
    };
    assertRecomputedProviderReceipt(
      providerReceipt,
      {
        action: record.action,
        provider: record.provider,
        resource: record.resource,
        remoteRevision: record.remoteRevision,
        repository,
        ref: record.resource,
        remote: record.remote,
        remoteRepository,
        remoteUrlDigest,
        sourceBindingDigest: record.sourceBindingDigest,
        sourceRemoteBindingDigest
      },
      response,
      `git:${repository}:remote.sync:${record.resource}:${providerRevision}:${localRevision}`
    );
    if (
      providerRevision !== receipt.providerReceipt.providerRevision ||
      localRevision !== receipt.providerReceipt.localRevision ||
      providerReceipt.ref !== record.resource ||
      providerReceipt.repository !== repository ||
      providerReceipt.sourceBindingDigest !== record.sourceBindingDigest ||
      providerReceipt.sourceRemoteBindingDigest !== record.sourceRemoteBindingDigest
    ) {
      throw new Error("Git remote synchronization proof does not match provider state");
    }
    return;
  }
  if (key === "worktree.cleanup:git") {
    const expectedPath = record.resource.startsWith("worktree:")
      ? record.resource.slice("worktree:".length)
      : null;
    if (!expectedPath || providerReceipt.path !== expectedPath) {
      throw new Error("Git worktree cleanup proof is not bound to the requested resource");
    }
    const output = (await execBoundGitAuthority(cwd, ["worktree", "list", "--porcelain"])).stdout;
    const present = output.split(/\n\n+/).some((block) => block.split("\n").some((line) => line === `worktree ${providerReceipt.path}`));
    if (present) throw new Error("Git worktree cleanup proof does not match provider state");
    const repository = await currentGitProviderIdentity(cwd);
    const response = { path: providerReceipt.path, removed: true };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `git:${repository}:worktree.cleanup:${providerReceipt.path}`
    );
  }
}

const PR_MERGE_HUMAN_APPROVAL_KIND = "host-signed-pr-merge-authorization";
const PR_MERGE_HUMAN_APPROVAL_MODEL = "pr-merge-human-authorization";
const PR_MERGE_HUMAN_APPROVAL_REVIEWER = "better-workflows-pr-merge-human-approval";
const PR_MERGE_ZERO_REVIEW_POLICY = "solo-repository-zero-review-v1";

export function findExactMergeHumanAuthorization(evidence, {
  action,
  provider,
  resource,
  remoteRevision,
  repository,
  actor,
  humanApprovalDigest
}) {
  if (
    action !== "pr.merge" ||
    typeof provider !== "string" || !provider ||
    typeof resource !== "string" || !/^pull\/\d+$/.test(resource) ||
    typeof remoteRevision !== "string" || !remoteRevision ||
    typeof repository !== "string" || !repository ||
    typeof actor !== "string" || !actor ||
    !/^[a-f0-9]{64}$/.test(humanApprovalDigest ?? "")
  ) {
    return null;
  }
  return evidence.find((item) => {
    if (item.kind !== "remote-authorization" || item.status !== "complete" || item.stale) return false;
    const payload = item.receipt?.payload;
    const producer = typeof item.receipt?.producer === "string"
      ? item.receipt.producer
      : item.receipt?.producer?.provider;
    return (
      producer === "user-authority" &&
      payload?.action === action &&
      payload?.provider === provider &&
      payload?.resource === resource &&
      payload?.remoteRevision === remoteRevision &&
      payload?.repository === repository &&
      payload?.actor === actor &&
      payload?.humanApprovalDigest === humanApprovalDigest
    );
  }) ?? null;
}

export function assertPersistedMergeHumanApproval(record, checkVerification) {
  const observedDigest = checkVerification?.humanApproval?.authorizationDigest ?? null;
  if ((record.mergeHumanApprovalDigest ?? null) !== observedDigest) {
    throw new Error("Governed PR merge human approval changed after action issuance");
  }
}

export function assertPersistedMergeHumanAuthorizationEvidence(
  record,
  evidence,
  checkVerification,
  { actor, repository }
) {
  assertPersistedMergeHumanApproval(record, checkVerification);
  const humanApproval = checkVerification?.humanApproval ?? null;
  if (!humanApproval) {
    if (record.mergeAuthorizationEvidenceId !== undefined) {
      throw new Error("Governed PR merge authorization evidence remained bound after human approval disappeared");
    }
    return null;
  }
  if (
    typeof record.mergeAuthorizationEvidenceId !== "string" ||
    !record.mergeAuthorizationEvidenceId ||
    humanApproval.actor !== actor
  ) {
    throw new Error("Governed PR merge authorization evidence or live actor changed after action issuance");
  }
  const candidate = evidence.find((item) => item.id === record.mergeAuthorizationEvidenceId) ?? null;
  const exact = candidate && findExactMergeHumanAuthorization([candidate], {
    action: record.action,
    provider: record.provider,
    resource: record.resource,
    remoteRevision: record.remoteRevision,
    repository,
    actor,
    humanApprovalDigest: humanApproval.authorizationDigest
  });
  if (!exact || exact.id !== record.mergeAuthorizationEvidenceId) {
    throw new Error("Governed PR merge authorization evidence is absent, stale, replaced, or invalid");
  }
  return exact;
}

export function assertPersistedRequiredChecksEvidence(record, evidence, { repository }) {
  if (typeof record.requiredChecksEvidenceId !== "string" || !record.requiredChecksEvidenceId) {
    throw new Error("Governed PR merge lacks the exact required-check evidence ID issued with the action");
  }
  const candidate = evidence.find((item) => item.id === record.requiredChecksEvidenceId) ?? null;
  const payload = candidate?.kind === "required-checks" ? candidate.receipt?.payload : null;
  const binding = candidate?.receipt?.inputBinding;
  if (
    !candidate || candidate.status !== "complete" || candidate.stale === true ||
    candidate.id !== record.requiredChecksEvidenceId ||
    binding?.runId !== record.runId ||
    binding?.contractDigest !== record.contractDigest ||
    binding?.remoteRevision !== record.remoteRevision ||
    binding?.reviewHead !== record.reviewedHead ||
    binding?.reviewBase !== record.remoteRevision ||
    Number(binding?.pullRequest) !== record.pullRequest ||
    binding?.repository !== repository ||
    binding?.baseRefName !== record.targetRef ||
    payload?.provider !== "github" ||
    payload?.repository !== repository ||
    Number(payload?.pr) !== record.pullRequest ||
    payload?.head !== record.reviewedHead ||
    payload?.base !== record.remoteRevision ||
    payload?.baseRefName !== record.targetRef
  ) {
    throw new Error("Governed PR merge required-check evidence is absent, stale, replaced, or invalid");
  }
  return candidate;
}

export function assertPersistedSuccessfulMergeActionForRequiredChecks(
  actions,
  requiredChecks,
  { runId, contractDigest, repository }
) {
  const candidates = actions.filter((action) => action.requiredChecksEvidenceId === requiredChecks?.id);
  if (candidates.length !== 1) {
    throw new Error("Governed PR merge completion requires one exact issued merge action for the required-check evidence ID");
  }
  const action = candidates[0];
  const payload = requiredChecks?.receipt?.payload;
  const authorization = payload?.humanApproval?.authorization;
  if (
    action.runId !== runId ||
    action.contractDigest !== contractDigest ||
    action.action !== "pr.merge" ||
    action.provider !== "github-cli" ||
    action.resource !== `pull/${payload?.pr}` ||
    action.remoteRevision !== payload?.base ||
    action.pullRequest !== Number(payload?.pr) ||
    action.reviewedHead !== payload?.head ||
    action.targetRef !== payload?.baseRefName ||
    action.mergeRepository !== repository ||
    action.status !== "spent" ||
    action.outcome !== "success" ||
    typeof action.tokenHash !== "string" || !SHA256_DIGEST.test(action.tokenHash) ||
    typeof action.attemptId !== "string" || !action.attemptId ||
    typeof action.reviewPackageId !== "string" || !action.reviewPackageId ||
    !SHA256_DIGEST.test(action.reviewContinuityDigest ?? "") ||
    (authorization && action.reviewPackageId !== authorization.reviewPackageId) ||
    action.providerInvocation?.provider !== "github-cli" ||
    action.providerInvocation?.actionAttemptId !== action.attemptId ||
    action.providerInvocation?.adminBypass !== false ||
    action.providerInvocation?.exitCode !== 0 ||
    action.providerInvocation?.dispatchState !== "sent" ||
    action.receipt?.providerReceipt?.invocationId !== action.providerInvocation?.id
  ) {
    throw new Error("Governed PR merge completion action is not the exact successfully invoked merge action");
  }
  assertPersistedRequiredChecksEvidence(action, [requiredChecks], { repository });
  validateActionReceipt(action, "success", action.receipt);
  return action;
}

export async function verifyMergeHumanApproval(cwd, payload) {
  const approval = payload?.humanApproval;
  const authorization = approval?.authorization;
  const attestation = approval?.attestation;
  if (
    !approval || approval.schemaVersion !== 1 ||
    !authorization || authorization.schemaVersion !== 1 ||
    authorization.kind !== PR_MERGE_HUMAN_APPROVAL_KIND ||
    authorization.action !== "pr.merge" ||
    authorization.resource !== `pull/${payload?.pr}` ||
    authorization.repository !== payload?.repository ||
    authorization.pr !== payload?.pr ||
    authorization.head !== payload?.head ||
    authorization.base !== payload?.base ||
    authorization.baseRefName !== payload?.baseRefName ||
    authorization.adminBypass !== false ||
    authorization.reviewPolicyException !== PR_MERGE_ZERO_REVIEW_POLICY ||
    typeof authorization.actor !== "string" || !authorization.actor ||
    typeof authorization.runId !== "string" || !authorization.runId.startsWith("sbw-") ||
    typeof authorization.reviewPackageId !== "string" || !authorization.reviewPackageId.startsWith("review-") ||
    !/^[a-f0-9]{64}$/.test(authorization.contractDigest ?? "") ||
    !/^[a-f0-9]{64}$/.test(authorization.sourceBindingDigest ?? "") ||
    !/^[a-f0-9]{64}$/.test(authorization.sourceSentinelDigest ?? "") ||
    !attestation || typeof attestation.path !== "string" || !path.isAbsolute(attestation.path) ||
    !/^[a-f0-9]{64}$/.test(attestation.attestationDigest ?? "") ||
    !/^[a-f0-9]{64}$/.test(attestation.fileDigest ?? "")
  ) {
    throw new Error("Governed PR merge human approval binding is incomplete");
  }
  const approvedAt = Date.parse(authorization.approvedAt ?? "");
  if (!Number.isFinite(approvedAt) || approvedAt > Date.now() + 300_000 || Date.now() - approvedAt > 24 * 60 * 60 * 1000) {
    throw new Error("Governed PR merge human approval is stale or invalid");
  }
  const expectedAuthorization = {
    schemaVersion: 1,
    kind: PR_MERGE_HUMAN_APPROVAL_KIND,
    action: "pr.merge",
    resource: `pull/${payload.pr}`,
    runId: authorization.runId,
    contractDigest: authorization.contractDigest,
    sourceBindingDigest: authorization.sourceBindingDigest,
    sourceSentinelDigest: authorization.sourceSentinelDigest,
    reviewPackageId: authorization.reviewPackageId,
    repository: payload.repository,
    pr: payload.pr,
    head: payload.head,
    base: payload.base,
    baseRefName: payload.baseRefName,
    actor: authorization.actor,
    adminBypass: false,
    reviewPolicyException: PR_MERGE_ZERO_REVIEW_POLICY,
    approvedAt: authorization.approvedAt
  };
  const authorizationDigest = digestObject(expectedAuthorization);
  if (
    digestObject(authorization) !== authorizationDigest ||
    approval.authorizationDigest !== authorizationDigest
  ) {
    throw new Error("Governed PR merge human approval authorization digest is invalid");
  }
  const binding = {
    base: payload.base,
    head: payload.head,
    instructionDigest: authorizationDigest,
    model: PR_MERGE_HUMAN_APPROVAL_MODEL,
    packageId: `merge-approval-${authorizationDigest}`,
    promptDigest: authorizationDigest,
    reviewDigest: authorizationDigest,
    reviewerId: PR_MERGE_HUMAN_APPROVAL_REVIEWER,
    runId: authorization.runId,
    sentinelDigest: authorization.sourceSentinelDigest
  };
  const attestationPath = await realpath(attestation.path);
  if (sha256(await readFile(attestationPath)) !== attestation.fileDigest) {
    throw new Error("Governed PR merge human approval attestation changed after authorization");
  }
  const { captureSourceBinding } = await import("./git.mjs");
  let currentSource;
  try {
    currentSource = await captureSourceBinding(path.resolve(cwd), {
      baseRevision: payload.base,
      requireClean: true
    });
  } catch (error) {
    throw new Error(`Governed PR merge human approval source registry binding is stale: ${error.message}`);
  }
  if (
    currentSource?.headRevision !== payload.head ||
    currentSource?.digest !== authorization.sourceBindingDigest
  ) {
    throw new Error("Governed PR merge human approval source registry binding is stale");
  }
  const { verifyTrustedNativeCriticAttestation } = await import("./providers.mjs");
  const verified = await verifyTrustedNativeCriticAttestation({
    attestationPath,
    workspaceRoot: cwd,
    binding
  });
  if (
    verified.attestationDigest !== attestation.attestationDigest ||
    verified.attestationPath !== attestationPath ||
    sha256(await readFile(verified.attestationPath)) !== attestation.fileDigest
  ) {
    throw new Error("Governed PR merge human approval attestation changed after authorization");
  }
  return {
    authorizationDigest,
    attestationDigest: verified.attestationDigest,
    sourceBindingDigest: currentSource.digest,
    actor: authorization.actor,
    reviewPolicyException: authorization.reviewPolicyException
  };
}

export async function verifyRequiredChecksProvider(
  cwd,
  payload,
  providerExecutable = null
) {
  if (payload.provider !== "github") throw new Error("Required checks must be observed from GitHub");
  const executable = await verifyRecordedExecutable(
    providerExecutable ?? payload.providerExecutable,
    "gh",
    "Required checks provider observation"
  );
  const executablePath = executable.path;
  const repository = repositoryIdentity(payload.repository);
  const prefix = "github.com/";
  if (!repository.startsWith(prefix)) throw new Error("Required checks repository is not a GitHub repository");
  if (!Array.isArray(payload.requiredStatusChecks) || payload.requiredStatusChecks.length === 0) {
    throw new Error("Required checks evidence must include the protected branch status-check set");
  }
  const repositoryPath = repository.slice(prefix.length);
  if (!Number.isSafeInteger(payload.pr) || payload.pr < 1) {
    throw new Error("Required checks evidence must include a safe pull-request identity");
  }
  const pull = JSON.parse((await execBoundGitHubCli(executablePath, [
    "api",
    `repos/${repositoryPath}/pulls/${payload.pr}`
  ], { cwd, encoding: "utf8" })).stdout);
  if (
    pull.number !== payload.pr ||
    pull.state !== "open" ||
    pull.draft !== false ||
    pull.head?.sha !== payload.head ||
    typeof pull.head?.ref !== "string" ||
    !pull.head.ref ||
    pull.base?.sha !== payload.base ||
    pull.base?.ref !== payload.baseRefName
  ) {
    throw new Error("Required checks evidence does not match the live open pull request");
  }
  const headRefName = pull.head.ref;
  const humanApproval = payload.humanApproval
    ? await verifyMergeHumanApproval(cwd, payload)
    : null;
  const protection = JSON.parse((await execBoundGitHubCli(executablePath, [
    "api",
    `repos/${repositoryPath}/branches/${encodeURIComponent(payload.baseRefName)}/protection`
  ], { cwd, encoding: "utf8" })).stdout);
  if (protection.enforce_admins?.enabled !== true || !protection.required_status_checks) {
    throw new Error("Protected branch policy is missing enforce-admins or required status checks");
  }
  const requiredApprovingReviewCount = protection.required_pull_request_reviews?.required_approving_review_count;
  if (
    !Number.isInteger(requiredApprovingReviewCount) ||
    requiredApprovingReviewCount < 0 ||
    (requiredApprovingReviewCount === 0 && humanApproval?.reviewPolicyException !== PR_MERGE_ZERO_REVIEW_POLICY)
  ) {
    throw new Error("Protected branch policy is missing required pull-request reviews");
  }
  if (protection.allow_force_pushes?.enabled === true || protection.allow_deletions?.enabled === true) {
    throw new Error("Protected branch policy permits force-pushes or deletions");
  }
  const branchRules = JSON.parse((await execBoundGitHubCli(executablePath, [
    "api",
    `repos/${repositoryPath}/rules/branches/${encodeURIComponent(payload.baseRefName)}`
  ], { cwd, encoding: "utf8" })).stdout);
  if (!Array.isArray(branchRules)) {
    throw new Error("Protected branch rules could not be verified completely");
  }
  if (branchRules.some((rule) => !rule || typeof rule.type !== "string" || !rule.type)) {
    throw new Error("Protected branch rules contain an incomplete rule definition");
  }
  if (branchRules.some((rule) => ["deletion", "non_fast_forward"].includes(rule.type))) {
    throw new Error("Protected branch rules permit deletion or non-fast-forward updates");
  }
  const rulesetPages = JSON.parse((await execBoundGitHubCli(executablePath, [
    "api",
    "--paginate",
    "--slurp",
    `repos/${repositoryPath}/rulesets?includes_parents=true`
  ], { cwd, encoding: "utf8" })).stdout);
  if (!Array.isArray(rulesetPages) || rulesetPages.some((page) => !Array.isArray(page))) {
    throw new Error("Repository rulesets could not be verified completely");
  }
  const rulesets = rulesetPages.flat();
  const activeRulesets = rulesets.filter((item) => item?.enforcement === "active");
  if (activeRulesets.some((item) => !Number.isInteger(Number(item?.id)))) {
    throw new Error("Active repository ruleset listing contains an incomplete identity");
  }
  const branchRef = `refs/heads/${payload.baseRefName}`;
  const rulesetRequiredStatusChecks = [];
  const normalizeRulesetCheckAppId = (value) => {
    if (value === undefined || value === null || value === "" || value === -1 || value === "-1") return null;
    const appId = Number(value);
    return Number.isInteger(appId) && appId >= 0 ? appId : undefined;
  };
  const refPatternMatches = (pattern) => {
    if (pattern === "~ALL" || pattern === "~DEFAULT_BRANCH" || pattern === branchRef) return true;
    if (typeof pattern !== "string" || !pattern.includes("*")) return false;
    const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${escaped}$`).test(branchRef);
  };
  for (const listed of activeRulesets) {
    const detail = JSON.parse((await execBoundGitHubCli(executablePath, [
      "api",
      `repos/${repositoryPath}/rulesets/${Number(listed.id)}`
    ], { cwd, encoding: "utf8" })).stdout);
    const includes = detail.conditions?.ref_name?.include;
    if (detail.target === "branch" && !Array.isArray(includes)) {
      throw new Error("Active branch ruleset has no complete ref-name condition");
    }
    const appliesToTarget = detail.target === "branch" && Array.isArray(includes) && includes.some(refPatternMatches);
    if (appliesToTarget && !Array.isArray(detail.bypass_actors)) {
      throw new Error("Active protected branch ruleset has no complete bypass-actor policy");
    }
    if (appliesToTarget && detail.bypass_actors.length > 0) {
      throw new Error("Active protected branch ruleset permits bypass actors");
    }
    if (appliesToTarget && !Array.isArray(detail.rules)) {
      throw new Error("Active protected branch ruleset has no complete rule set");
    }
    const rules = Array.isArray(detail.rules) ? detail.rules : [];
    if (appliesToTarget && rules.some((rule) => ["deletion", "non_fast_forward"].includes(rule?.type))) {
      throw new Error("Active protected branch ruleset permits deletion or non-fast-forward updates");
    }
    const requiredStatusRules = rules.filter((rule) => rule?.type === "required_status_checks");
    for (const requiredStatusRule of requiredStatusRules) {
      if (appliesToTarget && !Array.isArray(requiredStatusRule.parameters?.required_status_checks)) {
        throw new Error("Active protected branch ruleset has incomplete required status checks");
      }
      if (appliesToTarget) {
        for (const check of requiredStatusRule.parameters.required_status_checks) {
          const name = check?.context ?? check?.name;
          if (typeof name !== "string" || !name) {
            throw new Error("Active protected branch ruleset has an incomplete required status check");
          }
          const appId = normalizeRulesetCheckAppId(check?.integration_id ?? check?.app_id);
          if (appId === undefined) {
            throw new Error("Active protected branch ruleset has an invalid required status check app identity");
          }
          rulesetRequiredStatusChecks.push({ context: name, appId });
        }
      }
    }
    if (appliesToTarget && detail.enforcement !== "active") {
      throw new Error("Active protected branch ruleset detail changed enforcement state");
    }
    const pullRequestRule = rules.find((rule) => rule?.type === "pull_request");
    if (
      appliesToTarget &&
      pullRequestRule &&
      (!Number.isInteger(pullRequestRule.parameters?.required_approving_review_count) ||
        pullRequestRule.parameters.required_approving_review_count < 0 ||
        (pullRequestRule.parameters.required_approving_review_count === 0 &&
          humanApproval?.reviewPolicyException !== PR_MERGE_ZERO_REVIEW_POLICY))
    ) {
      throw new Error("Active protected branch ruleset has incomplete pull-request review policy");
    }
  }
  const requiredStatusProtection = JSON.parse((await execBoundGitHubCli(executablePath, [
    "api",
    `repos/${repositoryPath}/branches/${encodeURIComponent(payload.baseRefName)}/protection/required_status_checks`
  ], { cwd, encoding: "utf8" })).stdout);
  if (
    requiredStatusProtection.contexts !== undefined &&
    (!Array.isArray(requiredStatusProtection.contexts) ||
      requiredStatusProtection.contexts.some((context) => typeof context !== "string" || !context))
  ) {
    throw new Error("Protected branch status-check contexts contain malformed entries");
  }
  if (
    requiredStatusProtection.checks !== undefined &&
    (!Array.isArray(requiredStatusProtection.checks) ||
      requiredStatusProtection.checks.some((check) => {
        const name = check?.context ?? check?.name;
        return !check || typeof check !== "object" || typeof name !== "string" || !name;
      }))
  ) {
    throw new Error("Protected branch status-check objects contain malformed entries");
  }
  const normalizeProtectedCheckAppId = (value) => {
    // GitHub uses a missing/null (and, on older responses, -1) app id to
    // express a context-only requirement that any check provider may satisfy.
    if (value === undefined || value === null || value === -1 || value === "-1") return null;
    const appId = Number(value);
    return Number.isInteger(appId) && appId >= 0 ? appId : undefined;
  };
  const structuredProtectedChecks = Array.isArray(requiredStatusProtection.checks) && requiredStatusProtection.checks.length > 0;
  const protectedCheckApps = [
    ...(!structuredProtectedChecks && Array.isArray(requiredStatusProtection.contexts)
      ? requiredStatusProtection.contexts.map((context) => ({ context, appId: null }))
      : []),
    ...(Array.isArray(requiredStatusProtection.checks)
      ? requiredStatusProtection.checks.map((check) => ({
          context: check.context ?? check.name,
          appId: normalizeProtectedCheckAppId(check.app_id)
        }))
      : []),
    ...rulesetRequiredStatusChecks
  ];
  if (protectedCheckApps.some((check) => !check.context || check.appId === undefined)) {
    throw new Error("Protected required checks contain malformed app identities");
  }
  const requiredStatusChecks = [...new Set(protectedCheckApps.map((check) => check.context))].sort();
  const protectedCheckContextCounts = new Map();
  for (const check of protectedCheckApps) {
    protectedCheckContextCounts.set(check.context, (protectedCheckContextCounts.get(check.context) ?? 0) + 1);
  }
  if ([...protectedCheckContextCounts.values()].some((count) => count > 1)) {
    throw new Error("Protected required checks contain duplicate contexts that the evidence schema cannot represent");
  }
  if (requiredStatusChecks.length > 0 && protectedCheckApps.length === 0) {
    throw new Error("Protected required checks lack a verifiable requirement identity");
  }
  const sortProtectedCheckApps = (left, right) => (
    String(left?.context ?? "").localeCompare(String(right?.context ?? "")) ||
    String(left?.appId ?? "any").localeCompare(String(right?.appId ?? "any"))
  );
  if (
    digestObject([...protectedCheckApps].sort(sortProtectedCheckApps)) !==
    digestObject([...(payload.requiredStatusCheckApps ?? [])].sort(sortProtectedCheckApps))
  ) {
    throw new Error("Required check evidence does not match protected GitHub App identities");
  }
  if (digestObject(requiredStatusChecks) !== digestObject([...payload.requiredStatusChecks].sort())) {
    throw new Error("Required checks evidence does not match the protected branch status-check set");
  }
  const workflowPages = JSON.parse((await execBoundGitHubCli(executablePath, [
    "api",
    "--paginate",
    "--slurp",
    `repos/${repositoryPath}/actions/runs?head_sha=${encodeURIComponent(payload.head)}&per_page=100`
  ], { cwd, encoding: "utf8" })).stdout);
  if (!Array.isArray(workflowPages) || workflowPages.some((page) => !page || !Array.isArray(page.workflow_runs))) {
    throw new Error("Required check provider response is not a complete GitHub workflow-run set");
  }
  const allHeadRuns = workflowPages.flatMap((page) => page.workflow_runs)
    .filter((run) => run?.head_sha === payload.head);
  const runs = allHeadRuns.filter((run) => run.head_branch === headRefName);
  const workflowCount = workflowPages.reduce((sum, page) => sum + page.workflow_runs.length, 0);
  const workflowTotal = workflowPages[0]?.total_count;
  if (!Number.isInteger(workflowTotal) || workflowTotal !== workflowCount || runs.length === 0) {
    throw new Error("Required check provider response has no complete workflow-run set for the live pull-request head ref");
  }
  const observedAt = Date.parse(payload.observedAt ?? "");
  if (!Number.isFinite(observedAt)) {
    throw new Error("Required check evidence must include a valid observation timestamp");
  }
  for (const run of runs) {
    const completedAt = run.completed_at ?? run.updated_at;
    if (
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      !Number.isFinite(Date.parse(completedAt ?? "")) ||
      Date.parse(completedAt) > observedAt
    ) {
      throw new Error(`Required check workflow run is not a fresh successful GitHub run: ${run.id}`);
    }
  }
  const checkRunPages = JSON.parse((await execBoundGitHubCli(executablePath, [
    "api",
    "--paginate",
    "--slurp",
    `repos/${repositoryPath}/commits/${encodeURIComponent(payload.head)}/check-runs?per_page=100`
  ], { cwd, encoding: "utf8" })).stdout);
  if (!Array.isArray(checkRunPages) || checkRunPages.some((page) => !page || !Array.isArray(page.check_runs))) {
    throw new Error("Required check provider response is not a complete GitHub check-run set");
  }
  const checkRuns = checkRunPages.flatMap((page) => page.check_runs)
    .filter((check) => check?.head_sha === payload.head);
  const checkRunCount = checkRunPages.reduce((sum, page) => sum + page.check_runs.length, 0);
  const checkRunTotal = checkRunPages[0]?.total_count;
  if (!Number.isInteger(checkRunTotal) || checkRunTotal !== checkRunCount) {
    throw new Error("Required check provider response is not a complete GitHub check-run set");
  }
  const statusPages = JSON.parse((await execBoundGitHubCli(executablePath, [
    "api",
    "--paginate",
    "--slurp",
    `repos/${repositoryPath}/commits/${encodeURIComponent(payload.head)}/statuses?per_page=100`
  ], { cwd, encoding: "utf8" })).stdout);
  if (!Array.isArray(statusPages) || statusPages.some((page) => !Array.isArray(page))) {
    throw new Error("Required check provider response is not a complete GitHub commit-status set");
  }
  const commitStatuses = statusPages.flatMap((page) => page)
    .filter((status) => status?.sha === payload.head);
  const canonicalRequiredCheckObservationId = (value, label = "required check observation") => {
    const raw = typeof value === "string"
      ? value.trim()
      : Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
    if (!/^(0|[1-9]\d*)$/.test(raw)) {
      throw new Error(`Required check provider returned an unsafe observation identity: ${label}`);
    }
    return raw;
  };
  const canonicalRequiredCheckObservationKind = (value, label = "required check observation") => {
    const raw = String(value ?? "").trim();
    if (!["check-run", "commit-status"].includes(raw)) {
      throw new Error(`Required check provider returned an unsafe observation kind: ${label}`);
    }
    return raw;
  };
  const requiredCheckObservationIdentity = (kind, id, label) => (
    `${canonicalRequiredCheckObservationKind(kind, label)}:${canonicalRequiredCheckObservationId(id, label)}`
  );
  // The provider returns every check-run for the commit, including optional
  // jobs that are intentionally skipped.  Only the protected status contexts
  // are merge gates; choose the newest authoritative check-run or commit
  // status for each required context, then require that observation to be
  // terminal success. App-bound requirements remain restricted to check-runs.
  const requiredObservations = protectedCheckApps.map(({ context: name, appId }) => {
    const candidates = [];
    for (const check of checkRuns) {
      if (check?.name !== name || check?.head_sha !== payload.head ||
          (appId !== null && check?.app?.id !== appId)) continue;
      const identity = canonicalRequiredCheckObservationId(check.id, `${name} check-run`);
      // GitHub check-run responses expose the observation start as
      // `started_at` (and do not consistently include `created_at`). Keep
      // both shapes equivalent for freshness selection; completed_at remains
      // the terminal-outcome boundary below.
      const createdAt = Date.parse(check.created_at ?? check.started_at ?? "");
      const completedAt = Date.parse(check.completed_at ?? "");
      if (!Number.isFinite(createdAt)) {
        throw new Error(`Required check provider returned a matching observation without a valid origin timestamp: ${name}`);
      }
      candidates.push({
        ...check,
        id: identity,
        observationKind: "check-run",
        observationIdentity: requiredCheckObservationIdentity("check-run", identity, `${name} check-run`),
        observationAt: createdAt,
        completedAt
      });
    }
    if (appId === null) {
      for (const status of commitStatuses) {
        if (status?.context !== name || status?.sha !== payload.head) continue;
        const identity = canonicalRequiredCheckObservationId(status.id, `${name} commit-status`);
        const originAt = Date.parse(status.created_at ?? status.started_at ?? "");
        const observedStatusAt = Date.parse(status.updated_at ?? status.completed_at ?? "");
        if (!Number.isFinite(originAt)) {
          throw new Error(`Required check provider returned a matching status without a valid origin timestamp: ${name}`);
        }
        if (!Number.isFinite(observedStatusAt)) {
          throw new Error(`Required check provider returned a matching status without a valid terminal timestamp: ${name}`);
        }
        candidates.push({
          id: identity,
          name,
          providerName: name,
          head_sha: payload.head,
          status: "completed",
          conclusion: String(status.state ?? ""),
          observationKind: "commit-status",
          observationIdentity: requiredCheckObservationIdentity("commit-status", identity, `${name} commit-status`),
          observationAt: originAt,
          completedAt: observedStatusAt
        });
      }
    }
    const seenObservationIds = new Set();
    for (const candidate of candidates) {
      const identity = String(candidate.observationIdentity ?? "").trim();
      if (!identity) {
        throw new Error(`Required check provider returned an observation without an identity: ${name}`);
      }
      if (seenObservationIds.has(identity)) {
        throw new Error(`Required check provider returned ambiguous duplicate observations: ${name}#${identity}`);
      }
      seenObservationIds.add(identity);
    }
    const latestObservationAt = Math.max(...candidates.map((candidate) => candidate.observationAt));
    const latestCandidates = candidates.filter((candidate) => candidate.observationAt === latestObservationAt);
    const latestKinds = new Set(latestCandidates.map((candidate) => candidate.observationKind));
    const latestOutcomes = new Set(latestCandidates.map((candidate) => `${candidate.status}:${candidate.conclusion}:${candidate.completedAt}`));
    if (latestKinds.size > 1 && latestOutcomes.size > 1) {
      throw new Error(`Required check provider returned ambiguous cross-provider observations at the same timestamp: ${name}`);
    }
    // IDs from check-runs and commit-statuses are independent namespaces. Once
    // the outcome is proven identical, use a fixed kind preference only; never
    // compare IDs across provider resource types.
    const compareSameKindObservationIds = (left, right) => {
      const leftId = String(left.id);
      const rightId = String(right.id);
      if (/^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
        const delta = BigInt(leftId) - BigInt(rightId);
        if (delta < 0n) return -1;
        if (delta > 0n) return 1;
      }
      return leftId.localeCompare(rightId);
    };
    latestCandidates.sort((left, right) => (
      String(left.observationKind).localeCompare(String(right.observationKind)) ||
      (latestKinds.size === 1 ? compareSameKindObservationIds(left, right) : 0)
    ));
    const selected = latestCandidates.at(-1);
    if (!selected) {
      throw new Error(`Required check provider has no fresh successful check observation for protected context: ${name}`);
    }
    if (
      selected.status !== "completed" ||
      selected.conclusion !== "success" ||
      !Number.isFinite(selected.completedAt) ||
      selected.completedAt > observedAt
    ) {
      throw new Error(`Required check provider latest protected check observation is not successful: ${name}`);
    }
    return selected;
  });
  const observedIdentities = new Set(payload.checks.map((check) => (
    requiredCheckObservationIdentity(
      check.observationKind,
      check.providerRunId,
      `${check.name ?? "required check"} evidence`
    )
  )));
  const requiredProviderIdentities = new Set(requiredObservations.map((check) => String(check.observationIdentity)));
  if (observedIdentities.size !== requiredObservations.length || observedIdentities.size !== payload.checks.length ||
      [...requiredProviderIdentities].some((identity) => !observedIdentities.has(identity))) {
    throw new Error("Required check evidence does not cover the canonical protected check observation set");
  }
  const observedRequired = new Set(payload.checks.map((check) => check.providerName ?? check.name));
  if (requiredStatusChecks.some((name) => !observedRequired.has(name))) {
    throw new Error("Required check evidence does not include every protected status check");
  }
  for (const check of payload.checks) {
    const observationKind = canonicalRequiredCheckObservationKind(check.observationKind, `${check.name ?? "required check"} evidence`);
    const providerRunId = canonicalRequiredCheckObservationId(check.providerRunId, `${check.name ?? "required check"} evidence`);
    const observationIdentity = `${observationKind}:${providerRunId}`;
    const observation = requiredObservations.find((candidate) => candidate.observationIdentity === observationIdentity);
    const protectedApp = protectedCheckApps.find((candidate) => candidate.context === (observation?.providerName ?? observation?.name));
    if (
      !observation ||
      observation.head_sha !== payload.head ||
      observation.status !== "completed" ||
      observation.conclusion !== "success" ||
      (check.providerName ?? check.name) !== (observation.providerName ?? observation.name) ||
      check.observationKind !== observation.observationKind ||
      !protectedApp ||
      (protectedApp.appId !== null && observation.app?.id !== protectedApp.appId) ||
      check.name !== `${observation.name}#${observation.id}` ||
      !Number.isFinite(observation.completedAt) ||
      observation.completedAt > observedAt ||
      !Number.isFinite(Date.parse(check.completedAt ?? "")) ||
      Date.parse(check.completedAt) !== observation.completedAt
    ) {
      throw new Error(`Required check provider observation is not a fresh successful GitHub check: ${check.providerRunId}`);
    }
  }
  return { humanApproval };
}

async function assertPullEvidenceBinding(admittedEvidence, request, reviewPackage, contract, expectedRepository) {
  const pullMatch = /^pull\/(\d+)$/.exec(request.resource);
  if (!pullMatch) throw new Error("PR merge resources must use pull/<number>");
  const expectedBaseRef = isDevDeliveryTemplate(contract.template) ? "dev" : null;
  for (const kind of ["pr-state", "required-checks"]) {
    if (!request.requiredEvidence.includes(kind)) continue;
    const records = admittedEvidence.filter((item) => item.kind === kind && item.status === "complete" && !item.stale);
    if (records.length === 0) continue;
    const exact = records.some((record) => {
      const payload = record.receipt?.payload;
      return (
        String(payload?.pr) === pullMatch[1] &&
        payload?.head === reviewPackage.head &&
        payload?.base === reviewPackage.base &&
        payload?.repository === expectedRepository &&
        (expectedBaseRef === null || payload?.baseRefName === expectedBaseRef)
      );
    });
    if (!exact) {
      throw new Error(`Action token denied until ${kind} is bound to the exact reviewed PR head`);
    }
  }
}

function assertTargetBranchEvidence(admittedEvidence, request, expectedRepository, expectedRevision) {
  if (!request.requiredEvidence.includes("target-branch-dev")) return;
  const records = admittedEvidence.filter((item) => item.kind === "target-branch-dev" && item.status === "complete" && !item.stale);
  const exact = records.some((record) => {
    const payload = record.receipt?.payload;
    return (
      payload?.repository === expectedRepository &&
      payload?.ref === "dev" &&
      (!expectedRevision || payload?.revision === expectedRevision)
    );
  });
  if (!exact) throw new Error("Action token denied until target-branch-dev is bound to the selected repository and dev revision");
}

export function assertRemoteAuthorizationEvidence(
  admittedEvidence,
  request,
  providerAuthorization,
  expectedRepository,
  expectedAuthorizedRevision = request.remoteRevision
) {
  const exact = admittedEvidence.some((record) => {
    if (record.kind !== "remote-authorization" || record.status !== "complete" || record.stale) return false;
    const payload = record.receipt?.payload;
    const producer = typeof record.receipt?.producer === "string"
      ? record.receipt.producer
      : record.receipt?.producer?.provider;
    const gitPush = request.provider === "git" && request.action === "git.push"
      ? GIT_PUSH_RESOURCE.exec(request.resource)
      : null;
    return (
      payload?.action === request.action &&
      payload?.provider === request.provider &&
      payload?.resource === request.resource &&
      payload?.remoteRevision === expectedAuthorizedRevision &&
      typeof payload?.repository === "string" && payload.repository.length > 0 &&
      typeof payload?.actor === "string" && payload.actor.length > 0 &&
      (!gitPush || (
        ["git", "github-cli-and-git"].includes(producer) &&
        payload.repository === expectedRepository &&
        payload.remote === gitPush[1] &&
        payload.ref === gitPush[2] &&
        payload.credentialCheck === "github-cli-token-actor"
      )) &&
      (!providerAuthorization || (
        payload.repository === providerAuthorization.repository &&
        payload.actor === providerAuthorization.actor
      ))
    );
  });
  if (!exact) throw new Error("Action token denied until remote authorization is bound to the exact actor, provider, resource, and revision");
}

function assertRemoteSyncMergeBinding(admittedEvidence, reviewPackage, contract, expectedRepository) {
  const exact = admittedEvidence
    .filter((item) => item.kind === "merge-result" && item.status === "complete" && !item.stale)
    .map((item) => item.receipt?.payload)
    .find((payload) => (
      payload?.outcome === "success" &&
      payload?.reviewPackageId === reviewPackage.packageId &&
      payload?.head === reviewPackage.head &&
      payload?.base === reviewPackage.base &&
      payload?.baseRefName === "dev" &&
      payload?.repository === expectedRepository &&
      Number.isInteger(payload?.pr) &&
      typeof payload?.mergeCommit === "string" && /^[a-f0-9]{40}$/i.test(payload.mergeCommit)
    ));
  if (!exact) throw new Error("Action token denied until merge-result is bound to the exact reviewed PR and merge");
  return {
    mergeCommit: exact.mergeCommit,
    pullRequest: exact.pr,
    reviewedHead: reviewPackage.head,
    reviewPackageId: reviewPackage.packageId
  };
}

function assertPersistedSuccessfulMergeAction(actions, mergeBinding) {
  const mergeAction = actions.find((action) => (
    action.action === "pr.merge" &&
    action.status === "spent" &&
    action.outcome === "success" &&
    action.pullRequest === mergeBinding.pullRequest &&
    action.reviewedHead === mergeBinding.reviewedHead &&
    action.reviewPackageId === mergeBinding.reviewPackageId &&
    action.receipt?.providerReceipt?.mergeCommit === mergeBinding.mergeCommit
  ));
  if (!mergeAction) {
    throw new Error("Remote sync requires a persisted successful pr.merge action");
  }
  return mergeAction;
}

function assertAutonomySnapshotIdentity(actual, expected, label) {
  if (!actual || !expected || typeof expected.digest !== "string" ||
      digestObject(actual) !== digestObject(expected)) {
    throw new Error(`${label} denied because the bounded autonomy snapshot changed; run autonomy preflight again`);
  }
}

function rawCommitParents(value, revision, label) {
  if (!Buffer.isBuffer(value)) throw new Error(`${label} commit object must be returned as bytes`);
  const headerEnd = value.indexOf(Buffer.from("\n\n"));
  if (headerEnd < 0 || value.subarray(0, headerEnd).includes(0)) {
    throw new Error(`${label} commit object ${revision} has malformed headers`);
  }
  const lines = value.subarray(0, headerEnd).toString("latin1").split("\n");
  if (!/^tree [a-f0-9]{40}$/i.test(lines[0] ?? "")) {
    throw new Error(`${label} commit object ${revision} lacks an exact tree header`);
  }
  const parents = [];
  let parentSection = true;
  for (const line of lines.slice(1)) {
    if (line.startsWith("parent ")) {
      if (!parentSection) {
        throw new Error(`${label} commit object ${revision} has a non-canonical parent header`);
      }
      const parent = line.slice("parent ".length);
      if (!SHA.test(parent)) {
        throw new Error(`${label} commit object ${revision} has an invalid parent header`);
      }
      parents.push(parent.toLowerCase());
      continue;
    }
    parentSection = false;
  }
  return parents;
}

async function rawLinearCommitDistance(cwd, ancestor, descendant, maxDistance, label) {
  if (!SHA.test(ancestor ?? "") || !SHA.test(descendant ?? "") ||
      !Number.isSafeInteger(maxDistance) || maxDistance < 0) {
    throw new Error(`${label} requires exact revisions and a bounded distance`);
  }
  const expectedAncestor = ancestor.toLowerCase();
  let current = descendant.toLowerCase();
  const visited = new Set();
  for (let distance = 0; distance <= maxDistance; distance += 1) {
    if (current === expectedAncestor) return distance;
    if (distance === maxDistance) {
      throw new Error(`${label} did not reach the immutable ancestor within ${maxDistance} commits`);
    }
    if (visited.has(current)) throw new Error(`${label} encountered a cyclic commit ancestry`);
    visited.add(current);
    const commit = await execBoundGitAuthority(cwd, ["cat-file", "commit", current], {
      encoding: "buffer",
      maxBuffer: BOUND_GIT_MAX_BUFFER
    });
    const parents = rawCommitParents(commit.stdout, current, label);
    if (parents.length !== 1) {
      throw new Error(`${label} requires an unambiguous single-parent commit chain`);
    }
    [current] = parents;
  }
  throw new Error(`${label} ancestry proof was indeterminate`);
}

async function currentAutonomySnapshot(manifest, contract, state) {
  return captureAutonomyReadinessSnapshot(
    manifest.cwd,
    contract.autonomyProfile,
    manifest.autonomyProfile?.sourceBindingDigest ?? manifest.sourceBinding?.digest ?? null,
    { sentinelDigest: state.lastSentinel?.digest ?? null }
  );
}

export async function autonomousCommitAllocation(manifest, actions, snapshot) {
  const sourceHead = manifest.autonomyProfile?.sourceHeadRevision;
  if (!SHA.test(sourceHead ?? "") || !SHA.test(snapshot?.headRevision ?? "")) {
    throw new Error("Autonomy commit allocation requires exact source and current head revisions");
  }
  const maxCommits = manifest.autonomyProfile?.limits?.maxCommits;
  if (!Number.isSafeInteger(maxCommits) || maxCommits < 1) {
    throw new Error("Autonomy commit allocation requires a positive maxCommits bound");
  }
  let ancestryCount;
  try {
    ancestryCount = await rawLinearCommitDistance(
      manifest.cwd,
      sourceHead,
      snapshot.headRevision,
      maxCommits,
      "Autonomy commit allocation"
    );
  } catch (error) {
    throw new Error(`Autonomy commit allocation denied because raw commit ancestry could not be proven: ${error.message}`);
  }
  const outstanding = actions.filter((action) => (
    action.action === "git.commit" &&
    action.autonomyDecision?.decision === "auto-approved" &&
    (
      action.status === "issued" ||
      (action.status === "spent" && ["pending", "unknown"].includes(action.outcome))
    )
  )).length;
  return { ancestryCount, outstanding, allocated: ancestryCount + outstanding };
}

function sourceBindingWithoutDigest(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return null;
  const { digest, ...payload } = binding;
  return { digest, payload };
}

function autonomousCommitSourceIdentity(binding) {
  return {
    schemaVersion: binding?.schemaVersion,
    cwd: binding?.cwd,
    repositoryRoot: binding?.repositoryRoot,
    gitDir: binding?.gitDir,
    gitCommonDir: binding?.gitCommonDir,
    originIdentity: binding?.originIdentity,
    symbolicRefs: binding?.symbolicRefs,
    baseRevision: binding?.baseRevision
  };
}

function parseBoundGitNulPaths(value, label) {
  if (!Buffer.isBuffer(value)) throw new Error(`${label} must be returned as bytes`);
  const paths = [];
  let offset = 0;
  while (offset < value.length) {
    const end = value.indexOf(0, offset);
    if (end < 0) throw new Error(`${label} is not NUL terminated`);
    const bytes = value.subarray(offset, end);
    if (bytes.length > 0) {
      const decoded = bytes.toString("utf8");
      if (!Buffer.from(decoded, "utf8").equals(bytes)) {
        throw new Error(`${label} contains a non-UTF-8 path`);
      }
      paths.push(decoded);
    }
    offset = end + 1;
  }
  return paths;
}

function autonomyPathAllowed(relative, pathScope) {
  return pathScope.includes(".") || pathScope.some((prefix) => (
    relative === prefix || relative.startsWith(`${prefix}/`)
  ));
}

function literalGitPathspec(relative) {
  return `:(literal)${relative}`;
}

async function boundedAutonomousCommitDiff(manifest, contract, record, currentHead) {
  const snapshot = record.autonomySnapshot;
  const limits = contract.autonomyProfile?.limits;
  const pathScope = contract.autonomyProfile?.pathScope;
  if (
    !snapshot || !limits || !Array.isArray(pathScope) ||
    !Array.isArray(snapshot.changedPaths) || !Array.isArray(snapshot.untrackedManifest) ||
    !Number.isSafeInteger(snapshot.trackedDiffBytes) || !SHA256_DIGEST.test(snapshot.trackedDiffDigest ?? "")
  ) {
    throw new Error("Autonomous Git commit reconciliation requires the exact consumed diff snapshot");
  }
  for (const item of snapshot.untrackedManifest) {
    if (
      !item || typeof item.path !== "string" || !["file", "symlink"].includes(item.type) ||
      (item.type === "symlink" && item.mode !== "120000") ||
      (item.type === "file" && !["100644", "100755"].includes(item.mode)) ||
      !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !SHA256_DIGEST.test(item.digest ?? "")
    ) {
      throw new Error("Autonomous Git commit reconciliation requires normalized untracked modes and content bindings");
    }
  }
  const preCommitHead = record.preCommitHeadRevision;
  const maxBuffer = Math.min(BOUND_GIT_MAX_BUFFER, limits.maxDiffBytes + 1);
  let committedDiff;
  let committedPathResult;
  try {
    [committedDiff, committedPathResult] = await Promise.all([
      execBoundGitAuthority(manifest.cwd, [
        "diff", "--no-ext-diff", "--no-textconv", "--binary", preCommitHead, currentHead, "--"
      ], {
        encoding: "buffer",
        maxBuffer
      }),
      execBoundGitAuthority(manifest.cwd, [
        "diff", "--no-ext-diff", "--no-textconv", "--name-status", "--find-renames", "-z", preCommitHead, currentHead, "--"
      ], {
        encoding: "buffer",
        maxBuffer
      })
    ]);
  } catch (error) {
    throw new Error(`Autonomous Git commit reconciliation exceeded maxDiffBytes=${limits.maxDiffBytes}: ${error.message}`);
  }
  if (committedDiff.stdout.byteLength > limits.maxDiffBytes) {
    throw new Error(`Autonomous Git commit reconciliation exceeded maxDiffBytes=${limits.maxDiffBytes}`);
  }
  const committedPaths = [...new Set(parseNulNameStatusPaths(
    committedPathResult.stdout,
    "Autonomous Git commit path list"
  ))].sort();
  const approvedPaths = [...new Set(snapshot.changedPaths)].sort();
  if (committedPaths.length > limits.maxFiles) {
    throw new Error(`Autonomous Git commit reconciliation exceeded maxFiles=${limits.maxFiles}`);
  }
  if (committedPaths.some((relative) => !autonomyPathAllowed(relative, pathScope))) {
    throw new Error("Autonomous Git commit reconciliation changed a path outside the approved autonomy scope");
  }
  if (JSON.stringify(committedPaths) !== JSON.stringify(approvedPaths)) {
    throw new Error("Autonomous Git commit reconciliation differs from the consumed path snapshot");
  }

  const untrackedByPath = new Map(snapshot.untrackedManifest.map((item) => [item.path, item]));
  if (untrackedByPath.size !== snapshot.untrackedManifest.length) {
    throw new Error("Autonomous Git commit reconciliation received a duplicate untracked path snapshot");
  }
  const trackedPaths = approvedPaths.filter((relative) => !untrackedByPath.has(relative));
  let trackedDiff = { stdout: Buffer.alloc(0) };
  if (trackedPaths.length > 0) {
    try {
      trackedDiff = await execBoundGitAuthority(manifest.cwd, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        preCommitHead,
        currentHead,
        "--",
        ...trackedPaths.map(literalGitPathspec)
      ], { encoding: "buffer", maxBuffer });
    } catch (error) {
      throw new Error(`Autonomous Git commit tracked diff could not be bounded: ${error.message}`);
    }
  }
  if (
    trackedDiff.stdout.byteLength !== snapshot.trackedDiffBytes ||
    sha256(trackedDiff.stdout) !== snapshot.trackedDiffDigest
  ) {
    throw new Error("Autonomous Git commit reconciliation differs from the consumed tracked diff snapshot");
  }

  for (const [relative, approved] of untrackedByPath) {
    const tree = await execBoundGitAuthority(manifest.cwd, [
      "ls-tree", "-z", currentHead, "--", literalGitPathspec(relative)
    ], { encoding: "buffer", maxBuffer });
    const entries = parseBoundGitNulPaths(tree.stdout, "Autonomous Git commit tree entry");
    if (entries.length !== 1) {
      throw new Error("Autonomous Git commit reconciliation did not create the approved untracked path exactly once");
    }
    const separator = entries[0].indexOf("\t");
    const header = separator >= 0 ? entries[0].slice(0, separator) : "";
    const observedPath = separator >= 0 ? entries[0].slice(separator + 1) : "";
    const [mode, type, objectId] = header.split(" ");
    if (
      observedPath !== relative || type !== "blob" || !/^[a-f0-9]{40,64}$/i.test(objectId ?? "") ||
      mode !== approved.mode
    ) {
      throw new Error("Autonomous Git commit reconciliation changed the approved untracked path mode, type, or identity");
    }
    const blob = await execBoundGitAuthority(manifest.cwd, ["cat-file", "blob", objectId], {
      encoding: "buffer",
      maxBuffer
    });
    if (blob.stdout.byteLength !== approved.bytes || sha256(blob.stdout) !== approved.digest) {
      throw new Error("Autonomous Git commit reconciliation changed approved untracked content");
    }
  }
}

async function verifyAutonomousCommitTransition(manifest, contract, record) {
  const recorded = sourceBindingWithoutDigest(record.preCommitSourceBinding);
  if (
    record.autonomyDecision?.decision !== "auto-approved" ||
    !recorded || record.preCommitSourceBinding.schemaVersion !== 3 ||
    !SHA256_DIGEST.test(recorded.digest ?? "") || digestObject(recorded.payload) !== recorded.digest ||
    !SHA.test(record.preCommitHeadRevision ?? "") ||
    record.preCommitSourceBinding.digest !== record.autonomySnapshot?.sourceBindingDigest ||
    record.preCommitSourceBinding.headRevision !== record.preCommitHeadRevision ||
    record.preCommitHeadRevision !== record.autonomySnapshot?.headRevision
  ) {
    throw new Error("Autonomous Git commit reconciliation lacks an immutable pre-action source binding");
  }
  const { captureSourceBinding } = await import("./git.mjs");
  const current = await captureSourceBinding(manifest.cwd, {
    baseRevision: record.preCommitSourceBinding.baseRevision,
    requireClean: true
  });
  if (!current || current.schemaVersion !== 3) {
    throw new Error("Autonomous Git commit reconciliation requires a clean schema-3 source binding");
  }
  if (
    digestObject(autonomousCommitSourceIdentity(current)) !==
    digestObject(autonomousCommitSourceIdentity(record.preCommitSourceBinding))
  ) {
    throw new Error("Autonomous Git commit reconciliation detected repository, branch, or remote identity drift");
  }
  if (manifest.autonomyProfile?.sourceBindingDigest !== manifest.sourceBinding?.digest ||
      ![record.preCommitSourceBinding.digest, current.digest].includes(manifest.sourceBinding?.digest) ||
      ![record.preCommitSourceBinding.digest, current.digest].includes(manifest.autonomyProfile?.sourceBindingDigest)) {
    throw new Error("Autonomous Git commit reconciliation detected an unrelated operational source binding");
  }
  let advancedBy;
  try {
    advancedBy = await rawLinearCommitDistance(
      manifest.cwd,
      record.preCommitHeadRevision,
      current.headRevision,
      1,
      "Autonomous Git commit transition"
    );
  } catch (error) {
    throw new Error(`Autonomous Git commit reconciliation requires exactly one commit per consumed token: ${error.message}`);
  }
  if (advancedBy !== 1) {
    throw new Error("Autonomous Git commit reconciliation requires exactly one commit per consumed token");
  }
  const sourceHead = manifest.autonomyProfile?.sourceHeadRevision;
  if (!SHA.test(sourceHead ?? "")) {
    throw new Error("Autonomous Git commit reconciliation lacks the immutable source-head anchor");
  }
  const maxCommits = contract.autonomyProfile?.limits?.maxCommits;
  let totalCommits;
  try {
    totalCommits = await rawLinearCommitDistance(
      manifest.cwd,
      sourceHead,
      current.headRevision,
      maxCommits,
      "Autonomous Git commit source ancestry"
    );
  } catch (error) {
    throw new Error(`Autonomous Git commit reconciliation exceeded maxCommits=${maxCommits} or left raw source ancestry: ${error.message}`);
  }
  if (!Number.isSafeInteger(totalCommits) || totalCommits < 0 || totalCommits > maxCommits) {
    throw new Error(`Autonomous Git commit reconciliation exceeded maxCommits=${maxCommits}`);
  }
  await boundedAutonomousCommitDiff(manifest, contract, record, current.headRevision);
  return current;
}

export async function issueActionToken(root, runId, request, currentTreeDigest, config) {
  if (request.action === "actions.dispatch") {
    throw new Error("GitHub Actions dispatch is deferred until immutable provider binding exists");
  }
  assertSupportedGovernedAction(request.action);
  for (const field of ["action", "provider", "resource", "remoteRevision"]) {
    if (typeof request[field] !== "string" || !request[field]) throw new Error(`Action ${field} is required`);
  }
  return withRunLock(root, runId, async ({ runDir }) => {
    const contract = await readJson(root, safeJoin(runDir, "contract.json"));
    assertActionIsNotDeferred(contract, request.action);
    if (contract.controlPlane?.reviewPolicy === "code-v2-pilot") {
      throw new Error("Action token denied because code-v2-pilot is shadow-only and cannot authorize side effects");
    }
    const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
    const state = await readJson(root, safeJoin(runDir, "state.json"));
    assertMutableRun({ state }, "Action token issuance");
    if (contract.autonomyProfile && state.autonomy?.status !== "ready") {
      throw new Error(`Action token denied because bounded autopilot is not ready: ${state.autonomy?.blockedReason ?? "preflight-required"}`);
    }
    const findings = await listJsonRecords(root, safeJoin(runDir, "findings"));
    const evidence = await listEffectiveEvidenceRecords(root, runId, {
      run: { runDir, manifest, contract, state }
    });
    const evidenceSupersessionFreshnessDigest = contract.schemaVersion === 2
      ? await currentEvidenceSupersessionFreshnessDigest(root, { runDir, manifest, contract, state })
      : null;
    const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
    let autonomyDecision = null;
    let autonomyDecisionReceipt = null;
    let autonomySnapshot = null;
    if (contract.autonomyProfile) {
      validateAutonomyBinding(contract.autonomyProfile);
      if (state.autonomy?.status !== "ready" || state.lastSentinelVerified !== true || state.lastSentinelComplete !== true) {
        throw new Error("Action token denied because bounded autopilot readiness is no longer verified");
      }
      const profile = await loadAutonomyProfile();
      if (autonomyProfileDigest(profile) !== contract.autonomyProfile.profileDigest) {
        throw new Error("Autonomy profile bundle drifted after run creation");
      }
      const requestedScope = request.action === "pr.create" && isDevDeliveryTemplate(contract.template)
        ? "dev"
        : request.scope;
      const decision = decideAutonomyAction(profile, request.action, {
        resource: request.resource,
        scope: requestedScope
      });
      autonomyDecisionReceipt = buildAutonomyDecisionReceipt({
        runId,
        binding: contract.autonomyProfile,
        sourceBindingDigest: manifest.autonomyProfile?.sourceBindingDigest ?? manifest.sourceBinding?.digest ?? null,
        request: {
          action: request.action,
          resource: request.resource,
          scope: requestedScope ?? request.resource
        },
        decision,
        tokenHash: null
      });
      if (decision.decision !== "auto-approved") {
        await appendJournal(root, runDir, "autonomy.decision", {
          decision: autonomyDecisionReceipt
        });
        assertAutonomyAction(profile, request.action, {
          resource: request.resource,
          scope: requestedScope
        });
      }
      autonomySnapshot = await currentAutonomySnapshot(manifest, contract, state);
      assertAutonomySnapshotIdentity(autonomySnapshot, state.autonomy?.snapshot, "Action token issuance");
      if (
        request.action === "git.commit" &&
        (await autonomousCommitAllocation(manifest, actions, autonomySnapshot)).allocated >= contract.autonomyProfile.limits.maxCommits
      ) {
        throw new Error(`Action token denied because bounded autopilot reached maxCommits=${contract.autonomyProfile.limits.maxCommits}`);
      }
      autonomyDecision = decision;
    }
    if (
      request.action === "pr.create" &&
      actions.some((action) => action.action === "pr.create" && action.status === "spent" && action.outcome === "success")
    ) {
      throw new Error("PR creation already succeeded for this run; reuse the registered pull request");
    }
    if (request.action === "pr.merge" && isDevDeliveryTemplate(contract.template)) {
      assertRunOwnedPullRequest(manifest, actions, runId, request.resource);
    }
    if (!state.lastSentinelVerified || state.lastSentinel?.digest !== currentTreeDigest) {
      throw new Error("Action token requires a verified current-tree sentinel");
    }
    if (state.lastSentinelComplete !== true) {
      throw new Error("Action token denied by incomplete bounded sentinel");
    }
    if (findings.some((item) => ["P0", "P1"].includes(item.severity) && item.status === "open")) {
      throw new Error("Action token denied by unresolved P0/P1 finding");
    }
    if (!Array.isArray(request.requiredEvidence) || request.requiredEvidence.length === 0) {
      throw new Error("Action token requires a declared pre-action evidence gate");
    }
    if (contract.schemaVersion === 2) {
      const configuredGate = contract.actionGates?.[request.action];
      if (!Array.isArray(configuredGate) || configuredGate.length === 0) {
        throw new Error(`No pre-action evidence gate is defined for: ${request.action}`);
      }
      if (
        request.requiredEvidence.length !== configuredGate.length ||
        request.requiredEvidence.some((kind, index) => kind !== configuredGate[index])
      ) {
        throw new Error("Action token denied because caller-selected evidence does not match the contract action gate");
      }
    }
    let admittedEvidence = evidence;
    if (contract.schemaVersion === 2) {
      const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
      for (const item of evidence.filter((record) => (
        record.schemaVersion === 2 && record.typedAdmission && record.stale !== true
      ))) {
        await validateTypedEvidenceRecord(item, {
          manifest,
          contract,
          root,
          runDir,
          requireReconciled: true
        });
      }
      admittedEvidence = evidence.filter((item) => (
        item.schemaVersion === 2 && item.typedAdmission && item.stale !== true
      ));
    }
    const initialActionEvidenceGateBinding = contract.schemaVersion === 2
      ? await currentActionEvidenceGateBinding(
          root,
          runId,
          { runDir, manifest, contract, state },
          request.action
        )
      : null;
    if (
      contract.actionStages &&
      Object.hasOwn(contract.actionStages, request.action) &&
      !ACTION_PROVIDER_RECEIPT_SCHEMAS[`${request.action}:${request.provider}`]
    ) {
      throw new Error(`Action provider pair is not supported by a live receipt verifier: ${request.action}:${request.provider}`);
    }
    let repository = null;
    if (request.action === "git.push") assertNoAmbientGitAuthorityOverrides();
    const needsProviderAuthorization = request.requiredEvidence.includes("remote-authorization") ||
      request.action === "pr.merge" ||
      (OWNED_RESOURCE_CREATION_ACTIONS.has(request.action) && request.provider === "github-cli");
    if (request.requiredEvidence.includes("target-branch-dev") || request.action === "pr.merge" || needsProviderAuthorization) {
      repository = await currentRepositoryIdentity(manifest.cwd);
      if (request.requiredEvidence.includes("target-branch-dev") || request.action === "pr.merge") {
        assertTargetBranchEvidence(admittedEvidence, request, repository, contract.remoteRevision ?? null);
      }
    }
    const providerExecutable = request.provider === "github-cli"
      ? await currentProviderExecutableIdentity("gh")
      : null;
    const providerAuthorizationExecutable = needsProviderAuthorization && repository?.startsWith("github.com/")
      ? providerExecutable ?? await currentProviderExecutableIdentity("gh")
      : null;
    const providerAuthorization = needsProviderAuthorization &&
      (request.provider === "github-cli" || (request.provider === "git" && repository?.startsWith("github.com/")))
      ? await verifyGitHubProviderAuthorization(manifest.cwd, repository, providerAuthorizationExecutable?.path)
      : null;
    if (request.requiredEvidence.includes("remote-authorization") && request.action !== "git.push") {
      assertRemoteAuthorizationEvidence(admittedEvidence, request, providerAuthorization, repository);
    }
    let actionBinding = {};
    if (providerExecutable) actionBinding.providerExecutable = providerExecutable;
    if (request.action === "git.push") {
      if (!request.requiredEvidence.includes("remote-authorization")) {
        throw new Error("Governed git.push requires remote-authorization evidence");
      }
      const [, remote, ref] = GIT_PUSH_RESOURCE.exec(request.resource) ?? [];
      if (!remote) throw new Error("Git push resources must use remote:<name>:refs/heads/<branch>");
      if (isDevDeliveryTemplate(contract.template) && ref === "refs/heads/dev") {
        throw new Error("pr-to-dev forbids direct pushes to protected dev");
      }
      const currentSourceBinding = await assertCurrentGitPushSourceBinding(manifest);
      const destination = await resolveGitPushDestination(manifest.cwd, remote);
      const { pushUrl, pushUrlDigest, remoteRepository, sourceRemoteBindingDigest } = destination;
      if (sourceRemoteBindingDigest !== currentSourceBinding.originIdentity.digest) {
        throw new Error("Git push destination differs from the immutable source remote binding");
      }
      if (remoteRepository !== repository) {
        throw new Error("Git push effective destination must match the authorized origin repository");
      }
      if (isDevDeliveryTemplate(contract.template) && (remote !== "origin" || remoteRepository !== repository)) {
        throw new Error("pr-to-dev git.push must use the canonical origin repository");
      }
      const expectedBranch = ref.slice("refs/heads/".length);
      const expectedRevision = (await execBoundGitAuthority(manifest.cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
      const gitProviderExecutable = await currentProviderExecutableIdentity(BOUND_GIT_EXECUTABLE);
      actionBinding = buildGitPushActionBinding({
        remote,
        pushUrl,
        remoteRepository,
        sourceBindingDigest: currentSourceBinding.digest,
        sourceRemoteBindingDigest,
        expectedBranch,
        expectedRevision,
        providerExecutable: gitProviderExecutable
      });
      if (request.requiredEvidence.includes("remote-authorization")) {
        if (!providerAuthorization || request.provider !== "git") {
          throw new Error("Git push requires a live GitHub identity plus a controlled Git credential check");
        }
        actionBinding.gitCredentialCheck = await verifyGitPushCredential(
          manifest.cwd,
          { remote, pushUrl, pushUrlDigest, ref, revision: expectedRevision, repository: remoteRepository, sourceRemoteBindingDigest },
          providerAuthorization.actor,
          {
            githubExecutablePath: providerAuthorizationExecutable.path,
            gitExecutablePath: gitProviderExecutable.path
          }
        );
        // A governed git.push has two deliberate revision anchors:
        // request.remoteRevision protects the reviewed/target base, while
        // expectedRevision is the exact commit that the credential dry-run
        // and fixed-argv push will transfer. PR actions use one revision.
        assertRemoteAuthorizationEvidence(
          admittedEvidence,
          request,
          providerAuthorization,
          repository,
          expectedRevision
        );
      }
      if (isDevDeliveryTemplate(contract.template)) {
        const currentBranch = (await execBoundGitAuthority(manifest.cwd, ["branch", "--show-current"])).stdout.trim();
        const currentBranchEvidence = admittedEvidence.find((item) => (
          item.kind === "current-branch" && item.status === "complete" && !item.stale &&
          item.receipt?.payload?.revision === expectedRevision &&
          [expectedBranch, `refs/heads/${expectedBranch}`].includes(item.receipt?.payload?.ref)
        ));
        if (currentBranch !== expectedBranch || !currentBranchEvidence) {
          throw new Error("pr-to-dev git.push must bind the current branch evidence to the pushed commit");
        }
      }
    }
    if (request.action === "actions.dispatch") {
      if (request.provider !== "github-cli") {
        throw new Error("GitHub Actions dispatch requires the github-cli provider");
      }
      if (!repository?.startsWith("github.com/")) {
        throw new Error("GitHub Actions dispatch requires a canonical GitHub repository");
      }
      if (!request.requiredEvidence.includes("remote-authorization")) {
        throw new Error("GitHub Actions dispatch requires remote-authorization evidence");
      }
      if (!SHA.test(request.remoteRevision)) {
        throw new Error("GitHub Actions dispatch requires an exact target revision");
      }
      const workflowFile = canonicalWorkflowFile(String(request.workflowFile ?? ""));
      const workflowResource = canonicalWorkflowResource(String(request.resource ?? ""));
      if (workflowResource !== `workflow:${workflowFile}`) {
        throw new Error("GitHub Actions dispatch resource must exactly bind the workflow-file selector");
      }
      const requestedDispatchRef = canonicalWorkflowRef(String(request.scope ?? ""));
      if (requestedDispatchRef.startsWith("refs/tags/")) {
        throw new Error("GitHub Actions dispatch tag refs are unsupported by branch-bound observation");
      }
      await execBoundGitAuthority(manifest.cwd, ["ls-files", "--error-unmatch", "--", workflowFile]);
      const workflowDispatchCapability = await readBoundWorkflowDispatchCapability(
        manifest.cwd,
        workflowFile,
        request.remoteRevision
      );
      const dispatchInputs = normalizeWorkflowInputs(request.dispatchInputs, {
        allowedPublicInputNames: workflowDispatchCapability.publicInputNames
      });
      for (const reservedInput of [WORKFLOW_DISPATCH_NONCE_INPUT, WORKFLOW_DISPATCH_EXPECTED_REVISION_INPUT]) {
        if (Object.hasOwn(dispatchInputs, reservedInput)) {
          throw new Error(`GitHub Actions dispatch input ${reservedInput} is reserved`);
        }
      }
      if (Object.keys(dispatchInputs).length > 18) {
        throw new Error("GitHub Actions dispatch requires two input slots for its provider-correlation gates");
      }
      const dispatchNonce = randomBytes(16).toString("hex");
      const boundDispatchInputs = normalizeWorkflowInputs({
        ...dispatchInputs,
        [WORKFLOW_DISPATCH_NONCE_INPUT]: dispatchNonce,
        [WORKFLOW_DISPATCH_EXPECTED_REVISION_INPUT]: request.remoteRevision
      }, {
        allowedPublicInputNames: workflowDispatchCapability.publicInputNames
      });
      const resolvedDispatchRef = await resolveBoundGitHubDispatchRef(
        manifest.cwd,
        repository,
        requestedDispatchRef,
        (providerExecutable ?? await currentProviderExecutableIdentity("gh")).path
      );
      if (resolvedDispatchRef.revision !== request.remoteRevision) {
        throw new Error("GitHub Actions dispatch ref does not resolve to the requested target revision");
      }
      if (resolvedDispatchRef.ref.startsWith("refs/tags/")) {
        throw new Error("GitHub Actions dispatch tag refs are unsupported by branch-bound observation");
      }
      const dispatchBinding = {
        action: request.action,
        provider: request.provider,
        resource: request.resource,
        remoteRevision: request.remoteRevision,
        workflowFile,
        dispatchRepository: repository,
        dispatchRef: resolvedDispatchRef.ref,
        dispatchNonce,
        dispatchInputs: boundDispatchInputs,
        dispatchInputsDigest: digestObject(boundDispatchInputs),
        workflowDispatchCapability,
        workflowDispatchCapabilityDigest: digestObject(workflowDispatchCapability),
        providerExecutable: providerExecutable ?? await currentProviderExecutableIdentity("gh")
      };
      actionBinding = {
        ...actionBinding,
        ...dispatchBinding,
        dispatchCommand: buildActionsDispatchCommand(dispatchBinding)
      };
    }
    if (request.action === "pr.create") {
      if (request.resource !== "pull/new") {
        throw new Error("Governed PR creation requires the pull/new resource");
      }
      const expectedHead = (await execBoundGitAuthority(manifest.cwd, [
        "rev-parse", "--verify", "HEAD^{commit}"
      ])).stdout.trim();
      if (!SHA.test(expectedHead)) throw new Error("PR creation requires an exact candidate source head");
      const targetRef = isDevDeliveryTemplate(contract.template) ? "dev" : String(request.scope ?? "");
      if (!/^[A-Za-z0-9._/-]+$/.test(targetRef)) {
        throw new Error("PR creation requires an exact target branch via --scope");
      }
      const headBranch = (await execBoundGitAuthority(manifest.cwd, ["branch", "--show-current"])).stdout.trim();
      if (!/^[A-Za-z0-9._/-]+$/.test(headBranch) || headBranch === targetRef) {
        throw new Error("PR creation requires a distinct current candidate branch");
      }
      const goal = String(manifest.goal ?? "Better Workflows delivery").replace(/\s+/g, " ").trim();
      const prTitle = `Better Workflows: ${goal || "delivery"}`.slice(0, 240);
      const prBodyPrefix = [
        "Automated Better Workflows delivery.",
        "",
        `Goal: ${goal || "Better Workflows delivery"}`
      ].join("\n");
      actionBinding = {
        ...actionBinding,
        expectedHead,
        targetRef,
        headBranch,
        createRepository: repository,
        prTitle,
        prBodyPrefix,
        providerExecutable: providerExecutable ?? await currentProviderExecutableIdentity("gh")
      };
    }
    if (request.action === "pr.merge") {
      const pullRequest = Number(String(request.resource).replace(/^pull\//, ""));
      if (!Number.isInteger(pullRequest)) throw new Error("PR merge resources must use pull/<number>");
      const currentHead = (await execBoundGitAuthority(manifest.cwd, [
        "rev-parse", "--verify", "HEAD^{commit}"
      ])).stdout.trim();
      actionBinding = buildPrMergeActionBinding({
        prior: actionBinding,
        pullRequest,
        reviewedHead: currentHead,
        remoteRevision: request.remoteRevision,
        targetRef: isDevDeliveryTemplate(contract.template) ? "dev" : null,
        providerExecutable: providerExecutable ?? await currentProviderExecutableIdentity("gh"),
        repository
      });
    }
    if (providerAuthorization) actionBinding.providerAuthorization = providerAuthorization;
    if (providerAuthorizationExecutable) actionBinding.providerAuthorizationExecutable = providerAuthorizationExecutable;
    let creationReservation = null;
    if (OWNED_RESOURCE_CREATION_ACTIONS.has(request.action)) {
      const providerRepository = request.provider === "github-cli"
        ? repository ?? await currentRepositoryIdentity(manifest.cwd)
        : await currentGitProviderIdentity(manifest.cwd);
      creationReservation = validateCreationReservationIdentity({
        provider: request.provider,
        repository: providerRepository,
        action: request.action,
        resource: request.resource
      });
      actionBinding.creationReservation = creationReservation;
    }
    if (request.action === "remote.sync" && isDevDeliveryTemplate(contract.template) && request.resource !== "refs/heads/dev") {
      throw new Error("pr-to-dev remote synchronization is restricted to refs/heads/dev");
    }
    if (request.action === "remote.sync") {
      const currentSourceBinding = await assertCurrentGitPushSourceBinding(manifest);
      const destination = await resolveGitFetchOrigin(manifest.cwd);
      const { remoteRepository, remoteUrlDigest, sourceRemoteBindingDigest } = destination;
      if (currentSourceBinding.originIdentity?.digest !== sourceRemoteBindingDigest) {
        throw new Error("Remote synchronization requires the immutable raw source remote binding");
      }
      if (repository && repository !== remoteRepository) {
        throw new Error("Remote synchronization origin differs from the authorized repository");
      }
      repository = remoteRepository;
      actionBinding = {
        ...actionBinding,
        remote: destination.remote,
        remoteRepository,
        remoteUrlDigest,
        sourceRemoteBindingDigest,
        sourceBindingDigest: currentSourceBinding.digest
      };
    }
    if (request.action === "plugin.cache.publish") {
      const pluginCacheRoot = getCodexPluginCacheRoot();
      if (manifest.pluginCacheRoot !== pluginCacheRoot) {
        throw new Error("Plugin cache action environment is bound to a different canonical cache root");
      }
      actionBinding = {
        ...actionBinding,
        cacheRoot: pluginCacheRoot
      };
    }
    if (autonomyDecision) {
      actionBinding.autonomyDecision = autonomyDecision;
      actionBinding.autonomySnapshot = autonomySnapshot;
      if (request.action === "git.commit") {
        if (!manifest.sourceBinding || manifest.sourceBinding.schemaVersion !== 3) {
          throw new Error("Autonomous Git commit issuance requires a schema-3 operational source binding");
        }
        if (
          manifest.sourceBinding.digest !== manifest.autonomyProfile?.sourceBindingDigest ||
          manifest.sourceBinding.digest !== autonomySnapshot.sourceBindingDigest ||
          manifest.sourceBinding.headRevision !== autonomySnapshot.headRevision
        ) {
          throw new Error("Autonomous Git commit issuance requires the readiness snapshot to match the operational source binding");
        }
        actionBinding.preCommitSourceBinding = manifest.sourceBinding;
        actionBinding.preCommitHeadRevision = autonomySnapshot.headRevision;
      }
    }
    let creationPrecondition = null;
    if (request.action === "pr.merge" && contract.controlPlane?.reviewPolicy !== "none") {
      const { isIndependentCriticEvidence } = await import("./evidence.mjs");
      const { isQuorumEvidence, changedPathsFromDiffManifest } = await import("./quorum.mjs");
      const { reviewPackageDigest } = await import("./review.mjs");
      const { assertReviewContinuity, reviewStatus } = await import("./review.mjs");
      const review = await reviewStatus(root, runId);
      const currentHead = (await execBoundGitAuthority(manifest.cwd, [
        "rev-parse", "--verify", "HEAD^{commit}"
      ])).stdout.trim();
      if (!review.complete || review.package?.head !== currentHead) {
        throw new Error("Action token denied until the exact review package is complete");
      }
      const hasIndependentCritic = admittedEvidence.some((item) => isIndependentCriticEvidence(item, {
        reviewPackage: review.package,
        sentinelDigest: state.lastSentinel?.digest
      })) || (quorumReviewEnabled(contract.controlPlane?.reviewPolicy) && admittedEvidence.some((item) => isQuorumEvidence(item, {
        registryCwd: manifest.cwd,
        expected: {
          runId,
          sourceBindingDigest: manifest.sourceBinding?.digest,
          sourceSentinelDigest: state.lastSentinel?.digest,
          contractDigest: digestObject(contract),
          templateDigest: contract.templateDigest,
          reviewPackageId: review.package.packageId,
          reviewPackageDigest: reviewPackageDigest(review.package),
          base: review.package.base,
          head: review.package.head,
          mergeBase: review.package.mergeBase,
          changedPaths: changedPathsFromDiffManifest(review.package.diffManifest)
        }
      })));
      if (!hasIndependentCritic) throw new Error("Action token denied until the exact independent critic or agent-review-quorum evidence is admitted");
      await assertPullEvidenceBinding(admittedEvidence, request, review.package, contract, repository);
      const continuity = await assertReviewContinuity(root, runId);
      actionBinding = {
        ...actionBinding,
        reviewedHead: review.package.head,
        reviewPackageId: review.package.packageId,
        reviewContinuityDigest: continuity.continuityDigest,
        pullRequest: Number(String(request.resource).replace(/^pull\//, ""))
      };
    }
    if (["remote.sync", "worktree.cleanup"].includes(request.action) && contract.controlPlane?.reviewPolicy !== "none") {
      const { assertReviewContinuity, reviewStatus } = await import("./review.mjs");
      const review = await reviewStatus(root, runId);
      if (!review.complete) throw new Error("Action token denied until the exact review package is complete");
      const continuity = await assertReviewContinuity(root, runId);
      actionBinding = {
        ...actionBinding,
        reviewedHead: continuity.head,
        reviewPackageId: continuity.packageId,
        reviewContinuityDigest: continuity.continuityDigest
      };
      if (request.action === "remote.sync") {
        const mergeBinding = assertRemoteSyncMergeBinding(admittedEvidence, review.package, contract, repository);
        const mergeAction = assertPersistedSuccessfulMergeAction(actions, mergeBinding);
        await verifyRecordedGitHubProvider(manifest, mergeAction);
        if (mergeAction.providerAuthorization?.repository !== repository) {
          throw new Error("Remote synchronization requires the persisted merge provider authorization for the same repository");
        }
        actionBinding = {
          ...actionBinding,
          ...mergeBinding,
          providerExecutable: mergeAction.providerExecutable,
          providerAuthorizationExecutable: mergeAction.providerAuthorizationExecutable ?? mergeAction.providerExecutable,
          providerAuthorization: mergeAction.providerAuthorization
        };
      }
    }
    if (request.action === "pr.merge" && request.requiredEvidence.includes("required-checks")) {
      const currentHead = (await execBoundGitAuthority(manifest.cwd, [
        "rev-parse", "--verify", "HEAD^{commit}"
      ])).stdout.trim();
      const requiredCheckCandidates = admittedEvidence.filter((item) => {
        const payload = item.kind === "required-checks" ? item.receipt?.payload : null;
        return payload?.head === currentHead && payload?.base === contract.remoteRevision && payload?.repository === repository;
      });
      if (requiredCheckCandidates.length !== 1) {
        throw new Error("Action token denied until one exact required-check provider evidence record is present");
      }
      const requiredChecks = requiredCheckCandidates[0];
      const checkVerification = await verifyRequiredChecksProvider(
        manifest.cwd,
        requiredChecks.receipt.payload,
        providerExecutable
      );
      actionBinding = {
        ...actionBinding,
        requiredChecksEvidenceId: requiredChecks.id
      };
      if (checkVerification.humanApproval) {
        const humanApprovalDigest = checkVerification.humanApproval.authorizationDigest;
        if (providerAuthorization?.actor !== checkVerification.humanApproval.actor) {
          throw new Error("Governed PR merge human approval actor does not match the live provider actor");
        }
        const mergeAuthorization = findExactMergeHumanAuthorization(admittedEvidence, {
          action: request.action,
          provider: request.provider,
          resource: request.resource,
          remoteRevision: request.remoteRevision,
          repository,
          actor: providerAuthorization.actor,
          humanApprovalDigest
        });
        if (!mergeAuthorization) {
          throw new Error("Governed PR merge human approval is not bound to exact user remote authorization");
        }
        actionBinding = {
          ...actionBinding,
          mergeHumanApprovalDigest: humanApprovalDigest,
          mergeAuthorizationEvidenceId: mergeAuthorization.id
        };
      }
    }
    if (request.action === "pr.merge") {
      await verifyPullRequestBeforeMerge(manifest.cwd, actionBinding, providerExecutable?.path);
    }
    const availableEvidence = new Set(
      admittedEvidence
        .filter((item) => item.status === "complete" && !item.stale)
        .map((item) => item.kind)
    );
    const missingEvidence = request.requiredEvidence.filter((kind) => !availableEvidence.has(kind));
    if (missingEvidence.length > 0) {
      throw new Error(`Action token missing evidence: ${missingEvidence.join(", ")}`);
    }
    if (DESTRUCTIVE_CLEANUP_ACTIONS.has(request.action)) {
      if (!request.requiredEvidence.includes("actions-cleanup-plan")) {
        throw new Error("Destructive cleanup actions require actions-cleanup-plan evidence");
      }
      const cleanupPlan = admittedEvidence.find((item) => item.kind === "actions-cleanup-plan");
      assertCleanupResourceBinding(manifest, runId, request, cleanupPlan, actions);
      if (
        isDevDeliveryTemplate(contract.template) &&
        !actions.some((action) => (
          action.action === "remote.sync" &&
          action.status === "spent" &&
          action.outcome === "success" &&
          action.resource === "refs/heads/dev" &&
          action.receipt?.providerReceipt?.providerRevision === action.mergeCommit &&
          action.receipt?.providerReceipt?.localRevision === action.mergeCommit
        ))
      ) {
        throw new Error("pr-to-dev cleanup requires a successful reconciled remote.sync action");
      }
    }
    const authorities = contract.authority?.externalSideEffects ?? [];
    if (!authorities.includes(request.action) && !authorities.includes("*")) {
      throw new Error(`Action not authorized by TaskContract: ${request.action}`);
    }
    if (contract.remoteRevision && contract.remoteRevision !== request.remoteRevision) {
      throw new Error("Remote revision does not match TaskContract");
    }
    if (contract.schemaVersion === 2 && contract.actionStages) {
      const stageId = contract.actionStages[request.action];
      if (!stageId) throw new Error(`No execution stage is bound to action: ${request.action}`);
      const { deriveLedgerStatus } = await import("./ledger.mjs");
      const ledger = await deriveLedgerStatus(root, runId);
      if (ledger.blockers.length > 0) {
        throw new Error(`Action token denied by execution ledger: ${ledger.blockers.join(", ")}`);
      }
      const stage = ledger.taskStates.find((item) => item.id === stageId);
      if (!stage || (stage.state !== "in_progress" && !ledger.readySet.includes(stageId))) {
        throw new Error(`Action token denied until execution stage is ready: ${stageId}`);
      }
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    const persistedScope = request.action === "pr.create" && isDevDeliveryTemplate(contract.template)
      ? "dev"
      : request.scope ?? request.resource;
    const ttlSeconds = Number(request.ttlSeconds ?? config.actionToken.ttlSeconds);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) {
      throw new Error("Action token TTL must be 1..3600 seconds");
    }
    let reservationHeld = false;
    const issuedAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    try {
      if (OWNED_RESOURCE_CREATION_ACTIONS.has(request.action)) {
        // Reserve before observing absence so an external creator cannot win the gap.
        await reserveCreationResource(root, runId, creationReservation, tokenHash, expiresAt);
        reservationHeld = true;
        creationPrecondition = await captureCreationPrecondition(
          manifest.cwd,
          request.action,
          request.resource,
          providerExecutable?.path,
          repository
        );
        if (!creationPrecondition || creationPrecondition.state !== "absent") {
          throw new Error("Owned resource creation requires an observed absent precondition after reservation");
        }
      }
      const issuedAutonomyDecisionReceipt = autonomyDecision
        ? buildAutonomyDecisionReceipt({
            runId,
            binding: contract.autonomyProfile,
            sourceBindingDigest: manifest.autonomyProfile?.sourceBindingDigest ?? manifest.sourceBinding?.digest ?? null,
            request: {
              action: request.action,
              resource: request.resource,
              scope: persistedScope
            },
            decision: autonomyDecision,
            tokenHash
          })
        : null;
      const finalEvidenceSupersessionFreshnessDigest = contract.schemaVersion === 2
        ? await currentEvidenceSupersessionFreshnessDigest(root, { runDir, manifest, contract, state })
        : null;
      if (finalEvidenceSupersessionFreshnessDigest !== evidenceSupersessionFreshnessDigest) {
        throw new Error("Action token denied because immutable evidence freshness changed during issuance");
      }
      const finalActionEvidenceGateBinding = contract.schemaVersion === 2
        ? await currentActionEvidenceGateBinding(
            root,
            runId,
            await loadRun(root, runId),
            request.action
          )
        : null;
      if (finalActionEvidenceGateBinding?.digest !== initialActionEvidenceGateBinding?.digest) {
        throw new Error("Action token denied because the configured evidence gate changed during issuance");
      }
      const record = {
        schemaVersion: 1,
        tokenHash,
        status: "issued",
        outcome: null,
        issuedAt,
        expiresAt,
        runId,
        action: request.action,
        provider: request.provider,
        resource: request.resource,
        scope: persistedScope,
        remoteRevision: request.remoteRevision,
        ...actionBinding,
        ...(issuedAutonomyDecisionReceipt ? { autonomyDecisionReceipt: issuedAutonomyDecisionReceipt } : {}),
        ...(creationPrecondition ? { creationPrecondition } : {}),
        treeDigest: currentTreeDigest,
        contractDigest: digestObject(contract),
        ...(finalEvidenceSupersessionFreshnessDigest
          ? { evidenceSupersessionFreshnessDigest: finalEvidenceSupersessionFreshnessDigest }
          : {}),
        ...(finalActionEvidenceGateBinding
          ? {
              evidenceGate: finalActionEvidenceGateBinding.configuredGate,
              evidenceGateDigest: finalActionEvidenceGateBinding.digest
            }
          : {}),
        idempotencyKey: `sbw-${runId}-${randomUUID()}`
      };
      await atomicWriteJson(root, safeJoin(runDir, "actions", `${tokenHash}.json`), record);
      await appendJournal(root, runDir, "action.issued", {
        action: record.action,
        provider: record.provider,
        resource: record.resource,
        tokenHash,
        autonomyDecision: record.autonomyDecision ?? null,
        autonomyDecisionReceipt: record.autonomyDecisionReceipt ?? null
      });
      return { token, ...record };
    } catch (error) {
      if (reservationHeld) await releaseCreationResource(root, runId, creationReservation, tokenHash);
      throw error;
    }
  });
}

async function consumeActionTokenInternal(root, runId, token, currentTreeDigest, allowWrapperExecution = false) {
  const tokenHash = sha256(token);
  return withRunLock(root, runId, async ({ runDir }) => {
    const state = await readJson(root, safeJoin(runDir, "state.json"));
    assertMutableRun({ state }, "Action token consumption");
    const target = safeJoin(runDir, "actions", `${tokenHash}.json`);
    const record = await readJson(root, target);
    assertSupportedGovernedAction(record.action);
    const contract = await readJson(root, safeJoin(runDir, "contract.json"));
    assertActionIsNotDeferred(contract, record.action);
    if (contract.autonomyProfile) {
      validateAutonomyBinding(contract.autonomyProfile);
      if (state.autonomy?.status !== "ready" || state.lastSentinelVerified !== true || state.lastSentinelComplete !== true) {
        throw new Error("Action consumption denied because bounded autopilot readiness is no longer verified");
      }
      const profile = await loadAutonomyProfile();
      if (autonomyProfileDigest(profile) !== contract.autonomyProfile.profileDigest) {
        throw new Error("Action consumption denied because the autonomy profile bundle changed");
      }
      const decision = assertAutonomyAction(profile, record.action, {
        resource: record.resource,
        scope: record.scope
      });
      if (JSON.stringify(decision) !== JSON.stringify(record.autonomyDecision)) {
        throw new Error("Action consumption denied because the autonomy decision binding changed");
      }
      const expectedReceipt = buildAutonomyDecisionReceipt({
        runId,
        binding: contract.autonomyProfile,
        sourceBindingDigest: (await readJson(root, safeJoin(runDir, "manifest.json"))).autonomyProfile?.sourceBindingDigest ?? null,
        request: {
          action: record.action,
          resource: record.resource,
          scope: record.scope
        },
        decision,
        tokenHash
      });
      if (JSON.stringify(expectedReceipt) !== JSON.stringify(record.autonomyDecisionReceipt)) {
        throw new Error("Action consumption denied because the autonomy decision receipt changed");
      }
      const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
      const snapshot = await currentAutonomySnapshot(manifest, contract, state);
      assertAutonomySnapshotIdentity(snapshot, state.autonomy?.snapshot, "Action consumption");
      assertAutonomySnapshotIdentity(snapshot, record.autonomySnapshot, "Action consumption token");
      if (record.action === "git.commit") {
        const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
        if ((await autonomousCommitAllocation(manifest, actions, snapshot)).allocated > contract.autonomyProfile.limits.maxCommits) {
          throw new Error(`Action consumption denied because bounded autopilot exceeded maxCommits=${contract.autonomyProfile.limits.maxCommits}`);
        }
      }
    }
    if (!allowWrapperExecution && EXECUTABLE_ACTION_PROVIDERS.has(`${record.action}:${record.provider}`)) {
      throw new Error("Wrapper-backed governed actions must use action execute; direct consume is not allowed");
    }
    if (record.status !== "issued") throw new Error("Action token was already consumed");
    if (Date.parse(record.expiresAt) <= Date.now()) throw new Error("Action token expired");
    if (
      record.action === "plugin.cache.publish" &&
      (typeof record.cacheRoot !== "string" || record.cacheRoot !== getCodexPluginCacheRoot())
    ) {
      throw new Error("Plugin cache action environment is bound to a different canonical cache root");
    }
    if (OWNED_RESOURCE_CREATION_ACTIONS.has(record.action)) {
      await assertCreationReservation(root, runId, record.creationReservation, tokenHash, record.expiresAt);
    }
    if (record.treeDigest !== currentTreeDigest) throw new Error("Action token tree binding changed");
    if (record.contractDigest !== digestObject(contract)) throw new Error("Action token contract binding changed");
    const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
    if (contract.schemaVersion === 2) {
      if (!SHA256_DIGEST.test(record.evidenceSupersessionFreshnessDigest ?? "")) {
        throw new Error("Action consumption denied because immutable evidence freshness is unbound");
      }
      const currentFreshnessDigest = await currentEvidenceSupersessionFreshnessDigest(root, {
        runDir,
        manifest,
        contract,
        state
      });
      if (currentFreshnessDigest !== record.evidenceSupersessionFreshnessDigest) {
        throw new Error("Action consumption denied because immutable evidence freshness changed");
      }
      const configuredGate = contract.actionGates?.[record.action];
      if (
        !Array.isArray(record.evidenceGate) ||
        !Array.isArray(configuredGate) ||
        digestObject(record.evidenceGate) !== digestObject(configuredGate) ||
        !SHA256_DIGEST.test(record.evidenceGateDigest ?? "")
      ) {
        throw new Error("Action consumption denied because the configured evidence gate is unbound");
      }
      const currentGateBinding = await currentActionEvidenceGateBinding(
        root,
        runId,
        await loadRun(root, runId),
        record.action
      );
      if (currentGateBinding.digest !== record.evidenceGateDigest) {
        throw new Error("Action consumption denied because the configured evidence gate changed");
      }
    }
    if (record.action === "actions.dispatch" && record.provider === "github-cli") {
      const liveWorkflowCapability = await readBoundWorkflowDispatchCapability(
        manifest.cwd,
        record.workflowFile,
        record.remoteRevision
      );
      if (
        digestObject(liveWorkflowCapability) !== record.workflowDispatchCapabilityDigest ||
        digestObject(record.workflowDispatchCapability ?? {}) !== record.workflowDispatchCapabilityDigest
      ) {
        throw new Error("Action consumption denied because the workflow dispatch capability changed or is unbound");
      }
    }
    if (record.reviewPackageId) {
      const { assertReviewContinuity } = await import("./review.mjs");
      await assertReviewContinuity(root, runId, {
        packageId: record.reviewPackageId,
        head: record.reviewedHead,
        continuityDigest: record.reviewContinuityDigest
      });
    }
    if (record.action === "git.push") {
      const currentSourceBinding = await assertCurrentGitPushSourceBinding(manifest, record.sourceBindingDigest);
      if (currentSourceBinding.originIdentity.digest !== record.sourceRemoteBindingDigest) {
        throw new Error("Action consumption denied because the raw source remote binding changed");
      }
    }
    if (record.action === "remote.sync") {
      const currentSourceBinding = await assertCurrentGitPushSourceBinding(manifest, record.sourceBindingDigest);
      const destination = await resolveGitFetchOrigin(manifest.cwd);
      if (
        destination.remote !== record.remote ||
        destination.remoteRepository !== record.remoteRepository ||
        destination.remoteUrlDigest !== record.remoteUrlDigest ||
        destination.sourceRemoteBindingDigest !== record.sourceRemoteBindingDigest ||
        currentSourceBinding.originIdentity?.digest !== record.sourceRemoteBindingDigest
      ) {
        throw new Error("Remote synchronization consumption denied because the immutable source or raw remote binding changed");
      }
    }
    const githubProviderExecutable = record.provider === "github-cli" || record.providerAuthorization?.provider === "github-cli"
      ? await verifyRecordedGitHubExecutable(
        record,
        record.providerAuthorizationExecutable ? "providerAuthorizationExecutable" : "providerExecutable"
      )
      : null;
    let liveGithubAuthorization = null;
    if (record.providerAuthorization?.provider === "github-cli") {
      const repository = await currentRepositoryIdentity(manifest.cwd);
      const authorization = await verifyGitHubProviderAuthorization(manifest.cwd, repository, githubProviderExecutable.path);
      if (digestObject(authorization) !== digestObject(record.providerAuthorization)) {
        throw new Error("Action consumption denied because GitHub provider authorization changed");
      }
      liveGithubAuthorization = authorization;
    }
    if (record.gitCredentialCheck) {
      const gitExecutable = await verifyRecordedExecutable(
        record.providerExecutable,
        BOUND_GIT_EXECUTABLE,
        "Git push provider"
      );
      const credentialCheck = await verifyGitPushCredential(
        manifest.cwd,
        {
          remote: record.remote,
          pushUrl: record.pushUrl,
          pushUrlDigest: record.pushUrlDigest,
          ref: record.gitCredentialCheck.ref,
          revision: record.gitCredentialCheck.revision,
          repository: record.gitCredentialCheck.repository,
          sourceRemoteBindingDigest: record.sourceRemoteBindingDigest
        },
        record.providerAuthorization?.actor ?? null,
        {
          githubExecutablePath: githubProviderExecutable.path,
          gitExecutablePath: gitExecutable.path
        }
      );
      if (digestObject(credentialCheck) !== digestObject(record.gitCredentialCheck)) {
        throw new Error("Action consumption denied because the controlled Git credential check changed");
      }
    }
    const actionExecutable = record.action === "git.push"
      ? await currentProviderExecutableIdentity(BOUND_GIT_EXECUTABLE)
      : ["pr.create", "pr.merge", "actions.dispatch"].includes(record.action)
        ? githubProviderExecutable
        : null;
    if (actionExecutable) {
      const executable = actionExecutable;
      if (digestObject(executable) !== digestObject(record.providerExecutable)) {
        throw new Error("Action consumption denied because the governed provider executable changed");
      }
    }
    if (record.action === "pr.merge") {
      await verifyPullRequestBeforeMerge(manifest.cwd, record, githubProviderExecutable?.path);
      if (contract.actionGates?.[record.action]?.includes("required-checks")) {
        const repository = await currentRepositoryIdentity(manifest.cwd);
        const evidence = await listEffectiveEvidenceRecords(root, runId, {
          run: await loadRun(root, runId)
        });
        const requiredChecks = assertPersistedRequiredChecksEvidence(record, evidence, { repository });
        const run = await loadRun(root, runId);
        const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
        await validateTypedEvidenceRecord(requiredChecks, {
          manifest: run.manifest,
          contract: run.contract,
          root,
          runDir,
          requireReconciled: true
        });
        const checkVerification = await verifyRequiredChecksProvider(
          manifest.cwd,
          requiredChecks.receipt.payload,
          githubProviderExecutable
        );
        const mergeAuthorization = assertPersistedMergeHumanAuthorizationEvidence(
          record,
          evidence,
          checkVerification,
          { actor: liveGithubAuthorization?.actor, repository }
        );
        if (mergeAuthorization) {
          await validateTypedEvidenceRecord(mergeAuthorization, {
            manifest: run.manifest,
            contract: run.contract,
            root,
            runDir,
            requireReconciled: true
          });
        }
      }
    }
    if (record.action === "remote.sync") {
      const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
      assertPersistedSuccessfulMergeAction(actions, record);
    }
    if (contract.schemaVersion === 2) {
      const finalFreshnessDigest = await currentEvidenceSupersessionFreshnessDigest(root, {
        runDir,
        manifest,
        contract,
        state
      });
      if (finalFreshnessDigest !== record.evidenceSupersessionFreshnessDigest) {
        throw new Error("Action consumption denied because immutable evidence freshness changed before execution");
      }
      const finalGateBinding = await currentActionEvidenceGateBinding(
        root,
        runId,
        await loadRun(root, runId),
        record.action
      );
      if (finalGateBinding.digest !== record.evidenceGateDigest) {
        throw new Error("Action consumption denied because the configured evidence gate changed before execution");
      }
    }
    const consume = async () => {
      if (OWNED_RESOURCE_CREATION_ACTIONS.has(record.action)) {
        await assertCreationReservation(root, runId, record.creationReservation, tokenHash, record.expiresAt);
      }
      const attemptId = randomUUID();
      const spentAt = nowIso();
      const next = {
        ...record,
        status: "spent",
        outcome: "pending",
        spentAt,
        attemptId
      };
      if (record.action === "actions.dispatch" && record.provider === "github-cli") {
        // Bind the consumed token to an explicit pre-invocation boundary in
        // the same durable write. A crash after consumption but before the
        // first provider write can then be reconciled as not-sent without a
        // second dispatch attempt.
        next.providerInvocation = workflowDispatchPreInvocation(runId, { ...record, attemptId }, spentAt);
      }
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "action.consumed", { attemptId, tokenHash });
      return next;
    };
    return OWNED_RESOURCE_CREATION_ACTIONS.has(record.action)
      ? await withCreationReservationLock(root, record.creationReservation, consume)
      : consume();
  });
}

export async function consumeActionToken(root, runId, token, currentTreeDigest) {
  return consumeActionTokenInternal(root, runId, token, currentTreeDigest, false);
}

function githubPreflightInvocation(runId, action, error) {
  const command = action.action === "pr.merge" ? action.mergeCommand : buildPrCreateCommand(action);
  if (!Array.isArray(command) || !["pr.create", "pr.merge"].includes(action.action)) {
    throw new Error("GitHub provider preflight receipt requires a fixed PR command");
  }
  const timestamp = nowIso();
  return {
    schemaVersion: 1,
    id: `github-${action.action}-preflight:${runId}:${action.attemptId}`,
    actionAttemptId: action.attemptId,
    provider: "github-cli",
    command,
    ...(action.action === "pr.merge" ? { adminBypass: false } : {}),
    providerExecutable: action.providerExecutable,
    providerAuthorizationExecutable: action.providerAuthorizationExecutable,
    providerAuthorization: action.providerAuthorization,
    startedAt: timestamp,
    finishedAt: timestamp,
    exitCode: null,
    dispatchState: "not-sent",
    errorDigest: sha256(error?.message ?? "provider preflight failed")
  };
}

const WORKFLOW_DISPATCH_OBSERVATION_TIMEOUT_MS = 45 * 60 * 1000;
const WORKFLOW_DISPATCH_POLL_INTERVAL_MS = 10 * 1000;
const WORKFLOW_DISPATCH_PREFLIGHT_LEASE_MS = 5 * 60 * 1000;
const WORKFLOW_DISPATCH_MAX_RECENT_RUNS = 100;
// Keep this list to fields supported by `gh run view --json`; in particular,
// startedAt is not a valid gh field and would strand a sent dispatch during
// nonce-bound observation.
const WORKFLOW_RUN_JSON_FIELDS = "databaseId,workflowName,displayTitle,status,conclusion,headSha,headBranch,createdAt,url";

function normalizeWorkflowRun(run) {
  return {
    databaseId: run?.databaseId ?? run?.id,
    workflowName: run?.workflowName ?? run?.name,
    displayTitle: run?.displayTitle ?? run?.display_title,
    status: run?.status,
    conclusion: run?.conclusion,
    headSha: run?.headSha ?? run?.head_sha,
    headBranch: run?.headBranch ?? run?.head_branch,
    createdAt: run?.createdAt ?? run?.created_at,
    startedAt: run?.startedAt ?? run?.run_started_at,
    url: run?.url ?? run?.html_url
  };
}

async function listWorkflowRuns(cwd, record, providerExecutablePath, { createdFilter, createdAtUpperBoundMs = null, maxRuns = WORKFLOW_DISPATCH_MAX_RECENT_RUNS } = {}) {
  const repository = canonicalGitHubRepositoryPath(record.dispatchRepository);
  const workflowFile = encodeURIComponent(path.posix.basename(canonicalWorkflowFile(record.workflowFile)));
  const branch = encodeURIComponent(workflowDispatchObservationRef(record.dispatchRef));
  const created = createdFilter ? `&created=${encodeURIComponent(createdFilter)}` : "";
  const boundedMaxRuns = Number.isInteger(maxRuns) && maxRuns > 0
    ? Math.min(maxRuns, WORKFLOW_DISPATCH_MAX_RECENT_RUNS)
    : WORKFLOW_DISPATCH_MAX_RECENT_RUNS;
  const output = await execBoundGitHubCli(providerExecutablePath, [
    "api",
    `repos/${repository}/actions/workflows/${workflowFile}/runs?per_page=${boundedMaxRuns}&page=1&branch=${branch}${created}`,
    "--method", "GET"
  ], { cwd });
  const payload = JSON.parse(output.stdout);
  const pages = Array.isArray(payload) ? payload : [payload];
  let declaredTotal = 0;
  const runs = pages.flatMap((page) => {
    if (Array.isArray(page)) return page;
    if (Array.isArray(page?.workflow_runs)) {
      const total = Number(page.total_count);
      if (Number.isInteger(total) && total >= 0) declaredTotal = Math.max(declaredTotal, total);
      return page.workflow_runs;
    }
    throw new Error("GitHub Actions workflow list returned an invalid page");
  });
  if (declaredTotal > boundedMaxRuns || runs.length > boundedMaxRuns) {
    throw new Error(`GitHub Actions workflow list exceeded bounded recent run limit of ${boundedMaxRuns}`);
  }
  return runs
    .map(normalizeWorkflowRun)
    .filter((run) => {
      if (!Number.isFinite(createdAtUpperBoundMs)) return true;
      const createdAt = Date.parse(String(run?.createdAt ?? ""));
      return Number.isFinite(createdAt) && createdAt <= createdAtUpperBoundMs;
    });
}

async function viewWorkflowRun(cwd, record, providerExecutablePath, runId) {
  const output = await execBoundGitHubCli(providerExecutablePath, [
    "run", "view", String(runId),
    "--repo", canonicalGitHubRepositoryPath(record.dispatchRepository),
    "--json", WORKFLOW_RUN_JSON_FIELDS
  ], { cwd });
  const run = JSON.parse(output.stdout);
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new Error("GitHub Actions workflow view returned an invalid result");
  }
  return run;
}

export function workflowDispatchMinimumCreatedAt(observationStartedAt) {
  const startedAt = Date.parse(observationStartedAt);
  if (!Number.isFinite(startedAt)) {
    throw new Error("GitHub Actions dispatch observation lower bound is invalid");
  }
  return startedAt - 10_000;
}

async function observeDispatchedWorkflow(cwd, record, providerExecutablePath, existingRunIds, observationStartedAt, { persistCandidate } = {}) {
  const known = new Set(existingRunIds.map(String));
  const expectedHeadBranch = workflowDispatchObservationRef(record.dispatchRef);
  const minimumCreatedAt = workflowDispatchMinimumCreatedAt(observationStartedAt);
  let observedRunId = record.providerInvocation?.observedRunId ? String(record.providerInvocation.observedRunId) : null;
  const deadline = Date.now() + WORKFLOW_DISPATCH_OBSERVATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const runs = await listWorkflowRuns(cwd, record, providerExecutablePath, {
      createdFilter: `>=${new Date(minimumCreatedAt).toISOString()}`
    });
    const candidates = runs.filter((run) => {
      const runId = String(run?.databaseId ?? "");
      const createdAt = Date.parse(run?.createdAt ?? "");
      return (
        /^\d+$/.test(runId) && !known.has(runId) &&
        run.headBranch === expectedHeadBranch &&
        WORKFLOW_DISPATCH_NONCE.test(String(record.dispatchNonce ?? "")) &&
        typeof run.displayTitle === "string" &&
        run.displayTitle.includes(record.dispatchNonce) &&
        Number.isFinite(createdAt) && createdAt >= minimumCreatedAt
      );
    });
    const additionalCandidates = observedRunId
      ? candidates.filter((run) => String(run.databaseId) !== observedRunId)
      : candidates;
    if (observedRunId ? additionalCandidates.length > 0 : additionalCandidates.length > 1) {
      throw new Error("GitHub Actions dispatch produced more than one unclaimed matching run");
    }
    if (!observedRunId && additionalCandidates.length === 1) {
      observedRunId = String(additionalCandidates[0].databaseId);
      if (persistCandidate) await persistCandidate(observedRunId);
    }
    if (observedRunId) {
      const observed = await viewWorkflowRun(cwd, record, providerExecutablePath, observedRunId);
      if (observed.status === "completed") {
        if (observed.headSha !== record.remoteRevision) {
          throw new Error(`GitHub Actions dispatch observed a nonce-bound workflow run at revision ${observed.headSha}, expected ${record.remoteRevision}`);
        }
        const finalRuns = await listWorkflowRuns(cwd, record, providerExecutablePath, {
          createdFilter: `>=${new Date(minimumCreatedAt).toISOString()}`
        });
        const finalCandidates = finalRuns.filter((run) => {
          const runId = String(run?.databaseId ?? "");
          const createdAt = Date.parse(run?.createdAt ?? "");
          return (
            /^\d+$/.test(runId) && !known.has(runId) &&
            run.headBranch === expectedHeadBranch &&
            WORKFLOW_DISPATCH_NONCE.test(String(record.dispatchNonce ?? "")) &&
            typeof run.displayTitle === "string" &&
            run.displayTitle.includes(record.dispatchNonce) &&
            Number.isFinite(createdAt) && createdAt >= minimumCreatedAt
          );
        });
        if (finalCandidates.length !== 1 || String(finalCandidates[0]?.databaseId) !== observedRunId) {
          throw new Error("GitHub Actions dispatch produced more than one unclaimed matching run");
        }
        return observed;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, WORKFLOW_DISPATCH_POLL_INTERVAL_MS));
  }
  throw new Error("GitHub Actions dispatch did not reach a completed provider run within the bounded observation window");
}

async function persistActionProviderInvocation(root, runId, action, invocation, {
  journalEvent = "action.provider-invoked",
  expectedProviderInvocation
} = {}) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const target = safeJoin(runDir, "actions", `${action.tokenHash}.json`);
    const current = await readJson(root, target);
    if (current.status !== "spent" || current.outcome !== "pending" || current.attemptId !== action.attemptId) {
      throw new Error("GitHub Actions provider invocation is not bound to the consumed action attempt");
    }
    const expectedInvocation = expectedProviderInvocation === undefined
      ? (action.providerInvocation ?? null)
      : expectedProviderInvocation;
    const currentInvocation = current.providerInvocation ?? null;
    if (digestObject(currentInvocation) !== digestObject(expectedInvocation)) {
      throw new Error("GitHub Actions provider invocation changed during resumable reconciliation");
    }
    const next = { ...current, providerInvocation: invocation };
    await atomicWriteJson(root, target, next);
    await appendJournal(root, runDir, journalEvent, {
      attemptId: action.attemptId,
      invocationId: invocation.id,
      dispatchState: invocation.dispatchState,
      exitCode: invocation.exitCode
    });
    return next;
  }, { ttlMs: 300_000 });
}

export async function resumeActionsDispatchObservation(root, runId, attemptId) {
  const run = await loadRun(root, runId);
  const runDir = runDirectory(root, runId);
  const records = await listJsonRecords(root, safeJoin(runDir, "actions"));
  const action = records.find((item) => item.attemptId === attemptId);
  if (!action || action.action !== "actions.dispatch" || action.provider !== "github-cli") return action ?? null;
  assertMutableRun(run, "Resumable GitHub Actions dispatch reconciliation");
  const invocation = action.providerInvocation;
  if (action.status !== "spent" || action.outcome !== "pending") return action;
  if (invocation?.dispatchState === "preflight") {
    if (typeof invocation.startedAt !== "string" || !Number.isFinite(Date.parse(invocation.startedAt)) ||
        invocation.exitCode !== null) {
      throw new Error("Resumable GitHub Actions dispatch preflight recovery requires a valid pre-call timestamp and null exit code");
    }
    const lease = invocation.executorLease;
    const leaseExpiresAt = Date.parse(lease?.expiresAt ?? "");
    if (!lease || !Number.isInteger(lease.pid) || lease.pid <= 0 || typeof lease.host !== "string" || lease.host.length === 0 ||
        !Number.isFinite(leaseExpiresAt)) {
      throw new Error("Resumable GitHub Actions dispatch preflight recovery requires a valid executor lease");
    }
    if (lease.host !== os.hostname()) {
      throw new Error(`Resumable GitHub Actions dispatch preflight lease expired on host ${lease.host}; refusing cross-host recovery`);
    }
    if (leaseExpiresAt > Date.now() || processAlive(lease.pid)) {
      throw new Error("Resumable GitHub Actions dispatch preflight recovery is blocked while its executor lease is active");
    }
    const recoveredInvocation = workflowDispatchInvocation(runId, action, {
      startedAt: invocation.startedAt,
      exitCode: null,
      dispatchState: "not-sent",
      preexistingRunIds: [],
      errorDigest: sha256("GitHub Actions dispatch provider invocation did not start before process termination")
    });
    return persistActionProviderInvocation(root, runId, action, recoveredInvocation, {
      journalEvent: "action.provider-preflight-recovered",
      expectedProviderInvocation: invocation
    });
  }
  if (action.status !== "spent" || action.outcome !== "pending" ||
      !invocation || invocation.dispatchState !== "sent-or-indeterminate" || invocation.workflowRun) {
    return action;
  }
  const observationStartedAt = invocation.observationStartedAt ?? invocation.dispatchedAt;
  if ((invocation.exitCode !== null && !Number.isInteger(invocation.exitCode)) || typeof observationStartedAt !== "string") {
    throw new Error("Resumable GitHub Actions dispatch reconciliation requires a recorded provider exit code and dispatch timestamp");
  }
  const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
  const providerExecutablePath = await verifyRecordedGitHubProvider(manifest, action);
  const providerExecutable = await currentProviderExecutableIdentity("gh");
  if (providerExecutable.path !== providerExecutablePath ||
      digestObject(providerExecutable) !== digestObject(action.providerExecutable)) {
    throw new Error("Resumable GitHub Actions dispatch reconciliation denied because the governed provider executable changed");
  }
  const providerAuthorization = await verifyGitHubProviderAuthorization(
    manifest.cwd,
    action.providerAuthorization.repository,
    providerExecutablePath
  );
  if (digestObject(providerAuthorization) !== digestObject(action.providerAuthorization)) {
    throw new Error("Resumable GitHub Actions dispatch reconciliation denied because the provider actor or permissions changed");
  }
  const preexistingRunIds = Array.isArray(invocation.preexistingRunIds)
    ? invocation.preexistingRunIds.map(String).filter((value) => /^\d+$/.test(value))
    : [];
  let currentAction = action;
  const persistCandidate = async (observedRunId) => {
    const currentInvocation = currentAction.providerInvocation;
    const candidateInvocation = workflowDispatchInvocation(runId, currentAction, {
      startedAt: currentInvocation.startedAt,
      exitCode: currentInvocation.exitCode,
      dispatchState: "sent-or-indeterminate",
      preexistingRunIds,
      dispatchedAt: currentInvocation.dispatchedAt,
      observationStartedAt,
      observedRunId
    });
    currentAction = await persistActionProviderInvocation(root, runId, currentAction, candidateInvocation, {
      expectedProviderInvocation: currentInvocation
    });
  };
  const workflowRun = await observeDispatchedWorkflow(
    manifest.cwd,
    currentAction,
    providerExecutablePath,
    preexistingRunIds,
    observationStartedAt,
    { persistCandidate }
  );
  const currentInvocation = currentAction.providerInvocation;
  const promotedInvocation = workflowDispatchInvocation(runId, currentAction, {
    startedAt: currentInvocation.startedAt,
    exitCode: currentInvocation.exitCode,
    dispatchState: "sent",
    preexistingRunIds,
    dispatchedAt: currentInvocation.dispatchedAt,
    observationStartedAt,
    observedRunId: currentInvocation.observedRunId,
    workflowRun
  });
  return persistActionProviderInvocation(root, runId, currentAction, promotedInvocation, {
    journalEvent: "action.provider-reconciled",
    expectedProviderInvocation: currentInvocation
  });
}

function workflowDispatchInvocation(runId, action, invocation) {
  return {
    schemaVersion: 1,
    id: `github-actions-dispatch-wrapper:${runId}:${action.attemptId}`,
    actionAttemptId: action.attemptId,
    provider: "github-cli",
    command: action.dispatchCommand,
    providerExecutable: action.providerExecutable,
    providerAuthorizationExecutable: action.providerAuthorizationExecutable,
    providerAuthorization: action.providerAuthorization,
    startedAt: invocation.startedAt,
    finishedAt: nowIso(),
    exitCode: invocation.exitCode,
    dispatchState: invocation.dispatchState,
    preexistingRunIds: invocation.preexistingRunIds,
    ...(invocation.executorLease ? { executorLease: invocation.executorLease } : {}),
    ...(invocation.dispatchedAt ? { dispatchedAt: invocation.dispatchedAt } : {}),
    ...(invocation.observationStartedAt ? { observationStartedAt: invocation.observationStartedAt } : {}),
    ...(invocation.observedRunId ? { observedRunId: String(invocation.observedRunId) } : {}),
    ...(invocation.workflowRun ? { workflowRun: invocation.workflowRun } : {}),
    ...(invocation.errorDigest ? { errorDigest: invocation.errorDigest } : {})
  };
}

function workflowDispatchPreInvocation(runId, action, startedAt) {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) throw new Error("GitHub Actions dispatch preflight timestamp is invalid");
  return workflowDispatchInvocation(runId, action, {
    startedAt,
    exitCode: null,
    dispatchState: "preflight",
    preexistingRunIds: [],
    executorLease: {
      pid: process.pid,
      host: os.hostname(),
      expiresAt: new Date(startedAtMs + WORKFLOW_DISPATCH_PREFLIGHT_LEASE_MS).toISOString()
    }
  });
}

async function persistPreflightProviderInvocation(root, runId, action, error) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const target = safeJoin(runDir, "actions", `${action.tokenHash}.json`);
    const current = await readJson(root, target);
    if (
      current.status !== "spent" ||
      current.attemptId !== action.attemptId ||
      current.providerInvocation
    ) return current;
    const invocation = githubPreflightInvocation(runId, action, error);
    const next = { ...current, providerInvocation: invocation };
    await atomicWriteJson(root, target, next);
    await appendJournal(root, runDir, "action.provider-preflight-failed", {
      attemptId: action.attemptId,
      invocationId: invocation.id,
      dispatchState: invocation.dispatchState
    });
    return next;
  });
}

export async function executeActionToken(root, runId, token, currentTreeDigest) {
  const actionRecord = await readJson(root, safeJoin(runDirectory(root, runId), "actions", `${sha256(token)}.json`));
  assertSupportedGovernedAction(actionRecord.action);
  const contract = await readJson(root, safeJoin(runDirectory(root, runId), "contract.json"));
  assertActionIsNotDeferred(contract, actionRecord.action);
  if (!isExecutableActionProvider(actionRecord.action, actionRecord.provider)) {
    throw new Error("The governed provider execution path only supports fixed GitHub/Git provider adapters");
  }
  let consumed = await consumeActionTokenInternal(root, runId, token, currentTreeDigest, true);
  if (contract.autonomyProfile) {
    const run = await loadRun(root, runId);
    if (run.state.autonomy?.status !== "ready" || run.state.lastSentinelVerified !== true || run.state.lastSentinelComplete !== true) {
      throw new Error("Action execution denied because bounded autopilot readiness is no longer verified");
    }
    const snapshot = await currentAutonomySnapshot(run.manifest, run.contract, run.state);
    assertAutonomySnapshotIdentity(snapshot, run.state.autonomy.snapshot, "Action execution");
    assertAutonomySnapshotIdentity(snapshot, consumed.autonomySnapshot, "Action execution token");
  }
  if (consumed.action === "actions.dispatch" && consumed.provider === "github-cli") {
    const manifest = await readJson(root, safeJoin(runDirectory(root, runId), "manifest.json"));
    const startedAt = nowIso();
    let expectedCommand;
    let providerExecutablePath;
    let existingRunIds = [];
    try {
      expectedCommand = buildActionsDispatchCommand(consumed);
      if (JSON.stringify(consumed.dispatchCommand) !== JSON.stringify(expectedCommand)) {
        throw new Error("GitHub Actions dispatch execution command is not the fixed workflow binding");
      }
      providerExecutablePath = await verifyRecordedGitHubProvider(manifest, consumed);
      const providerExecutable = await currentProviderExecutableIdentity("gh");
      if (providerExecutable.path !== providerExecutablePath ||
          digestObject(providerExecutable) !== digestObject(consumed.providerExecutable)) {
        throw new Error("GitHub Actions dispatch execution denied because the governed provider executable changed");
      }
      const providerAuthorization = await verifyGitHubProviderAuthorization(
        manifest.cwd,
        consumed.providerAuthorization.repository,
        providerExecutablePath
      );
      if (digestObject(providerAuthorization) !== digestObject(consumed.providerAuthorization)) {
        throw new Error("GitHub Actions dispatch execution denied because the provider actor or permissions changed");
      }
      const existingRuns = await listWorkflowRuns(manifest.cwd, consumed, providerExecutablePath, {
        createdFilter: `>=${new Date(workflowDispatchMinimumCreatedAt(startedAt)).toISOString()}`,
        createdAtUpperBoundMs: Date.parse(startedAt)
      });
      existingRunIds = existingRuns
        .map((run) => String(run?.databaseId ?? ""))
        .filter((runIdValue) => /^\d+$/.test(runIdValue));
      const resolvedDispatchRef = await resolveBoundGitHubDispatchRef(
        manifest.cwd,
        consumed.dispatchRepository,
        consumed.dispatchRef,
        providerExecutablePath
      );
      if (resolvedDispatchRef.ref !== consumed.dispatchRef || resolvedDispatchRef.revision !== consumed.remoteRevision) {
        throw new Error("GitHub Actions dispatch ref changed before provider invocation");
      }
    } catch (error) {
      const preflight = workflowDispatchInvocation(runId, consumed, {
        startedAt,
        exitCode: null,
        dispatchState: "not-sent",
        preexistingRunIds: existingRunIds,
        errorDigest: sha256(error?.message ?? "workflow dispatch preflight failed")
      });
      consumed = await persistActionProviderInvocation(root, runId, consumed, preflight);
      throw error;
    }
    // Re-check the ref immediately before recording the crash-observation
    // boundary. A drift here proves that the provider command was not sent,
    // so the attempt remains explicitly not-sent and may be reconciled as a
    // terminal preflight failure rather than stranded as indeterminate.
    const dispatchObservationStartedAt = nowIso();
    try {
      const resolvedDispatchRef = await resolveBoundGitHubDispatchRef(
        manifest.cwd,
        consumed.dispatchRepository,
        consumed.dispatchRef,
        providerExecutablePath
      );
      if (resolvedDispatchRef.ref !== consumed.dispatchRef || resolvedDispatchRef.revision !== consumed.remoteRevision) {
        throw new Error("GitHub Actions dispatch ref changed immediately before provider invocation");
      }
    } catch (error) {
      const preflight = workflowDispatchInvocation(runId, consumed, {
        startedAt,
        exitCode: null,
        dispatchState: "not-sent",
        preexistingRunIds: existingRunIds,
        errorDigest: sha256(error?.message ?? "workflow dispatch final preflight failed")
      });
      consumed = await persistActionProviderInvocation(root, runId, consumed, preflight);
      throw error;
    }
    // Persist the observation lower bound before the provider call. A crash
    // after the call but before its result is durable must still be resumable.
    consumed = await persistActionProviderInvocation(root, runId, consumed, workflowDispatchInvocation(runId, consumed, {
      startedAt,
      exitCode: null,
      // Once the token is consumed, a crash can occur immediately before or
      // after the provider call. Keep the attempt indeterminate until the
      // provider run is observed; never release it as a not-sent failure.
      dispatchState: "sent-or-indeterminate",
      preexistingRunIds: existingRunIds,
      observationStartedAt: dispatchObservationStartedAt
    }));
    let exitCode = 0;
    try {
      await execBoundGitHubCli(providerExecutablePath, expectedCommand.slice(1), { cwd: manifest.cwd });
    } catch (error) {
      exitCode = Number.isInteger(error?.code) ? error.code : 1;
      const failedInvocation = workflowDispatchInvocation(runId, consumed, {
        startedAt,
        exitCode,
        dispatchState: "sent-or-indeterminate",
        preexistingRunIds: existingRunIds,
        dispatchedAt: nowIso(),
        observationStartedAt: dispatchObservationStartedAt,
        errorDigest: sha256(error?.message ?? "workflow dispatch failed")
      });
      consumed = await persistActionProviderInvocation(root, runId, consumed, failedInvocation);
      throw Object.assign(
        new Error("GitHub Actions dispatch invocation failed; provider state is indeterminate and automatic retry is prohibited", {
          cause: error
        }),
        {
          code: "SBW_ACTIONS_DISPATCH_INDETERMINATE",
          providerInvocation: failedInvocation
        }
      );
    }
    const dispatchedAt = nowIso();
    consumed = await persistActionProviderInvocation(root, runId, consumed, workflowDispatchInvocation(runId, consumed, {
      startedAt,
      exitCode,
      dispatchState: "sent-or-indeterminate",
      preexistingRunIds: existingRunIds,
      dispatchedAt,
      observationStartedAt: dispatchObservationStartedAt
    }));
    try {
      const persistCandidate = async (observedRunId) => {
        const currentInvocation = consumed.providerInvocation;
        const candidateInvocation = workflowDispatchInvocation(runId, consumed, {
          startedAt,
          exitCode,
          dispatchState: "sent-or-indeterminate",
          preexistingRunIds: existingRunIds,
          dispatchedAt,
          observationStartedAt: dispatchObservationStartedAt,
          observedRunId
        });
        consumed = await persistActionProviderInvocation(root, runId, consumed, candidateInvocation, {
          expectedProviderInvocation: currentInvocation
        });
      };
      const workflowRun = await observeDispatchedWorkflow(
        manifest.cwd,
        consumed,
        providerExecutablePath,
        existingRunIds,
        dispatchObservationStartedAt,
        { persistCandidate }
      );
      const completedInvocation = workflowDispatchInvocation(runId, consumed, {
        startedAt,
        exitCode,
        dispatchState: "sent",
        preexistingRunIds: existingRunIds,
        dispatchedAt,
        observationStartedAt: dispatchObservationStartedAt,
        observedRunId: consumed.providerInvocation?.observedRunId,
        workflowRun
      });
      consumed = await persistActionProviderInvocation(root, runId, consumed, completedInvocation);
      return consumed;
    } catch (error) {
      const indeterminateInvocation = workflowDispatchInvocation(runId, consumed, {
        startedAt,
        exitCode,
        dispatchState: "sent-or-indeterminate",
        preexistingRunIds: existingRunIds,
        dispatchedAt,
        observationStartedAt: dispatchObservationStartedAt,
        observedRunId: consumed.providerInvocation?.observedRunId,
        errorDigest: sha256(error?.message ?? "workflow run observation failed")
      });
      consumed = await persistActionProviderInvocation(root, runId, consumed, indeterminateInvocation);
      throw error;
    }
  }
  if (consumed.action === "git.push" && consumed.provider === "git") {
    const { remote, pushUrl, ref, command: expectedCommand } = resolveGitPushExecutionBinding(consumed);
    const manifest = await readJson(root, safeJoin(runDirectory(root, runId), "manifest.json"));
    const currentSourceBinding = await assertCurrentGitPushSourceBinding(manifest, consumed.sourceBindingDigest);
    if (currentSourceBinding.originIdentity.digest !== consumed.sourceRemoteBindingDigest) {
      throw new Error("Git push execution denied because the raw source remote binding changed");
    }
    const executable = await currentProviderExecutableIdentity(BOUND_GIT_EXECUTABLE);
    if (digestObject(executable) !== digestObject(consumed.providerExecutable)) {
      throw new Error("Git push execution denied because the governed provider executable changed");
    }
    const githubExecutable = await verifyRecordedGitHubExecutable(consumed, "providerAuthorizationExecutable");
    const verifiedCredential = await verifyGitPushCredential(
      manifest.cwd,
      {
        remote,
        pushUrl,
        pushUrlDigest: consumed.pushUrlDigest,
        ref,
        revision: consumed.expectedRevision,
        repository: consumed.remoteRepository,
        sourceRemoteBindingDigest: consumed.sourceRemoteBindingDigest
      },
      consumed.providerAuthorization?.actor ?? null,
      {
        includeCredential: true,
        githubExecutablePath: githubExecutable.path,
        gitExecutablePath: executable.path
      }
    );
    const credentialCheck = verifiedCredential.binding;
    if (digestObject(credentialCheck) !== digestObject(consumed.gitCredentialCheck)) {
      throw new Error("Git push execution denied because the credential actor changed");
    }
    const currentRevision = (await execBoundGitAuthority(manifest.cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
    if (currentRevision !== consumed.expectedRevision) {
      throw new Error("Git push execution denied because the candidate revision changed");
    }
    return withRunLock(root, runId, async ({ runDir }) => {
      const run = await loadRun(root, runId);
      assertMutableRun(run, "Action provider execution");
      const target = safeJoin(runDir, "actions", `${consumed.tokenHash}.json`);
      const current = await readJson(root, target);
      if (current.status !== "spent" || current.attemptId !== consumed.attemptId) {
        throw new Error("Git push provider invocation is not bound to the consumed action attempt");
      }
      const startedAt = nowIso();
      let exitCode = 0;
      try {
        await withBoundGitCredential(run.manifest.cwd, consumed.pushUrl, verifiedCredential.credential, executable.path, (context) =>
          execBoundGit(executable.path, buildBoundGitPushArgs(expectedCommand, context.credentialFile, executable.path), {
            cwd: run.manifest.cwd,
            env: buildBoundGitPushEnvironment(context),
            timeoutMs: BOUND_GIT_TIMEOUT_MS,
            maxBuffer: BOUND_GIT_MAX_BUFFER
          })
        );
      } catch (error) {
        exitCode = Number.isInteger(error?.code) ? error.code : 1;
      }
      const invocation = {
        schemaVersion: 1,
        id: `git-push-wrapper:${runId}:${consumed.attemptId}`,
        actionAttemptId: consumed.attemptId,
        provider: "git",
        command: expectedCommand,
        providerExecutable: executable,
        providerAuthorizationExecutable: consumed.providerAuthorizationExecutable,
        providerAuthorization: consumed.providerAuthorization,
        credentialActor: credentialCheck.actor,
        startedAt,
        finishedAt: nowIso(),
        exitCode,
        dispatchState: exitCode === 0 ? "sent" : "sent-or-indeterminate"
      };
      const next = { ...current, providerInvocation: invocation };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "action.provider-invoked", {
        attemptId: consumed.attemptId,
        invocationId: invocation.id,
        exitCode
      });
      return next;
    }, { ttlMs: 300_000 });
  }
  if (consumed.action === "pr.create" && consumed.provider === "github-cli") {
    const manifest = await readJson(root, safeJoin(runDirectory(root, runId), "manifest.json"));
    const expectedCommand = buildPrCreateCommand(consumed);
    let executable;
    let providerAuthorization;
    try {
      executable = await verifyRecordedGitHubExecutable(consumed);
      providerAuthorization = await verifyCreateProviderAtInvocation(consumed, manifest);
    } catch (error) {
      await persistPreflightProviderInvocation(root, runId, consumed, error);
      throw error;
    }
    return withRunLock(root, runId, async ({ runDir }) => {
      const run = await loadRun(root, runId);
      assertMutableRun(run, "Action provider execution");
      const target = safeJoin(runDir, "actions", `${consumed.tokenHash}.json`);
      const current = await readJson(root, target);
      if (current.status !== "spent" || current.attemptId !== consumed.attemptId) {
        throw new Error("PR creation provider invocation is not bound to the consumed action attempt");
      }
      const startedAt = nowIso();
      let exitCode = 0;
      try {
        await execBoundGitHubCli(executable.path, expectedCommand.slice(1), {
          cwd: run.manifest.cwd,
        });
      } catch (error) {
        exitCode = Number.isInteger(error?.code) ? error.code : 1;
      }
      const invocation = {
        schemaVersion: 1,
        id: `github-pr-create-wrapper:${runId}:${consumed.attemptId}`,
        actionAttemptId: consumed.attemptId,
        provider: "github-cli",
        command: expectedCommand,
        providerExecutable: executable,
        providerAuthorizationExecutable: consumed.providerAuthorizationExecutable,
        providerAuthorization,
        startedAt,
        finishedAt: nowIso(),
        exitCode,
        dispatchState: exitCode === 0 ? "sent" : "sent-or-indeterminate"
      };
      const next = { ...current, providerInvocation: invocation };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "action.provider-invoked", {
        attemptId: consumed.attemptId,
        invocationId: invocation.id,
        exitCode
      });
      return next;
    }, { ttlMs: 300_000 });
  }
  if (consumed.action !== "pr.merge" || consumed.provider !== "github-cli") {
    throw new Error("The governed provider execution path only supports github-cli pr.create/pr.merge and git.push");
  }
  const expectedCommand = [
    "gh",
    "pr",
    "merge",
    String(consumed.pullRequest),
    "--repo",
    consumed.mergeRepository,
    "--match-head-commit",
    consumed.reviewedHead,
    "--merge",
    "--delete-branch=false"
  ];
  if (!consumed.mergeRepository || JSON.stringify(consumed.mergeCommand) !== JSON.stringify(expectedCommand)) {
    throw new Error("PR merge execution command is not the fixed non-admin invocation");
  }
  const executable = await currentProviderExecutableIdentity("gh");
  if (digestObject(executable) !== digestObject(consumed.providerExecutable)) {
    throw new Error("PR merge execution denied because the governed provider executable changed");
  }
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Action provider execution");
    const target = safeJoin(runDir, "actions", `${consumed.tokenHash}.json`);
    const current = await readJson(root, target);
    if (current.status !== "spent" || current.attemptId !== consumed.attemptId) {
      throw new Error("PR merge provider invocation is not bound to the consumed action attempt");
    }
    // Keep the canonical evidence replay, provider/PR checks, and provider
    // invocation inside one run lock. No local state writer can introduce an
    // invalid supersession after the final replay but before `gh pr merge`.
    let providerAuthorization;
    try {
      providerAuthorization = await verifyMergeProviderAtInvocation(root, runId, current, run.manifest);
      // Provider observations may take time. Replay every local immutable gate
      // once more at the last instruction boundary while the run lock is still
      // held, so neither late review state nor a malformed supersession can be
      // introduced between preflight and the provider call.
      await listEffectiveEvidenceRecords(root, runId, { run: await loadRun(root, runId) });
      if (current.reviewPackageId) {
        const { assertReviewContinuity } = await import("./review.mjs");
        await assertReviewContinuity(root, runId, {
          packageId: current.reviewPackageId,
          head: current.reviewedHead,
          continuityDigest: current.reviewContinuityDigest
        });
      }
    } catch (error) {
      if (!current.providerInvocation) {
        const invocation = githubPreflightInvocation(runId, consumed, error);
        const next = { ...current, providerInvocation: invocation };
        await atomicWriteJson(root, target, next);
        await appendJournal(root, runDir, "action.provider-preflight-failed", {
          attemptId: consumed.attemptId,
          invocationId: invocation.id,
          dispatchState: invocation.dispatchState
        });
      }
      throw error;
    }
    const startedAt = nowIso();
    let exitCode = 0;
    try {
      await execBoundGitHubCli(executable.path, expectedCommand.slice(1), { cwd: run.manifest.cwd });
    } catch (error) {
      exitCode = Number.isInteger(error?.code) ? error.code : 1;
    }
    const invocation = {
      schemaVersion: 1,
      id: `github-pr-merge-wrapper:${runId}:${consumed.attemptId}`,
      actionAttemptId: consumed.attemptId,
      provider: "github-cli",
      command: expectedCommand,
      adminBypass: false,
      providerExecutable: executable,
      providerAuthorizationExecutable: consumed.providerAuthorizationExecutable,
      providerAuthorization,
      startedAt,
      finishedAt: nowIso(),
      exitCode,
      dispatchState: exitCode === 0 ? "sent" : "sent-or-indeterminate"
    };
    const next = { ...current, providerInvocation: invocation };
    await atomicWriteJson(root, target, next);
    await appendJournal(root, runDir, "action.provider-invoked", {
      attemptId: consumed.attemptId,
      invocationId: invocation.id,
      exitCode
    });
    return next;
  }, { ttlMs: 300_000 });
}

function validateActionReceipt(record, outcome, receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("Action reconciliation requires a structured provider receipt");
  }
  const bindingFields = ["runId", "attemptId", "idempotencyKey", "remoteRevision"];
  const receiptBindingValid = bindingFields.every((field) => receipt[field] === record[field]);
  if (
    receipt.action !== record.action ||
    receipt.provider !== record.provider ||
    receipt.resource !== record.resource ||
    receipt.outcome !== outcome ||
    !receiptBindingValid ||
    !receipt.providerReceipt ||
    typeof receipt.providerReceipt !== "object" ||
    Array.isArray(receipt.providerReceipt) ||
    receipt.providerReceipt.action !== record.action ||
    receipt.providerReceipt.resource !== record.resource ||
    receipt.providerReceipt.outcome !== outcome ||
    receipt.providerReceipt.provider !== record.provider ||
    !bindingFields
      .filter((field) => !(record.action === "actions.dispatch" && field === "runId"))
      .every((field) => receipt.providerReceipt[field] === record[field]) ||
    typeof receipt.providerReceipt.executionId !== "string" ||
    !receipt.providerReceipt.executionId
  ) {
    throw new Error("Action reconciliation receipt is not bound to the action attempt");
  }
  assertProviderReceiptShape(record, receipt.providerReceipt, outcome);
}

async function validateActionEvidenceBinding(root, runDir, record, attemptId, outcome, receipt) {
  if (outcome !== "success") return;
  if (!Array.isArray(receipt.evidenceIds) || receipt.evidenceIds.length === 0) {
    throw new Error("Successful action reconciliation requires action-bound evidence IDs");
  }
  if (new Set(receipt.evidenceIds).size !== receipt.evidenceIds.length) {
    throw new Error("Action-bound evidence IDs must be unique");
  }
  const evidence = await listJsonRecords(root, safeJoin(runDir, "evidence"));
  for (const evidenceId of receipt.evidenceIds) {
    const item = evidence.find((candidate) => candidate.id === evidenceId);
    const payload = item?.receipt?.payload;
    const proof = payload?.actionProof;
    if (
      !item ||
      item.status !== "complete" ||
      item.stale === true ||
      !payload ||
      !proof ||
      proof.schemaVersion !== 1 ||
      proof.runId !== record.runId ||
      proof.actionAttemptId !== attemptId ||
      proof.action !== record.action ||
      proof.provider !== record.provider ||
      proof.resource !== record.resource ||
      proof.outcome !== "success" ||
      proof.idempotencyKey !== record.idempotencyKey ||
      proof.remoteRevision !== record.remoteRevision ||
      proof.providerExecutionId !== receipt.providerReceipt.executionId ||
      proof.providerReceiptDigest !== digestObject(receipt.providerReceipt) ||
      !payload.receipt ||
      digestObject(payload.receipt) !== digestObject(receipt.providerReceipt)
    ) {
      throw new Error("Action-bound evidence does not prove the reconciled side effect");
    }
  }
}

async function finalizePluginCacheReadiness(runId, attemptId, providerReceipt) {
  const { markPluginCacheReady, verifyPluginCacheReady } = await import("./publication.mjs");
  const providerReceiptDigest = digestObject(providerReceipt);
  const binding = {
    cacheRoot: providerReceipt.cacheRoot,
    version: providerReceipt.version,
    target: providerReceipt.target,
    targetDigest: providerReceipt.targetDigest,
    sourceDigest: providerReceipt.sourceDigest,
    sourceBaselineRevision: providerReceipt.sourceBaselineRevision,
    sourceHeadRevision: providerReceipt.sourceHeadRevision,
    sourceBindingDigest: providerReceipt.sourceBindingDigest,
    pluginBundleDigest: providerReceipt.pluginBundleDigest,
    runId,
    attemptId,
    providerReceiptDigest
  };
  await markPluginCacheReady(binding);
  return verifyPluginCacheReady(binding);
}

async function transitionAutonomousCommitSourceBinding(root, runDir, contract, record, onBoundary = () => {}) {
  const manifestPath = safeJoin(runDir, "manifest.json");
  const statePath = safeJoin(runDir, "state.json");
  const manifest = await readJson(root, manifestPath);
  const state = await readJson(root, statePath);
  const current = await verifyAutonomousCommitTransition(manifest, contract, record);
  const priorDigest = record.preCommitSourceBinding.digest;
  const history = Array.isArray(manifest.sourceBindingHistory) ? manifest.sourceBindingHistory : [];
  const existing = history.find((item) => (
    item.kind === "autonomous-commit" && item.actionAttemptId === record.attemptId
  ));
  if (existing && (
    existing.from !== priorDigest || existing.to !== current.digest ||
    existing.previousHeadRevision !== record.preCommitHeadRevision ||
    existing.headRevision !== current.headRevision
  )) {
    throw new Error("Autonomous Git commit source transition history is rebound to another commit");
  }
  if (manifest.sourceBinding.digest === current.digest && !existing) {
    throw new Error("Autonomous Git commit source transition lacks its immutable history record");
  }
  if (![priorDigest, current.digest].includes(manifest.sourceBinding.digest)) {
    throw new Error("Autonomous Git commit cannot replace an unrelated operational source binding");
  }
  const transitionedAt = existing?.at ?? nowIso();
  let manifestChanged = false;
  if (manifest.sourceBinding.digest === priorDigest) {
    const sourceHeadRevision = manifest.autonomyProfile?.sourceHeadRevision;
    if (!SHA.test(sourceHeadRevision ?? "")) {
      throw new Error("Autonomous Git commit source transition lacks the immutable source-head anchor");
    }
    const nextManifest = {
      ...manifest,
      sourceBinding: current,
      autonomyProfile: {
        ...manifest.autonomyProfile,
        sourceBindingDigest: current.digest,
        sourceHeadRevision
      },
      sourceBindingHistory: [
        ...history,
        {
          kind: "autonomous-commit",
          actionAttemptId: record.attemptId,
          from: priorDigest,
          to: current.digest,
          previousHeadRevision: record.preCommitHeadRevision,
          headRevision: current.headRevision,
          reason: "governed-autonomous-commit-reconciled",
          at: transitionedAt
        }
      ],
      updatedAt: transitionedAt
    };
    await atomicWriteJson(root, manifestPath, nextManifest);
    await onBoundary("source-manifest");
    manifestChanged = true;
  }
  const stateTransition = state.autonomousCommitTransition;
  const stateReadyForFreshPreflight = (
    state.status === "blocked" &&
    state.lastSentinel === null &&
    state.lastSentinelVerified === false &&
    state.lastSentinelComplete === false &&
    state.autonomy?.status === "blocked" &&
    state.autonomy?.snapshot === null &&
    state.autonomy?.blockedReason === "autonomous-commit-reconciled" &&
    stateTransition?.actionAttemptId === record.attemptId &&
    stateTransition?.sourceBindingDigest === current.digest
  );
  if (!stateReadyForFreshPreflight) {
    await atomicWriteJson(root, statePath, {
      ...state,
      status: "blocked",
      lastSentinel: null,
      lastSentinelVerified: false,
      lastSentinelComplete: false,
      autonomy: {
        ...state.autonomy,
        status: "blocked",
        snapshot: null,
        blockedReason: "autonomous-commit-reconciled",
        requiredAuthority: "autonomy.preflight",
        resumeFromStage: "preflight"
      },
      autonomousCommitTransition: {
        actionAttemptId: record.attemptId,
        previousHeadRevision: record.preCommitHeadRevision,
        headRevision: current.headRevision,
        sourceBindingDigest: current.digest,
        at: transitionedAt
      },
      updatedAt: transitionedAt
    });
    await onBoundary("source-state");
  }
  await appendJournalOnceForAttempt(root, runDir, "source-binding.autonomous-commit", record.attemptId, {
    actionAttemptId: record.attemptId,
    from: priorDigest,
    to: current.digest,
    previousHeadRevision: record.preCommitHeadRevision,
    headRevision: current.headRevision
  });
  return {
    sourceBinding: current,
    transitionedAt,
    repaired: !manifestChanged
  };
}

async function invalidateEvidenceAfterAutonomousCommit(root, runDir, record, transitionedAt, onBoundary = () => {}) {
  const run = {
    runDir,
    manifest: await readJson(root, safeJoin(runDir, "manifest.json")),
    contract: await readJson(root, safeJoin(runDir, "contract.json")),
    state: await readJson(root, safeJoin(runDir, "state.json"))
  };
  await assertAutonomousCommitEvidenceInvalidationSafe(root, run.manifest.runId, { run });
  const evidence = await listJsonRecords(root, safeJoin(runDir, "evidence"));
  let transitionBoundaryArmed = true;
  for (const item of evidence) {
    if (item.status !== "complete") continue;
    if (item.stale === true) {
      if (item.staleReason === `autonomous-commit-reconciled:${record.attemptId}`) {
        transitionBoundaryArmed = false;
      }
      continue;
    }
    const next = {
      ...item,
      stale: true,
      freshnessCheckedAt: transitionedAt,
      staleReason: `autonomous-commit-reconciled:${record.attemptId}`
    };
    await writeEvidenceFreshnessTransition(
      root,
      runDir,
      item,
      next,
      {
        kind: "autonomous-commit-reconciled",
        actionAttemptId: record.attemptId
      },
      {
        onPrepared: transitionBoundaryArmed
          ? () => onBoundary("evidence-transition-journal")
          : null
      }
    );
    transitionBoundaryArmed = false;
    await onBoundary("evidence-invalidation");
  }
  const parent = await appendEvidenceInvalidationParent(root, runDir, record.attemptId);
  return parent?.invalidated ?? 0;
}

const AUTONOMOUS_COMMIT_RECONCILE_FAILURE_POINTS = new Set([
  "provider-reservation",
  "source-manifest",
  "source-state",
  "action-persistence",
  "evidence-transition-journal",
  "evidence-invalidation"
]);

export async function reconcileAction(root, runId, attemptId, outcome, receipt = null, {
  failAfter = null
} = {}) {
  if (!["success", "failure", "unknown"].includes(outcome)) {
    throw new Error("Action outcome must be success, failure, or unknown");
  }
  if (failAfter !== null && !AUTONOMOUS_COMMIT_RECONCILE_FAILURE_POINTS.has(failAfter)) {
    throw new Error("Autonomous Git commit reconciliation failure point is invalid");
  }
  const onBoundary = async (point) => {
    if (failAfter === point) {
      throw new Error(`Injected autonomous Git commit reconciliation failure after ${point}`);
    }
  };
  await resumeActionsDispatchObservation(root, runId, attemptId);
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Action reconciliation");
    const records = await listJsonRecords(root, safeJoin(runDir, "actions"));
    const record = records.find((item) => item.attemptId === attemptId);
    if (!record) throw new Error(`Unknown action attempt: ${attemptId}`);
    assertActionIsNotDeferred(run.contract, record.action);
    if (failAfter !== null && !(
      record.action === "git.commit" &&
      record.provider === "git" &&
      record.autonomyDecision?.decision === "auto-approved"
    )) {
      throw new Error("Reconciliation failure injection is restricted to autonomous Git commits");
    }
    if (OWNED_RESOURCE_CREATION_ACTIONS.has(record.action)) {
      validateCreationReservationIdentity(record.creationReservation);
    }
    const repairingPluginCacheReadiness = (
      record.status === "spent" &&
      record.outcome === "success" &&
      outcome === "success" &&
      record.action === "plugin.cache.publish" &&
      record.provider === "local-workspace"
    );
    if (repairingPluginCacheReadiness) {
      if (!record.receipt || !receipt || digestObject(record.receipt) !== digestObject(receipt)) {
        throw new Error("Plugin cache readiness repair requires the exact persisted success receipt");
      }
      validateActionReceipt(record, outcome, receipt);
      await validateActionEvidenceBinding(root, runDir, record, attemptId, outcome, receipt);
      const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
      await verifyProviderReceipt(manifest, { ...record, outcome: "success" }, receipt, run.contract);
      await finalizePluginCacheReadiness(runId, attemptId, receipt.providerReceipt);
      const repaired = {
        ...record,
        cacheReadyRepairedAt: nowIso(),
        cacheReadyRepairReceiptDigest: digestObject(receipt.providerReceipt)
      };
      await atomicWriteJson(root, safeJoin(runDir, "actions", `${record.tokenHash}.json`), repaired);
      await appendJournal(root, runDir, "action.cache-ready-repaired", {
        attemptId,
        providerReceiptDigest: digestObject(receipt.providerReceipt)
      });
      return repaired;
    }
    const repairingAutonomousCommitTransition = (
      record.status === "spent" &&
      record.outcome === "success" &&
      outcome === "success" &&
      record.action === "git.commit" &&
      record.provider === "git" &&
      record.autonomyDecision?.decision === "auto-approved"
    );
    if (repairingAutonomousCommitTransition) {
      if (!record.receipt || !receipt || digestObject(record.receipt) !== digestObject(receipt)) {
        throw new Error("Autonomous Git commit transition repair requires the exact persisted success receipt");
      }
      validateActionReceipt(record, outcome, receipt);
      const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
      await verifyProviderReceipt(manifest, { ...record, outcome: "success" }, receipt, run.contract);
      await assertAutonomousCommitEvidenceInvalidationSafe(root, runId, { run });
      const transition = await transitionAutonomousCommitSourceBinding(root, runDir, run.contract, record, onBoundary);
      await invalidateEvidenceAfterAutonomousCommit(root, runDir, record, transition.transitionedAt, onBoundary);
      await appendJournalOnceForAttempt(root, runDir, "action.autonomous-commit-transition-repaired", attemptId, {
        sourceBindingDigest: transition.sourceBinding.digest
      });
      return record;
    }
    const recoveringUnknownSuccess = (
      record.status === "spent" &&
      record.outcome === "unknown" &&
      outcome === "success" &&
      OWNED_RESOURCE_CREATION_ACTIONS.has(record.action)
    );
    const recoveringUnknownFailure = (
      record.status === "spent" &&
      record.outcome === "unknown" &&
      outcome === "failure" &&
      record.action === "pr.create" &&
      record.provider === "github-cli"
    );
    const recoveringUnknown = recoveringUnknownSuccess || recoveringUnknownFailure;
    if (record.status !== "spent" || (record.outcome !== "pending" && !recoveringUnknown)) {
      throw new Error("Action attempt was already reconciled");
    }
    if (
      record.action === "pr.create" &&
      outcome === "failure" &&
      record.providerInvocation?.dispatchState !== "not-sent" &&
      !recoveringUnknownFailure
    ) {
      throw new Error("PR creation failure is not authoritative; preserve the reservation and reconcile as unknown or prove provider absence");
    }
    if (
      outcome === "failure" &&
      EXECUTABLE_ACTION_PROVIDERS.has(`${record.action}:${record.provider}`) &&
      record.providerInvocation?.dispatchState === "sent-or-indeterminate" &&
      !recoveringUnknownFailure
    ) {
      throw new Error("Indeterminate wrapper execution cannot be reconciled as failure; preserve the attempt and reconcile as unknown");
    }
    validateActionReceipt(record, outcome, receipt);
    if (outcome === "failure" && OWNED_RESOURCE_CREATION_ACTIONS.has(record.action)) {
      const failureAbsence = await verifyFailedCreationAbsence(run.manifest, record);
      receipt = {
        ...receipt,
        providerReceipt: {
          ...receipt.providerReceipt,
          failureAbsence
        }
      };
    }
    if (
      record.action === "pr.merge" &&
      outcome === "success" &&
      (!record.providerInvocation ||
        record.providerInvocation.provider !== "github-cli" ||
        record.providerInvocation.adminBypass !== false ||
        record.providerInvocation.exitCode !== 0 ||
        record.providerInvocation.dispatchState === "not-sent" ||
        digestObject(record.providerInvocation.providerExecutable) !== digestObject(record.providerExecutable) ||
        digestObject(record.providerInvocation.providerAuthorizationExecutable) !== digestObject(record.providerAuthorizationExecutable) ||
        JSON.stringify(record.providerInvocation.command) !== JSON.stringify(record.mergeCommand) ||
        receipt.providerReceipt.invocationId !== record.providerInvocation.id)
    ) {
      throw new Error("Successful PR merge reconciliation requires the governed non-admin provider wrapper");
    }
    if (
      record.action === "pr.create" &&
      outcome === "success" &&
      (!record.providerInvocation ||
        record.providerInvocation.provider !== "github-cli" ||
        (record.outcome !== "unknown" && record.providerInvocation.exitCode !== 0) ||
        record.providerInvocation.dispatchState === "not-sent" ||
        digestObject(record.providerInvocation.providerExecutable) !== digestObject(record.providerExecutable) ||
        digestObject(record.providerInvocation.providerAuthorizationExecutable) !== digestObject(record.providerAuthorizationExecutable) ||
        digestObject(record.providerInvocation.providerAuthorization) !== digestObject(record.providerAuthorization) ||
        JSON.stringify(record.providerInvocation.command) !== JSON.stringify(buildPrCreateCommand(record)))
    ) {
      throw new Error("Successful PR creation reconciliation requires the governed provider wrapper");
    }
    if (
      record.action === "git.push" &&
      outcome === "success" &&
      (!record.providerInvocation ||
        record.providerInvocation.provider !== "git" ||
        record.providerInvocation.exitCode !== 0 ||
        digestObject(record.providerInvocation.providerExecutable) !== digestObject(record.providerExecutable) ||
        digestObject(record.providerInvocation.providerAuthorizationExecutable) !== digestObject(record.providerAuthorizationExecutable) ||
        digestObject(record.providerInvocation.providerAuthorization) !== digestObject(record.providerAuthorization) ||
        record.providerInvocation.credentialActor !== record.gitCredentialCheck?.actor ||
        JSON.stringify(record.providerInvocation.command) !== JSON.stringify(record.pushCommand))
    ) {
      throw new Error("Successful Git push reconciliation requires the governed actor-bound provider wrapper");
    }
    const notSentDispatchFailure = (
      record.action === "actions.dispatch" &&
      outcome === "failure" &&
      record.providerInvocation?.dispatchState === "not-sent"
    );
    if (
      record.action === "actions.dispatch" &&
      !notSentDispatchFailure &&
      // A nonzero CLI exit is not itself a provider conclusion: a nonce-bound
      // completed run remains authoritative and may be reconciled without retry.
      (!record.providerInvocation ||
        record.providerInvocation.provider !== "github-cli" ||
        record.providerInvocation.dispatchState !== "sent" ||
        digestObject(record.providerInvocation.providerExecutable) !== digestObject(record.providerExecutable) ||
        digestObject(record.providerInvocation.providerAuthorizationExecutable) !== digestObject(record.providerAuthorizationExecutable) ||
        digestObject(record.providerInvocation.providerAuthorization) !== digestObject(record.providerAuthorization) ||
        JSON.stringify(record.providerInvocation.command) !== JSON.stringify(record.dispatchCommand) ||
        !record.providerInvocation.workflowRun ||
        receipt.providerReceipt.invocationId !== record.providerInvocation.id)
    ) {
      throw new Error("GitHub Actions dispatch reconciliation requires the governed provider wrapper");
    }
    const duplicateExecution = records.some((candidate) => (
      candidate.tokenHash !== record.tokenHash &&
      candidate.receipt?.providerReceipt?.executionId === receipt.providerReceipt.executionId
    ));
    if (duplicateExecution) {
      throw new Error("Provider execution identity is already bound to another action attempt");
    }
    await validateActionEvidenceBinding(root, runDir, record, attemptId, outcome, receipt);
    const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
    if (record.action === "pr.merge" && outcome === "success") {
      const { reviewStatus } = await import("./review.mjs");
      const review = await reviewStatus(root, runId);
      if (!review.complete ||
          review.package?.head !== receipt.providerReceipt.head ||
          receipt.providerReceipt.pr !== record.pullRequest ||
          receipt.providerReceipt.head !== record.reviewedHead) {
        throw new Error("PR merge receipt is not bound to the complete reviewed PR head");
      }
    }
    if (record.action === "remote.sync" && outcome === "success") {
      const mergeAction = records.find((candidate) => (
        candidate.action === "pr.merge" &&
        candidate.outcome === "success" &&
        candidate.pullRequest === record.pullRequest &&
        candidate.reviewedHead === record.reviewedHead &&
        candidate.reviewPackageId === record.reviewPackageId &&
        candidate.receipt?.providerReceipt?.pr === record.pullRequest &&
        candidate.receipt?.providerReceipt?.head === record.reviewedHead &&
        typeof candidate.receipt?.providerReceipt?.mergeCommit === "string" &&
        candidate.receipt.providerReceipt.mergeCommit === record.mergeCommit
      ));
      const mergeCommit = mergeAction?.receipt?.providerReceipt?.mergeCommit;
      if (!mergeCommit || receipt.providerReceipt.providerRevision !== mergeCommit || receipt.providerReceipt.localRevision !== mergeCommit) {
        throw new Error("Remote sync receipt is not bound to the reconciled PR merge commit");
      }
    }
    await verifyProviderReceipt(manifest, { ...record, outcome }, receipt, run.contract);
    const autonomousCommitTransitionRequired = (
      record.action === "git.commit" &&
      record.provider === "git" &&
      outcome === "success" &&
      record.autonomyDecision?.decision === "auto-approved"
    );
    if (autonomousCommitTransitionRequired) {
      await assertAutonomousCommitEvidenceInvalidationSafe(root, runId, { run });
    }
    await reserveProviderExecution(root, record, receipt.providerReceipt.executionId, outcome);
    await onBoundary("provider-reservation");
    const autonomousCommitTransition = autonomousCommitTransitionRequired
      ? await transitionAutonomousCommitSourceBinding(root, runDir, run.contract, record, onBoundary)
      : null;
    const target = safeJoin(runDir, "actions", `${record.tokenHash}.json`);
    const next = {
      ...record,
      outcome,
      receipt,
      reconciledAt: nowIso(),
      ...(autonomousCommitTransition
        ? {
            sourceBindingTransition: {
              from: record.preCommitSourceBinding.digest,
              to: autonomousCommitTransition.sourceBinding.digest,
              headRevision: autonomousCommitTransition.sourceBinding.headRevision,
              at: autonomousCommitTransition.transitionedAt
            }
          }
        : {}),
      ...(record.action === "pr.create" && outcome === "success"
        ? { ownedResource: `pull/${receipt.providerReceipt.number}` }
        : {})
    };
    await atomicWriteJson(root, target, next);
    await onBoundary("action-persistence");
    if (autonomousCommitTransition) {
      await invalidateEvidenceAfterAutonomousCommit(
        root,
        runDir,
        record,
        autonomousCommitTransition.transitionedAt,
        onBoundary
      );
    }
    if (record.action === "plugin.cache.publish" && outcome === "success") {
      await finalizePluginCacheReadiness(runId, attemptId, receipt.providerReceipt);
    }
    await appendJournal(root, runDir, "action.reconciled", {
      attemptId,
      outcome,
      recoveredUnknown: recoveringUnknown,
      recoveredUnknownSuccess: recoveringUnknownSuccess,
      recoveredUnknownFailure: recoveringUnknownFailure
    });
    if (record.action === "pr.create" && outcome === "success") {
      const ownedResource = `pull/${receipt.providerReceipt.number}`;
      await registerOwnedResourceLocked(root, runId, run, runDir, {
        resource: ownedResource,
        creationReceipt: {
          ownerRunId: runId,
          runId,
          resource: ownedResource,
          creationResource: record.resource,
          action: record.action,
          attemptId: record.attemptId,
          idempotencyKey: record.idempotencyKey,
          remoteRevision: record.remoteRevision,
          outcome: "success",
          provider: record.provider,
          providerReceipt: receipt.providerReceipt,
          evidenceIds: receipt.evidenceIds,
          targetRef: record.targetRef,
          createdAt: nowIso()
        }
      });
    }
    if (outcome === "failure" && OWNED_RESOURCE_CREATION_ACTIONS.has(record.action)) {
      await releaseCreationResource(root, runId, record.creationReservation, record.tokenHash);
    }
    return next;
  });
}

export async function inspectRun(root, runId) {
  const run = await loadRun(root, runId);
  return {
    ...run,
    evidence: await listJsonRecords(root, safeJoin(run.runDir, "evidence")),
    evidenceSupersessions: await listJsonRecords(root, safeJoin(run.runDir, "evidence-supersessions")),
    findings: await listJsonRecords(root, safeJoin(run.runDir, "findings")),
    actions: await listJsonRecords(root, safeJoin(run.runDir, "actions"))
  };
}

async function reapExpiredCreationReservations(root) {
  const directory = safeJoin(root, "creation-reservations");
  if (!(await pathExists(directory))) return;
  await assertNoSymlinkUnder(root, directory);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const target = safeJoin(directory, entry.name);
    const reservation = await readJson(root, target).catch(() => null);
    if (
      !reservation?.provider ||
      !reservation?.repository ||
      !reservation?.action ||
      !reservation?.resource
    ) continue;
    const identity = validateCreationReservationIdentity(reservation);
    await withCreationReservationLock(root, identity, async () => {
      const current = await readJson(root, creationReservationPath(root, identity)).catch(() => null);
      if (!current?.runId || !current?.tokenHash || Date.parse(current.expiresAt ?? "") > Date.now()) return;
      const action = await readJson(root, safeJoin(runDirectory(root, current.runId), "actions", `${current.tokenHash}.json`)).catch(() => null);
      if (!action || action.status === "issued") {
        await unlink(creationReservationPath(root, identity)).catch(() => undefined);
      }
    });
  }
}

export async function cleanupRuns(root, { olderThanDays, apply = false }) {
  await ensureStateRoot(root);
  await reapExpiredCreationReservations(root);
  const runsRoot = safeJoin(root, "runs");
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const candidates = [];
  const candidateMtimes = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
    const runDir = runDirectory(root, entry.name);
    await assertNoSymlinkUnder(root, runDir);
    const state = await readJson(root, safeJoin(runDir, "state.json")).catch(() => null);
    const manifest = await readJson(root, safeJoin(runDir, "manifest.json")).catch(() => null);
    const contract = await readJson(root, safeJoin(runDir, "contract.json")).catch(() => null);
    const actions = await listJsonRecords(root, safeJoin(runDir, "actions")).catch(() => []);
    const info = await stat(runDir);
    const ownedResources = Array.isArray(manifest?.ownedResources) ? manifest.ownedResources : [];
    const ownedResourcesCleared = ownedResources.every((entry) => ownedResourceCleared(entry, actions));
    const pendingSideEffect = actions.some((action) => action.status !== "spent" || ["pending", "unknown", "failure"].includes(action.outcome));
    const quarantinedAction = actions.some((action) => (
      UNSUPPORTED_GOVERNED_ACTIONS.has(action.action) || isDeferredGovernedAction(contract, action.action)
    ));
    if (
      state &&
      ["completed", "no_op", "cancelled_superseded", "cancelled_evidence_sufficient"].includes(state.status) &&
      info.mtimeMs < cutoff &&
      ownedResourcesCleared &&
      !pendingSideEffect &&
      !quarantinedAction
    ) {
      candidates.push(entry.name);
      candidateMtimes.set(entry.name, info.mtimeMs);
    }
  }
  if (apply) {
    for (const runId of candidates) {
      if (!(await pathExists(runDirectory(root, runId)))) continue;
      try {
        await withRunLock(root, runId, async ({ runDir }) => {
          const state = await readJson(root, safeJoin(runDir, "state.json")).catch(() => null);
          const manifest = await readJson(root, safeJoin(runDir, "manifest.json")).catch(() => null);
          const contract = await readJson(root, safeJoin(runDir, "contract.json")).catch(() => null);
          const actions = await listJsonRecords(root, safeJoin(runDir, "actions")).catch(() => []);
          const ownedResources = Array.isArray(manifest?.ownedResources) ? manifest.ownedResources : [];
          const ownedResourcesCleared = ownedResources.every((entry) => ownedResourceCleared(entry, actions));
          const pendingSideEffect = actions.some((action) => action.status !== "spent" || ["pending", "unknown", "failure"].includes(action.outcome));
          const quarantinedAction = actions.some((action) => (
            UNSUPPORTED_GOVERNED_ACTIONS.has(action.action) || isDeferredGovernedAction(contract, action.action)
          ));
          const terminalAt = Date.parse(state?.updatedAt ?? "");
          const oldEnough = Number.isFinite(terminalAt)
            ? terminalAt < cutoff
            : candidateMtimes.get(runId) < cutoff;
          if (
            state &&
            ["completed", "no_op", "cancelled_superseded", "cancelled_evidence_sufficient"].includes(state.status) &&
            oldEnough &&
            ownedResourcesCleared &&
            !pendingSideEffect &&
            !quarantinedAction
          ) {
            for (const entry of ownedResources) {
              await releaseCreationResource(root, runId, entry.creationReservation);
            }
            await rm(runDir, { recursive: true, force: false });
          }
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return { apply, candidates };
}
