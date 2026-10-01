import { randomBytes, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";

import { digestObject } from "./core.mjs";
import {
  verifyIncidentRecoveryDagPlanV1
} from "./incident-recovery-dag-v1.mjs";

export const INCIDENT_RECOVERY_DAG_AUTHORITY_SCHEMA_VERSION = 1;
export const INCIDENT_RECOVERY_DAG_AUTHORITY_KIND = "IncidentRecoveryDagRecoveryAuthorityV1";
export const INCIDENT_RECOVERY_DAG_AUTHORITY_STATE_KIND = "IncidentRecoveryDagRecoveryAuthorityStateV1";
export const INCIDENT_RECOVERY_DAG_AUTHORITY_CONSUMPTION_KIND = "IncidentRecoveryDagRecoveryAuthorityConsumptionReceiptV1";
export const INCIDENT_RECOVERY_DAG_AUTHORITY_REVOCATION_KIND = "IncidentRecoveryDagRecoveryAuthorityRevocationReceiptV1";
export const INCIDENT_RECOVERY_DAG_AUTHORITY_MAX_TTL_MS = 15 * 60 * 1_000;

const MIN_TTL_MS = 1_000;
const MAX_TASKS = 256;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ISSUERS = new WeakSet();

const AUTHORITY_KEYS = [
  "schemaVersion", "kind", "authorityId", "issuerId", "recoveryId", "recoveryPlanDigest",
  "taskIds", "authorityEpoch", "fence", "issuedAt", "expiresAt", "nonce", "authorityDigest"
];
const CONSUMPTION_KEYS = [
  "schemaVersion", "kind", "authorityId", "authorityDigest", "recoveryPlanDigest",
  "authorityEpoch", "fence", "consumedAt", "receiptDigest"
];
const REVOCATION_KEYS = [
  "schemaVersion", "kind", "authorityId", "authorityDigest", "recoveryPlanDigest",
  "authorityEpoch", "nextAuthorityEpoch", "fence", "replacementFence", "revokedAt", "reason",
  "receiptDigest"
];
const FRESH_SOURCE_KEYS = [
  "plan", "incident", "workflowPlan", "checkpoint", "executionRegistry", "budgetLedger"
];

export class IncidentRecoveryDagAuthorityError extends Error {
  constructor(code, message, status = "HOLD") {
    super(message);
    this.name = "IncidentRecoveryDagAuthorityError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = "HOLD") {
  throw new IncidentRecoveryDagAuthorityError(code, message, status);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " must be a plain object");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " contains a symbol property");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " contains an accessor property");
    }
  }
  return value;
}

function exactOptions(value, allowed, required, label) {
  assertPlainObject(value, label);
  const allowedSet = new Set(allowed);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowedSet.has(key)) fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " contains an unexpected field: " + key);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " is missing: " + key);
  }
}

function exactKeys(value, keys, label) {
  exactOptions(value, keys, keys, label);
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " is invalid");
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " is invalid");
  return value;
}

function assertInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " is invalid");
  }
  return value;
}

function assertIso(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " must be a canonical ISO timestamp");
  }
  return value;
}

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertTaskIds(value, label = "taskIds") {
  if (utilTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " must be a plain array");
  }
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_TASKS) {
    fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " length is invalid");
  }
  const result = [];
  let indices = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " contains an unexpected property");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " contains an accessor property");
    }
    result[Number(key)] = assertId(descriptor.value, label + "." + key);
    indices += 1;
  }
  if (indices !== length) fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " must not be sparse");
  for (let index = 1; index < result.length; index += 1) {
    if (compareIds(result[index - 1], result[index]) >= 0) {
      fail("EINCIDENT_DAG_AUTHORITY_INPUT", label + " must be sorted and unique");
    }
  }
  return result;
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function frozenClone(value) {
  return freezeDeep(structuredClone(value));
}

