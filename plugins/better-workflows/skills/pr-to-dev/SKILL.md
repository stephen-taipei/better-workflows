---
name: pr-to-dev
description: Goal-first 將範圍內修改分成 atomic commits、建立 target 為 dev 的 PR，通過 fresh checks 後 merge、同步 remote dev，並清理本次擁有的資源。選擇 $better-workflows:pr-to-dev 時使用。
---

# PR to dev

Read `../better-workflows/SKILL.md` completely and follow it, including the Goal-first entry contract.

Use template `pr-to-dev` with minimum mode `critical`. Inventory every in-scope change, stage explicit atomic commit batches, require the PR to target the exact `dev` branch, verify fresh required checks for the current head, merge without admin bypass, reconcile remote `dev`, and clean only resources owned by this run. Do not push, create or merge a PR, sync remote state, or clean resources beyond current user authority.
