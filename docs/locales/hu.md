<div align="center">

# Better Workflows

A Better Workflows V5.0 RC1 nyilvánosan elérhető: ingyenes, nyílt forráskódú Auto munkafolyamat AI engineering QA-hoz és szállításhoz, naprakész bizonyítékokkal, felülvizsgálati kapukkal és szolgáltatói egyeztetéssel.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · **Magyar** · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Dokumentáció megnyitása](https://betterworkflows.dev/hu/docs/) · [GitHub megnyitása](https://github.com/stephen-taipei/better-workflows) · [Támogatás USDT-vel (TRC20)](https://betterworkflows.dev/#sponsor)

</div>

A V5.0 RC1 a Codex, a Gemini CLI és a Qwen Code eszközöket fedi le macOS × Node 22/24 környezetben. A Claude Code, a Linux és a Windows minősítése a V5.1-re halasztódik. A GA legalább 30 naptári canary-napot, 20 egymást követő megfelelő indítást és három különböző repositoryt igényel.

## Vigye el az agent munkáját<br>a bizonyítható befejezésig.

A V5.0 RC1 nyilvánosan elérhető. Az Auto ellenőrzi a célt, a hatókört, az adattárat és a kockázatot, majd célzott ellenőrzéseket vagy egy bizonyíték-munkafolyamatot választ. A Git-módosítások feladathoz rendelt worktree-t használnak; a szállításhoz jóváhagyás és ellenőrzött külső eredmény szükséges.

## Négy egyértelmű határ a szándéktól a befejezésig.

Határozza meg a szerződést, ellenőrizze a forrást és a bizonyítékot, egyeztesse a külső hatásokat, és csak ismert végállapotnál jelentsen befejezést.

- **01 · `TaskContract`** — A V5.0 RC1 nyilvánosan elérhető. Az Auto ellenőrzi a célt, a hatókört, az adattárat és a kockázatot, majd célzott ellenőrzéseket vagy egy bizonyíték-munkafolyamatot választ. A Git-módosítások feladathoz rendelt worktree-t használnak; a szállításhoz jóváhagyás és ellenőrzött külső eredmény szükséges.
- **02 · `evidence`** — A Better Workflows V5.0 RC1 nyilvánosan elérhető: ingyenes, nyílt forráskódú Auto munkafolyamat AI engineering QA-hoz és szállításhoz, naprakész bizonyítékokkal, felülvizsgálati kapukkal és szolgáltatói egyeztetéssel.
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
- [Bizonyítékmozi](https://betterworkflows.dev/hu/docs/evidence-cinema/)

### Dokumentáció megnyitása · `hu`

Ezen a referenciaoldalon az áttekintés lokalizált; az interaktív tartalom fordítása még nem teljes.

- **01 · Négy egyértelmű határ a szándéktól a befejezésig.** — Határozza meg a szerződést, ellenőrizze a forrást és a bizonyítékot, egyeztesse a külső hatásokat, és csak ismert végállapotnál jelentsen befejezést.
- **02 · Az architektúratérképtől a gyakorlati használati esetekig.** — A V5.0 RC1 nyilvánosan elérhető. Az Auto ellenőrzi a célt, a hatókört, az adattárat és a kockázatot, majd célzott ellenőrzéseket vagy egy bizonyíték-munkafolyamatot választ. A Git-módosítások feladathoz rendelt worktree-t használnak; a szállításhoz jóváhagyás és ellenőrzött külső eredmény szükséges.
- **03 · Gyors kezdés** — A Better Workflows V5.0 RC1 nyilvánosan elérhető: ingyenes, nyílt forráskódú Auto munkafolyamat AI engineering QA-hoz és szállításhoz, naprakész bizonyítékokkal, felülvizsgálati kapukkal és szolgáltatói egyeztetéssel.

- [`Négy egyértelmű határ a szándéktól a befejezésig.`](https://betterworkflows.dev/docs/reference/hu/index.html) · `hu`
- [`Gyors kezdés`](https://betterworkflows.dev/docs/reference/hu/preview.html) · `hu`
- [`Az architektúratérképtől a gyakorlati használati esetekig.`](https://betterworkflows.dev/docs/reference/hu/use-cases/index.html) · `hu`
- [`Gyors kezdés — Az architektúratérképtől a gyakorlati használati esetekig.`](https://betterworkflows.dev/docs/reference/hu/use-cases/preview.html) · `hu`
- [`Bizonyítékmozi`](https://betterworkflows.dev/docs/reference/hu/evidence-cinema/index.html) · `hu`

- [Dokumentáció megnyitása · `hu`](../details/hu.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### Dokumentáció megnyitása · `en`



### Dokumentáció megnyitása · `hu`

- [Biztonsági szabályzat](hu/security.md) · `hu`
- [Közreműködés](hu/contributing.md) · `hu`
- [Irányítás](hu/governance.md) · `hu`
- [Magatartási kódex](hu/conduct.md) · `hu`
- [Harmadik felekre vonatkozó közlemények](hu/notices.md) · `hu`
- [A README minőségi terve](hu/readme-quality.md) · `hu`
- [Szerkesztői színrendszer](hu/color-system.md) · `hu`
- [Architektúra](hu/architecture.md) · `hu`
- [Biztonság](hu/security-guide.md) · `hu`
- [CLI-referencia](hu/cli-reference.md) · `hu`
- [Első lépések](hu/getting-started.md) · `hu`
- [Munkafolyamatok](hu/workflows.md) · `hu`
- [Segítség](hu/support.md) · `hu`

## Segíts a Better Workflows fenntartásában.

Az egyszeri támogatás a nyílt forráskód, a dokumentáció, a 41 nyelvű lokalizáció és a webtárhely fenntartását segíti. Nem jár tagsággal, ütemtervi vagy támogatási elsőbbséggel.

[Támogatás USDT-vel (TRC20)](https://betterworkflows.dev/#sponsor)

---

Egy parancs lefutása nem bizonyítja a befejezést; egy újra ellenőrizhető eredmény igen.
