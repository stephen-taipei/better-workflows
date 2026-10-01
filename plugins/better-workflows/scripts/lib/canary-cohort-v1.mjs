// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import {
  replayCanaryLedgerV1,
  validateCanaryRegistrationV1
} from "./canary-ledger-v1.mjs";

export const CANARY_COHORT_KIND = "CanaryCohortV1";
export const CANARY_START_INVENTORY_KIND = "CanaryStartInventoryV1";
export const CANARY_START_RECONCILIATION_KIND = "CanaryStartReconciliationV1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FACT_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REVISION = /^[a-f0-9]{40,64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_STARTS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 300_000;
const MAX_DEPTH = 16;

export class CanaryCohortError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CanaryCohortError";
    this.code = code;
    this.status = "HOLD";
  }
}

function fail(code, message) {
  throw new CanaryCohortError(code, message);
}

function snapshot(value) {
  let nodes = 0;
  let bytes = 0;
  const active = new Set();
  function charge(value) {
    bytes += typeof value === "number" ? value : Buffer.byteLength(value);
    if (bytes > MAX_BYTES) fail("ECANARY_COHORT_LIMIT", "Canary input exceeds byte bound");
  }
  function copy(item, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail("ECANARY_COHORT_LIMIT", "Canary input exceeds structural bounds");
    if (item === null || typeof item === "boolean") {
      charge(JSON.stringify(item));
      return item;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("ECANARY_COHORT_INVALID", "Canary numbers must be finite");
      charge(JSON.stringify(item));
      return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item === "string") {
      if (item.length > 4096) fail("ECANARY_COHORT_LIMIT", "Canary string is too large");
      charge(JSON.stringify(item));
      return item;
    }
    if (!item || typeof item !== "object" || active.has(item)) fail("ECANARY_COHORT_INVALID", "Canary input must be acyclic JSON data");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      fail("ECANARY_COHORT_INVALID", "Canary input must contain plain objects or arrays");
    }
    if (array && item.length > MAX_STARTS) fail("ECANARY_COHORT_LIMIT", "Canary array exceeds bound");
    // Enumerate only JSON-visible own keys, stopping before a large object can
    // force an unbounded descriptor map. Hidden/symbol metadata is not copied.
    const keys = [];
    const keyLimit = array ? item.length : 128;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (keys.length >= keyLimit) fail("ECANARY_COHORT_LIMIT", "Canary object has too many fields");
      keys.push(key);
    }
    active.add(item);
    let result;
    if (array) {
      if (keys.length !== item.length || keys.some((key, index) => key !== String(index))) {
        fail("ECANARY_COHORT_LIMIT", "Canary array is too large, sparse, or decorated");
      }
      charge(2 + Math.max(0, item.length - 1));
      result = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("ECANARY_COHORT_INVALID", "Canary array has an accessor or hole");
        result.push(copy(descriptor.value, depth + 1));
      }
    } else {
      keys.sort();
      charge(2 + Math.max(0, keys.length - 1));
      result = {};
      for (const key of keys) {
        if (["__proto__", "constructor", "prototype"].includes(key)) fail("ECANARY_COHORT_INVALID", "Unsafe Canary field");
        if (key.length > 4096) fail("ECANARY_COHORT_LIMIT", "Canary field name is too large");
        charge(JSON.stringify(key));
        charge(1);
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!("value" in descriptor) || !descriptor.enumerable) fail("ECANARY_COHORT_INVALID", "Canary object has an accessor or hidden field");
        result[key] = copy(descriptor.value, depth + 1);
      }
    }
    active.delete(item);
    return result;
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) fail("ECANARY_COHORT_LIMIT", "Canary input exceeds byte bound");
  return result;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(snapshot(value));
}

function commitment(kind, value) {
  return createHash("sha256").update(`BW:${kind}\0`).update(canonical(value)).digest("hex");
}

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) {
    fail("ECANARY_COHORT_INVALID", `${label} has unexpected or missing fields`);
  }
}

function reconciliationInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    fail("ECANARY_COHORT_INVALID", "reconciliation input must be a plain object");
  }
  const actual = [];
  for (const key in input) {
    if (!Object.hasOwn(input, key)) continue;
    if (actual.length >= 3) fail("ECANARY_COHORT_INVALID", "reconciliation input has too many fields");
    actual.push(key);
  }
  const keys = ["cohort", "ledgerEvents", "inventory"];
  if (canonical(actual.sort()) !== canonical([...keys].sort())) {
    fail("ECANARY_COHORT_INVALID", "reconciliation input has unexpected or missing fields");
  }
  const values = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail("ECANARY_COHORT_INVALID", "reconciliation input cannot contain accessors or hidden fields");
    }
    values[key] = descriptor.value;
  }
  return values;
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("ECANARY_COHORT_INVALID", `${label} is invalid`);
}

