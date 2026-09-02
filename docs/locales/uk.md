<div align="center">

# Better Workflows

AI-агент підбирає силу перевірки за ризиком і безпечно завершує роботу в ізольованому середовищі. Прості зміни виконуються швидко; важлива робота проходить evidence gates; зміни Git типово використовують окремий worktree.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · **Українська** · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Переглянути документацію](https://betterworkflows.dev/uk/docs/) · [Відкрити GitHub](https://github.com/stephen-taipei/better-workflows) · [Підтримати на Ko-fi](https://ko-fi.com/betterworkflows)

</div>

## Доведіть роботу агентів<br>до доказового завершення.

Better Workflows фіксує ціль, область і повноваження та пов’язує кожне рішення з актуальними, повторно перевірюваними доказами й узгодженим зовнішнім результатом.

## Чотири чіткі межі від наміру до завершення.

Визначте контракт, перевірте джерело й докази, узгодьте зовнішні ефекти та оголошуйте завершення лише коли кінцевий стан відомий.

- **01 · `TaskContract`** — Better Workflows фіксує ціль, область і повноваження та пов’язує кожне рішення з актуальними, повторно перевірюваними доказами й узгодженим зовнішнім результатом.
- **02 · `evidence`** — AI-агент підбирає силу перевірки за ризиком і безпечно завершує роботу в ізольованому середовищі. Прості зміни виконуються швидко; важлива робота проходить evidence gates; зміни Git типово використовують окремий worktree.
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
- [Evidence Cinema](https://betterworkflows.dev/uk/docs/evidence-cinema/)


- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### `GUIDES · en`

- [`getting-started`](../guide/getting-started.md) · `en`
- [`workflows`](../guide/workflows.md) · `en`
- [`architecture`](../guide/architecture.md) · `en`
- [`security`](../guide/security.md) · `en`
- [`cli-reference`](../guide/cli-reference.md) · `en`
- [`readme-quality`](../guide/readme-quality.md) · `en`

### `POLICIES · en`

- [`CODE_OF_CONDUCT`](../../CODE_OF_CONDUCT.md) · `en`
- [`CONTRIBUTING`](../../CONTRIBUTING.md) · `en`
- [`GOVERNANCE`](../../GOVERNANCE.md) · `en`
- [`SECURITY`](../../SECURITY.md) · `en`
- [`SUPPORT`](../../SUPPORT.md) · `en`
- [`THIRD_PARTY_NOTICES`](../../THIRD_PARTY_NOTICES.md) · `en`
- [`ANSIBLE`](../../deploy/ansible/README.md) · `en`

### `RUNTIME SOURCE · en`

- [`plugins/better-workflows/skills/`](../../plugins/better-workflows/skills/)
- [`evidence-cinema/imagegen-manifest`](../html/evidence-cinema/assets/imagegen-manifest.md)
- [`use-cases/color-system`](../html/use-cases/assets/color-system.md)
- [`use-cases/imagegen-manifest`](../html/use-cases/assets/imagegen-manifest.md)
- [Відкрити GitHub](https://github.com/stephen-taipei/better-workflows)

## Допоможіть підтримувати Better Workflows.

Одноразова підтримка допомагає підтримувати відкритий код, документацію, 41 локалізовану версію та хостинг сайту. Вона не надає статусу учасника чи пріоритету в плані розвитку або підтримці.

[Підтримати на Ko-fi](https://ko-fi.com/betterworkflows)

---

Виконана команда не доводить завершення; повторно перевірюваний результат доводить.
