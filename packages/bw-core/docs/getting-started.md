# Getting started with Better Workflows Core

[繁體中文（台灣）](getting-started.zh-TW.md)

Better Workflows Core stops a Claude Code agent from finishing on a test result that no longer matches the files, and from repeating or stacking side effects whose result never came back. This guide takes a clean repository to its first block in a few minutes.

Status: alpha (`6.0.0-alpha.1`). The policy format may still change before beta.

## Requirements

- Node.js 22.14 or later, with npm
- Git
- Claude Code with plugin support (`claude plugin --help` works)

## 1. See it work without Claude (a few seconds)

```bash
npm install -g @better-workflows/core@alpha
node "$(npm root -g)/@better-workflows/core/examples/stale-green/demo.mjs"
```

The first line installs the `bw` command. The demo builds a throwaway repository and sends the same hook events Claude Code sends. It shows:

1. Tests pass, then a file is edited: finishing is blocked because the passing run was on older files.
2. The tests fail on the new files: still blocked. They pass on the final files: allowed.
3. A push times out after it reached the remote: the retry is refused instead of pushing twice.
4. A deploy times out and nothing can read back whether it happened: further side effects are refused until a person settles it.

It exits 1 if any step does not behave as described.

## 2. Install the plugin

Once per machine:

```bash
claude plugin marketplace add stephen-taipei/better-workflows
```

Then in each repository you want to protect:

```bash
claude plugin install better-workflows-core@better-workflows --scope local
bw init
```

`--scope local` turns the plugin on for this repository only, in `.claude/settings.local.json`, which Git does not track. `bw init` writes `.better-workflows/policy.json`. Commit the policy file: it is the only place the agent's permissions come from, and the agent is not allowed to change it.

## 3. Your first block

Start Claude Code in the repository and ask for a small change, telling it not to run the tests. When it tries to finish, the Stop hook sends it back once: the required `test` evidence does not match the current files. The agent then either runs the tests or says plainly that they were not run.

Check the state at any time:

```bash
bw status
```

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

A check counts only when its own exit code decides the command's result. `pnpm test | tail -20`, `pnpm test; echo done` and `pnpm test || true` exit 0 even when the tests fail, so they never count; use `&&`, or start the line with `set -o pipefail`.

By default an evidence command is a prefix, so `pnpm test -- one.spec.ts` counts as `test`. To require the whole suite, mark the kind exact. This replaces the built-in commands for that kind and counts the command only when it runs from the repository root, or from the directory named by `"cwd"`:

```json
"evidence": { "kinds": [{ "kind": "test", "argv": [["pnpm", "test"]], "exact": true }] }
```

In a repository with more than one test suite, tell each exact kind which directories its result covers, so editing one part does not make every suite stale:

```json
"evidence": {
  "ignore": ["coverage"],
  "kinds": [
    { "kind": "plugin-test", "argv": [["make", "plugin-test"]], "exact": true, "cwd": "plugins/x", "scope": ["plugins/x", "shared"] },
    { "kind": "script-test", "argv": [["make", "script-test"]], "exact": true, "cwd": "scripts", "scope": ["scripts"] }
  ]
}
```

- `scope` lists every directory the check depends on, including the ones it imports from. Core does not work that out for you; a directory left out lets an old pass count after a change there.
- `ignore` lists output the checks write (reports, build output) that is not in `.gitignore`. Without it, a run that writes such a file looks like a run during which files changed and never counts.

When the hook sends the agent back, it also reports how this session has gone (runs, states of the files, failures in a row, times sent back). That is for the agent to decide whether to keep going or to stop and tell you what is failing. If you want it to keep pushing or merging for longer, that is your decision, made by editing the policy, not something the agent can grant itself.

## 5. When a side effect's result is unknown

Only exit code 0 counts as success. A timeout, an interrupt or any other exit leaves the action `unknown`, and further side effects are refused. Before the next side effect, the hook checks pushes, pull requests, releases and npm publishes with read-only queries (`git ls-remote`, `gh pr view`, `gh release view`, `npm view`) and settles them when it can.

Anything it cannot read back, such as a custom deploy, needs a person:

```bash
bw status
bw reconcile act_… --outcome success --note "checked the deploy log"
```

`bw status` lists the open action and its id.

The agent cannot run `bw reconcile <id>` or `bw init`, and cannot edit `.better-workflows/` or `.git/`.

## Updating

The plugin and the `bw` command come from the same package; update them together:

```bash
claude plugin marketplace update better-workflows
claude plugin update better-workflows-core@better-workflows --scope local
npm install -g @better-workflows/core@alpha
```

Run `claude plugin update` in each repository where the plugin is installed.

## Installing from a checkout

To run unreleased changes, use a clone instead of the marketplace and npm. If you ran V5 on this machine, `~/.better-workflows` holds its state; move it aside first and tell V5 where it went:

```bash
mv ~/.better-workflows ~/.better-workflows-V5
echo 'export SBW_STATE_ROOT="$HOME/.better-workflows-V5"' >> ~/.zshrc
```

If your shell is bash, write to `~/.bashrc` instead of `~/.zshrc`.

```bash
git clone --depth 1 https://github.com/stephen-taipei/better-workflows ~/.better-workflows
claude plugin marketplace add ~/.better-workflows/packages/bw-core
alias bw="node ~/.better-workflows/packages/bw-core/bin/bw.mjs"
```

## Turning it off

```bash
claude plugin uninstall better-workflows-core@better-workflows --scope local
```

The ledger stays in `.git/better-workflows/` until you delete it.

## Limits

- It only sees the commands Claude Code shows its hooks. A side effect inside a script the agent runs (for example a `release.sh` that pushes) is invisible unless the policy names that script as a custom action.
- Evidence covers tracked and untracked files that Git does not ignore.
- Every check hashes the working tree, so very large repositories pay for that on each call.
- Pull requests and releases are reconciled with `gh`. If it is not installed or not logged in, those actions stay unknown until you settle them by hand; `SessionStart` warns you when the policy needs `gh` and it is not usable.
