import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { PUBLIC_DOC_PAGES, UNNATURAL_EVIDENCE_PATTERNS, publicDocCopy, publicDocPath } from "../public-docs.mjs";
import { CONNECTORS_LOCALES, DEFAULT_LOCALE, LOCALE_KEYS, SPONSOR_LOCALE_MARKERS, SPONSOR_ONE_TIME_MARKERS, locales } from "../website-locales.mjs";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "../..");
const buildScript = path.join(repoRoot, "scripts", "build-website.mjs");
const generatorScript = path.join(repoRoot, "scripts", "generate-localized-markdown.mjs");
const repositoryUrl = "https://github.com/stephen-taipei/better-workflows";
const sponsorUrl = "https://ko-fi.com/betterworkflows";

function occurrences(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

function outputHtmlPath(outputDirectory, urlPath) {
  return path.join(outputDirectory, urlPath.slice(1), "index.html");
}

function referenceNavigationHarness(html) {
  const script = html.match(/<script>(\(\(\)=>\{const locales=[\s\S]*?\}\)\(\);)<\/script>/)?.[1];
  assert.ok(script, "reference navigation script");
  const frameLocation = new URL("https://betterworkflows.dev/docs/reference/index.html");
  const assigned = [];
  const opened = [];
  const topLocation = {
    pathname: "/ja/docs/",
    hash: "",
    assign(value) { assigned.push(value); }
  };
  let clickHandler;
  let hashHandler;
  const frameWindow = {
    location: frameLocation,
    top: { location: topLocation },
    open(...args) { opened.push(args); },
    addEventListener(type, handler) {
      if (type === "hashchange") hashHandler = handler;
    }
  };
  const document = {
    addEventListener(type, handler) {
      if (type === "click") clickHandler = handler;
    }
  };
  runInNewContext(script, { document, location: frameLocation, URL, window: frameWindow });
  assert.equal(typeof clickHandler, "function");
  assert.equal(typeof hashHandler, "function");
  return {
    click(href, { target = "", download = false } = {}) {
      assigned.length = 0;
      opened.length = 0;
      let prevented = false;
      const link = { href: new URL(href, frameLocation).href, target, download };
      clickHandler({
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: { closest: () => link },
        preventDefault() { prevented = true; }
      });
      return { prevented, assigned: assigned[0] ?? null, opened: opened[0] ?? null, topHash: topLocation.hash };
    },
    syncFrameHash(hash) {
      frameLocation.hash = hash;
      hashHandler();
      return topLocation.hash;
    }
  };
}

const UNLOCALIZED_UI_PATTERNS = {
  fil: [/\bcommand\b/iu, /\bcompletion\b/iu, /\btemplates?\b/iu, /\btests?\b/iu, /\brepository\b/iu],
  hi: [/Architecture map/iu, /use cases?/iu, /source code/iu],
  km: [/\b(?:code|templates?|tests?|repository|command)\b/iu],
  lo: [/\b(?:control plane|open-source|goal-first|workflow|review gates?|reconciliation|goal|scope|authority|contract|source|evidence|completion|terminal state|source code|code|templates?|tests?|repository|command)\b/iu],
  my: [/\b(?:architecture map|use cases?|command run|completion|terminal state|source code|repository|templates?|tests?|theme)\b/iu]
};

test("locale catalog matches Connectors iOS, preserves key order, and rejects freshness calques", async () => {
  const connectorsFixture = JSON.parse(await readFile(path.join(testDirectory, "fixtures", "connectors-ios-locales.json"), "utf8"));
  assert.equal(locales.length, 41);
  assert.deepEqual(CONNECTORS_LOCALES, connectorsFixture);
  assert.deepEqual(locales.map((locale) => locale.code), CONNECTORS_LOCALES);
  assert.equal(new Set(CONNECTORS_LOCALES).size, 41);
  for (const locale of locales) {
    assert.deepEqual(Object.keys(locale.messages), LOCALE_KEYS, locale.code);
    for (const key of LOCALE_KEYS) assert.ok(locale.messages[key].trim().length > 0, `${locale.code}.${key}`);
    for (const pattern of UNNATURAL_EVIDENCE_PATTERNS[locale.code] || []) {
      assert.doesNotMatch(JSON.stringify(locale.messages), pattern, `${locale.code}: ${pattern}`);
    }
    for (const pattern of UNLOCALIZED_UI_PATTERNS[locale.code] || []) {
      assert.doesNotMatch(JSON.stringify(locale.messages), pattern, `${locale.code}: ${pattern}`);
    }
    const documentCopies = PUBLIC_DOC_PAGES.map((page) => publicDocCopy(locale, page.id));
    assert.equal(new Set(documentCopies.map(({ title }) => title)).size, PUBLIC_DOC_PAGES.length, `${locale.code}: document titles`);
    assert.equal(new Set(documentCopies.map(({ description }) => description)).size, PUBLIC_DOC_PAGES.length, `${locale.code}: document descriptions`);
  }

  const traditionalTaiwan = locales.find((locale) => locale.code === "zh-Hant-TW").messages;
  const simplifiedChinese = locales.find((locale) => locale.code === "zh-Hans").messages;
  const japanese = locales.find((locale) => locale.code === "ja").messages;
  const korean = locales.find((locale) => locale.code === "ko").messages;
  const italian = locales.find((locale) => locale.code === "it").messages;
  assert.match(traditionalTaiwan.DESCRIPTION, /目前仍有效的證據/);
  assert.match(simplifiedChinese.DESCRIPTION, /当前仍有效的证据/);
  assert.match(japanese.DESCRIPTION, /現在のソースに紐付き、なお有効な証拠/);
  assert.match(korean.DESCRIPTION, /현재 소스에 바인딩되어 여전히 유효한 증거/);
  assert.match(italian.HERO_TITLE, /degli agenti$/);
  assert.doesNotMatch(JSON.stringify(locales.filter((locale) => locale.code.startsWith("zh-"))), /即時證據|实时证据|新鮮(?:的)?證據|新鲜(?:的)?证据/);
  assert.equal(locales.find((locale) => locale.code === "ar").dir, "rtl");
  assert.equal(locales.find((locale) => locale.code === "he").dir, "rtl");
  assert.deepEqual(Object.keys(SPONSOR_ONE_TIME_MARKERS).sort(), [...CONNECTORS_LOCALES].sort());
  assert.deepEqual(Object.keys(SPONSOR_LOCALE_MARKERS).sort(), [...CONNECTORS_LOCALES].sort());
  for (const locale of locales) {
    assert.ok(locale.messages.SPONSOR_BODY.includes(SPONSOR_ONE_TIME_MARKERS[locale.code]), `${locale.code}.SPONSOR_BODY one-time marker`);
    assert.ok(locale.messages.SPONSOR_BODY.includes(SPONSOR_LOCALE_MARKERS[locale.code]), `${locale.code}.SPONSOR_BODY locale-edition marker`);
  }
  assert.match(traditionalTaiwan.SPONSOR_BODY, /單次贊助/);
  assert.doesNotMatch(JSON.stringify(locales.filter((locale) => locale.code.startsWith("zh-"))), /走到可證明|達至可證明|走到可证明|外部副作用|一次過贊助|\b(?:repository|templates|tests|roadmap)\b/iu);
  assert.doesNotMatch(JSON.stringify(japanese), /証明可能|provider reconciliation|外部作用/iu);
  assert.doesNotMatch(JSON.stringify(korean), /증명 가능한|provider reconciliation|제어면|외부 효과/iu);
  assert.doesNotMatch(JSON.stringify(locales.find((locale) => locale.code === "hi").messages), /\b(?:agent workflows?|review gates?|open-source|goal-first|control plane)\b/iu);
  assert.doesNotMatch(JSON.stringify(locales), /41(?:[-\s]*(?:languages?|language localization)|\s*(?:種|种)?\s*(?:語言|语言|言語)|개\s*언어)/iu);
});

test("generated repository documentation covers the exact 41 locales", async () => {
  await execFileAsync(process.execPath, [generatorScript, "--check"], { cwd: repoRoot });
  const localeDirectory = path.join(repoRoot, "docs", "locales");
  const files = (await readdir(localeDirectory)).filter((name) => name.endsWith(".md")).sort();
  assert.deepEqual(files, CONNECTORS_LOCALES.map((code) => `${code}.md`).sort());

  const languageIndex = await readFile(path.join(repoRoot, "docs", "LANGUAGES.md"), "utf8");
  assert.deepEqual([...languageIndex.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]), CONNECTORS_LOCALES);
  assert.match(languageIndex, /localization terminology policy/);

  for (const locale of locales) {
    const markdown = await readFile(path.join(localeDirectory, `${locale.code}.md`), "utf8");
    assert.match(markdown, new RegExp(`https://betterworkflows\\.dev${publicDocPath(locale.code, "guide").replaceAll("/", "\\/")}`), locale.code);
    assert.match(markdown, /\(\.\.\/LOCALIZATION\.md\)/);
    assert.ok(markdown.includes(locale.messages.DESCRIPTION), locale.code);
    for (const pattern of UNNATURAL_EVIDENCE_PATTERNS[locale.code] || []) assert.doesNotMatch(markdown, pattern, locale.code);
  }

  const publicChineseSources = await Promise.all([
    "docs/README.zh-TW.md",
    "docs/README.zh-CN.md",
    "docs/details/zh-TW.md",
    "docs/details/zh-CN.md",
    "docs/html/index.html",
    "docs/html/preview.html",
    "docs/html/use-cases/index.html",
    "docs/html/use-cases/preview.html",
    "docs/html/evidence-cinema/index.html"
  ].map(async (relativePath) => readFile(path.join(repoRoot, relativePath), "utf8")));
  assert.doesNotMatch(publicChineseSources.join("\n"), /新鮮(?:的)?證據|新鲜(?:的)?证据|即時證據|实时证据/);
  assert.doesNotMatch(publicChineseSources.join("\n"), /41\s*(?:種|种)?\s*(?:語言|语言)/u);
});

