import {
  canonicalJson,
  digestObject
} from "./core.mjs";
import {
  validateExecutionBudgetLedgerV1
} from "./execution-budget-ledger-v1.mjs";
import {
  validateIncidentReportV1
} from "./incident-v1.mjs";
import {
  validateNativeV3PlanRunnerCheckpointV1
} from "./native-v3-plan-runner-core.mjs";
import {
  validateExecutionRegistrySnapshotV1
} from "./execution-runtime-v1.mjs";
import {
  validateWorkflowPlanV1
} from "./workflow-plan-v1.mjs";

export const INCIDENT_RECOVERY_DAG_SCHEMA_VERSION = 1;
export const INCIDENT_RECOVERY_DAG_PLAN_KIND = "IncidentRecoveryDagPlanV1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PLAN_STATUSES = new Set(["prepared", "reconciliation-required", "blocked", "no-op"]);
const DISPOSITIONS = new Set(["preserve", "recover", "reconcile", "blocked"]);
const RETRY_PROOFS = new Set([
  "not-started",
  "not-sent",
  "stop-stopped",
  "reconciled-not-sent",
  "failed-sealed"
]);
const PROOFS = new Set([
  "none",
  "not-started",
  "not-sent",
  "stop-stopped",
  "reconciled-not-sent",
  "failed-sealed",
  "succeeded-sealed",
  "unresolved"
]);
const TASK_STATUSES = new Set([
  "pending",
  "preparing",
  "dispatching",
  "succeeded",
  "failed",
  "hold",
  "unknown",
  "blocked",
  "cancelled"
]);
const CHECKPOINT_STATUSES = new Set([
  "ready",
  "running",
  "paused",
  "cancelling",
  "succeeded",
  "failed",
  "hold",
  "unknown",
  "cancelled"
]);
const HANDLE_STATUSES = new Set([
  "ready", "dispatching", "completed", "failed", "revoked", "stopped", "indeterminate"
]);
const INTENT_STATUSES = new Set([
  "pending", "dispatching", "not-sent", "sealed", "unknown", "cancelled"
]);
const RESERVATION_STATUSES = new Set(["reserved", "held", "released", "settled"]);
const RESERVATION_OUTCOMES = new Set(["success", "failure", "not-sent", "unknown"]);
const AUTHORITY = Object.freeze({
  classificationOnly: true,
  mayDispatch: false,
  mayResume: false,
  mayMintAdmission: false,
  mayPerformEffects: false
});

export class IncidentRecoveryDagError extends Error {
  constructor(code, message, status = "HOLD") {
    super(message);
    this.name = "IncidentRecoveryDagError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = "HOLD") {
  throw new IncidentRecoveryDagError(code, message, status);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail("EINCIDENT_DAG_INPUT", label + " must be a plain object");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("EINCIDENT_DAG_INPUT", label + " contains a symbol property");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      fail("EINCIDENT_DAG_INPUT", label + " contains an accessor property");
    }
  }
  return value;
}

function assertDataTree(value, label, context = { seen: new Set(), count: 0 }, depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (depth > 64 || context.count >= 100_000) {
    fail("EINCIDENT_DAG_INPUT", label + " exceeds the data-tree bound");
  }
  if (context.seen.has(value)) fail("EINCIDENT_DAG_INPUT", label + " contains a cycle");
  context.seen.add(value);
  context.count += 1;
  const array = Array.isArray(value);
  let arrayLength = null;
  let arrayIndexCount = 0;
  if (array) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail("EINCIDENT_DAG_INPUT", label + " must use Array.prototype");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || lengthDescriptor.get || lengthDescriptor.set ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
        lengthDescriptor.value > 100_000) {
      fail("EINCIDENT_DAG_INPUT", label + " has an invalid array length");
    }
    arrayLength = lengthDescriptor.value;
  } else {
    assertPlainObject(value, label);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    if (typeof key !== "string") fail("EINCIDENT_DAG_INPUT", label + " contains a symbol property");
    if (array) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= arrayLength) {
        fail("EINCIDENT_DAG_INPUT", label + " contains an unexpected array property");
      }
      arrayIndexCount += 1;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      fail("EINCIDENT_DAG_INPUT", label + " contains an accessor property");
    }
    assertDataTree(descriptor.value, label + "." + key, context, depth + 1);
  }
  if (array && arrayIndexCount !== arrayLength) {
    fail("EINCIDENT_DAG_INPUT", label + " must not be sparse");
  }
  context.seen.delete(value);
  return value;
}

function exactKeys(value, keys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("EINCIDENT_DAG_INPUT", label + " has an unexpected shape");
  }
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("EINCIDENT_DAG_INPUT", label + " is invalid");
  return value;
}

function assertDigest(value, label, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || !DIGEST.test(value)) fail("EINCIDENT_DAG_INPUT", label + " is invalid");
  return value;
}

function assertText(value, label) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 2048 ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    fail("EINCIDENT_DAG_INPUT", label + " is invalid");
  }
  return value;
}

function assertIso(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("EINCIDENT_DAG_INPUT", label + " is invalid");
  }
  return value;
}

function assertInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail("EINCIDENT_DAG_INPUT", label + " is invalid");
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

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nullableId(value, label) {
  if (value === null) return null;
  return assertId(value, label);
}

function nullableUsage(value, label) {
  if (value === null) return null;
  return assertInteger(value, label);
}

function validateTriple(value, label, { nullable = true } = {}) {
  exactKeys(value, ["attempts", "seconds", "tokens"], label);
  return {
    attempts: nullable ? nullableUsage(value.attempts, label + ".attempts") : assertInteger(value.attempts, label + ".attempts"),
    seconds: nullableUsage(value.seconds, label + ".seconds"),
    tokens: nullableUsage(value.tokens, label + ".tokens")
  };
}

function validateSource(value, label) {
  exactKeys(value, ["revision", "digest", "scope"], label);
  assertText(value.revision, label + ".revision");
  assertDigest(value.digest, label + ".digest");
  assertText(value.scope, label + ".scope");
  if (value.scope.startsWith("/") || value.scope.includes("\\") || value.scope.includes("//") ||
      value.scope.split("/").includes("..")) {
    fail("EINCIDENT_DAG_INPUT", label + ".scope is invalid");
  }
  return clone(value);
}

function validateIncidentBinding(value) {
  const label = INCIDENT_RECOVERY_DAG_PLAN_KIND + ".incident";
  exactKeys(value, ["incidentId", "revision", "revisionDigest", "source"], label);
  assertId(value.incidentId, label + ".incidentId");
  assertInteger(value.revision, label + ".revision", 1);
  assertDigest(value.revisionDigest, label + ".revisionDigest");
  validateSource(value.source, label + ".source");
  return clone(value);
}

