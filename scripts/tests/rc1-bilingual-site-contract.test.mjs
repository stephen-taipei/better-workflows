import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONNECTORS_LOCALES,
  DEFAULT_LOCALE,
  PUBLIC_RC1_LOCALE_IDS,
  locales,
  publicRc1Locales
} from "../website-locales.mjs";
import {
  EVIDENCE_CINEMA_TITLES,
  PUBLIC_DOC_PAGES,
  homepagePath,
  publicDocPath
} from "../public-docs.mjs";
import { LOCALE_OVERVIEW_LABELS, REFERENCE_CONTENT_NOTICES } from "../reference-copy.mjs";
import { v4ReferenceHeadingEntries } from "../reference-v4-headings.mjs";
import { loadArchitectureSource, architectureCatalog } from "../architecture-source.mjs";
import { loadSecurityGuideSource, securityCatalog } from "../security-source.mjs";
import { loadCliReferenceSource, cliReferenceCatalog } from "../cli-reference-source.mjs";
import { loadInteractiveDocumentPages } from "../interactive-document-build.mjs";
import { loadPublicTexts } from "../localized-public-text.mjs";
import { isIndexablePolicy } from "../localized-policies.mjs";
import { supportPath } from "../localized-support.mjs";
import { publicTextPath } from "../policy-routes.mjs";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "../..");
const buildScript = path.join(repoRoot, "scripts", "build-website.mjs");
const canonicalOrigin = "https://betterworkflows.dev";
const expectedLocaleIds = ["en", "zh-Hant", "zh-Hant-TW", "zh-Hant-HK", "zh-Hans", "vi", "uk", "tr", "th", "sv", "sk", "ru", "ro", "pt", "pt-BR", "pl", "nl", "nb", "my", "ms", "lo", "ko", "km", "ja", "it", "id", "hu", "hr", "hi", "he", "fr", "fil", "fi", "es", "es-MX", "el", "de", "da", "cs", "ca", "ar"];
const translatedLocaleIds = expectedLocaleIds.filter((code) => code !== "en");
const expectedDocIds = ["guide", "quick", "use-cases", "use-cases-quick", "evidence-cinema"];

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function outputFile(outputDirectory, route) {
  const relative = route.startsWith("/") ? route.slice(1) : route;
  return route.endsWith("/")
    ? path.join(outputDirectory, relative, "index.html")
    : path.join(outputDirectory, relative);
}

function alternateRows(html) {
  return [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)]
    .map(([, language, href]) => [language, href]);
}

function localeNavigationRows(html, attribute) {
  const expression = new RegExp(attribute + '="([^"]+)"[^>]+href="([^"]+)"', "g");
  return [...html.matchAll(expression)].map(([, code, href]) => [code, href]);
}

function robotsContent(html) {
  return html.match(/<meta name="robots" content="([^"]+)">/)?.[1] ?? null;
}

async function listFiles(directory, current = directory) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(directory, entryPath));
    else if (entry.isFile()) result.push(path.relative(directory, entryPath).split(path.sep).join("/"));
    else assert.fail("Website artifact contains a non-file entry: " + path.relative(directory, entryPath));
  }
  return result;
}

async function assertPageAlternates(html, routeForLocale, label) {
  const expected = [
    ...expectedLocaleIds.map((code) => [code, canonicalOrigin + routeForLocale(code)]),
    ["x-default", canonicalOrigin + routeForLocale(DEFAULT_LOCALE)]
  ];
  assert.deepEqual(alternateRows(html), expected, label + ": exact reciprocal hreflang set");
}

