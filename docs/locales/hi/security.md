<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# सुरक्षा नीति

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · **हिन्दी** · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [योगदान](contributing.md) · [आचार संहिता](conduct.md) · **सुरक्षा** · [संचालन व्यवस्था](governance.md) · [सहायता](support.md)

[41 स्थानीयकृत संस्करणों का अवलोकन और आधिकारिक वेब प्रवेश बिंदु](../../../docs/LANGUAGES.md)। इस मानक सुरक्षा नीति का अंग्रेज़ी संस्करण ही प्रामाणिक मूल स्रोत बना रहता है।

यदि साक्ष्य के लिए प्रस्तावित एकमात्र स्रोत में निजी इतिहास या ऐसी संवेदनशील परिचालन सामग्री है जिससे संवेदनशील जानकारी हटाई नहीं जा सकती\, तो उसे एकत्र या प्रेषित न करें। केवल संवेदनशील जानकारी छिपाकर तैयार किया गया `REJECTED_WITH_EVIDENCE` का कारण दर्ज करें।

## समर्थित संस्करण

| संस्करण | समर्थन |
| --- | --- |
| नवीनतम प्रकाशित रिलीज़ और अपरिवर्तनीय Codex बिल्ड | समर्थित |
| अपरिवर्तनीय कैश के पुराने संस्करण | वापस लौटने के लक्ष्य संस्करण\; जब तक स्पष्ट घोषणा न हो\, सुधार पुराने संस्करणों में लागू नहीं किए जाते |
| अप्रकाशित फ़ोर्क या संशोधित कैश सामग्री | समर्थित नहीं |

## भेद्यता की रिपोर्ट करें

कृपया [GitHub पर भेद्यता की निजी रिपोर्टिंग](https://github.com/stephen-taipei/better-workflows/security/advisories/new) का उपयोग करें। संदिग्ध भेद्यता के लिए सार्वजनिक समस्या\-रिपोर्ट न खोलें।

यह जानकारी शामिल करें\:

- प्रभावित संस्करण और प्लगइन बिल्ड\;
- परिवेश और Node\.js संस्करण\;
- समस्या दोहराने के न्यूनतम चरण\;
- अपेक्षित और देखी गई सुरक्षा सीमा\;
- प्रभाव और कोई भी ज्ञात अस्थायी समाधान\;
- क्या रिपोर्ट में गोपनीय सामग्री है।

सक्रिय प्रमाणीकरण विवरण\, हस्ताक्षर कुंजियाँ\, प्रदाता टोकन\, निजी प्रॉम्प्ट का असंशोधित रूप या तृतीय पक्षों का व्यक्तिगत डेटा शामिल न करें।

## प्रतिक्रिया

रखरखावकर्ता उपयोग योग्य रिपोर्ट मिलने की पुष्टि करेगा\, उसका दायरा सत्यापित करेगा और सुधार तथा प्रकटीकरण का समन्वय करेगा। निश्चित प्रतिक्रिया समय वाले SLA का वादा नहीं किया जाता। अज्ञात या मिलान से अपुष्ट परिणाम सत्यापन के अभाव में अवरुद्ध रहते हैं।

## सुरक्षा सीमाएँ

Better Workflows यह मानकर चलता है कि स्थानीय रिपॉज़िटरी\, होस्ट और निष्पादन योग्य टूलचेन विश्वसनीय हैं। Node का अनुमति मॉडल बहुस्तरीय सुरक्षा का हिस्सा है और दुर्भावनापूर्ण कोड के लिए ऑपरेटिंग सिस्टम का सैंडबॉक्स नहीं है। पूरी [सुरक्षा मार्गदर्शिका](security-guide.md) देखें।