function revision(value, label) {
  if (typeof value !== "string" || !REVISION.test(value)) fail("ECANARY_COHORT_INVALID", `${label} must be a lowercase revision`);
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("ECANARY_COHORT_INVALID", `${label} must be a SHA-256 digest`);
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("ECANARY_COHORT_INVALID", `${label} must be a canonical UTC timestamp`);
  }
  return Date.parse(value);
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail("ECANARY_COHORT_INVALID", `${label} must be a non-negative safe integer`);
}

function routeKey({ repositoryId, launcherId, sourceId }) {
  return `${repositoryId}\0${launcherId}\0${sourceId}`;
}

function runKey(repositoryId, runId) {
  return `${repositoryId}\0${runId}`;
}

function routeIdentity(key) {
  const [repositoryId, launcherId, sourceId] = key.split("\0");
  return { repositoryId, launcherId, sourceId };
}

function runIdentity(key) {
  const [repositoryId, runId] = key.split("\0");
  return { repositoryId, runId };
}

function cohortBody(input) {
  exact(input, ["schemaVersion", "kind", "registration", "routes", "collectorRevision", "verifierRevision"], "cohort");
  if (input.schemaVersion !== 1 || input.kind !== CANARY_COHORT_KIND) fail("ECANARY_COHORT_INVALID", "Cohort version/kind is invalid");
  const registration = validateCanaryRegistrationV1(input.registration);
  revision(input.collectorRevision, "cohort.collectorRevision");
  revision(input.verifierRevision, "cohort.verifierRevision");
  if (!Array.isArray(input.routes) || input.routes.length < 3 || input.routes.length > MAX_STARTS) {
    fail("ECANARY_COHORT_INVALID", "Cohort requires bounded routes for at least three repositories");
  }
  const repositories = new Set();
  let previous = null;
  for (const [index, route] of input.routes.entries()) {
    exact(route, ["repositoryId", "launcherId", "sourceId"], `cohort.routes[${index}]`);
    for (const key of ["repositoryId", "launcherId", "sourceId"]) identifier(route[key], `cohort.routes[${index}].${key}`);
    const key = routeKey(route);
    if (previous !== null && key <= previous) fail("ECANARY_COHORT_INVALID", "Cohort routes must be unique and sorted");
    previous = key;
    repositories.add(route.repositoryId);
  }
  if (repositories.size < 3) fail("ECANARY_COHORT_INVALID", "Cohort requires at least three distinct repositories");
  return { ...input, registration };
}

// This commitment is structural. It is not a trusted timestamp or owner signature.
export function createCanaryCohortV1(input) {
  const body = cohortBody(snapshot(input));
  return freeze({ ...body, cohortDigest: commitment(CANARY_COHORT_KIND, body) });
}

export function validateCanaryCohortV1(input) {
  const value = snapshot(input);
  exact(value, ["schemaVersion", "kind", "registration", "routes", "collectorRevision", "verifierRevision", "cohortDigest"], "cohort");
  digest(value.cohortDigest, "cohort.cohortDigest");
  const { cohortDigest, ...body } = value;
  const expected = createCanaryCohortV1(body);
  if (cohortDigest !== expected.cohortDigest) fail("ECANARY_COHORT_MISMATCH", "Cohort digest mismatch");
  return expected;
}

function facts(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("ECANARY_COHORT_INVALID", `${label} must be an object`);
  for (const [key, item] of Object.entries(value)) {
    if (!FACT_KEY.test(key) || item !== null && !["string", "number", "boolean"].includes(typeof item)) {
      fail("ECANARY_COHORT_INVALID", `${label} must contain scalar start-time facts`);
    }
  }
}

