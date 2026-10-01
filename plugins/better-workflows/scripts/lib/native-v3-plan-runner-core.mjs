import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  atomicWriteJson,
  canonicalJson,
  digestObject,
  ensurePrivateDir,
  getStateRoot,
  safeJoin,
  withRunLock
} from "./core.mjs";
import {
  readCheckpointJson,
  readCheckpointWithFence
} from "./native-v3-plan-checkpoint-reader.mjs";
import {
  buildExecutionAdmission,
  assertSameExecutionAdmission,
  digestExecutionAdmission,
  validateExecutionAdmission
} from "./execution-admission-v1.mjs";
import {
  isExecutionRuntimeEffectNotSent,
  openExecutionRegistry,
  readExecutionRecoveryTaskPermitConsumptionV1,
  readExecutionRecoveryTaskReleaseV1,
  validateExecutionHandleV1,
  validateStopReceiptV1
} from "./execution-runtime-v1.mjs";
import {
  readFreshWorkflowPlanV1,
  validateWorkflowPlanV1
} from "./workflow-plan-v1.mjs";
import { captureSourceBinding } from "./git.mjs";
import { openExecutionBudgetLedgerV1 } from "./execution-budget-ledger-v1.mjs";
import {
  OWNED_PROCESS_BEFORE_LAUNCH_MAX_MS,
  bindOwnedRecoveryLaunchVerifierV1,
  createOwnedProcessAdapterV1,
  readOwnedProcessLaunchEvidenceV1
} from "./owned-process-adapter-v1.mjs";
import {
  beginNativeV3PlanTaskPreparation,
  consumeNativeV3PlanTaskTransfer,
  isNativeV3PlanTaskAdapter,
  readNativeV3PlanTaskPreparation
} from "./native-v3-trusted-plan-producer.mjs";
import {
  NATIVE_V3_RECOVERY_COMMAND_ADOPTION_VALIDATION_KIND,
  prepareNativeV3RecoveryCommandAdoptionV1,
  revalidateNativeV3RecoveryCommandCanonicalV1
} from "./native-v3-command-runner.mjs";
import {
  createNativeV3VerificationConsumer,
  isNativeV3VerificationReceipt,
  isNativeV3VerificationTaskHandle,
  verifyNativeV3VerificationReceipt
} from "./native-v3-verification-consumer-v1.mjs";

export const NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION = 1;
export const NATIVE_V3_PLAN_RUNNER_KIND = "NativeV3PlanRunnerV1";
export const NATIVE_V3_PLAN_CHECKPOINT_KIND = "NativeV3PlanRunnerCheckpointV1";
export const NATIVE_V3_PLAN_CHECKPOINT_V2_SCHEMA_VERSION = 2;
export const NATIVE_V3_PLAN_CHECKPOINT_V2_KIND = "NativeV3PlanRunnerCheckpointV2";
export const NATIVE_V3_PLAN_RUN_RESULT_KIND = "NativeV3PlanRunResultV1";
export const NATIVE_V3_PLAN_RESUME_RECEIPT_KIND = "NativeV3PlanResumeTransitionReceiptV1";
export const NATIVE_V3_PLAN_INCIDENT_RECOVERY_RECEIPT_KIND = "NativeV3PlanIncidentRecoveryTransitionReceiptV1";
export const NATIVE_V3_PLAN_INCIDENT_RECOVERY_CLAIM_KIND = "NativeV3PlanIncidentRecoveryClaimV1";
export const NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_RELEASE_KIND = "NativeV3PlanIncidentRecoveryTaskReleaseV1";
export const NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_CONSUMPTION_KIND = "NativeV3PlanIncidentRecoveryTaskConsumptionV1";
export const NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_EFFECT_CAPABILITY_KIND = "NativeV3PlanIncidentRecoveryTaskEffectCapabilityV1";
export const NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_EFFECT_RESERVATION_KIND = "NativeV3PlanIncidentRecoveryTaskEffectReservationV1";
export const NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_EFFECT_TERMINAL_KIND = "NativeV3PlanIncidentRecoveryTaskEffectTerminalV1";
export const NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_COMMAND_ADOPTION_KIND = "NativeV3PlanIncidentRecoveryTaskCommandAdoptionV1";
// The outer runner/checkpoint identity remains V1 for compatibility with
// existing inspectors.  This nested version makes the meaning of usage
// fields explicit: a missing measurement is unknown, never an implicit zero.
export const NATIVE_V3_PLAN_USAGE_SCHEMA_VERSION = 2;

const PLAN_RUNNER_DIRECTORY = "native-v3-plan-runner-v1";
const CHECKPOINT_FILE = "checkpoint.json";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PARALLELISM = 32;
const DEFAULT_PARALLELISM = 2;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 5;
const STOP_WAIT_MS = 10_000;
// Private scheduler evidence, separate from the physical stop receipt. It
// binds the stop linearization to this exact invocation and cannot be copied
// into a caller-provided flag or inferred from STOPPED alone.
const EFFECT_NOT_STARTED_AT_STOP = new WeakMap();
const MAX_EVENTS = 16_384;
const RUN_STATUSES = new Set(["ready", "running", "paused", "cancelling", "succeeded", "failed", "hold", "unknown", "cancelled"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "hold", "unknown", "cancelled"]);
const TASK_STATUSES = new Set(["pending", "preparing", "dispatching", "succeeded", "failed", "hold", "unknown", "blocked", "cancelled"]);
const V2_TASK_STATUSES = new Set([...TASK_STATUSES, "awaiting-acceptance"]);
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "hold", "unknown", "blocked", "cancelled"]);
const V2_EFFECT_ACCEPTANCE_KIND = "NativeV3PlanEffectAcceptanceV1";
const STOP_REASONS = new Set(["cancel", "pause", "security-p0", "controller-failure"]);
const VERIFICATION_CHECKPOINT_KIND = "NativeV3PlanTaskVerificationCheckpointV1";
const OPTION_KEYS = new Set([
  "stateRoot", "root", "plan", "planId", "runId", "parallelism", "taskAdapter", "readFreshPlan", "clock", "abortSignal", "stopWaitMs"
]);
const CANCEL_KEYS = new Set(["reason"]);
const PAUSE_KEYS = new Set(["reason"]);
const RESUME_KEYS = new Set(["controlRequestDigest", "taskAdapter"]);
const INCIDENT_RECOVERY_TRANSITION_KEYS = new Set(["stateRoot", "root", "recoveryPlan", "handoffId", "controller"]);
const INCIDENT_RECOVERY_CLAIM_KEYS = new Set(["stateRoot", "root", "recoveryPlan", "handoffId", "controller"]);
const INCIDENT_RECOVERY_TASK_RELEASE_KEYS = new Set([
  "stateRoot", "root", "recoveryPlan", "handoffId", "claimId", "taskId", "controller"
]);
const INCIDENT_RECOVERY_TASK_CONSUMPTION_KEYS = new Set([
  "stateRoot", "root", "recoveryPlan", "handoffId", "claimId", "releaseId", "taskId", "controller"
]);
const INCIDENT_RECOVERY_TASK_EFFECT_CAPABILITY_KEYS = new Set(["consumptionReceipt"]);
const INCIDENT_RECOVERY_TASK_EFFECT_TERMINAL_KEYS = new Set(["reservation", "outcome", "reason"]);
const INCIDENT_RECOVERY_TASK_COMMAND_ADOPTION_KEYS = new Set([
  "reservation", "workspaceRoot", "bindingPath", "expectedCommandDigest", "approvalEnvelope",
  "effectBindingDigest", "trustMode", "requestedModel", "clock"
]);
const INCIDENT_RECOVERY_EVENT = "run.incident-recovery-prepared";
const INCIDENT_RECOVERY_EVENT_DETAIL_KIND = "NativeV3PlanIncidentRecoveryBoundaryV1";
const INCIDENT_RECOVERY_EFFECT_AUTHORITY = Object.freeze({
  mayResume: false,
  mayDispatch: false,
  mayPerformEffects: false
});
const INCIDENT_RECOVERY_PERMIT_EFFECT_AUTHORITY = Object.freeze({
  mayResume: false,
  mayUnblockHandle: false,
  mayDispatch: false,
  mayPerformEffects: false
});
const INCIDENT_RECOVERY_TASK_EFFECT_AUTHORITY = Object.freeze({
  mayCreateHandle: false,
  mayResume: false,
  mayUnblockHandle: false,
  mayDispatch: false,
  mayPerformEffects: false
});
const TRUSTED_PLAN_TASK_TRANSFER_KEYS = ["binding", "kind", "schemaVersion", "taskId", "unitId"].sort();
const TRUSTED_BINDING_KEYS = [
  "runId", "executionId", "attemptId", "unitId", "ownedResourceId", "sourceBindingDigest", "policyDigest", "revision"
].sort();

// These identities never cross the JSON boundary.  A checkpoint or a caller
// supplied object can describe a runner, but only the object returned by this
// factory can carry a transition receipt.
const TRUSTED_PLAN_RUNNERS = new WeakSet();
const PLAN_RESUME_RECEIPTS = new WeakMap();
const PLAN_RESUME_LINEAGES = new WeakMap();
const PLAN_RECOVERY_TASK_CONSUMPTION_RECEIPTS = new WeakSet();
const PLAN_RECOVERY_TASK_CONSUMPTION_BINDINGS = new WeakMap();
const PLAN_RECOVERY_TASK_CONSUMPTION_ISSUANCE = new Map();
const PLAN_RECOVERY_TASK_EFFECT_CAPABILITIES = new WeakMap();
const PLAN_RECOVERY_TASK_EFFECT_RESERVATIONS = new WeakMap();
const PLAN_RECOVERY_TASK_COMMAND_ADOPTIONS = new WeakMap();
const PLAN_RECOVERY_TASK_COMMAND_EXECUTIONS = new WeakMap();
const PLAN_RECOVERY_PENDING_OUTCOMES = new WeakMap();
// A persisted checkpoint carries a digest chain, but a digest alone is not an
// authenticity proof for a later progress snapshot.  Keep a process-local
// weak registry of native runners so a read in the owner process can require
// that the current checkpoint was actually emitted by that runner.  A fresh
// process deliberately cannot promote an untrusted later snapshot; it may
// still verify the exact transition checkpoint carried by the receipt.
const TRUSTED_PLAN_RUNNER_REGISTRY = new Map();

export class NativeV3PlanRunnerError extends Error {
  constructor(code, message, status = "HOLD") {
    super(message);
    this.name = "NativeV3PlanRunnerError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = "HOLD") {
  throw new NativeV3PlanRunnerError(code, message, status);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactOptions(value, allowed, label) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) fail("EPLAN_RUNNER_INPUT", `${label} must be a plain object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) fail("EPLAN_RUNNER_INPUT", `${label} contains unknown option(s): ${unknown.join(", ")}`);
  return value;
}

function text(value, label, pattern = null, max = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("EPLAN_RUNNER_INPUT", `${label} is invalid`);
  }
  if (pattern && !pattern.test(value)) fail("EPLAN_RUNNER_INPUT", `${label} is invalid`);
  return value;
}

function absolute(value, label) {
  const supplied = text(value, label);
  if (!path.isAbsolute(supplied)) fail("EPLAN_RUNNER_INPUT", `${label} must be absolute`);
  return path.resolve(supplied);
}

function id(value, label) {
  return text(value, label, ID, 256);
}

function digest(value, label) {
  return text(value, label, DIGEST, 64);
}

function taskId(value, label) {
  return text(value, label, TASK_ID, 128);
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  // AbortSignal is a live capability owned by this runner. Freezing it makes
  // AbortController.abort() fail when Node updates its internal state.
  if (value.constructor?.name === "AbortSignal") return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function currentDate(clock) {
  const value = clock?.now?.() ?? new Date();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("EPLAN_RUNNER_INPUT", "clock.now() must return a valid date");
  return date;
}

function nowIso(clock) {
  return currentDate(clock).toISOString();
}

function boundedInteger(value, label, { min = 0, max = 1_000_000 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("EPLAN_RUNNER_INPUT", `${label} must be a bounded integer`);
  }
  return value;
}

function validateAbortSignal(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function" || typeof value.removeEventListener !== "function") {
    fail("EPLAN_RUNNER_INPUT", `${label} must be an AbortSignal`);
  }
  return value;
}

function delay(milliseconds, { keepAlive = false } = {}) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, milliseconds);
    // Lease polling may be unreferenced, but cleanup deadlines are passed
    // with keepAlive so a pending top-level await cannot turn into exit 13
    // before the runner records its bounded UNKNOWN/HOLD result.
    if (!keepAlive) timer.unref?.();
  });
  promise.cancel = () => clearTimeout(timer);
  return promise;
}

function ownerProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still means that a process exists.  This runner intentionally
    // treats same-UID owner loss as a liveness observation, not host
    // attestation; the runtime registry remains the authority for effects.
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    return null;
  }
}

function isLeaseConflict(error) {
  return /^Run is leased by pid /.test(String(error?.message ?? ""));
}

function errorProjection(error, fallbackCode = "EPLAN_RUNNER_TASK") {
  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code.slice(0, 128) : fallbackCode;
  const message = String(error?.message ?? error ?? "unknown error").slice(0, 1024);
  const status = ["HOLD", "UNKNOWN"].includes(error?.status) ? error.status : null;
  return { code, message, status };
}

function errorClass(error) {
  if (error?.status === "UNKNOWN" || error?.code === "EEXECUTION_EFFECT_UNKNOWN" || error?.code === "ENATIVE_V3_EXECUTION_UNKNOWN") {
    return "unknown";
  }
  return "hold";
}

function unknownUsage() {
  return { seconds: null, tokens: null };
}

function addUsage(previous, observed) {
  return previous === null || observed === null ? null : previous + observed;
}

function accumulatedUsage(previous, observed) {
  return {
    seconds: addUsage(previous.seconds, observed.seconds),
    tokens: addUsage(previous.tokens, observed.tokens)
  };
}

// Expose the deterministic accounting projection for focused contract tests;
// it carries no authority and never turns an unknown dimension into a value.
export function accumulateNativeV3PlanUsage(previous, observed) {
  return accumulatedUsage(previous, observed);
}

function unknownUsageDimensions(value) {
  return ["seconds", "tokens"].filter((dimension) => value[dimension] === null);
}

function hasNotStartedProof(entry, stopResult) {
  // Once the runner invoked the effect callback, a later not-sent-shaped
  // error or STOPPED receipt cannot retroactively prove that no effect ran.
  if (entry?.effectStarted === true) return false;
  const proof = entry ? EFFECT_NOT_STARTED_AT_STOP.get(entry) : null;
  const ownedNeverDispatched = proof && proof.invocation === entry.preparationInvocation &&
    proof.attemptId === entry.attemptId && proof.cleanup === entry.preAdmissionCleanup &&
    stopResult?.kind === "stopped";
  return entry?.notSentProof === true || stopResult?.kind === "not-started" || Boolean(ownedNeverDispatched);
}

function markUnobservedUsage(state, taskState, entry = null, stopResult = null) {
  // A zero is a fact about an attempt that was proven never to enter the
  // effect boundary.  A STOPPED receipt alone is insufficient: the effect
  // may have started before the stop observation.  Preserve no fabricated
  // charge and make the aggregate sticky UNKNOWN until reconciliation.
  if (hasNotStartedProof(entry, stopResult)) return false;
  taskState.usage = unknownUsage();
  state.budget.secondsUsed = null;
  state.budget.tokensUsed = null;
  return true;
}

function taskHasNotStartedProof(state, taskState) {
  if (taskState.attempts === 0 && taskState.dispatches === 0) return true;
  if (taskState.status === "preparing" && taskState.startedAt === null) {
    // Reserve/preparation is persisted before the dispatching transition.  A
    // task still in that state has no durable effect-entry marker; keep the
    // initial zero only when the event chain also lacks that transition.
    return !state.events.some((event) => event.taskId === taskState.taskId &&
      event.attemptId === taskState.attemptId && event.type === "task.dispatching");
  }
  // Read only the latest attempt's stop/pause proof. A later reservation or
  // dispatch fences an older event, including a retained legacy not-started.
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index];
    if (event.taskId !== taskState.taskId) continue;
    if (["task.reserved", "task.dispatching"].includes(event.type)) break;
    const sameAttempt = event.attemptId === taskState.attemptId ||
      (taskState.attemptId === null && event.type === "task.pause-observed" && event.detail?.retryable === true);
    if (!sameAttempt || !["task.stop-observed", "task.pause-observed"].includes(event.type)) continue;
    if (event.detail?.outcome === "not-started" ||
        (event.detail?.outcome === "stopped" && event.detail?.effectNotStarted === true)) return true;
  }
  return false;
}

function validateUsage(value, label = "usage") {
  if (value === undefined || value === null) return unknownUsage();
  if (!isPlainObject(value)) fail("EPLAN_RUNNER_TASK_RESULT", `${label} must be a plain object`);
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !["seconds", "tokens"].includes(key))) {
    fail("EPLAN_RUNNER_TASK_RESULT", `${label} contains unknown fields`);
  }
  // Validate and retain each dimension independently.  A missing or null
  // dimension is unknown, while a known sibling remains usable for bounded
  // accounting.  This prevents an incomplete observation from becoming zero
  // without discarding the lower-bound fact that was actually observed.
  const seconds = !Object.hasOwn(value, "seconds") || value.seconds === undefined || value.seconds === null
    ? null
    : boundedInteger(value.seconds, `${label}.seconds`);
  const tokens = !Object.hasOwn(value, "tokens") || value.tokens === undefined || value.tokens === null
    ? null
    : boundedInteger(value.tokens, `${label}.tokens`);
  return {
    seconds,
    tokens
  };
}

export function validateNativeV3PlanTaskResult(value) {
  if (!isPlainObject(value)) fail("EPLAN_RUNNER_TASK_RESULT", "task runner result must be a plain object");
  if (value.outcome !== "success" && value.outcome !== "failure") {
    fail("EPLAN_RUNNER_TASK_RESULT", "task runner result outcome must be success or failure");
  }
  return { outcome: value.outcome, usage: validateUsage(value.usage) };
}

function checkpointBody(value) {
  const { stateDigest: ignored, ...body } = value;
  return body;
}

function sealCheckpoint(value) {
  const next = { ...value };
  delete next.stateDigest;
  next.stateDigest = digestObject(checkpointBody(next));
  return next;
}

function validateErrorProjection(value, label) {
  if (value === null) return null;
  if (!isPlainObject(value)) fail("EPLAN_RUNNER_STATE_INVALID", `${label} must be an object`);
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "code,message,status" || typeof value.code !== "string" ||
      typeof value.message !== "string" || (value.status !== null && !["HOLD", "UNKNOWN"].includes(value.status))) {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} is invalid`);
  }
  return { code: value.code, message: value.message, status: value.status };
}

function validateRelativeReceiptPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || value.includes("\0") ||
      path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value === "." || value.startsWith("../") || value.includes("/../")) {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} is invalid`);
  }
  return value;
}

function validateVerificationCheckpoint(value, expectedTask, label) {
  const hasVerification = expectedTask.verification !== undefined;
  if (!hasVerification) {
    if (value !== undefined) fail("EPLAN_RUNNER_STATE_INVALID", `${label} is not allowed for an unverified task`);
    return value;
  }
  if (value === null) return null;
  if (!isPlainObject(value)) fail("EPLAN_RUNNER_STATE_INVALID", `${label} must be an object or null`);
  const expectedKeys = [
    "schemaVersion", "kind", "taskId", "attemptId", "mode", "status", "receiptDigest", "receiptPath",
    "unitId", "unitDigest", "cacheKey", "runId", "epoch", "unrelatedHeadDigest", "sourceBindingDigest",
    "relevantRevisionDigest", "actionAdmissionDigest", "revisionReadyDigest", "finalFreezeDigest", "cycle",
    "accepted", "effectAuthorized"
  ].sort();
  if (Object.keys(value).sort().join(",") !== expectedKeys.join(",")) {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} has an unexpected shape`);
  }
  if (value.schemaVersion !== 1 || value.kind !== VERIFICATION_CHECKPOINT_KIND || value.taskId !== expectedTask.id ||
      value.mode !== expectedTask.verification.mode || !["pass", "fail", "hold", "unknown"].includes(value.status)) {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} identity/status is invalid`);
  }
  id(value.attemptId, `${label}.attemptId`);
  digest(value.receiptDigest, `${label}.receiptDigest`);
  validateRelativeReceiptPath(value.receiptPath, `${label}.receiptPath`);
  id(value.unitId, `${label}.unitId`);
  for (const key of [
    "unitDigest", "cacheKey", "unrelatedHeadDigest", "sourceBindingDigest", "relevantRevisionDigest", "actionAdmissionDigest"
  ]) digest(value[key], `${label}.${key}`);
  id(value.runId, `${label}.runId`);
  boundedInteger(value.epoch, `${label}.epoch`);
  for (const key of ["revisionReadyDigest", "finalFreezeDigest"]) {
    if (value[key] !== null) digest(value[key], `${label}.${key}`);
  }
  if (value.cycle !== null && typeof value.cycle !== "boolean") fail("EPLAN_RUNNER_STATE_INVALID", `${label}.cycle is invalid`);
  if (typeof value.accepted !== "boolean" || typeof value.effectAuthorized !== "boolean" ||
      value.accepted !== false || value.effectAuthorized !== false) {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} cannot carry action authority`);
  }
  if (value.status === "pass" && (value.revisionReadyDigest === null || value.finalFreezeDigest === null || value.cycle !== false)) {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} pass status is missing an acyclic revision freeze`);
  }
  if (value.status !== "pass" && (value.revisionReadyDigest !== null || value.finalFreezeDigest !== null || value.cycle !== null)) {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} non-pass status carries revision-freeze evidence`);
  }
  return value;
}

function checkpointFormat(value) {
  if (value?.schemaVersion === NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION && value.kind === NATIVE_V3_PLAN_CHECKPOINT_KIND) return 1;
  if (value?.schemaVersion === NATIVE_V3_PLAN_CHECKPOINT_V2_SCHEMA_VERSION && value.kind === NATIVE_V3_PLAN_CHECKPOINT_V2_KIND) return 2;
  fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint version/kind is invalid");
}

function validateV2EffectAcceptance(value, task, runId) {
  const label = `tasks.${task.taskId}.effectAcceptance`;
  if (value === null) {
    if (task.status === "awaiting-acceptance" || task.status === "succeeded") {
      fail("EPLAN_RUNNER_STATE_INVALID", `${label} is required for this task status`);
    }
    return;
  }
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== [
    "schemaVersion", "kind", "status", "runId", "taskId", "attemptId", "unitId", "executionId", "handleId", "intentId",
    "outcome", "effectDigest", "effectByteLength", "journalSequence", "journalStateDigest", "acceptedAt"
  ].sort().join(",")) fail("EPLAN_RUNNER_STATE_INVALID", `${label} has an unexpected shape`);
  if (value.schemaVersion !== 1 || value.kind !== V2_EFFECT_ACCEPTANCE_KIND ||
      !["awaiting", "accepted"].includes(value.status) || value.runId !== runId ||
      value.taskId !== task.taskId || value.attemptId !== task.attemptId ||
      value.unitId !== task.unitId || value.executionId !== task.executionId ||
      value.outcome !== "success") {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} identity or outcome is invalid`);
  }
  id(value.runId, `${label}.runId`);
  taskId(value.taskId, `${label}.taskId`);
  for (const key of ["attemptId", "unitId", "executionId"]) id(value[key], `${label}.${key}`);
  if (task.attempts < 1 || task.dispatches < 1 || task.admissionDigest === null || task.startedAt === null) {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} has no dispatched attempt or admission`);
  }
  id(value.handleId, `${label}.handleId`);
  id(value.intentId, `${label}.intentId`);
  digest(value.effectDigest, `${label}.effectDigest`);
  boundedInteger(value.effectByteLength, `${label}.effectByteLength`, { min: 1, max: 4096 });
  boundedInteger(value.journalSequence, `${label}.journalSequence`, { min: 1 });
  digest(value.journalStateDigest, `${label}.journalStateDigest`);
  if (value.status === "awaiting" && (task.status !== "awaiting-acceptance" || value.acceptedAt !== null)) {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} awaiting status is inconsistent`);
  }
  if (value.status === "accepted" && (task.status !== "succeeded" ||
      typeof value.acceptedAt !== "string" || !Number.isFinite(Date.parse(value.acceptedAt)))) {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} accepted status is inconsistent`);
  }
  if (value.status === "accepted" && (task.outcome !== "success" || task.finishedAt === null)) {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} accepted task outcome is invalid`);
  }
  if (task.status === "awaiting-acceptance" && (task.outcome !== "success" || task.finishedAt !== null)) {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} awaiting task outcome is invalid`);
  }
}

function validateTaskCheckpoint(value, expectedTask, { format = 1, runId = null } = {}) {
  if (!isPlainObject(value)) fail("EPLAN_RUNNER_STATE_INVALID", `tasks.${expectedTask.id} must be an object`);
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "taskId", "dependencies", "role", "writeOwner", "status", "attempts", "dispatches", "attemptId", "unitId",
    "executionId", "admissionDigest", "startedAt", "finishedAt", "outcome", "lastError", "stopReceipt", "usage",
    ...(format === 2 ? ["effectAcceptance"] : []),
    ...(expectedTask.verification === undefined ? [] : ["verification"])
  ].sort();
  if (keys.join(",") !== expectedKeys.join(",")) fail("EPLAN_RUNNER_STATE_INVALID", `tasks.${expectedTask.id} has an unexpected shape`);
  if (value.taskId !== expectedTask.id || !(format === 2 ? V2_TASK_STATUSES : TASK_STATUSES).has(value.status)) {
    fail("EPLAN_RUNNER_STATE_INVALID", `tasks.${expectedTask.id} identity/status is invalid`);
  }
  if (!same(value.dependencies, expectedTask.dependencies) || value.role !== expectedTask.role || !same(value.writeOwner, expectedTask.writeOwner)) {
    fail("EPLAN_RUNNER_STATE_INVALID", `tasks.${expectedTask.id} immutable graph binding changed`);
  }
  boundedInteger(value.attempts, `tasks.${expectedTask.id}.attempts`);
  boundedInteger(value.dispatches, `tasks.${expectedTask.id}.dispatches`);
  for (const [key, pattern] of [["attemptId", ID], ["unitId", ID], ["executionId", ID]]) {
    if (value[key] !== null && (typeof value[key] !== "string" || !pattern.test(value[key]))) {
      fail("EPLAN_RUNNER_STATE_INVALID", `tasks.${expectedTask.id}.${key} is invalid`);
    }
  }
  if (value.admissionDigest !== null) digest(value.admissionDigest, `tasks.${expectedTask.id}.admissionDigest`);
  for (const key of ["startedAt", "finishedAt"]) {
    if (value[key] !== null && (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key])))) {
      fail("EPLAN_RUNNER_STATE_INVALID", `tasks.${expectedTask.id}.${key} is invalid`);
    }
  }
  if (value.outcome !== null && !["success", "failure", "unknown", "hold", "cancelled", "blocked"].includes(value.outcome)) {
    fail("EPLAN_RUNNER_STATE_INVALID", `tasks.${expectedTask.id}.outcome is invalid`);
  }
  validateErrorProjection(value.lastError, `tasks.${expectedTask.id}.lastError`);
  if (value.stopReceipt !== null) validateStopReceiptV1(value.stopReceipt);
  if (!isPlainObject(value.usage) || Object.keys(value.usage).sort().join(",") !== "seconds,tokens") {
    fail("EPLAN_RUNNER_STATE_INVALID", `tasks.${expectedTask.id}.usage is invalid`);
  }
  const usageLabel = `tasks.${expectedTask.id}.usage`;
  for (const dimension of ["seconds", "tokens"]) {
    if (value.usage[dimension] !== null) boundedInteger(value.usage[dimension], `${usageLabel}.${dimension}`);
  }
  validateVerificationCheckpoint(value.verification, expectedTask, `tasks.${expectedTask.id}.verification`);
  if (format === 2) validateV2EffectAcceptance(value.effectAcceptance, value, runId);
  return value;
}

