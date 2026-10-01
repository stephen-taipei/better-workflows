import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  chmod,
  lstat,
  open,
  readFile,
  readdir,
  rename,
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
  safeJoin
} from "./core.mjs";

export const KNOWLEDGE_NODE_SCHEMA_VERSION = 1;
export const KNOWLEDGE_NODE_KIND = "KnowledgeNode";
export const KNOWLEDGE_NODE_REVISION_KIND = "KnowledgeNodeRevisionV1";
export const KNOWLEDGE_NODE_INDEX_KIND = "KnowledgeNodeIndexV1";
export const KNOWLEDGE_NODE_TOMBSTONE_KIND = "KnowledgeNodeTombstoneV1";
export const KNOWLEDGE_NODE_EXPORT_KIND = "KnowledgeNodeExportV1";
export const KNOWLEDGE_NODE_EXPORT_PERMISSION_KIND = "KnowledgeNodeExportPermissionV1";
export const KNOWLEDGE_NODE_READ_PERMISSION_KIND = "KnowledgeNodeReadPermissionV1";
export const KNOWLEDGE_NODE_SAVE_PERMISSION_KIND = "KnowledgeNodeSavePermissionV1";
export const KNOWLEDGE_NODE_REVOKE_PERMISSION_KIND = "KnowledgeNodeRevokePermissionV1";
export const KNOWLEDGE_NODE_DELETE_PERMISSION_KIND = "KnowledgeNodeDeletePermissionV1";
export const KNOWLEDGE_NODE_PRODUCER = "better-workflows-knowledge-local-v1";
export const KNOWLEDGE_NODE_IMPORTED_EXPORT_ORIGIN = "sanitized-export-import";
export const KNOWLEDGE_STORE_DIRECTORY = "knowledge-v1";

export const KNOWLEDGE_NODE_LIMITS = Object.freeze({
  maxRounds: 2,
  maxCandidates: 8,
  maxSnippets: 4,
  maxSnippetBytes: 8 * 1024,
  maxCardBytes: 64 * 1024,
  maxDeadlineMs: 2_000,
  maxNodeBytes: 256 * 1024,
  maxRevisionCount: 128,
  maxNodeCount: 256,
  maxIdBytes: 128,
  maxTextBytes: 16 * 1024,
  maxReasonBytes: 2 * 1024,
  maxSourceScopeBytes: 512
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION_FILE = /^(0|[1-9][0-9]{0,5})\.json$/;
const STORE_ROOT = KNOWLEDGE_STORE_DIRECTORY;
const ACTIVE = "active";
const REVOKED = "revoked";
const KNOWLEDGE_LOCK_SCHEMA_VERSION = 2;
const KNOWLEDGE_LOCK_KIND = "KnowledgeNodeLockV2";
const KNOWLEDGE_GATE_KIND = "KnowledgeNodeLockGateV2";
const KNOWLEDGE_LOCK_V1_KEYS = new Set(["schemaVersion", "kind", "nodeId", "token"]);
const KNOWLEDGE_LOCK_KEYS = new Set([
  "schemaVersion", "kind", "nodeId", "host", "pid", "startIdentity", "token", "fence", "createdAt"
]);
const LOCK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCK_START_IDENTITY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCAL_HOST = os.hostname();
const PROCESS_START_IDENTITY = `${new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString()}#${randomUUID()}`;

const NODE_KEYS = new Set(["schemaVersion", "kind", "nodeId", "revision", "source", "provenance", "rounds", "card"]);
const SOURCE_KEYS = new Set(["revision", "digest", "scope"]);
const PROVENANCE_KEYS = new Set(["producer", "capturedAt", "evidenceDigest", "origin"]);
const ROUND_KEYS = new Set(["round", "candidates"]);
const CANDIDATE_KEYS = new Set(["id", "title", "summary", "snippets"]);
const SNIPPET_KEYS = new Set(["id", "text", "source"]);
const SNIPPET_SOURCE_KEYS = new Set(["label", "digest"]);
const CARD_KEYS = new Set(["title", "summary", "candidateIds", "snippetIds"]);
const EXPORT_KEYS = new Set(["schemaVersion", "kind", "nodeId", "revision", "nodeDigest", "source", "card", "disclosure", "exportDigest"]);
const EXPORT_SOURCE_KEYS = new Set(["revision", "digest"]);
const EXPORT_CARD_KEYS = new Set(["title", "summary", "candidates", "snippets"]);
const EXPORT_CANDIDATE_KEYS = new Set(["id", "title", "summary", "snippetIds"]);
const EXPORT_SNIPPET_KEYS = new Set(["id", "text", "sourceDigest"]);
const EXPORT_DISCLOSURE_KEYS = new Set(["mode", "rawExcluded", "unknownContent", "selectionDigest"]);
const INDEX_KEYS = new Set([
  "schemaVersion", "kind", "nodeId", "status", "revision", "revisionDigest", "tombstoneDigest", "indexDigest"
]);
const TOMBSTONE_KEYS = new Set([
  "schemaVersion", "kind", "nodeId", "action", "revision", "revisionDigest", "at", "reason", "tombstoneDigest"
]);
const READ_PERMISSIONS = new WeakSet();
const SAVE_PERMISSIONS = new WeakSet();
const REVOKE_PERMISSIONS = new WeakSet();
const DELETE_PERMISSIONS = new WeakSet();
const EXPORT_PERMISSIONS = new WeakSet();
const USED_SAVE_PERMISSIONS = new WeakSet();
const USED_REVOKE_PERMISSIONS = new WeakSet();
const USED_DELETE_PERMISSIONS = new WeakSet();

// These opaque capabilities only separate local read/save/revoke/delete/export
// call sites.  They are not owner decisions, signatures, provider credentials,
// or evidence truth, and a caller-supplied provenance field never becomes
// authoritative merely because it matches this module's schema.

export class KnowledgeNodeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "KnowledgeNodeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new KnowledgeNodeError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail("EKNOWLEDGE_INVALID", `${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("EKNOWLEDGE_INVALID", `${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor.get || descriptor.set) fail("EKNOWLEDGE_INVALID", `${label}.${key} must be a data property`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) unknown.push(String(key));
  }
  unknown.sort();
  if (unknown.length > 0) fail("EKNOWLEDGE_INVALID", `${label} contains unknown field(s): ${unknown.join(", ")}`);
}

function requireKeys(value, keys, label) {
  for (const key of keys) if (!Object.hasOwn(value, key)) fail("EKNOWLEDGE_INVALID", `${label} requires ${key}`);
}

function boundedText(value, label, maxBytes, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && value.length === 0) || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("EKNOWLEDGE_INVALID", `${label} must be bounded text`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) fail("EKNOWLEDGE_LIMIT", `${label} exceeds ${maxBytes} bytes`);
  return value;
}

function safeId(value, label, { short = false } = {}) {
  const pattern = short ? SAFE_SHORT_ID : SAFE_ID;
  if (typeof value !== "string" || !pattern.test(value) || Buffer.byteLength(value, "utf8") > KNOWLEDGE_NODE_LIMITS.maxIdBytes) {
    fail("EKNOWLEDGE_INVALID", `${label} must be a safe id`);
  }
  return value;
}

function boundedInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("EKNOWLEDGE_INVALID", `${label} must be an integer from ${min} through ${max}`);
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("EKNOWLEDGE_INVALID", `${label} must be a lowercase SHA-256 digest`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    fail("EKNOWLEDGE_INVALID", `${label} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function arrayShape(value, label, { maxLength = null } = {}) {
  if (!Array.isArray(value)) fail("EKNOWLEDGE_INVALID", `${label} must be an array`);
  // Check length before inspecting any element or enumerable property.  This
  // keeps invalid sparse/hostile arrays bounded and avoids invoking an element
  // getter when the declared cardinality already violates the contract.
  if (maxLength !== null && value.length > maxLength) fail("EKNOWLEDGE_LIMIT", `${label} exceeds the bounded array length`);
  if (Object.getPrototypeOf(value) !== Array.prototype) fail("EKNOWLEDGE_INVALID", `${label} has an unexpected prototype`);
  const ownKeys = Reflect.ownKeys(value);
  if (maxLength !== null && ownKeys.length > maxLength + 1) fail("EKNOWLEDGE_LIMIT", `${label} contains too many own properties`);
  const descriptors = new Map();
  for (const key of ownKeys) {
    if (typeof key !== "string") fail("EKNOWLEDGE_INVALID", `${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) fail("EKNOWLEDGE_INVALID", `${label}.${key} must be a data property`);
    if (key === "length") {
      if (descriptor.value !== value.length) fail("EKNOWLEDGE_INVALID", `${label}.length is inconsistent`);
      descriptors.set(key, descriptor);
      continue;
    }
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length || !Number.isSafeInteger(Number(key))) {
      fail("EKNOWLEDGE_INVALID", `${label} contains a non-index array property`);
    }
    descriptors.set(key, descriptor);
  }
  return { length: value.length, descriptors };
}

function arrayValues(value, label, options = {}) {
  const { length, descriptors } = arrayShape(value, label, options);
  const result = [];
  for (let index = 0; index < length; index += 1) {
    result.push(descriptors.get(String(index))?.value);
  }
  return result;
}

