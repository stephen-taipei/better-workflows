<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# Başlarken

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · **Türkçe** · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1\; macOS × Node 22\/24 üzerinde Codex\, Gemini CLI ve Qwen Code\'u kapsar\. Claude Code\, Linux ve Windows yeterliliği V5\.1\'e ertelenmiştir\. GA için en az 30 doğal canary günü\, art arda 20 uygun başlatma ve üç ayrı depo gerekir\.

| [Genel bakış](../../../README.md) | [Ayrıntılar](../../../docs/details/en.md) | **Hızlı başlangıç** | [İş akışları](workflows.md) | [Mimari](architecture.md) | [Güvenlik](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[41 yerelleştirilmiş sürümde genel bakış ve resmî web giriş noktaları](../../../docs/LANGUAGES.md)\. Komutlar ve tanımlayıcılar standart İngilizce biçimleriyle korunur\.

V5\.0 RC1 \(`5.0.0-rc.1`\, `V5.0.rc1` etiketi\) genel kullanıma sunuldu\. Yayın kapsamı\; macOS Node 22\/24 üzerinde Codex\, Gemini CLI ve Qwen Code ile yalnızca Auto\'yu kapsar\. Linux ve Windows yeterliliği\, Claude Code yeterliliği gibi V5\.1\'e ertelenmiştir\. GA `5.0.0`\, en az 30 doğal canary günü\, art arda 20 uygun başlatma ve üç ayrı depo kaydedilene kadar beklemede kalır\.

## Gereksinimler

- Birlikte gelen `sbw` yardımcısı için Node\.js 22\.14 veya daha yenisi\.
- Güvenilir bir yerel depo\. Better Workflows\, kötü amaçlı depo kodunu sandbox\'a aldığını iddia etmez\.

v4 durum kök dizini\, belirli bir yapay zekâ ajan platformundan bağımsızdır\: ayarlandıysa `SBW_STATE_ROOT` önceliklidir\; ardından `XDG_STATE_HOME/better-workflows`\, aksi halde `~/.better-workflows` kullanılır\. Varsayılan konum artık `CODEX_HOME` altında değildir\. Mevcut v3 Codex durumunu taşımadan kullanmaya devam etmek için `SBW_STATE_ROOT` değerini açıkça tam olarak o `<CODEX_HOME>/sbw` dizinine ayarlayın\, ardından `sbw` aracını çağırın\.

V5\.0 GA \(`5.0.0`\) beklemede kalmaya devam ediyor\. Aşağıdaki kurulum komutları\, genel kullanıma sunulan V5\.0 RC1\'i \(`5.0.0-rc.1`\, `V5.0.rc1` etiketi\) hedefler\.

## Kurulum

### Codex — önerilen referans ortam

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

Kurulumdan sonra yeni bir Codex görevi açarak görevin beceri kataloğunu yenileyin\.

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI uzantıyı kopyalar\. Kurulumdan sonra oturumu yeniden başlatın\; daha sonra yenilemek için `gemini extensions update better-workflows` kullanın\.

Uzantı bağlamı köprüyü kendi yüklendiği kaynak yolundan çözümler\; proje çalışma dizininizi temel almaz\. Standart kullanıcı kapsamlı kurulumda eşdeğer elle denetim şöyledir\:

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

Bağlantılı veya çalışma alanı kapsamlı bir uzantıda\, ajan platformunun gösterdiği tam uzantı kökünü kullanın\. Benzer ad taşıyan bir çalışma kopyasıyla değiştirmeyin\.

### Qwen Code

Uzantının yerel kopyasını kurmadan önce sürümü sabitleyin\:

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code da uzantıyı kopyalar\; bu nedenle kurulumdan sonra oturumu yeniden başlatın ve sonraki güncellemeler için `qwen extensions update better-workflows` kullanın\.

Standart kullanıcı kapsamlı kurulumda eşdeğer elle köprü denetimi şöyledir\:

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

Tam kökü kullanma kuralı\, bağlantılı veya çalışma alanı kapsamlı kurulumlar için de geçerlidir\.

## Auto\'yu Kullanın

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

Her giriş noktası istenen Goal\'u korur\. İlgisiz bir etkin Goal açıkça düzenlenmeli veya temizlenmelidir\; asla sessizce değiştirilmez\.

## Yolu önizleyin

Yetenek anlık görüntüsü salt okunurdur\; sağlayıcı oturum açma işlemini veya anlamsal model yoklamasını tetiklemez\:

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

İncelenebilir bir iş devri için gizli ve tek kullanımlık bir doğrulanabilir kaydı kaydedip kullanın\:

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

Kayıtların süresi 24 saat sonra dolar\; yeniden kullanım veya çalışma alanı\, kapsam\, Profiles\, katalog\, yetenekler ya da eklenti paketindeki sapma durumunda işlem reddedilir\. Belirsizlik halinde devam etmeye izin verilmez\.

## Kurulumu doğrulayın

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## Depoda değişiklik yapmadan önce

Auto\, salt okunur bir çalışma alanı ön denetimiyle başlar\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Git dışı ve salt okunur görevler çalışma ağacı oluşturmaz\. Değişiklik yapan bir Git görevi\, göreve ait bir `TaskWorkspaceLeaseV1` oluşturmalı veya yeniden kullanmalıdır\. Kaynak çalışma dizininde commit edilmemiş değişiklikler varsa herhangi bir stash\, kopyalama\, commit veya çalışma ağacı oluşturma işleminden önce durulur\. HEAD bir dala bağlı değilse veya hedef eksikse açık bir entegrasyon hedefi gerekir\. Korunan veya uzak hedefler\, yönetişim kurallarına tabi PR teslim sürecine aktarılır\.

Codex veya başka bir ajan platformu mevcut görev için temiz çalışma ağacını zaten oluşturduysa\, iç içe bir çalışma ağacı oluşturmak yerine düzenlemeden önce mevcut ağacı kaydedin\:

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

Kayıt için değişmemiş başlangıç noktasında ayrı bir `codex/*` görev dalı\, aynı Git ortak dizini ve temiz bir kaynak çalışma kopyası gerekir\. Better Workflows çalışma ağacını kullanır\, ancak temizlik sırasında platforma ait dalı ve yolu korur\. Korunan bir hedef için önce kanıt iş akışını çalıştırın\, ardından tam olarak o iş akışının PR birleştirme ve uzak eşitleme işlemlerine ait doğrulanabilir kayıtlarını `workspace reconcile --run-id <run-id>` ile bağlayın\.

Sırada\: [doğru iş akışını seçin](workflows.md) veya [CLI başvurusuna](cli-reference.md) göz atın\.
