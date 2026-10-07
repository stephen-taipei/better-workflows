<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Berkontribusi

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · **Bahasa Indonesia** · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Terima kasih telah membantu meningkatkan Better Workflows\.

[README](../../../README.md) · **Berkontribusi** · [Kode etik](conduct.md) · [Keamanan](security.md) · [Tata kelola](governance.md) · [Dukungan](support.md)

[Ikhtisar dalam 41 edisi yang dilokalkan dan titik akses web resmi](../../../docs/LANGUAGES.md)\. Versi bahasa Inggris kebijakan kontribusi normatif ini tetap menjadi acuan resmi\.

## Sebelum memulai

- Gunakan issue atau diskusi terlebih dahulu untuk kontrak publik baru\, perubahan pada perilaku publik Auto\, batas keamanan\, atau perubahan arsitektur besar\.
- Pastikan satu pull request berfokus pada satu hasil\.
- Jangan pernah melakukan commit untuk kredensial\, prompt pribadi\, riwayat percakapan mentah\, kunci penandatanganan host\, tanda terima penyedia\, atau atestasi yang ditandatangani\.
- Laporkan kerentanan secara privat seperti yang dijelaskan dalam [SECURITY\.md](security.md)\.

## Penyiapan pengembangan

Persyaratan\:

- Node\.js 24 atau lebih baru\;
- tanpa dependensi pihak ketiga saat dijalankan\;
- cabang bersih yang didasarkan pada cabang target saat ini\.

Jalankan seluruh pemeriksaan dasar lokal\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Aturan perubahan

1. Pertahankan mutasi milik Root dan batas efek samping fail\-closed\.
2. Ketika perilaku publik Auto berubah\, perbarui template dan skill\-nya\, katalog entrypoint\, CLI\, pengujian\, serta semua dokumentasi yang terpengaruh secara bersamaan\.
3. Tolak opsi CLI yang tidak dikenal dan field skema yang tidak dikenal\.
4. Simpan status runtime privat di luar repositori\.
5. Tambahkan pengujian negatif untuk setiap safety gate baru\.
6. Jangan memutasi versi plugin\-cache yang tidak dapat diubah \(immutable\)\. Bundle yang diubah memerlukan versi build baru dan verifikasi digest sumber\/cache yang tepat\.

Untuk penataan yang hanya menyangkut README\, pastikan halaman akar mudah dipindai dan letakkan kontrak terperinci dalam berkas yang sesuai di bawah [`docs/guide/`](../../../docs/guide/)\.

## Daftar periksa permintaan penggabungan

- [ ] Cakupan dan hal yang bukan sasaran dinyatakan secara tegas\.
- [ ] Perilaku dan batas keselamatan didokumentasikan\.
- [ ] Pengujian terfokus mencakup jalur keberhasilan dan kegagalan\.
- [ ] Seluruh rangkaian pengujian dan `sbw eval` lulus\.
- [ ] `git diff --check` lulus\.
- [ ] Perubahan versi\/tembolok mengikuti aturan publikasi yang tidak dapat diubah jika berlaku\.
- [ ] Tidak ada rahasia\, status privat\, atau bukti penerimaan eksternal yang disertakan\.

Utamakan komit kecil yang mudah ditinjau\. Jangan gabungkan pembersihan yang tidak terkait dengan perubahan perilaku\.
