---
name: better-workflows
description: Route complex Codex work through native-first, evidence-driven workflows with root-only mutation, persistent /goal checkpoints, bounded read-only subagent waves, model-pinned critics, freshness checks, and fail-closed side-effect gates. Use when the user says better workflows, dynamic workflow, verified workflow, deep review, critical review, multi-agent review, multi-model review, review then fix, review to issues, fix issues then PR/merge, monorepo refactor, cross-platform contract, localization, iOS pbxproj review, CI/release monitoring, browser QA, research deliberation, Better Workflows self improvement, or explicitly invokes $better-workflows.
---

# Better Workflows

Keep the root agent as the only authority that edits files, integrates changes, runs Git or GitHub mutations, deploys, accepts risk, or declares completion. Treat native subagent read-only behavior as an orchestration contract, not an OS sandbox.

## Canonical model terminology

The public model roster is **Codex · Claude · Gemini · GPT-OSS · Grok · Cursor · Kimi · Qwen · Kiro**. `agy` is transport metadata for Gemini-, Claude-, and GPT-OSS-branded models; it is never another model brand. Treat [`config/deliberation-roster.json`](../../config/deliberation-roster.json) as the canonical terminology source, and keep this skill, the roster reference, tests, and public documentation synchronized with it.

## Preferred user entrypoints

Prefer the native searchable picker for the current Codex surface. In Codex CLI,
the user starts with `@` and searches `better`; in the Codex App, the user starts
with `/` and searches `better` to call a command. Select a human-readable task or
review-strength entry. The picker inserts `$better-workflows:<name>`;
`$better-workflows:auto` is the recommended default. Do not require the user to
remember template, mode, or model alias names.

A selector-fixed template or minimum mode is authoritative; never lower it.
Selectors with `auto` still use the routing rules below. Natural-language
`$better-workflows` invocation remains supported.
`$monorepo-refactor` for bounded monorepo architecture refactors.
`$better-workflows:self-improve` for governed improvement of this plugin from
recent workflow evidence.

## Goal-first entry contract

Every Better Workflows selector and compatibility alias defaults to persistent
Goal mode, including `direct`:

1. Before substantial work, inspect the current Codex goal.
2. If no goal exists, create one from the user's requested outcome.
3. If the active goal describes the same outcome, continue it instead of
   creating a duplicate.
4. If an unrelated unfinished goal exists, do not replace it silently. Tell the
   user to use `/goal edit` or `/goal clear`, then stop this workflow.
5. Keep working across turns until the acceptance gates are satisfied. Mark the
   goal complete only after the workflow completion rules pass. `inconclusive`,
   stale, indeterminate, or unknown outcomes are not complete.

Goal mode controls persistence; the Better Workflows mode controls verification
depth. They are independent. `direct` therefore uses a persistent goal without
creating a Better Workflows journal.

## Converge without repeated interaction

The default interaction mode is `auto-deduplicated`. Reuse a current standing
user directive without asking again when repository, goal, recipient/provider/
model, disclosed data scope, side-effect kinds, and safety constraints are
materially unchanged. A freshness-only receipt refresh preserves its
predecessor and exact scope digest. This suppresses duplicate questions; it does
not grant authority or relax current TaskContract, evidence, action-token,
required-check, provider-reconciliation, or completion gates.

A changed repository, candidate bytes, recipient/model/provider, disclosed data
scope, or side-effect kind is a material scope change unless an existing
standing directive expressly covers it. Record one structured HOLD when that
authority is missing; do not ask the same question again on later turns. Use
strict per-request prompting only when the user explicitly requests strict
interaction mode. Never request, copy, pipe, or retain an administrator
password. Use a matching installed non-interactive grant or trigger one exact
native administrator interaction and observe it; failure remains HOLD without
another prompt.

The root agent may use the interaction-only bridge to make this deduplication
observable and reproducible:

```bash
sbw interaction preview --scope-file <material-scope.json> \
  [--standing-file <standing-directive.json>] [--strict]
```

The request fingerprint is stable across repeated prompts. A matching standing
directive may suppress the duplicate question, including a freshness-only
renewal with a predecessor link. The bridge never issues an action token or
authorizes push, merge, deploy, cleanup, signing, or release; exact evidence,
provider reconciliation, required checks, and host authority remain mandatory.
New package/instruction/reviewer/execution identities after a BLOCK are a new
authorization boundary and require fresh disclosure authority.

