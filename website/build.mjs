#!/usr/bin/env node
// Builds betterworkflows.dev into dist/website/ from website/copy/<locale>.json
// and the existing design (styles.css, site.js). One homepage per locale:
// zh-Hant-TW at /, every other locale at /<code>/. `--check` builds into a
// temporary folder and fails on a missing or extra copy key, disallowed HTML
// in copy, a leftover template token, or an internal link with no file.
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const site = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(site, "..");
const ORIGIN = "https://betterworkflows.dev";
const REPO = "https://github.com/stephen-taipei/better-workflows";
const BLOB = `${REPO}/blob/main`;
const DEFAULT = "zh-Hant-TW";
const RTL = new Set(["ar", "he"]);
const SPONSOR = { address: "TGuMUi1d8MoBQcuFrGJZnu4JrbaeP3wy9a", qr: "/docs/assets/sponsor-usdt-trc20.jpeg" };
const STATIC = ["styles.css", "site.js", "better-workflows-mark.svg", "favicon.svg", "favicon.ico", "apple-touch-icon.png", "robots.txt", "healthz"];
const CMD = {
  cli: "npm install -g @better-workflows/core@alpha",
  demo: 'node "$(npm root -g)/@better-workflows/core/examples/stale-green/demo.mjs"',
  market: "claude plugin marketplace add stephen-taipei/better-workflows",
  install: "claude plugin install better-workflows-core@better-workflows --scope local",
  init: "bw init",
};

const esc = (v) => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const ic = (name, extra = "") => `<svg class="ic${extra ? ` ${extra}` : ""}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const EXT = 'target="_blank" rel="noopener noreferrer"';
const home = (code) => (code === DEFAULT ? "/" : `/${code}/`);
const links = (code) => ({
  guideEn: `${BLOB}/packages/bw-core/docs/getting-started.md`,
  guideZh: `${BLOB}/packages/bw-core/docs/getting-started.zh-TW.md`,
  policyRef: `${BLOB}/packages/bw-core/README.md#policy`,
  readme: `${BLOB}/docs/locales/${code}.md`,
  v5Archive: `${REPO}/tree/frozen/v5`,
  contribute: `${BLOB}/CONTRIBUTING.md`,
  security: `${BLOB}/SECURITY.md`,
});

const PATHS = ["M3 8h10M9 4l4 4-4 4", "M8 3v10M4 9l4 4 4-4", "M6.5 3.5h-3v9h9v-3M9.5 3.5h3v3M12.5 3.5L7 9"];
const SPRITE = '<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">'
  + `<symbol id="i-arrow" viewBox="0 0 16 16"><path d="${PATHS[0]}"/></symbol><symbol id="i-down" viewBox="0 0 16 16"><path d="${PATHS[1]}"/></symbol><symbol id="i-ext" viewBox="0 0 16 16"><path d="${PATHS[2]}"/></symbol>`
  + '<symbol id="i-copy" viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5"/><path d="M3 10.5V4a1 1 0 011-1h6.5"/></symbol>'
  + '<symbol id="i-check" viewBox="0 0 16 16"><path d="M3 8.5l3.2 3.2L13 4.8"/></symbol><symbol id="i-x" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></symbol>'
  + '<symbol id="i-sun" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></symbol>'
  + '<symbol id="i-moon" viewBox="0 0 16 16"><path d="M13.2 9.6A5.6 5.6 0 016.4 2.8a5.6 5.6 0 106.8 6.8z"/></symbol><symbol id="i-menu" viewBox="0 0 16 16"><path d="M2.5 5h11M2.5 11h11"/></symbol>'
  + '<symbol id="i-chev" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></symbol><symbol id="i-stop" viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></symbol>'
  + '<symbol id="i-lock" viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="6.5" rx="1.5"/><path d="M5.2 7V5.2a2.8 2.8 0 015.6 0V7"/></symbol>'
  + '<symbol id="i-doc" viewBox="0 0 16 16"><path d="M4 2h5.5L13 5.5V14H4z"/><path d="M6.2 9.4l1.5 1.5 2.6-2.8"/></symbol></svg>';

