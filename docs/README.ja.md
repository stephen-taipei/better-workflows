<div align="center">

# Better Workflows

### Goal-first · 証拠駆動 · Fail-closed

Codex のための統制された workflow orchestration。小さな変更は速く、重要な side effect は厳密に扱います。

| Primitive | 統制対象 | 証拠境界 |
| --- | --- | --- |
| **Prompt** | 成果 | テキストは権限を付与しない |
| **Context** | 入力 | fresh digests が必須 |
| **Harness** | ツール | allowlist 内の producer のみ信頼 |
| **Loop** | 試行 | retry は bounded |
| **Graph** | 状態 | read-only；scheduler や権限元ではない |

機密または private history は収集せず、redacted `REJECTED_WITH_EVIDENCE` disposition で拒否します。

**モデルブランド一覧：** Codex · Claude · Gemini（Antigravity `agy`
経由）· GPT-OSS（`agy` 経由）· Grok · Cursor · Kimi · Qwen · Kiro。
`agy` は transport metadata であり別のモデルブランドではありません。利用可否には最新の semantic roster probe が必要です。

[![Version](https://img.shields.io/badge/version-3.1.11-2563EB?style=flat-square)](../plugins/better-workflows/package.json)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A524-3C873A?style=flat-square)](../plugins/better-workflows/package.json)
[![Dependencies](https://img.shields.io/badge/runtime_dependencies-0-0F766E?style=flat-square)](../plugins/better-workflows/package.json)
[![License](https://img.shields.io/badge/license-MIT-64748B?style=flat-square)](../LICENSE)

[English](../README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md)

</div>

| **概要** | [詳細](details/ja.md) | [クイックスタート](guide/getting-started.md) | [Workflows](guide/workflows.md) | [Architecture](guide/architecture.md) | [Security](guide/security.md) | [CLI](guide/cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

## 重要点を先に確認

| **ROOT が変更を所有** | **ACTION の前に証拠** | **UNKNOWN = STOP** |
| --- | --- | --- |
| 編集、統合、deploy、リスク受容、完了宣言は Root だけが行います。 | Side effect の前に fresh check、provenance、明示 gate が必要です。 | Drift、stale evidence、未知の provider state は fail closed です。 |

| **13 TEMPLATES** | **WORKSPACE RECIPES** | **GRAPH VIEW** |
| --- | --- | --- |
| SOP を暗記せず、成果とリスクから route を選びます。 | 信頼済み Node.js の機械的手順を再実行して token を節約します。 | Typed 構造を検査しますが authority source にはなりません。 |

### Control-plane v2

新しい非 direct template run は typed evidence、append-only execution ledger、
宣言された review policy を使います。completion は承認済み evidence と
replay 状態だけから導出され、文章や caller `acceptanceIds` では完了できません。
Legacy v1 run は v1 reader で読み取り、Graph View は read-only projection のみです。

![Prompt から Graph までの Better Workflows engineering stack](assets/better-workflows-engineering-stack.svg)

| 項目 | **Prompt** | **Context** | **Harness** | **Loop** | **Graph** |
| --- | --- | --- | --- | --- | --- |
| 中心となる問い | 成果と制約は何か？ | 今、何が事実か？ | 誰がどこで何を行えるか？ | 続行、再試行、停止のどれか？ | Records と gates はどう関係するか？ |
| Better Workflows | Goal + TaskContract | Profile + sentinel + evidence | Root + template + `sbw` + trusted recipe | Checkpoint + freshness + reconciliation | Derived typed Graph View |
| 信頼性 | Acceptance と non-goals を明示 | Stale state を拒否 | Root が mutation を所有し、side effect は action token が必要 | 明確な停止条件を持つ bounded progress | 構造エラーは fail closed |
| 意図的な境界 | Prompt は authority ではない | Raw history を暗黙に探索しない | Unbounded dynamic harness を生成しない | Gate なしの loop-until-done を許可しない | Graph は policy input ではない |

## 30 秒で開始

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

新しい Codex task を開き、native picker から Better Workflows を選択します。

```text
Codex CLI: @better
Codex App: /better
```

推奨エントリ：

```text
$better-workflows:auto <必要な成果を記述>
```

Automatic route は具体的な template と最小 verification mode を選びますが、authority の付与、tool の install、scope の拡大はできません。

[インストール、検証、最初の workflow →](guide/getting-started.md)

## 成果から選ぶ

| 必要なこと | 選択 |
| --- | --- |
| Codex に安全な route を選ばせる | `$better-workflows:auto` |
| Repository review と重複排除済み issues | `$better-workflows:review-issues` |
| 修正、PR、merge、owned resource cleanup | `$better-workflows:fix-issues-pr` |
| Atomic commits と `dev` 向け PR | `$better-workflows:pr-to-dev` |
| 複数モデルによる architecture 比較 | `$better-workflows:research` |
| Release や不可逆操作の統制 | `$better-workflows:critical` |
| 反復 SOP を信頼済み Node.js mechanics にする | `$better-workflows:workspace-recipe` |

[全 entries、modes、templates を確認 →](details/ja.md)

## Gemini と `agy`

Google は consumer Gemini CLI を、`agy` で実行する Antigravity CLI へ移行しました。
Better Workflows は `agy` を **transport** として記録し、Gemini、Claude、
GPT-OSS を **model brands** として記録します。Agy を別のモデルブランドとして重複計上しません。

[Architecture、安全境界、全仕様 →](details/ja.md)

## 開発とコミュニティ

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
```

[Contributing](../CONTRIBUTING.md) · [Code of conduct](../CODE_OF_CONDUCT.md) ·
[Security](../SECURITY.md) · [Support](../SUPPORT.md)

MIT。[LICENSE](../LICENSE) を参照してください。
