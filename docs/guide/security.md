# Security

| [Overview](../../README.md) | [Details](../details/en.md) | [Quick start](getting-started.md) | [Workflows](workflows.md) | [Architecture](architecture.md) | **Security** | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

## Authority boundaries

| Surface | May do | Must not do |
| --- | --- | --- |
| Root | Edit, integrate, accept risk, invoke authorized side effects, complete | Bypass freshness, evidence, or reconciliation gates |
| Native delegated role | Research, review, test analysis, refutation | Edit, deploy, mutate Git/provider state, accept risk |
| External critic | Return advisory analysis of an authorized sanitized dossier | Receive secrets/private source or perform side effects |
| `sbw` | Validate and record deterministic state | Execute generated shell commands or invent authority |
| Graph View | Add structural failure diagnostics | Authorize, schedule, or relax policy |
| Workspace recipe | Read declared paths and write bounded staged artifacts | Network, shell, workers, source mutation, evidence acceptance |

Review profiles are descriptive provenance bindings, not permissions. The
legacy `review-contract-v1` profile does not imply kernel guarantees, while the
`review-kernel-v2-pilot` profile is restricted to `self-improve-ops` and remains
shadow-only; neither profile can issue a side-effect token.

If private history or sensitive operational material is the only proposed
evidence and cannot be sanitized, reject the proposal without harvesting or
transmitting that source. Persist only a redacted `REJECTED_WITH_EVIDENCE`
rationale.

## Local state

- Private state directories use mode `0700`.
- Private state files use mode `0600`.
- General receipts store digests and bounded metadata, not raw prompts,
  credentials, or conversation history. Reconciled side-effect action records
  retain structured provider receipts privately so their terminal state can be
  independently verified; those receipts are never included in external
  handoffs.
- Unknown remote outcomes require a read-only provider query and
  reconciliation; they are never blindly retried.
- Failed governed `pr.create` attempts keep their reservation until a paginated
  GitHub API query over all PR pages proves that no matching head/base PR
  exists; malformed or non-empty provider results remain fail-closed.
- A consumed owned-resource creation with outcome `unknown` keeps its
  reservation and cannot be retried blindly. An operator may reconcile that
  same attempt as `success` only after a fresh provider-side proof is bound to
  the consumed action's native marker, actor, source, and provider object; it
  may reconcile as `failure` only after a fresh pinned-provider absence proof
  for the exact resource. An unpinned or local absence snapshot cannot release
  the reservation. Provider presence, malformed results, or identity drift
  remain fail-closed, and expiry reaping never releases an unknown reservation
  automatically.
- Provider-execution reservations are idempotent only for the same run,
  action attempt, token, execution identity, and recorded outcome. A consumed
  owned-resource attempt may make one controlled transition from an `unknown`
  provider reservation to its verified terminal provider receipt; a superseded
  identity, second execution identity, outcome mismatch, legacy-format record,
  or another action attempt remains rejected. This lets a verified receipt
  resume after a crash between reservation and action-record persistence
  without permitting replay.
- `actions.dispatch` is available only through the fixed-argv GitHub CLI
  adapter. The token binds the tracked workflow file, exact ref, normalized
  inputs, repository, target revision, and pinned `gh` executable; execution
  snapshots pre-existing runs and observes exactly one new completed run with
  the requested revision. Ambiguous, missing, or indeterminate provider state
  remains unreconciled and cannot be released as a successful dispatch.
- GitHub provider probes are bound to the absolute executable path and content
  digest recorded when the action token is issued. A PATH, executable, or
  provider-authorization drift fails closed before the provider call; governed
  GitHub invocations never fall back to an ambient bare `gh` command.
- A non-zero `pr.create` wrapper exit after preflight is `sent-or-indeterminate`,
  not authoritative failure. A recorded preflight failure marked `not-sent` may
  release the `pull/new` reservation directly; a sent-or-indeterminate outcome
  remains unknown until a pinned provider query proves exact absence or
  canonical ownership. Verified absence may then reconcile the same attempt as
  failure and release the reservation.
- Creation reservation, consumption, release, and expiry reaping are
  serialized by a per-resource lease and namespaced by provider repository,
  action, and resource. An expired lease cannot be reclaimed while another
  consumer is finalizing the same creation attempt; legacy unscoped
  reservations remain fail-closed.
