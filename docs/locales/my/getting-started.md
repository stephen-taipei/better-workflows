<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# စတင်အသုံးပြုရန်

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · **မြန်မာ** · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 သည် macOS × Node 22\/24 ပေါ်တွင် Codex၊ Gemini CLI နှင့် Qwen Code တို့ကို အကျုံးဝင်သည်။ Claude Code၊ Linux နှင့် Windows အရည်အသွေးသတ်မှတ်ချက်ကို V5\.1 သို့ ရွှေ့ဆိုင်းထားသည်။ GA အတွက် အနည်းဆုံး သဘာဝအတိုင်းဖြစ်သော canary ရက်ပေါင်း ၃၀၊ ဆက်တိုက်သတ်မှတ်ချက်ပြည့်မီသော စတင်မှု အကြိမ် ၂၀ နှင့် သီးခြား repositories သုံးခု လိုအပ်သည်။

| [ခြုံငုံသုံးသပ်ချက်](../../../README.md) | [အသေးစိတ်](../../../docs/details/en.md) | **အမြန်စတင်ရန်** | [အလုပ်စဉ်များ](workflows.md) | [ဖွဲ့စည်းပုံ](architecture.md) | [လုံခြုံရေး](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[ဒေသသုံးဘာသာပြန်မူ 41 မူပါ ခြုံငုံသုံးသပ်ချက်နှင့် တရားဝင်ဝက်ဘ်ဝင်ပေါက်များ](../../../docs/LANGUAGES.md)။ အမိန့်များနှင့် သတ်မှတ်အမည်များကို မူရင်းစံ အင်္ဂလိပ်ပုံစံအတိုင်း ထားရှိသည်။

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) ကို အများပြည်သူသုံးအဖြစ် ရယူနိုင်ပါပြီ။ ၎င်း၏ ထုတ်ဝေမှုနယ်ပယ်တွင် macOS Node 22\/24 ပေါ်ရှိ Codex\, Gemini CLI နှင့် Qwen Code တို့နှင့်အတူ Auto သာ ပါဝင်သည်။ Linux နှင့် Windows သတ်မှတ်ချက်ပြည့်မီမှုကို Claude Code သတ်မှတ်ချက်ပြည့်မီမှုနည်းတူ V5\.1 သို့ ရွှေ့ဆိုင်းထားသည်။ အနည်းဆုံး သဘာဝအတိုင်း canary ရက် 30၊ ဆက်တိုက် အရည်အချင်းပြည့်မီသော စတင်မှု အကြိမ် 20 နှင့် သီးခြား repository သုံးခု မှတ်တမ်းတင်နိုင်သည့်အချိန်အထိ GA `5.0.0` သည် ဆိုင်းငံ့ထားဆဲ ဖြစ်သည်။

## လိုအပ်ချက်များ

- တွဲဖက်ပါရှိသော `sbw` helper အတွက် Node\.js 22\.14 သို့မဟုတ် နောက်ထပ် ဗားရှင်းအသစ်။
- ယုံကြည်စိတ်ချရသော local repository။ Better Workflows သည် အန္တရာယ်ရှိသော repository ကုဒ်ကို sandbox ပြုလုပ်ပေးသည်ဟု မဆိုလိုပါ။

v4 ၏ အခြေအနေသိမ်းဆည်းရာ အမြစ်ဖိုင်တွဲသည် ပလက်ဖောင်းတစ်ခုတည်းနှင့် မချည်နှောင်ထားပါ\: သတ်မှတ်ထားလျှင် `SBW_STATE_ROOT` ကို ဦးစားပေးပြီး၊ နောက်တစ်ဆင့်တွင် `XDG_STATE_HOME/better-workflows` ကို အသုံးပြုကာ၊ မရှိလျှင် `~/.better-workflows` ကို အသုံးပြုသည်။ ပုံမှန်တည်နေရာသည် `CODEX_HOME` အောက်တွင် မရှိတော့ပါ။ လက်ရှိရှိနေသော Codex v3 အခြေအနေကို မရွှေ့ဘဲ ဆက်သုံးရန် `sbw` ကို မခေါ်မီ `SBW_STATE_ROOT` ကို ထို `<CODEX_HOME>/sbw` ဖိုင်တွဲအတိအကျသို့ ရှင်းလင်းစွာ သတ်မှတ်ပါ။

V5\.0 GA \(`5.0.0`\) သည် ဆိုင်းငံ့ထားဆဲ ဖြစ်သည်။ အောက်ဖော်ပြပါ ထည့်သွင်းခြင်း command များသည် အများပြည်သူသုံး V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) ကို ရည်ညွှန်းပါသည်။

