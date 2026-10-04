<!-- Generated from GOVERNANCE.md; source-sha256: 1639c4634b05d69d4512a56cd48a9554ef5530423cc72b7d1f20387b22c9ce04; edit docs/rc1-catalogs/policies/*.json. -->
# 專案治理

[English](../en/governance.md) · **繁體中文（台灣）**

[README](../../../README.md) · [參與貢獻](contributing.md) · [行為準則](conduct.md) · [資安政策](security.md) · **專案治理** · [使用支援](support.md)

[RC1 規劃公開路由涵蓋 en 與 zh\-Hant\-TW；41 語系來源目錄為私有](../../../docs/LANGUAGES.md)。本專案治理政策以英文原文為準。

Better Workflows 由維護者主導。

## 決策模式

- 維護者接受或拒絕專案層級的設計與版本發布變更。
- 證據、可重現的測試、安全界線、相容性與維護成本，優先於受歡迎程度或多數決納入考量。
- 公開契約與資安界線的變更必須經過明確審查。
- 當新證據改變取捨時，遭拒絕的提案可以重新考慮。

## 工作流程權限

在一次 Better Workflows 執行中，Root 是唯一有權執行狀態變更並接受風險的主體。 這項執行階段規則不授予儲存庫擁有權，也不會凌駕 GitHub 權限。

## 版本發布

V5\.1 從公開 RC1 基準於隔離功能分支開發。功能PR以受保護的 `dev` 為目標；維護者協調最後release PR由 `dev` 至 `main`。merge前需獨立審查、最新必要checks與provider對帳。開發許可不代表activation、pilot或GA。

外掛快取建置版本不可變更。候選發布版本必須在發布前通過適用的測試、評估、證據時效性、證據、受保護分支，以及來源／快取核對關卡。

## 治理變更

治理變更須比照公開契約變更進行審查，並且必須記錄於儲存庫歷史紀錄中。
