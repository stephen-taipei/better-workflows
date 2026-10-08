# R10 Claude Code phase and dependency amendment

This planning-only candidate keeps all CC tasks BLOCKED and all 109 tracked
requirements / 107 GA obligations intact. It does not add Claude to the V5.0
public surface, install a plugin, qualify a host, or publish V5.1.

## Problem and change

The R9 requirement matrix listed cross-track dependencies that the CC task DAG
omitted. The R10 catalog records the following full-task completion dependencies:

| Task | Required tasks |
|---|---|
| CC-01 | B-08, W0-01, W0-06 |
| CC-02 | B-08, CC-01 |
| CC-03 | B-09a, B-09b, B-09c, B-09d, B-11, CC-01 |
| CC-04 | B-08, CC-01, CC-03 |
| CC-05 | CC-02, CC-03, CC-04 |
| CC-06 | B-04a, B-08, CC-05 |
| CC-07 | CC-01, CC-05, CC-06, REL-01 |

Requirement coverage is not synonymous with a direct dependency. W0-06 provides
89a's scope-freeze contract; PL-01's Windows production work is not added as a
macOS development prerequisite. B-04a provides 51's quota contract; the Claude
adapter still requires its own live observations. REL-01 remains the complete
release prerequisite for 90; partial development cannot satisfy it.

`v5-1-claude-claims.json` distinguishes development, qualification and release
observations. Its checker rejects phase substitution, host/platform/capability,
base/source/policy drift, incomplete CC-05 qualification raw/grader evidence,
incomplete CC-07 release four-host evidence, and
self-declared READY/completion. Passing structural checks explicitly does not
verify actual evidence bytes or provenance and never grants authority. The V5.0
exclusion utility filters caller-supplied path/host lists only; it does not
attest inventory completeness or replace the existing protected source-rights
consumer. The caller must obtain a complete bound inventory independently.

## Exact scope and source

The projection starts at RC1 dev `9afb9e119d74ff721fe6e0cb75760a0c32e7de25`.
Only the required planning catalogs, SOP, historical execution-status snapshot,
locale ownership fixture, checker and tests are projected. No unrelated private
runtime commits are part of this candidate. Private source locators and branch
names are withheld from the public planning projection; the original source
digest and issue-number namespace remain for private reconciliation.

The instruction to cherry-pick historical Claude commits is replaced with the
same reference-only, isolated reimplementation rule already used in Track H.
Historical autonomy files are not present in RC1 and require a separately
reviewed adoption proposal; this amendment does not restore them or their CLI.

## Planning acceptance and next work

Run `node scripts/validate-v51-plan.mjs`,
`node scripts/validate-v51-claude-claims.mjs`, and
`node --test scripts/tests/v51-plan-catalog.test.mjs scripts/tests/v51-claude-claims.test.mjs`.
Independent review must verify the metadata digest amendment, exact dependency
mapping, no obligation reduction, and no route from structural evidence to
runtime authority. This candidate has no reviewed READY packet digest.

After this planning revision is accepted, Root must freeze actual development
subcontracts, exact file ownership and prerequisite receipt coverage before
implementation. Real owner-authenticated evaluation remains a separate phase.
A dev PR does not authorize merge, activation, publication or GA.

## Phase vocabulary and limits

`completionDependencies` preserves the full-task DAG, including CC-07's REL-01
release dependency. It is not a qualification-only prerequisite list. The
separate phase scopes describe proposed subclaims, not completed capabilities.
CC-07 development covers package design; qualification covers a V5.1-only
candidate package; four-host same-source and marketplace readback remain release
obligations. No phase or observation in this amendment can complete a task.

`PROPOSAL` means unadmitted development design. `HOLD` means the phase has no
accepted qualification or release evidence. `BLOCKED` is the unchanged full-task
status. `receiptClass` is a prospective observation schema label, not an issued
receipt. The generic evidence lists are necessary structural placeholders, not
sufficient runtime qualification contracts; Root must freeze capability-specific
contracts before any live qualification can be accepted. Component release
observations do not grant publication permission: CC-07, REL-01, source-rights,
owner authorization and existing protected consumers still apply globally.
All listed subclaims are macOS-only and cannot satisfy Windows or overall GA
coverage. PL-01 and every other requirement remain in the full catalog.

The source `requirementDependencies` string retains the original matrix spelling;
`completionDependencies` is the machine-readable task list. The checker validates
the complete requirements and backlog catalogs before checking these seven claims.
The reviewed backlog metadata digest changes to
`e911b5d2491ef597d76b888197ee7687644a29c7ef10fa07129704c68384cef9`
for the explicit dependency mapping and withheld private source locator. The
original requirements row digest, leaf count and GA obligation count are unchanged.
