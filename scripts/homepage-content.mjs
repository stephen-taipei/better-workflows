import { publicDocPath } from "./public-docs.mjs";
import { overlayLocales } from "./locale-overlay.mjs";
import { CONNECTORS_LOCALES } from "./website-locales.mjs";

// Homepage body for the localized public site ("control console" design).
// Copy is authored HTML; every value taken from the shared locale catalog is escaped.
const REPOSITORY = "https://github.com/stephen-taipei/better-workflows";
const RELEASE_URL = `${REPOSITORY}/releases/tag/V5.0.rc1`;
const CINEMA_ASSETS = "/docs/evidence-cinema/assets";
const CAST = [["root", "Captain Root"], ["pixel", "Scout Pixel"], ["ledger", "Ledger"], ["vera", "Vera"], ["sentinel", "Sentinel"], ["echo", "Echo"]];

const esc = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const ic = (name, extra = "") => `<svg class="ic${extra ? ` ${extra}` : ""}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const ext = 'target="_blank" rel="noopener noreferrer"';

const COPY = Object.freeze(overlayLocales({
  "zh-Hant-TW": {
    badge: "V5.0 RC1 已公開上架，GA 仍待完成。",
    h1: "證據齊備，才算完成。",
    h1Signal: "證據不明，就先停下來。",
    heroLead: "Better Workflows 是開源的 AI 工程 QA＋交付守門人，像一位要求嚴格的資深 QA 工程師，替 AI agent 把關每一次交付。只有證據屬於目前的儲存庫、revision、scope 與目標，且能被再次檢查，階段才算通過。",
    taglineLabel: "四項原則",
    ctaInstall: "開始安裝",
    ctaDemo: "看閘門如何運作",
    spec: { title: "發布狀態", since: "2026-10-03", ga: "尚未發布", status: "受控預發布（controlled prerelease）", scope: "macOS × Node.js 22/24 · Codex · Gemini CLI · Qwen Code", notes: "閱讀 RC1 發布說明" },
    demo: {
      title: "閘門走查",
      illus: "示意走查，並非即時執行",
      termLabel: "終端機示意輸出",
      prompt: "&lt;描述你要的結果&gt;",
      lines: [
        ["route", "evidence-required · policy <code>dev-publish-v1</code>"],
        ["goal", "凍結 goal、scope、acceptance 與 authority <em class=\"r ok\">已綁定</em>"],
        ["source", "綁定目前 repository 與 revision，擷取 source sentinel <em class=\"r ok\">新鮮</em>"],
        ["worktree", "建立 task-owned branch 與 worktree，不動你的 checkout <em class=\"r ok\">已隔離</em>"],
        ["execute", "在綁定的 scope 內執行有界工作 <em class=\"r ok\">完成</em>"],
        ["verify", "typed evidence 綁定目前 source，review receipt 齊備 <em class=\"r ok\">通過</em>"],
        ["authority", "此 target 已授權，只允許單一副作用 <em class=\"r ok\">授權</em>"],
        ["act", "執行「一次」外部副作用 <em class=\"r ok\">已送出</em>"]
      ],
      reconcileUnknown: "核對 provider 狀態：回傳 <code>outcome unknown</code> <em class=\"r bad\">未知</em>",
      reconcileConfirmed: "核對 provider 與 repository 狀態 <em class=\"r ok\">一致</em>",
      completeUnknown: "不重試、不宣告完成 <em class=\"r mute\">未抵達</em>",
      completeConfirmed: "重新取樣 sentinel，重驗 acceptance，清理 task-owned 資源 <em class=\"r ok\">完成</em>",
      halt: "provider 結果未知：不重試、不宣告完成，先停下來等你決定。",
      complete: "終態的 provider 與 repository 證據齊備，已清理本任務擁有的 branch 與 worktree。",
      gates: [["目標凍結", "GOAL"], ["來源綁定", "SOURCE"], ["隔離 worktree", "WORKTREE"], ["有界執行", "EXECUTE"], ["證據新鮮且已審查", "VERIFY · GATE"], ["此 target 已授權", "AUTHORITY · GATE"], ["單一副作用", "ACT"], ["核對 provider 狀態", "RECONCILE · GATE"], ["完成並清理", "COMPLETE"]],
      controls: "走查控制", replay: "重播", step: "單步", outcomeLabel: "切換 provider 結果", outcomeKicker: "PROVIDER 結果",
      unknown: "未知 ⇒ 停止", confirmed: "已確認 ⇒ 完成",
      note: "這是示意走查。欄位與狀態僅用來說明閘門如何通過、又在哪裡停下；另一種結局是 provider 結果已確認，流程走到完成。"
    },
    stripLabel: "數字一覽",
    strip: [
      ["102", "型別化證據合約", "typed evidence contracts"],
      ["0", "執行期相依套件", "runtime dependencies"],
      ["1", "公開入口", "<code>$better-workflows:auto</code>"],
      ["3", "Auto 政策", "<code>read-only-v1</code><code>code-change-v1</code><code>dev-publish-v1</code>"],
      ["<small>≥</small>22.14", "Node.js 版本", "隨附 helper 的最低需求"],
      ["2", "公開語言", "en · zh-Hant-TW"]
    ],
    principles: {
      idx: "設計原則", en: "PRINCIPLES",
      title: "Prompt 能描述意圖，<br class=\"br-lg\">卻從不授予權限。",
      lead: "階段只有在證據屬於目前的儲存庫、revision、scope 與目標，且可被再次檢查時才會通過。證據缺漏、過期、衝突或結果未知時，流程會停止並請你決定，而不是假裝任務已完成。",
      pillars: [
        ["root", "只有 Root 能動手", "只有 Root 可以編輯、回併、部署、接受風險或宣告完成。Prompt 只描述意圖，不會授予權限。"],
        ["doc", "行動之前，先有證據", "每個副作用都需要新鮮的證據、清楚的出處，以及綁定預定目標的動作。"],
        ["lock", "失敗時一律關閉", "漂移、過期的證據或未知的 provider 狀態，一律讓流程停止，而不是繼續往前。"]
      ],
      compareTitle: "沒有治理，與有 Better Workflows", compareAspect: "面向", without: "沒有治理", with: "有 Better Workflows",
      compare: [
        ["授權", "Intent 與 authority 混為一談", "Goal、scope 與 authority 是各自獨立的紀錄"],
        ["時效", "通過的檢查可能屬於舊的 revision", "證據綁定目前的 source 與 target"],
        ["重試", "重試可能重複一個外部動作", "嘗試次數有上限，未知的結果會先被核對"],
        ["完成", "「完成」可能只代表指令回傳了", "完成需要終態的 provider 與 repository 證據"],
        ["隔離", "兩個任務編輯同一個 checkout", "會修改 Git 的任務各自使用專屬的 branch 與 worktree"]
      ],
      layersTitle: "權責分層",
      layers: [
        ["Prompt", "記錄想要的結果", "soft", "不授予權限"],
        ["Context", "綁定目前的事實", "", ""],
        ["Harness", "限定誰可以在哪裡行動", "hard", ""],
        ["Loop", "限制重試與核對的次數", "", ""],
        ["Graph", "投影已受理的狀態，不是 scheduler、policy 輸入或權限來源", "soft", "僅投影"]
      ]
    },
    workflow: {
      idx: "工作流程", en: "WORKFLOW",
      title: "風險決定驗證強度，<br class=\"br-lg\">而不是儀式。",
      lead: "清楚、可回復、低風險的變更可以走 Auto 快速路徑，只做小而聚焦的檢查；其餘一律升級為證據工作流，驗證強度與風險相稱。",
      flowTitle: "Auto 的五個步驟",
      routingTitle: "快速路徑，或證據工作流", bindsPolicy: "BINDS ONE POLICY", autoDecides: "AUTO 判斷", autoDecidesText: "依任務與風險，選擇驗證強度",
      fast: { name: "Auto 快速路徑", sub: "清楚、可回復、低風險的變更", body: "只做小而聚焦的 targeted check，不走完整證據流程。", guardsK: "即使走快速路徑，仍然", guards: ["不繞過 protected branch", "不擴大 scope", "不安裝工具", "不略過 task-owned worktree"] },
      evidence: { name: "證據工作流", sub: "其餘所有變更", body: "驗證強度依風險調整；證據必須屬於目前的 source 與 target。", promoteK: "這些檢查會立即升級為證據模式" },
      lifecycleTitle: "用四個問題取代「完成」",
      stages: [
        ["Define", "TaskContract", "目標、範圍、驗收、權限與風險路線，凍結了嗎？", [["", "陳述目標", ""], ["", "綁定範圍與目前脈絡", ""], ["branch", "要修改 Git？", "是 ⇒ 建立或重用 task-owned worktree"]]],
        ["Verify", "Evidence", "證據綁定到目前的原始碼了嗎？", [["", "在界線內執行有界工作", ""], ["gate", "審查並驗證新鮮證據", "source sentinel · typed evidence · graph 與 review receipt"]]],
        ["Reconcile", "Provider truth", "外部副作用的結果，已經確認了嗎？", [["gate stop", "此 target 已授權？", "否／未知 ⇒ 安全停止"], ["", "執行「一次」副作用", "一次性授權"], ["gate stop", "核對 provider 與 repository 狀態", "未知 ⇒ 調查，不盲目重試；安全停止"]]],
        ["Complete", "Terminal decision", "重新取樣之後，驗收仍然成立嗎？", [["", "重新取樣 sentinel，重新驗證 acceptance、ledger、review 與遠端結果", ""], ["end", "完成，並清理本任務擁有的資源", ""]]]
      ],
      replayNote: "<b>Replay 重播的是「判斷」</b>，在已記錄的證據上再做一次決定；它不會重新 push、merge、deploy 或 release。",
      gitTitle: "Git 邊界",
      gitFigTitle: "Git 邊界示意圖",
      gitFigDesc: "你的 checkout 維持不變；修改在專屬的 task branch 與 worktree 完成，並以已檢查的候選版本透過 compare-and-swap 回併。",
      gitFigCheckout: "你的 checkout（唯讀工作留在這裡）",
      gitFigCaption: "修改在專屬 worktree 完成，回併走已檢查的候選版本與 compare-and-swap。",
      gitRules: ["唯讀工作留在原處。", "會修改 Git 的工作一律使用專屬的 task branch 與 task-owned worktree，絕不動你的 checkout。", "回併使用已檢查的候選版本，並以 compare-and-swap 完成。", "只在有證明時，才清理本任務擁有的 branch 與 worktree。", "髒狀態不會被 stash，也不會被隱藏。", "乾淨、由宿主建立的獨占 worktree 會被採用，而不是再巢狀建立一個。"]
    },
    hosts: {
      idx: "支援範圍", en: "HOSTS &amp; PLATFORMS",
      title: "RC1 支援到哪裡，<br class=\"br-lg\">我們直接標出來。",
      lead: "V5.0 RC1 只涵蓋 macOS × Node.js 22/24 上的 Codex、Gemini CLI 與 Qwen Code。Claude Code、Linux 與 Windows 的資格驗收延至 V5.1，目前不算已支援。",
      caption: "V5.0 RC1 公開範圍：宿主與作業系統", hostCol: "宿主", recommended: "官方推薦", rc1: "RC1 公開", deferred: "V5.1 延後",
      matrixNote: "NODE.JS 22/24 · 隨附 helper 需要 ≥ 22.14.0", matrixNoteSub: "V5.1 延後 = 資格驗收尚未完成，不算已支援",
      recoTitle: "官方推薦：macOS + Codex", recoBody: "原生整合最深，是參考體驗最完整的組合。", recoV4: "V4 能力矩陣 · 歷史參考", native: "原生支援",
      recoFoot: "其他宿主透過共用的 core bridge；<code>unverified</code> 與 <code>unavailable</code> 都不算支援。",
      refSummary: "技術細節：V4 歷史支援矩陣（僅供參考）",
      refNote: "下方 V4 支援矩陣屬於歷史資料。目前 RC1 範圍為 macOS、Codex／Gemini CLI／Qwen Code 與 Node 22/24；GA 尚未完成。",
      scrollLabel: "可水平捲動", revision: "網站來源版本"
    },
    install: {
      idx: "開始使用", en: "INSTALL",
      title: "選擇你的宿主，<br class=\"br-lg\">貼上指令。",
      lead: "RC1 在 macOS 上提供 Codex、Gemini CLI 與 Qwen Code 的安裝路徑。隨附的 helper 需要 Node.js 22.14.0 或更新版本。請選擇你信任的本機儲存庫；Better Workflows 不宣稱能隔離惡意的儲存庫程式碼。",
      steps: [
        ["安裝", "選擇你的宿主，複製指令到終端機執行。<span class=\"nb\">官方推薦 macOS + Codex</span>。"],
        ["重新載入", "Codex：開啟「新的」任務，讓 skill 清單更新。Gemini CLI 與 Qwen Code：安裝後重新啟動 session。"],
        ["提出第一個請求", "在對話中輸入 <code>$better-workflows:auto</code>，接著描述你需要的結果。"]
      ],
      stepsNote: "RC1 尚非 GA。完整安裝步驟請見", quickLink: "快速開始",
      tabsLabel: "選擇宿主", recommendedShort: "推薦", copy: "複製", copyCommand: "複製這行指令",
      codexNote: "然後開啟一個「新的」Codex 任務，skill 清單才會更新。", restartNote: "安裝後請重新啟動 session。",
      firstK: "FIRST REQUEST · 第一個請求",
      firstFix: "$better-workflows:auto 檢視這個儲存庫並修正已確認的缺陷。",
      firstRead: "$better-workflows:auto 檢視這個儲存庫並摘要主要部分，不要修改檔案。",
      copyRequest: "複製這個請求", copyReadOnly: "複製這個唯讀請求",
      firstNote: "上面是修正請求，下面是唯讀請求。"
    },
    boundary: {
      idx: "證明邊界", en: "PROOF BOUNDARY",
      title: "能證明的與還不能證明的，<br class=\"br-lg\">都寫在這裡。",
      lead: "我們把話說在前面：它能阻擋哪些錯誤、哪些還沒有被證明，以及它不是什麼。",
      cols: [
        ["yes", "check", "能偵測並阻擋", "可觀測的錯誤", ["錯誤的儲存庫或 revision", "過期的證據（stale evidence）", "虛假的完成宣稱", "未授權的副作用", "未知的 provider 結果", "過早的 cleanup"]],
        ["no", "x", "尚未證明", "長期成效", ["尚未以統計證明，長期多輪的 agent 任務有較低的 scope drift、rework 或決策錯誤率", "無法證明你最初的目標，是正確的產品決策"]],
        ["not", "stop", "它不是", "邊界之外", ["不是 sandbox：不宣稱隔離惡意的儲存庫程式碼，請選擇你信任的本機儲存庫", "不是無限制的 agent runtime", "不會收集敏感或私人的歷史紀錄"]]
      ],
      rulesLabel: "Auto 的三條底線"
    },
    status: {
      idx: "發布狀態與授權", en: "STATUS &amp; LICENSE",
      lead: "RC1 是受控預發行版本，公開入口僅有 Auto。GA 需要的條件與延後的項目都列在下面，不會預先宣稱。",
      now: { kicker: "2026-10-03 公開", ver: "5.0.0-rc.1 · V5.0.rc1", body: "macOS × Node.js 22/24 上的 Codex、Gemini CLI 與 Qwen Code。唯一公開入口是 Auto。" },
      ga: { kicker: "尚未發布", ver: "需要同時滿足", crit: ["至少 30 個自然 canary 日", "20 次連續符合資格的啟動", "三個不同的儲存庫"] },
      next: { kicker: "延至 V5.1", ver: "Claude Code · Linux · Windows", body: "這些宿主與作業系統的資格驗收延至 V5.1，目前尚未發布。" },
      statementTitle: "正式聲明",
      licTitle: "授權與提供狀態", licItem: "項目", licForm: "授權或形式", licState: "狀態",
      lic: [
        ["第一方核心", "<span class=\"mono\">AGPL-3.0-only</span>", "", "ok", "RC1 已公開"],
        ["minimal wire package", "<span class=\"mono\">Apache-2.0</span>", "實體獨立，其 LICENSE 與 NOTICE 適用於該 package", "ok", "RC1 已公開"],
        ["基本產品", "免費", "", "ok", "RC1 已公開"],
        ["Professional Pack", "規劃為專有產品", "", "line", "尚未提供"],
        ["Cloud", "後續獨立的產品", "", "line", "尚未提供"]
      ]
    },
    docs: {
      idx: "文件", en: "DOCS",
      title: "依你的下一步閱讀。",
      lead: "5 個文件頁面，提供 41 種語言版本。想先看一次完整的過程，從 Evidence Cinema 開始。",
      cinemaAlt: "卡通場景：藍色狐狸向舉手攔阻的琥珀色陸龜出示證明，青綠色機器人在一旁等候。",
      cinemaTag: "INTERACTIVE · 互動示範", cinemaK: "EVIDENCE CINEMA · 證據劇場",
      cinemaTitle: "證據不是字幕，它決定結局。",
      cinemaBody: "八幕原創卡通重播：從意圖到可證明完成。可以暫停、倒帶，並切換「證據完整」與「provider outcome unknown」兩種結局。",
      castLabel: "六位原創角色", castNote: "六位原創角色 · sanitized 教學重播，不是 live run", cinemaGo: "進入證據劇場",
      list: [["guide", "文件總覽", "找到適合你下一個任務的使用指南。"], ["quick", "快速開始", "安裝 Better Workflows，執行第一個任務。"], ["use-cases", "使用情境", "從檢查、修改到交付，選擇適合的路線。"], ["use-cases-quick", "實用範例", "複製需求範例，再依照自己的任務調整。"]]
    },
    faq: {
      idx: "常見問題", en: "FAQ",
      title: "常見問題，<br>直接回答。",
      lead: (support) => `沒找到答案？到 <a href="${REPOSITORY}" ${ext}>GitHub</a> 或 <a href="${support}">支援頁面</a> 詢問。`,
      items: [
        ["Better Workflows 是什麼？", "它是開源的 AI 工程 QA＋交付守門人，像一位要求嚴格的資深 QA 工程師，替 AI agent 把關。階段只有在證據屬於目前的儲存庫、revision、scope 與目標，且能被再次檢查時才會通過；證據缺漏、過期、衝突或未知時，流程會停下來請你決定，而不是假裝完成。"],
        ["它會自己推送、合併或部署嗎？", "不會單憑 prompt 就做。Prompt 只描述意圖，從不授予權限。只有 Root 可以編輯、回併、部署、接受風險或宣告完成；每個副作用都需要新鮮證據、出處與綁定預定目標的動作，而且一次只執行一個副作用。"],
        ["小改動也要跑完整流程嗎？", "不用。清楚、可回復的低風險變更可以走 Auto 快速路徑，只做小而聚焦的檢查；其餘會升級為證據工作流。即使走快速路徑，也不會繞過 protected branch、不擴大 scope、不安裝工具，也不略過 task-owned worktree。"],
        ["它會動到我目前的 checkout 嗎？", "唯讀工作留在原處。會修改 Git 的工作一律使用專屬的 task branch 與 task-owned worktree，不會動你的 checkout；髒狀態不會被 stash，也不會被隱藏。"],
        ["RC1 支援哪些環境？Claude Code、Linux 與 Windows 呢？", "V5.0 RC1 的公開範圍是 macOS × Node.js 22/24，搭配 Codex、Gemini CLI 與 Qwen Code；官方推薦 macOS + Codex。Claude Code、Linux 與 Windows 的資格驗收延至 V5.1，目前尚未發布。"],
        ["它能保證程式沒有錯誤嗎？", "不能。它能阻擋錯誤的儲存庫或 revision、stale evidence、未授權副作用與過早 cleanup 等可觀測錯誤，但尚未以統計證明長期任務的 scope drift、rework 或決策錯誤率下降，也無法證明你最初的目標是正確的產品決策。"],
        ["它是 sandbox 嗎？", "不是。它不宣稱隔離惡意的儲存庫程式碼，請選擇你信任的本機儲存庫；它也不是無限制的 agent runtime，並且不會收集敏感或私人的歷史紀錄。"],
        ["授權與費用是什麼？", "第一方核心採 AGPL-3.0-only，實體獨立的 minimal wire package 採 Apache-2.0。基本產品免費；Professional Pack 規劃為專有產品，Cloud 是後續獨立產品，兩者目前尚未提供。"]
      ]
    },
    sponsor: { idx: "贊助", en: "SUPPORT", qrLabel: "在新分頁開啟 USDT（TRC20）QR 圖片", copyAddress: "複製 USDT 地址" },
    cta: { kicker: "V5.0 RC1 · 已公開上架", title: "讓下一次「完成」，<br class=\"br-lg\">有證據可查。", body: "安裝公開的 RC1，從 <code>$better-workflows:auto</code> 開始。GA 仍待完成，這點我們會一直寫在最前面。", notes: "RC1 發布說明" }
  },
  en: {
    badge: "V5.0 RC1 is publicly available. GA remains pending.",
    h1: "Done means proven.",
    h1Signal: "Unclear means stop.",
    heroLead: "Better Workflows is an open-source QA engineer and delivery gatekeeper for AI engineering — a demanding senior reviewer for every agent hand-off. A stage passes only when its evidence belongs to the current repository, revision, scope, and target, and can be checked again.",
    taglineLabel: "Four principles",
    ctaInstall: "Install",
    ctaDemo: "See the gate at work",
    spec: { title: "Status", since: "2026-10-03", ga: "Not released", status: "Controlled prerelease", scope: "macOS × Node.js 22/24 · Codex · Gemini CLI · Qwen Code", notes: "Read the RC1 release notes" },
    demo: {
      title: "gate walkthrough",
      illus: "Illustrative walkthrough, not a live run",
      termLabel: "Illustrative terminal output",
      prompt: "&lt;describe the outcome you need&gt;",
      lines: [
        ["route", "evidence-required · policy <code>dev-publish-v1</code>"],
        ["goal", "Freeze goal, scope, acceptance, and authority <em class=\"r ok\">bound</em>"],
        ["source", "Bind the current repository and revision; take a source sentinel <em class=\"r ok\">fresh</em>"],
        ["worktree", "Create a task-owned branch and worktree; your checkout is untouched <em class=\"r ok\">isolated</em>"],
        ["execute", "Run bounded work inside the bound scope <em class=\"r ok\">done</em>"],
        ["verify", "Typed evidence bound to the current source; review receipt present <em class=\"r ok\">passed</em>"],
        ["authority", "This target is authorized for a single side effect <em class=\"r ok\">granted</em>"],
        ["act", "Perform ONE external side effect <em class=\"r ok\">sent</em>"]
      ],
      reconcileUnknown: "Reconcile provider state: returned <code>outcome unknown</code> <em class=\"r bad\">unknown</em>",
      reconcileConfirmed: "Reconcile provider and repository state <em class=\"r ok\">consistent</em>",
      completeUnknown: "No retry, no completion claim <em class=\"r mute\">not reached</em>",
      completeConfirmed: "Re-take the sentinel, re-verify acceptance, clean task-owned resources <em class=\"r ok\">complete</em>",
      halt: "Provider outcome unknown: no retry, no completion claim. The run stops and waits for your decision.",
      complete: "Terminal provider and repository evidence is in place; the task-owned branch and worktree are cleaned up.",
      gates: [["Goal frozen", "GOAL"], ["Source bound", "SOURCE"], ["Worktree isolated", "WORKTREE"], ["Bounded execution", "EXECUTE"], ["Fresh, reviewed evidence", "VERIFY · GATE"], ["Target authorized", "AUTHORITY · GATE"], ["Single side effect", "ACT"], ["Provider state reconciled", "RECONCILE · GATE"], ["Complete and clean up", "COMPLETE"]],
      controls: "Walkthrough controls", replay: "Replay", step: "Step", outcomeLabel: "Choose the provider outcome", outcomeKicker: "PROVIDER OUTCOME",
      unknown: "Unknown ⇒ stop", confirmed: "Confirmed ⇒ complete",
      note: "This is an illustrative walkthrough. Fields and states only show where gates pass and where the run stops; the alternative ending confirms the provider outcome and the run completes."
    },
    stripLabel: "At a glance",
    strip: [
      ["102", "Typed evidence contracts", "evidence-contracts-v1"],
      ["0", "Runtime dependencies", "zero third-party packages"],
      ["1", "Public entrypoint", "<code>$better-workflows:auto</code>"],
      ["3", "Auto policies", "<code>read-only-v1</code><code>code-change-v1</code><code>dev-publish-v1</code>"],
      ["<small>≥</small>22.14", "Node.js version", "minimum for the bundled helper"],
      ["2", "Public languages", "en · zh-Hant-TW"]
    ],
    principles: {
      idx: "Principles", en: "PRINCIPLES",
      title: "A prompt can describe intent.<br class=\"br-lg\"> It never grants authority.",
      lead: "A stage passes only when its evidence belongs to the current repository, revision, scope, and target, and can be checked again. If evidence is missing, stale, conflicting, or the outcome is unknown, the workflow stops and asks you to decide instead of pretending the task is done.",
      pillars: [
        ["root", "Root-owned mutation", "Only Root may edit, integrate, deploy, accept risk, or declare completion. A prompt describes intent; it does not grant authority."],
        ["doc", "Evidence before action", "Every side effect requires fresh evidence, provenance, and an action bound to the intended target."],
        ["lock", "Fail closed", "Drift, stale evidence, or an unknown provider state always stops the workflow instead of pushing ahead."]
      ],
      compareTitle: "Without governance vs. with Better Workflows", compareAspect: "Aspect", without: "Without governance", with: "With Better Workflows",
      compare: [
        ["Authority", "Intent and authority are conflated", "Goal, scope, and authority are separate records"],
        ["Freshness", "A passing check may belong to an old revision", "Evidence is bound to the current source and target"],
        ["Retries", "A retry may duplicate an external action", "Attempts are bounded and unknown outcomes are reconciled"],
        ["Done", "“Done” can mean “the command returned”", "Completion requires terminal provider and repository evidence"],
        ["Isolation", "Two tasks edit one checkout", "Mutating Git tasks use separately owned branches and worktrees"]
      ],
      layersTitle: "Authority layers",
      layers: [
        ["Prompt", "Records the outcome you want", "soft", "Grants no authority"],
        ["Context", "Binds current facts", "", ""],
        ["Harness", "Limits who may act and where", "hard", ""],
        ["Loop", "Bounds retries and reconciliation", "", ""],
        ["Graph", "Projects admitted state; never a scheduler, policy input, or authority source", "soft", "Projection only"]
      ]
    },
    workflow: {
      idx: "Workflow", en: "WORKFLOW",
      title: "Risk sets the verification,<br class=\"br-lg\"> not ceremony.",
      lead: "A clear, reversible, low-risk change may use Auto's fast path with a small targeted check. Everything else is promoted to the evidence workflow, with verification strength matched to the risk.",
      flowTitle: "Auto in five steps",
      routingTitle: "Fast path or evidence workflow", bindsPolicy: "BINDS ONE POLICY", autoDecides: "AUTO DECIDES", autoDecidesText: "Verification strength follows the task and its risk",
      fast: { name: "Auto fast path", sub: "Clear, reversible, low-risk changes", body: "A small, focused targeted check instead of the full evidence workflow.", guardsK: "Even on the fast path, it still", guards: ["never bypasses a protected branch", "never widens the scope", "never installs tools", "never skips the task-owned worktree"] },
      evidence: { name: "Evidence workflow", sub: "Everything else", body: "Verification strength matches the risk; evidence must belong to the current source and target.", promoteK: "These checks promote to evidence mode immediately" },
      lifecycleTitle: "Four questions replace “done”",
      stages: [
        ["Define", "TaskContract", "Are the goal, scope, acceptance, authority, and route frozen?", [["", "State the goal", ""], ["", "Bind scope and current context", ""], ["branch", "Git mutation?", "Yes ⇒ create or reuse a task-owned worktree"]]],
        ["Verify", "Evidence", "Is the evidence bound to the current source?", [["", "Execute bounded work", ""], ["gate", "Review and validate fresh evidence", "source sentinel · typed evidence · graph and review receipts"]]],
        ["Reconcile", "Provider truth", "Is the outcome of the external side effect confirmed?", [["gate stop", "Authorized for this target?", "No / unknown ⇒ stop safely"], ["", "Perform ONE side effect", "single-use authority"], ["gate stop", "Reconcile provider and repository state", "Unknown ⇒ investigate, never blindly retry; stop safely"]]],
        ["Complete", "Terminal decision", "After re-sampling, does acceptance still hold?", [["", "Re-take the sentinel; re-verify acceptance, ledger, review, and remote result", ""], ["end", "Complete and clean owned resources", ""]]]
      ],
      replayNote: "<b>Replay repeats the decision</b> over the recorded evidence; it never repeats push, merge, deploy, or release.",
      gitTitle: "Git boundaries",
      gitFigTitle: "Git boundary diagram",
      gitFigDesc: "Your checkout stays untouched; changes happen in a task-owned branch and worktree and are integrated from a checked candidate with compare-and-swap.",
      gitFigCheckout: "your checkout (read-only work stays here)",
      gitFigCaption: "Changes happen in an owned worktree; integration uses a checked candidate and compare-and-swap.",
      gitRules: ["Read-only work stays in place.", "Mutating Git work always uses its own task branch and task-owned worktree — never your checkout.", "Integration uses a checked candidate and a compare-and-swap update.", "Only task-owned branches and worktrees are cleaned, and only with proof.", "Dirty state is never stashed or hidden.", "A clean, exclusive worktree created by the host is adopted instead of nesting another one."]
    },
    hosts: {
      idx: "Hosts", en: "HOSTS &amp; PLATFORMS",
      title: "Exactly where RC1 runs,<br class=\"br-lg\"> stated plainly.",
      lead: "V5.0 RC1 covers Codex, Gemini CLI, and Qwen Code on macOS × Node.js 22/24 only. Claude Code, Linux, and Windows qualification is deferred to V5.1 and is not support today.",
      caption: "V5.0 RC1 public scope: hosts and operating systems", hostCol: "Host", recommended: "Recommended", rc1: "RC1 public", deferred: "V5.1 deferred",
      matrixNote: "NODE.JS 22/24 · bundled helper needs ≥ 22.14.0", matrixNoteSub: "V5.1 deferred = qualification not finished; not support",
      recoTitle: "Official recommendation: macOS + Codex", recoBody: "The deepest native integration and the complete reference experience.", recoV4: "V4 capability matrix · historical", native: "native support",
      recoFoot: "Other hosts use the shared core bridge; <code>unverified</code> and <code>unavailable</code> are not support.",
      refSummary: "Technical details: V4 historical support matrix (reference only)",
      refNote: "The V4 matrices below are historical. Current RC1 supports macOS with Codex, Gemini CLI and Qwen Code on Node 22/24; GA remains pending.",
      scrollLabel: "scrolls horizontally", revision: "Site source revision"
    },
    install: {
      idx: "Install", en: "INSTALL",
      title: "Pick your host.<br class=\"br-lg\"> Paste the commands.",
      lead: "RC1 ships install paths for Codex, Gemini CLI, and Qwen Code on macOS. The bundled helper needs Node.js 22.14.0 or newer. Use a repository you trust; Better Workflows does not claim to sandbox malicious repository code.",
      steps: [
        ["Install", "Choose your host and run the commands in a terminal. The official recommendation is macOS + Codex."],
        ["Reload", "Codex: open a new task so the skill list refreshes. Gemini CLI and Qwen Code: restart the session after installing."],
        ["Make a first request", "Type <code>$better-workflows:auto</code>, then describe the outcome you need."]
      ],
      stepsNote: "RC1 is not GA. For every install step, see", quickLink: "Quick start",
      tabsLabel: "Choose a host", recommendedShort: "Recommended", copy: "Copy", copyCommand: "Copy this command",
      codexNote: "Then open a new Codex task so its skill list refreshes.", restartNote: "Restart the session after installing.",
      firstK: "FIRST REQUEST",
      firstFix: "$better-workflows:auto Review this repository and fix verified defects.",
      firstRead: "$better-workflows:auto Review this repository and summarize its main parts. Do not change files.",
      copyRequest: "Copy this request", copyReadOnly: "Copy this read-only request",
      firstNote: "The first request fixes verified defects; the second is read-only."
    },
    boundary: {
      idx: "Proof boundary", en: "PROOF BOUNDARY",
      title: "What it proves, and what it doesn't —<br class=\"br-lg\"> written down.",
      lead: "Up front: the errors it can block, what has not been proven yet, and what it is not.",
      cols: [
        ["yes", "check", "Detects and blocks", "Observable errors", ["The wrong repository or revision", "Stale evidence", "A false completion claim", "An unauthorized side effect", "An unknown provider outcome", "Premature cleanup"]],
        ["no", "x", "Not proven yet", "Long-term outcomes", ["Not statistically proven to lower scope drift, rework, or decision-error rates in multi-turn agent work", "Cannot prove that your original goal was the right product decision"]],
        ["not", "stop", "It is not", "Outside the boundary", ["Not a sandbox: it does not claim to isolate malicious repository code — use a repository you trust", "Not an unlimited agent runtime", "It never harvests sensitive or private history"]]
      ],
      rulesLabel: "Auto's three standing rules"
    },
    status: {
      idx: "Status &amp; license", en: "STATUS &amp; LICENSE",
      lead: "RC1 is a controlled prerelease with Auto as the only public entrypoint. The GA conditions and deferred items are listed below — nothing is claimed early.",
      now: { kicker: "Public since 2026-10-03", ver: "5.0.0-rc.1 · V5.0.rc1", body: "Codex, Gemini CLI, and Qwen Code on macOS × Node.js 22/24. Auto is the only public entrypoint." },
      ga: { kicker: "Not released", ver: "Requires all of", crit: ["At least 30 natural canary days", "20 consecutive eligible starts", "Three distinct repositories"] },
      next: { kicker: "Deferred to V5.1", ver: "Claude Code · Linux · Windows", body: "Qualification for these hosts and operating systems is deferred to V5.1 and not yet released." },
      statementTitle: "Statement of record",
      licTitle: "Licensing and availability", licItem: "Item", licForm: "License or form", licState: "Status",
      lic: [
        ["First-party core", "<span class=\"mono\">AGPL-3.0-only</span>", "", "ok", "Public in RC1"],
        ["Minimal wire package", "<span class=\"mono\">Apache-2.0</span>", "Physically separate; its LICENSE and NOTICE apply to that package", "ok", "Public in RC1"],
        ["Basic product", "Free", "", "ok", "Public in RC1"],
        ["Professional Pack", "Planned as proprietary", "", "line", "Not available"],
        ["Cloud", "Separate later product", "", "line", "Not available"]
      ]
    },
    docs: {
      idx: "Docs", en: "DOCS",
      title: "Read for your next step.",
      lead: "Five documentation pages, available in 41 languages. To see the whole process first, start with Evidence Cinema.",
      cinemaAlt: "Cartoon scene: a blue fox shows a glowing token to an amber tortoise who raises a hand to stop it, while a teal robot waits nearby.",
      cinemaTag: "INTERACTIVE DEMO", cinemaK: "EVIDENCE CINEMA",
      cinemaTitle: "Evidence isn't a subtitle. It decides the ending.",
      cinemaBody: "An eight-scene original cartoon replay from intent to provable completion. Pause, rewind, and switch between the “evidence complete” and “provider outcome unknown” endings.",
      castLabel: "Six original characters", castNote: "Six original characters · a sanitized teaching replay, not a live run", cinemaGo: "Enter Evidence Cinema",
      list: [["guide", "Documentation", "Find the right guide for your next task."], ["quick", "Quick start", "Install Better Workflows and run your first task."], ["use-cases", "Use cases", "Choose a path for reviewing, changing code, or delivery."], ["use-cases-quick", "Practical examples", "Start with a request you can adapt to your work."]]
    },
    faq: {
      idx: "FAQ", en: "FAQ",
      title: "Common questions,<br> straight answers.",
      lead: (support) => `Still unsure? Ask on <a href="${REPOSITORY}" ${ext}>GitHub</a> or visit the <a href="${support}">support page</a>.`,
      items: [
        ["What is Better Workflows?", "An open-source QA engineer and delivery gatekeeper for AI engineering — a demanding senior reviewer for AI agents. A stage passes only when its evidence belongs to the current repository, revision, scope, and target and can be checked again; when evidence is missing, stale, conflicting, or unknown, the workflow stops and asks you to decide instead of pretending it is done."],
        ["Will it push, merge, or deploy on its own?", "Not because a prompt said so. A prompt describes intent; it never grants authority. Only Root may edit, integrate, deploy, accept risk, or declare completion, and every side effect needs fresh evidence, provenance, and an action bound to the intended target — one side effect at a time."],
        ["Does every small change run the full process?", "No. A clear, reversible, low-risk change can use Auto's fast path with a small focused check; everything else is promoted to the evidence workflow. Even the fast path never bypasses a protected branch, widens scope, installs tools, or skips the task-owned worktree."],
        ["Will it touch my current checkout?", "Read-only work stays in place. Mutating Git work always uses its own task branch and task-owned worktree, never your checkout, and dirty state is never stashed or hidden."],
        ["What does RC1 support? What about Claude Code, Linux, and Windows?", "The V5.0 RC1 public scope is macOS × Node.js 22/24 with Codex, Gemini CLI, or Qwen Code; the official recommendation is macOS + Codex. Claude Code, Linux, and Windows qualification is deferred to V5.1 and not yet released."],
        ["Does it guarantee bug-free code?", "No. It can block observable errors such as the wrong repository or revision, stale evidence, unauthorized side effects, and premature cleanup, but it has not been statistically proven to lower scope drift, rework, or decision-error rates in long-running tasks, and it cannot prove your original goal was the right product decision."],
        ["Is it a sandbox?", "No. It does not claim to isolate malicious repository code, so use a repository you trust. It is not an unlimited agent runtime, and it never harvests sensitive or private history."],
        ["What does it cost, and how is it licensed?", "The first-party core is AGPL-3.0-only; the physically separate minimal wire package is Apache-2.0. The basic product is free. Professional Pack is planned as proprietary and Cloud is a separate later product; neither is available yet."]
      ]
    },
    sponsor: { idx: "Sponsor", en: "SUPPORT", qrLabel: "Open the USDT (TRC20) QR image in a new tab", copyAddress: "Copy the USDT address" },
    cta: { kicker: "V5.0 RC1 · publicly available", title: "Make the next “done”<br class=\"br-lg\"> something you can check.", body: "Install the public RC1 and start with <code>$better-workflows:auto</code>. GA is still pending, and we will keep saying so up front.", notes: "RC1 release notes" }
  }
}, "homepage-copy", CONNECTORS_LOCALES));

function secHead(idx, number, en, titleId, title, lead) {
  return `<header class="sec-head"><p class="home-eyebrow mono"><span class="idx">${number}</span>${idx}<span class="en">${en}</span></p><h2 id="${titleId}">${title}</h2>${lead ? `<p class="lead">${lead}</p>` : ""}</header>`;
}

function copyButton(label, text) {
  return `<button class="copy" type="button" data-copy aria-label="${esc(label)}">${ic("copy", "ic-copy")}${ic("check", "ic-ok")}<span class="copy-t">${text}</span></button>`;
}

function cmd(command, label, text, chat = false) {
  return `<div class="cmd${chat ? " cmd-chat" : ""}"><span class="cmd-p" aria-hidden="true">${chat ? "›" : "$"}</span><code>${esc(command)}</code>${copyButton(label, text)}</div>`;
}

// The shared host registry renders plain tables; add scroll regions and state classes for this design.
function decorateHostMatrix(html, label) {
  return html
    .replace(/<table class="(support-matrix|capability-matrix)">/g, (_, cls) => `<div class="table-scroll" tabindex="0" role="region" aria-label="${esc(`${cls === "support-matrix" ? "V4 support matrix" : "V4 capability matrix"} · ${label}`)}"><table class="${cls}">`)
    .replace(/<\/table>/g, "</table></div>")
    .replace(/<td><code>(native|unverified|unavailable)<\/code><\/td>/g, (_, state) => `<td><code class="s-${state === "native" ? "n" : state === "unverified" ? "v" : "u"}">${state}</code></td>`);
}

/**
 * Render the homepage <main> body.
 * ctx: { messages, v5Product, hostMatrixHtml, revision, sponsor: { address, qr, cta, title, body } }
 */
export function renderHomepageContent(code, ctx) {
  const t = COPY[code];
  if (!t) throw new Error(`Unsupported homepage locale: ${code}`);
  const { messages: m, v5Product: v5, hostMatrixHtml, revision, sponsor } = ctx;
  for (const field of ["eyebrow", "title", "boundary", "scope", "license", "plan"]) {
    if (typeof v5?.[field] !== "string" || !v5[field].trim()) throw new Error(`Missing complete V5 product copy: ${code}`);
  }
  const prefix = code === "en" ? "/en" : "";
  const autoFlow = String(m.V4_AUTO_FLOW).split("|").map((item) => item.trim()).filter(Boolean);
  const boundaries = String(m.V4_BOUNDARIES).split("|").map((item) => item.trim()).filter(Boolean);
  if (autoFlow.length !== 5 || boundaries.length !== 3) throw new Error(`Incomplete Auto flow or boundary copy: ${code}`);
  const d = t.demo;
  const gates = d.gates.map(([name, kind], i) => {
    const n = i + 1;
    const state = n === 8 ? "blocked" : n === 9 ? "skip" : "pass";
    const label = state === "blocked" ? "BLOCKED" : state === "skip" ? "NOT REACHED" : "PASS";
    return `<li class="gate${/GATE/.test(kind) ? " is-decision" : ""}" data-gate="${n}" data-state="${state}"><i class="g-led" aria-hidden="true"></i><span class="g-name">${name}<small>${kind}</small></span><span class="g-state mono">${label}</span></li>`;
  }).join("");
  const lines = d.lines.map(([key, text], i) => `<li class="tl" data-step="${i === 0 ? "0.5" : i}"><span class="tl-sym" aria-hidden="true">›</span><span class="tl-k">${key}</span><span class="tl-t">${text}</span></li>`).join("");
  const docsPath = (id) => publicDocPath(code, id);

  return `<main id="main">
