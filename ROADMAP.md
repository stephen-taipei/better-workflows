# Roadmap

[繁體中文（台灣）](docs/ROADMAP.zh-TW.md)

Updated: 2026-10-09

## Where the project stands

- **V5 is frozen at its release candidate.** [V5.0 RC1](https://github.com/stephen-taipei/better-workflows/releases/tag/V5.0.rc1) stays installable, and the current `main` (41 public locales, the V5.0 acceptance slices) is the final V5 state. No V5.0 stable release is planned.
- **The V5.1 plan has stopped.** Its open issues are being closed as `not planned`; branches and history are kept for reference.
- **Next is V6 "Core".** It keeps only the parts of Better Workflows that become more valuable as models get stronger.

## What V6 Core does

An AI agent must not claim a task is done with stale evidence, must not keep going after an external action ends with an unknown result, and gets permissions from a policy file, never from prompt text.

| Area | What it guarantees |
| --- | --- |
| Evidence binding | A test or build result counts only for the exact repository tree it ran on. Change a file and the old green result no longer counts. |
| Action gate | Side-effecting commands (push, merge, release, publish, deploy) need an authorization from the policy file and run at most once. |
| Provider reconciliation | If an external action times out or its result is unknown, dependent actions stay blocked until a read-only check confirms what actually happened. |
| Permission boundary | Allowed actions, writable paths and expiry come from `.better-workflows/policy.json`. Text in a prompt cannot grant authority. |

Claude Code is the first supported host. Its hooks let Core block an action deterministically instead of relying on instructions the model may ignore.

## Phases

1. **Scope reset** — this roadmap, CI that no longer depends on an owner-signed policy for every push, and closing the V5.1 backlog.
2. **Core kernel** — `packages/bw-core`: evidence, policy, action token, reconciliation, append-only ledger and a `bw` CLI. Zero runtime dependencies, Node 22+.
3. **Claude Code plugin** — `PreToolUse`, `PostToolUse`, `Stop` and `SessionStart` hooks backed by Core.
4. **Demo and docs** — a 30-second scenario: a stale green test is rejected, and a push with an unknown result must be reconciled. English and Traditional Chinese (Taiwan) only until V6.0 stable; the other locales follow after it.
5. **Alpha release** — installable from a Claude Code plugin marketplace entry and npm.
6. **Codex adapter** — the same guarantees for Codex, as far as its extension points allow.

## How we decide whether to continue

- Within 60 days of the alpha: at least one person other than the maintainer runs the full flow on a real repository.
- Within 90 days: at least three outside users, one of them using it for two weeks or more.
- If no outside user completes the flow within 90 days, Core stops being developed as a product and remains a personal Claude Code plugin.
