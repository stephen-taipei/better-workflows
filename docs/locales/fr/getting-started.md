<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Premiers pas

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · **Français** · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 prend en charge Codex\, Gemini CLI et Qwen Code sur macOS × Node 22\/24\. La qualification de Claude Code\, Linux et Windows est reportée à la V5\.1\. La GA nécessite au moins 30 jours calendaires de canary\, 20 démarrages éligibles consécutifs et trois dépôts distincts\.

| [Vue d’ensemble](../../../README.md) | [Détails](../../../docs/details/en.md) | **Démarrage rapide** | [Flux de travail](workflows.md) | [Architecture](architecture.md) | [Sécurité](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Vue d’ensemble en 41 éditions localisées et points d’accès web officiels](../../../docs/LANGUAGES.md)\. Les commandes et les identifiants conservent leur forme canonique en anglais\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) est disponible publiquement\. Son périmètre de publication ne couvre qu’Auto\, avec Codex\, Gemini CLI et Qwen Code sur macOS Node 22\/24\. La qualification pour Linux et Windows est reportée à V5\.1\, tout comme celle de Claude Code\. La GA `5.0.0` reste en attente jusqu’à ce qu’au moins 30 jours canaris naturels\, 20 démarrages éligibles consécutifs et trois dépôts distincts soient enregistrés\.

## Prérequis

- Node\.js 22\.14 ou supérieur pour l’utilitaire intégré `sbw`\.
- Un dépôt local de confiance\. Better Workflows ne prétend pas isoler dans un bac à sable le code de dépôt malveillant\.

Le répertoire racine de l’état v4 est indépendant de la plateforme \: `SBW_STATE_ROOT` est prioritaire s’il est défini\, puis `XDG_STATE_HOME/better-workflows`\, sinon `~/.better-workflows`\. L’emplacement par défaut ne se trouve plus sous `CODEX_HOME`\. Pour continuer à utiliser un état Codex v3 existant sans le déplacer\, définissez explicitement `SBW_STATE_ROOT` sur ce répertoire exact `<CODEX_HOME>/sbw` avant d’appeler `sbw`\.

La GA V5\.0 \(`5.0.0`\) reste en attente\. Les commandes d’installation ci\-dessous ciblent la version V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) disponible publiquement\.

## Installation

### Codex — référence recommandée

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

Après l’installation\, ouvrez une nouvelle tâche Codex pour actualiser son catalogue de compétences\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI copie l’extension\. Redémarrez la session après l’installation\, puis utilisez `gemini extensions update better-workflows` pour les mises à jour ultérieures\.

Le contexte de l’extension localise la passerelle à partir du chemin de son propre code source chargé\, et non du répertoire de travail de votre projet\. Pour une installation standard limitée à l’utilisateur\, la vérification manuelle équivalente est la suivante \:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Pour une extension liée ou limitée à l’espace de travail\, utilisez exactement le répertoire racine de l’extension indiqué par la plateforme\. Ne le remplacez pas par une copie de travail au nom similaire\.

### Qwen Code

Verrouillez la version publiée avant d’installer la copie locale de l’extension \:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code copie également l’extension \: redémarrez donc la session après l’installation et utilisez `qwen extensions update better-workflows` pour les mises à jour ultérieures\.

Pour une installation standard limitée à l’utilisateur\, la vérification manuelle équivalente de la passerelle est la suivante \:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

La même exigence de répertoire racine exact s’applique aux installations liées ou limitées à l’espace de travail\.

## Utiliser Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Chaque point d’entrée conserve le Goal demandé\. Un Goal actif sans rapport doit être modifié ou effacé explicitement \; il n’est jamais remplacé silencieusement\.

## Prévisualiser le routage

L’instantané des capacités est en lecture seule et ne déclenche ni connexion à un fournisseur ni sonde sémantique d’un modèle \:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Pour une transmission du travail qui puisse être examinée\, enregistrez puis utilisez un enregistrement vérifiable privé\, à usage unique \:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Les enregistrements expirent après 24 heures\. Leur utilisation est refusée par précaution en cas de réutilisation ou de divergence de l’espace de travail\, du périmètre\, des Profiles\, du catalogue\, des capacités ou du paquet du plugin\.

## Vérifier l’installation

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Avant de modifier un dépôt

Auto commence par un contrôle préalable de l’espace de travail en lecture seule \:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Les tâches sans Git et les tâches en lecture seule ne créent pas de worktree\. Une tâche Git qui effectue des modifications doit créer ou réutiliser un `TaskWorkspaceLeaseV1` appartenant à cette tâche\. Si la copie source contient des modifications non validées par un commit\, le processus s’arrête avant toute mise en réserve \(stash\)\, copie\, création de commit ou de worktree\. Un HEAD détaché ou une cible manquante exige une cible d’intégration explicite\. Les cibles protégées ou distantes passent par une livraison via PR soumise aux règles de gouvernance\.

Si Codex ou une autre plateforme a déjà créé un worktree propre pour la tâche en cours\, enregistrez\-le avant toute modification au lieu de créer un worktree imbriqué \:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

L’enregistrement exige une branche de tâche distincte `codex/*` à la révision de base inchangée\, le même répertoire commun Git et une copie de travail source propre\. Better Workflows utilise le worktree\, mais conserve la branche et le chemin appartenant à la plateforme lors du nettoyage\. Pour une cible protégée\, exécutez d’abord le flux de travail de preuves\, puis associez ses enregistrements exacts de fusion de PR et de synchronisation distante avec `workspace reconcile --run-id <run-id>`\.

Étape suivante \: [choisir le bon workflow](workflows.md) ou parcourir la [référence de la CLI](cli-reference.md)\.
