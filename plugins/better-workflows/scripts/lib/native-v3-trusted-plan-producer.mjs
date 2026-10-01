import {
  beginNativeV3CommandPlanPreparation,
  readNativeV3CommandPlanPreparation,
  isNativeV3CommandRunner,
} from "./native-v3-command-runner.mjs";

/**
 * The plan runner consumes only a capability minted from the production
 * command runner.  This module deliberately has no callback-based factory:
 * callers must first complete the native V3 TTY/owner-decision path and hand
 * over the resulting frozen command runner.
 */

const TRUSTED_PLAN_TASK_ADAPTERS = new WeakSet();
const ADAPTER_KEYS = ["schemaVersion", "kind", "prepareTask"].sort();
const TRUSTED_PLAN_TASK_TRANSFERS = new WeakMap();
const ADAPTER_PREPARERS = new WeakMap();
const PREPARATION_INVOCATIONS = new WeakMap();
const TRANSFER_KEYS = ["binding", "kind", "schemaVersion", "taskId", "unitId"].sort();

function fail(code, message, status = "HOLD") {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function plain(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("EPLAN_RUNNER_INPUT", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw fail("EPLAN_RUNNER_INPUT", `${label} must be a plain object`);
  }
  return value;
}

function exactOptions(value, allowed, label) {
  plain(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw fail("EPLAN_RUNNER_INPUT", `${label} contains unknown option(s): ${unknown.join(", ")}`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(value) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) {
    throw fail("EPLAN_RUNNER_INPUT", `${label} is invalid`);
  }
  return value;
}

function planTaskKey(runId, planId, taskId, attemptId) {
  return `${runId}\u0000${planId}\u0000${taskId}\u0000${attemptId}`;
}

/**
 * Convert one real, already-approved native V3 command runner into the task
 * capability consumed by the DAG scheduler.  The runner is the authority
 * source; no caller-supplied controller, resource adapter, effect, digest, or
 * approval flag is accepted here.  The returned descriptor is a one-shot
 * transfer token for the runner's existing execution registry handle.
 */
export function createNativeV3PlanTaskAdapterFromCommandRunner(options = {}) {
  exactOptions(options, new Set(["runner"]), "createNativeV3PlanTaskAdapterFromCommandRunner options");
  if (!isNativeV3CommandRunner(options.runner)) {
    throw fail(
      "EPLAN_RUNNER_INPUT",
      "runner must be created by the native V3 command runner's trusted owner-decision path"
    );
  }
  const runner = options.runner;
  return createAdapter(() => runner);
}

/**
 * Build one trusted adapter for all already-approved tasks in a single
 * WorkflowPlan run.  The runner set is the only authority input: every
 * entry is checked for a unique run/plan/task/attempt identity and the
 * scheduler can consume only the matching one-shot transfer.  No dependency
 * readiness flag, effect callback, controller, or serialized approval is
 * accepted here.
 */
export function createNativeV3PlanTaskAdapterFromCommandRunners(options = {}) {
  exactOptions(options, new Set(["runners"]), "createNativeV3PlanTaskAdapterFromCommandRunners options");
  if (!Array.isArray(options.runners) || options.runners.length === 0 || options.runners.length > 4096) {
    throw fail("EPLAN_RUNNER_INPUT", "runners must be a non-empty bounded array");
  }
  const entries = [];
  const identities = new Set();
  let expectedRunId = null;
  let expectedPlanId = null;
  for (const [index, runner] of options.runners.entries()) {
    if (!isNativeV3CommandRunner(runner)) {
      throw fail("EPLAN_RUNNER_INPUT", `runners[${index}] must be a trusted native V3 command runner`);
    }
    const runId = identifier(runner.runId, `runners[${index}].runId`);
    const planId = identifier(runner.planId, `runners[${index}].planId`);
    const taskId = identifier(runner.taskId, `runners[${index}].taskId`);
    const attemptId = identifier(runner.attemptId, `runners[${index}].attemptId`);
    const unitId = identifier(runner.unitId, `runners[${index}].unitId`);
    if (expectedRunId === null) expectedRunId = runId;
    if (expectedPlanId === null) expectedPlanId = planId;
    if (runId !== expectedRunId || planId !== expectedPlanId) {
      throw fail("EPLAN_RUNNER_INPUT", "all trusted task runners must share one runId and planId");
    }
    const key = planTaskKey(runId, planId, taskId, attemptId);
    if (identities.has(key)) throw fail("EPLAN_RUNNER_INPUT", "trusted task runner identities must be unique");
    identities.add(key);
    entries.push(Object.freeze({ runner, runId, planId, taskId, attemptId, unitId }));
  }
  const byIdentity = new Map(entries.map((entry) => [
    planTaskKey(entry.runId, entry.planId, entry.taskId, entry.attemptId),
    entry
  ]));
  return createAdapter((context) => {
    plain(context, "plan task context");
    const runId = identifier(context.runId, "plan task context.runId");
    const planId = identifier(context.planId, "plan task context.planId");
    const taskId = identifier(context.taskId, "plan task context.taskId");
    const attemptId = identifier(context.attemptId, "plan task context.attemptId");
    if (runId !== expectedRunId || planId !== expectedPlanId) {
      throw fail("EPLAN_RUNNER_ADAPTER", "plan task context is not bound to the trusted runner set");
    }
    const entry = byIdentity.get(planTaskKey(runId, planId, taskId, attemptId));
    if (!entry || (context.unitId !== undefined && context.unitId !== entry.unitId)) {
      throw fail("EPLAN_RUNNER_ADAPTER", "no approved native V3 runner exists for this exact task attempt", "HOLD");
    }
    return entry.runner;
  });
}

function createAdapter(selectRunner) {
  const adapter = {
    schemaVersion: 1,
    kind: "NativeV3TrustedPlanTaskAdapterV3",
    prepareTask: async (context) => beginNativeV3PlanTaskPreparation(adapter, context).prepared
  };
  Object.freeze(adapter);
  TRUSTED_PLAN_TASK_ADAPTERS.add(adapter);
  ADAPTER_PREPARERS.set(adapter, selectRunner);
  return adapter;
}

function preparationRecord(invocation, { adapter, context, descriptor } = {}) {
  const record = PREPARATION_INVOCATIONS.get(invocation);
  if (!record || record.adapter !== adapter || record.context !== context ||
      (descriptor !== undefined && record.descriptor !== descriptor)) {
    throw fail("EPLAN_RUNNER_ADAPTER", "preparation invocation identity is not bound to this caller", "UNKNOWN");
  }
  return record;
}

export function readNativeV3PlanTaskPreparation(invocation, identity) {
  const record = preparationRecord(invocation, identity);
  const command = record.commandInvocation === null ? null : readNativeV3CommandPlanPreparation(record.commandInvocation);
  return Object.freeze({
    ownership: command?.ownership ?? (record.settled ? "unowned" : "pending"),
    settled: record.settled,
    cleanup: command?.cleanup ?? null,
    failureCleanup: record.failureCleanup ?? command?.failureCleanup ?? null
  });
}

export function beginNativeV3PlanTaskPreparation(adapter, context, { stopWaitMs = 10_000 } = {}) {
  if (!isNativeV3PlanTaskAdapter(adapter) || !ADAPTER_PREPARERS.has(adapter)) {
    throw fail("EPLAN_RUNNER_ADAPTER", "preparation requires the original trusted adapter");
  }
  if (!Number.isSafeInteger(stopWaitMs) || stopWaitMs < 25 || stopWaitMs > 10_000) {
    throw fail("EPLAN_RUNNER_INPUT", "preparation stop observer wait is invalid");
  }
  const invocation = Object.freeze({});
  let cleanupReadyResolve;
  const cleanupReady = new Promise((resolve) => { cleanupReadyResolve = resolve; });
  const record = {
    adapter, context, commandInvocation: null, descriptor: null,
    settled: false, failureCleanup: null
  };
  PREPARATION_INVOCATIONS.set(invocation, record);
  // Mint before scheduling: core retains this invocation before any factory
  // work. A reused context still creates an entirely new ownership attempt.
  const prepared = Promise.resolve().then(async () => {
    try {
      const runner = ADAPTER_PREPARERS.get(adapter)(context);
      const command = beginNativeV3CommandPlanPreparation(runner, context, { stopWaitMs });
      record.commandInvocation = command.invocation;
      command.cleanupReady.then(cleanupReadyResolve, cleanupReadyResolve);
      const transfer = await command.prepared;
      const owned = readNativeV3CommandPlanPreparation(command.invocation);
      if (owned.ownership !== "owned" || !owned.cleanup) {
        throw fail("EPLAN_RUNNER_ADAPTER", "command transfer has no private allocation owner", "UNKNOWN");
      }
      if (context.signal?.aborted) {
        // A late ownership result is revoked before descriptor/admission
        // validation, including a descriptor that would fail validation.
        owned.cleanup.requestStop("cancel");
        throw fail("EPLAN_RUN_CANCELLED", "preparation was cancelled before execution admission", "HOLD");
      }
      if (!transfer || typeof transfer !== "object" || Array.isArray(transfer) ||
          transfer.kind !== "NativeV3PlanTaskTransferV1" ||
          transfer.taskId !== owned.cleanup.scope.taskId || transfer.unitId !== owned.cleanup.scope.unitId ||
          typeof transfer.execute !== "function" || typeof transfer.stop !== "function" ||
          !plain(transfer.handle, "native V3 transfer handle") ||
          !plain(transfer.controller, "native V3 transfer controller")) {
        throw fail("EPLAN_RUNNER_ADAPTER", "native V3 producer returned no valid one-shot task transfer");
      }
      const descriptor = Object.freeze({
        schemaVersion: 1, kind: transfer.kind, taskId: transfer.taskId,
        unitId: transfer.unitId, binding: Object.freeze({ ...transfer.binding })
      });
      TRUSTED_PLAN_TASK_TRANSFERS.set(descriptor, { transfer, invocation });
      record.descriptor = descriptor;
      return descriptor;
    } catch (error) {
      const command = record.commandInvocation === null ? null : readNativeV3CommandPlanPreparation(record.commandInvocation);
      if (command?.ownership === "owned") {
        command.cleanup.requestStop("cancel");
        record.failureCleanup ??= command.failureCleanup ?? await command.cleanup.observeStop("cancel");
        if (record.failureCleanup.kind !== "stopped") {
          const wrapped = fail("EPLAN_PREPARATION_CLEANUP_UNKNOWN", "Preparation failed and owned cleanup is unconfirmed", "UNKNOWN");
          wrapped.cause = error;
          throw wrapped;
        }
      }
      throw error;
    } finally {
      record.settled = true;
      cleanupReadyResolve();
    }
  });
  prepared.catch(() => {});
  return Object.freeze({ invocation, prepared, cleanupReady });
}

export const createNativeV3PlanTaskAdapterFromCommandRunnerSet = createNativeV3PlanTaskAdapterFromCommandRunners;

export function isNativeV3PlanTaskAdapter(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== ADAPTER_KEYS.length || keys.some((key, index) => key !== ADAPTER_KEYS[index])) return false;
  return TRUSTED_PLAN_TASK_ADAPTERS.has(value);
}

/**
 * Consume a producer descriptor exactly once.  The returned record stays
 * inside this process and carries only the already-created handle/controller
 * plus execute/stop capability; no raw effect or resource adapter is exported.
 */
export function consumeNativeV3PlanTaskTransfer(value, identity = undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("EPLAN_RUNNER_ADAPTER", "native V3 task transfer must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== TRANSFER_KEYS.length || keys.some((key, index) => key !== TRANSFER_KEYS[index])) {
    throw fail("EPLAN_RUNNER_ADAPTER", "native V3 task transfer has an unexpected shape");
  }
  const entry = TRUSTED_PLAN_TASK_TRANSFERS.get(value);
  if (!entry) {
    throw fail("EPLAN_RUNNER_ADAPTER", "native V3 task transfer is stale, copied, or already consumed");
  }
  if (identity !== undefined) {
    if (entry.invocation !== identity.invocation) {
      throw fail("EPLAN_RUNNER_ADAPTER", "descriptor belongs to another preparation invocation", "UNKNOWN");
    }
    preparationRecord(entry.invocation, { ...identity, descriptor: value });
  }
  TRUSTED_PLAN_TASK_TRANSFERS.delete(value);
  return entry.transfer;
}
