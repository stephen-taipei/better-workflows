# README quality blueprint

[41-locale localized overview and official web entry points](../LANGUAGES.md). This editorial blueprint remains canonical in English.

A Better Workflows README is a landing page, not a compressed reference
manual. Its job is to help a reader answer five questions in order:

1. What is this, and is it for me?
2. What problem does it solve?
3. Why should I trust its claims?
4. What is the shortest path to a first success?
5. Where should I go next?

This blueprint defines the narrative, visual, localization, and validation
contract for every repository README. The machine-readable source is
[`readme-quality-v1.json`](../../plugins/better-workflows/config/readme-quality-v1.json).

## Start from the reader's decision

GitHub surfaces a README before most repository content. The first screen must
therefore establish the product promise, intended audience, and a bounded next
action. It must not begin with internal architecture, a complete command
reference, or release-recovery detail.

Write for these reader jobs:

- **New visitor:** decide quickly whether Better Workflows solves a relevant
  problem.
- **New user:** install the plugin and reach one successful automatic route.
- **Evaluator:** understand the authority boundary and fail-closed behavior.
- **Returning operator:** jump to a workflow, security, architecture, or CLI
  answer.
- **Contributor or translator:** find the canonical contract, development
  commands, support, and governance.
- **Recipe reader:** understand one recipe's input, output, safety, example,
  and promotion lifecycle.

## Use a cause-and-effect narrative

The five landing READMEs use the same eight-part semantic sequence. Headings
may be idiomatic in each language, but the reader journey does not change.

| Section | Reader question and narrative role |
| --- | --- |
| Promise and audience | What is Better Workflows, why does it exist, and who is it for? |
| Problem to outcome | What goes wrong when intent, authority, evidence, and provider outcome are conflated? |
| Proof and boundaries | Which guarantees make the proposed outcome credible? |
| First success | What is the shortest complete install-to-result path? |
| Choose the next path | Which workflow or document matches the reader's goal? |
| Lifecycle | How does a goal become a reconciled completion—or stop safely? |
| Trust and limits | What can the system never infer, authorize, or claim? |
| Learn, help, contribute | Where are the deep docs, support, governance, development, and license? |

This order provides a practical arc:

- **Context:** prompt-driven work can express intent without proving authority
  or state.
- **Tension:** side effects turn that gap into delivery risk.
- **Resolution:** Better Workflows binds goal, scope, evidence, review, action,
  and provider reconciliation.
- **Proof:** explicit guarantees and boundaries show how the resolution works.
- **Action:** the reader reaches a first success before encountering deep
  implementation detail.
- **Continuation:** role- and outcome-based routes move the reader to the right
  tutorial, how-to guide, explanation, or reference.

## Separate landing content from deep documentation

Use the README for decision-relevant information. Route depth by purpose:

- [Getting started](getting-started.md) is the first-use tutorial.
- [Workflows](workflows.md) is the outcome-selection how-to guide.
- [Architecture](architecture.md) explains the control plane and trade-offs.
- [Security](security.md) explains authority, privacy, attestations, and
  fail-closed behavior.
- [CLI reference](cli-reference.md) is the command reference.
- Localized `docs/details/*.md` pages preserve comprehensive translated detail.

Do not duplicate cache recovery, lock ownership, full provider transport
semantics, exhaustive commands, or implementation change history in the
landing page. A concise safety claim stays local; its auditable depth belongs
in the canonical guide.

This separation follows the Diátaxis distinction between tutorials, how-to
guides, explanation, and reference. A single page cannot optimize for all four
reader needs at once.

## Make every visual earn its place

Use a visual only when relationships, hierarchy, or state transitions are
materially easier to understand than prose.

The landing pages permit two visuals:

1. **Authority-boundary architecture:** answers which layers shape intent,
   current facts, tool authority, bounded retries, and read-only state.
2. **Goal-to-completion lifecycle:** answers where evidence is checked, where
   side effects are authorized, and where unknown state stops progress.

Every visual must include:

- concise, meaningful alt text;
- an adjacent text equivalent that preserves the conclusion when the visual
  is hidden or Mermaid does not render;
- real text for essential labels whenever possible;
- a stable reader question that justifies keeping the visual current.

Do not add decorative screenshots, text-heavy images, or a diagram that merely
duplicates a short list. Keep selector tables to two concise columns so they
remain usable on narrow screens.

## Preserve meaning across languages

English is the semantic reference, not a line-count target. Traditional
Chinese, Simplified Chinese, Japanese, and Korean should sound natural to a
native reader while preserving the same contract.

The following items must remain equivalent:

- the eight semantic sections and their order;
- first-success commands and product identifiers;
- the five authority, evidence, unknown-state, prompt, and privacy claims;
- workflow, security, architecture, CLI, support, governance, development, and
  license destinations;
- visual purpose, lifecycle stages, and text fallbacks;
- version source and badge policy.

Headings, sentence boundaries, punctuation, examples, and calls to action may
be idiomatic. Never translate commands, selectors, evidence identifiers, or
security semantics.

## Give recipe READMEs a smaller contract

A recipe README is not a product landing page. It must answer:

1. What deterministic task does the recipe perform?
2. What input shape does it accept?
3. Which artifacts or evidence candidates does it produce?
4. Which reads and side effects are prohibited?
5. How can a maintainer validate it with the supplied fixture?
6. Which governed steps are required before trust, execution, or artifact
   promotion?

Readers should not need to inspect `run.mjs` or `recipe.json` to discover this
contract.

## Write for scanning and translation

- Lead with the reader's outcome and put important terms at the beginning of
  headings and paragraphs.
- Use active voice and name the actor responsible for an action.
- Address the reader directly for procedures.
- Keep paragraphs short and give each one a single job.
- Use numbered lists for sequence and bullets for non-sequential choices.
- Use descriptive links instead of generic “click here” labels.
- Keep headings hierarchical, specific, and parallel at the same level.
- Prefer literal, unambiguous language that survives translation.
- Put conditions before instructions and expected outcomes after commands.

## Validate semantics, not decoration

The documentation tests must detect more than matching headings. They verify:

- one H1 and a logical heading hierarchy;
- ordered semantic section and critical-claim markers;
- exact first-success commands and stable identifiers;
- relative links and locale-specific detail destinations;
- version badge parity with runtime metadata;
- meaningful image alt text and adjacent visual fallbacks;
- a single Mermaid lifecycle with a complete text equivalent;
- two-column table and paragraph-length budgets;
- absence of designated deep implementation detail from landing pages;
- the recipe-specific purpose, input, output, safety, example, and promotion
  sections.

Adversarial fixtures should remove a safety claim while keeping its heading,
alter a command, break a localized link, remove a visual fallback, add a
second H1, widen a table, or delete a recipe safety boundary. Each mutation
must fail for the intended reason.

## Research basis

- [GitHub: About the repository README file](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
  defines the README's first-visit purpose and recommends moving long-form
  documentation elsewhere.
- [Diátaxis](https://diataxis.fr/start-here/) separates tutorial, how-to,
  explanation, and reference needs.
- [Microsoft: Scannable content](https://learn.microsoft.com/en-us/style-guide/scannable-content/)
  emphasizes first-things-first structure, short paragraphs, and consistent
  visual entry points.
- [Google developer documentation style](https://developers.google.com/style/highlights)
  recommends active voice, direct address, descriptive headings, accessibility,
  and global-audience writing.
- [GitHub: Creating diagrams](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams)
  documents Mermaid support in Markdown.
- [W3C WAI: Images tutorial](https://www.w3.org/WAI/tutorials/images/) requires
  text alternatives and complete equivalents for informative and complex
  visuals.