<section class="home-hero" id="product" aria-labelledby="home-title">
  <div class="hero-bg" aria-hidden="true"></div>
  <div class="shell">
    <div class="hero-top">
      <div class="home-hero-copy">
        <a class="badge" href="#v5-status"><i class="led" aria-hidden="true"></i><b>5.0.0-rc.1</b><span>${t.badge}</span>${ic("arrow")}</a>
        <h1 id="home-title">${t.h1}<br><span class="h1-signal">${t.h1Signal}</span></h1>
        <p class="lead">${t.heroLead}</p>
        <ul class="tagline mono" aria-label="${t.taglineLabel}"><li>Goal-first</li><li>Evidence-driven</li><li>Fail-closed</li><li>Risk-adaptive</li></ul>
        <div class="cta-row">
          <a class="btn btn-primary" href="#install">${t.ctaInstall}${ic("arrow")}</a>
          <a class="btn btn-ghost" href="#gate-demo">${t.ctaDemo}${ic("down")}</a>
          <a class="link-quiet" href="${REPOSITORY}" ${ext}>GitHub${ic("ext")}</a>
        </div>
      </div>
      <aside class="spec" aria-labelledby="spec-title">
        <div class="spec-head"><i class="led led-live" aria-hidden="true"></i><h2 id="spec-title" class="mono">RELEASE <span>${t.spec.title}</span></h2></div>
        <dl class="spec-list">
          <div><dt>VERSION</dt><dd class="mono">5.0.0-rc.1</dd></div>
          <div><dt>TAG</dt><dd class="mono">V5.0.rc1</dd></div>
          <div><dt>SINCE</dt><dd class="mono">${t.spec.since} <span class="dim">Asia/Taipei</span></dd></div>
          <div><dt>GA 5.0.0</dt><dd><span class="pill pill-warn">${t.spec.ga}</span></dd></div>
          <div><dt>STATUS</dt><dd>${t.spec.status}</dd></div>
          <div><dt>SCOPE</dt><dd>${t.spec.scope}</dd></div>
        </dl>
        <a class="spec-foot" href="${RELEASE_URL}" ${ext}>${t.spec.notes}${ic("ext")}</a>
      </aside>
    </div>
    <section class="console inst" id="gate-demo" aria-labelledby="demo-title" data-demo data-outcome="unknown" data-run="done">
      <span class="tick t-tl" aria-hidden="true"></span><span class="tick t-tr" aria-hidden="true"></span>
      <div class="console-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><h2 id="demo-title" class="mono console-title">gate-demo <span>· ${d.title}</span></h2><span class="illus mono">${ic("stop")}${d.illus}</span></div>
      <div class="console-body">
        <div class="term" role="group" aria-label="${d.termLabel}">
          <ol class="term-log" data-term>
            <li class="tl tl-cmd" data-step="0"><span class="tl-sym" aria-hidden="true">$</span><span class="tl-t"><b>$better-workflows:auto</b> ${d.prompt}</span></li>
            ${lines}
            <li class="tl" data-step="8"><span class="tl-sym" aria-hidden="true">›</span><span class="tl-k">reconcile</span><span class="tl-t"><span data-for="unknown">${d.reconcileUnknown}</span><span data-for="confirmed">${d.reconcileConfirmed}</span></span></li>
            <li class="tl" data-step="9"><span class="tl-sym" aria-hidden="true">›</span><span class="tl-k">complete</span><span class="tl-t"><span data-for="unknown">${d.completeUnknown}</span><span data-for="confirmed">${d.completeConfirmed}</span></span></li>
          </ol>
          <div class="verdict-slot">
            <p class="term-verdict" data-verdict data-for-state="halt"><strong class="mono">${ic("stop")}STOPPED SAFELY</strong><span>${d.halt}</span></p>
            <p class="term-verdict term-verdict-ok" data-verdict data-for-state="complete"><strong class="mono">${ic("check")}COMPLETE</strong><span>${d.complete}</span></p>
          </div>
        </div>
        <div class="gates" role="group" aria-labelledby="gates-title">
          <div class="gates-head mono"><h3 id="gates-title">GATE STATE</h3><span data-progress>STOPPED AT 08 / 09</span></div>
          <ol class="gate-list">${gates}</ol>
        </div>
      </div>
      <div class="console-foot">
        <div class="ctl" role="group" aria-label="${d.controls}"><button class="ctl-btn" type="button" data-act="replay">${ic("replay")}${d.replay}</button><button class="ctl-btn" type="button" data-act="step">${ic("step")}${d.step}</button></div>
        <div class="seg ctl" role="group" aria-label="${d.outcomeLabel}"><span class="seg-label mono">${d.outcomeKicker}</span><span class="seg-box"><button type="button" class="seg-btn is-on" data-outcome-set="unknown" aria-pressed="true">${d.unknown}</button><button type="button" class="seg-btn" data-outcome-set="confirmed" aria-pressed="false">${d.confirmed}</button></span></div>
        <p class="foot-note">${d.note}</p>
      </div>
      <p class="sr-only" role="status" aria-live="polite" data-live></p>
    </section>
  </div>