function validateWorkflowBinding(value) {
  const label = INCIDENT_RECOVERY_DAG_PLAN_KIND + ".workflow";
  exactKeys(value, [
    "runId", "planId", "planDigest", "contractDigest", "sourceBindingDigest",
    "policyDigest", "revision"
  ], label);
  assertId(value.runId, label + ".runId");
  assertId(value.planId, label + ".planId");
  for (const key of ["planDigest", "contractDigest", "sourceBindingDigest", "policyDigest"]) {
    assertDigest(value[key], label + "." + key);
  }
  assertText(value.revision, label + ".revision");
  return clone(value);
}

function validateCheckpointBinding(value) {
  const label = INCIDENT_RECOVERY_DAG_PLAN_KIND + ".checkpoint";
  exactKeys(value, ["sequence", "stateDigest", "status", "reconcileRequired"], label);
  assertInteger(value.sequence, label + ".sequence");
  assertDigest(value.stateDigest, label + ".stateDigest");
  if (!CHECKPOINT_STATUSES.has(value.status)) fail("EINCIDENT_DAG_INPUT", label + ".status is invalid");
  if (typeof value.reconcileRequired !== "boolean") fail("EINCIDENT_DAG_INPUT", label + ".reconcileRequired is invalid");
  return clone(value);
}

function validateRegistryBinding(value) {
  const label = INCIDENT_RECOVERY_DAG_PLAN_KIND + ".registry";
  exactKeys(value, ["sequence", "stateDigest"], label);
  assertInteger(value.sequence, label + ".sequence");
  assertDigest(value.stateDigest, label + ".stateDigest");
  return clone(value);
}

function validateBudgetBinding(value) {
  const label = INCIDENT_RECOVERY_DAG_PLAN_KIND + ".budget";
  exactKeys(value, [
    "ledgerSequence", "ledgerDigest", "continuity", "limits", "remaining", "required"
  ], label);
  assertInteger(value.ledgerSequence, label + ".ledgerSequence");
  assertDigest(value.ledgerDigest, label + ".ledgerDigest");
  if (!["known", "unknown", "unbound"].includes(value.continuity)) {
    fail("EINCIDENT_DAG_INPUT", label + ".continuity is invalid");
  }
  const limits = validateTriple(value.limits, label + ".limits");
  if (limits.attempts === null || limits.attempts < 1) fail("EINCIDENT_DAG_INPUT", label + ".limits.attempts is invalid");
  const remaining = validateTriple(value.remaining, label + ".remaining");
  const required = validateTriple(value.required, label + ".required");
  if (required.attempts === null) fail("EINCIDENT_DAG_INPUT", label + ".required.attempts is invalid");
  return { ...clone(value), limits, remaining, required };
}

function validateRuntimeBinding(value, label) {
  if (value === null) return null;
  exactKeys(value, [
    "handleId", "handleDigest", "handleStatus", "intentId", "intentDigest",
    "intentStatus", "admissionDigest", "proof", "reservationIds", "reservationDigest",
    "reservationStatus", "reservationOutcome", "reservationUsageDigest", "stopReceiptId",
    "stopReceiptDigest", "reconciliationId", "reconciliationDigest"
  ], label);
  assertId(value.handleId, label + ".handleId");
  assertDigest(value.handleDigest, label + ".handleDigest");
  nullableId(value.intentId, label + ".intentId");
  assertDigest(value.intentDigest, label + ".intentDigest", true);
  assertDigest(value.admissionDigest, label + ".admissionDigest");
  if (!HANDLE_STATUSES.has(value.handleStatus) ||
      (value.intentStatus !== null && !INTENT_STATUSES.has(value.intentStatus))) {
    fail("EINCIDENT_DAG_INPUT", label + " statuses are invalid");
  }
  const intentFields = [value.intentId, value.intentDigest, value.intentStatus];
  if (!intentFields.every((item) => item === null) && !intentFields.every((item) => item !== null)) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " intent binding is partial");
  }
  if (!PROOFS.has(value.proof) || value.proof === "none" || value.proof === "not-started") {
    fail("EINCIDENT_DAG_INPUT", label + ".proof is invalid");
  }
  if (!Array.isArray(value.reservationIds) || value.reservationIds.some((id) => typeof id !== "string" || !ID.test(id))) {
    fail("EINCIDENT_DAG_INPUT", label + ".reservationIds is invalid");
  }
  if (new Set(value.reservationIds).size !== value.reservationIds.length ||
      value.reservationIds.some((id, index) => index > 0 && id < value.reservationIds[index - 1])) {
    fail("EINCIDENT_DAG_INPUT", label + ".reservationIds must be unique and sorted");
  }
  if (value.reservationIds.length !== 1) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " must bind exactly one budget reservation");
  }
  assertDigest(value.reservationDigest, label + ".reservationDigest");
  if (!RESERVATION_STATUSES.has(value.reservationStatus) ||
      !RESERVATION_OUTCOMES.has(value.reservationOutcome)) {
    fail("EINCIDENT_DAG_INPUT", label + " reservation lifecycle is invalid");
  }
  assertDigest(value.reservationUsageDigest, label + ".reservationUsageDigest", true);
  nullableId(value.stopReceiptId, label + ".stopReceiptId");
  assertDigest(value.stopReceiptDigest, label + ".stopReceiptDigest", true);
  nullableId(value.reconciliationId, label + ".reconciliationId");
  assertDigest(value.reconciliationDigest, label + ".reconciliationDigest", true);
  if ((value.stopReceiptId === null) !== (value.stopReceiptDigest === null) ||
      (value.reconciliationId === null) !== (value.reconciliationDigest === null)) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " proof evidence binding is partial");
  }
  if ((value.proof === "stop-stopped") !== (value.stopReceiptDigest !== null) ||
      (value.proof === "reconciled-not-sent") !== (value.reconciliationDigest !== null)) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " proof evidence binding is inconsistent");
  }
  const sealedOutcome = value.proof === "succeeded-sealed" ? "success"
    : value.proof === "failed-sealed" ? "failure" : null;
  if (sealedOutcome !== null &&
      (!(["settled", "held"].includes(value.reservationStatus)) ||
       value.reservationOutcome !== sealedOutcome || value.reservationUsageDigest === null)) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " sealed proof is not budget-settled");
  }
  if (["not-sent", "reconciled-not-sent"].includes(value.proof) &&
      (value.reservationStatus !== "released" || value.reservationOutcome !== "not-sent" ||
       value.reservationUsageDigest !== null)) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " not-sent proof is not budget-released");
  }
  if (value.proof === "stop-stopped" &&
      (value.reservationStatus !== "held" || value.reservationOutcome !== "unknown" ||
       value.reservationUsageDigest !== null)) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " stopped proof lacks conservative budget hold");
  }
  if (value.proof === "unresolved" &&
      (!(["reserved", "held"].includes(value.reservationStatus)) ||
       value.reservationOutcome !== "unknown")) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " unresolved proof has a terminal budget decision");
  }
  const lifecycleMatches = value.proof === "succeeded-sealed"
    ? value.handleStatus === "completed" && value.intentStatus === "sealed"
    : value.proof === "failed-sealed"
      ? value.handleStatus === "failed" && value.intentStatus === "sealed"
      : value.proof === "not-sent"
        ? ["ready", "stopped", "revoked"].includes(value.handleStatus) && value.intentStatus === "not-sent"
        : value.proof === "reconciled-not-sent"
          ? ["indeterminate", "stopped", "revoked"].includes(value.handleStatus) && value.intentStatus === "unknown"
          : value.proof === "stop-stopped"
            ? ["stopped", "revoked"].includes(value.handleStatus) &&
              [null, "cancelled"].includes(value.intentStatus)
            : true;
  if (!lifecycleMatches) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " proof does not match its runtime lifecycle");
  }
  return clone(value);
}

