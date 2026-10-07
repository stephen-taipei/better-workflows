// SPDX-License-Identifier: AGPL-3.0-only
import { lstat } from "node:fs/promises";
import path from "node:path";

import { digestObject, loadRun, sha256 } from "./core.mjs";
import { runSourceGit } from "./git.mjs";
import { assertReviewContinuity, reviewPackageDigest, reviewStatus } from "./review.mjs";
import { captureNativeReviewSnapshotIdentityV1, inspectNativeReviewSnapshotSubjectV1,
  validateShardedReviewReceipt, NATIVE_REVIEW_FULL_SNAPSHOT_MODE_V1 } from "./native-review-runner.mjs";
import { verifyTrustedNativeCriticAttestation } from "./providers.mjs";
import { assertRootOwnedRuntimePathV2, readBoundedRuntimeFileV2, observeRuntimeSourceTreeV2 } from "./runtime-qualification-v2.mjs";
import { assertInstalledRcPublicationContextV1, assertInstalledRcPublicationContextCurrentV1,
  readInstalledRcAdapterConfigRecordV1 } from "./rc-publication-installed-context-v1.mjs";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONFIG_KIND = "RcPublicationReviewDocumentsConfigV1";
const INVENTORY_PATH = "plugins/better-workflows/config/maintained-doc-inventory-v1.json";
const SCOPE_PATH = "plugins/better-workflows/config/product-release-scope-v1.json";
const ORIGINAL_SOURCES = ["docs/plans/v5-r4.md", "docs/plans/v5-r4-execution.md"];
// The existing maintained inventory's frozen denominator, not a new completion catalog.
const DOCUMENT_COUNT = 686;
const DOCUMENT_PATH_DIGEST = "6448b9ab0597691fcf16becf845285d23b957fed849a48937205dc60d6a4a376";
const NON_DOCUMENT_PATHS = [".gitignore", "COPYRIGHT", "LICENSE", "packages/better-workflows-wire/LICENSE", "packages/better-workflows-wire/NOTICE", "website/healthz"];
const INSTRUCTION_MARKER = "BW_RC_REVIEW_DOCS_CONTRACT_V1\n";
const DISPOSITION_MARKER = "BW_RC_DISPOSITIONS_V1 ";
const results = new WeakMap();

function hold(code, message) { throw Object.assign(new Error(message), { code, status: "HOLD" }); }
function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || digestObject(Object.keys(value).sort()) !== digestObject([...keys].sort())) hold("ERC_REVIEW_SCHEMA", `Unbound ${label} fields`);
}
function text(value, label, max = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r]/.test(value)) hold("ERC_REVIEW_SCHEMA", `Invalid ${label}`);
  return value;
}
function digest(value, label) { if (!DIGEST.test(value ?? "")) hold("ERC_REVIEW_SCHEMA", `Invalid ${label} digest`); return value; }
function id(value, label) { if (!ID.test(value ?? "")) hold("ERC_REVIEW_SCHEMA", `Invalid ${label} id`); return value; }
function relative(value, label) {
  text(value, label, 1024);
  if (path.isAbsolute(value) || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value) || value.split("/").some(part => ["", ".", ".."].includes(part))) hold("ERC_REVIEW_PATH", `Unsafe ${label}`);
  return value;
}
function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || /[\0\r\n]/.test(value)) hold("ERC_REVIEW_PATH", `Unsafe ${label}`);
  return value;
}
function within(root, file) { return file.startsWith(`${root}${path.sep}`) && path.resolve(file) === file; }
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function equal(actual, expected, label) { if (digestObject(actual) !== digestObject(expected)) hold("ERC_REVIEW_BINDING", `${label} changed`); }
function reference(value, label) { exact(value, ["path", "sha256"], label); absolute(value.path, label); digest(value.sha256, label); }
function sourceReference(value, label) {
  exact(value, ["id", "path", "sha256", "quote", "quoteSha256"], label);
  id(value.id, label); relative(value.path, label); digest(value.sha256, label); digest(value.quoteSha256, label);
  text(value.quote, `${label} quote`, 64 * 1024);
  if (sha256(Buffer.from(value.quote, "utf8")) !== value.quoteSha256) hold("ERC_REVIEW_REFERENCE", `${label} quote hash is inconsistent`);
}
function sortedUnique(values, label) {
  if (!Array.isArray(values) || values.length > 128 || values.some(value => !ID.test(value ?? "")) || new Set(values).size !== values.length) hold("ERC_REVIEW_SCHEMA", `Invalid ${label}`);
  equal(values, [...values].sort(), label); return values;
}

