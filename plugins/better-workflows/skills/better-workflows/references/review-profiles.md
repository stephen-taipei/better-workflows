# Review profiles

Template review profiles turn multi-perspective review ideas into bounded
capability claims. They do not select a permanent model roster and they never
grant authority to a reviewer or provider.

## Capability matrix

| Capability | `review-contract-v1` | `review-kernel-v2-pilot` |
|---|---|---|
| Changed surface | Immutable `BASE..HEAD` diff manifest | Deterministic `diff-files-v1` work-unit universe |
| Location binding | Package-bound path/location | Exact blob, content digest, and unique source quote |
| Finding verification | Final broad-review receipt and applicable independent critic | Different host-attested finder/verifier executions; `CONFIRMED`, `REFUTED`, `PARTIAL`, `OUT_OF_SCOPE`, or `INCONCLUSIVE` |
| Provenance | Immutable review package, contract, template, and sentinel bindings | Same bindings plus native read-only execution attestation |
| Spec/prompt | Exact review instruction digest | Exact review instruction digest plus lane/claim input digests |
| Authority | Existing template action gates | Observe-only; no action token |

`review-contract-v1` is intentionally honest about the legacy review path. It
does not imply per-file accounting, exact source re-anchoring, or symmetric
finder/verifier review. `review-kernel-v2-pilot` is restricted to
`self-improve-ops` until its receipts, prompts, and action lifecycle are
integrated for another workflow.

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
