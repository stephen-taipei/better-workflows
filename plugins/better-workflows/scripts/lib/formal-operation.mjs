// SPDX-License-Identifier: AGPL-3.0-only
import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyBoundedBytesV1 } from "./private-input-snapshot-v1.mjs";
import { spawnCapture } from "./process-capture.mjs";
import { formalProtectedCaptureClientV2 } from "./formal-protected-capture-client-v2.mjs";
import { parseStrictJsonV1 } from "./strict-json-v1.mjs";
import { createFormalSuiteEnvironment } from "./formal-environment.mjs";
import { formalCaptureObservation, formalCaptureSucceeded } from "./formal-suite-runner.mjs";

// Separate from the CI coverage policy: these lanes each run the full suite.
export const FORMAL_FULL_PROFILE = Object.freeze({
  id: "v5-macos-full-node22-24-v1",
  platform: "darwin",
  arch: "arm64",
  lanes: Object.freeze([
    Object.freeze({ id: "node22", nodeVersion: "22.23.3" }),
    Object.freeze({ id: "node24", nodeVersion: "24.21.0" })
  ])
});
export const FORMAL_OPERATION_TIMEOUT_MS = 95 * 60 * 1000;
export const FORMAL_OPERATION_RESERVE_MS = 30 * 1000;
export const FORMAL_LANE_TIMEOUT_MS = 45 * 60 * 1000;
const CLEANUP_GRACE_MS = 5000;
const PROBE_TIMEOUT_MS = 10000;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const READBACK_WORKER = fileURLToPath(new URL("../formal-commit-worker.mjs", import.meta.url));

function privateCaptureSnapshot(result, maxOutputBytes) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { execution: result, valid: false, observation: formalCaptureObservation(result) };
  }
  try {
    const stdout = copyBoundedBytesV1(result.stdout, { maxBytes: maxOutputBytes });
    const remainingBytes = maxOutputBytes - stdout.byteLength;
    const stderr = copyBoundedBytesV1(result.stderr, { maxBytes: Math.max(1, remainingBytes) });
    if (stderr.byteLength > remainingBytes) throw new Error("capture output exceeds its aggregate byte bound");
    const execution = { ...result, stdout, stderr };
    return { execution, stdout, stderr, valid: true, observation: formalCaptureObservation(execution) };
  } catch {
    // Preserve terminal metadata but do not treat fixture strings or partial
    // copies as proof of the captured output bytes.
    const execution = { ...result };
    delete execution.stdout;
    delete execution.stderr;
    return { execution, valid: false, observation: formalCaptureObservation(execution) };
  }
}

function decodePrivateCapture(snapshot) {
  try {
    if (!snapshot?.valid) throw new Error("capture did not provide bounded raw output bytes");
    const stdout = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot.stdout);
    const stderr = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot.stderr);
    if (!Buffer.from(stdout, "utf8").equals(snapshot.stdout) ||
        !Buffer.from(stderr, "utf8").equals(snapshot.stderr)) {
      throw new Error("capture output failed UTF-8 roundtrip verification");
    }
    return { ...snapshot.execution, stdout, stderr };
  } catch (cause) {
    const error = new Error("Formal operation capture output is not bounded, lossless UTF-8");
    error.code = "FORMAL_CAPTURE_OUTPUT_INVALID";
    error.cause = cause;
    error.execution = snapshot?.execution;
    throw error;
  }
}

/** One stop policy for acquisition, probes, both lanes, and terminalization.
 * Callers must create this before acquiring the slot, checkpoint around each
 * awaited filesystem action, and assertWithinDeadline after terminal writes.
 * At 94:30 success eligibility ends; the last 30s are for failure cleanup and
 * terminalization, not a second window for successful work. Filesystem and
 * onSpawn promises are not forcibly interruptible here. An owned outer
 * supervisor is still needed to bound a coordinator stuck in one of them;
 * this helper alone does not guarantee return by the whole-operation deadline.
 * This helper never authenticates observations or grants release authority.
 */
