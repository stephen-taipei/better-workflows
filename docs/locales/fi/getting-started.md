<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Aloittaminen

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · **Suomi** · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 kattaa alustat Codex\, Gemini CLI ja Qwen Code ympäristössä macOS × Node 22\/24\. Claude Code\-\, Linux\- ja Windows\-kelpoisuus siirretään versioon V5\.1\. GA vaatii vähintään 30 luonnollista canary\-päivää\, 20 peräkkäistä hyväksyttävää käynnistystä ja kolme eri arkistoa\.

| [Yleiskatsaus](../../../README.md) | [Lisätiedot](../../../docs/details/en.md) | **Pika\-aloitus** | [Työnkulut](workflows.md) | [Arkkitehtuuri](architecture.md) | [Tietoturva](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Yleiskatsaus 41 lokalisoituna versiona ja viralliset verkkosivujen aloituskohdat](../../../docs/LANGUAGES.md)\. Komennot ja tunnisteet säilyvät kanonisessa englanninkielisessä muodossaan\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) on julkisesti saatavilla\. Sen julkaisulaajuus kattaa vain Auton\, mukana Codex\, Gemini CLI ja Qwen Code macOS Node 22\/24 \-alustalla\. Linux\- ja Windows\-kelpuutus on siirretty versioon V5\.1\, samoin kuin Claude Code \-kelpuutus\. GA `5.0.0` pysyy odotustilassa\, kunnes vähintään 30 luonnollista canary\-päivää\, 20 peräkkäistä kelvollista käynnistystä ja kolme erillistä repositoriota on kirjattu\.

## Vaatimukset

- Node\.js 22\.14 tai uudempi mukana toimitettavaa `sbw`\-aputyökalua varten\.
- Luotettu paikallinen repositorio\. Better Workflows ei väitä eristävänsä haitallista repositoriokoodia hiekkalaatikkoon\.

v4\-tilan juurihakemisto on agenttialustasta riippumaton\: `SBW_STATE_ROOT` on ensisijainen\, kun se on asetettu\, seuraavana on `XDG_STATE_HOME/better-workflows` ja muuten käytetään hakemistoa `~/.better-workflows`\. Oletussijainti ei enää ole `CODEX_HOME`\-hakemiston alla\. Jos haluat jatkaa olemassa olevan v3\-tilan käyttöä Codex\-alustalla siirtämättä sitä\, aseta `SBW_STATE_ROOT` nimenomaisesti osoittamaan juuri kyseiseen `<CODEX_HOME>/sbw`\-hakemistoon ennen `sbw`\-komennon kutsumista\.

V5\.0 GA \(`5.0.0`\) on edelleen vireillä\. Alla olevat asennuskomennot kohdistuvat julkisesti saatavilla olevaan versioon V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\)\.

## Asennus

### Codex — suositeltu referenssi

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

Avaa asennuksen jälkeen uusi Codex\-tehtävä\, jotta sen taitoluettelo päivittyy\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI kopioi laajennuksen\. Käynnistä istunto uudelleen asennuksen jälkeen\; päivitä laajennus myöhemmin komennolla `gemini extensions update better-workflows`\.

Laajennuksen konteksti selvittää sillan sijainnin oman ladatun lähdekoodinsa polun perusteella\, ei projektisi työhakemistosta\. Tavallisessa käyttäjäkohtaisessa asennuksessa vastaava manuaalinen tarkistus on\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Jos laajennus on linkitetty tai rajattu työtilaan\, käytä täsmälleen agenttialustan näyttämää laajennuksen juurihakemistoa\. Älä korvaa sitä samankaltaisesti nimetyn repositorion työkopiolla\.

### Qwen Code

Kiinnitä julkaisu tiettyyn versioon ennen laajennuksen paikallisen kopion asentamista\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Myös Qwen Code kopioi laajennuksen\, joten käynnistä istunto uudelleen asennuksen jälkeen ja käytä myöhempiin päivityksiin komentoa `qwen extensions update better-workflows`\.

Tavallisessa käyttäjäkohtaisessa asennuksessa vastaava sillan manuaalinen tarkistus on\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Sama täsmällistä juurihakemistoa koskeva sääntö pätee linkitettyihin tai työtilaan rajattuihin asennuksiin\.

## Käytä Autoa

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Jokainen aloitusvaihtoehto säilyttää pyydetyn Goal\-tavoitteen\. Asiaan liittymätöntä aktiivista Goal\-tavoitetta on muokattava tai se on tyhjennettävä nimenomaisesti\; sitä ei koskaan korvata huomaamatta\.

## Esikatsele reititys

Tilannekuvan ottaminen käytettävissä olevista ominaisuuksista käyttää vain lukuoperaatioita eikä käynnistä palveluntarjoajalle kirjautumista tai mallin semanttista tarkistusta\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Tarkastettavaa työn luovutusta varten kirjaa ja käytä yksi yksityinen\, kertakäyttöinen varmennettava tietue\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Tietueet vanhenevat 24 tunnin kuluttua\, ja niiden käyttö evätään turvallisuussyistä\, jos niitä käytetään uudelleen tai työtilassa\, rajauksessa\, Profiles\-kokonaisuudessa\, luettelossa\, käytettävissä olevissa ominaisuuksissa tai lisäosapaketissa ilmenee poikkeamia\.

## Varmenna asennus

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Ennen repositorion muuttamista

Auto aloittaa työtilan ennakkotarkistuksella\, joka käyttää vain lukuoperaatioita\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Tehtävät\, joissa ei käytetä Git\-järjestelmää\, sekä vain lukevat tehtävät eivät luo worktree\-työpuuta\. Muutoksia tekevän Git\-tehtävän on luotava tai käytettävä uudelleen tehtävän omistamaa `TaskWorkspaceLeaseV1`\-varausta\. Jos lähteen työkopiossa on muutoksia\, joista ei ole tehty committia\, toiminta pysähtyy ennen mitään stash\-\, kopiointi\- tai commit\-toimintoa tai worktree\-työpuun luomista\. Irrallinen HEAD tai puuttuva kohde edellyttää erikseen määritettyä integrointikohdetta\. Suojatut kohteet tai etäkohteet siirretään hallitun PR\-toimituksen piiriin\.

Jos Codex tai jokin muu agenttialusta on jo luonut nykyiselle tehtävälle puhtaan worktree\-työpuun\, rekisteröi se ennen muokkaamista sen sijaan\, että loisit sisäkkäisen worktree\-työpuun\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Rekisteröinti edellyttää erillistä `codex/*`\-tehtävähaaraa muuttumattomassa pohjarevisiossa\, samaa yhteistä Git\-hakemistoa ja puhdasta lähteen työkopiota\. Better Workflows käyttää worktree\-työpuuta\, mutta säilyttää agenttialustan omistaman haaran ja polun siivouksessa\. Jos kohde on suojattu\, suorita ensin todentavan aineiston työnkulku ja sido sitten sen täsmälliset PR\-yhdistämisen ja etäsynkronoinnin varmennettavat tietueet komennolla `workspace reconcile --run-id <run-id>`\.

Seuraavaksi\: [valitse oikea työnkulku](workflows.md) tai selaa [CLI\-viitettä](cli-reference.md)\.
