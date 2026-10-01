<!-- Generated from SECURITY.md; source-sha256: a16157ba5c7878255a8c6b83a10edfb8d157f03df3a2b1a542a5e2f34ee0b808; edit docs/rc1-catalogs/policies/*.json. -->
# 資安政策

[English](../en/security.md) · **繁體中文（台灣）**

[README](../../../README.md) · [參與貢獻](contributing.md) · [行為準則](conduct.md) · **資安政策** · [專案治理](governance.md) · [使用支援](support.md)

[RC1 規劃公開路由涵蓋 en 與 zh\-Hant\-TW；41 語系來源目錄為私有](../../../docs/LANGUAGES.md)。本資安政策以英文原文為準。

若唯一提議使用的證據來源包含無法去除敏感資訊的非公開歷史紀錄或敏感作業資料，請勿蒐集或傳輸該來源。僅記錄已遮蔽敏感資訊的 `REJECTED_WITH_EVIDENCE` 理由。

## 支援的版本

| 版本 | 支援狀態 |
| --- | --- |
| 最新發布版本與不可變的 Codex 建置版本 | 支援 |
| 較舊的不可變快取版本 | 回復目標版本；除非明確公告，否則不會將修正回移至舊版本 |
| 未發布的分支專案或經修改的快取內容 | 不支援 |

## 回報漏洞

請使用[GitHub 私密漏洞回報](https://github.com/stephen-taipei/better-workflows/security/advisories/new)。請勿針對疑似漏洞建立公開議題。

請包含：

- 受影響的版本與外掛建置版本；
- 環境與 Node\.js 版本；
- 最小重現步驟；
- 預期與實際觀察到的資安界線；
- 影響與任何已知的因應方式；
- 回報是否包含機密資料。

請勿包含仍有效的身分驗證資料、簽章金鑰、供應商權杖、未經處理的非公開提示詞或第三方個人資料。

## 回應

維護者會確認收到可供處理的回報、驗證其範圍，並協調修補與揭露事宜。不承諾固定回應時間的 SLA。結果未知或尚未完成核對時，持續採取未經驗證即拒絕放行的原則。

## 資安界線

Better Workflows 假設本機儲存庫、主機與可執行工具鏈皆可信任。Node 的權限模型屬於縱深防禦措施，並非用來隔離惡意程式碼的作業系統沙箱。請參閱完整的[資安指南](security-guide.md)。
