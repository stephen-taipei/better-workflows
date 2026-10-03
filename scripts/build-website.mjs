#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CONNECTORS_LOCALES, DEFAULT_LOCALE, LOCALE_KEYS, PUBLIC_RC1_LOCALE_IDS, locales, publicRc1Locales } from "./website-locales.mjs";
import { PUBLIC_DOC_PAGES, homepagePath, publicDocCards, publicDocPath } from "./public-docs.mjs";
import { renderSupportHtml, supportCopy, supportPath } from "./localized-support.mjs";
import { publicContentCoverage } from "./public-content-coverage.mjs";
import { isIndexablePolicy, policyTitle, renderPolicyHtml } from "./localized-policies.mjs";
import { loadPublicTexts } from "./localized-public-text.mjs";
import { publicTextPath } from "./policy-routes.mjs";
import { loadInteractiveDocumentPages } from "./interactive-document-build.mjs";
import {
  loadHostSupportRegistry,
  renderHostSupportHtml
} from "../plugins/better-workflows/scripts/lib/hosts.mjs";
import { digestObject } from "../plugins/better-workflows/scripts/lib/core.mjs";
import { inspectProductPublicSurface, productReleaseScope } from "../plugins/better-workflows/scripts/lib/product-release-scope-v1.mjs";
import { SPONSORSHIP } from "./sponsorship.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const outputDirectory = path.resolve(process.env.SITE_OUTPUT_DIR || path.join(repoRoot, "dist", "website"));
const websiteSource = path.join(repoRoot, "website");
const localizedTemplatePath = path.join(scriptDirectory, "templates", "localized-homepage.html");
const docsSource = path.join(repoRoot, "docs", "html");
const pluginSource = path.join(repoRoot, "plugins", "better-workflows");
const PUBLIC_PLUGIN_WEBSITE_FILES = Object.freeze([
  ".codex-plugin/plugin.json",
  "package.json",
  "skills/auto/SKILL.md",
  "templates/auto.json",
  "scripts/lib/core.mjs",
  "scripts/lib/evidence.mjs",
  "scripts/lib/git.mjs",
  "scripts/lib/ledger.mjs",
  "scripts/lib/review.mjs"
]);
const PUBLIC_AUTO_HOST_CAPABILITY_IDS = Object.freeze([
  "task-contract",
  "typed-evidence",
  "replay",
  "action-gate",
  "task-worktree",
  "native-picker",
  "native-subagents"
]);
const canonicalOrigin = "https://betterworkflows.dev";
const repositoryUrl = "https://github.com/stephen-taipei/better-workflows";
const sponsorUrl = SPONSORSHIP.url;
const sponsorMode = SPONSORSHIP.mode;
const releaseLocales = publicRc1Locales;

