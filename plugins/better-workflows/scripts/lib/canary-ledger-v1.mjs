// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

export const CANARY_REGISTRATION_KIND = "CanaryRegistrationV1";
export const CANARY_LEDGER_EVENT_KIND = "CanaryLedgerEventV1";
export const CANARY_REPORT_KIND = "CanaryEvaluationV1";
export const CANARY_OUTCOMES = Object.freeze([
  "SUCCEEDED", "FAILED", "CANCELLED", "HOLD", "UNKNOWN", "INFRA_FAILURE"
]);
export const CANARY_RISK_KEYS = Object.freeze([
  "unauthorized", "duplicate", "stale", "scope", "unknown", "leak"
]);

const EVENT_OPS = new Set([
  "REGISTER", "RUN_STARTED", "RUN_FINISHED", "RISK_RECORDED", "HOLD_CLASSIFIED", "TOIL_RECORDED"
]);
const HOLD_CLASSES = new Set(["AVOIDABLE", "UNAVOIDABLE", "UNKNOWN"]);
const ORIGINS = new Set(["NATURAL", "SYNTHETIC_FIXTURE"]);
const ELIGIBILITY = new Set(["ELIGIBLE", "EXCLUDED", "OUT_OF_SCOPE", "UNKNOWN"]);
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40,64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FACT_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const OUTCOME_DERIVED_FACT = /(?:outcome|result|status|success|successful|succeeded|pass|passed|failure|failed|error|cancelled|canceled|complete|completed|finished|finishedat|finishat|terminal|holdreason|holdclassification)$/;
const ELIGIBILITY_FACT_FIELDS = new Set(["tier", "maintenance"]);
const ZERO_DIGEST = "0".repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MAX_EVENTS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_STRING = 4096;
const MAX_NODES = 300_000;
const MAX_DEPTH = 16;
const MAX_LOCK_TIMEOUT_MS = 30_000;
const FIXED_THRESHOLDS = Object.freeze({
  minimumDurationDays: 30,
  minimumEligibleRuns: 20,
  minimumRepositories: 3,
  maximumAvoidableHoldRate: 0.05,
  weeklyToilTargetMinutes: 60,
  weeklyToilStopMinutes: 90,
  consecutiveStopWeeks: 2,
  maximumRiskCount: 0
});

export class CanaryLedgerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "CanaryLedgerError";
    this.code = code;
    if (options.status) this.status = options.status;
  }
}

function fail(code, message, options = {}) {
  throw new CanaryLedgerError(code, message, options);
}

// Accept plain JSON data without invoking getters or toJSON methods.
function snapshot(value) {
  let nodes = 0;
  const active = new Set();
  function copy(item, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail("ECANARY_LIMIT", "Canary input exceeds structural bounds");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("ECANARY_INVALID", "Canary input numbers must be finite");
      return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item === "string") {
      if (item.length > MAX_STRING) fail("ECANARY_LIMIT", "Canary input string is too large");
      return item;
    }
    if (!item || typeof item !== "object") fail("ECANARY_INVALID", "Canary input must contain JSON data only");
    if (active.has(item)) fail("ECANARY_INVALID", "Canary input cannot contain cycles");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      fail("ECANARY_INVALID", "Canary input must contain plain objects or arrays");
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length > 0) fail("ECANARY_INVALID", "Canary input cannot contain symbol fields");
    active.add(item);
    let result;
    if (array) {
      if (item.length > MAX_EVENTS || Object.keys(descriptors).length !== item.length + 1) {
        fail("ECANARY_LIMIT", "Canary input array is too large, sparse, or decorated");
      }
      result = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          fail("ECANARY_INVALID", "Canary input array contains an accessor or hole");
        }
        result.push(copy(descriptor.value, depth + 1));
      }
    } else {
      if (Object.keys(descriptors).length > 128) fail("ECANARY_LIMIT", "Canary input object has too many fields");
      result = {};
      for (const key of Object.keys(descriptors).sort()) {
        if (["__proto__", "constructor", "prototype"].includes(key)) fail("ECANARY_INVALID", "Unsafe object field");
        const descriptor = descriptors[key];
        if (!("value" in descriptor) || !descriptor.enumerable) fail("ECANARY_INVALID", "Canary input cannot contain accessors or hidden fields");
        result[key] = copy(descriptor.value, depth + 1);
      }
    }
    active.delete(item);
    return result;
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) fail("ECANARY_LIMIT", "Canary input exceeds the byte bound");
  return result;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(snapshot(value));
}

function digestObject(kind, value) {
  return createHash("sha256").update(`BW:${kind}\0`).update(canonicalJson(value)).digest("hex");
}

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("ECANARY_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) fail("ECANARY_INVALID", `${label} has unexpected or missing fields`);
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("ECANARY_INVALID", `${label} is invalid`);
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("ECANARY_INVALID", `${label} must be a SHA-256 digest`);
}

function revision(value, label) {
  if (typeof value !== "string" || !REVISION.test(value)) fail("ECANARY_INVALID", `${label} must be a lowercase revision digest`);
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("ECANARY_INVALID", `${label} must be a canonical UTC timestamp`);
  }
  return Date.parse(value);
}

function nonNegativeInteger(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || value < 0) fail("ECANARY_INVALID", `${label} must be a non-negative safe integer${nullable ? " or null" : ""}`);
}

function addSafeInteger(total, value, label) {
  const result = total + value;
  if (!Number.isSafeInteger(result)) fail("ECANARY_LIMIT", `${label} exceeds the safe integer bound`);
  return result;
}

function scalar(value, label) {
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) fail("ECANARY_INVALID", `${label} must be a scalar`);
  if (typeof value === "number" && !Number.isFinite(value)) fail("ECANARY_INVALID", `${label} must be finite`);
}

