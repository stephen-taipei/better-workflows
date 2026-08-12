---
name: self-improve
description: Goal-first 以近期工作證據改善 Better Workflows 本身，保持 selector、template、catalog、tests、docs、version、cache 與 remote delivery 同步。選擇 $better-workflows:self-improve 時使用。
---

# Self improve

Read `../better-workflows/SKILL.md` completely and follow it, including the
Goal-first entry contract.

Use template `self-improve-ops` with minimum mode `critical`. This is a thin
orchestration contract for improving Better Workflows itself; it does not
replace `research-deliberation`, `monorepo-refactor`, `pr-to-dev`, capability
routing, or the immutable cache publisher.

The control-plane v2 pilot adds typed evidence receipts, an append-only ledger,
code-review convergence, and an atomic deliberation bundle to this template.
The optional design-packet and refinement pilots are enabled only here and in
`monorepo-refactor`; a refinement failure discards its bounded diff and never
invalidates an already accepted functional result.

## Build a bounded retrospective

1. Read the automation memory first when the invocation provides an automation
   ID. Gather only recent, relevant workspace memories, interaction summaries,
   current repository evidence, and prior run outcomes.
2. Keep raw private history, source, secrets, credentials, and regulated data
   out of external model prompts. Use `research-deliberation` first when the
   evidence is uncertain, contradictory, or requests a new workflow boundary.
3. Classify every candidate by recurrence, impact, current coverage, confidence,
   implementation cost, and counterargument. Record one of:
   `IMPLEMENT`, `NO_CHANGE`, `BLOCKED`, or `REJECTED_WITH_EVIDENCE`.
4. Treat `NO_CHANGE` as a valid successful outcome. Never create churn merely
   to justify a self-improvement run.

## Freeze, stage, and validate candidates

Before candidate work, freeze the current checked-in sanitized Evaluation
suite at `fixtures/self-improve-ops-evals-v2.3.json` in an immutable baseline
commit. Earlier v1, v2, v2.1, and v2.2 suites remain checked in and immutable for
host-attested evaluator migrations. Never edit a known corpus in place, or
derive cases from session history, transcripts, schedules, or any unsanitized
source. Every suite keeps isolated `train` and `holdout` splits.

Iterate only with the training split. Stage the entire candidate root and bind
it to the exact baseline revision. Then run the holdout split exactly three
times for the baseline and three times for the candidate. For ordinary and
purposes, every hard-safety assertion must pass in every baseline and candidate
replay. Evaluator migration instead requires every candidate hard-safety
assertion and every baseline/candidate universal invariant in all three
holdout replays. A source baseline non-invariant hard-safety gap is admissible
only when every candidate replay repairs it and the per-case median and noise
gates prove non-regression. Safety-remediation-v1 and quality-remediation-v1
have narrower, explicit policy-bound target rules below; do not apply the
ordinary global hard-safety rule to those purposes.
Evaluation v2.3 always includes the universal safety class and selects improvement classes from the complete changed-path
manifest. Exact allowlisted release-version-only substitutions remain in the
signed candidate manifest but do not activate unrelated improvement classes;
every other byte change remains semantic. The applicable improvement-class median must strictly exceed the
baseline median; no case may regress; and no candidate replay may fall below a
baseline case median. A fully saturated applicable improvement suite is
rejected. Ties, instability, malformed output, missing evidence, or no
measurable gain are `NO_CHANGE` or `REJECTED_WITH_EVIDENCE`, never ordinary
adoption.

Evaluation v2.3 retains the v2.2 documentation, deliberation, sanitizer,
evaluation-engineering, evidence-integrity, execution-ledger, review-convergence,
and direct-work coverage, and adds an isolated plugin-cache-publication class
for marker ownership and rollback races. The evaluator-migration source
allowlist remains historical and immutable; v2.2 is the default source for the
v2.3 migration. Admission pins both the v2.2 file digest and canonical suite
digest, requires every inherited class identity and semantics plus every
existing path mapping to remain unchanged, and requires every inherited case to
remain byte-for-byte identical. New coverage may add paths or use new class or
case identifiers, but missing, weakened, remapped, or reclassified inherited
coverage fails before replay. Evaluator dispositions classify the supplied snapshot rather
than recommend another edit: baseline and candidate use identical semantics,
and every satisfied assertion must be reported for every disposition. The
evaluator-migration source replay and target calibration include every case in
their immutable versioned suites, so inherited governed surfaces remain covered
and new classes are calibrated. Ordinary evaluation continues to select only
applicable improvement classes from changed paths.

