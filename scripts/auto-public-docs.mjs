import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONNECTORS_LOCALES, PUBLIC_LOCALE_IDS, locales } from "./website-locales.mjs";
import { publicDocPath } from "./public-docs.mjs";
import { applyPublicSiteShell } from "./public-site-shell.mjs";
import { overlayLocales } from "./locale-overlay.mjs";

const PAGE_IDS = new Set(["guide", "quick", "use-cases", "use-cases-quick"]);
const VARIANT_IDS = ["read-only-v1", "code-change-v1", "dev-publish-v1"];
const VARIANT_EVIDENCE = {
  "read-only-v1": ["source-inventory", "observed-result"],
  "code-change-v1": ["patch-review", "diff-review", "repo-gates"],
  "dev-publish-v1": ["target-branch-dev", "required-checks", "provider-reconciliation"]
};

const SOURCE_URLS = Object.freeze({
  plainLanguage: "https://github.com/stephen-taipei/better-workflows/blob/main/README.md#better-workflows-in-plain-language",
  firstResult: "https://github.com/stephen-taipei/better-workflows/blob/main/README.md#get-your-first-result",
  gettingStarted: "https://github.com/stephen-taipei/better-workflows/blob/main/docs/guide/getting-started.md",
  workflows: "https://github.com/stephen-taipei/better-workflows/blob/main/docs/guide/workflows.md",
  cli: "https://github.com/stephen-taipei/better-workflows/blob/main/docs/guide/cli-reference.md"
});

