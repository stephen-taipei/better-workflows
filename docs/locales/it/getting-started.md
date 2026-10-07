<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Primi passi

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · **Italiano** · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 copre Codex\, Gemini CLI e Qwen Code su macOS × Node 22\/24\. La qualificazione per Claude Code\, Linux e Windows è posticipata a V5\.1\. GA richiede almeno 30 giorni canary naturali\, 20 avvii idonei consecutivi e tre repository distinti\.

| [Panoramica](../../../README.md) | [Dettagli](../../../docs/details/en.md) | **Avvio rapido** | [Flussi di lavoro](workflows.md) | [Architettura](architecture.md) | [Sicurezza](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Panoramica in 41 versioni localizzate e punti di accesso web ufficiali](../../../docs/LANGUAGES.md)\. I comandi e gli identificatori mantengono la forma canonica in inglese\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) è disponibile pubblicamente\. Il suo ambito di rilascio copre solo Auto\, con Codex\, Gemini CLI e Qwen Code su macOS Node 22\/24\. La qualificazione per Linux e Windows è rimandata a V5\.1\, così come la qualificazione per Claude Code\. GA `5.0.0` rimane in sospeso fino a quando non saranno registrati almeno 30 giorni canary naturali\, 20 avvii idonei consecutivi e tre repository distinti\.

## Requisiti

- Node\.js 22\.14 o versione successiva per l\'helper `sbw` incluso\.
- Un repository locale affidabile\. Better Workflows non dichiara di isolare in sandbox il codice dannoso del repository\.

La directory radice dello stato di v4 è indipendente dalla piattaforma\: `SBW_STATE_ROOT` ha la precedenza se impostata\, poi `XDG_STATE_HOME/better-workflows`\, altrimenti `~/.better-workflows`\. La posizione predefinita non è più sotto `CODEX_HOME`\. Per continuare a usare uno stato Codex v3 esistente senza spostarlo\, imposta esplicitamente `SBW_STATE_ROOT` su quella precisa directory `<CODEX_HOME>/sbw` prima di invocare `sbw`\.

V5\.0 GA \(`5.0.0`\) rimane in sospeso\. I comandi di installazione seguenti si riferiscono a V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\)\, disponibile pubblicamente\.

## Installazione

### Codex — riferimento consigliato

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

Dopo l\'installazione\, apri una nuova attività Codex per aggiornare il catalogo delle competenze\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI copia l\'estensione\. Riavvia la sessione dopo l\'installazione\; usa `gemini extensions update better-workflows` per aggiornarla in seguito\.

Il contesto dell\'estensione individua il ponte dal percorso da cui è stato caricato il codice sorgente dell\'estensione stessa\, non dalla directory di lavoro del tuo progetto\. Per un\'installazione standard in ambito utente\, la verifica manuale equivalente è\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Per un\'estensione collegata o con ambito limitato all\'area di lavoro\, usa l\'esatta directory radice dell\'estensione indicata dalla piattaforma\. Non sostituirla con un checkout dal nome simile\.

### Qwen Code

Fissa la versione del rilascio prima di installare la copia locale dell\'estensione\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Anche Qwen Code copia l\'estensione\: riavvia quindi la sessione dopo l\'installazione e usa `qwen extensions update better-workflows` per gli aggiornamenti successivi\.

Per un\'installazione standard in ambito utente\, la verifica manuale equivalente del ponte è\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

La stessa regola della directory radice esatta si applica alle installazioni collegate o limitate all\'area di lavoro\.

## Usa Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Ogni punto d\'ingresso conserva il Goal richiesto\. Un Goal attivo non pertinente deve essere modificato o cancellato esplicitamente\; non viene mai sostituito in modo silenzioso\.

## Visualizza l\'anteprima del percorso

L\'istantanea delle capacità è di sola lettura e non avvia né l\'accesso al fornitore né una verifica semantica del modello\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Per un passaggio di consegne che possa essere esaminato\, registra e utilizza una registrazione verificabile privata\, utilizzabile una sola volta\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Le registrazioni verificabili scadono dopo 24 ore e il loro utilizzo viene rifiutato in caso di riutilizzo o di divergenza nell\'area di lavoro\, nell\'ambito\, nei Profiles\, nel catalogo\, nelle capacità o nel pacchetto del plugin\.

## Verifica l\'installazione

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Prima di modificare un repository

Auto inizia con una verifica preliminare dell\'area di lavoro in sola lettura\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Le attività che non usano Git e quelle di sola lettura non creano un worktree\. Un\'attività Git che apporta modifiche deve creare o riutilizzare un `TaskWorkspaceLeaseV1` di sua proprietà\. Se lo stato del sorgente contiene modifiche non registrate in un commit\, il processo si arresta prima di qualsiasi stash\, copia\, commit o creazione di worktree\. Un HEAD scollegato da un branch o una destinazione mancante richiede una destinazione di integrazione esplicita\. Le destinazioni protette o remote passano a un processo di consegna tramite PR soggetto alle regole di governance\.

Se Codex o un\'altra piattaforma ha già creato un worktree pulito per l\'attività corrente\, registralo prima di apportare modifiche\, invece di creare un worktree annidato\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

La registrazione richiede un branch di attività distinto `codex/*` alla revisione di base invariata\, la stessa directory comune di Git e un checkout pulito del sorgente\. Better Workflows usa il worktree\, ma durante la pulizia preserva il branch e il percorso di proprietà della piattaforma\. Per una destinazione protetta\, esegui prima il flusso di lavoro delle evidenze\, poi associa le sue registrazioni verificabili esatte del merge della PR e della sincronizzazione remota con `workspace reconcile --run-id <run-id>`\.

Passo successivo\: [scegli il workflow più adatto](workflows.md) oppure consulta la [guida di riferimento della CLI](cli-reference.md)\.