function validateFacts(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("ECANARY_INVALID", `${label} must be an object`);
  for (const [key, item] of Object.entries(value)) {
    if (!FACT_KEY.test(key)) fail("ECANARY_INVALID", `${label} contains an invalid key`);
    scalar(item, `${label}.${key}`);
  }
}

function validateRule(rule, label) {
  exact(rule, ["ruleId", "all"], label);
  identifier(rule.ruleId, `${label}.ruleId`);
  if (!Array.isArray(rule.all) || rule.all.length === 0 || rule.all.length > 32) fail("ECANARY_INVALID", `${label}.all must contain 1 to 32 predicates`);
  for (const [index, predicate] of rule.all.entries()) {
    exact(predicate, ["field", "operator", "value"], `${label}.all[${index}]`);
    if (typeof predicate.field !== "string" || !FACT_KEY.test(predicate.field)) fail("ECANARY_INVALID", `${label}.all[${index}].field is invalid`);
    const normalizedField = predicate.field.replace(/[_-]/g, "").toLowerCase();
    if (OUTCOME_DERIVED_FACT.test(normalizedField)) fail("ECANARY_INVALID", `${label}.all[${index}].field is outcome-derived`);
    if (!ELIGIBILITY_FACT_FIELDS.has(predicate.field)) {
      fail("ECANARY_INVALID", `${label}.all[${index}].field is not a frozen V1 start-time fact`);
    }
    if (predicate.operator === "eq") scalar(predicate.value, `${label}.all[${index}].value`);
    else if (predicate.operator === "oneOf") {
      if (!Array.isArray(predicate.value) || predicate.value.length === 0 || predicate.value.length > 32) {
        fail("ECANARY_INVALID", `${label}.all[${index}].value must be a bounded non-empty array`);
      }
      for (const item of predicate.value) scalar(item, `${label}.all[${index}].value`);
    } else fail("ECANARY_INVALID", `${label}.all[${index}].operator is unsupported`);
  }
}

function registrationBody(value) {
  exact(value, [
    "schemaVersion", "kind", "ledgerId", "campaignId", "revision", "policyId", "policyDigest",
    "registeredAt", "observationWindow", "eligibilityPolicy", "holdReasons", "thresholds"
  ], "registration");
  if (value.schemaVersion !== 1 || value.kind !== CANARY_REGISTRATION_KIND) fail("ECANARY_INVALID", "Registration version/kind is invalid");
  identifier(value.ledgerId, "registration.ledgerId");
  identifier(value.campaignId, "registration.campaignId");
  revision(value.revision, "registration.revision");
  identifier(value.policyId, "registration.policyId");
  digest(value.policyDigest, "registration.policyDigest");
  const registeredAt = timestamp(value.registeredAt, "registration.registeredAt");
  exact(value.observationWindow, ["startsAt", "endsAt"], "registration.observationWindow");
  const startsAt = timestamp(value.observationWindow.startsAt, "registration.observationWindow.startsAt");
  const endsAt = timestamp(value.observationWindow.endsAt, "registration.observationWindow.endsAt");
  if (registeredAt >= startsAt || startsAt >= endsAt) fail("ECANARY_INVALID", "Registration must precede a non-empty observation window");
  if (windowWeekCount(value.observationWindow) > MAX_EVENTS) fail("ECANARY_LIMIT", "Registration observation window exceeds the derived-week bound");
  exact(value.eligibilityPolicy, ["scopeRules", "exclusionRules"], "registration.eligibilityPolicy");
  if (!Array.isArray(value.eligibilityPolicy.scopeRules) || value.eligibilityPolicy.scopeRules.length === 0) {
    fail("ECANARY_INVALID", "Registration requires at least one scope rule");
  }
  if (!Array.isArray(value.eligibilityPolicy.exclusionRules)) fail("ECANARY_INVALID", "Registration exclusionRules must be an array");
  const ruleIds = new Set();
  for (const [index, rule] of value.eligibilityPolicy.scopeRules.entries()) {
    validateRule(rule, `registration.eligibilityPolicy.scopeRules[${index}]`);
    if (ruleIds.has(rule.ruleId)) fail("ECANARY_INVALID", "Registration rule IDs must be unique");
    ruleIds.add(rule.ruleId);
  }
  for (const [index, rule] of value.eligibilityPolicy.exclusionRules.entries()) {
    validateRule(rule, `registration.eligibilityPolicy.exclusionRules[${index}]`);
    if (ruleIds.has(rule.ruleId)) fail("ECANARY_INVALID", "Registration rule IDs must be unique");
    ruleIds.add(rule.ruleId);
  }
  if (!Array.isArray(value.holdReasons) || value.holdReasons.length === 0) fail("ECANARY_INVALID", "Registration holdReasons must be non-empty");
  const reasons = new Set();
  for (const [index, reason] of value.holdReasons.entries()) {
    exact(reason, ["reasonCode", "classification", "criterionDigest"], `registration.holdReasons[${index}]`);
    identifier(reason.reasonCode, `registration.holdReasons[${index}].reasonCode`);
    if (!HOLD_CLASSES.has(reason.classification)) fail("ECANARY_INVALID", "Registration HOLD classification is invalid");
    digest(reason.criterionDigest, `registration.holdReasons[${index}].criterionDigest`);
    if (reasons.has(reason.reasonCode)) fail("ECANARY_INVALID", "Registration HOLD reason codes must be unique");
    reasons.add(reason.reasonCode);
  }
  exact(value.thresholds, Object.keys(FIXED_THRESHOLDS), "registration.thresholds");
  if (canonicalJson(value.thresholds) !== canonicalJson(FIXED_THRESHOLDS)) fail("ECANARY_INVALID", "Registration thresholds must use the fixed V1 policy");
  return value;
}

export function createCanaryRegistrationV1(input) {
  const body = registrationBody(snapshot(input));
  return freeze({ ...body, registrationDigest: digestObject(CANARY_REGISTRATION_KIND, body) });
}

