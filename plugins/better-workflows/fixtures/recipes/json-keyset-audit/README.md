# JSON key-set audit

<!-- recipe-readme-section:purpose -->
## Purpose

This deterministic reference recipe compares nested JSON key sets and object-key
order. Use it to find missing keys and ordering drift across two or more
documents without changing the input files or source tree.

<!-- recipe-readme-section:inputs -->
## Inputs

Pass an object with a `documents` array. Each of the 2–100 entries requires a
unique reader-facing `label` and a `json` string whose root value is an object.

```json
{
  "documents": [
    { "label": "alpha", "json": "{\"name\":\"alpha\",\"enabled\":true}" },
    { "label": "beta", "json": "{\"name\":\"beta\",\"enabled\":false}" }
  ]
}
```

The complete deterministic fixture is in [`fixtures/input.json`](fixtures/input.json).

<!-- recipe-readme-section:outputs -->
## Outputs

- `keyset-report.json` contains labels, per-document key positions, and the
  `identicalKeySets` and `identicalOrder` decisions.
- `keyset-report.md` presents the same comparison as a readable table.
- The run proposes a `json-keyset-audit` evidence candidate. Root must verify
  it before admission; the recipe cannot accept its own evidence.

<!-- recipe-readme-section:safety-boundary -->
## Safety boundary

The manifest declares no `readPaths`. The recipe parses only the JSON strings
provided in its input, uses no network or shell, starts no child process, and
cannot mutate source. It writes only declared artifacts to the private staging
directory supplied by the governed recipe runtime.

Invalid JSON, a non-object root, an undeclared artifact, or an exceeded byte or
time limit fails the run without publishing partial output.

<!-- recipe-readme-section:run-example -->
## Run the example

From a Git worktree root, initialize the private recipe workspace, copy this
reference recipe, and validate its manifest, entry point, and fixture parity:

```bash
sbw recipe init
sbw recipe scaffold json-keyset-audit
sbw recipe validate json-keyset-audit
```

After governed promotion, execute the trusted copy with its fixture. Start with
a dry run, which discards staged artifacts:

```bash
sbw recipe run json-keyset-audit \
  --input-file .codex/better-workflows/recipes/json-keyset-audit/fixtures/input.json \
  --dry-run
```

<!-- recipe-readme-section:promotion-lifecycle -->
## Govern promotion

Validation does not grant trust. Review the manifest, code, fixture, declared
reads, limits, and execution digest. A `workspace-recipe` run must then satisfy
its evidence and sentinel gates, obtain a `recipe.promote` action, and receive
the user's exact digest confirmation:

```bash
sbw recipe promote <id> \
  --run <workspace-recipe-run-id> \
  --attempt <attempt-id> \
  --confirm-digest <execution-digest>
```

Normal execution atomically publishes only declared artifacts. Moving one
artifact into tracked source requires a separate `artifact.promote` action.
See the [architecture guide](../../../../../docs/guide/architecture.md) and
[CLI reference](../../../../../docs/guide/cli-reference.md) for the full trust,
run, untrust, and artifact lifecycle.
