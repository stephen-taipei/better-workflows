# 路線圖

[English](../ROADMAP.md)

更新日期：2026-10-09

## 專案目前狀態

- **V5 定格在預發行版本。** [V5.0 RC1](https://github.com/stephen-taipei/better-workflows/releases/tag/V5.0.rc1) 仍可安裝；目前的 `main`（41 個公開語系、V5.0 驗收差額）就是 V5 的最終狀態。不再規劃 V5.0 正式版。
- **V5.1 計畫已停止。** 相關 open issue 會以 `not planned` 關閉；分支與歷史紀錄保留供參考。
- **下一版是 V6「Core」。** 只保留 Better Workflows 中「模型越強越需要」的部分。

## V6 Core 做什麼

AI agent 不能拿過期的證據宣稱完成；外部動作結果不明時不能繼續往下做；權限只來自 policy 檔，不來自 prompt 文字。

| 能力 | 保證什麼 |
| --- | --- |
| 證據綁定 | 測試或建置結果只對它實際執行時的那份 repo 內容有效。改了任何檔案，舊的綠燈就不算數。 |
| Action gate | 有副作用的指令（push、merge、release、publish、deploy）必須有 policy 檔授權，而且最多執行一次。 |
| Provider 對帳 | 外部動作逾時或結果不明時，相依的後續動作一律擋下，直到唯讀查詢確認實際結果。 |
| 權限邊界 | 允許的動作、可寫路徑與期限都由 `.better-workflows/policy.json` 決定，prompt 裡的文字無法授權。 |

Claude Code 是第一個支援的工具。透過它的 hooks，Core 能以確定性的方式擋下動作，而不是依賴模型可能忽略的指示。

## 階段

1. **範圍重設**：本路線圖、讓 CI 不再每次 push 都依賴 owner 簽發的 policy、關閉 V5.1 待辦。
2. **Core kernel**：`packages/bw-core`，包含證據、policy、action token、對帳、append-only ledger 與 `bw` CLI。零執行階段依賴，Node 22 以上。
3. **Claude Code plugin**：以 Core 為基礎的 `PreToolUse`、`PostToolUse`、`Stop`、`SessionStart` hooks。
4. **Demo 與文件**：30 秒情境，過期的測試綠燈被拒絕、結果不明的 push 必須先對帳。V6.0 正式版前只提供英文與繁體中文（台灣），正式版後再補其他語系。
5. **Alpha 發行**：可從 Claude Code plugin marketplace 入口與 npm 安裝。
6. **Codex adapter**：在 Codex 擴充機制允許的範圍內提供相同保證。

## 是否繼續的判斷標準

- Alpha 發行後 60 天內：至少一位維護者以外的使用者，在真實 repo 跑完完整流程。
- 90 天內：至少三位外部使用者，其中一位持續使用兩週以上。
- 若 90 天內沒有任何外部使用者跑完流程，Core 停止以產品方式開發，轉為個人使用的 Claude Code plugin。
