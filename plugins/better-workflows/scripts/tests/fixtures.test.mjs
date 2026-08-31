import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { buildContract, pluginRoot, routeMode, VERSION } from "../lib/core.mjs";
import { loadAutonomyProfile } from "../lib/autonomy.mjs";
import { validateReviewProfile } from "../lib/review-policy.mjs";

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

test("SOP incident corpus covers convergence, launch, review, and fixture amplification regressions", async () => {
  const corpus = JSON.parse(
    await readFile(path.join(pluginRoot(), "fixtures", "sop-incidents-v4.json"), "utf8")
  );
  assert.equal(corpus.schemaVersion, 1);
  assert.ok(Array.isArray(corpus.incidents));
  const ids = corpus.incidents.map((incident) => incident.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const required of [
    "campaign-budget-reset",
    "zsh-readonly-variable",
    "process-scan-self-match",
    "bsd-sed-alternation",
    "pipefail-short-reader",
    "hardcoded-tool-location",
    "missing-tmp-parent",
    "incomplete-fixed-path",
    "sandbox-host-identity-denied",
    "exact-sha-evaluator-retry-loop",
    "model-output-schema-blocks-tools",
    "reviewed-wrong-diff",
    "same-process-timer-race"
  ]) assert.ok(ids.includes(required), required);
  assert.deepEqual(
    [...new Set(corpus.incidents.map((incident) => incident.class))].sort(),
    ["convergence", "launcher", "review", "test-fixture"]
  );
  for (const incident of corpus.incidents) {
    for (const field of ["id", "class", "symptom", "rootCause", "prevention", "regression"]) {
      assert.equal(typeof incident[field], "string", `${incident.id}:${field}`);
      assert.ok(incident[field].trim(), `${incident.id}:${field}`);
    }
    const serialized = JSON.stringify(incident);
    assert.doesNotMatch(serialized, /\/Users\//);
    assert.doesNotMatch(serialized, /(?:password|token|secret)\s*[:=]/i);
  }
});

test("bounded-autopilot policy is separate from templates and cannot authorize protected actions", async () => {
  const profile = await loadAutonomyProfile();
  const schema = JSON.parse(await readFile(path.join(pluginRoot(), "config", "autonomy", "bounded-autopilot-v1.schema.json"), "utf8"));
  assert.equal(profile.id, "bounded-autopilot-v1");
  assert.equal(schema.properties.id.const, profile.id);
  assert.deepEqual(schema.properties.autoActions.items.enum, profile.autoActions);
  assert.deepEqual(schema.properties.humanActions.items.enum, profile.humanActions);
  assert.deepEqual(schema.properties.deniedActions.items.enum, profile.deniedActions);
  assert.deepEqual(schema.properties.limits.properties, Object.fromEntries(
    Object.entries(profile.limits).map(([key, value]) => [key, { const: value }])
  ));
  assert.ok(profile.autoActions.includes("pr.create.dev"));
  assert.ok(!profile.autoActions.includes("pr.merge"));
  assert.ok(profile.humanActions.includes("pr.merge"));
  assert.ok(profile.humanActions.includes("git.push.dev"));
  assert.ok(profile.deniedActions.includes("password.capture"));
});

test("all fourteen templates are valid and side-effect templates declare action gates", async () => {
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
    "pr-to-dev-agent-quorum.json",
    "pr-to-dev.json",
    "research-deliberation.json",
    "review-to-issues.json",
    "self-improve-ops.json",
    "workspace-recipe.json"
  ]);
  for (const name of names) {
    const template = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    assert.equal(template.name, name.slice(0, -5));
    if (template.controlPlane.reviewPolicy === "none") {
      assert.equal(template.reviewProfile, undefined, `${name} must not declare a review profile`);
    } else {
      assert.ok(template.reviewProfile, `${name} must declare its review profile`);
      assert.doesNotThrow(() => validateReviewProfile(template.reviewProfile, {
        template: template.name,
        reviewPolicy: template.controlPlane.reviewPolicy
      }), name);
    }
    assert.ok(template.requiredEvidence.length > 0);
    assert.ok(template.acceptance.length > 0);
    assert.ok(template.policyGates.length > 0);
    const evidenceMinimum = new Set(template.requiredEvidence);
    for (const [action, prerequisites] of Object.entries(template.actionGates ?? {})) {
      for (const prerequisite of prerequisites) {
        assert.ok(
          evidenceMinimum.has(prerequisite),
          `${name} ${action} prerequisite is absent from requiredEvidence: ${prerequisite}`
        );
      }
    }
    if (template.deferredActions?.length > 0) {
      const deferred = new Set(template.deferredActions);
      for (const action of Object.keys(template.actionStages ?? {})) {
        assert.ok(!deferred.has(action), `${name} deferred action must not be an active stage: ${action}`);
      }
      for (const action of Object.keys(template.actionGates ?? {})) {
        assert.ok(!deferred.has(action), `${name} deferred action must not have an action gate: ${action}`);
      }
    }
    if (template.rootOnlyActions.some((action) => /deploy|release|issue create|pr create|pr merge/i.test(action)) &&
        !(template.deferredActions?.length > 0)) {
      assert.ok(template.actionGates && Object.keys(template.actionGates).length > 0, name);
    }
  }
});

