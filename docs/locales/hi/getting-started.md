<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# शुरुआत करें

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · **हिन्दी** · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 macOS × Node 22\/24 पर Codex\, Gemini CLI और Qwen Code को कवर करता है। Claude Code\, Linux और Windows की अर्हता V5\.1 तक के लिए स्थगित है। GA के लिए कम से कम 30 प्राकृतिक canary दिन\, लगातार 20 योग्य शुरुआत और तीन अलग\-अलग रिपॉजिटरी आवश्यक हैं।

| [अवलोकन](../../../README.md) | [विवरण](../../../docs/details/en.md) | **त्वरित शुरुआत** | [कार्यप्रवाह](workflows.md) | [आर्किटेक्चर](architecture.md) | [सुरक्षा](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[41 स्थानीयकृत संस्करणों का अवलोकन और आधिकारिक वेब प्रवेश बिंदु](../../../docs/LANGUAGES.md)। कमांड और पहचानकर्ता अंग्रेज़ी में अपने प्रामाणिक मानक रूप में बने रहते हैं।

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) सार्वजनिक रूप से उपलब्ध है। इसका रिलीज़ दायरा केवल Auto को कवर करता है\, जिसमें macOS Node 22\/24 पर Codex\, Gemini CLI\, और Qwen Code शामिल हैं। Linux और Windows योग्यता \(qualification\) को V5\.1 तक के लिए टाल दिया गया है\, जैसा कि Claude Code योग्यता के लिए भी है। GA `5.0.0` तब तक लंबित रहेगा जब तक कि कम से कम 30 प्राकृतिक कैनरी दिन\, लगातार 20 योग्य शुरुआत\, और तीन अलग\-अलग रिपॉजिटरी रिकॉर्ड नहीं किए जाते।

## आवश्यकताएँ

- बंडल किए गए `sbw` हेल्पर के लिए Node\.js 22\.14 या नया संस्करण।
- एक विश्वसनीय स्थानीय रिपॉजिटरी। Better Workflows दुर्भावनापूर्ण रिपॉजिटरी कोड को सैंडबॉक्स करने का दावा नहीं करता है।

v4 की स्थिति रखने वाली रूट डायरेक्टरी एजेंट प्लेटफ़ॉर्म से स्वतंत्र है\: `SBW_STATE_ROOT` सेट होने पर उसे प्राथमिकता मिलती है\, फिर `XDG_STATE_HOME/better-workflows` को\, और अन्यथा `~/.better-workflows` को। यह अब डिफ़ॉल्ट रूप से `CODEX_HOME` के अंतर्गत नहीं होती। Codex की मौजूदा v3 स्थिति को बिना स्थानांतरित किए इस्तेमाल करते रहने के लिए\, `sbw` चलाने से पहले `SBW_STATE_ROOT` को स्पष्ट रूप से उसी सटीक `<CODEX_HOME>/sbw` डायरेक्टरी पर सेट करें।

V5\.0 GA \(`5.0.0`\) अभी भी लंबित है। नीचे दिए गए इंस्टॉलेशन कमांड सार्वजनिक रूप से उपलब्ध V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) को लक्षित करते हैं।

## इंस्टॉल करें

### Codex — सुझाया गया संदर्भ

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

इंस्टॉलेशन के बाद Codex में नया कार्य खोलें\, ताकि उसकी कौशल\-सूची अपडेट हो जाए।

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI एक्सटेंशन की प्रतिलिपि बनाता है। इंस्टॉलेशन के बाद सत्र पुनः शुरू करें\; बाद में उसे अपडेट करने के लिए `gemini extensions update better-workflows` इस्तेमाल करें।

एक्सटेंशन का संदर्भ ब्रिज का पता अपने लोड किए गए स्रोत के पथ से निर्धारित करता है\, आपके प्रोजेक्ट की कार्य डायरेक्टरी से नहीं। सामान्य उपयोगकर्ता\-स्तरीय इंस्टॉलेशन के लिए समकक्ष मैन्युअल जाँच यह है\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

लिंक किए गए या कार्यक्षेत्र\-स्तरीय एक्सटेंशन के लिए वही सटीक एक्सटेंशन रूट इस्तेमाल करें जो एजेंट प्लेटफ़ॉर्म दिखाता है। उसकी जगह मिलते\-जुलते नाम वाला चेकआउट इस्तेमाल न करें।