const PAGE_COPY = Object.freeze(overlayLocales({
  en: {
    guide: {
      heading: "Start here",
      description: "A plain-language map to installing Better Workflows and choosing the right next step.",
      intro: "Better Workflows helps you move from a clear request to a result you can check. Start with the outcome you want; Auto checks the repository and chooses a suitable path.",
      stepsHeading: "What happens to a request",
      steps: [
        "Describe the result you want and the files or project it covers.",
        "Auto checks the project instructions and current state before deciding what it can safely do.",
        "It chooses a read-only review, a bounded code change, or a governed delivery path.",
        "It reports what it checked and stops when permission or supporting information is missing."
      ],
      pathsHeading: "Choose what you need next",
      pathsIntro: "Each page answers a different question.",
      paths: [
        { page: "quick", label: "Install and try Auto", description: "Choose Codex, Gemini CLI, or Qwen Code and make a first read-only request." },
        { page: "use-cases", label: "Pick a work path", description: "See what changes between reviewing, editing, and preparing delivery." },
        { page: "use-cases-quick", label: "Copy a request", description: "Start with a short prompt and a checklist for the result." },
        { page: "evidence-cinema", label: "See an example", description: "Watch a fictional task move through review and reconciliation." }
      ],
      variantsHeading: "Three paths inside the Auto entry",
      variantsIntro: "Auto chooses among these paths according to the request. Their technical policy IDs are shown below; they are not separate templates or commands.",
      variantLabels: {
        "read-only-v1": "Review and report",
        "code-change-v1": "Make a bounded code change",
        "dev-publish-v1": "Prepare protected delivery"
      },
      modeLabel: "Default mode",
      evidenceLabel: "Evidence to show",
      previewHeading: "Preview a route from the command line",
      previewText: "This command previews how a goal and scope would be routed; it does not run the requested work. See the CLI reference for options.",
      previewCommand: "node plugins/better-workflows/scripts/sbw.mjs route preview --goal \"Review this repository\" --scope . --entry auto",
      sourcesHeading: "Read the source guidance",
      sources: [
        { label: "README: Better Workflows in plain language", href: SOURCE_URLS.plainLanguage },
        { label: "Getting started", href: SOURCE_URLS.gettingStarted },
        { label: "Workflows", href: SOURCE_URLS.workflows },
        { label: "CLI reference", href: SOURCE_URLS.cli }
      ]
    },
    quick: {
      heading: "Quick start",
      description: "Install the public V5.0 RC1 on a supported macOS and Node setup, then try Auto.",
      intro: "V5.0 RC1 is the available release. The public scope is macOS with Node 22 or 24, using Codex, Gemini CLI, or Qwen Code. Node 22 must be version 22.14.0 or newer. GA remains pending.",
      requirementsHeading: "Before you begin",
      requirements: [
        "Use macOS with Node.js 22 or 24. The bundled sbw helper requires Node.js 22.14.0 or newer.",
        "Use a repository you trust. Better Workflows does not claim to sandbox malicious repository code.",
        "Linux, Windows, and Claude Code qualification are deferred to V5.1."
      ],
      installHeading: "Install for your host",
      hosts: {
        codex: {
          heading: "Codex · recommended reference",
          note: "Install the marketplace and plugin, then open a new Codex task so its skill list refreshes.",
          command: "codex plugin marketplace add stephen-taipei/better-workflows\ncodex plugin add better-workflows@better-workflows"
        },
        gemini: {
          heading: "Gemini CLI",
          note: "Gemini CLI copies the extension during installation. Restart Gemini CLI, then use the installed Auto skill or preview a route from the command line.",
          command: "gemini extensions install https://github.com/stephen-taipei/better-workflows --ref V5.0.rc1"
        },
        qwen: {
          heading: "Qwen Code",
          note: "Clone the pinned release and install that local extension copy. Restart Qwen Code after installation.",
          command: "git clone --branch V5.0.rc1 --depth 1 https://github.com/stephen-taipei/better-workflows.git\nqwen extensions install ./better-workflows"
        }
      },
      firstHeading: "Try a first request",
      firstIntro: "In Codex, open a new task and describe a read-only result:",
      firstPrompt: "$better-workflows:auto Review this repository and summarize its main parts. Do not change files.",
      otherHosts: "In Gemini CLI or Qwen Code, restart the host and ask it to use the installed Auto skill for the same read-only request.",
      resultHeading: "What to expect",
      result: "Auto should tell you what it inspected and what it found, without changing files for this request. If a later task needs edits, protected delivery, or an external action, it will require the appropriate worktree, evidence, or authorization.",
      nextHeading: "Continue",
      nextText: "Use the use-cases page to choose a path, or follow the source guide for installation checks and troubleshooting.",
      nextLabel: "Choose a work path",
      sources: [
        { label: "Official getting-started guide", href: SOURCE_URLS.gettingStarted },
        { label: "First-result instructions", href: SOURCE_URLS.firstResult },
        { label: "CLI reference", href: SOURCE_URLS.cli }
      ]
    },
    "use-cases": {
      heading: "Pick a work path",
      description: "See how Auto handles a review, a code change, or delivery to protected dev.",
      intro: "Tell Auto what result you need. These three paths describe the checks and boundaries for different kinds of work; Auto remains the single public entry.",
      scenariosHeading: "Three common requests",
      scenarios: {
        "read-only-v1": {
          title: "Review without editing",
          description: "Ask for an inspection, explanation, or comparison. Auto reads the requested scope and reports the files and observations behind its answer.",
          boundary: "This path has no action gate. It does not edit files or contact providers."
        },
        "code-change-v1": {
          title: "Fix a verified issue",
          description: "Give Auto a bounded change and a way to check it. Git edits use a task-owned worktree; the final report includes the diff, checks, and any remaining uncertainty.",
          boundary: "This path does not authorize a push, pull request, merge, deployment, or release."
        },
        "dev-publish-v1": {
          title: "Deliver to protected dev",
          description: "For an explicit protected dev target, Auto prepares the change, review, required checks, and provider reconciliation as one evidence-led delivery.",
          boundary: "Publication requires the exact user authority and reviewed head. Never push directly to dev or main; a ready pull request is not proof of a completed merge."
        }
      },
      evidenceLabel: "Evidence",
      modeLabel: "Mode",
      boundaryHeading: "Keep the boundary clear",
      boundary: "A local check only proves what that check observed. Protected or remote work needs the required review and fresh provider receipts; an unknown outcome stays unresolved until it is checked.",
      sourcesHeading: "Read more",
      sources: [
        { label: "Workflows source guide", href: SOURCE_URLS.workflows },
        { label: "Getting started and workspace boundaries", href: SOURCE_URLS.gettingStarted },
        { label: "Trust boundaries in the README", href: SOURCE_URLS.plainLanguage }
      ]
    },
    "use-cases-quick": {
      heading: "Copy a request",
      description: "Copy a short prompt for a read-only review, a bounded code change, or protected delivery preparation.",
      intro: "Replace the bracketed details before you send a prompt. In Codex, keep the Auto selector at the start. In Gemini CLI or Qwen Code, send the same request after the installed extension has loaded.",
      checklistHeading: "Before you send it",
      checklist: [
        "Name the result you want and the exact repository or path.",
        "Say whether the work is read-only or may change files.",
        "List the checks that would show the result is correct.",
        "Name any protected or remote action and state whether you authorize it."
      ],
      promptsHeading: "Copy one prompt",
      prompts: {
        "read-only-v1": "$better-workflows:auto Review <path> for <question>. Do not edit files or call external services. List the files and evidence behind your answer.",
        "code-change-v1": "$better-workflows:auto Fix <verified defect> within <path>. Keep the change inside <scope>, run <checks>, and report the diff and remaining risks. Do not publish or deploy.",
        "dev-publish-v1": "$better-workflows:auto For <change> targeting protected dev, prepare the evidence and review plan. Stop before push, pull request creation, merge, or deployment until I authorize the exact action."
      },
      promptLabels: {
        "read-only-v1": "Read-only review",
        "code-change-v1": "Code change",
        "dev-publish-v1": "Protected delivery"
      },
      noteHeading: "After Auto replies",
      note: "Check the cited files, diff, and check results yourself. If the requested next step needs an external action, review its exact target and authority before proceeding.",
      nextLabel: "See all three paths",
      sourcesHeading: "Source guides",
      sources: [
        { label: "Workflow choices", href: SOURCE_URLS.workflows },
        { label: "First-result instructions", href: SOURCE_URLS.firstResult }
      ]
    }
  },
  "zh-Hant-TW": {
    guide: {
      heading: "從這裡開始",
      description: "用白話了解 Better Workflows，選擇安裝方式與下一步。",
      intro: "Better Workflows 協助你從清楚的需求走到可檢查的結果。先說明想完成什麼；Auto 會先查看儲存庫，再選擇合適的工作路線。",
      stepsHeading: "提出需求後會發生什麼",
      steps: [
        "說明想要的結果，以及涉及的專案或檔案。",
        "Auto 先查看專案指示與目前狀態，再判斷可以安全進行哪些工作。",
        "它會選擇唯讀檢查、有限範圍的程式修改，或受治理的交付流程。",
        "它會回報檢查內容；缺少授權或證據時就停止。"
      ],
      pathsHeading: "選擇下一步",
      pathsIntro: "每一頁都回答不同問題。",
      paths: [
        { page: "quick", label: "安裝並試用 Auto", description: "選擇 Codex、Gemini CLI 或 Qwen Code，先提出唯讀需求。" },
        { page: "use-cases", label: "選擇工作路線", description: "了解檢查、修改與準備交付時的差別。" },
        { page: "use-cases-quick", label: "複製一段需求", description: "從簡短提示與結果檢查清單開始。" },
        { page: "evidence-cinema", label: "觀看工作示例", description: "查看虛構任務如何經過審查與結果核對。" }
      ],
      variantsHeading: "Auto 入口中的三種路線",
      variantsIntro: "Auto 會依工作內容選擇下列路線，並列出技術識別碼；它們不是不同的入口。",
      variantLabels: {
        "read-only-v1": "檢查並回報",
        "code-change-v1": "有限範圍的程式修改",
        "dev-publish-v1": "準備交付至受保護的 dev"
      },
      modeLabel: "預設處理方式",
      evidenceLabel: "核對資料",
      previewHeading: "從命令列預覽工作路線",
      previewText: "這個命令會依需求與範圍預覽工作路線，不會執行需求本身。其他選項請參考 CLI 文件。",
      previewCommand: "node plugins/better-workflows/scripts/sbw.mjs route preview --goal \"檢查這個儲存庫\" --scope . --entry auto",
      sourcesHeading: "查看原始文件",
      sources: [
        { label: "README 白話說明（英文原文）", href: SOURCE_URLS.plainLanguage },
        { label: "Getting started（英文原文）", href: SOURCE_URLS.gettingStarted },
        { label: "Workflows（英文原文）", href: SOURCE_URLS.workflows },
        { label: "CLI reference（英文原文）", href: SOURCE_URLS.cli }
      ]
    },
    quick: {
      heading: "快速開始",
      description: "在支援的 macOS 與 Node 環境安裝 V5.0 RC1，然後試用 Auto。",
      intro: "目前提供的是 V5.0 RC1。公開範圍是 macOS、Node 22 或 24，以及 Codex、Gemini CLI 或 Qwen Code。Node 22 至少需 22.14.0。GA 尚未完成。",
      requirementsHeading: "開始前",
      requirements: [
        "使用 macOS 與 Node.js 22 或 24。命令列工具需要 Node.js 22.14.0 或更新版本。",
        "選擇可信任的本機儲存庫。Better Workflows 不宣稱能隔離惡意儲存庫程式碼。",
        "Linux、Windows 與 Claude Code 的資格驗收延至 V5.1。"
      ],
      installHeading: "依照使用的工具安裝",
      hosts: {
        codex: {
          heading: "Codex · 官方參考體驗",
          note: "先將外掛市集加入 Codex 並安裝外掛，再重新開啟 Codex 工作，讓工具載入技能清單。",
          command: "codex plugin marketplace add stephen-taipei/better-workflows\ncodex plugin add better-workflows@better-workflows"
        },
        gemini: {
          heading: "Gemini CLI",
          note: "安裝時 Gemini CLI 會複製外掛。完成後重新啟動 Gemini CLI，再使用 Auto 技能，或從命令列預覽工作路線。",
          command: "gemini extensions install https://github.com/stephen-taipei/better-workflows --ref V5.0.rc1"
        },
        qwen: {
          heading: "Qwen Code",
          note: "先從固定版本複製專案，再安裝本機外掛。完成後重新啟動 Qwen Code。",
          command: "git clone --branch V5.0.rc1 --depth 1 https://github.com/stephen-taipei/better-workflows.git\nqwen extensions install ./better-workflows"
        }
      },
      firstHeading: "試著提出第一個需求",
      firstIntro: "在 Codex 開啟新的工作，輸入唯讀需求：",
      firstPrompt: "$better-workflows:auto 檢視這個儲存庫並摘要主要部分。不要修改檔案。",
      otherHosts: "使用 Gemini CLI 或 Qwen Code 時，重新啟動工具後，請已載入的 Auto 技能處理相同的唯讀需求。",
      resultHeading: "預期結果",
      result: "Auto 應說明它查看了哪些內容、發現什麼；這個需求不會修改檔案。之後若要修改程式、交付至受保護分支或執行外部操作，系統會要求相應的獨立工作目錄（worktree）、佐證或授權。",
      nextHeading: "接下來",
      nextText: "前往工作路線頁選擇合適的需求，或依原始指南完成安裝檢查與疑難排解。",
      nextLabel: "選擇工作路線",
      sources: [
        { label: "Getting started 官方指南（英文原文）", href: SOURCE_URLS.gettingStarted },
        { label: "第一個結果的原始說明（英文原文）", href: SOURCE_URLS.firstResult },
        { label: "CLI reference（英文原文）", href: SOURCE_URLS.cli }
      ]
    },
    "use-cases": {
      heading: "選擇工作路線",
      description: "了解 Auto 如何處理檢查、程式修改，以及交付至受保護的 dev。",
      intro: "告訴 Auto 想完成什麼。以下三種路線說明不同工作的檢查方式與界線；公開入口仍只有 Auto。",
      scenariosHeading: "三種常見需求",
      scenarios: {
        "read-only-v1": {
          title: "只檢查，不修改",
          description: "提出檢視、說明或比較需求。Auto 只查看指定範圍，回報依據哪些檔案與觀察得出答案。",
          boundary: "這條路線不會修改檔案，也不會呼叫外部服務。"
        },
        "code-change-v1": {
          title: "修正已確認的問題",
          description: "指出有限範圍的修改，並說明如何檢查結果。Git 修改會使用本次工作專用的獨立目錄（worktree）；最後回報差異、檢查結果與尚未確認的風險。",
          boundary: "這條路線本身不授權 push、建立 pull request、merge、deploy 或 release。"
        },
        "dev-publish-v1": {
          title: "交付至受保護的 dev",
          description: "明確指定受保護的 dev 後，Auto 會整合修改、審查、必要檢查，以及外部服務結果核對。",
          boundary: "發布需要使用者對確切目標與已審查版本的授權。不可直接 push 至 dev 或 main；pull request 準備完成也不代表 merge 已完成。"
        }
      },
      evidenceLabel: "佐證資料",
      modeLabel: "模式",
      boundaryHeading: "保留清楚的界線",
      boundary: "本機檢查只能證明該檢查實際觀察到的事。受保護或遠端工作需要完成必要審查，並確認外部服務的最新回覆；結果未知時，先查明才能繼續。",
      sourcesHeading: "延伸閱讀",
      sources: [
        { label: "Workflows 原始指南（英文原文）", href: SOURCE_URLS.workflows },
        { label: "安裝與工作目錄界線（英文原文）", href: SOURCE_URLS.gettingStarted },
        { label: "README 的信任界線（英文原文）", href: SOURCE_URLS.plainLanguage }
      ]
    },
    "use-cases-quick": {
      heading: "複製一段需求",
      description: "複製唯讀檢查、有限範圍程式修改或受保護交付準備的提示。",
      intro: "送出前請替換方括號內容。在 Codex 中保留開頭的 Auto 指令；在 Gemini CLI 或 Qwen Code 中，外掛載入後直接送出相同需求。",
      checklistHeading: "送出前確認",
      checklist: [
        "說明想要的結果，以及確切的儲存庫或路徑。",
        "說明工作是唯讀，還是可以修改檔案。",
        "列出能確認結果正確的檢查方式。",
        "指出任何受保護或遠端操作，並說明是否授權。"
      ],
      promptsHeading: "複製一段提示",
      prompts: {
        "read-only-v1": "$better-workflows:auto 檢視 <路徑> 中與 <問題> 相關的內容。不要修改檔案或呼叫外部服務。請列出依據的檔案與佐證。",
        "code-change-v1": "$better-workflows:auto 修正 <已確認的問題>，範圍限於 <路徑>。請只修改 <範圍>、執行 <檢查>，並回報修改差異與剩餘風險。不要發布或部署。",
        "dev-publish-v1": "$better-workflows:auto 為要交付到受保護 dev 的 <修改> 準備佐證與審查計畫。在我明確授權精確操作前，停止 push、建立 pull request、merge 或 deploy。"
      },
      promptLabels: {
        "read-only-v1": "唯讀檢查",
        "code-change-v1": "程式修改",
        "dev-publish-v1": "受保護交付"
      },
      noteHeading: "Auto 回覆後",
      note: "自行檢查引用的檔案、差異與檢查結果。若下一步需要外部操作，先確認確切目標與授權，再繼續。",
      nextLabel: "查看三種工作路線",
      sourcesHeading: "原始指南",
      sources: [
        { label: "工作路線選擇（英文原文）", href: SOURCE_URLS.workflows },
        { label: "第一個結果的原始說明（英文原文）", href: SOURCE_URLS.firstResult }
      ]
    }
  }
}, "public-page-copy", CONNECTORS_LOCALES));