function validateSortedTaskIds(value, label) {
  if (!Array.isArray(value) || value.length > 256) fail("EPLAN_RUNNER_STATE_INVALID", `${label} is invalid`);
  const normalized = value.map((item, index) => taskId(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length ||
      normalized.some((item, index) => index > 0 && item < normalized[index - 1])) {
    fail("EPLAN_RUNNER_STATE_INVALID", `${label} must be unique and sorted`);
  }
  return normalized;
}

function validateIncidentRecoveryEventDetail(value, plan) {
  if (!isPlainObject(value)) fail("EPLAN_RUNNER_STATE_INVALID", "incident recovery event detail must be an object");
  const expectedKeys = [
    "schemaVersion", "kind", "recoveryId", "recoveryPlanDigest", "handoffId", "handoffDigest",
    "sourceCheckpointSequence", "sourceCheckpointStateDigest", "sourceRegistrySequence", "sourceRegistryStateDigest",
    "committedRegistrySequence", "committedRegistryStateDigest", "taskIds", "preservedTaskIds", "sourceTasks", "entries",
    "effectAuthority"
  ].sort();
  if (Object.keys(value).sort().join(",") !== expectedKeys.join(",")) {
    fail("EPLAN_RUNNER_STATE_INVALID", "incident recovery event detail has an unexpected shape");
  }
  if (value.schemaVersion !== 1 || value.kind !== INCIDENT_RECOVERY_EVENT_DETAIL_KIND) {
    fail("EPLAN_RUNNER_STATE_INVALID", "incident recovery event detail version/kind is invalid");
  }
  id(value.recoveryId, "incident recovery event recoveryId");
  digest(value.recoveryPlanDigest, "incident recovery event recoveryPlanDigest");
  id(value.handoffId, "incident recovery event handoffId");
  digest(value.handoffDigest, "incident recovery event handoffDigest");
  boundedInteger(value.sourceCheckpointSequence, "incident recovery event sourceCheckpointSequence");
  digest(value.sourceCheckpointStateDigest, "incident recovery event sourceCheckpointStateDigest");
  boundedInteger(value.sourceRegistrySequence, "incident recovery event sourceRegistrySequence");
  digest(value.sourceRegistryStateDigest, "incident recovery event sourceRegistryStateDigest");
  boundedInteger(value.committedRegistrySequence, "incident recovery event committedRegistrySequence", { min: 1 });
  digest(value.committedRegistryStateDigest, "incident recovery event committedRegistryStateDigest");
  if (value.committedRegistrySequence !== value.sourceRegistrySequence + 1) {
    fail("EPLAN_RUNNER_STATE_INVALID", "incident recovery event registry transition is invalid");
  }
  const taskIds = validateSortedTaskIds(value.taskIds, "incident recovery event taskIds");
  const preservedTaskIds = validateSortedTaskIds(value.preservedTaskIds, "incident recovery event preservedTaskIds");
  if (taskIds.length === 0 || taskIds.some((item) => preservedTaskIds.includes(item))) {
    fail("EPLAN_RUNNER_STATE_INVALID", "incident recovery event task sets are invalid");
  }
  if (!isPlainObject(value.sourceTasks) ||
      !same(Object.keys(value.sourceTasks).sort(), taskIds)) {
    fail("EPLAN_RUNNER_STATE_INVALID", "incident recovery event sourceTasks do not exactly cover taskIds");
  }
  const expectedTasks = new Map(plan.taskContract.graph.tasks.map((task) => [task.id, task]));
  for (const taskIdValue of taskIds) {
    const expectedTask = expectedTasks.get(taskIdValue);
    if (!expectedTask) fail("EPLAN_RUNNER_STATE_INVALID", `incident recovery source task ${taskIdValue} is not in the plan`);
    validateTaskCheckpoint(value.sourceTasks[taskIdValue], expectedTask);
  }
  if (!Array.isArray(value.entries) || value.entries.length !== taskIds.length) {
    fail("EPLAN_RUNNER_STATE_INVALID", "incident recovery event entries do not exactly cover taskIds");
  }
  const handleIds = new Set();
  const admissionDigests = new Set();
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = value.entries[index];
    if (!isPlainObject(entry) || Object.keys(entry).sort().join(",") !==
        ["admissionDigest", "attemptId", "handleDigest", "handleId", "taskId"].sort().join(",")) {
      fail("EPLAN_RUNNER_STATE_INVALID", `incident recovery event entries[${index}] has an unexpected shape`);
    }
    if (taskId(entry.taskId, `incident recovery event entries[${index}].taskId`) !== taskIds[index]) {
      fail("EPLAN_RUNNER_STATE_INVALID", `incident recovery event entries[${index}] is not sorted with taskIds`);
    }
    id(entry.handleId, `incident recovery event entries[${index}].handleId`);
    id(entry.attemptId, `incident recovery event entries[${index}].attemptId`);
    digest(entry.handleDigest, `incident recovery event entries[${index}].handleDigest`);
    digest(entry.admissionDigest, `incident recovery event entries[${index}].admissionDigest`);
    if (handleIds.has(entry.handleId) || admissionDigests.has(entry.admissionDigest)) {
      fail("EPLAN_RUNNER_STATE_INVALID", "incident recovery event reuses a runtime or admission identity");
    }
    handleIds.add(entry.handleId);
    admissionDigests.add(entry.admissionDigest);
  }
  if (!isPlainObject(value.effectAuthority) ||
      Object.keys(value.effectAuthority).sort().join(",") !== Object.keys(INCIDENT_RECOVERY_EFFECT_AUTHORITY).sort().join(",") ||
      !same(value.effectAuthority, INCIDENT_RECOVERY_EFFECT_AUTHORITY)) {
    fail("EPLAN_RUNNER_STATE_INVALID", "incident recovery event must remain non-effecting");
  }
  return clone(value);
}

function validateCheckpoint(value, plan, expectedRoot = null, { allowLegacy = false, allowV2 = false } = {}) {
  if (!isPlainObject(value)) fail("EPLAN_RUNNER_STATE_INVALID", "plan runner checkpoint must be an object");
  const format = checkpointFormat(value);
  if (format === 2 && !allowV2) {
    fail("EPLAN_CHECKPOINT_V2_NOT_ACTIVE", "V2 checkpoint acceptance and recovery are not active", "HOLD");
  }
  const legacyUsageSchema = format === 1 && value.usageSchemaVersion === undefined;
  if (legacyUsageSchema && !allowLegacy) {
    fail("EPLAN_USAGE_SCHEMA_LEGACY", "legacy checkpoint has no trusted usage schema version; it cannot be resumed", "HOLD");
  }
  if (!legacyUsageSchema && value.usageSchemaVersion !== NATIVE_V3_PLAN_USAGE_SCHEMA_VERSION) {
    fail("EPLAN_USAGE_SCHEMA_UNSUPPORTED", "checkpoint usage schema version is unsupported", "HOLD");
  }
  const expectedKeys = [
    "schemaVersion", "kind", ...(legacyUsageSchema ? [] : ["usageSchemaVersion"]), "runId", "planId", "planDigest", "contractDigest", "parallelism", "status",
    "dispatchBlocked", "cancelRequested", "cancelReason", "failure", "ownerId", "ownerPid", "reconcileRequired", "budget", "tasks", "events",
    "sequence", "updatedAt", "stateDigest"
  ].sort();
  if (Object.keys(value).sort().join(",") !== expectedKeys.join(",")) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint has an unexpected shape");
  id(value.runId, "checkpoint.runId");
  id(value.planId, "checkpoint.planId");
  digest(value.planDigest, "checkpoint.planDigest");
  digest(value.contractDigest, "checkpoint.contractDigest");
  boundedInteger(value.parallelism, "checkpoint.parallelism", { min: 1, max: MAX_PARALLELISM });
  if (!RUN_STATUSES.has(value.status)) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint.status is invalid");
  if (typeof value.dispatchBlocked !== "boolean" || typeof value.cancelRequested !== "boolean") fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint dispatch flags are invalid");
  if (value.cancelReason !== null && !STOP_REASONS.has(value.cancelReason)) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint.cancelReason is invalid");
  if (value.status === "paused" && (value.dispatchBlocked !== true || value.cancelRequested !== false || value.cancelReason !== "pause")) {
    fail("EPLAN_RUNNER_STATE_INVALID", "paused checkpoint must remain dispatch-blocked with a pause reason");
  }
  validateErrorProjection(value.failure, "checkpoint.failure");
  if (value.ownerId !== null) id(value.ownerId, "checkpoint.ownerId");
  if (value.ownerPid !== null && (!Number.isSafeInteger(value.ownerPid) || value.ownerPid < 1)) {
    fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint.ownerPid is invalid");
  }
  if (typeof value.reconcileRequired !== "boolean") fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint.reconcileRequired is invalid");
  if (!isPlainObject(value.budget) || Object.keys(value.budget).sort().join(",") !== "attempts,attemptsUsed,seconds,secondsUsed,tokens,tokensUsed") {
    fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint.budget is invalid");
  }
  boundedInteger(value.budget.attempts, "checkpoint.budget.attempts", { min: 1 });
  boundedInteger(value.budget.attemptsUsed, "checkpoint.budget.attemptsUsed");
  for (const key of ["seconds", "tokens"]) {
    if (value.budget[key] !== null) boundedInteger(value.budget[key], `checkpoint.budget.${key}`, { min: 1 });
    if (value.budget[`${key}Used`] !== null) boundedInteger(value.budget[`${key}Used`], `checkpoint.budget.${key}Used`);
  }
  if (!isPlainObject(value.tasks)) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint.tasks must be an object");
  const expectedTasks = plan.taskContract.graph.tasks;
  const actualTaskIds = Object.keys(value.tasks).sort();
  const expectedTaskIds = expectedTasks.map((task) => task.id).sort();
  if (actualTaskIds.join(",") !== expectedTaskIds.join(",")) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint task universe changed");
  const expectedById = new Map(expectedTasks.map((task) => [task.id, task]));
  for (const taskIdValue of expectedTaskIds) {
    validateTaskCheckpoint(value.tasks[taskIdValue], expectedById.get(taskIdValue), { format, runId: value.runId });
  }
  if (!Array.isArray(value.events) || value.events.length > MAX_EVENTS) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint.events is invalid or exceeds the bound");
  let priorSequence = 0;
  for (const event of value.events) {
    if (!isPlainObject(event) || !Number.isSafeInteger(event.sequence) || event.sequence <= priorSequence ||
        typeof event.type !== "string" || typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at)) ||
        (event.taskId !== null && typeof event.taskId !== "string") || (event.attemptId !== null && typeof event.attemptId !== "string") ||
        (event.detail !== null && !isPlainObject(event.detail))) {
      fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint event is invalid");
    }
    if (event.previousStateDigest !== undefined) digest(event.previousStateDigest, "checkpoint event.previousStateDigest");
    if (event.type === INCIDENT_RECOVERY_EVENT) {
      if (format === 2) fail("EPLAN_V2_RECOVERY_UNSUPPORTED", "V2 incident recovery has no accepted consumer", "HOLD");
      const detail = validateIncidentRecoveryEventDetail(event.detail, plan);
      if (event.sequence !== detail.sourceCheckpointSequence + 1 ||
          event.previousStateDigest !== detail.sourceCheckpointStateDigest) {
        fail("EPLAN_RUNNER_STATE_INVALID", "incident recovery event is not bound to its source checkpoint");
      }
    }
    priorSequence = event.sequence;
  }
  boundedInteger(value.sequence, "checkpoint.sequence");
  if (value.sequence !== value.events.length) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint sequence is invalid");
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint.updatedAt is invalid");
  digest(value.stateDigest, "checkpoint.stateDigest");
  if (digestObject(checkpointBody(value)) !== value.stateDigest) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint state digest is invalid");
  if (expectedRoot) {
    if (value.planId !== expectedRoot.planId || value.planDigest !== expectedRoot.planDigest || value.contractDigest !== expectedRoot.contractDigest) {
      fail("EPLAN_RUNNER_STATE_DRIFT", "checkpoint is bound to a different immutable plan");
    }
    if (value.parallelism !== expectedRoot.parallelism) fail("EPLAN_RUNNER_STATE_DRIFT", "checkpoint parallelism changed");
  }
  return clone(value);
}

/**
 * Validate a persisted checkpoint as a pure snapshot bound to one immutable
 * WorkflowPlanV1.  This intentionally performs no filesystem read, owner
 * reconciliation, resume transition, or admission refresh.  Recovery
 * classifiers may use the returned clone as evidence input, but it carries no
 * execution authority.
 */
export function validateNativeV3PlanRunnerCheckpointV1(value, plan) {
  const pinnedPlan = validateWorkflowPlanV1(plan);
  if (!isPlainObject(value) || checkpointFormat(value) !== 1) {
    fail("EPLAN_RUNNER_STATE_INVALID", "V1 validator requires an exact V1 checkpoint");
  }
  const checkpoint = validateCheckpoint(value, pinnedPlan, null, { allowLegacy: false });
  if (checkpoint.planId !== pinnedPlan.planId ||
      checkpoint.planDigest !== pinnedPlan.planDigest ||
      checkpoint.contractDigest !== pinnedPlan.contractDigest) {
    fail("EPLAN_RUNNER_STATE_DRIFT", "checkpoint is bound to a different immutable plan");
  }
  return checkpoint;
}

/** Structural V2 validation grants no effect, acceptance, or recovery authority. */
export function validateNativeV3PlanRunnerCheckpointV2(value, plan) {
  const pinnedPlan = validateWorkflowPlanV1(plan);
  if (!isPlainObject(value) || checkpointFormat(value) !== 2) {
    fail("EPLAN_RUNNER_STATE_INVALID", "V2 validator requires an exact V2 checkpoint");
  }
  const checkpoint = validateCheckpoint(value, pinnedPlan, null, { allowLegacy: false, allowV2: true });
  if (checkpoint.planId !== pinnedPlan.planId ||
      checkpoint.planDigest !== pinnedPlan.planDigest ||
      checkpoint.contractDigest !== pinnedPlan.contractDigest) {
    fail("EPLAN_RUNNER_STATE_DRIFT", "checkpoint is bound to a different immutable plan");
  }
  return checkpoint;
}

function taskInitialState(task) {
  const initial = {
    taskId: task.id,
    dependencies: [...task.dependencies],
    role: task.role,
    writeOwner: clone(task.writeOwner),
    status: "pending",
    attempts: 0,
    dispatches: 0,
    attemptId: null,
    unitId: null,
    executionId: null,
    admissionDigest: null,
    startedAt: null,
    finishedAt: null,
    outcome: null,
    lastError: null,
    stopReceipt: null,
    usage: { seconds: 0, tokens: 0 }
  };
  if (task.verification !== undefined) initial.verification = null;
  return initial;
}

function initialCheckpoint({ plan, runId, parallelism, clock }) {
  const budget = plan.taskContract.budget;
  return sealCheckpoint({
    schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
    kind: NATIVE_V3_PLAN_CHECKPOINT_KIND,
    usageSchemaVersion: NATIVE_V3_PLAN_USAGE_SCHEMA_VERSION,
    runId,
    planId: plan.planId,
    planDigest: plan.planDigest,
    contractDigest: plan.contractDigest,
    parallelism,
    status: "ready",
    dispatchBlocked: false,
    cancelRequested: false,
    cancelReason: null,
    failure: null,
    ownerId: null,
    ownerPid: null,
    reconcileRequired: false,
    budget: {
      attempts: budget.attempts,
      seconds: budget.seconds,
      tokens: budget.tokens,
      attemptsUsed: 0,
      secondsUsed: 0,
      tokensUsed: 0
    },
    tasks: Object.fromEntries(plan.taskContract.graph.tasks.map((task) => [task.id, taskInitialState(task)])),
    events: [],
    sequence: 0,
    updatedAt: nowIso(clock)
  });
}

function eventFor(previous, type, { taskId = null, attemptId = null, detail = null, clock }) {
  return {
    sequence: previous.sequence + 1,
    previousStateDigest: previous.stateDigest,
    type,
    at: nowIso(clock),
    taskId,
    attemptId,
    detail: detail === null ? null : clone(detail)
  };
}

function planRunnerResult(state) {
  return clone({
    schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
    kind: NATIVE_V3_PLAN_RUN_RESULT_KIND,
    usageSchemaVersion: state.usageSchemaVersion ?? null,
    runId: state.runId,
    planId: state.planId,
    planDigest: state.planDigest,
    contractDigest: state.contractDigest,
    status: state.status,
    dispatchBlocked: state.dispatchBlocked,
    reconcileRequired: state.reconcileRequired,
    failure: state.failure,
    budget: state.budget,
    tasks: state.tasks,
    checkpoint: state
  });
}

function buildResumeTransitionReceipt({ before, after, requestDigest, freshAdapter }) {
  const resumedEvent = after.events.find((event) =>
    event.type === "run.resumed" && event.sequence > before.sequence
  );
  if (!resumedEvent || after.status !== "running" || after.ownerId === null || after.ownerPid === null) {
    fail("EPLAN_RESUME_RECEIPT", "the native resume transition did not produce a running owner boundary", "HOLD");
  }
  const admissionDigests = Object.values(after.tasks)
    .map((task) => task.admissionDigest)
    .filter((value) => typeof value === "string")
    .sort();
  const resumeGrantBody = {
    schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
    kind: "NativeV3PlanResumeTransitionGrantV1",
    runId: after.runId,
    planId: after.planId,
    planDigest: after.planDigest,
    contractDigest: after.contractDigest,
    requestDigest: requestDigest ?? null,
    beforeCheckpointDigest: before.stateDigest,
    afterCheckpointDigest: after.stateDigest,
    epoch: after.ownerId,
    ownerPid: after.ownerPid,
    freshAdapter: freshAdapter === true,
    effectAllowed: false
  };
  const resumeGrant = {
    ...resumeGrantBody,
    grantDigest: digestObject(resumeGrantBody)
  };
  const admissionBoundaryBody = {
    schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
    kind: "NativeV3PlanResumeAdmissionBoundaryV1",
    status: "pending",
    runId: after.runId,
    planId: after.planId,
    planDigest: after.planDigest,
    contractDigest: after.contractDigest,
    requestDigest: requestDigest ?? null,
    epoch: after.ownerId,
    resumeGrantDigest: resumeGrant.grantDigest,
    taskAdmissionDigests: admissionDigests,
    effectAllowed: false
  };
  const admissionBoundary = {
    ...admissionBoundaryBody,
    boundaryDigest: digestObject(admissionBoundaryBody)
  };
  return deepFreeze({
    schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
    kind: NATIVE_V3_PLAN_RESUME_RECEIPT_KIND,
    transition: "run.resumed",
    runId: after.runId,
    planId: after.planId,
    planDigest: after.planDigest,
    contractDigest: after.contractDigest,
    requestDigest: requestDigest ?? null,
    beforeCheckpointDigest: before.stateDigest,
    afterCheckpointDigest: after.stateDigest,
    beforeSequence: before.sequence,
    afterSequence: resumedEvent.sequence,
    ownerId: after.ownerId,
    ownerPid: after.ownerPid,
    freshEpoch: after.ownerId,
    freshAdapter: freshAdapter === true,
    // Keep the exact native transition checkpoint with the receipt.  A later
    // DAG transition may legitimately advance the durable checkpoint, but a
    // caller must never substitute a newly self-digested checkpoint for this
    // transition snapshot.
    afterCheckpoint: clone(after),
    lineageDigests: [after.stateDigest],
    resumeGrant,
    // A resume transition creates a fresh owner epoch; task admission is
    // still rebuilt and checked by executeTask immediately before effect.
    // Keeping this explicitly pending prevents the receipt from becoming an
    // effect grant merely because a caller copied its JSON fields.
    currentAdmission: admissionBoundary,
    effectAllowed: false
  });
}

function assertAdmissionForTask(admissionValue, { plan, task, runId, attemptId, unitId, clock }) {
  const admission = validateExecutionAdmission(admissionValue);
  const checks = [
    ["runId", admission.runId, runId],
    ["planDigest", admission.planDigest, plan.planDigest],
    ["contractDigest", admission.contractDigest, plan.contractDigest],
    ["taskId", admission.taskId, task.id],
    ["unitId", admission.unitId, unitId],
    ["attemptId", admission.attemptId, attemptId],
    ["sourceBindingDigest", admission.sourceBindingDigest, plan.taskContract.bindings.source.digest],
    ["policyDigest", admission.policyDigest, plan.taskContract.bindings.policy.digest],
    ["revision", admission.revision, plan.taskContract.bindings.source.revision]
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) fail("EPLAN_RUNNER_ADMISSION", `task admission ${label} is not bound to the current plan/task`);
  }
  if (!same(admission.scope, plan.taskContract.scope) || !same(admission.budget, task.budget)) {
    fail("EPLAN_RUNNER_ADMISSION", "task admission scope or budget is not bound to the plan");
  }
  if (Date.parse(admission.expiresAt) <= currentDate(clock).getTime()) {
    fail("EPLAN_RUNNER_ADMISSION", "task admission is expired", "HOLD");
  }
  return admission;
}

function assertStopReceiptForAdmission(receiptValue, admission, reason, handleId) {
  const receipt = validateStopReceiptV1(receiptValue);
  const checks = [
    ["runId", receipt.runId, admission.runId],
    ["executionId", receipt.executionId, admission.executionId],
    ["attemptId", receipt.attemptId, admission.attemptId],
    ["unitId", receipt.unitId, admission.unitId],
    ["sourceBindingDigest", receipt.sourceBindingDigest, admission.sourceBindingDigest],
    ["policyDigest", receipt.policyDigest, admission.policyDigest],
    ["revision", receipt.revision, admission.revision],
    ["authorityEpoch", receipt.authorityEpoch, admission.authorityEpoch],
    ["fence", receipt.fence, admission.fence],
    ["ownedResourceId", receipt.ownedResourceId, admission.ownedResourceId]
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) fail("EPLAN_RUNNER_STOP", `stop receipt ${label} is not bound to the task admission`);
  }
  if (handleId !== undefined && receipt.handleId !== handleId) {
    fail("EPLAN_RUNNER_STOP", "stop receipt handleId is not bound to the runtime handle");
  }
  if (receipt.reason !== reason) fail("EPLAN_RUNNER_STOP", "stop receipt reason is not bound to the requested cancellation");
  if (receipt.outcome !== "STOPPED" || receipt.confirmedOwnedScope !== true) {
    fail("EPLAN_RUNNER_STOP", "owned task stop did not produce physical STOPPED proof", "UNKNOWN");
  }
  return receipt;
}

