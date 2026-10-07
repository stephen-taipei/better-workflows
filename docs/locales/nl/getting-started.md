<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Aan de slag

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · **Nederlands** · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 ondersteunt Codex\, Gemini CLI en Qwen Code op macOS × Node 22\/24\. Kwalificatie voor Claude Code\, Linux en Windows is uitgesteld naar V5\.1\. GA vereist ten minste 30 natuurlijke canary\-dagen\, 20 opeenvolgende in aanmerking komende starts en drie verschillende repositories\.

| [Overzicht](../../../README.md) | [Details](../../../docs/details/en.md) | **Snel aan de slag** | [Workflows](workflows.md) | [Architectuur](architecture.md) | [Beveiliging](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Overzicht in 41 gelokaliseerde versies en officiële toegangspunten op het web](../../../docs/LANGUAGES.md)\. Opdrachten en identificatoren behouden hun canonieke Engelse vorm\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) is openbaar beschikbaar\. De release\-scope heeft uitsluitend betrekking op Auto\, met Codex\, Gemini CLI en Qwen Code op macOS Node 22\/24\. Kwalificatie voor Linux en Windows is uitgesteld naar V5\.1\, evenals kwalificatie voor Claude Code\. GA `5.0.0` blijft in afwachting totdat ten minste 30 natuurlijke canary\-dagen\, 20 opeenvolgende in aanmerking komende starts en drie afzonderlijke repositories zijn geregistreerd\.

## Vereisten

- Node\.js 22\.14 of nieuwer voor de meegeleverde `sbw`\-helper\.
- Een vertrouwde lokale repository\. Better Workflows claimt niet schadelijke repositorycode te sandboxen\.

De hoofdmap voor statusgegevens in v4 is onafhankelijk van het agentplatform\: `SBW_STATE_ROOT` heeft voorrang als deze is ingesteld\, daarna `XDG_STATE_HOME/better-workflows` en anders `~/.better-workflows`\. De standaardlocatie staat niet langer onder `CODEX_HOME`\. Om bestaande v3\-statusgegevens van Codex te blijven gebruiken zonder ze te verplaatsen\, stel je `SBW_STATE_ROOT` expliciet in op precies die map `<CODEX_HOME>/sbw` voordat je `sbw` aanroept\.

V5\.0 GA \(`5.0.0`\) blijft in afwachting\. De onderstaande installatieopdrachten richten zich op de openbaar beschikbare V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\)\.

## Installeren

### Codex — aanbevolen referentieomgeving

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

Open na de installatie een nieuwe Codex\-taak\, zodat de vaardighedencatalogus van die taak wordt vernieuwd\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI kopieert de extensie\. Start de sessie na de installatie opnieuw\; gebruik `gemini extensions update better-workflows` om de extensie later bij te werken\.

De extensiecontext bepaalt de locatie van de brug aan de hand van het eigen bronpad van waaruit de context is geladen\, niet aan de hand van de werkmap van je project\. Bij een standaardinstallatie binnen het bereik van één gebruiker is de equivalente handmatige controle\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Gebruik voor een gekoppelde extensie of een extensie binnen het bereik van de werkruimte de exacte hoofdmap van de extensie die het agentplatform toont\. Vervang deze niet door een checkout met een vergelijkbare naam\.

### Qwen Code

Zet de release vast voordat je de lokale kopie van de extensie installeert\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code kopieert de extensie ook\. Start daarom de sessie na de installatie opnieuw en gebruik `qwen extensions update better-workflows` voor latere updates\.

Bij een standaardinstallatie binnen het bereik van één gebruiker is de equivalente handmatige controle van de brug\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Dezelfde regel voor de exacte hoofdmap geldt voor gekoppelde installaties en installaties binnen het bereik van de werkruimte\.

## Gebruik Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Elk startpunt behoudt het gevraagde Goal\. Een niet\-gerelateerd actief Goal moet expliciet worden bewerkt of gewist\; het wordt nooit stilzwijgend vervangen\.

## De route vooraf bekijken

De momentopname van de mogelijkheden is alleen\-lezen en activeert geen aanmelding bij een provider of semantische modelprobe\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Leg voor een overdracht die kan worden beoordeeld één verifieerbaar record vast dat privé is en maar één keer kan worden gebruikt\, en gebruik het vervolgens\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Records verlopen na 24 uur\. Bij hergebruik of afwijkingen in de werkruimte\, reikwijdte\, Profiles\, catalogus\, mogelijkheden of plug\-inbundel wordt de handeling geweigerd\; bij onzekerheid mag niet worden doorgegaan\.

## De installatie verifiëren

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Voordat je een repository wijzigt

Auto begint met een alleen\-lezen voorcontrole van de werkruimte\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Taken buiten Git en alleen\-lezen taken maken geen werkboom aan\. Een Git\-taak die wijzigingen aanbrengt\, moet een `TaskWorkspaceLeaseV1` in eigendom van de taak aanmaken of hergebruiken\. Als de werkmap van de broncode wijzigingen bevat die nog niet zijn gecommit\, stopt het proces vóór elke stash\, kopieeractie\, commit of aanmaak van een werkboom\. Een losgekoppelde HEAD of een ontbrekend doel vereist een expliciet integratiedoel\. Beschermde doelen of doelen op een remote worden overgezet naar een proces voor oplevering via PR dat onder governanceregels valt\.

Als Codex of een ander agentplatform de schone werkboom voor de huidige taak al heeft aangemaakt\, registreer die dan vóór het bewerken in plaats van een geneste werkboom aan te maken\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Registratie vereist een afzonderlijke `codex/*`\-taakbranch op de ongewijzigde basis\, dezelfde gemeenschappelijke Git\-map en een schone checkout van de bron\. Better Workflows gebruikt de werkboom\, maar behoudt tijdens het opruimen de branch en het pad die eigendom zijn van het agentplatform\. Voer voor een beschermd doel eerst de bewijsworkflow uit\. Koppel daarna met `workspace reconcile --run-id <run-id>` de exacte verifieerbare records van die workflow voor het samenvoegen van de PR en het synchroniseren met de remote\.

Volgende\: [kies de juiste workflow](workflows.md) of blader door de [CLI\-referentie](cli-reference.md)\.
