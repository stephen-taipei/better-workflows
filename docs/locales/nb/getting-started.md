<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Kom i gang

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · **Norsk bokmål** · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 dekker Codex\, Gemini CLI og Qwen Code på macOS × Node 22\/24\. Kvalifisering for Claude Code\, Linux og Windows er utsatt til V5\.1\. GA krever minst 30 naturlige canary\-dager\, 20 påfølgende kvalifiserte oppstarter og tre distinkte depoter\.

| [Oversikt](../../../README.md) | [Detaljer](../../../docs/details/en.md) | **Hurtigstart** | [Arbeidsflyter](workflows.md) | [Arkitektur](architecture.md) | [Sikkerhet](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Oversikt i 41 lokaliserte utgaver og offisielle innganger på nettet](../../../docs/LANGUAGES.md)\. Kommandoer og identifikatorer beholder sin kanoniske engelske form\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) er offentlig tilgjengelig\. Omfanget for denne utgivelsen dekker kun Auto\, med Codex\, Gemini CLI og Qwen Code på macOS Node 22\/24\. Kvalifisering for Linux og Windows er utsatt til V5\.1\, i likhet med kvalifisering for Claude Code\. GA `5.0.0` avventer inntil minst 30 naturlige canary\-dager\, 20 kvalifiserte oppstarter på rad og tre distinkte repositories er registrert\.

## Krav

- Node\.js 22\.14 eller nyere for den inkluderte `sbw`\-hjelperen\.
- Et pålitelig lokalt repository\. Better Workflows gjør ikke krav på å kjøre ondsinnet repositoriekode i sandkasse\.

Rotkatalogen for v4\-tilstand er uavhengig av agentplattformen\: `SBW_STATE_ROOT` har forrang når den er angitt\, deretter brukes `XDG_STATE_HOME/better-workflows`\, og ellers brukes `~/.better-workflows`\. Standardplasseringen ligger ikke lenger under `CODEX_HOME`\. Hvis du vil fortsette å bruke en eksisterende v3\-tilstand for Codex uten å flytte den\, må du uttrykkelig sette `SBW_STATE_ROOT` til akkurat den eksisterende katalogen `<CODEX_HOME>/sbw` før du kaller `sbw`\.

V5\.0 GA \(`5.0.0`\) avventer fortsatt\. Installasjonskommandoene nedenfor gjelder for den offentlig tilgjengelige V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\)\.

## Installer

### Codex — anbefalt referanse

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

Åpne en ny Codex\-oppgave etter installasjonen slik at ferdighetskatalogen oppdateres\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI kopierer utvidelsen\. Start økten på nytt etter installasjonen\; bruk `gemini extensions update better-workflows` for å oppdatere den senere\.

Utvidelsens kontekst finner broen ut fra stien til sin egen innlastede kildekode\, ikke ut fra prosjektets arbeidskatalog\. For en vanlig brukerspesifikk installasjon er den tilsvarende manuelle kontrollen\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

For en lenket utvidelse eller en utvidelse avgrenset til et arbeidsområde bruker du nøyaktig den rotkatalogen for utvidelsen som agentplattformen viser\. Ikke erstatt den med en arbeidskopi med et lignende navn\.

### Qwen Code

Lås utgivelsen til en bestemt versjon før du installerer den lokale kopien av utvidelsen\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code kopierer også utvidelsen\, så start økten på nytt etter installasjonen og bruk `qwen extensions update better-workflows` til senere oppdateringer\.

For en vanlig brukerspesifikk installasjon er den tilsvarende manuelle kontrollen av broen\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Det samme kravet om nøyaktig rotkatalog gjelder for lenkede installasjoner og installasjoner avgrenset til et arbeidsområde\.

## Bruk Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Hvert inngangsvalg bevarer det forespurte Goal\-målet\. Et uvedkommende aktivt Goal\-mål må uttrykkelig redigeres eller tømmes\; det erstattes aldri ubemerket\.

## Forhåndsvis ruten

Øyeblikksbildet av tilgjengelige funksjoner bruker bare leseoperasjoner og utløser verken innlogging hos leverandøren eller en semantisk modellkontroll\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

For en overlevering som kan gjennomgås\, registrerer og bruker du én privat\, verifiserbar post til engangsbruk\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Postene utløper etter 24 timer\, og bruk avvises av sikkerhetshensyn ved gjenbruk eller avvik i arbeidsområde\, omfang\, Profiles\, katalog\, tilgjengelige funksjoner eller programtilleggspakke\.

## Verifiser installasjonen

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Før du endrer et kodelager

Auto starter med en forhåndskontroll av arbeidsområdet som bare leser\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Oppgaver som ikke bruker Git\, og oppgaver med bare lesetilgang oppretter ingen worktree\. En Git\-oppgave som gjør endringer\, må opprette eller gjenbruke en `TaskWorkspaceLeaseV1` som eies av oppgaven\. Hvis kildearbeidskopien inneholder endringer som ikke er lagret i en commit\, stopper prosessen før enhver stash\, kopiering\, commit eller opprettelse av en worktree\. Frakoblet HEAD eller et manglende mål krever et uttrykkelig integrasjonsmål\. Beskyttede mål eller fjernmål overføres til styrt levering via PR\.

Hvis Codex eller en annen agentplattform allerede har opprettet den gjeldende oppgavens rene worktree\, registrerer du den før redigering i stedet for å opprette en nestet worktree\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Registrering krever en egen oppgavegren etter mønsteret `codex/*` ved den uendrede basisrevisjonen\, den samme felles Git\-katalogen og en ren kildearbeidskopi\. Better Workflows bruker worktree\, men bevarer grenen og stien som agentplattformen eier\, under opprydding\. For et beskyttet mål kjører du først arbeidsflyten for verifikasjonsgrunnlag og binder deretter dens nøyaktige verifiserbare poster for PR\-fletting og fjernsynkronisering med `workspace reconcile --run-id <run-id>`\.

Neste steg\: [velg riktig arbeidsflyt](workflows.md) eller utforsk [CLI\-referansen](cli-reference.md)\.
