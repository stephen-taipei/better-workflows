<div align="center">

<img src="docs/html/assets/better-workflows-mark.svg" alt="Better Workflows" width="80">

# Better Workflows

**Your AI coding agent cannot finish on a stale green test, and cannot repeat or stack side effects whose result it never saw.**

[![Core](https://img.shields.io/badge/V6_Core-alpha-B45309?style=flat-square)](packages/bw-core)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A522.14.0-3C873A?style=flat-square)](packages/bw-core/package.json)
[![Core license](https://img.shields.io/badge/Core_license-Apache--2.0-64748B?style=flat-square)](packages/bw-core/LICENSE)

**English** · [繁體中文（台灣）](docs/README.zh-TW.md)

</div>

## What it stops

```text
agent  runs npm test                  → passes
agent  edits src/sum.ts               → breaks it
agent  "Done. Tests pass."
bw     ✗ Stop blocked. test: last result was for an older tree; files changed since then.

agent  git push origin main           → times out after the push landed
agent  git push origin main           (retry)
bw     ✗ Denied. git-push: the same action already succeeded at this commit.
```

The agent is held to the files as they are now, and to what the provider actually did. Permissions come only from a policy file the agent cannot edit, never from prompt text.

See both stories run in a few seconds, without Claude:

```bash
npm install -g @better-workflows/core@alpha
node "$(npm root -g)/@better-workflows/core/examples/stale-green/demo.mjs"
```

## Install for Claude Code

```bash
claude plugin marketplace add stephen-taipei/better-workflows                 # once per machine
claude plugin install better-workflows-core@better-workflows --scope local    # in your repository
bw init                                                                       # writes .better-workflows/policy.json
```

Then ask Claude Code for a change and tell it not to run the tests: it is sent back when it tries to finish. [Getting started](packages/bw-core/docs/getting-started.md) covers policies, unknown results and limits. Core is alpha (`6.0.0-alpha.1`), Apache-2.0, and has no runtime dependencies. Direction and milestones are in the [roadmap](ROADMAP.md).


## Other languages

| 🌐 | 🌐 | 🌐 | 🌐 |
| --- | --- | --- | --- |
| [English](docs/locales/en.md) | [繁體中文](docs/locales/zh-Hant.md) | [繁體中文（台灣）](docs/locales/zh-Hant-TW.md) | [繁體中文（香港）](docs/locales/zh-Hant-HK.md) |
| [简体中文](docs/locales/zh-Hans.md) | [Tiếng Việt](docs/locales/vi.md) | [Українська](docs/locales/uk.md) | [Türkçe](docs/locales/tr.md) |
| [ไทย](docs/locales/th.md) | [Svenska](docs/locales/sv.md) | [Slovenčina](docs/locales/sk.md) | [Русский](docs/locales/ru.md) |
| [Română](docs/locales/ro.md) | [Português](docs/locales/pt.md) | [Português (Brasil)](docs/locales/pt-BR.md) | [Polski](docs/locales/pl.md) |
| [Nederlands](docs/locales/nl.md) | [Norsk bokmål](docs/locales/nb.md) | [မြန်မာ](docs/locales/my.md) | [Bahasa Melayu](docs/locales/ms.md) |
| [ລາວ](docs/locales/lo.md) | [한국어](docs/locales/ko.md) | [ខ្មែរ](docs/locales/km.md) | [日本語](docs/locales/ja.md) |
| [Italiano](docs/locales/it.md) | [Bahasa Indonesia](docs/locales/id.md) | [Magyar](docs/locales/hu.md) | [Hrvatski](docs/locales/hr.md) |
| [हिन्दी](docs/locales/hi.md) | [עברית](docs/locales/he.md) | [Français](docs/locales/fr.md) | [Filipino](docs/locales/fil.md) |
| [Suomi](docs/locales/fi.md) | [Español](docs/locales/es.md) | [Español (México)](docs/locales/es-MX.md) | [Ελληνικά](docs/locales/el.md) |
| [Deutsch](docs/locales/de.md) | [Dansk](docs/locales/da.md) | [Čeština](docs/locales/cs.md) | [Català](docs/locales/ca.md) |
| [العربية](docs/locales/ar.md) |  |  |  |

Each page is a short V6 introduction generated from one catalog. English and Traditional Chinese (Taiwan) are reviewed by hand; the others are machine-translated, and the English README is authoritative. See the [localization policy](docs/LOCALIZATION.md).

## Contribute and get help

```bash
npm test --prefix packages/bw-core
```

[Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Governance](GOVERNANCE.md) · [Support](SUPPORT.md) · [Security policy](SECURITY.md)

One-time [USDT (TRC20) support](https://betterworkflows.dev/#sponsor) helps maintain the open-source code, documentation, 41-language localization, and website hosting. It does not provide membership, roadmap priority, or support priority.<br>**USDT · TRON (TRC20)** · `TGuMUi1d8MoBQcuFrGJZnu4JrbaeP3wy9a`<br><img src="docs/html/assets/sponsor-usdt-trc20.jpeg" alt="USDT (TRC20) QR: TGuMUi1d8MoBQcuFrGJZnu4JrbaeP3wy9a" width="160">

## V5

V5 is frozen at [RC1](https://github.com/stephen-taipei/better-workflows/releases/tag/V5.0.rc1) and V5.1 has stopped (2026-10-09). Its source, guides and localized references are on the [`frozen/v5`](https://github.com/stephen-taipei/better-workflows/tree/frozen/v5) branch, unchanged, for existing users.

Maintained by [stephen-taipei](https://github.com/stephen-taipei). V6 Core in `packages/bw-core` is Apache-2.0 under its own [LICENSE](packages/bw-core/LICENSE); the rest of this repository is AGPL-3.0-only ([LICENSE](LICENSE)). See [COPYRIGHT](COPYRIGHT) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
