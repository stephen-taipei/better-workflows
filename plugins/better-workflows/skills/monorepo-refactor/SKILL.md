---
name: monorepo-refactor
description: Safely inventory, plan, implement, validate, and document all eligible bounded refactoring recommendations in large monorepos while preserving behavior, contracts, data integrity, security boundaries, and rollback capability. Use for monorepo architecture refactors, package or module extraction, dependency-boundary cleanup, workspace migrations, and requests that require persistent /goal checkpoints.
---

# Monorepo Refactor

Read `../better-workflows/SKILL.md` completely and follow its root-only
mutation, evidence, freshness, and side-effect rules. This skill adds a
monorepo-specific execution contract; it does not replace the Better Workflows
goal contract or the repository's own `AGENTS.md` instructions.

## Goal-first entry contract

Use Codex's persistent `/goal` flow for every invocation:

1. Inspect the current goal before substantial work.
2. Create a goal from the requested outcome when none exists.
3. Continue an active goal only when it describes this same refactor.
4. Stop and ask the user to use `/goal edit` or `/goal clear` when an unrelated
   unfinished goal exists; never replace it silently.
5. Keep the goal active across checkpoints and turns. Mark it complete only
   after every eligible recommendation is implemented and validated (or an
   explicit fail-closed condition is recorded), rollback evidence exists, and
   the final report pass succeeds.

Use the `monorepo-refactor` workflow template with `verified` for audit-only
work, `deep` for approval-gated implementation, and `critical` when the risk
map requires independent external evidence. These Better Workflows modes are
verification depth; do not confuse them with the execution modes below.

## Execution modes

Default to `AUTONOMOUS` for an implementation request, including requests to
"盤點完所有項目後直接實作所有建議" or equivalent wording. Use
`APPROVAL_GATED` when the user asks to review a plan first, withholds
implementation authority, or the mission contract is ambiguous. Use
`AUDIT_ONLY` only when the user explicitly requests a read-only audit.

- `AUDIT_ONLY`: inspect and build private audit artifacts, architecture maps,
  candidate rankings, and slice plans. Do not edit product files, stage, commit,
  install packages, migrate databases, or perform remote operations.
- `APPROVAL_GATED`: complete pre-flight, inventory, risk map, baseline,
  capability map, and slice plan; stop at the first checkpoint. After approval,
  execute one slice, validate it, commit it atomically, and stop again. Do not
  treat the approved plan as completion; continue only after each next slice is
  approved.
- `AUTONOMOUS`: continue between machine-verifiable checkpoints only when the
  mission contract, scope, invariants, validation capability, isolation, and
  side-effect authority are explicit. After the complete inventory and
  candidate ranking, turn every eligible recommendation into the implementation
  queue and execute the queue to exhaustion. Stop at every configured limit or
  any fail-closed condition, but never stop merely because a recommendation list
  or slice plan has been produced.

If `PRIMARY_GOAL`, `TARGET_SCOPE`, or `BEHAVIOR_INVARIANTS` is missing and
cannot be derived without choosing a high-impact product direction, perform an
audit and request the missing contract. Treat that run as `AUDIT_ONLY`; do not
invent authority in order to implement a recommendation.

## Mission contract and limits

Record the mission contract before implementation. Use these defaults when the
user has not supplied a value:

```text
MAX_SLICES=3
MAX_TOTAL_COMMITS=8
MAX_PROJECTS_PER_SLICE=3
MAX_FILES_PER_SLICE=25
MAX_CHANGED_LINES_PER_SLICE=1500
MAX_SCOPE_EXPANSIONS=1
MAX_COMMAND_RETRIES=2
RECOMMENDATION_DISPOSITION=IMPLEMENT_ALL_ELIGIBLE

ALLOW_LOCAL_BRANCH_CREATION=true
ALLOW_LOCAL_COMMITS=true
ALLOW_REMOTE_OPERATIONS=false
ALLOW_DEPENDENCY_CHANGES=false
ALLOW_LOCKFILE_CHANGES=false
ALLOW_DATABASE_MIGRATIONS=false
ALLOW_DATABASE_WRITES=false
ALLOW_PRODUCTION_IO=false
ALLOW_EXTERNAL_API_WRITES=false
ALLOW_QUEUE_CONSUMPTION=false
ALLOW_PUBLIC_CONTRACT_CHANGES=false
ALLOW_AUTHORIZATION_CHANGES=false
ALLOW_PAYMENT_CHANGES=false
ALLOW_SECRET_HANDLING_CHANGES=false
ALLOW_DEPLOYMENT_CONFIG_CHANGES=false
```

