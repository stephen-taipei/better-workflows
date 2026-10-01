import { lstat } from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";

import { canonicalJson, digestObject } from "./core.mjs";
import {
  assertNativeCommandBindingMatchesApprovalEnvelope,
  readFreshNativeCommandBinding
} from "./native-command-binding-v1.mjs";
import {
  createCooperativeNativeV3Controller,
  createCooperativeNativeV3RecoveryController,
  isTrustedNativeV3Controller,
  nativeV3AllocationKeyFor
} from "./native-v3-cooperative-controller.mjs";
import {
  OWNED_PROCESS_BEFORE_LAUNCH_MAX_MS,
  createOwnedProcessAdapterV1
} from "./owned-process-adapter-v1.mjs";
import {
  isExecutionRuntimeEffectNotSent,
  openExecutionRegistry,
  validateExecutionHandleV1,
  validateStopReceiptV1
} from "./execution-runtime-v1.mjs";
import { openExecutionBudgetLedgerV1 } from "./execution-budget-ledger-v1.mjs";
import {
  assertIncidentRecoveryCommandBindingV1,
  assertIncidentRecoveryRuntimeSnapshotV1,
  deriveIncidentRecoveryLaunchFenceV1,
  incidentRecoveryEffectBindingDigestV1,
  readIncidentRecoveryReportV1,
  validateIncidentRecoveryPlanV1
} from "./incident-recovery-v1.mjs";
import { readFreshWorkflowPlanV1 } from "./workflow-plan-v1.mjs";
import { assertNativeV3AutoCommandExecutionAllowed } from "./native-v3-auto-execution-admission.mjs";
import {
  buildExecutionAdmission,
  digestExecutionAdmission,
  validateApprovalEnvelope
} from "./execution-admission-v1.mjs";

export const NATIVE_V3_COMMAND_RUNNER_KIND = "NativeV3CommandRunnerV1";
export const NATIVE_V3_COMMAND_RUNNER_TRUST_MODE = "cooperative-user-mode";
export const NATIVE_V3_EFFECT_NOT_SENT_KIND = "NativeV3EffectNotSentV1";
export const NATIVE_V3_COMMAND_SETTLEMENT_OBSERVATION_KIND = "NativeV3CommandSettlementObservationV1";
export const NATIVE_V3_RECOVERY_COMMAND_ADOPTION_VALIDATION_KIND = "NativeV3RecoveryCommandAdoptionValidationV1";

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
// The no-effect proof is deliberately process-local.  Public error fields can
// be copied or replaced by callers, so cleanup must consult only this private
// identity map and never treat serialized evidence as authority.
const EFFECT_NOT_SENT_EVIDENCE = new WeakMap();
// The plan runner may consume a command runner's already-created trusted
// controller/resource/effect only through this process-local capability.  A
// plain object with the same public shape is never admitted as a producer.
const TRUSTED_NATIVE_V3_COMMAND_RUNNERS = new WeakMap();
const COMMAND_PLAN_PREPARERS = new WeakMap();
const COMMAND_PLAN_PREPARATIONS = new WeakMap();
const PLAN_PREPARATION_STOP_WAIT_MS = 10_000;
// Passive settlement observation is not a run terminal or cleanup receipt.
// These caps affect only observation availability, never execution admission.
const COMMAND_SETTLEMENT_READERS = new WeakMap();
const COMMAND_ALLOCATION_UNCLAIMED_READERS = new WeakMap();
const COMMAND_PREPARED_STOP_REQUESTS = new WeakMap();
const COMMAND_SETTLEMENT_NOT_SENT = new WeakMap();
const COMMAND_OBSERVATION_MAX_BYTES = 1_048_576;
const COMMAND_OBSERVATION_MAX_NODES = 4_096;
const COMMAND_OBSERVATION_MAX_DEPTH = 32;
const RECOVERY_COMMAND_ADOPTION_EFFECT_AUTHORITY = Object.freeze({
  mayCreateHandle: false,
  mayResume: false,
  mayUnblockHandle: false,
  mayDispatch: false,
  mayPerformEffects: false
});

// openExecutionRegistry intentionally rejects concurrent owners of one run
// lease.  A trusted DAG creates one registry instance per task because each
// task owns a distinct controller/resource adapter, so coordinate only the
// short registry linearization sections in this process.  The handoff occurs
// as soon as the registry has invoked the effect callback; the owned effects
// themselves remain concurrent.  A second gate serializes callback return
// until its registry instance has sealed the result, avoiding a same-run CAS
// race without weakening the durable filesystem lease.
const NATIVE_V3_REGISTRY_COORDINATORS = new Map();
// macOS can take longer than one scheduler tick to durably remove the short
// runtime lease when sibling source/freshness reads are active. Keep the
// handoff bounded, but leave enough room for the owned callback linearization
// to complete before treating the effect as UNKNOWN.
const REGISTRY_HANDOFF_TIMEOUT_MS = 5_000;

function createRegistryHandoffGate() {
  let tail = Promise.resolve();
  return Object.freeze({
    enqueue: async (callback) => {
      const predecessor = tail;
      let resolveToken;
      const token = new Promise((resolve) => { resolveToken = resolve; });
      tail = token;
      await predecessor;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        resolveToken();
      };
      try {
        return await callback(release);
      } finally {
        // A pre-effect registry failure has no callback through which to hand
        // off.  Release its turn as soon as the failure settles.
        release();
      }
    },
    acquire: async () => {
      const predecessor = tail;
      let resolveToken;
      const token = new Promise((resolve) => { resolveToken = resolve; });
      tail = token;
      await predecessor;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        resolveToken();
      };
    }
  });
}

function registryCoordinatorFor(stateRoot, runId) {
  const key = `${path.resolve(stateRoot)}\u0000${runId}`;
  let coordinator = NATIVE_V3_REGISTRY_COORDINATORS.get(key);
  if (!coordinator) {
    coordinator = {
      key,
      active: 0,
      dispatch: createRegistryHandoffGate(),
      seal: createRegistryHandoffGate()
    };
    NATIVE_V3_REGISTRY_COORDINATORS.set(key, coordinator);
  }
  return coordinator;
}

function releaseRegistryCoordinator(coordinator) {
  coordinator.active -= 1;
  if (coordinator.active <= 0 && NATIVE_V3_REGISTRY_COORDINATORS.get(coordinator.key) === coordinator) {
    NATIVE_V3_REGISTRY_COORDINATORS.delete(coordinator.key);
  }
}

