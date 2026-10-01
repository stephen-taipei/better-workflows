// SPDX-License-Identifier: AGPL-3.0-only
// This local bridge binds one W3 projection receipt to a W5 PREPARE payload.
// Its inputs are caller asserted; it verifies neither manifest approval nor
// provider identity, rights clearance, or stable release admission.
import { createHash } from "node:crypto";
import { appendW5PublicationOperationEventV1 } from "./w5-publication-operation-v1.mjs";
import { PRODUCT_RC_ADMISSION_UNAVAILABLE, resolveProductReleaseTargetV1 } from "./product-release-channel-v1.mjs";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const W3_FIELDS = Object.freeze([
  "schemaVersion", "kind", "status", "authority", "verifiedSurface",
  "privateSourceSha", "privateSourceTreeOid", "productReleaseScopeDigest",
  "exportManifestDigest", "publicTreeOid", "publicCandidateSha",
  "publicFilesSha256", "includedCount", "excludedCount", "exportDigest"
]);
const W3_V2_FIELDS = Object.freeze([
  "schemaVersion", "kind", "status", "authority", "verifiedSurface",
  "privateSourceSha", "privateSourceTreeOid", "productReleaseScopeDigest",
  "approvalArtifactSha256", "exportManifestDigest", "publicTreeOid",
  "publicCandidateSha", "publicFilesSha256", "derivedOutputsSha256",
  "moduleClosureReceiptDigest", "includedCount", "excludedCount", "derivedCount", "exportDigest"
]);
const TARGET_FIELDS = Object.freeze([
  "provider", "repositoryId", "repository", "workflowPath", "sourceRef",
  "tagRef", "siteIdentityDigest"
]);

export class W5PublicCandidateBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = "W5PublicCandidateBindingError";
    this.code = "EW5_CANDIDATE_BINDING";
  }
}

function fail(message) {
  throw new W5PublicCandidateBindingError(message);
}

