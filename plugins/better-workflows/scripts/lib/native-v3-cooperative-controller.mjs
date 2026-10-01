import { randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";

import {
  atomicWriteJson,
  canonicalJson,
  digestObject,
  ensurePrivateDir,
  nowIso,
  readJson,
  safeJoin,
  withRunLock
} from "./core.mjs";
import { withIncidentRevisionLaunchFenceV1 } from "./incident-v1.mjs";
import { captureSourceBinding } from "./git.mjs";
import {
  ACTION_CAPABILITY_KIND,
  APPROVAL_ENVELOPE_KIND,
  buildExecutionAdmission,
  digestActionCapability,
  digestExecutionAdmission,
  validateActionCapability,
  validateApprovalEnvelope,
  validateExecutionAdmission,
  validateTrustedAdmissionSeal
} from "./execution-admission-v1.mjs";
import { createTrustedControllerAdapter, isTrustedOwnedResourceAdapter } from "./execution-runtime-v1.mjs";
import { assertPrivateStateBackendAvailableV1, assertPrivateStatePathV1 } from "./private-state-backend-v1.mjs";
import { readFreshWorkflowPlanV1 } from "./workflow-plan-v1.mjs";
import { assertNativeV3AutoCommandExecutionAllowed } from "./native-v3-auto-execution-admission.mjs";
import { validateIncidentRecoveryLaunchFenceV1 } from "./incident-recovery-v1.mjs";

/**
 * A user-mode bridge for native V3.
 *
 * This module deliberately says exactly what its boundary is.  The local
 * process and its private state are cooperative evidence, not a host TCB,
 * root-owned signer, process-group owner, or JobObject.  A host-attested
 * controller must be supplied by a different adapter when policy requires it.
 */

export const NATIVE_V3_COOPERATIVE_CONTROLLER_SCHEMA_VERSION = 1;
export const NATIVE_V3_COOPERATIVE_CONTROLLER_KIND = "CooperativeNativeV3ControllerV1";
export const NATIVE_V3_COOPERATIVE_TRUST_MODE = "cooperative-user-mode";
export const NATIVE_V3_COOPERATIVE_HOLD_CODE = "EHOST_TRUST_REQUIRED";
export const NATIVE_V3_COOPERATIVE_OWNER_APPROVAL_REQUEST_KIND = "NativeV3CooperativeOwnerApprovalRequestV1";
export const NATIVE_V3_COOPERATIVE_OWNER_DECISION_KIND = "NativeV3CooperativeOwnerDecisionV1";
export const NATIVE_V3_EFFECT_LAUNCH_RESERVATION_KIND = "CooperativeNativeV3EffectLaunchReservationV1";
export const NATIVE_V3_EFFECT_LAUNCH_AUTHORIZATION_KIND = "CooperativeNativeV3EffectLaunchAuthorizationV1";
export const NATIVE_V3_EFFECT_LAUNCH_COMMITMENT_KIND = "CooperativeNativeV3EffectLaunchCommitmentV1";
export const NATIVE_V3_EFFECT_LAUNCH_TRANSACTION_KIND = "CooperativeNativeV3EffectLaunchTransactionV1";
export const NATIVE_V3_EFFECT_LAUNCH_CLEANUP_RESOLUTION_KIND = "CooperativeNativeV3EffectLaunchCleanupResolutionV1";
// Recovery must select the persisted controller namespace explicitly when a
// single-task controller has no derived allocation key.  Allocation-backed
// recovery remains keyed by the exact task/attempt allocation identity.
export const NATIVE_V3_RECOVERY_STORAGE_BASE = "base-single-task";
export const NATIVE_V3_RECOVERY_STORAGE_ALLOCATION = "task-allocation";
export const NATIVE_V3_RECOVERY_SUCCESSOR_CLAIM_KIND = "CooperativeNativeV3RecoverySuccessorClaimV1";

const STATE_DIRECTORY = "native-v3-cooperative-controller-v1";
const RUNS_DIRECTORY = "runs";
const STATE_FILE = "controller.json";
const STATE_WRITE_LOCK_DIRECTORY = "write-locks";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ALLOCATION_KEY = /^alloc-[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_SEALS = 1024;
const OWNER_APPROVAL_SOURCE = "cooperative-owner-interactive";
const OWNER_DECISION_HANDLES = new WeakSet();
const TRUSTED_NATIVE_V3_CONTROLLERS = new WeakSet();
const MAX_OWNER_INTERACTION_MS = 15 * 60 * 1000;
// Fresh source/policy/plan reads run while the allocation CAS lock is held.
// Keep that critical section bounded so a stalled resolver cannot block
// revocation until the ordinary sixty-second lease expires.
const STATE_CALLBACK_TIMEOUT_MS = 5_000;
// One fresh read is a complete Git/authority capture: a dozen-odd git
// invocations over the worktree, index, ignored surface and authority layout.
// That costs seconds on a cold or shared host, so the default allowance is the
// full bounded window rather than half of it.  Every caller that names a value
// already passes this much; a shorter default only ever starved callers that
// omitted it.
const FRESH_RESOLVER_TIMEOUT_MS = 4_000;
// The ceiling stays where it is: it keeps a resolver below the state-lock
// callback bound so a slow one cannot hold the allocation lock indefinitely.
const MAX_FRESH_RESOLVER_TIMEOUT_MS = 4_000;
const RECOVERY_SUCCESSOR_CLAIM_KEYS = [
  "schemaVersion", "kind", "runId", "planId", "taskId", "unitId", "priorExecutionId",
  "priorAttemptId", "successorExecutionId", "successorAttemptId", "successorAllocationKey",
  "ownedResourceId", "sourceBindingDigest", "policyDigest", "revision", "effectBindingDigest",
  "claimedAt", "digest"
];
const EFFECT_LAUNCH_RESERVATION_KEYS = [
  "schemaVersion", "kind", "reservationId", "runId", "executionId", "attemptId", "unitId",
  "ownedResourceId", "sourceBindingDigest", "policyDigest", "revision", "effectBindingDigest",
  "authorityEpoch", "fence", "status", "reservedAt", "digest"
];
const EFFECT_LAUNCH_AUTHORIZATION_KEYS = [
  "schemaVersion", "kind", "authorizationId", "reservationId", "reservationDigest", "runId",
  "executionId", "attemptId", "unitId", "ownedResourceId", "sourceBindingDigest", "policyDigest",
  "revision", "effectBindingDigest", "authorityEpoch", "fence", "status", "authorizedAt", "digest"
];
const EFFECT_LAUNCH_COMMITMENT_KEYS = [
  "schemaVersion", "kind", "commitmentId", "authorizationId", "authorizationDigest", "reservationId",
  "reservationDigest", "runId", "executionId", "attemptId", "unitId", "ownedResourceId",
  "sourceBindingDigest", "policyDigest", "revision", "effectBindingDigest", "authorityEpoch", "fence",
  "status", "committedAt", "digest"
];
const EFFECT_LAUNCH_TRANSACTION_KEYS = [
  "schemaVersion", "kind", "transactionId", "commitmentId", "authorizationId", "authorizationDigest",
  "reservationId", "reservationDigest", "runId", "executionId", "attemptId", "unitId", "ownedResourceId",
  "sourceBindingDigest", "policyDigest", "revision", "effectBindingDigest", "authorityEpoch", "fence",
  "status", "startedAt", "digest"
];
const EFFECT_LAUNCH_CLEANUP_RESOLUTION_KEYS = [
  "schemaVersion", "kind", "resolutionId", "transactionId", "transactionDigest", "runId", "executionId",
  "attemptId", "unitId", "ownedResourceId", "sourceBindingDigest", "policyDigest", "revision",
  "effectBindingDigest", "authorityEpoch", "fence", "status", "effectStarted", "launchRequested",
  "groupTerminated", "lateLaunchBlocked", "noSendProof", "allocationId", "allocationRecordDigest",
  "cleanupDigest", "observedAt", "digest"
];
const OWNED_LAUNCH_CLEANUP_RECEIPT_KEYS = [
  "schemaVersion", "kind", "status", "allocationId", "transactionId", "transactionDigest", "runId",
  "handleId", "intentId", "executionId", "attemptId", "unitId", "ownedResourceId", "controllerId",
  "authorityDigest", "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence",
  "launchRequested", "effectStarted", "noSendProof", "groupTerminated", "lateLaunchBlocked",
  "launchReservationDigest", "launchAuthorizationDigest", "launchCommitmentDigest", "allocationRecordDigest",
  "observedAt", "digest"
];

function plain(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${label} must be a plain object`);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function text(value, label, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  if (pattern && !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function id(value, label) {
  return text(value, label, ID);
}

function digest(value, label) {
  return text(value, label, DIGEST);
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function currentDate(clock) {
  const value = typeof clock?.now === "function" ? clock.now() : new Date();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("clock.now() must return a valid date");
  return date;
}

function currentIso(clock) {
  return currentDate(clock).toISOString();
}

function futureIso(clock, milliseconds = 15 * 60 * 1000) {
  return new Date(currentDate(clock).getTime() + milliseconds).toISOString();
}

function sourceBinding(value, label = "sourceBinding") {
  plain(value, label);
  const result = {
    revision: text(value.revision, `${label}.revision`, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
    digest: digest(value.digest, `${label}.digest`)
  };
  return result;
}

function policyDigest(value) {
  return digest(value, "policyDigest");
}

function iso(value, label) {
  const normalized = text(value, label);
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${label} is invalid`);
  return new Date(normalized).toISOString();
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function rejectUnknownOptions(value, allowed, label) {
  plain(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is not supported`);
  }
}

function freshResolverTimeout(value) {
  const normalized = value === undefined ? FRESH_RESOLVER_TIMEOUT_MS : value;
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > MAX_FRESH_RESOLVER_TIMEOUT_MS) {
    throw new Error(`freshResolverTimeoutMs must be a positive integer <= ${MAX_FRESH_RESOLVER_TIMEOUT_MS}`);
  }
  return normalized;
}

function validateAbortSignal(value, label) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function" || typeof value.removeEventListener !== "function") {
    throw new Error(`${label} must be an AbortSignal`);
  }
  return value;
}

function budget(value, label) {
  plain(value, label);
  exactKeys(value, ["attempts", "seconds", "tokens"], label);
  if (!Number.isSafeInteger(value.attempts) || value.attempts <= 0 || value.attempts > 1_000_000) {
    throw new Error(`${label}.attempts is invalid`);
  }
  for (const key of ["seconds", "tokens"]) {
    if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] <= 0 || value[key] > 1_000_000)) {
      throw new Error(`${label}.${key} is invalid`);
    }
  }
  return { attempts: value.attempts, seconds: value.seconds, tokens: value.tokens };
}

function resolveRoot(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("stateRoot is required");
  return path.resolve(value);
}

export function nativeV3AllocationKeyFor({ taskId, attemptId } = {}) {
  const normalizedTaskId = id(taskId, "taskId");
  const normalizedAttemptId = id(attemptId, "attemptId");
  return `alloc-${digestObject({
    schemaVersion: 1,
    kind: "NativeV3TaskAllocationKeyV1",
    taskId: normalizedTaskId,
    attemptId: normalizedAttemptId
  })}`;
}

function normalizedAllocationKey(value, { taskId, attemptId } = {}) {
  if (value === undefined) return undefined;
  const supplied = text(value, "allocationKey", ALLOCATION_KEY);
  const expected = nativeV3AllocationKeyFor({ taskId, attemptId });
  if (supplied !== expected) throw new Error("allocationKey is not derived from the exact task/attempt identity");
  return supplied;
}

function pathFor(root, runId, allocationKey = undefined) {
  if (allocationKey === undefined) return safeJoin(root, STATE_DIRECTORY, RUNS_DIRECTORY, runId, STATE_FILE);
  return safeJoin(root, STATE_DIRECTORY, RUNS_DIRECTORY, runId, "allocations", allocationKey, STATE_FILE);
}

function runDirFor(root, runId, allocationKey = undefined) {
  if (allocationKey === undefined) return safeJoin(root, STATE_DIRECTORY, RUNS_DIRECTORY, runId);
  return safeJoin(root, STATE_DIRECTORY, RUNS_DIRECTORY, runId, "allocations", allocationKey);
}

async function ensureStateDirectories(root, runId, allocationKey = undefined) {
  await ensurePrivateDir(root);
  await ensurePrivateDir(safeJoin(root, STATE_DIRECTORY));
  await ensurePrivateDir(safeJoin(root, STATE_DIRECTORY, RUNS_DIRECTORY));
  await ensurePrivateDir(runDirFor(root, runId, allocationKey));
  if (allocationKey !== undefined) {
    await ensurePrivateDir(safeJoin(root, STATE_DIRECTORY, "locks"));
    await ensurePrivateDir(safeJoin(root, STATE_DIRECTORY, "locks", allocationKey));
    await ensurePrivateDir(safeJoin(root, STATE_DIRECTORY, "locks", allocationKey, RUNS_DIRECTORY));
    await ensurePrivateDir(safeJoin(root, STATE_DIRECTORY, "locks", allocationKey, RUNS_DIRECTORY, runId));
  }
}

function stateWriteLockRoot(root, allocationKey = undefined) {
  return allocationKey === undefined
    ? safeJoin(root, STATE_DIRECTORY, STATE_WRITE_LOCK_DIRECTORY)
    : safeJoin(root, STATE_DIRECTORY, STATE_WRITE_LOCK_DIRECTORY, allocationKey);
}

async function withStateWriteLock(root, runId, allocationKey, callback) {
  const lockRoot = stateWriteLockRoot(root, allocationKey);
  await ensurePrivateDir(safeJoin(lockRoot, RUNS_DIRECTORY, runId));
  return withRunLock(lockRoot, runId, callback, { ttlMs: 60_000 });
}

async function readStateIfPresent(root, runId, allocationKey = undefined) {
  try {
    return await readJson(root, pathFor(root, runId, allocationKey));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Seal evidence is an observation. Keep this path separate from readJson(),
// whose private-directory check may create or chmod the state root.
async function readSealStateReadOnly(root, runId, allocationKey = undefined) {
  assertPrivateStateBackendAvailableV1();
  const resolvedRoot = path.resolve(root);
  const target = pathFor(resolvedRoot, runId, allocationKey);
  const components = path.relative(resolvedRoot, target).split(path.sep).filter(Boolean);
  let current = resolvedRoot;
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = path.join(current, components[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink path component: ${current}`);
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`Expected directory path component: ${current}`);
    }
    if (index === components.length - 1 && (!info.isFile() || info.nlink !== 1)) {
      throw new Error(`Unsafe JSON path: ${current}`);
    }
    assertPrivateStatePathV1({
      root: resolvedRoot,
      target: current,
      info,
      kind: index === components.length - 1 ? "file" : "directory",
      label: `cooperative seal state ${current}`
    });
  }
  return JSON.parse(await readFile(target, "utf8"));
}

async function readSealStateIfPresentReadOnly(root, runId, allocationKey = undefined) {
  try {
    return await readSealStateReadOnly(root, runId, allocationKey);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(root, runId, state, allocationKey = undefined, {
  expectedStateDigest = undefined,
  expectAbsent = false,
  signal = undefined
} = {}) {
  // The callback lease can expire while user code is still unwinding.  Keep
  // durable commits behind a separate writer lease and compare the complete
  // prior state (which includes the authority epoch and fence) immediately
  // before the atomic rename.
  if (expectAbsent === (expectedStateDigest !== undefined)) {
    throw new Error("cooperative controller durable write requires exactly one CAS boundary");
  }
  if (signal?.aborted) throw boundedFailure("EOWNER_LOCK_ABORTED", "cooperative controller durable write was aborted");
  await withStateWriteLock(root, runId, allocationKey, async () => {
    if (signal?.aborted) throw boundedFailure("EOWNER_LOCK_ABORTED", "cooperative controller durable write was aborted");
    const current = await readStateIfPresent(root, runId, allocationKey);
    if (expectAbsent) {
      if (current !== null) throw ownerApprovalError("EOWNER_STATE_STALE", "cooperative controller state already exists");
    } else if (current === null || digestObject(current) !== expectedStateDigest) {
      throw ownerApprovalError("EOWNER_STATE_STALE", "cooperative controller state changed before durable write");
    }
    if (signal?.aborted) throw boundedFailure("EOWNER_LOCK_ABORTED", "cooperative controller durable write was aborted");
    await atomicWriteJson(root, pathFor(root, runId, allocationKey), state);
  });
}

// This seam exercises the same durable boundary used by controller callbacks
// after their bounded operation has returned.  It is intentionally test-only;
// production callers use the controller methods below.
export async function __testAttemptCooperativeNativeV3DurableWrite({
  stateRoot,
  runId,
  allocationKey = undefined,
  state,
  expectedStateDigest
} = {}) {
  const root = resolveRoot(stateRoot);
  const checkedRunId = checkRequiredOption(runId, "runId");
  const checkedState = plain(state, "test cooperative controller state");
  const checkedAllocationKey = allocationKey === undefined ? undefined : text(allocationKey, "allocationKey", ALLOCATION_KEY);
  const checkedExpectedStateDigest = digest(expectedStateDigest, "expectedStateDigest");
  await writeState(root, checkedRunId, checkedState, checkedAllocationKey, { expectedStateDigest: checkedExpectedStateDigest });
}

function boundedFailure(code, message) {
  return ownerApprovalError(code, message);
}

async function runBoundedControllerOperation(label, operation, { signal = undefined, timeoutMs = STATE_CALLBACK_TIMEOUT_MS } = {}) {
  if (signal?.aborted) throw boundedFailure("EOWNER_LOCK_ABORTED", `${label} was aborted before it started`);
  let timer;
  let removeAbort = null;
  const operationPromise = Promise.resolve().then(operation);
  // A timed-out resolver may continue running in user code.  Observe its
  // eventual rejection so it cannot become an unhandled rejection, while the
  // controller treats its result as unusable after the abort boundary.
  operationPromise.catch(() => {});
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(boundedFailure("EOWNER_LOCK_TIMEOUT", `${label} timed out`)), timeoutMs);
  });
  let abortPromise = null;
  if (signal) {
    abortPromise = new Promise((_, reject) => {
      const onAbort = () => reject(boundedFailure("EOWNER_LOCK_ABORTED", `${label} was aborted`));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
    });
  }
  try {
    return await Promise.race(abortPromise ? [operationPromise, timeoutPromise, abortPromise] : [operationPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
    removeAbort?.();
  }
}

async function withStateLock(root, runId, callback, allocationKey = undefined, options = {}) {
  await ensureStateDirectories(root, runId, allocationKey);
  // withRunLock resolves its lease beneath <root>/runs/<runId>.  The
  // cooperative controller's run directory is nested beneath its private
  // state namespace, so pass that namespace as the lock root.
  const lockRoot = allocationKey === undefined
    ? safeJoin(root, STATE_DIRECTORY)
    : safeJoin(root, STATE_DIRECTORY, "locks", allocationKey);
  const timeoutMs = options.timeoutMs === undefined ? null : options.timeoutMs;
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)) {
    throw new Error("state lock callback timeout is invalid");
  }
  const abortSignal = timeoutMs === null && options.abortSignal === undefined
    ? undefined
    : validateAbortSignal(options.abortSignal, "state lock abortSignal");
  const waitTimeoutMs = options.acquireTimeoutMs ?? STATE_CALLBACK_TIMEOUT_MS;
  if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs <= 0 || waitTimeoutMs > 60_000) {
    throw new Error("state lock acquisition timeout is invalid");
  }
  const deadline = Date.now() + waitTimeoutMs;
  for (;;) {
    try {
      return await withRunLock(lockRoot, runId, async (lease) => {
        if (timeoutMs === null && abortSignal === undefined) return callback(lease);
        const controller = new AbortController();
        let onExternalAbort = null;
        if (abortSignal) {
          onExternalAbort = () => controller.abort();
          if (abortSignal.aborted) controller.abort();
          else abortSignal.addEventListener("abort", onExternalAbort, { once: true });
        }
        try {
          return await runBoundedControllerOperation("controller state lock callback", () => callback({ ...lease, signal: controller.signal }), {
            signal: controller.signal,
            timeoutMs: timeoutMs ?? STATE_CALLBACK_TIMEOUT_MS
          });
        } finally {
          controller.abort();
          if (abortSignal && onExternalAbort) abortSignal.removeEventListener("abort", onExternalAbort);
        }
      }, { ttlMs: timeoutMs === null ? 60_000 : Math.min(60_000, timeoutMs + 1_000) });
    } catch (error) {
      // withRunLock deliberately fails fast on a live lease.  Controller
      // revocation must be able to wait for a bounded fresh-read callback to
      // release that same allocation lock, including when both calls are in
      // this process, so retry only this specific contention outcome.
      if (!String(error?.message ?? "").startsWith("Run is leased by pid") || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }
}

async function withOrderedStateLocks(root, runId, allocationKeys, callback) {
  const unique = new Map();
  for (const allocationKey of allocationKeys) {
    const sortKey = allocationKey === undefined ? "0:base-single-task" : `1:${allocationKey}`;
    unique.set(sortKey, allocationKey);
  }
  const ordered = [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, allocationKey]) => allocationKey);
  const acquire = async (index) => {
    if (index >= ordered.length) return callback();
    return withStateLock(root, runId, () => acquire(index + 1), ordered[index]);
  };
  return acquire(0);
}

