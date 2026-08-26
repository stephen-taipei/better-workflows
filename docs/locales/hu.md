<div align="center">

# Better Workflows

Nyílt forráskódú, goal-first vezérlősík agent-munkafolyamatokhoz naprakész bizonyítékokkal, ellenőrzési kapukkal és szolgáltatói egyeztetéssel.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · **Magyar** · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Dokumentáció megnyitása](https://betterworkflows.dev/hu/docs/) · [GitHub megnyitása](https://github.com/stephen-taipei/better-workflows) · [Támogatás Ko-fi-n](https://ko-fi.com/betterworkflows)

</div>

## Vigye el az agent munkáját<br>a bizonyítható befejezésig.

A Better Workflows rögzíti a célt, a hatókört és a jogosultságot, majd minden döntést naprakész, újra ellenőrizhető bizonyítékhoz és egyeztetett külső eredményhez köt.

## Négy egyértelmű határ a szándéktól a befejezésig.

Határozza meg a szerződést, ellenőrizze a forrást és a bizonyítékot, egyeztesse a külső hatásokat, és csak ismert végállapotnál jelentsen befejezést.

- **01 · `TaskContract`** — A Better Workflows rögzíti a célt, a hatókört és a jogosultságot, majd minden döntést naprakész, újra ellenőrizhető bizonyítékhoz és egyeztetett külső eredményhez köt.
- **02 · `evidence`** — Nyílt forráskódú, goal-first vezérlősík agent-munkafolyamatokhoz naprakész bizonyítékokkal, ellenőrzési kapukkal és szolgáltatói egyeztetéssel.
- **03 · `reconciliation`** — Határozza meg a szerződést, ellenőrizze a forrást és a bizonyítékot, egyeztesse a külső hatásokat, és csak ismert végállapotnál jelentsen befejezést.
- **04 · `terminal state`** — Egy parancs lefutása nem bizonyítja a befejezést; egy újra ellenőrizhető eredmény igen.

## Gyors kezdés

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## Az architektúratérképtől a gyakorlati használati esetekig.

- [Négy egyértelmű határ a szándéktól a befejezésig.](https://betterworkflows.dev/hu/docs/)
- [Gyors kezdés](https://betterworkflows.dev/hu/docs/quick/)
- [Az architektúratérképtől a gyakorlati használati esetekig.](https://betterworkflows.dev/hu/docs/use-cases/)
- [Gyors kezdés — Az architektúratérképtől a gyakorlati használati esetekig.](https://betterworkflows.dev/hu/docs/use-cases/quick/)
- [Evidence Cinema](https://betterworkflows.dev/hu/docs/evidence-cinema/)


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
- [GitHub megnyitása](https://github.com/stephen-taipei/better-workflows)

## Segíts a Better Workflows fenntartásában.

Az egyszeri támogatás a nyílt forráskód, a dokumentáció, 41 lokalizált változat és a webtárhely fenntartását segíti. Nem jár tagsággal, ütemtervi vagy támogatási elsőbbséggel.

[Támogatás Ko-fi-n](https://ko-fi.com/betterworkflows)

---

Egy parancs lefutása nem bizonyítja a befejezést; egy újra ellenőrizhető eredmény igen.
