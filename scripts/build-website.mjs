#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CONNECTORS_LOCALES, DEFAULT_LOCALE, LOCALE_KEYS, locales } from "./website-locales.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const outputDirectory = path.resolve(process.env.SITE_OUTPUT_DIR || path.join(repoRoot, "dist", "website"));
const websiteSource = path.join(repoRoot, "website");
const localizedTemplatePath = path.join(scriptDirectory, "templates", "localized-homepage.html");
const docsSource = path.join(repoRoot, "docs", "html");
const pluginSource = path.join(repoRoot, "plugins", "better-workflows");
const canonicalOrigin = "https://betterworkflows.dev";
const repositoryUrl = "https://github.com/stephen-taipei/better-workflows";
const sponsorUrl = "https://ko-fi.com/betterworkflows";
const sponsorMode = "one-time-only";

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

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function localePath(code) {
  return code === DEFAULT_LOCALE ? "/" : `/${code}/`;
}

function localeUrl(code) {
  return `${canonicalOrigin}${localePath(code)}`;
}

function hreflangLinks() {
  return [
    ...locales.map((locale) => `<link rel="alternate" hreflang="${locale.code}" href="${localeUrl(locale.code)}">`),
    `<link rel="alternate" hreflang="x-default" href="${canonicalOrigin}/">`
  ].join("\n    ");
}

function localeOptions(currentLocale) {
  return locales.map((locale) => {
    const selected = locale.code === currentLocale ? " selected" : "";
    return `<option value="${localePath(locale.code)}"${selected}>${escapeHtml(locale.label)}</option>`;
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
    HREFLANG_LINKS: hreflangLinks(),
    LOCALE_OPTIONS: localeOptions(locale.code),
    STRUCTURED_DATA: structuredData({ locale: locale.code, title: locale.messages.TITLE, description: locale.messages.DESCRIPTION, canonical, version: commonValues.VERSION })
  });
}

async function copyPluginWithoutNodeModules(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: (sourcePath) => !sourcePath.split(path.sep).includes("node_modules")
  });
}

function injectDocumentMetadata(content, page, version) {
  const canonical = `${canonicalOrigin}${page.path}`;
  const graph = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${canonical}#webpage`,
    name: page.title,
    description: page.description,
    url: canonical,
    image: `${canonicalOrigin}/docs/assets/better-workflows-control-plane-blue.webp`,
    inLanguage: ["zh-Hant", "en"],
    isPartOf: { "@id": `${canonicalOrigin}/#website` },
    about: { "@type": "SoftwareSourceCode", name: "Better Workflows", version, codeRepository: repositoryUrl }
  }).replaceAll("<", "\\u003c");
  const metadata = `
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Better Workflows">
  <meta property="og:locale" content="zh_TW">
  <meta property="og:url" content="${canonical}">
  <meta property="og:title" content="${escapeHtml(page.title)}">
  <meta property="og:description" content="${escapeHtml(page.description)}">
  <meta property="og:image" content="${canonicalOrigin}/docs/assets/better-workflows-control-plane-blue.webp">
  <meta property="og:image:width" content="1536">
  <meta property="og:image:height" content="1024">
  <meta property="og:image:alt" content="Better Workflows control plane">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(page.title)}">
  <meta name="twitter:description" content="${escapeHtml(page.description)}">
  <meta name="twitter:image" content="${canonicalOrigin}/docs/assets/better-workflows-control-plane-blue.webp">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="canonical" href="${canonical}">
  <script type="application/ld+json">${graph}</script>`;
  const normalized = content
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escapeHtml(page.description)}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(page.title)}</title>`);
  return normalized.replace("</head>", `${metadata}\n</head>`);
}

const documentPages = [
  { file: "docs/index.html", path: "/docs/", title: "Better Workflows 解剖書｜控制面與證據架構", description: "Better Workflows evidence-driven control plane、資料流、review、action、reconciliation 與 replay 的互動式官方文件。" },
  { file: "docs/preview.html", path: "/docs/preview.html", title: "Better Workflows 快速導覽｜控制面與即時證據", description: "用 5–10 分鐘理解 Better Workflows 的控制面、即時證據、replay 與可證明完成邊界。" },
  { file: "docs/use-cases/index.html", path: "/docs/use-cases/", title: "Better Workflows 情境應用手冊", description: "依任務風險選擇 Better Workflows template、mode、evidence、review、replay 與外部副作用關卡。" },
  { file: "docs/use-cases/preview.html", path: "/docs/use-cases/preview.html", title: "Better Workflows 情境手冊快速預覽", description: "快速查看 Better Workflows 工作路線、驗證強度、即時證據、停止條件與 replay 邊界。" },
  { file: "docs/evidence-cinema/index.html", path: "/docs/evidence-cinema/", title: "Better Workflows 證據劇場｜互動式 Evidence Cinema", description: "以八幕原創互動故事重播 Better Workflows 的 evidence、ledger、review、action 與 reconciliation lifecycle。" }
];

function sitemapXml(builtAt) {
  const lastModified = builtAt.slice(0, 10);
  const alternates = [
    ...locales.map((locale) => `    <xhtml:link rel="alternate" hreflang="${locale.code}" href="${localeUrl(locale.code)}"/>`),
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${canonicalOrigin}/"/>`
  ].join("\n");
  const localeEntries = locales.map((locale) => `  <url>
    <loc>${localeUrl(locale.code)}</loc>
    <lastmod>${lastModified}</lastmod>
${alternates}
  </url>`).join("\n");
  const docsEntries = documentPages.map((page) => `  <url><loc>${canonicalOrigin}${page.path}</loc><lastmod>${lastModified}</lastmod></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${localeEntries}
${docsEntries}
</urlset>
`;
}

