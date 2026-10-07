<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# ການມີສ່ວນຮ່ວມ

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · **ລາວ** · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

ຂອບໃຈທີ່ຊ່ວຍປັບປຸງ Better Workflows\.

[README](../../../README.md) · **ການມີສ່ວນຮ່ວມ** · [ຫຼັກປະພຶດປະຕິບັດ](conduct.md) · [ຄວາມປອດໄພ](security.md) · [ການກຳກັບດູແລ](governance.md) · [ການຊ່ວຍເຫຼືອ](support.md)

[ພາບລວມໃນ 41 ສະບັບປັບເຂົ້າທ້ອງຖິ່ນ ແລະ ຊ່ອງທາງເຂົ້າເວັບທາງການ](../../../docs/LANGUAGES.md)\. ສະບັບພາສາອັງກິດຂອງນະໂຍບາຍການມີສ່ວນຮ່ວມທີ່ກຳນົດຂໍ້ບັງຄັບນີ້ ຍັງຄົງເປັນຕົ້ນສະບັບອ້າງອີງທີ່ມີອຳນາດຊີ້ຂາດ\.

## ກ່ອນເລີ່ມຕົ້ນ

- ໃຊ້ issue ຫຼື discussion ກ່ອນສຳລັບ public contract ໃໝ່\, ການປ່ຽນແປງຕໍ່ ພຶດຕິກຳສາທາລະນະຂອງ Auto\, ຂອບເຂດຄວາມປອດໄພ\, ຫຼືການປ່ຽນແປງສະຖາປັດຕະຍະກຳຂະໜາດໃຫຍ່\.
- ໃຫ້ແຕ່ລະ pull request ສຸມໃສ່ຜົນໄດ້ຮັບດຽວ\.
- ຫ້າມ commit ຂໍ້ມູນປະຈຳຕົວ\, prompt ສ່ວນຕົວ\, ປະຫວັດການສົນທະນາດິບ\, host signing key\, ໃບຮັບ provider\, ຫຼື attestation ທີ່ລົງລາຍເຊັນແລ້ວເດັດຂາດ\.
- ລາຍງານຊ່ອງໂຫວ່ແບບສ່ວນຕົວຕາມທີ່ໄດ້ອະທິບາຍໄວ້ໃນ [SECURITY\.md](security.md)\.

## ການກຽມສະພາບແວດລ້ອມພັດທະນາ

ຂໍ້ກຳນົດ\:

- Node\.js 24 ຫຼືໃໝ່ກວ່າ\;
- ບໍ່ມີສ່ວນປະກອບຂອງບຸກຄົນທີສາມທີ່ຕ້ອງພຶ່ງພາໃນຂະນະເຮັດວຽກ\;
- ສາຂາທີ່ສະອາດ ໂດຍອີງໃສ່ສາຂາເປົ້າໝາຍປັດຈຸບັນ\.

ດຳເນີນຊຸດການກວດສອບພື້ນຖານພາຍໃນເຄື່ອງໃຫ້ຄົບຖ້ວນ\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## ກົດການປ່ຽນແປງ

1. ຮັກສາ mutation ທີ່ Root ເປັນເຈົ້າຂອງ ແລະຂອບເຂດ side\-effect ແບບ fail\-closed\.
2. ເມື່ອພຶດຕິກຳສາທາລະນະຂອງ Auto ມີການປ່ຽນແປງ\, ໃຫ້ອັບເດດ template ແລະ skill\, entrypoint catalog\, CLI\, test\, ແລະເອກະສານທີ່ກ່ຽວຂ້ອງທັງໝົດໄປພ້ອມກັນ\.
3. ປະຕິເສດ option ຂອງ CLI ທີ່ບໍ່ຮູ້ຈັກ ແລະຟິວ schema ທີ່ບໍ່ຮູ້ຈັກ\.
4. ເກັບຮັກສາ runtime state ສ່ວນຕົວໄວ້ນອກ repository\.
5. ເພີ່ມ negative test ສຳລັບທຸກດ່ານຄວາມປອດໄພໃໝ່\.
6. ຫ້າມປ່ຽນແປງເວີຊັນ plugin\-cache ທີ່ immutable ທີ່ມີຢູ່ແລ້ວ\. bundle ທີ່ມີການປ່ຽນແປງ ຕ້ອງມີເວີຊັນ build ໃໝ່ ແລະການກວດສອບ digest ຂອງ source\/cache ທີ່ກົງກັນແນ່ນອນ\.

ສຳລັບການຈັດລະບຽບສະເພາະ README\, ໃຫ້ໜ້າລະດັບຮາກອ່ານກວາດຕາໄດ້ງ່າຍ ແລະວາງຂໍ້ຕົກລົງລະອຽດ ໄວ້ໃນໄຟລ໌ທີ່ກົງກັນພາຍໃຕ້ [`docs/guide/`](../../../docs/guide/)\.

## ລາຍການກວດສອບຄຳຂໍຮວມການປ່ຽນແປງ

- [ ] ລະບຸຂອບເຂດ ແລະສິ່ງທີ່ບໍ່ແມ່ນເປົ້າໝາຍຢ່າງຊັດເຈນ\.
- [ ] ມີເອກະສານອະທິບາຍພຶດຕິກຳ ແລະຂອບເຂດຄວາມປອດໄພ\.
- [ ] ການທົດສອບສະເພາະຈຸດຄອບຄຸມທັງເສັ້ນທາງທີ່ສຳເລັດ ແລະລົ້ມເຫຼວ\.
- [ ] ຊຸດການທົດສອບທັງໝົດ ແລະ `sbw eval` ຜ່ານ\.
- [ ] `git diff --check` ຜ່ານ\.
- [ ] ການປ່ຽນແປງເວີຊັນ\/ແຄຊ ປະຕິບັດຕາມກົດການເຜີຍແຜ່ແບບປ່ຽນແປງບໍ່ໄດ້ ເມື່ອກົດນັ້ນນຳໃຊ້\.
- [ ] ບໍ່ມີຂໍ້ມູນລັບ\, ສະຖານະສ່ວນຕົວ ຫຼືຫຼັກຖານຕອບຮັບຈາກພາຍນອກລວມຢູ່\.

ຄວນໃຊ້ບັນທຶກການປ່ຽນແປງຂະໜາດນ້ອຍທີ່ກວດທານໄດ້ງ່າຍ\. ຫ້າມລວມການເກັບກວາດທີ່ບໍ່ກ່ຽວຂ້ອງເຂົ້າກັບ ການປ່ຽນແປງພຶດຕິກຳ\.
