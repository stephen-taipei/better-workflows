<!-- Generated from docs/guide/getting-started.md; source-sha256: f133cee692e9577917690ea23d8e67a3bd603237406ebe65ae9c9ef056d91af6; edit docs/rc1-catalogs/onboarding/*.json. -->
# はじめに

[English](../en/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [繁體中文（台灣）](../zh-Hant-TW/getting-started.md) · [繁體中文（香港）](../zh-Hant-HK/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [Tiếng Việt](../vi/getting-started.md) · [Українська](../uk/getting-started.md) · [Türkçe](../tr/getting-started.md) · [ไทย](../th/getting-started.md) · [Svenska](../sv/getting-started.md) · [Slovenčina](../sk/getting-started.md) · [Русский](../ru/getting-started.md) · [Română](../ro/getting-started.md) · [Português](../pt/getting-started.md) · [Português \(Brasil\)](../pt-BR/getting-started.md) · [Polski](../pl/getting-started.md) · [Nederlands](../nl/getting-started.md) · [Norsk bokmål](../nb/getting-started.md) · [မြန်မာ](../my/getting-started.md) · [Bahasa Melayu](../ms/getting-started.md) · [ລາວ](../lo/getting-started.md) · [한국어](../ko/getting-started.md) · [ខ្មែរ](../km/getting-started.md) · **日本語** · [Italiano](../it/getting-started.md) · [Bahasa Indonesia](../id/getting-started.md) · [Magyar](../hu/getting-started.md) · [Hrvatski](../hr/getting-started.md) · [हिन्दी](../hi/getting-started.md) · [עברית](../he/getting-started.md) · [Français](../fr/getting-started.md) · [Filipino](../fil/getting-started.md) · [Suomi](../fi/getting-started.md) · [Español](../es/getting-started.md) · [Español \(México\)](../es-MX/getting-started.md) · [Ελληνικά](../el/getting-started.md) · [Deutsch](../de/getting-started.md) · [Dansk](../da/getting-started.md) · [Čeština](../cs/getting-started.md) · [Català](../ca/getting-started.md) · [العربية](../ar/getting-started.md)

V5\.0 RC1 は macOS × Node 22\/24 上の Codex、Gemini CLI、Qwen Code をカバーしています。Claude Code、Linux、Windows の検証は V5\.1 に延期されます。GA には、少なくとも 30 暦日のカナリア期間、20 回連続の適格な起動、および 3 つの異なるリポジトリが必要です。

| [概要](../../../README.md) | [詳細](../../../docs/details/en.md) | **クイックスタート** | [ワークフロー](workflows.md) | [アーキテクチャ](architecture.md) | [セキュリティ](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

[41 ロケール版の概要と公式ウェブのアクセス先](../../../docs/LANGUAGES.md)。コマンドと識別子は、標準の英語表記を維持します。

V5\.0 RC1（`5.0.0-rc.1`、タグ `V5.0.rc1`）が一般公開されました。リリース対象は Auto のみで、macOS 上の Node 22\/24 における Codex、Gemini CLI、Qwen Code を対象としています。Linux および Windows の検証は、Claude Code の検証と同様に V5\.1 に延期されます。GA `5.0.0` は、少なくとも 30 日間の自然なカナリア運用日数、20 回の連続した適格な開始、および 三つの異なるリポジトリが記録されるまで保留されます。

## 必要条件

- 同梱の `sbw` ヘルパー用の Node\.js 22\.14 以降。
- 信頼できるローカルリポジトリ。Better Workflows は悪意のあるリポジトリコードをサンドボックス化することは保証しません。

v4 の状態ルートは、特定の AI エージェント実行環境に依存しません。`SBW_STATE_ROOT` が設定されていれば最優先で使用し、次に `XDG_STATE_HOME/better-workflows`、それ以外は `~/.better-workflows` を使用します。既定の場所は、もはや `CODEX_HOME` の下ではありません。既存の v3 Codex の状態を移動せずに使い続けるには、`SBW_STATE_ROOT` を、その状態がある正確な `<CODEX_HOME>/sbw` ディレクトリに明示的に設定してから `sbw` を呼び出してください。

V5\.0 GA（`5.0.0`）は保留中です。以下のインストールコマンドは、一般公開されている V5\.0 RC1（`5.0.0-rc.1`、タグ `V5.0.rc1`）を対象としています。

## インストール

### Codex — 推奨リファレンス環境

```bash
# Install the publicly available V5.0.rc1 release candidate.
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
node plugins/better-workflows/scripts/sbw.mjs version --json
node plugins/better-workflows/scripts/sbw.mjs update status --json
# Before the first check, status is unknown. Choose one update mode; manual is
# the default. off disables network access even for an explicit check, while an
# explicit check can query manual or automatic mode without the 24-hour throttle.
node plugins/better-workflows/scripts/sbw.mjs update configure --mode off
node plugins/better-workflows/scripts/sbw.mjs update configure --mode manual
node plugins/better-workflows/scripts/sbw.mjs update configure --mode automatic
node plugins/better-workflows/scripts/sbw.mjs update check --json
# automatic is opt-in, interactive-only, best effort, and at most once/24h;
# success and failure both consume the slot. Automatic checks are skipped in CI,
# --json, and non-interactive paths. It never auto-installs; only fixed public
# metadata is used.
```

インストール後に新しい Codex タスクを開き、スキルカタログを更新してください。

### Gemini CLI

```bash
# Install the publicly available V5.0.rc1 release candidate.
gemini extensions install https://github.com/stephen-taipei/better-workflows \
  --ref V5.0.rc1
```

Gemini CLI は拡張機能をコピーします。インストール後はセッションを再起動してください。後で更新するには `gemini extensions update better-workflows` を使用します。

拡張機能のコンテキストは、自身が読み込まれたソースパスを基準にブリッジを解決し、プロジェクトの作業ディレクトリは基準にしません。標準のユーザースコープのインストールでは、同等の手動確認は次のとおりです：

```bash
SBW_GEMINI_ROOT="$HOME/.gemini/extensions/better-workflows"
node "$SBW_GEMINI_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor gemini-cli
```

リンクされた拡張機能やワークスペーススコープの拡張機能では、AI エージェント実行環境が示す正確な拡張機能ルートを使用してください。名前が似たチェックアウトで代用しないでください。

### Qwen Code

拡張機能のローカルコピーをインストールする前に、リリースを固定してください：

```bash
# Install the publicly available V5.0.rc1 release candidate.
git clone --branch V5.0.rc1 --depth 1 \
  https://github.com/stephen-taipei/better-workflows.git
qwen extensions install ./better-workflows
```

Qwen Code も拡張機能をコピーするため、インストール後はセッションを再起動し、以後の更新には `qwen extensions update better-workflows` を使用してください。

標準のユーザースコープのインストールでは、同等の手動ブリッジ確認は次のとおりです：

```bash
SBW_QWEN_ROOT="$HOME/.qwen/extensions/better-workflows"
node "$SBW_QWEN_ROOT/plugins/better-workflows/scripts/sbw.mjs" \
  host doctor qwen-code
```

リンク形式またはワークスペーススコープでのインストールにも、正確なルートを使用する同じ規則が適用されます。

## Auto を使用する

```text
$better-workflows:auto Review this repository, fix verified defects, and create a PR.
```

すべてのエントリーポイントは、要求された Goal を維持します。無関係な進行中の Goal は明示的に編集またはクリアする必要があり、暗黙のうちに置き換えられることはありません。

## 経路をプレビューする

機能スナップショットは読み取り専用で、プロバイダーへのログインやモデルの意味的な動作を確認するプローブを開始しません：

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor --capabilities

node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Consolidate dependency updates" \
  --scope . \
  --entry auto \
  --domain maintenance \
  --tag dependabot
```

レビュー可能な引き継ぎのために、非公開で一度だけ使用できる検証可能な記録を一件作成して使用してください：

```bash
node plugins/better-workflows/scripts/sbw.mjs route preview \
  --goal "Refactor without changing public contracts" \
  --scope . \
  --entry auto \
  --record

node plugins/better-workflows/scripts/sbw.mjs run \
  --route-receipt <route-receipt-id>
```

記録は 24 時間後に失効します。再使用した場合や、ワークスペース、スコープ、Profiles、カタログ、機能、プラグインバンドルにずれが生じた場合は操作を拒否し、不確かなまま続行を許可することはありません。

## インストールを検証する

```bash
node plugins/better-workflows/scripts/sbw.mjs doctor
node plugins/better-workflows/scripts/sbw.mjs host list
node plugins/better-workflows/scripts/sbw.mjs host doctor <host-id>
node plugins/better-workflows/scripts/sbw.mjs host conformance <host-id>
node plugins/better-workflows/scripts/sbw.mjs graph validate
node plugins/better-workflows/scripts/sbw.mjs eval
```

## リポジトリを変更する前に

Auto は、読み取り専用のワークスペース事前確認から始めます：

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace preflight \
  --intent modify \
  --integration-target <local-branch>
```

Git を使わないタスクと読み取り専用タスクでは、ワークツリーを作成しません。変更を行う Git タスクは、タスクが所有する `TaskWorkspaceLeaseV1` を作成または再使用する必要があります。ソースの作業ディレクトリに未コミットの変更があれば、stash、コピー、コミット、ワークツリー作成のいずれを行うよりも前に停止します。HEAD が分離状態の場合や対象が存在しない場合は、明示的な統合先が必要です。保護された対象やリモートの対象は、ガバナンス規則に従う PR デリバリーに移行します。

Codex または別の AI エージェント実行環境が、現在のタスク用にクリーンなワークツリーをすでに作成している場合は、入れ子のワークツリーを作成せず、編集前に既存のワークツリーを登録してください：

```bash
node plugins/better-workflows/scripts/sbw.mjs workspace register \
  --task-id <task-id> \
  --base-revision <exact-40-character-sha> \
  --integration-target <local-branch> \
  --source-checkout <separate-clean-checkout>
```

登録には、変更されていない基点を指す別個の `codex/*` タスクブランチ、同じ Git 共通ディレクトリ、クリーンなソースチェックアウトが必要です。Better Workflows はそのワークツリーを使用しますが、クリーンアップ時には実行環境が所有するブランチとパスを維持します。保護された対象では、まず証拠ワークフローを実行し、そのワークフローの正確な PR マージとリモート同期の検証可能な記録を `workspace reconcile --run-id <run-id>` で結び付けてください。

次へ：[適切なワークフローの選択](workflows.md) または[CLI リファレンス](cli-reference.md) を参照してください。