async function waitForRegistryLeaseRelease(registry) {
  const leasePath = path.join(registry.runDir, ".lease");
  const deadline = Date.now() + REGISTRY_HANDOFF_TIMEOUT_MS;
  while (true) {
    const lease = await lstat(leasePath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw unknownError("execution registry lease could not be observed", error);
    });
    if (lease === null) return;
    if (Date.now() >= deadline) {
      throw unknownError("execution registry lease did not clear before sibling dispatch", new Error("registry handoff timeout"));
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const STOP_REASONS = new Set(["cancel", "pause", "security-p0", "controller-failure"]);
const OPTION_KEYS = new Set([
  "stateRoot", "root", "workspaceRoot", "planId", "runId", "taskId", "unitId",
  "executionId", "attemptId", "bindingPath", "expectedCommandDigest",
  "approvalEnvelope", "effectBindingDigest", "sourceBinding", "policyDigest", "readFreshSourceBinding",
  "readTrustPolicy", "trustMode", "sourceCwd", "requestedModel", "ownerDecision", "clock",
  "allocationKey", "planTaskMode", "resumeFromHandleId", "resumeReason", "freshResolverTimeoutMs", "incidentRecoveryPlan"
]);
const EXECUTE_KEYS = new Set();
const STOP_KEYS = new Set(["reason", "requestedBy", "expectedEpoch", "expectedFence", "expectedRevision"]);
const RECOVERY_OPTION_KEYS = new Set([
  "stateRoot", "root", "planId", "runId", "taskId", "unitId", "executionId", "attemptId",
  "handleId", "allocationKey", "sourceBinding", "policyDigest", "readFreshSourceBinding",
  "readTrustPolicy", "trustMode", "sourceCwd", "clock", "expectedSequence", "timeoutMs", "abortSignal"
]);
const RECOVERY_ADOPTION_VALIDATION_KEYS = new Set([
  "stateRoot", "workspaceRoot", "planId", "runId", "taskId", "unitId", "handle",
  "controller", "bindingPath", "expectedCommandDigest", "approvalEnvelope", "effectBindingDigest",
  "recoveryPlanDigest", "sourceBinding", "policyDigest", "trustMode", "requestedModel", "clock"
]);

export function isNativeV3CommandRunner(value) {
  return Boolean(value && typeof value === "object" && TRUSTED_NATIVE_V3_COMMAND_RUNNERS.has(value));
}

export function getNativeV3PlanTaskCapability(value) {
  if (!isNativeV3CommandRunner(value)) return null;
  return TRUSTED_NATIVE_V3_COMMAND_RUNNERS.get(value) ?? null;
}

function preparationStopWait(value = PLAN_PREPARATION_STOP_WAIT_MS) {
  if (!Number.isSafeInteger(value) || value < 25 || value > PLAN_PREPARATION_STOP_WAIT_MS) {
    throw fail("ENATIVE_V3_RUNNER_INPUT", "preparation stop observer wait is invalid", "HOLD");
  }
  return value;
}

export function beginNativeV3CommandPlanPreparation(runner, context, { stopWaitMs } = {}) {
  const prepare = COMMAND_PLAN_PREPARERS.get(runner);
  if (!isNativeV3CommandRunner(runner) || !prepare) {
    throw fail("ENATIVE_V3_PLAN_TASK_BINDING", "preparation requires the original command runner", "HOLD");
  }
  return prepare(context, preparationStopWait(stopWaitMs));
}

export function readNativeV3CommandPlanPreparation(invocation) {
  const state = COMMAND_PLAN_PREPARATIONS.get(invocation);
  if (!state) throw fail("ENATIVE_V3_PLAN_TASK_BINDING", "command preparation identity is invalid", "UNKNOWN");
  return Object.freeze({
    ownership: state.claimedHere ? "owned" : state.settled ? "unowned" : "pending",
    settled: state.settled,
    cleanup: state.claimedHere ? state.cleanup : null,
    failureCleanup: state.failureCleanup
  });
}

export function readNativeV3CommandSettlementObservation(runner) {
  if (!isNativeV3CommandRunner(runner)) return null;
  return COMMAND_SETTLEMENT_READERS.get(runner)?.() ?? null;
}

// This is a same-process ownership predicate, not a durable terminal status
// or authority token. Only the factory's actual one-shot claim is observed.
export function isNativeV3CommandAllocationUnclaimed(runner) {
  return isNativeV3CommandRunner(runner) &&
    COMMAND_ALLOCATION_UNCLAIMED_READERS.get(runner)?.() === true;
}

// The original factory reference conveys only its existing exact-scope stop
// right. It is not evidence that this invocation created the durable handle.
export function requestNativeV3PreparedCommandStop(runner) {
  const request = COMMAND_PREPARED_STOP_REQUESTS.get(runner);
  if (!isNativeV3CommandRunner(runner) || !request) {
    throw fail("ENATIVE_V3_CLI_CLEANUP_SCOPE", "Prepared cleanup requires the original command runner", "UNKNOWN");
  }
  return request();
}

// A copied error or observation cannot acquire the original no-effect proof.
// The exact factory runner also binds this lookup to its private allocation.
export function isNativeV3CommandSettlementEffectNotSent(observation, runner) {
  return isNativeV3CommandRunner(runner) &&
    COMMAND_SETTLEMENT_NOT_SENT.get(observation) === runner;
}

function copyCommandObservationData(value) {
  // Private command DTO copier, not a universal JS object classifier. Inputs
  // must originate in the admitted registry branch / ledger attachment below.
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set();
  const copies = new WeakMap();
  const charge = (amount) => {
    bytes += amount;
    if (bytes > COMMAND_OBSERVATION_MAX_BYTES) throw new Error("command observation byte limit");
  };
  const visit = (item, depth) => {
    if (++nodes > COMMAND_OBSERVATION_MAX_NODES || depth > COMMAND_OBSERVATION_MAX_DEPTH) {
      throw new Error("command observation structural limit");
    }
    charge(16);
    if (item === null || item === undefined || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string") {
      if (item.length > COMMAND_OBSERVATION_MAX_BYTES) throw new Error("command observation string limit");
      charge(Buffer.byteLength(item, "utf8"));
      return item;
    }
    if (typeof item !== "object" || utilTypes.isProxy(item) || ancestors.has(item)) {
      throw new Error("unsupported command observation data");
    }
    // Prototype changes do not remove intrinsic slots. Never admit a hidden
    // Map/buffer/etc. merely because it now resembles a plain data object.
    if ([utilTypes.isArgumentsObject, utilTypes.isAnyArrayBuffer, utilTypes.isArrayBufferView,
      utilTypes.isBoxedPrimitive, utilTypes.isDate, utilTypes.isMap, utilTypes.isSet,
      utilTypes.isMapIterator, utilTypes.isSetIterator,
      utilTypes.isWeakMap, utilTypes.isWeakSet, utilTypes.isNativeError, utilTypes.isPromise,
      utilTypes.isRegExp, utilTypes.isModuleNamespaceObject, utilTypes.isGeneratorObject,
      utilTypes.isExternal, utilTypes.isKeyObject, utilTypes.isCryptoKey].some((check) => check(item))) {
      throw new Error("unsupported command observation intrinsic type");
    }
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error("unsupported command observation prototype");
    }
    if (copies.has(item)) return copies.get(item);
    const keys = Reflect.ownKeys(item);
    if (keys.length > COMMAND_OBSERVATION_MAX_NODES) throw new Error("command observation key limit");
    const copied = array ? [] : Object.create(prototype);
    copies.set(item, copied);
    ancestors.add(item);
    try {
      for (const key of keys) {
        if (typeof key !== "string" || key.length > COMMAND_OBSERVATION_MAX_BYTES) {
          throw new Error("unsupported command observation key");
        }
        charge(Buffer.byteLength(key, "utf8"));
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor)) throw new Error("command observation accessor");
        if (array && key === "length") {
          if (descriptor.value > COMMAND_OBSERVATION_MAX_NODES) throw new Error("command observation array limit");
          copied.length = descriptor.value;
          continue;
        }
        if (!descriptor.enumerable) throw new Error("command observation non-data property");
        Object.defineProperty(copied, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
    } finally {
      ancestors.delete(item);
    }
    return copied;
  };
  // Construct only the validated data properties. No serializer may inspect
  // hidden slots or execute callbacks outside this bounded traversal.
  return visit(value, 0);
}

function commandObservationErrorProjection(error, trustedBudgetReceipt) {
  if (!error || typeof error !== "object" || utilTypes.isProxy(error) || !utilTypes.isNativeError(error)) {
    throw new Error("unsupported command observation rejection");
  }
  const prototype = Object.getPrototypeOf(error);
  // Native producer Error subclasses can have custom prototypes. Project
  // only own scalar data, without following a custom inherited name getter.
  const builtinPrototype = [Error.prototype, TypeError.prototype, RangeError.prototype, SyntaxError.prototype,
    ReferenceError.prototype, URIError.prototype, EvalError.prototype].includes(prototype);
  const projection = {
    name: builtinPrototype ? Object.getOwnPropertyDescriptor(prototype, "name").value : "Error",
    hasCause: Object.hasOwn(error, "cause"),
    hasBudgetSettlementError: Object.hasOwn(error, "budgetSettlementError")
  };
  for (const key of ["name", "message", "code", "status", "budgetReceipt"]) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) throw new Error("command observation error accessor");
    if (key === "budgetReceipt") {
      if (trustedBudgetReceipt === undefined || descriptor.value !== trustedBudgetReceipt) {
        throw new Error("command observation untrusted budget attachment");
      }
    } else if (descriptor.value !== undefined && typeof descriptor.value !== "string") {
      throw new Error("command observation non-string error field");
    }
    Object.defineProperty(projection, key, { value: descriptor.value, enumerable: true, configurable: true });
  }
  if (trustedBudgetReceipt !== undefined && !Object.hasOwn(projection, "budgetReceipt")) {
    throw new Error("command observation missing budget attachment");
  }
  return projection;
}

