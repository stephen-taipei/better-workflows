import { randomUUID } from "node:crypto";

import {
  digestObject,
  getStateRoot
} from "./core.mjs";
import {
  digestExecutionAdmission,
  validateExecutionAdmission
} from "./execution-admission-v1.mjs";
import {
  createIncidentReadPermissionV1,
  readIncidentV1,
  validateIncidentReportV1
} from "./incident-v1.mjs";
import {
  openExecutionRegistry,
  validateExecutionHandleV1,
  validateRecoveryPlanV1,
  validateStopReceiptV1
} from "./execution-runtime-v1.mjs";

export const INCIDENT_RECOVERY_SCHEMA_VERSION = 1;
export const INCIDENT_RECOVERY_PLAN_KIND = "IncidentRecoveryPlanV1";
export const INCIDENT_RECOVERY_RESULT_KIND = "IncidentRecoveryResultV1";
export const INCIDENT_RECOVERY_MAX_DEADLINE_MS = 2_000;
export const INCIDENT_RECOVERY_EFFECT_BINDING_KIND = "IncidentRecoveryEffectBindingV1";
export const INCIDENT_RECOVERY_LAUNCH_FENCE_KIND = "IncidentRecoveryLaunchFenceV1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PROOFS = new Set(["not-sent", "stop-stopped", "reconciled-not-sent", "cleanup-confirmed", "failed-sealed"]);
const PLAN_KEYS = [
  "schemaVersion", "kind", "recoveryId", "incidentId", "incidentRevision", "incidentDigest", "incidentSource",
  "runId", "handleId", "executionId", "unitId", "priorAttemptId", "newExecutionId", "newAttemptId",
  "sourceBindingDigest", "policyDigest", "revision", "ownedResourceId", "oldAuthorityEpoch", "oldFence",
  "oldIntentId", "oldIntentStatus", "oldIntentDigest", "oldAdmissionDigest", "oldBudgetDigest", "stopReceiptDigest",
  "reconciliationDigest", "cleanupResolutionDigest", "proof", "reason", "status", "preparedAt", "planDigest"
];

export class IncidentRecoveryError extends Error {
  constructor(code, message, status = "HOLD", details = undefined) {
    super(message);
    this.name = "IncidentRecoveryError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, status = "HOLD", details = undefined) {
  throw new IncidentRecoveryError(code, message, status, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail("EINCIDENT_RECOVERY_INPUT", `${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("EINCIDENT_RECOVERY_INPUT", `${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) fail("EINCIDENT_RECOVERY_INPUT", `${label} contains an accessor property`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Reflect.ownKeys(value).filter((key) => typeof key !== "string" || !allowed.has(key));
  if (unknown.length > 0) fail("EINCIDENT_RECOVERY_INPUT", `${label} contains unsupported fields`);
}

function requireKeys(value, keys, label) {
  for (const key of keys) if (!Object.hasOwn(value, key)) fail("EINCIDENT_RECOVERY_INPUT", `${label} requires ${key}`);
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("EINCIDENT_RECOVERY_INPUT", `${label} is invalid`);
  return value;
}

function assertDigest(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || !DIGEST.test(value)) fail("EINCIDENT_RECOVERY_INPUT", `${label} is invalid`);
  return value;
}

function assertRevision(value, label) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("EINCIDENT_RECOVERY_INPUT", `${label} is invalid`);
  }
  return value;
}

function assertIso(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail("EINCIDENT_RECOVERY_INPUT", `${label} is invalid`);
  return value;
}

function assertText(value, label) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("EINCIDENT_RECOVERY_INPUT", `${label} is invalid`);
  }
  return value;
}

function assertInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("EINCIDENT_RECOVERY_INPUT", `${label} is invalid`);
  return value;
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 4_096) fail("EINCIDENT_RECOVERY_INPUT", `${label} must be absolute`);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function deadlineMs(value) {
  return value === undefined
    ? INCIDENT_RECOVERY_MAX_DEADLINE_MS
    : assertInteger(value, "deadlineMs", 1, INCIDENT_RECOVERY_MAX_DEADLINE_MS);
}

function checkDeadline(deadline) {
  if (Date.now() > deadline) fail("EINCIDENT_RECOVERY_TIMEOUT", "incident recovery operation exceeded its bounded deadline", "UNKNOWN");
}

function sourceShape(value, label) {
  exactKeys(value, new Set(["revision", "digest", "scope"]), label);
  requireKeys(value, ["revision", "digest", "scope"], label);
  assertRevision(value.revision, `${label}.revision`);
  assertDigest(value.digest, `${label}.digest`);
  if (typeof value.scope !== "string" || value.scope.length === 0 || value.scope.length > 512 ||
      value.scope.startsWith("/") || value.scope.includes("\\") || value.scope.includes("//") || value.scope.split("/").includes("..")) {
    fail("EINCIDENT_RECOVERY_INPUT", `${label}.scope is invalid`);
  }
  return { revision: value.revision, digest: value.digest, scope: value.scope };
}

