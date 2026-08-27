<div align="center">

# Better Workflows

開源、goal-first 的 agent 工作流程控制面，以目前仍有效的證據、審查關卡、來源綁定與 provider 狀態核對，確保結果可重新驗證。

[English](en.md) · **繁體中文** · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[查看官方文件](https://betterworkflows.dev/zh-Hant/docs/) · [開啟 GitHub](https://github.com/stephen-taipei/better-workflows) · [透過 Ko-fi 單次贊助](https://ko-fi.com/betterworkflows)

</div>

## 讓 agent 工作<br>完成，並留下可驗證的結果。

Better Workflows 固定 goal、scope 與 authority，把每個判斷綁定到目前仍有效且可重新驗證的證據，以及已核對的外部結果。

## 從意圖到完成，明確劃分四道邊界。

先定義 contract，再驗證 source 與 evidence、核對外部操作結果；只有 terminal state 已知時，才宣告完成。

- **01 · `TaskContract`** — Better Workflows 固定 goal、scope 與 authority，把每個判斷綁定到目前仍有效且可重新驗證的證據，以及已核對的外部結果。
- **02 · `evidence`** — 開源、goal-first 的 agent 工作流程控制面，以目前仍有效的證據、審查關卡、來源綁定與 provider 狀態核對，確保結果可重新驗證。
- **03 · `reconciliation`** — 先定義 contract，再驗證 source 與 evidence、核對外部操作結果；只有 terminal state 已知時，才宣告完成。
- **04 · `terminal state`** — 命令成功執行不代表工作已經完成；可重新驗證的結果才是證明。

## 快速開始

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## 從架構地圖繼續深入實際使用情境。

- [從意圖到完成，明確劃分四道邊界。](https://betterworkflows.dev/zh-Hant/docs/)
- [快速開始](https://betterworkflows.dev/zh-Hant/docs/quick/)
- [從架構地圖繼續深入實際使用情境。](https://betterworkflows.dev/zh-Hant/docs/use-cases/)
- [快速開始 — 從架構地圖繼續深入實際使用情境。](https://betterworkflows.dev/zh-Hant/docs/use-cases/quick/)
- [Evidence Cinema](https://betterworkflows.dev/zh-Hant/docs/evidence-cinema/)


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

單次贊助將用於開源維護、文件、41 個本地化版本與網站託管；不包含會員資格，也不提供開發規劃或技術支援優先權。

[透過 Ko-fi 單次贊助](https://ko-fi.com/betterworkflows)

---

命令成功執行不代表工作已經完成；可重新驗證的結果才是證明。