function canonicalAuthorityBody(value) {
  return {
    schemaVersion: INCIDENT_RECOVERY_DAG_AUTHORITY_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_DAG_AUTHORITY_KIND,
    authorityId: assertId(value.authorityId, "authorityId"),
    issuerId: assertId(value.issuerId, "issuerId"),
    recoveryId: assertId(value.recoveryId, "recoveryId"),
    recoveryPlanDigest: assertDigest(value.recoveryPlanDigest, "recoveryPlanDigest"),
    taskIds: assertTaskIds(value.taskIds),
    authorityEpoch: assertInteger(value.authorityEpoch, "authorityEpoch", 1),
    fence: assertDigest(value.fence, "fence"),
    issuedAt: assertIso(value.issuedAt, "issuedAt"),
    expiresAt: assertIso(value.expiresAt, "expiresAt"),
    nonce: assertDigest(value.nonce, "nonce")
  };
}

export function validateIncidentRecoveryDagRecoveryAuthorityV1(value) {
  exactKeys(value, AUTHORITY_KEYS, INCIDENT_RECOVERY_DAG_AUTHORITY_KIND);
  if (value.schemaVersion !== INCIDENT_RECOVERY_DAG_AUTHORITY_SCHEMA_VERSION ||
      value.kind !== INCIDENT_RECOVERY_DAG_AUTHORITY_KIND) {
    fail("EINCIDENT_DAG_AUTHORITY_INPUT", "authority kind or schema version is invalid");
  }
  const body = canonicalAuthorityBody(value);
  const issued = Date.parse(body.issuedAt);
  const expires = Date.parse(body.expiresAt);
  if (expires <= issued || expires - issued > INCIDENT_RECOVERY_DAG_AUTHORITY_MAX_TTL_MS) {
    fail("EINCIDENT_DAG_AUTHORITY_EXPIRY", "authority expiry window is invalid");
  }
  const authorityDigest = assertDigest(value.authorityDigest, "authorityDigest");
  if (digestObject(body) !== authorityDigest) {
    fail("EINCIDENT_DAG_AUTHORITY_INTEGRITY", "authority digest is stale");
  }
  return frozenClone({ ...body, authorityDigest });
}

export function digestIncidentRecoveryDagRecoveryAuthorityV1(value) {
  return validateIncidentRecoveryDagRecoveryAuthorityV1(value).authorityDigest;
}

function canonicalConsumptionBody(value) {
  return {
    schemaVersion: INCIDENT_RECOVERY_DAG_AUTHORITY_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_DAG_AUTHORITY_CONSUMPTION_KIND,
    authorityId: assertId(value.authorityId, "consumption.authorityId"),
    authorityDigest: assertDigest(value.authorityDigest, "consumption.authorityDigest"),
    recoveryPlanDigest: assertDigest(value.recoveryPlanDigest, "consumption.recoveryPlanDigest"),
    authorityEpoch: assertInteger(value.authorityEpoch, "consumption.authorityEpoch", 1),
    fence: assertDigest(value.fence, "consumption.fence"),
    consumedAt: assertIso(value.consumedAt, "consumption.consumedAt")
  };
}

export function validateIncidentRecoveryDagAuthorityConsumptionReceiptV1(value) {
  exactKeys(value, CONSUMPTION_KEYS, INCIDENT_RECOVERY_DAG_AUTHORITY_CONSUMPTION_KIND);
  if (value.schemaVersion !== INCIDENT_RECOVERY_DAG_AUTHORITY_SCHEMA_VERSION ||
      value.kind !== INCIDENT_RECOVERY_DAG_AUTHORITY_CONSUMPTION_KIND) {
    fail("EINCIDENT_DAG_AUTHORITY_INPUT", "consumption receipt kind or schema version is invalid");
  }
  const body = canonicalConsumptionBody(value);
  const receiptDigest = assertDigest(value.receiptDigest, "consumption.receiptDigest");
  if (digestObject(body) !== receiptDigest) fail("EINCIDENT_DAG_AUTHORITY_INTEGRITY", "consumption receipt digest is stale");
  return frozenClone({ ...body, receiptDigest });
}

