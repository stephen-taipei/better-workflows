import { readFile } from "node:fs/promises";
import path from "node:path";
import { digestObject, listJsonRecords, pluginRoot, safeJoin, readJson, verifyMergeHumanApproval } from "./core.mjs";
import { captureSourceBinding } from "./git.mjs";
import { reviewPackageBindingRequired } from "./review-policy.mjs";
import { QUORUM_EVIDENCE_KIND, changedPathsFromDiffManifest, validateQuorumEvidencePayload } from "./quorum.mjs";
import { SHARD_PROTOCOL, assertShardedReviewShape } from "./native-review-shards.mjs";

const CONTRACT_FILE = path.join(pluginRoot(), "config", "evidence-contracts-v1.json");
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const PRODUCER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PAYLOAD_FAMILIES = new Set([
  "revision-identity",
  "inventory-snapshot",
  "plan-design",
  "validation-test",
  "review-analysis",
  "authorization",
  "side-effect-result",
  "provider-reconciliation",
  "decision-disposition",
  "artifact-package"
]);
const INDEPENDENT_CRITIC_PRODUCERS = new Set(["agy", "codex", "codex-native-subagent"]);
const MAX_REQUIRED_CHECK_AGE_MS = 30 * 60 * 1000;
const SELF_IMPROVE_HANDOFF_KIND = "self-improve-delivery-handoff";
let contractCache = null;

function hasCanonicalDependencyInputs(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "files") &&
    Array.isArray(value.files) &&
    value.files.every((candidate) => typeof candidate === "string" && candidate.length > 0)
  );
}

export async function loadEvidenceContracts({ refresh = false } = {}) {
  if (contractCache && !refresh) return contractCache;
  const value = JSON.parse(await readFile(CONTRACT_FILE, "utf8"));
  if (value?.schemaVersion !== 1 || !value.contracts || typeof value.contracts !== "object") {
    throw new Error("evidence-contracts-v1 must contain schemaVersion 1 and contracts");
  }
  const entries = Object.entries(value.contracts);
  if (entries.length !== 102) {
    throw new Error(`evidence-contracts-v1 must cover exactly 102 kinds, found ${entries.length}`);
  }
  for (const [kind, entry] of entries) {
    if (entry?.id !== `evidence-contracts-v1:${kind}`) {
      throw new Error(`Evidence contract id mismatch for ${kind}`);
    }
    if (!Array.isArray(entry.producerAllowlist) || entry.producerAllowlist.length === 0) {
      throw new Error(`Evidence contract producer allowlist is empty for ${kind}`);
    }
    if (!PAYLOAD_FAMILIES.has(entry.payloadFamily) || !Array.isArray(entry.requiredFields)) {
      throw new Error(`Evidence contract payload schema is invalid for ${kind}`);
    }
    const nullableFields = entry.nullableFields ?? [];
    if (
      !Array.isArray(nullableFields) ||
      new Set(nullableFields).size !== nullableFields.length ||
      nullableFields.some((field) => typeof field !== "string" || !entry.requiredFields.includes(field))
    ) {
      throw new Error(`Evidence contract nullable fields are invalid for ${kind}`);
    }
    if (!Array.isArray(entry.freshnessBinding) || !entry.freshnessBinding.includes("runId")) {
      throw new Error(`Evidence contract freshness binding is invalid for ${kind}`);
    }
  }
  const predicates = value.successPredicates ?? {};
  for (const [family, predicate] of Object.entries(predicates)) {
    if (!PAYLOAD_FAMILIES.has(family) || !predicate || typeof predicate.field !== "string") {
      throw new Error(`Evidence success predicate is invalid for ${family}`);
    }
    if (predicate.equals === undefined && !Array.isArray(predicate.oneOf) && predicate.nonEmpty !== true) {
      throw new Error(`Evidence success predicate has no comparison for ${family}`);
    }
  }
  contractCache = Object.fromEntries(entries.map(([kind, entry]) => [
    kind,
    { ...entry, success: predicates[entry.payloadFamily] ?? null }
  ]));
  return contractCache;
}

function producerId(producer) {
  if (typeof producer === "string") return producer;
  if (!producer || typeof producer !== "object") return "";
  return String(producer.provider ?? producer.type ?? producer.id ?? "");
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !HEX_DIGEST.test(value)) {
    throw new Error(`${label} must be a 64-character SHA-256 digest`);
  }
}

