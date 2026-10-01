// SPDX-License-Identifier: AGPL-3.0-only
// This reducer accepts only JSON-parsed or otherwise trusted plain data. A
// JavaScript Proxy can run traps during structural inspection and is outside
// this pure-data boundary. Persistence, provider verification, and release
// authority must be supplied by separate trusted adapters.
import { createHash } from "node:crypto";

export const W5_PUBLICATION_OPERATION_KIND = "W5PublicationOperationEventV1";
export const W5_PUBLICATION_STAGES = Object.freeze([
  "prepared",
  "sourcepublished",
  "remotechecks",
  "tagcreated",
  "released",
  "readback",
  "cleanup"
]);
export const W5_STABLE_ADMISSION_UNAVAILABLE = "V5_STABLE_ADMISSION_UNAVAILABLE";

const OPS = new Set(["PREPARE", "EFFECT_INTENT", "EFFECT_RESULT", "EFFECT_RECONCILE"]);
const OUTCOMES = new Set(["SUCCEEDED", "NOT_APPLIED", "UNKNOWN"]);
const DIGEST = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
const ZERO_DIGEST = "0".repeat(64);
const MAX_EVENTS = 256;
const MAX_NODES = 50_000;
const MAX_DEPTH = 16;
const MAX_STRING = 4096;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ATTEMPTS_PER_STAGE = 16;

export class W5PublicationOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "W5PublicationOperationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new W5PublicationOperationError(code, message);
}

// Copy plain JSON data without invoking accessors or toJSON methods.
function snapshot(value) {
  let nodes = 0;
  const active = new Set();
  function copy(item, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail("EW5_LIMIT", "Operation input exceeds structural bounds");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("EW5_INVALID", "Operation numbers must be finite");
      return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item === "string") {
      if (item.length > MAX_STRING) fail("EW5_LIMIT", "Operation string is too large");
      return item;
    }
    if (!item || typeof item !== "object") fail("EW5_INVALID", "Operation input must contain JSON data only");
    if (active.has(item)) fail("EW5_INVALID", "Operation input cannot contain cycles");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      fail("EW5_INVALID", "Operation input must contain plain objects or arrays");
    }
    if (Object.getOwnPropertySymbols(item).length > 0) fail("EW5_INVALID", "Operation input cannot contain symbol fields");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    active.add(item);
    let result;
    if (array) {
      if (item.length > MAX_EVENTS || Object.keys(descriptors).length !== item.length + 1) {
        fail("EW5_LIMIT", "Operation array is too large, sparse, or decorated");
      }
      result = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          fail("EW5_INVALID", "Operation array contains an accessor or hole");
        }
        result.push(copy(descriptor.value, depth + 1));
      }
    } else {
      if (Object.keys(descriptors).length > 64) fail("EW5_LIMIT", "Operation object has too many fields");
      result = {};
      for (const key of Object.keys(descriptors).sort()) {
        if (["__proto__", "constructor", "prototype"].includes(key)) fail("EW5_INVALID", "Unsafe operation field");
        const descriptor = descriptors[key];
        if (!("value" in descriptor) || !descriptor.enumerable) fail("EW5_INVALID", "Operation input cannot contain accessors or hidden fields");
        result[key] = copy(descriptor.value, depth + 1);
      }
    }
    active.delete(item);
    return result;
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) fail("EW5_LIMIT", "Operation input exceeds the byte bound");
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
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("EW5_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("EW5_INVALID", `${label} has unexpected or missing fields`);
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("EW5_INVALID", `${label} is invalid`);
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("EW5_INVALID", `${label} must be a lowercase SHA-256 digest`);
}

function publicationRef(value, prefix, label) {
  const name = typeof value === "string" && value.startsWith(prefix) ? value.slice(prefix.length) : "";
  // A bounded Git ref subset permits ordinary release metadata while keeping
  // provider endpoint construction independent of Git's full ref grammar.
  if (!name || name === "@" || name.length > 200 || !/^[A-Za-z0-9_+@][A-Za-z0-9._/+@-]*$/.test(name) ||
      name.endsWith("/") || name.endsWith(".") || name.includes("//") || name.includes("..") ||
      name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
    fail("EW5_INVALID", `${label} must be a canonical ${prefix} ref`);
  }
}

