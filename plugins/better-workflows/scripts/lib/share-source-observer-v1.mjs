import { digestObject, getStateRoot } from "./core.mjs";
import {
  createKnowledgeReadPermission,
  KnowledgeNodeError,
  readKnowledgeNodeV1
} from "./knowledge-v1.mjs";
import {
  createIncidentReadPermissionV1,
  IncidentError,
  readIncidentV1
} from "./incident-v1.mjs";

export const LOCAL_SOURCE_OBSERVATION_SCHEMA_VERSION = 1;
export const LOCAL_SOURCE_OBSERVATION_KIND = "LocalSourceObservationV1";
export const LOCAL_SOURCE_BINDING_V1 = "local-record-v1";
export const CALLER_ASSERTED_SOURCE_BINDING_V1 = "caller-asserted-v1";
export const LOCAL_SOURCE_PHASES = Object.freeze(["prepare", "export"]);
export const LOCAL_SOURCE_STATUSES = Object.freeze([
  "CURRENT",
  "CHANGED",
  "REVOKED",
  "EXPIRED",
  "REVIEW_REQUIRED",
  "REVIEW_REJECTED",
  "UNKNOWN"
]);

const SOURCE_KEYS = new Set(["kind", "id", "revision", "digest"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_KIND = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const LOCAL_REVISION = /^[1-9][0-9]{0,5}$/;
const MAX_DEADLINE_MS = 2_000;

export class ShareSourceObservationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ShareSourceObservationError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new ShareSourceObservationError(code, message, details);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail("ESOURCE_INVALID", "source reference could not be inspected");
  }
  if (prototype !== Object.prototype && prototype !== null) fail("ESOURCE_INVALID", "source reference must be a plain object");
  return true;
}

function ownDataKeys(value, label) {
  isPlainRecord(value);
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail("ESOURCE_INVALID", `${label} could not be inspected`);
  }
  const descriptors = new Map();
  for (const key of keys) {
    if (typeof key !== "string") fail("ESOURCE_INVALID", `${label} contains a symbol property`);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail("ESOURCE_INVALID", `${label} property could not be inspected`);
    }
    if (!descriptor || descriptor.get || descriptor.set) fail("ESOURCE_INVALID", `${label}.${key} must be a data property`);
    descriptors.set(key, descriptor);
  }
  return descriptors;
}

function normalizeReference(value) {
  const descriptors = ownDataKeys(value, "source reference");
  const unknown = [...descriptors.keys()].filter((key) => !SOURCE_KEYS.has(key)).sort();
  if (unknown.length > 0) fail("ESOURCE_INVALID", "source reference contains an unknown field");
  for (const key of SOURCE_KEYS) if (!descriptors.has(key)) fail("ESOURCE_INVALID", `source reference requires ${key}`);
  const kind = descriptors.get("kind").value;
  const id = descriptors.get("id").value;
  const revision = descriptors.get("revision").value;
  const digest = descriptors.get("digest").value;
  if (typeof kind !== "string" || !SAFE_KIND.test(kind)) fail("ESOURCE_INVALID", "source reference kind is invalid");
  if (typeof id !== "string" || !SAFE_ID.test(id)) fail("ESOURCE_INVALID", "source reference id is invalid");
  if (typeof revision !== "string" || revision.length === 0 || Buffer.byteLength(revision, "utf8") > 256) fail("ESOURCE_INVALID", "source reference revision is invalid");
  if (typeof digest !== "string" || !DIGEST.test(digest)) fail("ESOURCE_INVALID", "source reference digest is invalid");
  return Object.freeze({ kind, id, revision, digest });
}

function beginBudget(value) {
  const deadlineMs = value === undefined ? MAX_DEADLINE_MS : value;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS) fail("ESOURCE_INVALID", "source observation deadline is outside its bounded range");
  const startedAt = Date.now();
  const remaining = () => Math.max(0, deadlineMs - (Date.now() - startedAt));
  const check = () => {
    if (remaining() <= 0) fail("ESOURCE_DEADLINE", "source observation exceeded its bounded deadline");
  };
  return { remaining, check };
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function nullableRecord(revision = null, digest = null) {
  return { revision, digest };
}

