#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CONNECTORS_LOCALES, DEFAULT_LOCALE, LOCALE_KEYS, locales } from "./website-locales.mjs";
import { PUBLIC_DOC_PAGES, homepagePath, publicDocCards, publicDocCopy, publicDocPath } from "./public-docs.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const outputDirectory = path.resolve(process.env.SITE_OUTPUT_DIR || path.join(repoRoot, "dist", "website"));
const websiteSource = path.join(repoRoot, "website");
const localizedTemplatePath = path.join(scriptDirectory, "templates", "localized-homepage.html");
const localizedDocTemplatePath = path.join(scriptDirectory, "templates", "localized-doc-page.html");
const docsSource = path.join(repoRoot, "docs", "html");
const pluginSource = path.join(repoRoot, "plugins", "better-workflows");
const canonicalOrigin = "https://betterworkflows.dev";
const repositoryUrl = "https://github.com/stephen-taipei/better-workflows";
const sponsorUrl = "https://ko-fi.com/betterworkflows";
const sponsorMode = "one-time-only";

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

const openGraphLocales = {
  ar: "ar_AR", ca: "ca_ES", cs: "cs_CZ", da: "da_DK", de: "de_DE", el: "el_GR", en: "en_US", es: "es_ES", "es-MX": "es_MX", fi: "fi_FI", fil: "fil_PH", fr: "fr_FR", he: "he_IL", hi: "hi_IN", hr: "hr_HR", hu: "hu_HU", id: "id_ID", it: "it_IT", ja: "ja_JP", km: "km_KH", ko: "ko_KR", lo: "lo_LA", ms: "ms_MY", my: "my_MM", nb: "nb_NO", nl: "nl_NL", pl: "pl_PL", pt: "pt_PT", "pt-BR": "pt_BR", ro: "ro_RO", ru: "ru_RU", sk: "sk_SK", sv: "sv_SE", th: "th_TH", tr: "tr_TR", uk: "uk_UA", vi: "vi_VN", "zh-Hans": "zh_CN", "zh-Hant": "zh_TW", "zh-Hant-HK": "zh_HK", "zh-Hant-TW": "zh_TW"
};

async function gitRevision() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: repoRoot });
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
  for (const fileName of ["styles.css", "site.js"]) {
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

function localePath(code) {
  return homepagePath(code);
}

function localeUrl(code) {
  return `${canonicalOrigin}${localePath(code)}`;
}

function hreflangLinks(pathForLocale = localePath) {
  return [
    ...locales.map((locale) => `<link rel="alternate" hreflang="${locale.code}" href="${canonicalOrigin}${pathForLocale(locale.code)}">`),
    `<link rel="alternate" hreflang="x-default" href="${canonicalOrigin}${pathForLocale(DEFAULT_LOCALE)}">`
  ].join("\n    ");
}

function localeOptions(currentLocale = null, pathForLocale = localePath) {
  return locales.map((locale) => {
    const selected = locale.code === currentLocale ? " selected" : "";
    return `<option value="${pathForLocale(locale.code)}"${selected}>${escapeHtml(locale.label)}</option>`;
  }).join("");
}

function structuredData({ locale, title, description, canonical, version }) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${canonicalOrigin}/#website`,
        url: `${canonicalOrigin}/`,
        name: "Better Workflows",
        alternateName: ["BW", "betterworkflows.dev"],
        inLanguage: CONNECTORS_LOCALES,
        sameAs: [repositoryUrl, sponsorUrl]
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
        runtimePlatform: "Codex",
        version,
        inLanguage: locale,
        isPartOf: { "@id": `${canonicalOrigin}/#website` }
      }
    ]
  }).replaceAll("<", "\\u003c");
}

