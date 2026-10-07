<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# 貢献について

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · **日本語** · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

Better Workflows の改善にご協力いただき、ありがとうございます。

[README](../../../README.md) · **貢献方法** · [行動規範](conduct.md) · [セキュリティ](security.md) · [ガバナンス](governance.md) · [サポート](support.md)

[41 ロケール版の概要と公式ウェブのアクセス先](../../../docs/LANGUAGES.md)。本貢献ポリシーの規範となる正文は英語版です。

## 作業を始める前に

- 新しい公開コントラクト、オートの公開動作の変更、セキュリティ境界、または大規模なアーキテクチャの変更には、まずイシューまたはディスカッションを使用してください。
- ひとつのプルリクエストはひとつの成果に集中させてください。
- 認証情報、プライベートなプロンプト、生の会話履歴、ホストの署名鍵、プロバイダーの受領証、署名付き構成証明は絶対にコミットしないでください。
- 脆弱性は [SECURITY\.md](security.md) に記載されているとおり、非公開で報告してください。

## 開発環境のセットアップ

要件：

- Node\.js 24 以降；
- サードパーティーの実行時依存関係がないこと；
- 現在の対象ブランチを基にしたクリーンなブランチ。

ローカルの基準チェックをすべて実行してください：

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## 変更のルール

1. Root 所有の変更権限と fail\-closed な副作用境界を維持すること。
2. Auto の公開動作が変更された場合は、そのテンプレートとスキル、エントリポイントカタログ、CLI、テスト、および影響を受けるすべてのドキュメントをまとめて更新すること。
3. 未知の CLI オプションおよび未知のスキーマフィールドを拒否すること。
4. プライベートなランタイム状態はリポジトリの外部に保持すること。
5. 新しい safety gate ごとにネガティブテストを追加すること。
6. 既存の不変な plugin\-cache バージョンを変更しないこと。変更されたバンドルには新しいビルドバージョンと、完全一致するソース\/キャッシュダイジェスト検証が必要です。

README の構成だけを整理する場合は、ルートページを一覧しやすく保ち、詳細な契約は [`docs/guide/`](../../../docs/guide/) 内の対応するファイルに配置してください。

## プルリクエストのチェックリスト

- [ ] 対象範囲と対象外の目的が明確である。
- [ ] 動作と安全性の境界が文書化されている。
- [ ] 焦点を絞ったテストが成功経路と失敗経路を網羅している。
- [ ] テストスイート全体と `sbw eval` が合格している。
- [ ] `git diff --check` が合格している。
- [ ] 該当する場合、バージョン／キャッシュの変更が不変性を守る公開ルールに従っている。
- [ ] 秘密情報、非公開状態、外部の受領証が含まれていない。

小さくレビューしやすいコミットを推奨します。無関係な整理作業を動作変更と一緒にしないでください。