function makeObservation({ phase, source, status, reason, recordRevision = null, recordDigest = null, review = "UNKNOWN", expiry = null, tombstoneObserved = null }) {
  const core = {
    schemaVersion: LOCAL_SOURCE_OBSERVATION_SCHEMA_VERSION,
    kind: LOCAL_SOURCE_OBSERVATION_KIND,
    sourceBinding: LOCAL_SOURCE_BINDING_V1,
    phase,
    source,
    status,
    reason,
    observed: nullableRecord(recordRevision, recordDigest),
    review,
    expiry,
    tombstoneObserved,
    observationOnly: true
  };
  return deepFreeze({ ...core, observationDigest: digestObject(core) });
}

function mapError(error, source, phase) {
  const code = error?.code;
  if (code === "EKNOWLEDGE_REVOKED" || code === "EINCIDENT_REVOKED" || code === "ESHARE_REVOKED") {
    return makeObservation({ phase, source, status: "REVOKED", reason: "source-tombstone", review: "UNKNOWN", tombstoneObserved: true });
  }
  if (code === "ESHARE_EXPIRED") {
    return makeObservation({ phase, source, status: "EXPIRED", reason: "source-expired", review: "UNKNOWN", expiry: { expiresAt: null, expired: true }, tombstoneObserved: null });
  }
  if (code === "ESOURCE_DEADLINE" || code === "EKNOWLEDGE_DEADLINE" || code === "EINCIDENT_DEADLINE" || code === "ESHARE_DEADLINE") {
    return makeObservation({ phase, source, status: "UNKNOWN", reason: "source-observation-deadline" });
  }
  return makeObservation({ phase, source, status: "UNKNOWN", reason: "source-observation-failed" });
}

function compareRecord({ phase, source, recordRevision, recordDigest, review = "NOT_APPLICABLE", expiry = null }) {
  const expectedRevision = source.revision;
  const observedRevision = String(recordRevision);
  let status = "CURRENT";
  if (expectedRevision !== observedRevision || source.digest !== recordDigest) status = "CHANGED";
  else if (expiry?.expired === true) status = "EXPIRED";
  else if (review === "REVIEW_REJECTED") status = "REVIEW_REJECTED";
  else if (review === "REVIEW_REQUIRED") status = "REVIEW_REQUIRED";
  else if (review !== "APPROVED" && review !== "NOT_APPLICABLE") status = "UNKNOWN";
  const reasonByStatus = {
    CURRENT: "current-record-match",
    CHANGED: "source-reference-mismatch",
    EXPIRED: "source-expired",
    REVIEW_REJECTED: "source-review-rejected",
    REVIEW_REQUIRED: "source-review-incomplete",
    UNKNOWN: "source-review-unknown"
  };
  return makeObservation({
    phase,
    source,
    status,
    reason: reasonByStatus[status],
    recordRevision: observedRevision,
    recordDigest,
    review,
    expiry,
    tombstoneObserved: false
  });
}

function incidentReviewStatus(reviews) {
  const dispositions = [reviews?.privacy?.disposition, reviews?.security?.disposition, reviews?.facts?.disposition];
  if (dispositions.every((value) => value === "approved")) return "APPROVED";
  if (dispositions.some((value) => value === "rejected")) return "REVIEW_REJECTED";
  return "REVIEW_REQUIRED";
}

function shareReviewStatus(review) {
  return review && Object.values(review).every((value) => value === "approved") ? "APPROVED" : "UNKNOWN";
}

export function normalizeLocalSourceReferenceV1(source, sourceBinding = LOCAL_SOURCE_BINDING_V1) {
  if (sourceBinding !== LOCAL_SOURCE_BINDING_V1) fail("ESOURCE_INVALID", "source reference is not a local-record-v1 binding");
  const normalized = normalizeReference(source);
  if (!LOCAL_REVISION.test(normalized.revision)) fail("ESOURCE_INVALID", "local source revision must be a canonical record revision");
  return normalized;
}

export function isLocalSourceBindingV1(value) {
  return value === LOCAL_SOURCE_BINDING_V1;
}