const VARIANT_LABELS = Object.freeze(overlayLocales({
  en: {
    "read-only-v1": "Review and report",
    "code-change-v1": "Make a bounded code change",
    "dev-publish-v1": "Prepare protected delivery"
  },
  "zh-Hant-TW": {
    "read-only-v1": "檢查並回報",
    "code-change-v1": "有限範圍的程式修改",
    "dev-publish-v1": "準備受保護交付"
  }
}, "variant-labels", CONNECTORS_LOCALES));

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
})[character]);

function renderList(items, ordered = false) {
  const tag = ordered ? "ol" : "ul";
  return "<" + tag + ">" + items.map((item) => "<li>" + escapeHtml(item) + "</li>").join("") + "</" + tag + ">";
}

function renderSourceLinks(items) {
  return "<ul>" + items.map((item) =>
    "<li><a href=\"" + escapeHtml(item.href) + "\" target=\"_blank\" rel=\"noopener noreferrer\">" +
    escapeHtml(item.label) + "</a></li>").join("") + "</ul>";
}

function renderRouteCards(code, items) {
  return "<div class=\"doc-links\">" + items.map((item) =>
    "<a href=\"" + escapeHtml(publicDocPath(code, item.page)) + "\"><h3>" +
    escapeHtml(item.label) + "</h3><p>" + escapeHtml(item.description) + "</p></a>").join("") + "</div>";
}

