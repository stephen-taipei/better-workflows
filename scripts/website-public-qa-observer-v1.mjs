// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { digestObject } from "../plugins/better-workflows/scripts/lib/core.mjs";
import { loadHostSupportRegistry } from "../plugins/better-workflows/scripts/lib/hosts.mjs";
import { PUBLIC_DOC_PAGES } from "./public-docs.mjs";
import { loadPublicDocumentationExpectations, verifyPublicDocumentationResponse } from "./website-public-qa-documents.mjs";
import { DEFAULT_LOCALE, PUBLIC_LOCALE_IDS, publicLocales } from "./website-locales.mjs";

const ORIGIN = "https://betterworkflows.dev";
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function fetchExact(url, expectedType) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      cache: "no-store", redirect: "error", signal: controller.signal,
      headers: { "cache-control": "no-cache", pragma: "no-cache" }
    });
    if (response.status !== 200) throw new Error(`${url} returned ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes(expectedType)) throw new Error(`${url} returned unexpected content type: ${contentType}`);
    return Buffer.from(await response.arrayBuffer());
  } finally { clearTimeout(timer); }
}

// Side-effect-free module loading; network requests occur only when an installed
// qualification observer explicitly invokes this fixed-origin observer.
export async function observeWebsitePublicQaV1({ repositoryRoot, sourceRevision }) {
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot) ||
      path.resolve(repositoryRoot) !== repositoryRoot || !SHA40.test(sourceRevision ?? "")) {
    throw new TypeError("Website public QA requires the exact absolute source root and revision");
  }
  const documentationExpectations = await loadPublicDocumentationExpectations(repositoryRoot);
  const versionManifest = JSON.parse(await readFile(path.join(repositoryRoot, "plugins/better-workflows/config/version-manifest-v1.json"), "utf8"));
  const registry = await loadHostSupportRegistry();
  const registryDigest = digestObject(registry);
  const cacheBust = `sbw_revision=${sourceRevision}`;
  const releaseBuffer = await fetchExact(`${ORIGIN}/release.json?${cacheBust}`, "application/json");
  const release = JSON.parse(releaseBuffer.toString("utf8"));
  if (release.version !== versionManifest.version || release.revision !== sourceRevision) throw new Error("Public release version or revision mismatch");
  if (release.locales !== PUBLIC_LOCALE_IDS.length || release.defaultLocale !== DEFAULT_LOCALE) throw new Error("Public locale receipt mismatch");
  if (release.hostRegistryId !== registry.id || release.hostRegistryDigest !== registryDigest) throw new Error("Public host registry mismatch");
  if (!SHA256.test(release.contentDigest ?? "")) throw new Error("Public content digest is invalid");

  const manifestBuffer = await fetchExact(`${ORIGIN}/manifest.sha256?${cacheBust}`, "text/plain");
  if (sha256(manifestBuffer) !== release.contentDigest) throw new Error("Public manifest digest does not match release.json");
  const manifestEntries = new Map();
  for (const line of manifestBuffer.toString("utf8").trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  ([^\0]+)$/);
    if (!match || manifestEntries.has(match[2])) throw new Error("Public manifest is malformed or duplicated");
    manifestEntries.set(match[2], match[1]);
  }

  const expectedLocaleCodes = [...PUBLIC_LOCALE_IDS];
  const expectedDocumentationRouteCodes = expectedLocaleCodes.flatMap((locale) =>
    PUBLIC_DOC_PAGES.map(({ id }) => `${locale}/${id}`)
  ).sort((left, right) => left.localeCompare(right, "en"));
  const localeSurfaceBuffer = await fetchExact(`${ORIGIN}/locales.json?${cacheBust}`, "application/json");
  const localeSurface = JSON.parse(localeSurfaceBuffer.toString("utf8"));
  const deployedLocaleCodes = Array.isArray(localeSurface.locales)
    ? localeSurface.locales.map((locale) => locale?.code)
    : [];
  if (manifestEntries.get("locales.json") !== sha256(localeSurfaceBuffer)) throw new Error("Public locale surface manifest mismatch");
  if (localeSurface.count !== expectedLocaleCodes.length ||
      JSON.stringify(deployedLocaleCodes) !== JSON.stringify(expectedLocaleCodes) ||
      localeSurface.publicDocumentationPages !== PUBLIC_DOC_PAGES.length ||
      localeSurface.localizedReferencePages !== expectedDocumentationRouteCodes.length) {
    throw new Error("Public RC1 localeCodes or route denominator mismatch");
  }

  const localeReceipts = [];
  for (let offset = 0; offset < publicLocales.length; offset += 6) {
    const batch = publicLocales.slice(offset, offset + 6);
    localeReceipts.push(...await Promise.all(batch.map(async (locale) => {
      const relativePath = locale.code === DEFAULT_LOCALE ? "index.html" : `${locale.code}/index.html`;
      const publicPath = locale.code === DEFAULT_LOCALE ? "/" : `/${locale.code}/`;
      const body = await fetchExact(`${ORIGIN}${publicPath}?${cacheBust}`, "text/html");
      const html = body.toString("utf8");
      if (!html.includes(`<html lang="${locale.code}"`) || !html.includes(`<link rel="canonical" href="${ORIGIN}${publicPath}">`)) {
        throw new Error(`Locale identity mismatch: ${locale.code}`);
      }
      const hasPositioning = locale.code === DEFAULT_LOCALE ? html.includes("證據至上的 AI 工程 QA") :
        html.includes(escapeHtml(locale.messages.V4_POSITIONING));
      if (!hasPositioning || (!html.includes("host-support-v1") && !html.includes("HOST-SUPPORT-V1"))) throw new Error(`Locale v4 content missing: ${locale.code}`);
      const requiredLocalizedMessages = [locale.messages.V4_RISK_LEAD, locale.messages.V4_SUMMARY, locale.messages.V4_RECOMMENDED,
        locale.messages.V4_CLAIM_LIMIT, ...locale.messages.V4_AUTO_FLOW.split("|"), ...locale.messages.V4_BOUNDARIES.split("|")];
      if (!requiredLocalizedMessages.every((message) => html.includes(escapeHtml(message)))) throw new Error(`Locale v4 translation boundary missing: ${locale.code}`);
      if (!html.includes("support-matrix") || !html.includes("capability-matrix") || !html.includes("core-bridge") ||
          !html.includes("macOS + Codex") || !html.includes("Replay") || !html.includes(sourceRevision)) throw new Error(`Locale support or revision content missing: ${locale.code}`);
      const responseDigest = sha256(body);
      if (manifestEntries.get(relativePath) !== responseDigest) throw new Error(`Locale manifest mismatch: ${locale.code}`);
      return { locale: locale.code, path: publicPath, relativePath, responseDigest, result: "PASS" };
    })));
  }
  localeReceipts.sort((left, right) => left.locale.localeCompare(right.locale, "en"));
  if (JSON.stringify(localeReceipts.map(({ locale }) => locale)) !==
      JSON.stringify([...expectedLocaleCodes].sort((left, right) => left.localeCompare(right, "en")))) {
    throw new Error("Public RC1 locale receipts do not match localeCodes");
  }
  const documentationReceipts = [];
  const documentationBatchSize = 6 * PUBLIC_DOC_PAGES.length;
  for (let offset = 0; offset < documentationExpectations.length; offset += documentationBatchSize) {
    const batch = documentationExpectations.slice(offset, offset + documentationBatchSize);
    documentationReceipts.push(...await Promise.all(batch.map(async (expected) => {
      const body = await fetchExact(`${ORIGIN}${expected.path}?${cacheBust}`, "text/html");
      return verifyPublicDocumentationResponse(expected, body, manifestEntries);
    })));
  }
  documentationReceipts.sort((left, right) => `${left.locale}/${left.page}`.localeCompare(`${right.locale}/${right.page}`, "en"));
  if (JSON.stringify(documentationReceipts.map(({ locale, page }) => `${locale}/${page}`)) !==
      JSON.stringify(expectedDocumentationRouteCodes)) {
    throw new Error("Public RC1 documentation receipts do not match the route denominator");
  }
  const localeCodes = localeReceipts.map(({ locale }) => locale);
  const payload = {
    schemaVersion: 1, kind: "WorkspaceWebsitePublicQaReceiptV1", sourceRevision,
    version: release.version, origin: ORIGIN, contentDigest: release.contentDigest,
    releaseReceiptDigest: sha256(releaseBuffer), hostRegistryDigest: registryDigest,
    locales: localeReceipts, localeCodes, publicDocumentationPages: PUBLIC_DOC_PAGES.length,
    publicDocumentationRoutes: documentationReceipts,
    result: localeReceipts.every((item) => item.result === "PASS") &&
      documentationReceipts.length === expectedDocumentationRouteCodes.length && documentationReceipts.every((item) => item.result === "PASS") ? "PASS" : "FAIL",
    authentication: {
      status: "awaiting-github-oidc-attestation", releaseEligible: false,
      requirement: "Installed RC qualification must verify GitHub provenance for this exact public-QA receipt"
    }
  };
  if (payload.result !== "PASS") throw new Error("Public locale QA did not pass");
  return Object.freeze({ ...payload, receiptDigest: digestObject(payload) });
}
