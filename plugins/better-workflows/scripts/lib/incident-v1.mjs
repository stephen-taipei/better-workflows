import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink
} from "node:fs/promises";
import path from "node:path";
import {
  assertNoSymlinkUnder,
  atomicWriteJson,
  canonicalJson,
  digestObject,
  ensurePrivateDir,
  getStateRoot,
  isCredentialShapedValue,
  safeJoin
} from "./core.mjs";

export const INCIDENT_SCHEMA_VERSION = 1;
export const INCIDENT_REPORT_KIND = "IncidentReportV1";
export const INCIDENT_INDEX_KIND = "IncidentIndexV1";
export const INCIDENT_TOMBSTONE_KIND = "IncidentTombstoneV1";
export const INCIDENT_PREPARATION_KIND = "IncidentPublicationPreparationV1";
export const INCIDENT_PRODUCER = "better-workflows-incident-local-v1";
export const INCIDENT_STORE_DIRECTORY = "incident-v1";
export const INCIDENT_STATUS = "ADVISORY";
// This is a short-lived serialization fence for a trusted launch caller. It
// carries no publication or action authority; it only makes incident
// revision changes and the final owned launch transaction have one ordering.
export const INCIDENT_REVISION_LAUNCH_FENCE_KIND = "IncidentRevisionLaunchFenceV1";
export const INCIDENT_LIMITS = Object.freeze({
  maxIncidentCount: 256,
  maxRevisionCount: 64,
  maxIdBytes: 128,
  maxTitleBytes: 2 * 1024,
  maxSummaryBytes: 8 * 1024,
  maxFactCount: 32,
  maxFactBytes: 4 * 1024,
  maxContentBytes: 64 * 1024,
  maxSourceRevisionBytes: 256,
  maxSourceScopeBytes: 512,
  maxReviewReasonBytes: 2 * 1024,
  maxRemovedFieldCount: 16,
  maxRemovedFieldBytes: 256,
  maxTargetKindBytes: 64,
  maxTargetIdBytes: 256,
  maxTargetRevisionBytes: 256,
  maxRecordBytes: 256 * 1024,
  maxDeadlineMs: 2_000
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_HASH_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION_FILE = /^[1-9][0-9]{0,2}\.json$/;
const SENSITIVE_FIELD = /(?:raw|private|secret|token|password|passwd|authorization|credential|cookie|email|phone|address|ssn|api(?:[_-]?key)?|access(?:[_-]?key)?)(?:$|[_-]|[A-Z])/i;
const REPORT_KEYS = new Set([
  "schemaVersion", "kind", "incidentId", "revision", "status", "content", "source", "provenance", "reviews", "revisionDigest"
]);
const CONTENT_KEYS = new Set(["title", "summary", "facts", "impact"]);
const SOURCE_KEYS = new Set(["revision", "digest", "scope"]);
const PROVENANCE_KEYS = new Set(["producer", "method", "capturedAt", "evidenceDigest", "sanitization"]);
const SANITIZATION_KEYS = new Set(["mode", "rawExcluded", "removedFields", "sanitizedDigest"]);
const REVIEWS_KEYS = new Set(["privacy", "security", "facts"]);
const REVIEW_ENTRY_KEYS = new Set(["disposition", "reviewedAt", "reason"]);
const TARGET_KEYS = new Set(["kind", "id", "revision", "digest"]);
const PREPARATION_KEYS = new Set([
  "schemaVersion", "kind", "incidentId", "incidentRevision", "incidentDigest", "source", "target", "targetDigest",
  "reviewDigest", "artifact", "disclosure", "status", "publicationState", "published", "authority", "preparedAt", "preparationDigest"
]);
const ARTIFACT_KEYS = new Set(["title", "summary", "facts", "impact", "contentDigest"]);
const DISCLOSURE_KEYS = new Set(["mode", "rawExcluded"]);
const INDEX_KEYS = new Set(["schemaVersion", "kind", "incidentId", "status", "latestRevision", "latestDigest", "tombstoneDigest", "indexDigest"]);
const TOMBSTONE_KEYS = new Set(["schemaVersion", "kind", "incidentId", "action", "revision", "revisionDigest", "at", "reason", "tombstoneDigest"]);

const READ_PERMISSIONS = new WeakSet();
const FIRST_PERMISSIONS = new WeakSet();
const REVISION_PERMISSIONS = new WeakSet();
const REVIEW_PERMISSIONS = new WeakSet();
const PREPARE_PERMISSIONS = new WeakSet();
const REVOKE_PERMISSIONS = new WeakSet();
const DELETE_PERMISSIONS = new WeakSet();
const USED_FIRST_PERMISSIONS = new WeakSet();
const USED_REVISION_PERMISSIONS = new WeakSet();
const USED_REVIEW_PERMISSIONS = new WeakSet();
const USED_PREPARE_PERMISSIONS = new WeakSet();
const USED_REVOKE_PERMISSIONS = new WeakSet();
const USED_DELETE_PERMISSIONS = new WeakSet();

// These opaque capabilities only separate local call sites and bind a request
// to one state root, incident, revision, review role, or publication target.
// They are deliberately not owner signatures, provider credentials, evidence
// attestations, or permission to publish.  A preparation receipt is advisory
// and always records published:false.

export class IncidentError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "IncidentError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
      if (details && typeof details.status === "string") this.status = details.status;
    }
  }
}

function fail(code, message, details = undefined) {
  throw new IncidentError(code, message, details);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainRecord(value, label) {
  if (!isPlainRecord(value)) fail("EINCIDENT_INVALID", `${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("EINCIDENT_INVALID", `${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) fail("EINCIDENT_INVALID", `${label} contains an accessor property`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  assertPlainRecord(value, label);
  const unknown = Reflect.ownKeys(value).filter((key) => typeof key !== "string" || !allowed.has(key)).map(String).sort();
  if (unknown.length > 0) fail("EINCIDENT_INVALID", `${label} contains unknown field(s)`);
}

function requireKeys(value, keys, label) {
  for (const key of keys) if (!Object.hasOwn(value, key)) fail("EINCIDENT_INVALID", `${label} requires ${key}`);
}

function boundedText(value, label, maxBytes, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && value.length === 0) || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("EINCIDENT_INVALID", `${label} must be bounded text`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) fail("EINCIDENT_LIMIT", `${label} exceeds ${maxBytes} bytes`);
  return value;
}

// This is a bounded heuristic for known credential-shaped material, not a
// universal secret detector.  Raw/private values must still be excluded by
// the caller before they reach this advisory incident model.
function credentialShapedForExport(value, { allowUuid = false, allowHashRevision = false } = {}) {
  if (allowUuid && SAFE_UUID.test(value)) return false;
  if (allowHashRevision && SAFE_HASH_REVISION.test(value)) return false;
  return isCredentialShapedValue(value);
}

function exportedText(value, label, maxBytes, options = {}) {
  const text = boundedText(value, label, maxBytes, options);
  if (credentialShapedForExport(text, options)) fail("EINCIDENT_SENSITIVE", `${label} contains credential-shaped material`);
  return text;
}

function versionText(value, label, maxBytes) {
  // Revisions are bounded opaque version identifiers.  Lowercase SHA-1 and
  // SHA-256 and canonical UUID forms are accepted explicitly; other external
  // versions remain bounded text and are never treated as authenticated here.
  return exportedText(value, label, maxBytes, { allowHashRevision: true, allowUuid: true });
}

function safeId(value, label) {
  if (typeof value === "string" && credentialShapedForExport(value, { allowUuid: true, allowHashRevision: true })) {
    fail("EINCIDENT_SENSITIVE", `${label} contains credential-shaped material`);
  }
  if (typeof value !== "string" || !SAFE_ID.test(value) || Buffer.byteLength(value, "utf8") > INCIDENT_LIMITS.maxIdBytes) {
    fail("EINCIDENT_INVALID", `${label} must be a safe id`);
  }
  return value;
}

function targetText(value, label, maxBytes, pattern = null) {
  if (typeof value === "string" && credentialShapedForExport(value, { allowUuid: true, allowHashRevision: true })) {
    fail("EINCIDENT_SENSITIVE", `${label} contains credential-shaped material`);
  }
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f\\]/.test(value)) fail("EINCIDENT_INVALID", `${label} must be a safe target value`);
  if (pattern && !pattern.test(value)) fail("EINCIDENT_INVALID", `${label} contains an unsafe path or id`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) fail("EINCIDENT_LIMIT", `${label} exceeds ${maxBytes} bytes`);
  if (value.split("/").includes("..") || value.includes("//")) fail("EINCIDENT_INVALID", `${label} contains traversal`);
  return value;
}

function boundedInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("EINCIDENT_INVALID", `${label} must be an integer from ${min} through ${max}`);
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("EINCIDENT_INVALID", `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    fail("EINCIDENT_INVALID", `${label} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function beginDeadline(value, label, startedAt = Date.now()) {
  const deadlineMs = value === undefined
    ? INCIDENT_LIMITS.maxDeadlineMs
    : boundedInteger(value, `${label}.deadlineMs`, 1, INCIDENT_LIMITS.maxDeadlineMs);
  return () => {
    if (Date.now() - startedAt >= deadlineMs) fail("EINCIDENT_DEADLINE", `${label} exceeded the ${deadlineMs}ms deadline`);
  };
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
  return value;
}

function arrayValues(value, label, maxLength) {
  if (!Array.isArray(value)) fail("EINCIDENT_INVALID", `${label} must be an array`);
  if (value.length > maxLength) fail("EINCIDENT_LIMIT", `${label} exceeds the bounded array length`);
  if (Object.getPrototypeOf(value) !== Array.prototype) fail("EINCIDENT_INVALID", `${label} has an unexpected prototype`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > maxLength + 1) fail("EINCIDENT_LIMIT", `${label} contains too many own properties`);
  const descriptors = new Map();
  for (const key of ownKeys) {
    if (typeof key !== "string") fail("EINCIDENT_INVALID", `${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) fail("EINCIDENT_INVALID", `${label} contains an accessor property`);
    if (key === "length") {
      if (descriptor.value !== value.length) fail("EINCIDENT_INVALID", `${label}.length is inconsistent`);
      descriptors.set(key, descriptor.value);
      continue;
    }
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length || !Number.isSafeInteger(Number(key))) {
      fail("EINCIDENT_INVALID", `${label} contains a non-index array property`);
    }
    descriptors.set(key, descriptor.value);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) result.push(descriptors.get(String(index)));
  return result;
}

function capability(value, set) {
  const result = deepFreeze(value);
  set.add(result);
  return result;
}

function assertCapability(value, set, label) {
  if (!value || typeof value !== "object" || !set.has(value)) fail("EINCIDENT_PERMISSION", `${label} is not a genuine module capability`);
}

function assertPermissionRoot(permission, root, label) {
  if (permission.stateRoot !== root) fail("EINCIDENT_PERMISSION", `${label} is bound to a different state root`);
}

function assertPermissionIncident(permission, incidentId, label) {
  if (permission.incidentId !== incidentId) fail("EINCIDENT_PERMISSION", `${label} is bound to a different incident`);
}

function failUnsafePath(message = "incident filesystem path is unsafe") {
  fail("EINCIDENT_FS", message);
}

function isTrustedMacOsAlias(target) {
  if (process.platform !== "darwin") return false;
  const expected = {
    "/var": "/private/var",
    "/tmp": "/private/tmp"
  }[target];
  if (!expected) return false;
  try {
    return realpathSync(target) === expected;
  } catch {
    return false;
  }
}

function assertCanonicalStateRootPath(root) {
  let current = root;
  while (true) {
    let info = null;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT") failUnsafePath("incident state root could not be inspected");
    }
    if (info) {
      if (info.isSymbolicLink() && (current === root || !isTrustedMacOsAlias(current))) {
        failUnsafePath("incident state root contains an unsafe symbolic link");
      }
      if (!info.isSymbolicLink() && !info.isDirectory()) {
        failUnsafePath("incident state root contains a non-directory component");
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return root;
}

function stateRootPath(value) {
  if (value === undefined) return stateRootPath(getStateRoot());
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("EINCIDENT_INVALID", "stateRoot must be an absolute path");
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) fail("EINCIDENT_INVALID", "stateRoot is too broad");
  return assertCanonicalStateRootPath(resolved);
}

function assertOptionsKeys(value, allowed, label, required = []) {
  exactKeys(value, allowed, label);
  requireKeys(value, required, label);
}

async function assertIncidentPathNoSymlink(root, target, label = "incident path") {
  try {
    await assertNoSymlinkUnder(root, target);
  } catch (error) {
    if (error instanceof IncidentError) throw error;
    fail("EINCIDENT_FS", `${label} is unsafe`);
  }
}

async function ensureIncidentPrivateDir(root, target, label = "incident directory") {
  await assertIncidentPathNoSymlink(root, target, label);
  try {
    await ensurePrivateDir(target);
  } catch (error) {
    if (error instanceof IncidentError) throw error;
    fail("EINCIDENT_FS", `${label} is unsafe`);
  }
}

function normalizeSource(value) {
  exactKeys(value, SOURCE_KEYS, "incident.source");
  requireKeys(value, ["revision", "digest", "scope"], "incident.source");
  const scope = exportedText(value.scope, "incident.source.scope", INCIDENT_LIMITS.maxSourceScopeBytes);
  if (path.isAbsolute(scope) || scope.includes("\\") || scope.split("/").includes("..") || scope.includes("//")) fail("EINCIDENT_INVALID", "incident.source.scope must be a relative non-traversing scope");
  return {
    revision: versionText(value.revision, "incident.source.revision", INCIDENT_LIMITS.maxSourceRevisionBytes),
    digest: digest(value.digest, "incident.source.digest"),
    scope
  };
}

function normalizeTarget(value) {
  exactKeys(value, TARGET_KEYS, "incident target");
  requireKeys(value, ["kind", "id", "revision", "digest"], "incident target");
  return {
    kind: targetText(value.kind, "incident target.kind", INCIDENT_LIMITS.maxTargetKindBytes, /^[A-Za-z][A-Za-z0-9._-]{0,63}$/),
    id: targetText(value.id, "incident target.id", INCIDENT_LIMITS.maxTargetIdBytes, SAFE_TARGET_ID),
    revision: versionText(value.revision, "incident target.revision", INCIDENT_LIMITS.maxTargetRevisionBytes),
    digest: digest(value.digest, "incident target.digest")
  };
}

function normalizeRemovedFields(value, label = "incident provenance.sanitization.removedFields") {
  const items = arrayValues(value, label, INCIDENT_LIMITS.maxRemovedFieldCount);
  const result = items.map((item, index) => exportedText(item, `${label}[${index}]`, INCIDENT_LIMITS.maxRemovedFieldBytes));
  if (new Set(result).size !== result.length) fail("EINCIDENT_INVALID", `${label} must contain unique paths`);
  return result.sort();
}

function normalizeSanitization(value, content, label = "incident provenance.sanitization") {
  exactKeys(value, SANITIZATION_KEYS, label);
  requireKeys(value, ["mode", "rawExcluded", "removedFields", "sanitizedDigest"], label);
  if (value.mode !== "sanitized" || value.rawExcluded !== true) fail("EINCIDENT_INVALID", `${label} must exclude raw content`);
  const removedFields = normalizeRemovedFields(value.removedFields, `${label}.removedFields`);
  const sanitizedDigest = digest(value.sanitizedDigest, `${label}.sanitizedDigest`);
  if (sanitizedDigest !== digestObject({ content, removedFields })) fail("EINCIDENT_INTEGRITY", `${label}.sanitizedDigest is stale`);
  return { mode: "sanitized", rawExcluded: true, removedFields, sanitizedDigest };
}

function normalizeProvenance(value, content) {
  exactKeys(value, PROVENANCE_KEYS, "incident.provenance");
  requireKeys(value, ["producer", "method", "capturedAt", "evidenceDigest", "sanitization"], "incident.provenance");
  if (value.producer !== INCIDENT_PRODUCER || value.method !== "model-free") fail("EINCIDENT_INVALID", "incident provenance is not model-free local provenance");
  return {
    producer: INCIDENT_PRODUCER,
    method: "model-free",
    capturedAt: timestamp(value.capturedAt, "incident.provenance.capturedAt"),
    evidenceDigest: digest(value.evidenceDigest, "incident.provenance.evidenceDigest"),
    sanitization: normalizeSanitization(value.sanitization, content)
  };
}

function normalizeContent(value, checkDeadline) {
  assertPlainRecord(value, "incident.content");
  const raw = {};
  const removedFields = [];
  for (const key of Reflect.ownKeys(value)) {
    checkDeadline();
    if (typeof key !== "string") fail("EINCIDENT_INVALID", "incident.content contains a symbol property");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) fail("EINCIDENT_INVALID", "incident.content contains an accessor property");
    if (CONTENT_KEYS.has(key)) {
      raw[key] = descriptor.value;
    } else if (SENSITIVE_FIELD.test(key)) {
      // Do not inspect or persist the value of a field explicitly classified as
      // private.  The path is enough for a traceable sanitized disposition.
      removedFields.push(key);
    } else {
      fail("EINCIDENT_INVALID", "incident.content contains an unknown field");
    }
  }
  requireKeys(raw, ["title", "summary", "facts"], "incident.content");
  const facts = arrayValues(raw.facts, "incident.content.facts", INCIDENT_LIMITS.maxFactCount);
  const normalized = {
    title: exportedText(raw.title, "incident.content.title", INCIDENT_LIMITS.maxTitleBytes),
    summary: exportedText(raw.summary, "incident.content.summary", INCIDENT_LIMITS.maxSummaryBytes),
    facts: [],
    impact: raw.impact === undefined || raw.impact === null
      ? null
      : exportedText(raw.impact, "incident.content.impact", INCIDENT_LIMITS.maxSummaryBytes, { empty: true })
  };
  for (let index = 0; index < facts.length; index += 1) {
    checkDeadline();
    normalized.facts.push(exportedText(facts[index], `incident.content.facts[${index}]`, INCIDENT_LIMITS.maxFactBytes));
  }
  if (normalized.facts.length === 0) fail("EINCIDENT_INVALID", "incident.content.facts must not be empty");
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > INCIDENT_LIMITS.maxContentBytes) fail("EINCIDENT_LIMIT", "incident content exceeds the bounded size");
  return {
    content: normalized,
    removedFields: [...new Set(removedFields)].sort(),
    sanitizedDigest: digestObject({ content: normalized, removedFields: [...new Set(removedFields)].sort() })
  };
}

function normalizeReviewEntry(value, label) {
  exactKeys(value, REVIEW_ENTRY_KEYS, label);
  requireKeys(value, ["disposition", "reviewedAt", "reason"], label);
  if (!["pending", "approved", "rejected"].includes(value.disposition)) fail("EINCIDENT_INVALID", `${label}.disposition is unsupported`);
  const reviewedAt = value.reviewedAt === null ? null : timestamp(value.reviewedAt, `${label}.reviewedAt`);
  const reason = value.reason === null ? null : exportedText(value.reason, `${label}.reason`, INCIDENT_LIMITS.maxReviewReasonBytes, { empty: true });
  if (value.disposition === "pending" && (reviewedAt !== null || reason !== null)) fail("EINCIDENT_INVALID", `${label} pending disposition cannot carry a review timestamp or reason`);
  if (value.disposition !== "pending" && (reviewedAt === null || reason === null)) fail("EINCIDENT_INVALID", `${label} decided disposition requires timestamp and reason`);
  return { disposition: value.disposition, reviewedAt, reason };
}

function normalizeReviews(value) {
  exactKeys(value, REVIEWS_KEYS, "incident.reviews");
  requireKeys(value, ["privacy", "security", "facts"], "incident.reviews");
  return {
    privacy: normalizeReviewEntry(value.privacy, "incident.reviews.privacy"),
    security: normalizeReviewEntry(value.security, "incident.reviews.security"),
    facts: normalizeReviewEntry(value.facts, "incident.reviews.facts")
  };
}

function seal(core, field) {
  return deepFreeze({ ...core, [field]: digestObject(core) });
}

function initialReviews() {
  return {
    privacy: { disposition: "pending", reviewedAt: null, reason: null },
    security: { disposition: "pending", reviewedAt: null, reason: null },
    facts: { disposition: "pending", reviewedAt: null, reason: null }
  };
}

function buildProvenance({ source, content, removedFields, capturedAt, evidenceDigest }) {
  const sanitizedDigest = digestObject({ content, removedFields });
  return {
    producer: INCIDENT_PRODUCER,
    method: "model-free",
    capturedAt: timestamp(capturedAt ?? new Date().toISOString(), "incident.provenance.capturedAt"),
    evidenceDigest: evidenceDigest === undefined
      ? digestObject({ source, content, sanitizedDigest })
      : digest(evidenceDigest, "incident.provenance.evidenceDigest"),
    sanitization: {
      mode: "sanitized",
      rawExcluded: true,
      removedFields: [...removedFields].sort(),
      sanitizedDigest
    }
  };
}

function buildReport({ incidentId, revision, contentInfo, source, provenance, reviews = initialReviews() }) {
  const content = cloneJson(contentInfo.content);
  const normalizedSource = normalizeSource(source);
  const normalizedProvenance = normalizeProvenance(provenance, content);
  const normalizedReviews = normalizeReviews(reviews);
  const core = {
    schemaVersion: INCIDENT_SCHEMA_VERSION,
    kind: INCIDENT_REPORT_KIND,
    incidentId: safeId(incidentId, "incident.incidentId"),
    revision: boundedInteger(revision, "incident.revision", 1, INCIDENT_LIMITS.maxRevisionCount),
    status: INCIDENT_STATUS,
    content,
    source: normalizedSource,
    provenance: normalizedProvenance,
    reviews: normalizedReviews
  };
  return seal(core, "revisionDigest");
}

export function validateIncidentReportV1(value, options = {}) {
  assertOptionsKeys(options, new Set(["deadlineMs"]), "validateIncidentReportV1 options");
  const checkDeadline = beginDeadline(options.deadlineMs, "incident.validate");
  exactKeys(value, REPORT_KEYS, "incident report");
  requireKeys(value, [...REPORT_KEYS], "incident report");
  if (value.schemaVersion !== INCIDENT_SCHEMA_VERSION || value.kind !== INCIDENT_REPORT_KIND || value.status !== INCIDENT_STATUS) fail("EINCIDENT_INVALID", "incident report kind, version, or status is unsupported");
  const incidentId = safeId(value.incidentId, "incident.incidentId");
  const revision = boundedInteger(value.revision, "incident.revision", 1, INCIDENT_LIMITS.maxRevisionCount);
  const contentInfo = normalizeContent(value.content, checkDeadline);
  const source = normalizeSource(value.source);
  const provenance = normalizeProvenance(value.provenance, contentInfo.content);
  const reviews = normalizeReviews(value.reviews);
  const core = { schemaVersion: INCIDENT_SCHEMA_VERSION, kind: INCIDENT_REPORT_KIND, incidentId, revision, status: INCIDENT_STATUS, content: contentInfo.content, source, provenance, reviews };
  if (value.revisionDigest !== digestObject(core)) fail("EINCIDENT_INTEGRITY", "incident revision digest is stale");
  checkDeadline();
  return deepFreeze({ ...core, revisionDigest: value.revisionDigest });
}

function normalizePreparationArtifact(value) {
  exactKeys(value, ARTIFACT_KEYS, "incident preparation.artifact");
  requireKeys(value, [...ARTIFACT_KEYS], "incident preparation.artifact");
  const content = {
    title: exportedText(value.title, "incident preparation.artifact.title", INCIDENT_LIMITS.maxTitleBytes),
    summary: exportedText(value.summary, "incident preparation.artifact.summary", INCIDENT_LIMITS.maxSummaryBytes),
    facts: arrayValues(value.facts, "incident preparation.artifact.facts", INCIDENT_LIMITS.maxFactCount).map((item, index) => exportedText(item, `incident preparation.artifact.facts[${index}]`, INCIDENT_LIMITS.maxFactBytes)),
    impact: value.impact === null ? null : exportedText(value.impact, "incident preparation.artifact.impact", INCIDENT_LIMITS.maxSummaryBytes, { empty: true }),
    contentDigest: digest(value.contentDigest, "incident preparation.artifact.contentDigest")
  };
  if (content.facts.length === 0) fail("EINCIDENT_INVALID", "incident preparation artifact facts must not be empty");
  const withoutDigest = { title: content.title, summary: content.summary, facts: content.facts, impact: content.impact };
  if (content.contentDigest !== digestObject(withoutDigest)) fail("EINCIDENT_INTEGRITY", "incident preparation artifact content digest is stale");
  return content;
}

export function validateIncidentPublicationPreparationV1(value, options = {}) {
  assertOptionsKeys(options, new Set(["deadlineMs"]), "validateIncidentPublicationPreparationV1 options");
  const checkDeadline = beginDeadline(options.deadlineMs, "incident.prepare.validate");
  exactKeys(value, PREPARATION_KEYS, "incident publication preparation");
  requireKeys(value, [...PREPARATION_KEYS], "incident publication preparation");
  if (value.schemaVersion !== INCIDENT_SCHEMA_VERSION || value.kind !== INCIDENT_PREPARATION_KIND) fail("EINCIDENT_INVALID", "incident preparation kind or version is unsupported");
  if (value.status !== INCIDENT_STATUS || value.publicationState !== "PREPARED" || value.published !== false || value.authority !== "local-advisory-only") fail("EINCIDENT_INVALID", "incident preparation is not an unpublished advisory receipt");
  const incidentId = safeId(value.incidentId, "incident preparation.incidentId");
  const incidentRevision = boundedInteger(value.incidentRevision, "incident preparation.incidentRevision", 1, INCIDENT_LIMITS.maxRevisionCount);
  const incidentDigest = digest(value.incidentDigest, "incident preparation.incidentDigest");
  const source = value.source === null ? null : normalizeSource(value.source);
  const target = normalizeTarget(value.target);
  const targetDigest = digest(value.targetDigest, "incident preparation.targetDigest");
  if (targetDigest !== digestObject(target)) fail("EINCIDENT_INTEGRITY", "incident preparation target digest is stale");
  const reviewDigest = digest(value.reviewDigest, "incident preparation.reviewDigest");
  const artifact = normalizePreparationArtifact(value.artifact);
  exactKeys(value.disclosure, DISCLOSURE_KEYS, "incident preparation.disclosure");
  requireKeys(value.disclosure, ["mode", "rawExcluded"], "incident preparation.disclosure");
  if (value.disclosure.mode !== "sanitized" || value.disclosure.rawExcluded !== true) fail("EINCIDENT_INVALID", "incident preparation disclosure is not sanitized");
  const preparedAt = timestamp(value.preparedAt, "incident preparation.preparedAt");
  const core = {
    schemaVersion: INCIDENT_SCHEMA_VERSION,
    kind: INCIDENT_PREPARATION_KIND,
    incidentId,
    incidentRevision,
    incidentDigest,
    source,
    target,
    targetDigest,
    reviewDigest,
    artifact,
    disclosure: { mode: "sanitized", rawExcluded: true },
    status: INCIDENT_STATUS,
    publicationState: "PREPARED",
    published: false,
    authority: "local-advisory-only",
    preparedAt
  };
  if (value.preparationDigest !== digestObject(core)) fail("EINCIDENT_INTEGRITY", "incident preparation digest is stale");
  checkDeadline();
  return deepFreeze({ ...core, preparationDigest: value.preparationDigest });
}

export function incidentStoreRoot(stateRoot = getStateRoot()) {
  return safeJoin(stateRootPath(stateRoot), INCIDENT_STORE_DIRECTORY);
}

export function createIncidentReadPermissionV1({ stateRoot = getStateRoot(), incidentId = null, revision = null } = {}) {
  const root = stateRootPath(stateRoot);
  if (incidentId !== null) safeId(incidentId, "incident read permission.incidentId");
  if (revision !== null) boundedInteger(revision, "incident read permission.revision", 1, INCIDENT_LIMITS.maxRevisionCount);
  return capability({ kind: "IncidentReadPermissionV1", stateRoot: root, incidentId, revision }, READ_PERMISSIONS);
}

export function createIncidentFirstReportPermissionV1({ stateRoot = getStateRoot(), incidentId } = {}) {
  const root = stateRootPath(stateRoot);
  safeId(incidentId, "incident first report permission.incidentId");
  return capability({ kind: "IncidentFirstReportPermissionV1", stateRoot: root, incidentId, expectedRevision: 0 }, FIRST_PERMISSIONS);
}

export function createIncidentRevisionPermissionV1({ stateRoot = getStateRoot(), incidentId, expectedRevision } = {}) {
  const root = stateRootPath(stateRoot);
  safeId(incidentId, "incident revision permission.incidentId");
  boundedInteger(expectedRevision, "incident revision permission.expectedRevision", 1, INCIDENT_LIMITS.maxRevisionCount - 1);
  return capability({ kind: "IncidentRevisionPermissionV1", stateRoot: root, incidentId, expectedRevision }, REVISION_PERMISSIONS);
}

export function createIncidentReviewPermissionV1({ stateRoot = getStateRoot(), incidentId, expectedRevision, role } = {}) {
  const root = stateRootPath(stateRoot);
  safeId(incidentId, "incident review permission.incidentId");
  boundedInteger(expectedRevision, "incident review permission.expectedRevision", 1, INCIDENT_LIMITS.maxRevisionCount - 1);
  if (!["privacy", "security", "facts"].includes(role)) fail("EINCIDENT_INVALID", "incident review permission role is unsupported");
  return capability({ kind: "IncidentReviewPermissionV1", stateRoot: root, incidentId, expectedRevision, role }, REVIEW_PERMISSIONS);
}

export function createIncidentPreparePermissionV1({ stateRoot = getStateRoot(), incidentId, revision, target } = {}) {
  const root = stateRootPath(stateRoot);
  safeId(incidentId, "incident prepare permission.incidentId");
  boundedInteger(revision, "incident prepare permission.revision", 1, INCIDENT_LIMITS.maxRevisionCount);
  const normalizedTarget = normalizeTarget(target);
  return capability({
    kind: "IncidentPreparePermissionV1",
    stateRoot: root,
    incidentId,
    revision,
    target: normalizedTarget,
    targetDigest: digestObject(normalizedTarget)
  }, PREPARE_PERMISSIONS);
}

function createMutationPermission({ stateRoot = getStateRoot(), incidentId, expectedRevision }, kind, set, label) {
  const root = stateRootPath(stateRoot);
  safeId(incidentId, `${label}.incidentId`);
  boundedInteger(expectedRevision, `${label}.expectedRevision`, 1, INCIDENT_LIMITS.maxRevisionCount);
  return capability({ kind, stateRoot: root, incidentId, expectedRevision }, set);
}

export function createIncidentRevokePermissionV1(options = {}) {
  return createMutationPermission(options, "IncidentRevokePermissionV1", REVOKE_PERMISSIONS, "incident revoke permission");
}

export function createIncidentDeletePermissionV1(options = {}) {
  return createMutationPermission(options, "IncidentDeletePermissionV1", DELETE_PERMISSIONS, "incident delete permission");
}

async function optionalStat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    fail("EINCIDENT_FS", "incident storage path could not be inspected");
  }
}

async function assertExistingPath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("EINCIDENT_FS", "incident path escapes state root");
  const rootInfo = await optionalStat(resolvedRoot);
  if (!rootInfo) return false;
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail("EINCIDENT_FS", "incident state root is unsafe");
  let current = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await optionalStat(current);
    if (!info) return false;
    if (info.isSymbolicLink()) fail("EINCIDENT_FS", "incident path contains a symlink");
  }
  return true;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (error instanceof IncidentError) throw error;
    fail("EINCIDENT_FS", "incident directory sync failed");
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function atomicWriteIncidentJson(root, target, value, label = "incident record") {
  await assertIncidentPathNoSymlink(root, target, label);
  try {
    await atomicWriteJson(root, target, value);
  } catch (error) {
    if (error instanceof IncidentError) throw error;
    failUnsafePath(`${label} could not be written`);
  }
}

async function ensureStore(root) {
  const store = incidentStoreRoot(root);
  await ensureIncidentPrivateDir(root, store, "incident store");
  const incidents = safeJoin(store, "incidents");
  const locks = safeJoin(store, "locks");
  await ensureIncidentPrivateDir(root, incidents, "incident list root");
  await ensureIncidentPrivateDir(root, locks, "incident lock root");
  return store;
}

function incidentPaths(root, incidentId) {
  const store = incidentStoreRoot(root);
  const nodeDir = safeJoin(store, "incidents", incidentId);
  return {
    store,
    nodeDir,
    revisions: safeJoin(nodeDir, "revisions"),
    preparations: safeJoin(nodeDir, "preparations"),
    index: safeJoin(nodeDir, "index.json"),
    tombstone: safeJoin(nodeDir, "tombstone.json"),
    lock: safeJoin(store, "locks", `${incidentId}.lock`)
  };
}

async function readRegularJson(root, target, label, { allowMissing = false, maxBytes = INCIDENT_LIMITS.maxRecordBytes } = {}) {
  const present = await assertExistingPath(root, target);
  if (!present) {
    if (allowMissing) return null;
    fail("EINCIDENT_NOT_FOUND", "incident record does not exist");
  }
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) fail("EINCIDENT_FS", "incident record is not a regular single-link file");
    if (info.size > maxBytes) fail("EINCIDENT_LIMIT", "incident record exceeds the bounded record size");
    const text = await handle.readFile("utf8");
    try {
      return JSON.parse(text);
    } catch {
      fail("EINCIDENT_INTEGRITY", "incident record is not valid JSON");
    }
  } catch (error) {
    if (error instanceof IncidentError) throw error;
    if (error.code === "ENOENT" && allowMissing) return null;
    fail("EINCIDENT_FS", "incident record could not be read");
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function writeCreateOnlyJson(root, target, value, checkDeadline) {
  const parent = path.dirname(target);
  await assertIncidentPathNoSymlink(root, parent, "incident immutable parent");
  await ensureIncidentPrivateDir(root, parent, "incident immutable parent");
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > INCIDENT_LIMITS.maxRecordBytes) fail("EINCIDENT_LIMIT", "incident record exceeds the bounded record size");
  const temp = safeJoin(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(temp, flags, 0o600);
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temp, 0o600);
    checkDeadline();
    try {
      await link(temp, target);
    } catch (error) {
      if (error.code === "EEXIST") fail("EINCIDENT_CONFLICT", "incident immutable file already exists");
      fail("EINCIDENT_FS", "incident immutable file could not be linked");
    }
    await unlink(temp);
    await syncDirectory(parent);
  } catch (error) {
    if (error instanceof IncidentError) throw error;
    fail("EINCIDENT_FS", "incident immutable file could not be written");
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temp).catch((error) => {
      if (error.code !== "ENOENT") fail("EINCIDENT_FS", "incident temporary file could not be removed");
    });
  }
}

async function acquireIncidentLock(root, incidentId, checkDeadline) {
  const paths = incidentPaths(root, incidentId);
  await assertIncidentPathNoSymlink(root, paths.lock, "incident lock");
  await ensureIncidentPrivateDir(root, path.dirname(paths.lock), "incident lock root");
  const token = randomUUID();
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  let created = false;
  try {
    handle = await open(paths.lock, flags, 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, kind: "IncidentLockV1", incidentId, token })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(paths.lock, 0o600);
    await syncDirectory(path.dirname(paths.lock));
    checkDeadline();
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (created) await unlink(paths.lock).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") fail("EINCIDENT_FS", "incident lock cleanup failed");
    });
    if (error.code === "EEXIST") fail("EINCIDENT_LOCKED", "incident is already being changed");
    if (error instanceof IncidentError) throw error;
    fail("EINCIDENT_FS", "incident lock could not be acquired");
  }
  return {
    async release() {
      try {
        const current = await readRegularJson(root, paths.lock, "incident lock", { maxBytes: 4 * 1024 });
        if (current?.incidentId !== incidentId || current?.token !== token) return;
        await unlink(paths.lock);
        await syncDirectory(path.dirname(paths.lock));
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof IncidentError)) fail("EINCIDENT_FS", "incident lock could not be released");
        if (error instanceof IncidentError) throw error;
      }
    }
  };
}

function assertAbortSignal(value, label) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function" || typeof value.removeEventListener !== "function") {
    fail("EINCIDENT_INVALID", `${label} must be an AbortSignal`);
  }
  return value;
}

function incidentDeadlineError(label, deadlineMs) {
  return new IncidentError(
    "EINCIDENT_DEADLINE",
    `${label} exceeded the ${deadlineMs}ms deadline`,
    { status: "UNKNOWN" }
  );
}

function attachPendingSettlement(error, settlement) {
  Object.defineProperty(error, "pendingSettlement", {
    value: Promise.resolve(settlement),
    enumerable: false,
    configurable: false,
    writable: false
  });
  return error;
}

/**
 * Serialize a final owned launch against all incident mutations for one
 * incident, then verify that the latest revision is still the exact planned
 * revision before invoking the caller's already-authorized operation.
 *
 * The callback is deliberately only a lock-scoped operation. This helper does
 * not create an owner decision, attest content, or authorize an effect. Every
 * incident mutation uses acquireIncidentLock(), so a revision writer that wins
 * first makes this check stale, while a launch that wins first orders the
 * revision after its final transaction.
 */
export async function withIncidentRevisionLaunchFenceV1(options = {}) {
  assertOptionsKeys(options, new Set([
    "stateRoot", "incidentId", "expectedRevision", "expectedDigest", "deadlineMs", "abortSignal", "callback"
  ]), "withIncidentRevisionLaunchFenceV1 options", [
    "stateRoot", "incidentId", "expectedRevision", "expectedDigest", "callback"
  ]);
  const root = stateRootPath(options.stateRoot);
  const incidentId = safeId(options.incidentId, "incident launch fence.incidentId");
  const expectedRevision = boundedInteger(options.expectedRevision, "incident launch fence.expectedRevision", 1, INCIDENT_LIMITS.maxRevisionCount);
  const expectedDigest = digest(options.expectedDigest, "incident launch fence.expectedDigest");
  if (typeof options.callback !== "function") fail("EINCIDENT_INVALID", "incident launch fence callback is invalid");
  const abortSignal = assertAbortSignal(options.abortSignal, "incident launch fence.abortSignal");
  const deadlineMs = options.deadlineMs === undefined
    ? INCIDENT_LIMITS.maxDeadlineMs
    : boundedInteger(options.deadlineMs, "incident.launch-fence.deadlineMs", 1, INCIDENT_LIMITS.maxDeadlineMs);
  const startedAt = Date.now();
  const checkDeadline = () => {
    if (Date.now() - startedAt >= deadlineMs) throw incidentDeadlineError("incident.launch-fence", deadlineMs);
  };
  if (abortSignal?.aborted) fail("EINCIDENT_ABORTED", "incident launch fence was aborted", { status: "UNKNOWN" });
  await ensureStore(root);
  checkDeadline();
  if (abortSignal?.aborted) fail("EINCIDENT_ABORTED", "incident launch fence was aborted", { status: "UNKNOWN" });
  const lock = await acquireIncidentLock(root, incidentId, checkDeadline);
  let detachedSettlement = false;
  let callbackController = null;
  let callbackAbortListener = null;
  let timer = null;
  let timeoutTriggered = false;
  let abortTriggered = false;
  try {
    checkDeadline();
    if (abortSignal?.aborted) fail("EINCIDENT_ABORTED", "incident launch fence was aborted", { status: "UNKNOWN" });
    const current = await readCurrentSnapshot(root, incidentId, checkDeadline);
    if (current.latest.report.revision !== expectedRevision || current.latest.digest !== expectedDigest) {
      fail("EINCIDENT_RECOVERY_STALE", "incident revision changed before the final owned launch boundary", { status: "HOLD" });
    }
    if (abortSignal?.aborted) fail("EINCIDENT_ABORTED", "incident launch fence was aborted", { status: "UNKNOWN" });
    callbackController = new AbortController();
    const callbackPromise = Promise.resolve().then(() => {
      if (callbackController.signal.aborted) {
        fail("EINCIDENT_ABORTED", "incident launch fence callback was aborted", { status: "UNKNOWN" });
      }
      return options.callback({ signal: callbackController.signal });
    });
    callbackPromise.catch(() => {});
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timeoutTriggered = true;
        const error = incidentDeadlineError("incident.launch-fence", deadlineMs);
        reject(error);
      }, deadlineMs);
    });
    let abortPromise = null;
    if (abortSignal) {
      abortPromise = new Promise((_, reject) => {
        const onAbort = () => {
          abortTriggered = true;
          callbackController.abort();
          reject(new IncidentError("EINCIDENT_ABORTED", "incident launch fence was aborted", { status: "UNKNOWN" }));
        };
        callbackAbortListener = onAbort;
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener("abort", onAbort, { once: true });
      });
    }
    let result;
    try {
      result = await Promise.race(abortPromise ? [callbackPromise, timeoutPromise, abortPromise] : [callbackPromise, timeoutPromise]);
      if (Date.now() - startedAt >= deadlineMs) {
        timeoutTriggered = true;
        throw incidentDeadlineError("incident.launch-fence", deadlineMs);
      }
      return result;
    } catch (error) {
      if (!timeoutTriggered && !abortTriggered) throw error;
      detachedSettlement = true;
      callbackController.abort();
      const pendingSettlement = (async () => {
        try {
          await callbackPromise;
        } catch {
          // The callback result is unusable once the fence deadline/abort
          // wins.  Its settlement is still required before releasing the
          // incident lock because arbitrary JS cannot be forcibly cancelled.
        } finally {
          await lock.release();
        }
      })();
      pendingSettlement.catch(() => {});
      attachPendingSettlement(error, pendingSettlement);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (abortSignal && callbackAbortListener) abortSignal.removeEventListener("abort", callbackAbortListener);
    }
  } finally {
    if (callbackController) callbackController.abort();
    if (!detachedSettlement) await lock.release();
  }
}

function validateIndex(value, incidentId) {
  exactKeys(value, INDEX_KEYS, "incident index");
  requireKeys(value, [...INDEX_KEYS], "incident index");
  if (value.schemaVersion !== INCIDENT_SCHEMA_VERSION || value.kind !== INCIDENT_INDEX_KIND || value.incidentId !== incidentId) fail("EINCIDENT_INTEGRITY", "incident index identity is invalid");
  const status = value.status;
  if (status !== INCIDENT_STATUS && status !== "REVOKED") fail("EINCIDENT_INTEGRITY", "incident index status is invalid");
  const core = {
    schemaVersion: INCIDENT_SCHEMA_VERSION,
    kind: INCIDENT_INDEX_KIND,
    incidentId,
    status,
    latestRevision: boundedInteger(value.latestRevision, "incident index.latestRevision", 1, INCIDENT_LIMITS.maxRevisionCount),
    latestDigest: digest(value.latestDigest, "incident index.latestDigest"),
    tombstoneDigest: value.tombstoneDigest === null ? null : digest(value.tombstoneDigest, "incident index.tombstoneDigest")
  };
  if (value.indexDigest !== digestObject(core)) fail("EINCIDENT_INTEGRITY", "incident index digest is stale");
  if (status === INCIDENT_STATUS && core.tombstoneDigest !== null) fail("EINCIDENT_INTEGRITY", "active incident index has a tombstone");
  if (status === "REVOKED" && core.tombstoneDigest === null) fail("EINCIDENT_INTEGRITY", "revoked incident index lacks a tombstone");
  return deepFreeze({ ...core, indexDigest: value.indexDigest });
}

function validateTombstone(value, incidentId) {
  exactKeys(value, TOMBSTONE_KEYS, "incident tombstone");
  requireKeys(value, [...TOMBSTONE_KEYS], "incident tombstone");
  if (value.schemaVersion !== INCIDENT_SCHEMA_VERSION || value.kind !== INCIDENT_TOMBSTONE_KIND || value.incidentId !== incidentId) fail("EINCIDENT_INTEGRITY", "incident tombstone identity is invalid");
  const core = {
    schemaVersion: INCIDENT_SCHEMA_VERSION,
    kind: INCIDENT_TOMBSTONE_KIND,
    incidentId,
    action: value.action,
    revision: boundedInteger(value.revision, "incident tombstone.revision", 1, INCIDENT_LIMITS.maxRevisionCount),
    revisionDigest: digest(value.revisionDigest, "incident tombstone.revisionDigest"),
    at: timestamp(value.at, "incident tombstone.at"),
    reason: exportedText(value.reason, "incident tombstone.reason", INCIDENT_LIMITS.maxReviewReasonBytes)
  };
  if (!["revoke", "delete"].includes(core.action)) fail("EINCIDENT_INTEGRITY", "incident tombstone action is invalid");
  if (value.tombstoneDigest !== digestObject(core)) fail("EINCIDENT_INTEGRITY", "incident tombstone digest is stale");
  return deepFreeze({ ...core, tombstoneDigest: value.tombstoneDigest });
}

async function listRevisionFiles(root, revisions, checkDeadline) {
  const present = await assertExistingPath(root, revisions);
  if (!present) fail("EINCIDENT_INTEGRITY", "incident revisions directory is missing");
  const info = await optionalStat(revisions);
  if (!info) fail("EINCIDENT_INTEGRITY", "incident revisions directory is missing");
  if (info.isSymbolicLink() || !info.isDirectory()) fail("EINCIDENT_FS", "incident revisions path is unsafe");
  let entries;
  try {
    entries = await readdir(revisions, { withFileTypes: true });
  } catch (error) {
    if (error instanceof IncidentError) throw error;
    failUnsafePath("incident revisions directory could not be read");
  }
  if (entries.length > INCIDENT_LIMITS.maxRevisionCount) fail("EINCIDENT_LIMIT", "incident revision count exceeds the bounded limit");
  const files = [];
  for (const entry of entries) {
    checkDeadline();
    if (entry.isSymbolicLink() || !entry.isFile() || !REVISION_FILE.test(entry.name)) fail("EINCIDENT_INTEGRITY", "invalid incident revision entry");
    const revision = Number(entry.name.slice(0, -5));
    files.push({ revision, path: safeJoin(revisions, entry.name) });
  }
  return files.sort((left, right) => left.revision - right.revision);
}

async function readCurrentSnapshot(root, incidentId, checkDeadline, { allowMissing = false, requestedRevision = null } = {}) {
  const paths = incidentPaths(root, incidentId);
  const nodePresent = await assertExistingPath(root, paths.nodeDir);
  if (!nodePresent) {
    if (allowMissing) return null;
    fail("EINCIDENT_NOT_FOUND", "incident does not exist");
  }
  const nodeInfo = await optionalStat(paths.nodeDir);
  if (!nodeInfo) {
    if (allowMissing) return null;
    fail("EINCIDENT_NOT_FOUND", "incident does not exist");
  }
  if (nodeInfo.isSymbolicLink() || !nodeInfo.isDirectory()) fail("EINCIDENT_FS", "incident directory is unsafe");
  const tombstoneRaw = await readRegularJson(root, paths.tombstone, "incident tombstone", { allowMissing: true });
  checkDeadline();
  if (tombstoneRaw !== null) {
    const tombstone = validateTombstone(tombstoneRaw, incidentId);
    const indexRaw = await readRegularJson(root, paths.index, "incident index");
    const index = validateIndex(indexRaw, incidentId);
    if (index.status !== "REVOKED" || index.tombstoneDigest !== tombstone.tombstoneDigest || index.latestRevision !== tombstone.revision || index.latestDigest !== tombstone.revisionDigest) {
      fail("EINCIDENT_INTEGRITY", "revoked incident index does not match its tombstone");
    }
    fail("EINCIDENT_REVOKED", "incident is permanently revoked");
  }
  const indexRaw = await readRegularJson(root, paths.index, "incident index");
  const index = validateIndex(indexRaw, incidentId);
  if (index.status !== INCIDENT_STATUS || index.tombstoneDigest !== null) fail("EINCIDENT_INTEGRITY", "active incident index is invalid");
  const files = await listRevisionFiles(root, paths.revisions, checkDeadline);
  if (files.length !== index.latestRevision || files.some((file, indexValue) => file.revision !== indexValue + 1)) fail("EINCIDENT_INTEGRITY", "incident revisions are not contiguous");
  const records = [];
  for (const file of files) {
    checkDeadline();
    const raw = await readRegularJson(root, file.path, `incident revision ${file.revision}`);
    const report = validateIncidentReportV1(raw);
    if (report.incidentId !== incidentId || report.revision !== file.revision) fail("EINCIDENT_INTEGRITY", "incident revision identity changed");
    if (report.revisionDigest !== digestObject({ ...report, revisionDigest: undefined })) fail("EINCIDENT_INTEGRITY", "incident revision digest is not canonical");
    records.push({ report, digest: report.revisionDigest, path: file.path });
  }
  const latest = records.at(-1);
  if (!latest || latest.digest !== index.latestDigest || index.latestRevision !== latest.report.revision) fail("EINCIDENT_INTEGRITY", "incident index does not bind the latest revision");
  const chosen = requestedRevision === null ? latest : records.find((record) => record.report.revision === requestedRevision);
  if (!chosen) fail("EINCIDENT_NOT_FOUND", "incident revision does not exist");
  return { paths, index, latest, chosen, records };
}

function assertReadPermission(permission, root, incidentId, revision = null) {
  assertCapability(permission, READ_PERMISSIONS, "incident read permission");
  assertPermissionRoot(permission, root, "incident read permission");
  if (permission.incidentId !== null && permission.incidentId !== incidentId) fail("EINCIDENT_PERMISSION", "incident read permission is bound to a different incident");
  if (permission.revision !== null && revision !== null && permission.revision !== revision) fail("EINCIDENT_PERMISSION", "incident read permission is bound to a different revision");
}

function assertMutationPermission(permission, set, root, incidentId, label) {
  assertCapability(permission, set, label);
  assertPermissionRoot(permission, root, label);
  assertPermissionIncident(permission, incidentId, label);
}

async function persistNewRevision({ root, incidentId, report, expectedRevision, permission, permissionSet, usedPermissions, operation, deadlineMs }) {
  const startedAt = Date.now();
  const checkDeadline = beginDeadline(deadlineMs, `incident.${operation}`, startedAt);
  if (usedPermissions.has(permission)) fail("EINCIDENT_PERMISSION", `${operation} permission has already been consumed`);
  await ensureStore(root);
  checkDeadline();
  const lock = await acquireIncidentLock(root, incidentId, checkDeadline);
  try {
    const current = await readCurrentSnapshot(root, incidentId, checkDeadline, { allowMissing: true });
    if (expectedRevision === 0) {
      if (current !== null || report.revision !== 1) fail("EINCIDENT_STALE", "initial incident report has a stale revision expectation");
    } else {
      if (current === null) fail("EINCIDENT_NOT_FOUND", "incident does not exist");
      if (current.latest.report.revision !== expectedRevision) fail("EINCIDENT_STALE", "incident expectedRevision is stale");
      if (report.revision !== current.latest.report.revision + 1) fail("EINCIDENT_STALE", "incident revision must advance exactly once");
    }
    const paths = incidentPaths(root, incidentId);
    await ensureIncidentPrivateDir(root, paths.nodeDir, "incident directory");
    await ensureIncidentPrivateDir(root, paths.revisions, "incident revisions directory");
    await writeCreateOnlyJson(root, safeJoin(paths.revisions, `${report.revision}.json`), report, checkDeadline);
    const index = seal({
      schemaVersion: INCIDENT_SCHEMA_VERSION,
      kind: INCIDENT_INDEX_KIND,
      incidentId,
      status: INCIDENT_STATUS,
      latestRevision: report.revision,
      latestDigest: report.revisionDigest,
      tombstoneDigest: null
    }, "indexDigest");
    await assertIncidentPathNoSymlink(root, paths.index, "incident index");
    await atomicWriteIncidentJson(root, paths.index, index, "incident index");
    checkDeadline();
    const verified = await readCurrentSnapshot(root, incidentId, checkDeadline);
    if (verified.latest.digest !== report.revisionDigest) fail("EINCIDENT_INTEGRITY", "saved incident revision did not verify");
    usedPermissions.add(permission);
    return deepFreeze({
      ok: true,
      operation: `incident.${operation}`,
      incidentId,
      revision: report.revision,
      incidentDigest: report.revisionDigest,
      status: INCIDENT_STATUS,
      publication: "not-published",
      authority: "local-advisory-only",
      path: safeJoin(paths.revisions, `${report.revision}.json`)
    });
  } finally {
    await lock.release();
  }
}

function prepareContent({ content, source, capturedAt, evidenceDigest, checkDeadline = () => undefined }) {
  const contentInfo = normalizeContent(content, checkDeadline);
  const provenance = buildProvenance({ source, content: contentInfo.content, removedFields: contentInfo.removedFields, capturedAt, evidenceDigest });
  return { contentInfo, provenance };
}

export async function createIncidentFirstReportV1(options = {}) {
  assertOptionsKeys(options, new Set(["stateRoot", "incidentId", "content", "source", "capturedAt", "evidenceDigest", "permission", "deadlineMs"]), "createIncidentFirstReportV1 options", ["incidentId", "content", "source", "permission"]);
  const root = stateRootPath(options.stateRoot);
  const incidentId = safeId(options.incidentId, "createIncidentFirstReportV1.incidentId");
  assertMutationPermission(options.permission, FIRST_PERMISSIONS, root, incidentId, "incident first report permission");
  if (options.permission.expectedRevision !== 0) fail("EINCIDENT_PERMISSION", "first report permission must expect revision zero");
  const checkDeadline = beginDeadline(options.deadlineMs, "incident.first-report");
  const prepared = prepareContent({ content: options.content, source: options.source, capturedAt: options.capturedAt, evidenceDigest: options.evidenceDigest, checkDeadline });
  checkDeadline();
  const report = buildReport({ incidentId, revision: 1, contentInfo: prepared.contentInfo, source: options.source, provenance: prepared.provenance });
  return persistNewRevision({ root, incidentId, report, expectedRevision: 0, permission: options.permission, permissionSet: FIRST_PERMISSIONS, usedPermissions: USED_FIRST_PERMISSIONS, operation: "report", deadlineMs: options.deadlineMs });
}

export async function createIncidentRevisionV1(options = {}) {
  assertOptionsKeys(options, new Set(["stateRoot", "incidentId", "content", "source", "capturedAt", "evidenceDigest", "permission", "deadlineMs"]), "createIncidentRevisionV1 options", ["incidentId", "content", "source", "permission"]);
  const root = stateRootPath(options.stateRoot);
  const incidentId = safeId(options.incidentId, "createIncidentRevisionV1.incidentId");
  assertMutationPermission(options.permission, REVISION_PERMISSIONS, root, incidentId, "incident revision permission");
  if (USED_REVISION_PERMISSIONS.has(options.permission)) fail("EINCIDENT_PERMISSION", "incident revision permission has already been consumed");
  const checkDeadline = beginDeadline(options.deadlineMs, "incident.revision");
  const prepared = prepareContent({ content: options.content, source: options.source, capturedAt: options.capturedAt, evidenceDigest: options.evidenceDigest, checkDeadline });
  checkDeadline();
  await ensureStore(root);
  const lock = await acquireIncidentLock(root, incidentId, checkDeadline);
  try {
    const current = await readCurrentSnapshot(root, incidentId, checkDeadline);
    if (current.latest.report.revision !== options.permission.expectedRevision) fail("EINCIDENT_STALE", "incident revision permission is stale");
    if (current.latest.report.revision >= INCIDENT_LIMITS.maxRevisionCount) fail("EINCIDENT_LIMIT", "incident revision count exceeds the bounded limit");
    const report = buildReport({ incidentId, revision: current.latest.report.revision + 1, contentInfo: prepared.contentInfo, source: options.source, provenance: prepared.provenance });
    const paths = incidentPaths(root, incidentId);
    await ensureIncidentPrivateDir(root, paths.nodeDir, "incident directory");
    await ensureIncidentPrivateDir(root, paths.revisions, "incident revisions directory");
    await writeCreateOnlyJson(root, safeJoin(paths.revisions, `${report.revision}.json`), report, checkDeadline);
    const index = seal({ schemaVersion: INCIDENT_SCHEMA_VERSION, kind: INCIDENT_INDEX_KIND, incidentId, status: INCIDENT_STATUS, latestRevision: report.revision, latestDigest: report.revisionDigest, tombstoneDigest: null }, "indexDigest");
    await assertIncidentPathNoSymlink(root, paths.index, "incident index");
    await atomicWriteIncidentJson(root, paths.index, index, "incident index");
    const verified = await readCurrentSnapshot(root, incidentId, checkDeadline);
    if (verified.latest.digest !== report.revisionDigest) fail("EINCIDENT_INTEGRITY", "incident revision did not verify");
    USED_REVISION_PERMISSIONS.add(options.permission);
    return deepFreeze({ ok: true, operation: "incident.revision", incidentId, revision: report.revision, incidentDigest: report.revisionDigest, status: INCIDENT_STATUS, publication: "not-published", authority: "local-advisory-only", path: safeJoin(paths.revisions, `${report.revision}.json`) });
  } finally {
    await lock.release();
  }
}

export async function submitIncidentReviewV1(options = {}) {
  assertOptionsKeys(options, new Set(["stateRoot", "incidentId", "review", "permission", "deadlineMs"]), "submitIncidentReviewV1 options", ["incidentId", "review", "permission"]);
  const root = stateRootPath(options.stateRoot);
  const incidentId = safeId(options.incidentId, "submitIncidentReviewV1.incidentId");
  assertMutationPermission(options.permission, REVIEW_PERMISSIONS, root, incidentId, "incident review permission");
  if (USED_REVIEW_PERMISSIONS.has(options.permission)) fail("EINCIDENT_PERMISSION", "incident review permission has already been consumed");
  exactKeys(options.review, new Set(["role", "disposition", "reason"]), "incident review");
  requireKeys(options.review, ["role", "disposition", "reason"], "incident review");
  if (options.review.role !== options.permission.role) fail("EINCIDENT_PERMISSION", "incident review role does not match its capability");
  if (!["approved", "rejected"].includes(options.review.disposition)) fail("EINCIDENT_INVALID", "incident review disposition must be approved or rejected");
  const reason = exportedText(options.review.reason, "incident review.reason", INCIDENT_LIMITS.maxReviewReasonBytes);
  const checkDeadline = beginDeadline(options.deadlineMs, "incident.review");
  await ensureStore(root);
  const lock = await acquireIncidentLock(root, incidentId, checkDeadline);
  try {
    const current = await readCurrentSnapshot(root, incidentId, checkDeadline);
    if (current.latest.report.revision !== options.permission.expectedRevision) fail("EINCIDENT_STALE", "incident review permission is stale");
    if (current.latest.report.revision >= INCIDENT_LIMITS.maxRevisionCount) fail("EINCIDENT_LIMIT", "incident revision count exceeds the bounded limit");
    const reviews = cloneJson(current.latest.report.reviews);
    reviews[options.review.role] = { disposition: options.review.disposition, reviewedAt: new Date().toISOString(), reason };
    const report = buildReport({
      incidentId,
      revision: current.latest.report.revision + 1,
      contentInfo: { content: cloneJson(current.latest.report.content), removedFields: current.latest.report.provenance.sanitization.removedFields, sanitizedDigest: current.latest.report.provenance.sanitization.sanitizedDigest },
      source: current.latest.report.source,
      provenance: current.latest.report.provenance,
      reviews
    });
    const paths = incidentPaths(root, incidentId);
    await writeCreateOnlyJson(root, safeJoin(paths.revisions, `${report.revision}.json`), report, checkDeadline);
    const index = seal({ schemaVersion: INCIDENT_SCHEMA_VERSION, kind: INCIDENT_INDEX_KIND, incidentId, status: INCIDENT_STATUS, latestRevision: report.revision, latestDigest: report.revisionDigest, tombstoneDigest: null }, "indexDigest");
    await assertIncidentPathNoSymlink(root, paths.index, "incident index");
    await atomicWriteIncidentJson(root, paths.index, index, "incident index");
    const verified = await readCurrentSnapshot(root, incidentId, checkDeadline);
    if (verified.latest.digest !== report.revisionDigest) fail("EINCIDENT_INTEGRITY", "incident review revision did not verify");
    USED_REVIEW_PERMISSIONS.add(options.permission);
    return deepFreeze({ ok: true, operation: "incident.review", role: options.review.role, disposition: options.review.disposition, incidentId, revision: report.revision, incidentDigest: report.revisionDigest, status: INCIDENT_STATUS, publication: "not-published", authority: "local-advisory-only", path: safeJoin(paths.revisions, `${report.revision}.json`) });
  } finally {
    await lock.release();
  }
}

function allReviewsApproved(reviews) {
  return Object.values(reviews).every((review) => review.disposition === "approved");
}

export async function prepareIncidentPublicationV1(options = {}) {
  assertOptionsKeys(options, new Set(["stateRoot", "incidentId", "permission", "deadlineMs"]), "prepareIncidentPublicationV1 options", ["incidentId", "permission"]);
  const root = stateRootPath(options.stateRoot);
  const incidentId = safeId(options.incidentId, "prepareIncidentPublicationV1.incidentId");
  assertMutationPermission(options.permission, PREPARE_PERMISSIONS, root, incidentId, "incident prepare permission");
  if (USED_PREPARE_PERMISSIONS.has(options.permission)) fail("EINCIDENT_PERMISSION", "incident prepare permission has already been consumed");
  const checkDeadline = beginDeadline(options.deadlineMs, "incident.prepare");
  await ensureStore(root);
  const lock = await acquireIncidentLock(root, incidentId, checkDeadline);
  try {
    const snapshot = await readCurrentSnapshot(root, incidentId, checkDeadline, { requestedRevision: options.permission.revision });
    if (snapshot.latest.report.revision !== options.permission.revision || snapshot.chosen.digest !== snapshot.latest.digest) fail("EINCIDENT_STALE", "incident prepare permission is stale");
    if (!allReviewsApproved(snapshot.latest.report.reviews)) fail("EINCIDENT_REVIEW_REQUIRED", "privacy, security, and facts review must all be approved before preparation");
    const content = snapshot.latest.report.content;
    const artifact = {
      title: content.title,
      summary: content.summary,
      facts: [...content.facts],
      impact: content.impact,
      contentDigest: digestObject(content)
    };
    const core = {
      schemaVersion: INCIDENT_SCHEMA_VERSION,
      kind: INCIDENT_PREPARATION_KIND,
      incidentId,
      incidentRevision: snapshot.latest.report.revision,
      incidentDigest: snapshot.latest.digest,
      source: snapshot.latest.report.source,
      target: options.permission.target,
      targetDigest: options.permission.targetDigest,
      reviewDigest: digestObject(snapshot.latest.report.reviews),
      artifact,
      disclosure: { mode: "sanitized", rawExcluded: true },
      status: INCIDENT_STATUS,
      publicationState: "PREPARED",
      published: false,
      authority: "local-advisory-only",
      preparedAt: new Date().toISOString()
    };
    const preparation = seal(core, "preparationDigest");
    const paths = incidentPaths(root, incidentId);
    await ensureIncidentPrivateDir(root, paths.nodeDir, "incident directory");
    await ensureIncidentPrivateDir(root, paths.preparations, "incident preparations directory");
    const preparationPath = safeJoin(paths.preparations, `${preparation.preparationDigest}.json`);
    await writeCreateOnlyJson(root, preparationPath, preparation, checkDeadline);
    USED_PREPARE_PERMISSIONS.add(options.permission);
    return deepFreeze({ ok: true, operation: "incident.prepare-publication", incidentId, revision: preparation.incidentRevision, preparationDigest: preparation.preparationDigest, preparation, path: preparationPath, published: false, authority: "local-advisory-only" });
  } finally {
    await lock.release();
  }
}

export async function verifyIncidentPublicationPreparationV1(options = {}) {
  assertOptionsKeys(options, new Set(["stateRoot", "preparation", "target", "preparationPath", "deadlineMs"]), "verifyIncidentPublicationPreparationV1 options", ["preparation", "target"]);
  const root = stateRootPath(options.stateRoot);
  const checkDeadline = beginDeadline(options.deadlineMs, "incident.prepare.verify");
  const preparation = validateIncidentPublicationPreparationV1(options.preparation, { deadlineMs: options.deadlineMs });
  const target = normalizeTarget(options.target);
  if (digestObject(target) !== preparation.targetDigest) fail("EINCIDENT_STALE", "publication target changed after preparation");
  if (options.preparationPath !== undefined) {
    const persisted = validateIncidentPublicationPreparationV1(await readRegularJson(root, options.preparationPath, "incident publication preparation"), { deadlineMs: options.deadlineMs });
    if (persisted.preparationDigest !== preparation.preparationDigest) fail("EINCIDENT_INTEGRITY", "publication preparation receipt does not match its persisted record");
  }
  const snapshot = await readCurrentSnapshot(root, preparation.incidentId, checkDeadline);
  if (snapshot.latest.digest !== preparation.incidentDigest || snapshot.latest.report.revision !== preparation.incidentRevision) fail("EINCIDENT_STALE", "incident content or revision changed after preparation");
  if (digestObject(snapshot.latest.report.source) !== digestObject(preparation.source) || preparation.artifact.contentDigest !== digestObject(snapshot.latest.report.content) || preparation.reviewDigest !== digestObject(snapshot.latest.report.reviews)) {
    fail("EINCIDENT_INTEGRITY", "publication preparation does not bind the current source, content, and review state");
  }
  if (!allReviewsApproved(snapshot.latest.report.reviews)) fail("EINCIDENT_REVIEW_REQUIRED", "incident review is no longer complete");
  checkDeadline();
  return deepFreeze({ ok: true, valid: true, preparationDigest: preparation.preparationDigest, incidentId: preparation.incidentId, revision: preparation.incidentRevision, published: false, authority: "local-advisory-only" });
}

export async function readIncidentV1(options = {}) {
  assertOptionsKeys(options, new Set(["stateRoot", "incidentId", "permission", "deadlineMs"]), "readIncidentV1 options", ["incidentId", "permission"]);
  const root = stateRootPath(options.stateRoot);
  const incidentId = safeId(options.incidentId, "readIncidentV1.incidentId");
  const requestedRevision = options.permission?.revision ?? null;
  assertReadPermission(options.permission, root, incidentId, requestedRevision);
  const checkDeadline = beginDeadline(options.deadlineMs, "incident.read");
  const snapshot = await readCurrentSnapshot(root, incidentId, checkDeadline, { requestedRevision });
  return deepFreeze({ ok: true, incident: snapshot.chosen.report, report: snapshot.chosen.report, incidentDigest: snapshot.chosen.digest, latestRevision: snapshot.latest.report.revision, latestDigest: snapshot.latest.digest, status: INCIDENT_STATUS, path: snapshot.chosen.path });
}

export async function listIncidentsV1(options = {}) {
  assertOptionsKeys(options, new Set(["stateRoot", "permission", "deadlineMs"]), "listIncidentsV1 options", ["permission"]);
  const root = stateRootPath(options.stateRoot);
  assertReadPermission(options.permission, root, "__list__");
  const checkDeadline = beginDeadline(options.deadlineMs, "incident.list");
  const incidentsRoot = safeJoin(incidentStoreRoot(root), "incidents");
  if (!(await assertExistingPath(root, incidentsRoot))) return deepFreeze([]);
  const info = await optionalStat(incidentsRoot);
  if (!info) return deepFreeze([]);
  if (info.isSymbolicLink() || !info.isDirectory()) fail("EINCIDENT_FS", "incident list root is unsafe");
  let entries;
  try {
    entries = await readdir(incidentsRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof IncidentError) throw error;
    failUnsafePath("incident list root could not be read");
  }
  if (entries.length > INCIDENT_LIMITS.maxIncidentCount) fail("EINCIDENT_LIMIT", "incident count exceeds the bounded limit");
  const result = [];
  for (const entry of entries) {
    checkDeadline();
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail("EINCIDENT_INTEGRITY", "invalid incident entry");
    const incidentId = safeId(entry.name, "incident directory");
    try {
      const snapshot = await readCurrentSnapshot(root, incidentId, checkDeadline);
      result.push({ incidentId, revision: snapshot.latest.report.revision, incidentDigest: snapshot.latest.digest, status: INCIDENT_STATUS });
    } catch (error) {
      if (error.code === "EINCIDENT_REVOKED") continue;
      throw error;
    }
  }
  return deepFreeze(result.sort((left, right) => left.incidentId.localeCompare(right.incidentId)));
}

async function revokeInternal({ options, action, permissionSet, usedPermissions, kind }) {
  assertOptionsKeys(options, new Set(["stateRoot", "incidentId", "reason", "permission", "deadlineMs"]), `incident.${action} options`, ["incidentId", "permission"]);
  const root = stateRootPath(options.stateRoot);
  const incidentId = safeId(options.incidentId, `incident.${action}.incidentId`);
  assertMutationPermission(options.permission, permissionSet, root, incidentId, `incident ${action} permission`);
  if (usedPermissions.has(options.permission)) fail("EINCIDENT_PERMISSION", `incident ${action} permission has already been consumed`);
  const reason = exportedText(options.reason ?? `explicit ${action}`, `incident ${action}.reason`, INCIDENT_LIMITS.maxReviewReasonBytes);
  const checkDeadline = beginDeadline(options.deadlineMs, `incident.${action}`);
  await ensureStore(root);
  const lock = await acquireIncidentLock(root, incidentId, checkDeadline);
  try {
    const snapshot = await readCurrentSnapshot(root, incidentId, checkDeadline);
    if (snapshot.latest.report.revision !== options.permission.expectedRevision) fail("EINCIDENT_STALE", `incident ${action} permission is stale`);
    const paths = incidentPaths(root, incidentId);
    const tombstone = seal({ schemaVersion: INCIDENT_SCHEMA_VERSION, kind: INCIDENT_TOMBSTONE_KIND, incidentId, action, revision: snapshot.latest.report.revision, revisionDigest: snapshot.latest.digest, at: new Date().toISOString(), reason }, "tombstoneDigest");
    await writeCreateOnlyJson(root, paths.tombstone, tombstone, checkDeadline);
    const index = seal({ schemaVersion: INCIDENT_SCHEMA_VERSION, kind: INCIDENT_INDEX_KIND, incidentId, status: "REVOKED", latestRevision: snapshot.latest.report.revision, latestDigest: snapshot.latest.digest, tombstoneDigest: tombstone.tombstoneDigest }, "indexDigest");
    await assertIncidentPathNoSymlink(root, paths.index, "incident index");
    await atomicWriteIncidentJson(root, paths.index, index, "incident index");
    const persistedTombstone = validateTombstone(await readRegularJson(root, paths.tombstone, "incident tombstone"), incidentId);
    validateIndex(await readRegularJson(root, paths.index, "incident index"), incidentId);
    if (persistedTombstone.tombstoneDigest !== tombstone.tombstoneDigest) fail("EINCIDENT_INTEGRITY", "incident tombstone did not verify");
    usedPermissions.add(options.permission);
    return deepFreeze({ ok: true, operation: `incident.${action}`, incidentId, revision: snapshot.latest.report.revision, incidentDigest: snapshot.latest.digest, tombstoneDigest: tombstone.tombstoneDigest, status: "REVOKED", audit: "retained", authority: "local-advisory-only" });
  } finally {
    await lock.release();
  }
}

export async function revokeIncidentV1(options = {}) {
  return revokeInternal({ options, action: "revoke", permissionSet: REVOKE_PERMISSIONS, usedPermissions: USED_REVOKE_PERMISSIONS, kind: "IncidentRevokePermissionV1" });
}

export async function deleteIncidentV1(options = {}) {
  return revokeInternal({ options, action: "delete", permissionSet: DELETE_PERMISSIONS, usedPermissions: USED_DELETE_PERMISSIONS, kind: "IncidentDeletePermissionV1" });
}
