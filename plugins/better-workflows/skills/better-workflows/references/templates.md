# Workflow templates

Choose exactly one primary template. Existing domain skills remain authoritative for their own procedures.

| Template | Use |
|---|---|
| `review-to-issues` | Read-only review, deduplication, and issue creation |
| `issues-to-root-fix-pr-merge-cleanup` | Revalidate issues, let root fix/integrate, then PR/merge/cleanup |
| `cross-platform-contract` | Backend plus iOS/Android/Web contract changes |
| `ios-static-pbxproj` | Swift static review and serialized pbxproj membership |
| `localization-41` | Complete 41-locale updates and key/order validation |
| `ci-release-monitor` | Serialized CI, deploy, promotion, and reconciliation |
| `dependabot-consolidation-pr-cleanup` | Inventory Dependabot PRs, consolidate compatible updates, validate lockfiles, merge one PR, and clean only run-owned sources |
| `pr-to-dev` | Partition changes into atomic commits, create one PR targeting `dev`, merge after fresh checks, reconcile remote state, and clean owned resources |
| `browser-simulator-qa` | Current-state browser or simulator QA with artifacts |
| `research-deliberation` | CLI-proven multi-model roles, refutation, evidence reconciliation, and executable decision plan |
| `self-improve-ops` | Turn recent workflow evidence into a synchronized Better Workflows change-or-no-change decision with independently gated cache publication and remote delivery |
| `monorepo-refactor` | Inventory a monorepo and implement every eligible bounded recommendation with validation and rollback evidence |

Use the JSON definitions under the plugin `templates/` directory as the machine-readable source of required evidence and policy gates.
The review capability matrix and authoring SOP are in
[`review-profiles.md`](review-profiles.md).

Every installed template now declares a v2 control-plane policy and execution
stages. Non-direct runs receive typed evidence admission and a replayable
`ledger.json`; review-enabled templates additionally require an immutable review
package and final broad-review closure. Review-enabled templates also declare a
bound `reviewProfile` in their task contract. The profile is a capability
statement, not a model roster: legacy profiles bind the immutable diff manifest,
package-bound locations, broad-review receipt, package provenance, and the exact
instruction digest. `self-improve-ops` alone uses the shadow-only
`code-v2-pilot` profile with exact work-unit accounting, independently attested
review lanes, finder/verifier separation, deterministic source-quote
resolution, and two aggregate typed receipts; it remains unable to authorize
side effects. Do not infer kernel guarantees from a legacy profile or promote
the pilot by changing a template JSON field alone. Only `monorepo-refactor` and
`self-improve-ops` enable the design-packet/refinement pilots, and only
`research-deliberation` plus `self-improve-ops` enable atomic deliberation.