function allocationToken(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function allocationFence(runId, envelopeDigest, at) {
  return digestObject({
    schemaVersion: 1,
    kind: NATIVE_V3_COOPERATIVE_CONTROLLER_KIND,
    runId,
    envelopeDigest,
    random: randomBytes(32).toString("hex"),
    at
  });
}

const OWNER_APPROVAL_REQUEST_KEYS = [
  "schemaVersion", "kind", "requestId", "requestDigest", "candidateDigest", "effectBindingDigest",
  "runId", "planId", "taskId", "unitId", "executionId", "attemptId", "ownedResourceId", "nonce",
  "planDigest", "contractDigest", "sourceBindingDigest", "policyDigest", "revision",
  "recipient", "action", "requestedModel", "budget", "scope", "expiresAt", "createdAt"
];

const OWNER_DECISION_KEYS = [
  "schemaVersion", "kind", "decisionId", "decisionDigest", "requestDigest", "candidateDigest",
  "effectBindingDigest", "decision", "source", "decidedAt", "status", "consumedAt"
];

function ownerApprovalRequestBody(request) {
  const { requestDigest: ignored, ...body } = request;
  return body;
}

function validateOwnerApprovalRequest(value, runId = undefined) {
  plain(value, "owner approval request");
  exactKeys(value, OWNER_APPROVAL_REQUEST_KEYS, "owner approval request");
  if (value.schemaVersion !== 1 || value.kind !== NATIVE_V3_COOPERATIVE_OWNER_APPROVAL_REQUEST_KIND) {
    throw new Error("owner approval request version/kind is invalid");
  }
  id(value.requestId, "owner approval request.requestId");
  digest(value.requestDigest, "owner approval request.requestDigest");
  digest(value.candidateDigest, "owner approval request.candidateDigest");
  digest(value.effectBindingDigest, "owner approval request.effectBindingDigest");
  if (runId !== undefined && value.runId !== runId) throw new Error("owner approval request.runId does not match");
  for (const key of ["runId", "planId", "taskId", "unitId", "executionId", "attemptId", "ownedResourceId", "nonce"]) {
    id(value[key], `owner approval request.${key}`);
  }
  for (const key of ["planDigest", "contractDigest", "sourceBindingDigest", "policyDigest"]) {
    digest(value[key], `owner approval request.${key}`);
  }
  text(value.revision, "owner approval request.revision", /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
  text(value.recipient, "owner approval request.recipient");
  text(value.action, "owner approval request.action");
  if (value.requestedModel !== null) text(value.requestedModel, "owner approval request.requestedModel");
  budget(value.budget, "owner approval request.budget");
  plain(value.scope, "owner approval request.scope");
  exactKeys(value.scope, ["include", "exclude"], "owner approval request.scope");
  for (const key of ["include", "exclude"]) {
    if (!Array.isArray(value.scope[key]) || value.scope[key].some((item) => typeof item !== "string" || item.length > 4096 || /[\u0000-\u001f\u007f]/.test(item))) {
      throw new Error(`owner approval request.scope.${key} is invalid`);
    }
  }
  const expiresAt = iso(value.expiresAt, "owner approval request.expiresAt");
  const createdAt = iso(value.createdAt, "owner approval request.createdAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error("owner approval request expiry is invalid");
  const normalized = {
    ...value,
    requestedModel: value.requestedModel === null ? null : value.requestedModel,
    budget: budget(value.budget, "owner approval request.budget"),
    scope: { include: [...value.scope.include], exclude: [...value.scope.exclude] },
    expiresAt,
    createdAt
  };
  if (digestObject(ownerApprovalRequestBody(normalized)) !== normalized.requestDigest) {
    throw new Error("owner approval request digest is not bound");
  }
  return normalized;
}

function ownerDecisionBody(decision) {
  const { decisionDigest: ignored, ...body } = decision;
  return body;
}

function validateOwnerDecision(value, label = "owner approval decision") {
  plain(value, label);
  exactKeys(value, OWNER_DECISION_KEYS, label);
  if (value.schemaVersion !== 1 || value.kind !== NATIVE_V3_COOPERATIVE_OWNER_DECISION_KIND) {
    throw new Error(`${label} version/kind is invalid`);
  }
  id(value.decisionId, `${label}.decisionId`);
  digest(value.decisionDigest, `${label}.decisionDigest`);
  digest(value.requestDigest, `${label}.requestDigest`);
  digest(value.candidateDigest, `${label}.candidateDigest`);
  digest(value.effectBindingDigest, `${label}.effectBindingDigest`);
  if (!new Set(["approve", "reject"]).has(value.decision)) throw new Error(`${label}.decision is invalid`);
  if (value.source !== OWNER_APPROVAL_SOURCE) throw new Error(`${label}.source is invalid`);
  const decidedAt = iso(value.decidedAt, `${label}.decidedAt`);
  if (!new Set(["recorded", "consumed"]).has(value.status)) throw new Error(`${label}.status is invalid`);
  const consumedAt = value.consumedAt === null ? null : iso(value.consumedAt, `${label}.consumedAt`);
  if (value.status === "consumed" && (value.decision !== "approve" || consumedAt === null)) {
    throw new Error(`${label}.consumed status is invalid`);
  }
  if (value.status === "recorded" && consumedAt !== null) throw new Error(`${label}.recorded status is invalid`);
  const normalized = { ...value, decidedAt, consumedAt };
  if (digestObject(ownerDecisionBody(normalized)) !== normalized.decisionDigest) {
    throw new Error(`${label} digest is not bound`);
  }
  return normalized;
}

function ownerApprovalRequestFor({ plan, planId, candidate, effectBindingDigest, createdAt }) {
  const request = {
    schemaVersion: 1,
    kind: NATIVE_V3_COOPERATIVE_OWNER_APPROVAL_REQUEST_KIND,
    requestId: allocationToken("owner-request"),
    candidateDigest: candidate.digest,
    effectBindingDigest: digest(effectBindingDigest, "effectBindingDigest"),
    runId: candidate.runId,
    planId: id(planId, "planId"),
    taskId: candidate.taskId,
    unitId: candidate.unitId,
    executionId: candidate.executionId,
    attemptId: candidate.attemptId,
    ownedResourceId: candidate.ownedResourceId,
    nonce: candidate.nonce,
    planDigest: plan.planDigest,
    contractDigest: plan.contractDigest,
    sourceBindingDigest: candidate.sourceBindingDigest,
    policyDigest: candidate.policyDigest,
    revision: candidate.revision,
    recipient: candidate.recipient,
    action: candidate.action,
    requestedModel: candidate.requestedModel ?? null,
    budget: clone(candidate.budget),
    scope: clone(candidate.scope),
    expiresAt: candidate.expiresAt,
    createdAt
  };
  return validateOwnerApprovalRequest({
    ...request,
    requestDigest: digestObject(request)
  }, candidate.runId);
}

function ownerRequestMatchesPreparation(request, {
  plan,
  planId,
  runId,
  taskId,
  unitId,
  executionId,
  attemptId,
  recipient,
  action,
  requestedModel,
  source,
  policy,
  effectBindingDigest,
  expiresAt
}) {
  const task = taskFor(plan, taskId);
  const expected = {
    planId,
    runId,
    taskId,
    unitId,
    executionId,
    attemptId,
    recipient,
    action,
    requestedModel: requestedModel ?? null,
    budget: task.budget,
    scope: plan.taskContract.scope,
    planDigest: plan.planDigest,
    contractDigest: plan.contractDigest,
    sourceBindingDigest: source.digest,
    policyDigest: policy,
    revision: source.revision,
    effectBindingDigest
  };
  for (const [key, value] of Object.entries(expected)) {
    if (key === "budget" || key === "scope") {
      if (!same(request[key], value)) return false;
    } else if (request[key] !== value) {
      return false;
    }
  }
  return expiresAt === undefined || request.expiresAt === expiresAt;
}

function ownerDecisionFor(request, decision, decidedAt) {
  const body = {
    schemaVersion: 1,
    kind: NATIVE_V3_COOPERATIVE_OWNER_DECISION_KIND,
    decisionId: allocationToken("owner-decision"),
    requestDigest: request.requestDigest,
    candidateDigest: request.candidateDigest,
    effectBindingDigest: request.effectBindingDigest,
    decision,
    source: OWNER_APPROVAL_SOURCE,
    decidedAt: iso(decidedAt, "owner approval decision.decidedAt"),
    status: "recorded",
    consumedAt: null
  };
  return validateOwnerDecision({
    ...body,
    decisionDigest: digestObject(body)
  });
}

function validateDecisionAgainstRequest(decision, request) {
  const normalized = validateOwnerDecision(decision);
  if (normalized.requestDigest !== request.requestDigest ||
      normalized.candidateDigest !== request.candidateDigest ||
      normalized.effectBindingDigest !== request.effectBindingDigest) {
    throw new Error("owner approval decision is not bound to the exact pending request");
  }
  if (Date.parse(normalized.decidedAt) >= Date.parse(request.expiresAt)) {
    throw new Error("owner approval decision is outside the request validity window");
  }
  return normalized;
}

function mintOwnerDecisionHandle(decision) {
  const handle = Object.freeze(clone(decision));
  OWNER_DECISION_HANDLES.add(handle);
  return handle;
}

// The generic execution-runtime adapter is an implementation primitive, not
// the native V3 producer authority.  Keep a private producer brand so the
// POSIX recovery path cannot be opened with an exported adapter assembled by
// a caller from arbitrary callbacks and a self-asserted trust response.
export function isTrustedNativeV3Controller(value) {
  return Boolean(value && typeof value === "object" && TRUSTED_NATIVE_V3_CONTROLLERS.has(value));
}

function brandTrustedNativeV3Controller(controller) {
  TRUSTED_NATIVE_V3_CONTROLLERS.add(controller);
  return controller;
}

function validateOwnerDecisionHandle(value) {
  if (!value || typeof value !== "object" || !OWNER_DECISION_HANDLES.has(value)) {
    const error = new Error("An opaque cooperative owner interaction decision is required");
    error.code = "EOWNER_APPROVAL_REQUIRED";
    error.status = "HOLD";
    throw error;
  }
  return validateOwnerDecision(value, "opaque owner approval decision");
}

function validateEffectLaunchReservation(value, label = "effect launch reservation") {
  plain(value, label);
  exactKeys(value, EFFECT_LAUNCH_RESERVATION_KEYS, label);
  if (value.schemaVersion !== 1 || value.kind !== NATIVE_V3_EFFECT_LAUNCH_RESERVATION_KIND) {
    throw new Error(`${label} version/kind is invalid`);
  }
  id(value.reservationId, `${label}.reservationId`);
  for (const key of ["runId", "executionId", "attemptId", "unitId", "ownedResourceId"]) {
    id(value[key], `${label}.${key}`);
  }
  for (const key of ["sourceBindingDigest", "policyDigest", "effectBindingDigest", "fence", "digest"]) {
    digest(value[key], `${label}.${key}`);
  }
  text(value.revision, `${label}.revision`, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
  if (!Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1) {
    throw new Error(`${label}.authorityEpoch is invalid`);
  }
  if (value.status !== "reserved") throw new Error(`${label}.status is invalid`);
  const reservedAt = iso(value.reservedAt, `${label}.reservedAt`);
  const { digest: suppliedDigest, ...body } = value;
  if (digestObject(body) !== suppliedDigest) throw new Error(`${label}.digest is not bound`);
  return { ...value, reservedAt };
}

function validateEffectLaunchAuthorization(value, label = "effect launch authorization") {
  plain(value, label);
  exactKeys(value, EFFECT_LAUNCH_AUTHORIZATION_KEYS, label);
  if (value.schemaVersion !== 1 || value.kind !== NATIVE_V3_EFFECT_LAUNCH_AUTHORIZATION_KIND) {
    throw new Error(`${label} version/kind is invalid`);
  }
  id(value.authorizationId, `${label}.authorizationId`);
  id(value.reservationId, `${label}.reservationId`);
  for (const key of ["runId", "executionId", "attemptId", "unitId", "ownedResourceId"]) {
    id(value[key], `${label}.${key}`);
  }
  for (const key of ["reservationDigest", "sourceBindingDigest", "policyDigest", "effectBindingDigest", "fence", "digest"]) {
    digest(value[key], `${label}.${key}`);
  }
  text(value.revision, `${label}.revision`, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
  if (!Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1) {
    throw new Error(`${label}.authorityEpoch is invalid`);
  }
  if (value.status !== "authorized") throw new Error(`${label}.status is invalid`);
  const authorizedAt = iso(value.authorizedAt, `${label}.authorizedAt`);
  const { digest: suppliedDigest, ...body } = value;
  if (digestObject(body) !== suppliedDigest) throw new Error(`${label}.digest is not bound`);
  return { ...value, authorizedAt };
}

function validateEffectLaunchCommitment(value, label = "effect launch commitment") {
  plain(value, label);
  exactKeys(value, EFFECT_LAUNCH_COMMITMENT_KEYS, label);
  if (value.schemaVersion !== 1 || value.kind !== NATIVE_V3_EFFECT_LAUNCH_COMMITMENT_KIND) {
    throw new Error(`${label} version/kind is invalid`);
  }
  id(value.commitmentId, `${label}.commitmentId`);
  id(value.authorizationId, `${label}.authorizationId`);
  id(value.reservationId, `${label}.reservationId`);
  for (const key of ["runId", "executionId", "attemptId", "unitId", "ownedResourceId"]) {
    id(value[key], `${label}.${key}`);
  }
  for (const key of ["authorizationDigest", "reservationDigest", "sourceBindingDigest", "policyDigest", "effectBindingDigest", "fence", "digest"]) {
    digest(value[key], `${label}.${key}`);
  }
  text(value.revision, `${label}.revision`, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
  if (!Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1) {
    throw new Error(`${label}.authorityEpoch is invalid`);
  }
  if (value.status !== "committed") throw new Error(`${label}.status is invalid`);
  const committedAt = iso(value.committedAt, `${label}.committedAt`);
  const { digest: suppliedDigest, ...body } = value;
  if (digestObject(body) !== suppliedDigest) throw new Error(`${label}.digest is not bound`);
  return { ...value, committedAt };
}

function validateEffectLaunchTransaction(value, label = "effect launch transaction") {
  plain(value, label);
  exactKeys(value, EFFECT_LAUNCH_TRANSACTION_KEYS, label);
  if (value.schemaVersion !== 1 || value.kind !== NATIVE_V3_EFFECT_LAUNCH_TRANSACTION_KIND) {
    throw new Error(`${label} version/kind is invalid`);
  }
  id(value.transactionId, `${label}.transactionId`);
  id(value.commitmentId, `${label}.commitmentId`);
  id(value.authorizationId, `${label}.authorizationId`);
  id(value.reservationId, `${label}.reservationId`);
  for (const key of ["runId", "executionId", "attemptId", "unitId", "ownedResourceId"]) {
    id(value[key], `${label}.${key}`);
  }
  for (const key of ["authorizationDigest", "reservationDigest", "sourceBindingDigest", "policyDigest", "effectBindingDigest", "fence", "digest"]) {
    digest(value[key], `${label}.${key}`);
  }
  text(value.revision, `${label}.revision`, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
  if (!Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1) {
    throw new Error(`${label}.authorityEpoch is invalid`);
  }
  if (value.status !== "in-flight" && value.status !== "unknown") {
    throw new Error(`${label}.status is invalid`);
  }
  const startedAt = iso(value.startedAt, `${label}.startedAt`);
  const { digest: suppliedDigest, ...body } = value;
  if (digestObject(body) !== suppliedDigest) throw new Error(`${label}.digest is not bound`);
  return { ...value, startedAt };
}

function validateEffectLaunchAcknowledgement(value, expected, label = "effect launch acknowledgement") {
  plain(value, label);
  exactKeys(value, [
    "schemaVersion", "kind", "status", "commitmentId", "authorizationId", "authorizationDigest",
    "reservationId", "reservationDigest", "runId", "executionId", "attemptId", "unitId",
    "ownedResourceId", "sourceBindingDigest", "policyDigest", "revision", "effectBindingDigest",
    "authorityEpoch", "fence", "supervisorPid", "targetPid", "observedAt"
  ], label);
  if (value.schemaVersion !== 1 || value.kind !== "PosixOwnedProcessLaunchAcknowledgementV1" || value.status !== "spawned") {
    throw new Error(`${label} version/kind/status is invalid`);
  }
  for (const key of ["commitmentId", "authorizationId", "reservationId", "runId", "executionId", "attemptId", "unitId", "ownedResourceId"]) {
    id(value[key], `${label}.${key}`);
  }
  for (const key of ["authorizationDigest", "reservationDigest", "sourceBindingDigest", "policyDigest", "effectBindingDigest", "fence"]) {
    digest(value[key], `${label}.${key}`);
  }
  text(value.revision, `${label}.revision`, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
  if (!Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1 ||
      !Number.isSafeInteger(value.supervisorPid) || value.supervisorPid < 1 ||
      !Number.isSafeInteger(value.targetPid) || value.targetPid < 1) {
    throw new Error(`${label} numeric binding is invalid`);
  }
  const observedAt = iso(value.observedAt, `${label}.observedAt`);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) throw new Error(`${label}.${key} is not bound to the launch transaction`);
  }
  return { ...value, observedAt };
}

function launchReservationMatchesState(reservation, state) {
  if (reservation === null || reservation === undefined) return true;
  const binding = bindingFromState(state);
  return reservation.runId === binding.runId &&
    reservation.executionId === binding.executionId &&
    reservation.attemptId === binding.attemptId &&
    reservation.unitId === binding.unitId &&
    reservation.ownedResourceId === binding.ownedResourceId &&
    reservation.sourceBindingDigest === binding.sourceBindingDigest &&
    reservation.policyDigest === binding.policyDigest &&
    reservation.revision === binding.revision &&
    reservation.effectBindingDigest === state.ownerApprovalRequest.effectBindingDigest &&
    reservation.authorityEpoch >= 1 &&
    typeof reservation.fence === "string";
}

function launchCommitmentMatchesState(commitment, state, authorization) {
  if (commitment === null || commitment === undefined || authorization === null || authorization === undefined) return false;
  const binding = bindingFromState(state);
  return commitment.commitmentId !== undefined &&
    commitment.authorizationId === authorization.authorizationId &&
    commitment.authorizationDigest === authorization.digest &&
    commitment.reservationId === authorization.reservationId &&
    commitment.reservationDigest === authorization.reservationDigest &&
    commitment.runId === binding.runId &&
    commitment.executionId === binding.executionId &&
    commitment.attemptId === binding.attemptId &&
    commitment.unitId === binding.unitId &&
    commitment.ownedResourceId === binding.ownedResourceId &&
    commitment.sourceBindingDigest === binding.sourceBindingDigest &&
    commitment.policyDigest === binding.policyDigest &&
    commitment.revision === binding.revision &&
    commitment.effectBindingDigest === state.ownerApprovalRequest.effectBindingDigest &&
    commitment.authorityEpoch === authorization.authorityEpoch &&
    commitment.fence === authorization.fence;
}

function launchTransactionMatchesState(transaction, state, authorization) {
  if (transaction === null || transaction === undefined || authorization === null || authorization === undefined) return false;
  const binding = bindingFromState(state);
  return transaction.commitmentId !== undefined &&
    transaction.authorizationId === authorization.authorizationId &&
    transaction.authorizationDigest === authorization.digest &&
    transaction.reservationId === authorization.reservationId &&
    transaction.reservationDigest === authorization.reservationDigest &&
    transaction.runId === binding.runId &&
    transaction.executionId === binding.executionId &&
    transaction.attemptId === binding.attemptId &&
    transaction.unitId === binding.unitId &&
    transaction.ownedResourceId === binding.ownedResourceId &&
    transaction.sourceBindingDigest === binding.sourceBindingDigest &&
    transaction.policyDigest === binding.policyDigest &&
    transaction.revision === binding.revision &&
    transaction.effectBindingDigest === state.ownerApprovalRequest.effectBindingDigest &&
    transaction.authorityEpoch === authorization.authorityEpoch &&
    transaction.fence === authorization.fence;
}

function validateEffectLaunchCleanupResolution(value, label = "effect launch cleanup resolution") {
  plain(value, label);
  exactKeys(value, EFFECT_LAUNCH_CLEANUP_RESOLUTION_KEYS, label);
  if (value.schemaVersion !== 1 || value.kind !== NATIVE_V3_EFFECT_LAUNCH_CLEANUP_RESOLUTION_KIND ||
      value.status !== "cleanup-confirmed") {
    throw new Error(`${label} version/kind/status is invalid`);
  }
  for (const key of [
    "resolutionId", "transactionId", "runId", "executionId", "attemptId", "unitId", "ownedResourceId",
    "allocationId"
  ]) id(value[key], `${label}.${key}`);
  for (const key of [
    "transactionDigest", "sourceBindingDigest", "policyDigest", "effectBindingDigest", "fence",
    "allocationRecordDigest", "cleanupDigest", "digest"
  ]) digest(value[key], `${label}.${key}`);
  text(value.revision, `${label}.revision`, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
  if (!Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1) {
    throw new Error(`${label}.authorityEpoch is invalid`);
  }
  for (const key of ["effectStarted", "launchRequested", "groupTerminated", "lateLaunchBlocked"]) {
    if (value[key] !== true) throw new Error(`${label}.${key} must be true`);
  }
  if (value.noSendProof !== null) throw new Error(`${label}.noSendProof must remain null after an effect boundary`);
  const observedAt = iso(value.observedAt, `${label}.observedAt`);
  const { digest: suppliedDigest, ...body } = value;
  if (digestObject(body) !== suppliedDigest) throw new Error(`${label}.digest is not bound`);
  return { ...value, observedAt };
}

function launchCleanupResolutionMatchesState(resolution, state, authorization) {
  if (resolution === null || resolution === undefined || authorization === null || authorization === undefined) return false;
  const binding = bindingFromState(state);
  return resolution.transactionId !== undefined &&
    resolution.transactionDigest !== undefined &&
    resolution.runId === binding.runId &&
    resolution.executionId === binding.executionId &&
    resolution.attemptId === binding.attemptId &&
    resolution.unitId === binding.unitId &&
    resolution.ownedResourceId === binding.ownedResourceId &&
    resolution.sourceBindingDigest === binding.sourceBindingDigest &&
    resolution.policyDigest === binding.policyDigest &&
    resolution.revision === binding.revision &&
    resolution.effectBindingDigest === state.ownerApprovalRequest.effectBindingDigest &&
    resolution.authorityEpoch === authorization.authorityEpoch &&
    resolution.fence === authorization.fence;
}

function validateOwnedLaunchCleanupReceipt(value, request, transaction, controllerId, label = "owned launch cleanup receipt") {
  plain(value, label);
  exactKeys(value, OWNED_LAUNCH_CLEANUP_RECEIPT_KEYS, label);
  if (value.schemaVersion !== 1 || value.status !== "confirmed" ||
      value.kind !== "PosixOwnedLaunchCleanupReceiptV1") {
    throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_INVALID", `${label} version/kind/status is invalid`);
  }
  for (const key of [
    "allocationId", "transactionId", "runId", "handleId", "intentId", "executionId", "attemptId", "unitId",
    "ownedResourceId", "controllerId"
  ]) id(value[key], `${label}.${key}`);
  for (const key of [
    "transactionDigest", "authorityDigest", "sourceBindingDigest", "policyDigest", "fence",
    "launchReservationDigest", "launchAuthorizationDigest", "allocationRecordDigest", "digest"
  ]) digest(value[key], `${label}.${key}`);
  text(value.revision, `${label}.revision`, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
  if (!Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1) {
    throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_INVALID", `${label}.authorityEpoch is invalid`);
  }
  for (const key of ["launchRequested", "effectStarted", "groupTerminated", "lateLaunchBlocked"]) {
    if (value[key] !== true) throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_INVALID", `${label}.${key} must be true`);
  }
  if (value.noSendProof !== null || value.launchCommitmentDigest !== null) {
    throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_INVALID", `${label} crossed an effect boundary incorrectly`);
  }
  const observedAt = iso(value.observedAt, `${label}.observedAt`);
  const { digest: suppliedDigest, ...body } = value;
  if (digestObject(body) !== suppliedDigest) {
    throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_INVALID", `${label}.digest is not bound`);
  }
  const requestFields = [
    "runId", "handleId", "intentId", "executionId", "attemptId", "unitId", "ownedResourceId",
    "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence"
  ];
  for (const key of requestFields) {
    if (value[key] !== request[key]) throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_INVALID", `${label}.${key} is not bound to the request`);
  }
  if (value.controllerId !== controllerId || value.transactionId !== transaction.transactionId ||
      value.transactionDigest !== transaction.digest || value.launchReservationDigest !== transaction.reservationDigest ||
      value.launchAuthorizationDigest !== transaction.authorizationDigest || transaction.status !== "unknown") {
    throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_INVALID", `${label} is not bound to the unresolved controller transaction`);
  }
  return { ...value, observedAt };
}

function ownerApprovalError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = "HOLD";
  return error;
}

function recoverySuccessorClaimBody({
  runId,
  planId,
  taskId,
  unitId,
  priorExecutionId,
  priorAttemptId,
  successorExecutionId,
  successorAttemptId,
  successorAllocationKey,
  ownedResourceId,
  sourceBindingDigest,
  policyDigest: expectedPolicyDigest,
  revision,
  effectBindingDigest,
  claimedAt
}) {
  return {
    schemaVersion: 1,
    kind: NATIVE_V3_RECOVERY_SUCCESSOR_CLAIM_KIND,
    runId: id(runId, "recovery successor claim.runId"),
    planId: id(planId, "recovery successor claim.planId"),
    taskId: id(taskId, "recovery successor claim.taskId"),
    unitId: id(unitId, "recovery successor claim.unitId"),
    priorExecutionId: id(priorExecutionId, "recovery successor claim.priorExecutionId"),
    priorAttemptId: id(priorAttemptId, "recovery successor claim.priorAttemptId"),
    successorExecutionId: id(successorExecutionId, "recovery successor claim.successorExecutionId"),
    successorAttemptId: id(successorAttemptId, "recovery successor claim.successorAttemptId"),
    successorAllocationKey: text(successorAllocationKey, "recovery successor claim.successorAllocationKey", ALLOCATION_KEY),
    ownedResourceId: id(ownedResourceId, "recovery successor claim.ownedResourceId"),
    sourceBindingDigest: digest(sourceBindingDigest, "recovery successor claim.sourceBindingDigest"),
    policyDigest: digest(expectedPolicyDigest, "recovery successor claim.policyDigest"),
    revision: text(revision, "recovery successor claim.revision", /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
    effectBindingDigest: digest(effectBindingDigest, "recovery successor claim.effectBindingDigest"),
    claimedAt: iso(claimedAt, "recovery successor claim.claimedAt")
  };
}

function validateRecoverySuccessorClaim(value, state) {
  plain(value, "cooperative controller recovery successor claim");
  exactKeys(value, RECOVERY_SUCCESSOR_CLAIM_KEYS, "cooperative controller recovery successor claim");
  const body = recoverySuccessorClaimBody(value);
  const claim = { ...body, digest: digest(value.digest, "recovery successor claim.digest") };
  if (digestObject(body) !== claim.digest) {
    throw new Error("cooperative controller recovery successor claim digest is stale");
  }
  const expectedAllocationKey = nativeV3AllocationKeyFor({
    taskId: claim.taskId,
    attemptId: claim.successorAttemptId
  });
  if (claim.successorAllocationKey !== expectedAllocationKey ||
      claim.runId !== state.runId || claim.planId !== state.planId ||
      claim.taskId !== state.taskId || claim.unitId !== state.unitId ||
      claim.priorExecutionId !== state.executionId || claim.priorAttemptId !== state.attemptId ||
      claim.ownedResourceId !== state.ownedResourceId ||
      claim.sourceBindingDigest !== state.sourceBinding.digest ||
      claim.policyDigest !== state.policyDigest || claim.revision !== state.sourceBinding.revision ||
      claim.successorAttemptId === state.attemptId || state.status === "pending") {
    throw new Error("cooperative controller recovery successor claim is not bound to its prior allocation");
  }
  return claim;
}

function recoverySuccessorClaimFromState(state) {
  const value = state.recoverySuccessor === undefined ? null : state.recoverySuccessor;
  return value === null ? null : validateRecoverySuccessorClaim(value, state);
}

function recoverySuccessorStableFields(value) {
  const { claimedAt: _claimedAt, digest: _digest, ...stable } = value;
  return stable;
}

function assertNoRecoverySuccessor(state) {
  if (recoverySuccessorClaimFromState(state) !== null) {
    throw ownerApprovalError(
      "EOWNER_RECOVERY_SUPERSEDED",
      "the cooperative controller dispatch authority has been claimed by a fresh recovery successor"
    );
  }
}

function validateState(value, runId, allocationKey = undefined) {
  plain(value, "cooperative controller state");
  if (value.schemaVersion !== NATIVE_V3_COOPERATIVE_CONTROLLER_SCHEMA_VERSION ||
      value.kind !== NATIVE_V3_COOPERATIVE_CONTROLLER_KIND || value.runId !== runId) {
    throw new Error("cooperative controller state version/kind/run binding is invalid");
  }
  if (value.allocationKey !== undefined) {
    const persistedAllocationKey = normalizedAllocationKey(value.allocationKey, {
      taskId: value.taskId,
      attemptId: value.attemptId
    });
    if (allocationKey !== undefined && persistedAllocationKey !== allocationKey) {
      throw new Error("cooperative controller state allocation key does not match");
    }
  } else if (allocationKey !== undefined) {
    throw new Error("cooperative controller state is missing its task allocation key");
  }
  if (!["pending", "active", "revoked"].includes(value.status)) throw new Error("cooperative controller state status is invalid");
  id(value.planId, "cooperative controller state.planId");
  id(value.taskId, "cooperative controller state.taskId");
  id(value.unitId, "cooperative controller state.unitId");
  id(value.controllerId, "cooperative controller state.controllerId");
  if (value.trustMode !== NATIVE_V3_COOPERATIVE_TRUST_MODE) throw new Error("cooperative controller state trust mode is invalid");
  sourceBinding(value.sourceBinding, "cooperative controller state.sourceBinding");
  digest(value.policyDigest, "cooperative controller state.policyDigest");
  digest(value.planDigest, "cooperative controller state.planDigest");
  digest(value.contractDigest, "cooperative controller state.contractDigest");
  id(value.ownedResourceId, "cooperative controller state.ownedResourceId");
  id(value.nonce, "cooperative controller state.nonce");
  if (!Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1) throw new Error("cooperative controller state.authorityEpoch is invalid");
  digest(value.fence, "cooperative controller state.fence");
  id(value.incarnation, "cooperative controller state.incarnation");
  id(value.ownerLeaseId, "cooperative controller state.ownerLeaseId");
  plain(value.seals, "cooperative controller state.seals");
  if (Object.keys(value.seals).length > MAX_SEALS) throw new Error("cooperative controller seal limit exceeded");
  recoverySuccessorClaimFromState(value);
  const envelope = validateApprovalEnvelope(value.approvalEnvelope);
  const ownerRequest = validateOwnerApprovalRequest(value.ownerApprovalRequest, runId);
  if (ownerRequest.planId !== value.planId || ownerRequest.taskId !== value.taskId || ownerRequest.unitId !== value.unitId ||
      ownerRequest.executionId !== value.executionId || ownerRequest.attemptId !== value.attemptId ||
      ownerRequest.ownedResourceId !== value.ownedResourceId || ownerRequest.nonce !== value.nonce ||
      ownerRequest.planDigest !== value.planDigest || ownerRequest.contractDigest !== value.contractDigest ||
      ownerRequest.sourceBindingDigest !== value.sourceBinding.digest || ownerRequest.policyDigest !== value.policyDigest ||
      ownerRequest.revision !== value.sourceBinding.revision || ownerRequest.candidateDigest !== envelope.digest ||
      !same(ownerRequest.scope, envelope.scope)) {
    throw new Error("cooperative controller owner approval request is not bound to its envelope");
  }
  const launchReservation = value.launchReservation === undefined ? null : value.launchReservation;
  if (launchReservation !== null) {
    const checkedReservation = validateEffectLaunchReservation(launchReservation);
    if (!launchReservationMatchesState(checkedReservation, value)) {
      throw new Error("cooperative controller launch reservation is not bound to its allocation");
    }
    // Revocation advances the live epoch/fence while preserving the prior
    // launch reservation as append-only evidence of the earlier boundary.
    // An active state must still match exactly; a revoked state may carry the
    // reservation's pre-revocation epoch/fence.
    if (value.status !== "revoked" &&
        (checkedReservation.authorityEpoch !== value.authorityEpoch || checkedReservation.fence !== value.fence)) {
      throw new Error("cooperative controller launch reservation authority is stale");
    }
  }
  const launchAuthorization = value.launchAuthorization === undefined ? null : value.launchAuthorization;
  if (launchAuthorization !== null) {
    const checkedAuthorization = validateEffectLaunchAuthorization(launchAuthorization);
    if (launchReservation === null || checkedAuthorization.reservationId !== launchReservation.reservationId ||
        checkedAuthorization.reservationDigest !== launchReservation.digest ||
        checkedAuthorization.effectBindingDigest !== launchReservation.effectBindingDigest ||
        checkedAuthorization.runId !== launchReservation.runId ||
        checkedAuthorization.executionId !== launchReservation.executionId ||
        checkedAuthorization.attemptId !== launchReservation.attemptId ||
        checkedAuthorization.unitId !== launchReservation.unitId ||
        checkedAuthorization.ownedResourceId !== launchReservation.ownedResourceId) {
      throw new Error("cooperative controller launch authorization is not bound to its reservation");
    }
    // Revocation advances the live epoch/fence while retaining authorization
    // as append-only evidence of the prior linearization boundary.
    if (value.status !== "revoked" &&
        (checkedAuthorization.authorityEpoch !== value.authorityEpoch || checkedAuthorization.fence !== value.fence)) {
        throw new Error("cooperative controller launch authorization authority is stale");
    }
  }
  const launchCommitment = value.launchCommitment === undefined ? null : value.launchCommitment;
  if (launchCommitment !== null) {
    const checkedCommitment = validateEffectLaunchCommitment(launchCommitment);
    if (!launchCommitmentMatchesState(checkedCommitment, value, launchAuthorization)) {
      throw new Error("cooperative controller launch commitment is not bound to its authorization");
    }
    // Revocation advances the live epoch/fence while retaining the committed
    // launch as append-only evidence of the prior effect linearization.
    if (value.status !== "revoked" &&
        (checkedCommitment.authorityEpoch !== value.authorityEpoch || checkedCommitment.fence !== value.fence)) {
        throw new Error("cooperative controller launch commitment authority is stale");
    }
  }
  const launchTransaction = value.launchTransaction === undefined ? null : value.launchTransaction;
  if (launchTransaction !== null) {
    const checkedTransaction = validateEffectLaunchTransaction(launchTransaction);
    if (!launchTransactionMatchesState(checkedTransaction, value, launchAuthorization)) {
      throw new Error("cooperative controller launch transaction is not bound to its authorization");
    }
    if (launchCommitment !== null) {
      throw new Error("cooperative controller cannot retain both a launch transaction and commitment");
    }
    if (value.status !== "active") {
      throw new Error("cooperative controller launch transaction must remain active until it is resolved");
    }
  }
  const launchResolution = value.launchResolution === undefined ? null : value.launchResolution;
  if (launchResolution !== null) {
    const checkedResolution = validateEffectLaunchCleanupResolution(launchResolution);
    if (launchTransaction !== null || launchCommitment !== null ||
        !launchCleanupResolutionMatchesState(checkedResolution, value, launchAuthorization)) {
      throw new Error("cooperative controller launch cleanup resolution is not bound to its allocation");
    }
    if (value.status !== "active" && value.status !== "revoked") {
      throw new Error("cooperative controller launch cleanup resolution has an invalid state status");
    }
  }
  if (value.status === "pending" && launchReservation !== null) {
    throw new Error("pending cooperative controller cannot have an effect launch reservation");
  }
  if (value.status === "pending" && launchAuthorization !== null) {
    throw new Error("pending cooperative controller cannot have an effect launch authorization");
  }
  if (value.status === "pending" && launchCommitment !== null) {
    throw new Error("pending cooperative controller cannot have an effect launch commitment");
  }
  if (value.status === "pending" && launchTransaction !== null) {
    throw new Error("pending cooperative controller cannot have an effect launch transaction");
  }
  if (value.ownerApprovalDecision !== null) {
    validateDecisionAgainstRequest(value.ownerApprovalDecision, ownerRequest);
  }
  if (value.status === "pending") {
    if (value.capabilityId !== null || value.activationId !== null) throw new Error("pending cooperative controller cannot have active authority");
  }
  if (value.status === "active" || value.status === "revoked") {
    id(value.executionId, "cooperative controller state.executionId");
    id(value.attemptId, "cooperative controller state.attemptId");
    id(value.capabilityId, "cooperative controller state.capabilityId");
    if (!value.ownerApprovalDecision || value.ownerApprovalDecision.decision !== "approve" ||
        value.ownerApprovalDecision.status !== "consumed") {
      throw new Error("active cooperative controller requires a consumed owner approval decision");
    }
    id(value.activationId, "cooperative controller state.activationId");
  } else if (value.approvalEnvelope === null || value.approvalEnvelope === undefined) {
    throw new Error("pending cooperative controller requires its candidate envelope");
  }
  if (value.status === "revoked") {
    iso(value.revokedAt, "cooperative controller state.revokedAt");
    text(value.revocationReason, "cooperative controller state.revocationReason");
  } else if (value.revokedAt !== null || value.revocationReason !== null) {
    throw new Error("non-revoked cooperative controller cannot have revocation metadata");
  }
  return value;
}

function stateExpected(state) {
  return {
    planDigest: state.planDigest,
    contractDigest: state.contractDigest,
    sourceRevision: state.sourceBinding.revision,
    sourceDigest: state.sourceBinding.digest,
    policyDigest: state.policyDigest
  };
}

async function readFreshSource({
  sourceBinding: expected,
  readFreshSourceBinding,
  sourceCwd,
  runId,
  planId,
  clock,
  abortSignal = undefined,
  timeoutMs = FRESH_RESOLVER_TIMEOUT_MS
}) {
  let current;
  if (typeof readFreshSourceBinding === "function") {
    current = await runBoundedControllerOperation("fresh source binding resolver", () => readFreshSourceBinding({
        runId,
        planId,
        expected: clone(expected),
        observedAt: currentIso(clock)
      }), {
        signal: abortSignal,
        timeoutMs
    });
  } else if (typeof sourceCwd === "string" && sourceCwd.length > 0) {
    const captured = await runBoundedControllerOperation("fresh source capture", () => captureSourceBinding(path.resolve(sourceCwd), {
        baseRevision: expected.revision,
        requireClean: true
      }), {
        signal: abortSignal,
        timeoutMs
    });
    current = {
      revision: captured.headRevision ?? captured.revision,
      digest: captured.digest
    };
  } else {
    const error = new Error("Current source binding is required; pass readFreshSourceBinding or sourceCwd");
    error.code = "ESOURCE_FRESHNESS_UNAVAILABLE";
    error.status = "HOLD";
    throw error;
  }
  const normalized = sourceBinding(current, "fresh source binding");
  if (!same(normalized, expected)) {
    const error = new Error("Current source binding drifted from the approved V3 source");
    error.code = "ESOURCE_BINDING_DRIFT";
    error.status = "HOLD";
    throw error;
  }
  return normalized;
}

async function readFreshTrustPolicy({ readTrustPolicy, runId, planId, policyDigest: expectedPolicy, requestedTrustMode, clock, abortSignal = undefined, timeoutMs = FRESH_RESOLVER_TIMEOUT_MS }) {
  if (typeof readTrustPolicy !== "function") {
    const error = new Error("Trust grade is not available; inject a current trusted policy resolver");
    error.code = "EPOLICY_TRUST_UNRESOLVED";
    error.status = "HOLD";
    throw error;
  }
  const value = await runBoundedControllerOperation("fresh trust policy resolver", () => readTrustPolicy({
      runId,
      planId,
      policyDigest: expectedPolicy,
      requestedTrustMode,
      observedAt: currentIso(clock)
    }), {
      signal: abortSignal,
      timeoutMs
  });
  plain(value, "fresh trust policy");
  if (value.policyDigest !== expectedPolicy || !["cooperative-user-mode", "host-attested"].includes(value.requiredTrustMode)) {
    const error = new Error("Fresh trust policy is missing or bound to a different policy digest");
    error.code = "EPOLICY_TRUST_DRIFT";
    error.status = "HOLD";
    throw error;
  }
  if (value.requiredTrustMode !== requestedTrustMode) holdHostTrust("The authoritative policy requires a different trust mode");
  return { policyDigest: value.policyDigest, requiredTrustMode: value.requiredTrustMode };
}

async function readFreshPlan({ root, planId, expected, sourceBinding: expectedSource, policyDigest: expectedPolicy, readFreshSourceBinding, sourceCwd, readTrustPolicy, requestedTrustMode, runId, clock, abortSignal = undefined, timeoutMs = FRESH_RESOLVER_TIMEOUT_MS }) {
  await readFreshTrustPolicy({ readTrustPolicy, runId, planId, policyDigest: expectedPolicy, requestedTrustMode, clock, abortSignal, timeoutMs });
  const currentSource = await readFreshSource({
    sourceBinding: expectedSource,
    readFreshSourceBinding,
    sourceCwd,
    runId,
    planId,
    clock,
    abortSignal,
    timeoutMs
  });
  if (abortSignal?.aborted) throw boundedFailure("EOWNER_LOCK_ABORTED", "fresh plan read was aborted before validation");
  const plan = await readFreshWorkflowPlanV1({ root, planId, expected: {
    ...expected,
    sourceRevision: currentSource.revision,
    sourceDigest: currentSource.digest,
    policyDigest: expectedPolicy
  } });
  if (plan.taskContract.bindings.source.revision !== currentSource.revision ||
      plan.taskContract.bindings.source.digest !== currentSource.digest ||
      plan.taskContract.bindings.policy.digest !== expectedPolicy) {
    throw new Error("Fresh V3 plan source or policy binding does not match the controller request");
  }
  return { plan, sourceBinding: currentSource };
}

async function assertAutoEffectAdmissionForState(root, state) {
  const plan = await readFreshWorkflowPlanV1({
    root,
    planId: state.planId,
    expected: stateExpected(state)
  });
  assertNativeV3AutoCommandExecutionAllowed(plan);
}

function taskFor(plan, taskId) {
  const task = plan.taskContract.graph.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`V3 task is not present in the plan: ${taskId}`);
  return task;
}

function validateEnvelopeForPlan({ envelope, plan, runId, taskId, unitId, recipient, action, requestedModel, source, clock }) {
  const task = taskFor(plan, taskId);
  const checks = [
    ["runId", envelope.runId, runId],
    ["taskId", envelope.taskId, taskId],
    ["unitId", envelope.unitId, unitId],
    ["planDigest", envelope.planDigest, plan.planDigest],
    ["contractDigest", envelope.contractDigest, plan.contractDigest],
    ["sourceBindingDigest", envelope.sourceBindingDigest, source.digest],
    ["policyDigest", envelope.policyDigest, plan.taskContract.bindings.policy.digest],
    ["revision", envelope.revision, source.revision]
  ];
  for (const [label, actual, expected] of checks) if (actual !== expected) throw new Error(`ApprovalEnvelope.${label} is not bound to the fresh V3 plan`);
  if (!same(envelope.scope, plan.taskContract.scope)) throw new Error("ApprovalEnvelope.scope is not bound to the V3 contract scope");
  if (!same(envelope.budget, task.budget)) throw new Error("ApprovalEnvelope.budget is not bound to the V3 task budget");
  if (recipient !== undefined && envelope.recipient !== recipient) throw new Error("ApprovalEnvelope.recipient differs from the requested action");
  if (action !== undefined && envelope.action !== action) throw new Error("ApprovalEnvelope.action differs from the requested action");
  if (requestedModel !== undefined && envelope.requestedModel !== requestedModel) throw new Error("ApprovalEnvelope.requestedModel differs from the requested model");
  if (Date.parse(envelope.expiresAt) <= currentDate(clock).getTime()) throw new Error("ApprovalEnvelope has expired");
  return task;
}

function runContract(runId, plan) {
  const source = plan.taskContract.bindings.source;
  return {
    schemaVersion: 3,
    kind: "RunContractV3",
    runId,
    status: "active",
    plan: clone(plan),
    planDigest: plan.planDigest,
    contractDigest: plan.contractDigest,
    taskContract: plan.taskContract,
    revision: source.revision,
    sourceBindingDigest: source.digest,
    policyDigest: plan.taskContract.bindings.policy.digest
  };
}

function bindingFromState(state) {
  return {
    runId: state.runId,
    executionId: state.executionId,
    attemptId: state.attemptId,
    unitId: state.unitId,
    sourceBindingDigest: state.sourceBinding.digest,
    policyDigest: state.policyDigest,
    revision: state.sourceBinding.revision,
    ownedResourceId: state.ownedResourceId
  };
}

function assertRequestMatchesState(request, state) {
  plain(request, "execution binding");
  for (const key of ["runId", "executionId", "attemptId", "unitId", "sourceBindingDigest", "policyDigest", "revision", "ownedResourceId"]) {
    if (request[key] !== bindingFromState(state)[key]) throw new Error(`Execution binding.${key} does not match the cooperative controller state`);
  }
}

function capabilityFor(state) {
  const envelope = validateApprovalEnvelope(state.approvalEnvelope);
  const unsigned = {
    schemaVersion: 1,
    kind: ACTION_CAPABILITY_KIND,
    capabilityId: state.capabilityId,
    envelopeDigest: envelope.digest,
    runId: envelope.runId,
    executionId: envelope.executionId,
    attemptId: envelope.attemptId,
    ownedResourceId: envelope.ownedResourceId,
    planDigest: envelope.planDigest,
    contractDigest: envelope.contractDigest,
    sourceBindingDigest: envelope.sourceBindingDigest,
    policyDigest: envelope.policyDigest,
    revision: envelope.revision,
    taskId: envelope.taskId,
    unitId: envelope.unitId,
    scope: envelope.scope,
    recipient: envelope.recipient,
    action: envelope.action,
    budget: envelope.budget,
    expiresAt: envelope.expiresAt,
    nonce: envelope.nonce,
    authorityEpoch: state.authorityEpoch,
    fence: state.fence,
    ...(Object.hasOwn(envelope, "requestedModel") ? { requestedModel: envelope.requestedModel } : {})
  };
  const capabilityDigest = digestActionCapability(unsigned);
  return { ...unsigned, digest: capabilityDigest };
}

function authorityFor(state) {
  const envelope = validateApprovalEnvelope(state.approvalEnvelope);
  const capability = validateActionCapability(capabilityFor(state));
  return {
    kind: "TrustedExecutionAuthorityV1",
    status: "active",
    revoked: false,
    ...bindingFromState(state),
    authorityEpoch: state.authorityEpoch,
    fence: state.fence,
    capabilityDigest: digestActionCapability(capability),
    envelopeDigest: envelope.digest,
    expiresAt: envelope.expiresAt,
    envelope,
    capability,
    planDigest: envelope.planDigest,
    contractDigest: envelope.contractDigest,
    nonce: envelope.nonce,
    controllerId: state.controllerId,
    trustMode: NATIVE_V3_COOPERATIVE_TRUST_MODE
  };
}

const STOP_SCOPE_KEYS = ["runId", "executionId", "attemptId", "unitId", "ownedResourceId"];

function stopScopeFromState(state) {
  return {
    runId: state.runId,
    executionId: state.executionId,
    attemptId: state.attemptId,
    unitId: state.unitId,
    ownedResourceId: state.ownedResourceId
  };
}

function assertStopRequestMatchesState(request, state) {
  plain(request, "stop authority request");
  const actualKeys = Object.keys(request).sort();
  const expectedKeys = [...STOP_SCOPE_KEYS].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("stop authority request must contain only the owned five-field scope");
  }
  const scope = stopScopeFromState(state);
  for (const key of STOP_SCOPE_KEYS) {
    id(request[key], `stop authority request.${key}`);
    if (request[key] !== scope[key]) throw new Error(`Stop authority request.${key} does not match the persisted allocation`);
  }
  return scope;
}

function stopProjectionFor(state) {
  const approval = validateApprovalEnvelope(state.approvalEnvelope);
  const scope = stopScopeFromState(state);
  for (const key of STOP_SCOPE_KEYS) {
    if (approval[key] !== scope[key]) throw new Error(`Approved allocation.${key} is not bound to the persisted stop scope`);
  }
  if (approval.nonce !== state.nonce || approval.digest !== state.approvalEnvelope.digest) {
    throw new Error("Approved allocation nonce or approval digest is not bound to the persisted controller state");
  }

  // This is deliberately a stop projection, rather than the dispatch
  // authority.  It binds only the durable approved allocation and therefore
  // remains usable for emergency stop after dispatch freshness or expiry has
  // changed.  The complete local allocation identity is included in both
  // digest materials so neither digest can be transplanted between states.
  const allocation = {
    schemaVersion: 1,
    kind: "CooperativeNativeV3OwnedAllocationV1",
    ...scope,
    controllerId: state.controllerId,
    incarnation: state.incarnation,
    ownerLeaseId: state.ownerLeaseId,
    capabilityId: state.capabilityId,
    nonce: state.nonce,
    authorityEpoch: state.authorityEpoch,
    fence: state.fence,
    approvalEnvelopeDigest: approval.digest
  };
  const envelopeBody = {
    schemaVersion: 1,
    kind: "CooperativeNativeV3StopEnvelopeV1",
    scope,
    allocation
  };
  const envelopeDigest = digestObject(envelopeBody);
  const envelope = { ...envelopeBody, digest: envelopeDigest };
  const capability = {
    schemaVersion: 1,
    kind: "CooperativeNativeV3StopCapabilityV1",
    scope,
    allocation,
    envelopeDigest
  };
  const capabilityDigest = digestObject(capability);
  return {
    kind: "TrustedStopAuthorityV1",
    status: "active",
    revoked: false,
    ...scope,
    capabilityDigest,
    envelopeDigest,
    envelope
  };
}

function authorityRequestFields(value) {
  return ["runId", "executionId", "attemptId", "unitId", "ownedResourceId", "sourceBindingDigest", "policyDigest", "revision"]
    .map((key) => [key, value[key]]);
}

async function cooperativeAuthorityAttestation({ root, runId, allocationKey, controllerId, request, authority, authorityDigest, storageScope = undefined }) {
  const state = validateState(await readJson(root, pathFor(root, runId, allocationKey)), runId, allocationKey);
  validateRecoveryState(state, runId, allocationKey, storageScope);
  if (state.status !== "active" || state.controllerId !== controllerId) throw new Error("Cooperative authority is not active at the local controller boundary");
  // Recovery controllers may continue to expose non-authority observations,
  // but their trusted authority attestation must close the race where a
  // successor is claimed after readAuthority() starts and before verification.
  assertNoRecoverySuccessor(state);
  assertRequestMatchesState(request, state);
  for (const [key, value] of authorityRequestFields(authority)) {
    if (value !== bindingFromState(state)[key]) throw new Error(`Cooperative authority.${key} drifted`);
  }
  const envelope = validateApprovalEnvelope(authority.envelope);
  const capability = validateActionCapability(authority.capability);
  if (authority.envelopeDigest !== envelope.digest || authority.capabilityDigest !== digestActionCapability(capability) ||
      envelope.digest !== state.approvalEnvelope.digest || authority.authorityEpoch !== state.authorityEpoch || authority.fence !== state.fence ||
      capability.envelopeDigest !== envelope.digest || capability.authorityEpoch !== state.authorityEpoch || capability.fence !== state.fence) {
    throw new Error("Cooperative authority is not bound to the current local allocation");
  }
  if (digestObject(authority) !== authorityDigest) throw new Error("Cooperative authority digest mismatch");
  return { kind: "TrustedControllerAttestationV1", controllerId, authorityDigest };
}

async function cooperativeStopAuthorityAttestation({ root, runId, allocationKey, controllerId, request, authority, authorityDigest, storageScope = undefined }) {
  const state = validateState(await readJson(root, pathFor(root, runId, allocationKey)), runId, allocationKey);
  validateRecoveryState(state, runId, allocationKey, storageScope);
  if (!["active", "revoked"].includes(state.status) || state.controllerId !== controllerId) throw new Error("Cooperative stop authority is not active at the local controller boundary");
  assertStopRequestMatchesState(request, state);
  const expected = stopProjectionFor(state);
  if (!same(authority, expected)) throw new Error("Cooperative stop authority is not bound to the current local allocation");
  if (digestObject(authority) !== authorityDigest) throw new Error("Cooperative stop authority digest mismatch");
  return { kind: "TrustedControllerAttestationV1", controllerId, authorityDigest };
}

const ADMISSION_SEAL_READ_KEYS = [
  "runId", "handleId", "intentId", "admissionDigest", "authorityEpoch", "fence", "outcome", "effectDigest"
];

async function cooperativeSealObservation({ root, runId, allocationKey, controllerId, request, storageScope = undefined }) {
  plain(request, "cooperative admission seal read request");
  exactKeys(request, ADMISSION_SEAL_READ_KEYS, "cooperative admission seal read request");
  if (request.runId !== runId) throw ownerApprovalError("EOWNER_SEAL_BINDING", "admission seal runId changed");
  const intentId = id(request.intentId, "cooperative admission seal read request.intentId");
  const persisted = await readSealStateIfPresentReadOnly(root, runId, allocationKey);
  const state = storageScope === undefined
    ? validateState(persisted, runId, allocationKey)
    : validateRecoveryState(persisted, runId, allocationKey, storageScope);
  if (state.controllerId !== controllerId || state.allocationKey !== allocationKey ||
      !["active", "revoked"].includes(state.status)) {
    throw ownerApprovalError("EOWNER_SEAL_BINDING", "admission seal controller allocation changed");
  }
  const stored = Object.hasOwn(state.seals, intentId) ? state.seals[intentId] : null;
  if (!stored) throw ownerApprovalError("EOWNER_SEAL_UNAVAILABLE", "exact durable admission seal is unavailable");
  return clone(validateTrustedAdmissionSeal(stored, request));
}

async function cooperativeSealAttestation({ root, runId, allocationKey, controllerId, request, result, commitDigest, storageScope = undefined }) {
  const persisted = await readSealStateReadOnly(root, runId, allocationKey);
  const state = storageScope === undefined
    ? validateState(persisted, runId, allocationKey)
    : validateRecoveryState(persisted, runId, allocationKey, storageScope);
  if (state.controllerId !== controllerId || state.allocationKey !== allocationKey ||
      !["active", "revoked"].includes(state.status)) {
    throw new Error("Cooperative seal controller identity or allocation changed");
  }
  validateTrustedAdmissionSeal(result, {
    runId: request.runId,
    handleId: request.handleId,
    intentId: request.intentId,
    admissionDigest: request.admissionDigest,
    authorityEpoch: request.authorityEpoch,
    fence: request.fence,
    outcome: request.outcome,
    effectDigest: request.effectDigest
  });
  const stored = Object.hasOwn(state.seals, request.intentId) ? state.seals[request.intentId] : null;
  if (!stored || !same(stored, result)) throw new Error("Cooperative admission seal is not the durable CAS result");
  if (digestObject(result) !== commitDigest) throw new Error("Cooperative admission seal digest mismatch");
  return { kind: "TrustedAdmissionSealAttestationV1", controllerId, commitDigest };
}

async function readActiveState(root, runId, allocationKey = undefined) {
  const state = validateState(await readStateIfPresent(root, runId, allocationKey), runId, allocationKey);
  if (state.status !== "active") throw new Error("Cooperative controller is awaiting explicit human approval");
  assertNoRecoverySuccessor(state);
  return state;
}

async function readOwnedStopState(root, runId, allocationKey = undefined) {
  const state = validateState(await readStateIfPresent(root, runId, allocationKey), runId, allocationKey);
  if (!["active", "revoked"].includes(state.status)) {
    throw new Error("Cooperative controller has no approved owned allocation to stop");
  }
  return state;
}

function recoveryStorageScope(value, allocationKey) {
  if (value === undefined) {
    if (allocationKey !== undefined) return NATIVE_V3_RECOVERY_STORAGE_ALLOCATION;
    throw ownerApprovalError(
      "EOWNER_RECOVERY_SCOPE",
      "Base recovery requires explicit recoveryStorage:'base-single-task'"
    );
  }
  if (value !== NATIVE_V3_RECOVERY_STORAGE_BASE && value !== NATIVE_V3_RECOVERY_STORAGE_ALLOCATION) {
    throw ownerApprovalError("EOWNER_RECOVERY_SCOPE", "recoveryStorage must select base-single-task or task-allocation");
  }
  if (value === NATIVE_V3_RECOVERY_STORAGE_BASE && allocationKey !== undefined) {
    throw ownerApprovalError("EOWNER_RECOVERY_SCOPE", "base-single-task recovery cannot include an allocationKey");
  }
  if (value === NATIVE_V3_RECOVERY_STORAGE_ALLOCATION && allocationKey === undefined) {
    throw ownerApprovalError("EOWNER_RECOVERY_SCOPE", "task-allocation recovery requires its exact allocationKey");
  }
  return value;
}

function validateRecoveryState(value, runId, allocationKey, storageScope) {
  const state = validateState(value, runId, allocationKey);
  const hasAllocationKey = state.allocationKey !== undefined;
  if (storageScope === NATIVE_V3_RECOVERY_STORAGE_BASE && hasAllocationKey) {
    throw ownerApprovalError("EOWNER_RECOVERY_SCOPE", "base-single-task recovery resolved an allocation-backed state");
  }
  if (storageScope === NATIVE_V3_RECOVERY_STORAGE_ALLOCATION && !hasAllocationKey) {
    throw ownerApprovalError("EOWNER_RECOVERY_SCOPE", "task-allocation recovery resolved the base controller state");
  }
  return state;
}

async function readActiveRecoveryState(root, runId, allocationKey, storageScope) {
  const state = validateRecoveryState(
    await readStateIfPresent(root, runId, allocationKey),
    runId,
    allocationKey,
    storageScope
  );
  if (state.status !== "active") throw new Error("Cooperative controller is awaiting explicit human approval");
  return state;
}

function holdHostTrust(reason = "host-attested controller is required") {
  const error = new Error(reason);
  error.code = NATIVE_V3_COOPERATIVE_HOLD_CODE;
  error.status = "HOLD";
  error.reason = reason;
  throw error;
}

function requireCooperativeMode(trustMode) {
  if (trustMode !== NATIVE_V3_COOPERATIVE_TRUST_MODE) holdHostTrust("Only explicit cooperative-user-mode is implemented by this adapter");
}

function candidateEnvelope({ plan, runId, taskId, unitId, executionId, attemptId, recipient, action, requestedModel, expiresAt, ownedResourceId = undefined }) {
  const task = taskFor(plan, taskId);
  const source = plan.taskContract.bindings.source;
  const unsigned = {
    schemaVersion: 1,
    kind: APPROVAL_ENVELOPE_KIND,
    envelopeId: allocationToken("approval"),
    runId,
    executionId,
    attemptId,
    ownedResourceId: ownedResourceId ?? allocationToken("resource"),
    planDigest: plan.planDigest,
    contractDigest: plan.contractDigest,
    sourceBindingDigest: source.digest,
    policyDigest: plan.taskContract.bindings.policy.digest,
    revision: source.revision,
    taskId,
    unitId,
    scope: plan.taskContract.scope,
    recipient,
    action,
    budget: task.budget,
    expiresAt,
    nonce: allocationToken("nonce"),
    ...(requestedModel === undefined ? {} : { requestedModel })
  };
  const digestValue = digestObject(unsigned);
  return validateApprovalEnvelope({ ...unsigned, digest: digestValue });
}

function checkRequiredOption(value, label) {
  return text(value, label, ID);
}

const COMMON_CONTROLLER_OPTIONS = [
  "stateRoot", "runId", "planId", "taskId", "unitId", "executionId", "attemptId",
  "recipient", "action", "requestedModel", "sourceBinding", "policyDigest", "trustMode",
  "readFreshSourceBinding", "sourceCwd", "readTrustPolicy", "requestedTrustMode", "clock", "allocationKey",
  "freshResolverTimeoutMs"
];

function ownerInteractionDeadline(request, clock) {
  const remaining = Date.parse(request.expiresAt) - currentDate(clock).getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw ownerApprovalError("EOWNER_INTERACTION_EXPIRED", "The cooperative owner approval request has expired");
  }
  return Math.min(remaining, MAX_OWNER_INTERACTION_MS);
}

async function readCooperativeOwnerDecisionFromTTY(request, clock, ownerAbortSignal) {
  if (ownerAbortSignal?.aborted) {
    throw ownerApprovalError("EOWNER_INTERACTION_CANCELLED", "Cooperative owner approval was cancelled before the TTY interaction started");
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw ownerApprovalError("EOWNER_INTERACTION_NONINTERACTIVE", "Cooperative owner approval requires an interactive TTY");
  }
  if (process.stdin.destroyed === true) {
    throw ownerApprovalError("EOWNER_INTERACTION_EOF", "Cooperative owner approval input ended before the TTY interaction started");
  }
  const remaining = ownerInteractionDeadline(request, clock);
  const prompt = [
    "Native V3 action requires your explicit approval.",
    `Plan: ${request.planId}`,
    `Task: ${request.taskId}`,
    `Source revision: ${request.revision}`,
    `Scope: ${JSON.stringify(request.scope)}`,
    `Action: ${request.action}`,
    `Recipient: ${request.recipient}`,
    `Budget: ${JSON.stringify(request.budget)}`,
    `Candidate digest: ${request.candidateDigest}`,
    `Effect binding digest: ${request.effectBindingDigest}`,
    `Expires: ${request.expiresAt}`,
    "Type approve or reject: "
  ].join("\n");
  let terminal = null;
  const abort = new AbortController();
  let timer;
  let inputEnded = false;
  let ownerCancelled = false;
  let onInputEnd = () => {};
  let cleanupInputEnd = () => {};
  const inputEnd = new Promise((_, reject) => {
    let ended = false;
    onInputEnd = () => {
      if (ended) return;
      ended = true;
      inputEnded = true;
      reject(ownerApprovalError("EOWNER_INTERACTION_EOF", "Cooperative owner approval input ended before a decision"));
    };
    process.stdin.once("end", onInputEnd);
    process.stdin.once("close", onInputEnd);
    cleanupInputEnd = () => {
      process.stdin.removeListener("end", onInputEnd);
      process.stdin.removeListener("close", onInputEnd);
    };
  });
  let cleanupOwnerAbort = () => {};
  const ownerCancellation = new Promise((_, reject) => {
    if (!ownerAbortSignal) return;
    const onAbort = () => {
      if (ownerCancelled) return;
      ownerCancelled = true;
      reject(ownerApprovalError("EOWNER_INTERACTION_CANCELLED", "Cooperative owner approval was cancelled before a decision"));
    };
    ownerAbortSignal.addEventListener("abort", onAbort, { once: true });
    cleanupOwnerAbort = () => ownerAbortSignal.removeEventListener("abort", onAbort);
    if (ownerAbortSignal.aborted) onAbort();
  });
  ownerCancellation.catch(() => {});
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(ownerApprovalError("EOWNER_INTERACTION_TIMEOUT", "Cooperative owner approval interaction timed out"));
    }, remaining);
  });
  try {
    // The abort listener and the input listeners are installed before the
    // readline interface.  Recheck both cancellation sources immediately
    // after the interface is attached so a signal/closed stream cannot be
    // lost in the setup race.
    if (ownerAbortSignal?.aborted) {
      throw ownerApprovalError("EOWNER_INTERACTION_CANCELLED", "Cooperative owner approval was cancelled before the TTY interaction started");
    }
    terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (ownerAbortSignal?.aborted) {
      throw ownerApprovalError("EOWNER_INTERACTION_CANCELLED", "Cooperative owner approval was cancelled before a decision");
    }
    if (process.stdin.destroyed === true) onInputEnd();
    return (await Promise.race([
      terminal.question(prompt, { signal: abort.signal }),
      inputEnd,
      ownerCancellation,
      deadline
    ])).trim().toLowerCase();
  } catch (error) {
    if (ownerCancelled) throw error;
    if (inputEnded) throw error;
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
      throw ownerApprovalError("EOWNER_INTERACTION_TIMEOUT", "Cooperative owner approval interaction timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    cleanupInputEnd();
    cleanupOwnerAbort();
    abort.abort();
    terminal?.close();
  }
}

/** Record one explicit decision from the code-owned process TTY interaction. */
export async function collectCooperativeNativeV3OwnerDecision(options = {}) {
  rejectUnknownOptions(options, ["stateRoot", "runId", "taskId", "attemptId", "allocationKey", "requestDigest", "clock", "abortSignal"], "collectCooperativeNativeV3OwnerDecision options");
  const root = resolveRoot(options.stateRoot);
  const runId = checkRequiredOption(options.runId, "runId");
  const taskId = options.taskId === undefined ? undefined : checkRequiredOption(options.taskId, "taskId");
  const attemptId = options.attemptId === undefined ? undefined : checkRequiredOption(options.attemptId, "attemptId");
  if (options.allocationKey !== undefined && (taskId === undefined || attemptId === undefined)) {
    throw ownerApprovalError("EOWNER_APPROVAL_INPUT", "taskId and attemptId are required with allocationKey");
  }
  const allocationKey = normalizedAllocationKey(options.allocationKey, { taskId, attemptId });
  const requestedDigest = digest(options.requestDigest, "requestDigest");
  const abortSignal = validateAbortSignal(options.abortSignal, "collectCooperativeNativeV3OwnerDecision.abortSignal");
  if (abortSignal?.aborted) {
    throw ownerApprovalError("EOWNER_INTERACTION_CANCELLED", "Cooperative owner approval was cancelled before the TTY interaction started");
  }
  const before = await readStateIfPresent(root, runId, allocationKey);
  if (!before) throw ownerApprovalError("EOWNER_APPROVAL_REQUIRED", "The cooperative owner approval request is absent");
  const beforeState = validateState(before, runId, allocationKey);
  if (beforeState.status !== "pending") {
    throw ownerApprovalError("EOWNER_APPROVAL_REPLAY", "The cooperative owner approval request is no longer pending");
  }
  const request = validateOwnerApprovalRequest(beforeState.ownerApprovalRequest, runId);
  if (request.requestDigest !== requestedDigest) {
    throw ownerApprovalError("EOWNER_APPROVAL_REQUEST_MISMATCH", "The requested owner approval digest does not match the pending request");
  }
  let answer;
  try {
    answer = await readCooperativeOwnerDecisionFromTTY(request, options.clock, abortSignal);
  } catch (error) {
    if (error?.code === "EOWNER_INTERACTION_NONINTERACTIVE" || error?.code === "EOWNER_INTERACTION_CANCELLED") throw error;
    const wrapped = ownerApprovalError("EOWNER_INTERACTION_FAILED", "The cooperative owner interaction failed");
    wrapped.cause = error;
    throw wrapped;
  }
  if (answer !== "approve" && answer !== "reject") {
    throw ownerApprovalError("EOWNER_INTERACTION_INVALID", "The cooperative owner interaction must return approve or reject");
  }
  if (abortSignal?.aborted) {
    throw ownerApprovalError("EOWNER_INTERACTION_CANCELLED", "Cooperative owner approval was cancelled before its decision could be persisted");
  }
  const decision = ownerDecisionFor(request, answer, currentIso(options.clock));
  return withStateLock(root, runId, async () => {
    if (abortSignal?.aborted) {
      throw ownerApprovalError("EOWNER_INTERACTION_CANCELLED", "Cooperative owner approval was cancelled before its decision could be persisted");
    }
    const currentValue = await readStateIfPresent(root, runId, allocationKey);
    if (!currentValue) throw ownerApprovalError("EOWNER_APPROVAL_REQUIRED", "The cooperative owner approval request disappeared");
    const current = validateState(currentValue, runId, allocationKey);
    if (current.status !== "pending" || current.ownerApprovalRequest.requestDigest !== requestedDigest) {
      throw ownerApprovalError("EOWNER_APPROVAL_REPLAY", "The cooperative owner approval request changed while awaiting the owner");
    }
    if (current.ownerApprovalDecision !== null) {
      throw ownerApprovalError("EOWNER_APPROVAL_REPLAY", "The cooperative owner approval request already has a decision");
    }
    const expectedStateDigest = digestObject(current);
    if (abortSignal?.aborted) {
      throw ownerApprovalError("EOWNER_INTERACTION_CANCELLED", "Cooperative owner approval was cancelled before its decision could be persisted");
    }
    const bound = validateDecisionAgainstRequest(decision, current.ownerApprovalRequest);
    const persistedAt = currentIso(options.clock);
    if (Date.parse(persistedAt) >= Date.parse(current.ownerApprovalRequest.expiresAt)) {
      throw ownerApprovalError("EOWNER_INTERACTION_EXPIRED", "The cooperative owner approval request expired before its decision could be persisted");
    }
    current.ownerApprovalDecision = bound;
    current.updatedAt = persistedAt;
    await writeState(root, runId, current, allocationKey, {
      expectedStateDigest,
      signal: abortSignal
    });
    return mintOwnerDecisionHandle(bound);
  }, allocationKey);
}

export async function prepareCooperativeNativeV3Approval(options = {}) {
  rejectUnknownOptions(options, [...COMMON_CONTROLLER_OPTIONS, "effectBindingDigest", "expiresAt", "priorAttemptId", "priorAllocationKey", "priorRecoveryStorage"], "prepareCooperativeNativeV3Approval options");
  requireCooperativeMode(options.trustMode);
  const root = resolveRoot(options.stateRoot);
  const runId = checkRequiredOption(options.runId, "runId");
  const planId = checkRequiredOption(options.planId, "planId");
  const taskId = checkRequiredOption(options.taskId, "taskId");
  const unitId = checkRequiredOption(options.unitId, "unitId");
  const executionId = checkRequiredOption(options.executionId, "executionId");
  const attemptId = checkRequiredOption(options.attemptId, "attemptId");
  const allocationKey = normalizedAllocationKey(options.allocationKey, { taskId, attemptId });
  const priorAttemptId = options.priorAttemptId === undefined ? undefined : checkRequiredOption(options.priorAttemptId, "priorAttemptId");
  if (options.priorAllocationKey !== undefined && priorAttemptId === undefined) {
    throw ownerApprovalError("EOWNER_APPROVAL_INPUT", "priorAttemptId is required with priorAllocationKey");
  }
  if (options.priorRecoveryStorage !== undefined && priorAttemptId === undefined) {
    throw ownerApprovalError("EOWNER_APPROVAL_INPUT", "priorAttemptId is required with priorRecoveryStorage");
  }
  const priorAllocationKey = normalizedAllocationKey(options.priorAllocationKey, { taskId, attemptId: priorAttemptId });
  const priorRecoveryStorage = priorAttemptId === undefined
    ? undefined
    : recoveryStorageScope(options.priorRecoveryStorage, priorAllocationKey);
  const claimPriorRecovery = options.priorRecoveryStorage !== undefined;
  if (priorAttemptId !== undefined && priorAttemptId === attemptId) {
    throw ownerApprovalError("EOWNER_APPROVAL_INPUT", "recovery requires a fresh attemptId");
  }
  if (priorAttemptId !== undefined && allocationKey === undefined) {
    throw ownerApprovalError("EOWNER_APPROVAL_INPUT", "recovery successors require a fresh task allocation key");
  }
  const recipient = text(options.recipient, "recipient");
  const action = text(options.action, "action");
  const effectBindingDigest = digest(options.effectBindingDigest, "effectBindingDigest");
  const source = sourceBinding(options.sourceBinding);
  const policy = policyDigest(options.policyDigest);
  const freshResolverTimeoutMs = freshResolverTimeout(options.freshResolverTimeoutMs);
  const { plan } = await readFreshPlan({
    root,
    planId,
    runId,
    expected: {},
    sourceBinding: source,
    policyDigest: policy,
    readFreshSourceBinding: options.readFreshSourceBinding,
    sourceCwd: options.sourceCwd,
    readTrustPolicy: options.readTrustPolicy,
    requestedTrustMode: options.trustMode,
    clock: options.clock,
    timeoutMs: freshResolverTimeoutMs
  });
  assertNativeV3AutoCommandExecutionAllowed(plan);
  const requestedExpiresAt = options.expiresAt === undefined ? undefined : iso(options.expiresAt, "expiresAt");
  const expiresAt = requestedExpiresAt ?? futureIso(options.clock);
  if (Date.parse(expiresAt) <= currentDate(options.clock).getTime()) throw new Error("expiresAt must be in the future");
  const at = currentIso(options.clock);
  let prepared;
  const stateLocks = priorAttemptId === undefined ? [allocationKey] : [priorAllocationKey, allocationKey];
  await withOrderedStateLocks(root, runId, stateLocks, async () => {
    assertNativeV3AutoCommandExecutionAllowed(plan);
    const existingValue = await readStateIfPresent(root, runId, allocationKey);
    let existing = null;
    if (existingValue) {
      existing = validateState(existingValue, runId, allocationKey);
      if (existing.status !== "pending" || !ownerRequestMatchesPreparation(existing.ownerApprovalRequest, {
        plan,
        planId,
        runId,
        taskId,
        unitId,
        executionId,
        attemptId,
        recipient,
        action,
        requestedModel: options.requestedModel,
        source,
        policy,
        effectBindingDigest,
        expiresAt: requestedExpiresAt
      })) {
        throw new Error("A different cooperative controller allocation already exists for this run");
      }
    }
    let prior = null;
    if (priorAttemptId !== undefined) {
      const priorValue = await readStateIfPresent(root, runId, priorAllocationKey);
      if (!priorValue) throw ownerApprovalError("EOWNER_RECOVERY_BINDING", "the prior controller allocation is absent");
      prior = validateRecoveryState(priorValue, runId, priorAllocationKey, priorRecoveryStorage);
      const priorCleanupResolved = prior.status === "revoked" &&
        prior.launchTransaction === null && prior.launchCommitment === null &&
        prior.launchResolution !== null && prior.launchResolution.status === "cleanup-confirmed";
      if (!["active", "revoked"].includes(prior.status) || prior.taskId !== taskId || prior.unitId !== unitId || prior.attemptId !== priorAttemptId ||
          prior.planId !== planId || prior.sourceBinding.digest !== source.digest ||
          prior.sourceBinding.revision !== source.revision || prior.policyDigest !== policy ||
          prior.authorityEpoch >= Number.MAX_SAFE_INTEGER ||
          (prior.launchReservation !== null && prior.launchReservation !== undefined && !priorCleanupResolved)) {
        throw ownerApprovalError("EOWNER_RECOVERY_BINDING", "the prior controller allocation is not bound to this exact recovery request");
      }
      if (existing !== null && (existing.ownedResourceId !== prior.ownedResourceId ||
          existing.authorityEpoch !== prior.authorityEpoch + 1)) {
        throw ownerApprovalError("EOWNER_RECOVERY_BINDING", "the fresh controller allocation is not bound to the prior recovery authority");
      }
      if (claimPriorRecovery) {
        const stableClaim = {
          schemaVersion: 1,
          kind: NATIVE_V3_RECOVERY_SUCCESSOR_CLAIM_KIND,
          runId,
          planId,
          taskId,
          unitId,
          priorExecutionId: prior.executionId,
          priorAttemptId,
          successorExecutionId: executionId,
          successorAttemptId: attemptId,
          successorAllocationKey: allocationKey,
          ownedResourceId: prior.ownedResourceId,
          sourceBindingDigest: source.digest,
          policyDigest: policy,
          revision: source.revision,
          effectBindingDigest
        };
        const currentClaim = recoverySuccessorClaimFromState(prior);
        if (currentClaim !== null) {
          if (!same(recoverySuccessorStableFields(currentClaim), stableClaim)) {
            throw ownerApprovalError("EOWNER_RECOVERY_REPLAY", "the prior controller allocation is already claimed by a different recovery successor");
          }
        } else {
          const expectedStateDigest = digestObject(prior);
          const body = recoverySuccessorClaimBody({ ...stableClaim, claimedAt: at });
          prior.recoverySuccessor = { ...body, digest: digestObject(body) };
          prior.updatedAt = at;
          await writeState(root, runId, prior, priorAllocationKey, { expectedStateDigest });
        }
      }
    }
    if (existing !== null) {
      const candidate = validateApprovalEnvelope(existing.approvalEnvelope);
      prepared = {
        candidate,
        ownerApprovalRequest: clone(existing.ownerApprovalRequest),
        allocation: {
          ownedResourceId: existing.ownedResourceId,
          authorityEpoch: existing.authorityEpoch,
          fence: existing.fence,
          nonce: existing.nonce
        }
      };
      return;
    }
    const candidate = candidateEnvelope({
      plan,
      runId,
      taskId,
      unitId,
      executionId,
      attemptId,
      recipient,
      action,
      requestedModel: options.requestedModel,
      expiresAt,
      ownedResourceId: prior?.ownedResourceId
    });
    const ownerApprovalRequest = ownerApprovalRequestFor({
      plan,
      planId,
      candidate,
      effectBindingDigest,
      createdAt: at
    });
    let authorityEpoch = 1;
    if (prior) authorityEpoch = prior.authorityEpoch + 1;
    const allocation = {
      ownedResourceId: candidate.ownedResourceId,
      authorityEpoch,
      fence: allocationFence(runId, candidate.digest, at),
      nonce: candidate.nonce
    };
    await writeState(root, runId, {
      schemaVersion: 1,
      kind: NATIVE_V3_COOPERATIVE_CONTROLLER_KIND,
      status: "pending",
      trustMode: NATIVE_V3_COOPERATIVE_TRUST_MODE,
      runId,
      ...(allocationKey === undefined ? {} : { allocationKey }),
      planId,
      taskId,
      unitId,
      executionId,
      attemptId,
      sourceBinding: source,
      policyDigest: policy,
      planDigest: plan.planDigest,
      contractDigest: plan.contractDigest,
      controllerId: allocationToken("controller"),
      ownedResourceId: allocation.ownedResourceId,
      authorityEpoch: allocation.authorityEpoch,
      fence: allocation.fence,
      nonce: allocation.nonce,
      incarnation: allocationToken("incarnation"),
      ownerLeaseId: allocationToken("lease"),
      approvalEnvelope: candidate,
      ownerApprovalRequest,
      ownerApprovalDecision: null,
      // This durable, one-way marker records the launch candidate.  It is not
      // effect authorization: a supervisor must complete the second CAS
      // below before it can deliver a target launch frame.
      launchReservation: null,
      // Authorization is a second durable CAS after the supervisor has
      // announced its pending reservation.  Revocation can therefore win
      // after reservation but before any target frame is accepted.
      launchAuthorization: null,
      // The final commitment is persisted only after the lock-held launch
      // transaction receives the supervisor's exact spawn acknowledgement.
      // The supervisor is permitted to spawn only inside that transaction;
      // an acknowledgement or persistence failure remains unresolved.
      launchCommitment: null,
      // An append-only in-flight/unknown marker prevents revocation from
      // claiming success after a launch frame crossed the owned boundary but
      // its acknowledgement or durable commitment was lost.
      launchTransaction: null,
      // A cleanup-confirmed resolution keeps the original transaction and
      // effect boundary visible after the UNKNOWN is cleared.  It is never a
      // not-sent proof and cannot be reused for a later attempt.
      launchResolution: null,
      activationId: null,
      revokedAt: null,
      revocationReason: null,
      capabilityId: null,
      recoverySuccessor: null,
      seals: {},
      createdAt: at,
      updatedAt: at
    }, allocationKey, { expectAbsent: true });
    prepared = { candidate, ownerApprovalRequest, allocation };
  });
  return {
    status: "awaiting-human-approval",
    approvalEnvelope: clone(prepared.candidate),
    ownerApprovalRequest: clone(prepared.ownerApprovalRequest),
    allocation: clone(prepared.allocation)
  };
}

/** Revoke dispatch authority while preserving the approved allocation for stop. */
export async function revokeCooperativeNativeV3Controller(options = {}) {
  rejectUnknownOptions(options, ["stateRoot", "runId", "taskId", "attemptId", "allocationKey", "expectedEpoch", "expectedFence", "reason", "clock"], "revokeCooperativeNativeV3Controller options");
  const root = resolveRoot(options.stateRoot);
  const runId = checkRequiredOption(options.runId, "runId");
  const taskId = options.taskId === undefined ? undefined : checkRequiredOption(options.taskId, "taskId");
  const attemptId = options.attemptId === undefined ? undefined : checkRequiredOption(options.attemptId, "attemptId");
  if (options.allocationKey !== undefined && (taskId === undefined || attemptId === undefined)) {
    throw ownerApprovalError("EOWNER_REVOCATION_INPUT", "taskId and attemptId are required with allocationKey");
  }
  const allocationKey = normalizedAllocationKey(options.allocationKey, { taskId, attemptId });
  if (!Number.isSafeInteger(options.expectedEpoch) || options.expectedEpoch < 1) {
    throw new Error("expectedEpoch is invalid");
  }
  const expectedFence = digest(options.expectedFence, "expectedFence");
  const reason = text(options.reason, "reason");
  const at = currentIso(options.clock);
  let receipt;
  await withStateLock(root, runId, async () => {
    const currentValue = await readStateIfPresent(root, runId, allocationKey);
    if (!currentValue) throw ownerApprovalError("EALLOCATION_REQUIRED", "Controller allocation is absent");
    const state = validateState(currentValue, runId, allocationKey);
    if (state.status !== "active") {
      throw ownerApprovalError("EOWNER_REVOCATION_REPLAY", "The cooperative controller is not currently active");
    }
    const launchTransaction = state.launchTransaction ?? null;
    if (launchTransaction !== null) {
      const checkedTransaction = validateEffectLaunchTransaction(launchTransaction);
      const authorization = state.launchAuthorization ?? null;
      if (!launchTransactionMatchesState(checkedTransaction, state, authorization)) {
        throw ownerApprovalError("EOWNER_REVOCATION_UNKNOWN", "The owned effect launch transaction is not bound to the current allocation");
      }
      throw ownerApprovalError("EOWNER_REVOCATION_UNKNOWN", "The owned effect launch transaction is still in-flight or unresolved");
    }
    if (state.authorityEpoch !== options.expectedEpoch || state.fence !== expectedFence) {
      throw ownerApprovalError("EOWNER_REVOCATION_STALE", "The cooperative controller authority epoch or fence is stale");
    }
    if (state.authorityEpoch >= Number.MAX_SAFE_INTEGER) {
      throw ownerApprovalError("EOWNER_REVOCATION_UNSAFE", "The cooperative controller authority epoch cannot advance safely");
    }
    const expectedStateDigest = digestObject(state);
    state.status = "revoked";
    state.authorityEpoch += 1;
    state.fence = allocationFence(runId, state.approvalEnvelope.digest, at);
    state.revokedAt = at;
    state.revocationReason = reason;
    state.updatedAt = at;
    await writeState(root, runId, state, allocationKey, { expectedStateDigest });
    const launchReservation = state.launchReservation ?? null;
    const launchAuthorization = state.launchAuthorization ?? null;
    const launchCommitment = state.launchCommitment ?? null;
    receipt = {
      status: "revoked",
      runId,
      controllerId: state.controllerId,
      ownedResourceId: state.ownedResourceId,
      authorityEpoch: state.authorityEpoch,
      fence: state.fence,
      revokedAt: state.revokedAt,
      revocationReason: state.revocationReason,
      launchStatus: state.launchResolution !== null
        ? "cleanup-confirmed-before-revocation"
        : launchCommitment !== null
        ? "committed-before-revocation"
        : launchAuthorization !== null
        ? "authorized-before-revocation"
        : launchReservation !== null
          ? "reserved-before-revocation"
          : "not-reserved",
      launchReservationDigest: launchReservation?.digest ?? null,
      launchAuthorizationDigest: launchAuthorization?.digest ?? null,
      launchCommitmentDigest: launchCommitment?.digest ?? null,
      completionStatus: "unresolved"
    };
  }, allocationKey);
  return Object.freeze(receipt);
}

export async function createCooperativeNativeV3Controller(options = {}) {
  rejectUnknownOptions(options, [...COMMON_CONTROLLER_OPTIONS, "approvalEnvelope", "effectBindingDigest", "ownerDecision", "incidentRecoveryLaunchFence", "requireHostTrust", "policyRequiresHostTrust"], "createCooperativeNativeV3Controller options");
  requireCooperativeMode(options.trustMode);
  if (options.requireHostTrust === true || options.policyRequiresHostTrust === true) holdHostTrust();
  const ownerDecision = validateOwnerDecisionHandle(options.ownerDecision);
  const root = resolveRoot(options.stateRoot);
  const runId = checkRequiredOption(options.runId, "runId");
  const planId = checkRequiredOption(options.planId, "planId");
  const taskId = checkRequiredOption(options.taskId, "taskId");
  const unitId = checkRequiredOption(options.unitId, "unitId");
  const recipient = options.recipient === undefined ? undefined : text(options.recipient, "recipient");
  const action = options.action === undefined ? undefined : text(options.action, "action");
  const effectBindingDigest = digest(options.effectBindingDigest, "effectBindingDigest");
  const incidentRecoveryLaunchFence = options.incidentRecoveryLaunchFence === undefined
    ? null
    : validateIncidentRecoveryLaunchFenceV1(options.incidentRecoveryLaunchFence);
  if (incidentRecoveryLaunchFence !== null && incidentRecoveryLaunchFence.effectBindingDigest !== effectBindingDigest) {
    throw ownerApprovalError("EINCIDENT_RECOVERY_BINDING", "incident recovery launch fence is not bound to the approved effect");
  }
  const source = sourceBinding(options.sourceBinding);
  const policy = policyDigest(options.policyDigest);
  const freshResolverTimeoutMs = freshResolverTimeout(options.freshResolverTimeoutMs);
  const envelope = validateApprovalEnvelope(options.approvalEnvelope);
  const executionId = options.executionId ?? envelope.executionId;
  const attemptId = options.attemptId ?? envelope.attemptId;
  id(executionId, "executionId");
  id(attemptId, "attemptId");
  const allocationKey = normalizedAllocationKey(options.allocationKey, { taskId, attemptId });
  if (options.requestedModel !== undefined && envelope.requestedModel !== options.requestedModel) {
    throw new Error("requestedModel is not the exact human-approved model selection");
  }
  const initial = await readFreshPlan({
    root,
    planId,
    runId,
    expected: { planDigest: envelope.planDigest, contractDigest: envelope.contractDigest },
    sourceBinding: source,
    policyDigest: policy,
    readFreshSourceBinding: options.readFreshSourceBinding,
    sourceCwd: options.sourceCwd,
    readTrustPolicy: options.readTrustPolicy,
    requestedTrustMode: options.trustMode,
    clock: options.clock,
    timeoutMs: freshResolverTimeoutMs
  });
  assertNativeV3AutoCommandExecutionAllowed(initial.plan);
  validateEnvelopeForPlan({ envelope, plan: initial.plan, runId, taskId, unitId, recipient, action, requestedModel: options.requestedModel, source: initial.sourceBinding, clock: options.clock });
  const at = currentIso(options.clock);
  await withStateLock(root, runId, async ({ signal }) => {
    const current = await readStateIfPresent(root, runId, allocationKey);
    const fresh = await readFreshPlan({
      root,
      planId,
      runId,
      expected: { planDigest: envelope.planDigest, contractDigest: envelope.contractDigest },
      sourceBinding: source,
      policyDigest: policy,
      readFreshSourceBinding: options.readFreshSourceBinding,
      sourceCwd: options.sourceCwd,
      readTrustPolicy: options.readTrustPolicy,
      requestedTrustMode: options.trustMode,
      clock: options.clock,
      abortSignal: signal,
      timeoutMs: freshResolverTimeoutMs
    });
    assertNativeV3AutoCommandExecutionAllowed(fresh.plan);
    validateEnvelopeForPlan({ envelope, plan: fresh.plan, runId, taskId, unitId, recipient, action, requestedModel: options.requestedModel, source: fresh.sourceBinding, clock: options.clock });
    if (!current) throw ownerApprovalError("EALLOCATION_REQUIRED", "Controller allocation is absent; call prepareCooperativeNativeV3Approval before owner approval");
    const state = validateState(current, runId, allocationKey);
    const expectedStateDigest = digestObject(state);
    if (state.status !== "pending") {
      throw ownerApprovalError("EOWNER_APPROVAL_REPLAY", "The cooperative owner approval has already been consumed or revoked");
    }
    if (state.planId !== planId || state.taskId !== taskId || state.unitId !== unitId ||
        state.ownedResourceId !== envelope.ownedResourceId || state.nonce !== envelope.nonce ||
        state.approvalEnvelope.digest !== envelope.digest) {
      throw new Error("ApprovalEnvelope does not match the controller-owned pending allocation");
    }
    if (state.executionId !== executionId || state.attemptId !== attemptId) {
      throw new Error("ApprovalEnvelope execution identity does not match the controller-owned pending allocation");
    }
    if (!ownerRequestMatchesPreparation(state.ownerApprovalRequest, {
      plan: fresh.plan,
      planId,
      runId,
      taskId,
      unitId,
      executionId,
      attemptId,
      recipient: envelope.recipient,
      action: envelope.action,
      requestedModel: options.requestedModel ?? envelope.requestedModel,
      source: fresh.sourceBinding,
      policy,
      effectBindingDigest,
      expiresAt: state.ownerApprovalRequest.expiresAt
    })) {
      throw ownerApprovalError("EOWNER_APPROVAL_REQUEST_MISMATCH", "The pending owner approval request is not bound to the current effect");
    }
    const persistedDecision = state.ownerApprovalDecision;
    if (!persistedDecision) throw ownerApprovalError("EOWNER_APPROVAL_REQUIRED", "An explicit cooperative owner decision is required");
    const boundDecision = validateDecisionAgainstRequest(persistedDecision, state.ownerApprovalRequest);
    if (!same(boundDecision, ownerDecision)) {
      throw ownerApprovalError("EOWNER_APPROVAL_REPLAY", "The supplied cooperative owner decision is not the persisted single-use decision");
    }
    if (boundDecision.decision !== "approve") {
      throw ownerApprovalError("EOWNER_APPROVAL_REJECTED", "The cooperative owner rejected this action");
    }
    const consumedBody = {
      ...boundDecision,
      status: "consumed",
      consumedAt: at
    };
    const consumedDecision = validateOwnerDecision({
      ...consumedBody,
      decisionDigest: digestObject(ownerDecisionBody(consumedBody))
    });
    if (signal.aborted) throw boundedFailure("EOWNER_LOCK_ABORTED", "controller activation was aborted before persistence");
    state.status = "active";
    state.approvalEnvelope = clone(envelope);
    state.ownerApprovalDecision = consumedDecision;
    state.activationId = allocationToken("activation");
    state.capabilityId = allocationToken("capability");
    state.updatedAt = at;
    await writeState(root, runId, state, allocationKey, {
      expectedStateDigest,
      signal
    });
  }, allocationKey, { timeoutMs: STATE_CALLBACK_TIMEOUT_MS });
  const state = await readActiveState(root, runId, allocationKey);
  const controllerId = state.controllerId;
  // The execution registry needs one coherent fresh observation.  Exposing a
  // batch boundary avoids re-running the full source/policy plan capture once
  // for each of run-contract, source, and authority while preserving the
  // trusted adapter's independent TCB attestation of the authority.
  const readExecutionBinding = async ({ runId: requestedRunId, binding }) => {
    if (requestedRunId !== runId) throw new Error("runId does not match the cooperative controller");
    const current = await readActiveState(root, runId, allocationKey);
    assertRequestMatchesState(binding, current);
    const fresh = await readFreshPlan({
      root,
      planId: current.planId,
      runId,
      expected: stateExpected(current),
      sourceBinding: current.sourceBinding,
      policyDigest: current.policyDigest,
      readFreshSourceBinding: options.readFreshSourceBinding,
      sourceCwd: options.sourceCwd,
      readTrustPolicy: options.readTrustPolicy,
      requestedTrustMode: options.trustMode,
      clock: options.clock,
      timeoutMs: freshResolverTimeoutMs
    });
    validateEnvelopeForPlan({
      envelope: current.approvalEnvelope,
      plan: fresh.plan,
      runId,
      taskId: current.taskId,
      unitId: current.unitId,
      source: fresh.sourceBinding,
      clock: options.clock
    });
    const authority = authorityFor(current);
    const currentRunContract = runContract(runId, fresh.plan);
    buildExecutionAdmission({
      runContract: currentRunContract,
      authority,
      binding,
      now: currentDate(options.clock)
    });
    return {
      runContract: currentRunContract,
      sourceBinding: { runId, revision: fresh.sourceBinding.revision, digest: fresh.sourceBinding.digest },
      authority,
      // Read-only projection from this branded controller's persisted owner
      // request. It is evidence for validation and grants no launch method.
      effectBindingDigest: current.ownerApprovalRequest.effectBindingDigest,
      launchReservation: current.launchReservation ?? null,
      launchAuthorization: current.launchAuthorization ?? null,
      launchCommitment: current.launchCommitment ?? null,
      launchTransaction: current.launchTransaction ?? null,
      launchResolution: current.launchResolution ?? null
    };
  };
  const readRunContract = async ({ runId: requestedRunId }) => {
    if (requestedRunId !== runId) throw new Error("runId does not match the cooperative controller");
    const current = await readActiveState(root, runId, allocationKey);
    const fresh = await readFreshPlan({
      root,
      planId: current.planId,
      runId,
      expected: stateExpected(current),
      sourceBinding: current.sourceBinding,
      policyDigest: current.policyDigest,
      readFreshSourceBinding: options.readFreshSourceBinding,
      sourceCwd: options.sourceCwd,
      readTrustPolicy: options.readTrustPolicy,
      requestedTrustMode: options.trustMode,
      clock: options.clock,
      timeoutMs: freshResolverTimeoutMs
    });
    return runContract(runId, fresh.plan);
  };
  const readSource = async ({ runId: requestedRunId }) => {
    if (requestedRunId !== runId) throw new Error("runId does not match the cooperative controller");
    const current = await readActiveState(root, runId, allocationKey);
    const fresh = await readFreshPlan({
      root,
      planId: current.planId,
      runId,
      expected: stateExpected(current),
      sourceBinding: current.sourceBinding,
      policyDigest: current.policyDigest,
      readFreshSourceBinding: options.readFreshSourceBinding,
      sourceCwd: options.sourceCwd,
      readTrustPolicy: options.readTrustPolicy,
      requestedTrustMode: options.trustMode,
      clock: options.clock,
      timeoutMs: freshResolverTimeoutMs
    });
    return { runId, revision: fresh.sourceBinding.revision, digest: fresh.sourceBinding.digest };
  };
  const readAuthority = async (request) => {
    const current = await readActiveState(root, runId, allocationKey);
    assertRequestMatchesState(request, current);
    const fresh = await readFreshPlan({
      root,
      planId: current.planId,
      runId,
      expected: stateExpected(current),
      sourceBinding: current.sourceBinding,
      policyDigest: current.policyDigest,
      readFreshSourceBinding: options.readFreshSourceBinding,
      sourceCwd: options.sourceCwd,
      readTrustPolicy: options.readTrustPolicy,
      requestedTrustMode: options.trustMode,
      clock: options.clock,
      timeoutMs: freshResolverTimeoutMs
    });
    assertNativeV3AutoCommandExecutionAllowed(fresh.plan);
    validateEnvelopeForPlan({ envelope: current.approvalEnvelope, plan: fresh.plan, runId, taskId: current.taskId, unitId: current.unitId, source: fresh.sourceBinding, clock: options.clock });
    const authority = authorityFor(current);
    buildExecutionAdmission({
      runContract: runContract(runId, fresh.plan),
      authority,
      binding: request,
      now: currentDate(options.clock)
    });
    return authority;
  };
  const readStopAuthority = async (request) => {
    // Stop authority is scoped to the persisted approved allocation.  Keep
    // this path independent of fresh-plan/source/policy and dispatch expiry
    // checks so an owned resource remains stoppable during emergency drift.
    const current = await readOwnedStopState(root, runId, allocationKey);
    assertStopRequestMatchesState(request, current);
    return stopProjectionFor(current);
  };
  const readLifecycle = async ({ runId: requestedRunId }) => {
    if (requestedRunId !== runId) throw new Error("runId does not match the cooperative controller");
    const current = await readActiveState(root, runId, allocationKey);
    return {
      kind: "ControllerLifecycleObservationV1",
      runId,
      status: "active",
      incarnation: current.incarnation,
      ownerLeaseId: current.ownerLeaseId,
      previousIncarnation: null,
      previousOwnerLeaseId: null,
      observedAt: currentIso(options.clock)
    };
  };
  const commitEffectLaunch = async (request) => {
    plain(request, "effect launch request");
    exactKeys(request, [
      "runId", "executionId", "attemptId", "unitId", "ownedResourceId", "sourceBindingDigest",
      "policyDigest", "revision", "authorityEpoch", "fence", "effectBindingDigest"
    ], "effect launch request");
    const requestedBinding = {
      runId: id(request.runId, "effect launch request.runId"),
      executionId: id(request.executionId, "effect launch request.executionId"),
      attemptId: id(request.attemptId, "effect launch request.attemptId"),
      unitId: id(request.unitId, "effect launch request.unitId"),
      sourceBindingDigest: digest(request.sourceBindingDigest, "effect launch request.sourceBindingDigest"),
      policyDigest: digest(request.policyDigest, "effect launch request.policyDigest"),
      revision: text(request.revision, "effect launch request.revision", /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
      ownedResourceId: id(request.ownedResourceId, "effect launch request.ownedResourceId")
    };
    if (request.runId !== runId) throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch runId does not match the controller");
    if (!Number.isSafeInteger(request.authorityEpoch) || request.authorityEpoch < 1) {
      throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch authority epoch is invalid");
    }
    const expectedFence = digest(request.fence, "effect launch request.fence");
    const effectBindingDigest = digest(request.effectBindingDigest, "effect launch request.effectBindingDigest");
    let reservation;
    await withStateLock(root, runId, async ({ signal }) => {
      const current = validateState(await readStateIfPresent(root, runId, allocationKey), runId, allocationKey);
      const expectedStateDigest = digestObject(current);
      if (current.status !== "active") {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch authority is no longer active");
      }
      assertNoRecoverySuccessor(current);
      assertRequestMatchesState(requestedBinding, current);
      if (request.authorityEpoch !== current.authorityEpoch || expectedFence !== current.fence) {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch authority epoch or fence is stale");
      }
      if (effectBindingDigest !== current.ownerApprovalRequest.effectBindingDigest) {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch is not bound to the approved effect");
      }
      await assertAutoEffectAdmissionForState(root, current);
      const existing = current.launchReservation === undefined ? null : current.launchReservation;
      if (existing !== null) {
        const checked = validateEffectLaunchReservation(existing);
        if (checked.authorityEpoch !== request.authorityEpoch || checked.fence !== expectedFence ||
            !launchReservationMatchesState(checked, current) || checked.effectBindingDigest !== effectBindingDigest) {
          throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch reservation is bound to a different request");
        }
        reservation = clone(checked);
        return;
      }
      // Re-read the complete plan/source/policy while holding the same
      // controller allocation lock used by revocation. This records a
      // candidate reservation only; the adapter must obtain the separate
      // authorization CAS after the supervisor requests this exact candidate.
      const fresh = await readFreshPlan({
        root,
        planId: current.planId,
        runId,
        expected: stateExpected(current),
        sourceBinding: current.sourceBinding,
        policyDigest: current.policyDigest,
        readFreshSourceBinding: options.readFreshSourceBinding,
        sourceCwd: options.sourceCwd,
        readTrustPolicy: options.readTrustPolicy,
        requestedTrustMode: options.trustMode,
        clock: options.clock,
        abortSignal: signal,
        timeoutMs: freshResolverTimeoutMs
      });
      validateEnvelopeForPlan({
        envelope: current.approvalEnvelope,
        plan: fresh.plan,
        runId,
        taskId: current.taskId,
        unitId: current.unitId,
        source: fresh.sourceBinding,
        clock: options.clock
      });
      const authority = authorityFor(current);
      buildExecutionAdmission({
        runContract: runContract(runId, fresh.plan),
        authority,
        binding: requestedBinding,
        now: currentDate(options.clock)
      });
      const body = {
        schemaVersion: 1,
        kind: NATIVE_V3_EFFECT_LAUNCH_RESERVATION_KIND,
        reservationId: allocationToken("launch"),
        ...requestedBinding,
        effectBindingDigest,
        authorityEpoch: request.authorityEpoch,
        fence: expectedFence,
        status: "reserved",
        reservedAt: currentIso(options.clock)
      };
      reservation = validateEffectLaunchReservation({ ...body, digest: digestObject(body) });
      if (signal.aborted) throw boundedFailure("EOWNER_LOCK_ABORTED", "effect launch reservation was aborted before persistence");
      current.launchReservation = reservation;
      current.updatedAt = currentIso(options.clock);
      await writeState(root, runId, current, allocationKey, {
        expectedStateDigest,
        signal
      });
    }, allocationKey, { timeoutMs: STATE_CALLBACK_TIMEOUT_MS });
    return clone(reservation);
  };
  const authorizeEffectLaunch = async (request) => {
    plain(request, "effect launch authorization request");
    exactKeys(request, [
      "runId", "executionId", "attemptId", "unitId", "ownedResourceId", "sourceBindingDigest",
      "policyDigest", "revision", "authorityEpoch", "fence", "effectBindingDigest",
      "reservationId", "reservationDigest"
    ], "effect launch authorization request");
    const requestedBinding = {
      runId: id(request.runId, "effect launch authorization request.runId"),
      executionId: id(request.executionId, "effect launch authorization request.executionId"),
      attemptId: id(request.attemptId, "effect launch authorization request.attemptId"),
      unitId: id(request.unitId, "effect launch authorization request.unitId"),
      sourceBindingDigest: digest(request.sourceBindingDigest, "effect launch authorization request.sourceBindingDigest"),
      policyDigest: digest(request.policyDigest, "effect launch authorization request.policyDigest"),
      revision: text(request.revision, "effect launch authorization request.revision", /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
      ownedResourceId: id(request.ownedResourceId, "effect launch authorization request.ownedResourceId")
    };
    if (request.runId !== runId) throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch authorization runId does not match the controller");
    if (!Number.isSafeInteger(request.authorityEpoch) || request.authorityEpoch < 1) {
      throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch authorization epoch is invalid");
    }
    const expectedFence = digest(request.fence, "effect launch authorization request.fence");
    const effectBindingDigest = digest(request.effectBindingDigest, "effect launch authorization request.effectBindingDigest");
    const reservationId = id(request.reservationId, "effect launch authorization request.reservationId");
    const reservationDigest = digest(request.reservationDigest, "effect launch authorization request.reservationDigest");
    let authorization;
    await withStateLock(root, runId, async ({ signal }) => {
      const current = validateState(await readStateIfPresent(root, runId, allocationKey), runId, allocationKey);
      const expectedStateDigest = digestObject(current);
      if (current.status !== "active") {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch authorization is no longer active");
      }
      assertNoRecoverySuccessor(current);
      assertRequestMatchesState(requestedBinding, current);
      if (request.authorityEpoch !== current.authorityEpoch || expectedFence !== current.fence) {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch authorization epoch or fence is stale");
      }
      if (effectBindingDigest !== current.ownerApprovalRequest.effectBindingDigest) {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch authorization is not bound to the approved effect");
      }
      await assertAutoEffectAdmissionForState(root, current);
      const reservation = current.launchReservation === undefined ? null : current.launchReservation;
      if (reservation === null) {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch authorization requires a durable reservation");
      }
      const checkedReservation = validateEffectLaunchReservation(reservation);
      if (checkedReservation.reservationId !== reservationId || checkedReservation.digest !== reservationDigest ||
          checkedReservation.authorityEpoch !== request.authorityEpoch || checkedReservation.fence !== expectedFence ||
          checkedReservation.effectBindingDigest !== effectBindingDigest || !launchReservationMatchesState(checkedReservation, current)) {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch authorization is not bound to the durable reservation");
      }
      const existing = current.launchAuthorization === undefined ? null : current.launchAuthorization;
      if (existing !== null) {
        const checkedExisting = validateEffectLaunchAuthorization(existing);
        if (checkedExisting.reservationId !== reservationId || checkedExisting.reservationDigest !== reservationDigest ||
            checkedExisting.authorityEpoch !== request.authorityEpoch || checkedExisting.fence !== expectedFence ||
            checkedExisting.effectBindingDigest !== effectBindingDigest) {
          throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch authorization replay conflicts with the durable authorization");
        }
        authorization = clone(checkedExisting);
        return;
      }
      // This is the second, revocation-linearized boundary.  A revoke that
      // wins after reservation but before this lock is acquired leaves the
      // allocation revoked, so the supervisor never receives an authorized
      // launch frame and no target can be spawned.
      const fresh = await readFreshPlan({
        root,
        planId: current.planId,
        runId,
        expected: stateExpected(current),
        sourceBinding: current.sourceBinding,
        policyDigest: current.policyDigest,
        readFreshSourceBinding: options.readFreshSourceBinding,
        sourceCwd: options.sourceCwd,
        readTrustPolicy: options.readTrustPolicy,
        requestedTrustMode: options.trustMode,
        clock: options.clock,
        abortSignal: signal,
        timeoutMs: freshResolverTimeoutMs
      });
      validateEnvelopeForPlan({
        envelope: current.approvalEnvelope,
        plan: fresh.plan,
        runId,
        taskId: current.taskId,
        unitId: current.unitId,
        source: fresh.sourceBinding,
        clock: options.clock
      });
      const authority = authorityFor(current);
      buildExecutionAdmission({
        runContract: runContract(runId, fresh.plan),
        authority,
        binding: requestedBinding,
        now: currentDate(options.clock)
      });
      const body = {
        schemaVersion: 1,
        kind: NATIVE_V3_EFFECT_LAUNCH_AUTHORIZATION_KIND,
        authorizationId: allocationToken("authorize"),
        reservationId,
        reservationDigest,
        ...requestedBinding,
        effectBindingDigest,
        authorityEpoch: request.authorityEpoch,
        fence: expectedFence,
        status: "authorized",
        authorizedAt: currentIso(options.clock)
      };
      authorization = validateEffectLaunchAuthorization({ ...body, digest: digestObject(body) });
      if (signal.aborted) throw boundedFailure("EOWNER_LOCK_ABORTED", "effect launch authorization was aborted before persistence");
      current.launchAuthorization = authorization;
      current.updatedAt = currentIso(options.clock);
      await writeState(root, runId, current, allocationKey, {
        expectedStateDigest,
        signal
      });
    }, allocationKey, { timeoutMs: STATE_CALLBACK_TIMEOUT_MS });
    return clone(authorization);
  };
  const commitAuthorizedEffectLaunch = async (request, launchEffect = null) => {
    if (typeof launchEffect !== "function") {
      throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch commitment requires the trusted owned launcher");
    }
    plain(request, "effect launch commitment request");
    exactKeys(request, [
      "runId", "executionId", "attemptId", "unitId", "ownedResourceId", "sourceBindingDigest",
      "policyDigest", "revision", "authorityEpoch", "fence", "effectBindingDigest",
      "reservationId", "reservationDigest", "authorizationId", "authorizationDigest"
    ], "effect launch commitment request");
    const requestedBinding = {
      runId: id(request.runId, "effect launch commitment request.runId"),
      executionId: id(request.executionId, "effect launch commitment request.executionId"),
      attemptId: id(request.attemptId, "effect launch commitment request.attemptId"),
      unitId: id(request.unitId, "effect launch commitment request.unitId"),
      sourceBindingDigest: digest(request.sourceBindingDigest, "effect launch commitment request.sourceBindingDigest"),
      policyDigest: digest(request.policyDigest, "effect launch commitment request.policyDigest"),
      revision: text(request.revision, "effect launch commitment request.revision", /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
      ownedResourceId: id(request.ownedResourceId, "effect launch commitment request.ownedResourceId")
    };
    if (request.runId !== runId) throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch commitment runId does not match the controller");
    if (!Number.isSafeInteger(request.authorityEpoch) || request.authorityEpoch < 1) {
      throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch commitment epoch is invalid");
    }
    const expectedFence = digest(request.fence, "effect launch commitment request.fence");
    const effectBindingDigest = digest(request.effectBindingDigest, "effect launch commitment request.effectBindingDigest");
    const reservationId = id(request.reservationId, "effect launch commitment request.reservationId");
    const reservationDigest = digest(request.reservationDigest, "effect launch commitment request.reservationDigest");
    const authorizationId = id(request.authorizationId, "effect launch commitment request.authorizationId");
    const authorizationDigest = digest(request.authorizationDigest, "effect launch commitment request.authorizationDigest");
    let commitment;
    const commitUnderStateLock = async (signal) => {
      const current = validateState(await readStateIfPresent(root, runId, allocationKey), runId, allocationKey);
      let expectedStateDigest = digestObject(current);
      if (current.status !== "active") {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch commitment is no longer active");
      }
      assertNoRecoverySuccessor(current);
      assertRequestMatchesState(requestedBinding, current);
      if (request.authorityEpoch !== current.authorityEpoch || expectedFence !== current.fence) {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch commitment epoch or fence is stale");
      }
      if (effectBindingDigest !== current.ownerApprovalRequest.effectBindingDigest) {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch commitment is not bound to the approved effect");
      }
      await assertAutoEffectAdmissionForState(root, current);
      const reservation = current.launchReservation === undefined ? null : current.launchReservation;
      if (reservation === null) {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch commitment requires a durable reservation");
      }
      const checkedReservation = validateEffectLaunchReservation(reservation);
      if (checkedReservation.reservationId !== reservationId || checkedReservation.digest !== reservationDigest ||
          checkedReservation.authorityEpoch !== request.authorityEpoch || checkedReservation.fence !== expectedFence ||
          checkedReservation.effectBindingDigest !== effectBindingDigest || !launchReservationMatchesState(checkedReservation, current)) {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch commitment is not bound to the durable reservation");
      }
      const authorization = current.launchAuthorization === undefined ? null : current.launchAuthorization;
      if (authorization === null) {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch commitment requires a durable authorization");
      }
      const checkedAuthorization = validateEffectLaunchAuthorization(authorization);
      if (checkedAuthorization.authorizationId !== authorizationId || checkedAuthorization.digest !== authorizationDigest ||
          checkedAuthorization.reservationId !== reservationId || checkedAuthorization.reservationDigest !== reservationDigest ||
          checkedAuthorization.authorityEpoch !== request.authorityEpoch || checkedAuthorization.fence !== expectedFence ||
          checkedAuthorization.effectBindingDigest !== effectBindingDigest ||
          !launchReservationMatchesState(checkedAuthorization, current)) {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch commitment is not bound to the durable authorization");
      }
      const existing = current.launchCommitment === undefined ? null : current.launchCommitment;
      if (existing !== null) {
        const checkedExisting = validateEffectLaunchCommitment(existing);
        if (!launchCommitmentMatchesState(checkedExisting, current, checkedAuthorization) ||
            checkedExisting.commitmentId === undefined || checkedExisting.authorizationId !== authorizationId ||
            checkedExisting.authorizationDigest !== authorizationDigest || checkedExisting.reservationId !== reservationId ||
            checkedExisting.reservationDigest !== reservationDigest || checkedExisting.authorityEpoch !== request.authorityEpoch ||
            checkedExisting.fence !== expectedFence || checkedExisting.effectBindingDigest !== effectBindingDigest) {
          throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch commitment replay conflicts with the durable commitment");
        }
        commitment = clone(checkedExisting);
        return;
      }
      if (current.launchTransaction !== undefined && current.launchTransaction !== null) {
        throw ownerApprovalError("EOWNED_PROCESS_AUTHORITY", "effect launch already has an in-flight or unresolved transaction");
      }
      // Revalidate the current source, policy, plan, envelope, and admission
      // before entering the final owned launch transaction.  The controller
      // lock remains held while the trusted supervisor receives its go frame
      // and acknowledges the real OS spawn, so revocation cannot complete in
      // the gap between authorization delivery and target creation.
      const fresh = await readFreshPlan({
        root,
        planId: current.planId,
        runId,
        expected: stateExpected(current),
        sourceBinding: current.sourceBinding,
        policyDigest: current.policyDigest,
        readFreshSourceBinding: options.readFreshSourceBinding,
        sourceCwd: options.sourceCwd,
        readTrustPolicy: options.readTrustPolicy,
        requestedTrustMode: options.trustMode,
        clock: options.clock,
        abortSignal: signal,
        timeoutMs: freshResolverTimeoutMs
      });
      validateEnvelopeForPlan({
        envelope: current.approvalEnvelope,
        plan: fresh.plan,
        runId,
        taskId: current.taskId,
        unitId: current.unitId,
        source: fresh.sourceBinding,
        clock: options.clock
      });
      const authority = authorityFor(current);
      buildExecutionAdmission({
        runContract: runContract(runId, fresh.plan),
        authority,
        binding: requestedBinding,
        now: currentDate(options.clock)
      });
      const commitmentId = allocationToken("commit");
      const launchContext = {
        commitmentId,
        authorizationId,
        authorizationDigest,
        reservationId,
        reservationDigest,
        ...requestedBinding,
        effectBindingDigest,
        authorityEpoch: request.authorityEpoch,
        fence: expectedFence
      };
      const transactionBody = {
        schemaVersion: 1,
        kind: NATIVE_V3_EFFECT_LAUNCH_TRANSACTION_KIND,
        transactionId: allocationToken("launch-tx"),
        ...launchContext,
        status: "in-flight",
        startedAt: currentIso(options.clock)
      };
      const transaction = validateEffectLaunchTransaction({ ...transactionBody, digest: digestObject(transactionBody) });
      current.launchTransaction = transaction;
      current.updatedAt = currentIso(options.clock);
      await writeState(root, runId, current, allocationKey, {
        expectedStateDigest,
        signal
      });
      expectedStateDigest = digestObject(current);
      let acknowledgement;
      try {
        acknowledgement = await runBoundedControllerOperation(
          "owned effect launch transaction",
          () => launchEffect(clone(launchContext), { signal, transaction: clone(transaction) }),
          { signal, timeoutMs: STATE_CALLBACK_TIMEOUT_MS }
        );
        validateEffectLaunchAcknowledgement(acknowledgement, launchContext);
      } catch (error) {
        const { digest: ignoredDigest, ...transactionWithoutDigest } = transaction;
        const unknownBody = { ...transactionWithoutDigest, status: "unknown" };
        current.launchTransaction = validateEffectLaunchTransaction({
          ...unknownBody,
          digest: digestObject(unknownBody)
        });
        current.updatedAt = currentIso(options.clock);
        await writeState(root, runId, current, allocationKey, { expectedStateDigest });
        expectedStateDigest = digestObject(current);
        throw error;
      }
      const body = {
        schemaVersion: 1,
        kind: NATIVE_V3_EFFECT_LAUNCH_COMMITMENT_KIND,
        commitmentId,
        authorizationId,
        authorizationDigest,
        reservationId,
        reservationDigest,
        ...requestedBinding,
        effectBindingDigest,
        authorityEpoch: request.authorityEpoch,
        fence: expectedFence,
        status: "committed",
        committedAt: currentIso(options.clock)
      };
      commitment = validateEffectLaunchCommitment({ ...body, digest: digestObject(body) });
      if (signal.aborted) throw boundedFailure("EOWNER_LOCK_ABORTED", "effect launch commitment was aborted before persistence");
      current.launchTransaction = null;
      current.launchCommitment = commitment;
      current.updatedAt = currentIso(options.clock);
      await writeState(root, runId, current, allocationKey, {
        expectedStateDigest,
        signal
      });
    };
    await withStateLock(root, runId, async ({ signal }) => {
      if (incidentRecoveryLaunchFence === null) return commitUnderStateLock(signal);
      return withIncidentRevisionLaunchFenceV1({
        stateRoot: root,
        incidentId: incidentRecoveryLaunchFence.incidentId,
        expectedRevision: incidentRecoveryLaunchFence.incidentRevision,
        expectedDigest: incidentRecoveryLaunchFence.incidentDigest,
        abortSignal: signal,
        callback: () => commitUnderStateLock(signal)
      });
    }, allocationKey, { timeoutMs: STATE_CALLBACK_TIMEOUT_MS });
    return clone(commitment);
  };
  const resolveEffectLaunchTransaction = async (request, resourceAdapter = null) => {
    if (!isTrustedOwnedResourceAdapter(resourceAdapter)) {
      throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_UNAVAILABLE", "launch transaction resolution requires the trusted POSIX owned resource adapter or an equivalent selected backend");
    }
    try {
      const { assertTrustedOwnedProcessResourceAdapterV1 } = await import("./owned-process-adapter-v1.mjs");
      assertTrustedOwnedProcessResourceAdapterV1(resourceAdapter);
    } catch (error) {
      const unavailable = ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_UNAVAILABLE", "launch transaction resolution requires the trusted POSIX owned resource adapter or an equivalent selected backend");
      unavailable.cause = error;
      throw unavailable;
    }
    if (typeof resourceAdapter.resolveOwnedLaunch !== "function") {
      throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_UNAVAILABLE", "trusted POSIX owned resource adapter or equivalent selected backend cannot resolve launch cleanup");
    }
    plain(request, "effect launch cleanup resolution request");
    exactKeys(request, [
      "runId", "handleId", "intentId", "executionId", "attemptId", "unitId", "ownedResourceId",
      "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence", "transactionId", "transactionDigest"
    ], "effect launch cleanup resolution request");
    const requestedBinding = {
      runId: id(request.runId, "effect launch cleanup resolution request.runId"),
      executionId: id(request.executionId, "effect launch cleanup resolution request.executionId"),
      attemptId: id(request.attemptId, "effect launch cleanup resolution request.attemptId"),
      unitId: id(request.unitId, "effect launch cleanup resolution request.unitId"),
      sourceBindingDigest: digest(request.sourceBindingDigest, "effect launch cleanup resolution request.sourceBindingDigest"),
      policyDigest: digest(request.policyDigest, "effect launch cleanup resolution request.policyDigest"),
      revision: text(request.revision, "effect launch cleanup resolution request.revision", /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
      ownedResourceId: id(request.ownedResourceId, "effect launch cleanup resolution request.ownedResourceId")
    };
    const handleId = id(request.handleId, "effect launch cleanup resolution request.handleId");
    const intentId = id(request.intentId, "effect launch cleanup resolution request.intentId");
    if (request.runId !== runId) throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_INPUT", "effect launch cleanup resolution runId does not match the controller");
    const transactionId = id(request.transactionId, "effect launch cleanup resolution request.transactionId");
    const transactionDigest = digest(request.transactionDigest, "effect launch cleanup resolution request.transactionDigest");
    if (!Number.isSafeInteger(request.authorityEpoch) || request.authorityEpoch < 1) {
      throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_INPUT", "effect launch cleanup resolution epoch is invalid");
    }
    const expectedFence = digest(request.fence, "effect launch cleanup resolution request.fence");
    let resolution;
    await withStateLock(root, runId, async ({ signal }) => {
      const current = validateState(await readStateIfPresent(root, runId, allocationKey), runId, allocationKey);
      const expectedStateDigest = digestObject(current);
      if (current.status !== "active") {
        throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_REPLAY", "effect launch cleanup resolution requires an active controller");
      }
      assertNoRecoverySuccessor(current);
      assertRequestMatchesState(requestedBinding, current);
      if (request.authorityEpoch !== current.authorityEpoch || expectedFence !== current.fence) {
        throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_STALE", "effect launch cleanup resolution authority is stale");
      }
      const currentResolution = current.launchResolution ?? null;
      if (currentResolution !== null) {
        const checkedResolution = validateEffectLaunchCleanupResolution(currentResolution);
        if (checkedResolution.transactionId !== transactionId || checkedResolution.transactionDigest !== transactionDigest ||
            !launchCleanupResolutionMatchesState(checkedResolution, current, current.launchAuthorization)) {
          throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_REPLAY", "effect launch cleanup resolution conflicts with the durable resolution");
        }
        resolution = clone(checkedResolution);
        return;
      }
      const transaction = current.launchTransaction ?? null;
      if (transaction === null) {
        throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_UNKNOWN", "the controller has no unresolved launch transaction to resolve");
      }
      const checkedTransaction = validateEffectLaunchTransaction(transaction);
      if (!launchTransactionMatchesState(checkedTransaction, current, current.launchAuthorization) ||
          checkedTransaction.status !== "unknown" || checkedTransaction.transactionId !== transactionId ||
          checkedTransaction.digest !== transactionDigest || checkedTransaction.authorityEpoch !== request.authorityEpoch ||
          checkedTransaction.fence !== expectedFence) {
        throw ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_UNKNOWN", "the launch transaction is stale or not bound to the requested cleanup");
      }
      let cleanup;
      try {
        cleanup = await runBoundedControllerOperation(
          "owned launch cleanup resolution",
          () => resourceAdapter.resolveOwnedLaunch({
            request: {
              ...requestedBinding,
              handleId,
              intentId,
              authorityEpoch: request.authorityEpoch,
              fence: expectedFence,
              transactionId,
              transactionDigest
            },
            transaction: clone(checkedTransaction)
          }, { signal }),
          { signal, timeoutMs: STATE_CALLBACK_TIMEOUT_MS }
        );
      } catch (error) {
        const held = ownerApprovalError("EOWNER_LAUNCH_RESOLUTION_UNKNOWN", "owned launch cleanup could not be proven");
        held.cause = error;
        throw held;
      }
      const checkedCleanup = validateOwnedLaunchCleanupReceipt(cleanup, {
        ...requestedBinding,
        handleId,
        intentId,
        authorityEpoch: request.authorityEpoch,
        fence: expectedFence
      }, checkedTransaction, current.controllerId);
      const body = {
        schemaVersion: 1,
        kind: NATIVE_V3_EFFECT_LAUNCH_CLEANUP_RESOLUTION_KIND,
        resolutionId: allocationToken("launch-cleanup"),
        transactionId: checkedTransaction.transactionId,
        transactionDigest: checkedTransaction.digest,
        ...requestedBinding,
        effectBindingDigest: checkedTransaction.effectBindingDigest,
        authorityEpoch: checkedTransaction.authorityEpoch,
        fence: checkedTransaction.fence,
        status: "cleanup-confirmed",
        effectStarted: true,
        launchRequested: true,
        groupTerminated: true,
        lateLaunchBlocked: true,
        noSendProof: null,
        allocationId: checkedCleanup.allocationId,
        allocationRecordDigest: checkedCleanup.allocationRecordDigest,
        cleanupDigest: checkedCleanup.digest,
        observedAt: currentIso(options.clock)
      };
      resolution = validateEffectLaunchCleanupResolution({ ...body, digest: digestObject(body) });
      if (signal.aborted) throw boundedFailure("EOWNER_LOCK_ABORTED", "effect launch cleanup resolution was aborted before persistence");
      current.launchTransaction = null;
      current.launchResolution = resolution;
      current.updatedAt = currentIso(options.clock);
      await writeState(root, runId, current, allocationKey, {
        expectedStateDigest,
        signal
      });
    }, allocationKey, { timeoutMs: STATE_CALLBACK_TIMEOUT_MS });
    return clone(resolution);
  };
  const commitAdmissionSeal = async (request) => {
    plain(request, "admission seal request");
    const required = ["runId", "handleId", "intentId", "admissionDigest", "authorityEpoch", "fence", "outcome", "effectDigest"];
    for (const key of required) if (!Object.hasOwn(request, key)) throw new Error(`admission seal request requires ${key}`);
    if (request.runId !== runId) throw new Error("admission seal runId does not match");
    return withStateLock(root, runId, async ({ signal }) => {
      const current = validateState(await readStateIfPresent(root, runId, allocationKey), runId, allocationKey);
      const expectedStateDigest = digestObject(current);
      if (current.status !== "active") throw new Error("Cannot commit a seal for a non-active cooperative controller");
      assertNoRecoverySuccessor(current);
      id(request.intentId, "admission seal request.intentId");
      if (request.authorityEpoch !== current.authorityEpoch || request.fence !== current.fence) throw new Error("Admission seal authority epoch/fence is stale");
      const suppliedAdmission = validateExecutionAdmission(request.admission);
      assertRequestMatchesState(suppliedAdmission, current);
      if (digestExecutionAdmission(suppliedAdmission) !== request.admissionDigest) {
        throw new Error("Admission seal digest is not bound to the supplied current admission");
      }
      const fresh = await readFreshPlan({
        root,
        planId: current.planId,
        runId,
        expected: stateExpected(current),
        sourceBinding: current.sourceBinding,
        policyDigest: current.policyDigest,
        readFreshSourceBinding: options.readFreshSourceBinding,
        sourceCwd: options.sourceCwd,
        readTrustPolicy: options.readTrustPolicy,
        requestedTrustMode: options.trustMode,
        clock: options.clock,
        abortSignal: signal,
        timeoutMs: freshResolverTimeoutMs
      });
      const currentAdmission = buildExecutionAdmission({
        runContract: runContract(runId, fresh.plan),
        authority: authorityFor(current),
        binding: suppliedAdmission,
        now: currentDate(options.clock)
      }).admission;
      if (!same(currentAdmission, suppliedAdmission)) {
        throw new Error("Admission seal supplied an admission that is not the fresh current admission");
      }
      const existing = Object.hasOwn(current.seals, request.intentId) ? current.seals[request.intentId] : null;
      const requestShape = {
        runId: request.runId,
        handleId: request.handleId,
        intentId: request.intentId,
        admissionDigest: request.admissionDigest,
        authorityEpoch: request.authorityEpoch,
        fence: request.fence,
        outcome: request.outcome,
        effectDigest: request.effectDigest
      };
      if (existing) {
        const existingShape = {
          runId: existing.runId,
          handleId: existing.handleId,
          intentId: existing.intentId,
          admissionDigest: existing.admissionDigest,
          authorityEpoch: existing.authorityEpoch,
          fence: existing.fence,
          outcome: existing.outcome,
          effectDigest: existing.effectDigest
        };
        if (!same(existingShape, requestShape)) {
          const error = new Error("Admission seal replay conflicts with the durable CAS seal");
          error.code = "ESEAL_REPLAY";
          throw error;
        }
        return clone(existing);
      }
      for (const stored of Object.values(current.seals)) {
        if (stored.admissionDigest === request.admissionDigest && stored.intentId !== request.intentId) {
          const error = new Error("The exact V3 admission nonce/capability is already sealed for another intent");
          error.code = "ESEAL_REPLAY";
          throw error;
        }
      }
      const seal = {
        schemaVersion: 1,
        kind: "TrustedAdmissionSealV1",
        status: "committed",
        ...requestShape,
        committedAt: currentIso(options.clock)
      };
      validateTrustedAdmissionSeal(seal, requestShape);
      if (signal.aborted) throw boundedFailure("EOWNER_LOCK_ABORTED", "admission seal was aborted before persistence");
      current.seals[request.intentId] = seal;
      current.updatedAt = currentIso(options.clock);
      await writeState(root, runId, current, allocationKey, {
        expectedStateDigest,
        signal
      });
      return seal;
    }, allocationKey, { timeoutMs: STATE_CALLBACK_TIMEOUT_MS });
  };
  const readAdmissionSeal = async (request) => cooperativeSealObservation({
    root, runId, allocationKey, controllerId, request
  });
  const controller = brandTrustedNativeV3Controller(createTrustedControllerAdapter({
    readRunContract,
    readSourceBinding: readSource,
    readAuthority,
    readExecutionBinding,
    readStopAuthority,
    readControllerLifecycle: readLifecycle,
    commitEffectLaunch,
    authorizeEffectLaunch,
    commitAuthorizedEffectLaunch,
    resolveEffectLaunchTransaction,
    commitAdmissionSeal,
    readAdmissionSeal,
    trustBoundary: {
      id: controllerId,
      verify: async (request) => {
        if (request.authority?.kind === "TrustedStopAuthorityV1") {
          return cooperativeStopAuthorityAttestation({ root, runId, allocationKey, controllerId, ...request });
        }
        if (request.authority) return cooperativeAuthorityAttestation({ root, runId, allocationKey, controllerId, ...request });
        if (request.result) return cooperativeSealAttestation({ root, runId, allocationKey, controllerId, ...request });
        throw new Error("Cooperative trust boundary received an unknown attestation request");
      }
    },
    label: "cooperative-native-v3-controller"
  }));
  return {
    controller,
    binding: bindingFromState(state),
    authorityReceipt: {
      schemaVersion: 1,
      kind: "CooperativeControllerAuthorityReceiptV1",
      status: "active",
      trustMode: NATIVE_V3_COOPERATIVE_TRUST_MODE,
      controllerId,
      runId,
      planId: state.planId,
      taskId: state.taskId,
      unitId: state.unitId,
      ownedResourceId: state.ownedResourceId,
      authorityEpoch: state.authorityEpoch,
      fence: state.fence,
      nonce: state.nonce,
      envelopeDigest: state.approvalEnvelope.digest,
      issuedAt: state.createdAt
    },
    trustMode: NATIVE_V3_COOPERATIVE_TRUST_MODE
  };
}

/**
 * Rehydrate the trusted read side of an already approved allocation.  This
 * path is intentionally observation-only: it consumes the immutable,
 * controller-owned approval state and can issue no new approval, effect, or
 * process identity.  It exists for a recovery process that needs to query a
 * POSIX allocation after the original controller process has disappeared.
 */
export async function createCooperativeNativeV3RecoveryController(options = {}) {
  rejectUnknownOptions(options, [...COMMON_CONTROLLER_OPTIONS, "recoveryStorage", "requireHostTrust", "policyRequiresHostTrust"], "createCooperativeNativeV3RecoveryController options");
  requireCooperativeMode(options.trustMode);
  if (options.requireHostTrust === true || options.policyRequiresHostTrust === true) holdHostTrust();
  const root = resolveRoot(options.stateRoot);
  const runId = checkRequiredOption(options.runId, "runId");
  const planId = checkRequiredOption(options.planId, "planId");
  const taskId = checkRequiredOption(options.taskId, "taskId");
  const unitId = checkRequiredOption(options.unitId, "unitId");
  const allocationKey = normalizedAllocationKey(options.allocationKey, { taskId, attemptId: options.attemptId });
  const storageScope = recoveryStorageScope(options.recoveryStorage, allocationKey);
  const expectedExecutionId = checkRequiredOption(options.executionId, "executionId");
  const expectedAttemptId = checkRequiredOption(options.attemptId, "attemptId");
  const expectedSource = sourceBinding(options.sourceBinding);
  const expectedPolicy = policyDigest(options.policyDigest);
  const freshResolverTimeoutMs = freshResolverTimeout(options.freshResolverTimeoutMs);
  const state = await readActiveRecoveryState(root, runId, allocationKey, storageScope);
  if (state.planId !== planId || state.taskId !== taskId || state.unitId !== unitId ||
      state.executionId !== expectedExecutionId || state.attemptId !== expectedAttemptId ||
      state.sourceBinding.revision !== expectedSource.revision || state.sourceBinding.digest !== expectedSource.digest ||
      state.policyDigest !== expectedPolicy) {
    throw ownerApprovalError("EOWNER_RECOVERY_BINDING", "persisted controller allocation is not bound to the requested recovery scope");
  }
  const fresh = await readFreshPlan({
    root,
    planId,
    runId,
    expected: stateExpected(state),
    sourceBinding: state.sourceBinding,
    policyDigest: state.policyDigest,
    readFreshSourceBinding: options.readFreshSourceBinding,
    sourceCwd: options.sourceCwd,
    readTrustPolicy: options.readTrustPolicy,
    requestedTrustMode: options.trustMode,
    clock: options.clock,
    timeoutMs: freshResolverTimeoutMs
  });
  validateEnvelopeForPlan({
    envelope: state.approvalEnvelope,
    plan: fresh.plan,
    runId,
    taskId,
    unitId,
    source: fresh.sourceBinding,
    clock: options.clock
  });
  const controllerId = state.controllerId;
  const currentState = async ({ allowRevoked = false, allowSuperseded = false } = {}) => {
    const checked = validateRecoveryState(
      await readStateIfPresent(root, runId, allocationKey),
      runId,
      allocationKey,
      storageScope
    );
    if (!allowRevoked && checked.status !== "active") throw new Error("Cooperative recovery controller is not active");
    if (checked.controllerId !== controllerId || checked.planId !== planId || checked.taskId !== taskId || checked.unitId !== unitId ||
        checked.executionId !== expectedExecutionId || checked.attemptId !== expectedAttemptId ||
        checked.ownedResourceId !== state.ownedResourceId) {
      throw new Error("Cooperative recovery controller allocation changed");
    }
    if (!allowSuperseded) assertNoRecoverySuccessor(checked);
    return checked;
  };
  const freshFor = async (current) => readFreshPlan({
    root,
    planId: current.planId,
    runId,
    expected: stateExpected(current),
    sourceBinding: current.sourceBinding,
    policyDigest: current.policyDigest,
    readFreshSourceBinding: options.readFreshSourceBinding,
    sourceCwd: options.sourceCwd,
    readTrustPolicy: options.readTrustPolicy,
    requestedTrustMode: options.trustMode,
    clock: options.clock,
    timeoutMs: freshResolverTimeoutMs
  });
  const readExecutionBinding = async ({ runId: requestedRunId, binding }) => {
    if (requestedRunId !== runId) throw new Error("runId does not match the cooperative recovery controller");
    const current = await currentState();
    assertRequestMatchesState(binding, current);
    const currentFresh = await freshFor(current);
    validateEnvelopeForPlan({ envelope: current.approvalEnvelope, plan: currentFresh.plan, runId, taskId: current.taskId, unitId: current.unitId, source: currentFresh.sourceBinding, clock: options.clock });
    const authority = authorityFor(current);
    const currentRunContract = runContract(runId, currentFresh.plan);
    buildExecutionAdmission({ runContract: currentRunContract, authority, binding, now: currentDate(options.clock) });
    return {
      runContract: currentRunContract,
      sourceBinding: { runId, revision: currentFresh.sourceBinding.revision, digest: currentFresh.sourceBinding.digest },
      authority,
      // Preserve the same observation shape for a rehydrated controller.
      effectBindingDigest: current.ownerApprovalRequest.effectBindingDigest,
      launchReservation: current.launchReservation ?? null,
      launchAuthorization: current.launchAuthorization ?? null,
      launchCommitment: current.launchCommitment ?? null,
      launchTransaction: current.launchTransaction ?? null,
      launchResolution: current.launchResolution ?? null
    };
  };
  const readRunContract = async ({ runId: requestedRunId }) => {
    if (requestedRunId !== runId) throw new Error("runId does not match the cooperative recovery controller");
    const current = await currentState({ allowSuperseded: true });
    const currentFresh = await freshFor(current);
    return runContract(runId, currentFresh.plan);
  };
  const readSource = async ({ runId: requestedRunId }) => {
    if (requestedRunId !== runId) throw new Error("runId does not match the cooperative recovery controller");
    const current = await currentState({ allowSuperseded: true });
    const currentFresh = await freshFor(current);
    return { runId, revision: currentFresh.sourceBinding.revision, digest: currentFresh.sourceBinding.digest };
  };
  const readAuthority = async (request) => {
    const current = await currentState();
    assertRequestMatchesState(request, current);
    const currentFresh = await freshFor(current);
    validateEnvelopeForPlan({ envelope: current.approvalEnvelope, plan: currentFresh.plan, runId, taskId: current.taskId, unitId: current.unitId, source: currentFresh.sourceBinding, clock: options.clock });
    const authority = authorityFor(current);
    buildExecutionAdmission({ runContract: runContract(runId, currentFresh.plan), authority, binding: request, now: currentDate(options.clock) });
    return authority;
  };
  const readStopAuthority = async (request) => {
    const current = await currentState({ allowRevoked: true, allowSuperseded: true });
    assertStopRequestMatchesState(request, current);
    return stopProjectionFor(current);
  };
  const readLifecycle = async ({ runId: requestedRunId }) => {
    if (requestedRunId !== runId) throw new Error("runId does not match the cooperative recovery controller");
    const current = await currentState({ allowSuperseded: true });
    return {
      kind: "ControllerLifecycleObservationV1",
      runId,
      status: "active",
      incarnation: current.incarnation,
      ownerLeaseId: current.ownerLeaseId,
      previousIncarnation: null,
      previousOwnerLeaseId: null,
      observedAt: currentIso(options.clock)
    };
  };
  const readAdmissionSeal = async (request) => cooperativeSealObservation({
    root, runId, allocationKey, controllerId, request, storageScope
  });
  const controller = brandTrustedNativeV3Controller(createTrustedControllerAdapter({
    readRunContract,
    readSourceBinding: readSource,
    readAuthority,
    readExecutionBinding,
    readStopAuthority,
    readControllerLifecycle: readLifecycle,
    readAdmissionSeal,
    trustBoundary: {
      id: controllerId,
      verify: async (request) => {
        if (request.authority?.kind === "TrustedStopAuthorityV1") {
          return cooperativeStopAuthorityAttestation({ root, runId, allocationKey, controllerId, ...request, storageScope });
        }
        if (request.authority) return cooperativeAuthorityAttestation({ root, runId, allocationKey, controllerId, ...request, storageScope });
        if (request.result) return cooperativeSealAttestation({ root, runId, allocationKey, controllerId, ...request, storageScope });
        throw new Error("Cooperative recovery trust boundary received an unknown attestation request");
      }
    },
    label: "cooperative-native-v3-recovery-controller"
  }));
  return {
    controller,
    binding: bindingFromState(state),
    authorityReceipt: {
      schemaVersion: 1,
      kind: "CooperativeControllerRecoveryReceiptV1",
      status: "active",
      trustMode: NATIVE_V3_COOPERATIVE_TRUST_MODE,
      controllerId,
      runId,
      planId: state.planId,
      taskId: state.taskId,
      unitId: state.unitId,
      ownedResourceId: state.ownedResourceId,
      authorityEpoch: state.authorityEpoch,
      fence: state.fence,
      nonce: state.nonce,
      envelopeDigest: state.approvalEnvelope.digest,
      storageScope,
      issuedAt: state.createdAt
    },
    trustMode: NATIVE_V3_COOPERATIVE_TRUST_MODE
  };
}
