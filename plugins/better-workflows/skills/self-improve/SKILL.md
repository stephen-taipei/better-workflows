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
suite at `fixtures/self-improve-ops-evals-v2.2.json` in an immutable baseline
commit. Earlier v1, v2, and v2.1 suites remain checked in and immutable for
host-attested evaluator migrations. Never edit a known corpus in place, or
derive cases from session history, transcripts, schedules, or any unsanitized
source. Every suite keeps isolated `train` and `holdout` splits.

Iterate only with the training split. Stage the entire candidate root and bind
it to the exact baseline revision. Then run the holdout split exactly three
times for the baseline and three times for the candidate. Every hard safety
assertion must pass in every replay. Evaluation v2.2 always includes the universal
safety class and selects improvement classes from the complete changed-path
manifest. The applicable improvement-class median must strictly exceed the
baseline median; no case may regress; and no candidate replay may fall below a
baseline case median. A fully saturated applicable improvement suite is
rejected. Ties, instability, malformed output, missing evidence, or no
measurable gain are `NO_CHANGE` or `REJECTED_WITH_EVIDENCE`, never ordinary
adoption.

Evaluation v2.2 retains the existing documentation, deliberation, sanitizer,
and evaluation-engineering coverage, and adds isolated train/holdout classes
for evidence integrity, execution-ledger replay, review convergence, and direct
work cost. The evaluator-migration source allowlist remains historical and
immutable; v2.1 is the default source for the v2.2 migration.

An evaluator migration is a separate governance path. It freezes the previous
versioned corpus at the run-start baseline, binds a distinct target corpus
digest into all seven signed executions, and requires deterministic class
applicability, balanced-sampling coverage, and saturation-policy calibration.
Source-suite replays may tie only on this migration path, and only when every
hard-safety assertion, every case median, and every individual candidate replay
is non-regressing. After a migration is merged, all ordinary candidates use the
new canonical corpus and the strict improvement rule above.

Real replays require separate, per-run authority and use only a read-only,
ephemeral Codex invocation. They also require a host-signed attestation for the
exact Codex binary and requested model. The trust root is fixed at
`/etc/better-workflows/codex-trust-root.json`; it and every parent directory
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
execution ID, run ID, corpus digest, baseline revision, candidate digest, role,
attempt number, exact prompt digest, and administrator-confirmed binary digest
are submitted in a digest-confirmed request. The installed administrator signer
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
`sbw self-improve host status`. If the host is unprovisioned, an administrator
reviews the root-owned legacy Swift provisioner with a fixed system runtime, as
documented in the repository README. Never use an unpinned maintainer Node
binary or `plutil` to validate this JSON,
and never overwrite or implicitly rotate an existing host key. If status reports
`ready: false` because only the legacy signer is installed, prepare the pinned
source digest, a compiled native launcher/probe digest, and a digest-bound
root-owned Node runtime staging command; never sudo the maintainer's
`process.execPath` directly. Run the digest-confirmed `host-trust.mjs upgrade`
operation through that fixed `/bin/sh` staging wrapper. The upgrade preserves
the trust root/key, atomically replaces the signer, retains the previous signer
as a root-owned backup, and runs a disposable signed readiness witness with the
native launcher. A failed upgrade is quarantined and rolled back with exact
prior artifact digests proven, without rotating keys.

After the candidate is frozen, use `sbw self-improve attestation request` with
the exact run, baseline, candidate root, model, and a new directory outside the
repository. It produces seven prompt-bound execution requests, their manifest
digest, runtime digest, and an exact batch `executeCommand`. That command first
hash-checks and stages the runtime into the fixed root-owned host directory,
then invokes the installed, capability-checked signer; the writable candidate
checkout is never executed with administrator privileges.

```sh
sbw self-improve evaluate \
  --run <run-id> \
  --cases plugins/better-workflows/fixtures/self-improve-ops-evals-v2.2.json \
  --baseline <immutable-baseline> --candidate-root . \
  --backend codex --model <attested-model> --allow-codex --sanitized \
  --trusted-codex-execution /host/executions/<train-result>.json --split train
```

The exact command returned as `executeCommand` is administrator-only and
executes the seven requests once. It returns root-owned witness paths under
`/private/var/db/better-workflows/executions`; pass the one training witness,
then the six holdout witnesses to `sbw`. The receipt and ledger remain outside
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
--next-cases plugins/better-workflows/fixtures/self-improve-ops-evals-v2.2.json
```

Use `--split holdout` only after training is frozen. This selector never
automatically adopts a candidate, commits, publishes a cache, pushes, merges,
deploys, or performs cleanup.

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

Any source change requires a new semantic/build version. Never overwrite an
existing immutable cache version. After final validation and only with explicit
authority, use the existing cache publisher, verify exact source/target digests,
and confirm the resolved new cache path/version.

Commit, cache publication, push, merge, deploy, and cleanup are independent
side effects. Issue and consume a separate action token for each authorized
action. This selector authorizes none of them by itself. After a push, reconcile
the exact remote branch revision. Do not merge, deploy, or clean resources
unless the user separately granted that authority.
