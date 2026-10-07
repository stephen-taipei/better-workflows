<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# 入門指南

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · **繁體中文（台灣）** · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · [日本語](../ja/getting-started.md) · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 涵蓋 macOS × Node 22\/24 上的 Codex、Gemini CLI 與 Qwen Code。Claude Code、Linux 與 Windows 的驗收延至 V5\.1。GA 仍需至少 30 個自然 canary 日、20 次連續符合資格的啟動，以及三個不同儲存庫。

| [總覽](../../../README.md) | [詳細說明](../../../docs/details/en.md) | **快速入門** | [工作流程](workflows.md) | [架構](architecture.md) | [資安](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[41 個語系版本的在地化總覽與官網入口](../../../docs/LANGUAGES.md)。指令與識別碼維持標準英文形式。

V5\.0 RC1（`5.0.0-rc.1`，tag `V5.0.rc1`）已公開上架。公開範圍僅有 Auto，涵蓋 macOS 搭配 Node 22\/24 上的 Codex、Gemini CLI 與 Qwen Code。Linux 與 Windows 的資格驗收延至 V5\.1，Claude Code 也同樣延後。GA `5.0.0` 仍待完成至少 30 個自然 canary 日、20 次連續符合資格的啟動，並記錄三個不同的儲存庫。

## 使用需求

- 隨附的 `sbw` 輔助工具需要 Node\.js 22\.14 或更新版本。
- 可信任的本機儲存庫。Better Workflows 並未宣稱能以沙箱隔離惡意儲存庫程式碼。

v4 的狀態根目錄不依賴特定 AI 代理平台：若已設定 `SBW_STATE_ROOT`，便優先使用；其次使用 `XDG_STATE_HOME/better-workflows`，否則使用 `~/.better-workflows`。預設位置不再位於 `CODEX_HOME` 之下。若要繼續使用現有的 v3 Codex 狀態而不搬移資料，請明確將 `SBW_STATE_ROOT` 設為該狀態所在的確切 `<CODEX_HOME>/sbw` 目錄，再呼叫 `sbw`。

V5\.0 \(GA\) \(`5.0.0`\) 仍待發布。以下安裝指令以已公開的 V5\.0 RC1（`5.0.0-rc.1`，tag `V5.0.rc1`）為目標。

## 安裝

### Codex — 建議採用的參考環境

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

安裝後請開啟新的 Codex 任務，以重新整理其技能目錄。

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI 會複製擴充套件。安裝後請重新啟動工作階段；之後可使用 `gemini extensions update better-workflows` 更新。

擴充套件的上下文會依自身已載入的來源路徑定位橋接層，而非依你的專案工作目錄。若採用標準的使用者範圍安裝，等效的手動檢查如下：

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

對於以連結方式載入或工作區範圍的擴充套件，請使用 AI 代理平台顯示的確切擴充套件根目錄。不得以名稱相近的簽出目錄替代。

### Qwen Code

安裝擴充套件的本機副本前，請先鎖定發行版本：

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code 也會複製擴充套件，因此安裝後請重新啟動工作階段，並使用 `qwen extensions update better-workflows` 進行後續更新。

若採用標準的使用者範圍安裝，等效的手動橋接層檢查如下：

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

以連結方式或工作區範圍安裝時，同樣必須遵守使用確切根目錄的規則。

## Auto

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

每個入口都會保留所要求的 Goal。若已有不相關的作用中 Goal，必須明確編輯或清除；系統絕不會在未明示的情況下將其替換。

## 預覽流程路徑

能力快照僅供讀取，不會觸發供應商登入或模型語意探測：

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

若要進行可供審閱的交接，請建立並使用一份私密、僅限單次使用的可驗證紀錄：

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

可驗證紀錄會在 24 小時後到期；若重複使用，或工作區、範圍、Profiles、目錄、能力或外掛套件出現偏移，系統會拒絕操作，不會在不確定的情況下放行。

## 驗證安裝

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## 修改儲存庫之前

Auto 會先對工作區進行唯讀預檢：

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

非 Git 任務與唯讀任務不會建立工作樹。會進行變更的 Git 任務必須建立或重用由該任務擁有的 `TaskWorkspaceLeaseV1`。若來源工作目錄包含未提交的變更，流程會在進行任何 stash、複製、提交或建立工作樹之前停止。若 HEAD 處於分離狀態，或缺少目標，則必須明確指定整合目標。受保護的目標或遠端目標，會轉入受治理規則管控的 PR 交付流程。

若 Codex 或其他 AI 代理平台已為目前任務建立乾淨的工作樹，請在編輯前先登錄該工作樹，不要建立巢狀工作樹：

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

登錄時必須具備獨立的 `codex/*` 任務分支，且該分支位於未變動的基底；同時必須使用相同的 Git 共用目錄，並保有乾淨的來源簽出目錄。Better Workflows 會使用該工作樹，但在清理時保留 AI 代理平台擁有的分支與路徑。若目標受到保護，請先執行證據工作流程，再以 `workspace reconcile --run-id <run-id>` 綁定該流程的確切 PR 合併與遠端同步可驗證紀錄。

下一步：[選擇合適的工作流程](workflows.md)，或瀏覽 [CLI 參考文件](cli-reference.md)。
