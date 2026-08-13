---
name: pr-to-dev
description: Goal-first 將範圍內修改分成 atomic commits、建立 target 為 dev 的 PR，通過 fresh checks 後 merge、同步 remote dev，並清理本次擁有的資源。選擇 $better-workflows:pr-to-dev 時使用。
---

# PR to dev

Read `../better-workflows/SKILL.md` completely and follow it, including the Goal-first entry contract.

Use template `pr-to-dev` with minimum mode `critical`. Inventory every in-scope change, stage explicit atomic commit batches, rebind the source after an intended commit wave with `sbw source rebind` before review (which invalidates all prior complete evidence and resets the v2 ledger), publish the candidate through the governed fixed-argv `pr.create` provider wrapper, require the PR to target the exact `dev` branch, verify fresh required checks for the current head, merge only the run-owned canonical PR without admin bypass, reconcile remote `dev`, and clean only resources owned by this run. A task that explicitly selects `bounded-autopilot-v1` may automate the bounded commit, cache, `codex/*` push, and `dev` PR stages after `sbw autonomy preflight`; protected merge, deploy, direct protected-branch push, and destructive cleanup remain separate human-authority gates.

When this delivery is handing off an accepted Better Workflows
self-improvement, start the run with the source run explicitly bound:

```sh
sbw run --template pr-to-dev --mode critical \
  --goal "Deliver the accepted self-improvement" --scope . \
  --self-improve-run <self-improve-run-id>
sbw self-improve handoff <pr-to-dev-run-id> \
  --source-run <self-improve-run-id>
```

The typed `self-improve-delivery-handoff` receipt is mandatory before any
commit, push, PR creation, merge, remote synchronization, or cleanup token is
issued. It proves the source run's accepted trusted holdout, clean exact HEAD,
plugin bundle, request/comparison/candidate digests, and seven distinct host
witnesses for ordinary evaluation or eight for evaluator migration. A normal
unbound `pr-to-dev` run is not an acceptable substitute.

If the governed PR provider returns `unknown`, keep the `pull/new` reservation and query the provider before deciding. Reconcile the same attempt as success only when the exact native marker, actor, source head, bound repository, and provider object are proven; reconcile it as failure only after a fresh pinned-provider query proves the exact candidate PR is absent. An unpinned or local absence snapshot may not release the reservation. A provider-execution reservation may be resumed only by the same run/action attempt/token, execution identity, and recorded outcome after an interrupted action-record write, with at most one unknown-to-terminal supersession; never reuse a superseded identity, legacy-format record, second identity, or another attempt.

Capture the absolute `gh` path and content digest at token issuance and use that
same identity for authorization, PR-state, required-check, receipt, and
reconciliation probes. If the fixed-argv create wrapper fails after preflight,
record `sent-or-indeterminate` and reconcile it as unknown; only a preflight
failure explicitly recorded as `not-sent` can release `pull/new` directly; a
fresh pinned-provider absence proof may reconcile the same unknown attempt as
failure and then release it. Reservation
expiry and reaping must run under the per-resource lease, namespaced by the
canonical provider repository, action, and resource. Legacy unscoped
reservations remain blocked until explicitly reconciled. Use `issue` →
`execute` for wrapper-backed push/create/merge actions; `execute` consumes
internally and direct `consume` is not a valid alternate path for them.
Contract-deferred actions are rejected by the core lifecycle and cannot be
smuggled through an empty action-stage map.

For `plugin.cache.publish`, the source run, delivery run, handoff, action
token, provider receipt, and ready marker must agree on one canonical
`CODEX_HOME` plugin-cache root. `sync` must run with that same environment.
If the process fails after the success action record is persisted, retry the
same action attempt with its persisted success receipt so the run-lock repair
path can promote the pending marker; do not issue a second token or rerun the
publication. A `spent/pending` action may resume only when the immutable target
and pending marker prove the exact handoff source binding, run, and attempt;
then create the receipt and promote readiness without republishing. If that
proof is missing, keep the attempt unknown and fail closed. A source run that
lacks an explicit canonical `pluginCacheRoot` is invalid; do not fall back to
the current ambient `CODEX_HOME`, and do not reclaim a publication lock while
its recorded owner is still alive.

If the reviewed source changes during repair, cancel or supersede this run and
start a fresh source-bound run with a fresh review package; never rebind after a
review package or finding identity exists.
