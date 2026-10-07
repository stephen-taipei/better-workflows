<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Menyumbang

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · **Bahasa Melayu** · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Terima kasih kerana membantu menambah baik Better Workflows\.

[README](../../../README.md) · **Menyumbang** · [Tatakelakuan](conduct.md) · [Keselamatan](security.md) · [Tadbir urus](governance.md) · [Sokongan](support.md)

[Gambaran keseluruhan dalam 41 versi setempat dan pintu masuk web rasmi](../../../docs/LANGUAGES.md)\. Versi bahasa Inggeris bagi dasar sumbangan normatif ini kekal sebagai rujukan muktamad\.

## Sebelum anda bermula

- Gunakan isu atau perbincangan terlebih dahulu untuk kontrak awam baharu\, perubahan pada tingkah laku awam Auto\, sempadan keselamatan\, atau perubahan seni bina yang besar\.
- Pastikan setiap satu pull request tertumpu pada satu hasil sahaja\.
- Jangan sekali\-kali komit kelayakan\, prom peribadi\, sejarah perbualan mentah\, kunci menandatangani hos\, resit penyedia\, atau pengesahan bertandatangan\.
- Laporkan kerentanan secara peribadi seperti yang diterangkan dalam [SECURITY\.md](security.md)\.

## Persediaan pembangunan

Keperluan\:

- Node\.js 24 atau lebih baharu\;
- tiada kebergantungan masa jalan pihak ketiga\;
- cabang bersih yang berasaskan cabang sasaran semasa\.

Jalankan keseluruhan semakan asas setempat\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Peraturan perubahan

1. Kekalkan mutasi milik Root dan sempadan kesan sampingan fail\-closed\.
2. Apabila tingkah laku awam Auto berubah\, kemas kini templat dan skill\, katalog entrypoint\, CLI\, ujian\, dan semua dokumentasi yang terjejas secara serentak\.
3. Tolak pilihan CLI yang tidak diketahui dan medan skema yang tidak dikenali\.
4. Simpan keadaan masa jalanan peribadi di luar repositori\.
5. Tambah ujian negatif untuk setiap safety gate baharu\.
6. Jangan ubah versi cache pemalam sedia ada yang tidak boleh diubah \(immutable\)\. Bungkusan yang diubah memerlukan versi binaan baharu dan pengesahan ringkasan \(digest\) sumber\/cache yang tepat\.

Bagi penyusunan yang hanya melibatkan README\, pastikan halaman akar mudah diimbas dan letakkan kontrak terperinci dalam fail yang sepadan di bawah [`docs/guide/`](../../../docs/guide/)\.

## Senarai semak permintaan penggabungan

- [ ] Skop dan perkara yang bukan matlamat dinyatakan dengan jelas\.
- [ ] Tingkah laku dan sempadan keselamatan didokumenkan\.
- [ ] Ujian tertumpu meliputi laluan kejayaan dan kegagalan\.
- [ ] Keseluruhan set ujian dan `sbw eval` lulus\.
- [ ] `git diff --check` lulus\.
- [ ] Perubahan versi\/cache mematuhi peraturan penerbitan yang tidak boleh diubah apabila berkenaan\.
- [ ] Tiada rahsia\, keadaan peribadi atau resit luaran disertakan\.

Komit kecil yang mudah disemak diutamakan\. Jangan gabungkan pengemasan yang tidak berkaitan dengan perubahan tingkah laku\.
