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

> **One-line positioning:** Dynamic Workflows expands the search space when a task needs adaptive breadth; Better Workflows makes the accepted path bounded, evidence-backed, and safe to integrate.

> **Important boundary:** The collaboration model below is a human- or automation-mediated operating model, not a native integration. There is no claim of shared runtime state, automatic handoff, or protocol compatibility between the two products.

### The maximum practical difference

The key difference is orchestration posture and authority:

- **Dynamic Workflows optimizes for adaptive breadth.** It can write a task-specific JavaScript harness, fan out many agents, choose models/worktrees, verify results, and loop until a task-specific stop condition is met.
- **Better Workflows optimizes for governed convergence.** It keeps mutation with Root, bounds delegated research, records deterministic state and evidence, and fails closed when freshness, authority, reconciliation, or completion evidence is missing.

Neither capability is exclusive. Better Workflows includes research and deep-review routes, while Dynamic Workflows can also implement and release changes. The distinction is what each system optimizes first: **runtime exploration scale versus deterministic mutation control**.

### Why these capabilities are not built in

This is a deliberate boundary, not an unfinished feature checklist. Better
Workflows is a governance/control plane around Codex work, not a runtime that
lets a model generate an unbounded agent harness. The `dw` helper records and
validates state, evidence, and action gates; it does not spawn agents or execute
model-generated commands.

| Capability | What this repo provides | Why the boundary is intentional |
| --- | --- | --- |
| Task-specific JavaScript harness | Explicit templates, modes, and deterministic helper logic. | A generated harness can adapt faster, but it also changes the execution plan at runtime; Better Workflows keeps the control plane inspectable before mutation. |
| Large or unbounded fan-out | At most three direct native children; no recursive delegation. | Bounds token cost, shared-file conflicts, and blast radius. |
| Adversarial verification | Refutation, research findings, and up to two sequential model-pinned critics. | Verification is preserved, but the number and order of critics remain auditable instead of expanding per generated subtask. |
| Loop-until-done | Persistent Goals, implementation queues, checkpoints, and explicit completion gates. | Work can continue across validated slices, but it cannot silently widen scope or spawn forever without fresh evidence. |
| Automatic worktree swarm | Branch/protected-branch and cleanup gates; no automatic worktree per generated subtask. | Root retains ownership of integration and cleanup, avoiding ambiguous ownership of parallel mutations. |
| Unattended long-running execution | Durable run state and resumable Goals, with explicit authority and reconciliation. | Resumability is useful; an autonomous daemon would require a separate lease, resource, cancellation, and side-effect protocol. |

**So is it unsuitable?** No. Better Workflows is the better fit when the
contract is known and the cost of an incorrect mutation is asymmetric: releases,
protected branches, API changes, security-sensitive refactors, reviews, and
maintenance. Dynamic Workflows is the better first tool when uncertainty and
scale dominate. Using both is often strongest: explore broadly, normalize a
versioned handoff, then let Better Workflows independently validate and govern
the implementation. This is an operating pattern, not native interoperability.

| Dimension | Better Workflows | Claude Dynamic Workflows |
| --- | --- | --- |
| Orchestration posture | Explicit selectors, templates, modes, and a deterministic local control plane. | A task-specific JavaScript harness is generated and composed at runtime. |
| Breadth and iteration | Small bounded waves: at most three direct children; independent critics run sequentially. | Large fan-out, adversarial verification, dynamic loops, and long-running runs when justified. |
| Mutation boundary | Root owns edits, integration, Git/GitHub, deploy, risk acceptance, and completion. Delegated agents are read-only by contract. | Models can choose subagent shape, model, and worktree isolation inside the generated harness; the task script determines the run's governance. |
| State and completion | Persistent Goal, private state, sentinels, evidence, leases, action tokens, reconciliation, and fail-closed completion. | Progress is saved and resumable; the harness coordinates convergence and returns a single result. |
| Cost and blast radius | Deliberately conservative; easier to bound cost, mutation surface, and stop conditions. | Higher scale potential, with an official warning that workflows can use substantially more tokens. |
| Best starting point | Known contract, release, refactor, review, or any change with asymmetric downside risk. | Unknown-size exploration, broad migration, codebase-wide audit, or work that earns massive parallelism. |

