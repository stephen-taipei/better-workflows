<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# योगदान

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · **हिन्दी** · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Better Workflows को बेहतर बनाने में मदद करने के लिए धन्यवाद।

[README](../../../README.md) · **योगदान** · [आचार संहिता](conduct.md) · [सुरक्षा](security.md) · [संचालन व्यवस्था](governance.md) · [सहायता](support.md)

[41 स्थानीयकृत संस्करणों का अवलोकन और आधिकारिक वेब प्रवेश बिंदु](../../../docs/LANGUAGES.md)। इस मानक योगदान नीति का अंग्रेज़ी संस्करण ही प्रामाणिक मूल स्रोत बना रहता है।

## शुरू करने से पहले

- नए सार्वजनिक अनुबंध \(public contract\)\, Auto के सार्वजनिक व्यवहार में बदलाव\, सुरक्षा सीमा\, या बड़े वास्तुशिल्प परिवर्तन \(architectural change\) के लिए पहले issue या discussion का उपयोग करें।
- एक pull request को एक ही परिणाम पर केंद्रित रखें।
- कभी भी क्रेडेंशियल्स\, निजी प्रॉम्प्ट्स\, कच्चा बातचीत इतिहास \(raw conversation history\)\, होस्ट हस्ताक्षर कुंजियाँ \(host signing keys\)\, प्रदाता रसीदें \(provider receipts\)\, या हस्ताक्षरित सत्यापन \(signed attestations\) कमिट न करें।
- कमजोरियों की सूचना [SECURITY\.md](security.md) में बताए अनुसार गोपनीय रूप से दें।

## विकास परिवेश की स्थापना

आवश्यकताएँ\:

- Node\.js 24 या नया संस्करण\;
- रनटाइम पर किसी तृतीय पक्ष की निर्भरता नहीं\;
- वर्तमान लक्ष्य शाखा पर आधारित एक स्वच्छ शाखा।

स्थानीय आधारभूत जाँचों का पूरा सेट चलाएँ\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## बदलाव के नियम

1. Root\-स्वामित्व वाले बदलाव और फ़ेल\-क्लोज़्ड साइड\-इफ़ेक्ट सीमाओं को बनाए रखें।
2. जब ऑटो का सार्वजनिक व्यवहार बदलता है\, तो उसके टेम्पलेट और कौशल\, प्रवेश बिंदु कैटलॉग\, CLI\, परीक्षणों और सभी प्रभावित दस्तावेज़ों को एक साथ अपडेट करें।
3. अज्ञात CLI विकल्पों और अज्ञात स्कीमा फ़ील्ड्स को अस्वीकार करें।
4. निजी रनटाइम स्थिति को रिपॉजिटरी के बाहर रखें।
5. प्रत्येक नए सुरक्षा द्वार के लिए नकारात्मक परीक्षण जोड़ें।
6. किसी मौजूदा अपरिवर्तनीय प्लगइन\-कैश संस्करण को संशोधित न करें। बदले हुए बंडल के लिए एक नया बिल्ड संस्करण और सटीक स्रोत\/कैश डाइजेस्ट सत्यापन की आवश्यकता होती है।

केवल README के संगठन में बदलाव करते समय मूल पृष्ठ को एक नज़र में समझने योग्य रखें और विस्तृत अनुबंध [`docs/guide/`](../../../docs/guide/) की संबंधित फ़ाइल में रखें।

## पुल अनुरोध की जाँच सूची

- [ ] दायरा और वे बातें जो लक्ष्य नहीं हैं\, स्पष्ट हैं।
- [ ] व्यवहार और सुरक्षा सीमाएँ दस्तावेज़ित हैं।
- [ ] केंद्रित परीक्षण सफलता और विफलता\, दोनों मार्गों को कवर करते हैं।
- [ ] पूरा परीक्षण समूह और `sbw eval` सफल होते हैं।
- [ ] `git diff --check` सफल होता है।
- [ ] जहाँ लागू हो\, संस्करण और कैश के बदलाव अपरिवर्तनीय प्रकाशन के नियमों का पालन करते हैं।
- [ ] कोई गोपनीय कुंजी या अन्य रहस्य\, निजी स्थिति अथवा बाहरी रसीद शामिल नहीं है।

छोटे और समीक्षा योग्य कमिट को प्राथमिकता दी जाती है। असंबंधित सफ़ाई को व्यवहार में बदलाव के साथ न मिलाएँ।