export async function assertActionProofPayload(payload, kind, run, evidenceId) {
  if (!(["cache-publication", "provider-reconciliation", "remote-sync"].includes(kind))) return;
  const proof = payload.actionProof;
  const receipt = payload.receipt;
  const proofFields = [
    "runId",
    "actionAttemptId",
    "action",
    "provider",
    "resource",
    "outcome",
    "idempotencyKey",
    "remoteRevision",
    "providerExecutionId",
    "providerReceiptDigest"
  ];
  if (!proof || typeof proof !== "object" || Array.isArray(proof) || proof.schemaVersion !== 1 ||
      proofFields.some((field) => typeof proof[field] !== "string" || !proof[field])) {
    throw new Error(`Typed evidence ${kind} actionProof is structurally invalid`);
  }
  if (proof.runId !== run.manifest.runId || proof.outcome !== "success" || payload.provider !== proof.provider) {
    throw new Error(`Typed evidence ${kind} actionProof run or outcome binding is invalid`);
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      receipt.action !== proof.action ||
      receipt.provider !== proof.provider ||
      receipt.resource !== proof.resource ||
      receipt.outcome !== proof.outcome ||
      receipt.runId !== proof.runId ||
      receipt.attemptId !== proof.actionAttemptId ||
      receipt.idempotencyKey !== proof.idempotencyKey ||
      receipt.remoteRevision !== proof.remoteRevision ||
      receipt.executionId !== proof.providerExecutionId ||
      typeof receipt.proofKind !== "string" || !receipt.proofKind ||
      typeof receipt.requestDigest !== "string" || !HEX_DIGEST.test(receipt.requestDigest) ||
      typeof receipt.responseDigest !== "string" || !HEX_DIGEST.test(receipt.responseDigest) ||
      typeof receipt.verifiedAt !== "string" || Number.isNaN(Date.parse(receipt.verifiedAt)) ||
      receipt.terminalState !== "success" ||
      proof.providerReceiptDigest !== digestObject(receipt)) {
    throw new Error(`Typed evidence ${kind} actionProof receipt binding is invalid`);
  }
  if (kind === "remote-sync" && (
    proof.action !== "remote.sync" ||
    proof.provider !== "git" ||
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(proof.resource) ||
    typeof payload.mergeCommit !== "string" || !/^[a-f0-9]{40}$/i.test(payload.mergeCommit) ||
    receipt.providerRevision !== payload.mergeCommit ||
    receipt.localRevision !== payload.mergeCommit
  )) {
    throw new Error("Typed evidence remote-sync must bind the reconciled refs to the final merge commit");
  }
  if (kind === "cache-publication" && (
    proof.action !== "plugin.cache.publish" ||
    proof.provider !== "local-workspace"
  )) {
    throw new Error("Typed evidence cache-publication must bind the local plugin cache publication action");
  }
  if (run.root && run.runDir) {
    const actions = await listJsonRecords(run.root, safeJoin(run.runDir, "actions"));
    const action = actions.find((candidate) => candidate.attemptId === proof.actionAttemptId);
    if (
      !action ||
      action.runId !== proof.runId ||
      action.action !== proof.action ||
      action.provider !== proof.provider ||
      action.resource !== proof.resource ||
      action.idempotencyKey !== proof.idempotencyKey ||
      action.remoteRevision !== proof.remoteRevision ||
      action.status !== "spent" ||
      (run.requireReconciled && action.outcome !== "success") ||
      (action.outcome === "success" && (
        !action.receipt ||
        !Array.isArray(action.receipt.evidenceIds) ||
        !action.receipt.evidenceIds.includes(evidenceId) ||
        action.receipt.providerReceipt?.executionId !== proof.providerExecutionId ||
        digestObject(action.receipt.providerReceipt) !== digestObject(receipt)
      ))
    ) {
      throw new Error(`Typed evidence ${kind} actionProof does not reference a persisted reconciled action`);
    }
  }
}

const ARRAY_FIELDS = new Set([
  "acceptanceIds", "batches", "blockers", "checkSet", "checks", "commits", "conclusions", "files", "items",
  "providerRunIds", "requiredStatusCheckApps", "requiredStatusChecks", "resources", "roleReceipts", "roles", "scope", "tasks", "witnessDigests"
]);
const OBJECT_FIELDS = new Set([
  "actionProof", "artifact", "authorization", "counts", "diffManifest", "evaluatorAuthorization", "manifest", "metadata", "permissions",
  "providerAuthorization", "providerExecutable", "receipt", "scopeDigest", "summary", "target", "workflow"
]);
const OBJECT_FIELDS_BY_KIND = new Map([
  // Most decision-disposition records use a string decision.  The quorum
  // contract deliberately carries policyId and verdict together, so keep
  // that object shape scoped to its versioned evidence kind instead of
  // weakening the legacy decision-record contract.
  ["agent-review-quorum", new Set(["decision"])]
]);
const INTEGER_FIELDS = new Set(["number", "pr", "providerRunId", "repairRound"]);
const BOOLEAN_FIELDS = new Set(["adminBypass", "protected", "result", "success", "valid"]);
const DATE_FIELDS = new Set(["createdAt", "expiresAt", "observedAt", "verifiedAt"]);

export function assertPayloadFields(payload, requiredFields, kind, nullableFields = []) {
  const nullable = new Set(nullableFields);
  const objectFields = new Set([
    ...OBJECT_FIELDS,
    ...(OBJECT_FIELDS_BY_KIND.get(kind) ?? [])
  ]);
  for (const field of requiredFields) {
    if (!(field in payload) || payload[field] === "") {
      throw new Error(`Typed evidence ${kind} payload is missing required field: ${field}`);
    }
    const value = payload[field];
    if (value === null) {
      if (nullable.has(field)) continue;
      throw new Error(`Typed evidence ${kind} payload is missing required field: ${field}`);
    }
    if (ARRAY_FIELDS.has(field) && !Array.isArray(value)) {
      throw new Error(`Typed evidence ${kind} payload field ${field} must be an array`);
    }
    if (objectFields.has(field) && (typeof value !== "object" || Array.isArray(value))) {
      throw new Error(`Typed evidence ${kind} payload field ${field} must be an object`);
    }
    if (field === "providerExecutable") {
      const keys = Object.keys(value).sort();
      if (
        keys.length !== 2 ||
        keys[0] !== "digest" ||
        keys[1] !== "path" ||
        typeof value.path !== "string" ||
        !path.isAbsolute(value.path) ||
        typeof value.digest !== "string" ||
        !HEX_DIGEST.test(value.digest)
      ) {
        throw new Error(`Typed evidence ${kind} payload field providerExecutable must be an exact absolute path and SHA-256 digest object`);
      }
    }
    if (INTEGER_FIELDS.has(field) && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`Typed evidence ${kind} payload field ${field} must be a non-negative integer`);
    }
    if (field === "result" && (typeof value !== "boolean" && value !== "complete")) {
      throw new Error(`Typed evidence ${kind} payload field ${field} must be boolean or complete`);
    }
    if (BOOLEAN_FIELDS.has(field) && field !== "result" && typeof value !== "boolean") {
      throw new Error(`Typed evidence ${kind} payload field ${field} must be boolean`);
    }
    if (DATE_FIELDS.has(field) && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
      throw new Error(`Typed evidence ${kind} payload field ${field} must be an ISO date`);
    }
    if (
      !ARRAY_FIELDS.has(field) && !objectFields.has(field) && !INTEGER_FIELDS.has(field) &&
      !BOOLEAN_FIELDS.has(field) && !DATE_FIELDS.has(field) && typeof value !== "string"
    ) {
      throw new Error(`Typed evidence ${kind} payload field ${field} must be a string`);
    }
  }
}

