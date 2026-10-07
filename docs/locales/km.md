<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 អាចរកបានជាសាធារណៈ៖ workflow Auto ឥតគិតថ្លៃ និងជាកូដប្រភពបើកចំហសម្រាប់ QA និងការដឹកជញ្ជូននៃវិស្វកម្ម AI ជាមួយភស្តុតាងបច្ចុប្បន្ន ច្រកត្រួតពិនិត្យ និងការផ្សះផ្សា provider។

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · **ខ្មែរ** · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[មើលឯកសារ](https://betterworkflows.dev/km/docs/) · [បើក GitHub](https://github.com/stephen-taipei/better-workflows) · [គាំទ្រដោយ USDT (TRC20)](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 គ្របដណ្តប់លើ Codex, Gemini CLI និង Qwen Code នៅលើ macOS × Node 22/24។ លក្ខណៈសម្បត្តិ Claude Code, Linux និង Windows ត្រូវបានពន្យារពេលទៅ V5.1។ GA ទាមទារយ៉ាងហោចណាស់ 30 ថ្ងៃ canary តាមប្រតិទិន, ការចាប់ផ្តើមបំពេញលក្ខខណ្ឌ 20 ដងជាប់ៗគ្នា និង repository ផ្សេងគ្នាបី។

## នាំការងារ agent<br>ទៅកាន់ការបញ្ចប់ដែលអាចបញ្ជាក់បាន។

V5.0 RC1 អាចរកបានជាសាធារណៈ។ Auto ពិនិត្យមើលគោលដៅ វិសាលភាព កន្លែងផ្ទុកកូដ និងហានិភ័យ បន្ទាប់មកជ្រើសរើសការពិនិត្យតាមគោលដៅ ឬ workflow ភស្តុតាង។ ការកែប្រែ Git ប្រើ worktree ដែលគ្រប់គ្រងដោយកិច្ចការ; ការដឹកជញ្ជូនតម្រូវឱ្យមានការអនុញ្ញាត និងលទ្ធផលខាងក្រៅដែលបានផ្ទៀងផ្ទាត់។

## ព្រំដែនច្បាស់ចំនួនបួនពីគោលបំណងដល់ការបញ្ចប់។

កំណត់កិច្ចសន្យា ផ្ទៀងផ្ទាត់ប្រភព និងភស្តុតាង ផ្ទៀងផ្ទាត់ផលប៉ះពាល់ខាងក្រៅ ហើយប្រកាសថាបានបញ្ចប់តែពេលស្គាល់ស្ថានភាពចុងក្រោយ។

- **01 · `TaskContract`** — V5.0 RC1 អាចរកបានជាសាធារណៈ។ Auto ពិនិត្យមើលគោលដៅ វិសាលភាព កន្លែងផ្ទុកកូដ និងហានិភ័យ បន្ទាប់មកជ្រើសរើសការពិនិត្យតាមគោលដៅ ឬ workflow ភស្តុតាង។ ការកែប្រែ Git ប្រើ worktree ដែលគ្រប់គ្រងដោយកិច្ចការ; ការដឹកជញ្ជូនតម្រូវឱ្យមានការអនុញ្ញាត និងលទ្ធផលខាងក្រៅដែលបានផ្ទៀងផ្ទាត់។
- **02 · `evidence`** — Better Workflows V5.0 RC1 អាចរកបានជាសាធារណៈ៖ workflow Auto ឥតគិតថ្លៃ និងជាកូដប្រភពបើកចំហសម្រាប់ QA និងការដឹកជញ្ជូននៃវិស្វកម្ម AI ជាមួយភស្តុតាងបច្ចុប្បន្ន ច្រកត្រួតពិនិត្យ និងការផ្សះផ្សា provider។
- **03 · `reconciliation`** — កំណត់កិច្ចសន្យា ផ្ទៀងផ្ទាត់ប្រភព និងភស្តុតាង ផ្ទៀងផ្ទាត់ផលប៉ះពាល់ខាងក្រៅ ហើយប្រកាសថាបានបញ្ចប់តែពេលស្គាល់ស្ថានភាពចុងក្រោយ។
- **04 · `terminal state`** — ការដំណើរការពាក្យបញ្ជាមិនមែនជាភស្តុតាងនៃការបញ្ចប់ទេ; លទ្ធផលដែលអាចផ្ទៀងផ្ទាត់ឡើងវិញទើបជាភស្តុតាង។

## ចាប់ផ្ដើមរហ័ស

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## បន្តពីផែនទីស្ថាបត្យកម្មទៅករណីប្រើប្រាស់ជាក់ស្តែង។

- [ព្រំដែនច្បាស់ចំនួនបួនពីគោលបំណងដល់ការបញ្ចប់។](https://betterworkflows.dev/km/docs/)
- [ចាប់ផ្ដើមរហ័ស](https://betterworkflows.dev/km/docs/quick/)
- [បន្តពីផែនទីស្ថាបត្យកម្មទៅករណីប្រើប្រាស់ជាក់ស្តែង។](https://betterworkflows.dev/km/docs/use-cases/)
- [ចាប់ផ្ដើមរហ័ស — បន្តពីផែនទីស្ថាបត្យកម្មទៅករណីប្រើប្រាស់ជាក់ស្តែង។](https://betterworkflows.dev/km/docs/use-cases/quick/)
- [រោងកុនភស្តុតាង](https://betterworkflows.dev/km/docs/evidence-cinema/)

### មើលឯកសារ · `km`

ទំព័រឯកសារយោងនេះមានសេចក្ដីសង្ខេបដែលបានបកប្រែហើយ ប៉ុន្តែខ្លឹមសារអន្តរកម្មមិនទាន់ត្រូវបានបកប្រែពេញលេញទេ។

- **01 · ព្រំដែនច្បាស់ចំនួនបួនពីគោលបំណងដល់ការបញ្ចប់។** — កំណត់កិច្ចសន្យា ផ្ទៀងផ្ទាត់ប្រភព និងភស្តុតាង ផ្ទៀងផ្ទាត់ផលប៉ះពាល់ខាងក្រៅ ហើយប្រកាសថាបានបញ្ចប់តែពេលស្គាល់ស្ថានភាពចុងក្រោយ។
- **02 · បន្តពីផែនទីស្ថាបត្យកម្មទៅករណីប្រើប្រាស់ជាក់ស្តែង។** — V5.0 RC1 អាចរកបានជាសាធារណៈ។ Auto ពិនិត្យមើលគោលដៅ វិសាលភាព កន្លែងផ្ទុកកូដ និងហានិភ័យ បន្ទាប់មកជ្រើសរើសការពិនិត្យតាមគោលដៅ ឬ workflow ភស្តុតាង។ ការកែប្រែ Git ប្រើ worktree ដែលគ្រប់គ្រងដោយកិច្ចការ; ការដឹកជញ្ជូនតម្រូវឱ្យមានការអនុញ្ញាត និងលទ្ធផលខាងក្រៅដែលបានផ្ទៀងផ្ទាត់។
- **03 · ចាប់ផ្ដើមរហ័ស** — Better Workflows V5.0 RC1 អាចរកបានជាសាធារណៈ៖ workflow Auto ឥតគិតថ្លៃ និងជាកូដប្រភពបើកចំហសម្រាប់ QA និងការដឹកជញ្ជូននៃវិស្វកម្ម AI ជាមួយភស្តុតាងបច្ចុប្បន្ន ច្រកត្រួតពិនិត្យ និងការផ្សះផ្សា provider។

- [`ព្រំដែនច្បាស់ចំនួនបួនពីគោលបំណងដល់ការបញ្ចប់។`](https://betterworkflows.dev/docs/reference/km/index.html) · `km`
- [`ចាប់ផ្ដើមរហ័ស`](https://betterworkflows.dev/docs/reference/km/preview.html) · `km`
- [`បន្តពីផែនទីស្ថាបត្យកម្មទៅករណីប្រើប្រាស់ជាក់ស្តែង។`](https://betterworkflows.dev/docs/reference/km/use-cases/index.html) · `km`
- [`ចាប់ផ្ដើមរហ័ស — បន្តពីផែនទីស្ថាបត្យកម្មទៅករណីប្រើប្រាស់ជាក់ស្តែង។`](https://betterworkflows.dev/docs/reference/km/use-cases/preview.html) · `km`
- [`រោងកុនភស្តុតាង`](https://betterworkflows.dev/docs/reference/km/evidence-cinema/index.html) · `km`

- [មើលឯកសារ · `km`](../details/km.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### មើលឯកសារ · `en`



### មើលឯកសារ · `km`

- [គោលនយោបាយសន្តិសុខ](km/security.md) · `km`
- [ការចូលរួមចំណែក](km/contributing.md) · `km`
- [អភិបាលកិច្ច](km/governance.md) · `km`
- [ក្រមប្រតិបត្តិ](km/conduct.md) · `km`
- [សេចក្ដីជូនដំណឹងអំពីភាគីទីបី](km/notices.md) · `km`
- [ប្លង់សម្រាប់គុណភាព README](km/readme-quality.md) · `km`
- [ប្រព័ន្ធពណ៌សម្រាប់ការរៀបចំមាតិកា](km/color-system.md) · `km`
- [ស្ថាបត្យកម្ម](km/architecture.md) · `km`
- [សុវត្ថិភាព](km/security-guide.md) · `km`
- [ឯកសារយោង CLI](km/cli-reference.md) · `km`
- [ចាប់ផ្តើមប្រើប្រាស់](km/getting-started.md) · `km`
- [លំហូរការងារ](km/workflows.md) · `km`
- [ការគាំទ្រ](km/support.md) · `km`

## ជួយរក្សា Better Workflows ឱ្យបន្តថែទាំ។

ការគាំទ្រម្តងជួយថែទាំកូដប្រភពបើកចំហ ឯកសារ ការបកប្រែ 41 ភាសា និងការបង្ហោះគេហទំព័រ។ វាមិនផ្តល់សមាជិកភាព ឬអាទិភាព roadmap និង support ទេ។

[គាំទ្រដោយ USDT (TRC20)](https://betterworkflows.dev/#sponsor)

---

ការដំណើរការពាក្យបញ្ជាមិនមែនជាភស្តុតាងនៃការបញ្ចប់ទេ; លទ្ធផលដែលអាចផ្ទៀងផ្ទាត់ឡើងវិញទើបជាភស្តុតាង។