function validateTask(value, index) {
  const label = INCIDENT_RECOVERY_DAG_PLAN_KIND + ".tasks[" + index + "]";
  exactKeys(value, [
    "taskId", "dependencies", "checkpointTaskDigest", "checkpointStatus", "attempts",
    "attemptLimit", "attemptsRemaining", "attemptId", "unitId", "executionId",
    "admissionDigest", "disposition", "reason", "proof", "usage", "runtime"
  ], label);
  assertId(value.taskId, label + ".taskId");
  if (!Array.isArray(value.dependencies) || value.dependencies.some((item) => typeof item !== "string" || !ID.test(item))) {
    fail("EINCIDENT_DAG_INPUT", label + ".dependencies is invalid");
  }
  if (new Set(value.dependencies).size !== value.dependencies.length ||
      value.dependencies.some((id, dependencyIndex) => dependencyIndex > 0 && id < value.dependencies[dependencyIndex - 1])) {
    fail("EINCIDENT_DAG_INPUT", label + ".dependencies must be unique and sorted");
  }
  assertDigest(value.checkpointTaskDigest, label + ".checkpointTaskDigest");
  if (!TASK_STATUSES.has(value.checkpointStatus)) fail("EINCIDENT_DAG_INPUT", label + ".checkpointStatus is invalid");
  assertInteger(value.attempts, label + ".attempts");
  assertInteger(value.attemptLimit, label + ".attemptLimit", 1);
  assertInteger(value.attemptsRemaining, label + ".attemptsRemaining");
  if (value.attemptsRemaining !== Math.max(0, value.attemptLimit - value.attempts)) {
    fail("EINCIDENT_DAG_INTEGRITY", label + ".attemptsRemaining is stale");
  }
  nullableId(value.attemptId, label + ".attemptId");
  nullableId(value.unitId, label + ".unitId");
  nullableId(value.executionId, label + ".executionId");
  assertDigest(value.admissionDigest, label + ".admissionDigest", true);
  const runtimeFields = [value.unitId, value.executionId, value.admissionDigest];
  const runtimeFieldsAbsent = runtimeFields.every((item) => item === null);
  const runtimeFieldsPresent = runtimeFields.every((item) => item !== null);
  if (!runtimeFieldsAbsent && !runtimeFieldsPresent) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " runtime identity is partial");
  }
  if (runtimeFieldsPresent && value.attemptId === null) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " runtime identity has no attempt id");
  }
  if (!DISPOSITIONS.has(value.disposition)) fail("EINCIDENT_DAG_INPUT", label + ".disposition is invalid");
  assertText(value.reason, label + ".reason");
  if (!PROOFS.has(value.proof)) fail("EINCIDENT_DAG_INPUT", label + ".proof is invalid");
  exactKeys(value.usage, ["seconds", "tokens"], label + ".usage");
  const usage = {
    seconds: nullableUsage(value.usage.seconds, label + ".usage.seconds"),
    tokens: nullableUsage(value.usage.tokens, label + ".usage.tokens")
  };
  const runtime = validateRuntimeBinding(value.runtime, label + ".runtime");
  if ((runtime === null) !== runtimeFieldsAbsent) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " runtime identity is inconsistent");
  }
  if (runtime !== null && runtime.admissionDigest !== value.admissionDigest) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " runtime admission digest drifted");
  }
  if (runtime !== null && runtime.proof !== value.proof) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " runtime proof drifted");
  }
  if (runtime === null && value.proof !== "not-started") {
    fail("EINCIDENT_DAG_INTEGRITY", label + " unbound task has an invalid proof");
  }
  if (value.disposition === "preserve" &&
      (runtime === null || value.checkpointStatus !== "succeeded" || value.proof !== "succeeded-sealed")) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " preserve disposition lacks success proof");
  }
  if (value.disposition === "recover" && !RETRY_PROOFS.has(value.proof)) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " recover disposition lacks a retry proof");
  }
  if (value.disposition === "recover" &&
      ((value.proof === "not-started") !== (runtime === null))) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " recover disposition has an inconsistent runtime proof");
  }
  if ((value.checkpointStatus === "succeeded") !== (value.disposition === "preserve")) {
    fail("EINCIDENT_DAG_INTEGRITY", label + " succeeded checkpoint disposition is inconsistent");
  }
  if (value.proof === "succeeded-sealed" && value.disposition !== "preserve") {
    fail("EINCIDENT_DAG_INTEGRITY", label + " sealed success is not preserved");
  }
  if (value.proof === "unresolved" && value.disposition !== "reconcile") {
    fail("EINCIDENT_DAG_INTEGRITY", label + " unresolved effect is not reconciled");
  }
  return { ...clone(value), usage: { seconds: usage.seconds, tokens: usage.tokens }, runtime };
}

function assertTaskGraph(tasks) {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  if (byId.size !== tasks.length) fail("EINCIDENT_DAG_INPUT", "incident recovery DAG contains duplicate task ids");
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.taskId || !byId.has(dependency)) {
        fail("EINCIDENT_DAG_INPUT", "incident recovery DAG dependency is invalid");
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(taskId) {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) fail("EINCIDENT_DAG_INPUT", "incident recovery DAG contains a cycle");
    visiting.add(taskId);
    for (const dependency of byId.get(taskId).dependencies) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const task of tasks) visit(task.taskId);
}

function validateAuthority(value) {
  exactKeys(value, Object.keys(AUTHORITY), INCIDENT_RECOVERY_DAG_PLAN_KIND + ".authority");
  if (!same(value, AUTHORITY)) fail("EINCIDENT_DAG_AUTHORITY", "incident recovery DAG authority must remain classification-only");
  return clone(AUTHORITY);
}

function planBody(value) {
  const { manifestDigest: ignored, ...body } = value;
  return body;
}