Review repair limits are campaign-wide. The campaign ledger lives under the Git
repository-independent host ledger root `~/.better-workflows/campaigns` and
survives new clones, runs, state roots, packages, nonces, branches, and execution
identities. The first blocked package is the baseline and only
five subsequent repair waves are allowed. `campaign.exhausted=true` is terminal
`campaign-repair-budget-exhausted`; never evade it by minting another identity.
Read [convergence-and-authorization.md](../../../../docs/guide/convergence-and-authorization.md)
before formal evaluation, native review, or any authorization refresh.

## Preflight every workspace

Before substantial work in every task, run the host-neutral read-only preflight:

~~~bash
sbw workspace preflight --intent read-only
~~~

Shared state defaults to `XDG_STATE_HOME/better-workflows` when available and
otherwise `~/.better-workflows`; `SBW_STATE_ROOT` binds an explicit location.
Do not infer the core state root from `CODEX_HOME`. A v3 Codex state remains
usable only when its exact `<CODEX_HOME>/sbw` path is explicitly supplied as
`SBW_STATE_ROOT`.

This distinguishes a non-Git directory, read-only use of a repository, an
existing task-owned worktree, and an ownership conflict without creating Git
resources. If the task may modify a repository, rerun with `--intent modify`
and bind the exact existing local integration target before any edit. A dirty
source checkout stops. Never stash, copy, temporarily commit, or silently omit
staged, unstaged, untracked, conflict, or dirty-submodule state.

Every Git mutation, including Direct, uses either a newly created
`TaskWorkspaceLeaseV1` or a host-provided worktree that has been explicitly
registered and verified as exclusive to the current task. Never create a nested
worktree from another task's worktree. Branches, worktrees, commits, checks,
integration candidates, and cleanup belong to the lease; a name or path prefix
alone is never ownership proof.

Register a host-created worktree only before mutation, while it and a separate
source checkout are clean and still bound to the exact base:

~~~bash
sbw workspace register --task-id <task-id> --base-revision <exact-sha> \
  --integration-target <local-branch> --source-checkout <clean-checkout>
~~~

Registration records host ownership; Better Workflows must preserve that task
branch and worktree during cleanup. For protected delivery, do not move the
lease to integrated from prose or a copied receipt. After the governed run has
reconciled its exact `pr.merge` and `remote.sync` actions, bind that run with
`sbw workspace reconcile ... --run-id <run-id>`. Until it succeeds, retain the
task resources and report PR-ready rather than completion.

Detached HEAD, an absent source branch, or a target deleted or renamed during
the task requires the user to select or rebind the integration target. Offer at
most three evidence-ranked local candidates: repository Profile, task
convention such as `dev`, then upstream/origin default or a local branch that
contains the base revision. Never silently choose `main` from `origin/main`.

## Preview the route

For `$better-workflows:auto`, natural-language `$better-workflows`, and every
task selector except the explicit `direct` fast path, run a capability snapshot
and route preview before substantial work. The workspace preflight above still
applies to explicit Direct. An explicit selector is the highest user-controlled
route and Profiles may not replace it:

~~~bash
sbw doctor --capabilities
sbw route preview --goal "<goal>" --scope <path> [--entry <selector>] [--mode <mode>]
~~~

Report the selected source, primary entry/template, effective mode, excluded
optional support skills, and blockers. The Node-only snapshot must not start
provider login or semantic probes. It may reuse a valid 24-hour deliberation
roster cache; otherwise provider capabilities remain `requires-authority`.
Host-exposed MCP availability is `unsupported` in this helper and must be
reported by the Codex host.

Routing precedence is:

1. host hard constraints;
2. explicit entry, template, and mode;
3. the first matching workspace Profile at
   `<repo>/.better-workflows/profile.json` (or legacy
   `<repo>/.codex/better-workflows.json` only when the v4 path is absent);
4. the first matching personal Profile at
   `$SBW_STATE_ROOT/routing/profile.json`;
5. built-in `auto`.

Profiles select exactly one primary entry or template. They may set a minimum
mode, declare required capabilities, and name at most three advisory support
skills. A matching workspace rule replaces the personal rule; Profiles are
never deep-merged. Within one Profile, highest priority wins and equal priority
keeps file order. Match categories are ANDed while values inside a category are
ORed. A Profile cannot grant authority, install capabilities, add side effects,
lower a mode, or replace an explicit selector.

