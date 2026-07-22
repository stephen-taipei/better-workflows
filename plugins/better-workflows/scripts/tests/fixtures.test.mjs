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

test("all ten templates are valid and side-effect templates declare action gates", async () => {
  const directory = path.join(pluginRoot(), "templates");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.deepEqual(names, [
    "browser-simulator-qa.json",
    "ci-release-monitor.json",
    "cross-platform-contract.json",
    "dependabot-consolidation-pr-cleanup.json",
    "ios-static-pbxproj.json",
    "issues-to-root-fix-pr-merge-cleanup.json",
    "localization-41.json",
    "monorepo-refactor.json",
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

test("monorepo refactor requires implementation of every eligible recommendation", async () => {
  const template = JSON.parse(
    await readFile(
      path.join(pluginRoot(), "templates", "monorepo-refactor.json"),
      "utf8"
    )
  );
  assert.ok(template.requiredEvidence.includes("recommendation-register"));
  assert.ok(template.requiredEvidence.includes("implementation-queue"));
  assert.ok(
    template.policyGates.includes("implement-all-eligible-recommendations")
  );
  assert.ok(
    template.acceptance.some((item) => item.id === "recommendations-implemented")
  );
  assert.ok(
    template.acceptance.some((item) => item.id === "no-silent-deferrals")
  );
});

test("Dependabot consolidation requires classification, compatibility, and exact cleanup gates", async () => {
  const template = JSON.parse(
    await readFile(
      path.join(pluginRoot(), "templates", "dependabot-consolidation-pr-cleanup.json"),
      "utf8"
    )
  );
  assert.equal(template.defaultMode, "critical");
  for (const evidence of [
    "dependabot-inventory",
    "compatibility-matrix",
    "consolidation-diff",
    "lockfile-validation",
    "merge-result",
    "cleanup-manifest"
  ]) {
    assert.ok(template.requiredEvidence.includes(evidence), evidence);
  }
  for (const policy of [
    "explicit-eligibility-classification",
    "one-consolidation-pr-per-run",
    "compatibility-before-consolidation",
    "exact-run-owned-cleanup",
    "unknown-provider-state-fails-closed"
  ]) {
    assert.ok(template.policyGates.includes(policy), policy);
  }
  for (const action of ["pr.create", "pr.merge", "pr.close", "branch.delete"]) {
    assert.ok(Object.hasOwn(template.actionGates, action), action);
    assert.ok(template.actionGates[action].length > 0, action);
  }
  assert.ok(template.acceptance.some((item) => item.id === "eligibility-classified"));
  assert.ok(template.acceptance.some((item) => item.id === "cleanup-exact"));
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
    "monorepo-refactor",
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
  assert.match(main, /Goal-first entry contract/);
  assert.match(main, /\$monorepo-refactor/);
  assert.match(main, /direct.*do not invoke .*dw/s);
  assert.match(main, /at most three direct native children/);
  assert.match(main, /Never decide by vote/);
});

test("plugin has zero runtime dependencies", async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot(), "package.json"), "utf8"));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
});
