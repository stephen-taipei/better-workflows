<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Začínáme

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · **Čeština** · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 pokrývá Codex\, Gemini CLI a Qwen Code na macOS × Node 22\/24\. Kvalifikace pro Claude Code\, Linux a Windows je odložena na V5\.1\. GA vyžaduje alespoň 30 kalendářních kanárkových dní\, 20 po sobě jdoucích způsobilých spuštění a tři různé repozitáře\.

| [Přehled](../../../README.md) | [Podrobnosti](../../../docs/details/en.md) | **Rychlý start** | [Pracovní postupy](workflows.md) | [Architektura](architecture.md) | [Zabezpečení](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Přehled ve 41 lokalizovaných verzích a oficiální webové vstupní body](../../../docs/LANGUAGES.md)\. Příkazy a identifikátory zůstávají v kanonické anglické podobě\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) je veřejně k dispozici\. Rozsah jeho vydání pokrývá pouze Auto s Codex\, Gemini CLI a Qwen Code na macOS Node 22\/24\. Kvalifikace pro Linux a Windows je odložena na V5\.1\, stejně jako kvalifikace pro Claude Code\. Vydání GA `5.0.0` zůstává nevyřízeno\, dokud nebude zaznamenáno alespoň 30 přirozených kanárkových dnů\, 20 po sobě jdoucích způsobilých spuštění a tři různé repozitáře\.

## Požadavky

- Node\.js 22\.14 nebo novější pro přibaleného pomocníka `sbw`\.
- Důvěryhodný lokální repozitář\. Better Workflows netvrdí\, že izoluje v sandboxu škodlivý kód repozitáře\.

Kořenový adresář stavu v4 je nezávislý na platformě pro agenty\: pokud je nastaveno `SBW_STATE_ROOT`\, má přednost\, poté se použije `XDG_STATE_HOME/better-workflows`\, jinak `~/.better-workflows`\. Výchozí umístění už není pod `CODEX_HOME`\. Chceš\-li dál používat existující stav v3 pro Codex bez jeho přesunutí\, nastav `SBW_STATE_ROOT` výslovně na přesně tento adresář `<CODEX_HOME>/sbw` před voláním `sbw`\.

V5\.0 GA \(`5.0.0`\) zůstává nevyřízeno\. Níže uvedené instalační příkazy cílí na veřejně dostupnou verzi V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\)\.

## Instalace

### Codex — doporučené referenční prostředí

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

Po instalaci otevři v prostředí Codex nový úkol\, aby se obnovil jeho katalog dovedností\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI rozšíření kopíruje\. Po instalaci restartuj relaci\; k pozdější aktualizaci použij `gemini extensions update better-workflows`\.

Kontext rozšíření určuje umístění mostu z cesty ke svému vlastnímu načtenému zdrojovému kódu\, nikoli z pracovního adresáře tvého projektu\. Pro běžnou instalaci na úrovni uživatele vypadá odpovídající ruční kontrola takto\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

U rozšíření připojeného odkazem nebo omezeného na pracovní prostor použij přesný kořenový adresář rozšíření\, který uvádí platforma pro agenty\. Nenahrazuj jej podobně pojmenovanou pracovní kopií\.

### Qwen Code

Před instalací místní kopie rozšíření připni vydání ke konkrétní verzi\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code rozšíření také kopíruje\, proto po instalaci restartuj relaci a pro pozdější aktualizace používej `qwen extensions update better-workflows`\.

Pro běžnou instalaci na úrovni uživatele vypadá odpovídající ruční kontrola mostu takto\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Stejné pravidlo přesného kořenového adresáře platí pro instalace připojené odkazem nebo omezené na pracovní prostor\.

## Použijte Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Každý vstupní bod zachovává požadovaný cíl Goal\. Nesouvisející aktivní cíl Goal je nutné výslovně upravit nebo vymazat\; nikdy není potichu nahrazen\.

## Zobraz náhled trasy

Snímek schopností používá pouze operace čtení a nespouští přihlášení k poskytovateli ani sémantickou kontrolu modelu\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Pro předání\, které lze přezkoumat\, zaznamenej a použij jeden soukromý\, jednorázový\, ověřitelný záznam\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Platnost záznamů vyprší po 24 hodinách a jejich použití se z bezpečnostních důvodů odmítne při opětovném použití nebo odchylce v pracovním prostoru\, rozsahu\, nastavení Profiles\, katalogu\, schopnostech či balíčku doplňku\.

## Ověř instalaci

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Před změnou repozitáře

Auto začíná předběžnou kontrolou pracovního prostoru\, která pouze čte\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Úkoly mimo Git a úkoly pouze pro čtení nevytvářejí worktree\. Úkol Git provádějící změny musí vytvořit nebo znovu použít `TaskWorkspaceLeaseV1`\, který patří danému úkolu\. Pokud pracovní adresář zdroje obsahuje změny\, které ještě nejsou zaznamenány v commitu\, postup se zastaví před jakoukoli operací stash\, kopírováním\, operací commit nebo vytvořením worktree\. Odpojený HEAD nebo chybějící cíl vyžaduje výslovně určený integrační cíl\. Chráněné nebo vzdálené cíle přecházejí na řízené dodání prostřednictvím PR\.

Pokud Codex nebo jiná platforma pro agenty již vytvořila čisté worktree aktuálního úkolu\, zaregistruj je před úpravami místo vytváření vnořeného worktree\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Registrace vyžaduje samostatnou větev úkolu ve tvaru `codex/*` na nezměněné základní revizi\, stejný společný adresář Git a čistou pracovní kopii zdroje\. Better Workflows používá worktree\, ale při úklidu zachovává větev i cestu vlastněné platformou pro agenty\. U chráněného cíle nejprve spusť pracovní postup pro důkazní podklady a poté připoj jeho přesné ověřitelné záznamy o sloučení PR a vzdálené synchronizaci pomocí `workspace reconcile --run-id <run-id>`\.

Dále\: [vyberte si správné workflow](workflows.md) nebo prozkoumejte [referenční příručku k CLI](cli-reference.md)\.
