---
name: better-workflows
description: Route complex Codex work through native-first, evidence-driven workflows with root-only mutation, bounded read-only subagent waves, model-pinned critics, freshness checks, and fail-closed side-effect gates. Use when the user says better workflows, dynamic workflow, verified workflow, deep review, critical review, multi-agent review, multi-model review, review then fix, review to issues, fix issues then PR/merge, cross-platform contract, localization, iOS pbxproj review, CI/release monitoring, browser QA, research deliberation, or explicitly invokes $better-workflows.
---

# Better Workflows

Keep the root agent as the only authority that edits files, integrates changes, runs Git or GitHub mutations, deploys, accepts risk, or declares completion. Treat native subagent read-only behavior as an orchestration contract, not an OS sandbox.

## Resolve the helper

Use `dw` when `command -v dw` succeeds. Otherwise resolve the plugin root as two directories above this `SKILL.md` and run `node <plugin-root>/scripts/dw.mjs`. In the examples below, `dw` means whichever form was resolved. Do not install packages or create a global symlink automatically.

## Route the task

1. Read all applicable `AGENTS.md` files and repo-local skills before acting.
2. Classify the task using risk, uncertainty, blast radius, irreversibility, and evidence gap:
   - `direct`: trivial, reversible, well-understood work. Continue normally and do not invoke `dw`.
   - `verified`: use one to three native research/review/refutation agents.
   - `deep`: run `verified`, then one or two sequential model-pinned Codex critics.
   - `critical`: require independent external evidence and all fail-closed gates.
3. Never lower a user-requested mode. Model output may raise risk but may not lower it.
4. Select one template from [templates.md](references/templates.md).

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