export function validateCanaryRegistrationV1(input) {
  const value = snapshot(input);
  const { registrationDigest, ...body } = value;
  digest(registrationDigest, "registration.registrationDigest");
  const expected = createCanaryRegistrationV1(body);
  if (expected.registrationDigest !== registrationDigest) fail("ECANARY_REGISTRATION_MISMATCH", "Registration digest mismatch");
  return expected;
}

function evaluateRule(rule, facts) {
  const missing = [];
  for (const predicate of rule.all) {
    if (!Object.hasOwn(facts, predicate.field)) {
      missing.push(predicate.field);
      continue;
    }
    const actual = facts[predicate.field];
    const matches = predicate.operator === "eq"
      ? canonicalJson(actual) === canonicalJson(predicate.value)
      : predicate.value.some((candidate) => canonicalJson(candidate) === canonicalJson(actual));
    if (!matches) return { result: false, missing: [] };
  }
  return missing.length > 0 ? { result: null, missing } : { result: true, missing: [] };
}

function evaluateRuleSet(rules, facts) {
  if (rules.length === 0) return { result: false, matched: [], missing: [] };
  const evaluated = rules.map((rule) => ({ ruleId: rule.ruleId, ...evaluateRule(rule, facts) }));
  const matched = evaluated.filter((item) => item.result === true).map((item) => item.ruleId).sort();
  const missing = [...new Set(evaluated.flatMap((item) => item.missing))].sort();
  return { result: matched.length > 0 ? true : evaluated.some((item) => item.result === null) ? null : false, matched, missing };
}

export function classifyCanaryRunV1(input) {
  const value = snapshot(input);
  exact(value, ["registration", "origin", "facts"], "classification input");
  const registration = validateCanaryRegistrationV1(value.registration);
  if (!ORIGINS.has(value.origin)) fail("ECANARY_INVALID", "Run origin is invalid");
  validateFacts(value.facts, "classification input facts");
  const scope = evaluateRuleSet(registration.eligibilityPolicy.scopeRules, value.facts);
  const exclusion = scope.result === true
    ? evaluateRuleSet(registration.eligibilityPolicy.exclusionRules, value.facts)
    : { result: false, matched: [], missing: [] };
  const decision = scope.result === false ? "OUT_OF_SCOPE"
    : scope.result === null ? "UNKNOWN"
      : exclusion.result === true ? "EXCLUDED"
        : exclusion.result === null ? "UNKNOWN" : "ELIGIBLE";
  return freeze({
    decision,
    matchedScopeRuleIds: scope.matched,
    matchedExclusionRuleIds: exclusion.matched,
    missingFields: [...new Set([...scope.missing, ...exclusion.missing])].sort()
  });
}

function validateEvidenceRefs(value, label) {
  if (!Array.isArray(value) || value.length > 64) fail("ECANARY_INVALID", `${label} must be a bounded array`);
  for (const [index, ref] of value.entries()) {
    exact(ref, ["id", "kind", "digest"], `${label}[${index}]`);
    identifier(ref.id, `${label}[${index}].id`);
    identifier(ref.kind, `${label}[${index}].kind`);
    digest(ref.digest, `${label}[${index}].digest`);
  }
}

function validateProvenance(value) {
  exact(value, ["producerId", "sourceId", "sourceRevision", "sourceDigest", "evidenceRefs"], "event.provenance");
  identifier(value.producerId, "event.provenance.producerId");
  identifier(value.sourceId, "event.provenance.sourceId");
  identifier(value.sourceRevision, "event.provenance.sourceRevision");
  digest(value.sourceDigest, "event.provenance.sourceDigest");
  validateEvidenceRefs(value.evidenceRefs, "event.provenance.evidenceRefs");
}

function validateEligibility(value) {
  exact(value, ["decision", "matchedScopeRuleIds", "matchedExclusionRuleIds", "missingFields"], "run eligibility");
  if (!ELIGIBILITY.has(value.decision)) fail("ECANARY_INVALID", "Run eligibility decision is invalid");
  for (const key of ["matchedScopeRuleIds", "matchedExclusionRuleIds", "missingFields"]) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string")) fail("ECANARY_INVALID", `Run eligibility ${key} is invalid`);
  }
}

function validatePayload(op, payload) {
  if (op === "REGISTER") {
    exact(payload, ["registration"], "REGISTER payload");
    validateCanaryRegistrationV1(payload.registration);
  } else if (op === "RUN_STARTED") {
    exact(payload, ["repositoryId", "runId", "repositoryRevision", "origin", "facts", "eligibility"], "RUN_STARTED payload");
    identifier(payload.repositoryId, "RUN_STARTED repositoryId");
    identifier(payload.runId, "RUN_STARTED runId");
    revision(payload.repositoryRevision, "RUN_STARTED repositoryRevision");
    if (!ORIGINS.has(payload.origin)) fail("ECANARY_INVALID", "RUN_STARTED origin is invalid");
    validateFacts(payload.facts, "RUN_STARTED facts");
    validateEligibility(payload.eligibility);
  } else if (op === "RUN_FINISHED") {
    exact(payload, ["repositoryId", "runId", "outcome"], "RUN_FINISHED payload");
    identifier(payload.repositoryId, "RUN_FINISHED repositoryId");
    identifier(payload.runId, "RUN_FINISHED runId");
    if (!CANARY_OUTCOMES.includes(payload.outcome)) fail("ECANARY_INVALID", "RUN_FINISHED outcome is invalid");
  } else if (op === "RISK_RECORDED") {
    exact(payload, ["repositoryId", "runId", "counts"], "RISK_RECORDED payload");
    identifier(payload.repositoryId, "RISK_RECORDED repositoryId");
    identifier(payload.runId, "RISK_RECORDED runId");
    exact(payload.counts, CANARY_RISK_KEYS, "RISK_RECORDED counts");
    for (const key of CANARY_RISK_KEYS) nonNegativeInteger(payload.counts[key], `RISK_RECORDED counts.${key}`, { nullable: true });
  } else if (op === "HOLD_CLASSIFIED") {
    exact(payload, ["repositoryId", "runId", "reasonCode"], "HOLD_CLASSIFIED payload");
    identifier(payload.repositoryId, "HOLD_CLASSIFIED repositoryId");
    identifier(payload.runId, "HOLD_CLASSIFIED runId");
    identifier(payload.reasonCode, "HOLD_CLASSIFIED reasonCode");
  } else if (op === "TOIL_RECORDED") {
    exact(payload, ["receiptId", "weekStart", "minutes"], "TOIL_RECORDED payload");
    identifier(payload.receiptId, "TOIL_RECORDED receiptId");
    timestamp(payload.weekStart, "TOIL_RECORDED weekStart");
    if (!isUtcMonday(payload.weekStart)) fail("ECANARY_INVALID", "TOIL_RECORDED weekStart must be Monday 00:00:00.000Z");
    nonNegativeInteger(payload.minutes, "TOIL_RECORDED minutes", { nullable: true });
  } else fail("ECANARY_INVALID", "Unsupported canary operation");
}

