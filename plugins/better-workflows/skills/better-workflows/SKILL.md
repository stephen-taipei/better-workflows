---
name: better-workflows
description: Route complex Codex work through native-first, evidence-driven workflows with root-only mutation, persistent /goal checkpoints, bounded read-only subagent waves, model-pinned critics, freshness checks, and fail-closed side-effect gates. Use when the user says better workflows, dynamic workflow, verified workflow, deep review, critical review, multi-agent review, multi-model review, review then fix, review to issues, fix issues then PR/merge, monorepo refactor, cross-platform contract, localization, iOS pbxproj review, CI/release monitoring, browser QA, research deliberation, or explicitly invokes $better-workflows.
---

# Better Workflows

Keep the root agent as the only authority that edits files, integrates changes, runs Git or GitHub mutations, deploys, accepts risk, or declares completion. Treat native subagent read-only behavior as an orchestration contract, not an OS sandbox.

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

## Resolve the helper

Use `dw` only when `command -v dw` succeeds and `dw templates` lists the selected
template. If the command fails or its inventory lacks that template, treat the
global helper as stale: resolve the plugin root as two directories above this
`SKILL.md` and run `node <plugin-root>/scripts/dw.mjs`. Verify that fallback with
the same template inventory check before starting a run. In the examples below,
`dw` means whichever form was verified. Do not install packages or create a
global symlink automatically.

## Route the task

1. Read all applicable `AGENTS.md` files and repo-local skills before acting.
2. Classify the task using risk, uncertainty, blast radius, irreversibility, and evidence gap:
   - `direct`: trivial, reversible, well-understood work. Continue normally and do not invoke `dw`.
   - `verified`: use one to three native research/review/refutation agents.
   - `deep`: run `verified`, then one or two sequential model-pinned Codex critics.
   - `critical`: require independent external evidence and all fail-closed gates.
3. Never lower a user-requested mode. Model output may raise risk but may not lower it.
4. Select one template from [templates.md](references/templates.md).

For `research-deliberation`, also read
[deliberation-roster.md](references/deliberation-roster.md). It defines the
CLI-proven participant roster, model-bound roles, Agy-based Gemini route, and
capability-ranked final-arbiter fallback. Apply the contextual `medium`/`high`
reasoning-effort policy to every model and record its actual transport. The
former separate AI-meeting alias is intentionally not used.

## Start a verified run

For `verified`, `deep`, or `critical`, initialize a run:

~~~bash
dw run --template <template> --mode <mode> --goal "<goal>" --scope <path>
~~~

Pass repeated `--scope` arguments for disjoint paths. Add `--contract <json>` when exact acceptance items, ignored paths, remote revision, or side-effect authority must be preserved.

Before and after every native wave:

~~~bash
dw sentinel capture <run-id> --label <label>
dw sentinel verify <run-id> --label <label>
~~~

If verification reports drift, mark the run `indeterminate`, discard that wave's conclusions, do not restore files automatically, and report the changed surfaces.

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
dw critic codex <run-id> --model gpt-5.6-terra --effort high --prompt-file <sanitized-file>
dw critic codex <run-id> --model gpt-5.6-sol --effort xhigh --prompt-file <sanitized-file>
~~~

When the parent Codex sandbox blocks the child CLI from reading its own local auth/runtime state, request scoped approval for this exact critic command. Never replace the child `--sandbox read-only` setting with a bypass flag.

Use Agy only when the user authorized external egress and the bundle is sanitized, non-confidential, and within the byte limit:

~~~bash
dw critic agy <run-id> --model "Gemini 3.1 Pro (High)" --prompt-file <sanitized-file>
~~~

Never send secrets, regulated data, private source, raw history, or confidential prompts through Agy argv transport. If critical policy requires Agy and it is unavailable, finish as `inconclusive`.

## Record evidence and findings

Read [evidence-and-state.md](references/evidence-and-state.md) before adding evidence, resolving findings, resuming a run, or declaring completion.

~~~bash
dw evidence add <run-id> --file <evidence.json>
dw finding add <run-id> --file <finding.json>
dw finding update <run-id> --file <finding.json>
dw complete <run-id>
~~~

Do not complete with open P0/P1 findings, stale evidence, expired accepted risk, unknown reconciliation, missing acceptance evidence, or an invalid current-tree sentinel.

## Execute side effects

Only the root may request an action token, and only for authority already granted by the user:

~~~bash
dw action issue <run-id> --action <kind> --provider <provider> --resource <exact-id> --remote-revision <revision>
dw action consume <run-id> --token <token>
# Perform the one authorized side effect.
dw action reconcile <run-id> --attempt <attempt-id> --outcome <success|failure|unknown> --receipt <provider-receipt>
~~~

Never retry an `unknown` outcome without provider-side query reconciliation.

## Apply repository-specific policy

When working in the Connectors repository, read [connectors-policy.md](references/connectors-policy.md) and enforce it together with the current repository `AGENTS.md`. In every other repository, use its own `AGENTS.md` and do not import Connectors-specific rules.
