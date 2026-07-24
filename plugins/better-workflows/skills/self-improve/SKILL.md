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