function uniqueIds(value, label, { short = true, maxLength = null } = {}) {
  const items = arrayValues(value, label, { maxLength });
  const result = [];
  for (let index = 0; index < items.length; index += 1) {
    result.push(safeId(items[index], `${label}[${index}]`, { short }));
  }
  if (new Set(result).size !== result.length) fail("EKNOWLEDGE_INVALID", `${label} must contain unique ids`);
  return result;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneJson(value) {
  if (Array.isArray(value)) {
    const result = [];
    for (let index = 0; index < value.length; index += 1) result.push(cloneJson(value[index]));
    return result;
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = cloneJson(child);
    return result;
  }
  return value;
}

function failUnsafePath(message = "knowledge filesystem path is unsafe") {
  fail("EKNOWLEDGE_FS", message);
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
      if (error?.code !== "ENOENT") failUnsafePath("knowledge state root could not be inspected");
    }
    if (info) {
      if (info.isSymbolicLink() && (current === root || !isTrustedMacOsAlias(current))) {
        failUnsafePath("knowledge state root contains an unsafe symbolic link");
      }
      if (!info.isSymbolicLink() && !info.isDirectory()) {
        failUnsafePath("knowledge state root contains a non-directory component");
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
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("EKNOWLEDGE_INVALID", "stateRoot must be an absolute path");
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) fail("EKNOWLEDGE_INVALID", "stateRoot is too broad");
  return assertCanonicalStateRootPath(resolved);
}

function capabilityRoot(value, stateRoot, label) {
  if (value.stateRoot !== stateRoot) fail("EKNOWLEDGE_PERMISSION", `${label} is bound to a different state root`);
}

function permissionKeys(value, allowed, label) {
  exactKeys(value, allowed, label);
  return value;
}

function beginDeadline(value, label, startedAt = Date.now()) {
  const deadlineMs = value === undefined ? KNOWLEDGE_NODE_LIMITS.maxDeadlineMs : boundedInteger(value, `${label}.deadlineMs`, 1, KNOWLEDGE_NODE_LIMITS.maxDeadlineMs);
  return () => {
    if (Date.now() - startedAt >= deadlineMs) fail("EKNOWLEDGE_DEADLINE", `${label} exceeded the ${deadlineMs}ms deadline`);
  };
}

function capability(value, set) {
  const result = deepFreeze(value);
  set.add(result);
  return result;
}

function assertCapability(value, set, label) {
  if (!value || typeof value !== "object" || !set.has(value)) fail("EKNOWLEDGE_PERMISSION", `${label} is not a genuine module capability`);
}

function sourceValue(value) {
  exactKeys(value, SOURCE_KEYS, "node.source");
  requireKeys(value, ["revision", "digest", "scope"], "node.source");
  return {
    revision: boundedText(value.revision, "node.source.revision", 256),
    digest: digest(value.digest, "node.source.digest"),
    scope: boundedText(value.scope, "node.source.scope", KNOWLEDGE_NODE_LIMITS.maxSourceScopeBytes)
  };
}

// Provenance is retained for traceability only.  This advisory store does not
// promote a matching producer string or evidence digest into an attestation.
function provenanceValue(value) {
  exactKeys(value, PROVENANCE_KEYS, "node.provenance");
  requireKeys(value, ["producer", "capturedAt", "evidenceDigest"], "node.provenance");
  if (value.producer !== KNOWLEDGE_NODE_PRODUCER) fail("EKNOWLEDGE_INVALID", "node.provenance.producer is not the local advisory producer");
  const normalized = {
    producer: KNOWLEDGE_NODE_PRODUCER,
    capturedAt: timestamp(value.capturedAt, "node.provenance.capturedAt"),
    evidenceDigest: digest(value.evidenceDigest, "node.provenance.evidenceDigest")
  };
  if (value.origin !== undefined) {
    if (value.origin !== KNOWLEDGE_NODE_IMPORTED_EXPORT_ORIGIN) fail("EKNOWLEDGE_INVALID", "node.provenance.origin is unsupported");
    normalized.origin = KNOWLEDGE_NODE_IMPORTED_EXPORT_ORIGIN;
  }
  return normalized;
}

function snippetSourceValue(value, label) {
  exactKeys(value, SNIPPET_SOURCE_KEYS, label);
  requireKeys(value, ["label", "digest"], label);
  return {
    label: boundedText(value.label, `${label}.label`, 512),
    digest: digest(value.digest, `${label}.digest`)
  };
}

function snippetValue(value, label) {
  exactKeys(value, SNIPPET_KEYS, label);
  requireKeys(value, ["id", "text", "source"], label);
  return {
    id: safeId(value.id, `${label}.id`, { short: true }),
    text: boundedText(value.text, `${label}.text`, KNOWLEDGE_NODE_LIMITS.maxTextBytes),
    source: snippetSourceValue(value.source, `${label}.source`)
  };
}

function candidateValue(value, label) {
  exactKeys(value, CANDIDATE_KEYS, label);
  requireKeys(value, ["id", "title", "summary", "snippets"], label);
  const rawSnippets = arrayValues(value.snippets, `${label}.snippets`, { maxLength: KNOWLEDGE_NODE_LIMITS.maxSnippets });
  const snippets = [];
  for (let index = 0; index < rawSnippets.length; index += 1) {
    snippets.push(snippetValue(rawSnippets[index], `${label}.snippets[${index}]`));
  }
  return {
    id: safeId(value.id, `${label}.id`, { short: true }),
    title: boundedText(value.title, `${label}.title`, KNOWLEDGE_NODE_LIMITS.maxTextBytes),
    summary: boundedText(value.summary, `${label}.summary`, KNOWLEDGE_NODE_LIMITS.maxTextBytes),
    snippets
  };
}

function roundValue(value, label) {
  exactKeys(value, ROUND_KEYS, label);
  requireKeys(value, ["round", "candidates"], label);
  const round = boundedInteger(value.round, `${label}.round`, 1, KNOWLEDGE_NODE_LIMITS.maxRounds);
  const rawCandidates = arrayValues(value.candidates, `${label}.candidates`, { maxLength: KNOWLEDGE_NODE_LIMITS.maxCandidates });
  const candidates = [];
  for (let index = 0; index < rawCandidates.length; index += 1) {
    candidates.push(candidateValue(rawCandidates[index], `${label}.candidates[${index}]`));
  }
  if (candidates.length === 0) fail("EKNOWLEDGE_INVALID", `${label}.candidates must not be empty`);
  return { round, candidates };
}

function cardValue(value, candidateIds, snippetIds) {
  exactKeys(value, CARD_KEYS, "node.card");
  requireKeys(value, ["title", "summary", "candidateIds", "snippetIds"], "node.card");
  const card = {
    title: boundedText(value.title, "node.card.title", KNOWLEDGE_NODE_LIMITS.maxTextBytes),
    summary: boundedText(value.summary, "node.card.summary", KNOWLEDGE_NODE_LIMITS.maxTextBytes),
    candidateIds: uniqueIds(value.candidateIds, "node.card.candidateIds", { maxLength: KNOWLEDGE_NODE_LIMITS.maxCandidates }),
    snippetIds: uniqueIds(value.snippetIds, "node.card.snippetIds", { maxLength: KNOWLEDGE_NODE_LIMITS.maxSnippets })
  };
  if (card.candidateIds.length === 0 || card.snippetIds.length === 0) fail("EKNOWLEDGE_INVALID", "node.card must select candidates and snippets explicitly");
  if (card.candidateIds.some((id) => !candidateIds.has(id))) fail("EKNOWLEDGE_INVALID", "node.card selects an unknown candidate");
  if (card.snippetIds.some((id) => !snippetIds.has(id))) fail("EKNOWLEDGE_INVALID", "node.card selects an unknown snippet");
  const bytes = Buffer.byteLength(canonicalJson(card), "utf8");
  if (bytes > KNOWLEDGE_NODE_LIMITS.maxCardBytes) fail("EKNOWLEDGE_LIMIT", `node.card exceeds ${KNOWLEDGE_NODE_LIMITS.maxCardBytes} bytes`);
  return card;
}

function exportSourceValue(value) {
  if (value === null) return null;
  exactKeys(value, EXPORT_SOURCE_KEYS, "export.source");
  requireKeys(value, ["revision", "digest"], "export.source");
  return {
    revision: boundedText(value.revision, "export.source.revision", 256),
    digest: digest(value.digest, "export.source.digest")
  };
}

function exportCandidateValue(value, label) {
  exactKeys(value, EXPORT_CANDIDATE_KEYS, label);
  requireKeys(value, ["id", "title", "summary", "snippetIds"], label);
  return {
    id: safeId(value.id, `${label}.id`, { short: true }),
    title: boundedText(value.title, `${label}.title`, KNOWLEDGE_NODE_LIMITS.maxTextBytes),
    summary: boundedText(value.summary, `${label}.summary`, KNOWLEDGE_NODE_LIMITS.maxTextBytes),
    snippetIds: uniqueIds(value.snippetIds, `${label}.snippetIds`, { maxLength: KNOWLEDGE_NODE_LIMITS.maxSnippets })
  };
}

function exportSnippetValue(value, label) {
  exactKeys(value, EXPORT_SNIPPET_KEYS, label);
  requireKeys(value, ["id", "text"], label);
  const normalized = {
    id: safeId(value.id, `${label}.id`, { short: true }),
    text: boundedText(value.text, `${label}.text`, KNOWLEDGE_NODE_LIMITS.maxTextBytes)
  };
  if (value.sourceDigest !== undefined) normalized.sourceDigest = digest(value.sourceDigest, `${label}.sourceDigest`);
  return normalized;
}

function exportCardValue(value, checkDeadline) {
  exactKeys(value, EXPORT_CARD_KEYS, "export.card");
  requireKeys(value, ["title", "summary", "candidates", "snippets"], "export.card");
  const rawCandidates = arrayValues(value.candidates, "export.card.candidates", { maxLength: KNOWLEDGE_NODE_LIMITS.maxCandidates });
  const rawSnippets = arrayValues(value.snippets, "export.card.snippets", { maxLength: KNOWLEDGE_NODE_LIMITS.maxSnippets });
  if (rawCandidates.length === 0 || rawSnippets.length === 0) fail("EKNOWLEDGE_INVALID", "export.card must contain candidates and snippets");
  const candidates = [];
  const snippets = [];
  const candidateIds = new Set();
  const snippetIds = new Set();
  let snippetBytes = 0;
  for (let index = 0; index < rawSnippets.length; index += 1) {
    checkDeadline();
    const snippet = exportSnippetValue(rawSnippets[index], `export.card.snippets[${index}]`);
    if (snippetIds.has(snippet.id)) fail("EKNOWLEDGE_INVALID", `duplicate export snippet id: ${snippet.id}`);
    snippetIds.add(snippet.id);
    snippetBytes += Buffer.byteLength(snippet.text, "utf8");
    if (snippetBytes > KNOWLEDGE_NODE_LIMITS.maxSnippetBytes) fail("EKNOWLEDGE_LIMIT", "export.card.snippets exceeds the 8KiB limit");
    snippets.push(snippet);
  }
  for (let index = 0; index < rawCandidates.length; index += 1) {
    checkDeadline();
    const candidate = exportCandidateValue(rawCandidates[index], `export.card.candidates[${index}]`);
    if (candidateIds.has(candidate.id)) fail("EKNOWLEDGE_INVALID", `duplicate export candidate id: ${candidate.id}`);
    candidateIds.add(candidate.id);
    if (candidate.snippetIds.some((id) => !snippetIds.has(id))) fail("EKNOWLEDGE_INVALID", `export candidate selects an unknown snippet: ${candidate.id}`);
    for (const snippetId of candidate.snippetIds) {
      if (candidates.some((item) => item.snippetIds.includes(snippetId))) fail("EKNOWLEDGE_INVALID", `export snippet association is ambiguous: ${snippetId}`);
    }
    candidates.push(candidate);
  }
  const associatedSnippetIds = new Set(candidates.flatMap((candidate) => candidate.snippetIds));
  for (const snippetId of snippetIds) {
    if (!associatedSnippetIds.has(snippetId)) fail("EKNOWLEDGE_INVALID", `export snippet is not associated with a selected candidate: ${snippetId}`);
  }
  const card = {
    title: boundedText(value.title, "export.card.title", KNOWLEDGE_NODE_LIMITS.maxTextBytes),
    summary: boundedText(value.summary, "export.card.summary", KNOWLEDGE_NODE_LIMITS.maxTextBytes),
    candidates,
    snippets
  };
  if (Buffer.byteLength(canonicalJson(card), "utf8") > KNOWLEDGE_NODE_LIMITS.maxCardBytes) fail("EKNOWLEDGE_LIMIT", "export.card exceeds the bounded size");
  return { card, candidateIds, snippetIds };
}

/**
 * Validate a sanitized export without treating its source digest, producer
 * metadata, disclosure assertion, or original node digest as authority.
 * Older V1 exports without candidate.snippetIds are rejected because the
 * association cannot be reconstructed without guessing private data.
 */
export function validateKnowledgeNodeExportV1(value, options = {}) {
  exactKeys(options, new Set(["deadlineMs"]), "validateKnowledgeNodeExportV1 options");
  const checkDeadline = beginDeadline(options.deadlineMs, "knowledge.export.validate");
  exactKeys(value, EXPORT_KEYS, "knowledge export");
  requireKeys(value, [...EXPORT_KEYS], "knowledge export");
  if (value.schemaVersion !== KNOWLEDGE_NODE_SCHEMA_VERSION) fail("EKNOWLEDGE_INVALID", "export.schemaVersion is unsupported");
  if (value.kind !== KNOWLEDGE_NODE_EXPORT_KIND) fail("EKNOWLEDGE_INVALID", "export.kind is unsupported");
  const nodeId = safeId(value.nodeId, "export.nodeId");
  const revision = boundedInteger(value.revision, "export.revision", 1, KNOWLEDGE_NODE_LIMITS.maxRevisionCount);
  const nodeDigest = digest(value.nodeDigest, "export.nodeDigest");
  const source = exportSourceValue(value.source);
  const { card, candidateIds, snippetIds } = exportCardValue(value.card, checkDeadline);
  exactKeys(value.disclosure, EXPORT_DISCLOSURE_KEYS, "export.disclosure");
  requireKeys(value.disclosure, [...EXPORT_DISCLOSURE_KEYS], "export.disclosure");
  if (value.disclosure.mode !== "sanitized" || value.disclosure.rawExcluded !== true || value.disclosure.unknownContent !== "blocked") {
    fail("EKNOWLEDGE_INVALID", "export.disclosure is not a sanitized blocked-content declaration");
  }
  const candidateIdList = card.candidates.map((candidate) => candidate.id);
  const snippetIdList = card.snippets.map((snippet) => snippet.id);
  const selectionDigest = digestObject({ candidateIds: candidateIdList, snippetIds: snippetIdList });
  if (value.disclosure.selectionDigest !== selectionDigest) fail("EKNOWLEDGE_INTEGRITY", "export selection digest is stale");
  const core = {
    schemaVersion: KNOWLEDGE_NODE_SCHEMA_VERSION,
    kind: KNOWLEDGE_NODE_EXPORT_KIND,
    nodeId,
    revision,
    nodeDigest,
    source,
    card,
    disclosure: {
      mode: "sanitized",
      rawExcluded: true,
      unknownContent: "blocked",
      selectionDigest
    }
  };
  if (value.exportDigest !== digestObject(core)) fail("EKNOWLEDGE_INTEGRITY", "export digest is stale");
  checkDeadline();
  if (candidateIds.size !== candidateIdList.length || snippetIds.size !== snippetIdList.length) fail("EKNOWLEDGE_INVALID", "export selection contains duplicate ids");
  return deepFreeze({ ...core, exportDigest: value.exportDigest });
}

function preflightKnowledgeArrays(value, checkDeadline) {
  const rawRounds = arrayValues(value.rounds, "node.rounds", { maxLength: KNOWLEDGE_NODE_LIMITS.maxRounds });
  if (rawRounds.length === 0) fail("EKNOWLEDGE_LIMIT", "node.rounds must contain at least one round");
  let candidateCount = 0;
  let snippetCount = 0;
  for (let roundIndex = 0; roundIndex < rawRounds.length; roundIndex += 1) {
    checkDeadline();
    const rawRound = rawRounds[roundIndex];
    exactKeys(rawRound, ROUND_KEYS, `node.rounds[${roundIndex}]`);
    requireKeys(rawRound, ["round", "candidates"], `node.rounds[${roundIndex}]`);
    const rawCandidates = arrayValues(rawRound.candidates, `node.rounds[${roundIndex}].candidates`, {
      maxLength: KNOWLEDGE_NODE_LIMITS.maxCandidates
    });
    candidateCount += rawCandidates.length;
    if (candidateCount > KNOWLEDGE_NODE_LIMITS.maxCandidates) fail("EKNOWLEDGE_LIMIT", "node.candidates exceeds the eight-candidate limit");
    for (let candidateIndex = 0; candidateIndex < rawCandidates.length; candidateIndex += 1) {
      checkDeadline();
      const rawCandidate = rawCandidates[candidateIndex];
      exactKeys(rawCandidate, CANDIDATE_KEYS, `node.rounds[${roundIndex}].candidates[${candidateIndex}]`);
      requireKeys(rawCandidate, ["id", "title", "summary", "snippets"], `node.rounds[${roundIndex}].candidates[${candidateIndex}]`);
      const rawSnippets = arrayValues(rawCandidate.snippets, `node.rounds[${roundIndex}].candidates[${candidateIndex}].snippets`, {
        maxLength: KNOWLEDGE_NODE_LIMITS.maxSnippets
      });
      snippetCount += rawSnippets.length;
      if (snippetCount > KNOWLEDGE_NODE_LIMITS.maxSnippets) fail("EKNOWLEDGE_LIMIT", "node.snippets exceeds the four-snippet limit");
    }
  }
  return rawRounds;
}

export function validateKnowledgeNodeV1(value, options = {}) {
  exactKeys(options, new Set(["deadlineMs"]), "validateKnowledgeNodeV1 options");
  const checkDeadline = beginDeadline(options.deadlineMs, "knowledge.validate");
  exactKeys(value, NODE_KEYS, "node");
  requireKeys(value, ["schemaVersion", "kind", "nodeId", "revision", "source", "provenance", "rounds", "card"], "node");
  if (value.schemaVersion !== KNOWLEDGE_NODE_SCHEMA_VERSION) fail("EKNOWLEDGE_INVALID", "node.schemaVersion is unsupported");
  if (value.kind !== KNOWLEDGE_NODE_KIND) fail("EKNOWLEDGE_INVALID", "node.kind is unsupported");
  const nodeId = safeId(value.nodeId, "node.nodeId");
  const revision = boundedInteger(value.revision, "node.revision", 1, KNOWLEDGE_NODE_LIMITS.maxRevisionCount);
  const source = sourceValue(value.source);
  const provenance = provenanceValue(value.provenance);
  checkDeadline();
  const rawRounds = preflightKnowledgeArrays(value, checkDeadline);
  const rounds = [];
  for (let index = 0; index < rawRounds.length; index += 1) {
    checkDeadline();
    rounds.push(roundValue(rawRounds[index], `node.rounds[${index}]`));
  }
  checkDeadline();
  for (let index = 0; index < rounds.length; index += 1) {
    checkDeadline();
    if (rounds[index].round !== index + 1) fail("EKNOWLEDGE_INVALID", "node.rounds must be contiguous and ordered");
  }

  const candidates = new Map();
  const snippets = new Map();
  let snippetBytes = 0;
  let candidateCount = 0;
  for (const round of rounds) {
    checkDeadline();
    candidateCount += round.candidates.length;
    if (candidateCount > KNOWLEDGE_NODE_LIMITS.maxCandidates) fail("EKNOWLEDGE_LIMIT", "node.candidates exceeds the eight-candidate limit");
    for (const candidate of round.candidates) {
      checkDeadline();
      if (candidates.has(candidate.id)) fail("EKNOWLEDGE_INVALID", `duplicate candidate id: ${candidate.id}`);
      candidates.set(candidate.id, candidate);
      for (const snippet of candidate.snippets) {
        checkDeadline();
        if (snippets.has(snippet.id)) fail("EKNOWLEDGE_INVALID", `duplicate snippet id: ${snippet.id}`);
        snippets.set(snippet.id, snippet);
        snippetBytes += Buffer.byteLength(snippet.text, "utf8");
        if (snippets.size > KNOWLEDGE_NODE_LIMITS.maxSnippets) fail("EKNOWLEDGE_LIMIT", "node.snippets exceeds the four-snippet limit");
        if (snippetBytes > KNOWLEDGE_NODE_LIMITS.maxSnippetBytes) fail("EKNOWLEDGE_LIMIT", "node.snippets exceeds the 8KiB limit");
      }
    }
  }
  const card = cardValue(value.card, candidates, snippets);
  checkDeadline();
  const normalized = {
    schemaVersion: KNOWLEDGE_NODE_SCHEMA_VERSION,
    kind: KNOWLEDGE_NODE_KIND,
    nodeId,
    revision,
    source,
    provenance,
    rounds,
    card
  };
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > KNOWLEDGE_NODE_LIMITS.maxNodeBytes) {
    fail("EKNOWLEDGE_LIMIT", `node exceeds ${KNOWLEDGE_NODE_LIMITS.maxNodeBytes} bytes`);
  }
  checkDeadline();
  return deepFreeze(normalized);
}