- Contract `deferredActions` are rejected by the core issue, consume, execute,
  reconcile, completion, and cleanup paths; an empty template action-stage map
  is not the security boundary.
- Self-improve source bindings require a clean index, tracked worktree,
  untracked surface, and ignored surface. The baseline is resolved to an exact
  commit and the candidate must already be the committed HEAD; modified
  tracked plugin files also block immutable cache publication. Authoritative
  capture uses the pinned `/usr/bin/git` with a fixed minimal environment and
  records raw local origin fetch/push URLs without URL rewrites. The same pinned
  reader is used for review, refinement, recipe, self-improve, and immutable
  publication authority. Governed push and remote-sync paths reject ambient Git
  routing variables and recheck the complete source/remote binding at issue,
  consume, execution, and provider-reconciliation time.
- Plugin-cache ready finalization and failure cleanup share the same versioned
  publication lock, so marker transitions cannot race target removal. Cleanup
  requires the exact pending marker `runId` and action `attemptId`; a foreign
  replacement marker and its target are never removed by the failed attempt.
- Reclaiming a stale publication lock does not transfer pending-marker
  ownership. Before staging a missing target, the publisher requires any
  existing pending marker to match the complete source binding, `runId`, and
  `attemptId`; a foreign marker remains untouched and publication fails closed.
  Lock owners bind an OS-observable process-start digest. A proven stale path
  is atomically renamed to a same-version quarantine and its inode/content
  identity is rechecked before deletion; a pathname replacement stays
  quarantined and blocks later publishers.
- Evaluator migration pins both the immutable v2.2 file digest and canonical
  suite digest. The target must preserve every inherited class identity,
  semantics, and existing path mapping, plus all 18 inherited cases exactly;
  missing, weakened, remapped, or reclassified coverage fails before replay.
  New coverage may add paths or use distinct class or case identifiers.
  Intentional inherited-coverage changes require a separately versioned, digest-bound,
  independently reviewed compatibility policy.
- A delegated self-improve delivery must use `pr-to-dev --self-improve-run`
  and a typed `self-improve-delivery-handoff` receipt. That receipt binds the
  source run, baseline/HEAD/source/plugin digests, request manifest, accepted
  comparison, candidate snapshot, and every purpose-required distinct host
  witness (seven ordinary or eight for evaluator migration). Every delegated
  delivery action gate requires it; an empty or generic `pr-to-dev`
  gate cannot bypass the handoff.
- Typed handoff evidence declares `policyDigest` and `evaluatorAuthorization`
  as nullable required fields. Ordinary and evaluator-migration handoffs carry
  an explicit `null` policy digest, while policy-bound remediation handoffs
  carry a SHA-256 digest. Standing-consent replays carry their authorization;
  the explicit per-run administrator fallback carries `null`. The specialized
  handoff validator still enforces each purpose-specific value and exact keys.
- Governed `pr.create` actions bind the provider receipt to the exact candidate
  source commit observed when the action token is issued; a PR from another
  source head cannot be reconciled or registered as run-owned.
- Successful governed pull-request creation is canonicalized from `pull/new` to
  the verified `pull/<number>` resource before its creation reservation is
  released. The registered PR remains run-owned, and a verified merged PR is a
  terminal cleanup receipt for that owned resource.
- The `pr-to-dev` merge gate accepts only that run-owned canonical PR and its
  immutable successful `pr.create` receipt; matching head/check evidence alone
  cannot authorize merging an unrelated pull request.

## External model transport

Antigravity CLI (`agy`) is permitted only after explicit external-egress
authorization and only for sanitized, non-confidential material within the
configured byte limit. Command-line argument transport is treated as exposed
metadata.

The roster cache proves only a specific CLI/model pair and reasoning-effort
profile for at most 24 hours. Expiry, refresh, roster changes, executable path
changes, or binary digest changes invalidate it.

## Workspace recipe trust

A recipe cloned from Git is untrusted. Execution requires explicit promotion
of its exact digest in the current workspace. Trust is also bound to the plugin
bundle and Node major, so content or runtime drift fails closed.

Node 24 Permission Model reduces accidental access but is not an OS sandbox for
malicious code. Unreviewed or model-generated recipes must not be executed.

