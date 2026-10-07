<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 genel kullanıma sunuldu: güncel kanıtlar, inceleme kapıları ve sağlayıcı mutabakatı içeren, AI mühendisliği QA ve teslimatına yönelik ücretsiz, açık kaynaklı bir Auto iş akışı.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · **Türkçe** · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Belgeleri inceleyin](https://betterworkflows.dev/tr/docs/) · [GitHub’ı açın](https://github.com/stephen-taipei/better-workflows) · [USDT (TRC20) ile destekle](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1; macOS × Node 22/24 üzerinde Codex, Gemini CLI ve Qwen Code'u kapsar. Claude Code, Linux ve Windows yeterliliği V5.1'e ertelenmiştir. GA için en az 30 doğal canary günü, art arda 20 uygun başlatma ve üç ayrı depo gerekir.

## Agent işini<br>kanıtlanabilir bir sona taşıyın.

V5.0 RC1 genel kullanıma sunuldu. Auto; hedefi, kapsamı, depoyu ve riski denetler, ardından hedeflenen denetimleri veya bir kanıt iş akışını seçer. Git değişiklikleri göreve ait bir worktree kullanır; teslimat için yetkilendirme ve doğrulanmış harici bir sonuç gerekir.

## Niyetten tamamlanmaya dört açık sınır.

Sözleşmeyi tanımlayın, kaynağı ve kanıtı doğrulayın, dış etkileri uzlaştırın ve yalnızca son durum bilindiğinde tamamlandı deyin.

- **01 · `TaskContract`** — V5.0 RC1 genel kullanıma sunuldu. Auto; hedefi, kapsamı, depoyu ve riski denetler, ardından hedeflenen denetimleri veya bir kanıt iş akışını seçer. Git değişiklikleri göreve ait bir worktree kullanır; teslimat için yetkilendirme ve doğrulanmış harici bir sonuç gerekir.
- **02 · `evidence`** — Better Workflows V5.0 RC1 genel kullanıma sunuldu: güncel kanıtlar, inceleme kapıları ve sağlayıcı mutabakatı içeren, AI mühendisliği QA ve teslimatına yönelik ücretsiz, açık kaynaklı bir Auto iş akışı.
- **03 · `reconciliation`** — Sözleşmeyi tanımlayın, kaynağı ve kanıtı doğrulayın, dış etkileri uzlaştırın ve yalnızca son durum bilindiğinde tamamlandı deyin.
- **04 · `terminal state`** — Bir komutun çalışması tamamlanmayı kanıtlamaz; yeniden doğrulanabilir sonuç kanıtlar.

## Hızlı başlangıç

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## Mimari haritadan pratik kullanım senaryolarına geçin.

- [Niyetten tamamlanmaya dört açık sınır.](https://betterworkflows.dev/tr/docs/)
- [Hızlı başlangıç](https://betterworkflows.dev/tr/docs/quick/)
- [Mimari haritadan pratik kullanım senaryolarına geçin.](https://betterworkflows.dev/tr/docs/use-cases/)
- [Hızlı başlangıç — Mimari haritadan pratik kullanım senaryolarına geçin.](https://betterworkflows.dev/tr/docs/use-cases/quick/)
- [Kanıt Sineması](https://betterworkflows.dev/tr/docs/evidence-cinema/)

### Belgeleri inceleyin · `tr`

Bu başvuru sayfasının özeti yerelleştirilmiştir; etkileşimli içeriğin çevirisi henüz tamamlanmamıştır.

- **01 · Niyetten tamamlanmaya dört açık sınır.** — Sözleşmeyi tanımlayın, kaynağı ve kanıtı doğrulayın, dış etkileri uzlaştırın ve yalnızca son durum bilindiğinde tamamlandı deyin.
- **02 · Mimari haritadan pratik kullanım senaryolarına geçin.** — V5.0 RC1 genel kullanıma sunuldu. Auto; hedefi, kapsamı, depoyu ve riski denetler, ardından hedeflenen denetimleri veya bir kanıt iş akışını seçer. Git değişiklikleri göreve ait bir worktree kullanır; teslimat için yetkilendirme ve doğrulanmış harici bir sonuç gerekir.
- **03 · Hızlı başlangıç** — Better Workflows V5.0 RC1 genel kullanıma sunuldu: güncel kanıtlar, inceleme kapıları ve sağlayıcı mutabakatı içeren, AI mühendisliği QA ve teslimatına yönelik ücretsiz, açık kaynaklı bir Auto iş akışı.

- [`Niyetten tamamlanmaya dört açık sınır.`](https://betterworkflows.dev/docs/reference/tr/index.html) · `tr`
- [`Hızlı başlangıç`](https://betterworkflows.dev/docs/reference/tr/preview.html) · `tr`
- [`Mimari haritadan pratik kullanım senaryolarına geçin.`](https://betterworkflows.dev/docs/reference/tr/use-cases/index.html) · `tr`
- [`Hızlı başlangıç — Mimari haritadan pratik kullanım senaryolarına geçin.`](https://betterworkflows.dev/docs/reference/tr/use-cases/preview.html) · `tr`
- [`Kanıt Sineması`](https://betterworkflows.dev/docs/reference/tr/evidence-cinema/index.html) · `tr`

- [Belgeleri inceleyin · `tr`](../details/tr.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### Belgeleri inceleyin · `en`



### Belgeleri inceleyin · `tr`

- [Güvenlik politikası](tr/security.md) · `tr`
- [Katkıda bulunma](tr/contributing.md) · `tr`
- [Yönetişim](tr/governance.md) · `tr`
- [Davranış kuralları](tr/conduct.md) · `tr`
- [Üçüncü taraf bildirimleri](tr/notices.md) · `tr`
- [README kalite taslağı](tr/readme-quality.md) · `tr`
- [Editoryal renk sistemi](tr/color-system.md) · `tr`
- [Mimari](tr/architecture.md) · `tr`
- [Güvenlik](tr/security-guide.md) · `tr`
- [CLI başvurusu](tr/cli-reference.md) · `tr`
- [Başlarken](tr/getting-started.md) · `tr`
- [İş Akışları](tr/workflows.md) · `tr`
- [Destek](tr/support.md) · `tr`

## Better Workflows’un bakımına yardımcı olun.

Tek seferlik destek; açık kaynak bakımı, belgeler, 41 dilde yerelleştirme ve site barındırmasına katkı sağlar. Üyelik ya da roadmap ve destek önceliği satın almaz.

[USDT (TRC20) ile destekle](https://betterworkflows.dev/#sponsor)

---

Bir komutun çalışması tamamlanmayı kanıtlamaz; yeniden doğrulanabilir sonuç kanıtlar.