async function canonicalPotentialPath(targetPath) {
  let existingPath = path.resolve(targetPath);
  const missingSegments = [];
  while (true) {
    try {
      return path.join(await realpath(existingPath), ...missingSegments.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(existingPath);
      if (parent === existingPath) throw error;
      missingSegments.push(path.basename(existingPath));
      existingPath = parent;
    }
  }
}

function isStrictDescendant(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertSafeOutputDirectory() {
  const candidate = await canonicalPotentialPath(outputDirectory);
  const canonicalRepository = await realpath(repoRoot);
  const candidateDistRoot = await canonicalPotentialPath(path.join(repoRoot, "dist"));
  const temporaryRoots = await Promise.all([
    canonicalPotentialPath(tmpdir()),
    canonicalPotentialPath("/tmp")
  ]);
  const repositoryDistIsSafe = isStrictDescendant(candidateDistRoot, canonicalRepository) &&
    path.relative(canonicalRepository, candidateDistRoot) === "dist";
  const requestedThroughRepositoryDist = isStrictDescendant(outputDirectory, path.join(repoRoot, "dist"));
  if (requestedThroughRepositoryDist && !repositoryDistIsSafe) {
    throw new Error("SITE_OUTPUT_DIR must not traverse a symlinked repository dist directory");
  }
  const allowedRoots = [
    ...(repositoryDistIsSafe ? [candidateDistRoot] : []),
    ...temporaryRoots
  ];
  const candidateInsideRepository = candidate === canonicalRepository ||
    isStrictDescendant(candidate, canonicalRepository);
  const candidateInsideAuthorizedDist = repositoryDistIsSafe &&
    requestedThroughRepositoryDist && isStrictDescendant(candidate, candidateDistRoot);
  if (candidateInsideRepository && !candidateInsideAuthorizedDist) {
    throw new Error("SITE_OUTPUT_DIR must not replace or delete repository content outside canonical dist");
  }
  if (!allowedRoots.some((root) => isStrictDescendant(candidate, root))) {
    throw new Error("SITE_OUTPUT_DIR must be a child of repository dist or an operating-system temporary directory");
  }
}

const openGraphLocales = Object.freeze({ en: "en_US", "zh-Hant-TW": "zh_TW" });
if (JSON.stringify(Object.keys(openGraphLocales)) !== JSON.stringify(CONNECTORS_LOCALES)) {
  throw new Error("Open Graph locales must match the RC1 public locale catalog");
}

async function gitRevision() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function gitSourceModifiedAt() {
  try {
    const { stdout } = await execFileAsync("git", ["show", "-s", "--format=%cI", "HEAD"], { cwd: repoRoot });
    const value = new Date(stdout.trim());
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  } catch {
    return null;
  }
}

async function packageVersion() {
  const packageJson = JSON.parse(await readFile(path.join(pluginSource, "package.json"), "utf8"));
  return packageJson.version;
}

function buildTime() {
  const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH);
  if (Number.isFinite(sourceDateEpoch) && sourceDateEpoch > 0) return new Date(sourceDateEpoch * 1000).toISOString();
  return new Date().toISOString();
}

async function websiteAssetVersion() {
  const hash = createHash("sha256");
  for (const fileName of ["styles.css", "site.js", "better-workflows-mark.svg", "favicon.svg"]) {
    hash.update(fileName);
    hash.update("\0");
    hash.update(await readFile(path.join(websiteSource, fileName)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

async function contentManifest(directory) {
  const files = [];
  async function walk(currentDirectory) {
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      const filePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) await walk(filePath);
      else if (entry.isFile() && !["release.json", "manifest.sha256"].includes(path.relative(directory, filePath))) files.push(filePath);
      else if (!entry.isFile()) throw new Error(`Unsupported website artifact entry: ${path.relative(directory, filePath)}`);
    }
  }
  await walk(directory);
  files.sort((left, right) => left.localeCompare(right, "en"));
  const lines = [];
  for (const filePath of files) {
    const relativePath = path.relative(directory, filePath).split(path.sep).join("/");
    const digest = createHash("sha256").update(await readFile(filePath)).digest("hex");
    lines.push(`${digest}  ${relativePath}`);
  }
  const manifest = `${lines.join("\n")}\n`;
  return { manifest, digest: createHash("sha256").update(manifest).digest("hex") };
}

async function directoryManifest(directory) {
  const directories = [];
  async function walk(currentDirectory) {
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path.relative(directory, entryPath).split(path.sep).join("/"));
        await walk(entryPath);
      } else if (!entry.isFile()) {
        throw new Error(`Unsupported website artifact entry: ${path.relative(directory, entryPath)}`);
      }
    }
  }
  await walk(directory);
  return `${directories.sort((left, right) => left.localeCompare(right, "en")).join("\n")}\n`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escapeScriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function localePath(code) {
  return homepagePath(code);
}

function localeUrl(code) {
  return `${canonicalOrigin}${localePath(code)}`;
}

function hreflangLinks(pathForLocale = localePath) {
  return [
    ...releaseLocales.map((locale) => `<link rel="alternate" hreflang="${locale.code}" href="${canonicalOrigin}${pathForLocale(locale.code)}">`),
    `<link rel="alternate" hreflang="x-default" href="${canonicalOrigin}${pathForLocale(DEFAULT_LOCALE)}">`
  ].join("\n    ");
}

function localeOptions(currentLocale = null, pathForLocale = localePath) {
  return releaseLocales.map((locale) => {
    const selected = locale.code === currentLocale ? " selected" : "";
    return `<option value="${pathForLocale(locale.code)}"${selected}>${escapeHtml(locale.label)}</option>`;
  }).join("");
}

function localeLinks(currentLocale = null, pathForLocale = localePath) {
  return releaseLocales.map((locale) => {
    const current = locale.code === currentLocale ? ' aria-current="page"' : "";
    return `<a class="locale-option" data-locale-link="${escapeHtml(locale.code)}" href="${pathForLocale(locale.code)}" lang="${escapeHtml(locale.code)}" hreflang="${escapeHtml(locale.code)}"${current}>${escapeHtml(locale.label)} <code>${escapeHtml(locale.code)}</code></a>`;
  }).join("\n");
}

function localeButtonLinks(currentLocale = null, pathForLocale = localePath, dataAttribute = "data-locale-button") {
  return releaseLocales.map((locale) => {
    const current = locale.code === currentLocale ? ' aria-current="page"' : "";
    return `<a class="locale-option locale-button" ${dataAttribute}="${escapeHtml(locale.code)}" href="${pathForLocale(locale.code)}" lang="${escapeHtml(locale.code)}" hreflang="${escapeHtml(locale.code)}"${current}>${escapeHtml(locale.label)} <code>${escapeHtml(locale.code)}</code></a>`;
  }).join("\n");
}

function structuredData({ locale, title, description, canonical, version, runtimePlatforms }) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${canonicalOrigin}/#website`,
        url: `${canonicalOrigin}/`,
        name: "Better Workflows",
        alternateName: ["BW", "betterworkflows.dev"],
        inLanguage: PUBLIC_RC1_LOCALE_IDS,
        sameAs: [repositoryUrl]
      },
      {
        "@type": "SoftwareSourceCode",
        "@id": `${canonical}#source`,
        name: "Better Workflows",
        headline: title,
        description,
        url: canonical,
        codeRepository: repositoryUrl,
        license: `${repositoryUrl}/blob/main/LICENSE`,
        programmingLanguage: ["JavaScript", "HTML", "CSS"],
        runtimePlatform: runtimePlatforms,
        version,
        inLanguage: locale,
        isPartOf: { "@id": `${canonicalOrigin}/#website` }
      }
    ]
  }).replaceAll("<", "\\u003c");
}