export function knowledgeStoreRoot(stateRoot = getStateRoot()) {
  return safeJoin(stateRootPath(stateRoot), STORE_ROOT);
}

async function assertNoSymlinkSafe(root, target) {
  try {
    return await assertNoSymlinkUnder(root, target);
  } catch (error) {
    if (error instanceof KnowledgeNodeError) throw error;
    failUnsafePath();
  }
}

async function ensurePrivateDirSafe(target) {
  try {
    return await ensurePrivateDir(target);
  } catch (error) {
    if (error instanceof KnowledgeNodeError) throw error;
    failUnsafePath();
  }
}

async function atomicWriteKnowledgeJson(root, target, value, label = "knowledge record") {
  await assertNoSymlinkSafe(root, target);
  try {
    await atomicWriteJson(root, target, value);
  } catch (error) {
    if (error instanceof KnowledgeNodeError) throw error;
    failUnsafePath(`${label} could not be written`);
  }
}

export function createKnowledgeReadPermission({ stateRoot = getStateRoot(), nodeId = null, revision = null } = {}) {
  const root = stateRootPath(stateRoot);
  if (nodeId !== null) safeId(nodeId, "read permission.nodeId");
  if (revision !== null) boundedInteger(revision, "read permission.revision", 1, KNOWLEDGE_NODE_LIMITS.maxRevisionCount);
  return capability({
    kind: KNOWLEDGE_NODE_READ_PERMISSION_KIND,
    stateRoot: root,
    nodeId,
    revision
  }, READ_PERMISSIONS);
}