For delivery work, select `bounded-autopilot-v1` explicitly on the run when the
user wants low-risk work to continue without repeated prompts. It is a
run-scoped policy projection, not a global default or an authority source: it
may automate bounded commit, immutable cache publication, `codex/*` push, and
one PR to `dev`, while host bootstrap/upgrade/revoke, protected merge, deploy,
direct `dev`/`main` push, and cleanup remain human gates. Evaluator standing
consent never implies this delivery profile.

If the route remains built-in `auto`, `template` is intentionally null. Select
one real template from current evidence and preview again with `--template`;
never invent an `auto` template. For a stable handoff, record and consume one
private, single-use receipt:

~~~bash
sbw route preview --goal "<goal>" --scope <path> --template <template> --record
sbw run --route-receipt <route-receipt-id>
~~~

The receipt binds the workspace, scope, catalog, Profiles, capabilities,
selected route, and full plugin bundle digest. Expiry, replay, or any binding
drift fails closed.

## Resolve the helper

If a user or automation supplies a hyperlink to a versioned plugin-cache skill
path that no longer exists, do not recreate or mutate that stale path. Resolve
the current bundle through the host skill catalog or a verified matching cache
entry, record the plugin manifest name, exact version, and resolved path, then
verify its selector/template inventory and helper capabilities. If no current
matching bundle can be proven, fail closed.

Use `sbw` only when `command -v sbw` succeeds, `sbw templates` lists the selected
template, `sbw help` lists `route preview`, and `sbw doctor --capabilities`
succeeds without starting provider probes. If any check fails, or the inventory
lacks that template, treat the global helper as stale: resolve the plugin root
as two directories above this `SKILL.md` and run
`node <plugin-root>/scripts/sbw.mjs`. Verify the fallback with the same command
and template checks before starting a run. In the examples below, `sbw` means
whichever form was verified. Do not install packages or create a global symlink
automatically. Plugin cache versions are immutable: if the same version has
different contents, do not overwrite it. Require a new build version and exact
source/cache digest verification.

## Route the task

1. Read all applicable `AGENTS.md` files and repo-local skills before acting.
2. Classify the task using risk, uncertainty, blast radius, irreversibility, and evidence gap:
   - `direct`: trivial, reversible, well-understood work. Do not create an evidence journal, but keep workspace preflight, task-owned worktree isolation for Git mutation, bounded targeted checks, safe integration, and exact cleanup.
   - `verified`: use one to three native research/review/refutation agents.
   - `deep`: run `verified`, then one or two sequential model-pinned Codex critics.
   - `critical`: require independent external evidence and all fail-closed gates.
3. Never lower a user-requested mode. Model output may raise risk but may not lower it.
4. Select one template from [templates.md](references/templates.md).
   When changing a review-enabled template, also read
   [review-profiles.md](references/review-profiles.md) and keep its declared
capability profile aligned with the runtime policy.

For Auto, record `AutoRiskAssessmentV1`. Direct requires explicit acceptance
and mutation intent, irreversibility `0`, every other score at most `1`, total
at most `2`, no hard exclusion, and no selector, Profile, host constraint, or
protected/remote target requiring more. Unknown is evidence-required. Scope,
source, target, risk, or capability drift invalidates the assessment and route.

Direct checks are local, offline, side-effect-free outside task scratch, and
bounded to 120 seconds. Reads stay within the task worktree and scratch. They
use only the guarded Node runner; npm/pnpm, child processes, workers, native
addons, network use, checkout-external reads, or isolation-override flags
require an evidence route. This is a trusted-code seat belt, not a malicious
code sandbox. Failure or an unexplained result blocks completion. A Direct Git mutation keeps
the minimal workspace lease but no evidence ledger. That lease is recovery and
ownership state, not replayable proof.

For `research-deliberation`, also read
[deliberation-roster.md](references/deliberation-roster.md). It defines the
CLI-proven participant roster, model-bound roles, Antigravity CLI (`agy`)
transport for Gemini-, Claude-, and GPT-OSS-branded models, the rule that
`agy` is not a model brand, and
capability-ranked final-arbiter fallback. Apply the contextual `medium`/`high`
reasoning-effort policy to every model and record its actual transport. The
former separate AI-meeting alias is intentionally not used.

## Start a verified run

For `verified`, `deep`, or `critical`, initialize a run:

~~~bash
sbw run --template <template> --mode <mode> --goal "<goal>" --scope <path>
~~~

Pass repeated `--scope` arguments for disjoint paths. Add `--contract <json>` when exact acceptance items, ignored paths, remote revision, or side-effect authority must be preserved.

Before and after every native wave:

~~~bash
sbw sentinel capture <run-id> --label <label>
sbw sentinel verify <run-id> --label <label>
~~~