function fail(code, message, status = undefined) {
  const error = new Error(message);
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

function plain(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("ENATIVE_V3_RUNNER_INPUT", `${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw fail("ENATIVE_V3_RUNNER_INPUT", `${label} must be a plain object`);
  return value;
}

function exactOptions(value, allowed, label) {
  if (value === undefined) return {};
  plain(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw fail("ENATIVE_V3_RUNNER_INPUT", `${label} contains unknown option(s): ${unknown.sort().join(", ")}`);
  return value;
}

function text(value, label, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw fail("ENATIVE_V3_RUNNER_INPUT", `${label} is invalid`);
  }
  if (pattern && !pattern.test(value)) throw fail("ENATIVE_V3_RUNNER_INPUT", `${label} is invalid`);
  return value;
}

function absolute(value, label) {
  const supplied = text(value, label);
  if (!path.isAbsolute(supplied)) throw fail("ENATIVE_V3_RUNNER_INPUT", `${label} must be absolute`);
  return path.resolve(supplied);
}

function digest(value, label) {
  return text(value, label, DIGEST);
}

function identifier(value, label) {
  return text(value, label, ID);
}

function clone(value) {
  return structuredClone(value);
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sourceBinding(value, label = "sourceBinding") {
  plain(value, label);
  return {
    revision: text(value.revision, `${label}.revision`, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
    digest: digest(value.digest, `${label}.digest`)
  };
}

function currentDate(clock) {
  const value = clock?.now?.() ?? new Date();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw fail("ENATIVE_V3_RUNNER_INPUT", "clock.now() must return a valid date");
  return date;
}

function unknownError(message, cause = undefined) {
  const error = fail("ENATIVE_V3_EXECUTION_UNKNOWN", message, "UNKNOWN");
  if (cause !== undefined) error.cause = cause;
  return error;
}

function effectNotSentError(cause, allocation) {
  const evidence = Object.freeze({
    schemaVersion: 1,
    kind: NATIVE_V3_EFFECT_NOT_SENT_KIND,
    runId: allocation.runId,
    handleId: allocation.handleId,
    ownedResourceId: allocation.ownedResourceId,
    callbackStarted: false
  });
  const wrapped = fail(
    "EFFECT_NOT_SENT",
    `Execution effect was not sent: ${cause?.message ?? String(cause)}`,
    cause?.status ?? "HOLD"
  );
  wrapped.cause = cause;
  wrapped.effectNotSent = evidence;
  EFFECT_NOT_SENT_EVIDENCE.set(wrapped, evidence);
  return wrapped;
}

export function isNativeV3EffectNotSent(error, expected = undefined) {
  if (!error || error.code !== "EFFECT_NOT_SENT") return false;
  const evidence = EFFECT_NOT_SENT_EVIDENCE.get(error);
  if (!evidence || evidence.schemaVersion !== 1 || evidence.kind !== NATIVE_V3_EFFECT_NOT_SENT_KIND ||
      evidence.callbackStarted !== false || typeof evidence.runId !== "string" ||
      typeof evidence.handleId !== "string" || typeof evidence.ownedResourceId !== "string") {
    return false;
  }
  if (expected !== undefined) {
    if (!expected || evidence.runId !== expected.runId || evidence.handleId !== expected.handleId ||
        evidence.ownedResourceId !== expected.ownedResourceId) return false;
  }
  return true;
}

const EXPECTED_STOP_MISMATCHES = new Set([
  "stop expected authority epoch mismatch",
  "stop expected fence mismatch",
  "stop expected revision mismatch"
]);

function isExpectedStopMismatch(error) {
  return EXPECTED_STOP_MISMATCHES.has(error?.message);
}

function assertFreshBindingMatchesPlan(binding, plan, { taskId, unitId, source, policy }) {
  const checks = [
    ["planDigest", binding.planDigest, plan.planDigest],
    ["contractDigest", binding.contractDigest, plan.contractDigest],
    ["taskId", binding.taskId, taskId],
    ["unitId", binding.unitId, unitId],
    ["sourceBindingDigest", binding.sourceBindingDigest, source.digest],
    ["policyDigest", binding.policyDigest, policy],
    ["revision", binding.revision, source.revision]
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) throw fail("ENATIVE_V3_BINDING_PLAN", `binding.${label} is not bound to the persisted WorkflowPlan`);
  }
}

function assertSingleTaskPlan(plan, taskId, { allowGraph = false } = {}) {
  const tasks = plan.taskContract?.graph?.tasks;
  if (!Array.isArray(tasks)) throw fail("ENATIVE_V3_PLAN_HOLD", "WorkflowPlan graph is unavailable", "HOLD");
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw fail("ENATIVE_V3_PLAN_HOLD", `WorkflowPlan task is missing: ${taskId}`, "HOLD");
  if (!allowGraph && (tasks.length !== 1 || task.dependencies.length !== 0)) {
    throw fail("ENATIVE_V3_GRAPH_UNSUPPORTED", "Native V3 command runner currently supports one dependency-free task", "HOLD");
  }
  return task;
}

function normalizeStatus(state, handleId) {
  const handle = handleId ? state.handles?.[handleId] ?? null : null;
  const intent = handleId
    ? Object.values(state.intents ?? {}).find((item) => item.handleId === handleId) ?? null
    : null;
  const stopReceipts = handleId
    ? Object.values(state.stopReceipts ?? {}).filter((item) => item.handleId === handleId)
    : [];
  return clone({
    schemaVersion: 1,
    kind: "NativeV3CommandRunnerStatusV1",
    status: handle?.status ?? "ready",
    handle,
    intent,
    stopReceipts
  });
}

/**
 * Revalidate one existing dispatch-blocked recovery handle against the native
 * cooperative controller and a fresh approval-bound command.  This is an
 * internal B2b1 inspection seam: it creates no registry handle or adapter,
 * performs no runtime transition, and returns no execute callback.  The plan
 * runner remains the sole owner of the process-local adoption brand.
 */
async function readRecoveryCommandCanonicalBoundary(options = {}) {
  exactOptions(options, RECOVERY_ADOPTION_VALIDATION_KEYS, "recovery command adoption options");
  const stateRoot = absolute(options.stateRoot, "stateRoot");
  const workspaceRoot = absolute(options.workspaceRoot, "workspaceRoot");
  const planId = identifier(options.planId, "planId");
  const runId = text(options.runId, "runId", ID);
  const taskId = identifier(options.taskId, "taskId");
  const unitId = identifier(options.unitId, "unitId");
  const expectedCommandDigest = digest(options.expectedCommandDigest, "expectedCommandDigest");
  const effectBindingDigest = digest(options.effectBindingDigest, "effectBindingDigest");
  const recoveryPlanDigest = digest(options.recoveryPlanDigest, "recoveryPlanDigest");
  text(options.bindingPath, "bindingPath");
  if (options.trustMode !== NATIVE_V3_COMMAND_RUNNER_TRUST_MODE) {
    throw fail(
      "EHOST_TRUST_REQUIRED",
      `trustMode must be ${NATIVE_V3_COMMAND_RUNNER_TRUST_MODE}`,
      "HOLD"
    );
  }
  if (!isTrustedNativeV3Controller(options.controller)) {
    throw fail(
      "ENATIVE_V3_RECOVERY_ADOPTION_CONTROLLER",
      "recovery adoption requires the native cooperative owner-approved controller",
      "HOLD"
    );
  }
  if (typeof options.controller.readExecutionBinding !== "function") {
    throw fail(
      "ENATIVE_V3_RECOVERY_ADOPTION_CONTROLLER",
      "recovery adoption requires one atomic trusted execution-binding reader",
      "HOLD"
    );
  }

  let handle;
  try {
    handle = validateExecutionHandleV1(options.handle);
  } catch (error) {
    const wrapped = fail(
      "ENATIVE_V3_RECOVERY_ADOPTION_HANDLE",
      `recovery adoption handle is invalid: ${String(error?.message ?? error)}`,
      "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  if (handle.runId !== runId || handle.attemptId.length === 0 || handle.unitId !== unitId ||
      handle.status !== "ready" || handle.dispatchBlocked !== true || handle.revokedAt !== null ||
      typeof handle.admissionDigest !== "string") {
    throw fail(
      "ENATIVE_V3_RECOVERY_ADOPTION_HANDLE",
      "recovery adoption requires the exact untouched dispatch-blocked handoff handle",
      "HOLD"
    );
  }

  const envelope = validateApprovalEnvelope(options.approvalEnvelope);
  if (envelope.runId !== runId || envelope.executionId !== handle.executionId ||
      envelope.attemptId !== handle.attemptId || envelope.ownedResourceId !== handle.ownedResourceId ||
      envelope.taskId !== taskId || envelope.unitId !== unitId ||
      envelope.sourceBindingDigest !== handle.sourceBindingDigest ||
      envelope.policyDigest !== handle.policyDigest || envelope.revision !== handle.revision) {
    throw fail(
      "ENATIVE_V3_RECOVERY_ADOPTION_APPROVAL",
      "ApprovalEnvelope is not exact to the recovery handoff handle",
      "HOLD"
    );
  }
  if (options.requestedModel !== undefined && envelope.requestedModel !== options.requestedModel) {
    throw fail(
      "ENATIVE_V3_RECOVERY_ADOPTION_APPROVAL",
      "requestedModel is not the exact owner-approved model selection",
      "HOLD"
    );
  }

  const workflowPlan = await readFreshWorkflowPlanV1({
    root: stateRoot,
    planId,
    expected: {
      planDigest: envelope.planDigest,
      contractDigest: envelope.contractDigest,
      sourceRevision: handle.revision,
      sourceDigest: handle.sourceBindingDigest,
      policyDigest: handle.policyDigest
    }
  });
  assertNativeV3AutoCommandExecutionAllowed(workflowPlan);
  assertSingleTaskPlan(workflowPlan, taskId, { allowGraph: true });
  const persistedSource = sourceBinding(workflowPlan.taskContract.bindings.source, "WorkflowPlan source binding");
  const source = options.sourceBinding === undefined
    ? persistedSource
    : sourceBinding(options.sourceBinding);
  if (!same(source, persistedSource)) {
    throw fail("ESOURCE_BINDING_DRIFT", "sourceBinding is not the persisted plan binding", "HOLD");
  }
  const persistedPolicy = digest(workflowPlan.taskContract.bindings.policy.digest, "WorkflowPlan policy digest");
  const policyDigest = options.policyDigest === undefined
    ? persistedPolicy
    : digest(options.policyDigest, "policyDigest");
  if (policyDigest !== persistedPolicy) {
    throw fail("EPOLICY_TRUST_DRIFT", "policyDigest is not the persisted plan binding", "HOLD");
  }

  const commandBinding = await readFreshNativeCommandBinding({
    root: stateRoot,
    target: options.bindingPath,
    expectedDigest: expectedCommandDigest,
    workspaceRoot,
    requirePrivate: true
  });
  assertFreshBindingMatchesPlan(commandBinding, workflowPlan, { taskId, unitId, source, policy: policyDigest });
  assertNativeCommandBindingMatchesApprovalEnvelope(commandBinding, envelope, { workspaceRoot });
  if (commandBinding.recipient !== envelope.recipient || commandBinding.action !== envelope.action) {
    throw fail(
      "ENATIVE_V3_RECOVERY_ADOPTION_APPROVAL",
      "command binding recipient/action differs from the exact ApprovalEnvelope",
      "HOLD"
    );
  }
  const canonicalEffectBindingDigest = incidentRecoveryEffectBindingDigestV1({
    commandDigest: commandBinding.commandDigest,
    recoveryPlanDigest
  });
  if (effectBindingDigest !== canonicalEffectBindingDigest) {
    throw fail(
      "ENATIVE_V3_RECOVERY_ADOPTION_BINDING",
      "effectBindingDigest is not bound to the fresh command and exact DAG recovery plan",
      "HOLD"
    );
  }

  return { stateRoot, workspaceRoot, planId, runId, taskId, unitId, handle, envelope,
    workflowPlan, commandBinding, recoveryPlanDigest, effectBindingDigest, canonicalEffectBindingDigest };
}

// Observation only: this deliberately does not read or acquire controller
// state, and cannot grant dispatch authority. Initial adoption still uses
// the full controller validation below.
export async function revalidateNativeV3RecoveryCommandCanonicalV1(options = {}) {
  const canonical = await readRecoveryCommandCanonicalBoundary(options);
  return freezeDeep({ workflowPlan: clone(canonical.workflowPlan), commandBinding: clone(canonical.commandBinding) });
}

export async function prepareNativeV3RecoveryCommandAdoptionV1(options = {}) {
  const { runId, taskId, unitId, handle, envelope, workflowPlan, commandBinding,
    recoveryPlanDigest, effectBindingDigest, canonicalEffectBindingDigest } = await readRecoveryCommandCanonicalBoundary(options);
  const executionBinding = {
    runId: handle.runId,
    executionId: handle.executionId,
    attemptId: handle.attemptId,
    unitId: handle.unitId,
    sourceBindingDigest: handle.sourceBindingDigest,
    policyDigest: handle.policyDigest,
    revision: handle.revision,
    ownedResourceId: handle.ownedResourceId
  };
  const observed = await options.controller.readExecutionBinding({
    runId,
    binding: clone(executionBinding)
  });
  if (!observed || !observed.runContract || !observed.authority ||
      observed.sourceBinding?.runId !== runId || observed.sourceBinding?.revision !== handle.revision ||
      observed.sourceBinding?.digest !== handle.sourceBindingDigest ||
      observed.effectBindingDigest !== canonicalEffectBindingDigest) {
    throw fail(
      "ENATIVE_V3_RECOVERY_ADOPTION_AUTHORITY",
      "native controller returned no exact atomic source, owner-effect binding, and authority observation",
      "HOLD"
    );
  }
  let admission;
  try {
    const built = buildExecutionAdmission({
      runContract: observed.runContract,
      authority: observed.authority,
      binding: executionBinding,
      now: currentDate(options.clock)
    });
    admission = built.admission;
    if (!same(built.envelope, envelope) || digestExecutionAdmission(admission) !== handle.admissionDigest) {
      throw new Error("native controller admission differs from the immutable recovery handle");
    }
  } catch (error) {
    const wrapped = fail(
      "ENATIVE_V3_RECOVERY_ADOPTION_AUTHORITY",
      `native recovery admission is stale or not exact: ${String(error?.message ?? error)}`,
      "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  for (const key of [
    "launchReservation",
    "launchAuthorization",
    "launchCommitment",
    "launchTransaction",
    "launchResolution"
  ]) {
    if ((observed[key] ?? null) !== null) {
      throw fail(
        "ENATIVE_V3_RECOVERY_ADOPTION_LAUNCH_STATE",
        `native controller ${key} is already populated`,
        "HOLD"
      );
    }
  }

  const body = {
    schemaVersion: 1,
    kind: NATIVE_V3_RECOVERY_COMMAND_ADOPTION_VALIDATION_KIND,
    status: "validated",
    runId,
    planId: workflowPlan.planId,
    planDigest: workflowPlan.planDigest,
    contractDigest: workflowPlan.contractDigest,
    taskId,
    unitId,
    handleId: handle.handleId,
    handleDigest: digestObject(handle),
    executionId: handle.executionId,
    attemptId: handle.attemptId,
    ownedResourceId: handle.ownedResourceId,
    admissionDigest: handle.admissionDigest,
    approvalEnvelopeDigest: envelope.digest,
    commandDigest: commandBinding.commandDigest,
    recoveryPlanDigest,
    effectBindingDigest,
    sourceBindingDigest: handle.sourceBindingDigest,
    policyDigest: handle.policyDigest,
    revision: handle.revision,
    authorityEpoch: handle.authorityEpoch,
    fence: handle.fence,
    controllerId: options.controller.controllerId,
    callbackCalls: 0,
    effectStarted: false,
    effectAuthority: clone(RECOVERY_COMMAND_ADOPTION_EFFECT_AUTHORITY),
    validatedAt: currentDate(options.clock).toISOString()
  };
  const validation = freezeDeep({ ...body, validationDigest: digestObject(body) });
  return Object.freeze({
    validation,
    commandBinding: freezeDeep(clone(commandBinding)),
    admission: freezeDeep(clone(admission))
  });
}

/**
 * Construct one already-approved, single-task native V3 command runner.
 * Construction performs only fresh reads and durable handle allocation; it
 * never prepares an allocation or issues an approval.
 */
export async function createNativeV3CommandRunner(options = {}) {
  exactOptions(options, OPTION_KEYS, "createNativeV3CommandRunner options");
  const stateRootInput = options.stateRoot ?? options.root;
  const stateRoot = absolute(stateRootInput, "stateRoot");
  if (options.stateRoot !== undefined && options.root !== undefined && absolute(options.root, "root") !== stateRoot) {
    throw fail("ENATIVE_V3_RUNNER_INPUT", "stateRoot and root must refer to the same directory");
  }
  const workspaceRoot = absolute(options.workspaceRoot, "workspaceRoot");
  const planId = identifier(options.planId, "planId");
  const runId = text(options.runId, "runId", ID);
  const taskId = identifier(options.taskId, "taskId");
  const unitId = identifier(options.unitId, "unitId");
  const planTaskMode = options.planTaskMode;
  if (planTaskMode !== undefined && planTaskMode !== "trusted-plan-task") {
    throw fail("ENATIVE_V3_RUNNER_INPUT", "planTaskMode is invalid");
  }
  const envelope = validateApprovalEnvelope(options.approvalEnvelope);
  const executionId = identifier(options.executionId ?? envelope.executionId, "executionId");
  const attemptId = identifier(options.attemptId ?? envelope.attemptId, "attemptId");
  if (executionId !== envelope.executionId || attemptId !== envelope.attemptId) {
    throw fail("ENATIVE_V3_RUNNER_INPUT", "execution identity must match the ApprovalEnvelope");
  }
  let allocationKey;
  if (options.allocationKey !== undefined) {
    const expectedAllocationKey = nativeV3AllocationKeyFor({ taskId, attemptId });
    if (options.allocationKey !== expectedAllocationKey) {
      throw fail("ENATIVE_V3_RUNNER_INPUT", "allocationKey is not bound to the exact task/attempt identity", "HOLD");
    }
    allocationKey = options.allocationKey;
  }
  if (planTaskMode === "trusted-plan-task" && allocationKey === undefined) {
    throw fail("ENATIVE_V3_RUNNER_INPUT", "trusted plan task runners require a task/attempt allocation key", "HOLD");
  }
  const resumeFromHandleId = options.resumeFromHandleId === undefined
    ? undefined
    : identifier(options.resumeFromHandleId, "resumeFromHandleId");
  const resumeReason = options.resumeReason === undefined ? "reconcile-not-sent" : text(options.resumeReason, "resumeReason");
  const incidentRecoveryPlan = options.incidentRecoveryPlan === undefined
    ? null
    : validateIncidentRecoveryPlanV1(options.incidentRecoveryPlan);
  if (incidentRecoveryPlan !== null) {
    if (resumeFromHandleId !== incidentRecoveryPlan.handleId ||
        executionId !== incidentRecoveryPlan.newExecutionId ||
        attemptId !== incidentRecoveryPlan.newAttemptId) {
      throw fail("EINCIDENT_RECOVERY_BINDING", "incident recovery plan is not bound to the single fresh resume", "HOLD");
    }
  }
  const expectedCommandDigest = digest(options.expectedCommandDigest, "expectedCommandDigest");
  text(options.bindingPath, "bindingPath");
  if (typeof options.readFreshSourceBinding !== "function") throw fail("ESOURCE_FRESHNESS_UNAVAILABLE", "readFreshSourceBinding is required", "HOLD");
  if (typeof options.readTrustPolicy !== "function") throw fail("EPOLICY_TRUST_UNRESOLVED", "readTrustPolicy is required", "HOLD");
  if (options.trustMode !== NATIVE_V3_COMMAND_RUNNER_TRUST_MODE) {
    throw fail("EHOST_TRUST_REQUIRED", `trustMode must be ${NATIVE_V3_COMMAND_RUNNER_TRUST_MODE}`, "HOLD");
  }

  const initialPlan = await readFreshWorkflowPlanV1({
    root: stateRoot,
    planId,
    expected: { planDigest: envelope.planDigest, contractDigest: envelope.contractDigest }
  });
  assertNativeV3AutoCommandExecutionAllowed(initialPlan);
  const task = assertSingleTaskPlan(initialPlan, taskId, { allowGraph: planTaskMode === "trusted-plan-task" });
  const persistedSource = sourceBinding(initialPlan.taskContract.bindings.source, "WorkflowPlan source binding");
  const source = options.sourceBinding === undefined ? persistedSource : sourceBinding(options.sourceBinding);
  if (!same(source, persistedSource)) throw fail("ESOURCE_BINDING_DRIFT", "sourceBinding is not the persisted plan binding", "HOLD");
  const persistedPolicy = digest(initialPlan.taskContract.bindings.policy.digest, "WorkflowPlan policy digest");
  const policyDigest = options.policyDigest === undefined ? persistedPolicy : digest(options.policyDigest, "policyDigest");
  if (policyDigest !== persistedPolicy) throw fail("EPOLICY_TRUST_DRIFT", "policyDigest is not the persisted plan binding", "HOLD");

  const binding = await readFreshNativeCommandBinding({
    root: stateRoot,
    target: options.bindingPath,
    expectedDigest: expectedCommandDigest,
    workspaceRoot,
    requirePrivate: true
  });
  assertFreshBindingMatchesPlan(binding, initialPlan, { taskId, unitId, source, policy: policyDigest });
  assertNativeCommandBindingMatchesApprovalEnvelope(binding, envelope, { workspaceRoot });
  if (binding.recipient !== envelope.recipient || binding.action !== envelope.action) {
    throw fail("ENATIVE_V3_BINDING_APPROVAL", "binding recipient/action differs from the exact ApprovalEnvelope");
  }
  let effectBindingDigest = binding.commandDigest;
  if (incidentRecoveryPlan !== null) {
    const incidentBinding = assertIncidentRecoveryCommandBindingV1({
      plan: incidentRecoveryPlan,
      workflowPlan: initialPlan,
      approvalEnvelope: envelope,
      commandBinding: binding,
      sourceBinding: source,
      policyDigest,
      runId,
      taskId,
      unitId,
      ownerDecision: options.ownerDecision
    });
    effectBindingDigest = incidentBinding.effectBindingDigest;
  }
  if (options.effectBindingDigest !== undefined &&
      digest(options.effectBindingDigest, "effectBindingDigest") !== effectBindingDigest) {
    throw fail("ENATIVE_V3_BINDING_APPROVAL", "effectBindingDigest is not bound to the fresh command and recovery plan", "HOLD");
  }

  const selectedModel = options.requestedModel ?? envelope.requestedModel;
  const controllerOptions = {
    stateRoot,
    planId,
    runId,
    taskId,
    unitId,
    executionId,
    attemptId,
    recipient: binding.recipient,
    action: binding.action,
    approvalEnvelope: envelope,
    sourceBinding: source,
    policyDigest,
    requestedModel: selectedModel,
    readFreshSourceBinding: options.readFreshSourceBinding,
    readTrustPolicy: options.readTrustPolicy,
    sourceCwd: options.sourceCwd,
    trustMode: options.trustMode,
    clock: options.clock,
    freshResolverTimeoutMs: options.freshResolverTimeoutMs
  };
  if (incidentRecoveryPlan !== null) {
    // The fence is derived only after the fresh command, plan, envelope, and
    // opaque owner decision have been checked. It is a revision descriptor;
    // the controller still performs the final lock-scoped incident read and
    // owns the actual launch authority.
    controllerOptions.incidentRecoveryLaunchFence = deriveIncidentRecoveryLaunchFenceV1({
      plan: incidentRecoveryPlan,
      commandDigest: binding.commandDigest,
      effectBindingDigest
    });
  }
  if (allocationKey !== undefined) controllerOptions.allocationKey = allocationKey;
  if (options.ownerDecision !== undefined) {
    // The effect binding is derived from the freshly validated canonical
    // command, and for recovery also the immutable incident plan. Callers
    // may supply only the opaque owner decision handle; they cannot
    // substitute a separate digest projection.
    controllerOptions.effectBindingDigest = effectBindingDigest;
    controllerOptions.ownerDecision = options.ownerDecision;
  }
  const accepted = await createCooperativeNativeV3Controller(controllerOptions);
  const executionBinding = freezeDeep(clone(accepted.binding));
  if (typeof accepted.controller.readStopAuthority !== "function") {
    throw fail("ESTOP_AUTHORITY_UNAVAILABLE", "cooperative controller must provide a trusted readStopAuthority", "HOLD");
  }
  const runtimeController = accepted.controller;
  const budgetSeconds = task.budget.seconds;
  const beforeLaunchTimeoutMs = budgetSeconds === null
    ? OWNED_PROCESS_BEFORE_LAUNCH_MAX_MS
    : Math.min(OWNED_PROCESS_BEFORE_LAUNCH_MAX_MS, budgetSeconds * 1000);

  let adapter;
  let registry;
  const beforeLaunch = async (executionContext) => {
    if (!same(executionContext.binding, executionBinding)) throw unknownError("adapter execution binding changed before launch");
    const freshBinding = await readFreshNativeCommandBinding({
      root: stateRoot,
      target: options.bindingPath,
      expectedDigest: expectedCommandDigest,
      workspaceRoot,
      requirePrivate: true
    });
    assertFreshBindingMatchesPlan(freshBinding, initialPlan, { taskId, unitId, source, policy: policyDigest });
    assertNativeCommandBindingMatchesApprovalEnvelope(freshBinding, envelope, { workspaceRoot });
    if (incidentRecoveryPlan !== null) {
      assertIncidentRecoveryCommandBindingV1({
        plan: incidentRecoveryPlan,
        workflowPlan: initialPlan,
        approvalEnvelope: envelope,
        commandBinding: freshBinding,
        sourceBinding: source,
        policyDigest,
        runId,
        taskId,
        unitId,
        ownerDecision: options.ownerDecision
      });
      await assertIncidentRecoveryCurrent();
    }
    const authority = await accepted.controller.readAuthority(clone(executionBinding));
    if (authority.status !== "active" || authority.revoked === true ||
        authority.authorityEpoch !== executionContext.authorityEpoch || authority.fence !== executionContext.fence ||
        authority.ownedResourceId !== executionBinding.ownedResourceId || authority.envelopeDigest !== envelope.digest) {
      throw unknownError("fresh V3 authority is stale or not bound to the approved envelope");
    }
    if (authority.capability?.action !== freshBinding.action || authority.capability?.recipient !== freshBinding.recipient) {
      throw unknownError("fresh V3 capability is not bound to the command binding");
    }
  };
  adapter = createOwnedProcessAdapterV1({
    root: stateRoot,
    trustedController: runtimeController,
    beforeLaunch,
    beforeLaunchTimeoutMs
  });
  registry = await openExecutionRegistry({
    stateRoot,
    runId,
    controller: runtimeController,
    resourceAdapter: adapter.resourceAdapter,
    clock: options.clock
  });
  // The budget ledger is opened before a recovery handle is selected so a
  // not-sent predecessor can be released from its own trusted runtime fact.
  // It never receives caller-supplied usage or an approval object; reserve
  // amounts come from the freshly validated plan task below.
  const budgetLedger = await openExecutionBudgetLedgerV1({
    stateRoot,
    runId,
    controller: runtimeController,
    resourceAdapter: adapter.resourceAdapter,
    clock: options.clock
  });
  const assertIncidentRecoveryCurrent = async () => {
    if (incidentRecoveryPlan === null) return;
    const report = await readIncidentRecoveryReportV1({
      stateRoot,
      plan: incidentRecoveryPlan
    });
    const runtimeState = await registry.replay();
    assertIncidentRecoveryRuntimeSnapshotV1({
      plan: incidentRecoveryPlan,
      state: runtimeState,
      incident: report.incident
    });
  };
  await assertIncidentRecoveryCurrent();
  if (resumeFromHandleId !== undefined) {
    const previousBudget = await budgetLedger.load();
    for (const previousReservation of Object.values(previousBudget.reservations ?? {})) {
      if (previousReservation.runtime.handleId !== resumeFromHandleId ||
          !["reserved", "held"].includes(previousReservation.status)) continue;
      // This is intentionally a settle observation, not a release request.
      // Only the runtime's durable not-sent proof can release the old
      // reservation; UNKNOWN/stopped/completed facts remain held.
      await budgetLedger.settle({
        handleId: resumeFromHandleId,
        reservationId: previousReservation.reservationId
      });
    }
  }
  await assertIncidentRecoveryCurrent();
  let handle;
  if (resumeFromHandleId !== undefined) {
    const resumed = await registry.resumeExecution(resumeFromHandleId, {
      executionId,
      attemptId,
      reason: resumeReason
    });
    handle = resumed.handle;
    if (!same({
      runId: handle.runId,
      executionId: handle.executionId,
      attemptId: handle.attemptId,
      unitId: handle.unitId,
      sourceBindingDigest: handle.sourceBindingDigest,
      policyDigest: handle.policyDigest,
      revision: handle.revision,
      ownedResourceId: handle.ownedResourceId
    }, executionBinding)) {
      throw fail("ENATIVE_V3_RECOVERY_BINDING", "resumed execution handle is not bound to the fresh approved runner", "HOLD");
    }
  } else {
    handle = await registry.createExecutionHandle(executionBinding);
  }
  const registryCoordinator = registryCoordinatorFor(stateRoot, runId);
  const trustedAllocation = Object.freeze({
    runId: handle.runId,
    handleId: handle.handleId,
    ownedResourceId: handle.ownedResourceId
  });
  const observationBinding = Object.freeze({
    ...executionBinding,
    planId,
    planDigest: initialPlan.planDigest,
    contractDigest: initialPlan.contractDigest,
    taskId,
    unitId,
    executionId,
    attemptId,
    handleId: handle.handleId,
    admissionDigest: handle.admissionDigest ?? null,
    effectBindingDigest
  });
  const errorBudgetAttachments = new WeakMap();
  const settlementObservation = {
    settlement: "unstarted",
    snapshot: null,
    captureUnavailable: false,
    notSent: false
  };
  const observationRecord = (availability) => ({
    schemaVersion: 1,
    kind: NATIVE_V3_COMMAND_SETTLEMENT_OBSERVATION_KIND,
    binding: observationBinding,
    settlement: settlementObservation.settlement,
    availability,
    value: null,
    error: null
  });
  const captureSettlement = (settlement, payload) => {
    settlementObservation.settlement = settlement;
    try {
      const record = observationRecord("AVAILABLE");
      let notSent = false;
      if (settlement === "fulfilled") {
        // Only this registry branch returns a fresh canonical JSON effect
        // tree. Its handle/intent are detached registry-owned durable DTOs;
        // the appended budget receipt is made from the private ledger output.
        // The generic registry branch may retain opaque callback values and
        // is deliberately not a supported passive-observation data domain.
        if (!DIGEST.test(observationBinding.admissionDigest ?? "") ||
            payload.handle.admissionDigest !== observationBinding.admissionDigest ||
            payload.handle.handleId !== trustedAllocation.handleId) {
          throw new Error("command observation canonical producer unavailable");
        }
        record.value = payload;
      } else {
        record.error = commandObservationErrorProjection(payload, errorBudgetAttachments.get(payload));
        const proof = EFFECT_NOT_SENT_EVIDENCE.get(payload);
        notSent = Boolean(proof && proof.runId === trustedAllocation.runId &&
          proof.handleId === trustedAllocation.handleId && proof.ownedResourceId === trustedAllocation.ownedResourceId &&
          proof.callbackStarted === false);
        // Preserve the original fixed private proof DTO for CLI display.
        // The copied DTO/error is not rebranded as an original error; the
        // separate exact-observation predicate remains the authority lookup.
        if (notSent) record.error.effectNotSent = proof;
      }
      // Capture before external promise consumers can mutate their result.
      settlementObservation.snapshot = copyCommandObservationData(record);
      settlementObservation.notSent = notSent;
    } catch {
      settlementObservation.snapshot = null;
      settlementObservation.notSent = false;
      settlementObservation.captureUnavailable = true;
    }
  };
  const budgetAmounts = Object.freeze({
    attempts: 1,
    seconds: task.budget.seconds,
    tokens: task.budget.tokens,
    cost: null
  });
  let budgetReservation = null;
  let budgetReservationPromise = null;
  const reserveBudget = () => {
    if (budgetReservationPromise === null) {
      budgetReservationPromise = (async () => {
        const receipt = await budgetLedger.reserve({
          handleId: handle.handleId,
          idempotencyKey: `native-v3-command:${handle.handleId}`,
          amounts: budgetAmounts
        });
        const reservation = Object.values(receipt.reservations ?? {})
          .find((item) => item.runtime.handleId === handle.handleId && item.idempotencyKey === `native-v3-command:${handle.handleId}`);
        if (!reservation) {
          const error = new Error("trusted execution budget reservation was not returned by the ledger");
          error.code = "EEXECUTION_BUDGET_RESERVATION_UNKNOWN";
          error.status = "UNKNOWN";
          throw error;
        }
        budgetReservation = Object.freeze({
          reservationId: reservation.reservationId,
          idempotencyKey: reservation.idempotencyKey
        });
        return receipt;
      })();
      budgetReservationPromise.catch(() => {});
    }
    return budgetReservationPromise;
  };
  const settleBudget = async () => {
    if (budgetReservation === null) return null;
    return budgetLedger.settle({
      handleId: handle.handleId,
      reservationId: budgetReservation.reservationId
    });
  };
  const attachBudgetReceipt = (result, receipt) => {
    if (!receipt || budgetReservation === null) return result;
    const reservation = receipt.reservations?.[budgetReservation.reservationId] ?? null;
    return {
      ...result,
      budgetReceipt: Object.freeze({
        schemaVersion: 1,
        kind: "NativeV3CommandBudgetReceiptV1",
        runId,
        handleId: handle.handleId,
        reservationId: budgetReservation.reservationId,
        status: reservation?.status ?? null,
        outcome: reservation?.outcome ?? null,
        usage: reservation?.usage ?? null,
        decision: receipt.decision ?? null,
        ledgerSequence: receipt.sequence,
        ledgerStateDigest: receipt.stateDigest
      })
    };
  };
  let activeEffect = null;
  // A validated stop request can race the runtime's pre-effect freshness
  // checks, before an effectRun exists.  Keep a private sticky latch so a
  // failed stop cannot be followed by a late callback that starts the owned
  // resource after the caller releases its gate.  The latch is set only after
  // the caller's expected authority values have passed validation below.
  let stopLatchReason = null;
  let allocationClaim = null;

  const claimAllocation = (owner) => {
    if (stopLatchReason !== null) {
      throw fail("ENATIVE_V3_ALLOCATION_STOPPED", "the native V3 allocation is already stop-latched", "HOLD");
    }
    if (allocationClaim === null) {
      allocationClaim = owner;
      return;
    }
    // The command runner's public execute promise is idempotent after its
    // first command claim.  A plan transfer is different: it is a one-shot
    // ownership move and must never be minted twice.
    throw fail(
      "ENATIVE_V3_ALLOCATION_CONSUMED",
      `the native V3 allocation is already claimed by ${allocationClaim}`,
      "HOLD"
    );
  };

  const requestLocalEmergencyStop = (reason, effectRun = activeEffect) => {
    if (effectRun) {
      effectRun.cancelStartup(reason);
      if (effectRun.localStopPromise) return effectRun.localStopPromise;
    }
    let localStop;
    try {
      // Invoke the adapter synchronously after sticky cancellation is set.
      // Deferring this call to a microtask lets a released beforeLaunch gate
      // launch the target before a failed durable stop reports back.
      localStop = Promise.resolve(adapter.resourceAdapter.stopOwned({
        request: {
          runId: trustedAllocation.runId,
          handleId: trustedAllocation.handleId,
          ownedResourceId: trustedAllocation.ownedResourceId,
          reason,
          requestedBy: "native-v3-command-runner",
          emergency: true
        },
        ownedResourceId: trustedAllocation.ownedResourceId,
        scope: {
          runId: trustedAllocation.runId,
          handleId: trustedAllocation.handleId
        }
      }));
    } catch (error) {
      localStop = Promise.reject(error);
    }
    localStop.catch(() => {});
    if (effectRun) effectRun.localStopPromise = localStop;
    return localStop;
  };

  let executePromise = null;
  let transferExecutePromise = null;

  const executeThroughRegistry = () => {
    registryCoordinator.active += 1;
    let releaseSeal = null;
    let releaseFinalDispatch = null;
    const registryPromise = registryCoordinator.dispatch.enqueue(async (releaseDispatch) => {
      // Reserve under the trusted admission before the runtime can create a
      // dispatch intent.  The coordinator token is not a runtime lease, so
      // the ledger's own run lease is never nested inside withRegistryLock.
      await reserveBudget();
      const guardedEffect = async (executionContext) => {
        // The runtime invokes this callback while its per-run lease is still
        // held. Start the owned effect immediately, then yield one event-loop
        // turn before handing the dispatch gate to a sibling task. This lets
        // the runtime finish the callback linearization and remove its lease;
        // the owned effects themselves remain concurrent.
        const effectPromise = Promise.resolve().then(() => effect(executionContext));
        effectPromise.catch(() => {});
        try {
          await waitForRegistryLeaseRelease(registry);
        } catch (error) {
          // The effect callback has already been invoked. If the runtime does
          // not release its lease within the bounded handoff window, cancel
          // the same private owned allocation before exposing UNKNOWN. This
          // prevents a lease observation failure from leaving a live resource
          // behind while the durable registry records an indeterminate intent.
          await requestLocalEmergencyStop("registry handoff failed").catch(() => {});
          throw error;
        }
        releaseDispatch();
        try {
          const result = await effectPromise;
          // A sibling may be in the runtime's pre-effect registry section
          // while this effect is running. Before returning to the runtime's
          // final CAS, reserve the same dispatch gate again. The sibling
          // releases its initial token only after its callback has been
          // invoked and its registry lease has cleared, so final sealing
          // cannot race that pre-effect section.
          releaseFinalDispatch = await registryCoordinator.dispatch.acquire();
          releaseSeal = await registryCoordinator.seal.acquire();
          return result;
        } catch (error) {
          // A rejected callback still causes the registry to persist an
          // UNKNOWN intent. Hold the finalization gate until that write is
          // complete so a sibling registry cannot race the same-run CAS.
          releaseFinalDispatch = await registryCoordinator.dispatch.acquire();
          releaseSeal = await registryCoordinator.seal.acquire();
          throw error;
        }
      };
      return registry.execute(handle.handleId, guardedEffect);
    });
    const observed = registryPromise.then(
      async (result) => {
        let budgetReceipt;
        try {
          budgetReceipt = await settleBudget();
        } catch (error) {
          const held = unknownError("trusted execution budget settlement is unavailable", error);
          held.code = "EEXECUTION_BUDGET_SETTLEMENT_UNKNOWN";
          held.budgetSettlementError = error;
          throw held;
        }
        return attachBudgetReceipt(result, budgetReceipt);
      },
      async (error) => {
        let budgetReceipt = null;
        try {
          budgetReceipt = await settleBudget();
        } catch (settlementError) {
          error.budgetSettlementError = settlementError;
          error.status = error.status ?? "UNKNOWN";
        }
        if (budgetReceipt) {
          error.budgetReceipt = budgetReceipt.budgetReceipt ?? budgetReceipt;
          errorBudgetAttachments.set(error, budgetReceipt.budgetReceipt ?? budgetReceipt);
        }
        if (isExecutionRuntimeEffectNotSent(error, trustedAllocation)) {
          const wrapped = effectNotSentError(error, trustedAllocation);
          if (budgetReceipt) {
            wrapped.budgetReceipt = budgetReceipt.budgetReceipt ?? budgetReceipt;
            errorBudgetAttachments.set(wrapped, budgetReceipt.budgetReceipt ?? budgetReceipt);
          }
          throw wrapped;
        }
        // Preserve the runtime's exact error identity/code/status when no
        // private not-sent proof exists.  The durable status is available via
        // status(), while this path must never relabel an arbitrary failure as
        // EFFECT_NOT_SENT or erase a known stop/binding code.
        throw error;
      }
    );
    observed.catch(() => {});
    observed.then(
      () => {
        releaseFinalDispatch?.();
        releaseSeal?.();
        releaseRegistryCoordinator(registryCoordinator);
      },
      (error) => {
        releaseFinalDispatch?.();
        releaseSeal?.();
        releaseRegistryCoordinator(registryCoordinator);
      }
    );
    settlementObservation.settlement = "pending";
    // This side branch follows the existing release handlers. Never return
    // its promise, change the original result/error, or repeat budget work.
    const capture = observed.then(
      (result) => captureSettlement("fulfilled", result),
      (error) => captureSettlement("rejected", error)
    );
    capture.catch(() => {});
    return observed;
  };

  const effect = async (executionContext) => {
    if (stopLatchReason !== null) {
      throw unknownError("owned command startup was cancelled", stopLatchReason);
    }
    let timer = null;
    let budgetStopPromise = null;
    let rejectBudgetStopFailure;
    const budgetStopFailure = new Promise((_, reject) => { rejectBudgetStopFailure = reject; });
    budgetStopFailure.catch(() => {});
    let budgetExceeded = false;
    let resolveCancel;
    const cancelSignal = new Promise((resolve) => { resolveCancel = resolve; });
    cancelSignal.catch(() => {});
    const effectRun = {
      localStopPromise: null,
      cancelRequested: false,
      cancelStartup: (reason) => {
        if (effectRun.cancelRequested) return;
        effectRun.cancelRequested = true;
        resolveCancel({ state: "cancelled", reason });
      }
    };
    activeEffect = effectRun;
    const requestBudgetStop = () => {
      budgetExceeded = true;
      // Cancel the adapter's exact in-memory reservation immediately.  The
      // registry path remains authoritative for durable stop/reconciliation,
      // while this local path keeps a stalled startup from launching later.
      void requestLocalEmergencyStop("budget exceeded", effectRun);
      budgetStopPromise = registry.requestStop(handle.handleId, {
        reason: "cancel",
        requestedBy: "native-v3-command-runner",
        expectedEpoch: executionContext.authorityEpoch,
        expectedFence: executionContext.fence,
        expectedRevision: executionContext.binding.revision
      });
      budgetStopPromise.catch((error) => {
        rejectBudgetStopFailure(unknownError("approved command budget stop failed", error));
      });
    };
    try {
      if (budgetSeconds !== null) timer = setTimeout(requestBudgetStop, budgetSeconds * 1000);
      // Attach a settlement observer before the adapter can reject.  The
      // startup cancellation race is separate from durable registry stop, so a
      // budget or rejected explicit stop can return UNKNOWN without waiting for
      // unbounded adapter filesystem/startup work.
      const startPromise = adapter.startOwned(executionContext, {
        command: binding.executable,
        args: binding.args,
        cwd: binding.cwd,
        env: binding.env,
        effectBindingDigest,
        maxOutputBytes: binding.maxOutputBytes
      });
      const observedStart = startPromise.then(
        (value) => {
          // A cancellation race may win before startup settles.  Observe the
          // eventual completion promise here as well, so a late start cannot
          // create an unhandled rejection after the runner returned UNKNOWN.
          value?.completion?.catch?.(() => {});
          return { state: "fulfilled", value };
        },
        (error) => ({ state: "rejected", error })
      );
      observedStart.catch(() => {});
      const startupResult = await Promise.race([observedStart, cancelSignal, budgetStopFailure]);
      if (startupResult.state === "rejected") throw startupResult.error;
      if (startupResult.state === "cancelled") throw unknownError("owned command startup was cancelled", startupResult.reason);
      const started = startupResult.value;
      if (!started || typeof started.completion?.then !== "function") throw unknownError("owned adapter did not return a completion promise");
      // Observe completion even if the trusted stop path fails.  A failed stop
      // must return UNKNOWN promptly while leaving the adapter allocation for
      // reconciliation; it must never be reported as cleaned up.
      started.completion.catch(() => {});
      const completionResult = await Promise.race([
        started.completion.then(
          (value) => ({ state: "fulfilled", value }),
          (error) => ({ state: "rejected", error })
        ),
        cancelSignal,
        budgetStopFailure
      ]);
      if (completionResult.state === "cancelled") throw unknownError("owned command was cancelled", completionResult.reason);
      if (completionResult.state === "rejected") throw completionResult.error;
      const completion = completionResult.value;
      if (budgetExceeded) throw unknownError("approved command budget was exceeded");
      if (completion.outcome === "indeterminate" || completion.outcome === "unknown" || completion.groupTerminated !== true) {
        throw unknownError("owned process completion is indeterminate");
      }
      const outputExceeded = completion.outputExceeded === true;
      const outcome = !outputExceeded && completion.outcome === "stopped" && completion.code === 0 ? "success" : "failure";
      return {
        outcome,
        code: completion.code,
        signal: completion.signal,
        groupTerminated: true,
        outputExceeded,
        ...(outputExceeded ? { reason: "output-exceeded" } : {})
      };
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (activeEffect === effectRun) activeEffect = null;
    }
  };

  const execute = async (executeOptions = undefined) => {
    exactOptions(executeOptions, EXECUTE_KEYS, "execute options");
    if (planTaskMode === "trusted-plan-task") {
      throw fail(
        "ENATIVE_V3_PLAN_TRANSFER_REQUIRED",
        "A plan task allocation must be transferred to the trusted DAG runner before execution",
        "HOLD"
      );
    }
    if (executePromise === null) {
      claimAllocation("command runner");
      executePromise = executeThroughRegistry();
    }
    return executePromise;
  };

  const stop = async (stopOptions = undefined) => {
    const supplied = exactOptions(stopOptions, STOP_KEYS, "stop options");
    const reason = supplied.reason ?? "cancel";
    const requestedBy = supplied.requestedBy ?? "native-v3-command-runner";
    if (!STOP_REASONS.has(reason)) throw fail("ENATIVE_V3_RUNNER_INPUT", "stop reason is invalid");
    identifier(requestedBy, "stop.requestedBy");
    for (const [key, expected, label] of [
      ["expectedEpoch", handle.authorityEpoch, "authority epoch"],
      ["expectedFence", handle.fence, "fence"],
      ["expectedRevision", handle.revision, "revision"]
    ]) {
      if (supplied[key] !== undefined && supplied[key] !== expected) {
        throw fail("ENATIVE_V3_STOP_EXPECTATION", `stop expected ${label} mismatch`);
      }
    }
    const request = {
      reason,
      requestedBy,
      expectedEpoch: supplied.expectedEpoch ?? handle.authorityEpoch,
      expectedFence: supplied.expectedFence ?? handle.fence,
      expectedRevision: supplied.expectedRevision ?? handle.revision
    };
    if (stopLatchReason === null) stopLatchReason = reason;
    // Set the in-memory cancellation bit before waiting on the durable
    // registry path.  A registry lock/read can wait long enough for a caller
    // to release a startup freshness gate; starting the local stop only from
    // the rejection handler leaves that window open.  Keep this exact promise
    // and await it on either registry outcome.
    const localStop = activeEffect ? requestLocalEmergencyStop(reason, activeEffect) : null;
    const stopPromise = registry.requestStop(handle.handleId, request);
    // A rejected authority/read/persistence path may occur before the runtime
    // can construct a durable stop request.  Use only the closed trusted
    // allocation identity for the local emergency cancellation; never use
    // caller-supplied PID/process identity or fabricate a receipt.  Await the
    // same local stop promise before exposing the registry failure so a caller
    // cannot release a startup gate while cancellation is still pending.
    return stopPromise.then(
      async (receipt) => {
        const emergencyStop = localStop ?? (activeEffect ? requestLocalEmergencyStop(reason, activeEffect) : null);
        if (emergencyStop) await emergencyStop.catch(() => {});
        return receipt;
      },
      async (error) => {
        if (isExpectedStopMismatch(error) && !localStop) throw error;
        try {
          const emergencyStop = localStop ?? requestLocalEmergencyStop(reason);
          const result = await emergencyStop;
          if (result !== undefined) error.emergencyStopResult = result;
        } catch (emergencyError) {
          error.emergencyStopError = emergencyError;
        }
        throw error;
      }
    );
  };

  const status = async () => normalizeStatus(await registry.replay(), handle.handleId);
  const reconcile = async (reconcileOptions = undefined) => {
    const supplied = exactOptions(reconcileOptions, new Set(["expectedSequence", "timeoutMs", "abortSignal"]), "reconcile options");
    const current = await registry.replay();
    const currentHandle = current.handles?.[handle.handleId];
    if (!currentHandle) throw unknownError("native V3 execution handle is absent during reconciliation");
    const reconciled = await registry.reconcileUnknownExecution(handle.handleId, {
      expectedSequence: supplied.expectedSequence,
      timeoutMs: supplied.timeoutMs,
      abortSignal: supplied.abortSignal
    });
    // A terminal-looking allocation cannot clear the controller's UNKNOWN
    // launch transaction by itself.  After the registry has appended its
    // observation, ask the same in-process POSIX adapter for its private,
    // owned cleanup receipt.  The controller validates the exact transaction
    // and persists a cleanup-confirmed resolution only from that producer
    // path.  Missing evidence remains HOLD and is returned as such.
    let controllerResolution = null;
    if (typeof runtimeController.resolveEffectLaunchTransaction === "function" &&
        typeof adapter.resourceAdapter.resolveOwnedLaunch === "function") {
      const bindingObservation = await runtimeController.readExecutionBinding({
        runId,
        binding: clone(executionBinding)
      });
      const transaction = bindingObservation.launchTransaction ?? null;
      if (transaction !== null) {
        try {
          controllerResolution = await runtimeController.resolveEffectLaunchTransaction({
            runId,
            handleId: handle.handleId,
            intentId: reconciled.intent.intentId,
            ...executionBinding,
            authorityEpoch: transaction.authorityEpoch,
            fence: transaction.fence,
            transactionId: transaction.transactionId,
            transactionDigest: transaction.digest
          }, adapter.resourceAdapter);
        } catch (error) {
          if (error?.code !== "EOWNER_LAUNCH_RESOLUTION_UNKNOWN") throw error;
        }
      }
    }
    if (controllerResolution !== null && typeof registry.recordOwnedCleanupResolution === "function") {
      await registry.recordOwnedCleanupResolution(handle.handleId, controllerResolution, runtimeController);
    }
    let budgetSettlement = null;
    if (budgetReservation !== null) {
      try {
        budgetSettlement = await settleBudget();
      } catch (error) {
        throw unknownError("trusted execution budget reconciliation is unavailable", error);
      }
    }
    const result = controllerResolution === null ? reconciled : { ...reconciled, controllerResolution };
    return attachBudgetReceipt(result, budgetSettlement);
  };
  let planStopPromise = null;
  let planStopReason = null;
  const cleanupUnknown = (code, message) => Object.freeze({
    kind: "unknown", receipt: null, reason: planStopReason,
    error: Object.freeze({ code, message, status: "UNKNOWN" })
  });
  const createPlanPreparation = (stopWaitMs) => {
    const invocation = Object.freeze({});
    let cleanupReadyResolve;
    const cleanupReady = new Promise((resolve) => { cleanupReadyResolve = resolve; });
    const state = {
      invocation, claimedHere: false, settled: false, failureCleanup: null,
      cleanup: null, cleanupReady, cleanupReadyResolve, stopWaitMs
    };
    const scope = freezeDeep({
      ...executionBinding, planId, planDigest: initialPlan.planDigest,
      contractDigest: initialPlan.contractDigest, taskId,
      handleId: handle.handleId, authorityEpoch: handle.authorityEpoch, fence: handle.fence
    });
    const requestStop = (reason) => {
      if (!state.claimedHere || !STOP_REASONS.has(reason)) {
        throw fail("ENATIVE_V3_PLAN_TASK_BINDING", "cleanup requires this invocation's allocation claim", "UNKNOWN");
      }
      if (planStopPromise === null) {
        planStopReason = reason;
        // This latch is factory-owned, including when the original fence is
        // stale. A cleanup failure must not allow a late transferred execute.
        if (stopLatchReason === null) stopLatchReason = reason;
        // Install the memo before entering stop's synchronous native prefix.
        // The factory latch above is already active before this microtask.
        planStopPromise = Promise.resolve().then(() => stop({
          reason, requestedBy: "native-v3-plan-runner",
          expectedEpoch: scope.authorityEpoch, expectedFence: scope.fence,
          expectedRevision: scope.revision
        })).then((value) => {
          try {
            const receipt = validateStopReceiptV1(value);
            for (const key of ["runId", "executionId", "attemptId", "unitId", "handleId", "ownedResourceId",
              "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence"]) {
              if (receipt[key] !== scope[key]) throw new Error("owned cleanup binding mismatch");
            }
            if (receipt.reason !== planStopReason || receipt.outcome !== "STOPPED" || receipt.confirmedOwnedScope !== true) {
              throw new Error("owned cleanup lacks STOPPED proof");
            }
            return Object.freeze({ kind: "stopped", receipt: freezeDeep(clone(receipt)), reason: planStopReason, error: null });
          } catch {
            return cleanupUnknown("ENATIVE_V3_PLAN_CLEANUP_RECEIPT", "Owned cleanup did not return matching STOPPED proof");
          }
        }, () => cleanupUnknown("ENATIVE_V3_PLAN_CLEANUP_UNKNOWN", "Owned cleanup could not be confirmed"));
        planStopPromise.catch(() => {});
      }
      return planStopPromise;
    };
    state.cleanup = Object.freeze({
      scope,
      requestStop,
      observeStop: async (reason) => {
        const actual = requestStop(reason);
        let timer;
        const deadline = new Promise((resolve) => {
          timer = setTimeout(() => resolve(cleanupUnknown(
            "ENATIVE_V3_PLAN_CLEANUP_TIMEOUT", "Owned cleanup exceeded its observation deadline"
          )), stopWaitMs);
        });
        try { return await Promise.race([actual, deadline]); }
        finally { clearTimeout(timer); }
      }
    });
    COMMAND_PLAN_PREPARATIONS.set(invocation, state);
    return state;
  };
  const preparationFailed = (state, error) => {
    state.settled = true;
    state.cleanupReadyResolve();
    if (!state.claimedHere) throw error;
    return state.cleanup.observeStop("cancel").then((result) => {
      state.failureCleanup ??= result;
      if (state.failureCleanup.kind === "stopped") throw error;
      throw unknownError("plan preparation failed and owned cleanup is unconfirmed", error);
    });
  };
  const mintPlanTransfer = (context, state) => {
    plain(context, "plan task context");
    if (
      context.runId !== runId ||
      context.planId !== planId ||
      context.planDigest !== initialPlan.planDigest ||
      context.contractDigest !== initialPlan.contractDigest ||
      context.taskId !== taskId ||
      (context.unitId !== undefined && context.unitId !== unitId) ||
      context.attemptId !== attemptId
    ) {
      throw fail("ENATIVE_V3_PLAN_TASK_BINDING", "plan task context is not bound to this approved command runner", "HOLD");
    }
    claimAllocation("plan runner");
    // Publish THIS claim before anything that can fail while creating the
    // transfer. A rejected duplicate claim cannot acquire the previous cap.
    state.claimedHere = true;
    state.cleanupReadyResolve();
    const transferBinding = freezeDeep(clone(executionBinding));
    const transferHandle = freezeDeep(clone(handle));
    return Object.freeze({
      kind: "NativeV3PlanTaskTransferV1",
      taskId,
      unitId,
      binding: transferBinding,
      handle: transferHandle,
      controller: runtimeController,
      execute: async () => {
        if (transferExecutePromise === null) transferExecutePromise = executeThroughRegistry();
        return transferExecutePromise;
      },
      stop: async (options) => {
        const supplied = exactOptions(options, STOP_KEYS, "stop options");
        for (const [key, expected] of [["expectedEpoch", state.cleanup.scope.authorityEpoch],
          ["expectedFence", state.cleanup.scope.fence], ["expectedRevision", state.cleanup.scope.revision]]) {
          if (supplied[key] !== undefined && supplied[key] !== expected) {
            throw fail("ENATIVE_V3_STOP_EXPECTATION", "transfer stop expectation mismatch", "UNKNOWN");
          }
        }
        if (supplied.requestedBy !== undefined) identifier(supplied.requestedBy, "stop.requestedBy");
        const result = await state.cleanup.observeStop(supplied.reason ?? "cancel");
        if (result.kind !== "stopped") throw unknownError("transferred owned cleanup is unconfirmed");
        return result.receipt;
      },
      reconcile
    });
  };
  const transferPlanTask = (context) => {
    const state = createPlanPreparation(PLAN_PREPARATION_STOP_WAIT_MS);
    try {
      const transfer = mintPlanTransfer(context, state);
      state.settled = true;
      return transfer;
    } catch (error) {
      return preparationFailed(state, error);
    }
  };
  const beginPlanPreparation = (context, stopWaitMs) => {
    const state = createPlanPreparation(stopWaitMs);
    // Caller retains the unique token before this original factory runs.
    const prepared = Promise.resolve().then(() => {
      try {
        const transfer = mintPlanTransfer(context, state);
        state.settled = true;
        return transfer;
      } catch (error) {
        return preparationFailed(state, error);
      }
    });
    prepared.catch(() => {});
    return Object.freeze({ invocation: state.invocation, prepared, cleanupReady: state.cleanupReady });
  };
  const runner = {
    schemaVersion: 1,
    kind: NATIVE_V3_COMMAND_RUNNER_KIND,
    runId,
    planId,
    taskId,
    unitId,
    attemptId,
    ...(allocationKey === undefined ? {} : { allocationKey }),
    execute,
    stop,
    reconcile,
    status
  };
  Object.defineProperty(runner, "handleId", { enumerable: true, get: () => handle.handleId });
  const preparedStopScope = freezeDeep({
    ...executionBinding, handleId: handle.handleId, ownedResourceId: handle.ownedResourceId,
    authorityEpoch: handle.authorityEpoch, fence: handle.fence
  });
  let preparedStopPromise = null;
  COMMAND_PREPARED_STOP_REQUESTS.set(runner, () => {
    if (preparedStopPromise !== null) return preparedStopPromise;
    if (allocationClaim !== null) {
      throw fail("ENATIVE_V3_CLI_CLEANUP_SCOPE", "Prepared cleanup cannot replace scheduler-owned cancellation", "UNKNOWN");
    }
    const reason = stopLatchReason ?? "cancel";
    let resolveStop, rejectStop;
    // Install the memo and latch before stop's synchronous trusted prefix.
    preparedStopPromise = Object.freeze(new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject; }));
    preparedStopPromise.catch(() => {});
    if (stopLatchReason === null) stopLatchReason = reason;
    try {
      const actual = stop({
        reason, requestedBy: "native-v3-cli-prepared-cleanup",
        expectedEpoch: preparedStopScope.authorityEpoch,
        expectedFence: preparedStopScope.fence,
        expectedRevision: preparedStopScope.revision
      });
      Promise.resolve(actual).then((value) => {
        const receipt = validateStopReceiptV1(value);
        for (const key of ["runId", "executionId", "attemptId", "unitId", "handleId", "ownedResourceId",
          "sourceBindingDigest", "policyDigest", "revision", "authorityEpoch", "fence"]) {
          if (receipt[key] !== preparedStopScope[key]) {
            throw fail("ENATIVE_V3_CLI_CLEANUP_UNKNOWN", "Prepared stop receipt scope does not match the factory allocation", "UNKNOWN");
          }
        }
        if (receipt.reason !== reason || receipt.outcome !== "STOPPED" ||
            receipt.confirmedOwnedScope !== true || receipt.localOutcome !== "stopped") {
          throw fail("ENATIVE_V3_CLI_CLEANUP_UNKNOWN", "Prepared command lacks matching confirmed STOPPED proof", "UNKNOWN");
        }
        return freezeDeep(clone(receipt));
      }).then(resolveStop, rejectStop);
    } catch (error) {
      rejectStop(error);
    }
    return preparedStopPromise;
  });
  TRUSTED_NATIVE_V3_COMMAND_RUNNERS.set(runner, transferPlanTask);
  COMMAND_PLAN_PREPARERS.set(runner, beginPlanPreparation);
  COMMAND_ALLOCATION_UNCLAIMED_READERS.set(runner, () => allocationClaim === null);
  COMMAND_SETTLEMENT_READERS.set(runner, () => {
    try {
      const record = settlementObservation.snapshot ?? observationRecord(
        settlementObservation.captureUnavailable ? "UNKNOWN" :
          settlementObservation.settlement === "unstarted" ? "UNSTARTED" : "PENDING"
      );
      const observation = freezeDeep(copyCommandObservationData(record));
      if (settlementObservation.notSent && observation.availability === "AVAILABLE") {
        COMMAND_SETTLEMENT_NOT_SENT.set(observation, runner);
      }
      return observation;
    } catch {
      // A reader copy failure is observation-only and never a run decision.
      return Object.freeze({
        schemaVersion: 1,
        kind: NATIVE_V3_COMMAND_SETTLEMENT_OBSERVATION_KIND,
        binding: null,
        settlement: settlementObservation.settlement,
        availability: "UNKNOWN",
        value: null,
        error: null
      });
    }
  });
  return Object.freeze(runner);
}

/**
 * Reconcile one persisted UNKNOWN command from a fresh process.  The caller
 * supplies only the durable execution identity and current source/policy
 * readers; the recovery controller and POSIX adapter derive their authority
 * from the persisted approved allocation and the live owned process group.
 * No caller-supplied PID, provider JSON, or query callback is accepted.
 */
export async function reconcileNativeV3CommandRunner(options = {}) {
  exactOptions(options, RECOVERY_OPTION_KEYS, "reconcileNativeV3CommandRunner options");
  const stateRoot = absolute(options.stateRoot ?? options.root, "stateRoot");
  if (options.stateRoot !== undefined && options.root !== undefined && absolute(options.root, "root") !== stateRoot) {
    throw fail("ENATIVE_V3_RUNNER_INPUT", "stateRoot and root must refer to the same directory");
  }
  const planId = identifier(options.planId, "planId");
  const runId = text(options.runId, "runId", ID);
  const taskId = identifier(options.taskId, "taskId");
  const unitId = identifier(options.unitId, "unitId");
  const executionId = identifier(options.executionId, "executionId");
  const attemptId = identifier(options.attemptId, "attemptId");
  const handleId = identifier(options.handleId, "handleId");
  const allocationKey = nativeV3AllocationKeyFor({ taskId, attemptId });
  if (options.allocationKey !== undefined && options.allocationKey !== allocationKey) {
    throw fail("ENATIVE_V3_RECOVERY_BINDING", "allocationKey is not derived from the exact task/attempt identity", "HOLD");
  }
  const source = sourceBinding(options.sourceBinding, "sourceBinding");
  const policy = digest(options.policyDigest, "policyDigest");
  if (options.trustMode !== NATIVE_V3_COMMAND_RUNNER_TRUST_MODE) {
    throw fail("EHOST_TRUST_REQUIRED", `trustMode must be ${NATIVE_V3_COMMAND_RUNNER_TRUST_MODE}`, "HOLD");
  }
  if (typeof options.readFreshSourceBinding !== "function" &&
      !(typeof options.sourceCwd === "string" && options.sourceCwd.length > 0)) {
    throw fail("ESOURCE_FRESHNESS_UNAVAILABLE", "readFreshSourceBinding or sourceCwd is required", "HOLD");
  }
  if (typeof options.readTrustPolicy !== "function") {
    throw fail("EPOLICY_TRUST_UNRESOLVED", "readTrustPolicy is required", "HOLD");
  }
  const recovered = await createCooperativeNativeV3RecoveryController({
    stateRoot,
    runId,
    planId,
    taskId,
    unitId,
    executionId,
    attemptId,
    allocationKey,
    sourceBinding: source,
    policyDigest: policy,
    readFreshSourceBinding: options.readFreshSourceBinding,
    readTrustPolicy: options.readTrustPolicy,
    sourceCwd: options.sourceCwd,
    trustMode: options.trustMode,
    clock: options.clock
  });
  const adapter = createOwnedProcessAdapterV1({ root: stateRoot, trustedController: recovered.controller });
  const registry = await openExecutionRegistry({
    stateRoot,
    runId,
    controller: recovered.controller,
    resourceAdapter: adapter.resourceAdapter,
    clock: options.clock
  });
  const snapshot = await registry.replay();
  const handle = snapshot.handles?.[handleId];
  if (!handle || handle.runId !== runId || handle.executionId !== executionId || handle.attemptId !== attemptId ||
      handle.unitId !== unitId || handle.sourceBindingDigest !== source.digest || handle.policyDigest !== policy ||
      handle.revision !== source.revision || handle.ownedResourceId !== recovered.binding.ownedResourceId) {
    throw fail("ENATIVE_V3_RECOVERY_BINDING", "persisted execution handle is not bound to the fresh recovery controller", "HOLD");
  }
  return registry.reconcileUnknownExecution(handleId, {
    expectedSequence: options.expectedSequence,
    timeoutMs: options.timeoutMs,
    abortSignal: options.abortSignal
  });
}

export default createNativeV3CommandRunner;