test("ci release dispatch stays deferred while monitoring remains non-circular", async () => {
  const template = JSON.parse(
    await readFile(path.join(pluginRoot(), "templates", "ci-release-monitor.json"), "utf8")
  );
  const monitorStage = template.executionStages.find((stage) => stage.id === "monitor-execute");
  assert.ok(monitorStage);
  assert.deepEqual(monitorStage.dependsOn, ["queue"]);
  assert.deepEqual(template.actionStages, {});
  assert.deepEqual(template.actionGates, {});
  assert.ok(template.deferredActions.includes("workflow.dispatch"));
  assert.ok(template.deferredActions.includes("branch.promote"));
  assert.equal(template.executionStages.find((stage) => stage.id === "provider-reconcile").dependsOn[0], "monitor-execute");
});

test("integration-tag workflow grants check-read permission for catch-up reconciliation", async () => {
  const workflow = await readFile(
    path.resolve(pluginRoot(), "../../.github/workflows/ci.yml"),
    "utf8"
  );
  assert.match(
    workflow,
    /integration-tag:[\s\S]*?permissions:\s*\n\s+contents:\s+write\s*\n\s+actions:\s+read\s*\n\s+checks:\s+read\s*\n\s+statuses:\s+read\s*\n\s+pull-requests:\s+read/
  );
  assert.match(workflow, /integration-tag:[\s\S]*?RELEASE_POLICY_ADMIN_TOKEN:\s+\$\{\{\s*secrets\.BETTER_WORKFLOWS_POLICY_TOKEN\s*\}\}/);
});

