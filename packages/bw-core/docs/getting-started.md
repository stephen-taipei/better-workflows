# Getting started with Better Workflows Core

[繁體中文（台灣）](getting-started.zh-TW.md)

Better Workflows Core stops a Claude Code agent from finishing on a test result that no longer matches the files, and from repeating or stacking side effects whose result never came back. This guide takes a clean repository to its first block in a few minutes.

Status: pre-alpha. Until the alpha release, Core is installed from a Git checkout.

## Requirements

- Node.js 22.14 or later
- Git
- Claude Code with plugin support (`claude plugin --help` works)

## 1. See it work without Claude (about 2 seconds)

```bash
git clone --depth 1 https://github.com/stephen-taipei/better-workflows ~/.better-workflows
node ~/.better-workflows/packages/bw-core/examples/stale-green/demo.mjs
```

The demo builds a throwaway repository and sends the same hook events Claude Code sends. It shows:

1. Tests pass, then a file is edited: finishing is blocked because the passing run was on older files.
2. The tests fail on the new files: still blocked. They pass on the final files: allowed.
3. A push times out after it reached the remote: the retry is refused instead of pushing twice.
4. A deploy times out and nothing can read back whether it happened: further side effects are refused until a person settles it.

It exits 1 if any step does not behave as described.

## 2. Install the plugin

Once per machine:

```bash
claude plugin marketplace add ~/.better-workflows/packages/bw-core
```

Then in each repository you want to protect:

```bash
claude plugin install better-workflows-core@better-workflows --scope local
node ~/.better-workflows/packages/bw-core/bin/bw.mjs init
```

`--scope local` turns the plugin on for this repository only, in `.claude/settings.local.json`, which Git does not track. `bw init` writes `.better-workflows/policy.json`. Commit the policy file: it is the only place the agent's permissions come from, and the agent is not allowed to change it.

## 3. Your first block

Start Claude Code in the repository and ask for a small change, telling it not to run the tests. When it tries to finish, the Stop hook sends it back once: the required `test` evidence does not match the current files. The agent then either runs the tests or says plainly that they were not run.

Check the state at any time:

```bash
node ~/.better-workflows/packages/bw-core/bin/bw.mjs status
```

Tip: `alias bw="node ~/.better-workflows/packages/bw-core/bin/bw.mjs"`.

## 4. Tell it what your checks and side effects are

The default policy requires a passing `test` before work counts as complete and asks before every side effect. Common commands (`npm test`, `pnpm test`, `pytest`, `go test`, `cargo test` and others) are recognised as tests. Add your own:

```json
{
  "version": 1,
  "completion": { "require": ["test", "lint"] },
  "evidence": { "kinds": [{ "kind": "lint", "argv": [["pnpm", "lint:ci"]] }] },
  "actions": {
    "default": "ask",
    "rules": { "git-push": "allow", "package-publish": "deny" },
    "custom": [{ "kind": "deploy", "argv": [["./deploy.sh"]] }]
  }
}
```

- `allow` defers to Claude Code's own permission rules; it never grants more than Claude Code already would.
- `ask` sends the call to Claude Code's permission prompt.
- `deny` blocks it.
- A rule can expire: `{ "decision": "allow", "expiresAt": "2026-12-31T00:00:00Z" }`. After that it falls back to `ask`.
- An invalid policy file blocks every side effect until it is fixed.

## 5. When a side effect's result is unknown

Only exit code 0 counts as success. A timeout, an interrupt or any other exit leaves the action `unknown`, and further side effects are refused. Before the next side effect, the hook checks pushes, pull requests, releases and npm publishes with read-only queries (`git ls-remote`, `gh pr view`, `gh release view`, `npm view`) and settles them when it can.

Anything it cannot read back, such as a custom deploy, needs a person:

```bash
bw status                      # lists the open action and its id
bw reconcile act_… --outcome success --note "checked the deploy log"
```

The agent cannot run `bw reconcile <id>` or `bw init`, and cannot edit `.better-workflows/` or `.git/`.

## Turning it off

```bash
claude plugin uninstall better-workflows-core@better-workflows --scope local
```

The ledger stays in `.git/better-workflows/` until you delete it.

## Limits

- It only sees the commands Claude Code shows its hooks. A side effect inside a script the agent runs (for example a `release.sh` that pushes) is invisible unless the policy names that script as a custom action.
- Evidence covers tracked and untracked files that Git does not ignore.
- Every check hashes the working tree, so very large repositories pay for that on each call.
