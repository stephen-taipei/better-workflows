<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# المساهمة

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · **العربية**

شكراً لمساعدتك في تحسين Better Workflows\.

[README](../../../README.md) · **المساهمة** · [قواعد السلوك](conduct.md) · [الأمان](security.md) · [حوكمة المشروع](governance.md) · [الدعم](support.md)

[نظرة عامة في 41 نسخة موطّنة ونقاط الوصول الرسمية على الويب](../../../docs/LANGUAGES.md)\. تظل النسخة الإنجليزية هي المرجع المعتمد لسياسة المساهمة المعيارية هذه\.

## قبل البدء

- استخدم مشكلة \(issue\) أو مناقشة \(discussion\) أولاً عند اقتراح عقد عام جديد، أو تغيير في سلوك Auto العام، أو حد أمني، أو تغيير معماري كبير\.
- احرص على تركيز طلب السحب \(pull request\) الواحد على نتيجة واحدة\.
- لا تودع أبداً بيانات الاعتماد، أو التوجيهات الخاصة، أو سجل المحادثات الخام، أو مفاتيح توقيع المضيف، أو إيصالات المزود، أو الشهادات الموقعة\.
- أبلغ عن الثغرات الأمنية بشكل خاص كما هو موضح في [SECURITY\.md](security.md)\.

## إعداد بيئة التطوير

المتطلبات\:

- Node\.js 24 أو أحدث؛
- عدم وجود اعتماد على مكوّنات أطراف ثالثة وقت التشغيل؛
- فرع نظيف مبني على الفرع المستهدف الحالي\.

شغّل مجموعة الفحوص المرجعية المحلية كاملةً\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## قواعد التغيير

1. الحفاظ على عمليات التعديل المملوكة لـ Root وحدود الآثار الجانبية المحمية عند الفشل \(fail\-closed\)\.
2. عند تغيير سلوك Auto العام، حدّث قالبه ومهارته، ودليل نقاط الدخول، وواجهة CLI، والاختبارات، وجميع الوثائق المتأثرة معاً\.
3. ارفض خيارات CLI غير المعروفة وحقول المخطط غير المعروفة\.
4. احتفظ بحالة وقت التشغيل الخاصة خارج المستودع\.
5. أضف اختبارات سلبية لكل بوابة أمان جديدة\.
6. لا تعدّل إصدار ذاكرة التخزين المؤقت للملحق \(plugin\-cache\) غير القابل للتغيير\. يتطلب تغيير الحزمة إصدار بناء جديد والتحقق الدقيق من ملخص المصدر والتخزين المؤقت\.

عند الاقتصار على إعادة تنظيم README، أبقِ الصفحة الجذرية سهلة التصفح السريع وضع العقود المفصلة في الملف المناسب ضمن [`docs/guide/`](../../../docs/guide/)\.

## قائمة التحقق لطلب السحب

- [ ] النطاق وما لا يدخل ضمن الأهداف محددان بوضوح\.
- [ ] السلوك وحدود الأمان موثّقان\.
- [ ] الاختبارات المركّزة تغطي مسارات النجاح والفشل\.
- [ ] اجتازت مجموعة الاختبارات الكاملة و`sbw eval` الفحص بنجاح\.
- [ ] اجتاز `git diff --check` الفحص بنجاح\.
- [ ] تتبع تغييرات الإصدار\/ذاكرة التخزين المؤقت قواعد النشر التي تضمن عدم قابلية التغيير، عند انطباقها\.
- [ ] لا توجد أسرار أو حالة خاصة أو إيصالات خارجية\.

تُفضَّل الإيداعات الصغيرة التي يسهل مراجعتها\. لا تدمج أعمال تنظيف غير مرتبطة مع تغيير في السلوك\.
