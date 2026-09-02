<div align="center">

# Better Workflows

Inaangkop ng AI agent ang lakas ng beripikasyon sa panganib at ligtas na tinatapos ang trabaho sa hiwalay na environment. Mabilis ang simpleng pagbabago; gumagamit ng evidence gates ang mahalagang trabaho; may sariling worktree ang Git changes bilang default.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · **Filipino** · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Tingnan ang dokumentasyon](https://betterworkflows.dev/fil/docs/) · [Buksan ang GitHub](https://github.com/stephen-taipei/better-workflows) · [Sumuporta sa Ko-fi](https://ko-fi.com/betterworkflows)

</div>

## Dalhin ang trabaho ng agent<br>sa napapatunayang pagtatapos.

Itinatakda ng Better Workflows ang layunin, saklaw, at awtoridad, at itinatali ang bawat desisyon sa napapanahon at muling mapapatunayang ebidensya at naipagtugmang panlabas na resulta.

## Apat na malinaw na hangganan mula intensyon hanggang pagkumpleto.

Itakda ang kasunduan, beripikahin ang pinagmulan at ebidensya, itugma ang mga panlabas na epekto, at ideklarang kumpleto lamang kapag tiyak na ang panghuling kalagayan.

- **01 · `TaskContract`** — Itinatakda ng Better Workflows ang layunin, saklaw, at awtoridad, at itinatali ang bawat desisyon sa napapanahon at muling mapapatunayang ebidensya at naipagtugmang panlabas na resulta.
- **02 · `evidence`** — Inaangkop ng AI agent ang lakas ng beripikasyon sa panganib at ligtas na tinatapos ang trabaho sa hiwalay na environment. Mabilis ang simpleng pagbabago; gumagamit ng evidence gates ang mahalagang trabaho; may sariling worktree ang Git changes bilang default.
- **03 · `reconciliation`** — Itakda ang kasunduan, beripikahin ang pinagmulan at ebidensya, itugma ang mga panlabas na epekto, at ideklarang kumpleto lamang kapag tiyak na ang panghuling kalagayan.
- **04 · `terminal state`** — Ang pagpapatakbo ng utos ay hindi patunay ng pagkumpleto; ang muling mapapatunayang resulta ang patunay.

## Mabilisang simula

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## Mula sa mapa ng arkitektura tungo sa mga praktikal na kaso ng paggamit.

- [Apat na malinaw na hangganan mula intensyon hanggang pagkumpleto.](https://betterworkflows.dev/fil/docs/)
- [Mabilisang simula](https://betterworkflows.dev/fil/docs/quick/)
- [Mula sa mapa ng arkitektura tungo sa mga praktikal na kaso ng paggamit.](https://betterworkflows.dev/fil/docs/use-cases/)
- [Mabilisang simula — Mula sa mapa ng arkitektura tungo sa mga praktikal na kaso ng paggamit.](https://betterworkflows.dev/fil/docs/use-cases/quick/)
- [Evidence Cinema](https://betterworkflows.dev/fil/docs/evidence-cinema/)


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
- [Buksan ang GitHub](https://github.com/stephen-taipei/better-workflows)

## Tulungang mapanatili ang Better Workflows.

Ang minsanang suporta ay tumutulong sa pagpapanatili ng bukas na source code, dokumentasyon, 41 bersyong naisalokal, at pagho-host ng website. Hindi ito nagbibigay ng pagiging miyembro o priyoridad sa plano ng pagpapaunlad o suporta.

[Sumuporta sa Ko-fi](https://ko-fi.com/betterworkflows)

---

Ang pagpapatakbo ng utos ay hindi patunay ng pagkumpleto; ang muling mapapatunayang resulta ang patunay.
