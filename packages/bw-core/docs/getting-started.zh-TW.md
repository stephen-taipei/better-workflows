# Better Workflows Core 快速開始

[English](getting-started.md)

Better Workflows Core 讓 Claude Code 的 agent 不能拿「已經對不上目前檔案」的測試結果宣稱完成，也不能在外部動作結果沒有回來時重複執行或繼續疊加副作用。本文帶你從一個乾淨的 repository 走到第一次攔截，只需要幾分鐘。

狀態：pre-alpha。alpha 發佈前，Core 從 Git checkout 安裝。

## 需求

- Node.js 22.14 以上
- Git
- 支援 plugin 的 Claude Code（`claude plugin --help` 可以執行）

## 1. 不需要 Claude 先看效果（約 2 秒）

```bash
git clone --depth 1 https://github.com/stephen-taipei/better-workflows ~/.better-workflows
node ~/.better-workflows/packages/bw-core/examples/stale-green/demo.mjs
```

demo 會建立一個用完即丟的 repository，送出與 Claude Code 完全相同的 hook 事件，依序呈現：

1. 測試通過後又改了檔案：不能完成，因為通過的那次是在舊檔案上跑的。
2. 在新檔案上測試失敗：仍然不能完成。在最終檔案上通過：放行。
3. push 已經到達 remote 但呼叫逾時：重試會被拒絕，不會 push 兩次。
4. 部署逾時，且沒有任何方式能讀回它是否成功：之後的副作用都被拒絕，直到有人確認並結案。

任何一步行為不符，demo 會以 exit code 1 結束。

## 2. 安裝 plugin

每台機器做一次：

```bash
claude plugin marketplace add ~/.better-workflows/packages/bw-core
```

接著在每個要保護的 repository 裡：

```bash
claude plugin install better-workflows-core@better-workflows --scope local
node ~/.better-workflows/packages/bw-core/bin/bw.mjs init
```

`--scope local` 只在這個 repository 啟用 plugin，設定寫在 Git 不追蹤的 `.claude/settings.local.json`。`bw init` 會寫出 `.better-workflows/policy.json`。請把 policy 檔 commit 進去：agent 的權限只來自這個檔案，而且 agent 不能修改它。

## 3. 第一次攔截

在這個 repository 啟動 Claude Code，請它做一個小改動，並告訴它不要跑測試。它要結束時，Stop hook 會把它退回一次：必要的 `test` 證據對不上目前的檔案。agent 接下來會去跑測試，或明確說出測試沒有跑。

隨時可以查看狀態：

```bash
node ~/.better-workflows/packages/bw-core/bin/bw.mjs status
```

小技巧：`alias bw="node ~/.better-workflows/packages/bw-core/bin/bw.mjs"`。

## 4. 告訴它你的檢查與副作用

預設 policy 要求通過 `test` 才算完成，並且每個副作用都先詢問。常見指令（`npm test`、`pnpm test`、`pytest`、`go test`、`cargo test` 等）會被認成測試。也可以自行加入：

```json
{
  "version": 1,
  "completion": { "require": ["test", "lint"] },
  "evidence": { "kinds": [{ "kind": "lint", "argv": [["pnpm", "lint:ci"]] }] },
  "actions": {
    "default": "ask",
    "rules": { "git-push": "allow", "package-publish": "deny" },
    "custom": [{ "kind": "deploy", "argv": [["./deploy.sh"]] }]
  }
}
```

- `allow` 交回 Claude Code 自己的權限規則，絕不給出比 Claude Code 原本更多的權限。
- `ask` 交給 Claude Code 的權限提示。
- `deny` 直接擋下。
- 規則可以設期限：`{ "decision": "allow", "expiresAt": "2026-12-31T00:00:00Z" }`，過期後退回 `ask`。
- policy 檔格式錯誤時，所有副作用都會被擋，直到修好為止。

## 5. 副作用結果不明時

只有 exit code 0 算成功。逾時、中斷或其他 exit code 都會讓該動作成為 `unknown`，之後的副作用一律被拒絕。下一個副作用執行前，hook 會用唯讀查詢（`git ls-remote`、`gh pr view`、`gh release view`、`npm view`）確認 push、pull request、release 與 npm 發佈，能確認的就自動結案。

讀不回結果的動作（例如自訂的部署）需要由人確認：

```bash
bw status                      # 列出未結案動作與它的 id
bw reconcile act_… --outcome success --note "已檢查部署紀錄"
```

agent 不能執行 `bw reconcile <id>` 或 `bw init`，也不能修改 `.better-workflows/` 或 `.git/`。

## 關閉

```bash
claude plugin uninstall better-workflows-core@better-workflows --scope local
```

ledger 會留在 `.git/better-workflows/`，直到你自行刪除。

## 限制

- 只看得到 Claude Code 交給 hooks 的指令。agent 執行的腳本內部產生的副作用（例如會 push 的 `release.sh`）看不到，除非 policy 把該腳本列為自訂動作。
- 證據涵蓋已追蹤與未追蹤、且未被 Git 忽略的檔案。
- 每次檢查都會雜湊整個工作目錄，非常大的 repository 每次呼叫都要付出這個成本。
