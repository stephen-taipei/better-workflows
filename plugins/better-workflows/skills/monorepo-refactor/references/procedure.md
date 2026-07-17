# Monorepo Refactor Procedure Reference

Use this reference with `SKILL.md` when the task reaches planning or
implementation. It expands the required state, evidence, and stop gates; it
does not grant permission for external side effects.

## Persistent run state

Create a private run directory under:

```bash
RUN_ID="$(date +%Y%m%d-%H%M%S)"
AUDIT_ROOT="$(git rev-parse --git-path ai-refactor-runs)"
AUDIT_DIR="$AUDIT_ROOT/$RUN_ID"
mkdir -p "$AUDIT_DIR/checkpoints" "$AUDIT_DIR/logs"
```

Keep these files out of normal commits:

```text
run-config.json
state.json
workspace-summary.md
project-index.json
dependency-index.json
runtime-entrypoints.md
contracts-index.md
data-ownership.md
risk-map.md
validation-capabilities.json
baseline.json
candidate-register.md
decision-log.md
slice-queue.json
checkpoints/
logs/
```

Before each phase, re-read `run-config.json` and `state.json`. Update state via
temporary file plus atomic rename. A state record must identify the phase,
task/base SHA, current HEAD, mode, scope, limits, findings, validation status,
stop conditions, and next allowed action.

## Mission contract

Accept either natural-language input or an explicit contract. Normalize it to:

```text
EXECUTION_MODE=AUDIT_ONLY|APPROVAL_GATED|AUTONOMOUS
RECOMMENDATION_DISPOSITION=IMPLEMENT_ALL_ELIGIBLE|AUDIT_ONLY|APPROVAL_GATED
PRIMARY_GOAL=
TARGET_SCOPE=
KNOWN_PAIN_POINTS=
BUSINESS_CRITICAL_PATHS=
BEHAVIOR_INVARIANTS=
TARGET_ARCHITECTURE_RULES=
NON_GOALS=
SUCCESS_METRICS=
```

Record authority flags separately from goals. A missing goal, scope, or behavior
invariant forces audit-only work. A user request to refactor a named module is
not permission to change neighboring modules, contracts, schemas, or deploy
configuration.

For an explicit implementation request, normalize
`RECOMMENDATION_DISPOSITION=IMPLEMENT_ALL_ELIGIBLE` and
`EXECUTION_MODE=AUTONOMOUS` unless the user selected a stricter mode. This means
the recommendation register is an execution queue, not a report of possible
future work. Keep `AUDIT_ONLY` and `APPROVAL_GATED` as explicit ways to stop
before implementation or between approved slices.

## Architecture and runtime evidence

For JavaScript/TypeScript workspaces inspect `package.json`, workspace files,
orchestrator config, TypeScript references, aliases, exports, lint rules, test
frameworks, generators, and release tooling. For Nx, verify the installed CLI
before using `show projects`, `show project`, or graph commands. For polyglot
repositories, create separate indices for pnpm/npm/Yarn, Bazel, Gradle/Maven,
Go, Cargo, Composer, and Python workspaces as applicable.

Runtime coupling to search for includes:

- dynamic imports, route and lazy-load boundaries;
- HTTP/OpenAPI, GraphQL, RPC, protobuf, WebSocket, and serialization formats;
- database tables, migrations, ORM models, Redis/cache keys, files and object
  storage;
- queues, jobs, cron schedules, events and payloads;
- environment variables, feature flags, authentication, authorization,
  permissions, payments, subscriptions, billing, and external services;
- deployment units and release boundaries.

Label every index field `CONFIRMED`, `INFERRED`, `UNVERIFIED`, or `CONFLICTING`
when the evidence status matters. An Nx/project graph is configured-dependency
evidence only; it does not prove runtime safety.

## Baseline and capability record

Define `TASK_BASE_SHA` once at task start and `SLICE_BASE_SHA` before each slice.
Run only capabilities supported by the repository, in this order where
possible: targeted typecheck, lint, unit tests, build, integration tests,
critical E2E, then workspace validation. Each command record includes:

```json
{
  "command": "",
  "workingDirectory": "",
  "startTime": "",
  "endTime": "",
  "exitCode": 0,
  "status": "PASS|FAIL|UNVERIFIED|NOT_APPLICABLE",
  "failureClass": "PRE_EXISTING_CONFIRMED|PRE_EXISTING_SUSPECTED|ENVIRONMENT_FAILURE|TOOLING_FAILURE|FLAKY|UNKNOWN",
  "scope": "",
  "logFile": ""
}
```

The capability matrix uses only `SUPPORTED`, `PARTIALLY_SUPPORTED`,
`UNSUPPORTED`, `BROKEN`, or `UNKNOWN`. Missing evidence is never converted to
PASS by manual inspection. If a pre-existing failure touches the proposed
slice, add characterization coverage, repair it, or stop that slice.

## Candidate and slice schemas

Score candidates by average value, feasibility, and risk only for ordering. Do
not silently drop a lower-ranked recommendation; either queue it or record a
gate-backed disposition.

```text
PRIORITY_SCORE = VALUE_SCORE + FEASIBILITY_SCORE - RISK_SCORE
```

The recommendation register must preserve the complete inventory-to-action
mapping:

```json
{
  "recommendationId": "stable-id",
  "sourceEvidence": [],
  "summary": "",
  "scope": {"projects": [], "paths": [], "contracts": [], "runtimeFlows": []},
  "priorityScore": 0,
  "implementationOrder": 0,
  "disposition": "IMPLEMENT_NEXT|IMPLEMENT_AFTER_DEPENDENCY|BLOCKED|REJECTED|AUDIT_ONLY|APPROVAL_GATED",
  "action": "",
  "acceptance": [],
  "rollback": [],
  "blockingEvidence": [],
  "requiredAuthority": [],
  "sliceIds": []
}
```

