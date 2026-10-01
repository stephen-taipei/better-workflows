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
} from "../lib/core.mjs";
import {
  readCheckpointJson,
  readCheckpointWithFence
} from "../lib/native-v3-plan-checkpoint-reader.mjs";
import {
  buildExecutionAdmission,
  assertSameExecutionAdmission,
  digestExecutionAdmission,
  validateExecutionAdmission
} from "../lib/execution-admission-v1.mjs";
import {
  createPosixOwnedProcessAdapter
} from "../lib/posix-owned-process-adapter.mjs";
import {
  isExecutionRuntimeEffectNotSent,
  openExecutionRegistry,
  validateStopReceiptV1
} from "../lib/execution-runtime-v1.mjs";
import {
  readFreshWorkflowPlanV1,
  validateWorkflowPlanV1
} from "../lib/workflow-plan-v1.mjs";
import { isNativeV3PlanTaskAdapter } from "../lib/native-v3-trusted-plan-producer.mjs";

export const NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION = 1;
export const NATIVE_V3_PLAN_RUNNER_KIND = "NativeV3PlanRunnerV1";
export const NATIVE_V3_PLAN_CHECKPOINT_KIND = "NativeV3PlanRunnerCheckpointV1";
export const NATIVE_V3_PLAN_RUN_RESULT_KIND = "NativeV3PlanRunResultV1";

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
const MAX_EVENTS = 16_384;
const RUN_STATUSES = new Set(["ready", "running", "cancelling", "succeeded", "failed", "hold", "unknown", "cancelled"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "hold", "unknown", "cancelled"]);
const TASK_STATUSES = new Set(["pending", "preparing", "dispatching", "succeeded", "failed", "hold", "unknown", "blocked", "cancelled"]);
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "hold", "unknown", "blocked", "cancelled"]);
const STOP_REASONS = new Set(["cancel", "pause", "security-p0", "controller-failure"]);
const OPTION_KEYS = new Set([
  "stateRoot", "root", "plan", "planId", "runId", "parallelism", "taskAdapter", "readFreshPlan", "clock", "abortSignal", "stopWaitMs"
]);
const CANCEL_KEYS = new Set(["reason"]);
const TRUSTED_PLAN_TASK_ADAPTERS = new WeakSet();
const TRUSTED_PREPARED_TASK_KEYS = ["taskId", "unitId", "binding", "controller", "resourceAdapter", "effect"].sort();
const TRUSTED_BINDING_KEYS = [
  "runId", "executionId", "attemptId", "unitId", "ownedResourceId", "sourceBindingDigest", "policyDigest", "revision"
].sort();

/**
 * Mark a task producer as trusted by this runner.  The producer may provide a
 * task-specific controller, but it cannot provide an admission, approval
 * boolean, or a stop receipt.  Those values are derived by the runner and the
 * execution registry from the branded controller/resource adapter.
 */
export function createNativeV3TestPlanTaskAdapter({ prepareTask } = {}) {
  if (typeof prepareTask !== "function") throw new TypeError("prepareTask must be callable");
  const adapter = Object.freeze({
    schemaVersion: 1,
    kind: "NativeV3TestPlanTaskAdapterV1",
    prepareTask
  });
  TRUSTED_PLAN_TASK_ADAPTERS.add(adapter);
  return adapter;
}

/**
 * Build a trusted task producer backed by the real POSIX owned-process
 * adapter.  The caller supplies only a branded controller and an immutable
 * command description for each task; authority and effect admission are
 * still rebuilt by createNativeV3PlanRunner/openExecutionRegistry.
 */