test("trusted pull-request-target workflow publishes a pre-merge policy artifact", async () => {
  const workflow = await readFile(
    path.resolve(pluginRoot(), "../../.github/workflows/ci.yml"),
    "utf8"
  );
  const reconciliationWorkflow = await readFile(
    path.resolve(pluginRoot(), "../../.github/workflows/release-policy-reconcile.yml"),
    "utf8"
  );
  assert.match(workflow, /test:\s*\n\s+if:\s+github\.event_name\s+==\s+'push'\s+\|\|\s+github\.event_name\s+==\s+'pull_request'/);
  assert.match(workflow, /test:\s*[\s\S]*?permissions:\s*\n\s+contents:\s+read\s*\n\s+pull-requests:\s+read/);
  const testJob = workflow.match(/\n  test:\n[\s\S]*?(?=\n  [a-z-]+:|$)/)?.[0] ?? "";
  assert.doesNotMatch(testJob, /statuses:\s+write/);
  assert.match(workflow, /pull_request_target:\s*\n\s+types:\s+\[opened, reopened, synchronize, closed\]/);
  assert.doesNotMatch(workflow, /workflow_run:/);
  assert.match(workflow, /release-policy-receipt:\s*\n\s+name:\s+Release policy receipt\s*\n\s+if:\s+github\.event_name\s+==\s+'pull_request_target'[\s\S]*?github\.event\.action\s+==\s+'closed'[\s\S]*?github\.event\.pull_request\.merged\s+==\s+true/);
  assert.match(workflow, /release-policy-receipt:[\s\S]*?actions:\s+read\s*\n\s+statuses:\s+write/);
  assert.match(workflow, /release-policy-receipt:[\s\S]*?ref:\s+\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(workflow, /release-policy-receipt:[\s\S]*?GITHUB_EVENT_NAME:\s+\$\{\{\s*github\.event_name\s*\}\}/);
  assert.match(workflow, /release-policy-receipt:[\s\S]*?GITHUB_EVENT_ACTION:\s+\$\{\{\s*github\.event\.action\s*\}\}/);
  assert.match(workflow, /release-policy-receipt:[\s\S]*?GITHUB_HEAD_SHA:\s+\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/);
  assert.match(workflow, /release-policy-receipt:[\s\S]*?GITHUB_PR_NUMBER:\s+\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/);
  assert.match(workflow, /release-policy-receipt:[\s\S]*?GITHUB_PR_MERGED:\s+\$\{\{\s*github\.event\.pull_request\.merged\s*\}\}/);
  assert.match(workflow, /release-policy-receipt:[\s\S]*?GITHUB_MERGE_COMMIT_SHA:\s+\$\{\{\s*github\.event\.pull_request\.merge_commit_sha\s*\}\}/);
  assert.match(workflow, /release-policy-receipt:[\s\S]*?GITHUB_PR_MERGED_AT:\s+\$\{\{\s*github\.event\.pull_request\.merged_at\s*\}\}/);
  assert.match(workflow, /release-policy-receipt:[\s\S]*?GITHUB_RUN_ID:\s+\$\{\{\s*github\.run_id\s*\}\}/);
  assert.match(workflow, /release-policy-receipt:[\s\S]*?GITHUB_RUN_ATTEMPT:\s+\$\{\{\s*github\.run_attempt\s*\}\}/);
  assert.match(workflow, /RELEASE_POLICY_RECEIPT_PHASE:\s+prepare[\s\S]*?RELEASE_POLICY_ADMIN_TOKEN:\s+\$\{\{\s*secrets\.BETTER_WORKFLOWS_POLICY_TOKEN\s*\}\}/);
  assert.match(workflow, /id:\s+close-binding[\s\S]*?if:\s+github\.event\.action\s+==\s+'closed'[\s\S]*?RELEASE_POLICY_RECEIPT_PHASE:\s+close-binding/);
  assert.match(workflow, /if:\s+always\(\)\s+&&\s+steps\.close-binding\.outcome\s+==\s+'success'[\s\S]*?better-workflows-release-policy-close-binding-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/);
  assert.match(workflow, /release-policy-receipt:[\s\S]*?RELEASE_POLICY_RECEIPT_FILE:\s+\$\{\{\s*runner\.temp\s*\}\}\/release-policy-receipt\.json/);
  assert.match(workflow, /id:\s+prepare[\s\S]*?RELEASE_POLICY_RECEIPT_PHASE:\s+prepare[\s\S]*?run:\s+node plugins\/better-workflows\/scripts\/release-policy-receipt\.mjs/);
  assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262\s+# v4/);
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\s+# v4[\s\S]*?node-version:\s+24\.12\.0/);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\s+# v4/);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02[\s\S]*?name:\s+Publish required-check policy status after artifact upload[\s\S]*?RELEASE_POLICY_RECEIPT_PHASE:\s+publish/);
  assert.match(workflow, /better-workflows-release-policy-receipt-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/);
  assert.match(workflow, /retention-days:\s+90/);
  assert.match(workflow, /release-policy-receipt:[\s\S]*?run:\s+node plugins\/better-workflows\/scripts\/release-policy-receipt\.mjs/);
  assert.match(reconciliationWorkflow, /workflow_run:\s*\n\s+workflows:\s+\["CI"\]\s*\n\s+types:\s+\[completed\]/);
  assert.match(reconciliationWorkflow, /release-policy-receipt:\s*\n\s+name:\s+Release policy receipt\s*\n\s+# The Node entrypoint rejects non-merged runs and skips runs without the immutable close binding\.\s*\n\s+if:\s+github\.event\.workflow_run\.event\s+==\s+'pull_request_target'/);
  assert.match(reconciliationWorkflow, /GITHUB_EVENT_PATH:\s+\$\{\{\s*github\.event_path\s*\}\}/);
  assert.match(reconciliationWorkflow, /RELEASE_POLICY_RECEIPT_PHASE:\s+prepare/);
  assert.match(reconciliationWorkflow, /RELEASE_POLICY_RECEIPT_PHASE:\s+prepare[\s\S]*?RELEASE_POLICY_ADMIN_TOKEN:\s+\$\{\{\s*secrets\.BETTER_WORKFLOWS_POLICY_TOKEN\s*\}\}/);
  assert.match(reconciliationWorkflow, /RELEASE_POLICY_RECEIPT_PHASE:\s+publish/);
  assert.match(reconciliationWorkflow, /GITHUB_RUN_ATTEMPT:\s+\$\{\{\s*github\.run_attempt\s*\}\}/);
  assert.match(reconciliationWorkflow, /better-workflows-release-policy-receipt-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/);
  assert.match(reconciliationWorkflow, /Validate exact closed merge trigger and prepare required-check policy receipt artifact/);
  assert.match(reconciliationWorkflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262\s+# v4/);
  assert.match(reconciliationWorkflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\s+# v4[\s\S]*?node-version:\s+24\.12\.0/);
  assert.match(reconciliationWorkflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\s+# v4/);
  for (const [name, text] of [["ci.yml", workflow], ["release-policy-reconcile.yml", reconciliationWorkflow]]) {
    assert.doesNotMatch(text, /uses:\s+actions\/[A-Za-z0-9_.-]+@(?![0-9a-f]{40}\b)\S+/i, `${name} contains a mutable action ref`);
    assert.doesNotMatch(text, /node-version:\s+24(?:\s|$)/, `${name} contains a floating Node 24 runtime`);
  }
});

test("generated HTML template inventory derives ci release stages from authoritative templates", async () => {
  const templateDirectory = path.join(pluginRoot(), "templates");
  const templateFiles = (await readdir(templateDirectory)).filter((name) => name.endsWith(".json"));
  const templates = await Promise.all(templateFiles.map(async (name) => (
    JSON.parse(await readFile(path.join(templateDirectory, name), "utf8"))
  )));
  const totalStages = templates.reduce((sum, template) => sum + template.executionStages.length, 0);
  const ciTemplate = templates.find((template) => template.name === "ci-release-monitor");
  assert.ok(ciTemplate);
  const useCases = await readFile(path.resolve(pluginRoot(), "../../docs/html/use-cases/index.html"), "utf8");
  const home = await readFile(path.resolve(pluginRoot(), "../../docs/html/index.html"), "utf8");
  const preview = await readFile(path.resolve(pluginRoot(), "../../docs/html/use-cases/preview.html"), "utf8");
  assert.match(useCases, new RegExp(`id:'ci-release-monitor', mode:'critical', stages:${ciTemplate.executionStages.length},`));
  for (const stage of ciTemplate.executionStages) assert.ok(useCases.includes(`['${stage.id}'`), stage.id);
  assert.ok(!useCases.includes("['push-preflight'"));
  assert.match(useCases, new RegExp(`14 / ${totalStages} stages`));
  assert.match(useCases, /Fourteen templates and sixty-six stages/);
  assert.match(home, new RegExp(`14 個 template 合計 ${totalStages} stages`));
  assert.match(preview, new RegExp(`${totalStages} 個 stages`));
  assert.match(preview, new RegExp(`${totalStages} stages`));
});

test("pr-to-dev push is issued in the post-review side-effect stage", async () => {
  const template = JSON.parse(
    await readFile(path.join(pluginRoot(), "templates", "pr-to-dev.json"), "utf8")
  );
  assert.equal(template.actionStages["git.push"], "pr-checks");
  assert.equal(template.executionStages.find((stage) => stage.id === "pr-checks").dependsOn[0], "review");
});

test("workspace recipes require explicit trust and independently gated artifact promotion", async () => {
  const template = JSON.parse(
    await readFile(path.join(pluginRoot(), "templates", "workspace-recipe.json"), "utf8")
  );
  assert.equal(template.defaultMode, "verified");
  for (const evidence of [
    "recipe-contract",
    "fixture-test",
    "candidate-dry-run",
    "digest-confirmation",
    "current-sentinel",
    "artifact-receipt",
    "promotion-decision"
  ]) {
    assert.ok(template.requiredEvidence.includes(evidence), evidence);
  }
  assert.deepEqual(Object.keys(template.actionGates).sort(), [
    "artifact.promote",
    "recipe.promote"
  ]);
  assert.ok(template.policyGates.includes("no-untrusted-execution"));
  assert.ok(template.policyGates.includes("no-automatic-scaffold-promotion-or-execution"));
});

test("review profiles are copied into the bound task contract", async () => {
  const template = JSON.parse(
    await readFile(path.join(pluginRoot(), "templates", "self-improve-ops.json"), "utf8")
  );
  const contract = buildContract({
    template: template.name,
    templateDefinition: template,
    goal: "profile binding fixture",
    scope: ["templates/self-improve-ops.json"],
    risk: { risk: 1, uncertainty: 1, blastRadius: 1, irreversibility: 0, evidenceGap: 1 }
  });
  assert.deepEqual(contract.reviewProfile, template.reviewProfile);
});

test("review-enabled contracts require a bound profile and review-none contracts reject one", async () => {
  const template = JSON.parse(
    await readFile(path.join(pluginRoot(), "templates", "self-improve-ops.json"), "utf8")
  );
  const reviewEnabledWithoutProfile = structuredClone(template);
  reviewEnabledWithoutProfile.controlPlane.reviewPolicy = "code-v1";
  delete reviewEnabledWithoutProfile.controlPlane.workUnitPolicy;
  delete reviewEnabledWithoutProfile.controlPlane.reviewLanes;
  delete reviewEnabledWithoutProfile.reviewProfile;
  assert.throws(() => buildContract({
    template: "review-enabled-without-profile",
    templateDefinition: reviewEnabledWithoutProfile,
    goal: "missing profile",
    scope: ["plugins"],
    risk: { risk: 1, uncertainty: 1, blastRadius: 1, irreversibility: 0, evidenceGap: 1 }
  }), /review-enabled policy requires reviewProfile/);

  const reviewNoneWithProfile = structuredClone(template);
  reviewNoneWithProfile.controlPlane.reviewPolicy = "none";
  delete reviewNoneWithProfile.controlPlane.workUnitPolicy;
  delete reviewNoneWithProfile.controlPlane.reviewLanes;
  assert.throws(() => buildContract({
    template: "review-none-with-profile",
    templateDefinition: reviewNoneWithProfile,
    goal: "extraneous profile",
    scope: ["plugins"],
    risk: { risk: 1, uncertainty: 1, blastRadius: 1, irreversibility: 0, evidenceGap: 1 }
  }), /reviewProfile is not allowed when review policy is none/);
});

test("review profile validation prevents capability escalation by template editing", () => {
  const legacy = {
    schemaVersion: 1,
    id: "review-contract-v1",
    changedSurfaceAccounting: "diff-manifest-v1",
    anchorResolution: "package-bound-location-v1",
    findingVerification: "broad-review-v1",
    provenanceBinding: "review-package-v1",
    specBinding: "instruction-digest-v1"
  };
  assert.doesNotThrow(() => validateReviewProfile(legacy, {
    template: "pr-to-dev",
    reviewPolicy: "code-v1"
  }));
  assert.throws(() => validateReviewProfile({
    ...legacy,
    anchorResolution: "exact-quote-v1"
  }, {
    template: "pr-to-dev",
    reviewPolicy: "code-v1"
  }), /capability set is invalid/);
  assert.throws(() => validateReviewProfile({
    ...legacy,
    id: "review-kernel-v2-pilot",
    changedSurfaceAccounting: "work-unit-accounting-v1",
    anchorResolution: "exact-quote-v1",
    findingVerification: "finder-verifier-v1",
    provenanceBinding: "host-attested-native-v1"
  }, {
    template: "pr-to-dev",
    reviewPolicy: "code-v2-pilot"
  }), /restricted to self-improve-ops/);
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
    "remote-sync",
    "actions-cleanup-plan"
  ]) {
    assert.ok(template.requiredEvidence.includes(evidence), evidence);
  }
  for (const action of ["git.commit", "plugin.cache.publish", "git.push", "pr.create", "pr.merge", "remote.sync", "worktree.cleanup"]) {
    assert.ok(Object.hasOwn(template.actionGates, action), action);
    assert.ok(template.actionGates[action].length > 0, action);
  }
  assert.ok(template.actionGates["worktree.cleanup"].includes("actions-cleanup-plan"));
  assert.ok(!template.actionGates["worktree.cleanup"].includes("cleanup-manifest"));
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

test("self improve keeps strict holdout and delegates delivery side effects", async () => {
  const template = JSON.parse(
    await readFile(path.join(pluginRoot(), "templates", "self-improve-ops.json"), "utf8")
  );
  assert.equal(template.defaultMode, "critical");
  assert.equal(template.controlPlane.reviewPolicy, "code-v2-pilot");
  assert.equal(template.reviewProfile.id, "review-kernel-v2-pilot");
  assert.equal(template.reviewProfile.changedSurfaceAccounting, "work-unit-accounting-v1");
  assert.equal(template.reviewProfile.anchorResolution, "exact-quote-v1");
  assert.equal(template.reviewProfile.findingVerification, "finder-verifier-v1");
  assert.equal(template.reviewProfile.provenanceBinding, "host-attested-native-v1");
  assert.equal(template.controlPlane.workUnitPolicy, "diff-files-v1");
  assert.equal(template.requiredEvidence.includes("patch-review"), false);
  assert.deepEqual(
    template.executionStages.find((stage) => stage.id === "sync-review")?.requiredEvidence,
    ["sync-matrix", "work-unit-accounting", "review-kernel-summary", "repo-gates"]
  );
  for (const evidence of [
    "retrospective-source-inventory",
    "evaluation-suite",
    "training-replay",
    "candidate-staging",
    "holdout-comparison",
    "recurrence-matrix",
    "decision-record",
    "sync-matrix",
    "work-unit-accounting",
    "review-kernel-summary",
    "plugin-version",
    "cache-check",
    "cache-publication",
    "remote-reconciliation"
  ]) {
    assert.ok(template.requiredEvidence.includes(evidence), evidence);
  }
  for (const policy of [
    "first-class-no-change",
    "sanitized-evaluation-suite",
    "train-holdout-isolation",
    "staged-candidate-before-commit",
    "strict-holdout-improvement",
    "versioned-safety-remediation-policy",
    "versioned-quality-remediation-policy",
    "control-plane-v2-evaluator-coverage",
    "host-attested-codex-only",
    "root-signed-standing-evaluator-consent",
    "no-automatic-adoption",
    "thin-workflow-composition",
    "stale-versioned-link-resolution",
    "no-mutation-of-stale-cache",
    "selector-template-catalog-test-doc-sync",
    "new-version-before-publication",
    "immutable-cache-exact-digest",
    "independent-action-authority",
    "delegated-delivery-boundary"
  ]) {
    assert.ok(template.policyGates.includes(policy), policy);
  }
  assert.deepEqual(template.actionGates, {});
  assert.deepEqual(template.actionStages, {});
  assert.deepEqual(template.deferredActions, ["git.commit", "plugin.cache.publish", "git.push"]);
  assert.ok(template.acceptance.some((item) => item.id === "outcome-explicit"));
  assert.ok(template.acceptance.some((item) => item.id === "heldout-gated"));
  assert.ok(template.acceptance.some((item) => item.id === "cache-immutable"));
  assert.ok(template.acceptance.some((item) => item.id === "delivery-reconciled"));
  assert.equal(template.executionStages.at(-1).id, "delivery-handoff");
});

test("deliberation roster separates model brands from the Agy transport with a 24-hour lease", async () => {
  const roster = JSON.parse(
    await readFile(path.join(pluginRoot(), "config", "deliberation-roster.json"), "utf8")
  );
  assert.equal(roster.schemaVersion, 3);
  assert.deepEqual(
    roster.terminology.modelBrands,
    ["Codex", "Claude", "Gemini", "GPT-OSS", "Grok", "Cursor", "Kimi", "Qwen", "Kiro"]
  );
  assert.equal(roster.terminology.transportCommand, "agy");
  assert.deepEqual(roster.terminology.transportModelBrands, ["Gemini", "Claude", "GPT-OSS"]);
  assert.equal(roster.terminology.transportIsModelBrand, false);
  assert.equal(roster.rosterCacheHours, 24);
  const providers = new Map(roster.providers.map((provider) => [provider.id, provider]));
  for (const id of ["codex", "claude", "gemini", "agy", "grok", "cursor", "kimi", "qwen", "kiro"]) {
    assert.ok(providers.has(id), id);
  }
  assert.equal(providers.get("gemini").command, "agy");
  assert.equal(providers.get("gemini").probe, "agy");
  assert.equal(providers.get("gemini").effortTransport, "native");
  assert.equal(
    providers.get("agy").models.find((model) => model.model === "claude-opus-4-6-thinking").brand,
    "Claude"
  );
  assert.equal(
    providers.get("agy").models.find((model) => model.model === "gpt-oss-120b-medium").brand,
    "GPT-OSS"
  );
  assert.ok(providers.get("agy").models.every((model) => model.brand !== "Agy"));
  assert.deepEqual(
    [...new Set(roster.providers.flatMap((provider) => provider.models.map((model) => model.brand)))].sort(),
    [...roster.terminology.modelBrands].sort()
  );
  assert.deepEqual(
    [...new Set(
      roster.providers
        .filter((provider) => provider.command === roster.terminology.transportCommand)
        .flatMap((provider) => provider.models.map((model) => model.brand))
    )].sort(),
    [...roster.terminology.transportModelBrands].sort()
  );
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
    "verified",
    "workspace-recipe"
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
  assert.match(main, /`direct` therefore uses a persistent goal without\s+creating a Better Workflows journal/);
  assert.match(main, /workspace preflight above still\s+applies to explicit Direct/);
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
  assert.equal(VERSION, packageManifest.version);
});
