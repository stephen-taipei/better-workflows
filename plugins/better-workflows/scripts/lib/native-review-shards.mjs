import assert from "node:assert/strict";
import path from "node:path";
import { contentDigest, MAX_REVIEW_DIFF_BYTES, MAX_REVIEW_PATHS } from "./native-review-content.mjs";

export const SHARD_PROTOCOL = "native-review-sharded-v1";
export const DEFAULT_SHARD_POLICY = Object.freeze({
  schemaVersion: 1, targetBytes: 1024 * 1024, maxShardBytes: 4 * 1024 * 1024,
  maxShards: 64, concurrency: 3, shardTimeoutMs: 30 * 60 * 1000,
  totalTimeoutMs: 90 * 60 * 1000, executionBudget: 65
});
export const shardDigest = value => contentDigest(JSON.stringify(value));
const DIGEST = /^[a-f0-9]{64}$/;
const exact = (value, keys, label) => {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `Unexpected ${label} fields`);
};

export function assertShardedReviewShape(review) {
  exact(review, ["schemaVersion", "verdict", "scopeCoverage", "findings", "reviewProtocol", "shardProof"], "sharded review");
  assert.equal(review.reviewProtocol, SHARD_PROTOCOL);
  const proof = review.shardProof;
  exact(proof, ["schemaVersion", "planDigest", "aggregateReceiptPath", "aggregateReceiptSha256", "executionId"], "shard proof");
  assert.equal(proof.schemaVersion, 1);
  assert(DIGEST.test(proof.planDigest) && DIGEST.test(proof.aggregateReceiptSha256));
  assert(typeof proof.aggregateReceiptPath === "string" && path.isAbsolute(proof.aggregateReceiptPath) &&
    path.resolve(proof.aggregateReceiptPath) === proof.aggregateReceiptPath && !proof.aggregateReceiptPath.includes("\0"));
  assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(proof.executionId));
  return proof;
}

export function validateShardPolicy(policy) {
  exact(policy, Object.keys(DEFAULT_SHARD_POLICY), "shard policy");
  assert.equal(policy.schemaVersion, 1);
  for (const key of Object.keys(policy)) assert(Number.isSafeInteger(policy[key]), `Invalid shard policy ${key}`);
  assert(policy.targetBytes >= 16 * 1024 && policy.targetBytes <= policy.maxShardBytes);
  assert(policy.maxShardBytes <= 4 * 1024 * 1024);
  assert(policy.maxShards >= 1 && policy.maxShards <= 64);
  assert(policy.concurrency >= 1 && policy.concurrency <= 3);
  assert(policy.shardTimeoutMs >= 1000 && policy.shardTimeoutMs <= 30 * 60 * 1000);
  assert(policy.totalTimeoutMs >= policy.shardTimeoutMs && policy.totalTimeoutMs <= 90 * 60 * 1000);
  assert(policy.executionBudget >= 2 && policy.executionBudget <= 65);
  return Object.fromEntries(Object.keys(DEFAULT_SHARD_POLICY).map(key => [key, policy[key]]));
}

// Only prose and translation data can be represented by shard reports in the
// cross-module pass. Executable documentation, templates and all other source
// are always reread there. All files still receive a full independent shard review.
export const documentOnlyPath = relative => /^docs\/.+\.(md|rst|txt)$/.test(relative) ||
  /^docs\/translations\/.+\.json$/.test(relative);

