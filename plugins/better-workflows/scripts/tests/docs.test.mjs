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
    assert.match(content, /sbw doctor --capabilities/, file);
    assert.match(content, /sbw route preview/, file);
    assert.match(content, /sbw route profile validate/, file);
    assert.match(content, /sbw run --route-receipt/, file);
    assert.match(content, /plugin-cache\.mjs check/, file);
    assert.match(content, /immutable/, file);
    assert.match(content, /pr-to-dev/, file);
    assert.match(content, /\$better-workflows:self-improve/, file);
    assert.match(content, /train\/holdout/, file);
    assert.match(content, /host-signed/, file);
    assert.match(content, /\$better-workflows:workspace-recipe/, file);
    assert.match(content, /self-improve host status/, file);
    assert.match(content, /self-improve attestation request/, file);
    assert.match(content, /recipe scaffold json-keyset-audit/, file);
    assert.match(content, /recipe promote <id>/, file);
    assert.match(content, /artifact\.promote/, file);
    assert.match(content, /graph validate/, file);
    assert.match(content, /graph inspect/, file);
    assert.match(content, /Dynamic\s+Workflow[\s\S]{0,20}runtime/, file);
    assert.match(content, /policy\s+input/, file);
    assert.match(content, /authority\s+source/, file);
    assert.match(content, /agent\s+runtime/, file);
    assert.match(content, /graph envelope/, file);
    assert.match(content, /presentation/, file);
    assert.match(content, /non-sensitive\s+structural[\s\S]{0,20}projection/, file);
    assert.match(content, /exit `2`/, file);
  }
});
