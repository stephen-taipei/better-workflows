# Better Workflows

[English](../README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

Better Workflows 是為 Codex 設計的原生優先、證據驅動工作流。Root 是唯一能修改程式碼、執行 Git/GitHub、deploy、接受風險與宣告完成的 authority；subagents 專注於研究、Review、測試證據與反證。

## 設計原理

Better Workflows 是治理型的 orchestration layer，不是無限制的 agent swarm。核心原則是：

- **Root-owned mutation：** Root 是唯一能修改、整合、執行 Git/GitHub mutation、deploy、接受風險與宣告完成的 authority。
- **Evidence before side effects：** side effect 前必須有證據、freshness、授權與 provider reconciliation；unknown outcome 一律 fail closed。
- **Bounded delegation：** native subagents 只負責研究、Review、測試證據與反證；最多三個 direct children，禁止遞迴 delegation，獨立 critics 依序執行。
- **Persistent intent：** `/goal` 跨 turn 保存使用者目標；template 與 mode 只決定驗證深度，不會偷偷改變目標。
- **Deterministic control plane：** `dw` 記錄 contract、private state、sentinel、evidence、findings、lease、action token 與 reconciliation，但不執行 model 生成的 command。
- **Explicit completion：** 只有 acceptance evidence 仍然新鮮、必要檢查通過、rollback 可用，且沒有未解決的高風險或 unknown state，才能完成。
- **Fast path remains explicit：** 小型且可逆的工作可使用 `direct`，不必承擔完整 workflow journal 成本。

這個取捨是用部分最高平行吞吐量，換取較小、可檢查的 mutation surface 與可預期的停止條件。目的是讓不安全的進度難以被隱藏，即使因此需要暫停等待證據或使用者授權。

## Better Workflows 與 Claude Dynamic Workflows 比較

這裡的「Claude Dynamic Workflows」指 Anthropic 的 Claude Code 功能，不是第三方套件。比較依據是 2026-07-20 查閱的 Anthropic 公開資料：[Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)、[A harness for every task](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)，以及 [Claude Code 平行 agent 文件](https://code.claude.com/docs/en/agents)。

| 面向 | Better Workflows | Claude Dynamic Workflows |
| --- | --- | --- |
| Orchestration | Selector、template、明確 mode 與 deterministic local control plane。 | Claude 依任務動態撰寫 JavaScript harness，再協調整個 run。 |
| 平行處理 | 小型 bounded native wave：最多三個 direct children，critics 依序執行。 | 以大量 fan-out 與長時間工作為目標；Anthropic 描述可平行啟動數十到數百個 subagents。 |
| State 與完成條件 | Persistent `/goal`、private run state、sentinel、evidence、action token、reconciliation 與 fail-closed completion。 | 保存 workflow progress，中斷後可繼續；實際 run 形狀主要由動態產生的 harness 決定。 |
| Mutation governance | Root-only mutation/integration；delegated agents 依 contract 唯讀。 | 支援 subagents、worktree、model 選擇與 permission control，但 workflow 本身是為任務動態產生。 |
| 適應性 | Runtime freedom 較低，但 side effect 前較容易 review，也較容易從 template 重現。 | Runtime adaptability 較高，適合未知數量、高平行、對抗驗證或多日任務。 |
| 吞吐與成本 | 刻意保守；較少平行 worker 可能降低最高吞吐，但成本與 blast radius 較容易界定。 | 吞吐潛力較高，但官方提醒 dynamic workflows 可能消耗明顯更多 token。 |
| 可攜性 | Codex-native plugin 與 Node.js helper；可套用到能執行 plugin 的 repositories。 | Claude Code CLI、Desktop、VS Code extension、API 與支援的 cloud providers。 |
| 最適情境 | Contract-sensitive refactor、Review、release、Git/GitHub 操作，重視證據與 rollback。 | 大型 migration、全 codebase exploration、大規模 verification，以及需要動態 orchestration 的任務。 |

### 實務取捨

當主要風險是 uncontrolled mutation、授權不清、證據過期或不可逆 side effect 時，Better Workflows 更合適。明確的 queue、checkpoint 與 fail-closed gates 讓人容易解釋流程為何停止，以及繼續前需要補哪些 reconciliation。

當瓶頸是 orchestration scale，例如大量獨立子任務、長時間執行、動態 loop 或大型 migration 時，Claude Dynamic Workflows 更有優勢。不過 Anthropic 也提醒它不適合每個任務，且可能顯著增加 token 使用量；規模換來的是成本與 latency trade-off，而不是所有任務的普遍提升。

兩者優化的目標不同：Better Workflows 優先追求 Codex 內可治理、可 Review 的進度；Claude Dynamic Workflows 優先追求 Claude Code 內動態產生且高度平行的 harness。

## 安裝

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

安裝後請開新的 Codex task，讓 Skill catalog 重新載入。

## 在 Codex 使用

### Codex CLI

在 Codex CLI 中，請以 `@` 開頭搜尋 `better`，再從 CLI 選單選擇 Better Workflows skill 或入口。

![Codex CLI Skill 選單中的 Better Workflows](assets/better-workflows-skill-picker-cli.png)

### Codex App

在 Codex App 中，請以 `/` 開頭搜尋 `better`，再從 App 選單選擇對應的 command 或 skill 入口。

![Codex App command 選單中的 Better Workflows](assets/better-workflows-skill-picker-app.png)

在任一介面選擇入口後直接描述成果即可。選單會自動插入 `$better-workflows:<name>`；不需要手動輸入 `/goal`，也不用記住 template、mode 或 model alias。最推薦的預設入口是：

```text
$better-workflows:auto <描述你要完成的成果>
```

例如：

```text
$better-workflows:cross-platform 檢查 backend、iOS 和 Android 的 contact sync contract，修復問題並建立 PR。
```

所有入口都會在正式工作前自動建立或延續 persistent Goal，包含 `direct`。如果已有不相關且尚未完成的 Goal，流程會要求你使用 `/goal edit` 或 `/goal clear`，不會偷偷覆蓋。

### 快速選擇

- 不確定選哪個：使用 `auto`。
- 已知道任務類型：從九個任務入口選擇。
- 只想指定審查強度：使用 `direct`、`verified`、`deep` 或 `critical`。
- 習慣舊指令：使用 compatibility alias。

### 自動與任務入口

| 入口 | 建議情境 | 範例 |
| --- | --- | --- |
| `$better-workflows:auto` | 大多數任務的推薦預設。依風險與證據自動選 template、mode 與 critics。 | `$better-workflows:auto Review 目前 repo、修復已驗證問題並建立 PR。` |
| `$better-workflows:review-issues` | 唯讀 audit、finding 去重，以及經授權的 GitHub issue 建立；不修改 code。 | `$better-workflows:review-issues Review 最新 dev SHA，建立去重後的 P0/P1/P2 issues。` |
| `$better-workflows:fix-issues-pr` | 重驗 open issues、由 Root 修復、建立 PR；只有獲授權時才 merge 與 cleanup。 | `$better-workflows:fix-issues-pr 修復 dev 的 open issues，建立 PR，等待 fresh checks 後 merge 並 cleanup。` |
| `$better-workflows:cross-platform` | Backend、iOS、Android、Web 的 schema、optional 欄位、enum、sync、version gate 與 headers。 | `$better-workflows:cross-platform 檢查 backend、iOS 和 Android 的 contact sync contract，修復問題並建立 PR。` |
| `$better-workflows:ios-static` | 不適合本機 build 時的 Swift/iOS 靜態 Review，以及序列化 `project.pbxproj` 驗證。 | `$better-workflows:ios-static 不做 build，Review iOS 變更、檢查新 Swift 檔已加入 pbxproj 並修復靜態問題。` |
| `$better-workflows:localization` | 多語系更新，特別是 41 語系 key 數量、順序、精準 scope 與區域變體。 | `$better-workflows:localization 將這些 keys 加到全部 41 語系，並驗證 key 順序一致。` |
| `$better-workflows:ci-release` | CI failure、runner queue、序列化 deploy、release、遠端監控與 receipt 驗證。 | `$better-workflows:ci-release 診斷失敗的 PR checks、修復並監控序列化 dev deploy。` |
| `$better-workflows:browser-qa` | 需要最新 UI 證據、截圖與可重現 action log 的 Webwright／模擬器 QA。 | `$better-workflows:browser-qa 驗證 signup 與 contact sync，並附上 screenshot evidence。` |
| `$better-workflows:research` | 證據驅動研究、架構比較、獨立觀點與反證；不以多數決決策。 | `$better-workflows:research 比較三種 sync 架構、反證每個方案並提出建議。` |
| `$better-workflows:monorepo-refactor` | 完整盤點 monorepo，直接實作所有合格的 bounded refactor 建議，並保留 behavior invariants、validation 與 rollback evidence。 | `$better-workflows:monorepo-refactor 盤點 monorepo，直接實作所有合格的 boundary cleanup 建議，不改變 public contract。` |

### 審查強度入口

這四個入口會讓 Codex 自動判斷任務 template，但固定最低驗證強度。

| 入口 | 建議情境 | 範例 |
| --- | --- | --- |
| `$better-workflows:direct` | 小型、可逆、明確且重視速度的任務。保留 Goal，但不建立 workflow journal 或 critics。 | `$better-workflows:direct 修正這個一行文件 typo 並檢查 diff。` |
| `$better-workflows:verified` | 一般工程任務，需要 1–3 個唯讀 research／Review／refutation agents 與 freshness evidence。 | `$better-workflows:verified Review 並修復 pagination bug，然後建立 PR。` |
| `$better-workflows:deep` | 架構、安全、廣泛 refactor 或高不確定性變更，需要 verified wave 加獨立 Codex critics。 | `$better-workflows:deep Review auth redesign、修復已驗證問題並建立 migration-safe PR。` |
| `$better-workflows:critical` | Release、migration、production、破壞性 cleanup 或不可逆 side effects，必須 fail closed。 | `$better-workflows:critical 只有 policy、remote SHA 與 reconciliation gates 全部通過才執行 production release。` |

### Compatibility aliases

這些入口保留舊使用習慣，但底層都改走同一套 Goal-first、Root-owned 工作流，不會復活已淘汰的平行寫入流程。

| 入口 | 建議情境 | 對應路由 |
| --- | --- | --- |
| `$better-workflows:auto-improve` | 舊 `autoImprove`：Review、驗證 findings、修復、建立 PR 並安全收斂。 | Fix issues to PR，預設 `deep` |
| `$better-workflows:auto-issues` | 舊 `autoIssues`：唯讀 Review 與去重 issue 建立。 | Review to issues，預設 `verified` |
| `$better-workflows:ai-meeting-tw` | 舊 AI meeting：多觀點研究與 model critics，不使用 Claude 或票數決策。 | Research deliberation，預設 `deep` |
| `$better-workflows:git-check-issues` | 舊 issue repair：重新取得 issue 狀態、修復、建立 PR 與精準 cleanup。 | Fix issues to PR，預設 `deep` |
| `$better-workflows` | 沒有指定選單入口時的自然語言 router。 | 自動判斷 template 與 mode |

## 核心模式

| Mode | 行為 |
| --- | --- |
| `direct` | Root 直接工作，不建立 durable workflow state。 |
| `verified` | Root 加 1–3 個唯讀研究／Review／反證 agents。 |
| `deep` | `verified` 後序列加入最多兩個 Codex critics。 |
| `critical` | 完整 evidence、side-effect gates，以及 policy 要求的外部 reviewer。 |

## 安全模型

- Root 是唯一修改、Git/GitHub、deploy、接受風險與宣告完成的 authority。
- Side effects 在 freshness、授權或 reconciliation 不完整時 fail closed。
- Agy 只允許經授權、去敏且非機密的資料。
- Unknown provider outcome 必須先 query reconciliation，不會盲目重試。

## 開發驗證

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/dw.mjs eval
```

Runtime 只使用 Node.js standard library。

## License

MIT。請參閱 [LICENSE](../LICENSE) 與 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
