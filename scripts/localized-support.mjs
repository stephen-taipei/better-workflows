import { applyPublicSiteShell } from './public-site-shell.mjs';
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONNECTORS_LOCALES, DEFAULT_LOCALE, locales, publicLocales } from "./website-locales.mjs";
import { publicDocPath } from "./public-docs.mjs";
import { PUBLIC_TEXT_ROUTES, publicTextPath } from "./policy-routes.mjs";
import core from "../docs/rc1-catalogs/support/core.json" with { type: "json" };
import europe from "../docs/rc1-catalogs/support/europe.json" with { type: "json" };
import asia from "../docs/rc1-catalogs/support/asia.json" with { type: "json" };
import { SPONSORSHIP } from "./sponsorship.mjs";

// This digest pins the complete canonical document, not just its title or summary.
// A changed source requires an explicit translation review; never refresh automatically.
export const SUPPORT_SOURCE = Object.freeze({
  path: "SUPPORT.md",
  sha256: "ca057985be574c2fbc72ad73b2c79a381344c14ff304505a45b8d5bc4b9edc36"
});

export const SUPPORT_KEYS = Object.freeze([
  "title", "navContribution", "navConduct", "navSecurity", "navGovernance",
  "overview", "start", "installation", "route", "commandUsage", "trust", "historicalDetail",
  "help", "helpIntro", "version", "environment", "entry", "behavior", "reproduction",
  "sensitive", "feature", "vulnerability"
]);

export function validateSupportRows(groups) {
  const rows = {};
  for (const group of groups) {
    for (const [code, row] of Object.entries(group)) {
      if (Object.hasOwn(rows, code)) throw new Error(`Duplicate support locale: ${code}`);
      if (!CONNECTORS_LOCALES.includes(code)) throw new Error(`Unexpected support locale: ${code}`);
      if (!Array.isArray(row) || row.length !== SUPPORT_KEYS.length) throw new Error(`Incomplete support translation: ${code}`);
      row.forEach((text, index) => {
        if (typeof text !== "string" || !text.trim() || /[\r\n]|__I18N_|__SITE_/.test(text)) {
          throw new Error(`Invalid support segment: ${code}.${SUPPORT_KEYS[index]}`);
        }
      });
      if (new Set(row.slice(13)).size !== row.slice(13).length) throw new Error(`Duplicate support policy segment: ${code}`);
      if (!row[21].includes("SECURITY.md")) throw new Error(`Missing private security reporting link: ${code}`);
      rows[code] = Object.fromEntries(SUPPORT_KEYS.map((key, index) => [key, row[index]]));
    }
  }
  for (const code of CONNECTORS_LOCALES) if (!Object.hasOwn(rows, code)) throw new Error(`Missing support locale: ${code}`);
  return Object.fromEntries(CONNECTORS_LOCALES.map((code) => [code, Object.freeze(rows[code])]));
}

export const supportCopy = Object.freeze(validateSupportRows([core, europe, asia]));

export function verifySupportEnglishSegments(sourceBytes, copy = supportCopy.en) {
  const normalized = (value) => value.replace(/\s+/g, " ").trim();
  const actual = normalized(String(sourceBytes)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\|\s*:---:[^\n]*$/gm, "")
    .replace(/^#{1,6}\s+|^-\s+/gm, "")
    .replace(/\*\*|\|/g, " "));
  const expected = normalized([
    copy.title, "README", copy.navContribution, copy.navConduct, copy.navSecurity, copy.navGovernance, copy.title,
    copy.overview, copy.start, copy.installation, copy.route, copy.commandUsage, copy.trust, copy.historicalDetail,
    copy.help, copy.helpIntro, copy.version, copy.environment, copy.entry, copy.behavior, copy.reproduction,
    copy.sensitive, copy.feature, copy.vulnerability
  ].join(" "));
  if (actual !== expected) throw new Error("English support segments do not cover the complete canonical prose in order");
}

export async function verifySupportSource(repositoryRoot) {
  const bytes = await readFile(path.join(repositoryRoot, SUPPORT_SOURCE.path));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== SUPPORT_SOURCE.sha256) throw new Error(`Support source changed; full translations require review: ${actual}`);
  verifySupportEnglishSegments(bytes);
  return actual;
}

