import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, readFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, lstat, unlink, chmod } from "node:fs/promises";
import path from "node:path";

import { digestObject } from "./core.mjs";
import {
  createOwnedResourceAdapter,
  isTrustedControllerAdapter,
  loadExecutionRegistry,
  readExecutionRecoveryTaskEffectIntentV1,
  readExecutionRecoveryTaskEffectLaunchV1,
  readExecutionRecoveryTaskEffectOutcomeV1,
  validateExecutionResourceObservationV1
} from "./execution-runtime-v1.mjs";
import {
  isTrustedNativeV3Controller,
  NATIVE_V3_EFFECT_LAUNCH_AUTHORIZATION_KIND,
  NATIVE_V3_EFFECT_LAUNCH_COMMITMENT_KIND,
  NATIVE_V3_EFFECT_LAUNCH_TRANSACTION_KIND
} from "./native-v3-cooperative-controller.mjs";

/**
 * A small, local-only process resource adapter for the V5 execution runtime.
 *
 * The runtime owns the durable intent and fence.  This module owns only the
 * short-lived POSIX process group and a private allocation receipt.  In
 * particular, a PID supplied by a caller is never accepted as an authority
 * to signal a process.
 */

export const POSIX_OWNED_PROCESS_ADAPTER_KIND = "PosixOwnedProcessAdapterV1";
export const POSIX_OWNED_PROCESS_ALLOCATION_KIND = "PosixOwnedProcessAllocationV1";
export const POSIX_OWNED_PROCESS_HANDLE_KIND = "PosixOwnedProcessHandleV1";
export const POSIX_STOP_GRACE_MS = 2_000;
export const POSIX_STOP_TOTAL_MS = 10_000;
export const POSIX_MAX_OUTPUT_BYTES = 64 * 1024;
export const POSIX_BEFORE_LAUNCH_DEFAULT_MS = 2_000;
export const POSIX_BEFORE_LAUNCH_MAX_MS = 30_000;

const POSIX_OWNED_LAUNCH_CLEANUP_RECEIPT_KIND = "PosixOwnedLaunchCleanupReceiptV1";
// Only the real POSIX producer may mint the resource capability accepted by
// native V3 cleanup resolution.  The generic runtime factory remains useful
// for registry fixtures, but its public callback surface is not production
// process ownership evidence.
const POSIX_OWNED_RESOURCE_ADAPTERS = new WeakSet();
const POSIX_OWNED_PROCESS_HANDLE_ENTRIES = new WeakMap();
const POSIX_RECOVERY_EFFECT_QUERIES = new WeakMap();
const POSIX_RECOVERY_LAUNCH_VERIFIERS = new WeakMap();

// Internal registration; the exact one-shot frame capability exists only
// during the trusted controller callback and is never stored in a receipt.
export function bindPosixOwnedRecoveryLaunchVerifierV1(resourceAdapter, verifier) {
  if (!POSIX_RECOVERY_EFFECT_QUERIES.has(resourceAdapter) || typeof verifier !== "function" ||
      POSIX_RECOVERY_LAUNCH_VERIFIERS.has(resourceAdapter)) {
    throw fail("EOWNED_PROCESS_AUTHORITY", "recovery launch verifier requires one original trusted adapter");
  }
  POSIX_RECOVERY_LAUNCH_VERIFIERS.set(resourceAdapter, verifier);
}

export function queryPosixOwnedRecoveryTaskEffectV1(resourceAdapter, input, options) {
  assertTrustedPosixOwnedResourceAdapter(resourceAdapter);
  const query = POSIX_RECOVERY_EFFECT_QUERIES.get(resourceAdapter);
  if (!query) throw fail("EOWNED_PROCESS_QUERY_UNAVAILABLE", "trusted recovery query is unavailable");
  return query(input, options);
}

// A successful controller commit clears its in-flight transaction. Preserve
// the original transaction only behind the exact live adapter/handle pair so
// recovery outcome writers can bind real launch evidence without inventing a
// transaction from the later commitment or trusting a serialized handle.
export function readPosixOwnedProcessLaunchEvidenceV1(resourceAdapter, handle) {
  assertTrustedPosixOwnedResourceAdapter(resourceAdapter);
  const owned = POSIX_OWNED_PROCESS_HANDLE_ENTRIES.get(handle);
  if (!owned || owned.resourceAdapter !== resourceAdapter || !owned.entry.launchTransaction) {
    throw fail("EOWNED_PROCESS_LAUNCH_EVIDENCE", "exact live owned launch evidence is unavailable");
  }
  const { entry, launchRecord } = owned;
  const transaction = validateLaunchTransaction(entry.launchTransaction);
  const body = {
    schemaVersion: 1,
    kind: "PosixOwnedProcessLaunchEvidenceV1",
    allocationId: entry.allocationId,
    runId: entry.context.runId,
    handleId: entry.context.handleId,
    intentId: entry.context.intentId,
    ownedResourceId: entry.context.ownedResourceId,
    controllerId: launchRecord.controllerId,
    transaction: cloneFrozen(transaction),
    launchCommitmentDigest: launchRecord.launchCommitmentDigest,
    allocationRecordDigest: digestObject(launchRecord)
  };
  return cloneFrozen({ ...body, digest: digestObject(body) });
}

export function assertTrustedPosixOwnedResourceAdapter(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function") || !POSIX_OWNED_RESOURCE_ADAPTERS.has(value)) {
    throw new Error("resource adapter was not produced by the POSIX owned process adapter");
  }
  return value;
}

const LAUNCH_TRANSACTION_KEYS = [
  "schemaVersion", "kind", "transactionId", "commitmentId", "authorizationId", "authorizationDigest",
  "reservationId", "reservationDigest", "runId", "executionId", "attemptId", "unitId", "ownedResourceId",
  "sourceBindingDigest", "policyDigest", "revision", "effectBindingDigest", "authorityEpoch", "fence",
  "status", "startedAt", "digest"
];
const OWNED_LAUNCH_RESOLUTION_REQUEST_KEYS = [
  "runId", "handleId", "intentId", "executionId", "attemptId", "unitId", "ownedResourceId",
  "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence", "transactionId", "transactionDigest"
];

const PRIVATE_DIRECTORY = "posix-owned-process-v1";
const ALLOCATION_DIRECTORY = "allocations";
const ALLOCATION_FILE = /^[0-9a-f-]{36}\.json$/;
const TEXT = /^[^\u0000-\u001f\u007f]{1,512}$/;
const PID = /^[0-9]+$/;
const FORBIDDEN_PROCESS_KEYS = new Set([
  "pid", "pgid", "pidFile", "pgidFile", "processId", "processGroupId",
  "leaderPid", "leaderProcessId", "callerPid", "callerPgid", "signalPid",
  "provider", "remote", "url", "admin", "uid", "gid", "shell", "launcher", "launcherPath", "detached"
]);

const SUPERVISOR_SOURCE = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");

let input = "";
process.stdin.setEncoding("utf8");
const control = fs.createWriteStream(null, { fd: 3, autoClose: false });
let config = null;
let configured = false;
let launched = false;
let launchPending = null;
let launchAuthorized = null;
let target = null;
let parentPid = process.ppid;
let watchdog = null;
const send = (message) => {
  try { control.write(JSON.stringify(message) + "\n"); } catch { /* parent is gone */ }
};
const killOwnGroup = (signal) => {
  try { process.kill(0, signal); } catch { /* group is already gone */ }
};
const dispatchTarget = (launchContext = null) => {
  try {
    target = spawn(config.command, Array.isArray(config.args) ? config.args : [], {
      cwd: config.cwd,
      env: config.env,
      shell: false,
      detached: false,
      stdio: ["ignore", "inherit", "inherit"]
    });
  } catch (error) {
    send({ type: "error", message: String(error && error.code ? error.code : "spawn-error") });
    return;
  }
  target.once("error", (error) => {
    send({ type: "error", message: String(error && error.code ? error.code : "spawn-error") });
  });
  target.once("spawn", () => {
    send({
      type: "ready",
      leaderPid: process.pid,
      processGroupId: process.pid,
      targetPid: target.pid,
      ...(launchContext === null ? {} : {
        reservationId: launchContext.reservationId,
        reservationDigest: launchContext.reservationDigest,
        authorizationId: launchContext.authorizationId,
        authorizationDigest: launchContext.authorizationDigest,
        commitmentId: launchContext.commitmentId,
        authorityEpoch: launchContext.authorityEpoch,
        fence: launchContext.fence,
        effectBindingDigest: launchContext.effectBindingDigest
      })
    });
  });
  target.once("close", (code, signal) => {
    send({ type: "exit", code: Number.isInteger(code) ? code : null, signal: signal || null });
    // The parent normally tears down the group after observing this event.
    // Keeping the leader alive preserves a stable group identity for that
    // stop decision; the parent-death watchdog handles a crashed parent.
  });
};
const handleMessage = (message) => {
  if (!message || typeof message !== "object") {
    send({ type: "error", message: "protocol" });
    process.exit(73);
  }
  if (!configured) {
    if (message.type !== "configure") {
      send({ type: "error", message: "configure" });
      process.exit(72);
    }
    config = message;
    configured = true;
    send({ type: "configured" });
    return;
  }
  if (!launched) {
    if (message.type === "cancel") {
      send({ type: "cancelled" });
      setImmediate(() => process.exit(0));
      return;
    }
    if (launchPending !== null) {
      if (message.type !== "launch-authorized" ||
          message.reservationId !== launchPending.reservationId ||
          message.reservationDigest !== launchPending.reservationDigest ||
          message.authorityEpoch !== launchPending.authorityEpoch ||
          message.fence !== launchPending.fence ||
          message.effectBindingDigest !== launchPending.effectBindingDigest ||
          typeof message.authorizationId !== "string" || message.authorizationId.length === 0 ||
          typeof message.authorizationDigest !== "string" || !/^[a-f0-9]{64}$/.test(message.authorizationDigest)) {
        send({ type: "error", message: "launch-authorization" });
        process.exit(72);
        return;
      }
      launchAuthorized = {
        ...launchPending,
        authorizationId: message.authorizationId,
        authorizationDigest: message.authorizationDigest
      };
      launchPending = null;
      send({ type: "launch-commit-request", ...launchAuthorized });
      return;
    }
    if (launchAuthorized !== null) {
      if (message.type === "launch-commit-rejected") {
        send({ type: "cancelled" });
        setImmediate(() => process.exit(0));
        return;
      }
      if (message.type !== "launch-go" ||
          typeof message.commitmentId !== "string" || message.commitmentId.length === 0 ||
          message.reservationId !== launchAuthorized.reservationId ||
          message.reservationDigest !== launchAuthorized.reservationDigest ||
          message.authorizationId !== launchAuthorized.authorizationId ||
          message.authorizationDigest !== launchAuthorized.authorizationDigest ||
          message.authorityEpoch !== launchAuthorized.authorityEpoch ||
          message.fence !== launchAuthorized.fence ||
          message.effectBindingDigest !== launchAuthorized.effectBindingDigest) {
        send({ type: "error", message: "launch-go" });
        process.exit(72);
        return;
      }
      const launchContext = {
        ...launchAuthorized,
        commitmentId: message.commitmentId
      };
      launchAuthorized = null;
      launched = true;
      dispatchTarget(launchContext);
      return;
    }
    if (message.type !== "launch") {
      send({ type: "error", message: "launch" });
      process.exit(72);
    }
    const reservationKeys = ["reservationId", "reservationDigest", "authorityEpoch", "fence", "effectBindingDigest"];
    const hasReservation = reservationKeys.some((key) => Object.hasOwn(message, key));
    if (hasReservation) {
      if (typeof message.reservationId !== "string" || message.reservationId.length === 0 ||
          typeof message.reservationDigest !== "string" || !/^[a-f0-9]{64}$/.test(message.reservationDigest) ||
          !Number.isSafeInteger(message.authorityEpoch) || message.authorityEpoch < 1 ||
          typeof message.fence !== "string" || !/^[a-f0-9]{64}$/.test(message.fence) ||
          typeof message.effectBindingDigest !== "string" || !/^[a-f0-9]{64}$/.test(message.effectBindingDigest)) {
        send({ type: "error", message: "launch-reservation" });
        process.exit(72);
        return;
      }
      launchPending = {
        reservationId: message.reservationId,
        reservationDigest: message.reservationDigest,
        authorityEpoch: message.authorityEpoch,
        fence: message.fence,
        effectBindingDigest: message.effectBindingDigest
      };
      send({ type: "launch-request", ...launchPending });
      return;
    }
    launched = true;
    dispatchTarget(null);
  }
};
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (input.length > 512 * 1024) {
    send({ type: "error", message: "protocol" });
    process.exit(74);
  }
  let index;
  while ((index = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, index);
    input = input.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch {
      send({ type: "error", message: "protocol" });
      process.exit(72);
      return;
    }
    handleMessage(message);
  }
});
process.stdin.on("error", () => process.exit(71));
process.stdin.on("end", () => {
  if (!launched) process.exit(72);
});
// The parent signals the complete group.  Keep the leader alive through
// TERM so its identity remains valid for the later KILL escalation; a
// leader that disappears while descendants remain is never signal-safe.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
process.on("SIGQUIT", () => {});
watchdog = setInterval(() => {
  if (process.ppid !== parentPid) {
    clearInterval(watchdog);
    killOwnGroup("SIGKILL");
  }
}, 25);
`;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertBeforeLaunchTimeout(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > POSIX_BEFORE_LAUNCH_MAX_MS) {
    throw fail("EOWNED_PROCESS_INPUT", `beforeLaunchTimeoutMs must be a positive integer <= ${POSIX_BEFORE_LAUNCH_MAX_MS}`);
  }
  return value;
}

function assertText(value, label, max = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw fail("EOWNED_PROCESS_INPUT", `${label} is invalid`);
  }
  return value;
}

function assertDigest(value, label) {
  const normalized = assertText(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw fail("EOWNED_PROCESS_INPUT", `${label} is invalid`);
  return normalized;
}

function assertAbsolutePath(value, label) {
  assertText(value, label, 4096);
  if (!path.isAbsolute(value)) throw fail("EOWNED_PROCESS_INPUT", `${label} must be absolute`);
  return path.normalize(value);
}

function assertNoProcessIdentityKeys(value, label, seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw fail("EOWNED_PROCESS_INPUT", `${label} is cyclic`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PROCESS_KEYS.has(key)) throw fail("EOWNED_PROCESS_INPUT", `${label}.${key} is not accepted`);
    if (child && typeof child === "object") assertNoProcessIdentityKeys(child, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("EOWNED_PROCESS_INPUT", `${label} is invalid`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw fail("EOWNED_PROCESS_INPUT", `${label} has an unexpected shape`);
  }
}

function validateLaunchTransaction(value, label = "launch transaction") {
  exactKeys(value, LAUNCH_TRANSACTION_KEYS, label);
  if (value.schemaVersion !== 1 || value.kind !== NATIVE_V3_EFFECT_LAUNCH_TRANSACTION_KIND ||
      (value.status !== "in-flight" && value.status !== "unknown")) {
    throw fail("EOWNED_PROCESS_INPUT", `${label} is invalid`);
  }
  for (const key of ["transactionId", "commitmentId", "authorizationId", "reservationId", "runId", "executionId", "attemptId", "unitId", "ownedResourceId"]) {
    assertText(value[key], `${label}.${key}`);
  }
  for (const key of ["authorizationDigest", "reservationDigest", "sourceBindingDigest", "policyDigest", "effectBindingDigest", "fence", "digest"]) {
    assertDigest(value[key], `${label}.${key}`);
  }
  assertText(value.revision, `${label}.revision`);
  if (!Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1) throw fail("EOWNED_PROCESS_INPUT", `${label}.authorityEpoch is invalid`);
  assertText(value.startedAt, `${label}.startedAt`);
  if (digestObject(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "digest"))) !== value.digest) {
    throw fail("EOWNED_PROCESS_INPUT", `${label}.digest is not bound`);
  }
  return value;
}

function nowNumber(now) {
  const value = Number(now());
  if (!Number.isFinite(value) || value < 0) throw fail("EOWNED_PROCESS_CLOCK", "clock is invalid");
  return value;
}

function isoAt(value) {
  return new Date(value).toISOString();
}

function tokenDigest(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function randomToken() {
  return `${randomUUID()}-${randomUUID()}`;
}

async function ensurePrivateDirectory(directory, boundary = null) {
  const absolute = assertAbsolutePath(directory, "private directory");
  const base = boundary ? assertAbsolutePath(boundary, "private directory boundary") : path.parse(absolute).root;
  const relative = path.relative(base, absolute);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw fail("EOWNED_PROCESS_STATE", "private path escapes its root");
  let current = base;
  try {
    const baseEntry = await lstat(current);
    if (baseEntry.isSymbolicLink() || !baseEntry.isDirectory()) throw fail("EOWNED_PROCESS_STATE", "private path is unsafe");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try { await mkdir(current, { mode: 0o700, recursive: true }); }
    catch (mkdirError) { if (mkdirError?.code !== "EEXIST") throw mkdirError; }
    const baseEntry = await lstat(current);
    if (baseEntry.isSymbolicLink() || !baseEntry.isDirectory()) throw fail("EOWNED_PROCESS_STATE", "private path is unsafe");
  }
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw fail("EOWNED_PROCESS_STATE", "private path is unsafe");
      await chmod(current, 0o700).catch(() => {});
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError?.code !== "EEXIST") throw mkdirError; }
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw fail("EOWNED_PROCESS_STATE", "private path is unsafe");
      await chmod(current, 0o700).catch(() => {});
    }
  }
  return absolute;
}

async function assertPrivateFile(file, { allowMissing = false } = {}) {
  try {
    const entry = await lstat(file);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
      throw fail("EOWNED_PROCESS_STATE", "allocation file is unsafe");
    }
    return entry;
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function fsyncDirectory(directory) {
  try {
    const handle = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0));
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Directory fsync is unavailable on some macOS filesystems; the atomic
    // rename and private directory checks still apply.
  }
}

async function writePrivateJson(file, value, { createOnly = false, boundary = null } = {}) {
  await ensurePrivateDirectory(path.dirname(file), boundary);
  if (createOnly) {
    const existing = await assertPrivateFile(file, { allowMissing: true });
    if (existing) throw fail("EOWNED_PROCESS_STATE", "allocation already exists");
  } else {
    await assertPrivateFile(file, { allowMissing: true });
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0), 0o600);
    const bytes = Buffer.from(JSON.stringify(value));
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    await chmod(file, 0o600);
    await fsyncDirectory(path.dirname(file));
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readPrivateJson(file) {
  await assertPrivateFile(file);
  let parsed;
  try { parsed = JSON.parse(await readFile(file, "utf8")); } catch (error) {
    throw fail("EOWNED_PROCESS_STATE", `allocation state is invalid: ${error?.code || "parse"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fail("EOWNED_PROCESS_STATE", "allocation state is invalid");
  return parsed;
}

