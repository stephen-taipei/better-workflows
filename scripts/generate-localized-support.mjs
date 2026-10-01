#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECTORS_LOCALES } from "./website-locales.mjs";
import { renderSupportMarkdown, supportMarkdownPath, verifySupportSource } from "./localized-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some((arg) => !["--check", "--preserve-deferred"].includes(arg))) throw new Error("Usage: generate-localized-support.mjs [--check] [--preserve-deferred]");
await verifySupportSource(root);
const check = args.includes("--check");
const preserveDeferred = args.includes("--preserve-deferred");
for (const code of CONNECTORS_LOCALES) {
  const target = path.join(root, supportMarkdownPath(code));
  const expected = renderSupportMarkdown(code);
  if (check) {
    if (await readFile(target, "utf8") !== expected) throw new Error(`Generated support content drift: ${code}`);
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, expected);
  }
}
// Do not delete an unexpected locale directory: it may contain other contributors' work.
for (const entry of preserveDeferred ? [] : await readdir(path.join(root, "docs", "locales"), { withFileTypes: true })) {
  if (!entry.isDirectory() || CONNECTORS_LOCALES.includes(entry.name)) continue;
  const contents = await readdir(path.join(root, "docs", "locales", entry.name));
  if (contents.includes("support.md")) throw new Error(`Unexpected support locale directory: ${entry.name}`);
}
console.log(JSON.stringify({ ok: true, mode: check ? "check" : "write", document: "SUPPORT.md", fullTextEditions: CONNECTORS_LOCALES.length, nativeSpeakerReview: "not-established" }));
