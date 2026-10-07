<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Začíname

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · **Slovenčina** · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 pokrýva Codex\, Gemini CLI a Qwen Code na macOS × Node 22\/24\. Kvalifikácia pre Claude Code\, Linux a Windows je odložená na V5\.1\. GA vyžaduje aspoň 30 prirodzených kanárikových dní\, 20 po sebe idúcich spôsobilých spustení a tri rôzne repozitáre\.

| [Prehľad](../../../README.md) | [Podrobnosti](../../../docs/details/en.md) | **Rýchly štart** | [Pracovné postupy](workflows.md) | [Architektúra](architecture.md) | [Bezpečnosť](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Prehľad v 41 lokalizovaných vydaniach a oficiálne webové vstupné body](../../../docs/LANGUAGES.md)\. Príkazy a identifikátory zostávajú v kanonickej anglickej podobe\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) je verejne dostupné\. Rozsah jeho vydania pokrýva iba Auto\, a to s Codex\, Gemini CLI a Qwen Code v systéme macOS Node 22\/24\. Kvalifikácia pre Linux a Windows je odložená na V5\.1\, rovnako ako kvalifikácia pre Claude Code\. GA `5.0.0` stále čaká na vydanie\, kým sa nezaznamená aspoň 30 kalendárnych canary dní\, 20 po sebe idúcich oprávnených spustení a tri rôzne repozitáre\.

## Požiadavky

- Node\.js 22\.14 alebo novší pre pribalený pomocný nástroj `sbw`\.
- Dôveryhodný lokálny repozitár\. Better Workflows netvrdí\, že izoluje v sandboxe škodlivý kód repozitára\.

Koreňový adresár stavu v4 je nezávislý od platformy agentov\: ak je nastavený `SBW_STATE_ROOT`\, má prednosť\; potom nasleduje `XDG_STATE_HOME/better-workflows`\, inak `~/.better-workflows`\. Predvolené umiestnenie už nie je pod `CODEX_HOME`\. Ak chcete ďalej používať existujúci stav v3 pre Codex bez jeho presúvania\, výslovne nastavte `SBW_STATE_ROOT` na presne ten adresár `<CODEX_HOME>/sbw` ešte pred spustením `sbw`\.

V5\.0 GA \(`5.0.0`\) stále čaká na vydanie\. Nižšie uvedené inštalačné príkazy cielia na verejne dostupné V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\)\.

## Inštalácia

### Codex — odporúčané referenčné prostredie

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

Po inštalácii otvorte novú úlohu Codex\, aby sa obnovil jej katalóg zručností\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI rozšírenie skopíruje\. Po inštalácii reštartujte reláciu\; na neskoršie obnovenie použite `gemini extensions update better-workflows`\.

Kontext rozšírenia určuje umiestnenie mosta podľa vlastnej cesty k zdroju\, z ktorého bol načítaný\, nie podľa pracovného adresára vášho projektu\. Pri štandardnej inštalácii v rámci používateľského účtu je ekvivalentná ručná kontrola nasledovná\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Pri rozšírení pripojenom cez odkaz alebo nainštalovanom v rozsahu pracovného priestoru použite presný koreňový adresár rozšírenia zobrazený platformou agenta\. Nenahrádzajte ho pracovnou kópiou s podobným názvom\.

### Qwen Code

Pred inštaláciou lokálnej kópie rozšírenia zafixujte vydanie\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code rozšírenie tiež kopíruje\, preto po inštalácii reštartujte reláciu a na neskoršie aktualizácie používajte `qwen extensions update better-workflows`\.

Pri štandardnej inštalácii v rámci používateľského účtu je ekvivalentná ručná kontrola mosta nasledovná\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Rovnaké pravidlo presného koreňového adresára platí aj pre inštalácie cez odkaz alebo v rozsahu pracovného priestoru\.

## Použite Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Každý vstupný bod zachováva požadovaný Goal\. Nesúvisiaci aktívny Goal sa musí výslovne upraviť alebo vymazať\; nikdy sa potichu nenahrádza\.

## Náhľad trasy

Snímka možností je iba na čítanie a nespúšťa prihlásenie k poskytovateľovi ani sémantickú sondu modelu\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Aby sa odovzdanie práce dalo posúdiť\, zaznamenajte a použite jeden súkromný overiteľný záznam určený na jednorazové použitie\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Platnosť záznamov vyprší po 24 hodinách\. Pri opätovnom použití alebo odchýlke v pracovnom priestore\, rozsahu\, Profiles\, katalógu\, možnostiach či balíku doplnku sa operácia odmietne\; pri neistote sa pokračovanie nepovolí\.

## Overenie inštalácie

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Pred zmenou repozitára

Auto začína predbežnou kontrolou pracovného priestoru iba na čítanie\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Úlohy nesúvisiace s Git a úlohy iba na čítanie nevytvárajú pracovný strom\. Úloha Git\, ktorá vykonáva zmeny\, musí vytvoriť alebo opätovne použiť `TaskWorkspaceLeaseV1` vo vlastníctve danej úlohy\. Ak pracovný adresár zdroja obsahuje zmeny\, ktoré ešte nie sú zaznamenané v commite\, postup sa zastaví pred akoukoľvek operáciou stash\, kopírovaním\, vytvorením commitu alebo vytvorením pracovného stromu\. Ak je HEAD odpojený alebo chýba cieľ\, treba výslovne určiť integračný cieľ\. Chránené alebo vzdialené ciele prechádzajú do procesu dodania cez PR\, ktorý podlieha pravidlám riadenia\.

Ak Codex alebo iná platforma agentov už vytvorila čistý pracovný strom pre aktuálnu úlohu\, zaregistrujte ho pred úpravami namiesto vytvárania vnoreného pracovného stromu\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Registrácia vyžaduje samostatnú vetvu úlohy `codex/*` na nezmenenej základni\, rovnaký spoločný adresár Git a čistú pracovnú kópiu zdroja\. Better Workflows používa pracovný strom\, ale pri čistení zachováva vetvu a cestu vo vlastníctve platformy agenta\. Pri chránenom cieli najprv spustite pracovný postup práce s dôkazmi a potom pomocou `workspace reconcile --run-id <run-id>` naviažte jeho presné overiteľné záznamy o zlúčení PR a vzdialenej synchronizácii\.

Ďalej\: [vyberte si ten správny workflow](workflows.md) alebo si prezrite [referenčnú príručku CLI](cli-reference.md)\.
