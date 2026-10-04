import { applyPublicSiteShell } from './public-site-shell.mjs';
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONNECTORS_LOCALES, DEFAULT_LOCALE, PUBLIC_RC1_LOCALE_IDS, locales } from "./website-locales.mjs";
import { loadPolicySources, validatePolicyText } from "./policy-source.mjs";
import { supportCopy, supportPath, escapeSupportMarkdownText } from "./localized-support.mjs";
import { PUBLIC_TEXT_ROUTES as targets, publicTextPath } from "./policy-routes.mjs";
import { homepagePath, publicDocPath } from "./public-docs.mjs";
import { validateWorkflowLabels, workflowDiagramMarkdown, workflowDiagramHtml } from "./workflow-diagram.mjs";
import { localizeArchitectureCode } from "./architecture-source.mjs";
import { SPONSORSHIP } from "./sponsorship.mjs";
export { policyPath, policyMarkdownPath } from "./policy-routes.mjs";

const groups = ["core", "asia", "europe"];
const origin = "https://betterworkflows.dev";
const repository = "https://github.com/stephen-taipei/better-workflows";
const escapeHtml = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const sourceUrl = (target, revision = "main") => {
  if (!/^(?:main|[a-f0-9]{40})$/.test(revision)) throw new Error("Invalid public source revision");
  return `${repository}/blob/${revision}/${target}`;
};

function requireLocale(code) {
  if (!CONNECTORS_LOCALES.includes(code)) throw new Error(`Unsupported policy locale: ${code}`);
  return locales.find((item) => item.code === code);
}

