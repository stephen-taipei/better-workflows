# Evidence and state

Evidence records must contain:

- stable `id`
- `kind` and short `summary`
- `acceptanceIds` covered
- `status: complete`
- `sourceDigest`
- producer metadata
- declared dependency fingerprints
- creation time

New non-direct runs use TaskContract v2. Their evidence must use the typed-v1
catalog in `config/evidence-contracts-v1.json` (102 exact kinds). The CLI
recomputes and verifies the receipt payload digest and semantic success fields;
unknown kinds, unauthorized producers, stale run or revision bindings, empty
payloads, and digest mismatches fail closed. v2
completion ignores caller-provided `acceptanceIds` and requires typed evidence,
the execution ledger, and the applicable review policy.

Use the execution ledger as the only task state authority:

~~~sh
sbw ledger status <run-id>
sbw ledger transition <run-id> --file <event.json>
sbw ledger compile <run-id> --design-packet <packet.json>
~~~

`start`, `complete`, `fail`, `block`, `release`, and `cancel` events are
append-only and replayed deterministically. Budgets are three attempts for
regular stages, five for review repair, and one for authorization/side-effect
stages. A retry budget exhaustion is a machine-readable blocked state; text
such as `PASS` never changes a task state.
An event may include an `expectedLedgerDigest`; stale values and non-root
actors are rejected.

Evidence is append-only. A typed `provider-reconciliation` record admitted
before terminal action reconciliation can be superseded only when the
replacement is already the exact evidence ID in the same persisted successful
action receipt. Use:

~~~sh
sbw evidence supersede <run-id> --file <supersession.json>
~~~

The input is exact-keyed and uses the two persisted full-record digests:

~~~json
{
  "schemaVersion": 1,
  "id": "provider-proof-correction-1",
  "supersededEvidenceId": "provider-proof-malformed",
  "supersededEvidenceDigest": "<sha256>",
  "replacementEvidenceId": "provider-proof-corrected",
  "replacementEvidenceDigest": "<sha256>",
  "actionAttemptId": "<persisted-attempt-id>",
  "reason": "Correct a malformed receipt for the same terminal provider attempt"
}
~~~

The supersession record and journal event bind the run, action attempt,
execution identity, both complete record digests, contract, source, policy, and
remote revision. The original evidence file remains unchanged and auditable;
reducers omit it only after validating the complete supersession. Cross-run,
cross-attempt, stale, missing, chained, duplicate, conflicting, or manually
forged stale/supersession state is blocking. Each evidence and supersession ID
must also match its canonical JSON filename and be unique in its directory.
Once a supersession binds its target and replacement digests, routine resume or
action freshness checks never rewrite either file; a later freshness failure
blocks the action while preserving both original byte streams.

Freshness mutation is itself append-only. Protocol v2 first appends an
`evidence.freshness-transition` intent that binds the admission digest, prior
and next full evidence digests, immutable projection, transition cause, and an
exact freshness patch. Only then does it atomically replace the evidence file.
If the process stops between those writes, canonical resume reconstructs the
same next bytes from the pending intent and completes it without adding a
second transition. Every consumer replays the complete admission-to-current
journal chain, including records whose persisted `stale` flag is false.

An autonomous commit additionally appends exactly one
`evidence.invalidated` parent for its action attempt. That parent binds the
sorted complete child set by evidence ID, resulting evidence digest, and
transition digest. A missing or duplicate parent, omitted or extra child,
digest mismatch, unsupported protocol, or evidence bytes edited back to fresh
is blocking. Legacy freshness entries remain readable under their original
format; a run is checked under protocol v2 once it records a versioned
transition, and no existing legacy bytes are rewritten as an upgrade.

Code-review templates additionally use immutable review packages and stable
finding IDs. Scoped repair is bounded to five unique rounds and each repair
result must bind `repairAttemptId`, `idempotencyKey`, and the immutable
`packageDigest`; an identical retry is idempotent. A final broad review is
required before an action token can be issued. The package identity also binds
the template's `reviewProfile` digest when one is declared, so changing the
claimed review capability invalidates the package instead of silently changing
the review contract.

The `agent-review-quorum` contract is version-disjoint from legacy host-signed
critic records. It stores a canonical `quorum-manifest-v1` with exact
run/source/package bindings, five signed role receipts, bounded expiry,
provider-family diversity, routing tier, dissent, blockers, and report digest.
The reducer is deterministic: only five PASS receipts on an ordinary path can
produce PASS; missing, duplicate, stale, BLOCK, INCONCLUSIVE, identity,
provider, conflict, or classifier failures produce HOLD. A manifest's changed
paths are rederived from the immutable review package before admission, so a
role cannot relabel a high-risk diff as ordinary. The quorum verifier is
software-layer only and never invokes the host signer; high-risk changes keep
the host-trusted route. `SBW_QUORUM_IDENTITY_REGISTRY` must resolve to an
operator-provisioned, checkout-external registry with exactly the five fixed
roles; its digest is pinned in the manifest and every receipt signs the full
review-package/head binding. Missing or mismatched registry state is HOLD, and
this registry is not a root-owned Ed25519 trust root.

`self-improve-ops` pilots `code-v2-pilot` in shadow mode. Its immutable package
adds exact BASE/HEAD blob work units and two to five declared finder lanes.
Every required lane must account for every unit exactly once through a distinct
host-signed, read-only native execution. Per-claim verification rejects the
originating reviewer or execution; conflicting verifier outcomes become
`INCONCLUSIVE` rather than a vote. Findings bind exact blobs, content digests,
and quote anchors, so missing or ambiguous anchors remain blocking. The private
append-only axis and verification records are reduced into typed
`work-unit-accounting` and `review-kernel-summary` evidence. Zero findings still
requires complete lane coverage. Any later axis, verification, finding,
coverage, or synthesis digest invalidates broad completion. This pilot cannot
issue side-effect action tokens.

Findings use only `open`, `resolved`, `accepted-risk` with owner/reason/future expiry, or `rejected-with-evidence`. P0 findings cannot be accepted automatically.

Run states are:

~~~text
pending running completed failed_retryable failed_terminal stale no_op
cancelled_superseded cancelled_evidence_sufficient
blocked_external_reviewer inconclusive indeterminate
~~~

Resume reuses a complete evidence node only when its declared source, dependency, tool, policy, schema, prompt, model, and required remote fingerprints still match. It never claims to restore hidden model reasoning.

Completion requires current acceptance evidence, no unresolved P0/P1, valid current-tree verification, required fresh critics, and no unknown side-effect outcome.

After successful v2 completion, `completionBlockers` is cleared and
`completionDecision` stores the evaluated evidence, ledger, review, and sentinel
digests. Direct mode remains stateless: it creates no run directory, ledger,
review package, or extra provider call.
