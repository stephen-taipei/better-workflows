<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Első lépések

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · **Magyar** · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

A V5\.0 RC1 a Codex\, a Gemini CLI és a Qwen Code eszközöket fedi le macOS × Node 22\/24 környezetben\. A Claude Code\, a Linux és a Windows minősítése a V5\.1\-re halasztódik\. A GA legalább 30 naptári canary\-napot\, 20 egymást követő megfelelő indítást és három különböző repositoryt igényel\.

| [Áttekintés](../../../README.md) | [Részletek](../../../docs/details/en.md) | **Gyors kezdés** | [Munkafolyamatok](workflows.md) | [Architektúra](architecture.md) | [Biztonság](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Áttekintés 41 lokalizált változatban és hivatalos webes belépési pontok](../../../docs/LANGUAGES.md)\. A parancsok és az azonosítók megőrzik kanonikus angol alakjukat\.

A V5\.0 RC1 \(`5.0.0-rc.1`\, `V5.0.rc1` címke\) nyilvánosan elérhető\. A kiadás hatóköre kizárólag az Auto munkafolyamatra terjed ki\, a Codex\, a Gemini CLI és a Qwen Code használatával macOS Node 22\/24 környezetben\. A Linux és Windows minősítés a V5\.1 verzióra halasztva\, ahogy a Claude Code minősítés is\. A GA `5.0.0` függőben marad legalább 30 természetes canary nap\, 20 egymást követő jogosult indítás és három különböző adattár rögzítéséig\.

## Követelmények

- Node\.js 22\.14 vagy újabb a mellékelt `sbw` segédprogramhoz\.
- Megbízható helyi adattár\. A Better Workflows nem vállalja a rosszindulatú adattárkódok sandboxolását\.

A v4 állapotának gyökérkönyvtára ügynökplatformtól független\: ha a `SBW_STATE_ROOT` be van állítva\, az élvez elsőbbséget\, ezt követi a `XDG_STATE_HOME/better-workflows`\, egyébként pedig a `~/.better-workflows`\. Az alapértelmezett hely már nem a `CODEX_HOME` alatt található\. Ha egy meglévő v3\-as Codex\-állapotot áthelyezés nélkül szeretnél tovább használni\, a `SBW_STATE_ROOT` értékét kifejezetten pontosan arra a `<CODEX_HOME>/sbw` könyvtárra állítsd a `sbw` meghívása előtt\.

A V5\.0 GA \(`5.0.0`\) még függőben van\. Az alábbi telepítési parancsok a nyilvánosan elérhető V5\.0 RC1 \(`5.0.0-rc.1`\, `V5.0.rc1` címke\) verziót célozzák\.

## Telepítés

### Codex — ajánlott referencia

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

Telepítés után nyiss új Codex\-feladatot\, hogy frissüljön a készségkatalógusa\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

A Gemini CLI másolatot készít a kiegészítőről\. Telepítés után indítsd újra a munkamenetet\; későbbi frissítéséhez használd a `gemini extensions update better-workflows` parancsot\.

A kiegészítő kontextusa a saját betöltött forrásának elérési útjából határozza meg a híd helyét\, nem a projekted munkakönyvtárából\. Szokásos\, felhasználói szintű telepítés esetén az ezzel egyenértékű kézi ellenőrzés\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Hivatkozással csatolt vagy munkaterületre korlátozott kiegészítőnél pontosan az ügynökplatform által jelzett kiegészítő\-gyökérkönyvtárat használd\. Ne helyettesítsd hasonló nevű munkapéldánnyal\.

### Qwen Code

Rögzítsd a kiadást egy adott verzióhoz a kiegészítő helyi másolatának telepítése előtt\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

A Qwen Code is másolatot készít a kiegészítőről\, ezért telepítés után indítsd újra a munkamenetet\, a későbbi frissítésekhez pedig használd a `qwen extensions update better-workflows` parancsot\.

Szokásos\, felhasználói szintű telepítés esetén a híd ezzel egyenértékű kézi ellenőrzése\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Ugyanez a pontos gyökérkönyvtárra vonatkozó szabály érvényes a hivatkozással csatolt vagy munkaterületre korlátozott telepítésekre\.

## Az Auto használata

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Minden belépési pont megőrzi a kért Goal célt\. Egy nem kapcsolódó aktív Goal célt kifejezetten szerkeszteni vagy törölni kell\; a rendszer soha nem cseréli le észrevétlenül\.

## Tekintsd meg az útvonal előnézetét

A képességpillanatkép csak olvasási műveleteket használ\, és nem indít szolgáltatói bejelentkezést vagy szemantikai modellpróbát\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Az átadás felülvizsgálhatóságához rögzíts és használj fel egy privát\, egyszer használatos\, ellenőrizhető bejegyzést\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

A bejegyzések 24 óra után lejárnak\; ismételt felhasználásuk\, illetve a munkaterület\, a hatókör\, a Profiles\, a katalógus\, a képességek vagy a bővítménycsomag eltérése esetén a rendszer biztonsági okból megtagadja a használatukat\.

## Ellenőrizd a telepítést

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## A kódtár módosítása előtt

Az Auto a munkaterület csak olvasási műveleteket végző előzetes ellenőrzésével indul\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

A Git rendszert nem használó és a csak olvasást végző feladatok nem hoznak létre worktree\-t\. Egy módosító Git\-feladatnak létre kell hoznia vagy újra kell használnia egy\, a feladat tulajdonában álló `TaskWorkspaceLeaseV1`\-et\. Ha a forrás munkakönyvtára még nem commitolt módosításokat tartalmaz\, a folyamat minden stash\, másolás\, commit és worktree\-létrehozás előtt leáll\. Leválasztott HEAD vagy hiányzó cél esetén kifejezetten meg kell adni az integrációs célt\. A védett vagy távoli célok a szabályozott\, PR\-alapú szállítás folyamatába kerülnek\.

Ha a Codex vagy egy másik ügynökplatform már létrehozta az aktuális feladat tiszta worktree\-jét\, szerkesztés előtt regisztráld azt\, ahelyett\, hogy beágyazott worktree\-t hoznál létre\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

A regisztrációhoz külön\, a `codex/*` mintának megfelelő feladatág szükséges a változatlan alaprevízión\, továbbá ugyanaz a közös Git\-könyvtár és egy tiszta forrás\-munkapéldány\. A Better Workflows használja a worktree\-t\, de takarításkor megőrzi az ügynökplatform tulajdonában lévő ágat és elérési utat\. Védett cél esetén először futtasd a bizonyítékokat kezelő munkafolyamatot\, majd a `workspace reconcile --run-id <run-id>` paranccsal kösd hozzá annak pontos\, ellenőrizhető bejegyzéseit a PR beolvasztásáról és a távoli szinkronizálásról\.

Következő lépés\: [válaszd ki a megfelelő munkafolyamatot](workflows.md) vagy böngészd a [CLI\-referenciát](cli-reference.md)\.
