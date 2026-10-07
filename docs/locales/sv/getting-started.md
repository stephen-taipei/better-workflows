<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Kom igång

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · **Svenska** · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 omfattar Codex\, Gemini CLI och Qwen Code på macOS × Node 22\/24\. Kvalificering för Claude Code\, Linux och Windows skjuts upp till V5\.1\. GA kräver minst 30 naturliga canary\-dagar\, 20 kvalificerade starter i följd och tre separata arkiv\.

| [Översikt](../../../README.md) | [Detaljer](../../../docs/details/en.md) | **Snabbstart** | [Arbetsflöden](workflows.md) | [Arkitektur](architecture.md) | [Säkerhet](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Översikt i 41 lokaliserade utgåvor och officiella ingångar på webben](../../../docs/LANGUAGES.md)\. Kommandon och identifierare behåller sin kanoniska engelska form\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tagg `V5.0.rc1`\) är allmänt tillgänglig\. Dess versionsomfattning täcker endast Auto\, med Codex\, Gemini CLI och Qwen Code på macOS Node 22\/24\. Kvalificering för Linux och Windows skjuts upp till V5\.1\, liksom kvalificering för Claude Code\. GA `5.0.0` avvaktar tills minst 30 naturliga canary\-dagar\, 20 kvalificerade starter i följd och tre separata arkiv har registrerats\.

## Krav

- Node\.js 22\.14 eller senare för det medföljande `sbw`\-hjälpprogrammet\.
- Ett betrott lokalt arkiv\. Better Workflows gör inte anspråk på att isolera skadlig kod i arkivet i en sandbox\.

Rotkatalogen för v4\-tillstånd är oberoende av agentplattform\: `SBW_STATE_ROOT` har företräde när den är angiven\, därefter används `XDG_STATE_HOME/better-workflows` och annars `~/.better-workflows`\. Standardplatsen ligger inte längre under `CODEX_HOME`\. För att fortsätta använda ett befintligt v3\-tillstånd för Codex utan att flytta det anger du uttryckligen `SBW_STATE_ROOT` till exakt den befintliga katalogen `<CODEX_HOME>/sbw` innan du anropar `sbw`\.

V5\.0 GA \(`5.0.0`\) avvaktar fortfarande\. Installationskommandona nedan gäller den allmänt tillgängliga V5\.0 RC1 \(`5.0.0-rc.1`\, tagg `V5.0.rc1`\)\.

## Installera

### Codex — rekommenderad referens

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

Öppna en ny Codex\-uppgift efter installationen så att dess färdighetskatalog uppdateras\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI kopierar tillägget\. Starta om sessionen efter installationen\; använd `gemini extensions update better-workflows` för att uppdatera det senare\.

Tilläggets kontext hittar bryggan utifrån sökvägen till sin egen inlästa källkod\, inte utifrån projektets arbetskatalog\. För en vanlig användarspecifik installation är motsvarande manuella kontroll\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

För ett länkat eller arbetsytespecifikt tillägg använder du exakt den rotkatalog för tillägget som agentplattformen visar\. Ersätt den inte med en arbetskopia med ett liknande namn\.

### Qwen Code

Lås utgåvan till en bestämd version innan du installerar den lokala kopian av tillägget\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code kopierar också tillägget\, så starta om sessionen efter installationen och använd `qwen extensions update better-workflows` för senare uppdateringar\.

För en vanlig användarspecifik installation är motsvarande manuella kontroll av bryggan\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Samma krav på exakt rotkatalog gäller för länkade eller arbetsytespecifika installationer\.

## Använd Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Varje ingångsval bevarar det begärda Goal\-målet\. Ett orelaterat aktivt Goal\-mål måste uttryckligen redigeras eller rensas\; det ersätts aldrig obemärkt\.

## Förhandsgranska rutten

Ögonblicksbilden av tillgängliga funktioner använder endast läsoperationer och utlöser varken leverantörsinloggning eller en semantisk modellkontroll\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

För en överlämning som går att granska registrerar och använder du en privat verifierbar post för engångsbruk\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Posterna löper ut efter 24 timmar\, och användningen avvisas av säkerhetsskäl vid återanvändning eller avvikelser i arbetsyta\, omfattning\, Profiles\, katalog\, tillgängliga funktioner eller insticksprogramspaket\.

## Verifiera installationen

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Innan du ändrar ett kodarkiv

Auto börjar med en förhandskontroll av arbetsytan som endast läser\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Uppgifter som inte använder Git och uppgifter med enbart läsåtkomst skapar ingen worktree\. En Git\-uppgift som gör ändringar måste skapa eller återanvända en `TaskWorkspaceLeaseV1` som tillhör uppgiften\. Om källarbetskopian innehåller ändringar som inte har checkats in stoppas processen före varje stash\, kopiering\, commit eller skapande av en worktree\. Frikopplad HEAD eller ett saknat mål kräver ett uttryckligt integrationsmål\. Skyddade mål eller fjärrmål överförs till styrd leverans via PR\.

Om Codex eller en annan agentplattform redan har skapat den aktuella uppgiftens rena worktree registrerar du den innan du redigerar\, i stället för att skapa en nästlad worktree\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Registrering kräver en separat uppgiftsgren enligt `codex/*` vid den oförändrade basrevisionen\, samma gemensamma Git\-katalog och en ren källarbetskopia\. Better Workflows använder worktree men bevarar grenen och sökvägen som tillhör agentplattformen vid städning\. För ett skyddat mål kör du först arbetsflödet för verifieringsunderlag och binder sedan dess exakta verifierbara poster för PR\-sammanslagning och fjärrsynkronisering med `workspace reconcile --run-id <run-id>`\.

Nästa steg\: [välj rätt arbetsflöde](workflows.md) eller bläddra i [CLI\-referensen](cli-reference.md)\.
