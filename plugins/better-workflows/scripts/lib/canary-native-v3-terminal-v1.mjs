// SPDX-License-Identifier: AGPL-3.0-only
// Local Native V3 plan/command observations only. Caller configuration, local typed
// results and journal replay do not authenticate a producer or complete a stream.
import { createHash } from "node:crypto";
import { appendCanaryEventV1, readCanaryLedgerV1 } from "./canary-ledger-v1.mjs";
import { validateCanaryCohortV1 } from "./canary-cohort-v1.mjs";
import { CANARY_NATIVE_V3_START_KIND } from "./canary-native-v3-start-v1.mjs";

const PLAN_RESULT_KIND = "NativeV3PlanRunResultV1";
const CLI_PLAN_RESULT_KIND = "NativeV3InteractiveCliPlanRunV1";
const CLI_COMMAND_RESULT_KIND = "NativeV3InteractiveCliRunV1";
// native-v3-plan-runner-core.mjs:90-91. Paused/ready/running/cancelling are
// deliberately absent; promise fulfillment is not terminal evidence.
const OUTCOMES = Object.freeze({
  succeeded: "SUCCEEDED", failed: "FAILED", hold: "HOLD",
  unknown: "UNKNOWN", cancelled: "CANCELLED"
});
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION = /^[a-f0-9]{40,64}$/;
const hash = value => createHash("sha256").update(value).digest("hex");

function requireFact(value, code) {
  if (!value) throw Object.assign(new Error(code), { code });
}
function dataRecord(value, keys) {
  requireFact(value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), "ECANARY_NATIVE_V3_TERMINAL_BINDING");
  const own = Reflect.ownKeys(value);
  requireFact(own.length === keys.length && own.every(key => typeof key === "string" && keys.includes(key)),
    "ECANARY_NATIVE_V3_TERMINAL_BINDING");
  const result = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    requireFact(d?.enumerable && "value" in d, "ECANARY_NATIVE_V3_TERMINAL_BINDING");
    result[key] = d.value;
  }
  return result;
}
function boundCheckpoint(value, prepared, status) {
  return value && value.runId === prepared.runId && value.planId === prepared.planId &&
    value.planDigest === prepared.planDigest && value.contractDigest === prepared.contractDigest &&
    value.status === status;
}
function localObservation(executionOutcome, details) {
  return Object.freeze({
    recorded: false, observation: "UNFINISHED", canaryOutcome: "UNKNOWN", executionOutcome,
    canaryAcceptance: "HOLD", releaseAuthority: "NONE", journalCompleteness: "UNVERIFIED",
    ...details
  });
}

function terminalBinding(configuration, prepared, startReceipt, identityKeys) {
  const config = dataRecord(configuration, [
    "schemaVersion", "kind", "planId", "expectedSourceBinding", "cohort",
    "journalPath", "route", "facts", "evidenceRefs"
  ]);
  requireFact(config.schemaVersion === 1 && config.kind === CANARY_NATIVE_V3_START_KIND,
    "ECANARY_NATIVE_V3_TERMINAL_BINDING");
  const identity = dataRecord(prepared, identityKeys);
  const source = dataRecord(identity.sourceBinding, ["revision", "digest"]);
  const expectedSource = dataRecord(config.expectedSourceBinding, ["revision", "digest"]);
  const route = dataRecord(config.route, ["repositoryId", "launcherId", "sourceId"]);
  const started = dataRecord(startReceipt, [
    "ledgerId", "sequence", "eventDigest", "headDigest", "eventCount", "canaryAcceptance", "releaseAuthority"
  ]);
  const cohort = validateCanaryCohortV1(config.cohort);
  requireFact([identity.planId, identity.runId, ...Object.values(route)].every(value => typeof value === "string" && ID.test(value)) &&
    [identity.planDigest, identity.contractDigest, source.digest, started.eventDigest].every(value =>
      typeof value === "string" && DIGEST.test(value)) && REVISION.test(source.revision ?? "") &&
    config.planId === identity.planId && expectedSource.revision === source.revision && expectedSource.digest === source.digest &&
    started.canaryAcceptance === "HOLD" && started.releaseAuthority === "NONE" &&
    started.ledgerId === cohort.registration.ledgerId && started.headDigest === started.eventDigest &&
    Number.isSafeInteger(started.sequence) && started.sequence > 0 && started.eventCount === started.sequence &&
    cohort.routes.some(entry => entry.repositoryId === route.repositoryId &&
      entry.launcherId === route.launcherId && entry.sourceId === route.sourceId),
  "ECANARY_NATIVE_V3_TERMINAL_BINDING");
  return { config, identity, source, route, started, cohort };
}

