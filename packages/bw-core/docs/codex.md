# Codex adapter (experimental)

[繁體中文（台灣）](codex.zh-TW.md)

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
`Codex hooks cannot ask; change the policy and retry`.

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
Core records `tool.consumed` for a host/session/tool ID under the ledger lock
only when the call has a pending result file, a corresponding pending action,
or a matching probe-settled failure with a known exit code. A read-only Bash
call with no tracked work adds no marker. A replay cannot
reserve another action or bind the old result to a new tree, even if later
accounting fails. The marker records consumption only; it does not establish
successful evidence.

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

For the built-in actions with read-only probes (`git-push`, `gh-pr-merge`,
`gh-pr-create`, `gh-release`, and `package-publish`), a negative provider result
may settle the action as `failed` even when Codex has not supplied a final
completion. This releases the side-effect gate for a retry. The probe reports
provider state; it does not prove the original command never ran. A retry can
overlap an original command that is still running, and this behavior accepts
that risk to restore availability after a missing Codex completion. Actions
without an applicable probe, including custom actions and `http-write`, remain
`unknown` and continue to block side effects.

A matching completion for the same host, session, and tool call can refine a
probe-settled `failed` action only when it reports explicit exit 0, which changes
the action to `success`. A non-zero, missing, malformed, or ambiguous result
does not change `failed`. A late completion does not overwrite a manual
reconciliation. Positive provider evidence can still establish `success`; a
matching late completion can also settle a provisional `unknown`.

Recovery reads each needed transcript once per hook and indexes matching final
results. Conflicting final results for the same call remain unknown. Evidence
keeps `toolUseId` and an `order` with the ledger sequence observed before the
command started (`startedAfterSeq`). Codex additionally records the completion's
position in a snapshot identified by the host, session, canonical transcript
path and full content digest. Results in the same snapshot can be ordered even
when their hooks arrive late; results from different snapshots are comparable
only when the earlier result was already in the ledger before the later run.
Core never orders completions by pending filenames or timestamps. Unordered or
conflicting candidates block completion; rerun the check after those results
are recorded. Transcript growth can require this conservative rerun. Existing
entries are not rewritten, and missing ordering metadata cannot establish a
newer passing result. Upgrade all participating hosts together: older Core
versions do not enforce this ordering rule.

## File protection and validation limits

For `apply_patch`, the adapter reads the patch from `tool_input.command` and
checks each `*** Add File:`, `*** Update File:`, `*** Delete File:`, and
`*** Move to:` path. Missing or unrecognized headers are denied. Both lexical
`.git` paths and resolved protected paths are checked, including symlinks and
linked worktree Git markers, per-worktree Git directories and the current
repository's common Git directory. This is a header scanner, not a patch parser.

Sanitized Bash fixtures come from the 2026-10-21 Codex CLI recording. Tests replay
them against temporary Git repositories. The `apply_patch` payload, portable
plugin discovery and `Stop` response are based on official documentation or
fixtures, and remain **未實測** on a live Codex host. No plugin is enabled in `deckhand` or `adorable-git-grpah`.

Every new ledger entry has the top-level shape
`{ v, seq, at, type, data, prev, hash }`, and `v` is included in its hash. A missing `v` is interpreted as version 1 and
verified with the legacy hash, without rewriting the entry. A version that is
not a positive integer breaks the chain. Core skips entries newer than its
`LEDGER_VERSION` while folding state, reports the maximum newer version, and
fails closed for side effects, opaque commands and completion until Core is
upgraded. `bw verify` still verifies the chain and reports the maximum version.
When host hooks encounter a newer ledger version, they leave existing pending
calls pending and do not append ledger records for those calls.

New optional host/session metadata and `tool.consumed` do not require rewriting
old entries. Older Core versions do not enforce the consumed-call guard.
Evidence pending files from before host-prefixed filenames were introduced are
not migrated; rerun unfinished checks after upgrading. Existing action records
without a `session` cannot be ended by `PostToolUse`; they remain open for
reconciliation.
