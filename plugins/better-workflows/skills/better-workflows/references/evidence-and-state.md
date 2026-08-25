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
the host-trusted route.

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
