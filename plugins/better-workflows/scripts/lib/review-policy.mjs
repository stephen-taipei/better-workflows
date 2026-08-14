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
  })
});

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
