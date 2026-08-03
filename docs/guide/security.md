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
  the consumed action's native marker, actor, source, and provider object;
  an absence snapshot cannot convert `unknown` to `failure`, because a
  matching provider object may appear after the snapshot and before local
  reservation finalization. The reservation remains held until an authoritative
  terminal provider result is available; expiry reaping never releases an
  unknown reservation automatically.
- Provider-execution reservations are idempotent only for the same run,
  action attempt, token, execution identity, and recorded outcome. A consumed
  owned-resource attempt may make one controlled transition from an `unknown`
  provider reservation to its verified terminal provider receipt; a superseded
  identity, second execution identity, outcome mismatch, legacy-format record,
  or another action attempt remains rejected. This lets a verified receipt
  resume after a crash between reservation and action-record persistence
  without permitting replay.
- `actions.dispatch` is intentionally rejected by the core action-token
  lifecycle until a fixed-argv provider adapter can correlate one requested
  workflow dispatch to exactly one provider-assigned run. It must not be
  treated as a generic creation action with a pre-known run ID.
- GitHub provider probes are bound to the absolute executable path and content
  digest recorded when the action token is issued. A PATH, executable, or
  provider-authorization drift fails closed before the provider call; governed
  GitHub invocations never fall back to an ambient bare `gh` command.
- A non-zero `pr.create` wrapper exit after preflight is `sent-or-indeterminate`,
  not authoritative failure. Only a recorded preflight failure marked
  `not-sent` may release the `pull/new` reservation; all other outcomes remain
  unknown until a provider query proves absence or canonical ownership.
- Creation reservation, consumption, release, and expiry reaping are
  serialized by a per-resource lease. An expired lease cannot be reclaimed
  while another consumer is finalizing the same creation attempt.
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

After freezing a candidate, generate seven run-specific requests outside the
repository:

```bash
node plugins/better-workflows/scripts/sbw.mjs \
  self-improve attestation request \
  --run <run-id> \
  --baseline <sha> \
  --candidate-root . \
  --model <model> \
  --output <new-outside-repo-directory>
```

Training and holdout attestations cannot be reused for a different run or
candidate digest. A tie, mismatch, timeout, regression, or unknown result is not
authority to commit, publish, push, or merge.

Before sampling by file count or bytes, the sanitizer validates every changed
path against a fixed plugin and repository-public-document allowlist. Paths
outside it fail closed even when they would sort beyond the sampling limit.
Only sampled valid UTF-8, non-secret-shaped content is sent to Codex.

## Threat-model boundary

Better Workflows assumes trusted local repositories and local tools. It does
not claim to isolate hostile repository code, compromised executables,
privileged malware, or an untrusted host administrator.