function documentStructuredData({ locale, title, description, canonical, reference, version }) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${canonical}#page`,
    headline: title,
    description,
    url: canonical,
    image: `${canonicalOrigin}/docs/assets/better-workflows-control-plane-blue.webp`,
    inLanguage: locale,
    isPartOf: { "@id": `${canonicalOrigin}/#website` },
    isBasedOn: `${canonicalOrigin}${reference}`,
    about: {
      "@type": "SoftwareSourceCode",
      name: "Better Workflows",
      version,
      codeRepository: repositoryUrl
    }
  }).replaceAll("<", "\\u003c");
}

function replaceSiteTokens(content, values) {
  return content.replace(/__SITE_([A-Z0-9_]+)__/g, (_, key) => values[key] ?? "unknown");
}

function renderLocalizedPage(template, locale, commonValues) {
  let content = template;
  for (const key of LOCALE_KEYS) content = content.replaceAll(`__I18N_${key}__`, escapeHtml(locale.messages[key]));
  const canonical = localeUrl(locale.code);
  return replaceSiteTokens(content, {
    ...commonValues,
    LOCALE: locale.code,
    DIRECTION: locale.dir || "ltr",
    OG_LOCALE: openGraphLocales[locale.code],
    CANONICAL: canonical,
    HOME_PATH: homepagePath(locale.code),
    IMAGE_ALT: escapeHtml(`${locale.messages.CONTROL_TITLE} — Better Workflows`),
    HREFLANG_LINKS: hreflangLinks(),
    LOCALE_OPTIONS: localeOptions(locale.code),
    DOCS_PATH: publicDocPath(locale.code, "guide"),
    CINEMA_PATH: publicDocPath(locale.code, "evidence-cinema"),
    DOC_CARDS: renderDocumentCards(locale, null),
    STRUCTURED_DATA: structuredData({ locale: locale.code, title: locale.messages.TITLE, description: locale.messages.DESCRIPTION, canonical, version: commonValues.VERSION })
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

function renderLocalizedDocument(template, locale, page, commonValues) {
  let content = template;
  for (const key of LOCALE_KEYS) content = content.replaceAll(`__I18N_${key}__`, escapeHtml(locale.messages[key]));
  const copy = publicDocCopy(locale, page.id);
  const canonicalPath = publicDocPath(locale.code, page.id);
  const canonical = `${canonicalOrigin}${canonicalPath}`;
  const metaTitle = `${copy.title} | Better Workflows`;
  return replaceSiteTokens(content, {
    ...commonValues,
    LOCALE: locale.code,
    DIRECTION: locale.dir || "ltr",
    OG_LOCALE: openGraphLocales[locale.code],
    CANONICAL: canonical,
    HOME_PATH: homepagePath(locale.code),
    DOCS_PATH: publicDocPath(locale.code, "guide"),
    CINEMA_PATH: publicDocPath(locale.code, "evidence-cinema"),
    PAGE_TITLE: escapeHtml(copy.title),
    PAGE_META_TITLE: escapeHtml(metaTitle),
    PAGE_DESCRIPTION: escapeHtml(copy.description),
    IMAGE_ALT: escapeHtml(`${copy.title} — Better Workflows`),
    REFERENCE_PATH: copy.referencePath,
    HREFLANG_LINKS: hreflangLinks((code) => publicDocPath(code, page.id)),
    LOCALE_OPTIONS: localeOptions(locale.code, (code) => publicDocPath(code, page.id)),
    DOC_CARDS: renderDocumentCards(locale, page.id),
    STRUCTURED_DATA: documentStructuredData({ locale: locale.code, title: metaTitle, description: copy.description, canonical, reference: copy.referencePath, version: commonValues.VERSION })
  });
}

async function copyPluginWithoutNodeModules(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: (sourcePath) => !sourcePath.split(path.sep).includes("node_modules")
  });
}

function injectReferenceMetadata(content, page) {
  const canonical = `${canonicalOrigin}${publicDocPath(DEFAULT_LOCALE, page.id)}`;
  const localeControl = `<aside style="position:fixed;right:12px;bottom:12px;z-index:9999;padding:8px 10px;border:1px solid #94a3b8;border-radius:10px;background:#fff;color:#172238;font:12px/1.4 system-ui;box-shadow:0 8px 30px rgba(15,23,42,.18)"><label>🌐 BCP 47 <select aria-label="BCP 47" onchange="if(this.value)window.top.location.assign(this.value)"><option value="" selected disabled>—</option>${localeOptions(null, (code) => publicDocPath(code, page.id))}</select></label></aside>`;
  const referenceRoutes = Object.fromEntries(PUBLIC_DOC_PAGES.map((item) => [`/docs/reference/${item.reference}`, item.path]));
  const topLevelNavigation = `<script>(()=>{const locales=${JSON.stringify(CONNECTORS_LOCALES)};const routes=${JSON.stringify(referenceRoutes)};const openSource=target=>window.open(target.href,"_blank","noopener,noreferrer");const syncTopHash=()=>{if(window.top!==window&&window.top.location.hash!==location.hash)window.top.location.hash=location.hash;};window.addEventListener("hashchange",syncTopHash);document.addEventListener("click",event=>{if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;const link=event.target.closest("a[href]");if(!link||link.download||link.target&&link.target!=="_self")return;const target=new URL(link.href,location.href);if(target.origin!==location.origin){event.preventDefault();openSource(target);return;}if(target.pathname===location.pathname){if(target.hash&&window.top.location.hash!==target.hash){event.preventDefault();window.top.location.hash=target.hash;}return;}const route=routes[target.pathname];if(!route){event.preventDefault();openSource(target);return;}const first=window.top.location.pathname.split("/").filter(Boolean)[0];const locale=locales.includes(first)?first:${JSON.stringify(DEFAULT_LOCALE)};const prefix=locale===${JSON.stringify(DEFAULT_LOCALE)}?"/":"/"+locale+"/";event.preventDefault();window.top.location.assign(prefix+route+target.hash);});})();</script>`;
  const metadata = `
  <meta name="robots" content="noindex,follow">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="canonical" href="${canonical}">`;
  return content
    .replace(/\s*<meta name="robots" content="[^"]*">/g, "")
    .replace(/\s*<link rel="canonical" href="[^"]*">/g, "")
    .replace("</head>", `${metadata}\n</head>`)
    .replace(/<body([^>]*)>/, `<body$1>${localeControl}${topLevelNavigation}`);
}

function redirectPage(destination) {
  const canonical = `${canonicalOrigin}${destination}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,follow"><meta http-equiv="refresh" content="0;url=${destination}"><link rel="canonical" href="${canonical}"><title>Better Workflows documentation</title></head><body><a href="${destination}">Continue to Better Workflows documentation</a></body></html>\n`;
}

function sitemapXml(sourceModifiedAt) {
  const lastModified = sourceModifiedAt?.slice(0, 10) || null;
  const entriesFor = (pathForLocale) => {
    const alternates = [
      ...locales.map((locale) => `    <xhtml:link rel="alternate" hreflang="${locale.code}" href="${canonicalOrigin}${pathForLocale(locale.code)}"/>`),
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${canonicalOrigin}${pathForLocale(DEFAULT_LOCALE)}"/>`
    ].join("\n");
    return locales.map((locale) => `  <url>
    <loc>${canonicalOrigin}${pathForLocale(locale.code)}</loc>${lastModified ? `\n    <lastmod>${lastModified}</lastmod>` : ""}
${alternates}
  </url>`).join("\n");
  };
  const homepageEntries = entriesFor(localePath);
  const docsEntries = PUBLIC_DOC_PAGES.map((page) => entriesFor((code) => publicDocPath(code, page.id))).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${homepageEntries}
${docsEntries}
</urlset>
`;
}

const version = await packageVersion();
const revision = await gitRevision();
const sourceModifiedAt = await gitSourceModifiedAt();
const builtAt = buildTime();
const assetVersion = await websiteAssetVersion();
const commonValues = { VERSION: version, REVISION: revision, BUILD_TIME: builtAt, ASSET_VERSION: assetVersion };
const defaultLocale = locales.find((locale) => locale.code === DEFAULT_LOCALE);

if (locales.length !== 41 || JSON.stringify(locales.map((locale) => locale.code)) !== JSON.stringify(CONNECTORS_LOCALES)) {
  throw new Error("Website locale scope must match the Connectors iOS 41-locale inventory exactly");
}
for (const locale of locales) {
  if (JSON.stringify(Object.keys(locale.messages)) !== JSON.stringify(LOCALE_KEYS)) throw new Error(`Locale key order mismatch: ${locale.code}`);
}

await assertSafeOutputDirectory();
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(websiteSource, outputDirectory, { recursive: true });
await cp(docsSource, path.join(outputDirectory, "docs", "reference"), { recursive: true });
await cp(path.join(docsSource, "assets"), path.join(outputDirectory, "docs", "assets"), { recursive: true });
await copyPluginWithoutNodeModules(pluginSource, path.join(outputDirectory, "plugins", "better-workflows"));

for (const page of PUBLIC_DOC_PAGES) {
  const referencePath = path.join(outputDirectory, "docs", "reference", page.reference);
  await writeFile(referencePath, injectReferenceMetadata(await readFile(referencePath, "utf8"), page));
}

const localizedTemplate = await readFile(localizedTemplatePath, "utf8");
for (const locale of locales) {
  const homepageFile = locale.code === DEFAULT_LOCALE
    ? path.join(outputDirectory, "index.html")
    : path.join(outputDirectory, locale.code, "index.html");
  await mkdir(path.dirname(homepageFile), { recursive: true });
  await writeFile(homepageFile, renderLocalizedPage(localizedTemplate, locale, commonValues));
}

const localizedDocTemplate = await readFile(localizedDocTemplatePath, "utf8");
for (const locale of locales) {
  for (const page of PUBLIC_DOC_PAGES) {
    const publicDirectory = path.join(outputDirectory, publicDocPath(locale.code, page.id).slice(1));
    await mkdir(publicDirectory, { recursive: true });
    await writeFile(path.join(publicDirectory, "index.html"), renderLocalizedDocument(localizedDocTemplate, locale, page, commonValues));
  }
}

await writeFile(path.join(outputDirectory, "docs", "preview.html"), redirectPage(publicDocPath(DEFAULT_LOCALE, "quick")));
await mkdir(path.join(outputDirectory, "docs", "use-cases"), { recursive: true });
await writeFile(path.join(outputDirectory, "docs", "use-cases", "preview.html"), redirectPage(publicDocPath(DEFAULT_LOCALE, "use-cases-quick")));

const notFoundPath = path.join(outputDirectory, "404.html");
const notFoundData = Object.fromEntries(locales.map((locale) => [locale.code, {
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
  NOT_FOUND_DATA: JSON.stringify(notFoundData).replaceAll("<", "\\u003c")
}));

await writeFile(path.join(outputDirectory, "locales.json"), `${JSON.stringify({
  defaultLocale: DEFAULT_LOCALE,
  count: locales.length,
  publicDocumentationPages: PUBLIC_DOC_PAGES.length,
  locales: locales.map(({ code, label, dir = "ltr" }) => ({
    code,
    label,
    dir,
    url: localeUrl(code),
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
  locales: locales.length,
  publicDocumentationPages: PUBLIC_DOC_PAGES.length,
  defaultLocale: DEFAULT_LOCALE,
  assetVersion,
  contentDigest: artifactContentDigest,
  artifact: "static-frontend"
}, null, 2)}\n`);

console.log(JSON.stringify({ outputDirectory, version, revision, builtAt, sourceModifiedAt, assetVersion, contentDigest: artifactContentDigest, locales: locales.length, repository: repositoryUrl, sponsorUrl, sponsorMode }, null, 2));
