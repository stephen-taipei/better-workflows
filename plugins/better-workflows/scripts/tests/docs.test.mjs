import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pluginRoot } from "../lib/core.mjs";

const repoRoot = path.resolve(pluginRoot(), "../..");
const documents = [
  path.join(repoRoot, "README.md"),
  path.join(repoRoot, "docs", "README.zh-TW.md"),
  path.join(repoRoot, "docs", "README.zh-CN.md"),
  path.join(repoRoot, "docs", "README.ja.md"),
  path.join(repoRoot, "docs", "README.ko.md")
];

test("all README languages explain progressive routing, Profiles, receipts, and immutable cache", async (context) => {
  try {
    await access(documents[0]);
  } catch {
    context.skip("repository README files are not part of the installed plugin cache bundle");
    return;
  }
  for (const file of documents) {
    const content = await readFile(file, "utf8");
    assert.match(content, /dw doctor --capabilities/, file);
    assert.match(content, /dw route preview/, file);
    assert.match(content, /dw route profile validate/, file);
    assert.match(content, /dw run --route-receipt/, file);
    assert.match(content, /plugin-cache\.mjs check/, file);
    assert.match(content, /immutable/, file);
    assert.match(content, /pr-to-dev/, file);
    assert.match(content, /\$better-workflows:self-improve/, file);
  }
});