function canonicalRevocationBody(value) {
  if (typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 512) {
    fail("EINCIDENT_DAG_AUTHORITY_INPUT", "revocation reason is invalid");
  }
  return {
    schemaVersion: INCIDENT_RECOVERY_DAG_AUTHORITY_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_DAG_AUTHORITY_REVOCATION_KIND,
    authorityId: assertId(value.authorityId, "revocation.authorityId"),
    authorityDigest: assertDigest(value.authorityDigest, "revocation.authorityDigest"),
    recoveryPlanDigest: assertDigest(value.recoveryPlanDigest, "revocation.recoveryPlanDigest"),
    authorityEpoch: assertInteger(value.authorityEpoch, "revocation.authorityEpoch", 1),
    nextAuthorityEpoch: assertInteger(value.nextAuthorityEpoch, "revocation.nextAuthorityEpoch", 2),
    fence: assertDigest(value.fence, "revocation.fence"),
    replacementFence: assertDigest(value.replacementFence, "revocation.replacementFence"),
    revokedAt: assertIso(value.revokedAt, "revocation.revokedAt"),
    reason: value.reason
  };
}

export function validateIncidentRecoveryDagAuthorityRevocationReceiptV1(value) {
  exactKeys(value, REVOCATION_KEYS, INCIDENT_RECOVERY_DAG_AUTHORITY_REVOCATION_KIND);
  if (value.schemaVersion !== INCIDENT_RECOVERY_DAG_AUTHORITY_SCHEMA_VERSION ||
      value.kind !== INCIDENT_RECOVERY_DAG_AUTHORITY_REVOCATION_KIND) {
    fail("EINCIDENT_DAG_AUTHORITY_INPUT", "revocation receipt kind or schema version is invalid");
  }
  const body = canonicalRevocationBody(value);
  if (body.nextAuthorityEpoch !== body.authorityEpoch + 1 || body.replacementFence === body.fence) {
    fail("EINCIDENT_DAG_AUTHORITY_INTEGRITY", "revocation receipt did not rotate epoch and fence");
  }
  const receiptDigest = assertDigest(value.receiptDigest, "revocation.receiptDigest");
  if (digestObject(body) !== receiptDigest) fail("EINCIDENT_DAG_AUTHORITY_INTEGRITY", "revocation receipt digest is stale");
  return frozenClone({ ...body, receiptDigest });
}

function currentDate(clock) {
  let raw;
  try {
    raw = clock();
  } catch {
    fail("EINCIDENT_DAG_AUTHORITY_CLOCK", "authority issuer clock failed", "UNKNOWN");
  }
  try {
    const milliseconds = raw instanceof Date ? Date.prototype.getTime.call(raw) : raw;
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) throw new TypeError("invalid date");
    return date;
  } catch {
    fail("EINCIDENT_DAG_AUTHORITY_CLOCK", "authority issuer clock is invalid", "UNKNOWN");
  }
}

function expiryDate(now, ttlMs) {
  const expiresAt = new Date(now.getTime() + ttlMs);
  if (Number.isNaN(expiresAt.getTime())) {
    fail("EINCIDENT_DAG_AUTHORITY_CLOCK", "authority expiry could not be represented", "UNKNOWN");
  }
  return expiresAt;
}

function entropyDigest(label) {
  try {
    return randomBytes(32).toString("hex");
  } catch {
    fail("EINCIDENT_DAG_AUTHORITY_ENTROPY", label + " could not be generated", "UNKNOWN");
  }
}

function authorityId() {
  try {
    return "dag-authority-" + randomUUID();
  } catch {
    fail("EINCIDENT_DAG_AUTHORITY_ENTROPY", "authority identity could not be generated", "UNKNOWN");
  }
}

function verifyFreshPlan(options, label) {
  exactOptions(options, FRESH_SOURCE_KEYS, FRESH_SOURCE_KEYS, label);
  try {
    const plan = verifyIncidentRecoveryDagPlanV1({
      plan: options.plan,
      incident: options.incident,
      workflowPlan: options.workflowPlan,
      checkpoint: options.checkpoint,
      executionRegistry: options.executionRegistry,
      budgetLedger: options.budgetLedger
    });
    if (plan.status !== "prepared") {
      fail("EINCIDENT_DAG_AUTHORITY_PLAN_STATE", "DAG recovery authority requires a fully prepared classification plan");
    }
    return plan;
  } catch (error) {
    if (error instanceof IncidentRecoveryDagAuthorityError) throw error;
    fail("EINCIDENT_DAG_AUTHORITY_STALE", "DAG recovery classification is not fresh: " + String(error?.message ?? error));
  }
}

