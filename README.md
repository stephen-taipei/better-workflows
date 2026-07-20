# Better Workflows

[English](README.md) | [繁體中文](docs/README.zh-TW.md) | [简体中文](docs/README.zh-CN.md) | [日本語](docs/README.ja.md) | [한국어](docs/README.ko.md)

Native-first, evidence-driven workflow orchestration for Codex.

Better Workflows keeps one root agent responsible for edits and side effects, uses small bounded waves of native subagents for research and review, and adds deterministic state, freshness, evidence, and action-token gates for higher-risk tasks.

## Design

Better Workflows is deliberately a governed orchestration layer, not an
unbounded agent swarm. Its design principles are:

- **Root-owned mutation:** the root agent is the only authority that edits,
  integrates, performs Git/GitHub mutations, deploys, accepts risk, or declares
  completion.
- **Evidence before side effects:** evidence, freshness, authorization, and
  provider reconciliation are required before an irreversible action; unknown
  outcomes fail closed.
- **Bounded delegation:** native subagents are limited to research, review,
  testing evidence, and refutation. Fan-out is capped at three direct children
  with no recursive delegation, and independent model critics run sequentially.
- **Persistent intent:** `/goal` preserves the requested outcome across turns;
  templates and modes define verification depth without silently changing the
  goal.
- **Deterministic control plane:** the `dw` helper records contracts, private
  state, sentinels, evidence, findings, leases, action tokens, and
  reconciliation; it does not execute model-generated commands.
- **Explicit completion:** a run is complete only when acceptance evidence is
  current, required checks pass, rollback is usable, and no unresolved
  high-risk or unknown state remains.
- **Fast path remains explicit:** `direct` avoids workflow journaling for small,
  reversible work instead of making every task pay the full orchestration cost.

This trades some peak parallel throughput for a smaller, inspectable mutation
surface and predictable stop conditions. The trade-off is intentional: the
workflow should make unsafe progress difficult to hide, even when that means
pausing for evidence or user authority.

## Better Workflows vs. Claude Dynamic Workflows

This comparison treats “Claude Dynamic Workflows” as Anthropic's Claude Code
feature, not a third-party package. It is based on Anthropic's public material
checked on 2026-07-20: [Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code),
[A harness for every task](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code),
and [Claude Code's parallel-agent documentation](https://code.claude.com/docs/en/agents).

| Dimension | Better Workflows | Claude Dynamic Workflows |
| --- | --- | --- |
| Orchestration | Selectors, templates, explicit modes, and a deterministic local control plane. | Claude dynamically writes a JavaScript harness for the task, then coordinates the run. |
| Parallelism | Small bounded native waves: at most three direct children, with sequential critics. | Designed for large fan-out and long-running work; Anthropic describes tens to hundreds of parallel subagents. |
| State and completion | Persistent `/goal`, private run state, sentinels, evidence, action tokens, reconciliation, and fail-closed completion. | Workflow progress is saved so interrupted runs can resume; the generated harness determines much of the run shape. |
| Mutation governance | Root-only mutation and integration; delegated agents are read-only by contract. | Supports subagents, worktrees, model selection, and permission controls, but the workflow itself is dynamically authored for the task. |
| Adaptability | Lower runtime freedom, but the behavior is easier to review before side effects and easier to reproduce from templates. | Higher runtime adaptability and better fit for unknown-size, highly parallel, adversarial, or multi-day work. |
| Throughput and cost | Intentionally conservative; fewer parallel workers can mean lower peak throughput, but the cost and blast radius are easier to bound. | Higher throughput potential, with a documented warning that dynamic workflows can consume substantially more tokens. |
| Portability | Codex-native plugin and Node.js helper; portable across repositories that can run the plugin. | Claude Code CLI, Desktop, VS Code extension, API, and supported cloud providers. |
| Best fit | Contract-sensitive refactors, reviews, releases, and Git/GitHub operations where evidence and rollback matter. | Large migrations, codebase-wide exploration, massive verification, and tasks where dynamically generated orchestration is the main advantage. |

### Practical trade-offs

Better Workflows is stronger when the primary risk is uncontrolled mutation,
unclear authority, stale evidence, or an irreversible side effect. Its explicit
queues, checkpoints, and fail-closed gates make it easier to explain why a run
stopped and what must be reconciled before it can continue.

Claude Dynamic Workflows is stronger when the primary bottleneck is orchestration
scale: many independent subtasks, long-running execution, dynamic loops, or
large migrations. Anthropic's own guidance also says workflows are not needed
for every task and may use significantly more tokens, so that scale is a
deliberate cost/latency trade-off rather than a universal improvement.

These are different optimization targets, not a claim that one system wins every
benchmark. Better Workflows optimizes for governed, reviewable progress inside
Codex; Claude Dynamic Workflows optimizes for dynamically generated, highly
parallel harnesses inside Claude Code.

## Install

Add the GitHub marketplace and install the plugin:

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

Start a new Codex task after installation so the skill catalog refreshes.

## Use in Codex

Restart Codex or open a new task after installation.

### Codex CLI

In Codex CLI, start with `@` and search `better`, then select a Better Workflows
skill or entry from the CLI picker.

![Better Workflows entries in the Codex CLI skill picker](docs/assets/better-workflows-skill-picker-cli.png)

### Codex App

In the Codex App, start with `/` and search `better`, then choose the matching
command or skill entry from the App picker.

![Better Workflows commands in the Codex App command picker](docs/assets/better-workflows-skill-picker-app.png)

On either surface, choose an entry and describe the outcome. The picker inserts
the selected `$better-workflows:<name>` reference. You do not need to type
`/goal`, remember template names, or choose model aliases. The recommended
default is:

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
| `$better-workflows:monorepo-refactor` | Full workspace inventory followed by direct implementation of every eligible bounded refactor recommendation, with behavior invariants, validation, and rollback evidence. | `$better-workflows:monorepo-refactor Inventory the monorepo and implement all eligible boundary-cleanup recommendations without changing its public contract.` |

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

The skill inspects or continues the active goal, inventories the full workspace,
and then implements every recommendation that is inside scope and passes the
safety gates. It continues through validated slices instead of stopping at a
recommendation list. `AUDIT_ONLY` and `APPROVAL_GATED` remain explicit modes
when you want a read-only result or approval between slices. The goal is marked
complete only after the eligible recommendation queue is empty and validation
and rollback evidence pass.

For example:

```text
$better-workflows:monorepo-refactor Inventory the monorepo, then directly implement all eligible boundary-cleanup recommendations without changing public behavior.
```

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

Current Codex surfaces expose plugin Skills through native pickers: Codex CLI
uses `@` search, while the Codex App uses `/` command search. No custom prompt
installer or separate command layer is required.

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