export function policyTitle(policy, code) {
  requireLocale(code);
  return policy.translations[code][0].replace(/^# /, "");
}

// A localized shell around a canonical-English body is useful for navigation,
// but it must not be advertised to search engines as translated content.
export function isIndexablePolicy(policy) {
  return policy.translationMode !== "canonical-english-body";
}

export function buildPolicyCatalog(sources, catalogs) {
  const rows = {};
  const expectedDigests = Object.fromEntries(sources.map((source) => [source.id, source.sha256]));
  for (const catalog of catalogs) {
    if (Object.keys(catalog).sort().join() !== "locales,sourceDigests" ||
        !catalog.sourceDigests || Object.keys(catalog.sourceDigests).sort().join() !== Object.keys(expectedDigests).sort().join() ||
        Object.entries(expectedDigests).some(([key, digest]) => catalog.sourceDigests[key] !== digest)) {
      throw new Error("Policy catalog source digest or schema drift");
    }
    for (const [code, row] of Object.entries(catalog.locales)) {
      requireLocale(code);
      if (code === "en" || Object.hasOwn(rows, code)) throw new Error(`Duplicate or overridden canonical policy locale: ${code}`);
      if (Object.keys(row).sort().join() !== Object.keys(expectedDigests).sort().join()) throw new Error(`Policy set drift: ${code}`);
      for (const source of sources) {
        const texts = row[source.id];
        if (!Array.isArray(texts) || texts.length !== source.texts.length) throw new Error(`Incomplete policy: ${code}/${source.id}`);
        texts.forEach((text, index) => {
          validatePolicyText(source.texts[index], text, `${code}/${source.id}/${index}`);
          for (const identifier of source.requiredIdentifiers || []) {
            if (source.texts[index].includes(identifier) && !text.includes(identifier)) {
              throw new Error(`Public document identifier missing: ${code}/${source.id}/${index}/${identifier}`);
            }
          }
          // These pinned English policies contain no Han names or quotations.
          // Catch accidental Chinese draft fragments outside Han-using locales.
          if (!/^(?:zh(?:-|$)|ja$|ko$)/.test(code) && /\p{Script=Han}/u.test(text)) {
            throw new Error(`Unexpected Han script in policy translation: ${code}/${source.id}/${index}`);
          }
          // Reference guides remain canonical in English until a real,
          // source-bound translation catalog is admitted. Their localized
          // headings/overview are useful navigation, but must not be mistaken
          // for a translated body or replaced with fabricated prose.
          if (text === source.texts[index] && source.translationMode !== "canonical-english-body") {
            throw new Error(`English policy fallback: ${code}/${source.id}/${index}`);
          }
        });
        if (new Set(texts).size !== texts.length) throw new Error(`Duplicated policy paragraph: ${code}/${source.id}`);
        for (const block of source.blocks.filter((item) => item.type === "workflow-diagram")) {
          validateWorkflowLabels(block.indices.map((index) => texts[index]));
        }
      }
      rows[code] = row;
    }
  }
  for (const code of CONNECTORS_LOCALES) if (code !== "en" && !Object.hasOwn(rows, code)) throw new Error(`Missing policy locale: ${code}`);
  return sources.map((source) => {
    // Exact English is compiler input, never a separately edited translation.
    const reconstructed = source.blocks.map((block) => block.type === "text"
      ? source.texts[block.index].replace(/\{LINK_(\d+)\}/g, (_, index) => source.links[index])
      : block.type === "workflow-diagram" ? workflowDiagramMarkdown(block.indices.map((index) => source.texts[index])) : block.source).join("\n\n");
    if (reconstructed !== source.blocks.map((block) => block.source).join("\n\n")) throw new Error(`Incomplete canonical policy mapping: ${source.id}`);
    return { ...source, translations: Object.fromEntries(CONNECTORS_LOCALES.map((code) =>
      [code, code === "en" ? source.texts : rows[code][source.id]])) };
  });
}

export async function loadPolicies(root) {
  const sources = await loadPolicySources(root);
  const catalogs = await Promise.all(groups.map(async (group) => JSON.parse(await readFile(
    path.join(root, "docs", "rc1-catalogs", "policies", `${group}.json`), "utf8"))));
  return buildPolicyCatalog(sources, catalogs);
}

function linkTarget(target, code, format, source = "README.md", revision, pinnedLinkRevisions) {
  if (/^https:\/\//.test(target)) return target;
  if (path.posix.isAbsolute(target) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.includes("\\")) {
    throw new Error("Unsupported public document link target");
  }
  // A guide's links are relative to its source directory, not the repository root.
  target = path.posix.normalize(path.posix.join(path.posix.dirname(source), target));
  if (target.startsWith("../") || path.posix.isAbsolute(target)) throw new Error("Public document link escaped repository");
  if (Object.hasOwn(targets, target)) return format === "html" ? publicTextPath(code, targets[target]) : `${targets[target]}.md`;
  if (target === "SUPPORT.md") return format === "html" ? supportPath(code) : "support.md";
  if (/^https:\/\//.test(target)) return target;
  const linkRevision = pinnedLinkRevisions?.[target];
  if (linkRevision) return sourceUrl(target, linkRevision);
  if (revision === null) {
    // Working-tree candidates may use stable site routes, but must not publish
    // GitHub links that imply their uncommitted bytes have an immutable revision.
    if (target === "README.md") return format === "html" ? homepagePath(code) : `../../../${target}`;
    if (target === "docs/details/en.md" || target === "docs/LANGUAGES.md") {
      return format === "html" ? publicDocPath(code, "guide") : `../../../${target}`;
    }
    if (format === "html") return null;
  }
  // Candidate-only manuals can reference files absent from this local runtime.
  // Committed sources keep those English references on an exact source revision.
  const exactRevision = linkRevision ?? revision;
  return format === "html" || exactRevision ? sourceUrl(target, exactRevision) : `../../../${target}`;
}

function link(label, target, code, format, source, revision, pinnedLinkRevisions) {
  const url = linkTarget(target, code, format, source, revision, pinnedLinkRevisions);
  if (url === null) return label;
  const english = format === "html" && !/^https:\/\//.test(target) && url.startsWith(repository);
  return format === "html" ? `<a href="${escapeHtml(url)}"${english ? ' hreflang="en"' : ""}>${label}</a>` : `[${label}](${url})`;
}

// Deliberately small compiler for the pinned policies, not a general Markdown engine.
// Only fixed link placeholders, inline code and emphasis can produce markup.
export function policyInline(value, policy, code, format) {
  const escape = format === "html" ? escapeHtml : escapeSupportMarkdownText;
  const text = value.replace(/\s*\n\s*/g, (breakText, offset) => {
    if (!/^(?:zh(?:-|$)|ja$)/.test(code)) return " ";
    // Source wrapping must not insert a space in the middle of a CJK word.
    const left = value[offset - 1] || "";
    const right = value[offset + breakText.length] || "";
    return /[!-~]/.test(left) && /[!-~]/.test(right) ? " " : "";
  });
  const pattern = /\[([^\]]+)\]\(\{LINK_(\d+)\}\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let output = "";
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    output += escape(text.slice(offset, match.index));
    if (match[1] !== undefined) {
      const target = policy.links[Number(match[2])];
      if (!target) throw new Error("Unknown policy link placeholder");
      output += link(policyInline(match[1], policy, code, format), target, code, format,
        policy.source, policy.sourceRevision, policy.pinnedLinkRevisions);
    } else if (match[3] !== undefined) {
      output += format === "html" ? `<code>${escapeHtml(match[3])}</code>` : `\`${match[3]}\``;
    } else {
      const inner = escape(match[4]);
      output += format === "html" ? `<strong>${inner}</strong>` : `**${inner}**`;
    }
    offset = match.index + match[0].length;
  }
  return output + escape(text.slice(offset));
}

export function renderPolicyBlock(text, policy, code, format) {
  const inline = (value) => policyInline(value, policy, code, format);
  const heading = text.match(/^(#{1,6}) (.+)$/);
  if (heading) return format === "html" ? `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>` : `${heading[1]} ${inline(heading[2])}`;
  if (text.startsWith("|")) {
    const rows = text.split("\n").map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
    if (format === "markdown") return rows.map((row, i) => `| ${row.map((cell) => i === 1 ? cell : inline(cell)).join(" | ")} |`).join("\n");
    const row = (cells, tag) => `<tr>${cells.map((cell) => `<${tag}${tag === "th" ? ' scope="col"' : ""}>${inline(cell)}</${tag}>`).join("")}</tr>`;
    const navigationTable = rows.length === 2 && rows[0].length === 7;
    return `<div class="table-scroll${navigationTable ? " navigation-table" : ""}"><table><thead>${row(rows[0], "th")}</thead><tbody>${rows.slice(2).map((cells) => row(cells, "td")).join("")}</tbody></table></div>`;
  }
  if (/^(?:-|\d+\.) /.test(text)) {
    const items = [];
    for (const line of text.split("\n")) {
      const start = line.match(/^(-|\d+\.) (\[[ x]\] )?(.*)$/);
      if (start) items.push({ marker: start[1], checkbox: start[2] || "", value: start[3] });
      else if (items.length && /^\s+/.test(line)) items.at(-1).value += `\n${line.trim()}`;
      else throw new Error("Unsupported policy list continuation");
    }
    if (format === "markdown") return items.map((item) => `${item.marker} ${item.checkbox}${inline(item.value)}`).join("\n");
    const tag = items[0].marker === "-" ? "ul" : "ol";
    return `<${tag}>${items.map((item) => `<li>${item.checkbox ? `<input type="checkbox" disabled${item.checkbox === "[x] " ? " checked" : ""} aria-label="${escapeHtml(item.value)}"> ` : ""}${inline(item.value)}</li>`).join("\n")}</${tag}>`;
  }
  return format === "html" ? `<p>${inline(text)}</p>` : inline(text);
}

function navigation(code, id, format) {
  const t = supportCopy[code];
  const entries = [["README", "README.md"], [t.navContribution, "CONTRIBUTING.md"], [t.navConduct, "CODE_OF_CONDUCT.md"],
    [t.navSecurity, "SECURITY.md"], [t.navGovernance, "GOVERNANCE.md"], [t.title, "SUPPORT.md"]];
  const escape = format === "html" ? escapeHtml : escapeSupportMarkdownText;
  const items = entries.map(([label, target]) => targets[target] === id
    ? (format === "html" ? `<strong aria-current="page">${escape(label)}</strong>` : `**${escape(label)}**`)
    : link(escape(label), target, code, format));
  return format === "html" ? `<nav aria-label="${escapeHtml(requireLocale(code).messages.MENU)}">${items.join("\n")}</nav>` : items.join(" · ");
}

function bodyBlocks(policy, code, format) {
  const locale = requireLocale(code);
  const blocks = policy.blocks.map((block) => {
    if (block.type === "navigation") return navigation(code, policy.id, format);
    if (block.type === "workflow-diagram") {
      const labels = block.indices.map((index) => policy.translations[code][index]);
      return format === "markdown" ? workflowDiagramMarkdown(labels) : workflowDiagramHtml(labels);
    }
    if (block.type === "code") {
      const codeSource = policy.id === "architecture" ? localizeArchitectureCode(block.source, code, policy.bodyTranslations?.[code]) : block.source;
      if (format === "markdown") return codeSource;
      const lines = codeSource.split("\n");
      return `<pre dir="ltr"><code class="language-${escapeHtml(lines[0].slice(3))}">${escapeHtml(lines.slice(1, -1).join("\n"))}\n</code></pre>`;
    }
    if (block.type === "fixed-table") return renderPolicyBlock(block.source, policy, code, format);
    return renderPolicyBlock(block.type === "fixed-heading" ? block.source : block.type === "reference-links" ? block.text : policy.translations[code][block.index], policy, code, format);
  });
  if (policy.id === "getting-started") {
    const scope = format === "markdown" ? escapeSupportMarkdownText(locale.v5Product.scope) : `<p>${escapeHtml(locale.v5Product.scope)}</p>`;
    blocks.splice(1, 0, scope);
  }
  return blocks;
}

export function renderPolicyMarkdown(policy, code) {
  const locale = requireLocale(code);
  const blocks = bodyBlocks(policy, code, "markdown");
  const guideHeadingMaps = {
    architecture: "scripts/architecture-source.mjs",
    "security-guide": "scripts/security-source.mjs",
    "cli-reference": "scripts/cli-reference-source.mjs"
  };
  const catalogPath = guideHeadingMaps[policy.id]
    || `docs/rc1-catalogs/${policy.catalogDirectory || "policies"}/*.json`;
  blocks.splice(1, 0, CONNECTORS_LOCALES.map((other) => {
    const label = escapeSupportMarkdownText(requireLocale(other).label);
    return other === code ? `**${label}**` : `[${label}](../${other}/${policy.id}.md)`;
  }).join(" · "));
  return `<!-- Generated from ${policy.source}; source-sha256: ${policy.sha256}; edit ${catalogPath}. -->\n${locale.dir === "rtl" ? '<div dir="rtl">\n\n' : ""}${blocks.join("\n\n")}\n${locale.dir === "rtl" ? "\n</div>\n" : ""}`;
}

export function renderPolicyHtml(policy, code) {
  const locale = requireLocale(code);
  const m = locale.messages;
  const title = `${policyTitle(policy, code)} | Better Workflows`;
  const canonical = `${origin}${publicTextPath(code, policy.id)}`;
  const description = `${policyTitle(policy, code)} — Better Workflows`;
  const robots = isIndexablePolicy(policy) ? "index,follow" : "noindex,follow";
  const alternates = [...PUBLIC_RC1_LOCALE_IDS.map((other) => `<link rel="alternate" hreflang="${other}" href="${origin}${publicTextPath(other, policy.id)}">`),
    `<link rel="alternate" hreflang="x-default" href="${origin}${publicTextPath(DEFAULT_LOCALE, policy.id)}">`].join("\n");
  const structuredDataFields = { "@context": "https://schema.org", "@type": "WebPage", name: title,
    inLanguage: code, url: canonical, description };
  if (policy.sourceRevision !== null) structuredDataFields.isBasedOn = sourceUrl(policy.source, policy.sourceRevision);
  const structuredData = JSON.stringify(structuredDataFields).replaceAll("<", "\\u003c");
  return applyPublicSiteShell(`<!doctype html>
<html lang="${code}" dir="${locale.dir || "ltr"}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="${robots}"><link rel="canonical" href="${canonical}">
${alternates}
<meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${canonical}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><script type="application/ld+json">${structuredData}</script>
<style>
:root{font:18px/1.7 system-ui,sans-serif;color:#17243a;background:#f8fafc;color-scheme:light}
body{max-width:82ch;margin:auto;padding:clamp(1rem,4vw,3rem);overflow-wrap:anywhere}a{color:#1948a7;text-underline-offset:.18em}
a:focus-visible,summary:focus-visible{outline:3px solid #6b21a8;outline-offset:3px}h1{font-size:clamp(2rem,5vw,3rem);line-height:1.2}h2{margin-block-start:2rem}
nav{display:flex;gap:.5rem 1rem;flex-wrap:wrap;margin-block:1.25rem}nav.locale-button-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.4rem}nav.locale-button-grid a{padding:.4rem .55rem;border:1px solid #ccd4e0;border-radius:.45rem;text-decoration:none}nav.locale-button-grid a[aria-current="page"]{border-color:#1948a7;font-weight:700}details{padding:1rem;border:1px solid #ccd4e0;border-radius:.7rem}summary{cursor:pointer}
li{margin-block:.3rem}pre{padding:1rem;border-radius:.5rem;background:#e5eaf2;overflow:auto}code{font-size:.9em;overflow-wrap:anywhere;direction:ltr;unicode-bidi:isolate}
.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;text-align:start}th,td{padding:.65rem;border:1px solid #ccd4e0;vertical-align:top}
.navigation-table table{min-width:42rem}.navigation-table th{white-space:nowrap}
.workflow-map{margin:2rem 0;padding:1rem;border:1px solid #ccd4e0;border-radius:.7rem}.workflow-map figcaption{font-weight:700}
.workflow-map ul{list-style:none;padding:0;margin-block-end:0;display:grid;gap:.7rem}.workflow-map li{margin:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.5rem;padding:.75rem;background:#e5eaf2;border-radius:.4rem}
@media(max-width:40rem){.workflow-map li{grid-template-columns:minmax(0,1fr)}}
footer{margin-block-start:3rem;padding-block-start:1rem;border-block-start:1px solid #ccd4e0}
</style></head><body><a href="#main">${escapeHtml(m.SKIP)}</a>
<header><nav aria-label="${escapeHtml(m.MENU)}"><a href="${code === DEFAULT_LOCALE ? "/" : `/${code}/`}">Better Workflows</a><a href="${code === DEFAULT_LOCALE ? "/docs/" : `/${code}/docs/`}">${escapeHtml(m.DOCS_CTA)}</a><a href="${supportPath(code)}">${escapeHtml(supportCopy[code].title)}</a></nav>
<details class="locale-menu" open><summary>${escapeHtml(m.LANGUAGE)}: ${escapeHtml(locale.label)}</summary><nav class="locale-button-grid" data-public-locale-buttons aria-label="${escapeHtml(m.LANGUAGE)}">
${PUBLIC_RC1_LOCALE_IDS.map((other) => `<a class="locale-option locale-button" data-locale-button="${other}" data-locale-static="true" href="${publicTextPath(other, policy.id)}" lang="${other}" hreflang="${other}"${other === code ? ' aria-current="page"' : ""}>${escapeHtml(requireLocale(other).label)}</a>`).join("\n")}
</nav></details></header>
<main id="main" data-source="${policy.source}" data-source-sha256="${policy.sha256}"${policy.sourceRevision ? ` data-source-revision="${escapeHtml(policy.sourceRevision)}"` : ""}${policy.sourceStatus ? ` data-source-status="${escapeHtml(policy.sourceStatus)}"` : ""}>
${bodyBlocks(policy, code, "html").join("\n")}
</main><footer><a href="${repository}">${escapeHtml(m.GITHUB_CTA)}</a> · <a href="${SPONSORSHIP.url}">${escapeHtml(m.SPONSOR_CTA)}</a><p>${escapeHtml(m.SPONSOR_BODY)}</p></footer>
</body></html>\n`, { code, path: publicTextPath(code, policy.id), kind: 'document' });
}
