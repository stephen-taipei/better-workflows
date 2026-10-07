<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Kebijakan keamanan

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · **Bahasa Indonesia** · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Berkontribusi](contributing.md) · [Kode etik](conduct.md) · **Keamanan** · [Tata kelola](governance.md) · [Dukungan](support.md)

[Ikhtisar dalam 41 edisi yang dilokalkan dan titik akses web resmi](../../../docs/LANGUAGES.md)\. Versi bahasa Inggris kebijakan keamanan normatif ini tetap menjadi acuan resmi\.

Jika satu\-satunya sumber bukti yang diusulkan berisi riwayat pribadi atau materi operasional sensitif yang tidak dapat dibersihkan dari informasi sensitif\, jangan kumpulkan atau kirimkan sumber tersebut\. Catat hanya alasan `REJECTED_WITH_EVIDENCE` yang informasi sensitifnya telah disamarkan\.

## Versi yang didukung

| Versi | Dukungan |
| --- | --- |
| Rilis terbaru yang telah dipublikasikan dan hasil build Codex yang tidak dapat diubah | Didukung |
| Versi tembolok lama yang tidak dapat diubah | Sasaran pengembalian versi\; perbaikan tidak diterapkan ke versi lama kecuali diumumkan secara tegas |
| Fork yang belum dirilis atau isi tembolok yang dimodifikasi | Tidak didukung |

## Melaporkan kerentanan

Gunakan [pelaporan kerentanan privat GitHub](https://github.com/stephen-taipei/better-workflows/security/advisories/new)\. Jangan membuka isu publik untuk kerentanan yang dicurigai\.

Sertakan\:

- versi dan hasil build plugin yang terdampak\;
- lingkungan dan versi Node\.js\;
- langkah reproduksi minimal\;
- batas keamanan yang diharapkan dan yang diamati\;
- dampak serta solusi sementara yang diketahui\;
- keterangan apakah laporan berisi materi rahasia\.

Jangan sertakan kredensial aktif\, kunci penandatanganan\, token penyedia\, prompt pribadi mentah\, atau data pribadi pihak ketiga\.

## Tanggapan

Pemelihara akan mengonfirmasi penerimaan laporan yang dapat ditindaklanjuti\, memvalidasi cakupannya\, dan mengoordinasikan perbaikan serta pengungkapan\. Tidak ada janji SLA dengan waktu tanggapan tetap\. Hasil yang belum diketahui atau belum direkonsiliasi tetap diblokir\, dengan menolak kelanjutan jika belum terverifikasi\.

## Batas keamanan

Better Workflows mengasumsikan repositori lokal\, host\, dan rantai alat yang dapat dieksekusi tepercaya\. Model Perizinan Node merupakan pertahanan berlapis dan bukan kotak pasir sistem operasi untuk kode berbahaya\. Lihat [panduan keamanan](security-guide.md) lengkap\.
