# V5.1 Root 派工、整合與驗收 SOP

## 使用方式

R10 當前基線：129 張 task、109 tracked leaves、107 GA obligations。122 僅為原始 issue 對照數；新增的七張 CC task 仍為 BLOCKED。下文標示 R8 歷史的 102／100／122 數字只描述當時修訂，不作為 R10 派工或驗收分母。

先由 Root 核對新總表與當次 source。完整工作封包未凍結前保持 BLOCKED；唯讀調查可先行。READY 表示封包及直接前置已驗證，仍不自行授予 effect 權限。BLOCKED 與 UNTRIGGERED 不派實作。

每張 issue 指定 R（Root）、W（開發）或 Q（独立驗證）。角色名稱不授權 effect。適用的 AGENTS.md／CLAUDE.md 允許 delegation 時，積極拆出可獨立驗證、低歧義工作；衝突依指令優先層級處理，未明確授予的寫權不增加。

## 開工封包

Root 在 BLOCKED→READY 前保存 `schemaVersion: 2` 的 `dispatchPacket`。頂層及固定巢狀物件只接受下列 schema 的欄位；未知、缺少或來源失配均拒絕：

| 欄位 | 要求 |
|---|---|
| schemaVersion／issue | 固定版本2；issue為catalog工作單代碼 |
| owner／integrationOwner／reviewers | `{id, role}`；owner角色符合工作單；整合角色為R；reviewers至少一位，ID互異且不同於owner |
| sourceDigest／base／contractDigest | 綁定R7來源身分、已核定planning revision的精確base SHA及工作單contract；不得只寫branch名 |
| contractDetails | 固定schema、exports、errors、callbacks、bytes、storage六項非空描述；不適用須說明原因；另含sourceBinding及policyBinding |
| contractDetails.sourceBinding | `{base, head, files}`；base/head符合核定base；files逐項為`{path, status, sha256}`，路徑安全且互異；PRESENT有SHA-256，ABSENT為null |
| contractDetails.policyBinding | `{id, digest}`；凍結適用policy身分及SHA-256 |
| dependencyReceipts | 逐項`{task, sourceDigest, base, receiptDigest}`；完整且唯一涵蓋直接前置，來源及base一致；未觸發條件另保留理由 |
| reservedPaths | 符合contract的逐一排他檔案，相當於writeOwner.paths；rename／new file也需納入；forbidden及beforeWrite維持catalog中已凍結限制 |
| workspaceLease | `{id, ownerId, branch, worktreePath, expiresAt}`；Root provisioning、codex/ branch、獨立worktree及owner相符lease |
| environment | `{host: {os, arch}, nodeVersion, toolVersions}`；明確版本及非空tool版本表 |
| acceptance | `{commands, positiveCases, negativeCases, compatibility}`；前三項非空，compatibility符合工作單contract |
| budget | `{attempts, deadline, tokenBudget, unknownTokens, noProgressLimit}`；有限正整數attempts、UTC deadline、tokenBudget為正整數或null；未知用量選STOP或BOUND_BY_ATTEMPTS_AND_DEADLINE；noProgressLimit固定2 |
| stopConditions／rollback | 非空停止條件陣列；rollback為`{trigger, procedure}`，兩者非空 |
| lifecycle | `{ownerId, recordPidPpidDescendants, recordCwd, recordPortsSockets, cleanupMethod}`；owner符合封包，三項tracking皆為true，清理方法非空 |
| conditionalTrigger | 任務含條件leaf時必填，其他任務拒絕；`{evaluatedAt, bindings}`，逐leaf綁定見下節 |
| packetDigest | 排除packetDigest欄位後，遞迴按物件key排序、保留陣列順序的compact JSON之UTF-8 SHA-256 |

R10 catalog另固定129張 task（含原122張工作單及7張CC task）的來源對照、owner、版本、leaf mapping、依賴、排他路徑及contract（包含forbidden／beforeWrite）。這個reviewed metadata digest獨立於每張contract自算digest；39個RC2語系須全域唯一，並維持已核定12／14／13組別成員。state、dispatchPacket及執行收據不進此不可變投影。刻意變更planning metadata或base時，必須先提出可審閱的版本差額，再同步修訂catalog與固定digest；不能重算個別contract後自行改寫規劃。

