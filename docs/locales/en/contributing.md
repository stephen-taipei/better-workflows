<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Contributing

**English** · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Thank you for helping improve Better Workflows\.

[README](../../../README.md) · **Contributing** · [Code of conduct](conduct.md) · [Security](security.md) · [Governance](governance.md) · [Support](support.md)

[41\-locale localized overview and official web entry points](../../../docs/LANGUAGES.md)\. This normative contribution policy remains canonical in English\.

## Before you start

- Use an issue or discussion first for a new public contract\, a change to Auto\'s public behavior\, a security boundary\, or a large architectural change\.
- Keep one pull request focused on one outcome\.
- Never commit credentials\, private prompts\, raw conversation history\, host signing keys\, provider receipts\, or signed attestations\.
- Report vulnerabilities privately as described in [SECURITY\.md](security.md)\.

## Development setup

Requirements\:

- Node\.js 24 or newer\;
- no third\-party runtime dependency\;
- a clean branch based on the current target branch\.

Run the complete local baseline\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Change rules

1. Preserve Root\-owned mutation and fail\-closed side\-effect boundaries\.
2. When Auto\'s public behavior changes\, update its template and skill\, entrypoint catalog\, CLI\, tests\, and all affected documentation together\.
3. Reject unknown CLI options and unknown schema fields\.
4. Keep private runtime state outside the repository\.
5. Add negative tests for every new safety gate\.
6. Do not mutate an existing immutable plugin\-cache version\. A changed bundle requires a new build version and exact source\/cache digest verification\.

For README\-only organization\, keep the root page scannable and place detailed contracts in the matching file under [`docs/guide/`](../../../docs/guide/)\.

## Pull request checklist

- [ ] Scope and non\-goals are explicit\.
- [ ] Behavior and safety boundaries are documented\.
- [ ] Focused tests cover success and failure paths\.
- [ ] The full test suite and `sbw eval` pass\.
- [ ] `git diff --check` passes\.
- [ ] Version\/cache changes follow immutable publication rules when applicable\.
- [ ] No secrets\, private state\, or external receipts are included\.

Small reviewable commits are preferred\. Do not combine unrelated cleanup with a behavior change\.
