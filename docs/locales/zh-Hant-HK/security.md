<!-- Generated from SECURITY.md; source-sha256: 02167257277c1b06a7ed11fafcc20158ee6ada1747d84478edd027770a882919; edit docs/rc1-catalogs/policies/*.json. -->
# 保安政策

[English](../en/security.md) · [繁體中文](../zh-Hant/security.md) · [繁體中文（台灣）](../zh-Hant-TW/security.md) · **繁體中文（香港）** · [简体中文](../zh-Hans/security.md) · [Tiếng Việt](../vi/security.md) · [Українська](../uk/security.md) · [Türkçe](../tr/security.md) · [ไทย](../th/security.md) · [Svenska](../sv/security.md) · [Slovenčina](../sk/security.md) · [Русский](../ru/security.md) · [Română](../ro/security.md) · [Português](../pt/security.md) · [Português \(Brasil\)](../pt-BR/security.md) · [Polski](../pl/security.md) · [Nederlands](../nl/security.md) · [Norsk bokmål](../nb/security.md) · [မြန်မာ](../my/security.md) · [Bahasa Melayu](../ms/security.md) · [ລາວ](../lo/security.md) · [한국어](../ko/security.md) · [ខ្មែរ](../km/security.md) · [日本語](../ja/security.md) · [Italiano](../it/security.md) · [Bahasa Indonesia](../id/security.md) · [Magyar](../hu/security.md) · [Hrvatski](../hr/security.md) · [हिन्दी](../hi/security.md) · [עברית](../he/security.md) · [Français](../fr/security.md) · [Filipino](../fil/security.md) · [Suomi](../fi/security.md) · [Español](../es/security.md) · [Español \(México\)](../es-MX/security.md) · [Ελληνικά](../el/security.md) · [Deutsch](../de/security.md) · [Dansk](../da/security.md) · [Čeština](../cs/security.md) · [Català](../ca/security.md) · [العربية](../ar/security.md)

[README](../../../README.md) · [參與貢獻](contributing.md) · [行為守則](conduct.md) · **保安** · [項目管治](governance.md) · [使用支援](support.md)

[41 個語系版本的本地化總覽與官方網站入口](../../../docs/LANGUAGES.md)。本具規範效力的保安政策以英文版為準。

如唯一建議採用的證據來源包含無法移除敏感資料的非公開歷史紀錄或敏感營運資料，請勿收集或傳送該來源。只記錄已遮蓋敏感資料的 `REJECTED_WITH_EVIDENCE` 理由。

## 支援版本

| 版本 | 支援狀態 |
| --- | --- |
| 最新發佈版本及不可變更的 Codex 建置版本 | 支援 |
| 較舊的不可變更快取版本 | 用作回復至舊版本的目標；除非另有明確公告，否則不會將修正移植至舊版本 |
| 未發佈的分支專案或經修改的快取內容 | 不支援 |

## 報告漏洞

請使用[GitHub 私密漏洞報告](https://github.com/stephen-taipei/better-workflows/security/advisories/new)。請勿就疑似漏洞建立公開議題。

請提供：

- 受影響的版本及外掛建置版本；
- 環境及 Node\.js 版本；
- 最少的重現步驟；
- 預期及實際觀察到的保安邊界；
- 影響及任何已知的應對方法；
- 報告是否包含機密資料。

請勿包含仍然有效的憑證、簽署金鑰、服務供應商權杖、未經處理的非公開提示詞或第三方個人資料。

## 回應

維護者會確認收到可供處理的報告、核實其範圍，並協調修補及披露事宜。不承諾固定回應時間的 SLA。結果不明或尚未完成核對時，會維持未經驗證便拒絕放行的原則。

## 保安邊界

Better Workflows 假設本機儲存庫、主機及可執行工具鏈均可信任。Node 的權限模型屬於縱深防禦措施，並非用來隔離惡意程式碼的作業系統沙箱。請參閱完整的[保安指南](security-guide.md)。
