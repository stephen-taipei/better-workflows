# Better Workflows

[English](../README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

Better Workflows は、Codex 向けのネイティブ優先・証拠駆動ワークフローです。Root だけがコード変更、Git/GitHub 操作、deploy、リスク受容、完了宣言を行い、subagents は調査、Review、テスト証拠、反証を担当します。

## 設計原則

Better Workflows は無制限の agent swarm ではなく、ガバナンスを備えた orchestration layer です。主な原則は次のとおりです。

- **Root-owned mutation：** Root だけが変更、統合、Git/GitHub mutation、deploy、リスク受容、完了宣言を行います。
- **Evidence before side effects：** side effect の前に evidence、freshness、権限、provider reconciliation を要求し、unknown outcome は fail closed にします。
- **Bounded delegation：** native subagents は調査、Review、テスト証拠、反証に限定します。direct children は最大 3 つ、再帰 delegation は禁止し、独立 critics は順番に実行します。
- **Persistent intent：** `/goal` は turn をまたいでユーザーの目標を保持します。template と mode は検証の深さだけを決め、目標を暗黙に変更しません。
- **Deterministic control plane：** `dw` は contract、private state、sentinel、evidence、findings、lease、action token、reconciliation を記録しますが、model が生成した command は実行しません。
- **Explicit completion：** 最新の acceptance evidence、必要なチェック、利用可能な rollback がそろい、高リスクまたは unknown state が残っていない場合だけ完了とします。
- **Fast path remains explicit：** 小さく可逆な作業には `direct` を使い、完全な workflow journal のコストを明示的に省略できます。

この設計は最大の並列スループットの一部を、検査しやすい mutation surface と予測可能な停止条件に交換します。証拠やユーザー権限を待つために停止しても、安全でない進捗が隠れないことを優先します。

## Better Workflows と Claude Dynamic Workflows の比較

ここでいう「Claude Dynamic Workflows」は Anthropic の Claude Code 機能を指し、第三者パッケージを指しません。比較は 2026-07-20 に確認した Anthropic の公開資料、[Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)、[A harness for every task](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)、および [Claude Code の並列 agent ドキュメント](https://code.claude.com/docs/en/agents) に基づきます。

| 観点 | Better Workflows | Claude Dynamic Workflows |
| --- | --- | --- |
| Orchestration | Selector、template、明示的な mode、deterministic local control plane。 | Claude がタスクごとに JavaScript harness を動的に作成し、run を調整します。 |
| 並列処理 | 小さく bounded な native wave：direct children は最大 3、critics は順次実行。 | 大規模 fan-out と長時間実行向け。Anthropic は数十から数百の subagents を並列実行する形を説明しています。 |
| State と完了条件 | Persistent `/goal`、private run state、sentinel、evidence、action token、reconciliation、fail-closed completion。 | workflow progress を保存し、中断後に再開できます。実際の run の形は動的に生成された harness が大きく決めます。 |
| Mutation governance | Root-only mutation/integration。delegated agents は contract 上 read-only。 | subagents、worktree、model 選択、permission control を利用できますが、workflow 自体はタスクごとに動的生成されます。 |
| 適応性 | Runtime freedom は低めですが、side effect 前に Review しやすく、template から再現しやすい設計です。 | Runtime adaptability が高く、作業量が未知、高並列、adversarial verification、多日タスクに向きます。 |
| スループットとコスト | 意図的に保守的。並列 worker が少ないため最大スループットは下がり得ますが、コストと blast radius を管理しやすいです。 | 高いスループットが期待できますが、公式に通常より大幅に token を消費する可能性が示されています。 |
| 可搬性 | Codex-native plugin と Node.js helper。plugin を実行できる repository に適用できます。 | Claude Code CLI、Desktop、VS Code extension、API、対応する cloud providers。 |
| 得意な用途 | Contract-sensitive refactor、Review、release、Git/GitHub 操作など、evidence と rollback を重視する作業。 | 大規模 migration、codebase 全体の探索、大規模 verification、動的 orchestration が主な利点になる作業。 |

### 実務上のトレードオフ

主なリスクが uncontrolled mutation、曖昧な権限、古い evidence、不可逆 side effect の場合、Better Workflows が適しています。明示的な queue、checkpoint、fail-closed gates により、なぜ停止したか、再開にどの reconciliation が必要かを説明しやすくなります。

主なボトルネックが orchestration scale、つまり多数の独立した subtask、長時間実行、動的 loop、大規模 migration の場合、Claude Dynamic Workflows が有利です。ただし Anthropic 自身もすべてのタスクに必要ではなく、token 使用量が大きくなる可能性を説明しています。規模には cost/latency のトレードオフがあります。

両者は異なるものを最適化します。Better Workflows は Codex 内の governed で Review 可能な進捗を、Claude Dynamic Workflows は Claude Code 内で動的に生成される高並列 harness を優先します。

## インストール

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

インストール後、新しい Codex task を開いて Skill catalog を再読み込みしてください。

## Codex での使い方

### Codex CLI

Codex CLI では `@` から始めて `better` を検索し、CLI picker から Better Workflows の skill または入口を選びます。

![Codex CLI Skill picker の Better Workflows](assets/better-workflows-skill-picker-cli.png)

### Codex App

Codex App では `/` から始めて `better` を検索し、App picker から対応する command または skill の入口を選びます。

![Codex App command picker の Better Workflows](assets/better-workflows-skill-picker-app.png)

どちらの画面でも入口を選んで目的を記述するだけです。Picker が `$better-workflows:<name>` を挿入します。`/goal`、template 名、mode 名、model alias を覚える必要はありません。推奨デフォルト：

```text
$better-workflows:auto <達成したい結果を記述>
```

すべての入口は、実作業の前に persistent Goal を作成または継続します。`direct` も同様です。無関係な未完了 Goal がある場合は、上書きせず `/goal edit` または `/goal clear` を案内します。

### すばやい選び方

- 迷った場合：`auto`。
- タスク種別が明確：9 つの task entry から選択。
- 検証強度だけ指定：`direct`、`verified`、`deep`、`critical`。
- 旧コマンドを継続：compatibility alias。

### 自動・タスク入口

| 入口 | 推奨シーン | 例 |
| --- | --- | --- |
| `$better-workflows:auto` | ほとんどのタスクに推奨。リスクと証拠から template、mode、critics を自動選択。 | `$better-workflows:auto 現在の repo を Review し、検証済みの問題を修正して PR を作成。` |
| `$better-workflows:review-issues` | 読み取り専用 audit、finding の重複排除、許可済み GitHub issue 作成。コードは変更しない。 | `$better-workflows:review-issues 最新 dev SHA を Review し、重複のない P0/P1/P2 issues を作成。` |
| `$better-workflows:fix-issues-pr` | Open issues を再確認し Root が修正、PR 作成。許可がある場合のみ merge/cleanup。 | `$better-workflows:fix-issues-pr dev の open issues を修正し、fresh checks 後に merge と cleanup。` |
| `$better-workflows:cross-platform` | Backend、iOS、Android、Web の schema、optional、enum、sync、version gate、headers。 | `$better-workflows:cross-platform backend、iOS、Android の contact sync contract を確認し、修正して PR を作成。` |
| `$better-workflows:ios-static` | ローカル build を避ける Swift/iOS 静的 Review と直列化された `project.pbxproj` 検証。 | `$better-workflows:ios-static build せず iOS 変更を Review し、新規 Swift ファイルの pbxproj 登録を確認。` |
| `$better-workflows:localization` | 多言語更新、特に 41 locales の key 数、順序、正確な scope、地域差。 | `$better-workflows:localization 全 41 locales に keys を追加し、順序が一致することを検証。` |
| `$better-workflows:ci-release` | CI failure、runner queue、直列 deploy、release、遠隔監視、receipt 検証。 | `$better-workflows:ci-release 失敗した PR checks を修正し、直列 dev deploy を監視。` |
| `$better-workflows:browser-qa` | 最新 UI 証拠、screenshots、再現可能な action log が必要な Webwright／simulator QA。 | `$better-workflows:browser-qa signup と contact sync を検証し、screenshot evidence を添付。` |
| `$better-workflows:research` | 証拠駆動調査、設計比較、独立視点、反証。多数決では決めない。 | `$better-workflows:research 3 つの sync architecture を比較・反証し、推奨案を提示。` |
| `$better-workflows:monorepo-refactor` | monorepo 全体を調査し、適格な bounded refactor 提案を直接実装。behavior invariants、validation、rollback evidence を保持します。 | `$better-workflows:monorepo-refactor monorepo を調査し、public contract を変えずに適格な boundary cleanup を実装。` |

### Review 強度入口

| 入口 | 推奨シーン | 例 |
| --- | --- | --- |
| `$better-workflows:direct` | 小さく可逆で明確、速度優先。Goal は使うが workflow journal/critics は使わない。 | `$better-workflows:direct 1 行の documentation typo を修正し diff を確認。` |
| `$better-workflows:verified` | 通常の開発で、1–3 read-only agents と freshness evidence が必要。 | `$better-workflows:verified pagination bug を Review・修正し PR を作成。` |
| `$better-workflows:deep` | Architecture、security、広範囲 refactor、不確実な変更。Verified wave と独立 Codex critics を使用。 | `$better-workflows:deep auth redesign を Review し、検証済み問題を修正して migration-safe PR を作成。` |
| `$better-workflows:critical` | Release、migration、production、破壊的 cleanup、不可逆 side effects。完全な fail-closed gates が必要。 | `$better-workflows:critical policy、remote SHA、reconciliation gates 通過後のみ production release を実行。` |

### Compatibility aliases

| 入口 | 推奨シーン | 対応ルート |
| --- | --- | --- |
| `$better-workflows:auto-improve` | 旧 `autoImprove`：Review、finding 検証、修正、PR、収束。 | Fix issues to PR、既定 `deep` |
| `$better-workflows:auto-issues` | 旧 `autoIssues`：読み取り専用 Review と重複なし issue 作成。 | Review to issues、既定 `verified` |
| `$better-workflows:ai-meeting-tw` | 旧 AI meeting：Claude や投票を使わない多視点調査と model critics。 | Research deliberation、既定 `deep` |
| `$better-workflows:git-check-issues` | 旧 issue repair：状態再取得、修正、PR、正確な cleanup。 | Fix issues to PR、既定 `deep` |
| `$better-workflows` | 特定の入口を選ばない自然言語 router。 | Template と mode を自動判定 |

## モード

| Mode | 動作 |
| --- | --- |
| `direct` | Root が直接作業し、durable workflow state は作らない。 |
| `verified` | Root と 1–3 の read-only research/review/refutation agents。 |
| `deep` | `verified` 後、最大 2 つの Codex critics を直列実行。 |
| `critical` | 完全な evidence/side-effect gates と、policy 必須の外部 reviewer。 |

## 開発・検証

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/dw.mjs eval
```

## License

MIT。[LICENSE](../LICENSE) と [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) を参照してください。