function renderVariantCards(guide, code, copy) {
  return "<div class=\"policies\">" + VARIANT_IDS.map((id) => {
    const variant = guide.catalog.variants[id];
    if (!variant || typeof variant.defaultMode !== "string") {
      throw new Error("Auto public documentation variant is incomplete: " + id);
    }
    return "<article class=\"workflow-map policy\"><h3>" + escapeHtml(copy.variantLabels[id]) +
      "</h3><p><code>" + escapeHtml(id) + "</code></p><p>" +
      escapeHtml(copy.modeLabel) + ": <code>" + escapeHtml(variant.defaultMode) +
      "</code></p><p>" + escapeHtml(copy.evidenceLabel) + ": " +
      VARIANT_EVIDENCE[id].map((evidence) => "<code>" + escapeHtml(evidence) + "</code>").join(" · ") +
      "</p></article>";
  }).join("") + "</div>";
}

function renderHostBlocks(copy) {
  return ["codex", "gemini", "qwen"].map((hostId) => {
    const host = copy.hosts[hostId];
    if (!host) throw new Error("Auto quick-start copy is incomplete: " + hostId);
    return "<section class=\"public-document__section\"><h3>" + escapeHtml(host.heading) +
      "</h3><p>" + escapeHtml(host.note) + "</p><pre><code>" +
      escapeHtml(host.command) + "</code></pre></section>";
  }).join("");
}