function requireLocale(code) {
  if (!Object.hasOwn(supportCopy, code)) throw new Error(`Unsupported support locale: ${code}`);
  return supportCopy[code];
}

export function supportPath(code) {
  requireLocale(code);
  return code === DEFAULT_LOCALE ? "/support/" : `/${code}/support/`;
}

export function supportMarkdownPath(code) {
  requireLocale(code);
  return `docs/locales/${code}/support.md`;
}

const guideLinks = [
  ["installation", "docs/guide/getting-started.md"],
  ["route", "docs/guide/workflows.md"],
  ["commandUsage", "docs/guide/cli-reference.md"],
  ["trust", "docs/guide/security.md"],
  ["historicalDetail", "docs/details/en.md"]
];
const navigation = [["README", "README.md"], ["navContribution", "CONTRIBUTING.md"],
  ["navConduct", "CODE_OF_CONDUCT.md"], ["navSecurity", "SECURITY.md"], ["navGovernance", "GOVERNANCE.md"]];
const detailKeys = ["version", "environment", "entry", "behavior", "reproduction"];
const html = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
export const escapeSupportMarkdownText = (text) => String(text)
  .replace(/[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]/g, "\\$&");
const markdownText = escapeSupportMarkdownText;

export function renderSupportMarkdown(code) {
  const t = requireLocale(code);
  const direction = locales.find((item) => item.code === code).dir || "ltr";
  const link = (label, target) => `[${markdownText(label)}](${Object.hasOwn(PUBLIC_TEXT_ROUTES, target) ? `${PUBLIC_TEXT_ROUTES[target]}.md` : `../../../${target}`})`;
  const languageLinks = locales.map((locale) => locale.code === code
    ? `**${markdownText(locale.label)}**` : `[${markdownText(locale.label)}](../${locale.code}/support.md)`).join(" · ");
  const canonicalLinks = navigation.map(([key, target]) => link(t[key] || key, target)).join(" · ");
  return `<!-- Generated from ${SUPPORT_SOURCE.path}; source-sha256: ${SUPPORT_SOURCE.sha256}; edit docs/rc1-catalogs/support/*.json. -->
${direction === "rtl" ? '<div dir="rtl">\n\n' : ""}# ${markdownText(t.title)}

${languageLinks}

${canonicalLinks} · **${markdownText(t.title)}**

${link(t.overview, "docs/LANGUAGES.md")}

## ${markdownText(t.start)}

${guideLinks.map(([key, target]) => `- ${link(t[key], target)} · \`${Object.hasOwn(PUBLIC_TEXT_ROUTES, target) ? code : "en"}\``).join("\n")}

## ${markdownText(t.help)}

${markdownText(t.helpIntro)}

${detailKeys.map((key) => `- ${markdownText(t[key])}`).join("\n")}

${markdownText(t.sensitive)}

${markdownText(t.feature)}