If an intended commit or rebase changes `HEAD` after run creation, use the
root-only pre-review rebind before capturing the next sentinel:

~~~bash
sbw source rebind <run-id> --reason "commit stage completed"
sbw sentinel capture <run-id> --label post-commit
sbw sentinel verify <run-id> --label post-commit
~~~

Rebind is rejected after review packages, findings, or side effects exist; it
does not replace a fresh review. It marks every prior complete evidence record
stale and resets the v2 execution ledger, including evidence contracts that do
not carry an explicit source-binding field.

If verification reports drift, mark the run `indeterminate`, discard that wave's conclusions, do not restore files automatically, and report the changed surfaces.

## Inspect the derived graph

Graph View is a typed, read-only projection of installed templates or one live
run. It is a cross-record validator, not a policy input, scheduler, authority
source, persisted graph, Dynamic Workflow runtime, or agent runtime. It may only
add a fail-closed structural rejection; it never authorizes, schedules, or
relaxes behavior.
Every enforcement point recomputes validation from the installed template or
private run records. Never accept a graph envelope, graph digest, Mermaid, or
persisted graph as policy input. Presentation failure cannot grant or relax
authority.

~~~bash
sbw graph validate
sbw graph validate --template <name>
sbw graph validate --run <run-id>
sbw graph inspect --template <name> [--format json|mermaid]
sbw graph inspect --run <run-id> [--format json|mermaid]
~~~

JSON is canonical. Mermaid remains inside the JSON `content` field and is never
written implicitly. Structural errors exit `2` and block `eval`, run creation,
action-token issue, and completion. Warnings do not block. Graph output must not
contain raw evidence summaries, inputs, conversations, token hashes,
credentials, provider receipts, or absolute paths.
Live-run provenance digests must cover only the allowlisted non-sensitive
structural projection. Omitted private fields must not affect source or graph
digests.

## Delegate bounded read-only work

- Spawn at most three direct native children. Do not allow children to spawn descendants.
- Use native children only for research, review, test/log analysis, and refutation.
- State explicitly that they must not edit files, invoke external side effects, accept risk, or declare completion.
- Give each child a bounded question and require structured findings with evidence.
- End the native wave before launching any external critic.
- Never decide by vote. Reconcile claims against current evidence.

For `critical`, do not delegate to a native child unless the current surface can deny its mutation and external-action capabilities. Otherwise keep the work with the root and use isolated critics.

## Run independent critics

Use sequential critics only when evidence is missing, contradictory, or required by mode:

~~~bash
sbw critic codex <run-id> --model gpt-5.6-terra --effort high --prompt-file <sanitized-file>
sbw critic codex <run-id> --model gpt-5.6-sol --effort xhigh --prompt-file <sanitized-file>
~~~

When the parent Codex sandbox blocks the child CLI from reading its own local auth/runtime state, request scoped approval for this exact critic command. Never replace the child `--sandbox read-only` setting with a bypass flag.

Use Antigravity CLI (`agy`) only when the user authorized external egress and
the bundle is sanitized, non-confidential, and within the byte limit:

~~~bash
sbw critic agy <run-id> --model "Gemini 3.1 Pro (High)" --prompt-file <sanitized-file>
~~~

Never send secrets, regulated data, private source, raw history, or
confidential prompts through `agy` argv transport. If critical policy requires
this transport and it is unavailable, finish as `inconclusive`.

## Record evidence and findings

Read [evidence-and-state.md](references/evidence-and-state.md) before adding evidence, resolving findings, resuming a run, or declaring completion.

~~~bash
sbw evidence add <run-id> --file <evidence.json>
sbw evidence supersede <run-id> --file <supersession.json>
sbw finding add <run-id> --file <finding.json>
sbw finding update <run-id> --file <finding.json>
sbw complete <run-id>
~~~

Do not complete with open P0/P1 findings, stale evidence, expired accepted risk, unknown reconciliation, missing acceptance evidence, or an invalid current-tree sentinel.

`evidence supersede` is a narrow recovery lifecycle for a typed
`provider-reconciliation` candidate that was admitted before action
reconciliation and later proven malformed by the persisted terminal action. It
never edits or deletes the original record. The append-only supersession must
bind both exact evidence digests and the same run, action attempt, execution,
source, contract, policy, and remote revision; the replacement must be the exact
evidence ID reconciled by the action. Missing, stale, cross-attempt, chained,
conflicting, duplicate, filename-rebound, or hand-edited bindings fail closed.
After admission, freshness checks preserve the target and replacement bytes and
block instead of rewriting either digest-bound record. Do not use this lifecycle
to hide valid evidence or as a substitute for source rebind.

