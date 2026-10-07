<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 現已公開發布：免費、開源嘅 Auto 工作流程，專為 AI 工程 QA 同交付而設，具備最新證據、審查 gate 同供應商對賬功能。

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · **繁體中文（香港）** · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[查看官方文件](https://betterworkflows.dev/zh-Hant-HK/docs/) · [開啟 GitHub](https://github.com/stephen-taipei/better-workflows) · [透過 USDT（TRC20）一次過贊助](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 涵蓋 macOS × Node 22/24 上嘅 Codex、Gemini CLI 同 Qwen Code。Claude Code、Linux 同 Windows 嘅合資格認證推遲至 V5.1。GA 需要至少 30 個自然金絲雀日、連續 20 次合資格啟動，同三個不同嘅存放庫。

## 讓 agent 工作<br>完成，並留下可以再次驗證的結果。

V5.0 RC1 現已公開發布。Auto 會檢查目標、範疇、代碼庫同風險，然後揀選針對性檢查或證據工作流程。Git 修改使用任務專屬嘅 worktree；交付需要授權同經過驗證嘅外部成果。

## 由意圖到完成，清楚劃分四道邊界。

先定義 contract，再驗證 source 及 evidence、核對外部操作結果；只有在 terminal state 已知時，才宣告完成。

- **01 · `TaskContract`** — V5.0 RC1 現已公開發布。Auto 會檢查目標、範疇、代碼庫同風險，然後揀選針對性檢查或證據工作流程。Git 修改使用任務專屬嘅 worktree；交付需要授權同經過驗證嘅外部成果。
- **02 · `evidence`** — Better Workflows V5.0 RC1 現已公開發布：免費、開源嘅 Auto 工作流程，專為 AI 工程 QA 同交付而設，具備最新證據、審查 gate 同供應商對賬功能。
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
- [證據劇場](https://betterworkflows.dev/zh-Hant-HK/docs/evidence-cinema/)

### 查看官方文件 · `zh-Hant-HK`

此參考頁已提供本地化摘要；互動內容尚未完整翻譯。

- **01 · 由意圖到完成，清楚劃分四道邊界。** — 先定義 contract，再驗證 source 及 evidence、核對外部操作結果；只有在 terminal state 已知時，才宣告完成。
- **02 · 由架構地圖繼續深入實際使用情境。** — V5.0 RC1 現已公開發布。Auto 會檢查目標、範疇、代碼庫同風險，然後揀選針對性檢查或證據工作流程。Git 修改使用任務專屬嘅 worktree；交付需要授權同經過驗證嘅外部成果。
- **03 · 快速開始** — Better Workflows V5.0 RC1 現已公開發布：免費、開源嘅 Auto 工作流程，專為 AI 工程 QA 同交付而設，具備最新證據、審查 gate 同供應商對賬功能。

- [`由意圖到完成，清楚劃分四道邊界。`](https://betterworkflows.dev/docs/reference/zh-Hant-HK/index.html) · `zh-Hant-HK`
- [`快速開始`](https://betterworkflows.dev/docs/reference/zh-Hant-HK/preview.html) · `zh-Hant-HK`
- [`由架構地圖繼續深入實際使用情境。`](https://betterworkflows.dev/docs/reference/zh-Hant-HK/use-cases/index.html) · `zh-Hant-HK`
- [`快速開始 — 由架構地圖繼續深入實際使用情境。`](https://betterworkflows.dev/docs/reference/zh-Hant-HK/use-cases/preview.html) · `zh-Hant-HK`
- [`證據劇場`](https://betterworkflows.dev/docs/reference/zh-Hant-HK/evidence-cinema/index.html) · `zh-Hant-HK`

- [查看官方文件 · `zh-Hant-HK`](../details/zh-Hant-HK.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### 查看官方文件 · `en`



### 查看官方文件 · `zh-Hant-HK`

- [保安政策](zh-Hant-HK/security.md) · `zh-Hant-HK`
- [參與貢獻](zh-Hant-HK/contributing.md) · `zh-Hant-HK`
- [管治](zh-Hant-HK/governance.md) · `zh-Hant-HK`
- [社區行為準則](zh-Hant-HK/conduct.md) · `zh-Hant-HK`
- [第三方聲明](zh-Hant-HK/notices.md) · `zh-Hant-HK`
- [README 撰寫品質指南](zh-Hant-HK/readme-quality.md) · `zh-Hant-HK`
- [編輯用色系統](zh-Hant-HK/color-system.md) · `zh-Hant-HK`
- [架構](zh-Hant-HK/architecture.md) · `zh-Hant-HK`
- [保安](zh-Hant-HK/security-guide.md) · `zh-Hant-HK`
- [CLI 參考](zh-Hant-HK/cli-reference.md) · `zh-Hant-HK`
- [入門指南](zh-Hant-HK/getting-started.md) · `zh-Hant-HK`
- [工作流程](zh-Hant-HK/workflows.md) · `zh-Hant-HK`
- [使用支援](zh-Hant-HK/support.md) · `zh-Hant-HK`

## 協助 Better Workflows 持續維護。

一次過贊助會用於開源維護、文件、41 個本地化版本同網站託管；唔包括會員資格，亦唔會提供產品路線圖或技術支援優先權。

[透過 USDT（TRC20）一次過贊助](https://betterworkflows.dev/#sponsor)

---

指令成功執行不代表工作已經完成；可以再次驗證的結果才是證明。