function validatePlan(value) {
  exactKeys(value, new Set(PLAN_KEYS), INCIDENT_RECOVERY_PLAN_KIND);
  requireKeys(value, PLAN_KEYS, INCIDENT_RECOVERY_PLAN_KIND);
  if (value.schemaVersion !== INCIDENT_RECOVERY_SCHEMA_VERSION || value.kind !== INCIDENT_RECOVERY_PLAN_KIND) {
    fail("EINCIDENT_RECOVERY_INPUT", "incident recovery plan kind or version is invalid");
  }
  for (const key of ["recoveryId", "incidentId", "runId", "handleId", "executionId", "unitId", "priorAttemptId", "newExecutionId", "newAttemptId", "ownedResourceId", "oldIntentId"]) {
    assertId(value[key], `${INCIDENT_RECOVERY_PLAN_KIND}.${key}`);
  }
  if (value.newAttemptId === value.priorAttemptId || value.newExecutionId === value.executionId) {
    fail("EINCIDENT_RECOVERY_INPUT", "incident recovery must use a new execution and attempt identity");
  }
  assertInteger(value.incidentRevision, `${INCIDENT_RECOVERY_PLAN_KIND}.incidentRevision`, 1, 64);
  assertDigest(value.incidentDigest, `${INCIDENT_RECOVERY_PLAN_KIND}.incidentDigest`);
  sourceShape(value.incidentSource, `${INCIDENT_RECOVERY_PLAN_KIND}.incidentSource`);
  assertDigest(value.sourceBindingDigest, `${INCIDENT_RECOVERY_PLAN_KIND}.sourceBindingDigest`);
  assertDigest(value.policyDigest, `${INCIDENT_RECOVERY_PLAN_KIND}.policyDigest`);
  assertRevision(value.revision, `${INCIDENT_RECOVERY_PLAN_KIND}.revision`);
  assertInteger(value.oldAuthorityEpoch, `${INCIDENT_RECOVERY_PLAN_KIND}.oldAuthorityEpoch`, 0, Number.MAX_SAFE_INTEGER);
  assertDigest(value.oldFence, `${INCIDENT_RECOVERY_PLAN_KIND}.oldFence`);
  assertDigest(value.oldIntentDigest, `${INCIDENT_RECOVERY_PLAN_KIND}.oldIntentDigest`);
  assertDigest(value.oldAdmissionDigest, `${INCIDENT_RECOVERY_PLAN_KIND}.oldAdmissionDigest`);
  assertDigest(value.oldBudgetDigest, `${INCIDENT_RECOVERY_PLAN_KIND}.oldBudgetDigest`);
  assertDigest(value.stopReceiptDigest, `${INCIDENT_RECOVERY_PLAN_KIND}.stopReceiptDigest`, { nullable: true });
  assertDigest(value.reconciliationDigest, `${INCIDENT_RECOVERY_PLAN_KIND}.reconciliationDigest`, { nullable: true });
  assertDigest(value.cleanupResolutionDigest, `${INCIDENT_RECOVERY_PLAN_KIND}.cleanupResolutionDigest`, { nullable: true });
  if (!PROOFS.has(value.proof)) fail("EINCIDENT_RECOVERY_INPUT", `${INCIDENT_RECOVERY_PLAN_KIND}.proof is invalid`);
  if (!["cancelled", "not-sent", "unknown", "sealed"].includes(value.oldIntentStatus)) fail("EINCIDENT_RECOVERY_INPUT", `${INCIDENT_RECOVERY_PLAN_KIND}.oldIntentStatus is invalid`);
  assertText(value.reason, `${INCIDENT_RECOVERY_PLAN_KIND}.reason`);
  if (value.status !== "prepared") fail("EINCIDENT_RECOVERY_INPUT", `${INCIDENT_RECOVERY_PLAN_KIND}.status is invalid`);
  assertIso(value.preparedAt, `${INCIDENT_RECOVERY_PLAN_KIND}.preparedAt`);
  assertDigest(value.planDigest, `${INCIDENT_RECOVERY_PLAN_KIND}.planDigest`);
  const body = Object.fromEntries(PLAN_KEYS.filter((key) => key !== "planDigest").map((key) => [key, value[key]]));
  if (digestObject(body) !== value.planDigest) fail("EINCIDENT_RECOVERY_INTEGRITY", "incident recovery plan digest is stale");
  if (value.proof === "not-sent" && value.oldIntentStatus !== "not-sent") fail("EINCIDENT_RECOVERY_INPUT", "not-sent proof is not bound to a not-sent intent");
  if (["reconciled-not-sent", "cleanup-confirmed"].includes(value.proof) && value.oldIntentStatus !== "unknown") fail("EINCIDENT_RECOVERY_INPUT", "unknown recovery proof is not bound to an unknown intent");
  if (value.proof === "failed-sealed" && value.oldIntentStatus !== "sealed") fail("EINCIDENT_RECOVERY_INPUT", "failed recovery proof is not bound to a sealed intent");
  if (value.proof === "stop-stopped" && value.stopReceiptDigest === null) fail("EINCIDENT_RECOVERY_INPUT", "stopped recovery proof has no stop receipt");
  if (value.proof === "reconciled-not-sent" && value.reconciliationDigest === null) fail("EINCIDENT_RECOVERY_INPUT", "reconciled recovery proof has no reconciliation");
  if (value.proof === "cleanup-confirmed" && value.cleanupResolutionDigest === null) fail("EINCIDENT_RECOVERY_INPUT", "cleanup recovery proof has no cleanup resolution");
  return freezeDeep(clone(value));
}

export function validateIncidentRecoveryPlanV1(value) {
  return validatePlan(value);
}

