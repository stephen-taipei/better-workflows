<div align="center">

# Better Workflows

AI-agenten anpassar verifieringen efter risken och slutför arbetet säkert i en isolerad miljö. Enkla ändringar går snabbt; viktigt arbete använder evidence gates; Git-ändringar använder som standard en egen worktree.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · **Svenska** · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Utforska dokumentationen](https://betterworkflows.dev/sv/docs/) · [Öppna GitHub](https://github.com/stephen-taipei/better-workflows) · [Stöd via Ko-fi](https://ko-fi.com/betterworkflows)

</div>

## För agentarbetet<br>hela vägen till ett bevisbart slut.

Better Workflows låser mål, scope och authority och knyter varje beslut till aktuella, återvaliderbara bevis och ett avstämt externt resultat.

## Fyra tydliga gränser från avsikt till slutförande.

Definiera kontraktet, verifiera källa och bevis, stäm av externa effekter och markera arbetet som slutfört först när sluttillståndet är känt.

- **01 · `TaskContract`** — Better Workflows låser mål, scope och authority och knyter varje beslut till aktuella, återvaliderbara bevis och ett avstämt externt resultat.
- **02 · `evidence`** — AI-agenten anpassar verifieringen efter risken och slutför arbetet säkert i en isolerad miljö. Enkla ändringar går snabbt; viktigt arbete använder evidence gates; Git-ändringar använder som standard en egen worktree.
- **03 · `reconciliation`** — Definiera kontraktet, verifiera källa och bevis, stäm av externa effekter och markera arbetet som slutfört först när sluttillståndet är känt.
- **04 · `terminal state`** — Att ett kommando kördes bevisar inte slutförande; ett återvaliderbart resultat gör det.

## Snabbstart

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## Gå från arkitekturkartan till praktiska användningsfall.

- [Fyra tydliga gränser från avsikt till slutförande.](https://betterworkflows.dev/sv/docs/)
- [Snabbstart](https://betterworkflows.dev/sv/docs/quick/)
- [Gå från arkitekturkartan till praktiska användningsfall.](https://betterworkflows.dev/sv/docs/use-cases/)
- [Snabbstart — Gå från arkitekturkartan till praktiska användningsfall.](https://betterworkflows.dev/sv/docs/use-cases/quick/)
- [Evidence Cinema](https://betterworkflows.dev/sv/docs/evidence-cinema/)


- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### `GUIDES · en`

- [`getting-started`](../guide/getting-started.md) · `en`
- [`workflows`](../guide/workflows.md) · `en`
- [`architecture`](../guide/architecture.md) · `en`
- [`security`](../guide/security.md) · `en`
- [`cli-reference`](../guide/cli-reference.md) · `en`
- [`readme-quality`](../guide/readme-quality.md) · `en`

### `POLICIES · en`

- [`CODE_OF_CONDUCT`](../../CODE_OF_CONDUCT.md) · `en`
- [`CONTRIBUTING`](../../CONTRIBUTING.md) · `en`
- [`GOVERNANCE`](../../GOVERNANCE.md) · `en`
- [`SECURITY`](../../SECURITY.md) · `en`
- [`SUPPORT`](../../SUPPORT.md) · `en`
- [`THIRD_PARTY_NOTICES`](../../THIRD_PARTY_NOTICES.md) · `en`
- [`ANSIBLE`](../../deploy/ansible/README.md) · `en`

### `RUNTIME SOURCE · en`

- [`plugins/better-workflows/skills/`](../../plugins/better-workflows/skills/)
- [`evidence-cinema/imagegen-manifest`](../html/evidence-cinema/assets/imagegen-manifest.md)
- [`use-cases/color-system`](../html/use-cases/assets/color-system.md)
- [`use-cases/imagegen-manifest`](../html/use-cases/assets/imagegen-manifest.md)
- [Öppna GitHub](https://github.com/stephen-taipei/better-workflows)

## Hjälp till att underhålla Better Workflows.

Ett engångsbidrag stöder underhåll av öppen källkod, dokumentation, 41 lokaliserade versioner och webbhosting. Det ger inget medlemskap eller prioritet i roadmap eller support.

[Stöd via Ko-fi](https://ko-fi.com/betterworkflows)

---

Att ett kommando kördes bevisar inte slutförande; ett återvaliderbart resultat gör det.
