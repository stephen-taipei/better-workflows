<div align="center">

# Better Workflows

AI agent がリスクに応じて検証強度を選び、隔離環境で安全に作業を完了します。 単純な変更は素早く完了し、重要な作業は evidence gate を通し、Git 変更は既定で専用 worktree を使います。

[English](en.md) · [繁體中文](zh-Hant.md) · [繁體中文（台灣）](zh-Hant-TW.md) · [繁體中文（香港）](zh-Hant-HK.md) · [简体中文](zh-Hans.md) · [Tiếng Việt](vi.md) · [Українська](uk.md) · [Türkçe](tr.md) · [ไทย](th.md) · [Svenska](sv.md) · [Slovenčina](sk.md) · [Русский](ru.md) · [Română](ro.md) · [Português](pt.md) · [Português (Brasil)](pt-BR.md) · [Polski](pl.md) · [Nederlands](nl.md) · [Norsk bokmål](nb.md) · [မြန်မာ](my.md) · [Bahasa Melayu](ms.md) · [ລາວ](lo.md) · [한국어](ko.md) · [ខ្មែរ](km.md) · **日本語** · [Italiano](it.md) · [Bahasa Indonesia](id.md) · [Magyar](hu.md) · [Hrvatski](hr.md) · [हिन्दी](hi.md) · [עברית](he.md) · [Français](fr.md) · [Filipino](fil.md) · [Suomi](fi.md) · [Español](es.md) · [Español (México)](es-MX.md) · [Ελληνικά](el.md) · [Deutsch](de.md) · [Dansk](da.md) · [Čeština](cs.md) · [Català](ca.md) · [العربية](ar.md)

[ドキュメントを見る](https://betterworkflows.dev/ja/docs/) · [GitHub を開く](https://github.com/stephen-taipei/better-workflows) · [Ko-fi で支援](https://ko-fi.com/betterworkflows)

</div>

## エージェントの仕事を<br>完了を検証できる状態まで導く。

Better Workflows は goal、scope、authority を固定し、すべての判断を現在のソースに紐付き、なお有効で再検証可能な証拠と、照合済みの外部結果に結び付けます。

## 意図から完了までを分ける、4 つの明確な境界。

contract を定義し、source と evidence を検証し、外部で生じた結果を照合したうえで、終端状態が判明したときだけ完了を宣言します。

- **01 · `TaskContract`** — Better Workflows は goal、scope、authority を固定し、すべての判断を現在のソースに紐付き、なお有効で再検証可能な証拠と、照合済みの外部結果に結び付けます。
- **02 · `evidence`** — AI agent がリスクに応じて検証強度を選び、隔離環境で安全に作業を完了します。 単純な変更は素早く完了し、重要な作業は evidence gate を通し、Git 変更は既定で専用 worktree を使います。
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
- [Evidence Cinema](https://betterworkflows.dev/ja/docs/evidence-cinema/)

- [`DETAILS · ja`](../details/ja.md)
- [`README · en`](../../README.md)
- [`LOCALIZATION`](../LOCALIZATION.md)

### `GUIDES · en`

- [`getting-started`](../guide/getting-started.md) · `en`
- [`workflows`](../guide/workflows.md) · `en`
- [`architecture`](../guide/architecture.md) · `en`
- [`security`](../guide/security.md) · `en`
- [`cli-reference`](../guide/cli-reference.md) · `en`
- [`readme-quality`](../guide/readme-quality.md) · `en`

### `POLICIES · en`

- [`CODE_OF_CONDUCT`](../../CODE_OF_CONDUCT.md) · `en`
- [`CONTRIBUTING`](../../CONTRIBUTING.md) · `en`
- [`GOVERNANCE`](../../GOVERNANCE.md) · `en`
- [`SECURITY`](../../SECURITY.md) · `en`
- [`SUPPORT`](../../SUPPORT.md) · `en`
- [`THIRD_PARTY_NOTICES`](../../THIRD_PARTY_NOTICES.md) · `en`
- [`ANSIBLE`](../../deploy/ansible/README.md) · `en`

### `RUNTIME SOURCE · en`

- [`plugins/better-workflows/skills/`](../../plugins/better-workflows/skills/)
- [`evidence-cinema/imagegen-manifest`](../html/evidence-cinema/assets/imagegen-manifest.md)
- [`use-cases/color-system`](../html/use-cases/assets/color-system.md)
- [`use-cases/imagegen-manifest`](../html/use-cases/assets/imagegen-manifest.md)
- [GitHub を開く](https://github.com/stephen-taipei/better-workflows)

## Better Workflows の継続的なメンテナンスを支えてください。

一度限りの支援は、オープンソースの保守、ドキュメント、41 ロケール向けのローカライズ版、Web サイト運営に役立ちます。会員資格、ロードマップ上の優先権、サポート上の優先権は付与されません。

[Ko-fi で支援](https://ko-fi.com/betterworkflows)

---

コマンドが動いたことは完了の証明ではありません。再検証できる結果こそが証拠です。
