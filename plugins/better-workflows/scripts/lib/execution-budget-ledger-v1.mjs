import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertNoSymlinkUnder,
  atomicWriteJson,
  canonicalJson,
  digestObject,
  ensurePrivateDir,
  readJson,
  safeJoin,
  withRunLock
} from "./core.mjs";
import {
  assertSameExecutionAdmission,
  buildExecutionAdmission,
  digestExecutionAdmission,
  validateExecutionAdmission
} from "./execution-admission-v1.mjs";
import {
  openExecutionRegistry,
  readExecutionSealedEffectEvidenceV2,
  validateExecutionUsageObservationV1
} from "./execution-runtime-v1.mjs";
import { assertPrivateStateBackendAvailableV1 } from "./private-state-backend-v1.mjs";

/**
 * Durable accounting for a trusted execution admission.
 *
 * This module intentionally does not issue an admission, grant provider
 * authority, or infer provider usage.  The runtime registry and its branded
 * controller remain the authority for those facts.  The ledger only records
 * bounded reservations and observations that the runtime has already made.
 */
export const EXECUTION_BUDGET_LEDGER_SCHEMA_VERSION = 1;
export const EXECUTION_BUDGET_LEDGER_KIND = "ExecutionBudgetLedgerV1";
export const EXECUTION_BUDGET_RESERVATION_KIND = "ExecutionBudgetReservationV1";
export const EXECUTION_BUDGET_EVENT_KIND = "ExecutionBudgetLedgerEventV1";
export const EXECUTION_BUDGET_LEDGER_DIRECTORY = "execution-budget-ledger-v1";
export const EXECUTION_BUDGET_SETTLEMENT_EVIDENCE_V2_KIND = "ExecutionBudgetSettlementEvidenceV2";

