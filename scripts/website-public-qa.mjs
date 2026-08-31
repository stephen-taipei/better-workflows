#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, digestObject, safeJoin } from "../plugins/better-workflows/scripts/lib/core.mjs";
import { loadHostSupportRegistry } from "../plugins/better-workflows/scripts/lib/hosts.mjs";
import { DEFAULT_LOCALE, locales } from "./website-locales.mjs";

const ORIGIN = "https://betterworkflows.dev";
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function required(name, pattern = null) {
  const value = String(process.env[name] ?? "").trim();
  if (!value || (pattern && !pattern.test(value))) throw new Error(`Missing or invalid ${name}`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function fetchExact(url, expectedType) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: { "cache-control": "no-cache", pragma: "no-cache" }
    });
    if (response.status !== 200) throw new Error(`${url} returned ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes(expectedType)) throw new Error(`${url} returned unexpected content type: ${contentType}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

const sourceRevision = required("SBW_RELEASE_REVISION", SHA40);
const stateRoot = path.resolve(required("SBW_STATE_ROOT"));
const versionManifest = JSON.parse(await readFile(path.resolve("plugins/better-workflows/config/version-manifest-v1.json"), "utf8"));
const registry = await loadHostSupportRegistry();
const registryDigest = digestObject(registry);
const cacheBust = `sbw_revision=${sourceRevision}`;
const releaseBuffer = await fetchExact(`${ORIGIN}/release.json?${cacheBust}`, "application/json");
const release = JSON.parse(releaseBuffer.toString("utf8"));
if (release.version !== versionManifest.version || release.revision !== sourceRevision) throw new Error("Public release version or revision mismatch");
if (release.locales !== 41 || release.defaultLocale !== DEFAULT_LOCALE) throw new Error("Public locale receipt mismatch");
if (release.hostRegistryId !== registry.id || release.hostRegistryDigest !== registryDigest) throw new Error("Public host registry mismatch");
if (!SHA256.test(release.contentDigest)) throw new Error("Public content digest is invalid");

const manifestBuffer = await fetchExact(`${ORIGIN}/manifest.sha256?${cacheBust}`, "text/plain");
if (sha256(manifestBuffer) !== release.contentDigest) throw new Error("Public manifest digest does not match release.json");
const manifestEntries = new Map();
for (const line of manifestBuffer.toString("utf8").trim().split("\n")) {
  const match = line.match(/^([a-f0-9]{64})  ([^\0]+)$/);
  if (!match || manifestEntries.has(match[2])) throw new Error("Public manifest is malformed or duplicated");
  manifestEntries.set(match[2], match[1]);
}

const localeReceipts = [];
for (let offset = 0; offset < locales.length; offset += 6) {
  const batch = locales.slice(offset, offset + 6);
  localeReceipts.push(...await Promise.all(batch.map(async (locale) => {
    const relativePath = locale.code === DEFAULT_LOCALE ? "index.html" : `${locale.code}/index.html`;
    const publicPath = locale.code === DEFAULT_LOCALE ? "/" : `/${locale.code}/`;
    const body = await fetchExact(`${ORIGIN}${publicPath}?${cacheBust}`, "text/html");
    const html = body.toString("utf8");
    if (
      !html.includes(`<html lang="${locale.code}"`) ||
      !html.includes(`<link rel="canonical" href="${ORIGIN}${publicPath}">`)
    ) {
      throw new Error(`Locale identity mismatch: ${locale.code}`);
    }
    const hasPositioning = locale.code === DEFAULT_LOCALE
      ? html.includes("證據至上的 AI 工程 QA")
      : html.includes(escapeHtml(locale.messages.V4_POSITIONING));
    if (!hasPositioning || !html.includes("host-support-v1") && !html.includes("HOST-SUPPORT-V1")) {
      throw new Error(`Locale v4 content missing: ${locale.code}`);
    }
    const requiredLocalizedMessages = [
      locale.messages.V4_RISK_LEAD,
      locale.messages.V4_SUMMARY,
      locale.messages.V4_RECOMMENDED,
      locale.messages.V4_CLAIM_LIMIT,
      ...locale.messages.V4_AUTO_FLOW.split("|"),
      ...locale.messages.V4_BOUNDARIES.split("|")
    ];
    if (!requiredLocalizedMessages.every((message) => html.includes(escapeHtml(message)))) {
      throw new Error(`Locale v4 translation boundary missing: ${locale.code}`);
    }
    if (!html.includes("support-matrix") || !html.includes("capability-matrix") ||
        !html.includes("core-bridge") || !html.includes("macOS + Codex") ||
        !html.includes("Replay") || !html.includes(sourceRevision)) {
      throw new Error(`Locale support or revision content missing: ${locale.code}`);
    }
    const responseDigest = sha256(body);
    if (manifestEntries.get(relativePath) !== responseDigest) throw new Error(`Locale manifest mismatch: ${locale.code}`);
    return { locale: locale.code, path: publicPath, relativePath, responseDigest, result: "PASS" };
  })));
}

localeReceipts.sort((left, right) => left.locale.localeCompare(right.locale, "en"));
const payload = {
  schemaVersion: 1,
  kind: "WorkspaceWebsitePublicQaReceiptV1",
  sourceRevision,
  version: release.version,
  origin: ORIGIN,
  contentDigest: release.contentDigest,
  releaseReceiptDigest: sha256(releaseBuffer),
  hostRegistryDigest: registryDigest,
  locales: localeReceipts,
  result: localeReceipts.length === 41 && localeReceipts.every((item) => item.result === "PASS") ? "PASS" : "FAIL",
  authentication: {
    status: "awaiting-github-oidc-attestation",
    releaseEligible: false,
    requirement: "Stable release must attest this exact public-QA receipt before tag publication"
  }
};
if (payload.result !== "PASS") throw new Error("Public locale QA did not pass");
const receipt = { ...payload, receiptDigest: digestObject(payload) };
const outputPath = safeJoin(stateRoot, "release-gates", sourceRevision, "website-public-qa.json");
await atomicWriteJson(stateRoot, outputPath, receipt);
process.stdout.write(`${JSON.stringify({ ok: true, outputPath, receiptDigest: receipt.receiptDigest, locales: localeReceipts.length, sourceRevision }, null, 2)}\n`);