結構checker只檢查schema、固定baseline與封包內binding，不驗證真實身份、policy、檔案bytes、lease有效性、host能力或receipt結果，也不授予effect。Root在固定經審閱的packet digest及標READY之前，須依可信的當次身份與授權證據，核對owner／integrationOwner／reviewers的實際身份、角色、適用授權及審查者依policy要求的獨立性；另須讀回實際host／工具能力、版本與可用性，以及當次dev SHA、來源及policy、直接前置收據、實際worktree／lease與截止時間，完成適用admission。身份、授權、獨立性或host／工具能力缺證據、僅有synthetic值或失配時保持BLOCKED；base已變更時也保持BLOCKED。Root也須核對每项直接前置的當次實際收據，其來源／base／版本與結果符合該前置contract的可接受終態；FAIL／HOLD／UNKNOWN／NOT_RUN或僅有格式正確的digest不能通過。off／未觸發結論只在該前置contract明確接受、已有核定理由與實際收據時成立；否則依賴工作保持BLOCKED。固定packet digest前，Root須核對本批次所有可派工的實際寫入路徑，包含Root保留路徑與共享facade；重疊須先序列化或透過明確owner交接解除，未完成不得READY。UTC時間的結構驗證是確定性snapshot檢查，執行前另核對是否到期。測試中的synthetic owner／lease／receipt不是實際派工證據。

完整結構草稿通過`validateV51DispatchPacket`仍不能建立catalog READY。Root完成上述實際核對後，另在經審閱的checker版本中固定該issue的packet digest；`validateV51Catalog`要求此獨立參照存在且一致。目前固定參照為空，沒有任何READY packet獲核定；只在packet內重算digest、改source／policy／receipt或加自述批准欄位，不能解除BLOCKED。

`developmentBase`是核定派工批次的實作起始source SHA B；reviewed catalog／checker revision C是另行凍結的planning artifact，不要求C=B。Root可先在獨立planning branch／artifact核定C，再確認目標dev與實作worktree起始source仍為B才派工。若發布C或其他整合已移動dev，保持BLOCKED，依planning revision程序更新base並重新核定受影響packet／receipts。

當前 governed run 只有 Root 寫入，children 回傳提案。獨立開發 Agent 的新模組寫權依其核定 packet；不由這份計畫或 issue label 自動取得。最多三張有用的獨立工作單並行，host／quota／資源限制優先；不能以產品上限32推導native Agent數量。

## Root 保留與整合

Root 保留 authority、admission、ledger、recovery transitions、shared budgets、五個共享 facade，以及 Git／CI／provider／release。worker 不反向 import 原 facade；共享接線由 Root 序列化。

1. 核對實際 diff、API／bytes相容、正反 evidence與owner cleanup。
2. feature PR 指向 protected dev；必要 checks 是 Runtime / Node 22.23.3、Runtime / Node 24.21.0、test。strict freshness、admins enforced、no force/delete、conversation resolution。
3. GitHub approval count0用於此單一maintainer流程，不取代適用的獨立review receipts與Better Workflows gates。
4. 各分支PASS後，對組合candidate重新檢查；不得合成不同SHA／runAttempt／host的資格。
5. 保留commit與provider操作收據，更新master和handoff；遷移／關閉issue不代表產品GA。
6. 最終release PR由dev至main；tag/publication只依正式gates和owner授權。

## 驗收與停止

保持 UNKNOWN／HOLD／NOT_RUN。SOURCE_OR_TEST_FAILURE 保留原attempt；修正後用新SHA重綁受影響receipts，不以重建候選或提高timeout覆寫失敗。

P1本機Shadow在原任務結束後離線研究，無當輪import/query/wait/decision/effect/completion；兩個研究leaf不列GA。Rust／codec有熱點與准入證據才觸發；off／未觸發有直接理由才是有效結論。

GA需全部必交能力、決策與條件結論、same-SHA qualification、41語系官網／文件、E2E收益及護欄、30自然日／20連續適格starts／3repos。canary的FAIL/HOLD/UNKNOWN保留分母；它不代替版本效益證據。

