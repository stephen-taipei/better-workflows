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

test("all twelve templates are valid and side-effect templates declare action gates", async () => {
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
    "pr-to-dev.json",
    "research-deliberation.json",
    "review-to-issues.json",
    "self-improve-ops.json"
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

test("pr-to-dev enforces batched commits, a dev-targeted PR, and remote reconciliation", async () => {
  const template = JSON.parse(
    await readFile(path.join(pluginRoot(), "templates", "pr-to-dev.json"), "utf8")
  );
  assert.equal(template.defaultMode, "critical");
  for (const evidence of [
    "commit-plan",
    "commit-manifest",
    "commit-history",
    "target-branch-dev",
    "required-checks",
    "merge-result",
    "remote-sync"
  ]) {
    assert.ok(template.requiredEvidence.includes(evidence), evidence);
  }
  for (const action of ["git.commit", "git.push", "pr.create", "pr.merge", "remote.sync", "worktree.cleanup"]) {
    assert.ok(Object.hasOwn(template.actionGates, action), action);
    assert.ok(template.actionGates[action].length > 0, action);
  }
  for (const acceptance of ["batched-commits-complete", "pr-targets-dev", "fresh-checks-passed", "merged-to-dev", "remote-reconciled", "cleanup-exact"]) {
    assert.ok(template.acceptance.some((item) => item.id === acceptance), acceptance);
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

test("research deliberation requires CLI-proven roles and an executable arbiter plan", async () => {
  const template = JSON.parse(
    await readFile(path.join(pluginRoot(), "templates", "research-deliberation.json"), "utf8")
  );
  for (const evidence of [
    "deliberation-roster",
    "role-perspective-matrix",
    "decision-record",
    "executable-plan",
    "arbiter-verdict"
  ]) {
    assert.ok(template.requiredEvidence.includes(evidence), evidence);
  }
  for (const policy of [
    "provider-probe-before-roster",
    "model-bound-role-assignment",
    "role-duplication-across-brands-allowed",
    "capability-ranked-arbiter-fallback"
  ]) {
    assert.ok(template.policyGates.includes(policy), policy);
  }
  for (const acceptance of ["providers-probed", "roles-separated", "plan-executable", "arbiter-resolved"]) {
    assert.ok(template.acceptance.some((item) => item.id === acceptance), acceptance);
  }
});

test("self improve keeps no-change, synchronization, cache, commit, and push fail closed", async () => {
  const template = JSON.parse(
    await readFile(path.join(pluginRoot(), "templates", "self-improve-ops.json"), "utf8")
  );
  assert.equal(template.defaultMode, "critical");
  for (const evidence of [
    "retrospective-source-inventory",
    "recurrence-matrix",
    "decision-record",
    "sync-matrix",
    "plugin-version",
    "cache-check",
    "cache-publication",
    "remote-reconciliation"
  ]) {
    assert.ok(template.requiredEvidence.includes(evidence), evidence);
  }
  for (const policy of [
    "first-class-no-change",
    "thin-workflow-composition",
    "stale-versioned-link-resolution",
    "no-mutation-of-stale-cache",
    "selector-template-catalog-test-doc-sync",
    "new-version-before-publication",
    "immutable-cache-exact-digest",
    "independent-action-authority"
  ]) {
    assert.ok(template.policyGates.includes(policy), policy);
  }
  assert.deepEqual(Object.keys(template.actionGates).sort(), [
    "git.commit",
    "git.push",
    "plugin.cache.publish"
  ]);
  assert.ok(template.acceptance.some((item) => item.id === "outcome-explicit"));
  assert.ok(template.acceptance.some((item) => item.id === "cache-immutable"));
  assert.ok(template.acceptance.some((item) => item.id === "delivery-reconciled"));
});

test("deliberation roster keeps every brand and routes Gemini through Agy with a 24-hour lease", async () => {
  const roster = JSON.parse(
    await readFile(path.join(pluginRoot(), "config", "deliberation-roster.json"), "utf8")
  );
  assert.equal(roster.rosterCacheHours, 24);
  const providers = new Map(roster.providers.map((provider) => [provider.id, provider]));
  for (const id of ["codex", "claude", "gemini", "agy", "grok", "cursor", "kimi", "qwen", "kiro"]) {
    assert.ok(providers.has(id), id);
  }
  assert.equal(providers.get("gemini").command, "agy");
  assert.equal(providers.get("gemini").probe, "agy");
  assert.equal(providers.get("gemini").effortTransport, "native");
  assert.equal(
    providers.get("agy").models.find((model) => model.model === "claude-opus-4-6-thinking").effortTransport,
    "model-variant"
  );
  assert.deepEqual(roster.reasoningEffort.allowed, ["medium", "high"]);
  assert.equal(roster.reasoningEffort.modeDefaults.verified, "medium");
  assert.equal(roster.reasoningEffort.modeDefaults.deep, "high");
  assert.deepEqual(
    providers.get("gemini").models
      .filter((model) => model.model.startsWith("gemini-3.6-flash-"))
      .map((model) => model.reasoningEffort)
      .sort(),
    ["high", "medium"]
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
    "repository-actions-inventory",
    "actions-cleanup-plan",
    "merge-result",
    "actions-cancelled",
    "cleanup-manifest"
  ]) {
    assert.ok(template.requiredEvidence.includes(evidence), evidence);
  }
  for (const policy of [
    "explicit-eligibility-classification",
    "one-consolidation-pr-per-run",
    "compatibility-before-consolidation",
    "repository-actions-existence-check",
    "cancel-actions-before-source-cleanup",
    "preserve-current-consolidation-actions",
    "unknown-action-state-fails-closed",
    "exact-run-owned-cleanup",
    "unknown-provider-state-fails-closed"
  ]) {
    assert.ok(template.policyGates.includes(policy), policy);
  }
  for (const action of ["actions.inventory", "pr.create", "pr.merge", "actions.cancel", "pr.close", "branch.delete", "worktree.cleanup"]) {
    assert.ok(Object.hasOwn(template.actionGates, action), action);
    assert.ok(template.actionGates[action].length > 0, action);
  }
  assert.ok(template.acceptance.some((item) => item.id === "eligibility-classified"));
  assert.ok(template.acceptance.some((item) => item.id === "actions-inventory-current"));
  assert.ok(template.acceptance.some((item) => item.id === "actions-cancelled-before-cleanup"));
  assert.ok(template.acceptance.some((item) => item.id === "cleanup-exact"));
});

test("skills have no placeholders and retired AI-meeting alias is absent", async () => {
  const skillsRoot = path.join(pluginRoot(), "skills");
  const skillNames = (await readdir(skillsRoot)).sort();
  assert.deepEqual(skillNames, [
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
    "pr-to-dev",
    "research",
    "review-issues",
    "self-improve",
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
  assert.match(main, /direct.*do not invoke .*sbw/s);
  assert.match(main, /at most three direct native children/);
  assert.match(main, /Never decide by vote/);
  assert.match(main, /CLI-proven participant roster/);
  assert.doesNotMatch(await readFile(path.join(pluginRoot(), "templates", "research-deliberation.json"), "utf8"), /no-claude/);
});

test("plugin has zero runtime dependencies", async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot(), "package.json"), "utf8"));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
});

test("plugin exposes sbw as its sole executable", async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot(), "package.json"), "utf8"));
  assert.deepEqual(manifest.bin, { sbw: "scripts/sbw.mjs" });
});

test("plugin runtime and Codex build versions are aligned", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(pluginRoot(), ".codex-plugin", "plugin.json"), "utf8")
  );
  const packageManifest = JSON.parse(
    await readFile(path.join(pluginRoot(), "package.json"), "utf8")
  );
  assert.equal(manifest.version.split("+")[0], packageManifest.version);
});
