# Roadmap

[繁體中文（台灣）](docs/ROADMAP.zh-TW.md)

Updated: 2026-10-13

## Where the project stands

- **V6 Core alpha is out.** [`6.0.0-alpha.1`](packages/bw-core/CHANGELOG.md) installs from this repository's Claude Code plugin marketplace and from npm. The policy format may still change before beta.
- **Self-use continues.** Core has run on two of the maintainer's repositories since 2026-10-12; the first review of real catches and false blocks is on 2026-10-26.
- **V5 is frozen.** It lives on the [`frozen/v5`](https://github.com/stephen-taipei/better-workflows/tree/frozen/v5) branch, and [V5.0 RC1](https://github.com/stephen-taipei/better-workflows/releases/tag/V5.0.rc1) stays installable. The V5.1 plan has stopped.

## What V6 Core does

An AI agent must not claim a task is done with stale evidence, must not keep going after an external action ends with an unknown result, and gets permissions from a policy file, never from prompt text.

| Area | What it guarantees |
| --- | --- |
| Evidence binding | A test or build result counts only for the exact repository tree it ran on. Change a file and the old green result no longer counts. |
| Action gate | Side-effecting commands (push, merge, release, publish, deploy) need an authorization from the policy file and run at most once. |
| Provider reconciliation | If an external action times out or its result is unknown, dependent actions stay blocked until a read-only check confirms what actually happened. |
| Permission boundary | Allowed actions and their expiry come from `.better-workflows/policy.json`, which the agent is not allowed to change. Text in a prompt cannot grant authority. |

Claude Code is the first supported host. Its hooks let Core block an action deterministically instead of relying on instructions the model may ignore.

## Phases

1. **Scope reset** (done): this roadmap, CI that runs only Core, and closing the V5.1 backlog.
2. **Core kernel** (done): `packages/bw-core` with evidence, policy, action token, reconciliation, append-only ledger and a `bw` CLI. Zero runtime dependencies, Node 22.14+.
3. **Claude Code plugin** (done): `SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop` and `SubagentStop` hooks backed by Core.
4. **Demo and docs** (done): a few-second scenario where a stale green test is rejected and a push with an unknown result must be reconciled. Guides in English and Traditional Chinese (Taiwan); the README and website in 41 languages, 39 of them machine-translated.
5. **Alpha release** (now): `6.0.0-alpha.1`, from the plugin marketplace and npm.
6. **Beta**: the policy format is frozen once self-use shows real catches and few false blocks.
7. **More hosts**: Codex and others as small adapters, as far as their extension points allow.

## How we decide whether to continue

- Counted from the `6.0.0-alpha.1` release.
- Within 60 days: at least one person other than the maintainer runs the full flow on a real repository.
- Within 90 days: at least three outside users, one of them using it for two weeks or more.
- If no outside user completes the flow within 90 days, Core stops being developed as a product and remains a personal Claude Code plugin.
