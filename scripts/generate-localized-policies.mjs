#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECTORS_LOCALES } from "./website-locales.mjs";
import { renderPolicyMarkdown } from "./localized-policies.mjs";
import { loadPublicTexts } from "./localized-public-text.mjs";
import { publicTextMarkdownPath as policyMarkdownPath } from "./policy-routes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some((arg) => !["--check", "--preserve-deferred"].includes(arg))) throw new Error("Usage: generate-localized-policies.mjs [--check] [--preserve-deferred]");
const check = args.includes("--check");
const preserveDeferred = args.includes("--preserve-deferred");
// Validate every pinned source and all catalogs before making any output changes.
const policies = await loadPublicTexts(root);
for (const policy of policies) for (const code of CONNECTORS_LOCALES) {
  const target = path.join(root, policyMarkdownPath(code, policy.id));
  const expected = renderPolicyMarkdown(policy, code);
  if (check) {
    if (await readFile(target, "utf8") !== expected) throw new Error(`Generated policy content drift: ${code}/${policy.id}`);
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, expected);
  }
}
for (const entry of preserveDeferred ? [] : await readdir(path.join(root, "docs", "locales"), { withFileTypes: true })) {
  if (!entry.isDirectory() || CONNECTORS_LOCALES.includes(entry.name)) continue;
  const contents = await readdir(path.join(root, "docs", "locales", entry.name));
  if (policies.some((policy) => contents.includes(`${policy.id}.md`))) throw new Error(`Unexpected policy locale directory: ${entry.name}`);
}
console.log(JSON.stringify({ ok: true, mode: check ? "check" : "write", documents: policies.map((policy) => policy.source),
  sourceMappedEditions: policies.length * CONNECTORS_LOCALES.length,
  fullTextEditions: policies.filter((policy) => policy.translationMode !== "canonical-english-body").length * CONNECTORS_LOCALES.length,
  nativeSpeakerReview: "not-established" }));