const RUN_ID = /^sbw-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DIMENSIONS = Object.freeze(["attempts", "seconds", "tokens", "cost"]);
const USAGE_DIMENSIONS = Object.freeze(["attempts", "seconds", "tokens", "cost"]);
const RESERVATION_STATUSES = new Set(["reserved", "held", "released", "settled"]);
const OUTCOMES = new Set(["success", "failure", "not-sent", "unknown"]);
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_EVENTS = 100_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRIES = 1_200;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class ExecutionBudgetLedgerError extends Error {
  constructor(code, message, { status = "HOLD", details = undefined, cause = undefined } = {}) {
    super(message);
    this.name = "ExecutionBudgetLedgerError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

function fail(code, message, options = {}) {
  throw new ExecutionBudgetLedgerError(code, message, options);
}

// The runtime's own fail-closed vocabulary for a stale binding, source,
// policy or allocation.  Only these codes survive the admission read
// unchanged; anything else is flattened so a caller-supplied controller
// cannot choose the code the ledger reports.
const BOUNDED_ADMISSION_CODE = /^E(?:NATIVE_COMMAND_BINDING|NATIVE_V3|SOURCE|POLICY|OWNER|ALLOCATION|EXECUTION|EFFECT)(?:_[A-Z0-9]+)+$/u;
const HOLDABLE_STATUS = new Set(["HOLD", "UNKNOWN"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail("EBUDGET_INVALID", `${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) {
      fail("EBUDGET_INVALID", `${label} contains an unsafe key`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      fail("EBUDGET_INVALID", `${label}.${key} must be a data property`);
    }
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Reflect.ownKeys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("EBUDGET_INVALID", `${label} has an unexpected shape`);
  }
}

function assertRequest(value, expected, label) {
  if (value === undefined || value === null) fail("EBUDGET_INVALID", `${label} is required`);
  assertExactKeys(value, expected, label);
  return value;
}

function assertAllowedRequest(value, allowed, required, label) {
  if (value === undefined || value === null) fail("EBUDGET_INVALID", `${label} is required`);
  assertPlainObject(value, label);
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) {
    fail("EBUDGET_INVALID", `${label} has an unexpected or missing field`);
  }
  return value;
}

function clone(value) {
  try {
    return structuredClone(value);
  } catch (error) {
    fail("EBUDGET_INVALID", "value cannot be cloned safely", { cause: error });
  }
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function assertText(value, label, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("EBUDGET_INVALID", `${label} is invalid`);
  }
  if (pattern && !pattern.test(value)) fail("EBUDGET_INVALID", `${label} is invalid`);
  return value;
}

function assertId(value, label) {
  return assertText(value, label, ID);
}

function assertDigest(value, label) {
  return assertText(value, label, DIGEST);
}

function assertRevision(value, label) {
  return assertText(value, label, REVISION);
}

function assertRunId(value, label) {
  return assertText(value, label, RUN_ID);
}

function assertIso(value, label) {
  assertText(value, label);
  if (!Number.isFinite(Date.parse(value))) fail("EBUDGET_INVALID", `${label} is invalid`);
  return value;
}

function assertNonNegativeInteger(value, label, { allowNull = true } = {}) {
  if (value === null && allowNull) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail("EBUDGET_INVALID", `${label} must be a non-negative integer or null`);
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail("EBUDGET_INVALID", `${label} must be a positive integer`);
  return value;
}

function safeNow(clock) {
  const value = clock?.now?.() ?? new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("EBUDGET_INVALID", "clock returned an invalid time");
  return date.toISOString();
}

function validateClock(clock) {
  if (clock === undefined) return Object.freeze({ now: () => new Date() });
  assertPlainObject(clock, "clock");
  if (typeof clock.now !== "function") fail("EBUDGET_INVALID", "clock.now must be callable");
  return Object.freeze({ now: clock.now.bind(clock) });
}

function validateAbortSignal(signal) {
  if (signal === undefined || signal === null) return null;
  if (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function") {
    fail("EBUDGET_INVALID", "abortSignal must be an AbortSignal");
  }
  return signal;
}

function validateLimits(value, label = "limits") {
  assertExactKeys(value, DIMENSIONS, label);
  const limits = {
    attempts: value.attempts,
    seconds: value.seconds,
    tokens: value.tokens,
    cost: value.cost
  };
  for (const dimension of DIMENSIONS) {
    if (dimension === "cost") {
      if (limits.cost !== null) fail("EBUDGET_UNSUPPORTED_DIMENSION", `${label}.cost is unavailable; it must remain null`);
    } else {
      if (limits[dimension] !== null) assertPositiveInteger(limits[dimension], `${label}.${dimension}`);
    }
  }
  return limits;
}

function validateAmounts(value, label = "amounts", { requireKnownFinite = true } = {}) {
  assertExactKeys(value, DIMENSIONS, label);
  const amounts = {
    attempts: value.attempts,
    seconds: value.seconds,
    tokens: value.tokens,
    cost: value.cost
  };
  assertPositiveInteger(amounts.attempts, `${label}.attempts`);
  for (const dimension of ["seconds", "tokens"]) {
    assertNonNegativeInteger(amounts[dimension], `${label}.${dimension}`);
  }
  if (amounts.cost !== null) fail("EBUDGET_UNSUPPORTED_DIMENSION", `${label}.cost is unavailable; it must remain null`);
  if (requireKnownFinite) {
    // The caller must reserve a known amount when the trusted admission has a
    // finite dimension.  A null amount is an honest HOLD, never an estimate.
    return amounts;
  }
  return amounts;
}

function validateLineage(value, label = "lineage") {
  assertExactKeys(value, ["planDigest", "contractDigest", "sourceBindingDigest", "policyDigest", "revision"], label);
  return {
    planDigest: assertDigest(value.planDigest, `${label}.planDigest`),
    contractDigest: assertDigest(value.contractDigest, `${label}.contractDigest`),
    sourceBindingDigest: assertDigest(value.sourceBindingDigest, `${label}.sourceBindingDigest`),
    policyDigest: assertDigest(value.policyDigest, `${label}.policyDigest`),
    revision: assertRevision(value.revision, `${label}.revision`)
  };
}

function validateRuntimeBinding(value, label = "runtime binding") {
  assertPlainObject(value, label);
  const keys = ["runId", "handleId", "executionId", "attemptId", "unitId", "ownedResourceId", "authorityEpoch", "fence"];
  assertExactKeys(value, keys, label);
  return {
    runId: assertRunId(value.runId, `${label}.runId`),
    handleId: assertId(value.handleId, `${label}.handleId`),
    executionId: assertId(value.executionId, `${label}.executionId`),
    attemptId: assertId(value.attemptId, `${label}.attemptId`),
    unitId: assertId(value.unitId, `${label}.unitId`),
    ownedResourceId: assertId(value.ownedResourceId, `${label}.ownedResourceId`),
    authorityEpoch: assertPositiveInteger(value.authorityEpoch, `${label}.authorityEpoch`),
    fence: assertDigest(value.fence, `${label}.fence`)
  };
}

function validateUsage(value, label = "usage") {
  assertExactKeys(value, USAGE_DIMENSIONS, label);
  const usage = {
    attempts: assertNonNegativeInteger(value.attempts, `${label}.attempts`, { allowNull: false }),
    seconds: assertNonNegativeInteger(value.seconds, `${label}.seconds`),
    tokens: assertNonNegativeInteger(value.tokens, `${label}.tokens`),
    cost: value.cost
  };
  if (usage.cost !== null) fail("EBUDGET_UNSUPPORTED_DIMENSION", `${label}.cost is unavailable; it must remain null`);
  return usage;
}

function validateReservation(value, label = EXECUTION_BUDGET_RESERVATION_KIND) {
  assertExactKeys(value, [
    "schemaVersion", "kind", "reservationId", "idempotencyKey", "runtime", "executionId", "attemptId", "unitId",
    "admissionDigest", "lineage", "requested", "reserved", "status", "outcome", "usage", "createdAt", "updatedAt"
  ], label);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_BUDGET_RESERVATION_KIND) {
    fail("EBUDGET_INVALID", `${label} version/kind is invalid`);
  }
  const runtime = validateRuntimeBinding(value.runtime, `${label}.runtime`);
  if (value.executionId !== runtime.executionId || value.attemptId !== runtime.attemptId || value.unitId !== runtime.unitId) {
    fail("EBUDGET_INVALID", `${label} execution identity is not bound to runtime`);
  }
  assertId(value.reservationId, `${label}.reservationId`);
  assertText(value.idempotencyKey, `${label}.idempotencyKey`);
  assertDigest(value.admissionDigest, `${label}.admissionDigest`);
  const lineage = validateLineage(value.lineage, `${label}.lineage`);
  const requested = validateAmounts(value.requested, `${label}.requested`, { requireKnownFinite: false });
  const reserved = validateAmounts(value.reserved, `${label}.reserved`, { requireKnownFinite: false });
  if (canonicalJson(requested) !== canonicalJson(reserved)) fail("EBUDGET_INVALID", `${label}.reserved must equal requested`);
  if (!RESERVATION_STATUSES.has(value.status)) fail("EBUDGET_INVALID", `${label}.status is invalid`);
  if (!OUTCOMES.has(value.outcome)) fail("EBUDGET_INVALID", `${label}.outcome is invalid`);
  if (value.usage !== null) validateUsage(value.usage, `${label}.usage`);
  assertIso(value.createdAt, `${label}.createdAt`);
  assertIso(value.updatedAt, `${label}.updatedAt`);
  return {
    schemaVersion: 1,
    kind: EXECUTION_BUDGET_RESERVATION_KIND,
    reservationId: value.reservationId,
    idempotencyKey: value.idempotencyKey,
    runtime,
    executionId: value.executionId,
    attemptId: value.attemptId,
    unitId: value.unitId,
    admissionDigest: value.admissionDigest,
    lineage,
    requested,
    reserved,
    status: value.status,
    outcome: value.outcome,
    usage: value.usage === null ? null : validateUsage(value.usage, `${label}.usage`),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function initialState(runId) {
  const state = {
    schemaVersion: EXECUTION_BUDGET_LEDGER_SCHEMA_VERSION,
    kind: EXECUTION_BUDGET_LEDGER_KIND,
    runId,
    lineage: null,
    limits: null,
    sequence: 0,
    stateDigest: null,
    reservations: {}
  };
  state.stateDigest = stateDigest(state);
  return state;
}

function stateDigest(value) {
  const { stateDigest: ignored, ...body } = value;
  return digestObject(body);
}

function validateState(value, expectedRunId, label = EXECUTION_BUDGET_LEDGER_KIND) {
  assertExactKeys(value, ["schemaVersion", "kind", "runId", "lineage", "limits", "sequence", "stateDigest", "reservations"], label);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_BUDGET_LEDGER_KIND) fail("EBUDGET_CORRUPT", `${label} version/kind is invalid`);
  assertRunId(value.runId, `${label}.runId`);
  if (value.runId !== expectedRunId) fail("EBUDGET_CORRUPT", `${label}.runId is not bound to the opened run`);
  if (value.lineage === null) {
    if (value.limits !== null || Object.keys(value.reservations).length > 0) fail("EBUDGET_CORRUPT", `${label} has unbound reservations`);
  } else {
    validateLineage(value.lineage, `${label}.lineage`);
    validateLimits(value.limits, `${label}.limits`);
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) fail("EBUDGET_CORRUPT", `${label}.sequence is invalid`);
  assertDigest(value.stateDigest, `${label}.stateDigest`);
  assertPlainObject(value.reservations, `${label}.reservations`);
  for (const [id, reservation] of Object.entries(value.reservations)) {
    if (id !== reservation.reservationId) fail("EBUDGET_CORRUPT", `${label}.reservations key is not bound`);
    const normalized = validateReservation(reservation, `${label}.reservations.${id}`);
    if (normalized.runtime.runId !== expectedRunId) fail("EBUDGET_CORRUPT", `${label}.reservation run is not bound`);
    if (value.lineage && canonicalJson(normalized.lineage) !== canonicalJson(value.lineage)) {
      fail("EBUDGET_CORRUPT", `${label}.reservation lineage drifted`);
    }
  }
  if (stateDigest(value) !== value.stateDigest) fail("EBUDGET_CORRUPT", `${label}.stateDigest is not bound`);
  return value;
}

function validateEvent(value, expectedRunId, label = EXECUTION_BUDGET_EVENT_KIND) {
  assertExactKeys(value, [
    "schemaVersion", "kind", "eventId", "runId", "sequence", "previousSequence", "previousStateDigest",
    "op", "payload", "stateDigest", "at"
  ], label);
  if (value.schemaVersion !== 1 || value.kind !== EXECUTION_BUDGET_EVENT_KIND) fail("EBUDGET_CORRUPT", `${label} version/kind is invalid`);
  assertId(value.eventId, `${label}.eventId`);
  assertRunId(value.runId, `${label}.runId`);
  if (value.runId !== expectedRunId) fail("EBUDGET_CORRUPT", `${label}.runId is not bound`);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Number.isSafeInteger(value.previousSequence) || value.previousSequence < 0 || value.sequence !== value.previousSequence + 1) {
    fail("EBUDGET_CORRUPT", `${label}.sequence is not contiguous`);
  }
  assertDigest(value.previousStateDigest, `${label}.previousStateDigest`);
  assertText(value.op, `${label}.op`);
  assertPlainObject(value.payload, `${label}.payload`);
  assertDigest(value.stateDigest, `${label}.stateDigest`);
  assertIso(value.at, `${label}.at`);
  return value;
}

function same(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

async function assertNoSymlinkUnderReadOnly(root, target) {
  assertPrivateStateBackendAvailableV1();
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = safeJoin(resolvedRoot, path.relative(resolvedRoot, path.resolve(target)));
  const components = path.relative(resolvedRoot, resolvedTarget).split(path.sep).filter(Boolean);
  let current = resolvedRoot;
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = path.join(current, components[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink path component: ${current}`);
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`Expected directory path component: ${current}`);
    }
  }
  return true;
}

async function readJsonReadOnly(root, target) {
  const exists = await assertNoSymlinkUnderReadOnly(root, target);
  if (!exists) {
    const error = new Error(`JSON path does not exist: ${target}`);
    error.code = "ENOENT";
    throw error;
  }
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error(`Unsafe JSON path: ${target}`);
  }
  return JSON.parse(await readFile(target, "utf8"));
}

