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
sbw source rebind <run-id> --reason <text>
sbw sentinel capture <run-id> --label <label>
sbw sentinel verify <run-id> --label <label>
sbw evidence add <run-id> --file <evidence.json>
sbw finding add <run-id> --file <finding.json>
sbw finding update <run-id> --file <finding.json>
sbw ledger status <run-id>
sbw ledger transition <run-id> --file <event.json>
sbw ledger compile <run-id> --design-packet <packet.json>
sbw review package <run-id> --base <sha> --head <sha> --scope <path> \
  --diff-manifest <json> --instruction-digest <sha256> --sentinel-digest <sha256>
sbw review status <run-id>
sbw review finding <run-id> --file <finding.json>
sbw review repair <run-id> --package <package-id> --file <result.json>
sbw review broad <run-id> --package <package-id> --head <sha> --sentinel-digest <sha256>
sbw refinement status <run-id>
sbw refinement apply <run-id> --file <receipt.json>
sbw complete <run-id>
```

Ledger transition files may include `expectedLedgerDigest`; when present it
must match the current canonical `ledger.json` digest. Transitions are
root-owned, and stale expected digests or non-root actors fail closed.

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

sbw deliberation deliberate --run <run-id> \
  --prompt-file <sanitized-case.md> \
  --allow-external-providers --sanitized
```

The run-bound form is an atomic, idempotent receipt: it writes one private
bundle only after roster, perspectives, arbitration, decision, and derived
evidence all succeed, and prints only the bundle ID/digest, participant status,
and decision summary.

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
