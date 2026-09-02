<div align="center">

# Better Workflows

AI-agenten tilpasser verifiseringen til risikoen og fullfører arbeidet trygt i et isolert miljø. Enkle endringer går raskt; viktig arbeid bruker evidence gates; Git-endringer bruker som standard en egen worktree.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · **Norsk bokmål** · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Utforsk dokumentasjonen](https://betterworkflows.dev/nb/docs/) · [Åpne GitHub](https://github.com/stephen-taipei/better-workflows) · [Støtt på Ko-fi](https://ko-fi.com/betterworkflows)

</div>

## Før agentarbeidet<br>helt fram til en etterprøvbar avslutning.

Better Workflows låser mål, scope og authority og knytter hver beslutning til oppdatert, revaliderbar evidens og et avstemt eksternt resultat.

## Fire tydelige grenser fra hensikt til fullføring.

Definer kontrakten, verifiser kilde og evidens, avstem eksterne effekter, og erklær først fullført når sluttilstanden er kjent.

- **01 · `TaskContract`** — Better Workflows låser mål, scope og authority og knytter hver beslutning til oppdatert, revaliderbar evidens og et avstemt eksternt resultat.
- **02 · `evidence`** — AI-agenten tilpasser verifiseringen til risikoen og fullfører arbeidet trygt i et isolert miljø. Enkle endringer går raskt; viktig arbeid bruker evidence gates; Git-endringer bruker som standard en egen worktree.
- **03 · `reconciliation`** — Definer kontrakten, verifiser kilde og evidens, avstem eksterne effekter, og erklær først fullført når sluttilstanden er kjent.
- **04 · `terminal state`** — At en kommando kjørte, beviser ikke fullføring; et revaliderbart resultat gjør det.

## Kom raskt i gang

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## Gå fra arkitekturkartet til praktiske brukstilfeller.

- [Fire tydelige grenser fra hensikt til fullføring.](https://betterworkflows.dev/nb/docs/)
- [Kom raskt i gang](https://betterworkflows.dev/nb/docs/quick/)
- [Gå fra arkitekturkartet til praktiske brukstilfeller.](https://betterworkflows.dev/nb/docs/use-cases/)
- [Kom raskt i gang — Gå fra arkitekturkartet til praktiske brukstilfeller.](https://betterworkflows.dev/nb/docs/use-cases/quick/)
- [Evidence Cinema](https://betterworkflows.dev/nb/docs/evidence-cinema/)


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
- [Åpne GitHub](https://github.com/stephen-taipei/better-workflows)

## Hjelp oss å vedlikeholde Better Workflows.

Et engangsbidrag støtter vedlikehold av åpen kildekode, dokumentasjon, 41 lokaliserte versjoner og webhosting. Det gir ikke medlemskap eller prioritet i veikart eller brukerstøtte.

[Støtt på Ko-fi](https://ko-fi.com/betterworkflows)

---

At en kommando kjørte, beviser ikke fullføring; et revaliderbart resultat gjør det.
