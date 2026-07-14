---
name: auto-improve
description: Compatibility alias for legacy /autoImprove, autoImprove, full-codebase review then fix, review then create issues and fix them, or automatic improvement requests. Routes the request through $better-workflows with root-only mutation and verified evidence; never executes the retired parallel-writing workflow.
---

# autoImprove compatibility

Read `../better-workflows/SKILL.md` completely and follow it.

Use template `issues-to-root-fix-pr-merge-cleanup` and mode `deep` by default. Use `critical` for migrations, releases, broad destructive cleanup, or irreversible external actions.

Do not run the retired 5–7 parallel writing-worker flow. Native children may only research, review, or refute; the root performs every edit, integration, GitHub action, merge, deploy, and cleanup.
