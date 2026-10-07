<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Početak rada

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · **Hrvatski** · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 pokriva Codex\, Gemini CLI i Qwen Code na sustavu macOS × Node 22\/24\. Kvalifikacija za Claude Code\, Linux i Windows odgođena je za V5\.1\. GA zahtijeva najmanje 30 prirodnih dana canary testiranja\, 20 uzastopnih kvalificiranih pokretanja i tri zasebna repozitorija\.

| [Pregled](../../../README.md) | [Detalji](../../../docs/details/en.md) | **Brzi početak** | [Radni tijekovi](workflows.md) | [Arhitektura](architecture.md) | [Sigurnost](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Pregled u 41 lokaliziranoj verziji i službene pristupne točke na webu](../../../docs/LANGUAGES.md)\. Naredbe i identifikatori zadržavaju kanonski oblik na engleskom\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) javno je dostupan\. Opseg ovog izdanja pokriva samo Auto\, uz Codex\, Gemini CLI i Qwen Code na macOS\-u uz Node 22\/24\. Kvalifikacija za Linux i Windows odgođena je za V5\.1\, kao i kvalifikacija za Claude Code\. GA `5.0.0` ostaje na čekanju dok se ne zabilježi najmanje 30 prirodnih canary dana\, 20 uzastopnih prihvatljivih pokretanja i tri različita repozitorija\.

## Preduvjeti

- Node\.js 22\.14 ili noviji za priloženi `sbw` pomoćni alat\.
- Pouzdani lokalni repozitorij\. Better Workflows ne tvrdi da izolira u sandboxu zlonamjerni kod repozitorija\.

Korijenski direktorij stanja u v4 neovisan je o platformi agenta\: prednost ima `SBW_STATE_ROOT` ako je postavljen\, zatim `XDG_STATE_HOME/better-workflows`\, a inače `~/.better-workflows`\. Prema zadanim postavkama više nije unutar `CODEX_HOME`\. Za nastavak korištenja postojećeg stanja v3 za Codex bez premještanja izričito postavi `SBW_STATE_ROOT` na točno taj direktorij `<CODEX_HOME>/sbw` prije pozivanja `sbw`\.

V5\.0 GA \(`5.0.0`\) i dalje je na čekanju\. Naredbe za instalaciju u nastavku odnose se na javno dostupan V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\)\.

## Instalacija

### Codex — preporučena referenca

```bash
# Install the publicly available V5.0.rc1 release candidate.
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
node plugins/better-workflows/scripts/sbw.mjs version --json
node plugins/better-workflows/scripts/sbw.mjs update status --json
# Before the first check, status is unknown. Choose one update mode; manual is
# the default. off disables network access even for an explicit check, while an
# explicit check can query manual or automatic mode without the 24-hour throttle.
node plugins/better-workflows/scripts/sbw.mjs update configure --mode off
node plugins/better-workflows/scripts/sbw.mjs update configure --mode manual
node plugins/better-workflows/scripts/sbw.mjs update configure --mode automatic
node plugins/better-workflows/scripts/sbw.mjs update check --json
# automatic is opt-in, interactive-only, best effort, and at most once/24h;
# success and failure both consume the slot. Automatic checks are skipped in CI,
# --json, and non-interactive paths. It never auto-installs; only fixed public
# metadata is used.
```

Nakon instalacije otvori novi Codex zadatak kako bi se osvježio njegov katalog vještina\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI kopira proširenje\. Ponovno pokreni sesiju nakon instalacije\; za kasnije ažuriranje koristi `gemini extensions update better-workflows`\.

Kontekst proširenja pronalazi most prema putanji vlastitog učitanog izvornog koda\, a ne prema radnom direktoriju tvojeg projekta\. Za standardnu instalaciju na razini korisnika ekvivalentna ručna provjera glasi\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Za povezano proširenje ili proširenje ograničeno na radni prostor koristi točno onaj korijenski direktorij proširenja koji prikazuje platforma agenta\. Nemoj ga zamijeniti radnom kopijom sličnog naziva\.

### Qwen Code

Zaključaj verziju izdanja prije instaliranja lokalne kopije proširenja\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code također kopira proširenje\, pa ponovno pokreni sesiju nakon instalacije i za kasnija ažuriranja koristi `qwen extensions update better-workflows`\.

Za standardnu instalaciju na razini korisnika ekvivalentna ručna provjera mosta glasi\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Isto pravilo o točnom korijenskom direktoriju vrijedi za povezane instalacije ili instalacije ograničene na radni prostor\.

## Koristite Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Svaka ulazna točka čuva zatraženi cilj Goal\. Nepovezani aktivni cilj Goal mora se izričito urediti ili očistiti\; nikada se ne zamjenjuje prešutno\.

## Pregledaj rutu unaprijed

Snimka mogućnosti služi samo za čitanje i ne pokreće prijavu kod pružatelja ni semantičku provjeru modela\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Za primopredaju koja se može pregledati zabilježi i iskoristi jedan privatan\, jednokratan\, provjerljiv zapis\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Zapisi istječu nakon 24 sata\, a njihova se uporaba iz sigurnosnih razloga odbija pri ponovnoj uporabi ili odstupanjima u radnom prostoru\, opsegu\, postavkama Profiles\, katalogu\, mogućnostima ili paketu dodatka\.

## Provjeri instalaciju

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Prije izmjene repozitorija

Auto počinje prethodnom provjerom radnog prostora koja samo čita\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Zadaci koji ne koriste Git i zadaci samo za čitanje ne stvaraju worktree\. Git zadatak koji mijenja stanje mora stvoriti ili ponovno upotrijebiti `TaskWorkspaceLeaseV1` koji pripada zadatku\. Ako radni direktorij izvora sadrži promjene koje još nisu zabilježene u commitu\, postupak se zaustavlja prije bilo kakve operacije stash\, kopiranja\, operacije commit ili stvaranja radnog stabla worktree\. Odvojeni HEAD ili nedostajuće odredište zahtijevaju izričito odredište integracije\. Zaštićena ili udaljena odredišta prebacuju se na isporuku putem PR\-a pod pravilima upravljanja\.

Ako Codex ili druga platforma agenta već ima stvoren čisti worktree za trenutačni zadatak\, registriraj ga prije uređivanja umjesto stvaranja ugniježđenog worktree radnog stabla\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Registracija zahtijeva zasebnu granu zadatka oblika `codex/*` na nepromijenjenoj osnovnoj reviziji\, isti zajednički Git direktorij i čistu radnu kopiju izvora\. Better Workflows koristi worktree\, ali tijekom čišćenja čuva granu i putanju koje pripadaju platformi agenta\. Za zaštićeno odredište prvo pokreni radni tijek za dokaze\, a zatim njegove točno određene provjerljive zapise o spajanju PR\-a i udaljenoj sinkronizaciji poveži naredbom `workspace reconcile --run-id <run-id>`\.

Sljedeće\: [odaberite odgovarajući tijek rada](workflows.md) ili pregledajte [CLI referencu](cli-reference.md)\.
