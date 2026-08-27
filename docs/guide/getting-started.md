# Getting started

| [Overview](../../README.md) | [Details](../details/en.md) | **Quick start** | [Workflows](workflows.md) | [Architecture](architecture.md) | [Security](security.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

## Requirements

- A Tier 1 host: Codex, Claude Code, Gemini CLI, or Qwen Code on macOS or Linux.
- Node.js 24 or newer for the bundled `sbw` helper.
- A trusted local repository. Better Workflows does not claim to sandbox
  malicious repository code.

The official reference experience is **macOS + Codex**. It has the deepest
native integration. Other Tier 1 hosts use the same TaskContract, evidence,
Replay, action-gate, and worktree semantics through the core bridge, but their
picker, subagent, host-trust, and publication UX is not identical.

The v4 state root is host-neutral: `SBW_STATE_ROOT` wins when set, then
`XDG_STATE_HOME/better-workflows`, otherwise `~/.better-workflows`. It no
longer defaults under `CODEX_HOME`. To keep using an existing v3 Codex state
without moving it, set `SBW_STATE_ROOT` explicitly to that exact
`<CODEX_HOME>/sbw` directory before invoking `sbw`.

## Install

### Codex — recommended reference

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

Open a new Codex task after installation so its skill catalog refreshes.

### Claude Code

From Claude Code, use its official plugin marketplace commands:

```text
/plugin marketplace add stephen-taipei/better-workflows
/plugin install better-workflows@better-workflows
```

Restart or run `/reload-plugins` when Claude Code asks you to activate the
cached plugin. The repository ships `.claude-plugin/marketplace.json` and the
plugin ships `.claude-plugin/plugin.json` plus its `skills/` directory.

### Gemini CLI

```bash
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref v4.0.0
```

Gemini CLI copies the extension. Restart the session after installation; use
`gemini extensions update better-workflows` to refresh it later.

The extension context resolves the bridge from its own loaded source path, not
from your project working directory. For a standard user-scoped install, the
equivalent manual check is:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

For a linked or workspace-scoped extension, use the exact extension root shown
by the host. Do not substitute a similarly named checkout.

### Qwen Code

Pin the release before installing the local extension copy:

```bash
git clone --branch v4.0.0 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code also copies the extension, so restart the session after installation
and use `qwen extensions update better-workflows` for later updates.

For a standard user-scoped install, the equivalent manual bridge check is:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

The same exact-root rule applies to linked or workspace-scoped installs.

These mechanisms follow the official [Claude Code plugin](https://code.claude.com/docs/en/plugins),
[Gemini CLI extension](https://geminicli.com/docs/extensions/reference/), and
[Qwen Code extension](https://qwenlm.github.io/qwen-code-docs/en/developers/extensions/extension/)
contracts. Tier 1 release claims still require Better Workflows conformance;
the presence of an upstream extension feature alone is not proof. Conformance
checks the pinned CLI version, runs the official Claude/Gemini validator,
installs the Gemini and Qwen repository distributions into an isolated home,
and verifies the installed manifest, context, and helper against the exact
source digests before exercising the shared safety suite. Claude validation
uses strict mode so warnings cannot silently become Tier 1 release proof. The
release gate authenticates that exact host/OS receipt in CI.

### Preview hosts

Kimi Code CLI, Kiro, Grok Build, Cursor, and GitHub Copilot use the
[plugin-local manual compatibility pack](../../plugins/better-workflows/compatibility/preview/INSTRUCTIONS.md).
Load the matching manifest and shared instructions through the host's own
repository-instruction mechanism, then call the plugin-local `sbw` helper.
This path is a local smoke-tested core bridge, not a native extension or Tier 1
promise. Windows remains OS Preview for every host in v4.0.0.

## Pick a workflow

In Codex CLI, type `@better`. In the Codex App, type `/better`.

Use the automatic entry when you do not already know the route:

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Use a specific entry when the desired workflow is already known:

```text
$better-workflows:pr-to-dev Split the current changes into atomic commits, open a PR to dev, and merge after fresh checks.
```

Every entry preserves the requested Goal. An unrelated active Goal must be
edited or cleared explicitly; it is never silently replaced.

## Preview the route

The capability snapshot is read-only and does not trigger provider login or a
semantic model probe:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --domain maintenance \
  --tag dependabot
```

For a reviewable handoff, record and consume one private, single-use receipt:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry monorepo-refactor \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Receipts expire after 24 hours and fail closed on replay or drift in workspace,
scope, Profiles, catalog, capabilities, or plugin bundle.

## Verify the installation

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

Use `codex`, `claude-code`, `gemini-cli`, or `qwen-code` as `<host-id>`. A
local conformance PASS proves the current executable, manifest, and core bridge
are present. It is intentionally not a release receipt; v4.0.0 requires an
authenticated CI/provider envelope for all eight Tier 1 host/OS combinations.

## Before a repository mutation

Auto starts with a read-only workspace preflight:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Non-Git and read-only tasks do not create a worktree. A mutating Git task must
create or reuse a task-owned `TaskWorkspaceLeaseV1`. Dirty source state stops
before any stash, copy, commit, or worktree creation. Detached HEAD or a missing
target requires an explicit integration target. Protected or remote targets
are promoted to governed PR delivery.

If Codex or another host already created the current task's clean worktree,
register it before editing instead of creating a nested worktree:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Registration requires a distinct `codex/*` task branch at the unchanged base,
the same Git common directory, and a clean source checkout. Better Workflows
uses the worktree but preserves the host-owned branch and path during cleanup.
For a protected target, run the evidence workflow first, then bind its exact PR
merge and remote-sync receipts with `workspace reconcile --run-id <run-id>`.

## Optional: initialize workspace recipes

Nothing is created automatically. From the Git worktree root:

```bash
node plugins/better-workflows/scripts/sbw.mjs recipe init
node plugins/better-workflows/scripts/sbw.mjs recipe scaffold json-keyset-audit
node plugins/better-workflows/scripts/sbw.mjs recipe validate json-keyset-audit
```

Initialization creates `.codex/better-workflows/`. A cloned recipe remains
untrusted until its exact digest is explicitly promoted in that workspace.

Next: [choose the right workflow](workflows.md) or browse the
[CLI reference](cli-reference.md).
