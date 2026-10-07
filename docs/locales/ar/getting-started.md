<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# بدء الاستخدام

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · **العربية**

يغطي V5\.0 RC1 كلاً من Codex وGemini CLI وQwen Code على macOS × Node 22\/24\. بينما أُرجئ تأهيل Claude Code وLinux وWindows إلى V5\.1\. يتطلب GA ما لا يقل عن 30 يومًا كناريًا طبيعيًا، و20 تشغيلاً مؤهلاً متتاليًا، وثلاثة مستودعات متمايزة\.

| [نظرة عامة](../../../README.md) | [التفاصيل](../../../docs/details/en.md) | **البدء السريع** | [سير العمل](workflows.md) | [البنية](architecture.md) | [الأمان](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[نظرة عامة في 41 نسخة موطّنة ونقاط الوصول الرسمية على الويب](../../../docs/LANGUAGES.md)\. تبقى الأوامر والمعرّفات بصيغتها المرجعية باللغة الإنجليزية\.

إصدار V5\.0 RC1 \(`5.0.0-rc.1`، الوسم `V5.0.rc1`\) متاح للعموم\. يغطي نطاق إصداره Auto فقط، مع Codex وGemini CLI وQwen Code على macOS Node 22\/24\. تم تأجيل تأهيل Linux وWindows إلى V5\.1، بالإضافة إلى تأهيل Claude Code\. يظل الإصدار العام GA `5.0.0` معلقاً حتى تسجيل 30 يوماً طبيعياً على الأقل من اختبارات الكناري، و20 عملية تشغيل مؤهلة متتالية، وثلاثة مستودعات متميزة\.

## المتطلبات

- Node\.js 22\.14 أو أحدث للمساعد المضمن `sbw`\.
- مستودع محلي موثوق\. لا يدعي Better Workflows عزل الشيفرة البرمجية الضارة في المستودع داخل بيئة معزولة \(sandbox\)\.

الدليل الجذري للحالة في v4 مستقل عن منصة تشغيل الوكيل\: تكون الأولوية لـ `SBW_STATE_ROOT` عند تعيينه، ثم لـ `XDG_STATE_HOME/better-workflows`، وإلا يُستخدم `~/.better-workflows`\. ولم يعد موضعه الافتراضي داخل `CODEX_HOME`\. للاستمرار في استخدام حالة v3 الحالية الخاصة بـ Codex دون نقلها، اضبط `SBW_STATE_ROOT` صراحةً على دليل `<CODEX_HOME>/sbw` نفسه بدقة قبل استدعاء `sbw`\.

لا يزال إصدار V5\.0 GA \(`5.0.0`\) معلقاً\. تستهدف أوامر التثبيت أدناه إصدار V5\.0 RC1 المتاح للعموم \(`5.0.0-rc.1`، الوسم `V5.0.rc1`\)\.

## التثبيت

### Codex — البيئة المرجعية الموصى بها

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

افتح مهمة Codex جديدة بعد التثبيت لتحديث فهرس المهارات فيها\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

تنسخ Gemini CLI الامتداد\. أعد تشغيل الجلسة بعد التثبيت؛ واستخدم `gemini extensions update better-workflows` لتحديثه لاحقًا\.

يحدّد سياق الامتداد موقع الجسر انطلاقًا من مسار المصدر الذي حُمّل منه هو نفسه، وليس من دليل العمل في مشروعك\. في التثبيت القياسي على نطاق المستخدم، يكون الفحص اليدوي المكافئ كما يلي\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

بالنسبة إلى امتداد مرتبط أو مثبت على نطاق مساحة العمل، استخدم جذر الامتداد الدقيق الذي تعرضه منصة الوكيل\. لا تستبدله بنسخة عمل مسحوبة ذات اسم مشابه\.

### Qwen Code

ثبّت مرجع الإصدار قبل تثبيت النسخة المحلية من الامتداد\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

تنسخ Qwen Code الامتداد أيضًا، لذا أعد تشغيل الجلسة بعد التثبيت واستخدم `qwen extensions update better-workflows` للتحديثات اللاحقة\.

في التثبيت القياسي على نطاق المستخدم، يكون الفحص اليدوي المكافئ للجسر كما يلي\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

تنطبق قاعدة الجذر الدقيق نفسها على التثبيتات المرتبطة أو المثبتة على نطاق مساحة العمل\.

## استخدام Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

يحافظ كل مدخل على Goal المطلوب\. يجب تعديل أي Goal نشط غير ذي صلة أو مسحه صراحةً؛ ولا يجري استبداله ضمنيًا أبدًا\.

## معاينة المسار

لقطة القدرات للقراءة فقط، ولا تؤدي إلى تسجيل الدخول إلى المزوّد أو إجراء فحص دلالي للنموذج\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

لإجراء تسليم يمكن مراجعته، سجّل سجلًا خاصًا قابلًا للتحقق ومخصصًا للاستخدام مرة واحدة، ثم استخدمه\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

تنتهي صلاحية السجلات بعد 24 ساعة، وتُرفض العملية عند إعادة استخدامها أو حدوث انحراف في مساحة العمل أو النطاق أو Profiles أو الفهرس أو القدرات أو حزمة الإضافة؛ فلا يُسمح بالمتابعة في حالة عدم اليقين\.

## التحقق من التثبيت

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## قبل إجراء تغيير على المستودع

يبدأ Auto بفحص تمهيدي لمساحة العمل للقراءة فقط\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

لا تنشئ المهام غير المرتبطة بـ Git والمهام المخصصة للقراءة فقط شجرة عمل\. يجب على مهمة Git التي تُجري تغييرات إنشاء `TaskWorkspaceLeaseV1` مملوك للمهمة أو إعادة استخدامه\. إذا كان دليل عمل المصدر يحتوي على تغييرات لم تُضمَّن في commit، تتوقف العملية قبل أي stash أو نسخ أو إيداع أو إنشاء لشجرة عمل\. إذا كان HEAD منفصلًا أو كان الهدف مفقودًا، فيلزم تحديد هدف دمج صريح\. تُنقل الأهداف المحمية أو البعيدة إلى تسليم عبر PR خاضع للحوكمة\.

إذا كانت Codex أو منصة وكيل أخرى قد أنشأت بالفعل شجرة عمل نظيفة للمهمة الحالية، فسجّلها قبل التحرير بدلًا من إنشاء شجرة عمل متداخلة\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

يتطلب التسجيل فرع مهمة `codex/*` منفصلًا عند القاعدة التي لم تتغير، ودليل Git المشترك نفسه، ونسخة عمل مسحوبة نظيفة للمصدر\. تستخدم Better Workflows شجرة العمل، لكنها تحافظ أثناء التنظيف على الفرع والمسار اللذين تملكهما منصة الوكيل\. للهدف المحمي، شغّل سير عمل الأدلة أولًا، ثم اربط سجلاته الدقيقة القابلة للتحقق الخاصة بدمج PR والمزامنة البعيدة باستخدام `workspace reconcile --run-id <run-id>`\.

التالي\: [اختر سير العمل المناسب](workflows.md) أو تصفح [مرجع واجهة CLI](cli-reference.md)\.