function renderScenarioCards(guide, code, copy) {
  const labels = VARIANT_LABELS[code];
  return "<div class=\"policies\">" + VARIANT_IDS.map((id) => {
    const scenario = copy.scenarios[id];
    const variant = guide.catalog.variants[id];
    if (!scenario || !variant || typeof variant.defaultMode !== "string") {
      throw new Error("Auto use-case copy or variant is incomplete: " + id);
    }
    return "<article class=\"workflow-map policy\"><p>" + escapeHtml(labels[id]) +
      " · <code>" + escapeHtml(id) + "</code></p><h3>" + escapeHtml(scenario.title) +
      "</h3><p>" + escapeHtml(scenario.description) + "</p><p>" +
      escapeHtml(copy.modeLabel) + ": <code>" + escapeHtml(variant.defaultMode) +
      "</code>; " + escapeHtml(copy.evidenceLabel) + ": " +
      VARIANT_EVIDENCE[id].map((evidence) => "<code>" + escapeHtml(evidence) + "</code>").join(" · ") +
      ".</p><p>" + escapeHtml(scenario.boundary) + "</p></article>";
  }).join("") + "</div>";
}

function renderPrompts(copy) {
  return "<div class=\"public-document__prompts\">" + VARIANT_IDS.map((id) => {
    if (typeof copy.prompts[id] !== "string" || typeof copy.promptLabels[id] !== "string") {
      throw new Error("Auto prompt copy is incomplete: " + id);
    }
    return "<section class=\"public-document__section\"><h3>" + escapeHtml(copy.promptLabels[id]) +
      " · <code>" + escapeHtml(id) + "</code></h3><pre><code>" +
      escapeHtml(copy.prompts[id]) + "</code></pre></section>";
  }).join("") + "</div>";
}