An evaluator migration is a separate governance path. It freezes the previous
versioned corpus at the run-start baseline, binds a distinct target corpus
digest into eight signed executions (independent train baseline and candidate,
plus three baseline and three candidate holdouts), executes the full target
split in each replay, and requires deterministic class isolation,
balanced-sampling coverage, and target-only headroom calibration.
Every target-only assertion must name snapshot-verifiable implementation or
regression-test evidence. Conceptual governance wording alone cannot satisfy a
target-only assertion, and a missing exact symbol, test title, case id, or
heading in the full-file evidence index is negative evidence rather than a
license to infer the behavior exists.
Changing an inherited case requires a separately versioned, digest-bound,
independently reviewed compatibility policy; an ordinary target corpus cannot
authorize that change itself.
Source-suite replays may tie only on this migration path. Every candidate
hard-safety assertion and every universal invariant must pass; any baseline
non-invariant hard-safety miss must be repaired by all candidate replays; and
every case median plus every individual candidate replay must be non-regressing.
After a migration is merged, all ordinary candidates use the new canonical
corpus and the strict improvement rule above.

Safety remediation is a separate, versioned purpose and is never selected by
changing `--purpose` after an ordinary run has failed. Create the run with
`--evaluation-purpose safety-remediation-v1`; it loads the fixed policy at
`config/self-improve-safety-remediation-v1.json`, binds its digest into the
suite digest, request manifest, every signed execution, evidence, and delivery
handoff, and uses the immutable v2.2 corpus digest declared by that policy.
The v2.2 corpus itself remains unchanged. The policy retains the universal
invariant holdout and exactly three remediation targets: evidence cross-run
substitution, ledger PASS-text transitions, and fifth-round review blocking.
The three candidate holdout replays must pass every applicable hard-safety
assertion; the three baseline replays must pass the invariant class and must
reproduce each target defect in at least two replays. Every target defect must
be repaired by the candidate, with no target-case regression, no noisy
candidate replay, and strict target median improvement. Missing, malformed,
drifted, or reused policy/request/witness bindings fail closed. This policy is
an evaluator migration of semantics only; it does not change ordinary or
evaluator-migration comparison behavior.

Quality remediation is a separate, versioned purpose for recurring completeness
gaps, not a claim that the v2.2 hard-safety evaluator is defective. Create the
run with `--evaluation-purpose quality-remediation-v1`; it loads
`config/self-improve-quality-remediation-v1.json` and binds that policy digest
through the suite digest, request manifest, signed executions, evidence, and
delivery handoff. It keeps the same immutable v2.2 corpus and universal hard-
safety invariant, but targets the three existing non-hard completion assertions:
typed evidence admission, exhaustion blocking, and final broad review. Each
target must fail in at least two of three baseline replays and pass in all three
candidate replays; candidate hard-safety, invariant hard-safety, no regression,
no candidate noise, and strict target improvement remain mandatory. It never
changes `safety-remediation-v1`, the v2.2 fixture, or ordinary comparison
semantics. A quality gap that is not reproduced is rejected as
`baseline-quality-gap-not-reproduced`.

Real replays require authority and use only a read-only, ephemeral Codex
invocation. For this fixed Better Workflows repository, a one-time,
administrator-installed, root-signed standing consent may satisfy the evaluator
execution authority without interrupting every long-running run. It is exact to
`gpt-5.6-terra`, the four declared self-improve purposes, seven or eight
purpose-specific requests, the maintainer uid/gid/home, the checked-in sanitizer
policy digest, and one fixed request root. It explicitly denies commit, cache
publication, push, PR, merge, deploy, and cleanup authority. A mismatched,
tampered, revoked, expired, or stale grant fails closed and falls back to the
existing per-run administrator path; prose in a prompt is never treated as a
self-issued grant. Replays also require a host-signed attestation for the exact
Codex binary and requested model. The trust root is fixed at the canonical
path: on macOS `/private/etc/better-workflows/codex-trust-root.json` (the `/etc`
spelling is a symlink), and on other platforms
`/etc/better-workflows/codex-trust-root.json`. The trust root and every parent directory
must be administrator-owned and non-writable by the invoking user. `PATH`, a
self-reported model, a CLI-selected trust root, or a binary digest supplied
without a verifiable host signature is not trusted. A fixture backend exists
only for deterministic tests and cannot authorize delivery.