export function createKnowledgeSavePermission({ stateRoot = getStateRoot(), nodeId, expectedRevision = 0 } = {}) {
  const root = stateRootPath(stateRoot);
  safeId(nodeId, "save permission.nodeId");
  boundedInteger(expectedRevision, "save permission.expectedRevision", 0, KNOWLEDGE_NODE_LIMITS.maxRevisionCount - 1);
  return capability({
    kind: KNOWLEDGE_NODE_SAVE_PERMISSION_KIND,
    stateRoot: root,
    nodeId,
    expectedRevision
  }, SAVE_PERMISSIONS);
}

function createMutationPermission({ stateRoot = getStateRoot(), nodeId, expectedRevision = 0 }, kind, set, label) {
  const root = stateRootPath(stateRoot);
  safeId(nodeId, `${label}.nodeId`);
  boundedInteger(expectedRevision, `${label}.expectedRevision`, 1, KNOWLEDGE_NODE_LIMITS.maxRevisionCount);
  return capability({ kind, stateRoot: root, nodeId, expectedRevision }, set);
}

export function createKnowledgeRevokePermission(options = {}) {
  return createMutationPermission(options, KNOWLEDGE_NODE_REVOKE_PERMISSION_KIND, REVOKE_PERMISSIONS, "revoke permission");
}

export function createKnowledgeDeletePermission(options = {}) {
  return createMutationPermission(options, KNOWLEDGE_NODE_DELETE_PERMISSION_KIND, DELETE_PERMISSIONS, "delete permission");
}

export function createKnowledgeExportPermission({
  stateRoot = getStateRoot(),
  nodeId,
  revision,
  candidateIds,
  snippetIds,
  privacy
} = {}) {
  const root = stateRootPath(stateRoot);
  safeId(nodeId, "export permission.nodeId");
  boundedInteger(revision, "export permission.revision", 1, KNOWLEDGE_NODE_LIMITS.maxRevisionCount);
  const normalizedCandidates = uniqueIds(candidateIds, "export permission.candidateIds", { maxLength: KNOWLEDGE_NODE_LIMITS.maxCandidates });
  const normalizedSnippets = uniqueIds(snippetIds, "export permission.snippetIds", { maxLength: KNOWLEDGE_NODE_LIMITS.maxSnippets });
  if (normalizedCandidates.length === 0 || normalizedSnippets.length === 0) fail("EKNOWLEDGE_PERMISSION", "export permission requires a non-empty explicit selection");
  exactKeys(privacy, new Set(["mode", "status", "excludeRaw", "unknownContent", "includeSourceDigest"]), "export permission.privacy");
  requireKeys(privacy, ["mode", "status", "excludeRaw", "unknownContent", "includeSourceDigest"], "export permission.privacy");
  if (privacy.mode !== "sanitized" || privacy.status !== "approved" || privacy.excludeRaw !== true || privacy.unknownContent !== "blocked" || typeof privacy.includeSourceDigest !== "boolean") {
    fail("EKNOWLEDGE_PERMISSION", "export requires explicit approved sanitized selection and blocked unknown content");
  }
  return capability({
    kind: KNOWLEDGE_NODE_EXPORT_PERMISSION_KIND,
    stateRoot: root,
    nodeId,
    revision,
    candidateIds: normalizedCandidates,
    snippetIds: normalizedSnippets,
    privacy: {
      mode: "sanitized",
      status: "approved",
      excludeRaw: true,
      unknownContent: "blocked",
      includeSourceDigest: privacy.includeSourceDigest
    }
  }, EXPORT_PERMISSIONS);
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    failUnsafePath("knowledge storage path could not be inspected");
  }
}

async function optionalStat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    failUnsafePath("knowledge storage path could not be inspected");
  }
}

async function assertReadOnlyPath(root, target) {
  const resolvedRoot = path.resolve(root);
  const rootInfo = await optionalStat(resolvedRoot);
  if (!rootInfo) return false;
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) failUnsafePath("knowledge state root is unsafe");
  const relative = path.relative(resolvedRoot, path.resolve(target));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    failUnsafePath("knowledge path escapes state root");
  }
  let current = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await optionalStat(current);
    if (!info) return false;
    if (info.isSymbolicLink()) failUnsafePath("knowledge path contains a symlink");
  }
  return true;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (error instanceof KnowledgeNodeError) throw error;
    failUnsafePath("knowledge directory sync failed");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ensureStore(stateRoot) {
  const root = knowledgeStoreRoot(stateRoot);
  await assertNoSymlinkSafe(stateRoot, root);
  await ensurePrivateDirSafe(root);
  const nodes = safeJoin(root, "nodes");
  const locks = safeJoin(root, "locks");
  await assertNoSymlinkSafe(stateRoot, nodes);
  await assertNoSymlinkSafe(stateRoot, locks);
  await ensurePrivateDirSafe(nodes);
  await ensurePrivateDirSafe(locks);
  return { root, nodes, locks };
}

function nodePaths(stateRoot, nodeId) {
  const store = knowledgeStoreRoot(stateRoot);
  const nodes = safeJoin(store, "nodes");
  const nodeDir = safeJoin(nodes, nodeId);
  const revisions = safeJoin(nodeDir, "revisions");
  return {
    store,
    nodes,
    nodeDir,
    revisions,
    index: safeJoin(nodeDir, "index.json"),
    tombstone: safeJoin(nodeDir, "tombstone.json"),
    lock: safeJoin(store, "locks", `${nodeId}.lock`),
    gate: safeJoin(store, "locks", `${nodeId}.gate`)
  };
}

async function readRegularJson(stateRoot, target, label) {
  const present = await assertReadOnlyPath(stateRoot, target);
  if (!present) return null;
  const info = await optionalStat(target);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) fail("EKNOWLEDGE_FS", `${label} is not a regular private file`);
  if (info.size > KNOWLEDGE_NODE_LIMITS.maxNodeBytes) fail("EKNOWLEDGE_LIMIT", `${label} exceeds the bounded record size`);
  let parsed;
  let content;
  try {
    content = await readFile(target, "utf8");
  } catch (error) {
    failUnsafePath(`${label} could not be read`);
  }
  try {
    parsed = JSON.parse(content);
  } catch {
    fail("EKNOWLEDGE_INTEGRITY", `${label} is not valid JSON`);
  }
  return parsed;
}

async function writeCreateOnlyJson(stateRoot, target, value, checkDeadline) {
  checkDeadline();
  const parent = path.dirname(target);
  await assertNoSymlinkSafe(stateRoot, parent);
  await ensurePrivateDirSafe(parent);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (bytes.byteLength > KNOWLEDGE_NODE_LIMITS.maxNodeBytes) fail("EKNOWLEDGE_LIMIT", "knowledge record exceeds the bounded size");
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  let created = false;
  try {
    handle = await open(target, flags, 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(target, 0o600);
    await syncDirectory(parent);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error.code === "EEXIST") fail("EKNOWLEDGE_CONFLICT", "knowledge record already exists");
    if (created) {
      try {
        const info = await lstat(target);
        if (info.isFile() && !info.isSymbolicLink()) await unlink(target);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") failUnsafePath("knowledge record cleanup failed");
      }
    }
    if (error instanceof KnowledgeNodeError) throw error;
    failUnsafePath("knowledge immutable file could not be written");
  }
  checkDeadline();
}

function sealedCore(value, digestKey) {
  return { ...value, [digestKey]: digestObject(value) };
}

function validateIndex(value, expectedNodeId) {
  exactKeys(value, INDEX_KEYS, "knowledge index");
  requireKeys(value, [...INDEX_KEYS], "knowledge index");
  if (value.schemaVersion !== KNOWLEDGE_NODE_SCHEMA_VERSION || value.kind !== KNOWLEDGE_NODE_INDEX_KIND) fail("EKNOWLEDGE_INTEGRITY", "knowledge index kind is invalid");
  if (value.nodeId !== expectedNodeId) fail("EKNOWLEDGE_INTEGRITY", "knowledge index node identity changed");
  if (![ACTIVE, REVOKED].includes(value.status)) fail("EKNOWLEDGE_INTEGRITY", "knowledge index status is invalid");
  const normalized = {
    schemaVersion: 1,
    kind: KNOWLEDGE_NODE_INDEX_KIND,
    nodeId: safeId(value.nodeId, "knowledge index.nodeId"),
    status: value.status,
    revision: boundedInteger(value.revision, "knowledge index.revision", 1, KNOWLEDGE_NODE_LIMITS.maxRevisionCount),
    revisionDigest: digest(value.revisionDigest, "knowledge index.revisionDigest"),
    tombstoneDigest: value.tombstoneDigest === null ? null : digest(value.tombstoneDigest, "knowledge index.tombstoneDigest")
  };
  if (digestObject(normalized) !== value.indexDigest) fail("EKNOWLEDGE_INTEGRITY", "knowledge index digest mismatch");
  return deepFreeze(normalized);
}

