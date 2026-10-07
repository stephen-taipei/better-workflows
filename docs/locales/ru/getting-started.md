<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Начало работы

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · **Русский** · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 охватывает Codex\, Gemini CLI и Qwen Code на macOS × Node 22\/24\. Квалификация для Claude Code\, Linux и Windows отложена до V5\.1\. Для GA требуется как минимум 30 календарных канареечных дней\, 20 успешных запусков подряд\, удовлетворяющих критериям\, и три разных репозитория\.

| [Обзор](../../../README.md) | [Подробности](../../../docs/details/en.md) | **Быстрый старт** | [Рабочие процессы](workflows.md) | [Архитектура](architecture.md) | [Безопасность](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Обзор в 41 локализованной версии и официальные точки входа на сайте](../../../docs/LANGUAGES.md)\. Команды и идентификаторы сохраняют каноническую английскую форму\.

V5\.0 RC1 \(`5.0.0-rc.1`\, тег `V5.0.rc1`\) доступна публично\. Область этого релиза охватывает только Auto с Codex\, Gemini CLI и Qwen Code на macOS Node 22\/24\. Квалификация для Linux и Windows отложена до V5\.1\, как и квалификация для Claude Code\. Релиз GA `5.0.0` отложен до тех пор\, пока не будет зафиксировано как минимум 30 естественных дней канареечного тестирования\, 20 последовательных подходящих запусков и три разных репозитория\.

## Требования

- Node\.js 22\.14 или новее для встроенного вспомогательного инструмента `sbw`\.
- Доверенный локальный репозиторий\. Better Workflows не претендует на изолированное выполнение \(sandboxing\) вредоносного кода из репозитория\.

Корневой каталог состояния v4 не зависит от платформы агентов\: если задан `SBW_STATE_ROOT`\, он имеет приоритет\; затем используется `XDG_STATE_HOME/better-workflows`\, иначе — `~/.better-workflows`\. По умолчанию каталог больше не размещается внутри `CODEX_HOME`\. Чтобы продолжать использовать существующее состояние v3 для Codex без его перемещения\, явно укажите для `SBW_STATE_ROOT` тот самый точный каталог `<CODEX_HOME>/sbw` перед вызовом `sbw`\.

V5\.0 GA \(`5.0.0`\) пока ожидает выпуска\. Приведенные ниже команды установки предназначены для публично доступной версии V5\.0 RC1 \(`5.0.0-rc.1`\, тег `V5.0.rc1`\)\.

## Установка

### Codex — рекомендуемая эталонная среда

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

После установки откройте новую задачу Codex\, чтобы обновить её каталог навыков\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI копирует расширение\. После установки перезапустите сеанс\; для последующего обновления используйте `gemini extensions update better-workflows`\.

Контекст расширения определяет расположение моста по пути исходного кода\, из которого сам был загружен\, а не по рабочему каталогу вашего проекта\. При стандартной установке в пределах учётной записи пользователя эквивалентная ручная проверка выглядит так\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Для расширения\, подключённого через ссылку или установленного в пределах рабочей области\, используйте точный корневой каталог расширения\, показанный платформой агента\. Не подставляйте рабочую копию с похожим именем\.

### Qwen Code

Перед установкой локальной копии расширения зафиксируйте релиз\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code также копирует расширение\, поэтому после установки перезапустите сеанс\, а для последующих обновлений используйте `qwen extensions update better-workflows`\.

При стандартной установке в пределах учётной записи пользователя эквивалентная ручная проверка моста выглядит так\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

То же правило точного корневого каталога действует для установок через ссылку или в пределах рабочей области\.

## Использование Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Каждая точка входа сохраняет запрошенный Goal\. Несвязанный активный Goal необходимо явно отредактировать или очистить\; он никогда не заменяется незаметно\.

## Предварительный просмотр маршрута

Снимок возможностей доступен только для чтения и не запускает вход у провайдера или семантическую проверку модели\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Для передачи работы с возможностью проверки зафиксируйте и используйте одну приватную проверяемую запись для однократного использования\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Срок действия записей истекает через 24 часа\. При повторном использовании или отклонениях в рабочей области\, области действия\, Profiles\, каталоге\, возможностях или пакете плагина операция отклоняется\: при неопределённости продолжение не разрешается\.

## Проверьте установку

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Перед изменением репозитория

Auto начинает с предварительной проверки рабочей области только для чтения\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Задачи\, не связанные с Git\, и задачи только для чтения не создают рабочее дерево\. Задача Git\, вносящая изменения\, должна создать или повторно использовать `TaskWorkspaceLeaseV1`\, принадлежащий этой задаче\. Если рабочий каталог исходного кода содержит незакоммиченные изменения\, процесс останавливается до любого stash\, копирования\, коммита или создания рабочего дерева\. Если HEAD находится в отсоединённом состоянии или цель отсутствует\, требуется явно указать цель интеграции\. Защищённые или удалённые цели переводятся в процесс доставки через PR\, подчинённый правилам управления\.

Если Codex или другая платформа агентов уже создала чистое рабочее дерево для текущей задачи\, зарегистрируйте его перед редактированием вместо создания вложенного рабочего дерева\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Для регистрации необходимы отдельная ветка задачи `codex/*`\, указывающая на неизменённую базу\, тот же общий каталог Git и чистая рабочая копия источника\. Better Workflows использует рабочее дерево\, но при очистке сохраняет ветку и путь\, принадлежащие платформе агента\. Для защищённой цели сначала выполните рабочий процесс работы с доказательствами\, затем с помощью `workspace reconcile --run-id <run-id>` привяжите его точные проверяемые записи о слиянии PR и удалённой синхронизации\.

Далее\: [выберите подходящий workflow](workflows.md) или просмотрите [справочник по CLI](cli-reference.md)\.
