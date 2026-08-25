const POLICY_TRAITS = Object.freeze({
  none: Object.freeze({
    reviewEnabled: false,
    packageBindingRequired: false,
    kernel: null
  }),
  "static-v1": Object.freeze({
    reviewEnabled: true,
    packageBindingRequired: true,
    kernel: null
  }),
  "code-v1": Object.freeze({
    reviewEnabled: true,
    packageBindingRequired: true,
    kernel: null
  }),
  "finding-v1": Object.freeze({
    reviewEnabled: true,
    packageBindingRequired: true,
    kernel: null
  }),
  "code-v2-pilot": Object.freeze({
    reviewEnabled: true,
    packageBindingRequired: true,
    kernel: "review-kernel-v2-pilot"
  }),
  "agent-quorum-v1": Object.freeze({
    reviewEnabled: true,
    packageBindingRequired: true,
    kernel: null,
    quorum: "agent-review-quorum-v1"
  })
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LEGACY_REVIEW_PROFILE = Object.freeze({
  changedSurfaceAccounting: "diff-manifest-v1",
  anchorResolution: "package-bound-location-v1",
  findingVerification: "broad-review-v1",
  provenanceBinding: "review-package-v1",
  specBinding: "instruction-digest-v1"
});
const KERNEL_REVIEW_PROFILE = Object.freeze({
  changedSurfaceAccounting: "work-unit-accounting-v1",
  anchorResolution: "exact-quote-v1",
  findingVerification: "finder-verifier-v1",
  provenanceBinding: "host-attested-native-v1",
  specBinding: "instruction-digest-v1"
});
const QUORUM_REVIEW_PROFILE = Object.freeze({
  schemaVersion: 1,
  id: "review-quorum-v1",
  changedSurfaceAccounting: "diff-manifest-v1",
  anchorResolution: "package-bound-location-v1",
  findingVerification: "broad-review-v1",
  provenanceBinding: "agent-review-quorum-v1",
  specBinding: "instruction-digest-v1"
});
const REVIEW_PROFILE_KEYS = Object.freeze([
  "schemaVersion",
  "id",
  "changedSurfaceAccounting",
  "anchorResolution",
  "findingVerification",
  "provenanceBinding",
  "specBinding"
]);

export const REVIEW_PROFILE_IDS = Object.freeze({
  LEGACY: "review-contract-v1",
  KERNEL: "review-kernel-v2-pilot",
  QUORUM: "review-quorum-v1"
});

export function validateReviewProfile(profile, { template = null, reviewPolicy = null } = {}) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("TaskContract reviewProfile must be an object");
  }
  if (Object.keys(profile).sort().join("\0") !== [...REVIEW_PROFILE_KEYS].sort().join("\0")) {
    throw new Error("TaskContract reviewProfile has unknown or missing fields");
  }
  if (profile.schemaVersion !== 1 || typeof profile.id !== "string" || !SAFE_ID.test(profile.id)) {
    throw new Error("TaskContract reviewProfile identity is invalid");
  }
  const expected = profile.id === REVIEW_PROFILE_IDS.KERNEL
    ? KERNEL_REVIEW_PROFILE
    : profile.id === REVIEW_PROFILE_IDS.QUORUM
      ? QUORUM_REVIEW_PROFILE
    : profile.id === REVIEW_PROFILE_IDS.LEGACY
      ? LEGACY_REVIEW_PROFILE
      : null;
  if (!expected || Object.entries(expected).some(([key, value]) => profile[key] !== value)) {
    throw new Error("TaskContract reviewProfile capability set is invalid");
  }
  if (reviewPolicy === "none") {
    throw new Error("TaskContract reviewProfile requires an enabled review policy");
  }
  const kernel = profile.id === REVIEW_PROFILE_IDS.KERNEL;
  if (kernel && (reviewPolicy !== "code-v2-pilot" || template !== "self-improve-ops")) {
    throw new Error("TaskContract review-kernel-v2-pilot is restricted to self-improve-ops");
  }
  if (profile.id === REVIEW_PROFILE_IDS.QUORUM && reviewPolicy !== "agent-quorum-v1") {
    throw new Error("TaskContract review-quorum-v1 requires agent-quorum-v1");
  }
  if (profile.id !== REVIEW_PROFILE_IDS.QUORUM && reviewPolicy === "agent-quorum-v1") {
    throw new Error("TaskContract agent-quorum-v1 requires the review-quorum-v1 profile");
  }
  if (!kernel && reviewPolicy === "code-v2-pilot") {
    throw new Error("TaskContract code-v2-pilot requires the review-kernel-v2-pilot profile");
  }
  return profile;
}

export const REVIEW_POLICIES = Object.freeze(Object.keys(POLICY_TRAITS));

export function reviewPolicyTraits(policy) {
  const normalized = policy ?? "none";
  const traits = POLICY_TRAITS[normalized];
  if (!traits) throw new Error(`Unknown review policy: ${policy}`);
  return traits;
}

export function reviewEnabled(policy) {
  return reviewPolicyTraits(policy).reviewEnabled;
}

export function reviewPackageBindingRequired(policy) {
  return reviewPolicyTraits(policy).packageBindingRequired;
}

export function reviewKernelEnabled(policy) {
  return reviewPolicyTraits(policy).kernel === "review-kernel-v2-pilot";
}

export function quorumReviewEnabled(policy) {
  return reviewPolicyTraits(policy).quorum === "agent-review-quorum-v1";
}