function renderPageBody(guide, code, pageId) {
  const copy = PAGE_COPY[code]?.[pageId];
  if (!copy || typeof copy.heading !== "string" || typeof copy.description !== "string") {
    throw new Error("Auto public documentation has incomplete page copy: " + code + "/" + pageId);
  }
  let sections = "";
  if (pageId === "guide") {
    sections = "<section class=\"public-document__section\"><h2>" + escapeHtml(copy.stepsHeading) +
      "</h2>" + renderList(copy.steps, true) + "</section>" +
      "<section class=\"public-document__section\"><h2>" + escapeHtml(copy.pathsHeading) +
      "</h2><p>" + escapeHtml(copy.pathsIntro) + "</p>" + renderRouteCards(code, copy.paths) +
      "</section><section class=\"public-document__section\"><h2>" + escapeHtml(copy.variantsHeading) +
      "</h2><p>" + escapeHtml(copy.variantsIntro) + "</p>" + renderVariantCards(guide, code, copy) +
      "</section><section class=\"public-document__section\"><h2>" + escapeHtml(copy.previewHeading) +
      "</h2><p>" + escapeHtml(copy.previewText) + "</p><pre><code>" +
      escapeHtml(copy.previewCommand) + "</code></pre></section><section class=\"public-document__section\"><h2>" +
      escapeHtml(copy.sourcesHeading) + "</h2>" + renderSourceLinks(copy.sources) + "</section>";
  } else if (pageId === "quick") {
    sections = "<section class=\"public-document__section\"><h2>" + escapeHtml(copy.requirementsHeading) +
      "</h2>" + renderList(copy.requirements) + "</section>" +
      "<section class=\"public-document__section\"><h2>" + escapeHtml(copy.installHeading) +
      "</h2>" + renderHostBlocks(copy) + "</section>" +
      "<section class=\"public-document__section\"><h2>" + escapeHtml(copy.firstHeading) +
      "</h2><p>" + escapeHtml(copy.firstIntro) + "</p><pre><code>" +
      escapeHtml(copy.firstPrompt) + "</code></pre><p>" + escapeHtml(copy.otherHosts) +
      "</p></section><section class=\"public-document__section\"><h2>" +
      escapeHtml(copy.resultHeading) + "</h2><p>" + escapeHtml(copy.result) +
      "</p></section><section class=\"public-document__section\"><h2>" +
      escapeHtml(copy.nextHeading) + "</h2><p>" + escapeHtml(copy.nextText) +
      " <a href=\"" + escapeHtml(publicDocPath(code, "use-cases")) + "\">" +
      escapeHtml(copy.nextLabel) + "</a></p>" + renderSourceLinks(copy.sources) + "</section>";
  } else if (pageId === "use-cases") {
    sections = "<section class=\"public-document__section\"><h2>" + escapeHtml(copy.scenariosHeading) +
      "</h2>" + renderScenarioCards(guide, code, copy) + "</section>" +
      "<section class=\"public-document__section\"><h2>" + escapeHtml(copy.boundaryHeading) +
      "</h2><p>" + escapeHtml(copy.boundary) + "</p><p><a href=\"" +
      escapeHtml(publicDocPath(code, "use-cases-quick")) + "\">" +
      escapeHtml(PAGE_COPY[code]["use-cases-quick"].heading) + "</a></p></section>" +
      "<section class=\"public-document__section\"><h2>" + escapeHtml(copy.sourcesHeading) +
      "</h2>" + renderSourceLinks(copy.sources) + "</section>";
  } else {
    sections = "<section class=\"public-document__section\"><h2>" + escapeHtml(copy.checklistHeading) +
      "</h2>" + renderList(copy.checklist) + "</section>" +
      "<section class=\"public-document__section\"><h2>" + escapeHtml(copy.promptsHeading) +
      "</h2>" + renderPrompts(copy) + "</section>" +
      "<section class=\"public-document__section\"><h2>" + escapeHtml(copy.noteHeading) +
      "</h2><p>" + escapeHtml(copy.note) + "</p><p><a href=\"" +
      escapeHtml(publicDocPath(code, "use-cases")) + "\">" +
      escapeHtml(copy.nextLabel) + "</a></p><h3>" + escapeHtml(copy.sourcesHeading) +
      "</h3>" + renderSourceLinks(copy.sources) + "</section>";
  }
  return "<main id=\"content\" class=\"public-document public-document--" + escapeHtml(pageId) +
    "\"><article><h1>" + escapeHtml(copy.heading) + "</h1><p class=\"public-document__intro\">" +
    escapeHtml(copy.intro) + "</p>" + sections + "</article></main>";
}

