# Codex adapter（實驗性）

[English](codex.md)

`bw hook codex` 會從 stdin 讀取一筆 JSON 格式的 Codex hook event。在 Git
repository 以外執行時不會介入。Core 會和同一個 worktree 中的 Claude Code
adapter 共用 evidence 與 action gate；Codex adapter 不會代替使用者授予原生工具權限。

## 套件與 hook 契約

根目錄的 `plugin.json` 使用可攜式 Agent Plugins schema。它的
`extensions["com.openai"].hooks` 會選擇 `./hooks/codex.json`，取代預設發現
Claude 專用 `hooks/hooks.json` 的方式。指令會透過 `${PLUGIN_ROOT}` 找到套件內的
CLI。Claude manifests 維持不變。

已註冊的 event 是 `SessionStart`、`PreToolUse`（`Bash|apply_patch`）、
`PostToolUse`（`Bash`）與 `Stop`。沒有註冊 `PermissionRequest` 或
`SubagentStop`。policy 的 `allow` 不會回傳 permission decision；Codex 仍會套用
自己的權限。Codex hooks 不支援 `ask`，因此 Core 會在保留 action 前將它轉成
`deny`，理由是 `Codex hooks cannot ask; change the policy and retry`。

manifest 與 patch payload 依據 2026-10-21 查閱的官方
[plugin packaging](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks)
與 [hooks](https://learn.chatgpt.com/docs/hooks) 文件。Codex 要求使用者檢查並信任
已安裝的 hooks。Hooks 只涵蓋支援的工具路徑，不能取代完整的 sandbox 邊界。

## 完成狀態與不確定結果

Codex CLI 0.163.0 的紀錄顯示，成功與失敗的 shell 呼叫都會帶有空的
`tool_response`。Adapter 會改讀 Codex 提供的 transcript，依 `item.id` 與
`tool_use_id` 配對 `event_msg` → `item_completed` → `CommandExecution`。只有整數
`exit_code` 能確立最終結果；只有 exit 0 能確立成功或通過的 evidence。

如果 completion record 缺少、格式錯誤或無法讀取，Core 會讓呼叫維持 pending，不會
結束 action，也不會寫入 evidence。同一個 host 與 session 的後續 hook 會重試
pending 呼叫，包含只有 evidence 的指令。背景指令可能在不同 turn 完成。關聯依據是
host、session 與 tool-call ID，不是 turn ID。Evidence 會保留指令執行前的 snapshot，
所以中途修改檔案不會讓較早的檢查變成新的通過結果。

只有呼叫有待處理的結果檔，或有對應的 pending action 時，Core 才會在 ledger lock
內為 host/session/tool ID 寫入 `tool.consumed`。沒有待處理工作的唯讀 Bash 呼叫不會新增
marker。重播無法再次保留 action，也不能把舊結果綁到新的 tree，即使後續入帳失敗也
一樣。這筆 marker 只代表呼叫已消耗，不代表 evidence 通過。

Codex 原生權限提示中的中斷與拒絕，無法從 `turn_aborted` event 區分。兩者都不會被
解讀成「指令一定沒執行」。若沒有相符的最終結果，action 會保留給 Core 既有的唯讀
對帳流程。Evidence 與重複 action key 由不同 host 共用；pending 檔案與 session 完成
歷程則依 host 區分。唯讀 probe 開始前，Core 會取得 action status 與最新 history
entry；它只會在同一把 ledger lock 內確認兩者仍符合該 snapshot 後才追加結果。因此，
並行完成或對帳會優先於過期 probe。手動對帳也會在相同 lock 內檢查並追加。
`bw status` 會顯示每個 host 最近一次 session 的開始時間。

provider 的負面查詢結果，不能證明尚無最終結果的指令已停止。這類呼叫會維持
unknown 並阻擋後續副作用；相符的晚到 completion 仍可完成結算。provider 已確認
成功時，保留既有的成功判定。人工結案與 terminal 紀錄不會自動重開，包含舊版 Core
已判定失敗的紀錄。

每個 hook 對每份需要的 transcript 只讀取一次，並建立最終結果索引。同一個呼叫
若有互相矛盾的最終結果，會維持 unknown。Evidence 保留 `toolUseId`，並在 `order`
記錄指令開始前已看到的帳本序號（`startedAfterSeq`）。Codex 另記錄 completion
在 transcript snapshot 中的位置；snapshot 身分包含 host、session、canonical path
及完整內容的 digest。同一 snapshot 的結果可依完成位置排序，即使 hook 晚到也一樣。
不同 snapshot 只有在較早結果已入帳、較晚指令才開始時，才能確立先後。
Core 不會用 pending 檔名或時間戳排序。無法排序或互相矛盾的候選結果會阻擋完成；
結果入帳後，必須重新執行檢查。transcript 增長也可能觸發這個保守重跑要求。
既有紀錄不會改寫；缺少順序資料，不能證明某筆通過結果比較新。所有參與的 host
應一起升級，因為舊版 Core 不會執行這項順序保護。

## 檔案保護與驗證限制

對 `apply_patch`，adapter 會從 `tool_input.command` 讀取 patch，並檢查每個
`*** Add File:`、`*** Update File:`、`*** Delete File:` 與 `*** Move to:` 路徑。
缺少或無法辨識的 header 會被拒絕。Core 會檢查字面上的 `.git` 路徑與解析後的受保護
路徑，範圍包含 symlink、linked worktree 的 Git marker、worktree 專用 Git 目錄及目前
repository 共用的 Git `commonDir`。這是 header scanner，不是 patch parser。

清理過的 Bash fixtures 取自 2026-10-21 Codex CLI recording。測試會在暫存 Git
repository 中重播 fixtures。`apply_patch` payload 格式、可攜式 plugin discovery 與
`Stop` response 依據官方文件或 fixture 撰寫，尚未在 live Codex host 實測。沒有在
`deckhand` 或 `adorable-git-grpah` 啟用 plugin。

每筆新 ledger entry 的最上層格式是
`{ v, seq, at, type, data, prev, hash }`，`v` 也納入 hash。沒有 `v` 的舊紀錄會以版本
1 讀取，並依原本的 hash 驗證，不會改寫。`v` 不是正整數時，Core 會判定 hash chain
損毀。Core 不會把高於 `LEDGER_VERSION` 的 entry 折進 evidence 或 actions，並會回報
最高版本；在升級 Core 前，會拒絕副作用與 opaque 指令，且 completion 一律不通過。
`bw verify` 仍會驗證 chain，並顯示最高版本。Host hook 遇到較新 ledger 版本時，
會保留既有 pending call，不會替這些呼叫追加 ledger 紀錄。

新增的 host/session metadata 與 `tool.consumed` 不需要改寫舊紀錄。舊版 Core 不會執行
新的 consumed-call 防重播保護。host-specific pending 檔名推出前建立的 pending 檔案
不會遷移；升級後要重跑尚未完成的檢查。沒有 `session` 欄位的舊 action record 無法由
`PostToolUse` 結束，會維持開啟並交由對帳處理。
