# Contributing

Thank you for helping improve Better Workflows.

| [README](README.md) | **Contributing** | [Code of conduct](CODE_OF_CONDUCT.md) | [Security](SECURITY.md) | [Governance](GOVERNANCE.md) | [Support](SUPPORT.md) |
| :---: | :---: | :---: | :---: | :---: | :---: |

[41-locale localized overview and official web entry points](docs/LANGUAGES.md). This normative contribution policy remains canonical in English.

## Before you start

- Use an issue or discussion first for a new public contract, a change to
  Auto's public behavior, a security boundary, or a large architectural change.
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
npm test --prefix packages/bw-core
git diff --check
```

V5 is frozen on the [`frozen/v5`](https://github.com/stephen-taipei/better-workflows/tree/frozen/v5) branch; its baseline (`npm test --prefix plugins/better-workflows`, `sbw eval`) runs there, not on `main`.

## Change rules

1. Core stays fail-closed: anything it cannot read is treated as not counting or as needing a person, never as allowed.
2. Every new gate or check names, in the pull request, the user-visible failure it prevents. If it cannot, it is not added.
3. Add a negative test for every new safety gate.
4. Reject unknown policy fields and unknown CLI options.
5. Keep the kernel under 3,000 lines and no source file over 600 lines.
6. Do not extend shell parsing to recognise new command forms; a form Core cannot read stays unrecognised.
7. Keep runtime state in `.git/better-workflows/`, never in the working tree.

## Pull request checklist

- [ ] Scope and non-goals are explicit.
- [ ] Behavior and safety boundaries are documented.
- [ ] Focused tests cover success and failure paths.
- [ ] `npm test --prefix packages/bw-core` passes.
- [ ] `git diff --check` passes.
- [ ] No secrets, private state, or external receipts are included.

Small reviewable commits are preferred. Do not combine unrelated cleanup with a
behavior change.