Before applying file-count or byte sampling, the sanitizer validates every
changed path against the fixed plugin and repository-public-document allowlist.
A path outside that allowlist rejects the replay even when it would sort beyond
the sampling limit. The prompt includes a complete path, state, size, and digest
manifest, then allocates bounded content samples across runtime, tests, config,
skills, templates, fixtures, metadata, and docs. Only valid UTF-8,
non-secret-shaped content from approved paths is sent to Codex.

Each real replay uses a distinct host-owned execution witness. Its unique
execution ID, run ID, corpus digest, baseline revision, candidate digest, exact
committed HEAD, source-binding digest, role, attempt number, exact prompt digest,
purpose, policy digest when applicable, native Mach-O Codex digest, and
administrator-owned allowlist digest are submitted
in a digest-confirmed request. The installed administrator signer
snapshots that exact binary into a root-owned `0755` execution-root file, creates
and signs the pre-execution binding, then invokes a root-owned native launcher.
The launcher clears supplementary groups before applying the requesting
non-root uid/gid and fixed `PATH`, `HOME`, and `CODEX_HOME` values. The signed
attestation, result receipt, envelope, and ledger all bind the confirmed
request digest and exact run-as identity; candidate snapshots also bind
normalized file modes.
After the child exits, the host captures the parsed response, exit status, and
timestamps, writes a root-owned execution ledger, and signs the result receipt.
Training takes one witness; holdout takes six (candidate 1–3, then baseline
1–3). `sbw` consumes the persisted witness and never reruns Codex during resume
or delivery revalidation. Replayed, duplicated, response-mutated,
ledger-mutated, or executable-drifted witnesses fail closed.

Ordinary clones and workspace recipes do not require this host trust root. A
maintainer who will run real self-improvement delivery replays must first use
`sbw self-improve host status`. If the fixed trust root or private key is absent,
stop for the host's separately approved administrator bootstrap; this repository
does not publish or execute the untracked legacy Swift bootstrap artifact. Never use an unpinned maintainer Node
binary or `plutil` to validate this JSON,
and never overwrite or implicitly rotate an existing host key. If status reports
`ready: false` because only the legacy signer is installed, prepare the pinned
source digest, a compiled native launcher/probe digest, and a digest-bound
root-owned Node runtime staging command; never sudo the maintainer's
`process.execPath` directly. Compile the exact native sources with the fixed
`/usr/bin/clang`; upgrade rejects source bytes and non-Mach-O artifacts. Run the
digest-confirmed `host-trust.mjs upgrade` operation through that fixed
`/bin/sh` staging wrapper with `env -i`, root-owner/mode checks, and an
immutable digest-bound runtime target. The upgrade preserves
the trust root/key, atomically replaces the signer, retains the previous signer
as a root-owned backup, and runs a disposable signed readiness witness with the
native launcher. A failed upgrade is quarantined and rolled back with exact
prior artifact digests proven, without rotating keys.

The installed signer authenticates the canonical parent chain for the fixed
runtime root, signer, native launcher, readiness probe, execution root,
attestation root, and request-bundle root before privileged reads or writes.
Every parent must be administrator-owned and lack group/world write bits; a
root-owned leaf under a writable or replaceable parent is rejected.

After host readiness is current, install the bounded standing evaluator consent
once. `prepare` writes a user-owned `0600` digest-bound request below
`/private/tmp/better-workflows-standing-consent-<uid>` and returns the exact
administrator command. Run only that returned command after confirming its
digest. The root signer installs a signed grant, the checked-in sanitizer policy,
and a `visudo`-validated `NOPASSWD:NOSETENV` rule restricted by the root-owned
runtime SHA-256 and an anchored `execute-consented-batch` argv regex. It never
allows a shell, arbitrary script, alternate runtime, or wildcard command.

```sh
sbw self-improve consent status
sbw self-improve consent prepare
# execute only the returned administratorCommand once
```

When the grant matches, attestation output must be one safe direct child of the
fixed request root and the returned batch command uses `/usr/bin/sudo -n`.
Treat `standingConsent.matched: true` as the already-installed authority for
that exact evaluator batch: execute the returned command directly, do not ask
the user to repeat a run-specific authorization sentence, and do not pause a
long-running task for another evaluator confirmation. If `sudo -n` or any
root-side validation fails, record the mismatch and fail closed; never weaken
the rule or silently switch to a password prompt. A new administrator approval
is required only to install, replace, or revoke the standing grant.
Before execution, the root signer independently revalidates the signed grant,
policy and command digests, owner/mode and canonical paths, exact source-bound
manifest, request count, model, purpose, prompt schema, complete changed-file
manifest, UTF-8, secret rejection, and sampling budgets. The schemaVersion 4
authorization is copied into every request, execution, root batch journal,
training/holdout record, and typed delivery handoff. It proves evaluator
provenance only; delivery still needs independent action authority. Revoke at
any time with `sbw self-improve consent revoke` and execute its returned
administrator command.

