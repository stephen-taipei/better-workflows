export const LOCALE_KEYS = [
  "TITLE",
  "DESCRIPTION",
  "SKIP",
  "MENU",
  "LANGUAGE",
  "HERO_TITLE",
  "HERO_ACCENT",
  "HERO_LEAD",
  "DOCS_CTA",
  "GITHUB_CTA",
  "CONTROL_TITLE",
  "CONTROL_SUMMARY",
  "QUICK_START",
  "DOCS_TITLE",
  "CLOSING_TITLE",
  "THEME_LIGHT",
  "THEME_DARK",
  "V4_POSITIONING",
  "V4_RISK_LEAD",
  "V4_SUMMARY",
  "V4_AUTO_FLOW",
  "V4_RECOMMENDED",
  "V4_BOUNDARIES",
  "V4_CLAIM_LIMIT",
  "SPONSOR_CTA",
  "SPONSOR_TITLE",
  "SPONSOR_BODY"
];

export const CONNECTORS_LOCALES = ["en", "zh-Hant-TW"];

// RC1 site copy contains only the public English and Taiwan Traditional Chinese editions.
export const PUBLIC_RC1_LOCALE_IDS = Object.freeze(["en", "zh-Hant-TW"]);

export const DEFAULT_LOCALE = "zh-Hant-TW";

export const locales = [
  {
    code: "en", label: "English", messages: {
      TITLE: "Better Workflows | Provable agent workflows",
      DESCRIPTION: "An open-source, goal-first control plane for agent workflows with current evidence, review gates, source binding, and provider reconciliation.",
      SKIP: "Skip to main content", MENU: "Menu", LANGUAGE: "Language",
      HERO_TITLE: "Take agent work", HERO_ACCENT: "to a provable finish.",
      HERO_LEAD: "Better Workflows freezes the goal, scope, and authority, then binds every decision to current, re-verifiable evidence and a reconciled external outcome.",
      DOCS_CTA: "Explore the documentation", GITHUB_CTA: "Open GitHub",
      CONTROL_TITLE: "Four explicit boundaries from intent to completion.",
      CONTROL_SUMMARY: "Define the contract, verify source and evidence, reconcile external effects, and declare completion only when the terminal state is known.",
      QUICK_START: "Quick start", DOCS_TITLE: "Move from the architecture map to practical use cases.",
      CLOSING_TITLE: "Running a command is not proof of completion; a re-verifiable outcome is.",
      THEME_LIGHT: "Switch to light theme", THEME_DARK: "Switch to dark theme"
    }
  },
  {
    code: "zh-Hant-TW", label: "繁體中文（台灣）", messages: {
      TITLE: "Better Workflows｜讓 agent 工作完成且可驗證",
      DESCRIPTION: "開源、goal-first 的 agent 工作流程控制面，以目前仍有效的證據、審查關卡、來源綁定與 provider 狀態核對，確保結果可重新驗證。",
      SKIP: "跳到主要內容", MENU: "選單", LANGUAGE: "語言",
      HERO_TITLE: "讓 agent 工作", HERO_ACCENT: "完成，並留下可驗證的結果。",
      HERO_LEAD: "Better Workflows 固定 goal、scope 與 authority，把每個判斷綁定到目前仍有效且可重新驗證的證據，以及已核對的外部結果。",
      DOCS_CTA: "查看官方文件", GITHUB_CTA: "開啟 GitHub",
      CONTROL_TITLE: "從意圖到完成，明確劃分四道邊界。",
      CONTROL_SUMMARY: "先定義 contract，再驗證 source 與 evidence、核對外部操作結果；只有 terminal state 已知時，才宣告完成。",
      QUICK_START: "快速開始", DOCS_TITLE: "從架構地圖繼續深入實際使用情境。",
      CLOSING_TITLE: "命令成功執行不代表工作已經完成；可重新驗證的結果才是證明。",
      THEME_LIGHT: "切換淺色模式", THEME_DARK: "切換深色模式"
    }
  }
];

