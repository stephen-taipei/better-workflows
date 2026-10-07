<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# سياسة الأمان

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · **العربية**

[README](../../../README.md) · [المساهمة](contributing.md) · [قواعد السلوك](conduct.md) · **الأمان** · [حوكمة المشروع](governance.md) · [الدعم](support.md)

[نظرة عامة في 41 نسخة موطّنة ونقاط الوصول الرسمية على الويب](../../../docs/LANGUAGES.md)\. تظل النسخة الإنجليزية هي المرجع المعتمد لهذه السياسة الأمنية المعيارية\.

إذا كان مصدر الأدلة الوحيد المقترح يتضمن سجلاً خاصاً أو مواد تشغيلية حساسة لا يمكن تنقيحها لإزالة المعلومات الحساسة، فلا تجمعها ولا ترسلها\. سجّل فقط مبرراً منقّحاً لإزالة المعلومات الحساسة للحالة `REJECTED_WITH_EVIDENCE`\.

## الإصدارات المدعومة

| الإصدار | الدعم |
| --- | --- |
| أحدث إصدار منشور ونسخة بناء Codex غير القابلة للتغيير | مدعوم |
| الإصدارات الأقدم من ذاكرة التخزين المؤقت غير القابلة للتغيير | أهداف للرجوع إلى إصدار سابق؛ لا تُنقل الإصلاحات إلى الإصدارات الأقدم إلا إذا أُعلن عن ذلك صراحةً |
| التفريعات غير المنشورة أو المحتويات المعدّلة لذاكرة التخزين المؤقت | غير مدعوم |

## الإبلاغ عن ثغرة أمنية

يرجى استخدام [الإبلاغ الخاص عن الثغرات الأمنية في GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. لا تفتح بلاغاً عاماً بشأن ثغرة مشتبه بها\.

أدرج ما يلي\:

- الإصدار المتأثر ونسخة بناء المكوّن الإضافي؛
- البيئة وإصدار Node\.js؛
- الحد الأدنى من خطوات إعادة إنتاج المشكلة؛
- حدود الأمان المتوقعة وتلك المرصودة فعلياً؛
- التأثير وأي حل التفافي معروف؛
- ما إذا كان التقرير يتضمن مواد سرية\.

لا تُدرج بيانات اعتماد فعّالة أو مفاتيح توقيع أو رموز وصول خاصة بالمزوّدين أو موجّهات خاصة خام أو بيانات شخصية لأطراف ثالثة\.

## الاستجابة

سيؤكد المشرف على الصيانة استلام التقرير القابل للمعالجة، ويتحقق من نطاقه، وينسّق المعالجة والإفصاح\. لا يُقدَّم وعد بـ SLA يحدد زمناً ثابتاً للاستجابة\. عندما تكون النتائج مجهولة أو لم تُستكمل مطابقتها، يظل التنفيذ مرفوضاً ما دام غير متحقق منه\.

## الحدود الأمنية

يفترض Better Workflows أن المستودع المحلي والمضيف وسلسلة الأدوات القابلة للتنفيذ موثوقة\. نموذج الأذونات في Node هو وسيلة للدفاع متعدد الطبقات، وليس بيئة عزل على مستوى نظام التشغيل للشيفرة الخبيثة\. راجع [دليل الأمان](security-guide.md) الكامل\.