// Copy is authored HTML limited to <code> and <b>; everything else is escaped text.
const ALLOWED = /<\/?(code|b)>/g;
function checkCopy(code, en, value, at = "") {
  if (typeof en === "string") {
    if (en === "" && value === "") return; // an intentionally blank slot, such as a layer with no pill
    if (typeof value !== "string" || !value.trim()) throw new Error(`${code}: ${at} is missing`);
    if (/[<>]/.test(value.replace(ALLOWED, ""))) throw new Error(`${code}: ${at} has HTML other than <code> and <b>`);
    return;
  }
  if (Array.isArray(en)) {
    if (!Array.isArray(value) || value.length !== en.length) throw new Error(`${code}: ${at} needs ${en.length} items`);
    en.forEach((item, i) => checkCopy(code, item, value[i], `${at}[${i}]`));
    return;
  }
  if (!value || typeof value !== "object") throw new Error(`${code}: ${at} is missing`);
  const extra = Object.keys(value).filter((k) => !(k in en));
  if (extra.length) throw new Error(`${code}: unknown keys at ${at || "top"}: ${extra.join(", ")}`);
  for (const key of Object.keys(en)) checkCopy(code, en[key], value[key], at ? `${at}.${key}` : key);
}
// Tone and state values are class names, not text: they must equal English.
function checkTokens(code, t, en) {
  const same = (a, b, at) => { if (a !== b) throw new Error(`${code}: ${at} must stay "${b}"`); };
  t.demo.gates.forEach((g, i) => same(g[2], en.demo.gates[i][2], `demo.gates[${i}][2]`));
  t.principles.pillars.forEach((p, i) => same(p[0], en.principles.pillars[i][0], `principles.pillars[${i}][0]`));
  t.principles.layers.forEach((l, i) => same(l[2], en.principles.layers[i][2], `principles.layers[${i}][2]`));
  t.boundary.cols.forEach((c, i) => { same(c[0], en.boundary.cols[i][0], `boundary.cols[${i}][0]`); same(c[1], en.boundary.cols[i][1], `boundary.cols[${i}][1]`); });
  t.status.road.forEach((r, i) => { same(r[0], en.status.road[i][0], `status.road[${i}][0]`); same(r[1], en.status.road[i][1], `status.road[${i}][1]`); });
  t.status.lic.forEach((r, i) => same(r[3], en.status.lic[i][3], `status.lic[${i}][3]`));
  t.docList.forEach((d, i) => same(d[0], en.docList[i][0], `docList[${i}][0]`));
}