function allocationPath(directory, allocationId) {
  if (!/^[0-9a-f-]{36}$/.test(allocationId)) throw fail("EOWNED_PROCESS_STATE", "allocation id is invalid");
  return path.join(directory, `${allocationId}.json`);
}

function validateExecutionContext(executionContext) {
  assertNoProcessIdentityKeys(executionContext, "executionContext");
  if (!executionContext || typeof executionContext !== "object" || Array.isArray(executionContext)) {
    throw fail("EOWNED_PROCESS_CONTEXT", "executionContext is required");
  }
  if (executionContext.schemaVersion !== 1) throw fail("EOWNED_PROCESS_CONTEXT", "executionContext schemaVersion is invalid");
  const binding = executionContext.binding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw fail("EOWNED_PROCESS_CONTEXT", "executionContext.binding is required");
  for (const key of ["handleId", "intentId"]) assertText(executionContext[key], `executionContext.${key}`);
  for (const key of ["runId", "ownedResourceId"]) assertText(binding[key], `executionContext.binding.${key}`);
  return {
    schemaVersion: 1,
    handleId: executionContext.handleId,
    intentId: executionContext.intentId,
    runId: binding.runId,
    ownedResourceId: binding.ownedResourceId
  };
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function cloneFrozen(value) {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    throw fail("EOWNED_PROCESS_CONTEXT", "executionContext cannot be cloned");
  }
}

function commandOptions(first, second) {
  let options;
  if (first && typeof first === "object" && first.executionContext) {
    options = { ...first };
  } else {
    options = { ...(second || {}), executionContext: first };
  }
  assertNoProcessIdentityKeys(options, "startOwned options");
  if (options.executionContext === undefined) throw fail("EOWNED_PROCESS_CONTEXT", "executionContext is required");
  const context = validateExecutionContext(options.executionContext);
  const executionContext = cloneFrozen(options.executionContext);
  const command = assertAbsolutePath(options.command, "command");
  const args = options.args === undefined ? [] : options.args;
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string" || /[\u0000]/.test(item) || item.length > 4096)) {
    throw fail("EOWNED_PROCESS_INPUT", "args are invalid");
  }
  const cwd = options.cwd === undefined ? process.cwd() : assertAbsolutePath(options.cwd, "cwd");
  const providedEnv = options.env === undefined ? {} : options.env;
  if (!providedEnv || typeof providedEnv !== "object" || Array.isArray(providedEnv)) throw fail("EOWNED_PROCESS_INPUT", "env is invalid");
  // Target processes receive only the caller's explicit, validated env.  The
  // supervisor has its own minimal PATH above and must not leak controller
  // secrets or ambient variables into the owned task.
  const env = {};
  for (const [key, value] of Object.entries(providedEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof value !== "string" || /[\u0000]/.test(value)) {
      throw fail("EOWNED_PROCESS_INPUT", "env is invalid");
    }
    env[key] = value;
  }
  const requestedLimit = options.maxOutputBytes === undefined ? POSIX_MAX_OUTPUT_BYTES : Number(options.maxOutputBytes);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > POSIX_MAX_OUTPUT_BYTES) {
    throw fail("EOWNED_PROCESS_INPUT", "maxOutputBytes exceeds the fixed limit");
  }
  const effectBindingDigest = options.effectBindingDigest === undefined
    ? null
    : assertDigest(options.effectBindingDigest, "effectBindingDigest");
  return { context, executionContext, command, args: [...args], cwd, env, maxOutputBytes: requestedLimit, effectBindingDigest };
}

async function procStartTime(pid) {
  if (process.platform !== "linux") return null;
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(")");
    if (close < 0) return null;
    const fields = text.slice(close + 2).trim().split(/\s+/);
    return fields[19] || null; // field 22, after pid/comm; index 19 after state
  } catch {
    return null;
  }
}

function syncProcStartTime(pid) {
  // The asynchronous /proc read is used before a signal.  This synchronous
  // probe closes the small check-to-signal window on Linux without accepting a
  // positive-PID fallback on any platform.
  if (process.platform !== "linux") return null;
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(")");
    if (close < 0) return null;
    return text.slice(close + 2).trim().split(/\s+/)[19] || null;
  } catch {
    return null;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw fail("EOWNED_PROCESS_QUERY_ABORTED", "owned process observation was aborted");
}

async function recoveredGroupProbe(record, signal) {
  throwIfAborted(signal);
  const pid = record.leaderPid;
  if (!Number.isSafeInteger(pid) || pid < 1 || record.processGroupId !== pid) {
    return { leader: false, group: false, startTime: null };
  }
  let leader = true;
  try { process.kill(pid, 0); } catch (error) {
    if (error?.code === "ESRCH") leader = false;
    else leader = null;
  }
  const currentStartTime = leader === true ? await procStartTime(pid) : null;
  if (leader === true) {
    // A recovered adapter must prove the PID incarnation before calling a
    // live group active.  Darwin has no /proc start-time source here, so a
    // persisted PID alone is deliberately insufficient after restart.
    if (record.leaderStartTime === null || currentStartTime === null || currentStartTime !== record.leaderStartTime) {
      leader = null;
    }
  }
  throwIfAborted(signal);
  let group;
  try {
    process.kill(-pid, 0);
    group = true;
  } catch (error) {
    group = error?.code === "ESRCH" ? false : null;
  }
  return { leader, group, startTime: currentStartTime };
}

async function groupProbe(entry) {
  const leader = entry.supervisor;
  const pid = entry.leaderPid;
  if (!Number.isSafeInteger(pid) || pid < 1) return { leader: false, group: false };
  let leaderState = Boolean(leader && leader.pid === pid && leader.exitCode === null && leader.signalCode === null);
  if (leaderState) {
    try { process.kill(pid, 0); } catch (error) {
      if (error?.code === "ESRCH") leaderState = false;
      else leaderState = null;
    }
  }
  if (leaderState === true && entry.startTime !== null) {
    const current = syncProcStartTime(pid);
    if (current === null || current !== entry.startTime) leaderState = null;
  }
  // A zero-signal group probe is safe even after the leader exits.  It tells
  // us whether descendants still occupy the original group, but it never
  // authorizes signaling that group once leader/incarnation proof is gone.
  try {
    process.kill(-pid, 0);
    return { leader: leaderState, group: true };
  } catch (error) {
    if (error?.code === "ESRCH") return { leader: leaderState, group: false };
    return { leader: leaderState, group: null };
  }
}

function throwIfUnsafeSignal(entry, probe) {
  if (probe.leader !== true || probe.group !== true) throw fail("EOWNED_PROCESS_SIGNAL_UNKNOWN", "owned process group identity is not proven");
}

