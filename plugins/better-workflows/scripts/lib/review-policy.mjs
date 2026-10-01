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
  LEGACY: "review-contract-v1"
});

export function validateReviewProfile(profile, { reviewPolicy = null } = {}) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("TaskContract reviewProfile must be an object");
  }
  if (Object.keys(profile).sort().join("\0") !== [...REVIEW_PROFILE_KEYS].sort().join("\0")) {
    throw new Error("TaskContract reviewProfile has unknown or missing fields");
  }
  if (profile.schemaVersion !== 1 || typeof profile.id !== "string" || !SAFE_ID.test(profile.id)) {
    throw new Error("TaskContract reviewProfile identity is invalid");
  }
  const expected = profile.id === REVIEW_PROFILE_IDS.LEGACY ? LEGACY_REVIEW_PROFILE : null;
  if (!expected || Object.entries(expected).some(([key, value]) => profile[key] !== value)) {
    throw new Error("TaskContract reviewProfile capability set is invalid");
  }
  if (reviewPolicy === "none") {
    throw new Error("TaskContract reviewProfile requires an enabled review policy");
  }
  if (reviewPolicy !== null && !REVIEW_POLICIES.includes(reviewPolicy)) {
    throw new Error("TaskContract reviewProfile policy is unsupported by public Auto");
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
  reviewPolicyTraits(policy);
  return false;
}

export function quorumReviewEnabled(policy) {
  reviewPolicyTraits(policy);
  return false;
}

const PRE_REVIEW_LOCAL_ACTIONS = new Set(["git.commit"]);

// A commit freezes a reviewable HEAD and is still gated by the contract's
// change inventory, commit plan, patch review, and repository checks. Requiring
// the final HEAD review before that commit exists creates an impossible cycle.
// Every remote or publication action continues to require completed review.
export function completedReviewRequiredForAction(action) {
  return !PRE_REVIEW_LOCAL_ACTIONS.has(String(action));
}