${t.vulnerability.split("SECURITY.md").map(markdownText).join(link("SECURITY.md", "SECURITY.md"))}
${direction === "rtl" ? "\n</div>\n" : ""}
`.trimEnd() + "\n";
}

export function renderSupportHtml(code) {
  const t = requireLocale(code);
  const locale = locales.find((item) => item.code === code);
  const m = locale.messages;
  const origin = "https://betterworkflows.dev";
  const canonical = `${origin}${supportPath(code)}`;
  const sourceUrl = (target) => `https://github.com/stephen-taipei/better-workflows/blob/main/${target}`;
  const link = (label, target) => Object.hasOwn(PUBLIC_TEXT_ROUTES, target)
    ? `<a href="${publicTextPath(code, PUBLIC_TEXT_ROUTES[target])}" hreflang="${code}">${html(label)}</a>`
    : `<a href="${sourceUrl(target)}" hreflang="en">${html(label)}</a>`;
  const title = `${t.title} | Better Workflows`;
  const alternates = [...publicLocales.map((item) => `<link rel="alternate" hreflang="${item.code}" href="${origin}${supportPath(item.code)}">`),
    `<link rel="alternate" hreflang="x-default" href="${origin}${supportPath(DEFAULT_LOCALE)}">`].join("\n");
  // WebPage describes real translated body content; no completion/quality claim is implied.
  const structuredData = JSON.stringify({ "@context": "https://schema.org", "@type": "WebPage", name: title,
    inLanguage: code, url: canonical, description: t.helpIntro,
    isBasedOn: sourceUrl(SUPPORT_SOURCE.path) }).replaceAll("<", "\\u003c");
  return applyPublicSiteShell(`<!doctype html>
<html lang="${code}" dir="${locale.dir || "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<meta name="description" content="${html(t.helpIntro)}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${canonical}">
${alternates}
<meta property="og:type" content="website">
<meta property="og:title" content="${html(title)}">
<meta property="og:description" content="${html(t.helpIntro)}">
<meta property="og:url" content="${canonical}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script type="application/ld+json">${structuredData}</script>
<style>
:root{font:18px/1.7 system-ui,sans-serif;color:#17243a;background:#f8fafc;color-scheme:light}
body{max-width:76ch;margin:auto;padding:clamp(1rem,4vw,3rem)}a{color:#1948a7;text-underline-offset:.18em}
a:focus-visible{outline:3px solid #6b21a8;outline-offset:3px}h1{font-size:clamp(2rem,5vw,3rem);line-height:1.2}
h2{margin-block-start:2rem}nav{display:flex;gap:.5rem 1rem;flex-wrap:wrap;margin-block:1.25rem}nav.locale-button-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.4rem}nav.locale-button-grid a{padding:.4rem .55rem;border:1px solid #ccd4e0;border-radius:.45rem;text-decoration:none}nav.locale-button-grid a[aria-current="page"]{border-color:#1948a7;font-weight:700}
details{padding:1rem;border:1px solid #ccd4e0;border-radius:.7rem}summary{cursor:pointer}
li{margin-block:.3rem}.notice{padding:1rem;border-inline-start:4px solid #b45309;background:#fffbeb}
footer{margin-block-start:3rem;padding-block-start:1rem;border-block-start:1px solid #ccd4e0}
</style>
</head>
<body>
<a href="#main">${html(m.SKIP)}</a>
<header><nav aria-label="${html(m.MENU)}"><a href="${code === DEFAULT_LOCALE ? "/" : `/${code}/`}">Better Workflows</a>
<a href="${code === DEFAULT_LOCALE ? "/docs/" : `/${code}/docs/`}">${html(m.DOCS_CTA)}</a></nav>
<details class="locale-menu" open><summary>${html(m.LANGUAGE)}: ${html(locale.label)}</summary><nav class="locale-button-grid" data-public-locale-buttons aria-label="${html(m.LANGUAGE)}">
${publicLocales.map((item) => `<a class="locale-option locale-button" data-locale-button="${item.code}" data-locale-static="true" href="${supportPath(item.code)}" lang="${item.code}" hreflang="${item.code}"${item.code === code ? ' aria-current="page"' : ""}>${html(item.label)}</a>`).join("\n")}
</nav></details></header>
<main id="main" data-source="SUPPORT.md" data-source-sha256="${SUPPORT_SOURCE.sha256}">
<h1>${html(t.title)}</h1>
<nav aria-label="${html(m.MENU)}">${navigation.map(([key, target]) => link(t[key] || key, target)).join("\n")}</nav>
<p><a href="${publicDocPath(code, "guide")}">${html(m.DOCS_CTA)}</a></p>
<h2>${html(t.start)}</h2>
<ul>${guideLinks.map(([key, target]) => `<li>${link(t[key], target)}</li>`).join("\n")}</ul>
<h2>${html(t.help)}</h2><p>${html(t.helpIntro)}</p>
<ul>${detailKeys.map((key) => `<li>${html(t[key])}</li>`).join("\n")}</ul>
<p class="notice">${html(t.sensitive)}</p><p>${html(t.feature)}</p>
<p>${html(t.vulnerability).replace("SECURITY.md", link("SECURITY.md", "SECURITY.md"))}</p>
</main>
<footer><a href="https://github.com/stephen-taipei/better-workflows">${html(m.GITHUB_CTA)}</a> · <a href="${SPONSORSHIP.url}">${html(m.SPONSOR_CTA)}</a><p>${html(m.SPONSOR_BODY)}</p></footer>
</body></html>
`, { code, path: supportPath(code), kind: 'document' });
}