export function validateIncidentRecoveryDagPlanV1(value) {
  assertDataTree(value, INCIDENT_RECOVERY_DAG_PLAN_KIND);
  exactKeys(value, [
    "schemaVersion", "kind", "recoveryId", "status", "preparedAt", "incident",
    "workflow", "checkpoint", "registry", "budget", "tasks", "authority", "manifestDigest"
  ], INCIDENT_RECOVERY_DAG_PLAN_KIND);
  if (value.schemaVersion !== INCIDENT_RECOVERY_DAG_SCHEMA_VERSION ||
      value.kind !== INCIDENT_RECOVERY_DAG_PLAN_KIND) {
    fail("EINCIDENT_DAG_INPUT", "incident recovery DAG kind or version is invalid");
  }
  assertId(value.recoveryId, INCIDENT_RECOVERY_DAG_PLAN_KIND + ".recoveryId");
  if (!PLAN_STATUSES.has(value.status)) fail("EINCIDENT_DAG_INPUT", "incident recovery DAG status is invalid");
  assertIso(value.preparedAt, INCIDENT_RECOVERY_DAG_PLAN_KIND + ".preparedAt");
  const incident = validateIncidentBinding(value.incident);
  const workflow = validateWorkflowBinding(value.workflow);
  const checkpoint = validateCheckpointBinding(value.checkpoint);
  const registry = validateRegistryBinding(value.registry);
  const budget = validateBudgetBinding(value.budget);
  if (!Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.length > 256) {
    fail("EINCIDENT_DAG_INPUT", "incident recovery DAG tasks are invalid");
  }
  const tasks = value.tasks.map(validateTask);
  if (tasks.some((task, index) => index > 0 && task.taskId < tasks[index - 1].taskId)) {
    fail("EINCIDENT_DAG_INPUT", "incident recovery DAG tasks must be sorted");
  }
  assertTaskGraph(tasks);
  const authority = validateAuthority(value.authority);
  assertDigest(value.manifestDigest, INCIDENT_RECOVERY_DAG_PLAN_KIND + ".manifestDigest");
  if (digestObject(planBody(value)) !== value.manifestDigest) {
    fail("EINCIDENT_DAG_INTEGRITY", "incident recovery DAG manifest digest is stale");
  }
  const dispositions = new Set(tasks.map((task) => task.disposition));
  const globalReconciliation = checkpoint.reconcileRequired ||
    ["running", "cancelling", "unknown"].includes(checkpoint.status) ||
    budget.continuity === "unknown";
  const taskMap = new Map(tasks.map((task) => [task.taskId, task]));
  if (tasks.some((task) => task.disposition === "recover" &&
      (globalReconciliation || task.attemptsRemaining === 0 || task.dependencies.some((dependency) =>
        ["reconcile", "blocked"].includes(taskMap.get(dependency).disposition))))) {
    fail("EINCIDENT_DAG_INTEGRITY", "recover disposition bypasses a global, attempt, or dependency fence");
  }
  const insufficientBudget = ["attempts", "seconds", "tokens"].some((dimension) =>
    budget.required[dimension] !== null && budget.remaining[dimension] !== null &&
    budget.required[dimension] > budget.remaining[dimension]);
  if (insufficientBudget && dispositions.has("recover")) {
    fail("EINCIDENT_DAG_INTEGRITY", "recover disposition bypasses the global budget fence");
  }
  if (tasks.some((task) => task.disposition === "reconcile" &&
      task.proof !== "unresolved" && !globalReconciliation)) {
    fail("EINCIDENT_DAG_INTEGRITY", "reconciliation task has no global or runtime uncertainty");
  }
  const expectedStatus = globalReconciliation || dispositions.has("reconcile")
    ? "reconciliation-required"
    : dispositions.has("blocked")
      ? "blocked"
      : dispositions.has("recover")
        ? "prepared"
        : "no-op";
  if (value.status !== expectedStatus) {
    fail("EINCIDENT_DAG_INTEGRITY", "incident recovery DAG status is not derived from its tasks and global state");
  }
  return freezeDeep({
    schemaVersion: INCIDENT_RECOVERY_DAG_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_DAG_PLAN_KIND,
    recoveryId: value.recoveryId,
    status: value.status,
    preparedAt: value.preparedAt,
    incident,
    workflow,
    checkpoint,
    registry,
    budget,
    tasks,
    authority,
    manifestDigest: value.manifestDigest
  });
}

function ledgerTotals(state) {
  const consumed = { attempts: 0, seconds: 0, tokens: 0, cost: null };
  const reserved = { attempts: 0, seconds: 0, tokens: 0, cost: null };
  const unknown = { attempts: false, seconds: false, tokens: false, cost: true };
  for (const reservation of Object.values(state.reservations)) {
    if (reservation.status === "reserved" || reservation.status === "held") {
      for (const dimension of ["attempts", "seconds", "tokens"]) {
        const observed = reservation.usage?.[dimension];
        const amount = reservation.status === "held" && observed !== null && observed !== undefined
          ? Math.max(reservation.reserved[dimension] ?? 0, observed)
          : reservation.reserved[dimension];
        if (amount === null) unknown[dimension] = true;
        else reserved[dimension] += amount;
      }
    }
    if (reservation.status === "settled") {
      for (const dimension of ["attempts", "seconds", "tokens"]) {
        const observed = reservation.usage?.[dimension];
        if (observed === null || observed === undefined) unknown[dimension] = true;
        else consumed[dimension] += observed;
      }
    }
    if (reservation.status === "held") {
      if (!reservation.usage || reservation.usage.seconds === null) unknown.seconds = true;
      if (!reservation.usage || reservation.usage.tokens === null) unknown.tokens = true;
      if (reservation.outcome === "unknown") unknown.attempts = true;
    }
  }
  return { consumed, reserved, unknown };
}

function ledgerRemaining(state) {
  const totals = ledgerTotals(state);
  const result = {};
  for (const dimension of ["attempts", "seconds", "tokens", "cost"]) {
    const limit = state.limits?.[dimension] ?? null;
    if (limit === null) {
      result[dimension] = { limit: null, consumed: null, reserved: null, remaining: null, unknown: true };
    } else {
      result[dimension] = {
        limit,
        consumed: totals.consumed[dimension],
        reserved: totals.reserved[dimension],
        remaining: Math.max(0, limit - totals.consumed[dimension] - totals.reserved[dimension]),
        unknown: totals.unknown[dimension]
      };
    }
  }
  return result;
}