export async function loadAutoPublicDocs(repositoryRoot, { requireComplete = true } = {}) {
  const [catalog, scope] = await Promise.all([
    readFile(path.join(repositoryRoot, "plugins/better-workflows/templates/auto.json"), "utf8").then(JSON.parse),
    readFile(path.join(repositoryRoot, "plugins/better-workflows/config/product-release-scope-v1.json"), "utf8").then(JSON.parse)
  ]);
  if (catalog.name !== "auto" || catalog.kind !== "AutoPolicyCatalogV1" ||
      JSON.stringify(Object.keys(catalog.variants).sort()) !== JSON.stringify([...VARIANT_IDS].sort()) ||
      JSON.stringify(scope.publicEntrypointIds) !== '["auto"]' ||
      JSON.stringify(scope.publicTemplateIds) !== '["auto"]' ||
      JSON.stringify(scope.publicSkillIds) !== '["auto"]') {
    throw new Error("Auto public documentation requires the exact V5.0 Auto-only source contract");
  }
  const localeCatalog = Object.fromEntries(locales.map((locale) => [locale.code, locale.messages]));
  const localeCopyComplete = CONNECTORS_LOCALES.every((code) => PAGE_IDS.size === Object.keys(PAGE_COPY[code] || {}).length &&
    [...PAGE_IDS].every((pageId) => PAGE_COPY[code][pageId]?.heading && PAGE_COPY[code][pageId]?.description));
  const complete = localeCopyComplete &&
    JSON.stringify(Object.keys(localeCatalog).sort()) === JSON.stringify([...CONNECTORS_LOCALES].sort()) &&
    CONNECTORS_LOCALES.every((code) => localeCatalog[code] &&
      ["DESCRIPTION", "HERO_LEAD", "CONTROL_SUMMARY", "QUICK_START", "DOCS_TITLE", "LANGUAGE", "SKIP"]
        .every((key) => typeof localeCatalog[code][key] === "string" && localeCatalog[code][key].trim()));
  if (requireComplete && !complete) throw new Error("Auto public documentation has an incomplete RC1 locale body catalog");
  return {
    catalog: { locales: localeCatalog, variants: catalog.variants },
    source: { keys: VARIANT_IDS },
    status: { complete, missing: complete ? [] : ["locale-body"], codes: CONNECTORS_LOCALES },
    assets: {}
  };
}