/** Pure data inspection; it confers no context, attestation or publication authority. */
export function inspectRcReviewDocumentsConfigV1(input) {
  const value = structuredClone(input);
  exact(value, ["schemaVersion", "kind", "operationId", "bindingDigest", "publicCandidateSha", "publicTreeOid", "fullUniverseDigest", "runId", "packageId", "packageDigest", "continuityDigest", "runContractSha256", "instructionSha256", "semanticLaneId", "lanes", "acceptedCoverage", "documents"], "fixed review/doc config");
  if (value.schemaVersion !== 1 || value.kind !== CONFIG_KIND || !SHA.test(value.publicCandidateSha ?? "") || !SHA.test(value.publicTreeOid ?? "")) hold("ERC_REVIEW_SCHEMA", "Fixed review/doc config identity is invalid");
  id(value.operationId, "operation"); id(value.runId, "run"); id(value.packageId, "package"); id(value.semanticLaneId, "semantic lane");
  for (const key of ["bindingDigest", "fullUniverseDigest", "packageDigest", "continuityDigest", "runContractSha256", "instructionSha256"]) digest(value[key], key);
  if (!Array.isArray(value.lanes) || value.lanes.length < 2 || value.lanes.length > 5) hold("ERC_REVIEW_LANES", "The existing review kernel's required lanes are missing");
  for (const lane of value.lanes) {
    exact(lane, ["axisId", "reviewerId", "model", "executionId", "receipt", "attestation", "axisAttestation"], "native review lane");
    for (const key of ["axisId", "reviewerId", "model", "executionId"]) id(lane[key], key);
    for (const key of ["receipt", "attestation", "axisAttestation"]) reference(lane[key], key);
  }
  for (const key of ["axisId", "reviewerId", "executionId"]) if (new Set(value.lanes.map(lane => lane[key])).size !== value.lanes.length) hold("ERC_REVIEW_INDEPENDENCE", `Reused ${key}`);
  if (!value.lanes.some(lane => lane.axisId === value.semanticLaneId)) hold("ERC_REVIEW_LANES", "Semantic lane is not a required independently executed lane");
  if (value.acceptedCoverage !== null) {
    const coverage = value.acceptedCoverage;
    exact(coverage, ["privateSourceSha", "sources", "scopeReferences", "rows", "rowsDigest"], "existing accepted-coverage reference");
    if (!SHA.test(coverage.privateSourceSha ?? "")) hold("ERC_REVIEW_REFERENCE", "Coverage private source is missing");
    if (!Array.isArray(coverage.sources) || coverage.sources.length !== 2) hold("ERC_REVIEW_REFERENCE", "Both original V5 r4 sources are required");
    equal(coverage.sources.map(source => source.path).sort(), [...ORIGINAL_SOURCES].sort(), "original requirement sources");
    for (const source of coverage.sources) { exact(source, ["path", "sha256"], "original source"); digest(source.sha256, "original source"); }
    if (!Array.isArray(coverage.scopeReferences) || coverage.scopeReferences.length < 1 || coverage.scopeReferences.length > 64) hold("ERC_ADOPTED_SCOPE_REQUIRED", "Exact owner-adopted scope citations are missing");
    for (const ref of coverage.scopeReferences) sourceReference(ref, "owner-adopted scope reference");
    const refIds = new Set(coverage.scopeReferences.map(ref => ref.id));
    if (refIds.size !== coverage.scopeReferences.length || !["original-denominator", "product-scope", "auto-only", "platform-deferral", "host-deferral", "rc-first"].every(key => refIds.has(key))) hold("ERC_ADOPTED_SCOPE_REQUIRED", "Original denominator, current Auto/macOS scope, deferrals and RC-first citations are required");
    if (!Array.isArray(coverage.rows) || coverage.rows.length !== 46) hold("ERC_COVERAGE_DENOMINATOR", "All 46 original rows must remain in the denominator");
    equal(coverage.rows.map(row => row.id).sort((a, b) => Number(a) - Number(b)), Array.from({ length: 46 }, (_, i) => String(i + 1)), "original 46-row denominator");
    for (const row of coverage.rows) {
      exact(row, ["id", "quote", "quoteSha256", "scopeReferenceIds"], "original requirement row");
      text(row.quote, "original requirement row quote", 64 * 1024); digest(row.quoteSha256, "original row quote");
      if (sha256(Buffer.from(row.quote)) !== row.quoteSha256) hold("ERC_REVIEW_REFERENCE", "Original row quote hash changed");
      sortedUnique(row.scopeReferenceIds, "row scope references");
      if (row.scopeReferenceIds.some(key => !refIds.has(key))) hold("ERC_REVIEW_REFERENCE", "Row uses an unknown scope citation");
    }
    digest(coverage.rowsDigest, "original rows"); equal(coverage.rowsDigest, digestObject(coverage.rows), "original rows digest");
  }
  if (value.documents !== null) {
    exact(value.documents, ["inventoryPath", "inventorySha256", "inventoryRevision"], "maintained document reference");
    if (value.documents.inventoryPath !== INVENTORY_PATH) hold("ERC_DOCUMENT_INVENTORY", "Only the existing maintained inventory is supported");
    digest(value.documents.inventorySha256, "maintained inventory"); text(value.documents.inventoryRevision, "inventory revision", 128);
  }
  return freeze(value);
}

/** The actual native instruction must begin with these bytes. No signer is exposed. */
export function rcReviewDocumentsInstructionContractV1(input) {
  const value = inspectRcReviewDocumentsConfigV1(input);
  return freeze({ schemaVersion: 1, kind: "RcPublicationSemanticReviewContractV1", operationId: value.operationId,
    bindingDigest: value.bindingDigest, publicCandidateSha: value.publicCandidateSha, publicTreeOid: value.publicTreeOid,
    reviewMode: NATIVE_REVIEW_FULL_SNAPSHOT_MODE_V1, fullUniverseDigest: value.fullUniverseDigest,
    trackingOnlyRows: ["1", "2"],
    acceptedCoverage: value.acceptedCoverage, documents: value.documents });
}