const version = await packageVersion();
const revision = await gitRevision();
const builtAt = buildTime();
const assetVersion = await websiteAssetVersion();
const commonValues = { VERSION: version, REVISION: revision, BUILD_TIME: builtAt, ASSET_VERSION: assetVersion };

if (locales.length !== 41 || JSON.stringify(locales.map((locale) => locale.code)) !== JSON.stringify(CONNECTORS_LOCALES)) {
  throw new Error("Website locale scope must match the Connectors iOS 41-locale inventory exactly");
}
for (const locale of locales) {
  if (JSON.stringify(Object.keys(locale.messages)) !== JSON.stringify(LOCALE_KEYS)) throw new Error(`Locale key order mismatch: ${locale.code}`);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(websiteSource, outputDirectory, { recursive: true });
await cp(docsSource, path.join(outputDirectory, "docs"), { recursive: true });
await copyPluginWithoutNodeModules(pluginSource, path.join(outputDirectory, "plugins", "better-workflows"));

// The generated cinema page was authored from the repository root, where
// ../../../plugins resolves from docs/html/evidence-cinema. After the docs
// tree is mounted at /docs, the equivalent public path is ../../plugins.
const cinemaPagePath = path.join(outputDirectory, "docs", "evidence-cinema", "index.html");
const cinemaPage = await readFile(cinemaPagePath, "utf8");
await writeFile(cinemaPagePath, cinemaPage.replaceAll("../../../plugins/", "../../plugins/"));

const defaultLocale = locales.find((locale) => locale.code === DEFAULT_LOCALE);
const rootCanonical = `${canonicalOrigin}/`;
const rootPath = path.join(outputDirectory, "index.html");
const rootContent = await readFile(rootPath, "utf8");
await writeFile(rootPath, replaceSiteTokens(rootContent, {
  ...commonValues,
  HREFLANG_LINKS: hreflangLinks(),
  LOCALE_OPTIONS: localeOptions(DEFAULT_LOCALE),
  STRUCTURED_DATA: structuredData({ locale: DEFAULT_LOCALE, title: defaultLocale.messages.TITLE, description: defaultLocale.messages.DESCRIPTION, canonical: rootCanonical, version })
}));

const localizedTemplate = await readFile(localizedTemplatePath, "utf8");
for (const locale of locales.filter((item) => item.code !== DEFAULT_LOCALE)) {
  const localeDirectory = path.join(outputDirectory, locale.code);
  await mkdir(localeDirectory, { recursive: true });
  await writeFile(path.join(localeDirectory, "index.html"), renderLocalizedPage(localizedTemplate, locale, commonValues));
}

const notFoundPath = path.join(outputDirectory, "404.html");
await writeFile(notFoundPath, replaceSiteTokens(await readFile(notFoundPath, "utf8"), commonValues));

for (const page of documentPages) {
  const filePath = path.join(outputDirectory, page.file);
  const content = await readFile(filePath, "utf8");
  await writeFile(filePath, injectDocumentMetadata(content, page, version));
}

await writeFile(path.join(outputDirectory, "locales.json"), `${JSON.stringify({
  defaultLocale: DEFAULT_LOCALE,
  count: locales.length,
  locales: locales.map(({ code, label, dir = "ltr" }) => ({ code, label, dir, url: localeUrl(code) }))
}, null, 2)}\n`);
await writeFile(path.join(outputDirectory, "sitemap.xml"), sitemapXml(builtAt));
const artifactManifest = await contentManifest(outputDirectory);
await writeFile(path.join(outputDirectory, "manifest.sha256"), artifactManifest.manifest);
const artifactContentDigest = artifactManifest.digest;
await writeFile(path.join(outputDirectory, "release.json"), `${JSON.stringify({
  project: "better-workflows",
  version,
  revision,
  builtAt,
  canonical: `${canonicalOrigin}/`,
  domains: ["betterworkflows.dev", "betterworkflows.org"],
  repository: repositoryUrl,
  sponsorUrl,
  sponsorMode,
  locales: locales.length,
  defaultLocale: DEFAULT_LOCALE,
  assetVersion,
  contentDigest: artifactContentDigest,
  artifact: "static-frontend"
}, null, 2)}\n`);

console.log(JSON.stringify({ outputDirectory, version, revision, builtAt, assetVersion, contentDigest: artifactContentDigest, locales: locales.length, repository: repositoryUrl, sponsorUrl, sponsorMode }, null, 2));
