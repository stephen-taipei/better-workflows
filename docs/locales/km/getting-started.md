<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# ចាប់ផ្តើមប្រើប្រាស់

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · **ខ្មែរ** · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 គ្របដណ្តប់លើ Codex\, Gemini CLI និង Qwen Code នៅលើ macOS × Node 22\/24។ លក្ខណៈសម្បត្តិ Claude Code\, Linux និង Windows ត្រូវបានពន្យារពេលទៅ V5\.1។ GA ទាមទារយ៉ាងហោចណាស់ 30 ថ្ងៃ canary តាមប្រតិទិន\, ការចាប់ផ្តើមបំពេញលក្ខខណ្ឌ 20 ដងជាប់ៗគ្នា និង repository ផ្សេងគ្នាបី។

| [ទិដ្ឋភាពទូទៅ](../../../README.md) | [ព័ត៌មានលម្អិត](../../../docs/details/en.md) | **ចាប់ផ្តើមរហ័ស** | [លំហូរការងារ](workflows.md) | [ស្ថាបត្យកម្ម](architecture.md) | [សុវត្ថិភាព](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[ទិដ្ឋភាពទូទៅក្នុងកំណែដែលបានសម្របតាមភាសា និងតំបន់ចំនួន 41 និងច្រកចូលគេហទំព័រផ្លូវការ](../../../docs/LANGUAGES.md)។ ពាក្យបញ្ជា និងសញ្ញាសម្គាល់នៅតែរក្សាទម្រង់ស្តង់ដារជាភាសាអង់គ្លេស។

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) អាចរកបានជាសាធារណៈ។ វិសាលភាពចេញផ្សាយរបស់វាគ្របដណ្តប់តែលើ Auto ប៉ុណ្ណោះ ជាមួយ Codex\, Gemini CLI និង Qwen Code នៅលើ macOS Node 22\/24។ លក្ខណៈសម្បត្តិគ្រប់គ្រាន់សម្រាប់ Linux និង Windows ត្រូវបានពន្យារពេលទៅ V5\.1 ដូចគ្នានឹងលក្ខណៈសម្បត្តិគ្រប់គ្រាន់សម្រាប់ Claude Code ដែរ។ GA `5.0.0` នៅតែរង់ចាំរហូតដល់យ៉ាងហោចណាស់ 30 ថ្ងៃ canary ធម្មជាតិ ការចាប់ផ្តើមជាប់លក្ខខណ្ឌ 20 លើកជាប់គ្នា និងកន្លែងផ្ទុកកូដខុសគ្នាបីត្រូវបានកត់ត្រា។

## តម្រូវការ

- Node\.js 22\.14 ឬថ្មីជាងនេះសម្រាប់ជំនួយការ `sbw` ដែលភ្ជាប់មកជាមួយ។
- កន្លែងផ្ទុកកូដក្នុងស្រុកដែលគួរឱ្យទុកចិត្ត។ Better Workflows មិនអះអាងថានឹង sandbox កូដកន្លែងផ្ទុកកូដដែលមានគំនិតព្យាបាទឡើយ។

ថតឫសសម្រាប់រក្សាទុកស្ថានភាព v4 មិនពឹងផ្អែកលើវេទិកាណាមួយទេ៖ បើបានកំណត់ `SBW_STATE_ROOT` វានឹងមានអាទិភាព បន្ទាប់មកគឺ `XDG_STATE_HOME/better-workflows` បើមិនមានទេ នឹងប្រើ `~/.better-workflows`។ ទីតាំងលំនាំដើមលែងនៅក្រោម `CODEX_HOME` ទៀតហើយ។ ដើម្បីបន្តប្រើស្ថានភាព Codex v3 ដែលមានស្រាប់ដោយមិនផ្លាស់ទីវា សូមកំណត់ `SBW_STATE_ROOT` ឱ្យច្បាស់លាស់ទៅកាន់ថត `<CODEX_HOME>/sbw` នោះឱ្យត្រូវគ្នាពិតប្រាកដ មុនហៅប្រើ `sbw`។