function normalizeLedgerSnapshot(value) {
  assertPlainObject(value, "execution budget ledger snapshot");
  const allowed = new Set([
    "schemaVersion", "kind", "runId", "lineage", "limits", "sequence", "stateDigest",
    "reservations", "remaining"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("EINCIDENT_DAG_INPUT", "execution budget ledger snapshot has an unexpected shape");
  }
  const snapshot = clone(value);
  const suppliedRemaining = Object.hasOwn(snapshot, "remaining") ? snapshot.remaining : null;
  delete snapshot.remaining;
  let ledger;
  try {
    ledger = validateExecutionBudgetLedgerV1(snapshot);
  } catch (error) {
    fail("EINCIDENT_DAG_BUDGET", "execution budget ledger is invalid: " + String(error?.message ?? error));
  }
  const remaining = ledgerRemaining(ledger);
  if (suppliedRemaining !== null && !same(suppliedRemaining, remaining)) {
    fail("EINCIDENT_DAG_BUDGET", "execution budget ledger remaining projection is stale");
  }
  return { ledger: clone(ledger), remaining };
}

function assertWorkflowBindings(plan, checkpoint, registry, ledger, incident) {
  const source = plan.taskContract.bindings.source;
  const policy = plan.taskContract.bindings.policy;
  if (incident.source.revision !== source.revision || incident.source.digest !== source.digest) {
    fail("EINCIDENT_DAG_SOURCE", "incident source is not bound to WorkflowPlanV1");
  }
  if (checkpoint.planId !== plan.planId || checkpoint.planDigest !== plan.planDigest ||
      checkpoint.contractDigest !== plan.contractDigest) {
    fail("EINCIDENT_DAG_CHECKPOINT", "checkpoint is not bound to WorkflowPlanV1");
  }
  if (registry.runId !== checkpoint.runId || ledger.runId !== checkpoint.runId) {
    fail("EINCIDENT_DAG_RUN", "recovery snapshots are not bound to the same run");
  }
  if (Object.keys(registry.admissions).length !== Object.keys(registry.handles).length) {
    fail("EINCIDENT_DAG_ADMISSION", "legacy runtime handles cannot establish DAG recovery evidence");
  }
  for (const admission of Object.values(registry.admissions)) {
    const task = plan.taskContract.graph.tasks.find((candidate) => candidate.id === admission.taskId);
    if (admission.runId !== checkpoint.runId || admission.planDigest !== plan.planDigest ||
        admission.contractDigest !== plan.contractDigest || admission.sourceBindingDigest !== source.digest ||
        admission.policyDigest !== policy.digest || admission.revision !== source.revision ||
        !task) {
      fail("EINCIDENT_DAG_ADMISSION", "durable admission is not bound to WorkflowPlanV1");
    }
    if (!same(admission.scope, plan.taskContract.scope) || !same(admission.budget, task.budget)) {
      fail("EINCIDENT_DAG_ADMISSION", "durable admission scope or budget drifted from WorkflowPlanV1");
    }
  }
  if (ledger.lineage !== null) {
    const expected = {
      planDigest: plan.planDigest,
      contractDigest: plan.contractDigest,
      sourceBindingDigest: source.digest,
      policyDigest: policy.digest,
      revision: source.revision
    };
    if (!same(ledger.lineage, expected)) fail("EINCIDENT_DAG_BUDGET", "budget ledger lineage drifted");
    const expectedLimits = {
      attempts: plan.taskContract.budget.attempts,
      seconds: plan.taskContract.budget.seconds,
      tokens: plan.taskContract.budget.tokens,
      cost: null
    };
    if (!same(ledger.limits, expectedLimits)) fail("EINCIDENT_DAG_BUDGET", "budget ledger limits drifted");
  }
  const checkpointLimits = {
    attempts: checkpoint.budget.attempts,
    seconds: checkpoint.budget.seconds,
    tokens: checkpoint.budget.tokens
  };
  if (!same(checkpointLimits, plan.taskContract.budget)) {
    fail("EINCIDENT_DAG_BUDGET", "checkpoint budget limits drifted from WorkflowPlanV1");
  }
  if (checkpoint.budget.attemptsUsed > checkpoint.budget.attempts) {
    fail("EINCIDENT_DAG_BUDGET", "checkpoint attempts exceed the immutable budget");
  }
  for (const dimension of ["seconds", "tokens"]) {
    const limit = checkpoint.budget[dimension];
    const used = checkpoint.budget[dimension + "Used"];
    if (limit !== null && used !== null && used > limit) {
      fail("EINCIDENT_DAG_BUDGET", "checkpoint " + dimension + " usage exceeds the immutable budget");
    }
  }
  if (ledger.lineage === null) {
    const attempted = checkpoint.budget.attemptsUsed !== 0 ||
      Object.values(checkpoint.tasks).some((task) => task.attempts !== 0) ||
      Object.keys(registry.handles).length !== 0 ||
      Object.keys(ledger.reservations).length !== 0;
    if (attempted) fail("EINCIDENT_DAG_BUDGET", "attempted workflow has an unbound budget ledger");
  }
}

function assertReservationBindings(ledger, registry) {
  const byHandle = new Map();
  const seenHandles = new Set();
  const seenIdempotencyKeys = new Set();
  for (const reservation of Object.values(ledger.reservations)) {
    const handle = registry.handles[reservation.runtime.handleId];
    const admission = registry.admissions[reservation.runtime.handleId];
    if (!handle || !admission || reservation.admissionDigest !== handle.admissionDigest) {
      fail("EINCIDENT_DAG_BUDGET", "budget reservation is not bound to a durable runtime handle");
    }
    for (const key of [
      "runId", "executionId", "attemptId", "unitId", "ownedResourceId", "authorityEpoch", "fence"
    ]) {
      if (reservation.runtime[key] !== handle[key]) {
        fail("EINCIDENT_DAG_BUDGET", "budget reservation runtime binding drifted");
      }
    }
    if (reservation.executionId !== handle.executionId ||
        reservation.attemptId !== handle.attemptId ||
        reservation.unitId !== handle.unitId ||
        !same(reservation.lineage, ledger.lineage)) {
      fail("EINCIDENT_DAG_BUDGET", "budget reservation identity or lineage drifted");
    }
    if (seenHandles.has(handle.handleId) || seenIdempotencyKeys.has(reservation.idempotencyKey)) {
      fail("EINCIDENT_DAG_BUDGET", "budget reservation identity is duplicated");
    }
    seenHandles.add(handle.handleId);
    seenIdempotencyKeys.add(reservation.idempotencyKey);
    byHandle.set(handle.handleId, reservation);
  }
  const admissionHandleIds = Object.keys(registry.admissions);
  if (byHandle.size !== admissionHandleIds.length ||
      admissionHandleIds.some((handleId) => !byHandle.has(handleId))) {
    fail("EINCIDENT_DAG_BUDGET", "budget reservations do not exactly cover durable admissions");
  }
  return byHandle;
}

function latestStopReceipt(registry, handleId) {
  const receipts = Object.values(registry.stopReceipts).filter((receipt) => receipt.handleId === handleId);
  if (receipts.length === 0) return null;
  const latestTime = Math.max(...receipts.map((receipt) => Date.parse(receipt.createdAt)));
  const latest = receipts
    .filter((receipt) => Date.parse(receipt.createdAt) === latestTime)
    .sort((left, right) => compareIds(left.stopReceiptId, right.stopReceiptId));
  if (latest.some((receipt) => receipt.outcome !== "STOPPED" || receipt.confirmedOwnedScope !== true)) {
    return null;
  }
  return latest[0];
}

function latestReconciliation(intent) {
  return Array.isArray(intent.reconciliation) && intent.reconciliation.length > 0
    ? intent.reconciliation.at(-1)
    : null;
}

function retryableReconciliation(handle, intent) {
  const reconciliation = latestReconciliation(intent);
  return reconciliation?.decision === "retryable" &&
    reconciliation.runId === handle.runId &&
    reconciliation.handleId === handle.handleId &&
    reconciliation.intentId === intent.intentId &&
    reconciliation.observation?.controllerStatus === "terminated" &&
    reconciliation.observation?.providerOutcome === "not-sent" &&
    reconciliation.observation?.businessOutcome === null;
}

function runtimeProof(registry, handle, intent) {
  if (intent === null) {
    const stopReceipt = latestStopReceipt(registry, handle.handleId);
    if (["stopped", "revoked"].includes(handle.status) &&
        stopReceipt?.outcome === "STOPPED" && stopReceipt.confirmedOwnedScope === true) {
      return "stop-stopped";
    }
    return "unresolved";
  }
  if (intent.status === "unknown") {
    return ["indeterminate", "stopped", "revoked"].includes(handle.status) &&
      retryableReconciliation(handle, intent)
      ? "reconciled-not-sent"
      : "unresolved";
  }
  if (intent.status === "pending" || intent.status === "dispatching") return "unresolved";
  if (intent.status === "sealed" && intent.outcome === "success" && intent.admissionSeal !== undefined) {
    return handle.status === "completed" ? "succeeded-sealed" : "unresolved";
  }
  if (intent.status === "sealed" && intent.outcome === "failure" && intent.admissionSeal !== undefined) {
    return handle.status === "failed" ? "failed-sealed" : "unresolved";
  }
  if (intent.status === "sealed") return "unresolved";
  if (["ready", "stopped", "revoked"].includes(handle.status) && intent.status === "not-sent" &&
      intent.callbackCalls === 0 && intent.dispatchReserved === false) {
    return "not-sent";
  }
  const stopReceipt = latestStopReceipt(registry, handle.handleId);
  if (["stopped", "revoked"].includes(handle.status) &&
      stopReceipt?.outcome === "STOPPED" && stopReceipt.confirmedOwnedScope === true) {
    return "stop-stopped";
  }
  return "unresolved";
}

function assertCurrentObligationTail(registry, handle, taskId) {
  const members = Object.values(registry.handles)
    .filter((candidate) => candidate.obligationKey === handle.obligationKey);
  const parents = new Set(members
    .map((candidate) => candidate.origin?.resumedFromHandleId)
    .filter((candidate) => candidate !== undefined));
  const tails = members.filter((candidate) => !parents.has(candidate.handleId));
  if (tails.length !== 1 || tails[0].handleId !== handle.handleId) {
    fail("EINCIDENT_DAG_RUNTIME", "checkpoint task is not bound to the current obligation tail: " + taskId);
  }
}

function assertReservationProof(reservation, proof, taskId) {
  const usageDigest = reservation.usage === null ? null : digestObject(reservation.usage);
  const sealedOutcome = proof === "succeeded-sealed" ? "success"
    : proof === "failed-sealed" ? "failure" : null;
  if (sealedOutcome !== null &&
      (!(["settled", "held"].includes(reservation.status)) ||
       reservation.outcome !== sealedOutcome || usageDigest === null)) {
    fail("EINCIDENT_DAG_BUDGET", "sealed runtime has no matching terminal budget evidence: " + taskId);
  }
  if (["not-sent", "reconciled-not-sent"].includes(proof) &&
      (reservation.status !== "released" || reservation.outcome !== "not-sent" || usageDigest !== null)) {
    fail("EINCIDENT_DAG_BUDGET", "not-sent runtime has no matching released budget evidence: " + taskId);
  }
  if (proof === "stop-stopped" &&
      (reservation.status !== "held" || reservation.outcome !== "unknown" || usageDigest !== null)) {
    fail("EINCIDENT_DAG_BUDGET", "stopped runtime has no conservative budget hold: " + taskId);
  }
  if (proof === "unresolved" &&
      (!(["reserved", "held"].includes(reservation.status)) || reservation.outcome !== "unknown")) {
    fail("EINCIDENT_DAG_BUDGET", "unresolved runtime has a contradictory terminal budget decision: " + taskId);
  }
  return usageDigest;
}

function taskObligationEvidence(registry, taskAdmissions, reservationsByHandle, taskId) {
  const obligationKeys = new Set(taskAdmissions.map(([handleId]) =>
    registry.handles[handleId].obligationKey));
  if (obligationKeys.size > 1) {
    fail("EINCIDENT_DAG_RUNTIME", "checkpoint task has multiple durable obligation chains: " + taskId);
  }
  return taskAdmissions.map(([handleId]) => {
    const handle = registry.handles[handleId];
    const intents = Object.values(registry.intents)
      .filter((intent) => intent.handleId === handleId);
    if (intents.length > 1) {
      fail("EINCIDENT_DAG_RUNTIME", "task obligation member has multiple execution intents: " + taskId);
    }
    const intent = intents[0] ?? null;
    const proof = runtimeProof(registry, handle, intent);
    const reservation = reservationsByHandle.get(handleId) ?? null;
    if (reservation === null) {
      fail("EINCIDENT_DAG_BUDGET", "task obligation member requires exactly one budget reservation: " + taskId);
    }
    return {
      handle,
      intent,
      proof,
      reservation,
      reservationUsageDigest: assertReservationProof(reservation, proof, taskId)
    };
  });
}

function runtimeForTask(plan, checkpointTask, task, registry, reservationsByHandle) {
  const bindingValues = [
    checkpointTask.unitId,
    checkpointTask.executionId,
    checkpointTask.admissionDigest
  ];
  const allNull = bindingValues.every((value) => value === null);
  const allPresent = bindingValues.every((value) => value !== null);
  if (!allNull && !allPresent) {
    fail("EINCIDENT_DAG_CHECKPOINT", "checkpoint task has a partial runtime binding: " + task.id);
  }
  const taskAdmissions = Object.entries(registry.admissions)
    .filter(([, admission]) => admission.taskId === task.id);
  const chainEvidence = taskObligationEvidence(
    registry,
    taskAdmissions,
    reservationsByHandle,
    task.id
  );
  if (allNull) {
    if (checkpointTask.attemptId !== null &&
        taskAdmissions.some(([, admission]) => admission.attemptId === checkpointTask.attemptId)) {
      fail("EINCIDENT_DAG_RUNTIME", "checkpoint task omits its current durable runtime state: " + task.id);
    }
    if (taskAdmissions.length > checkpointTask.attempts) {
      fail("EINCIDENT_DAG_RUNTIME", "durable runtime attempts exceed the checkpoint task count: " + task.id);
    }
    if (chainEvidence.some((evidence) =>
      evidence.proof === "unresolved" || evidence.proof === "succeeded-sealed")) {
      fail("EINCIDENT_DAG_RUNTIME", "unbound checkpoint task has unresolved or successful runtime history: " + task.id);
    }
    return null;
  }
  if (checkpointTask.attemptId === null) {
    fail("EINCIDENT_DAG_CHECKPOINT", "checkpoint task runtime binding has no attempt id: " + task.id);
  }
  const matches = taskAdmissions.filter(([handleId, admission]) => {
    const handle = registry.handles[handleId];
    return admission.taskId === task.id &&
      handle.admissionDigest === checkpointTask.admissionDigest &&
      handle.attemptId === checkpointTask.attemptId &&
      handle.unitId === checkpointTask.unitId &&
      handle.executionId === checkpointTask.executionId;
  });
  if (matches.length !== 1) {
    fail("EINCIDENT_DAG_ADMISSION", "checkpoint task requires exactly one bound runtime admission: " + task.id);
  }
  const [handleId, admission] = matches[0];
  const handle = registry.handles[handleId];
  assertCurrentObligationTail(registry, handle, task.id);
  if (taskAdmissions.length > checkpointTask.attempts) {
    fail("EINCIDENT_DAG_RUNTIME", "durable runtime attempts exceed the checkpoint task count: " + task.id);
  }
  if (admission.planDigest !== plan.planDigest || admission.contractDigest !== plan.contractDigest) {
    fail("EINCIDENT_DAG_ADMISSION", "task admission plan binding drifted: " + task.id);
  }
  for (const evidence of chainEvidence) {
    if (evidence.handle.handleId !== handleId && evidence.proof === "unresolved") {
      fail("EINCIDENT_DAG_RUNTIME", "task obligation predecessor remains unresolved: " + task.id);
    }
  }
  const selectedEvidence = chainEvidence.find((evidence) => evidence.handle.handleId === handleId) ?? null;
  if (selectedEvidence === null) {
    fail("EINCIDENT_DAG_RUNTIME", "checkpoint task has no selected obligation evidence: " + task.id);
  }
  const { intent, proof, reservation, reservationUsageDigest } = selectedEvidence;
  const stopReceipt = proof === "stop-stopped" ? latestStopReceipt(registry, handleId) : null;
  const reconciliation = proof === "reconciled-not-sent" && intent !== null
    ? latestReconciliation(intent)
    : null;
  return {
    handleId,
    handleDigest: digestObject(handle),
    handleStatus: handle.status,
    intentId: intent?.intentId ?? null,
    intentDigest: intent === null ? null : digestObject(intent),
    intentStatus: intent?.status ?? null,
    admissionDigest: handle.admissionDigest,
    proof,
    reservationIds: [reservation.reservationId],
    reservationDigest: digestObject(reservation),
    reservationStatus: reservation.status,
    reservationOutcome: reservation.outcome,
    reservationUsageDigest,
    stopReceiptId: stopReceipt?.stopReceiptId ?? null,
    stopReceiptDigest: stopReceipt === null ? null : digestObject(stopReceipt),
    reconciliationId: reconciliation?.reconciliationId ?? null,
    reconciliationDigest: reconciliation === null ? null : digestObject(reconciliation)
  };
}

function initialTaskClassification(plan, checkpoint, registry, reservationsByHandle) {
  return plan.taskContract.graph.tasks.map((task) => {
    const checkpointTask = checkpoint.tasks[task.id];
    const runtime = runtimeForTask(plan, checkpointTask, task, registry, reservationsByHandle);
    const proof = runtime?.proof ?? "not-started";
    let disposition;
    let reason;
    if (checkpointTask.status === "succeeded") {
      if (proof !== "succeeded-sealed") {
        fail("EINCIDENT_DAG_RUNTIME", "succeeded checkpoint task lacks a sealed success proof: " + task.id);
      }
      disposition = "preserve";
      reason = "sealed-success-is-preserved";
    } else if (runtime !== null && RETRY_PROOFS.has(proof)) {
      disposition = "recover";
      reason = "runtime-proof-" + proof;
    } else if (runtime !== null && proof === "unresolved") {
      disposition = "reconcile";
      reason = "runtime-effect-is-unresolved";
    } else if (checkpointTask.status === "unknown" ||
        checkpointTask.status === "dispatching" ||
        (checkpointTask.status === "preparing" && runtime !== null)) {
      disposition = "reconcile";
      reason = "checkpoint-effect-is-unresolved";
    } else if (["pending", "preparing", "blocked", "cancelled"].includes(checkpointTask.status) && runtime === null) {
      disposition = "recover";
      reason = checkpointTask.status === "blocked"
        ? "dependency-task-was-not-started"
        : "task-was-not-admitted";
    } else {
      disposition = "blocked";
      reason = "checkpoint-state-has-no-retry-proof";
    }
    const attemptsRemaining = Math.max(0, task.budget.attempts - checkpointTask.attempts);
    if (disposition === "recover" && attemptsRemaining === 0) {
      disposition = "blocked";
      reason = "task-attempt-budget-exhausted";
    }
    return {
      taskId: task.id,
      dependencies: [...task.dependencies].sort(compareIds),
      checkpointTaskDigest: digestObject(checkpointTask),
      checkpointStatus: checkpointTask.status,
      attempts: checkpointTask.attempts,
      attemptLimit: task.budget.attempts,
      attemptsRemaining,
      attemptId: checkpointTask.attemptId,
      unitId: checkpointTask.unitId,
      executionId: checkpointTask.executionId,
      admissionDigest: checkpointTask.admissionDigest,
      disposition,
      reason,
      proof,
      usage: clone(checkpointTask.usage),
      runtime
    };
  });
}

function propagateDependencies(tasks) {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (task.disposition !== "recover") continue;
      const dependencies = task.dependencies.map((id) => byId.get(id));
      if (dependencies.some((dependency) => dependency.disposition === "reconcile")) {
        task.disposition = "blocked";
        task.reason = "dependency-reconciliation-required";
        changed = true;
      } else if (dependencies.some((dependency) => dependency.disposition === "blocked")) {
        task.disposition = "blocked";
        task.reason = "dependency-recovery-is-blocked";
        changed = true;
      }
    }
  }
}

