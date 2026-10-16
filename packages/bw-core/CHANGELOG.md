# Changelog

## Unreleased

### Added

- **What the hooks stopped is now in the ledger.** When the Claude Code hook refuses a tool call or asks the person about one, it records a `tool.gated` entry with the decision, the reason, the command or file, and the session. Before, only Stop refusals and side effects that went ahead were recorded, so a review had to search the conversation logs for refusals. `bw log` lists the new entries.

## 6.0.0-alpha.2

### Fixed

- **The agent could fake a passing check with `bw run`.** `bw run --kind test -- true` recorded a passing `test` for the current files, and the Claude Code hook let the agent run it. The hook now refuses `bw run` from the agent, however it is invoked (`bw`, `npx bw`, `node …/bw.mjs`, `npx @better-workflows/core`); a person can still use it.
- **Two sessions could both be let through for the same side effect.** The hook decided from the ledger and recorded the action as two separate steps, so a second session could pass between them. The final decision and the record now happen under the ledger lock, and the second session is refused while the first one's result is open.
- **A ledger lock older than 30 seconds was deleted.** The lock now names its owner and is taken back only when that process, on the same machine, is gone. A lock whose owner is still running is never removed for being old; after waiting 10 seconds the writer reports which process holds it.

## 6.0.0-alpha.1

First release of Better Workflows Core, the V6 line. V5 is frozen on the [`frozen/v5`](https://github.com/stephen-taipei/better-workflows/tree/frozen/v5) branch and shares no code with it.

The policy format (`version: 1`) may still change before beta.

### What it does

- **Evidence.** A test, lint, typecheck or build result counts only for the exact working tree it ran on, only if it passed, and only if no file changed while it ran. A run whose exit code belongs to another command (`npm test | tail`, `npm test || true`) never counts.
- **Completion.** `completion.require` lists the evidence that must be fresh before work counts as complete. Exact kinds can name the directory they must run in (`cwd`) and the directories their result covers (`scope`); `evidence.ignore` keeps check output out of the tree.
- **Action gate.** Pushes, PR merges and creates, releases, package publishes, `gh api` and HTTP writes, and custom kinds need `allow` from `.better-workflows/policy.json`; the default is `ask`. Commands Core cannot read are `opaque` and asked about. The same side effect at the same commit is refused after it succeeded.
- **Reconciliation.** Anything but exit code 0 leaves an action `unknown`, and further side effects are refused until a read-only provider check (`git ls-remote`, `gh pr view`, `gh release view`, `npm view`) or a person settles it.
- **Ledger.** Append-only and hash-chained in `.git/better-workflows/`, with the last entry's seq and hash in `ledger.head`, so `bw verify` also notices entries cut from the end.
- **Claude Code plugin.** Six hooks: `SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop` (sends the agent back once when required evidence is stale) and `SubagentStop` (settles refusals made during a subagent, never sends it back).
- **CLI.** `bw init`, `run`, `check-completion`, `check-command`, `reconcile`, `status`, `verify`, `log`.
- **Demo.** `examples/stale-green/demo.mjs` runs the stale-green and unknown-push stories in a few seconds without Claude.

### Limits

- Claude Code is the only host. Other agents are not constrained by the policy.
- Core sees only the commands Claude Code shows its hooks; a side effect inside a script is invisible unless the policy names the script.
- Shell parsing is deliberately limited. A form Core cannot read is treated as not counting, or as needing a person.
- Rewriting `ledger.jsonl` and `ledger.head` together is not detected.
