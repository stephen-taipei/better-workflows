import assert from "node:assert/strict";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";

import { digestObject } from "./core.mjs";
import { runSourceGit } from "./git.mjs";
import {
  assertPhysicalPath,
  assertPhysicalSnapshot,
  atomicJson,
  boundedFile,
  createJson,
  captureNativeReviewSnapshotIdentityV1,
  inspectNativeReviewSnapshotSubjectV1,
  NATIVE_REVIEW_FULL_SNAPSHOT_MODE_V1,
  parseNameStatus
} from "./native-review-runner.mjs";
import { contentDigest } from "./native-review-content.mjs";

export const REVIEW_SHARDED_V2_PROTOCOL = "native-review-sharded-v2";
export const REVIEW_SHARDED_V2_SCHEMA_VERSION = 1;
export const REVIEW_SHARD_PLAN_KIND = "ReviewShardPlanV1";
export const REVIEW_UNIT_RESULT_KIND = "ReviewUnitResultV1";
export const REVIEW_CHECKPOINT_KIND = "ReviewCheckpointV1";
export const REVIEW_LANE_RECEIPT_KIND = "ReviewLaneReceiptV1";
export const REVIEW_AGGREGATE_KIND = "ReviewAggregateV1";

export const DEFAULT_REVIEW_SHARDED_V2_POLICY = Object.freeze({
  schemaVersion: 1,
  concurrency: 2,
  maxPrimaryUnits: 32,
  maxSourceBytes: 64 * 1024,
  maxSharedContextBytes: 16 * 1024,
  initTimeoutMs: 60 * 1000,
  targetTimeoutMs: 5 * 60 * 1000,
  softTimeoutMs: 8 * 60 * 1000,
  hardTimeoutMs: 10 * 60 * 1000,
  noProgressTimeoutMs: 3 * 60 * 1000,
  cleanupReserveMs: 5 * 60 * 1000,
  sameCauseAttempts: 2,
  maxDepth: 3,
  maxLeavesMultiplier: 4,
  maxRelationRounds: 2,
  maxRelations: 256,
  maxTotalTimeMs: 90 * 60 * 1000
});

// V5 r4 fixes the per-attempt timing, size, retry, depth, and relation
// contract. It does not promise a 90-minute total run. This slice has no
// trusted producer for an authorized aggregate budget, so its public JSON
// policy cannot override the conservative implementation default below.
// Only worker concurrency and primary-unit batch size are caller tunables,
// and both remain inside the contract's bounded ranges. A policy object is
// input data, not an authority grant or an attestation.
const FIXED_REVIEW_SHARDED_V2_POLICY = Object.freeze({
  schemaVersion: 1,
  maxSourceBytes: 64 * 1024,
  maxSharedContextBytes: 16 * 1024,
  initTimeoutMs: 60 * 1000,
  targetTimeoutMs: 5 * 60 * 1000,
  softTimeoutMs: 8 * 60 * 1000,
  hardTimeoutMs: 10 * 60 * 1000,
  noProgressTimeoutMs: 3 * 60 * 1000,
  cleanupReserveMs: 5 * 60 * 1000,
  sameCauseAttempts: 2,
  maxDepth: 3,
  maxLeavesMultiplier: 4,
  maxRelationRounds: 2,
  maxRelations: 256
});

const DEFAULT_AGGREGATE_BUDGET_MS = DEFAULT_REVIEW_SHARDED_V2_POLICY.maxTotalTimeMs;

const ADJUSTABLE_REVIEW_SHARDED_V2_POLICY = Object.freeze({
  concurrency: Object.freeze({ min: 1, max: 3 }),
  maxPrimaryUnits: Object.freeze({ min: 1, max: 32 })
});

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUS = new Set(["A", "C", "D", "M", "R", "T"]);
const OBLIGATION_KINDS = new Set(["cross-file", "api", "config", "shared-state", "authority", "large-file-integration"]);
const UNIT_KINDS = new Set(["path", "subunit", "whole-file-integration"]);
const RESULT_VERDICTS = new Set(["PASS", "BLOCK", "UNKNOWN"]);
const CHECKPOINT_STATUSES = new Set(["READY", "RUNNING", "PAUSED", "PAUSED_BUDGET", "HOLD", "UNKNOWN", "BLOCKED", "COMPLETE"]);
const UNIT_RESULTS = new WeakSet();
const LANE_RECEIPTS = new WeakSet();
const AGGREGATES = new WeakSet();
const CHECKPOINTS = new WeakSet();

function object(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function exact(value, keys, label) {
  object(value, label);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `Unexpected ${label} fields`);
}

function digest(value, label) {
  assert(DIGEST.test(String(value ?? "")), `${label} must be a SHA-256 digest`);
  return value;
}

function id(value, label) {
  assert(SAFE_ID.test(String(value ?? "")), `${label} must be a safe identifier`);
  return value;
}

function relativePath(value, label) {
  assert(typeof value === "string" && value && !value.includes("\0"), `${label} must be a relative path`);
  const normalized = value.replaceAll("\\", "/");
  assert(!path.isAbsolute(normalized) && !normalized.split("/").some(part => ["", ".", ".."].includes(part)),
    `${label} must be a normalized relative path`);
  return normalized;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  assert(Number.isSafeInteger(value) && value >= min && value <= max, `${label} must be a bounded integer`);
  return value;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function nowIso() {
  return new Date().toISOString();
}

function canonicalManifest(value, label = "manifest") {
  assert(Array.isArray(value), `${label} must be an array`);
  const files = value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    object(entry, itemLabel);
    const keys = Object.keys(entry);
    const allowed = entry.oldPath === undefined ? ["status", "path"] : ["status", "path", "oldPath"];
    assert.deepEqual(keys.sort(), allowed.sort(), `${itemLabel} has unexpected fields`);
    assert(typeof entry.status === "string" && /^[ACDMRT][0-9]*$/.test(entry.status), `${itemLabel}.status is invalid`);
    const status = entry.status[0];
    assert(STATUS.has(status), `${itemLabel}.status is unsupported`);
    const pathValue = relativePath(entry.path, `${itemLabel}.path`);
    const rename = status === "R" || status === "C";
    if (rename) {
      assert(typeof entry.oldPath === "string", `${itemLabel}.oldPath is required for rename/copy`);
      const oldPath = relativePath(entry.oldPath, `${itemLabel}.oldPath`);
      assert(oldPath !== pathValue, `${itemLabel} cannot rename a path to itself`);
      return { status: entry.status, oldPath, path: pathValue };
    }
    assert(entry.oldPath === undefined, `${itemLabel}.oldPath is only valid for rename/copy`);
    return { status: entry.status, path: pathValue };
  }).sort((left, right) => digestObject(left).localeCompare(digestObject(right)));
  const identities = new Set();
  for (const file of files) {
    const identity = `${file.oldPath ?? ""}\0${file.path}`;
    assert(!identities.has(identity), `${label} contains duplicate paths`);
    identities.add(identity);
  }
  assert(files.length > 0, `${label} must contain at least one changed path`);
  return files;
}

function normalizePolicy(value = DEFAULT_REVIEW_SHARDED_V2_POLICY) {
  const policy = { ...value };
  exact(policy, Object.keys(DEFAULT_REVIEW_SHARDED_V2_POLICY), "v2 review policy");
  for (const [key, bounds] of Object.entries(ADJUSTABLE_REVIEW_SHARDED_V2_POLICY)) {
    integer(policy[key], `policy.${key}`, bounds);
  }
  for (const [key, expected] of Object.entries(FIXED_REVIEW_SHARDED_V2_POLICY)) {
    assert.equal(policy[key], expected, `policy.${key} must use the V5 r4 contract value`);
  }
  assert.equal(policy.maxTotalTimeMs, DEFAULT_AGGREGATE_BUDGET_MS,
    "policy.maxTotalTimeMs requires a trusted aggregate-budget producer");
  assert(policy.initTimeoutMs <= policy.targetTimeoutMs && policy.targetTimeoutMs < policy.softTimeoutMs &&
    policy.softTimeoutMs < policy.hardTimeoutMs, "v2 review timeouts must be ordered");
  assert(policy.noProgressTimeoutMs < policy.hardTimeoutMs, "v2 no-progress timeout exceeds hard timeout");
  assert(policy.maxTotalTimeMs >= policy.hardTimeoutMs + policy.cleanupReserveMs,
    "v2 total budget must include hard timeout and cleanup reserve");
  return Object.freeze(policy);
}

