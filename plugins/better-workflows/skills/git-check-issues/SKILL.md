---
name: git-check-issues
description: Compatibility alias for /git-check-issues, check issues, fix open issues, or review and repair GitHub issues. Routes through $better-workflows with current issue-state checks, root-owned fixes, serialized shared resources, PR gates, and exact cleanup.
---

# Git issue compatibility workflow

Read `../better-workflows/SKILL.md` completely and follow it.

Use template `issues-to-root-fix-pr-merge-cleanup` and mode `deep`. Re-fetch every assigned issue before work and before side effects. Closed, superseded, or duplicate issues become no-op evidence rather than repair work.
