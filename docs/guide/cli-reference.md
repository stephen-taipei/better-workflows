# CLI reference

| [Overview](../../README.md) | [Details](../details/en.md) | [Quick start](getting-started.md) | [Workflows](workflows.md) | [Architecture](architecture.md) | [Security](security.md) | **CLI** |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[41-locale localized overview and official web entry points](../LANGUAGES.md). Commands and identifiers remain canonical in English.

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
sbw route preview --goal "<goal>" --scope <path> \
  --autonomy-profile bounded-autopilot-v1
sbw route profile validate --file <profile.json>
sbw route profile install --file <profile.json>
sbw route profile show
```

## Runs, evidence, and findings

```bash
sbw run --template <template> --mode <mode> --goal "<goal>" --scope <path>
sbw run --template self-improve-ops --mode critical --goal "<goal>" \
  --scope <path> --baseline <immutable-baseline-sha> \
  [--evaluation-purpose ordinary|evaluator-migration|safety-remediation-v1|quality-remediation-v1]
sbw run --template pr-to-dev --mode critical --goal "<goal>" --scope <path> \
  --self-improve-run <self-improve-run-id>
sbw run --template pr-to-dev --mode critical --goal "<goal>" --scope <path> \
  --autonomy-profile bounded-autopilot-v1
sbw run --template pr-to-dev-agent-quorum --mode critical --goal "<ordinary PR goal>" --scope <path>
sbw self-improve handoff <pr-to-dev-run-id> --source-run <self-improve-run-id>
sbw run --route-receipt <route-receipt-id>
sbw status <run-id>
sbw resume <run-id>
sbw autonomy preview <run-id>
sbw autonomy preflight <run-id>
sbw autonomy revoke <run-id>
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
sbw review axis-digest <run-id> --file <axis-receipt.json>
sbw review axis <run-id> --file <axis-receipt.json> \
  --reviewer-id <native-agent-id> --attestation <host-file>
sbw review verify-digest <run-id> --file <verification-receipt.json>
sbw review verify <run-id> --file <verification-receipt.json> \
  --reviewer-id <native-agent-id> --attestation <host-file>
sbw review coverage <run-id>
sbw review synthesize <run-id>
sbw review status <run-id>
sbw review quorum status <run-id>
sbw review quorum verify <run-id> --file <quorum-manifest.json>
sbw review quorum run <run-id> --file <quorum-manifest.json>
sbw review finding <run-id> --file <finding.json>
sbw review repair <run-id> --package <package-id> --file <result.json>
sbw review broad <run-id> --package <package-id> --head <sha> --sentinel-digest <sha256>
sbw refinement status <run-id>
sbw refinement apply <run-id> --file <receipt.json>
sbw complete <run-id>
```

`source rebind` is root-only and pre-review/pre-side-effect. It invalidates all
prior complete evidence and resets the v2 execution ledger, so the next
sentinel, evidence, and review must be captured from the rebound source.

The `code-v2-pilot` review kernel is currently enabled only by
`self-improve-ops` as an observe-only pilot. Its axis and verification commands
accept only host-attested, read-only native-subagent executions. Every required
axis must account for every immutable diff work unit, and a different reviewer
must verify each reported claim before deterministic synthesis. `coverage` and
`synthesize` publish only the aggregate `work-unit-accounting` and
`review-kernel-summary` evidence; per-axis and per-claim records remain in the
private append-only review state. The pilot denies all action tokens, including
commit, push, cache publication, PR creation, and merge. The native signing
request for `review axis` or `review verify` must include the receipt's exact
`executionId`; a legacy v1 native-critic request may omit it but cannot satisfy
either v2 command.

Every review-enabled template also binds a `reviewProfile` into its
TaskContract and review-package identity. `review-contract-v1` records the
legacy-compatible diff-manifest, package-location, broad-review, provenance,
and instruction-digest guarantees. Only `review-kernel-v2-pilot` records exact
work-unit accounting, source-quote anchors, finder/verifier separation, and
host-attested native provenance; it remains restricted to `self-improve-ops`.

`pr-to-dev-agent-quorum` binds `review-quorum-v1` and the
`agent-review-quorum-v1` policy. It is intended only for ordinary low-risk PR
diffs. The five fixed role receipts must all be PASS and must satisfy the
identity/provider diversity rules. `review quorum verify` is read-only;
`review quorum run` admits the typed receipt after the same checks. Neither
command invokes `sudo` or the host signer. A high-risk or unclassified diff is
HOLD and must be handled by the existing host-trusted `pr-to-dev` path.

Evaluator attestation request generation uses the unique currently valid
host-approved native Codex binary by default. If more than one valid entry is
installed, pass its exact canonical path with `--binary`; PATH wrappers and
unapproved binaries fail closed.

Ledger transition files may include `expectedLedgerDigest`; when present it
must match the current canonical `ledger.json` digest. Transitions are
root-owned, and stale expected digests or non-root actors fail closed.

`actions.dispatch` is currently deferred. GitHub workflow dispatch resolves a
mutable ref and cannot atomically bind execution to the preflight-attested
workflow bytes, so the governed lifecycle rejects new dispatch tokens and
executable provider paths. Existing dispatch records can still be validated or
reconciled read-only; do not treat a post-dispatch head check as authorization.

Governed GitHub actions record an absolute `gh` executable path and content
digest at token issuance. Provider probes and fixed-argv wrappers use that
recorded identity; a PATH or executable drift fails closed. A non-zero PR
creation wrapper exit after preflight remains sent-or-indeterminate, so keep
the `pull/new` reservation and reconcile with a pinned provider query rather
than treating it as an immediate failure. An explicitly recorded `not-sent`
preflight failure can release the reservation directly; a fresh provider proof
of exact absence can reconcile the same unknown attempt as failure, while a
provider object or identity drift remains fail-closed.

Creation reservations are namespaced by provider repository, action, and
resource; an unknown PR in one repository cannot poison another repository's
`pull/new` slot.

Use `sbw action execute` for wrapper-backed `git.push`, `pr.create`, and
`pr.merge`; `execute` consumes the token internally. Direct `action consume` is
reserved for non-wrapper side effects that the root performs before a separate
reconciliation. Contract `deferredActions` are rejected by the core lifecycle,
even when a template has no active action stage.

For governed `git.push`, `--remote-revision` remains the protected task/base
revision used by the contract and review gates. The action binding separately
captures the exact current source commit (`expectedRevision`) that the pinned
credential dry-run and fixed-argv push will transfer. Remote-authorization
evidence must bind its `payload.remoteRevision` to that source commit; PR merge
authorization continues to bind its payload to the protected base revision.

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
already trusted code and leaves no published artifact. Successful
`recipe.promote` and `artifact.promote` source writes are reconciled as exact,
one-path provider-action transitions; extra workspace drift or a tampered
transition is audited as non-authorizing.

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
sbw self-improve consent status
sbw self-improve consent prepare
# execute the returned digest-bound administratorCommand once
sbw self-improve attestation request \
  --run <run-id> \
  --baseline <sha> \
  --candidate-root . \
  --model <model> \
  --output <outside-repo-directory>
```