export function createShardPlan({ binding, parentIndexSha256, streams, images, policy }) {
  policy = validateShardPolicy(policy);
  assert.equal(binding.reviewProtocol, SHARD_PROTOCOL);
  assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,181}$/.test(binding.executionId), "Shard parent execution id exceeds derived identity budget");
  assert(DIGEST.test(parentIndexSha256), "Invalid parent index digest");
  assert(streams.length > 0 && streams.length <= MAX_REVIEW_PATHS, "Invalid shard universe");
  assert(new Set(streams.map(s => s.id)).size === streams.length, "Duplicate stream identity");
  assert(streams.every((s, i) => s.id === `s${String(i).padStart(6, "0")}` &&
    !s.binding.path.startsWith("__bw_review_reports__/")), "Noncanonical parent stream identity");
  assert(new Set(streams.map(s => s.binding.path)).size === streams.length, "Duplicate stream path");
  assert(streams.every(s => s.binding.base === binding.base && s.binding.head === binding.head &&
    s.binding.packageSha256 === binding.packageSha256 && s.binding.manifestSha256 === binding.manifestSha256),
  "Mixed shard source binding");
  assert(streams.reduce((n, s) => n + s.binding.bytes, 0) <= MAX_REVIEW_DIFF_BYTES);
  const universe = streams.map(({ id, binding: source }) => ({ id, binding: source }));
  const artifacts = images.map(({ path, revision, sha256, bytes }) => ({ path, revision, sha256, bytes }));
  assert(new Set(artifacts.map(a => `${a.path}\0${a.revision}`)).size === artifacts.length,
    "Duplicate image identity");
  for (const a of artifacts) assert(universe.some(s => s.binding.path === a.path) &&
    [binding.base, binding.head].includes(a.revision) && DIGEST.test(a.sha256) &&
    Number.isSafeInteger(a.bytes) && a.bytes > 0, "Unbound shard image");
  const shards = [];
  for (const lane of ["source", "documents"]) {
    let current = [];
    let bytes = 0;
    const flush = () => {
      if (!current.length) return;
      const paths = new Set(current.map(s => s.binding.path));
      const shardImages = artifacts.filter(a => paths.has(a.path));
      const shardId = `shard-${String(shards.length).padStart(3, "0")}`;
      shards.push({ shardId, lane, executionId: `${binding.executionId}.${shardId}`,
        streams: current, images: shardImages, bytes, subsetDigest: shardDigest({ streams: current, images: shardImages }) });
      current = []; bytes = 0;
    };
    for (const stream of universe.filter(s => documentOnlyPath(s.binding.path) === (lane === "documents"))) {
      const size = stream.binding.bytes + artifacts.filter(a => a.path === stream.binding.path).reduce((n, a) => n + a.bytes, 0);
      assert(size <= policy.maxShardBytes, `Single path exceeds shard budget: ${stream.binding.path}`);
      if (current.length && (bytes + size > policy.targetBytes || binding.reviewMode === "full-snapshot-v1" && current.length >= 64)) flush();
      current.push(stream); bytes += size;
    }
    flush();
  }
  assert(shards.length <= policy.maxShards && shards.length + 1 <= policy.executionBudget,
    "Shard execution budget exceeded");
  const crossStreams = universe.filter(s => !documentOnlyPath(s.binding.path));
  return { protocol: SHARD_PROTOCOL, binding, parentIndexSha256, policy, universeDigest: shardDigest(universe),
    imageDigest: shardDigest(artifacts), shards,
    cross: { executionId: `${binding.executionId}.cross`, streamIds: crossStreams.map(s => s.id) },
    expectedPaths: universe.length, plannedExecutions: shards.length + 1 };
}

export function validateShardPlan(plan, expected) {
  assert.deepEqual(plan, createShardPlan(expected), "Shard plan differs from the frozen parent universe or policy");
  return shardDigest(plan);
}

export function validateSemanticSummary(summary, allowedPaths) {
  exact(summary, ["reviewedAreas", "interfaces", "risks"], "semantic summary");
  assert(Array.isArray(summary.reviewedAreas) && summary.reviewedAreas.length > 0 && summary.reviewedAreas.length <= 32);
  assert(Array.isArray(summary.risks) && summary.risks.length <= 32);
  for (const text of [...summary.reviewedAreas, ...summary.risks]) {
    assert(typeof text === "string" && text.trim() && text.length <= 2048, "Invalid semantic summary text");
  }
  assert(Array.isArray(summary.interfaces) && summary.interfaces.length <= 64);
  for (const item of summary.interfaces) {
    exact(item, ["path", "contract", "dependencies"], "semantic interface");
    assert(allowedPaths.includes(item.path), "Semantic interface outside shard");
    assert(typeof item.contract === "string" && item.contract.trim() && item.contract.length <= 2048);
    assert(Array.isArray(item.dependencies) && item.dependencies.length <= 32 && item.dependencies.every(
      p => typeof p === "string" && p.length <= 512 && !p.startsWith("/") && !p.split("/").includes("..")));
  }
  assert(Buffer.byteLength(JSON.stringify(summary)) <= 48 * 1024, "Semantic summary exceeds budget");
  return summary;
}

export function crossReviewStreams(plan, streams, records) {
  const byId = new Map(streams.map(s => [s.id, s]));
  const selected = plan.cross.streamIds.map(id => {
    assert(byId.has(id), "Cross-module source stream is missing");
    return byId.get(id);
  });
  for (const [i, record] of records.entries()) {
    const bytes = Buffer.from(JSON.stringify({ protocol: SHARD_PROTOCOL, planDigest: shardDigest(plan),
      recordDigest: shardDigest(record), record }));
    const id = `s${String(streams.length + i).padStart(6, "0")}`;
    assert(!byId.has(id), "Cross-module report stream identity collides");
    selected.push({ id, binding: { ...streams[0].binding, path: `__bw_review_reports__/${record.shardId}.json`,
      sha256: contentDigest(bytes), bytes: bytes.length }, bytes });
  }
  return selected;
}

