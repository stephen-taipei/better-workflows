# Codex adapter (experimental)

`bw hook codex` reads one Codex hook event as JSON from stdin. Outside a Git
repository it does nothing. Core shares evidence and action gates with the
Claude Code adapter in the same worktree ledger; Codex never grants native
tool permission on the user's behalf.

## Package and hook contract

The root `plugin.json` uses the portable Agent Plugins schema. Its
`extensions["com.openai"].hooks` selects `./hooks/codex.json`, replacing the
default discovery of the Claude-specific `hooks/hooks.json`. Commands resolve
the packaged CLI through `${PLUGIN_ROOT}`. The Claude manifests are unchanged.

Registered events are `SessionStart`, `PreToolUse` (`Bash|apply_patch`),
`PostToolUse` (`Bash`), and `Stop`. There is no `PermissionRequest` or
`SubagentStop` registration. A policy `allow` returns no permission decision;
Codex still applies its own permissions. A policy `ask` becomes `deny` before
Core reserves an action, with the reason
“Codex 不支援 ask；請人調整 policy 後重試”.

The manifest and patch payload follow the official
[plugin packaging](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks)
and [hooks](https://learn.chatgpt.com/docs/hooks) documentation, consulted on
2026-10-21. Codex requires users to review and trust installed hooks. Hooks are
a guardrail for supported tool paths, not a complete sandbox boundary.

## Completion and uncertain results

Codex CLI 0.163.0 recordings show an empty `tool_response` for successful and
failed shell calls. The adapter instead reads the supplied transcript and
matches `event_msg` → `item_completed` → `CommandExecution` by `item.id` and
`tool_use_id`. Only an integer `exit_code` establishes a final result; only
exit 0 establishes a success or passing evidence.

When the completion record is absent, malformed, or unreadable, Core keeps the
call pending without ending actions or writing evidence. Every subsequent hook
retries pending calls for the same host and session, including evidence-only
commands. Background commands may finish in a different turn. Correlation uses
host, session and tool-call ID, not turn ID. Evidence retains its pre-command
snapshot, so intervening edits cannot turn an older check into a fresh pass.
Before settling a result, Core durably records `tool.consumed` for that
host/session/tool ID under the ledger lock. A replay cannot reserve another
action or bind the old result to a new tree, even if later accounting fails.
The marker records consumption only; it does not establish successful evidence.

An interruption and a refusal at Codex's native prompt are not distinguishable
from the recorded `turn_aborted` event. Neither is interpreted as “never ran”.
Without a matching final result, actions remain available to Core's existing
read-only reconciliation. Evidence and duplicate-action keys remain shared
across hosts; pending files and session completion history are host-specific.
Read-only probe results are applied only if the action status and latest history
entry still match the snapshot taken before the probe. A concurrent completion
or reconciliation takes precedence; stale probes report the current outcome.
Manual reconciliation checks and appends under the same ledger lock.
`bw status` reports the latest session start time for each host.

## File protection and validation limits

For `apply_patch`, the adapter reads the patch from `tool_input.command` and
checks each `*** Add File:`, `*** Update File:`, `*** Delete File:`, and
`*** Move to:` path. Missing or unrecognized headers are denied. Both lexical
`.git` paths and resolved protected paths are checked, including symlinks and
linked worktree Git markers, per-worktree Git directories and the current
repository's common Git directory. This is a header scanner, not a patch parser.

Sanitized Bash fixtures come from the 2026-10-21 Codex CLI recording. Tests replay
them against temporary Git repositories. The `apply_patch` payload and portable
plugin discovery are based on official documentation and remain **未實測** on a
live Codex host. No plugin is enabled in `deckhand` or `adorable-git-grpah`.

Existing unversioned ledger entry types remain readable. New optional host and
session correlation metadata and the additive `tool.consumed` entry do not
require rewriting old entries. Older Core versions do not enforce the new
consumed-call guard. A future
incompatible ledger change will require explicit versioning and migration.
Evidence pending files from before host-prefixed filenames were introduced are
not migrated; rerun unfinished checks after upgrading. Existing action records
remain available to reconciliation.