async function facts() {
  const src = path.join(root, "packages/bw-core/src");
  let lines = 0;
  for (const entry of await readdir(src, { recursive: true })) {
    if (entry.endsWith(".mjs")) lines += (await readFile(path.join(src, entry), "utf8")).split("\n").length - 1;
  }
  let tests = 0;
  const testDir = path.join(root, "packages/bw-core/test");
  for (const f of await readdir(testDir)) if (f.endsWith(".test.mjs")) tests += ((await readFile(path.join(testDir, f), "utf8")).match(/^\s*test\(/gm) || []).length;
  const pkg = JSON.parse(await readFile(path.join(root, "packages/bw-core/package.json"), "utf8"));
  const hooks = JSON.parse(await readFile(path.join(root, "packages/bw-core/hooks/hooks.json"), "utf8")).hooks;
  const ci = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const list = (key) => (ci.match(new RegExp(`${key}: \\[([^\\]]*)\\]`))?.[1] ?? "").split(",").filter((s) => s.trim()).length;
  return [lines.toLocaleString("en-US"), String(tests), String(Object.keys(pkg.dependencies ?? {}).length), String(Object.keys(hooks).length), String(list("os") * list("node"))];
}

const secHead = (n, idx, en, id, title, lead) => `<header class="sec-head"><p class="home-eyebrow mono"><span class="idx">${n}</span>${idx}<span class="en">${en}</span></p><h2 id="${id}">${title}</h2>${lead ? `<p class="lead">${lead}</p>` : ""}</header>`;
const copyBtn = (label, text) => `<button class="copy" type="button" data-copy aria-label="${esc(label)}">${ic("copy", "ic-copy")}${ic("check", "ic-ok")}<span class="copy-t">${esc(text)}</span></button>`;
const cmd = (command, label, text, chat = false) => `<div class="cmd${chat ? " cmd-chat" : ""}"><span class="cmd-p" aria-hidden="true">${chat ? "›" : "$"}</span><code>${esc(command)}</code>${copyBtn(label, text)}</div>`;

function mainHtml(code, t, nums, count) {
  const L = links(code);
  const strip = t.strip.items.map(([label, sub], i) => `<li><span class="num mono">${i === 5 ? count : nums[i]}</span><span class="cap"><b>${label}</b>${sub}</span></li>`).join("");
  const gates = t.demo.gates.map(([name, kind, state], i) => `<li class="gate" data-gate="${i + 1}" data-state="${state}"><i class="g-led" aria-hidden="true"></i><span class="g-name">${name}<small>${kind}</small></span><span class="g-state mono">${state === "blocked" ? "BLOCKED" : "PASS"}</span></li>`).join("");
  const lines = t.demo.lines.map(([k, text], i) => `<li class="tl" data-step="${i + 1}"><span class="tl-sym" aria-hidden="true">›</span><span class="tl-k">${k}</span><span class="tl-t">${text}</span></li>`).join("");
  const supported = `<td class="c-rc1"><i class="led" aria-hidden="true"></i>${t.hosts.supported}</td>`;
  const planned = `<td class="c-def">${t.hosts.planned}</td>`;
  const hostRows = `<tr><th scope="row"><b>Claude Code</b><span class="pill pill-sig">${t.hosts.firstHost}</span></th>${supported}${supported}<td class="c-def">${t.hosts.untested}</td></tr>`
    + ["Codex", "Gemini CLI", "Qwen Code"].map((h) => `<tr><th scope="row"><b>${h}</b><span class="pill pill-line">${t.hosts.v5only}</span></th>${planned}${planned}${planned}</tr>`).join("");
  return `<main id="main" class="home-main">
<section class="home-hero" id="product" aria-labelledby="home-title">
  <div class="hero-bg" aria-hidden="true"></div>
  <div class="shell">
    <div class="hero-top">
      <div class="home-hero-copy">
        <a class="badge" href="#status"><i class="led" aria-hidden="true"></i><b>V6 Core</b><span>${t.hero.badge}</span>${ic("arrow")}</a>
        <h1 id="home-title">${t.hero.h1}<br><span class="h1-signal">${t.hero.h1Signal}</span></h1>
        <p class="lead">${t.hero.lead}</p>
        <ul class="tagline mono" aria-label="${esc(t.hero.taglineLabel)}">${t.hero.chips.map((c) => `<li>${c}</li>`).join("")}</ul>
        <div class="cta-row">
          <a class="btn btn-primary" href="#install">${t.hero.ctaInstall}${ic("arrow")}</a>
          <a class="btn btn-ghost" href="#gate-demo">${t.hero.ctaDemo}${ic("down")}</a>
          <a class="link-quiet" href="${REPO}" ${EXT}>GitHub${ic("ext")}</a>
        </div>
      </div>
      <aside class="spec" aria-labelledby="spec-title">
        <div class="spec-head"><i class="led led-live" aria-hidden="true"></i><h2 id="spec-title" class="mono">V6 <span>${t.hero.specTitle}</span></h2></div>
        <dl class="spec-list">
          <div><dt>STATUS</dt><dd><span class="pill pill-warn">alpha</span></dd></div>
          <div><dt>HOST</dt><dd>${t.hero.host}</dd></div>
          <div><dt>OS</dt><dd class="mono">${t.hero.platforms}</dd></div>
          <div><dt>NODE</dt><dd class="mono">22.14+</dd></div>
          <div><dt>LICENSE</dt><dd class="mono">${t.hero.license}</dd></div>
          <div><dt>NOW</dt><dd>${t.hero.status}</dd></div>
        </dl>
        <a class="spec-foot" href="${code === "zh-Hant-TW" ? L.guideZh : L.guideEn}" ${EXT}>${t.hero.notes}${ic("ext")}</a>
      </aside>
    </div>
    <section class="console inst" id="gate-demo" aria-labelledby="demo-title" data-outcome="unknown" data-run="done">
      <span class="tick t-tl" aria-hidden="true"></span><span class="tick t-tr" aria-hidden="true"></span>
      <div class="console-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><h2 id="demo-title" class="mono console-title">stale-green <span>· ${t.demo.title}</span></h2><span class="illus mono">${ic("stop")}demo</span></div>
      <div class="console-body">
        <div class="term" role="group" aria-label="${esc(t.demo.termLabel)}">
          <ol class="term-log">
            <li class="tl tl-cmd" data-step="0"><span class="tl-sym" aria-hidden="true">$</span><span class="tl-t"><b>claude</b> ${t.demo.prompt}</span></li>
            ${lines}
          </ol>
          <div class="verdict-slot"><p class="term-verdict" data-for-state="halt"><strong class="mono">${ic("stop")}SENT BACK</strong><span>${t.demo.halt}</span></p></div>
        </div>
        <div class="gates" role="group" aria-labelledby="gates-title">
          <div class="gates-head mono"><h3 id="gates-title">${t.demo.gatesTitle}</h3><span>${t.demo.progress}</span></div>
          <ol class="gate-list">${gates}</ol>
        </div>
      </div>
      <div class="console-foot"><p class="foot-note">${t.demo.note}</p></div>
    </section>
  </div>
</section>

<section class="shell strip-wrap" aria-label="${esc(t.strip.label)}"><ul class="strip">${strip}</ul></section>

<section class="sec shell" id="principles" aria-labelledby="principles-title">
  ${secHead("01", t.principles.idx, t.principles.en, "principles-title", t.principles.title, t.principles.lead)}
  <ul class="pillars">${t.principles.pillars.map(([icon, title, body], i) => `<li class="pillar"><svg class="ic-lg" aria-hidden="true"><use href="#i-${icon}"/></svg><p class="mono kick">RULE 0${i + 1}</p><h3>${title}</h3><p>${body}</p></li>`).join("")}</ul>
  <div class="split">
    <div class="compare-wrap">
      <h3 class="blk-title mono">WITHOUT <i>vs</i> WITH<span>${t.principles.compareTitle}</span></h3>
      <div class="tbl-card"><table class="compare">
        <thead><tr><th scope="col"><span class="sr-only">${t.principles.compareAspect}</span></th><th scope="col">${t.principles.without}</th><th scope="col">${t.principles.with}</th></tr></thead>
        <tbody>${t.principles.compare.map(([a, b, c]) => `<tr><th scope="row" class="mono">${a}</th><td>${b}</td><td>${c}</td></tr>`).join("")}</tbody>
      </table></div>
    </div>
    <figure class="stack">
      <h3 class="blk-title mono">AUTHORITY<span>${t.principles.layersTitle}</span></h3>
      <ol class="stack-list">${t.principles.layers.map(([name, body, tone, pill], i) => `<li class="lyr${tone ? ` lyr-${tone}` : ""}"><span class="lyr-n mono">L${i + 1}</span><div><b class="mono">${name}</b><p>${body}</p></div>${pill ? `<span class="pill pill-line">${pill}</span>` : ""}</li>`).join("")}</ol>
    </figure>
  </div>
</section>

<section class="sec shell" id="workflow" aria-labelledby="workflow-title">
  ${secHead("02", t.workflow.idx, t.workflow.en, "workflow-title", t.workflow.title, t.workflow.lead)}
  <div class="blk"><h3 class="blk-title mono">HOOKS<span>${t.workflow.hooksTitle}</span></h3><ol class="auto-flow-list">${t.workflow.hooks.map((h) => `<li>${h}</li>`).join("")}</ol></div>
  <div class="blk">
    <div class="lanes">
      <article class="lane card">
        <header><span class="tag mono">STOP</span><h4>${t.workflow.completion.name}</h4><p class="sub">${t.workflow.completion.sub}</p></header>
        <p>${t.workflow.completion.body}</p>
        <p class="mono kick guard-k">${t.workflow.completion.guardsK}</p>
        <ul class="guards">${t.workflow.completion.guards.map((g) => `<li>${ic("check")}<span>${g}</span></li>`).join("")}</ul>
      </article>
      <article class="lane lane-ev card">
        <header><span class="tag tag-sig mono">PRETOOLUSE</span><h4>${t.workflow.actions.name}</h4><p class="sub">${t.workflow.actions.sub}</p></header>
        <p>${t.workflow.actions.body}</p>
        <p class="mono kick guard-k">${t.workflow.actions.kindsK}</p>
        <ul class="chips chips-up">${t.workflow.actions.kinds.map((k) => `<li><code>${k}</code></li>`).join("")}</ul>
      </article>
    </div>
  </div>
  <div class="blk"><h3 class="blk-title mono">RULES<span>${t.workflow.rulesTitle}</span></h3><ul class="git-rules">${t.workflow.rules.map((r, i) => `<li><span class="mono">R${i + 1}</span><p>${r}</p></li>`).join("")}</ul></div>
</section>

<section class="sec shell" id="hosts" aria-labelledby="hosts-title">
  ${secHead("03", t.hosts.idx, t.hosts.en, "hosts-title", t.hosts.title, t.hosts.lead)}
  <div class="hosts-grid">
    <div class="matrix-card card">
      <table class="rc-matrix">
        <caption class="sr-only">${t.hosts.caption}</caption>
        <thead><tr><th scope="col"><span class="sr-only">${t.hosts.hostCol}</span></th><th scope="col" class="mono">macOS</th><th scope="col" class="mono">Linux</th><th scope="col" class="mono">Windows</th></tr></thead>
        <tbody>${hostRows}</tbody>
      </table>
      <p class="matrix-note mono"><i class="led" aria-hidden="true"></i>${t.hosts.matrixNote}<span>${t.hosts.matrixNoteSub}</span></p>
    </div>
    <aside class="reco card" aria-labelledby="reco-title">
      <p class="mono kick">FIRST HOST</p>
      <h3 id="reco-title">${t.hosts.recoTitle}</h3>
      <p>${t.hosts.recoBody}</p>
      <ul class="chips"><li><code>SessionStart</code></li><li><code>PreToolUse</code></li><li><code>PostToolUse</code></li><li><code>Stop</code></li></ul>
      <p class="reco-foot">${t.hosts.recoFoot}</p>
    </aside>
  </div>
</section>

<section class="sec shell" id="install" aria-labelledby="install-title">
  ${secHead("04", t.install.idx, t.install.en, "install-title", t.install.title, t.install.lead)}
  <div class="install-grid">
    <ol class="steps">
      ${t.install.steps.map(([title, body], i) => `<li><span class="mono n">${i + 1}</span><div><h3>${title}</h3><p>${body}</p></div></li>`).join("")}
      <li class="steps-note"><p>${t.install.stepsNote} <a href="${code === "zh-Hant-TW" ? L.guideZh : L.guideEn}" ${EXT}>${t.install.guideLink}${ic("arrow")}</a></p></li>
    </ol>
    <div class="install-term inst" data-tabs>
      <div class="tablist" role="tablist" aria-label="${esc(t.install.tabsLabel)}"><button type="button" role="tab" id="tab-claude" aria-controls="panel-claude" aria-selected="true">Claude Code</button></div>
      <div class="tabpanel" role="tabpanel" id="panel-claude" aria-labelledby="tab-claude">
        <h3 class="nojs-title">Claude Code</h3>
        ${cmd(CMD.cli, t.install.copyCommand, t.install.copy)}
        ${cmd(CMD.market, t.install.copyCommand, t.install.copy)}
        ${cmd(CMD.install, t.install.copyCommand, t.install.copy)}
        ${cmd(CMD.init, t.install.copyCommand, t.install.copy)}
        <p class="pnote">${ic("arrow")}${t.install.demoNote}</p>
        ${cmd(CMD.demo, t.install.copyCommand, t.install.copy)}
      </div>
      <div class="first-req">
        <p class="mono kick">${t.install.firstK}</p>
        ${cmd(t.install.firstAsk, t.install.copyRequest, t.install.copy, true)}
        <p class="pnote pnote-mute">${t.install.firstNote}</p>
      </div>
    </div>
  </div>
</section>

<section class="sec shell" id="boundary" aria-labelledby="boundary-title">
  <div class="slab inst">
    <span class="tick t-tl" aria-hidden="true"></span><span class="tick t-tr" aria-hidden="true"></span><span class="tick t-bl" aria-hidden="true"></span><span class="tick t-br" aria-hidden="true"></span>
    ${secHead("05", t.boundary.idx, t.boundary.en, "boundary-title", t.boundary.title, t.boundary.lead).replace('class="sec-head"', 'class="sec-head sec-head-slab"')}
    <div class="b-cols">${t.boundary.cols.map(([tone, icon, kicker, title, items]) => `<article class="b-col b-${tone}"><p class="b-k mono">${ic(icon)}${kicker}</p><h3>${title}</h3><ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul></article>`).join("")}</div>
    <div class="boundary-card" id="proof-boundaries">
      <blockquote class="claim-limit">${t.boundary.claim}</blockquote>
      <ol class="boundary-list" aria-label="${esc(t.boundary.rulesLabel)}">${t.boundary.rules.map((r, i) => `<li><span class="mono">B${i + 1}</span><span>${r}</span></li>`).join("")}</ol>
    </div>
  </div>
</section>

<section class="section shell v5-status-section" id="status" aria-labelledby="status-title">
  <header class="sec-head"><p class="home-eyebrow mono"><span class="idx">06</span>${t.status.idx}<span class="en">${t.status.en}</span></p><h2 id="status-title">${t.status.title}</h2><p class="lead">${t.status.lead}</p></header>
  <ol class="road">${t.status.road.map(([pill, tone, kicker, name, ver, body]) => `<li class="stn${pill === "NOW" ? " stn-now" : pill === "NEXT" ? " stn-ga" : ""}"><span class="stn-dot" aria-hidden="true"></span><p class="mono kick"><span class="pill pill-${tone}">${pill}</span> ${kicker}</p><h3>${name}</h3><p class="mono ver">${ver}</p><p>${body}</p></li>`).join("")}</ol>
  <div class="status-grid">
    <div class="statement card"><h3 class="blk-title mono">STATEMENT<span>${t.status.statementTitle}</span></h3><p class="statement-k mono">${t.status.statementK}</p>${t.status.statement.map((p) => `<p>${p}</p>`).join("")}</div>
    <div class="license card">
      <div class="lic-head"><h3 class="blk-title mono">LICENSING<span>${t.status.licTitle}</span></h3></div>
      <table class="lic-table"><caption class="sr-only">${t.status.licTitle}</caption>
        <thead><tr><th scope="col">${t.status.licItem}</th><th scope="col">${t.status.licForm}</th><th scope="col">${t.status.licState}</th></tr></thead>
        <tbody>${t.status.lic.map(([item, form, note, tone, state]) => `<tr><th scope="row">${item}</th><td>${form}${note ? `<small>${note}</small>` : ""}</td><td><span class="pill pill-${tone}">${state}</span></td></tr>`).join("")}</tbody>
      </table>
    </div>
  </div>
</section>

<section class="sec shell" id="docs" aria-labelledby="docs-title">
  ${secHead("07", t.docs.idx, t.docs.en, "docs-title", t.docs.title, t.docs.lead)}
  <ul class="doc-list">${t.docList.map(([key, title, body]) => `<li><a class="doc-row" href="${L[key]}" ${EXT}><span class="mono doc-path">${esc(L[key].replace(BLOB, "").replace(REPO, ""))}</span><span class="doc-main"><b>${title}</b><small>${body}</small></span>${ic("ext")}</a></li>`).join("")}</ul>
</section>

<section class="sec shell" id="faq" aria-labelledby="faq-title">
  <div class="faq-grid">
    <header class="faq-head"><p class="home-eyebrow mono"><span class="idx">08</span>${t.faq.idx}<span class="en">${t.faq.en}</span></p><h2 id="faq-title">${t.faq.title}</h2><p class="lead">${t.faq.lead} <a href="${REPO}/issues" ${EXT}>GitHub Issues${ic("ext")}</a></p></header>
    <div class="faq-list">${t.faq.items.map(([q, a], i) => `<details class="faq-item"${i === 0 ? " open" : ""}><summary>${q}${ic("chev")}</summary><p>${a}</p></details>`).join("")}</div>
  </div>
</section>

<section class="sec shell sponsor-section" id="sponsor" aria-labelledby="sponsor-title">
  <div class="sponsor card">
    <div class="sponsor-copy"><p class="home-eyebrow mono"><span class="idx">09</span>${t.sponsor.idx}<span class="en">${t.sponsor.en}</span></p><h2 id="sponsor-title">${t.sponsor.title}</h2><p class="sponsor-method">${t.sponsor.cta}</p><p>${t.sponsor.body}</p></div>
    <div class="sponsor-pay">
      <a class="qr" href="${SPONSOR.qr}" ${EXT} aria-label="${esc(t.sponsor.qrLabel)}"><img class="sponsor-qr" src="${SPONSOR.qr}" width="200" height="197" loading="lazy" decoding="async" alt="USDT (TRC20) QR: ${SPONSOR.address}"></a>
      <div class="addr"><p class="mono net sponsor-network" dir="ltr">USDT · TRON (TRC20)</p><div class="addr-row"><code class="sponsor-address" dir="ltr">${SPONSOR.address}</code>${copyBtn(t.sponsor.copyAddress, t.install.copy)}</div></div>
    </div>
  </div>
</section>

<section class="shell cta-wrap" aria-labelledby="cta-title">
  <div class="cta inst">
    <div class="cta-copy">
      <p class="mono kick"><i class="led led-live" aria-hidden="true"></i>${t.cta.kicker}</p>
      <h2 id="cta-title">${t.cta.title}</h2>
      <p>${t.cta.body}</p>
      <div class="cta-row"><a class="btn btn-primary" href="#install">${t.hero.ctaInstall}${ic("arrow")}</a><a class="btn btn-ghost" href="${REPO}" ${EXT}>${t.cta.notes}${ic("ext")}</a></div>
    </div>
    <img class="cta-mark" src="/better-workflows-mark.svg" width="756" height="608" alt="" aria-hidden="true" loading="lazy" decoding="async">
  </div>
</section>
</main>`;
}

function header(code, c, locales, v) {
  const h = home(code);
  const langs = locales.map((l) => `<a data-locale-link="${l.code}" lang="${l.code}" hreflang="${l.code}" href="${home(l.code)}"${l.code === code ? ' aria-current="page"' : ""}>${esc(l.name)}</a>`).join("");
  const brand = `<a class="brand" href="${h}" aria-label="${esc(c.homeLabel)}"><img class="brand-mark brand-mark--converge" src="/better-workflows-mark.svg?v=${v}" width="34" height="27" alt="" aria-hidden="true"><span class="brand-name">Better Workflows</span><span class="brand-tag" title="V6 Core alpha">V6</span></a>`;
  return `<a class="skip-link" href="#main">${c.skip}</a><header class="site-header" data-site-header><span class="read-bar" aria-hidden="true"></span><div class="shell header-inner">${brand}`
    + `<nav class="site-nav" id="site-nav" aria-label="${esc(c.product)}" data-site-nav><a href="${h}#product">${c.product}</a><a href="${h}#principles">${c.principles}</a><a href="${h}#workflow">${c.workflow}</a><a href="${h}#install">${c.install}</a><a href="${h}#docs">${c.docs}</a><a href="${h}#sponsor">${c.sponsor}</a><a class="nav-gh" href="${REPO}" ${EXT}>GitHub${ic("ext")}</a><a class="nav-cta btn btn-primary" href="${h}#install">${c.installCta}${ic("arrow")}</a></nav>`
    + `<div class="header-tools"><details class="lang-menu"><summary aria-label="${esc(c.language)}">${esc(locales.find((l) => l.code === code).name)}</summary><nav class="lang" aria-label="${esc(c.language)}">${langs}</nav></details>`
    + `<button class="icon-btn theme-toggle" type="button" data-theme-toggle data-label-to-dark="${esc(c.themeToDark)}" data-label-to-light="${esc(c.themeToLight)}" aria-label="${esc(c.themeToggle)}" aria-pressed="false">${ic("sun", "ic-sun")}${ic("moon", "ic-moon")}</button>`
    + `<button class="icon-btn nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" data-menu-toggle data-label-open="${esc(c.menuOpen)}" data-label-close="${esc(c.menuClose)}" aria-label="${esc(c.menuOpen)}">${ic("menu", "ic-menu")}${ic("x", "ic-close")}</button></div></div></header>`;
}

function footer(code, c, note) {
  const h = home(code), L = links(code);
  return `<footer class="site-footer"><div class="shell footer-grid"><div class="foot-brand"><a class="brand" href="${h}" aria-label="${esc(c.homeLabel)}"><img class="brand-mark brand-mark--converge" src="/better-workflows-mark.svg" width="34" height="27" alt="" aria-hidden="true"><span class="brand-name">Better Workflows</span></a><p>${c.tagline}</p><p class="foot-chip mono"><i class="led" aria-hidden="true"></i>${c.chip}</p></div>`
    + `<nav aria-labelledby="f-over"><h2 id="f-over" class="mono">${c.overview}</h2><a href="${h}#principles">${c.principles}</a><a href="${h}#workflow">${c.workflow}</a><a href="${h}#hosts">${c.hosts}</a><a href="${h}#install">${c.install}</a><a href="${h}#boundary">${c.boundary}</a><a href="${h}#status">${c.status}</a><a href="${h}#faq">${c.faq}</a></nav>`
    + `<nav aria-labelledby="f-res"><h2 id="f-res" class="mono">${c.resources}</h2><a href="${L.guideEn}" ${EXT}>${c.guideEn}</a><a href="${L.guideZh}" ${EXT}>${c.guideZh}</a><a href="${L.policyRef}" ${EXT}>${c.policyRef}</a><a href="${L.v5Archive}" ${EXT}>${c.v5Archive}</a></nav>`
    + `<nav aria-labelledby="f-oss"><h2 id="f-oss" class="mono">${c.project}</h2><a href="${REPO}" ${EXT}>GitHub</a><a href="${L.contribute}" ${EXT}>${c.contribute}</a><a href="${L.security}" ${EXT}>${c.security}</a><a href="${h}#sponsor">${c.sponsor}</a></nav></div>`
    + `<div class="shell footer-bottom mono"><span>© Better Workflows</span><span>${c.license}</span><span>betterworkflows.dev <i>${c.alias}</i></span>${note ? `<span>${esc(note)} <a href="${home("en")}" hreflang="en" lang="en">English</a></span>` : ""}</div></footer>`;
}

function head(code, t, locales, v) {
  const url = `${ORIGIN}${home(code)}`;
  const image = `${ORIGIN}/docs/assets/better-workflows-control-plane-blue.webp`;
  const alternates = [...locales.map((l) => `<link rel="alternate" hreflang="${l.code}" href="${ORIGIN}${home(l.code)}">`), `<link rel="alternate" hreflang="x-default" href="${ORIGIN}/">`].join("");
  const data = JSON.stringify({ "@context": "https://schema.org", "@type": "SoftwareSourceCode", name: "Better Workflows", description: t.meta.description, url, codeRepository: REPO, license: `${BLOB}/packages/bw-core/LICENSE`, programmingLanguage: "JavaScript", runtimePlatform: "Node.js", inLanguage: code }).replaceAll("<", "\\u003c");
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="index,follow,max-image-preview:large">`
    + `<title>${esc(t.meta.title)}</title><meta name="description" content="${esc(t.meta.description)}"><link rel="canonical" href="${url}">${alternates}`
    + `<meta property="og:type" content="website"><meta property="og:site_name" content="Better Workflows"><meta property="og:locale" content="${code.replaceAll("-", "_")}"><meta property="og:url" content="${url}"><meta property="og:title" content="${esc(t.meta.title)}"><meta property="og:description" content="${esc(t.meta.description)}"><meta property="og:image" content="${image}"><meta property="og:image:alt" content="${esc(t.meta.imageAlt)}">`
    + `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(t.meta.title)}"><meta name="twitter:description" content="${esc(t.meta.description)}"><meta name="twitter:image" content="${image}">`
    + `<script type="application/ld+json">${data}</script>`
    + `<link rel="icon" href="/favicon.ico?v=${v}" sizes="48x48"><link rel="icon" href="/favicon.svg?v=${v}" type="image/svg+xml" sizes="any"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${v}">`
    + `<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f3eee2" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#13100b" media="(prefers-color-scheme: dark)">`
    + `<script>try{const t=localStorage.getItem('better-workflows-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch{}document.documentElement.classList.add('js');</script>`
    + `<link rel="stylesheet" href="/styles.css?v=${v}"><script src="/site.js?v=${v}" defer></script>`;
}

