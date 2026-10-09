# Better Workflows Core

[English](README.md)

防止 AI coding agent 拿過期的證據宣稱「完成」、在結果不明的副作用之後繼續疊加動作，以及從 prompt 文字取得權限。

狀態：pre-alpha，屬於 [V6 路線圖](../../docs/ROADMAP.zh-TW.md)。下一步是從 hooks 呼叫本套件的 Claude Code plugin。

## 檢查什麼

| 檢查 | 規則 |
| --- | --- |
| 證據 | 測試、lint、typecheck 或建置結果，會綁定執行當下工作目錄的 Git tree（已追蹤的變更加上未被 ignore 的未追蹤檔案）。只有在工作目錄內容完全相同、結果通過、且執行期間沒有檔案變動時才算數。 |
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

Policy 格式見[英文版](README.md#policy)。policy 檔無效時，所有副作用都會被拒絕，不會退回預設值；過期的規則退回 `ask`。

## 限制

- 只看得到 host adapter 交給它的指令，其他途徑產生的副作用不在範圍內。
- Hash chain 能偵測部分竄改，但擋不住對 `.git/` 有寫入權限者整份重寫。由 host adapter 阻止 agent 存取 ledger、policy 檔與 `bw reconcile <id>`。
- 符合 `.gitignore` 的檔案不納入證據 tree。
- 每次檢查都會 hash 整個工作目錄，非常大的 repo 每次呼叫都要付出這個成本。

## 授權

Apache-2.0，見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。
