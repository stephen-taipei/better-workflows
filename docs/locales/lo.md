<div align="center">

# Better Workflows

ໃຫ້ AI agent ເລືອກຄວາມເຂັ້ມການກວດຕາມຄວາມສ່ຽງ ແລະສຳເລັດວຽກຢ່າງປອດໄພໃນ environment ແຍກ. ການແກ້ໄຂງ່າຍໆເຮັດໄດ້ໄວ; ວຽກສຳຄັນໃຊ້ດ່ານຫຼັກຖານ; ການແກ້ Git ໃຊ້ worktree ສະເພາະເປັນຄ່າເລີ່ມຕົ້ນ.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · **ລາວ** · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[ເບິ່ງເອກະສານ](https://betterworkflows.dev/lo/docs/) · [ເປີດ GitHub](https://github.com/stephen-taipei/better-workflows) · [ສະໜັບສະໜູນຜ່ານ Ko-fi](https://ko-fi.com/betterworkflows)

</div>

## ນຳວຽກຂອງ agent<br>ໄປສູ່ການສຳເລັດທີ່ພິສູດໄດ້.

Better Workflows ກຳນົດເປົ້າໝາຍ ຂອບເຂດ ແລະສິດອຳນາດໃຫ້ຄົງທີ່ ແລ້ວເຊື່ອມທຸກການຕັດສິນໃຈກັບຫຼັກຖານທີ່ຍັງກົງກັບແຫຼ່ງທີ່ມາແລະກວດຊ້ຳໄດ້ ພ້ອມຜົນລັບພາຍນອກທີ່ກວດທຽບແລ້ວ.

## ສີ່ຂອບເຂດທີ່ຊັດເຈນຈາກຄວາມຕັ້ງໃຈຫາການສຳເລັດ.

ກຳນົດສັນຍາ ກວດແຫຼ່ງທີ່ມາແລະຫຼັກຖານ ກວດທຽບຜົນກະທົບພາຍນອກ ແລະປະກາດວ່າສຳເລັດເມື່ອຮູ້ສະຖານະສຸດທ້າຍແລ້ວເທົ່ານັ້ນ.

- **01 · `TaskContract`** — Better Workflows ກຳນົດເປົ້າໝາຍ ຂອບເຂດ ແລະສິດອຳນາດໃຫ້ຄົງທີ່ ແລ້ວເຊື່ອມທຸກການຕັດສິນໃຈກັບຫຼັກຖານທີ່ຍັງກົງກັບແຫຼ່ງທີ່ມາແລະກວດຊ້ຳໄດ້ ພ້ອມຜົນລັບພາຍນອກທີ່ກວດທຽບແລ້ວ.
- **02 · `evidence`** — ໃຫ້ AI agent ເລືອກຄວາມເຂັ້ມການກວດຕາມຄວາມສ່ຽງ ແລະສຳເລັດວຽກຢ່າງປອດໄພໃນ environment ແຍກ. ການແກ້ໄຂງ່າຍໆເຮັດໄດ້ໄວ; ວຽກສຳຄັນໃຊ້ດ່ານຫຼັກຖານ; ການແກ້ Git ໃຊ້ worktree ສະເພາະເປັນຄ່າເລີ່ມຕົ້ນ.
- **03 · `reconciliation`** — ກຳນົດສັນຍາ ກວດແຫຼ່ງທີ່ມາແລະຫຼັກຖານ ກວດທຽບຜົນກະທົບພາຍນອກ ແລະປະກາດວ່າສຳເລັດເມື່ອຮູ້ສະຖານະສຸດທ້າຍແລ້ວເທົ່ານັ້ນ.
- **04 · `terminal state`** — ການດຳເນີນຄຳສັ່ງບໍ່ແມ່ນຫຼັກຖານວ່າວຽກສຳເລັດ; ຜົນລັບທີ່ກວດຊ້ຳໄດ້ຕ່າງຫາກແມ່ນຫຼັກຖານ.

## ເລີ່ມຕົ້ນດ່ວນ

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## ໄປຈາກແຜນທີ່ສະຖາປັດຕະຍະກຳຫາກໍລະນີນຳໃຊ້ຈິງ.

- [ສີ່ຂອບເຂດທີ່ຊັດເຈນຈາກຄວາມຕັ້ງໃຈຫາການສຳເລັດ.](https://betterworkflows.dev/lo/docs/)
- [ເລີ່ມຕົ້ນດ່ວນ](https://betterworkflows.dev/lo/docs/quick/)
- [ໄປຈາກແຜນທີ່ສະຖາປັດຕະຍະກຳຫາກໍລະນີນຳໃຊ້ຈິງ.](https://betterworkflows.dev/lo/docs/use-cases/)
- [ເລີ່ມຕົ້ນດ່ວນ — ໄປຈາກແຜນທີ່ສະຖາປັດຕະຍະກຳຫາກໍລະນີນຳໃຊ້ຈິງ.](https://betterworkflows.dev/lo/docs/use-cases/quick/)
- [Evidence Cinema](https://betterworkflows.dev/lo/docs/evidence-cinema/)


- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### `GUIDES · en`

- [`getting-started`](../guide/getting-started.md) · `en`
- [`workflows`](../guide/workflows.md) · `en`
- [`architecture`](../guide/architecture.md) · `en`
- [`security`](../guide/security.md) · `en`
- [`cli-reference`](../guide/cli-reference.md) · `en`
- [`readme-quality`](../guide/readme-quality.md) · `en`

### `POLICIES · en`

- [`CODE_OF_CONDUCT`](../../CODE_OF_CONDUCT.md) · `en`
- [`CONTRIBUTING`](../../CONTRIBUTING.md) · `en`
- [`GOVERNANCE`](../../GOVERNANCE.md) · `en`
- [`SECURITY`](../../SECURITY.md) · `en`
- [`SUPPORT`](../../SUPPORT.md) · `en`
- [`THIRD_PARTY_NOTICES`](../../THIRD_PARTY_NOTICES.md) · `en`
- [`ANSIBLE`](../../deploy/ansible/README.md) · `en`

### `RUNTIME SOURCE · en`

- [`plugins/better-workflows/skills/`](../../plugins/better-workflows/skills/)
- [`evidence-cinema/imagegen-manifest`](../html/evidence-cinema/assets/imagegen-manifest.md)
- [`use-cases/color-system`](../html/use-cases/assets/color-system.md)
- [`use-cases/imagegen-manifest`](../html/use-cases/assets/imagegen-manifest.md)
- [ເປີດ GitHub](https://github.com/stephen-taipei/better-workflows)

## ຊ່ວຍໃຫ້ Better Workflows ໄດ້ຮັບການດູແລຕໍ່ໄປ.

ການສະໜັບສະໜູນຄັ້ງດຽວຊ່ວຍບຳລຸງຊອບແວເປີດແຫຼ່ງ ເອກະສານ ສະບັບທີ່ປັບໃຫ້ເໝາະກັບທ້ອງຖິ່ນ 41 ສະບັບ ແລະການໂຮສເວັບໄຊ. ບໍ່ໄດ້ຮັບສະມາຊິກ ຫຼືສິດກ່ອນໃນແຜນພັດທະນາແລະການຊ່ວຍເຫຼືອ.

[ສະໜັບສະໜູນຜ່ານ Ko-fi](https://ko-fi.com/betterworkflows)

---

ການດຳເນີນຄຳສັ່ງບໍ່ແມ່ນຫຼັກຖານວ່າວຽກສຳເລັດ; ຜົນລັບທີ່ກວດຊ້ຳໄດ້ຕ່າງຫາກແມ່ນຫຼັກຖານ.
