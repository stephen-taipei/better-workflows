<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# 參與貢獻

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · **繁體中文（香港）** · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

感謝你協助改善 Better Workflows。

[README](../../../README.md) · **參與貢獻** · [行為守則](conduct.md) · [保安](security.md) · [項目管治](governance.md) · [使用支援](support.md)

[41 個語系版本的本地化總覽與官方網站入口](../../../docs/LANGUAGES.md)。本具規範效力的貢獻政策以英文版為準。

## 開始之前

- 如涉及新嘅公開合約、Auto 公開行為嘅變更、安全邊界或重大架構改動，請先開 issue 或 discussion。
- 保持一個 pull request 專注於一個成果。
- 切勿 commit 憑證、私密 prompt、原始對話記錄、主機簽名金鑰、供應商收據或已簽名嘅 attestation。
- 請依照 [SECURITY\.md](security.md) 嘅指引私下通報安全漏洞。

## 開發環境設定

要求：

- Node\.js 24 或以上版本；
- 不含第三方運行時依賴項目；
- 以目前目標分支為基礎的乾淨分支。

執行完整的本機基準檢查：

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## 變更規則

1. 保留 Root 專屬嘅變更權限與 fail\-closed 副作用邊界。
2. 當 Auto 嘅公開行為有所改變時，請同時更新其範本與 skill、進入點目錄、CLI、測試以及所有受影響嘅文件。
3. 拒絕未知嘅 CLI 選項與未知嘅 schema 欄位。
4. 將私密 runtime 狀態保留喺代碼庫之外。
5. 為每個新嘅 safety gate 加入反向測試。
6. 切勿變更現有且不可變嘅 plugin\-cache 版本。套件一旦改動，必須使用新嘅 build 版本並進行精確嘅 source\/cache digest 驗證。

如只調整 README 的編排，請保持根目錄頁面易於瀏覽，並將詳細契約放在 [`docs/guide/`](../../../docs/guide/) 下的對應檔案。

## 拉取請求檢查清單

- [ ] 已明確列出範圍及非目標。
- [ ] 已記錄行為及安全邊界。
- [ ] 針對性測試涵蓋成功及失敗路徑。
- [ ] 完整測試套件及 `sbw eval` 均通過。
- [ ] `git diff --check` 通過。
- [ ] 適用時，版本／快取變更遵守不可變更的發佈規則。
- [ ] 未包含機密資料、私密狀態或外部回執。

建議採用小幅而易於審閱的提交。請勿將無關的清理工作與行為變更合併。
