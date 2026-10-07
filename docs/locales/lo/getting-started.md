<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# ເລີ່ມຕົ້ນໃຊ້ງານ

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · **ລາວ** · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 ຮອງຮັບ Codex\, Gemini CLI ແລະ Qwen Code ເທິງ macOS × Node 22\/24\. ສ່ວນ Claude Code\, Linux ແລະ Windows ແມ່ນເລື່ອນໄປ V5\.1\. GA ຕ້ອງການຢ່າງໜ້ອຍ 30 ວັນ canary ຕາມທຳມະຊາດ\, 20 ການເລີ່ມຕົ້ນທີ່ຜ່ານເກນຕິດຕໍ່ກັນ ແລະ ສາມ repository ທີ່ຕ່າງກັນ\.

| [ພາບລວມ](../../../README.md) | [ລາຍລະອຽດ](../../../docs/details/en.md) | **ເລີ່ມຕົ້ນຢ່າງໄວ** | [ຂະບວນວຽກ](workflows.md) | [ສະຖາປັດຕະຍະກຳ](architecture.md) | [ຄວາມປອດໄພ](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[ພາບລວມໃນ 41 ສະບັບປັບເຂົ້າທ້ອງຖິ່ນ ແລະ ຊ່ອງທາງເຂົ້າເວັບທາງການ](../../../docs/LANGUAGES.md)\. ຄຳສັ່ງ ແລະ ຕົວລະບຸຍັງຄົງໃຊ້ຮູບແບບມາດຕະຖານພາສາອັງກິດ\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) ເປີດໃຫ້ໃຊ້ງານສາທາລະນະແລ້ວ\. ຂອບເຂດການປ່ອຍເວີຊັນກວມເອົາສະເພາະ Auto\, ໂດຍມີ Codex\, Gemini CLI\, ແລະ Qwen Code ເທິງ macOS Node 22\/24\. ການຮັບຮອງສຳລັບ Linux ແລະ Windows ຖືກເລື່ອນໄປເປັນ V5\.1\, ເຊັ່ນດຽວກັບການຮັບຮອງ Claude Code\. GA `5.0.0` ຍັງຄົງລໍຖ້າຈົນກວ່າຈະບັນທຶກ canary ຄົບຢ່າງໜ້ອຍ 30 ວັນຕາມທຳມະຊາດ\, ການເລີ່ມຕົ້ນທີ່ມີສິດ 20 ຄັ້ງຕິດຕໍ່ກັນ\, ແລະສາມ repository ທີ່ແຕກຕ່າງກັນ\.

## ຂໍ້ກຳນົດ

- Node\.js 22\.14 ຫຼື ໃໝ່ກວ່າ ສຳລັບຕົວຊ່ວຍ `sbw` ທີ່ມານຳກັນ\.
- repository ທ້ອງຖິ່ນທີ່ເຊື່ອຖືໄດ້\. Better Workflows ບໍ່ໄດ້ອ້າງວ່າມີ sandbox ສຳລັບໂຄ້ດ repository ທີ່ເປັນອັນຕະລາຍ\.

ໂຟນເດີຮາກເກັບສະຖານະຂອງ v4 ບໍ່ຜູກກັບແພລດຟອມໃດໜຶ່ງ\: ຖ້າຕັ້ງຄ່າ `SBW_STATE_ROOT` ໄວ້ ຈະໃຊ້ຄ່ານັ້ນກ່ອນ\, ຕໍ່ມາແມ່ນ `XDG_STATE_HOME/better-workflows`\, ຖ້າບໍ່ມີຈະໃຊ້ `~/.better-workflows`\. ຕຳແໜ່ງເລີ່ມຕົ້ນບໍ່ຢູ່ພາຍໃຕ້ `CODEX_HOME` ອີກຕໍ່ໄປ\. ເພື່ອໃຊ້ສະຖານະ Codex v3 ທີ່ມີຢູ່ຕໍ່ໂດຍບໍ່ຍ້າຍມັນ\, ໃຫ້ຕັ້ງ `SBW_STATE_ROOT` ຢ່າງຊັດເຈນໄປຫາໂຟນເດີ `<CODEX_HOME>/sbw` ນັ້ນໃຫ້ກົງທຸກປະການກ່ອນເອີ້ນໃຊ້ `sbw`\.