async function readBoundStart(binding) {
  const { config, identity, source, route, started, cohort } = binding;
  const replay = await readCanaryLedgerV1({ journalPath: config.journalPath });
  requireFact(replay.ledgerId === started.ledgerId &&
    replay.registration.registrationDigest === cohort.registration.registrationDigest,
  "ECANARY_NATIVE_V3_TERMINAL_REGISTRATION");
  const run = replay.runs.find(item => item.start.payload.repositoryId === route.repositoryId &&
    item.start.payload.runId === identity.runId);
  const event = run?.start;
  const startIdentity = hash(JSON.stringify([
    cohort.cohortDigest, route.repositoryId, route.launcherId, route.sourceId, identity.runId
  ]));
  requireFact(event && event.eventDigest === started.eventDigest && event.sequence === started.sequence &&
    event.ledgerId === started.ledgerId && event.eventId === "start-" + startIdentity &&
    event.idempotencyKey === "start-" + startIdentity && event.op === "RUN_STARTED" &&
    event.payload.repositoryRevision === cohort.registration.revision && event.payload.origin === "NATURAL" &&
    event.provenance.producerId === route.launcherId && event.provenance.sourceId === route.sourceId &&
    event.provenance.sourceRevision === source.revision && event.provenance.sourceDigest === source.digest,
  "ECANARY_NATIVE_V3_TERMINAL_START");
  requireFact(run.finish === null, "ECANARY_NATIVE_V3_TERMINAL_RECONCILE_REQUIRED");
  return { replay, event };
}

async function appendBoundFinish(binding, journal, executionOutcome, outcomeKnown, attemptedOutcome, cleanupFailure = null) {
  const { config, identity, source, route, started, cohort } = binding;
  const { replay, event } = journal;
  const phase = "append";
  const finishIdentity = hash(JSON.stringify([
    cohort.cohortDigest, route.repositoryId, route.launcherId, route.sourceId, identity.runId, started.eventDigest
  ]));
  const appended = await appendCanaryEventV1({
    journalPath: config.journalPath,
    expectedHeadDigest: replay.headDigest, expectedEventCount: replay.eventCount,
    request: {
      ledgerId: started.ledgerId, eventId: "finish-" + finishIdentity,
      idempotencyKey: "finish-" + finishIdentity, op: "RUN_FINISHED", at: new Date().toISOString(),
      // Preserve existing provenance and evidence contracts; do not invent a
      // terminal attestation or promote these caller-supplied refs to trust.
      provenance: {
        producerId: route.launcherId, sourceId: route.sourceId,
        sourceRevision: source.revision, sourceDigest: source.digest,
        evidenceRefs: event.provenance.evidenceRefs
      },
      payload: { repositoryId: route.repositoryId, runId: identity.runId, outcome: attemptedOutcome }
    }
  });
  if (appended.idempotent || appended.appended !== true) {
    return localObservation(executionOutcome, {
      recorded: null, observation: "UNKNOWN", attemptedOutcome,
      reasonCode: "ECANARY_NATIVE_V3_TERMINAL_RECONCILE_REQUIRED", failurePhase: phase
    });
  }
  return localObservation(executionOutcome, {
    recorded: true, observation: "FINISHED", canaryOutcome: attemptedOutcome,
    ledgerId: appended.event.ledgerId, sequence: appended.event.sequence,
    eventDigest: appended.event.eventDigest, headDigest: appended.headDigest, eventCount: appended.eventCount,
    reasonCode: outcomeKnown ? "CANARY_NATIVE_V3_TERMINAL_OBSERVED" : "ECANARY_NATIVE_V3_CLEANUP_UNKNOWN",
    ...(outcomeKnown ? {} : { failure: cleanupFailure ?? { code: "ECANARY_NATIVE_V3_CLEANUP_UNKNOWN",
      message: "Terminal execution was observed but cleanup/outcome remains unknown" } })
  });
}

