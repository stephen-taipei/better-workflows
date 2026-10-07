import { applyPublicSiteShell } from './public-site-shell.mjs';
import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { CONNECTORS_LOCALES, DEFAULT_LOCALE, PUBLIC_LOCALE_IDS, locales } from "./website-locales.mjs";
import { publicDocPath } from "./public-docs.mjs";
import { applyHtmlEdits, decodeHtml, escapeHtml, readDataObject, scanHtml } from "./html-source.mjs";
import { readStructuredDataArray, readStructuredDataObject } from "./structured-data-source.mjs";

export const EVIDENCE_CINEMA_SOURCE = Object.freeze({
  path: "docs/html/evidence-cinema/index.html",
  sha256: "281a3a9b5aeff93bc79ee7ac9874517bbc8c3897d8e7f6b3132854bc16f48d10",
  rendererPath: "docs/html/evidence-cinema/shared/renderer.js",
  rendererSha256: "6886ea7b87c8a392ab8f2d2abc2f0c2e3fabad173bf1944a6bba780ec99abdf7",
  cssPath: "docs/html/evidence-cinema/shared/cinema.css",
  cssSha256: "03631d1fcb2d70e6c3916d88768198d2d9fee8513e2cbb71d271473a279a3e63",
  catalogPath: "docs/rc1-catalogs/interactive/evidence-cinema.json"
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error("Interactive evidence cinema: " + message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const normalize = (text) => decodeHtml(text).replace(/\s+/g, " ").trim();
const under = (node, predicate) => { while (node) { if (predicate(node)) return true; node = node.parent; } return false; };
const hasClass = (node, name) => (node.attributes.class || "").split(/\s+/).includes(name);
const languageNode = (node) => under(node, (item) => item.tag === "option" && item.parent?.attributes.id === "locale-select"
  || Object.hasOwn(item.attributes, "data-public-locale-nav") || Object.hasOwn(item.attributes, "data-public-locale-buttons") || hasClass(item, "locale-noscript-links"));
const actors = ["Captain Root", "Scout Pixel", "Ledger", "Vera", "Sentinel", "Echo"];
const technicalBody = new Set(["BW", "BETTER WORKFLOWS · 5.0.0", "🌐", "↓", "↺", "←", "▶", "→", "·", "/", "00:00", "01:04", "0.75×", "1×", "1.25×", "1.5×", "01", "02", "03", "04", "05", "06", "SCENE 01 / 08", "run.created → pending", ...actors]);
const proseData = (key) => /^(?:scenes\.\d+|unknown)\.(?:short|alt|role|title|dialogue|badge|fact|source\.label|records\.\d+\.summary)$/.test(key);
const interfaceCopy = Object.freeze({
  transcriptTitle: "完整八幕正文與另一種結局",
  transcriptNote: "不必啟用 JavaScript，就能閱讀每幕對白、治理說明與全部示範紀錄。播放控制只改變呈現，不改變任何真實 run。",
  pause: "暫停", play: "播放", jump: "跳到第 {number} 幕：{title}", portrait: "{actor} 角色肖像",
  sceneIndex: "第 {number} 幕 / 08", unknownHeading: "第 08 幕：provider outcome unknown 的結局",
  draft: "完整正文翻譯草稿；尚未通過獨立語義審查，並非正式發布或 live run 的完成證明。",
  noScript: "JavaScript 已關閉：所有八幕、兩種結局、角色與來源仍可完整閱讀；只有播放與記錄切換停用。"
});
function flatten(value, prefix = "", output = {}) {
  if (typeof value === "string") output[prefix] = value;
  else for (const [key, child] of Object.entries(value)) flatten(child, prefix ? prefix + "." + key : key, output);
  return output;
}
function validateScenes(scenes, unknown) {
  const keys = ["no", "short", "accent", "image", "alt", "actor", "role", "avatar", "title", "dialogue", "state", "badge", "fact", "source", "records"];
  if (!Array.isArray(scenes) || scenes.length !== 8 || !same(Object.keys(unknown), ["title", "dialogue", "state", "badge", "fact", "records"])) fail("scene shape");
  const counts = [2, 2, 3, 2, 2, 3, 2, 2];
  for (const [index, scene] of scenes.entries()) {
    if (!same(Object.keys(scene), keys) || scene.no !== String(index + 1).padStart(2, "0") || !actors.includes(scene.actor)
      || !/^#[a-f\d]{6}$/.test(scene.accent) || !/^assets\/scene-0[1-8]-[a-z]+\.webp$/.test(scene.image)
      || !/^assets\/character-[a-z]+\.webp$/.test(scene.avatar) || !same(Object.keys(scene.source), ["label", "href"])
      || !Array.isArray(scene.records) || scene.records.length !== counts[index]) fail("scene identity or dimensions");
  }
  if (!Array.isArray(unknown.records) || unknown.records.length !== 2 || unknown.state !== "provider outcome unknown → indeterminate") fail("unknown ending");
  for (const scene of [...scenes, unknown]) for (const record of scene.records) {
    if (!same(Object.keys(record), ["kind", "id", "status", "summary", "binding", "digest"])
      || !/^[a-z][a-z-]+$/.test(record.kind) || !/^demo-[\w-]+$/.test(record.id)
      || !["complete", "open", "ready", "issued", "indeterminate"].includes(record.status)
      || !/^(?:sha256:demo-|ledger:demo-|sentinel:demo-|finding:demo-|state:demo-|token:demo-|attempt:demo-|receipt:demo-|decision:demo-|decision:not-issued)/.test(record.digest)) fail("demo record shape or identity");
  }
}

// All prose is bound, including hidden/accessible labels and runtime records.
// The original runtime file is parsed as data only and is never evaluated.
export function describeEvidenceCinemaSource(html, renderer, css, pins = EVIDENCE_CINEMA_SOURCE) {
  if (hash(html) !== pins.sha256 || hash(renderer) !== pins.rendererSha256 || hash(css) !== pins.cssSha256) fail("source digest changed");
  const scenes = readStructuredDataArray(renderer, "const demoScenes = ").value;
  const unknown = readStructuredDataObject(renderer, "const unknownEnding = ").value;
  validateScenes(scenes, unknown);
  const tree = scanHtml(html), messages = {}, lookup = new Map(), targets = [], invariants = [];
  const register = (value) => {
    if (!lookup.has(value)) { const key = "text." + String(lookup.size + 1).padStart(3, "0"); lookup.set(value, key); messages[key] = value; }
    return lookup.get(value);
  };
  const ids = tree.elements.map((node) => node.attributes.id).filter(Boolean);
  if (ids.length !== new Set(ids).size || tree.elements.filter((node) => node.tag === "html").length !== 1) fail("source DOM identity");
  const root = tree.elements.find((node) => node.tag === "html");
  if (root.attributes["data-replay-mode"] !== "demo" || root.attributes["data-ending"] !== "verified" || root.attributes["data-asset-base"] !== "assets/") fail("source is not a public demo");
  const localeLinks = tree.elements.filter((node) => Object.hasOwn(node.attributes, "data-locale-static"));
  if (!same(localeLinks.map((node) => node.attributes["data-locale-button"]), CONNECTORS_LOCALES)
    || !same(localeLinks.map((node) => node.attributes.href), CONNECTORS_LOCALES.map((code) => publicDocPath(code, "evidence-cinema")))) fail("locale route identity");
  for (const text of tree.texts) {
    const value = normalize(text.value);
    if (!value || languageNode(text.parent)) continue;
    if (technicalBody.has(value)) { invariants.push(value); continue; }
    targets.push({ type: "text", text, key: register(value) });
  }
  for (const node of tree.elements) for (const attr of ["alt", "aria-label", "title", "placeholder", ...(node.tag === "meta" && node.attributes.name === "description" ? ["content"] : [])]) {
    const value = node.attributes[attr];
    if (value && !languageNode(node)) targets.push({ type: "attribute", node, attr, key: register(value) });
  }
  const data = { scenes, unknown }, flat = flatten(data), dataTargets = [];
  for (const [key, value] of Object.entries(flat)) if (proseData(key)) dataTargets.push({ path: key, key: register(value) });
  const uiKeys = Object.fromEntries(Object.entries(interfaceCopy).map(([key, value]) => [key, register(value)]));
  const scripts = tree.elements.filter((node) => node.tag === "script");
  if (!same(scripts.map((node) => node.attributes.src), ["shared/renderer.js", "shared/public-locales.js"])) fail("unexpected source script");
  const manifest = { html: hash(html), renderer: hash(renderer), css: hash(css), messages,
    targets: targets.map((target) => ({ key: target.key, type: target.type, start: target.text?.start ?? target.node.start, attr: target.attr ?? null })),
    dataTargets, uiKeys, invariants: Object.fromEntries(Object.entries(flat).filter(([key]) => !proseData(key))), literalBody: invariants };
  return { html, renderer, css, tree, scripts, data, messages, keys: Object.keys(messages), lookup, targets, dataTargets, uiKeys, manifest, manifestDigest: hash(JSON.stringify(manifest)) };
}

export function validateEvidenceCinemaCatalog(source, catalog, { requireComplete = true } = {}) {
  if (!same(Object.keys(catalog), ["source", "sourceSha256", "rendererSha256", "manifestDigest", "status", "locales"])
    || catalog.source !== EVIDENCE_CINEMA_SOURCE.path || catalog.sourceSha256 !== source.manifest.html
    || catalog.rendererSha256 !== source.manifest.renderer || catalog.manifestDigest !== source.manifestDigest) fail("catalog source binding");
  if (catalog.status !== "translated-pending-review") fail("catalog status");
  const codes = Object.keys(catalog.locales), missing = CONNECTORS_LOCALES.filter((code) => !codes.includes(code));
  if (!same(codes, CONNECTORS_LOCALES.filter((code) => codes.includes(code)))) fail("locale scope or ordering");
  if (requireComplete && missing.length) fail("incomplete RC1 locale catalog");
  for (const code of codes) {
    const messages = catalog.locales[code];
    if (!same(Object.keys(messages), source.keys)) fail("message parity " + code);
    for (const key of source.keys) {
      const original = source.messages[key], value = messages[key];
      if (typeof value !== "string" || !value.trim() || /[<>\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(decodeHtml(value))) fail("invalid plain text " + code + "/" + key);
      if (code === "zh-Hant-TW" && value !== original) fail("canonical source copy " + key);
      if (!same(original.match(/\d+(?:\.\d+)*/g) || [], value.match(/\d+(?:\.\d+)*/g) || [])) fail("numeric drift " + key);
      if (!same(original.match(/\{[a-z]+\}/g) || [], value.match(/\{[a-z]+\}/g) || [])) fail("placeholder drift " + key);
      const tokens = original.match(/Better Workflows|JavaScript|TaskContract v2|INCONCLUSIVE|P0\/P1|expectedLedgerDigest|evidence\.attached|run\.created|[a-z-]+\.mjs|auto\/SKILL\.md/g) || [];
      for (const token of new Set(tokens)) if (!value.includes(token)) fail("identifier drift " + key + ": " + token);
      if ((code === "en" && /\p{Script=Han}/u.test(value)) || (!code.startsWith("zh-") && /\p{Script=Han}/u.test(original) && original.length > 12 && value === original)) fail("untranslated source fallback " + code + "/" + key);
      if (code !== "en" && !code.startsWith("zh-") && catalog.locales.en && value.length > 32 && value === catalog.locales.en[key]) fail("English prose fallback " + code + "/" + key);
    }
  }
  return { codes, missing, complete: missing.length === 0 };
}

export async function loadEvidenceCinema(repositoryRoot, { requireComplete = true } = {}) {
  const pin = EVIDENCE_CINEMA_SOURCE;
  const source = describeEvidenceCinemaSource(...await Promise.all([pin.path, pin.rendererPath, pin.cssPath].map((file) => readFile(path.join(repositoryRoot, file), "utf8"))));
  const raw = await readFile(path.join(repositoryRoot, pin.catalogPath), "utf8");
  JSON.parse(raw);
  const catalog = readDataObject("const messages = " + raw + ";").value;
  const status = validateEvidenceCinemaCatalog(source, catalog, { requireComplete });
  const assetNames = [...new Set([...source.tree.elements.filter((node) => node.tag === "img").map((node) => node.attributes.src), ...source.data.scenes.flatMap((scene) => [scene.image, scene.avatar])])].sort();
  const assets = [];
  for (const name of assetNames) {
    if (!/^assets\/[a-z0-9-]+\.webp$/.test(name)) fail("asset path");
    const file = path.join(repositoryRoot, "docs/html/evidence-cinema", name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) fail("asset is not a physical file");
    assets.push({ path: name, sha256: hash(await readFile(file)) });
  }
  const runtime = await readFile(path.join(repositoryRoot, "scripts/assets/interactive-evidence-cinema.js"), "utf8");
  const styles = await readFile(path.join(repositoryRoot, "scripts/assets/interactive-evidence-cinema.css"), "utf8");
  return { source, catalog, status, runtime, styles, assets, catalogSha256: hash(raw), runtimeSha256: hash(runtime), stylesSha256: hash(styles) };
}

export function evidenceCinemaData(guide, code) {
  validateEvidenceCinemaCatalog(guide.source, guide.catalog, { requireComplete: false });
  const messages = guide.catalog.locales[code];
  if (!messages) fail("missing locale body " + code);
  const data = structuredClone(guide.source.data);
  for (const target of guide.source.dataTargets) {
    const parts = target.path.split("."), leaf = parts.pop(); let node = data;
    for (const key of parts) node = node[key];
    node[leaf] = messages[target.key];
  }
  return { ...data, ui: Object.fromEntries(Object.entries(guide.source.uiKeys).map(([key, id]) => [key, messages[id]])) };
}

export function evidenceCinemaCoverage(guide, { publicRouteIntegrated = false } = {}) {
  const status = validateEvidenceCinemaCatalog(guide.source, guide.catalog, { requireComplete: publicRouteIntegrated });
  return { source: EVIDENCE_CINEMA_SOURCE.path, sourceSha256: guide.source.manifest.html, manifestDigest: guide.source.manifestDigest, messageCount: guide.source.keys.length,
    catalogedLocales: status.codes, missingLocales: status.missing, completeCatalog: status.complete, scenes: 8, endings: 2,
    fullTextParity: "not-promoted", semanticReview: "not-established", nativeSpeakerReview: "not-established",
    publicRouteIntegration: publicRouteIntegrated ? "build-integrated-not-deployment-proof" : "pending",
    catalogSha256: guide.catalogSha256, runtimeSha256: guide.runtimeSha256, stylesSha256: guide.stylesSha256 };
}

export function evidenceCinemaUrl(target, code) {
  if (!CONNECTORS_LOCALES.includes(code) || /[\\\u0000-\u0020]/.test(target)) fail("invalid route input");
  if (/^#[\w-]+$/.test(target)) return target;
  if (CONNECTORS_LOCALES.some((locale) => target === publicDocPath(locale, "evidence-cinema"))) return target;
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(target)) fail("unsupported source URL");
  const url = new URL(target, "https://source.invalid/docs/html/evidence-cinema/index.html");
  const pluginPaths = ["skills/auto/SKILL.md", ...["core", "ledger", "evidence", "review", "git"].map((name) => "scripts/lib/" + name + ".mjs")];
  const mapped = url.pathname === "/docs/html/index.html" ? publicDocPath(code, "guide")
    : url.pathname === "/docs/html/use-cases/index.html" ? publicDocPath(code, "use-cases")
    : /^\/docs\/html\/evidence-cinema\/assets\/[a-z0-9-]+\.webp$/.test(url.pathname) ? url.pathname.replace("/docs/html/", "/docs/")
    : url.pathname === "/docs/html/evidence-cinema/shared/cinema.css" ? "/docs/evidence-cinema/shared/cinema.css"
    : pluginPaths.some((name) => url.pathname === "/plugins/better-workflows/" + name) ? url.pathname : null;
  if (!mapped || url.search) fail("unmapped source URL " + target);
  return mapped + url.hash;
}

const attrsHtml = (attrs) => Object.entries(attrs).map(([name, value]) => value === null ? " " + name : " " + name + '="' + escapeHtml(value) + '"').join("");
const token = (template, vars) => template.replace(/\{([a-z]+)\}/g, (_, key) => vars[key]);
const recordHtml = (record) => '<article class="record" data-demo-record="' + escapeHtml(record.id) + '"><div class="record-top"><code class="record-kind">' + escapeHtml(record.kind) + '</code><code class="record-status ' + escapeHtml(record.status) + '">' + escapeHtml(record.status) + '</code></div><strong>' + escapeHtml(record.summary) + '</strong><dl>' + ["id", "binding", "digest"].map((key) => '<dt><code>' + key + '</code></dt><dd><code>' + escapeHtml(record[key]) + '</code></dd>').join("") + '</dl></article>';
const demoRecord = (scene, ending) => ({ demo: true, authoritative: false, presentationOnly: true, recordedOutcome: null, ending, scene: scene.no, derivedState: scene.state, records: scene.records });
function sceneBody(scene, code, ending) {
  return '<p>' + escapeHtml(scene.dialogue) + '</p><p class="record-note">' + escapeHtml(scene.fact) + '</p><p><code>' + escapeHtml(scene.state) + '</code></p><div class="record-list">' + scene.records.map(recordHtml).join("") + '</div><a class="record-source" href="' + escapeHtml(evidenceCinemaUrl(scene.source.href, code)) + '">' + escapeHtml(scene.source.label) + '</a><pre class="transcript-json">' + escapeHtml(JSON.stringify(demoRecord(scene, ending), null, 2)) + '</pre>';
}

export const renderEvidenceCinemaPreview = (guide, code) => renderPage(guide, code, false);
export const renderEvidenceCinemaHtml = (guide, code) => renderPage(guide, code, true);
function renderPage(guide, code, publicPage) {
  const source = describeEvidenceCinemaSource(guide.source.html, guide.source.renderer, guide.source.css);
  validateEvidenceCinemaCatalog(source, guide.catalog, { requireComplete: publicPage });
  const locale = locales.find((value) => value.code === code);
  if (!locale) fail("unsupported locale");
  const messages = guide.catalog.locales[code];
  if (!messages) fail("missing locale body " + code);
  const { scenes, unknown, ui } = evidenceCinemaData(guide, code), first = scenes[0];
  const text = (value) => { const key = source.lookup.get(value); if (!key) fail("unbound render copy"); return messages[key]; };
  const edits = [], whole = new Set(), content = new Set(), nodeById = (id) => source.tree.elements.find((node) => node.attributes.id === id);
  const replace = (node, value) => { if (!node) fail("missing source slot"); whole.add(node); edits.push({ start: node.start, end: node.end, value }); };
  const fill = (id, value) => { const node = nodeById(id); if (!node) fail("missing source slot " + id); content.add(node); edits.push({ start: node.openEnd, end: node.contentEnd, value }); };
  const links = PUBLIC_LOCALE_IDS.map((item) => { const language = locales.find((entry) => entry.code === item); return '<a data-cinema-locale="' + item + '" lang="' + item + '" hreflang="' + item + '" dir="' + (language.dir || "ltr") + '" href="' + publicDocPath(item, "evidence-cinema") + '"' + (item === code ? ' aria-current="page"' : '') + '>' + escapeHtml(language.label) + '</a>'; }).join("");
  replace(source.tree.elements.find((node) => hasClass(node, "locale-control")), '<details class="cinema-locales"><summary>' + escapeHtml(text("語言")) + ' · ' + escapeHtml(locale.label) + '</summary><nav aria-label="' + escapeHtml(text("語言")) + '">' + links + '</nav></details>');
  for (const node of source.tree.elements.filter((node) => hasClass(node, "locale-menu") || hasClass(node, "locale-noscript-links") || hasClass(node, "locale-button-section"))) replace(node, "");
  const noScript = source.tree.elements.filter((node) => node.tag === "noscript").at(-1);
  replace(noScript, '<noscript><p class="boundary-note">' + escapeHtml(ui.noScript) + '</p></noscript>');
  const payload = { locale: code, demo: true, authoritative: false, presentationOnly: true, scenes, unknown, ui };
  const json = JSON.stringify(payload).replace(/[<>&\u2028\u2029]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  replace(source.scripts[0], '<script id="evidence-cinema-data" type="application/json">' + json + '</script>');
  replace(source.scripts[1], '<script type="module">' + guide.runtime + '</script>');
  replace(source.tree.elements.find((node) => node.attributes.href === "shared/public-locales.css"), '<style>' + guide.styles + '</style>');
  fill("record-list", first.records.map(recordHtml).join(""));
  fill("raw-record", escapeHtml(JSON.stringify(demoRecord(first, "verified"), null, 2)));
  fill("scene-index", escapeHtml(token(ui.sceneIndex, { number: first.no })));
  fill("scene-fact", escapeHtml(first.fact));
  fill("record-source", escapeHtml(text("查看權威來源 ↗")) + ' · ' + escapeHtml(first.source.label));
  fill("timeline", scenes.map((scene, index) => '<li><a data-demo-scene="' + index + '" href="#chapter-' + scene.no + '" aria-label="' + escapeHtml(token(ui.jump, { number: scene.no, title: scene.short })) + '"><span class="dot" aria-hidden="true">' + scene.no + '</span><b>' + escapeHtml(scene.short) + '</b></a></li>').join(""));
  const transcript = scenes.map((scene) => '<article class="cinema-chapter" id="chapter-' + scene.no + '" data-transcript-scene="' + scene.no + '"><h3>' + scene.no + ' · ' + escapeHtml(scene.title) + '</h3><figure><img src="' + evidenceCinemaUrl(scene.image, code) + '" alt="' + escapeHtml(scene.alt) + '" loading="lazy" width="1693" height="909"><figcaption>' + escapeHtml(scene.actor + " · " + scene.role) + '</figcaption></figure>' + sceneBody(scene, code, "verified") + '</article>').join("");
  const alternate = { ...scenes[7], ...unknown };
  const shell = nodeById("cinema");
  edits.push({ start: shell.end, end: shell.end, value: '<section id="transcript" class="cinema-transcript" aria-labelledby="transcript-heading"><h2 id="transcript-heading">' + escapeHtml(ui.transcriptTitle) + '</h2><p>' + escapeHtml(ui.transcriptNote) + '</p><p class="boundary-note">' + escapeHtml(text("這些是 sanitized 教學票根；卡片包含 evidence、ledger、finding 與 action state，不把所有記錄冒充成同一種 evidence。")) + '</p>' + transcript + '<article class="cinema-chapter" id="chapter-08-unknown" data-transcript-ending="unknown"><h3>' + escapeHtml(ui.unknownHeading) + '</h3><h4>' + escapeHtml(unknown.title) + '</h4>' + sceneBody(alternate, code, "unknown") + '</article></section>' });
  const attributeTargets = source.targets.filter((target) => target.type === "attribute");
  for (const node of source.tree.elements) {
    if (under(node, (item) => whole.has(item)) || under(node.parent, (item) => content.has(item))) continue;
    const attrs = { ...node.attributes };
    if (node.tag === "html") Object.assign(attrs, { lang: code, dir: locale.dir || "ltr", "data-locale": code, "data-replay-mode": "public-demo", "data-asset-base": "/docs/evidence-cinema/assets/" });
    for (const target of attributeTargets.filter((target) => target.node === node)) attrs[target.attr] = messages[target.key];
    if (attrs.id === "scene-image") attrs.alt = first.alt;
    if (attrs.id === "actor-avatar") attrs.alt = token(ui.portrait, { actor: first.actor });
    if (node.tag === "button" || node.tag === "input" || node.tag === "select") attrs.disabled = null;
    const cast = Object.hasOwn(attrs, "data-cast-scene");
    if (cast) { delete attrs.type; delete attrs.disabled; attrs.href = "#chapter-" + scenes[Number(attrs["data-cast-scene"])].no; }
    for (const name of ["href", "src"]) if (attrs[name]) attrs[name] = evidenceCinemaUrl(attrs[name], code);
    if (!same(attrs, node.attributes) || cast) edits.push({ start: node.start, end: node.openEnd, value: "<" + (cast ? "a" : node.tag) + attrsHtml(attrs) + ">" });
    if (cast) edits.push({ start: node.contentEnd, end: node.end, value: "</a>" });
  }
  for (const target of source.targets.filter((target) => target.type === "text")) {
    if (under(target.text.parent, (node) => whole.has(node) || content.has(node))) continue;
    const leading = /^\s*/.exec(target.text.value)[0], trailing = /\s*$/.exec(target.text.value)[0];
    edits.push({ start: target.text.start, end: target.text.end, value: leading + escapeHtml(messages[target.key]) + trailing });
  }
  const head = source.tree.elements.find((node) => node.tag === "head"), main = nodeById("main");
  edits.push({ start: head.contentEnd, end: head.contentEnd, value: '\n<meta name="robots" content="noindex,follow"><link rel="canonical" href="https://betterworkflows.dev' + publicDocPath(code, "evidence-cinema") + '">' + (publicPage ? [...PUBLIC_LOCALE_IDS, "x-default"].map((item) => '<link rel="alternate" hreflang="' + item + '" href="https://betterworkflows.dev' + publicDocPath(item === "x-default" ? DEFAULT_LOCALE : item, "evidence-cinema") + '">').join("") : "") });
  edits.push({ start: main.openEnd, end: main.openEnd, value: '<p class="cinema-draft">' + escapeHtml(ui.draft) + '</p>' });
  const rendered = applyHtmlEdits(source.html, edits);
  return publicPage ? applyPublicSiteShell(rendered, { code, path: publicDocPath(code, "evidence-cinema"), kind: "cinema" }) : rendered;
}
