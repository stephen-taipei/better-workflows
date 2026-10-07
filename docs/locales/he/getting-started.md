<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# מתחילים

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · **עברית** · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 מכסה את Codex\, Gemini CLI ו\-Qwen Code ב\-macOS × Node 22\/24\. ההסמכה של Claude Code\, Linux ו\-Windows נדחית ל\-V5\.1\. לצורך GA נדרשים לפחות 30 ימי canary טבעיים\, 20 הפעלות כשירות ברצף ושלושה מאגרים נפרדים\.

| [סקירה](../../../README.md) | [פרטים](../../../docs/details/en.md) | **התחלה מהירה** | [תהליכי עבודה](workflows.md) | [ארכיטקטורה](architecture.md) | [אבטחה](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[סקירה ב־41 גרסאות מותאמות לשפה ולאזור ונקודות גישה רשמיות באתר](../../../docs/LANGUAGES.md)\. הפקודות והמזהים נשארים בצורתם התקנית באנגלית\.

‏V5\.0 RC1 \(‏`5.0.0-rc.1`\, תגית `V5.0.rc1`\) זמין לציבור\. היקף השחרור מכסה את Auto בלבד\, יחד עם Codex\,‏ Gemini CLI ו\-Qwen Code ב\-macOS עם Node 22\/24\. ההתאמה \(qualification\) ל\-Linux ול\-Windows נדחית ל\-V5\.1\, וכך גם ההתאמה ל\-Claude Code\. גרסת GA `5.0.0` ממתינה לתיעוד של לפחות 30 ימי canary טבעיים\, 20 הפעלות כשירות ברצף ושלושה מאגרים נפרדים\.

## דרישות

- ‏Node\.js 22\.14 או גרסה חדשה יותר עבור כלי העזר המצורף `sbw`\.
- מאגר מקומי מהימן\. Better Workflows אינו מתיימר להפעיל בארגז חול \(sandbox\) קוד מאגר זדוני\.

תיקיית השורש של המצב ב־v4 אינה תלויה בפלטפורמת הסוכן\: אם הוגדר `SBW_STATE_ROOT`\, יש לו קדימות\; לאחריו משתמשים ב־`XDG_STATE_HOME/better-workflows`\, ואחרת ב־`~/.better-workflows`\. מיקום ברירת המחדל כבר אינו תחת `CODEX_HOME`\. כדי להמשיך להשתמש במצב v3 קיים של Codex בלי להעביר אותו\, הגדירו במפורש את `SBW_STATE_ROOT` לאותה תיקיית `<CODEX_HOME>/sbw` מדויקת לפני הפעלת `sbw`\.

‏V5\.0 GA \(‏`5.0.0`\) עדיין בהמתנה\. פקודות ההתקנה שלהלן מיועדות ל\-V5\.0 RC1 הזמין לציבור \(`5.0.0-rc.1`\, תגית `V5.0.rc1`\)\.

## התקנה

### Codex — סביבת הייחוס המומלצת

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

לאחר ההתקנה\, פתחו משימת Codex חדשה כדי לרענן את קטלוג המיומנויות שלה\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI מעתיק את ההרחבה\. הפעילו מחדש את ההפעלה לאחר ההתקנה\; לעדכון מאוחר יותר השתמשו ב־`gemini extensions update better-workflows`\.

הקשר ההרחבה מאתר את הגשר לפי נתיב המקור שממנו הוא עצמו נטען\, ולא לפי תיקיית העבודה של הפרויקט שלכם\. בהתקנה רגילה בהיקף משתמש\, הבדיקה הידנית המקבילה היא\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

בהרחבה מקושרת או בהיקף מרחב העבודה\, השתמשו בתיקיית השורש המדויקת של ההרחבה שמציגה פלטפורמת הסוכן\. אין להחליף אותה בעותק עבודה בעל שם דומה\.

### Qwen Code

נעלו את גרסת ההפצה לפני התקנת העותק המקומי של ההרחבה\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

גם Qwen Code מעתיק את ההרחבה\, לכן הפעילו מחדש את ההפעלה לאחר ההתקנה והשתמשו ב־`qwen extensions update better-workflows` לעדכונים בהמשך\.

בהתקנה רגילה בהיקף משתמש\, הבדיקה הידנית המקבילה של הגשר היא\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

אותו כלל המחייב שימוש בשורש המדויק חל גם על התקנות מקושרות או בהיקף מרחב העבודה\.

## שימוש ב\-Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

כל נקודת כניסה שומרת על ה־Goal שהתבקש\. יש לערוך או לנקות במפורש Goal פעיל שאינו קשור\; הוא לעולם אינו מוחלף בשקט\.

## תצוגה מקדימה של המסלול

תמונת מצב היכולות היא לקריאה בלבד ואינה מפעילה התחברות לספק או בדיקה סמנטית של המודל\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

לצורך העברה שניתן לסקור\, תעדו רשומה פרטית הניתנת לאימות ולשימוש חד־פעמי\, ואז השתמשו בה\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

תוקפן של הרשומות פג לאחר 24 שעות\. בשימוש חוזר או בסטייה במרחב העבודה\, בהיקף\, ב־Profiles\, בקטלוג\, ביכולות או בחבילת התוסף\, הפעולה נדחית\; אין אישור להמשיך במצב של אי־ודאות\.

## אימות ההתקנה

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## לפני שינוי במאגר

Auto מתחיל בבדיקה מקדימה של מרחב העבודה לקריאה בלבד\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

משימות שאינן קשורות ל־Git ומשימות לקריאה בלבד אינן יוצרות עץ עבודה\. משימת Git שמשנה מצב חייבת ליצור או לעשות שימוש חוזר ב־`TaskWorkspaceLeaseV1` שבבעלות המשימה\. אם תיקיית העבודה של המקור כוללת שינויים שטרם נכללו ב־commit\, התהליך נעצר לפני כל stash\, העתקה\, commit או יצירת עץ עבודה\. HEAD מנותק או יעד חסר מחייבים יעד אינטגרציה מפורש\. יעדים מוגנים או מרוחקים מועברים לתהליך מסירה דרך PR הכפוף לכללי ממשל\.

אם Codex או פלטפורמת סוכנים אחרת כבר יצרו עץ עבודה נקי למשימה הנוכחית\, רשמו אותו לפני העריכה במקום ליצור עץ עבודה מקונן\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

הרישום דורש ענף משימה נפרד מסוג `codex/*` שמצביע לבסיס שלא השתנה\, אותה תיקיית Git משותפת ועותק עבודה נקי של המקור\. Better Workflows משתמשת בעץ העבודה\, אך במהלך הניקוי שומרת על הענף והנתיב שבבעלות פלטפורמת הסוכן\. עבור יעד מוגן\, הפעילו תחילה את תהליך העבודה עם הראיות\, ואז קשרו את הרשומות המדויקות והניתנות לאימות שלו עבור מיזוג PR וסנכרון מרוחק באמצעות `workspace reconcile --run-id <run-id>`\.

הבא\: [בחרו את תהליך העבודה המתאים](workflows.md) או עיינו ב\-[מדריך ה\-CLI](cli-reference.md)\.