function normalizeRoles(value) {
  assert(Array.isArray(value) && value.length >= 2 && value.length <= 32, "v2 review requires two to thirty-two roles");
  const seen = new Set();
  const roles = value.map((role, index) => {
    const label = `roles[${index}]`;
    exact(role, ["id", "required"], label);
    const roleId = id(role.id, `${label}.id`);
    assert(typeof role.required === "boolean", `${label}.required must be boolean`);
    assert(!seen.has(roleId), `Duplicate review role: ${roleId}`);
    seen.add(roleId);
    return { id: roleId, required: role.required };
  }).sort((left, right) => left.id.localeCompare(right.id));
  assert(roles.some(role => role.required), "v2 review requires at least one required role");
  return roles;
}

function normalizeContextPaths(value = []) {
  assert(Array.isArray(value) && value.length <= 256, "review context paths are bounded");
  return [...new Set(value.map((entry, index) => relativePath(entry, `contextPaths[${index}]`)))].sort();
}

function treeRecordFromToken(token, label) {
  const tab = token.indexOf("\t");
  assert(tab > 0, `${label} tree record is malformed`);
  const fields = token.slice(0, tab).split(/\s+/);
  assert(fields.length === 4, `${label} tree record has unexpected fields`);
  const [mode, type, objectId, sizeText] = fields;
  assert(/^\d{6}$/.test(mode) && ["blob", "commit", "tree"].includes(type) && SHA.test(objectId), `${label} tree identity is invalid`);
  const bytes = sizeText === "-" ? 0 : Number(sizeText);
  integer(bytes, `${label}.bytes`);
  return { mode, type, object: objectId, bytes, path: relativePath(token.slice(tab + 1), `${label}.path`) };
}

async function sourceGit(repository, args, options = {}) {
  return runSourceGit(repository, args, { ...options, validateWorktree: false, workTree: repository });
}

