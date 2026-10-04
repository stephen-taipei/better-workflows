import { publicDocPath } from "./public-docs.mjs";

const RELEASE_URL = "https://github.com/stephen-taipei/better-workflows/releases/tag/V5.0.rc1";

const COPY = Object.freeze({
  en: {
    heroEyebrow: "BETTER WORKFLOWS · V5.0 RC1",
    heroTitle: "Make AI-written code safer to deliver.",
    heroLead: "Keep coding work within a clear scope, check the changes that matter, and pause when the result is unclear.",
    heroPrimary: "Get started",
    heroSecondary: "See how it works",
    imageAlt: "An illustrated open book and checked shield connected by blue workflow diagrams.",
    productKicker: "WHY BETTER WORKFLOWS",
    productTitle: "A clearer path from request to handoff",
    productIntro: "Give AI coding tasks boundaries you can understand and checks you can review.",
    features: [
      ["Set clear boundaries", "State the goal and scope first. Git changes use a separate task branch and worktree."],
      ["Check the right changes", "Checks are tied to the repository, change, and delivery target they actually cover."],
      ["Pause when something is unclear", "Stale checks, conflicting state, or an unknown provider result stop the workflow for a decision."]
    ],
    workflowKicker: "HOW IT WORKS",
    workflowTitle: "Three steps to a reviewable result",
    workflowIntro: "One public entry adapts the checks to the task and its risk.",
    workflow: [
      ["Describe the outcome", "Start with $better-workflows:auto and say what result you need."],
      ["Check the current work", "Auto reads the repository and task context, then chooses a suitable level of verification."],
      ["Review before handoff", "Review the changes and their checks. Protected or external actions require explicit authority and confirmed results."]
    ],
    installKicker: "V5.0 RC1 · CONTROLLED PRERELEASE",
    installTitle: "Install the public Codex release",
    installIntro: "Add the marketplace and plugin, then open a new Codex task and describe the outcome you need.",
    installCommands: "# Install Better Workflows V5.0 RC1\ncodex plugin marketplace add stephen-taipei/better-workflows\ncodex plugin add better-workflows@better-workflows\n\n# In a new Codex task\n$better-workflows:auto Review this repository and fix verified defects.",
    installNote: "Public scope: macOS with Codex, Gemini CLI, or Qwen Code on Node.js 22/24. The bundled helper requires Node.js 22.14 or newer. RC1 is not GA; Claude Code, Linux, and Windows qualification is deferred to V5.1.",
    installGuideLink: "See installation steps for all supported hosts",
    releaseLink: "Read the RC1 release notes",
    principlesKicker: "THE PROMISE",
    principlesTitle: "Clear limits. Honest results.",
    principles: [
      "A request sets the goal; it does not grant permission for external actions.",
      "A check counts only when it covers the current work and intended destination.",
      "Missing, stale, conflicting, or unknown results stop the workflow for review."
    ],
    principlesNote: "Better Workflows checks observable workflow mistakes. It has not yet been statistically proven to reduce rework or decision errors across long-running AI tasks.",
    docsKicker: "DOCUMENTATION",
    docsTitle: "Find the guide you need",
    docs: [
      ["guide", "Documentation", "Find the right guide for your next task."],
      ["quick", "Quick start", "Install Better Workflows and run your first task."],
      ["use-cases", "Use cases", "Choose a path for reviewing, changing code, or delivery."],
      ["use-cases-quick", "Practical examples", "Start with a request you can adapt to your work."],
      ["evidence-cinema", "Evidence Cinema", "Explore how checks and delivery fit together in an interactive demo."]
    ],
    faqKicker: "FAQ",
    faqTitle: "Common questions",
    faq: [
      ["What does Better Workflows do?", "It gives AI coding tasks a clear goal, selects checks suited to the task, and records what is ready for review."],
      ["Will it push, merge, or deploy on its own?", "A prompt alone never grants that authority. Protected delivery and other external actions require explicit approval and a confirmed result."],
      ["What does the RC1 release support?", "The public RC1 scope is macOS with Codex, Gemini CLI, or Qwen Code on Node.js 22/24. Claude Code, Linux, and Windows qualification is deferred to V5.1."],
      ["Does it guarantee bug-free code?", "No. It can check observable workflow conditions, but it has not been statistically proven to reduce errors or rework across long AI tasks."]
    ]
  },
  "zh-Hant-TW": {
    heroEyebrow: "BETTER WORKFLOWS · V5.0 RC1",
    heroTitle: "讓 AI 寫的程式，更安心地交付。",
    heroLead: "先劃清工作範圍，檢查真正重要的變更；遇到不確定的結果，就先停下來確認。",
    heroPrimary: "開始使用",
    heroSecondary: "了解運作方式",
    imageAlt: "藍色流程圖環繞著一本打開的書與通過檢查的盾牌。",
    productKicker: "BETTER WORKFLOWS 的價值",
    productTitle: "從提出需求，到清楚交接",
    productIntro: "為 AI 程式開發任務設定清楚的界線，並提供可供檢視的檢查結果。",
    features: [
      ["先訂清楚範圍", "先說明目標與範圍。需要修改 Git 時，使用獨立的任務分支與工作樹。"],
      ["檢查實際改動", "檢查結果會對應實際檢查過的儲存庫、變更內容與交付目標。"],
      ["遇到不確定就先停下", "檢查過期、狀態衝突或供應商結果未知時，流程會停止並等待決定。"]
    ],
    workflowKicker: "運作方式",
    workflowTitle: "三步驟，得到可檢視的結果",
    workflowIntro: "從唯一公開入口開始，依照任務與風險選擇適合的檢查方式。",
    workflow: [
      ["說明你要的結果", "使用 $better-workflows:auto，描述你希望完成什麼。"],
      ["檢查目前的工作狀態", "Auto 會先讀取儲存庫與任務脈絡，再選擇適合的驗證強度。"],
      ["交接前先檢視", "檢視變更與檢查結果。受保護的交付或其他外部操作，需要明確授權並確認結果。"]
    ],
    installKicker: "V5.0 RC1 · 受控預發布",
    installTitle: "安裝公開版 Codex 外掛",
    installIntro: "加入市集與外掛後，開啟新的 Codex 任務，描述你希望完成的結果。",
    installCommands: "# 安裝 Better Workflows V5.0 RC1\ncodex plugin marketplace add stephen-taipei/better-workflows\ncodex plugin add better-workflows@better-workflows\n\n# 在新的 Codex 任務中輸入\n$better-workflows:auto 檢視這個儲存庫並修正已確認的缺陷。",
    installNote: "公開範圍：macOS 搭配 Codex、Gemini CLI 或 Qwen Code，使用 Node.js 22/24。隨附工具需要 Node.js 22.14 或更新版本。RC1 尚非 GA；Claude Code、Linux 與 Windows 的資格驗收延至 V5.1。",
    installGuideLink: "查看各平台的安裝步驟",
    releaseLink: "閱讀 RC1 發布說明",
    principlesKicker: "產品承諾",
    principlesTitle: "界線清楚，結果誠實。",
    principles: [
      "提出需求是在說明目標，不代表已授權外部操作。",
      "檢查結果必須涵蓋目前的工作與預定交付目標，才算有效。",
      "結果缺漏、過期、衝突或未知時，流程會停下來等待檢視。"
    ],
    principlesNote: "Better Workflows 能檢查可觀察的流程錯誤；目前尚未以統計方式證明能減少長時間 AI 任務中的返工或判斷錯誤。",
    docsKicker: "文件",
    docsTitle: "依需求閱讀文件",
    docs: [
      ["guide", "文件總覽", "找到適合你下一個任務的使用指南。"],
      ["quick", "快速開始", "安裝 Better Workflows，執行第一個任務。"],
      ["use-cases", "使用情境", "從檢查、修改到交付，選擇適合的路線。"],
      ["use-cases-quick", "實用範例", "複製需求範例，再依照自己的任務調整。"],
      ["evidence-cinema", "Evidence Cinema", "透過互動示範，了解檢查與交付如何串起來。"]
    ],
    faqKicker: "常見問題",
    faqTitle: "你可能也想知道",
    faq: [
      ["Better Workflows 會做什麼？", "它會為 AI 程式開發任務設定清楚目標，依任務選擇檢查方式，並記錄哪些結果已可供檢視。"],
      ["它會自行推送、合併或部署嗎？", "單靠提示內容不會取得這些操作的授權。受保護的交付與其他外部操作都需要明確核准並確認結果。"],
      ["RC1 公開版支援哪些環境？", "公開範圍為 macOS 搭配 Codex、Gemini CLI 或 Qwen Code，使用 Node.js 22/24。Claude Code、Linux 與 Windows 的資格驗收延至 V5.1。"],
      ["它能保證程式沒有錯誤嗎？", "不能。它能檢查可觀察的流程條件，但目前尚未以統計方式證明能減少長時間 AI 任務中的錯誤或返工。"]
    ]
  }
});