function replaceSiteTokens(content, values) {
  return content.replace(/__SITE_([A-Z0-9_]+)__/g, (_, key) => values[key] ?? "unknown");
}

function renderLocalizedList(value, className) {
  const items = String(value).split("|").map((item) => item.trim()).filter(Boolean);
  return `<ol class="${className}">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`;
}

function renderV5ProductStatus(locale) {
  const copy = locale?.v5Product;
  const fields = ["eyebrow", "title", "boundary", "scope", "license", "plan"];
  if (!copy || fields.some((field) => typeof copy[field] !== "string" || copy[field].trim() === "")) {
    throw new Error("Missing complete V5 product copy: " + (locale?.code || "unknown"));
  }
  return [
    `<p class="eyebrow">${escapeHtml(copy.eyebrow)}</p>`,
    `<h2>${escapeHtml(copy.title)}</h2>`,
    `<p>${escapeHtml(copy.boundary)}</p>`,
    `<p>${escapeHtml(copy.scope)}</p>`,
    `<p>${escapeHtml(copy.license)}</p>`,
    `<p>${escapeHtml(copy.plan)}</p>`
  ].join("\n");
}

function renderLocalizedPage(template, locale, commonValues) {
  let content = template;
  for (const key of LOCALE_KEYS) content = content.replaceAll(`__I18N_${key}__`, escapeHtml(locale.messages[key]));
  const canonical = localeUrl(locale.code);
  return replaceSiteTokens(content, {
    ...commonValues,
    SUPPORT_PATH: supportPath(locale.code),
    SUPPORT_TITLE: escapeHtml(supportCopy[locale.code].title),
    POLICIES_NAV: policies.map((policy) => `<a href="${publicTextPath(locale.code, policy.id)}">${escapeHtml(policyTitle(policy, locale.code))}</a>`).join("\n"),
    LOCALE: locale.code,
    DIRECTION: locale.dir || "ltr",
    OG_LOCALE: openGraphLocales[locale.code],
    CANONICAL: canonical,
    HOME_PATH: homepagePath(locale.code),
    IMAGE_ALT: escapeHtml(`${locale.messages.CONTROL_TITLE} — Better Workflows`),
    HREFLANG_LINKS: hreflangLinks(),
    LOCALE_OPTIONS: localeOptions(locale.code),
    LOCALE_LINKS: localeLinks(locale.code),
    LOCALE_BUTTONS: localeButtonLinks(locale.code),
    DOCS_PATH: publicDocPath(locale.code, "guide"),
    CINEMA_PATH: publicDocPath(locale.code, "evidence-cinema"),
    DOC_CARDS: renderDocumentCards(locale, null),
    AUTO_FLOW_ITEMS: renderLocalizedList(locale.messages.V4_AUTO_FLOW, "auto-flow-list"),
    BOUNDARY_ITEMS: renderLocalizedList(locale.messages.V4_BOUNDARIES, "boundary-list"),
    V5_PRODUCT_STATUS: renderV5ProductStatus(locale),
    STRUCTURED_DATA: structuredData({
      locale: locale.code,
      title: locale.messages.TITLE,
      description: locale.messages.DESCRIPTION,
      canonical,
      version: commonValues.VERSION,
      runtimePlatforms: commonValues.RUNTIME_PLATFORMS
    })
  });
}

