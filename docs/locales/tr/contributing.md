<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# Katkıda bulunma

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · **Türkçe** · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Better Workflows\'u geliştirmeye yardımcı olduğunuz için teşekkür ederiz\.

[README](../../../README.md) · **Katkıda bulunma** · [Davranış kuralları](conduct.md) · [Güvenlik](security.md) · [Proje yönetimi](governance.md) · [Destek](support.md)

[41 yerelleştirilmiş sürümde genel bakış ve resmî web giriş noktaları](../../../docs/LANGUAGES.md)\. Bu normatif katkı politikasında esas alınan metin İngilizce sürümdür\.

## Başlamadan önce

- Yeni bir genel sözleşme\, Auto\'nun genel davranışında bir değişiklik\, bir güvenlik sınırı veya büyük bir mimari değişiklik için önce bir issue veya discussion kullanın\.
- Her pull request\'i tek bir amaca odaklı tutun\.
- Kimlik bilgilerini\, özel prompt\'ları\, ham konuşma geçmişini\, ana bilgisayar imzalama anahtarlarını\, sağlayıcı makbuzlarını veya imzalı tasdikleri asla commit\'lemeyin\.
- Güvenlik açıklarını [SECURITY\.md](security.md) dosyasında açıklandığı gibi gizlice bildirin\.

## Geliştirme ortamının kurulumu

Gereksinimler\:

- Node\.js 24 veya üzeri\;
- üçüncü taraf çalışma zamanı bağımlılığı bulunmaması\;
- mevcut hedef dalı temel alan temiz bir dal\.

Yerel temel kontrollerin tamamını çalıştırın\:

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## Değişiklik kuralları

1. Root sahipliğindeki mutasyonu ve fail\-closed yan etki sınırlarını koruyun\.
2. Auto\'nun genel davranışı değiştiğinde şablonunu ve skill\'ini\, giriş noktası kataloğunu\, CLI\'ı\, testleri ve etkilenen tüm belgeleri birlikte güncelleyin\.
3. Bilinmeyen CLI seçeneklerini ve bilinmeyen şema alanlarını reddedin\.
4. Özel runtime durumunu deponun dışında tutun\.
5. Her yeni güvenlik kapısı için negatif testler ekleyin\.
6. Mevcut ve değişmez bir plugin\-cache sürümünü mutate etmeyin\. Değiştirilmiş bir paket\, yeni bir derleme sürümü ve tam kaynak\/önbellek özeti doğrulaması gerektirir\.

Yalnızca README düzenlemesi yaparken kök sayfayı hızlıca gözden geçirilebilir tutun ve ayrıntılı sözleşmeleri [`docs/guide/`](../../../docs/guide/) altındaki ilgili dosyaya yerleştirin\.

## Çekme isteği kontrol listesi

- [ ] Kapsam ve hedeflenmeyenler açıkça belirtilmiştir\.
- [ ] Davranış ve güvenlik sınırları belgelenmiştir\.
- [ ] Odaklı testler başarı ve başarısızlık yollarını kapsar\.
- [ ] Test paketinin tamamı ve `sbw eval` başarıyla geçer\.
- [ ] `git diff --check` başarıyla geçer\.
- [ ] Geçerli olduğu durumlarda sürüm\/önbellek değişiklikleri\, değiştirilemez yayımlama kurallarına uyar\.
- [ ] Gizli bilgiler\, özel durum veya haricî alındılar içermez\.

Küçük ve incelenebilir değişiklik kayıtları tercih edilir\. İlgisiz temizleme çalışmalarını bir davranış değişikliğiyle birleştirmeyin\.