export function createFormalOperation({
  now = () => performance.now(), signalSource = process, capture = formalProtectedCaptureClientV2() ?? spawnCapture,
  schedule = setTimeout, unschedule = clearTimeout
} = {}) {
  const start = now();
  if (!Number.isFinite(start)) throw new Error("Formal operation requires a monotonic clock");
  const controller = new AbortController();
  let last = start;
  let reason = null;
  let disposed = false;
  let active = 0;
  let cleanupConfirmed = true;
  let readbackController = null;
  const captures = [];
  const stop = (cause, abortReadback = true) => {
    reason ??= cause;
    if (!controller.signal.aborted) controller.abort();
    if (abortReadback && readbackController && !readbackController.signal.aborted) readbackController.abort();
  };
  const elapsed = () => {
    const current = now();
    if (!Number.isFinite(current) || current < last) {
      stop("monotonic-clock-invalid");
      throw new Error("Formal operation monotonic clock is invalid");
    }
    last = current;
    return current - start;
  };
  const checkpoint = (stage = "operation") => {
    const duration = elapsed();
    if (duration >= FORMAL_OPERATION_TIMEOUT_MS - FORMAL_OPERATION_RESERVE_MS) stop("deadline", false);
    if (disposed || reason || !cleanupConfirmed) {
      const error = new Error(`Formal operation cannot continue at ${stage}: ${disposed ? "disposed" : reason ?? "cleanup-unconfirmed"}`);
      error.code = "FORMAL_OPERATION_STOPPED";
      throw error;
    }
    return duration;
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  signalSource.on("SIGINT", interrupt);
  signalSource.on("SIGTERM", terminate);
  const timer = schedule(() => stop("deadline", false), FORMAL_OPERATION_TIMEOUT_MS - FORMAL_OPERATION_RESERVE_MS);
  return Object.freeze({
    signal: controller.signal,
    checkpoint,
    fail(cause = "operation-failed") {
      if (typeof cause !== "string" || !cause || cause.length > 128) throw new Error("Formal operation failure requires a bounded reason");
      stop(cause);
    },
    // Recompute the work cutoff even if timer delivery was delayed by a busy
    // event loop. The failure reserve never restores success eligibility.
    assertWithinDeadline() {
      const duration = elapsed();
      if (duration >= FORMAL_OPERATION_TIMEOUT_MS - FORMAL_OPERATION_RESERVE_MS) stop("deadline");
      if (disposed || reason || active !== 0 || !cleanupConfirmed) {
        throw new Error(`Formal operation has no successful terminal boundary: ${reason ?? "active, disposed, or unconfirmed cleanup"}`);
      }
      return duration;
    },
    snapshot() {
      return { schemaVersion: 1, authority: "none", timeoutMs: FORMAL_OPERATION_TIMEOUT_MS,
        cleanupReserveMs: FORMAL_OPERATION_RESERVE_MS, elapsedMs: elapsed(), stopReason: reason,
        activeCaptures: active, cleanupConfirmed, captures: structuredClone(captures) };
    },
    async capture(command, args, options = {}) {
      const { cwd, env, input, maxOutputBytes = 1024 * 1024, lane = false, kind = lane ? "lane" : "probe", onSpawn = null } = options;
      if (!["probe", "lane", "coordinator"].includes(kind) || (lane && kind !== "lane") ||
          Object.keys(options).some((key) => !["cwd", "env", "input", "maxOutputBytes", "lane", "kind", "onSpawn"].includes(key))) {
        throw new Error("Formal operation capture kind or options are invalid");
      }
      const duration = checkpoint("subprocess dispatch");
      if (active !== 0) throw new Error("Formal operation subprocesses must be serial");
      const limit = kind === "coordinator" ? FORMAL_OPERATION_TIMEOUT_MS - FORMAL_OPERATION_RESERVE_MS : kind === "lane" ? FORMAL_LANE_TIMEOUT_MS : PROBE_TIMEOUT_MS;
      const timeoutMs = Math.min(limit,
        Math.floor(FORMAL_OPERATION_TIMEOUT_MS - FORMAL_OPERATION_RESERVE_MS - duration));
      if (timeoutMs < 1) { stop("deadline"); checkpoint("subprocess dispatch"); }
      const observation = { kind, command: [command, ...args], startedElapsedMs: duration, terminal: null };
      captures.push(observation);
      active += 1;
      let snapshot;
      try {
        const result = await capture(command, args, { cwd, env, input, maxOutputBytes, timeoutMs,
          encoding: null,
          cleanupGraceMs: CLEANUP_GRACE_MS, abortSignal: controller.signal, onSpawn });
        snapshot = privateCaptureSnapshot(result, maxOutputBytes);
      } catch (error) {
        if (error?.execution !== undefined) {
          snapshot = privateCaptureSnapshot(error.execution, maxOutputBytes);
          try { error.execution = decodePrivateCapture(snapshot); }
          catch { error.execution = snapshot.execution; }
        }
        throw error;
      } finally {
        const terminal = snapshot?.execution;
        observation.terminal = snapshot?.observation ?? formalCaptureObservation(terminal);
        cleanupConfirmed &&= terminal?.groupTerminated === true;
        active -= 1;
        observation.finishedElapsedMs = elapsed();
      }
      // Keep the terminal facts when a signal/deadline arrived during capture.
      try { checkpoint("subprocess cleanup"); } catch (error) { error.execution = snapshot?.execution; throw error; }
      return decodePrivateCapture(snapshot);
    },
    async readback(request, { cwd, env } = {}) {
      if (disposed || !reason || active !== 0) throw new Error("Formal readback requires a failed, settled operation");
      // Validate the exact bytes that will cross the process boundary. Accessors
      // or toJSON must not change a validated reconcile into a mutating action.
      const input = JSON.stringify(request);
      if (typeof input !== "string") throw new Error("Formal failure readback only permits the fixed reconciliation worker");
      if (Buffer.byteLength(input) > 64 * 1024) throw new Error("Formal readback request exceeds its byte bound");
      const requestSnapshot = parseStrictJsonV1(input, { maxBytes: 64 * 1024 });
      const keys = requestSnapshot && Object.keys(requestSnapshot).sort().join(",");
      const route = requestSnapshot?.kind === "FullFormalCommitRequestV1" && keys === "action,context,kind,schemaVersion,supervision" ||
        requestSnapshot?.kind === "FullFormalReleaseRequestV1" && keys === "action,commitObservation,context,kind,schemaVersion,supervision";
      if (requestSnapshot?.schemaVersion !== 1 || requestSnapshot.action !== "reconcile" || !route) {
        throw new Error("Formal failure readback only permits the fixed reconciliation worker");
      }
      const duration = elapsed();
      // spawnCapture has separate TERM and KILL cleanup waits. Reserve both.
      const timeoutMs = Math.min(PROBE_TIMEOUT_MS, Math.floor(FORMAL_OPERATION_TIMEOUT_MS - duration - 2 * CLEANUP_GRACE_MS));
      if (timeoutMs < 1) throw new Error("Formal readback has insufficient cleanup budget");
      readbackController = new AbortController();
      const hardTimer = schedule(() => readbackController?.abort(), timeoutMs);
      const observation = { kind: "readback", phase: "failure-only", command: [process.execPath, READBACK_WORKER],
        startedElapsedMs: duration, terminal: null };
      captures.push(observation);
      active += 1;
      let snapshot;
      try {
        const result = await capture(process.execPath, [READBACK_WORKER], { cwd,
          env: createFormalSuiteEnvironment(env?.PATH, env), input, timeoutMs, cleanupGraceMs: CLEANUP_GRACE_MS,
          abortSignal: readbackController.signal, maxOutputBytes: 64 * 1024, encoding: null });
        snapshot = privateCaptureSnapshot(result, 64 * 1024);
        return decodePrivateCapture(snapshot);
      } catch (error) {
        if (!snapshot && error?.execution !== undefined) {
          snapshot = privateCaptureSnapshot(error.execution, 64 * 1024);
          try { error.execution = decodePrivateCapture(snapshot); }
          catch { error.execution = snapshot.execution; }
        } else if (snapshot && error?.execution === undefined) {
          error.execution = snapshot.execution;
        }
        throw error;
      }
      finally {
        unschedule(hardTimer);
        readbackController = null;
        const terminal = snapshot?.execution;
        observation.terminal = snapshot?.observation ?? formalCaptureObservation(terminal);
        cleanupConfirmed &&= terminal?.groupTerminated === true;
        active -= 1;
        observation.finishedElapsedMs = elapsed();
      }
    },
    dispose() {
      if (active !== 0) throw new Error("Formal operation cannot dispose before capture cleanup settles");
      if (!disposed) {
        unschedule(timer);
        signalSource.removeListener("SIGINT", interrupt);
        signalSource.removeListener("SIGTERM", terminate);
        disposed = true;
      }
    }
  });
}

const fs = { access, lstat, open, realpath };
const stamp = (info) => [info.dev, info.ino, info.size, info.mode, info.nlink, info.mtimeMs, info.ctimeMs];
const sameStamp = (left, right) => JSON.stringify(stamp(left)) === JSON.stringify(stamp(right));
function physicalExecutable(info) {
  if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size) ||
      info.size < 1 || info.size > MAX_EXECUTABLE_BYTES) throw new Error("Formal runtime must be a bounded physical executable");
}

