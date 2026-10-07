<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# תרומה לפרויקט

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · **עברית** · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

תודה על העזרה בשיפור Better Workflows\.

[README](../../../README.md) · **תרומה לפרויקט** · [כללי התנהגות](conduct.md) · [אבטחה](security.md) · [ניהול הפרויקט](governance.md) · [תמיכה](support.md)

[סקירה ב־41 גרסאות מותאמות לשפה ולאזור ונקודות גישה רשמיות באתר](../../../docs/LANGUAGES.md)\. הנוסח האנגלי הוא הנוסח הקובע של מדיניות תרומה נורמטיבית זו\.

## לפני שמתחילים

- השתמשו קודם ב\-issue או בדיון עבור חוזה ציבורי חדש\, שינוי בהתנהגות הציבורית של Auto\, גבול אבטחה או שינוי ארכיטקטוני משמעותי\.
- שמרו על כל pull request ממוקד בתוצאה אחת בלבד\.
- לעולם אל תבצעו commit לאישורי גישה \(credentials\)\, פרומפטים פרטיים\, היסטוריית שיחות גולמית\, מפתחות חתימה של מארח\, קבלות ספק או אימותים חתומים \(signed attestations\)\.
- דווחו על פגיעויות באופן פרטי כמתואר ב\-[SECURITY\.md](security.md)\.

## הגדרת סביבת הפיתוח

דרישות\:

- Node\.js 24 ומעלה\;
- ללא תלות ברכיבי צד שלישי בזמן ריצה\;
- ענף נקי המבוסס על ענף היעד הנוכחי\.

יש להריץ את מלוא בדיקות הבסיס המקומיות\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## כללי שינוי

1. שמרו על מוטציה בבעלות Root ועל גבולות תופעות לוואי במצב fail\-closed\.
2. כאשר ההתנהגות הציבורית של Auto משתנה\, עדכנו יחד את התבנית וה\-skill שלו\, קטלוג נקודות הכניסה\, ה\-CLI\, הבדיקות וכל התיעוד המושפע מכך\.
3. דחו אפשרויות CLI לא מוכרות ושדות schema לא מוכרים\.
4. שמרו מצב זמן ריצה פרטי \(private runtime state\) מחוץ למאגר\.
5. הוסיפו בדיקות שליליות \(negative tests\) עבור כל safety gate חדש\.
6. אל תשנו גרסה קיימת ובלתי ניתנת לשינוי של ה\-plugin\-cache\. חבילה שהשתנתה דורשת גרסת build חדשה ואימות מדויק של תמצית המקור והמטמון \(digest\)\.

כאשר מארגנים מחדש רק את README\, יש לשמור על עמוד השורש נוח לסקירה מהירה ולמקם חוזים מפורטים בקובץ המתאים תחת [`docs/guide/`](../../../docs/guide/)\.

## רשימת בדיקה לבקשת משיכה

- [ ] ההיקף ומה שאינו בגדר המטרות מוגדרים במפורש\.
- [ ] ההתנהגות וגבולות הבטיחות מתועדים\.
- [ ] בדיקות ממוקדות מכסות מסלולי הצלחה וכשל\.
- [ ] חבילת הבדיקות המלאה ו־`sbw eval` עוברים בהצלחה\.
- [ ] `git diff --check` עובר בהצלחה\.
- [ ] שינויי גרסה\/מטמון עומדים בכללי הפרסום המבטיחים אי־שינוי\, כאשר כללים אלה חלים\.
- [ ] לא נכללו סודות\, מצב פרטי או אישורי קבלה חיצוניים\.

עדיפות לשמירות גרסה קטנות שנוח לסקור\. אין לשלב עבודות ניקוי שאינן קשורות עם שינוי התנהגות\.