function validatePayload(op, payload) {
  if (op === "PREPARE") {
    exact(payload, ["candidate", "target", "grantDigest"], "prepare payload");
    exact(payload.candidate, ["commitSha", "manifestDigest", "snapshotDigest", "exportDigest"], "candidate binding");
    if (typeof payload.candidate.commitSha !== "string" || !COMMIT_SHA.test(payload.candidate.commitSha)) {
      fail("EW5_INVALID", "candidate commitSha must be an exact lowercase 40-character SHA");
    }
    for (const key of ["manifestDigest", "snapshotDigest", "exportDigest"]) digest(payload.candidate[key], `candidate.${key}`);
    exact(payload.target, [
      "provider", "repositoryId", "repository", "workflowPath", "sourceRef", "tagRef", "siteIdentityDigest"
    ], "target binding");
    if (payload.target.provider !== "github") fail("EW5_INVALID", "target provider must be github");
    if (!Number.isSafeInteger(payload.target.repositoryId) || payload.target.repositoryId <= 0) {
      fail("EW5_INVALID", "target repositoryId must be a positive numeric repository ID");
    }
    if (typeof payload.target.repository !== "string" || !REPOSITORY.test(payload.target.repository) ||
        payload.target.repository.split("/").some((part) => part === "." || part === "..")) {
      fail("EW5_INVALID", "target repository must be a canonical owner/name");
    }
    if (typeof payload.target.workflowPath !== "string" || !WORKFLOW_PATH.test(payload.target.workflowPath)) {
      fail("EW5_INVALID", "target workflowPath must be a canonical workflow path");
    }
    publicationRef(payload.target.sourceRef, "refs/heads/", "target.sourceRef");
    publicationRef(payload.target.tagRef, "refs/tags/", "target.tagRef");
    digest(payload.target.siteIdentityDigest, "target.siteIdentityDigest");
    digest(payload.grantDigest, "grantDigest");
    return;
  }
  if (op === "EFFECT_INTENT") {
    exact(payload, ["step", "attemptId", "bindingDigest"], "effect intent payload");
    if (!W5_PUBLICATION_STAGES.slice(1).includes(payload.step)) fail("EW5_INVALID", "effect intent step is invalid");
    identifier(payload.attemptId, "attemptId");
    digest(payload.bindingDigest, "bindingDigest");
    return;
  }
  if (op === "EFFECT_RESULT" || op === "EFFECT_RECONCILE") {
    exact(payload, ["step", "attemptId", "outcome", "evidenceDigest", "bindingDigest"], `${op} payload`);
    if (!W5_PUBLICATION_STAGES.slice(1).includes(payload.step)) fail("EW5_INVALID", `${op} step is invalid`);
    identifier(payload.attemptId, "attemptId");
    if (!OUTCOMES.has(payload.outcome)) fail("EW5_INVALID", `${op} outcome is invalid`);
    digest(payload.evidenceDigest, "evidenceDigest");
    digest(payload.bindingDigest, "bindingDigest");
    return;
  }
  fail("EW5_INVALID", "Operation event type is invalid");
}

function normalizeRequest(input) {
  const request = snapshot(input);
  exact(request, ["operationId", "eventId", "op", "payload"], "operation request");
  identifier(request.operationId, "operationId");
  identifier(request.eventId, "eventId");
  if (!OPS.has(request.op)) fail("EW5_INVALID", "Operation event type is invalid");
  validatePayload(request.op, request.payload);
  return request;
}

function requestDigest(request) {
  return digestObject("W5PublicationOperationRequestV1", request);
}

function eventRequest(event) {
  return { operationId: event.operationId, eventId: event.eventId, op: event.op, payload: event.payload };
}

export function validateW5PublicationOperationEventV1(input) {
  const event = snapshot(input);
  exact(event, [
    "schemaVersion", "kind", "operationId", "eventId", "requestDigest", "sequence",
    "previousEventDigest", "op", "payload", "eventDigest"
  ], "operation event");
  if (event.schemaVersion !== 1 || event.kind !== W5_PUBLICATION_OPERATION_KIND) fail("EW5_CORRUPT", "Operation event version or kind is invalid");
  identifier(event.operationId, "event.operationId");
  identifier(event.eventId, "event.eventId");
  digest(event.requestDigest, "event.requestDigest");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) fail("EW5_CORRUPT", "Operation event sequence must be a positive safe integer");
  digest(event.previousEventDigest, "event.previousEventDigest");
  if (!OPS.has(event.op)) fail("EW5_INVALID", "Operation event type is invalid");
  validatePayload(event.op, event.payload);
  if (event.requestDigest !== requestDigest(normalizeRequest(eventRequest(event)))) fail("EW5_CORRUPT", "Operation request digest mismatch");
  const { eventDigest, ...body } = event;
  digest(eventDigest, "event.eventDigest");
  if (digestObject(W5_PUBLICATION_OPERATION_KIND, body) !== eventDigest) fail("EW5_CORRUPT", "Operation event digest mismatch");
  return freeze(event);
}

