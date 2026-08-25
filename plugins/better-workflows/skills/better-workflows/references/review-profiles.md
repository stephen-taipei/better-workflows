# Review profiles

Template review profiles turn multi-perspective review ideas into bounded
capability claims. They do not select a permanent model roster and they never
grant authority to a reviewer or provider.

## Capability matrix

| Capability | `review-contract-v1` | `review-kernel-v2-pilot` | `review-quorum-v1` |
|---|---|---|
| Changed surface | Immutable `BASE..HEAD` diff manifest | Deterministic `diff-files-v1` work-unit universe | Immutable package diff, rederived at admission |
| Location binding | Package-bound path/location | Exact blob, content digest, and unique source quote | Package-bound paths plus base/head/merge-base and changed-path classifier |
| Finding verification | Final broad-review receipt and applicable independent critic | Different host-attested finder/verifier executions; `CONFIRMED`, `REFUTED`, `PARTIAL`, `OUT_OF_SCOPE`, or `INCONCLUSIVE` | Five fixed roles; all signed `PASS`, otherwise `HOLD` |
| Provenance | Immutable review package, contract, template, and sentinel bindings | Same bindings plus native read-only execution attestation | Same bindings plus unique identity/key, provider-family diversity, receipt signatures, and bounded expiry |
| Spec/prompt | Exact review instruction digest | Exact review instruction digest plus lane/claim input digests | Exact instruction, dossier, policy, role-assignment, and report digests |
| Authority | Existing template action gates | Observe-only; no action token | Existing protected action gates; no admin bypass or direct protected-branch push |

`review-contract-v1` is intentionally honest about the legacy review path. It
does not imply per-file accounting, exact source re-anchoring, or symmetric
finder/verifier review. `review-kernel-v2-pilot` is restricted to
`self-improve-ops` until its receipts, prompts, and action lifecycle are
integrated for another workflow.

`review-quorum-v1` is restricted to the separate `pr-to-dev-agent-quorum`
template and ordinary low-risk diffs. It is a software-layer review route, not
a replacement for the host trust root. The classifier sends governance,
evaluator, identity, evidence-verifier, routing/authority, workflow, template,
and other ambiguous changes to the host-trusted legacy path.

## Authoring SOP

1. Select the existing review policy first. Do not change `code-v1`,
   `finding-v1`, or `static-v1` to `code-v2-pilot` by editing a template field.
2. Declare exactly one profile matching the policy. The profile is copied into
   the TaskContract and its digest is included in the immutable review package.
3. Keep legacy templates on `review-contract-v1` until deterministic work-unit,
   source-quote, independent execution, and aggregate typed-receipt support
   are all implemented and tested for that template.
4. For the kernel pilot, complete every required lane even with zero findings;
   run `sbw review coverage` and `sbw review synthesize`, then re-check the
   current sentinel and review continuity before any handoff.
5. Treat `REFUTED`, `OUT_OF_SCOPE`, and `INCONCLUSIVE` as durable review
   outcomes. Never delete a claim or turn an unverified premise into a higher
   severity.
6. Add the profile assertion to template fixtures, graph validation, and docs
   in the same change. Bump the semantic and plugin build versions; never
   overwrite an existing cache version.
