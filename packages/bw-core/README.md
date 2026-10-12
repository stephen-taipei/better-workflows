# Better Workflows Core

[繁體中文（台灣）](README.zh-TW.md)

Stops an AI coding agent from claiming "done" on stale evidence, from repeating or stacking side effects whose result is unknown, and from taking permissions out of prompt text.

Status: pre-alpha, part of the [V6 roadmap](../../ROADMAP.md). Claude Code is the first host, through the hooks plugin in this package. Start with [Getting started](docs/getting-started.md), or run the [stale-green demo](examples/stale-green/demo.mjs) (`node examples/stale-green/demo.mjs`, about 2 seconds, no Claude needed).

## What it checks

| Check | Rule |
| --- | --- |
| Evidence | A test, lint, typecheck or build result is recorded against the Git tree of the working copy at the time it ran (tracked changes plus untracked, non-ignored files). It counts only while the working copy still has exactly that content, only if it passed, and only if no file changed while it ran. A run whose exit code belongs to another command on the line (`npm test | tail`, `npm test; echo done`, `npm test || true`) never counts; join commands with `&&` or set `pipefail`. |
| Completion | `completion.require` in the policy lists the evidence kinds that must be fresh before work counts as complete. |
| Action gate | Pushes, PR merges and creates, releases, package publishes, `gh api` writes, HTTP writes and any custom kinds are side effects. Each needs `allow` from the policy file; the default is `ask`. Commands whose effects cannot be read (command substitution, `eval`, `sh -c`) are treated as `opaque`, default `ask`. |
| At most once | The same side effect at the same commit is refused after it has succeeded. |
| Reconciliation | Only exit code 0 is a known result. Anything else leaves the action `unknown`, and every further side effect is refused until `bw reconcile` settles it with a read-only check against the provider (`git ls-remote`, `gh pr view`, `gh release view`, `npm view`), or a person settles it with a note. |
| Ledger | Every record goes to an append-only, hash-chained ledger in `.git/better-workflows/`. `bw verify` detects edited or removed entries and a half-written last line; it cannot tell that whole entries were cut from the end. |

## Commands

```bash
bw init                                  # write .better-workflows/policy.json
bw run --kind test -- npm test           # run and record evidence
bw check-completion                      # 0 when required evidence is fresh, 2 otherwise
bw check-command "git push origin main"  # 0 allow, 2 deny, 3 ask
bw reconcile                             # settle unknown actions by probing the provider
bw reconcile <id> --outcome success --note "checked the deploy dashboard"
bw status | bw verify | bw log
```

## Claude Code

Until the alpha release, install it from a checkout (details in [Getting started](docs/getting-started.md)):

```bash
claude plugin marketplace add path/to/better-workflows/packages/bw-core
claude plugin install better-workflows-core@better-workflows --scope local
node path/to/better-workflows/packages/bw-core/bin/bw.mjs init
```

| Hook | What it does |
| --- | --- |
| `SessionStart` | Records the starting tree and tells the agent which evidence completion needs and which side effects are still unsettled. |
| `PreToolUse` | Runs the action gate on Bash commands. `deny` blocks the call, `ask` sends it to the permission prompt, `allow` defers to Claude Code's own permission rules and never grants more. Edits to `.better-workflows/` or `.git/` and `bw init` / `bw reconcile <id>` are refused. |
| `PostToolUse`, `PostToolUseFailure` | Records the exit code: 0 is success, anything else or an interrupt is `unknown`. Records evidence for test, lint, typecheck and build commands. |
| `Stop`, `SubagentStop` | If files changed in the session and the required evidence is not fresh, sends the agent back once with what is missing; the second time it only warns. |

A side effect refused at the permission prompt never runs and gets no `PostToolUse`. The adapter settles it as `failed` only when the session transcript shows Claude Code's refusal as the tool's result. Any other missing result, an interrupt included, stays `unknown`.

## Policy

```json
{
  "version": 1,
  "completion": { "require": ["test"] },
  "evidence": { "kinds": [{ "kind": "e2e", "argv": [["pnpm", "e2e"]] }] },
  "actions": {
    "default": "ask",
    "rules": {
      "git-push": "allow",
      "gh-pr-merge": { "decision": "allow", "expiresAt": "2026-12-31T00:00:00Z" },
      "package-publish": "deny"
    },
    "custom": [{ "kind": "deploy", "argv": [["./deploy.sh"], ["kubectl", "apply"]] }]
  },
  "opaque": "ask"
}
```

Each evidence `argv` is a command prefix added to the built-in list for that kind. Add `"exact": true` to an evidence entry to replace the built-in list for that kind and count only the whole command run from the repository root, so neither `pnpm test -- one.spec.ts` nor `pnpm test` inside one workspace package stands in for the suite. `"cwd": "plugins/x"` names another directory; a `cd` on the same line is followed, and one the hook cannot read (`cd $DIR`) does not count.

An exact kind can also declare `"scope": ["plugins/x", "shared"]`: the directories its result covers. Git already hashes every directory on its own, so the result then stays fresh while files outside those directories change, and goes stale only when something under them does. The whole tree is the default. Name every directory the check depends on, including what it imports: Core does not build a dependency graph, so a scope that leaves one out lets an old pass count.

`"evidence": { "ignore": ["coverage", "dist"] }` leaves output a check writes out of the tree, so a run that produces a report is not treated as a run during which files changed. Prefer `.gitignore` when the output should never be committed; `ignore` is for paths the repository tracks or deliberately leaves unignored.

An invalid policy file denies every side effect rather than falling back to defaults. An expired rule falls back to `ask`.

## How the agent knows when to stop trying

When `Stop` sends the agent back, the message also says how this session has gone: how many times each missing kind ran, on how many states of the files, and how many of the latest runs failed in a row, plus how many times the session was already sent back. Core only counts. Whether that means the run is converging or going in circles is for the agent, or the person reading `bw status`, to judge. Authority is never extended on that judgement: a longer or wider permission comes from a person editing the policy (`expiresAt`), never from the agent.

## Limits

- It sees only the commands a host adapter shows it. Side effects made some other way are outside its view.
- The hash chain detects partial edits, not a full rewrite by someone with write access to `.git/`. Host adapters keep the agent away from the ledger, the policy file and `bw reconcile <id>`.
- Files matched by `.gitignore` are not part of the evidence tree.
- Every check hashes the whole working tree, so very large repositories pay for it on each call. `scope` changes what is compared, not what is hashed.
- `gh` must be installed and logged in for pull-request and release actions to be reconciled automatically; `SessionStart` warns when the policy needs it and it is not usable.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
