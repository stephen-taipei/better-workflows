import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONNECTORS_LOCALES, locales } from "./website-locales.mjs";
import { localizeReferenceTexts } from "./reference-localization.mjs";
import { describePolicySource } from "./policy-source.mjs";
import { v4ReferenceHeadingEntries } from "./reference-v4-headings.mjs";
import { loadReferenceBodyTranslations } from "./reference-body-catalog.mjs";

export const SECURITY_GUIDE_SPEC = Object.freeze({
  id: "security-guide",
  kind: "guide",
  source: "docs/guide/security.md",
  sha256: "83e112d4b882e688df175ee925d4e4b91ce1bff1c5832eb645e9c297f482dce2",
  translationMode: "canonical-english-body",
  catalogDirectory: "public-docs",
  navigationPrefix: "| [Overview](../../README.md)"
});

const HEADINGS = Object.freeze({
  en: ["Security","Authority boundaries","Local state","External model transport","Threat-model boundary"],
  "zh-Hant-TW": ["安全性","權限邊界","本機狀態","外部模型傳輸","威脅模型邊界"]
});

const HEADING_KEYS = ["title", "authority", "local", "external", "threat"];

function headingSet(code) {
  const values = HEADINGS[code];
  if (!values) throw new Error(`Security heading locale missing: ${code}`);
  return Object.fromEntries(HEADING_KEYS.map((key, index) => [key, values[index]]));
}

export async function loadSecurityGuideSource(root) {
  const source = describePolicySource(SECURITY_GUIDE_SPEC, await readFile(path.join(root, SECURITY_GUIDE_SPEC.source), "utf8"));
  return loadReferenceBodyTranslations(root, source, { includePending: false });
}

export function securityTexts(source, code) {
  if (!CONNECTORS_LOCALES.includes(code)) throw new Error(`Unsupported security guide locale: ${code}`);
  if (code === "en") return source.texts;
  const locale = locales.find((entry) => entry.code === code);
  const headings = headingSet(code);
  const headingMap = new Map([
    ["# Security", headings.title],
    ["## Authority boundaries", headings.authority],
    ["## Local state", headings.local],
    ["## External model transport", headings.external],
    ["## Threat-model boundary", headings.threat],
    ...v4ReferenceHeadingEntries(code)
  ]);
  return localizeReferenceTexts(source, code, locale.messages, { headingMap });
}

export function securityCatalog(source) {
  return {
    sourceDigests: { "security-guide": source.sha256 },
    locales: Object.fromEntries(CONNECTORS_LOCALES.filter((code) => code !== "en").map((code) => [code, { "security-guide": securityTexts(source, code) }]))
  };
}