async function executableDigest(canonicalPath, operation, files) {
  operation.checkpoint("runtime open");
  const handle = await files.open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    physicalExecutable(before);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < before.size) {
      operation.checkpoint("runtime digest");
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead < 1) throw new Error("Formal runtime changed while hashing");
      position += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const current = await files.lstat(canonicalPath);
    physicalExecutable(current);
    if (!sameStamp(before, after) || !sameStamp(before, current)) throw new Error("Formal runtime changed while hashing");
    operation.checkpoint("runtime digest complete");
    return { sha256: hash.digest("hex"), stamp: stamp(before) };
  } finally { await handle.close(); }
}

const PROBE_SCRIPT = "process.stdout.write(JSON.stringify({nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,executable:require('node:fs').realpathSync(process.execPath)}))";

/** Observe actual executable identity. files is injected only by local tests.
 * Re-observe before/after each lane and compare against the reserved identity.
 */
export async function observeFormalRuntime({ nodePath, laneId, operation, cwd, env, files = fs }) {
  const lane = FORMAL_FULL_PROFILE.lanes.find((entry) => entry.id === laneId);
  if (!lane) throw new Error("Unknown full formal runtime lane");
  if (typeof nodePath !== "string" || !path.isAbsolute(nodePath) || path.resolve(nodePath) !== nodePath) {
    throw new Error("Formal runtime locator must be an absolute normalized path");
  }
  operation.checkpoint("runtime resolution");
  const canonicalPath = await files.realpath(nodePath);
  if (!path.isAbsolute(canonicalPath) || path.resolve(canonicalPath) !== canonicalPath) throw new Error("Formal runtime canonical path is invalid");
  await files.access(canonicalPath, constants.X_OK);
  const before = await executableDigest(canonicalPath, operation, files);
  const probeEnv = createFormalSuiteEnvironment(env?.PATH, env);
  const result = await operation.capture(canonicalPath, ["--input-type=commonjs", "-e", PROBE_SCRIPT], { cwd, env: probeEnv, maxOutputBytes: 4096 });
  if (!formalCaptureSucceeded(result) || result.stderr !== "") throw new Error("Formal runtime probe did not terminate cleanly");
  let identity;
  try { identity = parseStrictJsonV1(result.stdout, { maxBytes: 4096 }); }
  catch { throw new Error("Formal runtime probe returned invalid JSON"); }
  if (identity?.nodeVersion !== lane.nodeVersion || identity.platform !== FORMAL_FULL_PROFILE.platform ||
      identity.arch !== FORMAL_FULL_PROFILE.arch || identity.executable !== canonicalPath ||
      Object.keys(identity).sort().join(",") !== "arch,executable,nodeVersion,platform") {
    throw new Error("Formal runtime probe does not match the pinned profile");
  }
  const after = await executableDigest(canonicalPath, operation, files);
  if (JSON.stringify(before) !== JSON.stringify(after) || await files.realpath(nodePath) !== canonicalPath) {
    throw new Error("Formal runtime identity changed during observation");
  }
  operation.checkpoint("runtime observation complete");
  return Object.freeze({ laneId: lane.id, nodeVersion: lane.nodeVersion, platform: identity.platform,
    arch: identity.arch, path: canonicalPath, executableSha256: after.sha256 });
}

export function assertSameFormalRuntime(expected, observed) {
  if (!expected || !observed || JSON.stringify(expected) !== JSON.stringify(observed)) {
    throw new Error("Formal runtime identity drifted from the reserved profile");
  }
}

export async function observeFormalRuntimes({ nodePaths, operation, cwd, env, files = fs }) {
  if (!nodePaths || Object.keys(nodePaths).sort().join(",") !== "node22,node24") {
    throw new Error("Full formal profile requires exactly node22 and node24 locators");
  }
  const identities = [];
  for (const lane of FORMAL_FULL_PROFILE.lanes) {
    identities.push(await observeFormalRuntime({ nodePath: nodePaths[lane.id], laneId: lane.id, operation, cwd, env, files }));
  }
  if (identities[0].path === identities[1].path) throw new Error("Full formal runtimes must use distinct executable paths");
  return Object.freeze(identities);
}
