<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Memulai

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · **Bahasa Indonesia** · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 mencakup Codex\, Gemini CLI\, dan Qwen Code di macOS × Node 22\/24\. Kualifikasi Claude Code\, Linux\, dan Windows ditunda hingga V5\.1\. GA memerlukan setidaknya 30 hari canary alami\, 20 kali mulai yang memenuhi syarat berturut\-turut\, dan tiga repositori berbeda\.

| [Ikhtisar](../../../README.md) | [Rincian](../../../docs/details/en.md) | **Mulai cepat** | [Alur kerja](workflows.md) | [Arsitektur](architecture.md) | [Keamanan](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[Ikhtisar dalam 41 edisi yang dilokalkan dan titik akses web resmi](../../../docs/LANGUAGES.md)\. Perintah dan pengenal tetap menggunakan bentuk baku dalam bahasa Inggris\.

V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) telah tersedia untuk umum\. Cakupan rilisnya hanya mencakup Auto\, dengan Codex\, Gemini CLI\, dan Qwen Code di macOS Node 22\/24\. Kualifikasi Linux dan Windows ditangguhkan ke V5\.1\, begitu juga dengan kualifikasi Claude Code\. GA `5.0.0` masih tertunda sampai setidaknya 30 hari canary alami\, 20 permulaan memenuhi syarat berturut\-turut\, dan tiga repositori berbeda tercatat\.

## Persyaratan

- Node\.js 22\.14 atau yang lebih baru untuk helper `sbw` bawaan\.
- Repositori lokal tepercaya\. Better Workflows tidak mengklaim melakukan sandbox pada kode repositori berbahaya\.

Direktori akar penyimpanan status v4 tidak bergantung pada platform\: `SBW_STATE_ROOT` diprioritaskan jika diatur\, lalu `XDG_STATE_HOME/better-workflows`\, dan jika tidak\, `~/.better-workflows`\. Lokasi bawaan tidak lagi berada di bawah `CODEX_HOME`\. Untuk terus menggunakan status Codex v3 yang sudah ada tanpa memindahkannya\, atur `SBW_STATE_ROOT` secara eksplisit ke direktori `<CODEX_HOME>/sbw` yang persis sama sebelum memanggil `sbw`\.

V5\.0 GA \(`5.0.0`\) masih tertunda\. Perintah penginstalan di bawah ini menargetkan V5\.0 RC1 \(`5.0.0-rc.1`\, tag `V5.0.rc1`\) yang telah tersedia untuk umum\.

## Instalasi

### Codex — acuan yang direkomendasikan

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

Buka tugas Codex baru setelah instalasi agar katalog keterampilannya dimuat ulang\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI menyalin ekstensi\. Mulai ulang sesi setelah instalasi\; gunakan `gemini extensions update better-workflows` untuk memperbaruinya nanti\.

Konteks ekstensi menentukan lokasi penghubung dari jalur sumbernya sendiri yang dimuat\, bukan dari direktori kerja proyek Anda\. Untuk instalasi standar dengan cakupan pengguna\, pemeriksaan manual yang setara adalah\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Untuk ekstensi yang ditautkan atau bercakupan ruang kerja\, gunakan direktori akar ekstensi yang persis ditampilkan oleh platform\. Jangan menggantinya dengan checkout yang namanya mirip\.

### Qwen Code

Kunci versi rilis sebelum memasang salinan ekstensi lokal\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code juga menyalin ekstensi\, jadi mulai ulang sesi setelah instalasi dan gunakan `qwen extensions update better-workflows` untuk pembaruan berikutnya\.

Untuk instalasi standar dengan cakupan pengguna\, pemeriksaan penghubung secara manual yang setara adalah\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Aturan penggunaan direktori akar yang persis sama ini juga berlaku untuk instalasi yang ditautkan atau bercakupan ruang kerja\.

## Gunakan Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Setiap titik masuk mempertahankan Goal yang diminta\. Goal aktif yang tidak terkait harus diedit atau dihapus secara eksplisit\; Goal tersebut tidak pernah diganti secara diam\-diam\.

## Pratinjau rute

Snapshot kemampuan bersifat hanya baca dan tidak memicu proses masuk ke penyedia atau pemeriksaan semantik model\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

Untuk serah terima yang dapat ditinjau\, catat lalu gunakan satu catatan privat yang dapat diverifikasi dan hanya dapat digunakan sekali\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Catatan yang dapat diverifikasi kedaluwarsa setelah 24 jam\, dan penggunaannya ditolak jika digunakan ulang atau terjadi penyimpangan pada ruang kerja\, cakupan\, Profiles\, katalog\, kemampuan\, atau bundel plugin\.

## Verifikasi instalasi

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Sebelum mengubah repositori

Auto dimulai dengan pemeriksaan awal ruang kerja yang bersifat hanya baca\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Tugas non\-Git dan tugas hanya baca tidak membuat worktree\. Tugas Git yang melakukan perubahan harus membuat atau menggunakan kembali `TaskWorkspaceLeaseV1` milik tugas tersebut\. Jika direktori kerja sumber berisi perubahan yang belum di\-commit\, proses berhenti sebelum melakukan stash\, penyalinan\, commit\, atau pembuatan worktree apa pun\. HEAD yang terlepas atau target yang tidak ada memerlukan target integrasi eksplisit\. Target yang dilindungi atau berada di remote dialihkan ke proses penyerahan melalui PR yang tunduk pada tata kelola\.

Jika Codex atau platform lain sudah membuat worktree bersih untuk tugas saat ini\, daftarkan sebelum mengedit\, alih\-alih membuat worktree bersarang\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Pendaftaran memerlukan cabang tugas `codex/*` tersendiri pada revisi dasar yang tidak berubah\, direktori bersama Git yang sama\, serta checkout sumber yang bersih\. Better Workflows menggunakan worktree tersebut\, tetapi mempertahankan cabang dan jalur milik platform saat pembersihan\. Untuk target yang dilindungi\, jalankan alur kerja bukti terlebih dahulu\, lalu ikat catatan penggabungan PR dan sinkronisasi remote dari alur kerja tersebut yang dapat diverifikasi dan cocok secara persis menggunakan `workspace reconcile --run-id <run-id>`\.

Berikutnya\: [pilih alur kerja yang tepat](workflows.md) atau jelajahi [referensi CLI](cli-reference.md)\.