function eventRequest(event) {
  return {
    ledgerId: event.ledgerId,
    eventId: event.eventId,
    idempotencyKey: event.idempotencyKey,
    op: event.op,
    at: event.at,
    provenance: event.provenance,
    payload: event.payload
  };
}

export function validateCanaryLedgerEventV1(input) {
  const value = snapshot(input);
  exact(value, [
    "schemaVersion", "kind", "ledgerId", "eventId", "idempotencyKey", "requestDigest", "sequence",
    "previousEventDigest", "op", "at", "provenance", "payload", "eventDigest"
  ], "ledger event");
  if (value.schemaVersion !== 1 || value.kind !== CANARY_LEDGER_EVENT_KIND) fail("ECANARY_CORRUPT", "Ledger event version/kind is invalid");
  identifier(value.ledgerId, "event.ledgerId");
  identifier(value.eventId, "event.eventId");
  identifier(value.idempotencyKey, "event.idempotencyKey");
  digest(value.requestDigest, "event.requestDigest");
  nonNegativeInteger(value.sequence, "event.sequence");
  if (value.sequence < 1) fail("ECANARY_CORRUPT", "Event sequence must be positive");
  digest(value.previousEventDigest, "event.previousEventDigest");
  if (!EVENT_OPS.has(value.op)) fail("ECANARY_INVALID", "Event operation is invalid");
  timestamp(value.at, "event.at");
  validateProvenance(value.provenance);
  validatePayload(value.op, value.payload);
  const expectedRequestDigest = digestObject("CanaryLedgerRequestV1", eventRequest(value));
  if (value.requestDigest !== expectedRequestDigest) fail("ECANARY_CORRUPT", "Event request digest mismatch");
  const { eventDigest, ...body } = value;
  digest(eventDigest, "event.eventDigest");
  if (digestObject(CANARY_LEDGER_EVENT_KIND, body) !== eventDigest) fail("ECANARY_CORRUPT", "Event digest mismatch");
  return freeze(value);
}

function runKey(repositoryId, runId) {
  return `${repositoryId}\0${runId}`;
}

function weekStartMs(value) {
  const date = new Date(value);
  const days = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - days);
}

function weekStartIso(value) {
  return new Date(weekStartMs(value)).toISOString();
}

function isUtcMonday(value) {
  return weekStartIso(value) === value;
}

function windowWeekCount(window) {
  return Math.ceil((Date.parse(window.endsAt) - weekStartMs(window.startsAt)) / WEEK_MS);
}

function windowWeeks(window) {
  const count = windowWeekCount(window);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_EVENTS) fail("ECANARY_LIMIT", "Observation window exceeds the derived-week bound");
  const first = weekStartMs(window.startsAt);
  return Array.from({ length: count }, (_, index) => new Date(first + index * WEEK_MS).toISOString());
}

function isWindowWeek(window, weekStart) {
  const candidate = Date.parse(weekStart);
  return candidate >= weekStartMs(window.startsAt) && candidate < Date.parse(window.endsAt);
}