function requiredBudget(tasks, taskMap) {
  const recover = tasks.filter((task) => task.disposition === "recover");
  const result = { attempts: recover.length, seconds: 0, tokens: 0 };
  for (const dimension of ["seconds", "tokens"]) {
    for (const recovery of recover) {
      const value = taskMap.get(recovery.taskId).budget[dimension];
      if (value === null) {
        result[dimension] = null;
        break;
      }
      result[dimension] += value;
    }
  }
  return result;
}

function budgetProjection(plan, checkpoint, ledgerInfo, tasks) {
  const limits = clone(plan.taskContract.budget);
  const ledger = ledgerInfo.ledger;
  const bound = ledger.lineage !== null;
  const remaining = {};
  let continuity = bound ? "known" : "unbound";
  for (const dimension of ["attempts", "seconds", "tokens"]) {
    const limit = limits[dimension];
    if (limit === null) {
      remaining[dimension] = null;
      continue;
    }
    const used = dimension === "attempts"
      ? checkpoint.budget.attemptsUsed
      : checkpoint.budget[dimension + "Used"];
    if (used === null) {
      remaining[dimension] = null;
      continuity = "unknown";
      continue;
    }
    const checkpointRemaining = Math.max(0, limit - used);
    if (!bound) {
      remaining[dimension] = checkpointRemaining;
      continue;
    }
    const durable = ledgerInfo.remaining[dimension];
    if (durable.unknown) {
      remaining[dimension] = null;
      continuity = "unknown";
    } else {
      remaining[dimension] = Math.min(checkpointRemaining, durable.remaining);
    }
  }
  const taskMap = new Map(plan.taskContract.graph.tasks.map((task) => [task.id, task]));
  const required = requiredBudget(tasks, taskMap);
  return {
    ledgerSequence: ledger.sequence,
    ledgerDigest: ledger.stateDigest,
    continuity,
    limits,
    remaining,
    required
  };
}

