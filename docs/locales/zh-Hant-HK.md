<div align="center">

# Better Workflows

等 AI agent 按風險選擇驗證強度，喺隔離環境安全完成工作。 簡單修改快速完成；重要工作使用證據 gate；Git 修改預設使用專屬 worktree。

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · **繁體中文（香港）** · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[查看官方文件](https://betterworkflows.dev/zh-Hant-HK/docs/) · [開啟 GitHub](https://github.com/stephen-taipei/better-workflows) · [透過 Ko-fi 一次性贊助](https://ko-fi.com/betterworkflows)

</div>

## 讓 agent 工作<br>完成，並留下可以再次驗證的結果。

Better Workflows 會固定 goal、scope 及 authority，將每個判斷綁定到目前仍然有效、可以再次驗證的證據，以及已核對的外部結果。

## 由意圖到完成，清楚劃分四道邊界。

先定義 contract，再驗證 source 及 evidence、核對外部操作結果；只有在 terminal state 已知時，才宣告完成。

- **01 · `TaskContract`** — Better Workflows 會固定 goal、scope 及 authority，將每個判斷綁定到目前仍然有效、可以再次驗證的證據，以及已核對的外部結果。
- **02 · `evidence`** — 等 AI agent 按風險選擇驗證強度，喺隔離環境安全完成工作。 簡單修改快速完成；重要工作使用證據 gate；Git 修改預設使用專屬 worktree。
- **03 · `reconciliation`** — 先定義 contract，再驗證 source 及 evidence、核對外部操作結果；只有在 terminal state 已知時，才宣告完成。
- **04 · `terminal state`** — 指令成功執行不代表工作已經完成；可以再次驗證的結果才是證明。

## 快速開始

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## 由架構地圖繼續深入實際使用情境。

- [由意圖到完成，清楚劃分四道邊界。](https://betterworkflows.dev/zh-Hant-HK/docs/)
- [快速開始](https://betterworkflows.dev/zh-Hant-HK/docs/quick/)
- [由架構地圖繼續深入實際使用情境。](https://betterworkflows.dev/zh-Hant-HK/docs/use-cases/)
- [快速開始 — 由架構地圖繼續深入實際使用情境。](https://betterworkflows.dev/zh-Hant-HK/docs/use-cases/quick/)
- [Evidence Cinema](https://betterworkflows.dev/zh-Hant-HK/docs/evidence-cinema/)


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
- [開啟 GitHub](https://github.com/stephen-taipei/better-workflows)

## 協助持續維護 Better Workflows。

一次性贊助會用於開源維護、文件、41 個本地化版本及網站託管；不包括會員資格，亦不會提供開發規劃或技術支援優先權。

[透過 Ko-fi 一次性贊助](https://ko-fi.com/betterworkflows)

---

指令成功執行不代表工作已經完成；可以再次驗證的結果才是證明。