function nextStage(stage) {
  const index = W5_PUBLICATION_STAGES.indexOf(stage);
  return index >= 0 ? W5_PUBLICATION_STAGES[index + 1] ?? null : null;
}

function requirePending(state, payload, status, label) {
  if (!state.pending || state.pending.status !== status || state.pending.step !== payload.step || state.pending.attemptId !== payload.attemptId) {
    fail("EW5_ORDER", `${label} must bind to the current operation and attempt`);
  }
}

function applyTransition(state, event) {
  if (event.op === "PREPARE") {
    if (state.binding || event.sequence !== 1) fail("EW5_ORDER", "PREPARE must be the first and only binding event");
    state.operationId = event.operationId;
    state.binding = event.payload;
    state.bindingDigest = digestObject("W5PublicationBindingV1", event.payload);
    state.stage = "prepared";
    return;
  }
  if (!state.binding) fail("EW5_ORDER", "Publication events require a preceding PREPARE");
  if (event.operationId !== state.operationId) fail("EW5_BINDING", "Operation ID changed during replay");
  const payload = event.payload;
  if (payload.bindingDigest !== state.bindingDigest) fail("EW5_BINDING", "Candidate or target binding changed during replay");
  if (event.op === "EFFECT_INTENT") {
    const expected = nextStage(state.stage);
    if (!expected || payload.step !== expected || state.pending) fail("EW5_ORDER", "Effect intent is not for the next unblocked stage");
    if (state.attemptIds.has(payload.attemptId)) fail("EW5_ATTEMPT_CONFLICT", "Attempt ID was already used by this operation");
    const count = state.attemptsByStage.get(payload.step) ?? 0;
    if (count >= MAX_ATTEMPTS_PER_STAGE) fail("EW5_LIMIT", "Stage attempt limit was reached");
    state.attemptIds.add(payload.attemptId);
    state.attemptsByStage.set(payload.step, count + 1);
    state.pending = { step: payload.step, attemptId: payload.attemptId, status: "INTENT" };
    return;
  }
  if (event.op === "EFFECT_RESULT") {
    requirePending(state, payload, "INTENT", "Effect result");
  } else if (event.op === "EFFECT_RECONCILE") {
    requirePending(state, payload, "UNKNOWN", "Reconciliation");
  }
  if (payload.outcome === "UNKNOWN") {
    state.pending = { ...state.pending, status: "UNKNOWN" };
    return;
  }
  if (payload.outcome === "SUCCEEDED") {
    state.stage = payload.step;
  }
  // NOT_APPLIED closes this attempt without advancing the stage. A later
  // attempt must use a new attemptId and begin with another intent event.
  state.pending = null;
}

function normalizeExpectations(input, required) {
  const headPresent = Object.hasOwn(input, "expectedHeadDigest");
  const countPresent = Object.hasOwn(input, "expectedEventCount");
  if (headPresent !== countPresent || (required && !headPresent)) fail("EW5_CAS_REQUIRED", "Expected head digest and event count must be supplied together");
  if (!headPresent) return null;
  digest(input.expectedHeadDigest, "expectedHeadDigest");
  if (!Number.isSafeInteger(input.expectedEventCount) || input.expectedEventCount < 0) fail("EW5_INVALID", "expectedEventCount must be a non-negative safe integer");
  return { expectedHeadDigest: input.expectedHeadDigest, expectedEventCount: input.expectedEventCount };
}