function physicalIdentity(info) { return { dev: String(info.dev), ino: String(info.ino), uid: String(info.uid), mode: String(info.mode), size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) }; }
async function protectedRecord(file, maximum, expectedSha256 = null) {
  await assertRootOwnedRuntimePathV2(file);
  const before = physicalIdentity(await lstat(file, { bigint: true }));
  const bytes = await readBoundedRuntimeFileV2(file, maximum);
  const after = physicalIdentity(await lstat(file, { bigint: true }));
  equal(before, after, "protected evidence file identity");
  const actual = sha256(bytes);
  if (expectedSha256 !== null && actual !== expectedSha256) hold("ERC_REVIEW_BYTES", "Protected raw evidence bytes changed");
  return { path: file, bytes, sha256: actual, identity: after };
}
async function evidenceRecord(ref, root, maximum = 128 * 1024 * 1024) {
  if (!within(root, ref.path)) hold("ERC_REVIEW_PATH", "Review artifact is outside the fixed operation evidence namespace");
  return protectedRecord(ref.path, maximum, ref.sha256);
}
function strictUtf8(bytes, label) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { hold("ERC_REVIEW_UTF8", `${label} is not strict UTF-8`); }
}
async function committedFile(repository, revision, relativePath, expectedSha256 = null, maximum = 8 * 1024 * 1024) {
  relative(relativePath, "committed file");
  const bytes = (await runSourceGit(repository, ["cat-file", "blob", `${revision}:${relativePath}`], { encoding: "buffer", maxBuffer: maximum })).stdout;
  if (!Buffer.isBuffer(bytes) || bytes.length > maximum || expectedSha256 !== null && sha256(bytes) !== expectedSha256) hold("ERC_REVIEW_SOURCE", "Committed reference bytes changed");
  return bytes;
}
async function observePublicSnapshot(ctx, config) {
  const snapshot = await captureNativeReviewSnapshotIdentityV1(ctx.candidate.publicRoot, ctx.candidate.publicCandidateSha);
  for (const key of ["publicCandidateSha", "publicTreeOid"]) if (config[key] !== ctx.candidate[key]) hold("ERC_REVIEW_BINDING", "Review config belongs to another public projection");
  if (snapshot.snapshotTreeOid !== config.publicTreeOid || snapshot.fullUniverseDigest !== config.fullUniverseDigest) hold("ERC_REVIEW_UNIVERSE", "Actual entire public snapshot changed");
  const observation = await observeRuntimeSourceTreeV2({ sourceRoot: ctx.candidate.publicRoot,
    treeRecords: snapshot.records.map(record => ({ mode: record.mode, type: record.type, sha: record.oid, path: record.path })) });
  return { snapshot, observation };
}
async function validateReferencedSources(ctx, config) {
  const coverage = config.acceptedCoverage;
  if (!coverage) hold("ERC_ADOPTED_COVERAGE_REQUIRED", "The original 46-row adopted coverage and exact scope citations have not been installed");
  if (coverage.privateSourceSha !== ctx.candidate.privateSourceSha) hold("ERC_REVIEW_REFERENCE", "Coverage is bound to another private-to-public projection");
  const sourceBytes = new Map();
  for (const ref of coverage.sources) sourceBytes.set(ref.path, await committedFile(ctx.candidate.privateRoot, coverage.privateSourceSha, ref.path, ref.sha256));
  const originalRows = readOriginalRcRequirementRowsV1(sourceBytes.get(ORIGINAL_SOURCES[1]));
  for (const row of coverage.rows) if (row.quote !== originalRows.get(row.id)) hold("ERC_COVERAGE_DENOMINATOR", "Original matrix row was replaced by local evidence or a draft catalog");
  for (const ref of coverage.scopeReferences) {
    const bytes = sourceBytes.get(ref.path) ?? await committedFile(ctx.candidate.privateRoot, coverage.privateSourceSha, ref.path, ref.sha256);
    if (sha256(bytes) !== ref.sha256 || !strictUtf8(bytes, "scope citation").includes(ref.quote)) hold("ERC_REVIEW_REFERENCE", "Adopted scope citation is absent from the exact private source");
  }
  const scope = JSON.parse(strictUtf8(await committedFile(ctx.candidate.publicRoot, ctx.candidate.publicCandidateSha, SCOPE_PATH), "product scope"));
  if (scope.id !== "v5.0-rc2-macos-auto-41-locales-20261007-r1" || digestObject(scope) !== ctx.binding.productReleaseScopeDigest) hold("ERC_REVIEW_SCOPE", "The actual public Auto/macOS product scope changed");
  return coverage;
}

/** Reads the original numbered requirement tables only, stopping at original row 46. */
export function readOriginalRcRequirementRowsV1(bytes) {
  const lines = strictUtf8(bytes, "original execution matrix").split("\n");
  const first = lines.findIndex(line => line === "| # | 要求 | Owner | Evidence | Negative case | Rollback | Status |");
  if (first < 0) hold("ERC_COVERAGE_DENOMINATOR", "Original requirement matrix header is absent");
  const rows = new Map();
  for (const line of lines.slice(first + 1)) {
    const match = line.match(/^\|\s*([1-9][0-9]*)\s*\|/);
    if (!match) continue;
    const idValue = match[1];
    if (Number(idValue) > 46 || rows.has(idValue)) hold("ERC_COVERAGE_DENOMINATOR", "Original matrix has duplicate or unexpected numbered rows");
    rows.set(idValue, line);
    if (idValue === "46") break;
  }
  equal([...rows.keys()].sort((a, b) => Number(a) - Number(b)), Array.from({ length: 46 }, (_, i) => String(i + 1)), "original requirement matrix");
  return rows;
}

