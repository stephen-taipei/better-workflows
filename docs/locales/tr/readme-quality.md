<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# README kalite taslağı

[English](../en/readme-quality.md) · [繁體中文](../zh-Hant/readme-quality.md) · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · **Türkçe** · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[41 yerelleştirilmiş sürümde genel bakış ve resmî web giriş noktaları](../../../docs/LANGUAGES.md)\. Bu editoryal taslakta esas alınan metin İngilizce sürüm olmaya devam eder\.

Bir Better Workflows README dosyası bir açılış sayfasıdır\; sıkıştırılmış bir başvuru kılavuzu değildir\. Görevi\, okuyucunun şu beş soruyu sırayla yanıtlamasına yardımcı olmaktır\:

1. Bu nedir ve bana uygun mu\?
2. Hangi sorunu çözer\?
3. İddialarına neden güvenmeliyim\?
4. İlk başarıya giden en kısa yol nedir\?
5. Bundan sonra nereye gitmeliyim\?

Bu taslak\, depodaki her README için anlatı\, görsel\, yerelleştirme ve doğrulama sözleşmesini tanımlar\. Makine tarafından okunabilir kaynak [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json) dosyasıdır\.

## Okuyucunun kararından başlayın

GitHub\, README dosyasını depo içeriğinin çoğundan önce gösterir\. Bu nedenle ilk ekran ürünün vaadini\, hedef kitlesini ve sınırları belli bir sonraki eylemi ortaya koymalıdır\. İç mimariyle\, eksiksiz bir komut başvurusuyla veya sürüm kurtarma ayrıntılarıyla başlamamalıdır\.

Şu okuyucu görevlerini gözeterek yazın\:

- **Yeni ziyaretçi\:** Better Workflows\'un ilgili bir sorunu çözüp çözmediğine hızlıca karar verin\.
- **Yeni kullanıcı\:** eklentiyi yükleyin ve başarılı bir otomatik rotaya ulaşın\.
- **Değerlendirici\:** yetki sınırını ve fail\-closed davranışını anlayın\.
- **Geri dönen operatör\:** bir iş akışına\, güvenliğe\, mimariye veya CLI yanıtına atlayın\.
- **Katkıda bulunan veya çevirmen\:** kanonik sözleşmeyi\, geliştirme komutlarını\, desteği ve yönetişimi bulun\.

## Neden\-sonuç anlatısı kullanın

Beş açılış README dosyası\, aynı sekiz parçalı anlamsal sırayı kullanır\. Başlıklar her dilde doğal biçimde ifade edilebilir\, ancak okuyucunun izlediği yol değişmez\.

| Bölüm | Okuyucunun sorusu ve anlatıdaki rolü |
| --- | --- |
| Vaat ve hedef kitle | Better Workflows nedir\, neden vardır ve kimler içindir\? |
| Sorundan sonuca | Niyet\, yetki\, kanıt ve sağlayıcı sonucu birbirine karıştırıldığında ne ters gider\? |
| İspat ve sınırlar | Önerilen sonucu hangi güvenceler inandırıcı kılar\? |
| İlk başarı | Kurulumdan sonuca uzanan en kısa eksiksiz yol nedir\? |
| Sonraki yolu seçme | Hangi iş akışı veya belge okuyucunun hedefiyle örtüşür\? |
| Yaşam döngüsü | Bir hedef nasıl mutabakatı sağlanmış bir tamamlanmaya dönüşür veya güvenli biçimde durur\? |
| Güven ve sınırlar | Sistem neleri hiçbir zaman çıkaramaz\, yetkilendiremez veya iddia edemez\? |
| Öğrenme\, yardım alma\, katkıda bulunma | Ayrıntılı belgeler\, destek\, yönetişim\, geliştirme ve lisans nerede bulunur\? |

Bu sıra\, pratik bir anlatı akışı sağlar\:

- **Bağlam\:** istemlerle yönlendirilen çalışma\, yetkiyi veya durumu kanıtlamadan niyeti ifade edebilir\.
- **Gerilim\:** yan etkiler bu boşluğu teslimat riskine dönüştürür\.
- **Çözüm\:** Better Workflows hedefi\, kapsamı\, kanıtı\, incelemeyi\, eylemi ve sağlayıcıyla mutabakatı birbirine bağlar\.
- **İspat\:** açık güvenceler ve sınırlar\, çözümün nasıl işlediğini gösterir\.
- **Eylem\:** okuyucu\, derin uygulama ayrıntılarıyla karşılaşmadan önce ilk başarısına ulaşır\.
- **Devam\:** role ve sonuca dayalı yollar\, okuyucuyu doğru öğreticiye\, uygulama kılavuzuna\, açıklamaya veya başvuru kaynağına yönlendirir\.

## Açılış içeriğini ayrıntılı belgelerden ayırın

README dosyasını karar için gerekli bilgilere ayırın\. Ayrıntılara amaca göre yönlendirin\:

- [Başlangıç](getting-started.md)\, ilk kullanıma yönelik öğreticidir\.
- [İş akışları](workflows.md)\, sonuç seçimine yönelik uygulama kılavuzudur\.
- [Mimari](architecture.md)\, kontrol düzlemini ve ödünleşimleri açıklar\.
- [Güvenlik](security-guide.md)\, yetkiyi\, mahremiyeti\, doğrulama beyanlarını ve doğrulama yokken yürütmeyi reddeden davranışı açıklar\.
- [CLI başvurusu](cli-reference.md)\, komut başvuru kaynağıdır\.
- Yerelleştirilmiş `docs/details/*.md` sayfaları\, çevrilmiş ayrıntıları kapsamlı biçimde korur\.

Önbellek kurtarmayı\, kilit sahipliğini\, sağlayıcı aktarımının tüm anlambilimini\, eksiksiz komut listesini veya uygulama değişiklik geçmişini açılış sayfasında yinelemeyin\. Kısa bir güvenlik iddiası bu sayfada kalır\; denetlenebilir ayrıntıları ise esas alınan kılavuzda yer alır\.

Bu ayrım\, Diátaxis\'in öğreticiler\, uygulama kılavuzları\, açıklamalar ve başvuru kaynakları arasında yaptığı ayrıma dayanır\. Tek bir sayfa\, bu dört okuyucu ihtiyacının tümü için aynı anda en uygun biçimde düzenlenemez\.

## Her görselin yerini hak etmesini sağlayın

Bir görseli yalnızca ilişkileri\, hiyerarşiyi veya durum geçişlerini düz yazıya göre belirgin biçimde daha anlaşılır kıldığında kullanın\.

Açılış sayfalarında iki görsele izin verilir\:

1. **Yetki sınırı mimarisi\:** niyeti\, güncel olguları\, araç yetkisini\, sınırlı yeniden denemeleri ve salt okunur durumu hangi katmanların şekillendirdiğini yanıtlar\.
2. **Hedeften tamamlanmaya yaşam döngüsü\:** kanıtın nerede kontrol edildiğini\, yan etkilerin nerede yetkilendirildiğini ve bilinmeyen durumun ilerlemeyi nerede durdurduğunu yanıtlar\.

Her görsel şunları içermelidir\:

- kısa ve anlamlı alternatif metin\;
- görsel gizlendiğinde veya Mermaid görüntülenmediğinde sonucu koruyan\, hemen yanında yer alan eşdeğer bir metin\;
- mümkün olduğunda temel etiketler için gerçek metin\;
- görseli güncel tutmayı gerekçelendiren\, sürekliliğini koruyan bir okuyucu sorusu\.

Dekoratif ekran görüntüleri\, yoğun metin içeren görseller veya yalnızca kısa bir listeyi yineleyen diyagramlar eklemeyin\. Seçim tablolarını iki kısa sütunla sınırlayın\; böylece dar ekranlarda da kullanılabilir kalırlar\.

## Diller arasında anlamı koruyun

İngilizce\, anlamsal başvuru kaynağıdır\; hedeflenen satır sayısı değildir\. Geleneksel Çince\, Basitleştirilmiş Çince\, Japonca ve Korece\, aynı sözleşmeyi korurken ana dili o dil olan okuyucuya doğal gelmelidir\.

