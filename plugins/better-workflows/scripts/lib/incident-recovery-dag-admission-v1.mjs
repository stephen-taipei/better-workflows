import path from "node:path";
import { randomBytes } from "node:crypto";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { types as utilTypes } from "node:util";
import os from "node:os";

import {
  atomicWriteJson,
  assertNoSymlinkUnder,
  digestObject,
  ensurePrivateDir,
  readJson,
  runDirectory,
  safeJoin
} from "./core.mjs";
import {
  digestExecutionAdmission,
  reservationKey,
  validateExecutionAdmission
} from "./execution-admission-v1.mjs";
import {
  readFreshExecutionAdmissionV1,
  validateExecutionRegistrySnapshotV1
} from "./execution-runtime-v1.mjs";
import {
  assertIncidentRecoveryDagAuthorityIssuerV1,
  validateIncidentRecoveryDagAuthorityConsumptionReceiptV1,
  validateIncidentRecoveryDagRecoveryAuthorityV1
} from "./incident-recovery-dag-authority-v1.mjs";
import {
  buildIncidentRecoveryDagPlanV1,
  validateIncidentRecoveryDagPlanV1,
  verifyIncidentRecoveryDagPlanV1
} from "./incident-recovery-dag-v1.mjs";
import { validateWorkflowPlanV1 } from "./workflow-plan-v1.mjs";

export const INCIDENT_RECOVERY_DAG_ADMISSION_SCHEMA_VERSION = 1;
export const INCIDENT_RECOVERY_DAG_ADMISSION_BATCH_KIND = "IncidentRecoveryDagAdmissionBatchV1";
export const INCIDENT_RECOVERY_DAG_ADMISSION_LEDGER_KIND = "IncidentRecoveryDagAdmissionLedgerV1";
export const INCIDENT_RECOVERY_DAG_ADMISSION_LEDGER_FILE = "incident-recovery-dag-admissions-v1.json";
export const INCIDENT_RECOVERY_DAG_ADMISSION_MAX_BATCHES = 256;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const RESERVED_MAP_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));
const ADMISSION_LOCK_FILE = ".incident-recovery-dag-admission-v1.lock";
const EFFECT_AUTHORITY = Object.freeze({
  mayCreateHandle: false,
  mayDispatch: false,
  mayPerformEffects: false
});

export class IncidentRecoveryDagAdmissionError extends Error {
  constructor(code, message, status = "HOLD", details = undefined) {
    super(message);
    this.name = "IncidentRecoveryDagAdmissionError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, status = "HOLD", details = undefined) {
  throw new IncidentRecoveryDagAdmissionError(code, message, status, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} contains an accessor property`);
    }
  }
  return value;
}

function assertArray(value, label, maximum = 256) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} is invalid`);
  }
  const length = value.length;
  let indexes = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} contains an unexpected property`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} contains an accessor property`);
    }
    indexes += 1;
  }
  if (indexes !== length) fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} must not be sparse`);
  return value;
}

function assertDataTree(value, label, context = { seen: new Set(), count: 0 }, depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (depth > 64 || context.count >= 100_000) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} exceeds the data-tree bound`);
  }
  if (context.seen.has(value)) fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} contains a cycle`);
  context.seen.add(value);
  context.count += 1;
  if (Array.isArray(value)) assertArray(value, label, 100_000);
  else assertPlainObject(value, label);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assertDataTree(descriptor.value, `${label}.${String(key)}`, context, depth + 1);
  }
  context.seen.delete(value);
  return value;
}

function exactKeys(value, keys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} has an unexpected shape`);
  }
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID.test(value) || RESERVED_MAP_KEYS.has(value)) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} is invalid`);
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} is invalid`);
  }
  return value;
}

function assertIso(value, label) {
  const date = typeof value === "string" ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} is invalid`);
  }
  return value;
}

function assertInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label} is invalid`);
  }
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

function frozenClone(value) {
  return freezeDeep(clone(value));
}

function same(left, right) {
  return digestObject(left) === digestObject(right);
}

function currentDate(clock) {
  try {
    const value = clock?.now?.() ?? new Date();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) fail("EINCIDENT_DAG_ADMISSION_CLOCK", "clock returned an invalid time", "UNKNOWN");
    return date;
  } catch (error) {
    if (error instanceof IncidentRecoveryDagAdmissionError && error.status === "UNKNOWN") throw error;
    fail("EINCIDENT_DAG_ADMISSION_CLOCK", `clock failed: ${error.message}`, "UNKNOWN");
  }
}

function safeClock(clock) {
  if (clock === undefined) return undefined;
  exactKeys(clock, ["now"], "clock");
  if (typeof clock.now !== "function") {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", "clock must expose now()");
  }
  return Object.freeze({ now: clock.now.bind(clock) });
}

function storageScopeDigest(root, runId) {
  return digestObject({ schemaVersion: 1, stateRoot: path.resolve(root), runId });
}

function classificationDigest(plan) {
  const {
    recoveryId: ignoredRecoveryId,
    preparedAt: ignoredPreparedAt,
    manifestDigest: ignoredManifestDigest,
    ...classificationState
  } = plan;
  return digestObject(classificationState);
}

