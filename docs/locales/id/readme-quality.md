<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# Cetak biru kualitas README

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · **Bahasa Indonesia** · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[Ikhtisar dalam 41 edisi yang dilokalkan dan titik akses web resmi](../../../docs/LANGUAGES.md)\. Versi bahasa Inggris cetak biru editorial ini tetap menjadi acuan kanonis\.

README Better Workflows adalah halaman pengantar\, bukan panduan referensi yang dipadatkan\. Tugasnya membantu pembaca menjawab lima pertanyaan secara berurutan\:

1. Apa ini\, dan apakah cocok untuk saya\?
2. Masalah apa yang diselesaikannya\?
3. Mengapa saya harus memercayai klaimnya\?
4. Apa jalur terpendek menuju keberhasilan pertama\?
5. Ke mana saya harus melanjutkan\?

Cetak biru ini menetapkan kontrak narasi\, visual\, lokalisasi\, dan validasi untuk setiap README repositori\. Sumber yang dapat dibaca mesin adalah [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)\.

## Mulai dari keputusan pembaca

GitHub menampilkan README sebelum sebagian besar konten repositori\. Karena itu\, layar pertama harus menjelaskan janji produk\, audiens yang dituju\, dan tindakan berikutnya yang memiliki batas cakupan\. Halaman tidak boleh dimulai dengan arsitektur internal\, referensi perintah lengkap\, atau rincian pemulihan rilis\.

Tulis untuk tugas\-tugas pembaca berikut\:

- **Pengunjung baru\:** tentukan dengan cepat apakah Better Workflows menyelesaikan masalah yang relevan\.
- **Pengguna baru\:** instal plugin dan capai satu rute otomatis yang berhasil\.
- **Evaluator\:** pahami batas otoritas dan perilaku fail\-closed\.
- **Operator lama\:** lompat ke jawaban seputar alur kerja\, keamanan\, arsitektur\, atau CLI\.
- **Kontributor atau penerjemah\:** temukan kontrak kanonikal\, perintah pengembangan\, dukungan\, dan tata kelola\.

## Gunakan narasi sebab\-akibat

Kelima README pengantar menggunakan urutan semantik delapan bagian yang sama\. Judul boleh mengikuti kelaziman setiap bahasa\, tetapi perjalanan pembaca tidak berubah\.

| Bagian | Pertanyaan pembaca dan peran naratif |
| --- | --- |
| Janji dan audiens | Apa itu Better Workflows\, mengapa ada\, dan untuk siapa\? |
| Dari masalah ke hasil | Apa yang salah ketika maksud\, kewenangan\, bukti\, dan hasil penyedia dicampuradukkan\? |
| Pembuktian dan batas | Jaminan apa yang membuat hasil yang diusulkan dapat dipercaya\? |
| Keberhasilan pertama | Apa jalur lengkap terpendek dari pemasangan hingga hasil\? |
| Pilih jalur berikutnya | Alur kerja atau dokumen mana yang sesuai dengan tujuan pembaca\? |
| Siklus hidup | Bagaimana sebuah tujuan berujung pada penyelesaian yang statusnya telah direkonsiliasi—atau berhenti dengan aman\? |
| Kepercayaan dan keterbatasan | Apa yang tidak pernah dapat disimpulkan\, diizinkan\, atau diklaim oleh sistem\? |
| Belajar\, memperoleh bantuan\, berkontribusi | Di mana dokumentasi mendalam\, dukungan\, tata kelola\, pengembangan\, dan lisensi\? |

Urutan ini memberikan alur praktis\:

- **Konteks\:** pekerjaan yang digerakkan oleh prompt dapat menyatakan maksud tanpa membuktikan kewenangan atau status\.
- **Ketegangan\:** efek samping mengubah kesenjangan itu menjadi risiko penyampaian hasil\.
- **Penyelesaian\:** Better Workflows mengikat tujuan\, cakupan\, bukti\, peninjauan\, tindakan\, dan rekonsiliasi dengan penyedia\.
- **Pembuktian\:** jaminan dan batas yang eksplisit menunjukkan cara kerja penyelesaian tersebut\.
- **Tindakan\:** pembaca mencapai keberhasilan pertama sebelum menemui rincian implementasi yang mendalam\.
- **Kelanjutan\:** rute berdasarkan peran dan hasil mengarahkan pembaca ke tutorial\, panduan praktis\, penjelasan\, atau referensi yang tepat\.

## Pisahkan konten pengantar dari dokumentasi mendalam

Gunakan README untuk informasi yang relevan bagi keputusan\. Arahkan pembahasan mendalam menurut tujuannya\:

- [Memulai](getting-started.md) adalah tutorial penggunaan pertama\.
- [Alur kerja](workflows.md) adalah panduan praktis untuk memilih hasil\.
- [Arsitektur](architecture.md) menjelaskan bidang kendali serta kelebihan dan kekurangan pilihan\.
- [Keamanan](security-guide.md) menjelaskan kewenangan\, privasi\, atestasi\, dan perilaku yang menolak melanjutkan selama belum terverifikasi\.
- [Referensi CLI](cli-reference.md) adalah referensi perintah\.
- Halaman `docs/details/*.md` yang dilokalkan mempertahankan rincian terjemahan yang menyeluruh\.

Jangan menduplikasi pemulihan tembolok\, kepemilikan kunci penguncian\, semantik transportasi penyedia yang lengkap\, daftar perintah menyeluruh\, atau riwayat perubahan implementasi pada halaman pengantar\. Klaim keselamatan yang ringkas tetap berada di halaman itu\; rincian yang dapat diaudit harus ditempatkan dalam panduan kanonis\.