export function createNativeV3TestPosixPlanTaskAdapter(options = {}) {
  exactOptions(options, new Set(["stateRoot", "root", "prepareTask"]), "createNativeV3TestPosixPlanTaskAdapter options");
  if (typeof options.prepareTask !== "function") fail("EPLAN_RUNNER_INPUT", "POSIX task adapter prepareTask must be callable");
  const stateRootInput = options.stateRoot ?? options.root;
  const stateRoot = absolute(stateRootInput, "stateRoot");
  if (options.stateRoot !== undefined && options.root !== undefined && absolute(options.root, "root") !== stateRoot) {
    fail("EPLAN_RUNNER_INPUT", "stateRoot and root must refer to the same directory");
  }
  const processAdapter = createPosixOwnedProcessAdapter({ root: stateRoot });
  const adapter = createNativeV3TestPlanTaskAdapter({
    prepareTask: async (context) => {
      const descriptor = await options.prepareTask(context);
      if (!isPlainObject(descriptor)) fail("EPLAN_RUNNER_ADAPTER", "POSIX task descriptor must be a plain object");
      const expectedKeys = [
        "taskId", "unitId", "binding", "controller", "command", "args", "cwd", "env", "maxOutputBytes"
      ].sort();
      if (Object.keys(descriptor).sort().join(",") !== expectedKeys.join(",")) {
        fail("EPLAN_RUNNER_ADAPTER", "POSIX task descriptor has an unexpected shape");
      }
      if (descriptor.taskId !== context.taskId || descriptor.binding?.runId !== context.runId ||
          descriptor.binding?.attemptId !== context.attemptId) {
        fail("EPLAN_RUNNER_ADAPTER", "POSIX task descriptor is not bound to the task context");
      }
      return {
        taskId: descriptor.taskId,
        unitId: descriptor.unitId,
        binding: descriptor.binding,
        controller: descriptor.controller,
        resourceAdapter: processAdapter.resourceAdapter,
        effect: async (executionContext) => {
          const started = await processAdapter.startOwned(executionContext, {
            command: descriptor.command,
            args: descriptor.args,
            cwd: descriptor.cwd,
            env: descriptor.env,
            maxOutputBytes: descriptor.maxOutputBytes
          });
          if (!started || typeof started.completion?.then !== "function") {
            const error = new Error("POSIX owned process adapter did not return a completion promise");
            error.code = "EEXECUTION_EFFECT_UNKNOWN";
            error.status = "UNKNOWN";
            throw error;
          }
          const completion = await started.completion;
          if (completion?.outcome !== "stopped" || completion.groupTerminated !== true) {
            const error = new Error("POSIX owned process completion is not a proven terminal outcome");
            error.code = "EEXECUTION_EFFECT_UNKNOWN";
            error.status = "UNKNOWN";
            throw error;
          }
          return {
            outcome: completion.code === 0 && completion.outputExceeded !== true ? "success" : "failure",
            process: {
              code: completion.code,
              signal: completion.signal,
              outputExceeded: completion.outputExceeded === true,
              groupTerminated: true
            }
          };
        }
      };
    }
  });
  return adapter;
}

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
  const observation = error?.code === "EUNSAFE_JSON_PATH" && error.observation
    ? ` [lstat: ${JSON.stringify(error.observation)}]` : "";
  const message = `${String(error?.message ?? error ?? "unknown error")}${observation}`.slice(0, 1024);
  const status = ["HOLD", "UNKNOWN"].includes(error?.status) ? error.status : null;
  return { code, message, status };
}

function errorClass(error) {
  if (error?.status === "UNKNOWN" || error?.code === "EEXECUTION_EFFECT_UNKNOWN" || error?.code === "ENATIVE_V3_EXECUTION_UNKNOWN") {
    return "unknown";
  }
  return "hold";
}

function validateUsage(value, label = "usage") {
  if (value === undefined || value === null) return { seconds: 0, tokens: 0 };
  if (!isPlainObject(value)) fail("EPLAN_RUNNER_TASK_RESULT", `${label} must be a plain object`);
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !["seconds", "tokens"].includes(key))) {
    fail("EPLAN_RUNNER_TASK_RESULT", `${label} contains unknown fields`);
  }
  return {
    seconds: boundedInteger(value.seconds ?? 0, `${label}.seconds`),
    tokens: boundedInteger(value.tokens ?? 0, `${label}.tokens`)
  };
}