function applyGlobalFences(checkpoint, tasks, budget) {
  const activeRun = ["running", "cancelling"].includes(checkpoint.status);
  if (checkpoint.reconcileRequired || checkpoint.status === "unknown" || activeRun) {
    for (const task of tasks) {
      if (task.disposition === "recover") {
        task.disposition = "reconcile";
        task.reason = checkpoint.reconcileRequired
          ? "checkpoint-owner-reconciliation-required"
          : "checkpoint-run-is-not-safely-terminal";
      }
    }
    propagateDependencies(tasks);
    return;
  }
  if (budget.continuity === "unknown") {
    for (const task of tasks) {
      if (task.disposition === "recover") {
        task.disposition = "reconcile";
        task.reason = "budget-continuity-is-unknown";
      }
    }
    propagateDependencies(tasks);
    return;
  }
  const insufficient = ["attempts", "seconds", "tokens"].find((dimension) => {
    const required = budget.required[dimension];
    const remaining = budget.remaining[dimension];
    return required !== null && remaining !== null && required > remaining;
  });
  if (insufficient) {
    for (const task of tasks) {
      if (task.disposition === "recover") {
        task.disposition = "blocked";
        task.reason = "global-" + insufficient + "-budget-exhausted";
      }
    }
    propagateDependencies(tasks);
  }
}

