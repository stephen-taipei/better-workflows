# Better Workflows Core

[English](README.md)

防止 AI coding agent 拿過期的證據宣稱「完成」、在結果不明的副作用之後繼續疊加動作，以及從 prompt 文字取得權限。

狀態：pre-alpha，屬於 [V6 路線圖](../../docs/ROADMAP.zh-TW.md)。第一個 host 是 Claude Code，透過本套件內的 hooks plugin 接入。請從[快速開始](docs/getting-started.zh-TW.md)入手，或執行 [stale-green demo](examples/stale-green/demo.mjs)（`node examples/stale-green/demo.mjs`，約 2 秒，不需要 Claude）。

## 檢查什麼

| 檢查 | 規則 |
| --- | --- |
| 證據 | 測試、lint、typecheck 或建置結果，會綁定執行當下工作目錄的 Git tree（已追蹤的變更加上未被 ignore 的未追蹤檔案）。只有在工作目錄內容完全相同、結果通過、且執行期間沒有檔案變動時才算數。exit code 屬於同一行其他指令的執行（`npm test | tail`、`npm test; echo done`、`npm test || true`）一律不算；請用 `&&` 串接或設定 `pipefail`。 |
| 完成判定 | policy 的 `completion.require` 列出完成前必須有效的證據種類。 |
| Action gate | push、PR merge 與建立、release、套件發佈、`gh api` 寫入、HTTP 寫入，以及自訂種類都算副作用，各自需要 policy 檔的 `allow`；預設是 `ask`。無法看穿效果的指令（command substitution、`eval`、`sh -c`）視為 `opaque`，預設 `ask`。 |
| 最多一次 | 同一個副作用在同一個 commit 成功後，再次執行會被拒絕。 |
| 對帳 | 只有 exit code 0 算已知結果。其他情況一律標為 `unknown`，之後所有副作用都會被拒絕，直到 `bw reconcile` 用唯讀查詢向 provider 確認（`git ls-remote`、`gh pr view`、`gh release view`、`npm view`），或由人附註說明後手動結案。 |
| Ledger | 每筆紀錄寫入 `.git/better-workflows/` 內 append-only、hash chain 串接的 ledger。`bw verify` 能偵測竄改與截斷。 |

## 指令

```bash
bw init                                  # 建立 .better-workflows/policy.json
bw run --kind test -- npm test           # 執行並記錄證據
bw check-completion                      # 必要證據有效回傳 0，否則 2
bw check-command "git push origin main"  # 0 允許、2 拒絕、3 詢問
bw reconcile                             # 向 provider 查詢以結案 unknown 動作
bw reconcile <id> --outcome success --note "已確認部署儀表板"
bw status | bw verify | bw log
```

Policy 格式見[英文版](README.md#policy)。證據的 `argv` 是指令前綴，會加進該種類的內建清單；在證據項目加上 `"exact": true` 則取代該種類的內建清單，且只認在 repo 根目錄執行的完整指令，`pnpm test -- one.spec.ts` 或在單一 workspace package 裡跑的 `pnpm test` 都不會被當成整套測試。`"cwd": "plugins/x"` 可指定其他目錄；同一行的 `cd` 會被追蹤，hook 讀不懂的 `cd`（例如 `cd $DIR`）不算。policy 檔無效時，所有副作用都會被拒絕，不會退回預設值；過期的規則退回 `ask`。

exact 種類還可以宣告 `"scope": ["plugins/x", "shared"]`，也就是這個結果涵蓋的目錄。Git 本來就會替每個目錄各算一個雜湊，所以宣告之後，scope 以外的檔案改動不會讓結果過期，只有 scope 底下有變動才會。預設是整個 tree。要把檢查依賴的目錄全部列進去（包含它 import 的東西）：Core 不建相依圖，漏列一個目錄就會讓舊的通過被算成有效。

`"evidence": { "ignore": ["coverage", "dist"] }` 會把檢查自己寫出的產物排除在 tree 之外，這樣會產生報告的執行不會被當成「執行期間檔案變了」。永遠不該 commit 的產物請優先用 `.gitignore`；`ignore` 是給 repo 有追蹤、或刻意不 ignore 的路徑用的。

`Stop` 把 agent 退回時，訊息會附上這個 session 的狀況：缺的每種證據跑了幾次、跑在幾個不同的檔案狀態上、最近連續失敗幾次，以及這個 session 已被退回幾次。Core 只負責計數，是收斂還是鬼打牆由 agent（或看 `bw status` 的人）判斷。授權不會因為這個判斷而延長：更久或更大的權限只能由人改 policy（`expiresAt`），agent 自己做不到。


## Claude Code

alpha 發佈前，從 checkout 安裝（細節見[快速開始](docs/getting-started.zh-TW.md)）：

```bash
claude plugin marketplace add path/to/better-workflows/packages/bw-core
claude plugin install better-workflows-core@better-workflows --scope local
node path/to/better-workflows/packages/bw-core/bin/bw.mjs init
```

| Hook | 行為 |
| --- | --- |
| `SessionStart` | 記錄起始 tree，並告訴 agent 完成需要哪些證據、哪些副作用仍未結案。 |
| `PreToolUse` | 對 Bash 指令執行 action gate。`deny` 擋下，`ask` 交給權限提示，`allow` 交回 Claude Code 自己的權限規則，絕不多給權限。修改 `.better-workflows/`、`.git/` 以及 `bw init`／`bw reconcile <id>` 一律拒絕。 |
| `PostToolUse`、`PostToolUseFailure` | 記錄 exit code：0 為成功，其他或中斷為 `unknown`。test、lint、typecheck、build 指令同時記錄證據。 |
| `Stop` | session 內檔案有變更但必要證據不新鮮時，把 agent 退回一次並說明缺什麼；第二次只警告。 |
| `SubagentStop` | 結案 subagent 執行期間被人拒絕的副作用。不會退回 subagent：它和主 agent 共用 session，由主 agent 的 `Stop` 把關。 |

在權限提示被拒絕的副作用沒有執行，也不會觸發 `PostToolUse`。只有 session transcript 顯示 Claude Code 的拒絕訊息是該工具的結果時，adapter 才會把它結案為 `failed`；其他缺少結果的情況（包含中斷）一律維持 `unknown`。

## 限制

- 只看得到 host adapter 交給它的指令，其他途徑產生的副作用不在範圍內。
- Hash chain 能偵測部分竄改，但擋不住對 `.git/` 有寫入權限者整份重寫。由 host adapter 阻止 agent 存取 ledger、policy 檔與 `bw reconcile <id>`。
- 符合 `.gitignore` 的檔案不納入證據 tree。
- 每次檢查都會 hash 整個工作目錄，非常大的 repo 每次呼叫都要付出這個成本。`scope` 改變的是比對的範圍，不是雜湊的範圍。
- pull request 與 release 的自動對帳需要已安裝且已登入的 `gh`；policy 用到它而它不能用時，`SessionStart` 會警告。

## 授權

Apache-2.0，見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。