test("Public website exposes the exact 41-locale route, navigation, and content contract", async () => {
  assert.deepEqual(CONNECTORS_LOCALES, expectedLocaleIds);
  assert.deepEqual(PUBLIC_RC1_LOCALE_IDS, expectedLocaleIds);
  assert.deepEqual(locales.map(({ code }) => code), expectedLocaleIds);
  assert.deepEqual(publicRc1Locales.map(({ code }) => code), expectedLocaleIds);
  assert.deepEqual(PUBLIC_DOC_PAGES.map(({ id }) => id), expectedDocIds);
  assert.deepEqual(Object.keys(EVIDENCE_CINEMA_TITLES).sort(), [...expectedLocaleIds].sort());
  assert.deepEqual(Object.keys(REFERENCE_CONTENT_NOTICES), expectedLocaleIds);
  assert.deepEqual(Object.keys(LOCALE_OVERVIEW_LABELS), translatedLocaleIds);
  for (const code of expectedLocaleIds) assert.equal(v4ReferenceHeadingEntries(code).length, 6);

  const privateReferenceLoaders = [
    [loadArchitectureSource, architectureCatalog],
    [loadSecurityGuideSource, securityCatalog],
    [loadCliReferenceSource, cliReferenceCatalog]
  ];
  for (const [load, catalog] of privateReferenceLoaders) {
    const source = await load(repoRoot);
    assert.deepEqual(Object.keys(source.bodyTranslations), [],
      source.id + ": reference bodies stay canonical English in the public source");
    assert.deepEqual(Object.keys(catalog(source).locales), translatedLocaleIds,
      source.id + ": every non-English locale has its heading/copy map");
  }
  const publicTexts = await loadPublicTexts(repoRoot);
  for (const document of publicTexts) {
    assert.deepEqual(Object.keys(document.translations), expectedLocaleIds,
      document.id + ": public text translations cover every public locale");
  }

  const builderSource = await readFile(buildScript, "utf8");
  const indexableDocMatch = builderSource.match(
    /const indexableDocPages = PUBLIC_DOC_PAGES\.filter\(\(page\) => page\.id === "([^"]+)"\);/
  );
  assert.ok(indexableDocMatch, "update the RC1 site contract when build-website changes its explicit indexable-document list");
  const indexableDocIds = [indexableDocMatch[1]];
  const indexableDocs = PUBLIC_DOC_PAGES.filter(({ id }) => indexableDocIds.includes(id));

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bw-rc1-site-contract-"));
  const outputDirectory = path.join(temporaryRoot, "website");
  try {
    await execFileAsync(process.execPath, [buildScript], {
      cwd: repoRoot,
      env: { ...process.env, SITE_OUTPUT_DIR: outputDirectory, SOURCE_DATE_EPOCH: "1787644800" },
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    });

    const release = JSON.parse(await readFile(path.join(outputDirectory, "release.json"), "utf8"));
    const localeManifest = JSON.parse(await readFile(path.join(outputDirectory, "locales.json"), "utf8"));
    const coverage = JSON.parse(await readFile(path.join(outputDirectory, "translation-coverage.json"), "utf8"));
    assert.equal(release.locales, expectedLocaleIds.length);
    assert.equal(release.defaultLocale, DEFAULT_LOCALE);
    assert.equal(release.publicDocumentationPages, expectedDocIds.length);
    assert.equal(release.localizedReferencePages, expectedLocaleIds.length * expectedDocIds.length);
    assert.deepEqual(localeManifest.locales.map(({ code }) => code), expectedLocaleIds);
    assert.equal(localeManifest.count, expectedLocaleIds.length);
    for (const entry of localeManifest.locales) {
      assert.deepEqual(Object.keys(entry.docs), expectedDocIds, entry.code + ": exact five-document route inventory");
      assert.deepEqual(Object.values(entry.docs),
        expectedDocIds.map((id) => canonicalOrigin + publicDocPath(entry.code, id)),
        entry.code + ": all five routes bind to this locale");
    }
    assert.deepEqual(coverage.locales, expectedLocaleIds);
    assert.equal(coverage.fullContentLocalizationComplete, false);

    const completeDocuments = await loadInteractiveDocumentPages(repoRoot);
    const pagePaths = new Map();
    for (const locale of publicRc1Locales) {
      const homeRoute = homepagePath(locale.code);
      const home = await readFile(outputFile(outputDirectory, homeRoute), "utf8");
      pagePaths.set(homeRoute, home);
      assert.match(home, new RegExp('<html lang="' + locale.code + '"'));
      assert.match(home, new RegExp('<link rel="canonical" href="' +
        (canonicalOrigin + homeRoute).replaceAll("/", "\\/") + '">'));
      assert.match(home, /<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">/);
      assertPageAlternates(home, homepagePath, locale.code + " homepage");

      for (const key of [
        "TITLE", "DESCRIPTION", "V4_CLAIM_LIMIT"
      ]) {
        assert.ok(home.includes(escapeHtml(locale.messages[key])), locale.code + "." + key + " must be rendered");
      }
      for (const value of Object.values(locale.v5Product)) {
        assert.ok(home.includes(escapeHtml(value)), locale.code + ": complete localized V5 product copy");
      }
      const flow = home.match(/<ol class="auto-flow-list">([\s\S]*?)<\/ol>/)?.[1];
      assert.ok(flow, locale.code + ": localized Auto flow");
      assert.deepEqual([...flow.matchAll(/<li>(.*?)<\/li>/g)].map(([, item]) => item),
        locale.messages.V4_AUTO_FLOW.split("|").map(escapeHtml), locale.code + ": no fallback in ordered Auto flow");
      assert.deepEqual(localeNavigationRows(home, "data-locale-link").map(([code]) => code), expectedLocaleIds);
      assert.deepEqual(localeNavigationRows(home, "data-locale-link").map(([, href]) => href),
        expectedLocaleIds.map(homepagePath), locale.code + ": homepage locale links");
      assert.deepEqual(localeNavigationRows(home, "data-locale-button").map(([code]) => code), expectedLocaleIds);
      assert.deepEqual(localeNavigationRows(home, "data-locale-button").map(([, href]) => href),
        expectedLocaleIds.map(homepagePath), locale.code + ": homepage locale buttons");
      assert.doesNotMatch(home, /__(?:SITE|I18N)_/);

      for (const page of PUBLIC_DOC_PAGES) {
        const route = publicDocPath(locale.code, page.id);
        const html = await readFile(outputFile(outputDirectory, route), "utf8");
        pagePaths.set(route, html);
        assert.equal(html, completeDocuments.get(page.id).pages.get(locale.code),
          locale.code + "/" + page.id + ": rendered body is source-bound without fallback");
        assert.match(html, new RegExp('<html lang="' + locale.code + '"'));
        assert.match(html, new RegExp('<link rel="canonical" href="' +
          (canonicalOrigin + route).replaceAll("/", "\\/") + '">'));
        await assertPageAlternates(html, (code) => publicDocPath(code, page.id), locale.code + "/" + page.id);
        assert.doesNotMatch(html, /__(?:SITE|I18N)_|<iframe\b/);

        const controlAttribute = page.id === "evidence-cinema" ? "data-cinema-locale" : "data-auto-locale";
        const buttons = localeNavigationRows(html, controlAttribute);
        assert.deepEqual(buttons.map(([code]) => code), expectedLocaleIds, locale.code + "/" + page.id + ": exact locale nav");
        assert.deepEqual(buttons.map(([, href]) => href), expectedLocaleIds.map((code) => publicDocPath(code, page.id)),
          locale.code + "/" + page.id + ": exact locale routes");
      }
    }

    const englishHome = pagePaths.get(homepagePath("en"));
    const taiwanHome = pagePaths.get(homepagePath("zh-Hant-TW"));
    const englishLocale = locales.find(({ code }) => code === "en");
    const taiwanLocale = locales.find(({ code }) => code === "zh-Hant-TW");
    for (const key of ["TITLE", "DESCRIPTION"]) {
      assert.notEqual(englishLocale.messages[key], taiwanLocale.messages[key], key + ": source copy remains locale-specific");
      assert.ok(taiwanHome.includes(escapeHtml(taiwanLocale.messages[key])), "zh-Hant-TW." + key + ": localized copy is rendered");
      assert.ok(!taiwanHome.includes(escapeHtml(englishLocale.messages[key])), "zh-Hant-TW." + key + ": English fallback is absent");
    }

    assert.deepEqual(indexableDocIds, ["quick"],
      "the current source contract marks only the quick guide as an indexable public documentation page");
    for (const page of PUBLIC_DOC_PAGES) {
      const indexable = indexableDocs.some(({ id }) => id === page.id);
      for (const locale of publicRc1Locales) {
        const html = pagePaths.get(publicDocPath(locale.code, page.id));
        const robots = robotsContent(html);
        assert.equal(robots, indexable ? "index,follow" : "noindex,follow",
          locale.code + "/" + page.id + ": explicit document indexability");
      }
    }

    for (const policy of publicTexts) {
      for (const locale of publicRc1Locales) {
        const route = publicTextPath(locale.code, policy.id);
        const html = await readFile(outputFile(outputDirectory, route), "utf8");
        pagePaths.set(route, html);
        const expectedRobots = isIndexablePolicy(policy) ? "index,follow" : "noindex,follow";
        assert.equal(robotsContent(html), expectedRobots, locale.code + "/" + policy.id + ": policy indexability");
        if (isIndexablePolicy(policy)) {
          await assertPageAlternates(html, (code) => publicTextPath(code, policy.id), locale.code + "/" + policy.id);
        }
        assert.deepEqual(localeNavigationRows(html, "data-locale-button").map(([code]) => code), expectedLocaleIds,
          locale.code + "/" + policy.id + ": policy locale nav");
      }
    }
    for (const code of expectedLocaleIds) {
      const route = supportPath(code);
      const html = await readFile(outputFile(outputDirectory, route), "utf8");
      pagePaths.set(route, html);
      await assertPageAlternates(html, supportPath, code + " support");
      assert.deepEqual(localeNavigationRows(html, "data-locale-button").map(([locale]) => locale), expectedLocaleIds,
        code + " support: exact locale nav");
    }

    const referencePageDirectories = await readdir(path.join(outputDirectory, "docs", "reference"), { withFileTypes: true });
    const localeDirectoryPattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/;
    const referenceLocales = referencePageDirectories.filter((entry) => entry.isDirectory() && localeDirectoryPattern.test(entry.name))
      .map(({ name }) => name).sort();
    assert.deepEqual(referenceLocales, [...expectedLocaleIds].sort(),
      "legacy reference redirects are generated for every public locale");
    for (const page of PUBLIC_DOC_PAGES) {
      const defaultRedirect = path.posix.join("docs", "reference", page.reference);
      const html = await readFile(path.join(outputDirectory, defaultRedirect), "utf8");
      assert.equal(robotsContent(html), "noindex,follow", page.id + ": default reference redirect");
      assert.deepEqual(localeNavigationRows(html, "data-locale-button").map(([code]) => code), expectedLocaleIds);
      for (const locale of publicRc1Locales) {
        const localizedRedirect = path.posix.join("docs", "reference", locale.code, page.reference);
        const localizedHtml = await readFile(path.join(outputDirectory, localizedRedirect), "utf8");
        assert.equal(robotsContent(localizedHtml), "noindex,follow", locale.code + "/" + page.id + ": legacy reference redirect");
        assert.deepEqual(localeNavigationRows(localizedHtml, "data-locale-button").map(([code]) => code), expectedLocaleIds);
      }
    }

    const indexedPolicies = publicTexts.filter(isIndexablePolicy);
    const routeGroups = [
      expectedLocaleIds.map(homepagePath),
      ...indexableDocs.map((page) => expectedLocaleIds.map((code) => publicDocPath(code, page.id))),
      expectedLocaleIds.map(supportPath),
      ...indexedPolicies.map((policy) => expectedLocaleIds.map((code) => publicTextPath(code, policy.id)))
    ];
    const expectedSitemapPaths = routeGroups.flat().sort();
    const sitemap = await readFile(path.join(outputDirectory, "sitemap.xml"), "utf8");
    const sitemapEntries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([, entry]) => entry);
    const actualSitemapPaths = sitemapEntries.map((entry) =>
      entry.match(/<loc>https:\/\/betterworkflows\.dev([^<]+)<\/loc>/)?.[1]).sort();
    assert.deepEqual(actualSitemapPaths, expectedSitemapPaths, "sitemap has exactly the source-declared RC1 indexable routes");
    assert.equal(new Set(actualSitemapPaths).size, expectedSitemapPaths.length, "sitemap routes are unique");
    assert.match(sitemap, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
    const entriesByRoute = new Map(sitemapEntries.map((entry) => [
      entry.match(/<loc>https:\/\/betterworkflows\.dev([^<]+)<\/loc>/)?.[1], entry
    ]));
    for (const routeGroup of routeGroups) {
      for (const route of routeGroup) {
        const entry = entriesByRoute.get(route);
        assert.ok(entry, "sitemap entry exists for " + route);
        const links = [...entry.matchAll(/<xhtml:link\b[^>]*hreflang="([^"]+)"[^>]*href="([^"]+)"/g)]
          .map(([, language, href]) => [language, href]);
        const defaultIndex = expectedLocaleIds.indexOf(DEFAULT_LOCALE);
        const expected = [
          ...expectedLocaleIds.map((code, index) => [code, canonicalOrigin + routeGroup[index]]),
          ["x-default", canonicalOrigin + routeGroup[defaultIndex]]
        ];
        assert.deepEqual(links, expected, route + ": sitemap alternates are reciprocal and RC1-scoped");
      }
    }
    for (const page of PUBLIC_DOC_PAGES.filter((item) => !indexableDocs.some(({ id }) => id === item.id))) {
      for (const code of expectedLocaleIds) {
        assert.ok(!actualSitemapPaths.includes(publicDocPath(code, page.id)), code + "/" + page.id + ": draft excluded from sitemap");
      }
    }
    for (const policy of publicTexts.filter((item) => !isIndexablePolicy(item))) {
      for (const code of expectedLocaleIds) {
        assert.ok(!actualSitemapPaths.includes(publicTextPath(code, policy.id)),
          code + "/" + policy.id + ": canonical-English reference excluded from sitemap");
      }
    }

    const outputFiles = await listFiles(outputDirectory);
    assert.ok(!outputFiles.includes("scripts/private/website-locales-rc2.mjs"),
      "website artifact must not package the private RC2 locale catalog");
    assert.ok(!outputFiles.some((file) => file.startsWith("docs/translations/reference-bodies/")),
      "website artifact must not package deferred reference-body source");
    const rootLocalePrefixes = [...new Set(outputFiles
      .filter((file) => file.endsWith("/index.html"))
      .map((file) => file.split("/")[0])
      .filter((segment) => localeDirectoryPattern.test(segment)))].sort();
    assert.deepEqual(rootLocalePrefixes, translatedLocaleIds.filter((code) => code !== DEFAULT_LOCALE).concat("en").sort(),
      "every non-default locale has a prefixed public route; zh-Hant-TW is the default root");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

// The approved source-projection manifest is currently generated outside this
// repository. Keep this unresolved release gate visible until CI receives that
// manifest and verifies its exact exclude decisions; website packaging alone
// does not prove Git source projection exclusion.
