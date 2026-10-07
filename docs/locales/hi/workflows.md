<!-- Generated from docs/guide/workflows.md; source-sha256: 2acaf671415fc972265bcc5c4f20484c1a6cbea2dd1e6aa3fb22f54943786bb0; edit docs/rc1-catalogs/workflows/*.json. -->
# वर्कफ़्लो

[English](../en/workflows.md) · [繁體中文](../zh-Hant/workflows.md) · [繁體中文（台灣）](../zh-Hant-TW/workflows.md) · [繁體中文（香港）](../zh-Hant-HK/workflows.md) · [简体中文](../zh-Hans/workflows.md) · [Tiếng Việt](../vi/workflows.md) · [Українська](../uk/workflows.md) · [Türkçe](../tr/workflows.md) · [ไทย](../th/workflows.md) · [Svenska](../sv/workflows.md) · [Slovenčina](../sk/workflows.md) · [Русский](../ru/workflows.md) · [Română](../ro/workflows.md) · [Português](../pt/workflows.md) · [Português \(Brasil\)](../pt-BR/workflows.md) · [Polski](../pl/workflows.md) · [Nederlands](../nl/workflows.md) · [Norsk bokmål](../nb/workflows.md) · [မြန်မာ](../my/workflows.md) · [Bahasa Melayu](../ms/workflows.md) · [ລາວ](../lo/workflows.md) · [한국어](../ko/workflows.md) · [ខ្មែរ](../km/workflows.md) · [日本語](../ja/workflows.md) · [Italiano](../it/workflows.md) · [Bahasa Indonesia](../id/workflows.md) · [Magyar](../hu/workflows.md) · [Hrvatski](../hr/workflows.md) · **हिन्दी** · [עברית](../he/workflows.md) · [Français](../fr/workflows.md) · [Filipino](../fil/workflows.md) · [Suomi](../fi/workflows.md) · [Español](../es/workflows.md) · [Español \(México\)](../es-MX/workflows.md) · [Ελληνικά](../el/workflows.md) · [Deutsch](../de/workflows.md) · [Dansk](../da/workflows.md) · [Čeština](../cs/workflows.md) · [Català](../ca/workflows.md) · [العربية](../ar/workflows.md)

| [अवलोकन](../../../README.md) | [विवरण](../../../docs/details/en.md) | [त्वरित शुरुआत](getting-started.md) | **वर्कफ़्लो** | [आर्किटेक्चर](architecture.md) | [सुरक्षा](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

## Auto का उपयोग करें

```text
$better-workflows:auto <describe the outcome you need>
```

## सामान्य पथ

```mermaid
flowchart TD
  A{"परिणाम क्या है?"}
  A -->|"केवल समीक्षा"| B["auto"]
  A -->|"ठीक करें और डिलीवर करें"| C["auto"]
  A -->|"विकल्पों की तुलना करें"| D["auto"]
  A -->|"रिलीज़ या अपरिवर्तनीय कार्रवाई"| E["HOLD"]
  A -->|"स्थिर प्रक्रिया दोहराएं"| F["auto"]
  A -->|"अनिश्चित"| G["HOLD"]
```