Delivery may separately opt into the immutable `bounded-autopilot-v1` profile
when creating its `pr-to-dev` run. This profile is run-scoped and can automate
only bounded commits, immutable cache publication, `codex/*` push, and one PR
to `dev`; it never authorizes merge, deploy, protected-branch push, or cleanup.
Run `sbw autonomy preflight <run-id>` before issuing any delivery token. A
missing host bundle, credential, provider capability, or expired binding creates
a resumable blocked state rather than an interactive password prompt.

Before generating replay requests, the candidate checkout must be the exact
committed HEAD that will be reviewed and delivered. If candidate work is still
dirty, hand it to `pr-to-dev` for the commit wave first, then start a new
source-bound self-improve run from that commit. Never commit, rebind, or change
the plugin bundle between request generation, administrator execution, replay
evaluation, and delivery revalidation; doing so invalidates the signed witnesses.

Create that source-bound run with the immutable baseline explicitly separated
from the committed candidate HEAD:

```sh
sbw run --template self-improve-ops --mode critical \
  --goal "<bounded improvement goal>" --scope . \
  --baseline <immutable-baseline-sha> \
  [--evaluation-purpose ordinary|evaluator-migration|safety-remediation-v1|quality-remediation-v1]
```

`--baseline` is resolved to a commit before the run is written. The run rejects
any tracked, untracked, or ignored worktree drift; a candidate that is not yet
committed cannot be evaluated or delivered by this workflow.

After the candidate is frozen, use `sbw self-improve attestation request` with
the exact run, baseline, candidate root, model, and a new directory outside the
repository. It produces seven prompt-bound execution requests, their manifest
digest, the already-installed fixed runtime digest, and an exact batch
`executeCommand`. That command verifies the pre-installed root-owned runtime
target and invokes the installed, capability-checked signer; it never stages or
executes a maintainer-selected runtime, and the writable candidate checkout is
never executed with administrator privileges.

```sh
sbw self-improve evaluate \
  --run <run-id> \
  --cases plugins/better-workflows/fixtures/self-improve-ops-evals-v2.3.json \
  --baseline <immutable-baseline> --candidate-root . \
  --backend codex --model <attested-model> --allow-codex --sanitized \
  --request-manifest <outside-repo>/attestation-requests.json \
  --request-manifest-digest <confirmed-manifest-sha256> \
  --trusted-codex-execution /host/executions/<train-result>.json --split train
```

The exact command returned as `executeCommand` executes the seven requests once.
With matching standing consent it is noninteractive and narrowly gated; without
one it remains the explicit administrator-only fallback. It returns root-owned witness paths under
`/private/var/db/better-workflows/executions`; pass the one training witness,
then the six holdout witnesses to `sbw`, together with the same manifest path
and digest. `sbw` requires the root-owned completed batch journal and verifies
every request file's digest, execution identity, run-as tuple, binary, model,
suite, baseline, and candidate against that manifest. The receipt and ledger remain outside
the evaluated repository; `sbw` verifies their signatures, confirmed
request/run-as identity, prompt/response digests, binary, model, execution,
file modes, exit status, timestamps, and immutable host ledger before recording
replay evidence. The host attestation is signed before
launch as an immutable execution binding; the result receipt is signed only
after successful completion.

For a versioned evaluator migration, replace the ordinary cases path with the
immutable previous corpus and add:

```sh
--purpose evaluator-migration \
--next-cases plugins/better-workflows/fixtures/self-improve-ops-evals-v2.3.json
```

For a policy-bound safety remediation run, fix the purpose at run creation and
use the v2.2 cases path without `--next-cases`:

```sh
sbw run --template self-improve-ops --mode critical \
  --goal "Repair reproduced Better Workflows safety defects" --scope . \
  --baseline <immutable-baseline-sha> \
  --evaluation-purpose safety-remediation-v1
```

Pass `--purpose safety-remediation-v1` to both evaluation commands only when
the run was created with that immutable purpose. Without standing consent, the
attestation manifest uses schemaVersion 3 for this purpose and includes the
policy identity and digest; schemaVersion 2 remains the ordinary/migration
fallback contract. Matching standing consent uses schemaVersion 4 for every
purpose and additionally binds its authorization.

