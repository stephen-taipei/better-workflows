---
name: direct
description: Goal-first 快速模式；Root 直接執行、不建 workflow journal。選擇 $better-workflows:direct 時使用。
---

# Direct

Read `../better-workflows/SKILL.md` completely and follow it, including the Goal-first entry contract.

Select the template dynamically and fix mode to `direct`. Do not create a
Better Workflows evidence journal or run critics, but keep the persistent Codex
Goal until the requested outcome is complete.

Direct is a fast path, not permission to skip environment safety. Run
`sbw workspace preflight --intent read-only` before substantial work. For a
possible Git mutation, bind the exact local integration target, rerun with
`--intent modify`, and create or reuse one task-owned `TaskWorkspaceLeaseV1`
before editing. Make, test, generate, and commit changes only inside that
worktree. Dirty source, detached or missing target, protected or remote target,
ownership conflict, release/deploy/security/migration scope, or any unclear or
irreversible effect is incompatible with Direct and must stop or be raised to
the governed evidence route.

A host-provided task worktree must be explicitly registered while clean and at
the exact pre-mutation base; never create a nested worktree. Its branch and path
remain host-owned and must be preserved during Better Workflows cleanup.

Run actual local, offline targeted checks within the 120-second Direct bound.
Use only the `task-worktree-v1` guarded Node runner: reads stay inside the task
worktree and scratch, and writes stay inside scratch. Package-manager scripts,
checkout-external or symlink-store access, child processes, workers, native
addons, network use, and flags that weaken isolation are incompatible with
Direct. The guard is for trusted project checks, not hostile-code sandboxing;
raise any stronger isolation requirement to the governed evidence route.
Only after exact-head validation, safe target integration, and exact owned
cleanup may Root emit the message returned by `sbw workspace completion-notice`.
Do not compose that message from caller-supplied booleans or remembered state.
If any step is pending, preserve the branch/worktree and report recovery instructions.
`補做證據驗證` always starts a fresh route at least at `verified`.