### Explore → Gate → Execute → Maintain

Use this as a collaboration SOP. It is a recommended operating pattern, not an automatic product handoff.

```mermaid
flowchart LR
  A["Uncertain or broad problem"] --> B["Dynamic Workflows<br/>adaptive exploration"]
  B --> C{"Versioned handoff gate<br/>goal · scope · invariants · evidence · ownership"}
  C -- "stale, drift, conflict, or missing authority" --> B
  C -- "accepted" --> D["Better Workflows<br/>root-controlled execution"]
  D --> E["Fresh validation<br/>contracts · tests · rollback"]
  E --> F["Authorized integration or release"]
  F --> G["Bounded maintenance<br/>with auditable state"]
  G -- "new uncertainty or scope expansion" --> B
```

### The versioned handoff package

Before Better Workflows accepts exploratory output, normalize it into a
versioned handoff package. This is the anti-drift boundary:

| Gate | Required artifact | Reject and return to exploration when |
| --- | --- | --- |
| Goal | Problem statement, non-goals, chosen option, rejected alternatives. | The goal or scope is still ambiguous. |
| Contract | Invariants, interfaces, acceptance tests, reproducible commands. | A public behavior or success condition is unowned. |
| Evidence | Source index, provenance, timestamps, baseline checks, unresolved findings. | Evidence is stale, unknown, or cannot be reproduced. |
| Ownership | Repository, branch, commit/worktree identity, component owners, mutation boundary. | Baseline drift, ownership conflict, or shared-file collision exists. |
| Risk and action | Dependency/security risk register, side-effect inventory, rollback plan, required authority/action tokens. | A side effect lacks authorization, reconciliation, or rollback. |

Better Workflows then independently validates the package, converts it into
its Goal/contract/evidence state, and executes only the accepted scope. If the
scope expands, the baseline changes, or a gate becomes stale, stop and send the
work back through exploration instead of silently widening the mutation surface.

### When to use one or both

| Situation | Recommended path | Why |
| --- | --- | --- |
| Small, reversible, well-understood change | Better Workflows `direct` | Dynamic orchestration cost is not earned. |
| Known contract with meaningful verification or release risk | Better Workflows `verified`, `deep`, or `critical` | Fresh evidence and authority gates matter more than fan-out. |
| Unknown architecture, many independent hypotheses, or large migration | Dynamic Workflows first, then the handoff gate | Use breadth to reduce uncertainty; do not let exploratory output bypass integration controls. |
| Production maintenance after the design is settled | Better Workflows | Preserve the contract, evidence, rollback, and auditable ownership over time. |

**Mental model:** explore wide, gate explicitly, execute narrow, maintain audibly.

## Install

Add the GitHub marketplace and install the plugin:

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

Start a new Codex task after installation so the skill catalog refreshes.

## Progressive routing: Snapshot → Preview → Execute

> **Value:** Better Workflows now explains *why* a route is usable before work
> begins. It never treats an installed name as proof that its command, support
> skill, provider, or host capability is currently callable.

```bash
# Read-only: never starts provider login or a semantic model probe.
dw doctor --capabilities

# Read-only route decision.
dw route preview \
  --goal "Consolidate Dependabot updates and clean owned resources" \
  --scope . \
  --domain maintenance \
  --tag dependabot
```

Each capability is reported as `available`, `unavailable`, `unverified`,
`unsupported`, or `requires-authority`, with its reason and fallback. Model
availability may reuse an unchanged 24-hour semantic roster cache; a miss or
expiry does not trigger a probe. Node-only v1 reports host MCP exposure as
`unsupported` and leaves that attestation to Codex.

### One primary route, one Profile

A Routing Profile selects exactly one primary entry or template. It may set a
minimum mode, require capabilities, and attach up to three **advisory-only**
support skills. It cannot install tools, grant authority, add side effects,
lower the mode, or replace an explicit picker choice.

| Precedence | Source | Rule |
| ---: | --- | --- |
| 1 | Host hard constraints | Never lowered by local configuration; absent host input is reported `unverified`. |
| 2 | Explicit entry/template/mode | The user's picker or CLI choice wins. |
| 3 | Workspace Profile | `<repo>/.codex/better-workflows.json`; a matching rule replaces personal routing. |
| 4 | Personal Profile | `$DW_STATE_ROOT/routing/profile.json`. |
| 5 | Built-in `auto` | Returns `template: null` until current evidence selects a real template. |