const docCardIcons = {
  guide: "◎",
  quick: "▱",
  "use-cases": "↯",
  "use-cases-quick": "≡",
  "evidence-cinema": "▶"
};

function renderDocumentCards(locale, currentPageId) {
  return publicDocCards(locale).map((card) => {
    const current = card.id === currentPageId ? ' aria-current="page"' : "";
    return `<a class="doc-card${card.id === "guide" ? " doc-card-featured" : ""}" href="${card.path}"${current}>
      <div class="doc-icon">${docCardIcons[card.id]}</div><div><h3>${escapeHtml(card.title)}</h3><p>${escapeHtml(card.description)}</p></div><span class="doc-arrow">↗</span>
    </a>`;
  }).join("\n");
}

async function ensurePhysicalOutputDirectory(directory) {
  const relative = path.relative(outputDirectory, directory);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Public plugin website destination must be inside the output directory");
  }
  let current = outputDirectory;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current);
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Public plugin website destination directory must be physical: ${relative}`);
    }
  }
}

async function copyPublicPluginWebsiteFiles(source, destination) {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error("Public plugin website source must be a physical directory");
  }
  for (const relativePath of PUBLIC_PLUGIN_WEBSITE_FILES) {
    const segments = relativePath.split("/");
    let sourceParent = source;
    for (const segment of segments.slice(0, -1)) {
      sourceParent = path.join(sourceParent, segment);
      const parentInfo = await lstat(sourceParent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
        throw new Error(`Public plugin website source directory must be physical: ${relativePath}`);
      }
    }
    const sourcePath = path.join(sourceParent, segments.at(-1));
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Public plugin website source must be a physical file: ${relativePath}`);
    }
    const destinationPath = path.join(destination, relativePath);
    await ensurePhysicalOutputDirectory(path.dirname(destinationPath));
    await cp(sourcePath, destinationPath, { force: false, errorOnExist: true });
  }
}

function referenceRuntimeSource() {
  const catalog = {
    defaultLocale: DEFAULT_LOCALE,
    locales: releaseLocales.map(({ code, label, dir, messages }) => ({ code, label, dir: dir || "ltr", messages }))
  };
  return `window.BETTER_WORKFLOWS_REFERENCE_LOCALES=${escapeScriptJson(catalog)};\n(() => {\n  const catalog = window.BETTER_WORKFLOWS_REFERENCE_LOCALES;\n  const code = window.BETTER_WORKFLOWS_REFERENCE_LOCALE;\n  const locale = catalog?.locales?.find((item) => item.code === code);\n  if (!locale) return;\n  document.documentElement.lang = locale.code;\n  document.documentElement.dir = locale.dir;\n  document.querySelectorAll('select[aria-label*="BCP 47"]').forEach((select) => { select.value = select.value || locale.code; });\n})();\n`;
}

function redirectPage(destination, locale = releaseLocales.find((entry) => entry.code === DEFAULT_LOCALE), pathForLocale = () => destination) {
  const canonical = `${canonicalOrigin}${destination}`;
  const buttons = localeButtonLinks(locale.code, pathForLocale);
  return `<!doctype html><html lang="${locale.code}" dir="${locale.dir || "ltr"}"><head><meta charset="utf-8"><meta name="robots" content="noindex,follow"><meta http-equiv="refresh" content="0;url=${destination}"><link rel="canonical" href="${canonical}"><title>${escapeHtml(locale.messages.TITLE)}</title><style>body{max-width:72rem;margin:0 auto;padding:2rem;font:16px/1.5 system-ui,sans-serif;color:#172238}a{color:#1948a7}.locale-button-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.5rem;margin-top:1.5rem}.locale-button-grid a{padding:.55rem .65rem;border:1px solid #ccd4e0;border-radius:.5rem;text-decoration:none}.locale-button-grid a[aria-current="page"]{border-color:#1948a7;font-weight:700}</style></head><body><p><a href="${destination}">${escapeHtml(locale.messages.DOCS_CTA)}</a></p><nav class="locale-button-grid" data-public-locale-buttons aria-label="${escapeHtml(locale.messages.LANGUAGE)}">${buttons}</nav><script>location.replace(${JSON.stringify(destination)}+location.search+location.hash);</script></body></html>\n`;
}

