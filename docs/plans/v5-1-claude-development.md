# V5.1 Claude Root development contract

This amendment defines `CC-DEV-01`, the first actual runtime slice toward all seven Claude obligations. It uses the independently reviewed R10 phase boundary. It does not change the 129 task / 109 leaf / 107 GA catalogs, full completion dependencies, or the empty full-task READY registry.

Root owns all writes under an actual `TaskWorkspaceLeaseV1` and Auto `code-change-v1`. Workers investigate/review read-only. The implementation source is H4 `51eddd9cecaf3aacaac773f7b54aa2f00d323325`; the original task catalog base remains `9afb9e119d74ff721fe6e0cb75760a0c32e7de25`. This is a historical comparison of the catalog base and public planning H4 only: their `plugins/better-workflows` Git trees are identical. The development candidate subsequently adds the Claude host observer/CLI wiring and repairs native review preflight, so its runtime tree differs from those starting revisions. No private implementation history is imported.

The exact machine-readable contract, paths, APIs, errors, bounds, acceptance commands, rollback and stop conditions are in `v5-1-claude-development-contracts.json`. Its bytes must be independently reviewed before runtime implementation. The accompanying validator checks structure and the pinned reviewed contract; it grants no dispatch, qualification, release, or task-completion authority. The public workspace object is an explicit private-evidence-required projection. It publishes only the public starting revision and host-provided preservation policy. Actual task IDs, lease registration digests, branch names, integration targets, worktree locators and current lease validity remain in private evidence and must be read back independently before any applicable admission. The projection is not a replacement lease or an authorization receipt.

## Entry and completion dependencies

The finite entry prerequisites are the current source inventory, officially registered task lease, and independent exact-byte development-contract review. B-08 / W0-01 / W0-06 remain unaccepted full-task dependencies. Their restricted dispatch, admission, baseline/source-rights, platform/pilot contracts are not exercised by this read-only observer. Their completion receipts remain required before full CC-01 qualification/completion. This slice cannot be substituted for a full-task dispatch packet.

## Runtime path

`sbw host binding claude-code --os macos` calls the shipped `claude-host-binding-v1.mjs` module. It observes the executing helper bundle and actual CLI identity with bounded execution. The canonical observation is suitable for later CC-02 producer attestation, CC-05 raw/grader bindings and CC-06 pin comparison. It does not infer model identity, installed Claude plugin state, privileged execution provenance or qualification.

The candidate V5.0 bundle has no Claude descriptor; its live observation must HOLD. Component validation success cannot overcome that absence. Successful fixture coverage is a development test only. Actual installed-source and qualification evidence require a subsequent V5.1 distribution and the remaining gates.

The existing V5.0 product version, three-host scope, source-rights policy, deferred Claude conformance, signing and installation artifacts are unchanged. No receipt is written by this CLI. All CC tasks remain BLOCKED until their full requirements are accepted.

## Independent code-review corrections

The observer CLI now distinguishes PASS (exit 0), HOLD (exit 2), and invalid invocation (exit 1). Inventory enumeration is streamed and bounded at 4096 directories / 8192 total entries, including empty directories. These corrections address only the observer slice-level interface/resource criteria and preserve its observation-only effect. CC-DEV-01 acceptance remains BLOCKED pending complete formal slice evidence; full CC-01 through CC-07 acceptance remains BLOCKED pending their original prerequisites and qualification gates. The original implementation phase limits remain historical; this contract/documentation correction uses a separately authorized bounded Root repair phase.