In `AUTONOMOUS`, every recommendation whose disposition is
`IMPLEMENT_NEXT` or `IMPLEMENT_AFTER_DEPENDENCY` must produce one or more
slice IDs and be executed. `BLOCKED`, `REJECTED`, `AUDIT_ONLY`, and
`APPROVAL_GATED` require a concrete evidence-backed reason; they are not
successful completion states.

Hard stop conditions and missing evidence override the score. A slice plan uses
this shape:

```json
{
  "sliceId": "domain-concern-sequence",
  "title": "Human-readable title",
  "problem": {"summary": "", "rootCause": "", "evidence": []},
  "goal": "",
  "scope": {"projects": [], "paths": [], "contracts": [], "runtimeFlows": []},
  "nonGoals": [],
  "behaviorInvariants": [],
  "expectedFiles": [],
  "expectedChangedLines": 0,
  "riskLevel": "LOW|MEDIUM|HIGH",
  "validationPlan": [],
  "rollbackPlan": [],
  "stopConditions": [],
  "requiredCapabilities": [],
  "status": "PLANNED"
}
```

Keep each slice within three projects, 25 files, and 1,500 changed lines by
default. If it cannot be split, record why, expected size, migration and
rollback strategy, then wait for approval or stop autonomous execution. If a
recommendation needs multiple slices, keep it in the queue until all of its
slice IDs reach validated completion.

## Slice execution and commit evidence

Use this order and do not mix unrelated cleanup into the slice. Repeat the
sequence for every eligible recommendation; a successful slice checkpoint
authorizes the next queue item in `AUTONOMOUS` mode:

1. Capture `SLICE_BASE_SHA`, expected HEAD, and working-tree status.
2. Add or complete characterization tests for existing behavior.
3. Establish the stable seam or public/internal contract.
4. Migrate consumers and move the implementation.
5. Retain only a bounded, tested compatibility bridge with owner and removal
   criteria.
6. Run targeted checks and inspect generated/unexpected files.
7. Review the complete explicit-path diff and `git diff --check`.
8. Stage explicit paths only and create a Conventional Commit.
9. Run affected validation against `SLICE_BASE_SHA..HEAD`.
10. Write a checkpoint, update the recommendation disposition, refresh the
    queue, and stop or continue according to its evidence.

Do not use `git add .` or `git add -A`. A commit must contain one coherent
architecture concern, have no secrets or unrelated formatting, preserve a
buildable or explicitly verifiable state, and be independently revertible.

## Machine-verifiable checkpoint

Write one JSON checkpoint per completed slice:

```json
{
  "sliceId": "",
  "taskBaseSha": "",
  "sliceBaseSha": "",
  "headSha": "",
  "scope": {"projects": [], "files": [], "fileCount": 0, "changedLines": 0},
  "commits": [],
  "commands": [],
  "baselineComparison": {
    "newFailures": [],
    "resolvedFailures": [],
    "unchangedFailures": [],
    "worsenedFailures": []
  },
  "capabilities": [],
  "behaviorInvariants": [],
  "unexpectedChanges": [],
  "contractChanges": [],
  "remainingRisks": [],
  "rollback": {"strategy": "git revert", "commits": []},
  "stopConditionsTriggered": [],
  "nextSlice": "",
  "continueAllowed": false
}
```

Set `continueAllowed=true` only when targeted and affected validation pass, no
failure worsens, scope and diff match the plan, no unexpected files or
unexplained generated files exist, required invariants/contracts pass or are
not applicable, rollback is valid, the next boundary is explicit, and all
limits remain within budget. High-risk UNVERIFIED evidence always makes it
false.

## Approval gates

In `APPROVAL_GATED`, stop after candidate ranking and slice planning with a
`CHECKPOINT READY` report containing inventory, risk map, baseline, capability
map, and proposed slice. After each approved slice, stop again after
implementation, validation, diff review, atomic local commit, and checkpoint.
Do not infer approval from silence or from a previously approved slice.

In `AUTONOMOUS`, do not stop after candidate ranking. Proceed through the
implementation queue without per-slice user approval when the mission contract,
authority flags, validation capability, and rollback evidence remain valid.
Stop only for configured limits, concurrent tree drift, unknown/high-risk
validation, or another fail-closed condition. `AUTONOMOUS` still cannot grant
production I/O, public breaking changes, dependency installation, database
writes, remote operations, or other authority not present in the contract.

## Final report and status

The final report must identify mode, run ID, task and final SHA, branch,
mission, invariants, non-goals, the full recommendation register, completed
slices, files and commits, commands and results, baseline comparison,
architecture/boundary/data/state/contract impact, risks, rollback,
deferred/blocked/rejected items, and unverified areas. Use exactly one final
status:

```text
PASS
PASS_WITH_BASELINE_FAILURES
PARTIAL
BLOCKED
STOPPED
AUDIT_ONLY_COMPLETE
```

Do not declare completion with open critical findings, stale/indeterminate
evidence, unknown reconciliation, missing acceptance evidence, invalid current
tree sentinels, an unfinished required slice, or an eligible recommendation
that has not been implemented. `PASS` and
`PASS_WITH_BASELINE_FAILURES` require an empty eligible queue; otherwise use
`PARTIAL`, `BLOCKED`, `STOPPED`, or `AUDIT_ONLY_COMPLETE` as appropriate.