function validateInventory(input, cohort) {
  const inventory = snapshot(input);
  exact(inventory, ["schemaVersion", "kind", "cohortDigest", "coverage", "capturedAt", "streams"], "inventory");
  if (inventory.schemaVersion !== 1 || inventory.kind !== CANARY_START_INVENTORY_KIND || inventory.cohortDigest !== cohort.cohortDigest) {
    fail("ECANARY_INVENTORY_INVALID", "Inventory version/kind/cohort binding is invalid");
  }
  exact(inventory.coverage, ["startsAt", "completeThrough"], "inventory.coverage");
  const registrationWindow = cohort.registration.observationWindow;
  const startsAt = timestamp(inventory.coverage.startsAt, "inventory.coverage.startsAt");
  const completeThrough = timestamp(inventory.coverage.completeThrough, "inventory.coverage.completeThrough");
  const capturedAt = timestamp(inventory.capturedAt, "inventory.capturedAt");
  if (inventory.coverage.startsAt !== registrationWindow.startsAt || completeThrough < startsAt ||
      completeThrough > Date.parse(registrationWindow.endsAt) || capturedAt < completeThrough) {
    fail("ECANARY_INVENTORY_INVALID", "Inventory coverage is outside the registered window or later than capture");
  }
  if (!Array.isArray(inventory.streams) || inventory.streams.length > MAX_STARTS) fail("ECANARY_COHORT_LIMIT", "Inventory streams exceed bound");
  const seenStreams = new Set();
  const seenRuns = new Set();
  let startCount = 0;
  for (const [streamIndex, stream] of inventory.streams.entries()) {
    exact(stream, ["repositoryId", "launcherId", "sourceId", "firstSequence", "lastSequence", "sourceWatermarkDigest", "starts"], `inventory.streams[${streamIndex}]`);
    for (const key of ["repositoryId", "launcherId", "sourceId"]) identifier(stream[key], `inventory.streams[${streamIndex}].${key}`);
    const key = routeKey(stream);
    if (seenStreams.has(key)) fail("ECANARY_INVENTORY_INVALID", "Inventory repeats a source stream");
    seenStreams.add(key);
    integer(stream.firstSequence, "inventory stream firstSequence");
    integer(stream.lastSequence, "inventory stream lastSequence");
    if (stream.firstSequence < 1 || !Array.isArray(stream.starts) || stream.lastSequence !== stream.firstSequence + stream.starts.length - 1) {
      fail("ECANARY_INVENTORY_INVALID", "Inventory stream sequence range is not contiguous");
    }
    digest(stream.sourceWatermarkDigest, "inventory stream sourceWatermarkDigest");
    startCount += stream.starts.length;
    if (startCount > MAX_STARTS) fail("ECANARY_COHORT_LIMIT", "Inventory starts exceed bound");
    for (const [index, start] of stream.starts.entries()) {
      exact(start, ["sequence", "runId", "startedAt", "candidateRevision", "sourceRevision", "sourceDigest", "facts"], `inventory start ${index}`);
      integer(start.sequence, "inventory start sequence");
      if (start.sequence !== stream.firstSequence + index) fail("ECANARY_INVENTORY_INVALID", "Inventory has a sequence gap");
      identifier(start.runId, "inventory start runId");
      revision(start.candidateRevision, "inventory start candidateRevision");
      identifier(start.sourceRevision, "inventory start sourceRevision");
      digest(start.sourceDigest, "inventory start sourceDigest");
      const at = timestamp(start.startedAt, "inventory start startedAt");
      if (at < startsAt || at >= completeThrough) fail("ECANARY_INVENTORY_INVALID", "Inventory start is outside claimed coverage");
      facts(start.facts, "inventory start facts");
      const run = runKey(stream.repositoryId, start.runId);
      if (seenRuns.has(run)) fail("ECANARY_INVENTORY_INVALID", "Inventory repeats a run across streams");
      seenRuns.add(run);
    }
  }
  return inventory;
}

