<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 ເປີດໃຫ້ໃຊ້ງານສາທາລະນະແລ້ວ: Auto workflow ແຫຼ່ງເປີດທີ່ໃຊ້ຟຣີສຳລັບ QA ວິສະວະກຳ AI ແລະການສົ່ງມອບ, ພ້ອມດ້ວຍຫຼັກຖານປັດຈຸບັນ, ດ່ານກວດສອບ, ແລະການກະທົບຍອດ provider.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · **ລາວ** · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[ເບິ່ງເອກະສານ](https://betterworkflows.dev/lo/docs/) · [ເປີດ GitHub](https://github.com/stephen-taipei/better-workflows) · [ສະໜັບສະໜູນດ້ວຍ USDT (TRC20)](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 ຮອງຮັບ Codex, Gemini CLI ແລະ Qwen Code ເທິງ macOS × Node 22/24. ສ່ວນ Claude Code, Linux ແລະ Windows ແມ່ນເລື່ອນໄປ V5.1. GA ຕ້ອງການຢ່າງໜ້ອຍ 30 ວັນ canary ຕາມທຳມະຊາດ, 20 ການເລີ່ມຕົ້ນທີ່ຜ່ານເກນຕິດຕໍ່ກັນ ແລະ ສາມ repository ທີ່ຕ່າງກັນ.

## ນຳວຽກຂອງ agent<br>ໄປສູ່ການສຳເລັດທີ່ພິສູດໄດ້.

V5.0 RC1 ເປີດໃຫ້ໃຊ້ງານສາທາລະນະແລ້ວ. Auto ຈະກວດສອບເປົ້າໝາຍ, ຂອບເຂດ, repository, ແລະຄວາມສ່ຽງ, ຈາກນັ້ນເລືອກການກວດສອບແບບກົງເປົ້າ ຫຼື evidence workflow. ການແກ້ໄຂ Git ໃຊ້ worktree ທີ່ເປັນກຳມະສິດຂອງວຽກ; ການສົ່ງມອບຕ້ອງການການອະນຸຍາດ ແລະຜົນໄດ້ຮັບພາຍນອກທີ່ຜ່ານການຢືນຢັນແລ້ວ.

## ສີ່ຂອບເຂດທີ່ຊັດເຈນຈາກຄວາມຕັ້ງໃຈຫາການສຳເລັດ.

ກຳນົດສັນຍາ ກວດແຫຼ່ງທີ່ມາແລະຫຼັກຖານ ກວດທຽບຜົນກະທົບພາຍນອກ ແລະປະກາດວ່າສຳເລັດເມື່ອຮູ້ສະຖານະສຸດທ້າຍແລ້ວເທົ່ານັ້ນ.

- **01 · `TaskContract`** — V5.0 RC1 ເປີດໃຫ້ໃຊ້ງານສາທາລະນະແລ້ວ. Auto ຈະກວດສອບເປົ້າໝາຍ, ຂອບເຂດ, repository, ແລະຄວາມສ່ຽງ, ຈາກນັ້ນເລືອກການກວດສອບແບບກົງເປົ້າ ຫຼື evidence workflow. ການແກ້ໄຂ Git ໃຊ້ worktree ທີ່ເປັນກຳມະສິດຂອງວຽກ; ການສົ່ງມອບຕ້ອງການການອະນຸຍາດ ແລະຜົນໄດ້ຮັບພາຍນອກທີ່ຜ່ານການຢືນຢັນແລ້ວ.
- **02 · `evidence`** — Better Workflows V5.0 RC1 ເປີດໃຫ້ໃຊ້ງານສາທາລະນະແລ້ວ: Auto workflow ແຫຼ່ງເປີດທີ່ໃຊ້ຟຣີສຳລັບ QA ວິສະວະກຳ AI ແລະການສົ່ງມອບ, ພ້ອມດ້ວຍຫຼັກຖານປັດຈຸບັນ, ດ່ານກວດສອບ, ແລະການກະທົບຍອດ provider.
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
- [ຮູບເງົາຫຼັກຖານ](https://betterworkflows.dev/lo/docs/evidence-cinema/)

### ເບິ່ງເອກະສານ · `lo`

ໜ້າອ້າງອີງນີ້ມີພາບລວມທີ່ແປແລ້ວ; ເນື້ອຫາແບບໂຕ້ຕອບຍັງແປບໍ່ຄົບຖ້ວນ.

- **01 · ສີ່ຂອບເຂດທີ່ຊັດເຈນຈາກຄວາມຕັ້ງໃຈຫາການສຳເລັດ.** — ກຳນົດສັນຍາ ກວດແຫຼ່ງທີ່ມາແລະຫຼັກຖານ ກວດທຽບຜົນກະທົບພາຍນອກ ແລະປະກາດວ່າສຳເລັດເມື່ອຮູ້ສະຖານະສຸດທ້າຍແລ້ວເທົ່ານັ້ນ.
- **02 · ໄປຈາກແຜນທີ່ສະຖາປັດຕະຍະກຳຫາກໍລະນີນຳໃຊ້ຈິງ.** — V5.0 RC1 ເປີດໃຫ້ໃຊ້ງານສາທາລະນະແລ້ວ. Auto ຈະກວດສອບເປົ້າໝາຍ, ຂອບເຂດ, repository, ແລະຄວາມສ່ຽງ, ຈາກນັ້ນເລືອກການກວດສອບແບບກົງເປົ້າ ຫຼື evidence workflow. ການແກ້ໄຂ Git ໃຊ້ worktree ທີ່ເປັນກຳມະສິດຂອງວຽກ; ການສົ່ງມອບຕ້ອງການການອະນຸຍາດ ແລະຜົນໄດ້ຮັບພາຍນອກທີ່ຜ່ານການຢືນຢັນແລ້ວ.
- **03 · ເລີ່ມຕົ້ນດ່ວນ** — Better Workflows V5.0 RC1 ເປີດໃຫ້ໃຊ້ງານສາທາລະນະແລ້ວ: Auto workflow ແຫຼ່ງເປີດທີ່ໃຊ້ຟຣີສຳລັບ QA ວິສະວະກຳ AI ແລະການສົ່ງມອບ, ພ້ອມດ້ວຍຫຼັກຖານປັດຈຸບັນ, ດ່ານກວດສອບ, ແລະການກະທົບຍອດ provider.

- [`ສີ່ຂອບເຂດທີ່ຊັດເຈນຈາກຄວາມຕັ້ງໃຈຫາການສຳເລັດ.`](https://betterworkflows.dev/docs/reference/lo/index.html) · `lo`
- [`ເລີ່ມຕົ້ນດ່ວນ`](https://betterworkflows.dev/docs/reference/lo/preview.html) · `lo`
- [`ໄປຈາກແຜນທີ່ສະຖາປັດຕະຍະກຳຫາກໍລະນີນຳໃຊ້ຈິງ.`](https://betterworkflows.dev/docs/reference/lo/use-cases/index.html) · `lo`
- [`ເລີ່ມຕົ້ນດ່ວນ — ໄປຈາກແຜນທີ່ສະຖາປັດຕະຍະກຳຫາກໍລະນີນຳໃຊ້ຈິງ.`](https://betterworkflows.dev/docs/reference/lo/use-cases/preview.html) · `lo`
- [`ຮູບເງົາຫຼັກຖານ`](https://betterworkflows.dev/docs/reference/lo/evidence-cinema/index.html) · `lo`

- [ເບິ່ງເອກະສານ · `lo`](../details/lo.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### ເບິ່ງເອກະສານ · `en`



### ເບິ່ງເອກະສານ · `lo`

- [ນະໂຍບາຍຄວາມປອດໄພ](lo/security.md) · `lo`
- [ການມີສ່ວນຮ່ວມ](lo/contributing.md) · `lo`
- [ການກຳກັບດູແລ](lo/governance.md) · `lo`
- [ຈັນຍາບັນການປະພຶດ](lo/conduct.md) · `lo`
- [ແຈ້ງການກ່ຽວກັບພາກສ່ວນທີສາມ](lo/notices.md) · `lo`
- [ແຜນແມ່ບົດຄຸນນະພາບ README](lo/readme-quality.md) · `lo`
- [ລະບົບສີສຳລັບບົດບັນນາທິການ](lo/color-system.md) · `lo`
- [ສະຖາປັດຕະຍະກຳ](lo/architecture.md) · `lo`
- [ຄວາມປອດໄພ](lo/security-guide.md) · `lo`
- [ອ້າງອີງ CLI](lo/cli-reference.md) · `lo`
- [ເລີ່ມຕົ້ນໃຊ້ງານ](lo/getting-started.md) · `lo`
- [ຂະບວນການເຮັດວຽກ](lo/workflows.md) · `lo`
- [ການຊ່ວຍເຫຼືອ](lo/support.md) · `lo`

## ຊ່ວຍໃຫ້ Better Workflows ໄດ້ຮັບການດູແລຕໍ່ໄປ.

ການສະໜັບສະໜູນຄັ້ງດຽວຊ່ວຍບຳລຸງ ຊອບແວແຫຼ່ງເປີດ, ເອກະສານ, ການແປ 41 ພາສາ ແລະ hosting. ບໍ່ໄດ້ຮັບສະມາຊິກ ຫຼືສິດກ່ອນໃນ roadmap/support.

[ສະໜັບສະໜູນດ້ວຍ USDT (TRC20)](https://betterworkflows.dev/#sponsor)

---

ການດຳເນີນຄຳສັ່ງບໍ່ແມ່ນຫຼັກຖານວ່າວຽກສຳເລັດ; ຜົນລັບທີ່ກວດຊ້ຳໄດ້ຕ່າງຫາກແມ່ນຫຼັກຖານ.
