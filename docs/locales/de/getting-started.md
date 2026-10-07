<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Erste Schritte

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · **Deutsch** · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 deckt Codex\, Gemini CLI und Qwen Code unter macOS × Node 22\/24 ab\. Die Qualifizierung für Claude Code\, Linux und Windows ist auf V5\.1 verschoben\. GA erfordert mindestens 30 Canary\-Kalendertage\, 20 aufeinanderfolgende berechtigte Starts und drei verschiedene Repositories\.

| [Überblick](../../../README.md) | [Details](../../../docs/details/en.md) | **Schnellstart** | [Arbeitsabläufe](workflows.md) | [Architektur](architecture.md) | [Sicherheit](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Überblick in 41 Sprach\- und Regionalversionen und offizielle Web\-Einstiegspunkte](../../../docs/LANGUAGES.md)\. Befehle und Bezeichner behalten ihre kanonische englische Form\.

V5\.0 RC1 \(`5.0.0-rc.1`\, Tag `V5.0.rc1`\) ist öffentlich verfügbar\. Der Release\-Umfang deckt ausschließlich Auto ab\, mit Codex\, Gemini CLI und Qwen Code unter macOS Node 22\/24\. Die Qualifizierung für Linux und Windows ist auf V5\.1 verschoben\, ebenso wie die Qualifizierung für Claude Code\. GA `5.0.0` bleibt ausstehend\, bis mindestens 30 natürliche Canary\-Tage\, 20 aufeinanderfolgende berechtigte Starts und drei verschiedene Repositories erfasst wurden\.

## Voraussetzungen

- Node\.js 22\.14 oder neuer für das gebündelte `sbw`\-Hilfsprogramm\.
- Ein vertrauenswürdiges lokales Repository\. Better Workflows erhebt keinen Anspruch darauf\, bösartigen Repository\-Code in einer Sandbox auszuführen\.

Das Stammverzeichnis für den Zustand in v4 ist plattformunabhängig\: Wenn `SBW_STATE_ROOT` gesetzt ist\, hat es Vorrang\, danach folgt `XDG_STATE_HOME/better-workflows`\, andernfalls `~/.better-workflows`\. Standardmäßig liegt es nicht mehr unter `CODEX_HOME`\. Um einen vorhandenen Zustand von Codex v3 ohne Verschieben weiterzuverwenden\, setzen Sie `SBW_STATE_ROOT` ausdrücklich auf genau dieses Verzeichnis `<CODEX_HOME>/sbw`\, bevor Sie `sbw` aufrufen\.

V5\.0 GA \(`5.0.0`\) bleibt ausstehend\. Die folgenden Installationsbefehle zielen auf die öffentlich verfügbare Version V5\.0 RC1 \(`5.0.0-rc.1`\, Tag `V5.0.rc1`\) ab\.

## Installation

### Codex — empfohlene Referenz

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

Öffnen Sie nach der Installation eine neue Codex\-Aufgabe\, damit der Skill\-Katalog aktualisiert wird\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI kopiert die Erweiterung\. Starten Sie die Sitzung nach der Installation neu\; verwenden Sie `gemini extensions update better-workflows`\, um die Erweiterung später zu aktualisieren\.

Der Kontext der Erweiterung ermittelt den Speicherort der Brücke anhand des Quellpfads\, aus dem die Erweiterung selbst geladen wurde\, und nicht anhand des Arbeitsverzeichnisses Ihres Projekts\. Bei einer standardmäßigen benutzerbezogenen Installation lautet die entsprechende manuelle Prüfung\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Bei einer verknüpften oder auf den Arbeitsbereich beschränkten Erweiterung verwenden Sie genau das von der Plattform angezeigte Stammverzeichnis der Erweiterung\. Ersetzen Sie es nicht durch einen Checkout mit ähnlichem Namen\.

### Qwen Code

Fixieren Sie die Release\-Version\, bevor Sie die lokale Kopie der Erweiterung installieren\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Auch Qwen Code kopiert die Erweiterung\. Starten Sie daher die Sitzung nach der Installation neu und verwenden Sie `qwen extensions update better-workflows` für spätere Aktualisierungen\.

Bei einer standardmäßigen benutzerbezogenen Installation lautet die entsprechende manuelle Prüfung der Brücke\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Dieselbe Regel zur exakten Übereinstimmung des Stammverzeichnisses gilt für verknüpfte oder auf den Arbeitsbereich beschränkte Installationen\.

## Auto verwenden

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Jeder Einstieg bewahrt das angeforderte Goal\. Ein nicht damit zusammenhängendes aktives Goal muss ausdrücklich bearbeitet oder gelöscht werden\; es wird niemals stillschweigend ersetzt\.

## Die Route vorab anzeigen

Die Momentaufnahme der Fähigkeiten wird ausschließlich lesend ermittelt und löst weder eine Anmeldung beim Anbieter noch eine semantische Modellprüfung aus\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Für eine prüfbare Übergabe erfassen und verwenden Sie einen privaten\, nur einmal verwendbaren überprüfbaren Datensatz\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Überprüfbare Datensätze laufen nach 24 Stunden ab\. Ihre Verwendung wird verweigert\, wenn sie erneut verwendet werden oder sich Arbeitsbereich\, Geltungsbereich\, Profiles\, Katalog\, Fähigkeiten oder Plugin\-Paket gegenüber dem gebundenen Zustand verändern\.

## Die Installation überprüfen

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Vor einer Änderung am Repository

Auto beginnt mit einer rein lesenden Vorabprüfung des Arbeitsbereichs\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Aufgaben ohne Git und rein lesende Aufgaben erzeugen keinen Worktree\. Eine Git\-Aufgabe mit Änderungen muss ein aufgabeneigenes `TaskWorkspaceLeaseV1` erstellen oder wiederverwenden\. Wenn der Quellstand Änderungen enthält\, die noch nicht in einem Commit erfasst sind\, stoppt der Vorgang vor jeglichem Stash\, Kopieren\, Commit oder Erstellen eines Worktrees\. Ein von einem Branch gelöster HEAD oder ein fehlendes Ziel erfordert ein ausdrücklich angegebenes Integrationsziel\. Geschützte oder entfernte Ziele werden auf einen regelgebundenen Auslieferungsprozess per PR hochgestuft\.

Wenn Codex oder eine andere Plattform bereits einen sauberen Worktree für die aktuelle Aufgabe erstellt hat\, registrieren Sie ihn vor dem Bearbeiten\, statt einen verschachtelten Worktree zu erstellen\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Die Registrierung setzt einen separaten Aufgaben\-Branch `codex/*` auf der unveränderten Basisrevision\, dasselbe gemeinsame Git\-Verzeichnis und einen sauberen Quell\-Checkout voraus\. Better Workflows nutzt den Worktree\, erhält beim Aufräumen aber den Branch und den Pfad im Besitz der Plattform\. Führen Sie bei einem geschützten Ziel zuerst den Arbeitsablauf für Nachweise aus und binden Sie anschließend dessen exakte überprüfbare Datensätze zum PR\-Merge und zur Remote\-Synchronisierung mit `workspace reconcile --run-id <run-id>`\.

Weiter\: [wähle den passenden Workflow](workflows.md) oder durchsuche die [CLI\-Referenz](cli-reference.md)\.
