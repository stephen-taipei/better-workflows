import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONNECTORS_LOCALES, locales } from "./website-locales.mjs";
import { describePolicySource } from "./policy-source.mjs";
import { localizeReferenceTexts } from "./reference-localization.mjs";
import { v4ReferenceHeadingEntries } from "./reference-v4-headings.mjs";
import { loadReferenceBodyTranslations } from "./reference-body-catalog.mjs";
import { overlayLocales } from "./locale-overlay.mjs";

export const CLI_REFERENCE_SPEC = Object.freeze({
  id: "cli-reference",
  kind: "guide",
  source: "docs/guide/cli-reference.md",
  sha256: "ec70ac76f8954078ccebb620d79dc0cacf952122f33062a66307d5003483e961",
  translationMode: "canonical-english-body",
  catalogDirectory: "public-docs",
  navigationPrefix: "| [Overview](../../README.md)"
});

// The command surface stays source-owned. These labels are the localized
// navigation/heading frame around that immutable command and policy content.
const HEADINGS = Object.freeze(overlayLocales({
  en: ["CLI reference","Overview","Details","Quick start","Workflows","Architecture","Security","CLI","Diagnose and route","Runs, evidence, and findings","Graph View","Model deliberation","Repository validation"],
  "zh-Hant-TW": ["CLI 參考","概覽","詳細資料","快速開始","工作流程","架構","安全性","CLI","診斷與路由","執行、證據與發現","圖形檢視","模型研判","儲存庫驗證"]
}, "cli-reference-headings", CONNECTORS_LOCALES));

function headingSet(code) {
  const values = HEADINGS[code];
  if (!values) throw new Error(`CLI heading locale missing: ${code}`);
  return Object.fromEntries(["title", "overview", "details", "quick", "workflows", "architecture", "security", "cli", "diagnose", "runs", "graph", "model", "validation"].map((key, index) => [key, values[index]]));
}

export async function loadCliReferenceSource(root) {
  const source = describePolicySource(CLI_REFERENCE_SPEC, await readFile(path.join(root, CLI_REFERENCE_SPEC.source), "utf8"));
  return loadReferenceBodyTranslations(root, source, { includePending: false });
}

export function cliReferenceTexts(source, code) {
  if (!CONNECTORS_LOCALES.includes(code)) throw new Error(`Unsupported CLI reference locale: ${code}`);
  if (code === "en") return source.texts;
  const locale = locales.find((entry) => entry.code === code);
  const headings = headingSet(code);
  const headingMap = new Map([
    ["# CLI reference", `# ${headings.title}`],
    ["## Diagnose and route", `## ${headings.diagnose}`],
    ["## Runs, evidence, and findings", `## ${headings.runs}`],
    ["## Graph View", `## Graph View — ${headings.graph}`],
    ["## Model deliberation", `## ${headings.model}`],
    ["## Repository validation", `## ${headings.validation}`],
    ...v4ReferenceHeadingEntries(code)
  ]);
  return localizeReferenceTexts(source, code, locale.messages, { headingMap });
}

export function cliReferenceCatalog(source) {
  return {
    sourceDigests: { "cli-reference": source.sha256 },
    locales: Object.fromEntries(CONNECTORS_LOCALES.filter((code) => code !== "en").map((code) => [code, { "cli-reference": cliReferenceTexts(source, code) }]))
  };
}