</section>

<section class="shell strip-wrap" aria-label="${t.stripLabel}">
  <ul class="strip">${t.strip.map(([num, label, sub]) => `<li><span class="num mono">${num}</span><span class="cap"><b>${label}</b>${sub}</span></li>`).join("")}</ul>
</section>

<section class="sec shell" id="principles" aria-labelledby="principles-title">
  ${secHead(t.principles.idx, "01", t.principles.en, "principles-title", t.principles.title, t.principles.lead)}
  <ul class="pillars">${t.principles.pillars.map(([iconName, title, body], i) => `<li class="pillar"><svg class="ic-lg" aria-hidden="true"><use href="#i-${iconName}"/></svg><p class="mono kick">TRUST 0${i + 1}</p><h3>${title}</h3><p>${body}</p></li>`).join("")}</ul>
  <div class="split">
    <div class="compare-wrap">
      <h3 class="blk-title mono">WITHOUT <i>vs</i> WITH<span>${t.principles.compareTitle}</span></h3>
      <div class="tbl-card"><table class="compare">
        <thead><tr><th scope="col"><span class="sr-only">${t.principles.compareAspect}</span></th><th scope="col">${t.principles.without}</th><th scope="col">${t.principles.with}</th></tr></thead>
        <tbody>${t.principles.compare.map(([aspect, before, after]) => `<tr><th scope="row" class="mono">${aspect}</th><td>${before}</td><td>${after}</td></tr>`).join("")}</tbody>
      </table></div>
    </div>
    <figure class="stack">
      <h3 class="blk-title mono">AUTHORITY LAYERS<span>${t.principles.layersTitle}</span></h3>
      <ol class="stack-list">${t.principles.layers.map(([name, body, tone, pill], i) => `<li class="lyr${tone ? ` lyr-${tone}` : ""}"><span class="lyr-n mono">L${i + 1}</span><div><b class="mono">${name}</b><p>${body}</p></div>${pill ? `<span class="pill pill-line">${pill}</span>` : ""}</li>`).join("")}</ol>
    </figure>
  </div>