Inside one Profile, higher priority wins and ties keep file order. Match
categories are ANDed; values inside each category are ORed. Workspace and
personal rules are never deep-merged. See the strict
[example Profile](plugins/better-workflows/config/routing-profile.example.json).

```bash
dw route profile validate --file my-routing-profile.json
dw route profile install --file my-routing-profile.json
dw route profile show
```

### Reviewable, single-use route receipts

Use `--record` when preview and execution must be bound across a handoff:

```bash
dw route preview \
  --goal "Refactor the monorepo without changing public contracts" \
  --scope . \
  --entry monorepo-refactor \
  --record

dw run --route-receipt <route-receipt-id>
```

```mermaid
flowchart LR
  A["Capability snapshot<br/>cache-only provider state"] --> B["Route preview<br/>explicit → workspace → personal → auto"]
  B --> C{"Concrete template<br/>and required capabilities available?"}
  C -- "No" --> D["Fail closed<br/>report blocker or select a real template"]
  C -- "Yes" --> E["Private route receipt<br/>0600 · 24h · bundle digest"]
  E --> F{"Workspace, Profile, scope,<br/>catalog, capability, or bundle drift?"}
  F -- "Yes" --> D
  F -- "No" --> G["Single-use dw run<br/>mode floor preserved"]
  G --> H["Template-bound action gates<br/>fresh evidence and reconciliation"]
```

Receipts bind the goal/scope, selected route, catalog, workspace and personal
Profiles, capability fingerprint, and exact plugin bundle digest. They expire
after 24 hours and are single-use. Replay, tampering, or any binding drift fails
closed.

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
- Know the task category: choose one of the ten task entries.
- Care mainly about review depth: choose `direct`, `verified`, `deep`, or `critical`.
- Already use a legacy command: choose its compatibility alias.

### Automatic and task entries

| Entry | Recommended use | Example |
| --- | --- | --- |
| `$better-workflows:auto` | Best default for most work. Codex selects the template, verification mode, and critics from risk and evidence. | `$better-workflows:auto Review the current repository, fix verified defects, and create a PR.` |
| `$better-workflows:review-issues` | Read-only repository audit, finding deduplication, and authorized GitHub issue creation. It does not fix code. | `$better-workflows:review-issues Review the latest dev SHA and create deduplicated P0/P1/P2 issues.` |
| `$better-workflows:fix-issues-pr` | Re-check open issues, implement root-owned fixes, create a PR, then merge and clean up only when authorized. | `$better-workflows:fix-issues-pr Fix open dev issues, create a PR, wait for fresh checks, merge, and clean up.` |
| `$better-workflows:pr-to-dev` | Split all in-scope changes into atomic commits, create one PR targeting `dev`, wait for fresh checks, merge, reconcile remote state, and clean owned resources. | `$better-workflows:pr-to-dev Commit current changes in batches, open a PR to dev, merge after fresh checks, sync remote dev, and clean this run's worktree.` |
| `$better-workflows:cross-platform` | Backend and mobile/web contract work: schemas, optional fields, enums, sync behavior, version gates, and headers. | `$better-workflows:cross-platform Check the backend, iOS, and Android contact sync contract, fix issues, and create a PR.` |
| `$better-workflows:ios-static` | Swift/iOS static review and serialized `project.pbxproj` verification when local builds are prohibited or undesirable. | `$better-workflows:ios-static Review the iOS changes without building, verify new Swift files are in pbxproj, and fix static issues.` |
| `$better-workflows:localization` | Multi-locale changes, especially 41-locale key counts, ordering, exact scope, and regional variants. | `$better-workflows:localization Add these keys to all 41 locales and verify identical key order.` |
| `$better-workflows:ci-release` | CI failures, runner queues, serialized deploys, releases, remote monitoring, and receipt-based verification. | `$better-workflows:ci-release Diagnose the failing PR checks, fix them, and monitor the serialized dev deployment.` |
| `$better-workflows:browser-qa` | Webwright or simulator QA requiring current UI evidence, screenshots, and a reproducible action log. | `$better-workflows:browser-qa Verify signup and contact sync in the browser and attach screenshot evidence.` |
| `$better-workflows:research` | CLI-proven multi-model roles, evidence-backed architecture comparison, refutation, and an executable plan without majority voting. | `$better-workflows:research Compare three sync architectures, challenge each one, and produce an implementation-ready plan.` |
| `$better-workflows:monorepo-refactor` | Full workspace inventory followed by direct implementation of every eligible bounded refactor recommendation, with behavior invariants, validation, and rollback evidence. | `$better-workflows:monorepo-refactor Inventory the monorepo and implement all eligible boundary-cleanup recommendations without changing its public contract.` |