Dry-run still executes already trusted code, but discards staged artifacts.
Normal execution publishes only declared, verified artifacts. A tracked-source
promotion needs an independent `artifact.promote` action.

## Host-signed self-improvement

Critical self-improvement uses a root-owned public trust root and a private
Ed25519 signing key outside the repository. Check host readiness with:

```bash
node plugins/better-workflows/scripts/sbw.mjs self-improve host status
```

Initial provisioning uses the existing root-owned Swift signer through fixed
system binaries. Real replay upgrade compiles the exact native sources with
fixed `/usr/bin/clang`, rejects non-Mach-O artifacts, and uses a digest-bound,
root-owned Node runtime plus a native launcher that proves empty supplementary
groups before applying the requested non-root identity; do not sudo the
maintainer's `process.execPath` directly. The administrator also approves one
canonical native Mach-O Codex executable and its SHA-256 in the root-owned
`/etc/better-workflows/codex-binary-allowlist.json` (`0644`); JS wrappers,
arbitrary executables, changed digests, and non-Mach-O files fail closed. The
generated batch command clears the environment, verifies the existing runtime
target's owner/mode and digest, and executes only that already-installed runtime.
The installed signer also authenticates the canonical parent chain for the
runtime root, signer, launcher, probe, execution root, attestation root, and
execution-bundle root; every parent must be administrator-owned and free of
group/world write bits before a privileged read or write. A root-owned leaf in
a writable or replaceable parent is not accepted.
The host signs the confirmed request digest, exact committed HEAD/source binding,
allowlist digest, binary, and run-as identity into the attestation, receipt,
envelope, and ledger.
Before a signer readiness receipt can be issued, the host binds the evaluator to
a root-owned minimal `gpt-5.6-terra` model catalog with `comp_hash=3000`, no
shell, no search, no MCP/skills, no collaboration, and no dynamic tool mode. A
nonce-bound loopback Responses gate admits exactly one Codex client request with
the expected bootstrap shape, root challenge, exact inference input, and
root-bound output schema. It discards the client bootstrap body and constructs
the forwarded body from root inputs: one user inference item, no instructions,
an own top-level `tools: []`, `tool_choice: none`, and fixed reasoning/stream
controls. The proof binds the canonical field-set policy, captured-body digest,
and distinct forwarded-body digest; the provider verifier independently checks
those bindings. The gate applies a total deadline and destroys any residual
upstream stream when the evaluator closes its downstream response. Every later
evaluator execution uses the same binary, catalog digest, and hardened argv; its JSONL transcript is
digest-bound into the ledger, receipt, and envelope and fails closed on any tool
or unknown event.
This makes transcript checking a second boundary rather than the first point at
which tool availability is discovered.

Literal prompt-boundary tokens inside allowed source material are encoded as
canonical JSON Unicode escapes. The signed original file digest remains
authoritative, and a transformation manifest records every display-only escape,
so delimiter-bearing source remains evaluable without creating a second data
boundary.

To keep long-running self-improvement from pausing at every batch, a maintainer
may install one bounded standing evaluator consent after host readiness is
current:

```bash
node plugins/better-workflows/scripts/sbw.mjs self-improve consent status
node plugins/better-workflows/scripts/sbw.mjs self-improve consent prepare
```

`prepare` returns a digest-bound administrator command. Running that command
once installs a root-signed, revocable grant and a `visudo`-validated rule that
permits only the digest-pinned root runtime to invoke
`execute-consented-batch` for one safe request directory. The grant is limited
to this repository, the maintainer identity, `gpt-5.6-terra`, the four declared
self-improve purposes, seven or eight read-only/tool-free sanitized requests,
and the checked-in policy digest. It explicitly denies commit, cache, push, PR,
merge, deploy, and cleanup authority. Matching batches use `/usr/bin/sudo -n`;
any scope, digest, owner/mode, path, prompt, model, count, revocation, or policy
mismatch fails closed without silently opening a password prompt. Use
`self-improve consent revoke` to prepare the exact revocation command. The
per-run administrator command remains available only when the standing grant is
absent or explicitly revoked.

Credential-bearing Git pushes run from an ephemeral bare Git directory that
can read only the explicitly selected source object database. They inherit no
ambient `GIT_*`, proxy, TLS, helper, global, system, repository-local, HOME, or
XDG configuration; the canonical HTTPS destination, credential store, protocol
allowlist, redirect policy, hooks policy, and SSL verification are fixed by the
governed argv and a minimal environment shared by dry-run and real push.

