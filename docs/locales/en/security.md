<!-- Generated from SECURITY.md; source-sha256: a16157ba5c7878255a8c6b83a10edfb8d157f03df3a2b1a542a5e2f34ee0b808; edit docs/rc1-catalogs/policies/*.json. -->
# Security policy

**English** · [繁體中文（台灣）](../zh-Hant-TW/security.md)

[README](../../../README.md) · [Contributing](contributing.md) · [Code of conduct](conduct.md) · **Security** · [Governance](governance.md) · [Support](support.md)

[RC1 planned public routes cover en and zh\-Hant\-TW\; the 41\-locale source catalog is private](../../../docs/LANGUAGES.md)\. This normative security policy remains canonical in English\.

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