function assertSemanticSuccess(payload, kind, definition) {
  const predicate = definition.success;
  if (!predicate) return;
  const value = payload[predicate.field];
  const matches = predicate.equals !== undefined
    ? value === predicate.equals
    : Array.isArray(predicate.oneOf)
      ? predicate.oneOf.some((candidate) => value === candidate)
      : Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
  if (!matches) throw new Error(`Typed evidence ${kind} payload ${predicate.field} failed its success predicate`);
}

function assertIndependentCriticBinding(record, run) {
  if (record.review?.reviewProtocol || record.review?.shardProof) {
    const proof = assertShardedReviewShape(record.review);
    if (record.providerExecution?.provider !== "codex-native-subagent" ||
        record.providerExecution?.executionId !== proof.executionId ||
        record.nativeReviewer?.executionId !== proof.executionId || !record.nativeReviewer?.attestationPath ||
        !HEX_DIGEST.test(record.nativeReviewer?.attestationFileDigest ?? "")) {
      throw new Error("Sharded native review requires an exact replay-verifiable host attestation");
    }
  }
  const binding = record.dependencies?.reviewBinding;
  const required = ["packageId", "base", "head", "scopeDigest", "diffManifestDigest", "instructionDigest", "sentinelDigest"];
  if (reviewPackageBindingRequired(run.contract.controlPlane?.reviewPolicy)) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      throw new Error("Typed evidence independent-critic review binding is required");
    }
    for (const field of required) {
      if (typeof binding[field] !== "string" || !binding[field]) {
        throw new Error(`Typed evidence independent-critic review binding is missing: ${field}`);
      }
    }
  }
  const execution = record.providerExecution;
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    throw new Error("Typed evidence independent-critic provider execution is required");
  }
  if (
    execution.provider !== producerId(record.receipt?.producer) ||
    execution.model !== record.dependencies?.model ||
    execution.modelAssurance !== "host-signed-attestation" ||
    execution.trustAttested !== true ||
    execution.promptDigest !== record.dependencies?.promptDigest ||
    execution.reviewDigest !== digestObject(record.review) ||
    execution.sandbox !== "read-only" ||
    typeof execution.executionDigest !== "string" ||
    execution.executionDigest !== digestObject({
      provider: execution.provider,
      model: execution.model,
      modelAssurance: execution.modelAssurance,
      trustAttested: execution.trustAttested,
      promptDigest: execution.promptDigest,
      reviewDigest: execution.reviewDigest,
      transport: execution.transport,
      sandbox: execution.sandbox,
      ...(record.review?.reviewProtocol === SHARD_PROTOCOL ? { executionId: execution.executionId } : {})
    })
  ) {
    throw new Error("Typed evidence independent-critic provider execution is invalid");
  }
  if (execution.provider === "codex-native-subagent" && !record.nativeReviewer?.attestationDigest) {
    throw new Error("Typed evidence native critic attestation is missing");
  }
  if (reviewPackageBindingRequired(run.contract.controlPlane?.reviewPolicy) && record.dependencies.promptDigest !== binding.instructionDigest) {
    throw new Error("Typed evidence independent-critic prompt is not bound to the review instruction");
  }
  if (record.review?.verdict === "PASS" && record.review.findings.length > 0) {
    throw new Error("Typed evidence independent-critic PASS cannot contain findings");
  }
}

export function assertShardedCurrentAuthority(record, run, reviewPackage) {
  const binding = record.dependencies?.reviewBinding;
  if (!binding || run.state?.lastSentinelVerified !== true || run.state?.lastSentinelComplete !== true ||
      binding.sentinelDigest !== run.state.lastSentinel?.digest) throw new Error("Sharded critic current sentinel is stale or unverified");
  if (!reviewPackage || reviewPackage.immutable !== true ||
      reviewPackage.contractDigest !== digestObject(run.contract) || reviewPackage.templateDigest !== run.contract.templateDigest ||
      ["packageId", "base", "head", "scopeDigest", "diffManifestDigest", "instructionDigest", "sentinelDigest"].some(
        field => reviewPackage[field] !== binding[field])) {
    throw new Error("Sharded critic current package authority changed");
  }
}