function recoveryOptions(options, label, required) {
  assertPlainObject(options, label);
  const allowed = new Set([
    "stateRoot", "incidentId", "incidentRevision", "incidentDigest", "runId", "handleId", "newExecutionId", "newAttemptId",
    "reason", "controller", "resourceAdapter", "deadlineMs", "plan"
  ]);
  exactKeys(options, allowed, label);
  requireKeys(options, required, label);
  assertAbsolutePath(options.stateRoot ?? getStateRoot(), `${label}.stateRoot`);
  if (options.incidentId !== undefined) assertId(options.incidentId, `${label}.incidentId`);
  if (options.incidentRevision !== undefined) assertInteger(options.incidentRevision, `${label}.incidentRevision`, 1, 64);
  if (options.incidentDigest !== undefined) assertDigest(options.incidentDigest, `${label}.incidentDigest`);
  if (options.runId !== undefined) assertId(options.runId, `${label}.runId`);
  if (options.handleId !== undefined) assertId(options.handleId, `${label}.handleId`);
  if (options.newExecutionId !== undefined) assertId(options.newExecutionId, `${label}.newExecutionId`);
  if (options.newAttemptId !== undefined) assertId(options.newAttemptId, `${label}.newAttemptId`);
  if (options.reason !== undefined) assertText(options.reason, `${label}.reason`);
  if (options.deadlineMs !== undefined) deadlineMs(options.deadlineMs);
  return options;
}

async function openRegistry(options, runId) {
  try {
    return await openExecutionRegistry({
      stateRoot: options.stateRoot,
      runId,
      controller: options.controller,
      resourceAdapter: options.resourceAdapter ?? null
    });
  } catch (error) {
    if (error instanceof IncidentRecoveryError) throw error;
    fail("EINCIDENT_RECOVERY_AUTHORITY", "incident recovery requires a trusted execution controller", "HOLD", { cause: error?.code ?? "unknown" });
  }
}

async function readCurrentIncident(options, incidentId, incidentRevision, deadline) {
  checkDeadline(deadline);
  let result;
  try {
    const permission = createIncidentReadPermissionV1({ stateRoot: options.stateRoot, incidentId, revision: incidentRevision });
    result = await readIncidentV1({ stateRoot: options.stateRoot, incidentId, permission, deadlineMs: Math.min(deadline - Date.now(), INCIDENT_RECOVERY_MAX_DEADLINE_MS) });
  } catch (error) {
    if (error instanceof IncidentRecoveryError) throw error;
    fail("EINCIDENT_RECOVERY_INCIDENT", "incident report could not be read for recovery", "HOLD", { cause: error?.code ?? "unknown" });
  }
  checkDeadline(deadline);
  if (result.latestRevision !== incidentRevision || result.incident.revision !== incidentRevision || result.incidentDigest !== result.incident.revisionDigest) {
    fail("EINCIDENT_RECOVERY_STALE", "incident recovery requires the current incident revision", "HOLD");
  }
  if (options.incidentDigest !== undefined && result.incidentDigest !== options.incidentDigest) {
    fail("EINCIDENT_RECOVERY_STALE", "incident recovery incident digest is stale", "HOLD");
  }
  return validateIncidentReportV1(result.incident, { deadlineMs: Math.min(deadline - Date.now(), INCIDENT_RECOVERY_MAX_DEADLINE_MS) });
}

function intentFor(state, handleId) {
  const intents = Object.values(state.intents ?? {}).filter((item) => item.handleId === handleId &&
    ["cancelled", "pending", "dispatching", "not-sent", "sealed", "unknown"].includes(item.status));
  if (intents.length !== 1) fail("EINCIDENT_RECOVERY_INTENT", "incident recovery requires exactly one current execution intent", "HOLD");
  return intents[0];
}

function stopReceiptFor(state, handleId) {
  const receipts = Object.values(state.stopReceipts ?? {}).filter((item) => item.handleId === handleId);
  if (receipts.length === 0) return null;
  receipts.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  return receipts.at(-1);
}

function cleanupResolutionFor(intent) {
  return intent.cleanupResolution ?? null;
}

function latestReconciliationFor(intent) {
  return Array.isArray(intent.reconciliation) && intent.reconciliation.length > 0
    ? intent.reconciliation.at(-1)
    : null;
}

function sameBinding(handle, incident, runId) {
  return handle.runId === runId && handle.revision === incident.source.revision &&
    handle.sourceBindingDigest === incident.source.digest && typeof handle.policyDigest === "string";
}

function retryableReconciliation(value, handle, intent) {
  return value?.decision === "retryable" && value.intentId === intent.intentId && value.handleId === handle.handleId &&
    value.runId === handle.runId && value.observation?.controllerStatus === "terminated" &&
    value.observation?.providerOutcome === "not-sent" && value.observation?.businessOutcome === null;
}


function admissionFor(state, handle) {
  if (handle.admissionDigest === undefined) {
    fail("EINCIDENT_RECOVERY_ADMISSION", "V5 incident recovery requires a current typed execution admission", "HOLD");
  }
  const supplied = state.admissions?.[handle.handleId];
  if (!supplied) {
    fail("EINCIDENT_RECOVERY_ADMISSION", "the durable execution admission is missing", "HOLD");
  }
  let admission;
  try {
    admission = validateExecutionAdmission(supplied);
  } catch (error) {
    fail("EINCIDENT_RECOVERY_ADMISSION", "the durable execution admission is invalid", "HOLD", { cause: error?.message ?? "invalid" });
  }
  if (digestExecutionAdmission(admission) !== handle.admissionDigest ||
      admission.runId !== handle.runId || admission.executionId !== handle.executionId ||
      admission.attemptId !== handle.attemptId || admission.unitId !== handle.unitId ||
      admission.ownedResourceId !== handle.ownedResourceId ||
      admission.sourceBindingDigest !== handle.sourceBindingDigest ||
      admission.policyDigest !== handle.policyDigest || admission.revision !== handle.revision ||
      admission.authorityEpoch !== handle.authorityEpoch || admission.fence !== handle.fence) {
    fail("EINCIDENT_RECOVERY_ADMISSION", "the durable execution admission is not bound to its handle", "HOLD");
  }
  return admission;
}

