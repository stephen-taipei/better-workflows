---
name: auto
description: Goal-first 自動入口（推薦）；自動選 template、mode 與 critics。選擇 $better-workflows:auto 時使用。
---

# Auto

Read `../better-workflows/SKILL.md` completely and follow it, including the Goal-first entry contract.

Before substantial work, always run a read-only repository preflight, even when
the request initially looks non-Git:

~~~bash
sbw workspace preflight --intent read-only
~~~

Classify the task as read-only, possibly mutating, or unknown. If it may mutate
a Git repository, rerun preflight with `--intent modify` and the exact local
integration target before editing anything. A dirty source checkout, detached
HEAD, missing or renamed target, ownership conflict, or an unverified existing
worktree stops mutation. Never auto-stash, make a temporary source commit, copy
a patch, ignore dirty state, or infer `main` merely from `origin/HEAD`.

Then run `sbw doctor --capabilities` and a reviewable route preview. Root must
state the acceptance boundary, mutation intent, all five risk scores, every
hard exclusion, the local integration target when applicable, and the actual
bounded check plan. Unknown values are not zero:

~~~bash
sbw route preview --goal "<goal>" --scope <path> \
  --mutation <read-only|modify|unknown> --acceptance-defined \
  --risk <0..3> --uncertainty <0..3> --blast-radius <0..3> \
  --irreversibility <0..3> --evidence-gap <0..3> \
  [--integration-target <local-branch>] [--protected-target] \
  [--hard-exclusion <code>] [--basic-check <label>] --record
~~~

Credentials, security boundaries, migrations, schemas, dependencies, releases,
deployments, external APIs or side effects, protected or remote targets, broad
scope, unclear acceptance, and unknown outcomes are hard exclusions or higher
risk. Do not omit a known exclusion to obtain Direct.

Report the route source, `AutoRiskAssessmentV1` decision and reason codes,
workspace lifecycle, primary entry/template, effective mode, optional support
exclusions, and blockers. Direct is permitted only when the assessment returns
`direct-fast-path`: irreversibility is zero, each other dimension is at most
one, the total is at most two, acceptance and mutation intent are explicit,
and no exclusion or higher constraint applies.

For a Direct Git mutation, create or reuse the returned task-owned
`TaskWorkspaceLeaseV1` before consuming the route receipt. Make, generate,
test, and commit every change only in that worktree. Direct has no evidence
journal or critics, but it still runs the recorded local, offline targeted
checks within the 120-second bound. It validates the exact task head, safely
integrates only an eligible non-protected local target, and cleans only exact
resources owned by the same lease after terminal integration proof.

If the host already supplied the current task's worktree, use `workspace
register` at the unchanged exact base instead of nesting another worktree.
Registered host resources are preserved during cleanup; only Better Workflows
integration candidates may be removed by this lease.

Protected or remote targets are governed delivery: create or update the
run-owned PR only through the selected evidence workflow, require fresh checks,
the exact PR head, terminal provider reconciliation, and merge authority.
`pr-required` or `PR ready` is not completion and does not permit cleanup.
After merge, `workspace reconcile` must find the exact successful governed
`pr.merge` and matching `remote.sync` actions in the same run before protected
cleanup. Squash cleanup additionally requires the receipt-bound reviewed head
and provider merge commit; a branch-name match or local diff is insufficient.

If scope, source revision, target, acceptance, risk, or capability state changes
during execution, invalidate the assessment and route receipt and preview
again. A failed, timed-out, or unexplained targeted check cannot be reported as
complete.

If the preview returns built-in `auto` with no concrete template and requires
evidence, select exactly one template from current evidence and preview it
explicitly; never fabricate an `auto` template.

Select the final template and mode from the preview, current risk, and evidence.
Profiles may raise the minimum mode but may not replace an explicit selector or
grant authority. A task may separately select `bounded-autopilot-v1` once; that
run-scoped policy can automate only its bounded local actions, `codex/*` push,
and one PR targeting `dev`. It never grants protected merge, deploy, direct
`dev/main` push, or destructive cleanup authority. Keep model aliases internal
unless the user asks for them.

After a Direct Git task, emit the standard completion notice only when both
integration and cleanup are terminal and include the actual target and checks.
Explain that the result used the low-risk Direct path and is not a complete
replayable evidence workflow. Invite the user to reply `補做證據驗證`; that
follow-up must route at least to `verified`. If integration or cleanup is still
pending, report the recovery state instead and never emit the completion notice.
When `cleanupDisposition` is `preserve-host-provided`, explicitly say the lease
was closed but the host-owned task branch and worktree were retained; never use
the run-owned-resource removal wording for that case.