// A caller-supplied inventory is useful for finding gaps, but cannot attest its own
// identity, completeness, watermark, or preregistration time. No MATCH result below
// is a canary acceptance or release authorization.
export function reconcileCanaryStartsV1(input) {
  // Each of these three components has its own 8 MiB bound. Copying their
  // aggregate under one 8 MiB cap would reject a valid near-limit V1 ledger.
  const value = reconciliationInput(input);
  const cohort = validateCanaryCohortV1(value.cohort);
  const replay = replayCanaryLedgerV1({ events: value.ledgerEvents });
  if (replay.registration.registrationDigest !== cohort.registration.registrationDigest) {
    fail("ECANARY_COHORT_MISMATCH", "Ledger registration is not bound to cohort");
  }
  const inventory = validateInventory(value.inventory, cohort);
  const cutoff = Date.parse(inventory.coverage.completeThrough);
  const requiredRoutes = new Set(cohort.routes.map(routeKey));
  const presentRoutes = new Set(inventory.streams.map(routeKey));
  const missingRoutes = [...requiredRoutes].filter((key) => !presentRoutes.has(key)).sort();
  const unexpectedRoutes = [...presentRoutes].filter((key) => !requiredRoutes.has(key)).sort();
  const inventoryStarts = new Map();
  for (const stream of inventory.streams) {
    for (const start of stream.starts) inventoryStarts.set(runKey(stream.repositoryId, start.runId), { stream, start });
  }
  const ledgerStarts = new Map();
  const unmappedLedgerStarts = [];
  let fixtureStarts = 0;
  let laterLedgerStarts = 0;
  for (const run of replay.runs) {
    const event = run.start;
    if (event.payload.origin === "SYNTHETIC_FIXTURE") {
      fixtureStarts++;
      continue;
    }
    if (Date.parse(event.at) >= cutoff) {
      laterLedgerStarts++;
      continue;
    }
    const key = runKey(event.payload.repositoryId, event.payload.runId);
    ledgerStarts.set(key, event);
    const route = routeKey({
      repositoryId: event.payload.repositoryId,
      launcherId: event.provenance.producerId,
      sourceId: event.provenance.sourceId
    });
    if (!requiredRoutes.has(route)) unmappedLedgerStarts.push(key);
  }
  const missingLedgerStarts = [];
  const missingInventoryStarts = [];
  const fieldMismatches = [];
  let matchedStarts = 0;
  for (const [key, { stream, start }] of inventoryStarts) {
    const event = ledgerStarts.get(key);
    if (!event) {
      missingLedgerStarts.push(key);
      continue;
    }
    const fields = [];
    if (start.startedAt !== event.at) fields.push("startedAt");
    if (start.candidateRevision !== event.payload.repositoryRevision) fields.push("candidateRevision");
    if (start.sourceRevision !== event.provenance.sourceRevision) fields.push("sourceRevision");
    if (start.sourceDigest !== event.provenance.sourceDigest) fields.push("sourceDigest");
    if (stream.launcherId !== event.provenance.producerId) fields.push("launcherId");
    if (stream.sourceId !== event.provenance.sourceId) fields.push("sourceId");
    if (canonical(start.facts) !== canonical(event.payload.facts)) fields.push("facts");
    if (fields.length > 0) fieldMismatches.push({ run: key, fields });
    else matchedStarts++;
  }
  for (const key of ledgerStarts.keys()) if (!inventoryStarts.has(key)) missingInventoryStarts.push(key);
  const structuralMatch = missingRoutes.length === 0 && unexpectedRoutes.length === 0 &&
    missingLedgerStarts.length === 0 && missingInventoryStarts.length === 0 &&
    unmappedLedgerStarts.length === 0 && fieldMismatches.length === 0;
  // This is only a lower bound: an unauthenticated or incomplete source may
  // have further starts. Missing ledger entries never disappear from the view.
  const observedNaturalStartFloor = new Set([...ledgerStarts.keys(), ...inventoryStarts.keys()]).size;
  return freeze({
    schemaVersion: 1,
    kind: CANARY_START_RECONCILIATION_KIND,
    cohortDigest: cohort.cohortDigest,
    inventoryDigest: commitment(CANARY_START_INVENTORY_KIND, inventory),
    ledgerHeadDigest: replay.headDigest,
    ledgerEventCount: replay.eventCount,
    coverage: inventory.coverage,
    ledgerNaturalStarts: ledgerStarts.size,
    inventoryNaturalStarts: inventoryStarts.size,
    observedNaturalStartFloor,
    fixtureStarts,
    laterLedgerStarts,
    matchedStarts,
    missingRoutes: missingRoutes.map(routeIdentity),
    unexpectedRoutes: unexpectedRoutes.map(routeIdentity),
    missingLedgerStarts: missingLedgerStarts.sort().map(runIdentity),
    missingInventoryStarts: missingInventoryStarts.sort().map(runIdentity),
    unmappedLedgerStarts: unmappedLedgerStarts.sort().map(runIdentity),
    fieldMismatches: fieldMismatches.sort((a, b) => a.run.localeCompare(b.run)).map(({ run, fields }) => ({ run: runIdentity(run), fields })),
    structuralMatch,
    registrationTimeStatus: "UNVERIFIED",
    inventoryAuthenticity: "UNVERIFIED",
    ledgerCompleteness: "UNVERIFIED",
    denominatorCompleteness: "UNKNOWN",
    canaryAcceptance: "HOLD",
    releaseAuthority: "NONE",
    actionAuthority: "NONE",
    status: structuralMatch ? "HOLD_UNVERIFIED_SOURCE" : "HOLD_RECONCILIATION_MISMATCH"
  });
}