function applyTransition(state, event) {
  if (event.op === "REGISTER") {
    if (state.registration || event.sequence !== 1) fail("ECANARY_ORDER", "REGISTER must be the first and only registration event");
    const registration = validateCanaryRegistrationV1(event.payload.registration);
    if (registration.ledgerId !== event.ledgerId || event.at !== registration.registeredAt) fail("ECANARY_BINDING", "REGISTER event is not bound to its registration");
    state.registration = registration;
    state.ledgerId = registration.ledgerId;
    return;
  }
  const registration = state.registration;
  if (!registration) fail("ECANARY_ORDER", "Canary events require a preceding REGISTER event");
  if (event.ledgerId !== registration.ledgerId) fail("ECANARY_BINDING", "Event ledgerId drifted");
  if (event.op === "RUN_STARTED") {
    const payload = event.payload;
    if (payload.repositoryRevision !== registration.revision) fail("ECANARY_BINDING", "Run revision does not match registration");
    const at = Date.parse(event.at);
    if (at < Date.parse(registration.observationWindow.startsAt) || at >= Date.parse(registration.observationWindow.endsAt)) {
      fail("ECANARY_SCOPE", "Run start is outside the registered half-open window");
    }
    const key = runKey(payload.repositoryId, payload.runId);
    if (state.runs.has(key)) fail("ECANARY_RUN_CONFLICT", "Run identity was already started");
    const expected = classifyCanaryRunV1({ registration, origin: payload.origin, facts: payload.facts });
    if (canonicalJson(expected) !== canonicalJson(payload.eligibility)) fail("ECANARY_ELIGIBILITY", "Recorded run eligibility does not match the preregistered rules");
    state.runs.set(key, { start: event, finish: null, risk: null, hold: null });
  } else if (["RUN_FINISHED", "RISK_RECORDED", "HOLD_CLASSIFIED"].includes(event.op)) {
    const key = runKey(event.payload.repositoryId, event.payload.runId);
    const run = state.runs.get(key);
    if (!run) fail("ECANARY_ORDER", `${event.op} references a run that has not started`);
    if (Date.parse(event.at) < Date.parse(run.start.at)) fail("ECANARY_ORDER", `${event.op} precedes RUN_STARTED`);
    if (event.op === "RUN_FINISHED") {
      if (run.finish) fail("ECANARY_RUN_CONFLICT", "Run already has a terminal outcome");
      run.finish = event;
    } else if (event.op === "RISK_RECORDED") {
      if (run.risk) fail("ECANARY_RUN_CONFLICT", "Run already has a risk record");
      run.risk = event;
    } else {
      if (!run.finish || run.finish.payload.outcome !== "HOLD") fail("ECANARY_ORDER", "HOLD_CLASSIFIED requires a terminal HOLD outcome");
      if (run.hold) fail("ECANARY_RUN_CONFLICT", "Run HOLD was already classified");
      if (event.provenance.evidenceRefs.length === 0) fail("ECANARY_EVIDENCE", "HOLD classification requires evidence references");
      const reason = registration.holdReasons.find((item) => item.reasonCode === event.payload.reasonCode);
      if (!reason) fail("ECANARY_EVIDENCE", "HOLD classification reason was not preregistered");
      run.hold = event;
    }
  } else if (event.op === "TOIL_RECORDED") {
    if (!isWindowWeek(registration.observationWindow, event.payload.weekStart)) fail("ECANARY_SCOPE", "TOIL_RECORDED week is outside the registered window");
    if (state.toil.has(event.payload.receiptId)) fail("ECANARY_IDEMPOTENCY_CONFLICT", "Toil receipt ID was already recorded");
    state.toil.set(event.payload.receiptId, event);
  }
}

function normalizeExpectations(expectedHeadDigest, expectedEventCount) {
  const headPresent = expectedHeadDigest !== undefined;
  const countPresent = expectedEventCount !== undefined;
  if (headPresent !== countPresent) fail("ECANARY_EXPECTATION_REQUIRED", "Expected head and event count must be supplied together");
  if (!headPresent) return null;
  digest(expectedHeadDigest, "expectedHeadDigest");
  nonNegativeInteger(expectedEventCount, "expectedEventCount");
  return { expectedHeadDigest, expectedEventCount };
}

export function replayCanaryLedgerV1(input) {
  const value = snapshot(input);
  const allowed = ["events", "expectedHeadDigest", "expectedEventCount"].filter((key) => Object.hasOwn(value, key));
  exact(value, allowed, "replay input");
  if (!Array.isArray(value.events) || value.events.length === 0 || value.events.length > MAX_EVENTS) fail("ECANARY_CORRUPT", "Replay requires a bounded non-empty event array");
  const expectations = normalizeExpectations(value.expectedHeadDigest, value.expectedEventCount);
  const state = { registration: null, ledgerId: null, runs: new Map(), toil: new Map() };
  const eventIds = new Set();
  const idempotency = new Set();
  const events = [];
  let previous = ZERO_DIGEST;
  for (const [index, inputEvent] of value.events.entries()) {
    const event = validateCanaryLedgerEventV1(inputEvent);
    if (event.sequence !== index + 1 || event.previousEventDigest !== previous) fail("ECANARY_CORRUPT", "Ledger sequence or previous digest is not contiguous");
    if (eventIds.has(event.eventId)) fail("ECANARY_CORRUPT", "Ledger contains a duplicate eventId");
    if (idempotency.has(event.idempotencyKey)) fail("ECANARY_CORRUPT", "Ledger contains a duplicate idempotencyKey");
    eventIds.add(event.eventId);
    idempotency.add(event.idempotencyKey);
    applyTransition(state, event);
    events.push(event);
    previous = event.eventDigest;
  }
  if (!state.registration) fail("ECANARY_CORRUPT", "Ledger has no registration");
  if (expectations && (expectations.expectedEventCount !== events.length || expectations.expectedHeadDigest !== previous)) {
    fail("ECANARY_REPLAY_EXPECTATION_MISMATCH", "Ledger does not match the independently supplied expected head/count");
  }
  const runs = [...state.runs.values()].map((run) => ({ start: run.start, finish: run.finish, risk: run.risk, hold: run.hold }));
  return freeze({
    schemaVersion: 1,
    kind: "CanaryLedgerReplayV1",
    ledgerId: state.ledgerId,
    eventCount: events.length,
    headDigest: previous,
    journalCompleteness: expectations ? "VERIFIED" : "UNVERIFIED",
    registration: state.registration,
    events,
    runs,
    toilRecords: [...state.toil.values()]
  });
}

function reportReplay(input, expectedHeadDigest, expectedEventCount) {
  if (!input || input.kind !== "CanaryLedgerReplayV1" || !Array.isArray(input.events)) fail("ECANARY_INVALID", "Report requires a replay result");
  const replayInput = { events: input.events };
  if (expectedHeadDigest !== undefined) replayInput.expectedHeadDigest = expectedHeadDigest;
  if (expectedEventCount !== undefined) replayInput.expectedEventCount = expectedEventCount;
  return replayCanaryLedgerV1(replayInput);
}

function sealedReport(body) {
  const report = { ...body, reportDigest: digestObject(CANARY_REPORT_KIND, body) };
  return freeze(report);
}

