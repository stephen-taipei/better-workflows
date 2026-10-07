<div align="center">

# Better Workflows

‏Better Workflows V5.0 RC1 זמין כעת לציבור: תהליך עבודה Auto חינמי ובקוד פתוח ל-QA ולמסירה בהנדסת AI, עם ראיות עדכניות, review gates והתאמה מול ספקים (provider reconciliation).

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · **עברית** · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[עיון בתיעוד](https://betterworkflows.dev/he/docs/) · [פתיחת GitHub](https://github.com/stephen-taipei/better-workflows) · [תמיכה באמצעות USDT (TRC20)](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 מכסה את Codex, Gemini CLI ו-Qwen Code ב-macOS × Node 22/24. ההסמכה של Claude Code, Linux ו-Windows נדחית ל-V5.1. לצורך GA נדרשים לפחות 30 ימי canary טבעיים, 20 הפעלות כשירות ברצף ושלושה מאגרים נפרדים.

## הובילו את עבודת ה-agent<br>לסיום שניתן להוכיח.

‏V5.0 RC1 זמין לציבור. Auto בודק את היעד, ההיקף, המאגר והסיכון, ולאחר מכן בוחר בדיקות ממוקדות או תהליך עבודה מבוסס ראיות (evidence workflow). שינויי Git משתמשים ב-worktree בבעלות המשימה; המסירה דורשת הרשאה ותוצאה חיצונית מאומתת.

## ארבעה גבולות ברורים בין כוונה להשלמה.

הגדירו את החוזה, אמתו את המקור והראיות, התאימו את ההשפעות החיצוניות והכריזו על השלמה רק כשהמצב הסופי ידוע.

- **01 · `TaskContract`** — ‏V5.0 RC1 זמין לציבור. Auto בודק את היעד, ההיקף, המאגר והסיכון, ולאחר מכן בוחר בדיקות ממוקדות או תהליך עבודה מבוסס ראיות (evidence workflow). שינויי Git משתמשים ב-worktree בבעלות המשימה; המסירה דורשת הרשאה ותוצאה חיצונית מאומתת.
- **02 · `evidence`** — ‏Better Workflows V5.0 RC1 זמין כעת לציבור: תהליך עבודה Auto חינמי ובקוד פתוח ל-QA ולמסירה בהנדסת AI, עם ראיות עדכניות, review gates והתאמה מול ספקים (provider reconciliation).
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
- [קולנוע הראיות](https://betterworkflows.dev/he/docs/evidence-cinema/)

### עיון בתיעוד · `he`

בדף העזר הזה יש סקירה מתורגמת; התוכן האינטראקטיבי עדיין לא תורגם במלואו.

- **01 · ארבעה גבולות ברורים בין כוונה להשלמה.** — הגדירו את החוזה, אמתו את המקור והראיות, התאימו את ההשפעות החיצוניות והכריזו על השלמה רק כשהמצב הסופי ידוע.
- **02 · עברו ממפת הארכיטקטורה למקרי שימוש מעשיים.** — ‏V5.0 RC1 זמין לציבור. Auto בודק את היעד, ההיקף, המאגר והסיכון, ולאחר מכן בוחר בדיקות ממוקדות או תהליך עבודה מבוסס ראיות (evidence workflow). שינויי Git משתמשים ב-worktree בבעלות המשימה; המסירה דורשת הרשאה ותוצאה חיצונית מאומתת.
- **03 · התחלה מהירה** — ‏Better Workflows V5.0 RC1 זמין כעת לציבור: תהליך עבודה Auto חינמי ובקוד פתוח ל-QA ולמסירה בהנדסת AI, עם ראיות עדכניות, review gates והתאמה מול ספקים (provider reconciliation).

- [`ארבעה גבולות ברורים בין כוונה להשלמה.`](https://betterworkflows.dev/docs/reference/he/index.html) · `he`
- [`התחלה מהירה`](https://betterworkflows.dev/docs/reference/he/preview.html) · `he`
- [`עברו ממפת הארכיטקטורה למקרי שימוש מעשיים.`](https://betterworkflows.dev/docs/reference/he/use-cases/index.html) · `he`
- [`התחלה מהירה — עברו ממפת הארכיטקטורה למקרי שימוש מעשיים.`](https://betterworkflows.dev/docs/reference/he/use-cases/preview.html) · `he`
- [`קולנוע הראיות`](https://betterworkflows.dev/docs/reference/he/evidence-cinema/index.html) · `he`

- [עיון בתיעוד · `he`](../details/he.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### עיון בתיעוד · `en`



### עיון בתיעוד · `he`

- [מדיניות אבטחה](he/security.md) · `he`
- [תרומה לפרויקט](he/contributing.md) · `he`
- [ממשל הפרויקט](he/governance.md) · `he`
- [קוד התנהגות](he/conduct.md) · `he`
- [הודעות בנוגע לצדדים שלישיים](he/notices.md) · `he`
- [מתווה איכות עבור README](he/readme-quality.md) · `he`
- [מערכת צבעים עריכתית](he/color-system.md) · `he`
- [ארכיטקטורה](he/architecture.md) · `he`
- [אבטחה](he/security-guide.md) · `he`
- [מדריך CLI](he/cli-reference.md) · `he`
- [מתחילים](he/getting-started.md) · `he`
- [תהליכי עבודה](he/workflows.md) · `he`
- [תמיכה](he/support.md) · `he`

## עזרו לשמור על Better Workflows מתוחזק.

תמיכה חד-פעמית מסייעת בתחזוקת הקוד הפתוח, התיעוד, הלוקליזציה ל-41 שפות ואחסון האתר. היא אינה מקנה חברות או קדימות במפת הדרכים או בתמיכה.

[תמיכה באמצעות USDT (TRC20)](https://betterworkflows.dev/#sponsor)

---

פקודה שרצה אינה הוכחה להשלמה; תוצאה שניתן לאמת שוב היא כן.
