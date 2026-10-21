# Codex hook fixtures

`captured-hooks.json` and `captured-transcript.jsonl` are sanitized extracts from `codex-hook-events.jsonl` and `rollout-2026-10-21T17-18-00-01a15dc0-d1c6-7a70-8e7a-869bdc21595f.jsonl`. The hook extract keeps only event names, `Bash`, the empty `tool_response`, and the fields needed to correlate calls. Session, turn, and tool IDs are fake. All paths are test paths. Commands are replaced with the allowlisted `npm test`.

The transcript extract keeps only matching `CommandExecution` `item_completed` entries (`id`, `type`, `status`, `exit_code`) and `turn_aborted` (`reason`). It omits `aggregated_output` and every other transcript field.

`apply-patch-cases.json` is synthetic. It uses the official Codex hook field contract (`tool_name: "apply_patch"`, `tool_input.command`) and is not a live-captured or experimentally verified `apply_patch` event format. The adapter tests must retain this limitation in their report.
