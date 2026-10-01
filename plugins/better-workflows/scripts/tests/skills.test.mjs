import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const pluginRoot = path.resolve(import.meta.dirname, "../..");
const skillsRoot = path.join(pluginRoot, "skills");
const templatesRoot = path.join(pluginRoot, "templates");

test("V5 public plugin exposes only the Auto skill and template", async () => {
  const catalog = JSON.parse(await readFile(path.join(pluginRoot, "config/entrypoint-catalog.json"), "utf8"));
  assert.deepEqual(catalog.skills.map(({ id, template, mode }) => ({ id, template, mode })),
    [{ id: "auto", template: "auto", mode: "auto" }]);
  assert.deepEqual(await readdir(skillsRoot), ["auto"]);
  assert.deepEqual(await readdir(templatesRoot), ["auto.json"]);
  const plugin = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(plugin.skills, "./skills/");
  assert.ok(plugin.interface.defaultPrompt.length > 0);
  for (const prompt of plugin.interface.defaultPrompt) {
    assert.match(prompt, /\$better-workflows:auto/);
    assert.doesNotMatch(prompt, /\$better-workflows:(?!auto\b)[a-z-]+/);
  }
});

test("Auto skill describes current admission and preserves action authority", async () => {
  const content = await readFile(path.join(skillsRoot, "auto/SKILL.md"), "utf8");
  for (const required of [
    "name: auto", "Goal-first", "current host goal", "sbw workspace preflight",
    "sbw doctor --capabilities", "sbw route preview", "AutoRiskAssessmentV1",
    "read-only-v1", "code-change-v1", "dev-publish-v1", "--route-receipt",
    "rebind the exact", "new sentinel"
  ]) assert.ok(content.includes(required), required);
  assert.match(content, /persistent goal only if the user explicitly asks/);
  assert.match(content, /atomic local commits after scoped plan and\s+repository gates, with broad review before publication/);
  assert.match(content, /Never push directly to `dev` or `main`/);
  assert.match(content, /It is the only public selector\. The\s+installed `templates\/auto\.json` is the only public template\./);
  assert.match(content, /policies inside Auto, not separately selectable templates or skills/);
  assert.match(content, /unknown provider state[\s\S]*HOLD/);
  assert.doesNotMatch(content, /\$better-workflows:(?!auto\b)[a-z-]+/);
});

test("Auto skill defines finite repair and stopping guidance without promising global cost enforcement", async () => {
  const content = await readFile(path.join(skillsRoot, "auto/SKILL.md"), "utf8");
  assert.match(content, /Keep one finite acceptance list for the authorized scope/);
  assert.match(content, /After two attempts with the same cause and no acceptance progress,[\s\S]*stop that repair path/);
  assert.match(content, /Do not create another run, package, or goal to reset an exhausted budget/);
  assert.match(content, /A stage attempt limit is not a global model cost limit/);
  assert.match(content, /When no aggregate token or time cap is configured, report that limitation/);
  assert.match(content, /When every remaining item depends on an external HOLD, end the current[\s\S]*turn/);
  assert.match(content, /ending a turn neither completes nor pauses that goal/);
});