async function observeNormalizedSource({ stateRoot, source, phase, budget, seen }) {
  const sourceKey = `${source.kind}:${source.id}:${source.revision}:${source.digest}`;
  if (seen.has(sourceKey)) return makeObservation({ phase, source, status: "UNKNOWN", reason: "source-lineage-cycle" });
  seen.add(sourceKey);
  if (!new Set(["knowledge", "incident", "share"]).has(source.kind)) {
    return makeObservation({ phase, source, status: "UNKNOWN", reason: "no-trusted-local-resolver" });
  }
  try {
    budget.check();
    if (source.kind === "knowledge") {
      const permission = createKnowledgeReadPermission({ stateRoot, nodeId: source.id });
      const result = await readKnowledgeNodeV1({ stateRoot, nodeId: source.id, permission, deadlineMs: Math.max(1, budget.remaining()) });
      budget.check();
      return compareRecord({ phase, source, recordRevision: result.latestRevision, recordDigest: result.latestDigest });
    }

    if (source.kind === "incident") {
      const permission = createIncidentReadPermissionV1({ stateRoot, incidentId: source.id });
      const result = await readIncidentV1({ stateRoot, incidentId: source.id, permission, deadlineMs: Math.max(1, budget.remaining()) });
      budget.check();
      return compareRecord({
        phase,
        source,
        recordRevision: result.latestRevision,
        recordDigest: result.latestDigest,
        review: incidentReviewStatus(result.incident?.reviews)
      });
    }

    // This import is deliberately deferred to avoid a static cycle: share-v1
    // calls this observer, while a share may itself be a local source.
    const share = await import("./share-v1.mjs");
    const permission = share.createShareReadPermissionV1({ stateRoot, shareId: source.id });
    const result = await share.readShareArtifactV1({ stateRoot, shareId: source.id, permission, deadlineMs: Math.max(1, budget.remaining()) });
    budget.check();
    if (!share.isLocalSourceBindingV1(result.artifact?.sourceBinding)) {
      return makeObservation({ phase, source, status: "UNKNOWN", reason: "nested-source-is-caller-asserted", recordRevision: String(result.latestRevision), recordDigest: result.latestDigest, review: "UNKNOWN", tombstoneObserved: false });
    }
    let nestedSource;
    try {
      nestedSource = normalizeLocalSourceReferenceV1(result.artifact.source, result.artifact.sourceBinding);
    } catch {
      return makeObservation({ phase, source, status: "UNKNOWN", reason: "nested-source-reference-invalid", recordRevision: String(result.latestRevision), recordDigest: result.latestDigest, review: "UNKNOWN", tombstoneObserved: false });
    }
    const nestedObservation = await observeNormalizedSource({ stateRoot, source: nestedSource, phase, budget, seen });
    if (nestedObservation.status !== "CURRENT") {
      return makeObservation({
        phase,
        source,
        status: nestedObservation.status,
        reason: "nested-source-not-current",
        recordRevision: String(result.latestRevision),
        recordDigest: result.latestDigest,
        review: nestedObservation.review,
        tombstoneObserved: nestedObservation.tombstoneObserved
      });
    }
    const latestExpiry = result.artifact?.expiresAt
      ? { expiresAt: result.artifact.expiresAt, expired: Date.parse(result.artifact.expiresAt) <= Date.now() }
      : null;
    return compareRecord({
      phase,
      source,
      recordRevision: result.latestRevision,
      recordDigest: result.latestDigest,
      review: shareReviewStatus(result.artifact?.review),
      expiry: latestExpiry
    });
  } catch (error) {
    if (error instanceof ShareSourceObservationError) {
      if (error.code === "ESOURCE_DEADLINE") return mapError(error, source, phase);
      throw error;
    }
    if (error instanceof KnowledgeNodeError || error instanceof IncidentError || error?.name === "ShareError") {
      return mapError(error, source, phase);
    }
    return mapError(error, source, phase);
  }
}

export async function observeLocalSourceV1(options = {}) {
  const descriptors = ownDataKeys(options, "source observation options");
  const allowed = new Set(["stateRoot", "source", "sourceBinding", "phase", "deadlineMs"]);
  if ([...descriptors.keys()].some((key) => !allowed.has(key))) fail("ESOURCE_INVALID", "source observation options contain an unknown field");
  const stateRoot = descriptors.get("stateRoot")?.value ?? getStateRoot();
  const source = descriptors.get("source")?.value;
  const sourceBinding = descriptors.get("sourceBinding")?.value ?? LOCAL_SOURCE_BINDING_V1;
  const phase = descriptors.get("phase")?.value ?? "prepare";
  const deadlineMs = descriptors.get("deadlineMs")?.value;
  if (!LOCAL_SOURCE_PHASES.includes(phase)) fail("ESOURCE_INVALID", "source observation phase is unsupported");
  const normalized = normalizeLocalSourceReferenceV1(source, sourceBinding);
  const budget = beginBudget(deadlineMs);
  budget.check();
  return observeNormalizedSource({ stateRoot, source: normalized, phase, budget, seen: new Set() });
}
