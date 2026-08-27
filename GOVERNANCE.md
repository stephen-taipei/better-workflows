# Governance

| [README](README.md) | [Contributing](CONTRIBUTING.md) | [Code of conduct](CODE_OF_CONDUCT.md) | [Security](SECURITY.md) | **Governance** | [Support](SUPPORT.md) |
| :---: | :---: | :---: | :---: | :---: | :---: |

[41-locale localized overview and official web entry points](docs/LANGUAGES.md). This normative governance policy remains canonical in English.

Better Workflows is maintainer-led.

## Decision model

- The maintainer accepts or rejects project-level design and release changes.
- Evidence, reproducible tests, safety boundaries, compatibility, and
  maintenance cost are considered before popularity or majority vote.
- Public contract and security-boundary changes require explicit review.
- A rejected proposal may be reconsidered when new evidence changes the
  trade-off.

## Workflow authority

Within a Better Workflows run, Root is the only mutation and risk-acceptance
authority. Models, critics, recipes, and Graph View remain advisory or
validation surfaces. This runtime rule does not grant repository ownership or
override GitHub permissions.

## Releases

Plugin cache builds are immutable. A release candidate must pass the applicable
tests, evaluation, freshness, evidence, protected-branch, and source/cache
reconciliation gates before publication.

## Changes to governance

Governance changes are reviewed as public-contract changes and must be recorded
in repository history.
