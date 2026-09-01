<div align="center">

# Better Workflows

AI agent menyesuaikan kekuatan verifikasi dengan risiko dan menyelesaikan pekerjaan dengan aman di lingkungan terisolasi. Perubahan sederhana berjalan cepat; pekerjaan penting memakai evidence gates; perubahan Git secara default memakai worktree khusus.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · **Bahasa Indonesia** · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Jelajahi dokumentasi](https://betterworkflows.dev/id/docs/) · [Buka GitHub](https://github.com/stephen-taipei/better-workflows) · [Dukung di Ko-fi](https://ko-fi.com/betterworkflows)

</div>

## Bawa pekerjaan agent<br>hingga selesai dengan bukti.

Better Workflows mengunci goal, scope, dan authority, lalu mengikat setiap keputusan pada bukti terkini yang dapat diverifikasi ulang dan hasil eksternal yang telah direkonsiliasi.

## Empat batas tegas dari niat hingga penyelesaian.

Tentukan contract, verifikasi source dan evidence, rekonsiliasi efek eksternal, lalu nyatakan selesai hanya saat terminal state sudah diketahui.

- **01 · `TaskContract`** — Better Workflows mengunci goal, scope, dan authority, lalu mengikat setiap keputusan pada bukti terkini yang dapat diverifikasi ulang dan hasil eksternal yang telah direkonsiliasi.
- **02 · `evidence`** — AI agent menyesuaikan kekuatan verifikasi dengan risiko dan menyelesaikan pekerjaan dengan aman di lingkungan terisolasi. Perubahan sederhana berjalan cepat; pekerjaan penting memakai evidence gates; perubahan Git secara default memakai worktree khusus.
- **03 · `reconciliation`** — Tentukan contract, verifikasi source dan evidence, rekonsiliasi efek eksternal, lalu nyatakan selesai hanya saat terminal state sudah diketahui.
- **04 · `terminal state`** — Perintah yang berjalan bukan bukti selesai; hasil yang dapat diverifikasi ulang adalah buktinya.

## Mulai cepat

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## Lanjutkan dari peta arsitektur ke kasus penggunaan praktis.

- [Empat batas tegas dari niat hingga penyelesaian.](https://betterworkflows.dev/id/docs/)
- [Mulai cepat](https://betterworkflows.dev/id/docs/quick/)
- [Lanjutkan dari peta arsitektur ke kasus penggunaan praktis.](https://betterworkflows.dev/id/docs/use-cases/)
- [Mulai cepat — Lanjutkan dari peta arsitektur ke kasus penggunaan praktis.](https://betterworkflows.dev/id/docs/use-cases/quick/)
- [Evidence Cinema](https://betterworkflows.dev/id/docs/evidence-cinema/)


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
- [Buka GitHub](https://github.com/stephen-taipei/better-workflows)

## Bantu menjaga Better Workflows tetap terawat.

Dukungan satu kali membantu pemeliharaan open source, dokumentasi, 41 versi terlokalisasi, dan hosting situs. Dukungan ini tidak memberikan keanggotaan atau prioritas dalam peta jalan maupun bantuan.

[Dukung di Ko-fi](https://ko-fi.com/betterworkflows)

---

Perintah yang berjalan bukan bukti selesai; hasil yang dapat diverifikasi ulang adalah buktinya.