async function mapBounded(values, concurrency, worker) {
  const output = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      output[index] = await worker(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

async function treeMap(repository, revision) {
  const result = await sourceGit(repository, ["ls-tree", "-r", "-l", "-z", revision, "--"], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  const raw = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  assert(raw.length && raw.at(-1) === 0, "Git tree snapshot is truncated");
  const map = new Map();
  for (const token of raw.toString("utf8").split("\0").filter(Boolean)) {
    const record = treeRecordFromToken(token, `Git ${revision}`);
    assert(!map.has(record.path), `Git tree contains duplicate path: ${record.path}`);
    map.set(record.path, record);
  }
  return map;
}

function publicTreeRecord(record) {
  if (!record) return null;
  return { mode: record.mode, type: record.type, object: record.object, bytes: record.bytes };
}

async function captureContext(repository, revision, paths, headTree) {
  const entries = paths.map((relative) => {
    const record = headTree.get(relative);
    assert(record, `Review context path is absent at HEAD: ${relative}`);
    return { path: relative, revision, ...publicTreeRecord(record) };
  });
  const bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  return { paths: entries, bytes, digest: digestObject(entries) };
}

function sourceEntry(publicManifestEntry, baseTree, headTree) {
  const basePath = publicManifestEntry.oldPath ?? publicManifestEntry.path;
  const base = publicTreeRecord(baseTree.get(basePath));
  const head = publicTreeRecord(headTree.get(publicManifestEntry.path));
  const status = publicManifestEntry.status[0];
  assert(status === "A" ? !base && head : status === "D" ? base && !head : base && head,
    `Git source identity is inconsistent for ${publicManifestEntry.path}`);
  return { ...publicManifestEntry, base, head };
}

function sourceIdentity(source) {
  return {
    base: source.base,
    head: source.head,
    manifest: source.manifest,
    manifestDigest: source.manifestDigest,
    mergeBase: source.mergeBase,
    ...(source.reviewMode === undefined ? {} : { reviewMode: source.reviewMode, snapshotTreeOid: source.snapshotTreeOid, fullUniverseDigest: source.fullUniverseDigest })
  };
}

function manifestProjection(manifest) {
  return manifest.map(entry => ({ status: entry.status, path: entry.path, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}) }));
}

async function captureSource(repositoryValue, base, head, contextPaths, reviewMode = undefined) {
  const requestedRepository = path.resolve(String(repositoryValue ?? ""));
  assert(path.isAbsolute(String(repositoryValue ?? "")) && requestedRepository === repositoryValue,
    "Review repository must be an absolute normalized path");
  const repositorySnapshot = await assertPhysicalPath(requestedRepository, "Review source repository", { directory: true });
  const repository = repositorySnapshot.path;
  assert(SHA.test(base) && SHA.test(head), "Review source revisions must be full commit SHA-1 values");
  const currentHead = String((await sourceGit(repository, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout).trim();
  assert.equal(currentHead, head, "Review source HEAD is stale");
  const clean = String((await sourceGit(repository, ["status", "--porcelain=v1"])).stdout);
  assert.equal(clean, "", "Review source must be a clean committed tree");
  assert(reviewMode === undefined || reviewMode === NATIVE_REVIEW_FULL_SNAPSHOT_MODE_V1, "Unknown review source mode");
  const snapshot = reviewMode === undefined ? null : await captureNativeReviewSnapshotIdentityV1(repository, head);
  if (snapshot) assert.equal(base, snapshot.base, "Full snapshot BASE must be the Git empty tree");
  const mergeBase = snapshot ? null : String((await sourceGit(repository, ["merge-base", base, head])).stdout).trim();
  if (!snapshot) assert.equal(mergeBase, base, "Review BASE must equal the Git merge base of HEAD");
  const manifest = snapshot ? snapshot.manifest.files : parseNameStatus((await sourceGit(repository, ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", `${base}..${head}`], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 })).stdout);
  const baseTree = snapshot ? new Map() : await treeMap(repository, base);
  const headTree = await treeMap(repository, head);
  const sourceManifest = manifest.map(entry => sourceEntry(entry, baseTree, headTree));
  const context = await captureContext(repository, head, contextPaths, headTree);
  const manifestDigest = digestObject(sourceManifest);
  const source = {
    repository,
    base,
    head,
    mergeBase,
    manifest: sourceManifest,
    manifestDigest,
    context,
    ...(snapshot ? { reviewMode: snapshot.reviewMode, snapshotTreeOid: snapshot.snapshotTreeOid, fullUniverseDigest: snapshot.fullUniverseDigest } : {}),
    sourceDigest: digestObject({ repository, ...sourceIdentity({ manifest: sourceManifest, manifestDigest, mergeBase, base, head, ...(snapshot ? { reviewMode: snapshot.reviewMode, snapshotTreeOid: snapshot.snapshotTreeOid, fullUniverseDigest: snapshot.fullUniverseDigest } : {}) }), contextDigest: context.digest })
  };
  await assertPhysicalSnapshot(repositorySnapshot, "Review source repository");
  return { source, baseTree, headTree };
}

function compareSuppliedManifest(supplied, actual) {
  if (supplied === undefined || supplied === null) return;
  assert.deepEqual(canonicalManifest(supplied, "supplied manifest"), canonicalManifest(actual, "Git manifest"),
    "Supplied review manifest does not match the clean Git BASE..HEAD manifest");
}

function unitSource(entry, bytes, contentSha256 = null, pageDigests = null) {
  const base = entry.base;
  const head = entry.head;
  const pages = pageDigests ?? (contentSha256 === null ? [] : [contentSha256]);
  return {
    base,
    head,
    bytes,
    contentSha256,
    pageDigests: pages,
    identity: digestObject({ base, head, bytes, contentSha256, pageDigests: pages })
  };
}

function makeUnit({ entry, kind = "path", range = null, bytes, contentSha256 = null, pageDigests = null }) {
  const source = unitSource(entry, bytes, contentSha256, pageDigests);
  const core = {
    kind,
    path: entry.path,
    oldPath: entry.oldPath ?? null,
    source,
    range
  };
  return {
    id: `unit-${digestObject(core).slice(0, 32)}`,
    ...core,
    obligationIds: []
  };
}

async function buildUnits(source, baseTree, headTree, policy) {
  const units = [];
  const prepared = await mapBounded(source.manifest, 8, async entry => {
    const selected = entry.head ?? entry.base;
    const bytes = selected?.bytes ?? 0;
    assert(selected, `Changed review path is absent from both frozen trees: ${entry.path}`);
    const revision = entry.head ? source.head : source.base;
    const sourcePath = entry.head ? entry.path : (entry.oldPath ?? entry.path);
    const tree = entry.head ? headTree : baseTree;
    assert(tree.get(sourcePath), `Git source tree identity disappeared: ${sourcePath}`);
    const file = await sourceGit(source.repository, ["show", `${revision}:${sourcePath}`], {
      encoding: "buffer",
      maxBuffer: Math.max(bytes + 1024, policy.maxSourceBytes + 1024)
    });
    const content = Buffer.isBuffer(file.stdout) ? file.stdout : Buffer.from(file.stdout ?? "");
    assert.equal(content.length, bytes, `Git review source bytes changed: ${entry.path}`);
    return { entry, bytes, content };
  });
  for (const { entry, bytes, content } of prepared) {
    if (bytes <= policy.maxSourceBytes) {
      const contentSha256 = contentDigest(content);
      units.push(makeUnit({ entry, bytes, contentSha256, pageDigests: [contentSha256] }));
      continue;
    }
    const wholeDigest = contentDigest(content);
    const pageDigests = [];
    for (let start = 0; start < bytes; start += policy.maxSourceBytes) {
      const end = Math.min(bytes, start + policy.maxSourceBytes);
      const pageDigest = contentDigest(content.subarray(start, end));
      pageDigests.push(pageDigest);
      const subunit = makeUnit({ entry, kind: "subunit", range: { start, end }, bytes: end - start,
        contentSha256: pageDigest, pageDigests: [pageDigest] });
      units.push(subunit);
    }
    const whole = makeUnit({ entry, kind: "whole-file-integration", bytes, contentSha256: wholeDigest, pageDigests });
    units.push(whole);
  }
  return units.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeObligations(input = [], units) {
  assert(Array.isArray(input) && input.length <= 4096, "review obligations are bounded");
  const byPath = new Map();
  for (const unit of units) byPath.set(unit.path, [...(byPath.get(unit.path) ?? []), unit.id]);
  const obligations = input.map((entry, index) => {
    const label = `obligations[${index}]`;
    exact(entry, ["id", "kind", "paths", "required"], label);
    const obligationId = id(entry.id, `${label}.id`);
    assert(OBLIGATION_KINDS.has(entry.kind), `${label}.kind is invalid`);
    assert(entry.required === true, `${label}.required must be true`);
    assert(Array.isArray(entry.paths) && entry.paths.length > 0, `${label}.paths must be non-empty`);
    const paths = [...new Set(entry.paths.map((value, pathIndex) => relativePath(value, `${label}.paths[${pathIndex}]`)))].sort();
    for (const value of paths) assert(byPath.has(value), `${label} references an unknown changed path: ${value}`);
    if (entry.kind !== "large-file-integration") assert(paths.length >= 2, `${label} must cover at least two paths`);
    const unitIds = [...new Set(paths.flatMap(value => byPath.get(value)))].sort();
    assert(unitIds.length > 0, `${label} has no assigned units`);
    return { id: obligationId, kind: entry.kind, paths, unitIds, required: true };
  });
  const seen = new Set();
  for (const entry of obligations) assert(!seen.has(entry.id) && seen.add(entry.id), `Duplicate review obligation: ${entry.id}`);
  return obligations.sort((left, right) => left.id.localeCompare(right.id));
}

function withGeneratedLargeFileObligations(input, units) {
  const generated = [];
  const largePaths = [...new Set(units.filter(unit => unit.kind === "whole-file-integration").map(unit => unit.path))].sort();
  for (const relative of largePaths) generated.push({
    id: `large-file-${digestObject(relative).slice(0, 24)}`,
    kind: "large-file-integration",
    paths: [relative],
    required: true
  });
  return normalizeObligations([...(input ?? []), ...generated], units);
}

function applyObligations(units, obligations) {
  const byUnit = new Map(units.map(unit => [unit.id, []]));
  for (const obligation of obligations) for (const unitId of obligation.unitIds) byUnit.get(unitId).push(obligation.id);
  return units.map(unit => ({ ...unit, obligationIds: byUnit.get(unit.id).sort() }));
}

function makeAssignments(roles, units) {
  const assignments = [];
  for (const role of roles) for (const unit of units) {
    const assignment = { roleId: role.id, unitId: unit.id, required: role.required };
    assignments.push({ id: `assignment-${digestObject(assignment).slice(0, 32)}`, ...assignment, order: assignments.length });
  }
  return assignments;
}

function makeBatches(units, assignments, policy) {
  const batches = [];
  for (let start = 0; start < units.length; start += policy.maxPrimaryUnits) {
    const selected = units.slice(start, start + policy.maxPrimaryUnits);
    const unitIds = selected.map(unit => unit.id);
    const assignmentIds = assignments.filter(item => unitIds.includes(item.unitId)).map(item => item.id);
    batches.push({ batchId: `batch-${String(batches.length).padStart(4, "0")}`, order: batches.length,
      unitIds, assignmentIds, primaryUnitCount: unitIds.length });
  }
  return batches;
}

function budgetFor({ roles, batches, policy }) {
  const requiredRoleCount = roles.filter(role => role.required).length;
  const estimatedMs = Math.ceil(batches.length * requiredRoleCount * policy.targetTimeoutMs / policy.concurrency);
  // This is the deterministic wall-time gate for this bounded slice only.
  // The 90-minute default is not a V5 total-time guarantee; a future runner
  // must supply a separate trusted aggregate-budget authorization before a
  // different total can be used. Token, cost, and attempt counters live in
  // checkpoint ledger observations and are not available quota or authority.
  return { estimatedMs, maxTotalTimeMs: policy.maxTotalTimeMs,
    status: estimatedMs <= policy.maxTotalTimeMs ? "READY" : "PAUSED_BUDGET" };
}

function planBody({ source, context, roles, units, obligations, assignments, batches, policy, budget, planId }) {
  return {
    schemaVersion: REVIEW_SHARDED_V2_SCHEMA_VERSION,
    kind: REVIEW_SHARD_PLAN_KIND,
    protocol: REVIEW_SHARDED_V2_PROTOCOL,
    immutable: true,
    planId,
    source,
    context,
    roles,
    units,
    obligations,
    assignments,
    batches,
    policy,
    budget
  };
}

function assertSourceShape(source) {
  const snapshot = source.reviewMode === undefined ? null : inspectNativeReviewSnapshotSubjectV1(Object.fromEntries(["reviewMode", "base", "head", "mergeBase", "snapshotTreeOid", "fullUniverseDigest"].map(key => [key, source[key]])));
  exact(source, ["repository", "base", "head", "mergeBase", "manifest", "manifestDigest", "context", "sourceDigest", ...(snapshot ? ["reviewMode", "snapshotTreeOid", "fullUniverseDigest"] : [])], "review source");
  assert(path.isAbsolute(source.repository) && path.resolve(source.repository) === source.repository, "review source repository is invalid");
  if (!snapshot) {
    for (const value of [source.base, source.head, source.mergeBase]) assert(SHA.test(value), "review source revision is invalid");
    assert.equal(source.mergeBase, source.base);
  } else {
    assert(source.manifest.every(entry => entry.status === "A" && entry.base === null && entry.head?.type === "blob" && ["100644", "100755"].includes(entry.head.mode) && !entry.oldPath), "Snapshot manifest must account for every HEAD blob as an addition");
    const universe = source.manifest.map(entry => ({ path: entry.path, mode: entry.head.mode, type: entry.head.type, oid: entry.head.object })).sort((left, right) => left.path.localeCompare(right.path, "en"));
    assert.equal(source.fullUniverseDigest, digestObject(universe), "Full snapshot universe digest is stale");
  }
  canonicalManifest(manifestProjection(source.manifest), "review source manifest");
  assert.equal(digestObject(source.manifest), source.manifestDigest, "Review source manifest digest is stale");
  exact(source.context, ["paths", "bytes", "digest"], "review source context");
  assert(Array.isArray(source.context.paths) && source.context.paths.length <= 256);
  integer(source.context.bytes, "review source context.bytes");
  assert(source.context.bytes <= 16 * 1024);
  assert.equal(source.context.bytes, source.context.paths.reduce((total, item) => total + item.bytes, 0));
  assert.deepEqual(source.context.paths.map(item => item.path), source.context.paths.map(item => item.path).sort(), "Review context paths are not canonical");
  for (const item of source.context.paths) {
    exact(item, ["path", "revision", "mode", "type", "object", "bytes"], "review context path");
    relativePath(item.path, "review context path.path");
    assert.equal(item.revision, source.head); assert(/^\d{6}$/.test(item.mode)); assert(["blob", "commit", "tree"].includes(item.type));
    assert(SHA.test(item.object)); integer(item.bytes, "review context path.bytes");
  }
  assert.equal(source.context.digest, digestObject(source.context.paths));
  assert.equal(source.sourceDigest, digestObject({ repository: source.repository, ...sourceIdentity(source), contextDigest: source.context.digest }));
  for (const entry of source.manifest) {
    exact(entry, ["status", "path", ...(entry.oldPath ? ["oldPath"] : []), "base", "head"], "review manifest entry");
    for (const side of ["base", "head"]) {
      const value = entry[side];
      if (value === null) continue;
      exact(value, ["mode", "type", "object", "bytes"], `review manifest ${side}`);
      assert(/^\d{6}$/.test(value.mode)); assert(["blob", "commit", "tree"].includes(value.type)); assert(SHA.test(value.object)); integer(value.bytes, "review manifest bytes");
    }
  }
  return source;
}

function assertRoleUnitCoverage(plan) {
  const roles = normalizeRoles(plan.roles);
  const units = plan.units;
  const unitIds = new Set(units.map(unit => unit.id));
  assert.equal(unitIds.size, units.length, "Duplicate review unit");
  const roleIds = new Set(roles.map(role => role.id));
  const expected = new Set();
  for (const role of roles) for (const unit of units) expected.add(`${role.id}\0${unit.id}`);
  const seen = new Set();
  assert(Array.isArray(plan.assignments) && plan.assignments.length === expected.size,
    "Review assignments must contain exactly one entry for every role×unit pair");
  for (const [index, assignment] of plan.assignments.entries()) {
    exact(assignment, ["id", "roleId", "unitId", "required", "order"], "review assignment");
    id(assignment.id, "review assignment.id"); assert(roleIds.has(assignment.roleId)); assert(unitIds.has(assignment.unitId));
    assert.equal(assignment.required, roles.find(role => role.id === assignment.roleId).required);
    assert.equal(assignment.order, index, "Review assignment order is not canonical");
    const key = `${assignment.roleId}\0${assignment.unitId}`;
    assert(!seen.has(key), "Duplicate role×unit assignment"); seen.add(key);
  }
  assert.equal(seen.size, expected.size, "Missing required role×unit assignment");
  assert.deepEqual([...seen].sort(), [...expected].sort(), "Role×unit coverage is incomplete");
}

function assertPlanShape(plan) {
  exact(plan, ["schemaVersion", "kind", "protocol", "immutable", "planId", "source", "context", "roles", "units", "obligations", "assignments", "batches", "policy", "budget", "planDigest"], "ReviewShardPlanV1");
  assert.equal(plan.schemaVersion, 1); assert.equal(plan.kind, REVIEW_SHARD_PLAN_KIND); assert.equal(plan.protocol, REVIEW_SHARDED_V2_PROTOCOL); assert.equal(plan.immutable, true); id(plan.planId, "planId");
  assertSourceShape(plan.source); assert.deepEqual(plan.context, plan.source.context); normalizePolicy(plan.policy); assert.deepEqual(plan.roles, [...plan.roles].sort((left, right) => left.id.localeCompare(right.id)), "Review roles are not canonical"); normalizeRoles(plan.roles);
  assert(Array.isArray(plan.units) && plan.units.length > 0 && plan.units.length <= 4096);
  const unitIds = new Set();
  for (const unit of plan.units) {
    exact(unit, ["id", "kind", "path", "oldPath", "source", "range", "obligationIds"], "ReviewUnitV1");
    id(unit.id, "unit.id"); assert(UNIT_KINDS.has(unit.kind)); relativePath(unit.path, "unit.path");
    assert(unit.oldPath === null || typeof unit.oldPath === "string");
    if (unit.oldPath !== null) relativePath(unit.oldPath, "unit.oldPath");
    exact(unit.source, ["base", "head", "bytes", "contentSha256", "pageDigests", "identity"], "unit.source");
    for (const side of ["base", "head"]) {
      const value = unit.source[side];
      if (value !== null) { exact(value, ["mode", "type", "object", "bytes"], "unit source tree identity"); assert(SHA.test(value.object)); integer(value.bytes, "unit source bytes"); }
    }
    integer(unit.source.bytes, "unit.source.bytes");
    assert(DIGEST.test(unit.source.contentSha256), "unit.source.contentSha256 is required");
    assert(Array.isArray(unit.source.pageDigests) && unit.source.pageDigests.length > 0);
    unit.source.pageDigests.forEach(value => digest(value, "unit.source.pageDigest"));
    assert.equal(unit.source.identity, digestObject({ base: unit.source.base, head: unit.source.head,
      bytes: unit.source.bytes, contentSha256: unit.source.contentSha256,
      pageDigests: unit.source.pageDigests }), "unit.source.identity is stale");
    if (unit.kind === "path") { assert(unit.range === null && unit.source.bytes <= plan.policy.maxSourceBytes); assert.equal(unit.source.pageDigests.length, 1); assert.equal(unit.source.pageDigests[0], unit.source.contentSha256); }
    if (unit.kind === "subunit") { exact(unit.range, ["start", "end"], "unit.range"); integer(unit.range.start); integer(unit.range.end, "unit.range.end", { min: unit.range.start + 1 }); assert(unit.range.end - unit.range.start === unit.source.bytes); assert(unit.source.bytes <= plan.policy.maxSourceBytes); assert.equal(unit.source.pageDigests.length, 1); assert.equal(unit.source.pageDigests[0], unit.source.contentSha256); }
    if (unit.kind === "whole-file-integration") { assert(unit.range === null); assert(unit.source.bytes > plan.policy.maxSourceBytes); assert.equal(unit.source.pageDigests.length, Math.ceil(unit.source.bytes / plan.policy.maxSourceBytes)); }
    assert(Array.isArray(unit.obligationIds)); unit.obligationIds.forEach(value => id(value, "unit.obligationId"));
    assert(!unitIds.has(unit.id), "Duplicate review unit"); unitIds.add(unit.id);
  }
  assert.deepEqual(plan.units.map(unit => unit.id), plan.units.map(unit => unit.id).sort(), "Review units are not canonical");
  assert(Array.isArray(plan.obligations));
  const obligations = new Set();
  const unitsByPath = new Map();
  for (const unit of plan.units) unitsByPath.set(unit.path, [...(unitsByPath.get(unit.path) ?? []), unit.id]);
  for (const entry of plan.obligations) {
    exact(entry, ["id", "kind", "paths", "unitIds", "required"], "Review obligation"); id(entry.id, "obligation.id"); assert(OBLIGATION_KINDS.has(entry.kind)); assert(entry.required === true);
    assert(Array.isArray(entry.paths) && entry.paths.length > 0);
    const paths = entry.paths.map(value => relativePath(value, "obligation.path"));
    assert.deepEqual(paths, [...new Set(paths)].sort(), "Review obligation paths are not canonical");
    assert(entry.kind === "large-file-integration" || entry.paths.length >= 2); assert(Array.isArray(entry.unitIds) && entry.unitIds.length > 0); entry.unitIds.forEach(value => assert(unitIds.has(value), "obligation references unknown unit"));
    const expectedUnitIds = [...new Set(paths.flatMap(value => unitsByPath.get(value) ?? []))].sort();
    assert.deepEqual(entry.unitIds, expectedUnitIds, "Review obligation does not cover its declared paths exactly");
    assert(!obligations.has(entry.id), "Duplicate review obligation"); obligations.add(entry.id);
  }
  assert.deepEqual(plan.obligations.map(entry => entry.id), plan.obligations.map(entry => entry.id).sort(), "Review obligations are not canonical");
  const obligationsByUnit = new Map(plan.units.map(unit => [unit.id, []]));
  for (const entry of plan.obligations) for (const unitId of entry.unitIds) obligationsByUnit.get(unitId).push(entry.id);
  for (const unit of plan.units) {
    for (const obligationId of unit.obligationIds) assert(obligations.has(obligationId), "Unit references unknown obligation");
    assert.deepEqual(unit.obligationIds, obligationsByUnit.get(unit.id).sort(), "Unit obligation coverage is not exact");
  }
  assertRoleUnitCoverage(plan);
  const batchUnitIds = new Set();
  const expectedBatchCount = Math.ceil(plan.units.length / plan.policy.maxPrimaryUnits);
  assert(Array.isArray(plan.batches) && plan.batches.length === expectedBatchCount, "Review batches are incomplete");
  const assignmentById = new Map(plan.assignments.map(item => [item.id, item]));
  for (const [index, batch] of plan.batches.entries()) {
    exact(batch, ["batchId", "order", "unitIds", "assignmentIds", "primaryUnitCount"], "Review batch"); id(batch.batchId, "batch.batchId"); integer(batch.order); assert(Array.isArray(batch.unitIds) && batch.unitIds.length > 0 && batch.unitIds.length <= plan.policy.maxPrimaryUnits); assert.equal(batch.primaryUnitCount, batch.unitIds.length); assert(Array.isArray(batch.assignmentIds));
    assert.equal(batch.order, index, "Review batch order is not canonical");
    const expectedUnitIds = plan.units.slice(index * plan.policy.maxPrimaryUnits, (index + 1) * plan.policy.maxPrimaryUnits).map(unit => unit.id);
    assert.deepEqual(batch.unitIds, expectedUnitIds, "Review batch units are not canonical");
    for (const unitId of batch.unitIds) { assert(unitIds.has(unitId)); assert(!batchUnitIds.has(unitId), "Unit assigned to multiple batches"); batchUnitIds.add(unitId); }
    const expectedAssignmentIds = plan.assignments.filter(item => batch.unitIds.includes(item.unitId)).map(item => item.id);
    assert.deepEqual(batch.assignmentIds, expectedAssignmentIds, "Review batch assignments do not match its units");
    assert.equal(new Set(batch.assignmentIds).size, batch.assignmentIds.length, "Review batch contains duplicate assignments");
    for (const assignmentId of batch.assignmentIds) assert(assignmentById.has(assignmentId), "Review batch references an unknown assignment");
  }
  assert.equal(batchUnitIds.size, unitIds.size, "Batches omit a review unit");
  const batchedAssignments = plan.batches.flatMap(batch => batch.assignmentIds);
  assert.deepEqual([...batchedAssignments].sort(), plan.assignments.map(item => item.id).sort(), "Batches omit or duplicate review assignments");
  exact(plan.budget, ["estimatedMs", "maxTotalTimeMs", "status"], "Review budget"); integer(plan.budget.estimatedMs); assert.equal(plan.budget.maxTotalTimeMs, plan.policy.maxTotalTimeMs); assert(["READY", "PAUSED_BUDGET"].includes(plan.budget.status));
  const expectedBudget = budgetFor({ units: plan.units, roles: plan.roles, batches: plan.batches, policy: plan.policy }); assert.deepEqual(plan.budget, expectedBudget);
  const withoutDigest = { ...plan }; delete withoutDigest.planDigest; digest(plan.planDigest, "planDigest"); assert.equal(plan.planDigest, digestObject(withoutDigest), "Review plan digest is stale");
  return plan;
}

export async function captureTrustedReviewSourceV2({ repository, base, head, contextPaths = [], manifest = undefined, reviewMode = undefined } = {}) {
  const paths = normalizeContextPaths(contextPaths);
  const captured = await captureSource(repository, base, head, paths, reviewMode);
  compareSuppliedManifest(manifest, manifestProjection(captured.source.manifest));
  return deepFreeze(captured.source);
}

/**
 * "Trusted" covers only internal source capture and physical snapshot.
 * Policy, roles, manifest, and obligations remain untrusted JSON data;
 * normalization grants no authority and attests no future execution.
 */
export async function createTrustedReviewShardPlanV2({ repository, base, head, roles, contextPaths = [], manifest = undefined, obligations = [], policy = DEFAULT_REVIEW_SHARDED_V2_POLICY, planId = null, reviewMode = undefined } = {}) {
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedRoles = normalizeRoles(roles);
  const captured = await captureSource(repository, base, head, normalizeContextPaths(contextPaths), reviewMode);
  compareSuppliedManifest(manifest, manifestProjection(captured.source.manifest));
  const unitsInitial = await buildUnits(captured.source, captured.baseTree, captured.headTree, normalizedPolicy);
  const obligationsValue = withGeneratedLargeFileObligations(obligations, unitsInitial);
  const units = applyObligations(unitsInitial, obligationsValue);
  const assignments = makeAssignments(normalizedRoles, units);
  const batches = makeBatches(units, assignments, normalizedPolicy);
  const budget = budgetFor({ units, roles: normalizedRoles, batches, policy: normalizedPolicy });
  const resolvedPlanId = planId === null ? `review-v2-${digestObject({ source: captured.source.sourceDigest, roles: normalizedRoles, units: units.map(unit => unit.id), obligations: obligationsValue, policy: normalizedPolicy }).slice(0, 32)}` : id(planId, "planId");
  const body = planBody({ source: captured.source, context: captured.source.context, roles: normalizedRoles, units, obligations: obligationsValue, assignments, batches, policy: normalizedPolicy, budget, planId: resolvedPlanId });
  const plan = deepFreeze({ ...body, planDigest: digestObject(body) });
  assertPlanShape(plan);
  await assertPhysicalSnapshot(await assertPhysicalPath(captured.source.repository, "Review source repository", { directory: true }), "Review source repository");
  return plan;
}

export function validateReviewShardPlanV2(plan) {
  return deepFreeze(assertPlanShape(plan));
}

export async function assertReviewShardPlanFresh(plan) {
  const canonical = validateReviewShardPlanV2(plan);
  const source = await captureTrustedReviewSourceV2({ repository: canonical.source.repository, base: canonical.source.base, head: canonical.source.head,
    contextPaths: canonical.source.context.paths.map(entry => entry.path), manifest: manifestProjection(canonical.source.manifest), reviewMode: canonical.source.reviewMode });
  assert.equal(source.sourceDigest, canonical.source.sourceDigest, "Review source revision or manifest drifted");
  assert.equal(source.context.digest, canonical.source.context.digest, "Review context drifted");
  return canonical;
}

function validatePages(pages, expectedBytes, label, expectedPageDigests = null) {
  assert(Array.isArray(pages) && pages.length > 0, `${label}.pages must be non-empty`);
  if (expectedPageDigests !== null) {
    assert.deepEqual(pages.length, expectedPageDigests.length, `${label}.pages count does not match the frozen source`);
  }
  let offset = 0;
  for (const [index, page] of pages.entries()) {
    exact(page, ["offset", "bytes", "sha256", "eof"], `${label}.pages[${index}]`); integer(page.offset); integer(page.bytes, `${label}.pages.bytes`, { min: expectedBytes === 0 ? 0 : 1 }); digest(page.sha256, `${label}.pages.sha256`); assert(typeof page.eof === "boolean"); assert.equal(page.offset, offset); assert.equal(page.eof, index === pages.length - 1); if (expectedPageDigests !== null) { const expectedPageBytes = Math.min(64 * 1024, expectedBytes - offset); assert.equal(page.bytes, expectedPageBytes, `${label}.pages bytes do not match the frozen page boundary`); assert.equal(page.sha256, expectedPageDigests[index], `${label}.page hash does not match the frozen source`); } offset += page.bytes;
  }
  assert.equal(offset, expectedBytes, `${label}.pages do not cover the frozen source bytes`);
}

// This is a typed execution receipt shape for sealed review data. It is not a
// host attestation and never makes a result authoritative on its own.
function executionProof(value, label) {
  exact(value, ["executionId", "traceSha256", "code", "signal", "groupTerminated", "cleaned"], label); id(value.executionId, `${label}.executionId`); digest(value.traceSha256, `${label}.traceSha256`); assert(value.code === null || Number.isSafeInteger(value.code)); assert(value.signal === null || typeof value.signal === "string"); assert.equal(value.groupTerminated, true); assert.equal(value.cleaned, true); return value;
}

function validateFindings(findings, unit = null, label = "Review findings") {
  assert(Array.isArray(findings) && findings.length <= 32, `${label} must be bounded`);
  for (const [index, finding] of findings.entries()) {
    const findingLabel = `${label}[${index}]`;
    exact(finding, ["severity", "path", "line", "title", "evidence", "requiredChange"], findingLabel);
    assert(["P0", "P1", "P2", "P3"].includes(finding.severity), `${findingLabel}.severity is invalid`);
    relativePath(finding.path, `${findingLabel}.path`);
    if (unit) assert(finding.path === unit.path || finding.path === unit.oldPath, `${findingLabel}.path is outside the assigned unit`);
    assert(finding.line === null || (Number.isSafeInteger(finding.line) && finding.line > 0), `${findingLabel}.line is invalid`);
    for (const key of ["title", "evidence", "requiredChange"]) assert(typeof finding[key] === "string" && finding[key].trim(), `${findingLabel}.${key} is invalid`);
  }
  return findings;
}

function unitForAssignment(plan, roleId, unitId) {
  const assignment = plan.assignments.find(item => item.roleId === roleId && item.unitId === unitId);
  assert(assignment, "Review result references an unknown role×unit assignment");
  return { assignment, unit: plan.units.find(item => item.id === unitId) };
}

export function createSealedReviewUnitResult({ plan, roleId, unitId, verdict, reason = null, findings = [], pages, execution } = {}) {
  const canonicalPlan = validateReviewShardPlanV2(plan); id(roleId, "roleId"); id(unitId, "unitId");
  const { assignment, unit } = unitForAssignment(canonicalPlan, roleId, unitId);
  assert(RESULT_VERDICTS.has(verdict)); validateFindings(findings, unit, "ReviewUnitResultV1.findings"); assert(verdict === "PASS" ? findings.length === 0 : verdict === "BLOCK" ? findings.length > 0 : true); assert(verdict === "UNKNOWN" ? typeof reason === "string" && reason.trim() : reason === null || typeof reason === "string");
  validatePages(pages, unit.source.bytes, "ReviewUnitResultV1", unit.source.pageDigests); executionProof(execution, "ReviewUnitResultV1.execution");
  const body = { schemaVersion: 1, kind: REVIEW_UNIT_RESULT_KIND, protocol: REVIEW_SHARDED_V2_PROTOCOL, sealed: true, authoritative: false,
    planDigest: canonicalPlan.planDigest, assignmentId: assignment.id, roleId, unitId, verdict, reason, findings, pages, execution };
  const result = deepFreeze({ ...body, resultDigest: digestObject(body) }); UNIT_RESULTS.add(result); return result;
}

export function validateSealedReviewUnitResult(value, plan = null) {
  exact(value, ["schemaVersion", "kind", "protocol", "sealed", "authoritative", "planDigest", "assignmentId", "roleId", "unitId", "verdict", "reason", "findings", "pages", "execution", "resultDigest"], REVIEW_UNIT_RESULT_KIND);
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, REVIEW_UNIT_RESULT_KIND); assert.equal(value.protocol, REVIEW_SHARDED_V2_PROTOCOL); assert.equal(value.sealed, true, "Review unit result must be sealed"); assert.equal(value.authoritative, false, "Review unit result cannot claim authoritative status"); digest(value.planDigest, "result.planDigest"); id(value.assignmentId, "result.assignmentId"); id(value.roleId, "result.roleId"); id(value.unitId, "result.unitId"); assert(RESULT_VERDICTS.has(value.verdict)); const unit = plan ? plan.units.find(item => item.id === value.unitId) : null; if (plan) assert(unit, "Review result references an unknown unit"); validateFindings(value.findings, unit, "ReviewUnitResultV1.findings"); assert(value.verdict !== "PASS" || value.findings.length === 0, "Review unit PASS cannot contain findings"); assert(value.verdict !== "BLOCK" || value.findings.length > 0, "Review unit BLOCK requires a finding"); validatePages(value.pages, unit?.source.bytes ?? value.pages.reduce((sum, page) => sum + page.bytes, 0), "ReviewUnitResultV1", unit?.source.pageDigests ?? null); executionProof(value.execution, "ReviewUnitResultV1.execution");
  const body = { ...value }; delete body.resultDigest; assert.equal(value.resultDigest, digestObject(body), "Review unit result digest is stale");
  if (plan) { const canonicalPlan = validateReviewShardPlanV2(plan); assert.equal(value.planDigest, canonicalPlan.planDigest); const { assignment } = unitForAssignment(canonicalPlan, value.roleId, value.unitId); assert.equal(value.assignmentId, assignment.id); }
  return deepFreeze(value);
}

export function createSealedReviewLaneReceipt({ plan, roleId, results } = {}) {
  const canonicalPlan = validateReviewShardPlanV2(plan); id(roleId, "roleId"); const role = canonicalPlan.roles.find(item => item.id === roleId); assert(role, "Review lane role is unknown"); assert(Array.isArray(results));
  const normalized = results.map(item => validateSealedReviewUnitResult(item, canonicalPlan)); const expected = canonicalPlan.units.map(unit => `${roleId}\0${unit.id}`).sort(); const seen = new Set();
  for (const result of normalized) { assert.equal(result.roleId, roleId); const key = `${roleId}\0${result.unitId}`; assert(!seen.has(key), "Duplicate role×unit result"); seen.add(key); }
  assert.deepEqual([...seen].sort(), expected, "Review lane does not cover every assigned unit");
  const body = { schemaVersion: 1, kind: REVIEW_LANE_RECEIPT_KIND, protocol: REVIEW_SHARDED_V2_PROTOCOL, sealed: true, authoritative: false,
    planDigest: canonicalPlan.planDigest, roleId, required: role.required, resultDigests: normalized.map(item => item.resultDigest).sort(), coverage: { expected: expected.length, observed: seen.size, complete: true }, verdict: normalized.some(item => item.verdict === "BLOCK") ? "BLOCK" : normalized.some(item => item.verdict === "UNKNOWN") ? "UNKNOWN" : "PASS" };
  const receipt = deepFreeze({ ...body, receiptDigest: digestObject(body) }); LANE_RECEIPTS.add(receipt); return receipt;
}

export function validateSealedReviewLaneReceipt(value, plan = null) {
  exact(value, ["schemaVersion", "kind", "protocol", "sealed", "authoritative", "planDigest", "roleId", "required", "resultDigests", "coverage", "verdict", "receiptDigest"], REVIEW_LANE_RECEIPT_KIND);
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, REVIEW_LANE_RECEIPT_KIND); assert.equal(value.protocol, REVIEW_SHARDED_V2_PROTOCOL); assert.equal(value.sealed, true, "Review lane receipt must be sealed"); assert.equal(value.authoritative, false, "Review lane receipt cannot claim authoritative status"); digest(value.planDigest, "lane.planDigest"); id(value.roleId, "lane.roleId"); assert(typeof value.required === "boolean"); assert(Array.isArray(value.resultDigests)); value.resultDigests.forEach(item => digest(item, "lane.resultDigest")); assert.equal(new Set(value.resultDigests).size, value.resultDigests.length, "Lane receipt contains duplicate result digests"); assert.deepEqual(value.resultDigests, [...value.resultDigests].sort(), "Lane receipt result digests are not canonical"); exact(value.coverage, ["expected", "observed", "complete"], "lane.coverage"); integer(value.coverage.expected); integer(value.coverage.observed); assert.equal(value.coverage.complete, true); assert.equal(value.coverage.expected, value.coverage.observed); assert.equal(value.resultDigests.length, value.coverage.observed); assert(["PASS", "BLOCK", "UNKNOWN"].includes(value.verdict)); const body = { ...value }; delete body.receiptDigest; assert.equal(value.receiptDigest, digestObject(body), "Review lane receipt digest is stale");
  if (plan) { const canonicalPlan = validateReviewShardPlanV2(plan); assert.equal(value.planDigest, canonicalPlan.planDigest); assert(canonicalPlan.roles.some(role => role.id === value.roleId && role.required === value.required)); assert.equal(value.coverage.expected, canonicalPlan.units.length); }
  return deepFreeze(value);
}

export function createSealedReviewAggregate({ plan, laneReceipts, unitResults } = {}) {
  const canonicalPlan = validateReviewShardPlanV2(plan); assert(Array.isArray(laneReceipts)); assert(Array.isArray(unitResults));
  const receipts = laneReceipts.map(item => validateSealedReviewLaneReceipt(item, canonicalPlan)); const results = unitResults.map(item => validateSealedReviewUnitResult(item, canonicalPlan));
  const requiredRoles = canonicalPlan.roles.filter(role => role.required); const byRole = new Map();
  for (const receipt of receipts) { assert(requiredRoles.some(role => role.id === receipt.roleId), "Aggregate contains a non-required review lane"); assert(!byRole.has(receipt.roleId), "Duplicate review lane receipt"); byRole.set(receipt.roleId, receipt); }
  assert.equal(receipts.length, requiredRoles.length, "Aggregate contains an unexpected review lane count");
  for (const role of requiredRoles) assert(byRole.has(role.id), `Missing required review lane: ${role.id}`);
  const requiredAssignments = new Set(canonicalPlan.assignments.filter(item => item.required).map(item => item.id)); const seen = new Set();
  for (const result of results) { assert(requiredAssignments.has(result.assignmentId), "Aggregate contains an unassigned or non-required result"); assert(!seen.has(result.assignmentId), "Aggregate contains duplicate assignment result"); seen.add(result.assignmentId); }
  assert.deepEqual([...seen].sort(), [...requiredAssignments].sort(), "Aggregate does not cover every required role×unit assignment");
  for (const role of requiredRoles) {
    const resultDigests = results.filter(result => result.roleId === role.id).map(result => result.resultDigest).sort();
    assert.deepEqual(byRole.get(role.id).resultDigests, resultDigests, `Review lane ${role.id} is not bound to its result bodies`);
  }
  const findings = results.flatMap(item => item.findings); const unknown = results.some(item => item.verdict === "UNKNOWN"); const blocked = results.some(item => item.verdict === "BLOCK");
  const body = { schemaVersion: 1, kind: REVIEW_AGGREGATE_KIND, protocol: REVIEW_SHARDED_V2_PROTOCOL, sealed: true, authoritative: false,
    planDigest: canonicalPlan.planDigest, laneReceiptDigests: receipts.map(item => item.receiptDigest).sort(), resultDigests: results.map(item => item.resultDigest).sort(),
    coverage: { requiredRoles: requiredRoles.map(role => role.id), requiredAssignments: requiredAssignments.size, observedAssignments: seen.size, complete: true },
    obligations: canonicalPlan.obligations.map(item => ({ id: item.id, covered: item.unitIds.every(unitId => results.some(result => result.unitId === unitId)) })),
    verdict: blocked ? "BLOCK" : unknown ? "UNKNOWN" : "HOLD", findings, admission: { status: "REQUIRED", digest: null }, reason: blocked ? null : unknown ? "unknown unit result requires reconciliation" : "trusted current admission and host attestation are not present" };
  const aggregate = deepFreeze({ ...body, aggregateDigest: digestObject(body) }); AGGREGATES.add(aggregate); return aggregate;
}

export function validateSealedReviewAggregate(value, plan = null) {
  exact(value, ["schemaVersion", "kind", "protocol", "sealed", "authoritative", "planDigest", "laneReceiptDigests", "resultDigests", "coverage", "obligations", "verdict", "findings", "admission", "reason", "aggregateDigest"], REVIEW_AGGREGATE_KIND);
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, REVIEW_AGGREGATE_KIND); assert.equal(value.protocol, REVIEW_SHARDED_V2_PROTOCOL); assert.equal(value.sealed, true, "Review aggregate must be sealed"); assert.equal(value.authoritative, false, "Review aggregate cannot claim authoritative status"); digest(value.planDigest, "aggregate.planDigest"); assert.equal(new Set(value.laneReceiptDigests).size, value.laneReceiptDigests.length, "Aggregate contains duplicate lane receipts"); assert.equal(new Set(value.resultDigests).size, value.resultDigests.length, "Aggregate contains duplicate results"); assert.deepEqual(value.laneReceiptDigests, [...value.laneReceiptDigests].sort(), "Aggregate lane receipt digests are not canonical"); assert.deepEqual(value.resultDigests, [...value.resultDigests].sort(), "Aggregate result digests are not canonical"); value.laneReceiptDigests.forEach(item => digest(item, "aggregate.laneReceiptDigest")); value.resultDigests.forEach(item => digest(item, "aggregate.resultDigest")); exact(value.coverage, ["requiredRoles", "requiredAssignments", "observedAssignments", "complete"], "aggregate.coverage"); assert(Array.isArray(value.coverage.requiredRoles)); assert.deepEqual(value.coverage.requiredRoles, [...value.coverage.requiredRoles].sort()); assert.equal(value.coverage.complete, true); integer(value.coverage.requiredAssignments); integer(value.coverage.observedAssignments); assert.equal(value.coverage.requiredAssignments, value.coverage.observedAssignments); assert(Array.isArray(value.obligations)); value.obligations.forEach(item => { exact(item, ["id", "covered"], "aggregate obligation"); id(item.id, "aggregate obligation.id"); assert(typeof item.covered === "boolean"); }); assert(["BLOCK", "UNKNOWN", "HOLD"].includes(value.verdict)); exact(value.admission, ["status", "digest"], "aggregate admission"); assert.equal(value.admission.status, "REQUIRED"); assert.equal(value.admission.digest, null); const body = { ...value }; delete body.aggregateDigest; assert.equal(value.aggregateDigest, digestObject(body), "Review aggregate digest is stale"); if (plan) { const canonicalPlan = validateReviewShardPlanV2(plan); assert.equal(value.planDigest, canonicalPlan.planDigest); assert.deepEqual(value.coverage.requiredRoles, canonicalPlan.roles.filter(role => role.required).map(role => role.id)); assert.equal(value.coverage.requiredAssignments, canonicalPlan.assignments.filter(item => item.required).length); assert.deepEqual(value.obligations.map(item => item.id), canonicalPlan.obligations.map(item => item.id)); } return deepFreeze(value);
}

function checkpointBody(value) {
  const body = { ...value }; delete body.checkpointDigest; return body;
}

function validateCheckpointShape(value, plan = null) {
  // Token, cost, and attempt counters are immutable ledger observations only.
  // They do not establish a quota, permit dispatch, or replace a trusted
  // budget gate.
  exact(value, ["schemaVersion", "kind", "protocol", "sealed", "runId", "planDigest", "sourceDigest", "epoch", "grantDigest", "admissionDigest", "status", "completedAssignmentIds", "nextBatchIndex", "budget", "resultDigests", "resumedFrom", "createdAt", "checkpointDigest"], REVIEW_CHECKPOINT_KIND);
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, REVIEW_CHECKPOINT_KIND); assert.equal(value.protocol, REVIEW_SHARDED_V2_PROTOCOL); assert.equal(value.sealed, true); id(value.runId, "checkpoint.runId"); digest(value.planDigest, "checkpoint.planDigest"); digest(value.sourceDigest, "checkpoint.sourceDigest"); integer(value.epoch, "checkpoint.epoch", { min: 1 }); digest(value.grantDigest, "checkpoint.grantDigest"); assert(value.admissionDigest === null || DIGEST.test(value.admissionDigest)); assert(CHECKPOINT_STATUSES.has(value.status)); assert(Array.isArray(value.completedAssignmentIds)); value.completedAssignmentIds.forEach(item => id(item, "checkpoint.assignmentId")); assert.equal(new Set(value.completedAssignmentIds).size, value.completedAssignmentIds.length); assert.deepEqual(value.completedAssignmentIds, [...value.completedAssignmentIds].sort(), "Checkpoint assignments are not canonical"); integer(value.nextBatchIndex); exact(value.budget, ["elapsedMs", "tokenUnits", "costUnits", "attemptsUsed"], "checkpoint.budget"); for (const key of Object.keys(value.budget)) integer(value.budget[key]); assert(Array.isArray(value.resultDigests)); value.resultDigests.forEach(item => digest(item, "checkpoint.resultDigest")); assert.equal(new Set(value.resultDigests).size, value.resultDigests.length, "Checkpoint contains duplicate result digests"); assert.deepEqual(value.resultDigests, [...value.resultDigests].sort(), "Checkpoint result digests are not canonical"); assert(value.resumedFrom === null || DIGEST.test(value.resumedFrom)); assert(typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))); digest(value.checkpointDigest, "checkpointDigest"); assert.equal(value.checkpointDigest, digestObject(checkpointBody(value)), "Review checkpoint digest is stale");
  if (plan) { const canonicalPlan = validateReviewShardPlanV2(plan); assert.equal(value.planDigest, canonicalPlan.planDigest); assert.equal(value.sourceDigest, canonicalPlan.source.sourceDigest); assert(value.nextBatchIndex <= canonicalPlan.batches.length); const known = new Set(canonicalPlan.assignments.map(item => item.id)); value.completedAssignmentIds.forEach(item => assert(known.has(item), "Checkpoint contains an unknown assignment")); }
  return deepFreeze(value);
}

export function createReviewCheckpoint({ plan, runId, epoch, grantDigest, admissionDigest = null, status = "READY", completedAssignmentIds = [], nextBatchIndex = 0, budget = { elapsedMs: 0, tokenUnits: 0, costUnits: 0, attemptsUsed: 0 }, resultDigests = [], resumedFrom = null } = {}) {
  const canonicalPlan = validateReviewShardPlanV2(plan); id(runId, "runId"); integer(epoch, "epoch", { min: 1 }); digest(grantDigest, "grantDigest"); assert(admissionDigest === null || DIGEST.test(admissionDigest)); assert(CHECKPOINT_STATUSES.has(status)); assert(Array.isArray(resultDigests)); const value = { schemaVersion: 1, kind: REVIEW_CHECKPOINT_KIND, protocol: REVIEW_SHARDED_V2_PROTOCOL, sealed: true, runId, planDigest: canonicalPlan.planDigest, sourceDigest: canonicalPlan.source.sourceDigest, epoch, grantDigest, admissionDigest, status, completedAssignmentIds: [...completedAssignmentIds].sort(), nextBatchIndex, budget: { ...budget }, resultDigests: [...resultDigests].sort(), resumedFrom, createdAt: nowIso() }; const checkpoint = deepFreeze({ ...value, checkpointDigest: digestObject(value) }); CHECKPOINTS.add(checkpoint); return validateCheckpointShape(checkpoint, canonicalPlan);
}

export function validateReviewCheckpoint(value, plan = null) { return validateCheckpointShape(value, plan); }

export async function persistReviewCheckpoint({ checkpoint, checkpointPath, plan = null } = {}) {
  const value = validateReviewCheckpoint(checkpoint, plan); assert(path.isAbsolute(checkpointPath) && path.resolve(checkpointPath) === checkpointPath, "Checkpoint path must be absolute and normalized");
  const writerLockPath = `${checkpointPath}.writer-lock`;
  try {
    await createJson(writerLockPath, { schemaVersion: 1, kind: "ReviewCheckpointWriterLockV1" });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Review checkpoint path has a competing writer; late writer rejected");
    throw error;
  }
  try {
    try { await lstat(checkpointPath); throw new Error("Review checkpoint path already exists; late writer rejected"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await atomicJson(checkpointPath, value);
    const file = await boundedFile(checkpointPath, "Review checkpoint");
    return { path: file.path, sha256: contentDigest(file.bytes) };
  } finally {
    await rm(writerLockPath, { force: true }).catch(() => undefined);
  }
}

export async function readReviewCheckpoint({ checkpointPath, plan = null } = {}) {
  const file = await boundedFile(checkpointPath, "Review checkpoint");
  const checkpoint = validateReviewCheckpoint(JSON.parse(file.bytes.toString("utf8")), plan);
  CHECKPOINTS.add(checkpoint);
  return checkpoint;
}

export function resumeReviewCheckpoint({ checkpoint, plan, newEpoch, newGrantDigest, newAdmissionDigest } = {}) {
  const prior = validateReviewCheckpoint(checkpoint, plan); const canonicalPlan = validateReviewShardPlanV2(plan); integer(newEpoch, "newEpoch", { min: 1 }); assert(newEpoch > prior.epoch, "Resume requires a strictly newer epoch"); digest(newGrantDigest, "newGrantDigest"); assert(newGrantDigest !== prior.grantDigest, "Resume requires a new grant"); digest(newAdmissionDigest, "newAdmissionDigest"); assert(prior.admissionDigest === null || newAdmissionDigest !== prior.admissionDigest, "Resume requires fresh admission"); assert(prior.status !== "COMPLETE", "Completed review cannot be resumed");
  return createReviewCheckpoint({ plan: canonicalPlan, runId: prior.runId, epoch: newEpoch, grantDigest: newGrantDigest, admissionDigest: newAdmissionDigest, status: "READY", completedAssignmentIds: prior.completedAssignmentIds, nextBatchIndex: prior.nextBatchIndex, budget: prior.budget, resultDigests: prior.resultDigests, resumedFrom: prior.checkpointDigest });
}

export const isSealedReviewUnitResult = value => UNIT_RESULTS.has(value);
export const isSealedReviewLaneReceipt = value => LANE_RECEIPTS.has(value);
export const isSealedReviewAggregate = value => AGGREGATES.has(value);
export const isReviewCheckpoint = value => CHECKPOINTS.has(value);
