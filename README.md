# Better Workflows

[English](README.md) | [繁體中文](docs/README.zh-TW.md) | [简体中文](docs/README.zh-CN.md) | [日本語](docs/README.ja.md) | [한국어](docs/README.ko.md)

Native-first, evidence-driven workflow orchestration for Codex.

Better Workflows keeps one root agent responsible for edits and side effects, uses small bounded waves of native subagents for research and review, and adds deterministic state, freshness, evidence, and action-token gates for higher-risk tasks.

## Design

- Root is the only authority that edits, integrates, performs Git/GitHub mutations, deploys, accepts risk, or declares completion.
- Native subagents are bounded to research, review, testing evidence, and refutation. They are a trusted orchestration contract, not an OS sandbox.
- Native fan-out is limited to three direct children with no recursive delegation.
- Independent model critics run sequentially after the native wave.
- Side effects fail closed when evidence, freshness, authorization, or reconciliation is incomplete.
- Better Workflows selectors and compatibility aliases use persistent Codex `/goal` checkpoints by default.
- `direct` mode creates no workflow journal and preserves fast everyday operation.

## Install

Add the GitHub marketplace and install the plugin:

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

Start a new Codex task after installation so the skill catalog refreshes.

## Use in Codex

Restart Codex or open a new task after installation. Press `@` and search
`better`, or type `/skills` and choose `List skills`, to open the built-in Skill
picker.

![Better Workflows entries in the Codex Skill picker](docs/assets/better-workflows-skill-picker.png)

Choose an entry, then describe the outcome. The picker inserts the selected
`$better-workflows:<name>` reference. You do not need to type `/goal`, remember
template names, or choose model aliases. The recommended default is:

```text
$better-workflows:auto <describe the outcome you need>
```

For example:

```text
$better-workflows:cross-platform Check the backend, iOS, and Android contact sync contract, fix issues, and create a PR.
```

Every entry starts or continues a persistent Codex Goal before substantial
work, including `direct`. If an unrelated unfinished Goal already exists, the
workflow stops and asks you to use `/goal edit` or `/goal clear` instead of
silently replacing it.

### Choose quickly

- Unsure which workflow to use: choose `auto`.
- Know the task category: choose one of the nine task entries.
- Care mainly about review depth: choose `direct`, `verified`, `deep`, or `critical`.
- Already use a legacy command: choose its compatibility alias.

### Automatic and task entries

| Entry | Recommended use | Example |
| --- | --- | --- |
| `$better-workflows:auto` | Best default for most work. Codex selects the template, verification mode, and critics from risk and evidence. | `$better-workflows:auto Review the current repository, fix verified defects, and create a PR.` |
| `$better-workflows:review-issues` | Read-only repository audit, finding deduplication, and authorized GitHub issue creation. It does not fix code. | `$better-workflows:review-issues Review the latest dev SHA and create deduplicated P0/P1/P2 issues.` |
| `$better-workflows:fix-issues-pr` | Re-check open issues, implement root-owned fixes, create a PR, then merge and clean up only when authorized. | `$better-workflows:fix-issues-pr Fix open dev issues, create a PR, wait for fresh checks, merge, and clean up.` |
| `$better-workflows:cross-platform` | Backend and mobile/web contract work: schemas, optional fields, enums, sync behavior, version gates, and headers. | `$better-workflows:cross-platform Check the backend, iOS, and Android contact sync contract, fix issues, and create a PR.` |
| `$better-workflows:ios-static` | Swift/iOS static review and serialized `project.pbxproj` verification when local builds are prohibited or undesirable. | `$better-workflows:ios-static Review the iOS changes without building, verify new Swift files are in pbxproj, and fix static issues.` |
| `$better-workflows:localization` | Multi-locale changes, especially 41-locale key counts, ordering, exact scope, and regional variants. | `$better-workflows:localization Add these keys to all 41 locales and verify identical key order.` |
| `$better-workflows:ci-release` | CI failures, runner queues, serialized deploys, releases, remote monitoring, and receipt-based verification. | `$better-workflows:ci-release Diagnose the failing PR checks, fix them, and monitor the serialized dev deployment.` |
| `$better-workflows:browser-qa` | Webwright or simulator QA requiring current UI evidence, screenshots, and a reproducible action log. | `$better-workflows:browser-qa Verify signup and contact sync in the browser and attach screenshot evidence.` |
| `$better-workflows:research` | Evidence-backed research, architecture comparison, independent perspectives, and refutation without majority voting. | `$better-workflows:research Compare three sync architectures, challenge each one, and recommend a decision.` |
| `$better-workflows:monorepo-refactor` | Bounded monorepo refactoring with workspace inventory, slice plans, behavior invariants, validation, and rollback evidence. | `$better-workflows:monorepo-refactor Extract this package boundary without changing its public contract.` |

