<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Kom godt i gang

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · **Dansk** · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 dækker Codex\, Gemini CLI og Qwen Code på macOS × Node 22\/24\. Kvalificering til Claude Code\, Linux og Windows er udskudt til V5\.1\. GA kræver mindst 30 naturlige canary\-dage\, 20 kvalificerede starter i træk og tre særskilte repositories\.

| [Oversigt](../../../README.md) | [Detaljer](../../../docs/details/en.md) | **Hurtigstart** | [Arbejdsgange](workflows.md) | [Arkitektur](architecture.md) | [Sikkerhed](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Oversigt i 41 lokaliserede udgaver og officielle indgange på nettet](../../../docs/LANGUAGES.md)\. Kommandoer og identifikatorer beholder deres kanoniske engelske form\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) er offentligt tilgængelig\. Dens udgivelsesomfang dækker kun Auto med Codex\, Gemini CLI og Qwen Code på macOS Node 22\/24\. Linux\- og Windows\-kvalificering er udskudt til V5\.1\, ligesom Claude Code\-kvalificering\. GA `5.0.0` afventer\, indtil mindst 30 naturlige canary\-dage\, 20 på hinanden følgende kvalificerede starter og tre adskilte lagre er registreret\.

## Krav

- Node\.js 22\.14 eller nyere til den medfølgende `sbw`\-hjælper\.
- Et betroet lokalt lager\. Better Workflows hævder ikke at isolere ondsindet lagerkode i en sandbox\.

Rodmappen for v4\-tilstand er uafhængig af agentplatformen\: `SBW_STATE_ROOT` har forrang\, når den er angivet\, derefter bruges `XDG_STATE_HOME/better-workflows`\, og ellers bruges `~/.better-workflows`\. Standardplaceringen ligger ikke længere under `CODEX_HOME`\. Hvis du vil fortsætte med at bruge en eksisterende v3\-tilstand for Codex uden at flytte den\, skal du udtrykkeligt sætte `SBW_STATE_ROOT` til netop den eksisterende mappe `<CODEX_HOME>/sbw`\, før du kalder `sbw`\.

V5\.0 GA \(`5.0.0`\) afventer stadig\. Installationskommandoerne nedenfor er rettet mod den offentligt tilgængelige V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\)\.

## Installation

### Codex — anbefalet reference

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

Åbn en ny Codex\-opgave efter installationen\, så dens færdighedskatalog opdateres\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI kopierer udvidelsen\. Genstart sessionen efter installationen\; brug `gemini extensions update better-workflows` til at opdatere den senere\.

Udvidelsens kontekst finder broen ud fra stien til sin egen indlæste kildekode\, ikke ud fra projektets arbejdsmappe\. For en almindelig brugerspecifik installation er den tilsvarende manuelle kontrol\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

For en linket udvidelse eller en udvidelse afgrænset til et arbejdsområde skal du bruge præcis den rodmappe for udvidelsen\, som agentplatformen viser\. Erstat den ikke med en arbejdskopi med et lignende navn\.

### Qwen Code

Fastlås udgivelsen til en bestemt version\, før du installerer den lokale kopi af udvidelsen\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code kopierer også udvidelsen\, så genstart sessionen efter installationen\, og brug `qwen extensions update better-workflows` til senere opdateringer\.

For en almindelig brugerspecifik installation er den tilsvarende manuelle kontrol af broen\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Det samme krav om den præcise rodmappe gælder for linkede installationer og installationer afgrænset til et arbejdsområde\.

## Brug Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Hvert indgangsvalg bevarer det ønskede Goal\-mål\. Et uvedkommende aktivt Goal\-mål skal udtrykkeligt redigeres eller ryddes\; det erstattes aldrig ubemærket\.

## Forhåndsvis ruten

Øjebliksbilledet af tilgængelige funktioner bruger kun læseoperationer og udløser hverken login hos udbyderen eller en semantisk modelkontrol\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

For en overdragelse\, der kan gennemgås\, skal du registrere og bruge én privat\, verificerbar post til engangsbrug\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Posterne udløber efter 24 timer\, og brug afvises af sikkerhedshensyn ved genbrug eller afvigelser i arbejdsområde\, omfang\, Profiles\, katalog\, tilgængelige funktioner eller pluginpakke\.

## Verificér installationen

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Før du ændrer et kodelager

Auto starter med en indledende kontrol af arbejdsområdet\, som kun læser\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Opgaver\, der ikke bruger Git\, og opgaver med ren læseadgang opretter ikke en worktree\. En Git\-opgave\, der foretager ændringer\, skal oprette eller genbruge en `TaskWorkspaceLeaseV1`\, som ejes af opgaven\. Hvis kildearbejdskopien indeholder ændringer\, der ikke er registreret i en commit\, stopper processen før enhver stash\, kopiering\, commit eller oprettelse af en worktree\. Frakoblet HEAD eller et manglende mål kræver et udtrykkeligt integrationsmål\. Beskyttede mål eller fjernmål overføres til styret levering via PR\.

Hvis Codex eller en anden agentplatform allerede har oprettet den aktuelle opgaves rene worktree\, skal du registrere den før redigering i stedet for at oprette en indlejret worktree\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Registrering kræver en særskilt opgavegren efter mønstret `codex/*` ved den uændrede basisrevision\, den samme fælles Git\-mappe og en ren kildearbejdskopi\. Better Workflows bruger worktree\, men bevarer grenen og stien\, som agentplatformen ejer\, under oprydning\. For et beskyttet mål skal du først køre arbejdsgangen for verifikationsgrundlag og derefter binde dens præcise verificerbare poster for PR\-fletning og fjernsynkronisering med `workspace reconcile --run-id <run-id>`\.

Næste\: [vælg det rigtige workflow](workflows.md) eller udforsk [CLI\-referencen](cli-reference.md)\.
