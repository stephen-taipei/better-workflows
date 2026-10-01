import {
  createNativeV3PlanRunner as createNativeV3PlanRunnerCore,
  isNativeV3PlanRunner as isCoreNativeV3PlanRunner,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_CLAIM_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_RECEIPT_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_CONSUMPTION_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_COMMAND_ADOPTION_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_EFFECT_CAPABILITY_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_EFFECT_RESERVATION_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_EFFECT_TERMINAL_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_RELEASE_KIND,
  authorizeNativeV3PlanIncidentRecoveryTaskReleaseV1,
  adoptNativeV3PlanIncidentRecoveryTaskReservationV1,
  claimNativeV3PlanIncidentRecoveryHandoffV1,
  consumeNativeV3PlanIncidentRecoveryTaskReleaseV1,
  mintNativeV3PlanIncidentRecoveryTaskCapabilityV1,
  prepareNativeV3PlanIncidentRecoveryTransitionV1,
  reserveNativeV3PlanIncidentRecoveryTaskCapabilityV1,
  terminalizeNativeV3PlanIncidentRecoveryTaskReservationV1,
  isNativeV3PlanIncidentRecoveryTaskCommandAdoptionV1,
  readNativeV3PlanRunnerCheckpoint,
  isNativeV3PlanRunnerCheckpointInResumeLineage as isCoreNativeV3PlanRunnerCheckpointInResumeLineage,
  readNativeV3PlanRunnerResumeReceipt as readCoreNativeV3PlanRunnerResumeReceipt
} from "./native-v3-plan-runner-core.mjs";
import {
  createNativeV3PlanTaskAdapterFromCommandRunner,
  createNativeV3PlanTaskAdapterFromCommandRunners,
  createNativeV3PlanTaskAdapterFromCommandRunnerSet,
  isNativeV3PlanTaskAdapter
} from "./native-v3-trusted-plan-producer.mjs";

export const NATIVE_V3_PLAN_RUNNER_SCHEMA_VERSION = 1;
export const NATIVE_V3_PLAN_RUNNER_KIND = "NativeV3PlanRunnerV1";
export const NATIVE_V3_PLAN_CHECKPOINT_KIND = "NativeV3PlanRunnerCheckpointV1";
export const NATIVE_V3_PLAN_RUN_RESULT_KIND = "NativeV3PlanRunResultV1";

// The production entry point has its own private identity in addition to the
// core runner identity.  This keeps test/core objects from being accepted by
// the workflow-control production boundary merely because their public shape
// happens to match.
const PRODUCTION_PLAN_RUNNERS = new WeakSet();

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

const OPTION_KEYS = new Set([
  "stateRoot", "root", "plan", "planId", "runId", "parallelism", "taskAdapter", "readFreshPlan", "clock", "abortSignal", "stopWaitMs"
]);

function exactOptions(value, allowed, label) {
  plain(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw fail("EPLAN_RUNNER_INPUT", `${label} contains unknown option(s): ${unknown.join(", ")}`);
  }
  return value;
}

/**
 * Create the DAG scheduler only from a capability minted by the production
 * native V3 command runner.  The public boundary intentionally does not
 * accept an arbitrary prepareTask callback or caller-owned controller,
 * resource adapter, effect, approval, or digest projection.
 */
export async function createNativeV3PlanRunner(options = {}) {
  exactOptions(options, OPTION_KEYS, "createNativeV3PlanRunner options");
  if (!isNativeV3PlanTaskAdapter(options.taskAdapter)) {
    throw fail(
      "EPLAN_RUNNER_INPUT",
      "taskAdapter must come from createNativeV3PlanTaskAdapterFromCommandRunner"
    );
  }
  const runner = await createNativeV3PlanRunnerCore(options);
  if (!isCoreNativeV3PlanRunner(runner)) {
    throw fail("EPLAN_RUNNER_INPUT", "native V3 core did not return a branded plan runner");
  }
  PRODUCTION_PLAN_RUNNERS.add(runner);
  return runner;
}

export function isNativeV3PlanRunner(value) {
  return PRODUCTION_PLAN_RUNNERS.has(value);
}

export function readNativeV3PlanRunnerResumeReceipt(runner, expected = {}) {
  if (!PRODUCTION_PLAN_RUNNERS.has(runner)) return null;
  return readCoreNativeV3PlanRunnerResumeReceipt(runner, expected);
}

export function isNativeV3PlanRunnerCheckpointInResumeLineage(options = {}) {
  return isCoreNativeV3PlanRunnerCheckpointInResumeLineage(options);
}

/**
 * This name is retained only as a fail-closed migration diagnostic.  The old
 * callback factory was never a trust boundary and cannot create a production
 * plan adapter.
 */
export function createNativeV3TrustedPlanTaskAdapter() {
  throw fail(
    "EPLAN_RUNNER_INPUT",
    "callback-based plan task adapters are not supported; use an approved native V3 command runner capability"
  );
}

export function createNativeV3PosixPlanTaskAdapter() {
  throw fail(
    "EPLAN_RUNNER_INPUT",
    "callback-based POSIX plan task adapters are not supported; use an approved native V3 command runner capability"
  );
}

export {
  createNativeV3PlanTaskAdapterFromCommandRunner,
  createNativeV3PlanTaskAdapterFromCommandRunners,
  createNativeV3PlanTaskAdapterFromCommandRunnerSet,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_CLAIM_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_RECEIPT_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_CONSUMPTION_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_COMMAND_ADOPTION_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_EFFECT_CAPABILITY_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_EFFECT_RESERVATION_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_EFFECT_TERMINAL_KIND,
  NATIVE_V3_PLAN_INCIDENT_RECOVERY_TASK_RELEASE_KIND,
  authorizeNativeV3PlanIncidentRecoveryTaskReleaseV1,
  adoptNativeV3PlanIncidentRecoveryTaskReservationV1,
  claimNativeV3PlanIncidentRecoveryHandoffV1,
  consumeNativeV3PlanIncidentRecoveryTaskReleaseV1,
  mintNativeV3PlanIncidentRecoveryTaskCapabilityV1,
  prepareNativeV3PlanIncidentRecoveryTransitionV1,
  reserveNativeV3PlanIncidentRecoveryTaskCapabilityV1,
  terminalizeNativeV3PlanIncidentRecoveryTaskReservationV1,
  isNativeV3PlanIncidentRecoveryTaskCommandAdoptionV1,
  readNativeV3PlanRunnerCheckpoint
};

export default createNativeV3PlanRunner;
