# Getting started

| [Overview](../../README.md) | [Details](../details/en.md) | **Quick start** | [Workflows](workflows.md) | [Architecture](architecture.md) | [Security](security.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

## Requirements

- Codex with plugin support.
- Node.js 24 or newer for the bundled `sbw` helper.
- A trusted local repository. Better Workflows does not claim to sandbox
  malicious repository code.

## Install

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

Open a new Codex task after installation so its skill catalog refreshes.

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
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

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