async function assertPinnedReplayArtifacts(receipt, reviewRoot) {
  // These are existing replay artifacts, not a generic executable/path endpoint.
  const refs = [receipt.verification?.planPath, receipt.binding?.resultPath,
    ...Object.values(receipt.verification?.inputs ?? {}).map(ref => ref.path),
    ...receipt.executionArtifacts.flatMap(ref => [ref.receiptPath, ref.jobPath, ref.resultPath, ref.tracePath])];
  const content = receipt.verification?.content;
  refs.push(content?.indexPath, ...(content?.streams ?? []).map(ref => ref.file), ...(content?.images ?? []).map(ref => ref.file));
  for (const file of new Set(refs)) {
    absolute(file, "actual replay artifact");
    if (!within(reviewRoot, file)) hold("ERC_REVIEW_PATH", "Native replay refers outside the fixed protected review namespace");
    await assertRootOwnedRuntimePathV2(file);
  }
  const pinContent = async (contentValue, images = []) => {
    const index = await evidenceRecord({ path: contentValue.indexPath, sha256: contentValue.indexSha256 }, reviewRoot, 8 * 1024 * 1024);
    const value = JSON.parse(strictUtf8(index.bytes, "actual native content index"));
    if (!Array.isArray(value.streams)) hold("ERC_REVIEW_REPLAY", "Actual native content index has no streams");
    for (const stream of value.streams) {
      const file = path.join(path.dirname(index.path), relative(stream.file, "actual native stream file"));
      if (!within(reviewRoot, file)) hold("ERC_REVIEW_PATH", "Actual native content escaped the protected review namespace");
      await assertRootOwnedRuntimePathV2(file);
    }
    for (const image of images) {
      if (!within(reviewRoot, absolute(image.file, "actual native image"))) hold("ERC_REVIEW_PATH", "Actual native image escaped the protected review namespace");
      await assertRootOwnedRuntimePathV2(image.file);
    }
  };
  await pinContent(content, content.images);
  for (const artifact of receipt.executionArtifacts) {
    const jobRecord = await evidenceRecord({ path: artifact.jobPath, sha256: artifact.jobSha256 }, reviewRoot, 8 * 1024 * 1024);
    const job = JSON.parse(strictUtf8(jobRecord.bytes, "actual native execution job"));
    await pinContent(job.content, job.images); await pinContent(job.context);
  }
}
function axisIdentity(axis) {
  return Object.fromEntries(["schemaVersion", "packageId", "axisId", "repairRound", "executionId", "reviewerId", "role", "contextProfile", "contextDigest", "inputDigest", "toolPolicyDigest", "verdict", "unitResults", "findings"].map(key => [key, axis[key]]));
}
async function verifyLane(ctx, config, lane, reviewPackage, kernel, reviewRoot, subject, contractBytes) {
  const record = await evidenceRecord(lane.receipt, reviewRoot);
  const receipt = JSON.parse(strictUtf8(record.bytes, "native aggregate receipt"));
  if (!Array.isArray(receipt.executionArtifacts)) hold("ERC_REVIEW_REPLAY", "Actual native execution artifacts are missing");
  await assertPinnedReplayArtifacts(receipt, reviewRoot);
  const replay = await validateShardedReviewReceipt(lane.receipt.path, { reviewPackage,
    binding: { runId: config.runId, repository: ctx.candidate.publicRoot, packageId: config.packageId,
      base: subject.base, head: subject.head, reviewerId: lane.reviewerId, model: lane.model, executionId: lane.executionId,
      reviewMode: subject.reviewMode, snapshotTreeOid: subject.snapshotTreeOid, fullUniverseDigest: subject.fullUniverseDigest,
      instructionSha256: config.instructionSha256 } });
  if (replay.receiptSha256 !== record.sha256 || replay.review.verdict !== "PASS" || replay.review.findings.length ||
      !replay.review.scopeCoverage.complete || replay.review.scopeCoverage.reviewedPathCount !== reviewPackage.workUniverse.length) hold("ERC_REVIEW_REPLAY", "Full public snapshot independent review did not qualify");
  const instructionPath = replay.receipt.verification.inputs.instruction.path;
  const instruction = await protectedRecord(instructionPath, 8 * 1024 * 1024, config.instructionSha256);
  const prefix = Buffer.concat([Buffer.from(INSTRUCTION_MARKER), contractBytes, Buffer.from("\n\n")]);
  if (!instruction.bytes.subarray(0, prefix.length).equals(prefix)) hold("ERC_REVIEW_CONTRACT", "Actual signed native instruction omits the exact RC source/coverage/doc contract");
  const attestation = await verifyTrustedNativeCriticAttestation({ attestationPath: lane.attestation.path,
    expectedFileDigest: lane.attestation.sha256, workspaceRoot: ctx.candidate.publicRoot,
    binding: replay.signerBinding, requireFixedHostRoot: true });
  const finished = Date.parse(replay.receipt.finishedAt);
  if (!Number.isFinite(finished) || Date.parse(attestation.issuedAt) < finished || finished > Date.now()) hold("ERC_REVIEW_FRESHNESS", "Host signature predates the actual complete native execution");
  const axes = kernel.axes.filter(axis => axis.axisId === lane.axisId);
  if (axes.length !== 1) hold("ERC_REVIEW_KERNEL", "Required native lane has no unique current kernel axis");
  const axis = axes[0];
  if (axis.executionId !== lane.executionId || axis.reviewerId !== lane.reviewerId || axis.providerExecution.model !== lane.model ||
      axis.inputDigest !== config.instructionSha256 || axis.verdict !== "PASS" || axis.findings.length) hold("ERC_REVIEW_KERNEL", "Kernel axis is not the independently observed native snapshot execution");
  const expectedUnits = reviewPackage.workUniverse.map(unit => ({ unitId: unit.id, disposition: "reviewed-no-issue", findingIds: [] })).sort((a, b) => a.unitId.localeCompare(b.unitId));
  equal(axis.unitResults, expectedUnits, "actual complete zero-finding native review-to-kernel mapping");
  const axisAttestation = await verifyTrustedNativeCriticAttestation({ attestationPath: lane.axisAttestation.path,
    expectedFileDigest: lane.axisAttestation.sha256, workspaceRoot: ctx.candidate.publicRoot,
    binding: { ...replay.signerBinding, reviewDigest: digestObject(axisIdentity(axis)) }, requireFixedHostRoot: true });
  if (axisAttestation.attestationDigest !== axis.providerExecution.attestationDigest || Date.parse(axisAttestation.issuedAt) < finished) hold("ERC_REVIEW_KERNEL", "Kernel provider flag is not backed by its actual current host signature");
  return { axisId: lane.axisId, replay, observation: { axisId: lane.axisId, executionId: lane.executionId,
    aggregateSha256: record.sha256, aggregateIdentity: record.identity,
    nativeReviewDigest: digestObject(replay.review), attestationFileDigest: attestation.fileDigest,
    attestationDigest: attestation.attestationDigest, trustRootDigest: attestation.trustRootDigest,
    axisAttestationFileDigest: axisAttestation.fileDigest, axisAttestationDigest: axisAttestation.attestationDigest,
    axisDigest: axis.axisDigest } };
}

