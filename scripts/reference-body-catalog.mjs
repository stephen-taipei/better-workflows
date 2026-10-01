import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { CONNECTORS_LOCALES } from "./website-locales.mjs";
import { validatePolicyText } from "./policy-source.mjs";

const catalogKeys = ["schemaVersion", "id", "source", "sourceSha256", "locale", "status", "texts", "diagramLabels"].sort();
const fixedDiagramIdentifiers = new Set(["TaskContract", "AutoRiskAssessmentV1"]);

// A catalog translates the complete ordered source, not a bag of generic UI
// messages. Presence proves a source-bound translation draft, not independent
// linguistic review, publication, or permission to change indexability.
export function validateReferenceBodyCatalog(source, code, catalog) {
  const context = `${code}/${source.id}`;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog) ||
      Object.keys(catalog).sort().join() !== catalogKeys.join() ||
      catalog.schemaVersion !== 1 || catalog.id !== source.id ||
      catalog.source !== source.source || catalog.sourceSha256 !== source.sha256 ||
      catalog.locale !== code || code === "en" || !CONNECTORS_LOCALES.includes(code) ||
      catalog.status !== "translated-pending-review") {
    throw new Error(`Reference body catalog binding or schema drift: ${context}`);
  }
  if (!Array.isArray(catalog.texts) || catalog.texts.length !== source.texts.length) {
    throw new Error(`Incomplete reference body catalog: ${context}`);
  }
  catalog.texts.forEach((text, index) => {
    validatePolicyText(source.texts[index], text, `${context}/${index}`);
    if (text === source.texts[index]) throw new Error(`English reference body fallback: ${context}/${index}`);
  });
  if (new Set(catalog.texts).size !== catalog.texts.length) throw new Error(`Duplicated reference body paragraph: ${context}`);
  const labels = catalog.diagramLabels;
  const expected = [...new Set(source.blocks.filter((block) => block.type === "code" && block.source.startsWith("```mermaid\n"))
    .flatMap((block) => [...block.source.matchAll(/"([^"]+)"/g)].map((match) => match[1])))].sort();
  if (!labels || typeof labels !== "object" || Array.isArray(labels) || Object.keys(labels).sort().join("\n") !== expected.join("\n")) {
    throw new Error(`Reference diagram label coverage drift: ${context}`);
  }
  for (const label of expected) {
    const translation = labels[label];
    if (typeof translation !== "string" || !translation.trim() || /["\r\n<>\u202a-\u202e\u2066-\u2069]/u.test(translation) ||
        (fixedDiagramIdentifiers.has(label) ? translation !== label : translation === label)) {
      throw new Error(`Invalid reference diagram translation: ${context}/${label}`);
    }
  }
  return structuredClone(catalog);
}

export async function loadReferenceBodyTranslations(root, source, { includePending = true } = {}) {
  // RC1 serves only accepted bilingual source. Pending draft bodies remain in
  // the private catalog and are not loaded into the public site projection.
  if (!includePending) return { ...source, bodyTranslations: {} };
  const directory = path.join(root, "docs/translations/reference-bodies", source.id);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { ...source, bodyTranslations: {} }; throw error; }
  const bodyTranslations = {};
  for (const entry of entries) {
    const code = entry.name.replace(/\.json$/, "");
    if (!entry.isFile() || entry.name !== `${code}.json` || code === "en" || !CONNECTORS_LOCALES.includes(code)) {
      throw new Error(`Unexpected reference body catalog: ${source.id}/${entry.name}`);
    }
    const catalog = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
    bodyTranslations[code] = validateReferenceBodyCatalog(source, code, catalog);
  }
  return { ...source, bodyTranslations };
}

export function referenceBodyCoverage(source, code) {
  if (code === "en") return { status: "canonical-source", translated: false, semanticReview: "not-applicable" };
  if (source.bodyTranslations?.[code]) return { status: "translated-pending-review", translated: true, semanticReview: "pending" };
  return { status: "canonical-english-body", translated: false, semanticReview: "not-established" };
}
