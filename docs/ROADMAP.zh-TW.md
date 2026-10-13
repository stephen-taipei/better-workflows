# 路線圖

[English](../ROADMAP.md)

更新日期：2026-10-13

## 專案目前狀態

- **V6 Core alpha 已發佈。** [`6.0.0-alpha.2`](../packages/bw-core/CHANGELOG.md) 可從本 repository 的 Claude Code plugin marketplace 與 npm 安裝。beta 之前 policy 格式仍可能調整。
- **自用持續進行。** 2026-10-12 起在維護者的兩個 repository 上運作；第一次檢視真擋與誤擋在 2026-10-26。
- **V5 已凍結。** 位於 [`frozen/v5`](https://github.com/stephen-taipei/better-workflows/tree/frozen/v5) 分支，[V5.0 RC1](https://github.com/stephen-taipei/better-workflows/releases/tag/V5.0.rc1) 仍可安裝。V5.1 計畫已停止。

## V6 Core 做什麼

AI agent 不能拿過期的證據宣稱完成；外部動作結果不明時不能繼續往下做；權限只來自 policy 檔，不來自 prompt 文字。

| 能力 | 保證什麼 |
| --- | --- |
| 證據綁定 | 測試或建置結果只對它實際執行時的那份 repo 內容有效。改了任何檔案，舊的綠燈就不算數。 |
| Action gate | 有副作用的指令（push、merge、release、publish、deploy）必須有 policy 檔授權，而且最多執行一次。 |
| Provider 對帳 | 外部動作逾時或結果不明時，相依的後續動作一律擋下，直到唯讀查詢確認實際結果。 |
| 權限邊界 | 允許的動作與期限都由 `.better-workflows/policy.json` 決定（agent 不得修改），prompt 裡的文字無法授權。 |

Claude Code 是第一個支援的工具。透過它的 hooks，Core 能以確定性的方式擋下動作，而不是依賴模型可能忽略的指示。

## 階段

1. **範圍重設**（完成）：本路線圖、CI 只跑 Core、關閉 V5.1 待辦。
2. **Core kernel**（完成）：`packages/bw-core`，包含證據、policy、action token、對帳、append-only ledger 與 `bw` CLI。零執行階段依賴，Node 22.14 以上。
3. **Claude Code plugin**（完成）：以 Core 為基礎的 `SessionStart`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Stop`、`SubagentStop` hooks。
4. **Demo 與文件**（完成）：幾秒鐘的情境，過期的測試綠燈被拒絕、結果不明的 push 必須先對帳。指南提供英文與繁體中文（台灣）；README 與官網提供 41 種語言，其中 39 種為機器翻譯。
5. **Alpha 發行**（目前）：`6.0.0-alpha.2`，可從 plugin marketplace 與 npm 安裝。
6. **Beta**：自用期證明真的擋下錯誤、而且誤擋夠少之後，凍結 policy 格式。
7. **正式版 `6.0.0`**：以下條件全部成立才發佈：
   - 沒有已知 bug 會讓 agent 把不該算數的證據算數，或讓副作用重複執行、疊加執行。
   - Beta 在維護者的 repository 上至少跑滿四週，沒有未修的誤擋 bug。
   - 至少一位維護者以外的人，在真實 repository 上跑完整個流程。
   - Beta 之後 policy 格式沒有再改。
8. **更多 host**：Codex 等以小型 adapter 支援，範圍以各自的擴充機制為限。正式版不需要等這一項。

## 是否繼續的判斷標準

- 從 `6.0.0-alpha.1` 發佈起算。
- 60 天內：至少一位維護者以外的使用者，在真實 repo 跑完完整流程。
- 90 天內：至少三位外部使用者，其中一位持續使用兩週以上。
- 若 90 天內沒有任何外部使用者跑完流程，Core 停止以產品方式開發，轉為個人使用的 Claude Code plugin。