test("build emits 41 localized homepages and five documentation routes with complete SEO metadata", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "better-workflows-seo-"));
  const outputDirectory = path.join(temporaryRoot, "website");
  try {
    await execFileAsync(process.execPath, [buildScript], {
      cwd: repoRoot,
      env: { ...process.env, SITE_OUTPUT_DIR: outputDirectory, SOURCE_DATE_EPOCH: "1787644800" }
    });

    const expectedHreflangs = new Set([...CONNECTORS_LOCALES, "x-default"]);
    let homepageStructure = null;
    for (const locale of locales) {
      const homepageRelativePath = locale.code === DEFAULT_LOCALE ? "index.html" : path.join(locale.code, "index.html");
      const html = await readFile(path.join(outputDirectory, homepageRelativePath), "utf8");
      const canonical = `https://betterworkflows.dev${locale.code === DEFAULT_LOCALE ? "/" : `/${locale.code}/`}`;
      assert.match(html, new RegExp(`<html lang="${locale.code}"`), locale.code);
      assert.match(html, new RegExp(`<link rel="canonical" href="${canonical.replaceAll("/", "\\/")}">`), locale.code);
      assert.match(html, /<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">/);
      assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
      assert.match(html, /<meta property="og:image:alt"/);
      assert.match(html, new RegExp(repositoryUrl.replaceAll("/", "\\/")));
      assert.match(html, new RegExp(sponsorUrl.replaceAll("/", "\\/")));
      assert.match(html, /id="sponsor"/);
      assert.match(html, /id="docs"/);
      assert.equal(occurrences(html, /<h1\b/g), 1, locale.code);
      assert.equal(occurrences(html, /<option\b/g), 41, locale.code);
      assert.equal(occurrences(html, /class="doc-card/g), PUBLIC_DOC_PAGES.length, locale.code);
      assert.doesNotMatch(html, /__(?:SITE|I18N)_/);
      assert.deepEqual(new Set([...html.matchAll(/<link rel="alternate" hreflang="([^"]+)"/g)].map((match) => match[1])), expectedHreflangs, locale.code);

      const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
      const source = jsonLd["@graph"].find((item) => item["@type"] === "SoftwareSourceCode");
      assert.equal(source.codeRepository, repositoryUrl);
      assert.equal(source.url, canonical);
      const structure = [...html.matchAll(/<section class="([^"]+)"(?: id="([^"]+)")?/g)].map((match) => [match[1], match[2] || null]);
      if (homepageStructure === null) homepageStructure = structure;
      else assert.deepEqual(structure, homepageStructure, `${locale.code}: homepage structure`);
      assert.match(html, new RegExp(`<a class="brand" href="${(locale.code === DEFAULT_LOCALE ? "/" : `/${locale.code}/`).replaceAll("/", "\\/")}"`));

      for (const page of PUBLIC_DOC_PAGES) {
        const urlPath = publicDocPath(locale.code, page.id);
        const documentHtml = await readFile(outputHtmlPath(outputDirectory, urlPath), "utf8");
        const documentCanonical = `https://betterworkflows.dev${urlPath}`;
        assert.match(documentHtml, new RegExp(`<html lang="${locale.code}"`), `${locale.code}/${page.id}`);
        assert.match(documentHtml, new RegExp(`<link rel="canonical" href="${documentCanonical.replaceAll("/", "\\/")}">`));
        assert.equal(occurrences(documentHtml, /<option\b/g), 41, `${locale.code}/${page.id}`);
        assert.equal(occurrences(documentHtml, /<link rel="alternate" hreflang=/g), 42, `${locale.code}/${page.id}`);
        assert.doesNotMatch(documentHtml, /class="doc-kicker"/);
        assert.match(documentHtml, new RegExp(`<iframe[^>]+src="\\/docs\\/reference\\/${page.reference.replaceAll("/", "\\/")}"`));
        assert.doesNotMatch(documentHtml, /__(?:SITE|I18N)_/);
        assert.doesNotMatch(documentHtml, /TechArticle/);
        const pageData = JSON.parse(documentHtml.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
        assert.equal(pageData["@type"], "WebPage");
        assert.equal(pageData.inLanguage, locale.code);
        assert.equal(pageData.url, documentCanonical);
        assert.equal(pageData.isBasedOn, `https://betterworkflows.dev/docs/reference/${page.reference}`);
        if (page.id === "evidence-cinema") assert.match(pageData.headline, /^Evidence Cinema \| Better Workflows$/);
      }
    }

    const manifest = JSON.parse(await readFile(path.join(outputDirectory, "locales.json"), "utf8"));
    const release = JSON.parse(await readFile(path.join(outputDirectory, "release.json"), "utf8"));
    assert.equal(manifest.count, 41);
    assert.equal(manifest.publicDocumentationPages, PUBLIC_DOC_PAGES.length);
    assert.equal(manifest.defaultLocale, DEFAULT_LOCALE);
    assert.equal(release.locales, 41);
    assert.equal(release.publicDocumentationPages, PUBLIC_DOC_PAGES.length);
    assert.equal(release.repository, repositoryUrl);
    assert.equal(release.sponsorUrl, sponsorUrl);
    assert.equal(release.sponsorMode, "one-time-only");
    const contentManifest = await readFile(path.join(outputDirectory, "manifest.sha256"), "utf8");
    assert.equal(createHash("sha256").update(contentManifest).digest("hex"), release.contentDigest);
    await execFileAsync("shasum", ["-a", "256", "--check", "manifest.sha256"], { cwd: outputDirectory });

    const sitemap = await readFile(path.join(outputDirectory, "sitemap.xml"), "utf8");
    const indexedPageCount = CONNECTORS_LOCALES.length * (1 + PUBLIC_DOC_PAGES.length);
    assert.match(sitemap, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
    assert.equal(occurrences(sitemap, /<url>/g), indexedPageCount);
    assert.equal(occurrences(sitemap, /<xhtml:link\b/g), indexedPageCount * 42);
    assert.ok(release.sourceModifiedAt && !Number.isNaN(Date.parse(release.sourceModifiedAt)));
    assert.equal(occurrences(sitemap, new RegExp(`<lastmod>${release.sourceModifiedAt.slice(0, 10)}<\\/lastmod>`, "g")), indexedPageCount);
    if (release.sourceModifiedAt.slice(0, 10) !== release.builtAt.slice(0, 10)) {
      assert.doesNotMatch(sitemap, new RegExp(`<lastmod>${release.builtAt.slice(0, 10)}<\\/lastmod>`));
    }

    for (const page of PUBLIC_DOC_PAGES) {
      const reference = await readFile(path.join(outputDirectory, "docs", "reference", page.reference), "utf8");
      assert.match(reference, /<meta name="robots" content="noindex,follow">/);
      assert.match(reference, new RegExp(`<link rel="canonical" href="https:\/\/betterworkflows\\.dev${publicDocPath(DEFAULT_LOCALE, page.id).replaceAll("/", "\\/")}">`));
      const localeSelector = reference.match(/<select aria-label="BCP 47"[^>]*>([\s\S]*?)<\/select>/);
      assert.ok(localeSelector, page.id);
      assert.equal(occurrences(localeSelector[1], /<option\b/g), 42, page.id);
      assert.equal(occurrences(localeSelector[1], / selected\b/g), 1, page.id);
      assert.match(localeSelector[1], /^<option value="" selected disabled>—<\/option>/);
      assert.match(reference, /window\.top\.location\.assign\(prefix\+route\+target\.hash\)/);
      assert.match(reference, /window\.addEventListener\("hashchange",syncTopHash\)/);
      assert.match(reference, /window\.open\(target\.href,"_blank","noopener,noreferrer"\)/);
      if (page.id === "guide") {
        const navigation = referenceNavigationHarness(reference);
        assert.deepEqual(navigation.click("#replay"), { prevented: true, assigned: null, opened: null, topHash: "#replay" });
        assert.deepEqual(navigation.click("/docs/reference/preview.html#flow"), { prevented: true, assigned: "/ja/docs/quick/#flow", opened: null, topHash: "#replay" });
        assert.deepEqual(navigation.click("/plugins/better-workflows/README.md"), { prevented: true, assigned: null, opened: ["https://betterworkflows.dev/plugins/better-workflows/README.md", "_blank", "noopener,noreferrer"], topHash: "#replay" });
        assert.deepEqual(navigation.click("https://github.com/stephen-taipei/better-workflows"), { prevented: true, assigned: null, opened: ["https://github.com/stephen-taipei/better-workflows", "_blank", "noopener,noreferrer"], topHash: "#replay" });
        assert.equal(navigation.syncFrameHash("#architecture"), "#architecture");
      }
    }

    const localizedDocTemplate = await readFile(path.join(repoRoot, "scripts", "templates", "localized-doc-page.html"), "utf8");
    assert.match(localizedDocTemplate, /41 · BCP 47/);
    assert.doesNotMatch(localizedDocTemplate, /41 · __I18N_LANGUAGE__/);

    const notFound = await readFile(path.join(outputDirectory, "404.html"), "utf8");
    assert.doesNotMatch(notFound, /NOT FOUND|這個 route 不存在/);
    assert.doesNotMatch(notFound, /__(?:SITE|I18N)_/);
    assert.equal(occurrences(notFound, /<option\b/g), 41);
    const notFoundEditions = JSON.parse(notFound.match(/<script type="application\/json" id="not-found-locales">([^<]+)<\/script>/)[1]);
    assert.deepEqual(Object.keys(notFoundEditions), CONNECTORS_LOCALES);
    assert.equal(notFoundEditions.ar.dir, "rtl");
    assert.equal(notFoundEditions.ar.home, "/ar/");
    assert.equal(notFoundEditions.ar.docs, "/ar/docs/");
    assert.equal(notFoundEditions[DEFAULT_LOCALE].home, "/");
    assert.match(await readFile(path.join(outputDirectory, "site.js"), "utf8"), /syncReferenceHash/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("localized templates keep general interface prose in the locale catalog", async () => {
  const templates = await Promise.all([
    "scripts/templates/localized-homepage.html",
    "scripts/templates/localized-doc-page.html"
  ].map((relativePath) => readFile(path.join(repoRoot, relativePath), "utf8")));
  const source = templates.join("\n");
  for (const phrase of ["THE CONTROL PLANE", "GOAL-FIRST", "CURRENT EVIDENCE", "FAIL-CLOSED", "Source binding", "Provider reconciliation", "Known terminal state"]) {
    assert.doesNotMatch(source, new RegExp(phrase, "i"), phrase);
  }
  assert.doesNotMatch(source, /__SITE_PAGE_LABEL__/);
  assert.doesNotMatch(source, /class="doc-kicker"/);
  assert.ok(PUBLIC_DOC_PAGES.every((page) => !("label" in page)));
});
