import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";
import {
  appendJournal,
  assertNoSymlinkUnder,
  atomicWriteJson,
  ensurePrivateDir,
  readJson,
  safeJoin,
  withRunLock
} from "./core.mjs";
import { assertPrivateStateBackendAvailableV1 } from "./private-state-backend-v1.mjs";
import { assertNativeV3AutoCommandExecutionAllowed } from "./native-v3-auto-execution-admission.mjs";
import {
  assertSameExecutionAdmission,
  buildExecutionAdmission,
  digestExecutionAdmission,
  isV3Authority,
  isV3RunContract,
  reservationKey,
  validateExecutionAdmission,
  validateTrustedAdmissionSeal
} from "./execution-admission-v1.mjs";

/**
 * V5 W1 execution identity foundation.
 *
 * This module is deliberately a registry and intent/fence layer only.  It
 * does not claim to terminate a process tree, own a cgroup, or implement a
 * Windows JobObject.  A trusted controller and an explicitly branded owned
 * resource adapter are required for those boundaries.
 */

export const EXECUTION_RUNTIME_SCHEMA_VERSION = 1;
export const EXECUTION_RUNTIME_KIND = "ExecutionRegistryV1";
export const EXECUTION_HANDLE_KIND = "ExecutionHandleV1";
export const STOP_REQUEST_KIND = "StopRequestV1";
export const STOP_RECEIPT_KIND = "StopReceiptV1";
export const RECOVERY_PLAN_KIND = "RecoveryPlanV1";
export const EXECUTION_EFFECT_NOT_SENT_KIND = "ExecutionEffectNotSentV1";
export const EXECUTION_RESOURCE_OBSERVATION_KIND = "ExecutionResourceObservationV1";
export const EXECUTION_RECONCILIATION_KIND = "ExecutionReconciliationV1";
export const EXECUTION_USAGE_OBSERVATION_KIND = "ExecutionUsageObservationV1";
export const EXECUTION_RECOVERY_HANDOFF_KIND = "ExecutionRecoveryHandoffV1";
export const EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND = "ExecutionRecoveryHandoffClaimV1";
export const EXECUTION_RECOVERY_TASK_RELEASE_KIND = "ExecutionRecoveryTaskReleaseV1";
export const EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND = "ExecutionRecoveryTaskPermitConsumptionV1";
export const EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND = "ExecutionRecoveryTaskEffectIntentV1";
export const EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND = "ExecutionRecoveryTaskEffectLaunchV1";
export const EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND = "ExecutionRecoveryTaskEffectOutcomeV1";
export const EXECUTION_RECOVERY_TASK_EFFECT_RECONCILIATION_KIND = "ExecutionRecoveryTaskEffectReconciliationV1";
export const EXECUTION_RECOVERY_TASK_EFFECT_RESOURCE_OBSERVATION_KIND = "ExecutionRecoveryTaskEffectResourceObservationV1";
export const EXECUTION_SEALED_EFFECT_ARTIFACT_KIND = "ExecutionSealedEffectArtifactV1";
export const EXECUTION_SEALED_EFFECT_EVIDENCE_V2_KIND = "ExecutionSealedEffectEvidenceV2";

const JOURNAL_EVENT = "execution-runtime.v1";
const JOURNAL_EVENT_SCHEMA_VERSION = 2;
const JOURNAL_EVENT_KIND = "ExecutionRegistryEventV2";
const LEGACY_JOURNAL_EVENT_SCHEMA_VERSION = 1;
const LEGACY_JOURNAL_EVENT_KIND = "ExecutionRegistryEventV1";
const RUNTIME_DIRECTORY = "execution-runtime-v1";
const MAX_SEALED_EFFECT_BYTES = 4 * 1024;
const RUN_ID_PATTERN = /^sbw-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;
const FENCE_PATTERN = /^[a-f0-9]{64}$/i;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const STOP_REASONS = new Set(["cancel", "pause", "security-p0", "controller-failure"]);
const LOCAL_STOP_OUTCOMES = new Set(["not-started", "stopped", "indeterminate", "unknown"]);
const REMOTE_STOP_OUTCOMES = new Set(["not-applicable", "not-sent", "stopped", "unknown"]);
const NOT_SENT_REASON = "authority-stale-before-effect";
const RECONCILE_QUERY_WAIT_MS = 10_000;
const RECOVERY_HANDOFF_EFFECT_AUTHORITY = Object.freeze({
  mayDispatch: false,
  mayPerformEffects: false
});
const RECOVERY_CLAIM_EFFECT_AUTHORITY = Object.freeze({
  mayUnblockHandle: false,
  mayDispatch: false,
  mayPerformEffects: false
});
const RECOVERY_TASK_RELEASE_EFFECT_AUTHORITY = Object.freeze({
  mayUnblockHandle: false,
  mayDispatch: false,
  mayPerformEffects: false
});
const RECOVERY_TASK_PERMIT_CONSUMPTION_EFFECT_AUTHORITY = Object.freeze({
  mayUnblockHandle: false,
  mayDispatch: false,
  mayPerformEffects: false
});
const RECOVERY_TASK_EFFECT_INTENT_EFFECT_AUTHORITY = Object.freeze({
  mayUnblockHandle: false,
  mayDispatch: false,
  mayPerformEffects: false
});
const RECOVERY_TASK_EFFECT_OBSERVATION_EFFECT_AUTHORITY = Object.freeze({
  mayUnblockHandle: false,
  mayDispatch: false,
  mayPerformEffects: false
});
const RECOVERY_TASK_EFFECT_OBSERVATION_SETTLEMENT_AUTHORITY = Object.freeze({
  maySettlePlan: false,
  mayReleaseDependencies: false
});
const SEALED_EFFECT_ARTIFACT_AUTHORITY = Object.freeze({
  mayDispatch: false,
  mayPerformEffects: false,
  maySettlePlan: false,
  mayReleaseDependencies: false
});
const RECOVERY_TASK_EFFECT_INTENT_STATUSES = new Set([
  "created", "dispatch-reserved", "not-sent", "unknown"
]);
const RECOVERY_TASK_EFFECT_NOT_SENT_REASONS = new Set([
  "authority-stale-before-effect",
  "owner-cancelled-before-effect",
  "reservation-aborted-before-effect"
]);
const RECOVERY_TASK_EFFECT_UNKNOWN_REASONS = new Set([
  "reservation-state-ambiguous",
  "durable-transition-ambiguous"
]);
const RECOVERY_TASK_EFFECT_OUTCOMES = new Set(["success", "failure", "unknown"]);
const RECOVERY_TASK_EFFECT_OUTCOME_UNKNOWN_REASONS = new Set([
  "launch-state-ambiguous",
  "effect-result-ambiguous",
  "controller-state-ambiguous",
  "durable-outcome-ambiguous"
]);

// A controller adapter is an authority-bearing capability.  A symbol property
// is insufficient here: Object.create(genuineAdapter), a Proxy, or a copied
// symbol can expose the same public shape while replacing its resolver.  The
// module-private set is identity-only and the factory freezes the genuine
// object before returning it.
const TRUSTED_CONTROLLERS = new WeakSet();
const OWNED_RESOURCE_ADAPTERS = new WeakSet();
// A not-sent result is authoritative only when this runtime instance created
// it after the durable intent transition succeeded.  Serialized or copied
// error fields are deliberately not accepted as proof by consumers.
const EFFECT_NOT_SENT_PROOFS = new WeakMap();
const REPLAY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const REPLAY_CACHE_MAX_ENTRIES = 8;
const validatedReplayCache = new Map();
let validatedReplayCacheBytes = 0;
const RECOVERY_HANDOFF_READ_LEASE = Symbol("execution-recovery-handoff-read-lease");

// Multiple task registries in one trusted DAG share the durable run lease.
// The filesystem lease remains the authority across processes; this bounded
// in-process queue prevents sibling registries in this Node process from
// racing that short CAS section and turning a normal overlap into a false
// UNKNOWN.  The queue never surrounds an external effect: execute() invokes
// the callback while the lease is held, then this queue entry is released as
// soon as withRunLock returns.
const RUNTIME_CRITICAL_SECTIONS = new Map();
const RUNTIME_CRITICAL_SECTION_WAIT_MS = 5_000;
// A trusted DAG may have many task registries, but no run may create an
// unbounded in-process backlog behind the durable lease.  This is a queue
// safety bound, not an authority decision; callers receive UNKNOWN when the
// bound is reached and must reconcile rather than silently retrying.
const RUNTIME_CRITICAL_SECTION_MAX_ACTIVE = 128;

function runtimeCriticalSectionTimeout() {
  const error = new Error("execution runtime critical section queue timed out before its callback started");
  error.code = "EEXECUTION_RUNTIME_QUEUE_TIMEOUT";
  error.status = "UNKNOWN";
  return error;
}

function runtimeCriticalSectionCapacity() {
  const error = new Error("execution runtime critical section queue is full");
  error.code = "EEXECUTION_RUNTIME_QUEUE_FULL";
  error.status = "UNKNOWN";
  return error;
}

function expireRuntimeCriticalEntry(section, entry, error) {
  if (!entry || entry.started || entry.cancelled) return false;
  entry.cancelled = true;
  const index = section.queue.indexOf(entry);
  if (index >= 0) section.queue.splice(index, 1);
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  section.active -= 1;
  entry.reject(error);
  return true;
}

async function pumpRuntimeCriticalSection(section) {
  if (section.running) return;
  section.running = true;
  try {
    while (section.queue.length > 0) {
      const entry = section.queue.shift();
      if (!entry || entry.cancelled) continue;
      // A delayed event loop can run this pump after the timeout callback was
      // due.  Check the actual deadline immediately before starting user
      // code; timer scheduling alone is not a validity proof.
      if (entry.deadlineAt <= Date.now()) {
        expireRuntimeCriticalEntry(section, entry, runtimeCriticalSectionTimeout());
        continue;
      }
      entry.started = true;
      if (entry.timer !== null) clearTimeout(entry.timer);
      try {
        entry.resolve(await entry.callback());
      } catch (error) {
        entry.reject(error);
      } finally {
        section.active -= 1;
      }
    }
  } finally {
    section.running = false;
    if (section.active === 0 && section.queue.length === 0 && RUNTIME_CRITICAL_SECTIONS.get(section.key) === section) {
      RUNTIME_CRITICAL_SECTIONS.delete(section.key);
    }
  }
}

function enqueueRuntimeCriticalSection(root, runId, callback) {
  const key = `${path.resolve(root)}\u0000${runId}`;
  let section = RUNTIME_CRITICAL_SECTIONS.get(key);
  if (!section) {
    section = { key, queue: [], running: false, active: 0 };
    RUNTIME_CRITICAL_SECTIONS.set(key, section);
  }
  if (section.active >= RUNTIME_CRITICAL_SECTION_MAX_ACTIVE) {
    if (section.active === 0 && section.queue.length === 0 && !section.running && RUNTIME_CRITICAL_SECTIONS.get(key) === section) {
      RUNTIME_CRITICAL_SECTIONS.delete(key);
    }
    return Promise.reject(runtimeCriticalSectionCapacity());
  }
  section.active += 1;
  return new Promise((resolve, reject) => {
    const entry = {
      callback,
      resolve,
      reject,
      started: false,
      cancelled: false,
      timer: null,
      deadlineAt: Date.now() + RUNTIME_CRITICAL_SECTION_WAIT_MS
    };
    entry.timer = setTimeout(() => {
      if (!expireRuntimeCriticalEntry(section, entry, runtimeCriticalSectionTimeout())) return;
      if (!section.running) void pumpRuntimeCriticalSection(section);
      if (section.active === 0 && section.queue.length === 0 && !section.running && RUNTIME_CRITICAL_SECTIONS.get(key) === section) {
        RUNTIME_CRITICAL_SECTIONS.delete(key);
      }
    }, RUNTIME_CRITICAL_SECTION_WAIT_MS);
    section.queue.push(entry);
    void pumpRuntimeCriticalSection(section);
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOwnDataObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) throw new Error(`${label} contains an accessor property`);
  }
  return value;
}

function assertSafeObject(value, label, seen = new Set()) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  if (seen.has(value)) throw new Error(`${label} must not contain cycles`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${label} contains forbidden key: ${key}`);
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === "object") assertSafeObject(item, `${label}.${key}`, seen);
      } else {
        assertSafeObject(child, `${label}.${key}`, seen);
      }
    }
  }
  seen.delete(value);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function executionEffectNotSentError(cause, proof) {
  const error = new Error(`Execution effect was not sent: ${cause?.message ?? String(cause)}`);
  error.code = "EFFECT_NOT_SENT";
  EFFECT_NOT_SENT_PROOFS.set(error, proof);
  return error;
}

function executionEffectStatusUnknownError(cause, proofError = undefined) {
  const error = new Error(
    `Execution effect status is UNKNOWN; durable not-sent proof is unavailable: ${cause?.message ?? String(cause)}`
  );
  error.code = "EEXECUTION_EFFECT_UNKNOWN";
  error.status = "UNKNOWN";
  error.cause = cause;
  if (proofError !== undefined) error.proofError = proofError;
  return error;
}

export function isExecutionRuntimeEffectNotSent(error, expected = undefined) {
  if (!error || error.code !== "EFFECT_NOT_SENT") return false;
  const proof = EFFECT_NOT_SENT_PROOFS.get(error);
  if (!proof || proof.schemaVersion !== 1 || proof.kind !== EXECUTION_EFFECT_NOT_SENT_KIND ||
      proof.status !== "not-sent" || proof.callbackCalls !== 0 || proof.dispatchReserved !== false ||
      typeof proof.runId !== "string" || typeof proof.handleId !== "string" ||
      typeof proof.intentId !== "string" || typeof proof.ownedResourceId !== "string" ||
      typeof proof.notSentAt !== "string" || typeof proof.notSentReason !== "string" ||
      !Number.isSafeInteger(proof.stateSequence) || !DIGEST_PATTERN.test(proof.stateDigest)) {
    return false;
  }
  if (expected !== undefined) {
    if (!expected || proof.runId !== expected.runId || proof.handleId !== expected.handleId ||
        proof.ownedResourceId !== expected.ownedResourceId ||
        (expected.intentId !== undefined && proof.intentId !== expected.intentId)) return false;
  }
  return true;
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function assertText(value, label, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  if (pattern && !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assertId(value, label) {
  return assertText(value, label, ID_PATTERN);
}

function assertDigest(value, label) {
  return assertText(value, label, DIGEST_PATTERN);
}

function assertFence(value, label = "fence") {
  return assertText(value, label, FENCE_PATTERN);
}

function assertRevision(value, label = "revision") {
  return assertText(value, label, REVISION_PATTERN);
}

function assertEpoch(value, label = "authorityEpoch") {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
  return value;
}

function assertIso(value, label) {
  assertText(value, label);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function nowIso(clock) {
  const value = clock?.now?.();
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error("Clock returned an invalid time");
  return date.toISOString();
}

function safeClock(clock) {
  if (clock === undefined) return { now: () => new Date() };
  assertOwnDataObject(clock, "clock");
  exactKeys(clock, ["now"], "clock");
  const descriptor = Object.getOwnPropertyDescriptor(clock, "now");
  if (!descriptor || descriptor.get || descriptor.set || typeof descriptor.value !== "function") {
    throw new Error("clock must expose one own data-function now()");
  }
  return Object.freeze({ now: descriptor.value.bind(clock) });
}

function monotonicNowNs() {
  if (typeof process?.hrtime?.bigint !== "function") return null;
  return process.hrtime.bigint();
}

function validateAbortSignal(value, label = "abortSignal") {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function" || typeof value.removeEventListener !== "function") {
    throw new Error(`${label} must be an AbortSignal`);
  }
  return value;
}

function bindingFromInput(value, { label = "execution binding", allowRunId = true } = {}) {
  assertSafeObject(value, label);
  const binding = {
    runId: value.runId,
    executionId: value.executionId,
    attemptId: value.attemptId,
    unitId: value.unitId,
    sourceBindingDigest: value.sourceBindingDigest,
    policyDigest: value.policyDigest,
    revision: value.revision,
    ...(value.ownedResourceId === undefined ? {} : { ownedResourceId: value.ownedResourceId })
  };
  if (allowRunId) {
    if (typeof binding.runId !== "string" || !RUN_ID_PATTERN.test(binding.runId)) throw new Error(`${label}.runId is invalid`);
  }
  assertId(binding.executionId, `${label}.executionId`);
  assertId(binding.attemptId, `${label}.attemptId`);
  assertId(binding.unitId, `${label}.unitId`);
  assertDigest(binding.sourceBindingDigest, `${label}.sourceBindingDigest`);
  assertDigest(binding.policyDigest, `${label}.policyDigest`);
  assertRevision(binding.revision, `${label}.revision`);
  if (binding.ownedResourceId !== undefined) assertId(binding.ownedResourceId, `${label}.ownedResourceId`);
  return binding;
}

function bindingForHandle(handle) {
  return bindingFromInput(handle, { label: "ExecutionHandleV1" });
}

function publicBinding(binding) {
  return Object.freeze({ ...binding });
}

function authorityScope(binding) {
  return {
    runId: binding.runId,
    executionId: binding.executionId,
    attemptId: binding.attemptId,
    unitId: binding.unitId,
    sourceBindingDigest: binding.sourceBindingDigest,
    policyDigest: binding.policyDigest,
    revision: binding.revision,
    ...(binding.ownedResourceId === undefined ? {} : { ownedResourceId: binding.ownedResourceId })
  };
}

function validateAuthority(value, requested, label = "trusted controller authority") {
  assertSafeObject(value, label);
  if (isV3Authority(value) && (value.approved === true || value.issuer !== undefined || value.signer !== undefined)) {
    throw new Error(`${label} cannot establish V3 admission from caller approval, issuer, or signer fields`);
  }
  if (value.kind !== "TrustedExecutionAuthorityV1") throw new Error(`${label} kind is invalid`);
  if (value.status !== "active" || value.revoked !== false) throw new Error(`${label} is not currently active`);
  const authorityBinding = bindingFromInput(value, { label, allowRunId: true });
  if (!same(authorityScope(authorityBinding), authorityScope(requested))) throw new Error(`${label} scope does not match the requested execution`);
  assertEpoch(value.authorityEpoch, `${label}.authorityEpoch`);
  assertFence(value.fence, `${label}.fence`);
  assertDigest(value.capabilityDigest, `${label}.capabilityDigest`);
  assertDigest(value.envelopeDigest, `${label}.envelopeDigest`);
  if (!isPlainObject(value.envelope)) throw new Error(`${label}.envelope is required`);
  assertSafeObject(value.envelope, `${label}.envelope`);
  if (value.envelope.digest !== value.envelopeDigest) throw new Error(`${label}.envelope digest is not bound`);
  // Legacy authorities carry the runtime binding as their envelope scope.
  // V3 authorities carry a native contract scope; execution-admission-v1
  // validates that scope against the attested TaskContractV3 instead.
  if (value.envelope.kind !== "ApprovalEnvelope" && !same(value.envelope.scope, authorityScope(requested))) {
    throw new Error(`${label}.envelope scope does not match`);
  }
  if (value.expiresAt !== undefined) {
    assertIso(value.expiresAt, `${label}.expiresAt`);
    if (Date.parse(value.expiresAt) <= Date.now()) throw new Error(`${label} has expired`);
  }
  return {
    ...authorityBinding,
    status: "active",
    revoked: false,
    authorityEpoch: value.authorityEpoch,
    fence: value.fence,
    capabilityDigest: value.capabilityDigest,
    envelopeDigest: value.envelopeDigest,
    expiresAt: value.expiresAt ?? null,
    envelope: clone(value.envelope),
    ...(value.capability === undefined ? {} : { capability: clone(value.capability) }),
    ...(value.planDigest === undefined ? {} : { planDigest: value.planDigest }),
    ...(value.contractDigest === undefined ? {} : { contractDigest: value.contractDigest }),
    ...(value.nonce === undefined ? {} : { nonce: value.nonce })
  };
}

function validateStopAuthority(value, requested, label = "trusted stop authority") {
  assertSafeObject(value, label);
  const expectedKeys = [
    "kind", "status", "revoked", "runId", "executionId", "attemptId", "unitId", "ownedResourceId",
    "capabilityDigest", "envelopeDigest", "envelope"
  ];
  exactKeys(value, expectedKeys, label);
  if (value.kind !== "TrustedStopAuthorityV1" || value.status !== "active" || value.revoked !== false) throw new Error(`${label} is not active`);
  for (const key of ["runId", "executionId", "attemptId", "unitId", "ownedResourceId"]) assertId(value[key], `${label}.${key}`);
  if (value.runId !== requested.runId || value.executionId !== requested.executionId || value.attemptId !== requested.attemptId ||
      value.unitId !== requested.unitId || value.ownedResourceId !== requested.ownedResourceId) {
    throw new Error(`${label} scope does not match the owned handle`);
  }
  assertDigest(value.capabilityDigest, `${label}.capabilityDigest`);
  assertDigest(value.envelopeDigest, `${label}.envelopeDigest`);
  if (!isPlainObject(value.envelope) || value.envelope.digest !== value.envelopeDigest ||
      !same(value.envelope.scope, {
        runId: requested.runId,
        executionId: requested.executionId,
        attemptId: requested.attemptId,
        unitId: requested.unitId,
        ownedResourceId: requested.ownedResourceId
      })) throw new Error(`${label}.envelope is not bound to the owned scope`);
  return value;
}

function validateRunContract(value, requested, label = "run contract") {
  assertSafeObject(value, label);
  if (value.runId !== requested.runId) throw new Error(`${label}.runId does not match`);
  if (value.revision !== requested.revision) throw new Error(`${label}.revision does not match`);
  if (value.sourceBindingDigest !== requested.sourceBindingDigest) throw new Error(`${label}.sourceBindingDigest does not match`);
  if (value.policyDigest !== requested.policyDigest) throw new Error(`${label}.policyDigest does not match`);
  if (value.status !== undefined && value.status !== "active" && value.status !== "running") throw new Error(`${label} is not active`);
  return value;
}

function validateSourceBinding(value, requested, label = "source binding") {
  assertSafeObject(value, label);
  if (value.runId !== requested.runId) throw new Error(`${label}.runId does not match`);
  if (value.revision !== requested.revision) throw new Error(`${label}.revision does not match`);
  if (value.digest !== requested.sourceBindingDigest && value.sourceBindingDigest !== requested.sourceBindingDigest) {
    throw new Error(`${label}.digest does not match`);
  }
  return value;
}

function validateControllerLifecycle(value, runId, label = "controller lifecycle") {
  assertSafeObject(value, label);
  const keys = ["kind", "runId", "status", "incarnation", "ownerLeaseId", "previousIncarnation", "previousOwnerLeaseId", "observedAt"];
  exactKeys(value, keys, label);
  if (value.kind !== "ControllerLifecycleObservationV1" || value.runId !== runId) throw new Error(`${label} identity is invalid`);
  if (!["active", "terminated"].includes(value.status)) throw new Error(`${label}.status is invalid`);
  assertId(value.incarnation, `${label}.incarnation`);
  assertId(value.ownerLeaseId, `${label}.ownerLeaseId`);
  if (value.previousIncarnation !== null) assertId(value.previousIncarnation, `${label}.previousIncarnation`);
  if (value.previousOwnerLeaseId !== null) assertId(value.previousOwnerLeaseId, `${label}.previousOwnerLeaseId`);
  assertIso(value.observedAt, `${label}.observedAt`);
  if (value.status === "active" && (value.previousIncarnation !== null || value.previousOwnerLeaseId !== null)) {
    throw new Error(`${label} active observation cannot contain a terminated predecessor`);
  }
  if (value.status === "terminated" && (!value.previousIncarnation || !value.previousOwnerLeaseId)) {
    throw new Error(`${label} terminated observation must identify the terminated owner lease`);
  }
  return value;
}

function validateExecutionResourceObservation(value, expected = undefined, label = EXECUTION_RESOURCE_OBSERVATION_KIND) {
  assertSafeObject(value, label);
  exactKeys(value, [
    "schemaVersion", "kind", "observationId", "runId", "handleId", "intentId", "executionId", "attemptId", "unitId",
    "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence", "ownedResourceId",
    "controllerStatus", "providerOutcome", "businessOutcome", "observedAt", "evidenceDigest"
  ], label);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_RESOURCE_OBSERVATION_KIND) {
    throw new Error(`${label} version/kind is invalid`);
  }
  assertId(value.observationId, `${label}.observationId`);
  const binding = bindingFromInput(value, { label });
  assertId(value.handleId, `${label}.handleId`);
  assertId(value.intentId, `${label}.intentId`);
  assertEpoch(value.authorityEpoch, `${label}.authorityEpoch`);
  assertFence(value.fence, `${label}.fence`);
  assertId(value.ownedResourceId, `${label}.ownedResourceId`);
  if (!["active", "terminated", "unknown"].includes(value.controllerStatus)) {
    throw new Error(`${label}.controllerStatus is invalid`);
  }
  if (!["not-sent", "active", "completed", "failed", "unknown"].includes(value.providerOutcome)) {
    throw new Error(`${label}.providerOutcome is invalid`);
  }
  if (value.businessOutcome !== null && !["success", "failure", "unknown"].includes(value.businessOutcome)) {
    throw new Error(`${label}.businessOutcome is invalid`);
  }
  if (value.businessOutcome !== null && !["completed", "failed"].includes(value.providerOutcome)) {
    throw new Error(`${label}.businessOutcome is not bound to a provider outcome`);
  }
  assertIso(value.observedAt, `${label}.observedAt`);
  assertDigest(value.evidenceDigest, `${label}.evidenceDigest`);
  if (expected !== undefined && expected !== null) {
    const expectedBinding = bindingFromInput(expected, { label: `${label} expected binding` });
    for (const key of [
      "runId", "executionId", "attemptId", "unitId", "sourceBindingDigest", "policyDigest", "revision", "ownedResourceId"
    ]) {
      if (key === "ownedResourceId" && expectedBinding.ownedResourceId === undefined) continue;
      if (binding[key] !== expectedBinding[key]) throw new Error(`${label}.${key} does not match the requested execution`);
    }
    if (value.handleId !== expected.handleId) throw new Error(`${label}.handleId does not match the requested handle`);
    if (value.intentId !== expected.intentId) throw new Error(`${label}.intentId does not match the requested intent`);
    if (value.authorityEpoch !== expected.authorityEpoch || value.fence !== expected.fence) {
      throw new Error(`${label} authority is not bound to the requested handle`);
    }
  }
  return { ...value, ...binding };
}

export function validateExecutionResourceObservationV1(value, expected = undefined) {
  return validateExecutionResourceObservation(value, expected);
}

function validateExecutionUsageObservation(value, expected = undefined, label = EXECUTION_USAGE_OBSERVATION_KIND) {
  assertSafeObject(value, label);
  exactKeys(value, [
    "schemaVersion", "kind", "observationId", "runId", "handleId", "intentId", "executionId", "attemptId", "unitId",
    "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence", "ownedResourceId", "attempts",
    "elapsedMs", "monotonicClock", "measurementWindow", "observedAt", "observationDigest"
  ], label);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_USAGE_OBSERVATION_KIND) {
    throw new Error(`${label} version/kind is invalid`);
  }
  assertId(value.observationId, `${label}.observationId`);
  const binding = bindingFromInput(value, { label });
  assertId(value.handleId, `${label}.handleId`);
  assertId(value.intentId, `${label}.intentId`);
  assertEpoch(value.authorityEpoch, `${label}.authorityEpoch`);
  assertFence(value.fence, `${label}.fence`);
  assertId(value.ownedResourceId, `${label}.ownedResourceId`);
  if (value.attempts !== 1) throw new Error(`${label}.attempts must be exactly one`);
  if (!Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0) {
    throw new Error(`${label}.elapsedMs is invalid`);
  }
  if (value.monotonicClock !== "process.hrtime.bigint") throw new Error(`${label}.monotonicClock is invalid`);
  if (value.measurementWindow !== "trusted-effect-callback") throw new Error(`${label}.measurementWindow is invalid`);
  assertIso(value.observedAt, `${label}.observedAt`);
  assertDigest(value.observationDigest, `${label}.observationDigest`);
  const { observationDigest: suppliedDigest, ...body } = value;
  if (digestObject(body) !== suppliedDigest) throw new Error(`${label}.observationDigest is not bound`);
  if (expected !== undefined && expected !== null) {
    const expectedBinding = bindingFromInput(expected, { label: `${label} expected binding` });
    for (const key of [
      "runId", "executionId", "attemptId", "unitId", "sourceBindingDigest", "policyDigest", "revision", "ownedResourceId"
    ]) {
      if (expectedBinding[key] === undefined) continue;
      if (binding[key] !== expectedBinding[key]) throw new Error(`${label}.${key} does not match the requested execution`);
    }
    if (expected.handleId !== undefined && value.handleId !== expected.handleId) {
      throw new Error(`${label}.handleId does not match the requested handle`);
    }
    if (expected.intentId !== undefined && value.intentId !== expected.intentId) {
      throw new Error(`${label}.intentId does not match the requested intent`);
    }
    if (expected.authorityEpoch !== undefined && value.authorityEpoch !== expected.authorityEpoch) {
      throw new Error(`${label}.authorityEpoch does not match the requested handle`);
    }
    if (expected.fence !== undefined && value.fence !== expected.fence) {
      throw new Error(`${label}.fence does not match the requested handle`);
    }
  }
  return { ...value, ...binding };
}

export function validateExecutionUsageObservationV1(value, expected = undefined) {
  return validateExecutionUsageObservation(value, expected);
}

function createExecutionUsageObservation(handle, intent, startedAt, clock) {
  const endedAt = monotonicNowNs();
  if (startedAt === null || endedAt === null || endedAt < startedAt) return null;
  const elapsedNs = endedAt - startedAt;
  const elapsedMsBig = (elapsedNs + 999_999n) / 1_000_000n;
  if (elapsedMsBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const body = {
    schemaVersion: 1,
    kind: EXECUTION_USAGE_OBSERVATION_KIND,
    observationId: randomUUID(),
    runId: handle.runId,
    handleId: handle.handleId,
    intentId: intent.intentId,
    executionId: handle.executionId,
    attemptId: handle.attemptId,
    unitId: handle.unitId,
    sourceBindingDigest: handle.sourceBindingDigest,
    policyDigest: handle.policyDigest,
    revision: handle.revision,
    authorityEpoch: handle.authorityEpoch,
    fence: handle.fence,
    ownedResourceId: handle.ownedResourceId,
    attempts: 1,
    elapsedMs: Number(elapsedMsBig),
    monotonicClock: "process.hrtime.bigint",
    measurementWindow: "trusted-effect-callback",
    observedAt: nowIso(clock)
  };
  const observation = { ...body, observationDigest: digestObject(body) };
  return validateExecutionUsageObservation(observation, {
    ...bindingForHandle(handle),
    handleId: handle.handleId,
    intentId: intent.intentId,
    authorityEpoch: handle.authorityEpoch,
    fence: handle.fence
  });
}

function validateExecutionReconciliation(value, expected = undefined, label = EXECUTION_RECONCILIATION_KIND) {
  assertSafeObject(value, label);
  exactKeys(value, [
    "schemaVersion", "kind", "reconciliationId", "intentId", "handleId", "runId", "decision",
    "observation", "reconciledAt", "reconciliationDigest"
  ], label);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_RECONCILIATION_KIND) {
    throw new Error(`${label} version/kind is invalid`);
  }
  assertId(value.reconciliationId, `${label}.reconciliationId`);
  assertId(value.intentId, `${label}.intentId`);
  assertId(value.handleId, `${label}.handleId`);
  if (!RUN_ID_PATTERN.test(value.runId)) throw new Error(`${label}.runId is invalid`);
  if (!["retryable", "completed", "hold"].includes(value.decision)) throw new Error(`${label}.decision is invalid`);
  const observation = validateExecutionResourceObservation(value.observation, expected ? {
    ...expected,
    handleId: value.handleId,
    intentId: value.intentId
  } : undefined, `${label}.observation`);
  assertIso(value.reconciledAt, `${label}.reconciledAt`);
  assertDigest(value.reconciliationDigest, `${label}.reconciliationDigest`);
  const body = {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    reconciliationId: value.reconciliationId,
    intentId: value.intentId,
    handleId: value.handleId,
    runId: value.runId,
    decision: value.decision,
    observation,
    reconciledAt: value.reconciledAt
  };
  if (digestObject(body) !== value.reconciliationDigest) {
    throw new Error(`${label}.reconciliationDigest is not bound to the observation`);
  }
  const retryable = observation.controllerStatus === "terminated" &&
    observation.providerOutcome === "not-sent" && observation.businessOutcome === null;
  // A provider-completed observation is a terminal effect fact.  It is kept
  // separate from business outcome: the latter may still be UNKNOWN, and the
  // execution remains non-retryable until a caller has an independent policy
  // decision for the business obligation.
  const completed = observation.controllerStatus !== "active" && observation.providerOutcome === "completed";
  if ((value.decision === "retryable") !== retryable ||
      (value.decision === "completed") !== completed ||
      (value.decision === "hold" && (retryable || completed))) {
    throw new Error(`${label}.decision does not match the provider observation`);
  }
  if (expected !== undefined && expected !== null) {
    if (value.runId !== expected.runId || value.handleId !== expected.handleId || value.intentId !== expected.intentId) {
      throw new Error(`${label} identity is not bound to the requested intent`);
    }
  }
  return { ...value, observation };
}

export function validateExecutionReconciliationV1(value, expected = undefined) {
  return validateExecutionReconciliation(value, expected);
}

function validateController(controller) {
  if (!isTrustedControllerAdapter(controller)) {
    throw new Error("A trusted controller adapter is required; caller booleans cannot establish current admission");
  }
  return controller;
}

// This predicate is intentionally backed by the module-private brand.  It is
// used by the POSIX adapter when it mints its resource observation capability;
// a caller cannot turn an arbitrary object or serialized controller response
// into that capability by copying the public shape.
export function isTrustedControllerAdapter(value) {
  return Boolean(value && (typeof value === "object" || typeof value === "function") && TRUSTED_CONTROLLERS.has(value));
}

// Resource adapters carry the runtime's private identity through this module.
// Consumers may inspect the public kind/label, but only the exact frozen
// object made by this factory is eligible for a controller-owned recovery
// operation.  A Proxy, derived object, copied object, or deserialized shape
// is deliberately not an adapter.
export function isTrustedOwnedResourceAdapter(value) {
  return Boolean(value && (typeof value === "object" || typeof value === "function") && OWNED_RESOURCE_ADAPTERS.has(value));
}

function validateObservedAuthority(value, label = "observed authority") {
  assertSafeObject(value, label);
  exactKeys(value, ["authorityEpoch", "fence"], label);
  assertEpoch(value.authorityEpoch, `${label}.authorityEpoch`);
  assertFence(value.fence, `${label}.fence`);
  return value;
}

function observedAuthorityFor(authority) {
  return {
    authorityEpoch: assertEpoch(authority.authorityEpoch, "observed authority.authorityEpoch"),
    fence: assertFence(authority.fence, "observed authority.fence")
  };
}

export function createTrustedControllerAdapter({
  readRunContract,
  readSourceBinding,
  readAuthority,
  readExecutionBinding = null,
  readStopAuthority = null,
  readControllerLifecycle = null,
  commitEffectLaunch = null,
  authorizeEffectLaunch = null,
  commitAuthorizedEffectLaunch = null,
  resolveEffectLaunchTransaction = null,
  commitAdmissionSeal = null,
  readAdmissionSeal = null,
  trustBoundary,
  label = "trusted-controller-v1"
} = {}) {
  if (typeof readRunContract !== "function" || typeof readSourceBinding !== "function" || typeof readAuthority !== "function") {
    throw new Error("Trusted controller adapter requires readRunContract, readSourceBinding, and readAuthority");
  }
  if (readExecutionBinding !== null && typeof readExecutionBinding !== "function") {
    throw new Error("readExecutionBinding must be a function when provided");
  }
  if (!isPlainObject(trustBoundary) || typeof trustBoundary.verify !== "function") {
    throw new Error("Trusted controller adapter requires an explicit trustBoundary verifier (TCB seam)");
  }
  if (readControllerLifecycle !== null && typeof readControllerLifecycle !== "function") {
    throw new Error("readControllerLifecycle must be a function when provided");
  }
  if (readStopAuthority !== null && typeof readStopAuthority !== "function") {
    throw new Error("readStopAuthority must be a function when provided");
  }
  if (commitAdmissionSeal !== null && typeof commitAdmissionSeal !== "function") {
    throw new Error("commitAdmissionSeal must be a function when provided");
  }
  if (readAdmissionSeal !== null && typeof readAdmissionSeal !== "function") {
    throw new Error("readAdmissionSeal must be a function when provided");
  }
  if (commitEffectLaunch !== null && typeof commitEffectLaunch !== "function") {
    throw new Error("commitEffectLaunch must be a function when provided");
  }
  if (authorizeEffectLaunch !== null && typeof authorizeEffectLaunch !== "function") {
    throw new Error("authorizeEffectLaunch must be a function when provided");
  }
  if (commitAuthorizedEffectLaunch !== null && typeof commitAuthorizedEffectLaunch !== "function") {
    throw new Error("commitAuthorizedEffectLaunch must be a function when provided");
  }
  if (resolveEffectLaunchTransaction !== null && typeof resolveEffectLaunchTransaction !== "function") {
    throw new Error("resolveEffectLaunchTransaction must be a function when provided");
  }
  const controllerId = assertId(trustBoundary.id ?? label, "trust boundary controller id");
  const adapter = {
    kind: "TrustedExecutionControllerAdapterV1",
    controllerId,
    label: assertText(label, "controller label"),
    async readRunContract(request) {
      return clone(await readRunContract(clone(request)));
    },
    async readSourceBinding(request) {
      return clone(await readSourceBinding(clone(request)));
    },
    async readAuthority(request) {
      const authority = clone(await readAuthority(clone(request)));
      const authorityDigest = digestObject(authority);
      const attestation = await trustBoundary.verify({
        request: clone(request),
        authority: clone(authority),
        authorityDigest
      });
      if (!isPlainObject(attestation) || Object.keys(attestation).sort().join("\0") !== "authorityDigest\0controllerId\0kind" ||
          attestation.kind !== "TrustedControllerAttestationV1" || attestation.controllerId !== controllerId ||
          attestation.authorityDigest !== authorityDigest) {
        throw new Error("Trusted controller TCB did not attest the exact authority response");
      }
      return authority;
    },
    ...(readExecutionBinding === null ? {} : {
      async readExecutionBinding(request) {
        const supplied = clone(request);
        const authorityRequest = supplied?.binding ?? supplied;
        const value = clone(await readExecutionBinding(supplied));
        if (!isPlainObject(value) || !isPlainObject(value.authority)) {
          throw new Error("Trusted controller execution binding is invalid");
        }
        const authority = value.authority;
        const authorityDigest = digestObject(authority);
        const attestation = await trustBoundary.verify({
          request: clone(authorityRequest),
          authority: clone(authority),
          authorityDigest
        });
        if (!isPlainObject(attestation) || Object.keys(attestation).sort().join("\0") !== "authorityDigest\0controllerId\0kind" ||
            attestation.kind !== "TrustedControllerAttestationV1" || attestation.controllerId !== controllerId ||
            attestation.authorityDigest !== authorityDigest) {
          throw new Error("Trusted controller TCB did not attest the exact authority response");
        }
        return value;
      }
    }),
    ...(readStopAuthority === null ? {} : {
      async readStopAuthority(request) {
        const authority = clone(await readStopAuthority(clone(request)));
        const authorityDigest = digestObject(authority);
        const attestation = await trustBoundary.verify({
          request: clone(request),
          authority: clone(authority),
          authorityDigest
        });
        if (!isPlainObject(attestation) || Object.keys(attestation).sort().join("\0") !== "authorityDigest\0controllerId\0kind" ||
            attestation.kind !== "TrustedControllerAttestationV1" || attestation.controllerId !== controllerId ||
            attestation.authorityDigest !== authorityDigest) {
          throw new Error("Trusted controller TCB did not attest the exact stop authority response");
        }
        return authority;
      }
    }),
    ...(readControllerLifecycle === null ? {} : {
      async readControllerLifecycle(request) {
        return clone(await readControllerLifecycle(clone(request)));
      }
    }),
    ...(commitEffectLaunch === null ? {} : {
      async commitEffectLaunch(request) {
        // This operation is deliberately kept separate from admission seals:
        // the native producer uses it as the durable launch reservation
        // boundary, before an owned POSIX process receives its launch frame.
        // The caller receives only the producer's cloned, typed reservation;
        // it cannot establish one by copying this public shape.  Actual POSIX
        // effect ordering is handled by commitAuthorizedEffectLaunch below.
        return clone(await commitEffectLaunch(clone(request)));
      }
    }),
    ...(authorizeEffectLaunch === null ? {} : {
      async authorizeEffectLaunch(request) {
        // The native producer owns this second, revocation-linearized gate.
        // It is intentionally only a cloned producer result; callers cannot
        // mint an authorization by constructing the public response shape.
        return clone(await authorizeEffectLaunch(clone(request)));
      }
    }),
    ...(commitAuthorizedEffectLaunch === null ? {} : {
      async commitAuthorizedEffectLaunch(request, launchEffect) {
        // This is the producer-owned effect transaction boundary.  The
        // trusted adapter holds its state lock while the internal launcher
        // performs the owned spawn and returns its exact acknowledgement;
        // callers cannot create a commitment by copying its public shape.
        // The launcher is an internal owned-process transaction callback,
        // rather than a source of authority or a caller-supplied approval.
        if (typeof launchEffect !== "function") throw new Error("commitAuthorizedEffectLaunch requires the trusted owned launcher");
        return clone(await commitAuthorizedEffectLaunch(clone(request), launchEffect));
      }
    }),
    ...(resolveEffectLaunchTransaction === null ? {} : {
      async resolveEffectLaunchTransaction(request, resourceAdapter) {
        if (!isTrustedOwnedResourceAdapter(resourceAdapter) ||
            typeof resourceAdapter.resolveOwnedLaunch !== "function") {
          throw new Error("resolveEffectLaunchTransaction requires a trusted owned resource adapter");
        }
        // The resource adapter is an internal producer object.  The caller
        // may provide no callback or result; it can only ask the controller
        // to resolve through the adapter's own branded cleanup path.
        return clone(await resolveEffectLaunchTransaction(clone(request), resourceAdapter));
      }
    }),
    ...(commitAdmissionSeal === null ? {} : {
      async commitAdmissionSeal(request) {
        const result = clone(await commitAdmissionSeal(clone(request)));
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
        const commitDigest = digestObject(result);
        const attestation = await trustBoundary.verify({
          request: clone(request),
          result: clone(result),
          commitDigest
        });
        if (!isPlainObject(attestation) || Object.keys(attestation).sort().join("\0") !== "commitDigest\0controllerId\0kind" ||
            attestation.kind !== "TrustedAdmissionSealAttestationV1" || attestation.controllerId !== controllerId ||
            attestation.commitDigest !== commitDigest) {
          throw new Error("Trusted controller TCB did not attest the exact admission seal");
        }
        return result;
      }
    }),
    ...(readAdmissionSeal === null ? {} : {
      async readAdmissionSeal(request) {
        assertOwnDataObject(request, "trusted admission seal read request");
        exactKeys(request, [
          "runId", "handleId", "intentId", "admissionDigest", "authorityEpoch", "fence", "outcome", "effectDigest"
        ], "trusted admission seal read request");
        const result = clone(await readAdmissionSeal(clone(request)));
        validateTrustedAdmissionSeal(result, request);
        const commitDigest = digestObject(result);
        const attestation = await trustBoundary.verify({
          request: clone(request),
          result: clone(result),
          commitDigest
        });
        if (!isPlainObject(attestation) || Object.keys(attestation).sort().join("\0") !== "commitDigest\0controllerId\0kind" ||
            attestation.kind !== "TrustedAdmissionSealAttestationV1" || attestation.controllerId !== controllerId ||
            attestation.commitDigest !== commitDigest) {
          throw new Error("Trusted controller TCB did not attest the exact persisted admission seal");
        }
        return result;
      }
    })

  };
  TRUSTED_CONTROLLERS.add(adapter);
  return Object.freeze(adapter);
}

export function createOwnedResourceAdapter({ stopOwned, queryOwned = null, resolveOwnedLaunch = null, label = "owned-resource-adapter-v1" } = {}) {
  if (typeof stopOwned !== "function") throw new Error("Owned resource adapter requires stopOwned");
  if (queryOwned !== null && typeof queryOwned !== "function") {
    throw new Error("queryOwned must be a function when provided");
  }
  if (resolveOwnedLaunch !== null && typeof resolveOwnedLaunch !== "function") {
    throw new Error("resolveOwnedLaunch must be a function when provided");
  }
  const adapter = {
    kind: "OwnedExecutionResourceAdapterV1",
    label: assertText(label, "resource adapter label"),
    async stopOwned(request) {
      return clone(await stopOwned(clone(request)));
    },
    ...(queryOwned === null ? {} : {
      async queryOwned(request, { signal = undefined } = {}) {
        return clone(await queryOwned(clone(request), { signal }));
      }
    }),
    ...(resolveOwnedLaunch === null ? {} : {
      async resolveOwnedLaunch(request, { signal = undefined } = {}) {
        return clone(await resolveOwnedLaunch(clone(request), { signal }));
      }
    })
  };
  OWNED_RESOURCE_ADAPTERS.add(adapter);
  return Object.freeze(adapter);
}

function validateHandle(value) {
  assertSafeObject(value, EXECUTION_HANDLE_KIND);
  const handleKeys = [
    "schemaVersion", "kind", "handleId", "runId", "executionId", "attemptId", "unitId",
    "sourceBindingDigest", "policyDigest", "revision", "ownedResourceId", "authorityEpoch",
    "fence", "executionScopeDigest", "obligationKey", "createdAt", "status", "dispatchBlocked", "revokedAt", "origin"
  ];
  if (value.admissionDigest !== undefined) handleKeys.push("admissionDigest");
  exactKeys(value, handleKeys, EXECUTION_HANDLE_KIND);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_HANDLE_KIND) throw new Error(`${EXECUTION_HANDLE_KIND} version/kind is invalid`);
  assertId(value.handleId, `${EXECUTION_HANDLE_KIND}.handleId`);
  const binding = bindingFromInput(value, { label: EXECUTION_HANDLE_KIND });
  assertId(value.ownedResourceId, `${EXECUTION_HANDLE_KIND}.ownedResourceId`);
  assertEpoch(value.authorityEpoch, `${EXECUTION_HANDLE_KIND}.authorityEpoch`);
  assertFence(value.fence, `${EXECUTION_HANDLE_KIND}.fence`);
  assertDigest(value.executionScopeDigest, `${EXECUTION_HANDLE_KIND}.executionScopeDigest`);
  assertDigest(value.obligationKey, `${EXECUTION_HANDLE_KIND}.obligationKey`);
  if (value.admissionDigest !== undefined) assertDigest(value.admissionDigest, `${EXECUTION_HANDLE_KIND}.admissionDigest`);
  assertIso(value.createdAt, `${EXECUTION_HANDLE_KIND}.createdAt`);
  if (!["ready", "dispatching", "completed", "failed", "revoked", "stopped", "indeterminate"].includes(value.status)) {
    throw new Error(`${EXECUTION_HANDLE_KIND}.status is invalid`);
  }
  assertBoolean(value.dispatchBlocked, `${EXECUTION_HANDLE_KIND}.dispatchBlocked`);
  if (value.revokedAt !== null) assertIso(value.revokedAt, `${EXECUTION_HANDLE_KIND}.revokedAt`);
  assertSafeObject(value.origin, `${EXECUTION_HANDLE_KIND}.origin`);
  if (value.origin.handleId !== value.handleId || value.origin.authorityEpoch !== value.authorityEpoch || value.origin.fence !== value.fence) {
    throw new Error(`${EXECUTION_HANDLE_KIND}.origin is not immutable-bound`);
  }
  return { ...value, ...binding };
}

export function validateExecutionHandleV1(value) {
  return validateHandle(value);
}

function validateStopRequest(value) {
  assertSafeObject(value, STOP_REQUEST_KIND);
  exactKeys(value, [
    "schemaVersion", "kind", "stopRequestId", "handleId", "runId", "executionId", "attemptId", "unitId",
    "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence", "ownedResourceId",
    "reason", "requestedBy", "requestedAt", "securityRcaRequired", "status"
  ], STOP_REQUEST_KIND);
  if (value.schemaVersion !== 1 || value.kind !== STOP_REQUEST_KIND) throw new Error(`${STOP_REQUEST_KIND} version/kind is invalid`);
  assertId(value.stopRequestId, `${STOP_REQUEST_KIND}.stopRequestId`);
  assertId(value.handleId, `${STOP_REQUEST_KIND}.handleId`);
  const binding = bindingFromInput(value, { label: STOP_REQUEST_KIND });
  assertId(value.ownedResourceId, `${STOP_REQUEST_KIND}.ownedResourceId`);
  assertEpoch(value.authorityEpoch, `${STOP_REQUEST_KIND}.authorityEpoch`);
  assertFence(value.fence, `${STOP_REQUEST_KIND}.fence`);
  if (!STOP_REASONS.has(value.reason)) throw new Error(`${STOP_REQUEST_KIND}.reason is invalid`);
  assertId(value.requestedBy, `${STOP_REQUEST_KIND}.requestedBy`);
  assertIso(value.requestedAt, `${STOP_REQUEST_KIND}.requestedAt`);
  assertBoolean(value.securityRcaRequired, `${STOP_REQUEST_KIND}.securityRcaRequired`);
  if (value.status !== "requested") throw new Error(`${STOP_REQUEST_KIND}.status is invalid`);
  return { ...value, ...binding };
}

export function validateStopRequestV1(value) {
  return validateStopRequest(value);
}

function validateStopReceipt(value) {
  assertSafeObject(value, STOP_RECEIPT_KIND);
  exactKeys(value, [
    "schemaVersion", "kind", "stopReceiptId", "stopRequestId", "handleId", "runId", "executionId", "attemptId",
    "unitId", "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence", "ownedResourceId",
    "localOutcome", "remoteOutcome", "outcome", "confirmedOwnedScope", "securityRcaRequired", "reason", "createdAt", "details"
  ], STOP_RECEIPT_KIND);
  if (value.schemaVersion !== 1 || value.kind !== STOP_RECEIPT_KIND) throw new Error(`${STOP_RECEIPT_KIND} version/kind is invalid`);
  assertId(value.stopReceiptId, `${STOP_RECEIPT_KIND}.stopReceiptId`);
  assertId(value.stopRequestId, `${STOP_RECEIPT_KIND}.stopRequestId`);
  assertId(value.handleId, `${STOP_RECEIPT_KIND}.handleId`);
  const binding = bindingFromInput(value, { label: STOP_RECEIPT_KIND });
  assertId(value.ownedResourceId, `${STOP_RECEIPT_KIND}.ownedResourceId`);
  assertEpoch(value.authorityEpoch, `${STOP_RECEIPT_KIND}.authorityEpoch`);
  assertFence(value.fence, `${STOP_RECEIPT_KIND}.fence`);
  if (!LOCAL_STOP_OUTCOMES.has(value.localOutcome) || !REMOTE_STOP_OUTCOMES.has(value.remoteOutcome)) {
    throw new Error(`${STOP_RECEIPT_KIND} outcome is invalid`);
  }
  if (!["STOPPED", "INDETERMINATE", "UNKNOWN"].includes(value.outcome)) throw new Error(`${STOP_RECEIPT_KIND}.outcome is invalid`);
  if (value.outcome === "STOPPED" && (value.localOutcome !== "stopped" || !["stopped", "not-applicable"].includes(value.remoteOutcome))) {
    throw new Error(`${STOP_RECEIPT_KIND} cannot report STOPPED without confirmed local stop`);
  }
  assertBoolean(value.confirmedOwnedScope, `${STOP_RECEIPT_KIND}.confirmedOwnedScope`);
  assertBoolean(value.securityRcaRequired, `${STOP_RECEIPT_KIND}.securityRcaRequired`);
  if (value.securityRcaRequired && value.reason !== "security-p0") throw new Error(`${STOP_RECEIPT_KIND} security RCA binding is invalid`);
  assertText(value.reason, `${STOP_RECEIPT_KIND}.reason`);
  assertIso(value.createdAt, `${STOP_RECEIPT_KIND}.createdAt`);
  assertSafeObject(value.details, `${STOP_RECEIPT_KIND}.details`);
  return { ...value, ...binding };
}

export function validateStopReceiptV1(value) {
  return validateStopReceipt(value);
}

function validateRecoveryPlan(value) {
  assertSafeObject(value, RECOVERY_PLAN_KIND);
  exactKeys(value, [
    "schemaVersion", "kind", "recoveryPlanId", "fromHandleId", "newHandleId", "runId", "executionId", "unitId",
    "priorAttemptId", "newAttemptId", "sourceBindingDigest", "policyDigest", "revision", "oldAuthorityEpoch",
    "newAuthorityEpoch", "oldFence", "newFence", "reason", "status", "createdAt"
  ], RECOVERY_PLAN_KIND);
  if (value.schemaVersion !== 1 || value.kind !== RECOVERY_PLAN_KIND) throw new Error(`${RECOVERY_PLAN_KIND} version/kind is invalid`);
  assertId(value.recoveryPlanId, `${RECOVERY_PLAN_KIND}.recoveryPlanId`);
  assertId(value.fromHandleId, `${RECOVERY_PLAN_KIND}.fromHandleId`);
  assertId(value.newHandleId, `${RECOVERY_PLAN_KIND}.newHandleId`);
  const binding = bindingFromInput({
    runId: value.runId,
    executionId: value.executionId,
    attemptId: value.newAttemptId,
    unitId: value.unitId,
    sourceBindingDigest: value.sourceBindingDigest,
    policyDigest: value.policyDigest,
    revision: value.revision
  }, { label: RECOVERY_PLAN_KIND });
  assertId(value.priorAttemptId, `${RECOVERY_PLAN_KIND}.priorAttemptId`);
  assertEpoch(value.oldAuthorityEpoch, `${RECOVERY_PLAN_KIND}.oldAuthorityEpoch`);
  assertEpoch(value.newAuthorityEpoch, `${RECOVERY_PLAN_KIND}.newAuthorityEpoch`);
  if (value.newAuthorityEpoch <= value.oldAuthorityEpoch) throw new Error(`${RECOVERY_PLAN_KIND} must advance authority epoch`);
  assertFence(value.oldFence, `${RECOVERY_PLAN_KIND}.oldFence`);
  assertFence(value.newFence, `${RECOVERY_PLAN_KIND}.newFence`);
  assertText(value.reason, `${RECOVERY_PLAN_KIND}.reason`);
  if (value.status !== "prepared") throw new Error(`${RECOVERY_PLAN_KIND}.status is invalid`);
  assertIso(value.createdAt, `${RECOVERY_PLAN_KIND}.createdAt`);
  return { ...value, ...binding };
}

export function validateRecoveryPlanV1(value) {
  return validateRecoveryPlan(value);
}

export function computeExecutionScopeDigest(binding) {
  const normalized = bindingFromInput(binding, { label: "execution scope binding" });
  return digestObject({
    schemaVersion: 1,
    unitId: normalized.unitId,
    sourceBindingDigest: normalized.sourceBindingDigest,
    policyDigest: normalized.policyDigest,
    revision: normalized.revision
  });
}

function computeObligationKey(binding) {
  const normalized = bindingFromInput(binding, { label: "logical obligation binding" });
  return digestObject({
    schemaVersion: 1,
    runId: normalized.runId,
    unitId: normalized.unitId,
    sourceBindingDigest: normalized.sourceBindingDigest,
    policyDigest: normalized.policyDigest,
    revision: normalized.revision,
    ownedResourceId: normalized.ownedResourceId
  });
}

function digestObject(value) {
  // This is an execution scope digest only.  It is deliberately not a cache
  // key: complete dependency fingerprints and current admission belong to the
  // independent W2 cache implementation.
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (isPlainObject(item)) return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
    return item;
  };
  const text = JSON.stringify(sort(value));
  return createSha256(text);
}

function recoveryHandoffBody(value) {
  const { handoffDigest: ignored, ...body } = value;
  return body;
}

export function validateExecutionRecoveryHandoffV1(value, expected = {}) {
  assertOwnDataObject(expected, `${EXECUTION_RECOVERY_HANDOFF_KIND} expected binding`);
  const expectedKeys = new Set(["handoffId", "runId", "recoveryId", "batchDigest", "runtimeScopeDigest"]);
  for (const key of Object.keys(expected)) {
    if (!expectedKeys.has(key)) throw new Error(`${EXECUTION_RECOVERY_HANDOFF_KIND} expected binding contains an unknown key`);
  }
  assertSafeObject(value, EXECUTION_RECOVERY_HANDOFF_KIND);
  exactKeys(value, [
    "schemaVersion", "kind", "status", "handoffId", "runId", "recoveryId",
    "batchDigest", "recoveryPlanDigest", "authorityDigest", "authorityReceiptDigest",
    "admissionStateRootDigest", "admissionStorageScopeDigest", "runtimeScopeDigest",
    "journalRelativePath", "sourceJournalByteLength", "sourceJournalDigest",
    "sourceRegistrySequence", "sourceRegistryStateDigest", "committedRegistrySequence",
    "committedRegistryStateDigest", "taskIds", "entries", "effectAuthority", "handoffDigest"
  ], EXECUTION_RECOVERY_HANDOFF_KIND);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_RECOVERY_HANDOFF_KIND || value.status !== "committed") {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_KIND} version/kind/status is invalid`);
  }
  for (const key of ["handoffId", "runId", "recoveryId"]) assertId(value[key], `${EXECUTION_RECOVERY_HANDOFF_KIND}.${key}`);
  for (const key of [
    "batchDigest", "recoveryPlanDigest", "authorityDigest", "authorityReceiptDigest",
    "admissionStateRootDigest", "admissionStorageScopeDigest", "runtimeScopeDigest",
    "sourceJournalDigest", "sourceRegistryStateDigest", "committedRegistryStateDigest", "handoffDigest"
  ]) assertDigest(value[key], `${EXECUTION_RECOVERY_HANDOFF_KIND}.${key}`);
  if (value.journalRelativePath !== `runs/${value.runId}/journal.jsonl`) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_KIND}.journalRelativePath is invalid`);
  }
  if (!Number.isSafeInteger(value.sourceJournalByteLength) || value.sourceJournalByteLength < 0) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_KIND}.sourceJournalByteLength is invalid`);
  }
  if (!Number.isSafeInteger(value.sourceRegistrySequence) || value.sourceRegistrySequence < 0 ||
      !Number.isSafeInteger(value.committedRegistrySequence) ||
      value.committedRegistrySequence !== value.sourceRegistrySequence + 1) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_KIND} registry sequence is invalid`);
  }
  if (!Array.isArray(value.taskIds) || value.taskIds.length === 0 || value.taskIds.length > 256) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_KIND}.taskIds is invalid`);
  }
  const taskIds = value.taskIds.map((taskId, index) => assertId(taskId, `${EXECUTION_RECOVERY_HANDOFF_KIND}.taskIds[${index}]`));
  if (new Set(taskIds).size !== taskIds.length || taskIds.some((taskId, index) => index > 0 && taskId < taskIds[index - 1])) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_KIND}.taskIds must be unique and sorted`);
  }
  if (!Array.isArray(value.entries) || value.entries.length !== taskIds.length) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_KIND}.entries does not exactly cover taskIds`);
  }
  const entries = value.entries.map((entry, index) => {
    const label = `${EXECUTION_RECOVERY_HANDOFF_KIND}.entries[${index}]`;
    assertSafeObject(entry, label);
    exactKeys(entry, [
      "taskId", "controllerId", "handleId", "priorHandleId", "recoveryPlanId",
      "executionId", "attemptId", "unitId", "ownedResourceId", "bindingDigest",
      "logicalObligationDigest", "handleDigest", "admissionDigest", "reservationKey"
    ], label);
    const taskId = assertId(entry.taskId, `${label}.taskId`);
    if (taskId !== taskIds[index]) throw new Error(`${label}.taskId is not sorted with taskIds`);
    const priorHandleId = entry.priorHandleId === null ? null : assertId(entry.priorHandleId, `${label}.priorHandleId`);
    const recoveryPlanId = entry.recoveryPlanId === null ? null : assertId(entry.recoveryPlanId, `${label}.recoveryPlanId`);
    if ((priorHandleId === null) !== (recoveryPlanId === null)) {
      throw new Error(`${label} recovery identities are incomplete`);
    }
    if (typeof entry.reservationKey !== "string" || entry.reservationKey.length === 0 || entry.reservationKey.length > 768) {
      throw new Error(`${label}.reservationKey is invalid`);
    }
    return {
      taskId,
      controllerId: assertId(entry.controllerId, `${label}.controllerId`),
      handleId: assertId(entry.handleId, `${label}.handleId`),
      priorHandleId,
      recoveryPlanId,
      executionId: assertId(entry.executionId, `${label}.executionId`),
      attemptId: assertId(entry.attemptId, `${label}.attemptId`),
      unitId: assertId(entry.unitId, `${label}.unitId`),
      ownedResourceId: assertId(entry.ownedResourceId, `${label}.ownedResourceId`),
      bindingDigest: assertDigest(entry.bindingDigest, `${label}.bindingDigest`),
      logicalObligationDigest: assertDigest(entry.logicalObligationDigest, `${label}.logicalObligationDigest`),
      handleDigest: assertDigest(entry.handleDigest, `${label}.handleDigest`),
      admissionDigest: assertDigest(entry.admissionDigest, `${label}.admissionDigest`),
      reservationKey: entry.reservationKey
    };
  });
  if (new Set(entries.map((entry) => entry.controllerId)).size !== entries.length ||
      new Set(entries.map((entry) => entry.handleId)).size !== entries.length ||
      new Set(entries.map((entry) => entry.executionId)).size !== entries.length ||
      new Set(entries.map((entry) => entry.attemptId)).size !== entries.length ||
      new Set(entries.flatMap((entry) => entry.recoveryPlanId === null ? [] : [entry.recoveryPlanId])).size !==
        entries.filter((entry) => entry.recoveryPlanId !== null).length ||
      new Set(entries.map((entry) => entry.admissionDigest)).size !== entries.length ||
      new Set(entries.map((entry) => entry.reservationKey)).size !== entries.length) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_KIND} entries reuse a controller, runtime, admission, or reservation identity`);
  }
  assertSafeObject(value.effectAuthority, `${EXECUTION_RECOVERY_HANDOFF_KIND}.effectAuthority`);
  exactKeys(value.effectAuthority, Object.keys(RECOVERY_HANDOFF_EFFECT_AUTHORITY), `${EXECUTION_RECOVERY_HANDOFF_KIND}.effectAuthority`);
  if (!same(value.effectAuthority, RECOVERY_HANDOFF_EFFECT_AUTHORITY)) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_KIND} must remain non-effecting`);
  }
  if (digestObject(recoveryHandoffBody(value)) !== value.handoffDigest) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_KIND}.handoffDigest is not bound`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && value[key] !== expectedValue) {
      throw new Error(`${EXECUTION_RECOVERY_HANDOFF_KIND}.${key} does not match the expected value`);
    }
  }
  return freezeDeep(clone({ ...value, taskIds, entries, effectAuthority: RECOVERY_HANDOFF_EFFECT_AUTHORITY }));
}

function sealExecutionRecoveryHandoff(value) {
  return validateExecutionRecoveryHandoffV1({
    ...clone(value),
    handoffDigest: digestObject(value)
  });
}

function validateSortedIds(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > 256 || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} is invalid`);
  }
  const ids = value.map((item, index) => assertId(item, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length || ids.some((item, index) => index > 0 && item < ids[index - 1])) {
    throw new Error(`${label} must be unique and sorted`);
  }
  return ids;
}

function recoveryClaimIdentity(value) {
  return `recovery-claim:${digestObject(value)}`;
}

function recoveryTaskReleaseIdentity(value) {
  return `recovery-release:${digestObject(value)}`;
}

function recoveryTaskPermitConsumptionIdentity(value) {
  return `recovery-consumption:${digestObject(value)}`;
}

function recoveryTaskEffectIntentIdentity(value) {
  return `recovery-effect-intent:${digestObject(value)}`;
}

function recoveryTaskEffectReservationIdentity(value) {
  return `recovery-effect-reservation:${digestObject(value)}`;
}

function recoveryTaskEffectLaunchIdentity(value) {
  return `recovery-effect-launch:${digestObject(value)}`;
}

function recoveryTaskEffectOutcomeIdentity(value) {
  return `recovery-effect-outcome:${digestObject(value)}`;
}

function recoveryClaimBody(value) {
  const { claimDigest: ignored, ...body } = value;
  return body;
}

export function validateExecutionRecoveryHandoffClaimV1(value, expected = {}) {
  assertOwnDataObject(expected, `${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND} expected binding`);
  const expectedKeys = new Set(["claimId", "runId", "handoffId", "handoffDigest", "preparedCheckpointStateDigest"]);
  for (const key of Object.keys(expected)) {
    if (!expectedKeys.has(key)) throw new Error(`${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND} expected binding contains an unknown key`);
  }
  assertSafeObject(value, EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND);
  exactKeys(value, [
    "schemaVersion", "kind", "status", "claimId", "runId", "handoffId", "handoffDigest",
    "recoveryPlanDigest", "planId", "planDigest", "contractDigest", "preparedCheckpointSequence",
    "preparedCheckpointStateDigest", "preparedEventSequence", "preparedEventDigest", "taskIds", "entries",
    "sourceRegistrySequence", "sourceRegistryStateDigest", "committedRegistrySequence",
    "committedRegistryStateDigest", "claimedAt", "effectAuthority", "claimDigest"
  ], EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND || value.status !== "claimed") {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND} version/kind/status is invalid`);
  }
  for (const key of ["claimId", "runId", "handoffId", "planId"]) {
    assertId(value[key], `${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND}.${key}`);
  }
  for (const key of [
    "handoffDigest", "recoveryPlanDigest", "planDigest", "contractDigest", "preparedCheckpointStateDigest",
    "preparedEventDigest", "sourceRegistryStateDigest", "committedRegistryStateDigest", "claimDigest"
  ]) assertDigest(value[key], `${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND}.${key}`);
  for (const key of ["preparedCheckpointSequence", "preparedEventSequence", "sourceRegistrySequence", "committedRegistrySequence"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error(`${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND}.${key} is invalid`);
    }
  }
  if (value.committedRegistrySequence !== value.sourceRegistrySequence + 1) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND} registry transition is invalid`);
  }
  if (value.preparedEventSequence !== value.preparedCheckpointSequence) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND} prepared event sequence is invalid`);
  }
  const taskIds = validateSortedIds(value.taskIds, `${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND}.taskIds`);
  if (!Array.isArray(value.entries) || utilTypes.isProxy(value.entries) || value.entries.length !== taskIds.length) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND}.entries do not exactly cover taskIds`);
  }
  const entries = value.entries.map((entry, index) => {
    const label = `${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND}.entries[${index}]`;
    assertSafeObject(entry, label);
    exactKeys(entry, ["taskId", "handleId", "handleDigest", "attemptId", "admissionDigest"], label);
    const normalized = {
      taskId: assertId(entry.taskId, `${label}.taskId`),
      handleId: assertId(entry.handleId, `${label}.handleId`),
      handleDigest: assertDigest(entry.handleDigest, `${label}.handleDigest`),
      attemptId: assertId(entry.attemptId, `${label}.attemptId`),
      admissionDigest: assertDigest(entry.admissionDigest, `${label}.admissionDigest`)
    };
    if (normalized.taskId !== taskIds[index]) throw new Error(`${label}.taskId is not sorted with taskIds`);
    return normalized;
  });
  if (new Set(entries.map((entry) => entry.handleId)).size !== entries.length ||
      new Set(entries.map((entry) => entry.attemptId)).size !== entries.length ||
      new Set(entries.map((entry) => entry.admissionDigest)).size !== entries.length) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND}.entries reuse a runtime or admission identity`);
  }
  assertSafeObject(value.effectAuthority, `${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND}.effectAuthority`);
  exactKeys(value.effectAuthority, Object.keys(RECOVERY_CLAIM_EFFECT_AUTHORITY), `${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND}.effectAuthority`);
  if (!same(value.effectAuthority, RECOVERY_CLAIM_EFFECT_AUTHORITY)) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND} must remain non-effecting`);
  }
  assertIso(value.claimedAt, `${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND}.claimedAt`);
  const identity = recoveryClaimIdentity({
    runId: value.runId,
    handoffId: value.handoffId,
    handoffDigest: value.handoffDigest,
    recoveryPlanDigest: value.recoveryPlanDigest,
    planId: value.planId,
    planDigest: value.planDigest,
    contractDigest: value.contractDigest,
    preparedCheckpointSequence: value.preparedCheckpointSequence,
    preparedCheckpointStateDigest: value.preparedCheckpointStateDigest,
    preparedEventSequence: value.preparedEventSequence,
    preparedEventDigest: value.preparedEventDigest,
    taskIds
  });
  if (value.claimId !== identity) throw new Error(`${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND}.claimId is not deterministic`);
  if (digestObject(recoveryClaimBody(value)) !== value.claimDigest) {
    throw new Error(`${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND}.claimDigest is not bound`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && value[key] !== expectedValue) {
      throw new Error(`${EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND}.${key} does not match the expected value`);
    }
  }
  return freezeDeep(clone({ ...value, taskIds, entries, effectAuthority: RECOVERY_CLAIM_EFFECT_AUTHORITY }));
}

function sealExecutionRecoveryHandoffClaim(value) {
  return validateExecutionRecoveryHandoffClaimV1({
    ...clone(value),
    claimDigest: digestObject(value)
  });
}

function recoveryTaskReleaseBody(value) {
  const { releaseDigest: ignored, ...body } = value;
  return body;
}

export function validateExecutionRecoveryTaskReleaseV1(value, expected = {}) {
  assertOwnDataObject(expected, `${EXECUTION_RECOVERY_TASK_RELEASE_KIND} expected binding`);
  const expectedKeys = new Set(["releaseId", "runId", "handoffId", "claimId", "taskId", "handleId"]);
  for (const key of Object.keys(expected)) {
    if (!expectedKeys.has(key)) throw new Error(`${EXECUTION_RECOVERY_TASK_RELEASE_KIND} expected binding contains an unknown key`);
  }
  assertSafeObject(value, EXECUTION_RECOVERY_TASK_RELEASE_KIND);
  exactKeys(value, [
    "schemaVersion", "kind", "status", "releaseId", "runId", "handoffId", "handoffDigest",
    "claimId", "claimDigest", "taskId", "handleId", "handleDigest", "attemptId", "admissionDigest",
    "planId", "planDigest", "contractDigest", "recoveryPlanDigest", "preparedEventSequence",
    "preparedEventDigest", "checkpointSequence", "checkpointStateDigest", "taskStateDigest",
    "dependencies", "dependencyStateDigest", "sourceRegistrySequence", "sourceRegistryStateDigest",
    "committedRegistrySequence", "committedRegistryStateDigest", "authorizedAt", "effectAuthority",
    "releaseDigest"
  ], EXECUTION_RECOVERY_TASK_RELEASE_KIND);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_RECOVERY_TASK_RELEASE_KIND || value.status !== "authorized") {
    throw new Error(`${EXECUTION_RECOVERY_TASK_RELEASE_KIND} version/kind/status is invalid`);
  }
  for (const key of ["releaseId", "runId", "handoffId", "claimId", "taskId", "handleId", "attemptId", "planId"]) {
    assertId(value[key], `${EXECUTION_RECOVERY_TASK_RELEASE_KIND}.${key}`);
  }
  for (const key of [
    "handoffDigest", "claimDigest", "handleDigest", "admissionDigest", "planDigest", "contractDigest",
    "recoveryPlanDigest", "preparedEventDigest", "checkpointStateDigest", "taskStateDigest",
    "dependencyStateDigest", "sourceRegistryStateDigest", "committedRegistryStateDigest", "releaseDigest"
  ]) assertDigest(value[key], `${EXECUTION_RECOVERY_TASK_RELEASE_KIND}.${key}`);
  for (const key of ["preparedEventSequence", "checkpointSequence", "sourceRegistrySequence", "committedRegistrySequence"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_RELEASE_KIND}.${key} is invalid`);
    }
  }
  if (value.committedRegistrySequence !== value.sourceRegistrySequence + 1 ||
      value.checkpointSequence < value.preparedEventSequence) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_RELEASE_KIND} sequence binding is invalid`);
  }
  if (!Array.isArray(value.dependencies) || utilTypes.isProxy(value.dependencies) || value.dependencies.length > 256) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_RELEASE_KIND}.dependencies is invalid`);
  }
  const dependencies = value.dependencies.map((entry, index) => {
    const label = `${EXECUTION_RECOVERY_TASK_RELEASE_KIND}.dependencies[${index}]`;
    assertSafeObject(entry, label);
    exactKeys(entry, ["taskId", "status", "stateDigest"], label);
    if (entry.status !== "succeeded") throw new Error(`${label}.status must be succeeded`);
    return {
      taskId: assertId(entry.taskId, `${label}.taskId`),
      status: "succeeded",
      stateDigest: assertDigest(entry.stateDigest, `${label}.stateDigest`)
    };
  });
  if (new Set(dependencies.map((entry) => entry.taskId)).size !== dependencies.length ||
      dependencies.some((entry, index) => index > 0 && entry.taskId < dependencies[index - 1].taskId)) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_RELEASE_KIND}.dependencies must be unique and sorted`);
  }
  if (digestObject(dependencies) !== value.dependencyStateDigest) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_RELEASE_KIND}.dependencyStateDigest is not bound`);
  }
  assertSafeObject(value.effectAuthority, `${EXECUTION_RECOVERY_TASK_RELEASE_KIND}.effectAuthority`);
  exactKeys(value.effectAuthority, Object.keys(RECOVERY_TASK_RELEASE_EFFECT_AUTHORITY), `${EXECUTION_RECOVERY_TASK_RELEASE_KIND}.effectAuthority`);
  if (!same(value.effectAuthority, RECOVERY_TASK_RELEASE_EFFECT_AUTHORITY)) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_RELEASE_KIND} must remain non-effecting`);
  }
  assertIso(value.authorizedAt, `${EXECUTION_RECOVERY_TASK_RELEASE_KIND}.authorizedAt`);
  const identity = recoveryTaskReleaseIdentity({
    claimId: value.claimId,
    taskId: value.taskId,
    handleId: value.handleId,
    attemptId: value.attemptId
  });
  if (value.releaseId !== identity) throw new Error(`${EXECUTION_RECOVERY_TASK_RELEASE_KIND}.releaseId is not deterministic`);
  if (digestObject(recoveryTaskReleaseBody(value)) !== value.releaseDigest) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_RELEASE_KIND}.releaseDigest is not bound`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && value[key] !== expectedValue) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_RELEASE_KIND}.${key} does not match the expected value`);
    }
  }
  return freezeDeep(clone({ ...value, dependencies, effectAuthority: RECOVERY_TASK_RELEASE_EFFECT_AUTHORITY }));
}

function sealExecutionRecoveryTaskRelease(value) {
  return validateExecutionRecoveryTaskReleaseV1({
    ...clone(value),
    releaseDigest: digestObject(value)
  });
}

function recoveryTaskPermitConsumptionBody(value) {
  const { consumptionDigest: ignored, ...body } = value;
  return body;
}

export function validateExecutionRecoveryTaskPermitConsumptionV1(value, expected = {}) {
  assertOwnDataObject(expected, `${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND} expected binding`);
  const expectedKeys = new Set([
    "consumptionId", "runId", "handoffId", "claimId", "releaseId", "taskId", "handleId"
  ]);
  for (const key of Object.keys(expected)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND} expected binding contains an unknown key`);
    }
  }
  assertSafeObject(value, EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND);
  exactKeys(value, [
    "schemaVersion", "kind", "status", "consumptionId", "runId", "handoffId", "handoffDigest",
    "claimId", "claimDigest", "releaseId", "releaseDigest", "taskId", "handleId", "handleDigest",
    "attemptId", "admissionDigest", "planId", "planDigest", "contractDigest", "recoveryPlanDigest",
    "preparedEventSequence", "preparedEventDigest", "checkpointSequence", "checkpointStateDigest",
    "taskStateDigest", "dependencies", "dependencyStateDigest", "sourceRegistrySequence",
    "sourceRegistryStateDigest", "committedRegistrySequence", "committedRegistryStateDigest",
    "consumedAt", "effectAuthority", "consumptionDigest"
  ], EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND ||
      value.status !== "consumed") {
    throw new Error(`${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND} version/kind/status is invalid`);
  }
  for (const key of [
    "consumptionId", "runId", "handoffId", "claimId", "releaseId", "taskId", "handleId", "attemptId", "planId"
  ]) assertId(value[key], `${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND}.${key}`);
  for (const key of [
    "handoffDigest", "claimDigest", "releaseDigest", "handleDigest", "admissionDigest", "planDigest",
    "contractDigest", "recoveryPlanDigest", "preparedEventDigest", "checkpointStateDigest",
    "taskStateDigest", "dependencyStateDigest", "sourceRegistryStateDigest", "committedRegistryStateDigest",
    "consumptionDigest"
  ]) assertDigest(value[key], `${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND}.${key}`);
  for (const key of [
    "preparedEventSequence", "checkpointSequence", "sourceRegistrySequence", "committedRegistrySequence"
  ]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND}.${key} is invalid`);
    }
  }
  if (value.committedRegistrySequence !== value.sourceRegistrySequence + 1 ||
      value.checkpointSequence < value.preparedEventSequence) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND} sequence binding is invalid`);
  }
  if (!Array.isArray(value.dependencies) || utilTypes.isProxy(value.dependencies) || value.dependencies.length > 256) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND}.dependencies is invalid`);
  }
  const dependencies = value.dependencies.map((entry, index) => {
    const label = `${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND}.dependencies[${index}]`;
    assertSafeObject(entry, label);
    exactKeys(entry, ["taskId", "status", "stateDigest"], label);
    if (entry.status !== "succeeded") throw new Error(`${label}.status must be succeeded`);
    return {
      taskId: assertId(entry.taskId, `${label}.taskId`),
      status: "succeeded",
      stateDigest: assertDigest(entry.stateDigest, `${label}.stateDigest`)
    };
  });
  if (new Set(dependencies.map((entry) => entry.taskId)).size !== dependencies.length ||
      dependencies.some((entry, index) => index > 0 && entry.taskId < dependencies[index - 1].taskId)) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND}.dependencies must be unique and sorted`);
  }
  if (digestObject(dependencies) !== value.dependencyStateDigest) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND}.dependencyStateDigest is not bound`);
  }
  assertSafeObject(value.effectAuthority, `${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND}.effectAuthority`);
  exactKeys(
    value.effectAuthority,
    Object.keys(RECOVERY_TASK_PERMIT_CONSUMPTION_EFFECT_AUTHORITY),
    `${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND}.effectAuthority`
  );
  if (!same(value.effectAuthority, RECOVERY_TASK_PERMIT_CONSUMPTION_EFFECT_AUTHORITY)) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND} must remain non-effecting`);
  }
  assertIso(value.consumedAt, `${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND}.consumedAt`);
  const identity = recoveryTaskPermitConsumptionIdentity({
    releaseId: value.releaseId,
    releaseDigest: value.releaseDigest,
    taskId: value.taskId,
    handleId: value.handleId,
    attemptId: value.attemptId
  });
  if (value.consumptionId !== identity) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND}.consumptionId is not deterministic`);
  }
  if (digestObject(recoveryTaskPermitConsumptionBody(value)) !== value.consumptionDigest) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND}.consumptionDigest is not bound`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && value[key] !== expectedValue) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND}.${key} does not match the expected value`);
    }
  }
  return freezeDeep(clone({
    ...value,
    dependencies,
    effectAuthority: RECOVERY_TASK_PERMIT_CONSUMPTION_EFFECT_AUTHORITY
  }));
}

function sealExecutionRecoveryTaskPermitConsumption(value) {
  return validateExecutionRecoveryTaskPermitConsumptionV1({
    ...clone(value),
    consumptionDigest: digestObject(value)
  });
}

const RECOVERY_TASK_EFFECT_INTENT_BINDING_FIELDS = [
  "runId", "handoffId", "handoffDigest", "claimId", "claimDigest", "releaseId", "releaseDigest",
  "consumptionId", "consumptionDigest", "taskId", "handleId", "handleDigest", "attemptId",
  "admissionDigest", "planId", "planDigest", "contractDigest", "recoveryPlanDigest",
  "preparedEventSequence", "preparedEventDigest", "checkpointSequence", "checkpointStateDigest",
  "taskStateDigest", "dependencyStateDigest", "consumedAt"
];

function recoveryTaskEffectIntentBody(value) {
  const { intentDigest: ignored, ...body } = value;
  return body;
}

export function validateExecutionRecoveryTaskEffectIntentV1(value, expected = {}) {
  assertOwnDataObject(expected, `${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND} expected binding`);
  const expectedKeys = new Set([
    "intentId", "status", "runId", "handoffId", "claimId", "releaseId", "consumptionId",
    "taskId", "handleId"
  ]);
  for (const key of Object.keys(expected)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND} expected binding contains an unknown key`);
    }
  }
  assertSafeObject(value, EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND);
  exactKeys(value, [
    "schemaVersion", "kind", "status", "intentId", "runId", "handoffId", "handoffDigest",
    "claimId", "claimDigest", "releaseId", "releaseDigest", "consumptionId", "consumptionDigest",
    "taskId", "handleId", "handleDigest", "attemptId", "admissionDigest", "planId", "planDigest",
    "contractDigest", "recoveryPlanDigest", "preparedEventSequence", "preparedEventDigest",
    "checkpointSequence", "checkpointStateDigest", "taskStateDigest", "dependencies",
    "dependencyStateDigest", "consumedAt", "transitionIndex", "priorIntentDigest", "reservationId",
    "dispatchReserved", "callbackCalls", "effectStarted", "createdAt", "reservedAt", "terminalAt",
    "terminalReason", "sourceRegistrySequence", "sourceRegistryStateDigest",
    "committedRegistrySequence", "committedRegistryStateDigest", "effectAuthority", "intentDigest"
  ], EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND ||
      !RECOVERY_TASK_EFFECT_INTENT_STATUSES.has(value.status)) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND} version/kind/status is invalid`);
  }
  for (const key of [
    "intentId", "runId", "handoffId", "claimId", "releaseId", "consumptionId", "taskId", "handleId",
    "attemptId", "planId"
  ]) assertId(value[key], `${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.${key}`);
  for (const key of [
    "handoffDigest", "claimDigest", "releaseDigest", "consumptionDigest", "handleDigest",
    "admissionDigest", "planDigest", "contractDigest", "recoveryPlanDigest", "preparedEventDigest",
    "checkpointStateDigest", "taskStateDigest", "dependencyStateDigest", "sourceRegistryStateDigest",
    "committedRegistryStateDigest", "intentDigest"
  ]) assertDigest(value[key], `${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.${key}`);
  for (const key of [
    "preparedEventSequence", "checkpointSequence", "transitionIndex", "sourceRegistrySequence",
    "committedRegistrySequence", "callbackCalls"
  ]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.${key} is invalid`);
    }
  }
  if (value.committedRegistrySequence !== value.sourceRegistrySequence + 1 ||
      value.checkpointSequence < value.preparedEventSequence || value.callbackCalls !== 0 ||
      typeof value.dispatchReserved !== "boolean" || typeof value.effectStarted !== "boolean" ||
      value.effectStarted !== false) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND} sequence or no-effect binding is invalid`);
  }
  if (!Array.isArray(value.dependencies) || utilTypes.isProxy(value.dependencies) || value.dependencies.length > 256) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.dependencies is invalid`);
  }
  const dependencies = value.dependencies.map((entry, index) => {
    const label = `${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.dependencies[${index}]`;
    assertSafeObject(entry, label);
    exactKeys(entry, ["taskId", "status", "stateDigest"], label);
    if (entry.status !== "succeeded") throw new Error(`${label}.status must be succeeded`);
    return {
      taskId: assertId(entry.taskId, `${label}.taskId`),
      status: "succeeded",
      stateDigest: assertDigest(entry.stateDigest, `${label}.stateDigest`)
    };
  });
  if (new Set(dependencies.map((entry) => entry.taskId)).size !== dependencies.length ||
      dependencies.some((entry, index) => index > 0 && entry.taskId < dependencies[index - 1].taskId) ||
      digestObject(dependencies) !== value.dependencyStateDigest) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.dependencies are not uniquely and exactly bound`);
  }
  assertIso(value.consumedAt, `${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.consumedAt`);
  assertIso(value.createdAt, `${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.createdAt`);
  if (value.priorIntentDigest !== null) {
    assertDigest(value.priorIntentDigest, `${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.priorIntentDigest`);
  }
  if (value.reservationId !== null) {
    assertId(value.reservationId, `${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.reservationId`);
  }
  if (value.reservedAt !== null) assertIso(value.reservedAt, `${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.reservedAt`);
  if (value.terminalAt !== null) assertIso(value.terminalAt, `${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.terminalAt`);
  if (value.terminalReason !== null) assertId(value.terminalReason, `${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.terminalReason`);
  const identity = recoveryTaskEffectIntentIdentity({
    consumptionId: value.consumptionId,
    consumptionDigest: value.consumptionDigest,
    taskId: value.taskId,
    handleId: value.handleId,
    attemptId: value.attemptId
  });
  if (value.intentId !== identity) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.intentId is not deterministic`);
  }
  const reservationId = recoveryTaskEffectReservationIdentity({
    intentId: value.intentId,
    consumptionDigest: value.consumptionDigest
  });
  if (value.status === "created") {
    if (value.transitionIndex !== 0 || value.priorIntentDigest !== null || value.reservationId !== null ||
        value.dispatchReserved !== false || value.reservedAt !== null || value.terminalAt !== null ||
        value.terminalReason !== null) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND} created state is invalid`);
    }
  } else if (value.status === "dispatch-reserved") {
    if (value.transitionIndex !== 1 || value.priorIntentDigest === null || value.reservationId !== reservationId ||
        value.dispatchReserved !== true || value.reservedAt === null || value.terminalAt !== null ||
        value.terminalReason !== null) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND} dispatch-reserved state is invalid`);
    }
  } else {
    const reasons = value.status === "not-sent"
      ? RECOVERY_TASK_EFFECT_NOT_SENT_REASONS
      : RECOVERY_TASK_EFFECT_UNKNOWN_REASONS;
    const expectedReserved = value.status === "unknown";
    if (value.transitionIndex !== 2 || value.priorIntentDigest === null || value.reservationId !== reservationId ||
        value.dispatchReserved !== expectedReserved || value.reservedAt === null || value.terminalAt === null ||
        !reasons.has(value.terminalReason)) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND} terminal state is invalid`);
    }
  }
  assertSafeObject(value.effectAuthority, `${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.effectAuthority`);
  exactKeys(
    value.effectAuthority,
    Object.keys(RECOVERY_TASK_EFFECT_INTENT_EFFECT_AUTHORITY),
    `${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.effectAuthority`
  );
  if (!same(value.effectAuthority, RECOVERY_TASK_EFFECT_INTENT_EFFECT_AUTHORITY)) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND} must remain non-effecting`);
  }
  if (digestObject(recoveryTaskEffectIntentBody(value)) !== value.intentDigest) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.intentDigest is not bound`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && value[key] !== expectedValue) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND}.${key} does not match the expected value`);
    }
  }
  return freezeDeep(clone({
    ...value,
    dependencies,
    effectAuthority: RECOVERY_TASK_EFFECT_INTENT_EFFECT_AUTHORITY
  }));
}

function sealExecutionRecoveryTaskEffectIntent(value) {
  return validateExecutionRecoveryTaskEffectIntentV1({
    ...clone(value),
    intentDigest: digestObject(value)
  });
}

const RECOVERY_TASK_EFFECT_LAUNCH_INTENT_BINDING_FIELDS = [
  ...RECOVERY_TASK_EFFECT_INTENT_BINDING_FIELDS,
  "intentId", "intentDigest", "reservationId"
];
const RECOVERY_TASK_EFFECT_LAUNCH_ADOPTION_BINDING_FIELDS = [
  "reservationDigest", "adoptionDigest", "validationDigest", "approvalEnvelopeDigest",
  "commandDigest", "effectBindingDigest", "unitId", "executionId", "ownedResourceId",
  "controllerId", "launchEvidenceDigest"
];
const RECOVERY_TASK_EFFECT_OUTCOME_LAUNCH_BINDING_FIELDS = [
  ...RECOVERY_TASK_EFFECT_LAUNCH_INTENT_BINDING_FIELDS,
  ...RECOVERY_TASK_EFFECT_LAUNCH_ADOPTION_BINDING_FIELDS,
  "launchId", "launchDigest"
];

function recoveryTaskEffectLaunchBody(value) {
  const { launchDigest: ignored, ...body } = value;
  return body;
}

function recoveryTaskEffectOutcomeBody(value) {
  const { outcomeDigest: ignored, ...body } = value;
  return body;
}

function validateRecoveryTaskEffectObservationAuthorities(value, label) {
  assertSafeObject(value.effectAuthority, `${label}.effectAuthority`);
  exactKeys(
    value.effectAuthority,
    Object.keys(RECOVERY_TASK_EFFECT_OBSERVATION_EFFECT_AUTHORITY),
    `${label}.effectAuthority`
  );
  if (!same(value.effectAuthority, RECOVERY_TASK_EFFECT_OBSERVATION_EFFECT_AUTHORITY)) {
    throw new Error(`${label} must remain non-effecting`);
  }
  assertSafeObject(value.settlementAuthority, `${label}.settlementAuthority`);
  exactKeys(
    value.settlementAuthority,
    Object.keys(RECOVERY_TASK_EFFECT_OBSERVATION_SETTLEMENT_AUTHORITY),
    `${label}.settlementAuthority`
  );
  if (!same(value.settlementAuthority, RECOVERY_TASK_EFFECT_OBSERVATION_SETTLEMENT_AUTHORITY)) {
    throw new Error(`${label} must not settle a plan or release dependencies`);
  }
}

export function validateExecutionRecoveryTaskEffectLaunchV1(value, expected = {}) {
  assertOwnDataObject(expected, `${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND} expected binding`);
  const expectedKeys = new Set([
    "launchId", "runId", "intentId", "taskId", "handleId", "adoptionDigest",
    "commandDigest", "effectBindingDigest", "controllerId"
  ]);
  for (const key of Object.keys(expected)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND} expected binding contains an unknown key`);
    }
  }
  assertSafeObject(value, EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND);
  exactKeys(value, [
    "schemaVersion", "kind", "status", "launchId",
    ...RECOVERY_TASK_EFFECT_LAUNCH_INTENT_BINDING_FIELDS,
    "dependencies",
    ...RECOVERY_TASK_EFFECT_LAUNCH_ADOPTION_BINDING_FIELDS,
    "dispatchMayHaveStarted", "callbackCalls", "effectStarted", "evidenceStatus", "recordedAt",
    "sourceRegistrySequence", "sourceRegistryStateDigest", "committedRegistrySequence",
    "committedRegistryStateDigest", "effectAuthority", "settlementAuthority", "launchDigest"
  ], EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND ||
      value.status !== "dispatch-window-open") {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND} version/kind/status is invalid`);
  }
  for (const key of [
    "launchId", "runId", "handoffId", "claimId", "releaseId", "consumptionId", "taskId",
    "handleId", "attemptId", "planId", "reservationId", "unitId", "executionId",
    "ownedResourceId", "controllerId"
  ]) assertId(value[key], `${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND}.${key}`);
  for (const key of [
    "handoffDigest", "claimDigest", "releaseDigest", "consumptionDigest", "handleDigest",
    "admissionDigest", "planDigest", "contractDigest", "recoveryPlanDigest", "preparedEventDigest",
    "checkpointStateDigest", "taskStateDigest", "dependencyStateDigest", "intentDigest",
    "reservationDigest", "adoptionDigest", "validationDigest", "approvalEnvelopeDigest",
    "commandDigest", "effectBindingDigest", "launchEvidenceDigest", "sourceRegistryStateDigest",
    "committedRegistryStateDigest", "launchDigest"
  ]) assertDigest(value[key], `${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND}.${key}`);
  for (const key of [
    "preparedEventSequence", "checkpointSequence", "sourceRegistrySequence", "committedRegistrySequence"
  ]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND}.${key} is invalid`);
    }
  }
  if (value.committedRegistrySequence !== value.sourceRegistrySequence + 1 ||
      value.dispatchMayHaveStarted !== true || value.callbackCalls !== null ||
      value.effectStarted !== null || value.evidenceStatus !== "observation-only") {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND} ordering or observation boundary is invalid`);
  }
  if (!Array.isArray(value.dependencies) || utilTypes.isProxy(value.dependencies) || value.dependencies.length > 256) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND}.dependencies is invalid`);
  }
  const dependencies = value.dependencies.map((entry, index) => {
    const label = `${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND}.dependencies[${index}]`;
    assertSafeObject(entry, label);
    exactKeys(entry, ["taskId", "status", "stateDigest"], label);
    if (entry.status !== "succeeded") throw new Error(`${label}.status must be succeeded`);
    return {
      taskId: assertId(entry.taskId, `${label}.taskId`),
      status: "succeeded",
      stateDigest: assertDigest(entry.stateDigest, `${label}.stateDigest`)
    };
  });
  if (new Set(dependencies.map((entry) => entry.taskId)).size !== dependencies.length ||
      dependencies.some((entry, index) => index > 0 && entry.taskId < dependencies[index - 1].taskId) ||
      digestObject(dependencies) !== value.dependencyStateDigest) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND}.dependencies are not uniquely and exactly bound`);
  }
  assertIso(value.consumedAt, `${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND}.consumedAt`);
  assertIso(value.recordedAt, `${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND}.recordedAt`);
  const identity = recoveryTaskEffectLaunchIdentity({
    intentId: value.intentId,
    intentDigest: value.intentDigest,
    reservationId: value.reservationId,
    reservationDigest: value.reservationDigest,
    adoptionDigest: value.adoptionDigest,
    launchEvidenceDigest: value.launchEvidenceDigest
  });
  if (value.launchId !== identity) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND}.launchId is not deterministic`);
  }
  validateRecoveryTaskEffectObservationAuthorities(value, EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND);
  if (digestObject(recoveryTaskEffectLaunchBody(value)) !== value.launchDigest) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND}.launchDigest is not bound`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && value[key] !== expectedValue) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND}.${key} does not match the expected value`);
    }
  }
  return freezeDeep(clone({
    ...value,
    dependencies,
    effectAuthority: RECOVERY_TASK_EFFECT_OBSERVATION_EFFECT_AUTHORITY,
    settlementAuthority: RECOVERY_TASK_EFFECT_OBSERVATION_SETTLEMENT_AUTHORITY
  }));
}

function sealExecutionRecoveryTaskEffectLaunch(value) {
  return validateExecutionRecoveryTaskEffectLaunchV1({
    ...clone(value),
    launchDigest: digestObject(value)
  });
}

export function validateExecutionRecoveryTaskEffectOutcomeV1(value, expected = {}) {
  assertOwnDataObject(expected, `${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND} expected binding`);
  const expectedKeys = new Set([
    "outcomeId", "runId", "launchId", "intentId", "taskId", "handleId", "outcome"
  ]);
  for (const key of Object.keys(expected)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND} expected binding contains an unknown key`);
    }
  }
  assertSafeObject(value, EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND);
  exactKeys(value, [
    "schemaVersion", "kind", "status", "outcomeId",
    ...RECOVERY_TASK_EFFECT_OUTCOME_LAUNCH_BINDING_FIELDS,
    "dependencies", "outcome", "effectResultDigest", "usageDigest", "controllerTransactionId",
    "controllerTransactionDigest", "callbackCalls", "effectStarted", "terminalReason",
    "outcomeEvidenceDigest", "evidenceStatus", "observedAt", "sourceRegistrySequence",
    "sourceRegistryStateDigest", "committedRegistrySequence", "committedRegistryStateDigest",
    "effectAuthority", "settlementAuthority", "outcomeDigest"
  ], EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND ||
      value.status !== "outcome-observed" || !RECOVERY_TASK_EFFECT_OUTCOMES.has(value.outcome)) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND} version/kind/status/outcome is invalid`);
  }
  for (const key of [
    "outcomeId", "runId", "handoffId", "claimId", "releaseId", "consumptionId", "taskId",
    "handleId", "attemptId", "planId", "reservationId", "unitId", "executionId",
    "ownedResourceId", "controllerId", "launchId"
  ]) assertId(value[key], `${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.${key}`);
  for (const key of [
    "handoffDigest", "claimDigest", "releaseDigest", "consumptionDigest", "handleDigest",
    "admissionDigest", "planDigest", "contractDigest", "recoveryPlanDigest", "preparedEventDigest",
    "checkpointStateDigest", "taskStateDigest", "dependencyStateDigest", "intentDigest",
    "reservationDigest", "adoptionDigest", "validationDigest", "approvalEnvelopeDigest",
    "commandDigest", "effectBindingDigest", "launchEvidenceDigest", "launchDigest",
    "outcomeEvidenceDigest", "sourceRegistryStateDigest", "committedRegistryStateDigest", "outcomeDigest"
  ]) assertDigest(value[key], `${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.${key}`);
  for (const key of [
    "preparedEventSequence", "checkpointSequence", "sourceRegistrySequence", "committedRegistrySequence"
  ]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.${key} is invalid`);
    }
  }
  if (value.committedRegistrySequence !== value.sourceRegistrySequence + 1 ||
      value.evidenceStatus !== "observation-only") {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND} ordering or observation boundary is invalid`);
  }
  if (!Array.isArray(value.dependencies) || utilTypes.isProxy(value.dependencies) || value.dependencies.length > 256) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.dependencies is invalid`);
  }
  const dependencies = value.dependencies.map((entry, index) => {
    const label = `${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.dependencies[${index}]`;
    assertSafeObject(entry, label);
    exactKeys(entry, ["taskId", "status", "stateDigest"], label);
    if (entry.status !== "succeeded") throw new Error(`${label}.status must be succeeded`);
    return {
      taskId: assertId(entry.taskId, `${label}.taskId`),
      status: "succeeded",
      stateDigest: assertDigest(entry.stateDigest, `${label}.stateDigest`)
    };
  });
  if (new Set(dependencies.map((entry) => entry.taskId)).size !== dependencies.length ||
      dependencies.some((entry, index) => index > 0 && entry.taskId < dependencies[index - 1].taskId) ||
      digestObject(dependencies) !== value.dependencyStateDigest) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.dependencies are not uniquely and exactly bound`);
  }
  assertIso(value.consumedAt, `${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.consumedAt`);
  assertIso(value.observedAt, `${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.observedAt`);
  if (value.effectResultDigest !== null) {
    assertDigest(value.effectResultDigest, `${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.effectResultDigest`);
  }
  if (value.usageDigest !== null) {
    assertDigest(value.usageDigest, `${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.usageDigest`);
  }
  if (value.controllerTransactionId !== null) {
    assertId(value.controllerTransactionId, `${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.controllerTransactionId`);
  }
  if (value.controllerTransactionDigest !== null) {
    assertDigest(value.controllerTransactionDigest, `${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.controllerTransactionDigest`);
  }
  if ((value.controllerTransactionId === null) !== (value.controllerTransactionDigest === null)) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND} controller transaction binding is partial`);
  }
  if (value.terminalReason !== null) {
    assertId(value.terminalReason, `${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.terminalReason`);
  }
  if (["success", "failure"].includes(value.outcome)) {
    if (value.effectResultDigest === null || value.usageDigest === null ||
        value.controllerTransactionId === null || value.callbackCalls !== 1 ||
        value.effectStarted !== true || value.terminalReason !== null) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND} terminal success/failure observation is incomplete`);
    }
  } else {
    const callbackPair = (value.callbackCalls === 0 && value.effectStarted === false) ||
      (value.callbackCalls === 1 && value.effectStarted === true) ||
      (value.callbackCalls === null && value.effectStarted === null);
    if (value.effectResultDigest !== null || value.usageDigest !== null || !callbackPair ||
        !RECOVERY_TASK_EFFECT_OUTCOME_UNKNOWN_REASONS.has(value.terminalReason)) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND} unknown observation is invalid`);
    }
  }
  const identity = recoveryTaskEffectOutcomeIdentity({
    launchId: value.launchId,
    launchDigest: value.launchDigest
  });
  if (value.outcomeId !== identity) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.outcomeId is not deterministic`);
  }
  validateRecoveryTaskEffectObservationAuthorities(value, EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND);
  if (digestObject(recoveryTaskEffectOutcomeBody(value)) !== value.outcomeDigest) {
    throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.outcomeDigest is not bound`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && value[key] !== expectedValue) {
      throw new Error(`${EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND}.${key} does not match the expected value`);
    }
  }
  return freezeDeep(clone({
    ...value,
    dependencies,
    effectAuthority: RECOVERY_TASK_EFFECT_OBSERVATION_EFFECT_AUTHORITY,
    settlementAuthority: RECOVERY_TASK_EFFECT_OBSERVATION_SETTLEMENT_AUTHORITY
  }));
}

function sealExecutionRecoveryTaskEffectOutcome(value) {
  return validateExecutionRecoveryTaskEffectOutcomeV1({
    ...clone(value),
    outcomeDigest: digestObject(value)
  });
}

const RECOVERY_RESOURCE_ID_FIELDS = ["runId", "handleId", "executionId", "attemptId", "unitId", "ownedResourceId",
  "recoveryEffectIntentId", "launchId", "outcomeId"];
const RECOVERY_RESOURCE_DIGEST_FIELDS = ["sourceBindingDigest", "policyDigest", "fence", "recoveryEffectIntentDigest", "launchDigest", "outcomeDigest"];
const RECOVERY_RESOURCE_BINDING_FIELDS = [...RECOVERY_RESOURCE_ID_FIELDS, ...RECOVERY_RESOURCE_DIGEST_FIELDS,
  "revision", "authorityEpoch", "controllerTransactionId", "controllerTransactionDigest"];
const RECOVERY_RESOURCE_RESOLUTIONS = Object.freeze({ completed: "success", failed: "failure", "not-sent": "not-sent" });

function recoveryResourceBinding(outcome, handle) {
  return {
    ...Object.fromEntries(["runId", "handleId", "executionId", "attemptId", "unitId", "ownedResourceId", "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence"].map((key) => [key, handle[key]])),
    recoveryEffectIntentId: outcome.intentId, recoveryEffectIntentDigest: outcome.intentDigest,
    launchId: outcome.launchId, launchDigest: outcome.launchDigest, outcomeId: outcome.outcomeId, outcomeDigest: outcome.outcomeDigest,
    controllerTransactionId: outcome.controllerTransactionId, controllerTransactionDigest: outcome.controllerTransactionDigest
  };
}

export function validateExecutionRecoveryTaskEffectResourceObservationV1(value, expected = {}) {
  const label = EXECUTION_RECOVERY_TASK_EFFECT_RESOURCE_OBSERVATION_KIND;
  assertOwnDataObject(expected, `${label} expected`);
  if (Object.keys(expected).some((key) => !RECOVERY_RESOURCE_BINDING_FIELDS.includes(key))) throw new Error(`${label} unknown expected key`);
  assertSafeObject(value, label);
  exactKeys(value, ["schemaVersion", "kind", "observationId", ...RECOVERY_RESOURCE_BINDING_FIELDS,
    "controllerStatus", "providerOutcome", "businessOutcome", "observedAt", "evidenceDigest"], label);
  if (value.schemaVersion !== 1 || value.kind !== label || value.businessOutcome !== null ||
      !["active", "terminated", "unknown"].includes(value.controllerStatus) ||
      !["active", "completed", "failed", "not-sent", "unknown"].includes(value.providerOutcome)) throw new Error(`${label} invalid observation`);
  for (const key of [...RECOVERY_RESOURCE_ID_FIELDS, "observationId", "revision"]) assertId(value[key], `${label}.${key}`);
  for (const key of [...RECOVERY_RESOURCE_DIGEST_FIELDS, "evidenceDigest"]) assertDigest(value[key], `${label}.${key}`);
  if (!Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1 ||
      ((value.controllerTransactionId === null) !== (value.controllerTransactionDigest === null))) throw new Error(`${label} invalid transaction or epoch`);
  if (value.controllerTransactionId !== null) {
    assertId(value.controllerTransactionId, `${label}.controllerTransactionId`);
    assertDigest(value.controllerTransactionDigest, `${label}.controllerTransactionDigest`);
  }
  assertIso(value.observedAt, `${label}.observedAt`);
  for (const [key, item] of Object.entries(expected)) if (value[key] !== item) throw new Error(`${label}.${key} binding mismatch`);
  return freezeDeep(clone(value));
}

export function validateExecutionRecoveryTaskEffectReconciliationV1(value, expected = {}) {
  const label = EXECUTION_RECOVERY_TASK_EFFECT_RECONCILIATION_KIND;
  assertOwnDataObject(expected, `${label} expected`);
  if (Object.keys(expected).some((key) => !["runId", "outcomeId", "outcomeDigest"].includes(key))) throw new Error(`${label} unknown expected key`);
  assertSafeObject(value, label);
  exactKeys(value, ["schemaVersion", "kind", "status", "reconciliationId", "runId", "outcomeId", "outcomeDigest",
    "originalOutcome", "handleSnapshot", "observation", "resolvedOutcome", "evidenceStatus", "observedAt",
    "sourceRegistrySequence", "sourceRegistryStateDigest", "committedRegistrySequence", "committedRegistryStateDigest",
    "effectAuthority", "settlementAuthority", "reconciliationDigest"], label);
  const original = validateExecutionRecoveryTaskEffectOutcomeV1(value.originalOutcome, { runId: value.runId });
  const handle = validateExecutionHandleV1(value.handleSnapshot);
  if (digestObject(handle) !== original.handleDigest || handle.handleId !== original.handleId ||
      handle.runId !== original.runId || handle.status !== "ready" || handle.dispatchBlocked !== true || handle.revokedAt !== null) {
    throw new Error(`${label} original handle snapshot is not bound`);
  }
  const observation = validateExecutionRecoveryTaskEffectResourceObservationV1(value.observation, recoveryResourceBinding(original, handle));
  if (value.schemaVersion !== 1 || value.kind !== label || value.status !== "reconciled" || original.outcome !== "unknown" ||
      original.outcomeId !== value.outcomeId || original.outcomeDigest !== value.outcomeDigest || value.evidenceStatus !== "observation-only" ||
      observation.controllerStatus !== "terminated" || !Object.hasOwn(RECOVERY_RESOURCE_RESOLUTIONS, observation.providerOutcome) ||
      value.resolvedOutcome !== RECOVERY_RESOURCE_RESOLUTIONS[observation.providerOutcome] || value.observedAt !== observation.observedAt ||
      ["runId", "handleId", "executionId", "attemptId", "unitId", "ownedResourceId", "launchId", "launchDigest", "outcomeId", "outcomeDigest", "controllerTransactionId", "controllerTransactionDigest"].some((key) => observation[key] !== original[key]) ||
      observation.recoveryEffectIntentId !== original.intentId || observation.recoveryEffectIntentDigest !== original.intentDigest) throw new Error(`${label} is not bound to an UNKNOWN outcome resolution`);
  const id = `recovery-effect-reconciliation:${digestObject({ outcomeId: value.outcomeId, outcomeDigest: value.outcomeDigest })}`;
  if (value.reconciliationId !== id || !Number.isSafeInteger(value.sourceRegistrySequence) || value.sourceRegistrySequence < original.committedRegistrySequence ||
      value.committedRegistrySequence !== value.sourceRegistrySequence + 1) throw new Error(`${label} invalid identity or ordering`);
  for (const key of ["sourceRegistryStateDigest", "committedRegistryStateDigest", "reconciliationDigest"]) assertDigest(value[key], `${label}.${key}`);
  validateRecoveryTaskEffectObservationAuthorities(value, label);
  const { reconciliationDigest, ...body } = value;
  if (digestObject(body) !== reconciliationDigest) throw new Error(`${label} digest mismatch`);
  for (const [key, item] of Object.entries(expected)) if (value[key] !== item) throw new Error(`${label}.${key} binding mismatch`);
  return freezeDeep(clone(value));
}

function createSha256(value) {
  // Dynamic import would make pure key generation asynchronous.  The runtime
  // uses a small synchronous SHA-256 implementation only for this digest.
  // Node's built-in implementation is loaded once below through a lazy
  // require-free ESM-compatible module binding.
  return sha256Sync(value);
}

// `node:crypto` is imported lazily through a statically initialized binding in
// order to keep the public API synchronous without exposing a mutable helper.
import { createHash } from "node:crypto";
function sha256Sync(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function initialRegistry(runId) {
  const value = {
    schemaVersion: 1,
    kind: EXECUTION_RUNTIME_KIND,
    runId,
    sequence: 0,
    stateDigest: null,
    handles: {},
    intents: {},
    stopRequests: {},
    stopReceipts: {},
    recoveryPlans: {}
  };
  value.stateDigest = registryDigest(value);
  return value;
}

function registryDigest(value) {
  // This checkpoint proves semantic consistency between a snapshot and its
  // journal transition.  It is not an authentication tag: a writer that can
  // replace the data can recompute the digest too.  Authority trust remains at
  // the separately attested controller boundary used for fresh admission.
  const { stateDigest: ignored, ...withoutDigest } = value;
  return digestObject(withoutDigest);
}

function withRegistryDigest(value) {
  const next = clone(value);
  next.stateDigest = registryDigest(next);
  return next;
}

const REGISTRY_MAP_ID_FIELDS = Object.freeze({
  handles: "handleId",
  intents: "intentId",
  stopRequests: "stopRequestId",
  stopReceipts: "stopReceiptId",
  recoveryPlans: "recoveryPlanId"
});

function validateRegistryMapIds(value) {
  for (const [mapKey, idField] of Object.entries(REGISTRY_MAP_ID_FIELDS)) {
    for (const [mapId, item] of Object.entries(value[mapKey])) {
      if (!isPlainObject(item) || item[idField] !== mapId) {
        throw new Error(`Execution registry ${mapKey} map key ${mapId} does not match record ${idField}`);
      }
    }
  }
}

function validateRegistryRelations(value) {
  for (const intent of Object.values(value.intents)) {
    const handle = value.handles[intent.handleId];
    if (!handle) throw new Error(`Execution registry intent ${intent.intentId} references a missing handle`);
    assertIntentBinding(intent, handle, `Execution registry intent ${intent.intentId}`);
  }
  for (const request of Object.values(value.stopRequests)) {
    const handle = value.handles[request.handleId];
    if (!handle) throw new Error(`Execution registry stop request ${request.stopRequestId} references a missing handle`);
    assertStopRequestBinding(request, handle, `Execution registry stop request ${request.stopRequestId}`);
  }
  for (const receipt of Object.values(value.stopReceipts)) {
    const request = value.stopRequests[receipt.stopRequestId];
    if (!request) throw new Error(`Execution registry stop receipt ${receipt.stopReceiptId} references a missing stop request`);
    const handle = value.handles[receipt.handleId];
    if (!handle) throw new Error(`Execution registry stop receipt ${receipt.stopReceiptId} references a missing handle`);
    if (receipt.handleId !== request.handleId || receipt.reason !== request.reason ||
        receipt.securityRcaRequired !== request.securityRcaRequired ||
        receipt.authorityEpoch !== request.authorityEpoch || receipt.fence !== request.fence) {
      throw new Error(`Execution registry stop receipt ${receipt.stopReceiptId} is not bound to its request`);
    }
    assertStopRequestBinding(receipt, handle, `Execution registry stop receipt ${receipt.stopReceiptId}`);
  }
  for (const plan of Object.values(value.recoveryPlans)) {
    const oldHandle = value.handles[plan.fromHandleId];
    const newHandle = value.handles[plan.newHandleId];
    if (!oldHandle || !newHandle) throw new Error(`Execution registry recovery plan ${plan.recoveryPlanId} references a missing handle`);
    if (plan.fromHandleId === plan.newHandleId || plan.runId !== oldHandle.runId ||
        plan.executionId !== newHandle.executionId || plan.newAttemptId !== newHandle.attemptId ||
        plan.priorAttemptId !== oldHandle.attemptId || plan.unitId !== oldHandle.unitId ||
        plan.sourceBindingDigest !== oldHandle.sourceBindingDigest || plan.policyDigest !== oldHandle.policyDigest ||
        plan.revision !== oldHandle.revision || plan.oldAuthorityEpoch !== oldHandle.authorityEpoch ||
        plan.oldFence !== oldHandle.fence || plan.newAuthorityEpoch !== newHandle.authorityEpoch ||
        plan.newFence !== newHandle.fence) {
      throw new Error(`Execution registry recovery plan ${plan.recoveryPlanId} is not bound to its handles`);
    }
  }
}

function validateObligationReservations(value) {
  const groups = new Map();
  const childByParent = new Map();
  const hasNotSentIntent = (handleId) => Object.values(value.intents).some((intent) =>
    intent.handleId === handleId && intent.status === "not-sent" && intent.callbackCalls === 0 && intent.dispatchReserved === false
  );
  for (const [handleId, handle] of Object.entries(value.handles)) {
    const group = groups.get(handle.obligationKey) ?? [];
    group.push({ handleId, handle });
    groups.set(handle.obligationKey, group);

    const sourceId = handle.origin.resumedFromHandleId;
    const priorAttemptId = handle.origin.priorAttemptId;
    const hasSource = sourceId !== undefined || priorAttemptId !== undefined;
    if (!hasSource) continue;
    if (sourceId === undefined || priorAttemptId === undefined) {
      throw new Error(`Execution registry handle ${handleId} has an incomplete recovery origin`);
    }
    const source = value.handles[sourceId];
    if (!source || sourceId === handleId) {
      throw new Error(`Execution registry handle ${handleId} has a missing recovery source`);
    }
    if (!["revoked", "stopped", "failed", "indeterminate"].includes(source.status) &&
        !(source.status === "ready" && hasNotSentIntent(sourceId))) {
      throw new Error(`Execution registry handle ${handleId} has a non-recoverable recovery source`);
    }
    if (priorAttemptId !== source.attemptId || handle.obligationKey !== source.obligationKey ||
        handle.executionScopeDigest !== source.executionScopeDigest || handle.authorityEpoch <= source.authorityEpoch) {
      throw new Error(`Execution registry handle ${handleId} recovery origin is not bound to its source`);
    }
    if (!Object.values(value.recoveryPlans).some((plan) => plan.fromHandleId === sourceId && plan.newHandleId === handleId)) {
      throw new Error(`Execution registry handle ${handleId} has no persisted recovery plan`);
    }
    if (childByParent.has(sourceId)) throw new Error(`Execution registry obligation reservation forks at handle ${sourceId}`);
    childByParent.set(sourceId, handleId);
  }

  for (const [obligationKey, group] of groups) {
    if (group.length === 1) continue;
    const roots = group.filter(({ handle }) => handle.origin.resumedFromHandleId === undefined);
    if (roots.length !== 1) throw new Error(`Execution registry obligation ${obligationKey} has multiple roots`);
    const members = new Set();
    let current = roots[0].handleId;
    while (current !== undefined && !members.has(current)) {
      members.add(current);
      current = childByParent.get(current);
    }
    if (members.size !== group.length || current !== undefined) {
      throw new Error(`Execution registry obligation ${obligationKey} has an invalid reservation chain`);
    }
  }
}

function validateRegistry(value, runId) {
  assertSafeObject(value, EXECUTION_RUNTIME_KIND);
  const expected = ["schemaVersion", "kind", "runId", "sequence", "stateDigest", "handles", "intents", "stopRequests", "stopReceipts", "recoveryPlans"];
  exactKeys(value, expected, EXECUTION_RUNTIME_KIND);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_RUNTIME_KIND || value.runId !== runId) throw new Error("Execution registry identity is invalid");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error("Execution registry sequence is invalid");
  assertDigest(value.stateDigest, "Execution registry stateDigest");
  for (const key of ["handles", "intents", "stopRequests", "stopReceipts", "recoveryPlans"]) {
    if (!isPlainObject(value[key])) throw new Error(`Execution registry ${key} must be an object`);
  }
  validateRegistryMapIds(value);
  for (const item of Object.values(value.handles)) {
    const handle = validateHandle(item);
    const binding = bindingForHandle(handle);
    if (handle.executionScopeDigest !== computeExecutionScopeDigest(binding)) {
      throw new Error(`Execution registry handle ${handle.handleId} execution scope digest is not bound`);
    }
    if (handle.obligationKey !== computeObligationKey(binding)) {
      throw new Error(`Execution registry handle ${handle.handleId} obligation key is not bound`);
    }
  }
  for (const item of Object.values(value.stopRequests)) validateStopRequest(item);
  for (const item of Object.values(value.stopReceipts)) validateStopReceipt(item);
  for (const item of Object.values(value.recoveryPlans)) validateRecoveryPlan(item);
  for (const intent of Object.values(value.intents)) validateIntent(intent);
  validateRegistryRelations(value);
  validateObligationReservations(value);
  if (registryDigest(value) !== value.stateDigest) throw new Error("Execution registry digest is invalid");
  return value;
}

/**
 * Validate the exact snapshot returned by ExecutionRegistryV1.load().
 *
 * The canonical registry state and its stateDigest deliberately exclude the
 * durable admission ledger because admissions are replay-derived from the
 * append-only journal.  Consumers that classify recovery must therefore bind
 * that derived map explicitly instead of treating stateDigest as admission
 * provenance.  This helper is pure: it never opens or repairs a registry and
 * it cannot mint fresh authority.
 */
export function validateExecutionRegistrySnapshotV1(value, expectedRunId) {
  const label = "ExecutionRegistrySnapshotV1";
  assertSafeObject(value, label);
  exactKeys(value, [
    "schemaVersion", "kind", "runId", "sequence", "stateDigest", "handles", "intents",
    "stopRequests", "stopReceipts", "recoveryPlans", "admissions"
  ], label);
  if (typeof expectedRunId !== "string" || !RUN_ID_PATTERN.test(expectedRunId)) {
    throw new Error(label + " expected runId is invalid");
  }
  const snapshot = clone(value);
  const { admissions, ...canonical } = snapshot;
  const state = validateRegistry(canonical, expectedRunId);
  assertSafeObject(admissions, label + ".admissions");

  const expectedHandleIds = Object.entries(state.handles)
    .filter(([, handle]) => handle.admissionDigest !== undefined)
    .map(([handleId]) => handleId)
    .sort();
  const actualHandleIds = Object.keys(admissions).sort();
  if (expectedHandleIds.length !== actualHandleIds.length ||
      expectedHandleIds.some((handleId, index) => handleId !== actualHandleIds[index])) {
    throw new Error(label + ".admissions does not exactly cover the V3 handles");
  }

  const normalizedAdmissions = {};
  const seenReservations = new Set();
  const seenAdmissionIds = new Set();
  for (const handleId of expectedHandleIds) {
    const handle = state.handles[handleId];
    const admission = validateExecutionAdmission(admissions[handleId]);
    if (digestExecutionAdmission(admission) !== handle.admissionDigest) {
      throw new Error(label + ".admissions." + handleId + " digest is not bound to its handle");
    }
    for (const key of [
      "runId", "executionId", "attemptId", "unitId", "ownedResourceId",
      "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence"
    ]) {
      if (admission[key] !== handle[key]) {
        throw new Error(label + ".admissions." + handleId + "." + key + " is not bound to its handle");
      }
    }
    const reservation = reservationKey(admission);
    if (seenReservations.has(reservation)) {
      throw new Error(label + ".admissions contains a replayed reservation");
    }
    if (seenAdmissionIds.has(admission.admissionId)) {
      throw new Error(label + ".admissions contains a replayed admission identity");
    }
    seenReservations.add(reservation);
    seenAdmissionIds.add(admission.admissionId);
    normalizedAdmissions[handleId] = admission;
  }

  return freezeDeep(clone({ ...state, admissions: normalizedAdmissions }));
}

function validateIntent(value) {
  assertSafeObject(value, "ExecutionIntentV1");
  const intentKeys = [
    "schemaVersion", "kind", "intentId", "handleId", "runId", "executionId", "attemptId", "unitId",
    "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence", "executionScopeDigest",
    "controllerIncarnation", "ownerLeaseId", "createdAt", "status", "callbackCalls", "dispatchStartedAt", "sealedAt",
    "outcome", "effectDigest", "unknownReason", "lateCallback", "dispatchReserved", "notSentAt", "notSentReason"
  ];
  if (value.admissionSeal !== undefined) intentKeys.push("admissionSeal");
  if (value.reconciliation !== undefined) intentKeys.push("reconciliation");
  if (value.cleanupResolution !== undefined) intentKeys.push("cleanupResolution");
  if (value.usageObservation !== undefined) intentKeys.push("usageObservation");
  exactKeys(value, intentKeys, "ExecutionIntentV1");
  if (value.schemaVersion !== 1 || value.kind !== "ExecutionIntentV1") throw new Error("Execution intent kind/version is invalid");
  assertId(value.intentId, "ExecutionIntentV1.intentId");
  assertId(value.handleId, "ExecutionIntentV1.handleId");
  const binding = bindingFromInput(value, { label: "ExecutionIntentV1" });
  assertEpoch(value.authorityEpoch, "ExecutionIntentV1.authorityEpoch");
  assertFence(value.fence, "ExecutionIntentV1.fence");
  assertDigest(value.executionScopeDigest, "ExecutionIntentV1.executionScopeDigest");
  if (value.controllerIncarnation !== null) assertId(value.controllerIncarnation, "ExecutionIntentV1.controllerIncarnation");
  if (value.ownerLeaseId !== null) assertId(value.ownerLeaseId, "ExecutionIntentV1.ownerLeaseId");
  assertIso(value.createdAt, "ExecutionIntentV1.createdAt");
  if (!["pending", "dispatching", "not-sent", "sealed", "unknown", "cancelled"].includes(value.status)) throw new Error("ExecutionIntentV1.status is invalid");
  if (!Number.isSafeInteger(value.callbackCalls) || value.callbackCalls < 0 || value.callbackCalls > 1) throw new Error("ExecutionIntentV1.callbackCalls is invalid");
  for (const key of ["dispatchStartedAt", "sealedAt"]) if (value[key] !== null) assertIso(value[key], `ExecutionIntentV1.${key}`);
  if (value.outcome !== null && !["success", "failure", "unknown"].includes(value.outcome)) throw new Error("ExecutionIntentV1.outcome is invalid");
  if (value.effectDigest !== null) assertDigest(value.effectDigest, "ExecutionIntentV1.effectDigest");
  if (value.admissionSeal !== undefined) validateTrustedAdmissionSeal(value.admissionSeal, {
    runId: value.runId,
    handleId: value.handleId,
    intentId: value.intentId,
    authorityEpoch: value.authorityEpoch,
    fence: value.fence,
    ...(value.outcome === null ? {} : { outcome: value.outcome }),
      ...(value.effectDigest === null ? {} : { effectDigest: value.effectDigest })
  });
  if (value.cleanupResolution !== undefined) {
    const cleanup = validateExecutionOwnedCleanupResolution(value.cleanupResolution, "ExecutionIntentV1.cleanupResolution");
    for (const key of [
      "runId", "handleId", "intentId", "executionId", "attemptId", "unitId",
      "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence"
    ]) {
      const expected = key === "handleId" ? value.handleId : value[key];
      if (cleanup[key] !== expected) throw new Error(`ExecutionIntentV1.cleanupResolution.${key} is not bound`);
    }
    if (cleanup.effectStarted !== true || cleanup.launchRequested !== true || cleanup.groupTerminated !== true ||
        cleanup.lateLaunchBlocked !== true || cleanup.noSendProof !== null) {
      throw new Error("ExecutionIntentV1.cleanupResolution crossed an effect boundary incorrectly");
    }
  }
  if (value.usageObservation !== undefined) {
    if (value.usageObservation === null) {
      if (value.status === "sealed") throw new Error("ExecutionIntentV1 sealed usage observation is missing");
    } else {
      validateExecutionUsageObservation(value.usageObservation, {
        runId: value.runId,
        handleId: value.handleId,
        intentId: value.intentId,
        executionId: value.executionId,
        attemptId: value.attemptId,
        unitId: value.unitId,
        sourceBindingDigest: value.sourceBindingDigest,
        policyDigest: value.policyDigest,
        revision: value.revision,
        authorityEpoch: value.authorityEpoch,
        fence: value.fence
      }, "ExecutionIntentV1.usageObservation");
      if (value.status !== "sealed") throw new Error("ExecutionIntentV1 usage observation is only valid for a sealed intent");
    }
  }
  if (value.reconciliation !== undefined) {
    if (!Array.isArray(value.reconciliation) || value.reconciliation.length < 1 || value.reconciliation.length > 16) {
      throw new Error("ExecutionIntentV1.reconciliation history is invalid");
    }
    const ids = new Set();
    for (const record of value.reconciliation) {
      validateExecutionReconciliation(record, {
        runId: value.runId,
        handleId: value.handleId,
        intentId: value.intentId,
        executionId: value.executionId,
        attemptId: value.attemptId,
        unitId: value.unitId,
        sourceBindingDigest: value.sourceBindingDigest,
        policyDigest: value.policyDigest,
        revision: value.revision,
        authorityEpoch: value.authorityEpoch,
        fence: value.fence
      });
      if (ids.has(record.reconciliationId)) throw new Error("ExecutionIntentV1.reconciliation history contains a duplicate record");
      ids.add(record.reconciliationId);
    }
  }
  if (value.unknownReason !== null) assertText(value.unknownReason, "ExecutionIntentV1.unknownReason");
  assertBoolean(value.lateCallback, "ExecutionIntentV1.lateCallback");
  assertBoolean(value.dispatchReserved, "ExecutionIntentV1.dispatchReserved");
  if (value.notSentAt !== null) assertIso(value.notSentAt, "ExecutionIntentV1.notSentAt");
  if (value.notSentReason !== null) assertText(value.notSentReason, "ExecutionIntentV1.notSentReason");
  if (value.status !== "not-sent" && (value.notSentAt !== null || value.notSentReason !== null)) {
    throw new Error("ExecutionIntentV1 not-sent evidence is only valid for not-sent state");
  }
  if (value.status === "not-sent" && (value.callbackCalls !== 0 || value.dispatchReserved !== false ||
      value.notSentAt === null || value.notSentReason === null || value.outcome !== null || value.effectDigest !== null)) {
    throw new Error("ExecutionIntentV1 not-sent state is invalid");
  }
  if (value.status === "dispatching" && (value.callbackCalls !== 0 || value.dispatchReserved !== true ||
      value.notSentAt !== null || value.notSentReason !== null)) {
    throw new Error("ExecutionIntentV1 dispatch reservation is invalid");
  }
  if (value.status === "sealed" && (value.callbackCalls !== 1 || value.dispatchReserved !== false ||
      value.notSentAt !== null || value.notSentReason !== null)) {
    throw new Error("ExecutionIntentV1 sealed callback state is invalid");
  }
  if (value.status === "unknown" && ((value.dispatchReserved === false && value.callbackCalls !== 1) ||
      (value.dispatchReserved === true && value.callbackCalls !== 0))) {
    throw new Error("ExecutionIntentV1 post-callback unknown state is invalid");
  }
  return { ...value, ...binding };
}

function intentFor(handle, intentId, clock) {
  const value = {
    schemaVersion: 1,
    kind: "ExecutionIntentV1",
    intentId,
    handleId: handle.handleId,
    runId: handle.runId,
    executionId: handle.executionId,
    attemptId: handle.attemptId,
    unitId: handle.unitId,
    sourceBindingDigest: handle.sourceBindingDigest,
    policyDigest: handle.policyDigest,
    revision: handle.revision,
    authorityEpoch: handle.authorityEpoch,
    fence: handle.fence,
    executionScopeDigest: handle.executionScopeDigest,
    controllerIncarnation: null,
    ownerLeaseId: null,
    createdAt: nowIso(clock),
    status: "pending",
    callbackCalls: 0,
    dispatchStartedAt: null,
    sealedAt: null,
    outcome: null,
    effectDigest: null,
    unknownReason: null,
    lateCallback: false,
    dispatchReserved: false,
    notSentAt: null,
    notSentReason: null,
    usageObservation: null
  };
  validateIntent(value);
  return value;
}

function buildHandle(binding, authority, clock, origin = null, admission = null) {
  const handleId = randomUUID();
  const createdAt = nowIso(clock);
  const value = {
    schemaVersion: 1,
    kind: EXECUTION_HANDLE_KIND,
    handleId,
    ...binding,
    ownedResourceId: binding.ownedResourceId ?? authority.ownedResourceId,
    authorityEpoch: authority.authorityEpoch,
    fence: authority.fence,
    executionScopeDigest: computeExecutionScopeDigest(binding),
    obligationKey: computeObligationKey(binding),
    ...(admission ? { admissionDigest: digestExecutionAdmission(admission) } : {}),
    createdAt,
    status: "ready",
    dispatchBlocked: false,
    revokedAt: null,
    origin: {
      ...(origin ?? {
      handleId,
      runId: binding.runId,
      executionId: binding.executionId,
      attemptId: binding.attemptId,
      unitId: binding.unitId,
      sourceBindingDigest: binding.sourceBindingDigest,
      policyDigest: binding.policyDigest,
      revision: binding.revision,
      authorityEpoch: authority.authorityEpoch,
      fence: authority.fence,
      createdAt
      }),
      handleId
    }
  };
  if (!value.ownedResourceId) throw new Error("Trusted authority must bind an owned resource identity");
  validateHandle(value);
  return value;
}

function buildCurrentRequest(handleOrBinding) {
  return {
    runId: handleOrBinding.runId,
    executionId: handleOrBinding.executionId,
    attemptId: handleOrBinding.attemptId,
    unitId: handleOrBinding.unitId,
    sourceBindingDigest: handleOrBinding.sourceBindingDigest,
    policyDigest: handleOrBinding.policyDigest,
    revision: handleOrBinding.revision,
    ...(handleOrBinding.ownedResourceId === undefined ? {} : { ownedResourceId: handleOrBinding.ownedResourceId })
  };
}

async function readFreshControllerBinding(controller, requested, { clock = undefined } = {}) {
  const observed = typeof controller.readExecutionBinding === "function"
    ? await controller.readExecutionBinding({ runId: requested.runId, binding: clone(requested) })
    : {
        runContract: await controller.readRunContract({ runId: requested.runId }),
        sourceBinding: await controller.readSourceBinding({ runId: requested.runId }),
        authority: await controller.readAuthority(clone(requested))
      };
  const runContract = validateRunContract(observed.runContract, requested);
  const sourceBinding = validateSourceBinding(observed.sourceBinding, requested);
  const authority = validateAuthority(observed.authority, requested);
  if (authority.authorityEpoch !== undefined && authority.revision !== runContract.revision) {
    throw new Error("Trusted authority revision does not match the current run contract");
  }
  const authorityIsV3 = isV3Authority(authority);
  const contractIsV3 = isV3RunContract(runContract);
  if (authorityIsV3 || contractIsV3) {
    if (!authorityIsV3 || !contractIsV3) {
      throw new Error("V3 current admission requires matching V3 run contract and TCB authority");
    }
    const current = buildExecutionAdmission({
      runContract,
      authority,
      binding: requested,
      now: clock?.now?.() ?? new Date()
    });
    return { runContract, sourceBinding, authority, admission: current.admission, nativeContract: current.runContract, envelope: current.envelope, capability: current.capability };
  }
  return { runContract, sourceBinding, authority, admission: null, nativeContract: null, envelope: null, capability: null };
}

/**
 * Observe one fresh, TCB-attested V3 admission without reserving it in the
 * execution registry.  The returned record is capability-bearing data, but
 * this function creates no handle, intent, durable reservation, or effect
 * path.  A consumer must bind it at its own durable admission boundary before
 * it can be used by the runtime.
 */
export async function readFreshExecutionAdmissionV1(options = {}) {
  assertOwnDataObject(options, "readFreshExecutionAdmissionV1 options");
  const allowed = new Set(["controller", "binding", "clock"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new Error(`readFreshExecutionAdmissionV1 options contains an unknown key: ${key}`);
  }
  if (!Object.hasOwn(options, "controller") || !Object.hasOwn(options, "binding")) {
    throw new Error("readFreshExecutionAdmissionV1 requires controller and binding");
  }
  const controller = validateController(options.controller);
  if (typeof controller.readExecutionBinding !== "function") {
    const error = new Error("Fresh execution admission observation requires one atomic trusted execution-binding read");
    error.code = "EADMISSION_HOLD";
    error.status = "HOLD";
    throw error;
  }
  assertOwnDataObject(options.binding, "fresh execution admission binding");
  const binding = bindingFromInput(options.binding, { label: "fresh execution admission binding" });
  if (!binding.ownedResourceId) {
    throw new Error("fresh execution admission binding requires an authority-bound ownedResourceId");
  }
  if (options.clock !== undefined) assertOwnDataObject(options.clock, "fresh execution admission clock");
  const clock = options.clock === undefined ? undefined : safeClock(options.clock);
  const fresh = await readFreshControllerBinding(controller, binding, { clock });
  if (!fresh.admission) {
    const error = new Error("Fresh execution admission requires a matching V3 run contract and TCB authority");
    error.code = "EADMISSION_HOLD";
    error.status = "HOLD";
    throw error;
  }
  return freezeDeep(clone(fresh.admission));
}

function assertCurrentAuthority(handle, authority) {
  if (authority.authorityEpoch !== handle.authorityEpoch || authority.fence !== handle.fence) {
    throw new Error("Execution fence or authority epoch is stale");
  }
  if (authority.revoked === true || authority.status !== "active") throw new Error("Execution authority is revoked");
}

function assertFreshBindingForHandle(handle, fresh, persistedAdmission = null, { allowRevoked = false } = {}) {
  if (persistedAdmission && !fresh.admission) {
    throw new Error("Persisted V3 execution cannot downgrade to a legacy run contract");
  }
  if (!persistedAdmission && fresh.admission) {
    throw new Error("Legacy execution handle cannot be upgraded without a new admission");
  }
  if (persistedAdmission) assertSameExecutionAdmission(persistedAdmission, fresh.admission);
  if (!allowRevoked) assertCurrentAuthority(handle, fresh.authority);
  return fresh;
}

function assertNoLateMutation(handle, intent) {
  if (handle.dispatchBlocked || ["revoked", "stopped", "indeterminate"].includes(handle.status)) {
    throw new Error("Execution is revoked or dispatch-blocked");
  }
  if (intent.status !== "dispatching" || intent.dispatchReserved !== true) throw new Error("Execution intent is not dispatchable");
}

function calculateStopOutcome(localOutcome, remoteOutcome) {
  if (localOutcome === "stopped" && ["stopped", "not-applicable"].includes(remoteOutcome)) return "STOPPED";
  if (localOutcome === "indeterminate" || remoteOutcome === "unknown") return "INDETERMINATE";
  return "UNKNOWN";
}

function createStopReceipt(request, adapterResult, clock) {
  const safeResult = isPlainObject(adapterResult) ? adapterResult : {};
  const confirmedOwnedScope = safeResult.confirmedOwnedScope === true && safeResult.ownedResourceId === request.ownedResourceId;
  const localOutcome = LOCAL_STOP_OUTCOMES.has(safeResult.localOutcome) && confirmedOwnedScope
    ? safeResult.localOutcome
    : "unknown";
  const remoteOutcome = REMOTE_STOP_OUTCOMES.has(safeResult.remoteOutcome) ? safeResult.remoteOutcome : "unknown";
  const receipt = {
    schemaVersion: 1,
    kind: STOP_RECEIPT_KIND,
    stopReceiptId: randomUUID(),
    stopRequestId: request.stopRequestId,
    handleId: request.handleId,
    runId: request.runId,
    executionId: request.executionId,
    attemptId: request.attemptId,
    unitId: request.unitId,
    sourceBindingDigest: request.sourceBindingDigest,
    policyDigest: request.policyDigest,
    revision: request.revision,
    authorityEpoch: request.authorityEpoch,
    fence: request.fence,
    ownedResourceId: request.ownedResourceId,
    localOutcome,
    remoteOutcome,
    outcome: calculateStopOutcome(localOutcome, remoteOutcome),
    confirmedOwnedScope,
    securityRcaRequired: request.securityRcaRequired,
    reason: request.reason,
    createdAt: nowIso(clock),
    details: {
      adapter: safeResult.adapter ?? null,
      message: safeResult.message ?? null,
      error: safeResult.error ?? null
    }
  };
  validateStopReceipt(receipt);
  return receipt;
}

async function ensureDirectory(root, runId) {
  await ensurePrivateDir(root);
  await ensurePrivateDir(safeJoin(root, "runs"));
  await ensurePrivateDir(safeJoin(root, "runs", runId));
}

async function assertNoSymlinkUnderReadOnly(root, target) {
  assertPrivateStateBackendAvailableV1();
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = safeJoin(resolvedRoot, path.relative(resolvedRoot, path.resolve(target)));
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  const components = relative.split(path.sep).filter(Boolean);
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = path.join(current, components[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink path component: ${current}`);
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`Expected directory path component: ${current}`);
    }
  }
  return true;
}

async function assertReadOnlyDirectory(root, target, label) {
  const exists = await assertNoSymlinkUnderReadOnly(root, target);
  if (!exists) {
    const error = new Error(`${label} does not exist`);
    error.code = "ENOENT";
    throw error;
  }
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is not a real directory`);
  return info;
}

async function readJsonReadOnly(root, target) {
  assertPrivateStateBackendAvailableV1();
  const exists = await assertNoSymlinkUnderReadOnly(root, target);
  if (!exists) {
    const error = new Error(`JSON path does not exist: ${target}`);
    error.code = "ENOENT";
    throw error;
  }
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error(`Unsafe JSON path: ${target}`);
  }
  return JSON.parse(await readFile(target, "utf8"));
}

function directoryIdentity(info) {
  return Object.freeze({ device: String(info.dev), inode: String(info.ino) });
}

async function readDirectoryIdentity(target, label) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is not a real directory`);
  return directoryIdentity(info);
}

async function readJournalBytes(root, runDir, { observationOnly = false } = {}) {
  const target = safeJoin(runDir, "journal.jsonl");
  if (observationOnly) await assertNoSymlinkUnderReadOnly(root, target);
  else await assertNoSymlinkUnder(root, target);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error(`Unsafe journal path: ${target}`);
  }
  return readFile(target);
}

function parseJournalFrames(bytes, start = 0) {
  if (!Buffer.isBuffer(bytes)) throw new Error("Execution registry journal bytes are invalid");
  if (!Number.isSafeInteger(start) || start < 0 || start > bytes.length || (start > 0 && bytes[start - 1] !== 0x0a)) {
    throw new Error("Execution registry journal replay offset is not a line boundary");
  }
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0x0a) {
    throw new Error("Execution registry journal has a partial tail");
  }
  const records = [];
  let lineStart = start;
  for (let index = start; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    if (index === lineStart) throw new Error("Execution registry journal contains an empty record");
    records.push({
      record: JSON.parse(bytes.subarray(lineStart, index).toString("utf8")),
      start: lineStart,
      end: index + 1
    });
    lineStart = index + 1;
  }
  if (lineStart !== bytes.length) throw new Error("Execution registry journal has a partial tail");
  return records;
}

function admissionForBinding(admission, binding, label = "execution admission") {
  const normalized = validateExecutionAdmission(admission);
  const fields = ["runId", "executionId", "attemptId", "unitId", "sourceBindingDigest", "policyDigest", "revision"];
  for (const field of fields) {
    if (normalized[field] !== binding[field]) throw new Error(`${label}.${field} does not match its execution binding`);
  }
  if (normalized.authorityEpoch !== binding.authorityEpoch || normalized.fence !== binding.fence) {
    throw new Error(`${label} authority epoch or fence does not match its execution binding`);
  }
  return normalized;
}

function admissionRecordsFromRecord(record, label = "execution admission journal record") {
  if (!isPlainObject(record) || !isPlainObject(record.payload)) return [];
  const candidates = [];
  if (Object.hasOwn(record.payload, "admission")) {
    candidates.push({
      handleId: record.payload.handleId ?? record.payload.newHandleId,
      admission: record.payload.admission
    });
  }
  if (record.op === "recovery.batch-committed" && Array.isArray(record.payload.entries)) {
    for (const entry of record.payload.entries) {
      candidates.push({ handleId: entry?.handleId, admission: entry?.admission });
    }
  }
  return candidates.map((candidate, index) => {
    try {
      return {
        handleId: assertId(candidate.handleId, `${label}[${index}].handleId`),
        admission: validateExecutionAdmission(candidate.admission)
      };
    } catch (error) {
      throw new Error(`${label}[${index}] is invalid: ${error.message}`);
    }
  });
}

function addAdmissionLedgerRecord(byHandle, byReservation, byAdmissionId, record, runId) {
  for (const { handleId, admission } of admissionRecordsFromRecord(record)) {
    if (admission.runId !== runId) throw new Error("Execution admission journal record has the wrong run identity");
    if (byHandle.has(handleId)) throw new Error(`Execution admission reservation is duplicated for handle ${handleId}`);
    const key = reservationKey(admission);
    if (byReservation.has(key)) throw new Error("Execution admission nonce replayed within the run");
    if (byAdmissionId.has(admission.admissionId)) throw new Error("Execution admission identity replayed within the run");
    byHandle.set(handleId, admission);
    byReservation.set(key, handleId);
    byAdmissionId.add(admission.admissionId);
  }
}

function deriveAdmissionLedger(records, runId, seed = null) {
  const byHandle = seed?.byHandle instanceof Map ? new Map(seed.byHandle) : new Map();
  const byReservation = new Map();
  const byAdmissionId = new Set();
  for (const [handleId, admissionValue] of byHandle) {
    assertId(handleId, "cached execution admission handleId");
    const admission = validateExecutionAdmission(admissionValue);
    if (admission.runId !== runId) throw new Error("Cached execution admission has the wrong run identity");
    const key = reservationKey(admission);
    if (byReservation.has(key)) throw new Error("Cached execution admission nonce is duplicated within the run");
    if (byAdmissionId.has(admission.admissionId)) {
      throw new Error("Cached execution admission identity is duplicated within the run");
    }
    byHandle.set(handleId, admission);
    byReservation.set(key, handleId);
    byAdmissionId.add(admission.admissionId);
  }
  for (const record of records) {
    addAdmissionLedgerRecord(byHandle, byReservation, byAdmissionId, record, runId);
  }
  return byHandle;
}

function addRecoveryHandoffRecord(byId, record, runId) {
  if (!isPlainObject(record) || record.op !== "recovery.batch-committed" || !isPlainObject(record.payload)) return;
  const handoff = validateExecutionRecoveryHandoffV1(record.payload.handoff, { runId });
  if (byId.has(handoff.handoffId)) throw new Error(`Execution recovery handoff is duplicated: ${handoff.handoffId}`);
  byId.set(handoff.handoffId, handoff);
}

function deriveRecoveryHandoffs(records, runId, seed = null) {
  const byId = seed instanceof Map ? new Map(seed) : new Map();
  for (const record of records) addRecoveryHandoffRecord(byId, record, runId);
  return byId;
}

function deriveRecoveryAuthorityLedger(records, runId, {
  recoveryHandoffs = new Map(),
  recoveryClaims = new Map(),
  recoveryTaskReleases = new Map(),
  recoveryTaskPermitConsumptions = new Map(),
  recoveryTaskEffectIntents = new Map(),
  recoveryTaskEffectLaunches = new Map(),
  recoveryTaskEffectOutcomes = new Map(),
  recoveryTaskEffectReconciliations = new Map()
} = {}) {
  const handoffsById = new Map(recoveryHandoffs);
  const claimsById = new Map(recoveryClaims);
  const releasesById = new Map(recoveryTaskReleases);
  const consumptionsById = new Map(recoveryTaskPermitConsumptions);
  const effectIntentsById = new Map(recoveryTaskEffectIntents);
  const effectLaunchesById = new Map(recoveryTaskEffectLaunches);
  const effectOutcomesById = new Map(recoveryTaskEffectOutcomes);
  const effectReconciliationsByOutcome = new Map(recoveryTaskEffectReconciliations);
  const claimByHandoff = new Map([...claimsById.values()].map((claim) => [claim.handoffId, claim.claimId]));
  const releaseByClaimTask = new Map([...releasesById.values()].map((release) => [
    `${release.claimId}\u0000${release.taskId}`,
    release.releaseId
  ]));
  const consumptionByRelease = new Map([...consumptionsById.values()].map((consumption) => [
    consumption.releaseId,
    consumption.consumptionId
  ]));
  const effectIntentByConsumption = new Map([...effectIntentsById.values()].map((intent) => [
    intent.consumptionId,
    intent.intentId
  ]));
  const effectLaunchByIntent = new Map([...effectLaunchesById.values()].map((launch) => [
    launch.intentId,
    launch.launchId
  ]));
  const effectOutcomeByLaunch = new Map([...effectOutcomesById.values()].map((outcome) => [
    outcome.launchId,
    outcome.outcomeId
  ]));
  for (const record of records) {
    if (!isPlainObject(record) || !isPlainObject(record.payload)) continue;
    if (record.op === "recovery.batch-committed") {
      const handoff = validateExecutionRecoveryHandoffV1(record.payload.handoff, { runId });
      if (handoffsById.has(handoff.handoffId)) {
        throw new Error(`Execution recovery handoff is duplicated: ${handoff.handoffId}`);
      }
      handoffsById.set(handoff.handoffId, handoff);
      continue;
    }
    if (record.op === "recovery.handoff-claimed") {
      const claim = validateExecutionRecoveryHandoffClaimV1(record.payload.claim, { runId });
      const handoff = handoffsById.get(claim.handoffId);
      if (!handoff) throw new Error(`Execution recovery claim references a missing prior handoff: ${claim.handoffId}`);
      if (claimByHandoff.has(claim.handoffId) || claimsById.has(claim.claimId)) {
        throw new Error(`Execution recovery handoff claim is duplicated: ${claim.handoffId}`);
      }
      if (claim.handoffDigest !== handoff.handoffDigest ||
          claim.recoveryPlanDigest !== handoff.recoveryPlanDigest ||
          !same(claim.taskIds, handoff.taskIds) ||
          claim.entries.length !== handoff.entries.length ||
          claim.entries.some((entry, index) => {
            const marker = handoff.entries[index];
            return entry.taskId !== marker.taskId || entry.handleId !== marker.handleId ||
              entry.handleDigest !== marker.handleDigest || entry.attemptId !== marker.attemptId ||
              entry.admissionDigest !== marker.admissionDigest;
          })) {
        throw new Error(`Execution recovery claim is not exactly bound to handoff ${claim.handoffId}`);
      }
      claimsById.set(claim.claimId, claim);
      claimByHandoff.set(claim.handoffId, claim.claimId);
      continue;
    }
    if (record.op === "recovery.task-release-authorized") {
      const release = validateExecutionRecoveryTaskReleaseV1(record.payload.release, { runId });
      const claim = claimsById.get(release.claimId);
      const handoff = handoffsById.get(release.handoffId);
      if (!claim || !handoff) {
        throw new Error(`Execution recovery task release references a missing prior claim or handoff: ${release.releaseId}`);
      }
      const claimEntry = claim.entries.find((entry) => entry.taskId === release.taskId);
      const claimTaskKey = `${release.claimId}\u0000${release.taskId}`;
      if (releasesById.has(release.releaseId) || releaseByClaimTask.has(claimTaskKey)) {
        throw new Error(`Execution recovery task release is duplicated: ${release.releaseId}`);
      }
      if (!claimEntry || release.handoffId !== claim.handoffId || release.handoffDigest !== claim.handoffDigest ||
          release.claimDigest !== claim.claimDigest || release.planId !== claim.planId ||
          release.planDigest !== claim.planDigest || release.contractDigest !== claim.contractDigest ||
          release.recoveryPlanDigest !== claim.recoveryPlanDigest ||
          release.preparedEventSequence !== claim.preparedEventSequence ||
          release.preparedEventDigest !== claim.preparedEventDigest ||
          release.handleId !== claimEntry.handleId || release.handleDigest !== claimEntry.handleDigest ||
          release.attemptId !== claimEntry.attemptId || release.admissionDigest !== claimEntry.admissionDigest ||
          handoff.handoffDigest !== release.handoffDigest) {
        throw new Error(`Execution recovery task release is not exactly bound to claim ${release.claimId}`);
      }
      releasesById.set(release.releaseId, release);
      releaseByClaimTask.set(claimTaskKey, release.releaseId);
      continue;
    }
    if (record.op === "recovery.task-permit-consumed") {
      const consumption = validateExecutionRecoveryTaskPermitConsumptionV1(record.payload.consumption, { runId });
      const handoff = handoffsById.get(consumption.handoffId);
      const claim = claimsById.get(consumption.claimId);
      const release = releasesById.get(consumption.releaseId);
      if (!handoff || !claim || !release) {
        throw new Error(
          `Execution recovery task permit consumption references a missing prior handoff, claim, or release: ${consumption.consumptionId}`
        );
      }
      if (consumptionsById.has(consumption.consumptionId) || consumptionByRelease.has(consumption.releaseId)) {
        throw new Error(`Execution recovery task permit consumption is duplicated: ${consumption.consumptionId}`);
      }
      const copiedReleaseFields = [
        "runId", "handoffId", "handoffDigest", "claimId", "claimDigest", "releaseId", "releaseDigest",
        "taskId", "handleId", "handleDigest", "attemptId", "admissionDigest", "planId", "planDigest",
        "contractDigest", "recoveryPlanDigest", "preparedEventSequence", "preparedEventDigest",
        "checkpointSequence", "checkpointStateDigest", "taskStateDigest", "dependencyStateDigest"
      ];
      if (copiedReleaseFields.some((key) => consumption[key] !== release[key]) ||
          !same(consumption.dependencies, release.dependencies) || claim.claimDigest !== consumption.claimDigest ||
          handoff.handoffDigest !== consumption.handoffDigest) {
        throw new Error(`Execution recovery task permit consumption is not exactly bound to release ${consumption.releaseId}`);
      }
      consumptionsById.set(consumption.consumptionId, consumption);
      consumptionByRelease.set(consumption.releaseId, consumption.consumptionId);
      continue;
    }
    if ([
      "recovery.task-effect-intent-created",
      "recovery.task-effect-dispatch-reserved",
      "recovery.task-effect-not-sent",
      "recovery.task-effect-unknown"
    ].includes(record.op)) {
      const intent = validateExecutionRecoveryTaskEffectIntentV1(record.payload.intent, { runId });
      const consumption = consumptionsById.get(intent.consumptionId);
      if (!consumption) {
        throw new Error(`Execution recovery task effect intent references a missing prior consumption: ${intent.intentId}`);
      }
      if (RECOVERY_TASK_EFFECT_INTENT_BINDING_FIELDS.some((key) => intent[key] !== consumption[key]) ||
          !same(intent.dependencies, consumption.dependencies)) {
        throw new Error(`Execution recovery task effect intent is not exactly bound to consumption ${intent.consumptionId}`);
      }
      const expectedStatus = {
        "recovery.task-effect-intent-created": "created",
        "recovery.task-effect-dispatch-reserved": "dispatch-reserved",
        "recovery.task-effect-not-sent": "not-sent",
        "recovery.task-effect-unknown": "unknown"
      }[record.op];
      if (intent.status !== expectedStatus) {
        throw new Error(`Execution recovery task effect intent operation/status mismatch: ${intent.intentId}`);
      }
      const previous = effectIntentsById.get(intent.intentId) ?? null;
      if (intent.status === "created") {
        if (previous || effectIntentByConsumption.has(intent.consumptionId)) {
          throw new Error(`Execution recovery task effect intent is duplicated: ${intent.intentId}`);
        }
      } else {
        if (!previous) {
          throw new Error(`Execution recovery task effect intent transition lacks its predecessor: ${intent.intentId}`);
        }
        if (effectLaunchByIntent.has(intent.intentId)) {
          throw new Error(`Execution recovery task effect intent transitioned after its durable launch: ${intent.intentId}`);
        }
        const validTransition = previous.status === "created"
          ? intent.status === "dispatch-reserved"
          : previous.status === "dispatch-reserved" && ["not-sent", "unknown"].includes(intent.status);
        if (!validTransition || intent.transitionIndex !== previous.transitionIndex + 1 ||
            intent.priorIntentDigest !== previous.intentDigest || intent.createdAt !== previous.createdAt ||
            RECOVERY_TASK_EFFECT_INTENT_BINDING_FIELDS.some((key) => intent[key] !== previous[key]) ||
            !same(intent.dependencies, previous.dependencies) ||
            (previous.status === "dispatch-reserved" &&
              (intent.reservationId !== previous.reservationId || intent.reservedAt !== previous.reservedAt))) {
          throw new Error(`Execution recovery task effect intent transition is not exact: ${intent.intentId}`);
        }
      }
      effectIntentsById.set(intent.intentId, intent);
      effectIntentByConsumption.set(intent.consumptionId, intent.intentId);
      continue;
    }
    if (record.op === "recovery.task-effect-launch-recorded") {
      const launch = validateExecutionRecoveryTaskEffectLaunchV1(record.payload.launch, { runId });
      const intent = effectIntentsById.get(launch.intentId);
      if (!intent || intent.status !== "dispatch-reserved") {
        throw new Error(`Execution recovery task effect launch references a missing or non-reserved intent: ${launch.launchId}`);
      }
      if (effectLaunchesById.has(launch.launchId) || effectLaunchByIntent.has(launch.intentId)) {
        throw new Error(`Execution recovery task effect launch is duplicated: ${launch.launchId}`);
      }
      if (RECOVERY_TASK_EFFECT_LAUNCH_INTENT_BINDING_FIELDS.some((key) => launch[key] !== intent[key]) ||
          !same(launch.dependencies, intent.dependencies)) {
        throw new Error(`Execution recovery task effect launch is not exactly bound to intent ${launch.intentId}`);
      }
      effectLaunchesById.set(launch.launchId, launch);
      effectLaunchByIntent.set(launch.intentId, launch.launchId);
      continue;
    }
    if (record.op === "recovery.task-effect-outcome-recorded") {
      const outcome = validateExecutionRecoveryTaskEffectOutcomeV1(record.payload.outcome, { runId });
      const launch = effectLaunchesById.get(outcome.launchId);
      if (!launch) {
        throw new Error(`Execution recovery task effect outcome references a missing launch: ${outcome.outcomeId}`);
      }
      if (effectOutcomesById.has(outcome.outcomeId) || effectOutcomeByLaunch.has(outcome.launchId)) {
        throw new Error(`Execution recovery task effect outcome is duplicated: ${outcome.outcomeId}`);
      }
      if (RECOVERY_TASK_EFFECT_OUTCOME_LAUNCH_BINDING_FIELDS.some((key) => outcome[key] !== launch[key]) ||
          !same(outcome.dependencies, launch.dependencies)) {
        throw new Error(`Execution recovery task effect outcome is not exactly bound to launch ${outcome.launchId}`);
      }
      effectOutcomesById.set(outcome.outcomeId, outcome);
      effectOutcomeByLaunch.set(outcome.launchId, outcome.outcomeId);
    }
    if (record.op === "recovery.task-effect-outcome-reconciled") {
      const reconciliation = validateExecutionRecoveryTaskEffectReconciliationV1(record.payload.reconciliation, { runId });
      const original = effectOutcomesById.get(reconciliation.outcomeId);
      if (!original || !same(original, reconciliation.originalOutcome) || effectReconciliationsByOutcome.has(original.outcomeId)) {
        throw new Error("Recovery reconciliation has a missing, conflicting or duplicated original outcome");
      }
      effectReconciliationsByOutcome.set(original.outcomeId, reconciliation);
    }
  }
  return {
    recoveryClaims: claimsById,
    recoveryTaskReleases: releasesById,
    recoveryTaskPermitConsumptions: consumptionsById,
    recoveryTaskEffectIntents: effectIntentsById,
    recoveryTaskEffectLaunches: effectLaunchesById,
    recoveryTaskEffectOutcomes: effectOutcomesById,
    recoveryTaskEffectReconciliations: effectReconciliationsByOutcome
  };
}

function assertRecoveryHandoffJournalPrefix(record, journalBytes, lineStart) {
  if (!isPlainObject(record) || record.op !== "recovery.batch-committed" || !isPlainObject(record.payload)) return;
  const handoff = validateExecutionRecoveryHandoffV1(record.payload.handoff, { runId: record.runId });
  const prefix = journalBytes.subarray(0, lineStart);
  const digest = createHash("sha256").update(prefix).digest("hex");
  if (handoff.sourceJournalByteLength !== lineStart || handoff.sourceJournalDigest !== digest) {
    throw new Error("Execution recovery handoff source journal provenance is invalid");
  }
}

function replayCacheKey(root, runId) {
  return `${path.resolve(root)}\u0000${runId}`;
}

function dropValidatedReplayCache(key) {
  const prior = validatedReplayCache.get(key);
  if (!prior) return;
  validatedReplayCache.delete(key);
  validatedReplayCacheBytes -= prior.memoryBytes;
}

function getValidatedReplayCache(key) {
  const entry = validatedReplayCache.get(key);
  if (!entry) return null;
  validatedReplayCache.delete(key);
  validatedReplayCache.set(key, entry);
  return entry;
}

function cachePrefixMatches(entry, bytes) {
  if (bytes.length < entry.byteLength) return false;
  const prefix = bytes.subarray(0, entry.byteLength);
  const digest = createHash("sha256").update(prefix).digest("hex");
  return digest === entry.prefixDigest && prefix.equals(entry.prefixBytes);
}

function putValidatedReplayCache(
  key,
  bytes,
  state,
  admissions = new Map(),
  recoveryHandoffs = new Map(),
  recoveryClaims = new Map(),
  recoveryTaskReleases = new Map(),
  recoveryTaskPermitConsumptions = new Map(),
  recoveryTaskEffectIntents = new Map(),
  recoveryTaskEffectLaunches = new Map(),
  recoveryTaskEffectOutcomes = new Map(),
  recoveryTaskEffectReconciliations = new Map()
) {
  const prefixBytes = Buffer.from(bytes);
  const cachedState = clone(state);
  const cachedAdmissions = Object.fromEntries(admissions);
  const cachedRecoveryHandoffs = Object.fromEntries(recoveryHandoffs);
  const cachedRecoveryClaims = Object.fromEntries(recoveryClaims);
  const cachedRecoveryTaskReleases = Object.fromEntries(recoveryTaskReleases);
  const cachedRecoveryTaskPermitConsumptions = Object.fromEntries(recoveryTaskPermitConsumptions);
  const cachedRecoveryTaskEffectIntents = Object.fromEntries(recoveryTaskEffectIntents);
  const cachedRecoveryTaskEffectLaunches = Object.fromEntries(recoveryTaskEffectLaunches);
  const cachedRecoveryTaskEffectOutcomes = Object.fromEntries(recoveryTaskEffectOutcomes);
  const cachedRecoveryTaskEffectReconciliations = Object.fromEntries(recoveryTaskEffectReconciliations);
  const memoryBytes = prefixBytes.byteLength +
    Buffer.byteLength(JSON.stringify(cachedState), "utf8") +
    Buffer.byteLength(JSON.stringify(cachedAdmissions), "utf8") +
    Buffer.byteLength(JSON.stringify(cachedRecoveryHandoffs), "utf8") +
    Buffer.byteLength(JSON.stringify(cachedRecoveryClaims), "utf8") +
    Buffer.byteLength(JSON.stringify(cachedRecoveryTaskReleases), "utf8") +
    Buffer.byteLength(JSON.stringify(cachedRecoveryTaskPermitConsumptions), "utf8") +
    Buffer.byteLength(JSON.stringify(cachedRecoveryTaskEffectIntents), "utf8") +
    Buffer.byteLength(JSON.stringify(cachedRecoveryTaskEffectLaunches), "utf8") +
    Buffer.byteLength(JSON.stringify(cachedRecoveryTaskEffectOutcomes), "utf8") +
    Buffer.byteLength(JSON.stringify(cachedRecoveryTaskEffectReconciliations), "utf8");
  dropValidatedReplayCache(key);
  if (memoryBytes > REPLAY_CACHE_MAX_BYTES) return;
  const entry = {
    byteLength: prefixBytes.byteLength,
    prefixBytes,
    prefixDigest: createHash("sha256").update(prefixBytes).digest("hex"),
    state: cachedState,
    admissions: cachedAdmissions,
    recoveryHandoffs: cachedRecoveryHandoffs,
    recoveryClaims: cachedRecoveryClaims,
    recoveryTaskReleases: cachedRecoveryTaskReleases,
    recoveryTaskPermitConsumptions: cachedRecoveryTaskPermitConsumptions,
    recoveryTaskEffectIntents: cachedRecoveryTaskEffectIntents,
    recoveryTaskEffectLaunches: cachedRecoveryTaskEffectLaunches,
    recoveryTaskEffectOutcomes: cachedRecoveryTaskEffectOutcomes,
    recoveryTaskEffectReconciliations: cachedRecoveryTaskEffectReconciliations,
    memoryBytes
  };
  validatedReplayCache.set(key, entry);
  validatedReplayCacheBytes += memoryBytes;
  while (validatedReplayCache.size > REPLAY_CACHE_MAX_ENTRIES || validatedReplayCacheBytes > REPLAY_CACHE_MAX_BYTES) {
    const oldestKey = validatedReplayCache.keys().next().value;
    if (oldestKey === undefined) break;
    dropValidatedReplayCache(oldestKey);
  }
}

function eventFor(next, previous, op, payload) {
  return {
    schemaVersion: JOURNAL_EVENT_SCHEMA_VERSION,
    kind: JOURNAL_EVENT_KIND,
    runId: next.runId,
    sequence: next.sequence,
    previousSequence: previous.sequence,
    previousStateDigest: previous.stateDigest,
    stateDigest: next.stateDigest,
    op,
    payload: clone(payload),
    delta: createRegistryDelta(previous, next)
  };
}

const REGISTRY_MAP_KEYS = ["handles", "intents", "stopRequests", "stopReceipts", "recoveryPlans"];

const JOURNAL_EVENT_RECORD_KEYS = Object.freeze([
  "at", "event", "schemaVersion", "kind", "runId", "sequence", "previousSequence",
  "previousStateDigest", "stateDigest", "op", "payload", "delta"
]);

const LEGACY_JOURNAL_EVENT_RECORD_KEYS = Object.freeze([
  "at", "event", "schemaVersion", "kind", "sequence", "previousSequence",
  "previousStateDigest", "stateDigest", "op", "payload", "state"
]);

const JOURNAL_DELTA_KEYS = Object.freeze(["added", "updated", "removed"]);

function emptyMapDelta() {
  return { added: {}, updated: {}, removed: [] };
}

function createMapDelta(previous, next) {
  const delta = emptyMapDelta();
  const ids = [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort();
  for (const id of ids) {
    const before = previous[id];
    const after = next[id];
    if (before === undefined && after !== undefined) delta.added[id] = clone(after);
    else if (before !== undefined && after === undefined) delta.removed.push(id);
    else if (before !== undefined && !semanticSame(before, after)) delta.updated[id] = clone(after);
  }
  return delta;
}

function createRegistryDelta(previous, next) {
  const delta = {};
  for (const mapKey of REGISTRY_MAP_KEYS) delta[mapKey] = createMapDelta(previous[mapKey], next[mapKey]);
  return delta;
}

function validateMapDelta(value, mapKey) {
  assertSafeObject(value, `Execution registry delta.${mapKey}`);
  exactKeys(value, JOURNAL_DELTA_KEYS, `Execution registry delta.${mapKey}`);
  for (const field of ["added", "updated"]) {
    assertSafeObject(value[field], `Execution registry delta.${mapKey}.${field}`);
    for (const [id, item] of Object.entries(value[field])) {
      assertId(id, `Execution registry delta.${mapKey}.${field} id`);
      assertSafeObject(item, `Execution registry delta.${mapKey}.${field}.${id}`);
    }
  }
  if (!Array.isArray(value.removed) || value.removed.some((id) => typeof id !== "string")) {
    throw new Error(`Execution registry delta.${mapKey}.removed is invalid`);
  }
  const removed = new Set();
  for (const id of value.removed) {
    assertId(id, `Execution registry delta.${mapKey}.removed id`);
    if (removed.has(id)) throw new Error(`Execution registry delta.${mapKey}.removed contains a duplicate id`);
    removed.add(id);
  }
  for (const id of removed) {
    if (Object.prototype.hasOwnProperty.call(value.added, id) || Object.prototype.hasOwnProperty.call(value.updated, id)) {
      throw new Error(`Execution registry delta.${mapKey} overlaps added/updated with removed id ${id}`);
    }
  }
  return value;
}

function validateRegistryDelta(value) {
  assertSafeObject(value, "Execution registry delta");
  exactKeys(value, REGISTRY_MAP_KEYS, "Execution registry delta");
  for (const mapKey of REGISTRY_MAP_KEYS) validateMapDelta(value[mapKey], mapKey);
  return value;
}

function applyMapDelta(previous, value, mapKey) {
  validateMapDelta(value, mapKey);
  if (value.removed.length > 0) {
    throw new Error(`Execution registry delta.${mapKey} cannot delete append-only history`);
  }
  const next = { ...previous };
  for (const id of Object.keys(value.added)) {
    if (Object.prototype.hasOwnProperty.call(previous, id)) {
      throw new Error(`Execution registry delta.${mapKey}.added already exists: ${id}`);
    }
    next[id] = clone(value.added[id]);
  }
  for (const id of Object.keys(value.updated)) {
    if (!Object.prototype.hasOwnProperty.call(previous, id)) {
      throw new Error(`Execution registry delta.${mapKey}.updated is missing its prior record: ${id}`);
    }
    if (semanticSame(previous[id], value.updated[id])) {
      throw new Error(`Execution registry delta.${mapKey}.updated is a no-op: ${id}`);
    }
    next[id] = clone(value.updated[id]);
  }
  return next;
}

function applyRegistryDelta(previous, delta) {
  validateRegistryDelta(delta);
  const next = clone(previous);
  for (const mapKey of REGISTRY_MAP_KEYS) next[mapKey] = applyMapDelta(previous[mapKey], delta[mapKey], mapKey);
  return next;
}

function semanticSame(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return digestObject(a) === digestObject(b);
}

function transitionError(message) {
  throw new Error(`Execution registry journal transition is invalid: ${message}`);
}

function eventPayload(event, expectedKeys) {
  if (!isPlainObject(event.payload)) transitionError(`${event.op} payload must be a plain object`);
  try {
    exactKeys(event.payload, expectedKeys, `${event.op} payload`);
  } catch (error) {
    transitionError(error.message);
  }
  return event.payload;
}

function assertMapsStableExcept(previous, next, changes = {}) {
  for (const mapKey of REGISTRY_MAP_KEYS) {
    const allowed = new Set(changes[mapKey] ?? []);
    const ids = new Set([...Object.keys(previous[mapKey]), ...Object.keys(next[mapKey])]);
    for (const id of ids) {
      if (allowed.has(id)) continue;
      if (!semanticSame(previous[mapKey][id], next[mapKey][id])) {
        transitionError(`${mapKey}.${id} changed outside the ${mapKey} transition`);
      }
    }
  }
}

function assertRecoveryTaskEffectIntentBinding(previous, next, intent, label) {
  assertMapsStableExcept(previous, next);
  const previousHandle = handleFor(previous, intent.handleId, `${label} handle`);
  const nextHandle = handleFor(next, intent.handleId, `${label} handle`);
  if (digestObject(previousHandle) !== intent.handleDigest ||
      !semanticSame(previousHandle, nextHandle) ||
      previousHandle.attemptId !== intent.attemptId ||
      previousHandle.admissionDigest !== intent.admissionDigest ||
      previousHandle.status !== "ready" || previousHandle.dispatchBlocked !== true ||
      previousHandle.revokedAt !== null || nextHandle.dispatchBlocked !== true ||
      Object.values(previous.intents).some((entry) => entry.handleId === intent.handleId) ||
      Object.values(next.intents).some((entry) => entry.handleId === intent.handleId)) {
    transitionError(`${label} is not bound to one untouched blocked recovery handle`);
  }
}

function assertAddedMapEntry(previous, next, mapKey, id) {
  if (Object.prototype.hasOwnProperty.call(previous[mapKey], id)) {
    transitionError(`${mapKey}.${id} already exists`);
  }
  if (!Object.prototype.hasOwnProperty.call(next[mapKey], id)) {
    transitionError(`${mapKey}.${id} was not added`);
  }
}

function handleFor(state, handleId, label = "handle") {
  const handle = state.handles[handleId];
  if (!handle) transitionError(`${label} ${handleId} is missing`);
  return handle;
}

function intentForState(state, intentId, label = "intent") {
  const intent = state.intents[intentId];
  if (!intent) transitionError(`${label} ${intentId} is missing`);
  return intent;
}

function assertObjectStableExcept(previous, next, mutableKeys, label) {
  for (const key of Object.keys(previous)) {
    if (mutableKeys.has(key)) continue;
    if (!semanticSame(previous[key], next[key])) transitionError(`${label}.${key} changed unexpectedly`);
  }
}

function assertHandleBinding(handle, binding, label) {
  const expected = bindingFromInput(binding, { label });
  const actual = bindingForHandle(handle);
  if (!semanticSame(actual, expected)) transitionError(`${label} does not match its handle`);
  if (handle.executionScopeDigest !== computeExecutionScopeDigest(expected)) {
    transitionError(`${label} execution scope digest is not bound`);
  }
  if (handle.obligationKey !== computeObligationKey(expected)) {
    transitionError(`${label} obligation key is not bound`);
  }
}

function assertHandleOrigin(handle, binding, label, { resumedFromHandleId = null, priorAttemptId = null } = {}) {
  const originKeys = [
    "handleId", "runId", "executionId", "attemptId", "unitId", "sourceBindingDigest", "policyDigest",
    "revision", "authorityEpoch", "fence", "createdAt",
    ...(resumedFromHandleId === null ? [] : ["resumedFromHandleId", "priorAttemptId"])
  ];
  try {
    exactKeys(handle.origin, originKeys, `${label}.origin`);
  } catch (error) {
    transitionError(error.message);
  }
  const expected = bindingFromInput(binding, { label });
  for (const key of ["handleId", "runId", "executionId", "attemptId", "unitId", "sourceBindingDigest", "policyDigest", "revision"]) {
    if (handle.origin[key] !== (key === "handleId" ? handle.handleId : expected[key])) {
      transitionError(`${label}.origin.${key} is not bound`);
    }
  }
  if (handle.origin.authorityEpoch !== handle.authorityEpoch || handle.origin.fence !== handle.fence) {
    transitionError(`${label}.origin authority is not bound`);
  }
  assertIso(handle.origin.createdAt, `${label}.origin.createdAt`);
  if (resumedFromHandleId !== null && (handle.origin.resumedFromHandleId !== resumedFromHandleId || handle.origin.priorAttemptId !== priorAttemptId)) {
    transitionError(`${label}.origin recovery source is not bound`);
  }
}

function assertIntentBinding(intent, handle, label) {
  if (intent.handleId !== handle.handleId) transitionError(`${label} handle identity does not match`);
  const intentBinding = bindingFromInput(intent, { label });
  const handleBinding = bindingForHandle(handle);
  for (const key of [
    "runId", "executionId", "attemptId", "unitId", "sourceBindingDigest", "policyDigest", "revision"
  ]) {
    if (intentBinding[key] !== handleBinding[key]) transitionError(`${label}.${key} does not match its handle`);
  }
  if (intent.authorityEpoch !== handle.authorityEpoch || intent.fence !== handle.fence ||
      intent.executionScopeDigest !== handle.executionScopeDigest) {
    transitionError(`${label} authority or scope is not bound to its handle`);
  }
  if (intent.admissionSeal !== undefined) {
    if (handle.admissionDigest === undefined) transitionError(`${label} admission seal is not bound to a V3 handle`);
    try {
      validateTrustedAdmissionSeal(intent.admissionSeal, {
        runId: handle.runId,
        handleId: handle.handleId,
        intentId: intent.intentId,
        admissionDigest: handle.admissionDigest,
        authorityEpoch: handle.authorityEpoch,
        fence: handle.fence,
        outcome: intent.outcome,
        effectDigest: intent.effectDigest
      });
    } catch (error) {
      transitionError(`${label} admission seal is not bound: ${error.message}`);
    }
  }
  if (intent.usageObservation !== undefined && intent.usageObservation !== null) {
    try {
      validateExecutionUsageObservation(intent.usageObservation, {
        ...handleBinding,
        handleId: handle.handleId,
        intentId: intent.intentId,
        ownedResourceId: handle.ownedResourceId,
        authorityEpoch: handle.authorityEpoch,
        fence: handle.fence
      }, `${label}.usageObservation`);
    } catch (error) {
      transitionError(`${label} usage observation is not bound: ${error.message}`);
    }
  }
}

const EXECUTION_OWNED_CLEANUP_RESOLUTION_KIND = "ExecutionOwnedCleanupResolutionV1";

function validateExecutionOwnedCleanupResolution(value, label = EXECUTION_OWNED_CLEANUP_RESOLUTION_KIND) {
  assertSafeObject(value, label);
  exactKeys(value, [
    "schemaVersion", "kind", "status", "resolutionId", "transactionId", "transactionDigest",
    "runId", "handleId", "intentId", "executionId", "attemptId", "unitId", "ownedResourceId",
    "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence", "effectBindingDigest",
    "allocationId", "allocationRecordDigest", "cleanupDigest", "effectStarted", "launchRequested",
    "groupTerminated", "lateLaunchBlocked", "noSendProof", "controllerResolutionDigest", "observedAt", "digest"
  ], label);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_OWNED_CLEANUP_RESOLUTION_KIND ||
      value.status !== "cleanup-confirmed") throw new Error(`${label} version/kind/status is invalid`);
  for (const key of [
    "resolutionId", "transactionId", "runId", "handleId", "intentId", "executionId", "attemptId",
    "unitId", "ownedResourceId", "allocationId"
  ]) assertId(value[key], `${label}.${key}`);
  for (const key of [
    "transactionDigest", "sourceBindingDigest", "policyDigest", "fence", "effectBindingDigest",
    "allocationRecordDigest", "cleanupDigest", "controllerResolutionDigest", "digest"
  ]) assertDigest(value[key], `${label}.${key}`);
  assertText(value.revision, `${label}.revision`, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
  assertEpoch(value.authorityEpoch, `${label}.authorityEpoch`);
  for (const key of ["effectStarted", "launchRequested", "groupTerminated", "lateLaunchBlocked"]) {
    if (value[key] !== true) throw new Error(`${label}.${key} must be true`);
  }
  if (value.noSendProof !== null) throw new Error(`${label}.noSendProof must remain null after an effect boundary`);
  assertIso(value.observedAt, `${label}.observedAt`);
  const { digest: suppliedDigest, ...body } = value;
  if (digestObject(body) !== suppliedDigest) throw new Error(`${label}.digest is not bound`);
  return { ...value };
}

function assertIntentTransition(previousIntent, nextIntent, mutableKeys, label) {
  assertObjectStableExcept(previousIntent, nextIntent, new Set(mutableKeys), label);
}

function assertHandleTransition(previousHandle, nextHandle, mutableKeys, label) {
  assertObjectStableExcept(previousHandle, nextHandle, new Set(mutableKeys), label);
}

function assertStopRequestBinding(request, handle, label) {
  const requestBinding = bindingFromInput(request, { label });
  const handleBinding = bindingForHandle(handle);
  if (!semanticSame(requestBinding, handleBinding)) transitionError(`${label} scope does not match its handle`);
  if (request.authorityEpoch !== handle.authorityEpoch || request.fence !== handle.fence) {
    transitionError(`${label} authority is not bound to its handle`);
  }
  if (request.securityRcaRequired !== (request.reason === "security-p0")) {
    transitionError(`${label} security RCA binding is invalid`);
  }
}

// A physical stop/cleanup never resolves an already-entered effect.  The
// exact same rule is used for live recovery and journal replay so changing
// handle status or presenting an older recovery record cannot bypass UNKNOWN.
function hasRetryableReconciliation(handle, intent) {
  const last = intent?.reconciliation?.at(-1);
  const observed = last?.observation;
  return intent?.status === "unknown" && last?.decision === "retryable" &&
    last.runId === handle.runId && last.handleId === handle.handleId &&
    last.intentId === intent.intentId && observed?.controllerStatus === "terminated" &&
    observed.providerOutcome === "not-sent" && observed.businessOutcome === null;
}

function recoveryNeedsReconciliation(handle, intent) {
  if (intent?.status === "unknown") return !hasRetryableReconciliation(handle, intent);
  // A callback still in flight has not produced any outcome proof.  An
  // indeterminate physical stop also needs reconciliation, even before send.
  return handle.status === "indeterminate" || ["pending", "dispatching"].includes(intent?.status);
}

function validateRecoveryBatchJournalEntry(value, index) {
  const label = `recovery.batch-committed entries[${index}]`;
  assertSafeObject(value, label);
  exactKeys(value, [
    "taskId", "controllerId", "handleId", "priorHandleId", "recoveryPlanId", "binding", "admission"
  ], label);
  const taskId = assertId(value.taskId, `${label}.taskId`);
  const controllerId = assertId(value.controllerId, `${label}.controllerId`);
  const handleId = assertId(value.handleId, `${label}.handleId`);
  const priorHandleId = value.priorHandleId === null ? null : assertId(value.priorHandleId, `${label}.priorHandleId`);
  const recoveryPlanId = value.recoveryPlanId === null ? null : assertId(value.recoveryPlanId, `${label}.recoveryPlanId`);
  if ((priorHandleId === null) !== (recoveryPlanId === null)) throw new Error(`${label} recovery identities are incomplete`);
  const binding = bindingFromInput(value.binding, { label: `${label}.binding` });
  const admission = validateExecutionAdmission(value.admission);
  for (const key of [
    "runId", "executionId", "attemptId", "unitId", "ownedResourceId",
    "sourceBindingDigest", "policyDigest", "revision"
  ]) {
    if (admission[key] !== binding[key]) throw new Error(`${label}.admission.${key} is not bound`);
  }
  if (admission.taskId !== taskId) throw new Error(`${label}.admission.taskId is not bound`);
  return { taskId, controllerId, handleId, priorHandleId, recoveryPlanId, binding, admission };
}

function assertRecoverableSourceHandle(state, oldHandle, label) {
  const oldIntent = Object.values(state.intents).find((intent) =>
    intent.handleId === oldHandle.handleId && intent.status === "not-sent"
  );
  const currentIntent = findIntentForHandle(state, oldHandle.handleId);
  const notSentResume = oldHandle.status === "ready" && oldIntent?.callbackCalls === 0 && oldIntent.dispatchReserved === false;
  if (recoveryNeedsReconciliation(oldHandle, currentIntent)) {
    transitionError(`${label} requires reconciliation before recovery`);
  }
  if (!["revoked", "stopped", "failed", "indeterminate"].includes(oldHandle.status) && !notSentResume) {
    transitionError(`${label} is not recoverable`);
  }
}

function assertEventTransition(previous, next, op, payload, schemaVersion = JOURNAL_EVENT_SCHEMA_VERSION) {
  const event = { op, payload, state: next, schemaVersion };
  switch (op) {
    case "handle.created": {
      const hasAdmission = Object.hasOwn(event.payload ?? {}, "admission");
      const value = eventPayload(event, hasAdmission
        ? ["admission", "binding", "executionScopeDigest", "handleId", "observedAuthority"]
        : ["binding", "executionScopeDigest", "handleId", "observedAuthority"]);
      const binding = bindingFromInput(value.binding, { label: "handle.created binding" });
      let observedAuthority;
      try {
        observedAuthority = validateObservedAuthority(value.observedAuthority, "handle.created observedAuthority");
      } catch (error) {
        transitionError(error.message);
      }
      const handle = handleFor(next, value.handleId, "created handle");
      assertAddedMapEntry(previous, next, "handles", value.handleId);
      assertMapsStableExcept(previous, next, { handles: [value.handleId] });
      if (value.executionScopeDigest !== handle.executionScopeDigest) transitionError("handle.created scope digest is not bound");
      assertHandleBinding(handle, binding, "handle.created binding");
      if (observedAuthority.authorityEpoch !== handle.authorityEpoch || observedAuthority.fence !== handle.fence) {
        transitionError("handle.created observed authority is not bound to the handle");
      }
      if (Object.values(previous.handles).some((item) => item.obligationKey === handle.obligationKey)) {
        transitionError("handle.created obligation is already reserved; recovery must use recovery.prepared");
      }
      if (handle.status !== "ready" || handle.dispatchBlocked !== false || handle.revokedAt !== null) {
        transitionError("handle.created must start ready and dispatchable");
      }
      assertHandleOrigin(handle, binding, "handle.created handle");
      if (hasAdmission) {
        try {
          const admission = admissionForBinding(value.admission, handle, "handle.created admission");
          if (handle.admissionDigest === undefined || digestExecutionAdmission(admission) !== handle.admissionDigest) {
            transitionError("handle.created admission digest is not bound to the immutable handle");
          }
        } catch (error) {
          transitionError(error.message);
        }
      } else if (handle.admissionDigest !== undefined) {
        transitionError("V3 handle.created admission reservation is missing");
      }
      break;
    }
    case "intent.created": {
      const value = eventPayload(event, ["handleId", "intentId"]);
      const handle = handleFor(previous, value.handleId, "intent.created handle");
      const intent = intentForState(next, value.intentId, "created intent");
      assertAddedMapEntry(previous, next, "intents", value.intentId);
      assertMapsStableExcept(previous, next, { intents: [value.intentId] });
      if (handle.status !== "ready" || handle.dispatchBlocked) transitionError("intent.created requires a ready handle");
      if (Object.values(previous.intents).some((item) => item.handleId === value.handleId)) {
        transitionError("intent.created cannot reserve a handle with an existing intent");
      }
      assertIntentBinding(intent, handle, "intent.created intent");
      if (intent.status !== "pending" || intent.callbackCalls !== 0 || intent.dispatchStartedAt !== null ||
          intent.sealedAt !== null || intent.outcome !== null || intent.effectDigest !== null ||
          intent.unknownReason !== null || intent.lateCallback !== false || intent.dispatchReserved !== false ||
          intent.notSentAt !== null || intent.notSentReason !== null ||
          intent.controllerIncarnation !== null || intent.ownerLeaseId !== null ||
          (intent.usageObservation !== undefined && intent.usageObservation !== null)) {
        transitionError("intent.created has an invalid initial intent state");
      }
      break;
    }
    case "intent.dispatched": {
      const value = eventPayload(event, ["authorityEpoch", "fence", "handleId", "intentId"]);
      const previousIntent = intentForState(previous, value.intentId, "dispatched intent");
      const nextIntent = intentForState(next, value.intentId, "dispatched intent");
      const previousHandle = handleFor(previous, value.handleId, "dispatched handle");
      const nextHandle = handleFor(next, value.handleId, "dispatched handle");
      assertMapsStableExcept(previous, next, { handles: [value.handleId], intents: [value.intentId] });
      if (previousIntent.handleId !== value.handleId || nextIntent.handleId !== value.handleId) {
        transitionError("intent.dispatched identity does not match its payload");
      }
      if (!(previousIntent.status === "pending" || previousIntent.status === "not-sent") || previousIntent.callbackCalls !== 0 ||
          previousIntent.dispatchReserved !== false ||
          previousHandle.status !== "ready" || previousHandle.dispatchBlocked) {
        transitionError("intent.dispatched requires a retryable intent on a ready handle");
      }
      if (value.authorityEpoch !== previousIntent.authorityEpoch || value.fence !== previousIntent.fence) {
        transitionError("intent.dispatched authority is not bound to its intent");
      }
      assertIntentBinding(previousIntent, previousHandle, "intent.dispatched previous intent");
      assertIntentBinding(nextIntent, nextHandle, "intent.dispatched next intent");
      assertIntentTransition(previousIntent, nextIntent, ["status", "callbackCalls", "dispatchReserved", "dispatchStartedAt", "controllerIncarnation", "ownerLeaseId", "notSentAt", "notSentReason", "usageObservation"], "intent.dispatched intent");
      assertHandleTransition(previousHandle, nextHandle, ["status"], "intent.dispatched handle");
      if (nextIntent.status !== "dispatching" || nextIntent.callbackCalls !== 0 || nextIntent.dispatchReserved !== true ||
          nextIntent.dispatchStartedAt === null || nextIntent.notSentAt !== null || nextIntent.notSentReason !== null ||
          nextIntent.controllerIncarnation === null || nextIntent.ownerLeaseId === null || nextHandle.status !== "dispatching") {
        transitionError("intent.dispatched has an invalid dispatch state");
      }
      break;
    }
    case "intent.not-sent": {
      const value = eventPayload(event, ["handleId", "intentId", "reason"]);
      const previousIntent = intentForState(previous, value.intentId, "intent.not-sent intent");
      const nextIntent = intentForState(next, value.intentId, "intent.not-sent intent");
      const previousHandle = handleFor(previous, value.handleId, "intent.not-sent handle");
      const nextHandle = handleFor(next, value.handleId, "intent.not-sent handle");
      assertMapsStableExcept(previous, next, { handles: [value.handleId], intents: [value.intentId] });
      if (previousIntent.handleId !== value.handleId || nextIntent.handleId !== value.handleId ||
          previousIntent.status !== "dispatching" || previousIntent.callbackCalls !== 0 || previousIntent.dispatchReserved !== true ||
          !["dispatching", "revoked", "stopped", "indeterminate"].includes(previousHandle.status)) {
        transitionError("intent.not-sent requires a reserved dispatch and matching handle");
      }
      assertIntentBinding(previousIntent, previousHandle, "intent.not-sent previous intent");
      assertIntentBinding(nextIntent, nextHandle, "intent.not-sent next intent");
      assertIntentTransition(previousIntent, nextIntent, ["status", "dispatchReserved", "notSentAt", "notSentReason"], "intent.not-sent intent");
      assertHandleTransition(previousHandle, nextHandle, ["status", "dispatchBlocked"], "intent.not-sent handle");
      const expectedHandleStatus = previousHandle.status === "dispatching" ? "ready" : previousHandle.status;
      const expectedDispatchBlocked = previousHandle.status === "dispatching" ? false : previousHandle.dispatchBlocked;
      if (value.reason !== NOT_SENT_REASON || nextIntent.status !== "not-sent" || nextIntent.callbackCalls !== 0 ||
          nextIntent.dispatchReserved !== false || nextIntent.notSentAt === null || nextIntent.notSentReason !== value.reason ||
          nextIntent.sealedAt !== null || nextIntent.outcome !== null || nextIntent.effectDigest !== null ||
          nextIntent.unknownReason !== null || nextIntent.lateCallback !== false ||
          (nextIntent.usageObservation !== undefined && nextIntent.usageObservation !== null) ||
          nextHandle.status !== expectedHandleStatus || nextHandle.dispatchBlocked !== expectedDispatchBlocked) {
        transitionError("intent.not-sent has an invalid pre-send state");
      }
      break;
    }
    case "intent.unknown":
    case "intent.late-callback-rejected":
    case "intent.recovered-unknown": {
      const value = eventPayload(event, op === "intent.recovered-unknown"
        ? ["handleId", "intentId", "reason"]
        : ["intentId", "reason"]);
      const previousIntent = intentForState(previous, value.intentId, `${op} intent`);
      const nextIntent = intentForState(next, value.intentId, `${op} intent`);
      const handleId = value.handleId ?? previousIntent.handleId;
      const previousHandle = handleFor(previous, handleId, `${op} handle`);
      const nextHandle = handleFor(next, handleId, `${op} handle`);
      assertMapsStableExcept(previous, next, { handles: [handleId], intents: [value.intentId] });
      if (previousIntent.handleId !== handleId || nextIntent.handleId !== handleId) {
        transitionError(`${op} identity does not match its payload`);
      }
      const recoveredBeforeCallback = op === "intent.recovered-unknown";
      if (previousIntent.status !== "dispatching" || previousIntent.callbackCalls !== 0 || previousIntent.dispatchReserved !== true ||
          !["dispatching", "revoked", "stopped", "indeterminate"].includes(previousHandle.status)) {
        transitionError(`${op} requires a dispatching intent and handle`);
      }
      assertIntentBinding(previousIntent, previousHandle, `${op} previous intent`);
      assertIntentBinding(nextIntent, nextHandle, `${op} next intent`);
      assertIntentTransition(previousIntent, nextIntent, ["status", "callbackCalls", "dispatchReserved", "sealedAt", "outcome", "unknownReason", "lateCallback"], `${op} intent`);
      assertHandleTransition(previousHandle, nextHandle, ["status", "dispatchBlocked"], `${op} handle`);
      const expectedLateCallback = op !== "intent.unknown";
      if (nextIntent.status !== "unknown" || nextIntent.callbackCalls !== (recoveredBeforeCallback ? 0 : 1) ||
          nextIntent.dispatchReserved !== recoveredBeforeCallback || nextIntent.notSentAt !== null || nextIntent.notSentReason !== null ||
          nextIntent.sealedAt === null || nextIntent.outcome !== "unknown" ||
          nextIntent.effectDigest !== null || nextIntent.unknownReason !== value.reason ||
          (nextIntent.usageObservation !== undefined && nextIntent.usageObservation !== null) ||
          nextIntent.lateCallback !== expectedLateCallback || nextHandle.status !== "indeterminate" ||
          nextHandle.dispatchBlocked !== true) {
        transitionError(`${op} has an invalid unknown transition`);
      }
      if (op === "intent.unknown" && value.reason !== "effect-callback-error") {
        transitionError("intent.unknown reason is invalid");
      }
      if (op === "intent.recovered-unknown" && value.reason !== "controller-restart-before-seal") {
        transitionError("intent.recovered-unknown reason is invalid");
      }
      if (op === "intent.late-callback-rejected" && !["stale-epoch-or-revocation", "revoked-before-seal", "admission-commit-unavailable", "admission-commit-rejected", "effect-result-unpersistable"].includes(value.reason)) {
        transitionError("intent.late-callback-rejected reason is invalid");
      }
      break;
    }
    case "intent.reconciled": {
      const value = eventPayload(event, ["handleId", "intentId", "reconciliation"]);
      const previousIntent = intentForState(previous, value.intentId, "intent.reconciled intent");
      const nextIntent = intentForState(next, value.intentId, "intent.reconciled intent");
      const previousHandle = handleFor(previous, value.handleId, "intent.reconciled handle");
      const nextHandle = handleFor(next, value.handleId, "intent.reconciled handle");
      assertMapsStableExcept(previous, next, { intents: [value.intentId] });
      if (previousIntent.handleId !== value.handleId || nextIntent.handleId !== value.handleId) {
        transitionError("intent.reconciled identity does not match its payload");
      }
      if (previousIntent.status !== "unknown" ||
          !["indeterminate", "stopped", "revoked"].includes(previousHandle.status) || previousHandle.dispatchBlocked !== true) {
        transitionError("intent.reconciled requires an UNKNOWN intent on a dispatch-blocked handle");
      }
      assertIntentBinding(previousIntent, previousHandle, "intent.reconciled previous intent");
      assertIntentBinding(nextIntent, nextHandle, "intent.reconciled next intent");
      try {
        validateExecutionReconciliation(value.reconciliation, {
          runId: previousIntent.runId,
          handleId: previousHandle.handleId,
          intentId: previousIntent.intentId,
          executionId: previousIntent.executionId,
          attemptId: previousIntent.attemptId,
          unitId: previousIntent.unitId,
          sourceBindingDigest: previousIntent.sourceBindingDigest,
          policyDigest: previousIntent.policyDigest,
          revision: previousIntent.revision,
          authorityEpoch: previousIntent.authorityEpoch,
          fence: previousIntent.fence,
          ownedResourceId: previousHandle.ownedResourceId
        });
      } catch (error) {
        transitionError(error.message);
      }
      if (value.reconciliation.runId !== previousIntent.runId ||
          value.reconciliation.handleId !== previousHandle.handleId ||
          value.reconciliation.intentId !== previousIntent.intentId ||
          value.reconciliation.observation.ownedResourceId !== previousHandle.ownedResourceId) {
        transitionError("intent.reconciled record is not bound to the owned execution");
      }
      const previousHistory = previousIntent.reconciliation ?? [];
      const nextHistory = nextIntent.reconciliation;
      if (!Array.isArray(nextHistory) || nextHistory.length !== previousHistory.length + 1 ||
          !previousHistory.every((record, index) => semanticSame(record, nextHistory[index])) ||
          !semanticSame(nextHistory[nextHistory.length - 1], value.reconciliation)) {
        transitionError("intent.reconciled history is not append-only");
      }
      assertIntentTransition(previousIntent, nextIntent, ["reconciliation"], "intent.reconciled intent");
      assertHandleTransition(previousHandle, nextHandle, [], "intent.reconciled handle");
      if (nextHistory[nextHistory.length - 1] === undefined) {
        transitionError("intent.reconciled record was not durably attached");
      }
      break;
    }
    case "intent.cleanup-confirmed": {
      const value = eventPayload(event, ["cleanupResolution", "handleId", "intentId"]);
      const previousIntent = intentForState(previous, value.intentId, "intent.cleanup-confirmed intent");
      const nextIntent = intentForState(next, value.intentId, "intent.cleanup-confirmed intent");
      const previousHandle = handleFor(previous, value.handleId, "intent.cleanup-confirmed handle");
      const nextHandle = handleFor(next, value.handleId, "intent.cleanup-confirmed handle");
      assertMapsStableExcept(previous, next, { intents: [value.intentId] });
      if (previousIntent.handleId !== value.handleId || nextIntent.handleId !== value.handleId) {
        transitionError("intent.cleanup-confirmed identity does not match its payload");
      }
      if (previousIntent.status !== "unknown" || previousHandle.status !== "indeterminate" ||
          previousHandle.dispatchBlocked !== true || previousIntent.cleanupResolution !== undefined) {
        transitionError("intent.cleanup-confirmed requires an unresolved indeterminate execution");
      }
      assertIntentBinding(previousIntent, previousHandle, "intent.cleanup-confirmed previous intent");
      assertIntentBinding(nextIntent, nextHandle, "intent.cleanup-confirmed next intent");
      try {
        validateExecutionOwnedCleanupResolution(value.cleanupResolution);
      } catch (error) {
        transitionError(error.message);
      }
      const cleanup = value.cleanupResolution;
      for (const key of [
        "runId", "handleId", "intentId", "executionId", "attemptId", "unitId", "ownedResourceId",
        "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence"
      ]) {
        const expected = key === "handleId" || key === "ownedResourceId"
          ? (key === "handleId" ? previousHandle.handleId : previousHandle.ownedResourceId)
          : previousIntent[key];
        if (cleanup[key] !== expected) transitionError(`intent.cleanup-confirmed ${key} is not bound`);
      }
      if (!semanticSame(nextIntent.cleanupResolution, cleanup) || nextIntent.status !== "unknown" ||
          nextIntent.outcome !== "unknown" || nextIntent.effectDigest !== null || nextIntent.notSentAt !== null ||
          nextIntent.notSentReason !== null || nextHandle.status !== "indeterminate" || nextHandle.dispatchBlocked !== true) {
        transitionError("intent.cleanup-confirmed changed the UNKNOWN execution lifecycle");
      }
      assertIntentTransition(previousIntent, nextIntent, ["cleanupResolution"], "intent.cleanup-confirmed intent");
      assertHandleTransition(previousHandle, nextHandle, [], "intent.cleanup-confirmed handle");
      break;
    }
    case "intent.sealed":
    case "intent.sealed-with-effect": {
      const withEffect = op === "intent.sealed-with-effect";
      const hasAdmissionSeal = Object.hasOwn(event.payload ?? {}, "admissionSeal");
      const hasUsageObservation = Object.hasOwn(event.payload ?? {}, "usageObservation");
      const value = eventPayload(event, [
        ...(hasAdmissionSeal ? ["admissionSeal"] : []),
        "effectDigest", "handleId", "intentId", "outcome",
        ...(withEffect ? ["effect", "effectByteLength"] : []),
        ...(hasUsageObservation ? ["usageObservation"] : [])
      ]);
      if (withEffect && (event.schemaVersion !== JOURNAL_EVENT_SCHEMA_VERSION || !hasAdmissionSeal)) {
        transitionError("intent.sealed-with-effect requires a V2 journal event and V3 admission seal");
      }
      const previousIntent = intentForState(previous, value.intentId, "sealed intent");
      const nextIntent = intentForState(next, value.intentId, "sealed intent");
      const previousHandle = handleFor(previous, value.handleId, "sealed handle");
      const nextHandle = handleFor(next, value.handleId, "sealed handle");
      assertMapsStableExcept(previous, next, { handles: [value.handleId], intents: [value.intentId] });
      if (previousIntent.handleId !== value.handleId || nextIntent.handleId !== value.handleId) {
        transitionError("intent.sealed identity does not match its payload");
      }
      if (previousIntent.status !== "dispatching" || previousIntent.callbackCalls !== 0 || previousIntent.dispatchReserved !== true || previousHandle.status !== "dispatching") {
        transitionError("intent.sealed requires a dispatching intent and handle");
      }
      assertIntentBinding(previousIntent, previousHandle, "intent.sealed previous intent");
      assertIntentBinding(nextIntent, nextHandle, "intent.sealed next intent");
      assertIntentTransition(previousIntent, nextIntent, ["status", "callbackCalls", "dispatchReserved", "sealedAt", "outcome", "effectDigest", "admissionSeal", ...(hasUsageObservation ? ["usageObservation"] : [])], "intent.sealed intent");
      assertHandleTransition(previousHandle, nextHandle, ["status"], "intent.sealed handle");
      if (!(["success", "failure"].includes(value.outcome)) || nextIntent.status !== "sealed" ||
          nextIntent.sealedAt === null || nextIntent.outcome !== value.outcome ||
          nextIntent.effectDigest !== value.effectDigest || nextHandle.status !== (value.outcome === "success" ? "completed" : "failed")) {
        transitionError("intent.sealed has an invalid terminal transition");
      }
      assertDigest(value.effectDigest, "intent.sealed payload.effectDigest");
      if (withEffect) {
        let artifact;
        try {
          artifact = canonicalSealedEffect(value.effect);
        } catch (error) {
          transitionError(`intent.sealed-with-effect artifact is invalid: ${error.message}`);
        }
        if (artifact.digest !== value.effectDigest || artifact.byteLength !== value.effectByteLength ||
            artifact.effect.outcome !== value.outcome) {
          transitionError("intent.sealed-with-effect artifact does not match the sealed outcome and digest");
        }
      }
      if (hasUsageObservation) {
        try {
          validateExecutionUsageObservation(value.usageObservation, {
            ...bindingForHandle(nextHandle),
            handleId: value.handleId,
            intentId: value.intentId,
            ownedResourceId: nextHandle.ownedResourceId,
            authorityEpoch: nextHandle.authorityEpoch,
            fence: nextHandle.fence
          }, "intent.sealed payload.usageObservation");
        } catch (error) {
          transitionError(error.message);
        }
        if (!semanticSame(nextIntent.usageObservation, value.usageObservation)) {
          transitionError("intent.sealed usage observation is not stored in the durable intent");
        }
      } else if (nextIntent.usageObservation !== undefined) {
        transitionError("intent.sealed usage observation is missing from the journal payload");
      }
      if (hasAdmissionSeal) {
        if (nextHandle.admissionDigest === undefined || nextIntent.admissionSeal === undefined) {
          transitionError("intent.sealed V3 admission seal is missing from the durable handle or intent");
        }
        try {
          validateTrustedAdmissionSeal(value.admissionSeal, {
            runId: nextHandle.runId,
            handleId: value.handleId,
            intentId: value.intentId,
            admissionDigest: nextHandle.admissionDigest,
            authorityEpoch: nextHandle.authorityEpoch,
            fence: nextHandle.fence,
            outcome: value.outcome,
            effectDigest: value.effectDigest
          });
        } catch (error) {
          transitionError(error.message);
        }
        if (!semanticSame(nextIntent.admissionSeal, value.admissionSeal)) {
          transitionError("intent.sealed admission seal is not stored in the durable intent");
        }
      } else if (nextHandle.admissionDigest !== undefined || nextIntent.admissionSeal !== undefined) {
        transitionError("intent.sealed V3 admission seal is missing from the journal payload");
      }
      break;
    }
    case "stop.requested": {
      const value = eventPayload(event, ["handleId", "reason", "stopRequestId"]);
      const previousHandle = handleFor(previous, value.handleId, "stop.requested handle");
      const nextHandle = handleFor(next, value.handleId, "stop.requested handle");
      const request = next.stopRequests[value.stopRequestId];
      if (!request) transitionError("stop.requested request was not added");
      assertAddedMapEntry(previous, next, "stopRequests", value.stopRequestId);
      const cancelledIntentIds = Object.values(previous.intents)
        .filter((item) => item.handleId === value.handleId && item.status === "pending")
        .map((item) => item.intentId);
      assertMapsStableExcept(previous, next, {
        handles: [value.handleId],
        intents: cancelledIntentIds,
        stopRequests: [value.stopRequestId]
      });
      if (value.reason !== request.reason || request.handleId !== value.handleId) transitionError("stop.requested identity does not match its payload");
      if (Object.values(previous.stopRequests).some((item) => item.handleId === value.handleId && item.reason === value.reason)) {
        transitionError("stop.requested duplicates an existing stop request");
      }
      assertStopRequestBinding(request, previousHandle, "stop.requested request");
      assertHandleTransition(previousHandle, nextHandle, ["status", "dispatchBlocked", "revokedAt"], "stop.requested handle");
      if (nextHandle.status !== "revoked" || nextHandle.dispatchBlocked !== true || nextHandle.revokedAt === null) {
        transitionError("stop.requested must revoke and block the handle");
      }
      for (const [intentId, previousIntent] of Object.entries(previous.intents)) {
        const nextIntent = next.intents[intentId];
        if (previousIntent.handleId !== value.handleId || previousIntent.status !== "pending") {
          if (!semanticSame(previousIntent, nextIntent)) transitionError(`stop.requested changed intents.${intentId} unexpectedly`);
          continue;
        }
        assertIntentTransition(previousIntent, nextIntent, ["status", "outcome", "unknownReason"], `stop.requested intents.${intentId}`);
        if (nextIntent.status !== "cancelled" || nextIntent.outcome !== "unknown" || nextIntent.unknownReason !== "stop-requested") {
          transitionError(`stop.requested did not cancel intents.${intentId} correctly`);
        }
      }
      break;
    }
    case "stop.receipt.sealed": {
      const value = eventPayload(event, ["outcome", "stopReceiptId", "stopRequestId"]);
      const request = previous.stopRequests[value.stopRequestId];
      if (!request) transitionError("stop.receipt.sealed references a missing stop request");
      const receipt = next.stopReceipts[value.stopReceiptId];
      if (!receipt) transitionError("stop.receipt.sealed receipt was not added");
      const previousHandle = handleFor(previous, request.handleId, "stop.receipt.sealed handle");
      const nextHandle = handleFor(next, request.handleId, "stop.receipt.sealed handle");
      assertAddedMapEntry(previous, next, "stopReceipts", value.stopReceiptId);
      assertMapsStableExcept(previous, next, { handles: [request.handleId], stopReceipts: [value.stopReceiptId] });
      if (receipt.stopReceiptId !== value.stopReceiptId || receipt.stopRequestId !== value.stopRequestId || receipt.handleId !== request.handleId) {
        transitionError("stop.receipt.sealed identity does not match its payload");
      }
      if (Object.values(previous.stopReceipts).some((item) => item.stopRequestId === value.stopRequestId)) {
        transitionError("stop.receipt.sealed duplicates an existing receipt");
      }
      validateStopReceipt(receipt);
      assertStopRequestBinding(receipt, previousHandle, "stop.receipt.sealed receipt");
      if (receipt.reason !== request.reason || receipt.securityRcaRequired !== request.securityRcaRequired ||
          receipt.outcome !== value.outcome || receipt.stopRequestId !== request.stopRequestId) {
        transitionError("stop.receipt.sealed receipt is not bound to its request");
      }
      assertHandleTransition(previousHandle, nextHandle, ["status"], "stop.receipt.sealed handle");
      if (nextHandle.dispatchBlocked !== true || nextHandle.status !== (receipt.outcome === "STOPPED" ? "stopped" : "indeterminate")) {
        transitionError("stop.receipt.sealed has an invalid final handle state");
      }
      break;
    }
    case "recovery.batch-committed": {
      const value = eventPayload(event, ["entries", "handoff"]);
      let handoff;
      try {
        handoff = validateExecutionRecoveryHandoffV1(value.handoff, { runId: previous.runId });
      } catch (error) {
        transitionError(error.message);
      }
      if (!Array.isArray(value.entries) || value.entries.length !== handoff.entries.length) {
        transitionError("recovery.batch-committed entries do not cover the handoff");
      }
      if (handoff.sourceRegistrySequence !== previous.sequence ||
          handoff.sourceRegistryStateDigest !== previous.stateDigest ||
          handoff.committedRegistrySequence !== next.sequence ||
          handoff.committedRegistryStateDigest !== next.stateDigest) {
        transitionError("recovery.batch-committed registry head is not bound");
      }
      const entries = value.entries.map((entry, index) => {
        try {
          return validateRecoveryBatchJournalEntry(entry, index);
        } catch (error) {
          transitionError(error.message);
        }
      });
      if (entries.some((entry, index) => entry.taskId !== handoff.taskIds[index])) {
        transitionError("recovery.batch-committed task order is not bound");
      }
      const handleIds = entries.map((entry) => entry.handleId);
      const recoveryPlanIds = entries.flatMap((entry) => entry.recoveryPlanId === null ? [] : [entry.recoveryPlanId]);
      const controllerIds = entries.map((entry) => entry.controllerId);
      const executionIds = entries.map((entry) => entry.binding.executionId);
      const attemptIds = entries.map((entry) => entry.binding.attemptId);
      const admissionIds = entries.map((entry) => entry.admission.admissionId);
      if (new Set(handleIds).size !== handleIds.length || new Set(recoveryPlanIds).size !== recoveryPlanIds.length ||
          new Set(controllerIds).size !== controllerIds.length || new Set(executionIds).size !== executionIds.length ||
          new Set(attemptIds).size !== attemptIds.length || new Set(admissionIds).size !== admissionIds.length) {
        transitionError("recovery.batch-committed reuses a controller, handle, recovery-plan, execution, attempt, or admission identity");
      }
      if (entries.some((entry) => Object.values(previous.handles).some((handle) =>
        handle.executionId === entry.binding.executionId || handle.attemptId === entry.binding.attemptId
      ))) {
        transitionError("recovery.batch-committed reuses a durable execution or attempt identity");
      }
      assertMapsStableExcept(previous, next, { handles: handleIds, recoveryPlans: recoveryPlanIds });
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const marker = handoff.entries[index];
        const handle = next.handles[entry.handleId];
        if (!handle) transitionError(`recovery.batch-committed handle ${entry.handleId} is missing`);
        assertAddedMapEntry(previous, next, "handles", entry.handleId);
        assertHandleBinding(handle, entry.binding, `recovery.batch-committed ${entry.taskId}`);
        let admission;
        try {
          admission = admissionForBinding(entry.admission, handle, `recovery.batch-committed ${entry.taskId} admission`);
        } catch (error) {
          transitionError(error.message);
        }
        const admissionDigest = digestExecutionAdmission(admission);
        if (handle.admissionDigest !== admissionDigest || marker.taskId !== entry.taskId ||
            marker.controllerId !== entry.controllerId || marker.handleId !== entry.handleId ||
            marker.priorHandleId !== entry.priorHandleId || marker.recoveryPlanId !== entry.recoveryPlanId ||
            marker.executionId !== entry.binding.executionId || marker.attemptId !== entry.binding.attemptId ||
            marker.unitId !== entry.binding.unitId || marker.ownedResourceId !== entry.binding.ownedResourceId ||
            marker.bindingDigest !== digestObject(entry.binding) ||
            marker.logicalObligationDigest !== handle.obligationKey ||
            marker.handleDigest !== digestObject(handle) ||
            marker.admissionDigest !== admissionDigest || marker.reservationKey !== reservationKey(admission)) {
          transitionError(`recovery.batch-committed ${entry.taskId} marker is not bound`);
        }
        if (handle.status !== "ready" || handle.dispatchBlocked !== true || handle.revokedAt !== null) {
          transitionError(`recovery.batch-committed ${entry.taskId} handle is not ready and dispatch-blocked`);
        }
        if (entry.priorHandleId === null) {
          if (Object.values(previous.handles).some((prior) => prior.obligationKey === handle.obligationKey)) {
            transitionError(`recovery.batch-committed ${entry.taskId} initial obligation is already reserved`);
          }
          assertHandleOrigin(handle, entry.binding, `recovery.batch-committed ${entry.taskId}`);
          continue;
        }
        const oldHandle = handleFor(previous, entry.priorHandleId, `recovery.batch-committed ${entry.taskId} source`);
        assertRecoverableSourceHandle(previous, oldHandle, `recovery.batch-committed ${entry.taskId} source`);
        const plan = next.recoveryPlans[entry.recoveryPlanId];
        if (!plan) transitionError(`recovery.batch-committed ${entry.taskId} recovery plan is missing`);
        assertAddedMapEntry(previous, next, "recoveryPlans", entry.recoveryPlanId);
        validateRecoveryPlan(plan);
        if (plan.recoveryPlanId !== entry.recoveryPlanId || plan.fromHandleId !== oldHandle.handleId ||
            plan.newHandleId !== handle.handleId || plan.runId !== oldHandle.runId ||
            plan.executionId !== handle.executionId || plan.newAttemptId !== handle.attemptId ||
            plan.priorAttemptId !== oldHandle.attemptId || plan.unitId !== oldHandle.unitId ||
            plan.sourceBindingDigest !== oldHandle.sourceBindingDigest || plan.policyDigest !== oldHandle.policyDigest ||
            plan.revision !== oldHandle.revision || plan.oldAuthorityEpoch !== oldHandle.authorityEpoch ||
            plan.oldFence !== oldHandle.fence || plan.newAuthorityEpoch !== handle.authorityEpoch ||
            plan.newFence !== handle.fence || handle.obligationKey !== oldHandle.obligationKey ||
            handle.executionScopeDigest !== oldHandle.executionScopeDigest || handle.authorityEpoch <= oldHandle.authorityEpoch ||
            handle.fence === oldHandle.fence || handle.executionId === oldHandle.executionId ||
            handle.attemptId === oldHandle.attemptId || plan.reason !== "incident-recovery-dag-runtime-handoff") {
          transitionError(`recovery.batch-committed ${entry.taskId} successor is not bound`);
        }
        assertHandleOrigin(handle, entry.binding, `recovery.batch-committed ${entry.taskId}`, {
          resumedFromHandleId: oldHandle.handleId,
          priorAttemptId: oldHandle.attemptId
        });
      }
      break;
    }
    case "recovery.handoff-claimed": {
      const value = eventPayload(event, ["claim"]);
      let claim;
      try {
        claim = validateExecutionRecoveryHandoffClaimV1(value.claim, { runId: previous.runId });
      } catch (error) {
        transitionError(error.message);
      }
      assertMapsStableExcept(previous, next);
      if (claim.sourceRegistrySequence !== previous.sequence ||
          claim.sourceRegistryStateDigest !== previous.stateDigest ||
          claim.committedRegistrySequence !== next.sequence ||
          claim.committedRegistryStateDigest !== next.stateDigest) {
        transitionError("recovery.handoff-claimed registry head is not bound");
      }
      for (const entry of claim.entries) {
        const handle = handleFor(previous, entry.handleId, `recovery.handoff-claimed ${entry.taskId}`);
        if (digestObject(handle) !== entry.handleDigest || handle.attemptId !== entry.attemptId ||
            handle.admissionDigest !== entry.admissionDigest || handle.status !== "ready" ||
            handle.dispatchBlocked !== true || handle.revokedAt !== null ||
            Object.values(previous.intents).some((intent) => intent.handleId === entry.handleId)) {
          transitionError(`recovery.handoff-claimed ${entry.taskId} is not an untouched blocked handoff handle`);
        }
      }
      break;
    }
    case "recovery.task-release-authorized": {
      const value = eventPayload(event, ["release"]);
      let release;
      try {
        release = validateExecutionRecoveryTaskReleaseV1(value.release, { runId: previous.runId });
      } catch (error) {
        transitionError(error.message);
      }
      assertMapsStableExcept(previous, next);
      if (release.sourceRegistrySequence !== previous.sequence ||
          release.sourceRegistryStateDigest !== previous.stateDigest ||
          release.committedRegistrySequence !== next.sequence ||
          release.committedRegistryStateDigest !== next.stateDigest) {
        transitionError("recovery.task-release-authorized registry head is not bound");
      }
      const handle = handleFor(previous, release.handleId, `recovery.task-release-authorized ${release.taskId}`);
      if (digestObject(handle) !== release.handleDigest || handle.attemptId !== release.attemptId ||
          handle.admissionDigest !== release.admissionDigest || handle.status !== "ready" ||
          handle.dispatchBlocked !== true || handle.revokedAt !== null ||
          Object.values(previous.intents).some((intent) => intent.handleId === release.handleId)) {
        transitionError(`recovery.task-release-authorized ${release.taskId} is not an untouched blocked handoff handle`);
      }
      break;
    }
    case "recovery.task-permit-consumed": {
      const value = eventPayload(event, ["consumption"]);
      let consumption;
      try {
        consumption = validateExecutionRecoveryTaskPermitConsumptionV1(value.consumption, { runId: previous.runId });
      } catch (error) {
        transitionError(error.message);
      }
      assertMapsStableExcept(previous, next);
      if (consumption.sourceRegistrySequence !== previous.sequence ||
          consumption.sourceRegistryStateDigest !== previous.stateDigest ||
          consumption.committedRegistrySequence !== next.sequence ||
          consumption.committedRegistryStateDigest !== next.stateDigest) {
        transitionError("recovery.task-permit-consumed registry head is not bound");
      }
      const handle = handleFor(previous, consumption.handleId, `recovery.task-permit-consumed ${consumption.taskId}`);
      if (digestObject(handle) !== consumption.handleDigest || handle.attemptId !== consumption.attemptId ||
          handle.admissionDigest !== consumption.admissionDigest || handle.status !== "ready" ||
          handle.dispatchBlocked !== true || handle.revokedAt !== null ||
          Object.values(previous.intents).some((intent) => intent.handleId === consumption.handleId)) {
        transitionError(`recovery.task-permit-consumed ${consumption.taskId} is not an untouched blocked handoff handle`);
      }
      break;
    }
    case "recovery.task-effect-intent-created":
    case "recovery.task-effect-dispatch-reserved":
    case "recovery.task-effect-not-sent":
    case "recovery.task-effect-unknown": {
      const value = eventPayload(event, ["intent"]);
      let intent;
      try {
        intent = validateExecutionRecoveryTaskEffectIntentV1(value.intent, { runId: previous.runId });
      } catch (error) {
        transitionError(error.message);
      }
      const expectedStatus = {
        "recovery.task-effect-intent-created": "created",
        "recovery.task-effect-dispatch-reserved": "dispatch-reserved",
        "recovery.task-effect-not-sent": "not-sent",
        "recovery.task-effect-unknown": "unknown"
      }[op];
      if (intent.status !== expectedStatus ||
          intent.sourceRegistrySequence !== previous.sequence ||
          intent.sourceRegistryStateDigest !== previous.stateDigest ||
          intent.committedRegistrySequence !== next.sequence ||
          intent.committedRegistryStateDigest !== next.stateDigest) {
        transitionError(`${op} status or registry head is not bound`);
      }
      assertRecoveryTaskEffectIntentBinding(previous, next, intent, op);
      break;
    }
    case "recovery.task-effect-launch-recorded": {
      const value = eventPayload(event, ["launch"]);
      let launch;
      try {
        launch = validateExecutionRecoveryTaskEffectLaunchV1(value.launch, { runId: previous.runId });
      } catch (error) {
        transitionError(error.message);
      }
      if (launch.sourceRegistrySequence !== previous.sequence ||
          launch.sourceRegistryStateDigest !== previous.stateDigest ||
          launch.committedRegistrySequence !== next.sequence ||
          launch.committedRegistryStateDigest !== next.stateDigest) {
        transitionError("recovery.task-effect-launch-recorded registry head is not bound");
      }
      assertRecoveryTaskEffectIntentBinding(previous, next, launch, op);
      break;
    }
    case "recovery.task-effect-outcome-recorded": {
      const value = eventPayload(event, ["outcome"]);
      let outcome;
      try {
        outcome = validateExecutionRecoveryTaskEffectOutcomeV1(value.outcome, { runId: previous.runId });
      } catch (error) {
        transitionError(error.message);
      }
      if (outcome.sourceRegistrySequence !== previous.sequence ||
          outcome.sourceRegistryStateDigest !== previous.stateDigest ||
          outcome.committedRegistrySequence !== next.sequence ||
          outcome.committedRegistryStateDigest !== next.stateDigest) {
        transitionError("recovery.task-effect-outcome-recorded registry head is not bound");
      }
      assertRecoveryTaskEffectIntentBinding(previous, next, outcome, op);
      break;
    }
    case "recovery.task-effect-outcome-reconciled": {
      const value = eventPayload(event, ["reconciliation"]);
      const reconciliation = validateExecutionRecoveryTaskEffectReconciliationV1(value.reconciliation, { runId: previous.runId });
      if (reconciliation.sourceRegistrySequence !== previous.sequence || reconciliation.sourceRegistryStateDigest !== previous.stateDigest ||
          reconciliation.committedRegistrySequence !== next.sequence || reconciliation.committedRegistryStateDigest !== next.stateDigest) {
        transitionError("recovery reconciliation registry head is not bound");
      }
      assertRecoveryTaskEffectIntentBinding(previous, next, reconciliation.originalOutcome, op);
      validateExecutionRecoveryTaskEffectResourceObservationV1(reconciliation.observation,
        recoveryResourceBinding(reconciliation.originalOutcome, previous.handles[reconciliation.originalOutcome.handleId]));
      break;
    }
    case "recovery.prepared": {
      const hasAdmission = Object.hasOwn(event.payload ?? {}, "admission");
      const value = eventPayload(event, hasAdmission
        ? ["admission", "fromHandleId", "newHandleId", "recoveryPlanId"]
        : ["fromHandleId", "newHandleId", "recoveryPlanId"]);
      const oldHandle = handleFor(previous, value.fromHandleId, "recovery source handle");
      const newHandle = next.handles[value.newHandleId];
      const plan = next.recoveryPlans[value.recoveryPlanId];
      if (!newHandle || !plan) transitionError("recovery.prepared did not add its handle and plan");
      assertAddedMapEntry(previous, next, "handles", value.newHandleId);
      assertAddedMapEntry(previous, next, "recoveryPlans", value.recoveryPlanId);
      assertMapsStableExcept(previous, next, { handles: [value.newHandleId], recoveryPlans: [value.recoveryPlanId] });
      const sourceNotSent = Object.values(previous.intents).some((intent) =>
        intent.handleId === oldHandle.handleId && intent.status === "not-sent" && intent.callbackCalls === 0 && intent.dispatchReserved === false
      );
      if (!["revoked", "stopped", "failed", "indeterminate"].includes(oldHandle.status) &&
          !(oldHandle.status === "ready" && sourceNotSent)) {
        transitionError("recovery.prepared requires a recoverable source handle");
      }
      if (recoveryNeedsReconciliation(oldHandle, findIntentForHandle(previous, oldHandle.handleId))) {
        transitionError("recovery.prepared requires a resolved outcome before a fresh attempt");
      }
      validateRecoveryPlan(plan);
      if (plan.recoveryPlanId !== value.recoveryPlanId || plan.fromHandleId !== value.fromHandleId ||
          plan.newHandleId !== value.newHandleId || plan.runId !== oldHandle.runId ||
          plan.executionId !== newHandle.executionId || plan.newAttemptId !== newHandle.attemptId ||
          plan.priorAttemptId !== oldHandle.attemptId || plan.unitId !== oldHandle.unitId ||
          plan.sourceBindingDigest !== oldHandle.sourceBindingDigest || plan.policyDigest !== oldHandle.policyDigest ||
          plan.revision !== oldHandle.revision || plan.oldAuthorityEpoch !== oldHandle.authorityEpoch ||
          plan.oldFence !== oldHandle.fence || plan.newAuthorityEpoch !== newHandle.authorityEpoch ||
          plan.newFence !== newHandle.fence) {
        transitionError("recovery.prepared plan is not bound to its handles");
      }
      assertHandleBinding(newHandle, bindingForHandle(newHandle), "recovery.prepared new handle");
      assertHandleOrigin(newHandle, bindingForHandle(newHandle), "recovery.prepared new handle", {
        resumedFromHandleId: oldHandle.handleId,
        priorAttemptId: oldHandle.attemptId
      });
      if (newHandle.status !== "ready" || newHandle.dispatchBlocked !== false || newHandle.revokedAt !== null ||
          newHandle.obligationKey !== oldHandle.obligationKey || newHandle.executionScopeDigest !== oldHandle.executionScopeDigest ||
          newHandle.origin.resumedFromHandleId !== oldHandle.handleId || newHandle.origin.priorAttemptId !== oldHandle.attemptId ||
          plan.newAuthorityEpoch <= plan.oldAuthorityEpoch) {
        transitionError("recovery.prepared new handle is not a fresh bound attempt");
      }
      if (hasAdmission) {
        try {
          const admission = admissionForBinding(value.admission, newHandle, "recovery.prepared admission");
          if (newHandle.admissionDigest === undefined || digestExecutionAdmission(admission) !== newHandle.admissionDigest) {
            transitionError("recovery.prepared admission digest is not bound to the immutable handle");
          }
        } catch (error) {
          transitionError(error.message);
        }
      } else if (newHandle.admissionDigest !== undefined) {
        transitionError("V3 recovery admission reservation is missing");
      }
      break;
    }
    default:
      transitionError(`unsupported operation ${String(op)}`);
  }
}

function verifyEvent(record, previous, runId) {
  if (!isPlainObject(record) || record.event !== JOURNAL_EVENT) throw new Error("Execution registry journal contains an unexpected event");
  const event = record;
  assertIso(event.at, "Execution registry journal event.at");
  if (event.schemaVersion === LEGACY_JOURNAL_EVENT_SCHEMA_VERSION && event.kind === LEGACY_JOURNAL_EVENT_KIND) {
    exactKeys(event, LEGACY_JOURNAL_EVENT_RECORD_KEYS, "Execution registry legacy journal event");
    if (event.sequence !== previous.sequence + 1 || event.previousSequence !== previous.sequence) {
      throw new Error("Execution registry journal sequence is not contiguous");
    }
    if (event.previousStateDigest !== previous.stateDigest) throw new Error("Execution registry journal previous digest does not match");
    validateRegistry(event.state, runId);
    if (event.state.sequence !== event.sequence || event.state.stateDigest !== event.stateDigest || registryDigest(event.state) !== event.stateDigest) {
      throw new Error("Execution registry journal state digest is invalid");
    }
    assertEventTransition(previous, event.state, event.op, event.payload, event.schemaVersion);
    return event.state;
  }
  if (event.schemaVersion !== JOURNAL_EVENT_SCHEMA_VERSION || event.kind !== JOURNAL_EVENT_KIND) {
    throw new Error("Execution registry journal event is invalid");
  }
  exactKeys(event, JOURNAL_EVENT_RECORD_KEYS, "Execution registry journal event");
  if (event.runId !== runId) throw new Error("Execution registry journal run identity is invalid");
  if (event.sequence !== previous.sequence + 1 || event.previousSequence !== previous.sequence) {
    throw new Error("Execution registry journal sequence is not contiguous");
  }
  if (event.previousStateDigest !== previous.stateDigest) throw new Error("Execution registry journal previous digest does not match");
  const rebuilt = applyRegistryDelta(previous, event.delta);
  const next = {
    ...rebuilt,
    sequence: event.sequence,
    stateDigest: event.stateDigest
  };
  validateRegistry(next, runId);
  if (next.stateDigest !== registryDigest(next)) throw new Error("Execution registry journal state digest is invalid");
  assertEventTransition(previous, next, event.op, event.payload, event.schemaVersion);
  return next;
}

function safeRecordMap(value) {
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error("Execution registry map contains a forbidden key");
    output[key] = item;
  }
  return output;
}

function replaceMap(state, key, id, value) {
  const next = clone(state);
  next[key] = safeRecordMap({ ...next[key], [id]: clone(value) });
  return next;
}

function removeMap(state, key, id) {
  const next = clone(state);
  const map = { ...next[key] };
  delete map[id];
  next[key] = map;
  return next;
}

function findIntentForHandle(state, handleId) {
  return Object.values(state.intents).find((intent) => intent.handleId === handleId && ["pending", "dispatching", "not-sent", "sealed", "unknown"].includes(intent.status)) ?? null;
}

function recoveryHandoffFailure(code, message, status = "HOLD", details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

function validateRecoveryHandoffSeed(value, runId) {
  const label = "recovery handoff seed";
  assertSafeObject(value, label);
  exactKeys(value, [
    "handoffId", "recoveryId", "batchDigest", "recoveryPlanDigest", "authorityDigest",
    "authorityReceiptDigest", "admissionStateRootDigest", "admissionStorageScopeDigest",
    "runtimeScopeDigest", "sourceRegistrySequence", "sourceRegistryStateDigest"
  ], label);
  const seed = {
    handoffId: assertId(value.handoffId, `${label}.handoffId`),
    recoveryId: assertId(value.recoveryId, `${label}.recoveryId`),
    batchDigest: assertDigest(value.batchDigest, `${label}.batchDigest`),
    recoveryPlanDigest: assertDigest(value.recoveryPlanDigest, `${label}.recoveryPlanDigest`),
    authorityDigest: assertDigest(value.authorityDigest, `${label}.authorityDigest`),
    authorityReceiptDigest: assertDigest(value.authorityReceiptDigest, `${label}.authorityReceiptDigest`),
    admissionStateRootDigest: assertDigest(value.admissionStateRootDigest, `${label}.admissionStateRootDigest`),
    admissionStorageScopeDigest: assertDigest(value.admissionStorageScopeDigest, `${label}.admissionStorageScopeDigest`),
    runtimeScopeDigest: assertDigest(value.runtimeScopeDigest, `${label}.runtimeScopeDigest`),
    sourceRegistrySequence: value.sourceRegistrySequence,
    sourceRegistryStateDigest: assertDigest(value.sourceRegistryStateDigest, `${label}.sourceRegistryStateDigest`)
  };
  if (!Number.isSafeInteger(seed.sourceRegistrySequence) || seed.sourceRegistrySequence < 0) {
    throw new Error(`${label}.sourceRegistrySequence is invalid`);
  }
  return seed;
}

function validateRecoveryHandoffChildren(value, runId) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length === 0 || value.length > 256) {
    throw new Error("recovery handoff children are invalid");
  }
  const controllers = new Set();
  const controllerIds = new Set();
  const executions = new Set();
  const attempts = new Set();
  const admissionIds = new Set();
  const admissions = new Set();
  const reservations = new Set();
  const normalized = value.map((child, index) => {
    const label = `recovery handoff children[${index}]`;
    assertOwnDataObject(child, label);
    exactKeys(child, ["taskId", "binding", "controller", "admission", "priorHandleId"], label);
    const taskId = assertId(child.taskId, `${label}.taskId`);
    const binding = bindingFromInput(child.binding, { label: `${label}.binding` });
    if (binding.runId !== runId || !binding.ownedResourceId) throw new Error(`${label}.binding is outside the run or resource scope`);
    const controller = validateController(child.controller);
    if (typeof controller.readExecutionBinding !== "function") {
      throw recoveryHandoffFailure("EADMISSION_HOLD", `${label}.controller lacks one atomic execution-binding read`);
    }
    if (controllers.has(controller) || controllerIds.has(controller.controllerId)) {
      throw new Error("recovery handoff requires one exact controller identity per child");
    }
    controllers.add(controller);
    controllerIds.add(controller.controllerId);
    const admission = validateExecutionAdmission(child.admission);
    for (const key of [
      "runId", "executionId", "attemptId", "unitId", "ownedResourceId",
      "sourceBindingDigest", "policyDigest", "revision"
    ]) {
      if (admission[key] !== binding[key]) throw new Error(`${label}.admission.${key} is not bound`);
    }
    if (admission.taskId !== taskId) throw new Error(`${label}.admission.taskId is not bound`);
    const admissionDigest = digestExecutionAdmission(admission);
    const reservation = reservationKey(admission);
    if (executions.has(binding.executionId) || attempts.has(binding.attemptId) ||
        admissionIds.has(admission.admissionId) ||
        admissions.has(admissionDigest) || reservations.has(reservation)) {
      throw new Error("recovery handoff children reuse an execution, attempt, admission, or reservation identity");
    }
    executions.add(binding.executionId);
    attempts.add(binding.attemptId);
    admissionIds.add(admission.admissionId);
    admissions.add(admissionDigest);
    reservations.add(reservation);
    return {
      taskId,
      binding: clone(binding),
      controller,
      controllerId: controller.controllerId,
      admission: clone(admission),
      admissionDigest,
      reservationKey: reservation,
      priorHandleId: child.priorHandleId === null ? null : assertId(child.priorHandleId, `${label}.priorHandleId`)
    };
  });
  if (new Set(normalized.map((child) => child.taskId)).size !== normalized.length ||
      normalized.some((child, index) => index > 0 && child.taskId < normalized[index - 1].taskId)) {
    throw new Error("recovery handoff children must be unique and sorted by taskId");
  }
  return normalized;
}

function validateRecoveryClaimCheckpoint(value) {
  const label = "recovery handoff claim checkpoint";
  assertOwnDataObject(value, label);
  exactKeys(value, [
    "recoveryPlanDigest", "planId", "planDigest", "contractDigest",
    "preparedCheckpointSequence", "preparedCheckpointStateDigest",
    "preparedEventSequence", "preparedEventDigest"
  ], label);
  const checkpoint = {
    recoveryPlanDigest: assertDigest(value.recoveryPlanDigest, `${label}.recoveryPlanDigest`),
    planId: assertId(value.planId, `${label}.planId`),
    planDigest: assertDigest(value.planDigest, `${label}.planDigest`),
    contractDigest: assertDigest(value.contractDigest, `${label}.contractDigest`),
    preparedCheckpointSequence: value.preparedCheckpointSequence,
    preparedCheckpointStateDigest: assertDigest(value.preparedCheckpointStateDigest, `${label}.preparedCheckpointStateDigest`),
    preparedEventSequence: value.preparedEventSequence,
    preparedEventDigest: assertDigest(value.preparedEventDigest, `${label}.preparedEventDigest`)
  };
  for (const key of ["preparedCheckpointSequence", "preparedEventSequence"]) {
    if (!Number.isSafeInteger(checkpoint[key]) || checkpoint[key] < 1) throw new Error(`${label}.${key} is invalid`);
  }
  if (checkpoint.preparedEventSequence !== checkpoint.preparedCheckpointSequence) {
    throw new Error(`${label} event and checkpoint sequence must match`);
  }
  return checkpoint;
}

function validateRecoveryTaskReleaseCheckpoint(value) {
  const label = "recovery task release checkpoint";
  assertOwnDataObject(value, label);
  exactKeys(value, [
    "checkpointSequence", "checkpointStateDigest", "taskStateDigest", "dependencies"
  ], label);
  if (!Number.isSafeInteger(value.checkpointSequence) || value.checkpointSequence < 1) {
    throw new Error(`${label}.checkpointSequence is invalid`);
  }
  if (!Array.isArray(value.dependencies) || utilTypes.isProxy(value.dependencies) || value.dependencies.length > 256) {
    throw new Error(`${label}.dependencies is invalid`);
  }
  const dependencies = value.dependencies.map((entry, index) => {
    const entryLabel = `${label}.dependencies[${index}]`;
    assertOwnDataObject(entry, entryLabel);
    exactKeys(entry, ["taskId", "status", "stateDigest"], entryLabel);
    if (entry.status !== "succeeded") throw new Error(`${entryLabel}.status must be succeeded`);
    return {
      taskId: assertId(entry.taskId, `${entryLabel}.taskId`),
      status: "succeeded",
      stateDigest: assertDigest(entry.stateDigest, `${entryLabel}.stateDigest`)
    };
  });
  if (new Set(dependencies.map((entry) => entry.taskId)).size !== dependencies.length ||
      dependencies.some((entry, index) => index > 0 && entry.taskId < dependencies[index - 1].taskId)) {
    throw new Error(`${label}.dependencies must be unique and sorted`);
  }
  return {
    checkpointSequence: value.checkpointSequence,
    checkpointStateDigest: assertDigest(value.checkpointStateDigest, `${label}.checkpointStateDigest`),
    taskStateDigest: assertDigest(value.taskStateDigest, `${label}.taskStateDigest`),
    dependencies,
    dependencyStateDigest: digestObject(dependencies)
  };
}

async function openExecutionRegistryInternal({
  stateRoot,
  runId,
  controller,
  resourceAdapter = null,
  clock = undefined,
  registryRoot = undefined,
  journalWriter = undefined
} = {}, { observationOnly = false } = {}) {
  const trustedController = validateController(controller);
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)) throw new Error("stateRoot must be an absolute path");
  // Keep the platform boundary ahead of every state-root filesystem read.
  // In particular, Windows must not reach POSIX symlink/mode inspection.
  assertPrivateStateBackendAvailableV1();
  const stateRootInfo = await lstat(stateRoot).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stateRootInfo?.isSymbolicLink()) throw new Error("stateRoot must not be a symlink");
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) throw new Error("runId is invalid");
  if (resourceAdapter !== null && !isTrustedOwnedResourceAdapter(resourceAdapter)) {
    throw new Error("resourceAdapter must be created by createOwnedResourceAdapter");
  }
  const safeClockValue = safeClock(clock);
  const root = path.resolve(registryRoot ?? safeJoin(path.resolve(stateRoot), RUNTIME_DIRECTORY));
  const runDir = safeJoin(root, "runs", runId);
  const registryPath = safeJoin(runDir, "registry.json");
  const writer = journalWriter ?? appendJournal;
  if (typeof writer !== "function") throw new Error("journalWriter must be callable");
  if (observationOnly) {
    await assertReadOnlyDirectory(root, root, "execution registry root");
    await assertReadOnlyDirectory(root, safeJoin(root, "runs"), "execution registry runs directory");
    await assertReadOnlyDirectory(root, runDir, "execution registry run directory");
  } else {
    await ensureDirectory(root, runId);
  }
  const openedStateRootIdentity = await readDirectoryIdentity(path.resolve(stateRoot), "stateRoot");
  const openedRuntimeRootIdentity = await readDirectoryIdentity(root, "execution registry root");
  let lastAdmissionLedger = new Map();
  let lastRecoveryHandoffs = new Map();
  let lastRecoveryClaims = new Map();
  let lastRecoveryTaskReleases = new Map();
  let lastRecoveryTaskPermitConsumptions = new Map();
  let lastRecoveryTaskEffectIntents = new Map();
  let lastRecoveryTaskEffectLaunches = new Map();
  let lastRecoveryTaskEffectOutcomes = new Map();
  let lastRecoveryTaskEffectReconciliations = new Map();
  let lastJournalProvenance = null;

  async function readRecovered({ repair = true, onVerifiedEvent = null, returnReadback = false } = {}) {
    if (onVerifiedEvent !== null && typeof onVerifiedEvent !== "function") {
      throw new Error("Execution journal observer must be callable");
    }
    let state;
    try {
      state = validateRegistry(await (observationOnly
        ? readJsonReadOnly(root, registryPath)
        : readJson(root, registryPath)), runId);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = initialRegistry(runId);
    }
    const journalBytes = await readJournalBytes(root, runDir, { observationOnly });
    const journalProvenance = {
      relativePath: `runs/${runId}/journal.jsonl`,
      byteLength: journalBytes.byteLength,
      digest: createHash("sha256").update(journalBytes).digest("hex")
    };
    const cacheKey = replayCacheKey(root, runId);
    const cached = getValidatedReplayCache(cacheKey);
    let replayed;
    let records;
    let frames;
    let admissionSeed = null;
    let recoveryHandoffSeed = null;
    let recoveryClaimSeed = null;
    let recoveryTaskReleaseSeed = null;
    let recoveryTaskPermitConsumptionSeed = null;
    let recoveryTaskEffectIntentSeed = null;
    let recoveryTaskEffectLaunchSeed = null;
    let recoveryTaskEffectOutcomeSeed = null;
    let recoveryTaskEffectReconciliationSeed = null;
    if (onVerifiedEvent === null && cached && cachePrefixMatches(cached, journalBytes)) {
      frames = parseJournalFrames(journalBytes, cached.byteLength);
      records = frames.map((frame) => frame.record);
      replayed = clone(cached.state);
      const seededByHandle = new Map(Object.entries(cached.admissions ?? {}).map(([id, admission]) => [id, validateExecutionAdmission(admission)]));
      admissionSeed = { byHandle: seededByHandle };
      recoveryHandoffSeed = new Map(Object.entries(cached.recoveryHandoffs ?? {}).map(([id, handoff]) => [
        id,
        validateExecutionRecoveryHandoffV1(handoff, { runId })
      ]));
      recoveryClaimSeed = new Map(Object.entries(cached.recoveryClaims ?? {}).map(([id, claim]) => [
        id,
        validateExecutionRecoveryHandoffClaimV1(claim, { runId })
      ]));
      recoveryTaskReleaseSeed = new Map(Object.entries(cached.recoveryTaskReleases ?? {}).map(([id, release]) => [
        id,
        validateExecutionRecoveryTaskReleaseV1(release, { runId })
      ]));
      recoveryTaskPermitConsumptionSeed = new Map(
        Object.entries(cached.recoveryTaskPermitConsumptions ?? {}).map(([id, consumption]) => [
          id,
          validateExecutionRecoveryTaskPermitConsumptionV1(consumption, { runId })
        ])
      );
      recoveryTaskEffectIntentSeed = new Map(
        Object.entries(cached.recoveryTaskEffectIntents ?? {}).map(([id, intent]) => [
          id,
          validateExecutionRecoveryTaskEffectIntentV1(intent, { runId })
        ])
      );
      recoveryTaskEffectLaunchSeed = new Map(
        Object.entries(cached.recoveryTaskEffectLaunches ?? {}).map(([id, launch]) => [
          id,
          validateExecutionRecoveryTaskEffectLaunchV1(launch, { runId })
        ])
      );
      recoveryTaskEffectOutcomeSeed = new Map(
        Object.entries(cached.recoveryTaskEffectOutcomes ?? {}).map(([id, outcome]) => [
          id,
          validateExecutionRecoveryTaskEffectOutcomeV1(outcome, { runId })
        ])
      );
      recoveryTaskEffectReconciliationSeed = new Map(Object.entries(cached.recoveryTaskEffectReconciliations ?? {}).map(([id, value]) => [
        id, validateExecutionRecoveryTaskEffectReconciliationV1(value, { runId, outcomeId: id })
      ]));
      for (const frame of frames) {
        assertRecoveryHandoffJournalPrefix(frame.record, journalBytes, frame.start);
        replayed = verifyEvent(frame.record, replayed, runId);
        onVerifiedEvent?.(frame.record, replayed, frame);
      }
    } else {
      frames = parseJournalFrames(journalBytes);
      records = frames.map((frame) => frame.record);
      replayed = initialRegistry(runId);
      for (const frame of frames) {
        assertRecoveryHandoffJournalPrefix(frame.record, journalBytes, frame.start);
        replayed = verifyEvent(frame.record, replayed, runId);
        onVerifiedEvent?.(frame.record, replayed, frame);
      }
    }
    const admissions = deriveAdmissionLedger(records, runId, admissionSeed);
    const recoveryHandoffs = deriveRecoveryHandoffs(records, runId, recoveryHandoffSeed);
    const recoveryAuthority = deriveRecoveryAuthorityLedger(records, runId, {
      recoveryHandoffs: recoveryHandoffSeed ?? new Map(),
      recoveryClaims: recoveryClaimSeed ?? new Map(),
      recoveryTaskReleases: recoveryTaskReleaseSeed ?? new Map(),
      recoveryTaskPermitConsumptions: recoveryTaskPermitConsumptionSeed ?? new Map(),
      recoveryTaskEffectIntents: recoveryTaskEffectIntentSeed ?? new Map(),
      recoveryTaskEffectLaunches: recoveryTaskEffectLaunchSeed ?? new Map(),
      recoveryTaskEffectOutcomes: recoveryTaskEffectOutcomeSeed ?? new Map(),
      recoveryTaskEffectReconciliations: recoveryTaskEffectReconciliationSeed ?? new Map()
    });
    if (journalBytes.length === 0 && state.sequence !== 0) throw new Error("Execution registry state has no journal provenance");
    if (state.sequence > replayed.sequence) throw new Error("Execution registry state is ahead of its journal");
    if (state.sequence === replayed.sequence && state.stateDigest !== replayed.stateDigest) throw new Error("Execution registry state diverges from journal");
    if (state.sequence < replayed.sequence && repair && !observationOnly) await atomicWriteJson(root, registryPath, replayed);
    lastAdmissionLedger = admissions;
    lastRecoveryHandoffs = recoveryHandoffs;
    lastRecoveryClaims = recoveryAuthority.recoveryClaims;
    lastRecoveryTaskReleases = recoveryAuthority.recoveryTaskReleases;
    lastRecoveryTaskPermitConsumptions = recoveryAuthority.recoveryTaskPermitConsumptions;
    lastRecoveryTaskEffectIntents = recoveryAuthority.recoveryTaskEffectIntents;
    lastRecoveryTaskEffectLaunches = recoveryAuthority.recoveryTaskEffectLaunches;
    lastRecoveryTaskEffectOutcomes = recoveryAuthority.recoveryTaskEffectOutcomes;
    lastRecoveryTaskEffectReconciliations = recoveryAuthority.recoveryTaskEffectReconciliations;
    lastJournalProvenance = journalProvenance;
    putValidatedReplayCache(
      cacheKey,
      journalBytes,
      replayed,
      admissions,
      recoveryHandoffs,
      lastRecoveryClaims,
      lastRecoveryTaskReleases,
      lastRecoveryTaskPermitConsumptions,
      lastRecoveryTaskEffectIntents,
      lastRecoveryTaskEffectLaunches,
      lastRecoveryTaskEffectOutcomes,
      lastRecoveryTaskEffectReconciliations
    );
    return returnReadback ? { state: replayed, journalProvenance } : replayed;
  }

  async function assertOpenedRootIdentities() {
    try {
      const stateIdentity = await readDirectoryIdentity(path.resolve(stateRoot), "stateRoot");
      const runtimeIdentity = await readDirectoryIdentity(root, "execution registry root");
      if (!same(stateIdentity, openedStateRootIdentity) || !same(runtimeIdentity, openedRuntimeRootIdentity)) {
        throw new Error("execution runtime root identity changed after the registry was opened");
      }
    } catch (error) {
      throw recoveryHandoffFailure(
        "EEXECUTION_RECOVERY_HANDOFF_UNKNOWN",
        `Execution runtime root identity is unresolved: ${error.message}`,
        "UNKNOWN"
      );
    }
  }

  async function persistUnlocked(previous, next, op, payload) {
    validateRegistry(previous, runId);
    validateRegistry(next, runId);
    if (next.sequence !== previous.sequence + 1) throw new Error("Execution registry CAS sequence is invalid");
    if (next.stateDigest !== registryDigest(next)) throw new Error("Execution registry next digest is invalid");
    const event = eventFor(next, previous, op, payload);
    assertEventTransition(previous, next, op, payload);
    await writer(root, runDir, JOURNAL_EVENT, event);
    await atomicWriteJson(root, registryPath, next);
    return next;
  }

  async function withRegistryLock(callback, options = {}) {
    return enqueueRuntimeCriticalSection(root, runId, () => withRunLock(root, runId, callback, options));
  }

  // The core lock is intentionally fail-fast for ordinary competing CAS
  // operations. Reads, pre-send evidence, and emergency stop may race the
  // short callback-start linearization section, so they wait briefly for that
  // section to finish rather than treating the race as a provider outcome.
  async function withRegistryLockWaiting(callback, options = {}) {
    let lastError;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      try {
        return await withRegistryLock(callback, options);
      } catch (error) {
        lastError = error;
        if (!/^Run is leased by pid /.test(String(error?.message ?? ""))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    throw lastError ?? new Error("Unable to acquire the execution registry stop lease");
  }

  async function currentFor(handle, { allowRevoked = false, intentId = null } = {}) {
    const binding = bindingForHandle(handle);
    const persistedState = await readRecovered();
    const persistedHandle = persistedState.handles[handle.handleId];
    if (!persistedHandle) throw new Error("Execution handle is no longer present");
    if (!allowRevoked && (persistedHandle.dispatchBlocked || ["revoked", "stopped", "indeterminate"].includes(persistedHandle.status))) {
      throw new Error("Execution handle is revoked or dispatch-blocked");
    }
    if (intentId !== null) {
      const persistedIntent = persistedState.intents[intentId];
      if (!persistedIntent || persistedIntent.handleId !== handle.handleId || persistedIntent.status !== "dispatching" || persistedIntent.dispatchReserved !== true) {
        throw new Error("Execution intent is no longer dispatchable");
      }
    }
    const persistedAdmission = lastAdmissionLedger.get(handle.handleId) ?? null;
    const fresh = await readFreshControllerBinding(trustedController, binding, { clock: safeClockValue });
    return assertFreshBindingForHandle(handle, fresh, persistedAdmission, { allowRevoked });
  }

  async function reconcilePendingInLock(state, { controllerStopped = false } = {}) {
    if (!controllerStopped) return state;
    if (typeof trustedController.readControllerLifecycle !== "function") {
      throw new Error("Pending execution reconciliation requires a controller lifecycle observation");
    }
    let current = state;
    for (const intent of Object.values(state.intents)) {
      if (intent.status !== "dispatching" || intent.dispatchReserved !== true) continue;
      if (!intent.controllerIncarnation || !intent.ownerLeaseId) {
        throw new Error("Pending intent lacks controller incarnation and owner lease; reconciliation is HOLD");
      }
      const lifecycle = validateControllerLifecycle(
        await trustedController.readControllerLifecycle({ runId }),
        runId
      );
      if (lifecycle.status !== "terminated" || lifecycle.previousIncarnation !== intent.controllerIncarnation || lifecycle.previousOwnerLeaseId !== intent.ownerLeaseId) {
        throw new Error("Controller owner lease has not been observed terminated; pending effect remains live");
      }
      const nextIntent = {
        ...intent,
        status: "unknown",
        outcome: "unknown",
        sealedAt: nowIso(safeClockValue),
        unknownReason: "controller-restart-before-seal",
        lateCallback: true,
        callbackCalls: 0,
        dispatchReserved: true,
        notSentAt: null,
        notSentReason: null
      };
      const handle = current.handles[intent.handleId];
      if (!handle) throw new Error("Execution intent references a missing handle");
      const nextHandle = { ...handle, status: "indeterminate", dispatchBlocked: true };
      current = withRegistryDigest({
        ...current,
        sequence: current.sequence + 1,
        handles: { ...current.handles, [handle.handleId]: nextHandle },
        intents: { ...current.intents, [intent.intentId]: nextIntent }
      });
      current = await persistUnlocked(state, current, "intent.recovered-unknown", {
        intentId: intent.intentId,
        handleId: intent.handleId,
        reason: nextIntent.unknownReason
      });
      state = current;
    }
    return current;
  }

  async function load({ reconcile = false } = {}) {
    return withRegistryLockWaiting(async () => {
      let state = await readRecovered();
      if (reconcile) state = await reconcilePendingInLock(state, { controllerStopped: true });
      const admissions = lastAdmissionLedger;
      return clone({ ...state, admissions: Object.fromEntries(admissions) });
    });
  }

  async function reconcileAfterControllerStop() {
    return withRegistryLock(async () => clone(await reconcilePendingInLock(await readRecovered(), { controllerStopped: true })));
  }

  async function persistNotSent(intent, handleId) {
    return withRegistryLockWaiting(async () => {
      const state = await readRecovered();
      const currentIntent = state.intents[intent.intentId];
      const handle = state.handles[handleId];
      // A stop changes the handle lifecycle, not whether this live execute()
      // invocation entered its callback. Only the exact reserved intent can
      // become not-sent, and stopped/revoked handles keep their dispatch fence.
      // Recovered UNKNOWN intents and post-callback outcomes never qualify.
      if (!currentIntent || !handle || currentIntent.handleId !== handleId ||
          currentIntent.status !== "dispatching" || currentIntent.callbackCalls !== 0 ||
          currentIntent.dispatchReserved !== true || !semanticSame(currentIntent, intent) ||
          !["dispatching", "revoked", "stopped", "indeterminate"].includes(handle.status) ||
          handle.dispatchBlocked !== (handle.status !== "dispatching")) return false;
      const nextIntent = {
        ...currentIntent,
        status: "not-sent",
        callbackCalls: 0,
        dispatchReserved: false,
        notSentAt: nowIso(safeClockValue),
        notSentReason: NOT_SENT_REASON,
        sealedAt: null,
        outcome: null,
        effectDigest: null,
        unknownReason: null,
        lateCallback: false
      };
      const nextHandle = handle.status === "dispatching"
        ? { ...handle, status: "ready", dispatchBlocked: false }
        : handle;
      const next = withRegistryDigest({
        ...state,
        sequence: state.sequence + 1,
        handles: { ...state.handles, [handleId]: nextHandle },
        intents: { ...state.intents, [intent.intentId]: nextIntent }
      });
      await persistUnlocked(state, next, "intent.not-sent", {
        intentId: intent.intentId,
        handleId,
        reason: NOT_SENT_REASON
      });
      return Object.freeze({
        schemaVersion: 1,
        kind: EXECUTION_EFFECT_NOT_SENT_KIND,
        runId,
        handleId,
        intentId: currentIntent.intentId,
        ownedResourceId: handle.ownedResourceId,
        status: nextIntent.status,
        callbackCalls: nextIntent.callbackCalls,
        dispatchReserved: nextIntent.dispatchReserved,
        notSentAt: nextIntent.notSentAt,
        notSentReason: nextIntent.notSentReason,
        stateSequence: next.sequence,
        stateDigest: next.stateDigest
      });
    });
  }

  async function reconcileUnknownExecution(handleId, {
    expectedSequence = undefined,
    timeoutMs = RECONCILE_QUERY_WAIT_MS,
    abortSignal = undefined
  } = {}) {
    assertId(handleId, "reconcile.handleId");
    if (expectedSequence !== undefined && (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0)) {
      throw new Error("reconcile.expectedSequence is invalid");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 60_000) {
      throw new Error("reconcile.timeoutMs is invalid");
    }
    const callerAbortSignal = validateAbortSignal(abortSignal, "reconcile.abortSignal");
    if (!resourceAdapter || typeof resourceAdapter.queryOwned !== "function") {
      const unavailable = new Error("UNKNOWN execution requires a trusted owned-resource query adapter");
      unavailable.code = "EEXECUTION_RECONCILE_UNAVAILABLE";
      unavailable.status = "UNKNOWN";
      throw unavailable;
    }

    const snapshot = await withRegistryLock(async () => {
      const state = await readRecovered();
      if (expectedSequence !== undefined && state.sequence !== expectedSequence) {
        throw new Error("Execution registry expected sequence mismatch");
      }
      const handle = state.handles[handleId];
      if (!handle) throw new Error("Execution handle was not found");
      const intent = Object.values(state.intents).find((item) => item.handleId === handleId && item.status === "unknown");
      if (!intent) {
        const unavailable = new Error("Execution handle has no UNKNOWN intent to reconcile");
        unavailable.code = "EEXECUTION_RECONCILE_NOT_UNKNOWN";
        unavailable.status = "HOLD";
        throw unavailable;
      }
      if (!["indeterminate", "stopped", "revoked"].includes(handle.status) || handle.dispatchBlocked !== true) {
        const invalid = new Error("Execution UNKNOWN intent is not bound to a dispatch-blocked handle");
        invalid.code = "EEXECUTION_RECONCILE_BINDING";
        invalid.status = "HOLD";
        throw invalid;
      }
      return {
        sequence: state.sequence,
        handle: clone(handle),
        intent: clone(intent)
      };
    });

    let rawObservation;
    const queryAbortController = new AbortController();
    let timeout = null;
    let onCallerAbort = null;
    try {
      if (callerAbortSignal?.aborted) {
        const cancelled = new Error("UNKNOWN execution reconciliation was aborted before provider observation");
        cancelled.code = "EEXECUTION_RECONCILE_ABORTED";
        cancelled.status = "UNKNOWN";
        throw cancelled;
      }
      const queryRequest = {
        request: {
          runId,
          handleId: snapshot.handle.handleId,
          intentId: snapshot.intent.intentId,
          executionId: snapshot.handle.executionId,
          attemptId: snapshot.handle.attemptId,
          unitId: snapshot.handle.unitId,
          sourceBindingDigest: snapshot.handle.sourceBindingDigest,
          policyDigest: snapshot.handle.policyDigest,
          revision: snapshot.handle.revision,
          authorityEpoch: snapshot.handle.authorityEpoch,
          fence: snapshot.handle.fence,
          ownedResourceId: snapshot.handle.ownedResourceId
        },
        scope: {
          runId,
          handleId: snapshot.handle.handleId,
          intentId: snapshot.intent.intentId,
          ownedResourceId: snapshot.handle.ownedResourceId
        }
      };
      const queryPromise = resourceAdapter.queryOwned(queryRequest, { signal: queryAbortController.signal });
      queryPromise.catch(() => {});
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const expired = new Error("Trusted owned-resource reconciliation exceeded its bounded query deadline");
          expired.code = "EEXECUTION_RECONCILE_TIMEOUT";
          expired.status = "UNKNOWN";
          reject(expired);
        }, timeoutMs);
      });
      const callerCancellation = callerAbortSignal
        ? new Promise((_, reject) => {
          onCallerAbort = () => {
            const cancelled = new Error("UNKNOWN execution reconciliation was aborted");
            cancelled.code = "EEXECUTION_RECONCILE_ABORTED";
            cancelled.status = "UNKNOWN";
            reject(cancelled);
          };
          callerAbortSignal.addEventListener("abort", onCallerAbort, { once: true });
        })
        : null;
      rawObservation = await Promise.race([queryPromise, deadline, ...(callerCancellation ? [callerCancellation] : [])]);
    } catch (error) {
      queryAbortController.abort();
      const failed = new Error(`Trusted owned-resource reconciliation failed: ${String(error?.message ?? error)}`);
      failed.code = error?.code ?? "EEXECUTION_RECONCILE_QUERY";
      failed.status = "UNKNOWN";
      failed.cause = error;
      throw failed;
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      if (callerAbortSignal && onCallerAbort) callerAbortSignal.removeEventListener("abort", onCallerAbort);
    }

    let observation;
    try {
      observation = validateExecutionResourceObservation(rawObservation, {
        runId,
        handleId: snapshot.handle.handleId,
        intentId: snapshot.intent.intentId,
        executionId: snapshot.handle.executionId,
        attemptId: snapshot.handle.attemptId,
        unitId: snapshot.handle.unitId,
        sourceBindingDigest: snapshot.handle.sourceBindingDigest,
        policyDigest: snapshot.handle.policyDigest,
        revision: snapshot.handle.revision,
        authorityEpoch: snapshot.handle.authorityEpoch,
        fence: snapshot.handle.fence,
        ownedResourceId: snapshot.handle.ownedResourceId
      }, "trusted execution resource observation");
    } catch (error) {
      const invalid = new Error(`Trusted owned-resource reconciliation returned invalid evidence: ${String(error?.message ?? error)}`);
      invalid.code = "EEXECUTION_RECONCILE_INVALID";
      invalid.status = "UNKNOWN";
      invalid.cause = error;
      throw invalid;
    }

    try {
      const currentSource = await trustedController.readSourceBinding({ runId });
      validateSourceBinding(currentSource, snapshot.handle, "fresh reconciliation source binding");
    } catch (error) {
      const stale = new Error(`Execution source binding changed during UNKNOWN reconciliation: ${String(error?.message ?? error)}`);
      stale.code = "EEXECUTION_RECONCILE_SOURCE_DRIFT";
      stale.status = "UNKNOWN";
      stale.cause = error;
      throw stale;
    }

    // Only a pinned not-sent observation can release the reservation for a
    // retry.  Provider completion records a terminal effect fact instead;
    // it never turns into a retry or a business PASS by itself.
    const decision = observation.controllerStatus === "terminated" &&
      observation.providerOutcome === "not-sent" && observation.businessOutcome === null
      ? "retryable"
      : observation.controllerStatus !== "active" && observation.providerOutcome === "completed"
        ? "completed"
        : "hold";
    const reconciliation = {
      schemaVersion: 1,
      kind: EXECUTION_RECONCILIATION_KIND,
      reconciliationId: randomUUID(),
      intentId: snapshot.intent.intentId,
      handleId: snapshot.handle.handleId,
      runId,
      decision,
      observation,
      reconciledAt: nowIso(safeClockValue),
      reconciliationDigest: null
    };
    reconciliation.reconciliationDigest = digestObject({
      schemaVersion: reconciliation.schemaVersion,
      kind: reconciliation.kind,
      reconciliationId: reconciliation.reconciliationId,
      intentId: reconciliation.intentId,
      handleId: reconciliation.handleId,
      runId: reconciliation.runId,
      decision: reconciliation.decision,
      observation: reconciliation.observation,
      reconciledAt: reconciliation.reconciledAt
    });
    validateExecutionReconciliation(reconciliation, {
      runId,
      handleId: snapshot.handle.handleId,
      intentId: snapshot.intent.intentId,
      executionId: snapshot.handle.executionId,
      attemptId: snapshot.handle.attemptId,
      unitId: snapshot.handle.unitId,
      sourceBindingDigest: snapshot.handle.sourceBindingDigest,
      policyDigest: snapshot.handle.policyDigest,
      revision: snapshot.handle.revision,
      authorityEpoch: snapshot.handle.authorityEpoch,
      fence: snapshot.handle.fence,
      ownedResourceId: snapshot.handle.ownedResourceId
    });

    return withRegistryLock(async () => {
      const state = await readRecovered();
      if (state.sequence !== snapshot.sequence) {
        const raced = new Error("Execution state changed while UNKNOWN reconciliation was being observed");
        raced.code = "EEXECUTION_RECONCILE_RACE";
        raced.status = "UNKNOWN";
        throw raced;
      }
      const handle = state.handles[handleId];
      const intent = state.intents[snapshot.intent.intentId];
      if (!handle || !intent || !same(handle, snapshot.handle) || !same(intent, snapshot.intent) ||
          intent.status !== "unknown") {
        const raced = new Error("Execution UNKNOWN intent changed before reconciliation could be sealed");
        raced.code = "EEXECUTION_RECONCILE_RACE";
        raced.status = "UNKNOWN";
        throw raced;
      }
      const nextIntent = {
        ...intent,
        reconciliation: [...(Array.isArray(intent.reconciliation) ? intent.reconciliation : []), reconciliation]
      };
      const next = withRegistryDigest({
        ...state,
        sequence: state.sequence + 1,
        intents: { ...state.intents, [intent.intentId]: nextIntent }
      });
      await persistUnlocked(state, next, "intent.reconciled", {
        handleId,
        intentId: intent.intentId,
        reconciliation
      });
      return {
        reconciliation: clone(reconciliation),
        reconciliations: clone(nextIntent.reconciliation),
        handle: clone(handle),
        intent: clone(nextIntent)
      };
    });
  }

  async function recordOwnedCleanupResolution(handleId, controllerResolution, producerController) {
    assertId(handleId, "recordOwnedCleanupResolution.handleId");
    if (producerController !== trustedController) {
      const rejected = new Error("owned cleanup resolution requires this registry's trusted controller");
      rejected.code = "EEXECUTION_CLEANUP_RESOLUTION_UNAVAILABLE";
      rejected.status = "HOLD";
      throw rejected;
    }
    if (!isPlainObject(controllerResolution) || controllerResolution.status !== "cleanup-confirmed" ||
        controllerResolution.effectStarted !== true || controllerResolution.launchRequested !== true ||
        controllerResolution.groupTerminated !== true || controllerResolution.lateLaunchBlocked !== true ||
        controllerResolution.noSendProof !== null) {
      const invalid = new Error("owned cleanup resolution is not a confirmed effect-boundary result");
      invalid.code = "EEXECUTION_CLEANUP_RESOLUTION_INVALID";
      invalid.status = "HOLD";
      throw invalid;
    }
    const controllerResolutionBody = Object.fromEntries(
      Object.entries(controllerResolution).filter(([key]) => key !== "digest")
    );
    if (typeof controllerResolution.digest !== "string" || digestObject(controllerResolutionBody) !== controllerResolution.digest) {
      const invalid = new Error("owned cleanup resolution digest is not bound");
      invalid.code = "EEXECUTION_CLEANUP_RESOLUTION_INVALID";
      invalid.status = "HOLD";
      throw invalid;
    }
    return withRegistryLockWaiting(async () => {
      const state = await readRecovered();
      const handle = state.handles[handleId];
      const intent = findIntentForHandle(state, handleId);
      if (!handle || !intent || intent.status !== "unknown" || handle.status !== "indeterminate" ||
          handle.dispatchBlocked !== true) {
        const blocked = new Error("owned cleanup resolution requires an unresolved indeterminate execution");
        blocked.code = "EEXECUTION_CLEANUP_RESOLUTION_HOLD";
        blocked.status = "HOLD";
        throw blocked;
      }
      if (intent.cleanupResolution !== undefined) {
        if (!semanticSame(intent.cleanupResolution.controllerResolutionDigest, controllerResolution.digest)) {
          const conflict = new Error("owned cleanup resolution conflicts with the durable lifecycle marker");
          conflict.code = "EEXECUTION_CLEANUP_RESOLUTION_REPLAY";
          conflict.status = "HOLD";
          throw conflict;
        }
        return clone(intent.cleanupResolution);
      }
      const binding = bindingForHandle(handle);
      if (controllerResolution.runId !== binding.runId || controllerResolution.executionId !== binding.executionId ||
          controllerResolution.attemptId !== binding.attemptId || controllerResolution.unitId !== binding.unitId ||
          controllerResolution.ownedResourceId !== binding.ownedResourceId ||
          controllerResolution.sourceBindingDigest !== binding.sourceBindingDigest ||
          controllerResolution.policyDigest !== binding.policyDigest || controllerResolution.revision !== binding.revision ||
          controllerResolution.authorityEpoch !== handle.authorityEpoch || controllerResolution.fence !== handle.fence) {
        const stale = new Error("owned cleanup resolution is not bound to the registry execution");
        stale.code = "EEXECUTION_CLEANUP_RESOLUTION_STALE";
        stale.status = "HOLD";
        throw stale;
      }
      let attested;
      try {
        attested = await trustedController.readExecutionBinding({ runId, binding: clone(binding) });
      } catch (error) {
        const held = new Error("trusted controller could not re-attest the owned cleanup resolution");
        held.code = "EEXECUTION_CLEANUP_RESOLUTION_HOLD";
        held.status = "HOLD";
        held.cause = error;
        throw held;
      }
      if (!semanticSame(attested?.launchResolution, controllerResolution)) {
        const stale = new Error("owned cleanup resolution is not the controller's current durable resolution");
        stale.code = "EEXECUTION_CLEANUP_RESOLUTION_STALE";
        stale.status = "HOLD";
        throw stale;
      }
      const body = {
        schemaVersion: 1,
        kind: EXECUTION_OWNED_CLEANUP_RESOLUTION_KIND,
        status: "cleanup-confirmed",
        resolutionId: controllerResolution.resolutionId,
        transactionId: controllerResolution.transactionId,
        transactionDigest: controllerResolution.transactionDigest,
        runId: binding.runId,
        handleId,
        intentId: intent.intentId,
        executionId: binding.executionId,
        attemptId: binding.attemptId,
        unitId: binding.unitId,
        ownedResourceId: binding.ownedResourceId,
        sourceBindingDigest: binding.sourceBindingDigest,
        policyDigest: binding.policyDigest,
        revision: binding.revision,
        authorityEpoch: handle.authorityEpoch,
        fence: handle.fence,
        effectBindingDigest: controllerResolution.effectBindingDigest,
        allocationId: controllerResolution.allocationId,
        allocationRecordDigest: controllerResolution.allocationRecordDigest,
        cleanupDigest: controllerResolution.cleanupDigest,
        effectStarted: true,
        launchRequested: true,
        groupTerminated: true,
        lateLaunchBlocked: true,
        noSendProof: null,
        controllerResolutionDigest: controllerResolution.digest,
        observedAt: controllerResolution.observedAt
      };
      const cleanupResolution = validateExecutionOwnedCleanupResolution({ ...body, digest: digestObject(body) });
      const nextIntent = { ...intent, cleanupResolution };
      const next = withRegistryDigest({
        ...state,
        sequence: state.sequence + 1,
        intents: { ...state.intents, [intent.intentId]: nextIntent }
      });
      await persistUnlocked(state, next, "intent.cleanup-confirmed", {
        handleId,
        intentId: intent.intentId,
        cleanupResolution
      });
      return clone(cleanupResolution);
    });
  }

  function recoveryHandoffResult(state, handoff) {
    const validated = validateExecutionRecoveryHandoffV1(handoff, { runId });
    const handles = validated.entries.map((entry) => {
      const handle = state.handles[entry.handleId];
      if (!handle || digestObject(handle) !== entry.handleDigest) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_HANDOFF_UNKNOWN",
          `Durable recovery handoff handle ${entry.handleId} is missing or drifted`,
          "UNKNOWN"
        );
      }
      return clone(handle);
    });
    const recoveryPlans = validated.entries.flatMap((entry) => {
      if (entry.recoveryPlanId === null) return [];
      const plan = state.recoveryPlans[entry.recoveryPlanId];
      if (!plan) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_HANDOFF_UNKNOWN",
          `Durable recovery handoff plan ${entry.recoveryPlanId} is missing`,
          "UNKNOWN"
        );
      }
      return [clone(plan)];
    });
    return freezeDeep({
      handoff: validated,
      handles,
      recoveryPlans,
      registryHead: {
        sequence: state.sequence,
        stateDigest: state.stateDigest
      },
      journalReadback: clone(lastJournalProvenance),
      effectAuthority: clone(RECOVERY_HANDOFF_EFFECT_AUTHORITY)
    });
  }

  function recoveryClaimResult(state, claim) {
    const validated = validateExecutionRecoveryHandoffClaimV1(claim, { runId });
    return freezeDeep({
      claim: validated,
      registryHead: {
        sequence: state.sequence,
        stateDigest: state.stateDigest
      },
      journalReadback: clone(lastJournalProvenance),
      effectAuthority: clone(RECOVERY_CLAIM_EFFECT_AUTHORITY)
    });
  }

  function recoveryTaskReleaseResult(state, release) {
    const validated = validateExecutionRecoveryTaskReleaseV1(release, { runId });
    return freezeDeep({
      release: validated,
      registryHead: {
        sequence: state.sequence,
        stateDigest: state.stateDigest
      },
      journalReadback: clone(lastJournalProvenance),
      effectAuthority: clone(RECOVERY_TASK_RELEASE_EFFECT_AUTHORITY)
    });
  }

  function recoveryTaskPermitConsumptionResult(state, consumption) {
    const validated = validateExecutionRecoveryTaskPermitConsumptionV1(consumption, { runId });
    return freezeDeep({
      consumption: validated,
      registryHead: {
        sequence: state.sequence,
        stateDigest: state.stateDigest
      },
      journalReadback: clone(lastJournalProvenance),
      effectAuthority: clone(RECOVERY_TASK_PERMIT_CONSUMPTION_EFFECT_AUTHORITY)
    });
  }

  function recoveryTaskEffectIntentResult(state, intent) {
    const validated = validateExecutionRecoveryTaskEffectIntentV1(intent, { runId });
    return freezeDeep({
      intent: validated,
      registryHead: {
        sequence: state.sequence,
        stateDigest: state.stateDigest
      },
      journalReadback: clone(lastJournalProvenance),
      effectAuthority: clone(RECOVERY_TASK_EFFECT_INTENT_EFFECT_AUTHORITY)
    });
  }

  function recoveryTaskEffectLaunchResult(state, launch) {
    const validated = validateExecutionRecoveryTaskEffectLaunchV1(launch, { runId });
    return freezeDeep({
      launch: validated,
      registryHead: {
        sequence: state.sequence,
        stateDigest: state.stateDigest
      },
      journalReadback: clone(lastJournalProvenance),
      effectAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_EFFECT_AUTHORITY),
      settlementAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_SETTLEMENT_AUTHORITY)
    });
  }

  function recoveryTaskEffectOutcomeResult(state, outcome) {
    const validated = validateExecutionRecoveryTaskEffectOutcomeV1(outcome, { runId });
    return freezeDeep({
      outcome: validated,
      registryHead: {
        sequence: state.sequence,
        stateDigest: state.stateDigest
      },
      journalReadback: clone(lastJournalProvenance),
      effectAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_EFFECT_AUTHORITY),
      settlementAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_SETTLEMENT_AUTHORITY)
    });
  }

  async function persistRecoveryAuthorityRecord({
    state,
    next,
    op,
    payload,
    record,
    recordDigest,
    readbackDigest = undefined,
    lookup,
    code,
    label
  }) {
    let persistError = null;
    try {
      await assertOpenedRootIdentities();
      await persistUnlocked(state, next, op, payload);
    } catch (error) {
      persistError = error;
    }
    let readback = null;
    let persisted = null;
    try {
      readback = await readRecovered();
      persisted = lookup();
    } catch (error) {
      throw recoveryHandoffFailure(
        code,
        `${label} durable readback is unresolved: ${error.message}`,
        "UNKNOWN",
        { record: clone(record), ...(persistError ? { persistError: persistError.message } : {}) }
      );
    }
    const persistedDigest = typeof readbackDigest === "function"
      ? readbackDigest(persisted)
      : Object.hasOwn(record, "consumptionDigest")
        ? persisted?.consumptionDigest ?? null
        : Object.hasOwn(record, "releaseDigest")
          ? persisted?.releaseDigest ?? null
          : persisted?.claimDigest ?? null;
    if (!persisted || persistedDigest !== recordDigest ||
        readback.sequence !== next.sequence || readback.stateDigest !== next.stateDigest) {
      throw recoveryHandoffFailure(
        code,
        persistError
          ? `${label} durable commit is unresolved: ${persistError.message}`
          : `${label} durable readback does not match the committed journal event`,
        "UNKNOWN",
        { record: clone(record) }
      );
    }
    return { readback, persisted };
  }

  function assertExactRecoveryHandoffReplay(seed, children, state, handoff) {
    const expectedFields = [
      "handoffId", "recoveryId", "batchDigest", "recoveryPlanDigest", "authorityDigest",
      "authorityReceiptDigest", "admissionStateRootDigest", "admissionStorageScopeDigest",
      "runtimeScopeDigest", "sourceRegistrySequence", "sourceRegistryStateDigest"
    ];
    for (const key of expectedFields) {
      if (handoff[key] !== seed[key]) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_HANDOFF_REPLAY",
          `Recovery handoff ${seed.handoffId} is already bound to different ${key}`
        );
      }
    }
    if (children.length !== handoff.entries.length || children.some((child, index) => {
      const marker = handoff.entries[index];
      const handle = state.handles[marker.handleId];
      return marker.taskId !== child.taskId || marker.controllerId !== child.controllerId ||
        marker.priorHandleId !== child.priorHandleId || marker.executionId !== child.binding.executionId ||
        marker.attemptId !== child.binding.attemptId || marker.unitId !== child.binding.unitId ||
        marker.ownedResourceId !== child.binding.ownedResourceId || marker.bindingDigest !== digestObject(child.binding) ||
        marker.admissionDigest !== child.admissionDigest || marker.reservationKey !== child.reservationKey ||
        !handle || marker.logicalObligationDigest !== handle.obligationKey || marker.handleDigest !== digestObject(handle);
    })) {
      throw recoveryHandoffFailure(
        "EEXECUTION_RECOVERY_HANDOFF_REPLAY",
        `Recovery handoff ${seed.handoffId} replay does not exactly match its durable child set`
      );
    }
    return recoveryHandoffResult(state, handoff);
  }

  async function commitRecoveryHandoffBatch(request = {}) {
    assertOwnDataObject(request, "commitRecoveryHandoffBatch request");
    exactKeys(request, ["seed", "children"], "commitRecoveryHandoffBatch request");
    const seed = validateRecoveryHandoffSeed(request.seed, runId);
    const children = validateRecoveryHandoffChildren(request.children, runId);

    const initial = await withRegistryLock(async () => {
      await assertOpenedRootIdentities();
      const state = await readRecovered();
      const existing = lastRecoveryHandoffs.get(seed.handoffId) ?? null;
      if (existing) {
        return { replay: assertExactRecoveryHandoffReplay(seed, children, state, existing) };
      }
      if (state.sequence !== seed.sourceRegistrySequence || state.stateDigest !== seed.sourceRegistryStateDigest) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_HANDOFF_HEAD",
          "Execution registry journal head changed before the recovery handoff freshness observation"
        );
      }
      return { replay: null };
    });
    if (initial.replay !== null) return initial.replay;

    // Controller reads are potentially remote and unbounded.  Observe every
    // child before acquiring the short-lived filesystem lease, then repeat the
    // registry-head CAS under that lease.  This prevents a slow controller
    // from allowing the lease to expire while a journal append is in flight.
    const freshBindings = [];
    for (const child of children) {
      try {
        const fresh = await readFreshControllerBinding(child.controller, child.binding, { clock: safeClockValue });
        assertNativeV3AutoCommandExecutionAllowed(fresh.runContract.plan);
        if (!fresh.admission) throw new Error("current controller did not return a V3 admission");
        assertSameExecutionAdmission(child.admission, fresh.admission);
        freshBindings.push(fresh);
      } catch (error) {
        throw recoveryHandoffFailure(
          error?.status === "UNKNOWN" ? "EEXECUTION_RECOVERY_HANDOFF_UNKNOWN" : "EEXECUTION_RECOVERY_HANDOFF_FRESHNESS",
          `Recovery handoff child ${child.taskId} is not current: ${error.message}`,
          error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
        );
      }
    }
    const committedAt = nowIso(safeClockValue);
    const commitClock = Object.freeze({ now: () => committedAt });

    return withRegistryLock(async () => {
      await assertOpenedRootIdentities();
      const state = await readRecovered();
      const existing = lastRecoveryHandoffs.get(seed.handoffId) ?? null;
      if (existing) return assertExactRecoveryHandoffReplay(seed, children, state, existing);
      if (state.sequence !== seed.sourceRegistrySequence || state.stateDigest !== seed.sourceRegistryStateDigest) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_HANDOFF_HEAD",
          "Execution registry journal head changed before the recovery handoff CAS"
        );
      }
      if (!lastJournalProvenance) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_HANDOFF_UNKNOWN",
          "Execution journal provenance is unavailable",
          "UNKNOWN"
        );
      }
      const priorAdmissionIds = new Set([...lastAdmissionLedger.values()].map((admission) => admission.admissionId));
      const priorReservations = new Set([...lastAdmissionLedger.values()].map((admission) => reservationKey(admission)));
      const priorExecutions = new Set(Object.values(state.handles).map((handle) => handle.executionId));
      const priorAttempts = new Set(Object.values(state.handles).map((handle) => handle.attemptId));
      const built = [];
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        const fresh = freshBindings[index];
        if (priorAdmissionIds.has(child.admission.admissionId) || priorReservations.has(child.reservationKey) ||
            priorExecutions.has(child.binding.executionId) || priorAttempts.has(child.binding.attemptId)) {
          throw recoveryHandoffFailure(
            "EEXECUTION_RECOVERY_HANDOFF_REPLAY",
            `Recovery handoff child ${child.taskId} reuses a durable runtime identity`
          );
        }
        let origin = null;
        let recoveryPlan = null;
        if (child.priorHandleId === null) {
          const obligation = computeObligationKey(child.binding);
          if (Object.values(state.handles).some((handle) => handle.obligationKey === obligation)) {
            throw recoveryHandoffFailure(
              "EEXECUTION_RECOVERY_HANDOFF_REPLAY",
              `Recovery handoff child ${child.taskId} logical obligation is already reserved`
            );
          }
        } else {
          const oldHandle = state.handles[child.priorHandleId];
          if (!oldHandle) {
            throw recoveryHandoffFailure(
              "EEXECUTION_RECOVERY_HANDOFF_BINDING",
              `Recovery handoff child ${child.taskId} source handle is missing`
            );
          }
          const oldIntent = Object.values(state.intents).find((intent) =>
            intent.handleId === oldHandle.handleId && intent.status === "not-sent"
          );
          const currentIntent = findIntentForHandle(state, oldHandle.handleId);
          const notSentResume = oldHandle.status === "ready" && oldIntent?.callbackCalls === 0 && oldIntent.dispatchReserved === false;
          if (recoveryNeedsReconciliation(oldHandle, currentIntent)) {
            throw recoveryHandoffFailure(
              "EEXECUTION_RECOVERY_HANDOFF_UNKNOWN",
              `Recovery handoff child ${child.taskId} source outcome requires reconciliation`,
              "UNKNOWN"
            );
          }
          if (!["revoked", "stopped", "failed", "indeterminate"].includes(oldHandle.status) && !notSentResume) {
            throw recoveryHandoffFailure(
              "EEXECUTION_RECOVERY_HANDOFF_BINDING",
              `Recovery handoff child ${child.taskId} source handle is not recoverable`
            );
          }
          if (Object.values(state.handles).some((handle) => handle.origin?.resumedFromHandleId === oldHandle.handleId)) {
            throw recoveryHandoffFailure(
              "EEXECUTION_RECOVERY_HANDOFF_REPLAY",
              `Recovery handoff child ${child.taskId} source already has a successor`
            );
          }
          if (computeObligationKey(child.binding) !== oldHandle.obligationKey ||
              computeExecutionScopeDigest(child.binding) !== oldHandle.executionScopeDigest ||
              child.binding.executionId === oldHandle.executionId || child.binding.attemptId === oldHandle.attemptId ||
              fresh.authority.authorityEpoch <= oldHandle.authorityEpoch || fresh.authority.fence === oldHandle.fence) {
            throw recoveryHandoffFailure(
              "EEXECUTION_RECOVERY_HANDOFF_BINDING",
              `Recovery handoff child ${child.taskId} is not a fresh successor`
            );
          }
          const oldAdmission = lastAdmissionLedger.get(oldHandle.handleId) ?? null;
          if (!oldAdmission || reservationKey(oldAdmission) === child.reservationKey ||
              oldAdmission.admissionId === child.admission.admissionId) {
            throw recoveryHandoffFailure(
              "EEXECUTION_RECOVERY_HANDOFF_REPLAY",
              `Recovery handoff child ${child.taskId} lacks a fresh predecessor-bound admission`
            );
          }
          origin = {
            runId: child.binding.runId,
            executionId: child.binding.executionId,
            attemptId: child.binding.attemptId,
            unitId: child.binding.unitId,
            sourceBindingDigest: child.binding.sourceBindingDigest,
            policyDigest: child.binding.policyDigest,
            revision: child.binding.revision,
            authorityEpoch: fresh.authority.authorityEpoch,
            fence: fresh.authority.fence,
            createdAt: nowIso(commitClock),
            resumedFromHandleId: oldHandle.handleId,
            priorAttemptId: oldHandle.attemptId
          };
        }
        const created = buildHandle(child.binding, fresh.authority, commitClock, origin, fresh.admission);
        const handle = validateHandle({ ...created, dispatchBlocked: true });
        if (child.priorHandleId !== null) {
          const oldHandle = state.handles[child.priorHandleId];
          recoveryPlan = {
            schemaVersion: 1,
            kind: RECOVERY_PLAN_KIND,
            recoveryPlanId: randomUUID(),
            fromHandleId: oldHandle.handleId,
            newHandleId: handle.handleId,
            runId,
            executionId: handle.executionId,
            unitId: oldHandle.unitId,
            priorAttemptId: oldHandle.attemptId,
            newAttemptId: handle.attemptId,
            sourceBindingDigest: oldHandle.sourceBindingDigest,
            policyDigest: oldHandle.policyDigest,
            revision: oldHandle.revision,
            oldAuthorityEpoch: oldHandle.authorityEpoch,
            newAuthorityEpoch: handle.authorityEpoch,
            oldFence: oldHandle.fence,
            newFence: handle.fence,
            reason: "incident-recovery-dag-runtime-handoff",
            status: "prepared",
            createdAt: nowIso(commitClock)
          };
          validateRecoveryPlan(recoveryPlan);
        }
        priorAdmissionIds.add(child.admission.admissionId);
        priorReservations.add(child.reservationKey);
        priorExecutions.add(child.binding.executionId);
        priorAttempts.add(child.binding.attemptId);
        built.push({ child, handle, recoveryPlan });
      }
      const next = withRegistryDigest({
        ...state,
        sequence: state.sequence + 1,
        handles: {
          ...state.handles,
          ...Object.fromEntries(built.map(({ handle }) => [handle.handleId, handle]))
        },
        recoveryPlans: {
          ...state.recoveryPlans,
          ...Object.fromEntries(built.flatMap(({ recoveryPlan }) => recoveryPlan === null ? [] : [[recoveryPlan.recoveryPlanId, recoveryPlan]]))
        }
      });
      const handoff = sealExecutionRecoveryHandoff({
        schemaVersion: 1,
        kind: EXECUTION_RECOVERY_HANDOFF_KIND,
        status: "committed",
        handoffId: seed.handoffId,
        runId,
        recoveryId: seed.recoveryId,
        batchDigest: seed.batchDigest,
        recoveryPlanDigest: seed.recoveryPlanDigest,
        authorityDigest: seed.authorityDigest,
        authorityReceiptDigest: seed.authorityReceiptDigest,
        admissionStateRootDigest: seed.admissionStateRootDigest,
        admissionStorageScopeDigest: seed.admissionStorageScopeDigest,
        runtimeScopeDigest: seed.runtimeScopeDigest,
        journalRelativePath: lastJournalProvenance.relativePath,
        sourceJournalByteLength: lastJournalProvenance.byteLength,
        sourceJournalDigest: lastJournalProvenance.digest,
        sourceRegistrySequence: state.sequence,
        sourceRegistryStateDigest: state.stateDigest,
        committedRegistrySequence: next.sequence,
        committedRegistryStateDigest: next.stateDigest,
        taskIds: built.map(({ child }) => child.taskId),
        entries: built.map(({ child, handle, recoveryPlan }) => ({
          taskId: child.taskId,
          controllerId: child.controllerId,
          handleId: handle.handleId,
          priorHandleId: child.priorHandleId,
          recoveryPlanId: recoveryPlan?.recoveryPlanId ?? null,
          executionId: child.binding.executionId,
          attemptId: child.binding.attemptId,
          unitId: child.binding.unitId,
          ownedResourceId: child.binding.ownedResourceId,
          bindingDigest: digestObject(child.binding),
          logicalObligationDigest: handle.obligationKey,
          handleDigest: digestObject(handle),
          admissionDigest: child.admissionDigest,
          reservationKey: child.reservationKey
        })),
        effectAuthority: clone(RECOVERY_HANDOFF_EFFECT_AUTHORITY)
      });
      const journalEntries = built.map(({ child, handle, recoveryPlan }) => ({
        taskId: child.taskId,
        controllerId: child.controllerId,
        handleId: handle.handleId,
        priorHandleId: child.priorHandleId,
        recoveryPlanId: recoveryPlan?.recoveryPlanId ?? null,
        binding: clone(child.binding),
        admission: clone(child.admission)
      }));
      try {
        await assertOpenedRootIdentities();
        await persistUnlocked(state, next, "recovery.batch-committed", { handoff, entries: journalEntries });
      } catch (error) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_HANDOFF_UNKNOWN",
          `Recovery handoff durable commit is unresolved: ${error.message}`,
          "UNKNOWN",
          { handoff: clone(handoff) }
        );
      }
      let readback;
      try {
        readback = await readRecovered();
      } catch (error) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_HANDOFF_UNKNOWN",
          `Recovery handoff durable readback is unresolved: ${error.message}`,
          "UNKNOWN",
          { handoff: clone(handoff) }
        );
      }
      const persisted = lastRecoveryHandoffs.get(handoff.handoffId) ?? null;
      if (!persisted || persisted.handoffDigest !== handoff.handoffDigest ||
          readback.sequence !== next.sequence || readback.stateDigest !== next.stateDigest) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_HANDOFF_UNKNOWN",
          "Recovery handoff durable readback does not match the committed journal event",
          "UNKNOWN",
          { handoff: clone(handoff) }
        );
      }
      return recoveryHandoffResult(readback, persisted);
    });
  }

  // Internal durable-storage primitive.  Its returned record never grants
  // effect authority; effect-bearing consumers must use a fresh plan-bound
  // high-level receipt rather than trusting this caller-supplied checkpoint.
  async function claimRecoveryHandoff(request = {}) {
    assertOwnDataObject(request, "claimRecoveryHandoff request");
    exactKeys(request, ["handoffId", "checkpoint"], "claimRecoveryHandoff request");
    const handoffId = assertId(request.handoffId, "claimRecoveryHandoff.handoffId");
    const checkpoint = validateRecoveryClaimCheckpoint(request.checkpoint);
    return withRegistryLockWaiting(async () => {
      await assertOpenedRootIdentities();
      const state = await readRecovered();
      const handoff = lastRecoveryHandoffs.get(handoffId) ?? null;
      if (!handoff) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_CLAIM_HANDOFF",
          `Recovery handoff ${handoffId} was not found`
        );
      }
      if (checkpoint.recoveryPlanDigest !== handoff.recoveryPlanDigest) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_CLAIM_BINDING",
          `Recovery handoff ${handoffId} claim uses a different recovery plan digest`
        );
      }
      const claimId = recoveryClaimIdentity({
        runId,
        handoffId,
        handoffDigest: handoff.handoffDigest,
        ...checkpoint,
        taskIds: handoff.taskIds
      });
      const existing = [...lastRecoveryClaims.values()].find((claim) => claim.handoffId === handoffId) ?? null;
      if (existing) {
        const replayMatches = existing.claimId === claimId && existing.handoffDigest === handoff.handoffDigest &&
          existing.recoveryPlanDigest === checkpoint.recoveryPlanDigest && existing.planId === checkpoint.planId &&
          existing.planDigest === checkpoint.planDigest && existing.contractDigest === checkpoint.contractDigest &&
          existing.preparedCheckpointSequence === checkpoint.preparedCheckpointSequence &&
          existing.preparedCheckpointStateDigest === checkpoint.preparedCheckpointStateDigest &&
          existing.preparedEventSequence === checkpoint.preparedEventSequence &&
          existing.preparedEventDigest === checkpoint.preparedEventDigest;
        if (!replayMatches) {
          throw recoveryHandoffFailure(
            "EEXECUTION_RECOVERY_CLAIM_REPLAY",
            `Recovery handoff ${handoffId} is already claimed by a different checkpoint`
          );
        }
        return recoveryClaimResult(state, existing);
      }
      const entries = handoff.entries.map((entry) => {
        const handle = state.handles[entry.handleId];
        if (!handle || digestObject(handle) !== entry.handleDigest || handle.attemptId !== entry.attemptId ||
            handle.admissionDigest !== entry.admissionDigest || handle.status !== "ready" ||
            handle.dispatchBlocked !== true || handle.revokedAt !== null ||
            Object.values(state.intents).some((intent) => intent.handleId === entry.handleId)) {
          throw recoveryHandoffFailure(
            "EEXECUTION_RECOVERY_CLAIM_HANDLE",
            `Recovery handoff ${handoffId} task ${entry.taskId} no longer has its exact blocked handle`,
            "UNKNOWN"
          );
        }
        return {
          taskId: entry.taskId,
          handleId: entry.handleId,
          handleDigest: entry.handleDigest,
          attemptId: entry.attemptId,
          admissionDigest: entry.admissionDigest
        };
      });
      const next = withRegistryDigest({ ...state, sequence: state.sequence + 1 });
      const claim = sealExecutionRecoveryHandoffClaim({
        schemaVersion: 1,
        kind: EXECUTION_RECOVERY_HANDOFF_CLAIM_KIND,
        status: "claimed",
        claimId,
        runId,
        handoffId,
        handoffDigest: handoff.handoffDigest,
        ...checkpoint,
        taskIds: clone(handoff.taskIds),
        entries,
        sourceRegistrySequence: state.sequence,
        sourceRegistryStateDigest: state.stateDigest,
        committedRegistrySequence: next.sequence,
        committedRegistryStateDigest: next.stateDigest,
        claimedAt: nowIso(safeClockValue),
        effectAuthority: clone(RECOVERY_CLAIM_EFFECT_AUTHORITY)
      });
      const persisted = await persistRecoveryAuthorityRecord({
        state,
        next,
        op: "recovery.handoff-claimed",
        payload: { claim },
        record: claim,
        recordDigest: claim.claimDigest,
        lookup: () => lastRecoveryClaims.get(claim.claimId) ?? null,
        code: "EEXECUTION_RECOVERY_CLAIM_UNKNOWN",
        label: "Recovery handoff claim"
      });
      return recoveryClaimResult(persisted.readback, persisted.persisted);
    });
  }

  // Internal durable-storage primitive.  Dependency state is recorded here,
  // not established here.  A later effect gate must re-read the canonical
  // WorkflowPlan/checkpoint and must never consume this raw record directly.
  async function authorizeRecoveryHandoffTaskRelease(request = {}) {
    assertOwnDataObject(request, "authorizeRecoveryHandoffTaskRelease request");
    exactKeys(
      request,
      ["handoffId", "claimId", "taskId", "checkpoint"],
      "authorizeRecoveryHandoffTaskRelease request"
    );
    const handoffId = assertId(request.handoffId, "authorizeRecoveryHandoffTaskRelease.handoffId");
    const claimId = assertId(request.claimId, "authorizeRecoveryHandoffTaskRelease.claimId");
    const taskId = assertId(request.taskId, "authorizeRecoveryHandoffTaskRelease.taskId");
    const checkpoint = validateRecoveryTaskReleaseCheckpoint(request.checkpoint);
    return withRegistryLockWaiting(async () => {
      await assertOpenedRootIdentities();
      const state = await readRecovered();
      const handoff = lastRecoveryHandoffs.get(handoffId) ?? null;
      const claim = lastRecoveryClaims.get(claimId) ?? null;
      if (!handoff || !claim || claim.handoffId !== handoffId || claim.handoffDigest !== handoff.handoffDigest) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_RELEASE_CLAIM",
          "Recovery task release does not reference an exact durable claim and handoff"
        );
      }
      if (checkpoint.checkpointSequence < claim.preparedEventSequence) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_RELEASE_CHECKPOINT",
          `Recovery task ${taskId} checkpoint predates the prepared recovery event`
        );
      }
      const claimEntry = claim.entries.find((entry) => entry.taskId === taskId) ?? null;
      if (!claimEntry) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_RELEASE_TASK",
          `Recovery task ${taskId} is not part of claim ${claimId}`
        );
      }
      const releaseId = recoveryTaskReleaseIdentity({
        claimId,
        taskId,
        handleId: claimEntry.handleId,
        attemptId: claimEntry.attemptId
      });
      const existing = lastRecoveryTaskReleases.get(releaseId) ?? null;
      if (existing) {
        if (existing.checkpointSequence !== checkpoint.checkpointSequence ||
            existing.checkpointStateDigest !== checkpoint.checkpointStateDigest ||
            existing.taskStateDigest !== checkpoint.taskStateDigest ||
            existing.dependencyStateDigest !== checkpoint.dependencyStateDigest ||
            !same(existing.dependencies, checkpoint.dependencies)) {
          throw recoveryHandoffFailure(
            "EEXECUTION_RECOVERY_RELEASE_REPLAY",
            `Recovery task ${taskId} already has a release bound to a different checkpoint`
          );
        }
        return recoveryTaskReleaseResult(state, existing);
      }
      const handle = state.handles[claimEntry.handleId];
      if (!handle || digestObject(handle) !== claimEntry.handleDigest || handle.attemptId !== claimEntry.attemptId ||
          handle.admissionDigest !== claimEntry.admissionDigest || handle.status !== "ready" ||
          handle.dispatchBlocked !== true || handle.revokedAt !== null ||
          Object.values(state.intents).some((intent) => intent.handleId === claimEntry.handleId)) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_RELEASE_HANDLE",
          `Recovery task ${taskId} no longer has its exact blocked handle`,
          "UNKNOWN"
        );
      }
      const next = withRegistryDigest({ ...state, sequence: state.sequence + 1 });
      const release = sealExecutionRecoveryTaskRelease({
        schemaVersion: 1,
        kind: EXECUTION_RECOVERY_TASK_RELEASE_KIND,
        status: "authorized",
        releaseId,
        runId,
        handoffId,
        handoffDigest: handoff.handoffDigest,
        claimId,
        claimDigest: claim.claimDigest,
        taskId,
        handleId: claimEntry.handleId,
        handleDigest: claimEntry.handleDigest,
        attemptId: claimEntry.attemptId,
        admissionDigest: claimEntry.admissionDigest,
        planId: claim.planId,
        planDigest: claim.planDigest,
        contractDigest: claim.contractDigest,
        recoveryPlanDigest: claim.recoveryPlanDigest,
        preparedEventSequence: claim.preparedEventSequence,
        preparedEventDigest: claim.preparedEventDigest,
        checkpointSequence: checkpoint.checkpointSequence,
        checkpointStateDigest: checkpoint.checkpointStateDigest,
        taskStateDigest: checkpoint.taskStateDigest,
        dependencies: checkpoint.dependencies,
        dependencyStateDigest: checkpoint.dependencyStateDigest,
        sourceRegistrySequence: state.sequence,
        sourceRegistryStateDigest: state.stateDigest,
        committedRegistrySequence: next.sequence,
        committedRegistryStateDigest: next.stateDigest,
        authorizedAt: nowIso(safeClockValue),
        effectAuthority: clone(RECOVERY_TASK_RELEASE_EFFECT_AUTHORITY)
      });
      const persisted = await persistRecoveryAuthorityRecord({
        state,
        next,
        op: "recovery.task-release-authorized",
        payload: { release },
        record: release,
        recordDigest: release.releaseDigest,
        lookup: () => lastRecoveryTaskReleases.get(release.releaseId) ?? null,
        code: "EEXECUTION_RECOVERY_RELEASE_UNKNOWN",
        label: "Recovery task release"
      });
      return recoveryTaskReleaseResult(persisted.readback, persisted.persisted);
    });
  }

  // Internal durable-storage primitive.  It consumes one exact release into
  // an idempotent journal record while deliberately leaving the handle
  // blocked and all effect authority false.  Only a fresh plan-bound caller
  // may use this primitive; the raw record is never dispatch authority.
  async function consumeRecoveryHandoffTaskRelease(request = {}) {
    assertOwnDataObject(request, "consumeRecoveryHandoffTaskRelease request");
    exactKeys(
      request,
      ["handoffId", "claimId", "releaseId", "taskId"],
      "consumeRecoveryHandoffTaskRelease request"
    );
    const handoffId = assertId(request.handoffId, "consumeRecoveryHandoffTaskRelease.handoffId");
    const claimId = assertId(request.claimId, "consumeRecoveryHandoffTaskRelease.claimId");
    const releaseId = assertId(request.releaseId, "consumeRecoveryHandoffTaskRelease.releaseId");
    const taskId = assertId(request.taskId, "consumeRecoveryHandoffTaskRelease.taskId");
    return withRegistryLockWaiting(async () => {
      await assertOpenedRootIdentities();
      const state = await readRecovered();
      const handoff = lastRecoveryHandoffs.get(handoffId) ?? null;
      const claim = lastRecoveryClaims.get(claimId) ?? null;
      const release = lastRecoveryTaskReleases.get(releaseId) ?? null;
      if (!handoff || !claim || !release || claim.handoffId !== handoffId || release.handoffId !== handoffId ||
          release.claimId !== claimId || release.taskId !== taskId || claim.handoffDigest !== handoff.handoffDigest ||
          release.handoffDigest !== handoff.handoffDigest || release.claimDigest !== claim.claimDigest) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_CONSUMPTION_RELEASE",
          "Recovery task permit consumption does not reference one exact durable handoff, claim, and release chain"
        );
      }
      const claimEntry = claim.entries.find((entry) => entry.taskId === taskId) ?? null;
      if (!claimEntry || claimEntry.handleId !== release.handleId || claimEntry.handleDigest !== release.handleDigest ||
          claimEntry.attemptId !== release.attemptId || claimEntry.admissionDigest !== release.admissionDigest) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_CONSUMPTION_BINDING",
          `Recovery task ${taskId} release is not exact to its claimed handle`,
          "UNKNOWN"
        );
      }
      const handle = state.handles[release.handleId];
      if (!handle || digestObject(handle) !== release.handleDigest || handle.attemptId !== release.attemptId ||
          handle.admissionDigest !== release.admissionDigest || handle.status !== "ready" ||
          handle.dispatchBlocked !== true || handle.revokedAt !== null ||
          Object.values(state.intents).some((intent) => intent.handleId === release.handleId)) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_CONSUMPTION_HANDLE",
          `Recovery task ${taskId} no longer has its exact untouched blocked handle`,
          "UNKNOWN"
        );
      }
      const consumptionId = recoveryTaskPermitConsumptionIdentity({
        releaseId,
        releaseDigest: release.releaseDigest,
        taskId,
        handleId: release.handleId,
        attemptId: release.attemptId
      });
      const existing = lastRecoveryTaskPermitConsumptions.get(consumptionId) ?? null;
      if (existing) {
        if (existing.releaseId !== releaseId || existing.releaseDigest !== release.releaseDigest ||
            existing.taskId !== taskId || existing.handleId !== release.handleId ||
            existing.handleDigest !== release.handleDigest || existing.attemptId !== release.attemptId ||
            existing.admissionDigest !== release.admissionDigest) {
          throw recoveryHandoffFailure(
            "EEXECUTION_RECOVERY_CONSUMPTION_REPLAY",
            `Recovery task ${taskId} permit was consumed with a conflicting durable binding`,
            "UNKNOWN"
          );
        }
        return recoveryTaskPermitConsumptionResult(state, existing);
      }
      const conflicting = [...lastRecoveryTaskPermitConsumptions.values()].find(
        (consumption) => consumption.releaseId === releaseId
      ) ?? null;
      if (conflicting) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_CONSUMPTION_REPLAY",
          `Recovery task ${taskId} release already has a different durable consumption`,
          "UNKNOWN"
        );
      }
      const next = withRegistryDigest({ ...state, sequence: state.sequence + 1 });
      const consumption = sealExecutionRecoveryTaskPermitConsumption({
        schemaVersion: 1,
        kind: EXECUTION_RECOVERY_TASK_PERMIT_CONSUMPTION_KIND,
        status: "consumed",
        consumptionId,
        runId,
        handoffId,
        handoffDigest: handoff.handoffDigest,
        claimId,
        claimDigest: claim.claimDigest,
        releaseId,
        releaseDigest: release.releaseDigest,
        taskId,
        handleId: release.handleId,
        handleDigest: release.handleDigest,
        attemptId: release.attemptId,
        admissionDigest: release.admissionDigest,
        planId: release.planId,
        planDigest: release.planDigest,
        contractDigest: release.contractDigest,
        recoveryPlanDigest: release.recoveryPlanDigest,
        preparedEventSequence: release.preparedEventSequence,
        preparedEventDigest: release.preparedEventDigest,
        checkpointSequence: release.checkpointSequence,
        checkpointStateDigest: release.checkpointStateDigest,
        taskStateDigest: release.taskStateDigest,
        dependencies: clone(release.dependencies),
        dependencyStateDigest: release.dependencyStateDigest,
        sourceRegistrySequence: state.sequence,
        sourceRegistryStateDigest: state.stateDigest,
        committedRegistrySequence: next.sequence,
        committedRegistryStateDigest: next.stateDigest,
        consumedAt: nowIso(safeClockValue),
        effectAuthority: clone(RECOVERY_TASK_PERMIT_CONSUMPTION_EFFECT_AUTHORITY)
      });
      const persisted = await persistRecoveryAuthorityRecord({
        state,
        next,
        op: "recovery.task-permit-consumed",
        payload: { consumption },
        record: consumption,
        recordDigest: consumption.consumptionDigest,
        lookup: () => lastRecoveryTaskPermitConsumptions.get(consumption.consumptionId) ?? null,
        code: "EEXECUTION_RECOVERY_CONSUMPTION_UNKNOWN",
        label: "Recovery task permit consumption"
      });
      return recoveryTaskPermitConsumptionResult(persisted.readback, persisted.persisted);
    });
  }

  function assertRecoveryTaskEffectIntentHandle(state, binding, code, label) {
    const handle = state.handles[binding.handleId] ?? null;
    if (!handle || digestObject(handle) !== binding.handleDigest ||
        handle.attemptId !== binding.attemptId || handle.admissionDigest !== binding.admissionDigest ||
        handle.status !== "ready" || handle.dispatchBlocked !== true || handle.revokedAt !== null ||
        Object.values(state.intents).some((intent) => intent.handleId === binding.handleId)) {
      throw recoveryHandoffFailure(
        code,
        `${label} no longer has its exact untouched blocked handle`,
        "UNKNOWN"
      );
    }
    return handle;
  }

  function recoveryTaskEffectIntentBase(consumption) {
    return {
      ...Object.fromEntries(RECOVERY_TASK_EFFECT_INTENT_BINDING_FIELDS.map((key) => [key, clone(consumption[key])])),
      dependencies: clone(consumption.dependencies)
    };
  }

  // These four methods are journal-only bookkeeping primitives.  They never
  // create a generic execution intent, unblock a handle, or cross an effect
  // boundary.  The high-level plan runner is solely responsible for minting
  // process-local capabilities after fresh canonical validation.
  async function createRecoveryTaskEffectIntent(request = {}) {
    assertOwnDataObject(request, "createRecoveryTaskEffectIntent request");
    exactKeys(request, ["consumptionId", "taskId", "handleId"], "createRecoveryTaskEffectIntent request");
    const consumptionId = assertId(request.consumptionId, "createRecoveryTaskEffectIntent.consumptionId");
    const taskId = assertId(request.taskId, "createRecoveryTaskEffectIntent.taskId");
    const handleId = assertId(request.handleId, "createRecoveryTaskEffectIntent.handleId");
    return withRegistryLockWaiting(async () => {
      await assertOpenedRootIdentities();
      const state = await readRecovered();
      const consumption = lastRecoveryTaskPermitConsumptions.get(consumptionId) ?? null;
      if (!consumption || consumption.taskId !== taskId || consumption.handleId !== handleId) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_EFFECT_INTENT_CONSUMPTION",
          "Recovery task effect intent does not reference one exact durable permit consumption"
        );
      }
      assertRecoveryTaskEffectIntentHandle(
        state,
        consumption,
        "EEXECUTION_RECOVERY_EFFECT_INTENT_HANDLE",
        `Recovery task ${taskId}`
      );
      const intentId = recoveryTaskEffectIntentIdentity({
        consumptionId,
        consumptionDigest: consumption.consumptionDigest,
        taskId,
        handleId,
        attemptId: consumption.attemptId
      });
      const existing = lastRecoveryTaskEffectIntents.get(intentId) ?? null;
      if (existing) {
        if (existing.consumptionId !== consumptionId || existing.consumptionDigest !== consumption.consumptionDigest ||
            existing.taskId !== taskId || existing.handleId !== handleId ||
            existing.handleDigest !== consumption.handleDigest || existing.attemptId !== consumption.attemptId) {
          throw recoveryHandoffFailure(
            "EEXECUTION_RECOVERY_EFFECT_INTENT_REPLAY",
            `Recovery task ${taskId} effect intent has a conflicting durable binding`,
            "UNKNOWN"
          );
        }
        return recoveryTaskEffectIntentResult(state, existing);
      }
      const conflicting = [...lastRecoveryTaskEffectIntents.values()].find(
        (intent) => intent.consumptionId === consumptionId ||
          (intent.handleId === handleId && intent.attemptId === consumption.attemptId)
      ) ?? null;
      if (conflicting) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_EFFECT_INTENT_REPLAY",
          `Recovery task ${taskId} already has a different durable effect intent`,
          "UNKNOWN"
        );
      }
      const next = withRegistryDigest({ ...state, sequence: state.sequence + 1 });
      const intent = sealExecutionRecoveryTaskEffectIntent({
        schemaVersion: 1,
        kind: EXECUTION_RECOVERY_TASK_EFFECT_INTENT_KIND,
        status: "created",
        intentId,
        ...recoveryTaskEffectIntentBase(consumption),
        transitionIndex: 0,
        priorIntentDigest: null,
        reservationId: null,
        dispatchReserved: false,
        callbackCalls: 0,
        effectStarted: false,
        createdAt: nowIso(safeClockValue),
        reservedAt: null,
        terminalAt: null,
        terminalReason: null,
        sourceRegistrySequence: state.sequence,
        sourceRegistryStateDigest: state.stateDigest,
        committedRegistrySequence: next.sequence,
        committedRegistryStateDigest: next.stateDigest,
        effectAuthority: clone(RECOVERY_TASK_EFFECT_INTENT_EFFECT_AUTHORITY)
      });
      const persisted = await persistRecoveryAuthorityRecord({
        state,
        next,
        op: "recovery.task-effect-intent-created",
        payload: { intent },
        record: intent,
        recordDigest: intent.intentDigest,
        readbackDigest: (value) => value?.intentDigest ?? null,
        lookup: () => lastRecoveryTaskEffectIntents.get(intent.intentId) ?? null,
        code: "EEXECUTION_RECOVERY_EFFECT_INTENT_UNKNOWN",
        label: "Recovery task effect intent creation"
      });
      return recoveryTaskEffectIntentResult(persisted.readback, persisted.persisted);
    });
  }

  async function reserveRecoveryTaskEffectIntent(request = {}) {
    assertOwnDataObject(request, "reserveRecoveryTaskEffectIntent request");
    exactKeys(request, ["intentId"], "reserveRecoveryTaskEffectIntent request");
    const intentId = assertId(request.intentId, "reserveRecoveryTaskEffectIntent.intentId");
    return withRegistryLockWaiting(async () => {
      await assertOpenedRootIdentities();
      const state = await readRecovered();
      const current = lastRecoveryTaskEffectIntents.get(intentId) ?? null;
      if (!current) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_EFFECT_INTENT_MISSING",
          "Recovery task effect intent was not found"
        );
      }
      assertRecoveryTaskEffectIntentHandle(
        state,
        current,
        "EEXECUTION_RECOVERY_EFFECT_INTENT_HANDLE",
        `Recovery task ${current.taskId}`
      );
      if (current.status === "dispatch-reserved") return recoveryTaskEffectIntentResult(state, current);
      if (current.status !== "created") {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_EFFECT_INTENT_STATE",
          `Recovery task effect intent ${intentId} is already terminal`
        );
      }
      const next = withRegistryDigest({ ...state, sequence: state.sequence + 1 });
      const reservedAt = nowIso(safeClockValue);
      const intent = sealExecutionRecoveryTaskEffectIntent({
        ...clone(recoveryTaskEffectIntentBody(current)),
        status: "dispatch-reserved",
        transitionIndex: current.transitionIndex + 1,
        priorIntentDigest: current.intentDigest,
        reservationId: recoveryTaskEffectReservationIdentity({
          intentId,
          consumptionDigest: current.consumptionDigest
        }),
        dispatchReserved: true,
        reservedAt,
        sourceRegistrySequence: state.sequence,
        sourceRegistryStateDigest: state.stateDigest,
        committedRegistrySequence: next.sequence,
        committedRegistryStateDigest: next.stateDigest
      });
      const persisted = await persistRecoveryAuthorityRecord({
        state,
        next,
        op: "recovery.task-effect-dispatch-reserved",
        payload: { intent },
        record: intent,
        recordDigest: intent.intentDigest,
        readbackDigest: (value) => value?.intentDigest ?? null,
        lookup: () => lastRecoveryTaskEffectIntents.get(intent.intentId) ?? null,
        code: "EEXECUTION_RECOVERY_EFFECT_RESERVATION_UNKNOWN",
        label: "Recovery task effect dispatch reservation"
      });
      return recoveryTaskEffectIntentResult(persisted.readback, persisted.persisted);
    });
  }

  async function terminalizeRecoveryTaskEffectIntent(request, status) {
    const label = status === "not-sent"
      ? "recordRecoveryTaskEffectNotSent request"
      : "recordRecoveryTaskEffectUnknown request";
    assertOwnDataObject(request, label);
    exactKeys(request, ["intentId", "reason"], label);
    const intentId = assertId(request.intentId, `${label}.intentId`);
    const reason = assertId(request.reason, `${label}.reason`);
    const allowedReasons = status === "not-sent"
      ? RECOVERY_TASK_EFFECT_NOT_SENT_REASONS
      : RECOVERY_TASK_EFFECT_UNKNOWN_REASONS;
    if (!allowedReasons.has(reason)) throw new Error(`${label}.reason is invalid`);
    return withRegistryLockWaiting(async () => {
      await assertOpenedRootIdentities();
      const state = await readRecovered();
      const current = lastRecoveryTaskEffectIntents.get(intentId) ?? null;
      if (!current) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_EFFECT_INTENT_MISSING",
          "Recovery task effect intent was not found"
        );
      }
      assertRecoveryTaskEffectIntentHandle(
        state,
        current,
        "EEXECUTION_RECOVERY_EFFECT_INTENT_HANDLE",
        `Recovery task ${current.taskId}`
      );
      if (current.status === status && current.terminalReason === reason) {
        return recoveryTaskEffectIntentResult(state, current);
      }
      if (current.status !== "dispatch-reserved") {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_EFFECT_INTENT_STATE",
          `Recovery task effect intent ${intentId} cannot transition to ${status}`
        );
      }
      if ([...lastRecoveryTaskEffectLaunches.values()].some((launch) => launch.intentId === intentId)) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_EFFECT_INTENT_LAUNCHED",
          `Recovery task effect intent ${intentId} cannot transition to ${status} after a durable launch`,
          "UNKNOWN"
        );
      }
      const next = withRegistryDigest({ ...state, sequence: state.sequence + 1 });
      const intent = sealExecutionRecoveryTaskEffectIntent({
        ...clone(recoveryTaskEffectIntentBody(current)),
        status,
        transitionIndex: current.transitionIndex + 1,
        priorIntentDigest: current.intentDigest,
        dispatchReserved: status === "unknown",
        terminalAt: nowIso(safeClockValue),
        terminalReason: reason,
        sourceRegistrySequence: state.sequence,
        sourceRegistryStateDigest: state.stateDigest,
        committedRegistrySequence: next.sequence,
        committedRegistryStateDigest: next.stateDigest
      });
      const op = status === "not-sent"
        ? "recovery.task-effect-not-sent"
        : "recovery.task-effect-unknown";
      const persisted = await persistRecoveryAuthorityRecord({
        state,
        next,
        op,
        payload: { intent },
        record: intent,
        recordDigest: intent.intentDigest,
        readbackDigest: (value) => value?.intentDigest ?? null,
        lookup: () => lastRecoveryTaskEffectIntents.get(intent.intentId) ?? null,
        code: status === "not-sent"
          ? "EEXECUTION_RECOVERY_EFFECT_NOT_SENT_UNKNOWN"
          : "EEXECUTION_RECOVERY_EFFECT_UNKNOWN_UNKNOWN",
        label: status === "not-sent"
          ? "Recovery task effect not-sent transition"
          : "Recovery task effect unknown transition"
      });
      return recoveryTaskEffectIntentResult(persisted.readback, persisted.persisted);
    });
  }

  async function recordRecoveryTaskEffectNotSent(request = {}) {
    return terminalizeRecoveryTaskEffectIntent(request, "not-sent");
  }

  async function recordRecoveryTaskEffectUnknown(request = {}) {
    return terminalizeRecoveryTaskEffectIntent(request, "unknown");
  }

  function assertRecoveryTaskEffectExpectedRegistryHead(state, request, label) {
    if (!Number.isSafeInteger(request.expectedRegistrySequence) || request.expectedRegistrySequence < 0) {
      throw new Error(`${label}.expectedRegistrySequence is invalid`);
    }
    assertDigest(request.expectedRegistryStateDigest, `${label}.expectedRegistryStateDigest`);
    if (state.sequence !== request.expectedRegistrySequence ||
        state.stateDigest !== request.expectedRegistryStateDigest) {
      throw recoveryHandoffFailure(
        "EEXECUTION_RECOVERY_EFFECT_LEDGER_CAS",
        `${label} expected registry head is stale`
      );
    }
  }

  async function recordRecoveryTaskEffectLaunch(request = {}) {
    const label = "recordRecoveryTaskEffectLaunch request";
    assertOwnDataObject(request, label);
    exactKeys(request, [
      "intentId", "intentDigest", "reservationId", "reservationDigest", "adoptionDigest",
      "validationDigest", "approvalEnvelopeDigest", "commandDigest", "effectBindingDigest",
      "unitId", "executionId", "ownedResourceId", "controllerId", "launchEvidenceDigest",
      "expectedRegistrySequence", "expectedRegistryStateDigest"
    ], label);
    const normalized = {
      intentId: assertId(request.intentId, `${label}.intentId`),
      intentDigest: assertDigest(request.intentDigest, `${label}.intentDigest`),
      reservationId: assertId(request.reservationId, `${label}.reservationId`),
      reservationDigest: assertDigest(request.reservationDigest, `${label}.reservationDigest`),
      adoptionDigest: assertDigest(request.adoptionDigest, `${label}.adoptionDigest`),
      validationDigest: assertDigest(request.validationDigest, `${label}.validationDigest`),
      approvalEnvelopeDigest: assertDigest(request.approvalEnvelopeDigest, `${label}.approvalEnvelopeDigest`),
      commandDigest: assertDigest(request.commandDigest, `${label}.commandDigest`),
      effectBindingDigest: assertDigest(request.effectBindingDigest, `${label}.effectBindingDigest`),
      unitId: assertId(request.unitId, `${label}.unitId`),
      executionId: assertId(request.executionId, `${label}.executionId`),
      ownedResourceId: assertId(request.ownedResourceId, `${label}.ownedResourceId`),
      controllerId: assertId(request.controllerId, `${label}.controllerId`),
      launchEvidenceDigest: assertDigest(request.launchEvidenceDigest, `${label}.launchEvidenceDigest`),
      expectedRegistrySequence: request.expectedRegistrySequence,
      expectedRegistryStateDigest: request.expectedRegistryStateDigest
    };
    return withRegistryLockWaiting(async () => {
      await assertOpenedRootIdentities();
      const state = await readRecovered();
      const intent = lastRecoveryTaskEffectIntents.get(normalized.intentId) ?? null;
      if (!intent || intent.status !== "dispatch-reserved" ||
          intent.intentDigest !== normalized.intentDigest || intent.reservationId !== normalized.reservationId) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_EFFECT_LAUNCH_INTENT",
          "Recovery task effect launch does not reference one exact dispatch-reserved intent"
        );
      }
      const handle = assertRecoveryTaskEffectIntentHandle(
        state,
        intent,
        "EEXECUTION_RECOVERY_EFFECT_LAUNCH_HANDLE",
        `Recovery task ${intent.taskId}`
      );
      if (handle.unitId !== normalized.unitId || handle.executionId !== normalized.executionId ||
          handle.ownedResourceId !== normalized.ownedResourceId) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_EFFECT_LAUNCH_BINDING",
          "Recovery task effect launch command binding is not exact to the blocked handle"
        );
      }
      const launchId = recoveryTaskEffectLaunchIdentity({
        intentId: intent.intentId,
        intentDigest: intent.intentDigest,
        reservationId: intent.reservationId,
        reservationDigest: normalized.reservationDigest,
        adoptionDigest: normalized.adoptionDigest,
        launchEvidenceDigest: normalized.launchEvidenceDigest
      });
      const existing = lastRecoveryTaskEffectLaunches.get(launchId) ?? null;
      const requestFields = [
        "reservationDigest", "adoptionDigest", "validationDigest", "approvalEnvelopeDigest",
        "commandDigest", "effectBindingDigest", "unitId", "executionId", "ownedResourceId",
        "controllerId", "launchEvidenceDigest"
      ];
      if (existing) {
        if (existing.intentId !== intent.intentId || existing.intentDigest !== intent.intentDigest ||
            existing.reservationId !== intent.reservationId ||
            requestFields.some((key) => existing[key] !== normalized[key])) {
          throw recoveryHandoffFailure(
            "EEXECUTION_RECOVERY_EFFECT_LAUNCH_REPLAY",
            `Recovery task ${intent.taskId} launch has a conflicting durable binding`,
            "UNKNOWN"
          );
        }
        return recoveryTaskEffectLaunchResult(state, existing);
      }
      const conflicting = [...lastRecoveryTaskEffectLaunches.values()].find(
        (launch) => launch.intentId === intent.intentId
      ) ?? null;
      if (conflicting) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_EFFECT_LAUNCH_REPLAY",
          `Recovery task ${intent.taskId} already has a different durable launch`,
          "UNKNOWN"
        );
      }
      assertRecoveryTaskEffectExpectedRegistryHead(state, normalized, label);
      const next = withRegistryDigest({ ...state, sequence: state.sequence + 1 });
      const launch = sealExecutionRecoveryTaskEffectLaunch({
        schemaVersion: 1,
        kind: EXECUTION_RECOVERY_TASK_EFFECT_LAUNCH_KIND,
        status: "dispatch-window-open",
        launchId,
        ...Object.fromEntries(RECOVERY_TASK_EFFECT_LAUNCH_INTENT_BINDING_FIELDS.map(
          (key) => [key, clone(intent[key])]
        )),
        dependencies: clone(intent.dependencies),
        ...Object.fromEntries(RECOVERY_TASK_EFFECT_LAUNCH_ADOPTION_BINDING_FIELDS.map(
          (key) => [key, clone(normalized[key])]
        )),
        dispatchMayHaveStarted: true,
        callbackCalls: null,
        effectStarted: null,
        evidenceStatus: "observation-only",
        recordedAt: nowIso(safeClockValue),
        sourceRegistrySequence: state.sequence,
        sourceRegistryStateDigest: state.stateDigest,
        committedRegistrySequence: next.sequence,
        committedRegistryStateDigest: next.stateDigest,
        effectAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_EFFECT_AUTHORITY),
        settlementAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_SETTLEMENT_AUTHORITY)
      });
      const persisted = await persistRecoveryAuthorityRecord({
        state,
        next,
        op: "recovery.task-effect-launch-recorded",
        payload: { launch },
        record: launch,
        recordDigest: launch.launchDigest,
        readbackDigest: (value) => value?.launchDigest ?? null,
        lookup: () => lastRecoveryTaskEffectLaunches.get(launch.launchId) ?? null,
        code: "EEXECUTION_RECOVERY_EFFECT_LAUNCH_UNKNOWN",
        label: "Recovery task effect launch"
      });
      return recoveryTaskEffectLaunchResult(persisted.readback, persisted.persisted);
    });
  }

  async function recordRecoveryTaskEffectOutcome(request = {}) {
    const label = "recordRecoveryTaskEffectOutcome request";
    assertOwnDataObject(request, label);
    exactKeys(request, [
      "launchId", "launchDigest", "outcome", "effectResultDigest", "usageDigest",
      "controllerTransactionId", "controllerTransactionDigest", "callbackCalls", "effectStarted",
      "terminalReason", "outcomeEvidenceDigest", "expectedRegistrySequence",
      "expectedRegistryStateDigest"
    ], label);
    const normalized = {
      launchId: assertId(request.launchId, `${label}.launchId`),
      launchDigest: assertDigest(request.launchDigest, `${label}.launchDigest`),
      outcome: request.outcome,
      effectResultDigest: request.effectResultDigest,
      usageDigest: request.usageDigest,
      controllerTransactionId: request.controllerTransactionId,
      controllerTransactionDigest: request.controllerTransactionDigest,
      callbackCalls: request.callbackCalls,
      effectStarted: request.effectStarted,
      terminalReason: request.terminalReason,
      outcomeEvidenceDigest: assertDigest(request.outcomeEvidenceDigest, `${label}.outcomeEvidenceDigest`),
      expectedRegistrySequence: request.expectedRegistrySequence,
      expectedRegistryStateDigest: request.expectedRegistryStateDigest
    };
    if (!RECOVERY_TASK_EFFECT_OUTCOMES.has(normalized.outcome)) {
      throw new Error(`${label}.outcome is invalid`);
    }
    if (normalized.effectResultDigest !== null) {
      assertDigest(normalized.effectResultDigest, `${label}.effectResultDigest`);
    }
    if (normalized.usageDigest !== null) assertDigest(normalized.usageDigest, `${label}.usageDigest`);
    if (normalized.controllerTransactionId !== null) {
      assertId(normalized.controllerTransactionId, `${label}.controllerTransactionId`);
    }
    if (normalized.controllerTransactionDigest !== null) {
      assertDigest(normalized.controllerTransactionDigest, `${label}.controllerTransactionDigest`);
    }
    if (normalized.terminalReason !== null) assertId(normalized.terminalReason, `${label}.terminalReason`);
    return withRegistryLockWaiting(async () => {
      await assertOpenedRootIdentities();
      const state = await readRecovered();
      const launch = lastRecoveryTaskEffectLaunches.get(normalized.launchId) ?? null;
      if (!launch || launch.launchDigest !== normalized.launchDigest) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_EFFECT_OUTCOME_LAUNCH",
          "Recovery task effect outcome does not reference one exact durable launch"
        );
      }
      const intent = lastRecoveryTaskEffectIntents.get(launch.intentId) ?? null;
      if (!intent || intent.status !== "dispatch-reserved" || intent.intentDigest !== launch.intentDigest) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_EFFECT_OUTCOME_INTENT",
          "Recovery task effect outcome no longer has its exact dispatch-reserved intent",
          "UNKNOWN"
        );
      }
      assertRecoveryTaskEffectIntentHandle(
        state,
        launch,
        "EEXECUTION_RECOVERY_EFFECT_OUTCOME_HANDLE",
        `Recovery task ${launch.taskId}`
      );
      const outcomeId = recoveryTaskEffectOutcomeIdentity({
        launchId: launch.launchId,
        launchDigest: launch.launchDigest
      });
      const existing = lastRecoveryTaskEffectOutcomes.get(outcomeId) ?? null;
      const requestFields = [
        "outcome", "effectResultDigest", "usageDigest", "controllerTransactionId",
        "controllerTransactionDigest", "callbackCalls", "effectStarted", "terminalReason",
        "outcomeEvidenceDigest"
      ];
      if (existing) {
        if (existing.launchId !== launch.launchId || existing.launchDigest !== launch.launchDigest ||
            requestFields.some((key) => existing[key] !== normalized[key])) {
          throw recoveryHandoffFailure(
            "EEXECUTION_RECOVERY_EFFECT_OUTCOME_REPLAY",
            `Recovery task ${launch.taskId} outcome has a conflicting durable binding`,
            "UNKNOWN"
          );
        }
        return recoveryTaskEffectOutcomeResult(state, existing);
      }
      const conflicting = [...lastRecoveryTaskEffectOutcomes.values()].find(
        (outcome) => outcome.launchId === launch.launchId
      ) ?? null;
      if (conflicting) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_EFFECT_OUTCOME_REPLAY",
          `Recovery task ${launch.taskId} already has a different durable outcome`,
          "UNKNOWN"
        );
      }
      assertRecoveryTaskEffectExpectedRegistryHead(state, normalized, label);
      const next = withRegistryDigest({ ...state, sequence: state.sequence + 1 });
      const outcome = sealExecutionRecoveryTaskEffectOutcome({
        schemaVersion: 1,
        kind: EXECUTION_RECOVERY_TASK_EFFECT_OUTCOME_KIND,
        status: "outcome-observed",
        outcomeId,
        ...Object.fromEntries(RECOVERY_TASK_EFFECT_OUTCOME_LAUNCH_BINDING_FIELDS.map(
          (key) => [key, clone(launch[key])]
        )),
        dependencies: clone(launch.dependencies),
        outcome: normalized.outcome,
        effectResultDigest: normalized.effectResultDigest,
        usageDigest: normalized.usageDigest,
        controllerTransactionId: normalized.controllerTransactionId,
        controllerTransactionDigest: normalized.controllerTransactionDigest,
        callbackCalls: normalized.callbackCalls,
        effectStarted: normalized.effectStarted,
        terminalReason: normalized.terminalReason,
        outcomeEvidenceDigest: normalized.outcomeEvidenceDigest,
        evidenceStatus: "observation-only",
        observedAt: nowIso(safeClockValue),
        sourceRegistrySequence: state.sequence,
        sourceRegistryStateDigest: state.stateDigest,
        committedRegistrySequence: next.sequence,
        committedRegistryStateDigest: next.stateDigest,
        effectAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_EFFECT_AUTHORITY),
        settlementAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_SETTLEMENT_AUTHORITY)
      });
      const persisted = await persistRecoveryAuthorityRecord({
        state,
        next,
        op: "recovery.task-effect-outcome-recorded",
        payload: { outcome },
        record: outcome,
        recordDigest: outcome.outcomeDigest,
        readbackDigest: (value) => value?.outcomeDigest ?? null,
        lookup: () => lastRecoveryTaskEffectOutcomes.get(outcome.outcomeId) ?? null,
        code: "EEXECUTION_RECOVERY_EFFECT_OUTCOME_UNKNOWN",
        label: "Recovery task effect outcome"
      });
      return recoveryTaskEffectOutcomeResult(persisted.readback, persisted.persisted);
    });
  }

  async function readRecoveryHandoff(handoffId) {
    assertId(handoffId, "readRecoveryHandoff.handoffId");
    const state = await readRecovered({ repair: false });
    const handoff = lastRecoveryHandoffs.get(handoffId) ?? null;
    if (!handoff) throw recoveryHandoffFailure("EEXECUTION_RECOVERY_HANDOFF_MISSING", "Execution recovery handoff was not found");
    return recoveryHandoffResult(state, handoff);
  }

  async function readSealedEffectArtifact(intentId, { includeBinding = false } = {}) {
    assertId(intentId, "readSealedEffectArtifact.intentId");
    if (typeof includeBinding !== "boolean") throw new Error("readSealedEffectArtifact.includeBinding is invalid");
    await assertOpenedRootIdentities();
    let sealedEvent = null;
    let sealedFrame = null;
    // The normal replay cache has state and admission ledgers, but no effect
    // bodies. Observe one complete verified replay rather than trusting a
    // cached state or a second, independently read journal.
    const { state, journalProvenance } = await readRecovered({
      repair: false,
      returnReadback: true,
      onVerifiedEvent: (record, _next, frame) => {
        if (record.op !== "intent.sealed-with-effect" || record.payload?.intentId !== intentId) return;
        if (sealedEvent) throw new Error("Execution sealed effect artifact is duplicated");
        sealedEvent = record;
        sealedFrame = { start: frame.start, end: frame.end };
      }
    });
    await assertOpenedRootIdentities();
    const stableJournalBytes = await readJournalBytes(root, runDir, { observationOnly: true });
    if (stableJournalBytes.byteLength !== journalProvenance.byteLength ||
        createHash("sha256").update(stableJournalBytes).digest("hex") !== journalProvenance.digest) {
      throw recoveryHandoffFailure(
        "EEXECUTION_SEALED_EFFECT_ARTIFACT_CHANGED",
        "Execution sealed effect journal changed during readback",
        "HOLD"
      );
    }
    await assertOpenedRootIdentities();
    const intent = state.intents[intentId] ?? null;
    if (!sealedEvent) {
      throw recoveryHandoffFailure(
        "EEXECUTION_SEALED_EFFECT_ARTIFACT_UNAVAILABLE",
        `Execution intent ${intentId} has no durable V3 sealed effect artifact`,
        intent?.status === "unknown" ? "UNKNOWN" : "HOLD"
      );
    }
    const payload = sealedEvent.payload;
    const handle = state.handles[payload.handleId] ?? null;
    const artifact = canonicalSealedEffect(payload.effect);
    if (!intent || intent.status !== "sealed" || intent.handleId !== payload.handleId ||
        intent.outcome !== payload.outcome || intent.effectDigest !== artifact.digest ||
        !semanticSame(intent.admissionSeal, payload.admissionSeal) ||
        !handle || handle.admissionDigest === undefined ||
        artifact.digest !== payload.effectDigest || artifact.byteLength !== payload.effectByteLength) {
      throw recoveryHandoffFailure(
        "EEXECUTION_SEALED_EFFECT_ARTIFACT_DIVERGED",
        `Execution intent ${intentId} sealed effect artifact diverges from its durable state`,
        "UNKNOWN"
      );
    }
    const sealedArtifact = {
      schemaVersion: 1,
      kind: EXECUTION_SEALED_EFFECT_ARTIFACT_KIND,
      runId,
      intentId,
      handleId: payload.handleId,
      outcome: payload.outcome,
      effect: artifact.effect,
      canonicalJson: artifact.canonicalJson,
      effectByteLength: artifact.byteLength,
      effectDigest: artifact.digest,
      admissionSeal: clone(payload.admissionSeal),
      journalRecord: {
        sequence: sealedEvent.sequence,
        stateDigest: sealedEvent.stateDigest,
        startByte: sealedFrame.start,
        endByte: sealedFrame.end
      },
      registryHead: { sequence: state.sequence, stateDigest: state.stateDigest },
      journalReadback: journalProvenance,
      authority: SEALED_EFFECT_ARTIFACT_AUTHORITY
    };
    if (!includeBinding) return freezeDeep(sealedArtifact);
    const persistedAdmission = lastAdmissionLedger.get(payload.handleId) ?? null;
    if (!persistedAdmission || handle.status !== (payload.outcome === "success" ? "completed" : "failed") ||
        digestExecutionAdmission(persistedAdmission) !== handle.admissionDigest ||
        payload.admissionSeal.admissionDigest !== handle.admissionDigest) {
      throw recoveryHandoffFailure(
        "EEXECUTION_SEALED_EFFECT_BINDING_DIVERGED",
        `Execution intent ${intentId} admission or handle diverges from its durable journal`,
        "UNKNOWN"
      );
    }
    if (typeof trustedController.readAdmissionSeal !== "function") {
      throw recoveryHandoffFailure(
        "EEXECUTION_SEALED_EFFECT_SEAL_READ_UNAVAILABLE",
        "Trusted controller cannot read back its persisted admission seal",
        "HOLD"
      );
    }
    let controllerSeal;
    try {
      controllerSeal = await trustedController.readAdmissionSeal({
        runId,
        handleId: payload.handleId,
        intentId,
        admissionDigest: handle.admissionDigest,
        authorityEpoch: handle.authorityEpoch,
        fence: handle.fence,
        outcome: payload.outcome,
        effectDigest: artifact.digest
      });
    } catch (cause) {
      const held = cause?.code === "EHOST_TRUST_REQUIRED";
      const error = recoveryHandoffFailure(
        "EEXECUTION_SEALED_EFFECT_SEAL_READ_FAILED",
        "Trusted controller admission seal readback failed",
        held ? "HOLD" : "UNKNOWN"
      );
      error.cause = cause;
      throw error;
    }
    if (!semanticSame(controllerSeal, payload.admissionSeal)) {
      throw recoveryHandoffFailure(
        "EEXECUTION_SEALED_EFFECT_CONTROLLER_DIVERGED",
        `Execution intent ${intentId} controller seal diverges from its durable journal`,
        "UNKNOWN"
      );
    }
    return freezeDeep({
      schemaVersion: 2,
      kind: EXECUTION_SEALED_EFFECT_EVIDENCE_V2_KIND,
      artifact: sealedArtifact,
      persistedHandle: clone(handle),
      persistedIntent: clone(intent),
      persistedAdmissionLineage: {
        planDigest: persistedAdmission.planDigest,
        contractDigest: persistedAdmission.contractDigest,
        sourceBindingDigest: persistedAdmission.sourceBindingDigest,
        policyDigest: persistedAdmission.policyDigest,
        revision: persistedAdmission.revision
      },
      persistedAdmissionTaskId: persistedAdmission.taskId,
      persistedAdmissionDigest: handle.admissionDigest,
      controllerSeal: clone(controllerSeal),
      authority: SEALED_EFFECT_ARTIFACT_AUTHORITY
    });
  }

  async function readRecoveryHandoffClaim(claimId) {
    assertId(claimId, "readRecoveryHandoffClaim.claimId");
    const state = await readRecovered({ repair: false });
    const claim = lastRecoveryClaims.get(claimId) ?? null;
    if (!claim) {
      throw recoveryHandoffFailure(
        "EEXECUTION_RECOVERY_CLAIM_MISSING",
        "Execution recovery handoff claim was not found"
      );
    }
    return recoveryClaimResult(state, claim);
  }

  async function readRecoveryHandoffTaskRelease(releaseId) {
    assertId(releaseId, "readRecoveryHandoffTaskRelease.releaseId");
    const state = await readRecovered({ repair: false });
    const release = lastRecoveryTaskReleases.get(releaseId) ?? null;
    if (!release) {
      throw recoveryHandoffFailure(
        "EEXECUTION_RECOVERY_RELEASE_MISSING",
        "Execution recovery task release was not found"
      );
    }
    return recoveryTaskReleaseResult(state, release);
  }

  async function readRecoveryHandoffTaskPermitConsumption(consumptionId) {
    assertId(consumptionId, "readRecoveryHandoffTaskPermitConsumption.consumptionId");
    const state = await readRecovered({ repair: false });
    const consumption = lastRecoveryTaskPermitConsumptions.get(consumptionId) ?? null;
    if (!consumption) {
      throw recoveryHandoffFailure(
        "EEXECUTION_RECOVERY_CONSUMPTION_MISSING",
        "Execution recovery task permit consumption was not found"
      );
    }
    return recoveryTaskPermitConsumptionResult(state, consumption);
  }

  async function readRecoveryTaskEffectIntent(intentId) {
    assertId(intentId, "readRecoveryTaskEffectIntent.intentId");
    const state = await readRecovered({ repair: false });
    const intent = lastRecoveryTaskEffectIntents.get(intentId) ?? null;
    if (!intent) {
      throw recoveryHandoffFailure(
        "EEXECUTION_RECOVERY_EFFECT_INTENT_MISSING",
        "Execution recovery task effect intent was not found"
      );
    }
    assertRecoveryTaskEffectIntentHandle(
      state,
      intent,
      "EEXECUTION_RECOVERY_EFFECT_INTENT_HANDLE",
      `Recovery task ${intent.taskId}`
    );
    return recoveryTaskEffectIntentResult(state, intent);
  }

  async function readRecoveryTaskEffectLaunch(launchId) {
    assertId(launchId, "readRecoveryTaskEffectLaunch.launchId");
    const state = await readRecovered({ repair: false });
    const launch = lastRecoveryTaskEffectLaunches.get(launchId) ?? null;
    if (!launch) {
      throw recoveryHandoffFailure(
        "EEXECUTION_RECOVERY_EFFECT_LAUNCH_MISSING",
        "Execution recovery task effect launch was not found"
      );
    }
    const intent = lastRecoveryTaskEffectIntents.get(launch.intentId) ?? null;
    if (!intent || intent.status !== "dispatch-reserved" || intent.intentDigest !== launch.intentDigest) {
      throw recoveryHandoffFailure(
        "EEXECUTION_RECOVERY_EFFECT_LAUNCH_INTENT",
        "Execution recovery task effect launch has no exact dispatch-reserved intent",
        "UNKNOWN"
      );
    }
    assertRecoveryTaskEffectIntentHandle(
      state,
      launch,
      "EEXECUTION_RECOVERY_EFFECT_LAUNCH_HANDLE",
      `Recovery task ${launch.taskId}`
    );
    return recoveryTaskEffectLaunchResult(state, launch);
  }

  async function readRecoveryTaskEffectOutcome(outcomeId) {
    assertId(outcomeId, "readRecoveryTaskEffectOutcome.outcomeId");
    const state = await readRecovered({ repair: false });
    const outcome = lastRecoveryTaskEffectOutcomes.get(outcomeId) ?? null;
    if (!outcome) {
      throw recoveryHandoffFailure(
        "EEXECUTION_RECOVERY_EFFECT_OUTCOME_MISSING",
        "Execution recovery task effect outcome was not found"
      );
    }
    const launch = lastRecoveryTaskEffectLaunches.get(outcome.launchId) ?? null;
    if (!launch || launch.launchDigest !== outcome.launchDigest) {
      throw recoveryHandoffFailure(
        "EEXECUTION_RECOVERY_EFFECT_OUTCOME_LAUNCH",
        "Execution recovery task effect outcome has no exact durable launch",
        "UNKNOWN"
      );
    }
    assertRecoveryTaskEffectIntentHandle(
      state,
      outcome,
      "EEXECUTION_RECOVERY_EFFECT_OUTCOME_HANDLE",
      `Recovery task ${outcome.taskId}`
    );
    return recoveryTaskEffectOutcomeResult(state, outcome);
  }

  async function readRecoveryTaskEffectDispatchBoundary(intentId) {
    assertId(intentId, "readRecoveryTaskEffectDispatchBoundary.intentId");
    const state = await readRecovered({ repair: false });
    const intent = lastRecoveryTaskEffectIntents.get(intentId);
    if (!intent || intent.status !== "dispatch-reserved") throw recoveryHandoffFailure("EEXECUTION_RECOVERY_EFFECT_RESERVATION", "Recovery dispatch reservation is missing");
    const handle = assertRecoveryTaskEffectIntentHandle(state, intent, "EEXECUTION_RECOVERY_EFFECT_RESERVATION_HANDLE", "Recovery dispatch reservation");
    const launch = [...lastRecoveryTaskEffectLaunches.values()].find((value) => value.intentId === intentId) ?? null;
    return freezeDeep({ intent: clone(intent), handle: clone(handle), launch: clone(launch),
      registryHead: { sequence: state.sequence, stateDigest: state.stateDigest },
      effectAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_EFFECT_AUTHORITY),
      settlementAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_SETTLEMENT_AUTHORITY) });
  }

  function recoveryTaskEffectReconciliationResult(state, reconciliation) {
    return freezeDeep({
      reconciliation: validateExecutionRecoveryTaskEffectReconciliationV1(reconciliation, { runId }),
      registryHead: { sequence: state.sequence, stateDigest: state.stateDigest },
      journalReadback: clone(lastJournalProvenance),
      effectAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_EFFECT_AUTHORITY),
      settlementAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_SETTLEMENT_AUTHORITY)
    });
  }

  async function readRecoveryTaskEffectReconciliation(outcomeId) {
    assertId(outcomeId, "readRecoveryTaskEffectReconciliation.outcomeId");
    const state = await readRecovered({ repair: false });
    const reconciliation = lastRecoveryTaskEffectReconciliations.get(outcomeId);
    if (!reconciliation) throw recoveryHandoffFailure("EEXECUTION_RECOVERY_EFFECT_RECONCILIATION_MISSING", "Recovery reconciliation was not found");
    assertRecoveryTaskEffectIntentHandle(state, reconciliation.originalOutcome, "EEXECUTION_RECOVERY_EFFECT_RECONCILIATION_HANDLE", "Recovery reconciliation");
    return recoveryTaskEffectReconciliationResult(state, reconciliation);
  }

  async function reconcileRecoveryTaskEffectOutcome(outcomeId, options = {}) {
    assertId(outcomeId, "reconcileRecoveryTaskEffectOutcome.outcomeId");
    assertOwnDataObject(options, "recovery reconciliation options");
    if (Object.keys(options).some((key) => !["expectedSequence", "timeoutMs", "abortSignal"].includes(key))) throw new Error("Unknown recovery reconciliation option");
    const { expectedSequence, timeoutMs = RECONCILE_QUERY_WAIT_MS, abortSignal } = options;
    if (expectedSequence !== undefined && (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0)) throw new Error("Invalid recovery reconciliation expectedSequence");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 60_000) throw new Error("Invalid recovery reconciliation timeoutMs");
    const callerSignal = validateAbortSignal(abortSignal, "recovery reconciliation abortSignal");
    const failure = (code, message) => recoveryHandoffFailure(`EEXECUTION_RECOVERY_EFFECT_RECONCILIATION_${code}`, message, "UNKNOWN");
    const snapshot = await withRegistryLockWaiting(async () => {
      await assertOpenedRootIdentities();
      const state = await readRecovered();
      const existing = lastRecoveryTaskEffectReconciliations.get(outcomeId);
      if (existing) return { existing: recoveryTaskEffectReconciliationResult(state, existing) };
      if (expectedSequence !== undefined && expectedSequence !== state.sequence) throw failure("CAS", "Recovery reconciliation sequence changed");
      const outcome = lastRecoveryTaskEffectOutcomes.get(outcomeId);
      const launch = outcome && lastRecoveryTaskEffectLaunches.get(outcome.launchId);
      const intent = outcome && lastRecoveryTaskEffectIntents.get(outcome.intentId);
      if (!outcome || outcome.outcome !== "unknown" || !launch || launch.launchDigest !== outcome.launchDigest ||
          !intent || intent.status !== "dispatch-reserved" || intent.intentDigest !== outcome.intentDigest) throw failure("BINDING", "Recovery reconciliation requires an exact UNKNOWN chain");
      const handle = assertRecoveryTaskEffectIntentHandle(state, outcome, "EEXECUTION_RECOVERY_EFFECT_RECONCILIATION_HANDLE", "Recovery reconciliation");
      return { outcome: clone(outcome), handle: clone(handle), sequence: state.sequence, stateDigest: state.stateDigest };
    });
    if (snapshot.existing) return snapshot.existing;
    if (!resourceAdapter || !isTrustedOwnedResourceAdapter(resourceAdapter)) throw failure("UNAVAILABLE", "Recovery reconciliation requires a trusted owned process adapter");
    const request = recoveryResourceBinding(snapshot.outcome, snapshot.handle);
    const scope = Object.fromEntries(["runId", "handleId", "ownedResourceId", "recoveryEffectIntentId", "launchId", "outcomeId"].map((key) => [key, request[key]]));
    const queryAbort = new AbortController();
    const deadlineAt = Date.now() + timeoutMs;
    let timer;
    let onAbort;
    let observation;
    try {
      if (callerSignal?.aborted) throw failure("ABORTED", "Recovery reconciliation was aborted");
      const query = import("./owned-process-adapter-v1.mjs").then(({ queryOwnedRecoveryTaskEffectV1 }) =>
        queryOwnedRecoveryTaskEffectV1(resourceAdapter, { request, scope }, { signal: queryAbort.signal }));
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(failure("TIMEOUT", "Recovery query exceeded its deadline")), timeoutMs); });
      const cancellation = new Promise((_, reject) => {
        onAbort = () => reject(failure("ABORTED", "Recovery reconciliation was aborted"));
        callerSignal?.addEventListener("abort", onAbort, { once: true });
        if (callerSignal?.aborted) onAbort();
      });
      observation = validateExecutionRecoveryTaskEffectResourceObservationV1(await Promise.race([query, deadline, cancellation]), request);
    } catch (error) {
      throw failure("QUERY", `Recovery query is unresolved: ${String(error?.message ?? error)}`);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
      queryAbort.abort();
    }
    if (observation.controllerStatus !== "terminated" || !Object.hasOwn(RECOVERY_RESOURCE_RESOLUTIONS, observation.providerOutcome)) throw failure("UNRESOLVED", "Recovery resource observation remains UNKNOWN");
    return withRegistryLockWaiting(async () => {
      await assertOpenedRootIdentities();
      if (callerSignal?.aborted) throw failure("ABORTED", "Recovery reconciliation was aborted before append");
      const state = await readRecovered();
      const existing = lastRecoveryTaskEffectReconciliations.get(outcomeId);
      if (existing) {
        if (!same(existing.originalOutcome, snapshot.outcome) || !same(existing.observation, observation)) throw failure("REPLAY", "Conflicting concurrent recovery observation");
        return recoveryTaskEffectReconciliationResult(state, existing);
      }
      if (state.sequence !== snapshot.sequence || state.stateDigest !== snapshot.stateDigest ||
          !same(lastRecoveryTaskEffectOutcomes.get(outcomeId), snapshot.outcome)) throw failure("CAS", "Recovery state changed during query");
      const handle = assertRecoveryTaskEffectIntentHandle(state, snapshot.outcome, "EEXECUTION_RECOVERY_EFFECT_RECONCILIATION_HANDLE", "Recovery reconciliation");
      const binding = Object.fromEntries(["runId", "executionId", "attemptId", "unitId", "sourceBindingDigest", "policyDigest", "revision", "ownedResourceId"].map((key) => [key, handle[key]]));
      let fresh;
      let authorityTimer;
      let authorityAbort;
      try {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw failure("TIMEOUT", "Recovery reconciliation deadline expired before append");
        fresh = await Promise.race([
          trustedController.readExecutionBinding({ runId, binding }),
          new Promise((_, reject) => { authorityTimer = setTimeout(() => reject(failure("TIMEOUT", "Recovery authority read exceeded its deadline")), remaining); }),
          new Promise((_, reject) => {
            authorityAbort = () => reject(failure("ABORTED", "Recovery authority read was aborted"));
            callerSignal?.addEventListener("abort", authorityAbort, { once: true });
            if (callerSignal?.aborted) authorityAbort();
          })
        ]);
      } catch (error) {
        throw failure("AUTHORITY", `Recovery authority is unresolved: ${String(error?.message ?? error)}`);
      } finally {
        clearTimeout(authorityTimer);
        callerSignal?.removeEventListener("abort", authorityAbort);
      }
      if (!fresh?.authority || [...Object.keys(binding), "authorityEpoch", "fence"].some((key) => fresh.authority[key] !== handle[key]) ||
          fresh.authority.status !== "active" || fresh.authority.revoked === true || fresh.launchTransaction != null) throw failure("AUTHORITY", "Recovery authority changed before append");
      if (callerSignal?.aborted) throw failure("ABORTED", "Recovery reconciliation was aborted before append");
      const next = withRegistryDigest({ ...state, sequence: state.sequence + 1 });
      const body = {
        schemaVersion: 1, kind: EXECUTION_RECOVERY_TASK_EFFECT_RECONCILIATION_KIND, status: "reconciled",
        reconciliationId: `recovery-effect-reconciliation:${digestObject({ outcomeId, outcomeDigest: snapshot.outcome.outcomeDigest })}`,
        runId, outcomeId, outcomeDigest: snapshot.outcome.outcomeDigest, originalOutcome: snapshot.outcome, handleSnapshot: clone(handle),
        observation, resolvedOutcome: RECOVERY_RESOURCE_RESOLUTIONS[observation.providerOutcome], evidenceStatus: "observation-only", observedAt: observation.observedAt,
        sourceRegistrySequence: state.sequence, sourceRegistryStateDigest: state.stateDigest,
        committedRegistrySequence: next.sequence, committedRegistryStateDigest: next.stateDigest,
        effectAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_EFFECT_AUTHORITY), settlementAuthority: clone(RECOVERY_TASK_EFFECT_OBSERVATION_SETTLEMENT_AUTHORITY)
      };
      const reconciliation = validateExecutionRecoveryTaskEffectReconciliationV1({ ...body, reconciliationDigest: digestObject(body) });
      const persisted = await persistRecoveryAuthorityRecord({ state, next, op: "recovery.task-effect-outcome-reconciled",
        payload: { reconciliation }, record: reconciliation, recordDigest: reconciliation.reconciliationDigest,
        readbackDigest: (value) => value?.reconciliationDigest ?? null,
        lookup: () => lastRecoveryTaskEffectReconciliations.get(outcomeId) ?? null,
        code: "EEXECUTION_RECOVERY_EFFECT_RECONCILIATION_UNKNOWN", label: "Recovery effect reconciliation" });
      return recoveryTaskEffectReconciliationResult(persisted.readback, persisted.persisted);
    });
  }

  async function withRecoveryHandoffReadLease(handoffId, callback) {
    assertId(handoffId, "withRecoveryHandoffReadLease.handoffId");
    if (typeof callback !== "function") throw new Error("withRecoveryHandoffReadLease callback must be callable");
    return withRegistryLockWaiting(async () => {
      await assertOpenedRootIdentities();
      const state = await readRecovered({ repair: false });
      const handoff = lastRecoveryHandoffs.get(handoffId) ?? null;
      if (!handoff) {
        throw recoveryHandoffFailure(
          "EEXECUTION_RECOVERY_HANDOFF_MISSING",
          "Execution recovery handoff was not found"
        );
      }
      // The callback receives observation-only data and no registry mutation
      // capability.  Keeping the run lease until it settles lets another
      // durable store publish an exact non-effecting binding without a
      // registry writer interleaving between validation and publication.
      return callback(recoveryHandoffResult(state, handoff));
    });
  }

  async function createHandle(request, { expectedSequence = undefined } = {}) {
    const binding = bindingFromInput({ ...request, runId }, { label: "createExecutionHandle" });
    if (!binding.ownedResourceId) throw new Error("createExecutionHandle requires an authority-bound ownedResourceId");
    return withRegistryLock(async () => {
      let state = await readRecovered();
      if (expectedSequence !== undefined && state.sequence !== expectedSequence) throw new Error("Execution registry expected sequence mismatch");
      const existing = Object.values(state.handles).find((item) => item.executionId === binding.executionId && item.attemptId === binding.attemptId);
      if (existing) {
        if (!same(bindingForHandle(existing), binding)) throw new Error("Execution identity is already bound to a different scope");
        return clone(existing);
      }
      const obligation = computeObligationKey(binding);
      if (Object.values(state.handles).some((item) => item.obligationKey === obligation)) {
        throw new Error("Logical obligation is already reserved; use resumeExecution after reconciliation");
      }
      const fresh = await readFreshControllerBinding(trustedController, binding, { clock: safeClockValue });
      assertNativeV3AutoCommandExecutionAllowed(fresh.runContract.plan);
      if (fresh.admission) {
        const admissions = lastAdmissionLedger;
        const key = reservationKey(fresh.admission);
        for (const prior of admissions.values()) {
          if (reservationKey(prior) === key) throw new Error("V3 admission nonce has already been reserved in this run");
          if (prior.admissionId === fresh.admission.admissionId) throw new Error("V3 admission capability has already been reserved in this run");
        }
      }
      const handle = buildHandle(binding, fresh.authority, safeClockValue, null, fresh.admission);
      const next = withRegistryDigest({
        ...state,
        sequence: state.sequence + 1,
        handles: { ...state.handles, [handle.handleId]: handle }
      });
      await persistUnlocked(state, next, "handle.created", {
        handleId: handle.handleId,
        binding: publicBinding(binding),
        executionScopeDigest: handle.executionScopeDigest,
        observedAuthority: observedAuthorityFor(fresh.authority),
        ...(fresh.admission ? { admission: fresh.admission } : {})
      });
      return clone(handle);
    });
  }

  async function execute(handleId, effect, { expectedSequence = undefined, faults = {} } = {}) {
    assertId(handleId, "execute.handleId");
    if (typeof effect !== "function") throw new Error("execute requires an effect callback");
    if (!isPlainObject(faults)) throw new Error("execute.faults must be a plain object");
    if (typeof faults.beforeIntent === "function") await faults.beforeIntent();

    // Read the durable handle under the run lease, but perform the expensive
    // trusted controller/source observation after releasing it.  The second
    // lease entry below is a CAS-style recheck that prevents an observation
    // from authorizing a handle or intent that changed while it was outside
    // the lock.
    let intent;
    let callbackBinding;
    let preparation = null;
    await withRegistryLock(async () => {
      const state = await readRecovered();
      if (expectedSequence !== undefined && state.sequence !== expectedSequence) throw new Error("Execution registry expected sequence mismatch");
      const handle = state.handles[handleId];
      if (!handle) throw new Error("Execution handle was not found");
      validateHandle(handle);
      callbackBinding = bindingForHandle(handle);
      if (["completed", "failed"].includes(handle.status)) {
        const terminal = findIntentForHandle(state, handleId);
        if (!terminal || terminal.status !== "sealed") throw new Error("Terminal handle has no sealed intent");
        intent = clone(terminal);
        return;
      }
      const existing = findIntentForHandle(state, handleId);
      if (existing?.status === "unknown") {
        const unknown = new Error("Execution effect is UNKNOWN and cannot be blindly retried");
        unknown.code = "EEXECUTION_EFFECT_UNKNOWN";
        unknown.status = "UNKNOWN";
        throw unknown;
      }
      if (existing?.status === "cancelled") throw new Error("Execution intent was cancelled");
      if (existing?.status === "dispatching" || handle.status === "dispatching") throw new Error("Execution effect is already in flight");
      if (existing?.status === "sealed") {
        intent = clone(existing);
        return;
      }
      if (handle.dispatchBlocked || ["revoked", "stopped", "indeterminate"].includes(handle.status)) throw new Error("Execution is revoked or dispatch-blocked");
      preparation = {
        handle: clone(handle),
        existing: existing ? clone(existing) : null,
        admission: clone(lastAdmissionLedger.get(handleId) ?? null)
      };
    });
    if (!preparation) return clone(intent);

    // The handle was created from a trusted current observation and the
    // admission ledger is immutable after intent preparation.  The authority
    // that can authorize the effect is still re-read after the dispatching
    // transition below; doing another full source capture before that
    // transition only serializes sibling DAG tasks without adding an effect
    // authorization boundary.
    if (preparation.handle.admissionDigest !== undefined && typeof trustedController.commitAdmissionSeal !== "function") {
      const hold = new Error("Trusted V3 admission seal CAS is unavailable; execution is HOLD");
      hold.code = "EADMISSION_HOLD";
      throw hold;
    }

    intent = preparation.existing ?? intentFor(preparation.handle, randomUUID(), safeClockValue);
    await withRegistryLock(async () => {
      let state = await readRecovered();
      const handle = state.handles[handleId];
      if (!handle) throw new Error("Execution handle was not found");
      validateHandle(handle);
      if (!same(handle, preparation.handle)) throw new Error("Execution handle changed while preparing the effect");
      const existing = findIntentForHandle(state, handleId);
      if (preparation.existing) {
        if (!existing || !same(existing, preparation.existing)) throw new Error("Execution intent changed while preparing the effect");
      } else {
        if (existing) throw new Error("Execution effect is already in flight");
        const created = withRegistryDigest({
          ...state,
          sequence: state.sequence + 1,
          intents: { ...state.intents, [intent.intentId]: intent }
        });
        state = await persistUnlocked(state, created, "intent.created", { intentId: intent.intentId, handleId });
      }
      const persistedAdmission = lastAdmissionLedger.get(handleId) ?? null;
      if (handle.admissionDigest !== undefined &&
          (!persistedAdmission || digestExecutionAdmission(persistedAdmission) !== handle.admissionDigest)) {
        throw new Error("Persisted V3 execution admission is missing or does not match the handle");
      }
    });

    // This hook intentionally runs after the durable pending intent and
    // outside the run lease so a test/controller can stop or reconcile it.
    if (typeof faults.afterIntentBeforeEffect === "function") await faults.afterIntentBeforeEffect(clone(intent));

    if (typeof trustedController.readControllerLifecycle !== "function") {
      throw new Error("Execution dispatch requires a trusted controller lifecycle/owner-lease adapter");
    }
    const lifecycle = validateControllerLifecycle(
      await trustedController.readControllerLifecycle({ runId }),
      runId
    );
    if (lifecycle.status !== "active") throw new Error("Controller owner lease is not active");

    await withRegistryLock(async () => {
      let state = await readRecovered();
      const handle = state.handles[handleId];
      const currentIntent = state.intents[intent.intentId];
      if (!handle || !same(handle, preparation.handle)) throw new Error("Execution handle changed before dispatch");
      if (!currentIntent || !same(currentIntent, intent)) throw new Error("Execution intent changed before dispatch");
      if (currentIntent.status !== "pending" && currentIntent.status !== "not-sent") throw new Error("Execution intent is no longer dispatchable");
      const dispatched = {
        ...currentIntent,
        status: "dispatching",
        callbackCalls: 0,
        dispatchReserved: true,
        dispatchStartedAt: nowIso(safeClockValue),
        controllerIncarnation: lifecycle.incarnation,
        ownerLeaseId: lifecycle.ownerLeaseId,
        notSentAt: null,
        notSentReason: null
      };
      const dispatchHandle = { ...handle, status: "dispatching" };
      const dispatchState = withRegistryDigest({
        ...state,
        sequence: state.sequence + 1,
        handles: { ...state.handles, [handleId]: dispatchHandle },
        intents: { ...state.intents, [intent.intentId]: dispatched }
      });
      await persistUnlocked(state, dispatchState, "intent.dispatched", {
        intentId: intent.intentId,
        handleId,
        authorityEpoch: handle.authorityEpoch,
        fence: handle.fence
      });
      intent = dispatched;
    });

    if (!intent) throw new Error("Execution intent was not prepared");
    if (intent.status === "sealed") return clone(intent);
    if (typeof faults.afterDispatchBeforeEffect === "function") await faults.afterDispatchBeforeEffect(clone(intent));

    let currentAdmission = null;
    let effectResult;
    let effectStarted = false;
    let effectStartedAtMono = null;
    let usageObservation = null;
    try {
      // Re-observe authority after the caller hook, outside the lease.  Only
      // the short persisted-handle/intent check and callback invocation are
      // linearized under the run lease; the external effect promise itself is
      // allowed to run after the lease is released.
      const callbackFresh = await readFreshControllerBinding(
        trustedController,
        callbackBinding,
        { clock: safeClockValue }
      );
      assertNativeV3AutoCommandExecutionAllowed(callbackFresh.runContract.plan);
      await withRegistryLock(async () => {
        const state = await readRecovered();
        const handle = state.handles[handleId];
        const currentIntent = state.intents[intent.intentId];
        if (!handle || !currentIntent || !same(currentIntent, intent) || handle.status !== "dispatching") {
          throw new Error("Execution intent is no longer dispatchable");
        }
        if (handle.dispatchBlocked) throw new Error("Execution handle is revoked or dispatch-blocked");
        currentAdmission = assertFreshBindingForHandle(handle, callbackFresh, lastAdmissionLedger.get(handleId) ?? null).admission;
        const executionContext = freezeDeep({
          schemaVersion: 1,
          handleId,
          intentId: intent.intentId,
          binding: callbackBinding,
          authorityEpoch: intent.authorityEpoch,
          fence: intent.fence,
          ...(currentAdmission ? { admission: currentAdmission } : {})
        });
        effectStarted = true;
        effectStartedAtMono = monotonicNowNs();
        const callbackResult = effect(executionContext);
        // Attach rejection handling synchronously while the callback promise
        // is created.  The registry lock can then be released without an
        // unhandled-rejection window before the outer execution awaits it.
        effectResult = Promise.resolve(callbackResult).then(
          (value) => ({ status: "fulfilled", value }),
          (error) => ({ status: "rejected", error })
        );
      });
      const settledEffect = await effectResult;
      if (settledEffect.status === "rejected") throw settledEffect.error;
      effectResult = settledEffect.value;
      usageObservation = createExecutionUsageObservation(
        preparation.handle,
        intent,
        effectStartedAtMono,
        safeClockValue
      );
      if (typeof faults.afterEffectBeforeSeal === "function") await faults.afterEffectBeforeSeal(clone(effectResult));
    } catch (error) {
      // A callback that has not begun is still provably not sent. Persist that
      // fact before returning the retryable pre-send error. Once invocation
      // begins, a thrown error may represent a partial external effect and the
      // intent must remain UNKNOWN; it is never retried blindly.
      if (!effectStarted) {
        let proof;
        try {
          proof = await persistNotSent(intent, handleId);
        } catch (proofError) {
          throw executionEffectStatusUnknownError(error, proofError);
        }
        if (!proof) throw executionEffectStatusUnknownError(error);
        throw executionEffectNotSentError(error, proof);
      }
      if (error?.code === "SBW_TEST_CRASH_AFTER_EFFECT_BEFORE_SEAL" || typeof faults.afterEffectBeforeSeal === "function") throw error;
      // The effect callback may reject while a concurrent stop is committing
      // its durable request under the same run lease. Wait only through the
      // bounded emergency-stop lock policy. A timeout leaves the intent
      // unsealed for reconciliation; it never authorizes retrying the effect.
      await withRegistryLockWaiting(async () => {
        const state = await readRecovered();
        const currentIntent = state.intents[intent.intentId];
        if (!currentIntent || currentIntent.status !== "dispatching") return;
        const nextIntent = {
          ...currentIntent,
          status: "unknown",
          callbackCalls: 1,
          dispatchReserved: false,
          outcome: "unknown",
          sealedAt: nowIso(safeClockValue),
          unknownReason: "effect-callback-error",
          lateCallback: false
        };
        const handle = state.handles[handleId];
        const next = withRegistryDigest({
          ...state,
          sequence: state.sequence + 1,
          handles: { ...state.handles, [handleId]: { ...handle, status: "indeterminate", dispatchBlocked: true } },
          intents: { ...state.intents, [intent.intentId]: nextIntent }
        });
        await persistUnlocked(state, next, "intent.unknown", { intentId: intent.intentId, reason: nextIntent.unknownReason });
      });
      throw error;
    }

    let admissionSeal = null;
    const persistLateUnknown = async (reason) => withRegistryLockWaiting(async () => {
      const state = await readRecovered();
      const currentIntent = state.intents[intent.intentId];
      const handle = state.handles[handleId];
      if (!currentIntent || !handle || currentIntent.status !== "dispatching") return false;
      const unknown = {
        ...currentIntent,
        status: "unknown",
        callbackCalls: 1,
        dispatchReserved: false,
        outcome: "unknown",
        sealedAt: nowIso(safeClockValue),
        unknownReason: reason,
        lateCallback: true
      };
      const next = withRegistryDigest({
        ...state,
        sequence: state.sequence + 1,
        handles: { ...state.handles, [handleId]: { ...handle, status: "indeterminate", dispatchBlocked: true } },
        intents: { ...state.intents, [intent.intentId]: unknown }
      });
      await persistUnlocked(state, next, "intent.late-callback-rejected", { intentId: intent.intentId, reason });
      return true;
    });
    const lateError = (error) => {
      const late = new Error(`Late callback rejected: ${error?.message ?? String(error)}`);
      late.code = "ESTALE_EXECUTION";
      return late;
    };

    let normalized;
    let effectDigest;
    let sealedEffectArtifact = null;
    try {
      normalized = normalizeEffectResult(effectResult);
      if (preparation.handle.admissionDigest !== undefined) {
        sealedEffectArtifact = canonicalSealedEffect(normalized.result);
        effectDigest = sealedEffectArtifact.digest;
      } else {
        effectDigest = digestObject(normalized.result);
      }
    } catch (error) {
      await persistLateUnknown("effect-result-unpersistable");
      throw lateError(error);
    }

    let finalFresh;
    try {
      finalFresh = await readFreshControllerBinding(
        trustedController,
        callbackBinding,
        { clock: safeClockValue }
      );
    } catch (error) {
      await persistLateUnknown("stale-epoch-or-revocation");
      throw lateError(error);
    }

    if (Boolean(finalFresh.admission) !== Boolean(sealedEffectArtifact)) {
      await persistLateUnknown("effect-result-unpersistable");
      throw lateError(new Error("V3 effect artifact and admission do not match"));
    }

    let finalSnapshot;
    try {
      finalSnapshot = await withRegistryLock(async () => {
        const state = await readRecovered();
        const currentIntent = state.intents[intent.intentId];
        const handle = state.handles[handleId];
        if (!currentIntent || !handle || currentIntent.status !== "dispatching") throw new Error("Late callback or stale execution intent rejected");
        return {
          handle: clone(handle),
          intent: clone(currentIntent),
          admission: clone(lastAdmissionLedger.get(handleId) ?? null)
        };
      });
    } catch (error) {
      throw error;
    }

    try {
      assertFreshBindingForHandle(finalSnapshot.handle, finalFresh, finalSnapshot.admission);
      assertNoLateMutation(finalSnapshot.handle, finalSnapshot.intent);
    } catch (error) {
      await persistLateUnknown("revoked-before-seal");
      throw lateError(error);
    }

    if (finalFresh.admission) {
      const commitReason = typeof trustedController.commitAdmissionSeal === "function"
        ? "admission-commit-rejected"
        : "admission-commit-unavailable";
      try {
        if (typeof trustedController.commitAdmissionSeal !== "function") {
          throw new Error("Trusted V3 admission seal CAS is unavailable");
        }
        const admission = finalFresh.admission;
        const admissionDigest = digestExecutionAdmission(admission);
        const seal = await trustedController.commitAdmissionSeal({
          runId,
          handleId,
          intentId: intent.intentId,
          admission: clone(admission),
          admissionDigest,
          authorityEpoch: admission.authorityEpoch,
          fence: admission.fence,
          outcome: normalized.outcome,
          effectDigest
        });
        admissionSeal = validateTrustedAdmissionSeal(seal, {
          runId,
          handleId,
          intentId: intent.intentId,
          admissionDigest,
          authorityEpoch: admission.authorityEpoch,
          fence: admission.fence,
          outcome: normalized.outcome,
          effectDigest
        });
      } catch (error) {
        await persistLateUnknown(commitReason);
        const late = new Error(`V3 admission seal rejected: ${error.message}`);
        late.code = "ESTALE_EXECUTION";
        throw late;
      }
    }

    let result;
    try {
      await withRegistryLock(async () => {
        const state = await readRecovered();
        const currentIntent = state.intents[intent.intentId];
        const handle = state.handles[handleId];
        if (!currentIntent || !handle || currentIntent.status !== "dispatching") {
          const stale = new Error("Late callback or stale execution intent rejected");
          stale.code = "ESTALE_EXECUTION";
          stale.unknownReason = "revoked-before-seal";
          throw stale;
        }
        if (!same(handle, finalSnapshot.handle) || !same(currentIntent, finalSnapshot.intent)) {
          const stale = new Error("Execution handle or intent changed before seal");
          stale.code = "ESTALE_EXECUTION";
          stale.unknownReason = "revoked-before-seal";
          throw stale;
        }
        try {
          assertFreshBindingForHandle(handle, finalFresh, lastAdmissionLedger.get(handleId) ?? null);
          assertNoLateMutation(handle, currentIntent);
        } catch (error) {
          error.code = "ESTALE_EXECUTION";
          error.unknownReason = error.message.includes("revoked") || error.message.includes("dispatch-blocked")
            ? "revoked-before-seal"
            : "stale-epoch-or-revocation";
          throw error;
        }
        if (finalFresh.admission && !admissionSeal) {
          const hold = new Error("V3 admission seal is missing");
          hold.code = "ESTALE_EXECUTION";
          hold.unknownReason = "admission-commit-rejected";
          throw hold;
        }
        const sealed = {
          ...currentIntent,
          status: "sealed",
          callbackCalls: 1,
          dispatchReserved: false,
          sealedAt: nowIso(safeClockValue),
          outcome: normalized.outcome,
          effectDigest,
          ...(admissionSeal ? { admissionSeal } : {}),
          ...(usageObservation ? { usageObservation } : {})
        };
        const sealedHandle = { ...handle, status: normalized.outcome === "success" ? "completed" : "failed" };
        const next = withRegistryDigest({
          ...state,
          sequence: state.sequence + 1,
          handles: { ...state.handles, [handleId]: sealedHandle },
          intents: { ...state.intents, [intent.intentId]: sealed }
        });
        await persistUnlocked(state, next, sealedEffectArtifact ? "intent.sealed-with-effect" : "intent.sealed", {
          intentId: intent.intentId,
          handleId,
          outcome: normalized.outcome,
          effectDigest: sealed.effectDigest,
          ...(sealedEffectArtifact ? {
            effect: sealedEffectArtifact.effect,
            effectByteLength: sealedEffectArtifact.byteLength
          } : {}),
          ...(admissionSeal ? { admissionSeal } : {}),
          ...(usageObservation ? { usageObservation } : {})
        });
        result = {
          handle: clone(sealedHandle),
          intent: clone(sealed),
          outcome: normalized.outcome,
          effect: clone(sealedEffectArtifact?.effect ?? normalized.result)
        };
      });
    } catch (error) {
      if (error?.code !== "ESTALE_EXECUTION") throw error;
      await persistLateUnknown(error.unknownReason ?? "revoked-before-seal");
      throw lateError(error);
    }
    return result;
  }

  async function requestStop(handleId, {
    reason = "cancel",
    requestedBy = "trusted-controller",
    expectedEpoch = undefined,
    expectedFence = undefined,
    expectedRevision = undefined
  } = {}) {
    assertId(handleId, "stop.handleId");
    if (!STOP_REASONS.has(reason)) throw new Error("stop reason is invalid");
    assertId(requestedBy, "stop.requestedBy");
    let stopRequest = null;
    let existingReceipt = null;
    let alreadyComplete = false;
    await withRegistryLockWaiting(async () => {
      let state = await readRecovered();
      const handle = state.handles[handleId];
      if (!handle) throw new Error("Execution handle was not found");
      if (expectedEpoch !== undefined && expectedEpoch !== handle.authorityEpoch) throw new Error("stop expected authority epoch mismatch");
      if (expectedFence !== undefined && expectedFence !== handle.fence) throw new Error("stop expected fence mismatch");
      if (expectedRevision !== undefined && expectedRevision !== handle.revision) throw new Error("stop expected revision mismatch");
      const prior = Object.values(state.stopRequests).find((item) => item.handleId === handleId && item.reason === reason);
      if (prior) {
        const receipt = Object.values(state.stopReceipts).find((item) => item.stopRequestId === prior.stopRequestId);
        stopRequest = clone(prior);
        existingReceipt = receipt ? clone(receipt) : null;
        alreadyComplete = true;
        return;
      }
      if (typeof trustedController.readStopAuthority !== "function") {
        throw new Error("Stopping requires a separate trusted owned-scope stop authority");
      }
      await validateStopAuthority(
        await trustedController.readStopAuthority({
          runId: handle.runId,
          executionId: handle.executionId,
          attemptId: handle.attemptId,
          unitId: handle.unitId,
          ownedResourceId: handle.ownedResourceId
        }),
        handle
      );
      stopRequest = {
        schemaVersion: 1,
        kind: STOP_REQUEST_KIND,
        stopRequestId: randomUUID(),
        handleId,
        runId: handle.runId,
        executionId: handle.executionId,
        attemptId: handle.attemptId,
        unitId: handle.unitId,
        sourceBindingDigest: handle.sourceBindingDigest,
        policyDigest: handle.policyDigest,
        revision: handle.revision,
        authorityEpoch: handle.authorityEpoch,
        fence: handle.fence,
        ownedResourceId: handle.ownedResourceId,
        reason,
        requestedBy,
        requestedAt: nowIso(safeClockValue),
        securityRcaRequired: reason === "security-p0",
        status: "requested"
      };
      validateStopRequest(stopRequest);
      const nextHandle = {
        ...handle,
        status: "revoked",
        dispatchBlocked: true,
        revokedAt: nowIso(safeClockValue)
      };
      const nextIntents = { ...state.intents };
      for (const intent of Object.values(nextIntents)) {
        if (intent.handleId !== handleId || intent.status !== "pending") continue;
        nextIntents[intent.intentId] = { ...intent, status: "cancelled", outcome: "unknown", unknownReason: "stop-requested" };
      }
      const next = withRegistryDigest({
        ...state,
        sequence: state.sequence + 1,
        handles: { ...state.handles, [handleId]: nextHandle },
        intents: nextIntents,
        stopRequests: { ...state.stopRequests, [stopRequest.stopRequestId]: stopRequest }
      });
      await persistUnlocked(state, next, "stop.requested", { stopRequestId: stopRequest.stopRequestId, handleId, reason });
    }).catch(async (error) => {
      // Even if a journal writer fails, the trusted stop adapter is still
      // invoked as an emergency attempt.  The caller receives the persistence
      // error and must reconcile; no successful receipt is fabricated.
      if (alreadyComplete) throw error;
      const fallback = {
        request: stopRequest ? clone(stopRequest) : { handleId, reason, requestedBy, emergency: true },
        ownedResourceId: stopRequest?.ownedResourceId ?? null,
        scope: { handleId, runId }
      };
      if (resourceAdapter) {
        try { await resourceAdapter.stopOwned(fallback); } catch { /* preserve original persistence failure */ }
      }
      error.emergencyStopAttempted = Boolean(resourceAdapter);
      throw error;
    });
    if (alreadyComplete) return existingReceipt;
    let adapterResult;
    if (resourceAdapter) {
      try {
        adapterResult = await resourceAdapter.stopOwned({
          request: clone(stopRequest),
          ownedResourceId: stopRequest.ownedResourceId,
          scope: { handleId: stopRequest.handleId, runId: stopRequest.runId }
        });
      } catch (error) {
        adapterResult = { localOutcome: "unknown", remoteOutcome: "unknown", confirmedOwnedScope: false, error: String(error?.message ?? error) };
      }
    } else {
      adapterResult = { localOutcome: "unknown", remoteOutcome: "not-sent", confirmedOwnedScope: false, message: "No owned-resource adapter is configured" };
    }
    const receipt = createStopReceipt(stopRequest, adapterResult, safeClockValue);
    try {
      await withRegistryLockWaiting(async () => {
        const state = await readRecovered();
        const handle = state.handles[handleId];
        const finalHandleStatus = receipt.outcome === "STOPPED" ? "stopped" : "indeterminate";
        const next = withRegistryDigest({
          ...state,
          sequence: state.sequence + 1,
          handles: { ...state.handles, [handleId]: { ...handle, status: finalHandleStatus, dispatchBlocked: true } },
          stopReceipts: { ...state.stopReceipts, [receipt.stopReceiptId]: receipt }
        });
        await persistUnlocked(state, next, "stop.receipt.sealed", { stopReceiptId: receipt.stopReceiptId, stopRequestId: stopRequest.stopRequestId, outcome: receipt.outcome });
      });
    } catch (error) {
      error.stopReceipt = receipt;
      error.emergencyStopAttempted = true;
      throw error;
    }
    return clone(receipt);
  }

  async function resumeExecution(handleId, { executionId, attemptId, reason = "resume" } = {}) {
    assertId(handleId, "resume.handleId");
    assertId(executionId, "resume.executionId");
    assertId(attemptId, "resume.attemptId");
    assertText(reason, "resume.reason");
    return withRegistryLock(async () => {
      let state = await readRecovered();
      const oldHandle = state.handles[handleId];
      if (!oldHandle) throw new Error("Execution handle was not found");
      const oldIntent = Object.values(state.intents).find((intent) => intent.handleId === handleId && intent.status === "not-sent");
      const currentIntent = findIntentForHandle(state, handleId);
      const notSentResume = oldHandle.status === "ready" && oldIntent?.callbackCalls === 0 && oldIntent.dispatchReserved === false;
      // Cleanup is retained as a physical lifecycle observation.  Neither it
      // nor a fresh grant may stand in for the old effect's outcome proof.
      if (recoveryNeedsReconciliation(oldHandle, currentIntent)) {
        const blocked = new Error("UNKNOWN execution requires a fresh provider reconciliation before resume");
        blocked.code = "EEXECUTION_RECONCILIATION_REQUIRED";
        blocked.status = "UNKNOWN";
        throw blocked;
      }
      if (!["revoked", "stopped", "failed", "indeterminate"].includes(oldHandle.status) && !notSentResume) {
        throw new Error("Only stopped, failed, or not-sent handles can be resumed");
      }
      if (attemptId === oldHandle.attemptId) {
        throw new Error("Resume must use a new attempt identity");
      }
      const binding = bindingFromInput({
        runId,
        executionId,
        attemptId,
        unitId: oldHandle.unitId,
        sourceBindingDigest: oldHandle.sourceBindingDigest,
        policyDigest: oldHandle.policyDigest,
        revision: oldHandle.revision,
        ownedResourceId: oldHandle.ownedResourceId
      }, { label: "resume binding" });
      const fresh = await readFreshControllerBinding(trustedController, binding, { clock: safeClockValue });
      assertNativeV3AutoCommandExecutionAllowed(fresh.runContract.plan);
      if (fresh.authority.authorityEpoch <= oldHandle.authorityEpoch) throw new Error("Resume must use a fresh authority epoch");
      const oldAdmissions = lastAdmissionLedger;
      const oldAdmission = oldAdmissions.get(oldHandle.handleId) ?? null;
      if (oldAdmission && !fresh.admission) throw new Error("V3 recovery requires a fresh V3 admission");
      if (oldAdmission && fresh.admission && reservationKey(oldAdmission) === reservationKey(fresh.admission)) {
        throw new Error("V3 recovery cannot reuse the prior admission nonce");
      }
      if (fresh.admission) {
        for (const [priorHandleId, prior] of oldAdmissions) {
          if (priorHandleId === oldHandle.handleId) continue;
          if (reservationKey(prior) === reservationKey(fresh.admission) || prior.admissionId === fresh.admission.admissionId) {
            throw new Error("V3 recovery admission is already reserved by another handle");
          }
        }
      }
      const newHandle = buildHandle(binding, fresh.authority, safeClockValue, {
        runId: binding.runId,
        executionId: binding.executionId,
        attemptId: binding.attemptId,
        unitId: binding.unitId,
        sourceBindingDigest: binding.sourceBindingDigest,
        policyDigest: binding.policyDigest,
        revision: binding.revision,
        authorityEpoch: fresh.authority.authorityEpoch,
        fence: fresh.authority.fence,
        createdAt: nowIso(safeClockValue),
        resumedFromHandleId: oldHandle.handleId,
        priorAttemptId: oldHandle.attemptId
      }, fresh.admission);
      const plan = {
        schemaVersion: 1,
        kind: RECOVERY_PLAN_KIND,
        recoveryPlanId: randomUUID(),
        fromHandleId: oldHandle.handleId,
        newHandleId: newHandle.handleId,
        runId,
        executionId,
        unitId: oldHandle.unitId,
        priorAttemptId: oldHandle.attemptId,
        newAttemptId: attemptId,
        sourceBindingDigest: oldHandle.sourceBindingDigest,
        policyDigest: oldHandle.policyDigest,
        revision: oldHandle.revision,
        oldAuthorityEpoch: oldHandle.authorityEpoch,
        newAuthorityEpoch: fresh.authority.authorityEpoch,
        oldFence: oldHandle.fence,
        newFence: fresh.authority.fence,
        reason,
        status: "prepared",
        createdAt: nowIso(safeClockValue)
      };
      validateRecoveryPlan(plan);
      const next = withRegistryDigest({
        ...state,
        sequence: state.sequence + 1,
        handles: { ...state.handles, [newHandle.handleId]: newHandle },
        recoveryPlans: { ...state.recoveryPlans, [plan.recoveryPlanId]: plan }
      });
      await persistUnlocked(state, next, "recovery.prepared", {
        recoveryPlanId: plan.recoveryPlanId,
        fromHandleId: handleId,
        newHandleId: newHandle.handleId,
        ...(fresh.admission ? { admission: fresh.admission } : {})
      });
      return { handle: clone(newHandle), recoveryPlan: clone(plan) };
    });
  }

  const api = {
    schemaVersion: 1,
    kind: EXECUTION_RUNTIME_KIND,
    runId,
    root,
    runDir,
    registryPath,
    load,
    commitRecoveryHandoffBatch,
    claimRecoveryHandoff,
    authorizeRecoveryHandoffTaskRelease,
    consumeRecoveryHandoffTaskRelease,
    createRecoveryTaskEffectIntent,
    reserveRecoveryTaskEffectIntent,
    recordRecoveryTaskEffectNotSent,
    recordRecoveryTaskEffectUnknown,
    recordRecoveryTaskEffectLaunch,
    recordRecoveryTaskEffectOutcome,
    reconcileRecoveryTaskEffectOutcome,
    readRecoveryTaskEffectReconciliation,
    readRecoveryTaskEffectDispatchBoundary,
    readRecoveryHandoff,
    readRecoveryHandoffClaim,
    readRecoveryHandoffTaskRelease,
    readRecoveryHandoffTaskPermitConsumption,
    readRecoveryTaskEffectIntent,
    readRecoveryTaskEffectLaunch,
    readRecoveryTaskEffectOutcome,
    readSealedEffectArtifact,
    [RECOVERY_HANDOFF_READ_LEASE]: withRecoveryHandoffReadLease,
    createHandle,
    createExecutionHandle: createHandle,
    execute,
    requestStop,
    stop: requestStop,
    resumeExecution,
    reconcileUnknownExecution,
    recordOwnedCleanupResolution,
    reconcileAfterControllerStop,
    replay: async () => load({ reconcile: false })
  };
  return Object.freeze(api);
}

export async function openExecutionRegistry(options = {}) {
  return openExecutionRegistryInternal(options, { observationOnly: false });
}

export async function readExecutionSealedEffectArtifactV1(options = {}) {
  assertOwnDataObject(options, "readExecutionSealedEffectArtifactV1 options");
  exactKeys(
    options,
    Object.hasOwn(options, "registryRoot")
      ? ["stateRoot", "registryRoot", "runId", "controller", "intentId"]
      : ["stateRoot", "runId", "controller", "intentId"],
    "readExecutionSealedEffectArtifactV1 options"
  );
  const intentId = assertId(options.intentId, "readExecutionSealedEffectArtifactV1.intentId");
  const registry = await openExecutionRegistryInternal({
    stateRoot: options.stateRoot,
    ...(Object.hasOwn(options, "registryRoot") ? { registryRoot: options.registryRoot } : {}),
    runId: options.runId,
    controller: options.controller
  }, { observationOnly: true });
  return registry.readSealedEffectArtifact(intentId);
}

/** Observation-only readback with the exact persisted handle and intent. */
export async function readExecutionSealedEffectEvidenceV2(options = {}) {
  assertOwnDataObject(options, "readExecutionSealedEffectEvidenceV2 options");
  exactKeys(
    options,
    Object.hasOwn(options, "registryRoot")
      ? ["stateRoot", "registryRoot", "runId", "controller", "intentId"]
      : ["stateRoot", "runId", "controller", "intentId"],
    "readExecutionSealedEffectEvidenceV2 options"
  );
  const intentId = assertId(options.intentId, "readExecutionSealedEffectEvidenceV2.intentId");
  const registry = await openExecutionRegistryInternal({
    stateRoot: options.stateRoot,
    ...(Object.hasOwn(options, "registryRoot") ? { registryRoot: options.registryRoot } : {}),
    runId: options.runId,
    controller: options.controller
  }, { observationOnly: true });
  return registry.readSealedEffectArtifact(intentId, { includeBinding: true });
}

export async function readExecutionRecoveryHandoffV1(options = {}) {
  assertOwnDataObject(options, "readExecutionRecoveryHandoffV1 options");
  exactKeys(
    options,
    Object.hasOwn(options, "registryRoot")
      ? ["stateRoot", "registryRoot", "runId", "controller", "handoffId"]
      : ["stateRoot", "runId", "controller", "handoffId"],
    "readExecutionRecoveryHandoffV1 options"
  );
  const handoffId = assertId(options.handoffId, "readExecutionRecoveryHandoffV1.handoffId");
  const registry = await openExecutionRegistryInternal({
    stateRoot: options.stateRoot,
    ...(Object.hasOwn(options, "registryRoot") ? { registryRoot: options.registryRoot } : {}),
    runId: options.runId,
    controller: options.controller
  }, { observationOnly: true });
  return registry.readRecoveryHandoff(handoffId);
}

export async function readExecutionRecoveryHandoffClaimV1(options = {}) {
  assertOwnDataObject(options, "readExecutionRecoveryHandoffClaimV1 options");
  exactKeys(
    options,
    Object.hasOwn(options, "registryRoot")
      ? ["stateRoot", "registryRoot", "runId", "controller", "claimId"]
      : ["stateRoot", "runId", "controller", "claimId"],
    "readExecutionRecoveryHandoffClaimV1 options"
  );
  const claimId = assertId(options.claimId, "readExecutionRecoveryHandoffClaimV1.claimId");
  const registry = await openExecutionRegistryInternal({
    stateRoot: options.stateRoot,
    ...(Object.hasOwn(options, "registryRoot") ? { registryRoot: options.registryRoot } : {}),
    runId: options.runId,
    controller: options.controller
  }, { observationOnly: true });
  return registry.readRecoveryHandoffClaim(claimId);
}

export async function readExecutionRecoveryTaskReleaseV1(options = {}) {
  assertOwnDataObject(options, "readExecutionRecoveryTaskReleaseV1 options");
  exactKeys(
    options,
    Object.hasOwn(options, "registryRoot")
      ? ["stateRoot", "registryRoot", "runId", "controller", "releaseId"]
      : ["stateRoot", "runId", "controller", "releaseId"],
    "readExecutionRecoveryTaskReleaseV1 options"
  );
  const releaseId = assertId(options.releaseId, "readExecutionRecoveryTaskReleaseV1.releaseId");
  const registry = await openExecutionRegistryInternal({
    stateRoot: options.stateRoot,
    ...(Object.hasOwn(options, "registryRoot") ? { registryRoot: options.registryRoot } : {}),
    runId: options.runId,
    controller: options.controller
  }, { observationOnly: true });
  return registry.readRecoveryHandoffTaskRelease(releaseId);
}

export async function readExecutionRecoveryTaskPermitConsumptionV1(options = {}) {
  assertOwnDataObject(options, "readExecutionRecoveryTaskPermitConsumptionV1 options");
  exactKeys(
    options,
    Object.hasOwn(options, "registryRoot")
      ? ["stateRoot", "registryRoot", "runId", "controller", "consumptionId"]
      : ["stateRoot", "runId", "controller", "consumptionId"],
    "readExecutionRecoveryTaskPermitConsumptionV1 options"
  );
  const consumptionId = assertId(
    options.consumptionId,
    "readExecutionRecoveryTaskPermitConsumptionV1.consumptionId"
  );
  const registry = await openExecutionRegistryInternal({
    stateRoot: options.stateRoot,
    ...(Object.hasOwn(options, "registryRoot") ? { registryRoot: options.registryRoot } : {}),
    runId: options.runId,
    controller: options.controller
  }, { observationOnly: true });
  return registry.readRecoveryHandoffTaskPermitConsumption(consumptionId);
}

export async function readExecutionRecoveryTaskEffectIntentV1(options = {}) {
  assertOwnDataObject(options, "readExecutionRecoveryTaskEffectIntentV1 options");
  exactKeys(
    options,
    Object.hasOwn(options, "registryRoot")
      ? ["stateRoot", "registryRoot", "runId", "controller", "intentId"]
      : ["stateRoot", "runId", "controller", "intentId"],
    "readExecutionRecoveryTaskEffectIntentV1 options"
  );
  const intentId = assertId(options.intentId, "readExecutionRecoveryTaskEffectIntentV1.intentId");
  const registry = await openExecutionRegistryInternal({
    stateRoot: options.stateRoot,
    ...(Object.hasOwn(options, "registryRoot") ? { registryRoot: options.registryRoot } : {}),
    runId: options.runId,
    controller: options.controller
  }, { observationOnly: true });
  return registry.readRecoveryTaskEffectIntent(intentId);
}

export async function readExecutionRecoveryTaskEffectLaunchV1(options = {}) {
  assertOwnDataObject(options, "readExecutionRecoveryTaskEffectLaunchV1 options");
  exactKeys(
    options,
    Object.hasOwn(options, "registryRoot")
      ? ["stateRoot", "registryRoot", "runId", "controller", "launchId"]
      : ["stateRoot", "runId", "controller", "launchId"],
    "readExecutionRecoveryTaskEffectLaunchV1 options"
  );
  const launchId = assertId(options.launchId, "readExecutionRecoveryTaskEffectLaunchV1.launchId");
  const registry = await openExecutionRegistryInternal({
    stateRoot: options.stateRoot,
    ...(Object.hasOwn(options, "registryRoot") ? { registryRoot: options.registryRoot } : {}),
    runId: options.runId,
    controller: options.controller
  }, { observationOnly: true });
  return registry.readRecoveryTaskEffectLaunch(launchId);
}

export async function readExecutionRecoveryTaskEffectOutcomeV1(options = {}) {
  assertOwnDataObject(options, "readExecutionRecoveryTaskEffectOutcomeV1 options");
  exactKeys(
    options,
    Object.hasOwn(options, "registryRoot")
      ? ["stateRoot", "registryRoot", "runId", "controller", "outcomeId"]
      : ["stateRoot", "runId", "controller", "outcomeId"],
    "readExecutionRecoveryTaskEffectOutcomeV1 options"
  );
  const outcomeId = assertId(options.outcomeId, "readExecutionRecoveryTaskEffectOutcomeV1.outcomeId");
  const registry = await openExecutionRegistryInternal({
    stateRoot: options.stateRoot,
    ...(Object.hasOwn(options, "registryRoot") ? { registryRoot: options.registryRoot } : {}),
    runId: options.runId,
    controller: options.controller
  }, { observationOnly: true });
  return registry.readRecoveryTaskEffectOutcome(outcomeId);
}

export async function readExecutionRecoveryTaskEffectReconciliationV1(options = {}) {
  assertOwnDataObject(options, "readExecutionRecoveryTaskEffectReconciliationV1 options");
  exactKeys(options, ["stateRoot", "runId", "controller", "outcomeId", ...(Object.hasOwn(options, "registryRoot") ? ["registryRoot"] : [])],
    "readExecutionRecoveryTaskEffectReconciliationV1 options");
  const outcomeId = assertId(options.outcomeId, "readExecutionRecoveryTaskEffectReconciliationV1.outcomeId");
  const registry = await openExecutionRegistryInternal({ stateRoot: options.stateRoot, runId: options.runId, controller: options.controller,
    ...(Object.hasOwn(options, "registryRoot") ? { registryRoot: options.registryRoot } : {}) }, { observationOnly: true });
  return registry.readRecoveryTaskEffectReconciliation(outcomeId);
}

export async function withExecutionRecoveryHandoffReadLeaseV1(options = {}, callback) {
  assertOwnDataObject(options, "withExecutionRecoveryHandoffReadLeaseV1 options");
  exactKeys(
    options,
    Object.hasOwn(options, "registryRoot")
      ? ["stateRoot", "registryRoot", "runId", "controller", "handoffId"]
      : ["stateRoot", "runId", "controller", "handoffId"],
    "withExecutionRecoveryHandoffReadLeaseV1 options"
  );
  if (typeof callback !== "function") {
    throw new Error("withExecutionRecoveryHandoffReadLeaseV1 callback must be callable");
  }
  const handoffId = assertId(options.handoffId, "withExecutionRecoveryHandoffReadLeaseV1.handoffId");
  const registry = await openExecutionRegistryInternal({
    stateRoot: options.stateRoot,
    ...(Object.hasOwn(options, "registryRoot") ? { registryRoot: options.registryRoot } : {}),
    runId: options.runId,
    controller: options.controller
  }, { observationOnly: true });
  return registry[RECOVERY_HANDOFF_READ_LEASE](handoffId, callback);
}

export async function loadExecutionRegistry(options) {
  const registry = await openExecutionRegistry(options);
  return registry.load();
}

function normalizeEffectResult(value) {
  if (!isPlainObject(value)) throw new Error("Effect callback must return an object with outcome success or failure");
  assertSafeObject(value, "effect result");
  if (!["success", "failure"].includes(value.outcome)) throw new Error("Effect callback outcome must be success or failure; UNKNOWN is controller-owned");
  return { outcome: value.outcome, result: value };
}

// The V3 journal carries the exact bounded effect result that was sealed.  A
// caller-authored object is never permitted to lose values during JSON
// serialization and then acquire the digest of a different object.
function canonicalSealedEffect(value) {
  const seen = new Set();
  let entries = 0;
  const visit = (item, depth) => {
    if (depth > 32) throw new Error("Sealed effect exceeds the maximum JSON depth");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      if (Buffer.byteLength(item, "utf8") > MAX_SEALED_EFFECT_BYTES) throw new Error("Sealed effect string exceeds the byte limit");
      return item;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Object.is(item, -0) || (Number.isInteger(item) && !Number.isSafeInteger(item))) {
        throw new Error("Sealed effect contains a non-canonical number");
      }
      return item;
    }
    if (!item || typeof item !== "object" || utilTypes.isProxy(item) || seen.has(item)) {
      throw new Error("Sealed effect contains a non-JSON value or cycle");
    }
    seen.add(item);
    let output;
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 256 ||
          Reflect.ownKeys(item).length !== item.length + 1) {
        throw new Error("Sealed effect array is sparse or has extra properties");
      }
      output = [];
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new Error("Sealed effect array contains an accessor or hole");
        }
        if (++entries > 256) throw new Error("Sealed effect has too many entries");
        output.push(visit(descriptor.value, depth + 1));
      }
    } else {
      if (Reflect.ownKeys(item).length > 256) throw new Error("Sealed effect has too many entries");
      assertOwnDataObject(item, "sealed effect");
      output = {};
      for (const key of Object.keys(item).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (FORBIDDEN_KEYS.has(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value") ||
            Buffer.byteLength(key, "utf8") > MAX_SEALED_EFFECT_BYTES) {
          throw new Error("Sealed effect object contains an unsafe property");
        }
        if (++entries > 256) throw new Error("Sealed effect has too many entries");
        output[key] = visit(descriptor.value, depth + 1);
      }
      if (Reflect.ownKeys(item).length !== Object.keys(item).length) {
        throw new Error("Sealed effect object contains a hidden property");
      }
    }
    seen.delete(item);
    return output;
  };
  if (!isPlainObject(value)) throw new Error("Sealed effect must be a plain object");
  const effect = visit(value, 0);
  const canonicalJson = JSON.stringify(effect);
  const byteLength = Buffer.byteLength(canonicalJson, "utf8");
  if (byteLength > MAX_SEALED_EFFECT_BYTES) throw new Error("Sealed effect exceeds the byte limit");
  return { effect, canonicalJson, byteLength, digest: sha256Sync(canonicalJson) };
}
