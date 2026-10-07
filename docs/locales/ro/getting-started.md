<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Primii pași

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · **Română** · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 acoperă Codex\, Gemini CLI și Qwen Code pe macOS × Node 22\/24\. Calificarea pentru Claude Code\, Linux și Windows este amânată pentru V5\.1\. GA necesită cel puțin 30 de zile calendaristice de canary\, 20 de porniri eligibile consecutive și trei depozite distincte\.

| [Prezentare generală](../../../README.md) | [Detalii](../../../docs/details/en.md) | **Pornire rapidă** | [Fluxuri de lucru](workflows.md) | [Arhitectură](architecture.md) | [Securitate](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Prezentare generală în 41 de versiuni localizate și puncte oficiale de acces web](../../../docs/LANGUAGES.md)\. Comenzile și identificatorii își păstrează forma canonică în engleză\.

V5\.0 RC1 \(`5.0.0-rc.1`\, eticheta `V5.0.rc1`\) este disponibil public\. Sfera acestei versiuni acoperă doar Auto\, cu Codex\, Gemini CLI și Qwen Code pe macOS Node 22\/24\. Calificarea pentru Linux și Windows este amânată pentru V5\.1\, la fel ca și calificarea pentru Claude Code\. GA `5.0.0` rămâne în așteptare până la înregistrarea a cel puțin 30 de zile calendaristice de canary\, 20 de porniri eligibile consecutive și trei depozite distincte\.

## Cerințe

- Node\.js 22\.14 sau mai recent pentru utilitarul `sbw` inclus\.
- Un depozit local de încredere\. Better Workflows nu pretinde că izolează în sandbox codul malițios din depozite\.

Directorul rădăcină al stării v4 este independent de platforma de agenți\: `SBW_STATE_ROOT` are prioritate când este setat\, apoi se folosește `XDG_STATE_HOME/better-workflows`\, iar în caz contrar `~/.better-workflows`\. Locația implicită nu mai este sub `CODEX_HOME`\. Pentru a continua să folosești o stare v3 existentă pentru Codex fără a o muta\, setează explicit `SBW_STATE_ROOT` la exact acel director `<CODEX_HOME>/sbw` înainte de a invoca `sbw`\.

V5\.0 GA \(`5.0.0`\) rămâne în așteptare\. Comenzile de instalare de mai jos vizează versiunea disponibilă public V5\.0 RC1 \(`5.0.0-rc.1`\, eticheta `V5.0.rc1`\)\.

## Instalare

### Codex — referința recomandată

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

Deschide o sarcină Codex nouă după instalare\, astfel încât catalogul său de abilități să se actualizeze\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI copiază extensia\. Repornește sesiunea după instalare\; folosește `gemini extensions update better-workflows` pentru a o actualiza ulterior\.

Contextul extensiei determină locația punții pornind de la calea propriului cod sursă încărcat\, nu de la directorul de lucru al proiectului tău\. Pentru o instalare standard la nivel de utilizator\, verificarea manuală echivalentă este\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Pentru o extensie legată printr\-un link sau instalată la nivelul spațiului de lucru\, folosește exact directorul rădăcină al extensiei indicat de platforma de agenți\. Nu îl înlocui cu o copie de lucru cu un nume asemănător\.

### Qwen Code

Fixează lansarea la o versiune precisă înainte de a instala copia locală a extensiei\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code copiază și el extensia\, așa că repornește sesiunea după instalare și folosește `qwen extensions update better-workflows` pentru actualizările ulterioare\.

Pentru o instalare standard la nivel de utilizator\, verificarea manuală echivalentă a punții este\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Aceeași regulă privind directorul rădăcină exact se aplică instalărilor legate printr\-un link sau celor la nivelul spațiului de lucru\.

## Folosește Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Fiecare punct de intrare păstrează obiectivul Goal solicitat\. Un obiectiv Goal activ fără legătură cu sarcina trebuie editat sau golit explicit\; nu este niciodată înlocuit pe ascuns\.

## Previzualizează ruta

Instantaneul capabilităților este doar pentru citire și nu declanșează autentificarea la furnizor sau o sondare semantică a modelului\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Pentru o predare care poate fi revizuită\, înregistrează și utilizează o singură înregistrare verificabilă\, privată și de unică folosință\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Înregistrările expiră după 24 de ore\, iar utilizarea lor este refuzată din motive de siguranță în caz de reutilizare sau de abateri în spațiul de lucru\, domeniul de aplicare\, Profiles\, catalog\, capabilități ori pachetul pluginului\.

## Verifică instalarea

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Înainte de modificarea unui depozit

Auto începe cu o verificare preliminară a spațiului de lucru care efectuează doar citiri\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Sarcinile fără Git și cele doar pentru citire nu creează un worktree\. O sarcină Git care efectuează modificări trebuie să creeze sau să reutilizeze un `TaskWorkspaceLeaseV1` deținut de sarcină\. Dacă directorul de lucru al sursei conține modificări neincluse într\-un commit\, procesul se oprește înainte de orice stash\, copiere\, commit sau creare de worktree\. O stare HEAD detașată sau lipsa unei ținte necesită o țintă de integrare explicită\. Țintele protejate sau la distanță sunt trecute la livrare prin PR supusă regulilor de guvernanță\.

Dacă Codex sau o altă platformă de agenți a creat deja worktree\-ul curat al sarcinii curente\, înregistrează\-l înainte de editare\, în loc să creezi un worktree imbricat\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Înregistrarea necesită o ramură de sarcină distinctă de forma `codex/*` la revizia de bază neschimbată\, același director comun Git și o copie de lucru curată a sursei\. Better Workflows folosește worktree\-ul\, dar păstrează ramura și calea deținute de platforma de agenți în timpul curățării\. Pentru o țintă protejată\, rulează mai întâi fluxul de lucru pentru dovezi\, apoi leagă înregistrările sale verificabile exacte pentru îmbinarea PR și sincronizarea la distanță folosind `workspace reconcile --run-id <run-id>`\.

Următorul pas\: [alege fluxul de lucru potrivit](workflows.md) sau explorează [referința CLI](cli-reference.md)\.
