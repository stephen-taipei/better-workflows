import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONNECTORS_LOCALES, DEFAULT_LOCALE, LOCALE_KEYS, SPONSOR_ONE_TIME_MARKERS, locales } from "../website-locales.mjs";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "../..");
const buildScript = path.join(repoRoot, "scripts", "build-website.mjs");
const repositoryUrl = "https://github.com/stephen-taipei/better-workflows";
const sponsorUrl = "https://ko-fi.com/betterworkflows";

function occurrences(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

test("locale catalog matches Connectors iOS and preserves key order", () => {
  assert.equal(locales.length, 41);
  assert.deepEqual(locales.map((locale) => locale.code), CONNECTORS_LOCALES);
  assert.equal(new Set(CONNECTORS_LOCALES).size, 41);
  for (const locale of locales) {
    assert.deepEqual(Object.keys(locale.messages), LOCALE_KEYS, locale.code);
    for (const key of LOCALE_KEYS) assert.ok(locale.messages[key].trim().length > 0, `${locale.code}.${key}`);
    assert.equal(locale.messages.V4_AUTO_FLOW.split("|").length, 5, `${locale.code}.V4_AUTO_FLOW`);
    assert.equal(locale.messages.V4_BOUNDARIES.split("|").length, 3, `${locale.code}.V4_BOUNDARIES`);
    assert.match(locale.messages.V4_RECOMMENDED, /macOS \+ Codex/, `${locale.code}.V4_RECOMMENDED`);
    assert.ok(locale.messages.V4_CLAIM_LIMIT.length >= 80, `${locale.code}.V4_CLAIM_LIMIT`);
  }
  assert.match(locales.find((locale) => locale.code === "zh-Hant-TW").messages.DESCRIPTION, /依風險.*專屬 worktree/);
  const englishPositioning = locales.find((locale) => locale.code === "en").messages.V4_POSITIONING;
  for (const locale of locales.filter((item) => item.code !== "en")) {
    assert.notEqual(locale.messages.V4_POSITIONING, englishPositioning, `${locale.code} must not fall back to English v4 copy`);
  }
  assert.doesNotMatch(JSON.stringify(locales.filter((locale) => locale.code.startsWith("zh-"))), /新鮮證據/);
  assert.equal(locales.find((locale) => locale.code === "ar").dir, "rtl");
  assert.equal(locales.find((locale) => locale.code === "he").dir, "rtl");
  assert.deepEqual(Object.keys(SPONSOR_ONE_TIME_MARKERS), CONNECTORS_LOCALES);
  for (const locale of locales) assert.ok(locale.messages.SPONSOR_BODY.includes(SPONSOR_ONE_TIME_MARKERS[locale.code]), `${locale.code}.SPONSOR_BODY one-time marker`);
  assert.match(locales.find((locale) => locale.code === "zh-Hant-TW").messages.SPONSOR_BODY, /單次贊助/);
});

test("build emits 41 crawlable locale editions and complete SEO metadata", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "better-workflows-seo-"));
  const outputDirectory = path.join(temporaryRoot, "website");
  try {
    await execFileAsync(process.execPath, [buildScript], {
      cwd: repoRoot,
      env: { ...process.env, SITE_OUTPUT_DIR: outputDirectory, SOURCE_DATE_EPOCH: "1787644800" }
    });

    const expectedHreflangs = new Set([...CONNECTORS_LOCALES, "x-default"]);
    for (const locale of locales) {
      const relativePath = locale.code === DEFAULT_LOCALE ? "index.html" : path.join(locale.code, "index.html");
      const html = await readFile(path.join(outputDirectory, relativePath), "utf8");
      const canonical = locale.code === DEFAULT_LOCALE ? "https://betterworkflows.dev/" : `https://betterworkflows.dev/${locale.code}/`;
      assert.match(html, new RegExp(`<html lang="${locale.code}"`), locale.code);
      assert.match(html, new RegExp(`<link rel="canonical" href="${canonical.replaceAll("/", "\\/")}">`), locale.code);
      assert.match(html, /<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">/);
      assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
      assert.match(html, /<meta property="og:image:alt"/);
      assert.match(html, new RegExp(repositoryUrl.replaceAll("/", "\\/")));
      assert.match(html, new RegExp(sponsorUrl.replaceAll("/", "\\/")));
      assert.match(html, /id="sponsor"/);
      assert.match(html, /id="v4-overview"/);
      assert.match(html, /id="host-support"/);
      assert.match(html, /class="support-matrix"/);
      assert.match(html, /macOS \+ Codex/);
      assert.match(html, /Replay/);
      assert.ok(
        html.includes(escapeHtml(locale.messages.V4_CLAIM_LIMIT)),
        `${locale.code}.V4_CLAIM_LIMIT must be rendered in its localized form`
      );
      assert.equal(occurrences(html, /class="auto-flow-list"/g), 1, locale.code);
      assert.match(html, /\/styles\.css\?v=[a-f0-9]{12}/);
      assert.match(html, /\/site\.js\?v=[a-f0-9]{12}/);
      assert.match(html, /better-workflows#get-your-first-result/);
      assert.equal(occurrences(html, /<h1\b/g), 1, locale.code);
      assert.equal(occurrences(html, /<option\b/g), 41, locale.code);
      assert.doesNotMatch(html, /__(?:SITE|I18N)_/);

      const hreflangs = new Set([...html.matchAll(/<link rel="alternate" hreflang="([^"]+)"/g)].map((match) => match[1]));
      assert.deepEqual(hreflangs, expectedHreflangs, locale.code);
      const jsonLdMatch = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/);
      assert.ok(jsonLdMatch, locale.code);
      const jsonLd = JSON.parse(jsonLdMatch[1]);
      const source = jsonLd["@graph"].find((item) => item["@type"] === "SoftwareSourceCode");
      assert.equal(source.codeRepository, repositoryUrl);
      assert.equal(source.url, canonical);
      assert.deepEqual(source.runtimePlatform, ["Codex", "Claude Code", "Gemini CLI", "Qwen Code"]);
    }

    const manifest = JSON.parse(await readFile(path.join(outputDirectory, "locales.json"), "utf8"));
    const release = JSON.parse(await readFile(path.join(outputDirectory, "release.json"), "utf8"));
    assert.equal(manifest.count, 41);
    assert.equal(manifest.defaultLocale, DEFAULT_LOCALE);
    assert.equal(release.locales, 41);
    assert.equal(release.repository, repositoryUrl);
    assert.equal(release.sponsorUrl, sponsorUrl);
    assert.equal(release.sponsorMode, "one-time-only");
    assert.equal(release.hostRegistryId, "host-support-v1");
    assert.match(release.hostRegistryDigest, /^[a-f0-9]{64}$/);
    assert.match(release.revision, /^[a-f0-9]{40}$/);
    const contentManifest = await readFile(path.join(outputDirectory, "manifest.sha256"), "utf8");
    assert.equal(createHash("sha256").update(contentManifest).digest("hex"), release.contentDigest);
    await execFileAsync("shasum", ["-a", "256", "--check", "manifest.sha256"], { cwd: outputDirectory });
    assert.match(release.assetVersion, /^[a-f0-9]{12}$/);
    assert.match(release.contentDigest, /^[a-f0-9]{64}$/);

    const sitemap = await readFile(path.join(outputDirectory, "sitemap.xml"), "utf8");
    assert.match(sitemap, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
    assert.equal(occurrences(sitemap, /<url>/g), 46);
    assert.equal(occurrences(sitemap, /<xhtml:link\b/g), 41 * 42);
    for (const locale of locales) {
      const canonical = locale.code === DEFAULT_LOCALE ? "https://betterworkflows.dev/" : `https://betterworkflows.dev/${locale.code}/`;
      assert.match(sitemap, new RegExp(`<loc>${canonical.replaceAll("/", "\\/")}</loc>`), locale.code);
    }

    for (const [relativePath, canonical] of [
      ["docs/index.html", "https://betterworkflows.dev/docs/"],
      ["docs/preview.html", "https://betterworkflows.dev/docs/preview.html"],
      ["docs/use-cases/index.html", "https://betterworkflows.dev/docs/use-cases/"],
      ["docs/use-cases/preview.html", "https://betterworkflows.dev/docs/use-cases/preview.html"],
      ["docs/evidence-cinema/index.html", "https://betterworkflows.dev/docs/evidence-cinema/"]
    ]) {
      const html = await readFile(path.join(outputDirectory, relativePath), "utf8");
      assert.match(html, new RegExp(`<link rel="canonical" href="${canonical.replaceAll("/", "\\/")}">`));
      assert.match(html, /<script type="application\/ld\+json">/);
      assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
      assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
