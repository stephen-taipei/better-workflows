---
name: auto-issues
description: Compatibility alias for legacy /autoIssues, autoIssues, audit and create issues, scan issues without fixing, or read-only repository review requests. Routes through $better-workflows and preserves read-only review plus root-owned deduplicated issue creation.
---

# autoIssues compatibility

Read `../better-workflows/SKILL.md` completely and follow it.

Use template `review-to-issues` and mode `verified` by default. Reviewers remain read-only. Re-fetch the current SHA and deduplicate against existing issues immediately before the root creates any issue.
