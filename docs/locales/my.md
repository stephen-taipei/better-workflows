<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 ကို အများပြည်သူသုံးအဖြစ် ရယူနိုင်ပါပြီ- လက်ရှိ အထောက်အထား၊ review gates နှင့် provider ညှိနှိုင်းမှုတို့ ပါဝင်သော AI engineering QA နှင့် delivery အတွက် အခမဲ့ open-source Auto workflow ဖြစ်ပါသည်။

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · **မြန်မာ** · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[စာရွက်စာတမ်းကို ကြည့်ရန်](https://betterworkflows.dev/my/docs/) · [GitHub ဖွင့်ရန်](https://github.com/stephen-taipei/better-workflows) · [USDT (TRC20) ဖြင့် ပံ့ပိုးပါ](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 သည် macOS × Node 22/24 ပေါ်တွင် Codex၊ Gemini CLI နှင့် Qwen Code တို့ကို အကျုံးဝင်သည်။ Claude Code၊ Linux နှင့် Windows အရည်အသွေးသတ်မှတ်ချက်ကို V5.1 သို့ ရွှေ့ဆိုင်းထားသည်။ GA အတွက် အနည်းဆုံး သဘာဝအတိုင်းဖြစ်သော canary ရက်ပေါင်း ၃၀၊ ဆက်တိုက်သတ်မှတ်ချက်ပြည့်မီသော စတင်မှု အကြိမ် ၂၀ နှင့် သီးခြား repositories သုံးခု လိုအပ်သည်။

## agent အလုပ်ကို<br>သက်သေပြနိုင်သည့် အဆုံးသတ်အထိ ယူဆောင်ပါ။

V5.0 RC1 ကို အများပြည်သူသုံးအဖြစ် ရယူနိုင်ပါပြီ။ Auto သည် ရည်မှန်းချက်၊ နယ်ပယ်၊ repository နှင့် အန္တရာယ်တို့ကို စစ်ဆေးပြီးနောက် ပစ်မှတ်ထားစစ်ဆေးမှုများ သို့မဟုတ် evidence workflow တစ်ခုကို ရွေးချယ်သည်။ Git ပြင်ဆင်မှုများသည် task ပိုင်ဆိုင်သော worktree ကို အသုံးပြုပြီး delivery အတွက် ခွင့်ပြုချက်နှင့် အတည်ပြုပြီးသော ပြင်ပရလဒ် လိုအပ်သည်။

## ရည်ရွယ်ချက်မှ ပြီးစီးမှုအထိ ရှင်းလင်းသော နယ်နိမိတ်လေးခု။

စာချုပ်ကို သတ်မှတ်ပြီး ရင်းမြစ်နှင့် အထောက်အထားကို စစ်ဆေးပါ။ ပြင်ပသက်ရောက်မှုများကို တိုက်ဆိုင်စစ်ဆေးပြီး နောက်ဆုံးအခြေအနေကို သိရှိမှသာ ပြီးစီးကြောင်း ကြေညာပါ။

- **01 · `TaskContract`** — V5.0 RC1 ကို အများပြည်သူသုံးအဖြစ် ရယူနိုင်ပါပြီ။ Auto သည် ရည်မှန်းချက်၊ နယ်ပယ်၊ repository နှင့် အန္တရာယ်တို့ကို စစ်ဆေးပြီးနောက် ပစ်မှတ်ထားစစ်ဆေးမှုများ သို့မဟုတ် evidence workflow တစ်ခုကို ရွေးချယ်သည်။ Git ပြင်ဆင်မှုများသည် task ပိုင်ဆိုင်သော worktree ကို အသုံးပြုပြီး delivery အတွက် ခွင့်ပြုချက်နှင့် အတည်ပြုပြီးသော ပြင်ပရလဒ် လိုအပ်သည်။
- **02 · `evidence`** — Better Workflows V5.0 RC1 ကို အများပြည်သူသုံးအဖြစ် ရယူနိုင်ပါပြီ- လက်ရှိ အထောက်အထား၊ review gates နှင့် provider ညှိနှိုင်းမှုတို့ ပါဝင်သော AI engineering QA နှင့် delivery အတွက် အခမဲ့ open-source Auto workflow ဖြစ်ပါသည်။
- **03 · `reconciliation`** — စာချုပ်ကို သတ်မှတ်ပြီး ရင်းမြစ်နှင့် အထောက်အထားကို စစ်ဆေးပါ။ ပြင်ပသက်ရောက်မှုများကို တိုက်ဆိုင်စစ်ဆေးပြီး နောက်ဆုံးအခြေအနေကို သိရှိမှသာ ပြီးစီးကြောင်း ကြေညာပါ။
- **04 · `terminal state`** — အမိန့်တစ်ခုကို လုပ်ဆောင်ခြင်းသည် ပြီးစီးကြောင်း သက်သေမဟုတ်ပါ; ပြန်လည်စစ်ဆေးနိုင်သော ရလဒ်ကသာ သက်သေဖြစ်သည်။

## အမြန်စတင်ရန်

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## စနစ်တည်ဆောက်ပုံမြေပုံမှ လက်တွေ့အသုံးပြုမှုများသို့ ဆက်သွားပါ။

- [ရည်ရွယ်ချက်မှ ပြီးစီးမှုအထိ ရှင်းလင်းသော နယ်နိမိတ်လေးခု။](https://betterworkflows.dev/my/docs/)
- [အမြန်စတင်ရန်](https://betterworkflows.dev/my/docs/quick/)
- [စနစ်တည်ဆောက်ပုံမြေပုံမှ လက်တွေ့အသုံးပြုမှုများသို့ ဆက်သွားပါ။](https://betterworkflows.dev/my/docs/use-cases/)
- [အမြန်စတင်ရန် — စနစ်တည်ဆောက်ပုံမြေပုံမှ လက်တွေ့အသုံးပြုမှုများသို့ ဆက်သွားပါ။](https://betterworkflows.dev/my/docs/use-cases/quick/)
- [အထောက်အထား ရုပ်ရှင်ရုံ](https://betterworkflows.dev/my/docs/evidence-cinema/)

### စာရွက်စာတမ်းကို ကြည့်ရန် · `my`

ဤကိုးကားစာမျက်နှာတွင် မိမိဘာသာစကားဖြင့် အကျဉ်းချုပ် ရရှိနိုင်သော်လည်း အပြန်အလှန်တုံ့ပြန်နိုင်သော အကြောင်းအရာကို အပြည့်အစုံ မပြန်ဆိုရသေးပါ။

- **01 · ရည်ရွယ်ချက်မှ ပြီးစီးမှုအထိ ရှင်းလင်းသော နယ်နိမိတ်လေးခု။** — စာချုပ်ကို သတ်မှတ်ပြီး ရင်းမြစ်နှင့် အထောက်အထားကို စစ်ဆေးပါ။ ပြင်ပသက်ရောက်မှုများကို တိုက်ဆိုင်စစ်ဆေးပြီး နောက်ဆုံးအခြေအနေကို သိရှိမှသာ ပြီးစီးကြောင်း ကြေညာပါ။
- **02 · စနစ်တည်ဆောက်ပုံမြေပုံမှ လက်တွေ့အသုံးပြုမှုများသို့ ဆက်သွားပါ။** — V5.0 RC1 ကို အများပြည်သူသုံးအဖြစ် ရယူနိုင်ပါပြီ။ Auto သည် ရည်မှန်းချက်၊ နယ်ပယ်၊ repository နှင့် အန္တရာယ်တို့ကို စစ်ဆေးပြီးနောက် ပစ်မှတ်ထားစစ်ဆေးမှုများ သို့မဟုတ် evidence workflow တစ်ခုကို ရွေးချယ်သည်။ Git ပြင်ဆင်မှုများသည် task ပိုင်ဆိုင်သော worktree ကို အသုံးပြုပြီး delivery အတွက် ခွင့်ပြုချက်နှင့် အတည်ပြုပြီးသော ပြင်ပရလဒ် လိုအပ်သည်။
- **03 · အမြန်စတင်ရန်** — Better Workflows V5.0 RC1 ကို အများပြည်သူသုံးအဖြစ် ရယူနိုင်ပါပြီ- လက်ရှိ အထောက်အထား၊ review gates နှင့် provider ညှိနှိုင်းမှုတို့ ပါဝင်သော AI engineering QA နှင့် delivery အတွက် အခမဲ့ open-source Auto workflow ဖြစ်ပါသည်။

- [`ရည်ရွယ်ချက်မှ ပြီးစီးမှုအထိ ရှင်းလင်းသော နယ်နိမိတ်လေးခု။`](https://betterworkflows.dev/docs/reference/my/index.html) · `my`
- [`အမြန်စတင်ရန်`](https://betterworkflows.dev/docs/reference/my/preview.html) · `my`
- [`စနစ်တည်ဆောက်ပုံမြေပုံမှ လက်တွေ့အသုံးပြုမှုများသို့ ဆက်သွားပါ။`](https://betterworkflows.dev/docs/reference/my/use-cases/index.html) · `my`
- [`အမြန်စတင်ရန် — စနစ်တည်ဆောက်ပုံမြေပုံမှ လက်တွေ့အသုံးပြုမှုများသို့ ဆက်သွားပါ။`](https://betterworkflows.dev/docs/reference/my/use-cases/preview.html) · `my`
- [`အထောက်အထား ရုပ်ရှင်ရုံ`](https://betterworkflows.dev/docs/reference/my/evidence-cinema/index.html) · `my`

- [စာရွက်စာတမ်းကို ကြည့်ရန် · `my`](../details/my.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### စာရွက်စာတမ်းကို ကြည့်ရန် · `en`



### စာရွက်စာတမ်းကို ကြည့်ရန် · `my`

- [လုံခြုံရေးမူဝါဒ](my/security.md) · `my`
- [ပံ့ပိုးပါဝင်ခြင်း](my/contributing.md) · `my`
- [အုပ်ချုပ်စီမံမှု](my/governance.md) · `my`
- [အပြုအမူကျင့်ဝတ်](my/conduct.md) · `my`
- [ပြင်ပအဖွဲ့အစည်းများဆိုင်ရာ အသိပေးချက်များ](my/notices.md) · `my`
- [README အရည်အသွေးစီမံပုံ](my/readme-quality.md) · `my`
- [အယ်ဒီတာရေးရာ အရောင်စနစ်](my/color-system.md) · `my`
- [ဗိသုကာ](my/architecture.md) · `my`
- [လုံခြုံရေး](my/security-guide.md) · `my`
- [CLI ကိုးကားချက်](my/cli-reference.md) · `my`
- [စတင်အသုံးပြုရန်](my/getting-started.md) · `my`
- [လုပ်ငန်းစဉ်များ](my/workflows.md) · `my`
- [ပံ့ပိုးကူညီမှု](my/support.md) · `my`

## Better Workflows ကို ဆက်လက်ထိန်းသိမ်းနိုင်ရန် ကူညီပါ။

တစ်ကြိမ်တည်း ပံ့ပိုးမှုသည် open-source ထိန်းသိမ်းမှု၊ စာရွက်စာတမ်း၊ ဘာသာစကား ၄၁ မျိုးနှင့် website hosting ကို ကူညီသည်။ membership သို့မဟုတ် roadmap/support ဦးစားပေးမှု မရပါ။

[USDT (TRC20) ဖြင့် ပံ့ပိုးပါ](https://betterworkflows.dev/#sponsor)

---

အမိန့်တစ်ခုကို လုပ်ဆောင်ခြင်းသည် ပြီးစီးကြောင်း သက်သေမဟုတ်ပါ; ပြန်လည်စစ်ဆေးနိုင်သော ရလဒ်ကသာ သက်သေဖြစ်သည်။
