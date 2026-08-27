<div align="center">

# Better Workflows

שכבת בקרה בקוד פתוח ובגישת goal-first לתהליכי agent, עם ראיות עדכניות, שערי ביקורת והתאמה מול הספק.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · **עברית** · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[עיון בתיעוד](https://betterworkflows.dev/he/docs/) · [פתיחת GitHub](https://github.com/stephen-taipei/better-workflows) · [תמיכה דרך Ko-fi](https://ko-fi.com/betterworkflows)

</div>

## הובילו את עבודת ה-agent<br>לסיום שניתן להוכיח.

Better Workflows מקבע את היעד, ההיקף והסמכות, וקושר כל החלטה לראיות עדכניות שניתן לאמת שוב ולתוצאה חיצונית שעברה התאמה.

## ארבעה גבולות ברורים בין כוונה להשלמה.

הגדירו את החוזה, אמתו את המקור והראיות, התאימו את ההשפעות החיצוניות והכריזו על השלמה רק כשהמצב הסופי ידוע.

- **01 · `TaskContract`** — Better Workflows מקבע את היעד, ההיקף והסמכות, וקושר כל החלטה לראיות עדכניות שניתן לאמת שוב ולתוצאה חיצונית שעברה התאמה.
- **02 · `evidence`** — שכבת בקרה בקוד פתוח ובגישת goal-first לתהליכי agent, עם ראיות עדכניות, שערי ביקורת והתאמה מול הספק.
- **03 · `reconciliation`** — הגדירו את החוזה, אמתו את המקור והראיות, התאימו את ההשפעות החיצוניות והכריזו על השלמה רק כשהמצב הסופי ידוע.
- **04 · `terminal state`** — פקודה שרצה אינה הוכחה להשלמה; תוצאה שניתן לאמת שוב היא כן.

## התחלה מהירה

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## עברו ממפת הארכיטקטורה למקרי שימוש מעשיים.

- [ארבעה גבולות ברורים בין כוונה להשלמה.](https://betterworkflows.dev/he/docs/)
- [התחלה מהירה](https://betterworkflows.dev/he/docs/quick/)
- [עברו ממפת הארכיטקטורה למקרי שימוש מעשיים.](https://betterworkflows.dev/he/docs/use-cases/)
- [התחלה מהירה — עברו ממפת הארכיטקטורה למקרי שימוש מעשיים.](https://betterworkflows.dev/he/docs/use-cases/quick/)
- [Evidence Cinema](https://betterworkflows.dev/he/docs/evidence-cinema/)


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
- [פתיחת GitHub](https://github.com/stephen-taipei/better-workflows)

## עזרו לתחזק את Better Workflows לאורך זמן.

תמיכה חד-פעמית מסייעת בתחזוקת הקוד הפתוח, התיעוד, 41 גרסאות מותאמות לאזור ואחסון האתר. היא אינה מקנה חברות או קדימות במפת הדרכים או בתמיכה.

[תמיכה דרך Ko-fi](https://ko-fi.com/betterworkflows)

---

פקודה שרצה אינה הוכחה להשלמה; תוצאה שניתן לאמת שוב היא כן.
