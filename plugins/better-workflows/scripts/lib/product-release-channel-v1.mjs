// SPDX-License-Identifier: AGPL-3.0-only
// Pure release-target selection. Contract/digest agreement is not admission,
// provider authenticity, publisher authority, or a GA completion receipt.
import { createHash } from "node:crypto";

export const PRODUCT_RC_ADMISSION_UNAVAILABLE = "V5_RC_ADMISSION_UNAVAILABLE";
export const PRODUCT_RC_MANUAL_OPERATOR_PROCEDURE_REQUIRED = "V5_RC_MANUAL_OPERATOR_PROCEDURE_REQUIRED";

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Mirrors the accepted checked-in JSON. productReleaseScope verifies its bytes
// semantically before using either channel; caller policy cannot replace it.
export const PRODUCT_RELEASE_CHANNEL_CONTRACT_V1 = freeze({
  schemaVersion: 1,
  kind: "ProductReleaseChannelContractV1",
  id: "v5.0-macos-auto-rc-ga-20261002-r2",
  productVersion: "5.0.0",
  productReleaseScopeId: "v5.0-rc2-macos-auto-41-locales-20261007-r1",
  commonAcceptance: [
    "rights-and-corresponding-source",
    "exact-public-candidate-and-source-scope",
    "macos-node22-node24-runtime",
    "codex-gemini-cli-qwen-code-host-conformance",
    "full-formal-evaluation-and-applicable-accepted-coverage",
    "independent-review",
    "maintained-document-disposition",
    "exact-candidate-publication-operation-and-publisher-authority",
    "provider-readback",
    "owned-resource-cleanup"
  ],
  gaCanaryAcceptance: {
    minimumNaturalDays: 30,
    minimumConsecutiveEligibleStarts: 20,
    minimumDistinctRepositories: 3
  },
  rc1ManualPublication: {
    schemaVersion: 1,
    kind: "OwnerControlledManualRcPublicationContractV1",
    id: "v5.0.rc1-owner-controlled-manual-20261002-r1",
    adoptedAt: "2026-10-02",
    releaseVersion: "5.0.0-rc.1",
    publicationMode: "OWNER_CONTROLLED_MANUAL",
    publisherAuthority: "OWNER_EXACT_AUTHORIZATION",
    repository: { name: "stephen-taipei/better-workflows", id: 1400546180 },
    sourceHistory: "FRESH_SOURCE_ONLY",
    effectPolicy: "CREATE_ONLY",
    allowedEffects: ["create-source-main", "create-rc-tag", "create-rc-prerelease"],
    orderedStages: ["prepared", "sourcepublished", "remotechecks", "tagcreated", "released", "readback", "cleanup"],
    requiredEvidence: [
      "owner-exact-candidate-and-target-authorization",
      "fresh-exact-numeric-public-target-and-create-only-absence",
      "exact-candidate-public-docs-ci-host-site-and-changelog-readback"
    ],
    operationRecord: "OPERATOR_OWNED_DURABLE_EXACT_BINDING",
    unknownRecovery: "SAME_OPERATION_QUERY_RECONCILE_BEFORE_RETRY",
    receiptKind: "OwnerControlledManualRcPublicationReceiptV1",
    protectedAdmission: "NOT_ESTABLISHED",
    authority: "none",
    releaseEligible: false
  },
  channels: {
    stable: {
      version: "5.0.0",
      prerelease: false,
      makeLatest: "true",
      canaryRequiredForPublication: true,
      publicationBeforeCanaryStartAllowed: false,
      claimDisposition: "GA_REQUIRES_FULL_ACCEPTANCE_AND_CANARY"
    },
    rc: {
      versionPattern: "^5\\.0\\.0-rc\\.(0|[1-9][0-9]*)$",
      prerelease: true,
      makeLatest: "false",
      canaryRequiredForPublication: false,
      publicationBeforeCanaryStartAllowed: true,
      claimDisposition: "RC_ONLY_NO_GA_OR_COMPLETION_CLAIM"
    }
  },
  authority: "none",
  releaseEligible: false
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(kind, value) {
  return createHash("sha256").update(`BW:${kind}\0`).update(JSON.stringify(canonical(value))).digest("hex");
}

export function productReleaseChannelContractDigestV1() {
  return digest("ProductReleaseChannelContractV1", PRODUCT_RELEASE_CHANNEL_CONTRACT_V1);
}

// Only the manifest's exact release version selects the channel. An env flag,
// GA tag alias, preview label, build metadata, or caller PASS cannot select RC.
export function resolveProductReleaseTargetV1(releaseVersion) {
  const contract = PRODUCT_RELEASE_CHANNEL_CONTRACT_V1;
  if (typeof releaseVersion !== "string" || releaseVersion.length > 128 || releaseVersion !== releaseVersion.trim()) {
    throw new Error("Product release target requires an exact supported version");
  }
  const channel = releaseVersion === contract.channels.stable.version
    ? "stable"
    : new RegExp(contract.channels.rc.versionPattern).test(releaseVersion) ? "rc" : null;
  if (!channel) throw new Error(`No accepted product release channel for ${releaseVersion}`);
  const selection = contract.channels[channel];
  const rcTagParts = channel === "rc"
    ? /^(\d+)\.(\d+)\.0-rc\.(0|[1-9][0-9]*)$/.exec(releaseVersion)
    : null;
  if (channel === "rc" && !rcTagParts) {
    throw new Error(`No accepted Git tag mapping for product release version ${releaseVersion}`);
  }
  const releaseTag = channel === "stable"
    ? `v${releaseVersion}`
    : `V${rcTagParts[1]}.${rcTagParts[2]}.rc${rcTagParts[3]}`;
  // The owner adopted the manual procedure for this exact RC1 version only.
  // Target metadata selects a procedure; it does not verify or authorize it.
  const manual = channel === "rc" && releaseVersion === contract.rc1ManualPublication.releaseVersion
    ? contract.rc1ManualPublication : null;
  const body = {
    schemaVersion: 1,
    kind: "ProductReleaseTargetV1",
    channelContractId: contract.id,
    channelContractDigest: productReleaseChannelContractDigestV1(),
    productVersion: contract.productVersion,
    productReleaseScopeId: contract.productReleaseScopeId,
    releaseVersion,
    releaseTag,
    releaseName: `Better Workflows v${releaseVersion}`,
    channel,
    draft: false,
    prerelease: selection.prerelease,
    makeLatest: selection.makeLatest,
    canaryRequiredForPublication: selection.canaryRequiredForPublication,
    publicationBeforeCanaryStartAllowed: selection.publicationBeforeCanaryStartAllowed,
    claimDisposition: selection.claimDisposition,
    publicationMode: manual?.publicationMode ?? "INSTALLED_PROTECTED",
    publisherAuthority: manual?.publisherAuthority ?? "INSTALLED_PROTECTED_AUTHORITY",
    publicationContractId: manual?.id ?? contract.id,
    manualPublicationContract: manual,
    publicationAcceptance: [...contract.commonAcceptance, ...(manual?.requiredEvidence ?? [])],
    commonAcceptance: [...contract.commonAcceptance],
    gaCanaryAcceptance: { ...contract.gaCanaryAcceptance },
    authority: "none",
    releaseEligible: false
  };
  return freeze({ ...body, releaseTargetDigest: digest("ProductReleaseTargetV1", body) });
}

export function assertProductReleaseTargetManifestV1(manifest) {
  const releaseTarget = resolveProductReleaseTargetV1(manifest?.version);
  if (manifest?.releaseTag !== releaseTarget.releaseTag ||
      manifest?.releaseName !== releaseTarget.releaseName) {
    throw new Error("Product version, tag, and release name disagree with the selected release channel");
  }
  return releaseTarget;
}