export function evaluateCanaryReportV1(input) {
  const value = snapshot(input);
  const allowed = ["replay", "asOf", "expectedHeadDigest", "expectedEventCount"].filter((key) => Object.hasOwn(value, key));
  exact(value, allowed, "report input");
  const replay = reportReplay(value.replay, value.expectedHeadDigest, value.expectedEventCount);
  const asOf = timestamp(value.asOf, "report.asOf");
  const registration = replay.registration;
  const included = replay.runs.filter(({ start }) => start.payload.origin === "NATURAL" && !["EXCLUDED", "OUT_OF_SCOPE"].includes(start.payload.eligibility.decision));
  const eligible = included.filter(({ start }) => start.payload.eligibility.decision === "ELIGIBLE");
  const excluded = replay.runs.filter(({ start }) => start.payload.origin === "NATURAL" && ["EXCLUDED", "OUT_OF_SCOPE"].includes(start.payload.eligibility.decision));
  const synthetic = replay.runs.filter(({ start }) => start.payload.origin === "SYNTHETIC_FIXTURE");
  const statusCounts = Object.fromEntries([...CANARY_OUTCOMES, "UNFINISHED"].map((status) => [status, 0]));
  for (const run of included) statusCounts[run.finish?.payload.outcome ?? "UNFINISHED"]++;

  const riskCounters = {};
  for (const key of CANARY_RISK_KEYS) {
    let lowerBound = 0;
    let exactValue = replay.journalCompleteness === "VERIFIED";
    for (const run of [...replay.runs]) {
      const valueAtKey = run.risk?.payload.counts[key];
      if (valueAtKey === undefined || valueAtKey === null) {
        if (run.start.payload.origin === "NATURAL") exactValue = false;
      } else lowerBound = addSafeInteger(lowerBound, valueAtKey, `risk counter ${key}`);
    }
    riskCounters[key] = { observedLowerBound: lowerBound, exact: exactValue ? lowerBound : null };
  }

  const holdReasons = new Map(registration.holdReasons.map((reason) => [reason.reasonCode, reason]));
  const holdRuns = included.filter((run) => run.finish?.payload.outcome === "HOLD");
  let avoidable = 0;
  let holdExact = true;
  for (const run of holdRuns) {
    const classification = run.hold ? holdReasons.get(run.hold.payload.reasonCode)?.classification : null;
    if (!classification || classification === "UNKNOWN") holdExact = false;
    if (classification === "AVOIDABLE") avoidable++;
  }
  const avoidableRate = included.length > 0 && holdExact ? avoidable / included.length : null;

  const toilByWeek = new Map(windowWeeks(registration.observationWindow).map((weekStart) => [weekStart, []]));
  for (const event of replay.toilRecords) toilByWeek.get(event.payload.weekStart)?.push(event.payload.minutes);
  const weeklyToil = [...toilByWeek.entries()].map(([weekStart, values]) => {
    const observedLowerBound = values
      .filter((item) => item !== null)
      .reduce((sum, item) => addSafeInteger(sum, item, `weekly toil ${weekStart}`), 0);
    const exactValue = values.length > 0 && values.every((item) => item !== null) ? observedLowerBound : null;
    return { weekStart, observedLowerBound, exact: exactValue };
  });

  const blockers = [];
  const nonzeroRisks = CANARY_RISK_KEYS.filter((key) => riskCounters[key].observedLowerBound > 0);
  const unknownEligibility = included.filter(({ start }) => start.payload.eligibility.decision === "UNKNOWN").map(({ start }) => runKey(start.payload.repositoryId, start.payload.runId));
  const unknownOutcomes = included.filter((run) => !run.finish || run.finish.payload.outcome === "UNKNOWN").map(({ start }) => runKey(start.payload.repositoryId, start.payload.runId));
  const unknownRiskKeys = CANARY_RISK_KEYS.filter((key) => riskCounters[key].exact === null);
  const unknownToilWeeks = weeklyToil.filter((week) => week.exact === null).map((week) => week.weekStart);
  if (replay.journalCompleteness !== "VERIFIED") blockers.push("journal-completeness-unverified");
  blockers.push(...unknownEligibility.map((key) => `eligibility-unknown:${key}`));
  blockers.push(...unknownOutcomes.map((key) => `outcome-unknown:${key}`));
  blockers.push(...unknownRiskKeys.map((key) => `risk-unknown:${key}`));
  if (!holdExact) blockers.push("hold-classification-unknown");
  blockers.push(...unknownToilWeeks.map((week) => `toil-unknown:${week}`));

  let toilStop = false;
  for (let index = 1; index < weeklyToil.length; index++) {
    if (weeklyToil[index - 1].observedLowerBound > FIXED_THRESHOLDS.weeklyToilStopMinutes &&
        weeklyToil[index].observedLowerBound > FIXED_THRESHOLDS.weeklyToilStopMinutes) toilStop = true;
  }
  const windowMs = Date.parse(registration.observationWindow.endsAt) - Date.parse(registration.observationWindow.startsAt);
  const windowEnded = asOf >= Date.parse(registration.observationWindow.endsAt);
  const repositories = new Set(eligible.map(({ start }) => start.payload.repositoryId));
  const sufficientCounts = windowMs >= FIXED_THRESHOLDS.minimumDurationDays * DAY_MS &&
    eligible.length >= FIXED_THRESHOLDS.minimumEligibleRuns && repositories.size >= FIXED_THRESHOLDS.minimumRepositories && included.length > 0;
  const thresholdBreach = avoidableRate !== null && avoidableRate > FIXED_THRESHOLDS.maximumAvoidableHoldRate ||
    weeklyToil.some((week) => week.exact !== null && week.exact > FIXED_THRESHOLDS.weeklyToilTargetMinutes);
  const finalUnknown = unknownEligibility.length > 0 || unknownOutcomes.length > 0 || unknownRiskKeys.length > 0 || !holdExact || unknownToilWeeks.length > 0;

  const assessment = nonzeroRisks.length > 0 || toilStop ? "STOP_EXPANSION_OBSERVED"
    : replay.journalCompleteness !== "VERIFIED" ? "HOLD_INCONCLUSIVE"
      : !windowEnded ? "CONTINUE_OBSERVING"
        : finalUnknown ? "HOLD_INCONCLUSIVE"
          : !sufficientCounts ? "HOLD_INSUFFICIENT"
            : thresholdBreach ? "HOLD_THRESHOLD_BREACH" : "OBSERVED_CRITERIA_MET";
  return sealedReport({
    schemaVersion: 1,
    kind: CANARY_REPORT_KIND,
    ledgerId: registration.ledgerId,
    registrationDigest: registration.registrationDigest,
    headDigest: replay.headDigest,
    eventCount: replay.eventCount,
    asOf: value.asOf,
    assessment,
    actionAuthority: "NONE",
    journalCompleteness: replay.journalCompleteness,
    denominator: {
      includedNaturalStarts: included.length,
      eligibleNaturalStarts: eligible.length,
      eligibilityUnknown: unknownEligibility.length,
      repositories: repositories.size,
      excludedNaturalStarts: excluded.length,
      syntheticStarts: synthetic.length
    },
    statusCounts,
    exclusions: excluded.map(({ start }) => ({
      repositoryId: start.payload.repositoryId,
      runId: start.payload.runId,
      decision: start.payload.eligibility.decision,
      ruleIds: start.payload.eligibility.matchedExclusionRuleIds
    })),
    riskCounters,
    holdMetrics: {
      holds: holdRuns.length,
      avoidableObserved: avoidable,
      classificationComplete: holdExact,
      avoidableRate
    },
    weeklyToil,
    sufficiency: {
      windowEnded,
      windowDurationDays: windowMs / DAY_MS,
      minimumDurationMet: windowMs >= FIXED_THRESHOLDS.minimumDurationDays * DAY_MS,
      minimumRunsMet: eligible.length >= FIXED_THRESHOLDS.minimumEligibleRuns,
      minimumRepositoriesMet: repositories.size >= FIXED_THRESHOLDS.minimumRepositories,
      zeroDenominator: included.length === 0,
      observedZeroRiskIsProof: false
    },
    blockers: [...new Set(blockers)].sort(),
    accepted: false,
    effectAuthorized: false
  });
}