function sitemapXml(sourceModifiedAt) {
  const lastModified = sourceModifiedAt?.slice(0, 10) || null;
  const entriesFor = (pathForLocale) => {
    const alternates = [
      ...releaseLocales.map((locale) => `    <xhtml:link rel="alternate" hreflang="${locale.code}" href="${canonicalOrigin}${pathForLocale(locale.code)}"/>`),
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${canonicalOrigin}${pathForLocale(DEFAULT_LOCALE)}"/>`
    ].join("\n");
    return releaseLocales.map((locale) => `  <url>
    <loc>${canonicalOrigin}${pathForLocale(locale.code)}</loc>${lastModified ? `\n    <lastmod>${lastModified}</lastmod>` : ""}
${alternates}
  </url>`).join("\n");
  };
  const homepageEntries = entriesFor(localePath);
  // Complete draft rendering is separate from independent semantic acceptance.
  // Only the accepted quick guide is indexable; other drafts stay noindex even
  // after the RC1 public locale bodies have been integrated into the build.
  const indexableDocPages = PUBLIC_DOC_PAGES.filter((page) => page.id === "quick");
  const docsEntries = indexableDocPages.map((page) => entriesFor((code) => publicDocPath(code, page.id))).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${homepageEntries}
${docsEntries}
${entriesFor(supportPath)}
${policies.filter(isIndexablePolicy).map((policy) => entriesFor((code) => publicTextPath(code, policy.id))).join("\n")}
</urlset>
`;
}

// Reject unsafe output paths even if a later content preflight also fails.
await assertSafeOutputDirectory();
const publicSurface = await inspectProductPublicSurface();
if (publicSurface.applicable && !publicSurface.matches) {
  throw new Error("Website build refused a plugin surface outside the V5.0 public Auto scope");
}
const version = await packageVersion();
const revision = await gitRevision();
const sourceModifiedAt = await gitSourceModifiedAt();
const builtAt = buildTime();
const assetVersion = await websiteAssetVersion();
const hostSupportRegistry = await loadHostSupportRegistry();
const hostRegistryDigest = digestObject(hostSupportRegistry);
const publicHostCapabilities = hostSupportRegistry.capabilityDefinitions.filter((capability) =>
  PUBLIC_AUTO_HOST_CAPABILITY_IDS.includes(capability.id));
if (JSON.stringify(publicHostCapabilities.map((capability) => capability.id)) !==
    JSON.stringify(PUBLIC_AUTO_HOST_CAPABILITY_IDS)) {
  throw new Error("Auto website capability matrix no longer matches the host registry");
}
const { scope: currentProductScope } = await productReleaseScope();
if (!currentProductScope || JSON.stringify(currentProductScope.publicLocaleIds) !== JSON.stringify(PUBLIC_RC1_LOCALE_IDS)) {
  throw new Error("Website RC1 locale scope differs from the product release contract");
}
const runtimePlatforms = hostSupportRegistry.hosts
  .filter((host) => currentProductScope ? currentProductScope.hostIds.includes(host.id) : host.supportTier === "tier1")
  .map((host) => host.displayName);
const commonValues = {
  VERSION: version,
  REVISION: revision,
  BUILD_TIME: builtAt,
  ASSET_VERSION: assetVersion,
  HOST_SUPPORT_MATRIX: renderHostSupportHtml({
    ...hostSupportRegistry,
    capabilityDefinitions: publicHostCapabilities
  }),
  RUNTIME_PLATFORMS: runtimePlatforms,
  SPONSOR_ADDRESS: SPONSORSHIP.address,
  SPONSOR_QR: `${SPONSORSHIP.qrPath}?sha256=${SPONSORSHIP.qrSha256}`
};
const defaultLocale = releaseLocales.find((locale) => locale.code === DEFAULT_LOCALE);
// Validate full source/body parity before replacing any build output.
const translationCoverage = await publicContentCoverage(repoRoot, { localeIds: PUBLIC_RC1_LOCALE_IDS, allowMissingGenerated: true });
const policies = await loadPublicTexts(repoRoot);
const deferredReferenceIds = new Set(["architecture", "security-guide", "cli-reference"]);
if (JSON.stringify(policies.filter((policy) => policy.translationMode === "canonical-english-body").map((policy) => policy.id).sort()) !==
    JSON.stringify([...deferredReferenceIds].sort())) {
  throw new Error("Every deferred reference body must be explicitly excluded from the V5.0 public website");
}
// Render the five public bodies before touching the output. Missing or invalid
// data must not fall back to an English body or an unpublished locale route.
const interactiveDocuments = await loadInteractiveDocumentPages(repoRoot);
const sourceMappedDocuments = translationCoverage.documents.map((document) => ({ source: document.path, editions: document.editions.length }));
const fullTextDocuments = translationCoverage.documents.filter((document) => document.fullTextParity === "verified")
  .map((document) => ({ source: document.path, editions: document.editions.length }));

if (locales.length !== PUBLIC_RC1_LOCALE_IDS.length ||
    JSON.stringify(locales.map((locale) => locale.code)) !== JSON.stringify(PUBLIC_RC1_LOCALE_IDS) ||
    JSON.stringify(CONNECTORS_LOCALES) !== JSON.stringify(PUBLIC_RC1_LOCALE_IDS)) {
  throw new Error("Website source catalog must match the exact RC1 public locale scope");
}
for (const locale of releaseLocales) {
  if (JSON.stringify(Object.keys(locale.messages)) !== JSON.stringify(LOCALE_KEYS)) throw new Error(`Locale key order mismatch: ${locale.code}`);
}

await assertSafeOutputDirectory();
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(websiteSource, outputDirectory, { recursive: true });
await mkdir(path.join(outputDirectory, "docs", "reference"), { recursive: true });
await cp(path.join(docsSource, "assets"), path.join(outputDirectory, "docs", "assets"), { recursive: true });
// The archived multi-template guide is not a V5 public website asset.
// Rendered cinema pages inline their runtime supplement. Copy only the
// verified images and the linked source stylesheet, never the raw runtime tree.
const cinemaGuide = interactiveDocuments.get("evidence-cinema")?.guide;
const cinemaAssets = cinemaGuide?.assets;
if (!Array.isArray(cinemaAssets) || cinemaAssets.length === 0) {
  throw new Error("Evidence cinema has no verified public image assets");
}
const cinemaAssetSource = path.join(docsSource, "evidence-cinema", "assets");
const cinemaAssetSourceInfo = await lstat(cinemaAssetSource);
if (!cinemaAssetSourceInfo.isDirectory() || cinemaAssetSourceInfo.isSymbolicLink()) {
  throw new Error("Evidence cinema asset source must be a physical directory");
}
for (const asset of cinemaAssets) {
  if (!/^assets\/[a-z0-9-]+\.webp$/.test(asset.path)) {
    throw new Error("Evidence cinema public asset path is invalid");
  }
  const sourcePath = path.join(docsSource, "evidence-cinema", asset.path);
  const before = await lstat(sourcePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Evidence cinema public asset must be a physical file: ${asset.path}`);
  }
  const bytes = await readFile(sourcePath);
  const after = await lstat(sourcePath);
  if (!after.isFile() || after.isSymbolicLink() ||
      before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs ||
      createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new Error(`Evidence cinema public asset changed after preflight: ${asset.path}`);
  }
  const destinationPath = path.join(outputDirectory, "docs", "evidence-cinema", asset.path);
  await ensurePhysicalOutputDirectory(path.dirname(destinationPath));
  await writeFile(destinationPath, bytes, { flag: "wx" });
}
const cinemaStylesSource = path.join(docsSource, "evidence-cinema", "shared", "cinema.css");
const cinemaStylesDirectoryInfo = await lstat(path.dirname(cinemaStylesSource));
if (!cinemaStylesDirectoryInfo.isDirectory() || cinemaStylesDirectoryInfo.isSymbolicLink()) {
  throw new Error("Evidence cinema stylesheet source must be a physical directory");
}
const stylesBefore = await lstat(cinemaStylesSource);
if (!stylesBefore.isFile() || stylesBefore.isSymbolicLink()) {
  throw new Error("Evidence cinema stylesheet must be a physical file");
}
const cinemaStyles = await readFile(cinemaStylesSource);
const stylesAfter = await lstat(cinemaStylesSource);
if (!stylesAfter.isFile() || stylesAfter.isSymbolicLink() ||
    stylesBefore.dev !== stylesAfter.dev || stylesBefore.ino !== stylesAfter.ino ||
    stylesBefore.mtimeMs !== stylesAfter.mtimeMs ||
    createHash("sha256").update(cinemaStyles).digest("hex") !== cinemaGuide.source.manifest.css) {
  throw new Error("Evidence cinema stylesheet changed after preflight");
}
const cinemaStylesDestination = path.join(outputDirectory, "docs", "evidence-cinema", "shared", "cinema.css");
await ensurePhysicalOutputDirectory(path.dirname(cinemaStylesDestination));
await writeFile(cinemaStylesDestination, cinemaStyles, { flag: "wx" });
const sponsorQrDigest = createHash("sha256")
  .update(await readFile(path.join(outputDirectory, SPONSORSHIP.qrPath.slice(1))))
  .digest("hex");