const v5ProductCopy = {
  en: {
    eyebrow: "V5 · Development status and licensing",
    title: "V5 is in development and has not been formally released.",
    boundary: "The V4 documentation scope does not mean V5 has been verified; verification for the new version is still pending.",
    scope: "V5.0: macOS × Node 22/24, with qualification still pending. Linux and Windows qualification is deferred to V5.1. Claude Code qualification is also deferred to V5.1.",
    license: "The first-party Better Workflows core is AGPL-3.0-only. The physically separate minimal wire package is Apache-2.0; its LICENSE and NOTICE apply to that package.",
    plan: "The basic product is free. Professional Pack is planned as a proprietary product, and Cloud is a separate product planned for later; neither is currently available."
  },
  "zh-Hant-TW": {
    eyebrow: "V5 · 開發狀態與授權",
    title: "V5 正在開發，尚未正式發布。",
    boundary: "V4 既有文件範圍不代表 V5 已驗證；新版本驗證尚待完成。",
    scope: "V5.0：macOS × Node 22/24，驗收尚未完成。Linux 與 Windows 的驗收延至 V5.1。 Claude Code 的驗收也延至 V5.1。",
    license: "第一方 Better Workflows 核心採 AGPL-3.0-only。實體獨立的 minimal wire package 另採 Apache-2.0；其 LICENSE 與 NOTICE 適用於該 package。",
    plan: "基本產品免費。Professional Pack 規劃為專有產品，Cloud 是後續獨立產品；兩者目前尚未提供。"
  }
};

const V5_PRODUCT_FIELDS = ["eyebrow", "title", "boundary", "scope", "license", "plan"];
const V5_PRODUCT_MARKERS = {
  boundary: ["V4", "V5"],
  scope: ["V5.0", "V5.1", "macOS", "Node 22/24", "Linux", "Windows", "Claude Code"],
  license: ["AGPL-3.0-only", "Apache-2.0", "LICENSE", "NOTICE"],
  plan: ["Professional Pack", "Cloud"]
};
const v5ProductCodes = Object.keys(v5ProductCopy);
if (v5ProductCodes.length !== CONNECTORS_LOCALES.length || CONNECTORS_LOCALES.some((code) => !Object.hasOwn(v5ProductCopy, code))) {
  throw new Error("V5 product copy must cover every public locale exactly once");
}
for (const locale of locales) {
  const copy = v5ProductCopy[locale.code];
  if (!copy || V5_PRODUCT_FIELDS.some((field) => typeof copy[field] !== "string" || copy[field].trim() === "")) {
    throw new Error("Missing complete V5 product copy: " + locale.code);
  }
  for (const [field, markers] of Object.entries(V5_PRODUCT_MARKERS)) {
    if (markers.some((marker) => !copy[field].includes(marker))) {
      throw new Error("Incomplete V5 product copy: " + locale.code + "." + field);
    }
  }
  if (locale.code !== "en" && V5_PRODUCT_FIELDS.every((field) => copy[field] === v5ProductCopy.en[field])) {
    throw new Error("V5 product copy falls back to English: " + locale.code);
  }
  locale.v5Product = Object.freeze({ ...copy });
}

if (locales.length !== CONNECTORS_LOCALES.length || new Set(locales.map(({ code }) => code)).size !== CONNECTORS_LOCALES.length || CONNECTORS_LOCALES.some((code) => !locales.some((locale) => locale.code === code))) {
  throw new Error("Locale catalog must match the independent Connectors iOS inventory");
}
const localeOrder = new Map(CONNECTORS_LOCALES.map((code, index) => [code, index]));
locales.sort((left, right) => localeOrder.get(left.code) - localeOrder.get(right.code));
export const publicRc1Locales = Object.freeze(PUBLIC_RC1_LOCALE_IDS.map((code) => {
  const locale = locales.find((entry) => entry.code === code);
  if (!locale) throw new Error(`RC1 public locale is absent from the source catalog: ${code}`);
  return locale;
}));

