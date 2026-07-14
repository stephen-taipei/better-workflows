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

Findings use only `open`, `resolved`, `accepted-risk` with owner/reason/future expiry, or `rejected-with-evidence`. P0 findings cannot be accepted automatically.

Run states are:

~~~text
pending running completed failed_retryable failed_terminal stale no_op
cancelled_superseded cancelled_evidence_sufficient
blocked_external_reviewer inconclusive indeterminate
~~~

Resume reuses a complete evidence node only when its declared source, dependency, tool, policy, schema, prompt, model, and required remote fingerprints still match. It never claims to restore hidden model reasoning.

Completion requires current acceptance evidence, no unresolved P0/P1, valid current-tree verification, required fresh critics, and no unknown side-effect outcome.