function validateTombstone(value, expectedNodeId) {
  exactKeys(value, TOMBSTONE_KEYS, "knowledge tombstone");
  requireKeys(value, [...TOMBSTONE_KEYS], "knowledge tombstone");
  if (value.schemaVersion !== KNOWLEDGE_NODE_SCHEMA_VERSION || value.kind !== KNOWLEDGE_NODE_TOMBSTONE_KIND) fail("EKNOWLEDGE_INTEGRITY", "knowledge tombstone kind is invalid");
  const normalized = {
    schemaVersion: 1,
    kind: KNOWLEDGE_NODE_TOMBSTONE_KIND,
    nodeId: safeId(value.nodeId, "knowledge tombstone.nodeId"),
    action: value.action,
    revision: boundedInteger(value.revision, "knowledge tombstone.revision", 1, KNOWLEDGE_NODE_LIMITS.maxRevisionCount),
    revisionDigest: digest(value.revisionDigest, "knowledge tombstone.revisionDigest"),
    at: timestamp(value.at, "knowledge tombstone.at"),
    reason: boundedText(value.reason, "knowledge tombstone.reason", KNOWLEDGE_NODE_LIMITS.maxReasonBytes)
  };
  if (normalized.nodeId !== expectedNodeId || !["revoke", "delete"].includes(normalized.action)) fail("EKNOWLEDGE_INTEGRITY", "knowledge tombstone identity or action is invalid");
  if (digestObject(normalized) !== value.tombstoneDigest) fail("EKNOWLEDGE_INTEGRITY", "knowledge tombstone digest mismatch");
  return deepFreeze(normalized);
}

async function listRevisionFiles(stateRoot, revisions, checkDeadline) {
  checkDeadline();
  const present = await assertReadOnlyPath(stateRoot, revisions);
  if (!present) return [];
  const info = await optionalStat(revisions);
  if (!info) return [];
  if (info.isSymbolicLink() || !info.isDirectory()) fail("EKNOWLEDGE_FS", "knowledge revisions directory is unsafe");
  let entries;
  try {
    entries = await readdir(revisions, { withFileTypes: true });
  } catch (error) {
    if (error instanceof KnowledgeNodeError) throw error;
    failUnsafePath("knowledge revisions directory could not be read");
  }
  if (entries.length > KNOWLEDGE_NODE_LIMITS.maxRevisionCount) fail("EKNOWLEDGE_LIMIT", "knowledge revision count exceeds the bounded limit");
  const result = [];
  for (const entry of entries) {
    checkDeadline();
    if (entry.isSymbolicLink() || !entry.isFile() || !REVISION_FILE.test(entry.name)) fail("EKNOWLEDGE_INTEGRITY", "invalid knowledge revision entry");
    const revision = Number(entry.name.slice(0, -5));
    if (revision < 1 || revision > KNOWLEDGE_NODE_LIMITS.maxRevisionCount) fail("EKNOWLEDGE_INVALID", "knowledge revision is outside the bounded range");
    result.push({ revision, path: safeJoin(revisions, entry.name) });
  }
  return result.sort((left, right) => left.revision - right.revision);
}

async function readCurrentSnapshot(stateRoot, nodeId, checkDeadline, { requestedRevision = null, allowMissing = false } = {}) {
  checkDeadline();
  const paths = nodePaths(stateRoot, nodeId);
  const pathPresent = await assertReadOnlyPath(stateRoot, paths.nodeDir);
  checkDeadline();
  if (!pathPresent) {
    if (allowMissing) return null;
    fail("EKNOWLEDGE_NOT_FOUND", `knowledge node does not exist: ${nodeId}`);
  }
  const nodeInfo = await optionalStat(paths.nodeDir);
  if (!nodeInfo) {
    if (allowMissing) return null;
    fail("EKNOWLEDGE_NOT_FOUND", `knowledge node does not exist: ${nodeId}`);
  }
  if (nodeInfo.isSymbolicLink() || !nodeInfo.isDirectory()) fail("EKNOWLEDGE_FS", "knowledge node directory is unsafe");
  const tombstoneRaw = await readRegularJson(stateRoot, paths.tombstone, "knowledge tombstone");
  checkDeadline();
  if (tombstoneRaw !== null) {
    const tombstone = validateTombstone(tombstoneRaw, nodeId);
    const indexRaw = await readRegularJson(stateRoot, paths.index, "knowledge index");
    checkDeadline();
    if (indexRaw !== null) {
      const index = validateIndex(indexRaw, nodeId);
      if (index.status !== REVOKED || index.tombstoneDigest !== tombstoneRaw.tombstoneDigest || index.revision !== tombstone.revision || index.revisionDigest !== tombstone.revisionDigest) {
        fail("EKNOWLEDGE_INTEGRITY", "revoked knowledge index does not match its tombstone");
      }
    }
    fail("EKNOWLEDGE_REVOKED", `knowledge node is permanently ${tombstone.action}d: ${nodeId}`);
  }
  const indexRaw = await readRegularJson(stateRoot, paths.index, "knowledge index");
  checkDeadline();
  if (indexRaw === null) fail("EKNOWLEDGE_INTEGRITY", "knowledge node has no index");
  const index = validateIndex(indexRaw, nodeId);
  if (index.status !== ACTIVE || index.tombstoneDigest !== null) fail("EKNOWLEDGE_INTEGRITY", "active knowledge index has an invalid status");
  const files = await listRevisionFiles(stateRoot, paths.revisions, checkDeadline);
  if (files.length !== index.revision || files.some((item, indexValue) => item.revision !== indexValue + 1)) fail("EKNOWLEDGE_INTEGRITY", "knowledge revisions are not a contiguous history");
  const records = [];
  for (const file of files) {
    checkDeadline();
    const raw = await readRegularJson(stateRoot, file.path, `knowledge revision ${file.revision}`);
    const node = validateKnowledgeNodeV1(raw);
    checkDeadline();
    if (node.nodeId !== nodeId || node.revision !== file.revision) fail("EKNOWLEDGE_INTEGRITY", "knowledge revision identity changed");
    records.push({ node, nodeDigest: digestObject(node), path: file.path });
  }
  const latest = records.at(-1);
  if (!latest || latest.nodeDigest !== index.revisionDigest || index.revision !== latest.node.revision) fail("EKNOWLEDGE_INTEGRITY", "knowledge index does not bind the latest revision");
  const chosen = requestedRevision === null ? latest : records.find((record) => record.node.revision === requestedRevision);
  if (!chosen) fail("EKNOWLEDGE_NOT_FOUND", `knowledge revision does not exist: ${nodeId}@${requestedRevision}`);
  return {
    paths,
    index,
    latest,
    chosen,
    records
  };
}

function lockUuid(value, label) {
  if (typeof value !== "string" || !LOCK_UUID.test(value)) fail("EKNOWLEDGE_INTEGRITY", `${label} is malformed`);
  return value;
}

function validateNodeLock(value, nodeId, { kind = KNOWLEDGE_LOCK_KIND, allowLegacy = kind === KNOWLEDGE_LOCK_KIND } = {}) {
  assertPlainObject(value, "knowledge lock");
  if (allowLegacy && value.schemaVersion === 1 && value.kind === "KnowledgeNodeLockV1") {
    exactKeys(value, KNOWLEDGE_LOCK_V1_KEYS, "knowledge lock");
    requireKeys(value, ["schemaVersion", "kind", "nodeId", "token"], "knowledge lock");
    safeId(value.nodeId, "knowledge lock.nodeId");
    boundedText(value.token, "knowledge lock.token", 128);
    if (value.nodeId !== nodeId) fail("EKNOWLEDGE_INTEGRITY", "knowledge lock node identity changed");
    return { ...value, legacy: true };
  }
  if (value.schemaVersion !== KNOWLEDGE_LOCK_SCHEMA_VERSION || value.kind !== kind) {
    fail("EKNOWLEDGE_LOCK_UNKNOWN", "knowledge lock format is not recoverable");
  }
  exactKeys(value, KNOWLEDGE_LOCK_KEYS, "knowledge lock");
  requireKeys(value, ["schemaVersion", "kind", "nodeId", "host", "pid", "startIdentity", "token", "fence", "createdAt"], "knowledge lock");
  safeId(value.nodeId, "knowledge lock.nodeId");
  boundedText(value.host, "knowledge lock.host", 255);
  boundedInteger(value.pid, "knowledge lock.pid", 1, 2 ** 31 - 1);
  boundedText(value.startIdentity, "knowledge lock.startIdentity", 256);
  if (!LOCK_START_IDENTITY.test(value.startIdentity)) fail("EKNOWLEDGE_INTEGRITY", "knowledge lock.startIdentity is malformed");
  lockUuid(value.token, "knowledge lock.token");
  lockUuid(value.fence, "knowledge lock.fence");
  timestamp(value.createdAt, "knowledge lock.createdAt");
  if (value.nodeId !== nodeId) fail("EKNOWLEDGE_INTEGRITY", "knowledge lock node identity changed");
  return value;
}

function lockStatIdentity(info) {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.nlink].map((value) => String(value)).join(":");
}

function lockInodeIdentity(info) {
  return [info.dev, info.ino].map((value) => String(value)).join(":");
}

async function observeNodeLock(stateRoot, target, nodeId, { kind = KNOWLEDGE_LOCK_KIND, allowLegacy = kind === KNOWLEDGE_LOCK_KIND } = {}) {
  let record;
  try {
    record = await readRegularJson(stateRoot, target, "knowledge lock");
  } catch (error) {
    // A process can be killed between O_EXCL and the metadata write.  Give a
    // normal contender a short bounded chance to observe the completed record;
    // a persistent partial record remains UNKNOWN and is never reclaimed.
    if (error instanceof KnowledgeNodeError && error.code === "EKNOWLEDGE_INTEGRITY") return { incomplete: true };
    throw error;
  }
  if (record === null) return null;
  const info = await optionalStat(target);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) failUnsafePath("knowledge lock is not a regular private file");
  const validated = validateNodeLock(record, nodeId, { kind, allowLegacy });
  return {
    record: validated,
    digest: digestObject(record),
    statIdentity: lockStatIdentity(info),
    inodeIdentity: lockInodeIdentity(info)
  };
}

function sameLockObservation(left, right) {
  return left !== null && right !== null &&
    left.digest === right.digest && left.statIdentity === right.statIdentity;
}

function sameRetiredLock(left, right) {
  // rename legitimately changes ctime/nlink metadata; the inode and complete
  // owner bytes are the identity that must remain constant after retirement.
  return left !== null && right !== null &&
    left.digest === right.digest && left.inodeIdentity === right.inodeIdentity;
}