</section>

<section class="sec shell" id="workflow" aria-labelledby="workflow-title">
  ${secHead(t.workflow.idx, "02", t.workflow.en, "workflow-title", t.workflow.title, t.workflow.lead)}
  <div class="blk" id="auto-flow">
    <h3 class="blk-title mono">AUTO FLOW<span>${t.workflow.flowTitle}</span></h3>
    <ol class="auto-flow-list">${autoFlow.map((item) => `<li>${esc(item)}</li>`).join("")}</ol>
  </div>
  <div class="blk">
    <h3 class="blk-title mono">ROUTING<span>${t.workflow.routingTitle}</span></h3>
    <div class="router card">
      <div class="router-a"><span class="mono kick">ENTRYPOINT</span><code>$better-workflows:auto</code></div>
      ${ic("arrow", "router-arrow")}
      <div class="router-b"><span class="mono kick">${t.workflow.bindsPolicy}</span><span class="chips"><code>read-only-v1</code><code>code-change-v1</code><code>dev-publish-v1</code></span></div>
      ${ic("arrow", "router-arrow")}
      <div class="router-c"><span class="mono kick">${t.workflow.autoDecides}</span><b>${t.workflow.autoDecidesText}</b></div>
    </div>
    <div class="lanes">
      <article class="lane card">
        <header><span class="tag mono">FAST PATH</span><h4>${t.workflow.fast.name}</h4><p class="sub">${t.workflow.fast.sub}</p></header>
        <p>${t.workflow.fast.body}</p>
        <p class="mono kick guard-k">${t.workflow.fast.guardsK}</p>
        <ul class="guards">${t.workflow.fast.guards.map((g) => `<li>${ic("check")}${g}</li>`).join("")}</ul>
      </article>
      <article class="lane lane-ev card">
        <header><span class="tag tag-sig mono">EVIDENCE WORKFLOW</span><h4>${t.workflow.evidence.name}</h4><p class="sub">${t.workflow.evidence.sub}</p></header>
        <p>${t.workflow.evidence.body}</p>
        <p class="mono kick guard-k">${t.workflow.evidence.promoteK}</p>
        <ul class="chips chips-up"><li><code>package-manager</code></li><li><code>network</code></li><li><code>child-process</code></li><li><code>native</code></li><li><code>checkout-external</code></li></ul>
      </article>
    </div>
  </div>
  <div class="blk">
    <h3 class="blk-title mono">LIFECYCLE<span>${t.workflow.lifecycleTitle}</span></h3>
    <div class="lifecycle" data-lifecycle>
      <ol class="lc-stages">${(() => { let i = 0; return t.workflow.stages.map(([name, codeName, question, nodes], s) => `<li class="lc-stage"><header><span class="lc-n mono">0${s + 1}</span><div><h4>${name}</h4><span class="mono lc-code">${codeName}</span></div></header><p class="lc-q">${question}</p><ol class="lc-nodes">${nodes.map(([kind, text, small]) => `<li class="lc-node${kind.split(" ").filter(Boolean).filter((k) => k !== "stop").map((k) => ` lc-${k}`).join("")}" style="--i:${i++}"><span class="lc-dot" aria-hidden="true"></span>${text}${small ? `<small${kind.includes("stop") ? ' class="lc-stop"' : ""}>${small}</small>` : ""}</li>`).join("")}</ol></li>`).join(""); })()}</ol>
      <p class="lc-note">${ic("replay")}<span>${t.workflow.replayNote}</span></p>
    </div>
  </div>
  <div class="blk">
    <h3 class="blk-title mono">GIT SAFETY<span>${t.workflow.gitTitle}</span></h3>
    <div class="git-grid">
      <figure class="git-fig card">
        <svg viewBox="0 0 360 190" role="img" aria-labelledby="git-t git-d">
          <title id="git-t">${t.workflow.gitFigTitle}</title>
          <desc id="git-d">${t.workflow.gitFigDesc}</desc>
          <g class="gf-line"><path d="M20 48H340"/><path class="gf-br" d="M80 48C100 48 100 130 130 130H250C280 130 280 48 300 48"/></g>
          <g class="gf-dot"><circle cx="20" cy="48" r="4.5"/><circle cx="80" cy="48" r="4.5"/><circle cx="300" cy="48" r="4.5"/><circle cx="340" cy="48" r="4.5"/><circle class="sig" cx="145" cy="130" r="5"/><circle class="sig" cx="190" cy="130" r="5"/><circle class="sig" cx="235" cy="130" r="5"/></g>
          <g class="gf-txt"><text x="20" y="24">${t.workflow.gitFigCheckout}</text><text x="130" y="160" class="sig-t">task branch + task-owned worktree</text><text x="308" y="104" class="sig-t mono">CAS</text></g>
        </svg>
        <figcaption>${t.workflow.gitFigCaption}</figcaption>
      </figure>
      <ul class="git-rules">${t.workflow.gitRules.map((rule, i) => `<li><span class="mono">G${i + 1}</span><p>${rule}</p></li>`).join("")}</ul>
    </div>
  </div>