async function assertShardedCriticReplay(record, run) {
  if (!record.review?.reviewProtocol && !record.review?.shardProof) return;
  const proof = assertShardedReviewShape(record.review), binding = record.dependencies.reviewBinding;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(binding.packageId) || !run.runDir) {
    throw new Error("Sharded critic canonical package locator is missing");
  }
  const stateRoot = run.root ?? path.dirname(path.dirname(run.runDir));
  const reviewPackage = await readJson(stateRoot, safeJoin(run.runDir, "review-packages", `${binding.packageId}.json`));
  assertShardedCurrentAuthority(record, run, reviewPackage);
  const { validateShardedReviewReceipt } = await import("./native-review-runner.mjs");
  const verified = await validateShardedReviewReceipt(proof.aggregateReceiptPath, { binding: {
    runId: run.manifest.runId, repository: run.manifest.cwd, base: binding.base, head: binding.head,
    packageId: binding.packageId, instructionSha256: binding.instructionDigest, model: record.dependencies.model,
    reviewerId: record.nativeReviewer.id, executionId: proof.executionId
  }, reviewPackage });
  if (digestObject(verified.review) !== digestObject(record.review)) throw new Error("Sharded critic changed after receipt verification");
  if (verified.signerBinding.sentinelDigest !== binding.sentinelDigest ||
      verified.receipt.verification === undefined) throw new Error("Sharded critic sentinel differs from signed source");
  const { verifyTrustedNativeCriticAttestation } = await import("./providers.mjs");
  const attestation = await verifyTrustedNativeCriticAttestation({ attestationPath: record.nativeReviewer.attestationPath,
    workspaceRoot: run.manifest.cwd, binding: { ...verified.signerBinding, sentinelDigest: binding.sentinelDigest },
    expectedFileDigest: record.nativeReviewer.attestationFileDigest });
  if (attestation.attestationDigest !== record.nativeReviewer.attestationDigest) throw new Error("Sharded critic host attestation changed");
}

async function assertReviewKernelEvidence(payload, kind, run, { recorded = false } = {}) {
  if (!["work-unit-accounting", "review-kernel-summary"].includes(kind)) return;
  if (!run.root) throw new Error(`Typed evidence ${kind} requires live review-kernel state`);
  const { recordedReviewKernelStatus, reviewKernelStatus } = await import("./review.mjs");
  const kernel = recorded
    ? await recordedReviewKernelStatus(run.root, run.manifest.runId, payload.packageId)
    : await reviewKernelStatus(run.root, run.manifest.runId);
  if (!kernel) throw new Error(`Typed evidence ${kind} requires a current v2 review package`);
  const commonMatches = (
    payload.result === true && payload.packageId === kernel.packageId &&
    payload.repairRound === kernel.repairRound && payload.workUniverseDigest === kernel.workUniverseDigest &&
    payload.axisSetDigest === kernel.axisSetDigest && payload.coverageDigest === kernel.coverageDigest
  );
  if (!commonMatches) throw new Error(`Typed evidence ${kind} is stale or not bound to the current review kernel`);
  if (kind === "work-unit-accounting") {
    if (
      !kernel.convergence.coverageComplete || payload.reviewLanesDigest !== kernel.reviewLanesDigest ||
      digestObject(payload.items) !== digestObject(kernel.coverage)
    ) throw new Error("Typed evidence work-unit-accounting does not match deterministic coverage");
    return;
  }
  if (
    !kernel.convergence.complete || payload.verificationSetDigest !== kernel.verificationSetDigest ||
    payload.findingSetDigest !== kernel.findingSetDigest || payload.convergenceDigest !== kernel.convergenceDigest ||
    digestObject(payload.items) !== digestObject(kernel.findings)
  ) throw new Error("Typed evidence review-kernel-summary does not match deterministic synthesis");
}

async function assertQuorumEvidence(payload, kind, run, { now } = {}) {
  if (kind !== QUORUM_EVIDENCE_KIND) return;
  const manifest = payload?.manifest;
  const packageId = manifest?.reviewPackageId;
  const root = path.dirname(path.dirname(run.runDir));
  const packages = await listJsonRecords(root, safeJoin(run.runDir, "review-packages"));
  const reviewPackage = packages.find((item) => item.packageId === packageId);
  if (!reviewPackage || reviewPackage.immutable !== true) {
    throw new Error("Quorum evidence must bind to an immutable current review package");
  }
  const { reviewPackageDigest } = await import("./review.mjs");
  if (
    reviewPackage.contractDigest !== digestObject(run.contract) ||
    reviewPackage.templateDigest !== run.contract.templateDigest ||
    reviewPackage.sentinelDigest !== run.state.lastSentinel?.digest ||
    reviewPackage.diffManifestDigest !== digestObject(reviewPackage.diffManifest)
  ) {
    throw new Error("Quorum evidence review package binding is stale");
  }
  validateQuorumEvidencePayload(payload, {
    registryCwd: run.manifest.cwd,
    ...(now === undefined ? {} : { now }),
    expected: {
      runId: run.manifest.runId,
      sourceBindingDigest: run.manifest.sourceBinding?.digest,
      sourceSentinelDigest: run.state.lastSentinel?.digest,
      contractDigest: digestObject(run.contract),
      templateDigest: run.contract.templateDigest,
      instructionDigest: reviewPackage.instructionDigest,
      reviewPackageId: reviewPackage.packageId,
      reviewPackageDigest: reviewPackageDigest(reviewPackage),
      base: reviewPackage.base,
      head: reviewPackage.head,
      mergeBase: reviewPackage.mergeBase,
      changedPaths: changedPathsFromDiffManifest(reviewPackage.diffManifest)
    }
  });
}