function plainFields(input, fields, label) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    fail(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(input).length > 0) fail(`${label} contains symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (JSON.stringify(Object.keys(descriptors).sort()) !== JSON.stringify([...fields].sort())) {
    fail(`${label} has unexpected or missing fields`);
  }
  const result = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!("value" in descriptor) || !descriptor.enumerable) fail(`${label}.${field} must be a plain value`);
    result[field] = descriptor.value;
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validDigest(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function checkedW3CandidateV1(input, expectedProductReleaseScopeDigest) {
  const candidate = plainFields(input, W3_FIELDS, "W3 candidate");
  if (candidate.schemaVersion !== 1 || candidate.kind !== "W3LocalPublicCandidateV1" ||
      candidate.status !== "LOCAL_PROJECTION_VERIFIED" || candidate.authority !== "none" ||
      candidate.verifiedSurface !== "local-git-ref-object-graph-only") {
    fail("W3 candidate has unexpected identity, status, or authority");
  }
  for (const field of ["privateSourceSha", "privateSourceTreeOid", "publicTreeOid", "publicCandidateSha"]) {
    if (!validDigest(candidate[field], SHA1)) fail(`W3 candidate ${field} is invalid`);
  }
  for (const field of ["productReleaseScopeDigest", "exportManifestDigest", "publicFilesSha256", "exportDigest"]) {
    if (!validDigest(candidate[field], SHA256)) fail(`W3 candidate ${field} is invalid`);
  }
  if (!validDigest(expectedProductReleaseScopeDigest, SHA256) ||
      candidate.productReleaseScopeDigest !== expectedProductReleaseScopeDigest) {
    fail("W3 candidate product release scope is stale or unbound");
  }
  if (!Number.isSafeInteger(candidate.includedCount) || candidate.includedCount < 1 ||
      !Number.isSafeInteger(candidate.excludedCount) || candidate.excludedCount < 0) {
    fail("W3 candidate file counts are invalid");
  }
  const exportDigest = sha256(JSON.stringify({
    privateSourceSha: candidate.privateSourceSha,
    privateSourceTreeOid: candidate.privateSourceTreeOid,
    exportManifestDigest: candidate.exportManifestDigest,
    publicTreeOid: candidate.publicTreeOid,
    publicCandidateSha: candidate.publicCandidateSha,
    publicFilesSha256: candidate.publicFilesSha256
  }));
  if (candidate.exportDigest !== exportDigest) fail("W3 candidate export digest is inconsistent");
  return candidate;
}

function checkedW3CandidateV2(input, expectedProductReleaseScopeDigest) {
  const candidate = plainFields(input, W3_V2_FIELDS, "W3 candidate");
  if (candidate.schemaVersion !== 2 || candidate.kind !== "W3LocalPublicCandidateV2" ||
      candidate.status !== "LOCAL_PROJECTION_VERIFIED" || candidate.authority !== "none" ||
      candidate.verifiedSurface !== "local-git-ref-object-graph-only") {
    fail("W3 V2 candidate has unexpected identity, status, or authority");
  }
  for (const field of ["privateSourceSha", "privateSourceTreeOid", "publicTreeOid", "publicCandidateSha"]) {
    if (!validDigest(candidate[field], SHA1)) fail(`W3 V2 candidate ${field} is invalid`);
  }
  for (const field of ["productReleaseScopeDigest", "approvalArtifactSha256", "exportManifestDigest",
    "publicFilesSha256", "derivedOutputsSha256", "moduleClosureReceiptDigest", "exportDigest"]) {
    if (!validDigest(candidate[field], SHA256)) fail(`W3 V2 candidate ${field} is invalid`);
  }
  if (!validDigest(expectedProductReleaseScopeDigest, SHA256) ||
      candidate.productReleaseScopeDigest !== expectedProductReleaseScopeDigest) {
    fail("W3 V2 candidate product release scope is stale or unbound");
  }
  if (!Number.isSafeInteger(candidate.includedCount) || candidate.includedCount < 1 ||
      !Number.isSafeInteger(candidate.derivedCount) ||
      candidate.derivedCount < 1 || candidate.derivedCount > 2 ||
      !Number.isSafeInteger(candidate.excludedCount) ||
      candidate.excludedCount < 2 * candidate.derivedCount) {
    fail("W3 V2 candidate file counts are invalid");
  }
  const exportDigest = sha256(JSON.stringify({
    privateSourceSha: candidate.privateSourceSha,
    privateSourceTreeOid: candidate.privateSourceTreeOid,
    productReleaseScopeDigest: candidate.productReleaseScopeDigest,
    approvalArtifactSha256: candidate.approvalArtifactSha256,
    exportManifestDigest: candidate.exportManifestDigest,
    publicTreeOid: candidate.publicTreeOid,
    publicCandidateSha: candidate.publicCandidateSha,
    publicFilesSha256: candidate.publicFilesSha256,
    derivedOutputsSha256: candidate.derivedOutputsSha256,
    moduleClosureReceiptDigest: candidate.moduleClosureReceiptDigest
  }));
  if (candidate.exportDigest !== exportDigest) fail("W3 V2 candidate export digest is inconsistent");
  return candidate;
}

function checkedW3Candidate(input, expectedProductReleaseScopeDigest) {
  const version = Object.getOwnPropertyDescriptor(input ?? {}, "schemaVersion")?.value;
  const kind = Object.getOwnPropertyDescriptor(input ?? {}, "kind")?.value;
  if (version === 1 && kind === "W3LocalPublicCandidateV1") {
    return checkedW3CandidateV1(input, expectedProductReleaseScopeDigest);
  }
  if (version === 2 && kind === "W3LocalPublicCandidateV2") {
    return checkedW3CandidateV2(input, expectedProductReleaseScopeDigest);
  }
  fail("W3 candidate version or kind is unsupported");
}

/**
 * Construct a W5 PREPARE binding from a local W3 receipt. The snapshot digest
 * covers every fixed W3 field, including scope and file counts. W5 validates
 * the target and grant shapes and computes the binding digest, but the result
 * is still caller asserted and never grants publication authority.
 */
export function createW5PublicCandidateBindingV1(input) {
  const { w3Candidate, expectedProductReleaseScopeDigest, target, grantDigest } = plainFields(input, [
    "w3Candidate", "expectedProductReleaseScopeDigest", "target", "grantDigest"
  ], "W5 candidate binding options");
  const w3 = checkedW3Candidate(w3Candidate, expectedProductReleaseScopeDigest);
  const candidate = {
    commitSha: w3.publicCandidateSha,
    manifestDigest: w3.exportManifestDigest,
    snapshotDigest: sha256(`BW:${w3.kind}\0${JSON.stringify(w3)}`),
    exportDigest: w3.exportDigest
  };
  const payload = {
    candidate,
    target: plainFields(target, TARGET_FIELDS, "W5 target"),
    grantDigest
  };
  const proposal = appendW5PublicationOperationEventV1({
    events: [],
    expectedHeadDigest: "0".repeat(64),
    expectedEventCount: 0,
    request: {
      operationId: "local-binding-preview",
      eventId: "local-binding-preview",
      op: "PREPARE",
      payload
    }
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "W5PublicCandidateBindingV1",
    authority: "none",
    inputTrustBoundary: proposal.replay.inputTrustBoundary,
    providerAuthenticity: proposal.replay.providerAuthenticity,
    stableAdmission: proposal.replay.stableAdmission,
    releaseEligible: proposal.replay.releaseEligible,
    payload: proposal.replay.binding,
    bindingDigest: proposal.replay.bindingDigest
  });
}

/**
 * Add the exact RC/GA target to W3's existing exact-candidate binding without
 * changing the W5 V1 event schema or its authority boundary. This is a distinct
 * binding kind: an old V1 preview is not a channel-aware publication binding.
 * An authenticated observer/publisher must independently rederive both the W3
 * snapshot and release target before using this caller-asserted proposal.
 */
export function createW5PublicReleaseCandidateBindingV1(input) {
  const options = plainFields(input, [
    "w3Candidate", "expectedProductReleaseScopeDigest", "target", "grantDigest",
    "releaseVersion", "expectedReleaseTargetDigest"
  ], "W5 release candidate binding options");
  const releaseTarget = resolveProductReleaseTargetV1(options.releaseVersion);
  if (!validDigest(options.expectedReleaseTargetDigest, SHA256) ||
      options.expectedReleaseTargetDigest !== releaseTarget.releaseTargetDigest) {
    fail("W5 release channel contract is stale or unbound");
  }
  const localBinding = createW5PublicCandidateBindingV1({
    w3Candidate: options.w3Candidate,
    expectedProductReleaseScopeDigest: options.expectedProductReleaseScopeDigest,
    target: options.target,
    grantDigest: options.grantDigest
  });
  if (localBinding.payload.target.tagRef !== `refs/tags/${releaseTarget.releaseTag}`) {
    fail("W5 tag ref disagrees with the manifest's exact RC/GA release target");
  }
  const payload = {
    ...localBinding.payload,
    candidate: {
      ...localBinding.payload.candidate,
      snapshotDigest: sha256(`BW:W5PublicReleaseCandidateSnapshotV1\0${JSON.stringify({
        w3SnapshotDigest: localBinding.payload.candidate.snapshotDigest,
        releaseTargetDigest: releaseTarget.releaseTargetDigest
      })}`)
    }
  };
  const proposal = appendW5PublicationOperationEventV1({
    events: [],
    expectedHeadDigest: "0".repeat(64),
    expectedEventCount: 0,
    request: { operationId: "local-release-binding-preview", eventId: "local-release-binding-preview", op: "PREPARE", payload }
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "W5PublicReleaseCandidateBindingV1",
    authority: "none",
    inputTrustBoundary: proposal.replay.inputTrustBoundary,
    providerAuthenticity: proposal.replay.providerAuthenticity,
    stableAdmission: proposal.replay.stableAdmission,
    releaseAdmission: releaseTarget.channel === "rc" ? PRODUCT_RC_ADMISSION_UNAVAILABLE : proposal.replay.stableAdmission,
    releaseEligible: false,
    releaseTarget,
    w3SnapshotDigest: localBinding.payload.candidate.snapshotDigest,
    payload: proposal.replay.binding,
    bindingDigest: proposal.replay.bindingDigest
  });
}