## Bounded autopilot

Evaluator standing consent and delivery authority are separate capabilities. A
task may explicitly select the immutable `bounded-autopilot-v1` profile once:

```bash
node plugins/better-workflows/scripts/sbw.mjs run \
  --template pr-to-dev --mode critical --goal "<goal>" --scope . \
  --autonomy-profile bounded-autopilot-v1
node plugins/better-workflows/scripts/sbw.mjs autonomy preview <run-id>
node plugins/better-workflows/scripts/sbw.mjs autonomy preflight <run-id>
```

The profile is bound to the installed bundle digest, exact source binding,
repository, path scope, expiry, diff limits, and run ledger. It may automate
bounded local work, atomic commit, immutable cache publication, a push to
`codex/*`, and one PR whose base is `dev`. It never authorizes protected merge,
deploy, direct `dev`/`main` push, branch or worktree cleanup, host signer
bootstrap, or host signer upgrade. The evaluator standing grant cannot be used
to derive any of those delivery permissions.

Preflight is non-interactive. If host bootstrap, credentials, provider state,
or another mandatory capability is unavailable, the run records
`status=blocked`, a machine-readable `blockedReason`, the required authority,
and the exact resume stage. `sbw resume <run-id>` rechecks the same source,
profile, and authority digests and resumes only incomplete work; it never
replays completed evaluator or provider attempts. `autonomy revoke` blocks the
run and cannot be silently undone.

The root signer is validated through a signed, versioned host-bundle protocol;
ordinary changes to repository `host-trust.mjs` do not require an administrator
password. Only a host-bundle upgrade requires a separately governed bootstrap.
Passwords are never stored or piped to sudo, and no blanket `NOPASSWD` rule is
accepted.

Before generating requests, the candidate must already be the exact committed
HEAD that will be reviewed and delivered. A dirty candidate is handed to
`pr-to-dev` for its commit wave, followed by a fresh source-bound self-improve
run; committing or changing the plugin bundle after request generation
invalidates all signed witnesses. Then generate the purpose-specific batch
outside the repository: seven requests for ordinary or policy-bound replay,
or eight requests for evaluator migration:

```bash
node plugins/better-workflows/scripts/sbw.mjs \
  self-improve attestation request \
  --run <run-id> \
  --baseline <sha> \
  --candidate-root . \
  --model <model> \
  --output <new-outside-repo-directory>
```

Training and holdout witnesses cannot be reused for a different run or
candidate digest. Pass the returned manifest path and exact digest to every
`self-improve evaluate` call; `sbw` also requires the root-owned completed batch
journal and compares every request digest/run-as tuple to the manifest. The installed administrator signer executes each attested
Codex binary exactly once, captures the prompt, parsed response, exit status,
timestamps, and a root-owned one-shot ledger, then signs the result receipt.
`sbw` consumes the persisted witness and never reruns Codex during resume or
delivery revalidation. A tie, mismatch, timeout, regression, or unknown result
is not authority to commit, publish, push, or merge. The self-improve contract
defers commit, cache publication, push, merge, and cleanup actions to the
governed `pr-to-dev` and immutable-cache workflows.

Standing-consent manifests use schemaVersion 5 and propagate the same bounded
authorization through every request, signed execution, root batch journal,
training/holdout evidence, and typed delivery handoff. This is provenance for
read-only evaluator execution, never authority for delivery side effects.

Before sampling by file count or bytes, the sanitizer validates every changed
path against a fixed plugin and repository-public-document allowlist. Paths
outside it fail closed even when they would sort beyond the sampling limit.
Only sampled valid UTF-8, non-secret-shaped content is sent to Codex.
CI workflow files remain outside the standing-consent sanitizer and require
explicit review/validation when changed. Generated HTML/Markdown pages remain
explicit allowlist entries; generated `.webp` assets are excluded from
standing-consent evaluation and also require explicit review/validation. The
complete changed-path manifest still binds every such file to the signed
request.

## Threat-model boundary

Better Workflows assumes trusted local repositories and local tools. It does
not claim to isolate hostile repository code, compromised executables,
privileged malware, or an untrusted host administrator.