</section>

<section class="sec shell" id="hosts" aria-labelledby="hosts-title">
  ${secHead(t.hosts.idx, "03", t.hosts.en, "hosts-title", t.hosts.title, t.hosts.lead)}
  <div class="hosts-grid">
    <div class="matrix-card card">
      <table class="rc-matrix">
        <caption class="sr-only">${t.hosts.caption}</caption>
        <thead><tr><th scope="col"><span class="sr-only">${t.hosts.hostCol}</span></th><th scope="col" class="mono">macOS</th><th scope="col" class="mono">Linux</th><th scope="col" class="mono">Windows</th></tr></thead>
        <tbody>${[["Codex", true, true], ["Gemini CLI", false, true], ["Qwen Code", false, true], ["Claude Code", false, false]].map(([host, rec, mac]) => `<tr><th scope="row"><b>${host}</b>${rec ? `<span class="pill pill-sig">${t.hosts.recommended}</span>` : ""}</th>${mac ? `<td class="c-rc1"><i class="led" aria-hidden="true"></i>${t.hosts.rc1}</td>` : `<td class="c-def">${t.hosts.deferred}</td>`}<td class="c-def">${t.hosts.deferred}</td><td class="c-def">${t.hosts.deferred}</td></tr>`).join("")}</tbody>
      </table>
      <p class="matrix-note mono"><i class="led" aria-hidden="true"></i>${t.hosts.matrixNote}<span>${t.hosts.matrixNoteSub}</span></p>
    </div>
    <aside class="reco card" aria-labelledby="reco-title">
      <p class="mono kick">REFERENCE EXPERIENCE</p>
      <h3 id="reco-title">${t.hosts.recoTitle}</h3>
      <p>${t.hosts.recoBody}</p>
      <p class="mono kick reco-k">${t.hosts.recoV4}</p>
      <p class="reco-line"><code class="native">native</code>${t.hosts.native}</p>
      <ul class="chips"><li><code>task-contract</code></li><li><code>typed-evidence</code></li><li><code>replay</code></li><li><code>action-gate</code></li><li><code>native-picker</code></li><li><code>native-subagents</code></li></ul>
      <p class="reco-foot">${t.hosts.recoFoot}</p>
    </aside>
  </div>
  <details class="technical-reference" data-reference>
    <summary><span class="tr-t">${ic("chev")}${t.hosts.refSummary}</span><span class="mono tr-c">HOST-SUPPORT-V1</span></summary>
    <div class="tr-body">
      <p class="tr-note">${t.hosts.refNote}</p>
      <div class="v4-ref" id="host-support">
        <p class="home-eyebrow mono">V4 · HOST-SUPPORT-V1</p>
        <h3>V4 AI / OS capability matrix</h3>
        <div class="v4-copy"><p class="v4-pos">${esc(m.V4_POSITIONING)}</p><p>${esc(m.V4_RISK_LEAD)}</p><p>${esc(m.V4_SUMMARY)}</p></div>
        ${decorateHostMatrix(hostMatrixHtml, t.hosts.scrollLabel)}
        <p class="v4-recommended">${esc(m.V4_RECOMMENDED)}</p>
        <p class="tr-rev">${t.hosts.revision}：<code>${esc(revision)}</code></p>
      </div>
    </div>
  </details>
