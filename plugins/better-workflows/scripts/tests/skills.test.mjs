import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const pluginRoot = path.resolve(import.meta.dirname, "../..");
const skillsRoot = path.join(pluginRoot, "skills");
const catalogPath = path.join(pluginRoot, "config", "entrypoint-catalog.json");

test("exposes 17 selectable goal-first Better Workflows skills", async () => {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.equal(catalog.skills.length, 17);

  const directories = new Set(await readdir(skillsRoot));
  for (const entry of catalog.skills) {
    assert.ok(directories.has(entry.id), `missing selector skill: ${entry.id}`);
    const content = await readFile(path.join(skillsRoot, entry.id, "SKILL.md"), "utf8");
    assert.match(content, new RegExp(`name: ${entry.id}`));
    assert.match(content, /Goal-first/);
    assert.match(content, /Goal-first entry contract/);
  }
});

test("workspace recipe selector keeps initialization, trust, and artifact authority explicit", async () => {
  const content = await readFile(path.join(skillsRoot, "workspace-recipe", "SKILL.md"), "utf8");
  assert.match(content, /template `workspace-recipe` with minimum mode `verified`/);
  assert.match(content, /Do not automatically initialize/);
  assert.match(content, /same recurrence\s+fingerprint in the preceding 90 days/);
  assert.match(content, /recipe\.promote/);
  assert.match(content, /artifact\.promote/);
  assert.match(content, /Evidence candidates remain candidates/);
});

test("main skill defines persistent goal lifecycle", async () => {
  const content = await readFile(path.join(skillsRoot, "better-workflows", "SKILL.md"), "utf8");
  assert.match(content, /inspect the current Codex goal/);
  assert.match(content, /create one from the user's requested outcome/);
  assert.match(content, /Mark the\s+goal complete only after/);
  assert.match(content, /Goal mode controls persistence/);
  assert.match(content, /sbw templates.*selected\s+template/s);
  assert.match(content, /sbw help.*route preview/s);
  assert.match(content, /sbw doctor --capabilities/);
  assert.match(content, /global helper as stale/);
  assert.match(content, /sbw doctor --capabilities/);
  assert.match(content, /sbw route preview/);
  assert.match(content, /workspace Profile/);
  assert.match(content, /single-use receipt/);
});

test("auto entry requires capability snapshot and route preview before selection", async () => {
  const content = await readFile(path.join(skillsRoot, "auto", "SKILL.md"), "utf8");
  assert.match(content, /sbw doctor --capabilities/);
  assert.match(content, /sbw route preview/);
  assert.match(content, /never fabricate an `auto` template/);
});

test("self improve is a critical thin workflow with stale-link and delegated delivery", async () => {
  const content = await readFile(path.join(skillsRoot, "self-improve", "SKILL.md"), "utf8");
  assert.match(content, /template `self-improve-ops` with minimum mode `critical`/);
  assert.match(content, /Treat `NO_CHANGE` as a valid successful outcome/);
  assert.match(content, /train` and `holdout`/);
  assert.match(content, /host-signed attestation/);
  assert.match(content, /self-improve-ops-evals-v2\.4\.json/);
  assert.match(content, /v2\.3 is the default source for the v2\.4 migration/);
  assert.match(content, /immutable v2\.2 corpus/);
  assert.match(content, /quality-remediation-v1/);
  assert.match(content, /baseline-quality-gap-not-reproduced/);
  for (const evaluationClass of ["evidence-integrity", "execution-ledger", "review-convergence", "direct-work", "plugin-cache-publication", "review-work-unit-integrity"]) {
    assert.match(content, new RegExp(evaluationClass));
  }
  assert.match(content, /never\s+automatically adopts/);
  assert.match(content, /missing versioned plugin-cache\s+path/);
  assert.match(content, /Commit, cache publication, push, merge, deploy, and cleanup are delegated\s+independent/);
  assert.match(content, /exact\s+committed\s+HEAD/);
  assert.match(content, /source-bound self-improve run/);
  assert.match(content, /root-signed standing consent/);
  assert.match(content, /sbw self-improve consent prepare/);
  assert.match(content, /\/usr\/bin\/sudo -n/);
  assert.match(content, /delivery still needs independent action authority/);

  const main = await readFile(path.join(skillsRoot, "better-workflows", "SKILL.md"), "utf8");
  assert.match(main, /versioned plugin-cache skill\s+path that no longer exists/);
  assert.match(main, /do not recreate or mutate that stale path/);
});

test("monorepo refactor keeps its exact picker name", async () => {
  const metadata = await readFile(
    path.join(skillsRoot, "monorepo-refactor", "agents", "openai.yaml"),
    "utf8"
  );
  assert.match(metadata, /display_name: "monorepo-refactor"/);
  assert.match(metadata, /default_prompt: .*\$monorepo-refactor/);
  assert.doesNotMatch(metadata, /Add monorepo-refactor skill/);
});

test("monorepo refactor implements the eligible recommendation queue", async () => {
  const content = await readFile(
    path.join(skillsRoot, "monorepo-refactor", "SKILL.md"),
    "utf8"
  );
  assert.match(content, /RECOMMENDATION_DISPOSITION=IMPLEMENT_ALL_ELIGIBLE/);
  assert.match(content, /turn every eligible recommendation into the implementation\s+queue/);
  assert.match(content, /never stop merely because a recommendation list/);
  assert.match(content, /Completion requires an empty eligible queue/);
  assert.match(content, /Do not return a recommendation-only report/);
});
