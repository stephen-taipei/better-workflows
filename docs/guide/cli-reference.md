# CLI reference

| [Overview](../../README.md) | [Details](../details/en.md) | [Quick start](getting-started.md) | [Workflows](workflows.md) | [Architecture](architecture.md) | [Security](security.md) | **CLI** |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

Run from a checkout with:

```bash
node plugins/better-workflows/scripts/sbw.mjs <command>
```

A verified global `sbw` binary is optional. `sbw help` is the canonical source
for exact options in the installed build.

## Diagnose and route

```bash
sbw doctor
sbw doctor --capabilities
sbw route preview --goal "<goal>" --scope <path>
sbw route profile validate --file <profile.json>
sbw route profile install --file <profile.json>
sbw route profile show
```

## Runs, evidence, and findings

```bash
sbw run --template <template> --mode <mode> --goal "<goal>" --scope <path>
sbw run --route-receipt <route-receipt-id>
sbw status <run-id>
sbw resume <run-id>
sbw sentinel capture <run-id> --label <label>
sbw sentinel verify <run-id> --label <label>
sbw evidence add <run-id> --file <evidence.json>
sbw finding add <run-id> --file <finding.json>
sbw finding update <run-id> --file <finding.json>
sbw complete <run-id>
```

## Graph View

```bash
sbw graph validate
sbw graph validate --template <name>
sbw graph validate --run <run-id>
sbw graph inspect --template <name> [--format json|mermaid]
sbw graph inspect --run <run-id> [--format json|mermaid]
```

`inspect` accepts exactly one target. JSON is canonical; Mermaid stays in the
JSON envelope's `content`. Success exits `0`, structural diagnostics exit `2`,
and usage/system errors exit `1`.

## Workspace recipes

```bash
sbw recipe init
sbw recipe scaffold <id>
sbw recipe list
sbw recipe validate <id>
sbw recipe promote <id> \
  --run <run-id> \
  --attempt <attempt-id> \
  --confirm-digest <sha256>
sbw recipe run <id> --input-file <input.json> --dry-run
sbw recipe run <id> --input-file <input.json>
sbw recipe status <id>
sbw recipe untrust <id>
sbw recipe artifact promote <receipt-id> --artifact <id> --to <relative-path>
sbw recipe prune
sbw recipe prune --apply
```

`artifact.promote` is an independent action authority. A dry run executes only
already trusted code and leaves no published artifact.

## Model deliberation

```bash
sbw deliberation roster \
  --allow-external-providers \
  --sanitized \
  --reasoning-effort auto \
  --mode deep \
  --refresh

sbw deliberation deliberate \
  --prompt-file <sanitized-case.md> \
  --mode deep \
  --reasoning-effort auto \
  --allow-external-providers \
  --sanitized
```

Gemini models are reached through Antigravity CLI (`agy`) in this runtime.
`agy` is transport metadata, not a second model brand.

## Self-improvement host flow

```bash
sbw self-improve host status
sbw self-improve attestation request \
  --run <run-id> \
  --baseline <sha> \
  --candidate-root . \
  --model <model> \
  --output <outside-repo-directory>
```

## Repository validation

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
node scripts/plugin-cache.mjs check
```

Plugin cache versions are immutable. A changed bundle requires a new build
version; publication never overwrites an existing version with different
contents.
