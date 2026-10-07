<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 現已公開發布：專為 AI 工程 QA 與交付打造的免費開源 Auto 工作流，具備即時證據、審查 gate 與提供者核對機制。

[English](en.md) · **繁體中文** · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[查看官方文件](https://betterworkflows.dev/zh-Hant/docs/) · [官方來源連結](https://github.com/stephen-taipei/better-workflows) · [透過 USDT（TRC20）單次贊助](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 涵蓋 macOS × Node 22/24 上的 Codex、Gemini CLI 與 Qwen Code。Claude Code、Linux 與 Windows 資格認證延後至 V5.1。GA 需要至少 30 個自然金絲雀天數、連續 20 次合格啟動以及三個不同的存放庫。

## 讓 agent 工作<br>完成，並留下可驗證的結果。

V5.0 RC1 現已公開發布。Auto 會檢查目標、範圍、存放庫與風險，隨後選擇針對性檢查或證據工作流。Git 修改使用任務專屬的 worktree；交付則需要授權與經核驗的外部成果。

## 從意圖到完成，明確劃分四道邊界。

先定義 contract，再驗證 source 與 evidence、核對外部操作結果；只有 terminal state 已知時，才宣告完成。

- **01 · `TaskContract`** — V5.0 RC1 現已公開發布。Auto 會檢查目標、範圍、存放庫與風險，隨後選擇針對性檢查或證據工作流。Git 修改使用任務專屬的 worktree；交付則需要授權與經核驗的外部成果。
- **02 · `evidence`** — Better Workflows V5.0 RC1 現已公開發布：專為 AI 工程 QA 與交付打造的免費開源 Auto 工作流，具備即時證據、審查 gate 與提供者核對機制。
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
- [證據劇場](https://betterworkflows.dev/zh-Hant/docs/evidence-cinema/)

### 查看官方文件 · `zh-Hant`

此參考頁已提供本語系摘要；互動內容尚未完整翻譯。

- **01 · 從意圖到完成，明確劃分四道邊界。** — 先定義 contract，再驗證 source 與 evidence、核對外部操作結果；只有 terminal state 已知時，才宣告完成。
- **02 · 從架構地圖繼續深入實際使用情境。** — V5.0 RC1 現已公開發布。Auto 會檢查目標、範圍、存放庫與風險，隨後選擇針對性檢查或證據工作流。Git 修改使用任務專屬的 worktree；交付則需要授權與經核驗的外部成果。
- **03 · 快速開始** — Better Workflows V5.0 RC1 現已公開發布：專為 AI 工程 QA 與交付打造的免費開源 Auto 工作流，具備即時證據、審查 gate 與提供者核對機制。

- [`從意圖到完成，明確劃分四道邊界。`](https://betterworkflows.dev/docs/reference/zh-Hant/index.html) · `zh-Hant`
- [`快速開始`](https://betterworkflows.dev/docs/reference/zh-Hant/preview.html) · `zh-Hant`
- [`從架構地圖繼續深入實際使用情境。`](https://betterworkflows.dev/docs/reference/zh-Hant/use-cases/index.html) · `zh-Hant`
- [`快速開始 — 從架構地圖繼續深入實際使用情境。`](https://betterworkflows.dev/docs/reference/zh-Hant/use-cases/preview.html) · `zh-Hant`
- [`證據劇場`](https://betterworkflows.dev/docs/reference/zh-Hant/evidence-cinema/index.html) · `zh-Hant`

- [查看官方文件 · `zh-Hant`](../details/zh-Hant.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### 查看官方文件 · `en`



### 查看官方文件 · `zh-Hant`

- [資安政策](zh-Hant/security.md) · `zh-Hant`
- [參與貢獻](zh-Hant/contributing.md) · `zh-Hant`
- [專案治理](zh-Hant/governance.md) · `zh-Hant`
- [社群行為準則](zh-Hant/conduct.md) · `zh-Hant`
- [第三方聲明](zh-Hant/notices.md) · `zh-Hant`
- [README 撰寫品質指南](zh-Hant/readme-quality.md) · `zh-Hant`
- [編輯用色系統](zh-Hant/color-system.md) · `zh-Hant`
- [架構](zh-Hant/architecture.md) · `zh-Hant`
- [安全性](zh-Hant/security-guide.md) · `zh-Hant`
- [CLI 參考](zh-Hant/cli-reference.md) · `zh-Hant`
- [入門指南](zh-Hant/getting-started.md) · `zh-Hant`
- [工作流](zh-Hant/workflows.md) · `zh-Hant`
- [使用支援](zh-Hant/support.md) · `zh-Hant`

## 協助 Better Workflows 持續維護。

單次贊助將用於開源維護、文件、41 個本地化版本與網站託管；不包含會員資格，也不提供產品路線圖或技術支援優先權。

[透過 USDT（TRC20）單次贊助](https://betterworkflows.dev/#sponsor)

---

命令成功執行不代表工作已經完成；可重新驗證的結果才是證明。