Canonical freshness writes use a journal-first protocol: the durable
`evidence.freshness-transition` intent binds the admission digest, previous and
next evidence digests, immutable projection, cause, and an exact replay patch
before the evidence file is replaced. Resume must replay that same intent; it
must not append a competing transition. Autonomous-commit invalidation also
requires exactly one digest-bound `evidence.invalidated` parent covering the
complete child transition set. Missing, duplicate, partial, or conflicting
chains block every evidence consumer. Legacy transition records keep their
original reader and are not silently upgraded.

Review finding dispositions and final broad-review gates read only the
effective journal-replayed evidence set and revalidate each selected record's
current dependency fingerprints. A persisted `stale: false` field is never an
authority source by itself. Action tokens additionally bind a canonical digest
of every current typed record selected by the contract's complete configured
gate, together with the immutable initial source anchor, replay-valid source
transition chain, freshly captured source binding, content-complete sentinel,
policy, authority, effective supersession state, and current evidence-backed
P0/P1 finding dispositions. The digest is recomputed at the final issuance
boundary, before token consumption, immediately before and after a governed
provider call, and before successful reconciliation reservation and
persistence. Pre-call drift is `not-sent`; post-call drift is an audited
`unknown` bound to the invocation digest and cannot be retried or reconciled as
success from the stale gate. If an autonomous commit encounters any
supersession record, its
reconciliation fails before provider reservation, source-state transition, or
evidence mutation so both bound evidence byte streams remain unchanged.

All newly-created non-direct template runs use TaskContract v2. The run creates
an append-only execution ledger and accepts only typed evidence receipts from
the 102-kind catalog; v1 runs remain on the v1 reader and are never silently
upgraded. A v2 completion cannot be authorized by text or caller-supplied
`acceptanceIds`.

Inspect and advance the ledger explicitly:

~~~bash
sbw ledger status <run-id>
sbw ledger transition <run-id> --file <event.json>
sbw ledger compile <run-id> --design-packet <packet.json>
~~~

For templates with a review policy, create an immutable package, close scoped
findings within the bounded repair budget, and run the final broad review before
requesting any action token:

~~~bash
sbw review package <run-id> --base <40-char-sha> --head <40-char-sha> \
  --scope <path> --diff-manifest <json> \
  --instruction-digest <sha256> --sentinel-digest <sha256>
sbw review status <run-id>
~~~

`review status` includes the repository campaign budget. Before creating a
successor package, verify that the campaign has remaining repairs. Never treat a
fresh run, state root, package, or execution as a reset.

For a formal full evaluator, use only the host-capable Node launcher:

~~~bash
sbw eval --formal --expected-head <40-char-sha> \
  --expected-base <40-char-sha> \
  --launch-root </private/tmp/bw-*-formal-eval-*>
~~~

Do not compose shell wrappers for PATH, lid state, process scans, TMPDIR, or
caffeinate. The launcher creates and verifies those bindings and retains one
terminal receipt. One exact SHA receives one primary attempt and at most one
classified infrastructure replacement; a third attempt is rejected and a
source/fixture failure requires a repaired SHA.

For a package-bound independent Codex review, use only:

~~~bash
sbw review launch-native <run-id> --base <40-char-sha> --head <40-char-sha> \
  --package <package-id> --package-file <package.json> \
  --diff-manifest <manifest.json> --instruction <instruction.md> \
  --authorization <authorization.json> --model <model> \
  --reviewer-id <id> --execution-id <id> --result <new-absolute-result.json>
~~~

The runner must remain tool-capable: never add model-time `--output-schema` and
never substitute the current branch diff for the frozen `BASE...HEAD` manifest.
One immutable package may consume only one model attempt; a new result path or
execution ID does not reset it. Ad-hoc `codex exec` output is not admissible
native-review evidence.

For ordinary, low-risk PR delivery, use the isolated `pr-to-dev-agent-quorum`
template. After the immutable review package is closed, provide a source-bound
`quorum-manifest-v1` from the five fixed software roles and verify it with:

~~~bash
sbw review quorum verify <run-id> --file <quorum-manifest.json>
sbw review quorum run <run-id> --file <quorum-manifest.json>
~~~