export function replayW5PublicationOperationV1(input) {
  const value = snapshot(input);
  const allowed = ["events", "expectedHeadDigest", "expectedEventCount"].filter((key) => Object.hasOwn(value, key));
  exact(value, allowed, "replay input");
  if (!Array.isArray(value.events) || value.events.length > MAX_EVENTS) fail("EW5_LIMIT", "Replay event list exceeds its bound");
  const expectations = normalizeExpectations(value, false);
  const state = {
    operationId: null,
    binding: null,
    bindingDigest: null,
    stage: null,
    pending: null,
    attemptIds: new Set(),
    attemptsByStage: new Map()
  };
  const eventIds = new Set();
  let previous = ZERO_DIGEST;
  const events = [];
  for (const [index, inputEvent] of value.events.entries()) {
    const event = validateW5PublicationOperationEventV1(inputEvent);
    if (event.sequence !== index + 1 || event.previousEventDigest !== previous) fail("EW5_CORRUPT", "Event sequence or previous digest is not contiguous");
    if (eventIds.has(event.eventId)) fail("EW5_CORRUPT", "Operation contains a duplicate eventId");
    eventIds.add(event.eventId);
    if (index === 0 && event.op !== "PREPARE") fail("EW5_ORDER", "PREPARE must be the first operation event");
    if (index > 0 && event.op === "PREPARE") fail("EW5_ORDER", "Operation can contain only one PREPARE event");
    applyTransition(state, event);
    events.push(event);
    previous = event.eventDigest;
  }
  if (expectations && (expectations.expectedEventCount !== events.length || expectations.expectedHeadDigest !== previous)) {
    fail("EW5_CAS_MISMATCH", "Operation does not match the expected head digest and event count");
  }
  const operationStatus = !state.binding
    ? "UNPREPARED"
    : state.pending?.status === "UNKNOWN"
      ? "UNKNOWN"
      : state.pending
        ? "INTENT_PENDING"
        : state.stage === "cleanup"
          ? "COMPLETE"
          : "READY";
  return freeze({
    schemaVersion: 1,
    kind: "W5PublicationOperationReplayV1",
    operationId: state.operationId,
    binding: state.binding,
    bindingDigest: state.bindingDigest,
    stage: state.stage,
    operationStatus,
    pending: state.pending,
    eventCount: events.length,
    headDigest: previous,
    journalCompleteness: "UNVERIFIED",
    expectationStatus: expectations ? "LOCAL_MATCH" : "NOT_PROVIDED",
    inputTrustBoundary: "CALLER_ASSERTED",
    providerAuthenticity: "NOT_VERIFIED",
    stableAdmission: W5_STABLE_ADMISSION_UNAVAILABLE,
    releaseEligible: false
  });
}

function buildEvent(request, sequence, previousEventDigest) {
  const body = {
    schemaVersion: 1,
    kind: W5_PUBLICATION_OPERATION_KIND,
    operationId: request.operationId,
    eventId: request.eventId,
    requestDigest: requestDigest(request),
    sequence,
    previousEventDigest,
    op: request.op,
    payload: request.payload
  };
  return freeze({ ...body, eventDigest: digestObject(W5_PUBLICATION_OPERATION_KIND, body) });
}

// Pure append proposal with compare-and-swap. Persistence and any provider
// dispatch remain the caller's responsibility and are not claimed here.
export function appendW5PublicationOperationEventV1(input) {
  const value = snapshot(input);
  const expectedKeys = ["expectedHeadDigest", "expectedEventCount"].filter((key) => Object.hasOwn(value, key));
  exact(value, ["events", "request", ...expectedKeys], "append input");
  if (!Array.isArray(value.events) || value.events.length > MAX_EVENTS) fail("EW5_LIMIT", "Append event list exceeds its bound");
  const expectations = normalizeExpectations(value, true);
  const request = normalizeRequest(value.request);
  const prior = replayW5PublicationOperationV1({ events: value.events });
  if (expectations.expectedHeadDigest !== prior.headDigest || expectations.expectedEventCount !== prior.eventCount) {
    fail("EW5_CAS_MISMATCH", "Operation changed from the caller's expected head digest and event count");
  }
  const duplicate = value.events.find((event) => event.eventId === request.eventId);
  if (duplicate) {
    const checked = validateW5PublicationOperationEventV1(duplicate);
    if (checked.requestDigest !== requestDigest(request)) fail("EW5_EVENT_CONFLICT", "eventId is already bound to a different request");
    return freeze({ appended: false, idempotent: true, event: checked, events: value.events, replay: prior });
  }
  if (value.events.length >= MAX_EVENTS) fail("EW5_LIMIT", "Operation event limit was reached");
  const event = buildEvent(request, value.events.length + 1, prior.headDigest);
  const events = [...value.events, event];
  const replay = replayW5PublicationOperationV1({ events });
  return freeze({ appended: true, idempotent: false, event, events, replay });
}
