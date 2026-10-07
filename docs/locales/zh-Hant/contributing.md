<!-- Generated from CONTRIBUTING.md; source-sha256: f9fb422dd43bdbf071bcfe969fef0b4b9d47c7e44db40b362e14f8eadf13d507; edit docs/rc1-catalogs/policies/*.json. -->
# 參與貢獻

[English](../en/contributing.md) · **繁體中文** · [繁體中文（台灣）](../zh-Hant-TW/contributing.md) · [繁體中文（香港）](../zh-Hant-HK/contributing.md) · [简体中文](../zh-Hans/contributing.md) · [Tiếng Việt](../vi/contributing.md) · [Українська](../uk/contributing.md) · [Türkçe](../tr/contributing.md) · [ไทย](../th/contributing.md) · [Svenska](../sv/contributing.md) · [Slovenčina](../sk/contributing.md) · [Русский](../ru/contributing.md) · [Română](../ro/contributing.md) · [Português](../pt/contributing.md) · [Português \(Brasil\)](../pt-BR/contributing.md) · [Polski](../pl/contributing.md) · [Nederlands](../nl/contributing.md) · [Norsk bokmål](../nb/contributing.md) · [မြန်မာ](../my/contributing.md) · [Bahasa Melayu](../ms/contributing.md) · [ລາວ](../lo/contributing.md) · [한국어](../ko/contributing.md) · [ខ្មែរ](../km/contributing.md) · [日本語](../ja/contributing.md) · [Italiano](../it/contributing.md) · [Bahasa Indonesia](../id/contributing.md) · [Magyar](../hu/contributing.md) · [Hrvatski](../hr/contributing.md) · [हिन्दी](../hi/contributing.md) · [עברית](../he/contributing.md) · [Français](../fr/contributing.md) · [Filipino](../fil/contributing.md) · [Suomi](../fi/contributing.md) · [Español](../es/contributing.md) · [Español \(México\)](../es-MX/contributing.md) · [Ελληνικά](../el/contributing.md) · [Deutsch](../de/contributing.md) · [Dansk](../da/contributing.md) · [Čeština](../cs/contributing.md) · [Català](../ca/contributing.md) · [العربية](../ar/contributing.md)

感謝您協助改善 Better Workflows。

[README](../../../README.md) · **參與貢獻** · [行為準則](conduct.md) · [安全性](security.md) · [專案治理](governance.md) · [使用支援](support.md)

[41 個語系版本的在地化總覽與官網入口](../../../docs/LANGUAGES.md)。本貢獻規範以英文原文為準。

## 開始之前

- 若涉及新的公開規格契約、Auto 公開行為變更、安全邊界或重大架構調整，請先建立 issue 或討論。
- 保持單一 pull request 專注於單一成果。
- 切勿提交憑證、私有 prompt、原始對話紀錄、主機簽署金鑰、提供者回執或已簽署的證明。
- 請依 [SECURITY\.md](security.md) 所述方式私下回報安全漏洞。

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

1. 維護 Root 擁有的修改權限與 fail\-closed 副作用邊界。
2. 當 Auto 的公開行為變更時，請同步更新其範本與 skill、進入點目錄、CLI、測試及所有受影響的文件。
3. 拒絕未知的 CLI 選項與未知的 schema 欄位。
4. 將私有執行階段狀態保留在存放庫之外。
5. 為每個新增的安全 gate 建立反向測試（negative tests）。
6. 切勿修改既有且不可變的 plugin\-cache 版本。套件更動時必須建立新建置版本，並進行嚴格的來源\/快取摘要驗證。

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
