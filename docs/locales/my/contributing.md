<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# ပံ့ပိုးပါဝင်ခြင်း

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · **မြန်မာ** · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Better Workflows ကို ပိုမိုကောင်းမွန်စေရန် ကူညီပေးသည့်အတွက် ကျေးဇူးတင်ပါသည်။

[README](../../../README.md) · **ပါဝင်ကူညီခြင်း** · [လိုက်နာရမည့် ကျင့်ဝတ်များ](conduct.md) · [လုံခြုံရေး](security.md) · [စီမံအုပ်ချုပ်မှု](governance.md) · [ပံ့ပိုးကူညီမှု](support.md)

[ဒေသသုံးဘာသာပြန်မူ 41 မူပါ ခြုံငုံသုံးသပ်ချက်နှင့် တရားဝင်ဝက်ဘ်ဝင်ပေါက်များ](../../../docs/LANGUAGES.md)။ စည်းမျဉ်းအဖြစ် သတ်မှတ်ထားသော ဤပံ့ပိုးပါဝင်မှုမူဝါဒ၏ အင်္ဂလိပ်ဘာသာမူသည် အတည်ယူရမည့် မူရင်းစံအဖြစ် ဆက်လက်တည်ရှိသည်။

## မစတင်မီ

- အများပြည်သူသုံး သဘောတူစာချုပ်အသစ်၊ Auto ၏ ပြင်ပအပြုအမူ ပြောင်းလဲမှု၊ လုံခြုံရေးနယ်နိမိတ် သို့မဟုတ် ကြီးမားသော ဗိသုကာဆိုင်ရာ ပြောင်းလဲမှုများအတွက် issue သို့မဟုတ် discussion ကို အရင်သုံးပါ။
- pull request တစ်ခုလျှင် ရလဒ်တစ်ခုတည်းအပေါ် အာရုံစိုက်ထားပါ။
- credentials၊ သီးသန့် prompt များ၊ စကားပြောမှတ်တမ်းကြမ်းများ၊ host လက်မှတ်ရေးထိုးသည့် key များ၊ provider ပြေစာများ သို့မဟုတ် လက်မှတ်ထိုးထားသော သက်သေခံချက်များကို မည်သည့်အခါမျှ commit မလုပ်ပါနှင့်။
- အားနည်းချက်များကို [SECURITY\.md](security.md) တွင် ဖော်ပြထားသည့်အတိုင်း သီးသန့်သတင်းပို့ပါ။

## ဖွံ့ဖြိုးရေးပတ်ဝန်းကျင် ပြင်ဆင်ခြင်း

လိုအပ်ချက်များ\:

- Node\.js 24 သို့မဟုတ် ပိုသစ်သောဗားရှင်း\;
- လုပ်ဆောင်ချိန်တွင် တတိယပါတီ၏ မှီခိုအစိတ်အပိုင်း မရှိခြင်း\;
- လက်ရှိရည်မှန်းထားသော ကုဒ်အကိုင်းကို အခြေခံထားသည့် မသိမ်းသွင်းရသေးသော ပြောင်းလဲမှုမရှိသည့် ကုဒ်အကိုင်း။

စက်တွင်းအခြေခံစစ်ဆေးမှုအားလုံးကို အပြည့်အစုံ လုပ်ဆောင်ပါ\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## ပြောင်းလဲမှုစည်းမျဉ်းများ

1. Root ပိုင်ဆိုင်သော mutation နှင့် fail\-closed ဘေးထွက်ဆိုးကျိုး နယ်နိမိတ်များကို ထိန်းသိမ်းပါ။
2. Auto ၏ ပြင်ပအပြုအမူ ပြောင်းလဲသည့်အခါ ၎င်း၏ template နှင့် skill၊ entrypoint catalog၊ CLI၊ စမ်းသပ်မှုများနှင့် သက်ဆိုင်ရာ စာရွက်စာတမ်းအားလုံးကို အတူတကွ update လုပ်ပါ။
3. မသိသော CLI option များနှင့် မသိသော schema field များကို ငြင်းပယ်ပါ။
4. သီးသန့် runtime state ကို repository ၏ အပြင်ဘက်တွင် ထားရှိပါ။
5. safety gate အသစ်တိုင်းအတွက် negative test များ ထည့်သွင်းပါ။
6. ပြောင်းလဲ၍မရသော လက်ရှိ plugin\-cache version ကို မပြင်ဆင်ပါနှင့်။ ပြောင်းလဲထားသော bundle သည် build version အသစ်နှင့် အတိအကျတူညီသော source\/cache digest စစ်ဆေးမှု လိုအပ်သည်။

README ကိုသာ ပြန်လည်စီစဉ်ရာတွင် အရင်းအဆင့်စာမျက်နှာကို အမြန်ဖတ်ရှုနားလည်နိုင်အောင် ထားပြီး အသေးစိတ် သဘောတူသတ်မှတ်ချက်များကို [`docs/guide/`](../../../docs/guide/) အောက်ရှိ သက်ဆိုင်ရာဖိုင်တွင် ထားပါ။

## ပြောင်းလဲမှုများ ပေါင်းထည့်ရန် တောင်းဆိုချက် စစ်ဆေးစာရင်း

- [ ] အကျုံးဝင်မှုနှင့် ရည်ရွယ်ချက်မဟုတ်သောအရာများကို အတိအလင်း ဖော်ပြထားသည်။
- [ ] လုပ်ဆောင်ပုံနှင့် ဘေးကင်းရေးနယ်နိမိတ်များကို စာရွက်စာတမ်းပြုစုထားသည်။
- [ ] အာရုံစိုက်စမ်းသပ်မှုများက အောင်မြင်မှုနှင့် မအောင်မြင်မှုလမ်းကြောင်းများကို လွှမ်းခြုံထားသည်။
- [ ] စမ်းသပ်မှုအစုအဝေးတစ်ခုလုံးနှင့် `sbw eval` အောင်မြင်သည်။
- [ ] `git diff --check` အောင်မြင်သည်။
- [ ] ဗားရှင်း\/ကက်ရှ် ပြောင်းလဲမှုများသည် သက်ဆိုင်သည့်အခါ ပြောင်းလဲ၍မရသော ထုတ်ဝေမှုစည်းမျဉ်းများကို လိုက်နာသည်။
- [ ] လျှို့ဝှက်အချက်အလက်၊ ကိုယ်ပိုင်အခြေအနေ သို့မဟုတ် ပြင်ပလက်ခံအတည်ပြုမှတ်တမ်းများ မပါဝင်ပါ။

ပြန်လည်သုံးသပ်နိုင်သော သေးငယ်သည့် ပြောင်းလဲမှုမှတ်တမ်းများကို ဦးစားပေးသည်။ မသက်ဆိုင်သော ရှင်းလင်းပြုပြင်မှုကို လုပ်ဆောင်ပုံပြောင်းလဲမှုတစ်ခုနှင့် မပေါင်းစပ်ပါနှင့်။