V5\.0 GA \(`5.0.0`\) នៅតែរង់ចាំ។ ពាក្យបញ្ជាដំឡើងខាងក្រោមគឺសំដៅលើ V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) ដែលអាចរកបានជាសាធារណៈ។

## ដំឡើង

### Codex — វេទិកាយោងដែលបានណែនាំ

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

បើកការងារ Codex ថ្មីបន្ទាប់ពីដំឡើង ដើម្បីឱ្យបញ្ជីជំនាញរបស់វាត្រូវបានផ្ទុកឡើងវិញ។

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI ចម្លងផ្នែកបន្ថែម។ ចាប់ផ្តើមសម័យប្រើប្រាស់ឡើងវិញបន្ទាប់ពីដំឡើង ហើយប្រើ `gemini extensions update better-workflows` ដើម្បីធ្វើបច្ចុប្បន្នភាពនៅពេលក្រោយ។

បរិបទរបស់ផ្នែកបន្ថែមកំណត់ទីតាំងស្ពានភ្ជាប់តាមផ្លូវកូដប្រភពរបស់ខ្លួនដែលត្រូវបានផ្ទុក មិនមែនតាមថតធ្វើការរបស់គម្រោងអ្នកទេ។ សម្រាប់ការដំឡើងស្តង់ដារក្នុងវិសាលភាពអ្នកប្រើ ការត្រួតពិនិត្យដោយដៃដែលស្មើគ្នាគឺ៖

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

សម្រាប់ផ្នែកបន្ថែមដែលបានតភ្ជាប់ ឬមានវិសាលភាពត្រឹមកន្លែងធ្វើការ សូមប្រើថតឫសរបស់ផ្នែកបន្ថែមដែលត្រូវគ្នាពិតប្រាកដនឹងទីតាំងដែលវេទិកាបង្ហាញ។ កុំជំនួសវាដោយ checkout ដែលមានឈ្មោះស្រដៀងគ្នា។

### Qwen Code

កំណត់កំណែចេញផ្សាយឱ្យថេរ មុនដំឡើងច្បាប់ចម្លងផ្នែកបន្ថែមក្នុងម៉ាស៊ីន៖

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code ក៏ចម្លងផ្នែកបន្ថែមដែរ ដូច្នេះសូមចាប់ផ្តើមសម័យប្រើប្រាស់ឡើងវិញបន្ទាប់ពីដំឡើង ហើយប្រើ `qwen extensions update better-workflows` សម្រាប់ការធ្វើបច្ចុប្បន្នភាពនៅពេលក្រោយ។

សម្រាប់ការដំឡើងស្តង់ដារក្នុងវិសាលភាពអ្នកប្រើ ការត្រួតពិនិត្យស្ពានភ្ជាប់ដោយដៃដែលស្មើគ្នាគឺ៖

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

វិធានប្រើថតឫសឱ្យត្រូវគ្នាពិតប្រាកដនេះ ក៏អនុវត្តចំពោះការដំឡើងដែលបានតភ្ជាប់ ឬមានវិសាលភាពត្រឹមកន្លែងធ្វើការដែរ។

## ប្រើ Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

ជម្រើសចាប់ផ្តើមនីមួយៗរក្សា Goal ដែលបានស្នើ។ Goal សកម្មដែលមិនពាក់ព័ន្ធត្រូវតែកែសម្រួល ឬលុបចេញដោយច្បាស់លាស់ ហើយវាមិនដែលត្រូវបានជំនួសដោយស្ងៀមស្ងាត់ទេ។

## មើលផ្លូវជាមុន

រូបភាពស្ថានភាពនៃសមត្ថភាពគឺសម្រាប់តែអាន ហើយមិនបង្កឱ្យមានការចូលគណនីអ្នកផ្តល់សេវា ឬការត្រួតពិនិត្យផ្នែកអត្ថន័យរបស់ម៉ូដែលទេ៖

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

