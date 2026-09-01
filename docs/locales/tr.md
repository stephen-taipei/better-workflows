<div align="center">

# Better Workflows

AI agent doğrulama gücünü riske göre seçer ve işi yalıtılmış bir ortamda güvenle tamamlar. Basit değişiklikler hızlı ilerler; önemli işler evidence gates kullanır; Git değişiklikleri varsayılan olarak özel bir worktree kullanır.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · **Türkçe** · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Belgeleri inceleyin](https://betterworkflows.dev/tr/docs/) · [GitHub’ı açın](https://github.com/stephen-taipei/better-workflows) · [Ko-fi üzerinden destekle](https://ko-fi.com/betterworkflows)

</div>

## Agent işini<br>kanıtlanabilir bir sona taşıyın.

Better Workflows hedefi, kapsamı ve yetkiyi sabitler; her kararı güncel ve yeniden doğrulanabilir kanıta ve uzlaştırılmış dış sonuca bağlar.

## Niyetten tamamlanmaya dört açık sınır.

Sözleşmeyi tanımlayın, kaynağı ve kanıtı doğrulayın, dış etkileri uzlaştırın ve yalnızca son durum bilindiğinde tamamlandı deyin.

- **01 · `TaskContract`** — Better Workflows hedefi, kapsamı ve yetkiyi sabitler; her kararı güncel ve yeniden doğrulanabilir kanıta ve uzlaştırılmış dış sonuca bağlar.
- **02 · `evidence`** — AI agent doğrulama gücünü riske göre seçer ve işi yalıtılmış bir ortamda güvenle tamamlar. Basit değişiklikler hızlı ilerler; önemli işler evidence gates kullanır; Git değişiklikleri varsayılan olarak özel bir worktree kullanır.
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
- [Evidence Cinema](https://betterworkflows.dev/tr/docs/evidence-cinema/)


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
- [GitHub’ı açın](https://github.com/stephen-taipei/better-workflows)

## Better Workflows’un bakımına yardımcı olun.

Tek seferlik destek; açık kaynak bakımı, belgeler, 41 yerelleştirilmiş sürüm ve site barındırmasına katkı sağlar. Üyelik hakkı veya yol haritasında ya da destekte öncelik sağlamaz.

[Ko-fi üzerinden destekle](https://ko-fi.com/betterworkflows)

---

Bir komutun çalışması tamamlanmayı kanıtlamaz; yeniden doğrulanabilir sonuç kanıtlar.
