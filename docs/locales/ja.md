<div align="center">

# Better Workflows

Better Workflows V5.0 RC1 が一般公開されました。AI エンジニアリング QA とデリバリー向けの無料のオープンソース Auto ワークフローであり、最新の証拠、レビュー gate、プロバイダー照合を備えています。

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · **日本語** · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[ドキュメントを見る](https://betterworkflows.dev/ja/docs/) · [GitHub を開く](https://github.com/stephen-taipei/better-workflows) · [USDT（TRC20）で支援](https://betterworkflows.dev/#sponsor)

</div>

V5.0 RC1 は macOS × Node 22/24 上の Codex、Gemini CLI、Qwen Code をカバーしています。Claude Code、Linux、Windows の検証は V5.1 に延期されます。GA には、少なくとも 30 暦日のカナリア期間、20 回連続の適格な起動、および 3 つの異なるリポジトリが必要です。

## エージェントの仕事を<br>完了を検証できる状態まで導く。

V5.0 RC1 が一般公開されました。Auto が目標、スコープ、リポジトリ、リスクを確認し、的を絞ったチェックまたは evidence ワークフローを選択します。Git の変更にはタスク専用の worktree を使用し、デリバリーには承認と検証済みの外部成果が必要です。

## 意図から完了までを分ける、4 つの明確な境界。

contract を定義し、source と evidence を検証し、外部で生じた結果を照合したうえで、終端状態が判明したときだけ完了を宣言します。

- **01 · `TaskContract`** — V5.0 RC1 が一般公開されました。Auto が目標、スコープ、リポジトリ、リスクを確認し、的を絞ったチェックまたは evidence ワークフローを選択します。Git の変更にはタスク専用の worktree を使用し、デリバリーには承認と検証済みの外部成果が必要です。
- **02 · `evidence`** — Better Workflows V5.0 RC1 が一般公開されました。AI エンジニアリング QA とデリバリー向けの無料のオープンソース Auto ワークフローであり、最新の証拠、レビュー gate、プロバイダー照合を備えています。
- **03 · `reconciliation`** — contract を定義し、source と evidence を検証し、外部で生じた結果を照合したうえで、終端状態が判明したときだけ完了を宣言します。
- **04 · `terminal state`** — コマンドが動いたことは完了の証明ではありません。再検証できる結果こそが証拠です。

## クイックスタート

```bash
codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows
```

```text
$better-workflows:auto <goal>
```

## アーキテクチャマップから実践的なユースケースへ進む。

- [意図から完了までを分ける、4 つの明確な境界。](https://betterworkflows.dev/ja/docs/)
- [クイックスタート](https://betterworkflows.dev/ja/docs/quick/)
- [アーキテクチャマップから実践的なユースケースへ進む。](https://betterworkflows.dev/ja/docs/use-cases/)
- [クイックスタート — アーキテクチャマップから実践的なユースケースへ進む。](https://betterworkflows.dev/ja/docs/use-cases/quick/)
- [エビデンス・シネマ](https://betterworkflows.dev/ja/docs/evidence-cinema/)

### ドキュメントを見る · `ja`

この参照ページの概要は翻訳済みですが、インタラクティブな本文はまだすべて翻訳されていません。

- **01 · 意図から完了までを分ける、4 つの明確な境界。** — contract を定義し、source と evidence を検証し、外部で生じた結果を照合したうえで、終端状態が判明したときだけ完了を宣言します。
- **02 · アーキテクチャマップから実践的なユースケースへ進む。** — V5.0 RC1 が一般公開されました。Auto が目標、スコープ、リポジトリ、リスクを確認し、的を絞ったチェックまたは evidence ワークフローを選択します。Git の変更にはタスク専用の worktree を使用し、デリバリーには承認と検証済みの外部成果が必要です。
- **03 · クイックスタート** — Better Workflows V5.0 RC1 が一般公開されました。AI エンジニアリング QA とデリバリー向けの無料のオープンソース Auto ワークフローであり、最新の証拠、レビュー gate、プロバイダー照合を備えています。

- [`意図から完了までを分ける、4 つの明確な境界。`](https://betterworkflows.dev/docs/reference/ja/index.html) · `ja`
- [`クイックスタート`](https://betterworkflows.dev/docs/reference/ja/preview.html) · `ja`
- [`アーキテクチャマップから実践的なユースケースへ進む。`](https://betterworkflows.dev/docs/reference/ja/use-cases/index.html) · `ja`
- [`クイックスタート — アーキテクチャマップから実践的なユースケースへ進む。`](https://betterworkflows.dev/docs/reference/ja/use-cases/preview.html) · `ja`
- [`エビデンス・シネマ`](https://betterworkflows.dev/docs/reference/ja/evidence-cinema/index.html) · `ja`

- [ドキュメントを見る · `ja`](../details/ja.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### ドキュメントを見る · `en`



### ドキュメントを見る · `ja`

- [セキュリティポリシー](ja/security.md) · `ja`
- [貢献について](ja/contributing.md) · `ja`
- [ガバナンス](ja/governance.md) · `ja`
- [行動規範](ja/conduct.md) · `ja`
- [第三者に関する告知](ja/notices.md) · `ja`
- [README品質設計指針](ja/readme-quality.md) · `ja`
- [エディトリアル・カラーシステム](ja/color-system.md) · `ja`
- [アーキテクチャ](ja/architecture.md) · `ja`
- [セキュリティ](ja/security-guide.md) · `ja`
- [CLI リファレンス](ja/cli-reference.md) · `ja`
- [はじめに](ja/getting-started.md) · `ja`
- [ワークフロー](ja/workflows.md) · `ja`
- [サポート](ja/support.md) · `ja`

## Better Workflows の継続的なメンテナンスを支えてください。

一度限りの支援は、オープンソースの保守、ドキュメント、41 ロケール向けのローカライズ版、Web サイト運営に役立ちます。会員資格、roadmap、サポートの優先権を購入するものではありません。

[USDT（TRC20）で支援](https://betterworkflows.dev/#sponsor)

---

コマンドが動いたことは完了の証明ではありません。再検証できる結果こそが証拠です。