function semanticDispositions(replay, contractDigest) {
  const publicPaths = new Set(replay.plan.shards.flatMap(shard => shard.streams.map(item => item.binding.path)));
  const documents = new Map(), coverage = new Map();
  // Only the observed per-shard native final messages count. A cross report or
  // a caller-supplied disposition file cannot replace independent per-path review.
  for (const shard of replay.receipt.shards) {
    const paths = new Set(replay.plan.shards.find(item => item.shardId === shard.shardId)?.streams.map(item => item.binding.path));
    for (const item of shard.summary.interfaces) {
      if (!item.contract.startsWith(DISPOSITION_MARKER)) continue;
      let batch;
      try { batch = JSON.parse(item.contract.slice(DISPOSITION_MARKER.length)); } catch { hold("ERC_REVIEW_SEMANTICS", "Actual native semantic disposition JSON is malformed"); }
      exact(batch, ["contractDigest", "documents", "coverage"], "actual native semantic disposition batch");
      if (batch.contractDigest !== contractDigest || !Array.isArray(batch.documents) || !Array.isArray(batch.coverage)) hold("ERC_REVIEW_SEMANTICS", "Actual native semantic conclusion uses another signed review contract");
      for (const doc of batch.documents) {
        exact(doc, ["path", "recordDigest", "publicPath", "contentSha256", "sourceBindingsDigest", "disposition", "localeParity", "reason", "scopeReferenceIds"], "actual native maintained-doc disposition");
        relative(doc.path, "reviewed document"); digest(doc.recordDigest, "document inventory row"); digest(doc.sourceBindingsDigest, "document source bindings");
        if (doc.publicPath !== null) { relative(doc.publicPath, "public document"); digest(doc.contentSha256, "public document content"); if (!paths.has(doc.publicPath) || item.path !== doc.publicPath) hold("ERC_REVIEW_SEMANTICS", "Document conclusion is not from its actual independent source shard"); }
        else if (doc.contentSha256 !== null || ![INVENTORY_PATH, SCOPE_PATH].includes(item.path)) hold("ERC_REVIEW_SEMANTICS", "Absent public document must be explicitly reviewed through retained inventory/scope metadata");
        if (!["verified-current", "not-applicable", "excluded-from-public-projection"].includes(doc.disposition) || !["semantically-verified", "not-applicable"].includes(doc.localeParity)) hold("ERC_DOCUMENT_SEMANTICS", "Pending/deferred/fallback parity is not verified document semantics");
        text(doc.reason, "document semantic reason", 1000); sortedUnique(doc.scopeReferenceIds, "document scope references");
        if (documents.has(doc.path)) hold("ERC_DOCUMENT_DENOMINATOR", "Duplicate actual document semantic conclusion"); documents.set(doc.path, doc);
      }
      for (const row of batch.coverage) {
        exact(row, ["id", "quoteSha256", "disposition", "reason", "scopeReferenceIds", "reviewedPaths"], "actual native original-row disposition");
        const trackingOnly = row.id === "1" || row.id === "2";
        const acceptedDispositions = ["covered-current-source", "deferred-by-owner", "not-applicable"];
        if (!/^(?:[1-9]|[1-3][0-9]|4[0-6])$/.test(row.id ?? "") ||
            (trackingOnly ? row.disposition !== "tracking-only" : !acceptedDispositions.includes(row.disposition))) {
          hold("ERC_COVERAGE_SEMANTICS", "Original rows 1-2 must remain tracking-only; other original requirements need a genuine scope disposition");
        }
        digest(row.quoteSha256, "reviewed original quote"); text(row.reason, "original requirement semantic reason", 1000); sortedUnique(row.scopeReferenceIds, "requirement scope references");
        if (!Array.isArray(row.reviewedPaths) || row.reviewedPaths.length < 1 || row.reviewedPaths.length > 32 || new Set(row.reviewedPaths).size !== row.reviewedPaths.length || row.reviewedPaths.some(file => !publicPaths.has(relative(file, "reviewed requirement source"))) || !row.reviewedPaths.includes(item.path)) hold("ERC_COVERAGE_SEMANTICS", "Original requirement conclusion lacks observed exact-public source paths");
        if (coverage.has(row.id)) hold("ERC_COVERAGE_DENOMINATOR", "Duplicate actual original-row conclusion"); coverage.set(row.id, row);
      }
    }
  }
  return { documents, coverage };
}