V5\.0 GA \(`5.0.0`\) ຍັງຄົງລໍຖ້າຢູ່\. ຄຳສັ່ງຕິດຕັ້ງດ້ານລຸ່ມແມ່ນກຳນົດເປົ້າໝາຍໃສ່ V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) ທີ່ເປີດໃຫ້ໃຊ້ງານສາທາລະນະ\.

## ຕິດຕັ້ງ

### Codex — ແພລດຟອມອ້າງອີງທີ່ແນະນຳ

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

ເປີດວຽກ Codex ໃໝ່ຫຼັງຕິດຕັ້ງ ເພື່ອໂຫຼດລາຍການທັກສະຂອງມັນຄືນໃໝ່\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI ຄັດລອກສ່ວນຂະຫຍາຍ\. ໃຫ້ເລີ່ມເຊດຊັນໃໝ່ຫຼັງຕິດຕັ້ງ\; ໃຊ້ `gemini extensions update better-workflows` ເພື່ອອັບເດດໃນພາຍຫຼັງ\.

ບໍລິບົດຂອງສ່ວນຂະຫຍາຍກຳນົດຕຳແໜ່ງຕົວເຊື່ອມຈາກເສັ້ນທາງຊອດຂອງຕົວມັນເອງທີ່ຖືກໂຫຼດ\, ບໍ່ແມ່ນຈາກໂຟນເດີເຮັດວຽກຂອງໂຄງການ\. ສຳລັບການຕິດຕັ້ງມາດຕະຖານໃນຂອບເຂດຜູ້ໃຊ້\, ການກວດດ້ວຍຕົນເອງທີ່ທຽບເທົ່າກັນແມ່ນ\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

ສຳລັບສ່ວນຂະຫຍາຍທີ່ເຊື່ອມໂຍງໄວ້ ຫຼືຢູ່ໃນຂອບເຂດພື້ນທີ່ເຮັດວຽກ\, ໃຫ້ໃຊ້ໂຟນເດີຮາກຂອງສ່ວນຂະຫຍາຍທີ່ກົງກັບທີ່ແພລດຟອມສະແດງທຸກປະການ\. ຢ່າໃຊ້ checkout ທີ່ມີຊື່ຄ້າຍກັນແທນ\.

### Qwen Code

ຕຶງລຸ້ນເຜີຍແຜ່ໄວ້ກ່ອນຕິດຕັ້ງສຳເນົາສ່ວນຂະຫຍາຍພາຍໃນເຄື່ອງ\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code ກໍຄັດລອກສ່ວນຂະຫຍາຍເຊັ່ນກັນ\, ດັ່ງນັ້ນໃຫ້ເລີ່ມເຊດຊັນໃໝ່ຫຼັງຕິດຕັ້ງ ແລະ ໃຊ້ `qwen extensions update better-workflows` ສຳລັບການອັບເດດໃນພາຍຫຼັງ\.

ສຳລັບການຕິດຕັ້ງມາດຕະຖານໃນຂອບເຂດຜູ້ໃຊ້\, ການກວດຕົວເຊື່ອມດ້ວຍຕົນເອງທີ່ທຽບເທົ່າກັນແມ່ນ\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

ກົດການໃຊ້ໂຟນເດີຮາກໃຫ້ກົງທຸກປະການນີ້ ຍັງໃຊ້ກັບການຕິດຕັ້ງທີ່ເຊື່ອມໂຍງໄວ້ ຫຼືຢູ່ໃນຂອບເຂດພື້ນທີ່ເຮັດວຽກ\.

## ໃຊ້ Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

ທຸກຕົວເລືອກເລີ່ມວຽກຈະຮັກສາ Goal ທີ່ຮ້ອງຂໍໄວ້\. Goal ທີ່ກຳລັງເຮັດວຽກແຕ່ບໍ່ກ່ຽວຂ້ອງຕ້ອງຖືກແກ້ໄຂ ຫຼືລ້າງຢ່າງຊັດເຈນ\; ມັນຈະບໍ່ຖືກແທນທີ່ຢ່າງງຽບໆ\.

## ເບິ່ງເສັ້ນທາງລ່ວງໜ້າ

ພາບບັນທຶກຄວາມສາມາດເປັນແບບອ່ານຢ່າງດຽວ ແລະ ບໍ່ກະຕຸ້ນການເຂົ້າລະບົບຜູ້ໃຫ້ບໍລິການ ຫຼືການກວດເຊີງຄວາມໝາຍຂອງໂມເດວ\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

