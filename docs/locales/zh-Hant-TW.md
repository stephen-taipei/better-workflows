<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 已公開上架：免費開源的 AI 工程 QA 與交付守門人，以 Auto 入口、有效證據、審查關卡與外部狀態核對，確保結果可重新驗證。

[English](en.md) · [繁體中文](zh-Hant.md) · **繁體中文（台灣）** · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · [日本語](ja.md) · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[查看官方文件](https://betterworkflows.dev/docs/) · [開啟 GitHub](https://github.com/stephen-taipei/better-workflows) · [透過 USDT（TRC20）單次贊助](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 涵蓋 macOS × Node 22/24 上的 Codex、Gemini CLI 與 Qwen Code。Claude Code、Linux 與 Windows 的驗收延至 V5.1。GA 仍需至少 30 個自然 canary 日、20 次連續符合資格的啟動，以及三個不同儲存庫。

## 讓 agent 工作<br>完成，並留下可驗證的結果。

V5.0 RC1 已公開上架。Auto 先檢查目標、範圍、儲存庫與風險，再選擇精簡檢查或證據流程。Git 修改使用專屬 worktree；交付必須有授權，並核對外部結果。

## 從意圖到完成，明確劃分四道邊界。

先定義 contract，再驗證 source 與 evidence、核對外部操作結果；只有 terminal state 已知時，才宣告完成。

- **01 · `TaskContract`** — V5.0 RC1 已公開上架。Auto 先檢查目標、範圍、儲存庫與風險，再選擇精簡檢查或證據流程。Git 修改使用專屬 worktree；交付必須有授權，並核對外部結果。
- **02 · `evidence`** — Better Workflows V5.0 RC1 已公開上架：免費開源的 AI 工程 QA 與交付守門人，以 Auto 入口、有效證據、審查關卡與外部狀態核對，確保結果可重新驗證。
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

- [從意圖到完成，明確劃分四道邊界。](https://betterworkflows.dev/docs/)
- [快速開始](https://betterworkflows.dev/docs/quick/)
- [從架構地圖繼續深入實際使用情境。](https://betterworkflows.dev/docs/use-cases/)
- [快速開始 — 從架構地圖繼續深入實際使用情境。](https://betterworkflows.dev/docs/use-cases/quick/)
- [證據劇場](https://betterworkflows.dev/docs/evidence-cinema/)

### 查看官方文件 · `zh-Hant-TW`

此參考頁已提供本語系摘要；互動內容尚未完整翻譯。

- **01 · 從意圖到完成，明確劃分四道邊界。** — 先定義 contract，再驗證 source 與 evidence、核對外部操作結果；只有 terminal state 已知時，才宣告完成。
- **02 · 從架構地圖繼續深入實際使用情境。** — V5.0 RC1 已公開上架。Auto 先檢查目標、範圍、儲存庫與風險，再選擇精簡檢查或證據流程。Git 修改使用專屬 worktree；交付必須有授權，並核對外部結果。
- **03 · 快速開始** — Better Workflows V5.0 RC1 已公開上架：免費開源的 AI 工程 QA 與交付守門人，以 Auto 入口、有效證據、審查關卡與外部狀態核對，確保結果可重新驗證。

- [`從意圖到完成，明確劃分四道邊界。`](https://betterworkflows.dev/docs/reference/zh-Hant-TW/index.html) · `zh-Hant-TW`
- [`快速開始`](https://betterworkflows.dev/docs/reference/zh-Hant-TW/preview.html) · `zh-Hant-TW`
- [`從架構地圖繼續深入實際使用情境。`](https://betterworkflows.dev/docs/reference/zh-Hant-TW/use-cases/index.html) · `zh-Hant-TW`
- [`快速開始 — 從架構地圖繼續深入實際使用情境。`](https://betterworkflows.dev/docs/reference/zh-Hant-TW/use-cases/preview.html) · `zh-Hant-TW`
- [`證據劇場`](https://betterworkflows.dev/docs/reference/zh-Hant-TW/evidence-cinema/index.html) · `zh-Hant-TW`

- [查看官方文件 · `zh-Hant-TW`](../details/zh-Hant-TW.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### 查看官方文件 · `en`



### 查看官方文件 · `zh-Hant-TW`

- [資安政策](zh-Hant-TW/security.md) · `zh-Hant-TW`
- [參與貢獻](zh-Hant-TW/contributing.md) · `zh-Hant-TW`
- [專案治理](zh-Hant-TW/governance.md) · `zh-Hant-TW`
- [社群行為準則](zh-Hant-TW/conduct.md) · `zh-Hant-TW`
- [第三方聲明](zh-Hant-TW/notices.md) · `zh-Hant-TW`
- [README 撰寫品質指南](zh-Hant-TW/readme-quality.md) · `zh-Hant-TW`
- [編輯用色系統](zh-Hant-TW/color-system.md) · `zh-Hant-TW`
- [架構](zh-Hant-TW/architecture.md) · `zh-Hant-TW`
- [安全性](zh-Hant-TW/security-guide.md) · `zh-Hant-TW`
- [CLI 參考](zh-Hant-TW/cli-reference.md) · `zh-Hant-TW`
- [入門指南](zh-Hant-TW/getting-started.md) · `zh-Hant-TW`
- [工作流程](zh-Hant-TW/workflows.md) · `zh-Hant-TW`
- [使用支援](zh-Hant-TW/support.md) · `zh-Hant-TW`

## 一起支持 Better Workflows 持續維護。

單次贊助將用於開源維護、文件、41 個在地化版本與網站託管；不包含會員資格，也不提供產品路線圖或技術支援優先權。

[透過 USDT（TRC20）單次贊助](https://betterworkflows.dev/#sponsor)

---

命令成功執行不代表工作已經完成；可重新驗證的結果才是證明。