For a policy-bound quality remediation run, use the same v2.2 cases path and
pass `--purpose quality-remediation-v1` to both evaluation commands only when
the run was created with that immutable purpose. Its explicit fallback uses a
schemaVersion 3 manifest, while matching standing consent uses schemaVersion 4;
both contain the independent quality policy identity and digest. It cannot be
switched from an ordinary or safety-remediation run, and a prior safety run's
witnesses cannot be pooled or replayed.

Use `--split holdout` only after training is frozen. This selector never
automatically adopts a candidate, commits, publishes a cache, pushes, merges,
deploys, or performs cleanup. Its commit, cache publication, push, merge, and
cleanup actions are deferred to the governed `pr-to-dev` and immutable-cache
workflows.

After the trusted holdout is accepted and the synchronized patch is frozen,
delivery must be explicitly bound to that source run. Create the delegated
delivery run and record the typed handoff before issuing any delivery action:

```sh
sbw run --template pr-to-dev --mode critical \
  --goal "Deliver the accepted Better Workflows change" --scope . \
  --self-improve-run <self-improve-run-id>
sbw self-improve handoff <pr-to-dev-run-id> \
  --source-run <self-improve-run-id>
```

The handoff binds the exact source baseline and HEAD, clean source binding,
plugin bundle, request manifest, evaluator authorization (or explicit fallback), accepted comparison, candidate snapshot, and
all purpose-required distinct host witnesses (seven ordinary or eight for an
evaluator migration). Every delegated commit, push, PR, merge,
remote-sync, and cleanup gate requires this receipt; a generic `pr-to-dev` run
cannot be used as a substitute for the explicitly bound delivery run.
It also records the canonical Codex plugin-cache root in the source and target
run manifests and handoff. The delegated cache action must consume its token
under that same `CODEX_HOME`; an alternate cache root fails before token
consumption.

## Keep the workflow thin and synchronized

For every accepted change, prove whether each surface is affected:

- selector skill and picker metadata;
- machine-readable template;
- entrypoint catalog and route preview;
- helper or repository command documentation;
- hard-coded inventory and behavior tests;
- English, Traditional Chinese, Simplified Chinese, Japanese, and Korean docs;
- package semantic version and Codex plugin build version;
- immutable plugin cache;
- explicit-path commit and authorized remote branch.

A new template that should be discoverable requires a matching selector skill
and catalog entry. Do not duplicate operational mechanics already owned by
another template or helper.

If an automation-supplied hyperlink points to a missing versioned plugin-cache
path, never recreate, overwrite, or mutate that stale path. Resolve the
currently installed bundle from the host skill catalog or a verified plugin
cache entry, record its manifest name, exact version, and resolved path, and
verify the selected template and helper capabilities before continuing. If no
current matching bundle can be proven, fail closed.

## Validate, version, publish, and deliver

Run the repository baseline before edits. After the synchronized patch, run
targeted tests, the complete plugin test/eval suite, JSON parsing, route preview,
`git diff --check`, and a temporary-root cache publication test. Classify
infrastructure failures separately from product regressions.
The cache publication is a two-phase operation: a pending marker may remain
after an interrupted publication, but a persisted, verified success receipt
must be repaired under the run lock by promoting the exact marker to `ready`.
If the action is still `spent/pending`, recovery is allowed only when the
pending marker and immutable target prove the exact source binding, run, and
attempt; it must create the governed receipt without republishing. Repair may
not rerun publication, accept a different receipt, or overwrite a drifted
target. Ready finalization and failure cleanup must share the same versioned
publication lock so marker transitions cannot race target removal. Reclaiming
a stale lock does not transfer marker ownership: before staging a missing
target, an existing pending marker must match the complete source binding, run,
and attempt or publication fails closed without changing that marker.
Completion must recheck the ready marker, source binding,
provider-receipt digest, and canonical cache root. A source run without an
explicit canonical `pluginCacheRoot` is invalid; never infer it from the
current ambient `CODEX_HOME`. Publication locks may be reclaimed only after
the recorded owner is proven absent; otherwise fail closed.

Any source change requires a new semantic/build version. Never overwrite an
existing immutable cache version. After final validation and only with explicit
authority, use the existing cache publisher, verify exact source/target digests,
and confirm the resolved new cache path/version.

Commit, cache publication, push, merge, deploy, and cleanup are delegated
independent side effects. The self-improve contract defers their action tokens;
use `pr-to-dev` and the immutable cache publisher, each with its own evidence,
authority, and reconciliation. After a push, reconcile the exact remote branch
revision. Do not merge, deploy, or clean resources unless the user separately
granted that authority.