`run` records one `agent-review-quorum` receipt only when every role is PASS,
the identities and provider families satisfy the diversity policy, and the
classifier returns `ordinary`. Missing, conflicting, stale, high-risk, or
unclassified input is HOLD. This path reports `hostSignerInvoked: false` and
does not call `sudo`; governance changes, evaluator/identity/routing changes,
and any other high-risk surface remain on the legacy host-trusted path.

The verifier also requires `SBW_QUORUM_IDENTITY_REGISTRY` to point to an
operator-provisioned JSON registry outside the checkout. It must contain
exactly one trusted entry for each fixed role, with unique identities, keys,
and public keys plus the provider/provider-family/model binding. The manifest
pins that registry's digest and each receipt signs the complete package/head
binding. A missing, unreadable, symlinked, malformed, or mismatched registry
is HOLD; the registry is software-layer trust material and is not equivalent
to the root-owned host signing key.

`sbw deliberation deliberate --run <run-id> --prompt-file <sanitized-file>` is
available only to the research and self-improve pilots. It writes one atomic,
idempotent bundle and prints only its digest, participant statuses, and decision
summary. The Graph View remains a read-only projection of tasks and dependency
state; it is never a scheduler or authority source.

Ledger event files may carry an `expectedLedgerDigest` from the caller's last
read; a stale value is rejected, and every transition is root-owned.

## Execute side effects

Only the root may request an action token, and only for authority already granted by the user:

~~~bash
sbw action issue <run-id> --action <kind> --provider <provider> --resource <exact-id> --remote-revision <revision>
# For GitHub PR creation and merges, use the governed fixed-argv provider wrapper.
sbw action execute <run-id> --token <token>
# For a non-wrapper side effect, consume the token, perform the authorized
# operation, then reconcile it. `execute` performs the consume internally.
sbw action consume <run-id> --token <token>
# Perform any other authorized side effect, then reconcile it.
sbw action reconcile <run-id> --attempt <attempt-id> --outcome <success|failure|unknown> --receipt <provider-receipt>
~~~

Never retry an `unknown` outcome without provider-side query reconciliation.
For an owned-resource creation, the same consumed attempt may be reconciled as
`success` only when the provider query proves the exact native marker, actor,
source, repository, and provider object. An unknown owned-resource attempt may
be reconciled as `failure` only after a fresh pinned-provider query proves the
exact resource is absent; an unpinned or local absence snapshot is not enough.
Provider-execution
reservations may resume only for the same run, action attempt, token, execution
identity, and recorded outcome after an interrupted action-record write, with
one controlled unknown-to-terminal supersession and no second identity;
superseded or legacy-format reservations remain rejected. `actions.dispatch`
remains deferred because GitHub workflow dispatch accepts a mutable ref and
cannot atomically bind execution to preflight-attested workflow bytes. New
dispatch tokens and executable provider paths fail closed; historical dispatch
records may be validated or reconciled read-only. Ambiguous or indeterminate
dispatch state remains unreconciled.

For governed GitHub actions, bind every provider probe to the absolute
executable path and content digest captured at token issuance; do not resolve a
fresh PATH command or invoke a bare `gh` during authorization, PR-state, check,
receipt, or reconciliation probes. A `pr.create` wrapper failure after its
preflight is `sent-or-indeterminate`, not immediate failure; an explicit
preflight record marked `not-sent` can release `pull/new` directly, while a
fresh pinned-provider absence proof may reconcile the same unknown attempt as
failure. If any configured evidence, finding disposition, source-transition,
or sentinel authority changes after the wrapper has called the provider, the
action record itself becomes terminal `unknown` and retains the provider
invocation audit marker; never rewrite it to pending or invoke the provider a
second time.
Creation reservation, consume, release, and expiry-reap operations are
serialized by a resource lease namespaced by provider repository, action, and
resource, so unrelated repositories do not share a `pull/new` reservation. An
expired reservation cannot be taken over while another consumer is finalizing
it; legacy unscoped reservations remain blocked until explicitly reconciled.

`consume` is rejected for wrapper-backed `git.push`, `pr.create`, and
`pr.merge` actions; use `execute`, which consumes and invokes the fixed-argv
wrapper as one governed path. A contract `deferredActions` entry is rejected by
the core issue, consume, execute, reconcile, completion, and cleanup paths;
template-level empty action gates are not the security boundary.

## Apply repository-specific policy

When working in the Connectors repository, read [connectors-policy.md](references/connectors-policy.md) and enforce it together with the current repository `AGENTS.md`. In every other repository, use its own `AGENTS.md` and do not import Connectors-specific rules.
