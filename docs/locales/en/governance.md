<!-- Generated from GOVERNANCE.md; source-sha256: ca362c6f5cfa5809d5fe192865dcaffc4801124ebfda839929240b8efcedfafd; edit docs/rc1-catalogs/policies/*.json. -->
# Governance

**English** · [繁體中文](../zh-Hant/governance.md) · [繁體中文（台灣）](../zh-Hant-TW/governance.md) · [繁體中文（香港）](../zh-Hant-HK/governance.md) · [简体中文](../zh-Hans/governance.md) · [Tiếng Việt](../vi/governance.md) · [Українська](../uk/governance.md) · [Türkçe](../tr/governance.md) · [ไทย](../th/governance.md) · [Svenska](../sv/governance.md) · [Slovenčina](../sk/governance.md) · [Русский](../ru/governance.md) · [Română](../ro/governance.md) · [Português](../pt/governance.md) · [Português \(Brasil\)](../pt-BR/governance.md) · [Polski](../pl/governance.md) · [Nederlands](../nl/governance.md) · [Norsk bokmål](../nb/governance.md) · [မြန်မာ](../my/governance.md) · [Bahasa Melayu](../ms/governance.md) · [ລາວ](../lo/governance.md) · [한국어](../ko/governance.md) · [ខ្មែរ](../km/governance.md) · [日本語](../ja/governance.md) · [Italiano](../it/governance.md) · [Bahasa Indonesia](../id/governance.md) · [Magyar](../hu/governance.md) · [Hrvatski](../hr/governance.md) · [हिन्दी](../hi/governance.md) · [עברית](../he/governance.md) · [Français](../fr/governance.md) · [Filipino](../fil/governance.md) · [Suomi](../fi/governance.md) · [Español](../es/governance.md) · [Español \(México\)](../es-MX/governance.md) · [Ελληνικά](../el/governance.md) · [Deutsch](../de/governance.md) · [Dansk](../da/governance.md) · [Čeština](../cs/governance.md) · [Català](../ca/governance.md) · [العربية](../ar/governance.md)

[README](../../../README.md) · [Contributing](contributing.md) · [Code of conduct](conduct.md) · [Security](security.md) · **Governance** · [Support](support.md)

[41\-locale localized overview and official web entry points](../../../docs/LANGUAGES.md)\. This normative governance policy remains canonical in English\.

Better Workflows is maintainer\-led\.

## Decision model

- The maintainer accepts or rejects project\-level design and release changes\.
- Evidence\, reproducible tests\, safety boundaries\, compatibility\, and maintenance cost are considered before popularity or majority vote\.
- Public contract and security\-boundary changes require explicit review\.
- A rejected proposal may be reconsidered when new evidence changes the trade\-off\.

## Workflow authority

Within a Better Workflows run\, Root is the only mutation and risk\-acceptance authority\. This runtime rule does not grant repository ownership or override GitHub permissions\.

## Releases

Plugin cache builds are immutable\. A release candidate must pass the applicable tests\, evaluation\, freshness\, evidence\, protected\-branch\, and source\/cache reconciliation gates before publication\.

## Changes to governance

Governance changes are reviewed as public\-contract changes and must be recorded in repository history\.
