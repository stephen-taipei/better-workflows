import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const pluginRoot = path.resolve(import.meta.dirname, "../..");
const skillsRoot = path.join(pluginRoot, "skills");
const catalogPath = path.join(pluginRoot, "config", "entrypoint-catalog.json");

test("exposes 13 selectable goal-first Better Workflows skills", async () => {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.equal(catalog.skills.length, 13);

  const directories = new Set(await readdir(skillsRoot));
  for (const entry of catalog.skills) {
    assert.ok(directories.has(entry.id), `missing selector skill: ${entry.id}`);
    const content = await readFile(path.join(skillsRoot, entry.id, "SKILL.md"), "utf8");
    assert.match(content, new RegExp(`name: ${entry.id}`));
    assert.match(content, /Goal-first/);
    assert.match(content, /Goal-first entry contract/);
  }
});

test("main skill defines persistent goal lifecycle", async () => {
  const content = await readFile(path.join(skillsRoot, "better-workflows", "SKILL.md"), "utf8");
  assert.match(content, /inspect the current Codex goal/);
  assert.match(content, /create one from the user's requested outcome/);
  assert.match(content, /Mark the\s+goal complete only after/);
  assert.match(content, /Goal mode controls persistence/);
});