async function assertRequiredChecksPayload(payload, run, {
  now = Date.now(),
  recordedSourceBinding = null
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) {
    throw new Error("Typed evidence required-checks reference time is invalid");
  }
  const humanApproval = payload?.humanApproval;
  if (humanApproval !== undefined) {
    const authorization = humanApproval?.authorization;
    const attestation = humanApproval?.attestation;
    if (
      humanApproval?.schemaVersion !== 1 ||
      authorization?.schemaVersion !== 1 ||
      authorization.kind !== "host-signed-pr-merge-authorization" ||
      authorization.action !== "pr.merge" ||
      authorization.resource !== `pull/${payload?.pr}` ||
      authorization.repository !== payload?.repository ||
      authorization.pr !== payload?.pr ||
      authorization.head !== payload?.head ||
      authorization.base !== payload?.base ||
      authorization.baseRefName !== payload?.baseRefName ||
      authorization.adminBypass !== false ||
      authorization.reviewPolicyException !== "solo-repository-zero-review-v1" ||
      typeof authorization.actor !== "string" || !authorization.actor ||
      authorization.runId !== run.manifest.runId ||
      authorization.contractDigest !== digestObject(run.contract) ||
      authorization.sourceBindingDigest !== run.manifest.sourceBinding?.digest ||
      typeof authorization.reviewPackageId !== "string" ||
      !/^review-[a-f0-9]{32}$/.test(authorization.reviewPackageId) ||
      !attestation || typeof attestation.path !== "string" || !path.isAbsolute(attestation.path) ||
      !HEX_DIGEST.test(attestation.attestationDigest ?? "") ||
      !HEX_DIGEST.test(attestation.fileDigest ?? "")
    ) {
      throw new Error("Typed evidence required-checks human approval binding is incomplete");
    }
    const state = run.state ?? (run.runDir
      ? JSON.parse(await readFile(safeJoin(run.runDir, "state.json"), "utf8"))
      : null);
    if (!state?.lastSentinel?.digest || authorization.sourceSentinelDigest !== state.lastSentinel.digest) {
      throw new Error("Typed evidence required-checks human approval sentinel binding is stale");
    }
    const reviewPackage = run.runDir
      ? JSON.parse(await readFile(safeJoin(
        run.runDir,
        "review-packages",
        `${authorization.reviewPackageId}.json`
      ), "utf8"))
      : null;
    if (
      reviewPackage?.packageId !== authorization.reviewPackageId ||
      reviewPackage?.head !== payload.head ||
      reviewPackage?.base !== payload.base ||
      reviewPackage?.broadReview?.complete !== true
    ) {
      throw new Error("Typed evidence required-checks human approval review package binding is stale");
    }
    const expectedAuthorization = {
      schemaVersion: 1,
      kind: "host-signed-pr-merge-authorization",
      action: "pr.merge",
      resource: `pull/${payload.pr}`,
      runId: authorization.runId,
      contractDigest: authorization.contractDigest,
      sourceBindingDigest: authorization.sourceBindingDigest,
      sourceSentinelDigest: authorization.sourceSentinelDigest,
      reviewPackageId: authorization.reviewPackageId,
      repository: payload.repository,
      pr: payload.pr,
      head: payload.head,
      base: payload.base,
      baseRefName: payload.baseRefName,
      actor: authorization.actor,
      adminBypass: false,
      reviewPolicyException: "solo-repository-zero-review-v1",
      approvedAt: authorization.approvedAt
    };
    if (
      !Number.isFinite(Date.parse(authorization.approvedAt ?? "")) ||
      digestObject(authorization) !== digestObject(expectedAuthorization) ||
      humanApproval.authorizationDigest !== digestObject(expectedAuthorization)
    ) {
      throw new Error("Typed evidence required-checks human approval authorization is invalid");
    }
    const attestationVerification = await verifyMergeHumanApproval(run.manifest.cwd, payload, {
      now: nowMs,
      recordedSourceBinding
    });
    if (
      attestationVerification.authorizationDigest !== humanApproval.authorizationDigest ||
      attestationVerification.attestationDigest !== attestation.attestationDigest ||
      attestationVerification.sourceBindingDigest !== authorization.sourceBindingDigest ||
      attestationVerification.actor !== authorization.actor ||
      attestationVerification.reviewPolicyException !== authorization.reviewPolicyException
    ) {
      throw new Error("Typed evidence required-checks human approval attestation is invalid");
    }
  }
  const checks = payload?.checks;
  const observedAt = Date.parse(payload?.observedAt ?? "");
  if (!Number.isFinite(observedAt) || observedAt > nowMs + 5 * 60 * 1000 || nowMs - observedAt > MAX_REQUIRED_CHECK_AGE_MS) {
    throw new Error("Typed evidence required-checks observation is stale or invalid");
  }
  if (
    !Array.isArray(checks) ||
    checks.length === 0 ||
    !Array.isArray(payload?.checkSet) ||
    payload.checkSet.length === 0 ||
    !Array.isArray(payload?.providerRunIds) ||
    payload.providerRunIds.length === 0 ||
    checks.length !== payload.checkSet.length ||
    checks.length !== payload.providerRunIds.length ||
    payload.checkSet.length !== payload.providerRunIds.length ||
    !Array.isArray(payload?.conclusions) ||
    payload.conclusions.length !== checks.length ||
    new Set(checks.map((check) => check?.name)).size !== checks.length ||
    new Set(checks.map((check) => check?.providerName ?? check?.name)).size !== checks.length ||
    new Set(checks.map((check) => `${check?.observationKind}:${check?.providerRunId}`)).size !== checks.length ||
    checks.some((check, index) => (
      !check ||
      typeof check.name !== "string" || check.name.trim() === "" ||
      (check.providerName !== undefined && (typeof check.providerName !== "string" || check.providerName.trim() === "")) ||
      !["check-run", "commit-status"].includes(check.observationKind) ||
      typeof check.providerRunId !== "string" || check.providerRunId.trim() === "" ||
      typeof check.completedAt !== "string" || !Number.isFinite(Date.parse(check.completedAt)) ||
      Date.parse(check.completedAt) > observedAt ||
      !["SUCCESS", "success", "PASS", "pass"].includes(String(check.conclusion)) ||
      payload.checkSet[index] !== (check.providerName ?? check.name) ||
      payload.providerRunIds[index] !== check.providerRunId ||
      String(payload.conclusions[index]) !== String(check.conclusion)
    )) ||
    payload.checkSet.some((value) => typeof value !== "string" || value.trim() === "") ||
    payload.providerRunIds.some((value) => typeof value !== "string" || value.trim() === "") ||
    payload.conclusions.some((value) => !["SUCCESS", "success", "PASS", "pass"].includes(String(value)))
  ) {
    throw new Error("Typed evidence required-checks provider observation is incomplete");
  }
}