function ownerLiveness(record) {
  if (record.host !== LOCAL_HOST) return "unknown";
  // A live PID always blocks recovery, even when its incarnation differs;
  // this conservative rule prevents PID reuse from becoming a delete signal.
  try {
    process.kill(record.pid, 0);
    return "live";
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    return "unknown";
  }
}

function createOwnerRecord(kind, nodeId) {
  return {
    schemaVersion: KNOWLEDGE_LOCK_SCHEMA_VERSION,
    kind,
    nodeId,
    host: LOCAL_HOST,
    pid: process.pid,
    startIdentity: PROCESS_START_IDENTITY,
    token: randomUUID(),
    fence: randomUUID(),
    createdAt: new Date().toISOString()
  };
}

function createGateHandle(stateRoot, paths, record) {
  const gateDigest = digestObject(record);
  return {
    async release() {
      try {
        const content = await readRegularJson(stateRoot, paths.gate, "knowledge lock gate");
        if (!content) return;
        const validated = validateNodeLock(content, record.nodeId, { kind: KNOWLEDGE_GATE_KIND, allowLegacy: false });
        if (digestObject(validated) !== gateDigest) return;
        await unlink(paths.gate);
        await syncDirectory(path.dirname(paths.gate));
      } catch (error) {
        if (error?.code === "ENOENT") return;
        if (error instanceof KnowledgeNodeError) throw error;
        failUnsafePath("knowledge lock gate could not be released");
      }
    }
  };
}

async function tryCreateGate(stateRoot, paths, record, checkDeadline) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  let created = false;
  try {
    handle = await open(paths.gate, flags, 0o600);
    created = true;
    await handle.writeFile(`${canonicalJson(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(paths.gate, 0o600);
    await syncDirectory(path.dirname(paths.gate));
    checkDeadline();
    return createGateHandle(stateRoot, paths, record);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) {
      await unlink(paths.gate).catch((cleanupError) => {
        if (cleanupError.code !== "ENOENT") failUnsafePath("knowledge lock gate cleanup failed");
      });
    }
    if (error?.code === "EEXIST") return null;
    if (error instanceof KnowledgeNodeError) throw error;
    failUnsafePath("knowledge lock gate could not be acquired");
  }
}

async function recoverDeadGate(stateRoot, nodeId, paths, record, checkDeadline) {
  let first = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    checkDeadline();
    first = await observeNodeLock(stateRoot, paths.gate, nodeId, { kind: KNOWLEDGE_GATE_KIND, allowLegacy: false });
    if (!first) return "retry";
    if (first.incomplete) {
      if (attempt === 2) fail("EKNOWLEDGE_LOCK_UNKNOWN", "knowledge lock gate owner record is incomplete");
      await new Promise((resolve) => setTimeout(resolve, 2));
      continue;
    }
    break;
  }
  if (!first || first.incomplete) fail("EKNOWLEDGE_LOCK_UNKNOWN", "knowledge lock gate owner record is incomplete");
  const liveness = ownerLiveness(first.record);
  if (liveness === "live") fail("EKNOWLEDGE_LOCKED", `knowledge node is already being changed: ${nodeId}`);
  if (liveness !== "dead") fail("EKNOWLEDGE_LOCK_UNKNOWN", "knowledge lock gate owner cannot be verified");
  checkDeadline();
  const second = await observeNodeLock(stateRoot, paths.gate, nodeId, { kind: KNOWLEDGE_GATE_KIND, allowLegacy: false });
  if (!second) return "retry";
  if (second.incomplete || !sameLockObservation(first, second)) return "retry";
  if (ownerLiveness(second.record) !== "dead") {
    if (ownerLiveness(second.record) === "live") fail("EKNOWLEDGE_LOCKED", `knowledge node is already being changed: ${nodeId}`);
    fail("EKNOWLEDGE_LOCK_UNKNOWN", "knowledge lock gate owner cannot be verified");
  }

  const directory = path.dirname(paths.gate);
  const retiredPath = safeJoin(directory, `.${nodeId}.gate.retired.${first.record.fence}.${randomUUID()}`);
  try {
    await rename(paths.gate, retiredPath);
  } catch (error) {
    if (error?.code === "ENOENT") return "retry";
    failUnsafePath("knowledge lock gate could not be retired");
  }
  const acquired = await tryCreateGate(stateRoot, paths, record, checkDeadline);
  if (!acquired) return "retry";
  try {
    const retired = await observeNodeLock(stateRoot, retiredPath, nodeId, { kind: KNOWLEDGE_GATE_KIND, allowLegacy: false });
    if (!retired || retired.incomplete || !sameRetiredLock(first, retired)) {
      await acquired.release();
      fail("EKNOWLEDGE_LOCK_UNKNOWN", "knowledge lock gate changed during recovery");
    }
    await syncDirectory(directory);
    await unlink(retiredPath);
    await syncDirectory(directory);
    return acquired;
  } catch (error) {
    await acquired.release().catch(() => {});
    if (error instanceof KnowledgeNodeError) throw error;
    failUnsafePath("knowledge lock gate cleanup failed");
  }
}

async function acquireNodeGate(stateRoot, nodeId, paths, checkDeadline) {
  await assertNoSymlinkSafe(stateRoot, paths.gate);
  await ensurePrivateDirSafe(path.dirname(paths.gate));
  const record = createOwnerRecord(KNOWLEDGE_GATE_KIND, nodeId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const acquired = await tryCreateGate(stateRoot, paths, record, checkDeadline);
    if (acquired) return acquired;
    const recovered = await recoverDeadGate(stateRoot, nodeId, paths, record, checkDeadline);
    if (recovered !== "retry") return recovered;
  }
  fail("EKNOWLEDGE_LOCKED", `knowledge node is already being changed: ${nodeId}`);
}

async function retireDeadNodeLock(stateRoot, nodeId, paths, checkDeadline) {
  let first = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    checkDeadline();
    first = await observeNodeLock(stateRoot, paths.lock, nodeId);
    if (!first) return "retry";
    if (first.incomplete) {
      if (attempt === 2) fail("EKNOWLEDGE_LOCK_UNKNOWN", "knowledge lock owner record is incomplete");
      await new Promise((resolve) => setTimeout(resolve, 2));
      continue;
    }
    break;
  }
  if (!first || first.incomplete) fail("EKNOWLEDGE_LOCK_UNKNOWN", "knowledge lock owner record is incomplete");
  if (first.record.legacy) fail("EKNOWLEDGE_LOCK_UNKNOWN", "legacy knowledge lock owner cannot be verified");
  const liveness = ownerLiveness(first.record);
  if (liveness === "live") fail("EKNOWLEDGE_LOCKED", `knowledge node is already being changed: ${nodeId}`);
  if (liveness !== "dead") fail("EKNOWLEDGE_LOCK_UNKNOWN", "knowledge lock owner cannot be verified");
  checkDeadline();
  const second = await observeNodeLock(stateRoot, paths.lock, nodeId);
  if (!second) return "retry";
  if (second.incomplete || !sameLockObservation(first, second)) return "retry";
  if (ownerLiveness(second.record) !== "dead") {
    if (ownerLiveness(second.record) === "live") fail("EKNOWLEDGE_LOCKED", `knowledge node is already being changed: ${nodeId}`);
    fail("EKNOWLEDGE_LOCK_UNKNOWN", "knowledge lock owner cannot be verified");
  }
  const directory = path.dirname(paths.lock);
  const retiredPath = safeJoin(directory, `.${nodeId}.lock.retired.${first.record.fence}.${randomUUID()}`);
  try {
    await rename(paths.lock, retiredPath);
  } catch (error) {
    if (error?.code === "ENOENT") return "retry";
    failUnsafePath("knowledge stale lock could not be retired");
  }
  try {
    const retired = await observeNodeLock(stateRoot, retiredPath, nodeId);
    if (!retired || retired.incomplete || !sameRetiredLock(first, retired)) {
      fail("EKNOWLEDGE_LOCK_UNKNOWN", "knowledge lock changed during recovery");
    }
    await syncDirectory(directory);
    await unlink(retiredPath);
    await syncDirectory(directory);
    return "recovered";
  } catch (error) {
    if (error instanceof KnowledgeNodeError) throw error;
    failUnsafePath("knowledge stale lock cleanup failed");
  }
}

function createNodeLockHandle(stateRoot, paths, lockRecord, checkDeadline) {
  const lockDigest = digestObject(lockRecord);
  const assertOwned = async () => {
    checkDeadline();
    const current = await observeNodeLock(stateRoot, paths.lock, lockRecord.nodeId);
    if (!current || current.incomplete || current.digest !== lockDigest) {
      fail("EKNOWLEDGE_LOCK_UNKNOWN", "knowledge lock ownership changed");
    }
    checkDeadline();
  };
  return {
    path: paths.lock,
    token: lockRecord.token,
    fence: lockRecord.fence,
    assertOwned,
    async release() {
      try {
        const content = await readRegularJson(stateRoot, paths.lock, "knowledge lock");
        if (!content) return;
        const validated = validateNodeLock(content, lockRecord.nodeId);
        if (validated.legacy || digestObject(validated) !== lockDigest) return;
        await unlink(paths.lock);
        await syncDirectory(path.dirname(paths.lock));
      } catch (error) {
        if (error.code === "ENOENT") return;
        if (error instanceof KnowledgeNodeError) throw error;
        failUnsafePath("knowledge lock could not be released");
      }
    }
  };
}

async function acquireNodeLock(stateRoot, nodeId, checkDeadline) {
  const paths = nodePaths(stateRoot, nodeId);
  const gate = await acquireNodeGate(stateRoot, nodeId, paths, checkDeadline);
  const lockRecord = createOwnerRecord(KNOWLEDGE_LOCK_KIND, nodeId);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  let created = false;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        handle = await open(paths.lock, flags, 0o600);
        created = true;
        await handle.writeFile(`${canonicalJson(lockRecord)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await chmod(paths.lock, 0o600);
        await syncDirectory(path.dirname(paths.lock));
        checkDeadline();
        return createNodeLockHandle(stateRoot, paths, lockRecord, checkDeadline);
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        handle = null;
        if (created) {
          await unlink(paths.lock).catch((cleanupError) => {
            if (cleanupError.code !== "ENOENT") failUnsafePath("knowledge lock cleanup failed");
          });
          created = false;
        }
        if (error.code !== "EEXIST") {
          if (error instanceof KnowledgeNodeError) throw error;
          failUnsafePath("knowledge lock could not be acquired");
        }
        const recovery = await retireDeadNodeLock(stateRoot, nodeId, paths, checkDeadline);
        if (recovery === "retry" || recovery === "recovered") {
          checkDeadline();
          continue;
        }
      }
    }
    fail("EKNOWLEDGE_LOCKED", `knowledge node is already being changed: ${nodeId}`);
  } finally {
    await gate.release();
  }
}