取消或換模型先保全成果、同logical operation對帳、stop已證明owned processes，再依fenced新owner接手；不能只憑PID不存在刪Git鎖或重置budget。

## Catalog 欄位邊界

Backlog root 與每張 task 使用明列的欄位 schema；未知或缺少必填欄位即拒絕。Task `title` 納入固定 planning metadata digest；RC2 三組的 `localeIds` 為必填，其他 task 不接受此欄位。`readOnlyInspectionAllowed` 是固定 metadata，不能改成字串或透過新增未宣告的 authority 欄位建立執行權。

只有 `state`、`detail`、`readinessBlocker`、`dispatchPacket` 是可變的執行註記；`contractDigest` 另由固定 contract 重新核對。可變欄位仍有型態限制，且不授予 effect authority。BLOCKED 的 draft packet 是註記；READY 仍須完整 packet 驗證、獨立固定 packet digest、Root 實際 dependency／source／policy／lease 收據與既有 admission gates。

## 可攜路徑與實體別名

在 host／檔案系統資格尚未建立時，非 Root 的 reservedPaths 與所有 sourceBinding.files.path 採可攜 ASCII repository-relative 路徑：每段只允許 A–Z、a–z、0–9、點、底線及連字號；禁止空段、`.`／`..`、尾端點、Windows 保留裝置名稱及其副檔名。Unicode（包含 NFC／NFD 變體）、空白、控制字元、反斜線、磁碟／UNC／URI／alternate-stream、短檔名 `~` 及 wildcard 路徑保持拒絕；如需擴大字元契約，先另行核定實際 host 規則與負向證據。

結構 checker 保留原始路徑字串，僅以 ASCII lowercase comparison key 比較 source file 唯一性及非 Root 寫入範圍相等／父子重疊；即使在大小寫敏感主機也不允許靠大小寫拆分 ownership。此規則不建立實體身分或權限：Root 仍須在 dispatch 前讀回精確 source bytes、PRESENT／ABSENT、physical path、symlink／hardlink／junction／short-name alias 與 scope boundary；未知實體映射保持 HOLD。Root 規劃 placeholder 仍屬 BLOCKED，不能當成已凍結的實際寫入路徑。

Windows 名稱規則來源：[Microsoft Naming Files, Paths, and Namespaces](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)。可攜 ASCII 是本方案的保守工程限制，並不宣稱各檔案系統只支援 ASCII。


## 條件任務的觸發與准入

本次尚未發布的 bootstrap、零核定 READY 下，schemaVersion2 擴充為含條件封包的閉合契約；修訂須綁定新的經審閱 checker revision，不能宣稱一般性的舊 schema2 consumer 相容。`validateV51DispatchPacket` 的第五參數為完整 requirements context，缺少即拒絕；checker先核對固定來源、rows digest、分類、分母及base，再推導該task應涵蓋的條件leaf。

`conditionalTrigger` 固定為 `{evaluatedAt, bindings}`；每項binding僅接受 `{leafId, rowDigest, criterionId, evidenceDigest, sourceDigest, base, policyDigest, observedAt, expiresAt}`。leaf集合必須完整、唯一、無額外項目；R-04涵蓋40／41，R-06涵蓋36b／43。rowDigest為該經核對requirement row的canonical JSON SHA-256；sourceDigest／base／policyDigest符合當次packet。時間皆為ISO UTC，滿足 `observedAt ≤ evaluatedAt < expiresAt`，且evaluatedAt早於workspaceLease expiry及budget deadline。這是確定性snapshot檢查，不以Date.now()替代執行前的實際核對。

固定開工條件：34採`storage-hotspot-v1`，依計畫§3.7的I/O／儲存熱點與預註冊數值門檻；36b與37–43採`track-r-entry-v1`，依§4.2的Track A熱點證據及Node側改良已達上限。43的95% CI下界與最低實務收益仍是最後採用验收，不能要求R-06在開工前已有自身benchmark結果。

Root依evidenceDigest讀回實際證據，核對門檻、預註冊、結果、來源與policy規定的有效期限，才固定獨立經審閱packet digest。row34的門檻預註冊須早於查看codec結果，無須早於W0原始量測。執行前重新核對觸發證據、lease與budget有效性；缺證據、過期、結果不符或來源失配保持BLOCKED。未成立且有合格實際理由時維持UNTRIGGERED；off／未觸發不是觸發成立的證明。不存在`triggered:true`、自述批准狀態或任意criterion字串的通行方式。

