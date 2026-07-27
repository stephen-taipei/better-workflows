---
name: workspace-recipe
description: Goal-first 將穩定且可驗證的 SOP 固化為 workspace 內受治理的 Node.js recipe，經明確 digest promotion 後重複執行。選擇 $better-workflows:workspace-recipe 時使用。
---

# Workspace recipe

Read `../better-workflows/SKILL.md` completely and follow it, including the
Goal-first entry contract.

Use template `workspace-recipe` with minimum mode `verified`. This selector
governs deterministic workspace-owned recipes; it does not let a recipe choose
models, orchestrate agents, accept risk, mutate source, run arbitrary shell, or
perform external side effects.

## Decide whether a recipe is appropriate

A recipe is appropriate only when the SOP has stable mechanical inputs and
outputs, deterministic validation, bounded declared reads, and repeat value.
Root may scaffold one when the user explicitly asks. An automatic suggestion
requires at least two completed structured runs with the same recurrence
fingerprint in the preceding 90 days. Never inspect raw conversation history,
memory transcripts, credentials, provider receipts, or secrets to infer
recurrence.

Do not automatically initialize a workspace, scaffold code, promote trust, run
a recipe, or promote an artifact. Keep judgment, model selection, agent
orchestration, evidence acceptance, findings, and action-token authority in the
Better Workflows run.

## Govern the lifecycle

Resolve only the Git worktree root. Do not search nested packages for recipe
precedence. Initialize explicitly with:

```sh
sbw recipe init
sbw recipe scaffold <recipe-id>
sbw recipe validate <recipe-id>
```

Review `recipe.json`, `run.mjs`, fixtures, declared reads, input schema,
artifact caps, and validation output. Treat repository recipes as untrusted
after every clone, workspace change, manifest or entry drift, plugin bundle
change, or Node major change.

Before `recipe.promote`, require the template evidence, current complete
sentinel, no open P0/P1 finding, two matching candidate dry-runs, fixture
parity, and the user's exact digest confirmation. Issue and consume a
`recipe.promote` action token bound to
`recipe:<id>:<execution-digest>`, then pass its attempt ID:

```sh
sbw recipe promote <id> \
  --run <workspace-recipe-run-id> \
  --attempt <attempt-id> \
  --confirm-digest <execution-digest>
```

`--dry-run` executes the already trusted program and discards staging
artifacts. A normal run atomically publishes only declared artifacts:

```sh
sbw recipe run <id> --input-file <input.json> --dry-run
sbw recipe run <id> --input-file <input.json>
```

Evidence candidates remain candidates until Root verifies source digests and
freshness. Proposals describe later work only and never authorize it.

Promoting one ignored artifact into tracked source requires a separate
`artifact.promote` action token bound to
`artifact:<receipt-id>:<artifact-id>:<repo-relative-destination>`. Never
overwrite an existing destination. Use `sbw recipe prune` for a read-only
retention preview and `sbw recipe prune --apply` only when deletion is
explicitly authorized.