export function autoPublicDocsCoverage(guide, { publicRouteIntegrated = false } = {}) {
  return {
    publicRouteIntegrated,
    locales: guide?.status?.complete ? CONNECTORS_LOCALES.length : 0,
    publicTemplateIds: ["auto"],
    publicVariantIds: [...VARIANT_IDS]
  };
}

export function renderAutoPublicDocs(guide, code, pageId) {
  if (!PAGE_IDS.has(pageId)) throw new Error("Unknown Auto public documentation page: " + pageId);
  if (!guide?.catalog?.locales ||
      JSON.stringify(Object.keys(guide.catalog.locales).sort()) !== JSON.stringify([...CONNECTORS_LOCALES].sort())) {
    throw new Error("Auto public documentation has an incomplete RC1 locale body catalog");
  }
  if (JSON.stringify(Object.keys(guide.catalog.variants).sort()) !== JSON.stringify([...VARIANT_IDS].sort())) {
    throw new Error("Auto public documentation variants differ from the installed Auto catalog");
  }
  const locale = locales.find((item) => item.code === code);
  if (!locale || !guide.catalog.locales[code]) throw new Error("Unknown Auto public documentation locale: " + code);
  const copy = PAGE_COPY[code]?.[pageId];
  if (!copy) throw new Error("Auto public documentation has incomplete page copy: " + code + "/" + pageId);
  const canonical = "https://betterworkflows.dev" + publicDocPath(code, pageId);
  const alternatives = PUBLIC_LOCALE_IDS.map((candidate) =>
    '<link rel="alternate" hreflang="' + escapeHtml(candidate) + '" href="https://betterworkflows.dev' +
    escapeHtml(publicDocPath(candidate, pageId)) + '">').join("\n") +
    '\n<link rel="alternate" hreflang="x-default" href="https://betterworkflows.dev' +
    escapeHtml(publicDocPath("zh-Hant-TW", pageId)) + '">';
  const robots = pageId === "quick" ? "index,follow" : "noindex,follow";
  const structuredData = pageId === "quick"
    ? '<script type="application/ld+json">' + JSON.stringify({
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: copy.heading,
      description: copy.description,
      inLanguage: code,
      url: canonical
    }).replaceAll("<", "\\u003c") + "</script>"
    : "";
  const html = [
    "<!doctype html>",
    '<html lang="' + escapeHtml(code) + '" dir="' + (locale.dir === "rtl" ? "rtl" : "ltr") + '">',
    "<head>",
    '  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '  <meta name="robots" content="' + robots + '">',
    '  <meta name="description" content="' + escapeHtml(copy.description) + '">',
    "  <title>" + escapeHtml(copy.heading) + " · Better Workflows</title>",
    '  <link rel="canonical" href="' + escapeHtml(canonical) + '">',
    "  " + alternatives,
    "  " + structuredData,
    "</head>",
    "<body>",
    renderPageBody(guide, code, pageId),
    "</body></html>"
  ].join("\n");
  return applyPublicSiteShell(html, {
    code,
    path: publicDocPath(code, pageId),
    kind: "document"
  });
}
