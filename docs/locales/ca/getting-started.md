<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Primers passos

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · **Català** · [العربية](../ar/getting-started.md)

La versió V5\.0 RC1 cobreix Codex\, Gemini CLI i Qwen Code a macOS × Node 22\/24\. La qualificació de Claude Code\, Linux i Windows s\'ajorna a la versió V5\.1\. GA requereix almenys 30 dies naturals de canary\, 20 inicis aptes consecutius i tres repositoris diferents\.

| [Visió general](../../../README.md) | [Detalls](../../../docs/details/en.md) | **Inici ràpid** | [Fluxos de treball](workflows.md) | [Arquitectura](architecture.md) | [Seguretat](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Resum en 41 versions localitzades i punts d’accés web oficials](../../../docs/LANGUAGES.md)\. Les ordres i els identificadors mantenen la forma canònica en anglès\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) està disponible públicament\. El seu abast de llançament cobreix només Auto\, amb Codex\, Gemini CLI i Qwen Code a macOS Node 22\/24\. La qualificació per a Linux i Windows s’ajorna a V5\.1\, així com la qualificació de Claude Code\. GA `5.0.0` continua pendent fins que es registrin almenys 30 dies naturals de canary\, 20 inicis aptes consecutius i tres repositoris diferents\.

## Requisits

- Node\.js 22\.14 o posterior per a l’eina auxiliar `sbw` integrada\.
- Un repositori local de confiança\. Better Workflows no pretén aïllar en una sandbox el codi maliciós d’un repositori\.

El directori arrel de l’estat de v4 és independent de la plataforma d’agents\: `SBW_STATE_ROOT` té prioritat quan està definida\, després s’utilitza `XDG_STATE_HOME/better-workflows` i\, si no\, `~/.better-workflows`\. La ubicació predeterminada ja no és sota `CODEX_HOME`\. Per continuar fent servir un estat existent de v3 per a Codex sense moure’l\, estableix `SBW_STATE_ROOT` explícitament en aquell directori exacte `<CODEX_HOME>/sbw` abans d’invocar `sbw`\.

V5\.0 GA \(`5.0.0`\) continua pendent\. Les ordres d’instal·lació següents s’adrecen a la versió V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) disponible públicament\.

## Instal·lació

### Codex — referència recomanada

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

Obre una tasca nova de Codex després de la instal·lació perquè s’actualitzi el seu catàleg d’habilitats\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI copia l’extensió\. Reinicia la sessió després de la instal·lació\; fes servir `gemini extensions update better-workflows` per actualitzar\-la més endavant\.

El context de l’extensió resol la ubicació del pont a partir del camí del seu propi codi font carregat\, no del directori de treball del teu projecte\. Per a una instal·lació estàndard d’àmbit d’usuari\, la comprovació manual equivalent és\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Per a una extensió enllaçada o limitada a l’espai de treball\, fes servir el directori arrel exacte de l’extensió que mostra la plataforma d’agents\. No el substitueixis per una còpia de treball amb un nom semblant\.

### Qwen Code

Fixa el llançament a una versió concreta abans d’instal·lar la còpia local de l’extensió\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code també copia l’extensió\, així que reinicia la sessió després de la instal·lació i fes servir `qwen extensions update better-workflows` per a les actualitzacions posteriors\.

Per a una instal·lació estàndard d’àmbit d’usuari\, la comprovació manual equivalent del pont és\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

La mateixa regla sobre el directori arrel exacte s’aplica a les instal·lacions enllaçades o limitades a l’espai de treball\.

## Utilitza Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Cada entrada conserva el Goal sol·licitat\. Un Goal actiu que no hi estigui relacionat s’ha d’editar o buidar explícitament\; mai no se substitueix silenciosament\.

## Previsualitza la ruta

La instantània de capacitats és de només lectura i no activa l’inici de sessió amb el proveïdor ni una comprovació semàntica del model\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Per a un traspàs que es pugui revisar\, registra i utilitza un únic registre verificable privat i d’un sol ús\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Els registres caduquen després de 24 hores\, i se’n rebutja l’ús per seguretat si es reutilitzen o hi ha desviacions en l’espai de treball\, l’abast\, Profiles\, el catàleg\, les capacitats o el paquet del complement\.

## Verifica la instal·lació

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Abans de modificar un repositori

Auto comença amb una comprovació prèvia de l’espai de treball que només llegeix\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Les tasques que no fan servir Git i les de només lectura no creen cap worktree\. Una tasca de Git que faci canvis ha de crear o reutilitzar un `TaskWorkspaceLeaseV1` que pertanyi a la tasca\. Si el directori de treball del codi font conté canvis que encara no s’han registrat en un commit\, el procés s’atura abans de qualsevol stash\, còpia\, commit o creació de worktree\. Un HEAD deslligat o l’absència d’una destinació requereixen una destinació d’integració explícita\. Les destinacions protegides o remotes passen a un lliurament mitjançant PR subjecte a les regles de governança\.

Si Codex o una altra plataforma d’agents ja ha creat el worktree net de la tasca actual\, registra’l abans d’editar\, en lloc de crear un worktree imbricat\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

El registre requereix una branca de tasca separada amb el patró `codex/*` a la revisió de base sense canvis\, el mateix directori comú de Git i una còpia de treball neta de la font\. Better Workflows fa servir el worktree\, però durant la neteja conserva la branca i el camí que pertanyen a la plataforma d’agents\. Per a una destinació protegida\, executa primer el flux de treball d’evidències i després vincula els seus registres verificables exactes de fusió de PR i sincronització remota amb `workspace reconcile --run-id <run-id>`\.

Següent pas\: [tria el flux de treball adequat](workflows.md) o explora la [referència de la CLI](cli-reference.md)\.
