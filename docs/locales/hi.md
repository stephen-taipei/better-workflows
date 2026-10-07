<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 सार्वजनिक रूप से उपलब्ध है: AI engineering QA और delivery के लिए एक निःशुल्क, खुला-स्रोत (open-source) Auto वर्कफ़्लो, जिसमें वर्तमान साक्ष्य (current evidence), समीक्षा द्वार (review gates) और प्रदाता समाधान (provider reconciliation) शामिल हैं।

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · **हिन्दी** · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[दस्तावेज़ देखें](https://betterworkflows.dev/hi/docs/) · [GitHub खोलें](https://github.com/stephen-taipei/better-workflows) · [USDT (TRC20) से सहयोग करें](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 macOS × Node 22/24 पर Codex, Gemini CLI और Qwen Code को कवर करता है। Claude Code, Linux और Windows की अर्हता V5.1 तक के लिए स्थगित है। GA के लिए कम से कम 30 प्राकृतिक canary दिन, लगातार 20 योग्य शुरुआत और तीन अलग-अलग रिपॉजिटरी आवश्यक हैं।

## एजेंट के काम को<br>सत्यापित किए जा सकने वाले समापन तक पहुँचाएँ।

V5.0 RC1 सार्वजनिक रूप से उपलब्ध है। Auto लक्ष्य, कार्यक्षेत्र (scope), रिपॉजिटरी और जोखिम की जाँच करता है, फिर लक्षित जाँचों या साक्ष्य वर्कफ़्लो (evidence workflow) का चयन करता है। Git बदलाव कार्य-स्वामित्व वाले worktree (task-owned worktree) का उपयोग करते हैं; डिलीवरी के लिए प्रमाणीकरण और एक सत्यापित बाहरी परिणाम आवश्यक है।

## इरादे से समापन तक चार स्पष्ट सीमाएँ।

Contract तय करें, source और evidence सत्यापित करें, बाहरी प्रभावों का मिलान करें और अंतिम स्थिति ज्ञात होने पर ही कार्य पूर्ण घोषित करें।

- **01 · `TaskContract`** — V5.0 RC1 सार्वजनिक रूप से उपलब्ध है। Auto लक्ष्य, कार्यक्षेत्र (scope), रिपॉजिटरी और जोखिम की जाँच करता है, फिर लक्षित जाँचों या साक्ष्य वर्कफ़्लो (evidence workflow) का चयन करता है। Git बदलाव कार्य-स्वामित्व वाले worktree (task-owned worktree) का उपयोग करते हैं; डिलीवरी के लिए प्रमाणीकरण और एक सत्यापित बाहरी परिणाम आवश्यक है।
- **02 · `evidence`** — Better Workflows V5.0 RC1 सार्वजनिक रूप से उपलब्ध है: AI engineering QA और delivery के लिए एक निःशुल्क, खुला-स्रोत (open-source) Auto वर्कफ़्लो, जिसमें वर्तमान साक्ष्य (current evidence), समीक्षा द्वार (review gates) और प्रदाता समाधान (provider reconciliation) शामिल हैं।
- **03 · `reconciliation`** — Contract तय करें, source और evidence सत्यापित करें, बाहरी प्रभावों का मिलान करें और अंतिम स्थिति ज्ञात होने पर ही कार्य पूर्ण घोषित करें।
- **04 · `terminal state`** — सिर्फ़ कमांड चलना पूर्णता का प्रमाण नहीं है; दोबारा सत्यापित परिणाम ही प्रमाण है।

## त्वरित शुरुआत

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## आर्किटेक्चर मानचित्र से व्यावहारिक उपयोग-परिदृश्यों तक जाएँ।

- [इरादे से समापन तक चार स्पष्ट सीमाएँ।](https://betterworkflows.dev/hi/docs/)
- [त्वरित शुरुआत](https://betterworkflows.dev/hi/docs/quick/)
- [आर्किटेक्चर मानचित्र से व्यावहारिक उपयोग-परिदृश्यों तक जाएँ।](https://betterworkflows.dev/hi/docs/use-cases/)
- [त्वरित शुरुआत — आर्किटेक्चर मानचित्र से व्यावहारिक उपयोग-परिदृश्यों तक जाएँ।](https://betterworkflows.dev/hi/docs/use-cases/quick/)
- [साक्ष्य सिनेमा](https://betterworkflows.dev/hi/docs/evidence-cinema/)

### दस्तावेज़ देखें · `hi`

इस संदर्भ पृष्ठ का अवलोकन स्थानीयकृत है; इसकी संवादात्मक सामग्री का अभी पूरा अनुवाद नहीं हुआ है।

- **01 · इरादे से समापन तक चार स्पष्ट सीमाएँ।** — Contract तय करें, source और evidence सत्यापित करें, बाहरी प्रभावों का मिलान करें और अंतिम स्थिति ज्ञात होने पर ही कार्य पूर्ण घोषित करें।
- **02 · आर्किटेक्चर मानचित्र से व्यावहारिक उपयोग-परिदृश्यों तक जाएँ।** — V5.0 RC1 सार्वजनिक रूप से उपलब्ध है। Auto लक्ष्य, कार्यक्षेत्र (scope), रिपॉजिटरी और जोखिम की जाँच करता है, फिर लक्षित जाँचों या साक्ष्य वर्कफ़्लो (evidence workflow) का चयन करता है। Git बदलाव कार्य-स्वामित्व वाले worktree (task-owned worktree) का उपयोग करते हैं; डिलीवरी के लिए प्रमाणीकरण और एक सत्यापित बाहरी परिणाम आवश्यक है।
- **03 · त्वरित शुरुआत** — Better Workflows V5.0 RC1 सार्वजनिक रूप से उपलब्ध है: AI engineering QA और delivery के लिए एक निःशुल्क, खुला-स्रोत (open-source) Auto वर्कफ़्लो, जिसमें वर्तमान साक्ष्य (current evidence), समीक्षा द्वार (review gates) और प्रदाता समाधान (provider reconciliation) शामिल हैं।

- [`इरादे से समापन तक चार स्पष्ट सीमाएँ।`](https://betterworkflows.dev/docs/reference/hi/index.html) · `hi`
- [`त्वरित शुरुआत`](https://betterworkflows.dev/docs/reference/hi/preview.html) · `hi`
- [`आर्किटेक्चर मानचित्र से व्यावहारिक उपयोग-परिदृश्यों तक जाएँ।`](https://betterworkflows.dev/docs/reference/hi/use-cases/index.html) · `hi`
- [`त्वरित शुरुआत — आर्किटेक्चर मानचित्र से व्यावहारिक उपयोग-परिदृश्यों तक जाएँ।`](https://betterworkflows.dev/docs/reference/hi/use-cases/preview.html) · `hi`
- [`साक्ष्य सिनेमा`](https://betterworkflows.dev/docs/reference/hi/evidence-cinema/index.html) · `hi`

- [दस्तावेज़ देखें · `hi`](../details/hi.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### दस्तावेज़ देखें · `en`



### दस्तावेज़ देखें · `hi`

- [सुरक्षा नीति](hi/security.md) · `hi`
- [योगदान](hi/contributing.md) · `hi`
- [शासन व्यवस्था](hi/governance.md) · `hi`
- [आचार संहिता](hi/conduct.md) · `hi`
- [तृतीय पक्ष संबंधी सूचनाएँ](hi/notices.md) · `hi`
- [README की गुणवत्ता की रूपरेखा](hi/readme-quality.md) · `hi`
- [संपादकीय रंग प्रणाली](hi/color-system.md) · `hi`
- [आर्किटेक्चर](hi/architecture.md) · `hi`
- [सुरक्षा](hi/security-guide.md) · `hi`
- [CLI संदर्भ](hi/cli-reference.md) · `hi`
- [शुरुआत करें](hi/getting-started.md) · `hi`
- [वर्कफ़्लो](hi/workflows.md) · `hi`
- [सहायता](hi/support.md) · `hi`

## Better Workflows के रखरखाव में मदद करें।

एक बार का सहयोग मुक्त-स्रोत रखरखाव, दस्तावेज़, 41 भाषाओं के localization और वेबसाइट hosting में मदद करता है। इससे membership, roadmap या support priority नहीं मिलती।

[USDT (TRC20) से सहयोग करें](https://betterworkflows.dev/#sponsor)

---

सिर्फ़ कमांड चलना पूर्णता का प्रमाण नहीं है; दोबारा सत्यापित परिणाम ही प्रमाण है।