function assertInputBindingIdentity(receipt, run, definition, kind) {
  const binding = receipt.inputBinding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error(`Typed evidence ${kind} inputBinding is required`);
  }
  for (const field of definition.freshnessBinding) {
    if (!(field in binding)) {
      throw new Error(`Typed evidence ${kind} freshness binding is missing: ${field}`);
    }
  }
  if (binding.runId !== run.manifest.runId) {
    throw new Error(`Typed evidence ${kind} is bound to a different run`);
  }
  const contractDigest = digestObject(run.contract);
  if (binding.contractDigest !== contractDigest) {
    throw new Error(`Typed evidence ${kind} contract binding is stale`);
  }
  if (binding.remoteRevision !== (run.contract.remoteRevision ?? null)) {
    throw new Error(`Typed evidence ${kind} remote revision binding is stale`);
  }
}

async function assertFreshBinding(receipt, run, definition, kind) {
  assertInputBindingIdentity(receipt, run, definition, kind);
  const binding = receipt.inputBinding;
  if (definition.freshnessBinding.includes("sourceBindingDigest")) {
    const expected = run.manifest.sourceBinding?.digest;
    if (!expected || binding.sourceBindingDigest !== expected) {
      throw new Error(`Typed evidence ${kind} source binding is stale`);
    }
    const current = await captureSourceBinding(run.manifest.cwd, {
      baseRevision: run.manifest.sourceBinding.baseRevision,
      requireClean: run.manifest.template === "self-improve-ops"
    });
    if (!current || current.digest !== expected) {
      throw new Error(`Typed evidence ${kind} source binding changed`);
    }
  }
  if (definition.freshnessBinding.includes("sourceSentinelDigest")) {
    const expected = run.state.lastSentinel?.digest;
    if (!expected || binding.sourceSentinelDigest !== expected) {
      throw new Error(`Typed evidence ${kind} source sentinel binding is stale`);
    }
  }
  await assertReviewInputBindingSemantics(receipt, run, kind);
}

async function assertReviewInputBindingSemantics(receipt, run, kind) {
  const binding = receipt.inputBinding;
  if (["pr-state", "required-checks"].includes(kind)) {
    const payload = receipt.payload;
    if (
      binding.reviewHead !== payload?.head ||
      binding.reviewBase !== payload?.base ||
      String(binding.pullRequest) !== String(payload?.pr) ||
      binding.repository !== payload?.repository ||
      binding.baseRefName !== payload?.baseRefName
    ) {
      throw new Error(`Typed evidence ${kind} PR review binding is stale`);
    }
  }
  if (kind === "required-checks") {
    await assertRequiredChecksPayload(receipt.payload, run);
  }
}

export async function assertRecordedEvidenceSemantics(record, run) {
  const admittedAt = Date.parse(record?.typedAdmission?.admittedAt ?? "");
  if (!Number.isFinite(admittedAt)) {
    throw new Error("Recorded typed evidence admission time is invalid");
  }
  if (record?.sourceKind === "independent-critic") {
    assertIndependentCriticBinding(record, run);
    if (record.review?.reviewProtocol === SHARD_PROTOCOL) {
      await assertShardedCriticReplay(record, run);
      return;
    }
    throw new Error("Recorded independent critic evidence lacks a replay-verifiable attestation reference");
  }
  const payload = record?.receipt?.payload;
  const kind = record?.kind;
  await assertActionProofPayload(payload, kind, { ...run, requireReconciled: true }, record?.id);
  if (kind === "required-checks") {
    await assertRequiredChecksPayload(payload, run, {
      now: admittedAt,
      recordedSourceBinding: run.manifest?.sourceBinding ?? null
    });
  }
  await assertReviewKernelEvidence(payload, kind, run, { recorded: true });
  await assertQuorumEvidence(payload, kind, run, { now: admittedAt });
  if (kind === SELF_IMPROVE_HANDOFF_KIND) {
    throw new Error("Recorded self-improve delivery handoff requires live source-run revalidation");
  }
}

function evidenceValidationContext(run) {
  const contractSchemaVersion = run?.contract?.schemaVersion;
  if (contractSchemaVersion !== 1 && contractSchemaVersion !== 2) {
    const error = new Error("Evidence admission requires an explicit supported TaskContract schemaVersion (1 or 2); native V3 requires its own validation context");
    error.code = "EEVIDENCE_CONTRACT_VERSION";
    throw error;
  }
  // This private context selects an existing validator; it grants no authority.
  // A native V3 run must never be coerced into either historical run format.
  return Object.freeze({ contractSchemaVersion, run });
}

export async function admitTypedEvidence(record, run, { persisted = false } = {}) {
  const context = evidenceValidationContext(run);
  if (context.contractSchemaVersion === 1) return { ...record, schemaVersion: 1 };
  return admitSchema2Evidence(record, context, { persisted });
}