if (sponsorQrDigest !== SPONSORSHIP.qrSha256) throw new Error("Sponsorship QR does not match the owner-provided image");
await copyPublicPluginWebsiteFiles(pluginSource, path.join(outputDirectory, "plugins", "better-workflows"));

await writeFile(path.join(outputDirectory, "docs", "reference", "reference-locales.js"), referenceRuntimeSource());

for (const page of PUBLIC_DOC_PAGES) {
  const referencePath = path.join(outputDirectory, "docs", "reference", page.reference);
  await mkdir(path.dirname(referencePath), { recursive: true });
  await writeFile(referencePath, redirectPage(publicDocPath(DEFAULT_LOCALE, page.id), defaultLocale, (code) => publicDocPath(code, page.id)));
}

for (const locale of releaseLocales) {
  const localeReferenceRoot = path.join(outputDirectory, "docs", "reference", locale.code);
  await mkdir(localeReferenceRoot, { recursive: true });
  for (const page of PUBLIC_DOC_PAGES) {
    const localizedReferencePath = path.join(localeReferenceRoot, page.reference);
    await mkdir(path.dirname(localizedReferencePath), { recursive: true });
    await writeFile(localizedReferencePath, redirectPage(publicDocPath(locale.code, page.id), locale, (code) => publicDocPath(code, page.id)));
  }
}

