import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalGovernedGithubRepository, isExactGitAbsence, readRawLocalConfigValues } from "./git-observation-v1.mjs";
import { REVIEW_POLICIES, quorumReviewEnabled, reviewKernelEnabled, validateReviewProfile } from "./review-policy.mjs";
import { assertAutoPolicyBinding, autoPolicyBinding, autoPolicyDefinition } from "./auto-policy-v1.mjs";
import {
  assertDeliveryTargetEvidence,
  assertProtectedDeliveryRequest,
  isProtectedDeliveryTemplate,
  protectedDeliveryTarget,
  targetEvidenceKind
} from "./protected-delivery.mjs";
import {
  assertPrivateStateBackendAvailableV1,
  assertPrivateStatePathV1
} from "./private-state-backend-v1.mjs";
import { digestSentinelFile } from "./sentinel-file-digest.mjs";

const BOUND_GIT_EXECUTABLE = "/usr/bin/git";
const BOUND_GIT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const BOUND_GITHUB_CLI_TIMEOUT_MS = 30_000;
const BOUND_GITHUB_CLI_MAX_BUFFER = 1024 * 1024;
const BOUND_GIT_TIMEOUT_MS = 30_000;
const BOUND_GIT_MAX_BUFFER = 4 * 1024 * 1024;
const BOUND_PROCESS_TIMEOUT_MS = 300_000;
const BOUND_PROCESS_MAX_INPUT_BYTES = 100 * 1024 * 1024;
// The in-process supervisor force-kills its dedicated group after 100 ms when
// signalled. A completed target writes its result synchronously and schedules
// immediate group teardown, avoiding per-command latency while retaining the
// signal grace for hanging descendants. A
// short parent grace keeps the cleanup proof bounded without adding a full
// second of idle latency to every successful Git/provider call.
const BOUND_PROCESS_GROUP_CLEANUP_GRACE_MS = 250;
const BOUND_TIMEOUT_PROCESS_GROUP_CLEANUP_GRACE_MS = 1_000;
const BOUND_CREDENTIAL_ROOT = process.platform === "darwin" ? "/private/tmp" : "/tmp";
export const BOUND_CREDENTIAL_WORKSPACE_ROOT = BOUND_CREDENTIAL_ROOT;

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
  "const scheduleForceKill = (delayMs = 100) => { if (forceScheduled) return; forceScheduled = true; setTimeout(forceKill, delayMs); };",
  "for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) process.on(signal, scheduleForceKill);",
  "const watchdog = setInterval(() => { if (process.ppid !== parentPid) { forceKill(); } }, 25);",
  "watchdog.unref();",
  "const report = (code, signal) => { if (reported) return; reported = true; try { fs.writeSync(3, JSON.stringify({ schemaVersion: 1, code: code ?? null, signal: signal ?? null }) + '\\n'); } catch {} finally { scheduleForceKill(0); } };",
  "let child;",
  "try { child = spawn(target, targetArgs, { cwd, env: process.env, stdio: ['inherit', 'inherit', 'inherit', 'ignore'] }); } catch { report(126, null); }",
  "child?.once('error', () => report(126, null));",
  "child?.once('close', (code, signal) => report(code, signal));",
  "setInterval(() => {}, 1000);"
].join(" ");

function boundGitAuthorityEnvironment(indexFile = null) {
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
    GIT_GRAFT_FILE: "/dev/null",
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {})
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
  timeoutLimitMs = BOUND_GIT_TIMEOUT_MS,
  input = undefined,
  encoding = "utf8",
  label = "Bound process"
} = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return Promise.reject(new Error(`${label} requires an explicit controlled environment`));
  }
  if (!Number.isSafeInteger(timeoutLimitMs) || timeoutLimitMs < 1 || timeoutLimitMs > BOUND_PROCESS_TIMEOUT_MS) {
    return Promise.reject(new Error(`${label} timeout policy is invalid`));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > timeoutLimitMs) {
    return Promise.reject(new Error(`${label} timeout is outside the fixed bounded policy`));
  }
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > BOUND_GIT_MAX_BUFFER) {
    return Promise.reject(new Error(`${label} output limit is outside the fixed bounded policy`));
  }
  if (encoding !== null && encoding !== "buffer" && !Buffer.isEncoding(encoding)) {
    return Promise.reject(new Error(`${label} output encoding is invalid`));
  }
  if (
    input !== undefined && !Buffer.isBuffer(input) && typeof input !== "string" &&
    !(input instanceof Uint8Array)
  ) {
    return Promise.reject(new Error(`${label} input must be bytes or a string`));
  }
  if (input !== undefined && Buffer.byteLength(input) > BOUND_PROCESS_MAX_INPUT_BYTES) {
    return Promise.reject(new Error(`${label} input exceeds the fixed bounded policy`));
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
      stdio: supervised
        ? [input === undefined ? "ignore" : "pipe", "pipe", "pipe", "pipe"]
        : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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
    let cleanupError = null;
    let childError = null;
    let supervisorResult = null;
    let supervisorProtocolError = null;
    let supervisorBuffer = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const diagnosticOutput = (chunks) => {
      try {
        const bytes = Buffer.concat(chunks);
        return encoding === null || encoding === "buffer" ? bytes : bytes.toString(encoding);
      } catch {
        return encoding === null || encoding === "buffer" ? null : "";
      }
    };
    const processGroupCleanupFailure = () => {
      const error = new Error("Bound child process group termination could not be verified");
      error.code = "EPROCESSGROUP";
      error.status = "UNKNOWN";
      if (cleanupError !== null) error.cause = cleanupError;
      else if (childError !== null) error.cause = childError;
      if (childError !== null) error.childError = childError;
      error.stdout = diagnosticOutput(stdout);
      error.stderr = diagnosticOutput(stderr);
      return error;
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
      })().catch((error) => {
        cleanupError ??= error;
        return false;
      });
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
    if (input !== undefined) {
      child.stdin.on("error", (error) => {
        if (!["EPIPE", "ERR_STREAM_DESTROYED"].includes(error.code)) {
          supervisorProtocolError = new Error(`${label} input stream failed: ${error.message}`);
          terminate();
        }
      });
      child.stdin.end(input);
    }
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
      childError ??= error;
      // Windows has no stable process-group leader. Do not start a new
      // numeric-pid cleanup after an error; retain UNKNOWN if this invocation
      // has no cleanup already in flight.
      if (process.platform === "win32" && child.pid && !cleanupPromise) {
        cleanupError ??= new Error("Bound child identity could not be revalidated after its error");
        cleanupPromise = Promise.resolve(false);
      }
      void cleanupProcessGroup()
        .then((groupTerminated) => {
          finish(groupTerminated ? childError : processGroupCleanupFailure());
        })
        .catch((handlerFailure) => {
          const failure = new Error("Bound child process group termination could not be verified");
          failure.code = "EPROCESSGROUP";
          failure.status = "UNKNOWN";
          failure.cause = cleanupError ?? handlerFailure;
          if (childError !== null) failure.childError = childError;
          finish(failure);
        });
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      void (async () => {
        const groupTerminated = await cleanupProcessGroup();
        if (!groupTerminated) {
          finish(processGroupCleanupFailure());
          return;
        }
        if (childError !== null) {
          finish(childError);
          return;
        }
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
  input = undefined,
  encoding = "utf8",
  label = "Bound process"
} = {}) {
  return execBoundChildProcess(executablePath, args, {
    cwd,
    env,
    timeoutMs,
    maxBuffer,
    timeoutLimitMs: BOUND_PROCESS_TIMEOUT_MS,
    input,
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
  encoding = "utf8",
  indexFile = null
} = {}) {
  try {
    if (indexFile !== null) {
      const canonicalIndexFile = path.resolve(indexFile);
      const temporaryRoot = await realpath(os.tmpdir());
      const temporaryDirectory = await realpath(path.dirname(canonicalIndexFile));
      const relativeTemporaryDirectory = path.relative(temporaryRoot, temporaryDirectory);
      if (
        canonicalIndexFile !== indexFile ||
        relativeTemporaryDirectory === ".." || relativeTemporaryDirectory.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeTemporaryDirectory)
      ) {
        throw new Error("Bound Git temporary index must be an absolute file under the canonical temporary root");
      }
      const temporaryIndexInfo = await lstat(canonicalIndexFile);
      if (
        temporaryIndexInfo.isSymbolicLink() || !temporaryIndexInfo.isFile() ||
        temporaryIndexInfo.uid !== (process.getuid?.() ?? temporaryIndexInfo.uid) ||
        (temporaryIndexInfo.mode & 0o077) !== 0
      ) {
        throw new Error("Bound Git temporary index must be an owner-only regular file");
      }
    }
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
      env: boundGitAuthorityEnvironment(indexFile),
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

// Keep the legacy export as a quarantine boundary for existing callers. The
// public core never loads private bounded-autopilot implementations.
export async function captureAutonomyReadinessSnapshot() {
  throw publicAutoRunRequired("Legacy autonomy snapshot capture");
}

function assertNoAmbientGitAuthorityOverrides() {
  const neutralConfiguration = Object.freeze({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1"
  });
  const dangerous = Object.keys(process.env).filter((key) => {
    if (Object.hasOwn(neutralConfiguration, key) && process.env[key] === neutralConfiguration[key]) return false;
    return key === "GIT_CONFIG_COUNT" || key === "GIT_CONFIG_PARAMETERS" ||
      key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_") ||
      [
        "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
        "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
        "GIT_REPLACE_REF_BASE", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE"
      ].includes(key);
  }).sort();
  if (dangerous.length > 0) {
    throw new Error(`Git authority rejects ambient routing or configuration overrides: ${dangerous.join(",")}`);
  }
}

export const VERSION = "5.0.0-rc.1";
const MIGRATABLE_LEGACY_EXACT_VERSIONS = new Set([
  "1.0.0",
  "2.0.1",
  "2.1.0",
  "2.5.0",
  "2.6.0"
]);
const MIGRATABLE_LEGACY_FAMILIES = Object.freeze([
  // Before v4, every 3.4.x manifest no newer than the running plugin was
  // eligible. Preserve that bounded final-v3.4 upgrade path after the major
  // bump without exposing a historical patch label as an active version.
  Object.freeze({ major: 3, minor: 4, maxPatch: 14 }),
  Object.freeze({ major: 3, minor: 5, maxPatch: 0 }),
  // V5 retains only the shipped v4.0.0 manifest family for bounded legacy
  // reads and migration; later v4 patches/minors remain ineligible.
  Object.freeze({ major: 4, minor: 0, maxPatch: 0 })
]);

export function isMigratableWorkflowVersion(version) {
  if (MIGRATABLE_LEGACY_EXACT_VERSIONS.has(version)) return true;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    String(version ?? "")
  );
  if (!match) return false;
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  const [currentMajor, currentMinor, currentPatch] = VERSION.split(".").map(Number);
  if (major === currentMajor && minor === currentMinor) {
    return patch <= currentPatch;
  }
  return MIGRATABLE_LEGACY_FAMILIES.some((family) => (
    major === family.major && minor === family.minor && patch <= family.maxPatch
  ));
}
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
    tokenHash: action.tokenHash,
    idempotencyKey: action.idempotencyKey,
    action: action.action,
    provider: action.provider,
    providerRepository: action.providerRepository,
    resource: action.resource,
    creationReservation: action.creationReservation,
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
  "worktree.create:git",
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
const PROVIDER_EXECUTION_SCHEMA_VERSION = 2;
const CREATION_RESERVATION_SCHEMA_VERSION = 2;
const CREATION_RESERVATION_RELEASE_SCHEMA_VERSION = 1;
const PROVIDER_ACTION_SOURCE_MUTATIONS = new Set([
  "recipe.promote:local-workspace",
  "artifact.promote:local-workspace"
]);
const PROVIDER_ACTION_SOURCE_MUTATION_SCHEMA_VERSION = 1;

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
function assertActionTokenContractVersion(contract, operation) {
  if (contract?.schemaVersion === 2) return;
  const error = new Error(
    `${operation} requires TaskContract schemaVersion 2; legacy v1 cannot authorize new actions`
  );
  error.code = "EACTION_CONTRACT_VERSION";
  throw error;
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
  mergeMethod = "merge",
  providerExecutable,
  repository
}) {
  return {
    ...prior,
    pullRequest,
    reviewedHead,
    remoteRevision,
    ...(targetRef ? { targetRef } : {}),
    mergeMethod,
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
      mergeMethod === "merge" ? "--merge" : "--squash",
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
  if (env.XDG_STATE_HOME) {
    return path.join(path.resolve(env.XDG_STATE_HOME), "better-workflows");
  }
  const home = env.HOME
    ? path.resolve(env.HOME)
    : env.USERPROFILE
      ? path.resolve(env.USERPROFILE)
      : os.homedir();
  return path.join(home, ".better-workflows");
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
  assertPrivateStateBackendAvailableV1();
  if (await pathExists(target)) {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink directory: ${target}`);
    if (!info.isDirectory()) throw new Error(`Expected directory: ${target}`);
  } else {
    await mkdir(target, { recursive: true, mode: 0o700 });
  }
  await chmod(target, 0o700);
  assertPrivateStatePathV1({
    root: target,
    target,
    info: await lstat(target),
    kind: "directory",
    label: `private directory ${target}`
  });
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
  assertPrivateStateBackendAvailableV1();
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonIfExists(root, target) {
  try {
    return await readJson(root, target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function unlinkDurableFile(directory, target, { allowAbsent = false } = {}) {
  assertPrivateStateBackendAvailableV1();
  let removed = true;
  try {
    await unlink(target);
  } catch (error) {
    if (error.code !== "ENOENT" || !allowAbsent) throw error;
    removed = false;
  }
  await fsyncDirectory(directory);
  if (await pathExists(target)) {
    throw new Error(`Durable file removal did not reach an absent state: ${target}`);
  }
  return { removed };
}

export async function atomicWriteJson(root, target, value) {
  assertPrivateStateBackendAvailableV1();
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
  assertPrivateStateBackendAvailableV1();
  await assertNoSymlinkUnder(root, target);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    const error = new Error(`Unsafe JSON path: ${target}`);
    error.code = "EUNSAFE_JSON_PATH";
    error.observation = Object.freeze({
      isSymbolicLink: info.isSymbolicLink(),
      isFile: info.isFile(),
      nlink: Number.isSafeInteger(info.nlink) ? info.nlink : null
    });
    throw error;
  }
  return JSON.parse(await readFile(target, "utf8"));
}

export async function appendJournal(root, runDir, event, details = {}) {
  assertPrivateStateBackendAvailableV1();
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

export async function readJournalRecords(root, runDir) {
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
  const defaults = JSON.parse(await readFile(DEFAULTS_PATH, "utf8"));
  const interaction = defaults.interaction ?? {};
  if (!interaction || typeof interaction !== "object" || Array.isArray(interaction)) {
    throw new Error("defaults.interaction must be an object");
  }
  const defaultMode = interaction.defaultMode ?? "auto";
  if (!['auto', 'strict'].includes(defaultMode)) {
    throw new Error("defaults.interaction.defaultMode must be auto or strict");
  }
  if (interaction.strictOptIn !== undefined && typeof interaction.strictOptIn !== "boolean") {
    throw new Error("defaults.interaction.strictOptIn must be boolean");
  }
  const sopPolicy = interaction.sopPolicy ?? "sop-auto-v1";
  if (sopPolicy !== "sop-auto-v1") {
    throw new Error("defaults.interaction.sopPolicy is unsupported");
  }
  if (interaction.deduplicatePrompts !== undefined && typeof interaction.deduplicatePrompts !== "boolean") {
    throw new Error("defaults.interaction.deduplicatePrompts must be boolean");
  }
  const defaultAutonomyProfile = interaction.defaultAutonomyProfile ?? null;
  if (defaultAutonomyProfile !== null) {
    throw new Error("Public Auto does not enable an autonomy profile by default");
  }
  const autoTemplateStrategy = interaction.autoTemplateStrategy ?? "evidence-safe";
  if (autoTemplateStrategy !== "evidence-safe") {
    throw new Error("defaults.interaction.autoTemplateStrategy is unsupported");
  }
  return {
    ...defaults,
    interaction: {
      defaultMode,
      strictOptIn: interaction.strictOptIn ?? true,
      sopPolicy,
      deduplicatePrompts: interaction.deduplicatePrompts ?? true,
      defaultAutonomyProfile,
      autoTemplateStrategy
    }
  };
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
  if (contract?.template !== "auto") throw publicAutoRunRequired("Run mode routing");
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
  const riskMode = irreversibility >= 3 || (baseRisk >= 3 && blastRadius >= 2) || score >= 11
    ? "critical" : score >= 7 ? "deep" : score >= 3 ? "verified" : "direct";
  const binding = assertAutoPolicyBinding(contract.autoPolicy);
  const policyMode = autoPolicyDefinition(binding.id).defaultMode;
  const rank = { direct: 0, verified: 1, deep: 2, critical: 3 };
  const minimum = rank[policyMode] >= rank[riskMode] ? policyMode : riskMode;
  if (requested !== "auto" && rank[requested] < rank[minimum]) {
    throw new Error(`Public Auto policy ${binding.id} requires at least ${minimum} mode`);
  }
  return requested === "auto" ? minimum : requested;
}

export function validateContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("TaskContract must be an object");
  }
  if (![1, 2].includes(contract.schemaVersion)) {
    throw new Error("TaskContract.schemaVersion must be 1 or 2");
  }
  if (
    contract.evidenceAdmissionProtocolVersion !== undefined &&
    contract.evidenceAdmissionProtocolVersion !== EVIDENCE_ADMISSION_PROTOCOL_VERSION
  ) {
    throw new Error("TaskContract.evidenceAdmissionProtocolVersion is unsupported");
  }
  if (typeof contract.goal !== "string" || !contract.goal.trim()) {
    throw new Error("TaskContract.goal is required");
  }
  if (typeof contract.template !== "string" || !contract.template) {
    throw new Error("TaskContract.template is required");
  }
  if (contract.template !== "auto") throw publicAutoRunRequired("TaskContract validation");
  if (contract.template === "auto") {
    const binding = assertAutoPolicyBinding(contract.autoPolicy);
    const policy = autoPolicyDefinition(binding.id);
    if (contract.schemaVersion !== 2 || contract.autonomyProfile !== undefined) {
      throw new Error("Public Auto requires a v2 contract without bounded autopilot");
    }
    if (contract.upstreamSelfImproveRunId !== undefined) {
      throw new Error("Public Auto cannot bind a private self-improve upstream run");
    }
    for (const field of [
      "acceptance", "requiredEvidence", "controlPlane", "reviewProfile",
      "executionStages", "actionGates", "actionStages", "deferredActions"
    ]) {
      if (digestObject(contract[field] ?? null) !== digestObject(policy[field] ?? null)) {
        throw new Error(`Public Auto contract ${field} differs from canonical ${binding.id} policy`);
      }
    }
    const expectedAcceptanceEvidence = Object.fromEntries(
      policy.acceptance.map((item) => [item.id, [...policy.requiredEvidence]])
    );
    if (digestObject(contract.acceptanceEvidence) !== digestObject(expectedAcceptanceEvidence)) {
      throw new Error("Public Auto acceptance evidence differs from canonical policy");
    }
    if (contract.templateDigest !== undefined && contract.templateDigest !== digestObject(policy)) {
      throw new Error("Public Auto template digest differs from canonical policy");
    }
    const actions = new Set(Object.keys(policy.actionGates));
    if (!Array.isArray(contract.authority?.externalSideEffects) ||
        contract.authority.externalSideEffects.some((action) => !actions.has(action))) {
      throw new Error("Public Auto authority contains an action outside the selected policy");
    }
  } else if (contract.autoPolicy !== undefined) {
    throw new Error("Auto policy binding is only valid for the public Auto template");
  }
  if (contract.interactionMode !== undefined && !["auto", "strict"].includes(contract.interactionMode)) {
    throw new Error("TaskContract.interactionMode is invalid");
  }
  if (contract.selfImprovePurpose !== undefined) {
    throw publicAutoRunRequired("TaskContract validation");
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
    throw publicAutoRunRequired("TaskContract validation");
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
      if (Object.hasOwn(contract.actionStages, "pr.merge")) {
        if (!actionGates["pr.merge"]?.includes("required-checks")) {
          throw new Error("TaskContract v2 pr.merge must be gated by required-checks for atomic protected-base synchronization");
        }
        if (!contract.requiredEvidence.includes("required-checks")) {
          throw new Error("TaskContract v2 pr.merge must declare required-checks evidence");
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
  interactionMode = "auto",
  selfImprovePurpose = undefined,
  autonomyProfile = undefined
}) {
  if (selfImprovePurpose !== undefined || autonomyProfile !== undefined) {
    throw publicAutoRunRequired("TaskContract construction");
  }
  const acceptance = templateDefinition.acceptance ?? [
    { id: "task-complete", description: "The requested task is complete.", critical: true }
  ];
  const requiredEvidence = templateDefinition.requiredEvidence ?? [];
  const isV2 = templateDefinition.controlPlane && Array.isArray(templateDefinition.executionStages);
  const acceptanceEvidence = Object.fromEntries(
    acceptance.map((item) => [item.id, [...requiredEvidence]])
  );
  const externalSideEffects = [...new Set(authority)];
  return validateContract({
    schemaVersion: isV2 ? 2 : 1,
    evidenceAdmissionProtocolVersion: EVIDENCE_ADMISSION_PROTOCOL_VERSION,
    goal,
    template,
    ...(template === "auto"
      ? { autoPolicy: autoPolicyBinding(templateDefinition.autoPolicyId) }
      : {}),
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
    interactionMode,
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

export async function createRun({
  root = getStateRoot(), contract, requestedMode = "auto", cwd, baselineRevision = null,
  expectedOriginIdentityDigest = null
}) {
  if (contract?.template !== "auto") {
    throw publicAutoRunRequired("Run creation");
  }
  validateContract(contract);
  if (expectedOriginIdentityDigest !== null && !SHA256_DIGEST.test(expectedOriginIdentityDigest)) {
    throw new Error("Run creation requires an exact expected origin identity digest");
  }
  if (contract.evidenceAdmissionProtocolVersion === undefined) {
    contract.evidenceAdmissionProtocolVersion = EVIDENCE_ADMISSION_PROTOCOL_VERSION;
  }
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
    for (const child of ["evidence", "evidence-admissions", "findings", "sentinels", "actions"]) {
      await ensurePrivateDir(safeJoin(stagingDir, child));
    }
    const createdAt = nowIso();
    const { captureSourceBinding } = await import("./git.mjs");
    const sourceBinding = await captureSourceBinding(path.resolve(cwd), {
      baseRevision: baselineRevision ?? contract.remoteRevision ?? null,
      requireClean: false
    });
    if (expectedOriginIdentityDigest !== null &&
        sourceBinding.originIdentity?.digest !== expectedOriginIdentityDigest) {
      throw new Error("Remote origin changed after the live protected-target revision observation");
    }
    const { deriveCampaignBinding } = await import("./campaign.mjs");
    const campaign = deriveCampaignBinding(contract, sourceBinding);
    const manifest = {
      schemaVersion: 1,
      runId,
      version: VERSION,
      template: contract.template,
      mode,
      requestedMode,
      cwd: path.resolve(cwd),
      baselineRevision,
      pluginCacheRoot: getCodexPluginCacheRoot(),
      sourceBinding,
      campaign,
      initialSourceBindingDigest: sourceBinding?.digest ?? null,
      evidenceAdmissionProtocolVersion: contract.evidenceAdmissionProtocolVersion,
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
      sideEffects: []
    };
    await atomicWriteJson(root, safeJoin(stagingDir, "contract.json"), contract);
    await atomicWriteJson(root, safeJoin(stagingDir, "manifest.json"), manifest);
    await atomicWriteJson(root, safeJoin(stagingDir, "state.json"), state);
    if (contract.schemaVersion === 2) {
      const { initializeLedger } = await import("./ledger.mjs");
      await initializeLedger(root, stagingDir, contract, runId);
    }
    await appendJournal(root, stagingDir, "run.created", {
      mode,
      requestedMode,
      campaignId: campaign.campaignId,
      evidenceAdmissionProtocolVersion: contract.evidenceAdmissionProtocolVersion
    });
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
  const contract = await readJson(root, safeJoin(runDir, "contract.json"));
  const run = {
    runDir,
    manifest: await readJson(root, safeJoin(runDir, "manifest.json")),
    contract,
    state: await readJson(root, safeJoin(runDir, "state.json"))
  };
  assertPublicAutoRunBinding(run, "Run loading");
  return run;
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
  assertPrivateStateBackendAvailableV1();
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
  if (record.commitBatchBinding) {
    const binding = record.commitBatchBinding;
    if (
      record.action !== "git.commit" || record.provider !== "git" ||
      record.scope !== `${GOVERNED_COMMIT_BATCH_PROTOCOL}:${binding.batchId}` ||
      record.commitBatchBindingDigest !== commitBatchBindingDigest(binding) ||
      providerReceipt.commitBatchBindingDigest !== record.commitBatchBindingDigest ||
      providerReceipt.commitBatchId !== binding.batchId ||
      providerReceipt.commitBatchOrdinal !== binding.ordinal ||
      providerReceipt.commitBatchPlanDigest !== binding.planDigest ||
      providerReceipt.candidateIndexTree !== binding.candidateIndexTree
    ) {
      throw new Error("Git commit proof is not bound to the exact staged-batches-v1 action");
    }
    if (outcome === "success" && !SHA.test(providerReceipt.revision ?? "")) {
      throw new Error("Successful staged-batches-v1 commit proof requires a full SHA-1 revision");
    }
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
      !SHA.test(providerReceipt.revision ?? "") ||
      providerReceipt.creationProof?.markerVersion !== 1 ||
      !SHA256_DIGEST.test(providerReceipt.creationProof?.markerDigest ?? "") ||
      typeof providerReceipt.creationProof?.gitDir !== "string" ||
      typeof providerReceipt.creationProof?.gitCommonDir !== "string")
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
      !["merge", "squash"].includes(providerReceipt.mergeMethod) ||
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

function providerExecutionIdentity(record, executionId) {
  const repository = record?.providerRepository ?? record?.creationReservation?.repository;
  const identity = {
    schemaVersion: PROVIDER_EXECUTION_SCHEMA_VERSION,
    executionId,
    runId: record?.runId,
    attemptId: record?.attemptId,
    tokenHash: record?.tokenHash,
    action: record?.action,
    provider: record?.provider,
    repository,
    resource: record?.resource,
    idempotencyKey: record?.idempotencyKey,
    remoteRevision: record?.remoteRevision
  };
  if (
    typeof identity.executionId !== "string" || !identity.executionId ||
    typeof identity.runId !== "string" || !identity.runId ||
    typeof identity.attemptId !== "string" || !identity.attemptId ||
    !SHA256_DIGEST.test(String(identity.tokenHash ?? "")) ||
    typeof identity.action !== "string" || !identity.action ||
    typeof identity.provider !== "string" || !identity.provider ||
    typeof identity.repository !== "string" || !identity.repository ||
    typeof identity.resource !== "string" || !identity.resource ||
    typeof identity.idempotencyKey !== "string" || !identity.idempotencyKey ||
    typeof identity.remoteRevision !== "string" || !identity.remoteRevision
  ) {
    throw new Error("Provider execution requires a complete immutable action identity");
  }
  return identity;
}

function providerExecutionReservation(identity, outcome, recordedAt = nowIso()) {
  return {
    ...identity,
    identityDigest: digestObject(identity),
    outcome,
    recordedAt
  };
}

export function classifyProviderExecutionReplay(existing, record, executionId, outcome) {
  const identity = providerExecutionIdentity(record, executionId);
  if (
    existing?.schemaVersion !== PROVIDER_EXECUTION_SCHEMA_VERSION ||
    typeof existing?.executionId !== "string" ||
    typeof existing.identityDigest !== "string" ||
    !["unknown", "success", "failure"].includes(existing?.outcome)
  ) {
    throw new Error("Legacy provider execution reservation cannot be recovered; preserve the reservation");
  }
  if (
    existing.identityDigest !== digestObject(identity) ||
    Object.entries(identity).some(([key, value]) => existing[key] !== value)
  ) {
    throw new Error("Provider execution identity is already reserved globally");
  }
  if (existing.supersededBy !== undefined && existing.supersededBy !== null) {
    throw new Error("Provider execution identity was superseded by another identity");
  }
  const allowedKeys = new Set([
    ...Object.keys(identity),
    "identityDigest",
    "outcome",
    "recordedAt",
    ...(existing.outcome === "unknown" ? [] : ["terminalAt"])
  ]);
  if (
    Object.keys(existing).some((key) => !allowedKeys.has(key)) ||
    !Number.isFinite(Date.parse(existing.recordedAt ?? "")) ||
    (existing.terminalAt !== undefined && !Number.isFinite(Date.parse(existing.terminalAt)))
  ) {
    throw new Error("Provider execution reservation contains unbound fields");
  }
  if (existing.outcome === outcome) return "replay";
  const recoverableUnknown = OWNED_RESOURCE_CREATION_ACTIONS.has(record.action) ||
    (record.action === "git.commit" && record.provider === "git" && outcome === "success");
  if (
    recoverableUnknown && record.outcome === "unknown" && existing.outcome === "unknown" &&
    ["success", "failure"].includes(outcome)
  ) {
    return "resolve";
  }
  throw new Error("Provider execution identity is already bound to a different terminal outcome");
}

export async function reserveProviderExecution(
  root,
  record,
  executionId,
  outcome = record.outcome,
  { onBoundary = null } = {}
) {
  assertPrivateStateBackendAvailableV1();
  if (onBoundary !== null && typeof onBoundary !== "function") {
    throw new Error("Provider execution reservation boundary hook must be a function");
  }
  const directory = safeJoin(root, "provider-executions");
  let directoryCreated = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    directoryCreated = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error("Provider execution reservation directory is unsafe");
  }
  await chmod(directory, 0o700);
  if (directoryCreated) await onBoundary?.("provider-reservation-directory-created");
  // Always sync the state root, including on replay. A prior process may have
  // stopped after mkdir(2) but before making the directory entry durable.
  await fsyncDirectory(root);
  await onBoundary?.("provider-reservation-root-durable");
  const identity = providerExecutionIdentity(record, executionId);
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
    typeof item.identityDigest !== "string" ||
    !["unknown", "success", "failure"].includes(item.outcome)
  ))) {
    throw new Error("Legacy provider execution reservation cannot be recovered; preserve the reservation");
  }
  const exact = sameAttempt.find((item) => item.executionId === executionId);
  if (exact) {
    const replay = classifyProviderExecutionReplay(exact, record, executionId, outcome);
    if (replay === "resolve") {
      await atomicWriteJson(root, target, {
        ...exact,
        outcome,
        terminalAt: nowIso()
      });
    }
    await fsyncDirectory(directory);
    await onBoundary?.("provider-reservation-replay-durable");
    return;
  }
  if (sameAttempt.length > 0) {
    throw new Error("Provider execution identity is already bound to this action attempt");
  }
  await onBoundary?.("provider-reservation-before-create");
  try {
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(providerExecutionReservation(identity, outcome))}\n`);
      await handle.sync();
      await onBoundary?.("provider-reservation-file-synced");
    } finally {
      await handle.close();
    }
    await fsyncDirectory(directory);
    await onBoundary?.("provider-reservation-directory-durable");
  } catch (error) {
    if (error.code === "EEXIST") {
      const existing = await readJson(root, target);
      const replay = classifyProviderExecutionReplay(existing, record, executionId, outcome);
      if (replay === "resolve") {
        await atomicWriteJson(root, target, {
          ...existing,
          outcome,
          terminalAt: nowIso()
        });
      }
      await fsyncDirectory(directory);
      await onBoundary?.("provider-reservation-replay-durable");
      return;
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

function validateCreationReservationOwner(owner) {
  if (
    !owner || typeof owner !== "object" || Array.isArray(owner) ||
    typeof owner.runId !== "string" || !owner.runId ||
    typeof owner.attemptId !== "string" || !owner.attemptId ||
    !SHA256_DIGEST.test(String(owner.tokenHash ?? "")) ||
    typeof owner.idempotencyKey !== "string" || !owner.idempotencyKey
  ) {
    throw new Error("Creation reservation owner identity is incomplete");
  }
  return {
    runId: owner.runId,
    attemptId: owner.attemptId,
    tokenHash: owner.tokenHash,
    idempotencyKey: owner.idempotencyKey
  };
}

function creationReservationOwnerFromAction(record) {
  return validateCreationReservationOwner(record);
}

function creationReservationRecord(identity, owner, expiresAt, reservedAt = nowIso()) {
  const reservationIdentity = validateCreationReservationIdentity(identity);
  const reservationOwner = validateCreationReservationOwner(owner);
  if (!Number.isFinite(Date.parse(expiresAt ?? ""))) {
    throw new Error("Creation reservation expiry is invalid");
  }
  const binding = {
    schemaVersion: CREATION_RESERVATION_SCHEMA_VERSION,
    ...reservationIdentity,
    reservationKey: creationReservationKey(reservationIdentity),
    ...reservationOwner,
    expiresAt
  };
  return {
    ...binding,
    bindingDigest: digestObject(binding),
    reservedAt
  };
}

function validateCreationReservationRecord(record, identity, owner = null, expiresAt = null) {
  const reservationIdentity = validateCreationReservationIdentity(identity);
  const reservationOwner = owner === null
    ? validateCreationReservationOwner(record)
    : validateCreationReservationOwner(owner);
  const expected = creationReservationRecord(
    reservationIdentity,
    reservationOwner,
    expiresAt ?? record?.expiresAt,
    record?.reservedAt
  );
  if (
    record?.schemaVersion !== CREATION_RESERVATION_SCHEMA_VERSION ||
    record.bindingDigest !== expected.bindingDigest ||
    Object.keys(record ?? {}).sort().join("\0") !== Object.keys(expected).sort().join("\0") ||
    Object.entries(expected).some(([key, value]) => record[key] !== value)
  ) {
    throw new Error("Creation reservation identity changed or is incomplete");
  }
  return record;
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

function creationReservationLeaseRecordPath(lockPath) {
  return path.join(lockPath, "record.json");
}

async function readCreationReservationLease(root, lockPath, { allowIncomplete = false } = {}) {
  let info;
  try {
    info = await lstat(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error("Creation reservation lease path is unsafe");
  if (info.isDirectory()) {
    const recordPath = creationReservationLeaseRecordPath(lockPath);
    const record = await readJsonIfExists(root, recordPath);
    if (record === null) {
      if (allowIncomplete) return { format: "directory", record: null, recordPath };
      throw new Error("Creation reservation lease is incomplete; refusing to reclaim");
    }
    return { format: "directory", record, recordPath };
  }
  if (!info.isFile()) throw new Error("Creation reservation lease path is unsafe");
  // Read legacy file leases for compatibility, but never create a new lease
  // by exposing a pathname before its JSON record is complete.
  return { format: "file", record: await readJson(root, lockPath), recordPath: lockPath };
}

async function waitForCreationReservationLease(root, lockPath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const lease = await readCreationReservationLease(root, lockPath, { allowIncomplete: true });
    if (lease === null || lease.record !== null) return lease;
    if (Date.now() >= deadline) {
      throw new Error("Creation reservation lease remained incomplete; refusing to reclaim");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function removeCreationReservationLease(root, directory, lockPath, { allowAbsent = false, onBoundary = null } = {}) {
  const lease = await readCreationReservationLease(root, lockPath);
  if (lease === null) {
    if (!allowAbsent) throw new Error("Creation reservation lease disappeared before release");
    await fsyncDirectory(directory);
    return { removed: false };
  }
  if (lease.format === "file") {
    return unlinkDurableFile(directory, lockPath, { allowAbsent });
  }
  // A contender can recreate this pathname immediately after rmdir. Keep the
  // retiring directory pinned until the durability check is complete, so a
  // successor lease is not mistaken for (or removed as) our own lease.
  const retired = await open(lockPath, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const retiredInfo = await retired.stat();
    const currentInfo = await lstat(lockPath);
    if (!retiredInfo.isDirectory() || currentInfo.isSymbolicLink() || !currentInfo.isDirectory() ||
        retiredInfo.dev !== currentInfo.dev || retiredInfo.ino !== currentInfo.ino) {
      throw new Error("Creation reservation lease directory identity changed before release");
    }
    await unlinkDurableFile(lockPath, lease.recordPath, { allowAbsent: false });
    await rmdir(lockPath);
    await onBoundary?.("creation-lease-removed-before-release-check", { lockPath });
    await fsyncDirectory(directory);
    const successorInfo = await lstat(lockPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (successorInfo && successorInfo.dev === retiredInfo.dev && successorInfo.ino === retiredInfo.ino) {
      throw new Error(`Creation reservation lease directory remained after release: ${lockPath}`);
    }
    return { removed: true };
  } finally {
    await retired.close();
  }
}

function creationReservationReleaseDirectory(root) {
  return safeJoin(root, "creation-reservation-releases");
}

function creationReservationReleasePath(root, identity, owner) {
  const key = {
    reservation: validateCreationReservationIdentity(identity),
    owner: validateCreationReservationOwner(owner)
  };
  return safeJoin(creationReservationReleaseDirectory(root), `${digestObject(key)}.json`);
}

function creationReservationReleaseBinding(identity, owner, reservationDigest) {
  if (!SHA256_DIGEST.test(String(reservationDigest ?? ""))) {
    throw new Error("Creation reservation release requires the exact reservation digest");
  }
  return {
    schemaVersion: CREATION_RESERVATION_RELEASE_SCHEMA_VERSION,
    reservation: validateCreationReservationIdentity(identity),
    owner: validateCreationReservationOwner(owner),
    reservationDigest
  };
}

function validateCreationReservationRelease(record, identity, owner) {
  if (
    !record || record.schemaVersion !== CREATION_RESERVATION_RELEASE_SCHEMA_VERSION ||
    !["prepared", "released"].includes(record.status) ||
    !Number.isFinite(Date.parse(record.preparedAt ?? ""))
  ) {
    throw new Error("Creation reservation release tombstone is malformed");
  }
  const binding = creationReservationReleaseBinding(identity, owner, record.binding?.reservationDigest);
  const expectedKeys = [
    "binding",
    "bindingDigest",
    "preparedAt",
    ...(record.status === "released" ? ["releasedAt"] : []),
    "schemaVersion",
    "status"
  ].sort().join("\0");
  if (
    Object.keys(record).sort().join("\0") !== expectedKeys ||
    record.bindingDigest !== digestObject(binding) ||
    digestObject(record.binding) !== digestObject(binding)
  ) {
    throw new Error("Creation reservation release tombstone identity changed");
  }
  if (record.status === "released" && !Number.isFinite(Date.parse(record.releasedAt ?? ""))) {
    throw new Error("Creation reservation release tombstone lacks a terminal timestamp");
  }
  return record;
}

async function releaseCreationResourceLocked(root, identity, owner) {
  const reservationIdentity = validateCreationReservationIdentity(identity);
  const reservationOwner = validateCreationReservationOwner(owner);
  const directory = safeJoin(root, "creation-reservations");
  const target = creationReservationPath(root, reservationIdentity);
  const releaseDirectory = creationReservationReleaseDirectory(root);
  await ensurePrivateDir(releaseDirectory);
  await fsyncDirectory(root);
  const releaseTarget = creationReservationReleasePath(root, reservationIdentity, reservationOwner);
  const reservation = await readJsonIfExists(root, target);
  const priorRelease = await readJsonIfExists(root, releaseTarget);
  if (reservation === null) {
    if (!priorRelease) {
      throw new Error("Creation reservation absence is not bound to an exact release tombstone");
    }
    const release = validateCreationReservationRelease(priorRelease, reservationIdentity, reservationOwner);
    if (release.status === "released") return release;
    const terminal = { ...release, status: "released", releasedAt: nowIso() };
    await atomicWriteJson(root, releaseTarget, terminal);
    return terminal;
  }
  validateCreationReservationRecord(reservation, reservationIdentity, reservationOwner);
  const binding = creationReservationReleaseBinding(
    reservationIdentity,
    reservationOwner,
    digestObject(reservation)
  );
  let release = priorRelease;
  if (release) {
    release = validateCreationReservationRelease(release, reservationIdentity, reservationOwner);
    if (release.bindingDigest !== digestObject(binding)) {
      throw new Error("Creation reservation release tombstone is bound to different reservation bytes");
    }
    if (release.status === "released") {
      throw new Error("Released creation reservation unexpectedly reappeared");
    }
  } else {
    release = {
      schemaVersion: CREATION_RESERVATION_RELEASE_SCHEMA_VERSION,
      binding,
      bindingDigest: digestObject(binding),
      status: "prepared",
      preparedAt: nowIso()
    };
    await atomicWriteJson(root, releaseTarget, release);
  }
  await unlinkDurableFile(directory, target);
  const terminal = { ...release, status: "released", releasedAt: nowIso() };
  await atomicWriteJson(root, releaseTarget, terminal);
  return terminal;
}

async function withCreationReservationLock(root, identity, callback, options = {}) {
  assertPrivateStateBackendAvailableV1();
  const reservationIdentity = validateCreationReservationIdentity(identity);
  const directory = safeJoin(root, "creation-reservations");
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error("Creation reservation directory is unsafe");
  }
  await chmod(directory, 0o700);
  // Replay must also sync the root because an earlier mkdir may have survived
  // in cache without its parent directory entry reaching stable storage.
  await fsyncDirectory(root);
  const lockPath = creationReservationLeasePath(root, reservationIdentity);
  const reservationKey = creationReservationKey(reservationIdentity);
  const token = randomBytes(24).toString("hex");
  const ttlMs = options.ttlMs ?? 60_000;
  let acquired = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const lockInfo = await lstat(lockPath);
      if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory()) {
        throw new Error("Creation reservation lease path is unsafe");
      }
      await chmod(lockPath, 0o700);
      await atomicWriteJson(root, creationReservationLeaseRecordPath(lockPath), {
        token,
        pid: process.pid,
        host: os.hostname(),
        reservationKey,
        ...reservationIdentity,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString()
      });
      await fsyncDirectory(lockPath);
      await fsyncDirectory(directory);
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const lease = await waitForCreationReservationLease(root, lockPath);
      if (lease === null) continue;
      const existing = lease.record;
      const expired = existing && Date.parse(existing.expiresAt) < Date.now();
      if (!expired || existing?.host !== os.hostname() || processAlive(existing?.pid)) {
        if (expired && existing?.host && existing.host !== os.hostname()) {
          throw new Error(`Creation reservation lease expired on host ${existing.host}; refusing cross-host lease reclamation`);
        }
        throw new Error(`Creation resource is leased by pid ${existing?.pid ?? "unknown"}`);
      }
      try {
        await rename(lockPath, safeJoin(directory, `.${reservationKey}.lease.stale.${randomUUID()}`));
      } catch (renameError) {
        if (renameError.code === "ENOENT") continue;
        throw renameError;
      }
      await fsyncDirectory(directory);
    }
  }
  if (!acquired) throw new Error("Unable to acquire creation reservation lease");
  try {
    await options.onBoundary?.("creation-lease-acquired", { lockPath, token, reservationKey });
    return await callback();
  } finally {
    const lease = await readCreationReservationLease(root, lockPath);
    const existing = lease?.record ?? null;
    if (existing !== null && (existing.token !== token || existing.reservationKey !== reservationKey)) {
      throw new Error("Creation reservation lease identity changed before release");
    }
    await removeCreationReservationLease(root, directory, lockPath, { allowAbsent: true, onBoundary: options.onBoundary });
  }
}

async function reserveCreationResource(root, identity, owner, expiresAt, options = {}) {
  const reservationIdentity = validateCreationReservationIdentity(identity);
  const reservationOwner = validateCreationReservationOwner(owner);
  return withCreationReservationLock(root, reservationIdentity, async () => {
    const directory = safeJoin(root, "creation-reservations");
    const legacyTarget = legacyCreationReservationPath(root, reservationIdentity.resource);
    if (await pathExists(legacyTarget)) {
      throw new Error("Legacy unscoped creation reservation requires explicit reconciliation");
    }
    const target = creationReservationPath(root, reservationIdentity);
    const existing = await readJsonIfExists(root, target);
    const existingRecord = existing
      ? validateCreationReservationRecord(existing, reservationIdentity)
      : null;
    const existingAction = existingRecord?.runId && existingRecord?.tokenHash
      ? await readJson(root, safeJoin(runDirectory(root, existing.runId), "actions", `${existing.tokenHash}.json`)).catch(() => null)
      : null;
    const expiredIssued = (
      existingAction?.status === "issued" &&
      Number.isFinite(Date.parse(existing?.expiresAt ?? "")) &&
      Date.parse(existing.expiresAt) <= Date.now()
    );
    const knownFailure = existingAction?.status === "spent" && existingAction?.outcome === "failure";
    if (existingRecord && !expiredIssued && !knownFailure) {
      throw new Error("Owned resource creation is already reserved by another action for this provider repository");
    }
    if (existingRecord) {
      await releaseCreationResourceLocked(
        root,
        reservationIdentity,
        validateCreationReservationOwner(existingRecord)
      );
    }
    const value = creationReservationRecord(reservationIdentity, reservationOwner, expiresAt);
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(directory);
  }, options);
}

// Test-only seam for exercising the durable cross-process reservation boundary
// without coupling the regression to unrelated action-token admission gates.
export async function reserveCreationResourceForTest(root, identity, owner, expiresAt, options = {}) {
  return reserveCreationResource(root, identity, owner, expiresAt, options);
}

async function releaseCreationResource(root, identity, owner) {
  const reservationIdentity = validateCreationReservationIdentity(identity);
  const reservationOwner = validateCreationReservationOwner(owner);
  return withCreationReservationLock(root, reservationIdentity, async () => {
    return releaseCreationResourceLocked(root, reservationIdentity, reservationOwner);
  });
}

async function assertCreationReservation(root, identity, owner, expiresAt) {
  const reservationIdentity = validateCreationReservationIdentity(identity);
  const reservationOwner = validateCreationReservationOwner(owner);
  const reservation = await readJsonIfExists(root, creationReservationPath(root, reservationIdentity));
  if (!reservation || Date.parse(reservation.expiresAt ?? "") <= Date.now()) {
    throw new Error("Action token creation reservation is missing, expired, or rebound");
  }
  try {
    return validateCreationReservationRecord(reservation, reservationIdentity, reservationOwner, expiresAt);
  } catch (error) {
    throw new Error("Action token creation reservation is missing, expired, or rebound", { cause: error });
  }
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
  const creationReservationOwner = creationReservationOwnerFromAction(creationAction);
  const existing = Array.isArray(manifest.ownedResources)
    ? manifest.ownedResources.find((item) => item?.resource === resource)
    : null;
  if (!existing) {
    try {
      await assertCreationReservation(
        root,
        creationReservation,
        creationReservationOwner,
        creationAction.expiresAt
      );
    } catch {
      throw new Error("Owned resource registration requires an exclusive creation reservation");
    }
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
  if (existing) {
    if (
      existing.ownerRunId !== runId || existing.receiptDigest !== receiptDigest ||
      digestObject(existing.creationReservationOwner ?? null) !== digestObject(creationReservationOwner)
    ) {
      throw new Error("Owned resource registration is immutable");
    }
    await releaseCreationResource(root, creationReservation, creationReservationOwner);
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
    creationReservationOwner,
    registeredAt: nowIso()
  };
  const nextManifest = {
    ...manifest,
    ownedResources: [...manifest.ownedResources, entry]
  };
  await atomicWriteJson(root, manifestPath, nextManifest);
  await appendJournal(root, runDir, "resource.registered", entry);
  await releaseCreationResource(root, creationReservation, creationReservationOwner);
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
    assertMutableRun({ contract, manifest, state }, "Legacy run migration");
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
    if (!isMigratableWorkflowVersion(manifest.version)) {
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
    const run = await loadRun(root, runId);
    const current = run.state;
    assertMutableRun(run, "Run state");
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

function publicAutoRunRequired(operation) {
  const error = new Error(`${operation} requires a canonical public Auto run`);
  error.code = "EWORKFLOW_PUBLIC_AUTO_REQUIRED";
  error.status = "HOLD";
  return error;
}

function assertPublicAutoRunBinding(run, operation) {
  if (run?.contract?.template !== "auto" || run?.manifest?.template !== "auto" ||
      run.manifest.autonomyProfile != null || run.state?.autonomy != null ||
      run.contract.upstreamSelfImproveRunId != null) {
    throw publicAutoRunRequired(operation);
  }
  validateContract(run.contract);
  if (run.manifest.contractDigest !== digestObject(run.contract)) {
    throw publicAutoRunRequired(operation);
  }
}

function isPublicAutoActionRecord(record) {
  return record?.autonomyDecision == null && record?.autonomySnapshot == null &&
    record?.autonomyDecisionReceipt == null;
}

function assertPublicAutoActionRecord(record, operation) {
  if (!isPublicAutoActionRecord(record)) {
    throw publicAutoRunRequired(operation);
  }
}

function isPublicAutoRunBinding(run) {
  try {
    assertPublicAutoRunBinding(run, "Run cleanup");
    return true;
  } catch {
    return false;
  }
}

export function assertMutableRun(run, operation = "Run mutation") {
  assertPublicAutoRunBinding(run, operation);
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
    const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
    const contract = await readJson(root, safeJoin(runDir, "contract.json"));
    assertMutableRun({ contract, manifest, state: current }, "Run completion");
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

function evidenceValueForAdmission(admitted, existing = null) {
  const normalized = structuredClone(admitted);
  if (existing?.typedAdmission?.admittedAt && normalized.typedAdmission) {
    normalized.typedAdmission = {
      ...normalized.typedAdmission,
      admittedAt: existing.typedAdmission.admittedAt
    };
  }
  return {
    schemaVersion: 1,
    stale: false,
    createdAt: existing?.createdAt ?? nowIso(),
    dependencies: {},
    producer: {},
    ...normalized,
    admissionProtocolVersion: EVIDENCE_ADMISSION_PROTOCOL_VERSION
  };
}

function evidenceAdmissionIntentBinding(intent) {
  return {
    protocolVersion: intent.protocolVersion,
    runId: intent.runId,
    evidenceId: intent.evidenceId,
    evidenceDigest: intent.evidenceDigest,
    immutableEvidenceDigest: intent.immutableEvidenceDigest
  };
}

function validateEvidenceAdmissionIntent(intent, runId, evidenceId) {
  assertExactObjectKeys(intent, EVIDENCE_ADMISSION_INTENT_KEYS, "Evidence admission intent");
  if (
    intent.schemaVersion !== 1 ||
    intent.protocolVersion !== EVIDENCE_ADMISSION_PROTOCOL_VERSION ||
    intent.id !== evidenceId ||
    intent.evidenceId !== evidenceId ||
    intent.runId !== runId ||
    !intent.evidenceRecord ||
    typeof intent.evidenceRecord !== "object" ||
    Array.isArray(intent.evidenceRecord) ||
    intent.evidenceRecord.id !== evidenceId ||
    intent.evidenceRecord.admissionProtocolVersion !== EVIDENCE_ADMISSION_PROTOCOL_VERSION ||
    intent.evidenceDigest !== digestObject(intent.evidenceRecord) ||
    intent.immutableEvidenceDigest !== digestObject(evidenceImmutableProjection(intent.evidenceRecord)) ||
    intent.intentDigest !== digestObject(evidenceAdmissionIntentBinding(intent))
  ) {
    throw new Error(`Evidence admission intent binding is invalid: ${evidenceId}`);
  }
  return intent;
}

function evidenceAdmissionJournalDetails(intent) {
  return {
    protocolVersion: EVIDENCE_ADMISSION_PROTOCOL_VERSION,
    runId: intent.runId,
    evidenceId: intent.evidenceId,
    evidenceDigest: intent.evidenceDigest,
    immutableEvidenceDigest: intent.immutableEvidenceDigest,
    intentDigest: intent.intentDigest
  };
}

function matchesEvidenceAdmissionJournalEntry(entry, event, intent) {
  const expected = evidenceAdmissionJournalDetails(intent);
  return Boolean(
    entry?.event === event &&
    typeof entry.at === "string" &&
    Number.isFinite(Date.parse(entry.at)) &&
    Object.entries(expected).every(([key, value]) => entry[key] === value)
  );
}

export async function addEvidence(root, runId, record, { onAdmissionBoundary = null } = {}) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const boundRun = await loadRun(root, runId);
    assertMutableRun(boundRun, "Evidence");
    if (onAdmissionBoundary !== null && typeof onAdmissionBoundary !== "function") {
      throw new Error("Evidence admission boundary hook must be a function");
    }
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
    const intentTarget = safeJoin(runDir, "evidence-admissions", `${admitted.id}.json`);
    const existingRecords = await listIdentityBoundJsonRecords(root, safeJoin(runDir, "evidence"), "Evidence");
    let journal = await readJournalRecords(root, runDir);
    await assertEvidenceJournalProvenance(root, boundRun, existingRecords, journal, {
      ignoreEvidenceId: admitted.id
    });

    let intent;
    if (await pathExists(intentTarget)) {
      intent = validateEvidenceAdmissionIntent(await readJson(root, intentTarget), runId, admitted.id);
      const retryValue = evidenceValueForAdmission(admitted, intent.evidenceRecord);
      if (digestObject(retryValue) !== intent.evidenceDigest) {
        throw new Error(`Evidence admission retry conflicts with the durable intent: ${admitted.id}`);
      }
    } else {
      const currentAdmissionEvents = journal.filter((entry) => (
        [EVIDENCE_ADMISSION_PENDING_EVENT, "evidence.added"].includes(entry.event) &&
        entry.evidenceId === admitted.id
      ));
      if ((await pathExists(target)) || currentAdmissionEvents.length > 0) {
        throw new Error(`Evidence already exists without a recoverable admission intent: ${admitted.id}`);
      }
      const value = evidenceValueForAdmission(admitted);
      const binding = {
        protocolVersion: EVIDENCE_ADMISSION_PROTOCOL_VERSION,
        runId,
        evidenceId: admitted.id,
        evidenceDigest: digestObject(value),
        immutableEvidenceDigest: digestObject(evidenceImmutableProjection(value))
      };
      intent = {
        schemaVersion: 1,
        id: admitted.id,
        ...binding,
        evidenceRecord: value,
        intentDigest: digestObject(binding)
      };
      await atomicWriteJson(root, intentTarget, intent);
    }
    await onAdmissionBoundary?.("intent-written");

    journal = await readJournalRecords(root, runDir);
    const pending = journal.filter((entry) => (
      entry.event === EVIDENCE_ADMISSION_PENDING_EVENT && entry.evidenceId === admitted.id
    ));
    if (pending.length === 0) {
      await appendJournal(root, runDir, EVIDENCE_ADMISSION_PENDING_EVENT, evidenceAdmissionJournalDetails(intent));
    } else if (pending.length !== 1 || !matchesEvidenceAdmissionJournalEntry(
      pending[0],
      EVIDENCE_ADMISSION_PENDING_EVENT,
      intent
    )) {
      throw new Error(`Evidence admission pending journal binding is missing or ambiguous: ${admitted.id}`);
    }
    await onAdmissionBoundary?.("pending-journaled");

    if (await pathExists(target)) {
      const existing = await readJson(root, target);
      if (digestObject(existing) !== intent.evidenceDigest) {
        throw new Error(`Evidence file conflicts with the durable admission intent: ${admitted.id}`);
      }
    } else {
      await atomicWriteJson(root, target, intent.evidenceRecord);
    }
    await onAdmissionBoundary?.("evidence-written");

    journal = await readJournalRecords(root, runDir);
    const added = journal.filter((entry) => entry.event === "evidence.added" && entry.evidenceId === admitted.id);
    if (added.length === 0) {
      await appendJournal(root, runDir, "evidence.added", evidenceAdmissionJournalDetails(intent));
    } else if (added.length !== 1 || !matchesEvidenceAdmissionJournalEntry(
      added[0],
      "evidence.added",
      intent
    )) {
      throw new Error(`Evidence admission commit journal binding is missing or ambiguous: ${admitted.id}`);
    }
    await onAdmissionBoundary?.("admission-committed");
    return intent.evidenceRecord;
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
  if (!["resolved", "rejected-with-evidence"].includes(record.status)) return null;
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
  const freshness = await assertCurrentEvidenceFreshness(
    run,
    evidence,
    "Finding disposition evidence"
  );
  const payload = evidence.receipt?.payload;
  if (!Array.isArray(payload?.findingIds) || !payload.findingIds.includes(record.id)) {
    throw new Error("Finding disposition evidence is not bound to the finding");
  }
  return {
    findingId: record.id,
    severity: record.severity,
    status: record.status,
    evidenceId: evidence.id,
    evidenceDigest: digestObject(evidence),
    freshnessProjectionDigest: freshness.projectionDigest
  };
}

async function currentFindingDispositionBinding(root, runId, run) {
  const findings = await listJsonRecords(root, safeJoin(run.runDir, "findings"));
  const dispositions = [];
  const inventory = [];
  for (const finding of findings) {
    validateFinding(finding);
    if (["P0", "P1"].includes(finding.severity) && finding.status === "open") {
      throw new Error("Action token denied by unresolved P0/P1 finding");
    }
    if (!["P0", "P1"].includes(finding.severity)) continue;
    inventory.push({ id: finding.id, digest: digestObject(finding) });
    const binding = await assertFindingEvidence(root, run, run.runDir, finding);
    if (binding) dispositions.push(binding);
  }
  inventory.sort((left, right) => left.id.localeCompare(right.id));
  dispositions.sort((left, right) => left.findingId.localeCompare(right.findingId));
  return {
    digest: digestObject(dispositions),
    dispositions,
    inventory
  };
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
const REVIEW_EVIDENCE_SUPERSESSION_SCHEMA_VERSION = 1;
const REVIEW_EVIDENCE_SUPERSESSION_DIRECTORY = "review-evidence-supersessions";
const REVIEW_EVIDENCE_SUPERSESSION_EVENT = "review.evidence.superseded";
const REVIEW_EVIDENCE_SUPERSESSION_KIND = "review-evidence";
const REVIEW_EVIDENCE_SUPERSESSION_TARGET_DISPOSITION = "invalidated";
const REVIEW_EVIDENCE_SUPERSESSION_REPLACEMENT_DISPOSITION = "selected";
const REVIEW_EVIDENCE_SUPERSESSION_SELECTION_POLICY = "effective-current-only";
const REVIEW_EVIDENCE_SUPERSESSION_REASON_CODE = "missing-dependency-inputs";
const REVIEW_EVIDENCE_SUPERSESSION_REASON_CODES = new Set([
  REVIEW_EVIDENCE_SUPERSESSION_REASON_CODE,
  "dependency-freshness-drift"
]);
const REVIEW_EVIDENCE_SUPERSESSION_KEYS = new Set([
  "schemaVersion",
  "id",
  "runId",
  "kind",
  "targetDisposition",
  "replacementDisposition",
  "selectionPolicy",
  "supersededEvidence",
  "replacementEvidence",
  "reviewBinding",
  "contractDigest",
  "sourceBindingDigest",
  "policyDigest",
  "reasonCode",
  "reason",
  "actor",
  "createdAt"
]);
const REVIEW_EVIDENCE_SUPERSESSION_INPUT_KEYS = new Set([
  "schemaVersion",
  "id",
  "supersededEvidenceId",
  "supersededEvidenceDigest",
  "replacementEvidenceId",
  "replacementEvidenceDigest",
  "reasonCode",
  "reason"
]);
const REVIEW_EVIDENCE_REVIEW_BINDING_KEYS = new Set([
  "packageId",
  "base",
  "head",
  "scopeDigest",
  "diffManifestDigest",
  "instructionDigest"
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
const EVIDENCE_ADMISSION_PROTOCOL_VERSION = 1;
const EVIDENCE_ADMISSION_PENDING_EVENT = "evidence.admission-pending";
const EVIDENCE_ADMISSION_INTENT_KEYS = new Set([
  "schemaVersion",
  "id",
  "protocolVersion",
  "runId",
  "evidenceId",
  "evidenceDigest",
  "immutableEvidenceDigest",
  "evidenceRecord",
  "intentDigest"
]);
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

function evidenceAdmissionJournalBinding(record, journal, {
  allowPending = false,
  intent = null,
  runId = null,
  requiredProtocolVersion = null
} = {}) {
  const added = journal.filter((entry) => entry.event === "evidence.added" && entry.evidenceId === record.id);
  if (
    added.length !== 1 ||
    !SHA256_DIGEST.test(added[0].evidenceDigest ?? "") ||
    !SHA256_DIGEST.test(added[0].immutableEvidenceDigest ?? "")
  ) {
    throw new Error(`Evidence admission journal binding is missing or ambiguous: ${record.id}`);
  }
  const pending = journal.filter((entry) => (
    entry.event === EVIDENCE_ADMISSION_PENDING_EVENT && entry.evidenceId === record.id
  ));
  if (
    requiredProtocolVersion === EVIDENCE_ADMISSION_PROTOCOL_VERSION &&
    record.admissionProtocolVersion !== EVIDENCE_ADMISSION_PROTOCOL_VERSION
  ) {
    throw new Error(`Evidence admission protocol downgrade is forbidden by run history: ${record.id}`);
  }
  if (record.admissionProtocolVersion === undefined) {
    if (intent !== null || pending.length !== 0 || added[0].protocolVersion !== undefined) {
      throw new Error(`Legacy evidence admission was reinterpreted by a newer protocol: ${record.id}`);
    }
  } else if (record.admissionProtocolVersion === EVIDENCE_ADMISSION_PROTOCOL_VERSION) {
    if (runId === null || intent === null) {
      throw new Error(`Evidence admission intent is missing: ${record.id}`);
    }
    validateEvidenceAdmissionIntent(intent, runId, record.id);
    if (
      pending.length !== 1 ||
      !matchesEvidenceAdmissionJournalEntry(
        pending[0],
        EVIDENCE_ADMISSION_PENDING_EVENT,
        intent
      ) ||
      !matchesEvidenceAdmissionJournalEntry(added[0], "evidence.added", intent)
    ) {
      throw new Error(`Evidence two-phase admission journal chain is invalid: ${record.id}`);
    }
  } else {
    throw new Error(`Evidence admission protocol is unsupported: ${record.id}`);
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
  let admissionIntent = null;
  let admissionRunId = null;
  if (current.admissionProtocolVersion === EVIDENCE_ADMISSION_PROTOCOL_VERSION) {
    admissionRunId = (await readJson(root, safeJoin(runDir, "manifest.json"))).runId;
    admissionIntent = await readJson(
      root,
      safeJoin(runDir, "evidence-admissions", `${current.id}.json`)
    );
  }
  const binding = evidenceAdmissionJournalBinding(current, journal, {
    allowPending: true,
    intent: admissionIntent,
    runId: admissionRunId
  });
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

async function recoverPendingEvidenceFreshnessTransitions(root, runDir, records) {
  const journal = await readJournalRecords(root, runDir);
  const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
  const recoveredIds = [];
  const recoveredRecords = [];
  for (const current of records) {
    let admissionIntent = null;
    if (current.admissionProtocolVersion === EVIDENCE_ADMISSION_PROTOCOL_VERSION) {
      admissionIntent = await readJson(
        root,
        safeJoin(runDir, "evidence-admissions", `${current.id}.json`)
      );
    }
    const binding = evidenceAdmissionJournalBinding(current, journal, {
      allowPending: true,
      intent: admissionIntent,
      runId: manifest.runId
    });
    if (!binding.pendingTransition) {
      recoveredRecords.push(current);
      continue;
    }
    const pending = binding.pendingTransition;
    const recovered = applyEvidenceFreshnessPatch(current, pending.freshnessPatch);
    if (
      pending.immutableEvidenceDigest !== binding.immutableEvidenceDigest ||
      digestObject(recovered) !== pending.evidenceDigest
    ) {
      throw new Error(`Evidence freshness pending transition cannot be recovered: ${current.id}`);
    }
    await atomicWriteJson(root, safeJoin(runDir, "evidence", `${current.id}.json`), recovered);
    recoveredIds.push(current.id);
    recoveredRecords.push(recovered);
  }
  return { records: recoveredRecords, recoveredIds };
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

function hasCanonicalEvidenceDependencyInputs(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "files") &&
    Array.isArray(value.files) &&
    value.files.every((candidate) => typeof candidate === "string" && candidate.length > 0)
  );
}

function reviewEvidenceBinding(record) {
  const payload = record?.receipt?.payload;
  return {
    packageId: payload?.packageId,
    base: payload?.base,
    head: payload?.head,
    scopeDigest: payload?.scopeDigest,
    diffManifestDigest: payload?.diffManifestDigest,
    instructionDigest: payload?.instructionDigest
  };
}

function reviewEvidenceContentProjection(record) {
  const projection = structuredClone(record);
  delete projection.id;
  for (const key of [
    "createdAt",
    "dependencyInputs",
    "dependencies",
    "stale",
    "freshnessCheckedAt",
    "currentDependencyFiles",
    "staleReason"
  ]) delete projection[key];
  if (projection.typedAdmission) delete projection.typedAdmission.admittedAt;
  if (projection.receipt) delete projection.receipt.producedAt;
  return projection;
}

function reviewEvidencePackageBinding(reviewPackage) {
  return {
    packageId: reviewPackage.packageId,
    base: reviewPackage.base,
    head: reviewPackage.head,
    scopeDigest: reviewPackage.scopeDigest,
    diffManifestDigest: reviewPackage.diffManifestDigest,
    instructionDigest: reviewPackage.instructionDigest
  };
}

async function validateReviewEvidenceSupersessionRecord(root, run, recordsById, journal, record) {
  assertExactObjectKeys(record, REVIEW_EVIDENCE_SUPERSESSION_KEYS, "Review evidence supersession record");
  if (record.schemaVersion !== REVIEW_EVIDENCE_SUPERSESSION_SCHEMA_VERSION) {
    throw new Error("Review evidence supersession schemaVersion must be 1");
  }
  validateRecordId(record.id, "review evidence supersession");
  if (
    record.runId !== run.manifest.runId ||
    record.actor !== "root" ||
    record.kind !== REVIEW_EVIDENCE_SUPERSESSION_KIND ||
    record.targetDisposition !== REVIEW_EVIDENCE_SUPERSESSION_TARGET_DISPOSITION ||
    record.replacementDisposition !== REVIEW_EVIDENCE_SUPERSESSION_REPLACEMENT_DISPOSITION ||
    record.selectionPolicy !== REVIEW_EVIDENCE_SUPERSESSION_SELECTION_POLICY ||
    !REVIEW_EVIDENCE_SUPERSESSION_REASON_CODES.has(record.reasonCode)
  ) {
    throw new Error("Review evidence supersession lifecycle binding is invalid");
  }
  if (typeof record.reason !== "string" || record.reason.trim().length < 12 || record.reason.length > 512) {
    throw new Error("Review evidence supersession reason must be 12 to 512 characters");
  }
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error("Review evidence supersession createdAt is invalid");
  }
  assertExactObjectKeys(record.reviewBinding, REVIEW_EVIDENCE_REVIEW_BINDING_KEYS, "Review evidence supersession review binding");
  validateRecordId(record.reviewBinding.packageId, "review package");
  if (
    !SHA.test(record.reviewBinding.base) ||
    !SHA.test(record.reviewBinding.head) ||
    !SHA256_DIGEST.test(record.reviewBinding.scopeDigest) ||
    !SHA256_DIGEST.test(record.reviewBinding.diffManifestDigest) ||
    !SHA256_DIGEST.test(record.reviewBinding.instructionDigest)
  ) {
    throw new Error("Review evidence supersession review binding is invalid");
  }
  if (
    record.contractDigest !== run.manifest.contractDigest ||
    record.contractDigest !== digestObject(run.contract) ||
    record.sourceBindingDigest !== (run.manifest.sourceBinding?.digest ?? null) ||
    !SHA256_DIGEST.test(record.contractDigest) ||
    (
      record.sourceBindingDigest !== null &&
      !SHA256_DIGEST.test(record.sourceBindingDigest)
    ) ||
    !SHA256_DIGEST.test(record.policyDigest)
  ) {
    throw new Error("Review evidence supersession contract or source binding is stale");
  }
  for (const [label, binding] of [
    ["superseded", record.supersededEvidence],
    ["replacement", record.replacementEvidence]
  ]) {
    assertExactObjectKeys(binding, new Set(["id", "digest"]), `Review evidence supersession ${label} binding`);
    validateRecordId(binding.id, `${label} review evidence`);
    if (!SHA256_DIGEST.test(binding.digest)) {
      throw new Error(`Review evidence supersession ${label} digest is invalid`);
    }
  }
  if (record.supersededEvidence.id === record.replacementEvidence.id) {
    throw new Error("Review evidence supersession target and replacement must differ");
  }
  const target = recordsById.get(record.supersededEvidence.id);
  const replacement = recordsById.get(record.replacementEvidence.id);
  if (!target || !replacement) {
    throw new Error("Review evidence supersession target or replacement is missing");
  }
  if (
    digestObject(target) !== record.supersededEvidence.digest ||
    digestObject(replacement) !== record.replacementEvidence.digest
  ) {
    throw new Error("Review evidence supersession evidence digest changed");
  }
  if (
    target.kind !== "diff-review" ||
    replacement.kind !== "diff-review" ||
    target.schemaVersion !== 2 ||
    replacement.schemaVersion !== 2 ||
    target.status !== "complete" ||
    replacement.status !== "complete" ||
    !target.typedAdmission ||
    !replacement.typedAdmission
  ) {
    throw new Error("Review evidence supersession only supports typed diff-review records");
  }
  const packagePath = safeJoin(
    run.runDir,
    "review-packages",
    `${record.reviewBinding.packageId}.json`
  );
  const reviewPackage = await readJson(root, packagePath);
  if (
    reviewPackage.schemaVersion !== 1 ||
    reviewPackage.immutable !== true ||
    digestObject(reviewEvidencePackageBinding(reviewPackage)) !== digestObject(record.reviewBinding)
  ) {
    throw new Error("Review evidence supersession package binding is invalid");
  }
  if (
    digestObject(reviewEvidenceBinding(target)) !== digestObject(record.reviewBinding) ||
    digestObject(reviewEvidenceBinding(replacement)) !== digestObject(record.reviewBinding)
  ) {
    throw new Error("Review evidence supersession receipt is bound to a different review package");
  }
  if (digestObject(reviewEvidenceContentProjection(target)) !== digestObject(reviewEvidenceContentProjection(replacement))) {
    throw new Error("Review evidence supersession may only correct dependency inputs");
  }
  const targetDependencyInputsValid = hasCanonicalEvidenceDependencyInputs(target.dependencyInputs);
  if (!hasCanonicalEvidenceDependencyInputs(replacement.dependencyInputs)) {
    throw new Error("Review evidence supersession replacement dependencyInputs are invalid");
  }
  const targetFreshness = await currentEvidenceFreshness(run, target);
  if (record.reasonCode === REVIEW_EVIDENCE_SUPERSESSION_REASON_CODE) {
    if (targetDependencyInputsValid) {
      throw new Error("Review evidence supersession target is not the missing-dependency-inputs predecessor");
    }
    if (digestObject(target.dependencies ?? null) !== digestObject(replacement.dependencies ?? null)) {
      throw new Error("Review evidence supersession dependency projection changed");
    }
  } else {
    if (!targetDependencyInputsValid || digestObject(target.dependencyInputs) !== digestObject(replacement.dependencyInputs)) {
      throw new Error("Review evidence dependency-freshness correction changed its input paths");
    }
    const targetDependencies = structuredClone(target.dependencies ?? {});
    const replacementDependencies = structuredClone(replacement.dependencies ?? {});
    delete targetDependencies.files;
    delete replacementDependencies.files;
    if (digestObject(targetDependencies) !== digestObject(replacementDependencies)) {
      throw new Error("Review evidence dependency-freshness correction changed its static binding");
    }
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
    throw new Error("Review evidence supersession chronology is invalid");
  }
  const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
  const legacyDependencyInputs = {
    files: Array.isArray(target.dependencies?.files)
      ? target.dependencies.files.map((entry) => entry?.path).filter((value) => typeof value === "string" && value.length > 0)
      : []
  };
  await validateTypedEvidenceRecord(
    { ...target, dependencyInputs: legacyDependencyInputs },
    {
      manifest: run.manifest,
      contract: run.contract,
      state: run.state,
      root,
      runDir: run.runDir,
      requireReconciled: false
    }
  );
  if (!targetFreshness.stale) {
    throw new Error("Review evidence supersession target is not stale");
  }
  if (
    record.reasonCode === REVIEW_EVIDENCE_SUPERSESSION_REASON_CODE &&
    (
      targetFreshness.expectedDependencies !== null ||
      targetFreshness.projectionDigest !== digestObject({ invalidDependencyInputs: true })
    )
  ) {
    throw new Error("Review evidence supersession target is not stale solely from missing dependencyInputs");
  }
  await validateTypedEvidenceRecord(replacement, {
    manifest: run.manifest,
    contract: run.contract,
    state: run.state,
    root,
    runDir: run.runDir,
    requireReconciled: true
  });
  await assertCurrentEvidenceFreshness(run, replacement, "Review evidence supersession replacement");
  const recordDigest = digestObject(record);
  const matchingJournal = journal.filter((entry) => (
    entry.event === REVIEW_EVIDENCE_SUPERSESSION_EVENT &&
    entry.supersessionId === record.id &&
    entry.supersessionDigest === recordDigest &&
    entry.supersededEvidenceId === record.supersededEvidence.id &&
    entry.supersededEvidenceDigest === record.supersededEvidence.digest &&
    entry.replacementEvidenceId === record.replacementEvidence.id &&
    entry.replacementEvidenceDigest === record.replacementEvidence.digest &&
    entry.supersessionKind === record.kind &&
    entry.selectionPolicy === record.selectionPolicy &&
    entry.reasonCode === record.reasonCode &&
    typeof entry.at === "string" &&
    Number.isFinite(Date.parse(entry.at)) &&
    Date.parse(entry.at) >= supersededAt
  ));
  if (matchingJournal.length !== 1) {
    throw new Error("Review evidence supersession journal binding is missing or ambiguous");
  }
  return { record, target, replacement };
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
      requireClean: false
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
  return { stale, currentDependencyFiles: current, expectedDependencies, projectionDigest, currentSourceBinding: sourceBinding };
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

async function assertEvidenceJournalProvenance(root, run, records, journal, { ignoreEvidenceId = null } = {}) {
  if (ignoreEvidenceId !== null) validateRecordId(ignoreEvidenceId, "ignored evidence");
  const runCreated = journal.filter((entry) => entry.event === "run.created");
  const protocolMarkers = [
    run.contract.evidenceAdmissionProtocolVersion,
    run.manifest.evidenceAdmissionProtocolVersion,
    runCreated.length === 1 ? runCreated[0].evidenceAdmissionProtocolVersion : undefined
  ];
  const presentProtocolMarkers = protocolMarkers.filter((value) => value !== undefined);
  let requiredProtocolVersion = null;
  if (presentProtocolMarkers.length > 0) {
    if (
      runCreated.length !== 1 ||
      presentProtocolMarkers.length !== protocolMarkers.length ||
      presentProtocolMarkers.some((value) => value !== EVIDENCE_ADMISSION_PROTOCOL_VERSION) ||
      run.manifest.contractDigest !== digestObject(run.contract)
    ) {
      throw new Error("Evidence admission protocol run-history binding is inconsistent");
    }
    requiredProtocolVersion = EVIDENCE_ADMISSION_PROTOCOL_VERSION;
  } else if (run.manifest.contractDigest !== digestObject(run.contract)) {
    throw new Error("Legacy evidence admission contract binding is inconsistent");
  }
  const relevantRecords = records.filter((record) => record.id !== ignoreEvidenceId);
  const intents = (await listIdentityBoundJsonRecords(
    root,
    safeJoin(run.runDir, "evidence-admissions"),
    "Evidence admission"
  )).filter((intent) => intent.id !== ignoreEvidenceId);
  const admissionEvents = journal.filter((entry) => (
    [EVIDENCE_ADMISSION_PENDING_EVENT, "evidence.added"].includes(entry.event) &&
    entry.evidenceId !== ignoreEvidenceId
  ));
  for (const entry of admissionEvents) {
    validateRecordId(entry.evidenceId, "evidence admission journal");
  }
  const recordsById = new Map(relevantRecords.map((record) => [record.id, record]));
  const intentsById = new Map(intents.map((intent) => [intent.id, intent]));
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
  const added = admissionEvents.filter((entry) => entry.event === "evidence.added");
  const pending = admissionEvents.filter((entry) => entry.event === EVIDENCE_ADMISSION_PENDING_EVENT);
  const addedIds = new Set(added.map((entry) => entry.evidenceId));
  const protocolRecordIds = new Set(relevantRecords
    .filter((record) => record.admissionProtocolVersion === EVIDENCE_ADMISSION_PROTOCOL_VERSION)
    .map((record) => record.id));
  if (
    requiredProtocolVersion === EVIDENCE_ADMISSION_PROTOCOL_VERSION &&
    protocolRecordIds.size !== relevantRecords.length
  ) {
    throw new Error("Evidence admission protocol downgrade is forbidden by run history");
  }
  const protocolAdded = added.filter((entry) => entry.protocolVersion !== undefined);
  const protocolPendingIds = new Set(pending.map((entry) => entry.evidenceId));
  const sameSet = (left, right) => (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
  if (
    added.length !== relevantRecords.length ||
    !sameSet(addedIds, new Set(recordsById.keys())) ||
    intents.length !== protocolRecordIds.size ||
    !sameSet(new Set(intentsById.keys()), protocolRecordIds) ||
    pending.length !== protocolRecordIds.size ||
    !sameSet(protocolPendingIds, protocolRecordIds) ||
    protocolAdded.length !== protocolRecordIds.size ||
    protocolAdded.some((entry) => (
      entry.protocolVersion !== EVIDENCE_ADMISSION_PROTOCOL_VERSION ||
      !protocolRecordIds.has(entry.evidenceId)
    ))
  ) {
    throw new Error("Evidence admission journal and file inventory are not bijective");
  }
  const bindings = new Map();
  for (const record of relevantRecords) {
    try {
      bindings.set(record.id, evidenceAdmissionJournalBinding(record, journal, {
        intent: intentsById.get(record.id) ?? null,
        runId: run.manifest.runId,
        requiredProtocolVersion
      }));
    } catch (error) {
      const label = record.stale === true ? "stale" : "admission";
      throw new Error(`Evidence ${label} provenance is invalid: ${record.id ?? "unknown"}: ${error.message}`);
    }
  }
  for (const record of relevantRecords) {
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

async function loadReviewEvidenceSupersessions(root, run, records) {
  const directory = safeJoin(run.runDir, REVIEW_EVIDENCE_SUPERSESSION_DIRECTORY);
  const journal = await readJournalRecords(root, run.runDir);
  await assertEvidenceJournalProvenance(root, run, records, journal);
  const supersessions = await listIdentityBoundJsonRecords(root, directory, "Review evidence supersession");
  const journalEntries = journal.filter((entry) => entry.event === REVIEW_EVIDENCE_SUPERSESSION_EVENT);
  if (supersessions.length === 0 && journalEntries.length === 0) {
    return { records: [], supersededIds: new Set(), journal };
  }
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const validated = [];
  const supersededIds = new Set();
  const replacementIds = new Set();
  for (const supersession of supersessions) {
    const result = await validateReviewEvidenceSupersessionRecord(root, run, recordsById, journal, supersession);
    const targetId = result.record.supersededEvidence.id;
    const replacementId = result.record.replacementEvidence.id;
    if (supersededIds.has(targetId) || replacementIds.has(replacementId)) {
      throw new Error("Review evidence supersession is duplicated or conflicting");
    }
    if (replacementIds.has(targetId) || supersededIds.has(replacementId)) {
      throw new Error("Review evidence supersession chains or cycles are forbidden");
    }
    supersededIds.add(targetId);
    replacementIds.add(replacementId);
    validated.push(result.record);
  }
  if (journalEntries.length !== validated.length) {
    throw new Error("Review evidence supersession journal contains an unbound event");
  }
  return { records: validated, supersededIds, journal };
}

function mergeEvidenceSupersessionStates(provider, review) {
  const records = [...provider.records, ...review.records];
  const supersededIds = new Set();
  const replacementIds = new Set();
  for (const supersession of records) {
    const targetId = supersession.supersededEvidence.id;
    const replacementId = supersession.replacementEvidence.id;
    if (
      supersededIds.has(targetId) ||
      replacementIds.has(targetId) ||
      supersededIds.has(replacementId) ||
      replacementIds.has(replacementId)
    ) {
      throw new Error("Evidence supersession is duplicated or conflicting across lifecycles");
    }
    supersededIds.add(targetId);
    replacementIds.add(replacementId);
  }
  return { records, supersededIds, replacementIds };
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
    const usesCanonicalAdmissionProtocol = (
      journal.some((entry) => (
        entry.event === EVIDENCE_ADMISSION_PENDING_EVENT ||
        (entry.event === "evidence.added" && entry.protocolVersion !== undefined)
      )) ||
      await pathExists(safeJoin(run.runDir, "evidence-admissions"))
    );
    if (usesCanonicalFreshnessProtocol || usesCanonicalAdmissionProtocol) {
      await assertEvidenceJournalProvenance(root, run, records, journal);
    }
    return { records, supersessions: [] };
  }
  const providerSupersessions = await loadEvidenceSupersessions(root, run, records);
  const reviewSupersessions = await loadReviewEvidenceSupersessions(root, run, records);
  const { records: supersessions, supersededIds } = mergeEvidenceSupersessionStates(
    providerSupersessions,
    reviewSupersessions
  );
  return {
    records: records.filter((record) => !supersededIds.has(record.id)),
    supersessions
  };
}

async function currentEvidenceSupersessionFreshnessDigest(root, run) {
  const evidence = await listIdentityBoundJsonRecords(root, safeJoin(run.runDir, "evidence"), "Evidence");
  const supersessionState = mergeEvidenceSupersessionStates(
    await loadEvidenceSupersessions(root, run, evidence),
    await loadReviewEvidenceSupersessions(root, run, evidence)
  );
  const recordsById = new Map(evidence.map((record) => [record.id, record]));
  const projection = [];
  for (const supersession of supersessionState.records) {
    for (const role of ["supersededEvidence", "replacementEvidence"]) {
      const binding = supersession[role];
      const record = recordsById.get(binding.id);
      const reviewTargetInvalidated = (
        supersession.kind === REVIEW_EVIDENCE_SUPERSESSION_KIND &&
        role === "supersededEvidence"
      );
      const freshness = reviewTargetInvalidated ? null : await currentEvidenceFreshness(run, record);
      if (freshness?.stale) {
        throw new Error(`Action token denied by stale immutable supersession evidence: ${record.id}`);
      }
      projection.push({
        supersessionId: supersession.id,
        supersessionDigest: digestObject(supersession),
        role,
        evidenceId: record.id,
        evidenceDigest: digestObject(record),
        freshnessProjectionDigest: freshness?.projectionDigest ?? null,
        invalidated: reviewTargetInvalidated
      });
    }
  }
  return digestObject(projection);
}

function stableSentinelRecordDigest(sentinel) {
  if (!sentinel || typeof sentinel !== "object" || Array.isArray(sentinel)) {
    throw new Error("Source sentinel record is malformed");
  }
  const { checkedAt: _checkedAt, ...stable } = sentinel;
  return digestObject(stable);
}

async function actionSourceAuthoritySnapshot(root, runDir, manifest, state, evidenceGateProjection) {
  const sourceBinding = manifest.sourceBinding ?? null;
  if (sourceBinding === null) {
    return { schemaVersion: 1, sourceBinding: null, sourceSentinel: null };
  }
  if (
    sourceBinding.schemaVersion !== 3 ||
    !SHA256_DIGEST.test(sourceBinding.digest ?? "") ||
    evidenceGateProjection?.sourceBindingDigest !== sourceBinding.digest
  ) {
    throw new Error("Action source authority snapshot is not bound to the evidence gate");
  }
  const label = state.lastSentinel?.label;
  if (!SAFE_ID.test(label ?? "")) {
    return { schemaVersion: 1, sourceBinding: structuredClone(sourceBinding), sourceSentinel: null };
  }
  const target = safeJoin(runDir, "sentinels", `${label}.json`);
  if (!(await pathExists(target))) {
    return { schemaVersion: 1, sourceBinding: structuredClone(sourceBinding), sourceSentinel: null };
  }
  const sentinel = await readJson(root, target);
  if (
    sentinel.complete !== true ||
    sentinel.digest !== state.lastSentinel.digest ||
    sentinel.digest !== evidenceGateProjection?.sourceSentinelDigest
  ) {
    throw new Error("Action source sentinel snapshot is stale or incomplete");
  }
  return {
    schemaVersion: 1,
    sourceBinding: structuredClone(sourceBinding),
    sourceSentinel: {
      label,
      digest: sentinel.digest,
      recordDigest: stableSentinelRecordDigest(sentinel)
    }
  };
}

function providerActionMutationPath(record, sourceMutation) {
  const key = `${record.action}:${record.provider}`;
  if (!PROVIDER_ACTION_SOURCE_MUTATIONS.has(key)) {
    throw new Error("Provider action is not allowed to transition source authority");
  }
  const candidate = sourceMutation?.path;
  if (
    typeof candidate !== "string" || !candidate || candidate.includes("\\") ||
    /[\0\r\n\t]/.test(candidate) || path.posix.isAbsolute(candidate) ||
    path.posix.normalize(candidate) !== candidate || candidate === ".." || candidate.startsWith("../")
  ) {
    throw new Error("Provider action source mutation path is unsafe");
  }
  if (record.action === "recipe.promote") {
    const expected = ".codex/better-workflows/config.json";
    if (candidate !== expected) {
      throw new Error("Recipe promotion may only transition the workspace recipe config");
    }
    return candidate;
  }
  const resource = /^artifact:([^:]+):([^:]+):(.+)$/.exec(record.resource ?? "");
  if (!resource || resource[3] !== candidate) {
    throw new Error("Artifact promotion source mutation path is not resource-bound");
  }
  const components = candidate.toLowerCase().split("/");
  const authorityFiles = new Set([".git", ".gitattributes", ".gitignore", ".gitmodules"]);
  const foldedCandidate = candidate.toLowerCase();
  if (
    components.some((component) => authorityFiles.has(component)) ||
    foldedCandidate === ".codex/better-workflows" ||
    foldedCandidate.startsWith(".codex/better-workflows/")
  ) {
    throw new Error("Artifact promotion cannot mutate Git authority or reserved recipe state");
  }
  return candidate;
}

function sentinelPathBinding(sentinel, relativePath) {
  for (const collection of [sentinel.scopeDigest, sentinel.untracked]) {
    if ((collection?.skipped ?? []).some((item) => item.path === relativePath)) {
      throw new Error("Provider action source mutation path is outside complete sentinel coverage");
    }
  }
  const matches = [
    ...(sentinel.scopeDigest?.records ?? [])
      .filter((item) => item.path === relativePath)
      .map((record) => ({ surface: "tracked", record })),
    ...(sentinel.untracked?.records ?? [])
      .filter((item) => item.path === relativePath)
      .map((record) => ({ surface: "untracked", record }))
  ];
  if (matches.length > 1) {
    throw new Error("Provider action source mutation path has ambiguous sentinel coverage");
  }
  return matches[0] ?? null;
}

function normalizedSentinelOutsidePath(sentinel, relativePath) {
  const normalizeCollection = (collection) => ({
    records: (collection?.records ?? []).filter((item) => item.path !== relativePath),
    skipped: (collection?.skipped ?? []).filter((item) => item.path !== relativePath),
    complete: collection?.complete === true
  });
  const {
    checkedAt: _checkedAt,
    complete: _complete,
    digest: _digest,
    skipped: _skipped,
    statusDigest: _statusDigest,
    scopeDigest,
    untracked,
    ...stable
  } = sentinel;
  return {
    ...stable,
    scopeDigest: normalizeCollection(scopeDigest),
    untracked: normalizeCollection(untracked)
  };
}

function parsePorcelainV2Entries(stdout) {
  if (typeof stdout !== "string") throw new Error("Git status returned non-text output");
  const parts = stdout.split("\0");
  if (parts.at(-1) === "") parts.pop();
  const entries = [];
  const pathAfterFields = (record, fieldCount) => {
    let separator = -1;
    for (let count = 0; count < fieldCount; count += 1) {
      separator = record.indexOf(" ", separator + 1);
      if (separator < 0) throw new Error("Git status returned a malformed porcelain record");
    }
    return record.slice(separator + 1);
  };
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (!record) throw new Error("Git status returned an empty porcelain record");
    const type = record[0];
    if (type === "1") {
      entries.push({ type, paths: [pathAfterFields(record, 8)], parts: [record] });
    } else if (type === "u") {
      entries.push({ type, paths: [pathAfterFields(record, 10)], parts: [record] });
    } else if (type === "2") {
      const original = parts[index + 1];
      if (original === undefined) {
        throw new Error("Git status returned a malformed rename record");
      }
      entries.push({ type, paths: [pathAfterFields(record, 9), original], parts: [record, original] });
      index += 1;
    } else if (["?", "!"].includes(type) && record[1] === " ") {
      entries.push({ type, paths: [record.slice(2)], parts: [record] });
    } else {
      throw new Error("Git status returned an unsupported porcelain record");
    }
  }
  return entries;
}

function statusDigestOutsideMutation(stdout, relativePath, expectedType) {
  const entries = parsePorcelainV2Entries(stdout);
  const matches = entries.filter((entry) => entry.paths.includes(relativePath));
  if (
    matches.length !== 1 || matches[0].type !== expectedType ||
    matches[0].paths.length !== 1 || matches[0].paths[0] !== relativePath
  ) {
    throw new Error("Provider action source mutation does not have one exact Git status record");
  }
  const remaining = entries.filter((entry) => entry !== matches[0]);
  const normalized = remaining.length > 0
    ? `${remaining.flatMap((entry) => entry.parts).join("\0")}\0`
    : "";
  return sha256(normalized);
}

function comparableSourceBinding(sourceBinding) {
  const {
    digest: _digest,
    worktreeClean: _worktreeClean,
    worktreeStatusDigest: _worktreeStatusDigest,
    ...stable
  } = sourceBinding;
  return stable;
}

function validateRecipeConfigMutation(sourceMutation, beforeBinding, afterBinding) {
  assertExactObjectKeys(
    sourceMutation.recipeConfig,
    new Set(["before", "after"]),
    "Recipe promotion config transition"
  );
  const before = sourceMutation.recipeConfig.before;
  const after = sourceMutation.recipeConfig.after;
  const keys = new Set(["schemaVersion", "enabled", "artifactRetentionDays", "workspaceArtifactCapBytes"]);
  assertExactObjectKeys(before, keys, "Recipe promotion prior config");
  assertExactObjectKeys(after, keys, "Recipe promotion current config");
  if (
    before.schemaVersion !== 1 || after.schemaVersion !== 1 ||
    before.enabled !== false || after.enabled !== true ||
    !Number.isInteger(before.artifactRetentionDays) ||
    !Number.isInteger(before.workspaceArtifactCapBytes) ||
    digestObject({ ...before, enabled: true }) !== digestObject(after)
  ) {
    throw new Error("Recipe promotion config transition is not the exact enabled false-to-true mutation");
  }
  const beforeBytes = Buffer.from(`${JSON.stringify(before, null, 2)}\n`);
  const afterBytes = Buffer.from(`${JSON.stringify(after, null, 2)}\n`);
  if (
    beforeBinding?.surface !== "tracked" || afterBinding?.surface !== "tracked" ||
    beforeBinding.record?.type !== "file" || afterBinding.record?.type !== "file" ||
    beforeBinding.record.digest !== sha256(beforeBytes) || beforeBinding.record.size !== beforeBytes.length ||
    afterBinding.record.digest !== sha256(afterBytes) || afterBinding.record.size !== afterBytes.length
  ) {
    throw new Error("Recipe promotion config bytes are not sentinel-bound");
  }
}

async function loadActionBaselineSentinel(root, run, record) {
  const authority = record.sourceAuthorityAtIssue;
  const binding = authority?.sourceSentinel;
  if (
    authority?.schemaVersion !== 1 || authority.sourceBinding?.schemaVersion !== 3 ||
    !SHA256_DIGEST.test(authority.sourceBinding?.digest ?? "") ||
    !binding || !SAFE_ID.test(binding.label ?? "") ||
    binding.digest !== record.treeDigest || !SHA256_DIGEST.test(binding.recordDigest ?? "")
  ) {
    throw new Error("Provider action source transition lacks immutable issued source authority");
  }
  const sentinel = await readJson(root, safeJoin(run.runDir, "sentinels", `${binding.label}.json`));
  if (
    sentinel.complete !== true || sentinel.digest !== binding.digest ||
    stableSentinelRecordDigest(sentinel) !== binding.recordDigest
  ) {
    throw new Error("Provider action issued source sentinel was replaced or is incomplete");
  }
  return { authority, binding, sentinel };
}

async function validateProviderActionSourceMutation(root, run, record, providerReceipt) {
  const sourceMutation = providerReceipt.sourceMutation;
  const expectedKeys = new Set([
    "schemaVersion", "kind", "actionAttemptId", "action", "provider", "resource",
    "path", "sourceBinding", "sentinel", "pathTransition",
    ...(record.action === "recipe.promote" ? ["recipeConfig"] : [])
  ]);
  assertExactObjectKeys(sourceMutation, expectedKeys, "Provider action source mutation");
  if (
    sourceMutation.schemaVersion !== PROVIDER_ACTION_SOURCE_MUTATION_SCHEMA_VERSION ||
    sourceMutation.kind !== "provider-action" ||
    sourceMutation.actionAttemptId !== record.attemptId ||
    sourceMutation.action !== record.action || sourceMutation.provider !== record.provider ||
    sourceMutation.resource !== record.resource
  ) {
    throw new Error("Provider action source mutation identity is invalid");
  }
  const relativePath = providerActionMutationPath(record, sourceMutation);
  const baseline = await loadActionBaselineSentinel(root, run, record);
  if (
    record.evidenceGateProjection?.sourceBindingDigest !== baseline.authority.sourceBinding.digest ||
    record.evidenceGateProjection?.sourceSentinelDigest !== baseline.sentinel.digest
  ) {
    throw new Error("Provider action source transition is not bound to the issued evidence projection");
  }
  const {
    captureSentinel,
    captureSourceBinding,
    normalizeSourceBindingWorktreeStatus,
    runSourceGit
  } = await import("./git.mjs");
  const currentSentinel = await captureSentinel(run.manifest.cwd, run.contract, await loadDefaults());
  const currentSourceBinding = await captureSourceBinding(run.manifest.cwd, {
    baseRevision: baseline.authority.sourceBinding.baseRevision,
    requireClean: false
  });
  if (!currentSourceBinding || currentSentinel.complete !== true) {
    throw new Error("Provider action current source authority is unavailable or incomplete");
  }
  const [sentinelStatus, sourceBindingStatus] = await Promise.all([
    runSourceGit(run.manifest.cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    runSourceGit(run.manifest.cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored"])
  ]);
  const normalizedSourceBindingStatus = await normalizeSourceBindingWorktreeStatus(
    run.manifest.cwd,
    sourceBindingStatus.stdout
  );
  if (
    sha256(sentinelStatus.stdout) !== currentSentinel.statusDigest ||
    sha256(normalizedSourceBindingStatus) !== currentSourceBinding.worktreeStatusDigest
  ) {
    throw new Error("Provider action source changed during transition verification");
  }
  const expectedStatusType = record.action === "recipe.promote" ? "1" : "?";
  if (
    statusDigestOutsideMutation(sentinelStatus.stdout, relativePath, expectedStatusType) !== baseline.sentinel.statusDigest ||
    statusDigestOutsideMutation(normalizedSourceBindingStatus, relativePath, expectedStatusType) !==
      baseline.authority.sourceBinding.worktreeStatusDigest
  ) {
    throw new Error("Provider action source mutation includes undeclared Git status drift");
  }
  if (
    digestObject(normalizedSentinelOutsidePath(baseline.sentinel, relativePath)) !==
      digestObject(normalizedSentinelOutsidePath(currentSentinel, relativePath)) ||
    digestObject(comparableSourceBinding(baseline.authority.sourceBinding)) !==
      digestObject(comparableSourceBinding(currentSourceBinding))
  ) {
    throw new Error("Provider action source mutation changed authority outside its declared path");
  }
  const beforePath = sentinelPathBinding(baseline.sentinel, relativePath);
  const afterPath = sentinelPathBinding(currentSentinel, relativePath);
  assertExactObjectKeys(sourceMutation.sourceBinding, new Set(["from", "to", "headRevision"]), "Provider action source binding transition");
  assertExactObjectKeys(sourceMutation.sentinel, new Set(["from", "to"]), "Provider action sentinel transition");
  assertExactObjectKeys(sourceMutation.pathTransition, new Set(["before", "after"]), "Provider action path transition");
  if (
    sourceMutation.sourceBinding.from !== baseline.authority.sourceBinding.digest ||
    sourceMutation.sourceBinding.to !== currentSourceBinding.digest ||
    sourceMutation.sourceBinding.headRevision !== currentSourceBinding.headRevision ||
    sourceMutation.sentinel.from !== baseline.sentinel.digest ||
    sourceMutation.sentinel.to !== currentSentinel.digest ||
    digestObject(sourceMutation.pathTransition.before) !== digestObject(beforePath) ||
    digestObject(sourceMutation.pathTransition.after) !== digestObject(afterPath) ||
    baseline.authority.sourceBinding.headRevision !== currentSourceBinding.headRevision ||
    currentSourceBinding.digest === baseline.authority.sourceBinding.digest ||
    currentSentinel.digest === baseline.sentinel.digest
  ) {
    throw new Error("Provider action source mutation receipt does not match the exact live transition");
  }
  if (record.action === "recipe.promote") {
    validateRecipeConfigMutation(sourceMutation, beforePath, afterPath);
  } else if (
    beforePath !== null || afterPath?.surface !== "untracked" ||
    afterPath.record?.type !== "file" ||
    afterPath.record.digest !== providerReceipt.digest
  ) {
    throw new Error("Artifact promotion must create one exact untracked artifact file");
  }
  return {
    descriptor: sourceMutation,
    descriptorDigest: digestObject(sourceMutation),
    relativePath,
    baselineSourceBinding: baseline.authority.sourceBinding,
    currentSourceBinding,
    baselineSentinel: baseline.sentinel,
    currentSentinel,
    baselineSentinelRecordDigest: baseline.binding.recordDigest,
    currentSentinelRecordDigest: stableSentinelRecordDigest(currentSentinel)
  };
}

async function assertFrozenProviderActionEvidenceGate(root, runId, run, record, context) {
  const projection = record.evidenceGateProjection;
  if (
    !projection || digestObject(projection) !== record.evidenceGateDigest ||
    projection.runId !== runId || projection.action !== record.action ||
    projection.contractDigest !== digestObject(run.contract) ||
    projection.authorityDigest !== digestObject(run.contract.authority ?? null) ||
    projection.policyDigest !== canonicalEvidencePolicyDigest(run.contract) ||
    projection.remoteRevision !== (run.contract.remoteRevision ?? null) ||
    projection.workflowVersion !== VERSION
  ) {
    throw new Error(`${context} denied because the issued evidence projection is malformed`);
  }
  const effective = await loadEffectiveEvidenceState(root, runId, { run });
  const gateKinds = new Set(record.evidenceGate);
  const selected = effective.records
    .filter((item) => gateKinds.has(item.kind) && item.schemaVersion === 2 && item.typedAdmission && item.status === "complete" && item.stale !== true)
    .map((item) => ({ kind: item.kind, evidenceId: item.id, evidenceDigest: digestObject(item) }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.evidenceId.localeCompare(right.evidenceId));
  const expectedEvidence = (projection.evidence ?? [])
    .map((item) => ({ kind: item.kind, evidenceId: item.evidenceId, evidenceDigest: item.evidenceDigest }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.evidenceId.localeCompare(right.evidenceId));
  if (digestObject(selected) !== digestObject(expectedEvidence)) {
    throw new Error(`${context} denied because issued gate evidence changed after provider invocation`);
  }
  const supersessions = effective.supersessions
    .map((item) => ({ id: item.id, digest: digestObject(item) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (digestObject(supersessions) !== digestObject(projection.effectiveSupersessions ?? [])) {
    throw new Error(`${context} denied because evidence supersessions changed after provider invocation`);
  }
  const findings = (await listJsonRecords(root, safeJoin(run.runDir, "findings")))
    .filter((item) => ["P0", "P1"].includes(item.severity))
    .map((item) => {
      validateFinding(item);
      if (item.status === "open") throw new Error(`${context} denied by a post-invocation P0/P1 finding`);
      return { id: item.id, digest: digestObject(item) };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (digestObject(findings) !== digestObject(projection.findingInventory ?? [])) {
    throw new Error(`${context} denied because finding dispositions changed after provider invocation`);
  }
  return projection;
}

// Shared provenance semantics for an already identified live history prefix.
// The current authority reader still supplies its entire live history. The
// ordinary replay reader first proves its prefix is the sealed ISSUE anchor.
async function sourceHistoryProvenanceBinding(root, run, history, initialSourceBindingDigest) {
  const journal = history.length > 0 ? await readJournalRecords(root, run.runDir) : [];
  const actions = history.some((entry) => ["autonomous-commit", "governed-commit", "provider-action"].includes(entry?.kind))
    ? await listJsonRecords(root, safeJoin(run.runDir, "actions"))
    : [];
  const transitions = [];
  let prior = initialSourceBindingDigest;
  for (const entry of history) {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      entry.from !== prior || !SHA256_DIGEST.test(entry.to ?? "") ||
      !SHA.test(entry.headRevision ?? "") || !Number.isFinite(Date.parse(entry.at ?? ""))
    ) {
      throw new Error("Action token denied because source transition history is malformed");
    }
    if (entry.kind === "autonomous-commit") {
      const action = actions.find((candidate) => candidate.attemptId === entry.actionAttemptId);
      const journalEntry = journal.find((candidate) => (
        candidate.event === "source-binding.autonomous-commit" &&
        candidate.actionAttemptId === entry.actionAttemptId &&
        candidate.from === entry.from && candidate.to === entry.to &&
        candidate.headRevision === entry.headRevision
      ));
      if (
        !action || action.action !== "git.commit" || action.provider !== "git" ||
        action.status !== "spent" || action.outcome !== "success" ||
        action.sourceBindingTransition?.from !== entry.from ||
        action.sourceBindingTransition?.to !== entry.to ||
        action.sourceBindingTransition?.headRevision !== entry.headRevision ||
        !journalEntry
      ) {
        throw new Error("Action token denied because an autonomous source transition is not replay-valid");
      }
    } else if (entry.kind === "governed-commit") {
      const commitAction = actions.find((candidate) => candidate.attemptId === entry.actionAttemptId);
      const transition = commitAction?.sourceBindingTransition;
      const expectedHistory = transition
        ? {
            ...transition,
            reason: "governed-git-commit-reconciled",
            transitionDigest: digestObject(transition)
          }
        : null;
      const journalEntries = journal.filter((candidate) => (
        candidate.event === "source-binding.governed-commit" &&
        candidate.actionAttemptId === entry.actionAttemptId
      ));
      const beforeSentinelBinding = commitAction?.sourceAuthorityAtIssue?.sourceSentinel;
      const beforeSentinel = beforeSentinelBinding?.label
        ? await readJson(root, safeJoin(run.runDir, "sentinels", `${beforeSentinelBinding.label}.json`)).catch(() => null)
        : null;
      const afterSentinel = transition?.sourceSentinelLabel
        ? await readJson(root, safeJoin(run.runDir, "sentinels", `${transition.sourceSentinelLabel}.json`)).catch(() => null)
        : null;
      if (
        !commitAction || commitAction.action !== "git.commit" || commitAction.provider !== "git" ||
        commitAction.status !== "spent" || commitAction.outcome !== "success" ||
        !transition || digestObject(entry) !== digestObject(expectedHistory) ||
        transition.from !== entry.from || transition.to !== entry.to ||
        transition.headRevision !== entry.headRevision ||
        transition.providerReceiptDigest !== digestObject(commitAction.receipt?.providerReceipt ?? null) ||
        journalEntries.length !== 1 ||
        digestObject({ ...journalEntries[0], at: undefined, event: undefined, attemptId: undefined }) !==
          digestObject({ ...expectedHistory, at: undefined, reason: undefined }) ||
        !beforeSentinel || beforeSentinel.digest !== transition.sourceSentinelFrom ||
        stableSentinelRecordDigest(beforeSentinel) !== transition.sourceSentinelFromRecordDigest ||
        !afterSentinel || afterSentinel.digest !== transition.sourceSentinelTo ||
        stableSentinelRecordDigest(afterSentinel) !== transition.sourceSentinelToRecordDigest
      ) {
        throw new Error("Action token denied because a governed commit source transition is not replay-valid");
      }
    } else if (entry.kind === "provider-action") {
      const providerAction = actions.find((candidate) => candidate.attemptId === entry.actionAttemptId);
      const transition = providerAction?.sourceBindingTransition;
      const expectedHistory = transition
        ? {
            ...transition,
            reason: "governed-provider-action-reconciled",
            transitionDigest: digestObject(transition)
          }
        : null;
      const journalEntries = journal.filter((candidate) => (
        candidate.event === "source-binding.provider-action" &&
        candidate.actionAttemptId === entry.actionAttemptId
      ));
      const beforeSentinelBinding = providerAction?.sourceAuthorityAtIssue?.sourceSentinel;
      const beforeSentinel = beforeSentinelBinding?.label
        ? await readJson(root, safeJoin(run.runDir, "sentinels", `${beforeSentinelBinding.label}.json`)).catch(() => null)
        : null;
      const afterSentinel = transition?.sourceSentinelLabel
        ? await readJson(root, safeJoin(run.runDir, "sentinels", `${transition.sourceSentinelLabel}.json`)).catch(() => null)
        : null;
      if (
        !providerAction || providerAction.status !== "spent" || providerAction.outcome !== "success" ||
        !PROVIDER_ACTION_SOURCE_MUTATIONS.has(`${providerAction.action}:${providerAction.provider}`) ||
        !transition || digestObject(entry) !== digestObject(expectedHistory) ||
        transition.from !== entry.from || transition.to !== entry.to ||
        transition.headRevision !== entry.headRevision ||
        transition.providerReceiptDigest !== digestObject(providerAction.receipt?.providerReceipt ?? null) ||
        transition.sourceMutationDigest !== digestObject(providerAction.receipt?.providerReceipt?.sourceMutation ?? null) ||
        journalEntries.length !== 1 ||
        digestObject({ ...journalEntries[0], at: undefined, event: undefined, attemptId: undefined }) !==
          digestObject({ ...expectedHistory, at: undefined, reason: undefined }) ||
        !beforeSentinel || beforeSentinel.digest !== transition.sourceSentinelFrom ||
        stableSentinelRecordDigest(beforeSentinel) !== transition.sourceSentinelFromRecordDigest ||
        !afterSentinel || afterSentinel.digest !== transition.sourceSentinelTo ||
        stableSentinelRecordDigest(afterSentinel) !== transition.sourceSentinelToRecordDigest
      ) {
        throw new Error("Action token denied because a provider action source transition is not replay-valid");
      }
    } else {
      const journalEntry = journal.find((candidate) => (
        candidate.event === "source-binding.rebound" &&
        candidate.from === entry.from && candidate.to === entry.to &&
        candidate.headRevision === entry.headRevision && candidate.reason === entry.reason
      ));
      if (typeof entry.reason !== "string" || !entry.reason || !journalEntry) {
        throw new Error("Action token denied because a source rebind is not replay-valid");
      }
    }
    transitions.push({
      kind: entry.kind ?? "source-rebind",
      actionAttemptId: entry.actionAttemptId ?? null,
      action: entry.action ?? null,
      provider: entry.provider ?? null,
      resource: entry.resource ?? null,
      path: entry.path ?? null,
      from: entry.from,
      to: entry.to,
      headRevision: entry.headRevision,
      sourceSentinelFrom: entry.sourceSentinelFrom ?? null,
      sourceSentinelTo: entry.sourceSentinelTo ?? null,
      providerReceiptDigest: entry.providerReceiptDigest ?? null,
      sourceMutationDigest: entry.sourceMutationDigest ?? null,
      reason: entry.reason,
      at: entry.at,
      digest: digestObject(entry)
    });
    prior = entry.to;
  }
  return { transitions, reached: prior };
}

async function currentActionSourceAuthorityBinding(root, run, action) {
  const sourceBinding = run.manifest.sourceBinding ?? null;
  if (!sourceBinding) {
    if (run.manifest.initialSourceBindingDigest !== null && run.manifest.initialSourceBindingDigest !== undefined) {
      throw new Error("Action token denied because the initial source binding is malformed");
    }
    return {
      initialSourceBindingDigest: null,
      sourceBindingDigest: null,
      currentSourceBindingDigest: null,
      sourceTransitionDigest: digestObject([]),
      sourceTransitions: [],
      sourceSentinelDigest: run.state.lastSentinel?.digest ?? null
    };
  }
  if (
    sourceBinding.schemaVersion !== 3 ||
    !SHA256_DIGEST.test(sourceBinding.digest ?? "") ||
    run.state.lastSentinelVerified !== true ||
    run.state.lastSentinelComplete !== true ||
    !SHA256_DIGEST.test(run.state.lastSentinel?.digest ?? "")
  ) {
    throw new Error("Action token denied because current source authority is incomplete");
  }
  const { captureSentinel, captureSourceBinding } = await import("./git.mjs");
  const currentSourceBinding = await captureSourceBinding(run.manifest.cwd, {
    baseRevision: sourceBinding.baseRevision,
    requireClean: false
  });
  if (!currentSourceBinding) {
    throw new Error("Action token denied because the current source binding is unavailable");
  }
  if (currentSourceBinding.digest !== sourceBinding.digest) {
    if (action !== "git.commit") {
      throw new Error("Action token denied because the current source binding changed outside a governed transition");
    }
    if (
      currentSourceBinding.headRevision !== sourceBinding.headRevision ||
      digestObject(autonomousCommitSourceIdentity(currentSourceBinding)) !==
        digestObject(autonomousCommitSourceIdentity(sourceBinding))
    ) {
      throw new Error("Action token denied because a governed Git commit may change only staged source content before execution");
    }
  }
  const currentSentinel = await captureSentinel(run.manifest.cwd, run.contract, await loadDefaults());
  if (!currentSentinel.complete || currentSentinel.digest !== run.state.lastSentinel.digest) {
    throw new Error("Action token denied because the content-complete source sentinel changed");
  }

  const history = Array.isArray(run.manifest.sourceBindingHistory)
    ? run.manifest.sourceBindingHistory
    : [];
  const initialSourceBindingDigest = run.manifest.initialSourceBindingDigest ??
    history[0]?.from ?? sourceBinding.digest;
  if (initialSourceBindingDigest !== null && !SHA256_DIGEST.test(initialSourceBindingDigest)) {
    throw new Error("Action token denied because the initial source binding is malformed");
  }
  const { transitions, reached: prior } = await sourceHistoryProvenanceBinding(
    root, run, history, initialSourceBindingDigest
  );
  if (prior !== sourceBinding.digest) {
    throw new Error("Action token denied because source transition history does not reach the live source");
  }
  return {
    initialSourceBindingDigest,
    sourceBindingDigest: sourceBinding.digest,
    currentSourceBindingDigest: currentSourceBinding.digest,
    sourceTransitionDigest: digestObject(transitions),
    sourceTransitions: transitions,
    autonomySnapshotDigest: null,
    sourceSentinelDigest: currentSentinel.digest
  };
}

const ACTION_GATE_SOURCE_PROJECTION_FIELDS = new Set([
  "initialSourceBindingDigest",
  "sourceBindingDigest",
  "currentSourceBindingDigest",
  "sourceTransitionDigest",
  "sourceTransitions",
  "autonomySnapshotDigest",
  "sourceSentinelDigest"
]);

function actionEvidencePolicyProjection(projection) {
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) {
    throw new Error("Action evidence gate projection is missing");
  }
  return Object.fromEntries(
    Object.entries(projection).filter(([key]) => !ACTION_GATE_SOURCE_PROJECTION_FIELDS.has(key))
  );
}

export async function currentActionNonSourceAuthorityBinding(root, runId, run, action) {
  const configuredGate = run.contract.actionGates?.[action];
  if (!Array.isArray(configuredGate) || configuredGate.length === 0) {
    throw new Error(`No pre-action evidence gate is defined for: ${action}`);
  }
  const gateKinds = new Set(configuredGate);
  const effective = await loadEffectiveEvidenceState(root, runId, { run });
  const findingDispositionBinding = await currentFindingDispositionBinding(root, runId, run);
  const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
  const bindsStagedBatchPlan = action === "git.commit" && effective.records.some((item) => (
    item.kind === "commit-plan" &&
    item.receipt?.payload?.batchProtocol === GOVERNED_COMMIT_BATCH_PROTOCOL
  ));
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
      ...(bindsStagedBatchPlan
        ? { immutableEvidenceDigest: digestObject(evidenceImmutableProjection(record)) }
        : {}),
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
    remoteRevision: run.contract.remoteRevision ?? null,
    workflowVersion: VERSION,
    effectiveSupersessions: supersessions,
    findingDispositionDigest: findingDispositionBinding.digest,
    findingDispositions: findingDispositionBinding.dispositions,
    findingInventory: findingDispositionBinding.inventory,
    evidence: selected
  };
  return {
    configuredGate: [...configuredGate],
    digest: digestObject(projection),
    projection
  };
}

export async function currentActionEvidenceGateBinding(root, runId, run, action) {
  const policy = await currentActionNonSourceAuthorityBinding(root, runId, run, action);
  const sourceAuthority = await currentActionSourceAuthorityBinding(root, run, action);
  const evidenceSupersessionFreshnessDigest = await currentEvidenceSupersessionFreshnessDigest(root, run);
  const projection = {
    schemaVersion: policy.projection.schemaVersion,
    runId: policy.projection.runId,
    action: policy.projection.action,
    configuredGate: policy.projection.configuredGate,
    contractDigest: policy.projection.contractDigest,
    authorityDigest: policy.projection.authorityDigest,
    policyDigest: policy.projection.policyDigest,
    initialSourceBindingDigest: sourceAuthority.initialSourceBindingDigest,
    sourceBindingDigest: sourceAuthority.sourceBindingDigest,
    currentSourceBindingDigest: sourceAuthority.currentSourceBindingDigest,
    sourceTransitionDigest: sourceAuthority.sourceTransitionDigest,
    sourceTransitions: sourceAuthority.sourceTransitions,
    autonomySnapshotDigest: sourceAuthority.autonomySnapshotDigest ?? null,
    sourceSentinelDigest: sourceAuthority.sourceSentinelDigest,
    remoteRevision: policy.projection.remoteRevision,
    workflowVersion: policy.projection.workflowVersion,
    effectiveSupersessions: policy.projection.effectiveSupersessions,
    findingDispositionDigest: policy.projection.findingDispositionDigest,
    findingDispositions: policy.projection.findingDispositions,
    findingInventory: policy.projection.findingInventory,
    evidence: policy.projection.evidence
  };
  return {
    configuredGate: [...policy.configuredGate],
    digest: digestObject(projection),
    projection,
    policyDigest: policy.digest,
    policyProjection: policy.projection,
    evidenceSupersessionFreshnessDigest
  };
}

export async function assertSpentActionNonSourceAuthority(root, runId, run, record, context) {
  if (run.contract.schemaVersion !== 2) return null;
  const configuredGate = run.contract.actionGates?.[record.action];
  if (
    record.status !== "spent" || !record.attemptId ||
    !Array.isArray(configuredGate) || configuredGate.length === 0 ||
    !Array.isArray(record.evidenceGate) ||
    digestObject(record.evidenceGate) !== digestObject(configuredGate) ||
    !SHA256_DIGEST.test(record.evidenceGateDigest ?? "") ||
    !SHA256_DIGEST.test(record.evidenceSupersessionFreshnessDigest ?? "") ||
    digestObject(record.evidenceGateProjection ?? null) !== record.evidenceGateDigest
  ) {
    throw new Error(`${context} denied because the spent action evidence gate is unbound`);
  }
  const supersessionFreshnessDigest = await currentEvidenceSupersessionFreshnessDigest(root, run);
  if (supersessionFreshnessDigest !== record.evidenceSupersessionFreshnessDigest) {
    throw new Error(`${context} denied because immutable evidence freshness changed`);
  }
  const expectedPolicyProjection = actionEvidencePolicyProjection(record.evidenceGateProjection);
  const currentPolicy = await currentActionNonSourceAuthorityBinding(root, runId, run, record.action);
  if (currentPolicy.digest !== digestObject(expectedPolicyProjection)) {
    throw new Error(`${context} denied because non-source action authority changed`);
  }
  return currentPolicy;
}

const GOVERNED_COMMIT_ISSUED_PROOF_PROTOCOL = "GovernedCommitIssuedProofV1";
const GOVERNED_COMMIT_SUCCESS_REPLAY_PROTOCOL = "GovernedCommitSuccessReplayBindingV1";
const GOVERNED_COMMIT_SUCCESS_BOUND_EVENT = "action.governed-commit-success-bound";
const GOVERNED_COMMIT_REFRESH_EPOCH_PROTOCOL = "GovernedCommitDependencyRefreshEpochV1";

function governedCommitJournalMarked(entry) {
  return entry.event === GOVERNED_COMMIT_SUCCESS_BOUND_EVENT || Object.hasOwn(entry.cause ?? {}, "governedCommitEpoch") || [
    "governedCommitIssuedProofVersion", "governedCommitSuccessReplayVersion", "issuedProofDigest",
    "issuedActionDigest", "successReplayBindingDigest"
  ].some((key) => Object.hasOwn(entry, key));
}

function governedCommitActionMarked(record) {
  return ["governedCommitReplay", "governedCommitIssuedProof", "governedCommitSuccessReplay"]
    .some((key) => Object.hasOwn(record, key));
}

function governedCommitSourceState(state) {
  return {
    lastSentinel: structuredClone(state.lastSentinel ?? null),
    lastSentinelVerified: state.lastSentinelVerified === true,
    lastSentinelComplete: state.lastSentinelComplete === true
  };
}

function ordinaryGovernedCommit(record) {
  return record.action === "git.commit" && record.provider === "git" &&
    !record.commitBatchBinding && record.autonomyDecision?.decision !== "auto-approved";
}

function governedCommitProofBody(value) {
  const body = { ...value };
  delete body.proofDigest;
  return body;
}

function governedCommitSuccessBody(value) {
  const body = { ...value };
  delete body.bindingDigest;
  return body;
}

function governedCommitStableSentinelSnapshot(sentinel) {
  const { checkedAt: _checkedAt, ...stable } = sentinel;
  return structuredClone(stable);
}

function governedCommitEvidenceEvents(journal, evidenceId) {
  return journal.filter((entry) => (
    [EVIDENCE_ADMISSION_PENDING_EVENT, "evidence.added", EVIDENCE_FRESHNESS_EVENT].includes(entry.event) &&
    entry.evidenceId === evidenceId
  ));
}

function governedCommitGateInventory(records, gate) {
  const kinds = new Set(gate);
  return records.filter((item) => kinds.has(item.kind)).map((item) => ({
    id: item.id,
    kind: item.kind,
    immutableEvidenceDigest: digestObject(evidenceImmutableProjection(item))
  })).sort((left, right) => left.id.localeCompare(right.id));
}

async function captureGovernedCommitEvidenceSnapshot(root, run, record, journal, definitions) {
  if (record.schemaVersion !== 2 || !Number.isFinite(Date.parse(record.typedAdmission?.admittedAt ?? ""))) {
    throw new Error("Governed commit snapshot requires a complete typed admission time");
  }
  const intentPath = safeJoin(run.runDir, "evidence-admissions", `${record.id}.json`);
  const intent = await pathExists(intentPath) ? await readJson(root, intentPath) : null;
  const binding = evidenceAdmissionJournalBinding(record, journal, {
    intent, runId: run.manifest.runId,
    requiredProtocolVersion: run.manifest.evidenceAdmissionProtocolVersion ?? null
  });
  if (binding.pendingTransition) throw new Error("Governed commit proof cannot capture pending evidence freshness");
  const events = governedCommitEvidenceEvents(journal, record.id);
  return {
    evidenceId: record.id,
    evidenceDigest: digestObject(record),
    immutableEvidenceDigest: binding.immutableEvidenceDigest,
    definitionDigest: digestObject(definitions[record.kind]),
    record: structuredClone(record),
    admissionIntent: intent,
    admissionIntentDigest: digestObject(intent),
    provenanceEvents: events,
    provenanceDigest: digestObject(events)
  };
}

// A partial exclusive write is deliberately not recoverable as a grant. No
// token is returned until the file, action record and unique ISSUE event agree.
async function writeGovernedCommitIssuedProof(root, runDir, proof) {
  const directory = safeJoin(runDir, "action-issued-proofs");
  await assertNoSymlinkUnder(root, directory);
  await ensurePrivateDir(directory);
  await fsyncDirectory(runDir);
  const target = safeJoin(directory, `${proof.tokenHash}.json`);
  await assertNoSymlinkUnder(root, target);
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(proof, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(target, 0o400);
  await fsyncDirectory(directory);
}

async function prepareGovernedCommitIssuedProof(root, run, issuedAction) {
  if (run.contract.schemaVersion !== 2 || !ordinaryGovernedCommit(issuedAction) ||
      issuedAction.sourceAuthorityAtIssue?.sourceBinding?.schemaVersion !== 3 ||
      !SAFE_ID.test(issuedAction.sourceAuthorityAtIssue?.sourceSentinel?.label ?? "")) {
    throw new Error("Governed commit ISSUE proof requires a complete ordinary source authority");
  }
  for (const finding of await listJsonRecords(root, safeJoin(run.runDir, "findings"))) {
    validateFinding(finding);
    if (finding.status === "accepted-risk" && !Number.isFinite(Date.parse(finding.expiry))) {
      throw new Error("Governed commit ISSUE accepted-risk expiry is invalid");
    }
  }
  const { loadEvidenceContracts } = await import("./evidence.mjs");
  const definitions = await loadEvidenceContracts({ refresh: true });
  const records = await listIdentityBoundJsonRecords(root, safeJoin(run.runDir, "evidence"), "Evidence");
  const journal = await readJournalRecords(root, run.runDir);
  await assertEvidenceJournalProvenance(root, run, records, journal);
  const effective = await loadEffectiveEvidenceState(root, run.manifest.runId, { run });
  const gate = issuedAction.evidenceGateProjection;
  const closureIds = new Set([
    ...gate.evidence.map((item) => item.evidenceId),
    ...gate.findingDispositions.map((item) => item.evidenceId)
  ]);
  const closure = [];
  for (const evidenceId of [...closureIds].sort()) {
    const record = records.find((item) => item.id === evidenceId);
    if (!record) throw new Error(`Governed commit issued proof closure is missing: ${evidenceId}`);
    const snapshot = await captureGovernedCommitEvidenceSnapshot(root, run, record, journal, definitions);
    await assertCurrentEvidenceFreshness(run, record, "Governed commit ISSUE proof");
    const selected = gate.evidence.find((item) => item.evidenceId === evidenceId);
    if (selected && selected.evidenceDigest !== snapshot.evidenceDigest) {
      throw new Error("Governed commit ISSUE proof changed after the final gate");
    }
    closure.push(snapshot);
  }
  const body = {
    protocol: GOVERNED_COMMIT_ISSUED_PROOF_PROTOCOL,
    version: 1,
    runId: run.manifest.runId,
    tokenHash: issuedAction.tokenHash,
    attemptId: issuedAction.attemptId,
    issuedAction: structuredClone(issuedAction),
    issuedActionDigest: digestObject(issuedAction),
    contract: structuredClone(run.contract),
    contractDigest: digestObject(run.contract),
    authorityDigest: digestObject(run.contract.authority ?? null),
    policyDigest: canonicalEvidencePolicyDigest(run.contract),
    workflowVersion: VERSION,
    evidenceDefinitionVersion: 1,
    evidenceDefinitionsDigest: digestObject(definitions),
    sourceAuthority: structuredClone(issuedAction.sourceAuthorityAtIssue),
    sourceSentinelRecord: await readJson(root, safeJoin(run.runDir, "sentinels", `${issuedAction.sourceAuthorityAtIssue.sourceSentinel.label}.json`)),
    sourceStateAtIssue: governedCommitSourceState(run.state),
    sourceHistoryAnchor: structuredClone(run.manifest.sourceBindingHistory ?? []),
    sourceHistoryAnchorDigest: digestObject(run.manifest.sourceBindingHistory ?? []),
    gateInventory: governedCommitGateInventory(effective.records, issuedAction.evidenceGate),
    evidenceClosure: closure,
    effectiveSupersessions: structuredClone(gate.effectiveSupersessions),
    supersessionFreshnessDigest: issuedAction.evidenceSupersessionFreshnessDigest
  };
  return { ...body, proofDigest: digestObject(body) };
}

async function loadGovernedCommitIssuedProof(root, run, record) {
  const target = safeJoin(run.runDir, "action-issued-proofs", `${record.tokenHash}.json`);
  const journal = await readJournalRecords(root, run.runDir);
  const issues = journal.filter((entry) => entry.event === "action.issued" && (
    entry.tokenHash === record.tokenHash || entry.attemptId === record.attemptId
  ));
  const filePresent = await pathExists(target);
  const actionJournal = journal.filter((entry) => governedCommitAttemptEntry(entry, record));
  const marked = governedCommitActionMarked(record) || actionJournal.some(governedCommitJournalMarked);
  if (!filePresent && !marked) return null; // Legacy records keep the original strict path.
  if (!ordinaryGovernedCommit(record) || !filePresent || !marked || issues.length !== 1) {
    throw new Error("Governed commit ISSUE proof is missing, duplicated or detached");
  }
  const persisted = await readJson(root, safeJoin(run.runDir, "actions", `${record.tokenHash}.json`));
  if (digestObject(persisted) !== digestObject(record)) {
    throw new Error("Governed commit canonical persisted action changed");
  }
  const marker = record.governedCommitReplay;
  const reference = record.governedCommitIssuedProof;
  assertExactObjectKeys(marker, new Set(["protocol", "version"]), "Governed commit replay marker");
  assertExactObjectKeys(reference, new Set(["version", "proofDigest", "issuedActionDigest"]), "Governed commit ISSUE proof reference");
  const proof = await readJson(root, target);
  assertExactObjectKeys(proof, new Set([
    "protocol", "version", "runId", "tokenHash", "attemptId", "issuedAction", "issuedActionDigest",
    "contract", "contractDigest", "authorityDigest", "policyDigest", "workflowVersion", "evidenceDefinitionVersion",
    "evidenceDefinitionsDigest", "sourceAuthority", "sourceSentinelRecord", "sourceStateAtIssue", "sourceHistoryAnchor", "sourceHistoryAnchorDigest",
    "gateInventory", "evidenceClosure", "effectiveSupersessions", "supersessionFreshnessDigest", "proofDigest"
  ]), "Governed commit ISSUE proof");
  assertExactObjectKeys(proof.sourceStateAtIssue, new Set([
    "lastSentinel", "lastSentinelVerified", "lastSentinelComplete"
  ]), "Governed commit ISSUE source state");
  const issue = issues[0];
  const { loadEvidenceContracts } = await import("./evidence.mjs");
  if (marker.protocol !== GOVERNED_COMMIT_ISSUED_PROOF_PROTOCOL || marker.version !== 1 ||
      reference.version !== 1 || proof.protocol !== GOVERNED_COMMIT_ISSUED_PROOF_PROTOCOL || proof.version !== 1 ||
      proof.evidenceDefinitionVersion !== 1 || proof.workflowVersion !== VERSION ||
      proof.runId !== run.manifest.runId || proof.tokenHash !== record.tokenHash || proof.attemptId !== record.attemptId ||
      !SHA256_DIGEST.test(proof.proofDigest ?? "") || digestObject(governedCommitProofBody(proof)) !== proof.proofDigest ||
      reference.proofDigest !== proof.proofDigest || reference.issuedActionDigest !== proof.issuedActionDigest ||
      digestObject(proof.issuedAction) !== proof.issuedActionDigest ||
      proof.contractDigest !== digestObject(proof.contract) || proof.contractDigest !== digestObject(run.contract) ||
      proof.authorityDigest !== digestObject(run.contract.authority ?? null) ||
      proof.policyDigest !== canonicalEvidencePolicyDigest(run.contract) ||
      proof.evidenceDefinitionsDigest !== digestObject(await loadEvidenceContracts({ refresh: true })) ||
      proof.sourceHistoryAnchorDigest !== digestObject(proof.sourceHistoryAnchor) ||
      digestObject(proof.sourceAuthority) !== digestObject(proof.issuedAction.sourceAuthorityAtIssue) ||
      proof.sourceSentinelRecord?.complete !== true ||
      proof.sourceSentinelRecord?.digest !== proof.sourceAuthority.sourceSentinel?.digest ||
      stableSentinelRecordDigest(proof.sourceSentinelRecord) !== proof.sourceAuthority.sourceSentinel?.recordDigest ||
      proof.sourceStateAtIssue?.lastSentinel?.label !== proof.sourceAuthority.sourceSentinel?.label ||
      proof.sourceStateAtIssue?.lastSentinel?.digest !== proof.sourceAuthority.sourceSentinel?.digest ||
      proof.sourceStateAtIssue?.lastSentinelVerified !== true || proof.sourceStateAtIssue?.lastSentinelComplete !== true ||
      issue.governedCommitIssuedProofVersion !== 1 || issue.issuedProofDigest !== proof.proofDigest ||
      issue.issuedActionDigest !== proof.issuedActionDigest || issue.runId !== proof.runId ||
      issue.attemptId !== proof.attemptId || issue.tokenHash !== proof.tokenHash ||
      issue.action !== record.action || issue.provider !== record.provider || issue.resource !== record.resource) {
    throw new Error("Governed commit ISSUE proof version or durable binding changed");
  }
  if (proof.issuedAction.status !== "issued" || proof.issuedAction.outcome !== null ||
      !Array.isArray(proof.evidenceClosure) || !Array.isArray(proof.gateInventory) ||
      !Array.isArray(proof.sourceHistoryAnchor) || !Array.isArray(proof.effectiveSupersessions)) {
    throw new Error("Governed commit ISSUE proof shape is invalid");
  }
  assertGovernedCommitActionProjection(record, proof.issuedAction, journal);
  if (!["issued", "spent"].includes(record.status) ||
      (record.status === "issued" && record.outcome !== null) ||
      (record.status === "spent" && !["pending", "unknown", "failure", "success"].includes(record.outcome))) {
    throw new Error("Governed commit action status or outcome is unsupported");
  }
  if (record.status === "issued" && (record.receipt || record.sourceBindingTransition || record.governedCommitSuccessReplay)) {
    throw new Error("Governed commit ISSUE action contains an unissued success grant");
  }
  const consumed = journal.filter((entry) => entry.event === "action.consumed" && (
    entry.tokenHash === record.tokenHash || entry.attemptId === record.attemptId
  ));
  if (record.status === "spent" && (consumed.length !== 1 ||
      consumed[0].tokenHash !== record.tokenHash || consumed[0].attemptId !== record.attemptId ||
      consumed[0].governedCommitIssuedProofVersion !== 1 || consumed[0].issuedProofDigest !== proof.proofDigest)) {
    throw new Error("Governed commit spent action lacks its bound consumption journal");
  }
  if (record.status === "issued" && consumed.length !== 0) {
    throw new Error("Governed commit issued status contradicts its consumption journal");
  }
  const completed = journal.some((entry) => entry.event === "action.reconciled" &&
    entry.attemptId === record.attemptId && entry.outcome === "success");
  if ((record.governedCommitSuccessReplay || completed) && (record.status !== "spent" || record.outcome !== "success")) {
    throw new Error("Governed commit persisted success status was changed");
  }
  return proof;
}

// The issued projection is closed and presence-sensitive. Only fields written
// by these existing ordinary lifecycle boundaries may be added after ISSUE.
function assertGovernedCommitActionProjection(record, issued, journal) {
  const expected = new Set([...Object.keys(issued), "governedCommitIssuedProof"]);
  const mutable = new Set(["status", "outcome"]);
  if (record.status === "spent") expected.add("spentAt");
  if (record.status === "spent" && record.outcome !== "pending") {
    expected.add("receipt");
    expected.add("reconciledAt");
  }
  if (record.status === "spent" && record.outcome === "success") {
    expected.add("sourceBindingTransition");
    expected.add("governedCommitSuccessReplay");
  }
  const drifts = journal.filter((entry) => entry.event === "action.authority-drifted" && entry.attemptId === record.attemptId);
  if (drifts.length > 0) {
    expected.add("authorityFailure");
    if (digestObject(record.authorityFailure) !== drifts.at(-1).authorityFailureDigest) {
      throw new Error("Governed commit lifecycle authority failure was removed or rebound");
    }
  }
  assertExactObjectKeys(record, expected, "Governed commit closed action projection");
  for (const key of Object.keys(issued)) {
    if (!mutable.has(key) && digestObject(record[key]) !== digestObject(issued[key])) {
      throw new Error(`Governed commit immutable issued action changed: ${key}`);
    }
  }
  if (record.status === "spent" && !Number.isFinite(Date.parse(record.spentAt ?? ""))) {
    throw new Error("Governed commit spent boundary is invalid");
  }
  if (Object.hasOwn(record, "reconciledAt") && !Number.isFinite(Date.parse(record.reconciledAt ?? ""))) {
    throw new Error("Governed commit reconciliation boundary is invalid");
  }
}

async function assertGovernedCommitIssuedProofInventory(root, run, _actions) {
  const journal = await readJournalRecords(root, run.runDir);
  const directory = safeJoin(run.runDir, "actions");
  await assertNoSymlinkUnder(root, directory);
  const files = [];
  for (const name of (await readdir(directory)).filter((name) => name.endsWith(".json")).sort()) {
    files.push({ name, record: await readJson(root, safeJoin(directory, name)) });
  }
  const actions = files.map((item) => item.record);
  const proofDirectory = safeJoin(run.runDir, "action-issued-proofs");
  const proofTokens = new Set();
  if (await pathExists(proofDirectory)) {
    await assertNoSymlinkUnder(root, proofDirectory);
    for (const name of await readdir(proofDirectory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Governed commit ISSUE proof filename is invalid");
      const proof = await readJson(root, safeJoin(proofDirectory, name));
      if (name !== `${proof.tokenHash}.json` || proofTokens.has(proof.tokenHash) ||
          actions.filter((item) => item.tokenHash === proof.tokenHash).length !== 1) {
        throw new Error("Governed commit ISSUE proof is orphaned, duplicated or filename-rebound");
      }
      proofTokens.add(proof.tokenHash);
    }
  }
  const markedEntries = journal.filter(governedCommitJournalMarked);
  for (const entry of markedEntries) {
    const tokens = [entry.tokenHash, entry.cause?.governedCommitEpoch?.tokenHash].filter((value) => value !== undefined);
    const identities = [entry.attemptId, entry.actionAttemptId, entry.cause?.governedCommitEpoch?.attemptId].filter((value) => value !== undefined);
    const matches = actions.filter((item) => tokens.includes(item.tokenHash) || identities.includes(item.attemptId));
    if (matches.length !== 1 || tokens.some((value) => value !== matches[0].tokenHash) ||
        identities.some((value) => value !== matches[0].attemptId)) {
      throw new Error("Governed commit journal-only proof marker is orphaned or ambiguous");
    }
  }
  for (const { name, record } of files) {
    const covered = governedCommitActionMarked(record) || proofTokens.has(record.tokenHash) ||
      markedEntries.some((entry) => governedCommitAttemptEntry(entry, record));
    if (covered && (!SHA256_DIGEST.test(record.tokenHash ?? "") || !record.attemptId ||
        name !== `${record.tokenHash}.json` ||
        actions.filter((item) => item.tokenHash === record.tokenHash).length !== 1 ||
        actions.filter((item) => item.attemptId === record.attemptId).length !== 1)) {
      throw new Error("Governed commit canonical action filename, token or attempt identity changed");
    }
    await loadGovernedCommitIssuedProof(root, run, record);
  }
  return actions;
}

async function assertGovernedCommitEvidenceSnapshot(root, run, proof, snapshot, records, journal, binding, action) {
  const transition = binding.sourceTransition;
  assertExactObjectKeys(snapshot, new Set([
    "evidenceId", "evidenceDigest", "immutableEvidenceDigest", "definitionDigest", "record",
    "admissionIntent", "admissionIntentDigest", "provenanceEvents", "provenanceDigest"
  ]), "Governed commit evidence snapshot");
  const record = records.find((item) => item.id === snapshot.evidenceId);
  if (!record || snapshot.evidenceId !== snapshot.record?.id ||
      snapshot.provenanceDigest !== digestObject(snapshot.provenanceEvents) ||
      snapshot.admissionIntentDigest !== digestObject(snapshot.admissionIntent)) {
    throw new Error("Governed commit evidence snapshot or provenance reference changed");
  }
  const intentPath = safeJoin(run.runDir, "evidence-admissions", `${record.id}.json`);
  const intent = await pathExists(intentPath) ? await readJson(root, intentPath) : null;
  if (digestObject(intent) !== snapshot.admissionIntentDigest) {
    throw new Error(`Governed commit evidence admission intent changed: ${record.id}`);
  }
  const events = governedCommitEvidenceEvents(journal, record.id);
  if (digestObject(events.slice(0, snapshot.provenanceEvents.length)) !== snapshot.provenanceDigest) {
    throw new Error(`Governed commit issued evidence journal prefix changed: ${record.id}`);
  }
  evidenceAdmissionJournalBinding(snapshot.record, snapshot.provenanceEvents, {
    intent: snapshot.admissionIntent, runId: proof.runId,
    requiredProtocolVersion: snapshot.record.admissionProtocolVersion ?? null
  });
  evidenceAdmissionJournalBinding(record, journal, { intent, runId: proof.runId });
  const { assertGovernedCommitIssuedEvidenceV1 } = await import("./evidence.mjs");
  await assertGovernedCommitIssuedEvidenceV1(record, snapshot, proof, {
    ...run, root, requireReconciled: true
  });
  const freshness = await currentEvidenceFreshness(run, record);
  if (!freshness.expectedDependencies) throw new Error("Governed commit historical dependencies are malformed");
  const expected = { ...freshness.expectedDependencies };
  for (const [field, before, after] of [
    ["sourceBindingDigest", proof.sourceAuthority.sourceBinding?.digest, transition.to],
    ["sourceSentinelDigest", proof.sourceAuthority.sourceSentinel?.digest, transition.sourceSentinelTo]
  ]) {
    const issued = snapshot.record.dependencies?.[field] ?? null;
    if (issued !== null) {
      if (issued !== before || ![before, after].includes(expected[field])) {
        throw new Error(`Governed commit freshness is not explained by its source transition: ${record.id}`);
      }
      expected[field] = issued;
    }
  }
  if (digestObject(expected) !== digestObject(snapshot.record.dependencies ?? null)) {
    throw new Error(`Governed commit live non-source dependencies changed: ${record.id}`);
  }
  for (const entry of events.slice(snapshot.provenanceEvents.length)) {
    let epoch;
    try {
      epoch = assertGovernedCommitRefreshEpoch(run.runDir, proof, binding, action, journal, entry);
    } catch (error) {
      throw new Error(`Governed commit historical freshness change is unexplained: ${record.id}`, { cause: error });
    }
    const expectedAtEpoch = {
      ...freshness.expectedDependencies,
      sourceBindingDigest: snapshot.record.dependencies?.sourceBindingDigest == null
        ? null : epoch.observation.manifestSourceBinding.digest,
      sourceSentinelDigest: snapshot.record.dependencies?.sourceSentinelDigest == null
        ? null : epoch.observation.sourceState.lastSentinel.digest
    };
    const epochStale = digestObject(expectedAtEpoch) !== digestObject(snapshot.record.dependencies) ||
      (snapshot.record.dependencies?.sourceBindingDigest != null &&
        snapshot.record.dependencies.sourceBindingDigest !== epoch.actualSourceBinding.digest);
    const patch = entry.freshnessPatch;
    const reproduced = applyEvidenceFreshnessPatch(snapshot.record, patch);
    if (patch.stale !== epochStale || patch.currentDependencyFilesPresent !== true ||
        digestObject(patch.currentDependencyFiles) !== digestObject(freshness.currentDependencyFiles) ||
        patch.staleReasonPresent !== epochStale ||
        patch.staleReason !== (epochStale ? "dependency-freshness-check" : null) ||
        digestObject(entry.freshnessState) !== digestObject(evidenceFreshnessState(reproduced))) {
      throw new Error(`Governed commit historical freshness change is unexplained by its proven epoch: ${record.id}`);
    }
  }
  return record;
}

async function assertGovernedCommitLiveReplayAuthority(root, run, record, proof) {
  const gate = record.evidenceGateProjection;
  if (record.contractDigest !== digestObject(run.contract) ||
      digestObject(record.evidenceGate) !== digestObject(run.contract.actionGates?.["git.commit"]) ||
      digestObject(gate) !== record.evidenceGateDigest ||
      digestObject(gate) !== digestObject(proof.issuedAction.evidenceGateProjection)) {
    throw new Error("Governed commit live contract or issued gate changed");
  }
  const effective = await loadEffectiveEvidenceState(root, run.manifest.runId, { run });
  if (digestObject(governedCommitGateInventory(effective.records, record.evidenceGate)) !== digestObject(proof.gateInventory)) {
    throw new Error("Governed commit live gate inventory changed");
  }
  const supersessions = effective.supersessions.map((item) => ({ id: item.id, digest: digestObject(item) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (digestObject(supersessions) !== digestObject(proof.effectiveSupersessions) ||
      await currentEvidenceSupersessionFreshnessDigest(root, run) !== proof.supersessionFreshnessDigest) {
    throw new Error("Governed commit live immutable supersession freshness changed");
  }
  // Dispositions and accepted-risk expiry are live obligations. Their evidence
  // is captured in the ISSUE closure but is never revived by historical replay.
  const findings = await listJsonRecords(root, safeJoin(run.runDir, "findings"));
  for (const finding of findings) {
    validateFinding(finding);
    if (finding.status === "accepted-risk" && !Number.isFinite(Date.parse(finding.expiry))) {
      throw new Error("Governed commit live accepted-risk expiry is invalid");
    }
  }
  const disposition = await currentFindingDispositionBinding(root, run.manifest.runId, run);
  // Current disposition evidence has just passed the original live validator.
  // Its full digest can change only through the separately checked canonical
  // freshness chain; evidence identity and all non-source obligations stay pinned.
  const dispositionAuthority = (items) => items.map(({ evidenceDigest: _digest, ...binding }) => binding);
  if (digestObject(disposition.inventory) !== digestObject(gate.findingInventory) ||
      digestObject(dispositionAuthority(disposition.dispositions)) !== digestObject(dispositionAuthority(gate.findingDispositions)) ||
      disposition.digest !== digestObject(disposition.dispositions)) {
    throw new Error("Governed commit live finding disposition authority changed");
  }
}

async function prepareGovernedCommitSuccessReplayBinding(root, run, record, receipt, validation, transition, proof) {
  const journal = await readJournalRecords(root, run.runDir);
  const records = await listIdentityBoundJsonRecords(root, safeJoin(run.runDir, "evidence"), "Evidence");
  await assertEvidenceJournalProvenance(root, run, records, journal);
  const { loadEvidenceContracts, validateTypedEvidenceRecord } = await import("./evidence.mjs");
  const definitions = await loadEvidenceContracts({ refresh: true });
  const results = [];
  for (const evidenceId of [...receipt.evidenceIds].sort()) {
    const result = records.find((item) => item.id === evidenceId);
    if (!result) throw new Error("Governed commit success result evidence is missing");
    await validateTypedEvidenceRecord(result, { ...run, root, requireReconciled: false });
    await assertCurrentEvidenceFreshness(run, result, "Governed commit success result");
    results.push(await captureGovernedCommitEvidenceSnapshot(root, run, result, journal, definitions));
  }
  const body = {
    protocol: GOVERNED_COMMIT_SUCCESS_REPLAY_PROTOCOL,
    version: 1,
    runId: record.runId,
    tokenHash: record.tokenHash,
    attemptId: record.attemptId,
    issuedProofDigest: proof.proofDigest,
    receiptDigest: digestObject(receipt),
    providerReceiptDigest: digestObject(receipt.providerReceipt),
    providerExecutionId: receipt.providerReceipt.executionId,
    resultEvidence: results,
    sourceTransition: structuredClone(transition),
    sourceBindingTo: structuredClone(validation.currentSourceBinding),
    sourceSentinelTo: governedCommitStableSentinelSnapshot(validation.currentSentinel)
  };
  return { ...body, bindingDigest: digestObject(body) };
}

function governedCommitSuccessJournal(journal, record) {
  const entries = journal.filter((entry) => entry.event === GOVERNED_COMMIT_SUCCESS_BOUND_EVENT && (
    entry.attemptId === record.attemptId || entry.tokenHash === record.tokenHash
  ));
  if (entries.length > 1) throw new Error("Governed commit success binding journal is duplicated");
  return entries[0] ?? null;
}

function assertGovernedCommitSuccessBindingShape(binding, proof, record, receipt) {
  assertExactObjectKeys(binding, new Set([
    "protocol", "version", "runId", "tokenHash", "attemptId", "issuedProofDigest", "receiptDigest",
    "providerReceiptDigest", "providerExecutionId", "resultEvidence", "sourceTransition",
    "sourceBindingTo", "sourceSentinelTo", "bindingDigest"
  ]), "Governed commit success replay binding");
  if (binding.protocol !== GOVERNED_COMMIT_SUCCESS_REPLAY_PROTOCOL || binding.version !== 1 ||
      binding.runId !== record.runId || binding.tokenHash !== record.tokenHash || binding.attemptId !== record.attemptId ||
      binding.issuedProofDigest !== proof.proofDigest || binding.receiptDigest !== digestObject(receipt) ||
      binding.providerReceiptDigest !== digestObject(receipt.providerReceipt) ||
      binding.providerExecutionId !== receipt.providerReceipt.executionId ||
      !SHA256_DIGEST.test(binding.bindingDigest ?? "") ||
      digestObject(governedCommitSuccessBody(binding)) !== binding.bindingDigest ||
      !Array.isArray(binding.resultEvidence) || binding.resultEvidence.length !== receipt.evidenceIds.length ||
      new Set(binding.resultEvidence.map((item) => item.evidenceId)).size !== binding.resultEvidence.length ||
      digestObject(binding.resultEvidence.map((item) => item.evidenceId).sort()) !== digestObject([...receipt.evidenceIds].sort()) ||
      !Number.isFinite(Date.parse(binding.sourceTransition?.at ?? "")) ||
      binding.sourceBindingTo?.digest !== binding.sourceTransition?.to ||
      binding.sourceSentinelTo?.digest !== binding.sourceTransition?.sourceSentinelTo ||
      stableSentinelRecordDigest(binding.sourceSentinelTo) !== binding.sourceTransition?.sourceSentinelToRecordDigest) {
    throw new Error("Governed commit success replay binding changed or has an unsupported version");
  }
}

function assertGovernedCommitSuccessJournalBinding(entry, binding, record) {
  if (!entry || entry.version !== 1 || entry.attemptId !== record.attemptId || entry.tokenHash !== record.tokenHash ||
      entry.runId !== record.runId || entry.issuedProofDigest !== binding.issuedProofDigest ||
      entry.bindingDigest !== binding.bindingDigest || digestObject(entry.binding) !== digestObject(binding)) {
    throw new Error("Governed commit success replay lacks its durable journal binding");
  }
}

function governedCommitAttemptEntry(entry, record) {
  return [entry.tokenHash, entry.cause?.governedCommitEpoch?.tokenHash].filter((value) => value !== undefined).includes(record.tokenHash) ||
    [entry.attemptId, entry.actionAttemptId, entry.cause?.governedCommitEpoch?.attemptId].filter((value) => value !== undefined).includes(record.attemptId);
}

function governedCommitSuccessCompletion(journal, record, binding) {
  const entries = journal.filter((entry) => entry.event === "action.reconciled" &&
    governedCommitAttemptEntry(entry, record) && entry.outcome === "success");
  if (entries.length > 1) throw new Error("Governed commit success completion is duplicated");
  const completion = entries[0] ?? null;
  if (completion && (completion.attemptId !== record.attemptId || completion.tokenHash !== record.tokenHash ||
      completion.runId !== record.runId || completion.governedCommitSuccessReplayVersion !== 1 ||
      completion.issuedProofDigest !== binding.issuedProofDigest ||
      completion.successReplayBindingDigest !== binding.bindingDigest || completion.receiptDigest !== binding.receiptDigest ||
      completion.providerReceiptDigest !== binding.providerReceiptDigest)) {
    throw new Error("Governed commit success completion outcome, version or full binding changed");
  }
  if (journal.some((entry) => entry.event === "action.reconciled" && governedCommitAttemptEntry(entry, record) &&
      entry.outcome !== "success" && governedCommitJournalMarked(entry))) {
    throw new Error("Governed commit versioned success completion has a contradictory outcome");
  }
  return completion;
}

// Ordinary-only append identity includes outcome and every durable digest.
// Existing UNKNOWN history remains; the unrelated append-once helper is intact.
async function appendGovernedCommitSuccessCompletion(root, runDir, record, binding, details = {}) {
  const journal = await readJournalRecords(root, runDir);
  if (governedCommitSuccessCompletion(journal, record, binding)) return null;
  const sources = journal.filter((entry) => entry.event === "source-binding.governed-commit" &&
    governedCommitAttemptEntry(entry, record));
  if (sources.length !== 1) throw new Error("Governed commit completion lacks its unique source completion");
  const { event: _event, attemptId: sourceAttempt, ...sourceBody } = sources[0];
  const bound = governedCommitSuccessJournal(journal, record);
  assertGovernedCommitSuccessJournalBinding(bound, binding, record);
  if (sourceAttempt !== record.attemptId || journal.indexOf(sources[0]) <= journal.indexOf(bound) ||
      digestObject(sourceBody) !== digestObject({ ...binding.sourceTransition, transitionDigest: digestObject(binding.sourceTransition) })) {
    throw new Error("Governed commit success completion source binding or persistence order changed");
  }
  return appendJournal(root, runDir, "action.reconciled", {
    ...details,
    runId: record.runId,
    tokenHash: record.tokenHash,
    attemptId: record.attemptId,
    outcome: "success",
    governedCommitSuccessReplayVersion: 1,
    issuedProofDigest: binding.issuedProofDigest,
    successReplayBindingDigest: binding.bindingDigest,
    receiptDigest: binding.receiptDigest,
    providerReceiptDigest: binding.providerReceiptDigest
  });
}

// Pure structural classification of captured persistence observations. It never
// supplies a historical run to current freshness, authority or source readers.
function governedCommitPersistencePrefix(runDir, proof, binding, record, journal, observation) {
  assertExactObjectKeys(observation, new Set([
    "manifestSourceBinding", "sourceBindingHistory", "sourceState", "postSentinel"
  ]), "Governed commit persistence observation");
  assertExactObjectKeys(observation.sourceState, new Set([
    "lastSentinel", "lastSentinelVerified", "lastSentinelComplete"
  ]), "Governed commit source-state observation");
  const transition = binding.sourceTransition;
  const historyEntry = { ...transition, reason: "governed-git-commit-reconciled", transitionDigest: digestObject(transition) };
  const atAnchor = digestObject(observation.sourceBindingHistory) === proof.sourceHistoryAnchorDigest &&
    digestObject(observation.manifestSourceBinding) === digestObject(proof.sourceAuthority.sourceBinding);
  const atResult = digestObject(observation.sourceBindingHistory) === digestObject([...proof.sourceHistoryAnchor, historyEntry]) &&
    digestObject(observation.manifestSourceBinding) === digestObject(binding.sourceBindingTo);
  const stateAtAnchor = digestObject(observation.sourceState) === digestObject(proof.sourceStateAtIssue);
  const stateAtResult = digestObject(observation.sourceState) === digestObject({
    lastSentinel: {
      label: transition.sourceSentinelLabel,
      digest: transition.sourceSentinelTo,
      path: safeJoin(runDir, "sentinels", `${transition.sourceSentinelLabel}.json`)
    },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  });
  if ((!atAnchor && !atResult) || (!stateAtAnchor && !stateAtResult) || (atAnchor && !stateAtAnchor)) {
    throw new Error("Governed commit persistence source/history/state is missing, contradictory or reversed");
  }
  const postSentinelPresent = observation.postSentinel !== null;
  if ((atResult || stateAtResult) && !postSentinelPresent) {
    throw new Error("Governed commit persistence prefix lacks its post-source sentinel");
  }
  if (postSentinelPresent && (observation.postSentinel.complete !== true ||
      stableSentinelRecordDigest(observation.postSentinel) !== transition.sourceSentinelToRecordDigest ||
      stableSentinelRecordDigest(observation.postSentinel) !== stableSentinelRecordDigest(binding.sourceSentinelTo))) {
    throw new Error("Governed commit durable post-source sentinel changed");
  }
  const bound = governedCommitSuccessJournal(journal, record);
  assertGovernedCommitSuccessJournalBinding(bound, binding, record);
  const issues = journal.filter((entry) => entry.event === "action.issued" && governedCommitAttemptEntry(entry, record));
  const consumed = journal.filter((entry) => entry.event === "action.consumed" && governedCommitAttemptEntry(entry, record));
  if (issues.length !== 1 || consumed.length !== 1 ||
      journal.indexOf(issues[0]) >= journal.indexOf(consumed[0]) || journal.indexOf(consumed[0]) >= journal.indexOf(bound)) {
    throw new Error("Governed commit ISSUE/consume/prebinding persistence order changed");
  }
  const sources = journal.filter((entry) => entry.event === "source-binding.governed-commit" && governedCommitAttemptEntry(entry, record));
  const completion = governedCommitSuccessCompletion(journal, record, binding);
  const repairs = journal.filter((entry) => entry.event === "action.governed-commit-transition-repaired" && governedCommitAttemptEntry(entry, record));
  if (sources.length > 1 || repairs.length > 1) {
    throw new Error("Governed commit source or repair completion is duplicated");
  }
  if (sources.length === 1) {
    const { event: _event, attemptId: sourceAttempt, ...body } = sources[0];
    if (sourceAttempt !== record.attemptId || !atResult || !stateAtResult ||
        journal.indexOf(sources[0]) <= journal.indexOf(bound) ||
        digestObject(body) !== digestObject({ ...transition, transitionDigest: digestObject(transition) })) {
      throw new Error("Governed commit durable source completion is partial, reordered or rebound");
    }
  }
  if (completion && (sources.length !== 1 || !atResult || !stateAtResult ||
      journal.indexOf(completion) <= journal.indexOf(sources[0]))) {
    throw new Error("Governed commit durable success completion is partial or reordered");
  }
  if (repairs.length === 1 && (!completion || sources.length !== 1 || !atResult || !stateAtResult ||
      journal.indexOf(repairs[0]) <= journal.indexOf(completion) || repairs[0].attemptId !== record.attemptId ||
      repairs[0].governedCommitSuccessReplayVersion !== 1 || repairs[0].issuedProofDigest !== proof.proofDigest ||
      repairs[0].successReplayBindingDigest !== binding.bindingDigest || repairs[0].sourceBindingDigest !== transition.to)) {
    throw new Error("Governed commit existing repair lacks its complete, ordered success/source history");
  }
  const rank = repairs.length ? 6 : completion ? 5 : sources.length ? 4 : stateAtResult ? 3 : atResult ? 2 : postSentinelPresent ? 1 : 0;
  return { rank, name: ["action-success-anchor", "post-sentinel-only", "manifest-before-state", "state-before-source", "source-before-success", "success-before-repair", "repaired"][rank], completion };
}

async function captureGovernedCommitPersistenceObservation(root, run, binding) {
  const target = safeJoin(run.runDir, "sentinels", `${binding.sourceTransition.sourceSentinelLabel}.json`);
  return {
    manifestSourceBinding: structuredClone(run.manifest.sourceBinding),
    sourceBindingHistory: structuredClone(run.manifest.sourceBindingHistory ?? []),
    sourceState: governedCommitSourceState(run.state),
    postSentinel: await pathExists(target) ? await readJson(root, target) : null
  };
}

function governedCommitEpochBody(epoch) {
  const body = { ...epoch };
  delete body.epochDigest;
  return body;
}

function assertGovernedCommitRefreshEpoch(runDir, proof, binding, record, journal, entry) {
  assertExactObjectKeys(entry.cause, new Set(["kind", "governedCommitEpoch"]), "Governed commit dependency refresh cause");
  const epoch = entry.cause.governedCommitEpoch;
  assertExactObjectKeys(epoch, new Set([
    "protocol", "version", "runId", "tokenHash", "attemptId", "issuedProofDigest", "successReplayBindingDigest",
    "persistedActionDigest", "actualSourceBinding", "observation", "persistencePrefix", "journalPrefixLength", "journalPrefixDigest", "epochDigest"
  ]), "Governed commit dependency refresh epoch");
  const index = journal.indexOf(entry);
  if (entry.event !== EVIDENCE_FRESHNESS_EVENT || entry.protocolVersion !== EVIDENCE_FRESHNESS_PROTOCOL_VERSION ||
      entry.cause.kind !== "dependency-refresh" || epoch.protocol !== GOVERNED_COMMIT_REFRESH_EPOCH_PROTOCOL || epoch.version !== 1 ||
      epoch.runId !== record.runId || epoch.tokenHash !== record.tokenHash || epoch.attemptId !== record.attemptId ||
      epoch.issuedProofDigest !== proof.proofDigest || epoch.successReplayBindingDigest !== binding.bindingDigest ||
      epoch.persistedActionDigest !== digestObject(record) ||
      digestObject(epoch.actualSourceBinding) !== digestObject(binding.sourceBindingTo) ||
      index < 0 || epoch.journalPrefixLength !== index ||
      epoch.journalPrefixDigest !== digestObject(journal.slice(0, index)) ||
      !SHA256_DIGEST.test(epoch.epochDigest ?? "") || digestObject(governedCommitEpochBody(epoch)) !== epoch.epochDigest) {
    throw new Error("Governed commit dependency refresh epoch provenance changed");
  }
  const prefix = governedCommitPersistencePrefix(runDir, proof, binding, record, journal.slice(0, index), epoch.observation);
  if (epoch.persistencePrefix !== prefix.name) throw new Error("Governed commit dependency refresh epoch is unreachable");
  return { ...epoch, rank: prefix.rank };
}

function assertGovernedCommitRefreshEpochChain(runDir, proof, binding, record, journal, livePrefix) {
  let priorRank = -1;
  for (const entry of journal) {
    const epoch = entry.cause?.governedCommitEpoch;
    if (!epoch || (epoch.tokenHash !== record.tokenHash && epoch.attemptId !== record.attemptId)) continue;
    const validated = assertGovernedCommitRefreshEpoch(runDir, proof, binding, record, journal, entry);
    if (validated.rank < priorRank || validated.rank > livePrefix.rank) {
      throw new Error("Governed commit dependency refresh epoch reversed its writer prefix");
    }
    priorRank = validated.rank;
  }
}

// The schema delta is restricted to an already durable, exact ordinary SUCCESS
// prebinding and persisted SUCCESS action. It records an actual source capture,
// not an inference from manifest values, flags or wall-clock ordering.
async function governedCommitDependencyRefreshCause(root, run, freshness) {
  const journal = await readJournalRecords(root, run.runDir);
  const actions = await listJsonRecords(root, safeJoin(run.runDir, "actions"));
  const successes = actions.filter((record) => ordinaryGovernedCommit(record) && governedCommitActionMarked(record) &&
    record.status === "spent" && record.outcome === "success");
  if (successes.length === 0) return { kind: "dependency-refresh" };
  const { captureSourceBinding } = await import("./git.mjs");
  const actualSourceBinding = await captureSourceBinding(run.manifest.cwd, {
    baseRevision: run.manifest.sourceBinding.baseRevision,
    requireClean: false
  });
  if (freshness.currentSourceBinding && digestObject(freshness.currentSourceBinding) !== digestObject(actualSourceBinding)) {
    throw new Error("Governed commit dependency refresh actual source changed during capture");
  }
  const candidates = successes.filter((record) => record.governedCommitSuccessReplay?.sourceBindingTo?.digest === actualSourceBinding.digest);
  if (candidates.length === 0) return { kind: "dependency-refresh" };
  if (candidates.length !== 1) throw new Error("Governed commit dependency refresh epoch is ambiguous");
  await assertGovernedCommitIssuedProofInventory(root, run, actions);
  const record = candidates[0];
  const proof = await loadGovernedCommitIssuedProof(root, run, record);
  const binding = record.governedCommitSuccessReplay;
  assertGovernedCommitSuccessBindingShape(binding, proof, record, record.receipt);
  assertGovernedCommitSuccessJournalBinding(governedCommitSuccessJournal(journal, record), binding, record);
  const observation = await captureGovernedCommitPersistenceObservation(root, run, binding);
  const prefix = governedCommitPersistencePrefix(run.runDir, proof, binding, record, journal, observation);
  assertGovernedCommitRefreshEpochChain(run.runDir, proof, binding, record, journal, prefix);
  const body = {
    protocol: GOVERNED_COMMIT_REFRESH_EPOCH_PROTOCOL,
    version: 1,
    runId: record.runId,
    tokenHash: record.tokenHash,
    attemptId: record.attemptId,
    issuedProofDigest: proof.proofDigest,
    successReplayBindingDigest: binding.bindingDigest,
    persistedActionDigest: digestObject(record),
    actualSourceBinding,
    observation,
    persistencePrefix: prefix.name,
    journalPrefixLength: journal.length,
    journalPrefixDigest: digestObject(journal)
  };
  const epoch = { ...body, epochDigest: digestObject(body) };
  // Refuse provenance drift before appending the canonical transition. The
  // following write still uses the unchanged freshness protocol/version 2.
  const latest = await loadRun(root, run.manifest.runId);
  if (digestObject(await readJournalRecords(root, run.runDir)) !== body.journalPrefixDigest ||
      digestObject(await readJson(root, safeJoin(run.runDir, "actions", `${record.tokenHash}.json`))) !== body.persistedActionDigest ||
      digestObject(await captureGovernedCommitPersistenceObservation(root, latest, binding)) !== digestObject(observation)) {
    throw new Error("Governed commit dependency refresh epoch changed before persistence");
  }
  return { kind: "dependency-refresh", governedCommitEpoch: epoch };
}

async function assertGovernedCommitJournalOnlySuccessPrefix(root, run, record, receipt, proof, bound) {
  const journal = await readJournalRecords(root, run.runDir);
  const currentBound = governedCommitSuccessJournal(journal, record);
  // The caller's entry came from another parse. Rebind the complete entry to
  // this read before using object identity to enforce its persistence order.
  if (!currentBound || digestObject(currentBound) !== digestObject(bound)) {
    throw new Error("Governed commit journal-only success prebinding changed between journal reads");
  }
  assertGovernedCommitSuccessBindingShape(currentBound.binding, proof, record, receipt);
  assertGovernedCommitSuccessJournalBinding(currentBound, currentBound.binding, record);
  const observation = await captureGovernedCommitPersistenceObservation(root, run, currentBound.binding);
  if (record.status !== "spent" || !["pending", "unknown"].includes(record.outcome) ||
      digestObject(observation.manifestSourceBinding) !== digestObject(proof.sourceAuthority.sourceBinding) ||
      digestObject(observation.sourceBindingHistory) !== proof.sourceHistoryAnchorDigest ||
      digestObject(observation.sourceState) !== digestObject(proof.sourceStateAtIssue) || observation.postSentinel !== null ||
      journal.some((entry) => governedCommitAttemptEntry(entry, record) && (
        entry.event === "source-binding.governed-commit" || entry.event === "action.governed-commit-transition-repaired" ||
        (entry.event === "action.reconciled" && entry.outcome === "success")
      ))) {
    throw new Error("Governed commit journal-only success prebinding has an unreachable writer prefix");
  }
  const issues = journal.filter((entry) => entry.event === "action.issued" && governedCommitAttemptEntry(entry, record));
  const consumed = journal.filter((entry) => entry.event === "action.consumed" && governedCommitAttemptEntry(entry, record));
  if (issues.length !== 1 || consumed.length !== 1 ||
      journal.indexOf(issues[0]) >= journal.indexOf(consumed[0]) || journal.indexOf(consumed[0]) >= journal.indexOf(currentBound)) {
    throw new Error("Governed commit journal-only prebinding order changed");
  }
  // Validate the complete current result/source binding before the strict
  // route can reserve execution or record UNKNOWN. A conflicting durable
  // prebinding is corruption, not another source-authority observation.
  validateActionReceipt(record, "success", receipt);
  const validation = await validateGovernedCommitReconciliationAuthority(
    root, run.manifest.runId, run.runDir, record, receipt,
    "Governed commit journal-only strict retry"
  );
  const transition = governedCommitSourceTransition(record, receipt, validation, currentBound.binding.sourceTransition.at);
  const expected = await prepareGovernedCommitSuccessReplayBinding(root, run, record, receipt, validation, transition, proof);
  if (digestObject(expected) !== digestObject(currentBound.binding)) {
    throw new Error("Governed commit journal-only immutable result, source or provenance changed");
  }
}

async function assertGovernedCommitOrdinarySuccessReplay(root, runId, run, record, receipt, proof) {
  if (!ordinaryGovernedCommit(record) || record.status !== "spent" || record.outcome !== "success" ||
      !record.receipt || digestObject(record.receipt) !== digestObject(receipt)) {
    throw new Error("Governed commit historical replay requires the exact persisted ordinary success");
  }
  validateActionReceipt(record, "success", receipt);
  const binding = record.governedCommitSuccessReplay;
  assertGovernedCommitSuccessBindingShape(binding, proof, record, receipt);
  if (digestObject(binding.sourceTransition) !== digestObject(record.sourceBindingTransition)) {
    throw new Error("Governed commit success transition changed after persistence");
  }
  const journal = await readJournalRecords(root, run.runDir);
  assertGovernedCommitSuccessJournalBinding(governedCommitSuccessJournal(journal, record), binding, record);
  const prefix = governedCommitPersistencePrefix(run.runDir, proof, binding, record, journal,
    await captureGovernedCommitPersistenceObservation(root, run, binding));
  assertGovernedCommitRefreshEpochChain(run.runDir, proof, binding, record, journal, prefix);
  const records = await listIdentityBoundJsonRecords(root, safeJoin(run.runDir, "evidence"), "Evidence");
  await assertEvidenceJournalProvenance(root, run, records, journal);
  const closureIds = proof.evidenceClosure.map((item) => item.evidenceId);
  const expectedIds = [...new Set([
    ...record.evidenceGateProjection.evidence.map((item) => item.evidenceId),
    ...record.evidenceGateProjection.findingDispositions.map((item) => item.evidenceId)
  ])].sort();
  if (new Set(closureIds).size !== closureIds.length || digestObject([...closureIds].sort()) !== digestObject(expectedIds)) {
    throw new Error("Governed commit historical ISSUE proof closure changed");
  }
  for (const snapshot of [...proof.evidenceClosure, ...binding.resultEvidence]) {
    await assertGovernedCommitEvidenceSnapshot(root, run, proof, snapshot, records, journal, binding, record);
  }
  for (const selected of record.evidenceGateProjection.evidence) {
    const snapshot = proof.evidenceClosure.find((item) => item.evidenceId === selected.evidenceId);
    if (selected.kind !== snapshot.record.kind || selected.evidenceDigest !== snapshot.evidenceDigest ||
        selected.admissionDigest !== digestObject(snapshot.record.typedAdmission) ||
        selected.dependencyBindingDigest !== digestObject(snapshot.record.dependencies ?? null) ||
        selected.expectedDependencyDigest !== selected.dependencyBindingDigest) {
      throw new Error("Governed commit ISSUE selection is detached from its evidence snapshot");
    }
  }
  for (const disposition of record.evidenceGateProjection.findingDispositions) {
    const snapshot = proof.evidenceClosure.find((item) => item.evidenceId === disposition.evidenceId);
    if (disposition.evidenceDigest !== snapshot.evidenceDigest) {
      throw new Error("Governed commit ISSUE finding disposition is detached from its evidence snapshot");
    }
  }
  for (const snapshot of binding.resultEvidence) {
    const result = records.find((item) => item.id === snapshot.evidenceId);
    assertActionBoundEvidencePayload(record, result, record.attemptId, receipt);
  }
  await assertGovernedCommitLiveReplayAuthority(root, run, record, proof);
  await verifyProviderReceipt(run.manifest, record, receipt, run.contract);
  const validation = await validateGovernedCommitSourceTransition(root, run.runDir, run.contract, record, receipt);
  const expectedTransition = governedCommitSourceTransition(record, receipt, validation, binding.sourceTransition.at);
  if (digestObject(expectedTransition) !== digestObject(binding.sourceTransition) ||
      digestObject(validation.currentSourceBinding) !== digestObject(binding.sourceBindingTo) ||
      stableSentinelRecordDigest(validation.currentSentinel) !== stableSentinelRecordDigest(binding.sourceSentinelTo)) {
    throw new Error("Governed commit historical replay source or result changed");
  }
  const history = run.manifest.sourceBindingHistory ?? [];
  const initialSourceBindingDigest = run.manifest.initialSourceBindingDigest ??
    history[0]?.from ?? run.manifest.sourceBinding.digest;
  if (initialSourceBindingDigest !== proof.issuedAction.evidenceGateProjection.initialSourceBindingDigest) {
    throw new Error("Governed commit live initial source authority changed");
  }
  const anchor = await sourceHistoryProvenanceBinding(root, run, proof.sourceHistoryAnchor, initialSourceBindingDigest);
  if (anchor.reached !== proof.sourceAuthority.sourceBinding.digest ||
      digestObject(anchor.transitions) !== proof.issuedAction.evidenceGateProjection.sourceTransitionDigest ||
      digestObject(anchor.transitions) !== digestObject(proof.issuedAction.evidenceGateProjection.sourceTransitions)) {
    throw new Error("Governed commit live ISSUE source-history provenance changed");
  }
  return { validation, binding, successJournalMissing: prefix.completion === null, persistencePrefix: prefix.name };
}

async function governedCommitHistoricalEvidenceAuthority(root, runId, run, record, context) {
  const projection = record.evidenceGateProjection;
  const expectedGate = run.contract.actionGates?.["git.commit"];
  if (
    record.status !== "spent" || record.action !== "git.commit" || record.provider !== "git" ||
    record.contractDigest !== digestObject(run.contract) ||
    !Array.isArray(expectedGate) || digestObject(expectedGate) !== digestObject(record.evidenceGate) ||
    !projection || digestObject(projection) !== record.evidenceGateDigest ||
    projection.runId !== runId || projection.action !== "git.commit" ||
    projection.contractDigest !== digestObject(run.contract) ||
    projection.authorityDigest !== digestObject(run.contract.authority ?? null) ||
    projection.policyDigest !== canonicalEvidencePolicyDigest(run.contract) ||
    projection.remoteRevision !== (run.contract.remoteRevision ?? null) ||
    projection.workflowVersion !== VERSION ||
    !Array.isArray(projection.evidence)
  ) {
    throw new Error(`${context} denied because historical staged-batch authority is malformed or no longer governed`);
  }
  const issueSource = record.sourceAuthorityAtIssue;
  if (
    issueSource?.sourceBinding?.digest !== record.preCommitSourceBinding?.digest ||
    issueSource?.sourceSentinel?.digest !== projection.sourceSentinelDigest ||
    issueSource?.sourceSentinel?.digest !== record.treeDigest
  ) {
    throw new Error(`${context} denied because historical staged-batch authority is detached from its source snapshot`);
  }
  const records = await listIdentityBoundJsonRecords(
    root,
    safeJoin(run.runDir, "evidence"),
    "Evidence"
  );
  const byId = new Map(records.map((item) => [item.id, item]));
  for (const frozen of projection.evidence) {
    const evidence = byId.get(frozen.evidenceId);
    if (
      !evidence || evidence.kind !== frozen.kind || evidence.status !== "complete" ||
      evidence.schemaVersion !== 2 || !evidence.typedAdmission ||
      !SHA256_DIGEST.test(frozen.immutableEvidenceDigest ?? "") ||
      digestObject(evidenceImmutableProjection(evidence)) !== frozen.immutableEvidenceDigest
    ) {
      throw new Error(`${context} denied because issued evidence bytes changed: ${frozen.evidenceId}`);
    }
  }
  const findings = await listJsonRecords(root, safeJoin(run.runDir, "findings"));
  if (findings.some((item) => ["P0", "P1"].includes(item.severity) && item.status === "open")) {
    throw new Error(`${context} denied by a currently unresolved P0/P1 finding`);
  }
  return projection;
}

async function assertSpentActionEvidenceGate(root, runId, run, record, context) {
  if (run.contract.schemaVersion !== 2) return null;
  await assertSpentActionNonSourceAuthority(root, runId, run, record, context);
  const currentGate = await currentActionEvidenceGateBinding(root, runId, run, record.action);
  if (currentGate.digest !== record.evidenceGateDigest) {
    throw new Error(`${context} denied because the configured evidence gate changed`);
  }
  if (currentGate.projection.sourceSentinelDigest !== record.treeDigest) {
    throw new Error(`${context} denied because the content-complete source sentinel changed`);
  }
  return currentGate;
}

export async function assertSpentActionProviderAuthority(root, runId, run, record, context) {
  return assertSpentActionEvidenceGate(root, runId, run, record, context);
}

export async function assertAutonomousCommitEvidenceInvalidationSafe(
  root,
  runId,
  { run: suppliedRun = null } = {}
) {
  const run = suppliedRun ?? await loadRun(root, runId);
  if (run.contract.schemaVersion !== 2) return { ok: true, supersessionIds: [] };
  const supersessions = [
    ...(await listIdentityBoundJsonRecords(
      root,
      safeJoin(run.runDir, "evidence-supersessions"),
      "Evidence supersession"
    )),
    ...(await listIdentityBoundJsonRecords(
      root,
      safeJoin(run.runDir, REVIEW_EVIDENCE_SUPERSESSION_DIRECTORY),
      "Review evidence supersession"
    ))
  ];
  const journal = await readJournalRecords(root, run.runDir);
  const journalIds = journal
    .filter((entry) => (
      entry.event === "evidence.superseded" ||
      entry.event === REVIEW_EVIDENCE_SUPERSESSION_EVENT
    ))
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

export async function refreshEvidence(root, runId, { onTransitionPrepared = null } = {}) {
  if (onTransitionPrepared !== null && typeof onTransitionPrepared !== "function") {
    throw new Error("Evidence freshness transition hook must be a function");
  }
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Evidence freshness");
    let evidence = run.contract.schemaVersion === 2
      ? await listIdentityBoundJsonRecords(root, safeJoin(runDir, "evidence"), "Evidence")
      : await listJsonRecords(root, safeJoin(runDir, "evidence"));
    let recoveredPending = [];
    if (run.contract.schemaVersion === 2) {
      const recovered = await recoverPendingEvidenceFreshnessTransitions(root, runDir, evidence);
      evidence = recovered.records;
      recoveredPending = recovered.recoveredIds;
    }
    const supersessionState = run.contract.schemaVersion === 2
      ? mergeEvidenceSupersessionStates(
        await loadEvidenceSupersessions(root, run, evidence),
        await loadReviewEvidenceSupersessions(root, run, evidence)
      )
      : { records: [], supersededIds: new Set(), replacementIds: new Set() };
    const immutableIds = new Set(supersessionState.records.flatMap((record) => [
      record.supersededEvidence.id,
      record.replacementEvidence.id
    ]));
    const invalidatedReviewIds = new Set(
      supersessionState.records
        .filter((record) => record.kind === REVIEW_EVIDENCE_SUPERSESSION_KIND)
        .map((record) => record.supersededEvidence.id)
    );
    const stale = [];
    const fresh = [];
    const immutableStale = [];
    for (const record of evidence) {
      const freshness = await currentEvidenceFreshness(run, record);
      if (invalidatedReviewIds.has(record.id)) {
        stale.push(record.id);
      } else if (immutableIds.has(record.id)) {
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
        await writeEvidenceFreshnessTransition(
          root,
          runDir,
          record,
          next,
          await governedCommitDependencyRefreshCause(root, run, freshness),
          {
            onPrepared: onTransitionPrepared
              ? (transition) => onTransitionPrepared(record, transition)
              : null
          }
        );
      }
      (freshness.stale ? stale : fresh).push(record.id);
    }
    return {
      stale,
      fresh,
      immutableEvidenceIds: [...immutableIds].sort(),
      immutableStale: immutableStale.sort(),
      recoveredPending: recoveredPending.sort()
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

export async function supersedeReviewEvidence(root, runId, input) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Review evidence supersession");
    if (run.contract.schemaVersion !== 2) {
      throw new Error("Review evidence supersession requires a TaskContract v2 run");
    }
    assertExactObjectKeys(input, REVIEW_EVIDENCE_SUPERSESSION_INPUT_KEYS, "Review evidence supersession input");
    if (input.schemaVersion !== REVIEW_EVIDENCE_SUPERSESSION_SCHEMA_VERSION) {
      throw new Error("Review evidence supersession input schemaVersion must be 1");
    }
    validateRecordId(input.id, "review evidence supersession");
    validateRecordId(input.supersededEvidenceId, "superseded review evidence");
    validateRecordId(input.replacementEvidenceId, "replacement review evidence");
    if (
      !SHA256_DIGEST.test(input.supersededEvidenceDigest) ||
      !SHA256_DIGEST.test(input.replacementEvidenceDigest)
    ) {
      throw new Error("Review evidence supersession input digests are invalid");
    }
    if (!REVIEW_EVIDENCE_SUPERSESSION_REASON_CODES.has(input.reasonCode)) {
      throw new Error("Review evidence supersession reasonCode is unsupported");
    }
    if (typeof input.reason !== "string" || input.reason.trim().length < 12 || input.reason.length > 512) {
      throw new Error("Review evidence supersession reason must be 12 to 512 characters");
    }
    const evidence = await listIdentityBoundJsonRecords(root, safeJoin(runDir, "evidence"), "Evidence");
    const evidenceJournal = await readJournalRecords(root, runDir);
    await assertEvidenceJournalProvenance(root, run, evidence, evidenceJournal);
    const recordsById = new Map(evidence.map((record) => [record.id, record]));
    const target = recordsById.get(input.supersededEvidenceId);
    const replacement = recordsById.get(input.replacementEvidenceId);
    if (!target || !replacement) {
      throw new Error("Review evidence supersession target or replacement is missing");
    }
    if (
      digestObject(target) !== input.supersededEvidenceDigest ||
      digestObject(replacement) !== input.replacementEvidenceDigest
    ) {
      throw new Error("Review evidence supersession input digest does not match persisted evidence");
    }
    const targetPath = safeJoin(
      runDir,
      REVIEW_EVIDENCE_SUPERSESSION_DIRECTORY,
      `${input.id}.json`
    );
    if (!(await pathExists(targetPath))) {
      const existingSupersessions = await loadReviewEvidenceSupersessions(root, run, evidence);
      if (
        existingSupersessions.records.some((existing) => (
          existing.supersededEvidence.id === target.id ||
          existing.replacementEvidence.id === target.id ||
          existing.supersededEvidence.id === replacement.id ||
          existing.replacementEvidence.id === replacement.id
        ))
      ) {
        throw new Error("Review evidence supersession target or replacement is already bound");
      }
    }
    let record;
    if (await pathExists(targetPath)) {
      record = await readJson(root, targetPath);
      if (
        record.supersededEvidence?.id !== target.id ||
        record.supersededEvidence?.digest !== input.supersededEvidenceDigest ||
        record.replacementEvidence?.id !== replacement.id ||
        record.replacementEvidence?.digest !== input.replacementEvidenceDigest ||
        record.reasonCode !== input.reasonCode ||
        record.reason !== input.reason
      ) {
        throw new Error(`Review evidence supersession already exists: ${input.id}`);
      }
    } else {
      record = {
        schemaVersion: REVIEW_EVIDENCE_SUPERSESSION_SCHEMA_VERSION,
        id: input.id,
        runId,
        kind: REVIEW_EVIDENCE_SUPERSESSION_KIND,
        targetDisposition: REVIEW_EVIDENCE_SUPERSESSION_TARGET_DISPOSITION,
        replacementDisposition: REVIEW_EVIDENCE_SUPERSESSION_REPLACEMENT_DISPOSITION,
        selectionPolicy: REVIEW_EVIDENCE_SUPERSESSION_SELECTION_POLICY,
        supersededEvidence: { id: target.id, digest: input.supersededEvidenceDigest },
        replacementEvidence: { id: replacement.id, digest: input.replacementEvidenceDigest },
        reviewBinding: reviewEvidenceBinding(replacement),
        contractDigest: run.manifest.contractDigest,
        sourceBindingDigest: run.manifest.sourceBinding?.digest ?? null,
        policyDigest: replacement.dependencies?.policyDigest ?? null,
        reasonCode: input.reasonCode,
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
      supersessionKind: record.kind,
      selectionPolicy: record.selectionPolicy,
      reasonCode: record.reasonCode
    };
    const existingJournal = journal.filter(
      (entry) => entry.event === REVIEW_EVIDENCE_SUPERSESSION_EVENT && entry.supersessionId === record.id
    );
    if (existingJournal.length === 0) {
      await validateReviewEvidenceSupersessionRecord(
        root,
        run,
        recordsById,
        [...journal, { event: REVIEW_EVIDENCE_SUPERSESSION_EVENT, at: nowIso(), ...journalDetails }],
        record
      );
      await appendJournal(root, runDir, REVIEW_EVIDENCE_SUPERSESSION_EVENT, journalDetails);
    } else if (
      existingJournal.length !== 1 ||
      existingJournal[0].supersessionDigest !== recordDigest ||
      existingJournal[0].supersessionKind !== record.kind ||
      existingJournal[0].selectionPolicy !== record.selectionPolicy ||
      existingJournal[0].reasonCode !== record.reasonCode
    ) {
      throw new Error("Review evidence supersession journal binding conflicts with the persisted record");
    }
    const refreshed = await loadReviewEvidenceSupersessions(root, run, evidence);
    if (!refreshed.records.some((item) => item.id === record.id)) {
      throw new Error("Review evidence supersession was not admitted by canonical replay");
    }
    return record;
  });
}

export function isVerifiedStagedCommitTokenExpiry(action, journalRecords) {
  const receipt = action?.expirationReceipt;
  const sourceAuthority = action?.sourceAuthorityAtIssue;
  const sourceBinding = sourceAuthority?.sourceBinding;
  const sourceSentinel = sourceAuthority?.sourceSentinel;
  if (
    !action || typeof action !== "object" ||
    action.schemaVersion !== 1 || !SAFE_ID.test(action.runId ?? "") ||
    !SAFE_ID.test(action.attemptId ?? "") || !SHA256_DIGEST.test(action.tokenHash ?? "") ||
    sourceAuthority?.schemaVersion !== 1 || sourceBinding?.schemaVersion !== 3 ||
    !SHA.test(sourceBinding?.headRevision ?? "") || !SHA256_DIGEST.test(sourceBinding?.digest ?? "") ||
    !SAFE_ID.test(sourceSentinel?.label ?? "") ||
    !SHA256_DIGEST.test(sourceSentinel?.digest ?? "") ||
    !SHA256_DIGEST.test(sourceSentinel?.recordDigest ?? "") ||
    action.status !== "expired" || action.outcome !== null ||
    action.action !== "git.commit" || action.provider !== "git" ||
    action.resource !== "git:commit" ||
    action.autonomyDecision?.decision === "auto-approved" ||
    !isValidGovernedCommitBatchBinding(action.commitBatchBinding) ||
    action.scope !== `${GOVERNED_COMMIT_BATCH_PROTOCOL}:${action.commitBatchBinding.batchId}` ||
    !commitBatchBindingDigest(action.commitBatchBinding) ||
    action.commitBatchBindingDigest !== action.commitBatchBinding.bindingDigest ||
    action.receipt || action.providerInvocation || action.sourceBindingTransition || action.spentAt ||
    receipt?.schemaVersion !== 1 || receipt.kind !== "governed-commit-token-expired" ||
    receipt.actionAttemptId !== action.attemptId || receipt.tokenHash !== action.tokenHash ||
    receipt.commitBatchBindingDigest !== action.commitBatchBindingDigest ||
    receipt.batchId !== action.commitBatchBinding.batchId ||
    receipt.ordinal !== action.commitBatchBinding.ordinal ||
    receipt.expiresAt !== action.expiresAt ||
    !SHA256_DIGEST.test(receipt.preconditionDigest ?? "") ||
    !Number.isFinite(Date.parse(receipt.expiresAt ?? "")) ||
    !Number.isFinite(Date.parse(receipt.expiredAt ?? "")) ||
    Date.parse(receipt.expiredAt) < Date.parse(receipt.expiresAt) ||
    action.expirationReceiptDigest !== digestObject(receipt) ||
    !Array.isArray(journalRecords)
  ) return false;
  const matchingEvents = journalRecords.filter((item) => (
    item?.event === "action.commit-batch-expired" && item.attemptId === action.attemptId
  ));
  return matchingEvents.length === 1 &&
    matchingEvents[0].tokenHash === action.tokenHash &&
    matchingEvents[0].expirationReceiptDigest === action.expirationReceiptDigest &&
    digestObject(matchingEvents[0].expirationReceipt) === action.expirationReceiptDigest &&
    digestObject(matchingEvents[0].expirationReceipt) === digestObject(receipt);
}

function isSettledActionRecord(action, journalRecords) {
  if (
    action.status === "spent" &&
    !["unknown", "pending", "failure"].includes(action.outcome)
  ) return true;
  return isVerifiedStagedCommitTokenExpiry(action, journalRecords);
}

export async function evaluateCompletion(root, runId) {
  const { runDir, manifest, contract, state } = await loadRun(root, runId);
  let evidence = [];
  let evidenceSupersessions = [];
  const findings = await listJsonRecords(root, safeJoin(runDir, "findings"));
  const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
  if (contract.template !== "auto" || manifest.template !== "auto") {
    return {
      ok: false,
      blockers: ["unsupported-public-template"],
      evidence,
      evidenceSupersessions,
      findings,
      actions
    };
  }
  let actionJournal = [];
  const blockers = [];
  try {
    actionJournal = await readJournalRecords(root, runDir);
  } catch {
    blockers.push("invalid-action-journal");
  }
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
        requireClean: false
      });
      if (!currentSourceBinding || currentSourceBinding.digest !== manifest.sourceBinding.digest) {
        blockers.push("source-binding-drift");
      }
    } catch {
      blockers.push("source-binding-unavailable");
    }
  }
  for (const finding of findings) {
    try {
      validateFinding(finding);
      if (["P0", "P1"].includes(finding.severity)) {
        await assertFindingEvidence(root, { runDir, manifest, contract, state }, runDir, finding);
      }
    } catch (error) {
      blockers.push(`invalid-finding-disposition:${finding.id}:${error.message}`);
    }
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
              const checkVerification = await verifyRequiredChecksAfterSuccessfulMerge(manifest, contract, record, mergeAction);
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
  if (actions.some((action) => !isSettledActionRecord(action, actionJournal))) {
    blockers.push("side-effect-not-reconciled");
  }
  if (
    isProtectedDeliveryTemplate(contract) &&
    availableEvidence.has("remote-sync") &&
    !actions.some((action) => (
      action.action === "remote.sync" &&
      action.status === "spent" &&
      action.outcome === "success" &&
      action.resource === `refs/heads/${protectedDeliveryTarget(contract)}` &&
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
  if (isProtectedDeliveryTemplate(contract)) {
    const remoteSyncAction = actions.find((action) => (
      action.action === "remote.sync" &&
      action.status === "spent" &&
      action.outcome === "success" &&
      action.resource === `refs/heads/${protectedDeliveryTarget(contract)}` &&
      action.receipt?.providerReceipt
    ));
    if (remoteSyncAction) {
      try {
        await verifyProviderReceipt(manifest, { ...remoteSyncAction, outcome: "success" }, remoteSyncAction.receipt, contract);
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

// Test-only seam: linked-worktree regressions must observe the exact provider
// identity used by production reservation issuance, not reimplement Git lookup.
export async function currentGitProviderIdentityForTest(cwd) {
  return currentGitProviderIdentity(cwd);
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
    if (!path.isAbsolute(worktreePath) || path.resolve(worktreePath) !== worktreePath ||
        await realpath(path.dirname(worktreePath)) !== path.dirname(worktreePath)) {
      throw new Error("Git worktree creation requires an absolute canonical destination with an existing parent");
    }
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
    GH_PROMPT_DISABLED: "1",
    // gh may inspect the worktree through Git. Optional stat-cache refreshes
    // must not rewrite the raw index bound by the action's source sentinel.
    GIT_OPTIONAL_LOCKS: "0"
  };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    if (typeof process.env[key] === "string" && process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function normalizeBoundGitHubEnvironment(candidate) {
  const base = boundGitHubEnvironment(candidate?.HOME ?? os.homedir());
  const allowed = new Set([
    "PATH", "HOME", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GH_HOST", "LANG", "LC_ALL", "GH_PROMPT_DISABLED", "GIT_OPTIONAL_LOCKS",
    "GH_TOKEN", "GITHUB_TOKEN"
  ]);
  if (candidate !== undefined && (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))) {
    throw new Error("Bound GitHub CLI environment must be an object");
  }
  for (const key of Object.keys(candidate ?? {})) {
    if (!allowed.has(key)) throw new Error(`Bound GitHub CLI environment rejects ambient key ${key}`);
  }
  for (const key of ["PATH", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GH_HOST", "LANG", "LC_ALL", "GH_PROMPT_DISABLED", "GIT_OPTIONAL_LOCKS"]) {
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
  if (["dev", "main"].includes(record.targetRef) && !/^[a-f0-9]{40}$/i.test(record.remoteRevision ?? "")) {
    throw new Error(`Protected ${record.targetRef} merge requires the exact reviewed base revision`);
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
  if (!run.contract.actionGates?.[record.action]?.includes("required-checks")) {
    throw new Error("PR merge is deferred until required-checks provide atomic protected-base synchronization");
  }
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

const WORKTREE_CREATION_MARKER_VERSION = 1;
const WORKTREE_CREATION_MARKER_FILENAME = "sbw-worktree-creation-v1.json";

async function worktreeCreationProviderObject(cwd, worktreePath, revision) {
  if (!path.isAbsolute(worktreePath) || await realpath(worktreePath) !== worktreePath) {
    throw new Error("Git worktree creation proof requires the exact canonical worktree path");
  }
  const output = (await execBoundGitAuthority(cwd, ["worktree", "list", "--porcelain"])).stdout;
  const block = output.split(/\n\n+/).find((item) => item.split("\n").includes(`worktree ${worktreePath}`));
  if (!block || !block.split("\n").includes("detached") ||
      !block.split("\n").includes(`HEAD ${revision}`)) {
    throw new Error("Git worktree creation proof does not match the live detached provider object");
  }
  const gitDir = await realpath((await execBoundGitAuthority(cwd, [
    "-C", worktreePath, "rev-parse", "--absolute-git-dir"
  ])).stdout.trim());
  const commonValue = (await execBoundGitAuthority(cwd, [
    "-C", worktreePath, "rev-parse", "--git-common-dir"
  ])).stdout.trim();
  const gitCommonDir = await realpath(path.resolve(worktreePath, commonValue));
  if (gitCommonDir !== await currentGitProviderIdentity(cwd) ||
      gitDir === gitCommonDir || path.dirname(gitDir) !== path.join(gitCommonDir, "worktrees")) {
    throw new Error("Git worktree creation marker is not in this worktree's provider administration directory");
  }
  return {
    path: worktreePath,
    revision,
    gitDir,
    gitCommonDir,
    providerObjectId: `${worktreePath}:${revision}`,
    markerPath: path.join(gitDir, WORKTREE_CREATION_MARKER_FILENAME)
  };
}

async function readWorktreeCreationMarker(object) {
  const before = await lstat(object.markerPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Git worktree creation marker must be a regular non-symlink file");
  }
  const file = await open(object.markerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 16 * 1024) {
      throw new Error("Git worktree creation marker changed while opening");
    }
    const bytes = await file.readFile();
    const after = await lstat(object.markerPath);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error("Git worktree creation marker changed while reading");
    }
    return { value: JSON.parse(bytes.toString("utf8")), digest: sha256(bytes), info: after };
  } finally {
    await file.close();
  }
}

async function verifyWorktreeCreationMarker(manifest, record, providerReceipt) {
  const proof = providerReceipt.creationProof;
  if (proof?.markerVersion !== WORKTREE_CREATION_MARKER_VERSION || !SHA256_DIGEST.test(proof?.markerDigest ?? "")) {
    throw new Error("Git worktree creation requires the versioned per-worktree marker; legacy common config is not accepted");
  }
  const object = await worktreeCreationProviderObject(manifest.cwd, providerReceipt.path, providerReceipt.revision);
  if (providerReceipt.revision !== record.remoteRevision || record.resource !== `worktree:${object.path}` || proof.gitDir !== object.gitDir ||
      proof.gitCommonDir !== object.gitCommonDir || proof.markerPath !== object.markerPath ||
      proof.providerObjectId !== object.providerObjectId) {
    throw new Error("Git worktree creation marker provider object or administration path changed");
  }
  const observed = await readWorktreeCreationMarker(object);
  const expected = {
    schemaVersion: WORKTREE_CREATION_MARKER_VERSION,
    kind: "worktree-creation-marker",
    runId: record.runId,
    actionAttemptId: record.attemptId,
    idempotencyKey: record.idempotencyKey,
    resource: record.resource,
    path: object.path,
    revision: object.revision,
    gitDir: object.gitDir,
    gitCommonDir: object.gitCommonDir,
    providerObjectId: object.providerObjectId,
    marker: `sbw:${record.attemptId}:${record.idempotencyKey}`,
    createdAt: proof.observedAt
  };
  const minimumObservedAt = Date.parse(record.spentAt ?? "") - 2000;
  if (!Number.isFinite(minimumObservedAt) || !Number.isFinite(Date.parse(proof.observedAt ?? "")) ||
      Date.parse(proof.observedAt) < minimumObservedAt || observed.info.mtimeMs < minimumObservedAt ||
      observed.digest !== proof.markerDigest || digestObject(observed.value) !== digestObject(expected)) {
    throw new Error("Git worktree creation marker is not bound to this run, consumed attempt, resource and provider object");
  }
  return object;
}

function worktreeCreationReceiptResponse(object, proof) {
  return {
    path: object.path, revision: object.revision,
    markerVersion: proof.markerVersion, markerDigest: proof.markerDigest,
    gitDir: object.gitDir, gitCommonDir: object.gitCommonDir, providerObjectId: object.providerObjectId
  };
}

async function createDetachedWorktreeProviderReceipt(manifest, record) {
  const worktreePath = record.resource.slice("worktree:".length);
  if (!SHA.test(record.remoteRevision ?? "") || record.creationPrecondition?.state !== "absent") {
    throw new Error("Detached worktree creation requires the exact authorized revision and absent precondition");
  }
  await execBoundGitAuthority(manifest.cwd, ["worktree", "add", "--detach", "--", worktreePath, record.remoteRevision]);
  const object = await worktreeCreationProviderObject(manifest.cwd, worktreePath, record.remoteRevision);
  const observedAt = nowIso();
  const marker = {
    schemaVersion: WORKTREE_CREATION_MARKER_VERSION, kind: "worktree-creation-marker",
    runId: record.runId, actionAttemptId: record.attemptId, idempotencyKey: record.idempotencyKey,
    resource: record.resource, path: object.path, revision: object.revision,
    gitDir: object.gitDir, gitCommonDir: object.gitCommonDir, providerObjectId: object.providerObjectId,
    marker: `sbw:${record.attemptId}:${record.idempotencyKey}`, createdAt: observedAt
  };
  const bytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`);
  const file = await open(object.markerPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  const proof = {
    attemptId: record.attemptId, idempotencyKey: record.idempotencyKey, marker: marker.marker,
    markerVersion: WORKTREE_CREATION_MARKER_VERSION, markerDigest: sha256(bytes),
    markerPath: object.markerPath, gitDir: object.gitDir, gitCommonDir: object.gitCommonDir,
    providerObjectId: object.providerObjectId, observedAt
  };
  const repository = await currentGitProviderIdentity(manifest.cwd);
  const providerReceipt = {
    action: record.action, provider: record.provider, resource: record.resource, outcome: "success",
    runId: record.runId, attemptId: record.attemptId, idempotencyKey: record.idempotencyKey,
    remoteRevision: record.remoteRevision,
    executionId: `git:${repository}:worktree.create:${object.path}:${object.revision}:${proof.markerDigest}`,
    proofKind: "git-worktree-create", created: true, path: object.path, revision: object.revision,
    requestDigest: digestObject({ action: record.action, provider: record.provider, resource: record.resource,
      remoteRevision: record.remoteRevision, repository }),
    responseDigest: digestObject(worktreeCreationReceiptResponse(object, proof)),
    verifiedAt: observedAt, terminalState: "success", creationProof: proof,
    creationPreconditionDigest: digestObject(record.creationPrecondition)
  };
  await verifyWorktreeCreationMarker(manifest, record, providerReceipt);
  return providerReceipt;
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
    await verifyWorktreeCreationMarker(manifest, record, providerReceipt);
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
    binding: authorizationBinding,
    expectedFileDigest: authorizationAttestation.fileDigest
  });
  if (
    attestation.fileDigest !== authorizationAttestation.fileDigest ||
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
  assertPublicAutoActionRecord(record, "Provider receipt verification");
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
    const sourceMutationDigest = providerReceipt.sourceMutation
      ? digestObject(providerReceipt.sourceMutation)
      : null;
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, idempotencyKey: record.idempotencyKey },
      {
        kind: providerReceipt.kind,
        digest: providerReceipt.digest,
        ...(sourceMutationDigest ? { sourceMutationDigest } : {})
      },
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
      worktreeCreationReceiptResponse(await verifyWorktreeCreationMarker(manifest, record, providerReceipt), providerReceipt.creationProof),
      `git:${repository}:worktree.create:${providerReceipt.path}:${match.HEAD}:${providerReceipt.creationProof.markerDigest}`
    );
    return;
  }
  if (key === "git.commit:git") {
    const actualHead = (await execBoundGitAuthority(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    const actualCommit = (await execBoundGitAuthority(cwd, [
      "rev-parse", "--verify", `${providerReceipt.revision}^{commit}`
    ])).stdout.trim();
    const repository = await currentGitProviderIdentity(cwd);
    const batchBinding = record.commitBatchBinding ?? null;
    if (
      actualCommit !== providerReceipt.revision ||
      (!batchBinding || !record.sourceBindingTransition) && actualHead !== providerReceipt.revision
    ) {
      throw new Error("Git commit proof does not resolve to the issued provider revision");
    }
    const request = {
      action: record.action,
      provider: record.provider,
      resource: record.resource,
      remoteRevision: record.remoteRevision,
      repository,
      ...(batchBinding ? {
        commitBatchBindingDigest: record.commitBatchBindingDigest,
        commitBatchId: batchBinding.batchId,
        commitBatchOrdinal: batchBinding.ordinal,
        commitBatchPlanDigest: batchBinding.planDigest,
        candidateIndexTree: batchBinding.candidateIndexTree
      } : {})
    };
    const response = {
      repository,
      revision: providerReceipt.revision,
      ...(batchBinding ? {
        commitBatchBindingDigest: record.commitBatchBindingDigest,
        commitBatchId: batchBinding.batchId,
        commitBatchOrdinal: batchBinding.ordinal,
        commitBatchPlanDigest: batchBinding.planDigest,
        candidateIndexTree: batchBinding.candidateIndexTree
      } : {})
    };
    assertRecomputedProviderReceipt(
      providerReceipt,
      request,
      response,
      `git:${repository}:git.commit:${providerReceipt.revision}`
    );
    if (record.resource.startsWith("commit:") && providerReceipt.revision !== record.resource.slice("commit:".length)) {
      throw new Error("Git commit proof does not match provider state");
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
    const mergeHead = record.mergeMethod === "squash" ? actual.headRefOid : mergeParents[1];
    const expectedParentCount = record.mergeMethod === "squash" ? 1 : 2;
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
      mergeParents.length !== expectedParentCount ||
      providerReceipt.mergeHead !== record.reviewedHead ||
      mergeHead !== record.reviewedHead ||
      providerReceipt.providerExecutableDigest !== record.providerExecutable?.digest
    ) throw new Error("GitHub pull request merge proof does not match provider state");
    return;
  }
  if (key === "remote.sync:git") {
    assertProtectedDeliveryRequest(contract ?? manifest.template, record);
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

export async function verifyMergeHumanApproval(cwd, payload, {
  now = Date.now(),
  recordedSourceBinding = null
} = {}) {
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
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const approvedAt = Date.parse(authorization.approvedAt ?? "");
  if (!Number.isFinite(nowMs) || !Number.isFinite(approvedAt) || approvedAt > nowMs + 300_000 || nowMs - approvedAt > 24 * 60 * 60 * 1000) {
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
  let currentSource;
  if (recordedSourceBinding !== null) {
    const { digest, ...identity } = recordedSourceBinding ?? {};
    const canonicalCwd = await realpath(path.resolve(cwd));
    if (
      !recordedSourceBinding || typeof recordedSourceBinding !== "object" || Array.isArray(recordedSourceBinding) ||
      digestObject(identity) !== digest ||
      recordedSourceBinding.cwd !== canonicalCwd ||
      recordedSourceBinding.baseRevision !== payload.base ||
      recordedSourceBinding.headRevision !== payload.head
    ) {
      throw new Error("Governed PR merge human approval recorded source registry binding is invalid");
    }
    currentSource = recordedSourceBinding;
  } else {
    const { captureSourceBinding } = await import("./git.mjs");
    try {
      currentSource = await captureSourceBinding(path.resolve(cwd), {
        baseRevision: payload.base,
        requireClean: true
      });
    } catch (error) {
      throw new Error(`Governed PR merge human approval source registry binding is stale: ${error.message}`);
    }
  }
  if (
    currentSource?.headRevision !== payload.head ||
    currentSource?.digest !== authorization.sourceBindingDigest
  ) {
    throw new Error("Governed PR merge human approval source registry binding is stale");
  }
  const { verifyTrustedNativeCriticAttestation } = await import("./providers.mjs");
  const verified = await verifyTrustedNativeCriticAttestation({
    attestationPath: attestation.path,
    workspaceRoot: cwd,
    binding,
    now: nowMs,
    requireFixedHostRoot: recordedSourceBinding !== null,
    expectedFileDigest: attestation.fileDigest
  });
  if (
    verified.attestationDigest !== attestation.attestationDigest ||
    verified.attestationPath !== attestation.path ||
    verified.fileDigest !== attestation.fileDigest
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

// Public pre-merge observations have no merged-state option. ISSUE, CONSUME
// and provider invocation all retain the live open-PR predicate below.
export async function verifyRequiredChecksProvider(cwd, payload, providerExecutable = null) {
  return verifyRequiredChecksProviderObservation(cwd, payload, providerExecutable);
}

async function verifyRequiredChecksAfterSuccessfulMerge(manifest, contract, requiredChecks, mergeAction) {
  const exact = assertPersistedSuccessfulMergeActionForRequiredChecks([mergeAction], requiredChecks, {
    runId: manifest.runId, contractDigest: digestObject(contract), repository: requiredChecks.receipt.payload.repository
  });
  await verifyProviderReceipt(manifest, { ...exact, outcome: "success" }, exact.receipt, contract);
  const mergeCommit = exact.receipt.providerReceipt.mergeCommit;
  const object = await execBoundGitAuthority(manifest.cwd, ["cat-file", "commit", mergeCommit], { encoding: "buffer" });
  const parents = rawCommitParents(object.stdout, mergeCommit, "Completed PR merge");
  if (parents[0] !== exact.remoteRevision ||
      (exact.mergeMethod === "merge" && (parents.length !== 2 || parents[1] !== exact.reviewedHead)) ||
      (exact.mergeMethod === "squash" && parents.length !== 1)) {
    throw new Error("Completed PR merge Git parents do not preserve the exact authorized base and reviewed head");
  }
  return verifyRequiredChecksProviderObservation(manifest.cwd, requiredChecks.receipt.payload,
    exact.providerExecutable, exact);
}

async function verifyRequiredChecksProviderObservation(
  cwd,
  payload,
  providerExecutable = null,
  successfulMerge = null
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
    (successfulMerge ? pull.state !== "closed" : pull.state !== "open") ||
    pull.draft !== false ||
    pull.head?.sha !== payload.head ||
    typeof pull.head?.ref !== "string" ||
    !pull.head.ref ||
    (successfulMerge
      ? (!SHA.test(pull.base?.sha ?? "") || pull.merged !== true ||
          pull.merge_commit_sha !== successfulMerge.receipt.providerReceipt.mergeCommit ||
          payload.base !== successfulMerge.remoteRevision || payload.head !== successfulMerge.reviewedHead ||
          payload.pr !== successfulMerge.pullRequest || payload.baseRefName !== successfulMerge.targetRef)
      : pull.base?.sha !== payload.base) ||
    pull.base?.ref !== payload.baseRefName
  ) {
    throw new Error(successfulMerge
      ? "Required checks evidence does not match the exact persisted successful merged pull request"
      : "Required checks evidence does not match the live open pull request");
  }
  const headRefName = pull.head.ref;
  const repositoryMetadata = JSON.parse((await execBoundGitHubCli(executablePath, [
    "api",
    `repos/${repositoryPath}`
  ], { cwd, encoding: "utf8" })).stdout);
  if (
    typeof repositoryMetadata.default_branch !== "string" ||
    !repositoryMetadata.default_branch ||
    repositoryMetadata.default_branch.includes("\0")
  ) {
    throw new Error("GitHub repository metadata has no valid default branch");
  }
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
  // GitHub's `deletion` and `non_fast_forward` rule types are prohibitions.
  // Their presence strengthens protection; the classic allow_* flags above
  // remain the independent proof that these operations are not permitted.
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
  const defaultBranchRef = `refs/heads/${repositoryMetadata.default_branch}`;
  const rulesetRequiredStatusChecks = [];
  let rulesetStrictBaseSynchronization = false;
  const normalizeRulesetCheckAppId = (value) => {
    if (value === undefined || value === null || value === "" || value === -1 || value === "-1") return null;
    const appId = Number(value);
    return Number.isInteger(appId) && appId >= 0 ? appId : undefined;
  };
  const refPatternMatches = (pattern) => {
    if (typeof pattern !== "string" || !pattern || pattern.includes("\0")) {
      throw new Error("Active branch ruleset contains an invalid ref-name pattern");
    }
    if (pattern === "~ALL") return true;
    if (pattern === "~DEFAULT_BRANCH") return branchRef === defaultBranchRef;
    if (pattern.startsWith("~")) {
      throw new Error(`Active branch ruleset contains an unsupported ref-name selector: ${pattern}`);
    }
    if (!/[?*]/.test(pattern)) return pattern === branchRef;
    if (/[\[\]\\]/.test(pattern)) {
      throw new Error(`Active branch ruleset contains an unsupported ref-name glob: ${pattern}`);
    }
    let expression = "";
    for (let index = 0; index < pattern.length; index += 1) {
      const character = pattern[index];
      if (character === "*" && pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else if (character === "*") {
        expression += "[^/]*";
      } else if (character === "?") {
        expression += "[^/]";
      } else {
        expression += character.replace(/[.+^${}()|]/g, "\\$&");
      }
    }
    return new RegExp(`^${expression}$`).test(branchRef);
  };
  for (const listed of activeRulesets) {
    const detail = JSON.parse((await execBoundGitHubCli(executablePath, [
      "api",
      `repos/${repositoryPath}/rulesets/${Number(listed.id)}`
    ], { cwd, encoding: "utf8" })).stdout);
    const includes = detail.conditions?.ref_name?.include;
    const excludes = detail.conditions?.ref_name?.exclude;
    if (detail.target === "branch" && (!Array.isArray(includes) || !Array.isArray(excludes))) {
      throw new Error("Active branch ruleset has no complete ref-name condition");
    }
    const includeMatches = detail.target === "branch" ? includes.map(refPatternMatches) : [];
    const excludeMatches = detail.target === "branch" ? excludes.map(refPatternMatches) : [];
    const appliesToTarget = (
      detail.target === "branch" &&
      includeMatches.some(Boolean) &&
      !excludeMatches.some(Boolean)
    );
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
    // Ruleset `deletion` and `non_fast_forward` entries are protective
    // restrictions, not permission grants.
    const requiredStatusRules = rules.filter((rule) => rule?.type === "required_status_checks");
    for (const requiredStatusRule of requiredStatusRules) {
      if (appliesToTarget && !Array.isArray(requiredStatusRule.parameters?.required_status_checks)) {
        throw new Error("Active protected branch ruleset has incomplete required status checks");
      }
      if (appliesToTarget) {
        if (typeof requiredStatusRule.parameters?.strict_required_status_checks_policy !== "boolean") {
          throw new Error("Active protected branch ruleset has incomplete strict status-check policy");
        }
        rulesetStrictBaseSynchronization ||= requiredStatusRule.parameters.strict_required_status_checks_policy === true;
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
  const protectionStrictBaseSynchronization = (
    protection.required_status_checks?.strict === true &&
    requiredStatusProtection.strict === true
  );
  if (!protectionStrictBaseSynchronization && !rulesetStrictBaseSynchronization) {
    throw new Error("Protected branch policy does not atomically require the PR head to be current with its base");
  }
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
  return {
    humanApproval,
    baseSynchronization: {
      provider: "github",
      policy: "strict-required-status-checks",
      enforced: true
    }
  };
}

async function assertPullEvidenceBinding(admittedEvidence, request, reviewPackage, contract, expectedRepository) {
  const pullMatch = /^pull\/(\d+)$/.exec(request.resource);
  if (!pullMatch) throw new Error("PR merge resources must use pull/<number>");
  const expectedBaseRef = protectedDeliveryTarget(contract);
  if (!expectedBaseRef) throw new Error("PR merge requires a bound Auto protected delivery target");
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
        payload?.baseRefName === expectedBaseRef
      );
    });
    if (!exact) {
      throw new Error(`Action token denied until ${kind} is bound to the exact reviewed PR head`);
    }
  }
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

export function assertRemoteSyncMergeBinding(admittedEvidence, reviewPackage, contract, expectedRepository) {
  const targetRef = protectedDeliveryTarget(contract);
  if (!targetRef) throw new Error("Remote synchronization requires a bound Auto protected delivery target");
  const exact = admittedEvidence
    .filter((item) => item.kind === "merge-result" && item.status === "complete" && !item.stale)
    .map((item) => item.receipt?.payload)
    .find((payload) => (
      payload?.outcome === "success" &&
      payload?.reviewPackageId === reviewPackage.packageId &&
      payload?.head === reviewPackage.head &&
      payload?.base === reviewPackage.base &&
      payload?.baseRefName === targetRef &&
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

export async function autonomousCommitAllocation() {
  throw publicAutoRunRequired("Legacy autonomous commit allocation");
}

function sourceBindingWithoutDigest(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return null;
  const { digest, ...payload } = binding;
  return { digest, payload };
}

const GOVERNED_COMMIT_BATCH_PROTOCOL = "staged-batches-v1";
const GOVERNED_COMMIT_BATCH_SCOPE = /^staged-batches-v1:([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

async function assertManualGitCommitIndexIsolated(cwd, { requireStagedDiff = true } = {}) {
  const unstaged = await execBoundGitAuthority(cwd, [
    "diff", "--no-ext-diff", "--quiet", "--"
  ], { allowFailure: true });
  if (!unstaged.ok && unstaged.code !== 1) {
    throw new Error("Governed Git commit could not verify the unstaged diff boundary");
  }
  if (!unstaged.ok) {
    throw new Error("Governed Git commit issuance requires every intended tracked change to be staged");
  }
  const untracked = await execBoundGitAuthority(cwd, [
    "ls-files", "--others", "--exclude-standard", "-z", "--"
  ], { encoding: "buffer" });
  if (untracked.stdout.byteLength > 0) {
    throw new Error("Governed Git commit issuance rejects untracked paths; add every intended path before issuing the token");
  }
  const staged = await execBoundGitAuthority(cwd, [
    "diff", "--cached", "--no-ext-diff", "--quiet", "--"
  ], { allowFailure: true });
  if (!staged.ok && staged.code !== 1) {
    throw new Error("Governed Git commit could not verify the staged diff boundary");
  }
  if (staged.ok && requireStagedDiff) {
    throw new Error("Governed Git commit issuance requires a non-empty staged diff");
  }
}

function normalizeGovernedCommitBatchPlan(payload) {
  if (
    !payload || typeof payload !== "object" || Array.isArray(payload) ||
    payload.batchProtocol !== GOVERNED_COMMIT_BATCH_PROTOCOL ||
    typeof payload.objective !== "string" || !payload.objective.trim() ||
    !/^[A-Za-z0-9._/-]+$/.test(payload.branch ?? "") ||
    !/^[A-Za-z0-9._/-]+$/.test(payload.targetBranch ?? "") ||
    !SHA.test(payload.baseRevision ?? "") || !SHA.test(payload.headRevision ?? "") ||
    !Array.isArray(payload.batches) || payload.batches.length < 2 || payload.batches.length > 64
  ) {
    throw new Error("Governed Git staged-batches-v1 requires a complete versioned commit plan");
  }
  const batchIds = new Set();
  const paths = new Set();
  const batches = payload.batches.map((batch, ordinal) => {
    if (
      !batch || typeof batch !== "object" || Array.isArray(batch) ||
      !SAFE_ID.test(batch.id ?? "") || batchIds.has(batch.id) ||
      !Array.isArray(batch.files) || batch.files.length === 0
    ) {
      throw new Error("Governed Git staged-batches-v1 contains an invalid or empty batch");
    }
    batchIds.add(batch.id);
    const files = [...batch.files];
    if (files.some((relative) => (
      typeof relative !== "string" || !relative || /[\0\r\n\t]/.test(relative) ||
      path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative ||
      relative === "." || relative === ".." || relative.startsWith("../")
    ))) {
      throw new Error("Governed Git staged-batches-v1 contains an unsafe repository path");
    }
    if (new Set(files).size !== files.length) {
      throw new Error("Governed Git staged-batches-v1 contains a duplicate path in one batch");
    }
    for (const relative of files) {
      if (paths.has(relative)) throw new Error("Governed Git staged-batches-v1 batches overlap");
      paths.add(relative);
    }
    return { id: batch.id, ordinal, paths: files.sort((left, right) => left.localeCompare(right)) };
  });
  const stable = {
    schemaVersion: 1,
    protocol: GOVERNED_COMMIT_BATCH_PROTOCOL,
    objective: payload.objective.trim(),
    branch: payload.branch,
    targetBranch: payload.targetBranch,
    baseRevision: payload.baseRevision.toLowerCase(),
    headRevision: payload.headRevision.toLowerCase(),
    batches
  };
  return {
    stable,
    digest: digestObject(stable),
    paths: [...paths].sort((left, right) => left.localeCompare(right))
  };
}

function parseGitIndexStageEntries(value, label) {
  const records = parseBoundGitNulPaths(value, label);
  const entries = new Map();
  for (const record of records) {
    const separator = record.indexOf("\t");
    const header = separator >= 0 ? record.slice(0, separator) : "";
    const relative = separator >= 0 ? record.slice(separator + 1) : "";
    const [mode, objectId, rawStage] = header.split(" ");
    const stage = Number(rawStage);
    if (
      !relative || !/^[0-7]{6}$/.test(mode ?? "") || !/^[a-f0-9]{40,64}$/i.test(objectId ?? "") ||
      !Number.isInteger(stage) || stage !== 0 || mode === "000000" || /^0+$/.test(objectId ?? "") ||
      entries.has(relative)
    ) {
      throw new Error(`${label} contains an unmerged, intent-to-add, or malformed index entry`);
    }
    entries.set(relative, { mode, objectId: objectId.toLowerCase() });
  }
  return entries;
}

function parseGitTreeEntries(value, label) {
  const records = parseBoundGitNulPaths(value, label);
  const entries = new Map();
  for (const record of records) {
    const separator = record.indexOf("\t");
    const header = separator >= 0 ? record.slice(0, separator) : "";
    const relative = separator >= 0 ? record.slice(separator + 1) : "";
    const [mode, type, objectId] = header.split(" ");
    if (
      !relative || !/^[0-7]{6}$/.test(mode ?? "") ||
      !["blob", "commit"].includes(type ?? "") || !/^[a-f0-9]{40,64}$/i.test(objectId ?? "") ||
      entries.has(relative)
    ) {
      throw new Error(`${label} contains a duplicate or malformed Git tree entry`);
    }
    entries.set(relative, { mode, type, objectId: objectId.toLowerCase() });
  }
  return entries;
}

async function captureGovernedGitIndexFile(cwd) {
  const indexPathResult = await execBoundGitAuthority(cwd, ["rev-parse", "--git-path", "index"]);
  const requestedPath = indexPathResult.stdout.trim();
  if (!requestedPath || /[\0\r\n]/.test(requestedPath)) {
    throw new Error("Governed Git index path is malformed");
  }
  const indexPath = path.resolve(cwd, requestedPath);
  const indexInfo = await lstat(indexPath);
  if (
    indexInfo.isSymbolicLink() || !indexInfo.isFile() ||
    indexInfo.uid !== (process.getuid?.() ?? indexInfo.uid) || (indexInfo.mode & 0o022) !== 0
  ) {
    throw new Error("Governed Git index must be a regular, owner-controlled file");
  }
  const indexFile = await realpath(indexPath);
  const digest = await digestSentinelFile(indexFile, Number.MAX_SAFE_INTEGER);
  if (digest.type !== "file" || typeof digest.digest !== "string") {
    throw new Error("Governed Git index could not be captured as a stable regular file");
  }
  return { path: indexFile, digest: digest.digest };
}

async function governedGitIndexTreeFromPrivateCopy(cwd, sourceIndex) {
  const currentIndex = await captureGovernedGitIndexFile(cwd);
  if (currentIndex.digest !== sourceIndex.digest || currentIndex.path !== sourceIndex.path) {
    throw new Error("Governed Git index changed before its private tree snapshot");
  }
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "sbw-governed-index-"));
  try {
    const canonicalTemporaryDirectory = await realpath(temporaryDirectory);
    const temporaryIndex = path.join(canonicalTemporaryDirectory, "index");
    await copyFile(sourceIndex.path, temporaryIndex, fsConstants.COPYFILE_EXCL);
    await chmod(temporaryIndex, 0o600);
    const copiedIndex = await digestSentinelFile(temporaryIndex, Number.MAX_SAFE_INTEGER);
    const sourceAfterCopy = await captureGovernedGitIndexFile(cwd);
    if (
      copiedIndex.type !== "file" || copiedIndex.digest !== sourceIndex.digest ||
      sourceAfterCopy.digest !== sourceIndex.digest || sourceAfterCopy.path !== sourceIndex.path
    ) {
      throw new Error("Governed Git index changed while creating its private tree snapshot");
    }
    const tree = await execBoundGitAuthority(cwd, ["write-tree"], { indexFile: temporaryIndex });
    const sourceAfterTree = await captureGovernedGitIndexFile(cwd);
    if (sourceAfterTree.digest !== sourceIndex.digest || sourceAfterTree.path !== sourceIndex.path) {
      throw new Error("Governed Git index changed while computing its private tree snapshot");
    }
    return { tree: tree.stdout.trim().toLowerCase() };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function captureGovernedCommitTreePathManifest(cwd, revision, paths) {
  const entries = new Map();
  for (let offset = 0; offset < paths.length; offset += 128) {
    const batch = paths.slice(offset, offset + 128);
    const result = await execBoundGitAuthority(cwd, [
      "ls-tree", "-r", "-z", "--full-tree", revision, "--", ...batch.map(literalGitPathspec)
    ], { encoding: "buffer" });
    for (const [relative, entry] of parseGitTreeEntries(result.stdout, "Governed Git tree snapshot")) {
      if (!batch.includes(relative)) throw new Error("Governed Git tree snapshot escaped its literal path scope");
      entries.set(relative, entry);
    }
  }
  return paths.map((relative) => ({ path: relative, entry: entries.get(relative) ?? null }));
}

async function captureGovernedCommitIndexSnapshot(cwd, paths, { requireStagedDiff = true } = {}) {
  await assertManualGitCommitIndexIsolated(cwd, { requireStagedDiff });
  const { hiddenIndexEntries } = await import("./git.mjs");
  const hidden = await hiddenIndexEntries(cwd);
  if (hidden.records.length > 0) {
    throw new Error("Governed Git staged-batches-v1 rejects hidden or skip-worktree index entries");
  }
  const sourceIndex = await captureGovernedGitIndexFile(cwd);
  const [headResult, stagedResult, indexTreeSnapshot] = await Promise.all([
    execBoundGitAuthority(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]),
    execBoundGitAuthority(cwd, [
      "diff", "--cached", "--no-renames", "--name-only", "-z", "--"
    ], { encoding: "buffer" }),
    governedGitIndexTreeFromPrivateCopy(cwd, sourceIndex)
  ]);
  const stagedPaths = parseBoundGitNulPaths(stagedResult.stdout, "Governed Git staged path list")
    .sort((left, right) => left.localeCompare(right));
  if (new Set(stagedPaths).size !== stagedPaths.length) {
    throw new Error("Governed Git staged path list contains duplicates");
  }
  const entries = new Map();
  for (let offset = 0; offset < paths.length; offset += 128) {
    const batch = paths.slice(offset, offset + 128);
    const result = await execBoundGitAuthority(cwd, [
      "ls-files", "--stage", "-z", "--", ...batch.map(literalGitPathspec)
    ], { encoding: "buffer" });
    for (const [relative, entry] of parseGitIndexStageEntries(result.stdout, "Governed Git index snapshot")) {
      if (!batch.includes(relative)) throw new Error("Governed Git index snapshot escaped its literal path scope");
      entries.set(relative, entry);
    }
  }
  const headPathManifest = await captureGovernedCommitTreePathManifest(cwd, headResult.stdout.trim(), paths);
  const [finalHead, finalIndex] = await Promise.all([
    execBoundGitAuthority(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]),
    captureGovernedGitIndexFile(cwd)
  ]);
  if (
    finalHead.stdout.trim().toLowerCase() !== headResult.stdout.trim().toLowerCase() ||
    finalIndex.digest !== sourceIndex.digest || finalIndex.path !== sourceIndex.path
  ) {
    throw new Error("Governed Git index or HEAD changed during the staged-batches-v1 snapshot");
  }
  return {
    headRevision: headResult.stdout.trim().toLowerCase(),
    indexTree: indexTreeSnapshot.tree,
    stagedPaths,
    pathManifest: paths.map((relative) => ({ path: relative, entry: entries.get(relative) ?? null })),
    headPathManifest
  };
}

function expectedGovernedCommitHeadPathManifest(anchor, completedBatchCount) {
  const committedPaths = new Set(anchor.plan.batches.slice(0, completedBatchCount)
    .flatMap((batch) => batch.paths));
  const candidateByPath = new Map(anchor.pathManifest.map((item) => [item.path, item.entry]));
  const baseByPath = new Map(anchor.baseTreePathManifest.map((item) => [item.path, item.entry]));
  return anchor.plan.batches.flatMap((batch) => batch.paths)
    .sort((left, right) => left.localeCompare(right))
    .map((relative) => {
      const candidate = candidateByPath.get(relative) ?? null;
      const entry = committedPaths.has(relative)
        ? candidate
          ? {
              mode: candidate.mode,
              type: candidate.mode === "160000" ? "commit" : "blob",
              objectId: candidate.objectId
            }
          : null
        : baseByPath.get(relative) ?? null;
      return { path: relative, entry };
    });
}

function normalizeCommitBatchAnchor(anchor) {
  if (
    !anchor || typeof anchor !== "object" || Array.isArray(anchor) ||
    anchor.schemaVersion !== 1 || anchor.protocol !== GOVERNED_COMMIT_BATCH_PROTOCOL ||
    !SHA256_DIGEST.test(anchor.planDigest ?? "") || !SHA.test(anchor.originalHeadRevision ?? "") ||
    !SHA.test(anchor.candidateIndexTree ?? "") || !SAFE_ID.test(anchor.anchorAttemptId ?? "") ||
    !Array.isArray(anchor.plan?.batches) || !Array.isArray(anchor.pathManifest) ||
    !Array.isArray(anchor.baseTreePathManifest) || !SHA256_DIGEST.test(anchor.baseTreePathManifestDigest ?? "") ||
    !SAFE_ID.test(anchor.planEvidenceId ?? "") || !SHA256_DIGEST.test(anchor.planEvidenceDigest ?? "")
  ) {
    throw new Error("Governed Git staged-batches-v1 anchor is malformed");
  }
  const planDigest = digestObject(anchor.plan);
  if (planDigest !== anchor.planDigest) {
    throw new Error("Governed Git staged-batches-v1 anchor plan digest changed");
  }
  const paths = anchor.plan.batches.flatMap((batch) => batch.paths ?? [])
    .sort((left, right) => left.localeCompare(right));
  if (
    paths.length === 0 || new Set(paths).size !== paths.length ||
    digestObject(paths) !== anchor.candidatePathsDigest ||
    digestObject(anchor.pathManifest) !== anchor.candidatePathManifestDigest ||
    digestObject(anchor.baseTreePathManifest) !== anchor.baseTreePathManifestDigest ||
    digestObject(anchor.pathManifest.map((item) => item.path).sort((left, right) => left.localeCompare(right))) !==
      anchor.candidatePathsDigest ||
    digestObject(anchor.baseTreePathManifest.map((item) => item.path).sort((left, right) => left.localeCompare(right))) !==
      anchor.candidatePathsDigest
  ) {
    throw new Error("Governed Git staged-batches-v1 anchor path manifest is incomplete or overlapping");
  }
  return { paths, batches: anchor.plan.batches };
}

function commitBatchBindingDigest(binding) {
  return isValidGovernedCommitBatchBinding(binding) ? binding.bindingDigest : null;
}

function isValidGovernedCommitBatchBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  const expectedKeys = [
    "anchorAttemptId", "batchCount", "batchId", "bindingDigest", "candidateIndexTree",
    "candidatePathManifestDigest", "expectedParentHead", "ordinal", "pathsAtIssue",
    "pathsAtIssueDigest", "planDigest", "planEvidenceDigest", "planEvidenceId",
    "previousActionAttemptId", "protocol", "remainingPathDigest", "remainingPaths",
    "schemaVersion", "selectedPathDigest", "selectedPaths"
  ];
  const pathsAreCanonical = (paths, { allowEmpty = false } = {}) => (
    Array.isArray(paths) &&
    (allowEmpty || paths.length > 0) &&
    paths.every((relative) => (
      typeof relative === "string" && relative.length > 0 && !/[\0\r\n\t]/.test(relative) &&
      !path.posix.isAbsolute(relative) && path.posix.normalize(relative) === relative &&
      relative !== "." && relative !== ".." && !relative.startsWith("../")
    )) &&
    new Set(paths).size === paths.length &&
    digestObject(paths) === digestObject([...paths].sort((left, right) => left.localeCompare(right)))
  );
  const {
    bindingDigest,
    selectedPaths,
    remainingPaths,
    pathsAtIssue,
    ...projection
  } = binding;
  try {
    if (
      digestObject(Object.keys(binding).sort()) !== digestObject(expectedKeys) ||
      binding.schemaVersion !== 1 || binding.protocol !== GOVERNED_COMMIT_BATCH_PROTOCOL ||
      !SAFE_ID.test(binding.anchorAttemptId ?? "") ||
      !SHA256_DIGEST.test(binding.planDigest ?? "") ||
      !SAFE_ID.test(binding.planEvidenceId ?? "") ||
      !SHA256_DIGEST.test(binding.planEvidenceDigest ?? "") ||
      !Number.isInteger(binding.ordinal) || binding.ordinal < 0 ||
      !SAFE_ID.test(binding.batchId ?? "") ||
      !Number.isInteger(binding.batchCount) || binding.batchCount < 2 || binding.batchCount > 64 ||
      binding.ordinal >= binding.batchCount ||
      (binding.ordinal === 0 ? binding.previousActionAttemptId !== null
        : !SAFE_ID.test(binding.previousActionAttemptId ?? "")) ||
      !SHA.test(binding.expectedParentHead ?? "") ||
      !SHA.test(binding.candidateIndexTree ?? "") ||
      !SHA256_DIGEST.test(binding.candidatePathManifestDigest ?? "") ||
      !pathsAreCanonical(selectedPaths) || !pathsAreCanonical(remainingPaths, { allowEmpty: true }) ||
      !pathsAreCanonical(pathsAtIssue) ||
      !SHA256_DIGEST.test(binding.selectedPathDigest ?? "") ||
      binding.selectedPathDigest !== digestObject(selectedPaths) ||
      !SHA256_DIGEST.test(binding.remainingPathDigest ?? "") ||
      binding.remainingPathDigest !== digestObject(remainingPaths) ||
      !SHA256_DIGEST.test(binding.pathsAtIssueDigest ?? "")
    ) return false;
    const allPaths = [...selectedPaths, ...remainingPaths].sort((left, right) => left.localeCompare(right));
    return new Set(allPaths).size === allPaths.length &&
      digestObject(pathsAtIssue) === digestObject(allPaths) &&
      binding.pathsAtIssueDigest === digestObject(pathsAtIssue) &&
      SHA256_DIGEST.test(bindingDigest ?? "") &&
      digestObject({ ...projection, selectedPaths, remainingPaths, pathsAtIssue }) === bindingDigest;
  } catch {
    return false;
  }
}

async function resolveGovernedCommitBatchIssueBinding(root, runId, runContext, actions, request, admittedEvidence, attemptId) {
  const { manifest, contract, state, runDir } = runContext;
  const scopeMatch = GOVERNED_COMMIT_BATCH_SCOPE.exec(request.scope ?? "");
  const hasProtocolScope = typeof request.scope === "string" && request.scope.startsWith(`${GOVERNED_COMMIT_BATCH_PROTOCOL}:`);
  const planRecords = admittedEvidence.filter((item) => item.kind === "commit-plan" && item.status === "complete" && !item.stale);
  const versionedPlans = planRecords.filter((item) => item.receipt?.payload?.batchProtocol === GOVERNED_COMMIT_BATCH_PROTOCOL);
  if (!scopeMatch && !hasProtocolScope && versionedPlans.length === 0) return null;
  if (!scopeMatch || versionedPlans.length !== 1 || planRecords.length !== 1) {
    throw new Error("Governed Git staged-batches-v1 requires one fresh versioned commit plan and an exact batch scope");
  }
  const batchId = scopeMatch[1];
  const planRecord = versionedPlans[0];
  const normalized = normalizeGovernedCommitBatchPlan(planRecord.receipt.payload);
  const expectedTarget = protectedDeliveryTarget(contract);
  if (
    (expectedTarget && normalized.stable.targetBranch !== expectedTarget) ||
    (manifest.remoteRevision && normalized.stable.baseRevision !== manifest.remoteRevision.toLowerCase())
  ) {
    throw new Error("Governed Git staged-batches-v1 target or base differs from the immutable delivery contract");
  }
  const selectedBatch = normalized.stable.batches.find((batch) => batch.id === batchId);
  if (!selectedBatch) throw new Error("Governed Git staged-batches-v1 scope names an unknown batch");
  if (request.action !== "git.commit" || request.provider !== "git" || request.resource !== "git:commit") {
    throw new Error("Governed Git staged-batches-v1 is limited to manual git.commit actions");
  }
  if (manifest.autonomyProfile) {
    throw new Error("Governed Git staged-batches-v1 does not combine with bounded autopilot");
  }
  const priorCommitActions = actions.filter((item) => item.action === "git.commit");
  if (priorCommitActions.some((item) => !item.commitBatchBinding)) {
    throw new Error("Governed Git staged-batches-v1 requires a fresh run without legacy commit attempts");
  }
  if (priorCommitActions.some((item) => (
    item.status === "issued" || (item.status === "spent" && ["pending", "unknown"].includes(item.outcome))
  ))) {
    throw new Error("Governed Git staged-batches-v1 blocks while another commit attempt is unresolved");
  }
  const anchors = priorCommitActions.filter((item) => item.commitBatchAnchor);
  if (anchors.length > 1) throw new Error("Governed Git staged-batches-v1 has duplicate plan anchors");
  const branch = (await execBoundGitAuthority(manifest.cwd, ["branch", "--show-current"])).stdout.trim();
  if (branch !== normalized.stable.branch) {
    throw new Error("Governed Git staged-batches-v1 source branch differs from the reviewed commit plan");
  }
  const candidatePaths = normalized.paths;
  const indexSnapshot = await captureGovernedCommitIndexSnapshot(manifest.cwd, candidatePaths);
  let anchor;
  let nextOrdinal = 0;
  let expectedParentHead = normalized.stable.headRevision;
  let previousActionAttemptId = null;
  if (anchors.length === 0) {
    if (
      priorCommitActions.length > 0 || indexSnapshot.headRevision !== normalized.stable.headRevision ||
      digestObject(indexSnapshot.stagedPaths) !== digestObject(candidatePaths)
    ) {
      throw new Error("Governed Git staged-batches-v1 first action does not match the complete candidate index");
    }
    anchor = {
      schemaVersion: 1,
      protocol: GOVERNED_COMMIT_BATCH_PROTOCOL,
      plan: normalized.stable,
      planDigest: normalized.digest,
      planEvidenceId: planRecord.id,
      planEvidenceDigest: digestObject(planRecord),
      anchorAttemptId: attemptId,
      originalHeadRevision: indexSnapshot.headRevision,
      candidateIndexTree: indexSnapshot.indexTree,
      candidatePathsDigest: digestObject(candidatePaths),
      pathManifest: indexSnapshot.pathManifest,
      candidatePathManifestDigest: digestObject(indexSnapshot.pathManifest),
      baseTreePathManifest: indexSnapshot.headPathManifest,
      baseTreePathManifestDigest: digestObject(indexSnapshot.headPathManifest)
    };
  } else {
    const anchorAction = anchors[0];
    anchor = anchorAction.commitBatchAnchor;
    const normalizedAnchor = normalizeCommitBatchAnchor(anchor);
    const successful = priorCommitActions
      .filter((item) => item.commitBatchBinding?.planDigest === anchor.planDigest && item.outcome === "success")
      .sort((left, right) => left.commitBatchBinding.ordinal - right.commitBatchBinding.ordinal);
    if (
      digestObject(normalized.stable) !== anchor.planDigest ||
      normalized.digest !== anchor.planDigest ||
      digestObject(candidatePaths) !== anchor.candidatePathsDigest ||
      priorCommitActions.some((item) => item.commitBatchBinding?.planDigest !== anchor.planDigest) ||
      successful.length > anchor.plan.batches.length ||
      successful.some((item, ordinal) => (
        item.commitBatchBinding.ordinal !== ordinal ||
        item.commitBatchBindingDigest !== item.commitBatchBinding.bindingDigest ||
        item.sourceBindingTransition?.commitBatchBindingDigest !== item.commitBatchBinding.bindingDigest
      ))
    ) {
      throw new Error("Governed Git staged-batches-v1 action history diverged from its immutable plan");
    }
    nextOrdinal = successful.length;
    if (nextOrdinal >= anchor.plan.batches.length) {
      throw new Error("Governed Git staged-batches-v1 plan has no remaining batch");
    }
    const last = successful.at(-1);
    for (const priorAction of successful) {
      const priorReceipt = priorAction.receipt;
      validateActionReceipt(priorAction, "success", priorReceipt);
      await validateActionEvidenceBinding(root, runDir, priorAction, priorAction.attemptId, "success", priorReceipt, {
        allowStale: true,
        expectedProjection: priorAction.sourceBindingTransition?.actionReceiptEvidence
      });
      await verifyProviderReceipt(manifest, priorAction, priorReceipt, contract);
      await governedCommitHistoricalEvidenceAuthority(
        root,
        runId,
        { runDir, manifest, contract, state },
        priorAction,
        "Next staged-batch action issuance"
      );
      await validateGovernedCommitHistoricalSourceTransition(
        root,
        runDir,
        contract,
        priorAction,
        priorReceipt
      );
    }
    if (last) {
      previousActionAttemptId = last.attemptId;
      expectedParentHead = last.receipt?.providerReceipt?.revision;
      if (
        !SHA.test(expectedParentHead ?? "") ||
        !last.sourceBindingTransition ||
        last.sourceBindingTransition.headRevision !== expectedParentHead
      ) {
        throw new Error("Governed Git staged-batches-v1 predecessor transition is not complete");
      }
    } else {
      expectedParentHead = anchor.originalHeadRevision;
    }
    const remainingBefore = anchor.plan.batches.slice(nextOrdinal)
      .flatMap((batch) => batch.paths)
      .sort((left, right) => left.localeCompare(right));
    const expectedHeadPaths = expectedGovernedCommitHeadPathManifest(anchor, nextOrdinal);
    if (
      selectedBatch.ordinal !== nextOrdinal || selectedBatch.id !== anchor.plan.batches[nextOrdinal].id ||
      indexSnapshot.headRevision !== expectedParentHead ||
      indexSnapshot.indexTree !== anchor.candidateIndexTree ||
      digestObject(indexSnapshot.pathManifest) !== anchor.candidatePathManifestDigest ||
      digestObject(indexSnapshot.headPathManifest) !== digestObject(expectedHeadPaths) ||
      digestObject(indexSnapshot.stagedPaths) !== digestObject(remainingBefore)
    ) {
      throw new Error("Governed Git staged-batches-v1 next action does not match the exact remaining candidate index");
    }
    const futureFailures = priorCommitActions.filter((item) => (
      item.outcome === "failure" && item.commitBatchBinding.ordinal > nextOrdinal
    ));
    if (futureFailures.length > 0) {
      throw new Error("Governed Git staged-batches-v1 has a failure receipt beyond the next batch");
    }
  }
  if (selectedBatch.ordinal !== nextOrdinal || batchId !== anchor.plan.batches[nextOrdinal].id) {
    throw new Error("Governed Git staged-batches-v1 action is out of order");
  }
  const remainingPaths = anchor.plan.batches.slice(nextOrdinal + 1)
    .flatMap((batch) => batch.paths)
    .sort((left, right) => left.localeCompare(right));
  const bindingProjection = {
    schemaVersion: 1,
    protocol: GOVERNED_COMMIT_BATCH_PROTOCOL,
    anchorAttemptId: anchor.anchorAttemptId,
    planDigest: anchor.planDigest,
    planEvidenceId: planRecord.id,
    planEvidenceDigest: digestObject(planRecord),
    ordinal: nextOrdinal,
    batchId,
    batchCount: anchor.plan.batches.length,
    previousActionAttemptId,
    expectedParentHead,
    candidateIndexTree: anchor.candidateIndexTree,
    candidatePathManifestDigest: anchor.candidatePathManifestDigest,
    selectedPaths: selectedBatch.paths,
    selectedPathDigest: digestObject(selectedBatch.paths),
    remainingPaths,
    remainingPathDigest: digestObject(remainingPaths),
    pathsAtIssue: [...selectedBatch.paths, ...remainingPaths]
      .sort((left, right) => left.localeCompare(right)),
    pathsAtIssueDigest: digestObject([...selectedBatch.paths, ...remainingPaths]
      .sort((left, right) => left.localeCompare(right)))
  };
  return {
    binding: { ...bindingProjection, bindingDigest: digestObject(bindingProjection) },
    ...(anchors.length === 0 ? { anchor } : {})
  };
}

async function resolveGovernedCommitBatchAnchor(root, runId, record) {
  if (record.commitBatchAnchor) return record.commitBatchAnchor;
  const actions = await listJsonRecords(root, safeJoin(runDirectory(root, runId), "actions"));
  const anchorAction = actions.find((item) => item.attemptId === record.commitBatchBinding?.anchorAttemptId);
  return anchorAction?.commitBatchAnchor ?? null;
}

async function assertGovernedCommitBatchPrecondition(root, runId, manifest, record) {
  const binding = record.commitBatchBinding;
  const bindingDigest = commitBatchBindingDigest(binding);
  if (
    binding?.protocol !== GOVERNED_COMMIT_BATCH_PROTOCOL || !bindingDigest ||
    record.commitBatchBindingDigest !== bindingDigest ||
    record.scope !== `${GOVERNED_COMMIT_BATCH_PROTOCOL}:${binding.batchId}`
  ) {
    throw new Error("Governed Git staged-batches-v1 action binding is malformed");
  }
  const anchor = await resolveGovernedCommitBatchAnchor(root, runId, record);
  const normalized = normalizeCommitBatchAnchor(anchor);
  const batch = normalized.batches[binding.ordinal];
  if (
    binding.anchorAttemptId !== anchor.anchorAttemptId ||
    (record.attemptId === anchor.anchorAttemptId && (
      binding.planEvidenceId !== anchor.planEvidenceId ||
      binding.planEvidenceDigest !== anchor.planEvidenceDigest
    )) ||
    binding.planEvidenceId !== record.evidenceGateProjection?.evidence?.find((item) => (
      item.evidenceId === binding.planEvidenceId
    ))?.evidenceId ||
    binding.planEvidenceDigest !== record.evidenceGateProjection?.evidence?.find((item) => (
      item.evidenceId === binding.planEvidenceId
    ))?.evidenceDigest ||
    !batch || batch.id !== binding.batchId || binding.batchCount !== normalized.batches.length ||
    binding.planDigest !== anchor.planDigest || binding.candidateIndexTree !== anchor.candidateIndexTree ||
    binding.candidatePathManifestDigest !== anchor.candidatePathManifestDigest ||
    digestObject(binding.selectedPaths) !== digestObject(batch.paths) ||
    digestObject(batch.paths) !== binding.selectedPathDigest ||
    digestObject(binding.remainingPaths) !== binding.remainingPathDigest ||
    digestObject([...batch.paths, ...binding.remainingPaths].sort((left, right) => left.localeCompare(right))) !==
      binding.pathsAtIssueDigest
  ) {
    throw new Error("Governed Git staged-batches-v1 action does not match its immutable anchor");
  }
  const indexSnapshot = await captureGovernedCommitIndexSnapshot(
    manifest.cwd,
    normalized.paths,
    { requireStagedDiff: true }
  );
  const expectedHeadPaths = expectedGovernedCommitHeadPathManifest(anchor, binding.ordinal);
  if (
    indexSnapshot.headRevision !== binding.expectedParentHead ||
    indexSnapshot.indexTree !== binding.candidateIndexTree ||
    digestObject(indexSnapshot.pathManifest) !== anchor.candidatePathManifestDigest ||
    digestObject(indexSnapshot.headPathManifest) !== digestObject(expectedHeadPaths) ||
    digestObject(indexSnapshot.stagedPaths) !== binding.pathsAtIssueDigest
  ) {
    throw new Error("Governed Git staged-batches-v1 index or HEAD changed after token issuance");
  }
  return indexSnapshot;
}

async function governedCommitBatchExpiryPreconditionDigest(root, runId, manifest, contract, record) {
  const indexSnapshot = await assertGovernedCommitBatchPrecondition(root, runId, manifest, record);
  const issueSource = record.sourceAuthorityAtIssue;
  const issueBinding = issueSource?.sourceBinding;
  const issueSentinel = issueSource?.sourceSentinel;
  if (
    !issueBinding || !SHA256_DIGEST.test(issueBinding.digest ?? "") ||
    !issueSentinel || !SHA256_DIGEST.test(issueSentinel.digest ?? "") ||
    !SHA256_DIGEST.test(issueSentinel.recordDigest ?? "")
  ) {
    throw new Error("Expired staged-batch token lacks its immutable source and sentinel precondition");
  }
  const { captureSentinel, captureSourceBinding } = await import("./git.mjs");
  const [branch, sourceBinding] = await Promise.all([
    execBoundGitAuthority(manifest.cwd, ["branch", "--show-current"]).then((result) => result.stdout.trim()),
    captureSourceBinding(manifest.cwd, {
      baseRevision: issueBinding.baseRevision,
      requireClean: false
    })
  ]);
  const anchor = await resolveGovernedCommitBatchAnchor(root, runId, record);
  const sentinel = await captureSentinel(manifest.cwd, contract, await loadDefaults());
  if (branch !== anchor?.plan?.branch) {
    throw new Error("Expired staged-batch token source branch changed before expiry");
  }
  if (
    !sourceBinding ||
    digestObject(autonomousCommitSourceIdentity(sourceBinding)) !==
      digestObject(autonomousCommitSourceIdentity(issueBinding)) ||
    sourceBinding.headRevision !== issueBinding.headRevision
  ) {
    throw new Error("Expired staged-batch token source binding changed before expiry");
  }
  if (sentinel.complete !== true || sentinel.digest !== issueSentinel.digest) {
    throw new Error("Expired staged-batch token source sentinel changed before expiry");
  }
  if (stableSentinelRecordDigest(sentinel) !== issueSentinel.recordDigest) {
    throw new Error("Expired staged-batch token source sentinel record changed before expiry");
  }
  return digestObject({
    schemaVersion: 1,
    kind: "governed-commit-token-expiry-precondition",
    actionAttemptId: record.attemptId,
    tokenHash: record.tokenHash,
    commitBatchBindingDigest: record.commitBatchBindingDigest,
    branch,
    sourceBindingDigest: sourceBinding.digest,
    sourceSentinelDigest: sentinel.digest,
    sourceSentinelRecordDigest: stableSentinelRecordDigest(sentinel),
    indexSnapshot
  });
}

async function expireGovernedCommitBatchTokens(root, runId, runContext, actions, admittedEvidence) {
  const { runDir, manifest, contract } = runContext;
  const commitBatchActions = actions.filter((item) => item.commitBatchBinding);
  if (commitBatchActions.some((item) => (
    item.action !== "git.commit" || item.provider !== "git" || item.resource !== "git:commit" ||
    item.autonomyDecision?.decision === "auto-approved"
  ))) {
    throw new Error("Governed Git staged-batches-v1 action history contains a non-manual commit attempt");
  }
  const priorCommitActions = actions.filter((item) => item.action === "git.commit");
  if (priorCommitActions.some((item) => item.status === "expired")) {
    const journal = await readJournalRecords(root, runDir);
    for (const action of priorCommitActions.filter((item) => item.status === "expired")) {
      if (!isVerifiedStagedCommitTokenExpiry(action, journal)) {
        throw new Error("Governed Git staged-batches-v1 contains an unjournaled or malformed expired token");
      }
    }
  }
  const planRecords = admittedEvidence.filter((item) => (
    item.kind === "commit-plan" && item.status === "complete" && !item.stale
  ));
  const versionedPlans = planRecords.filter((item) => (
    item.receipt?.payload?.batchProtocol === GOVERNED_COMMIT_BATCH_PROTOCOL
  ));
  if (versionedPlans.length !== 1 || planRecords.length !== 1) return actions;
  const currentPlan = normalizeGovernedCommitBatchPlan(versionedPlans[0].receipt.payload);
  const journal = await readJournalRecords(root, runDir);
  const updated = [...actions];
  for (const action of priorCommitActions) {
    if (
      action.status !== "issued" ||
      action.action !== "git.commit" || action.provider !== "git" || action.resource !== "git:commit" ||
      !action.commitBatchBinding || action.autonomyDecision?.decision === "auto-approved"
    ) continue;
    const expiresAt = Date.parse(action.expiresAt ?? "");
    if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) continue;
    if (currentPlan.digest !== action.commitBatchBinding.planDigest) {
      throw new Error("Expired staged-batch token cannot be retired under a changed commit plan");
    }
    const preconditionDigest = await governedCommitBatchExpiryPreconditionDigest(
      root,
      runId,
      manifest,
      contract,
      action
    );
    const existingEvents = journal.filter((item) => (
      item.event === "action.commit-batch-expired" && item.attemptId === action.attemptId
    ));
    if (existingEvents.length > 1) {
      throw new Error("Expired staged-batch token has duplicate expiry journal events");
    }
    const existingReceipt = existingEvents[0]?.expirationReceipt ?? null;
    const expirationReceipt = existingReceipt ?? {
      schemaVersion: 1,
      kind: "governed-commit-token-expired",
      actionAttemptId: action.attemptId,
      tokenHash: action.tokenHash,
      commitBatchBindingDigest: action.commitBatchBindingDigest,
      batchId: action.commitBatchBinding.batchId,
      ordinal: action.commitBatchBinding.ordinal,
      expiresAt: action.expiresAt,
      expiredAt: nowIso(),
      preconditionDigest
    };
    const expirationReceiptDigest = digestObject(expirationReceipt);
    if (
      expirationReceipt.actionAttemptId !== action.attemptId ||
      expirationReceipt.tokenHash !== action.tokenHash ||
      expirationReceipt.commitBatchBindingDigest !== action.commitBatchBindingDigest ||
      expirationReceipt.batchId !== action.commitBatchBinding.batchId ||
      expirationReceipt.ordinal !== action.commitBatchBinding.ordinal ||
      expirationReceipt.expiresAt !== action.expiresAt ||
      expirationReceipt.preconditionDigest !== preconditionDigest ||
      !Number.isFinite(Date.parse(expirationReceipt.expiredAt ?? "")) ||
      Date.parse(expirationReceipt.expiredAt) < expiresAt
    ) {
      throw new Error("Expired staged-batch token journal does not match the live no-effect precondition");
    }
    if (!existingEvents.length) {
      await appendJournal(root, runDir, "action.commit-batch-expired", {
        attemptId: action.attemptId,
        tokenHash: action.tokenHash,
        expirationReceipt,
        expirationReceiptDigest
      });
    } else if (
      existingEvents[0].tokenHash !== action.tokenHash ||
      existingEvents[0].expirationReceiptDigest !== expirationReceiptDigest
    ) {
      throw new Error("Expired staged-batch token journal receipt changed during recovery");
    }
    const next = {
      ...action,
      status: "expired",
      outcome: null,
      expirationReceipt,
      expirationReceiptDigest
    };
    await atomicWriteJson(root, safeJoin(runDir, "actions", `${action.tokenHash}.json`), next);
    updated[updated.findIndex((item) => item.tokenHash === action.tokenHash)] = next;
  }
  return updated;
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

function literalGitPathspec(relative) {
  return `:(literal)${relative}`;
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
    const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
    const state = await readJson(root, safeJoin(runDir, "state.json"));
    assertMutableRun({ contract, manifest, state }, "Action token issuance");
    assertActionTokenContractVersion(contract, "Action token issuance");
    assertActionIsNotDeferred(contract, request.action);
    if (contract.controlPlane?.reviewPolicy === "code-v2-pilot") {
      throw new Error("Action token denied because code-v2-pilot is shadow-only and cannot authorize side effects");
    }
    const findings = await listJsonRecords(root, safeJoin(runDir, "findings"));
    const evidence = await listEffectiveEvidenceRecords(root, runId, {
      run: { runDir, manifest, contract, state }
    });
    const evidenceSupersessionFreshnessDigest = contract.schemaVersion === 2
      ? await currentEvidenceSupersessionFreshnessDigest(root, { runDir, manifest, contract, state })
      : null;
    let actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
    for (const action of actions) {
      assertPublicAutoActionRecord(action, "Action token issuance");
    }
    await assertGovernedCommitIssuedProofInventory(root, { runDir, manifest, contract, state }, actions);
    if (
      request.action === "pr.create" &&
      actions.some((action) => action.action === "pr.create" && action.status === "spent" && action.outcome === "success")
    ) {
      throw new Error("PR creation already succeeded for this run; reuse the registered pull request");
    }
    assertProtectedDeliveryRequest(contract, request);
    if (request.action === "pr.merge" && isProtectedDeliveryTemplate(contract)) {
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
          state,
          root,
          runDir,
          requireReconciled: true
        });
      }
      admittedEvidence = evidence.filter((item) => (
        item.schemaVersion === 2 && item.typedAdmission && item.stale !== true
      ));
    }
    if (
      request.action === "git.commit" && request.provider === "git" &&
      typeof request.scope === "string" &&
      request.scope.startsWith(`${GOVERNED_COMMIT_BATCH_PROTOCOL}:`)
    ) {
      actions = await expireGovernedCommitBatchTokens(
        root,
        runId,
        { runDir, manifest, contract },
        actions,
        admittedEvidence
      );
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
    const requiresTargetEvidence = request.requiredEvidence.includes(targetEvidenceKind(contract));
    if (requiresTargetEvidence || request.action === "pr.merge" || needsProviderAuthorization) {
      repository = await currentRepositoryIdentity(manifest.cwd);
      if (requiresTargetEvidence || request.action === "pr.merge") {
        assertDeliveryTargetEvidence(admittedEvidence, request, repository, contract.remoteRevision ?? null, contract);
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
      const currentSourceBinding = await assertCurrentGitPushSourceBinding(manifest);
      const destination = await resolveGitPushDestination(manifest.cwd, remote);
      const { pushUrl, pushUrlDigest, remoteRepository, sourceRemoteBindingDigest } = destination;
      if (sourceRemoteBindingDigest !== currentSourceBinding.originIdentity.digest) {
        throw new Error("Git push destination differs from the immutable source remote binding");
      }
      if (remoteRepository !== repository) {
        throw new Error("Git push effective destination must match the authorized origin repository");
      }
      if (isProtectedDeliveryTemplate(contract) && (remote !== "origin" || remoteRepository !== repository)) {
        throw new Error(`${contract.template} git.push must use the canonical origin repository`);
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
      if (isProtectedDeliveryTemplate(contract)) {
        const currentBranch = (await execBoundGitAuthority(manifest.cwd, ["branch", "--show-current"])).stdout.trim();
        const currentBranchEvidence = admittedEvidence.find((item) => (
          item.kind === "current-branch" && item.status === "complete" && !item.stale &&
          item.receipt?.payload?.revision === expectedRevision &&
          [expectedBranch, `refs/heads/${expectedBranch}`].includes(item.receipt?.payload?.ref)
        ));
        if (currentBranch !== expectedBranch || !currentBranchEvidence) {
          throw new Error(`${contract.template} git.push must bind the current branch evidence to the pushed commit`);
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
      const targetRef = protectedDeliveryTarget(contract);
      if (typeof targetRef !== "string" || !/^[A-Za-z0-9._/-]+$/.test(targetRef)) {
        throw new Error("PR creation requires a bound Auto protected delivery target");
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
      const mergeMethod = String(request.mergeMethod ?? "merge");
      if (!["merge", "squash"].includes(mergeMethod)) {
        throw new Error("Governed PR merge method must be merge or squash");
      }
      const currentHead = (await execBoundGitAuthority(manifest.cwd, [
        "rev-parse", "--verify", "HEAD^{commit}"
      ])).stdout.trim();
      actionBinding = buildPrMergeActionBinding({
        prior: actionBinding,
        pullRequest,
        reviewedHead: currentHead,
        remoteRevision: request.remoteRevision,
        targetRef: protectedDeliveryTarget(contract),
        mergeMethod,
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
    if (
      request.action === "git.commit" && !actionBinding.preCommitSourceBinding &&
      manifest.sourceBinding
    ) {
      if (
        manifest.sourceBinding.schemaVersion !== 3 ||
        !SHA256_DIGEST.test(manifest.sourceBinding.digest ?? "") ||
        !SHA.test(manifest.sourceBinding.headRevision ?? "")
      ) {
        throw new Error("Governed Git commit issuance requires a schema-3 operational source binding");
      }
      actionBinding.preCommitSourceBinding = manifest.sourceBinding;
      actionBinding.preCommitHeadRevision = manifest.sourceBinding.headRevision;
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
        isProtectedDeliveryTemplate(contract) &&
        !actions.some((action) => (
          action.action === "remote.sync" &&
          action.status === "spent" &&
          action.outcome === "success" &&
          action.resource === `refs/heads/${protectedDeliveryTarget(contract)}` &&
          action.receipt?.providerReceipt?.providerRevision === action.mergeCommit &&
          action.receipt?.providerReceipt?.localRevision === action.mergeCommit
        ))
      ) {
        throw new Error(`${contract.template} cleanup requires a successful reconciled remote.sync action`);
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
    // Check the mutable index only after every policy/evidence/stage gate has
    // passed. Governed commits freeze one exact staged batch before the token
    // exists; the consume/reconcile path revalidates that binding.
    if (request.action === "git.commit") {
      await assertManualGitCommitIndexIsolated(manifest.cwd);
    }
    const attemptId = randomUUID();
    let commitBatchAnchor = null;
    if (request.action === "git.commit") {
      const batchIssue = await resolveGovernedCommitBatchIssueBinding(
        root,
        runId,
        { runDir, manifest, contract, state },
        actions,
        request,
        admittedEvidence,
        attemptId
      );
      if (batchIssue) {
        actionBinding = {
          ...actionBinding,
          commitBatchBinding: batchIssue.binding,
          commitBatchBindingDigest: batchIssue.binding.bindingDigest
        };
        commitBatchAnchor = batchIssue.anchor ?? null;
      }
    }
    const providerRepository = creationReservation?.repository ??
      actionBinding.remoteRepository ??
      actionBinding.createRepository ??
      actionBinding.dispatchRepository ??
      (request.provider === "github-cli"
        ? repository ?? await currentRepositoryIdentity(manifest.cwd)
        : request.provider !== "git" || request.action === "git.commit"
          ? `workspace:${sha256(await realpath(manifest.cwd))}`
          : await currentGitProviderIdentity(manifest.cwd));
    actionBinding = { ...actionBinding, providerRepository };
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    const idempotencyKey = `sbw-${runId}-${randomUUID()}`;
    const reservationOwner = {
      runId,
      attemptId,
      tokenHash,
      idempotencyKey
    };
    const persistedScope = request.action === "pr.create" && isProtectedDeliveryTemplate(contract)
      ? protectedDeliveryTarget(contract)
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
        await reserveCreationResource(root, creationReservation, reservationOwner, expiresAt);
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
      let record = {
        schemaVersion: 1,
        tokenHash,
        attemptId,
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
        ...(commitBatchAnchor ? { commitBatchAnchor } : {}),
        ...(creationPrecondition ? { creationPrecondition } : {}),
        treeDigest: currentTreeDigest,
        contractDigest: digestObject(contract),
        ...(finalEvidenceSupersessionFreshnessDigest
          ? { evidenceSupersessionFreshnessDigest: finalEvidenceSupersessionFreshnessDigest }
          : {}),
        ...(finalActionEvidenceGateBinding
          ? {
              evidenceGate: finalActionEvidenceGateBinding.configuredGate,
              evidenceGateDigest: finalActionEvidenceGateBinding.digest,
              evidenceGateProjection: finalActionEvidenceGateBinding.projection,
              sourceAuthorityAtIssue: await actionSourceAuthoritySnapshot(
                root,
                runDir,
                manifest,
                state,
                finalActionEvidenceGateBinding.projection
              )
            }
          : {}),
        idempotencyKey
      };
      let governedCommitProof = null;
      if (ordinaryGovernedCommit(record)) {
        record = {
          ...record,
          governedCommitReplay: { protocol: GOVERNED_COMMIT_ISSUED_PROOF_PROTOCOL, version: 1 }
        };
        governedCommitProof = await prepareGovernedCommitIssuedProof(root, await loadRun(root, runId), record);
        await writeGovernedCommitIssuedProof(root, runDir, governedCommitProof);
        record = {
          ...record,
          governedCommitIssuedProof: {
            version: 1,
            proofDigest: governedCommitProof.proofDigest,
            issuedActionDigest: governedCommitProof.issuedActionDigest
          }
        };
      }
      await atomicWriteJson(root, safeJoin(runDir, "actions", `${tokenHash}.json`), record);
      await appendJournal(root, runDir, "action.issued", {
        action: record.action,
        provider: record.provider,
        resource: record.resource,
        tokenHash,
        autonomyDecision: record.autonomyDecision ?? null,
        autonomyDecisionReceipt: record.autonomyDecisionReceipt ?? null,
        commitBatchBindingDigest: record.commitBatchBindingDigest ?? null,
        ...(governedCommitProof ? {
          runId, attemptId,
          governedCommitIssuedProofVersion: 1,
          issuedProofDigest: governedCommitProof.proofDigest,
          issuedActionDigest: governedCommitProof.issuedActionDigest
        } : {})
      });
      if (governedCommitProof) {
        const deliverRun = await loadRun(root, runId);
        const delivered = await readJson(root, safeJoin(runDir, "actions", `${tokenHash}.json`));
        await assertGovernedCommitIssuedProofInventory(root, deliverRun, []);
        const deliveredProof = await loadGovernedCommitIssuedProof(root, deliverRun, delivered);
        if (!deliveredProof || digestObject(delivered) !== digestObject(record) ||
            deliveredProof.proofDigest !== governedCommitProof.proofDigest) {
          throw new Error("Governed commit persisted ISSUE action changed before token delivery");
        }
        const deliverGate = await currentActionEvidenceGateBinding(root, runId, deliverRun, delivered.action);
        const deliveryReadback = await readJson(root, safeJoin(runDir, "actions", `${tokenHash}.json`));
        if (deliverGate.digest !== delivered.evidenceGateDigest || digestObject(deliveryReadback) !== digestObject(delivered)) {
          throw new Error("Governed commit ISSUE binding changed before token delivery");
        }
      }
      return { token, ...record };
    } catch (error) {
      if (reservationHeld) await releaseCreationResource(root, creationReservation, reservationOwner);
      throw error;
    }
  });
}

async function consumeActionTokenInternal(root, runId, token, currentTreeDigest, allowWrapperExecution = false) {
  const tokenHash = sha256(token);
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Action token consumption");
    const { state, contract } = run;
    const target = safeJoin(runDir, "actions", `${tokenHash}.json`);
    const record = await readJson(root, target);
    assertPublicAutoActionRecord(record, "Action token consumption");
    await assertGovernedCommitIssuedProofInventory(root, run, await listJsonRecords(root, safeJoin(runDir, "actions")));
    await loadGovernedCommitIssuedProof(root, run, record);
    if (record.tokenHash !== tokenHash) throw new Error("Action token hash binding changed");
    assertSupportedGovernedAction(record.action);
    assertActionTokenContractVersion(contract, "Action token consumption");
    assertActionIsNotDeferred(contract, record.action);
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
      await assertCreationReservation(
        root,
        record.creationReservation,
        creationReservationOwnerFromAction(record),
        record.expiresAt
      );
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
    if (record.commitBatchBinding) {
      if (record.autonomyDecision?.decision === "auto-approved") {
        throw new Error("Governed Git staged-batches-v1 cannot be combined with bounded autopilot");
      }
      await assertGovernedCommitBatchPrecondition(root, runId, manifest, record);
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
        await assertCreationReservation(
          root,
          record.creationReservation,
          creationReservationOwnerFromAction(record),
          record.expiresAt
        );
      }
      if (Date.parse(record.expiresAt) <= Date.now()) {
        throw new Error("Action token expired");
      }
      const attemptId = record.attemptId;
      if (typeof attemptId !== "string" || !attemptId) {
        throw new Error("Action token attempt identity is missing");
      }
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
      await appendJournal(root, runDir, "action.consumed", {
        attemptId, tokenHash,
        ...(record.governedCommitIssuedProof ? {
          governedCommitIssuedProofVersion: 1,
          issuedProofDigest: record.governedCommitIssuedProof.proofDigest
        } : {})
      });
      if (record.governedCommitIssuedProof) await loadGovernedCommitIssuedProof(root, await loadRun(root, runId), next);
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

function providerInvocationAuthorityFailure(action, invocation, error) {
  return {
    schemaVersion: 1,
    kind: "post-invocation-action-authority-drift",
    runId: action.runId,
    actionAttemptId: action.attemptId,
    action: action.action,
    provider: action.provider,
    resource: action.resource,
    remoteRevision: action.remoteRevision,
    providerInvocationId: invocation.id,
    providerInvocationDigest: digestObject(invocation),
    errorDigest: sha256(error?.message ?? "action authority drifted after provider invocation"),
    observedAt: nowIso()
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
  expectedProviderInvocation,
  requireAuthorityGate = false
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
    let authorityGateError = null;
    if (requireAuthorityGate) {
      try {
        await assertSpentActionEvidenceGate(
          root,
          runId,
          await loadRun(root, runId),
          current,
          "GitHub Actions provider result persistence"
        );
      } catch (error) {
        authorityGateError = error;
      }
    }
    const persistedInvocation = authorityGateError
      ? {
          ...invocation,
          dispatchState: "sent-or-indeterminate",
          authorityGateStatus: "drifted-after-invocation",
          authorityGateErrorDigest: sha256(
            authorityGateError?.message ?? "action authority drifted before provider result persistence"
          )
        }
      : requireAuthorityGate
        ? { ...invocation, authorityGateStatus: "verified", authorityGateErrorDigest: null }
        : invocation;
    const authorityFailure = authorityGateError
      ? providerInvocationAuthorityFailure(current, persistedInvocation, authorityGateError)
      : null;
    const next = {
      ...current,
      providerInvocation: persistedInvocation,
      ...(authorityFailure ? { outcome: "unknown", authorityFailure } : {})
    };
    await atomicWriteJson(root, target, next);
    await appendJournal(root, runDir, journalEvent, {
      attemptId: action.attemptId,
      invocationId: persistedInvocation.id,
      dispatchState: persistedInvocation.dispatchState,
      exitCode: persistedInvocation.exitCode,
      authorityGateStatus: persistedInvocation.authorityGateStatus ?? null
    });
    if (authorityGateError) {
      await appendJournal(root, runDir, "action.authority-drifted", {
        attemptId: current.attemptId,
        outcome: "unknown",
        providerInvocationId: persistedInvocation.id,
        authorityFailureDigest: digestObject(authorityFailure)
      });
      throw Object.assign(
        new Error("GitHub Actions provider result is non-authorizing because action authority drifted", {
          cause: authorityGateError
        }),
        { code: "SBW_ACTION_AUTHORITY_INDETERMINATE", providerInvocation: persistedInvocation }
      );
    }
    return next;
  }, { ttlMs: 300_000 });
}

export async function resumeActionsDispatchObservation(root, runId, attemptId) {
  const run = await loadRun(root, runId);
  const runDir = runDirectory(root, runId);
  const records = await listJsonRecords(root, safeJoin(runDir, "actions"));
  const action = records.find((item) => item.attemptId === attemptId);
  assertPublicAutoActionRecord(action, "GitHub Actions dispatch reconciliation");
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
  const run = await loadRun(root, runId);
  assertMutableRun(run, "Action provider execution");
  const actionRecord = await readJson(root, safeJoin(runDirectory(root, runId), "actions", `${sha256(token)}.json`));
  assertPublicAutoActionRecord(actionRecord, "Action provider execution");
  assertSupportedGovernedAction(actionRecord.action);
  const { contract } = run;
  assertActionIsNotDeferred(contract, actionRecord.action);
  if (!isExecutableActionProvider(actionRecord.action, actionRecord.provider)) {
    throw new Error("The governed provider execution path only supports fixed GitHub/Git provider adapters");
  }
  let consumed = await consumeActionTokenInternal(root, runId, token, currentTreeDigest, true);
  if (consumed.action === "worktree.create" && consumed.provider === "git") {
    return withRunLock(root, runId, async ({ runDir }) => {
      const run = await loadRun(root, runId);
      assertMutableRun(run, "Detached worktree provider execution");
      const target = safeJoin(runDir, "actions", `${consumed.tokenHash}.json`);
      const current = await readJson(root, target);
      if (current.status !== "spent" || current.outcome !== "pending" || current.attemptId !== consumed.attemptId) {
        throw new Error("Detached worktree execution is not bound to the consumed pending attempt");
      }
      await assertCreationReservation(root, current.creationReservation,
        creationReservationOwnerFromAction(current), current.expiresAt);
      await assertSpentActionEvidenceGate(root, runId, run, current, "Detached worktree provider invocation");
      const absent = await captureCreationPrecondition(run.manifest.cwd, current.action, current.resource);
      if (absent?.state !== "absent" || digestObject(absent) !== digestObject(current.creationPrecondition)) {
        throw new Error("Detached worktree destination changed after the reserved absent precondition");
      }
      const startedAt = nowIso();
      let providerReceipt = null;
      let providerError = null;
      let authorityGateError = null;
      try {
        providerReceipt = await createDetachedWorktreeProviderReceipt(run.manifest, current);
      } catch (error) {
        providerError = error;
      }
      if (!providerError) {
        try {
          await assertSpentActionEvidenceGate(root, runId, await loadRun(root, runId), current,
            "Detached worktree provider result persistence");
        } catch (error) {
          authorityGateError = error;
        }
      }
      const invocation = {
        schemaVersion: 1, id: `git-worktree-create-wrapper:${runId}:${current.attemptId}`,
        actionAttemptId: current.attemptId, provider: "git",
        command: [BOUND_GIT_EXECUTABLE, "worktree", "add", "--detach", "--",
          current.resource.slice("worktree:".length), current.remoteRevision],
        startedAt, finishedAt: nowIso(), exitCode: providerError ? null : 0,
        dispatchState: providerError || authorityGateError ? "sent-or-indeterminate" : "sent",
        authorityGateStatus: authorityGateError ? "drifted-after-invocation" : "verified",
        ...(providerReceipt ? { providerReceipt } : {}),
        ...(providerError ? { errorDigest: sha256(providerError.message) } : {}),
        ...(authorityGateError ? { authorityGateErrorDigest: sha256(authorityGateError.message) } : {})
      };
      const authorityFailure = authorityGateError
        ? providerInvocationAuthorityFailure(current, invocation, authorityGateError) : null;
      const next = { ...current, providerInvocation: invocation,
        ...(providerError || authorityFailure ? { outcome: "unknown" } : {}),
        ...(authorityFailure ? { authorityFailure } : {}) };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "action.provider-invoked", {
        attemptId: current.attemptId, invocationId: invocation.id,
        dispatchState: invocation.dispatchState, authorityGateStatus: invocation.authorityGateStatus
      });
      if (providerError || authorityGateError) {
        throw Object.assign(new Error("Detached worktree provider execution requires reconciliation", {
          cause: providerError ?? authorityGateError
        }), { code: "SBW_ACTION_AUTHORITY_INDETERMINATE", providerInvocation: invocation });
      }
      return { ...next, providerReceipt };
    }, { ttlMs: 300_000 });
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
    await withRunLock(root, runId, async () => {
      const run = await loadRun(root, runId);
      const current = await readJson(
        root,
        safeJoin(run.runDir, "actions", `${consumed.tokenHash}.json`)
      );
      await assertSpentActionEvidenceGate(
        root,
        runId,
        run,
        current,
        "GitHub Actions dispatch provider invocation"
      );
    });
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
    let providerError = null;
    let authorityGateError = null;
    let dispatchedAt = null;
    consumed = await withRunLock(root, runId, async ({ runDir }) => {
      const run = await loadRun(root, runId);
      const target = safeJoin(runDir, "actions", `${consumed.tokenHash}.json`);
      const current = await readJson(root, target);
      if (current.status !== "spent" || current.attemptId !== consumed.attemptId) {
        throw new Error("GitHub Actions dispatch invocation is not bound to the consumed action attempt");
      }
      try {
        await assertSpentActionEvidenceGate(
          root,
          runId,
          run,
          current,
          "GitHub Actions dispatch provider invocation"
        );
      } catch (error) {
        const notSent = {
          ...workflowDispatchInvocation(runId, current, {
            startedAt,
            exitCode: null,
            dispatchState: "not-sent",
            preexistingRunIds: existingRunIds,
            observationStartedAt: dispatchObservationStartedAt,
            errorDigest: sha256(error?.message ?? "action authority drifted before dispatch")
          }),
          authorityGateStatus: "drifted-before-invocation",
          authorityGateErrorDigest: sha256(error?.message ?? "action authority drifted before dispatch")
        };
        const next = { ...current, providerInvocation: notSent };
        await atomicWriteJson(root, target, next);
        await appendJournal(root, runDir, "action.provider-preflight-failed", {
          attemptId: current.attemptId,
          invocationId: notSent.id,
          dispatchState: notSent.dispatchState,
          authorityGateStatus: notSent.authorityGateStatus
        });
        throw error;
      }
      try {
        await execBoundGitHubCli(providerExecutablePath, expectedCommand.slice(1), { cwd: manifest.cwd });
      } catch (error) {
        providerError = error;
        exitCode = Number.isInteger(error?.code) ? error.code : 1;
      }
      dispatchedAt = nowIso();
      try {
        await assertSpentActionEvidenceGate(
          root,
          runId,
          await loadRun(root, runId),
          current,
          "GitHub Actions dispatch provider result persistence"
        );
      } catch (error) {
        authorityGateError = error;
      }
      const invocation = {
        ...workflowDispatchInvocation(runId, current, {
          startedAt,
          exitCode,
          dispatchState: "sent-or-indeterminate",
          preexistingRunIds: existingRunIds,
          dispatchedAt,
          observationStartedAt: dispatchObservationStartedAt,
          ...(providerError
            ? { errorDigest: sha256(providerError?.message ?? "workflow dispatch failed") }
            : {})
        }),
        authorityGateStatus: authorityGateError ? "drifted-after-invocation" : "verified",
        authorityGateErrorDigest: authorityGateError
          ? sha256(authorityGateError?.message ?? "action authority drifted after dispatch")
          : null
      };
      const authorityFailure = authorityGateError
        ? providerInvocationAuthorityFailure(current, invocation, authorityGateError)
        : null;
      const next = {
        ...current,
        providerInvocation: invocation,
        ...(authorityFailure ? { outcome: "unknown", authorityFailure } : {})
      };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "action.provider-invoked", {
        attemptId: current.attemptId,
        invocationId: invocation.id,
        exitCode,
        authorityGateStatus: invocation.authorityGateStatus
      });
      if (authorityFailure) {
        await appendJournal(root, runDir, "action.authority-drifted", {
          attemptId: current.attemptId,
          outcome: "unknown",
          providerInvocationId: invocation.id,
          authorityFailureDigest: digestObject(authorityFailure)
        });
      }
      return next;
    }, { ttlMs: 300_000 });
    if (authorityGateError) {
      throw Object.assign(
        new Error("GitHub Actions dispatch provider state is indeterminate because action authority drifted after invocation", {
          cause: authorityGateError
        }),
        { code: "SBW_ACTION_AUTHORITY_INDETERMINATE", providerInvocation: consumed.providerInvocation }
      );
    }
    if (providerError) {
      throw Object.assign(
        new Error("GitHub Actions dispatch invocation failed; provider state is indeterminate and automatic retry is prohibited", {
          cause: providerError
        }),
        { code: "SBW_ACTIONS_DISPATCH_INDETERMINATE", providerInvocation: consumed.providerInvocation }
      );
    }
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
          expectedProviderInvocation: currentInvocation,
          requireAuthorityGate: true
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
      consumed = await persistActionProviderInvocation(root, runId, consumed, completedInvocation, {
        requireAuthorityGate: true
      });
      return consumed;
    } catch (error) {
      if (error?.code === "SBW_ACTION_AUTHORITY_INDETERMINATE") throw error;
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
      consumed = await persistActionProviderInvocation(root, runId, consumed, indeterminateInvocation, {
        requireAuthorityGate: true
      });
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
    assertProtectedDeliveryRequest(contract, consumed);
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
      await assertSpentActionEvidenceGate(
        root,
        runId,
        run,
        current,
        "Git push provider invocation"
      );
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
      let authorityGateError = null;
      try {
        await assertSpentActionEvidenceGate(
          root,
          runId,
          await loadRun(root, runId),
          current,
          "Git push provider result persistence"
        );
      } catch (error) {
        authorityGateError = error;
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
        dispatchState: exitCode === 0 && !authorityGateError ? "sent" : "sent-or-indeterminate",
        authorityGateStatus: authorityGateError ? "drifted-after-invocation" : "verified",
        authorityGateErrorDigest: authorityGateError
          ? sha256(authorityGateError?.message ?? "action authority drifted after provider invocation")
          : null
      };
      const authorityFailure = authorityGateError
        ? providerInvocationAuthorityFailure(current, invocation, authorityGateError)
        : null;
      const next = {
        ...current,
        providerInvocation: invocation,
        ...(authorityFailure ? { outcome: "unknown", authorityFailure } : {})
      };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "action.provider-invoked", {
        attemptId: consumed.attemptId,
        invocationId: invocation.id,
        exitCode,
        authorityGateStatus: invocation.authorityGateStatus
      });
      if (authorityFailure) {
        await appendJournal(root, runDir, "action.authority-drifted", {
          attemptId: current.attemptId,
          outcome: "unknown",
          providerInvocationId: invocation.id,
          authorityFailureDigest: digestObject(authorityFailure)
        });
      }
      if (authorityGateError) {
        throw Object.assign(
          new Error("Git push provider state is indeterminate because action authority drifted after invocation", {
            cause: authorityGateError
          }),
          { code: "SBW_ACTION_AUTHORITY_INDETERMINATE", providerInvocation: invocation }
        );
      }
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
      await assertSpentActionEvidenceGate(
        root,
        runId,
        run,
        current,
        "PR creation provider invocation"
      );
      const startedAt = nowIso();
      let exitCode = 0;
      try {
        await execBoundGitHubCli(executable.path, expectedCommand.slice(1), {
          cwd: run.manifest.cwd,
        });
      } catch (error) {
        exitCode = Number.isInteger(error?.code) ? error.code : 1;
      }
      let authorityGateError = null;
      try {
        await assertSpentActionEvidenceGate(
          root,
          runId,
          await loadRun(root, runId),
          current,
          "PR creation provider result persistence"
        );
      } catch (error) {
        authorityGateError = error;
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
        dispatchState: exitCode === 0 && !authorityGateError ? "sent" : "sent-or-indeterminate",
        authorityGateStatus: authorityGateError ? "drifted-after-invocation" : "verified",
        authorityGateErrorDigest: authorityGateError
          ? sha256(authorityGateError?.message ?? "action authority drifted after provider invocation")
          : null
      };
      const authorityFailure = authorityGateError
        ? providerInvocationAuthorityFailure(current, invocation, authorityGateError)
        : null;
      const next = {
        ...current,
        providerInvocation: invocation,
        ...(authorityFailure ? { outcome: "unknown", authorityFailure } : {})
      };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "action.provider-invoked", {
        attemptId: consumed.attemptId,
        invocationId: invocation.id,
        exitCode,
        authorityGateStatus: invocation.authorityGateStatus
      });
      if (authorityFailure) {
        await appendJournal(root, runDir, "action.authority-drifted", {
          attemptId: current.attemptId,
          outcome: "unknown",
          providerInvocationId: invocation.id,
          authorityFailureDigest: digestObject(authorityFailure)
        });
      }
      if (authorityGateError) {
        throw Object.assign(
          new Error("PR creation provider state is indeterminate because action authority drifted after invocation", {
            cause: authorityGateError
          }),
          { code: "SBW_ACTION_AUTHORITY_INDETERMINATE", providerInvocation: invocation }
        );
      }
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
    consumed.mergeMethod === "merge" ? "--merge" : consumed.mergeMethod === "squash" ? "--squash" : "--invalid-merge-method",
    "--delete-branch=false"
  ];
  if (!consumed.mergeRepository || !["merge", "squash"].includes(consumed.mergeMethod) ||
      JSON.stringify(consumed.mergeCommand) !== JSON.stringify(expectedCommand)) {
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
      await assertSpentActionEvidenceGate(
        root,
        runId,
        await loadRun(root, runId),
        current,
        "PR merge provider invocation"
      );
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
    let authorityGateError = null;
    try {
      await assertSpentActionEvidenceGate(
        root,
        runId,
        await loadRun(root, runId),
        current,
        "PR merge provider result persistence"
      );
    } catch (error) {
      authorityGateError = error;
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
      dispatchState: exitCode === 0 && !authorityGateError ? "sent" : "sent-or-indeterminate",
      authorityGateStatus: authorityGateError ? "drifted-after-invocation" : "verified",
      authorityGateErrorDigest: authorityGateError
        ? sha256(authorityGateError?.message ?? "action authority drifted after provider invocation")
        : null
    };
    const authorityFailure = authorityGateError
      ? providerInvocationAuthorityFailure(current, invocation, authorityGateError)
      : null;
    const next = {
      ...current,
      providerInvocation: invocation,
      ...(authorityFailure ? { outcome: "unknown", authorityFailure } : {})
    };
    await atomicWriteJson(root, target, next);
    await appendJournal(root, runDir, "action.provider-invoked", {
      attemptId: consumed.attemptId,
      invocationId: invocation.id,
      exitCode,
      authorityGateStatus: invocation.authorityGateStatus
    });
    if (authorityFailure) {
      await appendJournal(root, runDir, "action.authority-drifted", {
        attemptId: current.attemptId,
        outcome: "unknown",
        providerInvocationId: invocation.id,
        authorityFailureDigest: digestObject(authorityFailure)
      });
    }
    if (authorityGateError) {
      throw Object.assign(
        new Error("PR merge provider state is indeterminate because action authority drifted after invocation", {
          cause: authorityGateError
        }),
        { code: "SBW_ACTION_AUTHORITY_INDETERMINATE", providerInvocation: invocation }
      );
    }
    return next;
  }, { ttlMs: 300_000 });
}

function validateActionReceipt(record, outcome, receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("Action reconciliation requires a structured provider receipt");
  }
  const bindingFields = [
    "runId", "attemptId", "idempotencyKey", "remoteRevision",
    ...(record.commitBatchBinding ? ["commitBatchBindingDigest"] : [])
  ];
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

async function actionReceiptEvidenceProjection(root, runDir, outcome, receipt) {
  if (outcome !== "success") return [];
  if (!Array.isArray(receipt.evidenceIds) || receipt.evidenceIds.length === 0) {
    throw new Error("Successful action reconciliation requires action-bound evidence IDs");
  }
  if (new Set(receipt.evidenceIds).size !== receipt.evidenceIds.length) {
    throw new Error("Action-bound evidence IDs must be unique");
  }
  const evidence = await listJsonRecords(root, safeJoin(runDir, "evidence"));
  const projection = receipt.evidenceIds.map((evidenceId) => {
    const item = evidence.find((candidate) => candidate.id === evidenceId);
    if (!item) throw new Error(`Action-bound evidence record is missing: ${evidenceId}`);
    return { evidenceId, immutableEvidenceDigest: digestObject(evidenceImmutableProjection(item)) };
  }).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  return projection;
}

function assertActionBoundEvidencePayload(record, item, attemptId, receipt) {
  const payload = item?.receipt?.payload;
  const proof = payload?.actionProof;
  if (!item || item.status !== "complete" || !payload || !proof || proof.schemaVersion !== 1 ||
      proof.runId !== record.runId || proof.actionAttemptId !== attemptId ||
      proof.action !== record.action || proof.provider !== record.provider || proof.resource !== record.resource ||
      proof.outcome !== "success" || proof.idempotencyKey !== record.idempotencyKey ||
      proof.remoteRevision !== record.remoteRevision ||
      proof.providerExecutionId !== receipt.providerReceipt.executionId ||
      proof.providerReceiptDigest !== digestObject(receipt.providerReceipt) || !payload.receipt ||
      digestObject(payload.receipt) !== digestObject(receipt.providerReceipt)) {
    throw new Error("Action-bound evidence does not prove the reconciled side effect");
  }
}

async function validateActionEvidenceBinding(root, runDir, record, attemptId, outcome, receipt, {
  allowStale = false,
  expectedProjection = null
} = {}) {
  if (outcome !== "success") return;
  if (!Array.isArray(receipt.evidenceIds) || receipt.evidenceIds.length === 0) {
    throw new Error("Successful action reconciliation requires action-bound evidence IDs");
  }
  if (new Set(receipt.evidenceIds).size !== receipt.evidenceIds.length) {
    throw new Error("Action-bound evidence IDs must be unique");
  }
  const evidence = await listJsonRecords(root, safeJoin(runDir, "evidence"));
  const projection = [];
  for (const evidenceId of receipt.evidenceIds) {
    const item = evidence.find((candidate) => candidate.id === evidenceId);
    if (!allowStale && item?.stale === true) {
      throw new Error("Action-bound evidence does not prove the reconciled side effect");
    }
    assertActionBoundEvidencePayload(record, item, attemptId, receipt);
    projection.push({ evidenceId, immutableEvidenceDigest: digestObject(evidenceImmutableProjection(item)) });
  }
  projection.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  if (expectedProjection && digestObject(projection) !== digestObject(expectedProjection)) {
    throw new Error("Action-bound evidence changed after the staged-batch transition was recorded");
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

function providerActionSourceBindingTransition(record, receipt, validation, transitionedAt) {
  return {
    kind: "provider-action",
    actionAttemptId: record.attemptId,
    action: record.action,
    provider: record.provider,
    resource: record.resource,
    path: validation.relativePath,
    from: validation.baselineSourceBinding.digest,
    to: validation.currentSourceBinding.digest,
    headRevision: validation.currentSourceBinding.headRevision,
    sourceSentinelFrom: validation.baselineSentinel.digest,
    sourceSentinelTo: validation.currentSentinel.digest,
    sourceSentinelFromRecordDigest: validation.baselineSentinelRecordDigest,
    sourceSentinelToRecordDigest: validation.currentSentinelRecordDigest,
    sourceSentinelLabel: `provider-action-${record.attemptId}`,
    providerReceiptDigest: digestObject(receipt.providerReceipt),
    sourceMutationDigest: validation.descriptorDigest,
    at: transitionedAt
  };
}

async function transitionProviderActionSourceBinding(root, runDir, record, receipt, validation) {
  const manifestPath = safeJoin(runDir, "manifest.json");
  const statePath = safeJoin(runDir, "state.json");
  const manifest = await readJson(root, manifestPath);
  const state = await readJson(root, statePath);
  const history = Array.isArray(manifest.sourceBindingHistory) ? manifest.sourceBindingHistory : [];
  const existing = history.find((item) => (
    item.kind === "provider-action" && item.actionAttemptId === record.attemptId
  ));
  const transitionedAt = existing?.at ?? record.sourceBindingTransition?.at ?? nowIso();
  const transition = providerActionSourceBindingTransition(record, receipt, validation, transitionedAt);
  const historyEntry = {
    ...transition,
    reason: "governed-provider-action-reconciled",
    transitionDigest: digestObject(transition)
  };
  if (existing && digestObject(existing) !== digestObject(historyEntry)) {
    throw new Error("Provider action source transition history is rebound to another mutation");
  }
  if (record.sourceBindingTransition && digestObject(record.sourceBindingTransition) !== digestObject(transition)) {
    throw new Error("Provider action persisted source transition is rebound to another mutation");
  }
  if (![transition.from, transition.to].includes(manifest.sourceBinding?.digest)) {
    throw new Error("Provider action cannot replace an unrelated operational source binding");
  }
  const sentinelPath = safeJoin(runDir, "sentinels", `${transition.sourceSentinelLabel}.json`);
  if (await pathExists(sentinelPath)) {
    const persisted = await readJson(root, sentinelPath);
    if (
      persisted.digest !== transition.sourceSentinelTo ||
      stableSentinelRecordDigest(persisted) !== transition.sourceSentinelToRecordDigest
    ) {
      throw new Error("Provider action source transition sentinel conflicts with persisted state");
    }
  } else {
    await atomicWriteJson(root, sentinelPath, validation.currentSentinel);
  }
  if (manifest.sourceBinding.digest === transition.from) {
    await atomicWriteJson(root, manifestPath, {
      ...manifest,
      sourceBinding: validation.currentSourceBinding,
      sourceBindingHistory: [...history, historyEntry],
      updatedAt: transitionedAt
    });
  } else if (!existing) {
    throw new Error("Provider action current source binding lacks immutable transition history");
  }
  if (![transition.sourceSentinelFrom, transition.sourceSentinelTo].includes(state.lastSentinel?.digest)) {
    throw new Error("Provider action cannot replace an unrelated source sentinel");
  }
  if (
    state.lastSentinel?.digest !== transition.sourceSentinelTo ||
    state.lastSentinelVerified !== true || state.lastSentinelComplete !== true ||
    state.lastSentinel?.label !== transition.sourceSentinelLabel
  ) {
    await atomicWriteJson(root, statePath, {
      ...state,
      lastSentinel: {
        label: transition.sourceSentinelLabel,
        digest: transition.sourceSentinelTo,
        path: sentinelPath
      },
      lastSentinelVerified: true,
      lastSentinelComplete: true,
      sentinelDrift: null,
      updatedAt: transitionedAt
    });
  }
  await appendJournalOnceForAttempt(root, runDir, "source-binding.provider-action", record.attemptId, {
    ...transition,
    transitionDigest: digestObject(transition)
  });
  return { transition, historyEntry, sourceBinding: validation.currentSourceBinding };
}

function governedCommitSentinelContentProjection(sentinel) {
  if (!sentinel || typeof sentinel !== "object" || Array.isArray(sentinel)) {
    throw new Error("Governed Git commit source sentinel is malformed");
  }
  const files = [
    ...(sentinel.scopeDigest?.records ?? []),
    ...(sentinel.untracked?.records ?? [])
  ].map((record) => structuredClone(record)).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(files.map((record) => record.path)).size !== files.length) {
    throw new Error("Governed Git commit source sentinel contains duplicate paths");
  }
  return {
    cwd: sentinel.cwd,
    scopes: sentinel.scopes,
    exclusions: sentinel.exclusions,
    files,
    submodules: sentinel.submodules,
    symlinks: sentinel.symlinks,
    attributes: sentinel.attributes,
    authorityMetadata: sentinel.authorityMetadata,
    highRiskIgnored: sentinel.highRiskIgnored,
    skipped: sentinel.skipped
  };
}

async function assertGovernedCommitBatchCommitDelta(cwd, record, anchor, revision) {
  const binding = record.commitBatchBinding;
  const batch = anchor.plan.batches[binding.ordinal];
  if (
    !batch || batch.id !== binding.batchId || revision !== record.receipt?.providerReceipt?.revision
  ) {
    throw new Error("Governed Git staged-batches-v1 commit revision is not bound to its issued action");
  }
  const parentRecord = (await execBoundGitAuthority(cwd, ["rev-list", "--parents", "-n", "1", revision])).stdout.trim();
  const parentParts = parentRecord.split(/\s+/);
  if (parentParts.length !== 2 || parentParts[0] !== revision || parentParts[1] !== binding.expectedParentHead) {
    throw new Error("Governed Git staged-batches-v1 requires one direct single-parent commit at the expected HEAD");
  }
  const rawDiff = await execBoundGitAuthority(cwd, [
    "diff-tree", "--no-commit-id", "--raw", "--no-abbrev", "--no-renames", "-r", "-z",
    binding.expectedParentHead, revision, "--"
  ], { encoding: "buffer" });
  const records = parseBoundGitNulPaths(rawDiff.stdout, "Governed Git staged-batches-v1 commit diff");
  if (records.length % 2 !== 0) {
    throw new Error("Governed Git staged-batches-v1 commit diff is malformed");
  }
  const observed = new Map();
  for (let offset = 0; offset < records.length; offset += 2) {
    const header = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMDT])$/i.exec(records[offset]);
    const relative = records[offset + 1];
    if (!header || !relative || observed.has(relative)) {
      throw new Error("Governed Git staged-batches-v1 commit diff contains an unsupported or duplicate path");
    }
    observed.set(relative, {
      oldMode: header[1],
      newMode: header[2],
      oldObjectId: header[3].toLowerCase(),
      newObjectId: header[4].toLowerCase()
    });
  }
  const baseByPath = new Map(anchor.baseTreePathManifest.map((item) => [item.path, item.entry]));
  const candidateByPath = new Map(anchor.pathManifest.map((item) => [item.path, item.entry]));
  const zeroObjectId = "0".repeat(anchor.candidateIndexTree.length);
  const expected = new Map();
  for (const relative of batch.paths) {
    const before = baseByPath.get(relative) ?? null;
    const after = candidateByPath.get(relative) ?? null;
    if (
      before?.mode === after?.mode && before?.objectId === after?.objectId &&
      Boolean(before) === Boolean(after)
    ) {
      throw new Error("Governed Git staged-batches-v1 plan includes a path with no candidate tree change");
    }
    expected.set(relative, {
      oldMode: before?.mode ?? "000000",
      newMode: after?.mode ?? "000000",
      oldObjectId: before?.objectId ?? zeroObjectId,
      newObjectId: after?.objectId ?? zeroObjectId
    });
  }
  if (
    observed.size !== expected.size ||
    [...expected].some(([relative, entry]) => digestObject(observed.get(relative) ?? null) !== digestObject(entry))
  ) {
    throw new Error("Governed Git staged-batches-v1 commit changed paths, modes, or object IDs outside its selected batch");
  }
}

async function assertLiveGovernedCommitBatchSource(root, runDir, contract, record, anchor) {
  const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
  const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
  const transitions = actions
    .filter((item) => (
      item.commitBatchBinding?.planDigest === anchor.planDigest &&
      item.sourceBindingTransition?.kind === "governed-commit"
    ))
    .sort((left, right) => left.commitBatchBinding.ordinal - right.commitBatchBinding.ordinal);
  if (transitions.length === 0) {
    throw new Error("Governed Git staged-batches-v1 has no persisted source transition to recover");
  }
  let priorTo = null;
  for (let ordinal = 0; ordinal < transitions.length; ordinal += 1) {
    const action = transitions[ordinal];
    const transition = action.sourceBindingTransition;
    const sourceBefore = action.preCommitSourceBinding ?? action.sourceAuthorityAtIssue?.sourceBinding;
    const receipt = action.receipt;
    if (
      action.status !== "spent" || action.outcome !== "success" ||
      action.commitBatchBinding.ordinal !== ordinal ||
      action.commitBatchBindingDigest !== action.commitBatchBinding.bindingDigest ||
      transition.actionAttemptId !== action.attemptId ||
      transition.commitBatchBindingDigest !== action.commitBatchBindingDigest ||
      transition.commitBatchOrdinal !== ordinal ||
      transition.commitBatchId !== action.commitBatchBinding.batchId ||
      transition.commitBatchPlanDigest !== anchor.planDigest ||
      transition.from !== sourceBefore?.digest ||
      transition.previousHeadRevision !== action.commitBatchBinding.expectedParentHead ||
      (priorTo !== null && transition.from !== priorTo) ||
      transition.sourceBindingTo?.digest !== transition.to ||
      transition.sourceBindingTo?.headRevision !== transition.headRevision ||
      receipt?.outcome !== "success" ||
      receipt.providerReceipt?.revision !== transition.headRevision ||
      transition.candidateIndexTree !== anchor.candidateIndexTree ||
      !SHA.test(transition.headRevision ?? "") ||
      !SHA256_DIGEST.test(transition.to ?? "") ||
      !Array.isArray(transition.postIndexStagedPaths) ||
      !Array.isArray(transition.postHeadPathManifest)
    ) {
      throw new Error("Governed Git staged-batches-v1 persisted transition chain is incomplete or rebound");
    }
    const historyEntries = (manifest.sourceBindingHistory ?? []).filter((item) => (
      item.kind === "governed-commit" && item.actionAttemptId === action.attemptId
    ));
    if (historyEntries.length > 1) {
      throw new Error("Governed Git staged-batches-v1 has duplicate source transition history entries");
    }
    if (historyEntries.length === 1) {
      const { reason, transitionDigest, ...historicalProjection } = historyEntries[0];
      if (
        reason !== "governed-git-commit-reconciled" ||
        transitionDigest !== digestObject(historicalProjection) ||
        digestObject(historicalProjection) !== digestObject(transition)
      ) {
        throw new Error("Governed Git staged-batches-v1 source transition history is rebound");
      }
    } else if (action.attemptId !== record.attemptId) {
      throw new Error("Governed Git staged-batches-v1 predecessor transition is missing from source history");
    }
    priorTo = transition.to;
  }

  const latestAction = transitions.at(-1);
  const latest = latestAction.sourceBindingTransition;
  const expectedRemaining = anchor.plan.batches
    .slice(latestAction.commitBatchBinding.ordinal + 1)
    .flatMap((batch) => batch.paths)
    .sort((left, right) => left.localeCompare(right));
  const { captureSentinel, captureSourceBinding } = await import("./git.mjs");
  const [branchResult, currentSourceBinding, currentSentinel, currentIndex] = await Promise.all([
    execBoundGitAuthority(manifest.cwd, ["branch", "--show-current"]),
    captureSourceBinding(manifest.cwd, {
      baseRevision: latestAction.sourceAuthorityAtIssue?.sourceBinding?.baseRevision ?? manifest.sourceBinding?.baseRevision,
      requireClean: false
    }),
    captureSentinel(manifest.cwd, contract, await loadDefaults()),
    captureGovernedCommitIndexSnapshot(manifest.cwd, normalizeCommitBatchAnchor(anchor).paths, {
      requireStagedDiff: expectedRemaining.length > 0
    })
  ]);
  const branch = branchResult.stdout.trim();
  const expectedHeadPaths = expectedGovernedCommitHeadPathManifest(
    anchor,
    latestAction.commitBatchBinding.ordinal + 1
  );
  const liveState = await readJson(root, safeJoin(runDir, "state.json"));
  const liveDrift = [
    branch !== anchor.plan.branch && "branch",
    (!currentSourceBinding || currentSourceBinding.digest !== latest.to) && "source-binding",
    currentSourceBinding?.headRevision !== latest.headRevision && "source-head-binding",
    currentIndex.headRevision !== latest.headRevision && "index-head",
    currentIndex.indexTree !== latest.postIndexTree && "post-index-tree",
    currentIndex.indexTree !== anchor.candidateIndexTree && "candidate-index-tree",
    digestObject(currentIndex.stagedPaths) !== digestObject(expectedRemaining) && "staged-paths",
    digestObject(currentIndex.headPathManifest) !== digestObject(expectedHeadPaths) && "head-path-manifest",
    digestObject(currentIndex.pathManifest) !== anchor.candidatePathManifestDigest && "candidate-path-manifest",
    currentSentinel.complete !== true && "sentinel-incomplete",
    currentSentinel.digest !== latest.sourceSentinelTo && "sentinel-digest",
    stableSentinelRecordDigest(currentSentinel) !== latest.sourceSentinelToRecordDigest && "sentinel-record",
    ![latest.from, latest.to].includes(manifest.sourceBinding?.digest) && "manifest-source-binding",
    ![latest.sourceSentinelFrom, latest.sourceSentinelTo].includes(liveState.lastSentinel?.digest) && "state-sentinel"
  ].filter(Boolean);
  if (liveDrift.length > 0) {
    throw new Error(`Governed Git staged-batches-v1 live source, sentinel, HEAD, or index drifted after its latest transition: ${liveDrift.join(",")}`);
  }
  const latestSentinelPath = safeJoin(runDir, "sentinels", `${latest.sourceSentinelLabel}.json`);
  const storedLatestSentinel = await readJson(root, latestSentinelPath).catch(() => null);
  if (
    storedLatestSentinel && (
      storedLatestSentinel.digest !== latest.sourceSentinelTo ||
      stableSentinelRecordDigest(storedLatestSentinel) !== latest.sourceSentinelToRecordDigest
    )
  ) {
    throw new Error("Governed Git staged-batches-v1 latest source sentinel conflicts with its persisted transition");
  }
  if (!storedLatestSentinel && latestAction.attemptId !== record.attemptId) {
    throw new Error("Governed Git staged-batches-v1 latest historical source sentinel is missing");
  }
}

async function validateGovernedCommitHistoricalSourceTransition(root, runDir, contract, record, receipt) {
  const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
  const transition = record.sourceBindingTransition;
  const prior = record.preCommitSourceBinding ?? record.sourceAuthorityAtIssue?.sourceBinding;
  const anchor = await resolveGovernedCommitBatchAnchor(root, manifest.runId, record);
  const normalizedAnchor = normalizeCommitBatchAnchor(anchor);
  if (
    !transition || transition.kind !== "governed-commit" ||
    transition.actionAttemptId !== record.attemptId ||
    transition.commitBatchBindingDigest !== record.commitBatchBindingDigest ||
    transition.commitBatchId !== record.commitBatchBinding?.batchId ||
    transition.commitBatchOrdinal !== record.commitBatchBinding?.ordinal ||
    transition.commitBatchPlanDigest !== anchor.planDigest ||
    transition.candidateIndexTree !== anchor.candidateIndexTree ||
    transition.selectedPathDigest !== record.commitBatchBinding?.selectedPathDigest ||
    transition.remainingPathDigest !== record.commitBatchBinding?.remainingPathDigest ||
    transition.sourceSentinelLabel !== `governed-commit-${record.attemptId}` ||
    transition.providerReceiptDigest !== digestObject(receipt.providerReceipt) ||
    !Array.isArray(transition.postIndexStagedPaths) ||
    !Array.isArray(transition.postHeadPathManifest) ||
    !Array.isArray(transition.actionReceiptEvidence) ||
    !transition.sourceBindingTo ||
    transition.sourceBindingTo.digest !== transition.to ||
    transition.sourceBindingTo.headRevision !== transition.headRevision ||
    transition.from !== prior?.digest ||
    transition.previousHeadRevision !== record.commitBatchBinding?.expectedParentHead ||
    receipt.providerReceipt?.revision !== transition.headRevision ||
    !normalizedAnchor.batches[record.commitBatchBinding?.ordinal]
  ) {
    throw new Error("Governed Git staged-batches-v1 historical transition is malformed or rebound");
  }
  const targetBinding = sourceBindingWithoutDigest(transition.sourceBindingTo);
  if (
    transition.sourceBindingTo.schemaVersion !== 3 ||
    !SHA256_DIGEST.test(targetBinding?.digest ?? "") ||
    digestObject(targetBinding.payload) !== targetBinding.digest
  ) {
    throw new Error("Governed Git staged-batches-v1 historical source binding is invalid");
  }
  const priorPayload = sourceBindingWithoutDigest(prior);
  if (
    prior?.schemaVersion !== 3 || !SHA256_DIGEST.test(priorPayload?.digest ?? "") ||
    digestObject(priorPayload.payload) !== priorPayload.digest
  ) {
    throw new Error("Governed Git staged-batches-v1 historical predecessor binding is invalid");
  }
  await assertLiveGovernedCommitBatchSource(root, runDir, contract, record, anchor);
  const { captureSentinel } = await import("./git.mjs");
  const beforeBinding = record.sourceAuthorityAtIssue?.sourceSentinel;
  const beforeSentinel = beforeBinding?.label
    ? await readJson(root, safeJoin(runDir, "sentinels", `${beforeBinding.label}.json`)).catch(() => null)
    : null;
  const afterPath = safeJoin(runDir, "sentinels", `${transition.sourceSentinelLabel}.json`);
  let afterSentinel = await readJson(root, afterPath).catch(() => null);
  if (!afterSentinel) {
    const [currentHead, currentSourceBinding] = await Promise.all([
      execBoundGitAuthority(manifest.cwd, ["rev-parse", "--verify", "HEAD^{commit}"]),
      import("./git.mjs").then(({ captureSourceBinding }) => captureSourceBinding(manifest.cwd, {
        baseRevision: prior.baseRevision,
        requireClean: false
      }))
    ]);
    if (
      currentHead.stdout.trim() !== transition.headRevision ||
      currentSourceBinding?.digest !== transition.to
    ) {
      throw new Error("Governed Git staged-batches-v1 cannot recover a missing historical source sentinel");
    }
    afterSentinel = await captureSentinel(manifest.cwd, contract, await loadDefaults());
  }
  if (
    !beforeSentinel || beforeSentinel.complete !== true ||
    beforeSentinel.digest !== beforeBinding.digest ||
    stableSentinelRecordDigest(beforeSentinel) !== beforeBinding.recordDigest ||
    afterSentinel.complete !== true || afterSentinel.digest !== transition.sourceSentinelTo ||
    stableSentinelRecordDigest(afterSentinel) !== transition.sourceSentinelToRecordDigest ||
    digestObject(governedCommitSentinelContentProjection(afterSentinel)) !==
      digestObject(governedCommitSentinelContentProjection(beforeSentinel))
  ) {
    throw new Error("Governed Git staged-batches-v1 historical source sentinels are not replay-valid");
  }
  await assertGovernedCommitBatchCommitDelta(
    manifest.cwd,
    { ...record, receipt },
    anchor,
    transition.headRevision
  );
  const expectedRemaining = anchor.plan.batches
    .slice(record.commitBatchBinding.ordinal + 1)
    .flatMap((batch) => batch.paths)
    .sort((left, right) => left.localeCompare(right));
  const expectedHeadPaths = expectedGovernedCommitHeadPathManifest(
    anchor,
    record.commitBatchBinding.ordinal + 1
  );
  if (
    transition.postIndexTree !== anchor.candidateIndexTree ||
    transition.remainingPathDigest !== digestObject(expectedRemaining) ||
    digestObject(transition.postIndexStagedPaths) !== digestObject(expectedRemaining) ||
    transition.postIndexStagedPathDigest !== digestObject(expectedRemaining) ||
    digestObject(transition.postHeadPathManifest) !== digestObject(expectedHeadPaths) ||
    transition.postHeadPathManifestDigest !== digestObject(expectedHeadPaths) ||
    digestObject(transition.actionReceiptEvidence) !== digestObject(await actionReceiptEvidenceProjection(
      root,
      runDir,
      "success",
      receipt
    ))
  ) {
    throw new Error("Governed Git staged-batches-v1 historical index or action evidence projection changed");
  }
  return {
    manifest,
    prior,
    beforeSentinel,
    currentSourceBinding: transition.sourceBindingTo,
    currentSentinel: afterSentinel,
    batchSnapshot: {
      indexTree: transition.postIndexTree,
      stagedPaths: transition.postIndexStagedPaths,
      headPathManifest: transition.postHeadPathManifest
    },
    actionReceiptEvidence: transition.actionReceiptEvidence
  };
}

async function validateGovernedCommitSourceTransition(root, runDir, contract, record, receipt) {
  if (record.commitBatchBinding && record.sourceBindingTransition) {
    return validateGovernedCommitHistoricalSourceTransition(root, runDir, contract, record, receipt);
  }
  const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
  const prior = record.preCommitSourceBinding ?? record.sourceAuthorityAtIssue?.sourceBinding;
  const priorPayload = sourceBindingWithoutDigest(prior);
  if (
    !priorPayload || prior?.schemaVersion !== 3 ||
    !SHA256_DIGEST.test(priorPayload.digest ?? "") ||
    digestObject(priorPayload.payload) !== priorPayload.digest ||
    !SHA.test(prior.headRevision ?? "") ||
    record.preCommitHeadRevision && record.preCommitHeadRevision !== prior.headRevision
  ) {
    throw new Error("Governed Git commit reconciliation lacks an immutable pre-action source binding");
  }
  const beforeBinding = record.sourceAuthorityAtIssue?.sourceSentinel;
  if (
    !beforeBinding || !SAFE_ID.test(beforeBinding.label ?? "") ||
    !SHA256_DIGEST.test(beforeBinding.digest ?? "") ||
    !SHA256_DIGEST.test(beforeBinding.recordDigest ?? "")
  ) {
    throw new Error("Governed Git commit reconciliation lacks an immutable pre-action source sentinel");
  }
  const beforeSentinel = await readJson(
    root,
    safeJoin(runDir, "sentinels", `${beforeBinding.label}.json`)
  );
  if (
    beforeSentinel.complete !== true || beforeSentinel.digest !== beforeBinding.digest ||
    stableSentinelRecordDigest(beforeSentinel) !== beforeBinding.recordDigest
  ) {
    throw new Error("Governed Git commit pre-action source sentinel is not replay-valid");
  }
  const { captureSentinel, captureSourceBinding } = await import("./git.mjs");
  const batchBinding = record.commitBatchBinding ?? null;
  const anchor = batchBinding
    ? await resolveGovernedCommitBatchAnchor(root, manifest.runId, record)
    : null;
  const normalizedAnchor = batchBinding ? normalizeCommitBatchAnchor(anchor) : null;
  if (batchBinding) {
    if (
      batchBinding.bindingDigest !== record.commitBatchBindingDigest ||
      commitBatchBindingDigest(batchBinding) !== record.commitBatchBindingDigest ||
      batchBinding.anchorAttemptId !== anchor.anchorAttemptId ||
      normalizedAnchor.batches[batchBinding.ordinal]?.id !== batchBinding.batchId ||
      batchBinding.expectedParentHead !== prior.headRevision ||
      batchBinding.candidateIndexTree !== anchor.candidateIndexTree
    ) {
      throw new Error("Governed Git staged-batches-v1 action does not match its immutable source transition anchor");
    }
  }
  const currentSourceBinding = await captureSourceBinding(manifest.cwd, {
    baseRevision: prior.baseRevision,
    requireClean: !batchBinding
  });
  if (!currentSourceBinding || currentSourceBinding.schemaVersion !== 3) {
    throw new Error("Governed Git commit reconciliation requires a clean schema-3 source binding");
  }
  if (
    digestObject(autonomousCommitSourceIdentity(currentSourceBinding)) !==
    digestObject(autonomousCommitSourceIdentity(prior))
  ) {
    throw new Error("Governed Git commit reconciliation detected repository, branch, or remote identity drift");
  }
  if (![prior.digest, currentSourceBinding.digest].includes(manifest.sourceBinding?.digest)) {
    throw new Error("Governed Git commit reconciliation detected an unrelated operational source binding");
  }
  let advancedBy;
  try {
    advancedBy = await rawLinearCommitDistance(
      manifest.cwd,
      prior.headRevision,
      currentSourceBinding.headRevision,
      1,
      "Governed Git commit transition"
    );
  } catch (error) {
    throw new Error(`Governed Git commit reconciliation requires exactly one commit per consumed token: ${error.message}`);
  }
  if (advancedBy !== 1 || receipt.providerReceipt?.revision !== currentSourceBinding.headRevision) {
    throw new Error("Governed Git commit reconciliation is not bound to the exact provider revision");
  }
  let batchSnapshot = null;
  let actionReceiptEvidence = [];
  if (batchBinding) {
    await assertGovernedCommitBatchCommitDelta(
      manifest.cwd,
      { ...record, receipt },
      anchor,
      currentSourceBinding.headRevision
    );
    const remainingPaths = anchor.plan.batches.slice(batchBinding.ordinal + 1)
      .flatMap((batch) => batch.paths)
      .sort((left, right) => left.localeCompare(right));
    batchSnapshot = await captureGovernedCommitIndexSnapshot(manifest.cwd, normalizedAnchor.paths, {
      requireStagedDiff: remainingPaths.length > 0
    });
    const expectedHeadPaths = expectedGovernedCommitHeadPathManifest(anchor, batchBinding.ordinal + 1);
    if (
      batchSnapshot.headRevision !== currentSourceBinding.headRevision ||
      batchSnapshot.indexTree !== anchor.candidateIndexTree ||
      digestObject(batchSnapshot.pathManifest) !== anchor.candidatePathManifestDigest ||
      digestObject(batchSnapshot.headPathManifest) !== digestObject(expectedHeadPaths) ||
      digestObject(batchSnapshot.stagedPaths) !== digestObject(remainingPaths)
    ) {
      throw new Error("Governed Git staged-batches-v1 post-commit index is not the exact remaining candidate");
    }
    if (remainingPaths.length === 0) {
      const headTree = (await execBoundGitAuthority(manifest.cwd, ["rev-parse", "--verify", "HEAD^{tree}"])).stdout.trim();
      if (headTree !== anchor.candidateIndexTree) {
        throw new Error("Final governed Git staged-batches-v1 commit does not match the complete candidate tree");
      }
    }
    actionReceiptEvidence = await actionReceiptEvidenceProjection(root, runDir, "success", receipt);
  }
  const currentSentinel = await captureSentinel(manifest.cwd, contract, await loadDefaults());
  if (currentSentinel.complete !== true) {
    throw new Error("Governed Git commit reconciliation requires complete post-commit source coverage");
  }
  if (
    digestObject(governedCommitSentinelContentProjection(currentSentinel)) !==
    digestObject(governedCommitSentinelContentProjection(beforeSentinel))
  ) {
    throw new Error("Governed Git commit changed source content outside the consumed sentinel");
  }
  return {
    manifest,
    prior,
    beforeSentinel,
    currentSourceBinding,
    currentSentinel,
    batchSnapshot,
    actionReceiptEvidence
  };
}

async function validateGovernedCommitReconciliationAuthority(
  root,
  runId,
  runDir,
  record,
  receipt,
  context
) {
  const currentRun = await loadRun(root, runId);
  if (record.commitBatchBinding && record.sourceBindingTransition) {
    await governedCommitHistoricalEvidenceAuthority(root, runId, currentRun, record, context);
  } else {
    await assertSpentActionNonSourceAuthority(root, runId, currentRun, record, context);
  }
  return validateGovernedCommitSourceTransition(
    root,
    runDir,
    currentRun.contract,
    record,
    receipt
  );
}

function governedCommitSourceTransition(record, receipt, validation, transitionedAt) {
  const transition = {
    schemaVersion: 1,
    kind: "governed-commit",
    actionAttemptId: record.attemptId,
    action: record.action,
    provider: record.provider,
    resource: record.resource,
    from: validation.prior.digest,
    to: validation.currentSourceBinding.digest,
    previousHeadRevision: validation.prior.headRevision,
    headRevision: validation.currentSourceBinding.headRevision,
    sourceSentinelFrom: validation.beforeSentinel.digest,
    sourceSentinelFromRecordDigest: stableSentinelRecordDigest(validation.beforeSentinel),
    sourceSentinelTo: validation.currentSentinel.digest,
    sourceSentinelToRecordDigest: stableSentinelRecordDigest(validation.currentSentinel),
    sourceSentinelLabel: `governed-commit-${record.attemptId}`,
    providerReceiptDigest: digestObject(receipt.providerReceipt),
    at: transitionedAt
  };
  if (record.commitBatchBinding) {
    Object.assign(transition, {
      commitBatchBindingDigest: record.commitBatchBindingDigest,
      commitBatchId: record.commitBatchBinding.batchId,
      commitBatchOrdinal: record.commitBatchBinding.ordinal,
      commitBatchPlanDigest: record.commitBatchBinding.planDigest,
      candidateIndexTree: record.commitBatchBinding.candidateIndexTree,
      selectedPathDigest: record.commitBatchBinding.selectedPathDigest,
      remainingPathDigest: record.commitBatchBinding.remainingPathDigest,
      postIndexTree: validation.batchSnapshot.indexTree,
      postIndexStagedPaths: validation.batchSnapshot.stagedPaths,
      postIndexStagedPathDigest: digestObject(validation.batchSnapshot.stagedPaths),
      postHeadPathManifest: validation.batchSnapshot.headPathManifest,
      postHeadPathManifestDigest: digestObject(validation.batchSnapshot.headPathManifest),
      actionReceiptEvidence: validation.actionReceiptEvidence,
      sourceBindingTo: validation.currentSourceBinding
    });
  }
  return transition;
}

async function transitionGovernedCommitSourceBinding(root, runDir, record, receipt, validation, transition) {
  const manifestPath = safeJoin(runDir, "manifest.json");
  const statePath = safeJoin(runDir, "state.json");
  const manifest = await readJson(root, manifestPath);
  const state = await readJson(root, statePath);
  const history = Array.isArray(manifest.sourceBindingHistory) ? manifest.sourceBindingHistory : [];
  const historyEntry = {
    ...transition,
    reason: "governed-git-commit-reconciled",
    transitionDigest: digestObject(transition)
  };
  const existing = history.find((item) => (
    item.kind === "governed-commit" && item.actionAttemptId === record.attemptId
  ));
  if (existing && digestObject(existing) !== digestObject(historyEntry)) {
    throw new Error("Governed Git commit source transition history is rebound to another commit");
  }
  if (manifest.sourceBinding.digest === transition.to && !existing) {
    throw new Error("Governed Git commit source transition lacks its immutable history record");
  }
  let historyDescendant = false;
  if (existing && manifest.sourceBinding.digest !== transition.from && manifest.sourceBinding.digest !== transition.to) {
    const index = history.findIndex((item) => (
      item.kind === "governed-commit" && item.actionAttemptId === record.attemptId
    ));
    let reached = transition.to;
    for (const entry of history.slice(index + 1)) {
      if (entry.from !== reached || !SHA256_DIGEST.test(entry.to ?? "")) {
        throw new Error("Governed Git commit history cannot replay across a broken source transition chain");
      }
      reached = entry.to;
    }
    if (reached !== manifest.sourceBinding.digest) {
      throw new Error("Governed Git commit cannot replay across an unrelated operational source binding");
    }
    historyDescendant = true;
  } else if (![transition.from, transition.to].includes(manifest.sourceBinding.digest)) {
    throw new Error("Governed Git commit cannot replace an unrelated operational source binding");
  }
  if (!SAFE_ID.test(transition.sourceSentinelLabel ?? "")) {
    throw new Error("Governed Git commit source transition sentinel label is malformed");
  }
  const sentinelPath = safeJoin(runDir, "sentinels", `${transition.sourceSentinelLabel}.json`);
  if (await pathExists(sentinelPath)) {
    const persisted = await readJson(root, sentinelPath);
    if (
      persisted.digest !== transition.sourceSentinelTo ||
      stableSentinelRecordDigest(persisted) !== transition.sourceSentinelToRecordDigest
    ) {
      throw new Error("Governed Git commit post-action sentinel conflicts with persisted state");
    }
  } else {
    await atomicWriteJson(root, sentinelPath, validation.currentSentinel);
  }
  if (manifest.sourceBinding.digest === transition.from) {
    await atomicWriteJson(root, manifestPath, {
      ...manifest,
      sourceBinding: validation.currentSourceBinding,
      sourceBindingHistory: [...history, historyEntry],
      updatedAt: transition.at
    });
  }
  const latestHistoryEntry = historyDescendant
    ? [...history].reverse().find((item) => item.sourceSentinelTo && item.sourceSentinelLabel)
    : null;
  const stateAtPredecessor = (
    state.lastSentinel?.digest === transition.sourceSentinelFrom &&
    !historyDescendant
  );
  const stateAtTransition = (
    state.lastSentinel?.digest === transition.sourceSentinelTo &&
    state.lastSentinel?.label === transition.sourceSentinelLabel &&
    state.lastSentinelVerified === true && state.lastSentinelComplete === true
  );
  const stateAtDescendant = Boolean(
    historyDescendant && latestHistoryEntry?.sourceSentinelTo &&
    state.lastSentinel?.digest === latestHistoryEntry.sourceSentinelTo &&
    state.lastSentinel?.label === latestHistoryEntry.sourceSentinelLabel &&
    state.lastSentinelVerified === true && state.lastSentinelComplete === true
  );
  if (!stateAtPredecessor && !stateAtTransition && !stateAtDescendant) {
    throw new Error("Governed Git commit cannot replace an unrelated or incomplete source sentinel");
  }
  if (stateAtPredecessor) {
    await atomicWriteJson(root, statePath, {
      ...state,
      lastSentinel: {
        label: transition.sourceSentinelLabel,
        digest: transition.sourceSentinelTo,
        path: sentinelPath
      },
      lastSentinelVerified: true,
      lastSentinelComplete: true,
      sentinelDrift: null,
      updatedAt: transition.at
    });
  }
  await appendJournalOnceForAttempt(root, runDir, "source-binding.governed-commit", record.attemptId, {
    ...transition,
    transitionDigest: digestObject(transition)
  });
  return { transition, historyEntry, sourceBinding: validation.currentSourceBinding };
}

async function persistActionAuthorityDriftUnknown(
  root,
  runDir,
  record,
  receipt,
  error,
  { providerExecutionReservationOutcome }
) {
  const observedAt = nowIso();
  const authorityFailure = {
    schemaVersion: 1,
    kind: "post-invocation-action-authority-drift",
    actionAttemptId: record.attemptId,
    observedProviderOutcome: "success",
    observedProviderExecutionId: receipt.providerReceipt.executionId,
    observedProviderReceiptDigest: digestObject(receipt.providerReceipt),
    providerExecutionReservationOutcome,
    errorDigest: sha256(error?.message ?? "action authority drifted"),
    observedAt
  };
  const next = {
    ...record,
    outcome: "unknown",
    receipt: null,
    reconciledAt: observedAt,
    authorityFailure
  };
  await atomicWriteJson(root, safeJoin(runDir, "actions", `${record.tokenHash}.json`), next);
  await appendJournal(root, runDir, "action.authority-drifted", {
    attemptId: record.attemptId,
    outcome: "unknown",
    providerExecutionId: receipt.providerReceipt.executionId,
    providerExecutionReservationOutcome,
    authorityFailureDigest: digestObject(authorityFailure)
  });
  return next;
}

export async function reconcileAction(root, runId, attemptId, outcome, receipt = null, {
  failAfter = null
} = {}) {
  if (!["success", "failure", "unknown"].includes(outcome)) {
    throw new Error("Action outcome must be success, failure, or unknown");
  }
  if (failAfter !== null) {
    throw publicAutoRunRequired("Legacy autonomous reconciliation failure injection");
  }
  const onBoundary = async () => {};
  assertMutableRun(await loadRun(root, runId), "Action reconciliation");
  await resumeActionsDispatchObservation(root, runId, attemptId);
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Action reconciliation");
    const records = await listJsonRecords(root, safeJoin(runDir, "actions"));
    const record = records.find((item) => item.attemptId === attemptId);
    if (!record) throw new Error(`Unknown action attempt: ${attemptId}`);
    assertPublicAutoActionRecord(record, "Action reconciliation");
    await assertGovernedCommitIssuedProofInventory(root, run, records);
    const governedCommitIssuedProof = await loadGovernedCommitIssuedProof(root, run, record);
    const ordinaryBoundSuccess = governedCommitIssuedProof
      ? governedCommitSuccessJournal(await readJournalRecords(root, runDir), record) : null;
    if (ordinaryBoundSuccess && outcome !== "success") {
      throw new Error("Governed commit durable success prebinding cannot be changed to another outcome");
    }
    if (governedCommitIssuedProof && record.outcome !== "success") {
      const priorJournal = await readJournalRecords(root, runDir);
      if (!ordinaryBoundSuccess && (priorJournal.some((entry) => governedCommitAttemptEntry(entry, record) && (
          entry.event === "source-binding.governed-commit" || entry.event === "action.governed-commit-transition-repaired" ||
          (entry.event === "action.reconciled" && entry.outcome === "success")
        )) || (run.manifest.sourceBindingHistory ?? []).some((entry) => entry.actionAttemptId === record.attemptId))) {
        throw new Error("Governed commit source/completion history precedes its durable success prebinding");
      }
      if (ordinaryBoundSuccess) {
        await assertGovernedCommitJournalOnlySuccessPrefix(root, run, record, receipt, governedCommitIssuedProof, ordinaryBoundSuccess);
      }
    }
    assertActionIsNotDeferred(run.contract, record.action);
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
    const repairingProviderActionTransition = (
      record.status === "spent" && record.outcome === "success" && outcome === "success" &&
      PROVIDER_ACTION_SOURCE_MUTATIONS.has(`${record.action}:${record.provider}`) &&
      record.receipt?.providerReceipt?.sourceMutation
    );
    if (repairingProviderActionTransition) {
      if (!record.receipt || !receipt || digestObject(record.receipt) !== digestObject(receipt)) {
        throw new Error("Provider action source transition repair requires the exact persisted success receipt");
      }
      validateActionReceipt(record, outcome, receipt);
      await validateActionEvidenceBinding(root, runDir, record, attemptId, outcome, receipt);
      const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
      await verifyProviderReceipt(manifest, { ...record, outcome: "success" }, receipt, run.contract);
      await assertFrozenProviderActionEvidenceGate(
        root,
        runId,
        run,
        record,
        "Provider action source transition repair"
      );
      const validation = await validateProviderActionSourceMutation(
        root,
        run,
        record,
        receipt.providerReceipt
      );
      await transitionProviderActionSourceBinding(root, runDir, record, receipt, validation);
      await appendJournalOnceForAttempt(
        root,
        runDir,
        "action.provider-source-transition-repaired",
        attemptId,
        { sourceMutationDigest: validation.descriptorDigest }
      );
      return readJson(root, safeJoin(runDir, "actions", `${record.tokenHash}.json`));
    }
    const repairingGovernedCommitTransition = (
      record.status === "spent" && record.outcome === "success" && outcome === "success" &&
      record.action === "git.commit" && record.provider === "git" &&
      record.autonomyDecision?.decision !== "auto-approved" && record.sourceBindingTransition
    );
    if (repairingGovernedCommitTransition) {
      if (governedCommitIssuedProof) {
        await assertGovernedCommitOrdinarySuccessReplay(root, runId, run, record, receipt, governedCommitIssuedProof);
        // Recapture the live run, action and durable ISSUE binding immediately
        // before persistence, without substituting a historical run context.
        const persistenceRun = await loadRun(root, runId);
        const persistenceRecord = await readJson(root, safeJoin(runDir, "actions", `${record.tokenHash}.json`));
        const persistenceProof = await loadGovernedCommitIssuedProof(root, persistenceRun, persistenceRecord);
        if (!persistenceProof || digestObject(persistenceRecord) !== digestObject(record) ||
            persistenceProof.proofDigest !== governedCommitIssuedProof.proofDigest) {
          throw new Error("Governed commit success replay changed before persistence");
        }
        const replay = await assertGovernedCommitOrdinarySuccessReplay(
          root, runId, persistenceRun, persistenceRecord, receipt, persistenceProof
        );
        await transitionGovernedCommitSourceBinding(
          root, runDir, record, receipt, replay.validation, replay.binding.sourceTransition
        );
        if (replay.successJournalMissing) {
          await appendGovernedCommitSuccessCompletion(root, runDir, record, replay.binding);
        }
        await appendJournalOnceForAttempt(root, runDir, "action.governed-commit-transition-repaired", attemptId, {
          sourceBindingDigest: replay.validation.currentSourceBinding.digest,
          governedCommitSuccessReplayVersion: 1,
          issuedProofDigest: governedCommitIssuedProof.proofDigest,
          successReplayBindingDigest: replay.binding.bindingDigest
        });
        return readJson(root, safeJoin(runDir, "actions", `${record.tokenHash}.json`));
      }
      if (!record.receipt || !receipt || digestObject(record.receipt) !== digestObject(receipt)) {
        throw new Error("Governed Git commit transition repair requires the exact persisted success receipt");
      }
      validateActionReceipt(record, outcome, receipt);
      await validateActionEvidenceBinding(root, runDir, record, attemptId, outcome, receipt, {
        allowStale: Boolean(record.commitBatchBinding),
        expectedProjection: record.commitBatchBinding
          ? record.sourceBindingTransition.actionReceiptEvidence
          : null
      });
      const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
      await verifyProviderReceipt(manifest, { ...record, outcome: "success" }, receipt, run.contract);
      const validation = await validateGovernedCommitReconciliationAuthority(
        root,
        runId,
        runDir,
        record,
        receipt,
        "Governed Git commit transition repair"
      );
      const expected = governedCommitSourceTransition(record, receipt, validation, record.sourceBindingTransition.at);
      if (digestObject(expected) !== digestObject(record.sourceBindingTransition)) {
        throw new Error("Governed Git commit transition repair is rebound to another source state");
      }
      await transitionGovernedCommitSourceBinding(
        root,
        runDir,
        record,
        receipt,
        validation,
        record.sourceBindingTransition
      );
      await appendJournalOnceForAttempt(root, runDir, "action.governed-commit-transition-repaired", attemptId, {
        sourceBindingDigest: validation.currentSourceBinding.digest
      });
      return readJson(root, safeJoin(runDir, "actions", `${record.tokenHash}.json`));
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
    const recoveringUnknownCommitSuccess = (
      record.status === "spent" && record.outcome === "unknown" && outcome === "success" &&
      record.action === "git.commit" && record.provider === "git"
    );
    const recoveringUnknown = recoveringUnknownSuccess || recoveringUnknownFailure || recoveringUnknownCommitSuccess;
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
        String(record.providerInvocation.authorityGateStatus ?? "").startsWith("drifted-") ||
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
        String(record.providerInvocation.authorityGateStatus ?? "").startsWith("drifted-") ||
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
        String(record.providerInvocation.authorityGateStatus ?? "").startsWith("drifted-") ||
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
        String(record.providerInvocation.authorityGateStatus ?? "").startsWith("drifted-") ||
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
    const governedCommitTransitionRequired = (
      record.action === "git.commit" && record.provider === "git" && outcome === "success" &&
      record.autonomyDecision?.decision !== "auto-approved"
    );
    const providerActionSourceTransitionRequired = (
      outcome === "success" && run.contract.schemaVersion === 2 &&
      PROVIDER_ACTION_SOURCE_MUTATIONS.has(`${record.action}:${record.provider}`) &&
      Boolean(receipt.providerReceipt.sourceMutation)
    );
    const sourceMutatingReconciliation = governedCommitTransitionRequired ||
      providerActionSourceTransitionRequired ||
      (record.action === "worktree.cleanup" && outcome === "success");
    let providerActionSourceValidation = null;
    let governedCommitValidation = null;
    let governedCommitTransition = null;
    if (governedCommitTransitionRequired) {
      try {
        governedCommitValidation = await validateGovernedCommitReconciliationAuthority(
          root,
          runId,
          runDir,
          record,
          receipt,
          "Governed Git commit source reconciliation"
        );
        const boundSuccess = governedCommitIssuedProof
          ? governedCommitSuccessJournal(await readJournalRecords(root, runDir), record)
          : null;
        if (boundSuccess) {
          assertGovernedCommitSuccessBindingShape(boundSuccess.binding, governedCommitIssuedProof, record, receipt);
          assertGovernedCommitSuccessJournalBinding(boundSuccess, boundSuccess.binding, record);
        }
        governedCommitTransition = governedCommitSourceTransition(
          record,
          receipt,
          governedCommitValidation,
          boundSuccess?.binding.sourceTransition.at ?? nowIso()
        );
      } catch (error) {
        await reserveProviderExecution(
          root,
          record,
          receipt.providerReceipt.executionId,
          "unknown",
          { onBoundary }
        );
        await persistActionAuthorityDriftUnknown(
          root,
          runDir,
          record,
          receipt,
          error,
          { providerExecutionReservationOutcome: "unknown" }
        );
        throw Object.assign(
          new Error("Governed Git commit is non-authorizing because source authority drifted before reconciliation", {
            cause: error
          }),
          { code: "SBW_ACTION_AUTHORITY_INDETERMINATE" }
        );
      }
    }
    if (providerActionSourceTransitionRequired) {
      try {
        await assertFrozenProviderActionEvidenceGate(
          root,
          runId,
          run,
          record,
          "Provider action source reconciliation"
        );
        providerActionSourceValidation = await validateProviderActionSourceMutation(
          root,
          run,
          record,
          receipt.providerReceipt
        );
      } catch (error) {
        await reserveProviderExecution(
          root,
          record,
          receipt.providerReceipt.executionId,
          "unknown",
          { onBoundary }
        );
        await persistActionAuthorityDriftUnknown(
          root,
          runDir,
          record,
          receipt,
          error,
          { providerExecutionReservationOutcome: "unknown" }
        );
        throw Object.assign(
          new Error("Provider source mutation is non-authorizing because action authority drifted before reconciliation", {
            cause: error
          }),
          { code: "SBW_ACTION_AUTHORITY_INDETERMINATE" }
        );
      }
    }
    if (outcome === "success" && run.contract.schemaVersion === 2 && !sourceMutatingReconciliation) {
      try {
        await assertSpentActionEvidenceGate(
          root,
          runId,
          await loadRun(root, runId),
          record,
          "Action success reconciliation"
        );
      } catch (error) {
        await reserveProviderExecution(
          root,
          record,
          receipt.providerReceipt.executionId,
          "unknown",
          { onBoundary }
        );
        await persistActionAuthorityDriftUnknown(
          root,
          runDir,
          record,
          receipt,
          error,
          { providerExecutionReservationOutcome: "unknown" }
        );
        throw Object.assign(
          new Error("Provider result is non-authorizing because action authority drifted before reconciliation", {
            cause: error
          }),
          { code: "SBW_ACTION_AUTHORITY_INDETERMINATE" }
        );
      }
    }
    await reserveProviderExecution(
      root,
      record,
      receipt.providerReceipt.executionId,
      outcome,
      { onBoundary }
    );
    await onBoundary("provider-reservation");
    if (governedCommitTransitionRequired) {
      try {
        const currentValidation = await validateGovernedCommitReconciliationAuthority(
          root,
          runId,
          runDir,
          record,
          receipt,
          "Governed Git commit source persistence"
        );
        const currentTransition = governedCommitSourceTransition(
          record,
          receipt,
          currentValidation,
          governedCommitTransition.at
        );
        if (digestObject(currentTransition) !== digestObject(governedCommitTransition)) {
          throw new Error("Governed Git commit source state changed during reconciliation");
        }
        governedCommitValidation = currentValidation;
      } catch (error) {
        await persistActionAuthorityDriftUnknown(
          root,
          runDir,
          record,
          receipt,
          error,
          { providerExecutionReservationOutcome: "success" }
        );
        throw Object.assign(
          new Error("Governed Git commit is non-authorizing because source authority drifted before persistence", {
            cause: error
          }),
          { code: "SBW_ACTION_AUTHORITY_INDETERMINATE" }
        );
      }
    }
    if (providerActionSourceTransitionRequired) {
      try {
        await assertFrozenProviderActionEvidenceGate(
          root,
          runId,
          await loadRun(root, runId),
          record,
          "Provider action source persistence"
        );
        const currentValidation = await validateProviderActionSourceMutation(
          root,
          await loadRun(root, runId),
          record,
          receipt.providerReceipt
        );
        if (
          currentValidation.descriptorDigest !== providerActionSourceValidation.descriptorDigest ||
          currentValidation.currentSourceBinding.digest !== providerActionSourceValidation.currentSourceBinding.digest ||
          currentValidation.currentSentinel.digest !== providerActionSourceValidation.currentSentinel.digest
        ) {
          throw new Error("Provider action source mutation changed during reconciliation");
        }
        providerActionSourceValidation = currentValidation;
      } catch (error) {
        await persistActionAuthorityDriftUnknown(
          root,
          runDir,
          record,
          receipt,
          error,
          { providerExecutionReservationOutcome: "success" }
        );
        throw Object.assign(
          new Error("Provider source mutation is non-authorizing because action authority drifted before persistence", {
            cause: error
          }),
          { code: "SBW_ACTION_AUTHORITY_INDETERMINATE" }
        );
      }
    }
    if (outcome === "success" && run.contract.schemaVersion === 2 && !sourceMutatingReconciliation) {
      try {
        await assertSpentActionEvidenceGate(
          root,
          runId,
          await loadRun(root, runId),
          record,
          "Action success persistence"
        );
      } catch (error) {
        await persistActionAuthorityDriftUnknown(
          root,
          runDir,
          record,
          receipt,
          error,
          { providerExecutionReservationOutcome: "success" }
        );
        throw Object.assign(
          new Error("Provider result is non-authorizing because action authority drifted before persistence", {
            cause: error
          }),
          { code: "SBW_ACTION_AUTHORITY_INDETERMINATE" }
        );
      }
    }
    const providerSourceTransition = providerActionSourceTransitionRequired
      ? providerActionSourceBindingTransition(record, receipt, providerActionSourceValidation, nowIso())
      : null;
    let governedCommitSuccessReplay = null;
    if (governedCommitTransition && governedCommitIssuedProof) {
      governedCommitSuccessReplay = await prepareGovernedCommitSuccessReplayBinding(
        root, await loadRun(root, runId), record, receipt,
        governedCommitValidation, governedCommitTransition, governedCommitIssuedProof
      );
      const boundSuccess = governedCommitSuccessJournal(await readJournalRecords(root, runDir), record);
      if (boundSuccess) {
        assertGovernedCommitSuccessJournalBinding(boundSuccess, governedCommitSuccessReplay, record);
      } else {
        await appendJournal(root, runDir, GOVERNED_COMMIT_SUCCESS_BOUND_EVENT, {
          version: 1, runId, tokenHash: record.tokenHash, attemptId,
          issuedProofDigest: governedCommitIssuedProof.proofDigest,
          bindingDigest: governedCommitSuccessReplay.bindingDigest,
          binding: governedCommitSuccessReplay
        });
      }
    }
    const target = safeJoin(runDir, "actions", `${record.tokenHash}.json`);
    const next = {
      ...record,
      outcome,
      receipt,
      reconciledAt: nowIso(),
      ...(governedCommitTransition ? { sourceBindingTransition: governedCommitTransition } : {}),
      ...(governedCommitSuccessReplay ? { governedCommitSuccessReplay } : {}),
      ...(providerSourceTransition ? { sourceBindingTransition: providerSourceTransition } : {}),
      ...(["pr.create", "worktree.create"].includes(record.action) && outcome === "success"
        ? { ownedResource: record.action === "pr.create" ? `pull/${receipt.providerReceipt.number}` : record.resource }
        : {})
    };
    await atomicWriteJson(root, target, next);
    await onBoundary("action-persistence");
    if (governedCommitTransition) {
      await transitionGovernedCommitSourceBinding(
        root,
        runDir,
        next,
        receipt,
        governedCommitValidation,
        governedCommitTransition
      );
    }
    if (providerSourceTransition) {
      await transitionProviderActionSourceBinding(
        root,
        runDir,
        next,
        receipt,
        providerActionSourceValidation
      );
    }
    if (record.action === "plugin.cache.publish" && outcome === "success") {
      await finalizePluginCacheReadiness(runId, attemptId, receipt.providerReceipt);
    }
    const reconciliationDetails = {
      recoveredUnknown: recoveringUnknown,
      recoveredUnknownSuccess: recoveringUnknownSuccess,
      recoveredUnknownFailure: recoveringUnknownFailure
    };
    if (governedCommitSuccessReplay) {
      await appendGovernedCommitSuccessCompletion(root, runDir, next, governedCommitSuccessReplay, reconciliationDetails);
    } else {
      await appendJournal(root, runDir, "action.reconciled", { attemptId, outcome, ...reconciliationDetails });
    }
    if (["pr.create", "worktree.create"].includes(record.action) && outcome === "success") {
      const ownedResource = record.action === "pr.create" ? `pull/${receipt.providerReceipt.number}` : record.resource;
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
      await releaseCreationResource(
        root,
        record.creationReservation,
        creationReservationOwnerFromAction(record)
      );
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
    reviewEvidenceSupersessions: await listJsonRecords(
      root,
      safeJoin(run.runDir, REVIEW_EVIDENCE_SUPERSESSION_DIRECTORY)
    ),
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
    const reservation = await readJson(root, target);
    const identity = validateCreationReservationIdentity(reservation);
    validateCreationReservationRecord(reservation, identity);
    if (!isPublicAutoRunBinding(await loadRun(root, reservation.runId).catch(() => null))) continue;
    const observedOwner = validateCreationReservationOwner(reservation);
    await withCreationReservationLock(root, identity, async () => {
      const current = await readJsonIfExists(root, creationReservationPath(root, identity));
      if (!isPublicAutoRunBinding(await loadRun(root, (current ?? reservation).runId).catch(() => null))) return;
      const bound = current ?? reservation;
      const action = await readJsonIfExists(
        root,
        safeJoin(runDirectory(root, bound.runId), "actions", `${bound.tokenHash}.json`)
      );
      if (!isPublicAutoActionRecord(action)) return;
      if (!current) {
        await releaseCreationResourceLocked(root, identity, observedOwner);
        return;
      }
      validateCreationReservationRecord(current, identity);
      if (digestObject(current) !== digestObject(reservation)) return;
      if (Date.parse(current.expiresAt ?? "") > Date.now()) return;
      const owner = validateCreationReservationOwner(current);
      if (!action || action.status === "issued") {
        await releaseCreationResourceLocked(root, identity, owner);
      }
    });
  }
}

export async function cleanupRuns(root, { olderThanDays, apply = false }) {
  await ensureStateRoot(root);
  if (apply) await reapExpiredCreationReservations(root);
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
    let actionJournal = [];
    let actionJournalValid = true;
    try {
      actionJournal = await readJournalRecords(root, runDir);
    } catch {
      actionJournalValid = false;
    }
    const pendingSideEffect = !actionJournalValid || actions.some((action) => !isSettledActionRecord(action, actionJournal));
    const quarantinedAction = actions.some((action) => (
      !isPublicAutoActionRecord(action) || UNSUPPORTED_GOVERNED_ACTIONS.has(action.action) ||
      isDeferredGovernedAction(contract, action.action)
    ));
    if (
      state &&
      isPublicAutoRunBinding({ contract, manifest }) &&
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
          let actionJournal = [];
          let actionJournalValid = true;
          try {
            actionJournal = await readJournalRecords(root, runDir);
          } catch {
            actionJournalValid = false;
          }
          const pendingSideEffect = !actionJournalValid || actions.some((action) => !isSettledActionRecord(action, actionJournal));
          const quarantinedAction = actions.some((action) => (
            !isPublicAutoActionRecord(action) || UNSUPPORTED_GOVERNED_ACTIONS.has(action.action) ||
            isDeferredGovernedAction(contract, action.action)
          ));
          const terminalAt = Date.parse(state?.updatedAt ?? "");
          const oldEnough = Number.isFinite(terminalAt)
            ? terminalAt < cutoff
            : candidateMtimes.get(runId) < cutoff;
          if (
            state &&
            isPublicAutoRunBinding({ contract, manifest }) &&
            ["completed", "no_op", "cancelled_superseded", "cancelled_evidence_sufficient"].includes(state.status) &&
            oldEnough &&
            ownedResourcesCleared &&
            !pendingSideEffect &&
            !quarantinedAction
          ) {
            for (const entry of ownedResources) {
              await releaseCreationResource(
                root,
                entry.creationReservation,
                entry.creationReservationOwner
              );
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
