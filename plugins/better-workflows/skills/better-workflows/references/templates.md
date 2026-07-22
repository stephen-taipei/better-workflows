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
| `browser-simulator-qa` | Current-state browser or simulator QA with artifacts |
| `research-deliberation` | Multi-perspective research, refutation, and evidence-based decision |

Use the JSON definitions under the plugin `templates/` directory as the machine-readable source of required evidence and policy gates.