</section>

<section class="sec shell" id="install" aria-labelledby="install-title">
  ${secHead(t.install.idx, "04", t.install.en, "install-title", t.install.title, t.install.lead)}
  <div class="install-grid">
    <ol class="steps">
      ${t.install.steps.map(([title, body], i) => `<li><span class="mono n">${i + 1}</span><div><h3>${title}</h3><p>${body}</p></div></li>`).join("")}
      <li class="steps-note"><p>${t.install.stepsNote} <a href="${docsPath("quick")}">${t.install.quickLink}${ic("arrow")}</a></p></li>
    </ol>
    <div class="install-term inst" data-tabs>
      <div class="tablist" role="tablist" aria-label="${t.install.tabsLabel}">
        <button type="button" role="tab" id="tab-codex" aria-controls="panel-codex" aria-selected="true">Codex<span class="pill pill-sig">${t.install.recommendedShort}</span></button>
        <button type="button" role="tab" id="tab-gemini" aria-controls="panel-gemini" aria-selected="false" tabindex="-1">Gemini CLI</button>
        <button type="button" role="tab" id="tab-qwen" aria-controls="panel-qwen" aria-selected="false" tabindex="-1">Qwen Code</button>
      </div>
      <div class="tabpanel" role="tabpanel" id="panel-codex" aria-labelledby="tab-codex">
        <h3 class="nojs-title">Codex</h3>
        ${cmd("codex plugin marketplace add stephen-taipei/better-workflows", t.install.copyCommand, t.install.copy)}
        ${cmd("codex plugin add better-workflows@better-workflows", t.install.copyCommand, t.install.copy)}
        <p class="pnote">${ic("arrow")}${t.install.codexNote}</p>
      </div>
      <div class="tabpanel" role="tabpanel" id="panel-gemini" aria-labelledby="tab-gemini">
        <h3 class="nojs-title">Gemini CLI</h3>
        ${cmd("gemini extensions install https://github.com/stephen-taipei/better-workflows --ref V5.0.rc1", t.install.copyCommand, t.install.copy)}
        <p class="pnote">${ic("arrow")}${t.install.restartNote}</p>
      </div>
      <div class="tabpanel" role="tabpanel" id="panel-qwen" aria-labelledby="tab-qwen">
        <h3 class="nojs-title">Qwen Code</h3>
        ${cmd("git clone --branch V5.0.rc1 --depth 1 https://github.com/stephen-taipei/better-workflows.git", t.install.copyCommand, t.install.copy)}
        ${cmd("qwen extensions install ./better-workflows", t.install.copyCommand, t.install.copy)}
        <p class="pnote">${ic("arrow")}${t.install.restartNote}</p>
      </div>
      <div class="first-req">
        <p class="mono kick">${t.install.firstK}</p>
        ${cmd(t.install.firstFix, t.install.copyRequest, t.install.copy, true)}
        ${cmd(t.install.firstRead, t.install.copyReadOnly, t.install.copy, true)}
        <p class="pnote pnote-mute">${t.install.firstNote}</p>
      </div>
    </div>
  </div>