const esc = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

function renderCards(items, className) {
  return items.map(([title, description], index) => `
      <article class="${className}">
        ${className === "feature-card" ? `<p class="card-number">0${index + 1}</p>` : ""}
        <h3>${esc(title)}</h3>
        <p>${esc(description)}</p>
      </article>`).join("");
}

export function renderHomepageContent(code) {
  const copy = COPY[code];
  if (!copy) throw new Error(`Unsupported homepage locale: ${code}`);

  const docs = copy.docs.map(([id, title, description]) => `
      <a class="doc-card" href="${esc(publicDocPath(code, id))}">
        <h3>${esc(title)}</h3>
        <p>${esc(description)}</p>
        <span class="doc-arrow" aria-hidden="true">↗</span>
      </a>`).join("");

  const workflow = copy.workflow.map(([title, description], index) => `
      <li class="workflow-step">
        <span class="step-number" aria-hidden="true">0${index + 1}</span>
        <h3>${esc(title)}</h3>
        <p>${esc(description)}</p>
      </li>`).join("");

  const principles = copy.principles.map((principle) => `
      <li class="principle-item">${esc(principle)}</li>`).join("");

  const faq = copy.faq.map(([question, answer]) => `
      <details class="faq-item">
        <summary>${esc(question)}</summary>
        <p>${esc(answer)}</p>
      </details>`).join("");

  return `<main id="main">
  <section class="hero shell" aria-labelledby="homepage-title">
    <div class="hero-copy">
      <p class="eyebrow">${esc(copy.heroEyebrow)}</p>
      <h1 id="homepage-title">${code === "zh-Hant-TW" ? '讓 AI 寫的程式，<span>更安心地交付。</span>' : esc(copy.heroTitle)}</h1>
      <p class="hero-lead">${esc(copy.heroLead)}</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="#install">${esc(copy.heroPrimary)}</a>
        <a class="btn btn-secondary" href="#workflow">${esc(copy.heroSecondary)}</a>
      </div>
      <p class="hero-release"><a href="${RELEASE_URL}">${esc(copy.releaseLink)}</a></p>
    </div>
    <figure class="hero-art">
      <img src="/docs/assets/better-workflows-control-plane-blue.webp" width="1536" height="1024" alt="${esc(copy.imageAlt)}" fetchpriority="high">
    </figure>
  </section>

  <section class="section shell" id="product" aria-labelledby="product-title">
    <div class="section-heading">
      <p class="section-kicker">${esc(copy.productKicker)}</p>
      <h2 id="product-title">${esc(copy.productTitle)}</h2>
      <p>${esc(copy.productIntro)}</p>
    </div>
    <div class="feature-grid">${renderCards(copy.features, "feature-card")}
    </div>
  </section>

  <section class="section shell" id="workflow" aria-labelledby="workflow-title">
    <div class="section-heading">
      <p class="section-kicker">${esc(copy.workflowKicker)}</p>
      <h2 id="workflow-title">${esc(copy.workflowTitle)}</h2>
      <p>${esc(copy.workflowIntro)}</p>
    </div>
    <ol class="workflow-grid">${workflow}
    </ol>
  </section>

  <section class="section shell" id="install" aria-labelledby="install-title">
    <div class="section-heading">
      <p class="section-kicker">${esc(copy.installKicker)}</p>
      <h2 id="install-title">${esc(copy.installTitle)}</h2>
      <p>${esc(copy.installIntro)}</p>
    </div>
    <div class="install-grid">
      <div class="install-code"><p>${code === "en" ? "1. Run these commands in your terminal" : "1. 在終端機執行這兩行指令"}</p><pre><code>codex plugin marketplace add stephen-taipei/better-workflows
codex plugin add better-workflows@better-workflows</code></pre><p>${code === "en" ? "2. Start a new Codex task and describe your goal" : "2. 開啟新的 Codex 任務，輸入你的目標"}</p><pre><code>${code === "en" ? "$better-workflows:auto Review this repository and fix verified defects." : "$better-workflows:auto 檢視這個儲存庫並修正已確認的缺陷。"}</code></pre></div>
      <aside class="install-note">
        <p>${esc(copy.installNote)}</p>
        <p><a href="${esc(publicDocPath(code, "quick"))}">${esc(copy.installGuideLink)}</a></p>
      </aside>
    </div>
  </section>

  <section class="section shell" id="principles" aria-labelledby="principles-title">
    <div class="section-heading">
      <p class="section-kicker">${esc(copy.principlesKicker)}</p>
      <h2 id="principles-title">${esc(copy.principlesTitle)}</h2>
    </div>
    <ul class="principle-grid">${principles}
    </ul>
    <p class="principles-note">${esc(copy.principlesNote)}</p>
  </section>

  <section class="section shell" id="docs" aria-labelledby="docs-title">
    <div class="section-heading">
      <p class="section-kicker">${esc(copy.docsKicker)}</p>
      <h2 id="docs-title">${esc(copy.docsTitle)}</h2>
    </div>
    <div class="docs-grid">${docs}
    </div>
  </section>

  <section class="section shell" id="faq" aria-labelledby="faq-title">
    <div class="section-heading">
      <p class="section-kicker">${esc(copy.faqKicker)}</p>
      <h2 id="faq-title">${esc(copy.faqTitle)}</h2>
    </div>
    <div class="faq-list">${faq}
    </div>
  </section>
</main>`;
}