const localizedTemplate = await readFile(localizedTemplatePath, "utf8");
for (const locale of releaseLocales) {
  const homepageFile = locale.code === DEFAULT_LOCALE
    ? path.join(outputDirectory, "index.html")
    : path.join(outputDirectory, locale.code, "index.html");
  await mkdir(path.dirname(homepageFile), { recursive: true });
  await writeFile(homepageFile, renderLocalizedPage(localizedTemplate, locale, commonValues));
}

for (const locale of releaseLocales) {
  for (const page of PUBLIC_DOC_PAGES) {
    const publicDirectory = path.join(outputDirectory, publicDocPath(locale.code, page.id).slice(1));
    await mkdir(publicDirectory, { recursive: true });
    await writeFile(path.join(publicDirectory, "index.html"), interactiveDocuments.get(page.id).pages.get(locale.code));
  }
}

for (const locale of releaseLocales) {
  const directory = path.join(outputDirectory, supportPath(locale.code).slice(1));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "index.html"), renderSupportHtml(locale.code));
}
for (const policy of policies) for (const locale of releaseLocales) {
  const directory = path.join(outputDirectory, publicTextPath(locale.code, policy.id).slice(1));
  await mkdir(directory, { recursive: true });
  const body = deferredReferenceIds.has(policy.id)
    ? redirectPage(publicDocPath(locale.code, "guide"), locale, (code) => publicDocPath(code, "guide"))
    : renderPolicyHtml(policy, locale.code);
  await writeFile(path.join(directory, "index.html"), body);
}
await writeFile(path.join(outputDirectory, "translation-coverage.json"), `${JSON.stringify(translationCoverage, null, 2)}\n`);

await writeFile(path.join(outputDirectory, "docs", "preview.html"), redirectPage(publicDocPath(DEFAULT_LOCALE, "quick"), defaultLocale, (code) => publicDocPath(code, "quick")));
await mkdir(path.join(outputDirectory, "docs", "use-cases"), { recursive: true });
await writeFile(path.join(outputDirectory, "docs", "use-cases", "preview.html"), redirectPage(publicDocPath(DEFAULT_LOCALE, "use-cases-quick"), defaultLocale, (code) => publicDocPath(code, "use-cases-quick")));

