import { createHash } from "node:crypto";
import path from "node:path";
import { loadInteractiveDocumentPages } from "./interactive-document-build.mjs";
import { PUBLIC_DOC_PAGES, publicDocPath } from "./public-docs.mjs";
import { PUBLIC_LOCALE_IDS } from "./website-locales.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (body) => createHash("sha256").update(body).digest("hex");

// Use the same complete body renderers as build-website, not the obsolete
// iframe portal. Finish this source preflight before any public request.
export async function loadPublicDocumentationExpectations(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) {
    throw new TypeError("repositoryRoot must be an absolute path");
  }
  const documents = await loadInteractiveDocumentPages(repositoryRoot);
  const pageIds = PUBLIC_DOC_PAGES.map(({ id }) => id);
  if (!(documents instanceof Map) || JSON.stringify([...documents.keys()]) !== JSON.stringify(pageIds)) {
    throw new Error("Public documentation requires the exact five-document inventory");
  }
  const expectations = PUBLIC_LOCALE_IDS.flatMap((locale) => PUBLIC_DOC_PAGES.map(({ id: page }) => {
    const body = documents.get(page).pages.get(locale);
    if (typeof body !== "string" || !body) throw new Error(`Missing native documentation body: ${locale}/${page}`);
    const publicPath = publicDocPath(locale, page);
    return Object.freeze({
      locale,
      page,
      path: publicPath,
      relativePath: `${publicPath.slice(1)}index.html`,
      body,
      expectedBodySha256: sha256(body)
    });
  }));
  const expectedRoutes = PUBLIC_LOCALE_IDS.length * PUBLIC_DOC_PAGES.length;
  if (pageIds.length !== 5 || expectations.length !== expectedRoutes ||
      new Set(expectations.map((item) => item.path)).size !== expectedRoutes ||
      new Set(expectations.map((item) => item.relativePath)).size !== expectedRoutes) {
    throw new Error("Public documentation requires every RC1 locale-document route exactly once");
  }
  return Object.freeze(expectations);
}

// A server-provided manifest alone cannot prove that the deployed page matches
// the checked-out source. Require raw-byte equality with both bindings.
export function verifyPublicDocumentationResponse(expected, body, manifestEntries) {
  if (!expected || !SHA256.test(expected.expectedBodySha256) ||
      !PUBLIC_LOCALE_IDS.includes(expected.locale) || !PUBLIC_DOC_PAGES.some(({ id }) => id === expected.page) ||
      expected.path !== publicDocPath(expected.locale, expected.page) ||
      expected.relativePath !== `${expected.path.slice(1)}index.html`) {
    throw new TypeError("Invalid public documentation expectation or path binding");
  }
  if (!(manifestEntries instanceof Map)) throw new TypeError("manifestEntries must be a Map");
  if (typeof expected.body !== "string" || sha256(expected.body) !== expected.expectedBodySha256) {
    throw new Error(`Expected rendered body digest mismatch: ${expected.locale}/${expected.page}`);
  }
  const responseDigest = sha256(body);
  if (responseDigest !== expected.expectedBodySha256) {
    throw new Error(`Public documentation body digest mismatch: ${expected.locale}/${expected.page}`);
  }
  if (manifestEntries.get(expected.relativePath) !== responseDigest) {
    throw new Error(`Public documentation manifest digest mismatch at ${expected.relativePath}`);
  }
  return {
    locale: expected.locale,
    page: expected.page,
    path: expected.path,
    relativePath: expected.relativePath,
    responseDigest,
    result: "PASS"
  };
}