## ထည့်သွင်းတပ်ဆင်ရန်

### Codex — အကြံပြုထားသော ရည်ညွှန်းပလက်ဖောင်း

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

တပ်ဆင်ပြီးနောက် skill စာရင်း ပြန်လည်မွမ်းမံစေရန် Codex အလုပ်အသစ်တစ်ခုကို ဖွင့်ပါ။

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI သည် တိုးချဲ့အစိတ်အပိုင်းကို ကူးယူသည်။ တပ်ဆင်ပြီးနောက် လုပ်ဆောင်မှုအပိုင်းကို ပြန်လည်စတင်ပါ။ နောက်ပိုင်းမွမ်းမံရန် `gemini extensions update better-workflows` ကို အသုံးပြုပါ။

တိုးချဲ့အစိတ်အပိုင်း၏ ဆက်စပ်အချက်အလက်သည် ချိတ်ဆက်တံတား၏တည်နေရာကို သင့်ပရောဂျက်၏ အလုပ်လုပ်ရာဖိုင်တွဲမှ မဟုတ်ဘဲ ၎င်းကို တင်သွင်းခဲ့သည့် ကိုယ်ပိုင်ရင်းမြစ်လမ်းကြောင်းမှ ဆုံးဖြတ်သည်။ အသုံးပြုသူအတိုင်းအတာအတွင်း ပုံမှန်တပ်ဆင်မှုအတွက် တူညီသော လက်ဖြင့်စစ်ဆေးနည်းမှာ\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

ချိတ်ဆက်ထားသော သို့မဟုတ် အလုပ်နေရာအတိုင်းအတာအတွင်းရှိ တိုးချဲ့အစိတ်အပိုင်းအတွက် ပလက်ဖောင်းက ဖော်ပြသော တိုးချဲ့အစိတ်အပိုင်း၏ အမြစ်ဖိုင်တွဲအတိအကျကို အသုံးပြုပါ။ အမည်ဆင်တူသည့် checkout တစ်ခုဖြင့် အစားမထိုးပါနှင့်။

### Qwen Code

စက်တွင်း တိုးချဲ့အစိတ်အပိုင်းမိတ္တူကို မတပ်ဆင်မီ ထုတ်ဝေဗားရှင်းကို ပုံသေသတ်မှတ်ထားပါ\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code သည်လည်း တိုးချဲ့အစိတ်အပိုင်းကို ကူးယူသောကြောင့် တပ်ဆင်ပြီးနောက် လုပ်ဆောင်မှုအပိုင်းကို ပြန်လည်စတင်ပြီး နောက်ပိုင်းမွမ်းမံမှုများအတွက် `qwen extensions update better-workflows` ကို အသုံးပြုပါ။

အသုံးပြုသူအတိုင်းအတာအတွင်း ပုံမှန်တပ်ဆင်မှုအတွက် တူညီသော ချိတ်ဆက်တံတား လက်ဖြင့်စစ်ဆေးနည်းမှာ\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

အမြစ်ဖိုင်တွဲအတိအကျကို အသုံးပြုရမည့် စည်းမျဉ်းသည် ချိတ်ဆက်ထားသော သို့မဟုတ် အလုပ်နေရာအတိုင်းအတာအတွင်းရှိ တပ်ဆင်မှုများနှင့်လည်း သက်ဆိုင်သည်။

## Auto ကို အသုံးပြုခြင်း

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

စတင်ရွေးချယ်မှုတိုင်းသည် တောင်းဆိုထားသော Goal ကို ထိန်းသိမ်းထားသည်။ မသက်ဆိုင်သော လက်ရှိအသက်ဝင် Goal ကို အတိအလင်း ပြင်ဆင် သို့မဟုတ် ရှင်းလင်းရမည်ဖြစ်ပြီး၊ မသိမသာ အစားထိုးခြင်း မပြုပါ။

## လမ်းကြောင်းကို ကြိုတင်ကြည့်ရန်

စွမ်းဆောင်ရည်အခြေအနေမှတ်တမ်းသည် ဖတ်ရှုရန်သာဖြစ်ပြီး ဝန်ဆောင်မှုပေးသူထံ ဝင်ရောက်ခြင်း သို့မဟုတ် မော်ဒယ်၏ အဓိပ္ပာယ်ဆိုင်ရာ စမ်းသပ်စစ်ဆေးခြင်းကို မစတင်စေပါ\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