### Qwen Code

एक्सटेंशन की स्थानीय प्रतिलिपि इंस्टॉल करने से पहले रिलीज़ को किसी निश्चित संस्करण पर पिन करें\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code भी एक्सटेंशन की प्रतिलिपि बनाता है\, इसलिए इंस्टॉलेशन के बाद सत्र पुनः शुरू करें और बाद के अपडेट के लिए `qwen extensions update better-workflows` इस्तेमाल करें।

सामान्य उपयोगकर्ता\-स्तरीय इंस्टॉलेशन के लिए ब्रिज की समकक्ष मैन्युअल जाँच यह है\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

सटीक रूट का यही नियम लिंक किए गए या कार्यक्षेत्र\-स्तरीय इंस्टॉलेशन पर भी लागू होता है।

## Auto का उपयोग करें

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

हर प्रारंभ विकल्प अनुरोधित Goal को बनाए रखता है। किसी असंबंधित सक्रिय Goal को स्पष्ट रूप से संपादित या साफ़ करना होगा\; उसे कभी चुपचाप बदला नहीं जाता।

## मार्ग का पूर्वावलोकन करें

क्षमताओं का स्नैपशॉट लेने की प्रक्रिया केवल पढ़ने वाली कार्रवाइयाँ करती है और प्रदाता के यहाँ लॉगिन या मॉडल की सेमांटिक जाँच शुरू नहीं करती\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

समीक्षा योग्य हस्तांतरण के लिए एक निजी\, सत्यापन योग्य\, एकबारगी रिकॉर्ड दर्ज करें और उसका उपयोग करें\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

रिकॉर्ड 24 घंटे बाद अमान्य हो जाते हैं। दोबारा उपयोग या कार्यक्षेत्र\, दायरे\, Profiles\, कैटलॉग\, क्षमताओं या प्लगइन बंडल में विचलन होने पर सुरक्षा के लिए उनका उपयोग अस्वीकार कर दिया जाता है।

## इंस्टॉलेशन सत्यापित करें

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## रिपॉज़िटरी में बदलाव करने से पहले

Auto कार्यक्षेत्र की ऐसी प्रारंभिक जाँच से शुरू होता है जो केवल पढ़ती है\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

जो कार्य Git का उपयोग नहीं करते या केवल पढ़ते हैं\, वे worktree नहीं बनाते। बदलाव करने वाले Git कार्य को कार्य के स्वामित्व वाला `TaskWorkspaceLeaseV1` बनाना या दोबारा उपयोग करना होगा। यदि स्रोत की कार्यशील डायरेक्टरी में ऐसे बदलाव हैं जिनका commit नहीं हुआ है\, तो किसी भी stash\, कॉपी\, commit या worktree निर्माण से पहले प्रक्रिया रुक जाती है। अलग हुआ HEAD या लक्ष्य का न होना स्पष्ट रूप से निर्धारित एकीकरण लक्ष्य की माँग करता है। संरक्षित या दूरस्थ लक्ष्यों को नियमों के अधीन PR डिलीवरी में स्थानांतरित किया जाता है।

यदि Codex या किसी दूसरे एजेंट प्लेटफ़ॉर्म ने वर्तमान कार्य का साफ़ worktree पहले ही बना दिया है\, तो नेस्टेड worktree बनाने के बजाय संपादन से पहले उसे पंजीकृत करें\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

पंजीकरण के लिए अपरिवर्तित आधार पर एक अलग `codex/*` कार्य शाखा\, समान साझा Git डायरेक्टरी और स्रोत का साफ़ चेकआउट आवश्यक है। Better Workflows worktree का इस्तेमाल करता है\, लेकिन सफ़ाई के दौरान एजेंट प्लेटफ़ॉर्म के स्वामित्व वाली शाखा और पथ को बनाए रखता है। संरक्षित लक्ष्य के लिए पहले साक्ष्य कार्यप्रवाह चलाएँ\, फिर उसके PR मर्ज और दूरस्थ सिंक के सटीक सत्यापन योग्य रिकॉर्ड को `workspace reconcile --run-id <run-id>` से संबद्ध करें।

आगे\: [सही वर्कफ़्लो चुनें](workflows.md) या [CLI संदर्भ](cli-reference.md) ब्राउज़ करें।