export function verifyCanaryReportV1(input) {
  const value = snapshot(input);
  exact(value, ["events", "expectedHeadDigest", "expectedEventCount", "asOf", "report"], "report replay input");
  const replay = replayCanaryLedgerV1({
    events: value.events,
    expectedHeadDigest: value.expectedHeadDigest,
    expectedEventCount: value.expectedEventCount
  });
  const report = evaluateCanaryReportV1({
    replay,
    expectedHeadDigest: value.expectedHeadDigest,
    expectedEventCount: value.expectedEventCount,
    asOf: value.asOf
  });
  try {
    assert.deepEqual(value.report, snapshot(report));
  } catch (error) {
    fail("ECANARY_REPORT_MISMATCH", "Canary report replay mismatch", { cause: error });
  }
  return report;
}

function validateRequest(input) {
  const value = snapshot(input);
  exact(value, ["ledgerId", "eventId", "idempotencyKey", "op", "at", "provenance", "payload"], "append request");
  identifier(value.ledgerId, "request.ledgerId");
  identifier(value.eventId, "request.eventId");
  identifier(value.idempotencyKey, "request.idempotencyKey");
  if (!EVENT_OPS.has(value.op)) fail("ECANARY_INVALID", "Append request operation is invalid");
  timestamp(value.at, "request.at");
  validateProvenance(value.provenance);
  validatePayload(value.op, value.payload);
  return value;
}

async function safeJournalPath(input) {
  if (typeof input !== "string" || !path.isAbsolute(input)) fail("ECANARY_PATH", "Journal path must be absolute");
  const parent = await realpath(path.dirname(input));
  const name = path.basename(input);
  if (!name || name === "." || name === "..") fail("ECANARY_PATH", "Journal filename is invalid");
  return path.join(parent, name);
}

async function readEvents(journalPath, { missingAllowed = false } = {}) {
  let info;
  try {
    info = await lstat(journalPath);
  } catch (error) {
    if (error.code === "ENOENT" && missingAllowed) return [];
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) fail("ECANARY_PATH", "Journal must be a regular single-link file");
  if ((info.mode & 0o777) !== 0o600) fail("ECANARY_PATH", "Journal mode must be 0600");
  if (info.size > MAX_BYTES) fail("ECANARY_LIMIT", "Journal exceeds its byte bound");
  const bytes = await readFile(journalPath);
  if (bytes.length === 0) {
    if (missingAllowed) return [];
    fail("ECANARY_CORRUPT", "Journal is empty");
  }
  if (bytes.at(-1) !== 0x0a) fail("ECANARY_CORRUPT", "Journal has a partial tail");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    fail("ECANARY_CORRUPT", "Journal is not valid canonical UTF-8", { cause: error });
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > MAX_EVENTS) fail("ECANARY_LIMIT", "Journal exceeds its event bound");
  return lines.map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      fail("ECANARY_CORRUPT", `Journal line ${index + 1} is not JSON`, { cause: error });
    }
    if (canonicalJson(parsed) !== line) fail("ECANARY_CORRUPT", `Journal line ${index + 1} is not canonical JSON`);
    return parsed;
  });
}

