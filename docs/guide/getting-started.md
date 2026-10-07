# Getting started

| [Overview](../../README.md) | [Details](../details/en.md) | **Quick start** | [Workflows](workflows.md) | [Architecture](architecture.md) | [Security](security.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[41-locale localized overview and official web entry points](../LANGUAGES.md). Commands and identifiers remain canonical in English.

V5.0 RC1 (`5.0.0-rc.1`, tag `V5.0.rc1`) is publicly available. Its release scope covers Auto only, with Codex, Gemini CLI, and Qwen Code on macOS Node 22/24. Linux and Windows qualification is deferred to V5.1, as is Claude Code qualification. GA `5.0.0` remains pending until at least 30 natural canary days, 20 consecutive eligible starts, and three distinct repositories are recorded.

## Requirements

- Node.js 22.14 or newer for the bundled `sbw` helper.
- A trusted local repository. Better Workflows does not claim to sandbox
  malicious repository code.

The v4 state root is host-neutral: `SBW_STATE_ROOT` wins when set, then
`XDG_STATE_HOME/better-workflows`, otherwise `~/.better-workflows`. It no
longer defaults under `CODEX_HOME`. To keep using an existing v3 Codex state
without moving it, set `SBW_STATE_ROOT` explicitly to that exact
`<CODEX_HOME>/sbw` directory before invoking `sbw`.

V5.0 GA (`5.0.0`) remains pending. The installation commands below target the
publicly available V5.0 RC1 (`5.0.0-rc.1`, tag `V5.0.rc1`).

## Install

### Codex — recommended reference

```bash
# Install the publicly available V5.0.rc1 release candidate.
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
node plugins/better-workflows/scripts/sbw.mjs version --json
node plugins/better-workflows/scripts/sbw.mjs update status --json
# Before the first check, status is unknown. Choose one update mode; manual is
# the default. off disables network access even for an explicit check, while an
# explicit check can query manual or automatic mode without the 24-hour throttle.
node plugins/better-workflows/scripts/sbw.mjs update configure --mode off
node plugins/better-workflows/scripts/sbw.mjs update configure --mode manual
node plugins/better-workflows/scripts/sbw.mjs update configure --mode automatic
node plugins/better-workflows/scripts/sbw.mjs update check --json
# automatic is opt-in, interactive-only, best effort, and at most once/24h;
# success and failure both consume the slot. Automatic checks are skipped in CI,
# --json, and non-interactive paths. It never auto-installs; only fixed public
# metadata is used.
```

Open a new Codex task after installation so its skill catalog refreshes.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
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
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
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

## Use Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
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
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

For a reviewable handoff, record and consume one private, single-use receipt:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
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

Next: [choose the right workflow](workflows.md) or browse the
[CLI reference](cli-reference.md).
