<!-- Generated from docs/guide/readme-quality.md; source-sha256: 16a64c0672dc10b72a306cdf3a0b6bb81b50b3022b64c384e5bf6854c4d33b1b; edit docs/rc1-catalogs/public-docs/*.json. -->
# README 撰寫品質指南

[English](../en/readme-quality.md) · **繁體中文** · [繁體中文（台灣）](../zh-Hant-TW/readme-quality.md) · [繁體中文（香港）](../zh-Hant-HK/readme-quality.md) · [简体中文](../zh-Hans/readme-quality.md) · [Tiếng Việt](../vi/readme-quality.md) · [Українська](../uk/readme-quality.md) · [Türkçe](../tr/readme-quality.md) · [ไทย](../th/readme-quality.md) · [Svenska](../sv/readme-quality.md) · [Slovenčina](../sk/readme-quality.md) · [Русский](../ru/readme-quality.md) · [Română](../ro/readme-quality.md) · [Português](../pt/readme-quality.md) · [Português \(Brasil\)](../pt-BR/readme-quality.md) · [Polski](../pl/readme-quality.md) · [Nederlands](../nl/readme-quality.md) · [Norsk bokmål](../nb/readme-quality.md) · [မြန်မာ](../my/readme-quality.md) · [Bahasa Melayu](../ms/readme-quality.md) · [ລາວ](../lo/readme-quality.md) · [한국어](../ko/readme-quality.md) · [ខ្មែរ](../km/readme-quality.md) · [日本語](../ja/readme-quality.md) · [Italiano](../it/readme-quality.md) · [Bahasa Indonesia](../id/readme-quality.md) · [Magyar](../hu/readme-quality.md) · [Hrvatski](../hr/readme-quality.md) · [हिन्दी](../hi/readme-quality.md) · [עברית](../he/readme-quality.md) · [Français](../fr/readme-quality.md) · [Filipino](../fil/readme-quality.md) · [Suomi](../fi/readme-quality.md) · [Español](../es/readme-quality.md) · [Español \(México\)](../es-MX/readme-quality.md) · [Ελληνικά](../el/readme-quality.md) · [Deutsch](../de/readme-quality.md) · [Dansk](../da/readme-quality.md) · [Čeština](../cs/readme-quality.md) · [Català](../ca/readme-quality.md) · [العربية](../ar/readme-quality.md)

[41 個語系版本的在地化總覽與官網入口](../../../docs/LANGUAGES.md)。本撰寫指南以英文版為準。

Better Workflows 的 README 是專案入口頁，不是壓縮版參考手冊。它應協助讀者依序回答五個問題：

1. 這是什麼？適合我嗎？
2. 它能解決什麼問題？
3. 我為什麼能相信它的主張？
4. 最快完成第一次成功操作的路徑是什麼？
5. 接下來該看哪裡？

本指南定義每份儲存庫 README 在敘事、視覺、在地化與驗證方面必須遵守的要求。可供程式讀取的規格來源是 [`readme-quality-v1.json`](../../../plugins/better-workflows/config/readme-quality-v1.json)。

## 從讀者要做的決定出發

GitHub 通常會先呈現 README，再呈現儲存庫的其他內容。因此，第一個畫面必須說清楚產品能帶來什麼、適合誰，以及範圍明確的下一步。不要以內部架構、完整指令參考或版本復原細節作為開場。

請針對以下讀者需求撰寫：

- **新訪客：**快速判斷 Better Workflows 是否能解決相關問題。
- **新使用者：**安裝外掛程式並完成一次成功的自動路由。
- **評估人員：**了解權限邊界與 fail\-closed 行為。
- **回訪操作者：**快速跳轉至工作流、安全性、架構或 CLI 解答。
- **貢獻者或翻譯者：**查詢權威契約、開發指令、支援管道與治理規範。

## 用因果關係組織敘事

五份入口頁 README 採用相同的八段語意順序。各語系的標題可以符合當地用語，但讀者的閱讀路徑不變。

| 段落 | 讀者問題與敘事作用 |
| --- | --- |
| 產品價值與適用對象 | Better Workflows 是什麼、為何存在，又適合誰？ |
| 從問題到成果 | 把意圖、授權、證據與服務提供者的實際結果混為一談，會出什麼問題？ |
| 佐證與邊界 | 哪些保證讓預期成果可信？ |
| 第一次成功操作 | 從安裝到取得結果，最短的完整路徑是什麼？ |
| 選擇下一步 | 哪個工作流程或文件符合讀者的目標？ |
| 生命週期 | 目標如何成為經核對的完成結果，或在必要時安全停止？ |
| 信任與限制 | 系統絕不能自行推論、授權或宣稱什麼？ |
| 學習、求助與貢獻 | 深入文件、支援、治理、開發與授權條款在哪裡？ |

這個順序形成實用的敘事脈絡：

- **背景：**提示詞驅動的工作可以表達意圖，卻不代表授權或狀態已獲證明。
- **問題：**會改變系統狀態的操作，使這個缺口成為交付風險。
- **解法：**Better Workflows 將目標、範圍、證據、審查、操作與服務提供者結果核對綁定。
- **佐證：**透過明確的保證與邊界，說明解法如何運作。
- **行動：**先讓讀者完成第一次成功操作，再介紹深入實作細節。
- **延伸：**依角色與預期成果，引導讀者前往適合的教學、操作指南、概念說明或參考資料。

## 區分入口頁內容與深入文件

README 應提供有助於做決定的資訊。依用途引導讀者深入閱讀：

- [入門指南](getting-started.md)是初次使用的教學。
- [工作流程](workflows.md)是依預期成果選擇操作方式的指南。
- [架構](architecture.md)說明控制平面與設計取捨。
- [資安](security-guide.md)說明授權、隱私、簽證，以及條件不明或不符時停止執行的機制。
- [CLI 參考](cli-reference.md)是指令參考文件。
- 在地化的 `docs/details/*.md` 頁面保留完整的翻譯細節。

不要在入口頁重複放入快取復原、鎖定所有權、服務提供者傳輸的完整語意、所有指令或實作變更歷史。入口頁只需保留簡潔的安全主張；可供稽核的深入說明應放在正式指南中。

這種區分遵循 Diátaxis 對教學、操作指南、概念說明與參考資料的分類。同一頁面無法同時最佳化這四種閱讀需求。

## 每張圖都要有明確用途

只有在關係、層級或狀態轉移用圖像呈現明顯比文字更容易理解時，才使用圖像。

入口頁允許使用兩種圖：

1. **授權邊界架構圖：**說明哪些層級決定意圖、目前事實、工具權限、次數受限的重試與唯讀狀態。
2. **從目標到完成的生命週期圖：**說明何時檢查證據、何時授權會改變狀態的操作，以及何時因狀態不明而停止。

每張圖都必須包含：

- 簡潔且有意義的替代文字；
- 緊鄰圖像的等義文字，確保隱藏圖像或 Mermaid 無法顯示時，仍能理解相同結論；
- 盡可能以真正的文字呈現重要標籤；
- 一個明確且持續適用的讀者問題，作為持續更新該圖的理由。

不要加入裝飾性截圖、塞滿文字的圖片，或只是重述短清單的圖表。選擇表應維持兩個精簡欄位，讓窄螢幕也能閱讀。

## 各語系維持相同含義

英文是語意基準，不是行數目標。繁體中文、簡體中文、日文與韓文應讓母語讀者讀起來自然，同時保留相同的規範含義。

以下項目必須保持等義：

- 八個語意段落及其順序；
- 第一次成功操作的指令與產品識別碼；
- 授權、證據、未知狀態、提示詞與隱私等五項主張；
- 工作流程、資安、架構、CLI、支援、治理、開發與授權條款的連結目的地；
- 圖像用途、生命週期階段與替代文字說明；
- 版本來源與徽章規範。

標題、分句、標點、範例與行動引導可以符合當地習慣。絕不可翻譯指令、選擇器或證據識別碼，也不可改變安全規範的語意。

## 方便快速閱讀與翻譯

- 先說讀者能得到什麼結果，並把重要詞語放在標題及段落開頭。
- 使用主動語態，指明由誰負責操作。
- 撰寫操作程序時，直接對讀者說明。
- 段落要短，每段只處理一件事。
- 有順序的步驟使用編號清單，沒有先後關係的選項使用項目清單。
- 使用具體的連結文字，不要只寫「按這裡」。
- 標題層級要清楚、內容要具體，同一層級的表述應一致。
- 優先使用明確、沒有歧義且容易保留原意的語句。
- 先寫適用條件，再寫操作指示；指令之後再寫預期結果。

## 驗證含義，不只檢查外觀

文件測試不能只比對標題，還必須檢查：

- 單一 H1 與具備邏輯的標題階層架構；
- 循序排列的語意段落與關鍵主張標記；
- 精確的首次成功指令與穩定識別碼；
- 相對連結與各語系專屬的詳細資訊目標頁；
- 與執行階段中繼資料一致的版本徽章；
- 具實質意義的圖片替代文字（alt text）與相鄰視覺替代方案；
- 單一 Mermaid 生命週期圖表並附帶完整文字對應內容；
- 雙欄表格與段落長度預算規範；
- 宣傳首頁不包含特定深入實作細節；

## 研究依據

- [GitHub：儲存庫 README 檔案說明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)界定 README 在初次造訪時的用途，並建議將長篇文件移至其他位置。
- [Diátaxis](https://diataxis.fr/start-here/)區分教學、操作指南、概念說明與參考資料的需求。
- [Microsoft：便於快速閱讀的內容](https://learn.microsoft.com/en-us/style-guide/scannable-content/)強調重要資訊優先、短段落與一致的視覺閱讀起點。
- [Google 開發者文件風格指南](https://developers.google.com/style/highlights)建議使用主動語態、直接對讀者說明、具體標題、無障礙設計及適合全球讀者的寫法。
- [GitHub：建立圖表](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams)說明 Markdown 的 Mermaid 支援。
- [W3C WAI：圖片教學](https://www.w3.org/WAI/tutorials/images/)要求資訊性與複雜圖像提供替代文字及完整的等義說明。