const page = (code, headHtml, body) => `<!doctype html>\n<html lang="${code}" dir="${RTL.has(code) ? "rtl" : "ltr"}"><head>${headHtml}</head><body class="site-page home-site">${SPRITE}${body}</body></html>\n`;

async function build(out) {
  const catalog = JSON.parse(await readFile(path.join(root, "docs/locales/catalog.json"), "utf8"));
  const locales = catalog.locales;
  const en = JSON.parse(await readFile(path.join(site, "copy/en.json"), "utf8"));
  const copies = new Map();
  const missing = [];
  for (const { code } of locales) {
    const file = path.join(site, "copy", `${code}.json`);
    const t = await readFile(file, "utf8").then(JSON.parse, () => null);
    if (!t) { missing.push(code); continue; }
    checkCopy(code, en, t);
    checkTokens(code, t, en);
    copies.set(code, t);
  }
  if (missing.length) throw new Error(`website/copy is missing: ${missing.join(", ")}`);
  const extra = (await readdir(path.join(site, "copy"))).filter((f) => !locales.some((l) => `${l.code}.json` === f));
  if (extra.length) throw new Error(`website/copy has files for no locale: ${extra.join(", ")}`);
  // Locales whose README is machine-translated carry the same label on the site.
  const notes = JSON.parse(await readFile(path.join(site, "machine-notes.json"), "utf8"));
  for (const { code } of locales) {
    if (Boolean(catalog.text[code]?.machine) !== Boolean(notes[code])) throw new Error(`website/machine-notes.json: ${code} must ${notes[code] ? "not " : ""}have a note, as in docs/locales/catalog.json`);
  }

  const hash = createHash("sha256");
  for (const f of STATIC) hash.update(f).update(await readFile(path.join(site, f)));
  const v = hash.digest("hex").slice(0, 12);
  const nums = await facts();

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const f of STATIC) await cp(path.join(site, f), path.join(out, f));
  await cp(path.join(root, "docs/html/assets"), path.join(out, "docs/assets"), { recursive: true });
  for (const { code } of locales) {
    const t = copies.get(code);
    const body = header(code, t.shell, locales, v) + mainHtml(code, t, nums, String(locales.length)) + footer(code, t.shell, notes[code]);
    const file = path.join(out, home(code).slice(1), "index.html");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, page(code, head(code, t, locales, v), body));
  }
  const nf = (await readFile(path.join(site, "404.html"), "utf8"))
    .replace("__SITE_DEFAULT_LOCALE__", DEFAULT).replace("__SITE_DEFAULT_DIRECTION__", "ltr")
    .replace('<a class="btn btn-ghost" href="/docs/">查看文件 · Docs</a>', `<a class="btn btn-ghost" href="${links(DEFAULT).guideZh}" ${EXT}>查看文件 · Docs</a>`);
  await writeFile(path.join(out, "404.html"), nf);
  const urls = locales.map((l) => `<url><loc>${ORIGIN}${home(l.code)}</loc></url>`).join("");
  await writeFile(path.join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`);
  return locales.length;
}

async function verify(out) {
  const problems = [];
  const files = (await readdir(out, { recursive: true })).filter((f) => f.endsWith(".html"));
  for (const f of files) {
    const html = await readFile(path.join(out, f), "utf8");
    if (f.startsWith("docs/")) continue; // V5 archive, copied as is
    for (const m of html.matchAll(/__[A-Z][A-Z0-9_]+__/g)) problems.push(`${f}: leftover token ${m[0]}`);
    for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
      const target = path.join(out, m[1].endsWith("/") ? `${m[1]}index.html` : m[1]);
      if (!(await stat(target).catch(() => null))) problems.push(`${f}: ${m[1]} does not exist`);
    }
    for (const id of ["product", "principles", "workflow", "hosts", "install", "boundary", "status", "docs", "faq", "sponsor"]) {
      if (f !== "404.html" && !html.includes(`id="${id}"`)) problems.push(`${f}: section #${id} is missing`);
    }
  }
  return problems;
}

const check = process.argv.includes("--check");
const out = check ? await mkdtemp(path.join(tmpdir(), "bw-site-")) : path.resolve(process.env.SITE_OUTPUT_DIR || path.join(root, "dist/website"));
try {
  const count = await build(out);
  const problems = await verify(out);
  if (problems.length) {
    for (const p of problems) process.stderr.write(`${p}\n`);
    process.exit(1);
  }
  process.stdout.write(`${check ? "checked" : `wrote ${path.relative(process.cwd(), out)} with`} ${count} locale homepages\n`);
} finally {
  if (check) await rm(out, { recursive: true, force: true });
}
