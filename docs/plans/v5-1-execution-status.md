# V5.1 執行狀態：2026-10-03 公開開發基線歷史快照

快照日期：2026-10-03。此頁為當時公開開發基線與失敗觀察的歷史快照；文中的「本輪」、「目前」與檢查數量均以此日期為觀察界線。不授予執行權限，也不表示 V5.1 或 GA 完成。

## 當前進度與驗收依據

Root 在主總表 [#1](https://github.com/stephen-taipei/better-workflows/issues/1) 與驗收接手表 [#2](https://github.com/stephen-taipei/better-workflows/issues/2) 維護後續進度。當前候選的 commit、正式審查、PR checks、protected merge、部署與發布狀態，須分別以該候選的實際收據及提交／PR 記錄核對。本頁的歷史 PASS、BLOCK 與待提交描述不適用後續候選，也不能取代其驗收。

## 已建立

- 公開 dev 從 `9afb9e119d74ff721fe6e0cb75760a0c32e7de25` 建立；feature PR 整合至 dev，release PR 再至 main。
- dev 保護規則已 GET 讀回：strict required checks、enforce admins、conversation resolution，禁止 force push／deletion。必要 checks 為 `Runtime / Node 22.23.3`、`Runtime / Node 24.21.0`、`test`。
- GitHub approval count 0 適用單一 maintainer 流程；獨立 review 與 Better Workflows 技術 gates 仍需成立。
- 122 張新工作單：114 張 V5.1、8 張 V5.0，均經 title／body／labels 讀回。主總表 [#1](https://github.com/stephen-taipei/better-workflows/issues/1)，驗收與最後接手 [#2](https://github.com/stephen-taipei/better-workflows/issues/2)。
- 舊 90 張 open issues 已追加遷移對照，保持 open；26 張 closed 未修改。原始私有內容與 receipts 另存，未公開原文。
- 102 個 leaf tracking 保留：74 必交、17 決策、9 條件、2 P1 研究。GA obligations 為 100；決策／條件項須有結論，不要求全部啟用。
- 39 個 RC2 locale 身分已分為 12／14／13 組，內容與 rights closure 仍為 HOLD。

## 本機實作與驗證（截至 2026-10-03）

A-17a 的 Root 草案曾將 CLI、boundary、runner 及 checkpoint 上限共用為 32。獨立 Agent 僅提供唯讀建議與 review 摘要，沒有寫入或 implementation dispatch。開始編輯前，A-17a 專用 dispatch packet 與全部前置 receipts 未成立，違反本輪先凍結 packet 再實作的順序；此偏差已由正式 native review 指出，原始 BLOCK 保留。

該草案未准入、未發布，也不算 A-17a 完成。Root 當時已將 runtime／CLI／fixture 草案從工作內容退回 RC1 基準，僅保存為未驗收提案；A-17a 仍為 BLOCKED，待前置與 packet 成立後重新派工。當時候選只保留執行基線、規劃 catalog、治理與文件工作。在此歷史觀察時點，原本機 commit 保留，修正仍為待提交差額；修正後候選尚未取得正式 review。

| 檢查 | 本輪觀察 | 限制 |
|---|---|---|
| 已撤回 A-17a 草案的 CLI／runner／recovery | 歷史 58 tests PASS | 適用原草案，不能用來宣稱目前候選或 A-17a 已驗收 |
| 當時 catalog tests | 25 tests PASS | 檢查 reviewed rows、完整 leaf、契約形狀／digest、排他路徑、READY packet、P1／條件邊界；沒有 runtime authority |
| 公開網站文件 tests | 19 PASS、1 既有 TODO | TODO 為 RC2/source projection 隔離，仍待工作單驗收 |
| policy／Markdown 產物檢查 | PASS | nativeSpeakerReview 未建立；39 延後語系未完成 |
| dev 初始 CI | [run 37112907510](https://github.com/stephen-taipei/better-workflows/actions/runs/37112907510) success | 僅初始 RC1 SHA，不適用新候選 |

正式 native review 的第三次 attempt 使用任務隔離的官方 Codex 0.156.1、gpt-6-luna/max；文件 shard 覆蓋 7/7 後回傳語義 BLOCK，其餘 shard 因 parent abort 取消，aggregate coverage 未完成。第一次 sandbox SQLite 失敗與第二次 0.159.0 版本不相容紀錄均保留；未提高 timeout、改 gate 或用一般摘要代替。

曾修正新測試錯誤預期（CLI exit 2、runner bounded-integer message、研究 leaf 使用分類找出）；原失敗觀察保留在本輪紀錄。未提高 timeout 或改寫產品失敗終態。

## 尚未成立

- 完整 dispatch packet 與 dependency receipts 未凍結的工作保持 BLOCKED；唯讀調查可先行。issue label／catalog digest 不授予 effect。
- 新候選的正式 native review、feature PR checks、protected merge 與 provider reconciliation 未完成。新候選不得引用初始 dev 的 CI success。
- Track A／B／C／D 其餘能力、四層隔離、Windows runtime、Linux／Windows × Node 22／24、E2E、41 語系與 promotion 均須逐單取得 evidence。
- 30 自然日、20 連續適格 starts、3 repositories 的 canary 尚未成立；P1 本機 Shadow 不參與當輪 decision、effect、completion 或 GA。
- RC1 終態保持原狀；本輪未修改 `protectedAdmission=NOT_ESTABLISHED` 或 raw `releaseEligible:false`。

## 保全與接手

R7 原始來源與私有 issue snapshots 由 Root 保存，直到公開成果及來源對照完成。Root 依 [派工 SOP](v5-1-dispatch.md) 凍結每張 packet、序列化共享接線、核對組合 candidate、更新主總表與驗收收據。大型 lifecycle／provider／journal 搬移另排 Root 後續重構，不以任意搬移阻擋 GA；相應功能與安全驗收仍必交。