Keep the source-of-truth order: user request, repository architecture decisions
and specifications, actual validation results, source/configuration, project
metadata, history, then model inference. Mark important claims
`CONFIRMED`, `INFERRED`, `UNVERIFIED`, or `CONFLICTING`; never present an
inference as repository fact.

## Required phases

Execute and persist these phases in order. Do not skip pre-flight, baseline,
slice planning, or validation:

```text
PHASE_0_PRE_FLIGHT
PHASE_1_WORKSPACE_INVENTORY
PHASE_2_ARCHITECTURE_AND_RISK_MAP
PHASE_3_BASELINE_AND_CAPABILITY_MAP
PHASE_4_CANDIDATE_RANKING
PHASE_5_SLICE_PLAN
PHASE_6_SLICE_IMPLEMENTATION
PHASE_7_SLICE_VALIDATION
PHASE_8_FINAL_VALIDATION
PHASE_9_FINAL_REPORT
```

At every phase boundary, update private persistent state. Store audit material
under `git rev-parse --git-path ai-refactor-runs`; never add it to the product
commit unless the user explicitly requests that documentation.

## Inventory-to-implementation contract

The inventory and recommendation register are execution inputs, not the final
deliverable. In `AUTONOMOUS` mode, after `PHASE_4_CANDIDATE_RANKING`:

1. Convert every recommendation that is inside `TARGET_SCOPE`, `NON_GOALS`,
   authority flags, and safety gates into an implementation queue. Ranking sets
   order and slice boundaries; it does not silently discard lower-ranked work.
2. Give every queued item a concrete action, expected files, behavior
   invariants, acceptance checks, rollback, and a disposition of
   `IMPLEMENT_NEXT`, `IMPLEMENT_AFTER_DEPENDENCY`, `BLOCKED`, or `REJECTED`.
3. Execute each eligible item through the complete slice contract. After every
   validated checkpoint, refresh status and dependencies, then continue with
   the next eligible item until the queue has no implementable item left.
4. Do not return a recommendation-only report. A recommendation may remain
   unimplemented only when it is outside scope, explicitly non-goal, blocked by
   a fail-closed gate, rejected with evidence, or the user has explicitly
   selected `AUDIT_ONLY`/`APPROVAL_GATED`. Record the exact reason and the
   authority or evidence needed to resume it.
5. Do not pre-defer broad renames, style cleanup, or speculative abstractions
   merely because they are broad or inconvenient. Split them into bounded
   slices and implement them when they are authorized, behavior-safe, and
   verifiable. Defer only for a recorded gate, not for preference.

Completion requires an empty eligible queue. Any remaining eligible item makes
the run `PARTIAL` or `BLOCKED`; it must never be hidden in a final suggestions
list or treated as completed work.

## Pre-flight and isolation

