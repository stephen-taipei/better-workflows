<div align="center">

# Better Workflows

AI-agentti sovittaa varmennuksen riskin mukaan ja viimeistelee työn turvallisesti eristetyssä ympäristössä. Yksinkertaiset muutokset etenevät nopeasti; tärkeä työ käyttää evidence gate -tarkistuksia; Git-muutokset tehdään oletuksena omassa worktreessä.

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · **Suomi** · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[Tutustu dokumentaatioon](https://betterworkflows.dev/fi/docs/) · [Avaa GitHub](https://github.com/stephen-taipei/better-workflows) · [Tue Ko-fi-palvelussa](https://ko-fi.com/betterworkflows)

</div>

## Vie agenttien työ<br>todennettavaan päätökseen.

Better Workflows lukitsee tavoitteen, laajuuden ja valtuudet sekä sitoo jokaisen päätöksen ajantasaiseen, uudelleen varmennettavaan näyttöön ja täsmäytettyyn ulkoiseen tulokseen.

## Neljä selkeää rajaa aikomuksesta valmistumiseen.

Määritä sopimus, varmista lähde ja näyttö, täsmäytä ulkoiset vaikutukset ja ilmoita valmiiksi vasta, kun lopputila tunnetaan.

- **01 · `TaskContract`** — Better Workflows lukitsee tavoitteen, laajuuden ja valtuudet sekä sitoo jokaisen päätöksen ajantasaiseen, uudelleen varmennettavaan näyttöön ja täsmäytettyyn ulkoiseen tulokseen.
- **02 · `evidence`** — AI-agentti sovittaa varmennuksen riskin mukaan ja viimeistelee työn turvallisesti eristetyssä ympäristössä. Yksinkertaiset muutokset etenevät nopeasti; tärkeä työ käyttää evidence gate -tarkistuksia; Git-muutokset tehdään oletuksena omassa worktreessä.
- **03 · `reconciliation`** — Määritä sopimus, varmista lähde ja näyttö, täsmäytä ulkoiset vaikutukset ja ilmoita valmiiksi vasta, kun lopputila tunnetaan.
- **04 · `terminal state`** — Komennon suorittaminen ei todista valmistumista; uudelleen varmennettava tulos todistaa.

## Pika-aloitus

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## Siirry arkkitehtuurikartasta käytännön käyttötapauksiin.

- [Neljä selkeää rajaa aikomuksesta valmistumiseen.](https://betterworkflows.dev/fi/docs/)
- [Pika-aloitus](https://betterworkflows.dev/fi/docs/quick/)
- [Siirry arkkitehtuurikartasta käytännön käyttötapauksiin.](https://betterworkflows.dev/fi/docs/use-cases/)
- [Pika-aloitus — Siirry arkkitehtuurikartasta käytännön käyttötapauksiin.](https://betterworkflows.dev/fi/docs/use-cases/quick/)
- [Evidence Cinema](https://betterworkflows.dev/fi/docs/evidence-cinema/)


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
- [Avaa GitHub](https://github.com/stephen-taipei/better-workflows)

## Auta Better Workflowsin ylläpidossa.

Kertaluonteinen tuki auttaa avoimen lähdekoodin, dokumentaation, 41 lokalisoidun version ja verkkosivun ylläpidossa. Se ei anna jäsenyyttä eikä etusijaa kehityksessä tai tuessa.

[Tue Ko-fi-palvelussa](https://ko-fi.com/betterworkflows)

---

Komennon suorittaminen ei todista valmistumista; uudelleen varmennettava tulos todistaa.
