<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Security policy

**English** · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Contributing](contributing.md) · [Code of conduct](conduct.md) · **Security** · [Governance](governance.md) · [Support](support.md)

[41\-locale localized overview and official web entry points](../../../docs/LANGUAGES.md)\. This normative security policy remains canonical in English\.

If the only proposed evidence source contains private history or sensitive operational material that cannot be sanitized\, do not harvest or transmit it\. Record only a redacted `REJECTED_WITH_EVIDENCE` rationale\.

## Supported versions

| Version | Support |
| --- | --- |
| Latest published release and immutable Codex build | Supported |
| Older immutable cache versions | Rollback targets\; fixes are not backported unless explicitly announced |
| Unreleased forks or modified cache contents | Not supported |

## Report a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Do not open a public issue for a suspected vulnerability\.

Include\:

- affected version and plugin build\;
- environment and Node\.js version\;
- minimal reproduction steps\;
- expected and observed security boundary\;
- impact and any known workaround\;
- whether the report contains confidential material\.

Do not include live credentials\, signing keys\, provider tokens\, raw private prompts\, or third\-party personal data\.

## Response

The maintainer will acknowledge a usable report\, validate its scope\, and coordinate remediation and disclosure\. No fixed response\-time SLA is promised\. Unknown or unreconciled outcomes remain fail\-closed\.

## Security boundaries

Better Workflows assumes a trusted local repository\, host\, and executable toolchain\. Node\'s Permission Model is defense in depth and is not an OS sandbox for malicious code\. See the complete [security guide](security-guide.md)\.