async function verifyDocumentSemantics(ctx, config, source, semantic) {
  if (!config.documents) hold("ERC_DOCUMENT_DISPOSITIONS_REQUIRED", "Current maintained inventory and per-document semantic review have not been installed");
  const bytes = await committedFile(ctx.candidate.privateRoot, ctx.candidate.privateSourceSha, INVENTORY_PATH, config.documents.inventorySha256);
  const inventory = JSON.parse(strictUtf8(bytes, "maintained inventory"));
  if (inventory.schemaVersion !== 1 || inventory.inventoryRevision !== config.documents.inventoryRevision || !Array.isArray(inventory.records) || !Array.isArray(inventory.nonDocumentRecords)) hold("ERC_DOCUMENT_INVENTORY", "Actual maintained inventory identity changed");
  const paths = inventory.records.map(row => relative(row.path, "maintained inventory document")).sort((a, b) => a.localeCompare(b, "en"));
  if (paths.length !== DOCUMENT_COUNT || new Set(paths).size !== DOCUMENT_COUNT || sha256(`${paths.join("\n")}\n`) !== DOCUMENT_PATH_DIGEST ||
      inventory.denominator?.documents?.count !== DOCUMENT_COUNT || inventory.denominator.documents.pathDigest !== DOCUMENT_PATH_DIGEST) hold("ERC_DOCUMENT_DENOMINATOR", "Frozen maintained-document denominator was changed");
  equal(inventory.nonDocumentRecords.map(row => row.path).sort(), [...NON_DOCUMENT_PATHS].sort(), "six separate maintained non-document records");
  const records = [...inventory.records, ...inventory.nonDocumentRecords];
  equal([...semantic.documents.keys()].sort(), records.map(row => row.path).sort(), "complete maintained document/non-document dispositions");
  const sourceFiles = new Map(source.observation.files.map(file => [file.path, file]));
  if (sourceFiles.has(INVENTORY_PATH) && sourceFiles.get(INVENTORY_PATH).sha256 !== config.documents.inventorySha256) hold("ERC_DOCUMENT_INVENTORY", "Retained public inventory differs from the preserved original denominator");
  for (const actual of sourceFiles.keys()) if (/\.(md|html)$/.test(actual) && !paths.includes(actual)) hold("ERC_DOCUMENT_DENOMINATOR", "Actual public source contains an unaccounted maintained document");
  const referenceIds = new Set(config.acceptedCoverage.scopeReferences.map(ref => ref.id));
  for (const record of records) {
    const actual = semantic.documents.get(record.path), file = sourceFiles.get(record.path);
    if (actual.recordDigest !== digestObject(record) || actual.publicPath !== (file ? record.path : null) || actual.contentSha256 !== (file ? file.sha256 : null)) hold("ERC_DOCUMENT_BINDING", "Actual native document conclusion uses another inventory row/public file");
    if (actual.scopeReferenceIds.some(key => !referenceIds.has(key))) hold("ERC_DOCUMENT_BINDING", "Document uses an unknown adopted scope citation");
    const sourceBindings = [];
    for (const filePath of record.sourcePaths) {
      relative(filePath, "maintained document source");
      const projected = sourceFiles.get(filePath);
      const sourceSha256 = projected?.sha256 ?? sha256(await committedFile(ctx.candidate.privateRoot, ctx.candidate.privateSourceSha, filePath));
      sourceBindings.push({ path: filePath, location: projected ? "public" : "private-excluded", sha256: sourceSha256 });
    }
    equal(actual.sourceBindingsDigest, digestObject(sourceBindings), "document's actual generator/source binding");
    if (record.sourceDigest !== undefined && record.sourceDigest !== null && record.sourceDigest !== sourceBindings[0]?.sha256) hold("ERC_DOCUMENT_BINDING", "Existing inventory generator source digest is stale");
    if (!file) {
      if (actual.disposition !== "excluded-from-public-projection" || actual.localeParity !== "not-applicable" || actual.scopeReferenceIds.length === 0 ||
          !["excluded", "not-claimed", "not-product-surface"].includes(record.publicClaimStatus)) hold("ERC_DOCUMENT_SEMANTICS", "Removed product document has no actual adopted exclusion disposition");
    } else if (actual.disposition === "not-applicable") {
      if (actual.localeParity !== "not-applicable" || record.localeApplicability.count !== 0 || !["excluded", "not-claimed", "not-product-surface"].includes(record.publicClaimStatus)) hold("ERC_DOCUMENT_SEMANTICS", "Product/localized document cannot be labelled not applicable");
    } else {
      if (actual.disposition !== "verified-current" || record.localeApplicability.count > 0 && actual.localeParity !== "semantically-verified") hold("ERC_DOCUMENT_SEMANTICS", "Maintained localized semantics/parity is unverified");
      if (record.generator !== "manual" && sourceBindings.some(ref => ref.location !== "public")) hold("ERC_DOCUMENT_BINDING", "Public generated document depends on excluded private source");
    }
  }
  return { inventorySha256: sha256(bytes), inventoryRevision: inventory.inventoryRevision, documentCount: DOCUMENT_COUNT,
    nonDocumentCount: NON_DOCUMENT_PATHS.length, denominatorDigest: DOCUMENT_PATH_DIGEST,
    dispositionsDigest: digestObject(records.map(record => semantic.documents.get(record.path))) };
}
async function verifyCoverageSemantics(ctx, config, semantic) {
  const coverage = await validateReferencedSources(ctx, config);
  equal([...semantic.coverage.keys()].sort((a, b) => Number(a) - Number(b)), coverage.rows.map(row => row.id).sort((a, b) => Number(a) - Number(b)), "all original 46-row dispositions");
  for (const row of coverage.rows) {
    const actual = semantic.coverage.get(row.id);
    if (actual.quoteSha256 !== row.quoteSha256) hold("ERC_COVERAGE_BINDING", "Native conclusion substitutes the original requirement");
    equal(actual.scopeReferenceIds, row.scopeReferenceIds, "native conclusion's owner-adopted applicability references");
    const trackingOnly = row.id === "1" || row.id === "2";
    if (trackingOnly ? actual.disposition !== "tracking-only" : actual.disposition === "tracking-only") {
      hold("ERC_COVERAGE_SEMANTICS", "Original rows 1-2 are tracking-only and cannot claim implementation acceptance");
    }
    if (!trackingOnly && actual.disposition !== "covered-current-source" && actual.scopeReferenceIds.length === 0) hold("ERC_ADOPTED_SCOPE_REQUIRED", "Deferral/not-applicable conclusion lacks the actual owner-adopted scope source");
  }
  return { privateSourceSha: coverage.privateSourceSha, originalRowCount: 46, rowsDigest: coverage.rowsDigest,
    scopeReferencesDigest: digestObject(coverage.scopeReferences), dispositionsDigest: digestObject(coverage.rows.map(row => semantic.coverage.get(row.id))) };
}

