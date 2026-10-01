import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONNECTORS_LOCALES, PUBLIC_RC1_LOCALE_IDS, locales, publicRc1Locales } from "./website-locales.mjs";
import { publicDocCopy, publicDocPath } from "./public-docs.mjs";

const PAGE_IDS = new Set(["guide", "quick", "use-cases", "use-cases-quick"]);
const VARIANT_IDS = ["read-only-v1", "code-change-v1", "dev-publish-v1"];
const VARIANT_EVIDENCE = {
  "read-only-v1": ["source-inventory", "observed-result"],
  "code-change-v1": ["patch-review", "diff-review", "repo-gates"],
  "dev-publish-v1": ["target-branch-dev", "required-checks", "provider-reconciliation"]
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
})[character]);

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
  const complete = JSON.stringify(Object.keys(localeCatalog).sort()) === JSON.stringify([...CONNECTORS_LOCALES].sort()) &&
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
  if (!PAGE_IDS.has(pageId)) throw new Error(`Unknown Auto public documentation page: ${pageId}`);
  if (!guide?.catalog?.locales ||
      JSON.stringify(Object.keys(guide.catalog.locales).sort()) !== JSON.stringify([...CONNECTORS_LOCALES].sort())) {
    throw new Error("Auto public documentation has an incomplete RC1 locale body catalog");
  }
  if (JSON.stringify(Object.keys(guide.catalog.variants).sort()) !== JSON.stringify([...VARIANT_IDS].sort())) {
    throw new Error("Auto public documentation variants differ from the installed Auto catalog");
  }
  const locale = locales.find((item) => item.code === code);
  if (!locale || !guide.catalog.locales[code]) throw new Error(`Unknown Auto public documentation locale: ${code}`);
  const copy = publicDocCopy(locale, pageId);
  const canonical = `https://betterworkflows.dev${publicDocPath(code, pageId)}`;
  const alternatives = PUBLIC_RC1_LOCALE_IDS.map((candidate) =>
    `<link rel="alternate" hreflang="${escapeHtml(candidate)}" href="https://betterworkflows.dev${escapeHtml(publicDocPath(candidate, pageId))}">`).join("\n") +
    `\n<link rel="alternate" hreflang="x-default" href="https://betterworkflows.dev${escapeHtml(publicDocPath("zh-Hant-TW", pageId))}">`;
  const localeLinks = publicRc1Locales.map((candidate) =>
    `<a data-auto-locale="${escapeHtml(candidate.code)}" lang="${escapeHtml(candidate.code)}" href="${escapeHtml(publicDocPath(candidate.code, pageId))}"${candidate.code === code ? ' aria-current="page"' : ""}>${escapeHtml(candidate.label)}</a>`).join("\n");
  const cards = VARIANT_IDS.map((id) => {
    const variant = guide.catalog.variants[id];
    return `<details class="policy"><summary><code>${escapeHtml(id)}</code><span>${escapeHtml(variant.defaultMode)}</span></summary>` +
      `<p><code>${escapeHtml(VARIANT_EVIDENCE[id].join(" + "))}</code></p></details>`;
  }).join("\n");
  const heading = pageId === "quick" || pageId === "use-cases-quick"
    ? locale.messages.QUICK_START : copy.title;
  const robots = pageId === "quick" ? "index,follow" : "noindex,follow";
  const intro = pageId === "use-cases" || pageId === "use-cases-quick"
    ? locale.messages.CONTROL_SUMMARY : locale.messages.HERO_LEAD;
  const structuredData = pageId === "quick"
    ? `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: heading,
      description: copy.description,
      inLanguage: code,
      url: canonical
    }).replaceAll("<", "\\u003c")}</script>`
    : "";
  return `<!doctype html>
<html lang="${escapeHtml(code)}" dir="${locale.dir === "rtl" ? "rtl" : "ltr"}">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="${robots}">
  <meta name="description" content="${escapeHtml(copy.description)}">
  <title>${escapeHtml(heading)} · Better Workflows</title>
  <link rel="canonical" href="${escapeHtml(canonical)}">
  ${alternatives}
  ${structuredData}
  <style>body{font:1rem/1.65 system-ui,sans-serif;max-width:70rem;margin:auto;padding:1.5rem;color:#142536;background:#fff}a{color:#0957a3}nav{display:flex;flex-wrap:wrap;gap:.8rem}header,main,footer{margin-block:2rem}.lead{font-size:1.2rem;max-width:58rem}.policies{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem}.policy{border:1px solid #8092a4;border-radius:.8rem;padding:1rem}.policy summary{cursor:pointer;display:flex;justify-content:space-between;gap:1rem}.policy p{overflow-wrap:anywhere}.locales{display:flex;flex-wrap:wrap;gap:.65rem}code{font-size:.92em}a:focus-visible,summary:focus-visible{outline:3px solid #e58e20}@media(prefers-color-scheme:dark){body{color:#e7edf3;background:#0c1723}a{color:#8bc3ff}.policy{border-color:#7a90a5}}</style>
</head>
<body>
  <a href="#content">${escapeHtml(locale.messages.SKIP)}</a>
  <header><a href="${escapeHtml(code === "zh-Hant-TW" ? "/" : `/${code}/`)}">Better Workflows</a></header>
  <nav aria-label="Better Workflows"><a href="${escapeHtml(publicDocPath(code, "guide"))}">${escapeHtml(locale.messages.DOCS_TITLE)}</a><a href="${escapeHtml(publicDocPath(code, "quick"))}">${escapeHtml(locale.messages.QUICK_START)}</a><a href="${escapeHtml(publicDocPath(code, "use-cases"))}">Auto</a><a href="${escapeHtml(publicDocPath(code, "evidence-cinema"))}">Evidence Cinema</a></nav>
  <main id="content"><h1>${escapeHtml(heading)}</h1><p class="lead">${escapeHtml(intro)}</p>
    <h2>Auto</h2><p>${escapeHtml(locale.messages.DESCRIPTION)}</p>
    <div class="policies">${cards}</div>
    <p><code>$better-workflows:auto</code> · <code>sbw route preview --entry auto</code></p>
    <section id="replay"><h2>Evidence Cinema</h2><p><a href="${escapeHtml(publicDocPath(code, "evidence-cinema"))}">Evidence Cinema</a></p></section>
  </main>
  <footer><h2>${escapeHtml(locale.messages.LANGUAGE)}</h2><nav class="locales" aria-label="${escapeHtml(locale.messages.LANGUAGE)}">${localeLinks}</nav></footer>
</body></html>`;
}