### Review-strength entries

These entries let Codex choose the task template while you set the minimum
verification depth.

| Entry | Recommended use | Example |
| --- | --- | --- |
| `$better-workflows:direct` | Small, reversible, well-understood work where speed matters. Uses a persistent Goal but no workflow journal or critics. | `$better-workflows:direct Fix this one-line documentation typo and verify the diff.` |
| `$better-workflows:verified` | Normal engineering work that benefits from 1–3 read-only research/review/refutation agents and freshness evidence. | `$better-workflows:verified Review and fix the pagination bug, then create a PR.` |
| `$better-workflows:deep` | Architecture, security, broad refactors, or uncertain changes needing verified work plus independent Codex critics. | `$better-workflows:deep Review the auth redesign, fix verified issues, and produce a migration-safe PR.` |
| `$better-workflows:critical` | Releases, migrations, production operations, destructive cleanup, or irreversible side effects requiring fail-closed gates and mandatory independent evidence. | `$better-workflows:critical Run the production release only after all policy, remote-SHA, and reconciliation gates pass.` |

### Compatibility aliases

Use these when migrating existing habits. They route into the same Goal-first,
root-owned Better Workflows engine; they do not revive retired parallel-writing
workflows.

| Entry | Recommended use | Equivalent route |
| --- | --- | --- |
| `$better-workflows:auto-improve` | Legacy `autoImprove`: review, verify findings, fix, create PR, and converge safely. | Fix issues to PR, `deep` by default |
| `$better-workflows:auto-issues` | Legacy `autoIssues`: read-only review plus deduplicated issue creation. | Review to issues, `verified` by default |
| `$better-workflows:ai-meeting-tw` | Legacy AI meeting: multi-perspective research and model critics without Claude or vote counting. | Research deliberation, `deep` by default |
| `$better-workflows:git-check-issues` | Legacy issue repair: re-fetch issue state, fix active issues, create PR, and clean up precisely. | Fix issues to PR, `deep` by default |
| `$better-workflows` | Natural-language router when you do not select a specific menu entry. | Automatic template and mode routing |

## Modes and templates

Goal mode controls persistence; Better Workflows mode controls verification
depth. They are independent.
For a bounded monorepo refactor, choose `$better-workflows:monorepo-refactor`
from the Skill picker. It uses the native persistent Goal flow and supports
`AUDIT_ONLY`, `APPROVAL_GATED`, and `AUTONOMOUS` execution contracts:

```text
$better-workflows:monorepo-refactor Refactor the shared package boundary without changing public behavior.
```

The skill inspects or continues the active goal, pauses at approval checkpoints,
and marks the goal complete only after validation and rollback evidence pass.

Better Workflows chooses one of four modes:

| Mode | Behavior |
| --- | --- |
| `direct` | Root works normally without durable workflow state. |
| `verified` | Root plus one to three native research/review/refutation agents. |
| `deep` | Verified work followed by up to two sequential Codex critics. |
| `critical` | Full evidence and side-effect gates plus a required external reviewer when policy demands it. |

Nine workflow templates are included:

- `review-to-issues`
- `issues-to-root-fix-pr-merge-cleanup`
- `cross-platform-contract`
- `ios-static-pbxproj`
- `localization-41`
- `ci-release-monitor`
- `browser-simulator-qa`
- `research-deliberation`
- `monorepo-refactor`

Current Codex builds expose plugin Skills through the built-in `/skills` menu.
No custom prompt installer or separate command layer is required.

## Deterministic helper

The plugin bundles a zero-runtime-dependency Node.js helper. It manages contracts, private run state, evidence, findings, bounded Git sentinels, leases, action tokens, reconciliation, doctor checks, and evaluations. It does not spawn agents, execute model-generated commands, assign severity, or perform side effects.

Run it directly from a checkout:

```bash
node plugins/better-workflows/scripts/dw.mjs doctor
node plugins/better-workflows/scripts/dw.mjs eval
```

## Security model

- State directories use mode `0700`; state files use `0600`.
- Agy review is limited to explicitly authorized, sanitized, non-confidential bundles.
- Agy argv transport is treated as exposed metadata and is not allowed for confidential workflows.
- Unknown provider outcomes require query reconciliation and are never blindly retried.
- The project assumes trusted local repositories and does not claim to sandbox malicious repository code.

## Development

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/dw.mjs eval
```

The runtime uses only Node.js standard-library modules.

## License

MIT. See [LICENSE](LICENSE). No upstream workflow runtime is vendored; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
