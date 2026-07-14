# Better Workflows

Native-first, evidence-driven workflow orchestration for Codex.

Better Workflows keeps one root agent responsible for edits and side effects, uses small bounded waves of native subagents for research and review, and adds deterministic state, freshness, evidence, and action-token gates for higher-risk tasks.

## Design

- Root is the only authority that edits, integrates, performs Git/GitHub mutations, deploys, accepts risk, or declares completion.
- Native subagents are bounded to research, review, testing evidence, and refutation. They are a trusted orchestration contract, not an OS sandbox.
- Native fan-out is limited to three direct children with no recursive delegation.
- Independent model critics run sequentially after the native wave.
- Side effects fail closed when evidence, freshness, authorization, or reconciliation is incomplete.
- `direct` mode creates no workflow journal and preserves fast everyday operation.

## Install

Add the GitHub marketplace and install the plugin:

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

Start a new Codex task after installation so the skill catalog refreshes.

## Use in Codex

Restart Codex or open a new task after installation. Type `/skills` and choose
`List skills`, or press `@` and search `better`, to open the built-in Skill
dropdown. Choose one automatic router, one of eight task types, or one of four
review strengths. The picker inserts the selected `$better-workflows:<name>`
reference. The recommended entry is:

```text
$better-workflows:auto <describe the outcome you need>
```

Every selector starts or continues a persistent Codex Goal before substantial
work, including the fast `direct` selector. Goal mode controls persistence;
Better Workflows mode controls verification depth. Template names and model
aliases remain internal.

For example:

```text
$better-workflows:cross-platform Check the backend, iOS, and Android contact sync contract, fix issues, and create a PR.
```

Better Workflows chooses one of four modes:

| Mode | Behavior |
| --- | --- |
| `direct` | Root works normally without durable workflow state. |
| `verified` | Root plus one to three native research/review/refutation agents. |
| `deep` | Verified work followed by up to two sequential Codex critics. |
| `critical` | Full evidence and side-effect gates plus a required external reviewer when policy demands it. |

Eight workflow templates are included:

- `review-to-issues`
- `issues-to-root-fix-pr-merge-cleanup`
- `cross-platform-contract`
- `ios-static-pbxproj`
- `localization-41`
- `ci-release-monitor`
- `browser-simulator-qa`
- `research-deliberation`

Current Codex builds expose plugin Skills through the built-in `/skills` menu.
No custom prompt installer or separate command layer is required.

## Deterministic helper

The plugin bundles a zero-runtime-dependency Node.js helper. It manages contracts, private run state, evidence, findings, bounded Git sentinels, leases, action tokens, reconciliation, doctor checks, and evaluations. It does not spawn agents, execute model-generated commands, assign severity, or perform side effects.

Run it directly from a checkout:

```bash
node plugins/better-workflows/scripts/dw.mjs doctor
node plugins/better-workflows/scripts/dw.mjs eval
```

## Security model

- State directories use mode `0700`; state files use `0600`.
- Agy review is limited to explicitly authorized, sanitized, non-confidential bundles.
- Agy argv transport is treated as exposed metadata and is not allowed for confidential workflows.
- Unknown provider outcomes require query reconciliation and are never blindly retried.
- The project assumes trusted local repositories and does not claim to sandbox malicious repository code.

## Development

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/dw.mjs eval
```

The runtime uses only Node.js standard-library modules.

## License

MIT. See [LICENSE](LICENSE). No upstream workflow runtime is vendored; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