### CLI-proven multi-model deliberation

`research-deliberation` keeps the complete configured brand roster—Codex,
Claude, Gemini (through Agy), Agy, Grok, Cursor, Kimi, Qwen, and Kiro—but only
adds a CLI/model pair to the decision group after a safe semantic probe passes.
That means a missing binary, expired login, or unsafe interactive flow is
reported as unavailable, never silently substituted.

Each normal full-roster reasoning-effort profile is cached for at most 24 hours.
The cache is invalidated by expiry, `--refresh`, roster changes, or a CLI
path/binary-digest change; a targeted provider probe does not replace it.
External probes require
explicit authorization and sanitized, non-confidential material. Gemini uses
the `agy` transport in this runtime rather than a standalone `gemini` command.

Every participant also receives the same contextual reasoning-effort policy:
`medium` for bounded `direct`/`verified` work and `high` for
`auto`/`deep`/`critical` work, unless explicitly overridden. Codex receives a
native setting; Agy selects the actual `gemini-3.6-flash-medium` or
`gemini-3.6-flash-high` model variant and passes its native `--effort` flag
when supported. Agy models that reject the flag remain explicitly high- or
medium-only variants; other CLIs record prompt-guided effort without pretending
it was provider-attested.

```mermaid
flowchart LR
  A["Sanitized decision dossier"] --> B["Full brand roster\nfresh probe or valid 24h cache"]
  B --> C["Active model-bound roles\nindependent memos"]
  C --> D["Root evidence reconciliation\nno majority vote"]
  D --> E["Highest proven arbiter\nSol → Terra → Luna → Fable → Opus"]
  E --> F["Executable plan\nowner · dependencies · validation · rollback"]
  B -->|"unavailable or unsafe"| G["Record exclusion\nfail closed"]
```

```bash
node plugins/better-workflows/scripts/dw.mjs deliberation deliberate \
  --prompt-file sanitized-case.md \
  --allow-external-providers --sanitized
```

### Template-only operational routes

Dependabot consolidation is intentionally a template rather than another picker
Skill: it is a narrowly governed operational procedure that should be selected
from the current task context, while `auto` may route to it when the evidence
matches. Run it directly when you need the exact contract:

```bash
node plugins/better-workflows/scripts/dw.mjs run \
  --template dependabot-consolidation-pr-cleanup \
  --mode critical \
  --goal "Inventory Dependabot PRs, consolidate compatible updates, merge one PR, and clean only run-owned sources." \
  --scope .
```

The SOP is deliberately fail-closed:

```mermaid
flowchart LR
  A["Fresh Dependabot inventory"] --> B["Classify every PR\nconsolidate · separate · defer · exclude"]
  B --> C["Compatibility matrix\npeer · runtime · lockfile · security"]
  C --> D["One consolidation branch and bounded diff"]
  D --> E["Native install, lockfile, lint, typecheck, test, audit"]
  E --> F["One PR with current revision and fresh checks"]
  F --> G{"Merged and reconciled?"}
  G -- "No / unknown" --> H["Stop; query provider or resolve blocker"]
  G -- "Yes" --> J["Inventory repository workflows and Actions runs"]
  J --> K["Cancel run-owned queued/in-progress Actions and reconcile"]
  K --> I["Close/delete only run-owned source PRs/branches/worktrees"]
```

Its required evidence is `dependabot-inventory`, `compatibility-matrix`,
`consolidation-diff`, `lockfile-validation`, `repository-actions-inventory`,
`actions-cancelled`, `merge-result`, and `cleanup-manifest`. It checks that the
repository's workflow definitions and related Actions runs still exist and
records missing, disabled, queued, running, and terminal states. If the
provider cannot answer, the workflow stops. The template does not assume that
every Dependabot PR is safe to combine: each candidate must receive a
disposition, and cleanup is allowed only after run-owned Actions are cancelled
and the consolidation PR is terminally reconciled. The current consolidation
run and unrelated runs are never cancelled by this cleanup gate.