ပြန်လည်သုံးသပ်နိုင်သော အလုပ်လွှဲပြောင်းမှုအတွက် တစ်ကြိမ်သာသုံးနိုင်သည့် သီးသန့် စစ်ဆေးအတည်ပြုနိုင်သော မှတ်တမ်းတစ်ခုကို မှတ်တမ်းတင်ပြီး အသုံးပြုပါ\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

စစ်ဆေးအတည်ပြုနိုင်သော မှတ်တမ်းများသည် 24 နာရီအကြာတွင် သက်တမ်းကုန်ဆုံးပြီး၊ ပြန်လည်အသုံးပြုခြင်း သို့မဟုတ် အလုပ်နေရာ၊ အတိုင်းအတာ၊ Profiles၊ ကတ်တလောက်၊ စွမ်းဆောင်ရည်များ သို့မဟုတ် ပလပ်အင်အထုပ်တွင် ချည်နှောင်ထားသောအခြေအနေမှ ပြောင်းလဲကွာဟခြင်းရှိလျှင် အသုံးပြုခွင့်ကို ငြင်းပယ်သည်။

## တပ်ဆင်မှုကို အတည်ပြုစစ်ဆေးရန်

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## ကုဒ်သိုလှောင်ရုံကို မပြောင်းလဲမီ

Auto သည် အလုပ်နေရာကို ဖတ်ရှုရုံသာဖြင့် ကြိုတင်စစ်ဆေးခြင်းမှ စတင်သည်\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Git မသုံးသောအလုပ်များနှင့် ဖတ်ရှုရန်သာရှိသောအလုပ်များသည် worktree မဖန်တီးပါ။ ပြောင်းလဲမှုလုပ်သော Git အလုပ်သည် ထိုအလုပ်ပိုင် `TaskWorkspaceLeaseV1` ကို ဖန်တီးရမည် သို့မဟုတ် ပြန်သုံးရမည်။ ရင်းမြစ်၏ အလုပ်လုပ်ရာဖိုင်တွဲတွင် commit မလုပ်ရသေးသော ပြောင်းလဲမှုများရှိလျှင် stash၊ ကူးယူခြင်း၊ commit သို့မဟုတ် worktree ဖန်တီးခြင်း တစ်ခုခုမလုပ်မီ ရပ်တန့်သည်။ branch မှ ခွဲနေသော HEAD သို့မဟုတ် ပစ်မှတ်မရှိခြင်းအတွက် ပေါင်းစည်းမည့်ပစ်မှတ်ကို အတိအလင်း သတ်မှတ်ရမည်။ ကာကွယ်ထားသော သို့မဟုတ် အဝေးရှိပစ်မှတ်များကို စီမံအုပ်ချုပ်မှုစည်းမျဉ်းများအောက်ရှိ PR မှတစ်ဆင့် ပေးပို့မှုအဆင့်သို့ တိုးမြှင့်သည်။

Codex သို့မဟုတ် အခြားပလက်ဖောင်းတစ်ခုက လက်ရှိအလုပ်အတွက် သန့်ရှင်းသော worktree ကို ဖန်တီးထားပြီးဖြစ်လျှင် အတွင်းထပ် worktree တစ်ခု ဖန်တီးမည့်အစား မပြင်ဆင်မီ ၎င်းကို မှတ်ပုံတင်ပါ\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

မှတ်ပုံတင်ရန် မပြောင်းလဲထားသော အခြေခံဗားရှင်းပေါ်ရှိ သီးခြား `codex/*` အလုပ် branch၊ တူညီသော Git မျှဝေဖိုင်တွဲနှင့် သန့်ရှင်းသော ရင်းမြစ် checkout လိုအပ်သည်။ Better Workflows သည် worktree ကို အသုံးပြုသော်လည်း ရှင်းလင်းချိန်တွင် ပလက်ဖောင်းပိုင် branch နှင့် လမ်းကြောင်းကို ထိန်းသိမ်းထားသည်။ ကာကွယ်ထားသောပစ်မှတ်အတွက် အထောက်အထားအလုပ်စဉ်ကို အရင်လုပ်ဆောင်ပြီး၊ ထိုအလုပ်စဉ်၏ PR ပေါင်းစည်းမှုနှင့် အဝေးတစ်ပြေးညီပြုလုပ်မှုဆိုင်ရာ စစ်ဆေးအတည်ပြုနိုင်သော မှတ်တမ်းအတိအကျများကို `workspace reconcile --run-id <run-id>` ဖြင့် ချည်နှောင်ပါ။

နောက်တစ်ခု\: [မှန်ကန်သော workflow ကို ရွေးချယ်ပါ](workflows.md) သို့မဟုတ် [CLI ကိုးကားချက်](cli-reference.md) ကို ရှာဖွေကြည့်ရှုပါ။