/** Called by the opted-in plan CLI only after its execution/stop/control-cleanup
 * receipt is constructed. It never dispatches, registers, retries or changes the
 * execution outcome. This adapter is not an authenticated terminal reader.
 */
export async function recordCanaryNativeV3PlanTerminalV1({
  configuration, prepared, startReceipt, execution, executionErrorObserved, executionReceipt
} = {}) {
  const executionOutcome = typeof execution?.status === "string" ? execution.status :
    (typeof executionReceipt?.executionOutcome === "string" ? executionReceipt.executionOutcome : null);
  if (executionErrorObserved !== false || execution?.schemaVersion !== 1 ||
      execution.kind !== PLAN_RESULT_KIND || !Object.hasOwn(OUTCOMES, execution.status)) {
    return localObservation(executionOutcome, { reasonCode: "ECANARY_NATIVE_V3_TERMINAL_UNOBSERVED" });
  }
  let phase = "binding", attemptedOutcome = null;
  try {
    const binding = terminalBinding(configuration, prepared, startReceipt,
      ["planId", "runId", "planDigest", "contractDigest", "sourceBinding"]);
    const { identity, source, started } = binding;
    requireFact(execution.runId === identity.runId && execution.planId === identity.planId &&
      execution.planDigest === identity.planDigest && execution.contractDigest === identity.contractDigest &&
      boundCheckpoint(execution.checkpoint, identity, execution.status) &&
      executionReceipt?.schemaVersion === 1 && executionReceipt.kind === CLI_PLAN_RESULT_KIND &&
      executionReceipt.runId === identity.runId && executionReceipt.planId === identity.planId &&
      executionReceipt.planDigest === identity.planDigest && executionReceipt.contractDigest === identity.contractDigest &&
      executionReceipt.sourceBinding?.revision === source.revision && executionReceipt.sourceBinding.digest === source.digest &&
      executionReceipt.executionOutcome === execution.status &&
      boundCheckpoint(executionReceipt.checkpoint, identity, execution.status) &&
      executionReceipt.canaryStartReceipt?.eventDigest === started.eventDigest,
    "ECANARY_NATIVE_V3_TERMINAL_BINDING");

    phase = "journal";
    const journal = await readBoundStart(binding);

    // A fulfilled cancel() returns a checkpoint, not a separate completion
    // receipt (core:4616-4628). Only a coherent final checkpoint is usable here.
    // Unrecognized/intermediate stop facts cannot turn success into SUCCEEDED.
    const stopKnown = !Object.hasOwn(executionReceipt, "stopReceipt") ||
      (boundCheckpoint(executionReceipt.stopReceipt, identity, execution.status) &&
        executionReceipt.stopReceipt.status !== "unknown" &&
        executionReceipt.stopReceipt.reconcileRequired === false);
    const cleanupKnown = executionReceipt.controlCleanup?.closed === true &&
      executionReceipt.controlCleanup.completed === true && !Object.hasOwn(executionReceipt, "stopError") &&
      stopKnown && execution.reconcileRequired === false && execution.checkpoint.reconcileRequired === false;
    const outcomeKnown = cleanupKnown && (execution.status !== "succeeded" || executionReceipt.ok === true);
    attemptedOutcome = outcomeKnown ? OUTCOMES[execution.status] : "UNKNOWN";

    phase = "append";
    return await appendBoundFinish(binding, journal, executionOutcome, outcomeKnown, attemptedOutcome);
  } catch (error) {
    // Append may have reached storage before readback failed. No retry or
    // success fallback is safe; expose the ambiguity independently of execution.
    return localObservation(executionOutcome, {
      recorded: phase === "append" ? null : false, observation: "UNKNOWN", attemptedOutcome,
      reasonCode: typeof error?.code === "string" ? error.code : "ECANARY_NATIVE_V3_TERMINAL_UNKNOWN",
      failurePhase: phase,
      failure: { code: typeof error?.code === "string" ? error.code : "ECANARY_NATIVE_V3_TERMINAL_UNKNOWN",
        message: "Canary terminal observation requires reconciliation" }
    });
  }
}