function verificationCheckpointForReceipt(receipt, { plan, task, runId, attemptId, admission }) {
  if (!isNativeV3VerificationReceipt(receipt)) {
    fail("EPLAN_VERIFICATION_RECEIPT", "verification result was not returned by the trusted consumer", "HOLD");
  }
  try {
    verifyNativeV3VerificationReceipt(receipt);
  } catch (error) {
    const wrapped = new NativeV3PlanRunnerError(
      "EPLAN_VERIFICATION_RECEIPT",
      `verification receipt is invalid: ${String(error?.message ?? error)}`,
      "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  if (receipt.phase !== "evaluation" || receipt.planId !== plan.planId || receipt.planDigest !== plan.planDigest ||
      receipt.contractDigest !== plan.contractDigest || receipt.runId !== runId || receipt.taskId !== task.id ||
      receipt.mode !== task.verification.mode || receipt.epoch !== admission.authorityEpoch ||
      receipt.unrelatedHeadDigest !== admission.sourceBindingDigest || receipt.accepted !== false ||
      receipt.effectAuthorized !== false) {
    fail("EPLAN_VERIFICATION_BINDING", "verification receipt is not bound to the current plan/task admission", "HOLD");
  }
  const freeze = receipt.revisionFreeze;
  const record = {
    schemaVersion: 1,
    kind: VERIFICATION_CHECKPOINT_KIND,
    taskId: task.id,
    attemptId,
    mode: receipt.mode,
    status: receipt.status,
    receiptDigest: receipt.receiptDigest,
    receiptPath: receipt.receiptPath,
    unitId: receipt.unitId,
    unitDigest: receipt.unitDigest,
    cacheKey: receipt.cacheKey,
    runId: receipt.runId,
    epoch: receipt.epoch,
    unrelatedHeadDigest: receipt.unrelatedHeadDigest,
    sourceBindingDigest: receipt.sourceBindingDigest,
    relevantRevisionDigest: receipt.relevantRevisionDigest,
    actionAdmissionDigest: digestExecutionAdmission(admission),
    revisionReadyDigest: freeze?.revisionReadyDigest ?? null,
    finalFreezeDigest: freeze?.finalFreezeDigest ?? null,
    cycle: freeze?.cycle ?? null,
    accepted: false,
    effectAuthorized: false
  };
  validateVerificationCheckpoint(record, task, `tasks.${task.id}.verification`);
  return record;
}

function validatePreparedTask(value, { plan, task, runId, attemptId, preparationIdentity }) {
  if (!isPlainObject(value)) fail("EPLAN_RUNNER_ADAPTER", "task adapter must return a plain prepared task");
  const expectedKeys = TRUSTED_PLAN_TASK_TRANSFER_KEYS;
  if (Object.keys(value).sort().join(",") !== expectedKeys.join(",")) fail("EPLAN_RUNNER_ADAPTER", "prepared task has an unexpected shape");
  if (value.schemaVersion !== 1 || value.kind !== "NativeV3PlanTaskTransferV1") {
    fail("EPLAN_RUNNER_ADAPTER", "prepared task is not a native V3 one-shot transfer");
  }
  const transfer = consumeNativeV3PlanTaskTransfer(value, preparationIdentity);
  const preparedTaskId = taskId(value.taskId, "preparedTask.taskId");
  const preparedUnitId = id(value.unitId, "preparedTask.unitId");
  if (preparedTaskId !== task.id) fail("EPLAN_RUNNER_ADAPTER", "prepared taskId does not match the graph task");
  if (!isPlainObject(value.binding) || Object.keys(value.binding).sort().join(",") !== TRUSTED_BINDING_KEYS.join(",")) {
    fail("EPLAN_RUNNER_ADAPTER", "prepared task binding has an unexpected shape");
  }
  const binding = {
    runId: id(value.binding.runId, "preparedTask.binding.runId"),
    executionId: id(value.binding.executionId, "preparedTask.binding.executionId"),
    attemptId: id(value.binding.attemptId, "preparedTask.binding.attemptId"),
    unitId: id(value.binding.unitId, "preparedTask.binding.unitId"),
    ownedResourceId: id(value.binding.ownedResourceId, "preparedTask.binding.ownedResourceId"),
    sourceBindingDigest: digest(value.binding.sourceBindingDigest, "preparedTask.binding.sourceBindingDigest"),
    policyDigest: digest(value.binding.policyDigest, "preparedTask.binding.policyDigest"),
    revision: text(value.binding.revision, "preparedTask.binding.revision", ID, 256)
  };
  if (binding.runId !== runId || binding.attemptId !== attemptId || binding.unitId !== preparedUnitId ||
      binding.sourceBindingDigest !== plan.taskContract.bindings.source.digest ||
      binding.policyDigest !== plan.taskContract.bindings.policy.digest ||
      binding.revision !== plan.taskContract.bindings.source.revision) {
    fail("EPLAN_RUNNER_ADAPTER", "prepared task binding does not match the current plan/task");
  }
  let handle;
  try {
    handle = validateExecutionHandleV1(transfer.handle);
  } catch (error) {
    const wrapped = new NativeV3PlanRunnerError(
      "EPLAN_RUNNER_ADAPTER",
      `native V3 transfer handle is invalid: ${String(error?.message ?? error)}`,
      "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  const handleBinding = {
    runId: handle.runId,
    executionId: handle.executionId,
    attemptId: handle.attemptId,
    unitId: handle.unitId,
    ownedResourceId: handle.ownedResourceId,
    sourceBindingDigest: handle.sourceBindingDigest,
    policyDigest: handle.policyDigest,
    revision: handle.revision
  };
  if (!same(handleBinding, binding) || handle.status !== "ready" || handle.dispatchBlocked === true) {
    fail("EPLAN_RUNNER_ADAPTER", "native V3 transfer is not bound to a ready execution handle");
  }
  if (transfer.kind !== "NativeV3PlanTaskTransferV1" ||
      !isPlainObject(transfer.controller) || typeof transfer.execute !== "function" || typeof transfer.stop !== "function") {
    fail("EPLAN_RUNNER_ADAPTER", "native V3 transfer has no trusted execution capability");
  }
  return {
    taskId: preparedTaskId,
    unitId: preparedUnitId,
    binding,
    controller: transfer.controller,
    handle,
    transfer
  };
}

async function readTrustedAdmission(prepared, { plan, task, runId, attemptId, clock }) {
  const binding = prepared.binding;
  try {
    const runContract = await prepared.controller.readRunContract({ runId });
    const sourceBinding = await prepared.controller.readSourceBinding({ runId });
    if (!isPlainObject(sourceBinding) || sourceBinding.runId !== runId ||
        sourceBinding.revision !== binding.revision ||
        (sourceBinding.digest ?? sourceBinding.sourceBindingDigest) !== binding.sourceBindingDigest) {
      fail("EPLAN_RUNNER_ADMISSION", "trusted source binding drifted from the current plan", "HOLD");
    }
    const authority = await prepared.controller.readAuthority(clone(binding));
    const current = buildExecutionAdmission({
      runContract,
      authority,
      binding,
      now: currentDate(clock)
    });
    return assertAdmissionForTask(current.admission, {
      plan,
      task,
      runId,
      attemptId,
      unitId: binding.unitId,
      clock
    });
  } catch (error) {
    if (error instanceof NativeV3PlanRunnerError) throw error;
    const wrapped = new NativeV3PlanRunnerError(
      "EPLAN_RUNNER_ADMISSION",
      `trusted task admission could not be built: ${String(error?.message ?? error)}`,
      "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

function readyTasks(state, plan) {
  const byId = state.tasks;
  return plan.taskContract.graph.tasks
    .filter((task) => byId[task.id].status === "pending" && task.dependencies.every((idValue) => byId[idValue].status === "succeeded"))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function allTasksSucceeded(state, plan) {
  return plan.taskContract.graph.tasks.every((task) => state.tasks[task.id].status === "succeeded");
}

function hasUnknownTask(state, plan) {
  return plan.taskContract.graph.tasks.some((task) => state.tasks[task.id].status === "unknown");
}

function anyDependencyTerminalFailure(state, task) {
  return task.dependencies.some((dependency) => ["failed", "hold", "unknown", "blocked", "cancelled"].includes(state.tasks[dependency].status));
}

export async function readNativeV3PlanRunnerCheckpoint({ stateRoot, root, runId } = {}) {
  const resolvedRootInput = stateRoot ?? root ?? getStateRoot();
  const resolvedRoot = absolute(resolvedRootInput, "stateRoot");
  const resolvedRunId = id(runId, "runId");
  const runnerRoot = safeJoin(resolvedRoot, PLAN_RUNNER_DIRECTORY);
  const target = safeJoin(runnerRoot, "runs", resolvedRunId, CHECKPOINT_FILE);
  let raw;
  try {
    raw = await readCheckpointJson(runnerRoot, target);
  } catch (error) {
    if (error?.code === "ENOENT") fail("EPLAN_RUNNER_STATE_MISSING", "plan runner checkpoint is absent", "HOLD");
    throw error;
  }
  // The standalone V1 inspector feeds control and resume consumers. Keep V2
  // unavailable here until those consumers enforce its acceptance semantics.
  if (!isPlainObject(raw)) fail("EPLAN_RUNNER_STATE_INVALID", "plan runner checkpoint must be an object");
  const format = checkpointFormat(raw);
  if (format === 2) {
    fail("EPLAN_CHECKPOINT_V2_NOT_ACTIVE", "V2 checkpoint acceptance and recovery are not active", "HOLD");
  }
  const legacyUsageSchema = raw.usageSchemaVersion === undefined;
  if (!legacyUsageSchema && raw.usageSchemaVersion !== NATIVE_V3_PLAN_USAGE_SCHEMA_VERSION) {
    fail("EPLAN_USAGE_SCHEMA_UNSUPPORTED", "checkpoint usage schema version is unsupported", "HOLD");
  }
  const expectedKeys = [
    "schemaVersion", "kind", ...(legacyUsageSchema ? [] : ["usageSchemaVersion"]), "runId", "planId", "planDigest", "contractDigest", "parallelism", "status",
    "dispatchBlocked", "cancelRequested", "cancelReason", "failure", "ownerId", "ownerPid", "reconcileRequired", "budget", "tasks", "events",
    "sequence", "updatedAt", "stateDigest"
  ].sort();
  if (Object.keys(raw).sort().join(",") !== expectedKeys.join(",")) {
    fail("EPLAN_RUNNER_STATE_INVALID", "plan runner checkpoint has an unexpected shape");
  }
  const body = checkpointBody(raw);
  digest(raw.stateDigest, "checkpoint.stateDigest");
  if (digestObject(body) !== raw.stateDigest) fail("EPLAN_RUNNER_STATE_INVALID", "plan runner checkpoint digest is invalid");
  return clone(raw);
}

function incidentRecoveryPreparedEvent(checkpoint) {
  const matches = checkpoint.events.filter((event) => event.type === INCIDENT_RECOVERY_EVENT);
  if (matches.length > 1) {
    fail("EPLAN_INCIDENT_RECOVERY_CONFLICT", "plan checkpoint contains multiple incident recovery preparation events", "UNKNOWN");
  }
  return matches[0] ?? null;
}

function incidentRecoveryTransitionReceipt({ workflowPlan, handoff, checkpoint, event }) {
  const detail = validateIncidentRecoveryEventDetail(event.detail, workflowPlan);
  const body = {
    schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
    kind: NATIVE_V3_PLAN_INCIDENT_RECOVERY_RECEIPT_KIND,
    status: "prepared",
    runId: checkpoint.runId,
    planId: workflowPlan.planId,
    planDigest: workflowPlan.planDigest,
    contractDigest: workflowPlan.contractDigest,
    recoveryId: detail.recoveryId,
    recoveryPlanDigest: detail.recoveryPlanDigest,
    handoffId: detail.handoffId,
    handoffDigest: detail.handoffDigest,
    sourceCheckpointSequence: detail.sourceCheckpointSequence,
    sourceCheckpointStateDigest: detail.sourceCheckpointStateDigest,
    sourceRegistrySequence: detail.sourceRegistrySequence,
    sourceRegistryStateDigest: detail.sourceRegistryStateDigest,
    committedRegistrySequence: detail.committedRegistrySequence,
    committedRegistryStateDigest: detail.committedRegistryStateDigest,
    preparedCheckpointSequence: checkpoint.sequence,
    preparedCheckpointStateDigest: checkpoint.stateDigest,
    taskIds: clone(detail.taskIds),
    preservedTaskIds: clone(detail.preservedTaskIds),
    entries: clone(detail.entries),
    effectAuthority: clone(INCIDENT_RECOVERY_EFFECT_AUTHORITY),
    preparedAt: event.at
  };
  if (handoff.handoffId !== body.handoffId || handoff.handoffDigest !== body.handoffDigest) {
    fail("EPLAN_INCIDENT_RECOVERY_UNKNOWN", "incident recovery checkpoint receipt is not bound to the durable runtime handoff", "UNKNOWN");
  }
  return deepFreeze({ ...body, receiptDigest: digestObject(body) });
}

function incidentRecoveryRuntimeEntries({ recoveryPlan, checkpoint, handoff, handles, taskIds }) {
  if (handoff.entries.length !== taskIds.length) {
    fail("EPLAN_INCIDENT_RECOVERY_BINDING", "runtime handoff entries do not exactly cover recovery tasks", "HOLD");
  }
  const handlesById = new Map(handles.map((handle) => [handle.handleId, handle]));
  return handoff.entries.map((entry, index) => {
    const task = checkpoint.tasks[entry.taskId];
    const handle = handlesById.get(entry.handleId);
    if (!task) {
      fail("EPLAN_INCIDENT_RECOVERY_BINDING", `runtime handoff task ${entry.taskId} is absent from the checkpoint`, "HOLD");
    }
    const expectedAttemptId = `${entry.taskId}.attempt.${task.attempts + 1}`;
    if (entry.taskId !== taskIds[index] || entry.attemptId !== expectedAttemptId ||
        !handle || handle.status !== "ready" || handle.dispatchBlocked !== true ||
        handle.handleId !== entry.handleId || handle.attemptId !== entry.attemptId ||
        handle.executionId !== entry.executionId || handle.unitId !== entry.unitId ||
        handle.ownedResourceId !== entry.ownedResourceId || handle.admissionDigest !== entry.admissionDigest ||
        handle.sourceBindingDigest !== recoveryPlan.workflow.sourceBindingDigest ||
        handle.policyDigest !== recoveryPlan.workflow.policyDigest || handle.revision !== recoveryPlan.workflow.revision ||
        digestObject(handle) !== entry.handleDigest) {
      fail("EPLAN_INCIDENT_RECOVERY_BINDING", `runtime handoff task ${entry.taskId} is not the exact next blocked attempt`, "HOLD");
    }
    return {
      taskId: entry.taskId,
      handleId: entry.handleId,
      attemptId: entry.attemptId,
      handleDigest: entry.handleDigest,
      admissionDigest: entry.admissionDigest
    };
  });
}

function assertExactIncidentRecoveryRuntimeHead(runtimeReadback) {
  const { handoff, registryHead } = runtimeReadback;
  if (registryHead.sequence !== handoff.committedRegistrySequence ||
      registryHead.stateDigest !== handoff.committedRegistryStateDigest) {
    fail(
      "EPLAN_INCIDENT_RECOVERY_RUNTIME_DRIFT",
      "execution registry advanced beyond the exact committed recovery handoff",
      "HOLD"
    );
  }
}

function resetIncidentRecoveryTask(sourceTask) {
  const task = clone(sourceTask);
  task.status = "pending";
  task.attemptId = null;
  task.unitId = null;
  task.executionId = null;
  task.admissionDigest = null;
  task.startedAt = null;
  task.finishedAt = null;
  task.outcome = null;
  task.lastError = null;
  task.stopReceipt = null;
  if (Object.hasOwn(task, "verification")) task.verification = null;
  return task;
}

function budgetFromTaskHistory(workflowPlan, tasks) {
  const sumDimension = (dimension) => {
    const values = Object.values(tasks).map((task) => task.usage[dimension]);
    return values.some((value) => value === null) ? null : values.reduce((total, value) => total + value, 0);
  };
  return {
    attempts: workflowPlan.taskContract.budget.attempts,
    attemptsUsed: Object.values(tasks).reduce((total, task) => total + task.attempts, 0),
    seconds: workflowPlan.taskContract.budget.seconds,
    secondsUsed: sumDimension("seconds"),
    tokens: workflowPlan.taskContract.budget.tokens,
    tokensUsed: sumDimension("tokens")
  };
}

function validateIncidentRecoveryReplay(checkpoint, workflowPlan, recoveryPlan, runtimeReadback) {
  if (checkpoint.runId !== recoveryPlan.workflow.runId ||
      checkpoint.planId !== workflowPlan.planId ||
      checkpoint.planDigest !== workflowPlan.planDigest ||
      checkpoint.contractDigest !== workflowPlan.contractDigest) {
    fail(
      "EPLAN_INCIDENT_RECOVERY_BINDING",
      "incident recovery checkpoint is not bound to the exact workflow plan",
      "HOLD"
    );
  }
  const { handoff, handles } = runtimeReadback;
  const event = incidentRecoveryPreparedEvent(checkpoint);
  if (event === null) return null;
  const detail = validateIncidentRecoveryEventDetail(event.detail, workflowPlan);
  const taskIds = recoveryPlan.tasks.filter((task) => task.disposition === "recover").map((task) => task.taskId).sort();
  const preservedTaskIds = recoveryPlan.tasks.filter((task) => task.disposition === "preserve").map((task) => task.taskId).sort();
  const entries = incidentRecoveryRuntimeEntries({ recoveryPlan, checkpoint, handoff, handles, taskIds });
  if (checkpoint.status !== "paused" || checkpoint.dispatchBlocked !== true ||
      checkpoint.cancelRequested !== false || checkpoint.cancelReason !== "pause" ||
      checkpoint.failure !== null || checkpoint.ownerId !== null || checkpoint.ownerPid !== null ||
      checkpoint.reconcileRequired !== false || checkpoint.sequence !== event.sequence ||
      detail.recoveryId !== recoveryPlan.recoveryId || detail.recoveryPlanDigest !== recoveryPlan.manifestDigest ||
      detail.handoffId !== handoff.handoffId || detail.handoffDigest !== handoff.handoffDigest ||
      detail.recoveryPlanDigest !== handoff.recoveryPlanDigest || handoff.recoveryId !== recoveryPlan.recoveryId ||
      detail.sourceCheckpointSequence !== recoveryPlan.checkpoint.sequence ||
      detail.sourceCheckpointStateDigest !== recoveryPlan.checkpoint.stateDigest ||
      detail.sourceRegistrySequence !== handoff.sourceRegistrySequence ||
      detail.sourceRegistryStateDigest !== handoff.sourceRegistryStateDigest ||
      detail.committedRegistrySequence !== handoff.committedRegistrySequence ||
      detail.committedRegistryStateDigest !== handoff.committedRegistryStateDigest ||
      !same(detail.taskIds, taskIds) || !same(detail.preservedTaskIds, preservedTaskIds) ||
      !same(detail.entries, entries)) {
    fail("EPLAN_INCIDENT_RECOVERY_CONFLICT", "incident recovery preparation conflicts with the current plan checkpoint", "HOLD");
  }
  const classificationByTask = new Map(recoveryPlan.tasks.map((task) => [task.taskId, task]));
  const sourceTasks = {};
  for (const taskIdValue of detail.taskIds) {
    const sourceTask = detail.sourceTasks[taskIdValue];
    const classification = classificationByTask.get(taskIdValue);
    if (!classification || digestObject(sourceTask) !== classification.checkpointTaskDigest ||
        !same(checkpoint.tasks[taskIdValue], resetIncidentRecoveryTask(sourceTask))) {
      fail("EPLAN_INCIDENT_RECOVERY_CONFLICT", `recovered task ${taskIdValue} changed after preparation`, "HOLD");
    }
    sourceTasks[taskIdValue] = sourceTask;
  }
  for (const taskIdValue of detail.preservedTaskIds) {
    const task = checkpoint.tasks[taskIdValue];
    const classification = classificationByTask.get(taskIdValue);
    if (!classification || task?.status !== "succeeded" || digestObject(task) !== classification.checkpointTaskDigest) {
      fail("EPLAN_INCIDENT_RECOVERY_CONFLICT", `preserved task ${taskIdValue} is no longer succeeded`, "HOLD");
    }
    sourceTasks[taskIdValue] = task;
  }
  if (!same(checkpoint.budget, budgetFromTaskHistory(workflowPlan, sourceTasks))) {
    fail("EPLAN_INCIDENT_RECOVERY_CONFLICT", "incident recovery preparation changed historical budget usage", "HOLD");
  }
  return incidentRecoveryTransitionReceipt({ workflowPlan, handoff, checkpoint, event });
}

function incidentRecoveryBoundary({ recoveryPlan, workflowPlan, checkpoint, runtimeReadback }) {
  const { handoff, handles } = runtimeReadback;
  if (recoveryPlan.status !== "prepared" || handoff.recoveryPlanDigest !== recoveryPlan.manifestDigest ||
      handoff.runId !== recoveryPlan.workflow.runId || checkpoint.runId !== recoveryPlan.workflow.runId ||
      recoveryPlan.workflow.planId !== workflowPlan.planId ||
      recoveryPlan.workflow.planDigest !== workflowPlan.planDigest ||
      recoveryPlan.workflow.contractDigest !== workflowPlan.contractDigest ||
      recoveryPlan.workflow.sourceBindingDigest !== workflowPlan.taskContract.bindings.source.digest ||
      recoveryPlan.workflow.policyDigest !== workflowPlan.taskContract.bindings.policy.digest ||
      recoveryPlan.workflow.revision !== workflowPlan.taskContract.bindings.source.revision) {
    fail("EPLAN_INCIDENT_RECOVERY_BINDING", "incident recovery plan, workflow plan, checkpoint, and runtime handoff are not exact", "HOLD");
  }
  const replay = validateIncidentRecoveryReplay(checkpoint, workflowPlan, recoveryPlan, runtimeReadback);
  if (replay !== null) return { replay };
  // The first publication must linearize against the exact S1d registry head.
  // Once the prepared checkpoint exists, replay is instead bound to the exact
  // handoff and handle digests so an unrelated later registry event cannot
  // invalidate an already successful non-effecting transition.
  assertExactIncidentRecoveryRuntimeHead(runtimeReadback);
  if (!["failed", "hold", "cancelled"].includes(checkpoint.status) || checkpoint.dispatchBlocked !== true ||
      checkpoint.reconcileRequired !== false || checkpoint.sequence !== recoveryPlan.checkpoint.sequence ||
      checkpoint.stateDigest !== recoveryPlan.checkpoint.stateDigest || checkpoint.status !== recoveryPlan.checkpoint.status) {
    fail("EPLAN_INCIDENT_RECOVERY_STALE", "only the exact safely terminal incident checkpoint can be prepared for recovery", "HOLD");
  }
  const recoverTasks = recoveryPlan.tasks.filter((task) => task.disposition === "recover");
  const preservedTasks = recoveryPlan.tasks.filter((task) => task.disposition === "preserve");
  if (recoverTasks.length === 0 || recoverTasks.length + preservedTasks.length !== recoveryPlan.tasks.length) {
    fail("EPLAN_INCIDENT_RECOVERY_BINDING", "prepared incident recovery plan contains a non-runnable task disposition", "HOLD");
  }
  const taskIds = recoverTasks.map((task) => task.taskId).sort();
  const preservedTaskIds = preservedTasks.map((task) => task.taskId).sort();
  const nonSucceededTaskIds = Object.values(checkpoint.tasks)
    .filter((task) => task.status !== "succeeded")
    .map((task) => task.taskId)
    .sort();
  const succeededTaskIds = Object.values(checkpoint.tasks)
    .filter((task) => task.status === "succeeded")
    .map((task) => task.taskId)
    .sort();
  if (!same(taskIds, handoff.taskIds) || !same(taskIds, nonSucceededTaskIds) ||
      !same(preservedTaskIds, succeededTaskIds)) {
    fail("EPLAN_INCIDENT_RECOVERY_BINDING", "runtime handoff does not exactly cover the terminal checkpoint task boundary", "HOLD");
  }
  if (!same(checkpoint.budget, budgetFromTaskHistory(workflowPlan, checkpoint.tasks))) {
    fail("EPLAN_INCIDENT_RECOVERY_BINDING", "terminal checkpoint task history and budget usage disagree", "HOLD");
  }
  const entries = incidentRecoveryRuntimeEntries({ recoveryPlan, checkpoint, handoff, handles, taskIds });
  return {
    taskIds,
    preservedTaskIds,
    entries,
    detail: {
      schemaVersion: 1,
      kind: INCIDENT_RECOVERY_EVENT_DETAIL_KIND,
      recoveryId: recoveryPlan.recoveryId,
      recoveryPlanDigest: recoveryPlan.manifestDigest,
      handoffId: handoff.handoffId,
      handoffDigest: handoff.handoffDigest,
      sourceCheckpointSequence: checkpoint.sequence,
      sourceCheckpointStateDigest: checkpoint.stateDigest,
      sourceRegistrySequence: handoff.sourceRegistrySequence,
      sourceRegistryStateDigest: handoff.sourceRegistryStateDigest,
      committedRegistrySequence: handoff.committedRegistrySequence,
      committedRegistryStateDigest: handoff.committedRegistryStateDigest,
      taskIds,
      preservedTaskIds,
      sourceTasks: Object.fromEntries(taskIds.map((taskIdValue) => [taskIdValue, clone(checkpoint.tasks[taskIdValue])])),
      entries,
      effectAuthority: clone(INCIDENT_RECOVERY_EFFECT_AUTHORITY)
    }
  };
}

async function withBoundedPlanRunnerLock(runnerRoot, runId, callback) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      return await withRunLock(runnerRoot, runId, callback, { ttlMs: LOCK_WAIT_MS * 2 });
    } catch (error) {
      lastError = error;
      if (!isLeaseConflict(error)) throw error;
      await delay(LOCK_RETRY_MS, { keepAlive: true });
    }
  }
  const error = new NativeV3PlanRunnerError(
    "EPLAN_INCIDENT_RECOVERY_LEASE",
    "plan runner recovery checkpoint lease could not be acquired",
    "HOLD"
  );
  error.cause = lastError;
  throw error;
}

/**
 * Persist only the non-effecting plan-runner side of a committed S1d handoff.
 * Runtime handles stay ready and dispatch-blocked; a later governed claim is
 * required before ordinary resume may create or dispatch any task effect.
 */
export async function prepareNativeV3PlanIncidentRecoveryTransitionV1(options = {}) {
  const supplied = exactOptions(options, INCIDENT_RECOVERY_TRANSITION_KEYS, "incident recovery transition options");
  const stateRoot = absolute(supplied.stateRoot ?? supplied.root ?? getStateRoot(), "stateRoot");
  if (supplied.stateRoot !== undefined && supplied.root !== undefined && absolute(supplied.root, "root") !== stateRoot) {
    fail("EPLAN_RUNNER_INPUT", "stateRoot and root must refer to the same directory");
  }
  const handoffId = id(supplied.handoffId, "handoffId");
  let recoveryPlan;
  let withIncidentRecoveryDagRuntimeHandoffReadLeaseV1;
  try {
    const [planModule, runtimeModule] = await Promise.all([
      import("./incident-recovery-dag-v1.mjs"),
      import("./incident-recovery-dag-runtime-v1.mjs")
    ]);
    recoveryPlan = planModule.validateIncidentRecoveryDagPlanV1(supplied.recoveryPlan);
    withIncidentRecoveryDagRuntimeHandoffReadLeaseV1 = runtimeModule.withIncidentRecoveryDagRuntimeHandoffReadLeaseV1;
  } catch (error) {
    const wrapped = new NativeV3PlanRunnerError(
      "EPLAN_INCIDENT_RECOVERY_INPUT",
      `incident recovery plan could not be validated: ${String(error?.message ?? error)}`,
      error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  if (recoveryPlan.status !== "prepared") {
    fail("EPLAN_INCIDENT_RECOVERY_INPUT", "incident recovery transition requires a fully prepared DAG recovery plan", "HOLD");
  }
  const runId = id(recoveryPlan.workflow.runId, "recoveryPlan.workflow.runId");
  let workflowPlan;
  try {
    workflowPlan = await readFreshWorkflowPlanV1({
      root: stateRoot,
      planId: recoveryPlan.workflow.planId,
      expected: {
        planDigest: recoveryPlan.workflow.planDigest,
        contractDigest: recoveryPlan.workflow.contractDigest,
        sourceRevision: recoveryPlan.workflow.revision,
        sourceDigest: recoveryPlan.workflow.sourceBindingDigest,
        policyDigest: recoveryPlan.workflow.policyDigest
      }
    });
  } catch (error) {
    const wrapped = new NativeV3PlanRunnerError(
      "EPLAN_INCIDENT_RECOVERY_SOURCE",
      `fresh WorkflowPlanV1 could not be bound to recovery: ${String(error?.message ?? error)}`,
      error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  const withRuntimeReadLease = async (callback) => {
    try {
      return await withIncidentRecoveryDagRuntimeHandoffReadLeaseV1({
        stateRoot,
        runId,
        handoffId,
        controller: supplied.controller
      }, callback);
    } catch (error) {
      if (error instanceof NativeV3PlanRunnerError) throw error;
      const wrapped = new NativeV3PlanRunnerError(
        "EPLAN_INCIDENT_RECOVERY_RUNTIME",
        `durable DAG runtime handoff could not be read: ${String(error?.message ?? error)}`,
        error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      );
      wrapped.cause = error;
      throw wrapped;
    }
  };
  const runnerRoot = safeJoin(stateRoot, PLAN_RUNNER_DIRECTORY);
  const checkpointPath = safeJoin(runnerRoot, "runs", runId, CHECKPOINT_FILE);
  return withBoundedPlanRunnerLock(runnerRoot, runId, async () => withRuntimeReadLease(async (runtimeReadback) => {
    let checkpoint;
    try {
      checkpoint = validateCheckpoint(
        await readCheckpointJson(runnerRoot, checkpointPath),
        workflowPlan,
        null,
        { allowLegacy: false }
      );
    } catch (error) {
      if (error instanceof NativeV3PlanRunnerError) throw error;
      const wrapped = new NativeV3PlanRunnerError(
        "EPLAN_INCIDENT_RECOVERY_CHECKPOINT",
        `plan runner checkpoint could not be read: ${String(error?.message ?? error)}`,
        "HOLD"
      );
      wrapped.cause = error;
      throw wrapped;
    }
    const boundary = incidentRecoveryBoundary({ recoveryPlan, workflowPlan, checkpoint, runtimeReadback });
    if (boundary.replay) return boundary.replay;
    const draft = clone(checkpoint);
    delete draft.stateDigest;
    draft.status = "paused";
    draft.dispatchBlocked = true;
    draft.cancelRequested = false;
    draft.cancelReason = "pause";
    draft.failure = null;
    draft.ownerId = null;
    draft.ownerPid = null;
    draft.reconcileRequired = false;
    for (const taskIdValue of boundary.taskIds) {
      draft.tasks[taskIdValue] = resetIncidentRecoveryTask(draft.tasks[taskIdValue]);
    }
    const event = eventFor(checkpoint, INCIDENT_RECOVERY_EVENT, { detail: boundary.detail, clock: undefined });
    const next = sealCheckpoint({
      ...draft,
      sequence: checkpoint.sequence + 1,
      events: [...checkpoint.events, event],
      updatedAt: event.at
    });
    validateCheckpoint(next, workflowPlan, {
      planId: workflowPlan.planId,
      planDigest: workflowPlan.planDigest,
      contractDigest: workflowPlan.contractDigest,
      parallelism: checkpoint.parallelism
    });
    try {
      await atomicWriteJson(runnerRoot, checkpointPath, next);
    } catch (error) {
      let readback = null;
      try {
        readback = validateCheckpoint(await readCheckpointJson(runnerRoot, checkpointPath), workflowPlan, null, { allowLegacy: false });
      } catch {
        // Preserve the original ambiguous publication result below.
      }
      if (!readback || readback.stateDigest !== next.stateDigest || readback.sequence !== next.sequence) {
        const wrapped = new NativeV3PlanRunnerError(
          "EPLAN_INCIDENT_RECOVERY_UNKNOWN",
          `plan recovery checkpoint publication is unresolved: ${String(error?.message ?? error)}`,
          "UNKNOWN"
        );
        wrapped.cause = error;
        throw wrapped;
      }
    }
    return incidentRecoveryTransitionReceipt({
      workflowPlan,
      handoff: runtimeReadback.handoff,
      checkpoint: next,
      event
    });
  }));
}

async function loadIncidentRecoveryAuthorityContext(supplied, label) {
  const stateRoot = absolute(supplied.stateRoot ?? supplied.root ?? getStateRoot(), "stateRoot");
  if (supplied.stateRoot !== undefined && supplied.root !== undefined && absolute(supplied.root, "root") !== stateRoot) {
    fail("EPLAN_RUNNER_INPUT", "stateRoot and root must refer to the same directory");
  }
  const handoffId = id(supplied.handoffId, "handoffId");
  let recoveryPlan;
  let runtimeModule;
  try {
    const [planModule, loadedRuntimeModule] = await Promise.all([
      import("./incident-recovery-dag-v1.mjs"),
      import("./incident-recovery-dag-runtime-v1.mjs")
    ]);
    recoveryPlan = planModule.validateIncidentRecoveryDagPlanV1(supplied.recoveryPlan);
    runtimeModule = loadedRuntimeModule;
  } catch (error) {
    const wrapped = new NativeV3PlanRunnerError(
      "EPLAN_INCIDENT_RECOVERY_INPUT",
      `${label} recovery plan could not be validated: ${String(error?.message ?? error)}`,
      error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  if (recoveryPlan.status !== "prepared") {
    fail("EPLAN_INCIDENT_RECOVERY_INPUT", `${label} requires a fully prepared DAG recovery plan`, "HOLD");
  }
  const runId = id(recoveryPlan.workflow.runId, "recoveryPlan.workflow.runId");
  let workflowPlan;
  try {
    workflowPlan = await readFreshWorkflowPlanV1({
      root: stateRoot,
      planId: recoveryPlan.workflow.planId,
      expected: {
        planDigest: recoveryPlan.workflow.planDigest,
        contractDigest: recoveryPlan.workflow.contractDigest,
        sourceRevision: recoveryPlan.workflow.revision,
        sourceDigest: recoveryPlan.workflow.sourceBindingDigest,
        policyDigest: recoveryPlan.workflow.policyDigest
      }
    });
  } catch (error) {
    const wrapped = new NativeV3PlanRunnerError(
      "EPLAN_INCIDENT_RECOVERY_SOURCE",
      `${label} fresh WorkflowPlanV1 could not be bound to recovery: ${String(error?.message ?? error)}`,
      error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  return { stateRoot, handoffId, recoveryPlan, runtimeModule, runId, workflowPlan };
}

async function readPreparedIncidentRecoveryAuthorityBoundary(context, controller) {
  const runnerRoot = safeJoin(context.stateRoot, PLAN_RUNNER_DIRECTORY);
  const checkpointPath = safeJoin(runnerRoot, "runs", context.runId, CHECKPOINT_FILE);
  let checkpoint;
  try {
    checkpoint = validateCheckpoint(
      await readCheckpointJson(runnerRoot, checkpointPath),
      context.workflowPlan,
      null,
      { allowLegacy: false }
    );
  } catch (error) {
    if (error instanceof NativeV3PlanRunnerError) throw error;
    const wrapped = new NativeV3PlanRunnerError(
      "EPLAN_INCIDENT_RECOVERY_CHECKPOINT",
      `plan runner checkpoint could not be read: ${String(error?.message ?? error)}`,
      "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  let runtimeReadback;
  try {
    runtimeReadback = await context.runtimeModule.readIncidentRecoveryDagRuntimeHandoffV1({
      stateRoot: context.stateRoot,
      runId: context.runId,
      handoffId: context.handoffId,
      controller
    });
  } catch (error) {
    const wrapped = new NativeV3PlanRunnerError(
      "EPLAN_INCIDENT_RECOVERY_RUNTIME",
      `durable DAG runtime handoff could not be read: ${String(error?.message ?? error)}`,
      error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  const preparedReceipt = validateIncidentRecoveryReplay(
    checkpoint,
    context.workflowPlan,
    context.recoveryPlan,
    runtimeReadback
  );
  if (preparedReceipt === null) {
    fail("EPLAN_INCIDENT_RECOVERY_NOT_PREPARED", "incident recovery checkpoint has not been prepared", "HOLD");
  }
  const event = incidentRecoveryPreparedEvent(checkpoint);
  if (event === null || event.sequence !== checkpoint.sequence) {
    fail("EPLAN_INCIDENT_RECOVERY_CONFLICT", "incident recovery prepared event is not the checkpoint boundary", "UNKNOWN");
  }
  return { runnerRoot, checkpoint, event, runtimeReadback, preparedReceipt };
}

function incidentRecoveryAuthorityReceiptBody(context, boundary, runtimeRecord) {
  const authorityRecord = runtimeRecord.claim ?? runtimeRecord.release ?? runtimeRecord.consumption;
  if (!authorityRecord) {
    fail("EPLAN_INCIDENT_RECOVERY_UNKNOWN", "runtime authority result is missing its durable record", "UNKNOWN");
  }
  return {
    runId: context.runId,
    planId: context.workflowPlan.planId,
    planDigest: context.workflowPlan.planDigest,
    contractDigest: context.workflowPlan.contractDigest,
    recoveryId: context.recoveryPlan.recoveryId,
    recoveryPlanDigest: context.recoveryPlan.manifestDigest,
    handoffId: context.handoffId,
    handoffDigest: boundary.runtimeReadback.handoff.handoffDigest,
    preparedCheckpointSequence: boundary.checkpoint.sequence,
    preparedCheckpointStateDigest: boundary.checkpoint.stateDigest,
    preparedEventSequence: boundary.event.sequence,
    preparedEventDigest: digestObject(boundary.event),
    runtimeRegistrySequence: authorityRecord.committedRegistrySequence,
    runtimeRegistryStateDigest: authorityRecord.committedRegistryStateDigest
  };
}

/**
 * Durably bind the exact S1e checkpoint to its S1d runtime handoff. This does
 * not alter the plan checkpoint or unblock any execution handle.
 */
export async function claimNativeV3PlanIncidentRecoveryHandoffV1(options = {}) {
  const supplied = exactOptions(options, INCIDENT_RECOVERY_CLAIM_KEYS, "incident recovery claim options");
  const context = await loadIncidentRecoveryAuthorityContext(supplied, "incident recovery claim");
  const runnerRoot = safeJoin(context.stateRoot, PLAN_RUNNER_DIRECTORY);
  return withBoundedPlanRunnerLock(runnerRoot, context.runId, async () => {
    const boundary = await readPreparedIncidentRecoveryAuthorityBoundary(context, supplied.controller);
    let runtimeClaim;
    try {
      runtimeClaim = await context.runtimeModule.claimIncidentRecoveryDagRuntimeHandoffV1({
        stateRoot: context.stateRoot,
        runId: context.runId,
        handoffId: context.handoffId,
        controller: supplied.controller,
        checkpoint: {
          recoveryPlanDigest: context.recoveryPlan.manifestDigest,
          planId: context.workflowPlan.planId,
          planDigest: context.workflowPlan.planDigest,
          contractDigest: context.workflowPlan.contractDigest,
          preparedCheckpointSequence: boundary.checkpoint.sequence,
          preparedCheckpointStateDigest: boundary.checkpoint.stateDigest,
          preparedEventSequence: boundary.event.sequence,
          preparedEventDigest: digestObject(boundary.event)
        }
      });
    } catch (error) {
      const wrapped = new NativeV3PlanRunnerError(
        "EPLAN_INCIDENT_RECOVERY_CLAIM",
        `durable runtime recovery claim failed: ${String(error?.message ?? error)}`,
        error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      );
      wrapped.cause = error;
      throw wrapped;
    }
    const common = incidentRecoveryAuthorityReceiptBody(context, boundary, runtimeClaim);
    const claim = runtimeClaim.claim;
    if (claim.runId !== common.runId || claim.planId !== common.planId || claim.planDigest !== common.planDigest ||
        claim.contractDigest !== common.contractDigest || claim.recoveryPlanDigest !== common.recoveryPlanDigest ||
        claim.handoffId !== common.handoffId || claim.handoffDigest !== common.handoffDigest ||
        claim.preparedCheckpointSequence !== common.preparedCheckpointSequence ||
        claim.preparedCheckpointStateDigest !== common.preparedCheckpointStateDigest ||
        claim.preparedEventSequence !== common.preparedEventSequence || claim.preparedEventDigest !== common.preparedEventDigest ||
        !same(claim.taskIds, boundary.preparedReceipt.taskIds) ||
        !same(runtimeClaim.effectAuthority, { mayUnblockHandle: false, mayDispatch: false, mayPerformEffects: false })) {
      fail("EPLAN_INCIDENT_RECOVERY_CLAIM_UNKNOWN", "durable runtime recovery claim readback is not exact", "UNKNOWN");
    }
    const body = {
      schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
      kind: NATIVE_V3_PLAN_INCIDENT_RECOVERY_CLAIM_KIND,
      status: "claimed",
      ...common,
      claimId: claim.claimId,
      claimDigest: claim.claimDigest,
      taskIds: clone(claim.taskIds),
      effectAuthority: clone(INCIDENT_RECOVERY_PERMIT_EFFECT_AUTHORITY),
      claimedAt: claim.claimedAt
    };
    return deepFreeze({ ...body, receiptDigest: digestObject(body) });
  });
}

/**
 * Persist one task-scoped release permit only after every dependency is
 * durably succeeded in the exact current checkpoint. The runtime handle stays
 * dispatch-blocked; S1f-B must consume this permit through a trusted adapter.
 */
export async function authorizeNativeV3PlanIncidentRecoveryTaskReleaseV1(options = {}) {
  const supplied = exactOptions(options, INCIDENT_RECOVERY_TASK_RELEASE_KEYS, "incident recovery task release options");
  const claimId = id(supplied.claimId, "claimId");
  const requestedTaskId = taskId(supplied.taskId, "taskId");
  const context = await loadIncidentRecoveryAuthorityContext(supplied, "incident recovery task release");
  const runnerRoot = safeJoin(context.stateRoot, PLAN_RUNNER_DIRECTORY);
  return withBoundedPlanRunnerLock(runnerRoot, context.runId, async () => {
    const boundary = await readPreparedIncidentRecoveryAuthorityBoundary(context, supplied.controller);
    const graphTask = context.workflowPlan.taskContract.graph.tasks.find((task) => task.id === requestedTaskId) ?? null;
    const checkpointTask = boundary.checkpoint.tasks[requestedTaskId] ?? null;
    const recoveryTask = context.recoveryPlan.tasks.find((task) => task.taskId === requestedTaskId) ?? null;
    if (!graphTask || !checkpointTask || !recoveryTask || recoveryTask.disposition !== "recover" ||
        checkpointTask.status !== "pending") {
      fail("EPLAN_INCIDENT_RECOVERY_RELEASE_TASK", `task ${requestedTaskId} is not a pending recovery task`, "HOLD");
    }
    const dependencies = graphTask.dependencies.map((dependencyTaskId) => {
      const dependency = boundary.checkpoint.tasks[dependencyTaskId];
      if (!dependency || dependency.status !== "succeeded") {
        fail(
          "EPLAN_INCIDENT_RECOVERY_RELEASE_DEPENDENCY",
          `task ${requestedTaskId} dependency ${dependencyTaskId} is not durably succeeded`,
          dependency?.status === "unknown" ? "UNKNOWN" : "HOLD"
        );
      }
      return {
        taskId: dependencyTaskId,
        status: "succeeded",
        stateDigest: digestObject(dependency)
      };
    }).sort((left, right) => left.taskId.localeCompare(right.taskId));
    let runtimeRelease;
    try {
      runtimeRelease = await context.runtimeModule.authorizeIncidentRecoveryDagRuntimeTaskReleaseV1({
        stateRoot: context.stateRoot,
        runId: context.runId,
        handoffId: context.handoffId,
        claimId,
        taskId: requestedTaskId,
        controller: supplied.controller,
        checkpoint: {
          checkpointSequence: boundary.checkpoint.sequence,
          checkpointStateDigest: boundary.checkpoint.stateDigest,
          taskStateDigest: digestObject(checkpointTask),
          dependencies
        }
      });
    } catch (error) {
      const wrapped = new NativeV3PlanRunnerError(
        "EPLAN_INCIDENT_RECOVERY_RELEASE",
        `durable runtime task release failed: ${String(error?.message ?? error)}`,
        error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      );
      wrapped.cause = error;
      throw wrapped;
    }
    const common = incidentRecoveryAuthorityReceiptBody(context, boundary, runtimeRelease);
    const release = runtimeRelease.release;
    if (release.runId !== common.runId || release.planId !== common.planId || release.planDigest !== common.planDigest ||
        release.contractDigest !== common.contractDigest || release.recoveryPlanDigest !== common.recoveryPlanDigest ||
        release.handoffId !== common.handoffId || release.handoffDigest !== common.handoffDigest ||
        release.claimId !== claimId || release.taskId !== requestedTaskId ||
        release.preparedEventSequence !== common.preparedEventSequence || release.preparedEventDigest !== common.preparedEventDigest ||
        release.checkpointSequence !== boundary.checkpoint.sequence ||
        release.checkpointStateDigest !== boundary.checkpoint.stateDigest ||
        release.taskStateDigest !== digestObject(checkpointTask) || !same(release.dependencies, dependencies) ||
        !same(runtimeRelease.effectAuthority, { mayUnblockHandle: false, mayDispatch: false, mayPerformEffects: false })) {
      fail("EPLAN_INCIDENT_RECOVERY_RELEASE_UNKNOWN", "durable runtime task release readback is not exact", "UNKNOWN");
    }
    const body = {
      schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
      kind: NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_RELEASE_KIND,
      status: "authorized",
      ...common,
      claimId,
      claimDigest: release.claimDigest,
      releaseId: release.releaseId,
      releaseDigest: release.releaseDigest,
      taskId: requestedTaskId,
      handleId: release.handleId,
      handleDigest: release.handleDigest,
      attemptId: release.attemptId,
      checkpointSequence: release.checkpointSequence,
      checkpointStateDigest: release.checkpointStateDigest,
      taskStateDigest: release.taskStateDigest,
      dependencies: clone(dependencies),
      dependencyStateDigest: release.dependencyStateDigest,
      effectAuthority: clone(INCIDENT_RECOVERY_PERMIT_EFFECT_AUTHORITY),
      authorizedAt: release.authorizedAt
    };
    return deepFreeze({ ...body, receiptDigest: digestObject(body) });
  });
}

/**
 * Consume one exact durable task release after re-reading the canonical
 * WorkflowPlan, recovery plan, prepared checkpoint, DAG dependencies, and
 * current blocked handoff handle.  This B1 boundary remains non-effecting.
 */
export async function consumeNativeV3PlanIncidentRecoveryTaskReleaseV1(options = {}) {
  const supplied = exactOptions(
    options,
    INCIDENT_RECOVERY_TASK_CONSUMPTION_KEYS,
    "incident recovery task consumption options"
  );
  const claimId = id(supplied.claimId, "claimId");
  const releaseId = id(supplied.releaseId, "releaseId");
  const requestedTaskId = taskId(supplied.taskId, "taskId");
  const context = await loadIncidentRecoveryAuthorityContext(supplied, "incident recovery task consumption");
  const runnerRoot = safeJoin(context.stateRoot, PLAN_RUNNER_DIRECTORY);
  return withBoundedPlanRunnerLock(runnerRoot, context.runId, async () => {
    const boundary = await readPreparedIncidentRecoveryAuthorityBoundary(context, supplied.controller);
    const graphTask = context.workflowPlan.taskContract.graph.tasks.find((task) => task.id === requestedTaskId) ?? null;
    const checkpointTask = boundary.checkpoint.tasks[requestedTaskId] ?? null;
    const recoveryTask = context.recoveryPlan.tasks.find((task) => task.taskId === requestedTaskId) ?? null;
    const handoffEntry = boundary.runtimeReadback.handoff.entries.find((entry) => entry.taskId === requestedTaskId) ?? null;
    if (!graphTask || !checkpointTask || !recoveryTask || !handoffEntry || recoveryTask.disposition !== "recover" ||
        checkpointTask.status !== "pending") {
      fail("EPLAN_INCIDENT_RECOVERY_CONSUMPTION_TASK", `task ${requestedTaskId} is not a pending recovery task`, "HOLD");
    }
    const dependencies = graphTask.dependencies.map((dependencyTaskId) => {
      const dependency = boundary.checkpoint.tasks[dependencyTaskId];
      if (!dependency || dependency.status !== "succeeded") {
        fail(
          "EPLAN_INCIDENT_RECOVERY_CONSUMPTION_DEPENDENCY",
          `task ${requestedTaskId} dependency ${dependencyTaskId} is not durably succeeded`,
          dependency?.status === "unknown" ? "UNKNOWN" : "HOLD"
        );
      }
      return {
        taskId: dependencyTaskId,
        status: "succeeded",
        stateDigest: digestObject(dependency)
      };
    }).sort((left, right) => left.taskId.localeCompare(right.taskId));
    let durableReleaseResult;
    try {
      durableReleaseResult = await readExecutionRecoveryTaskReleaseV1({
        stateRoot: context.stateRoot,
        runId: context.runId,
        controller: supplied.controller,
        releaseId
      });
    } catch (error) {
      const wrapped = new NativeV3PlanRunnerError(
        "EPLAN_INCIDENT_RECOVERY_CONSUMPTION_RELEASE",
        `durable runtime task release could not be observed before consumption: ${String(error?.message ?? error)}`,
        error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      );
      wrapped.cause = error;
      throw wrapped;
    }
    const durableRelease = durableReleaseResult.release;
    if (durableRelease.runId !== context.runId || durableRelease.planId !== context.workflowPlan.planId ||
        durableRelease.planDigest !== context.workflowPlan.planDigest ||
        durableRelease.contractDigest !== context.workflowPlan.contractDigest ||
        durableRelease.recoveryPlanDigest !== context.recoveryPlan.manifestDigest ||
        durableRelease.handoffId !== context.handoffId ||
        durableRelease.handoffDigest !== boundary.runtimeReadback.handoff.handoffDigest ||
        durableRelease.claimId !== claimId || durableRelease.releaseId !== releaseId ||
        durableRelease.taskId !== requestedTaskId || durableRelease.handleId !== handoffEntry.handleId ||
        durableRelease.handleDigest !== handoffEntry.handleDigest || durableRelease.attemptId !== handoffEntry.attemptId ||
        durableRelease.admissionDigest !== handoffEntry.admissionDigest ||
        durableRelease.preparedEventSequence !== boundary.event.sequence ||
        durableRelease.preparedEventDigest !== digestObject(boundary.event) ||
        durableRelease.checkpointSequence !== boundary.checkpoint.sequence ||
        durableRelease.checkpointStateDigest !== boundary.checkpoint.stateDigest ||
        durableRelease.taskStateDigest !== digestObject(checkpointTask) ||
        !same(durableRelease.dependencies, dependencies) ||
        durableRelease.dependencyStateDigest !== digestObject(dependencies) ||
        !same(durableReleaseResult.effectAuthority, {
          mayUnblockHandle: false,
          mayDispatch: false,
          mayPerformEffects: false
        })) {
      fail(
        "EPLAN_INCIDENT_RECOVERY_CONSUMPTION_RELEASE",
        "durable runtime task release is stale or not exact to the current canonical recovery boundary",
        "HOLD"
      );
    }
    let runtimeConsumption;
    try {
      runtimeConsumption = await context.runtimeModule.consumeIncidentRecoveryDagRuntimeTaskReleaseV1({
        stateRoot: context.stateRoot,
        runId: context.runId,
        handoffId: context.handoffId,
        claimId,
        releaseId,
        taskId: requestedTaskId,
        controller: supplied.controller
      });
    } catch (error) {
      const wrapped = new NativeV3PlanRunnerError(
        "EPLAN_INCIDENT_RECOVERY_CONSUMPTION",
        `durable runtime task consumption failed: ${String(error?.message ?? error)}`,
        error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      );
      wrapped.cause = error;
      throw wrapped;
    }
    const common = incidentRecoveryAuthorityReceiptBody(context, boundary, runtimeConsumption);
    const consumption = runtimeConsumption.consumption;
    if (consumption.runId !== common.runId || consumption.planId !== common.planId ||
        consumption.planDigest !== common.planDigest || consumption.contractDigest !== common.contractDigest ||
        consumption.recoveryPlanDigest !== common.recoveryPlanDigest || consumption.handoffId !== common.handoffId ||
        consumption.handoffDigest !== common.handoffDigest || consumption.claimId !== claimId ||
        consumption.releaseId !== releaseId || consumption.taskId !== requestedTaskId ||
        consumption.handleId !== handoffEntry.handleId || consumption.handleDigest !== handoffEntry.handleDigest ||
        consumption.attemptId !== handoffEntry.attemptId || consumption.admissionDigest !== handoffEntry.admissionDigest ||
        consumption.preparedEventSequence !== common.preparedEventSequence ||
        consumption.preparedEventDigest !== common.preparedEventDigest ||
        consumption.checkpointSequence !== boundary.checkpoint.sequence ||
        consumption.checkpointStateDigest !== boundary.checkpoint.stateDigest ||
        consumption.taskStateDigest !== digestObject(checkpointTask) ||
        !same(consumption.dependencies, dependencies) ||
        consumption.dependencyStateDigest !== digestObject(dependencies) ||
        !same(runtimeConsumption.effectAuthority, {
          mayUnblockHandle: false,
          mayDispatch: false,
          mayPerformEffects: false
        })) {
      fail(
        "EPLAN_INCIDENT_RECOVERY_CONSUMPTION_UNKNOWN",
        "durable runtime task consumption readback is not exact",
        "UNKNOWN"
      );
    }
    const body = {
      schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
      kind: NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_CONSUMPTION_KIND,
      status: "consumed",
      ...common,
      claimId,
      claimDigest: consumption.claimDigest,
      releaseId,
      releaseDigest: consumption.releaseDigest,
      consumptionId: consumption.consumptionId,
      consumptionDigest: consumption.consumptionDigest,
      taskId: requestedTaskId,
      handleId: consumption.handleId,
      handleDigest: consumption.handleDigest,
      attemptId: consumption.attemptId,
      admissionDigest: consumption.admissionDigest,
      checkpointSequence: consumption.checkpointSequence,
      checkpointStateDigest: consumption.checkpointStateDigest,
      taskStateDigest: consumption.taskStateDigest,
      dependencies: clone(dependencies),
      dependencyStateDigest: consumption.dependencyStateDigest,
      sourceRuntimeRegistrySequence: consumption.sourceRegistrySequence,
      sourceRuntimeRegistryStateDigest: consumption.sourceRegistryStateDigest,
      effectAuthority: clone(INCIDENT_RECOVERY_PERMIT_EFFECT_AUTHORITY),
      consumedAt: consumption.consumedAt
    };
    const receipt = deepFreeze({ ...body, receiptDigest: digestObject(body) });
    const issuanceKey = `${context.stateRoot}\u0000${context.runId}\u0000${consumption.consumptionId}\u0000${consumption.consumptionDigest}`;
    let issuance = PLAN_RECOVERY_TASK_CONSUMPTION_ISSUANCE.get(issuanceKey);
    if (!issuance) {
      issuance = { status: "available" };
      PLAN_RECOVERY_TASK_CONSUMPTION_ISSUANCE.set(issuanceKey, issuance);
    }
    PLAN_RECOVERY_TASK_CONSUMPTION_RECEIPTS.add(receipt);
    PLAN_RECOVERY_TASK_CONSUMPTION_BINDINGS.set(receipt, {
      issuance,
      context,
      controller: supplied.controller,
      runnerRoot,
      supplied: {
        claimId,
        releaseId,
        consumptionId: consumption.consumptionId,
        taskId: requestedTaskId,
        controller: supplied.controller
      }
    });
    return receipt;
  });
}

async function readPlanBoundIncidentRecoveryTaskConsumption(context, supplied, label) {
  let workflowPlan;
  try {
    workflowPlan = await readFreshWorkflowPlanV1({
      root: context.stateRoot,
      planId: context.recoveryPlan.workflow.planId,
      expected: {
        planDigest: context.recoveryPlan.workflow.planDigest,
        contractDigest: context.recoveryPlan.workflow.contractDigest,
        sourceRevision: context.recoveryPlan.workflow.revision,
        sourceDigest: context.recoveryPlan.workflow.sourceBindingDigest,
        policyDigest: context.recoveryPlan.workflow.policyDigest
      }
    });
  } catch (error) {
    const wrapped = new NativeV3PlanRunnerError(
      "EPLAN_INCIDENT_RECOVERY_EFFECT_SOURCE",
      `${label} fresh WorkflowPlanV1 could not be revalidated: ${String(error?.message ?? error)}`,
      error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  const freshContext = { ...context, workflowPlan };
  const boundary = await readPreparedIncidentRecoveryAuthorityBoundary(freshContext, supplied.controller);
  const requestedTaskId = taskId(supplied.taskId, "taskId");
  const claimId = id(supplied.claimId, "claimId");
  const releaseId = id(supplied.releaseId, "releaseId");
  const consumptionId = id(supplied.consumptionId, "consumptionId");
  const graphTask = workflowPlan.taskContract.graph.tasks.find((task) => task.id === requestedTaskId) ?? null;
  const checkpointTask = boundary.checkpoint.tasks[requestedTaskId] ?? null;
  const recoveryTask = context.recoveryPlan.tasks.find((task) => task.taskId === requestedTaskId) ?? null;
  const handoffEntry = boundary.runtimeReadback.handoff.entries.find((entry) => entry.taskId === requestedTaskId) ?? null;
  if (!graphTask || !checkpointTask || !recoveryTask || !handoffEntry || recoveryTask.disposition !== "recover" ||
      checkpointTask.status !== "pending") {
    fail("EPLAN_INCIDENT_RECOVERY_EFFECT_TASK", `task ${requestedTaskId} is not a pending recovery task`, "HOLD");
  }
  const dependencies = graphTask.dependencies.map((dependencyTaskId) => {
    const dependency = boundary.checkpoint.tasks[dependencyTaskId];
    if (!dependency || dependency.status !== "succeeded") {
      fail(
        "EPLAN_INCIDENT_RECOVERY_EFFECT_DEPENDENCY",
        `task ${requestedTaskId} dependency ${dependencyTaskId} is not durably succeeded`,
        dependency?.status === "unknown" ? "UNKNOWN" : "HOLD"
      );
    }
    return {
      taskId: dependencyTaskId,
      status: "succeeded",
      stateDigest: digestObject(dependency)
    };
  }).sort((left, right) => left.taskId.localeCompare(right.taskId));
  let durableResult;
  try {
    durableResult = await readExecutionRecoveryTaskPermitConsumptionV1({
      stateRoot: context.stateRoot,
      runId: context.runId,
      controller: supplied.controller,
      consumptionId
    });
  } catch (error) {
    const wrapped = new NativeV3PlanRunnerError(
      "EPLAN_INCIDENT_RECOVERY_EFFECT_CONSUMPTION",
      `${label} durable task consumption could not be observed: ${String(error?.message ?? error)}`,
      error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  const consumption = durableResult.consumption;
  if (consumption.runId !== context.runId || consumption.planId !== workflowPlan.planId ||
      consumption.planDigest !== workflowPlan.planDigest || consumption.contractDigest !== workflowPlan.contractDigest ||
      consumption.recoveryPlanDigest !== context.recoveryPlan.manifestDigest ||
      consumption.handoffId !== context.handoffId ||
      consumption.handoffDigest !== boundary.runtimeReadback.handoff.handoffDigest ||
      consumption.claimId !== claimId || consumption.releaseId !== releaseId ||
      consumption.consumptionId !== consumptionId || consumption.taskId !== requestedTaskId ||
      consumption.handleId !== handoffEntry.handleId || consumption.handleDigest !== handoffEntry.handleDigest ||
      consumption.attemptId !== handoffEntry.attemptId || consumption.admissionDigest !== handoffEntry.admissionDigest ||
      consumption.preparedEventSequence !== boundary.event.sequence ||
      consumption.preparedEventDigest !== digestObject(boundary.event) ||
      consumption.checkpointSequence !== boundary.checkpoint.sequence ||
      consumption.checkpointStateDigest !== boundary.checkpoint.stateDigest ||
      consumption.taskStateDigest !== digestObject(checkpointTask) ||
      !same(consumption.dependencies, dependencies) ||
      consumption.dependencyStateDigest !== digestObject(dependencies) ||
      !same(durableResult.effectAuthority, {
        mayUnblockHandle: false,
        mayDispatch: false,
        mayPerformEffects: false
      })) {
    fail(
      "EPLAN_INCIDENT_RECOVERY_EFFECT_CONSUMPTION",
      `${label} durable task consumption is stale or not exact to the current canonical recovery boundary`,
      "HOLD"
    );
  }
  return {
    context: freshContext,
    boundary,
    checkpointTask,
    dependencies,
    handoffEntry,
    consumption,
    durableResult
  };
}

function assertPlanBoundRecoveryTaskEffectIntent(intent, observed, expectedStatus, label) {
  const { context, boundary, checkpointTask, dependencies, handoffEntry, consumption } = observed;
  if (!intent || intent.status !== expectedStatus || intent.runId !== context.runId ||
      intent.planId !== context.workflowPlan.planId || intent.planDigest !== context.workflowPlan.planDigest ||
      intent.contractDigest !== context.workflowPlan.contractDigest ||
      intent.recoveryPlanDigest !== context.recoveryPlan.manifestDigest ||
      intent.handoffId !== context.handoffId || intent.handoffDigest !== boundary.runtimeReadback.handoff.handoffDigest ||
      intent.claimId !== consumption.claimId || intent.releaseId !== consumption.releaseId ||
      intent.consumptionId !== consumption.consumptionId || intent.consumptionDigest !== consumption.consumptionDigest ||
      intent.taskId !== consumption.taskId || intent.handleId !== handoffEntry.handleId ||
      intent.handleDigest !== handoffEntry.handleDigest || intent.attemptId !== handoffEntry.attemptId ||
      intent.admissionDigest !== handoffEntry.admissionDigest ||
      intent.preparedEventSequence !== boundary.event.sequence ||
      intent.preparedEventDigest !== digestObject(boundary.event) ||
      intent.checkpointSequence !== boundary.checkpoint.sequence ||
      intent.checkpointStateDigest !== boundary.checkpoint.stateDigest ||
      intent.taskStateDigest !== digestObject(checkpointTask) ||
      !same(intent.dependencies, dependencies) || intent.dependencyStateDigest !== digestObject(dependencies) ||
      intent.callbackCalls !== 0 || intent.effectStarted !== false ||
      !same(intent.effectAuthority, {
        mayUnblockHandle: false,
        mayDispatch: false,
        mayPerformEffects: false
      })) {
    fail(
      "EPLAN_INCIDENT_RECOVERY_EFFECT_UNKNOWN",
      `${label} durable intent is not exact to the current plan-bound consumption`,
      "UNKNOWN"
    );
  }
}

/**
 * Mint an opaque process-local capability only after re-reading the complete
 * canonical B1 boundary.  The returned object has no serializable effect
 * authority and does not itself append an intent or reserve dispatch.
 *
 * The branded B1 receipt is deliberately burned before validation awaits.
 * A HOLD or UNKNOWN result therefore requires a fresh process to replay the
 * canonical durable B1 boundary; same-process token rollback is forbidden.
 */
export async function mintNativeV3PlanIncidentRecoveryTaskCapabilityV1(options = {}) {
  const supplied = exactOptions(
    options,
    INCIDENT_RECOVERY_TASK_EFFECT_CAPABILITY_KEYS,
    "incident recovery task effect capability options"
  );
  const consumptionReceipt = supplied.consumptionReceipt;
  const receiptBinding = PLAN_RECOVERY_TASK_CONSUMPTION_BINDINGS.get(consumptionReceipt) ?? null;
  if (!PLAN_RECOVERY_TASK_CONSUMPTION_RECEIPTS.has(consumptionReceipt) || !receiptBinding) {
    fail(
      "EPLAN_INCIDENT_RECOVERY_CAPABILITY_BRAND",
      "consumptionReceipt is absent, copied, proxied, or serialized",
      "HOLD"
    );
  }
  if (receiptBinding.issuance.status !== "available") {
    fail("EPLAN_INCIDENT_RECOVERY_CAPABILITY_REPLAY", "consumptionReceipt was already consumed", "HOLD");
  }
  // Consume the process-local B1 receipt before the first await so concurrent
  // mint attempts cannot both obtain a capability.
  receiptBinding.issuance.status = "consuming";
  return withBoundedPlanRunnerLock(receiptBinding.runnerRoot, receiptBinding.context.runId, async () => {
    const observed = await readPlanBoundIncidentRecoveryTaskConsumption(
      receiptBinding.context,
      receiptBinding.supplied,
      "incident recovery task effect capability"
    );
    if (consumptionReceipt.kind !== NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_CONSUMPTION_KIND ||
        consumptionReceipt.status !== "consumed" || consumptionReceipt.runId !== observed.context.runId ||
        consumptionReceipt.planId !== observed.context.workflowPlan.planId ||
        consumptionReceipt.planDigest !== observed.context.workflowPlan.planDigest ||
        consumptionReceipt.contractDigest !== observed.context.workflowPlan.contractDigest ||
        consumptionReceipt.recoveryPlanDigest !== observed.context.recoveryPlan.manifestDigest ||
        consumptionReceipt.handoffId !== observed.context.handoffId ||
        consumptionReceipt.handoffDigest !== observed.boundary.runtimeReadback.handoff.handoffDigest ||
        consumptionReceipt.claimId !== observed.consumption.claimId ||
        consumptionReceipt.releaseId !== observed.consumption.releaseId ||
        consumptionReceipt.consumptionId !== observed.consumption.consumptionId ||
        consumptionReceipt.consumptionDigest !== observed.consumption.consumptionDigest ||
        consumptionReceipt.taskId !== observed.consumption.taskId ||
        consumptionReceipt.handleId !== observed.consumption.handleId ||
        consumptionReceipt.handleDigest !== observed.consumption.handleDigest ||
        consumptionReceipt.attemptId !== observed.consumption.attemptId ||
        consumptionReceipt.admissionDigest !== observed.consumption.admissionDigest ||
        consumptionReceipt.checkpointSequence !== observed.boundary.checkpoint.sequence ||
        consumptionReceipt.checkpointStateDigest !== observed.boundary.checkpoint.stateDigest ||
        consumptionReceipt.taskStateDigest !== digestObject(observed.checkpointTask) ||
        !same(consumptionReceipt.dependencies, observed.dependencies) ||
        consumptionReceipt.dependencyStateDigest !== digestObject(observed.dependencies) ||
        !same(consumptionReceipt.effectAuthority, INCIDENT_RECOVERY_PERMIT_EFFECT_AUTHORITY)) {
      fail(
        "EPLAN_INCIDENT_RECOVERY_CAPABILITY_STALE",
        "consumptionReceipt is not exact to the freshly revalidated B1 boundary",
        "HOLD"
      );
    }
    const capabilityId = `recovery-effect-capability:${randomUUID()}`;
    const body = {
      schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
      kind: NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_EFFECT_CAPABILITY_KIND,
      status: "ready",
      capabilityId,
      runId: observed.context.runId,
      planId: observed.context.workflowPlan.planId,
      planDigest: observed.context.workflowPlan.planDigest,
      contractDigest: observed.context.workflowPlan.contractDigest,
      recoveryId: observed.context.recoveryPlan.recoveryId,
      recoveryPlanDigest: observed.context.recoveryPlan.manifestDigest,
      handoffId: observed.context.handoffId,
      handoffDigest: observed.boundary.runtimeReadback.handoff.handoffDigest,
      claimId: observed.consumption.claimId,
      releaseId: observed.consumption.releaseId,
      consumptionId: observed.consumption.consumptionId,
      consumptionDigest: observed.consumption.consumptionDigest,
      taskId: observed.consumption.taskId,
      handleId: observed.consumption.handleId,
      handleDigest: observed.consumption.handleDigest,
      attemptId: observed.consumption.attemptId,
      admissionDigest: observed.consumption.admissionDigest,
      preparedCheckpointSequence: observed.boundary.checkpoint.sequence,
      preparedCheckpointStateDigest: observed.boundary.checkpoint.stateDigest,
      preparedEventSequence: observed.boundary.event.sequence,
      preparedEventDigest: digestObject(observed.boundary.event),
      effectAuthority: clone(INCIDENT_RECOVERY_TASK_EFFECT_AUTHORITY),
      preparedAt: nowIso()
    };
    const capability = deepFreeze({ ...body, capabilityDigest: digestObject(body) });
    PLAN_RECOVERY_TASK_EFFECT_CAPABILITIES.set(capability, {
      context: observed.context,
      controller: receiptBinding.controller,
      runnerRoot: receiptBinding.runnerRoot,
      supplied: {
        claimId: observed.consumption.claimId,
        releaseId: observed.consumption.releaseId,
        consumptionId: observed.consumption.consumptionId,
        taskId: observed.consumption.taskId,
        controller: receiptBinding.controller
      },
      capabilityId,
      capabilityDigest: capability.capabilityDigest
    });
    receiptBinding.issuance.status = "consumed";
    return capability;
  });
}

/**
 * Consume one genuine capability and atomically cover fresh canonical
 * validation plus the two journal-only created/reserved transitions with the
 * same plan lock.  No callback, command, provider, or adapter is invoked.
 * The capability is deliberately burned before validation awaits.  On any
 * ambiguous result callers must inspect durable intent state (when present)
 * or restart from the canonical B1 boundary, never reuse this capability.
 */
export async function reserveNativeV3PlanIncidentRecoveryTaskCapabilityV1(capability) {
  const privateState = PLAN_RECOVERY_TASK_EFFECT_CAPABILITIES.get(capability) ?? null;
  if (!privateState) {
    fail(
      "EPLAN_INCIDENT_RECOVERY_EFFECT_CAPABILITY",
      "incident recovery task effect capability is absent, copied, proxied, serialized, or already consumed",
      "HOLD"
    );
  }
  PLAN_RECOVERY_TASK_EFFECT_CAPABILITIES.delete(capability);
  return withBoundedPlanRunnerLock(privateState.runnerRoot, privateState.context.runId, async () => {
    const observed = await readPlanBoundIncidentRecoveryTaskConsumption(
      privateState.context,
      privateState.supplied,
      "incident recovery task effect reservation"
    );
    if (observed.consumption.consumptionDigest !== capability.consumptionDigest ||
        observed.consumption.handleDigest !== capability.handleDigest ||
        observed.boundary.checkpoint.stateDigest !== capability.preparedCheckpointStateDigest) {
      fail("EPLAN_INCIDENT_RECOVERY_EFFECT_CAPABILITY", "incident recovery task effect capability is stale", "HOLD");
    }
    let created;
    try {
      created = await observed.context.runtimeModule.createIncidentRecoveryDagRuntimeTaskEffectIntentV1({
        stateRoot: observed.context.stateRoot,
        runId: observed.context.runId,
        handoffId: observed.context.handoffId,
        consumptionId: observed.consumption.consumptionId,
        taskId: observed.consumption.taskId,
        handleId: observed.consumption.handleId,
        controller: privateState.controller
      });
    } catch (error) {
      const wrapped = new NativeV3PlanRunnerError(
        "EPLAN_INCIDENT_RECOVERY_EFFECT_INTENT",
        `durable recovery effect intent creation failed: ${String(error?.message ?? error)}`,
        error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      );
      wrapped.cause = error;
      throw wrapped;
    }
    if (!["created", "dispatch-reserved"].includes(created.intent?.status)) {
      fail(
        "EPLAN_INCIDENT_RECOVERY_EFFECT_STATE",
        "durable recovery effect intent is already terminal",
        created.intent?.status === "unknown" ? "UNKNOWN" : "HOLD"
      );
    }
    assertPlanBoundRecoveryTaskEffectIntent(
      created.intent,
      observed,
      created.intent.status,
      "incident recovery task effect creation"
    );
    let reserved = created;
    if (created.intent.status === "created") {
      try {
        reserved = await observed.context.runtimeModule.reserveIncidentRecoveryDagRuntimeTaskEffectIntentV1({
          stateRoot: observed.context.stateRoot,
          runId: observed.context.runId,
          handoffId: observed.context.handoffId,
          intentId: created.intent.intentId,
          controller: privateState.controller
        });
      } catch (error) {
        const wrapped = new NativeV3PlanRunnerError(
          "EPLAN_INCIDENT_RECOVERY_EFFECT_RESERVATION",
          `durable recovery effect reservation failed: ${String(error?.message ?? error)}`,
          error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
        );
        wrapped.cause = error;
        throw wrapped;
      }
    }
    assertPlanBoundRecoveryTaskEffectIntent(
      reserved.intent,
      observed,
      "dispatch-reserved",
      "incident recovery task effect reservation"
    );
    if (!same(reserved.effectAuthority, {
      mayUnblockHandle: false,
      mayDispatch: false,
      mayPerformEffects: false
    })) {
      fail("EPLAN_INCIDENT_RECOVERY_EFFECT_UNKNOWN", "durable recovery effect reservation granted authority", "UNKNOWN");
    }
    const body = {
      schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
      kind: NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_EFFECT_RESERVATION_KIND,
      status: "dispatch-reserved",
      capabilityId: privateState.capabilityId,
      capabilityDigest: privateState.capabilityDigest,
      runId: observed.context.runId,
      planId: observed.context.workflowPlan.planId,
      planDigest: observed.context.workflowPlan.planDigest,
      contractDigest: observed.context.workflowPlan.contractDigest,
      recoveryId: observed.context.recoveryPlan.recoveryId,
      recoveryPlanDigest: observed.context.recoveryPlan.manifestDigest,
      handoffId: observed.context.handoffId,
      handoffDigest: observed.boundary.runtimeReadback.handoff.handoffDigest,
      consumptionId: observed.consumption.consumptionId,
      consumptionDigest: observed.consumption.consumptionDigest,
      taskId: observed.consumption.taskId,
      handleId: observed.consumption.handleId,
      handleDigest: observed.consumption.handleDigest,
      attemptId: observed.consumption.attemptId,
      admissionDigest: observed.consumption.admissionDigest,
      intentId: reserved.intent.intentId,
      intentDigest: reserved.intent.intentDigest,
      reservationId: reserved.intent.reservationId,
      runtimeRegistrySequence: reserved.intent.committedRegistrySequence,
      runtimeRegistryStateDigest: reserved.intent.committedRegistryStateDigest,
      callbackCalls: 0,
      effectStarted: false,
      effectAuthority: clone(INCIDENT_RECOVERY_TASK_EFFECT_AUTHORITY),
      reservedAt: reserved.intent.reservedAt
    };
    const reservation = deepFreeze({ ...body, reservationDigest: digestObject(body) });
    PLAN_RECOVERY_TASK_EFFECT_RESERVATIONS.set(reservation, {
      context: observed.context,
      controller: privateState.controller,
      runnerRoot: privateState.runnerRoot,
      supplied: privateState.supplied,
      intentId: reserved.intent.intentId,
      intentDigest: reserved.intent.intentDigest,
      reservationId: reserved.intent.reservationId,
      reservationDigest: reservation.reservationDigest
    });
    return reservation;
  });
}

/**
 * Consume one exact B2a reservation into a process-local, non-effecting native
 * command adoption.  B2b1 deliberately does not create a runner, resource
 * adapter, callback, or durable transition.  The reservation is burned before
 * the first await; any failed or ambiguous validation must restart from the
 * canonical durable recovery boundary in a fresh process.
 */
export async function adoptNativeV3PlanIncidentRecoveryTaskReservationV1(options = {}) {
  const supplied = exactOptions(
    options,
    INCIDENT_RECOVERY_TASK_COMMAND_ADOPTION_KEYS,
    "incident recovery task command adoption options"
  );
  const reservation = supplied.reservation;
  const privateState = PLAN_RECOVERY_TASK_EFFECT_RESERVATIONS.get(reservation) ?? null;
  if (!privateState) {
    fail(
      "EPLAN_INCIDENT_RECOVERY_COMMAND_ADOPTION_RESERVATION",
      "incident recovery task effect reservation is absent, copied, proxied, serialized, or already consumed",
      "HOLD"
    );
  }
  // Burn before the first await so adoption, terminalization, and concurrent
  // adoption cannot derive two process-local successors from one reservation.
  PLAN_RECOVERY_TASK_EFFECT_RESERVATIONS.delete(reservation);
  return withBoundedPlanRunnerLock(privateState.runnerRoot, privateState.context.runId, async () => {
    const observed = await readPlanBoundIncidentRecoveryTaskConsumption(
      privateState.context,
      privateState.supplied,
      "incident recovery task command adoption"
    );
    let intentResult;
    try {
      intentResult = await observed.context.runtimeModule.readIncidentRecoveryDagRuntimeTaskEffectIntentV1({
        stateRoot: observed.context.stateRoot,
        runId: observed.context.runId,
        handoffId: observed.context.handoffId,
        intentId: privateState.intentId,
        controller: privateState.controller
      });
    } catch (error) {
      const wrapped = new NativeV3PlanRunnerError(
        "EPLAN_INCIDENT_RECOVERY_COMMAND_ADOPTION_INTENT",
        `durable recovery effect reservation could not be observed: ${String(error?.message ?? error)}`,
        error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      );
      wrapped.cause = error;
      throw wrapped;
    }
    assertPlanBoundRecoveryTaskEffectIntent(
      intentResult.intent,
      observed,
      "dispatch-reserved",
      "incident recovery task command adoption"
    );
    const intent = intentResult.intent;
    if (intent.intentId !== privateState.intentId || intent.intentDigest !== privateState.intentDigest ||
        intent.reservationId !== privateState.reservationId ||
        reservation.kind !== NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_EFFECT_RESERVATION_KIND ||
        reservation.status !== "dispatch-reserved" ||
        reservation.reservationDigest !== privateState.reservationDigest ||
        reservation.intentId !== intent.intentId || reservation.intentDigest !== intent.intentDigest ||
        reservation.reservationId !== intent.reservationId ||
        reservation.runId !== observed.context.runId ||
        reservation.planId !== observed.context.workflowPlan.planId ||
        reservation.planDigest !== observed.context.workflowPlan.planDigest ||
        reservation.contractDigest !== observed.context.workflowPlan.contractDigest ||
        reservation.recoveryPlanDigest !== observed.context.recoveryPlan.manifestDigest ||
        reservation.handoffId !== observed.context.handoffId ||
        reservation.handoffDigest !== observed.boundary.runtimeReadback.handoff.handoffDigest ||
        reservation.consumptionId !== observed.consumption.consumptionId ||
        reservation.consumptionDigest !== observed.consumption.consumptionDigest ||
        reservation.taskId !== observed.consumption.taskId ||
        reservation.handleId !== observed.handoffEntry.handleId ||
        reservation.handleDigest !== observed.handoffEntry.handleDigest ||
        reservation.attemptId !== observed.handoffEntry.attemptId ||
        reservation.admissionDigest !== observed.handoffEntry.admissionDigest ||
        reservation.callbackCalls !== 0 || reservation.effectStarted !== false ||
        !same(reservation.effectAuthority, INCIDENT_RECOVERY_TASK_EFFECT_AUTHORITY)) {
      fail(
        "EPLAN_INCIDENT_RECOVERY_COMMAND_ADOPTION_RESERVATION",
        "incident recovery task effect reservation is stale or not exact to the canonical B2a boundary",
        "HOLD"
      );
    }
    const handle = observed.boundary.runtimeReadback.handles.find(
      (candidate) => candidate.handleId === observed.handoffEntry.handleId
    ) ?? null;
    if (!handle || digestObject(handle) !== observed.handoffEntry.handleDigest ||
        handle.status !== "ready" || handle.dispatchBlocked !== true) {
      fail(
        "EPLAN_INCIDENT_RECOVERY_COMMAND_ADOPTION_HANDLE",
        "incident recovery handoff handle is absent, drifted, or no longer dispatch-blocked",
        "HOLD"
      );
    }

    const commandValidationOptions = {
      stateRoot: observed.context.stateRoot,
      workspaceRoot: supplied.workspaceRoot,
      planId: observed.context.workflowPlan.planId,
      runId: observed.context.runId,
      taskId: observed.consumption.taskId,
      unitId: handle.unitId,
      handle,
      controller: privateState.controller,
      bindingPath: supplied.bindingPath,
      expectedCommandDigest: supplied.expectedCommandDigest,
      approvalEnvelope: supplied.approvalEnvelope,
      effectBindingDigest: supplied.effectBindingDigest,
      recoveryPlanDigest: observed.context.recoveryPlan.manifestDigest,
      sourceBinding: observed.context.workflowPlan.taskContract.bindings.source,
      policyDigest: observed.context.workflowPlan.taskContract.bindings.policy.digest,
      trustMode: supplied.trustMode,
      ...(supplied.requestedModel === undefined ? {} : { requestedModel: supplied.requestedModel }),
      ...(supplied.clock === undefined ? {} : { clock: supplied.clock })
    };
    let prepared;
    try {
      prepared = await prepareNativeV3RecoveryCommandAdoptionV1(commandValidationOptions);
    } catch (error) {
      const wrapped = new NativeV3PlanRunnerError(
        "EPLAN_INCIDENT_RECOVERY_COMMAND_ADOPTION",
        `native recovery command adoption failed: ${String(error?.message ?? error)}`,
        error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      );
      wrapped.cause = error;
      throw wrapped;
    }
    const validation = prepared.validation;
    if (!validation || validation.kind !== NATIVE_V3_RECOVERY_COMMAND_ADOPTION_VALIDATION_KIND ||
        validation.status !== "validated" || validation.runId !== observed.context.runId ||
        validation.planId !== observed.context.workflowPlan.planId ||
        validation.planDigest !== observed.context.workflowPlan.planDigest ||
        validation.contractDigest !== observed.context.workflowPlan.contractDigest ||
        validation.taskId !== observed.consumption.taskId || validation.unitId !== handle.unitId ||
        validation.handleId !== handle.handleId || validation.handleDigest !== digestObject(handle) ||
        validation.executionId !== handle.executionId || validation.attemptId !== handle.attemptId ||
        validation.ownedResourceId !== handle.ownedResourceId ||
        validation.admissionDigest !== handle.admissionDigest ||
        validation.recoveryPlanDigest !== observed.context.recoveryPlan.manifestDigest ||
        validation.callbackCalls !== 0 || validation.effectStarted !== false ||
        !same(validation.effectAuthority, INCIDENT_RECOVERY_TASK_EFFECT_AUTHORITY)) {
      fail(
        "EPLAN_INCIDENT_RECOVERY_COMMAND_ADOPTION_UNKNOWN",
        "native recovery command validation is not exact to the blocked B2a handle",
        "UNKNOWN"
      );
    }

    // Close the read window after command validation.  B2b1 publishes no
    // descriptor if the canonical checkpoint, dependency set, consumption,
    // handle, or durable intent changed during the fresh command reads.
    const confirmed = await readPlanBoundIncidentRecoveryTaskConsumption(
      observed.context,
      {
        claimId: observed.consumption.claimId,
        releaseId: observed.consumption.releaseId,
        consumptionId: observed.consumption.consumptionId,
        taskId: observed.consumption.taskId,
        controller: privateState.controller
      },
      "incident recovery task command adoption confirmation"
    );
    const confirmedIntent = await confirmed.context.runtimeModule.readIncidentRecoveryDagRuntimeTaskEffectIntentV1({
      stateRoot: confirmed.context.stateRoot,
      runId: confirmed.context.runId,
      handoffId: confirmed.context.handoffId,
      intentId: privateState.intentId,
      controller: privateState.controller
    });
    assertPlanBoundRecoveryTaskEffectIntent(
      confirmedIntent.intent,
      confirmed,
      "dispatch-reserved",
      "incident recovery task command adoption confirmation"
    );
    if (confirmed.boundary.checkpoint.stateDigest !== observed.boundary.checkpoint.stateDigest ||
        confirmed.boundary.runtimeReadback.registryHead.stateDigest !== observed.boundary.runtimeReadback.registryHead.stateDigest ||
        confirmedIntent.intent.intentDigest !== intent.intentDigest) {
      fail(
        "EPLAN_INCIDENT_RECOVERY_COMMAND_ADOPTION_DRIFT",
        "canonical recovery state changed during command adoption",
        "HOLD"
      );
    }

    let confirmedPrepared;
    try {
      confirmedPrepared = await prepareNativeV3RecoveryCommandAdoptionV1(commandValidationOptions);
    } catch (error) {
      const wrapped = new NativeV3PlanRunnerError(
        "EPLAN_INCIDENT_RECOVERY_COMMAND_ADOPTION_DRIFT",
        `native recovery command or controller changed during adoption: ${String(error?.message ?? error)}`,
        error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      );
      wrapped.cause = error;
      throw wrapped;
    }
    const confirmedValidation = confirmedPrepared.validation;
    const { validatedAt: initialValidatedAt, validationDigest: initialValidationDigest, ...initialStableValidation } = validation;
    const { validatedAt: confirmedValidatedAt, validationDigest: confirmedValidationDigest, ...confirmedStableValidation } = confirmedValidation;
    void initialValidatedAt;
    void initialValidationDigest;
    void confirmedValidatedAt;
    void confirmedValidationDigest;
    if (!same(initialStableValidation, confirmedStableValidation) ||
        !same(prepared.commandBinding, confirmedPrepared.commandBinding) ||
        !same(prepared.admission, confirmedPrepared.admission)) {
      fail(
        "EPLAN_INCIDENT_RECOVERY_COMMAND_ADOPTION_DRIFT",
        "native recovery command, controller, or admission changed during adoption",
        "HOLD"
      );
    }

    const finalConfirmed = await readPlanBoundIncidentRecoveryTaskConsumption(
      confirmed.context,
      {
        claimId: confirmed.consumption.claimId,
        releaseId: confirmed.consumption.releaseId,
        consumptionId: confirmed.consumption.consumptionId,
        taskId: confirmed.consumption.taskId,
        controller: privateState.controller
      },
      "incident recovery task command adoption final confirmation"
    );
    const finalConfirmedIntent = await finalConfirmed.context.runtimeModule.readIncidentRecoveryDagRuntimeTaskEffectIntentV1({
      stateRoot: finalConfirmed.context.stateRoot,
      runId: finalConfirmed.context.runId,
      handoffId: finalConfirmed.context.handoffId,
      intentId: privateState.intentId,
      controller: privateState.controller
    });
    assertPlanBoundRecoveryTaskEffectIntent(
      finalConfirmedIntent.intent,
      finalConfirmed,
      "dispatch-reserved",
      "incident recovery task command adoption final confirmation"
    );
    if (finalConfirmed.boundary.checkpoint.stateDigest !== confirmed.boundary.checkpoint.stateDigest ||
        finalConfirmed.boundary.runtimeReadback.registryHead.stateDigest !== confirmed.boundary.runtimeReadback.registryHead.stateDigest ||
        finalConfirmedIntent.intent.intentDigest !== confirmedIntent.intent.intentDigest) {
      fail(
        "EPLAN_INCIDENT_RECOVERY_COMMAND_ADOPTION_DRIFT",
        "canonical recovery state changed during final command adoption confirmation",
        "HOLD"
      );
    }

    const body = {
      schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
      kind: NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_COMMAND_ADOPTION_KIND,
      status: "command-adopted",
      reservationDigest: privateState.reservationDigest,
      validationDigest: confirmedValidation.validationDigest,
      runId: confirmedValidation.runId,
      planId: confirmedValidation.planId,
      planDigest: confirmedValidation.planDigest,
      contractDigest: confirmedValidation.contractDigest,
      recoveryPlanDigest: finalConfirmed.context.recoveryPlan.manifestDigest,
      handoffId: finalConfirmed.context.handoffId,
      handoffDigest: finalConfirmed.boundary.runtimeReadback.handoff.handoffDigest,
      consumptionId: finalConfirmed.consumption.consumptionId,
      consumptionDigest: finalConfirmed.consumption.consumptionDigest,
      taskId: confirmedValidation.taskId,
      unitId: confirmedValidation.unitId,
      handleId: confirmedValidation.handleId,
      handleDigest: confirmedValidation.handleDigest,
      executionId: confirmedValidation.executionId,
      attemptId: confirmedValidation.attemptId,
      ownedResourceId: confirmedValidation.ownedResourceId,
      admissionDigest: confirmedValidation.admissionDigest,
      intentId: intent.intentId,
      intentDigest: intent.intentDigest,
      reservationId: intent.reservationId,
      approvalEnvelopeDigest: confirmedValidation.approvalEnvelopeDigest,
      commandDigest: confirmedValidation.commandDigest,
      effectBindingDigest: confirmedValidation.effectBindingDigest,
      controllerId: confirmedValidation.controllerId,
      callbackCalls: 0,
      effectStarted: false,
      effectAuthority: clone(INCIDENT_RECOVERY_TASK_EFFECT_AUTHORITY),
      adoptedAt: confirmedValidation.validatedAt
    };
    const adoption = deepFreeze({ ...body, adoptionDigest: digestObject(body) });
    PLAN_RECOVERY_TASK_COMMAND_ADOPTIONS.set(adoption, {
      context: finalConfirmed.context,
      controller: privateState.controller,
      runnerRoot: privateState.runnerRoot,
      prepared: confirmedPrepared,
      validationOptions: Object.freeze({ ...commandValidationOptions,
        handle: deepFreeze(clone(commandValidationOptions.handle)),
        approvalEnvelope: deepFreeze(clone(commandValidationOptions.approvalEnvelope)),
        sourceBinding: deepFreeze(clone(commandValidationOptions.sourceBinding)) }),
      consumptionOptions: Object.freeze({ claimId: finalConfirmed.consumption.claimId,
        releaseId: finalConfirmed.consumption.releaseId, consumptionId: finalConfirmed.consumption.consumptionId,
        taskId: finalConfirmed.consumption.taskId, controller: privateState.controller }),
      checkpointStateDigest: finalConfirmed.boundary.checkpoint.stateDigest,
      dispatchNonce: randomUUID(),
      intentId: intent.intentId,
      intentDigest: intent.intentDigest,
      reservationId: intent.reservationId,
      reservationDigest: privateState.reservationDigest,
      adoptionDigest: adoption.adoptionDigest
    });
    return adoption;
  });
}

export function isNativeV3PlanIncidentRecoveryTaskCommandAdoptionV1(value) {
  return Boolean(value && typeof value === "object" && PLAN_RECOVERY_TASK_COMMAND_ADOPTIONS.has(value));
}

async function revalidateConsumedRecoveryCommand(adoption, privateState) {
  return withBoundedPlanRunnerLock(privateState.runnerRoot, privateState.context.runId, async () => {
    const observed = await readPlanBoundIncidentRecoveryTaskConsumption(privateState.context, privateState.consumptionOptions,
      "recovery command execution freshness");
    const intentRead = await observed.context.runtimeModule.readIncidentRecoveryDagRuntimeTaskEffectIntentV1({
      stateRoot: observed.context.stateRoot, runId: observed.context.runId, handoffId: observed.context.handoffId,
      intentId: privateState.intentId, controller: privateState.controller
    });
    assertPlanBoundRecoveryTaskEffectIntent(intentRead.intent, observed, "dispatch-reserved", "recovery command execution freshness");
    const handle = observed.boundary.runtimeReadback.handles.find((item) => item.handleId === adoption.handleId);
    if (observed.boundary.checkpoint.stateDigest !== privateState.checkpointStateDigest ||
        intentRead.intent.intentDigest !== privateState.intentDigest || !handle || digestObject(handle) !== adoption.handleDigest ||
        handle.status !== "ready" || handle.dispatchBlocked !== true) fail("EPLAN_RECOVERY_COMMAND_DRIFT", "Recovery command canonical boundary changed", "HOLD");
    let prepared;
    try {
      prepared = await prepareNativeV3RecoveryCommandAdoptionV1({ ...privateState.validationOptions, handle });
    } catch (error) {
      const wrapped = new NativeV3PlanRunnerError("EPLAN_RECOVERY_COMMAND_DRIFT",
        `Recovery command freshness failed: ${String(error?.message ?? error)}`, error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD");
      wrapped.cause = error;
      throw wrapped;
    }
    const stableValidation = (value) => {
      const { validatedAt, validationDigest, ...stable } = value;
      void validatedAt; void validationDigest;
      return stable;
    };
    if (!same(stableValidation(prepared.validation), stableValidation(privateState.prepared.validation)) ||
        !same(prepared.commandBinding, privateState.prepared.commandBinding) || !same(prepared.admission, privateState.prepared.admission)) {
      fail("EPLAN_RECOVERY_COMMAND_DRIFT", "Recovery command approval, admission or controller changed", "HOLD");
    }
    return { prepared, handle, task: observed.context.workflowPlan.taskContract.graph.tasks.find((item) => item.id === adoption.taskId) };
  });
}

// Internal core entry point: inspection data is not authority. Only the
// original process-local adoption object reaches this executor, exactly once.
export function consumeNativeV3PlanIncidentRecoveryTaskCommandAdoptionV1(adoption, options = {}) {
  const privateState = PLAN_RECOVERY_TASK_COMMAND_ADOPTIONS.get(adoption);
  if (!privateState) fail("EPLAN_RECOVERY_COMMAND_ADOPTION", "Recovery adoption is absent, copied or already consumed", "HOLD");
  PLAN_RECOVERY_TASK_COMMAND_ADOPTIONS.delete(adoption);
  const supplied = exactOptions(options, new Set(["abortSignal"]), "recovery command execution options");
  if (supplied.abortSignal !== undefined && !(supplied.abortSignal instanceof AbortSignal)) throw new Error("Invalid recovery command abortSignal");
  return executeConsumedRecoveryCommand(adoption, privateState, supplied.abortSignal);
}

async function executeConsumedRecoveryCommand(adoption, privateState, abortSignal) {
  if (abortSignal?.aborted) fail("EPLAN_RECOVERY_COMMAND_ABORTED", "Recovery command was aborted before launch", "HOLD");
  const fresh = await revalidateConsumedRecoveryCommand(adoption, privateState);
  const { handle, prepared, task } = fresh;
  const seconds = task.budget.seconds;
  const adapter = createOwnedProcessAdapterV1({ root: privateState.context.stateRoot, trustedController: privateState.controller,
    beforeLaunchTimeoutMs: seconds === null ? OWNED_PROCESS_BEFORE_LAUNCH_MAX_MS : Math.min(OWNED_PROCESS_BEFORE_LAUNCH_MAX_MS, seconds * 1000),
    beforeLaunch: async () => {
      if (abortSignal?.aborted) throw new Error("Recovery command aborted before owned launch");
      await revalidateConsumedRecoveryCommand(adoption, privateState);
    }
  });
  const registryOptions = { stateRoot: privateState.context.stateRoot, runId: adoption.runId, controller: privateState.controller,
    resourceAdapter: adapter.resourceAdapter, ...(privateState.validationOptions.clock === undefined ? {} : { clock: privateState.validationOptions.clock }) };
  const registry = await openExecutionRegistry(registryOptions);
  bindOwnedRecoveryLaunchVerifierV1(adapter.resourceAdapter, async (sendLaunchFrame) => {
    await withBoundedPlanRunnerLock(privateState.runnerRoot, privateState.context.runId, async () => {
      if (abortSignal?.aborted) fail("EPLAN_RECOVERY_COMMAND_ABORTED", "Recovery command aborted at final launch boundary", "HOLD");
      const canonical = await revalidateNativeV3RecoveryCommandCanonicalV1(privateState.validationOptions);
      const checkpointPath = safeJoin(privateState.runnerRoot, "runs", adoption.runId, CHECKPOINT_FILE);
      const checkpoint = validateCheckpoint(await readCheckpointJson(privateState.runnerRoot, checkpointPath),
        canonical.workflowPlan, null, { allowLegacy: false });
      const boundary = await registry.readRecoveryTaskEffectDispatchBoundary(adoption.intentId);
      if (checkpoint.stateDigest !== privateState.checkpointStateDigest ||
          !same(canonical.commandBinding, privateState.prepared.commandBinding) ||
          boundary.intent.intentDigest !== adoption.intentDigest || digestObject(boundary.handle) !== adoption.handleDigest ||
          boundary.launch?.adoptionDigest !== adoption.adoptionDigest) {
        fail("EPLAN_RECOVERY_COMMAND_DRIFT", "Recovery canonical state changed at final launch boundary", "HOLD");
      }
      // Linearize the exact frame with cooperative checkpoint writers. The
      // runtime registry lease is not held; ready/completion waits are outside
      // this bounded plan lease.
      sendLaunchFrame();
    });
  });
  const budget = await openExecutionBudgetLedgerV1(registryOptions);
  const budgetReceipt = await budget.reserveRecoveryTaskEffect({ handleId: handle.handleId, intentId: adoption.intentId,
    intentDigest: adoption.intentDigest, idempotencyKey: `recovery-command:${adoption.intentId}`,
    amounts: { attempts: 1, seconds, tokens: task.budget.tokens, cost: null } });
  await revalidateConsumedRecoveryCommand(adoption, privateState);
  if (abortSignal?.aborted) fail("EPLAN_RECOVERY_COMMAND_ABORTED", "Recovery command was aborted before launch", "HOLD");
  const head = await registry.load();
  const launchFields = ["intentId", "intentDigest", "reservationId", "reservationDigest", "adoptionDigest",
    "approvalEnvelopeDigest", "commandDigest", "effectBindingDigest", "unitId", "executionId", "ownedResourceId", "controllerId"];
  // A unique private nonce prevents an old durable launch from being read as
  // permission to dispatch again after a fresh process-local adoption.
  const { launch } = await registry.recordRecoveryTaskEffectLaunch({
    ...Object.fromEntries(launchFields.map((key) => [key, adoption[key]])), validationDigest: prepared.validation.validationDigest,
    launchEvidenceDigest: digestObject({ adoptionDigest: adoption.adoptionDigest, dispatchNonce: privateState.dispatchNonce,
      validationDigest: prepared.validation.validationDigest, budgetStateDigest: budgetReceipt.stateDigest }),
    expectedRegistrySequence: head.sequence, expectedRegistryStateDigest: head.stateDigest
  });
  // The durable writer has returned and released its registry lease. No
  // effect is scheduled before this point. The final frame alone is sent
  // under the plan lock to linearize with checkpoint writers.
  const stopInput = { request: { runId: adoption.runId, handleId: handle.handleId, ownedResourceId: handle.ownedResourceId },
    scope: { runId: adoption.runId, handleId: handle.handleId } };
  let timer;
  let onAbort;
  let started;
  let completion;
  let launchEvidence;
  let failureReason = null;
  let stopReceipt = null;
  const begin = process.hrtime.bigint();
  const cancellation = new Promise((_, reject) => {
    onAbort = () => reject(new Error("Recovery command cancelled"));
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    if (seconds !== null) timer = setTimeout(() => reject(new Error("Recovery command exceeded approved time budget")), seconds * 1000);
  });
  try {
    const binding = Object.fromEntries(TRUSTED_BINDING_KEYS.map((key) => [key, handle[key]]));
    const start = adapter.startOwned({ schemaVersion: 1, handleId: handle.handleId, intentId: adoption.intentId,
      binding, admission: prepared.admission, authorityEpoch: handle.authorityEpoch, fence: handle.fence }, {
      command: prepared.commandBinding.executable, args: prepared.commandBinding.args, cwd: prepared.commandBinding.cwd,
      env: prepared.commandBinding.env, effectBindingDigest: adoption.effectBindingDigest, maxOutputBytes: prepared.commandBinding.maxOutputBytes
    });
    start.then((value) => value.completion.catch(() => {}), () => {});
    started = await Promise.race([start, cancellation]);
    launchEvidence = readOwnedProcessLaunchEvidenceV1(adapter.resourceAdapter, started);
    completion = await Promise.race([started.completion, cancellation]);
    if (completion.outcome !== "stopped" || completion.groupTerminated !== true) throw new Error("Recovery command completion is unresolved");
  } catch (error) {
    failureReason = String(error?.message ?? error);
    try { stopReceipt = await adapter.stopOwned(stopInput); } catch (cleanupError) { failureReason += `; cleanup: ${String(cleanupError?.message ?? cleanupError)}`; }
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
  }
  const elapsedMs = Number((process.hrtime.bigint() - begin + 999_999n) / 1_000_000n);
  const known = failureReason === null && launchEvidence !== undefined && completion !== undefined;
  const outcome = !known ? "unknown" : completion.code === 0 && completion.outputExceeded !== true ? "success" : "failure";
  const result = known ? { code: completion.code, signal: completion.signal, groupTerminated: true, outputExceeded: completion.outputExceeded } : null;
  const usage = known ? { attempts: 1, elapsedMs, tokens: null, cost: null, measurementWindow: "recovery-owned-command" } : null;
  const outcomeRequest = deepFreeze({ launchId: launch.launchId, launchDigest: launch.launchDigest, outcome,
    effectResultDigest: result === null ? null : digestObject(result), usageDigest: usage === null ? null : digestObject(usage),
    controllerTransactionId: launchEvidence?.transaction.transactionId ?? null, controllerTransactionDigest: launchEvidence?.transaction.digest ?? null,
    callbackCalls: started ? 1 : null, effectStarted: started ? true : null,
    terminalReason: known ? null : "effect-result-ambiguous",
    outcomeEvidenceDigest: digestObject({ launchEvidence: launchEvidence ?? null, result, usage, failureReason, stopReceipt }) });
  const receipt = deepFreeze({ status: "outcome-persistence-pending", runId: adoption.runId,
    launchId: launch.launchId, launchDigest: launch.launchDigest, outcomeEvidenceDigest: outcomeRequest.outcomeEvidenceDigest });
  PLAN_RECOVERY_PENDING_OUTCOMES.set(receipt, { registry, adapter, outcomeRequest, budgetReceipt, result, usage,
    execution: null, pending: null });
  return persistNativeV3PlanIncidentRecoveryTaskCommandOutcomeV1(receipt);
}

async function persistRecoveryCommandOutcome(owned) {
  const { registry, adapter, outcomeRequest, budgetReceipt, result, usage } = owned;
  let recorded;
  // Only the registry head may change between attempts. Never repeat the
  // owned effect or recompute its immutable observation when a sibling writes.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const finalHead = await registry.load();
    try {
      recorded = await registry.recordRecoveryTaskEffectOutcome({ ...outcomeRequest,
        expectedRegistrySequence: finalHead.sequence, expectedRegistryStateDigest: finalHead.stateDigest });
      break;
    } catch (error) {
      if (error?.code !== "EEXECUTION_RECOVERY_EFFECT_LEDGER_CAS" || attempt === 2) throw error;
    }
  }
  const execution = deepFreeze({ ...recorded, budgetReceipt, result, usage });
  PLAN_RECOVERY_TASK_COMMAND_EXECUTIONS.set(execution, { registry, adapter });
  return execution;
}

// Internal observation persistence only: possession never restarts the effect.
// Clones/serialized receipts cannot recover the private immutable observation.
export function persistNativeV3PlanIncidentRecoveryTaskCommandOutcomeV1(receipt) {
  const owned = PLAN_RECOVERY_PENDING_OUTCOMES.get(receipt);
  if (!owned) fail("EPLAN_RECOVERY_COMMAND_OUTCOME_RECEIPT", "Pending outcome receipt is absent or copied", "HOLD");
  if (owned.execution) return Promise.resolve(owned.execution);
  if (owned.pending) return owned.pending;
  owned.pending = persistRecoveryCommandOutcome(owned).then((execution) => {
    owned.execution = execution;
    return execution;
  }).catch((cause) => {
    const error = new NativeV3PlanRunnerError("EPLAN_RECOVERY_COMMAND_OUTCOME_PENDING",
      "Owned effect finished but its immutable outcome is not confirmed durable", "UNKNOWN");
    error.cause = cause;
    Object.defineProperty(error, "executionReceipt", { value: receipt, enumerable: true });
    throw error;
  }).finally(() => { owned.pending = null; });
  return owned.pending;
}

export function reconcileNativeV3PlanIncidentRecoveryTaskCommandExecutionV1(execution, options = {}) {
  const owned = PLAN_RECOVERY_TASK_COMMAND_EXECUTIONS.get(execution);
  if (!owned) fail("EPLAN_RECOVERY_COMMAND_EXECUTION", "Recovery execution is absent or copied", "HOLD");
  return owned.registry.reconcileRecoveryTaskEffectOutcome(execution.outcome.outcomeId, options);
}

async function terminalizeNativeV3PlanIncidentRecoveryTaskEffectV1(reservation, options, status) {
  const label = status === "not-sent"
    ? "incident recovery task effect not-sent options"
    : "incident recovery task effect unknown options";
  const supplied = exactOptions(options, INCIDENT_RECOVERY_TASK_EFFECT_TERMINAL_KEYS, label);
  const privateState = PLAN_RECOVERY_TASK_EFFECT_RESERVATIONS.get(reservation) ?? null;
  if (!privateState) {
    fail(
      "EPLAN_INCIDENT_RECOVERY_EFFECT_RESERVATION",
      "incident recovery task effect reservation is absent, copied, proxied, serialized, or already consumed",
      "HOLD"
    );
  }
  const reason = id(supplied.reason, "reason");
  // Burn before the first await.  A failed or ambiguous durable transition is
  // reconciled through the journal by intentId; reusing the process-local
  // reservation could otherwise turn uncertainty into duplicate authority.
  PLAN_RECOVERY_TASK_EFFECT_RESERVATIONS.delete(reservation);
  return withBoundedPlanRunnerLock(privateState.runnerRoot, privateState.context.runId, async () => {
    let runtimeResult;
    try {
      const method = status === "not-sent"
        ? "recordIncidentRecoveryDagRuntimeTaskEffectNotSentV1"
        : "recordIncidentRecoveryDagRuntimeTaskEffectUnknownV1";
      runtimeResult = await privateState.context.runtimeModule[method]({
        stateRoot: privateState.context.stateRoot,
        runId: privateState.context.runId,
        handoffId: privateState.context.handoffId,
        intentId: privateState.intentId,
        reason,
        controller: privateState.controller
      });
    } catch (error) {
      const wrapped = new NativeV3PlanRunnerError(
        status === "not-sent"
          ? "EPLAN_INCIDENT_RECOVERY_EFFECT_NOT_SENT"
          : "EPLAN_INCIDENT_RECOVERY_EFFECT_UNKNOWN",
        `durable recovery effect ${status} transition failed: ${String(error?.message ?? error)}`,
        error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      );
      wrapped.cause = error;
      throw wrapped;
    }
    const intent = runtimeResult.intent;
    if (!intent || intent.status !== status || intent.intentId !== privateState.intentId ||
        intent.reservationId !== privateState.reservationId || intent.priorIntentDigest !== privateState.intentDigest ||
        intent.terminalReason !== reason || intent.callbackCalls !== 0 || intent.effectStarted !== false ||
        !same(runtimeResult.effectAuthority, {
          mayUnblockHandle: false,
          mayDispatch: false,
          mayPerformEffects: false
        })) {
      fail("EPLAN_INCIDENT_RECOVERY_EFFECT_UNKNOWN", `durable recovery effect ${status} readback is not exact`, "UNKNOWN");
    }
    const body = {
      schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
      kind: NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_EFFECT_TERMINAL_KIND,
      status,
      reservationDigest: privateState.reservationDigest,
      runId: intent.runId,
      planId: intent.planId,
      planDigest: intent.planDigest,
      contractDigest: intent.contractDigest,
      recoveryPlanDigest: intent.recoveryPlanDigest,
      handoffId: intent.handoffId,
      consumptionId: intent.consumptionId,
      taskId: intent.taskId,
      handleId: intent.handleId,
      handleDigest: intent.handleDigest,
      attemptId: intent.attemptId,
      intentId: intent.intentId,
      intentDigest: intent.intentDigest,
      reservationId: intent.reservationId,
      terminalReason: intent.terminalReason,
      callbackCalls: 0,
      effectStarted: false,
      effectAuthority: clone(INCIDENT_RECOVERY_TASK_EFFECT_AUTHORITY),
      terminalAt: intent.terminalAt
    };
    return deepFreeze({ ...body, receiptDigest: digestObject(body) });
  });
}

export async function terminalizeNativeV3PlanIncidentRecoveryTaskReservationV1(options = {}) {
  const supplied = exactOptions(
    options,
    INCIDENT_RECOVERY_TASK_EFFECT_TERMINAL_KEYS,
    "incident recovery task effect terminal options"
  );
  const outcome = text(supplied.outcome, "outcome", null, 32);
  if (!["not-sent", "unknown"].includes(outcome)) {
    fail("EPLAN_RUNNER_INPUT", "outcome must be not-sent or unknown", "HOLD");
  }
  return terminalizeNativeV3PlanIncidentRecoveryTaskEffectV1(
    supplied.reservation,
    { reason: supplied.reason },
    outcome
  );
}

function trustedRunnerRegistryKey(stateRoot, runId) {
  return `${stateRoot}\u0000${runId}`;
}

/**
 * Check whether a progressed checkpoint was emitted by the live native
 * runner in this process.  A self-digested JSON object is not enough to prove
 * append-only progress, so callers must fail closed when this process-local
 * provenance is unavailable (for example after a process restart).
 */
export function isNativeV3PlanRunnerCheckpointInResumeLineage({ stateRoot, root, runId, checkpoint } = {}) {
  if (!isPlainObject(checkpoint)) return false;
  let resolvedRoot;
  let resolvedRunId;
  try {
    resolvedRoot = absolute(stateRoot ?? root ?? getStateRoot(), "stateRoot");
    resolvedRunId = id(runId, "runId");
  } catch {
    return false;
  }
  if (typeof checkpoint.stateDigest !== "string" || !DIGEST.test(checkpoint.stateDigest)) return false;
  const registryEntry = TRUSTED_PLAN_RUNNER_REGISTRY.get(trustedRunnerRegistryKey(resolvedRoot, resolvedRunId));
  const runner = registryEntry?.deref?.();
  if (!runner || !TRUSTED_PLAN_RUNNERS.has(runner)) {
    if (registryEntry && !runner) TRUSTED_PLAN_RUNNER_REGISTRY.delete(trustedRunnerRegistryKey(resolvedRoot, resolvedRunId));
    return false;
  }
  const lineage = PLAN_RESUME_LINEAGES.get(runner);
  if (!lineage || lineage.latestDigest !== checkpoint.stateDigest ||
      lineage.latestSequence !== checkpoint.sequence || !lineage.checkpoints?.has(checkpoint.stateDigest)) {
    return false;
  }
  return true;
}

export function isNativeV3PlanRunner(value) {
  return TRUSTED_PLAN_RUNNERS.has(value);
}

/**
 * Read the most recent in-process receipt minted by the native runner's own
 * resume transition.  The private WeakSet/WeakMap check is intentional: a
 * copied checkpoint, a Proxy, a derived object, or a caller callback cannot
 * manufacture a receipt accepted by this verifier.
 */
export function readNativeV3PlanRunnerResumeReceipt(runner, expected = {}) {
  if (!TRUSTED_PLAN_RUNNERS.has(runner) || !isPlainObject(expected)) return null;
  const receipt = PLAN_RESUME_RECEIPTS.get(runner);
  if (!receipt) return null;
  const checks = [
    ["requestDigest", receipt.requestDigest],
    ["runId", receipt.runId],
    ["planId", receipt.planId],
    ["planDigest", receipt.planDigest],
    ["contractDigest", receipt.contractDigest],
    ["beforeCheckpointDigest", receipt.beforeCheckpointDigest],
    ["afterCheckpointDigest", receipt.afterCheckpointDigest],
    ["afterSequence", receipt.afterSequence]
  ];
  for (const [key, actual] of checks) {
    if (expected[key] !== undefined && expected[key] !== actual) return null;
  }
  const lineage = PLAN_RESUME_LINEAGES.get(runner);
  return clone({
    ...receipt,
    lineageDigests: lineage ? [...lineage.digests] : receipt.lineageDigests
  });
}

export async function createNativeV3PlanRunner(options = {}) {
  exactOptions(options, OPTION_KEYS, "createNativeV3PlanRunner options");
  const resolvedRootInput = options.stateRoot ?? options.root ?? getStateRoot();
  const stateRoot = absolute(resolvedRootInput, "stateRoot");
  if (options.stateRoot !== undefined && options.root !== undefined && absolute(options.root, "root") !== stateRoot) {
    fail("EPLAN_RUNNER_INPUT", "stateRoot and root must refer to the same directory");
  }
  const suppliedPlan = options.plan === undefined ? null : validateWorkflowPlanV1(options.plan);
  const resolvedPlanId = id(options.planId ?? suppliedPlan?.planId, "planId");
  if (suppliedPlan && suppliedPlan.planId !== resolvedPlanId) fail("EPLAN_RUNNER_INPUT", "planId does not match the immutable WorkflowPlanV1");
  const runId = id(options.runId, "runId");
  const parallelism = boundedInteger(options.parallelism ?? DEFAULT_PARALLELISM, "parallelism", { min: 1, max: MAX_PARALLELISM });
  if (!isPlainObject(options.taskAdapter) || !isNativeV3PlanTaskAdapter(options.taskAdapter)) {
    fail("EPLAN_RUNNER_INPUT", "taskAdapter must be created by the trusted native V3 producer");
  }
  if (options.readFreshPlan !== undefined && typeof options.readFreshPlan !== "function") fail("EPLAN_RUNNER_INPUT", "readFreshPlan must be callable");
  const clock = options.clock;
  const abortSignal = validateAbortSignal(options.abortSignal, "abortSignal");
  const stopWaitMs = boundedInteger(options.stopWaitMs ?? STOP_WAIT_MS, "stopWaitMs", { min: 25, max: STOP_WAIT_MS });
  const initialPlan = suppliedPlan ?? (await readFreshWorkflowPlanV1({ root: stateRoot, planId: resolvedPlanId }));
  const pinnedPlan = deepFreeze(clone(initialPlan));
  const hasVerificationTasks = pinnedPlan.taskContract.graph.tasks.some((task) => task.verification !== undefined);
  let verificationConsumer = null;
  if (hasVerificationTasks) {
    try {
      const capturedSource = await captureSourceBinding(path.resolve(process.cwd()), { requireClean: true });
      if (!capturedSource || typeof capturedSource.repositoryRoot !== "string" || !path.isAbsolute(capturedSource.repositoryRoot)) {
        fail("EPLAN_VERIFICATION_SETUP", "current process working directory is not a canonical Git repository", "HOLD");
      }
      // The repository root is deliberately derived from this process's
      // canonical working tree, never from a caller-provided task context or
      // serialized state.  The consumer immediately binds it to the plan's
      // Git source revision/digest and installed native policy.  CLI callers
      // enter here from the same clean repository used during preparation.
      verificationConsumer = await createNativeV3VerificationConsumer({
        plan: pinnedPlan,
        repositoryRoot: path.resolve(capturedSource.repositoryRoot),
        stateRoot
      });
    } catch (error) {
      const wrapped = new NativeV3PlanRunnerError(
        "EPLAN_VERIFICATION_SETUP",
        "verification consumer could not bind to the current repository and policy: " + String(error?.message ?? error),
        error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      );
      wrapped.cause = error;
      throw wrapped;
    }
  }
  const runnerRoot = safeJoin(stateRoot, PLAN_RUNNER_DIRECTORY);
  const runDir = safeJoin(runnerRoot, "runs", runId);
  const checkpointPath = safeJoin(runDir, CHECKPOINT_FILE);
  const ownerId = randomUUID();
  const initialTaskAdapter = options.taskAdapter;
  let activeTaskAdapter = initialTaskAdapter;
  let runPromise = null;
  let runSettled = true;
  let cancelPromise = null;
  let pausePromise = null;
  let pauseSettled = false;
  let localCancelRequested = false;
  let localPauseRequested = false;
  let cancelReason = null;
  let pauseOwnerId = null;
  let activeResumeLineage = null;
  const active = new Map();
  // Keep an entry until its settlement/stop journal transition completes.
  // active.delete() alone must not erase an owned handle on a storage error.
  const pendingCleanupEntries = new Set();
  const physicalStopObservations = new Map();
  let failureCleanupObservation = null;
  let failureCleanupPromise = null;
  let publicRunner = null;

  await ensurePrivateDir(stateRoot);
  await ensurePrivateDir(runnerRoot);
  await ensurePrivateDir(safeJoin(runnerRoot, "runs"));
  await ensurePrivateDir(runDir);

  async function withPlanLock(callback) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    let lastError;
    while (Date.now() <= deadline) {
      try {
        return await withRunLock(runnerRoot, runId, callback, { ttlMs: LOCK_WAIT_MS * 2 });
      } catch (error) {
        lastError = error;
        if (!isLeaseConflict(error)) throw error;
        // This bounded retry is active work, not an idle background poll.
        await delay(LOCK_RETRY_MS, { keepAlive: true });
      }
    }
    throw lastError ?? new NativeV3PlanRunnerError("EPLAN_RUNNER_LEASE", "plan runner state lease could not be acquired", "HOLD");
  }

  async function readCheckpointUnfenced() {
    const raw = await readCheckpointJson(runnerRoot, checkpointPath);
    return validateCheckpoint(raw, pinnedPlan, { planId: pinnedPlan.planId, planDigest: pinnedPlan.planDigest, contractDigest: pinnedPlan.contractDigest, parallelism }, { allowLegacy: true });
  }

  async function readCheckpoint() {
    return await readCheckpointWithFence(readCheckpointUnfenced, withPlanLock);
  }

  async function readCheckpointOrNull() {
    try {
      return await readCheckpointUnfenced();
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function transition(type, update, details = {}) {
    return withPlanLock(async () => {
      const current = await readCheckpointUnfenced();
      const draft = clone(current);
      delete draft.stateDigest;
      const changed = await update(draft, current);
      if (changed === false) return current;
      const event = eventFor(current, type, {
        taskId: details.taskId ?? null,
        attemptId: details.attemptId ?? null,
        detail: details.detail ?? null,
        clock
      });
      const next = sealCheckpoint({
        ...draft,
        sequence: current.sequence + 1,
        events: [...current.events, event],
        updatedAt: event.at
      });
      validateCheckpoint(next, pinnedPlan, { planId: pinnedPlan.planId, planDigest: pinnedPlan.planDigest, contractDigest: pinnedPlan.contractDigest, parallelism }, {
        allowLegacy: current.usageSchemaVersion === undefined
      });
      await atomicWriteJson(runnerRoot, checkpointPath, next);
      if (activeResumeLineage !== null) {
        activeResumeLineage.digests.add(next.stateDigest);
        activeResumeLineage.checkpoints.set(next.stateDigest, deepFreeze(clone(next)));
        activeResumeLineage.latestDigest = next.stateDigest;
        activeResumeLineage.latestSequence = next.sequence;
      }
      return next;
    });
  }

  await withPlanLock(async () => {
    const existing = await readCheckpointOrNull();
    if (existing) return existing;
    const initial = initialCheckpoint({ plan: pinnedPlan, runId, parallelism, clock });
    validateCheckpoint(initial, pinnedPlan, { planId: pinnedPlan.planId, planDigest: pinnedPlan.planDigest, contractDigest: pinnedPlan.contractDigest, parallelism });
    await atomicWriteJson(runnerRoot, checkpointPath, initial);
    return initial;
  });

  async function freshPlan() {
    const candidate = options.readFreshPlan
      ? await options.readFreshPlan({
        runId,
        planId: pinnedPlan.planId,
        expected: { planDigest: pinnedPlan.planDigest, contractDigest: pinnedPlan.contractDigest }
      })
      : suppliedPlan
        ? pinnedPlan
        : await readFreshWorkflowPlanV1({ root: stateRoot, planId: pinnedPlan.planId, expected: { planDigest: pinnedPlan.planDigest, contractDigest: pinnedPlan.contractDigest } });
    const current = validateWorkflowPlanV1(candidate);
    if (current.planId !== pinnedPlan.planId || current.planDigest !== pinnedPlan.planDigest || current.contractDigest !== pinnedPlan.contractDigest) {
      fail("EPLAN_SOURCE_DRIFT", "WorkflowPlanV1 changed during DAG execution", "HOLD");
    }
    return current;
  }

  async function freshResumePlan() {
    // A durable resume must re-read the immutable plan source even when the
    // constructor received a convenience copy.  Reusing that in-memory copy
    // would make a source revision change invisible at the recovery fence.
    const candidate = options.readFreshPlan
      ? await options.readFreshPlan({
        runId,
        planId: pinnedPlan.planId,
        expected: { planDigest: pinnedPlan.planDigest, contractDigest: pinnedPlan.contractDigest }
      })
      : await readFreshWorkflowPlanV1({
        root: stateRoot,
        planId: pinnedPlan.planId,
        expected: { planDigest: pinnedPlan.planDigest, contractDigest: pinnedPlan.contractDigest }
      });
    const current = validateWorkflowPlanV1(candidate);
    if (current.planId !== pinnedPlan.planId || current.planDigest !== pinnedPlan.planDigest || current.contractDigest !== pinnedPlan.contractDigest) {
      fail("EPLAN_SOURCE_DRIFT", "WorkflowPlanV1 changed before resume", "HOLD");
    }
    return current;
  }

  async function claimRun() {
    return transition("run.claimed", (state) => {
      if (state.usageSchemaVersion === undefined) {
        // Legacy checkpoints remain readable and stoppable, but a new effect
        // owner may not run or resume one because its historical zero usage
        // fields have no measurement semantics.
        if (!TERMINAL_RUN_STATUSES.has(state.status)) {
          fail("EPLAN_USAGE_SCHEMA_LEGACY", "legacy checkpoint requires a fresh V3 usage checkpoint before execution", "HOLD");
        }
        return false;
      }
      if (TERMINAL_RUN_STATUSES.has(state.status)) return false;
      if (state.status === "paused") return false;
      if (state.status === "running" && state.ownerId !== ownerId) fail("EPLAN_RUN_IN_PROGRESS", "another plan runner owner is active", "HOLD");
      if (state.status === "cancelling" && state.ownerId !== null && state.ownerId !== ownerId) fail("EPLAN_RUN_IN_PROGRESS", "another plan runner owner is cancelling", "HOLD");
      if (state.ownerId !== null && state.ownerId !== ownerId) fail("EPLAN_RUN_IN_PROGRESS", "checkpoint owner lease is not this runner", "HOLD");
      state.ownerId = ownerId;
      state.ownerPid = process.pid;
      state.reconcileRequired = false;
      if (state.status === "ready") state.status = "running";
      return true;
    }, { detail: { ownerId } });
  }

  async function markCancelRequested(reason) {
    localCancelRequested = true;
    cancelReason = reason;
    for (const entry of active.values()) entry.abortController.abort();
    return transition("run.cancel-requested", (state) => {
      if (TERMINAL_RUN_STATUSES.has(state.status)) return false;
      state.status = "cancelling";
      state.dispatchBlocked = true;
      state.cancelRequested = true;
      state.cancelReason = reason;
      if (state.ownerId === null) state.ownerId = ownerId;
      if (state.ownerId !== ownerId) {
        // A foreign controller may persist a stop request, but it cannot
        // observe that controller's active handles or declare the run
        // cancelled.  Keep this recoverable HOLD/UNKNOWN marker until the
        // owner completes cleanup or an explicit reconcile observes owner
        // process loss.
        state.reconcileRequired = true;
        state.failure = {
          code: "EPLAN_OWNER_RECONCILE_REQUIRED",
          message: "Cancellation was persisted, but the active owner must prove cleanup before terminal cancellation",
          status: "UNKNOWN"
        };
      }
      return true;
    }, { detail: { reason } });
  }

  async function markPauseRequested(reason) {
    localPauseRequested = true;
    for (const entry of active.values()) entry.abortController.abort();
    return transition("run.pause-requested", (state) => {
      if (TERMINAL_RUN_STATUSES.has(state.status)) return false;
      if (state.ownerId !== null && state.ownerId !== ownerId) {
        fail("EPLAN_RUN_IN_PROGRESS", "another plan runner owner is active", "HOLD");
      }
      if (state.status === "paused") return false;
      state.status = "paused";
      state.dispatchBlocked = true;
      state.cancelRequested = false;
      state.cancelReason = reason;
      state.ownerId = ownerId;
      state.ownerPid = process.pid;
      state.reconcileRequired = false;
      return true;
    }, { detail: { reason } });
  }

  async function reserveTask(task) {
    let reserved = null;
    await transition("task.reserved", (state) => {
      if (localCancelRequested || abortSignal?.aborted || state.cancelRequested || state.dispatchBlocked || TERMINAL_RUN_STATUSES.has(state.status)) return false;
      const current = state.tasks[task.id];
      if (current.status !== "pending" || !task.dependencies.every((dependency) => state.tasks[dependency].status === "succeeded")) return false;
      if (state.budget.attemptsUsed >= state.budget.attempts) {
        state.status = "hold";
        state.dispatchBlocked = true;
        state.failure = { code: "EPLAN_BUDGET_EXCEEDED", message: "WorkflowPlan attempt budget is exhausted before the next task dispatch", status: "HOLD" };
        return true;
      }
      const freshAttemptOffset = current.attempts === 0 && state.events.some((event) =>
        event.type === "run.paused" && Array.isArray(event.detail?.freshAttemptTaskIds) && event.detail.freshAttemptTaskIds.includes(task.id)
      ) ? 1 : 0;
      const attemptNumber = current.attempts + 1 + freshAttemptOffset;
      const attemptId = `${task.id}.attempt.${attemptNumber}`;
      current.status = "preparing";
      current.attempts = attemptNumber;
      current.dispatches += 1;
      current.attemptId = attemptId;
      current.unitId = null;
      current.executionId = null;
      current.admissionDigest = null;
      current.startedAt = null;
      current.finishedAt = null;
      current.outcome = null;
      current.lastError = null;
      current.stopReceipt = null;
      if (task.verification !== undefined) current.verification = null;
      state.budget.attemptsUsed += 1;
      reserved = { task: clone(task), attemptId, attemptNumber };
      return true;
    }, { taskId: task.id, detail: { phase: "preparing" } });
    return reserved;
  }

  async function recordVerification(entry, verification) {
    return transition("task.verification-observed", (state) => {
      const current = state.tasks[entry.task.id];
      // Receipt production is advisory. Admission must linearize under the
      // same lock as stop/pause and must never cross an attempt's fence.
      // Cleanup may leave the task preparing until its callback settles.
      if (state.status !== "running" || state.dispatchBlocked || state.cancelRequested ||
          localCancelRequested || localPauseRequested || entry.abortController.signal.aborted || abortSignal?.aborted ||
          TERMINAL_TASK_STATUSES.has(current.status) || current.attemptId !== entry.attemptId ||
          current.status !== "preparing") return false;
      current.verification = clone(verification);
      return true;
    }, {
      taskId: entry.task.id,
      attemptId: entry.attemptId,
      detail: {
        phase: "verification",
        status: verification.status,
        receiptDigest: verification.receiptDigest,
        revisionReadyDigest: verification.revisionReadyDigest,
        finalFreezeDigest: verification.finalFreezeDigest
      }
    });
  }

  async function markPrepared(entry, prepared) {
    return transition("task.prepared", (state) => {
      const current = state.tasks[entry.task.id];
      if (state.cancelRequested || state.dispatchBlocked || current.status !== "preparing" || current.attemptId !== entry.attemptId) return false;
      if (state.events.some((event) => event.detail?.admissionDigest === prepared.admissionDigest)) {
        state.status = "hold";
        state.dispatchBlocked = true;
        state.failure = { code: "EPLAN_DUPLICATE_ADMISSION", message: "A task admission digest was already reserved in this plan run", status: "HOLD" };
        return true;
      }
      current.unitId = prepared.unitId;
      current.executionId = prepared.admission.executionId;
      current.admissionDigest = prepared.admissionDigest;
      return true;
    }, { taskId: entry.task.id, attemptId: entry.attemptId, detail: { admissionDigest: prepared.admissionDigest, phase: "prepared" } });
  }

  async function markDispatching(entry) {
    return transition("task.dispatching", (state) => {
      const current = state.tasks[entry.task.id];
      if (state.cancelRequested || state.dispatchBlocked || state.status !== "running" || current.status !== "preparing" || current.attemptId !== entry.attemptId) {
        return false;
      }
      current.status = "dispatching";
      current.startedAt = nowIso(clock);
      return true;
    }, { taskId: entry.task.id, attemptId: entry.attemptId, detail: { phase: "dispatching" } });
  }

  async function markTaskStop(entry, stopResult) {
    return transition("task.stop-observed", (state) => {
      const current = state.tasks[entry.task.id];
      if (current.attemptId !== entry.attemptId || TERMINAL_TASK_STATUSES.has(current.status)) return false;
      markUnobservedUsage(state, current, entry, stopResult);
      current.finishedAt = nowIso(clock);
      current.stopReceipt = stopResult.receipt ?? null;
      if (stopResult.kind === "stopped" || stopResult.kind === "not-started") {
        current.status = "cancelled";
        current.outcome = "cancelled";
        current.lastError = null;
      } else {
        current.status = "unknown";
        current.outcome = "unknown";
        current.lastError = stopResult.error;
      }
      return true;
    }, { taskId: entry.task.id, attemptId: entry.attemptId,
      detail: { outcome: stopResult.kind, effectNotStarted: hasNotStartedProof(entry, stopResult) } });
  }

  async function markTaskPause(entry, stopResult) {
    const retryable = hasNotStartedProof(entry, stopResult) && ["stopped", "not-started"].includes(stopResult.kind);
    entry.pauseUnsafe = !retryable;
    return transition("task.pause-observed", (state) => {
      const current = state.tasks[entry.task.id];
      if (current.attemptId !== entry.attemptId || TERMINAL_TASK_STATUSES.has(current.status)) return false;
      current.stopReceipt = stopResult.receipt ?? null;
      if (retryable) {
        // A pause may requeue only work for which this runner has durable
        // evidence that the external effect was never entered.  Preserve the
        // attempt/dispatch counters for budget accounting, but clear the
        // attempt binding so resume must obtain a fresh trusted transfer.
        current.status = "pending";
        current.attemptId = null;
        current.unitId = null;
        current.executionId = null;
        current.admissionDigest = null;
        current.startedAt = null;
        current.finishedAt = null;
        current.outcome = null;
        current.lastError = null;
        if (entry.task.verification !== undefined) current.verification = null;
      } else {
        markUnobservedUsage(state, current, entry, stopResult);
        current.status = "unknown";
        current.outcome = "unknown";
        current.finishedAt = nowIso(clock);
        current.lastError = stopResult.error ?? {
          code: "EPLAN_PAUSE_RECONCILIATION_REQUIRED",
          message: "Paused task may have entered its external effect; reconciliation is required before retry",
          status: "UNKNOWN"
        };
      }
      return true;
    }, {
      taskId: entry.task.id,
      attemptId: entry.attemptId,
      detail: { outcome: stopResult.kind, retryable, effectNotStarted: hasNotStartedProof(entry, stopResult) }
    });
  }

  function refreshPreparationCleanup(entry, descriptor = undefined) {
    if (entry.preparationInvocation === null) return null;
    const outcome = readNativeV3PlanTaskPreparation(entry.preparationInvocation, {
      adapter: entry.preparationAdapter, context: entry.preparationContext, descriptor
    });
    if (outcome.ownership === "owned") {
      const scope = outcome.cleanup?.scope;
      if (!scope) fail("EPLAN_PREPARATION_OWNERSHIP", "Owned preparation has no private cleanup scope", "UNKNOWN");
      const expected = {
        runId, planId: pinnedPlan.planId, planDigest: pinnedPlan.planDigest,
        contractDigest: pinnedPlan.contractDigest, taskId: entry.task.id, attemptId: entry.attemptId,
        sourceBindingDigest: pinnedPlan.taskContract.bindings.source.digest,
        policyDigest: pinnedPlan.taskContract.bindings.policy.digest,
        revision: pinnedPlan.taskContract.bindings.source.revision
      };
      if (Object.entries(expected).some(([key, value]) => scope[key] !== value)) {
        fail("EPLAN_PREPARATION_OWNERSHIP", "Private cleanup scope is not bound to this task attempt", "UNKNOWN");
      }
      entry.preAdmissionCleanup = outcome.cleanup;
      entry.handleId = scope.handleId;
    }
    entry.preparationFailureCleanup ??= outcome.failureCleanup;
    return outcome;
  }

  function physicalStopEntry(entry, reason) {
    if (!entry.preAdmissionCleanup) {
      return Promise.resolve({ kind: "unknown", receipt: null, error: {
        code: "EPLAN_PREPARATION_OWNERSHIP", message: "No private allocation cleanup owner is available", status: "UNKNOWN"
      } });
    }
    if (entry.physicalStopPromise === null) {
      entry.physicalStopPromise = Promise.resolve().then(async () => {
        try {
          const result = await entry.preAdmissionCleanup.observeStop(reason);
          refreshPreparationCleanup(entry);
          if (entry.preparationFailureCleanup?.kind === "unknown") return entry.preparationFailureCleanup;
          if (result.kind !== "stopped") return result;
          if (entry.admission !== null) {
            assertStopReceiptForAdmission(result.receipt, entry.admission, result.reason, entry.handleId);
          }
          return result;
        } catch (error) {
          return { kind: "unknown", receipt: null, error: errorProjection(error, "EPLAN_RUNNER_STOP") };
        }
      });
      // Save the scheduler memo before native stop can reenter cleanup. The
      // command cap latches synchronously and owns its own retained memo.
      try {
        entry.preAdmissionCleanup.requestStop(reason);
        if (entry.effectStarted === false) {
          EFFECT_NOT_STARTED_AT_STOP.set(entry, Object.freeze({
            invocation: entry.preparationInvocation, attemptId: entry.attemptId,
            cleanup: entry.preAdmissionCleanup
          }));
        }
      } catch {
        // The canonical observer reports this failure as UNKNOWN; no proof
        // is minted if the private stop request could not latch.
      }
      entry.physicalStopPromise.then((result) => physicalStopObservations.set(entry, result), () => {});
      entry.physicalStopPromise.catch(() => {});
    }
    return entry.physicalStopPromise;
  }

  async function stopEntry(entry, reason) {
    entry.cleanupRequested = true;
    entry.cleanupReason ??= reason;
    entry.abortController.abort();
    let outcome;
    try { outcome = refreshPreparationCleanup(entry); }
    catch (error) { return { kind: "unknown", receipt: null, error: errorProjection(error, "EPLAN_PREPARATION_OWNERSHIP") }; }
    if (entry.preAdmissionCleanup) {
      // Keep a prior published ownership-timeout UNKNOWN, while still
      // requesting the late owner's single actual stop. No execute is retried.
      const actual = physicalStopEntry(entry, entry.cleanupReason);
      if (entry.preparationFailureCleanup?.kind === "unknown") return entry.preparationFailureCleanup;
      if (entry.detached && entry.stopRetryable && entry.stopPromise) return entry.stopPromise;
      return actual;
    }
    if (!entry.prepareStarted || entry.preparationInvocation === null ||
        (outcome?.ownership === "unowned" && outcome.settled)) {
      return { kind: "not-started", receipt: null, error: null };
    }
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopPromise = (async () => {
      const deadline = delay(stopWaitMs, { keepAlive: true });
      try {
        await Promise.race([entry.cleanupReady, deadline]);
        const settled = refreshPreparationCleanup(entry);
        if (entry.preAdmissionCleanup) return physicalStopEntry(entry, entry.cleanupReason);
        if (settled?.ownership === "unowned" && settled.settled) {
          return { kind: "not-started", receipt: null, error: null };
        }
        entry.detached = true;
        entry.stopRetryable = true;
        return { kind: "unknown", receipt: null, error: {
          code: "EPLAN_RUNNER_STOP_TIMEOUT", message: "Private task ownership did not settle before cancellation cleanup deadline", status: "UNKNOWN"
        } };
      } catch (error) {
        return { kind: "unknown", receipt: null, error: errorProjection(error, "EPLAN_PREPARATION_OWNERSHIP") };
      } finally { deadline.cancel(); }
    })();
    entry.stopPromise.catch(() => {});
    return entry.stopPromise;
  }

  async function stopAllActive(reason, { pause = false } = {}) {
    const entries = [...active.values()];
    const results = await Promise.all(entries.map(async (entry) => {
      let result = await stopEntry(entry, reason);
      const deadline = delay(stopWaitMs, { keepAlive: true });
      let settled = false;
      try {
        settled = await Promise.race([
          entry.promise.then(() => true),
          deadline.then(() => false)
        ]);
      } finally {
        deadline.cancel();
      }
      if (!settled) {
        entry.detached = true;
        // A stop receipt only covers the owned adapter's observation.  The
        // scheduler must also prove that this task callback settled before
        // returning a terminal checkpoint; otherwise a late callback could
        // still mutate the effect or leave a live obligation behind.
        if (result.kind === "stopped" || result.kind === "not-started") {
          result = {
            kind: "unknown",
            receipt: result.receipt ?? null,
            error: {
              code: "EPLAN_RUNNER_LATE_CALLBACK",
              message: "owned task callback did not settle after stop cleanup deadline",
              status: "UNKNOWN"
            }
          };
        }
      }
      if (settled || entry.detached) active.delete(entry.task.id);
      if (pause) await markTaskPause(entry, result);
      else await markTaskStop(entry, result);
      pendingCleanupEntries.delete(entry);
      return { entry, result };
    }));
    return results;
  }

  function readFailureCleanup() {
    return failureCleanupObservation === null ? null : clone(failureCleanupObservation);
  }

  function observeFailureCleanup() {
    if (failureCleanupPromise !== null) return failureCleanupPromise;
    localCancelRequested = true;
    const entries = [...new Set([...active.values(), ...pendingCleanupEntries, ...physicalStopObservations.keys()])];
    // Start every owned stop before awaiting any result. Storage is deliberately
    // outside this path: a failed checkpoint cannot fence off physical cleanup.
    const operations = entries.map(async (entry) => {
      let result;
      const stopDeadline = delay(stopWaitMs, { keepAlive: true });
      try {
        result = await Promise.race([
          stopEntry(entry, "cancel"),
          stopDeadline.then(() => ({ kind: "unknown", receipt: null, error: {
            code: "EPLAN_FAILURE_STOP_TIMEOUT", message: "Owned stop did not settle before the failure cleanup deadline", status: "UNKNOWN"
          } }))
        ]);
      } catch {
        result = { kind: "unknown", receipt: null, error: {
          code: "EPLAN_FAILURE_STOP_UNKNOWN", message: "Owned failure cleanup did not yield a validated stop result", status: "UNKNOWN"
        } };
      } finally {
        stopDeadline.cancel();
      }
      const callbackDeadline = delay(stopWaitMs, { keepAlive: true });
      let callbackSettled = false;
      try {
        callbackSettled = await Promise.race([
          entry.promise.then(() => true, () => true),
          callbackDeadline.then(() => false)
        ]);
      } finally {
        callbackDeadline.cancel();
      }
      if (!callbackSettled) entry.detached = true;
      return {
        taskId: entry.task.id, attemptId: entry.attemptId, handleId: entry.handleId,
        unitId: entry.admission?.unitId ?? entry.preAdmissionCleanup?.scope.unitId ?? null,
        executionId: entry.admission?.executionId ?? entry.preAdmissionCleanup?.scope.executionId ?? null,
        ownedResourceId: entry.admission?.ownedResourceId ?? entry.preAdmissionCleanup?.scope.ownedResourceId ?? null,
        callbackSettled, stopOutcome: result.kind,
        stopReceipt: result.receipt ?? null, error: result.error ?? null
      };
    });
    failureCleanupPromise = Promise.all(operations).then((tasks) => {
      failureCleanupObservation = {
        schemaVersion: 1, kind: "NativeV3PlanFailureCleanupObservationV1",
        runId, planId: pinnedPlan.planId, planDigest: pinnedPlan.planDigest, contractDigest: pinnedPlan.contractDigest,
        scope: "SCHEDULER_OWNED_ENTRY_OBSERVATIONS", checkpointPersistence: "UNPROVEN",
        completed: tasks.every((task) => task.callbackSettled && ["stopped", "not-started"].includes(task.stopOutcome)),
        tasks, authority: "none"
      };
    });
    failureCleanupPromise.catch(() => {});
    return failureCleanupPromise;
  }

  async function blockDependencies() {
    return transition("tasks.dependency-blocked", (state) => {
      let changed = false;
      for (const task of pinnedPlan.taskContract.graph.tasks) {
        const current = state.tasks[task.id];
        if (current.status === "pending" && anyDependencyTerminalFailure(state, task)) {
          current.status = "blocked";
          current.outcome = "blocked";
          current.lastError = { code: "EPLAN_DEPENDENCY_BLOCKED", message: "A dependency did not complete successfully", status: "HOLD" };
          current.finishedAt = nowIso(clock);
          changed = true;
        }
      }
      return changed;
    }, { detail: { phase: "dependency-blocked" } });
  }

  async function settleTask(entry, settlement) {
    async function transitionSettlement(type, update, details) {
      let admitted = false;
      const next = await transition(type, (liveState) => {
        const task = liveState.tasks[entry.task.id];
        // The initial settlement read is outside the plan lease. Stop/pause
        // may win before this CAS, and no late result may overwrite that
        // fence or a different attempt, including budget/error outcomes.
        if (liveState.status !== "running" || liveState.dispatchBlocked || liveState.cancelRequested ||
            localCancelRequested || localPauseRequested || abortSignal?.aborted ||
            task.attemptId !== entry.attemptId || TERMINAL_TASK_STATUSES.has(task.status)) return false;
        admitted = true;
        return update(liveState);
      }, details);
      if (!admitted && next.tasks[entry.task.id].attemptId === entry.attemptId &&
          !TERMINAL_TASK_STATUSES.has(next.tasks[entry.task.id].status)) {
        const stopped = await stopEntry(entry, next.status === "paused" || localPauseRequested ? "pause" : next.cancelReason ?? cancelReason ?? "cancel");
        if (next.status === "paused" || localPauseRequested) await markTaskPause(entry, stopped);
        else await markTaskStop(entry, stopped);
        return readCheckpoint();
      }
      return next;
    }
    const state = await readCheckpoint();
    const current = state.tasks[entry.task.id];
    if (TERMINAL_TASK_STATUSES.has(current.status)) {
      active.delete(entry.task.id);
      return state;
    }
    if (state.cancelRequested || state.dispatchBlocked || state.status !== "running") {
      const stopResult = await stopEntry(entry, state.cancelReason ?? cancelReason ?? "cancel");
      if (state.status === "paused" || localPauseRequested) await markTaskPause(entry, stopResult);
      else await markTaskStop(entry, stopResult);
      active.delete(entry.task.id);
      return readCheckpoint();
    }
    if (settlement.kind === "error") {
      const kind = errorClass(settlement.error);
      const stopResult = kind === "unknown" || kind === "hold"
        ? await stopEntry(entry, kind === "unknown" ? "controller-failure" : "cancel")
        : { kind: "not-started", receipt: null, error: null };
      if (stopResult.kind === "unknown") await markTaskStop(entry, stopResult);
      await transitionSettlement(`task.${kind}`, (nextState) => {
        const taskState = nextState.tasks[entry.task.id];
        if (TERMINAL_TASK_STATUSES.has(taskState.status)) return false;
        markUnobservedUsage(nextState, taskState, entry, stopResult);
        taskState.status = kind;
        taskState.outcome = kind;
        taskState.finishedAt = nowIso(clock);
        taskState.lastError = errorProjection(settlement.error, kind === "unknown" ? "EPLAN_TASK_UNKNOWN" : "EPLAN_TASK_HOLD");
        if (kind === "unknown" || kind === "hold") {
          if (kind === "hold") {
            nextState.status = "hold";
            nextState.dispatchBlocked = true;
            nextState.failure = taskState.lastError;
          } else {
            // An UNKNOWN effect fences only this obligation and its
            // dependants. Independent ready tasks may continue; the run is
            // finalized UNKNOWN once no unaffected work remains.
            nextState.reconcileRequired = true;
            nextState.failure = taskState.lastError;
          }
        }
        return true;
      }, { taskId: entry.task.id, attemptId: entry.attemptId, detail: { status: kind } });
      if (kind === "unknown") {
        await transition("run.unknown-observed", (nextState) => {
          if (nextState.status !== "running") return false;
          nextState.reconcileRequired = true;
          nextState.failure = nextState.failure ?? errorProjection(settlement.error, "EPLAN_TASK_UNKNOWN");
          return true;
        }, { taskId: entry.task.id, attemptId: entry.attemptId, detail: { scope: "task-and-dependants" } });
      }
      active.delete(entry.task.id);
      return readCheckpoint();
    }
    let result;
    try {
      result = validateNativeV3PlanTaskResult(settlement.value);
    } catch (error) {
      const stopResult = await stopEntry(entry, "cancel");
      if (stopResult.kind === "unknown") {
        await markTaskStop(entry, stopResult);
        active.delete(entry.task.id);
        await failRun("unknown", new NativeV3PlanRunnerError(
          "EPLAN_TASK_RESULT_UNKNOWN",
          "Malformed task result could not be safely stopped",
          "UNKNOWN"
        ));
        return readCheckpoint();
      }
      await transitionSettlement("task.result-invalid", (nextState) => {
        const taskState = nextState.tasks[entry.task.id];
        if (TERMINAL_TASK_STATUSES.has(taskState.status)) return false;
        markUnobservedUsage(nextState, taskState, entry, stopResult);
        taskState.status = "hold";
        taskState.outcome = "hold";
        taskState.finishedAt = nowIso(clock);
        taskState.lastError = errorProjection(error, "EPLAN_TASK_RESULT");
        nextState.status = "hold";
        nextState.dispatchBlocked = true;
        nextState.failure = taskState.lastError;
        return true;
      }, { taskId: entry.task.id, attemptId: entry.attemptId, detail: { status: "hold", phase: "result-validation" } });
      active.delete(entry.task.id);
      return readCheckpoint();
    }
    const usage = result.usage;
    const taskUsage = accumulatedUsage(current.usage, usage);
    const planUsage = accumulatedUsage({
      seconds: state.budget.secondsUsed,
      tokens: state.budget.tokensUsed
    }, usage);
    const cumulativeUnknownDimensions = unknownUsageDimensions(taskUsage);
    const unknownBudgetDimensions = ["seconds", "tokens"].filter((dimension) => {
      const constrained = entry.task.budget[dimension] !== null || state.budget[dimension] !== null;
      return constrained && (taskUsage[dimension] === null || planUsage[dimension] === null);
    });
    if (unknownBudgetDimensions.length > 0) {
      const usageUnknown = {
        code: "EPLAN_USAGE_UNKNOWN",
        message: `Trusted usage is unknown for bounded dimension(s): ${unknownBudgetDimensions.join(", ")}`,
        status: "HOLD"
      };
      const next = await transitionSettlement("task.hold", (nextState) => {
        const taskState = nextState.tasks[entry.task.id];
        if (TERMINAL_TASK_STATUSES.has(taskState.status)) return false;
        const liveTaskUsage = accumulatedUsage(taskState.usage, usage);
        const livePlanUsage = accumulatedUsage({
          seconds: nextState.budget.secondsUsed,
          tokens: nextState.budget.tokensUsed
        }, usage);
        // The effect result has already been observed.  Preserve that
        // historical outcome while fencing the task and all later work on
        // account of an unmeasured bounded dimension; this must never become
        // a retry or a not-sent claim.  Known sibling dimensions remain
        // durably accounted.
        taskState.status = "hold";
        taskState.outcome = result.outcome;
        taskState.finishedAt = nowIso(clock);
        taskState.lastError = usageUnknown;
        taskState.usage = liveTaskUsage;
        nextState.budget.secondsUsed = livePlanUsage.seconds;
        nextState.budget.tokensUsed = livePlanUsage.tokens;
        nextState.status = "hold";
        nextState.dispatchBlocked = true;
        nextState.failure = usageUnknown;
        return true;
      }, {
        taskId: entry.task.id,
        attemptId: entry.attemptId,
        detail: { phase: "usage", outcome: result.outcome, usageStatus: "unknown", unknownDimensions: cumulativeUnknownDimensions }
      });
      active.delete(entry.task.id);
      return next;
    }
    const exceedsTaskSeconds = entry.task.budget.seconds !== null && taskUsage.seconds !== null && taskUsage.seconds > entry.task.budget.seconds;
    const exceedsTaskTokens = entry.task.budget.tokens !== null && taskUsage.tokens !== null && taskUsage.tokens > entry.task.budget.tokens;
    const exceedsPlanSeconds = state.budget.seconds !== null && planUsage.seconds !== null && planUsage.seconds > state.budget.seconds;
    const exceedsPlanTokens = state.budget.tokens !== null && planUsage.tokens !== null && planUsage.tokens > state.budget.tokens;
    if (exceedsTaskSeconds || exceedsTaskTokens || exceedsPlanSeconds || exceedsPlanTokens) {
      await transitionSettlement("task.budget-exceeded", (nextState) => {
        const taskState = nextState.tasks[entry.task.id];
        taskState.status = "hold";
        // A budget violation blocks further work without rewriting the
        // effect that already settled. It cannot create a retryable failure
        // or erase an observed success from recovery/readback.
        taskState.outcome = result.outcome;
        taskState.finishedAt = nowIso(clock);
        taskState.lastError = { code: "EPLAN_BUDGET_EXCEEDED", message: "Task or WorkflowPlan resource budget was exceeded", status: "HOLD" };
        taskState.usage = accumulatedUsage(taskState.usage, usage);
        nextState.budget.secondsUsed = addUsage(nextState.budget.secondsUsed, usage.seconds);
        nextState.budget.tokensUsed = addUsage(nextState.budget.tokensUsed, usage.tokens);
        nextState.status = "hold";
        nextState.dispatchBlocked = true;
        nextState.failure = taskState.lastError;
        return true;
      }, { taskId: entry.task.id, attemptId: entry.attemptId, detail: { status: "budget-exceeded", outcome: result.outcome, usage } });
      active.delete(entry.task.id);
      return readCheckpoint();
    }
    const next = await transitionSettlement(`task.${result.outcome}`, (nextState) => {
      const taskState = nextState.tasks[entry.task.id];
      taskState.usage = accumulatedUsage(taskState.usage, usage);
      nextState.budget.secondsUsed = addUsage(nextState.budget.secondsUsed, usage.seconds);
      nextState.budget.tokensUsed = addUsage(nextState.budget.tokensUsed, usage.tokens);
      taskState.finishedAt = nowIso(clock);
      taskState.outcome = result.outcome;
      taskState.lastError = result.outcome === "failure"
        ? { code: "EPLAN_TASK_FAILED", message: "The typed task runner returned failure", status: null }
        : null;
      if (result.outcome === "success") {
        taskState.status = "succeeded";
      } else if (taskState.attempts < entry.task.budget.attempts && nextState.budget.attemptsUsed < nextState.budget.attempts) {
        taskState.status = "pending";
      } else {
        taskState.status = "failed";
        nextState.status = "failed";
        nextState.dispatchBlocked = true;
        nextState.failure = taskState.lastError;
      }
      return true;
    }, { taskId: entry.task.id, attemptId: entry.attemptId, detail: { outcome: result.outcome, usage } });
    active.delete(entry.task.id);
    return next;
  }

  async function executeTask(entry) {
    try {
      if (localCancelRequested || abortSignal?.aborted || entry.abortController.signal.aborted) {
        return { kind: "cancelled-before-prepare" };
      }
      entry.prepareStarted = true;
      const context = deepFreeze({
        schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
        kind: "NativeV3PlanTaskAdapterContextV1",
        runId,
        planId: pinnedPlan.planId,
        planDigest: pinnedPlan.planDigest,
        contractDigest: pinnedPlan.contractDigest,
        taskId: entry.task.id,
        attemptId: entry.attemptId,
        attemptNumber: entry.attemptNumber,
        task: clone(entry.task),
        plan: clone(pinnedPlan),
        signal: entry.abortController.signal
      });
      entry.preparationAdapter = activeTaskAdapter;
      entry.preparationContext = context;
      const preparation = beginNativeV3PlanTaskPreparation(activeTaskAdapter, context, { stopWaitMs });
      entry.preparationInvocation = preparation.invocation;
      entry.cleanupReady = preparation.cleanupReady;
      entry.cleanupReady.then(() => {
        try {
          refreshPreparationCleanup(entry);
          if (entry.preAdmissionCleanup && (entry.cleanupRequested || entry.detached ||
              entry.abortController.signal.aborted || localCancelRequested || abortSignal?.aborted)) {
            entry.cleanupRequested = true;
            entry.cleanupReason ??= "cancel";
            entry.abortController.abort();
            physicalStopEntry(entry, entry.cleanupReason).catch(() => {});
          }
        } catch (error) {
          entry.preparationProtocolError = error;
        }
      }).catch(() => {});
      const rawPrepared = await preparation.prepared;
      if (entry.preparationProtocolError) throw entry.preparationProtocolError;
      refreshPreparationCleanup(entry, rawPrepared);
      const candidate = validatePreparedTask(rawPrepared, {
        plan: pinnedPlan, task: entry.task, runId, attemptId: entry.attemptId,
        preparationIdentity: { invocation: entry.preparationInvocation, adapter: entry.preparationAdapter, context }
      });
      const admission = await readTrustedAdmission(candidate, {
        plan: pinnedPlan,
        task: entry.task,
        runId,
        attemptId: entry.attemptId,
        clock
      });
      // The producer transferred the command runner's already-created
      // execution allocation.  Reopening a registry here would mint a second
      // handle for the same logical obligation and could let the original
      // command runner launch the effect again after this plan succeeds.
      const handle = candidate.handle;
      const admissionDigest = digestExecutionAdmission(admission);
      if (handle.admissionDigest !== admissionDigest) {
        fail("EPLAN_RUNNER_ADMISSION", "transferred runtime handle admission is not bound to the trusted candidate", "HOLD");
      }
      const prepared = {
        ...candidate,
        admission,
        handle,
        runner: {
          execute: async () => {
            try {
              // This calls the producer's one-shot transfer capability, which
              // uses the original command runner registry and handle.  Do not
              // retry after a seal/commit failure: the effect may already have
              // started and the durable UNKNOWN state is the only safe result.
              const execution = await candidate.transfer.execute();
              const effect = execution?.effect ?? execution;
              if (isPlainObject(effect) && (effect.usage === undefined || effect.usage === null)) {
                // Reuse the command runner's settled, runtime-observed ledger
                // projection. The injected authority clock is not an elapsed
                // timer, and an arbitrary local command may call a provider.
                // Missing token/cost observations must therefore stay unknown.
                const receipt = execution?.budgetReceipt;
                if (receipt !== undefined && receipt !== null &&
                    (receipt.kind !== "NativeV3CommandBudgetReceiptV1" ||
                     receipt.runId !== runId || receipt.handleId !== handle.handleId)) {
                  fail("EPLAN_USAGE_BINDING", "runtime usage receipt is not bound to this execution handle", "HOLD");
                }
                return validateNativeV3PlanTaskResult({
                  ...effect,
                  usage: {
                    seconds: receipt?.usage?.seconds ?? null,
                    tokens: receipt?.usage?.tokens ?? null
                  }
                });
              }
              return validateNativeV3PlanTaskResult(effect);
            } catch (error) {
              throw error;
            }
          },
          stop: async ({ reason }) => candidate.transfer.stop({
            reason,
            requestedBy: "native-v3-plan-runner",
            expectedEpoch: handle.authorityEpoch,
            expectedFence: handle.fence,
            expectedRevision: handle.revision
          })
        }
      };
      entry.prepared = prepared;
      entry.admission = prepared.admission;
      entry.handleId = handle.handleId;
      entry.runner = prepared.runner;
      entry.ownsTransferredAllocation = true;
      entry.runnerReadyResolve(prepared);
      if (entry.detached && failureCleanupPromise !== null) {
        // A timed-out prepare can expose its validated owned allocation after
        // failure cleanup returned UNKNOWN. Revoke it through the same stop
        // memo; the earlier observation stays UNKNOWN and no effect is retried.
        entry.abortController.abort();
        physicalStopEntry(entry, "cancel").catch(() => {});
      }
      if (localCancelRequested || abortSignal?.aborted || entry.abortController.signal.aborted) {
        return { kind: "cancelled-before-prepare" };
      }
      if (entry.task.verification !== undefined) {
        if (!verificationConsumer) {
          fail("EPLAN_VERIFICATION_SETUP", "the verified WorkflowPlan task has no trusted verification consumer", "HOLD");
        }
        let verificationHandle;
        try {
          verificationHandle = await verificationConsumer.prepareTask({ taskId: entry.task.id });
          if (!isNativeV3VerificationTaskHandle(verificationHandle)) {
            fail("EPLAN_VERIFICATION_HANDLE", "verification consumer returned an untrusted task handle", "HOLD");
          }
        } catch (error) {
          if (error instanceof NativeV3PlanRunnerError) throw error;
          const wrapped = new NativeV3PlanRunnerError(
            "EPLAN_VERIFICATION_PREPARE",
            "verification task preparation failed: " + String(error?.message ?? error),
            error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
          );
          wrapped.cause = error;
          throw wrapped;
        }
        let verificationReceipt;
        try {
          verificationReceipt = await verificationConsumer.evaluateTask(verificationHandle, {
            runId,
            epoch: admission.authorityEpoch,
            unrelatedHeadDigest: admission.sourceBindingDigest
          });
        } catch (error) {
          const wrapped = new NativeV3PlanRunnerError(
            "EPLAN_VERIFICATION_EVALUATE",
            "verification evaluation failed: " + String(error?.message ?? error),
            error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
          );
          wrapped.cause = error;
          throw wrapped;
        }
        const verification = verificationCheckpointForReceipt(verificationReceipt, {
          plan: pinnedPlan,
          task: entry.task,
          runId,
          attemptId: entry.attemptId,
          admission
        });
        const verificationState = await recordVerification(entry, verification);
        if (!same(verificationState.tasks[entry.task.id].verification, verification)) {
          fail("EPLAN_VERIFICATION_STATE", "verification receipt could not be durably bound to the current task attempt", "HOLD");
        }
        if (verification.status !== "pass") {
          const status = verification.status === "unknown" ? "UNKNOWN" : "HOLD";
          const error = new NativeV3PlanRunnerError(
            "EPLAN_VERIFICATION_NOT_PASS",
            "verification did not pass before the native V3 effect dispatch",
            status
          );
          error.receiptDigest = verification.receiptDigest;
          throw error;
        }
        if (localCancelRequested || abortSignal?.aborted || entry.abortController.signal.aborted) {
          throw new NativeV3PlanRunnerError(
            "EPLAN_RUN_CANCELLED",
            "plan cancellation was observed after verification and before effect dispatch",
            "HOLD"
          );
        }
      }
      const preparedState = await markPrepared(entry, {
        ...prepared,
        admissionDigest
      });
      if (preparedState.tasks[entry.task.id].status !== "preparing" || preparedState.cancelRequested || preparedState.dispatchBlocked) {
        const stopResult = await stopEntry(entry, preparedState.cancelReason ?? cancelReason ?? "cancel");
        return stopResult.kind === "stopped" ? { kind: "cancelled" } : { kind: "error", error: stopResult.error ?? new NativeV3PlanRunnerError("EPLAN_RUNNER_STOP", "prepared task could not be stopped", "UNKNOWN") };
      }
      if (localCancelRequested || abortSignal?.aborted || entry.abortController.signal.aborted) {
        return { kind: "cancelled-before-prepare" };
      }
      const currentAdmission = await readTrustedAdmission(prepared, {
        plan: pinnedPlan,
        task: entry.task,
        runId,
        attemptId: entry.attemptId,
        clock
      });
      try {
        assertSameExecutionAdmission(admission, currentAdmission);
      } catch (error) {
        const wrapped = new NativeV3PlanRunnerError(
          "EPLAN_RUNNER_ADMISSION",
          "Current V3 admission drifted from the durable reservation",
          "HOLD"
        );
        wrapped.cause = error;
        throw wrapped;
      }
      if (localCancelRequested || abortSignal?.aborted || entry.abortController.signal.aborted) {
        return { kind: "cancelled-before-prepare" };
      }
      const dispatchState = await markDispatching(entry);
      if (dispatchState.tasks[entry.task.id].status !== "dispatching") {
        const stopResult = await stopEntry(entry, dispatchState.cancelReason ?? cancelReason ?? "cancel");
        return stopResult.kind === "stopped" ? { kind: "cancelled" } : { kind: "error", error: stopResult.error ?? new NativeV3PlanRunnerError("EPLAN_RUNNER_STOP", "task dispatch was blocked but cleanup was not proven", "UNKNOWN") };
      }
      const beforeEffect = await readCheckpoint();
      if (beforeEffect.status !== "running" || beforeEffect.dispatchBlocked || localPauseRequested || localCancelRequested ||
          abortSignal?.aborted || entry.abortController.signal.aborted) {
        await stopEntry(entry, beforeEffect.cancelReason ?? cancelReason ?? (localPauseRequested ? "pause" : "cancel"));
        return { kind: "cancelled-before-prepare" };
      }
      entry.effectStarted = true;
      const value = await prepared.runner.execute();
      return { kind: "result", value };
    } catch (error) {
      if (entry.handleId && isExecutionRuntimeEffectNotSent(error, {
        runId,
        handleId: entry.handleId,
        ownedResourceId: entry.admission?.ownedResourceId,
        intentId: undefined
      })) {
        entry.notSentProof = true;
      }
      entry.primaryFailure = error;
      const cleanup = await stopEntry(entry, error?.status === "UNKNOWN" ? "controller-failure" : "cancel");
      if (cleanup.kind === "unknown") {
        const wrapped = new NativeV3PlanRunnerError(
          "EPLAN_PREPARATION_CLEANUP_UNKNOWN",
          "Task failure left owned allocation cleanup unconfirmed",
          "UNKNOWN"
        );
        wrapped.cause = error;
        return { kind: "error", error: wrapped };
      }
      return { kind: "error", error };
    }
  }

  function launchTask(reserved) {
    const entry = {
      task: reserved.task,
      attemptId: reserved.attemptId,
      attemptNumber: reserved.attemptNumber,
      prepareStarted: false,
      preparationInvocation: null,
      preparationAdapter: null,
      preparationContext: null,
      preparationProtocolError: null,
      preparationFailureCleanup: null,
      preAdmissionCleanup: null,
      cleanupReady: null,
      cleanupRequested: false,
      cleanupReason: null,
      primaryFailure: null,
      prepared: null,
      admission: null,
      handleId: null,
      runner: null,
      stopPromise: null,
      physicalStopPromise: null,
      ownsTransferredAllocation: false,
      stopRetryable: false,
      notSentProof: false,
      effectStarted: false,
      pauseUnsafe: false,
      detached: false,
      abortController: new AbortController(),
      runnerReady: null,
      runnerReadyResolve: null,
      promise: null
    };
    entry.runnerReady = new Promise((resolve) => { entry.runnerReadyResolve = resolve; });
    entry.runnerReady.catch(() => {});
    active.set(entry.task.id, entry);
    pendingCleanupEntries.add(entry);
    entry.promise = executeTask(entry).then((settlement) => ({ entry, settlement }));
    entry.promise.catch(() => {});
    return entry;
  }

  async function waitForActivity() {
    if (active.size === 0) return { kind: "idle" };
    let timer = null;
    let poll = null;
    const cancellation = new Promise((resolve) => {
      poll = setInterval(async () => {
        try {
          const state = await readCheckpoint();
          if (state.status === "paused" || localPauseRequested) resolve({ kind: "pause" });
          else if (state.cancelRequested || localCancelRequested || abortSignal?.aborted) resolve({ kind: "cancel" });
        } catch (error) {
          resolve({ kind: "error", error });
        }
      }, 25);
    });
    const completions = [...active.values()].map((entry) => entry.promise.then(({ entry: settledEntry, settlement }) => ({ kind: "settled", entry: settledEntry, settlement })));
    try {
      return await Promise.race([...completions, cancellation]);
    } finally {
      if (poll !== null) clearInterval(poll);
      if (timer !== null) clearTimeout(timer);
    }
  }

  async function finalize(status, failure = null) {
    return transition("run.terminal", (state) => {
      // Success also needs a current admission at its final CAS. A concurrent
      // stop/pause must not be turned back into an unfenced successful run.
      if (status === "succeeded" && (state.status !== "running" || state.dispatchBlocked ||
          state.cancelRequested || localCancelRequested || localPauseRequested || abortSignal?.aborted)) return false;
      let changed = false;
      if (TERMINAL_RUN_STATUSES.has(state.status)) {
        // A task transition may fence the run before finalize() gets to mark
        // the remaining graph. Preserve that terminal decision while still
        // durably closing pending tasks for inspection.
        status = state.status;
        failure = state.failure ?? failure;
      } else {
        changed = true;
      }
      state.status = status;
      state.dispatchBlocked = status !== "succeeded";
      state.failure = failure;
      state.reconcileRequired = false;
      for (const task of pinnedPlan.taskContract.graph.tasks) {
        const taskState = state.tasks[task.id];
        if (status === "cancelled" && ["pending", "preparing"].includes(taskState.status)) {
          if (!taskHasNotStartedProof(state, taskState)) {
            // A terminal run transition can close a reservation that no
            // longer has an in-memory entry.  Do not turn that missing
            // observation into the initial zero charge.
            markUnobservedUsage(state, taskState);
          }
          taskState.status = "cancelled";
          taskState.outcome = "cancelled";
          taskState.finishedAt = nowIso(clock);
          changed = true;
        } else if (status !== "succeeded" && taskState.status === "pending") {
          taskState.status = "blocked";
          taskState.outcome = "blocked";
          taskState.lastError = { code: "EPLAN_RUN_BLOCKED", message: "The plan run stopped before this task became ready", status: "HOLD" };
          taskState.finishedAt = nowIso(clock);
          changed = true;
        }
      }
      return changed;
    }, { detail: { status } });
  }

  async function cancelRun() {
    const state = await readCheckpoint();
    if (state.ownerId !== null && state.ownerId !== ownerId) {
      // A non-owner may record cancellation, but it cannot stop the owner's
      // in-memory handles or close a dispatching task.  The durable marker is
      // deliberately left recoverable for the owner/reconcile path.
      return state;
    }
    const reason = state.cancelReason ?? cancelReason ?? "cancel";
    const stopped = await stopAllActive(reason);
    const hasUnknownStop = stopped.some(({ result }) => result.kind === "unknown");
    if (hasUnknownStop) return finalize("unknown", { code: "EPLAN_CLEANUP_UNKNOWN", message: "At least one owned task could not be proven stopped", status: "UNKNOWN" });
    return finalize("cancelled", null);
  }

  async function reconcile() {
    return transition("run.owner-reconcile", (state) => {
      if (TERMINAL_RUN_STATUSES.has(state.status) || state.ownerId === null || state.ownerId === ownerId) return false;
      const alive = ownerProcessAlive(state.ownerPid);
      if (alive !== false) {
        // No terminal status is inferred while the owner process is alive or
        // cannot be inspected.  A caller can retry this observation later.
        if (state.reconcileRequired && state.failure?.code === "EPLAN_OWNER_RECONCILE_REQUIRED") return false;
        state.reconcileRequired = true;
        state.failure = {
          code: "EPLAN_OWNER_RECONCILE_REQUIRED",
          message: "The plan owner is still live or its liveness cannot be proven; cleanup remains with that owner",
          status: "UNKNOWN"
        };
        return true;
      }
      state.status = "unknown";
      state.dispatchBlocked = true;
      state.failure = {
        code: "EPLAN_OWNER_LOST_RECONCILE_REQUIRED",
        message: "The plan owner process is gone; dispatching tasks require runtime handle reconciliation",
        status: "UNKNOWN"
      };
      for (const task of pinnedPlan.taskContract.graph.tasks) {
        const taskState = state.tasks[task.id];
        if (["preparing", "dispatching"].includes(taskState.status)) {
          markUnobservedUsage(state, taskState);
          taskState.status = "unknown";
          taskState.outcome = "unknown";
          taskState.lastError = state.failure;
          taskState.finishedAt = nowIso(clock);
        } else if (taskState.status === "pending") {
          taskState.status = "blocked";
          taskState.outcome = "blocked";
          taskState.lastError = {
            code: "EPLAN_RUN_BLOCKED",
            message: "The plan owner was lost before this task became ready",
            status: "HOLD"
          };
          taskState.finishedAt = nowIso(clock);
        }
      }
      return true;
    }, { detail: { phase: "owner-reconcile" } });
  }

  async function failRun(status, error) {
    const projected = errorProjection(error, status === "unknown" ? "EPLAN_TASK_UNKNOWN" : "EPLAN_TASK_HOLD");
    const reason = status === "unknown" ? "controller-failure" : "cancel";
    const stopped = await stopAllActive(reason);
    if (stopped.some(({ result }) => result.kind === "unknown")) {
      return finalize("unknown", { code: "EPLAN_CLEANUP_UNKNOWN", message: "Task cleanup could not be proven after a terminal failure", status: "UNKNOWN" });
    }
    return finalize(status, projected);
  }

  async function cleanupActiveBeforeTerminal(state) {
    if (state.status === "succeeded" || active.size === 0) return state;
    const reason = state.status === "unknown" ? "controller-failure" : "cancel";
    let stopped;
    try {
      stopped = await stopAllActive(reason);
    } catch {
      // A terminal checkpoint must never be returned while an owned sibling
      // is still unaccounted for.  If cleanup itself fails, preserve all
      // already-observed task outcomes but escalate the run to UNKNOWN.
      return transition("run.cleanup-unknown", (nextState) => {
        if (nextState.status === "succeeded") return false;
        nextState.status = "unknown";
        nextState.dispatchBlocked = true;
        nextState.reconcileRequired = true;
        nextState.failure = {
          code: "EPLAN_CLEANUP_UNKNOWN",
          message: "Owned task cleanup failed before terminal return",
          status: "UNKNOWN"
        };
        return true;
      }, { detail: { phase: "terminal-cleanup", outcome: "unknown" } });
    }
    if (!stopped.some(({ result }) => result.kind === "unknown")) return readCheckpoint();
    return transition("run.cleanup-unknown", (nextState) => {
      if (nextState.status === "succeeded") return false;
      nextState.status = "unknown";
      nextState.dispatchBlocked = true;
      nextState.reconcileRequired = true;
      nextState.failure = {
        code: "EPLAN_CLEANUP_UNKNOWN",
        message: "At least one owned sibling could not be proven stopped before terminal return",
        status: "UNKNOWN"
      };
      return true;
    }, { detail: { phase: "terminal-cleanup", outcome: "unknown" } });
  }

  async function finalizePause(stopped = []) {
    const unsafe = stopped.some(({ entry, result }) => entry.pauseUnsafe === true || result.kind === "unknown");
    const before = await readCheckpoint();
    const freshAttemptTaskIds = pinnedPlan.taskContract.graph.tasks
      .filter((task) => before.tasks[task.id].status === "pending" && before.tasks[task.id].attempts === 0)
      .map((task) => task.id)
      .sort();
    return transition("run.paused", (state) => {
      if (TERMINAL_RUN_STATUSES.has(state.status)) return false;
      if (state.status === "paused" && state.ownerId === null) return false;
      state.status = unsafe ? "unknown" : "paused";
      state.dispatchBlocked = true;
      state.cancelRequested = false;
      state.cancelReason = "pause";
      state.ownerId = null;
      state.ownerPid = null;
      state.reconcileRequired = unsafe;
      state.failure = unsafe
        ? { code: "EPLAN_PAUSE_RECONCILIATION_REQUIRED", message: "A paused task may have entered its external effect; provider reconciliation is required before retry", status: "UNKNOWN" }
        : null;
      return true;
    }, { detail: { phase: "paused", unsafe, freshAttemptTaskIds } });
  }

  async function runLoop() {
    const onAbort = () => {
      void markCancelRequested("cancel").catch(() => {});
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      let state = await claimRun();
      if (TERMINAL_RUN_STATUSES.has(state.status)) return planRunnerResult(state);
      if (state.status === "paused") {
        if (active.size > 0) {
          const paused = await finalizePause(await stopAllActive("pause", { pause: true }));
          if (paused.status === "paused") pauseOwnerId = ownerId;
        }
        return planRunnerResult(await readCheckpoint());
      }
      while (true) {
        state = await readCheckpoint();
        if (TERMINAL_RUN_STATUSES.has(state.status)) {
          if (state.status !== "succeeded" && active.size > 0) {
            state = await cleanupActiveBeforeTerminal(state);
          }
          if (state.status !== "succeeded" && pinnedPlan.taskContract.graph.tasks.some((task) => ["pending", "preparing"].includes(state.tasks[task.id].status))) {
            await finalize(state.status, state.failure);
            state = await readCheckpoint();
          }
          return planRunnerResult(state);
        }
        if (state.status === "paused") {
          const stopped = active.size > 0 ? await stopAllActive("pause", { pause: true }) : [];
          const paused = await finalizePause(stopped);
          if (paused.status === "paused") pauseOwnerId = ownerId;
          return planRunnerResult(await readCheckpoint());
        }
        if (state.cancelRequested || localCancelRequested || abortSignal?.aborted) {
          await cancelRun();
          return planRunnerResult(await readCheckpoint());
        }
        let currentPlan;
        try {
          currentPlan = await freshPlan();
        } catch (error) {
          await failRun("hold", error);
          return planRunnerResult(await readCheckpoint());
        }
        if (!same(currentPlan, pinnedPlan)) {
          await failRun("hold", new NativeV3PlanRunnerError("EPLAN_SOURCE_DRIFT", "WorkflowPlanV1 changed during DAG execution", "HOLD"));
          return planRunnerResult(await readCheckpoint());
        }
        await blockDependencies();
        state = await readCheckpoint();
        if (state.status === "failed" || state.status === "hold" || state.status === "unknown") {
          await failRun(state.status, state.failure ?? new NativeV3PlanRunnerError("EPLAN_RUN_TERMINAL", "plan run reached a terminal state", state.status === "unknown" ? "UNKNOWN" : "HOLD"));
          return planRunnerResult(await readCheckpoint());
        }
        const ready = readyTasks(state, pinnedPlan);
      while (active.size < parallelism && ready.length > 0) {
        if (localCancelRequested || abortSignal?.aborted) break;
        const reserved = await reserveTask(ready.shift());
        if (!reserved) break;
        if (localCancelRequested || abortSignal?.aborted) break;
        launchTask(reserved);
      }
        state = await readCheckpoint();
        if (state.status === "hold" || state.status === "failed" || state.status === "unknown") {
          await failRun(state.status, state.failure);
          return planRunnerResult(await readCheckpoint());
        }
        if (active.size === 0) {
          if (allTasksSucceeded(state, pinnedPlan)) {
            const completed = await finalize("succeeded", null);
            if (completed.status === "succeeded") return planRunnerResult(completed);
            continue;
          }
          const pending = pinnedPlan.taskContract.graph.tasks.filter((task) => ["pending", "preparing", "dispatching"].includes(state.tasks[task.id].status));
          if (pending.length === 0) {
            const stalled = hasUnknownTask(state, pinnedPlan);
              await failRun(stalled ? "unknown" : "hold", stalled
                ? new NativeV3PlanRunnerError("EPLAN_TASK_UNKNOWN", "WorkflowPlan completed all unaffected work but an obligation remains UNKNOWN", "UNKNOWN")
                : new NativeV3PlanRunnerError("EPLAN_DAG_STALLED", "WorkflowPlan DAG has no ready task and is not complete", "HOLD"));
              return planRunnerResult(await readCheckpoint());
          }
          continue;
        }
        const activity = await waitForActivity();
        if (activity.kind === "pause" || localPauseRequested) continue;
        if (activity.kind === "cancel" || localCancelRequested || abortSignal?.aborted) continue;
        if (activity.kind === "error") {
          await failRun("hold", activity.error);
          return planRunnerResult(await readCheckpoint());
        }
        if (activity.kind === "settled") {
          await settleTask(activity.entry, activity.settlement.kind === "result"
            ? { kind: "result", value: activity.settlement.value }
            : activity.settlement.kind === "cancelled-before-prepare"
              ? { kind: "cancelled" }
              : activity.settlement);
          pendingCleanupEntries.delete(activity.entry);
        }
      }
    } catch (error) {
      // Preserve the original producer rejection identity. Cleanup facts are
      // observed separately; neither a stop nor this exception is a terminal
      // checkpoint or permission to retry the effect.
      try {
        await observeFailureCleanup();
      } catch {
        // A failed observation cannot replace the primary execution failure.
      }
      throw error;
    } finally {
      abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  async function run() {
    if (runPromise === null) {
      runSettled = false;
      failureCleanupObservation = null;
      failureCleanupPromise = null;
      physicalStopObservations.clear();
      runPromise = runLoop();
      runPromise.then(
        () => { runSettled = true; },
        () => { runSettled = true; }
      );
    }
    return runPromise;
  }

  async function pause(pauseOptions = undefined) {
    const supplied = exactOptions(pauseOptions, PAUSE_KEYS, "pause options");
    const reason = supplied.reason ?? "pause";
    if (reason !== "pause") fail("EPLAN_RUNNER_INPUT", "pause reason must be pause");
    if (pausePromise !== null && pauseSettled) {
      const current = await readCheckpoint();
      if (current.status === "paused") return pausePromise;
      // A different runner may have resumed or finalized this checkpoint.
      // Do not return a stale pause receipt to a late caller.
      pausePromise = null;
    }
    if (pausePromise === null) {
      pauseSettled = false;
      pausePromise = (async () => {
        try {
          await markPauseRequested(reason);
          const stopped = active.size > 0 ? await stopAllActive(reason, { pause: true }) : [];
          const paused = await finalizePause(stopped);
          if (paused.status === "paused") pauseOwnerId = ownerId;
          if (runPromise !== null && !runSettled) await runPromise;
          return readCheckpoint();
        } finally {
          pauseSettled = true;
        }
      })();
      pausePromise.catch(() => {});
    }
    return pausePromise;
  }

  async function beginResume(resumeOptions = undefined) {
    const supplied = exactOptions(resumeOptions, RESUME_KEYS, "resume options");
    if (runPromise !== null && !runSettled) {
      fail("EPLAN_RUN_IN_PROGRESS", "plan runner is still settling its pause checkpoint", "HOLD");
    }
    if (runPromise !== null && runSettled) runPromise = null;
    if (supplied.taskAdapter !== undefined &&
        (!isPlainObject(supplied.taskAdapter) || !isNativeV3PlanTaskAdapter(supplied.taskAdapter))) {
      fail("EPLAN_RUNNER_INPUT", "resume taskAdapter must be created by the trusted native V3 producer");
    }
    if (supplied.controlRequestDigest !== undefined) digest(supplied.controlRequestDigest, "resume controlRequestDigest");
    const state = await readCheckpoint();
    if (state.usageSchemaVersion === undefined) {
      fail("EPLAN_USAGE_SCHEMA_LEGACY", "legacy checkpoint cannot be resumed without a trusted usage schema version", "HOLD");
    }
    if (state.status !== "paused") {
      if (state.status === "unknown") {
        fail("EPLAN_RESUME_RECONCILIATION_REQUIRED", "plan run is UNKNOWN and requires effect reconciliation before resume", "UNKNOWN");
      }
      fail("EPLAN_RUNNER_STATE", "only a durably paused plan run can be resumed", "HOLD");
    }
    if (incidentRecoveryPreparedEvent(state) !== null) {
      fail(
        "EPLAN_INCIDENT_RECOVERY_CLAIM_REQUIRED",
        "incident recovery checkpoint requires a durable runtime handoff claim before resume",
        "HOLD"
      );
    }
    if (pinnedPlan.taskContract.graph.tasks.some((task) => state.tasks[task.id].status === "unknown")) {
      fail("EPLAN_RESUME_RECONCILIATION_REQUIRED", "paused plan contains an UNKNOWN task that requires effect reconciliation", "UNKNOWN");
    }
    await freshResumePlan();
    const nextAdapter = supplied.taskAdapter;
    if (pauseOwnerId === ownerId && (!nextAdapter || nextAdapter === initialTaskAdapter)) {
      fail("EPLAN_RESUME_ADAPTER_REQUIRED", "same-owner resume requires a fresh trusted task adapter", "HOLD");
    }
    if (nextAdapter !== undefined) activeTaskAdapter = nextAdapter;
    localPauseRequested = false;
    pausePromise = null;
    const resumed = await transition("run.resumed", (current) => {
      if (current.status !== "paused") fail("EPLAN_RUNNER_STATE", "plan run changed before resume", "HOLD");
      if (current.ownerId !== null && current.ownerId !== ownerId) {
        fail("EPLAN_RUN_IN_PROGRESS", "another plan runner owner is active", "HOLD");
      }
      current.status = "running";
      current.dispatchBlocked = false;
      current.cancelRequested = false;
      current.cancelReason = null;
      current.failure = null;
      current.ownerId = ownerId;
      current.ownerPid = process.pid;
      current.reconcileRequired = false;
      return true;
    }, {
      detail: {
        phase: "resume",
        freshAdapter: nextAdapter !== undefined || pauseOwnerId !== ownerId,
        ownerId,
        ownerPid: process.pid
      }
    });
    const receipt = buildResumeTransitionReceipt({
      before: state,
      after: resumed,
      requestDigest: supplied.controlRequestDigest,
      freshAdapter: nextAdapter !== undefined || pauseOwnerId !== ownerId
    });
    if (publicRunner === null) {
      fail("EPLAN_RESUME_RECEIPT", "native plan runner identity was not initialized", "HOLD");
    }
    PLAN_RESUME_RECEIPTS.set(publicRunner, receipt);
    const resumedSnapshot = deepFreeze(clone(resumed));
    activeResumeLineage = {
      afterCheckpoint: resumedSnapshot,
      digests: new Set([resumed.stateDigest]),
      checkpoints: new Map([[resumed.stateDigest, resumedSnapshot]]),
      latestDigest: resumed.stateDigest,
      latestSequence: resumed.sequence
    };
    PLAN_RESUME_LINEAGES.set(publicRunner, activeResumeLineage);
    const execution = run();
    // resumeTransition intentionally returns at the transition boundary, so
    // callers that only need a control receipt do not wait for the whole DAG.
    // Mark the execution as observed to avoid an unhandled rejection when the
    // caller is only watching the transition and the later task fails.
    execution.catch(() => {});
    return { receipt, execution };
  }

  async function resume(resumeOptions = undefined) {
    const { execution } = await beginResume(resumeOptions);
    return execution;
  }

  async function resumeTransition(resumeOptions = undefined) {
    const { receipt } = await beginResume(resumeOptions);
    return receipt;
  }

  async function cancel(cancelOptions = undefined) {
    const supplied = exactOptions(cancelOptions, CANCEL_KEYS, "cancel options");
    const reason = supplied.reason ?? "cancel";
    if (!STOP_REASONS.has(reason)) fail("EPLAN_RUNNER_INPUT", "cancel reason is invalid");
    if (cancelPromise === null) {
      cancelPromise = (async () => {
        await markCancelRequested(reason);
        if (runPromise === null) await cancelRun();
        return readCheckpoint();
      })();
      cancelPromise.catch(() => {});
    }
    return cancelPromise;
  }

  async function inspect() {
    return readCheckpoint();
  }

  const runner = Object.freeze({
    schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
    kind: NATIVE_V3_PLAN_RUNNER_KIND,
    runId,
    planId: pinnedPlan.planId,
    planDigest: pinnedPlan.planDigest,
    contractDigest: pinnedPlan.contractDigest,
    run,
    execute: run,
    cancel,
    stop: cancel,
    pause,
    resume,
    resumeTransition,
    reconcile,
    inspect,
    readFailureCleanup,
    status: inspect
  });
  publicRunner = runner;
  TRUSTED_PLAN_RUNNERS.add(runner);
  TRUSTED_PLAN_RUNNER_REGISTRY.set(trustedRunnerRegistryKey(stateRoot, runId), new WeakRef(runner));
  return runner;
}

export default createNativeV3PlanRunner;