function bindingFromInput(value, label) {
  exactKeys(value, [
    "runId", "executionId", "attemptId", "unitId", "ownedResourceId",
    "sourceBindingDigest", "policyDigest", "revision"
  ], label);
  for (const key of ["runId", "executionId", "attemptId", "unitId", "ownedResourceId"]) {
    assertId(value[key], `${label}.${key}`);
  }
  assertDigest(value.sourceBindingDigest, `${label}.sourceBindingDigest`);
  assertDigest(value.policyDigest, `${label}.policyDigest`);
  if (typeof value.revision !== "string" || value.revision.length === 0 || value.revision.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(value.revision)) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label}.revision is invalid`);
  }
  return clone(value);
}

function validateEffectAuthority(value, label) {
  exactKeys(value, Object.keys(EFFECT_AUTHORITY), label);
  if (!same(value, EFFECT_AUTHORITY)) {
    fail("EINCIDENT_DAG_ADMISSION_AUTHORITY", `${label} must remain non-effecting`);
  }
  return clone(EFFECT_AUTHORITY);
}

function validateAdmissionEntry(value, index) {
  const label = `${INCIDENT_RECOVERY_DAG_ADMISSION_BATCH_KIND}.admissions[${index}]`;
  exactKeys(value, ["taskId", "binding", "admission", "admissionDigest", "reservationKey"], label);
  const taskId = assertId(value.taskId, `${label}.taskId`);
  const binding = bindingFromInput(value.binding, `${label}.binding`);
  let admission;
  try {
    admission = validateExecutionAdmission(value.admission);
  } catch (error) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", `${label}.admission is invalid: ${error.message}`);
  }
  const admissionDigest = assertDigest(value.admissionDigest, `${label}.admissionDigest`);
  if (digestExecutionAdmission(admission) !== admissionDigest) {
    fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", `${label}.admissionDigest is stale`);
  }
  const expectedReservation = reservationKey(admission);
  if (value.reservationKey !== expectedReservation) {
    fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", `${label}.reservationKey is stale`);
  }
  if (admission.taskId !== taskId) {
    fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", `${label}.taskId is not bound to its admission`);
  }
  for (const key of [
    "runId", "executionId", "attemptId", "unitId", "ownedResourceId",
    "sourceBindingDigest", "policyDigest", "revision"
  ]) {
    if (admission[key] !== binding[key]) {
      fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", `${label}.${key} is not bound to its admission`);
    }
  }
  return { taskId, binding, admission: clone(admission), admissionDigest, reservationKey: expectedReservation };
}

function batchBody(value) {
  const { batchDigest: ignored, ...body } = value;
  return body;
}

export function validateIncidentRecoveryDagAdmissionBatchV1(value, expected = {}) {
  assertDataTree(value, INCIDENT_RECOVERY_DAG_ADMISSION_BATCH_KIND);
  exactKeys(value, [
    "schemaVersion", "kind", "batchId", "runId", "storageScopeDigest", "recoveryId",
    "classificationDigest", "recoveryPlanDigest", "authorityId", "authorityDigest",
    "authorityEpoch", "fence", "taskIds", "admissions", "admissionsDigest", "status",
    "preparedAt", "consumptionReceipt", "committedAt", "effectAuthority", "batchDigest"
  ], INCIDENT_RECOVERY_DAG_ADMISSION_BATCH_KIND);
  if (value.schemaVersion !== INCIDENT_RECOVERY_DAG_ADMISSION_SCHEMA_VERSION ||
      value.kind !== INCIDENT_RECOVERY_DAG_ADMISSION_BATCH_KIND) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", "admission batch kind or version is invalid");
  }
  for (const key of ["batchId", "runId", "recoveryId", "authorityId"]) assertId(value[key], `admission batch.${key}`);
  for (const key of ["storageScopeDigest", "classificationDigest", "recoveryPlanDigest", "authorityDigest", "fence", "admissionsDigest", "batchDigest"]) {
    assertDigest(value[key], `admission batch.${key}`);
  }
  assertInteger(value.authorityEpoch, "admission batch.authorityEpoch", 1);
  const taskIds = assertArray(value.taskIds, "admission batch.taskIds")
    .map((taskId, index) => assertId(taskId, `admission batch.taskIds[${index}]`));
  if (taskIds.length === 0 || new Set(taskIds).size !== taskIds.length ||
      taskIds.some((taskId, index) => index > 0 && taskId < taskIds[index - 1])) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", "admission batch.taskIds must be non-empty, unique, and sorted");
  }
  const admissions = assertArray(value.admissions, "admission batch.admissions")
    .map(validateAdmissionEntry);
  if (admissions.length !== taskIds.length || admissions.some((entry, index) => entry.taskId !== taskIds[index])) {
    fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", "admission batch does not exactly cover its task ids");
  }
  if (digestObject(admissions) !== value.admissionsDigest) {
    fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", "admission batch admissions digest is stale");
  }
  if (new Set(admissions.map((entry) => entry.admission.admissionId)).size !== admissions.length ||
      new Set(admissions.map((entry) => entry.reservationKey)).size !== admissions.length ||
      new Set(admissions.map((entry) => entry.admission.executionId)).size !== admissions.length ||
      new Set(admissions.map((entry) => entry.admission.attemptId)).size !== admissions.length) {
    fail("EINCIDENT_DAG_ADMISSION_REPLAY", "admission batch contains a replayed admission, execution, attempt, or nonce identity");
  }
  if (!new Set(["prepared", "committed"]).has(value.status)) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", "admission batch.status is invalid");
  }
  assertIso(value.preparedAt, "admission batch.preparedAt");
  let receipt = null;
  if (value.status === "prepared") {
    if (value.consumptionReceipt !== null || value.committedAt !== null) {
      fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", "prepared admission batch cannot carry a consumption receipt or commit time");
    }
  } else {
    try {
      receipt = validateIncidentRecoveryDagAuthorityConsumptionReceiptV1(value.consumptionReceipt);
    } catch (error) {
      fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", `committed admission batch receipt is invalid: ${error.message}`);
    }
    assertIso(receipt.consumedAt, "admission batch.consumptionReceipt.consumedAt");
    assertIso(value.committedAt, "admission batch.committedAt");
    const preparedMs = Date.parse(value.preparedAt);
    const consumedMs = Date.parse(receipt.consumedAt);
    const committedMs = Date.parse(value.committedAt);
    if (consumedMs < preparedMs || committedMs < consumedMs) {
      fail("EINCIDENT_DAG_ADMISSION_CLOCK", "admission batch timestamps do not preserve prepare-consume-commit order", "UNKNOWN");
    }
    for (const [receiptKey, batchKey] of [
      ["authorityId", "authorityId"],
      ["authorityDigest", "authorityDigest"],
      ["recoveryPlanDigest", "recoveryPlanDigest"],
      ["authorityEpoch", "authorityEpoch"],
      ["fence", "fence"]
    ]) {
      if (receipt[receiptKey] !== value[batchKey]) {
        fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", `admission batch receipt ${receiptKey} is not bound`);
      }
    }
  }
  const effectAuthority = validateEffectAuthority(value.effectAuthority, "admission batch.effectAuthority");
  if (digestObject(batchBody(value)) !== value.batchDigest) {
    fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", "admission batch digest is stale");
  }
  if (expected.runId !== undefined && value.runId !== expected.runId) {
    fail("EINCIDENT_DAG_ADMISSION_BINDING", "admission batch runId does not match its durable scope");
  }
  if (expected.storageScopeDigest !== undefined && value.storageScopeDigest !== expected.storageScopeDigest) {
    fail("EINCIDENT_DAG_ADMISSION_BINDING", "admission batch storage scope does not match");
  }
  return freezeDeep({ ...clone(value), taskIds: [...taskIds], admissions, consumptionReceipt: receipt, effectAuthority });
}

function sealBatch(value) {
  const { batchDigest: ignored, ...body } = value;
  return validateIncidentRecoveryDagAdmissionBatchV1({ ...body, batchDigest: digestObject(body) });
}

function ledgerBody(value) {
  const { stateDigest: ignored, ...body } = value;
  return body;
}

export function validateIncidentRecoveryDagAdmissionLedgerV1(value, expected = {}) {
  assertDataTree(value, INCIDENT_RECOVERY_DAG_ADMISSION_LEDGER_KIND);
  exactKeys(value, [
    "schemaVersion", "kind", "runId", "storageScopeDigest", "sequence", "createdAt", "updatedAt",
    "records", "authorityIndex", "classificationIndex", "stateDigest"
  ], INCIDENT_RECOVERY_DAG_ADMISSION_LEDGER_KIND);
  if (value.schemaVersion !== INCIDENT_RECOVERY_DAG_ADMISSION_SCHEMA_VERSION ||
      value.kind !== INCIDENT_RECOVERY_DAG_ADMISSION_LEDGER_KIND) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", "admission ledger kind or version is invalid");
  }
  const runId = assertId(value.runId, "admission ledger.runId");
  const scopeDigest = assertDigest(value.storageScopeDigest, "admission ledger.storageScopeDigest");
  assertInteger(value.sequence, "admission ledger.sequence");
  assertIso(value.createdAt, "admission ledger.createdAt");
  assertIso(value.updatedAt, "admission ledger.updatedAt");
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    fail("EINCIDENT_DAG_ADMISSION_CLOCK", "admission ledger updatedAt precedes createdAt", "UNKNOWN");
  }
  for (const [name, map] of [["records", value.records], ["authorityIndex", value.authorityIndex], ["classificationIndex", value.classificationIndex]]) {
    assertPlainObject(map, `admission ledger.${name}`);
  }
  const recordEntries = Object.entries(value.records);
  if (recordEntries.length > INCIDENT_RECOVERY_DAG_ADMISSION_MAX_BATCHES) {
    fail("EINCIDENT_DAG_ADMISSION_LIMIT", "admission ledger exceeds the bounded batch count");
  }
  const records = {};
  const authorityIndex = {};
  const classificationIndex = {};
  const admissionIds = new Set();
  const reservations = new Set();
  const executionIds = new Set();
  const attemptIds = new Set();
  for (const [batchId, candidate] of recordEntries.sort(([left], [right]) => left.localeCompare(right))) {
    assertId(batchId, "admission ledger record id");
    const batch = validateIncidentRecoveryDagAdmissionBatchV1(candidate, { runId, storageScopeDigest: scopeDigest });
    if (batch.batchId !== batchId) fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", "admission ledger record id drifted");
    if (authorityIndex[batch.authorityId] || classificationIndex[batch.classificationDigest]) {
      fail("EINCIDENT_DAG_ADMISSION_REPLAY", "admission ledger contains a duplicate authority or recovery classification");
    }
    for (const entry of batch.admissions) {
      if (admissionIds.has(entry.admission.admissionId) || reservations.has(entry.reservationKey) ||
          executionIds.has(entry.admission.executionId) || attemptIds.has(entry.admission.attemptId)) {
        fail("EINCIDENT_DAG_ADMISSION_REPLAY", "admission ledger reuses a child admission, execution, attempt, or nonce identity");
      }
      admissionIds.add(entry.admission.admissionId);
      reservations.add(entry.reservationKey);
      executionIds.add(entry.admission.executionId);
      attemptIds.add(entry.admission.attemptId);
    }
    records[batchId] = batch;
    authorityIndex[batch.authorityId] = batchId;
    classificationIndex[batch.classificationDigest] = batchId;
  }
  if (!same(value.authorityIndex, authorityIndex) || !same(value.classificationIndex, classificationIndex)) {
    fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", "admission ledger indices are stale");
  }
  if (value.sequence < recordEntries.length || (value.sequence === 0) !== (recordEntries.length === 0)) {
    fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", "admission ledger sequence is inconsistent");
  }
  assertDigest(value.stateDigest, "admission ledger.stateDigest");
  if (digestObject(ledgerBody(value)) !== value.stateDigest) {
    fail("EINCIDENT_DAG_ADMISSION_INTEGRITY", "admission ledger state digest is stale");
  }
  if (expected.runId !== undefined && runId !== expected.runId) {
    fail("EINCIDENT_DAG_ADMISSION_BINDING", "admission ledger runId does not match");
  }
  if (expected.storageScopeDigest !== undefined && scopeDigest !== expected.storageScopeDigest) {
    fail("EINCIDENT_DAG_ADMISSION_BINDING", "admission ledger storage scope does not match");
  }
  return freezeDeep({ ...clone(value), records, authorityIndex, classificationIndex });
}

function sealLedger(value) {
  const { stateDigest: ignored, ...body } = value;
  return validateIncidentRecoveryDagAdmissionLedgerV1({ ...body, stateDigest: digestObject(body) });
}

function initialLedger(runId, scopeDigest, now) {
  return sealLedger({
    schemaVersion: INCIDENT_RECOVERY_DAG_ADMISSION_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_DAG_ADMISSION_LEDGER_KIND,
    runId,
    storageScopeDigest: scopeDigest,
    sequence: 0,
    createdAt: now,
    updatedAt: now,
    records: {},
    authorityIndex: {},
    classificationIndex: {}
  });
}

function ledgerPath(root, runId) {
  return safeJoin(runDirectory(root, runId), INCIDENT_RECOVERY_DAG_ADMISSION_LEDGER_FILE);
}

async function ensureRunDirectory(root, runId) {
  await ensurePrivateDir(root);
  await ensurePrivateDir(safeJoin(root, "runs"));
  const runDir = runDirectory(root, runId);
  await ensurePrivateDir(runDir);
  await assertNoSymlinkUnder(root, runDir);
  return runDir;
}

async function canonicalStateRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", "stateRoot must be an absolute path");
  }
  const resolved = path.resolve(value);
  const unsafeRoots = new Set([
    path.parse(resolved).root,
    path.resolve(os.homedir()),
    path.resolve(os.tmpdir()),
    path.resolve("/tmp"),
    path.resolve("/private/tmp")
  ]);
  if (unsafeRoots.has(resolved)) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", "stateRoot must be a dedicated task directory, not a broad filesystem root");
  }
  let rootInfo;
  try {
    rootInfo = await lstat(resolved);
  } catch (error) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", `stateRoot must already exist: ${error.message}`);
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", "stateRoot must be a real directory, not a symlink or file");
  }
  let canonical;
  try {
    canonical = await realpath(resolved);
  } catch (error) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", `stateRoot must already exist and resolve canonically: ${error.message}`);
  }
  const canonicalUnsafeRoots = new Set([path.parse(canonical).root]);
  for (const candidate of [os.homedir(), os.tmpdir(), "/tmp", "/private/tmp"]) {
    const candidateCanonical = await realpath(candidate).catch(() => null);
    if (candidateCanonical) canonicalUnsafeRoots.add(candidateCanonical);
  }
  if (canonicalUnsafeRoots.has(canonical)) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", "stateRoot resolves to a broad filesystem root");
  }
  await ensurePrivateDir(canonical);
  return canonical;
}

async function assertAdmissionLockOwned(root, lockGuard) {
  try {
    const [held, observed, record] = await Promise.all([
      lockGuard.handle.stat(),
      lstat(lockGuard.lockPath),
      readJson(root, lockGuard.lockPath)
    ]);
    if (!held.isFile() || !observed.isFile() || held.nlink !== 1 || observed.nlink !== 1 ||
        held.dev !== observed.dev || held.ino !== observed.ino || record.token !== lockGuard.token) {
      fail("EINCIDENT_DAG_ADMISSION_LEASE", "admission transaction lock ownership changed", "UNKNOWN");
    }
  } catch (error) {
    if (error instanceof IncidentRecoveryDagAdmissionError) throw error;
    fail("EINCIDENT_DAG_ADMISSION_LEASE", `admission transaction lock ownership is unresolved: ${error.message}`, "UNKNOWN");
  }
}

async function withAdmissionLock(root, runId, context, callback) {
  const runDir = await ensureRunDirectory(root, runId);
  const lockPath = safeJoin(runDir, ADMISSION_LOCK_FILE);
  const token = randomBytes(24).toString("hex");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      kind: "IncidentRecoveryDagAdmissionLockV1",
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      reclaimPolicy: "manual-reconciliation-only",
      runId,
      authorityId: context.authorityId,
      classificationDigest: context.classificationDigest,
      expectedLedgerStateDigest: context.expectedLedgerStateDigest
    })}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error?.code === "EEXIST") {
      fail(
        "EINCIDENT_DAG_ADMISSION_LEASE",
        "a non-reclaimable admission transaction lock already exists; reconcile durable state before retry",
        "UNKNOWN"
      );
    }
    fail("EINCIDENT_DAG_ADMISSION_LEASE", `admission transaction lock acquisition is unresolved: ${error.message}`, "UNKNOWN");
  }
  const lockGuard = Object.freeze({ token, lockPath, handle });
  try {
    await assertAdmissionLockOwned(root, lockGuard);
    return await callback({ token, runDir, lockGuard });
  } finally {
    await handle?.close().catch(() => undefined);
    const observed = await readJson(root, lockPath).catch(() => null);
    if (observed?.token === token) await unlink(lockPath).catch(() => undefined);
  }
}

async function readLedgerIfPresent(root, runId, scopeDigest) {
  try {
    return validateIncidentRecoveryDagAdmissionLedgerV1(
      await readJson(root, ledgerPath(root, runId)),
      { runId, storageScopeDigest: scopeDigest }
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof IncidentRecoveryDagAdmissionError) throw error;
    fail("EINCIDENT_DAG_ADMISSION_STATE", `durable admission ledger is unreadable or unsafe: ${error.message}`, "UNKNOWN");
  }
}

function assertNondecreasingTime(ledger, now, label) {
  if (Date.parse(now) < Date.parse(ledger.updatedAt)) {
    fail("EINCIDENT_DAG_ADMISSION_CLOCK", `${label} moved backwards relative to the durable ledger`, "UNKNOWN");
  }
}

function resealLedger(ledger, record, now) {
  return sealLedger({
    ...clone(ledger),
    sequence: ledger.sequence + 1,
    updatedAt: now,
    records: { ...clone(ledger.records), [record.batchId]: record },
    authorityIndex: { ...clone(ledger.authorityIndex), [record.authorityId]: record.batchId },
    classificationIndex: { ...clone(ledger.classificationIndex), [record.classificationDigest]: record.batchId }
  });
}

async function writeLedgerWithReadback(root, runId, expected, lockGuard) {
  await assertAdmissionLockOwned(root, lockGuard);
  // Visibility is not durability.  In particular, a rename may be visible even
  // when the parent-directory fsync failed.  Never consume authority after any
  // atomicWriteJson error merely because a matching readback can be observed.
  await atomicWriteJson(root, ledgerPath(root, runId), expected);
  const persisted = await readLedgerIfPresent(root, runId, expected.storageScopeDigest);
  if (!persisted || persisted.stateDigest !== expected.stateDigest) {
    fail("EINCIDENT_DAG_ADMISSION_PERSIST", "admission ledger durable readback does not match", "UNKNOWN");
  }
  await assertAdmissionLockOwned(root, lockGuard);
  return persisted;
}

function validateChildInputs(value) {
  const children = assertArray(value, "children");
  if (children.length === 0) fail("EINCIDENT_DAG_ADMISSION_INPUT", "children must not be empty");
  const normalized = children.map((child, index) => {
    const label = `children[${index}]`;
    exactKeys(child, ["taskId", "binding", "controller"], label);
    return {
      taskId: assertId(child.taskId, `${label}.taskId`),
      binding: bindingFromInput(child.binding, `${label}.binding`),
      controller: child.controller
    };
  });
  if (new Set(normalized.map((child) => child.taskId)).size !== normalized.length ||
      normalized.some((child, index) => index > 0 && child.taskId < normalized[index - 1].taskId)) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", "children must be unique and sorted by taskId");
  }
  return normalized;
}

function validateFaults(value) {
  if (value === undefined) return { afterPrepared: false, beforeCommit: false };
  exactKeys(value, ["afterPrepared", "beforeCommit"], "faults");
  if (typeof value.afterPrepared !== "boolean" || typeof value.beforeCommit !== "boolean") {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", "fault flags must be boolean");
  }
  return { afterPrepared: value.afterPrepared, beforeCommit: value.beforeCommit };
}

function assertAdmissionAgainstPlan({ admission, binding, taskId, plan, workflowPlan, registry, task }) {
  const expected = {
    runId: plan.workflow.runId,
    planDigest: plan.workflow.planDigest,
    contractDigest: plan.workflow.contractDigest,
    sourceBindingDigest: plan.workflow.sourceBindingDigest,
    policyDigest: plan.workflow.policyDigest,
    revision: plan.workflow.revision,
    taskId
  };
  for (const [key, value] of Object.entries(expected)) {
    if (admission[key] !== value) fail("EINCIDENT_DAG_ADMISSION_BINDING", `child admission ${taskId}.${key} drifted`);
  }
  const workflowTask = workflowPlan.taskContract.graph.tasks.find((candidate) => candidate.id === taskId);
  if (!workflowTask) fail("EINCIDENT_DAG_ADMISSION_BINDING", `child admission task ${taskId} is absent from WorkflowPlanV1`);
  for (const key of [
    "runId", "executionId", "attemptId", "unitId", "ownedResourceId",
    "sourceBindingDigest", "policyDigest", "revision"
  ]) {
    if (admission[key] !== binding[key]) fail("EINCIDENT_DAG_ADMISSION_BINDING", `child admission ${taskId}.${key} is not bound`);
  }
  if (Object.values(registry.handles).some((handle) =>
    handle.executionId === binding.executionId || handle.attemptId === binding.attemptId)) {
    fail("EINCIDENT_DAG_ADMISSION_REPLAY", `child admission ${taskId} reuses an execution or attempt identity`);
  }
  if (task.runtime !== null) {
    const prior = registry.handles[task.runtime.handleId];
    if (!prior || prior.unitId !== binding.unitId || prior.ownedResourceId !== binding.ownedResourceId ||
        prior.sourceBindingDigest !== binding.sourceBindingDigest || prior.policyDigest !== binding.policyDigest ||
        prior.revision !== binding.revision || prior.attemptId === binding.attemptId ||
        prior.executionId === binding.executionId || admission.authorityEpoch <= prior.authorityEpoch ||
        admission.fence === prior.fence) {
      fail("EINCIDENT_DAG_ADMISSION_BINDING", `child admission ${taskId} is not a fresh successor of its runtime task`);
    }
  } else {
    const conflict = Object.values(registry.handles).some((handle) =>
      handle.runId === binding.runId && handle.unitId === binding.unitId &&
      handle.ownedResourceId === binding.ownedResourceId &&
      handle.sourceBindingDigest === binding.sourceBindingDigest &&
      handle.policyDigest === binding.policyDigest && handle.revision === binding.revision);
    if (conflict) fail("EINCIDENT_DAG_ADMISSION_REPLAY", `not-started child admission ${taskId} reuses a logical obligation`);
  }
}

async function buildAdmissionEntries({ children, plan, workflowPlan, registry, clock, ledger }) {
  const planTasks = new Map(plan.tasks.map((task) => [task.taskId, task]));
  const admissionIds = new Set();
  const reservations = new Set();
  const executionIds = new Set();
  const attemptIds = new Set();
  const logicalObligations = new Set();
  for (const admission of Object.values(registry.admissions)) {
    admissionIds.add(admission.admissionId);
    reservations.add(reservationKey(admission));
    executionIds.add(admission.executionId);
    attemptIds.add(admission.attemptId);
  }
  for (const handle of Object.values(registry.handles)) {
    executionIds.add(handle.executionId);
    attemptIds.add(handle.attemptId);
  }
  for (const batch of Object.values(ledger.records)) {
    for (const entry of batch.admissions) {
      admissionIds.add(entry.admission.admissionId);
      reservations.add(entry.reservationKey);
      executionIds.add(entry.admission.executionId);
      attemptIds.add(entry.admission.attemptId);
      // S1c has no durable runtime-handoff marker. Treat every historical S1b
      // logical obligation as still outstanding until the later runtime CAS
      // slice can prove exact consumption and safely relax this fence.
      logicalObligations.add(logicalObligationDigest(entry.admission));
    }
  }
  const entries = [];
  for (const child of children) {
    const task = planTasks.get(child.taskId);
    if (!task || task.disposition !== "recover") {
      fail("EINCIDENT_DAG_ADMISSION_BINDING", `child ${child.taskId} is not a recover task in the current DAG plan`);
    }
    let admission;
    try {
      admission = await readFreshExecutionAdmissionV1({
        controller: child.controller,
        binding: child.binding,
        ...(clock === undefined ? {} : { clock })
      });
    } catch (error) {
      fail("EINCIDENT_DAG_ADMISSION_FRESHNESS", `fresh child admission ${child.taskId} failed: ${error.message}`, error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD");
    }
    assertAdmissionAgainstPlan({ admission, binding: child.binding, taskId: child.taskId, plan, workflowPlan, registry, task });
    const admissionDigest = digestExecutionAdmission(admission);
    const key = reservationKey(admission);
    const logicalObligation = logicalObligationDigest(admission);
    if (admissionIds.has(admission.admissionId) || reservations.has(key) ||
        executionIds.has(admission.executionId) || attemptIds.has(admission.attemptId) ||
        logicalObligations.has(logicalObligation)) {
      fail("EINCIDENT_DAG_ADMISSION_REPLAY", `child admission ${child.taskId} reuses a durable admission, execution, attempt, nonce, or logical obligation identity`);
    }
    admissionIds.add(admission.admissionId);
    reservations.add(key);
    executionIds.add(admission.executionId);
    attemptIds.add(admission.attemptId);
    logicalObligations.add(logicalObligation);
    entries.push({
      taskId: child.taskId,
      binding: clone(child.binding),
      admission: clone(admission),
      admissionDigest,
      reservationKey: key
    });
  }
  return entries;
}

function logicalObligationDigest(admission) {
  return digestObject({
    runId: admission.runId,
    unitId: admission.unitId,
    ownedResourceId: admission.ownedResourceId,
    sourceBindingDigest: admission.sourceBindingDigest,
    policyDigest: admission.policyDigest,
    revision: admission.revision
  });
}

async function assertPreparedAdmissionsRemainFresh({ children, prepared, plan, workflowPlan, registry, clock }) {
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const expected = prepared.admissions[index];
    let admission;
    try {
      admission = await readFreshExecutionAdmissionV1({
        controller: child.controller,
        binding: child.binding,
        ...(clock === undefined ? {} : { clock })
      });
    } catch (error) {
      fail(
        "EINCIDENT_DAG_ADMISSION_UNKNOWN",
        `prepared child admission ${child.taskId} could not be revalidated: ${error.message}`,
        "UNKNOWN",
        { batchId: prepared.batchId, taskId: child.taskId }
      );
    }
    const task = plan.tasks.find((candidate) => candidate.taskId === child.taskId);
    try {
      assertAdmissionAgainstPlan({ admission, binding: child.binding, taskId: child.taskId, plan, workflowPlan, registry, task });
      if (digestExecutionAdmission(admission) === expected.admissionDigest && same(admission, expected.admission)) continue;
      fail(
        "EINCIDENT_DAG_ADMISSION_UNKNOWN",
        `prepared child admission ${child.taskId} drifted before authority consumption`,
        "UNKNOWN",
        { batchId: prepared.batchId, taskId: child.taskId }
      );
    } catch (error) {
      if (error instanceof IncidentRecoveryDagAdmissionError && error.status === "UNKNOWN") throw error;
      fail(
        "EINCIDENT_DAG_ADMISSION_UNKNOWN",
        `prepared child admission ${child.taskId} failed final binding validation: ${error.message}`,
        "UNKNOWN",
        { batchId: prepared.batchId, taskId: child.taskId }
      );
    }
  }
}

function optionsShape(options) {
  assertPlainObject(options, "commitIncidentRecoveryDagAdmissionBatchV1 options");
  const allowed = new Set([
    "stateRoot", "authorityIssuer", "authority", "plan", "incident", "workflowPlan",
    "checkpoint", "executionRegistry", "budgetLedger", "children", "clock", "faults"
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail("EINCIDENT_DAG_ADMISSION_INPUT", `options contains an unknown key: ${key}`);
  }
  for (const key of [
    "stateRoot", "authorityIssuer", "authority", "plan", "incident", "workflowPlan",
    "checkpoint", "executionRegistry", "budgetLedger", "children"
  ]) {
    if (!Object.hasOwn(options, key)) fail("EINCIDENT_DAG_ADMISSION_INPUT", `options requires ${key}`);
  }
}

function orchestrationOptionsShape(options) {
  assertPlainObject(options, "orchestrateIncidentRecoveryDagAdmissionV1 options");
  const allowed = new Set([
    "stateRoot", "authorityIssuer", "recoveryId", "preparedAt", "incident", "workflowPlan",
    "checkpoint", "executionRegistry", "budgetLedger", "children", "clock", "faults"
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail("EINCIDENT_DAG_ADMISSION_INPUT", `orchestration options contains an unknown key: ${key}`);
  }
  for (const key of [
    "stateRoot", "authorityIssuer", "recoveryId", "preparedAt", "incident", "workflowPlan",
    "checkpoint", "executionRegistry", "budgetLedger", "children"
  ]) {
    if (!Object.hasOwn(options, key)) fail("EINCIDENT_DAG_ADMISSION_INPUT", `orchestration options requires ${key}`);
  }
}

function orchestrationInputSnapshot(options) {
  try {
    return frozenClone({
      incident: options.incident,
      workflowPlan: options.workflowPlan,
      checkpoint: options.checkpoint,
      executionRegistry: options.executionRegistry,
      budgetLedger: options.budgetLedger
    });
  } catch (error) {
    fail("EINCIDENT_DAG_ADMISSION_INPUT", `orchestration source snapshot failed: ${error.message}`);
  }
}

function orchestrationSource(snapshot, plan) {
  return {
    plan,
    incident: snapshot.incident,
    workflowPlan: snapshot.workflowPlan,
    checkpoint: snapshot.checkpoint,
    executionRegistry: snapshot.executionRegistry,
    budgetLedger: snapshot.budgetLedger
  };
}

function orchestrationFailure(error, { issuer, plan, authority }) {
  let authorityState = null;
  let revocationReceipt = null;
  try {
    authorityState = issuer.inspect(authority);
  } catch (inspectError) {
    return new IncidentRecoveryDagAdmissionError(
      "EINCIDENT_DAG_ADMISSION_ORCHESTRATION_UNKNOWN",
      `DAG admission orchestration could not reconcile authority state after failure: ${inspectError.message}`,
      "UNKNOWN",
      {
        causeCode: error?.code ?? "unknown",
        causeStatus: error?.status ?? "unknown",
        plan: clone(plan),
        authority: clone(authority)
      }
    );
  }
  if (error?.status === "HOLD" && authorityState.status === "active") {
    try {
      revocationReceipt = issuer.revoke({
        authority,
        reason: `S1c deterministic pre-consumption failure: ${error?.code ?? "unknown"}`
      });
    } catch (revokeError) {
      return new IncidentRecoveryDagAdmissionError(
        "EINCIDENT_DAG_ADMISSION_ORCHESTRATION_UNKNOWN",
        `DAG admission orchestration could not revoke an active authority after deterministic failure: ${revokeError.message}`,
        "UNKNOWN",
        {
          causeCode: error?.code ?? "unknown",
          causeStatus: error?.status ?? "unknown",
          plan: clone(plan),
          authority: clone(authority),
          authorityState: clone(authorityState)
        }
      );
    }
  }
  return new IncidentRecoveryDagAdmissionError(
    error?.code ?? "EINCIDENT_DAG_ADMISSION_ORCHESTRATION_UNKNOWN",
    error?.message ?? "DAG admission orchestration failed without a stable error",
    error?.status === "HOLD" ? "HOLD" : "UNKNOWN",
    {
      causeDetails: error?.details ?? null,
      plan: clone(plan),
      authority: clone(authority),
      authorityState: clone(authorityState),
      authorityDisposition: revocationReceipt === null ? authorityState.status : "revoked",
      revocationReceipt: revocationReceipt === null ? null : clone(revocationReceipt)
    }
  );
}

function assertCommittedReplayContext(issuer, authority, batch, children) {
  let issuerState;
  try {
    issuerState = issuer.inspect(authority);
  } catch (error) {
    fail("EINCIDENT_DAG_ADMISSION_AUTHORITY", `committed replay issuer ownership failed: ${error.message}`, error?.status ?? "HOLD");
  }
  if (issuerState.status !== "consumed") {
    fail("EINCIDENT_DAG_ADMISSION_AUTHORITY", `committed replay authority is ${issuerState.status}`);
  }
  if (batch.admissions.length !== children.length || batch.admissions.some((entry, index) =>
    entry.taskId !== children[index].taskId || !same(entry.binding, children[index].binding))) {
    fail("EINCIDENT_DAG_ADMISSION_REPLAY", "committed replay children differ from the durable batch");
  }
  return batch;
}

function resolveExistingBatch(ledger, stateDigest, authority) {
  if (!ledger) return null;
  const unresolved = Object.values(ledger.records).find((record) => record.status === "prepared");
  if (unresolved) {
    fail("EINCIDENT_DAG_ADMISSION_UNKNOWN", "a prepared durable admission batch blocks all new admission transactions for this run", "UNKNOWN", {
      batchId: unresolved.batchId,
      status: unresolved.status
    });
  }
  const existingBatchId = ledger.classificationIndex[stateDigest] ?? ledger.authorityIndex[authority.authorityId] ?? null;
  if (existingBatchId === null) return null;
  const existing = ledger.records[existingBatchId];
  if (existing.authorityDigest !== authority.authorityDigest || existing.classificationDigest !== stateDigest) {
    fail("EINCIDENT_DAG_ADMISSION_REPLAY", "recovery classification or authority is already bound to another durable batch");
  }
  return frozenClone(existing);
}

export async function commitIncidentRecoveryDagAdmissionBatchV1(options = {}) {
  optionsShape(options);
  const issuer = assertIncidentRecoveryDagAuthorityIssuerV1(options.authorityIssuer);
  const authority = validateIncidentRecoveryDagRecoveryAuthorityV1(options.authority);
  const plan = validateIncidentRecoveryDagPlanV1(options.plan);
  const workflowPlan = validateWorkflowPlanV1(options.workflowPlan);
  const registry = validateExecutionRegistrySnapshotV1(options.executionRegistry, plan.workflow.runId);
  const children = validateChildInputs(options.children);
  const clock = safeClock(options.clock);
  const faults = validateFaults(options.faults);
  const runId = plan.workflow.runId;
  const root = await canonicalStateRoot(options.stateRoot);
  const scopeDigest = storageScopeDigest(root, runId);
  if (plan.status !== "prepared" || authority.recoveryId !== plan.recoveryId ||
      authority.recoveryPlanDigest !== plan.manifestDigest ||
      plan.workflow.planDigest !== workflowPlan.planDigest ||
      plan.workflow.contractDigest !== workflowPlan.contractDigest ||
      plan.registry.sequence !== registry.sequence || plan.registry.stateDigest !== registry.stateDigest) {
    fail("EINCIDENT_DAG_ADMISSION_BINDING", "authority, DAG plan, workflow plan, or registry snapshot is stale");
  }
  const taskIds = children.map((child) => child.taskId);
  if (!same(taskIds, authority.taskIds)) {
    fail("EINCIDENT_DAG_ADMISSION_BINDING", "children do not exactly cover the authority task selection");
  }
  const stateDigest = classificationDigest(plan);
  const observedLedger = await readLedgerIfPresent(root, runId, scopeDigest);
  const observedBatch = resolveExistingBatch(observedLedger, stateDigest, authority);
  if (observedBatch) return assertCommittedReplayContext(issuer, authority, observedBatch, children);
  const expectedLedgerStateDigest = observedLedger?.stateDigest ?? null;
  return withAdmissionLock(root, runId, {
    authorityId: authority.authorityId,
    classificationDigest: stateDigest,
    expectedLedgerStateDigest
  }, async ({ lockGuard }) => {
    const lockedLedger = await readLedgerIfPresent(root, runId, scopeDigest);
    const existingBatch = resolveExistingBatch(lockedLedger, stateDigest, authority);
    if (existingBatch) return assertCommittedReplayContext(issuer, authority, existingBatch, children);
    if ((lockedLedger?.stateDigest ?? null) !== expectedLedgerStateDigest) {
      fail("EINCIDENT_DAG_ADMISSION_STATE", "admission ledger changed between preflight and exclusive lock acquisition", "UNKNOWN");
    }
    const firstNow = currentDate(clock).toISOString();
    let ledger = lockedLedger ?? initialLedger(runId, scopeDigest, firstNow);
    assertNondecreasingTime(ledger, firstNow, "admission preparation clock");
    let issuerState;
    try {
      issuerState = issuer.inspect(authority);
    } catch (error) {
      fail("EINCIDENT_DAG_ADMISSION_AUTHORITY", `live authority inspection failed: ${error.message}`, error?.status ?? "HOLD");
    }
    if (issuerState.status !== "active") {
      fail("EINCIDENT_DAG_ADMISSION_AUTHORITY", `live authority is ${issuerState.status}`);
    }
    if (Object.keys(ledger.records).length >= INCIDENT_RECOVERY_DAG_ADMISSION_MAX_BATCHES) {
      fail("EINCIDENT_DAG_ADMISSION_LIMIT", "admission ledger has reached its bounded batch count");
    }
    const admissions = await buildAdmissionEntries({ children, plan, workflowPlan, registry, clock, ledger });
    try {
      verifyIncidentRecoveryDagPlanV1({
        plan,
        incident: options.incident,
        workflowPlan: options.workflowPlan,
        checkpoint: options.checkpoint,
        executionRegistry: options.executionRegistry,
        budgetLedger: options.budgetLedger
      });
    } catch (error) {
      fail(
        "EINCIDENT_DAG_ADMISSION_FRESHNESS",
        `recovery source drifted before durable PREPARED admission: ${error.message}`,
        error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      );
    }
    const prepared = sealBatch({
      schemaVersion: INCIDENT_RECOVERY_DAG_ADMISSION_SCHEMA_VERSION,
      kind: INCIDENT_RECOVERY_DAG_ADMISSION_BATCH_KIND,
      batchId: authority.authorityId,
      runId,
      storageScopeDigest: scopeDigest,
      recoveryId: plan.recoveryId,
      classificationDigest: stateDigest,
      recoveryPlanDigest: plan.manifestDigest,
      authorityId: authority.authorityId,
      authorityDigest: authority.authorityDigest,
      authorityEpoch: authority.authorityEpoch,
      fence: authority.fence,
      taskIds,
      admissions,
      admissionsDigest: digestObject(admissions),
      status: "prepared",
      preparedAt: firstNow,
      consumptionReceipt: null,
      committedAt: null,
      effectAuthority: clone(EFFECT_AUTHORITY)
    });
    const preparedLedger = resealLedger(ledger, prepared, firstNow);
    try {
      ledger = await writeLedgerWithReadback(root, runId, preparedLedger, lockGuard);
    } catch (error) {
      if (error instanceof IncidentRecoveryDagAdmissionError && error.status === "UNKNOWN") throw error;
      fail("EINCIDENT_DAG_ADMISSION_PERSIST", `durable PREPARED write is unresolved before authority consumption: ${error.message}`, "UNKNOWN");
    }
    if (faults.afterPrepared) {
      fail("EINCIDENT_DAG_ADMISSION_UNKNOWN", "fault injected after durable PREPARED admission", "UNKNOWN", { batchId: prepared.batchId });
    }
    await assertPreparedAdmissionsRemainFresh({ children, prepared, plan, workflowPlan, registry, clock });
    await assertAdmissionLockOwned(root, lockGuard);
    let receipt;
    try {
      receipt = issuer.consume({
        authority,
        plan: options.plan,
        incident: options.incident,
        workflowPlan: options.workflowPlan,
        checkpoint: options.checkpoint,
        executionRegistry: options.executionRegistry,
        budgetLedger: options.budgetLedger
      });
      receipt = validateIncidentRecoveryDagAuthorityConsumptionReceiptV1(receipt);
    } catch (error) {
      fail("EINCIDENT_DAG_ADMISSION_UNKNOWN", `authority consumption did not reach a durable committed batch: ${error.message}`, "UNKNOWN", {
        batchId: prepared.batchId,
        cause: error?.code ?? "unknown"
      });
    }
    if (faults.beforeCommit) {
      fail("EINCIDENT_DAG_ADMISSION_UNKNOWN", "fault injected after authority consumption and before durable COMMITTED admission", "UNKNOWN", {
        batchId: prepared.batchId,
        receiptDigest: receipt.receiptDigest
      });
    }
    try {
      const committedAt = currentDate(clock).toISOString();
      assertNondecreasingTime(ledger, committedAt, "admission commit clock");
      if (Date.parse(committedAt) < Date.parse(prepared.preparedAt)) {
        fail("EINCIDENT_DAG_ADMISSION_CLOCK", "admission commit clock moved backwards", "UNKNOWN");
      }
      const committed = sealBatch({
        ...clone(prepared),
        status: "committed",
        consumptionReceipt: receipt,
        committedAt
      });
      const committedLedger = resealLedger(ledger, committed, committedAt);
      await writeLedgerWithReadback(root, runId, committedLedger, lockGuard);
      return frozenClone(committed);
    } catch (error) {
      if (error instanceof IncidentRecoveryDagAdmissionError && error.status === "UNKNOWN") throw error;
      fail("EINCIDENT_DAG_ADMISSION_UNKNOWN", `authority was consumed but durable COMMITTED write is unresolved: ${error.message}`, "UNKNOWN", {
        batchId: prepared.batchId,
        receiptDigest: receipt.receiptDigest
      });
    }
  });
}

// Trusted S1c composition only. This function issues and consumes the
// process-local S1a authority through the S1b durable admission boundary, but
// it never opens the execution registry or creates a handle, intent, runner,
// dispatch, provider call, command, or effect capability.
export async function orchestrateIncidentRecoveryDagAdmissionV1(options = {}) {
  orchestrationOptionsShape(options);
  const issuer = assertIncidentRecoveryDagAuthorityIssuerV1(options.authorityIssuer);
  const children = validateChildInputs(options.children);
  const plan = buildIncidentRecoveryDagPlanV1({
    recoveryId: options.recoveryId,
    preparedAt: options.preparedAt,
    incident: options.incident,
    workflowPlan: options.workflowPlan,
    checkpoint: options.checkpoint,
    executionRegistry: options.executionRegistry,
    budgetLedger: options.budgetLedger
  });
  // Build first so S0's descriptor-safe data-tree validation rejects hostile
  // accessors before structuredClone can observe them. There is no await
  // between validation and this immutable snapshot.
  const snapshot = orchestrationInputSnapshot(options);
  verifyIncidentRecoveryDagPlanV1({ plan, ...snapshot });
  const source = orchestrationSource(snapshot, plan);
  const authority = issuer.issue({
    ...source,
    taskIds: children.map((child) => child.taskId)
  });
  try {
    const batch = await commitIncidentRecoveryDagAdmissionBatchV1({
      stateRoot: options.stateRoot,
      authorityIssuer: issuer,
      authority,
      ...source,
      children,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.faults === undefined ? {} : { faults: options.faults })
    });
    const authorityState = issuer.inspect(authority);
    if (batch.status !== "committed" || authorityState.status !== "consumed" ||
        batch.authorityDigest !== authority.authorityDigest ||
        batch.recoveryPlanDigest !== plan.manifestDigest ||
        !same(batch.taskIds, authority.taskIds) || !same(batch.effectAuthority, EFFECT_AUTHORITY)) {
      fail(
        "EINCIDENT_DAG_ADMISSION_ORCHESTRATION_UNKNOWN",
        "DAG admission orchestration did not reach one exact committed and consumed result",
        "UNKNOWN"
      );
    }
    return frozenClone({
      plan,
      authority,
      batch,
      authorityState,
      effectAuthority: EFFECT_AUTHORITY
    });
  } catch (error) {
    throw orchestrationFailure(error, { issuer, plan, authority });
  }
}

export async function readIncidentRecoveryDagAdmissionLedgerV1(options = {}) {
  exactKeys(options, ["stateRoot", "runId"], "readIncidentRecoveryDagAdmissionLedgerV1 options");
  const root = await canonicalStateRoot(options.stateRoot);
  const runId = assertId(options.runId, "runId");
  const scopeDigest = storageScopeDigest(root, runId);
  const ledger = await readLedgerIfPresent(root, runId, scopeDigest);
  if (!ledger) fail("EINCIDENT_DAG_ADMISSION_MISSING", "durable DAG admission ledger does not exist");
  return frozenClone(ledger);
}

export async function readIncidentRecoveryDagAdmissionBatchV1(options = {}) {
  exactKeys(options, ["stateRoot", "runId", "authorityId"], "readIncidentRecoveryDagAdmissionBatchV1 options");
  const ledger = await readIncidentRecoveryDagAdmissionLedgerV1({ stateRoot: options.stateRoot, runId: options.runId });
  const authorityId = assertId(options.authorityId, "authorityId");
  const batchId = ledger.authorityIndex[authorityId];
  if (!batchId || !ledger.records[batchId]) {
    fail("EINCIDENT_DAG_ADMISSION_MISSING", "durable DAG admission batch does not exist");
  }
  return frozenClone(ledger.records[batchId]);
}

export function assertCommittedIncidentRecoveryDagAdmissionBatchV1(value) {
  const batch = validateIncidentRecoveryDagAdmissionBatchV1(value);
  if (batch.status !== "committed") {
    fail(
      "EINCIDENT_DAG_ADMISSION_UNKNOWN",
      "prepared admission data is diagnostic only and cannot be consumed as a committed batch",
      "UNKNOWN",
      { batchId: batch.batchId, status: batch.status }
    );
  }
  return batch;
}

// This is a committed-evidence reader, not a capability loader.  The batch's
// effectAuthority remains all false; a later runtime boundary must re-read the
// live branded controller and perform its own durable admission CAS.
export async function readCommittedIncidentRecoveryDagAdmissionBatchV1(options = {}) {
  return assertCommittedIncidentRecoveryDagAdmissionBatchV1(
    await readIncidentRecoveryDagAdmissionBatchV1(options)
  );
}