async function waitForGroupGone(entry, deadline) {
  if (!Number.isSafeInteger(entry.leaderPid) || entry.leaderPid < 1) return true;
  while (Date.now() < deadline) {
    const probe = await groupProbe(entry);
    if (probe.group === false) return true;
    // A just-issued group KILL can transiently report EPERM while the
    // kernel is tearing down the process group.  We already proved and
    // signalled this exact group above, so keep polling within the bounded
    // cleanup window instead of converting that transient observation into
    // an immediate UNKNOWN result.
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
  const finalProbe = await groupProbe(entry);
  if (finalProbe.group === false) return true;
  if (finalProbe.group === null) return null;
  return false;
}

function startCancelled(reason = "requested") {
  const error = fail("EOWNED_PROCESS_START_CANCELLED", "owned process start was cancelled");
  error.reason = typeof reason === "string" ? reason.slice(0, 128) : "requested";
  return error;
}

async function waitForStartSettled(entry, deadline) {
  if (entry.startSettled) return entry.startResult;
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining === 0) return null;
  let timer;
  try {
    return await Promise.race([
      entry.startSettledPromise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), remaining); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function publicHandle(entry, resourceAdapter) {
  const handle = {
    outcome: "success",
    kind: POSIX_OWNED_PROCESS_HANDLE_KIND,
    schemaVersion: 1,
    allocationId: entry.allocationId,
    runId: entry.context.runId,
    handleId: entry.context.handleId,
    intentId: entry.context.intentId,
    ownedResourceId: entry.context.ownedResourceId,
    startedAt: entry.startedAt
  };
  Object.defineProperty(handle, "completion", { value: entry.completion, enumerable: false });
  Object.defineProperty(handle, "leaderPid", { value: entry.leaderPid, enumerable: false });
  Object.defineProperty(handle, "processGroupId", { value: entry.leaderPid, enumerable: false });
  // Terminal observations update entry.record. Bind launch evidence to the
  // started snapshot, not whichever lifecycle phase a later reader observes.
  POSIX_OWNED_PROCESS_HANDLE_ENTRIES.set(handle, {
    entry, resourceAdapter, launchRecord: cloneFrozen(entry.record)
  });
  return Object.freeze(handle);
}

function stopResult(ownedResourceId, localOutcome, confirmedOwnedScope, message = undefined) {
  return {
    schemaVersion: 1,
    kind: "PosixOwnedProcessStopResultV1",
    ownedResourceId,
    confirmedOwnedScope,
    localOutcome,
    remoteOutcome: "not-applicable",
    ...(message ? { message } : {})
  };
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      record.schemaVersion !== 1 || record.kind !== POSIX_OWNED_PROCESS_ALLOCATION_KIND) {
    throw fail("EOWNED_PROCESS_STATE", "allocation state has an invalid kind");
  }
  for (const key of ["allocationId", "runId", "handleId", "intentId", "ownedResourceId", "ownerTokenDigest", "phase"]) {
    assertText(record[key], `allocation.${key}`);
  }
  if (!/^[0-9a-f-]{36}$/.test(record.allocationId) || !["prepared", "started", "terminal", "indeterminate"].includes(record.phase)) {
    throw fail("EOWNED_PROCESS_STATE", "allocation state is invalid");
  }
  if (record.leaderPid !== null && (!Number.isSafeInteger(record.leaderPid) || record.leaderPid < 1)) throw fail("EOWNED_PROCESS_STATE", "allocation leader is invalid");
  if (record.processGroupId !== null && record.processGroupId !== record.leaderPid) throw fail("EOWNED_PROCESS_STATE", "allocation group is invalid");
  for (const key of ["executionId", "attemptId", "unitId", "sourceBindingDigest", "policyDigest", "revision", "controllerId", "authorityDigest"]) {
    if (record[key] !== undefined && record[key] !== null) assertText(record[key], `allocation.${key}`);
  }
  if (record.leaderStartTime !== undefined && record.leaderStartTime !== null) assertText(record.leaderStartTime, "allocation.leaderStartTime");
  if (record.authorityEpoch !== undefined && record.authorityEpoch !== null &&
      (!Number.isSafeInteger(record.authorityEpoch) || record.authorityEpoch < 1)) {
    throw fail("EOWNED_PROCESS_STATE", "allocation authority epoch is invalid");
  }
  if (record.fence !== undefined && record.fence !== null &&
      typeof record.fence === "string" && !/^[a-f0-9]{64}$/.test(record.fence)) {
    throw fail("EOWNED_PROCESS_STATE", "allocation fence is invalid");
  }
  for (const key of ["effectStarted", "groupTerminated"]) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") throw fail("EOWNED_PROCESS_STATE", `allocation.${key} is invalid`);
  }
  if (record.launchRequested !== undefined && typeof record.launchRequested !== "boolean") {
    throw fail("EOWNED_PROCESS_STATE", "allocation.launchRequested is invalid");
  }
  if (record.launchReservationDigest !== undefined && record.launchReservationDigest !== null) {
    if (typeof record.launchReservationDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.launchReservationDigest)) {
      throw fail("EOWNED_PROCESS_STATE", "allocation.launchReservationDigest is invalid");
    }
  }
  if (record.launchAuthorizationDigest !== undefined && record.launchAuthorizationDigest !== null) {
    if (typeof record.launchAuthorizationDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.launchAuthorizationDigest)) {
      throw fail("EOWNED_PROCESS_STATE", "allocation.launchAuthorizationDigest is invalid");
    }
  }
  if (record.launchCommitmentDigest !== undefined && record.launchCommitmentDigest !== null) {
    if (typeof record.launchCommitmentDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.launchCommitmentDigest)) {
      throw fail("EOWNED_PROCESS_STATE", "allocation.launchCommitmentDigest is invalid");
    }
  }
  for (const key of ["exitCode"]) {
    if (record[key] !== undefined && record[key] !== null && (!Number.isSafeInteger(record[key]) || record[key] < -128 || record[key] > 255)) {
      throw fail("EOWNED_PROCESS_STATE", `allocation.${key} is invalid`);
    }
  }
  if (record.exitSignal !== undefined && record.exitSignal !== null) assertText(record.exitSignal, "allocation.exitSignal", 32);
  if (record.noSendProof !== undefined && record.noSendProof !== null) {
    if (!record.noSendProof || typeof record.noSendProof !== "object" || Array.isArray(record.noSendProof)) {
      throw fail("EOWNED_PROCESS_STATE", "allocation no-send proof is invalid");
    }
    if (record.noSendProof.kind !== "PosixOwnedProcessNoSendProofV1" ||
        record.noSendProof.allocationId !== record.allocationId ||
        record.noSendProof.handleId !== record.handleId ||
        record.noSendProof.intentId !== record.intentId ||
        record.noSendProof.ownedResourceId !== record.ownedResourceId ||
        !/^[a-f0-9]{64}$/.test(record.noSendProof.digest ?? "")) {
      throw fail("EOWNED_PROCESS_STATE", "allocation no-send proof is not bound");
    }
    const { digest: proofDigest, ...proofBody } = record.noSendProof;
    assertText(record.noSendProof.ownerTokenDigest, "allocation no-send proof.ownerTokenDigest");
    assertText(record.noSendProof.reason, "allocation no-send proof.reason", 128);
    if (digestObject(proofBody) !== proofDigest) throw fail("EOWNED_PROCESS_STATE", "allocation no-send proof digest is invalid");
  }
  return record;
}