async function assertTypedEvidenceStructure(record, run) {
  if (!record || record.schemaVersion !== 2) {
    throw new Error("v2 runs require EvidenceRecord schemaVersion 2");
  }
  if (typeof record.kind !== "string" || !record.kind) {
    throw new Error("Typed evidence kind is required");
  }
  const contracts = await loadEvidenceContracts();
  const definition = contracts[record.kind];
  if (!definition) throw new Error(`Unknown typed evidence kind: ${record.kind}`);
  if (record.status !== "complete") throw new Error("Typed evidence status must be complete");
  if (typeof record.summary !== "string" || !record.summary.trim()) {
    throw new Error("Typed evidence summary is required");
  }
  if (record.kind === "diff-review" && !hasCanonicalDependencyInputs(record.dependencyInputs)) {
    throw new Error("Typed evidence diff-review dependencyInputs must be an object containing only a files array");
  }
  const receipt = record.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`Typed evidence ${record.kind} receipt is required`);
  }
  if (receipt.contractId !== definition.id || receipt.contractVersion !== 1) {
    throw new Error(`Typed evidence ${record.kind} contract id/version is invalid`);
  }
  if (typeof receipt.runId !== "string" || receipt.runId !== run.manifest.runId) {
    throw new Error(`Typed evidence ${record.kind} receipt run binding is invalid`);
  }
  const producer = producerId(receipt.producer);
  if (!PRODUCER_ID.test(producer) || !definition.producerAllowlist.includes(producer)) {
    throw new Error(`Typed evidence ${record.kind} producer is not authorized`);
  }
  return { definition, producer };
}

async function assertIndependentEvidenceSemantics(record, run) {
  const producer = producerId(record.receipt?.producer);
  if (record.sourceKind === "independent-critic") {
    if (
      record.kind !== "patch-review" ||
      !INDEPENDENT_CRITIC_PRODUCERS.has(producer) ||
      record.review?.verdict !== "PASS" ||
      !record.dependencies?.promptDigest ||
      !record.dependencies?.model
    ) {
      throw new Error("Typed evidence independent-critic provenance is invalid");
    }
    assertIndependentCriticBinding(record, run);
    await assertShardedCriticReplay(record, run);
  }
}

async function assertTypedEvidencePayloadSemantics(record, run, definition) {
  const receipt = record.receipt;
  if (!receipt.payload || typeof receipt.payload !== "object" || Array.isArray(receipt.payload)) {
    throw new Error(`Typed evidence ${record.kind} payload must be a non-empty object`);
  }
  if (Object.keys(receipt.payload).length === 0) {
    throw new Error(`Typed evidence ${record.kind} payload must not be empty`);
  }
  await assertActionProofPayload(receipt.payload, record.kind, run, record.id);
  assertPayloadFields(receipt.payload, definition.requiredFields, record.kind, definition.nullableFields ?? []);
  await assertReviewKernelEvidence(receipt.payload, record.kind, run);
  await assertQuorumEvidence(receipt.payload, record.kind, run);
  if (record.kind === SELF_IMPROVE_HANDOFF_KIND) {
    const error = new Error("Private self-improve delivery evidence is unavailable in the public Auto bundle");
    error.code = "EWORKFLOW_PUBLIC_AUTO_REQUIRED";
    error.status = "HOLD";
    throw error;
  }
  assertSemanticSuccess(receipt.payload, record.kind, definition);
  const payloadDigest = digestObject(receipt.payload);
  assertDigest(receipt.payloadDigest, `Typed evidence ${record.kind} payloadDigest`);
  if (receipt.payloadDigest !== payloadDigest) {
    throw new Error(`Typed evidence ${record.kind} payload digest mismatch`);
  }
  if (record.sourceDigest !== undefined && record.sourceDigest !== payloadDigest) {
    throw new Error(`Typed evidence ${record.kind} sourceDigest is caller-forged`);
  }
  if (typeof receipt.producedAt !== "string" || Number.isNaN(Date.parse(receipt.producedAt))) {
    throw new Error(`Typed evidence ${record.kind} producedAt is invalid`);
  }
  return payloadDigest;
}

async function admitSchema2Evidence(record, context, { persisted = false } = {}) {
  const { run } = context;
  const { definition, producer } = await assertTypedEvidenceStructure(record, run);
  await assertIndependentEvidenceSemantics(record, run);
  await assertFreshBinding(record.receipt, run, definition, record.kind);
  const payloadDigest = await assertTypedEvidencePayloadSemantics(record, run, definition);
  const receipt = record.receipt;
  const normalized = {
    ...record,
    schemaVersion: 2,
    sourceDigest: payloadDigest,
    acceptanceIds: [],
    receipt: {
      ...receipt,
      payloadDigest
    },
    typedAdmission: {
      contractId: definition.id,
      contractVersion: 1,
      admittedAt: new Date().toISOString(),
      producer,
      ...(record.sourceKind === "independent-critic" ? { independentCritic: true } : {})
    }
  };
  return normalized;
}

function assertTypedAdmissionProvenance(record) {
  if (!record || record.schemaVersion !== 2 || !record.typedAdmission) {
    throw new Error("Evidence record is not a typed-v1 admission");
  }
  if (!EVIDENCE_ID.test(String(record.id ?? ""))) {
    throw new Error("Typed evidence id is invalid");
  }
  const expectedProducer = producerId(record.receipt?.producer);
  const expectedIndependent = record.sourceKind === "independent-critic";
  if (
    record.typedAdmission.contractId !== record.receipt?.contractId ||
    record.typedAdmission.contractVersion !== 1 ||
    record.typedAdmission.producer !== expectedProducer ||
    (expectedIndependent && record.typedAdmission.independentCritic !== true) ||
    (!expectedIndependent && record.typedAdmission.independentCritic === true)
  ) {
    throw new Error("Persisted typed evidence admission provenance is invalid");
  }
}

