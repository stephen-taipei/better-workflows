<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Участь у розробці

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · **Українська** · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Дякуємо за допомогу в удосконаленні Better Workflows\.

[README](../../../README.md) · **Участь у проєкті** · [Кодекс поведінки](conduct.md) · [Безпека](security.md) · [Управління проєктом](governance.md) · [Підтримка](support.md)

[Огляд у 41 локалізованій версії та офіційні точки входу на вебсайтах](../../../docs/LANGUAGES.md)\. Англійська версія залишається визначальним текстом цієї нормативної політики участі в розробці\.

## Перед початком

- Спочатку створіть issue або discussion для нового публічного контракту\, зміни публічної поведінки Auto\, межі безпеки чи масштабної архітектурної зміни\.
- Один pull request має бути зосереджений на одному результаті\.
- Ніколи не комітьте облікові дані\, приватні промпти\, необроблену історію розмов\, ключі підпису хоста\, квитанції провайдерів або підписані атестації\.
- Повідомляйте про вразливості конфіденційно\, як описано в [SECURITY\.md](security.md)\.

## Налаштування середовища розробки

Вимоги\:

- Node\.js 24 або новіша версія\;
- відсутність сторонніх залежностей під час виконання\;
- чиста гілка на основі поточної цільової гілки\.

Виконайте повний набір локальних базових перевірок\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Правила внесення змін

1. Зберігайте мутації\, підпорядковані Root\, та межі побічних ефектів із безпечною відмовою \(fail\-closed\)\.
2. У разі зміни публічної поведінки Auto оновлюйте разом її шаблон і скіл\, каталог точок входу\, CLI\, тести та всю зачеплену документацію\.
3. Відхиляйте невідомі параметри CLI та невідомі поля схеми\.
4. Зберігайте приватний стан середовища виконання поза межами репозиторію\.
5. Додавайте негативні тести для кожного нового safety gate\.
6. Не змінюйте наявну незмінну версію кешу плагінів\. Змінений бандл вимагає нової версії збірки та точної перевірки дайджесту вихідного коду\/кешу\.

Якщо зміни стосуються лише організації README\, залишайте кореневу сторінку зручною для швидкого перегляду\, а докладні контракти розміщуйте у відповідному файлі в [`docs/guide/`](../../../docs/guide/)\.

## Контрольний список запиту на злиття

- [ ] Обсяг і те\, що не належить до цілей\, визначено явно\.
- [ ] Поведінку та межі безпеки задокументовано\.
- [ ] Цільові тести охоплюють успішні та неуспішні шляхи\.
- [ ] Повний набір тестів і `sbw eval` проходять успішно\.
- [ ] `git diff --check` проходить успішно\.
- [ ] Зміни версій\/кешу відповідають правилам незмінної публікації\, якщо вони застосовні\.
- [ ] Секретів\, приватного стану та зовнішніх квитанцій не додано\.

Бажані невеликі коміти\, які легко перевірити\. Не поєднуйте непов’язане впорядкування зі зміною поведінки\.
