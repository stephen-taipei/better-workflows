// SPDX-License-Identifier: AGPL-3.0-only
// Unprivileged process capture for Auto review and formal evaluation.
// The installed host signer stays self-contained and retains its own copy.

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

// Direct POSIX captures use a Node supervisor as a stable process-group
// leader.  The target may exit or fork descendants, but this anchor remains
// alive until the parent explicitly tears down the group.  That makes the
// numeric PGID an incarnation-bound handle instead of a best-effort lookup
// that could be recycled between an asynchronous close event and cleanup.
const DIRECT_CAPTURE_SUPERVISOR_SOURCE = [
  "const fs = require('node:fs');",
  "const { spawn } = require('node:child_process');",
  "const target = process.argv[1];",
  "const targetArgs = JSON.parse(process.argv[2]);",
  "const cwd = process.argv[3];",
  "const parentPid = process.ppid;",
  "let reported = false;",
  "let forceScheduled = false;",
  "let child;",
  "const forceKill = () => { try { process.kill(0, 'SIGKILL'); } catch {} };",
  "const scheduleForceKill = () => { if (forceScheduled) return; forceScheduled = true; setTimeout(forceKill, 100); };",
  "for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) process.on(signal, scheduleForceKill);",
  "const watchdog = setInterval(() => { if (process.ppid !== parentPid) { try { process.kill(0, 'SIGKILL'); } catch {} } }, 25);",
  "watchdog.unref();",
  "const report = (code, signal) => { if (reported) return; reported = true; try { fs.writeSync(3, JSON.stringify({ schemaVersion: 1, code: code ?? null, signal: signal ?? null }) + '\\n'); } catch {} };",
  // Node may mark these inherited output descriptors nonblocking. Native
  // synchronous writers then fail with EAGAIN/WouldBlock when a pipe fills.
  // Restore blocking output before spawning the target; the outer capture
  // still drains asynchronously and enforces its output/timeout/group limits.
  // Missing runtime support fails before launching any target.
  "const blockingOutput = () => { for (const stream of [process.stdout, process.stderr]) { if (typeof stream?._handle?.setBlocking !== 'function') throw new Error('Blocking output is unavailable'); stream._handle.setBlocking(true); } };",
  "try { blockingOutput(); child = spawn(target, targetArgs, { cwd, env: process.env, stdio: ['pipe', 'inherit', 'inherit', 'ignore'] }); } catch { report(126, null); }",
  "if (child) { process.stdin.pipe(child.stdin); child.stdin.on('error', () => {}); child.once('error', () => report(126, null)); child.once('close', (code, signal) => report(code, signal)); }",
  "setInterval(() => {}, 1000);"
].join(" ");

function safeEnvironment(extra = {}) {
  const allowed = [
    "LANG",
    "LC_ALL"
  ];
  const environment = {
    PATH: SAFE_PATH,
    ...Object.fromEntries(allowed
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]))
  };
  return { ...environment, ...extra };
}

function terminate(child, signal, killFn = process.kill) {
  // Never signal a numeric group id after the original group disappeared;
  // that id may already belong to an unrelated process incarnation.
  if (!child.pid || !processGroupIsAlive(child.pid, killFn)) return false;
  try {
    // `spawnCapture` always gives the child a dedicated process group on
    // POSIX.  Signalling the negative pid is therefore the group operation,
    // not merely a best-effort signal to the direct launcher.
    if (process.platform !== "win32") killFn(-child.pid, signal);
    else killFn(child.pid, signal);
    return true;
  } catch {
    // Never fall back to signalling the numeric leader PID on POSIX: after a
    // failed group signal that PID may already have been recycled.
    if (process.platform !== "win32") return false;
    try { child.kill(signal); return true; } catch { return false; }
  }
}