function planStatus(tasks, checkpoint, budget) {
  if (checkpoint.reconcileRequired || ["running", "cancelling", "unknown"].includes(checkpoint.status) ||
      budget.continuity === "unknown") {
    return "reconciliation-required";
  }
  if (tasks.some((task) => task.disposition === "reconcile")) return "reconciliation-required";
  if (tasks.some((task) => task.disposition === "blocked")) return "blocked";
  if (tasks.some((task) => task.disposition === "recover")) return "prepared";
  return "no-op";
}

function buildPlan(options) {
  assertDataTree(options, "buildIncidentRecoveryDagPlanV1 options");
  exactKeys(options, [
    "recoveryId", "preparedAt", "incident", "workflowPlan", "checkpoint",
    "executionRegistry", "budgetLedger"
  ], "buildIncidentRecoveryDagPlanV1 options");
  assertId(options.recoveryId, "recoveryId");
  assertIso(options.preparedAt, "preparedAt");
  let plan;
  let checkpoint;
  let registry;
  let incident;
  try {
    plan = validateWorkflowPlanV1(options.workflowPlan);
    checkpoint = validateNativeV3PlanRunnerCheckpointV1(options.checkpoint, plan);
    registry = validateExecutionRegistrySnapshotV1(options.executionRegistry, checkpoint.runId);
    incident = validateIncidentReportV1(options.incident);
  } catch (error) {
    if (error instanceof IncidentRecoveryDagError) throw error;
    fail("EINCIDENT_DAG_INPUT", "recovery source validation failed: " + String(error?.message ?? error));
  }
  const ledgerInfo = normalizeLedgerSnapshot(options.budgetLedger);
  assertWorkflowBindings(plan, checkpoint, registry, ledgerInfo.ledger, incident);
  const reservationsByHandle = assertReservationBindings(ledgerInfo.ledger, registry);
  const tasks = initialTaskClassification(plan, checkpoint, registry, reservationsByHandle);
  propagateDependencies(tasks);
  const budget = budgetProjection(plan, checkpoint, ledgerInfo, tasks);
  applyGlobalFences(checkpoint, tasks, budget);
  tasks.sort((left, right) => compareIds(left.taskId, right.taskId));
  const source = plan.taskContract.bindings.source;
  const policy = plan.taskContract.bindings.policy;
  const body = {
    schemaVersion: INCIDENT_RECOVERY_DAG_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_DAG_PLAN_KIND,
    recoveryId: options.recoveryId,
    status: planStatus(tasks, checkpoint, budget),
    preparedAt: options.preparedAt,
    incident: {
      incidentId: incident.incidentId,
      revision: incident.revision,
      revisionDigest: incident.revisionDigest,
      source: clone(incident.source)
    },
    workflow: {
      runId: checkpoint.runId,
      planId: plan.planId,
      planDigest: plan.planDigest,
      contractDigest: plan.contractDigest,
      sourceBindingDigest: source.digest,
      policyDigest: policy.digest,
      revision: source.revision
    },
    checkpoint: {
      sequence: checkpoint.sequence,
      stateDigest: checkpoint.stateDigest,
      status: checkpoint.status,
      reconcileRequired: checkpoint.reconcileRequired
    },
    registry: {
      sequence: registry.sequence,
      stateDigest: registry.stateDigest
    },
    budget,
    tasks,
    authority: clone(AUTHORITY)
  };
  return validateIncidentRecoveryDagPlanV1({
    ...body,
    manifestDigest: digestObject(body)
  });
}

export function buildIncidentRecoveryDagPlanV1(options = {}) {
  return buildPlan(options);
}

export function verifyIncidentRecoveryDagPlanV1(options = {}) {
  exactKeys(options, [
    "plan", "incident", "workflowPlan", "checkpoint", "executionRegistry", "budgetLedger"
  ], "verifyIncidentRecoveryDagPlanV1 options");
  const supplied = validateIncidentRecoveryDagPlanV1(options.plan);
  const rebuilt = buildPlan({
    recoveryId: supplied.recoveryId,
    preparedAt: supplied.preparedAt,
    incident: options.incident,
    workflowPlan: options.workflowPlan,
    checkpoint: options.checkpoint,
    executionRegistry: options.executionRegistry,
    budgetLedger: options.budgetLedger
  });
  if (!same(supplied, rebuilt)) {
    fail("EINCIDENT_DAG_STALE", "incident recovery DAG plan drifted from its bound snapshots");
  }
  return supplied;
}
