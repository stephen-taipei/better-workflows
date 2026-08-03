---
name: pr-to-dev
description: Goal-first 將範圍內修改分成 atomic commits、建立 target 為 dev 的 PR，通過 fresh checks 後 merge、同步 remote dev，並清理本次擁有的資源。選擇 $better-workflows:pr-to-dev 時使用。
---

# PR to dev

Read `../better-workflows/SKILL.md` completely and follow it, including the Goal-first entry contract.

Use template `pr-to-dev` with minimum mode `critical`. Inventory every in-scope change, stage explicit atomic commit batches, rebind the source after an intended commit wave with `sbw source rebind` before review (which invalidates all prior complete evidence and resets the v2 ledger), publish the candidate through the governed fixed-argv `pr.create` provider wrapper, require the PR to target the exact `dev` branch, verify fresh required checks for the current head, merge only the run-owned canonical PR without admin bypass, reconcile remote `dev`, and clean only resources owned by this run. Do not push, create or merge a PR, sync remote state, or clean resources beyond current user authority.

If the governed PR provider returns `unknown`, keep the `pull/new` reservation and query the provider before deciding. Reconcile the same attempt as success only when the exact native marker, actor, source head, bound repository, and provider object are proven; an absence snapshot may not convert the unknown creation to failure because provider visibility can race local reservation finalization. A provider-execution reservation may be resumed only by the same run/action attempt/token, execution identity, and recorded outcome after an interrupted action-record write, with at most one unknown-to-terminal supersession; never reuse a superseded identity, legacy-format record, second identity, or another attempt.

If the reviewed source changes during repair, cancel or supersede this run and
start a fresh source-bound run with a fresh review package; never rebind after a
review package or finding identity exists.