ដើម្បីឱ្យការប្រគល់ការងារអាចត្រូវបានពិនិត្យឡើងវិញ សូមកត់ត្រា ហើយប្រើកំណត់ត្រាឯកជនដែលអាចផ្ទៀងផ្ទាត់បានមួយ ដែលអាចប្រើបានតែម្តង៖

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

កំណត់ត្រាដែលអាចផ្ទៀងផ្ទាត់បានផុតកំណត់បន្ទាប់ពី 24 ម៉ោង ហើយប្រព័ន្ធបដិសេធការប្រើប្រាស់នៅពេលមានការប្រើឡើងវិញ ឬមានភាពខុសគ្នាពីស្ថានភាពដែលបានចងភ្ជាប់ក្នុងកន្លែងធ្វើការ វិសាលភាព Profiles បញ្ជីកាតាឡុក សមត្ថភាព ឬកញ្ចប់កម្មវិធីជំនួយ។

## ផ្ទៀងផ្ទាត់ការដំឡើង

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## មុនពេលកែប្រែឃ្លាំងកូដ

Auto ចាប់ផ្តើមដោយការត្រួតពិនិត្យកន្លែងធ្វើការជាមុន ដែលសម្រាប់តែអាន៖

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

ការងារដែលមិនប្រើ Git និងការងារសម្រាប់តែអាន មិនបង្កើត worktree ទេ។ ការងារ Git ដែលធ្វើការផ្លាស់ប្តូរ ត្រូវតែបង្កើត ឬប្រើឡើងវិញនូវ `TaskWorkspaceLeaseV1` ដែលជាកម្មសិទ្ធិរបស់ការងារនោះ។ បើថតការងាររបស់កូដប្រភពមានការផ្លាស់ប្តូរដែលមិនទាន់បាន commit ដំណើរការនឹងឈប់មុនពេលធ្វើ stash ចម្លង commit ឬបង្កើត worktree ណាមួយ។ HEAD ដែលផ្តាច់ពីសាខា ឬការខ្វះគោលដៅ តម្រូវឱ្យបញ្ជាក់គោលដៅរួមបញ្ចូលឱ្យច្បាស់លាស់។ គោលដៅដែលត្រូវបានការពារ ឬនៅពីចម្ងាយ ត្រូវបានលើកទៅប្រើដំណើរការប្រគល់តាម PR ក្រោមអភិបាលកិច្ច។

បើ Codex ឬវេទិកាផ្សេងបានបង្កើត worktree ស្អាតសម្រាប់ការងារបច្ចុប្បន្នរួចហើយ សូមចុះបញ្ជីវាមុនពេលកែសម្រួល ជំនួសឱ្យការបង្កើត worktree នៅខាងក្នុង worktree មួយទៀត៖

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

ការចុះបញ្ជីតម្រូវឱ្យមានសាខាការងារ `codex/*` ដាច់ដោយឡែកនៅលើកំណែគោលដែលមិនបានផ្លាស់ប្តូរ ថតរួមរបស់ Git ដូចគ្នា និង checkout កូដប្រភពដែលស្អាត។ Better Workflows ប្រើ worktree នោះ ប៉ុន្តែរក្សាទុកសាខា និងផ្លូវដែលជាកម្មសិទ្ធិរបស់វេទិកានៅពេលសម្អាត។ សម្រាប់គោលដៅដែលត្រូវបានការពារ សូមដំណើរការលំហូរការងារភស្តុតាងជាមុន បន្ទាប់មកចងភ្ជាប់កំណត់ត្រាដែលអាចផ្ទៀងផ្ទាត់បាន និងត្រូវគ្នាពិតប្រាកដនៃការរួមបញ្ចូល PR និងការធ្វើសមកាលកម្មពីចម្ងាយរបស់លំហូរការងារនោះ ដោយប្រើ `workspace reconcile --run-id <run-id>`។

បន្ទាប់៖ [ជ្រើសរើស workflow ត្រឹមត្រូវ](workflows.md) ឬរកមើល [ឯកសារយោង CLI](cli-reference.md)។
