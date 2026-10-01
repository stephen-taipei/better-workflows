import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONNECTORS_LOCALES, locales } from "./website-locales.mjs";
import { describePolicySource } from "./policy-source.mjs";
import { localizeMermaidCode, localizeReferenceTexts } from "./reference-localization.mjs";
import { v4ReferenceHeadingEntries } from "./reference-v4-headings.mjs";
import { loadReferenceBodyTranslations } from "./reference-body-catalog.mjs";

export const ARCHITECTURE_SPEC = Object.freeze({
  id: "architecture",
  kind: "guide",
  source: "docs/guide/architecture.md",
  sha256: "9d2102eed653f2e009a0f032bc9fe4ca3100781e022dfc64ed6df55a767d9b6c",
  translationMode: "canonical-english-body",
  catalogDirectory: "public-docs",
  navigationPrefix: "| [Overview](../../README.md)"
});

// Headings are deliberately kept in a small, reviewable phrasebook. Runtime
// identifiers and normative names stay in the body exactly as authored.
const HEADINGS = Object.freeze({
  en: ["Architecture","Design contract","Better Workflows and Dynamic Workflows","Derived Graph View","Model deliberation and Antigravity CLI","Primary sources"],
  "zh-Hant-TW": ["架構","設計契約","Better Workflows 與 Dynamic Workflows","衍生圖檢視","模型研判與 Antigravity CLI","主要來源"]
});

function headingSet(code) {
  const values = HEADINGS[code];
  if (!values) throw new Error(`Architecture heading locale missing: ${code}`);
  return Object.fromEntries(["title", "design", "dynamic", "graph", "model", "primary"].map((key, index) => [key, values[index]]));
}

export async function loadArchitectureSource(root) {
  const source = describePolicySource(ARCHITECTURE_SPEC, await readFile(path.join(root, ARCHITECTURE_SPEC.source), "utf8"));
  return loadReferenceBodyTranslations(root, source, { includePending: false });
}

export function architectureTexts(source, code) {
  if (!CONNECTORS_LOCALES.includes(code)) throw new Error(`Unsupported architecture locale: ${code}`);
  if (code === "en") return source.texts;
  const locale = locales.find((entry) => entry.code === code);
  const h = headingSet(code);
  const headingMap = new Map([
    ["# Architecture", h.title],
    ["## Design contract", h.design],
    ["## Better Workflows and Dynamic Workflows", h.dynamic],
    ["## Derived Graph View", `${h.graph} (Graph View)`],
    ["## Model deliberation and Antigravity CLI", h.model],
    ...v4ReferenceHeadingEntries(code)
  ]);
  return localizeReferenceTexts(source, code, locale.messages, { headingMap });
}

export function localizeArchitectureCode(source, code, bodyTranslation) {
  return localizeMermaidCode(source, code, bodyTranslation?.diagramLabels);
}

export function architectureCatalog(source) {
  return {
    sourceDigests: { architecture: source.sha256 },
    locales: Object.fromEntries(CONNECTORS_LOCALES.filter((code) => code !== "en").map((code) => [code, { architecture: architectureTexts(source, code) }]))
  };
}

export function architectureSourceDigest(source) {
  return createHash("sha256").update(source.blocks.map((block) => block.source).join("\n\n") + "\n").digest("hex");
}