Before editing any product file, record:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log -1 --oneline
git remote -v
git diff --stat
git diff --cached --stat
```

Detect workspace metadata and available tools before selecting commands. Record
the package manager, orchestrator, framework versions, available targets,
nested repositories/submodules, known failures, possible production paths, and
whether another user or agent has changed the tree.

Treat `main`, `master`, `develop`, `development`, `release/*`, `production/*`,
and `prod/*` as protected by default. For implementation, isolate on a
dedicated local `ai/refactor/<run-id>` branch when safe. If the tree is dirty,
do not overwrite, restore, stash, or commit existing changes; downgrade to
audit-only if safe isolation is impossible.

Do not use destructive Git commands, rebase, merge, amend, force push, or
remote operations unless the user explicitly authorizes the exact operation.

## Inventory, evidence, and risk

Explore progressively: repository metadata, workspace metadata, project list,
dependency graph, runtime entry points, public entry points, domain/data
ownership, contracts and consumers, tests, then implementation details. Bound
large output and save complete logs privately. Include runtime coupling such as
routes, dynamic imports, APIs, schemas, queues, events, environment variables,
auth, payment, serialization, cron, and deployment boundaries; configured
dependency graphs alone are insufficient.

For each project/package/app/service/library, record path, type, language,
framework, purpose, owners, public API, runtime entry points, build/test/lint/
typecheck targets, direct and reverse dependencies, consumers, state/data
ownership, side effects, contracts, deployment unit, coverage evidence, known
failures, and architecture risks. Use `UNVERIFIED` for unknown fields.

Build a validation capability matrix covering typecheck, lint, unit/integration
tests, E2E, build, cycle and boundary checks, public-contract compatibility,
schema/migration safety, event/queue/serialization compatibility,
authorization/payment behavior, and artifact comparison. A missing checker is
`UNSUPPORTED` or `UNKNOWN`, never a passing result.

Rank candidates by value, feasibility, and risk to choose implementation order,
but let hard stop conditions override scores. Prefer a bounded concern with
evidence, clear boundaries, tests, independent validation, and independent
rollback. Record all candidates, including lower-ranked ones, in the
implementation queue; split broad renames, style-only work, speculative
abstractions, framework upgrades, and uncertain core-flow changes into smaller
slices when possible instead of merely listing them as suggestions.

## Slice contract

Plan one coherent slice at a time. Keep it within one domain, one architecture
concern, explicit dependency edges, one observable behavior, and one reversible
unit. Each plan must state the problem/root-cause evidence, goal, scope,
contracts/runtime flows, non-goals, behavior invariants, expected files and
changed lines, risk level, validation, rollback, stop conditions, and required
capabilities. Do not edit product code without this plan.

For each queued slice: capture `SLICE_BASE_SHA`, re-check `HEAD` and status, add or
complete characterization tests, establish the seam/contract, migrate bounded
consumers, retain only a tested compatibility bridge when necessary, validate,
review the complete diff, stage explicit paths, create an atomic commit, run
affected validation, and produce a machine-verifiable checkpoint.

In `AUTONOMOUS`, repeat this sequence for every eligible queue item. A
successful checkpoint authorizes continuation to the next planned slice; it is
not a reason to stop after the first recommendation.

Never introduce unproven `any`, unchecked casts, lint suppression, weakened
strictness, deleted tests, dependency/lockfile changes, database writes,
authorization/payment/secret/deployment changes, or public breaking contracts
without explicit mission authority and a safe migration plan. Compatibility
bridges require tests, an owner, removal criteria, and a future removal slice.

## Safety and validation gates

Never read or record secret values, credentials, private keys, tokens,
production kubeconfig, or production environment files. Do not connect to
production databases, queues, APIs, or deployment paths when production I/O is
not explicitly allowed. Do not install packages unless a frozen, authorized
install is allowed and the lockfile hash is unchanged.

Record baseline commands with working directory, timestamps, exit code, scope,
failure classification, and log path. Existing failures may remain only when
they are recorded, unrelated, non-worsened, and outside the changed scope.
After each command, re-check `git status --short` for generated or unexpected
files. Do not hide stderr, use `|| true`, or retry an unexplained failure.

Validation must prove targeted checks, affected checks, behavior invariants,
contract checks, no new or worsened failures, scope compliance, no unexpected
files, and a usable rollback path. High-risk `UNVERIFIED` capabilities make
continuation false.

Use explicit-path Git review before a commit:

```bash
git status --short
git diff --stat
git diff --check
git diff -- <explicit-paths>
git add <explicit-path-1> <explicit-path-2>
git diff --cached --check
git diff --cached --stat
git diff --cached
```

## Stop conditions and final report

Stop immediately for data loss/corruption, destructive migrations, auth or
authorization semantics, payment/billing/accounting, encryption or secret
handling, incompatible public contracts/serialization/events/queues, deploy
configuration, supply-chain risk, dirty-tree isolation failure, unknown
high-risk validation, scope/budget overflow, missing rollback, concurrent HEAD
drift, possible secret output, or production access. Report the trigger,
evidence, scope, diff/commits, validation state, rollback instructions, and safe
next actions.

At completion, report mode, run ID, task base SHA, final HEAD, branch, mission,
the full recommendation register with implementation evidence for each item,
completed/deferred/blocked/rejected items, commits/files, validation and
baseline comparison, architecture/data/state/contract impact, remaining risks,
rollback instructions, unverified areas, and one of:
`PASS`, `PASS_WITH_BASELINE_FAILURES`, `PARTIAL`, `BLOCKED`, `STOPPED`, or
`AUDIT_ONLY_COMPLETE`.

For the detailed state schemas, checkpoint contract, approval gates, commit
rules, and final-report template, read
[`references/procedure.md`](references/procedure.md) before implementing a
slice.