</section>

<section class="sec shell" id="boundary" aria-labelledby="boundary-title">
  <div class="slab inst">
    <span class="tick t-tl" aria-hidden="true"></span><span class="tick t-tr" aria-hidden="true"></span><span class="tick t-bl" aria-hidden="true"></span><span class="tick t-br" aria-hidden="true"></span>
    ${secHead(t.boundary.idx, "05", t.boundary.en, "boundary-title", t.boundary.title, t.boundary.lead).replace('class="sec-head"', 'class="sec-head sec-head-slab"')}
    <div class="b-cols">${t.boundary.cols.map(([tone, iconName, kicker, title, items]) => `<article class="b-col b-${tone}"><p class="b-k mono">${ic(iconName)}${kicker}</p><h3>${title}</h3><ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul></article>`).join("")}</div>
    <div class="boundary-card" id="proof-boundaries">
      <blockquote class="claim-limit">${esc(m.V4_CLAIM_LIMIT)}</blockquote>
      <ol class="boundary-list" aria-label="${t.boundary.rulesLabel}">${boundaries.map((item, i) => `<li><span class="mono">B${i + 1}</span>${esc(item)}</li>`).join("")}</ol>
    </div>
  </div>
</section>

<section class="section shell v5-status-section" id="v5-status">
  <header class="sec-head"><p class="home-eyebrow mono"><span class="idx">06</span>${t.status.idx}<span class="en">${t.status.en}</span></p><h2 id="status-title">${esc(v5.title)}</h2><p class="lead">${t.status.lead}</p></header>
  <ol class="road">
    <li class="stn stn-now"><span class="stn-dot" aria-hidden="true"></span><p class="mono kick"><span class="pill pill-sig">NOW</span> ${t.status.now.kicker}</p><h3>V5.0 RC1</h3><p class="mono ver">${t.status.now.ver}</p><p>${t.status.now.body}</p></li>
    <li class="stn stn-ga"><span class="stn-dot" aria-hidden="true"></span><p class="mono kick"><span class="pill pill-warn">PENDING</span> ${t.status.ga.kicker}</p><h3>GA 5.0.0</h3><p class="mono ver">${t.status.ga.ver}</p><ul class="crit">${t.status.ga.crit.map((c) => `<li><i aria-hidden="true"></i>${c}</li>`).join("")}</ul></li>
    <li class="stn stn-next"><span class="stn-dot" aria-hidden="true"></span><p class="mono kick"><span class="pill pill-line">DEFERRED</span> ${t.status.next.kicker}</p><h3>V5.1</h3><p class="mono ver">${t.status.next.ver}</p><p>${t.status.next.body}</p></li>
  </ol>
  <div class="status-grid">
    <div class="statement card">
      <h3 class="blk-title mono">STATEMENT<span>${t.status.statementTitle}</span></h3>
      <p class="statement-k mono">${esc(v5.eyebrow)}</p>
      <p>${esc(v5.boundary)}</p>
      <p>${esc(v5.scope)}</p>
      <p>${esc(v5.license)}</p>
      <p>${esc(v5.plan)}</p>
    </div>
    <div class="license card">
      <div class="lic-head"><h3 class="blk-title mono">LICENSING<span>${t.status.licTitle}</span></h3></div>
      <table class="lic-table">
        <caption class="sr-only">${t.status.licTitle}</caption>
        <thead><tr><th scope="col">${t.status.licItem}</th><th scope="col">${t.status.licForm}</th><th scope="col">${t.status.licState}</th></tr></thead>
        <tbody>${t.status.lic.map(([item, form, note, tone, state]) => `<tr><th scope="row">${item}</th><td>${form}${note ? `<small>${note}</small>` : ""}</td><td><span class="pill pill-${tone}">${state}</span></td></tr>`).join("")}</tbody>
      </table>
    </div>
  </div>