function stableAdmissionProjection(value) {
  return Object.fromEntries([
    "planDigest", "contractDigest", "sourceBindingDigest", "policyDigest", "revision", "taskId", "unitId",
    "ownedResourceId", "scope", "recipient", "action", "budget", "requestedModel"
  ].filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

function assertFreshAdmissionContinuity(plan, priorAdmission, state, handle) {
  const freshAdmission = admissionFor(state, handle);
  if (freshAdmission.runId !== plan.runId || freshAdmission.executionId !== plan.newExecutionId ||
      freshAdmission.attemptId !== plan.newAttemptId || freshAdmission.unitId !== plan.unitId ||
      freshAdmission.ownedResourceId !== plan.ownedResourceId ||
      digestObject(stableAdmissionProjection(freshAdmission)) !== digestObject(stableAdmissionProjection(priorAdmission)) ||
      digestObject(freshAdmission.budget) !== plan.oldBudgetDigest) {
    fail("EINCIDENT_RECOVERY_BUDGET", "fresh V3 admission does not preserve the recovery plan budget and scope", "HOLD");
  }
  return freshAdmission;
}

function classifySnapshot(state, handleId) {
  const handle = state.handles?.[handleId];
  if (!handle) fail("EINCIDENT_RECOVERY_HANDLE", "incident recovery execution handle is absent", "HOLD");
  validateExecutionHandleV1(handle);
  const admission = admissionFor(state, handle);
  const intent = intentFor(state, handleId);
  const stopReceipt = stopReceiptFor(state, handleId);
  if (stopReceipt) validateStopReceiptV1(stopReceipt);
  const reconciliation = latestReconciliationFor(intent);
  const cleanupResolution = cleanupResolutionFor(intent);
  let proof;
  // Read intent outcome before handle status. Physical STOPPED and owned
  // cleanup cannot turn an unresolved external effect into a retry.
  if (intent.status === "unknown") {
    if (["indeterminate", "stopped", "revoked"].includes(handle.status) &&
        retryableReconciliation(reconciliation, handle, intent)) proof = "reconciled-not-sent";
    else fail("EINCIDENT_RECOVERY_UNKNOWN", "incident recovery is blocked by an unresolved UNKNOWN execution", "UNKNOWN");
  } else if (["pending", "dispatching"].includes(intent.status)) {
    fail("EINCIDENT_RECOVERY_UNKNOWN", "incident recovery is blocked by an in-flight execution", "UNKNOWN");
  } else if (handle.status === "ready" && intent.status === "not-sent" && intent.callbackCalls === 0 && intent.dispatchReserved === false) {
    proof = "not-sent";
  } else if (["stopped", "revoked"].includes(handle.status) && stopReceipt?.outcome === "STOPPED" && stopReceipt.confirmedOwnedScope === true) {
    proof = "stop-stopped";
  } else if (handle.status === "failed" && intent.status === "sealed" && intent.outcome === "failure") {
    proof = "failed-sealed";
  } else {
    fail("EINCIDENT_RECOVERY_STATE", "incident recovery requires a stopped, failed, or proven-not-sent execution", "HOLD");
  }
  return { handle, admission, intent, stopReceipt, reconciliation, cleanupResolution, proof };
}

async function readFreshSourceAndPolicy(options, handle, incident, deadline, expectedAdmission = null) {
  checkDeadline(deadline);
  const controller = options.controller;
  if (!controller || typeof controller.readRunContract !== "function" || typeof controller.readSourceBinding !== "function") {
    fail("EINCIDENT_RECOVERY_AUTHORITY", "incident recovery requires a trusted source and policy observation", "HOLD");
  }
  let runContract;
  let sourceBinding;
  try {
    [runContract, sourceBinding] = await Promise.all([
      controller.readRunContract({ runId: handle.runId }),
      controller.readSourceBinding({ runId: handle.runId })
    ]);
  } catch (error) {
    fail("EINCIDENT_RECOVERY_SOURCE", "current source binding could not be observed", "HOLD", { cause: error?.code ?? "unknown" });
  }
  checkDeadline(deadline);
  assertPlainObject(runContract, "current run contract");
  assertPlainObject(sourceBinding, "current source binding");
  if (runContract.runId !== handle.runId || runContract.revision !== handle.revision ||
      runContract.sourceBindingDigest !== handle.sourceBindingDigest || runContract.policyDigest !== handle.policyDigest) {
    fail("EINCIDENT_RECOVERY_SOURCE", "current run source or policy binding changed", "HOLD");
  }
  if (expectedAdmission &&
      (runContract.planDigest !== expectedAdmission.planDigest || runContract.contractDigest !== expectedAdmission.contractDigest)) {
    fail("EINCIDENT_RECOVERY_BUDGET", "current V3 plan or contract changed during recovery", "HOLD");
  }
  const observedDigest = sourceBinding.digest ?? sourceBinding.sourceBindingDigest;
  if (sourceBinding.runId !== undefined && sourceBinding.runId !== handle.runId ||
      sourceBinding.revision !== handle.revision || observedDigest !== handle.sourceBindingDigest ||
      incident.source.revision !== handle.revision || incident.source.digest !== handle.sourceBindingDigest) {
    fail("EINCIDENT_RECOVERY_SOURCE", "incident source binding is stale", "HOLD");
  }
  return freezeDeep({ revision: handle.revision, sourceBindingDigest: handle.sourceBindingDigest, policyDigest: handle.policyDigest });
}

function planFromSnapshot({ incident, state, snapshot, runId, incidentId, nextExecutionId, nextAttemptId, reason }) {
  const handle = snapshot.handle;
  const intent = snapshot.intent;
  const plan = {
    schemaVersion: INCIDENT_RECOVERY_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_PLAN_KIND,
    recoveryId: randomUUID(),
    incidentId,
    incidentRevision: incident.revision,
    incidentDigest: incident.revisionDigest,
    incidentSource: clone(incident.source),
    runId,
    handleId: handle.handleId,
    executionId: handle.executionId,
    unitId: handle.unitId,
    priorAttemptId: handle.attemptId,
    newExecutionId: nextExecutionId,
    newAttemptId: nextAttemptId,
    sourceBindingDigest: handle.sourceBindingDigest,
    policyDigest: handle.policyDigest,
    revision: handle.revision,
    ownedResourceId: handle.ownedResourceId,
    oldAuthorityEpoch: handle.authorityEpoch,
    oldFence: handle.fence,
    oldIntentId: intent.intentId,
    oldIntentStatus: intent.status,
    oldIntentDigest: digestObject(intent),
    oldAdmissionDigest: handle.admissionDigest,
    oldBudgetDigest: digestObject(snapshot.admission.budget),
    stopReceiptDigest: snapshot.stopReceipt ? digestObject(snapshot.stopReceipt) : null,
    reconciliationDigest: snapshot.reconciliation ? digestObject(snapshot.reconciliation) : null,
    cleanupResolutionDigest: snapshot.cleanupResolution ? digestObject(snapshot.cleanupResolution) : null,
    proof: snapshot.proof,
    reason,
    status: "prepared",
    preparedAt: new Date().toISOString()
  };
  plan.planDigest = digestObject(plan);
  return validatePlan(plan);
}

function assertPlanMatchesSnapshot(plan, incident, snapshot) {
  const handle = snapshot.handle;
  const intent = snapshot.intent;
  const expected = {
    incidentId: incident.incidentId,
    incidentRevision: incident.revision,
    incidentDigest: incident.revisionDigest,
    incidentSource: incident.source,
    runId: handle.runId,
    handleId: handle.handleId,
    executionId: handle.executionId,
    unitId: handle.unitId,
    priorAttemptId: handle.attemptId,
    sourceBindingDigest: handle.sourceBindingDigest,
    policyDigest: handle.policyDigest,
    revision: handle.revision,
    ownedResourceId: handle.ownedResourceId,
    oldAuthorityEpoch: handle.authorityEpoch,
    oldFence: handle.fence,
    oldIntentId: intent.intentId,
    oldIntentStatus: intent.status,
    oldIntentDigest: digestObject(intent),
    oldAdmissionDigest: handle.admissionDigest,
    oldBudgetDigest: digestObject(snapshot.admission.budget),
    stopReceiptDigest: snapshot.stopReceipt ? digestObject(snapshot.stopReceipt) : null,
    reconciliationDigest: snapshot.reconciliation ? digestObject(snapshot.reconciliation) : null,
    cleanupResolutionDigest: snapshot.cleanupResolution ? digestObject(snapshot.cleanupResolution) : null,
    proof: snapshot.proof
  };
  for (const [key, value] of Object.entries(expected)) {
    if (digestObject(plan[key]) !== digestObject(value)) fail("EINCIDENT_RECOVERY_STALE", `incident recovery ${key} changed`, "HOLD");
  }
}

/**
 * Derive the digest that the existing cooperative owner-approval request
 * seals for an incident recovery launch.  The command digest alone describes
 * the executable payload; a recovery launch must also commit to the
 * immutable, incident-bound recovery plan.  This is a digest projection only
 * and never grants authority or turns caller data into an attestation.
 */
export function incidentRecoveryEffectBindingDigestV1(options = {}) {
  assertPlainObject(options, "incidentRecoveryEffectBindingDigestV1 options");
  exactKeys(options, new Set(["commandDigest", "recoveryPlanDigest"]), "incidentRecoveryEffectBindingDigestV1 options");
  requireKeys(options, ["commandDigest", "recoveryPlanDigest"], "incidentRecoveryEffectBindingDigestV1 options");
  const commandDigest = assertDigest(options.commandDigest, "commandDigest");
  const recoveryPlanDigest = assertDigest(options.recoveryPlanDigest, "recoveryPlanDigest");
  return digestObject({
    schemaVersion: INCIDENT_RECOVERY_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_EFFECT_BINDING_KIND,
    commandDigest,
    recoveryPlanDigest
  });
}

/**
 * Bind a recovery launch to the exact incident revision that was approved.
 * This is a typed descriptor only. It carries no owner authority; the
 * cooperative controller still verifies the opaque owner decision and uses
 * the incident store's revision fence at the final launch boundary.
 */
export function deriveIncidentRecoveryLaunchFenceV1(options = {}) {
  assertPlainObject(options, "deriveIncidentRecoveryLaunchFenceV1 options");
  exactKeys(options, new Set(["plan", "commandDigest", "effectBindingDigest"]), "deriveIncidentRecoveryLaunchFenceV1 options");
  requireKeys(options, ["plan", "commandDigest", "effectBindingDigest"], "deriveIncidentRecoveryLaunchFenceV1 options");
  const plan = validatePlan(options.plan);
  const commandDigest = assertDigest(options.commandDigest, "commandDigest");
  const effectBindingDigest = assertDigest(options.effectBindingDigest, "effectBindingDigest");
  if (incidentRecoveryEffectBindingDigestV1({ commandDigest, recoveryPlanDigest: plan.planDigest }) !== effectBindingDigest) {
    fail("EINCIDENT_RECOVERY_BINDING", "incident recovery launch fence effect binding is not canonical", "HOLD");
  }
  return freezeDeep({
    schemaVersion: INCIDENT_RECOVERY_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_LAUNCH_FENCE_KIND,
    recoveryPlanDigest: plan.planDigest,
    commandDigest,
    incidentId: plan.incidentId,
    incidentRevision: plan.incidentRevision,
    incidentDigest: plan.incidentDigest,
    effectBindingDigest
  });
}

export function validateIncidentRecoveryLaunchFenceV1(value) {
  assertPlainObject(value, "incident recovery launch fence");
  exactKeys(value, new Set([
    "schemaVersion", "kind", "recoveryPlanDigest", "commandDigest", "incidentId", "incidentRevision", "incidentDigest", "effectBindingDigest"
  ]), "incident recovery launch fence");
  requireKeys(value, [
    "schemaVersion", "kind", "recoveryPlanDigest", "commandDigest", "incidentId", "incidentRevision", "incidentDigest", "effectBindingDigest"
  ], "incident recovery launch fence");
  if (value.schemaVersion !== INCIDENT_RECOVERY_SCHEMA_VERSION || value.kind !== INCIDENT_RECOVERY_LAUNCH_FENCE_KIND) {
    fail("EINCIDENT_RECOVERY_INPUT", "incident recovery launch fence kind or version is invalid");
  }
  const normalized = {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    recoveryPlanDigest: assertDigest(value.recoveryPlanDigest, "incident recovery launch fence.recoveryPlanDigest"),
    commandDigest: assertDigest(value.commandDigest, "incident recovery launch fence.commandDigest"),
    incidentId: assertId(value.incidentId, "incident recovery launch fence.incidentId"),
    incidentRevision: assertInteger(value.incidentRevision, "incident recovery launch fence.incidentRevision", 1, 64),
    incidentDigest: assertDigest(value.incidentDigest, "incident recovery launch fence.incidentDigest"),
    effectBindingDigest: assertDigest(value.effectBindingDigest, "incident recovery launch fence.effectBindingDigest")
  };
  if (incidentRecoveryEffectBindingDigestV1({
    commandDigest: normalized.commandDigest,
    recoveryPlanDigest: normalized.recoveryPlanDigest
  }) !== normalized.effectBindingDigest) {
    fail("EINCIDENT_RECOVERY_BINDING", "incident recovery launch fence effect binding is not canonical", "HOLD");
  }
  return freezeDeep(normalized);
}

/**
 * Assert the cross-domain binding used by the native command runner's
 * single-resume path.  This helper is intentionally an assertion only: it
 * does not create an authority, consume an owner decision, or launch an
 * effect.  The command runner still obtains its fresh owner decision and
 * admission through the cooperative controller before it calls the runtime.
 */
export function assertIncidentRecoveryCommandBindingV1(options = {}) {
  assertPlainObject(options, "assertIncidentRecoveryCommandBindingV1 options");
  exactKeys(options, new Set([
    "plan", "workflowPlan", "approvalEnvelope", "commandBinding", "sourceBinding", "policyDigest",
    "runId", "taskId", "unitId", "ownerDecision"
  ]), "assertIncidentRecoveryCommandBindingV1 options");
  requireKeys(options, [
    "plan", "workflowPlan", "approvalEnvelope", "commandBinding", "sourceBinding", "policyDigest",
    "runId", "taskId", "unitId", "ownerDecision"
  ], "assertIncidentRecoveryCommandBindingV1 options");
  const plan = validatePlan(options.plan);
  const workflowPlan = assertPlainObject(options.workflowPlan, "workflowPlan");
  const approvalEnvelope = assertPlainObject(options.approvalEnvelope, "approvalEnvelope");
  const commandBinding = assertPlainObject(options.commandBinding, "commandBinding");
  const ownerDecision = assertPlainObject(options.ownerDecision, "ownerDecision");
  const sourceValue = assertPlainObject(options.sourceBinding, "sourceBinding");
  exactKeys(sourceValue, new Set(["revision", "digest"]), "sourceBinding");
  const source = {
    revision: assertRevision(sourceValue.revision, "sourceBinding.revision"),
    digest: assertDigest(sourceValue.digest, "sourceBinding.digest")
  };
  const policyDigest = assertDigest(options.policyDigest, "policyDigest");
  const runId = assertId(options.runId, "runId");
  const taskId = assertId(options.taskId, "taskId");
  const unitId = assertId(options.unitId, "unitId");

  if (plan.runId !== runId || plan.unitId !== unitId || plan.sourceBindingDigest !== source.digest ||
      plan.revision !== source.revision || plan.policyDigest !== policyDigest) {
    fail("EINCIDENT_RECOVERY_BINDING", "incident recovery plan is not bound to the current source, policy, or run", "HOLD");
  }
  if (approvalEnvelope.runId !== plan.runId || approvalEnvelope.executionId !== plan.newExecutionId ||
      approvalEnvelope.attemptId !== plan.newAttemptId || approvalEnvelope.unitId !== plan.unitId ||
      approvalEnvelope.ownedResourceId !== plan.ownedResourceId ||
      approvalEnvelope.planDigest !== workflowPlan.planDigest ||
      approvalEnvelope.contractDigest !== workflowPlan.contractDigest ||
      approvalEnvelope.sourceBindingDigest !== source.digest || approvalEnvelope.policyDigest !== policyDigest ||
      approvalEnvelope.revision !== source.revision ||
      digestObject(approvalEnvelope.budget) !== plan.oldBudgetDigest) {
    fail("EINCIDENT_RECOVERY_BINDING", "fresh approval is not bound to the incident recovery plan", "HOLD");
  }
  if (commandBinding.planDigest !== workflowPlan.planDigest ||
      commandBinding.contractDigest !== workflowPlan.contractDigest || commandBinding.taskId !== taskId ||
      commandBinding.unitId !== unitId || commandBinding.sourceBindingDigest !== source.digest ||
      commandBinding.policyDigest !== policyDigest || commandBinding.revision !== source.revision ||
      commandBinding.approvalEnvelopeDigest !== approvalEnvelope.digest ||
      typeof commandBinding.commandDigest !== "string" || !DIGEST.test(commandBinding.commandDigest)) {
    fail("EINCIDENT_RECOVERY_BINDING", "native command binding is not bound to the incident recovery approval", "HOLD");
  }
  const effectBindingDigest = incidentRecoveryEffectBindingDigestV1({
    commandDigest: commandBinding.commandDigest,
    recoveryPlanDigest: plan.planDigest
  });
  if (ownerDecision.effectBindingDigest !== effectBindingDigest) {
    fail("EINCIDENT_RECOVERY_BINDING", "opaque owner decision is not sealed to the incident recovery effect", "HOLD");
  }
  return freezeDeep({
    recoveryPlanDigest: plan.planDigest,
    incidentId: plan.incidentId,
    incidentRevision: plan.incidentRevision,
    incidentDigest: plan.incidentDigest,
    oldHandleId: plan.handleId,
    newExecutionId: plan.newExecutionId,
    newAttemptId: plan.newAttemptId,
    commandDigest: commandBinding.commandDigest,
    effectBindingDigest,
    approvalEnvelopeDigest: approvalEnvelope.digest,
    sourceBindingDigest: source.digest,
    policyDigest
  });
}

/**
 * Read the current incident revision for a runner launch boundary.  The
 * returned report is local advisory data; it is never an owner decision or a
 * replacement for the runtime's fresh admission check.
 */
export async function readIncidentRecoveryReportV1(options = {}) {
  assertPlainObject(options, "readIncidentRecoveryReportV1 options");
  exactKeys(options, new Set(["stateRoot", "plan", "deadlineMs"]), "readIncidentRecoveryReportV1 options");
  requireKeys(options, ["stateRoot", "plan"], "readIncidentRecoveryReportV1 options");
  const stateRoot = assertAbsolutePath(options.stateRoot, "stateRoot");
  const plan = validatePlan(options.plan);
  const ms = deadlineMs(options.deadlineMs);
  const deadline = Date.now() + ms;
  const incident = await readCurrentIncident({ stateRoot }, plan.incidentId, plan.incidentRevision, deadline);
  return freezeDeep({
    incidentId: plan.incidentId,
    incidentRevision: plan.incidentRevision,
    incidentDigest: incident.revisionDigest,
    incident
  });
}

/**
 * Validate the old execution snapshot immediately before a single runtime
 * resume.  This is deliberately a pure check over a snapshot supplied by a
 * trusted registry read; it cannot mint a handle or authorize an effect.
 */
export function assertIncidentRecoveryRuntimeSnapshotV1(options = {}) {
  assertPlainObject(options, "assertIncidentRecoveryRuntimeSnapshotV1 options");
  exactKeys(options, new Set(["plan", "state", "incident"]), "assertIncidentRecoveryRuntimeSnapshotV1 options");
  requireKeys(options, ["plan", "state", "incident"], "assertIncidentRecoveryRuntimeSnapshotV1 options");
  const plan = validatePlan(options.plan);
  const state = assertPlainObject(options.state, "execution state");
  const incident = validateIncidentReportV1(options.incident);
  const snapshot = classifySnapshot(state, plan.handleId);
  if (!sameBinding(snapshot.handle, incident, plan.runId)) {
    fail("EINCIDENT_RECOVERY_SOURCE", "incident and execution source bindings do not match", "HOLD");
  }
  assertPlanMatchesSnapshot(plan, incident, snapshot);
  return freezeDeep(clone(snapshot));
}

async function currentVerifiedContext(options, plan) {
  const verifiedPlan = validatePlan(plan);
  const ms = deadlineMs(options.deadlineMs);
  const deadline = Date.now() + ms;
  const incident = await readCurrentIncident(options, verifiedPlan.incidentId, verifiedPlan.incidentRevision, deadline);
  const registry = await openRegistry(options, verifiedPlan.runId);
  const state = await registry.load({ reconcile: false });
  const snapshot = classifySnapshot(state, verifiedPlan.handleId);
  if (!sameBinding(snapshot.handle, incident, verifiedPlan.runId)) fail("EINCIDENT_RECOVERY_SOURCE", "incident and execution source bindings do not match", "HOLD");
  assertPlanMatchesSnapshot(verifiedPlan, incident, snapshot);
  const freshSource = await readFreshSourceAndPolicy(options, snapshot.handle, incident, deadline, snapshot.admission);
  const after = await registry.load({ reconcile: false });
  const afterSnapshot = classifySnapshot(after, verifiedPlan.handleId);
  assertPlanMatchesSnapshot(verifiedPlan, incident, afterSnapshot);
  return { plan: verifiedPlan, incident, registry, state: after, snapshot: afterSnapshot, freshSource, deadline };
}

export async function prepareIncidentRecoveryV1(options = {}) {
  recoveryOptions(options, "prepareIncidentRecoveryV1", ["stateRoot", "incidentId", "incidentRevision", "runId", "handleId", "newExecutionId", "newAttemptId", "controller"]);
  if (options.newExecutionId === options.newAttemptId) fail("EINCIDENT_RECOVERY_INPUT", "new execution and attempt identities must differ");
  const reason = options.reason ?? "incident recovery";
  const ms = deadlineMs(options.deadlineMs);
  const deadline = Date.now() + ms;
  const incident = await readCurrentIncident(options, options.incidentId, options.incidentRevision, deadline);
  const registry = await openRegistry(options, options.runId);
  const state = await registry.load({ reconcile: false });
  const snapshot = classifySnapshot(state, options.handleId);
  if (!sameBinding(snapshot.handle, incident, options.runId)) fail("EINCIDENT_RECOVERY_SOURCE", "incident and execution source bindings do not match", "HOLD");
  await readFreshSourceAndPolicy(options, snapshot.handle, incident, deadline, snapshot.admission);
  checkDeadline(deadline);
  const plan = planFromSnapshot({
    incident,
    state,
    snapshot,
    runId: options.runId,
    incidentId: options.incidentId,
    nextExecutionId: options.newExecutionId,
    nextAttemptId: options.newAttemptId,
    reason
  });
  return freezeDeep({
    schemaVersion: INCIDENT_RECOVERY_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_RESULT_KIND,
    ok: true,
    status: "prepared",
    recoveryId: plan.recoveryId,
    plan
  });
}

export async function verifyIncidentRecoveryV1(options = {}) {
  recoveryOptions(options, "verifyIncidentRecoveryV1", ["stateRoot", "plan", "controller"]);
  const context = await currentVerifiedContext(options, options.plan);
  return freezeDeep({
    schemaVersion: INCIDENT_RECOVERY_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_RESULT_KIND,
    ok: true,
    valid: true,
    status: "verified",
    recoveryId: context.plan.recoveryId,
    planDigest: context.plan.planDigest,
    proof: context.plan.proof,
    sourceBindingDigest: context.freshSource.sourceBindingDigest,
    policyDigest: context.freshSource.policyDigest,
    authority: "verification-only; fresh admission is required for resume"
  });
}

export async function resumeIncidentRecoveryV1(options = {}) {
  recoveryOptions(options, "resumeIncidentRecoveryV1", ["stateRoot", "plan", "controller"]);
  const context = await currentVerifiedContext(options, options.plan);
  if (["reconciled-not-sent", "cleanup-confirmed"].includes(context.plan.proof) && context.snapshot.intent.status !== "unknown") {
    fail("EINCIDENT_RECOVERY_UNKNOWN", "incident recovery proof is no longer an UNKNOWN execution", "UNKNOWN");
  }
  let resumed;
  try {
    resumed = await context.registry.resumeExecution(context.plan.handleId, {
      executionId: context.plan.newExecutionId,
      attemptId: context.plan.newAttemptId,
      reason: context.plan.reason
    });
  } catch (error) {
    if (error?.status === "UNKNOWN" || error?.code === "EEXECUTION_RECONCILIATION_REQUIRED") {
      fail("EINCIDENT_RECOVERY_UNKNOWN", "incident recovery could not establish a fresh trusted execution", "UNKNOWN", { cause: error?.code ?? "unknown" });
    }
    fail("EINCIDENT_RECOVERY_RESUME", "incident recovery could not create a fresh trusted execution", "HOLD", { cause: error?.code ?? "unknown" });
  }
  const handle = validateExecutionHandleV1(resumed.handle);
  const runtimePlan = validateRecoveryPlanV1(resumed.recoveryPlan);
  if (runtimePlan.fromHandleId !== context.plan.handleId || runtimePlan.priorAttemptId !== context.plan.priorAttemptId ||
      runtimePlan.newAttemptId !== context.plan.newAttemptId || runtimePlan.executionId !== context.plan.newExecutionId ||
      runtimePlan.sourceBindingDigest !== context.plan.sourceBindingDigest || runtimePlan.policyDigest !== context.plan.policyDigest ||
      runtimePlan.revision !== context.plan.revision || runtimePlan.oldAuthorityEpoch !== context.plan.oldAuthorityEpoch ||
      runtimePlan.oldFence !== context.plan.oldFence || handle.authorityEpoch <= context.plan.oldAuthorityEpoch ||
      handle.fence === context.plan.oldFence || handle.admissionDigest === undefined && context.plan.oldAdmissionDigest !== null) {
    fail("EINCIDENT_RECOVERY_BINDING", "fresh runtime recovery is not bound to the incident recovery plan", "HOLD");
  }
  let resumedState;
  try {
    resumedState = await context.registry.load({ reconcile: false });
  } catch (error) {
    fail("EINCIDENT_RECOVERY_ADMISSION", "fresh runtime admission could not be read back", "HOLD", { cause: error?.code ?? "unknown" });
  }
  const freshAdmission = assertFreshAdmissionContinuity(context.plan, context.snapshot.admission, resumedState, handle);
  return freezeDeep({
    schemaVersion: INCIDENT_RECOVERY_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_RESULT_KIND,
    ok: true,
    status: "resumed",
    recoveryId: context.plan.recoveryId,
    planDigest: context.plan.planDigest,
    admissionDigest: digestExecutionAdmission(freshAdmission),
    budgetContinuity: "typed admission budget is unchanged; provider quota and usage remain unobserved",
    handle,
    recoveryPlan: runtimePlan,
    effect: "not-launched; caller must use the trusted native runner"
  });
}
