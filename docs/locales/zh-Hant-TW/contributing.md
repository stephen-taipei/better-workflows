<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# 參與貢獻

[English](../en/contributing.md) · [繁體中文](../zh-Hant/contributing.md) · **繁體中文（台灣）** · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

感謝您協助改善 Better Workflows。

[README](../../../README.md) · **參與貢獻** · [行為準則](conduct.md) · [資安政策](security.md) · [專案治理](governance.md) · [使用支援](support.md)

[41 個語系版本的在地化總覽與官網入口](../../../docs/LANGUAGES.md)。本貢獻規範以英文原文為準。

## 開始之前

- 新增公開契約、變更 Auto 的公開行為、調整資安界線或進行重大架構變更前，請先建立議題或發起討論。
- 每個合併請求應專注於單一成果。
- 切勿提交身分驗證資料、非公開提示詞、原始對話紀錄、主機簽章金鑰、供應商回執或已簽章的證明。
- 請依照 [SECURITY\.md](security.md) 的說明，以私密方式回報漏洞。

## 開發環境設定

需求：

- Node\.js 24 或更新版本；
- 不含第三方執行階段相依套件；
- 以目前目標分支為基礎的乾淨分支。

執行完整的本機基準檢查：

```bash
npm test --prefix plugins/better-workflows
node plugins/better-workflows/scripts/sbw.mjs eval
git diff --check
```

## 變更規則

1. 保留 Root 專屬的狀態變更權限，以及未經驗證即拒絕執行副作用的界線。
2. Auto 的公開行為如有變更，請一併更新其範本與技能、入口點目錄、CLI、測試及所有受影響的文件。
3. 拒絕未知的 CLI 選項與未知的結構描述欄位。
4. 將私密執行階段狀態保留在儲存庫之外。
5. 為每個新增的安全關卡加入負向測試。
6. 請勿變更既有的不可變外掛快取版本。套件組合若有變更，必須使用新的建置版本，並精確驗證來源／快取的摘要。

若僅調整 README 的組織方式，請讓根目錄頁面維持易於瀏覽，並將詳細契約放入 [`docs/guide/`](../../../docs/guide/) 下的對應檔案。

## 合併請求檢查清單

- [ ] 已明確說明範圍與非目標。
- [ ] 已記錄行為與安全界線。
- [ ] 針對性測試涵蓋成功與失敗路徑。
- [ ] 完整測試套件與 `sbw eval` 均通過。
- [ ] `git diff --check` 通過。
- [ ] 適用時，版本／快取變更遵循不可變發布規則。
- [ ] 未包含機密資訊、私密狀態或外部回執。

建議採用小幅且易於審查的提交。請勿將不相關的清理工作與行為變更合併。