完整synthetic conditional packet可以通過結構驗證，但catalog READY仍要求獨立固定packet digest及Root實際admission。當前固定READY表仍為空、條件task仍未啟動；R8 歷史修訂當時未變更requirements rows、task mapping、固定metadata digests或102／100分母；R10 當前值與 metadata digest 以本頁首段及 Claude amendment 為準。


## 規劃投影的封閉來源語法

`validateV51PlanProjection` 驗證已凍結的來源格式，不是通用 Markdown renderer。
先由相鄰 delimiter row 發現表格，再驗證 column-zero、空行邊界、未跳脫的兩端
`|`、分隔欄數及每一個 body row 的 framing、visibility 與相同欄數。
十一欄只允許 canonical requirement header；一般表格只允許驗證器中由已審閱基線
固定的完整 header vectors。未知 header、entity／escape／emphasis／link／code
等價拼法均拒絕，不由當次待驗文件建立 allowlist，也不新增顯示等價解碼。
未被合法表格消費的可見結構性 `|` 一律拒絕；只有完整同列、exact-run inline
code span 或奇數反斜線跳脫中的 `|` 可作普通文字。先發現表格，再適用 inline
code 例外，避免整個 header 包 code 後被略過。既有 comment／fence、HTML、ASCII
空白、CRLF 及 bare-CR 限制保留。沒有結構性 pipe 的普通 Setext heading 不當作表格。
column-zero 表格先依未跳脫的結構性 pipe 分欄，再以各欄原始字元獨立核對
inline code／HTML；backtick 不得跨欄配對，欄內 escaped pipe 保留。fence 開啟
只接受 column-zero 且位於文件起點或 ASCII 空行之後的頂層區塊；縮排開啟或
緊接容器文字的歧義位置拒絕，不能用清單 fence 遮罩已退出容器的需求表。
此來源契約收緊需經獨立 source review；本機測試、header registry 或結構通過不建立
READY、authority、runtime qualification、啟用、部署或 GA。R8 歷史：102／100／122 分母不變；此歷史敘述不適用 R10 當前分母。

## R10 Claude phase／claim 邊界

`v5-1-claude-claims.json` 將 CC 的 development、qualification、release 分列；
`validate-v51-claude-claims.mjs` 只檢查規劃形狀及 observation 的 exact binding。
它不驗證 supplied digest 指向的實際 bytes、provenance、簽章、身份或有效授權。
輸出固定 `authority: none`、`taskCompletion: BLOCKED`，不接 runtime admission。
R10 的開發欄位仍是 PROPOSAL，沒有凍結 development dispatch packet，不能據此派實作。

CC 完整資格的 task edges 補齊 requirement 級前置：93 的 89a 消費 W0-06 的
platform／host／action scope 契約，不把 Windows production seam PL-01 誤當
macOS 開發前置；98 的 51 消費 B-04a 的 quota 契約及 Claude 自身實際觀察，
不代替其他三個 host 的 conformance；99 的 90 保留 REL-01 的正式發布 gate。
58／59／60／61 的完整 executor 與隔離驗收仍由 B-08、B-09a–d、B-11 負責。
局部開發子項必須另凍結 exact claim／scope／source／policy／可接受終態／真實收據；
不能把完整 task 的 HOLD 包裝成子項 PASS。

隔離開發、真實資格及發布的 evidence class 不可互換。CC-05 的四組 raw／grader
結果逐項保留；測試成功觀察到預期 HOLD 不表示該能力已啟用。CC-07 缺任一 host
或 same-SHA／canary／rights／owner-publication 收據時維持 HOLD。原 109 tracked
leaves、107 GA obligations 與 READY 的独立固定 digest 規則均不變。

V5.0 的 canonical host scope 與 `.claude-plugin` 排除保持不變。未來 V5.1 candidate
套件與逐檔 ownership 須另經封包審查；目錄 placeholder、歷史 V4 autonomy source、
readiness probe 或此規劃測試均不授予安裝、activation 或發布權。