function assertReadPermission(permission, stateRoot, nodeId) {
  assertCapability(permission, READ_PERMISSIONS, "read permission");
  capabilityRoot(permission, stateRoot, "read permission");
  if (permission.nodeId !== null && permission.nodeId !== nodeId) fail("EKNOWLEDGE_PERMISSION", "read permission is bound to a different node");
}

function assertMutationPermission(permission, set, stateRoot, nodeId, label) {
  assertCapability(permission, set, label);
  capabilityRoot(permission, stateRoot, label);
  if (permission.nodeId !== nodeId) fail("EKNOWLEDGE_PERMISSION", `${label} is bound to a different node`);
}

async function saveInternal({ stateRoot, node, permission, deadlineMs, imported = false, acquiredLock = null, startedAt = undefined }) {
  const root = stateRootPath(stateRoot);
  const checkDeadline = beginDeadline(deadlineMs, "knowledge.save", startedAt);
  if (USED_SAVE_PERMISSIONS.has(permission)) fail("EKNOWLEDGE_PERMISSION", "save permission has already been consumed");
  const normalized = validateKnowledgeNodeV1(node, { deadlineMs });
  checkDeadline();
  assertMutationPermission(permission, SAVE_PERMISSIONS, root, normalized.nodeId, "save permission");
  await ensureStore(root);
  checkDeadline();
  const paths = nodePaths(root, normalized.nodeId);
  const lock = acquiredLock ?? await acquireNodeLock(root, normalized.nodeId, checkDeadline);
  const ownsLock = acquiredLock === null;
  try {
    await lock.assertOwned();
    checkDeadline();
    const current = await readCurrentSnapshot(root, normalized.nodeId, checkDeadline, { allowMissing: true });
    const expectedRevision = permission.expectedRevision;
    if (current === null) {
      if (expectedRevision !== 0 || normalized.revision !== 1) fail("EKNOWLEDGE_STALE", "initial knowledge save has a stale revision expectation");
    } else {
      if (expectedRevision !== current.latest.node.revision) fail("EKNOWLEDGE_STALE", "knowledge save expectedRevision is stale");
      if (normalized.revision !== current.latest.node.revision + 1) fail("EKNOWLEDGE_STALE", "knowledge revision must advance exactly once");
    }
    await assertNoSymlinkSafe(root, paths.nodeDir);
    await assertNoSymlinkSafe(root, paths.revisions);
    await ensurePrivateDirSafe(paths.nodeDir);
    await ensurePrivateDirSafe(paths.revisions);
    const revisionPath = safeJoin(paths.revisions, `${normalized.revision}.json`);
    if (await exists(revisionPath)) fail("EKNOWLEDGE_CONFLICT", `knowledge revision already exists: ${normalized.nodeId}@${normalized.revision}`);
    await lock.assertOwned();
    await writeCreateOnlyJson(root, revisionPath, normalized, checkDeadline);
    const index = sealedCore({
      schemaVersion: KNOWLEDGE_NODE_SCHEMA_VERSION,
      kind: KNOWLEDGE_NODE_INDEX_KIND,
      nodeId: normalized.nodeId,
      status: ACTIVE,
      revision: normalized.revision,
      revisionDigest: digestObject(normalized),
      tombstoneDigest: null
    }, "indexDigest");
    await lock.assertOwned();
    await atomicWriteKnowledgeJson(root, paths.index, index, "knowledge index");
    checkDeadline();
    await lock.assertOwned();
    const verified = await readCurrentSnapshot(root, normalized.nodeId, checkDeadline);
    if (verified.latest.nodeDigest !== digestObject(normalized)) fail("EKNOWLEDGE_INTEGRITY", "saved knowledge revision did not verify");
    USED_SAVE_PERMISSIONS.add(permission);
    return deepFreeze({
      ok: true,
      operation: imported ? "knowledge.import" : "knowledge.save",
      nodeId: normalized.nodeId,
      revision: normalized.revision,
      nodeDigest: verified.latest.nodeDigest,
      sourceDigest: normalized.source.digest,
      status: ACTIVE,
      imported,
      path: revisionPath
    });
  } finally {
    if (ownsLock) await lock.release();
  }
}

export async function saveKnowledgeNodeV1(options = {}) {
  permissionKeys(options, new Set(["stateRoot", "node", "permission", "deadlineMs"]), "saveKnowledgeNodeV1 options");
  requireKeys(options, ["node", "permission"], "saveKnowledgeNodeV1 options");
  return saveInternal(options);
}

export async function importKnowledgeNodeV1(options = {}) {
  permissionKeys(options, new Set(["stateRoot", "node", "permission", "deadlineMs"]), "importKnowledgeNodeV1 options");
  requireKeys(options, ["node", "permission"], "importKnowledgeNodeV1 options");
  return saveInternal({ ...options, imported: true });
}

function nodeFromKnowledgeExport(exported, nodeId, deadlineMs) {
  const checkDeadline = beginDeadline(deadlineMs, "knowledge.export.import");
  safeId(nodeId, "sanitized export target nodeId");
  if (nodeId === exported.nodeId) fail("EKNOWLEDGE_CONFLICT", "sanitized export must be imported under a new node ID");
  const snippets = new Map(exported.card.snippets.map((snippet) => [snippet.id, snippet]));
  const candidates = [];
  for (const candidate of exported.card.candidates) {
    checkDeadline();
    const candidateSnippets = [];
    for (const snippetId of candidate.snippetIds) {
      checkDeadline();
      const snippet = snippets.get(snippetId);
      if (!snippet) fail("EKNOWLEDGE_INTEGRITY", `sanitized export has a dangling snippet association: ${snippetId}`);
      const sourceDigest = digestObject({
        kind: "KnowledgeNodeImportedSnippetV1",
        exportDigest: exported.exportDigest,
        snippetId,
        text: snippet.text
      });
      candidateSnippets.push({
        id: snippet.id,
        text: snippet.text,
        source: { label: "sanitized-export", digest: sourceDigest }
      });
    }
    candidates.push({
      id: candidate.id,
      title: candidate.title,
      summary: candidate.summary,
      snippets: candidateSnippets
    });
  }
  const node = {
    schemaVersion: KNOWLEDGE_NODE_SCHEMA_VERSION,
    kind: KNOWLEDGE_NODE_KIND,
    nodeId,
    revision: 1,
    source: {
      revision: `sanitized-export:${exported.exportDigest}`,
      digest: exported.exportDigest,
      scope: "sanitized-export"
    },
    provenance: {
      producer: KNOWLEDGE_NODE_PRODUCER,
      capturedAt: new Date().toISOString(),
      evidenceDigest: exported.exportDigest,
      origin: KNOWLEDGE_NODE_IMPORTED_EXPORT_ORIGIN
    },
    rounds: [{ round: 1, candidates }],
    card: {
      title: exported.card.title,
      summary: exported.card.summary,
      candidateIds: exported.card.candidates.map((candidate) => candidate.id),
      snippetIds: exported.card.snippets.map((snippet) => snippet.id)
    }
  };
  return validateKnowledgeNodeV1(node, deadlineMs === undefined ? {} : { deadlineMs });
}

export async function importKnowledgeExportV1(options = {}) {
  permissionKeys(options, new Set(["stateRoot", "export", "nodeId", "permission", "deadlineMs"]), "importKnowledgeExportV1 options");
  requireKeys(options, ["export", "nodeId", "permission"], "importKnowledgeExportV1 options");
  const root = stateRootPath(options.stateRoot);
  const nodeId = safeId(options.nodeId, "importKnowledgeExportV1.nodeId");
  const exported = validateKnowledgeNodeExportV1(options.export, options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs });
  if (nodeId === exported.nodeId) fail("EKNOWLEDGE_CONFLICT", "sanitized export must be imported under a new node ID");
  assertMutationPermission(options.permission, SAVE_PERMISSIONS, root, nodeId, "save permission");
  if (options.permission.expectedRevision !== 0) fail("EKNOWLEDGE_STALE", "sanitized export import requires a fresh destination node");
  const node = nodeFromKnowledgeExport(exported, nodeId, options.deadlineMs);
  const startedAt = Date.now();
  const checkDeadline = beginDeadline(options.deadlineMs, "knowledge.export.import", startedAt);
  await ensureStore(root);
  const lockIds = [exported.nodeId, nodeId].sort((left, right) => left.localeCompare(right));
  const locks = [];
  try {
    for (const lockId of lockIds) {
      checkDeadline();
      locks.push({ nodeId: lockId, lock: await acquireNodeLock(root, lockId, checkDeadline) });
    }
    // Hold the source-node lock through destination publication.  A local
    // tombstone therefore cannot be bypassed by renaming the imported node;
    // a different state root remains an intentionally separate authority.
    await readCurrentSnapshot(root, exported.nodeId, checkDeadline, { allowMissing: true });
    const destinationLock = locks.find((entry) => entry.nodeId === nodeId).lock;
    const result = await saveInternal({
      stateRoot: root,
      node,
      permission: options.permission,
      deadlineMs: options.deadlineMs,
      imported: true,
      acquiredLock: destinationLock,
      startedAt
    });
    return deepFreeze({
      ...result,
      importedFromExportDigest: exported.exportDigest,
      sourceNodeId: exported.nodeId,
      importedOrigin: KNOWLEDGE_NODE_IMPORTED_EXPORT_ORIGIN
    });
  } finally {
    for (const entry of locks.reverse()) await entry.lock.release();
  }
}

export async function readKnowledgeNodeV1(options = {}) {
  permissionKeys(options, new Set(["stateRoot", "nodeId", "permission", "deadlineMs"]), "readKnowledgeNodeV1 options");
  requireKeys(options, ["nodeId", "permission"], "readKnowledgeNodeV1 options");
  const root = stateRootPath(options.stateRoot);
  const nodeId = safeId(options.nodeId, "readKnowledgeNodeV1.nodeId");
  assertReadPermission(options.permission, root, nodeId);
  const checkDeadline = beginDeadline(options.deadlineMs, "knowledge.read");
  const snapshot = await readCurrentSnapshot(root, nodeId, checkDeadline, { requestedRevision: options.permission.revision });
  checkDeadline();
  return deepFreeze({
    ok: true,
    operation: "knowledge.read",
    node: cloneJson(snapshot.chosen.node),
    nodeDigest: snapshot.chosen.nodeDigest,
    latestRevision: snapshot.latest.node.revision,
    latestDigest: snapshot.latest.nodeDigest,
    status: ACTIVE
  });
}