### Picker workflow: PR to `dev`

`pr-to-dev` governs atomic commit batches, one PR targeting `dev`, fresh required
checks, protected merge, remote `dev` reconciliation, and cleanup of only
run-owned resources. Select `$better-workflows:pr-to-dev` from the native picker,
or start the same template directly:

```bash
node plugins/better-workflows/scripts/dw.mjs run \
  --template pr-to-dev \
  --mode critical \
  --goal "Split in-scope changes into atomic commits, create one PR to dev, merge after fresh checks, sync remote dev, and clean owned worktrees." \
  --scope .
```

```mermaid
flowchart LR
  A["Inventory and commit manifest"] --> B["Review atomic commit batches"]
  B --> C["Push current head and create PR → dev"]
  C --> D["Verify current head and fresh required checks"]
  D --> E{"Protected merge succeeds?"}
  E -- "No / unknown" --> F["Stop and reconcile provider state"]
  E -- "Yes" --> G["Fetch and reconcile remote dev"]
  G --> H["Cleanup only run-owned resources"]
```

The gates are `commit-plan`, `commit-manifest`, `target-branch-dev`,
`required-checks`, `merge-result`, `remote-sync`, and `cleanup-manifest`.
Admin bypass, stale checks, unreviewed commits, and cleanup before remote
reconciliation are rejected.

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

Eleven workflow templates are included:

- `review-to-issues`
- `issues-to-root-fix-pr-merge-cleanup`
- `cross-platform-contract`
- `ios-static-pbxproj`
- `localization-41`
- `ci-release-monitor`
- `dependabot-consolidation-pr-cleanup`
- `browser-simulator-qa`
- `research-deliberation`
- `monorepo-refactor`
- `pr-to-dev`

Current Codex surfaces expose plugin Skills through native pickers: Codex CLI
uses `@` search, while the Codex App uses `/` command search. No custom prompt
installer or separate command layer is required.

## Deterministic helper

The plugin bundles a zero-runtime-dependency Node.js helper. It manages contracts, private run state, evidence, findings, bounded Git sentinels, leases, action tokens, reconciliation, doctor checks, and evaluations. It does not spawn agents, execute model-generated commands, assign severity, or perform side effects.

Run it directly from a checkout:

```bash
node plugins/better-workflows/scripts/dw.mjs doctor
node plugins/better-workflows/scripts/dw.mjs doctor --capabilities
node plugins/better-workflows/scripts/dw.mjs route preview --goal "Review this repo" --scope .
node plugins/better-workflows/scripts/dw.mjs eval
```

A global `dw` command is optional. Before a workflow uses one, it verifies that
`dw templates` contains the selected template, `dw help` lists `route preview`,
and `dw doctor --capabilities` works without provider probes. A stale helper
automatically falls back to the runner bundled with the active plugin.

## Security model

- State directories use mode `0700`; state files use `0600`.
- Agy review is limited to explicitly authorized, sanitized, non-confidential bundles.
- Agy argv transport is treated as exposed metadata and is not allowed for confidential workflows.
- The multi-model roster retains every configured brand, but only uses a CLI-proven result from a separate `medium` or `high` cache profile lasting at most 24 hours; expiry, `--refresh`, roster changes, and CLI identity changes force revalidation.
- Unknown provider outcomes require query reconciliation and are never blindly retried.
- The project assumes trusted local repositories and does not claim to sandbox malicious repository code.

## Development

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/dw.mjs eval
node scripts/plugin-cache.mjs check
```

The runtime uses only Node.js standard-library modules.

Plugin cache versions are immutable. Every content change must use a new build
version; `node scripts/plugin-cache.mjs sync` stages a missing version, verifies
the exact file manifest and digest, then atomically publishes it. It refuses to
overwrite a same-version cache with different contents. Run `dw eval` from the
final cache path before activating that version through the normal Codex plugin
refresh.

## License

MIT. See [LICENSE](LICENSE). No upstream workflow runtime is vendored; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
