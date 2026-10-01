import { digestObject } from "./core.mjs";
import { validateWorkflowPlanV1 } from "./workflow-plan-v1.mjs";
import {
  getNativeV3VerificationConsumerApi,
  isNativeV3VerificationConsumer,
  isNativeV3VerificationInspection,
  isNativeV3VerificationReceipt,
  isNativeV3VerificationReceiptBoundToConsumer,
  isNativeV3VerificationTaskHandle,
  verifyNativeV3VerificationReceipt
} from "./native-v3-verification-consumer-v1.mjs";

export const VERIFICATION_CLI_SCHEMA_VERSION = 1;
export const VERIFICATION_CLI_KIND = "VerificationCliV1";
export const VERIFICATION_CLI_RUN_KIND = "VerificationCliRunV1";
export const VERIFICATION_CLI_EXPLAIN_KIND = "VerificationCliExplainV1";

const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUS = new Set(["pass", "fail", "hold", "unknown"]);
const RUN_KEYS = new Set(["taskId", "runId", "epoch", "unrelatedHeadDigest"]);
const EXPLAIN_KEYS = new Set(["taskId", "receipt"]);
const SERVICE_KEYS = new Set(["consumer", "plan"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new VerificationCliInputError(`${label} must be a plain object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new VerificationCliInputError(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new VerificationCliInputError(`${label} is invalid`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new VerificationCliInputError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function optionalDigest(value, label) {
  if (value === undefined || value === null) return null;
  return digest(value, label);
}

function optionalPlan(plan) {
  if (plan === undefined || plan === null) return null;
  try {
    return validateWorkflowPlanV1(plan);
  } catch (error) {
    throw new VerificationCliInputError(`plan is invalid: ${error.message}`);
  }
}

function taskFromPlan(plan, taskId) {
  const task = plan?.taskContract?.graph?.tasks?.find((candidate) => candidate.id === taskId) ?? null;
  if (!task) return null;
  return task;
}

function planBinding(plan, handle) {
  if (!plan) return null;
  if (handle.planDigest !== plan.planDigest || handle.planId !== plan.planId ||
      handle.contractDigest !== plan.contractDigest) {
    throw new VerificationCliInputError("plan does not match the trusted verification consumer");
  }
  return plan;
}

function verifyTaskHandle(handle, plan, taskId) {
  if (!isNativeV3VerificationTaskHandle(handle)) {
    throw new VerificationCliInputError("verification task handle must come from the trusted consumer");
  }
  if (handle.taskId !== taskId) {
    throw new VerificationCliInputError("verification task handle is bound to a different task");
  }
  planBinding(plan, handle);
  return handle;
}

function sameReceiptHandle(receipt, handle) {
  return [
    "planId", "planDigest", "contractDigest", "taskId", "unitId", "unitDigest",
    "cacheKey", "mode", "sourceBindingDigest", "relevantRevisionDigest"
  ].every((field) => receipt[field] === handle[field]);
}

function emptyReceiptTrust() {
  return {
    processBranded: false,
    consumerBound: false,
    currentFreshness: false
  };
}

function currentAdmissionMatchesReceipt(receipt, inspection) {
  if (inspection.status !== "current" || !inspection.currentAdmission) return false;
  const current = inspection.currentAdmission;
  const historical = receipt.currentAdmission;
  if (!historical || current.status !== "admitted" || current.cacheEligible !== true) return false;
  return [
    "admissionDigest", "unitDigest", "cacheKey", "currentContentDigest", "currentManifestDigest", "status",
    "disposition", "cacheEligible", "sourceBindingDigest", "relevantRevisionDigest"
  ].every((field) => historical[field] === current[field]);
}

async function inspectReceiptTrust({ consumer, plan, taskId, receipt }) {
  const trust = emptyReceiptTrust();
  trust.processBranded = isNativeV3VerificationReceipt(receipt);
  if (!trust.processBranded) return trust;

  let api;
  try {
    api = getNativeV3VerificationConsumerApi(consumer);
  } catch {
    return trust;
  }
  trust.consumerBound = isNativeV3VerificationReceiptBoundToConsumer(receipt, consumer);
  if (!trust.consumerBound) return trust;
  let inspection;
  try {
    inspection = await api.inspectTask({
      taskId,
      runId: receipt.runId,
      epoch: receipt.epoch,
      unrelatedHeadDigest: receipt.unrelatedHeadDigest
    });
  } catch {
    return trust;
  }
  if (!isNativeV3VerificationInspection(inspection) ||
      !isNativeV3VerificationTaskHandle(inspection.handle)) {
    return trust;
  }
  const handle = inspection.handle;
  trust.consumerBound = trust.consumerBound && sameReceiptHandle(receipt, handle) &&
    (!plan || (
      handle.planId === plan.planId &&
      handle.planDigest === plan.planDigest &&
      handle.contractDigest === plan.contractDigest
    ));
  if (!trust.consumerBound) return trust;
  trust.currentFreshness = currentAdmissionMatchesReceipt(receipt, inspection);
  return trust;
}

function validateRunOptions(value) {
  exactKeys(value, RUN_KEYS, "verification run options");
  return {
    taskId: safeId(value.taskId, "taskId"),
    runId: safeId(value.runId, "runId"),
    epoch: (() => {
      if (!Number.isSafeInteger(value.epoch) || value.epoch < 0) {
        throw new VerificationCliInputError("epoch must be a non-negative safe integer");
      }
      return value.epoch;
    })(),
    unrelatedHeadDigest: optionalDigest(value.unrelatedHeadDigest, "unrelatedHeadDigest")
  };
}

function verifyReceiptForHandle(receipt, handle, observation) {
  if (!isNativeV3VerificationReceipt(receipt)) {
    throw new VerificationCliReceiptError("verification consumer returned an unauthenticated receipt");
  }
  try {
    verifyNativeV3VerificationReceipt(receipt);
  } catch (error) {
    throw new VerificationCliReceiptError(`verification receipt failed validation: ${error.message}`);
  }
  const bindings = [
    ["planId", receipt.planId, handle.planId],
    ["planDigest", receipt.planDigest, handle.planDigest],
    ["contractDigest", receipt.contractDigest, handle.contractDigest],
    ["taskId", receipt.taskId, handle.taskId],
    ["unitId", receipt.unitId, handle.unitId],
    ["unitDigest", receipt.unitDigest, handle.unitDigest],
    ["cacheKey", receipt.cacheKey, handle.cacheKey],
    ["mode", receipt.mode, handle.mode],
    ["runId", receipt.runId, observation.runId],
    ["epoch", receipt.epoch, observation.epoch],
    ["unrelatedHeadDigest", receipt.unrelatedHeadDigest, observation.unrelatedHeadDigest]
  ];
  for (const [label, actual, expected] of bindings) {
    if (actual !== expected) throw new VerificationCliReceiptError(`verification receipt ${label} is not bound to this run`);
  }
  if (receipt.accepted !== false || receipt.effectAuthorized !== false) {
    throw new VerificationCliReceiptError("verification receipt cannot carry effect authority");
  }
  if (!STATUS.has(receipt.status)) {
    throw new VerificationCliReceiptError("verification receipt has an unsupported status");
  }
  return receipt;
}

function cliStatus(status) {
  if (status === "pass") return "PASS";
  if (status === "fail") return "FAIL";
  if (status === "unknown") return "UNKNOWN";
  return "HOLD";
}

function cacheProjection(receipt) {
  if (receipt.mode === "off") {
    return {
      status: "not-applicable",
      hit: null,
      authenticated: false,
      reason: "verification mode is off; no shadow cache was consulted"
    };
  }
  const load = receipt.shadow?.shadowLoad ?? null;
  if (!load) {
    return {
      status: "unknown",
      hit: null,
      authenticated: false,
      reason: "shadow cache observation is unavailable"
    };
  }
  return {
    status: load.cacheHit === true ? "hit" : "miss",
    hit: load.cacheHit === true,
    authenticated: load.authenticated === true,
    reason: load.reason,
    recordDigest: load.recordDigest ?? null,
    resultDigest: load.resultDigest ?? null,
    admissionDigest: load.admissionDigest ?? null
  };
}

function evidenceProjection(receipt) {
  return {
    receiptDigest: receipt.receiptDigest,
    receiptPath: receipt.receiptPath ?? null,
    currentAdmission: receipt.currentAdmission ?? null,
    full: receipt.full ?? null,
    shadow: receipt.shadow ?? null,
    carryForward: receipt.carryForward ?? null,
    revisionFreeze: receipt.revisionFreeze ?? null,
    cache: cacheProjection(receipt)
  };
}

function authorityProjection() {
  return {
    accepted: false,
    authoritative: false,
    effectAuthorized: false,
    automaticQualification: "off"
  };
}

function buildRunResult({ plan, handle, observation, receipt, error = null }) {
  const status = receipt ? cliStatus(receipt.status) : "UNKNOWN";
  const core = {
    schemaVersion: VERIFICATION_CLI_SCHEMA_VERSION,
    kind: VERIFICATION_CLI_RUN_KIND,
    operation: "run",
    ok: status === "PASS",
    status,
    planId: handle?.planId ?? plan?.planId ?? null,
    planDigest: handle?.planDigest ?? plan?.planDigest ?? null,
    contractDigest: handle?.contractDigest ?? plan?.contractDigest ?? null,
    taskId: handle?.taskId ?? observation.taskId,
    unitId: handle?.unitId ?? null,
    unitDigest: handle?.unitDigest ?? null,
    cacheKey: handle?.cacheKey ?? null,
    mode: receipt?.mode ?? handle?.mode ?? null,
    runId: observation.runId,
    epoch: observation.epoch,
    unrelatedHeadDigest: observation.unrelatedHeadDigest,
    reason: receipt?.reason ?? (error?.code ?? "verification result is unavailable"),
    error: error === null ? null : {
      code: typeof error.code === "string" ? error.code.slice(0, 128) : "EVERIFICATION_CLI_UNKNOWN",
      message: String(error.message ?? error).slice(0, 512),
      status: "UNKNOWN"
    },
    receipt: receipt ?? null,
    evidence: receipt ? evidenceProjection(receipt) : {
      receiptDigest: null,
      receiptPath: null,
      currentAdmission: null,
      full: null,
      shadow: null,
      carryForward: null,
      revisionFreeze: null,
      cache: { status: "unknown", hit: null, authenticated: false, reason: "no trusted receipt was produced" }
    },
    authority: authorityProjection()
  };
  return deepFreeze({ ...core, responseDigest: digestObject(core) });
}

function buildExplainResult({ plan, task, handle, receipt, receiptTrust = null, error = null }) {
  const trust = receiptTrust === null ? emptyReceiptTrust() : {
    processBranded: receiptTrust.processBranded === true,
    consumerBound: receiptTrust.consumerBound === true,
    currentFreshness: receiptTrust.currentFreshness === true
  };
  const receiptTrusted = trust.processBranded && trust.consumerBound && trust.currentFreshness;
  const claimedStatus = receipt ? cliStatus(receipt.status) : null;
  const status = receipt && receiptTrusted ? claimedStatus : "UNKNOWN";
  const dependencies = task?.verification?.dependencies ?? null;
  const unit = {
    taskId: task?.id ?? receipt?.taskId ?? null,
    unitId: handle?.unitId ?? receipt?.unitId ?? null,
    unitDigest: handle?.unitDigest ?? receipt?.unitDigest ?? null,
    cacheKey: handle?.cacheKey ?? receipt?.cacheKey ?? null,
    mode: task?.verification?.mode ?? receipt?.mode ?? null,
    relevantRevisionDigest: handle?.relevantRevisionDigest ?? receipt?.relevantRevisionDigest ?? null,
    dependencies
  };
  const cache = receipt
    ? cacheProjection(receipt)
    : { status: "unknown", hit: null, authenticated: false, reason: "explain is read-only and no evaluation receipt was supplied" };
  const reason = error?.message ?? (receiptTrusted
    ? (receipt?.reason ?? "no evaluation receipt was supplied")
    : receipt
      ? !trust.processBranded
        ? "receipt shape is digest-consistent but its process authenticity is unavailable"
        : !trust.consumerBound
          ? "receipt is not bound to this trusted verification consumer"
          : "receipt is not a current fresh admission"
      : "no evaluation receipt was supplied");
  const core = {
    schemaVersion: VERIFICATION_CLI_SCHEMA_VERSION,
    kind: VERIFICATION_CLI_EXPLAIN_KIND,
    operation: "explain",
    ok: status === "PASS",
    status,
    claimedStatus,
    receiptTrusted,
    receiptTrust: trust,
    planId: plan?.planId ?? handle?.planId ?? receipt?.planId ?? null,
    planDigest: plan?.planDigest ?? handle?.planDigest ?? receipt?.planDigest ?? null,
    contractDigest: plan?.contractDigest ?? handle?.contractDigest ?? receipt?.contractDigest ?? null,
    reason,
    error: error === null ? null : {
      code: typeof error.code === "string" ? error.code.slice(0, 128) : "EVERIFICATION_CLI_EXPLAIN",
      message: String(error.message ?? error).slice(0, 512),
      status: "UNKNOWN"
    },
    affectedUnits: [unit],
    dependencies: dependencies ?? { files: [], globs: [], indirect: [], unknown: [], available: false },
    cache,
    evidence: receipt ? {
      receiptDigest: receipt.receiptDigest,
      receiptPath: receipt.receiptPath ?? null,
      currentAdmissionDigest: receipt.currentAdmission?.admissionDigest ?? null,
      currentContentDigest: receipt.currentAdmission?.currentContentDigest ?? null,
      currentManifestDigest: receipt.currentAdmission?.currentManifestDigest ?? null
    } : null,
    readOnly: true,
    authority: authorityProjection()
  };
  return deepFreeze({ ...core, responseDigest: digestObject(core) });
}

function assertConsumer(value) {
  if (!isNativeV3VerificationConsumer(value)) {
    throw new VerificationCliInputError("consumer must come from createNativeV3VerificationConsumer");
  }
  return value;
}

function assertReceiptArgument(receipt) {
  if (receipt === undefined || receipt === null) return null;
  if (!isPlainObject(receipt)) throw new VerificationCliInputError("receipt must be a plain object");
  try {
    verifyNativeV3VerificationReceipt(receipt);
  } catch (error) {
    throw new VerificationCliInputError(`receipt is invalid: ${error.message}`);
  }
  return receipt;
}

function validateExplainOptions(value) {
  exactKeys(value, EXPLAIN_KEYS, "verification explain options");
  return {
    taskId: safeId(value.taskId, "taskId"),
    receipt: assertReceiptArgument(value.receipt)
  };
}

async function runWithContext({ consumer, plan, options }) {
  const observation = validateRunOptions(options);
  const api = getNativeV3VerificationConsumerApi(consumer);
  let handle;
  try {
    handle = verifyTaskHandle(await api.prepareTask({ taskId: observation.taskId }), plan, observation.taskId);
  } catch (error) {
    if (error instanceof VerificationCliInputError) throw error;
    return buildRunResult({
      plan,
      handle: null,
      observation,
      error: normaliseError(error, "EVERIFICATION_CLI_PREPARE")
    });
  }
  try {
    const receipt = verifyReceiptForHandle(
      await api.evaluateTask(handle, {
        runId: observation.runId,
        epoch: observation.epoch,
        unrelatedHeadDigest: observation.unrelatedHeadDigest
      }),
      handle,
      observation
    );
    return buildRunResult({ plan, handle, observation, receipt });
  } catch (error) {
    return buildRunResult({
      plan,
      handle,
      observation,
      error: normaliseError(error, "EVERIFICATION_CLI_EVALUATE")
    });
  }
}

async function explainWithContext({ consumer, plan, options }) {
  const { taskId, receipt } = validateExplainOptions(options);
  const api = getNativeV3VerificationConsumerApi(consumer);
  const task = taskFromPlan(plan, taskId);
  if (plan && !task) throw new VerificationCliInputError(`plan has no task: ${taskId}`);
  if (receipt && receipt.taskId !== taskId) {
    throw new VerificationCliInputError("receipt is bound to a different task");
  }
  if (receipt) {
    const matchesPlan = !plan || (
      receipt.planId === plan.planId &&
      receipt.planDigest === plan.planDigest &&
      receipt.contractDigest === plan.contractDigest
    );
    if (!matchesPlan) {
      return buildExplainResult({
        plan,
        task,
        receipt,
        receiptTrust: emptyReceiptTrust(),
        error: normaliseError(new VerificationCliReceiptError("receipt is not bound to the requested plan"), "EVERIFICATION_CLI_RECEIPT_BINDING")
      });
    }
    const receiptTrust = await inspectReceiptTrust({ consumer, plan, taskId, receipt });
    return buildExplainResult({ plan, task, receipt, receiptTrust });
  }
  let handle = null;
  try {
    handle = verifyTaskHandle(await api.prepareTask({ taskId }), plan, taskId);
  } catch (error) {
    if (error instanceof VerificationCliInputError) throw error;
    return buildExplainResult({ plan, task, handle: null, receipt: null, receiptTrust: emptyReceiptTrust(), error: normaliseError(error, "EVERIFICATION_CLI_EXPLAIN_PREPARE") });
  }
  return buildExplainResult({ plan, task, handle, receipt: null, receiptTrust: emptyReceiptTrust() });
}

function normaliseError(error, fallbackCode) {
  const source = error instanceof Error ? error : new Error(String(error));
  const result = new Error(source.message);
  result.name = source.name;
  result.code = typeof source.code === "string" ? source.code : fallbackCode;
  result.status = source.status;
  return result;
}

export class VerificationCliInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerificationCliInputError";
    this.code = "EVERIFICATION_CLI_INPUT";
  }
}

export class VerificationCliReceiptError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerificationCliReceiptError";
    this.code = "EVERIFICATION_CLI_RECEIPT";
  }
}

export function createVerificationCliService(options = {}) {
  exactKeys(options, SERVICE_KEYS, "createVerificationCliService options");
  const consumer = assertConsumer(options.consumer);
  const plan = optionalPlan(options.plan);
  return Object.freeze({
    run(runOptions = {}) {
      return runWithContext({ consumer, plan, options: runOptions });
    },
    explain(explainOptions = {}) {
      return explainWithContext({ consumer, plan, options: explainOptions });
    }
  });
}

export async function runVerificationCliV1(options = {}) {
  exactKeys(options, new Set(["consumer", "plan", ...RUN_KEYS]), "runVerificationCliV1 options");
  const consumer = assertConsumer(options.consumer);
  const plan = optionalPlan(options.plan);
  const { consumer: ignoredConsumer, plan: ignoredPlan, ...runOptions } = options;
  void ignoredConsumer;
  void ignoredPlan;
  return runWithContext({ consumer, plan, options: runOptions });
}

export async function explainVerificationCliV1(options = {}) {
  exactKeys(options, new Set(["consumer", "plan", ...EXPLAIN_KEYS]), "explainVerificationCliV1 options");
  const consumer = assertConsumer(options.consumer);
  const plan = optionalPlan(options.plan);
  const { consumer: ignoredConsumer, plan: ignoredPlan, ...explainOptions } = options;
  void ignoredConsumer;
  void ignoredPlan;
  return explainWithContext({ consumer, plan, options: explainOptions });
}

export const runVerificationCli = runVerificationCliV1;
export const explainVerificationCli = explainVerificationCliV1;

export default createVerificationCliService;
