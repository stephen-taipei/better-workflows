<!-- Generated from docs/guide/workflows.md; source-sha256: 2acaf671415fc972265bcc5c4f20484c1a6cbea2dd1e6aa3fb22f54943786bb0; edit docs/rc1-catalogs/workflows/*.json. -->
# လုပ်ငန်းစဉ်များ

[English](../en/workflows.md) · [繁體中文](../zh-Hant/workflows.md) · [繁體中文（台灣）](../zh-Hant-TW/workflows.md) · [繁體中文（香港）](../zh-Hant-HK/workflows.md) · [简体中文](../zh-Hans/workflows.md) · [Tiếng Việt](../vi/workflows.md) · [Українська](../uk/workflows.md) · [Türkçe](../tr/workflows.md) · [ไทย](../th/workflows.md) · [Svenska](../sv/workflows.md) · [Slovenčina](../sk/workflows.md) · [Русский](../ru/workflows.md) · [Română](../ro/workflows.md) · [Português](../pt/workflows.md) · [Português \(Brasil\)](../pt-BR/workflows.md) · [Polski](../pl/workflows.md) · [Nederlands](../nl/workflows.md) · [Norsk bokmål](../nb/workflows.md) · **မြန်မာ** · [Bahasa Melayu](../ms/workflows.md) · [ລາວ](../lo/workflows.md) · [한국어](../ko/workflows.md) · [ខ្មែរ](../km/workflows.md) · [日本語](../ja/workflows.md) · [Italiano](../it/workflows.md) · [Bahasa Indonesia](../id/workflows.md) · [Magyar](../hu/workflows.md) · [Hrvatski](../hr/workflows.md) · [हिन्दी](../hi/workflows.md) · [עברית](../he/workflows.md) · [Français](../fr/workflows.md) · [Filipino](../fil/workflows.md) · [Suomi](../fi/workflows.md) · [Español](../es/workflows.md) · [Español \(México\)](../es-MX/workflows.md) · [Ελληνικά](../el/workflows.md) · [Deutsch](../de/workflows.md) · [Dansk](../da/workflows.md) · [Čeština](../cs/workflows.md) · [Català](../ca/workflows.md) · [العربية](../ar/workflows.md)

| [ခြုံငုံသုံးသပ်ချက်](../../../README.md) | [အသေးစိတ်](../../../docs/details/en.md) | [အမြန်စတင်ရန်](getting-started.md) | **Workflows** | [ဗိသုကာ](architecture.md) | [လုံခြုံရေး](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

## Auto ကို အသုံးပြုခြင်း

```text
$better-workflows:auto <describe the outcome you need>
```

## အသုံးများသော လမ်းကြောင်းများ

```mermaid
flowchart TD
  A{"ရလဒ်က ဘာလဲ?"}
  A -->|"ပြန်လည်သုံးသပ်ရုံသာ"| B["auto"]
  A -->|"ပြင်ဆင်ပြီး ပေးပို့ရန်"| C["auto"]
  A -->|"ရွေးချယ်စရာများ နှိုင်းယှဉ်ရန်"| D["auto"]
  A -->|"ဖြန့်ချိခြင်း သို့မဟုတ် ပြန်ပြင်မရသော လုပ်ဆောင်ချက်"| E["HOLD"]
  A -->|"တည်ငြိမ်သော လုပ်ငန်းစဉ်များ ထပ်လုပ်ရန်"| F["auto"]
  A -->|"မသေချာပါ"| G["HOLD"]
```