function validateTaskResult(value) {
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

function validateTaskCheckpoint(value, expectedTask) {
  if (!isPlainObject(value)) fail("EPLAN_RUNNER_STATE_INVALID", `tasks.${expectedTask.id} must be an object`);
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "taskId", "dependencies", "role", "writeOwner", "status", "attempts", "dispatches", "attemptId", "unitId",
    "executionId", "admissionDigest", "startedAt", "finishedAt", "outcome", "lastError", "stopReceipt", "usage"
  ].sort();
  if (keys.join(",") !== expectedKeys.join(",")) fail("EPLAN_RUNNER_STATE_INVALID", `tasks.${expectedTask.id} has an unexpected shape`);
  if (value.taskId !== expectedTask.id || !TASK_STATUSES.has(value.status)) fail("EPLAN_RUNNER_STATE_INVALID", `tasks.${expectedTask.id} identity/status is invalid`);
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
  boundedInteger(value.usage.seconds, `tasks.${expectedTask.id}.usage.seconds`);
  boundedInteger(value.usage.tokens, `tasks.${expectedTask.id}.usage.tokens`);
  return value;
}

function validateCheckpoint(value, plan, expectedRoot = null) {
  if (!isPlainObject(value)) fail("EPLAN_RUNNER_STATE_INVALID", "plan runner checkpoint must be an object");
  const expectedKeys = [
    "schemaVersion", "kind", "runId", "planId", "planDigest", "contractDigest", "parallelism", "status",
    "dispatchBlocked", "cancelRequested", "cancelReason", "failure", "ownerId", "ownerPid", "reconcileRequired", "budget", "tasks", "events",
    "sequence", "updatedAt", "stateDigest"
  ].sort();
  if (Object.keys(value).sort().join(",") !== expectedKeys.join(",")) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint has an unexpected shape");
  if (value.schemaVersion !== NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION || value.kind !== NATIVE_V3_PLAN_CHECKPOINT_KIND) {
    fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint version/kind is invalid");
  }
  id(value.runId, "checkpoint.runId");
  id(value.planId, "checkpoint.planId");
  digest(value.planDigest, "checkpoint.planDigest");
  digest(value.contractDigest, "checkpoint.contractDigest");
  boundedInteger(value.parallelism, "checkpoint.parallelism", { min: 1, max: MAX_PARALLELISM });
  if (!RUN_STATUSES.has(value.status)) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint.status is invalid");
  if (typeof value.dispatchBlocked !== "boolean" || typeof value.cancelRequested !== "boolean") fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint dispatch flags are invalid");
  if (value.cancelReason !== null && !STOP_REASONS.has(value.cancelReason)) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint.cancelReason is invalid");
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
    boundedInteger(value.budget[`${key}Used`], `checkpoint.budget.${key}Used`);
  }
  if (!isPlainObject(value.tasks)) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint.tasks must be an object");
  const expectedTasks = plan.taskContract.graph.tasks;
  const actualTaskIds = Object.keys(value.tasks).sort();
  const expectedTaskIds = expectedTasks.map((task) => task.id).sort();
  if (actualTaskIds.join(",") !== expectedTaskIds.join(",")) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint task universe changed");
  const expectedById = new Map(expectedTasks.map((task) => [task.id, task]));
  for (const taskIdValue of expectedTaskIds) validateTaskCheckpoint(value.tasks[taskIdValue], expectedById.get(taskIdValue));
  if (!Array.isArray(value.events) || value.events.length > MAX_EVENTS) fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint.events is invalid or exceeds the bound");
  let priorSequence = 0;
  for (const event of value.events) {
    if (!isPlainObject(event) || !Number.isSafeInteger(event.sequence) || event.sequence <= priorSequence ||
        typeof event.type !== "string" || typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at)) ||
        (event.taskId !== null && typeof event.taskId !== "string") || (event.attemptId !== null && typeof event.attemptId !== "string") ||
        (event.detail !== null && !isPlainObject(event.detail))) {
      fail("EPLAN_RUNNER_STATE_INVALID", "checkpoint event is invalid");
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

function taskInitialState(task) {
  return {
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
}

function initialCheckpoint({ plan, runId, parallelism, clock }) {
  const budget = plan.taskContract.budget;
  return sealCheckpoint({
    schemaVersion: NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION,
    kind: NATIVE_V3_PLAN_CHECKPOINT_KIND,
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

function validatePreparedTask(value, { plan, task, runId, attemptId }) {
  if (!isPlainObject(value)) fail("EPLAN_RUNNER_ADAPTER", "task adapter must return a plain prepared task");
  const hasDispatchReservationHook = Object.hasOwn(value, "onDispatchReservation");
  const expectedKeys = [...TRUSTED_PREPARED_TASK_KEYS, ...(hasDispatchReservationHook ? ["onDispatchReservation"] : [])].sort();
  if (Object.keys(value).sort().join(",") !== expectedKeys.join(",")) fail("EPLAN_RUNNER_ADAPTER", "prepared task has an unexpected shape");
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
  if (!isPlainObject(value.controller) || !isPlainObject(value.resourceAdapter) || typeof value.effect !== "function") {
    fail("EPLAN_RUNNER_ADAPTER", "prepared task must expose a trusted controller, owned resource adapter, and effect");
  }
  if (hasDispatchReservationHook && typeof value.onDispatchReservation !== "function") {
    fail("EPLAN_RUNNER_ADAPTER", "dispatch reservation hook must be callable");
  }
  return {
    taskId: preparedTaskId,
    unitId: preparedUnitId,
    binding,
    controller: value.controller,
    resourceAdapter: value.resourceAdapter,
    effect: value.effect,
    ...(hasDispatchReservationHook ? { onDispatchReservation: value.onDispatchReservation } : {})
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
  // This standalone inspector validates the checkpoint's structural digest. The
  // plan binding is checked by createNativeV3PlanRunner, which has the pinned
  // immutable WorkflowPlanV1 available.
  if (!isPlainObject(raw) || raw.kind !== NATIVE_V3_PLAN_CHECKPOINT_KIND) fail("EPLAN_RUNNER_STATE_INVALID", "plan runner checkpoint kind is invalid");
  const body = checkpointBody(raw);
  digest(raw.stateDigest, "checkpoint.stateDigest");
  if (digestObject(body) !== raw.stateDigest) fail("EPLAN_RUNNER_STATE_INVALID", "plan runner checkpoint digest is invalid");
  return clone(raw);
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
  if (!isPlainObject(options.taskAdapter) ||
      (!TRUSTED_PLAN_TASK_ADAPTERS.has(options.taskAdapter) && !isNativeV3PlanTaskAdapter(options.taskAdapter))) {
    fail("EPLAN_RUNNER_INPUT", "taskAdapter must be created by the trusted native V3 producer");
  }
  if (options.readFreshPlan !== undefined && typeof options.readFreshPlan !== "function") fail("EPLAN_RUNNER_INPUT", "readFreshPlan must be callable");
  const clock = options.clock;
  const abortSignal = validateAbortSignal(options.abortSignal, "abortSignal");
  const stopWaitMs = boundedInteger(options.stopWaitMs ?? STOP_WAIT_MS, "stopWaitMs", { min: 25, max: STOP_WAIT_MS });
  const initialPlan = suppliedPlan ?? (await readFreshWorkflowPlanV1({ root: stateRoot, planId: resolvedPlanId }));
  const pinnedPlan = deepFreeze(clone(initialPlan));
  const runnerRoot = safeJoin(stateRoot, PLAN_RUNNER_DIRECTORY);
  const runDir = safeJoin(runnerRoot, "runs", runId);
  const checkpointPath = safeJoin(runDir, CHECKPOINT_FILE);
  const ownerId = randomUUID();
  let runPromise = null;
  let cancelPromise = null;
  let localCancelRequested = false;
  let cancelReason = null;
  const active = new Map();

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

  async function withRuntimeRetry(callback) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    let lastError;
    while (Date.now() <= deadline) {
      try {
        return await callback();
      } catch (error) {
        lastError = error;
        if (!isLeaseConflict(error)) throw error;
        // This bounded retry is active work, not an idle background poll.
        await delay(LOCK_RETRY_MS, { keepAlive: true });
      }
    }
    throw lastError ?? new NativeV3PlanRunnerError("EPLAN_RUNNER_LEASE", "execution runtime lease could not be acquired", "HOLD");
  }

  async function readCheckpointUnfenced() {
    const raw = await readCheckpointJson(runnerRoot, checkpointPath);
    return validateCheckpoint(raw, pinnedPlan, { planId: pinnedPlan.planId, planDigest: pinnedPlan.planDigest, contractDigest: pinnedPlan.contractDigest, parallelism });
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
      validateCheckpoint(next, pinnedPlan, { planId: pinnedPlan.planId, planDigest: pinnedPlan.planDigest, contractDigest: pinnedPlan.contractDigest, parallelism });
      await atomicWriteJson(runnerRoot, checkpointPath, next);
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

  async function claimRun() {
    return transition("run.claimed", (state) => {
      if (TERMINAL_RUN_STATUSES.has(state.status)) return false;
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
      const attemptNumber = current.attempts + 1;
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
      state.budget.attemptsUsed += 1;
      reserved = { task: clone(task), attemptId, attemptNumber };
      return true;
    }, { taskId: task.id, detail: { phase: "preparing" } });
    return reserved;
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
      if (TERMINAL_TASK_STATUSES.has(current.status)) return false;
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
    }, { taskId: entry.task.id, attemptId: entry.attemptId, detail: { outcome: stopResult.kind } });
  }

  async function stopEntry(entry, reason) {
    if (entry.stopPromise) {
      // A timeout before prepare exposed an owned runner is retryable once the
      // late prepare completes.  A real UNKNOWN stop result stays sticky.
      if (!(entry.stopRetryable && entry.runner)) return entry.stopPromise;
      entry.stopPromise = null;
      entry.stopRetryable = false;
    }
    if (entry.notSentProof) return { kind: "not-started", receipt: null, error: null };
    entry.abortController.abort();
    entry.stopPromise = (async () => {
      if (!entry.runner) {
        if (!entry.prepareStarted) return { kind: "not-started", receipt: null, error: null };
        const deadline = delay(stopWaitMs, { keepAlive: true });
        try {
          const settled = await Promise.race([
            entry.runnerReady,
            entry.promise?.then(() => ({ taskSettled: true })),
            deadline.then(() => ({ timeout: true }))
          ]);
          if (settled?.taskSettled && !entry.runner) return { kind: "not-started", receipt: null, error: null };
          if (settled?.timeout && !entry.runner) {
            entry.detached = true;
            entry.stopRetryable = true;
            return { kind: "unknown", receipt: null, error: { code: "EPLAN_RUNNER_STOP_TIMEOUT", message: "task adapter did not expose an owned runner before cancellation cleanup deadline", status: "UNKNOWN" } };
          }
        } finally {
          deadline.cancel();
        }
      }
      if (!entry.runner) return { kind: "not-started", receipt: null, error: null };
      try {
        const receiptValue = await entry.runner.stop({ reason, requestedBy: "native-v3-plan-runner" });
        const receipt = assertStopReceiptForAdmission(receiptValue, entry.admission, reason, entry.handleId);
        return { kind: "stopped", receipt, error: null };
      } catch (error) {
        return { kind: "unknown", receipt: null, error: errorProjection(error, "EPLAN_RUNNER_STOP") };
      }
    })();
    entry.stopPromise.catch(() => {});
    return entry.stopPromise;
  }

  async function stopAllActive(reason) {
    const entries = [...active.values()];
    const results = await Promise.all(entries.map(async (entry) => {
      const result = await stopEntry(entry, reason);
      await markTaskStop(entry, result);
      return { entry, result };
    }));
    for (const { entry } of results) {
      const deadline = delay(stopWaitMs, { keepAlive: true });
      try {
        const settled = await Promise.race([
          entry.promise.then(() => true),
          deadline.then(() => false)
        ]);
        if (!settled) entry.detached = true;
        if (settled || entry.detached) active.delete(entry.task.id);
      } finally {
        deadline.cancel();
      }
    }
    return results;
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
    const state = await readCheckpoint();
    const current = state.tasks[entry.task.id];
    if (TERMINAL_TASK_STATUSES.has(current.status)) {
      active.delete(entry.task.id);
      return state;
    }
    if (state.cancelRequested || state.dispatchBlocked || state.status !== "running") {
      const stopResult = await stopEntry(entry, state.cancelReason ?? cancelReason ?? "cancel");
      await markTaskStop(entry, stopResult);
      active.delete(entry.task.id);
      return readCheckpoint();
    }
    if (settlement.kind === "error") {
      const kind = errorClass(settlement.error);
      const stopResult = kind === "unknown" || kind === "hold"
        ? await stopEntry(entry, kind === "unknown" ? "controller-failure" : "cancel")
        : { kind: "not-started", receipt: null, error: null };
      if (stopResult.kind === "unknown") await markTaskStop(entry, stopResult);
      await transition(`task.${kind}`, (nextState) => {
        const taskState = nextState.tasks[entry.task.id];
        if (TERMINAL_TASK_STATUSES.has(taskState.status)) return false;
        taskState.status = kind;
        taskState.outcome = kind;
        taskState.finishedAt = nowIso(clock);
        taskState.lastError = errorProjection(settlement.error, kind === "unknown" ? "EPLAN_TASK_UNKNOWN" : "EPLAN_TASK_HOLD");
        if (kind === "unknown" || kind === "hold") {
          nextState.status = kind;
          nextState.dispatchBlocked = true;
          nextState.failure = taskState.lastError;
        }
        return true;
      }, { taskId: entry.task.id, attemptId: entry.attemptId, detail: { status: kind } });
      active.delete(entry.task.id);
      return readCheckpoint();
    }
    let result;
    try {
      result = validateTaskResult(settlement.value);
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
      await transition("task.result-invalid", (nextState) => {
        const taskState = nextState.tasks[entry.task.id];
        if (TERMINAL_TASK_STATUSES.has(taskState.status)) return false;
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
    const exceedsTaskSeconds = entry.task.budget.seconds !== null && current.usage.seconds + usage.seconds > entry.task.budget.seconds;
    const exceedsTaskTokens = entry.task.budget.tokens !== null && current.usage.tokens + usage.tokens > entry.task.budget.tokens;
    const exceedsPlanSeconds = state.budget.seconds !== null && state.budget.secondsUsed + usage.seconds > state.budget.seconds;
    const exceedsPlanTokens = state.budget.tokens !== null && state.budget.tokensUsed + usage.tokens > state.budget.tokens;
    if (exceedsTaskSeconds || exceedsTaskTokens || exceedsPlanSeconds || exceedsPlanTokens) {
      await transition("task.budget-exceeded", (nextState) => {
        const taskState = nextState.tasks[entry.task.id];
        taskState.status = "hold";
        taskState.outcome = result.outcome;
        taskState.finishedAt = nowIso(clock);
        taskState.lastError = { code: "EPLAN_BUDGET_EXCEEDED", message: "Task or WorkflowPlan resource budget was exceeded", status: "HOLD" };
        taskState.usage = { seconds: current.usage.seconds + usage.seconds, tokens: current.usage.tokens + usage.tokens };
        nextState.budget.secondsUsed += usage.seconds;
        nextState.budget.tokensUsed += usage.tokens;
        nextState.status = "hold";
        nextState.dispatchBlocked = true;
        nextState.failure = taskState.lastError;
        return true;
      }, { taskId: entry.task.id, attemptId: entry.attemptId, detail: { status: "budget-exceeded", outcome: result.outcome, usage } });
      active.delete(entry.task.id);
      return readCheckpoint();
    }
    const next = await transition(`task.${result.outcome}`, (nextState) => {
      const taskState = nextState.tasks[entry.task.id];
      taskState.usage = { seconds: current.usage.seconds + usage.seconds, tokens: current.usage.tokens + usage.tokens };
      nextState.budget.secondsUsed += usage.seconds;
      nextState.budget.tokensUsed += usage.tokens;
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
      if (localCancelRequested || abortSignal?.aborted) return { kind: "cancelled-before-prepare" };
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
      const rawPrepared = await options.taskAdapter.prepareTask(context);
      const candidate = validatePreparedTask(rawPrepared, { plan: pinnedPlan, task: entry.task, runId, attemptId: entry.attemptId });
      const admission = await readTrustedAdmission(candidate, {
        plan: pinnedPlan,
        task: entry.task,
        runId,
        attemptId: entry.attemptId,
        clock
      });
      const registry = await openExecutionRegistry({
        stateRoot,
        runId,
        controller: candidate.controller,
        resourceAdapter: candidate.resourceAdapter,
        clock,
        // Each DAG task has one independent runtime journal.  This keeps the
        // registry's short CAS sections independent while the plan runner's
        // checkpoint remains the cross-task scheduler authority.
        registryRoot: safeJoin(runnerRoot, "execution-runtime", entry.task.id)
      });
      const handle = await withRuntimeRetry(() => registry.createExecutionHandle(candidate.binding));
      const admissionDigest = digestExecutionAdmission(admission);
      if (handle.admissionDigest !== admissionDigest) {
        fail("EPLAN_RUNNER_ADMISSION", "runtime handle admission is not bound to the trusted candidate", "HOLD");
      }
      const prepared = {
        ...candidate,
        admission,
        registry,
        handle,
        runner: {
          execute: async () => {
            try {
              // Do not retry the whole runtime execution after a lease error:
              // its callback may already have started an external effect even
              // when the later seal CAS failed.  The registry's durable
              // UNKNOWN state is the only safe recovery result in that race.
              const faults = typeof candidate.onDispatchReservation === "function"
                ? {
                    afterDispatchBeforeEffect: async (intent) => candidate.onDispatchReservation({
                      task: clone(entry.task),
                      attemptId: entry.attemptId,
                      handle: clone(handle),
                      intent: clone(intent)
                    })
                  }
                : undefined;
              const execution = await registry.execute(
                handle.handleId,
                candidate.effect,
                faults === undefined ? undefined : { faults }
              );
              const effect = execution?.effect ?? execution;
              return validateTaskResult(effect);
            } catch (error) {
              if (isExecutionRuntimeEffectNotSent(error, {
                runId,
                handleId: handle.handleId,
                ownedResourceId: handle.ownedResourceId
              })) entry.notSentProof = true;
              throw error;
            }
          },
          stop: async ({ reason }) => withRuntimeRetry(() => registry.requestStop(handle.handleId, {
            reason,
            requestedBy: "native-v3-plan-runner",
            expectedEpoch: handle.authorityEpoch,
            expectedFence: handle.fence,
            expectedRevision: handle.revision
          }))
        }
      };
      entry.prepared = prepared;
      entry.admission = prepared.admission;
      entry.handleId = handle.handleId;
      entry.registry = registry;
      entry.runner = prepared.runner;
      if (entry.stopRetryable) entry.stopPromise = null;
      entry.stopRetryable = false;
      entry.runnerReadyResolve(prepared);
      const preparedState = await markPrepared(entry, {
        ...prepared,
        admissionDigest
      });
      if (preparedState.tasks[entry.task.id].status !== "preparing" || preparedState.cancelRequested || preparedState.dispatchBlocked) {
        const stopResult = await stopEntry(entry, preparedState.cancelReason ?? cancelReason ?? "cancel");
        return stopResult.kind === "stopped" ? { kind: "cancelled" } : { kind: "error", error: stopResult.error ?? new NativeV3PlanRunnerError("EPLAN_RUNNER_STOP", "prepared task could not be stopped", "UNKNOWN") };
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
      const dispatchState = await markDispatching(entry);
      if (dispatchState.tasks[entry.task.id].status !== "dispatching") {
        const stopResult = await stopEntry(entry, dispatchState.cancelReason ?? cancelReason ?? "cancel");
        return stopResult.kind === "stopped" ? { kind: "cancelled" } : { kind: "error", error: stopResult.error ?? new NativeV3PlanRunnerError("EPLAN_RUNNER_STOP", "task dispatch was blocked but cleanup was not proven", "UNKNOWN") };
      }
      const value = await prepared.runner.execute();
      return { kind: "result", value };
    } catch (error) {
      return { kind: "error", error };
    }
  }

  function launchTask(reserved) {
    const entry = {
      task: reserved.task,
      attemptId: reserved.attemptId,
      attemptNumber: reserved.attemptNumber,
      prepareStarted: false,
      prepared: null,
      admission: null,
      handleId: null,
      registry: null,
      runner: null,
      stopPromise: null,
      stopRetryable: false,
      notSentProof: false,
      detached: false,
      abortController: new AbortController(),
      runnerReady: null,
      runnerReadyResolve: null,
      promise: null
    };
    entry.runnerReady = new Promise((resolve) => { entry.runnerReadyResolve = resolve; });
    entry.runnerReady.catch(() => {});
    active.set(entry.task.id, entry);
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
          if (state.cancelRequested || localCancelRequested || abortSignal?.aborted) resolve({ kind: "cancel" });
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

  async function runLoop() {
    const onAbort = () => {
      void markCancelRequested("cancel").catch(() => {});
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      let state = await claimRun();
      if (TERMINAL_RUN_STATUSES.has(state.status)) return planRunnerResult(state);
      while (true) {
        state = await readCheckpoint();
        if (TERMINAL_RUN_STATUSES.has(state.status)) {
          if (state.status !== "succeeded" && pinnedPlan.taskContract.graph.tasks.some((task) => ["pending", "preparing"].includes(state.tasks[task.id].status))) {
            await finalize(state.status, state.failure);
            state = await readCheckpoint();
          }
          return planRunnerResult(state);
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
            return planRunnerResult(completed);
          }
          const pending = pinnedPlan.taskContract.graph.tasks.filter((task) => ["pending", "preparing", "dispatching"].includes(state.tasks[task.id].status));
          if (pending.length === 0) {
            await failRun("hold", new NativeV3PlanRunnerError("EPLAN_DAG_STALLED", "WorkflowPlan DAG has no ready task and is not complete", "HOLD"));
            return planRunnerResult(await readCheckpoint());
          }
          continue;
        }
        const activity = await waitForActivity();
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
        }
      }
    } finally {
      abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  async function run() {
    if (runPromise === null) runPromise = runLoop();
    return runPromise;
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

  return Object.freeze({
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
    reconcile,
    inspect,
    status: inspect
  });
}

export default createNativeV3PlanRunner;