Pemisahan ini mengikuti pembedaan Diátaxis antara tutorial\, panduan praktis\, penjelasan\, dan referensi\. Satu halaman tidak dapat sekaligus mengoptimalkan keempat kebutuhan pembaca tersebut\.

## Pastikan setiap visual memiliki alasan untuk ditampilkan

Gunakan visual hanya ketika hubungan\, hierarki\, atau transisi status menjadi jauh lebih mudah dipahami dibandingkan melalui uraian teks\.

Halaman pengantar mengizinkan dua visual\:

1. **Arsitektur batas kewenangan\:** menjawab lapisan mana yang membentuk maksud\, fakta terkini\, kewenangan alat\, percobaan ulang terbatas\, dan status hanya baca\.
2. **Siklus tujuan hingga penyelesaian\:** menjawab di mana bukti diperiksa\, di mana efek samping diizinkan\, dan di mana status yang belum diketahui menghentikan kemajuan\.

Setiap visual harus menyertakan\:

- teks alternatif yang ringkas dan bermakna\;
- padanan teks di sebelahnya yang mempertahankan kesimpulan ketika visual disembunyikan atau Mermaid tidak dirender\;
- teks sungguhan untuk label penting bila memungkinkan\;
- pertanyaan pembaca yang tetap relevan dan membenarkan perlunya menjaga visual tetap mutakhir\.

Jangan menambahkan tangkapan layar dekoratif\, gambar yang dipenuhi teks\, atau diagram yang hanya menduplikasi daftar pendek\. Batasi tabel pilihan menjadi dua kolom ringkas agar tetap dapat digunakan pada layar sempit\.

## Pertahankan makna lintas bahasa

Bahasa Inggris adalah acuan semantik\, bukan target jumlah baris\. Bahasa Mandarin Tradisional\, Mandarin Sederhana\, Jepang\, dan Korea harus terdengar alami bagi pembaca penutur asli sambil mempertahankan kontrak yang sama\.

Hal\-hal berikut harus tetap setara\:

- delapan bagian semantik dan urutannya\;
- perintah keberhasilan pertama dan pengenal produk\;
- lima klaim tentang kewenangan\, bukti\, status yang belum diketahui\, prompt\, dan privasi\;
- tujuan tautan alur kerja\, keamanan\, arsitektur\, CLI\, dukungan\, tata kelola\, pengembangan\, dan lisensi\;
- tujuan visual\, tahap siklus hidup\, dan alternatif teks\;
- sumber versi dan kebijakan lencana\.

Judul\, batas kalimat\, tanda baca\, contoh\, dan ajakan bertindak boleh mengikuti kelaziman bahasa\. Jangan pernah menerjemahkan perintah\, selektor\, pengenal bukti\, atau semantik keamanan\.

## Tulis agar mudah dipindai dan diterjemahkan

- Awali dengan hasil bagi pembaca dan letakkan istilah penting di awal judul dan paragraf\.
- Gunakan kalimat aktif dan sebutkan pihak yang bertanggung jawab atas tindakan\.
- Sapa pembaca secara langsung dalam prosedur\.
- Buat paragraf pendek dan berikan satu tugas untuk setiap paragraf\.
- Gunakan daftar bernomor untuk urutan dan butir untuk pilihan yang tidak berurutan\.
- Gunakan tautan deskriptif\, bukan label umum seperti “klik di sini”\.
- Pertahankan judul yang hierarkis\, spesifik\, dan sejajar pada tingkat yang sama\.
- Utamakan bahasa harfiah yang tidak ambigu dan tetap jelas setelah diterjemahkan\.
- Letakkan kondisi sebelum instruksi dan hasil yang diharapkan setelah perintah\.

## Validasi semantik\, bukan dekorasi

Pengujian dokumentasi harus mendeteksi lebih dari sekadar kecocokan judul\. Pengujian memverifikasi\:

- satu H1 dan hierarki judul yang logis\;
- penanda bagian semantik terurut dan klaim penting\;
- perintah keberhasilan pertama yang tepat dan pengidentifikasi yang stabil\;
- tautan relatif dan tujuan detail khusus lokal\;
- paritas badge versi dengan metadata runtime\;
- teks alternatif gambar yang bermakna dan fallback visual yang berdampingan\;
- siklus hidup Mermaid tunggal dengan padanan teks lengkap\;
- tabel dua kolom dan batasan panjang paragraf\;
- ketiadaan detail implementasi mendalam yang ditentukan dari landing page\;

## Dasar penelitian

- [GitHub\: Tentang berkas README repositori](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) mendefinisikan tujuan README pada kunjungan pertama dan menyarankan pemindahan dokumentasi panjang ke tempat lain\.
- [Diátaxis](https://diataxis.fr/start-here/) memisahkan kebutuhan tutorial\, panduan praktis\, penjelasan\, dan referensi\.
- [Microsoft\: Konten yang mudah dipindai](https://learn.microsoft.com/en-us/style-guide/scannable-content/) menekankan struktur yang mendahulukan hal terpenting\, paragraf pendek\, dan titik masuk visual yang konsisten\.
- [Gaya dokumentasi pengembang Google](https://developers.google.com/style/highlights) menyarankan kalimat aktif\, sapaan langsung\, judul deskriptif\, aksesibilitas\, dan penulisan untuk audiens global\.
- [GitHub\: Membuat diagram](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) mendokumentasikan dukungan Mermaid dalam Markdown\.
- [W3C WAI\: Tutorial gambar](https://www.w3.org/WAI/tutorials/images/) mewajibkan alternatif teks dan padanan lengkap untuk visual yang informatif dan kompleks\.