function processGroupIsAlive(pid, killFn = process.kill) {
  if (!pid) return false;
  // A signal-zero check on only `-pid` proves that some group currently owns
  // the number, not that it is the group created for this capture.  Every
  // POSIX capture keeps its original supervisor/keeper leader alive until
  // teardown, so require that stable leader before inspecting the group.
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

// Test-only seam: if the stable leader has disappeared, callers must not
// issue a negative-PGID signal even when an unrelated group has reused it.
export function terminateProcessGroupForTest(pid, signal, killFn) {
  return terminate({ pid, kill: () => undefined }, signal, killFn);
}

const LINUX_TERMINATED_PROCESS_STATES = new Set(["Z", "X", "x"]);

function parseLinuxProcessStat(raw) {
  // /proc/<pid>/stat wraps the command name in parentheses. The name may
  // itself contain spaces or closing parentheses, so greedily bind the last
  // delimiter that is followed by state, PPID, and process-group fields.
  const match = /^(?:[1-9][0-9]*) \((.*)\) ([A-Za-z]) (-?[0-9]+) (-?[0-9]+)(?: |$)/s.exec(String(raw ?? ""));
  if (!match) return null;
  const processGroupId = Number(match[4]);
  if (!Number.isSafeInteger(processGroupId)) return null;
  return { state: match[2], processGroupId };
}

function linuxProcessGroupStateFromStats(statRecords, processGroupId) {
  let sawMember = false;
  let uncertain = false;
  for (const raw of statRecords) {
    const parsed = parseLinuxProcessStat(raw);
    if (!parsed) {
      uncertain = true;
      continue;
    }
    if (parsed.processGroupId !== processGroupId) continue;
    sawMember = true;
    if (!LINUX_TERMINATED_PROCESS_STATES.has(parsed.state)) return "live";
  }
  if (uncertain) return "unknown";
  return sawMember ? "zombie-only" : "absent";
}

// Test-only seam for the Linux /proc interpretation. Runtime callers still
// obtain every record directly from the kernel-owned procfs below.
export function linuxProcessGroupStateForTest(statRecords, processGroupId) {
  return linuxProcessGroupStateFromStats(statRecords, processGroupId);
}

export function linuxProcessStateForTest(statRecord) {
  return parseLinuxProcessStat(statRecord)?.state ?? "unknown";
}

function linuxProcfsIsTransparent(mountInfo) {
  for (const line of String(mountInfo ?? "").split("\n")) {
    const fields = line.trim().split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields[4] !== "/proc" || fields[separator + 1] !== "proc") continue;
    const options = `${fields[5] ?? ""},${fields[separator + 3] ?? ""}`.split(",");
    const hidepid = options.find((option) => option.startsWith("hidepid="));
    return hidepid === undefined || ["hidepid=0", "hidepid=off"].includes(hidepid);
  }
  return false;
}

export function linuxProcfsIsTransparentForTest(mountInfo) {
  return linuxProcfsIsTransparent(mountInfo);
}

async function linuxProcessGroupState(processGroupId, deadline = Number.POSITIVE_INFINITY) {
  try {
    // hidepid can omit live members owned by another uid without producing a
    // per-entry read error. Never infer zombie-only cleanup from that view.
    if (!linuxProcfsIsTransparent(await readFile("/proc/self/mountinfo", "utf8"))) return "unknown";
  } catch {
    return "unknown";
  }
  let entries;
  try {
    entries = await readdir("/proc");
  } catch {
    return "unknown";
  }
  const records = [];
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    if (Date.now() >= deadline) return "unknown";
    try {
      records.push(await readFile(`/proc/${entry}/stat`, "utf8"));
    } catch (error) {
      // A process disappearing between readdir and read is expected. Any
      // other failure leaves membership uncertain and therefore fails closed.
      if (!["ENOENT", "ESRCH"].includes(error.code)) records.push(null);
    }
  }
  return linuxProcessGroupStateFromStats(records, processGroupId);
}