function taskIdsForPlan(plan, requested) {
  const tasks = new Map(plan.tasks.map((task) => [task.taskId, task]));
  const recover = plan.tasks.filter((task) => task.disposition === "recover").map((task) => task.taskId);
  if (recover.length === 0) fail("EINCIDENT_DAG_AUTHORITY_PLAN_STATE", "DAG recovery plan has no recoverable task");
  const taskIds = requested === undefined ? recover : assertTaskIds(requested, "requested taskIds");
  const selected = new Set(taskIds);
  for (const taskId of taskIds) {
    const task = tasks.get(taskId);
    if (!task || task.disposition !== "recover") {
      fail("EINCIDENT_DAG_AUTHORITY_TASK", "authority task is not recoverable: " + taskId);
    }
    for (const dependency of task.dependencies) {
      if (tasks.get(dependency)?.disposition === "recover" && !selected.has(dependency)) {
        fail("EINCIDENT_DAG_AUTHORITY_TASK", "authority task subset is not dependency-closed");
      }
    }
  }
  return taskIds;
}

function assertAuthorityMatchesPlan(authority, plan) {
  if (authority.recoveryId !== plan.recoveryId || authority.recoveryPlanDigest !== plan.manifestDigest) {
    fail("EINCIDENT_DAG_AUTHORITY_STALE", "authority is bound to a different recovery classification");
  }
  const canonicalTaskIds = taskIdsForPlan(plan, authority.taskIds);
  if (digestObject(canonicalTaskIds) !== digestObject(authority.taskIds)) {
    fail("EINCIDENT_DAG_AUTHORITY_TASK", "authority task selection drifted");
  }
}

function recoveryClassificationStateDigest(plan) {
  const {
    recoveryId: ignoredRecoveryId,
    preparedAt: ignoredPreparedAt,
    manifestDigest: ignoredManifestDigest,
    ...classificationState
  } = plan;
  return digestObject(classificationState);
}

function stateSnapshot(record) {
  const body = {
    schemaVersion: INCIDENT_RECOVERY_DAG_AUTHORITY_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_DAG_AUTHORITY_STATE_KIND,
    authorityId: record.authority.authorityId,
    authorityDigest: record.authority.authorityDigest,
    recoveryPlanDigest: record.authority.recoveryPlanDigest,
    authorityEpoch: record.authority.authorityEpoch,
    fence: record.authority.fence,
    status: record.status,
    issuedAt: record.authority.issuedAt,
    expiresAt: record.authority.expiresAt,
    consumedAt: record.consumedAt,
    revokedAt: record.revokedAt,
    expiredAt: record.expiredAt,
    revocationReason: record.revocationReason,
    replacementFence: record.replacementFence
  };
  return frozenClone({ ...body, stateDigest: digestObject(body) });
}

export function isIncidentRecoveryDagAuthorityIssuerV1(value) {
  return Boolean(value && typeof value === "object" && ISSUERS.has(value));
}

