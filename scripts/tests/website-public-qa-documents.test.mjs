import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PUBLIC_DOC_PAGES, publicDocPath } from "../public-docs.mjs";
import { DEFAULT_LOCALE, PUBLIC_RC1_LOCALE_IDS, publicRc1Locales } from "../website-locales.mjs";
import {
  loadPublicDocumentationExpectations,
  verifyPublicDocumentationResponse
} from "../website-public-qa-documents.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "../..");
const pageIds = PUBLIC_DOC_PAGES.map(({ id }) => id);
const expectedLocalePageOrder = publicRc1Locales.flatMap(({ code }) => pageIds.map((page) => `${code}/${page}`));
const sha256 = (body) => createHash("sha256").update(body).digest("hex");

// The helper builds all native bodies once. Keeping the body beside its digest
// makes the verifier tests exercise the same current-render bytes without
// starting one render per assertion.
const expectations = await loadPublicDocumentationExpectations(repoRoot);

function nativeBody(expected) {
  assert.equal(typeof expected.body, "string", "expectation must expose its native rendered body fixture");
  return expected.body;
}

function manifestFor(expected, body = nativeBody(expected)) {
  return new Map([[expected.relativePath, sha256(body)]]);
}

test("public documentation expectations contain every RC1 locale-page body", () => {
  assert.ok(Array.isArray(expectations));
  assert.deepEqual(PUBLIC_RC1_LOCALE_IDS, ["en", "zh-Hant-TW"]);
  assert.equal(expectations.length, 10);
  assert.equal(expectations.length, PUBLIC_RC1_LOCALE_IDS.length * PUBLIC_DOC_PAGES.length);
  assert.deepEqual(expectations.map((item) => `${item.locale}/${item.page}`), expectedLocalePageOrder);
  assert.equal(new Set(expectations.map(({ path: route }) => route)).size, expectations.length);
  assert.equal(new Set(expectations.map(({ relativePath }) => relativePath)).size, expectations.length);
  assert.equal(new Set(expectations.map(({ locale }) => locale)).size, PUBLIC_RC1_LOCALE_IDS.length);
  for (const locale of PUBLIC_RC1_LOCALE_IDS) {
    const entries = expectations.filter((item) => item.locale === locale);
    assert.equal(entries.length, 5, `${locale}: exact five documentation pages`);
    assert.deepEqual(entries.map(({ page }) => page), pageIds, `${locale}: page order`);
    for (const entry of entries) {
      assert.equal(entry.path, publicDocPath(locale, entry.page));
      assert.equal(entry.relativePath, `${entry.path.slice(1)}index.html`);
      assert.match(entry.expectedBodySha256, /^[a-f0-9]{64}$/);
      assert.equal(entry.expectedBodySha256, sha256(nativeBody(entry)), `${locale}/${entry.page}: source digest`);
    }
  }
});

test("a current native-render page without the legacy iframe is accepted", () => {
  const expected = expectations.find(({ locale, page }) => locale === DEFAULT_LOCALE && page === "guide");
  assert.ok(expected);
  const body = nativeBody(expected);
  assert.doesNotMatch(body, /<iframe\b/i, "native documentation must not depend on a legacy iframe");
  assert.doesNotThrow(() => verifyPublicDocumentationResponse(expected, body, manifestFor(expected)));
});

test("a native-render Buffer is accepted and returns the exact six-field public receipt", () => {
  const expected = expectations.find(({ locale, page }) => locale === DEFAULT_LOCALE && page === "guide");
  assert.ok(expected);
  const body = nativeBody(expected);
  const receipt = verifyPublicDocumentationResponse(expected, Buffer.from(body, "utf8"), manifestFor(expected));
  assert.deepEqual(Object.keys(receipt), ["locale", "page", "path", "relativePath", "responseDigest", "result"]);
  assert.deepEqual(receipt, {
    locale: expected.locale,
    page: expected.page,
    path: expected.path,
    relativePath: expected.relativePath,
    responseDigest: expected.expectedBodySha256,
    result: "PASS"
  });
  assert.equal(Object.hasOwn(receipt, "body"), false);
  assert.equal(Object.hasOwn(receipt, "expectedBodySha256"), false);
});

