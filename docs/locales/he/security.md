<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# מדיניות אבטחה

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · **עברית** · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [תרומה לפרויקט](contributing.md) · [כללי התנהגות](conduct.md) · **אבטחה** · [ניהול הפרויקט](governance.md) · [תמיכה](support.md)

[סקירה ב־41 גרסאות מותאמות לשפה ולאזור ונקודות גישה רשמיות באתר](../../../docs/LANGUAGES.md)\. הנוסח האנגלי הוא הנוסח הקובע של מדיניות אבטחה נורמטיבית זו\.

אם מקור הראיות היחיד המוצע כולל היסטוריה פרטית או חומר תפעולי רגיש שלא ניתן להסיר מהם מידע רגיש\, אין לאסוף או להעביר אותם\. יש לתעד רק נימוק ל־`REJECTED_WITH_EVIDENCE` שמידע רגיש הושחר בו\.

## גרסאות נתמכות

| גרסה | תמיכה |
| --- | --- |
| הגרסה האחרונה שפורסמה ותוצר הבנייה הבלתי ניתן לשינוי של Codex | נתמכים |
| גרסאות ישנות יותר של המטמון הבלתי ניתן לשינוי | יעדים לחזרה לגרסה קודמת\; תיקונים לא יועברו לגרסאות ישנות אלא אם יוכרז על כך במפורש |
| פיצולים שטרם פורסמו או תוכן מטמון ששונה | אינם נתמכים |

## דיווח על חולשת אבטחה

יש להשתמש [בדיווח פרטי על חולשות אבטחה ב־GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. אין לפתוח דיווח תקלה פומבי לגבי חשד לחולשת אבטחה\.

יש לכלול\:

- הגרסה ותוצר הבנייה של התוסף שהושפעו\;
- הסביבה וגרסת Node\.js\;
- שלבי שחזור מינימליים\;
- גבול האבטחה הצפוי וזה שנצפה בפועל\;
- ההשפעה וכל פתרון עוקף ידוע\;
- האם הדיווח מכיל חומר סודי\.

אין לכלול פרטי הזדהות פעילים\, מפתחות חתימה\, אסימוני ספקים\, הנחיות פרטיות גולמיות או מידע אישי של צדדים שלישיים\.

## מענה

מתחזק הפרויקט יאשר קבלת דיווח שניתן לטפל בו\, יאמת את היקפו\, ויתאם את התיקון והחשיפה\. אין התחייבות ל־SLA עם זמן תגובה קבוע\. כאשר התוצאות אינן ידועות או טרם הושלמה הצלבתן\, הביצוע נשאר חסום בהיעדר אימות\.

## גבולות אבטחה

Better Workflows מניח שהמאגר המקומי\, המחשב המארח ושרשרת הכלים הניתנים להרצה מהימנים\. מודל ההרשאות של Node הוא אמצעי להגנה רב־שכבתית\, ואינו ארגז חול של מערכת ההפעלה לקוד זדוני\. ראו את [מדריך האבטחה](security-guide.md) המלא\.
