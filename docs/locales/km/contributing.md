<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# ការចូលរួមចំណែក

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · **ខ្មែរ** · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

សូមអរគុណចំពោះការជួយកែលម្អ Better Workflows។

[README](../../../README.md) · **ការចូលរួមចំណែក** · [ក្រមសីលធម៌](conduct.md) · [សុវត្ថិភាព](security.md) · [អភិបាលកិច្ច](governance.md) · [ការគាំទ្រ](support.md)

[ទិដ្ឋភាពទូទៅក្នុងកំណែដែលបានសម្របតាមភាសា និងតំបន់ចំនួន 41 និងច្រកចូលគេហទំព័រផ្លូវការ](../../../docs/LANGUAGES.md)។ កំណែជាភាសាអង់គ្លេសនៃគោលនយោបាយចូលរួមចំណែកដែលកំណត់បទបញ្ជានេះ នៅតែជាឯកសារគោលដែលមានអំណាចយោង។

## មុនពេលចាប់ផ្តើម

- ប្រើ issue ឬ discussion ជាមុនសិនសម្រាប់កិច្ចសន្យាសាធារណៈថ្មី ការផ្លាស់ប្តូរចំពោះ ឥរិយាបថសាធារណៈរបស់ Auto ព្រំដែនសុវត្ថិភាព ឬការផ្លាស់ប្តូរស្ថាបត្យកម្មធំ។
- រក្សា pull request មួយឱ្យផ្តោតលើលទ្ធផលតែមួយ។
- កុំ commit ព័ត៌មានសម្ងាត់ \(credentials\) ផ្ទាំងប្រអប់បញ្ចូលឯកជន \(private prompts\) ប្រវត្តិសន្ទនាដើម កូនសោ ចុះហត្ថលេខារបស់ហូស្ត បង្កាន់ដៃ provider ឬការបញ្ជាក់ដែលមានហត្ថលេខាជាដាច់ខាត។
- រាយការណ៍អំពីភាពងាយរងគ្រោះជាលក្ខណៈឯកជន ដូចដែលបានរៀបរាប់នៅក្នុង [SECURITY\.md](security.md)។

## ការរៀបចំបរិស្ថានអភិវឌ្ឍ

តម្រូវការ\:

- Node\.js 24 ឬថ្មីជាងនេះ\;
- គ្មានសមាសភាគរបស់ភាគីទីបីដែលត្រូវពឹងផ្អែកនៅពេលដំណើរការ\;
- សាខាស្អាតដែលផ្អែកលើសាខាគោលដៅបច្ចុប្បន្ន។

ដំណើរការការត្រួតពិនិត្យមូលដ្ឋានក្នុងម៉ាស៊ីនឱ្យបានពេញលេញ\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## វិធានសម្រាប់ការផ្លាស់ប្តូរ

1. រក្សាការផ្លាស់ប្តូរ \(mutation\) ដែលគ្រប់គ្រងដោយ Root និងព្រំដែនផលប៉ះពាល់ចំហៀង \(side\-effect\) បែប fail\-closed។
2. នៅពេលឥរិយាបថសាធារណៈរបស់ Auto ផ្លាស់ប្តូរ សូមធ្វើបច្ចុប្បន្នភាព template និង skill កាតាឡុក entrypoint\, CLI\, ការធ្វើតេស្ត និងឯកសាររងផលប៉ះពាល់ទាំងអស់ជាមួយគ្នា។
3. បដិសេធជម្រើស CLI ដែលមិនស្គាល់ និងវាល schema ដែលមិនស្គាល់។
4. រក្សាស្ថានភាព runtime ឯកជននៅខាងក្រៅកន្លែងផ្ទុកកូដ។
5. បន្ថែម negative test សម្រាប់រាល់ច្រកសុវត្ថិភាពថ្មី។
6. កុំកែប្រែកំណែ plugin\-cache ដែលមិនអាចកែប្រែបាន \(immutable\) ដែលមានស្រាប់។ កញ្ចប់ដែលបានផ្លាស់ប្តូរ តម្រូវឱ្យមានកំណែ build ថ្មី និងការផ្ទៀងផ្ទាត់ digest ប្រភព\/cache ជាក់លាក់។

សម្រាប់ការរៀបចំដែលពាក់ព័ន្ធតែ README សូមរក្សាទំព័រថ្នាក់ឫសឱ្យងាយអានរំលងរកចំណុចសំខាន់ៗ និងដាក់កិច្ចសន្យាលម្អិត នៅក្នុងឯកសារដែលត្រូវគ្នាក្រោម [`docs/guide/`](../../../docs/guide/)។

## បញ្ជីត្រួតពិនិត្យសំណើបញ្ចូលការផ្លាស់ប្តូរ

- [ ] វិសាលភាព និងអ្វីដែលមិនមែនជាគោលដៅត្រូវបានបញ្ជាក់ច្បាស់។
- [ ] ឥរិយាបថ និងព្រំដែនសុវត្ថិភាពត្រូវបានចងក្រងជាឯកសារ។
- [ ] តេស្តដែលផ្តោតជាក់លាក់គ្របដណ្តប់លើផ្លូវជោគជ័យ និងបរាជ័យ។
- [ ] សំណុំតេស្តទាំងមូល និង `sbw eval` ឆ្លងផុត។
- [ ] `git diff --check` ឆ្លងផុត។
- [ ] ការផ្លាស់ប្តូរកំណែ\/ឃ្លាំងសម្ងាត់អនុវត្តតាមវិធានចេញផ្សាយដែលមិនអាចកែប្រែបាន នៅពេលដែលវិធាននោះអនុវត្ត។
- [ ] គ្មានព័ត៌មានសម្ងាត់ ស្ថានភាពឯកជន ឬបង្កាន់ដៃបញ្ជាក់ពីខាងក្រៅត្រូវបានរួមបញ្ចូល។

គួរផ្តល់អាទិភាពដល់កំណត់ត្រាការផ្លាស់ប្តូរតូចៗដែលងាយពិនិត្យ។ កុំបញ្ចូលការសម្អាតដែលមិនពាក់ព័ន្ធជាមួយ ការផ្លាស់ប្តូរឥរិយាបថ។
