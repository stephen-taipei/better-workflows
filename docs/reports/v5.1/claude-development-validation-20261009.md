# Claude development validation: historical evidence and fresh publication boundary

Status: DEVELOPMENT EVIDENCE ONLY. CC-01–CC-07 qualification remains BLOCKED.

## Historical candidate

The public candidate `8ae909fc37c464cea0b31c3d5a291658af9da052` extends the protected development base `9afb9e119d74ff721fe6e0cb75760a0c32e7de25`. Its 26 changed paths contain V5.1 planning and closed evidence schemas, an observation-only Claude host inventory, and bounded native-review version and freshness guards. Its public ancestry excludes the held private development history.

The following results belong to that historical candidate. They are not receipts for a later candidate or a different run.

| Evidence | Observed result |
| --- | --- |
| Node 22.23.1 and Node 24.12.0 focused validation | Each passed 492 cases. |
| Successful full-eval invocations | Each Node version passed all 23 eligible suites in a successful invocation. |
| Planning, claims, and development validators | Passed. |
| Native review | Covered all 26 paths and cross-module behavior; zero findings. |
| Installed verifier and independent Astra acceptance | Accepted development evidence only. |
| [Push CI run 37841279398](https://github.com/stephen-taipei/better-workflows/actions/runs/37841279398) | Succeeded for exact SHA `8ae909fc37c464cea0b31c3d5a291658af9da052`. |
| Protected CI contexts | `Runtime / Node 22.23.3`, `Runtime / Node 24.21.0`, and `test` succeeded. |
| Optional runtime qualification lane | Skipped; it does not establish qualification. |

The first Node 22 full-eval invocation failed one suite. An existing native-v3 runner test reached its real three-second cancellation timer before sealing the expected failure. One isolated full-eval retry on unchanged source and unchanged deadlines passed. The original FAIL is preserved, and its timing cause remains unconfirmed.

## Publication freshness incident

The historical candidate was pushed through the governed provider wrapper, and actual provider readback was reconciled successfully. A later pre-PR check detected a change in raw Git index bytes. The reviewed HEAD, source contents, staged tree, flags, Git configuration, and hooks stayed identical. The writer and the exact changed index region were not established. This is not attributed to the earlier push.

The historical run remains HOLD for PR creation. Its sealed sentinel, native signature, action records, and receipts are preserved. A digest record does not reconstruct the original index bytes, and semantic similarity does not replace an exact frozen binding.

The fresh publication path uses a separate clone and Git common directory, canonical task-worktree ownership, and index stability checks before freezing. Cache settings apply only to this new clone. Its new source SHA must independently satisfy its local validation, native review, exact signing, provider, and CI gates. Results observed after freezing are retained outside this report; they are not back-written into the frozen source.

## Qualification boundary

The public READY registry remains empty. The observer, schemas, local tests, and this report grant no runtime admission, privileged evaluation capability, activation, pilot, GA, or release authority.

Actual Claude owner-login evaluations and four-mode results, model and version observations, four hosts on the same SHA, source-rights receipts, and marketplace readback remain required. Local model/version pinning and drift handling also remain development work.

The owner confirmed that the 30-natural-day canary, 20 consecutive eligible starts, and three-repository acceptance receipts have not started accumulating. Eligible starts and their receipts must be observed before the release acceptance can be completed. This report does not complete GOV-01, CC-01–CC-07, or REL-01, and does not authorize merge or release.
