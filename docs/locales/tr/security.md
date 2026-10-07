<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# Güvenlik politikası

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · **Türkçe** · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [Katkıda bulunma](contributing.md) · [Davranış kuralları](conduct.md) · **Güvenlik** · [Proje yönetimi](governance.md) · [Destek](support.md)

[41 yerelleştirilmiş sürümde genel bakış ve resmî web giriş noktaları](../../../docs/LANGUAGES.md)\. Bu normatif güvenlik politikasında esas alınan metin İngilizce sürümdür\.

Önerilen tek kanıt kaynağı\, hassas bilgilerden arındırılamayan özel geçmiş kayıtları veya hassas operasyonel materyaller içeriyorsa bunları toplamayın veya iletmeyin\. Yalnızca hassas kısımları karartılmış bir `REJECTED_WITH_EVIDENCE` gerekçesi kaydedin\.

## Desteklenen sürümler

| Sürüm | Destek |
| --- | --- |
| Yayımlanan en son sürüm ve değiştirilemez Codex derlemesi | Desteklenir |
| Eski değiştirilemez önbellek sürümleri | Geri dönüş hedefleridir\; açıkça duyurulmadıkça düzeltmeler eski sürümlere taşınmaz |
| Yayımlanmamış çatallar veya değiştirilmiş önbellek içerikleri | Desteklenmez |

## Güvenlik açığı bildirme

Lütfen [GitHub özel güvenlik açığı bildirimini](https://github.com/stephen-taipei/better-workflows/security/advisories/new) kullanın\. Şüpheli bir güvenlik açığı için herkese açık bir sorun kaydı oluşturmayın\.

Şunları ekleyin\:

- etkilenen sürüm ve eklenti derlemesi\;
- ortam ve Node\.js sürümü\;
- sorunu yeniden üretmek için gereken en az adımlar\;
- beklenen ve gözlemlenen güvenlik sınırı\;
- etki ve bilinen geçici çözümler\;
- bildirimin gizli materyal içerip içermediği\.

Geçerli kimlik bilgilerini\, imzalama anahtarlarını\, sağlayıcı belirteçlerini\, işlenmemiş özel istemleri veya üçüncü taraflara ait kişisel verileri eklemeyin\.

## Yanıt

Bakım sorumlusu\, işleme alınabilir bir bildirimin alındığını teyit eder\, kapsamını doğrular ve sorunun giderilmesi ile açıklanmasını koordine eder\. Sabit yanıt süreli bir SLA taahhüt edilmez\. Sonuçlar bilinmiyorsa veya karşılaştırılarak mutabakat sağlanmamışsa doğrulanmamış işlemleri reddetme durumu korunur\.

## Güvenlik sınırları

Better Workflows\, yerel deponun\, ana makinenin ve çalıştırılabilir araç zincirinin güvenilir olduğunu varsayar\. Node\'un İzin Modeli katmanlı bir savunma önlemidir\; kötü amaçlı kod için bir işletim sistemi korumalı alanı değildir\. Eksiksiz [güvenlik kılavuzuna](security-guide.md) bakın\.
