<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Участие в разработке

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · **Русский** · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Спасибо за помощь в улучшении Better Workflows\.

[README](../../../README.md) · **Участие в проекте** · [Кодекс поведения](conduct.md) · [Безопасность](security.md) · [Управление проектом](governance.md) · [Поддержка](support.md)

[Обзор в 41 локализованной версии и официальные точки входа на сайте](../../../docs/LANGUAGES.md)\. Английская версия остаётся определяющим текстом этой нормативной политики участия в разработке\.

## Перед началом

- Сначала создайте issue или обсуждение для нового публичного контракта\, изменения публичного поведения Auto\, границы безопасности или крупного архитектурного изменения\.
- Сосредоточьте один pull request на одном результате\.
- Никогда не фиксируйте в коммитах учетные данные\, приватные промпты\, исходную историю диалогов\, ключи подписи хоста\, квитанции провайдеров или подписанные аттестации\.
- Сообщайте об уязвимостях конфиденциально\, как описано в [SECURITY\.md](security.md)\.

## Настройка среды разработки

Требования\:

- Node\.js 24 или новее\;
- отсутствие сторонних зависимостей времени выполнения\;
- чистая ветка на основе текущей целевой ветки\.

Выполните полный набор локальных базовых проверок\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Правила внесения изменений

1. Сохраняйте мутации\, принадлежащие Root\, и границы побочных эффектов с принципом fail\-closed\.
2. При изменении публичного поведения Auto обновляйте его шаблон и навык\, каталог точек входа\, CLI\, тесты и всю затронутую документацию одновременно\.
3. Отклоняйте неизвестные параметры CLI и неизвестные поля схемы\.
4. Храните приватное состояние времени выполнения вне репозитория\.
5. Добавляйте негативные тесты для каждого нового safety gate\.
6. Не мутируйте существующую неизменяемую версию кэша плагинов\. Для измененного бандла требуется новая версия сборки и точная проверка дайджеста источника\/кэша\.

Если изменения касаются только организации README\, сохраняйте удобство быстрого просмотра корневой страницы\, а подробные контракты размещайте в соответствующем файле в [`docs/guide/`](../../../docs/guide/)\.

## Контрольный список запроса на слияние

- [ ] Область изменений и то\, что не входит в цели\, указаны явно\.
- [ ] Поведение и границы безопасности задокументированы\.
- [ ] Целевые тесты охватывают успешные и неуспешные пути\.
- [ ] Полный набор тестов и `sbw eval` проходят успешно\.
- [ ] `git diff --check` проходит успешно\.
- [ ] Изменения версий\/кеша соответствуют правилам неизменяемой публикации\, когда они применимы\.
- [ ] Секреты\, приватное состояние и внешние квитанции не включены\.

Предпочтительны небольшие коммиты\, которые удобно проверять\. Не объединяйте несвязанную очистку с изменением поведения\.