export function assertStreamCoverage(coverage, expected) {
  assert(coverage?.complete === true && coverage.records?.length === expected.length, "Incomplete stream coverage");
  for (const stream of expected) {
    const observed = coverage.records.filter(r => r.streamId === stream.id);
    assert(observed.length === 1 && observed[0].path === stream.binding.path &&
      observed[0].sha256 === stream.binding.sha256 && observed[0].observedBytes === stream.binding.bytes &&
      observed[0].complete && observed[0].eofObserved && observed[0].acknowledged, "Unverified shard stream");
  }
}

// Pure projection of records already verified from their raw transcripts by
// verifyShardExecution. Formal admission must use the receipt replay verifier;
// neither this function nor model-authored path counts create review authority.
export function aggregateShardReviews(plan, records, cross) {
  const planDigest = shardDigest(plan);
  assert.equal(records.length, plan.shards.length, "Missing shard result");
  const ids = new Set(), executions = new Set(), paths = new Set();
  const findings = [];
  for (let i = 0; i < plan.shards.length; i++) {
    const expected = plan.shards[i], record = records[i];
    assert.equal(record.shardId, expected.shardId, "Shard result order or identity mismatch");
    assert(!ids.has(record.shardId) && !executions.has(record.executionId), "Duplicate shard result");
    ids.add(record.shardId); executions.add(record.executionId);
    assert.equal(record.planDigest, planDigest, "Cross-package shard receipt");
    assert.equal(record.executionId, expected.executionId, "Shard execution mismatch");
    assert.equal(record.subsetDigest, expected.subsetDigest, "Shard subset changed");
    assertStreamCoverage(record.coverage, expected.streams);
    assert.equal(record.imageDigest, shardDigest(expected.images), "Shard image coverage differs from plan");
    for (const stream of expected.streams) {
      assert(!paths.has(stream.binding.path), "Overlapping shard coverage"); paths.add(stream.binding.path);
    }
    validateSemanticSummary(record.summary, expected.streams.map(s => s.binding.path));
    assert(["PASS", "BLOCK"].includes(record.result.verdict), "Invalid shard verdict");
    assert(record.result.verdict !== "PASS" || record.result.findings.length === 0, "Contradictory shard PASS");
    findings.push(...record.result.findings);
  }
  assert(paths.size === plan.expectedPaths, "Incomplete parent manifest union");
  assert(cross && cross.planDigest === planDigest && cross.executionId === plan.cross.executionId &&
    !executions.has(cross.executionId), "Missing independent cross-module review");
  assert.deepEqual(cross.shardReceiptDigests, records.map(shardDigest), "Cross-module review ignored shard receipts");
  // Restore parent order before assigning synthetic report IDs.
  const universe = plan.shards.flatMap(s => s.streams).sort((a, b) => a.id.localeCompare(b.id));
  assertStreamCoverage(cross.coverage, crossReviewStreams(plan, universe, records));
  const crossPaths = new Set(universe.filter(s => plan.cross.streamIds.includes(s.id)).map(s => s.binding.path));
  const crossImages = plan.shards.flatMap(s => s.images).filter(i => crossPaths.has(i.path));
  assert.equal(cross.imageDigest, shardDigest(crossImages), "Cross-module image coverage differs from plan");
  validateSemanticSummary(cross.summary, [...paths]);
  assert(["PASS", "BLOCK"].includes(cross.result.verdict), "Invalid cross-module verdict");
  assert(cross.result.verdict !== "PASS" || cross.result.findings.length === 0, "Contradictory cross-module PASS");
  findings.push(...cross.result.findings);
  return { schemaVersion: 1, verdict: findings.length ? "BLOCK" : "PASS",
    scopeCoverage: { base: plan.binding.base, head: plan.binding.head, manifestPathCount: paths.size,
      reviewedPathCount: paths.size, complete: true }, findings };
}

export async function runShardPool(items, { concurrency, timeoutMs, signal }, worker) {
  assert(Number.isSafeInteger(concurrency) && concurrency > 0 && concurrency <= 3);
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  const controller = new AbortController();
  let failure = null, next = 0;
  const stop = reason => { failure ??= reason instanceof Error ? reason : new Error("Shard review cancelled"); controller.abort(failure); };
  const aborted = () => stop(signal.reason);
  if (signal?.aborted) aborted(); else signal?.addEventListener("abort", aborted, { once: true });
  const timer = setTimeout(() => stop(new Error("Shard review total deadline exceeded")), timeoutMs);
  const output = new Array(items.length);
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!controller.signal.aborted && next < items.length) {
        const i = next++;
        try { output[i] = await worker(items[i], i, controller.signal); }
        catch (error) { stop(error); }
      }
    }));
    if (failure) throw failure;
    return output;
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", aborted);
  }
}
