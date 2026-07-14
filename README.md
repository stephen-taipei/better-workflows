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

The canonical, shareable entry is:

```text
$better-workflows review this API contract in deep mode
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

Custom slash-command prompts are not shipped. Codex CLI 0.144.3 rejected the
deprecated custom-prompt command during a clean-session forward test, while the
`$better-workflows` skill loaded successfully. The skill is therefore the single
supported entry point.

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