Şu öğeler eşdeğer kalmalıdır\:

- sekiz anlamsal bölüm ve bunların sırası\;
- ilk başarı komutları ve ürün tanımlayıcıları\;
- yetki\, kanıt\, bilinmeyen durum\, istem ve mahremiyet hakkındaki beş iddia\;
- iş akışı\, güvenlik\, mimari\, CLI\, destek\, yönetişim\, geliştirme ve lisans hedefleri\;
- görselin amacı\, yaşam döngüsü aşamaları ve yedek metinler\;
- sürüm kaynağı ve rozet politikası\.

Başlıklar\, cümle sınırları\, noktalama\, örnekler ve eylem çağrıları dile özgü doğal biçimde yazılabilir\. Komutları\, seçicileri\, kanıt tanımlayıcılarını veya güvenlik anlambilimini asla çevirmeyin\.

## Hızlı gözden geçirmeyi ve çeviriyi gözeterek yazın

- Okuyucunun elde edeceği sonuçla başlayın ve önemli terimleri başlıkların ve paragrafların başına yerleştirin\.
- Etken çatı kullanın ve eylemden sorumlu kişiyi veya bileşeni belirtin\.
- İşlemleri anlatırken okuyucuya doğrudan hitap edin\.
- Paragrafları kısa tutun ve her birine tek bir görev verin\.
- Sıralı işlemler için numaralı listeler\, sırasız seçenekler için madde işaretleri kullanın\.
- Genel “buraya tıklayın” etiketleri yerine açıklayıcı bağlantılar kullanın\.
- Başlıkları hiyerarşik\, belirgin ve aynı düzeyde paralel yapıda tutun\.
- Çeviride anlamını koruyan\, doğrudan ve belirsizlik içermeyen dili tercih edin\.
- Koşulları talimatlardan önce\, beklenen sonuçları komutlardan sonra verin\.

## Süslemeyi değil\, anlambilimi doğrulayın

Belge testleri yalnızca başlık eşleşmesini denetlemekle yetinmemelidir\. Şunları doğrularlar\:

- tek bir H1 ve mantıksal başlık hiyerarşisi\;
- sıralı anlamsal bölüm ve kritik iddia işaretçileri\;
- ilk başarı için kesin komutlar ve kararlı tanımlayıcılar\;
- göreli bağlantılar ve yerel ayarlara özgü ayrıntı hedefleri\;
- runtime meta verileriyle sürüm rozeti denkliği\;
- anlamlı görsel alt metni ve bitişik görsel alternatifler\;
- eksiksiz bir metin eşdeğerine sahip tek bir Mermaid yaşam döngüsü\;
- iki sütunlu tablo ve paragraf uzunluğu sınırları\;
- açılış sayfalarında belirlenmiş derin uygulama ayrıntılarının bulunmaması\;

## Araştırma temeli

- [GitHub\: Depo README dosyası hakkında](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) README dosyasının ilk ziyaretteki amacını tanımlar ve uzun belgelerin başka bir yere taşınmasını önerir\.
- [Diátaxis](https://diataxis.fr/start-here/)\; öğretici\, uygulama kılavuzu\, açıklama ve başvuru ihtiyaçlarını ayırır\.
- [Microsoft\: Hızla gözden geçirilebilir içerik](https://learn.microsoft.com/en-us/style-guide/scannable-content/) önemli bilgileri öne alan yapıyı\, kısa paragrafları ve tutarlı görsel giriş noktalarını vurgular\.
- [Google geliştirici belgeleri yazım biçimi](https://developers.google.com/style/highlights) etken çatıyı\, doğrudan hitabı\, açıklayıcı başlıkları\, erişilebilirliği ve küresel okuyucu kitlesine yönelik yazımı önerir\.
- [GitHub\: Diyagram oluşturma](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams) Markdown içindeki Mermaid desteğini belgeler\.
- [W3C WAI\: Görseller öğreticisi](https://www.w3.org/WAI/tutorials/images/)\, bilgi taşıyan ve karmaşık görseller için metin alternatifleri ve eksiksiz eşdeğerler gerektirir\.
