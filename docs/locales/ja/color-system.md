<!-- Generated from docs/html/use-cases/assets/color-system.md; source-sha256: edf32956ca99c7a6e6ffb1e978a1db935a54cfe2cd9cb22c06735b1078cd5120; edit docs/rc1-catalogs/public-docs/*.json. -->
# エディトリアル・カラーシステム

[English](../en/color-system.md) · [繁體中文](../zh-Hant/color-system.md) · [繁體中文（台灣）](../zh-Hant-TW/color-system.md) · [繁體中文（香港）](../zh-Hant-HK/color-system.md) · [简体中文](../zh-Hans/color-system.md) · [Tiếng Việt](../vi/color-system.md) · [Українська](../uk/color-system.md) · [Türkçe](../tr/color-system.md) · [ไทย](../th/color-system.md) · [Svenska](../sv/color-system.md) · [Slovenčina](../sk/color-system.md) · [Русский](../ru/color-system.md) · [Română](../ro/color-system.md) · [Português](../pt/color-system.md) · [Português \(Brasil\)](../pt-BR/color-system.md) · [Polski](../pl/color-system.md) · [Nederlands](../nl/color-system.md) · [Norsk bokmål](../nb/color-system.md) · [မြန်မာ](../my/color-system.md) · [Bahasa Melayu](../ms/color-system.md) · [ລາວ](../lo/color-system.md) · [한국어](../ko/color-system.md) · [ខ្មែរ](../km/color-system.md) · **日本語** · [Italiano](../it/color-system.md) · [Bahasa Indonesia](../id/color-system.md) · [Magyar](../hu/color-system.md) · [Hrvatski](../hr/color-system.md) · [हिन्दी](../hi/color-system.md) · [עברית](../he/color-system.md) · [Français](../fr/color-system.md) · [Filipino](../fil/color-system.md) · [Suomi](../fi/color-system.md) · [Español](../es/color-system.md) · [Español \(México\)](../es-MX/color-system.md) · [Ελληνικά](../el/color-system.md) · [Deutsch](../de/color-system.md) · [Dansk](../da/color-system.md) · [Čeština](../cs/color-system.md) · [Català](../ca/color-system.md) · [العربية](../ar/color-system.md)

この版では、従来のグリーン中心のシステムに代えて、ミッドナイト、コバルト、アンティークゴールドによる編集向けの配色を使います。温かい紙と水彩イラストの本らしさを保ちながら、ルート、証拠、終端状態を技術的なシグナルとして読み取れるようにすることが狙いです。

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Page | `#F6F1E7` | `#11172A` | paper \/ night\-reading canvas |
| Ink | `#17213A` | `#F5F1E8` | primary text and headings |
| Muted | `#56617A` | `#BEC5D6` | long\-form explanation |
| Primary | `#3157A4` | `#8FB1FF` | links\, route markers\, focus |
| Accent | `#D6A42F` | `#F2C85B` | completion\, active rails\, chapter rhythm |
| Warm signal | `#C65D3B` | `#FF9B71` | risk\, stop\, irreversible action |
| Secondary | `#6A5796` | `#C3B1F2` | supporting section markers |

このパレットは役割を基準に意図的に分け、少数のファミリーに限定しています。システムの全色を公開するのではなく、小さなプロジェクト用トークン集合を選ぶという USWDS の方針に従っています。色は唯一のシグナルではなく、段階的な補助です。通常のテキスト配色は WCAG AA 4\.5\:1 の基準で確認しました：明るいインク 14\.19\:1、明るい補助色 5\.51\:1、明るいプライマリ 6\.16\:1、暗いインク 15\.79\:1、暗い補助色 10\.30\:1、暗いプライマリ 8\.39\:1。

参考資料：

- [WCAG 2\.2、1\.4\.3 コントラスト（最低限）](https://www.w3.org/TR/WCAG22/#contrast-minimum)
- [USWDS 色の使用](https://designsystem.digital.gov/design-tokens/color/overview/)
- [USWDS テーマカラーのトークン](https://designsystem.digital.gov/design-tokens/color/theme-tokens/)
- [IBM Carbon のアクセシブルな色に関するガイダンス](https://carbondesignsystem.com/guidelines/accessibility/color/)
