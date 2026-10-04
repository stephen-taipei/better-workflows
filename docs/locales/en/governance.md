<!-- Generated from GOVERNANCE.md; source-sha256: 1639c4634b05d69d4512a56cd48a9554ef5530423cc72b7d1f20387b22c9ce04; edit docs/rc1-catalogs/policies/*.json. -->
# Governance

**English** · [繁體中文（台灣）](../zh-Hant-TW/governance.md)

[README](../../../README.md) · [Contributing](contributing.md) · [Code of conduct](conduct.md) · [Security](security.md) · **Governance** · [Support](support.md)

[RC1 planned public routes cover en and zh\-Hant\-TW\; the 41\-locale source catalog is private](../../../docs/LANGUAGES.md)\. This normative governance policy remains canonical in English\.

Better Workflows is maintainer\-led\.

## Decision model

- The maintainer accepts or rejects project\-level design and release changes\.
- Evidence\, reproducible tests\, safety boundaries\, compatibility\, and maintenance cost are considered before popularity or majority vote\.
- Public contract and security\-boundary changes require explicit review\.
- A rejected proposal may be reconsidered when new evidence changes the trade\-off\.

## Workflow authority

Within a Better Workflows run\, Root is the only mutation and risk\-acceptance authority\. This runtime rule does not grant repository ownership or override GitHub permissions\.

## Releases

V5\.1 development starts from the public RC1 baseline in isolated feature branches\. Feature pull requests target protected `dev`\; the maintainer coordinates the final release pull request from `dev` to `main`\. Independent review\, fresh required checks and provider reconciliation precede merge\. Development permission does not establish activation\, pilot or GA\.

Plugin cache builds are immutable\. A release candidate must pass the applicable tests\, evaluation\, freshness\, evidence\, protected\-branch\, and source\/cache reconciliation gates before publication\.

## Changes to governance

Governance changes are reviewed as public\-contract changes and must be recorded in repository history\.
