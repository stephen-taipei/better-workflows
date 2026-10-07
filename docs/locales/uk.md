<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 уже доступна публічно: безкоштовний робочий процес Auto з відкритим кодом для QA та доставки в AI-інженерії, з актуальними доказами, review gates та узгодженням провайдерів.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · **Українська** · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Переглянути документацію](https://betterworkflows.dev/uk/docs/) · [Відкрити GitHub](https://github.com/stephen-taipei/better-workflows) · [Підтримати за допомогою USDT (TRC20)](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 підтримує Codex, Gemini CLI та Qwen Code на macOS × Node 22/24. Кваліфікацію Claude Code, Linux та Windows відкладено до V5.1. Для GA потрібно щонайменше 30 природних днів канарейки, 20 послідовних відповідних запусків і три різні репозиторії.

## Доведіть роботу агентів<br>до доказового завершення.

V5.0 RC1 доступна публічно. Auto перевіряє мету, обсяг, репозиторій і ризик, після чого обирає цільові перевірки або робочий процес на основі доказів. Зміни Git використовують власний worktree завдання; для доставки потрібні авторизація та підтверджений зовнішній результат.

## Чотири чіткі межі від наміру до завершення.

Визначте контракт, перевірте джерело й докази, узгодьте зовнішні ефекти та оголошуйте завершення лише коли кінцевий стан відомий.

- **01 · `TaskContract`** — V5.0 RC1 доступна публічно. Auto перевіряє мету, обсяг, репозиторій і ризик, після чого обирає цільові перевірки або робочий процес на основі доказів. Зміни Git використовують власний worktree завдання; для доставки потрібні авторизація та підтверджений зовнішній результат.
- **02 · `evidence`** — Better Workflows V5.0 RC1 уже доступна публічно: безкоштовний робочий процес Auto з відкритим кодом для QA та доставки в AI-інженерії, з актуальними доказами, review gates та узгодженням провайдерів.
- **03 · `reconciliation`** — Визначте контракт, перевірте джерело й докази, узгодьте зовнішні ефекти та оголошуйте завершення лише коли кінцевий стан відомий.
- **04 · `terminal state`** — Виконана команда не доводить завершення; повторно перевірюваний результат доводить.

## Швидкий старт

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## Від мапи архітектури — до практичних сценаріїв.

- [Чотири чіткі межі від наміру до завершення.](https://betterworkflows.dev/uk/docs/)
- [Швидкий старт](https://betterworkflows.dev/uk/docs/quick/)
- [Від мапи архітектури — до практичних сценаріїв.](https://betterworkflows.dev/uk/docs/use-cases/)
- [Швидкий старт — Від мапи архітектури — до практичних сценаріїв.](https://betterworkflows.dev/uk/docs/use-cases/quick/)
- [Кіно доказів](https://betterworkflows.dev/uk/docs/evidence-cinema/)

### Переглянути документацію · `uk`

Ця довідкова сторінка має локалізований огляд; її інтерактивний вміст ще не перекладено повністю.

- **01 · Чотири чіткі межі від наміру до завершення.** — Визначте контракт, перевірте джерело й докази, узгодьте зовнішні ефекти та оголошуйте завершення лише коли кінцевий стан відомий.
- **02 · Від мапи архітектури — до практичних сценаріїв.** — V5.0 RC1 доступна публічно. Auto перевіряє мету, обсяг, репозиторій і ризик, після чого обирає цільові перевірки або робочий процес на основі доказів. Зміни Git використовують власний worktree завдання; для доставки потрібні авторизація та підтверджений зовнішній результат.
- **03 · Швидкий старт** — Better Workflows V5.0 RC1 уже доступна публічно: безкоштовний робочий процес Auto з відкритим кодом для QA та доставки в AI-інженерії, з актуальними доказами, review gates та узгодженням провайдерів.

- [`Чотири чіткі межі від наміру до завершення.`](https://betterworkflows.dev/docs/reference/uk/index.html) · `uk`
- [`Швидкий старт`](https://betterworkflows.dev/docs/reference/uk/preview.html) · `uk`
- [`Від мапи архітектури — до практичних сценаріїв.`](https://betterworkflows.dev/docs/reference/uk/use-cases/index.html) · `uk`
- [`Швидкий старт — Від мапи архітектури — до практичних сценаріїв.`](https://betterworkflows.dev/docs/reference/uk/use-cases/preview.html) · `uk`
- [`Кіно доказів`](https://betterworkflows.dev/docs/reference/uk/evidence-cinema/index.html) · `uk`

- [Переглянути документацію · `uk`](../details/uk.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### Переглянути документацію · `en`



### Переглянути документацію · `uk`

- [Політика безпеки](uk/security.md) · `uk`
- [Участь у розробці](uk/contributing.md) · `uk`
- [Управління](uk/governance.md) · `uk`
- [Кодекс поведінки](uk/conduct.md) · `uk`
- [Повідомлення про сторонні проєкти](uk/notices.md) · `uk`
- [План забезпечення якості README](uk/readme-quality.md) · `uk`
- [Редакційна система кольорів](uk/color-system.md) · `uk`
- [Архітектура](uk/architecture.md) · `uk`
- [Безпека](uk/security-guide.md) · `uk`
- [Довідник CLI](uk/cli-reference.md) · `uk`
- [Початок роботи](uk/getting-started.md) · `uk`
- [Робочі процеси](uk/workflows.md) · `uk`
- [Підтримка](uk/support.md) · `uk`

## Допоможіть підтримувати Better Workflows.

Одноразова підтримка допомагає відкритому коду, документації, локалізації 41 мовою та хостингу сайту. Вона не надає членства чи пріоритету в roadmap або підтримці.

[Підтримати за допомогою USDT (TRC20)](https://betterworkflows.dev/#sponsor)

---

Виконана команда не доводить завершення; повторно перевірюваний результат доводить.