Real Codex replay requires one distinct root-owned host execution witness per
execution. The candidate must already be an exact committed HEAD; source or
plugin-bundle changes after request generation invalidate the run. The
administrator reviews the manifest digest and runs its returned
`executeCommand` through the installed, capability-checked signer. That signer
executes Codex once, captures the response/timing/exit data, writes the
one-shot host ledger, and creates the result receipt. The evaluator consumes
the returned witness path via `--trusted-codex-execution` and rechecks its
prompt/response digest, binary/model, execution binding, ledger, exit status,
timestamps, and trust root before delivery; it never reruns Codex. The host
allowlist must contain the canonical native Mach-O Codex binary and its current
SHA-256; the JS wrapper or an arbitrary executable is rejected. Evaluation
also requires `--request-manifest` and its administrator-confirmed
`--request-manifest-digest`; the evaluator checks the root-owned completed batch
journal and every request digest/run-as tuple against that manifest.

After the one-time standing consent is active, exact `gpt-5.6-terra` batches
that satisfy the checked-in sanitizer policy return an `executeCommand` using
`/usr/bin/sudo -n` and schemaVersion 5. The root signer still independently
revalidates the fixed repository, user identity, request root, model, purpose,
count, source binding, prompt, file manifest, secret filter, and byte/case
budgets. An active or partially installed grant with any mismatch fails closed
instead of silently opening a password prompt. The explicit administrator path
is available only when the grant is absent or explicitly revoked; inspect or
prepare revocation with `sbw self-improve consent status|revoke`. This grant
never supplies delivery action tokens.

Self-improve does not issue commit, cache-publication, push, merge, or cleanup
tokens. After replay evidence is accepted, create the delegated `pr-to-dev`
run with `--self-improve-run`, record the typed `self-improve-delivery-handoff`,
and only then use the governed atomic-commit/`dev` PR flow and immutable cache
publisher. The handoff is bound to the clean exact source HEAD and the complete
purpose-specific witness set: seven trusted replays for ordinary evaluation or
eight for evaluator migration.

## Repository validation

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
node scripts/plugin-cache.mjs check
sbw action issue <pr-to-dev-run-id> --action plugin.cache.publish --provider local-workspace --resource plugin-cache:<source-head-revision> --remote-revision <target-branch-revision>
SBW_STATE_ROOT=<state-root> node scripts/plugin-cache.mjs sync --handoff-run <pr-to-dev-run-id> --token <plugin-cache-action-token>
```

Plugin cache versions are immutable. A changed bundle requires a new build
version; publication never overwrites an existing version with different
contents.
