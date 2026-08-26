# Contributing

Thank you for helping improve Better Workflows.

| [README](README.md) | **Contributing** | [Code of conduct](CODE_OF_CONDUCT.md) | [Security](SECURITY.md) | [Governance](GOVERNANCE.md) | [Support](SUPPORT.md) |
| :---: | :---: | :---: | :---: | :---: | :---: |

[41-locale localized overview and official web entry points](docs/LANGUAGES.md). This normative contribution policy remains canonical in English.

## Before you start

- Use an issue or discussion first for a new public contract, workflow
  template, security boundary, or large architectural change.
- Keep one pull request focused on one outcome.
- Never commit credentials, private prompts, raw conversation history, host
  signing keys, provider receipts, or signed attestations.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development setup

Requirements:

- Node.js 24 or newer;
- no third-party runtime dependency;
- a clean branch based on the current target branch.

Run the complete local baseline:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Change rules

1. Preserve Root-owned mutation and fail-closed side-effect boundaries.
2. Update selectors, templates, catalog, skills, tests, and all affected
   documentation together.
3. Reject unknown CLI options and unknown schema fields.
4. Keep private runtime state outside the repository.
5. Add negative tests for every new safety gate.
6. Do not mutate an existing immutable plugin-cache version. A changed bundle
   requires a new build version and exact source/cache digest verification.

For README-only organization, keep the root page scannable and place detailed
contracts in the matching file under [`docs/guide/`](docs/guide/).

## Pull request checklist

- [ ] Scope and non-goals are explicit.
- [ ] Behavior and safety boundaries are documented.
- [ ] Focused tests cover success and failure paths.
- [ ] The full test suite and `sbw eval` pass.
- [ ] `git diff --check` passes.
- [ ] Version/cache changes follow immutable publication rules when applicable.
- [ ] No secrets, private state, or external receipts are included.

Small reviewable commits are preferred. Do not combine unrelated cleanup with a
behavior change.