async function withJournalLock(journalPath, timeoutMs, callback) {
  nonNegativeInteger(timeoutMs, "lockTimeoutMs");
  if (timeoutMs > MAX_LOCK_TIMEOUT_MS) fail("ECANARY_LIMIT", `lockTimeoutMs must not exceed ${MAX_LOCK_TIMEOUT_MS}`);
  const lockPath = `${journalPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) fail("ECANARY_LOCK_TIMEOUT", "Journal lock could not be acquired within the bounded timeout", { status: "HOLD" });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  try {
    return await callback();
  } finally {
    try {
      await handle.close();
    } catch (error) {
      fail("ECANARY_LOCK_RELEASE_UNKNOWN", "Journal lock handle close could not be reconciled", { status: "UNKNOWN", cause: error });
    }
    try {
      await unlink(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") fail("ECANARY_LOCK_RELEASE_UNKNOWN", "Journal lock removal could not be reconciled", { status: "UNKNOWN", cause: error });
    }
  }
}

async function appendLine(journalPath, line) {
  const flags = FS_CONSTANTS.O_APPEND | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_WRONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(journalPath, flags, 0o600);
    await handle.chmod(0o600);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) fail("ECANARY_PATH", "Journal must remain a regular single-link file");
    await handle.write(line, null, "utf8");
    await handle.sync();
    // The first append may have created the journal. Request a directory-entry
    // sync before success; this does not prove physical-media persistence.
    const parent = await open(path.dirname(journalPath), FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    if (error instanceof CanaryLedgerError) throw error;
    fail("ECANARY_APPEND_UNKNOWN", "Journal append outcome is unknown", { status: "UNKNOWN", cause: error });
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        fail("ECANARY_APPEND_UNKNOWN", "Journal append handle close is unknown", { status: "UNKNOWN", cause: error });
      }
    }
  }
}

function buildEvent(request, sequence, previousEventDigest) {
  const body = {
    schemaVersion: 1,
    kind: CANARY_LEDGER_EVENT_KIND,
    ledgerId: request.ledgerId,
    eventId: request.eventId,
    idempotencyKey: request.idempotencyKey,
    requestDigest: digestObject("CanaryLedgerRequestV1", request),
    sequence,
    previousEventDigest,
    op: request.op,
    at: request.at,
    provenance: request.provenance,
    payload: request.payload
  };
  return freeze({ ...body, eventDigest: digestObject(CANARY_LEDGER_EVENT_KIND, body) });
}

export async function appendCanaryEventV1(input) {
  const value = snapshot(input);
  const allowed = ["journalPath", "request", "expectedHeadDigest", "expectedEventCount", "lockTimeoutMs"].filter((key) => Object.hasOwn(value, key));
  exact(value, allowed, "append input");
  const journalPath = await safeJournalPath(value.journalPath);
  const request = validateRequest(value.request);
  const expectations = normalizeExpectations(value.expectedHeadDigest, value.expectedEventCount);
  const timeoutMs = value.lockTimeoutMs ?? 2_000;
  return withJournalLock(journalPath, timeoutMs, async () => {
    const events = await readEvents(journalPath, { missingAllowed: true });
    let replay = null;
    if (events.length > 0) replay = replayCanaryLedgerV1({ events });
    const headDigest = replay?.headDigest ?? ZERO_DIGEST;
    const requestDigest = digestObject("CanaryLedgerRequestV1", request);
    const prior = events.find((event) => event.idempotencyKey === request.idempotencyKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest) fail("ECANARY_IDEMPOTENCY_CONFLICT", "Idempotency key is bound to a different request");
      return freeze({ appended: false, idempotent: true, event: prior, eventCount: events.length, headDigest });
    }
    if (expectations && (expectations.expectedHeadDigest !== headDigest || expectations.expectedEventCount !== events.length)) {
      fail("ECANARY_REPLAY_EXPECTATION_MISMATCH", "Journal changed from the caller's expected head/count");
    }
    if (events.some((event) => event.eventId === request.eventId)) fail("ECANARY_EVENT_CONFLICT", "Event ID is already bound to a different request");
    const event = buildEvent(request, events.length + 1, headDigest);
    replayCanaryLedgerV1({ events: [...events, event] });
    const eventLine = `${canonicalJson(event)}\n`;
    const currentBytes = events.reduce((total, item) => total + Buffer.byteLength(`${canonicalJson(item)}\n`), 0);
    if (currentBytes + Buffer.byteLength(eventLine) > MAX_BYTES) fail("ECANARY_LIMIT", "Journal append would exceed its byte bound");
    await appendLine(journalPath, eventLine);
    let written;
    let verified;
    try {
      written = await readEvents(journalPath);
      verified = replayCanaryLedgerV1({ events: written });
    } catch (error) {
      // The append and fsync already returned. A failed readback cannot prove
      // whether the intended start is now the durable journal head.
      fail("ECANARY_APPEND_UNKNOWN", "Journal append readback could not be reconciled", { status: "UNKNOWN", cause: error });
    }
    if (written.length !== events.length + 1 || verified.headDigest !== event.eventDigest) {
      fail("ECANARY_APPEND_UNKNOWN", "Journal append could not be reconciled to the intended event", { status: "UNKNOWN" });
    }
    return freeze({ appended: true, idempotent: false, event, eventCount: written.length, headDigest: verified.headDigest });
  });
}

export async function readCanaryLedgerV1(input) {
  const value = snapshot(input);
  const allowed = ["journalPath", "expectedHeadDigest", "expectedEventCount"].filter((key) => Object.hasOwn(value, key));
  exact(value, allowed, "journal read input");
  const journalPath = await safeJournalPath(value.journalPath);
  const events = await readEvents(journalPath);
  const replayInput = { events };
  if (Object.hasOwn(value, "expectedHeadDigest")) replayInput.expectedHeadDigest = value.expectedHeadDigest;
  if (Object.hasOwn(value, "expectedEventCount")) replayInput.expectedEventCount = value.expectedEventCount;
  return replayCanaryLedgerV1(replayInput);
}
