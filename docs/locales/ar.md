<div align="center">

# Better Workflows

إصدار Better Workflows V5.0 RC1 متاح للعموم: سير عمل Auto مجاني ومفتوح المصدر لضمان الجودة وهندسة التسليم للذكاء الاصطناعي، مع أدلة محدثة وبوابات مراجعة ومطابقة المزودين.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · **العربية**

[استكشف الوثائق](https://betterworkflows.dev/ar/docs/) · [افتح GitHub](https://github.com/stephen-taipei/better-workflows) · [ادعم باستخدام USDT (TRC20)](https://betterworkflows.dev/#sponsor)

</div>

يغطي V5.0 RC1 كلاً من Codex وGemini CLI وQwen Code على macOS × Node 22/24. بينما أُرجئ تأهيل Claude Code وLinux وWindows إلى V5.1. يتطلب GA ما لا يقل عن 30 يومًا كناريًا طبيعيًا، و20 تشغيلاً مؤهلاً متتاليًا، وثلاثة مستودعات متمايزة.

## انقل عمل الوكيل<br>إلى إنجاز يمكن إثباته.

إصدار V5.0 RC1 متاح للعموم. يتحقق Auto من الهدف والنطاق والمستودع والمخاطر، ثم يحدد عمليات فحص موجهة أو سير عمل يستند إلى الأدلة. تستخدم تعديلات Git مساحة عمل worktree مخصصة للمهمة؛ ويتطلب التسليم تفويضًا ونتيجة خارجية مؤكدة.

## أربع حدود واضحة بين النية والإنجاز.

حدّد العقد، تحقّق من المصدر والأدلة، طابق الآثار الخارجية، ثم أعلن الاكتمال فقط عندما تكون الحالة النهائية معروفة.

- **01 · `TaskContract`** — إصدار V5.0 RC1 متاح للعموم. يتحقق Auto من الهدف والنطاق والمستودع والمخاطر، ثم يحدد عمليات فحص موجهة أو سير عمل يستند إلى الأدلة. تستخدم تعديلات Git مساحة عمل worktree مخصصة للمهمة؛ ويتطلب التسليم تفويضًا ونتيجة خارجية مؤكدة.
- **02 · `evidence`** — إصدار Better Workflows V5.0 RC1 متاح للعموم: سير عمل Auto مجاني ومفتوح المصدر لضمان الجودة وهندسة التسليم للذكاء الاصطناعي، مع أدلة محدثة وبوابات مراجعة ومطابقة المزودين.
- **03 · `reconciliation`** — حدّد العقد، تحقّق من المصدر والأدلة، طابق الآثار الخارجية، ثم أعلن الاكتمال فقط عندما تكون الحالة النهائية معروفة.
- **04 · `terminal state`** — تشغيل أمر ليس دليلاً على الاكتمال؛ النتيجة القابلة لإعادة التحقق هي الدليل.

## البدء السريع

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## تابع من الخريطة المعمارية إلى حالات الاستخدام العملية.

- [أربع حدود واضحة بين النية والإنجاز.](https://betterworkflows.dev/ar/docs/)
- [البدء السريع](https://betterworkflows.dev/ar/docs/quick/)
- [تابع من الخريطة المعمارية إلى حالات الاستخدام العملية.](https://betterworkflows.dev/ar/docs/use-cases/)
- [البدء السريع — تابع من الخريطة المعمارية إلى حالات الاستخدام العملية.](https://betterworkflows.dev/ar/docs/use-cases/quick/)
- [سينما الأدلة](https://betterworkflows.dev/ar/docs/evidence-cinema/)

### استكشف الوثائق · `ar`

تتضمن صفحة المرجع هذه نظرة عامة مترجمة، لكن محتواها التفاعلي لم يُترجم بالكامل بعد.

- **01 · أربع حدود واضحة بين النية والإنجاز.** — حدّد العقد، تحقّق من المصدر والأدلة، طابق الآثار الخارجية، ثم أعلن الاكتمال فقط عندما تكون الحالة النهائية معروفة.
- **02 · تابع من الخريطة المعمارية إلى حالات الاستخدام العملية.** — إصدار V5.0 RC1 متاح للعموم. يتحقق Auto من الهدف والنطاق والمستودع والمخاطر، ثم يحدد عمليات فحص موجهة أو سير عمل يستند إلى الأدلة. تستخدم تعديلات Git مساحة عمل worktree مخصصة للمهمة؛ ويتطلب التسليم تفويضًا ونتيجة خارجية مؤكدة.
- **03 · البدء السريع** — إصدار Better Workflows V5.0 RC1 متاح للعموم: سير عمل Auto مجاني ومفتوح المصدر لضمان الجودة وهندسة التسليم للذكاء الاصطناعي، مع أدلة محدثة وبوابات مراجعة ومطابقة المزودين.

- [`أربع حدود واضحة بين النية والإنجاز.`](https://betterworkflows.dev/docs/reference/ar/index.html) · `ar`
- [`البدء السريع`](https://betterworkflows.dev/docs/reference/ar/preview.html) · `ar`
- [`تابع من الخريطة المعمارية إلى حالات الاستخدام العملية.`](https://betterworkflows.dev/docs/reference/ar/use-cases/index.html) · `ar`
- [`البدء السريع — تابع من الخريطة المعمارية إلى حالات الاستخدام العملية.`](https://betterworkflows.dev/docs/reference/ar/use-cases/preview.html) · `ar`
- [`سينما الأدلة`](https://betterworkflows.dev/docs/reference/ar/evidence-cinema/index.html) · `ar`

- [استكشف الوثائق · `ar`](../details/ar.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### استكشف الوثائق · `en`



### استكشف الوثائق · `ar`

- [سياسة الأمان](ar/security.md) · `ar`
- [المساهمة](ar/contributing.md) · `ar`
- [الحوكمة](ar/governance.md) · `ar`
- [مدونة السلوك](ar/conduct.md) · `ar`
- [إشعارات الأطراف الثالثة](ar/notices.md) · `ar`
- [مخطط جودة README](ar/readme-quality.md) · `ar`
- [نظام ألوان تحريري](ar/color-system.md) · `ar`
- [الهندسة المعمارية](ar/architecture.md) · `ar`
- [الأمان](ar/security-guide.md) · `ar`
- [مرجع CLI](ar/cli-reference.md) · `ar`
- [بدء الاستخدام](ar/getting-started.md) · `ar`
- [مهام سير العمل](ar/workflows.md) · `ar`
- [الدعم](ar/support.md) · `ar`

## ساعد Better Workflows على الاستمرار.

يساعد الدعم لمرة واحدة في صيانة الشيفرة المفتوحة والوثائق والترجمة إلى 41 لغة واستضافة الموقع. ولا يمنح عضوية أو أولوية في خارطة الطريق أو الدعم.

[ادعم باستخدام USDT (TRC20)](https://betterworkflows.dev/#sponsor)

---

تشغيل أمر ليس دليلاً على الاكتمال؛ النتيجة القابلة لإعادة التحقق هي الدليل.
