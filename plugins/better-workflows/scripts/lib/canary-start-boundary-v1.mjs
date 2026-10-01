// SPDX-License-Identifier: AGPL-3.0-only
// A local start-before-dispatch primitive. It does not authenticate a launcher,
// independently bind the caller-supplied cohort/routes, attest source-stream
// completeness, or grant canary/release acceptance.
import { createHash } from "node:crypto";
import {
  appendCanaryEventV1,
  classifyCanaryRunV1,
  readCanaryLedgerV1
} from "./canary-ledger-v1.mjs";
import { validateCanaryCohortV1 } from "./canary-cohort-v1.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION = /^[a-f0-9]{40,64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const FACT_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class CanaryStartBoundaryError extends Error {
  constructor(code, message, status = "HOLD", options) {
    super(message, options);
    this.name = "CanaryStartBoundaryError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new CanaryStartBoundaryError(code, message, status);
}

function record(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail("ECANARY_START_INVALID", `${label} must be a plain record`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) {
    fail("ECANARY_START_INVALID", `${label} has unexpected or missing fields`);
  }
  const result = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("ECANARY_START_INVALID", `${label}.${key} must be an enumerable data field`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("ECANARY_START_INVALID", `${label} is invalid`);
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("ECANARY_START_INVALID", `${label} must be a SHA-256 digest`);
}

function copyFacts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail("ECANARY_START_INVALID", "start.facts must be a plain record");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64 || keys.some((key) => typeof key !== "string" || !FACT_KEY.test(key))) {
    fail("ECANARY_START_INVALID", "start.facts has invalid or excessive fields");
  }
  const facts = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) ||
        descriptor.value !== null && !["string", "number", "boolean"].includes(typeof descriptor.value)) {
      fail("ECANARY_START_INVALID", `start.facts.${key} is not a scalar data field`);
    }
    facts[key] = descriptor.value;
  }
  return Object.freeze(facts);
}

function copyEvidenceRefs(value) {
  if (!Array.isArray(value) || value.length > 64) fail("ECANARY_START_INVALID", "start.evidenceRefs must be bounded");
  const refs = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail("ECANARY_START_INVALID", "start.evidenceRefs cannot contain holes or accessors");
    }
    const ref = record(descriptor.value, ["id", "kind", "digest"], `start.evidenceRefs[${index}]`);
    identifier(ref.id, "evidence ref id");
    identifier(ref.kind, "evidence ref kind");
    digest(ref.digest, "evidence ref digest");
    refs.push(Object.freeze(ref));
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    fail("ECANARY_START_INVALID", "start.evidenceRefs has extra fields");
  }
  return Object.freeze(refs);
}

function copyStart(value) {
  const start = record(value, ["runId", "at", "candidateRevision", "sourceRevision", "sourceDigest", "facts", "evidenceRefs"], "start");
  identifier(start.runId, "start.runId");
  if (typeof start.at !== "string" || !Number.isFinite(Date.parse(start.at)) || new Date(start.at).toISOString() !== start.at) {
    fail("ECANARY_START_INVALID", "start.at must be a canonical UTC timestamp");
  }
  for (const key of ["candidateRevision", "sourceRevision"]) {
    if (typeof start[key] !== "string" || !REVISION.test(start[key])) {
      fail("ECANARY_START_INVALID", `start.${key} must be a lowercase revision`);
    }
  }
  digest(start.sourceDigest, "start.sourceDigest");
  start.facts = copyFacts(start.facts);
  start.evidenceRefs = copyEvidenceRefs(start.evidenceRefs);
  return Object.freeze(start);
}

export async function withCanaryRunStartV1(input) {
  const args = record(input, ["cohort", "journalPath", "route", "start", "dispatch"], "start boundary input");
  if (typeof args.dispatch !== "function") fail("ECANARY_START_INVALID", "dispatch must be a function");
  const cohort = validateCanaryCohortV1(args.cohort);
  const route = record(args.route, ["repositoryId", "launcherId", "sourceId"], "route");
  for (const [key, value] of Object.entries(route)) identifier(value, `route.${key}`);
  if (!cohort.routes.some((entry) => entry.repositoryId === route.repositoryId &&
      entry.launcherId === route.launcherId && entry.sourceId === route.sourceId)) {
    fail("ECANARY_START_ROUTE", "Route is not in the caller-supplied cohort");
  }
  const start = copyStart(args.start);
  if (start.candidateRevision !== cohort.registration.revision) {
    fail("ECANARY_START_REVISION", "Start is not bound to the preregistered candidate revision");
  }
  // Registration is a separate, earlier event. A launcher cannot silently
  // create it as part of a run start or promote local replay to a witness.
  let replay;
  try {
    replay = await readCanaryLedgerV1({ journalPath: args.journalPath });
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("ECANARY_START_REGISTRATION", "The preregistered canary journal is absent");
    }
    throw error;
  }
  if (replay.registration.registrationDigest !== cohort.registration.registrationDigest) {
    fail("ECANARY_START_REGISTRATION", "Journal registration differs from the preregistered cohort");
  }
  const eligibility = classifyCanaryRunV1({ registration: cohort.registration, origin: "NATURAL", facts: start.facts });
  const identity = createHash("sha256").update(JSON.stringify([
    cohort.cohortDigest, route.repositoryId, route.launcherId, route.sourceId, start.runId
  ])).digest("hex");
  const request = {
    ledgerId: cohort.registration.ledgerId,
    eventId: `start-${identity}`,
    idempotencyKey: `start-${identity}`,
    op: "RUN_STARTED",
    at: start.at,
    provenance: {
      producerId: route.launcherId,
      sourceId: route.sourceId,
      sourceRevision: start.sourceRevision,
      sourceDigest: start.sourceDigest,
      evidenceRefs: start.evidenceRefs
    },
    payload: {
      repositoryId: route.repositoryId,
      runId: start.runId,
      repositoryRevision: start.candidateRevision,
      origin: "NATURAL",
      facts: start.facts,
      eligibility
    }
  };
  const appended = await appendCanaryEventV1({
    journalPath: args.journalPath,
    request,
    expectedHeadDigest: replay.headDigest,
    expectedEventCount: replay.eventCount
  });
  if (appended.idempotent) {
    fail("ECANARY_START_RECONCILE_REQUIRED", "Start was already recorded; dispatch outcome requires reconciliation", "UNKNOWN");
  }
  // A failed or indeterminate append never reaches dispatch. A dispatch error
  // leaves the durable RUN_STARTED in the denominator as UNFINISHED/UNKNOWN.
  let dispatchResult;
  try {
    dispatchResult = await args.dispatch(Object.freeze({ event: appended.event, route: Object.freeze(route), start }));
  } catch (cause) {
    throw new CanaryStartBoundaryError(
      "ECANARY_START_DISPATCH_UNKNOWN",
      "Start was recorded but dispatch outcome requires reconciliation",
      "UNKNOWN",
      { cause }
    );
  }
  return Object.freeze({
    event: appended.event,
    eventCount: appended.eventCount,
    headDigest: appended.headDigest,
    dispatchResult,
    canaryAcceptance: "HOLD",
    releaseAuthority: "NONE"
  });
}