test("wrong-locale, wrong-digest, and tampered bodies are rejected even with self-consistent manifests", () => {
  const expected = expectations.find(({ locale, page }) => locale === "en" && page === "evidence-cinema");
  const wrongLocale = expectations.find(({ locale, page }) => locale === DEFAULT_LOCALE && page === "evidence-cinema");
  assert.ok(expected && wrongLocale);
  const wrongLocaleBody = nativeBody(wrongLocale);
  assert.notEqual(sha256(wrongLocaleBody), expected.expectedBodySha256);
  assert.throws(
    () => verifyPublicDocumentationResponse(expected, wrongLocaleBody, manifestFor(expected, wrongLocaleBody)),
    /digest|body/i
  );

  const body = nativeBody(expected);
  const wrongDigest = { ...expected, expectedBodySha256: "0".repeat(64) };
  assert.throws(() => verifyPublicDocumentationResponse(wrongDigest, body, manifestFor(wrongDigest)), /digest|body/i);

  const tamperedBody = `${body}\n<!-- tampered -->`;
  assert.notEqual(sha256(tamperedBody), expected.expectedBodySha256);
  assert.throws(
    () => verifyPublicDocumentationResponse(expected, tamperedBody, manifestFor(expected, tamperedBody)),
    /digest|body/i
  );
});

test("legacy iframe is rejected", () => {
  const expected = expectations.find(({ locale, page }) => locale === "en" && page === "quick");
  assert.ok(expected);
  const body = nativeBody(expected);
  const legacyIframeBody = body.replace("</body>", '<iframe class="reference-frame" src="/docs/reference/en/preview.html"></iframe></body>');
  assert.notEqual(legacyIframeBody, body);
  assert.throws(
    () => verifyPublicDocumentationResponse(expected, legacyIframeBody, manifestFor(expected, legacyIframeBody)),
    /digest|body/i
  );
});

test("a missing manifest entry is rejected", () => {
  const expected = expectations.find(({ locale, page }) => locale === "en" && page === "quick");
  assert.ok(expected);
  const body = nativeBody(expected);
  assert.throws(() => verifyPublicDocumentationResponse(expected, body, new Map()), /manifest|path|digest/i);
});

test("a manifest entry at the exact path with the wrong digest is rejected", () => {
  const expected = expectations.find(({ locale, page }) => locale === "en" && page === "quick");
  assert.ok(expected);
  const body = nativeBody(expected);
  const wrongManifestDigest = expected.expectedBodySha256.replace(/^./, (digit) => digit === "0" ? "1" : "0");
  assert.notEqual(wrongManifestDigest, expected.expectedBodySha256);
  const manifest = new Map([[expected.relativePath, wrongManifestDigest]]);
  assert.throws(
    () => verifyPublicDocumentationResponse(expected, body, manifest),
    /manifest|digest/i
  );
});

test("production public QA observes source-bound documents before fetching", async () => {
  const qaSource = await readFile(path.join(repoRoot, "scripts", "website-public-qa.mjs"), "utf8");
  const observerSource = await readFile(path.join(repoRoot, "scripts", "website-public-qa-observer-v1.mjs"), "utf8");
  assert.match(qaSource, /observeWebsitePublicQaV1\(/);
  assert.match(observerSource, /website-public-qa-documents\.mjs/);
  assert.match(observerSource, /loadPublicDocumentationExpectations\(/);
  assert.match(observerSource, /verifyPublicDocumentationResponse\(/);
  assert.doesNotMatch(qaSource, /reference-frame|<iframe\b/i);
  assert.doesNotMatch(observerSource, /reference-frame|<iframe\b/i);
  const firstFetchExactInvocation = observerSource.indexOf("await fetchExact(");
  const documentationPreflight = observerSource.indexOf("await loadPublicDocumentationExpectations(");
  assert.ok(firstFetchExactInvocation >= 0, "production caller must retain its exact fetch gate");
  assert.ok(documentationPreflight >= 0 && documentationPreflight < firstFetchExactInvocation,
    "documentation source preflight must finish before the first public fetch");
  assert.match(observerSource, /release\.json/);
  assert.match(observerSource, /versionManifest\.version/);
  assert.match(observerSource, /loadHostSupportRegistry\(\)/);
  assert.match(observerSource, /release\.hostRegistry(?:Id|Digest)|registryDigest/);
  assert.match(observerSource, /publicPath.*index\.html|relativePath.*index\.html/s);
  assert.match(observerSource, /<html lang=/);
  assert.match(observerSource, /rel="canonical"/);
  assert.match(observerSource, /localeSurface\.localizedReferencePages !== expectedDocumentationRouteCodes\.length/);
  assert.match(observerSource, /JSON\.stringify\(deployedLocaleCodes\) !== JSON\.stringify\(expectedLocaleCodes\)/);
  assert.match(observerSource, /localeCodes,/);
  assert.match(observerSource, /JSON\.stringify\(localeReceipts\.map\(\(\{ locale \}\) => locale\)\)/);
  assert.match(observerSource, /JSON\.stringify\(documentationReceipts\.map/);
  assert.match(observerSource, /awaiting-github-oidc-attestation/);
});