async function verifyCurrent(ctx, phase) {
  assertInstalledRcPublicationContextV1(ctx);
  await assertInstalledRcPublicationContextCurrentV1(ctx);
  const configRecord = await readInstalledRcAdapterConfigRecordV1(ctx, "review-docs");
  const config = inspectRcReviewDocumentsConfigV1(configRecord.value);
  if (config.operationId !== ctx.operationId || config.bindingDigest !== ctx.bindingDigest) hold("ERC_REVIEW_BINDING", "Review context/config operation changed");
  const source = await observePublicSnapshot(ctx, config);
  const reviewRoot = path.join(ctx.paths.evidenceRoot, "review");
  await assertRootOwnedRuntimePathV2(reviewRoot, { directory: true });
  const run = await loadRun(reviewRoot, config.runId);
  if (run.manifest.cwd !== ctx.candidate.publicRoot || run.manifest.runId !== config.runId) hold("ERC_REVIEW_BINDING", "Native review was performed on private source or another public checkout");
  const contract = await protectedRecord(path.join(run.runDir, "contract.json"), 8 * 1024 * 1024, config.runContractSha256);
  equal(JSON.parse(strictUtf8(contract.bytes, "actual TaskContract")), run.contract, "actual native TaskContract");
  const status = await reviewStatus(reviewRoot, config.runId);
  const pkg = status.package, kernel = status.kernel;
  if (!pkg || pkg.schemaVersion !== 2 || !status.complete || !kernel?.convergence.complete || !status.kernelReceiptsComplete ||
      pkg.packageId !== config.packageId || reviewPackageDigest(pkg) !== config.packageDigest || status.continuityDigest !== config.continuityDigest ||
      pkg.head !== ctx.candidate.publicCandidateSha || !run.state.lastSentinelVerified || !run.state.lastSentinelComplete || pkg.sentinelDigest !== run.state.lastSentinel.digest) hold("ERC_REVIEW_CONTINUITY", "Actual current full public snapshot/kernel continuity is incomplete");
  const subject = inspectNativeReviewSnapshotSubjectV1(Object.fromEntries(["reviewMode", "base", "head", "mergeBase", "snapshotTreeOid", "fullUniverseDigest"].map(key => [key, pkg[key]])));
  if (subject.snapshotTreeOid !== config.publicTreeOid || subject.fullUniverseDigest !== config.fullUniverseDigest || pkg.scope.length !== 1 || pkg.scope[0] !== ".") hold("ERC_REVIEW_UNIVERSE", "Diff-only/package subset cannot replace the actual full public snapshot");
  equal(pkg.workUniverse.map(unit => unit.path).sort(), source.snapshot.records.map(record => record.path).sort(), "actual all-path review kernel universe");
  const lanes = pkg.reviewLanes.filter(lane => lane.required);
  equal(config.lanes.map(lane => lane.axisId).sort(), lanes.map(lane => lane.id).sort(), "all existing required review kernel lanes");
  if (kernel.axes.length !== lanes.length || kernel.verifications.length || kernel.findings.length || lanes.find(lane => lane.id === config.semanticLaneId)?.contextProfile === "low-context") hold("ERC_REVIEW_KERNEL", "Actual native review has unresolved/reused/low-context-only semantic coverage");
  const contractBytes = Buffer.from(JSON.stringify(rcReviewDocumentsInstructionContractV1(config)));
  const verified = [];
  for (const lane of config.lanes) verified.push(await verifyLane(ctx, config, lane, pkg, kernel, reviewRoot, subject, contractBytes));
  let qualification = null;
  if (phase === "qualification") {
    if (!config.acceptedCoverage) hold("ERC_ADOPTED_COVERAGE_REQUIRED", "Exact original/adopted scope references remain PENDING");
    const semantic = semanticDispositions(verified.find(lane => lane.axisId === config.semanticLaneId).replay, digestObject(JSON.parse(contractBytes)));
    qualification = { coverage: await verifyCoverageSemantics(ctx, config, semantic), documents: await verifyDocumentSemantics(ctx, config, source, semantic) };
  }
  await assertReviewContinuity(reviewRoot, config.runId, { packageId: pkg.packageId, packageDigest: config.packageDigest, head: pkg.head, continuityDigest: config.continuityDigest });
  const finalSource = await observePublicSnapshot(ctx, config);
  equal(finalSource.observation.sourceInventoryDigest, source.observation.sourceInventoryDigest, "public raw bytes/modes during review verification");
  equal(finalSource.observation.sourceSnapshotDigest, source.observation.sourceSnapshotDigest, "public physical source during review verification");
  await assertInstalledRcPublicationContextCurrentV1(ctx);
  const finalConfig = await readInstalledRcAdapterConfigRecordV1(ctx, "review-docs");
  equal({ sha256: finalConfig.sha256, identity: finalConfig.identity }, { sha256: configRecord.sha256, identity: configRecord.identity }, "fixed installed review/doc config");
  return { configRecord, source: finalSource, observation: { configSha256: configRecord.sha256, configIdentity: configRecord.identity,
    subject, publicSourceInventoryDigest: finalSource.observation.sourceInventoryDigest, publicSourceSnapshotDigest: finalSource.observation.sourceSnapshotDigest,
    runContractSha256: contract.sha256, packageDigest: config.packageDigest, continuityDigest: status.continuityDigest,
    kernelAxisSetDigest: kernel.axisSetDigest, kernelCoverageDigest: kernel.coverageDigest, kernelConvergenceDigest: kernel.convergenceDigest,
    nativeLanes: verified.map(lane => lane.observation), qualification } };
}
async function produce(ctx, phase) {
  const observed = await verifyCurrent(ctx, phase);
  const result = freeze({ kind: "InstalledRcReviewDocumentsObservationV1", authenticatedState: "VERIFIED_CURRENT", authority: "none",
    operationId: ctx.operationId, bindingDigest: ctx.bindingDigest, publicCandidateSha: ctx.candidate.publicCandidateSha,
    publicTreeOid: ctx.candidate.publicTreeOid, phase, evidenceDigest: digestObject(observed.observation), observation: observed.observation });
  results.set(result, { ctx, phase, evidenceDigest: result.evidenceDigest });
  return result;
}
export async function verifyInstalledRcSnapshotReviewV1(ctx) { return produce(ctx, "source"); }
export async function verifyInstalledRcReviewDocumentsV1(ctx) { return produce(ctx, "qualification"); }
export async function assertInstalledRcReviewDocumentsResultV1(result, ctx, phase) {
  assertInstalledRcPublicationContextV1(ctx);
  const bound = results.get(result);
  if (!["source", "qualification"].includes(phase) || !bound || bound.ctx !== ctx || bound.phase !== phase ||
      result.operationId !== ctx.operationId || result.bindingDigest !== ctx.bindingDigest || result.authenticatedState !== "VERIFIED_CURRENT") hold("ERC_REVIEW_RESULT", "Caller/stale/other-phase review observation is not a live trusted result");
  const observed = await verifyCurrent(ctx, phase);
  if (digestObject(observed.observation) !== bound.evidenceDigest) hold("ERC_REVIEW_RESULT_DRIFT", "Current public review/doc evidence changed after verification");
  return result;
}