const v4Copy = {
  en: [
    "Evidence-first AI engineering QA and delivery gatekeeper.",
    "Let AI agents choose verification strength by risk and finish work safely in an isolated environment.",
    "Simple changes move fast; important work uses evidence gates; Git changes use a dedicated worktree by default.",
    "Check the repository, goal, scope, and source branch|Choose Auto fast path or evidence-required|Read-only work stays in place; Git changes create or reuse an isolated task worktree|Validate the result; integrate changes only when authorized|Clean only task-owned branches and worktrees",
    "Official recommendation: macOS + Codex — the deepest native integration and complete reference experience.",
    "Auto fast path still runs targeted checks and never bypasses protected branches|Protected or remote targets use governed PRs, fresh checks, and merge authority|Replay re-evaluates recorded evidence; it does not merge, push, or deploy again",
    "Better Workflows can block observable errors such as the wrong repository or revision, stale evidence, unauthorized side effects, and premature cleanup. It has not yet statistically proven lower long-term scope drift, rework, or decision-error rates."
  ],
  "zh-Hant-TW": [
    "證據至上的 AI 工程 QA＋交付守門人。",
    "讓 AI agent 依風險選擇驗證強度，在隔離環境安全完成工作。",
    "單純修改快速完成；重要工作使用證據 gate；Git 修改預設使用專屬 worktree。",
    "檢查程式碼儲存庫、Goal、scope 與原分支|判斷 Auto 快速路徑 或 evidence-required|唯讀工作留在原處；Git 修改才建立或重用隔離 task worktree|驗證結果；獲授權後才回併修改|只清理本任務擁有的 branch 與 worktree",
    "官方推薦：macOS + Codex——原生整合最深、參考體驗最完整。",
    "Auto 快速路徑 仍會執行 targeted check，且絕不繞過 protected branch|protected 或 remote target 必須走受治理 PR、fresh checks 與 merge authority|Replay 是重播已記錄證據的判斷，不會重新 merge、push 或 deploy",
    "Better Workflows 能阻擋錯誤的程式碼儲存庫、錯 revision、stale evidence、未授權副作用與過早 cleanup 等可觀測錯誤；但尚未以統計證明長期任務的整體 scope drift、rework 或錯誤決策率下降。"
  ]
};

for (const locale of locales) {
  const copy = v4Copy[locale.code];
  if (!copy || copy.length !== 7) throw new Error(`Missing v4 copy: ${locale.code}`);
  Object.assign(locale.messages, {
    TITLE: `Better Workflows | ${copy[0]}`,
    V4_POSITIONING: copy[0],
    V4_RISK_LEAD: copy[1],
    V4_SUMMARY: copy[2],
    V4_AUTO_FLOW: copy[3],
    V4_RECOMMENDED: copy[4],
    V4_BOUNDARIES: copy[5],
    V4_CLAIM_LIMIT: copy[6]
  });
}

const sponsorCopy = {
  en: ["Support with USDT (TRC20)", "Help keep Better Workflows maintained.", "A one-time contribution supports open-source maintenance, English and Traditional Chinese documentation, and website hosting. It does not buy membership, roadmap priority, or support priority."],
  "zh-Hant-TW": ["透過 USDT（TRC20）單次贊助", "一起支持 Better Workflows 持續維護。", "單次贊助將用於開源維護、英文與繁體中文文件及網站託管；不包含會員資格，也不提供產品路線圖或技術支援優先權。"]
};

export const SPONSOR_ONE_TIME_MARKERS = {
  en: "one-time",
  "zh-Hant-TW": "單次贊助"
};

export const SPONSOR_LOCALE_MARKERS = {
  en: "English and Traditional Chinese documentation",
  "zh-Hant-TW": "英文與繁體中文文件"
};

for (const locale of locales) {
  const copy = sponsorCopy[locale.code];
  if (!copy) throw new Error(`Missing sponsor copy: ${locale.code}`);
  if (!copy[2].includes(SPONSOR_ONE_TIME_MARKERS[locale.code])) throw new Error(`Sponsor copy is not explicitly one-time: ${locale.code}`);
  if (!copy[2].includes(SPONSOR_LOCALE_MARKERS[locale.code])) throw new Error(`Sponsor copy does not describe its locale scope: ${locale.code}`);
  Object.assign(locale.messages, { SPONSOR_CTA: copy[0], SPONSOR_TITLE: copy[1], SPONSOR_BODY: copy[2] });
}
