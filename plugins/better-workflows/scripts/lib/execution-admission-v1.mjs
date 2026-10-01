import {
  digestObject,
  canonicalJson
} from "./core.mjs";
import {
  digestTaskContractV3,
  digestWorkflowPlanV1,
  validateTaskContractV3,
  validateWorkflowPlanV1
} from "./workflow-plan-v1.mjs";

export const EXECUTION_ADMISSION_SCHEMA_VERSION = 1;
export const EXECUTION_ADMISSION_KIND = "ExecutionAdmissionV1";
export const APPROVAL_ENVELOPE_KIND = "ApprovalEnvelope";
export const ACTION_CAPABILITY_KIND = "ActionCapabilityV1";
export const RUN_CONTRACT_V3_KIND = "RunContractV3";
export const TRUSTED_ADMISSION_SEAL_KIND = "TrustedAdmissionSealV1";

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@~-]{0,127}$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${label} must be a plain object`);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.has(key)) throw new Error(`${label} contains forbidden key: ${key}`);
    if (child && typeof child === "object") {
      if (Array.isArray(child)) child.forEach((item) => item && typeof item === "object" && object(item, `${label}.${key}`));
      else object(child, `${label}.${key}`);
    }
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function exact(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function text(value, label, pattern = null, max = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  if (pattern && !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function id(value, label) { return text(value, label, ID); }
function digest(value, label) { return text(value, label, DIGEST); }
function revision(value, label) { return text(value, label, REVISION); }
function model(value, label) { return text(value, label, MODEL_ID, 128); }
function epoch(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
  return value;
}
function iso(value, label) {
  text(value, label);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  return value;
}
function same(a, b) { return canonicalJson(a) === canonicalJson(b); }

function normalizeScope(value, label) {
  object(value, label);
  exact(value, ["include", "exclude"], label);
  if (!Array.isArray(value.include) || !Array.isArray(value.exclude)) throw new Error(`${label} must contain include and exclude arrays`);
  const normalize = (items, itemLabel) => {
    const values = items.map((item, index) => text(item, `${itemLabel}[${index}]`, null, 4096));
    if (new Set(values).size !== values.length) throw new Error(`${itemLabel} contains duplicates`);
    return [...values].sort();
  };
  return { include: normalize(value.include, `${label}.include`), exclude: normalize(value.exclude, `${label}.exclude`) };
}

function normalizeBudget(value, label) {
  object(value, label);
  exact(value, ["attempts", "seconds", "tokens"], label);
  const normalize = (item, itemLabel, nullable) => {
    if (item === null && nullable) return null;
    if (!Number.isSafeInteger(item) || item <= 0 || item > 1_000_000) throw new Error(`${itemLabel} is invalid`);
    return item;
  };
  return {
    attempts: normalize(value.attempts, `${label}.attempts`, false),
    seconds: normalize(value.seconds, `${label}.seconds`, true),
    tokens: normalize(value.tokens, `${label}.tokens`, true)
  };
}

const COMMON_KEYS = [
  "runId", "executionId", "attemptId", "ownedResourceId", "planDigest", "contractDigest", "sourceBindingDigest", "policyDigest", "revision", "taskId", "unitId",
  "scope", "recipient", "action", "budget", "expiresAt", "nonce"
];

function commonFrom(value, label) {
  const result = {
    runId: id(value.runId, `${label}.runId`),
    executionId: id(value.executionId, `${label}.executionId`),
    attemptId: id(value.attemptId, `${label}.attemptId`),
    ownedResourceId: id(value.ownedResourceId, `${label}.ownedResourceId`),
    planDigest: digest(value.planDigest, `${label}.planDigest`),
    contractDigest: digest(value.contractDigest, `${label}.contractDigest`),
    sourceBindingDigest: digest(value.sourceBindingDigest, `${label}.sourceBindingDigest`),
    policyDigest: digest(value.policyDigest, `${label}.policyDigest`),
    revision: revision(value.revision, `${label}.revision`),
    taskId: id(value.taskId, `${label}.taskId`),
    unitId: id(value.unitId, `${label}.unitId`),
    scope: normalizeScope(value.scope, `${label}.scope`),
    recipient: text(value.recipient, `${label}.recipient`),
    action: text(value.action, `${label}.action`),
    budget: normalizeBudget(value.budget, `${label}.budget`),
    expiresAt: iso(value.expiresAt, `${label}.expiresAt`),
    nonce: id(value.nonce, `${label}.nonce`)
  };
  return result;
}

// `requestedModel` is a TCB selection binding only. Provider-reported or
// provider-attested identities remain outside this admission projection.
function optionalRequestedModel(value, label) {
  return Object.hasOwn(value, "requestedModel")
    ? { requestedModel: model(value.requestedModel, `${label}.requestedModel`) }
    : {};
}

function unsignedEnvelope(value) {
  const { digest: ignored, ...withoutDigest } = value;
  return withoutDigest;
}

export function digestApprovalEnvelope(value) {
  const normalized = validateApprovalEnvelope(value);
  return digestObject(unsignedEnvelope(normalized));
}

export function validateApprovalEnvelope(value) {
  object(value, APPROVAL_ENVELOPE_KIND);
  const allowed = ["schemaVersion", "kind", "envelopeId", "digest", "requestedModel", ...COMMON_KEYS];
  const actual = Object.keys(value);
  if (!actual.every((key) => allowed.includes(key)) || !actual.includes("schemaVersion") || !actual.includes("kind") ||
      !actual.includes("envelopeId") || !actual.includes("digest") || COMMON_KEYS.some((key) => !actual.includes(key))) {
    throw new Error(`${APPROVAL_ENVELOPE_KIND} has an unexpected shape`);
  }
  if (value.schemaVersion !== 1 || value.kind !== APPROVAL_ENVELOPE_KIND) throw new Error(`${APPROVAL_ENVELOPE_KIND} version/kind is invalid`);
  const normalized = { schemaVersion: 1, kind: APPROVAL_ENVELOPE_KIND, envelopeId: id(value.envelopeId, `${APPROVAL_ENVELOPE_KIND}.envelopeId`), digest: digest(value.digest, `${APPROVAL_ENVELOPE_KIND}.digest`), ...commonFrom(value, APPROVAL_ENVELOPE_KIND), ...optionalRequestedModel(value, APPROVAL_ENVELOPE_KIND) };
  if (digestObject(unsignedEnvelope(normalized)) !== normalized.digest) throw new Error(`${APPROVAL_ENVELOPE_KIND}.digest is not bound`);
  return normalized;
}

export function digestActionCapability(value) {
  const normalized = validateActionCapability(value);
  return digestObject(unsignedCapability(normalized));
}

function unsignedCapability(value) {
  const { digest: ignored, ...withoutDigest } = value;
  return withoutDigest;
}

export function validateActionCapability(value) {
  object(value, ACTION_CAPABILITY_KIND);
  const allowed = ["schemaVersion", "kind", "capabilityId", "digest", "envelopeDigest", "requestedModel", ...COMMON_KEYS, "authorityEpoch", "fence"];
  const actual = Object.keys(value);
  if (!actual.every((key) => allowed.includes(key)) || !actual.includes("schemaVersion") || !actual.includes("kind") ||
      !actual.includes("capabilityId") || !actual.includes("envelopeDigest") || !actual.includes("authorityEpoch") || !actual.includes("fence") ||
      COMMON_KEYS.some((key) => !actual.includes(key))) {
    throw new Error(`${ACTION_CAPABILITY_KIND} has an unexpected shape`);
  }
  if (value.schemaVersion !== 1 || value.kind !== ACTION_CAPABILITY_KIND) throw new Error(`${ACTION_CAPABILITY_KIND} version/kind is invalid`);
  const normalized = {
    schemaVersion: 1,
    kind: ACTION_CAPABILITY_KIND,
    capabilityId: id(value.capabilityId, `${ACTION_CAPABILITY_KIND}.capabilityId`),
    ...(value.digest === undefined ? {} : { digest: digest(value.digest, `${ACTION_CAPABILITY_KIND}.digest`) }),
    envelopeDigest: digest(value.envelopeDigest, `${ACTION_CAPABILITY_KIND}.envelopeDigest`),
    ...commonFrom(value, ACTION_CAPABILITY_KIND),
    ...optionalRequestedModel(value, ACTION_CAPABILITY_KIND),
    authorityEpoch: epoch(value.authorityEpoch, `${ACTION_CAPABILITY_KIND}.authorityEpoch`),
    fence: digest(value.fence, `${ACTION_CAPABILITY_KIND}.fence`)
  };
  if (normalized.digest !== undefined && digestObject(unsignedCapability(normalized)) !== normalized.digest) {
    throw new Error(`${ACTION_CAPABILITY_KIND}.digest is not bound`);
  }
  return normalized;
}

const ADMISSION_KEYS = [
  "schemaVersion", "kind", "admissionId", "requestedModel", ...COMMON_KEYS,
  "authorityEpoch", "fence", "envelopeDigest", "capabilityDigest"
];
const ADMISSION_REQUIRED_KEYS = ADMISSION_KEYS.filter((key) => key !== "requestedModel");

export function validateExecutionAdmission(value) {
  object(value, EXECUTION_ADMISSION_KIND);
  const actual = Object.keys(value);
  if (!actual.every((key) => ADMISSION_KEYS.includes(key)) ||
      ADMISSION_REQUIRED_KEYS.some((key) => !actual.includes(key))) {
    throw new Error(`${EXECUTION_ADMISSION_KIND} has an unexpected shape`);
  }
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_ADMISSION_KIND) throw new Error(`${EXECUTION_ADMISSION_KIND} version/kind is invalid`);
  const normalized = {
    schemaVersion: 1,
    kind: EXECUTION_ADMISSION_KIND,
    admissionId: id(value.admissionId, `${EXECUTION_ADMISSION_KIND}.admissionId`),
    runId: id(value.runId, `${EXECUTION_ADMISSION_KIND}.runId`),
    executionId: id(value.executionId, `${EXECUTION_ADMISSION_KIND}.executionId`),
    attemptId: id(value.attemptId, `${EXECUTION_ADMISSION_KIND}.attemptId`),
    ...commonFrom(value, EXECUTION_ADMISSION_KIND),
    ...optionalRequestedModel(value, EXECUTION_ADMISSION_KIND),
    authorityEpoch: epoch(value.authorityEpoch, `${EXECUTION_ADMISSION_KIND}.authorityEpoch`),
    fence: digest(value.fence, `${EXECUTION_ADMISSION_KIND}.fence`),
    envelopeDigest: digest(value.envelopeDigest, `${EXECUTION_ADMISSION_KIND}.envelopeDigest`),
    capabilityDigest: digest(value.capabilityDigest, `${EXECUTION_ADMISSION_KIND}.capabilityDigest`)
  };
  return normalized;
}

export function digestExecutionAdmission(value) {
  return digestObject(validateExecutionAdmission(value));
}

export function validateTrustedAdmissionSeal(value, expected = {}) {
  object(value, TRUSTED_ADMISSION_SEAL_KIND);
  exact(value, [
    "schemaVersion", "kind", "status", "runId", "handleId", "intentId", "admissionDigest",
    "authorityEpoch", "fence", "outcome", "effectDigest", "committedAt"
  ], TRUSTED_ADMISSION_SEAL_KIND);
  if (value.schemaVersion !== 1 || value.kind !== TRUSTED_ADMISSION_SEAL_KIND || value.status !== "committed") {
    throw new Error(`${TRUSTED_ADMISSION_SEAL_KIND} version/kind/status is invalid`);
  }
  id(value.runId, `${TRUSTED_ADMISSION_SEAL_KIND}.runId`);
  id(value.handleId, `${TRUSTED_ADMISSION_SEAL_KIND}.handleId`);
  id(value.intentId, `${TRUSTED_ADMISSION_SEAL_KIND}.intentId`);
  digest(value.admissionDigest, `${TRUSTED_ADMISSION_SEAL_KIND}.admissionDigest`);
  epoch(value.authorityEpoch, `${TRUSTED_ADMISSION_SEAL_KIND}.authorityEpoch`);
  digest(value.fence, `${TRUSTED_ADMISSION_SEAL_KIND}.fence`);
  if (value.outcome !== "success" && value.outcome !== "failure") {
    throw new Error(`${TRUSTED_ADMISSION_SEAL_KIND}.outcome is invalid`);
  }
  digest(value.effectDigest, `${TRUSTED_ADMISSION_SEAL_KIND}.effectDigest`);
  iso(value.committedAt, `${TRUSTED_ADMISSION_SEAL_KIND}.committedAt`);
  for (const key of ["runId", "handleId", "intentId", "admissionDigest", "authorityEpoch", "fence", "outcome", "effectDigest"]) {
    if (expected[key] !== undefined && value[key] !== expected[key]) throw new Error(`${TRUSTED_ADMISSION_SEAL_KIND}.${key} is not bound`);
  }
  return { ...value };
}

export function isV3RunContract(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (
    value.kind === RUN_CONTRACT_V3_KIND || value.schemaVersion === 3 || value.taskContract?.schemaVersion === 3 ||
    value.plan?.taskContract?.schemaVersion === 3 || value.workflowPlan?.taskContract?.schemaVersion === 3
  ));
}

export function isV3Authority(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (
    value.capability?.kind === ACTION_CAPABILITY_KIND || value.envelope?.kind === APPROVAL_ENVELOPE_KIND ||
    value.planDigest !== undefined || value.contractDigest !== undefined || value.nonce !== undefined
  ));
}

function normalizeRunContract(value, requested) {
  object(value, "run contract");
  if (value.schemaVersion !== 3 || value.kind !== RUN_CONTRACT_V3_KIND) throw new Error("V3 run contract version/kind is invalid");
  const plan = value.plan ?? value.workflowPlan ?? null;
  if (!plan) throw new Error("V3 run contract requires a complete immutable WorkflowPlanV1");
  const contractInput = plan.taskContract;
  if (!contractInput) throw new Error("V3 run contract requires a native TaskContractV3 inside WorkflowPlanV1");
  const contract = validateTaskContractV3(contractInput);
  const computedContractDigest = digestTaskContractV3(contract);
  const planDigest = value.planDigest ?? plan?.planDigest;
  const contractDigest = value.contractDigest ?? plan?.contractDigest ?? computedContractDigest;
  digest(planDigest, "run contract.planDigest");
  digest(contractDigest, "run contract.contractDigest");
  if (contractDigest !== computedContractDigest) throw new Error("V3 run contract contractDigest does not match native TaskContractV3");
  if (plan) {
    const validatedPlan = validateWorkflowPlanV1(plan);
    if (validatedPlan.planDigest !== planDigest || validatedPlan.contractDigest !== contractDigest) throw new Error("V3 run contract plan digest is not bound");
    if (digestWorkflowPlanV1(validatedPlan) !== planDigest) throw new Error("V3 run contract plan is not immutable");
  }
  if (value.runId !== requested.runId || value.revision !== requested.revision ||
      value.sourceBindingDigest !== requested.sourceBindingDigest || value.policyDigest !== requested.policyDigest) {
    throw new Error("V3 run contract binding does not match the requested execution");
  }
  const status = value.status ?? "active";
  if (!["active", "running"].includes(status)) throw new Error("V3 run contract is not active");
  const source = contract.bindings.source;
  const policy = contract.bindings.policy;
  if (source.revision !== requested.revision || source.digest !== requested.sourceBindingDigest || policy.digest !== requested.policyDigest) {
    throw new Error("V3 native contract bindings do not match the requested execution");
  }
  return {
    schemaVersion: 3,
    kind: RUN_CONTRACT_V3_KIND,
    runId: requested.runId,
    status,
    planDigest,
    contractDigest,
    taskContract: contract,
    revision: requested.revision,
    sourceBindingDigest: requested.sourceBindingDigest,
    policyDigest: requested.policyDigest
  };
}

function assertCommonMatches(left, right, label) {
  for (const key of COMMON_KEYS) if (!same(left[key], right[key])) throw new Error(`${label}.${key} drifted`);
}

function assertRequestedModelMatches(left, right, label) {
  const leftHas = Object.hasOwn(left, "requestedModel");
  const rightHas = Object.hasOwn(right, "requestedModel");
  if (leftHas !== rightHas || (leftHas && left.requestedModel !== right.requestedModel)) {
    throw new Error(`${label}.requestedModel drifted`);
  }
}

function assertModelSelection(run, task, capability) {
  const parentPolicy = run.taskContract.modelPolicy;
  const effectivePolicy = task.modelPolicy;
  const hasSelected = Object.hasOwn(capability, "requestedModel");
  const selected = capability.requestedModel;
  const denies = new Set([...parentPolicy.deny, ...effectivePolicy.deny]);
  const allows = [parentPolicy.allow, effectivePolicy.allow].filter((items) => items.length > 0);
  const restricted = parentPolicy.allow.length > 0 || parentPolicy.deny.length > 0 ||
    effectivePolicy.allow.length > 0 || effectivePolicy.deny.length > 0 ||
    parentPolicy.requested !== null || effectivePolicy.requested !== null ||
    parentPolicy.inherit === false || effectivePolicy.inherit === false;

  // An omitted selection is retained only for the old, fully unconstrained
  // generic path; otherwise omission must not bypass native model policy.
  if (!hasSelected) {
    if (restricted) throw new Error("Action capability.requestedModel is required by the native model policy");
    return;
  }
  if (denies.has(selected)) throw new Error("Action capability.requestedModel is denied by the native model policy");
  for (const allow of allows) {
    if (!allow.includes(selected)) throw new Error("Action capability.requestedModel is outside the native model policy allow set");
  }
  if (effectivePolicy.requested !== null && selected !== effectivePolicy.requested) {
    throw new Error("Action capability.requestedModel does not match the effective task model policy");
  }
  if (effectivePolicy.requested === null && parentPolicy.requested !== null && selected !== parentPolicy.requested) {
    throw new Error("Action capability.requestedModel does not match the parent default model policy");
  }
}

export function buildExecutionAdmission({ runContract, authority, binding, now = new Date() } = {}) {
  object(runContract, "run contract");
  object(authority, "trusted execution authority");
  object(binding, "execution binding");
  const requested = {
    runId: id(binding.runId, "execution binding.runId"),
    executionId: id(binding.executionId, "execution binding.executionId"),
    attemptId: id(binding.attemptId, "execution binding.attemptId"),
    unitId: id(binding.unitId, "execution binding.unitId"),
    ownedResourceId: id(binding.ownedResourceId, "execution binding.ownedResourceId"),
    sourceBindingDigest: digest(binding.sourceBindingDigest, "execution binding.sourceBindingDigest"),
    policyDigest: digest(binding.policyDigest, "execution binding.policyDigest"),
    revision: revision(binding.revision, "execution binding.revision")
  };
  const run = normalizeRunContract(runContract, requested);
  const envelope = validateApprovalEnvelope(authority.envelope);
  const capability = validateActionCapability(authority.capability);
  if (authority.approved === true || authority.issuer !== undefined || authority.signer !== undefined) throw new Error("V3 admission rejects caller approval or issuer fields");
  if (authority.envelopeDigest !== envelope.digest || authority.capabilityDigest !== digestActionCapability(capability)) {
    throw new Error("TCB authority digest is not bound to its exact envelope/capability");
  }
  if (capability.envelopeDigest !== envelope.digest) throw new Error("Action capability is not bound to the approval envelope");
  assertCommonMatches(envelope, capability, "envelope/capability");
  assertRequestedModelMatches(envelope, capability, "envelope/capability");
  for (const field of ["runId", "executionId", "attemptId", "unitId", "ownedResourceId"]) {
    if (capability[field] !== requested[field] || envelope[field] !== requested[field]) {
      throw new Error(`V3 ${field} is not bound to the requested execution`);
    }
  }
  const task = run.taskContract.graph.tasks.find((item) => item.id === capability.taskId);
  if (!task) throw new Error("Action capability taskId is not present in the native V3 graph");
  assertModelSelection(run, task, capability);
  if (capability.unitId !== requested.unitId || capability.authorityEpoch !== authority.authorityEpoch || capability.fence !== authority.fence) {
    throw new Error("Action capability execution binding does not match the trusted authority");
  }
  if (authority.runId !== requested.runId || authority.executionId !== requested.executionId || authority.attemptId !== requested.attemptId ||
      authority.unitId !== requested.unitId || authority.sourceBindingDigest !== requested.sourceBindingDigest || authority.policyDigest !== requested.policyDigest ||
      authority.revision !== requested.revision || authority.ownedResourceId !== requested.ownedResourceId || authority.status !== "active" || authority.revoked !== false) {
    throw new Error("TCB authority execution binding is invalid");
  }
  if (capability.planDigest !== run.planDigest || capability.contractDigest !== run.contractDigest || capability.sourceBindingDigest !== run.sourceBindingDigest ||
      capability.policyDigest !== run.policyDigest || capability.revision !== run.revision || !same(capability.scope, run.taskContract.scope) ||
      !same(capability.budget, task.budget)) {
    throw new Error("Action capability is not bound to the current native V3 plan/contract");
  }
  const expires = Date.parse(capability.expiresAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs) || expires <= nowMs) throw new Error("V3 action capability has expired");
  const admission = validateExecutionAdmission({
    schemaVersion: 1,
    kind: EXECUTION_ADMISSION_KIND,
    admissionId: capability.capabilityId,
    runId: requested.runId,
    executionId: requested.executionId,
    attemptId: requested.attemptId,
    ownedResourceId: requested.ownedResourceId,
    planDigest: run.planDigest,
    contractDigest: run.contractDigest,
    sourceBindingDigest: run.sourceBindingDigest,
    policyDigest: run.policyDigest,
    revision: run.revision,
    taskId: capability.taskId,
    unitId: requested.unitId,
    scope: run.taskContract.scope,
    recipient: capability.recipient,
    action: capability.action,
    budget: capability.budget,
    expiresAt: capability.expiresAt,
    nonce: capability.nonce,
    authorityEpoch: capability.authorityEpoch,
    fence: capability.fence,
    envelopeDigest: envelope.digest,
    capabilityDigest: digestActionCapability(capability),
    ...optionalRequestedModel(capability, ACTION_CAPABILITY_KIND)
  });
  return { runContract: run, envelope, capability, admission };
}

export function assertSameExecutionAdmission(expected, actual) {
  const left = validateExecutionAdmission(expected);
  const right = validateExecutionAdmission(actual);
  if (!same(left, right)) throw new Error("Current V3 admission drifted from the durable reservation");
  return right;
}

export function reservationKey(value) {
  const admission = validateExecutionAdmission(value);
  return `${admission.runId}\u0000${admission.nonce}`;
}
