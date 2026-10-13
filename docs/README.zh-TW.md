<div align="center">

<img src="html/assets/better-workflows-mark.svg" alt="Better Workflows" width="80">

# Better Workflows

**AI coding agent 不能拿過時的綠燈宣稱完成，也不能在副作用結果不明時重複執行或繼續疊加。**

[![Core](https://img.shields.io/badge/V6_Core-alpha-B45309?style=flat-square)](../packages/bw-core)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A522.14.0-3C873A?style=flat-square)](../packages/bw-core/package.json)
[![Core license](https://img.shields.io/badge/Core_license-Apache--2.0-64748B?style=flat-square)](../packages/bw-core/LICENSE)

[English](../README.md) · **繁體中文（台灣）**

</div>

## 它擋下什麼

```text
agent  執行 npm test                  → 通過
agent  修改 src/sum.ts                → 改壞了
agent  「完成了，測試都通過。」
bw     ✗ Stop 被擋下。test: last result was for an older tree; files changed since then.

agent  git push origin main           → push 已到達 remote，但呼叫逾時
agent  git push origin main           （重試）
bw     ✗ 拒絕。git-push: the same action already succeeded at this commit.
```

agent 只能依據「現在的檔案」與「provider 實際發生的事」宣稱結果。權限只來自 agent 不能修改的 policy 檔，不來自 prompt 文字。

不需要 Claude，幾秒鐘就能看到這兩個故事實際跑一次：

```bash
npm install -g @better-workflows/core@alpha
node "$(npm root -g)/@better-workflows/core/examples/stale-green/demo.mjs"
```

## 安裝到 Claude Code

```bash
claude plugin marketplace add stephen-taipei/better-workflows
claude plugin install better-workflows-core@better-workflows --scope local
bw init
```

marketplace 每台機器加一次；後兩行在你的 repository 裡執行。`bw init` 會寫出 `.better-workflows/policy.json`。

接著請 Claude Code 做一個改動，並告訴它不要跑測試：它要結束時會被退回。policy 設定、結果不明時的處理與限制，請見[快速開始](../packages/bw-core/docs/getting-started.zh-TW.md)。Core 目前是 alpha（`6.0.0-alpha.1`）、Apache-2.0、沒有 runtime 相依套件。方向與里程碑見[路線圖](ROADMAP.zh-TW.md)。


## 其他語言

[English](../README.md) 以及其他 40 種語言的介紹頁列在[英文 README](../README.md#other-languages)。每頁都是從同一份 catalog 產生的 V6 簡介；英文與繁體中文（台灣）經人工審閱，其他語系為機器翻譯，以英文 README 為準。詳見[在地化政策](LOCALIZATION.md)。

## 參與貢獻與取得協助

```bash
npm test --prefix packages/bw-core
```

[Contributing](../CONTRIBUTING.md) · [Code of conduct](../CODE_OF_CONDUCT.md) · [Governance](../GOVERNANCE.md) · [Support](../SUPPORT.md) · [Security policy](../SECURITY.md)

單次 [USDT (TRC20) 贊助](https://betterworkflows.dev/#sponsor)將用於開源維護、文件與網站託管；不包含會員資格，也不提供 roadmap 或技術支援優先權。

**USDT · TRON (TRC20)** · `TGuMUi1d8MoBQcuFrGJZnu4JrbaeP3wy9a`

<img src="html/assets/sponsor-usdt-trc20.jpeg" alt="USDT (TRC20) QR: TGuMUi1d8MoBQcuFrGJZnu4JrbaeP3wy9a" width="160">

## V5

V5 定格在 [RC1](https://github.com/stephen-taipei/better-workflows/releases/tag/V5.0.rc1)，V5.1 已停止（2026-10-09）。V5 的原始碼、指南與各語系參考文件原封不動保留在 [`frozen/v5`](https://github.com/stephen-taipei/better-workflows/tree/frozen/v5) 分支，供既有使用者使用。

由 [stephen-taipei](https://github.com/stephen-taipei) 維護。`packages/bw-core` 的 V6 Core 依自己的 [LICENSE](../packages/bw-core/LICENSE) 採 Apache-2.0；repo 其餘部分採 AGPL-3.0-only（[LICENSE](../LICENSE)）。請見 [COPYRIGHT](../COPYRIGHT) 與 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