async function processGroupExists(pid, {
  killFn = process.kill,
  platform = process.platform,
  linuxStateFn = linuxProcessGroupState,
  deadline = Number.POSITIVE_INFINITY
} = {}) {
  if (!pid) return false;
  const target = platform === "win32" ? pid : -pid;
  try {
    killFn(target, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    // EPERM and unfamiliar probe failures prove no absence. In particular,
    // do not combine an unauthorized signal probe with a potentially hidden
    // procfs view and then infer that the group is gone.
    return true;
  }
  if (platform !== "linux") return true;
  const state = await linuxStateFn(pid, deadline);
  if (state === "zombie-only") return false;
  if (state !== "absent") return true;
  // The group existed immediately before the procfs scan. A no-member snapshot
  // is only conclusive if a fresh kernel probe now reports ESRCH; otherwise a
  // namespace, permissions, or scan race remains fail-closed.
  try {
    killFn(target, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export async function processGroupExistsForTest(pid, options) {
  return processGroupExists(pid, options);
}

async function waitForProcessGroupExit(pid, timeoutMs = 2_000) {
  // Observation is not signalling: after the stable leader exits, descendants
  // may still be dying. Never equate leader disappearance with group absence.
  // A recycled or inaccessible group is conservatively not a cleanup proof.
  const deadline = Date.now() + timeoutMs;
  while (await processGroupExists(pid, { deadline }) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !(await processGroupExists(pid, { deadline }));
}

export function spawnCapture(command, args, {
  input,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  encoding = "utf8",
  env = safeEnvironment(),
  abortSignal = null,
  cleanupGraceMs = 2_000,
  onSpawn = null,
  ...unsupportedOptions
  } = {}) {
  return new Promise((resolve, reject) => {
    if (Object.keys(unsupportedOptions).length > 0) {
      reject(new Error("Auto process capture does not accept extra execution options"));
      return;
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
        !Number.isSafeInteger(cleanupGraceMs) || cleanupGraceMs < 1 ||
        !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
      reject(new Error("Host capture bounded policy is invalid"));
      return;
    }
    if (input !== undefined && typeof input !== "string" && !(input instanceof Uint8Array)) {
      reject(new Error("Host capture input must be bytes or a string"));
      return;
    }
    const supervised = process.platform !== "win32";
    const supervisorCwd = cwd ?? process.cwd();
    const spawnOptions = {
      cwd: supervised ? "/" : cwd,
      env,
      shell: false,
      // A dedicated session/process group is part of the host execution
      // contract.  The POSIX group is terminated as a unit below; Windows
      // falls back to the direct process handle because negative process-group
      // signals are not available there.
      detached: true,
      stdio: supervised ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"]
    };
    const child = spawn(
      supervised ? process.execPath : command,
      supervised
        ? ["-e", DIRECT_CAPTURE_SUPERVISOR_SOURCE, command, JSON.stringify(args), supervisorCwd]
        : args,
      spawnOptions
    );
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let terminationRequested = false;
    let settled = false;
    let timeout;
    let cleanupPromise = null;
    let supervisorResult = null;
    let supervisorProtocolError = null;
    let captureError = null;
    let onSpawnPromise = Promise.resolve();
    let supervisorBuffer = "";
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", requestTermination);
      if (error) reject(error);
      else resolve(result);
    };
    const cleanupProcessGroup = () => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        if (!child.pid) return true;
        if (processGroupIsAlive(child.pid)) terminate(child, "SIGTERM");
        if (await waitForProcessGroupExit(child.pid, cleanupGraceMs)) return true;
        if (processGroupIsAlive(child.pid)) terminate(child, "SIGKILL");
        return waitForProcessGroupExit(child.pid, cleanupGraceMs);
      })();
      return cleanupPromise;
    };
    const requestTermination = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      // Start cleanup immediately.  Waiting for the direct launcher `close`
      // event is insufficient: a forked evaluator descendant can outlive its
      // parent and keep work running without an owned process handle.
      void cleanupProcessGroup();
    };
    const handleSupervisorData = (chunk) => {
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
          requestTermination();
        } catch (error) {
          supervisorProtocolError = new Error(`Host capture supervisor result was invalid: ${error.message}`);
          requestTermination();
        }
      }
    };
    child.stdio[3]?.on("data", handleSupervisorData);
    if (abortSignal) {
      if (abortSignal.aborted) requestTermination();
      else abortSignal.addEventListener("abort", requestTermination, { once: true });
    }
    const collect = (bucket) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        outputExceeded = true;
        requestTermination();
        return;
      }
      if (!outputExceeded) bucket.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      if (!child.pid) finish(error);
      else {
        captureError ??= error;
        requestTermination();
      }
    });
    // A launcher or evaluator may exit before the request body is fully
    // accepted.  Treat the resulting broken pipe as a normal child-exit
    // condition; without this listener Node reports an unhandled EPIPE and
    // bypasses the signed failure ledger/receipt path.
    child.stdin.on("error", (error) => {
      if (!["EPIPE", "ERR_STREAM_DESTROYED"].includes(error.code)) {
        captureError ??= error;
        requestTermination();
      }
    });
    if (onSpawn !== null && typeof onSpawn !== "function") {
      captureError = new Error("Host capture onSpawn hook must be a function");
      requestTermination();
    } else if (onSpawn) {
      onSpawnPromise = Promise.resolve().then(() => onSpawn(child)).catch((error) => {
        captureError ??= error;
        requestTermination();
      });
    }
    child.on("close", (code, signal) => {
      void (async () => {
        await onSpawnPromise;
        const groupTerminated = await cleanupProcessGroup();
        if (supervisorBuffer.trim() && !supervisorResult && !supervisorProtocolError) {
          supervisorProtocolError = new Error("Host capture supervisor result was incomplete");
        }
        const result = {
          pid: child.pid,
          code: supervisorResult?.code ?? code,
          signal: supervisorResult ? supervisorResult.signal : signal,
          timedOut,
          outputExceeded,
          groupTerminated,
          stdout: encoding === null ? Buffer.concat(stdout) : Buffer.concat(stdout).toString(encoding),
          stderr: encoding === null ? Buffer.concat(stderr) : Buffer.concat(stderr).toString(encoding)
        };
        if (!groupTerminated) {
          const error = new Error("Host child process group did not terminate within the cleanup deadline");
          error.execution = result;
          finish(error);
          return;
        }
        if (supervisorProtocolError || captureError) {
          const error = supervisorProtocolError ?? captureError;
          error.execution = result;
          finish(error);
          return;
        }
        finish(null, result);
      })().catch((error) => finish(error));
    });
    child.stdin.end(input);
    timeout = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);
  });
}