const notFoundPath = path.join(outputDirectory, "404.html");
const notFoundData = Object.fromEntries(releaseLocales.map((locale) => [locale.code, {
  dir: locale.dir || "ltr",
  title: locale.messages.TITLE,
  description: locale.messages.DESCRIPTION,
  language: locale.messages.LANGUAGE,
  docsCta: locale.messages.DOCS_CTA,
  home: homepagePath(locale.code),
  docs: publicDocPath(locale.code, "guide")
}]));
await writeFile(notFoundPath, replaceSiteTokens(await readFile(notFoundPath, "utf8"), {
  ...commonValues,
  DEFAULT_LOCALE: DEFAULT_LOCALE,
  DEFAULT_LOCALE_JSON: JSON.stringify(DEFAULT_LOCALE),
  DEFAULT_DIRECTION: defaultLocale.dir || "ltr",
  DEFAULT_TITLE: escapeHtml(defaultLocale.messages.TITLE),
  DEFAULT_DESCRIPTION: escapeHtml(defaultLocale.messages.DESCRIPTION),
  DEFAULT_LANGUAGE: escapeHtml(defaultLocale.messages.LANGUAGE),
  DEFAULT_DOCS_CTA: escapeHtml(defaultLocale.messages.DOCS_CTA),
  DEFAULT_HOME_PATH: homepagePath(DEFAULT_LOCALE),
  DEFAULT_DOCS_PATH: publicDocPath(DEFAULT_LOCALE, "guide"),
  LOCALE_OPTIONS: localeOptions(DEFAULT_LOCALE),
  LOCALE_LINKS: localeLinks(null),
  LOCALE_BUTTONS: localeButtonLinks(null),
  NOT_FOUND_DATA: JSON.stringify(notFoundData).replaceAll("<", "\\u003c")
}));

await writeFile(path.join(outputDirectory, "locales.json"), `${JSON.stringify({
  defaultLocale: DEFAULT_LOCALE,
  count: releaseLocales.length,
  sourceMappedDocuments,
  fullTextDocuments,
  referenceDocuments: translationCoverage.referenceDocuments,
  fullContentLocalizationComplete: translationCoverage.fullContentLocalizationComplete,
  publicDocumentationPages: PUBLIC_DOC_PAGES.length,
  localizedReferencePages: releaseLocales.length * PUBLIC_DOC_PAGES.length,
  locales: releaseLocales.map(({ code, label, dir = "ltr" }) => ({
    code,
    label,
    dir,
    url: localeUrl(code),
    support: `${canonicalOrigin}${supportPath(code)}`,
    policies: Object.fromEntries(policies.filter((doc) => doc.kind !== "guide").map((doc) => [doc.id, `${canonicalOrigin}${publicTextPath(code, doc.id)}`])),
    guides: Object.fromEntries(policies.filter((doc) => doc.kind === "guide").map((doc) => [doc.id, `${canonicalOrigin}${publicTextPath(code, doc.id)}`])),
    docs: Object.fromEntries(PUBLIC_DOC_PAGES.map((page) => [page.id, `${canonicalOrigin}${publicDocPath(code, page.id)}`]))
  }))
}, null, 2)}\n`);
await writeFile(path.join(outputDirectory, "sitemap.xml"), sitemapXml(sourceModifiedAt));
await writeFile(path.join(outputDirectory, "manifest.directories"), await directoryManifest(outputDirectory));
const artifactManifest = await contentManifest(outputDirectory);
await writeFile(path.join(outputDirectory, "manifest.sha256"), artifactManifest.manifest);
const artifactContentDigest = artifactManifest.digest;
await writeFile(path.join(outputDirectory, "release.json"), `${JSON.stringify({
  project: "better-workflows",
  version,
  revision,
  builtAt,
  sourceModifiedAt,
  canonical: `${canonicalOrigin}/`,
  domains: ["betterworkflows.dev", "betterworkflows.org"],
  repository: repositoryUrl,
  sponsorUrl,
  sponsorMode,
  sponsorCurrency: SPONSORSHIP.currency,
  sponsorNetwork: SPONSORSHIP.network,
  sponsorAddress: SPONSORSHIP.address,
  sponsorQrPath: SPONSORSHIP.qrPath,
  sponsorQrSha256: SPONSORSHIP.qrSha256,
  locales: releaseLocales.length,
  sourceMappedDocuments,
  fullTextDocuments,
  referenceDocuments: translationCoverage.referenceDocuments,
  fullContentLocalizationComplete: translationCoverage.fullContentLocalizationComplete,
  publicDocumentationPages: PUBLIC_DOC_PAGES.length,
  localizedReferencePages: releaseLocales.length * PUBLIC_DOC_PAGES.length,
  defaultLocale: DEFAULT_LOCALE,
  assetVersion,
  hostRegistryId: hostSupportRegistry.id,
  hostRegistryDigest,
  contentDigest: artifactContentDigest,
  artifact: "static-frontend"
}, null, 2)}\n`);

console.log(JSON.stringify({ outputDirectory, version, revision, builtAt, sourceModifiedAt, assetVersion, hostRegistryDigest, contentDigest: artifactContentDigest, locales: releaseLocales.length, publicDocumentationPages: PUBLIC_DOC_PAGES.length, localizedReferencePages: releaseLocales.length * PUBLIC_DOC_PAGES.length, repository: repositoryUrl, sponsorUrl, sponsorMode }, null, 2));
