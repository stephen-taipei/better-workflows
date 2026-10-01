import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
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
import {
  CALLER_ASSERTED_SOURCE_BINDING_V1,
  LOCAL_SOURCE_BINDING_V1,
  isLocalSourceBindingV1,
  normalizeLocalSourceReferenceV1,
  observeLocalSourceV1
} from "./share-source-observer-v1.mjs";

export const SHARE_SCHEMA_VERSION = 1;
export const SHARE_ARTIFACT_KIND = "ShareArtifactV1";
export const SHARE_EXPORT_KIND = "ShareExportV1";
export const SHARE_INDEX_KIND = "ShareIndexV1";
export const SHARE_TOMBSTONE_KIND = "ShareTombstoneV1";
export const SHARE_CREATE_PERMISSION_KIND = "ShareCreatePermissionV1";
export const SHARE_REVISION_PERMISSION_KIND = "ShareRevisionPermissionV1";
export const SHARE_READ_PERMISSION_KIND = "ShareReadPermissionV1";
export const SHARE_EXPORT_PERMISSION_KIND = "ShareExportPermissionV1";
export const SHARE_REVOKE_PERMISSION_KIND = "ShareRevokePermissionV1";
export const SHARE_EXPIRE_PERMISSION_KIND = "ShareExpirePermissionV1";
export const SHARE_PRODUCER = "better-workflows-share-local-v1";
export const SHARE_STORE_DIRECTORY = "share-v1";
export const SHARE_STATUS = "ACTIVE";
export const SHARE_REVOKED_STATUS = "REVOKED";
export const SHARE_EXPIRY_SCOPE = "future-access-only";
export { CALLER_ASSERTED_SOURCE_BINDING_V1, LOCAL_SOURCE_BINDING_V1, isLocalSourceBindingV1 };

export const SHARE_LIMITS = Object.freeze({
  maxShareCount: 256,
  maxRevisionCount: 32,
  maxIdBytes: 128,
  maxReferenceKindBytes: 64,
  maxReferenceIdBytes: 128,
  maxReferenceRevisionBytes: 256,
  maxTitleBytes: 2 * 1024,
  maxSummaryBytes: 8 * 1024,
  maxFactCount: 32,
  maxFactBytes: 4 * 1024,
  maxSnippetCount: 8,
  maxSnippetBytes: 8 * 1024,
  maxContentBytes: 64 * 1024,
  maxRecordBytes: 128 * 1024,
  maxReasonBytes: 2 * 1024,
  maxSelectionFields: 5,
  maxDeadlineMs: 2_000,
  maxTtlMs: 30 * 24 * 60 * 60 * 1000
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_KIND = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SHA_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID_REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION_FILE = /^[1-9][0-9]{0,2}\.json$/;
const CONTENT_FIELDS = new Set(["title", "summary", "facts", "snippets", "impact"]);
const REF_KEYS = new Set(["kind", "id", "revision", "digest"]);
const SOURCE_BINDING_VALUES = new Set([CALLER_ASSERTED_SOURCE_BINDING_V1, LOCAL_SOURCE_BINDING_V1]);
const CONTENT_KEYS = new Set(["title", "summary", "facts", "snippets", "impact"]);
const SELECTION_KEYS = new Set(["mode", "fields"]);
const PRIVACY_KEYS = new Set(["mode", "status", "rawExcluded", "unknownContent"]);
const REVIEW_KEYS = new Set(["privacy", "security", "facts"]);
const DISCLOSURE_KEYS = new Set(["mode", "rawExcluded", "unknownContent"]);
const PROVENANCE_KEYS = new Set(["producer", "method", "origin", "capturedAt"]);
const PUBLICATION_KEYS = new Set(["state", "published", "remoteShare", "authority"]);
const ARTIFACT_KEYS = new Set([
  "schemaVersion", "kind", "shareId", "revision", "previousArtifactDigest", "source", "target",
  "sourceBinding",
  "content", "contentDigest", "selection", "selectionDigest", "privacy", "privacyDigest", "review",
  "reviewDigest", "disclosure", "provenance", "publication", "status", "createdAt", "expiresAt",
  "expiryScope", "bindingDigest", "artifactDigest"
]);
const REQUIRED_ARTIFACT_KEYS = new Set([...ARTIFACT_KEYS].filter((key) => key !== "sourceBinding"));
const EXPORT_KEYS = new Set(["schemaVersion", "kind", "shareId", "revision", "artifact", "disclosure", "exportDigest"]);
const INDEX_KEYS = new Set([
  "schemaVersion", "kind", "shareId", "status", "latestRevision", "latestDigest", "expiresAt", "tombstoneDigest", "indexDigest"
]);
const TOMBSTONE_KEYS = new Set([
  "schemaVersion", "kind", "shareId", "action", "revision", "revisionDigest", "at", "reason", "tombstoneDigest"
]);

const CREATE_PERMISSIONS = new WeakSet();
const REVISION_PERMISSIONS = new WeakSet();
const READ_PERMISSIONS = new WeakSet();
const EXPORT_PERMISSIONS = new WeakSet();
const REVOKE_PERMISSIONS = new WeakSet();
const EXPIRE_PERMISSIONS = new WeakSet();
const USED_CREATE_PERMISSIONS = new WeakSet();
const USED_REVISION_PERMISSIONS = new WeakSet();
const USED_REVOKE_PERMISSIONS = new WeakSet();
const USED_EXPIRE_PERMISSIONS = new WeakSet();

// These capabilities only separate local call sites and bind a request to a
// state root, share identity, selected sanitized fields, and current binding.
// They are deliberately not owner decisions, signatures, provider
// credentials, evidence attestations, or permission to publish remotely.

export class ShareError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ShareError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new ShareError(code, message, details);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    fail("ESHARE_INVALID", "value must be a plain object");
  }
}

function ownDataKeys(value, label) {
  if (!isPlainRecord(value)) fail("ESHARE_INVALID", `${label} must be a plain object`);
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    fail("ESHARE_INVALID", `${label} shape could not be inspected`);
  }
  const descriptors = new Map();
  for (const key of ownKeys) {
    if (typeof key !== "string") fail("ESHARE_INVALID", `${label} contains a symbol property`);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail("ESHARE_INVALID", `${label} property could not be inspected`);
    }
    if (!descriptor || descriptor.get || descriptor.set) fail("ESHARE_INVALID", `${label}.${key} must be a data property`);
    descriptors.set(key, descriptor);
  }
  return descriptors;
}

function exactKeys(value, allowed, label) {
  const descriptors = ownDataKeys(value, label);
  const unknown = [...descriptors.keys()].filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) fail("ESHARE_INVALID", `${label} contains unknown field(s)`);
  return descriptors;
}

function requireKeys(value, keys, label) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail("ESHARE_INVALID", `${label} requires ${key}`);
  }
}

function valueOf(descriptors, value, key) {
  return descriptors.get(key)?.value;
}