ເພື່ອໃຫ້ທົບທວນການສົ່ງຕໍ່ວຽກໄດ້\, ໃຫ້ບັນທຶກແລ້ວໃຊ້ບັນທຶກສ່ວນຕົວທີ່ກວດຢືນຢັນໄດ້ໜຶ່ງລາຍການ ທີ່ໃຊ້ໄດ້ພຽງຄັ້ງດຽວ\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

ບັນທຶກທີ່ກວດຢືນຢັນໄດ້ຈະໝົດອາຍຸຫຼັງ 24 ຊົ່ວໂມງ ແລະ ລະບົບຈະປະຕິເສດການໃຊ້ງານເມື່ອມີການໃຊ້ຊ້ຳ ຫຼືມີການຄາດເຄື່ອນໃນພື້ນທີ່ເຮັດວຽກ\, ຂອບເຂດ\, Profiles\, ແຄັດຕາລັອກ\, ຄວາມສາມາດ ຫຼືຊຸດປລັກອິນ\.

## ກວດຢືນຢັນການຕິດຕັ້ງ

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## ກ່ອນປ່ຽນແປງຄັງໂຄດ

Auto ເລີ່ມດ້ວຍການກວດພື້ນທີ່ເຮັດວຽກລ່ວງໜ້າແບບອ່ານຢ່າງດຽວ\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

ວຽກທີ່ບໍ່ໃຊ້ Git ແລະ ວຽກແບບອ່ານຢ່າງດຽວບໍ່ສ້າງ worktree\. ວຽກ Git ທີ່ມີການປ່ຽນແປງຕ້ອງສ້າງ ຫຼືນຳ `TaskWorkspaceLeaseV1` ທີ່ວຽກນັ້ນເປັນເຈົ້າຂອງກັບມາໃຊ້\. ຖ້າໂຟນເດີເຮັດວຽກຂອງຊອດມີການປ່ຽນແປງທີ່ຍັງບໍ່ໄດ້ commit\, ຂະບວນການຈະຢຸດກ່ອນການ stash\, ຄັດລອກ\, commit ຫຼືສ້າງ worktree ໃດໆ\. HEAD ທີ່ແຍກອອກຈາກສາຂາ ຫຼືການບໍ່ມີເປົ້າໝາຍ ຈຳເປັນຕ້ອງລະບຸເປົ້າໝາຍການລວມຢ່າງຊັດເຈນ\. ເປົ້າໝາຍທີ່ປ້ອງກັນໄວ້ ຫຼືຢູ່ທາງໄກ ຈະຖືກຍົກລະດັບໄປສູ່ການສົ່ງມອບຜ່ານ PR ພາຍໃຕ້ການກຳກັບດູແລ\.

ຖ້າ Codex ຫຼືແພລດຟອມອື່ນໄດ້ສ້າງ worktree ທີ່ສະອາດສຳລັບວຽກປັດຈຸບັນແລ້ວ\, ໃຫ້ລົງທະບຽນມັນກ່ອນແກ້ໄຂ ແທນການສ້າງ worktree ຊ້ອນກັນ\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

ການລົງທະບຽນຕ້ອງໃຊ້ສາຂາວຽກ `codex/*` ທີ່ແຍກຕ່າງຫາກຢູ່ທີ່ລຸ້ນຖານເດີມທີ່ບໍ່ປ່ຽນແປງ\, ໂຟນເດີຮ່ວມຂອງ Git ດຽວກັນ ແລະ checkout ຊອດທີ່ສະອາດ\. Better Workflows ໃຊ້ worktree ນັ້ນ ແຕ່ຮັກສາສາຂາ ແລະ ເສັ້ນທາງທີ່ແພລດຟອມເປັນເຈົ້າຂອງໄວ້ໃນຂະນະທຳຄວາມສະອາດ\. ສຳລັບເປົ້າໝາຍທີ່ປ້ອງກັນໄວ້\, ໃຫ້ເອີ້ນໃຊ້ຂະບວນວຽກຫຼັກຖານກ່ອນ\, ແລ້ວຜູກບັນທຶກທີ່ກວດຢືນຢັນໄດ້ຂອງການລວມ PR ແລະ ການຊິງທາງໄກຈາກຂະບວນວຽກນັ້ນໃຫ້ກົງທຸກປະການດ້ວຍ `workspace reconcile --run-id <run-id>`\.

ຕໍ່ໄປ\: [ເລືອກ workflow ທີ່ເໝາະສົມ](workflows.md) ຫຼື ເບິ່ງ [ເອກະສານອ້າງອີງ CLI](cli-reference.md)\.
