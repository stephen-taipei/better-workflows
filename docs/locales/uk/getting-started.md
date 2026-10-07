<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Початок роботи

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · **Українська** · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 підтримує Codex\, Gemini CLI та Qwen Code на macOS × Node 22\/24\. Кваліфікацію Claude Code\, Linux та Windows відкладено до V5\.1\. Для GA потрібно щонайменше 30 природних днів канарейки\, 20 послідовних відповідних запусків і три різні репозиторії\.

| [Огляд](../../../README.md) | [Докладніше](../../../docs/details/en.md) | **Швидкий початок** | [Робочі процеси](workflows.md) | [Архітектура](architecture.md) | [Безпека](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Огляд у 41 локалізованій версії та офіційні точки входу на вебсайтах](../../../docs/LANGUAGES.md)\. Команди та ідентифікатори зберігають канонічну англійську форму\.

V5\.0 RC1 \(`5.0.0-rc.1`\, тег `V5.0.rc1`\) доступна публічно\. Обсяг її релізу охоплює лише Auto\, разом із Codex\, Gemini CLI та Qwen Code на macOS Node 22\/24\. Кваліфікацію для Linux і Windows відкладено до V5\.1\, як і кваліфікацію для Claude Code\. GA `5.0.0` очікується\, доки не буде зафіксовано щонайменше 30 природних днів канарейки\, 20 послідовних відповідних запусків і три окремі репозиторії\.

## Вимоги

- Node\.js 22\.14 або новішої версії для вбудованої допоміжної утиліти `sbw`\.
- Довірений локальний репозиторій\. Better Workflows не претендує на ізоляцію шкідливого коду репозиторію в пісочниці\.

Кореневий каталог стану v4 не прив’язаний до платформи ШІ\-агентів\: якщо задано `SBW_STATE_ROOT`\, він має пріоритет\; далі використовується `XDG_STATE_HOME/better-workflows`\, інакше — `~/.better-workflows`\. Типове розташування більше не міститься в `CODEX_HOME`\. Щоб і далі використовувати наявний стан v3 для Codex без його переміщення\, явно задайте для `SBW_STATE_ROOT` саме той точний каталог `<CODEX_HOME>/sbw` перед викликом `sbw`\.

V5\.0 GA \(`5.0.0`\) усе ще очікується\. Наведені нижче команди встановлення призначені для публічно доступної версії V5\.0 RC1 \(`5.0.0-rc.1`\, тег `V5.0.rc1`\)\.

## Встановлення

### Codex — рекомендоване еталонне середовище

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

Після встановлення відкрийте нове завдання Codex\, щоб оновити його каталог навичок\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI копіює розширення\. Після встановлення перезапустіть сеанс\; для подальшого оновлення використовуйте `gemini extensions update better-workflows`\.

Контекст розширення знаходить міст за власним шляхом до завантаженого джерела\, а не за робочим каталогом вашого проєкту\. Для стандартного встановлення в межах облікового запису користувача еквівалентна ручна перевірка виглядає так\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Для підключеного через посилання розширення або розширення в межах робочого простору використовуйте точний кореневий каталог розширення\, показаний платформою агента\. Не підміняйте його робочою копією зі схожою назвою\.

### Qwen Code

Зафіксуйте реліз перед встановленням локальної копії розширення\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code також копіює розширення\, тому після встановлення перезапустіть сеанс\, а для подальших оновлень використовуйте `qwen extensions update better-workflows`\.

Для стандартного встановлення в межах облікового запису користувача еквівалентна ручна перевірка мосту виглядає так\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Те саме правило точного кореневого каталогу діє для встановлень через посилання або в межах робочого простору\.

## Використання Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Кожна точка входу зберігає запитаний Goal\. Непов’язаний активний Goal потрібно явно відредагувати або очистити\; його ніколи не замінюють непомітно\.

## Попередній перегляд маршруту

Знімок можливостей доступний лише для читання й не запускає вхід до провайдера або семантичну перевірку моделі\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Для передавання роботи з можливістю огляду зафіксуйте й використайте один приватний запис для одноразового використання\, який можна перевірити\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Строк дії записів спливає через 24 години\. Повторне використання або розбіжності в робочому просторі\, області дії\, Profiles\, каталозі\, можливостях чи пакеті плагіна призводять до відмови в операції\: за невизначеності продовження не дозволяється\.

## Перевірка встановлення

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Перед змінами в репозиторії

Auto починає з попередньої перевірки робочого простору лише для читання\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Завдання поза Git і завдання лише для читання не створюють робочого дерева\. Завдання Git\, що вносить зміни\, має створити або повторно використати `TaskWorkspaceLeaseV1`\, який належить цьому завданню\. Якщо робочий каталог джерела містить незакомічені зміни\, процес зупиняється до будь\-якого stash\, копіювання\, коміту чи створення робочого дерева\. Від’єднаний HEAD або відсутня ціль потребують явно заданої цілі інтеграції\. Захищені чи віддалені цілі переводяться до процесу доставки через PR\, підпорядкованого правилам керування\.

Якщо Codex або інша платформа агентів уже створила чисте робоче дерево для поточного завдання\, зареєструйте його перед редагуванням замість створення вкладеного робочого дерева\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Для реєстрації потрібні окрема гілка завдання `codex/*`\, що вказує на незмінену базу\, той самий спільний каталог Git і чиста робоча копія джерела\. Better Workflows використовує робоче дерево\, але під час очищення зберігає гілку та шлях\, що належать платформі агента\. Для захищеної цілі спочатку виконайте робочий процес роботи з доказами\, а потім за допомогою `workspace reconcile --run-id <run-id>` прив’яжіть точні записи цього процесу про злиття PR і віддалену синхронізацію\, які можна перевірити\.

Далі\: [оберіть відповідний робочий процес](workflows.md) або перегляньте [довідник із CLI](cli-reference.md)\.
