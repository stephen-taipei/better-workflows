# Native review CLI preflight development contract

This document is the public projection of a historical five-file Root-owned repair. Its exact original source revision, file-byte bindings and independently reviewed original contract remain in private evidence. The adjacent JSON is explicitly a historical public projection, not an execution contract or admission receipt. It cannot replace current actual source/ownership evidence and the runner's immutable package bindings. It retains the original CC-01 through CC-07 dependencies and BLOCKED qualification state.

The observed native launch selected Codex CLI 0.160.1, which the installed protocol rejects. The package attempt was consumed before that rejection. The missing result JSON was a secondary error. The original blocked attempt stays immutable; no attempt reset or same-head replacement is allowed.

Before consuming a new actual launch attempt, the runner captures the selected absolute CLI's `--version` with the same launch environment, a 5 second deadline, 8192 combined output-byte cap and confirmed process-group cleanup. The version line must have the exact `codex-cli X.Y.Z` shape and belong to the existing supported list. The actual app-server handshake still performs its original version check.

Preparation does not execute a binary. Sharded and non-sharded launches retain the once guard, disclosure validation, immutable source package and content checks. This preflight does not prove model readiness, producer provenance, host qualification or release eligibility. Global configuration, installed bundles, the supported-version module and the bridge are unchanged.

The final candidate must pass the adjacent contract's dual Node tests, full repository gates and a formal review from the original immutable installed reviewer. Task-only selection of the existing supported 0.153.4 binary is explicit. Candidate runner code cannot act as its own acceptance reviewer. Original usage and remaining attempt limits carry forward; a new HEAD does not reset them.