function activeReservation(reservation) {
  return reservation.status === "reserved" || reservation.status === "held";
}

function totals(state) {
  const consumed = { attempts: 0, seconds: 0, tokens: 0, cost: null };
  const reserved = { attempts: 0, seconds: 0, tokens: 0, cost: null };
  const unknown = { attempts: false, seconds: false, tokens: false, cost: true };
  for (const reservation of Object.values(state.reservations)) {
    if (activeReservation(reservation)) {
      for (const dimension of ["attempts", "seconds", "tokens"]) {
        const observed = reservation.usage?.[dimension];
        // A held overrun remains active and is counted at the larger of its
        // requested reservation and the trusted observed amount.  This keeps
        // a late usage observation from creating capacity by arithmetic.
        const amount = reservation.status === "held" && observed !== null && observed !== undefined
          ? Math.max(reservation.reserved[dimension] ?? 0, observed)
          : reservation.reserved[dimension];
        if (amount === null) unknown[dimension] = true;
        else reserved[dimension] += amount;
      }
    }
    if (reservation.status === "settled") {
      const usage = reservation.usage;
      for (const dimension of ["attempts", "seconds", "tokens"]) {
        if (usage?.[dimension] === null || usage?.[dimension] === undefined) unknown[dimension] = true;
        else consumed[dimension] += usage[dimension];
      }
    }
    if (reservation.status === "held" && reservation.usage) {
      for (const dimension of ["attempts", "seconds", "tokens"]) {
        if (reservation.usage[dimension] === null) unknown[dimension] = true;
      }
    }
    if (reservation.status === "held") {
      // A held reservation is deliberately still counted against its
      // reservation.  Mark unresolved dimensions so a caller cannot mistake
      // conservative remaining arithmetic for observed provider usage.
      if (!reservation.usage || reservation.usage.seconds === null) unknown.seconds = true;
      if (!reservation.usage || reservation.usage.tokens === null) unknown.tokens = true;
      if (reservation.outcome === "unknown") unknown.attempts = true;
    }
  }
  return { consumed, reserved, unknown };
}

function remainingFor(state) {
  const sums = totals(state);
  const result = {};
  for (const dimension of DIMENSIONS) {
    const limit = state.limits?.[dimension] ?? null;
    if (limit === null) {
      result[dimension] = { limit: null, consumed: null, reserved: null, remaining: null, unknown: true };
      continue;
    }
    const consumed = sums.consumed[dimension];
    const reserved = sums.reserved[dimension];
    result[dimension] = {
      limit,
      consumed,
      reserved,
      remaining: Math.max(0, limit - consumed - reserved),
      unknown: sums.unknown[dimension]
    };
  }
  return result;
}

function stateWithReservation(state, reservation) {
  const next = clone(state);
  next.sequence += 1;
  next.reservations[reservation.reservationId] = clone(reservation);
  next.stateDigest = stateDigest(next);
  return next;
}

function applyEvent(previous, event, runId) {
  validateEvent(event, runId);
  if (event.previousSequence !== previous.sequence || event.previousStateDigest !== previous.stateDigest) {
    fail("EBUDGET_CORRUPT", "budget ledger journal previous state does not match");
  }
  let next;
  if (event.op === "reserve") {
    assertExactKeys(event.payload, ["lineage", "limits", "reservation"], "reserve event payload");
    const lineage = validateLineage(event.payload.lineage, "reserve event lineage");
    const limits = validateLimits(event.payload.limits, "reserve event limits");
    const reservation = validateReservation(event.payload.reservation, "reserve event reservation");
    if (reservation.runtime.runId !== runId || reservation.status !== "reserved") fail("EBUDGET_CORRUPT", "reserve event reservation is invalid");
    if (previous.sequence !== 0 || previous.lineage !== null || previous.limits !== null) {
      if (!previous.lineage || !same(previous.lineage, lineage) || !same(previous.limits, limits)) fail("EBUDGET_CORRUPT", "reserve event lineage changed");
    }
    if (Object.hasOwn(previous.reservations, reservation.reservationId)) fail("EBUDGET_CORRUPT", "reserve event duplicates reservation");
    next = stateWithReservation({ ...previous, lineage, limits }, reservation);
  } else if (["settle", "release", "hold", "reconcile"].includes(event.op)) {
    assertExactKeys(event.payload, ["reservation"], `${event.op} event payload`);
    const reservation = validateReservation(event.payload.reservation, `${event.op} event reservation`);
    const prior = previous.reservations[reservation.reservationId];
    if (!prior) fail("EBUDGET_CORRUPT", `${event.op} event references a missing reservation`);
    if (event.op === "settle" && reservation.status !== "settled") fail("EBUDGET_CORRUPT", "settle event status is invalid");
    if (event.op === "release" && reservation.status !== "released") fail("EBUDGET_CORRUPT", "release event status is invalid");
    if (event.op === "hold" && reservation.status !== "held") fail("EBUDGET_CORRUPT", "hold event status is invalid");
    if (event.op === "reconcile" && !["held", "released", "settled"].includes(reservation.status)) fail("EBUDGET_CORRUPT", "reconcile event status is invalid");
    const immutableFields = [
      "schemaVersion", "kind", "reservationId", "idempotencyKey", "runtime", "executionId", "attemptId", "unitId",
      "admissionDigest", "lineage", "requested", "reserved", "createdAt"
    ];
    if (reservation.runtime.runId !== runId || immutableFields.some((field) => !same(reservation[field], prior[field]))) {
      fail("EBUDGET_CORRUPT", `${event.op} event changed immutable reservation identity`);
    }
    if (prior.status === "released" || prior.status === "settled") fail("EBUDGET_CORRUPT", `${event.op} event changed a terminal reservation`);
    next = stateWithReservation(previous, reservation);
  } else {
    fail("EBUDGET_CORRUPT", `unsupported budget ledger operation: ${event.op}`);
  }
  if (next.sequence !== event.sequence || next.stateDigest !== event.stateDigest) fail("EBUDGET_CORRUPT", "budget ledger event digest is invalid");
  validateState(next, runId);
  return next;
}

async function appendEvent(root, journalPath, event) {
  await assertNoSymlinkUnder(root, journalPath);
  let info = null;
  try {
    info = await lstat(journalPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (info && (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)) {
    fail("EBUDGET_CORRUPT", "budget ledger journal path is unsafe");
  }
  const handle = await open(journalPath, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(journalPath, 0o600);
}

async function readJournal(root, journalPath, runId, { withReadback = false, observationOnly = false } = {}) {
  const result = (events, bytes) => withReadback ? {
    events,
    journalReadback: bytes === null ? null : {
      relativePath: `runs/${runId}/${EXECUTION_BUDGET_LEDGER_DIRECTORY}/journal.jsonl`,
      byteLength: bytes.byteLength,
      digest: createHash("sha256").update(bytes).digest("hex")
    }
  } : events;
  if (observationOnly) await assertNoSymlinkUnderReadOnly(root, journalPath);
  else await assertNoSymlinkUnder(root, journalPath);
  let info;
  try {
    info = await lstat(journalPath);
  } catch (error) {
    if (error.code === "ENOENT") return result([], null);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) fail("EBUDGET_CORRUPT", "budget ledger journal path is unsafe");
  if (info.size > MAX_JOURNAL_BYTES) fail("EBUDGET_LIMIT", "budget ledger journal exceeds its bounded size");
  const bytes = await readFile(journalPath);
  if (bytes.length > MAX_JOURNAL_BYTES) fail("EBUDGET_LIMIT", "budget ledger journal grew beyond its bounded size");
  if (bytes.length === 0) return result([], bytes);
  if (bytes[bytes.length - 1] !== 0x0a) fail("EBUDGET_CORRUPT", "budget ledger journal has a partial tail");
  const lines = bytes.toString("utf8").trimEnd().split("\n");
  if (lines.length > MAX_JOURNAL_EVENTS) fail("EBUDGET_LIMIT", "budget ledger journal exceeds its bounded event count");
  const events = [];
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      fail("EBUDGET_CORRUPT", `budget ledger journal event ${index + 1} is not JSON`, { cause: error });
    }
    events.push(validateEvent(event, runId, `budget ledger journal event ${index + 1}`));
  }
  return result(events, bytes);
}

async function readSnapshot(root, snapshotPath, runId, { observationOnly = false } = {}) {
  try {
    return validateState(await (observationOnly
      ? readJsonReadOnly(root, snapshotPath)
      : readJson(root, snapshotPath)), runId);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof ExecutionBudgetLedgerError) throw error;
    fail("EBUDGET_CORRUPT", "budget ledger snapshot cannot be read", { cause: error });
  }
}