function boundedText(value, label, maxBytes, { empty = false, checkCredential = true } = {}) {
  if (typeof value !== "string" || (!empty && value.length === 0) || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("ESHARE_INVALID", `${label} must be bounded text`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) fail("ESHARE_LIMIT", `${label} exceeds its bounded size`);
  if (checkCredential && isCredentialShapedValue(value)) fail("ESHARE_SENSITIVE", `${label} contains credential-shaped material`);
  return value;
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value) || Buffer.byteLength(value, "utf8") > SHARE_LIMITS.maxIdBytes) {
    fail("ESHARE_INVALID", `${label} must be a safe identifier`);
  }
  // Identifiers may be long opaque names; the core credential heuristic also
  // classifies any 32-character identifier as credential-shaped.  Reject only
  // explicit credential prefixes here, while content and free-form metadata
  // continue to use the stronger bounded-text check below.
  if (/^(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AKIA|ASIA|AIDA|AROA|sk_(?:live|test)_|rk_(?:live|test)_|sq0atp-|ya29\.|AIza|dop_v1_|lin_api_|npm_|pypi-AgEI|(?:cap|token|secret|password|passwd|credential|authorization)[_-])/i.test(value)) {
    fail("ESHARE_SENSITIVE", `${label} contains credential-shaped material`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("ESHARE_INVALID", `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function boundedReferenceText(value, label, maxBytes, { allowHash = false } = {}) {
  const normalized = boundedText(value, label, maxBytes, { checkCredential: false });
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    fail("ESHARE_INVALID", `${label} must not contain a path or traversal component`);
  }
  if (!(allowHash && (SHA_REVISION.test(normalized) || UUID_REVISION.test(normalized))) && isCredentialShapedValue(normalized)) {
    fail("ESHARE_SENSITIVE", `${label} contains credential-shaped material`);
  }
  return normalized;
}

function boundedInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("ESHARE_INVALID", `${label} is outside its bounded range`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    fail("ESHARE_INVALID", `${label} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function beginDeadline(value, label, startedAt = Date.now()) {
  const deadlineMs = value === undefined
    ? SHARE_LIMITS.maxDeadlineMs
    : boundedInteger(value, `${label}.deadlineMs`, 1, SHARE_LIMITS.maxDeadlineMs);
  return () => {
    if (Date.now() - startedAt >= deadlineMs) fail("ESHARE_DEADLINE", `${label} exceeded its bounded deadline`);
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

function failUnsafePath(message = "share filesystem path is unsafe") {
  fail("ESHARE_FS", message);
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
      if (error?.code !== "ENOENT") failUnsafePath("share state root could not be inspected");
    }
    if (info) {
      if (info.isSymbolicLink() && (current === root || !isTrustedMacOsAlias(current))) {
        failUnsafePath("share state root contains an unsafe symbolic link");
      }
      if (!info.isSymbolicLink() && !info.isDirectory()) {
        failUnsafePath("share state root contains a non-directory component");
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
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("ESHARE_INVALID", "stateRoot must be an absolute path");
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) fail("ESHARE_INVALID", "stateRoot is too broad");
  return assertCanonicalStateRootPath(resolved);
}

async function assertNoSymlinkSafe(root, target) {
  try {
    return await assertNoSymlinkUnder(root, target);
  } catch (error) {
    if (error instanceof ShareError) throw error;
    failUnsafePath();
  }
}

async function ensurePrivateDirSafe(target) {
  try {
    return await ensurePrivateDir(target);
  } catch (error) {
    if (error instanceof ShareError) throw error;
    failUnsafePath();
  }
}

function capability(value, set) {
  const frozen = deepFreeze(value);
  set.add(frozen);
  return frozen;
}

function assertCapability(value, set, label) {
  if (!value || typeof value !== "object" || !set.has(value)) fail("ESHARE_PERMISSION", `${label} is not a genuine share capability`);
}

function assertPermissionRoot(permission, root, label) {
  if (permission.stateRoot !== root) fail("ESHARE_PERMISSION", `${label} is bound to a different state root`);
}

function assertSharePermission(permission, set, root, shareId, label) {
  assertCapability(permission, set, label);
  assertPermissionRoot(permission, root, label);
  if (permission.shareId !== shareId) fail("ESHARE_PERMISSION", `${label} is bound to a different share`);
}

function arrayValues(value, label, maxLength, checkDeadline = () => {}) {
  if (!Array.isArray(value)) fail("ESHARE_INVALID", `${label} must be an array`);
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail("ESHARE_INVALID", `${label} prototype could not be inspected`);
  }
  if (prototype !== Array.prototype) fail("ESHARE_INVALID", `${label} has an unexpected prototype`);
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    fail("ESHARE_INVALID", `${label} shape could not be inspected`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || lengthDescriptor.get || lengthDescriptor.set || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    fail("ESHARE_INVALID", `${label}.length is invalid`);
  }
  const length = lengthDescriptor.value;
  if (length > maxLength) fail("ESHARE_LIMIT", `${label} exceeds its bounded array length`);
  if (ownKeys.length > maxLength + 1) fail("ESHARE_LIMIT", `${label} contains too many own properties`);
  const descriptors = new Map();
  for (const key of ownKeys) {
    if (typeof key !== "string") fail("ESHARE_INVALID", `${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) fail("ESHARE_INVALID", `${label}.${key} must be a data property`);
    if (key === "length") {
      if (descriptor.value !== length) fail("ESHARE_INVALID", `${label}.length is inconsistent`);
    } else if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length || !Number.isSafeInteger(Number(key))) {
      fail("ESHARE_INVALID", `${label} contains a non-index array property`);
    }
    descriptors.set(key, descriptor);
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    checkDeadline();
    const descriptor = descriptors.get(String(index));
    if (!descriptor) fail("ESHARE_INVALID", `${label} contains a sparse element`);
    result.push(descriptor.value);
  }
  return result;
}

function normalizeReference(value, label) {
  const descriptors = exactKeys(value, REF_KEYS, label);
  requireKeys(value, ["kind", "id", "revision", "digest"], label);
  const kind = boundedReferenceText(valueOf(descriptors, value, "kind"), `${label}.kind`, SHARE_LIMITS.maxReferenceKindBytes);
  if (!SAFE_KIND.test(kind)) fail("ESHARE_INVALID", `${label}.kind is invalid`);
  const id = safeId(valueOf(descriptors, value, "id"), `${label}.id`);
  const revision = boundedReferenceText(valueOf(descriptors, value, "revision"), `${label}.revision`, SHARE_LIMITS.maxReferenceRevisionBytes, { allowHash: true });
  return { kind, id, revision, digest: digest(valueOf(descriptors, value, "digest"), `${label}.digest`) };
}

function normalizeSourceBinding(value, label = "share.sourceBinding") {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !SOURCE_BINDING_VALUES.has(value)) fail("ESHARE_INVALID", `${label} is unsupported`);
  return value;
}

function validateSourceBindingReference(source, sourceBinding) {
  if (!isLocalSourceBindingV1(sourceBinding)) return;
  try {
    normalizeLocalSourceReferenceV1(source, sourceBinding);
  } catch {
    fail("ESHARE_INVALID", "share local source reference is invalid");
  }
}

function normalizeSnippet(value, label, checkDeadline) {
  const descriptors = exactKeys(value, new Set(["id", "text", "sourceDigest"]), label);
  requireKeys(value, ["id", "text", "sourceDigest"], label);
  checkDeadline();
  return {
    id: safeId(valueOf(descriptors, value, "id"), `${label}.id`),
    text: boundedText(valueOf(descriptors, value, "text"), `${label}.text`, SHARE_LIMITS.maxSnippetBytes),
    sourceDigest: valueOf(descriptors, value, "sourceDigest") === null
      ? null
      : digest(valueOf(descriptors, value, "sourceDigest"), `${label}.sourceDigest`)
  };
}

function normalizeContent(value, checkDeadline) {
  const descriptors = exactKeys(value, CONTENT_KEYS, "share.content");
  requireKeys(value, ["title", "summary", "facts", "snippets", "impact"], "share.content");
  checkDeadline();
  const title = boundedText(valueOf(descriptors, value, "title"), "share.content.title", SHARE_LIMITS.maxTitleBytes);
  const summary = boundedText(valueOf(descriptors, value, "summary"), "share.content.summary", SHARE_LIMITS.maxSummaryBytes);
  const rawFacts = valueOf(descriptors, value, "facts");
  const rawSnippets = valueOf(descriptors, value, "snippets");
  const facts = rawFacts === null ? null : arrayValues(rawFacts, "share.content.facts", SHARE_LIMITS.maxFactCount, checkDeadline).map((item, index) => boundedText(item, `share.content.facts[${index}]`, SHARE_LIMITS.maxFactBytes));
  const snippets = rawSnippets === null ? null : arrayValues(rawSnippets, "share.content.snippets", SHARE_LIMITS.maxSnippetCount, checkDeadline).map((item, index) => normalizeSnippet(item, `share.content.snippets[${index}]`, checkDeadline));
  if (facts && facts.length === 0) fail("ESHARE_INVALID", "share.content.facts must not be empty when selected");
  if (snippets && snippets.length === 0) fail("ESHARE_INVALID", "share.content.snippets must not be empty when selected");
  const impactValue = valueOf(descriptors, value, "impact");
  const impact = impactValue === null ? null : boundedText(impactValue, "share.content.impact", SHARE_LIMITS.maxSummaryBytes, { empty: true });
  const normalized = { title, summary, facts, snippets, impact };
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > SHARE_LIMITS.maxContentBytes) fail("ESHARE_LIMIT", "share.content exceeds the bounded size");
  return normalized;
}

function normalizeSelection(value, content, checkDeadline) {
  const descriptors = exactKeys(value, SELECTION_KEYS, "share.selection");
  requireKeys(value, ["mode", "fields"], "share.selection");
  if (valueOf(descriptors, value, "mode") !== "explicit") fail("ESHARE_REVIEW_REQUIRED", "share selection must be explicit");
  const fields = arrayValues(valueOf(descriptors, value, "fields"), "share.selection.fields", SHARE_LIMITS.maxSelectionFields, checkDeadline);
  if (fields.length === 0) fail("ESHARE_REVIEW_REQUIRED", "share selection must name at least one field");
  const normalizedFields = [];
  for (const field of fields) {
    if (typeof field !== "string" || !CONTENT_FIELDS.has(field)) fail("ESHARE_INVALID", "share selection contains an unsupported field");
    if (normalizedFields.includes(field)) fail("ESHARE_INVALID", "share selection contains duplicate fields");
    normalizedFields.push(field);
  }
  normalizedFields.sort((left, right) => [...CONTENT_FIELDS].indexOf(left) - [...CONTENT_FIELDS].indexOf(right));
  for (const field of CONTENT_FIELDS) {
    const selected = normalizedFields.includes(field);
    const valuePresent = field === "facts" || field === "snippets"
      ? Array.isArray(content[field]) && content[field].length > 0
      : content[field] !== null;
    if (selected !== valuePresent) fail("ESHARE_INVALID", `share selection does not match ${field}`);
  }
  if (!normalizedFields.includes("title") || !normalizedFields.includes("summary")) fail("ESHARE_REVIEW_REQUIRED", "share selection must include title and summary");
  return { mode: "explicit", fields: normalizedFields };
}

function normalizePrivacy(value) {
  const descriptors = exactKeys(value, PRIVACY_KEYS, "share.privacy");
  requireKeys(value, ["mode", "status", "rawExcluded", "unknownContent"], "share.privacy");
  if (valueOf(descriptors, value, "mode") !== "sanitized" || valueOf(descriptors, value, "status") !== "approved" || valueOf(descriptors, value, "rawExcluded") !== true || valueOf(descriptors, value, "unknownContent") !== "blocked") {
    fail("ESHARE_REVIEW_REQUIRED", "share privacy must be explicitly approved, sanitized, and unknown-blocked");
  }
  return { mode: "sanitized", status: "approved", rawExcluded: true, unknownContent: "blocked" };
}

function normalizeReview(value) {
  const descriptors = exactKeys(value, REVIEW_KEYS, "share.review");
  requireKeys(value, ["privacy", "security", "facts"], "share.review");
  const normalized = {
    privacy: valueOf(descriptors, value, "privacy"),
    security: valueOf(descriptors, value, "security"),
    facts: valueOf(descriptors, value, "facts")
  };
  for (const role of Object.keys(normalized)) {
    if (normalized[role] !== "approved") fail("ESHARE_REVIEW_REQUIRED", `share ${role} review is not approved`);
  }
  return normalized;
}

function normalizeDisclosure(value) {
  const descriptors = exactKeys(value, DISCLOSURE_KEYS, "share.disclosure");
  requireKeys(value, ["mode", "rawExcluded", "unknownContent"], "share.disclosure");
  if (valueOf(descriptors, value, "mode") !== "sanitized" || valueOf(descriptors, value, "rawExcluded") !== true || valueOf(descriptors, value, "unknownContent") !== "blocked") {
    fail("ESHARE_INVALID", "share disclosure is not a sanitized blocked-content declaration");
  }
  return { mode: "sanitized", rawExcluded: true, unknownContent: "blocked" };
}

function normalizeProvenance(value) {
  const descriptors = exactKeys(value, PROVENANCE_KEYS, "share.provenance");
  requireKeys(value, ["producer", "method", "origin", "capturedAt"], "share.provenance");
  if (valueOf(descriptors, value, "producer") !== SHARE_PRODUCER || valueOf(descriptors, value, "method") !== "model-free" || valueOf(descriptors, value, "origin") !== "local-sanitized") {
    fail("ESHARE_INVALID", "share provenance is not local sanitized provenance");
  }
  return {
    producer: SHARE_PRODUCER,
    method: "model-free",
    origin: "local-sanitized",
    capturedAt: timestamp(valueOf(descriptors, value, "capturedAt"), "share.provenance.capturedAt")
  };
}

function normalizePublication(value) {
  const descriptors = exactKeys(value, PUBLICATION_KEYS, "share.publication");
  requireKeys(value, ["state", "published", "remoteShare", "authority"], "share.publication");
  if (valueOf(descriptors, value, "state") !== "PREPARED" || valueOf(descriptors, value, "published") !== false || valueOf(descriptors, value, "remoteShare") !== false || valueOf(descriptors, value, "authority") !== "local-advisory-only") {
    fail("ESHARE_INVALID", "share publication must remain an unpublished local advisory");
  }
  return { state: "PREPARED", published: false, remoteShare: false, authority: "local-advisory-only" };
}

function normalizeInput({ source, target, content, selection, privacy, review, expiresAt, sourceBinding }, checkDeadline, { requireFutureExpiry = false } = {}) {
  const normalizedSource = normalizeReference(source, "share.source");
  const normalizedSourceBinding = normalizeSourceBinding(sourceBinding);
  validateSourceBindingReference(normalizedSource, normalizedSourceBinding);
  const normalizedTarget = normalizeReference(target, "share.target");
  const normalizedContent = normalizeContent(content, checkDeadline);
  const normalizedSelection = normalizeSelection(selection, normalizedContent, checkDeadline);
  const normalizedPrivacy = normalizePrivacy(privacy);
  const normalizedReview = normalizeReview(review);
  const normalizedExpiresAt = timestamp(expiresAt, "share.expiresAt");
  const expiresMs = Date.parse(normalizedExpiresAt);
  if (expiresMs <= Date.parse(new Date(0).toISOString())) fail("ESHARE_INVALID", "share.expiresAt is invalid");
  if (requireFutureExpiry && expiresMs <= Date.now()) fail("ESHARE_EXPIRED", "share.expiresAt is already expired");
  if (expiresMs > Date.now() + SHARE_LIMITS.maxTtlMs) fail("ESHARE_LIMIT", "share.expiresAt exceeds the bounded lifetime");
  const normalizedDisclosure = { mode: "sanitized", rawExcluded: true, unknownContent: "blocked" };
  const contentDigest = digestObject(normalizedContent);
  const selectionDigest = digestObject(normalizedSelection);
  const privacyDigest = digestObject(normalizedPrivacy);
  const reviewDigest = digestObject(normalizedReview);
  const bindingCore = {
    source: normalizedSource,
    target: normalizedTarget,
    contentDigest,
    selectionDigest,
    privacyDigest,
    reviewDigest,
    disclosure: normalizedDisclosure,
    expiresAt: normalizedExpiresAt
  };
  if (normalizedSourceBinding !== null) bindingCore.sourceBinding = normalizedSourceBinding;
  const bindingDigest = digestObject(bindingCore);
  checkDeadline();
  return {
    source: normalizedSource,
    target: normalizedTarget,
    content: normalizedContent,
    contentDigest,
    selection: normalizedSelection,
    selectionDigest,
    privacy: normalizedPrivacy,
    privacyDigest,
    review: normalizedReview,
    reviewDigest,
    disclosure: normalizedDisclosure,
    expiresAt: normalizedExpiresAt,
    bindingDigest,
    sourceBinding: normalizedSourceBinding
  };
}

function buildArtifact({ shareId, revision, previousArtifactDigest = null, normalized, createdAt }) {
  const provenance = {
    producer: SHARE_PRODUCER,
    method: "model-free",
    origin: "local-sanitized",
    capturedAt: createdAt
  };
  const publication = { state: "PREPARED", published: false, remoteShare: false, authority: "local-advisory-only" };
  const core = {
    schemaVersion: SHARE_SCHEMA_VERSION,
    kind: SHARE_ARTIFACT_KIND,
    shareId,
    revision,
    previousArtifactDigest,
    source: normalized.source,
    ...(normalized.sourceBinding === null ? {} : { sourceBinding: normalized.sourceBinding }),
    target: normalized.target,
    content: normalized.content,
    contentDigest: normalized.contentDigest,
    selection: normalized.selection,
    selectionDigest: normalized.selectionDigest,
    privacy: normalized.privacy,
    privacyDigest: normalized.privacyDigest,
    review: normalized.review,
    reviewDigest: normalized.reviewDigest,
    disclosure: normalized.disclosure,
    provenance,
    publication,
    status: SHARE_STATUS,
    createdAt,
    expiresAt: normalized.expiresAt,
    // Expiry gates future reads/preparations only.  It makes no claim that a
    // previously downloaded artifact can be recalled from another location.
    expiryScope: SHARE_EXPIRY_SCOPE,
    bindingDigest: normalized.bindingDigest
  };
  return deepFreeze({ ...core, artifactDigest: digestObject(core) });
}

function validateArtifactShape(value, { allowExpired = true } = {}) {
  const descriptors = exactKeys(value, ARTIFACT_KEYS, "share artifact");
  requireKeys(value, [...REQUIRED_ARTIFACT_KEYS], "share artifact");
  if (valueOf(descriptors, value, "schemaVersion") !== SHARE_SCHEMA_VERSION || valueOf(descriptors, value, "kind") !== SHARE_ARTIFACT_KIND || valueOf(descriptors, value, "status") !== SHARE_STATUS) {
    fail("ESHARE_INVALID", "share artifact kind, version, or status is unsupported");
  }
  const shareId = safeId(valueOf(descriptors, value, "shareId"), "share.shareId");
  const revision = boundedInteger(valueOf(descriptors, value, "revision"), "share.revision", 1, SHARE_LIMITS.maxRevisionCount);
  const previousArtifactDigest = valueOf(descriptors, value, "previousArtifactDigest");
  if (previousArtifactDigest !== null) digest(previousArtifactDigest, "share.previousArtifactDigest");
  const normalizedSource = normalizeReference(valueOf(descriptors, value, "source"), "share.source");
  const sourceBinding = normalizeSourceBinding(valueOf(descriptors, value, "sourceBinding"));
  validateSourceBindingReference(normalizedSource, sourceBinding);
  const normalizedTarget = normalizeReference(valueOf(descriptors, value, "target"), "share.target");
  const checkDeadline = beginDeadline(undefined, "share.validate");
  const normalizedContent = normalizeContent(valueOf(descriptors, value, "content"), checkDeadline);
  const normalizedSelection = normalizeSelection(valueOf(descriptors, value, "selection"), normalizedContent, checkDeadline);
  const normalizedPrivacy = normalizePrivacy(valueOf(descriptors, value, "privacy"));
  const normalizedReview = normalizeReview(valueOf(descriptors, value, "review"));
  const normalizedDisclosure = normalizeDisclosure(valueOf(descriptors, value, "disclosure"));
  const normalizedProvenance = normalizeProvenance(valueOf(descriptors, value, "provenance"));
  const normalizedPublication = normalizePublication(valueOf(descriptors, value, "publication"));
  const createdAt = timestamp(valueOf(descriptors, value, "createdAt"), "share.createdAt");
  const expiresAt = timestamp(valueOf(descriptors, value, "expiresAt"), "share.expiresAt");
  if (valueOf(descriptors, value, "expiryScope") !== SHARE_EXPIRY_SCOPE) fail("ESHARE_INVALID", "share expiry scope is unsupported");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) fail("ESHARE_INVALID", "share.expiresAt must be after createdAt");
  if (Date.parse(expiresAt) > Date.parse(createdAt) + SHARE_LIMITS.maxTtlMs) fail("ESHARE_LIMIT", "share lifetime exceeds the bounded limit");
  if (!allowExpired && Date.parse(expiresAt) <= Date.now()) fail("ESHARE_EXPIRED", "share artifact has expired");
  const contentDigest = digest(valueOf(descriptors, value, "contentDigest"), "share.contentDigest");
  if (contentDigest !== digestObject(normalizedContent)) fail("ESHARE_INTEGRITY", "share content digest is stale");
  const selectionDigest = digest(valueOf(descriptors, value, "selectionDigest"), "share.selectionDigest");
  if (selectionDigest !== digestObject(normalizedSelection)) fail("ESHARE_INTEGRITY", "share selection digest is stale");
  const privacyDigest = digest(valueOf(descriptors, value, "privacyDigest"), "share.privacyDigest");
  if (privacyDigest !== digestObject(normalizedPrivacy)) fail("ESHARE_INTEGRITY", "share privacy digest is stale");
  const reviewDigest = digest(valueOf(descriptors, value, "reviewDigest"), "share.reviewDigest");
  if (reviewDigest !== digestObject(normalizedReview)) fail("ESHARE_INTEGRITY", "share review digest is stale");
  const bindingDigest = digest(valueOf(descriptors, value, "bindingDigest"), "share.bindingDigest");
  const expectedBindingCore = {
    source: normalizedSource,
    target: normalizedTarget,
    contentDigest,
    selectionDigest,
    privacyDigest,
    reviewDigest,
    disclosure: normalizedDisclosure,
    expiresAt
  };
  if (sourceBinding !== null) expectedBindingCore.sourceBinding = sourceBinding;
  const expectedBinding = digestObject(expectedBindingCore);
  if (bindingDigest !== expectedBinding) fail("ESHARE_INTEGRITY", "share binding digest is stale");
  const core = {
    schemaVersion: SHARE_SCHEMA_VERSION,
    kind: SHARE_ARTIFACT_KIND,
    shareId,
    revision,
    previousArtifactDigest,
    source: normalizedSource,
    ...(sourceBinding === null ? {} : { sourceBinding }),
    target: normalizedTarget,
    content: normalizedContent,
    contentDigest,
    selection: normalizedSelection,
    selectionDigest,
    privacy: normalizedPrivacy,
    privacyDigest,
    review: normalizedReview,
    reviewDigest,
    disclosure: normalizedDisclosure,
    provenance: normalizedProvenance,
    publication: normalizedPublication,
    status: SHARE_STATUS,
    createdAt,
    expiresAt,
    expiryScope: SHARE_EXPIRY_SCOPE,
    bindingDigest
  };
  const artifactDigest = digest(valueOf(descriptors, value, "artifactDigest"), "share.artifactDigest");
  if (artifactDigest !== digestObject(core)) fail("ESHARE_INTEGRITY", "share artifact digest is stale");
  return deepFreeze({ ...core, artifactDigest });
}

export function validateShareArtifactV1(value, options = {}) {
  const descriptors = exactKeys(options, new Set(["allowExpired"]), "validateShareArtifactV1 options");
  const allowExpired = valueOf(descriptors, options, "allowExpired") ?? true;
  if (typeof allowExpired !== "boolean") fail("ESHARE_INVALID", "validateShareArtifactV1.allowExpired must be boolean");
  return validateArtifactShape(value, { allowExpired });
}

export function validateShareExportV1(value) {
  const descriptors = exactKeys(value, EXPORT_KEYS, "share export");
  requireKeys(value, [...EXPORT_KEYS], "share export");
  if (valueOf(descriptors, value, "schemaVersion") !== SHARE_SCHEMA_VERSION || valueOf(descriptors, value, "kind") !== SHARE_EXPORT_KIND) fail("ESHARE_INVALID", "share export kind or version is unsupported");
  const artifact = validateArtifactShape(valueOf(descriptors, value, "artifact"));
  if (valueOf(descriptors, value, "shareId") !== artifact.shareId || valueOf(descriptors, value, "revision") !== artifact.revision) fail("ESHARE_INTEGRITY", "share export identity does not match its artifact");
  const disclosure = normalizeDisclosure(valueOf(descriptors, value, "disclosure"));
  const core = { schemaVersion: SHARE_SCHEMA_VERSION, kind: SHARE_EXPORT_KIND, shareId: artifact.shareId, revision: artifact.revision, artifact, disclosure };
  const exportDigest = digest(valueOf(descriptors, value, "exportDigest"), "share.exportDigest");
  if (exportDigest !== digestObject(core)) fail("ESHARE_INTEGRITY", "share export digest is stale");
  return deepFreeze({ ...core, exportDigest });
}

function bindingInputDigest(normalized) {
  return normalized.bindingDigest;
}

function createBindingPermission(options, kind, set, label, requireFutureExpiry = true) {
  optionKeys(options, new Set(["stateRoot", "shareId", "source", "sourceBinding", "target", "content", "selection", "privacy", "review", "expiresAt", "expectedRevision"]), label);
  const root = stateRootPath(options.stateRoot);
  const normalizedShareId = safeId(options.shareId, `${label}.shareId`);
  const checkDeadline = beginDeadline(undefined, label);
  const normalized = normalizeInput(options, checkDeadline, { requireFutureExpiry });
  boundedInteger(options.expectedRevision, `${label}.expectedRevision`, 0, SHARE_LIMITS.maxRevisionCount - 1);
  return capability({
    kind,
    stateRoot: root,
    shareId: normalizedShareId,
    expectedRevision: options.expectedRevision,
    bindingDigest: bindingInputDigest(normalized),
    sourceBinding: normalized.sourceBinding,
    expiresAt: normalized.expiresAt
  }, set);
}

export function createShareCreatePermissionV1(options = {}) {
  return createBindingPermission(options, SHARE_CREATE_PERMISSION_KIND, CREATE_PERMISSIONS, "share create permission", true);
}

export const createSharePermissionV1 = createShareCreatePermissionV1;

export function createShareRevisionPermissionV1(options = {}) {
  return createBindingPermission(options, SHARE_REVISION_PERMISSION_KIND, REVISION_PERMISSIONS, "share revision permission", true);
}

export function createShareReadPermissionV1(options = {}) {
  optionKeys(options, new Set(["stateRoot", "shareId", "revision"]), "share read permission");
  const root = stateRootPath(options.stateRoot);
  const normalizedShareId = safeId(options.shareId, "share read permission.shareId");
  const revision = options.revision ?? null;
  if (revision !== null) boundedInteger(revision, "share read permission.revision", 1, SHARE_LIMITS.maxRevisionCount);
  return capability({ kind: SHARE_READ_PERMISSION_KIND, stateRoot: root, shareId: normalizedShareId, revision }, READ_PERMISSIONS);
}

export function createShareExportPermissionV1(options = {}) {
  optionKeys(options, new Set(["stateRoot", "shareId", "revision"]), "share export permission");
  const root = stateRootPath(options.stateRoot);
  const normalizedShareId = safeId(options.shareId, "share export permission.shareId");
  const revision = options.revision ?? null;
  if (revision !== null) boundedInteger(revision, "share export permission.revision", 1, SHARE_LIMITS.maxRevisionCount);
  return capability({ kind: SHARE_EXPORT_PERMISSION_KIND, stateRoot: root, shareId: normalizedShareId, revision }, EXPORT_PERMISSIONS);
}

function createMutationPermission(options, kind, set, label) {
  optionKeys(options, new Set(["stateRoot", "shareId", "expectedRevision"]), label);
  const root = stateRootPath(options.stateRoot);
  const normalizedShareId = safeId(options.shareId, `${label}.shareId`);
  boundedInteger(options.expectedRevision, `${label}.expectedRevision`, 1, SHARE_LIMITS.maxRevisionCount);
  return capability({ kind, stateRoot: root, shareId: normalizedShareId, expectedRevision: options.expectedRevision }, set);
}

export function createShareRevokePermissionV1(options = {}) {
  return createMutationPermission(options, SHARE_REVOKE_PERMISSION_KIND, REVOKE_PERMISSIONS, "share revoke permission");
}

export function createShareExpirePermissionV1(options = {}) {
  return createMutationPermission(options, SHARE_EXPIRE_PERMISSION_KIND, EXPIRE_PERMISSIONS, "share expire permission");
}

function shareStoreRoot(stateRoot) {
  return safeJoin(stateRootPath(stateRoot), SHARE_STORE_DIRECTORY);
}

export function shareStoreRootV1(stateRoot = getStateRoot()) {
  return shareStoreRoot(stateRoot);
}

function sharePaths(root, shareId) {
  const store = shareStoreRoot(root);
  const shareDir = safeJoin(store, "shares", shareId);
  return {
    store,
    shareDir,
    revisions: safeJoin(shareDir, "revisions"),
    index: safeJoin(shareDir, "index.json"),
    tombstone: safeJoin(shareDir, "tombstone.json"),
    lock: safeJoin(store, "locks", `${shareId}.lock`)
  };
}

async function optionalStat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    failUnsafePath();
  }
}

async function assertExistingPath(root, target) {
  await assertNoSymlinkSafe(root, target);
  return (await optionalStat(target)) !== null;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (error instanceof ShareError) throw error;
    failUnsafePath("share directory could not be synchronized");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ensureStore(root) {
  const store = shareStoreRoot(root);
  await assertNoSymlinkSafe(root, store);
  await ensurePrivateDirSafe(store);
  const shares = safeJoin(store, "shares");
  const locks = safeJoin(store, "locks");
  await assertNoSymlinkSafe(root, shares);
  await assertNoSymlinkSafe(root, locks);
  await ensurePrivateDirSafe(shares);
  await ensurePrivateDirSafe(locks);
  return { store, shares, locks };
}

async function readRegularJson(root, target, label, { allowMissing = false, maxBytes = SHARE_LIMITS.maxRecordBytes } = {}) {
  const present = await assertExistingPath(root, target);
  if (!present) {
    if (allowMissing) return null;
    fail("ESHARE_NOT_FOUND", `${label} does not exist`);
  }
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("ESHARE_FS", `${label} is not a regular single-link file`);
    if (!Number.isSafeInteger(before.size) || before.size > maxBytes) fail("ESHARE_LIMIT", `${label} exceeds its bounded size`);
    const text = await handle.readFile("utf8");
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail("ESHARE_FS", `${label} changed while being read`);
    }
    try {
      return JSON.parse(text);
    } catch {
      fail("ESHARE_INTEGRITY", `${label} is not valid JSON`);
    }
  } catch (error) {
    if (error instanceof ShareError) throw error;
    if (error.code === "ELOOP") fail("ESHARE_FS", `${label} contains a symbolic link`);
    if (error.code === "ENOENT" && allowMissing) return null;
    fail("ESHARE_FS", `${label} could not be read`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeCreateOnlyJson(root, target, value, checkDeadline) {
  const parent = path.dirname(target);
  await assertNoSymlinkSafe(root, parent);
  await ensurePrivateDirSafe(parent);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (bytes.byteLength > SHARE_LIMITS.maxRecordBytes) fail("ESHARE_LIMIT", "share record exceeds its bounded size");
  const temp = safeJoin(parent, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  let tempCreated = false;
  try {
    handle = await open(temp, flags, 0o600);
    tempCreated = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temp, 0o600);
    checkDeadline();
    try {
      // A hard-link publish exposes only the complete, fsynced inode and
      // cannot replace an existing artifact or follow a target symlink.
      await linkFile(temp, target);
    } catch (error) {
      if (error.code === "EEXIST") {
        const existing = await lstat(target).catch((statError) => {
          if (statError.code === "ENOENT") return null;
          throw statError;
        });
        if (existing?.isSymbolicLink()) fail("ESHARE_FS", "share target is a symbolic link");
        fail("ESHARE_CONFLICT", "share immutable file already exists");
      }
      if (error.code === "ELOOP") fail("ESHARE_FS", "share target is a symbolic link");
      throw error;
    }
    await unlink(temp);
    tempCreated = false;
    await syncDirectory(parent);
  } catch (error) {
    if (error instanceof ShareError) throw error;
    fail("ESHARE_FS", "share immutable file could not be written");
  } finally {
    await handle?.close().catch(() => {});
    if (tempCreated) await unlink(temp).catch((error) => {
      if (error.code !== "ENOENT") failUnsafePath("share temporary file could not be removed");
    });
  }
}

// Kept as a small local binding so the create-only publication primitive is
// explicit in this module and never confused with overwrite-style rename.
async function linkFile(source, target) {
  const { link } = await import("node:fs/promises");
  return link(source, target);
}

async function acquireShareLock(root, shareId, checkDeadline) {
  const paths = sharePaths(root, shareId);
  await assertNoSymlinkSafe(root, paths.lock);
  await ensurePrivateDirSafe(path.dirname(paths.lock));
  const token = randomUUID();
  let handle;
  let created = false;
  try {
    handle = await open(paths.lock, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    await handle.writeFile(`${canonicalJson({ schemaVersion: 1, kind: "ShareLockV1", shareId, token })}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(paths.lock, 0o600);
    await syncDirectory(path.dirname(paths.lock));
    checkDeadline();
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await unlink(paths.lock).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") failUnsafePath("share lock cleanup failed");
    });
    if (error.code === "EEXIST") fail("ESHARE_LOCKED", "share is already being changed");
    if (error instanceof ShareError) throw error;
    fail("ESHARE_FS", "share lock could not be acquired");
  }
  return {
    async release() {
      const current = await readRegularJson(root, paths.lock, "share lock", { maxBytes: 4 * 1024 });
      if (current?.shareId !== shareId || current?.token !== token) return;
      try {
        await unlink(paths.lock);
      } catch (error) {
        if (error instanceof ShareError) throw error;
        failUnsafePath("share lock could not be released");
      }
      await syncDirectory(path.dirname(paths.lock));
    }
  };
}

function validateIndex(value, shareId) {
  const descriptors = exactKeys(value, INDEX_KEYS, "share index");
  requireKeys(value, [...INDEX_KEYS], "share index");
  if (valueOf(descriptors, value, "schemaVersion") !== SHARE_SCHEMA_VERSION || valueOf(descriptors, value, "kind") !== SHARE_INDEX_KIND || valueOf(descriptors, value, "shareId") !== shareId) fail("ESHARE_INTEGRITY", "share index identity is invalid");
  const status = valueOf(descriptors, value, "status");
  if (![SHARE_STATUS, SHARE_REVOKED_STATUS].includes(status)) fail("ESHARE_INTEGRITY", "share index status is invalid");
  const latestRevision = boundedInteger(valueOf(descriptors, value, "latestRevision"), "share index.latestRevision", 1, SHARE_LIMITS.maxRevisionCount);
  const latestDigest = digest(valueOf(descriptors, value, "latestDigest"), "share index.latestDigest");
  const expiresAt = timestamp(valueOf(descriptors, value, "expiresAt"), "share index.expiresAt");
  const tombstoneDigest = valueOf(descriptors, value, "tombstoneDigest") === null ? null : digest(valueOf(descriptors, value, "tombstoneDigest"), "share index.tombstoneDigest");
  if (status === SHARE_STATUS && tombstoneDigest !== null) fail("ESHARE_INTEGRITY", "active share index has a tombstone");
  if (status === SHARE_REVOKED_STATUS && tombstoneDigest === null) fail("ESHARE_INTEGRITY", "revoked share index lacks a tombstone");
  const core = { schemaVersion: SHARE_SCHEMA_VERSION, kind: SHARE_INDEX_KIND, shareId, status, latestRevision, latestDigest, expiresAt, tombstoneDigest };
  const indexDigest = digest(valueOf(descriptors, value, "indexDigest"), "share index.indexDigest");
  if (indexDigest !== digestObject(core)) fail("ESHARE_INTEGRITY", "share index digest is stale");
  return deepFreeze({ ...core, indexDigest });
}

function validateTombstone(value, shareId) {
  const descriptors = exactKeys(value, TOMBSTONE_KEYS, "share tombstone");
  requireKeys(value, [...TOMBSTONE_KEYS], "share tombstone");
  if (valueOf(descriptors, value, "schemaVersion") !== SHARE_SCHEMA_VERSION || valueOf(descriptors, value, "kind") !== SHARE_TOMBSTONE_KIND || valueOf(descriptors, value, "shareId") !== shareId) fail("ESHARE_INTEGRITY", "share tombstone identity is invalid");
  const action = valueOf(descriptors, value, "action");
  if (!["revoke", "expire"].includes(action)) fail("ESHARE_INTEGRITY", "share tombstone action is invalid");
  const core = {
    schemaVersion: SHARE_SCHEMA_VERSION,
    kind: SHARE_TOMBSTONE_KIND,
    shareId,
    action,
    revision: boundedInteger(valueOf(descriptors, value, "revision"), "share tombstone.revision", 1, SHARE_LIMITS.maxRevisionCount),
    revisionDigest: digest(valueOf(descriptors, value, "revisionDigest"), "share tombstone.revisionDigest"),
    at: timestamp(valueOf(descriptors, value, "at"), "share tombstone.at"),
    reason: boundedText(valueOf(descriptors, value, "reason"), "share tombstone.reason", SHARE_LIMITS.maxReasonBytes)
  };
  const tombstoneDigest = digest(valueOf(descriptors, value, "tombstoneDigest"), "share tombstone.tombstoneDigest");
  if (tombstoneDigest !== digestObject(core)) fail("ESHARE_INTEGRITY", "share tombstone digest is stale");
  return deepFreeze({ ...core, tombstoneDigest });
}

async function listRevisionFiles(root, revisions, checkDeadline) {
  if (!(await assertExistingPath(root, revisions))) fail("ESHARE_INTEGRITY", "share revisions directory is missing");
  const info = await optionalStat(revisions);
  if (!info) fail("ESHARE_INTEGRITY", "share revisions directory is missing");
  if (info.isSymbolicLink() || !info.isDirectory()) fail("ESHARE_FS", "share revisions path is unsafe");
  let entries;
  try {
    entries = await readdir(revisions, { withFileTypes: true });
  } catch (error) {
    if (error instanceof ShareError) throw error;
    failUnsafePath();
  }
  if (entries.length > SHARE_LIMITS.maxRevisionCount) fail("ESHARE_LIMIT", "share revision count exceeds its bound");
  const files = [];
  for (const entry of entries) {
    checkDeadline();
    if (entry.isSymbolicLink()) fail("ESHARE_FS", "share revision entry is a symbolic link");
    if (!entry.isFile() || !REVISION_FILE.test(entry.name)) fail("ESHARE_INTEGRITY", "invalid share revision entry");
    files.push({ revision: Number(entry.name.slice(0, -5)), path: safeJoin(revisions, entry.name) });
  }
  return files.sort((left, right) => left.revision - right.revision);
}

async function readCurrentSnapshot(root, shareId, checkDeadline, { allowMissing = false, requestedRevision = null } = {}) {
  const paths = sharePaths(root, shareId);
  const nodePresent = await assertExistingPath(root, paths.shareDir);
  if (!nodePresent) {
    if (allowMissing) return null;
    fail("ESHARE_NOT_FOUND", "share does not exist");
  }
  const nodeInfo = await optionalStat(paths.shareDir);
  if (!nodeInfo) fail("ESHARE_NOT_FOUND", "share does not exist");
  if (nodeInfo.isSymbolicLink() || !nodeInfo.isDirectory()) fail("ESHARE_FS", "share directory is unsafe");
  const tombstoneRaw = await readRegularJson(root, paths.tombstone, "share tombstone", { allowMissing: true });
  checkDeadline();
  const indexRaw = await readRegularJson(root, paths.index, "share index");
  const index = validateIndex(indexRaw, shareId);
  if (tombstoneRaw !== null) {
    const tombstone = validateTombstone(tombstoneRaw, shareId);
    if (index.status !== SHARE_REVOKED_STATUS || index.tombstoneDigest !== tombstone.tombstoneDigest || index.latestRevision !== tombstone.revision || index.latestDigest !== tombstone.revisionDigest) fail("ESHARE_INTEGRITY", "share revoked index does not match its tombstone");
    fail(tombstone.action === "expire" ? "ESHARE_EXPIRED" : "ESHARE_REVOKED", `share is permanently ${tombstone.action === "expire" ? "expired" : "revoked"}`);
  }
  if (index.status !== SHARE_STATUS || index.tombstoneDigest !== null) fail("ESHARE_INTEGRITY", "active share index is invalid");
  const files = await listRevisionFiles(root, paths.revisions, checkDeadline);
  if (files.length !== index.latestRevision || files.some((file, indexValue) => file.revision !== indexValue + 1)) fail("ESHARE_INTEGRITY", "share revisions are not contiguous");
  const records = [];
  let previousDigest = null;
  for (const file of files) {
    checkDeadline();
    const raw = await readRegularJson(root, file.path, `share revision ${file.revision}`);
    const artifact = validateArtifactShape(raw);
    if (artifact.shareId !== shareId || artifact.revision !== file.revision || artifact.previousArtifactDigest !== previousDigest) fail("ESHARE_INTEGRITY", "share revision chain is invalid");
    records.push({ artifact, digest: artifact.artifactDigest, path: file.path });
    previousDigest = artifact.artifactDigest;
  }
  const latest = records.at(-1);
  if (!latest || latest.digest !== index.latestDigest || latest.artifact.expiresAt !== index.expiresAt) fail("ESHARE_INTEGRITY", "share index does not bind the latest artifact");
  const chosen = requestedRevision === null ? latest : records.find((record) => record.artifact.revision === requestedRevision);
  if (!chosen) fail("ESHARE_NOT_FOUND", "share revision does not exist");
  return { paths, index, latest, chosen, records };
}

function assertBinding(permission, normalized, label) {
  if (permission.bindingDigest !== normalized.bindingDigest) fail("ESHARE_PERMISSION", `${label} binding does not match its capability`);
}

function operationResult(operation, artifact, extra = {}) {
  return deepFreeze({
    ok: true,
    operation,
    shareId: artifact.shareId,
    revision: artifact.revision,
    artifactDigest: artifact.artifactDigest,
    status: artifact.status,
    publication: artifact.publication,
    authority: artifact.publication.authority,
    ...extra
  });
}

function remainingOperationBudget(deadlineMs, startedAt) {
  const limit = deadlineMs === undefined ? SHARE_LIMITS.maxDeadlineMs : deadlineMs;
  return Math.max(1, limit - (Date.now() - startedAt));
}

function sourceStatusForBinding(sourceBinding) {
  return isLocalSourceBindingV1(sourceBinding) ? "CURRENT" : "CALLER_ASSERTED";
}

function assertShareArtifactNotExpired(artifact) {
  if (Date.parse(artifact.expiresAt) <= Date.now()) fail("ESHARE_EXPIRED", "share has expired");
}

async function requireFreshLocalSource({ root, source, sourceBinding, phase, deadlineMs, startedAt }) {
  if (!isLocalSourceBindingV1(sourceBinding)) return null;
  // V1 has no cross-store read lease.  The caller performs an early and a
  // final point-in-time observation; a mutation after the final observation
  // remains outside this bounded slice and must not be described as race-proof.
  const observation = await observeLocalSourceV1({
    stateRoot: root,
    source,
    sourceBinding,
    phase,
    deadlineMs: remainingOperationBudget(deadlineMs, startedAt)
  });
  if (observation.status === "CURRENT") return observation;
  const codeByStatus = {
    CHANGED: "ESHARE_SOURCE_STALE",
    REVOKED: "ESHARE_SOURCE_REVOKED",
    EXPIRED: "ESHARE_SOURCE_EXPIRED",
    REVIEW_REQUIRED: "ESHARE_SOURCE_REVIEW_REQUIRED",
    REVIEW_REJECTED: "ESHARE_SOURCE_REVIEW_REJECTED",
    UNKNOWN: "ESHARE_SOURCE_UNKNOWN"
  };
  const code = codeByStatus[observation.status] ?? "ESHARE_SOURCE_UNKNOWN";
  fail(code, `share source is not current for ${phase}`);
}

function optionKeys(value, allowed, label) {
  const descriptors = ownDataKeys(value, label);
  if ([...descriptors.keys()].some((key) => !allowed.has(key))) fail("ESHARE_INVALID", `${label} contains an unknown option`);
}

export async function createShareArtifactV1(options = {}) {
  optionKeys(options, new Set(["stateRoot", "shareId", "source", "sourceBinding", "target", "content", "selection", "privacy", "review", "expiresAt", "permission", "deadlineMs"]), "createShareArtifactV1 options");
  for (const key of ["shareId", "source", "target", "content", "selection", "privacy", "review", "expiresAt", "permission"]) if (!Object.hasOwn(options, key)) fail("ESHARE_INVALID", `createShareArtifactV1 requires ${key}`);
  const root = stateRootPath(options.stateRoot);
  const shareId = safeId(options.shareId, "createShareArtifactV1.shareId");
  assertSharePermission(options.permission, CREATE_PERMISSIONS, root, shareId, "share create permission");
  if (USED_CREATE_PERMISSIONS.has(options.permission)) fail("ESHARE_PERMISSION", "share create permission has already been consumed");
  const startedAt = Date.now();
  const checkDeadline = beginDeadline(options.deadlineMs, "share.create", startedAt);
  const normalized = normalizeInput(options, checkDeadline, { requireFutureExpiry: true });
  if (options.permission.expectedRevision !== 0) fail("ESHARE_STALE", "share create requires expected revision zero");
  assertBinding(options.permission, normalized, "share create permission");
  const sourceStatus = sourceStatusForBinding(normalized.sourceBinding);
  await requireFreshLocalSource({ root, source: normalized.source, sourceBinding: normalized.sourceBinding, phase: "prepare", deadlineMs: options.deadlineMs, startedAt });
  await ensureStore(root);
  const lock = await acquireShareLock(root, shareId, checkDeadline);
  try {
    const current = await readCurrentSnapshot(root, shareId, checkDeadline, { allowMissing: true });
    if (current !== null) fail("ESHARE_CONFLICT", "share already exists or is tombstoned");
    const paths = sharePaths(root, shareId);
    await ensurePrivateDirSafe(paths.shareDir);
    await ensurePrivateDirSafe(paths.revisions);
    await requireFreshLocalSource({ root, source: normalized.source, sourceBinding: normalized.sourceBinding, phase: "prepare", deadlineMs: options.deadlineMs, startedAt });
    const createdAt = new Date().toISOString();
    const artifact = buildArtifact({ shareId, revision: 1, normalized, createdAt });
    await writeCreateOnlyJson(root, safeJoin(paths.revisions, "1.json"), artifact, checkDeadline);
    const indexCore = { schemaVersion: SHARE_SCHEMA_VERSION, kind: SHARE_INDEX_KIND, shareId, status: SHARE_STATUS, latestRevision: 1, latestDigest: artifact.artifactDigest, expiresAt: artifact.expiresAt, tombstoneDigest: null };
    await writeReplaceJson(root, paths.index, { ...indexCore, indexDigest: digestObject(indexCore) });
    const verified = await readCurrentSnapshot(root, shareId, checkDeadline);
    if (verified.latest.digest !== artifact.artifactDigest) fail("ESHARE_INTEGRITY", "created share did not verify");
    USED_CREATE_PERMISSIONS.add(options.permission);
    return operationResult("share.create", artifact, { artifact, sourceStatus });
  } finally {
    await lock.release();
  }
}

export async function reviseShareArtifactV1(options = {}) {
  optionKeys(options, new Set(["stateRoot", "shareId", "source", "sourceBinding", "target", "content", "selection", "privacy", "review", "expiresAt", "permission", "deadlineMs"]), "reviseShareArtifactV1 options");
  for (const key of ["shareId", "source", "target", "content", "selection", "privacy", "review", "expiresAt", "permission"]) if (!Object.hasOwn(options, key)) fail("ESHARE_INVALID", `reviseShareArtifactV1 requires ${key}`);
  const root = stateRootPath(options.stateRoot);
  const shareId = safeId(options.shareId, "reviseShareArtifactV1.shareId");
  assertSharePermission(options.permission, REVISION_PERMISSIONS, root, shareId, "share revision permission");
  if (USED_REVISION_PERMISSIONS.has(options.permission)) fail("ESHARE_PERMISSION", "share revision permission has already been consumed");
  const startedAt = Date.now();
  const checkDeadline = beginDeadline(options.deadlineMs, "share.revise", startedAt);
  const normalized = normalizeInput(options, checkDeadline, { requireFutureExpiry: true });
  assertBinding(options.permission, normalized, "share revision permission");
  const sourceStatus = sourceStatusForBinding(normalized.sourceBinding);
  await requireFreshLocalSource({ root, source: normalized.source, sourceBinding: normalized.sourceBinding, phase: "prepare", deadlineMs: options.deadlineMs, startedAt });
  const lock = await acquireShareLock(root, shareId, checkDeadline);
  try {
    const current = await readCurrentSnapshot(root, shareId, checkDeadline);
    if (Date.parse(current.latest.artifact.expiresAt) <= Date.now()) fail("ESHARE_EXPIRED", "expired share cannot be revised");
    if (isLocalSourceBindingV1(current.latest.artifact.sourceBinding) && !isLocalSourceBindingV1(normalized.sourceBinding)) {
      fail("ESHARE_SOURCE_REQUIRED", "a locally bound share cannot be revised with caller-asserted source data");
    }
    if (options.permission.expectedRevision !== current.latest.artifact.revision) fail("ESHARE_STALE", "share revision permission is stale");
    const revision = current.latest.artifact.revision + 1;
    boundedInteger(revision, "share revision", 1, SHARE_LIMITS.maxRevisionCount);
    const paths = sharePaths(root, shareId);
    await ensurePrivateDirSafe(paths.shareDir);
    await ensurePrivateDirSafe(paths.revisions);
    await requireFreshLocalSource({ root, source: normalized.source, sourceBinding: normalized.sourceBinding, phase: "prepare", deadlineMs: options.deadlineMs, startedAt });
    const artifact = buildArtifact({ shareId, revision, previousArtifactDigest: current.latest.artifact.artifactDigest, normalized, createdAt: new Date().toISOString() });
    await writeCreateOnlyJson(root, safeJoin(paths.revisions, `${revision}.json`), artifact, checkDeadline);
    const indexCore = { schemaVersion: SHARE_SCHEMA_VERSION, kind: SHARE_INDEX_KIND, shareId, status: SHARE_STATUS, latestRevision: revision, latestDigest: artifact.artifactDigest, expiresAt: artifact.expiresAt, tombstoneDigest: null };
    await writeReplaceJson(root, paths.index, { ...indexCore, indexDigest: digestObject(indexCore) });
    const verified = await readCurrentSnapshot(root, shareId, checkDeadline);
    if (verified.latest.digest !== artifact.artifactDigest) fail("ESHARE_INTEGRITY", "revised share did not verify");
    USED_REVISION_PERMISSIONS.add(options.permission);
    return operationResult("share.revise", artifact, { artifact, previousArtifactDigest: current.latest.artifact.artifactDigest, sourceStatus });
  } finally {
    await lock.release();
  }
}

export async function readShareArtifactV1(options = {}) {
  optionKeys(options, new Set(["stateRoot", "shareId", "permission", "deadlineMs"]), "readShareArtifactV1 options");
  for (const key of ["shareId", "permission"]) if (!Object.hasOwn(options, key)) fail("ESHARE_INVALID", `readShareArtifactV1 requires ${key}`);
  const root = stateRootPath(options.stateRoot);
  const shareId = safeId(options.shareId, "readShareArtifactV1.shareId");
  assertSharePermission(options.permission, READ_PERMISSIONS, root, shareId, "share read permission");
  const checkDeadline = beginDeadline(options.deadlineMs, "share.read");
  const snapshot = await readCurrentSnapshot(root, shareId, checkDeadline, { requestedRevision: options.permission.revision });
  assertShareArtifactNotExpired(snapshot.latest.artifact);
  assertShareArtifactNotExpired(snapshot.chosen.artifact);
  return deepFreeze({ ok: true, operation: "share.read", shareId, revision: snapshot.chosen.artifact.revision, artifactDigest: snapshot.chosen.artifact.artifactDigest, status: SHARE_STATUS, artifact: cloneJson(snapshot.chosen.artifact), latestRevision: snapshot.latest.artifact.revision, latestDigest: snapshot.latest.artifact.artifactDigest, publication: snapshot.chosen.artifact.publication, authority: snapshot.chosen.artifact.publication.authority });
}

export async function exportShareArtifactV1(options = {}) {
  optionKeys(options, new Set(["stateRoot", "shareId", "permission", "deadlineMs"]), "exportShareArtifactV1 options");
  for (const key of ["shareId", "permission"]) if (!Object.hasOwn(options, key)) fail("ESHARE_INVALID", `exportShareArtifactV1 requires ${key}`);
  const root = stateRootPath(options.stateRoot);
  const shareId = safeId(options.shareId, "exportShareArtifactV1.shareId");
  assertSharePermission(options.permission, EXPORT_PERMISSIONS, root, shareId, "share export permission");
  const startedAt = Date.now();
  const checkDeadline = beginDeadline(options.deadlineMs, "share.export", startedAt);
  const snapshot = await readCurrentSnapshot(root, shareId, checkDeadline, { requestedRevision: options.permission.revision });
  assertShareArtifactNotExpired(snapshot.latest.artifact);
  assertShareArtifactNotExpired(snapshot.chosen.artifact);
  const artifact = snapshot.chosen.artifact;
  const sourceStatus = sourceStatusForBinding(artifact.sourceBinding);
  await requireFreshLocalSource({ root, source: artifact.source, sourceBinding: artifact.sourceBinding, phase: "export", deadlineMs: options.deadlineMs, startedAt });
  assertShareArtifactNotExpired(snapshot.latest.artifact);
  assertShareArtifactNotExpired(snapshot.chosen.artifact);
  const core = { schemaVersion: SHARE_SCHEMA_VERSION, kind: SHARE_EXPORT_KIND, shareId, revision: artifact.revision, artifact: cloneJson(artifact), disclosure: { mode: "sanitized", rawExcluded: true, unknownContent: "blocked" } };
  const exported = deepFreeze({ ...core, exportDigest: digestObject(core) });
  return deepFreeze({ ok: true, operation: "share.export", shareId, revision: artifact.revision, exportDigest: exported.exportDigest, export: exported, published: false, remoteShare: false, authority: "local-advisory-only", sourceStatus });
}

async function writeReplaceJson(root, target, value) {
  try {
    await atomicWriteJson(root, target, value);
  } catch (error) {
    if (error instanceof ShareError) throw error;
    fail("ESHARE_FS", "share mutable index could not be written");
  }
}

async function tombstoneShare({ options, action, permissionSet, usedPermissions, label }) {
  optionKeys(options, new Set(["stateRoot", "shareId", "reason", "permission", "deadlineMs"]), `${label} options`);
  for (const key of ["shareId", "permission"]) if (!Object.hasOwn(options, key)) fail("ESHARE_INVALID", `${label} requires ${key}`);
  const root = stateRootPath(options.stateRoot);
  const shareId = safeId(options.shareId, `${label}.shareId`);
  assertSharePermission(options.permission, permissionSet, root, shareId, `${label} permission`);
  if (usedPermissions.has(options.permission)) fail("ESHARE_PERMISSION", `${label} permission has already been consumed`);
  const checkDeadline = beginDeadline(options.deadlineMs, `share.${action}`);
  const reason = options.reason === undefined ? (action === "expire" ? "share expired" : "owner revoked local share") : boundedText(options.reason, `${label}.reason`, SHARE_LIMITS.maxReasonBytes);
  const lock = await acquireShareLock(root, shareId, checkDeadline);
  try {
    const current = await readCurrentSnapshot(root, shareId, checkDeadline);
    if (options.permission.expectedRevision !== current.latest.artifact.revision) fail("ESHARE_STALE", `${label} permission is stale`);
    if (action === "expire" && Date.parse(current.latest.artifact.expiresAt) > Date.now()) fail("ESHARE_NOT_EXPIRED", "share has not expired");
    const paths = sharePaths(root, shareId);
    const tombstoneCore = { schemaVersion: SHARE_SCHEMA_VERSION, kind: SHARE_TOMBSTONE_KIND, shareId, action, revision: current.latest.artifact.revision, revisionDigest: current.latest.artifact.artifactDigest, at: new Date().toISOString(), reason };
    const tombstone = { ...tombstoneCore, tombstoneDigest: digestObject(tombstoneCore) };
    await writeCreateOnlyJson(root, paths.tombstone, tombstone, checkDeadline);
    const indexCore = { schemaVersion: SHARE_SCHEMA_VERSION, kind: SHARE_INDEX_KIND, shareId, status: SHARE_REVOKED_STATUS, latestRevision: current.latest.artifact.revision, latestDigest: current.latest.artifact.artifactDigest, expiresAt: current.latest.artifact.expiresAt, tombstoneDigest: tombstone.tombstoneDigest };
    await writeReplaceJson(root, paths.index, { ...indexCore, indexDigest: digestObject(indexCore) });
    usedPermissions.add(options.permission);
    return deepFreeze({ ok: true, operation: `share.${action}`, shareId, revision: current.latest.artifact.revision, artifactDigest: current.latest.artifact.artifactDigest, tombstoneDigest: tombstone.tombstoneDigest, status: SHARE_REVOKED_STATUS, publication: current.latest.artifact.publication, authority: "local-advisory-only" });
  } finally {
    await lock.release();
  }
}

export async function revokeShareArtifactV1(options = {}) {
  return tombstoneShare({ options, action: "revoke", permissionSet: REVOKE_PERMISSIONS, usedPermissions: USED_REVOKE_PERMISSIONS, label: "revokeShareArtifactV1" });
}

export async function expireShareArtifactV1(options = {}) {
  return tombstoneShare({ options, action: "expire", permissionSet: EXPIRE_PERMISSIONS, usedPermissions: USED_EXPIRE_PERMISSIONS, label: "expireShareArtifactV1" });
}

export async function listShareArtifactsV1(options = {}) {
  optionKeys(options, new Set(["stateRoot", "permission", "deadlineMs"]), "listShareArtifactsV1 options");
  const root = stateRootPath(options.stateRoot);
  assertCapability(options.permission, READ_PERMISSIONS, "share list permission");
  assertPermissionRoot(options.permission, root, "share list permission");
  if (options.permission.shareId !== null) fail("ESHARE_PERMISSION", "share listing requires an unbound read permission");
  const checkDeadline = beginDeadline(options.deadlineMs, "share.list");
  const sharesRoot = safeJoin(shareStoreRoot(root), "shares");
  if (!(await assertExistingPath(root, sharesRoot))) return deepFreeze([]);
  let entries;
  try {
    entries = await readdir(sharesRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof ShareError) throw error;
    failUnsafePath();
  }
  if (entries.length > SHARE_LIMITS.maxShareCount) fail("ESHARE_LIMIT", "share count exceeds its bound");
  const result = [];
  for (const entry of entries) {
    checkDeadline();
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail("ESHARE_INTEGRITY", "invalid share directory entry");
    const shareId = safeId(entry.name, "share directory");
    try {
      const snapshot = await readCurrentSnapshot(root, shareId, checkDeadline);
      const expired = Date.parse(snapshot.latest.artifact.expiresAt) <= Date.now();
      result.push({ shareId, revision: snapshot.latest.artifact.revision, artifactDigest: snapshot.latest.artifact.artifactDigest, status: expired ? "EXPIRED" : SHARE_STATUS, expiresAt: snapshot.latest.artifact.expiresAt });
    } catch (error) {
      if (["ESHARE_REVOKED", "ESHARE_EXPIRED"].includes(error.code)) continue;
      throw error;
    }
  }
  return deepFreeze(result.sort((left, right) => left.shareId.localeCompare(right.shareId)));
}

export function createShareUnboundReadPermissionV1(options = {}) {
  optionKeys(options, new Set(["stateRoot"]), "share unbound read permission");
  return capability({ kind: SHARE_READ_PERMISSION_KIND, stateRoot: stateRootPath(options.stateRoot), shareId: null, revision: null }, READ_PERMISSIONS);
}