async function findRecord(directory, context, boundary, requireUnique = false) {
  await ensurePrivateDirectory(directory, boundary);
  let names;
  try { names = await readdir(directory); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (names.length > 1024) throw fail("EOWNED_PROCESS_STATE", "allocation directory exceeds the safety limit");
  let matched = null;
  for (const name of names) {
    if (!ALLOCATION_FILE.test(name)) continue;
    const file = path.join(directory, name);
    const record = validateRecord(await readPrivateJson(file));
    if (record.runId === context.runId && record.handleId === context.handleId && record.ownedResourceId === context.ownedResourceId) {
      if (!requireUnique) return { record, file };
      if (matched) throw fail("EOWNED_PROCESS_STATE", "recovery allocation identity is ambiguous");
      matched = { record, file };
    }
  }
  return matched;
}

export function createPosixOwnedProcessAdapter({
  root,
  stateRoot,
  platform = process.platform,
  spawnImpl = spawn,
  trustedController = null,
  beforeLaunch,
  beforeLaunchTimeoutMs = POSIX_BEFORE_LAUNCH_DEFAULT_MS,
  now = () => Date.now()
} = {}) {
  if (platform !== "darwin" && platform !== "linux") throw fail("EUNSUPPORTED_POSIX_PROCESS_ADAPTER", "POSIX owned process adapter is unsupported on this platform");
  const stateRootPath = assertAbsolutePath(root || stateRoot, "adapter root");
  if (stateRootPath === path.parse(stateRootPath).root) throw fail("EOWNED_PROCESS_INPUT", "adapter root is too broad");
  if (typeof spawnImpl !== "function") throw fail("EOWNED_PROCESS_INPUT", "spawnImpl is invalid");
  if (trustedController !== null &&
      (!isTrustedControllerAdapter(trustedController) || !isTrustedNativeV3Controller(trustedController))) {
    throw fail("EOWNED_PROCESS_INPUT", "trustedController must be created by the native V3 controller producer");
  }
  if (trustedController !== null && typeof trustedController.readExecutionBinding !== "function") {
    throw fail("EOWNED_PROCESS_INPUT", "trustedController cannot produce an execution binding observation");
  }
  if (beforeLaunch !== undefined && typeof beforeLaunch !== "function") throw fail("EOWNED_PROCESS_INPUT", "beforeLaunch is invalid");
  const beforeLaunchTimeout = assertBeforeLaunchTimeout(beforeLaunchTimeoutMs);

  const allocations = path.join(stateRootPath, PRIVATE_DIRECTORY, ALLOCATION_DIRECTORY);
  const active = new Map();
  const activeByResource = new Map();
  // This map is intentionally process-local and private to the real POSIX
  // adapter.  A terminal allocation JSON record is observation data only;
  // the controller may clear an UNKNOWN launch transaction only when this
  // adapter also observed the owned supervisor's bounded cleanup and closed
  // its pending launch frame.  A restarted adapter has no such handle and
  // therefore remains HOLD.
  const ownedLaunchCleanupReceipts = new Map();
  // A terminal stop receipt is also process-local.  It preserves idempotent
  // stopOwned calls made through this adapter while refusing to promote a
  // writable terminal-looking record after a process restart.
  const terminalStopReceipts = new Map();

  const releaseEntry = (entry) => {
    active.delete(entry.allocationId);
    if (activeByResource.get(entry.context.ownedResourceId) === entry) activeByResource.delete(entry.context.ownedResourceId);
  };

  const settleCompletion = (entry, {
    localOutcome = "unknown",
    groupTerminated = false,
    code = entry.targetExit?.code ?? null,
    signal = entry.targetExit?.signal ?? null,
    endedAt = isoAt(nowNumber(now)),
    outputExceeded = entry.outputExceeded
  } = {}) => {
    if (entry.completionSettled) return entry.completionValue;
    entry.completionValue = Object.freeze({
      outcome: localOutcome === "stopped" ? "stopped" : localOutcome === "indeterminate" ? "indeterminate" : "unknown",
      code,
      signal,
      groupTerminated: Boolean(groupTerminated),
      outputExceeded: Boolean(outputExceeded),
      endedAt,
      stdout: Buffer.concat(entry.stdout).toString("utf8"),
      stderr: Buffer.concat(entry.stderr).toString("utf8")
    });
    entry.completionSettled = true;
    entry.resolveCompletion(entry.completionValue);
    return entry.completionValue;
  };

  const settleStart = (entry, result) => {
    if (entry.startSettled) return;
    entry.startSettled = true;
    entry.starting = false;
    entry.startResult = result;
    entry.resolveStart(result);
  };

  const requestCancel = (entry, reason) => {
    if (!entry.cancelRequested) {
      entry.cancelRequested = true;
      entry.cancelReason = typeof reason === "string" ? reason.slice(0, 128) : "requested";
      entry.resolveCancel?.(entry.cancelReason);
    }
  };

  const assertStartLive = (entry) => {
    if (entry.cancelRequested) throw startCancelled(entry.cancelReason);
  };

  const persist = async (entry, patch) => {
    entry.record = validateRecord({ ...entry.record, ...patch });
    await writePrivateJson(entry.recordPath, entry.record, { boundary: stateRootPath });
    entry.recordPersisted = true;
  };

  const rememberOwnedLaunchCleanup = (entry) => {
    if (!entry.recordPersisted || entry.record.phase !== "terminal" || entry.record.groupTerminated !== true ||
        entry.record.launchRequested !== true || entry.record.effectStarted !== true || entry.record.noSendProof !== null ||
        entry.record.launchCommitmentDigest !== null || typeof entry.launchTransactionId !== "string" ||
        typeof entry.launchTransactionDigest !== "string" || entry.launchFrameClosed !== true || entry.supervisorExited !== true) {
      return null;
    }
    const body = {
      schemaVersion: 1,
      kind: POSIX_OWNED_LAUNCH_CLEANUP_RECEIPT_KIND,
      status: "confirmed",
      allocationId: entry.record.allocationId,
      transactionId: entry.launchTransactionId,
      transactionDigest: entry.launchTransactionDigest,
      runId: entry.record.runId,
      handleId: entry.record.handleId,
      intentId: entry.record.intentId,
      executionId: entry.record.executionId,
      attemptId: entry.record.attemptId,
      unitId: entry.record.unitId,
      ownedResourceId: entry.record.ownedResourceId,
      controllerId: entry.record.controllerId,
      authorityDigest: entry.record.authorityDigest,
      sourceBindingDigest: entry.record.sourceBindingDigest,
      policyDigest: entry.record.policyDigest,
      revision: entry.record.revision,
      authorityEpoch: entry.record.authorityEpoch,
      fence: entry.record.fence,
      launchRequested: true,
      effectStarted: true,
      noSendProof: null,
      groupTerminated: true,
      lateLaunchBlocked: true,
      launchReservationDigest: entry.record.launchReservationDigest,
      launchAuthorizationDigest: entry.record.launchAuthorizationDigest,
      launchCommitmentDigest: null,
      allocationRecordDigest: digestObject(entry.record),
      observedAt: entry.record.endedAt
    };
    const receipt = Object.freeze({ ...body, digest: digestObject(body) });
    ownedLaunchCleanupReceipts.set(entry.allocationId, receipt);
    return receipt;
  };

  const rememberTerminalStop = (entry) => {
    if (!entry.recordPersisted || entry.record.phase !== "terminal" || entry.record.groupTerminated !== true) return;
    terminalStopReceipts.set(entry.record.allocationId, Object.freeze({
      allocationId: entry.record.allocationId,
      runId: entry.record.runId,
      handleId: entry.record.handleId,
      ownedResourceId: entry.record.ownedResourceId,
      recordDigest: digestObject(entry.record),
      transaction: entry.launchTransaction === null ? null : cloneFrozen(entry.launchTransaction)
    }));
  };

  const finish = async (entry, options = {}) => {
    if (entry.finished) return entry.completionValue;
    let {
      phase = "terminal",
      localOutcome = "stopped",
      groupTerminated = false,
      code = entry.targetExit?.code ?? null,
      signal = entry.targetExit?.signal ?? null,
      outputExceeded = entry.outputExceeded,
      persistRecord = true
    } = options;
    entry.phase = phase;
    const endedAt = isoAt(nowNumber(now));
    // Readiness is only an observation from the supervisor.  The durable
    // launch reservation is the one-way recovery boundary that blocks a
    // no-send proof; a crash before `ready` therefore remains UNKNOWN once a
    // launch candidate was reserved, even if no target effect was observed.
    const launchRequested = entry.launchRequested === true || entry.record.launchRequested === true;
    const effectStarted = launchRequested || entry.readySeen === true || entry.phase === "started" || entry.record.effectStarted === true;
    const noSendBody = !launchRequested && entry.record.launchReservationDigest === null &&
      entry.record.launchReservationDigest !== undefined && !effectStarted && phase === "terminal" && groupTerminated === true
      ? {
          schemaVersion: 1,
          kind: "PosixOwnedProcessNoSendProofV1",
          allocationId: entry.allocationId,
          runId: entry.context.runId,
          handleId: entry.context.handleId,
          intentId: entry.context.intentId,
          ownedResourceId: entry.context.ownedResourceId,
          ownerTokenDigest: entry.record.ownerTokenDigest,
          reason: entry.cancelReason ?? "startup-never-launched"
        }
      : null;
    const noSendProof = noSendBody ? { ...noSendBody, digest: digestObject(noSendBody) } : null;
    let persistenceError = null;
    if (persistRecord && entry.recordPersisted) try {
      await persist(entry, {
        phase,
        endedAt,
        localOutcome,
        groupTerminated,
        launchRequested,
        launchReservationDigest: entry.launchReservationDigest ?? entry.record.launchReservationDigest ?? null,
        effectStarted,
        noSendProof,
        exitCode: code,
        exitSignal: signal
      });
    } catch (error) {
      // The resource remains active and retryable when its receipt cannot be
      // durably written.  Never expose a successful stop for an unpersisted
      // result, but always settle the caller's completion promise.
      persistenceError = error;
      phase = "indeterminate";
      localOutcome = "indeterminate";
      groupTerminated = false;
      entry.phase = phase;
    }
    settleCompletion(entry, { localOutcome, groupTerminated, code, signal, endedAt, outputExceeded });
    rememberOwnedLaunchCleanup(entry);
    entry.cleanupControl?.();
    if (persistenceError) {
      entry.stopPromise = null;
      throw persistenceError;
    }
    rememberTerminalStop(entry);
    entry.finished = true;
    releaseEntry(entry);
    return entry.completionValue;
  };

  const stopEntry = async (entry, reason = "requested") => {
    if (entry.stopPromise) return entry.stopPromise;
    const stopDeadline = Date.now() + POSIX_STOP_TOTAL_MS;
    entry.stopPromise = (async () => {
      if (entry.finished) return stopResult(entry.context.ownedResourceId, entry.record.groupTerminated ? "stopped" : "unknown", Boolean(entry.record.groupTerminated), reason);
      if (entry.starting && entry.phase !== "started") {
        requestCancel(entry, reason);
        const startup = await waitForStartSettled(entry, stopDeadline);
        if (!startup) {
          // Keep the sticky cancellation and reservation in place.  A slow
          // startup must not be allowed to dispatch a target after this
          // bounded stop response; a later stop may retry its cleanup proof.
          entry.stopPromise = null;
          return stopResult(entry.context.ownedResourceId, "indeterminate", false, "owned process start did not settle within 10 seconds");
        }
        if (entry.phase !== "started") {
          if (startup.localOutcome === "stopped" && startup.confirmedOwnedScope === true) {
            return stopResult(entry.context.ownedResourceId, "stopped", true);
          }
          return stopResult(entry.context.ownedResourceId, "indeterminate", false, startup.message || "owned process start cleanup is indeterminate");
        }
      }
      const first = await groupProbe(entry);
      if (first.group === false) {
        await finish(entry, { phase: "terminal", localOutcome: "stopped", groupTerminated: true });
        return stopResult(entry.context.ownedResourceId, "stopped", true);
      }
      if (first.group !== true) {
        await finish(entry, { phase: "indeterminate", localOutcome: "indeterminate", groupTerminated: false });
        return stopResult(entry.context.ownedResourceId, "indeterminate", false, "owned process group identity is not proven");
      }
      if (first.leader !== true) {
        // The process-group probe is safe after leader loss, but it cannot
        // authorize a signal.  Give an already-exiting group the remainder of
        // this stop request's deadline to disappear on its own.
        const gone = await waitForGroupGone(entry, stopDeadline);
        if (gone === true) {
          await finish(entry, { phase: "terminal", localOutcome: "stopped", groupTerminated: true });
          return stopResult(entry.context.ownedResourceId, "stopped", true);
        }
        await finish(entry, { phase: "indeterminate", localOutcome: "indeterminate", groupTerminated: false });
        return stopResult(entry.context.ownedResourceId, "indeterminate", false, gone === null
          ? "owned process group identity became unknown after leader exit"
          : "owned process group did not become provably absent after leader exit");
      }
      if (Date.now() >= stopDeadline) {
        await finish(entry, { phase: "indeterminate", localOutcome: "indeterminate", groupTerminated: false });
        return stopResult(entry.context.ownedResourceId, "indeterminate", false, "owned process stop deadline expired before signaling");
      }
      try {
        throwIfUnsafeSignal(entry, first);
        process.kill(-entry.leaderPid, "SIGTERM");
      } catch (error) {
        await finish(entry, { phase: "indeterminate", localOutcome: "indeterminate", groupTerminated: false });
        return stopResult(entry.context.ownedResourceId, "indeterminate", false, error?.message || "SIGTERM was not sent");
      }
      const graceDeadline = Math.min(stopDeadline, Date.now() + POSIX_STOP_GRACE_MS);
      const afterGrace = await waitForGroupGone(entry, graceDeadline);
      if (afterGrace === true) {
        await finish(entry, { phase: "terminal", localOutcome: "stopped", groupTerminated: true });
        return stopResult(entry.context.ownedResourceId, "stopped", true);
      }
      if (afterGrace === null) {
        await finish(entry, { phase: "indeterminate", localOutcome: "indeterminate", groupTerminated: false });
        return stopResult(entry.context.ownedResourceId, "indeterminate", false, "owned process group identity became unknown");
      }
      const beforeKill = await groupProbe(entry);
      if (beforeKill.group !== true) {
        const gone = beforeKill.group === false;
        await finish(entry, { phase: gone ? "terminal" : "indeterminate", localOutcome: gone ? "stopped" : "indeterminate", groupTerminated: gone });
        return stopResult(entry.context.ownedResourceId, gone ? "stopped" : "indeterminate", gone, gone ? undefined : "owned process group identity became unknown");
      }
      if (beforeKill.leader !== true) {
        // A leader that vanished during the grace window is no longer a
        // signal authority.  Continue zero-signal observation only, bounded
        // by the original stop deadline.
        const goneAfterLeaderExit = await waitForGroupGone(entry, stopDeadline);
        if (goneAfterLeaderExit === true) {
          await finish(entry, { phase: "terminal", localOutcome: "stopped", groupTerminated: true });
          return stopResult(entry.context.ownedResourceId, "stopped", true);
        }
        await finish(entry, { phase: "indeterminate", localOutcome: "indeterminate", groupTerminated: false });
        return stopResult(entry.context.ownedResourceId, "indeterminate", false, goneAfterLeaderExit === null
          ? "owned process group identity became unknown after leader exit"
          : "owned process group did not become provably absent after leader exit");
      }
      if (Date.now() >= stopDeadline) {
        await finish(entry, { phase: "indeterminate", localOutcome: "indeterminate", groupTerminated: false });
        return stopResult(entry.context.ownedResourceId, "indeterminate", false, "owned process stop deadline expired before KILL");
      }
      try {
        throwIfUnsafeSignal(entry, beforeKill);
        process.kill(-entry.leaderPid, "SIGKILL");
      } catch (error) {
        await finish(entry, { phase: "indeterminate", localOutcome: "indeterminate", groupTerminated: false });
        return stopResult(entry.context.ownedResourceId, "indeterminate", false, error?.message || "SIGKILL was not sent");
      }
      const gone = await waitForGroupGone(entry, stopDeadline);
      if (gone === true) {
        await finish(entry, { phase: "terminal", localOutcome: "stopped", groupTerminated: true });
        return stopResult(entry.context.ownedResourceId, "stopped", true);
      }
      await finish(entry, { phase: "indeterminate", localOutcome: "indeterminate", groupTerminated: false });
      return stopResult(entry.context.ownedResourceId, "indeterminate", false, "owned process group did not become provably absent within 10 seconds");
    })().catch(async (error) => {
      if (entry.starting) {
        requestCancel(entry, reason);
        entry.stopPromise = null;
        return stopResult(entry.context.ownedResourceId, "indeterminate", false, error?.message || "owned process start stop failed");
      }
      await finish(entry, { phase: "indeterminate", localOutcome: "indeterminate", groupTerminated: false }).catch(() => {});
      return stopResult(entry.context.ownedResourceId, "indeterminate", false, error?.message || "owned stop failed");
    });
    return entry.stopPromise;
  };

  const waitForSupervisorExit = async (entry, timeoutMs = 1_000) => {
    if (entry.supervisorExited === true) return true;
    if (!entry.supervisorExitPromise) return false;
    let timer;
    try {
      await Promise.race([
        entry.supervisorExitPromise,
        new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return entry.supervisorExited === true;
  };

  const stopOwned = async ({ request, ownedResourceId, scope } = {}) => {
    assertNoProcessIdentityKeys({ request, ownedResourceId, scope }, "stopOwned request");
    const resourceId = request?.ownedResourceId || ownedResourceId;
    if (typeof resourceId !== "string") return stopResult("unknown", "unknown", false, "owned resource identity is missing");
    const runId = request?.runId || scope?.runId;
    const handleId = request?.handleId || scope?.handleId;
    if (typeof runId !== "string" || typeof handleId !== "string") return stopResult(resourceId, "unknown", false, "stop scope is missing");
    const context = { runId, handleId, ownedResourceId: resourceId };
    const live = activeByResource.get(resourceId);
    if (live && live.context.runId === runId && live.context.handleId === handleId) return stopEntry(live, request?.reason || "requested");
    try {
      const found = await findRecord(allocations, context, stateRootPath);
      if (!found) return stopResult(resourceId, "unknown", false, "owned allocation was not found");
      const receipt = terminalStopReceipts.get(found.record.allocationId);
      if (receipt && receipt.runId === context.runId && receipt.handleId === context.handleId &&
          receipt.ownedResourceId === resourceId && found.record.phase === "terminal" &&
          found.record.groupTerminated === true && digestObject(found.record) === receipt.recordDigest) {
        return stopResult(resourceId, "stopped", true);
      }
      // A restarted adapter has no live supervisor/incarnation proof.  It may
      // report metadata, but it must never promote a writable persisted flag.
      return stopResult(resourceId, "unknown", false, "live owner proof is unavailable after adapter restart");
    } catch (error) {
      return stopResult(resourceId, "unknown", false, error?.code === "EOWNED_PROCESS_STATE" ? "owned allocation state is unsafe" : "owned allocation state is unavailable");
    }
  };

  const resolveOwnedLaunch = async ({ request, transaction } = {}, { signal = undefined } = {}) => {
    if (!trustedController) throw fail("EOWNED_PROCESS_CLEANUP_UNKNOWN", "a trusted controller is required for launch transaction resolution");
    assertNoProcessIdentityKeys({ request, transaction }, "resolveOwnedLaunch request");
    exactKeys({ request, transaction }, ["request", "transaction"], "resolveOwnedLaunch request");
    exactKeys(request, OWNED_LAUNCH_RESOLUTION_REQUEST_KEYS, "resolveOwnedLaunch binding");
    validateLaunchTransaction(transaction);
    throwIfAborted(signal);
    for (const key of ["runId", "handleId", "intentId", "executionId", "attemptId", "unitId", "ownedResourceId", "revision"]) {
      assertText(request[key], `resolveOwnedLaunch.${key}`);
    }
    for (const key of ["sourceBindingDigest", "policyDigest", "fence", "transactionDigest"]) {
      assertDigest(request[key], `resolveOwnedLaunch.${key}`);
    }
    if (!Number.isSafeInteger(request.authorityEpoch) || request.authorityEpoch < 1) {
      throw fail("EOWNED_PROCESS_CLEANUP_UNKNOWN", "resolveOwnedLaunch authority epoch is invalid");
    }
    const bindingKeys = ["runId", "executionId", "attemptId", "unitId", "ownedResourceId", "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence"];
    for (const key of bindingKeys) {
      if (transaction[key] !== request[key]) {
        throw fail("EOWNED_PROCESS_CLEANUP_UNKNOWN", "launch cleanup evidence is not bound to the exact transaction");
      }
    }
    if (transaction.transactionId !== request.transactionId || transaction.digest !== request.transactionDigest) {
      throw fail("EOWNED_PROCESS_CLEANUP_UNKNOWN", "launch cleanup evidence has a different transaction identity");
    }
    const receipt = [...ownedLaunchCleanupReceipts.values()].find((item) =>
      item.transactionId === transaction.transactionId &&
      item.runId === request.runId && item.handleId === request.handleId && item.intentId === request.intentId &&
      item.executionId === request.executionId && item.attemptId === request.attemptId && item.unitId === request.unitId &&
      item.ownedResourceId === request.ownedResourceId
    ) ?? null;
    if (!receipt) {
      throw fail("EOWNED_PROCESS_CLEANUP_UNKNOWN", "the live owned adapter has no genuine cleanup receipt for this launch transaction");
    }
    const receiptBody = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "digest"));
    const { digest: currentTransactionDigest, ...currentTransactionBody } = transaction;
    const originalTransactionBody = { ...currentTransactionBody, status: "in-flight" };
    if (digestObject(originalTransactionBody) !== receipt.transactionDigest ||
        digestObject(receiptBody) !== receipt.digest || receipt.status !== "confirmed" || receipt.groupTerminated !== true ||
        receipt.launchRequested !== true || receipt.effectStarted !== true || receipt.noSendProof !== null ||
        receipt.lateLaunchBlocked !== true || receipt.launchCommitmentDigest !== null ||
        receipt.controllerId !== trustedController.controllerId) {
      throw fail("EOWNED_PROCESS_CLEANUP_UNKNOWN", "owned launch cleanup receipt is invalid or incomplete");
    }
    const recordFile = allocationPath(allocations, receipt.allocationId);
    const record = validateRecord(await readPrivateJson(recordFile));
    throwIfAborted(signal);
    if (record.allocationId !== receipt.allocationId || digestObject(record) !== receipt.allocationRecordDigest ||
        record.runId !== request.runId || record.handleId !== request.handleId || record.intentId !== request.intentId ||
        record.executionId !== request.executionId || record.attemptId !== request.attemptId || record.unitId !== request.unitId ||
        record.ownedResourceId !== request.ownedResourceId || record.sourceBindingDigest !== request.sourceBindingDigest ||
        record.policyDigest !== request.policyDigest || record.revision !== request.revision ||
        record.authorityEpoch !== request.authorityEpoch || record.fence !== request.fence ||
        record.controllerId !== trustedController.controllerId || record.launchRequested !== true ||
        record.effectStarted !== true || record.groupTerminated !== true || record.noSendProof !== null ||
        record.launchReservationDigest !== transaction.reservationDigest || record.launchAuthorizationDigest !== transaction.authorizationDigest ||
        record.launchCommitmentDigest !== null || record.phase !== "terminal") {
      throw fail("EOWNED_PROCESS_CLEANUP_UNKNOWN", "owned launch cleanup record is not bound to the exact controller transaction");
    }
    const live = activeByResource.get(request.ownedResourceId);
    if (live && !live.finished) {
      throw fail("EOWNED_PROCESS_CLEANUP_UNKNOWN", "owned launch cleanup still has a live adapter handle");
    }
    const probe = await recoveredGroupProbe(record, signal);
    if (probe.group !== false) {
      throw fail("EOWNED_PROCESS_CLEANUP_UNKNOWN", "owned launch process group absence is not proven");
    }
    // The controller re-digests the immutable transaction when it records the
    // status transition from in-flight to unknown.  Return a receipt bound to
    // that exact current transaction digest only after proving that the
    // private receipt was derived from the corresponding original transaction.
    const { digest: ignoredReceiptDigest, ...receiptWithoutDigest } = receipt;
    const currentReceiptBody = { ...receiptWithoutDigest, transactionDigest: currentTransactionDigest };
    return Object.freeze({ ...currentReceiptBody, digest: digestObject(currentReceiptBody) });
  };

  const queryOwned = async ({ request, scope } = {}, { signal = undefined } = {}) => {
    // This query is deliberately available only on an adapter created with a
    // module-branded trusted controller.  The generic runtime adapter still
    // supports its small unit-test callback contract, but that callback is
    // never the production authority for a POSIX allocation.
    if (!trustedController) throw fail("EOWNED_PROCESS_QUERY_UNAVAILABLE", "a trusted controller is required for owned process reconciliation");
    assertNoProcessIdentityKeys({ request, scope }, "queryOwned request");
    throwIfAborted(signal);
    if (!request || typeof request !== "object" || Array.isArray(request)) throw fail("EOWNED_PROCESS_QUERY", "owned process query request is missing");
    const expected = {
      runId: assertText(request.runId, "query.runId"),
      handleId: assertText(request.handleId, "query.handleId"),
      intentId: assertText(request.intentId, "query.intentId"),
      executionId: assertText(request.executionId, "query.executionId"),
      attemptId: assertText(request.attemptId, "query.attemptId"),
      unitId: assertText(request.unitId, "query.unitId"),
      sourceBindingDigest: assertText(request.sourceBindingDigest, "query.sourceBindingDigest"),
      policyDigest: assertText(request.policyDigest, "query.policyDigest"),
      revision: assertText(request.revision, "query.revision"),
      authorityEpoch: request.authorityEpoch,
      fence: assertText(request.fence, "query.fence"),
      ownedResourceId: assertText(request.ownedResourceId, "query.ownedResourceId")
    };
    if (!Number.isSafeInteger(expected.authorityEpoch) || expected.authorityEpoch < 1) throw fail("EOWNED_PROCESS_QUERY", "query.authorityEpoch is invalid");
    if (!/^[a-f0-9]{64}$/.test(expected.sourceBindingDigest) || !/^[a-f0-9]{64}$/.test(expected.policyDigest) ||
        !/^[a-f0-9]{64}$/.test(expected.fence)) throw fail("EOWNED_PROCESS_QUERY", "query binding digest is invalid");
    const binding = {
      runId: expected.runId,
      executionId: expected.executionId,
      attemptId: expected.attemptId,
      unitId: expected.unitId,
      sourceBindingDigest: expected.sourceBindingDigest,
      policyDigest: expected.policyDigest,
      revision: expected.revision,
      ownedResourceId: expected.ownedResourceId
    };

    // The controller response is obtained before reading the allocation.  It
    // is the TCB-attested proof that the request is still attached to the
    // exact approved source/policy/authority.  A matching JSON allocation
    // record without this response is never classified as completed or
    // not-sent.
    let controllerObservation;
    try {
      controllerObservation = await trustedController.readExecutionBinding({ runId: expected.runId, binding: cloneFrozen(binding) });
    } catch (error) {
      const wrapped = fail("EOWNED_PROCESS_AUTHORITY", "trusted controller could not attest the owned allocation");
      wrapped.cause = error;
      throw wrapped;
    }
    throwIfAborted(signal);
    const authority = controllerObservation?.authority;
    if (!authority || typeof authority !== "object" ||
        authority.runId !== expected.runId || authority.executionId !== expected.executionId ||
        authority.attemptId !== expected.attemptId || authority.unitId !== expected.unitId ||
        authority.ownedResourceId !== expected.ownedResourceId ||
        authority.sourceBindingDigest !== expected.sourceBindingDigest ||
        authority.policyDigest !== expected.policyDigest || authority.revision !== expected.revision ||
        authority.authorityEpoch !== expected.authorityEpoch || authority.fence !== expected.fence ||
        authority.status !== "active" || authority.revoked === true) {
      throw fail("EOWNED_PROCESS_AUTHORITY", "trusted controller authority is stale or not bound to the owned allocation");
    }
    const authorityDigest = digestObject(authority);
    // A controller-owned reservation survives a process crash.  Its
    // presence is stronger than the allocation JSON and blocks any
    // no-send classification until a separate, trusted reconciliation
    // protocol proves otherwise.
    const launchReservation = controllerObservation.launchReservation ?? null;
    const launchAuthorization = controllerObservation.launchAuthorization ?? null;
    const launchCommitment = controllerObservation.launchCommitment ?? null;
    const launchTransaction = controllerObservation.launchTransaction ?? null;
    const cleanupReceipt = launchTransaction === null ? null : [...ownedLaunchCleanupReceipts.values()].find((item) =>
      item.transactionId === launchTransaction.transactionId && item.transactionDigest === launchTransaction.digest &&
      item.runId === expected.runId && item.handleId === expected.handleId && item.intentId === expected.intentId &&
      item.executionId === expected.executionId && item.attemptId === expected.attemptId && item.unitId === expected.unitId &&
      item.ownedResourceId === expected.ownedResourceId
    ) ?? null;
    const found = await findRecord(allocations, {
      runId: expected.runId,
      handleId: expected.handleId,
      ownedResourceId: expected.ownedResourceId
    }, stateRootPath);
    throwIfAborted(signal);

    let runtimeHandle = null;
    let runtimeIntent = null;
    try {
      const runtimeState = await loadExecutionRegistry({
        stateRoot: stateRootPath,
        runId: expected.runId,
        controller: trustedController
      });
      runtimeHandle = runtimeState.handles?.[expected.handleId] ?? null;
      runtimeIntent = Object.values(runtimeState.intents ?? {}).find((item) =>
        item.handleId === expected.handleId && item.intentId === expected.intentId
      ) ?? null;
    } catch (error) {
      const wrapped = fail("EOWNED_PROCESS_AUTHORITY", "execution registry could not attest the owned allocation");
      wrapped.cause = error;
      throw wrapped;
    }
    const runtimeBindingMatched = runtimeHandle !== null && runtimeIntent !== null &&
      runtimeHandle.runId === expected.runId && runtimeHandle.executionId === expected.executionId &&
      runtimeHandle.attemptId === expected.attemptId && runtimeHandle.unitId === expected.unitId &&
      runtimeHandle.sourceBindingDigest === expected.sourceBindingDigest &&
      runtimeHandle.policyDigest === expected.policyDigest && runtimeHandle.revision === expected.revision &&
      runtimeHandle.authorityEpoch === expected.authorityEpoch && runtimeHandle.fence === expected.fence &&
      runtimeHandle.ownedResourceId === expected.ownedResourceId &&
      runtimeIntent.sourceBindingDigest === expected.sourceBindingDigest &&
      runtimeIntent.policyDigest === expected.policyDigest && runtimeIntent.revision === expected.revision &&
      runtimeIntent.authorityEpoch === expected.authorityEpoch && runtimeIntent.fence === expected.fence;

    let controllerStatus = "unknown";
    let providerOutcome = "unknown";
    let probe = { leader: null, group: null, startTime: null };
    let recordBindingMatched = false;
    if (found) {
      const record = found.record;
      recordBindingMatched = runtimeBindingMatched && record.executionId === expected.executionId &&
        record.attemptId === expected.attemptId && record.unitId === expected.unitId &&
        record.sourceBindingDigest === expected.sourceBindingDigest &&
        record.policyDigest === expected.policyDigest && record.revision === expected.revision &&
        record.authorityEpoch === expected.authorityEpoch && record.fence === expected.fence &&
        record.controllerId === trustedController.controllerId && record.authorityDigest === authorityDigest;
      if (recordBindingMatched && launchReservation !== null &&
          record.launchReservationDigest !== launchReservation.digest) {
        recordBindingMatched = false;
      }
      if (recordBindingMatched && launchAuthorization !== null &&
          record.launchAuthorizationDigest !== launchAuthorization.digest) {
        recordBindingMatched = false;
      }
      if (recordBindingMatched && launchAuthorization === null && record.launchAuthorizationDigest != null) {
        recordBindingMatched = false;
      }
      if (recordBindingMatched && launchCommitment !== null &&
          record.launchCommitmentDigest !== launchCommitment.digest) {
        recordBindingMatched = false;
      }
      if (recordBindingMatched && launchCommitment === null && record.launchCommitmentDigest != null) {
        recordBindingMatched = false;
      }
      if (recordBindingMatched && launchReservation === null && record.launchRequested === true) {
        recordBindingMatched = false;
      }
      // An in-flight or unresolved controller transaction is a hard HOLD.
      // Even a terminal-looking allocation record cannot promote it to a
      // completed or not-sent outcome until the trusted controller resolves
      // the owned launch boundary.
      if (recordBindingMatched && launchTransaction === null) {
        probe = await recoveredGroupProbe(record, signal);
        if (record.phase === "started" && runtimeIntent.status === "dispatching" && runtimeHandle.status === "dispatching" &&
            probe.leader === true && probe.group === true) {
          controllerStatus = "active";
          providerOutcome = "active";
        } else if (record.phase === "terminal" && runtimeIntent.status === "unknown" && runtimeHandle.status === "indeterminate" &&
            record.groupTerminated === true && probe.group === false) {
          controllerStatus = "terminated";
          if (record.effectStarted === true && record.localOutcome === "stopped" && record.exitCode === 0 && record.exitSignal === null) {
            providerOutcome = "completed";
          } else if (record.effectStarted === true && record.localOutcome === "stopped" &&
              (record.exitCode !== null || record.exitSignal !== null)) {
            providerOutcome = "failed";
          } else if (record.launchRequested === false && record.launchReservationDigest === null &&
              launchReservation === null && record.effectStarted === false && record.noSendProof != null &&
              runtimeIntent.dispatchReserved === false &&
              ((runtimeIntent.status === "not-sent" && runtimeIntent.callbackCalls === 0) ||
               (runtimeIntent.status === "unknown" && runtimeIntent.callbackCalls === 1))) {
            providerOutcome = "not-sent";
          }
        }
      }
    }

    const evidence = {
      schemaVersion: 1,
      kind: "PosixOwnedProcessObservationEvidenceV1",
      request: expected,
      controllerId: trustedController.controllerId,
      authorityDigest,
      allocationId: found?.record?.allocationId ?? null,
      recordBindingMatched,
      runtimeBindingMatched,
      runtimeIntentStatus: runtimeIntent?.status ?? null,
      recordPhase: found?.record?.phase ?? null,
      recordLaunchRequested: found?.record?.launchRequested ?? null,
      controllerLaunchReservation: launchReservation?.digest ?? null,
      controllerLaunchAuthorization: launchAuthorization?.digest ?? null,
      controllerLaunchCommitment: launchCommitment?.digest ?? null,
      controllerLaunchTransaction: launchTransaction?.digest ?? null,
      ownedLaunchCleanupReceipt: cleanupReceipt?.digest ?? null,
      recordEffectStarted: found?.record?.effectStarted ?? null,
      recordNoSendProof: found?.record?.noSendProof?.digest ?? null,
      probe,
      controllerStatus,
      providerOutcome
    };
    const observation = {
      schemaVersion: 1,
      kind: "ExecutionResourceObservationV1",
      observationId: randomUUID(),
      ...expected,
      controllerStatus,
      providerOutcome,
      businessOutcome: null,
      observedAt: isoAt(nowNumber(now)),
      evidenceDigest: digestObject(evidence)
    };
    return validateExecutionResourceObservationV1(observation, expected);
  };

  const queryRecoveryTaskEffectOwned = async ({ request, scope } = {}, { signal } = {}) => {
    if (!trustedController) throw fail("EOWNED_PROCESS_QUERY_UNAVAILABLE", "trusted recovery controller is required");
    const bindingKeys = ["runId", "executionId", "attemptId", "unitId", "sourceBindingDigest", "policyDigest", "revision", "ownedResourceId"];
    const identityKeys = [...bindingKeys, "handleId", "authorityEpoch", "fence"];
    const recoveryKeys = ["recoveryEffectIntentId", "recoveryEffectIntentDigest", "launchId", "launchDigest", "outcomeId", "outcomeDigest"];
    const transactionKeys = ["controllerTransactionId", "controllerTransactionDigest"];
    exactKeys(request, [...identityKeys, ...recoveryKeys, ...transactionKeys], "recovery query request");
    exactKeys(scope, ["runId", "handleId", "ownedResourceId", "recoveryEffectIntentId", "launchId", "outcomeId"], "recovery query scope");
    for (const value of [request, scope]) {
      if (Reflect.ownKeys(value).length !== Object.keys(value).length ||
          Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !Object.hasOwn(descriptor, "value"))) {
        throw fail("EOWNED_PROCESS_QUERY", "recovery query must contain only own data fields");
      }
    }
    const expected = cloneFrozen(request);
    for (const key of Object.keys(scope)) {
      if (scope[key] !== expected[key]) throw fail("EOWNED_PROCESS_QUERY", "recovery query scope differs from its binding");
    }
    for (const key of [...identityKeys, ...recoveryKeys].filter((key) => key !== "authorityEpoch")) assertText(expected[key], `recovery query.${key}`);
    if (!Number.isSafeInteger(expected.authorityEpoch) || expected.authorityEpoch < 1 ||
        ["sourceBindingDigest", "policyDigest", "fence", "recoveryEffectIntentDigest", "launchDigest", "outcomeDigest"].some((key) => !/^[a-f0-9]{64}$/.test(expected[key])) ||
        ((expected.controllerTransactionId === null) !== (expected.controllerTransactionDigest === null))) {
      throw fail("EOWNED_PROCESS_QUERY", "recovery query binding is invalid");
    }
    if (expected.controllerTransactionId !== null) {
      assertText(expected.controllerTransactionId, "recovery query.controllerTransactionId");
      if (!/^[a-f0-9]{64}$/.test(expected.controllerTransactionDigest)) throw fail("EOWNED_PROCESS_QUERY", "recovery transaction digest is invalid");
    }
    throwIfAborted(signal);
    const readOptions = { stateRoot: stateRootPath, runId: expected.runId, controller: trustedController };
    const intentRead = await readExecutionRecoveryTaskEffectIntentV1({ ...readOptions, intentId: expected.recoveryEffectIntentId });
    const launchRead = await readExecutionRecoveryTaskEffectLaunchV1({ ...readOptions, launchId: expected.launchId });
    const outcomeRead = await readExecutionRecoveryTaskEffectOutcomeV1({ ...readOptions, outcomeId: expected.outcomeId });
    const state = await loadExecutionRegistry(readOptions);
    const { intent } = intentRead;
    const { launch } = launchRead;
    const { outcome } = outcomeRead;
    const handle = state.handles[expected.handleId];
    if ([intentRead, launchRead, outcomeRead].some((value) => value.registryHead.sequence !== state.sequence || value.registryHead.stateDigest !== state.stateDigest) ||
        !handle || handle.status !== "ready" || handle.dispatchBlocked !== true ||
        identityKeys.some((key) => handle[key] !== expected[key]) ||
        intent.status !== "dispatch-reserved" || intent.intentDigest !== expected.recoveryEffectIntentDigest ||
        intent.handleId !== expected.handleId ||
        launch.launchDigest !== expected.launchDigest || launch.intentId !== intent.intentId || launch.intentDigest !== intent.intentDigest ||
        outcome.outcomeDigest !== expected.outcomeDigest || outcome.outcome !== "unknown" ||
        outcome.launchId !== launch.launchId || outcome.launchDigest !== launch.launchDigest ||
        transactionKeys.some((key) => outcome[key] !== expected[key]) ||
        launch.controllerId !== trustedController.controllerId) {
      throw fail("EOWNED_PROCESS_AUTHORITY", "recovery query does not match one canonical UNKNOWN chain");
    }
    const binding = Object.fromEntries(bindingKeys.map((key) => [key, expected[key]]));
    const controllerObservation = await trustedController.readExecutionBinding({ runId: expected.runId, binding: cloneFrozen(binding) });
    throwIfAborted(signal);
    const authority = controllerObservation?.authority;
    if (!authority || [...bindingKeys, "authorityEpoch", "fence"].some((key) => authority[key] !== expected[key]) || authority.status !== "active" || authority.revoked === true) {
      throw fail("EOWNED_PROCESS_AUTHORITY", "recovery query authority is stale");
    }
    const authorityDigest = digestObject(authority);
    const found = await findRecord(allocations, { runId: expected.runId, handleId: expected.handleId, ownedResourceId: expected.ownedResourceId }, stateRootPath, true);
    const record = found?.record ?? null;
    const terminalReceipt = record === null ? null : terminalStopReceipts.get(record.allocationId) ?? null;
    const live = record === null ? null : active.get(record.allocationId) ?? null;
    const transaction = live?.launchTransaction ?? terminalReceipt?.transaction ?? null;
    const reservation = controllerObservation.launchReservation ?? null;
    const authorization = controllerObservation.launchAuthorization ?? null;
    const commitment = controllerObservation.launchCommitment ?? null;
    let controllerStatus = "unknown";
    let providerOutcome = "unknown";
    let probe = { leader: null, group: null, startTime: null };
    const recordMatched = record !== null && [...identityKeys].every((key) => record[key] === expected[key]) &&
      record.intentId === expected.recoveryEffectIntentId && record.controllerId === trustedController.controllerId && record.authorityDigest === authorityDigest &&
      record.launchReservationDigest === (reservation?.digest ?? null) &&
      record.launchAuthorizationDigest === (authorization?.digest ?? null) &&
      record.launchCommitmentDigest === (commitment?.digest ?? null);
    const transactionMatched = expected.controllerTransactionId === null ||
      (transaction?.transactionId === expected.controllerTransactionId && transaction?.digest === expected.controllerTransactionDigest);
    // Null in the original UNKNOWN means unobserved, not no-launch. A
    // private transaction may supply the missing evidence, but only when
    // every execution and controller launch binding still matches.
    const actualTransactionMatched = transaction !== null &&
      [...bindingKeys, "authorityEpoch", "fence"].every((key) => transaction[key] === expected[key]) &&
      transaction.effectBindingDigest === launch.effectBindingDigest &&
      transaction.reservationId === reservation?.reservationId && transaction.reservationDigest === reservation?.digest &&
      transaction.authorizationId === authorization?.authorizationId && transaction.authorizationDigest === authorization?.digest &&
      transaction.commitmentId === commitment?.commitmentId;
    // A persisted PID or terminal-looking JSON is never enough to resolve a
    // recovery effect. Require this adapter's private lifecycle evidence as
    // well as current controller authority and independent group absence.
    if (recordMatched && transactionMatched && controllerObservation.launchTransaction == null) {
      probe = live ? await groupProbe(live) : await recoveredGroupProbe(record, signal);
      if (record.phase === "started" && live && probe.leader === true && probe.group === true) {
        controllerStatus = "active";
        providerOutcome = "active";
      } else if (record.phase === "terminal" && terminalReceipt?.recordDigest === digestObject(record) && record.groupTerminated === true && probe.group === false) {
        controllerStatus = "terminated";
        if (record.effectStarted === true && record.localOutcome === "stopped" && actualTransactionMatched &&
            record.exitCode === 0 && record.exitSignal === null) providerOutcome = "completed";
        else if (record.effectStarted === true && record.localOutcome === "stopped" && actualTransactionMatched &&
            (record.exitCode !== null || record.exitSignal !== null)) providerOutcome = "failed";
        else if (record.launchRequested === false && record.effectStarted === false && record.noSendProof !== null &&
            record.noSendProof.ownerTokenDigest === record.ownerTokenDigest && reservation === null && authorization === null && commitment === null &&
            expected.controllerTransactionId === null) providerOutcome = "not-sent";
      }
    }
    throwIfAborted(signal);
    const finalController = await trustedController.readExecutionBinding({ runId: expected.runId, binding: cloneFrozen(binding) });
    throwIfAborted(signal);
    if (digestObject(finalController.authority) !== authorityDigest ||
        ["launchReservation", "launchAuthorization", "launchCommitment", "launchTransaction"].some((key) =>
          (finalController[key]?.digest ?? null) !== (controllerObservation[key]?.digest ?? null))) {
      throw fail("EOWNED_PROCESS_AUTHORITY", "recovery controller changed during resource observation");
    }
    const evidence = { expected, registryHead: outcomeRead.registryHead, authorityDigest, recordDigest: record === null ? null : digestObject(record),
      terminalReceipt, transaction, recordMatched, transactionMatched, probe, controllerStatus, providerOutcome };
    return cloneFrozen({
      schemaVersion: 1, kind: "ExecutionRecoveryTaskEffectResourceObservationV1", observationId: randomUUID(),
      ...Object.fromEntries([...identityKeys, ...recoveryKeys, ...transactionKeys].map((key) => [key, expected[key]])),
      controllerStatus, providerOutcome, businessOutcome: null, observedAt: isoAt(nowNumber(now)), evidenceDigest: digestObject(evidence)
    });
  };

  const startOwned = async (first, second) => {
    const options = commandOptions(first, second);
    const existing = activeByResource.get(options.context.ownedResourceId);
    if (existing && !existing.finished) throw fail("EOWNED_PROCESS_DUPLICATE", "owned resource is already reserved");
    if (existing) activeByResource.delete(options.context.ownedResourceId);
    const allocationId = randomUUID();
    const recordPath = allocationPath(allocations, allocationId);
    const ownerToken = randomToken();
    const createdAt = isoAt(nowNumber(now));
    const record = {
      schemaVersion: 1,
      kind: POSIX_OWNED_PROCESS_ALLOCATION_KIND,
      allocationId,
      runId: options.context.runId,
      handleId: options.context.handleId,
      intentId: options.context.intentId,
      ownedResourceId: options.context.ownedResourceId,
      executionId: options.executionContext.binding?.executionId ?? null,
      attemptId: options.executionContext.binding?.attemptId ?? null,
      unitId: options.executionContext.binding?.unitId ?? null,
      sourceBindingDigest: options.executionContext.binding?.sourceBindingDigest ?? null,
      policyDigest: options.executionContext.binding?.policyDigest ?? null,
      revision: options.executionContext.binding?.revision ?? null,
      controllerId: trustedController?.controllerId ?? null,
      authorityEpoch: Number.isSafeInteger(options.executionContext.authorityEpoch) && options.executionContext.authorityEpoch >= 1
        ? options.executionContext.authorityEpoch
        : null,
      fence: typeof options.executionContext.fence === "string" && /^[a-f0-9]{64}$/.test(options.executionContext.fence)
        ? options.executionContext.fence
        : null,
      authorityDigest: null,
      ownerTokenDigest: tokenDigest(ownerToken),
      phase: "prepared",
      leaderPid: null,
      processGroupId: null,
      leaderStartTime: null,
      createdAt,
      startedAt: null,
      endedAt: null,
      localOutcome: null,
      groupTerminated: false,
      launchRequested: false,
      launchReservationDigest: null,
      launchAuthorizationDigest: null,
      launchCommitmentDigest: null,
      effectStarted: false,
      noSendProof: null,
      exitCode: null,
      exitSignal: null
    };
    const entry = {
      allocationId,
      recordPath,
      record,
      context: options.context,
      supervisor: null,
      leaderPid: null,
      startTime: null,
      startedAt: null,
      phase: "prepared",
      finished: false,
      starting: true,
      startSettled: false,
      startResult: null,
      startSettledPromise: null,
      resolveStart: null,
      cancelRequested: false,
      cancelReason: null,
      launchRequested: false,
      launchReservationDigest: null,
      launchAuthorizationDigest: null,
      launchCommitmentDigest: null,
      launchTransactionId: null,
      launchTransactionDigest: null,
      launchTransaction: null,
      launchFrameClosed: false,
      supervisorExited: false,
      cancelPromise: null,
      resolveCancel: null,
      supervisorExitPromise: null,
      resolveSupervisorExit: null,
      recordPersisted: false,
      stopPromise: null,
      stdout: [],
      stderr: [],
      outputBytes: 0,
      outputExceeded: false,
      controlBuffer: "",
      targetExit: null,
      completionValue: null,
      completionSettled: false,
      resolveCompletion: null,
      cleanupControl: null
    };
    entry.completion = new Promise((resolve) => { entry.resolveCompletion = resolve; });
    entry.completion.catch(() => {});
    entry.startSettledPromise = new Promise((resolve) => { entry.resolveStart = resolve; });
    entry.cancelPromise = new Promise((resolve) => { entry.resolveCancel = resolve; });
    active.set(allocationId, entry);
    activeByResource.set(options.context.ownedResourceId, entry);

    const runStart = async () => {
      let supervisor;
      try {
        assertStartLive(entry);
        await ensurePrivateDirectory(allocations, stateRootPath);
        assertStartLive(entry);
        await writePrivateJson(recordPath, record, { createOnly: true, boundary: stateRootPath });
        entry.recordPersisted = true;
        assertStartLive(entry);
        if (trustedController) {
          // Bind the persistent allocation to the controller's attested
          // authority before a supervisor exists.  The later query path must
          // reproduce this exact authority/binding pair; an allocation JSON
          // file on its own is never enough to establish provider evidence.
          const binding = options.executionContext.binding;
          const observed = await trustedController.readExecutionBinding({
            runId: binding.runId,
            binding: cloneFrozen(binding)
          });
          if (!observed || typeof observed !== "object" || !observed.authority ||
              observed.authority.runId !== binding.runId ||
              observed.authority.executionId !== binding.executionId ||
              observed.authority.attemptId !== binding.attemptId ||
              observed.authority.unitId !== binding.unitId ||
              observed.authority.ownedResourceId !== binding.ownedResourceId ||
              observed.authority.authorityEpoch !== options.executionContext.authorityEpoch ||
              observed.authority.fence !== options.executionContext.fence) {
            throw fail("EOWNED_PROCESS_AUTHORITY", "controller authority is not bound to the owned allocation");
          }
          await persist(entry, { authorityDigest: digestObject(observed.authority) });
        }
      supervisor = spawnImpl(process.execPath, ["-e", SUPERVISOR_SOURCE], {
        cwd: "/",
        env: { PATH: process.env.PATH || "/usr/bin:/bin" },
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"]
      });
      entry.supervisor = supervisor;
      entry.supervisorExitPromise = new Promise((resolve) => { entry.resolveSupervisorExit = resolve; });
      entry.supervisorExitPromise.catch(() => {});
      if (!supervisor || !Number.isSafeInteger(supervisor.pid) || supervisor.pid < 1) throw fail("EOWNED_PROCESS_START", "supervisor did not provide a live leader");
      // The ChildProcess object is the local proof that this PID was created
      // by this adapter.  The ready message below is still required before
      // the allocation is considered started.
      entry.leaderPid = supervisor.pid;
      // Persist the supervisor identity before sending configuration.  If the
      // adapter dies during startup, a recovery process can still inspect the
      // exact owned group and distinguish a proven cleanup from an unknown
      // one; a prepared record with no leader identity cannot support that
      // decision safely.
      await persist(entry, {
        leaderPid: supervisor.pid,
        processGroupId: supervisor.pid
      });
      const onOutput = (which, chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const remaining = options.maxOutputBytes - entry.outputBytes;
        if (bytes.length === 0) return;
        if (remaining <= 0) {
          if (!entry.outputExceeded) {
            entry.outputExceeded = true;
            if (entry.phase === "started") void stopEntry(entry, "output limit exceeded").catch(() => {});
          }
          return;
        }
        const kept = bytes.subarray(0, remaining);
        if (kept.length) entry[which].push(Buffer.from(kept));
        entry.outputBytes += kept.length;
        if (kept.length < bytes.length && !entry.outputExceeded) {
          entry.outputExceeded = true;
          if (entry.phase === "started") void stopEntry(entry, "output limit exceeded").catch(() => {});
        }
      };
      let resolveConfigured;
      let rejectConfigured;
      let resolveLaunchRequest;
      let rejectLaunchRequest;
      let resolveLaunchCommitRequest;
      let rejectLaunchCommitRequest;
      let resolveReady;
      let rejectReady;
      let configuredSeen = false;
      let launchRequestSeen = false;
      let launchCommitRequestSeen = false;
      let readySeen = false;
      let controlCleaned = false;
      const configuredPromise = new Promise((resolve, reject) => { resolveConfigured = resolve; rejectConfigured = reject; });
      const launchRequestPromise = new Promise((resolve, reject) => { resolveLaunchRequest = resolve; rejectLaunchRequest = reject; });
      const launchCommitRequestPromise = new Promise((resolve, reject) => { resolveLaunchCommitRequest = resolve; rejectLaunchCommitRequest = reject; });
      const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      configuredPromise.catch(() => {});
      launchRequestPromise.catch(() => {});
      launchCommitRequestPromise.catch(() => {});
      readyPromise.catch(() => {});
      const rejectPending = (error) => {
        if (!configuredSeen) rejectConfigured(error);
        if (!launchRequestSeen) rejectLaunchRequest(error);
        if (!launchCommitRequestSeen) rejectLaunchCommitRequest(error);
        if (!readySeen) rejectReady(error);
      };
      const processControlMessage = (message) => {
        if (message?.type === "configured") {
          if (!configuredSeen) { configuredSeen = true; resolveConfigured(message); }
          return;
        }
        if (message?.type === "launch-request") {
          if (!launchRequestSeen) { launchRequestSeen = true; resolveLaunchRequest(message); }
          return;
        }
        if (message?.type === "launch-commit-request") {
          if (!launchCommitRequestSeen) { launchCommitRequestSeen = true; resolveLaunchCommitRequest(message); }
          return;
        }
        if (message?.type === "ready") {
          if (!readySeen) {
            readySeen = true;
            entry.readySeen = true;
            resolveReady(message);
          }
          return;
        }
        if (message?.type === "cancelled") {
          rejectPending(startCancelled(entry.cancelReason));
          return;
        }
        if (message?.type === "error") {
          rejectPending(fail("EOWNED_PROCESS_START", "supervisor could not start target"));
          return;
        }
        if (message?.type === "exit") {
          entry.targetExit = { code: message.code, signal: message.signal };
          if (entry.phase === "started") void stopEntry(entry, "target exited").catch(() => {});
        }
      };
      const consumeControlBuffer = () => {
        let index;
        while ((index = entry.controlBuffer.indexOf("\n")) >= 0) {
          const line = entry.controlBuffer.slice(0, index);
          entry.controlBuffer = entry.controlBuffer.slice(index + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch {
            if (!readySeen) rejectPending(fail("EOWNED_PROCESS_START", "supervisor protocol is invalid"));
            continue;
          }
          processControlMessage(message);
        }
      };
      const onData = (chunk) => {
        entry.controlBuffer += Buffer.from(chunk).toString("utf8");
        consumeControlBuffer();
      };
      const onError = (error) => {
        rejectPending(entry.cancelRequested ? startCancelled(entry.cancelReason) : fail("EOWNED_PROCESS_START", error?.code || "supervisor error"));
      };
      const onSupervisorExit = () => {
        entry.supervisorExited = true;
        entry.resolveSupervisorExit?.();
        if (!readySeen) rejectPending(entry.cancelRequested ? startCancelled(entry.cancelReason) : fail("EOWNED_PROCESS_START", "supervisor exited before readiness"));
        else if (entry.phase === "started") {
          void groupProbe(entry).then((probe) => {
            if (probe.group === false) void stopEntry(entry, "supervisor exited").catch(() => {});
          }).catch(() => {});
        }
      };
      const stdoutData = (chunk) => onOutput("stdout", chunk);
      const stderrData = (chunk) => onOutput("stderr", chunk);
      const cleanupControl = () => {
        if (controlCleaned) return;
        controlCleaned = true;
        supervisor.stdio?.[3]?.off?.("data", onData);
        supervisor.stdout?.off?.("data", stdoutData);
        supervisor.stderr?.off?.("data", stderrData);
        supervisor.off?.("error", onError);
        supervisor.off?.("exit", onSupervisorExit);
      };
      entry.cleanupControl = cleanupControl;
      // Install every listener before writing either handshake message.  A
      // fast supervisor may coalesce configured, ready, and exit frames.
      supervisor.stdout?.on("data", stdoutData);
      supervisor.stderr?.on("data", stderrData);
      supervisor.stdio?.[3]?.on("data", onData);
      supervisor.once?.("error", onError);
      supervisor.once?.("exit", onSupervisorExit);
      assertStartLive(entry);
      if (typeof supervisor.stdin?.write !== "function") throw fail("EOWNED_PROCESS_START", "supervisor input is unavailable");
      supervisor.stdin.write(`${JSON.stringify({ type: "configure", command: options.command, args: options.args, cwd: options.cwd, env: options.env })}\n`);
      const waitStartupMessage = async (promise, label) => {
        let timer;
        try {
          return await Promise.race([
            promise,
            entry.cancelPromise.then(() => { throw startCancelled(entry.cancelReason); }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(fail("EOWNED_PROCESS_START", `${label} timed out`)), 2_000); })
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      await waitStartupMessage(configuredPromise, "supervisor configuration");
      assertStartLive(entry);
      if (beforeLaunch) {
        let timer;
        try {
          await Promise.race([
            Promise.resolve().then(() => beforeLaunch(options.executionContext)),
            entry.cancelPromise.then(() => { throw startCancelled(entry.cancelReason); }),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(fail("EOWNED_PROCESS_START", "beforeLaunch timed out")), beforeLaunchTimeout);
            })
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        assertStartLive(entry);
      }
      let launchReservation = null;
      let launchAuthorization = null;
      let launchCommitment = null;
      if (trustedController) {
        if (typeof trustedController.commitEffectLaunch !== "function") {
          throw fail("EOWNED_PROCESS_AUTHORITY", "trusted controller cannot commit the launch reservation boundary");
        }
        if (options.effectBindingDigest === null) {
          throw fail("EOWNED_PROCESS_AUTHORITY", "effect binding digest is required for a trusted owned launch");
        }
        launchReservation = await trustedController.commitEffectLaunch({
          ...options.executionContext.binding,
          authorityEpoch: options.executionContext.authorityEpoch,
          fence: options.executionContext.fence,
          effectBindingDigest: options.effectBindingDigest
        });
        if (!launchReservation || launchReservation.kind !== "CooperativeNativeV3EffectLaunchReservationV1" ||
            launchReservation.runId !== options.executionContext.binding.runId ||
            launchReservation.executionId !== options.executionContext.binding.executionId ||
            launchReservation.attemptId !== options.executionContext.binding.attemptId ||
            launchReservation.unitId !== options.executionContext.binding.unitId ||
            launchReservation.ownedResourceId !== options.executionContext.binding.ownedResourceId ||
            launchReservation.authorityEpoch !== options.executionContext.authorityEpoch ||
            launchReservation.fence !== options.executionContext.fence ||
            launchReservation.effectBindingDigest !== options.effectBindingDigest ||
            typeof launchReservation.digest !== "string" || !/^[a-f0-9]{64}$/.test(launchReservation.digest)) {
          throw fail("EOWNED_PROCESS_AUTHORITY", "trusted controller returned an invalid launch reservation");
        }
      }
      // Mark the irreversible boundary before sending the launch frame. If
      // this process crashes between the durable reservation and the frame,
      // recovery sees a reservation and keeps the outcome UNKNOWN rather than
      // minting a retryable no-send proof.
      entry.launchRequested = true;
      entry.launchReservationDigest = launchReservation?.digest ?? null;
      await persist(entry, {
        launchRequested: true,
        launchReservationDigest: entry.launchReservationDigest,
        launchAuthorizationDigest: null,
        effectStarted: true,
        noSendProof: null
      });
      assertStartLive(entry);
      if (trustedController) {
        const reservationFrame = {
          type: "launch",
          reservationId: launchReservation.reservationId,
          reservationDigest: launchReservation.digest,
          authorityEpoch: launchReservation.authorityEpoch,
          fence: launchReservation.fence,
          effectBindingDigest: launchReservation.effectBindingDigest
        };
        supervisor.stdin.write(`${JSON.stringify(reservationFrame)}\n`);
        const launchRequest = await waitStartupMessage(launchRequestPromise, "supervisor launch request");
        if (!launchRequest || launchRequest.type !== "launch-request" ||
            launchRequest.reservationId !== launchReservation.reservationId ||
            launchRequest.reservationDigest !== launchReservation.digest ||
            launchRequest.authorityEpoch !== launchReservation.authorityEpoch ||
            launchRequest.fence !== launchReservation.fence ||
            launchRequest.effectBindingDigest !== launchReservation.effectBindingDigest) {
          throw fail("EOWNED_PROCESS_AUTHORITY", "supervisor launch request is not bound to the trusted reservation");
        }
        if (typeof trustedController.authorizeEffectLaunch !== "function") {
          throw fail("EOWNED_PROCESS_AUTHORITY", "trusted controller cannot authorize the supervisor launch boundary");
        }
        launchAuthorization = await trustedController.authorizeEffectLaunch({
          ...options.executionContext.binding,
          authorityEpoch: launchReservation.authorityEpoch,
          fence: launchReservation.fence,
          effectBindingDigest: launchReservation.effectBindingDigest,
          reservationId: launchReservation.reservationId,
          reservationDigest: launchReservation.digest
        });
        if (!launchAuthorization || launchAuthorization.kind !== NATIVE_V3_EFFECT_LAUNCH_AUTHORIZATION_KIND ||
            launchAuthorization.reservationId !== launchReservation.reservationId ||
            launchAuthorization.reservationDigest !== launchReservation.digest ||
            launchAuthorization.runId !== options.executionContext.binding.runId ||
            launchAuthorization.executionId !== options.executionContext.binding.executionId ||
            launchAuthorization.attemptId !== options.executionContext.binding.attemptId ||
            launchAuthorization.unitId !== options.executionContext.binding.unitId ||
            launchAuthorization.ownedResourceId !== options.executionContext.binding.ownedResourceId ||
            launchAuthorization.authorityEpoch !== launchReservation.authorityEpoch ||
            launchAuthorization.fence !== launchReservation.fence ||
            launchAuthorization.effectBindingDigest !== launchReservation.effectBindingDigest ||
            typeof launchAuthorization.authorizationId !== "string" || launchAuthorization.authorizationId.length === 0 ||
            typeof launchAuthorization.digest !== "string" || !/^[a-f0-9]{64}$/.test(launchAuthorization.digest)) {
          throw fail("EOWNED_PROCESS_AUTHORITY", "trusted controller returned an invalid launch authorization");
        }
        await persist(entry, {
          launchAuthorizationDigest: launchAuthorization.digest,
          launchRequested: true,
          effectStarted: true,
          noSendProof: null
        });
        assertStartLive(entry);
        supervisor.stdin.write(`${JSON.stringify({
          type: "launch-authorized",
          authorizationId: launchAuthorization.authorizationId,
          reservationId: launchAuthorization.reservationId,
          reservationDigest: launchAuthorization.reservationDigest,
          authorityEpoch: launchAuthorization.authorityEpoch,
          fence: launchAuthorization.fence,
          effectBindingDigest: launchAuthorization.effectBindingDigest,
          authorizationDigest: launchAuthorization.digest
        })}\n`);
        const launchCommitRequest = await waitStartupMessage(launchCommitRequestPromise, "supervisor launch commitment request");
        if (!launchCommitRequest || launchCommitRequest.type !== "launch-commit-request" ||
            launchCommitRequest.authorizationId !== launchAuthorization.authorizationId ||
            launchCommitRequest.authorizationDigest !== launchAuthorization.digest ||
            launchCommitRequest.reservationId !== launchReservation.reservationId ||
            launchCommitRequest.reservationDigest !== launchReservation.digest ||
            launchCommitRequest.authorityEpoch !== launchAuthorization.authorityEpoch ||
            launchCommitRequest.fence !== launchAuthorization.fence ||
            launchCommitRequest.effectBindingDigest !== launchAuthorization.effectBindingDigest) {
          throw fail("EOWNED_PROCESS_AUTHORITY", "supervisor launch commitment request is not bound to the trusted authorization");
        }
        if (typeof trustedController.commitAuthorizedEffectLaunch !== "function") {
          throw fail("EOWNED_PROCESS_AUTHORITY", "trusted controller cannot commit the owned effect launch boundary");
        }
        const launchEffect = async (launchContext, { signal, transaction = null } = {}) => {
          const verifyRecovery = POSIX_RECOVERY_LAUNCH_VERIFIERS.get(resourceAdapter);
          if (signal?.aborted) throw fail("EOWNED_PROCESS_AUTHORITY", "owned effect launch transaction was aborted before spawn");
          assertStartLive(entry);
          if (transaction !== null) {
            validateLaunchTransaction(transaction);
            entry.launchTransactionId = transaction.transactionId;
            entry.launchTransactionDigest = transaction.digest;
            entry.launchTransaction = cloneFrozen(transaction);
          }
          let acknowledged = false;
          try {
            let frameSent = false;
            let frameCapabilityLive = true;
            const sendLaunchFrame = () => {
              if (!frameCapabilityLive || frameSent) throw fail("EOWNED_PROCESS_AUTHORITY", "owned launch frame capability is spent");
              if (signal?.aborted) throw fail("EOWNED_PROCESS_AUTHORITY", "owned launch was aborted at frame boundary");
              assertStartLive(entry);
              frameSent = true;
              supervisor.stdin.write(`${JSON.stringify({
              type: "launch-go",
              commitmentId: launchContext.commitmentId,
              authorizationId: launchContext.authorizationId,
              authorizationDigest: launchContext.authorizationDigest,
              reservationId: launchContext.reservationId,
              reservationDigest: launchContext.reservationDigest,
              authorityEpoch: launchContext.authorityEpoch,
              fence: launchContext.fence,
              effectBindingDigest: launchContext.effectBindingDigest
            })}\n`);
            };
            try {
              if (verifyRecovery) await verifyRecovery(sendLaunchFrame);
              else sendLaunchFrame();
            } finally { frameCapabilityLive = false; }
            if (!frameSent) throw fail("EOWNED_PROCESS_AUTHORITY", "owned launch verifier did not send its exact frame");
            const ready = await waitStartupMessage(readyPromise, "supervisor launch acknowledgement");
            if (!ready || ready.reservationId !== launchContext.reservationId ||
                ready.reservationDigest !== launchContext.reservationDigest ||
                ready.authorizationId !== launchContext.authorizationId ||
                ready.authorizationDigest !== launchContext.authorizationDigest ||
                ready.commitmentId !== launchContext.commitmentId ||
                ready.authorityEpoch !== launchContext.authorityEpoch ||
                ready.fence !== launchContext.fence ||
                ready.effectBindingDigest !== launchContext.effectBindingDigest ||
                !Number.isSafeInteger(ready.leaderPid) || ready.leaderPid < 1 ||
                !Number.isSafeInteger(ready.targetPid) || ready.targetPid < 1) {
              throw fail("EOWNED_PROCESS_AUTHORITY", "supervisor launch acknowledgement is not bound to the owned transaction");
            }
            acknowledged = true;
            return {
              schemaVersion: 1,
              kind: "PosixOwnedProcessLaunchAcknowledgementV1",
              status: "spawned",
              ...launchContext,
              supervisorPid: ready.leaderPid,
              targetPid: ready.targetPid,
              observedAt: isoAt(nowNumber(now))
            };
          } finally {
            if (!acknowledged) {
              try {
                supervisor.stdin.write("{\"type\":\"launch-commit-rejected\"}\n");
                entry.launchFrameClosed = true;
              } catch { /* cleanup below remains authoritative */ }
            }
          }
        };
        try {
          launchCommitment = await trustedController.commitAuthorizedEffectLaunch({
            ...options.executionContext.binding,
            authorityEpoch: launchAuthorization.authorityEpoch,
            fence: launchAuthorization.fence,
            effectBindingDigest: launchAuthorization.effectBindingDigest,
            reservationId: launchReservation.reservationId,
            reservationDigest: launchReservation.digest,
            authorizationId: launchAuthorization.authorizationId,
            authorizationDigest: launchAuthorization.digest
          }, launchEffect);
        } catch (error) {
          // Tell the owned supervisor to close any pending launch state.  A
          // target may already have spawned before the controller persisted
          // its commitment; the owned-group cleanup below remains
          // authoritative and records UNKNOWN when identity is uncertain.
          try {
            supervisor.stdin.write("{\"type\":\"launch-commit-rejected\"}\n");
            entry.launchFrameClosed = true;
          } catch { /* cleanup below remains authoritative */ }
          throw error;
        }
        if (!launchCommitment || launchCommitment.kind !== NATIVE_V3_EFFECT_LAUNCH_COMMITMENT_KIND ||
            typeof launchCommitment.commitmentId !== "string" || launchCommitment.commitmentId.length === 0 ||
            launchCommitment.authorizationId !== launchAuthorization.authorizationId ||
            launchCommitment.authorizationDigest !== launchAuthorization.digest ||
            launchCommitment.reservationId !== launchReservation.reservationId ||
            launchCommitment.reservationDigest !== launchReservation.digest ||
            launchCommitment.runId !== options.executionContext.binding.runId ||
            launchCommitment.executionId !== options.executionContext.binding.executionId ||
            launchCommitment.attemptId !== options.executionContext.binding.attemptId ||
            launchCommitment.unitId !== options.executionContext.binding.unitId ||
            launchCommitment.ownedResourceId !== options.executionContext.binding.ownedResourceId ||
            launchCommitment.authorityEpoch !== launchAuthorization.authorityEpoch ||
            launchCommitment.fence !== launchAuthorization.fence ||
            launchCommitment.effectBindingDigest !== launchAuthorization.effectBindingDigest ||
            typeof launchCommitment.digest !== "string" || !/^[a-f0-9]{64}$/.test(launchCommitment.digest)) {
          throw fail("EOWNED_PROCESS_AUTHORITY", "trusted controller returned an invalid launch commitment");
        }
        await persist(entry, {
          launchCommitmentDigest: launchCommitment.digest,
          launchAuthorizationDigest: launchAuthorization.digest,
          launchRequested: true,
          effectStarted: true,
          noSendProof: null
        });
        assertStartLive(entry);
      } else {
        supervisor.stdin.write("{\"type\":\"launch\"}\n");
      }
      const ready = await waitStartupMessage(readyPromise, "supervisor readiness");
      if (!ready || ready.leaderPid !== supervisor.pid || ready.processGroupId !== supervisor.pid || !Number.isSafeInteger(ready.targetPid)) throw fail("EOWNED_PROCESS_START", "supervisor identity is invalid");
      if (trustedController && (
        ready.reservationId !== launchReservation.reservationId ||
        ready.reservationDigest !== launchReservation.digest ||
        ready.authorizationId !== launchAuthorization.authorizationId ||
        ready.authorizationDigest !== launchAuthorization.digest ||
        ready.commitmentId !== launchCommitment.commitmentId ||
        ready.authorityEpoch !== launchAuthorization.authorityEpoch ||
        ready.fence !== launchAuthorization.fence ||
        ready.effectBindingDigest !== launchAuthorization.effectBindingDigest
      )) throw fail("EOWNED_PROCESS_AUTHORITY", "supervisor readiness is not bound to the trusted authorization");
      entry.leaderPid = supervisor.pid;
      entry.startTime = await procStartTime(entry.leaderPid);
      assertStartLive(entry);
      entry.startedAt = isoAt(nowNumber(now));
      await persist(entry, {
        phase: "started",
        leaderPid: entry.leaderPid,
        processGroupId: entry.leaderPid,
        leaderStartTime: entry.startTime,
        startedAt: entry.startedAt,
        effectStarted: true,
        noSendProof: null
      });
      assertStartLive(entry);
      entry.phase = "started";
      const handle = publicHandle(entry, resourceAdapter);
      settleStart(entry, { state: "started", localOutcome: "started", confirmedOwnedScope: true, handle });
      consumeControlBuffer();
      if (entry.targetExit) void stopEntry(entry, "target exited").catch(() => {});
      if (entry.outputExceeded) void stopEntry(entry, "output limit exceeded").catch(() => {});
      return handle;
    } catch (error) {
      let cleanupUnknown = false;
      let groupKnownGone = !supervisor;
      if (supervisor) {
        if (!Number.isSafeInteger(entry.leaderPid) || entry.leaderPid < 1) {
          cleanupUnknown = true;
        } else {
          const proof = await groupProbe(entry).catch(() => ({ leader: null, group: null }));
          if (proof.group === false) {
            groupKnownGone = true;
          } else if (proof.leader === true && proof.group === true) {
            try { process.kill(-entry.leaderPid, "SIGKILL"); } catch { cleanupUnknown = true; }
            if (!cleanupUnknown) {
              const gone = await waitForGroupGone(entry, Date.now() + POSIX_STOP_TOTAL_MS).catch(() => null);
              groupKnownGone = gone === true;
            }
            if (!groupKnownGone) cleanupUnknown = true;
          } else {
            cleanupUnknown = true;
          }
        }
      }
      if (cleanupUnknown) {
        entry.phase = "indeterminate";
        if (entry.recordPersisted) {
          await persist(entry, {
            phase: "indeterminate",
            endedAt: isoAt(nowNumber(now)),
            localOutcome: "indeterminate",
            groupTerminated: false,
            launchRequested: entry.launchRequested === true || entry.record.launchRequested === true,
            launchReservationDigest: entry.launchReservationDigest ?? entry.record.launchReservationDigest ?? null,
            effectStarted: entry.launchRequested === true || entry.readySeen === true || entry.record.effectStarted === true
          }).catch(() => {});
        }
        settleCompletion(entry, { localOutcome: "indeterminate", groupTerminated: false });
        settleStart(entry, {
          state: "indeterminate",
          localOutcome: "indeterminate",
          confirmedOwnedScope: false,
          message: "owned process cleanup could not be proven"
        });
        entry.stopPromise = null;
        const cleanupError = fail("EOWNED_PROCESS_CLEANUP_UNKNOWN", "owned process cleanup could not be proven");
        cleanupError.cause = error;
        throw cleanupError;
      }
      // Group absence alone does not prove that this adapter observed the
      // supervisor's real child exit.  Wait briefly for the listener attached
      // to this exact ChildProcess before releasing it; if the event remains
      // absent, finish without minting a cleanup receipt and keep resolution
      // in HOLD for a later owned observation.
      await waitForSupervisorExit(entry, Math.min(1_000, POSIX_STOP_TOTAL_MS));
      const cancelled = entry.cancelRequested || error?.code === "EOWNED_PROCESS_START_CANCELLED";
      const localOutcome = cancelled ? "stopped" : "unknown";
      let finishError = null;
      try {
        await finish(entry, {
          phase: "terminal",
          localOutcome,
          groupTerminated: groupKnownGone,
          persistRecord: entry.recordPersisted
        });
      } catch (persistenceError) {
        finishError = persistenceError;
      }
      settleStart(entry, {
        state: cancelled ? "cancelled" : "failed",
        localOutcome: finishError ? "indeterminate" : localOutcome,
        confirmedOwnedScope: !finishError && groupKnownGone,
        message: finishError ? "owned allocation persistence failed" : undefined
      });
      if (finishError) {
        finishError.cause = error;
        throw finishError;
      }
      throw error;
      }
    };
    entry.startPromise = runStart();
    entry.startPromise.catch(() => {});
    return entry.startPromise;
  };

  const resourceAdapter = createOwnedResourceAdapter({
    label: POSIX_OWNED_PROCESS_ADAPTER_KIND,
    stopOwned,
    ...(trustedController ? { queryOwned, resolveOwnedLaunch } : {})
  });
  POSIX_OWNED_RESOURCE_ADAPTERS.add(resourceAdapter);
  if (trustedController) POSIX_RECOVERY_EFFECT_QUERIES.set(resourceAdapter, queryRecoveryTaskEffectOwned);
  return Object.freeze({
    kind: POSIX_OWNED_PROCESS_ADAPTER_KIND,
    resourceAdapter,
    startOwned,
    stopOwned: resourceAdapter.stopOwned
  });
}

export const createOwnedProcessAdapter = createPosixOwnedProcessAdapter;
export default createPosixOwnedProcessAdapter;
