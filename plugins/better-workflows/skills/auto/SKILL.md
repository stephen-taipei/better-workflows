---
name: auto
description: Goal-first Better Workflows entry. Select the public Auto policy, minimum mode, and evidence gates from current task intent and target.
---

# Better Workflows Auto

Use this skill for `$better-workflows:auto`. It is the only public selector. The
installed `templates/auto.json` is the only public template. Its canonical
variants are `read-only-v1`, `code-change-v1`, and `dev-publish-v1`; they are
policies inside Auto, not separately selectable templates or skills.

The Codex plugin installer does not create a shell `sbw` command. Resolve the
installed plugin root from this skill's own path (two directories above this
file), then run its bundled CLI as `node <absolute-plugin-root>/scripts/sbw.mjs`.
Every `sbw` example below means that exact installed CLI. A separately
installed global wrapper is optional; use it only after verifying that it
selects this same installed bundle.

Keep the root agent responsible for edits, Git and provider mutations, risk
acceptance, and completion. Read-only workers can investigate or review; their
agreement does not grant action authority. Follow higher-priority host and user
instructions. Inspect the current host goal before substantial work. Create a
persistent goal only if the user explicitly asks for one and the host permits
it. Continue a matching goal, and never silently replace an unrelated one.

## Route from current facts

Run a read-only preflight before substantial work:

~~~bash
sbw workspace preflight --intent read-only
sbw doctor --capabilities
~~~

If the task may edit a Git repository, run a second preflight with
`--intent modify` and the exact local integration target. Inspect `AGENTS.md`
and `CLAUDE.md` where applicable. A dirty source, detached or missing target,
source revision drift, or uncertain worktree ownership is a HOLD unless the
user explicitly authorizes the exact exception. Never silently stash, infer
`main` from `origin/HEAD`, or borrow another task's worktree.

State the goal, scope, acceptance, mutation intent, target, all five risk
scores, hard exclusions, and bounded check plan. Unknown inputs are not zero.
Preview and record the route:

~~~bash
sbw route preview --goal "<goal>" --scope <path> \
  --mutation <read-only|modify|unknown> --acceptance-defined \
  --risk <0..3> --uncertainty <0..3> --blast-radius <0..3> \
  --irreversibility <0..3> --evidence-gap <0..3> \
  [--integration-target <local-branch>] [--protected-target] \
  [--hard-exclusion <code>] [--basic-check <label>] --record
~~~

Report the route source, `AutoRiskAssessmentV1` decision and reasons, selected
Auto variant, effective mode, blockers, and capability exclusions. The route
receipt binds the canonical policy digest; re-preview after source, policy,
target, scope, risk, acceptance, or capability changes. An unsupported protected
target or unknown mutation intent stays on HOLD. A bare `--template auto` run
uses the read-only variant and cannot acquire delivery actions.

Auto's fast path is available only when the assessment returns `direct-fast-path`:
acceptance and mutation intent are explicit, irreversibility is zero, each
other risk score is at most one, total risk is at most two, and no hard
exclusion or protected or remote target applies. It has no evidence journal or
critics. Run only the recorded bounded local checks. Git mutation still uses
an exact task-owned `TaskWorkspaceLeaseV1` or a registered host-provided
worktree. Do not report a failed, timed-out, or unexplained check as complete.
Use `sbw workspace completion-notice` for the final Auto fast-path result; preserve
host-owned resources during cleanup.

## Evidence workflows

`read-only-v1` requires current source inventory and observed result evidence
and has no action gates. `code-change-v1` requires a bounded change plan,
slice validation, independent patch and diff review, current repository
checks, final validation, and rollback evidence. Neither variant authorizes
provider actions by itself.

For an explicit protected `dev` target, Auto selects `dev-publish-v1` in
critical mode. The policy allows atomic local commits after scoped plan and
repository gates, with broad review before publication. It then requires the
exact reviewed head, one run-owned PR targeting `dev`, fresh required checks,
protected merge without admin bypass, terminal provider reconciliation,
exact local and remote revision agreement, and cleanup of only run-owned
resources. Never push directly to `dev` or `main`. PR readiness is not merge
completion. Action tokens require declared authority, canonical gates, fresh
typed evidence, and the current contract; a route or interaction approval does
not issue them.

Use `sbw run --route-receipt <id>` for evidence routes. Validate the graph and
current sentinel before advancing. After a source change, rebind the exact
source, capture and verify a new sentinel, then resume. Treat stale evidence,
missing signer trust, unresolved review findings, unknown provider state, or
an unverified target revision as HOLD. Do not infer success from local checks
or a previous receipt. Preserve the exact review, provider, and release gates
selected by the run; do not substitute model agreement for them.

The default interaction mode deduplicates an already authorized, identical
repository, goal, recipient, data scope, side effect, and safety boundary. It
only suppresses duplicate questions. A material change needs fresh
interaction authorization. `--strict` requests per-step interaction. Never
ask for, copy, or retain an administrator password; use a visible native host
dialog when administrator authorization is required.

## Convergence and stopping

Keep one finite acceptance list for the authorized scope. Mark each item with
its required evidence and current state. A review may expose a defect in that
scope; an optional improvement, private feature, or unadopted draft does not
silently become another completion requirement. Obtain the owner's scope
decision before adding such work. Preserve completed items unless current
evidence identifies a specific regression or invalidated binding.

Before a repair or repeated check, identify the observed failure, the changed
source or evidence, and the acceptance item that the next attempt can advance.
Do not repeat an unchanged failed check or request another review merely for
agreement. After two attempts with the same cause and no acceptance progress,
stop that repair path, report its exact HOLD, and rescope it with the root.
Do not create another run, package, or goal to reset an exhausted budget.

Respect the selected contract's stage attempts and any plan-wide attempts,
seconds, or tokens. A stage attempt limit is not a global model cost limit;
WorkflowPlan budget enforcement covers only its admitted execution path.
When no aggregate token or time cap is configured, report that limitation;
never claim that all host agent calls have a hard cost cap. Set a persistent
goal token budget only when the user explicitly requests that budget.

Continue only independently useful, authorized work within the same acceptance
list. When every remaining item depends on an external HOLD, end the current
turn with the completed items, exact blocker, and required next input or event.
Do not invent unrelated work, new verification requirements, or repeated polls
to keep the turn active. Follow the host's own persistent-goal lifecycle rules;
ending a turn neither completes nor pauses that goal.

## Completion

Check the requested acceptance items against fresh run evidence and the
actual current source. Distinguish local validation, reviewed candidate,
provider reconciliation, merge, deployment, and public release. If any required
receipt or authority is absent, report the exact HOLD and continue unaffected
work. Never call a planned or locally verified V5.0 release published.
