# Better Workflows

[English](../README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

Better Workflows 是為 Codex 設計的原生優先、證據驅動工作流。Root 是唯一能修改程式碼、執行 Git/GitHub、deploy、接受風險與宣告完成的 authority；subagents 專注於研究、Review、測試證據與反證。

## 設計原理

Better Workflows 是治理型的 orchestration layer，不是無限制的 agent swarm。核心原則是：

- **Root-owned mutation：** Root 是唯一能修改、整合、執行 Git/GitHub mutation、deploy、接受風險與宣告完成的 authority。
- **Evidence before side effects：** side effect 前必須有證據、freshness、授權與 provider reconciliation；unknown outcome 一律 fail closed。
- **Bounded delegation：** native subagents 只負責研究、Review、測試證據與反證；最多三個 direct children，禁止遞迴 delegation，獨立 critics 依序執行。
- **Persistent intent：** `/goal` 跨 turn 保存使用者目標；template 與 mode 只決定驗證深度，不會偷偷改變目標。
- **Deterministic control plane：** `sbw` 記錄 contract、private state、sentinel、evidence、findings、lease、action token 與 reconciliation，但不執行 model 生成的 command。
- **Explicit completion：** 只有 acceptance evidence 仍然新鮮、必要檢查通過、rollback 可用，且沒有未解決的高風險或 unknown state，才能完成。
- **Fast path remains explicit：** 小型且可逆的工作可使用 `direct`，不必承擔完整 workflow journal 成本。

這個取捨是用部分最高平行吞吐量，換取較小、可檢查的 mutation surface 與可預期的停止條件。目的是讓不安全的進度難以被隱藏，即使因此需要暫停等待證據或使用者授權。

## Better Workflows 與 Claude Dynamic Workflows 比較

這裡的「Claude Dynamic Workflows」指 Anthropic 的 Claude Code 功能，不是第三方套件。比較依據是 2026-07-20 查閱的 Anthropic 公開資料：[Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)、[A harness for every task](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)，以及 [Claude Code 平行 agent 文件](https://code.claude.com/docs/en/agents)。

> **一句話定位：** Dynamic Workflows 在需要自適應廣度時擴大探索空間；Better Workflows 讓已接受的路徑有界、可驗證，並能安全整合。

> **重要邊界：** 以下是人或自動化流程主導的 operating model，不是兩個產品之間的原生整合；不宣稱共享 runtime state、自動 handoff 或 protocol compatibility。

### 最大特色差異

核心差異是 orchestration posture 與 authority：

- **Dynamic Workflows 優先自適應廣度：** 依任務生成 JavaScript harness，平行展開多個 agents，選擇 model/worktree，驗證結果並依停止條件迭代。
- **Better Workflows 優先治理式收斂：** Root 保留 mutation，限制 delegated research，記錄 deterministic state/evidence；freshness、授權、reconciliation 或 completion evidence 不足時 fail closed。

這不是能力互斥：Better Workflows 也能 research/deep review，Dynamic Workflows 也能實作與 release。真正的差異是優先最佳化的對象：**runtime exploration scale 對 deterministic mutation control**。

### 為什麼沒有內建這些功能？

這是刻意設定的邊界，不是未完成的功能清單。Better Workflows 是圍繞 Codex 工作的治理／控制平面，不是讓 model 動態生成無界 agent harness 的 runtime。`sbw` 負責記錄與驗證 state、evidence 與 action gates；不會 spawn agents，也不會執行 model 生成的 commands。

| 能力 | 本 repo 提供什麼 | 為什麼刻意設界 |
| --- | --- | --- |
| 依任務生成 JavaScript harness | 明確 template、mode 與 deterministic helper logic。 | 動態 harness 適應更快，但會在 runtime 改變執行計畫；本 repo 保持 mutation 前的 control plane 可檢查。 |
| 大型或無界 fan-out | 最多三個 direct native children，禁止遞迴 delegation。 | 限制 token 成本、共用檔案衝突與 blast radius。 |
| Adversarial verification | Refutation、research findings，以及最多兩個循序 model-pinned critics。 | 保留反證，但數量與順序可審計，不會隨生成的子任務無限擴張。 |
| Loop-until-done | Persistent Goal、implementation queue、checkpoint 與明確 completion gates。 | 可跨 validated slices 繼續，但不能靜默擴張 scope 或在沒有新證據時無限 spawn。 |
| 自動 worktree swarm | Branch/protected-branch 與 cleanup gates；不為每個生成子任務自動建立 worktree。 | Root 保留 integration/cleanup ownership，避免平行 mutation 的責任不清。 |
| 無人值守長時間執行 | Durable run state 與可 resume 的 Goal，但仍需明確授權與 reconciliation。 | 可恢復很有用；autonomous daemon 還需要獨立的 lease、資源、取消與 side-effect protocol。 |

**所以它不適合嗎？** 不是。當 contract 已知，且錯誤 mutation 的下行風險不對稱時，Better Workflows 更合適：release、protected branch、API 變更、安全敏感 refactor、Review 與 maintenance。當不確定性與規模主導時，Dynamic Workflows 更適合作為第一棒。兩者並用通常更強：先廣泛探索，再正規化版本化 handoff，最後由 Better Workflows 獨立驗證並治理實作。這是 operating pattern，不是 native interoperability。

| 面向 | Better Workflows | Claude Dynamic Workflows |
| --- | --- | --- |
| Orchestration posture | 明確 selector、template、mode 與 deterministic local control plane。 | Runtime 動態生成並組合 task-specific JavaScript harness。 |
| 廣度與迭代 | 最多三個 direct children，獨立 critics 依序執行。 | 大量 fan-out、adversarial verification、dynamic loop 與長時間執行。 |
| Mutation boundary | Root 掌握修改、整合、Git/GitHub、deploy、風險接受與完成宣告；delegated agents 依 contract 唯讀。 | 生成的 harness 可選擇 subagent、model 與 worktree；該任務 script 決定治理形狀。 |
| State 與完成 | Persistent Goal、private state、sentinel、evidence、lease、action token、reconciliation、fail-closed。 | 保存 progress 並可 resume，由 harness 協調收斂後回傳結果。 |
| 成本與 blast radius | 刻意保守，較容易界定成本、mutation surface 與停止條件。 | 規模潛力高，但官方提醒可能使用明顯更多 token。 |
| 適合的起點 | 已知 contract、release、refactor、Review 或下行風險不對稱的變更。 | 未知規模探索、大型 migration、全 repo audit 或值得大量平行化的工作。 |

### Explore → Gate → Execute → Maintain

以下是協作 SOP；它是建議的 operating pattern，不是自動產品 handoff。

```mermaid
flowchart LR
  A["未知或廣泛問題"] --> B["Dynamic Workflows<br/>自適應探索"]
  B --> C{"版本化 handoff gate<br/>goal · scope · invariants · evidence · ownership"}
  C -- "過期、漂移、衝突或缺少授權" --> B
  C -- "接受" --> D["Better Workflows<br/>Root 控制執行"]
  D --> E["新鮮驗證<br/>contract · tests · rollback"]
  E --> F["授權整合或 release"]
  F --> G["有界維護<br/>保留可審計狀態"]
  G -- "新不確定性或 scope 擴張" --> B
```

### 版本化 handoff package

Better Workflows 接受探索結果前，先正規化成版本化 handoff package，作為防止 scope drift 的邊界：

| Gate | 必要資料 | 何時拒絕並回到探索 |
| --- | --- | --- |
| Goal | 問題、non-goals、選定方案與被否決方案。 | 目標或 scope 仍不明確。 |
| Contract | Invariants、interfaces、acceptance tests、可重現 commands。 | public behavior 或成功條件無人負責。 |
| Evidence | Source index、provenance、時間戳、baseline checks、未解 findings。 | 證據過期、unknown 或不可重現。 |
| Ownership | Repo、branch、commit/worktree、component owner、mutation boundary。 | baseline drift、ownership conflict 或共用檔案衝突。 |
| Risk/action | dependency/security risk、side-effect inventory、rollback、action tokens。 | side effect 缺少授權、reconciliation 或 rollback。 |

之後 Better Workflows 仍會獨立驗證 package，將它轉換為 Goal/contract/evidence state，只執行已接受的 scope。若 scope 擴大、baseline 改變或 gate 過期，就停止並重新探索，不要靜默擴張 mutation surface。

### 協作建議

| 情境 | 建議路徑 | 原因 |
| --- | --- | --- |
| 小型、可逆、明確的變更 | Better Workflows `direct` | 不值得支付 dynamic orchestration 成本。 |
| 已知 contract，但有驗證或 release 風險 | Better Workflows `verified`、`deep` 或 `critical` | 新鮮證據與 authority gates 比 fan-out 更重要。 |
| 架構未知、假設很多或大型 migration | 先 Dynamic Workflows，再進 handoff gate | 用廣度降低不確定性，但不能繞過整合控制。 |
| 設計已穩定後的 production 維護 | Better Workflows | 長期保留 contract、證據、rollback 與可審計 ownership。 |

**心智模型：** 廣泛探索、明確 gate、窄化執行、可審計維護。

## 安裝

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

安裝後請開新的 Codex task，讓 Skill catalog 重新載入。

## 漸進式路由：Snapshot → Preview → Execute

> **核心價值：** 工作開始前先說明「為什麼這條路由現在可用」。只看到已安裝
> 的名稱，不等於 command、support skill、provider 或 host capability
> 目前真的可以呼叫。

```bash
# 唯讀；不會啟動 provider 登入或 semantic model probe。
sbw doctor --capabilities

# 唯讀路由預覽。
sbw route preview \
  --goal "整合 Dependabot 更新並清理本次擁有的資源" \
  --scope . \
  --domain maintenance \
  --tag dependabot
```

每項 capability 都會顯示 `available`、`unavailable`、`unverified`、
`unsupported` 或 `requires-authority`，並附理由與 fallback。Model 可用性
只會重用未變更且仍在 24 小時內的 semantic roster cache；cache miss 或過期
不會自動 probe。Node-only v1 無法證明 Codex host 的 MCP exposure，因此明確
標示 `unsupported`，交由 host 回報。

### 一條 primary route、一份 Profile

Routing Profile 只能選一個 primary entry 或 template；可設定最低 mode、
required capabilities，以及最多三個**只提供建議**的 support skills。它不能
安裝工具、授予權限、新增 side effects、降低 mode，或覆蓋使用者明確選擇的
picker 入口。

| 優先序 | 來源 | 規則 |
| ---: | --- | --- |
| 1 | Host hard constraints | 本機設定不可降低；host 沒提供輸入時顯示 `unverified`。 |
| 2 | 明確 entry/template/mode | 使用者的 picker 或 CLI 選擇優先。 |
| 3 | Workspace Profile | `<repo>/.codex/better-workflows.json`；匹配時取代 personal route。 |
| 4 | Personal Profile | `$SBW_STATE_ROOT/routing/profile.json`。 |
| 5 | 內建 `auto` | 在證據選出真實 template 前回傳 `template: null`。 |

同一份 Profile 先比較 priority，同分維持檔案順序。不同 match category
採 AND；同一 category 內的值採 OR。Workspace 與 personal rule 不做
deep merge。可參考嚴格 schema 的
[Profile 範例](../plugins/better-workflows/config/routing-profile.example.json)。

```bash
sbw route profile validate --file my-routing-profile.json
sbw route profile install --file my-routing-profile.json
sbw route profile show
```

### 可審查、單次使用的 route receipt

需要把 preview 與後續執行綁在一起時，使用 `--record`：

```bash
sbw route preview \
  --goal "不改 public contract，重構 monorepo" \
  --scope . \
  --entry monorepo-refactor \
  --record

sbw run --route-receipt <route-receipt-id>
```

```mermaid
flowchart LR
  A["Capability snapshot<br/>只讀 roster cache"] --> B["Route preview<br/>explicit → workspace → personal → auto"]
  B --> C{"已有真實 template<br/>且 required capabilities 可用？"}
  C -- "否" --> D["Fail closed<br/>列出 blocker 或先選真實 template"]
  C -- "是" --> E["Private route receipt<br/>0600 · 24h · bundle digest"]
  E --> F{"Workspace、Profile、scope、<br/>catalog、capability 或 bundle 漂移？"}
  F -- "是" --> D
  F -- "否" --> G["單次 sbw run<br/>保留 mode floor"]
  G --> H["Template-bound action gates<br/>新鮮證據與 reconciliation"]
```

Receipt 會綁定 goal/scope、選定路由、catalog、workspace/personal Profiles、
capability fingerprint 與完整 plugin bundle digest；24 小時到期且只能使用
一次。重放、竄改或任何 binding 漂移都會 fail closed。

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
- 已知道任務類型：從十一個任務入口選擇。
- 只想指定審查強度：使用 `direct`、`verified`、`deep` 或 `critical`。
- 習慣舊指令：使用 compatibility alias。

### 自動與任務入口

| 入口 | 建議情境 | 範例 |
| --- | --- | --- |
| `$better-workflows:auto` | 大多數任務的推薦預設。依風險與證據自動選 template、mode 與 critics。 | `$better-workflows:auto Review 目前 repo、修復已驗證問題並建立 PR。` |
| `$better-workflows:review-issues` | 唯讀 audit、finding 去重，以及經授權的 GitHub issue 建立；不修改 code。 | `$better-workflows:review-issues Review 最新 dev SHA，建立去重後的 P0/P1/P2 issues。` |
| `$better-workflows:fix-issues-pr` | 重驗 open issues、由 Root 修復、建立 PR；只有獲授權時才 merge 與 cleanup。 | `$better-workflows:fix-issues-pr 修復 dev 的 open issues，建立 PR，等待 fresh checks 後 merge 並 cleanup。` |
| `$better-workflows:pr-to-dev` | 將範圍內修改分成 atomic commits，建立唯一 target 為 `dev` 的 PR，fresh checks 後 merge、同步 remote 並精準清理。 | `$better-workflows:pr-to-dev 分批 commit 目前修改，發 PR 至 dev，checks 通過後 merge、同步 remote dev 並清理本次 worktree。` |
| `$better-workflows:cross-platform` | Backend、iOS、Android、Web 的 schema、optional 欄位、enum、sync、version gate 與 headers。 | `$better-workflows:cross-platform 檢查 backend、iOS 和 Android 的 contact sync contract，修復問題並建立 PR。` |
| `$better-workflows:ios-static` | 不適合本機 build 時的 Swift/iOS 靜態 Review，以及序列化 `project.pbxproj` 驗證。 | `$better-workflows:ios-static 不做 build，Review iOS 變更、檢查新 Swift 檔已加入 pbxproj 並修復靜態問題。` |
| `$better-workflows:localization` | 多語系更新，特別是 41 語系 key 數量、順序、精準 scope 與區域變體。 | `$better-workflows:localization 將這些 keys 加到全部 41 語系，並驗證 key 順序一致。` |
| `$better-workflows:ci-release` | CI failure、runner queue、序列化 deploy、release、遠端監控與 receipt 驗證。 | `$better-workflows:ci-release 診斷失敗的 PR checks、修復並監控序列化 dev deploy。` |
| `$better-workflows:browser-qa` | 需要最新 UI 證據、截圖與可重現 action log 的 Webwright／模擬器 QA。 | `$better-workflows:browser-qa 驗證 signup 與 contact sync，並附上 screenshot evidence。` |
| `$better-workflows:research` | CLI 實測的多模型角色、證據驅動架構比較、反證與可執行 Plan；不以多數決決策。 | `$better-workflows:research 比較三種 sync 架構、反證每個方案並產出可實作的 Plan。` |
| `$better-workflows:self-improve` | 依近期且有界的證據改善 Better Workflows 本身，同步 selector、template、tests、docs、version、immutable cache 與經授權的 remote delivery。 | `$better-workflows:self-improve Review 近期 workflow 結果，只實作重複且已驗證的改善，完整驗證後發佈新 cache version 並 push atomic commit。` |
| `$better-workflows:monorepo-refactor` | 完整盤點 monorepo，直接實作所有合格的 bounded refactor 建議，並保留 behavior invariants、validation 與 rollback evidence。 | `$better-workflows:monorepo-refactor 盤點 monorepo，直接實作所有合格的 boundary cleanup 建議，不改變 public contract。` |

`self-improve-ops` 是薄型 orchestration template：沿用既有 research、refactor、routing、publication 與 delivery controls，允許有證據的 no-change，並分別 gate commit、cache publication 與 push。缺失的版本化 cache link 只能解析到已驗證的 current bundle，不得重建或修改 stale path。

### CLI 實測的多模型討論

`research-deliberation` 會保留完整設定的品牌名單：Codex、Claude、Gemini（經 Agy）、Agy、Grok、Cursor、Kimi、Qwen、Kiro；但只有通過安全 semantic CLI probe 的模型／指令組合，才能加入本次決策群。找不到 binary、登入失效或必須互動登入時，都會明確列為 unavailable，不會偷偷替代。

完整名單的每個 reasoning-effort profile 最多各自快取 24 小時；到期、`--refresh`、roster 設定變動，或 CLI 路徑／binary digest 變動時重新檢查。指定單一 provider 的 probe 不會覆寫完整快取。外部 CLI 一律需要使用者授權，且輸入必須是去敏、非機密資料；本 runtime 的 Gemini 以 `agy` transport 呼叫，不使用獨立 `gemini` 指令。

每個 participant 都套用相同的 contextual reasoning-effort：有界的 `direct`／`verified` 預設 `medium`，`auto`／`deep`／`critical` 預設 `high`，可依證據明確覆寫。Codex 會收到原生設定；Agy 會實際選擇 `gemini-3.6-flash-medium` 或 `gemini-3.6-flash-high`，且僅在該 model 支援時傳入原生 `--effort`；拒絕此旗標的 model 則如實標為 high／medium-only variant。其他 CLI 以 prompt-guidance 請求並如實記錄，不假稱 provider 已驗證。

```mermaid
flowchart LR
  A["去敏決策 dossier"] --> B["完整品牌 roster\n新 probe 或有效 24h cache"]
  B --> C["已驗證的模型角色\n獨立意見"]
  C --> D["Root 證據校準\n不採多數決"]
  D --> E["最高已驗證裁決者\nSol → Terra → Luna → Fable → Opus"]
  E --> F["可執行 Plan\nowner · dependencies · validation · rollback"]
  B -->|"不可用或不安全"| G["記錄排除\nfail closed"]
```

```bash
node plugins/better-workflows/scripts/sbw.mjs deliberation deliberate \
  --prompt-file sanitized-case.md \
  --allow-external-providers --sanitized
```

### Template-only：Dependabot consolidation SOP

Dependabot consolidation 是專用 template，不新增 picker Skill。需要固定
contract 時，可直接執行：

```bash
node plugins/better-workflows/scripts/sbw.mjs run \
  --template dependabot-consolidation-pr-cleanup \
  --mode critical \
  --goal "盤點 Dependabot PR，合併相容更新，建立並 merge 一個 consolidation PR，只清理本次產生的來源。" \
  --scope .
```

SOP 會依序完成：

```mermaid
flowchart LR
  A["新鮮 Dependabot inventory"] --> B["逐一分類\nconsolidate · separate · defer · exclude"]
  B --> C["相容性矩陣\npeer · runtime · lockfile · security"]
  C --> D["單一 consolidation branch 與 bounded diff"]
  D --> E["install、lockfile、lint、typecheck、test、audit"]
  E --> F["目前 revision 的單一 PR"]
  F --> G{"merge 且 reconciliation 完成？"}
  G -- "否／unknown" --> H["停止並查詢 provider 或處理 blocker"]
  G -- "是" --> J["盤點 repo workflows 與 Actions runs"]
  J --> K["取消本次擁有的 queued/in-progress Actions 並 reconciliation"]
  K --> I["只關閉／刪除本次擁有的來源 PR／branch／worktree"]
```

必要證據包含 `dependabot-inventory`、`compatibility-matrix`、
`consolidation-diff`、`lockfile-validation`、
`repository-actions-inventory`、`actions-cancelled`、`merge-result` 與
`cleanup-manifest`。流程會檢查 repo workflow 與相關 Actions runs 是否仍
存在，並明確記錄 missing、disabled、queued、running、terminal 狀態；查詢
失敗就停止。每個 Dependabot PR 都必須有 disposition；在本次來源 Actions
取消且 consolidation PR 完成 terminal reconciliation 前，不允許清理來源。

### Picker 流程：PR 合併至 `dev`

`pr-to-dev` 專門處理分批 atomic commit、建立唯一 target 為 `dev` 的 PR、
fresh required checks、受保護 merge、同步 remote `dev`，以及最後只清理本次
run 擁有的資源。可從原生 picker 選擇 `$better-workflows:pr-to-dev`，或直接
啟動相同 template：

```bash
node plugins/better-workflows/scripts/sbw.mjs run \
  --template pr-to-dev \
  --mode critical \
  --goal "將範圍內修改分成 atomic commits，建立 PR 合併至 dev，fresh checks 通過後 merge、同步 remote dev，再清理本次 worktree。" \
  --scope .
```

必要 gate 包含 `commit-plan`、`commit-manifest`、`target-branch-dev`、
`required-checks`、`merge-result`、`remote-sync` 與 `cleanup-manifest`。
禁止 admin bypass、stale checks、未 review commit，以及 remote reconciliation
前的 cleanup。

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
- 多模型 roster 保留所有設定品牌，但只使用最多 24 小時的 CLI 實測結果；到期、`--refresh`、roster 設定或 CLI 身分變動時必須重新驗證。
- Unknown provider outcome 必須先 query reconciliation，不會盲目重試。

## 開發驗證

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
node scripts/plugin-cache.mjs check
```

Runtime 只使用 Node.js standard library。

Plugin cache version 是 immutable。任何內容變更都必須使用新的 build
version；`node scripts/plugin-cache.mjs sync` 只會 stage 尚不存在的版本，
驗證完整 file manifest 與 digest 後原子發布。若同版本內容不同會拒絕原地
覆寫。用正常 Codex plugin refresh 啟用前，還要從最終 cache path 執行
`sbw eval`。

## License

MIT。請參閱 [LICENSE](../LICENSE) 與 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