async function loadDurableState({ root, runId, journalPath, snapshotPath, repair = true }) {
  const events = await readJournal(root, journalPath, runId);
  let replayed = initialState(runId);
  for (const event of events) replayed = applyEvent(replayed, event, runId);
  const snapshot = await readSnapshot(root, snapshotPath, runId);
  if (snapshot && snapshot.sequence > replayed.sequence) fail("EBUDGET_CORRUPT", "budget ledger snapshot is ahead of its journal");
  if (snapshot && snapshot.sequence === replayed.sequence && snapshot.stateDigest !== replayed.stateDigest) {
    fail("EBUDGET_CORRUPT", "budget ledger snapshot diverges from its journal");
  }
  if (replayed.sequence > 0 && repair && (!snapshot || snapshot.sequence < replayed.sequence)) {
    await atomicWriteJson(root, snapshotPath, replayed);
  }
  return replayed;
}

async function withLedgerLock(root, runId, callback) {
  let lastError;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      return await withRunLock(root, runId, callback, { ttlMs: LOCK_WAIT_MS });
    } catch (error) {
      lastError = error;
      if (!/^Run is leased by pid /.test(String(error?.message ?? ""))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  fail("EBUDGET_LOCK_TIMEOUT", "budget ledger could not acquire the bounded run lease", { status: "UNKNOWN", cause: lastError });
}

function bindingFromHandle(handle) {
  return {
    runId: handle.runId,
    executionId: handle.executionId,
    attemptId: handle.attemptId,
    unitId: handle.unitId,
    ownedResourceId: handle.ownedResourceId,
    sourceBindingDigest: handle.sourceBindingDigest,
    policyDigest: handle.policyDigest,
    revision: handle.revision
  };
}

async function readCurrentAdmission({ controller, runId, handle, persistedAdmission, clock }) {
  if (!persistedAdmission || handle.admissionDigest === undefined) {
    fail("EBUDGET_ADMISSION_REQUIRED", "budget accounting requires a durable V3 execution admission");
  }
  let observed;
  const binding = bindingFromHandle(handle);
  try {
    if (typeof controller.readExecutionBinding === "function") {
      observed = await controller.readExecutionBinding({ runId, binding: clone(binding) });
    } else {
      observed = {
        runContract: await controller.readRunContract({ runId }),
        sourceBinding: await controller.readSourceBinding({ runId }),
        authority: await controller.readAuthority(clone(binding))
      };
    }
    if (!isPlainObject(observed) || !isPlainObject(observed.runContract) || !isPlainObject(observed.sourceBinding) || !isPlainObject(observed.authority)) {
      fail("EBUDGET_AUTHORITY", "trusted controller returned no complete current binding");
    }
    const observedSourceDigest = observed.sourceBinding.digest ?? observed.sourceBinding.sourceBindingDigest;
    if (observed.sourceBinding.runId !== runId || observed.sourceBinding.revision !== binding.revision || observedSourceDigest !== binding.sourceBindingDigest) {
      fail("EBUDGET_BINDING", "current source binding is stale or does not match the durable handle");
    }
    const built = buildExecutionAdmission({
      runContract: observed.runContract,
      authority: observed.authority,
      binding,
      now: new Date(safeNow(clock))
    });
    const fresh = built.admission;
    assertSameExecutionAdmission(persistedAdmission, fresh);
    if (digestExecutionAdmission(fresh) !== handle.admissionDigest) {
      fail("EBUDGET_BINDING", "current admission does not match the durable execution handle");
    }
    return {
      admission: clone(persistedAdmission),
      // The run ledger is shared by all task allocations. A task capability
      // cannot silently become the whole plan's ceiling. The immutable plan
      // above is independently validated as part of current admission.
      planLimits: validateLimits({ ...built.runContract.taskContract.budget, cost: null })
    };
  } catch (error) {
    if (error instanceof ExecutionBudgetLedgerError) throw error;
    // The admission read runs through the caller's trusted controller, and the
    // runtime already answers a stale binding, source or policy with its own
    // bounded fail-closed code.  Flattening every one of them into
    // EBUDGET_BINDING would hide why the effect was refused -- a binding whose
    // file permissions drifted would report a budget fault instead of
    // ENATIVE_COMMAND_BINDING_FS.  Forward that vocabulary when the error
    // carries it, and flatten anything else so an untrusted adapter still
    // cannot invent a code.
    if (BOUNDED_ADMISSION_CODE.test(error?.code ?? "") && HOLDABLE_STATUS.has(error?.status)) throw error;
    fail("EBUDGET_BINDING", "current trusted admission binding or policy is stale or invalid", { status: "HOLD", cause: error });
  }
}

async function freshRuntimeObservation({ registry, controller, runId, handleId, clock }) {
  const snapshot = await registry.load({ reconcile: false });
  const handle = snapshot.handles?.[handleId];
  if (!handle) fail("EBUDGET_HANDLE_MISSING", `execution handle ${handleId} was not found`);
  const persistedAdmission = snapshot.admissions?.[handleId];
  if (!persistedAdmission || handle.admissionDigest === undefined) {
    fail("EBUDGET_ADMISSION_REQUIRED", "budget accounting requires a durable V3 execution admission");
  }
  const context = await readCurrentAdmission({ controller, runId, handle, persistedAdmission, clock });
  return { snapshot, handle: clone(handle), ...context };
}

async function durableRuntimeObservation({ registry, runId, handleId }) {
  const snapshot = await registry.load({ reconcile: false });
  const handle = snapshot.handles?.[handleId];
  if (!handle) fail("EBUDGET_HANDLE_MISSING", `execution handle ${handleId} was not found`);
  const admission = snapshot.admissions?.[handleId];
  if (!admission || handle.admissionDigest === undefined) {
    fail("EBUDGET_ADMISSION_REQUIRED", "budget accounting requires a durable V3 execution admission");
  }
  validateExecutionAdmission(admission);
  if (digestExecutionAdmission(admission) !== handle.admissionDigest) {
    fail("EBUDGET_CORRUPT", "runtime handle admission digest is not bound");
  }
  return { snapshot, handle: clone(handle), admission: clone(admission) };
}

function lineageFromAdmission(admission) {
  return {
    planDigest: admission.planDigest,
    contractDigest: admission.contractDigest,
    sourceBindingDigest: admission.sourceBindingDigest,
    policyDigest: admission.policyDigest,
    revision: admission.revision
  };
}

function limitsFromAdmission(admission) {
  return {
    attempts: admission.budget.attempts,
    seconds: admission.budget.seconds,
    tokens: admission.budget.tokens,
    cost: null
  };
}

function normalizeReserveAmounts(amounts, limits) {
  const normalized = validateAmounts(amounts, "reserve.amounts");
  for (const dimension of ["attempts", "seconds", "tokens"]) {
    if (limits[dimension] !== null && normalized[dimension] === null) {
      fail("EBUDGET_UNKNOWN_AMOUNT", `reserve.amounts.${dimension} must be known for a finite limit`, { status: "HOLD" });
    }
    if (limits[dimension] !== null && normalized[dimension] > limits[dimension]) {
      fail("EBUDGET_EXHAUSTED", `reserve.amounts.${dimension} exceeds its admission limit`, { status: "HOLD" });
    }
  }
  if (normalized.attempts !== 1) fail("EBUDGET_INVALID", "one reservation must account for exactly one execution attempt");
  return normalized;
}

function assertFits(state, amounts) {
  const current = remainingFor(state);
  for (const dimension of ["attempts", "seconds", "tokens"]) {
    if (amounts[dimension] === null) continue;
    const item = current[dimension];
    if (item.limit !== null && item.unknown) {
      fail("EBUDGET_USAGE_UNKNOWN", `budget ${dimension} usage is unknown`, {
        status: "HOLD",
        details: { dimension }
      });
    }
    if (item.limit !== null && item.remaining < amounts[dimension]) {
      fail("EBUDGET_EXHAUSTED", `budget ${dimension} is exhausted`, { status: "HOLD", details: { dimension } });
    }
  }
}

function assertPreparedRuntimeState(runtimeState, handleId) {
  const handle = runtimeState.handles?.[handleId];
  if (!handle) fail("EBUDGET_HANDLE_MISSING", `execution handle ${handleId} was not found`);
  const intents = Object.values(runtimeState.intents ?? {}).filter((intent) => intent.handleId === handleId);
  // A budget reservation is a pre-dispatch allocation.  A terminal, blocked,
  // in-flight, or already-intended handle cannot receive a new allocation;
  // the existing idempotency lookup deliberately happens before this gate.
  if (handle.status !== "ready" || handle.dispatchBlocked !== false || intents.length > 0) {
    fail("EBUDGET_EXECUTION_NOT_PREPARED", "execution handle is not in a fresh pre-dispatch state", {
      status: "HOLD",
      details: {
        handleStatus: handle.status,
        dispatchBlocked: handle.dispatchBlocked,
        intentStatuses: intents.map((intent) => intent.status).sort()
      }
    });
  }
}

function buildReservation({ reservationId, idempotencyKey, runtime, admission, amounts, at }) {
  return validateReservation({
    schemaVersion: 1,
    kind: EXECUTION_BUDGET_RESERVATION_KIND,
    reservationId,
    idempotencyKey,
    runtime,
    executionId: runtime.executionId,
    attemptId: runtime.attemptId,
    unitId: runtime.unitId,
    admissionDigest: digestExecutionAdmission(admission),
    lineage: lineageFromAdmission(admission),
    requested: amounts,
    reserved: amounts,
    status: "reserved",
    outcome: "unknown",
    usage: null,
    createdAt: at,
    updatedAt: at
  });
}

async function readRuntimeFile(registry) {
  try {
    return await readJson(registry.root, registry.registryPath);
  } catch (error) {
    fail("EBUDGET_RUNTIME_RACE", "execution registry state could not be read for the budget CAS", { status: "UNKNOWN", cause: error });
  }
}

function assertRuntimeSnapshotUnchanged(before, after) {
  if (before.sequence !== after.sequence || before.stateDigest !== after.stateDigest) {
    fail("EBUDGET_RUNTIME_RACE", "execution registry changed while budget accounting was prepared", { status: "UNKNOWN" });
  }
}

function currentIntentFor(state, handleId) {
  const intents = Object.values(state.intents ?? {}).filter((intent) => intent.handleId === handleId);
  return intents.sort((a, b) => String(b.sealedAt ?? b.dispatchStartedAt ?? "").localeCompare(String(a.sealedAt ?? a.dispatchStartedAt ?? "")))[0] ?? null;
}

function trustedRuntimeUsage(intent, reservation) {
  if (intent.usageObservation === undefined || intent.usageObservation === null) return null;
  let observation;
  try {
    // This validator checks shape and binding only.  It is called exclusively
    // after durableRuntimeObservation() has loaded the journal through the
    // trusted execution registry/controller; a caller-supplied JSON object is
    // never accepted as a usage source.
    observation = validateExecutionUsageObservationV1(intent.usageObservation, {
      runId: reservation.runtime.runId,
      handleId: reservation.runtime.handleId,
      intentId: intent.intentId,
      executionId: reservation.runtime.executionId,
      attemptId: reservation.runtime.attemptId,
      unitId: reservation.runtime.unitId,
      sourceBindingDigest: reservation.lineage.sourceBindingDigest,
      policyDigest: reservation.lineage.policyDigest,
      revision: reservation.lineage.revision,
      ownedResourceId: reservation.runtime.ownedResourceId,
      authorityEpoch: reservation.runtime.authorityEpoch,
      fence: reservation.runtime.fence
    });
  } catch (error) {
    fail("EBUDGET_USAGE_INVALID", "trusted runtime usage observation is invalid", {
      status: "UNKNOWN",
      cause: error
    });
  }
  const seconds = Math.ceil(observation.elapsedMs / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    fail("EBUDGET_USAGE_INVALID", "trusted runtime elapsed observation cannot be accounted", { status: "UNKNOWN" });
  }
  return { attempts: observation.attempts, seconds, tokens: null, cost: null };
}

function usageOverrunDimension(usage, reserved) {
  for (const dimension of ["attempts", "seconds", "tokens"]) {
    if (usage?.[dimension] !== null && usage?.[dimension] !== undefined &&
        reserved[dimension] !== null && usage[dimension] > reserved[dimension]) return dimension;
  }
  return null;
}

function heldDecision(reservation) {
  const dimension = usageOverrunDimension(reservation.usage, reservation.reserved);
  return dimension === null ? "held-usage-unknown" : `held-usage-overrun-${dimension}`;
}

function classifyRuntimeSettlement(runtimeState, reservation) {
  const handle = runtimeState.handles?.[reservation.runtime.handleId];
  const intent = currentIntentFor(runtimeState, reservation.runtime.handleId);
  if (!handle || !intent) return { kind: "hold", reason: "runtime-intent-missing" };
  if (intent.status === "not-sent" && intent.callbackCalls === 0 && intent.dispatchReserved === false && intent.notSentAt && intent.notSentReason) {
    return { kind: "release", reason: "trusted-runtime-not-sent" };
  }
  // Reconciliation is append-only runtime evidence. A later exact
  // terminated/not-sent observation may release a reservation that was held
  // after an earlier UNKNOWN query; a fresh epoch alone never does so.
  const latestReconciliation = Array.isArray(intent.reconciliation)
    ? intent.reconciliation.at(-1)
    : null;
  if (intent.cleanupResolution?.status === "cleanup-confirmed") {
    return { kind: "hold", reason: "runtime-cleanup-confirmed" };
  }
  if (intent.status === "unknown" && latestReconciliation?.decision === "retryable" &&
      latestReconciliation.observation?.controllerStatus === "terminated" &&
      latestReconciliation.observation?.providerOutcome === "not-sent" &&
      latestReconciliation.observation?.businessOutcome === null) {
    return { kind: "release", reason: "trusted-runtime-reconciliation-not-sent" };
  }
  if (intent.status === "sealed" && ["success", "failure"].includes(intent.outcome) && intent.effectDigest) {
    const usage = trustedRuntimeUsage(intent, reservation);
    if (usage === null) return { kind: "hold", reason: "trusted-runtime-usage-missing" };
    return { kind: "settle", outcome: intent.outcome, usage, reason: "trusted-runtime-sealed" };
  }
  if (intent.status === "unknown" || handle.status === "indeterminate" || intent.dispatchReserved === true) {
    return { kind: "hold", reason: "runtime-effect-unknown" };
  }
  return { kind: "hold", reason: "runtime-not-terminal" };
}

function updateReservation(reservation, { status, outcome, usage, at }) {
  return validateReservation({
    ...reservation,
    status,
    outcome,
    usage,
    updatedAt: at
  });
}

function output(state, { idempotent = false, decision = undefined } = {}) {
  const frozen = clone({
    ...state,
    reservations: Object.fromEntries(Object.entries(state.reservations).map(([id, reservation]) => [id, clone(reservation)])),
    remaining: remainingFor(state),
    ...(decision === undefined ? {} : { decision }),
    ...(idempotent ? { idempotent: true } : {})
  });
  return freezeDeep(frozen);
}

export function validateExecutionBudgetLedgerV1(value) {
  return validateState(value, value?.runId, EXECUTION_BUDGET_LEDGER_KIND);
}

export function validateExecutionBudgetReservationV1(value) {
  return validateReservation(value);
}

/**
 * Observation-only local settlement readback. Journal digests identify the
 * bytes observed here; they are not an external history attestation or plan
 * acceptance authority.
 */
export async function readExecutionBudgetSettlementEvidenceV2(options = {}) {
  assertAllowedRequest(
    options,
    ["stateRoot", "registryRoot", "runId", "controller", "reservationId", "intentId"],
    ["stateRoot", "runId", "controller", "reservationId", "intentId"],
    "readExecutionBudgetSettlementEvidenceV2"
  );
  const { stateRoot, runId, controller, reservationId, intentId } = options;
  assertText(stateRoot, "stateRoot");
  if (!path.isAbsolute(stateRoot) || path.resolve(stateRoot) !== stateRoot) {
    fail("EBUDGET_INVALID", "stateRoot must be a canonical absolute path");
  }
  assertRunId(runId, "runId");
  assertId(reservationId, "reservationId");
  assertId(intentId, "intentId");
  if (Object.hasOwn(options, "registryRoot") &&
      (!path.isAbsolute(options.registryRoot) || path.resolve(options.registryRoot) !== options.registryRoot)) {
    fail("EBUDGET_INVALID", "registryRoot must be a canonical absolute path");
  }

  const runtimeEvidence = await readExecutionSealedEffectEvidenceV2({
    stateRoot,
    ...(Object.hasOwn(options, "registryRoot") ? { registryRoot: options.registryRoot } : {}),
    runId,
    controller,
    intentId
  });
  const root = options.registryRoot ?? safeJoin(stateRoot, "execution-runtime-v1");
  const ledgerDir = safeJoin(root, "runs", runId, EXECUTION_BUDGET_LEDGER_DIRECTORY);
  const journalPath = safeJoin(ledgerDir, "journal.jsonl");
  const snapshotPath = safeJoin(ledgerDir, "ledger.json");
  let readback;
  let state = initialState(runId);
  let snapshot;
  const prefixDigests = new Map([[0, state.stateDigest]]);
  try {
    readback = await readJournal(root, journalPath, runId, { withReadback: true, observationOnly: true });
    if (readback.journalReadback === null || readback.events.length === 0) {
      fail("EBUDGET_SETTLEMENT_UNAVAILABLE", "durable budget settlement journal is unavailable");
    }
    for (const event of readback.events) {
      state = applyEvent(state, event, runId);
      prefixDigests.set(state.sequence, state.stateDigest);
    }
    snapshot = await readSnapshot(root, snapshotPath, runId, { observationOnly: true });
    if (snapshot && prefixDigests.get(snapshot.sequence) !== snapshot.stateDigest) {
      fail("EBUDGET_SETTLEMENT_DIVERGED", "budget snapshot is not a journal prefix", { status: "UNKNOWN" });
    }
  } catch (cause) {
    if (cause?.code === "EBUDGET_SETTLEMENT_UNAVAILABLE" || cause?.code === "EBUDGET_SETTLEMENT_DIVERGED") throw cause;
    fail("EBUDGET_SETTLEMENT_READ_FAILED", "durable budget settlement could not be verified", {
      status: "UNKNOWN", cause
    });
  }

  const settlementEvents = readback.events.filter((event) =>
    event.op === "settle" && event.payload.reservation.reservationId === reservationId
  );
  const reservation = state.reservations[reservationId] ?? null;
  if (!reservation || reservation.status !== "settled" || settlementEvents.length === 0) {
    fail("EBUDGET_SETTLEMENT_UNAVAILABLE", "exact settled budget reservation is unavailable");
  }
  if (settlementEvents.length !== 1 || !same(settlementEvents[0].payload.reservation, reservation)) {
    fail("EBUDGET_SETTLEMENT_DIVERGED", "settled reservation diverges from its journal event", { status: "UNKNOWN" });
  }

  const { artifact, persistedHandle: handle, persistedIntent: intent } = runtimeEvidence;
  const runtime = reservation.runtime;
  if (runtime.runId !== runId || runtime.handleId !== handle.handleId ||
      artifact.runId !== runId || artifact.handleId !== handle.handleId || artifact.intentId !== intentId ||
      intent.intentId !== intentId || intent.handleId !== handle.handleId || intent.status !== "sealed" ||
      intent.callbackCalls !== 1 || intent.dispatchReserved !== false ||
      reservation.outcome !== artifact.outcome || intent.outcome !== artifact.outcome ||
      artifact.effect?.outcome !== artifact.outcome || artifact.effectDigest !== intent.effectDigest ||
      reservation.admissionDigest !== handle.admissionDigest ||
      reservation.admissionDigest !== runtimeEvidence.persistedAdmissionDigest ||
      !same(reservation.lineage, runtimeEvidence.persistedAdmissionLineage)) {
    fail("EBUDGET_SETTLEMENT_BINDING", "budget settlement is not bound to the sealed runtime effect", { status: "UNKNOWN" });
  }
  if (runtime.ownedResourceId !== handle.ownedResourceId) {
    fail("EBUDGET_SETTLEMENT_BINDING", "budget settlement ownedResourceId differs from the sealed handle", { status: "UNKNOWN" });
  }
  for (const field of ["executionId", "attemptId", "unitId", "authorityEpoch", "fence"]) {
    if (runtime[field] !== handle[field] || intent[field] !== handle[field]) {
      fail("EBUDGET_SETTLEMENT_BINDING", `budget settlement ${field} differs from the sealed runtime effect`, { status: "UNKNOWN" });
    }
  }
  for (const field of ["sourceBindingDigest", "policyDigest", "revision"]) {
    if (reservation.lineage[field] !== handle[field] || intent[field] !== handle[field]) {
      fail("EBUDGET_SETTLEMENT_BINDING", `budget settlement ${field} differs from the sealed runtime effect`, { status: "UNKNOWN" });
    }
  }
  const derivedUsage = trustedRuntimeUsage(intent, reservation);
  if (derivedUsage === null || reservation.usage === null || !same(derivedUsage, reservation.usage) ||
      usageOverrunDimension(derivedUsage, reservation.reserved) !== null) {
    fail("EBUDGET_SETTLEMENT_USAGE", "settled usage is not the bounded runtime observation", { status: "UNKNOWN" });
  }
  const stable = await readJournal(root, journalPath, runId, { withReadback: true, observationOnly: true }).catch((cause) => {
    fail("EBUDGET_SETTLEMENT_READ_FAILED", "budget journal changed during settlement readback", {
      status: "UNKNOWN", cause
    });
  });
  if (!stable.journalReadback || !same(stable.journalReadback, readback.journalReadback)) {
    fail("EBUDGET_SETTLEMENT_CHANGED", "budget journal changed during settlement readback", { status: "UNKNOWN" });
  }
  const settlement = settlementEvents[0];
  return freezeDeep(clone({
    schemaVersion: 2,
    kind: EXECUTION_BUDGET_SETTLEMENT_EVIDENCE_V2_KIND,
    status: "observed",
    runId,
    reservationId,
    intentId,
    reservation,
    usage: derivedUsage,
    usageObservation: intent.usageObservation,
    boundedUnknownDimensions: ["attempts", "seconds", "tokens"].filter((dimension) =>
      reservation.reserved[dimension] !== null && derivedUsage[dimension] === null
    ),
    settlementEvent: {
      eventId: settlement.eventId,
      sequence: settlement.sequence,
      stateDigest: settlement.stateDigest,
      at: settlement.at
    },
    ledgerHead: { sequence: state.sequence, stateDigest: state.stateDigest },
    journalReadback: readback.journalReadback,
    runtimeEvidence,
    authority: { maySettlePlan: false, mayReleaseDependencies: false }
  }));
}

export async function openExecutionBudgetLedgerV1({
  stateRoot,
  runId,
  controller,
  resourceAdapter = null,
  clock = undefined
} = {}) {
  assertText(stateRoot, "stateRoot");
  if (!path.isAbsolute(stateRoot) || path.resolve(stateRoot) !== stateRoot) fail("EBUDGET_INVALID", "stateRoot must be a canonical absolute path");
  assertRunId(runId, "runId");
  const safeClockValue = validateClock(clock);
  let registry;
  try {
    registry = await openExecutionRegistry({ stateRoot, runId, controller, resourceAdapter, clock: safeClockValue });
  } catch (error) {
    if (error instanceof ExecutionBudgetLedgerError) throw error;
    fail("EBUDGET_AUTHORITY", "opening a durable budget ledger requires the trusted execution registry/controller", { status: "HOLD", cause: error });
  }
  const root = registry.root;
  const ledgerDir = safeJoin(registry.runDir, EXECUTION_BUDGET_LEDGER_DIRECTORY);
  const snapshotPath = safeJoin(ledgerDir, "ledger.json");
  const journalPath = safeJoin(ledgerDir, "journal.jsonl");
  await assertNoSymlinkUnder(root, ledgerDir);
  await ensurePrivateDir(ledgerDir);

  async function fresh(handleId) {
    assertId(handleId, "handleId");
    return freshRuntimeObservation({ registry, controller, runId, handleId, clock: safeClockValue });
  }

  async function reserveBudget(request = {}, recovery = null) {
    assertRequest(request, ["handleId", "idempotencyKey", "amounts"], "reserve");
    const { handleId, idempotencyKey, amounts } = request;
    assertText(idempotencyKey, "reserve.idempotencyKey");
    assertId(handleId, "reserve.handleId");
    const observed = await fresh(handleId);
    const recoveryBoundary = recovery === null ? null : await registry.readRecoveryTaskEffectDispatchBoundary(recovery.intentId);
    if (recoveryBoundary !== null && (recoveryBoundary.intent.intentDigest !== recovery.intentDigest ||
        recoveryBoundary.intent.handleId !== handleId || recoveryBoundary.registryHead.sequence !== observed.snapshot.sequence ||
        recoveryBoundary.registryHead.stateDigest !== observed.snapshot.stateDigest)) {
      fail("EBUDGET_RECOVERY_BINDING", "recovery reservation differs from the trusted runtime snapshot", { status: "HOLD" });
    }
    const beforeRuntime = {
      sequence: observed.snapshot.sequence,
      stateDigest: observed.snapshot.stateDigest
    };
    const limits = observed.planLimits;
    // Each allocation must still fit its exact task grant even when the
    // independently bound run budget is larger.
    const normalizedAmounts = normalizeReserveAmounts(amounts, limitsFromAdmission(observed.admission));
    normalizeReserveAmounts(normalizedAmounts, limits);
    return withLedgerLock(root, runId, async () => {
      const runtimeAfter = await readRuntimeFile(registry);
      assertRuntimeSnapshotUnchanged(beforeRuntime, runtimeAfter);
      // Re-read the controller while this ledger holds the same run lease.
      // A pre-lock authority read alone would leave a revoke/rebind window
      // between admission observation and the durable reservation event.
      const currentContext = await readCurrentAdmission({
        controller,
        runId,
        handle: observed.handle,
        persistedAdmission: observed.admission,
        clock: safeClockValue
      });
      const currentAdmission = currentContext.admission;
      if (!same(limits, currentContext.planLimits)) {
        fail("EBUDGET_LINEAGE", "current plan budget changed during reservation", { status: "HOLD" });
      }
      const state = await loadDurableState({ root, runId, journalPath, snapshotPath });
      const existing = Object.values(state.reservations).find((item) => item.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.admissionDigest !== digestExecutionAdmission(currentAdmission) ||
            existing.runtime.handleId !== observed.handle.handleId || !same(existing.requested, normalizedAmounts)) {
          fail("EBUDGET_IDEMPOTENCY_CONFLICT", "reserve idempotencyKey is already bound to different execution data");
        }
        return output(state, { idempotent: true });
      }
      if (recoveryBoundary === null) assertPreparedRuntimeState(runtimeAfter, handleId);
      else if (recoveryBoundary.launch !== null || !same(runtimeAfter.handles[handleId], recoveryBoundary.handle) ||
          recoveryBoundary.handle.status !== "ready" || recoveryBoundary.handle.dispatchBlocked !== true ||
          Object.values(runtimeAfter.intents ?? {}).some((intent) => intent.handleId === handleId)) {
        fail("EBUDGET_RECOVERY_NOT_PREPARED", "recovery budget requires an exact blocked reservation before launch", { status: "HOLD" });
      }
      if (state.lineage !== null && (!same(state.lineage, lineageFromAdmission(currentAdmission)) || !same(state.limits, limits))) {
        fail("EBUDGET_LINEAGE", "current admission is from a different plan/source/policy lineage", { status: "HOLD" });
      }
      if (Object.values(state.reservations).some((item) => item.runtime.handleId === observed.handle.handleId)) {
        fail("EBUDGET_HANDLE_REUSED", "an execution handle already has a budget reservation", { status: "HOLD" });
      }
      assertFits(state, normalizedAmounts);
      // Repeated attempts for one task share that task's cap. Group through
      // the registry's digest-bound admissions, never caller task labels or
      // a new unverified field added to historical ledger records.
      const taskReservations = {};
      for (const [id, reservation] of Object.entries(state.reservations)) {
        // Admissions are derived from the validated journal by registry.load.
        // The snapshot CAS above binds them to the still-current registry.
        const priorAdmission = observed.snapshot.admissions?.[reservation.runtime.handleId];
        if (!priorAdmission || digestExecutionAdmission(priorAdmission) !== reservation.admissionDigest) {
          fail("EBUDGET_BINDING", "prior budget reservation has no matching durable admission", { status: "HOLD" });
        }
        if (priorAdmission.taskId === currentAdmission.taskId) taskReservations[id] = reservation;
      }
      assertFits({ ...state, limits: limitsFromAdmission(currentAdmission), reservations: taskReservations }, normalizedAmounts);
      const at = safeNow(safeClockValue);
      const reservation = buildReservation({
        reservationId: randomUUID(),
        idempotencyKey,
        runtime: {
          runId,
          handleId: observed.handle.handleId,
          executionId: observed.handle.executionId,
          attemptId: observed.handle.attemptId,
          unitId: observed.handle.unitId,
          ownedResourceId: observed.handle.ownedResourceId,
          authorityEpoch: observed.handle.authorityEpoch,
          fence: observed.handle.fence
        },
        admission: currentAdmission,
        amounts: normalizedAmounts,
        at
      });
      const next = stateWithReservation({
        ...state,
        lineage: lineageFromAdmission(currentAdmission),
        limits
      }, reservation);
      const event = {
        schemaVersion: 1,
        kind: EXECUTION_BUDGET_EVENT_KIND,
        eventId: randomUUID(),
        runId,
        sequence: next.sequence,
        previousSequence: state.sequence,
        previousStateDigest: state.stateDigest,
        op: "reserve",
        payload: { lineage: next.lineage, limits: next.limits, reservation },
        stateDigest: next.stateDigest,
        at
      };
      await appendEvent(root, journalPath, event);
      await atomicWriteJson(root, snapshotPath, next);
      return output(next, { decision: "reserved" });
    });
  }

  async function settle(request = {}) {
    assertRequest(request, ["handleId", "reservationId"], "settle");
    const { handleId, reservationId } = request;
    assertId(handleId, "settle.handleId");
    assertId(reservationId, "settle.reservationId");
    const observed = await durableRuntimeObservation({ registry, runId, handleId });
    const beforeRuntime = { sequence: observed.snapshot.sequence, stateDigest: observed.snapshot.stateDigest };
    return withLedgerLock(root, runId, async () => {
      const runtimeAfter = await readRuntimeFile(registry);
      assertRuntimeSnapshotUnchanged(beforeRuntime, runtimeAfter);
      const state = await loadDurableState({ root, runId, journalPath, snapshotPath });
      const prior = state.reservations[reservationId];
      if (!prior) fail("EBUDGET_RESERVATION_MISSING", "budget reservation was not found");
      if (prior.runtime.handleId !== observed.handle.handleId || prior.admissionDigest !== digestExecutionAdmission(observed.admission)) {
        fail("EBUDGET_BINDING", "settlement handle/admission does not match the reservation", { status: "HOLD" });
      }
      if (prior.status === "released" || prior.status === "settled") return output(state, { idempotent: true, decision: prior.status });
      // A held outcome is already a durable terminal accounting decision.  A
      // repeated settle must not reinterpret it as a new usage observation or
      // release its reservation.
      if (prior.status === "held" && prior.usage !== null) {
        return output(state, { idempotent: true, decision: heldDecision(prior) });
      }
      const runtimeState = await readRuntimeFile(registry);
      const classification = classifyRuntimeSettlement(runtimeState, prior);
      if (classification.kind === "release") {
        const at = safeNow(safeClockValue);
        const nextReservation = updateReservation(prior, { status: "released", outcome: "not-sent", usage: null, at });
        const next = stateWithReservation(state, nextReservation);
        const event = {
          schemaVersion: 1, kind: EXECUTION_BUDGET_EVENT_KIND, eventId: randomUUID(), runId,
          sequence: next.sequence, previousSequence: state.sequence, previousStateDigest: state.stateDigest,
          op: "release", payload: { reservation: nextReservation }, stateDigest: next.stateDigest, at
        };
        await appendEvent(root, journalPath, event);
        await atomicWriteJson(root, snapshotPath, next);
        return output(next, { decision: "released" });
      }
      if (classification.kind === "settle") {
        const at = safeNow(safeClockValue);
        const overrun = usageOverrunDimension(classification.usage, prior.reserved);
        const nextStatus = overrun === null ? "settled" : "held";
        const nextReservation = updateReservation(prior, {
          status: nextStatus,
          outcome: classification.outcome,
          usage: classification.usage,
          at
        });
        const next = stateWithReservation(state, nextReservation);
        const event = {
          schemaVersion: 1, kind: EXECUTION_BUDGET_EVENT_KIND, eventId: randomUUID(), runId,
          sequence: next.sequence, previousSequence: state.sequence, previousStateDigest: state.stateDigest,
          op: nextStatus === "settled" ? "settle" : "hold", payload: { reservation: nextReservation }, stateDigest: next.stateDigest, at
        };
        await appendEvent(root, journalPath, event);
        await atomicWriteJson(root, snapshotPath, next);
        return output(next, { decision: nextStatus === "settled" ? "settled-observed-runtime-usage" : `held-usage-overrun-${overrun}` });
      }
      if (prior.status === "held") return output(state, { decision: "held" });
      const at = safeNow(safeClockValue);
      const nextReservation = updateReservation(prior, { status: "held", outcome: "unknown", usage: null, at });
      const next = stateWithReservation(state, nextReservation);
      const event = {
        schemaVersion: 1, kind: EXECUTION_BUDGET_EVENT_KIND, eventId: randomUUID(), runId,
        sequence: next.sequence, previousSequence: state.sequence, previousStateDigest: state.stateDigest,
        op: "hold", payload: { reservation: nextReservation }, stateDigest: next.stateDigest, at
      };
      await appendEvent(root, journalPath, event);
      await atomicWriteJson(root, snapshotPath, next);
      return output(next, { decision: "held-unknown" });
    });
  }

  async function reconcile(request = {}) {
    assertAllowedRequest(request, ["handleId", "reservationId", "expectedSequence", "timeoutMs", "abortSignal"], ["handleId", "reservationId"], "reconcile");
    const { handleId, reservationId, expectedSequence = undefined, timeoutMs = 10_000, abortSignal = undefined } = request;
    assertId(handleId, "reconcile.handleId");
    assertId(reservationId, "reconcile.reservationId");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 60_000) fail("EBUDGET_INVALID", "reconcile.timeoutMs is invalid");
    const signal = validateAbortSignal(abortSignal);
    const observed = await durableRuntimeObservation({ registry, runId, handleId });
    const state = await loadDurableState({ root, runId, journalPath, snapshotPath });
    const reservation = state.reservations[reservationId];
    if (!reservation) fail("EBUDGET_RESERVATION_MISSING", "budget reservation was not found");
    if (reservation.runtime.handleId !== observed.handle.handleId || reservation.runtime.handleId !== handleId) fail("EBUDGET_BINDING", "reconcile handle does not match the reservation", { status: "HOLD" });
    if (reservation.status === "released" || reservation.status === "settled") {
      return output(state, { idempotent: true, decision: reservation.status });
    }
    if (!resourceAdapter || typeof registry.reconcileUnknownExecution !== "function") {
      return output(state, { decision: "hold-resource-query-unavailable" });
    }
    let reconciliation;
    try {
      reconciliation = await registry.reconcileUnknownExecution(observed.handle.handleId, {
        expectedSequence,
        timeoutMs,
        abortSignal: signal
      });
    } catch (error) {
      if (error?.status === "UNKNOWN" || error?.code?.startsWith("EEXECUTION_RECONCILE")) {
        return output(state, { decision: "hold-reconcile-unknown" });
      }
      throw error;
    }
    const decision = reconciliation.reconciliation?.decision;
    if (!decision || !["retryable", "completed", "hold"].includes(decision)) {
      return output(state, { decision: "hold-invalid-reconciliation" });
    }
    return withLedgerLock(root, runId, async () => {
      const runtimeAfter = await readRuntimeFile(registry);
      if (runtimeAfter.sequence !== observed.snapshot.sequence + 1 ||
          (expectedSequence !== undefined && expectedSequence !== observed.snapshot.sequence)) {
        fail("EBUDGET_RUNTIME_RACE", "runtime changed after reconciliation observation", { status: "UNKNOWN" });
      }
      const current = await loadDurableState({ root, runId, journalPath, snapshotPath });
      const prior = current.reservations[reservationId];
      if (!prior) fail("EBUDGET_RESERVATION_MISSING", "budget reservation disappeared during reconciliation");
      if (prior.status === "released" || prior.status === "settled") return output(current, { idempotent: true, decision: prior.status });
      const at = safeNow(safeClockValue);
      const nextReservation = decision === "retryable"
        ? updateReservation(prior, { status: "released", outcome: "not-sent", usage: null, at })
        : decision === "completed"
          ? updateReservation(prior, { status: "held", outcome: "unknown", usage: { attempts: 1, seconds: null, tokens: null, cost: null }, at })
          : updateReservation(prior, { status: "held", outcome: "unknown", usage: null, at });
      const next = stateWithReservation(current, nextReservation);
      const event = {
        schemaVersion: 1, kind: EXECUTION_BUDGET_EVENT_KIND, eventId: randomUUID(), runId,
        sequence: next.sequence, previousSequence: current.sequence, previousStateDigest: current.stateDigest,
        op: "reconcile", payload: { reservation: nextReservation }, stateDigest: next.stateDigest, at
      };
      await appendEvent(root, journalPath, event);
      await atomicWriteJson(root, snapshotPath, next);
      return output(next, { decision: decision === "retryable" ? "released-after-trusted-not-sent" : decision === "completed" ? "held-provider-completed" : "held" });
    });
  }

  function reserve(request = {}) {
    return reserveBudget(request);
  }

  function reserveRecoveryTaskEffect(request = {}) {
    assertRequest(request, ["handleId", "idempotencyKey", "amounts", "intentId", "intentDigest"], "reserveRecoveryTaskEffect");
    assertId(request.intentId, "reserveRecoveryTaskEffect.intentId");
    assertDigest(request.intentDigest, "reserveRecoveryTaskEffect.intentDigest");
    return reserveBudget({ handleId: request.handleId, idempotencyKey: request.idempotencyKey, amounts: request.amounts },
      { intentId: request.intentId, intentDigest: request.intentDigest });
  }

  async function remaining() {
    const state = await withLedgerLock(root, runId, async () => loadDurableState({ root, runId, journalPath, snapshotPath }));
    return freezeDeep(clone({ runId, sequence: state.sequence, stateDigest: state.stateDigest, remaining: remainingFor(state), reservations: state.reservations }));
  }

  async function load() {
    const state = await withLedgerLock(root, runId, async () => loadDurableState({ root, runId, journalPath, snapshotPath }));
    return output(state);
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: EXECUTION_BUDGET_LEDGER_KIND,
    runId,
    root,
    runDir: registry.runDir,
    ledgerDir,
    snapshotPath,
    journalPath,
    registry,
    reserve,
    reserveRecoveryTaskEffect,
    settle,
    reconcile,
    remaining,
    load
  });
}