export async function validateTypedEvidenceRecord(record, run) {
  const context = evidenceValidationContext(run);
  if (context.contractSchemaVersion !== 2) {
    const error = new Error("Persisted typed evidence requires TaskContract schemaVersion 2");
    error.code = "EEVIDENCE_CONTRACT_VERSION";
    throw error;
  }
  assertTypedAdmissionProvenance(record);
  const admitted = await admitTypedEvidence(record, run, { persisted: true });
  if (admitted.sourceDigest !== record.sourceDigest || admitted.receipt.payloadDigest !== record.receipt.payloadDigest) {
    throw new Error("Typed evidence admission changed after persistence");
  }
  return admitted;
}

// Comparison of a persisted ISSUE proof, never an admission or a replacement
// run/state. Core binds the snapshot to the locked proof file and ISSUE journal
// before using this helper. Current-only kind obligations remain live below.
export async function assertGovernedCommitIssuedEvidenceV1(record, snapshot, proof, run) {
  const context = evidenceValidationContext(run);
  if (context.contractSchemaVersion !== 2 ||
      proof?.protocol !== "GovernedCommitIssuedProofV1" || proof.version !== 1 ||
      proof.runId !== run.manifest.runId || !snapshot?.record ||
      snapshot.record.id !== record?.id) {
    throw new Error("Governed commit issued evidence comparison is unbound");
  }
  const immutable = (value) => {
    const result = structuredClone(value);
    for (const key of ["stale", "staleReason", "freshnessCheckedAt", "currentDependencyFiles"]) delete result[key];
    return result;
  };
  if (digestObject(immutable(record)) !== snapshot.immutableEvidenceDigest ||
      digestObject(immutable(snapshot.record)) !== snapshot.immutableEvidenceDigest ||
      digestObject(snapshot.record) !== snapshot.evidenceDigest) {
    throw new Error(`Governed commit issued evidence bytes changed: ${record?.id ?? "unknown"}`);
  }
  assertTypedAdmissionProvenance(record);
  if (!Number.isFinite(Date.parse(record.typedAdmission.admittedAt ?? ""))) {
    throw new Error("Governed commit issued typed admission time is invalid");
  }
  const { definition } = await assertTypedEvidenceStructure(record, run);
  if (digestObject(definition) !== snapshot.definitionDigest) {
    throw new Error(`Governed commit issued evidence definition changed: ${record.kind}`);
  }
  assertInputBindingIdentity(record.receipt, run, definition, record.kind);
  for (const field of ["sourceBindingDigest", "sourceSentinelDigest"]) {
    if (!definition.freshnessBinding.includes(field)) continue;
    const expected = field === "sourceBindingDigest"
      ? proof.sourceAuthority.sourceBinding?.digest
      : proof.sourceAuthority.sourceSentinel?.digest;
    if (!HEX_DIGEST.test(expected ?? "") || record.receipt.inputBinding[field] !== expected) {
      throw new Error(`Governed commit issued evidence source snapshot changed: ${record.kind}`);
    }
  }
  await assertIndependentEvidenceSemantics(record, run);
  await assertReviewInputBindingSemantics(record.receipt, run, record.kind);
  await assertTypedEvidencePayloadSemantics(record, run, definition);
  return record;
}

export function isTypedEvidence(record) {
  return record?.schemaVersion === 2 && record?.typedAdmission?.contractVersion === 1;
}

export function isIndependentCriticEvidence(record, expectedBinding = null) {
  if (record?.review?.reviewProtocol || record?.review?.shardProof) {
    try {
      const proof = assertShardedReviewShape(record.review);
      if (record.nativeReviewer?.executionId !== proof.executionId || record.providerExecution?.executionId !== proof.executionId ||
          !record.nativeReviewer?.attestationPath || !HEX_DIGEST.test(record.nativeReviewer?.attestationFileDigest ?? "")) return false;
    } catch { return false; }
  }
  const binding = record?.dependencies?.reviewBinding;
  const expected = expectedBinding?.reviewPackage
    ? {
        packageId: expectedBinding.reviewPackage.packageId,
        base: expectedBinding.reviewPackage.base,
        head: expectedBinding.reviewPackage.head,
        scopeDigest: expectedBinding.reviewPackage.scopeDigest,
        diffManifestDigest: expectedBinding.reviewPackage.diffManifestDigest,
        instructionDigest: expectedBinding.reviewPackage.instructionDigest,
        sentinelDigest: expectedBinding.sentinelDigest
      }
    : null;
  return Boolean(
    isTypedEvidence(record) &&
    record.stale !== true &&
    record.sourceKind === "independent-critic" &&
    record.kind === "patch-review" &&
    record.typedAdmission?.independentCritic === true &&
    INDEPENDENT_CRITIC_PRODUCERS.has(record.typedAdmission?.producer) &&
    record.receipt?.payload?.verdict === "PASS" &&
    record.review?.verdict === "PASS" &&
    record.providerExecution?.modelAssurance === "host-signed-attestation" &&
    record.providerExecution?.trustAttested === true &&
    Boolean(record.dependencies?.promptDigest) &&
    Boolean(record.dependencies?.model) &&
    (!expected || (binding && Object.entries(expected).every(([key, value]) => binding[key] === value)))
  );
}

export function typedEvidenceKinds(records) {
  return new Set(
    records.filter((record) => isTypedEvidence(record) && !record.stale).map((record) => record.kind)
  );
}
