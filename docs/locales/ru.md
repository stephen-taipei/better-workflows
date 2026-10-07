<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 доступна публично: бесплатный Auto-workflow с открытым исходным кодом для инженерного QA и поставки ИИ с актуальными доказательствами, review gates и согласованием провайдеров.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · **Русский** · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Открыть документацию](https://betterworkflows.dev/ru/docs/) · [Открыть GitHub](https://github.com/stephen-taipei/better-workflows) · [Поддержать с помощью USDT (TRC20)](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 охватывает Codex, Gemini CLI и Qwen Code на macOS × Node 22/24. Квалификация для Claude Code, Linux и Windows отложена до V5.1. Для GA требуется как минимум 30 календарных канареечных дней, 20 успешных запусков подряд, удовлетворяющих критериям, и три разных репозитория.

## Доведите работу агентов<br>до доказуемого завершения.

V5.0 RC1 доступна публично. Auto проверяет цель, область действия, репозиторий и риск, затем выбирает целевые проверки или evidence workflow. Изменения Git используют принадлежащий задаче worktree; для поставки требуются авторизация и подтверждённый внешний результат.

## Четыре явные границы от намерения до завершения.

Определите контракт, проверьте источник и доказательства, сверьте внешние эффекты и объявляйте завершение только при известном конечном состоянии.

- **01 · `TaskContract`** — V5.0 RC1 доступна публично. Auto проверяет цель, область действия, репозиторий и риск, затем выбирает целевые проверки или evidence workflow. Изменения Git используют принадлежащий задаче worktree; для поставки требуются авторизация и подтверждённый внешний результат.
- **02 · `evidence`** — Better Workflows V5.0 RC1 доступна публично: бесплатный Auto-workflow с открытым исходным кодом для инженерного QA и поставки ИИ с актуальными доказательствами, review gates и согласованием провайдеров.
- **03 · `reconciliation`** — Определите контракт, проверьте источник и доказательства, сверьте внешние эффекты и объявляйте завершение только при известном конечном состоянии.
- **04 · `terminal state`** — Запуск команды не доказывает завершение; повторно проверяемый результат доказывает.

## Быстрый старт

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## От карты архитектуры — к практическим сценариям.

- [Четыре явные границы от намерения до завершения.](https://betterworkflows.dev/ru/docs/)
- [Быстрый старт](https://betterworkflows.dev/ru/docs/quick/)
- [От карты архитектуры — к практическим сценариям.](https://betterworkflows.dev/ru/docs/use-cases/)
- [Быстрый старт — От карты архитектуры — к практическим сценариям.](https://betterworkflows.dev/ru/docs/use-cases/quick/)
- [Кино доказательств](https://betterworkflows.dev/ru/docs/evidence-cinema/)

### Открыть документацию · `ru`

На этой справочной странице переведён обзор; интерактивное содержимое пока переведено не полностью.

- **01 · Четыре явные границы от намерения до завершения.** — Определите контракт, проверьте источник и доказательства, сверьте внешние эффекты и объявляйте завершение только при известном конечном состоянии.
- **02 · От карты архитектуры — к практическим сценариям.** — V5.0 RC1 доступна публично. Auto проверяет цель, область действия, репозиторий и риск, затем выбирает целевые проверки или evidence workflow. Изменения Git используют принадлежащий задаче worktree; для поставки требуются авторизация и подтверждённый внешний результат.
- **03 · Быстрый старт** — Better Workflows V5.0 RC1 доступна публично: бесплатный Auto-workflow с открытым исходным кодом для инженерного QA и поставки ИИ с актуальными доказательствами, review gates и согласованием провайдеров.

- [`Четыре явные границы от намерения до завершения.`](https://betterworkflows.dev/docs/reference/ru/index.html) · `ru`
- [`Быстрый старт`](https://betterworkflows.dev/docs/reference/ru/preview.html) · `ru`
- [`От карты архитектуры — к практическим сценариям.`](https://betterworkflows.dev/docs/reference/ru/use-cases/index.html) · `ru`
- [`Быстрый старт — От карты архитектуры — к практическим сценариям.`](https://betterworkflows.dev/docs/reference/ru/use-cases/preview.html) · `ru`
- [`Кино доказательств`](https://betterworkflows.dev/docs/reference/ru/evidence-cinema/index.html) · `ru`

- [Открыть документацию · `ru`](../details/ru.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### Открыть документацию · `en`



### Открыть документацию · `ru`

- [Политика безопасности](ru/security.md) · `ru`
- [Участие в разработке](ru/contributing.md) · `ru`
- [Управление](ru/governance.md) · `ru`
- [Кодекс поведения](ru/conduct.md) · `ru`
- [Уведомления о сторонних проектах](ru/notices.md) · `ru`
- [Схема построения качественного README](ru/readme-quality.md) · `ru`
- [Редакционная цветовая система](ru/color-system.md) · `ru`
- [Архитектура](ru/architecture.md) · `ru`
- [Безопасность](ru/security-guide.md) · `ru`
- [Справочник CLI](ru/cli-reference.md) · `ru`
- [Начало работы](ru/getting-started.md) · `ru`
- [Рабочие процессы](ru/workflows.md) · `ru`
- [Поддержка](ru/support.md) · `ru`

## Помогите поддерживать Better Workflows.

Разовая поддержка помогает развивать открытый код, документацию, локализацию на 41 язык и хостинг сайта. Она не дает членство или приоритет в roadmap и поддержке.

[Поддержать с помощью USDT (TRC20)](https://betterworkflows.dev/#sponsor)

---

Запуск команды не доказывает завершение; повторно проверяемый результат доказывает.