/** Called by the fixed command CLI after execution/stop/control-cleanup receipt
 * construction. The persisted sealed marker proves logical terminality only.
 * groupTerminated, watcher cleanup and stop handling are local observations,
 * not a host-qualified cleanup attestation or producer/stream authentication.
 * The execute result has no top-level kind/schema; nested records retain the
 * existing ExecutionHandleV1 / ExecutionIntentV1 contracts.
 */
export async function recordCanaryNativeV3CommandTerminalV1({
  configuration, prepared, startReceipt, execution, executionErrorObserved, executionReceipt
} = {}) {
  const executionOutcome = typeof execution?.outcome === "string" ? execution.outcome :
    (typeof executionReceipt?.executionOutcome === "string" ? executionReceipt.executionOutcome : null);
  // execution-runtime-v1.mjs:7693-7704, from registry.execute() through the
  // fixed runner. Promise settlement or runner.status() alone is insufficient.
  if (executionErrorObserved !== false || !["success", "failure"].includes(executionOutcome) ||
      execution?.handle?.schemaVersion !== 1 || execution.handle.kind !== "ExecutionHandleV1" ||
      execution?.intent?.schemaVersion !== 1 || execution.intent.kind !== "ExecutionIntentV1" ||
      execution?.intent?.status !== "sealed" || execution.intent.callbackCalls !== 1 ||
      execution.intent.dispatchReserved !== false || execution.intent.outcome !== executionOutcome ||
      execution?.handle?.status !== (executionOutcome === "success" ? "completed" : "failed")) {
    return localObservation(executionOutcome, { reasonCode: "ECANARY_NATIVE_V3_TERMINAL_UNOBSERVED" });
  }
  let phase = "binding", attemptedOutcome = null;
  try {
    const commandKeys = ["taskId", "unitId", "executionId", "attemptId", "handleId", "effectBindingDigest"];
    const binding = terminalBinding(configuration, prepared, startReceipt,
      ["planId", "runId", "planDigest", "contractDigest", "sourceBinding", ...commandKeys]);
    const { identity, source, started } = binding;
    requireFact(commandKeys.slice(0, -1).every(key => typeof identity[key] === "string" && ID.test(identity[key])) &&
      typeof identity.effectBindingDigest === "string" && DIGEST.test(identity.effectBindingDigest) &&
      executionReceipt?.schemaVersion === 1 && executionReceipt.kind === CLI_COMMAND_RESULT_KIND &&
      ["planId", "runId", "planDigest", "contractDigest", ...commandKeys].every(key => executionReceipt[key] === identity[key]) &&
      executionReceipt.sourceBinding?.revision === source.revision && executionReceipt.sourceBinding.digest === source.digest &&
      executionReceipt.canaryStartReceipt?.eventDigest === started.eventDigest &&
      (!Object.hasOwn(executionReceipt, "execution") || executionReceipt.execution === execution) &&
      (!Object.hasOwn(executionReceipt, "executionOutcome") || executionReceipt.executionOutcome === executionOutcome),
    "ECANARY_NATIVE_V3_TERMINAL_BINDING");
    // Bind the actual registry result to this allocation, not only the CLI's
    // prepared metadata. These necessary local facts do not authenticate it.
    requireFact([execution.handle, execution.intent].every(record =>
      ["runId", "unitId", "executionId", "attemptId", "handleId"].every(key => record[key] === identity[key]) &&
      record.revision === source.revision && record.sourceBindingDigest === source.digest &&
      record.policyDigest === executionReceipt.policyDigest),
    "ECANARY_NATIVE_V3_TERMINAL_BINDING");

    phase = "journal";
    const journal = await readBoundStart(binding);
    const missing = [];
    // The actual command effect returns these fields only after a determinate
    // completion (native-v3-command-runner.mjs:1198-1211). This is still local.
    if (execution.effect?.groupTerminated !== true) missing.push("execution.effect.groupTerminated=true");
    if (execution.effect?.outcome !== executionOutcome) missing.push("matching execution.effect.outcome");
    if (executionReceipt.controlCleanup?.closed !== true || executionReceipt.controlCleanup?.completed !== true) {
      missing.push("controlCleanup.closed/completed=true");
    }
    if (Object.hasOwn(executionReceipt, "stopError")) missing.push("stop handling without error");
    if (Object.hasOwn(executionReceipt, "stopReceipt") && executionReceipt.stopReceipt?.outcome !== "STOPPED") {
      missing.push("stopReceipt.outcome=STOPPED");
    }
    if (Object.hasOwn(executionReceipt, "workflowControlStop")) {
      const control = executionReceipt.workflowControlStop;
      const receipt = control?.receipt;
      if (control?.settled !== true || control.error !== null ||
          receipt?.schemaVersion !== 1 || receipt.kind !== "StopReceiptV1" ||
          receipt.outcome !== "STOPPED" || receipt.confirmedOwnedScope !== true || receipt.localOutcome !== "stopped" ||
          !["runId", "unitId", "executionId", "attemptId", "handleId"].every(key => receipt[key] === identity[key]) ||
          receipt.ownedResourceId !== execution.handle.ownedResourceId || receipt.revision !== source.revision ||
          receipt.sourceBindingDigest !== source.digest || receipt.policyDigest !== executionReceipt.policyDigest) {
        missing.push("matching settled workflowControlStop STOPPED receipt");
      }
    }
    const success = executionOutcome === "success";
    if (executionReceipt.status !== (success ? "SUCCESS" : "FAILURE") || executionReceipt.ok !== success) {
      missing.push("matching CLI settled status/ok");
    }
    const outcomeKnown = missing.length === 0;
    attemptedOutcome = outcomeKnown ? (success ? "SUCCEEDED" : "FAILED") : "UNKNOWN";
    phase = "append";
    return await appendBoundFinish(binding, journal, executionOutcome, outcomeKnown, attemptedOutcome,
      outcomeKnown ? null : { code: "ECANARY_NATIVE_V3_CLEANUP_UNKNOWN",
        message: "Logical command terminal was observed; missing local facts: " + missing.join(", ") });
  } catch (error) {
    // Match the plan adapter's no-retry reconciliation result. A storage write
    // can have succeeded even when append readback failed.
    return localObservation(executionOutcome, {
      recorded: phase === "append" ? null : false, observation: "UNKNOWN", attemptedOutcome,
      reasonCode: typeof error?.code === "string" ? error.code : "ECANARY_NATIVE_V3_TERMINAL_UNKNOWN",
      failurePhase: phase,
      failure: { code: typeof error?.code === "string" ? error.code : "ECANARY_NATIVE_V3_TERMINAL_UNKNOWN",
        message: "Canary terminal observation requires reconciliation" }
    });
  }
}
