<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Bermula

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · **Bahasa Melayu** · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 merangkumi Codex\, Gemini CLI dan Qwen Code pada macOS × Node 22\/24\. Kelayakan Claude Code\, Linux dan Windows ditangguhkan ke V5\.1\. GA memerlukan sekurang\-kurangnya 30 hari kenari semula jadi\, 20 permulaan layak berturut\-turut dan tiga repositori berbeza\.

| [Gambaran keseluruhan](../../../README.md) | [Butiran](../../../docs/details/en.md) | **Mula pantas** | [Aliran kerja](workflows.md) | [Seni bina](architecture.md) | [Keselamatan](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Gambaran keseluruhan dalam 41 versi setempat dan pintu masuk web rasmi](../../../docs/LANGUAGES.md)\. Arahan dan pengecam kekal dalam bentuk piawai bahasa Inggeris\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) kini tersedia secara umum\. Skop keluarannya hanya meliputi Auto\, bersama Codex\, Gemini CLI\, dan Qwen Code pada macOS Node 22\/24\. Kelayakan Linux dan Windows ditangguhkan ke V5\.1\, begitu juga dengan kelayakan Claude Code\. GA `5.0.0` masih tertunda sehingga sekurang\-kurangnya 30 hari canary semula jadi\, 20 permulaan layak berturut\-turut\, dan tiga repositori berbeza direkodkan\.

## Keperluan

- Node\.js 22\.14 atau lebih baharu untuk pembantu `sbw` yang disertakan\.
- Repositori tempatan yang dipercayai\. Better Workflows tidak mendakwa dapat menyediakan kotak pasir \(sandbox\) untuk kod repositori berniat jahat\.

Direktori akar penyimpanan keadaan v4 tidak bergantung pada platform\: `SBW_STATE_ROOT` diutamakan apabila ditetapkan\, kemudian `XDG_STATE_HOME/better-workflows`\, dan jika tidak\, `~/.better-workflows`\. Lokasi lalai tidak lagi berada di bawah `CODEX_HOME`\. Untuk terus menggunakan keadaan Codex v3 sedia ada tanpa memindahkannya\, tetapkan `SBW_STATE_ROOT` secara jelas kepada direktori `<CODEX_HOME>/sbw` yang tepat itu sebelum memanggil `sbw`\.

V5\.0 GA \(`5.0.0`\) masih tertunda\. Arahan pemasangan di bawah menyasarkan V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) yang tersedia secara umum\.

## Pemasangan

### Codex — rujukan yang disyorkan

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

Buka tugas Codex baharu selepas pemasangan supaya katalog kemahirannya disegarkan semula\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI menyalin sambungan\. Mulakan semula sesi selepas pemasangan\; gunakan `gemini extensions update better-workflows` untuk mengemas kininya kemudian\.

Konteks sambungan menentukan lokasi penghubung daripada laluan sumbernya sendiri yang dimuatkan\, bukannya daripada direktori kerja projek anda\. Untuk pemasangan standard dalam skop pengguna\, semakan manual yang setara ialah\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Untuk sambungan yang dipautkan atau dalam skop ruang kerja\, gunakan direktori akar sambungan yang tepat seperti yang dipaparkan oleh platform\. Jangan gantikannya dengan checkout yang mempunyai nama serupa\.

### Qwen Code

Kunci versi keluaran sebelum memasang salinan sambungan setempat\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code turut menyalin sambungan\, jadi mulakan semula sesi selepas pemasangan dan gunakan `qwen extensions update better-workflows` untuk kemas kini seterusnya\.

Untuk pemasangan standard dalam skop pengguna\, semakan penghubung secara manual yang setara ialah\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Peraturan penggunaan direktori akar yang tepat ini turut terpakai pada pemasangan yang dipautkan atau dalam skop ruang kerja\.

## Gunakan Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Setiap entri mengekalkan Goal yang diminta\. Goal aktif yang tidak berkaitan mesti disunting atau dikosongkan secara jelas\; ia tidak pernah digantikan secara senyap\.

## Pratonton laluan

Petikan keadaan keupayaan bersifat baca sahaja dan tidak mencetuskan log masuk penyedia atau pemeriksaan semantik model\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Untuk serah tugas yang boleh disemak\, catat kemudian gunakan satu rekod peribadi yang boleh disahkan dan hanya boleh digunakan sekali\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Rekod yang boleh disahkan tamat tempoh selepas 24 jam\, dan penggunaannya ditolak apabila digunakan semula atau apabila ruang kerja\, skop\, Profiles\, katalog\, keupayaan atau pakej pemalam tidak lagi sepadan dengan keadaan yang diikat\.

## Sahkan pemasangan

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Sebelum mengubah repositori

Auto bermula dengan semakan awal ruang kerja secara baca sahaja\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Tugas bukan Git dan tugas baca sahaja tidak mencipta worktree\. Tugas Git yang membuat perubahan mesti mencipta atau menggunakan semula `TaskWorkspaceLeaseV1` milik tugas tersebut\. Jika direktori kerja sumber mengandungi perubahan yang belum di\-commit\, proses berhenti sebelum sebarang stash\, penyalinan\, commit atau penciptaan worktree\. HEAD yang terpisah daripada cabang atau ketiadaan sasaran memerlukan sasaran integrasi yang jelas\. Sasaran yang dilindungi atau berada pada repositori jauh dialihkan kepada proses penyerahan melalui PR yang tertakluk pada tadbir urus\.

Jika Codex atau platform lain sudah mencipta worktree yang bersih untuk tugas semasa\, daftarkannya sebelum menyunting dan bukannya mencipta worktree bersarang\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Pendaftaran memerlukan cabang tugas `codex/*` yang berasingan pada revisi asas yang tidak berubah\, direktori bersama Git yang sama dan checkout sumber yang bersih\. Better Workflows menggunakan worktree tersebut tetapi mengekalkan cabang serta laluan milik platform semasa pembersihan\. Bagi sasaran yang dilindungi\, jalankan aliran kerja bukti dahulu\, kemudian ikat rekod penggabungan PR dan penyegerakan jauh daripada aliran kerja itu yang boleh disahkan dan sepadan secara tepat menggunakan `workspace reconcile --run-id <run-id>`\.

Seterusnya\: [pilih workflow yang betul](workflows.md) atau semak imbas [rujukan CLI](cli-reference.md)\.
