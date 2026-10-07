<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# セキュリティポリシー

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · [繁體中文（香港）](../zh-Hant-HK/security.md) · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · **日本語** · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [貢献方法](contributing.md) · [行動規範](conduct.md) · **セキュリティ** · [ガバナンス](governance.md) · [サポート](support.md)

[41 ロケール版の概要と公式ウェブのアクセス先](../../../docs/LANGUAGES.md)。本セキュリティポリシーの規範となる正文は英語版です。

提案された唯一の証拠ソースに、機密情報を除去できない非公開の履歴や機密性の高い運用資料が含まれている場合、それを収集または送信してはいけません。機密部分を伏せた `REJECTED_WITH_EVIDENCE` の理由だけを記録してください。

## サポート対象バージョン

| バージョン | サポート状況 |
| --- | --- |
| 最新の公開リリースと変更不可の Codex ビルド | サポート対象 |
| 旧バージョンの変更不可キャッシュ | ロールバック先として使用可能。明示的な告知がない限り、修正は旧バージョンに移植されません |
| 未リリースのフォーク、または変更されたキャッシュ内容 | サポート対象外 |

## 脆弱性の報告

[GitHub の非公開脆弱性報告](https://github.com/stephen-taipei/better-workflows/security/advisories/new)を利用してください。脆弱性が疑われる場合、公開の課題を作成してはいけません。

以下を含めてください：

- 影響を受けるバージョンとプラグインビルド；
- 環境と Node\.js のバージョン；
- 最小限の再現手順；
- 想定されるセキュリティ境界と実際に観測されたセキュリティ境界；
- 影響と既知の回避策；
- 報告に機密資料が含まれているかどうか。

有効な認証情報、署名鍵、プロバイダーのトークン、未加工の非公開プロンプト、第三者の個人情報を含めてはいけません。

## 対応

保守担当者は、対応可能な報告の受領を通知し、対象範囲を検証して、修正と情報公開を調整します。固定の応答時間を定めた SLA は約束しません。結果が不明、または照合が完了していない場合は、未検証のまま実行を許可しない状態を維持します。

## セキュリティ境界

Better Workflows は、ローカルリポジトリ、ホスト、実行可能なツールチェーンが信頼できることを前提とします。Node の権限モデルは多層防御の一部であり、悪意あるコードを隔離するためのOS サンドボックスではありません。詳しくは完全版の[セキュリティガイド](security-guide.md)を参照してください。