</section>

<section class="sec shell" id="docs" aria-labelledby="docs-title">
  ${secHead(t.docs.idx, "07", t.docs.en, "docs-title", t.docs.title, t.docs.lead)}
  <div class="docs-grid">
    <a class="cinema-card card" href="${docsPath("evidence-cinema")}">
      <figure class="cinema-art"><img src="${CINEMA_ASSETS}/scene-07-gate.webp" width="1672" height="941" loading="lazy" decoding="async" alt="${esc(t.docs.cinemaAlt)}"><span class="cinema-tag mono">${t.docs.cinemaTag}</span></figure>
      <div class="cinema-body">
        <p class="mono kick">${t.docs.cinemaK}</p>
        <h3>${t.docs.cinemaTitle}</h3>
        <p>${t.docs.cinemaBody}</p>
        <div class="cast"><ul class="cast-faces" aria-label="${t.docs.castLabel}">${CAST.map(([file, name]) => `<li><img src="${CINEMA_ASSETS}/character-${file}.webp" width="420" height="630" loading="lazy" decoding="async" alt="${name}"></li>`).join("")}</ul><span class="cast-note">${t.docs.castNote}</span></div>
        <span class="go">${t.docs.cinemaGo}${ic("arrow")}</span>
      </div>
    </a>
    <ul class="doc-list">${t.docs.list.map(([id, title, body]) => `<li><a class="doc-row" href="${docsPath(id)}"><span class="mono doc-path">${docsPath(id)}</span><span class="doc-main"><b>${title}</b><small>${body}</small></span>${ic("arrow")}</a></li>`).join("")}</ul>
  </div>
</section>

<section class="sec shell" id="faq" aria-labelledby="faq-title">
  <div class="faq-grid">
    <header class="faq-head"><p class="home-eyebrow mono"><span class="idx">08</span>${t.faq.idx}<span class="en">${t.faq.en}</span></p><h2 id="faq-title">${t.faq.title}</h2><p class="lead">${t.faq.lead(`${prefix}/support/`)}</p></header>
    <div class="faq-list">${t.faq.items.map(([q, a], i) => `<details class="faq-item"${i === 0 ? " open" : ""}><summary>${q}${ic("chev")}</summary><p>${a}</p></details>`).join("")}</div>
  </div>
</section>

<section class="sec shell sponsor-section" id="sponsor" aria-labelledby="sponsor-title">
  <div class="sponsor card">
    <div class="sponsor-copy">
      <p class="home-eyebrow mono"><span class="idx">09</span>${t.sponsor.idx}<span class="en">${t.sponsor.en}</span></p>
      <h2 id="sponsor-title">${esc(sponsor.title)}</h2>
      <p class="sponsor-method">${esc(sponsor.cta)}</p>
      <p>${esc(sponsor.body)}</p>
    </div>
    <div class="sponsor-pay">
      <a class="qr" href="${sponsor.qr}" target="_blank" rel="noopener noreferrer" aria-label="${esc(t.sponsor.qrLabel)}"><img class="sponsor-qr" src="${sponsor.qr}" width="200" height="197" loading="lazy" decoding="async" alt="USDT (TRC20) QR: ${esc(sponsor.address)}"></a>
      <div class="addr">
        <p class="mono net sponsor-network" dir="ltr">USDT · TRON (TRC20)</p>
        <div class="addr-row"><code class="sponsor-address" dir="ltr">${esc(sponsor.address)}</code>${copyButton(t.sponsor.copyAddress, t.install.copy)}</div>
      </div>
    </div>
  </div>
</section>

<section class="shell cta-wrap" aria-labelledby="cta-title">
  <div class="cta inst">
    <div class="cta-copy">
      <p class="mono kick"><i class="led led-live" aria-hidden="true"></i>${t.cta.kicker}</p>
      <h2 id="cta-title">${t.cta.title}</h2>
      <p>${t.cta.body}</p>
      <div class="cta-row"><a class="btn btn-primary" href="#install">${t.ctaInstall}${ic("arrow")}</a><a class="btn btn-ghost" href="${RELEASE_URL}" ${ext}>${t.cta.notes}${ic("ext")}</a></div>
    </div>
    <img class="cta-mark" src="/better-workflows-mark.svg" width="756" height="608" alt="" aria-hidden="true" loading="lazy" decoding="async">
  </div>
</section>
</main>`;
}
