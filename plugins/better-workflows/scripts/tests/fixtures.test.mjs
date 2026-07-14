import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pluginRoot, routeMode } from "../lib/core.mjs";

test("all historical and adversarial routing fixtures select the expected mode", async () => {
  const cases = JSON.parse(
    await readFile(path.join(pluginRoot(), "fixtures", "history", "cases.json"), "utf8")
  );
  assert.ok(cases.length >= 17);
  for (const fixture of cases) {
    assert.equal(
      routeMode({ risk: fixture.risk }, "auto"),
      fixture.expectedMode,
      fixture.name
    );
  }
});

test("all eight templates are valid and side-effect templates declare action gates", async () => {
  const directory = path.join(pluginRoot(), "templates");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.deepEqual(names, [
    "browser-simulator-qa.json",
    "ci-release-monitor.json",
    "cross-platform-contract.json",
    "ios-static-pbxproj.json",
    "issues-to-root-fix-pr-merge-cleanup.json",
    "localization-41.json",
    "research-deliberation.json",
    "review-to-issues.json"
  ]);
  for (const name of names) {
    const template = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    assert.equal(template.name, name.slice(0, -5));
    assert.ok(template.requiredEvidence.length > 0);
    assert.ok(template.acceptance.length > 0);
    assert.ok(template.policyGates.length > 0);
    if (template.rootOnlyActions.some((action) => /deploy|release|issue create|pr create|pr merge/i.test(action))) {
      assert.ok(template.actionGates && Object.keys(template.actionGates).length > 0, name);
    }
  }
});

test("skills have no placeholders and compatibility aliases route to the main skill", async () => {
  const skillsRoot = path.join(pluginRoot(), "skills");
  const skillNames = (await readdir(skillsRoot)).sort();
  assert.deepEqual(skillNames, [
    "ai-meeting-tw",
    "auto",
    "auto-improve",
    "auto-issues",
    "better-workflows",
    "browser-qa",
    "ci-release",
    "critical",
    "cross-platform",
    "deep",
    "direct",
    "fix-issues-pr",
    "git-check-issues",
    "ios-static",
    "localization",
    "research",
    "review-issues",
    "verified"
  ]);
  for (const name of skillNames) {
    const contents = await readFile(path.join(skillsRoot, name, "SKILL.md"), "utf8");
    assert.doesNotMatch(contents, /\[TODO|TODO:/);
    if (name !== "better-workflows") {
      assert.match(contents, /\.\.\/better-workflows\/SKILL\.md/);
    }
  }
  const main = await readFile(
    path.join(skillsRoot, "better-workflows", "SKILL.md"),
    "utf8"
  );
  assert.match(main, /root agent as the only authority/);
  assert.match(main, /direct.*do not invoke .*dw/s);
  assert.match(main, /at most three direct native children/);
  assert.match(main, /Never decide by vote/);
});

test("plugin has zero runtime dependencies", async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot(), "package.json"), "utf8"));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
});