export async function listKnowledgeNodes(options = {}) {
  permissionKeys(options, new Set(["stateRoot", "permission", "deadlineMs"]), "listKnowledgeNodes options");
  requireKeys(options, ["permission"], "listKnowledgeNodes options");
  const root = stateRootPath(options.stateRoot);
  assertCapability(options.permission, READ_PERMISSIONS, "read permission");
  capabilityRoot(options.permission, root, "read permission");
  if (options.permission.nodeId !== null || options.permission.revision !== null) fail("EKNOWLEDGE_PERMISSION", "listing requires an unbound read permission");
  const checkDeadline = beginDeadline(options.deadlineMs, "knowledge.list");
  const nodesRoot = safeJoin(knowledgeStoreRoot(root), "nodes");
  if (!(await assertReadOnlyPath(root, nodesRoot))) return deepFreeze([]);
  const info = await optionalStat(nodesRoot);
  if (!info) return deepFreeze([]);
  if (info.isSymbolicLink() || !info.isDirectory()) fail("EKNOWLEDGE_FS", "knowledge nodes root is unsafe");
  let entries;
  try {
    entries = await readdir(nodesRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof KnowledgeNodeError) throw error;
    failUnsafePath("knowledge nodes root could not be read");
  }
  if (entries.length > KNOWLEDGE_NODE_LIMITS.maxNodeCount) fail("EKNOWLEDGE_LIMIT", "knowledge node count exceeds the bounded limit");
  const result = [];
  for (const entry of entries) {
    checkDeadline();
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail("EKNOWLEDGE_INTEGRITY", `invalid knowledge node entry: ${entry.name}`);
    const nodeId = safeId(entry.name, "knowledge node directory");
    try {
      const snapshot = await readCurrentSnapshot(root, nodeId, checkDeadline);
      result.push({ nodeId, revision: snapshot.latest.node.revision, nodeDigest: snapshot.latest.nodeDigest, sourceDigest: snapshot.latest.node.source.digest });
    } catch (error) {
      if (error.code === "EKNOWLEDGE_REVOKED") continue;
      throw error;
    }
  }
  checkDeadline();
  return deepFreeze(result.sort((left, right) => left.nodeId.localeCompare(right.nodeId)));
}

function exportCandidateMap(node) {
  const candidates = new Map();
  const snippets = new Map();
  for (const round of node.rounds) {
    for (const candidate of round.candidates) {
      candidates.set(candidate.id, { candidate, round: round.round });
      for (const snippet of candidate.snippets) snippets.set(snippet.id, snippet);
    }
  }
  return { candidates, snippets };
}

export async function exportKnowledgeNodeV1(options = {}) {
  permissionKeys(options, new Set(["stateRoot", "nodeId", "permission", "deadlineMs"]), "exportKnowledgeNodeV1 options");
  requireKeys(options, ["nodeId", "permission"], "exportKnowledgeNodeV1 options");
  const root = stateRootPath(options.stateRoot);
  const nodeId = safeId(options.nodeId, "exportKnowledgeNodeV1.nodeId");
  assertCapability(options.permission, EXPORT_PERMISSIONS, "export permission");
  capabilityRoot(options.permission, root, "export permission");
  if (options.permission.nodeId !== nodeId) fail("EKNOWLEDGE_PERMISSION", "export permission is bound to a different node");
  const checkDeadline = beginDeadline(options.deadlineMs, "knowledge.export");
  const snapshot = await readCurrentSnapshot(root, nodeId, checkDeadline, { requestedRevision: options.permission.revision });
  const node = snapshot.chosen.node;
  const { candidates, snippets } = exportCandidateMap(node);
  const selectedCandidates = [];
  const selectedSnippetIds = new Set(options.permission.snippetIds);
  for (const id of options.permission.candidateIds) {
    const entry = candidates.get(id);
    if (!entry || !node.card.candidateIds.includes(id)) fail("EKNOWLEDGE_PERMISSION", `export candidate is not explicitly selected: ${id}`);
    selectedCandidates.push({
      id: entry.candidate.id,
      title: entry.candidate.title,
      summary: entry.candidate.summary,
      snippetIds: entry.candidate.snippets.map((snippet) => snippet.id).filter((snippetId) => selectedSnippetIds.has(snippetId))
    });
  }
  const selectedSnippets = [];
  for (const id of options.permission.snippetIds) {
    const snippet = snippets.get(id);
    if (!snippet || !node.card.snippetIds.includes(id)) fail("EKNOWLEDGE_PERMISSION", `export snippet is not explicitly selected: ${id}`);
    if (!selectedCandidates.some((candidate) => candidate.snippetIds.includes(id))) {
      fail("EKNOWLEDGE_PERMISSION", `export snippet is not associated with a selected candidate: ${id}`);
    }
    selectedSnippets.push({
      id: snippet.id,
      text: snippet.text,
      ...(options.permission.privacy.includeSourceDigest ? { sourceDigest: snippet.source.digest } : {})
    });
  }
  if (selectedCandidates.length === 0 || selectedSnippets.length === 0) fail("EKNOWLEDGE_PERMISSION", "export requires a non-empty explicit selection");
  const core = {
    schemaVersion: KNOWLEDGE_NODE_SCHEMA_VERSION,
    kind: KNOWLEDGE_NODE_EXPORT_KIND,
    nodeId,
    revision: node.revision,
    nodeDigest: snapshot.chosen.nodeDigest,
    source: options.permission.privacy.includeSourceDigest ? { revision: node.source.revision, digest: node.source.digest } : null,
    card: {
      title: node.card.title,
      summary: node.card.summary,
      candidates: selectedCandidates,
      snippets: selectedSnippets
    },
    disclosure: {
      mode: "sanitized",
      rawExcluded: true,
      unknownContent: "blocked",
      selectionDigest: digestObject({ candidateIds: options.permission.candidateIds, snippetIds: options.permission.snippetIds })
    }
  };
  if (Buffer.byteLength(canonicalJson(core.card), "utf8") > KNOWLEDGE_NODE_LIMITS.maxCardBytes) fail("EKNOWLEDGE_LIMIT", "export card exceeds the bounded size");
  checkDeadline();
  const result = { ...core, exportDigest: digestObject(core) };
  return deepFreeze({ ok: true, operation: "knowledge.export", export: result, exportDigest: result.exportDigest });
}

async function revokeInternal({ stateRoot, nodeId, permission, deadlineMs, action, permissionSet, usedPermissions }) {
  const root = stateRootPath(stateRoot);
  safeId(nodeId, `${action}KnowledgeNodeV1.nodeId`);
  assertMutationPermission(permission, permissionSet, root, nodeId, `${action} permission`);
  if (usedPermissions.has(permission)) fail("EKNOWLEDGE_PERMISSION", `${action} permission has already been consumed`);
  const checkDeadline = beginDeadline(deadlineMs, `knowledge.${action}`);
  await ensureStore(root);
  const paths = nodePaths(root, nodeId);
  const lock = await acquireNodeLock(root, nodeId, checkDeadline);
  try {
    await lock.assertOwned();
    const snapshot = await readCurrentSnapshot(root, nodeId, checkDeadline);
    if (permission.expectedRevision !== snapshot.latest.node.revision) fail("EKNOWLEDGE_STALE", `${action} permission expectedRevision is stale`);
    const tombstoneCore = {
      schemaVersion: KNOWLEDGE_NODE_SCHEMA_VERSION,
      kind: KNOWLEDGE_NODE_TOMBSTONE_KIND,
      nodeId,
      action,
      revision: snapshot.latest.node.revision,
      revisionDigest: snapshot.latest.nodeDigest,
      at: new Date().toISOString(),
      reason: action === "delete" ? "explicit delete" : "explicit revoke"
    };
    const tombstone = sealedCore(tombstoneCore, "tombstoneDigest");
    await lock.assertOwned();
    await writeCreateOnlyJson(root, paths.tombstone, tombstone, checkDeadline);
    const index = sealedCore({
      schemaVersion: KNOWLEDGE_NODE_SCHEMA_VERSION,
      kind: KNOWLEDGE_NODE_INDEX_KIND,
      nodeId,
      status: REVOKED,
      revision: snapshot.latest.node.revision,
      revisionDigest: snapshot.latest.nodeDigest,
      tombstoneDigest: tombstone.tombstoneDigest
    }, "indexDigest");
    await lock.assertOwned();
    await atomicWriteKnowledgeJson(root, paths.index, index, "knowledge index");
    checkDeadline();
    const persistedTombstone = await readRegularJson(root, paths.tombstone, "knowledge tombstone");
    validateTombstone(persistedTombstone, nodeId);
    const persistedIndex = await readRegularJson(root, paths.index, "knowledge index");
    validateIndex(persistedIndex, nodeId);
    usedPermissions.add(permission);
    return deepFreeze({ ok: true, operation: `knowledge.${action}`, nodeId, revision: snapshot.latest.node.revision, nodeDigest: snapshot.latest.nodeDigest, tombstoneDigest: tombstone.tombstoneDigest, status: REVOKED });
  } finally {
    await lock.release();
  }
}

export async function revokeKnowledgeNodeV1(options = {}) {
  permissionKeys(options, new Set(["stateRoot", "nodeId", "permission", "deadlineMs"]), "revokeKnowledgeNodeV1 options");
  requireKeys(options, ["nodeId", "permission"], "revokeKnowledgeNodeV1 options");
  return revokeInternal({ ...options, action: "revoke", permissionSet: REVOKE_PERMISSIONS, usedPermissions: USED_REVOKE_PERMISSIONS });
}

export async function deleteKnowledgeNodeV1(options = {}) {
  permissionKeys(options, new Set(["stateRoot", "nodeId", "permission", "deadlineMs"]), "deleteKnowledgeNodeV1 options");
  requireKeys(options, ["nodeId", "permission"], "deleteKnowledgeNodeV1 options");
  return revokeInternal({ ...options, action: "delete", permissionSet: DELETE_PERMISSIONS, usedPermissions: USED_DELETE_PERMISSIONS });
}
