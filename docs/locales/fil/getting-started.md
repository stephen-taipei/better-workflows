<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Pagsisimula

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · **Filipino** · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

Sinasaklaw ng V5\.0 RC1 ang Codex\, Gemini CLI\, at Qwen Code sa macOS × Node 22\/24\. Ipinagpaliban sa V5\.1 ang kwalipikasyon para sa Claude Code\, Linux\, at Windows\. Nangangailangan ang GA ng hindi bababa sa 30 natural na araw ng canary\, 20 magkakasunod na kwalipikadong pagsisimula\, at tatlong magkakaibang repository\.

| [Pangkalahatang\-ideya](../../../README.md) | [Mga detalye](../../../docs/details/en.md) | **Mabilis na pagsisimula** | [Mga daloy ng trabaho](workflows.md) | [Arkitektura](architecture.md) | [Seguridad](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Pangkalahatang\-ideya sa 41 lokal na bersyon at mga opisyal na pasukan sa web](../../../docs/LANGUAGES.md)\. Nananatili sa pamantayang anyong Ingles ang mga command at identifier\.

Available na sa publiko ang V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\)\. Sinasaklaw lamang ng saklaw ng release nito ang Auto\, kasama ang Codex\, Gemini CLI\, at Qwen Code sa macOS Node 22\/24\. Ang kwalipikasyon para sa Linux at Windows ay ipinagpaliban sa V5\.1\, gayundin ang kwalipikasyon para sa Claude Code\. Nananatiling nakabinbin ang GA `5.0.0` hanggang sa maitala ang hindi bababa sa 30 natural na araw ng canary\, 20 magkakasunod na kwalipikadong simula\, at tatlong magkakaibang repository\.

## Mga kailangan

- Node\.js 22\.14 o mas bago para sa kasamang `sbw` helper\.
- Isang pinagkakatiwalaang lokal na repository\. Hindi sinasabi ng Better Workflows na nagse\-sandbox ito ng nakapipinsalang code sa repository\.

Ang root directory ng estado sa v4 ay hindi nakatali sa isang platform\: inuuna ang `SBW_STATE_ROOT` kapag nakatakda ito\, kasunod ang `XDG_STATE_HOME/better-workflows`\, at kung hindi\, ang `~/.better-workflows`\. Hindi na ito inilalagay sa ilalim ng `CODEX_HOME` bilang default\. Upang patuloy na gamitin ang umiiral na estado ng Codex v3 nang hindi ito inililipat\, tahasang itakda ang `SBW_STATE_ROOT` sa mismong directory na `<CODEX_HOME>/sbw` bago tawagin ang `sbw`\.

Nananatiling nakabinbin ang V5\.0 GA \(`5.0.0`\)\. Naka\-target ang mga command sa pag\-install sa ibaba sa available na sa publikong V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\)\.

## Pag\-install

### Codex — inirerekomendang sanggunian

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

Magbukas ng bagong gawain sa Codex pagkatapos mag\-install upang ma\-refresh ang katalogo ng mga skill nito\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Kinokopya ng Gemini CLI ang extension\. I\-restart ang session pagkatapos mag\-install\; gamitin ang `gemini extensions update better-workflows` upang i\-update ito sa susunod\.

Tinutukoy ng konteksto ng extension ang lokasyon ng tulay mula sa sarili nitong na\-load na source path\, hindi mula sa working directory ng iyong proyekto\. Para sa karaniwang pag\-install na saklaw ang gumagamit\, ang katumbas na manwal na pagsusuri ay\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Para sa naka\-link na extension o extension na saklaw ang workspace\, gamitin ang eksaktong root directory ng extension na ipinapakita ng platform\. Huwag itong palitan ng checkout na may kahawig na pangalan\.

### Qwen Code

Itakda sa isang tiyak na release bago i\-install ang lokal na kopya ng extension\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Kinokopya rin ng Qwen Code ang extension\, kaya i\-restart ang session pagkatapos mag\-install at gamitin ang `qwen extensions update better-workflows` para sa mga susunod na update\.

Para sa karaniwang pag\-install na saklaw ang gumagamit\, ang katumbas na manwal na pagsusuri sa tulay ay\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Nalalapat din ang tuntuning ito sa eksaktong root directory sa mga naka\-link na pag\-install o pag\-install na saklaw ang workspace\.

## Gamitin ang Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Pinananatili ng bawat panimulang opsyon ang hiniling na Goal\. Kailangang tahasang i\-edit o alisin ang isang aktibong Goal na walang kaugnayan\; hindi ito kailanman tahimik na pinapalitan\.

## Silipin ang ruta

Para sa pagbasa lamang ang snapshot ng mga kakayahan at hindi ito nagpapasimula ng pag\-login sa provider o semantikong pagsusuri sa modelo\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Para sa paglilipat ng gawain na maaaring suriin\, itala at gamitin ang isang pribadong mapatutunayang tala na isang beses lamang magagamit\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Napapaso ang mga mapatutunayang tala pagkalipas ng 24 oras\, at tinatanggihan ang paggamit kapag inulit ang paggamit sa tala o nagkaroon ng paglihis sa workspace\, saklaw\, Profiles\, katalogo\, mga kakayahan\, o pakete ng plugin\.

## Tiyakin ang pag\-install

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Bago baguhin ang repositoryo

Nagsisimula ang Auto sa paunang pagsusuri ng workspace na para sa pagbasa lamang\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Hindi lumilikha ng worktree ang mga gawaing hindi gumagamit ng Git at mga gawaing para sa pagbasa lamang\. Ang gawaing Git na may mga pagbabago ay kailangang lumikha o muling gumamit ng `TaskWorkspaceLeaseV1` na pag\-aari ng gawaing iyon\. Kapag may mga pagbabagong hindi pa naiko\-commit sa working directory ng source\, humihinto ang proseso bago gumawa ng anumang stash\, pagkopya\, commit\, o paglikha ng worktree\. Nangangailangan ng tahasang target ng integrasyon ang HEAD na hiwalay sa branch o ang kawalan ng target\. Ang mga protektado o remote na target ay inililipat sa proseso ng paghahatid sa pamamagitan ng PR na saklaw ng mga tuntunin ng pamamahala\.

Kung nakagawa na ang Codex o ibang platform ng malinis na worktree para sa kasalukuyang gawain\, irehistro ito bago mag\-edit sa halip na lumikha ng nakapaloob na worktree\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Nangangailangan ang pagpaparehistro ng isang bukod na branch ng gawain na `codex/*` sa hindi nabagong base revision\, ng parehong pinagsasaluhang directory ng Git\, at ng malinis na checkout ng source\. Ginagamit ng Better Workflows ang worktree ngunit pinananatili ang branch at path na pag\-aari ng platform sa paglilinis\. Para sa protektadong target\, patakbuhin muna ang daloy ng trabaho para sa ebidensiya\, saka itali ang mismong mapatutunayang mga tala nito ng pag\-merge ng PR at pag\-sync sa remote gamit ang `workspace reconcile --run-id <run-id>`\.

Susunod\: [piliin ang tamang workflow](workflows.md) o i\-browse ang [sanggunian ng CLI](cli-reference.md)\.
