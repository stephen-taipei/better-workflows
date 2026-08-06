<div align="center">

# Better Workflows

### Goal-first · 證據驅動 · Fail-closed

Codex 的受治理工作流編排：小改動保持快速，重要 side effects 保持嚴謹。

| Primitive | 治理內容 | 證據邊界 |
| --- | --- | --- |
| **Prompt** | 成果 | 文字不授予權限 |
| **Context** | 輸入 | 必須有 fresh digests |
| **Harness** | 工具 | 只信任 allowlisted producers |
| **Loop** | 嘗試 | 重試保持有界 |
| **Graph** | 狀態 | 唯讀；不是 scheduler 或授權來源 |

絕不擷取敏感或私人歷史；只能以經遮蔽的 `REJECTED_WITH_EVIDENCE` disposition 拒絕。

**模型品牌名單：** Codex · Claude · Gemini（透過 Antigravity `agy`）·
GPT-OSS（透過 `agy`）· Grok · Cursor · Kimi · Qwen · Kiro。`agy` 是
transport metadata，不是另一個模型品牌；是否可用仍須通過最新 semantic roster probe。

[![Version](https://img.shields.io/badge/version-3.1.0-2563EB?style=flat-square)](../plugins/better-workflows/package.json)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A524-3C873A?style=flat-square)](../plugins/better-workflows/package.json)
[![Dependencies](https://img.shields.io/badge/runtime_dependencies-0-0F766E?style=flat-square)](../plugins/better-workflows/package.json)
[![License](https://img.shields.io/badge/license-MIT-64748B?style=flat-square)](../LICENSE)

[English](../README.md) · **繁體中文** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

</div>

| **概覽** | [詳細說明](details/zh-TW.md) | [快速開始](guide/getting-started.md) | [工作流](guide/workflows.md) | [架構](guide/architecture.md) | [安全](guide/security.md) | [CLI](guide/cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

## 先看最重要的部分

| **ROOT 掌握修改權** | **ACTION 前必須有證據** | **UNKNOWN = STOP** |
| --- | --- | --- |
| 只有 Root 能修改、整合、部署、接受風險與宣告完成。 | Side effect 前必須有新鮮檢查、provenance 與明確 gate。 | Drift、過期證據或未知 provider 狀態一律 fail closed。 |

| **13 個 TEMPLATES** | **WORKSPACE RECIPES** | **GRAPH VIEW** |
| --- | --- | --- |
| 依成果與風險選路線，不必背誦 SOP。 | 將可信任的 Node.js 機械步驟重複執行，節省 token。 | 檢查 typed 結構，但永遠不成為 authority source。 |

### Control-plane v2

新的非 direct template run 使用 typed evidence、append-only execution ledger
與宣告的 review policy；completion 只接受已核准證據與 replay 狀態，文字或
caller `acceptanceIds` 都不能直接完成 task。Legacy v1 run 仍由 v1 reader
讀取，不會被自動重新解釋；Graph View 只呈現唯讀 task/dependency projection。

![Better Workflows 從 Prompt 到 Graph 的工程分層](assets/better-workflows-engineering-stack.svg)

| 項目 | **Prompt** | **Context** | **Harness** | **Loop** | **Graph** |
| --- | --- | --- | --- | --- | --- |
| 核心問題 | 要達成什麼成果與限制？ | 現在有哪些可信事實？ | 誰能在哪裡做什麼？ | 應繼續、重試或停止？ | Records 與 gates 如何關聯？ |
| Better Workflows | Goal + TaskContract | Profile + sentinel + evidence | Root + template + `sbw` + trusted recipe | Checkpoint + freshness + reconciliation | 衍生 typed Graph View |
| 可靠性 | 明確 acceptance 與 non-goals | 拒絕過期狀態 | Root 掌握 mutation；side effect 需要 action token | 有界推進與明確停止條件 | 結構錯誤 fail closed |
| 刻意邊界 | Prompt 不是 authority | 不偷偷挖掘 raw history | 不產生無界動態 harness | 不允許無 gate 的 loop-until-done | Graph 永遠不是 policy input |

## 30 秒開始

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

開啟新的 Codex task，從原生 picker 選擇 Better Workflows：

```text
Codex CLI: @better
Codex App: /better
```

建議從這裡開始：

```text
$better-workflows:auto <描述你要的成果>
```

Automatic route 會選出一個具體 template 與最低驗證 mode，但不能自行授權、安裝工具或擴大 scope。

[安裝、驗證並執行第一個工作流 →](guide/getting-started.md)

## 依成果快速選擇

| 你需要…… | 選擇 |
| --- | --- |
| 讓 Codex 選擇安全且合適的路線 | `$better-workflows:auto` |
| Review repository 並建立去重 issues | `$better-workflows:review-issues` |
| 修正、建立 PR、merge 並清理 owned resources | `$better-workflows:fix-issues-pr` |
| Atomic commits 並交付 PR 到 `dev` | `$better-workflows:pr-to-dev` |
| 多模型比較架構並產生可執行方案 | `$better-workflows:research` |
| 管理 release 或不可逆操作 | `$better-workflows:critical` |
| 將重複 SOP 固化為可信 Node.js mechanics | `$better-workflows:workspace-recipe` |

[查看完整 entries、modes 與 templates →](details/zh-TW.md)

## Gemini 與 `agy`

Google 已將 consumer Gemini CLI 遷移到以 `agy` 執行的 Antigravity CLI。
Better Workflows 因此將 `agy` 記錄為 **transport**；Gemini、Claude 與
GPT-OSS 才是它可承載的 **model brands**。Agy 不會再被重複算成另一個模型品牌。

[查看架構、安全邊界與完整規格 →](details/zh-TW.md)

## 開發與社群

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
```

[Contributing](../CONTRIBUTING.md) · [Code of conduct](../CODE_OF_CONDUCT.md) ·
[Security](../SECURITY.md) · [Support](../SUPPORT.md)

MIT。請參閱 [LICENSE](../LICENSE)。