export function createIncidentRecoveryDagAuthorityIssuerV1(options = {}) {
  exactOptions(options, ["issuerId", "ttlMs", "clock"], ["issuerId"], "createIncidentRecoveryDagAuthorityIssuerV1 options");
  const issuerId = assertId(options.issuerId, "issuerId");
  const ttlMs = assertInteger(options.ttlMs ?? 5 * 60 * 1_000, "ttlMs", MIN_TTL_MS, INCIDENT_RECOVERY_DAG_AUTHORITY_MAX_TTL_MS);
  if (options.clock !== undefined && typeof options.clock !== "function") {
    fail("EINCIDENT_DAG_AUTHORITY_INPUT", "clock must be a function");
  }
  const clock = options.clock ?? (() => new Date());
  const records = new Map();
  const latestByRecovery = new Map();
  const latestByClassificationState = new Map();
  let latestClockMs = null;

  function issuerNow() {
    const now = currentDate(clock);
    const nowMs = now.getTime();
    if (latestClockMs !== null && nowMs < latestClockMs) {
      fail("EINCIDENT_DAG_AUTHORITY_CLOCK", "authority issuer clock moved backwards", "UNKNOWN");
    }
    latestClockMs = nowMs;
    return now;
  }

  function recordFor(value) {
    const authority = validateIncidentRecoveryDagRecoveryAuthorityV1(value);
    if (authority.issuerId !== issuerId) fail("EINCIDENT_DAG_AUTHORITY_ISSUER", "authority belongs to a different issuer");
    const record = records.get(authority.authorityId);
    if (!record || record.authority.authorityDigest !== authority.authorityDigest) {
      fail("EINCIDENT_DAG_AUTHORITY_UNKNOWN", "authority is not present in this live issuer ledger");
    }
    return record;
  }

  function refreshExpiry(record, now) {
    if (record.status === "active" && now.getTime() >= Date.parse(record.authority.expiresAt)) {
      record.status = "expired";
      record.expiredAt = now.toISOString();
    }
    return record;
  }

  function issue(input = {}) {
    exactOptions(input, [...FRESH_SOURCE_KEYS, "taskIds"], FRESH_SOURCE_KEYS, "issuer.issue options");
    const plan = verifyFreshPlan(Object.fromEntries(FRESH_SOURCE_KEYS.map((key) => [key, input[key]])), "issuer.issue source");
    const taskIds = taskIdsForPlan(plan, input.taskIds);
    const now = issuerNow();
    const classificationStateDigest = recoveryClassificationStateDigest(plan);
    const prior = latestByRecovery.get(plan.recoveryId) ?? null;
    const priorClassification = latestByClassificationState.get(classificationStateDigest) ?? null;
    if (prior) refreshExpiry(prior, now);
    if (priorClassification && priorClassification !== prior) refreshExpiry(priorClassification, now);
    if (prior?.status === "active") fail("EINCIDENT_DAG_AUTHORITY_ACTIVE", "an active authority already exists for this recovery classification");
    if (priorClassification && priorClassification.authority.recoveryId !== plan.recoveryId) {
      fail("EINCIDENT_DAG_AUTHORITY_REPLAY", "the same recovery classification state is already bound to another recovery identity");
    }
    if (priorClassification && priorClassification !== prior) {
      fail("EINCIDENT_DAG_AUTHORITY_ROLLBACK", "a historical recovery classification state cannot be reissued");
    }
    if (priorClassification?.status === "consumed") {
      fail("EINCIDENT_DAG_AUTHORITY_SPENT", "a consumed recovery classification state cannot be reissued");
    }

    const authorityEpoch = prior ? prior.authority.authorityEpoch + 1 : 1;
    const issuedAt = now.toISOString();
    const expiresAt = expiryDate(now, ttlMs).toISOString();
    const body = {
      schemaVersion: INCIDENT_RECOVERY_DAG_AUTHORITY_SCHEMA_VERSION,
      kind: INCIDENT_RECOVERY_DAG_AUTHORITY_KIND,
      authorityId: authorityId(),
      issuerId,
      recoveryId: plan.recoveryId,
      recoveryPlanDigest: plan.manifestDigest,
      taskIds,
      authorityEpoch,
      fence: prior?.status === "revoked" ? prior.replacementFence : entropyDigest("authority fence"),
      issuedAt,
      expiresAt,
      nonce: entropyDigest("authority nonce")
    };
    const authority = validateIncidentRecoveryDagRecoveryAuthorityV1({
      ...body,
      authorityDigest: digestObject(body)
    });
    if (records.has(authority.authorityId)) fail("EINCIDENT_DAG_AUTHORITY_ENTROPY", "authority identity collided", "UNKNOWN");
    const record = {
      authority,
      status: "active",
      consumedAt: null,
      revokedAt: null,
      expiredAt: null,
      revocationReason: null,
      replacementFence: null,
      consumptionReceipt: null,
      revocationReceipt: null
    };
    records.set(authority.authorityId, record);
    latestByRecovery.set(authority.recoveryId, record);
    latestByClassificationState.set(classificationStateDigest, record);
    return authority;
  }

  function inspect(value) {
    const record = recordFor(value);
    refreshExpiry(record, issuerNow());
    return stateSnapshot(record);
  }

  function consume(input = {}) {
    exactOptions(input, ["authority", ...FRESH_SOURCE_KEYS], ["authority", ...FRESH_SOURCE_KEYS], "issuer.consume options");
    const authority = validateIncidentRecoveryDagRecoveryAuthorityV1(input.authority);
    const plan = verifyFreshPlan(Object.fromEntries(FRESH_SOURCE_KEYS.map((key) => [key, input[key]])), "issuer.consume source");
    assertAuthorityMatchesPlan(authority, plan);
    const record = recordFor(authority);
    const now = issuerNow();
    refreshExpiry(record, now);
    if (record.status === "expired") fail("EINCIDENT_DAG_AUTHORITY_EXPIRED", "authority expired before consumption");
    if (record.status === "revoked") fail("EINCIDENT_DAG_AUTHORITY_REVOKED", "authority was revoked before consumption");
    if (record.status === "consumed") fail("EINCIDENT_DAG_AUTHORITY_CONSUMED", "authority is single-use and was already consumed");
    if (record.status !== "active") fail("EINCIDENT_DAG_AUTHORITY_STATE", "authority is not active");
    const body = {
      schemaVersion: INCIDENT_RECOVERY_DAG_AUTHORITY_SCHEMA_VERSION,
      kind: INCIDENT_RECOVERY_DAG_AUTHORITY_CONSUMPTION_KIND,
      authorityId: authority.authorityId,
      authorityDigest: authority.authorityDigest,
      recoveryPlanDigest: authority.recoveryPlanDigest,
      authorityEpoch: authority.authorityEpoch,
      fence: authority.fence,
      consumedAt: now.toISOString()
    };
    const receipt = validateIncidentRecoveryDagAuthorityConsumptionReceiptV1({
      ...body,
      receiptDigest: digestObject(body)
    });
    record.status = "consumed";
    record.consumedAt = receipt.consumedAt;
    record.consumptionReceipt = receipt;
    return receipt;
  }

  function revoke(input = {}) {
    exactOptions(input, ["authority", "reason"], ["authority", "reason"], "issuer.revoke options");
    const record = recordFor(input.authority);
    const now = issuerNow();
    refreshExpiry(record, now);
    if (record.status === "revoked") {
      if (record.revocationReason !== input.reason) fail("EINCIDENT_DAG_AUTHORITY_REVOKED", "authority was already revoked for a different reason");
      return record.revocationReceipt;
    }
    if (record.status === "expired") fail("EINCIDENT_DAG_AUTHORITY_EXPIRED", "expired authority cannot be revoked");
    if (record.status === "consumed") fail("EINCIDENT_DAG_AUTHORITY_CONSUMED", "consumed authority cannot be revoked");
    if (record.status !== "active") fail("EINCIDENT_DAG_AUTHORITY_STATE", "authority is not active");
    if (typeof input.reason !== "string" || input.reason.length < 1 || input.reason.length > 512) {
      fail("EINCIDENT_DAG_AUTHORITY_INPUT", "revocation reason is invalid");
    }
    let replacementFence = entropyDigest("replacement fence");
    if (replacementFence === record.authority.fence) replacementFence = entropyDigest("replacement fence");
    const body = {
      schemaVersion: INCIDENT_RECOVERY_DAG_AUTHORITY_SCHEMA_VERSION,
      kind: INCIDENT_RECOVERY_DAG_AUTHORITY_REVOCATION_KIND,
      authorityId: record.authority.authorityId,
      authorityDigest: record.authority.authorityDigest,
      recoveryPlanDigest: record.authority.recoveryPlanDigest,
      authorityEpoch: record.authority.authorityEpoch,
      nextAuthorityEpoch: record.authority.authorityEpoch + 1,
      fence: record.authority.fence,
      replacementFence,
      revokedAt: now.toISOString(),
      reason: input.reason
    };
    const receipt = validateIncidentRecoveryDagAuthorityRevocationReceiptV1({
      ...body,
      receiptDigest: digestObject(body)
    });
    record.status = "revoked";
    record.revokedAt = receipt.revokedAt;
    record.revocationReason = receipt.reason;
    record.replacementFence = receipt.replacementFence;
    record.revocationReceipt = receipt;
    return receipt;
  }

  const issuer = Object.freeze({ issue, inspect, consume, revoke });
  ISSUERS.add(issuer);
  return issuer;
}

export function assertIncidentRecoveryDagAuthorityIssuerV1(value) {
  if (!isIncidentRecoveryDagAuthorityIssuerV1(value)) {
    fail("EINCIDENT_DAG_AUTHORITY_ISSUER", "a live branded DAG recovery authority issuer is required");
  }
  return value;
}
