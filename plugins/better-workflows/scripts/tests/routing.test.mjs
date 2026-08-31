import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  unlink,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assessAutoRisk,
  capabilitySnapshot,
  claimRouteReceipt,
  installPersonalRoutingProfile,
  previewRoute,
  recordRouteReceipt,
  validateRouteReceipt,
  validateRoutingProfile
} from "../lib/routing.mjs";
import { bundleDigest } from "../lib/publication.mjs";
import { digestObject } from "../lib/core.mjs";

const execFileAsync = promisify(execFile);

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), "sbw-routing-workspace-"));
}

async function gitWorkspace() {
  const cwd = await workspace();
  await execFileAsync("git", ["init", "-q", "-b", "feature"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Better Workflows Tests"], { cwd });
  await execFileAsync("git", ["config", "user.email", "routing-tests@example.invalid"], { cwd });
  await writeFile(path.join(cwd, "app.txt"), "base\n");
  await execFileAsync("git", ["add", "app.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd });
  return cwd;
}

async function writeProfile(root, profile) {
  await mkdir(path.join(root, ".better-workflows"), { recursive: true });
  await writeFile(
    path.join(root, ".better-workflows", "profile.json"),
    `${JSON.stringify(profile, null, 2)}\n`
  );
}

async function writeLegacyProfile(root, profile) {
  await mkdir(path.join(root, ".codex"), { recursive: true });
  await writeFile(
    path.join(root, ".codex", "better-workflows.json"),
    `${JSON.stringify(profile, null, 2)}\n`
  );
}

function profile(rules) {
  return { schemaVersion: 1, rules };
}

function rule(id, {
  priority = 0,
  match = {},
  entry,
  template,
  minimumMode,
  supportSkills = [],
  requiredCapabilities = []
}) {
  return {
    id,
    priority,
    match,
    route: {
      ...(entry ? { entry } : { template }),
      ...(minimumMode ? { minimumMode } : {}),
      supportSkills,
      requiredCapabilities
    }
  };
}

test("route precedence is explicit, workspace, personal, then built-in auto", async () => {
  const cwd = await workspace();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-routing-state-"));
  await writeProfile(
    cwd,
    profile([
      rule("workspace-pr", {
        priority: 10,
        match: { keywords: ["merge"] },
        entry: "pr-to-dev",
        minimumMode: "critical"
      })
    ])
  );
  await mkdir(path.join(stateRoot, "routing"));
  await writeFile(
    path.join(stateRoot, "routing", "profile.json"),
    `${JSON.stringify(
      profile([
        rule("personal-research", {
          match: { keywords: ["merge"] },
          entry: "research",
          minimumMode: "deep"
        })
      ])
    )}\n`
  );

  const workspaceRoute = await previewRoute({
    cwd,
    stateRoot,
    goal: "merge this change",
    scope: ["src"]
  });
  assert.equal(workspaceRoute.source, "workspace-profile");
  assert.equal(workspaceRoute.primary.entry, "pr-to-dev");
  assert.equal(workspaceRoute.effectiveMode, "critical");
  assert.deepEqual(workspaceRoute.ignoredOverrides, ["personal-profile:personal-research"]);

  const explicit = await previewRoute({
    cwd,
    stateRoot,
    goal: "merge this change",
    scope: ["src"],
    entry: "research",
    mode: "direct"
  });
  assert.equal(explicit.source, "explicit-entry");
  assert.equal(explicit.primary.entry, "research");
  assert.equal(explicit.effectiveMode, "deep");

  const personalFallback = await previewRoute({
    cwd,
    stateRoot,
    goal: "research architecture",
    scope: ["src"]
  });
  assert.equal(personalFallback.source, "built-in-auto");
  assert.equal(personalFallback.primary.template, null);
  assert.equal(personalFallback.needsSelection, true);
});

test("route preview exposes a stable interaction fingerprint without granting action authority", async () => {
  const cwd = await workspace();
  const stateRoot = path.join(cwd, "state");
  const first = await previewRoute({
    cwd,
    stateRoot,
    goal: "review a bounded source change",
    scope: ["src", "tests"],
    mutationIntent: "read-only",
    acceptanceDefined: true,
    interactionMode: "auto"
  });
  const second = await previewRoute({
    cwd,
    stateRoot,
    goal: "review a bounded source change",
    scope: ["tests", "src"],
    mutationIntent: "read-only",
    acceptanceDefined: true,
    interactionMode: "auto"
  });
  assert.equal(first.interactionAuthorization.decision, "requires-user");
  assert.equal(first.interactionAuthorization.reason, "missing-standing-directive");
  assert.equal(first.interactionAuthorization.grantsActionAuthority, false);
  assert.equal(first.interactionAuthorization.technicalGatesRequired, true);
  assert.equal(first.interactionAuthorization.requestDigest, second.interactionAuthorization.requestDigest);
  assert.equal(first.bindings.interactionScopeDigest, second.bindings.interactionScopeDigest);
});

test("workspace non-match falls back to personal and matching uses category AND with value OR", async () => {
  const cwd = await workspace();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-routing-personal-"));
  await writeProfile(
    cwd,
    profile([
      rule("workspace-other", {
        match: { keywords: ["release"] },
        entry: "ci-release"
      })
    ])
  );
  await mkdir(path.join(stateRoot, "routing"));
  await writeFile(
    path.join(stateRoot, "routing", "profile.json"),
    `${JSON.stringify(
      profile([
        rule("first-equal-priority", {
          priority: 20,
          match: {
            keywords: ["refactor", "architecture"],
            domains: ["monorepo"],
            tags: ["maintenance", "cleanup"]
          },
          entry: "monorepo-refactor",
          minimumMode: "deep"
        }),
        rule("second-equal-priority", {
          priority: 20,
          match: {
            keywords: ["architecture"],
            domains: ["monorepo"],
            tags: ["cleanup"]
          },
          entry: "research"
        })
      ])
    )}\n`
  );
  const route = await previewRoute({
    cwd,
    stateRoot,
    goal: "architecture cleanup",
    scope: ["packages/core"],
    domains: ["monorepo"],
    tags: ["cleanup"]
  });
  assert.equal(route.source, "personal-profile");
  assert.equal(route.profileRule, "first-equal-priority");
  assert.equal(route.primary.entry, "monorepo-refactor");
});

test("missing optional support is excluded while a missing required capability blocks", async () => {
  const cwd = await workspace();
  const stateRoot = path.join(cwd, "missing-state");
  await writeProfile(
    cwd,
    profile([
      rule("capabilities", {
        match: {},
        entry: "review-issues",
        supportSkills: ["definitely-not-installed"],
        requiredCapabilities: ["mcp:host-tools"]
      })
    ])
  );
  const route = await previewRoute({ cwd, stateRoot, goal: "review", scope: ["."] });
  assert.equal(route.ok, false);
  assert.deepEqual(route.advisorySupportSkills, []);
  assert.equal(route.excludedSupportSkills[0].skill, "definitely-not-installed");
  assert.ok(route.blockers.includes("mcp:host-tools:unsupported"));
});

test("capability snapshot is cache-only and leaves a missing state root untouched", async () => {
  const cwd = await workspace();
  const stateRoot = path.join(cwd, "never-created");
  const snapshot = await capabilitySnapshot({
    cwd,
    stateRoot,
    requiredCapabilities: ["provider:agy", "command:node"]
  });
  assert.ok(snapshot.blockers.includes("provider:agy:requires-authority"));
  assert.equal(
    snapshot.capabilities.find((item) => item.id === "command:node").status,
    "available"
  );
  await assert.rejects(access(stateRoot));
});

test("capability snapshot resolves and fingerprints a callable symlink command without invoking it", async () => {
  const cwd = await workspace();
  const bin = path.join(cwd, "bin");
  await mkdir(bin);
  const target = path.join(bin, "real-tool");
  const marker = path.join(cwd, "must-not-exist");
  await writeFile(
    target,
    `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\n`,
    { mode: 0o755 }
  );
  await symlink(target, path.join(bin, "linked-tool"));
  const snapshot = await capabilitySnapshot({
    cwd,
    stateRoot: path.join(cwd, "state"),
    env: { ...process.env, PATH: bin },
    requiredCapabilities: ["command:linked-tool"]
  });
  const capability = snapshot.capabilities[0];
  assert.equal(capability.status, "available");
  assert.equal(capability.fingerprint.resolvedPath, await realpath(target));
  assert.equal(typeof capability.fingerprint.digest, "string");
  await assert.rejects(access(marker));
});

test("routing accepts a digest-bound schema-v2 ready marker for a cached skill", async () => {
  const cwd = await workspace();
  const codexHome = path.join(cwd, "codex-home");
  const version = "3.0.0+test.routing-v2";
  const cachePluginRoot = path.join(codexHome, "plugins", "cache", "better-workflows", "better-workflows");
  const target = path.join(cachePluginRoot, version);
  const skillPath = path.join(target, "skills", "cached-advisor", "SKILL.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, "# Cached advisor\n");
  const targetDigest = await bundleDigest(target);
  const stateRoot = path.join(cwd, "state");
  const runId = "sbw-20260804T000000Z-000000000000";
  const attemptId = "sbw-routing-v2-attempt";
  const sourceBinding = {
    baseRevision: "b".repeat(40),
    headRevision: "c".repeat(40),
    digest: "d".repeat(64)
  };
  const providerReceipt = {
    action: "plugin.cache.publish",
    provider: "local-workspace",
    resource: `plugin-cache:${sourceBinding.headRevision}`,
    outcome: "success",
    runId,
    attemptId,
    idempotencyKey: "sbw-routing-v2-idempotency",
    remoteRevision: "routing-v2-remote",
    executionId: `local-workspace:plugin.cache.publish:${attemptId}`,
    proofKind: "local-workspace:plugin.cache.publish",
    requestDigest: "f".repeat(64),
    responseDigest: "0".repeat(64),
    verifiedAt: "2026-08-04T00:00:00.000Z",
    terminalState: "success",
    cacheRoot: cachePluginRoot,
    version,
    target,
    sourceDigest: targetDigest,
    targetDigest,
    sourceBaselineRevision: sourceBinding.baseRevision,
    sourceHeadRevision: sourceBinding.headRevision,
    sourceBindingDigest: sourceBinding.digest,
    pluginBundleDigest: targetDigest,
    applied: true,
    noOp: false
  };
  await mkdir(path.join(stateRoot, "runs", runId, "actions"), { recursive: true });
  await writeFile(path.join(stateRoot, "runs", runId, "manifest.json"), `${JSON.stringify({
    pluginCacheRoot: cachePluginRoot,
    sourceBinding
  })}\n`);
  await writeFile(path.join(stateRoot, "runs", runId, "contract.json"), "{}\n");
  await writeFile(path.join(stateRoot, "runs", runId, "state.json"), "{}\n");
  const actionProof = {
    schemaVersion: 1,
    runId,
    actionAttemptId: attemptId,
    action: "plugin.cache.publish",
    provider: "local-workspace",
    resource: `plugin-cache:${sourceBinding.headRevision}`,
    outcome: "success",
    idempotencyKey: providerReceipt.idempotencyKey,
    remoteRevision: providerReceipt.remoteRevision,
    providerExecutionId: providerReceipt.executionId,
    providerReceiptDigest: digestObject(providerReceipt)
  };
  await mkdir(path.join(stateRoot, "runs", runId, "evidence"), { recursive: true });
  await writeFile(path.join(stateRoot, "runs", runId, "evidence", "cache-publication-routing-v2.json"), `${JSON.stringify({
    id: "cache-publication-routing-v2",
    status: "complete",
    stale: false,
    receipt: {
      payload: {
        provider: "local-workspace",
        actionProof,
        receipt: providerReceipt
      }
    }
  })}\n`);
  await writeFile(path.join(stateRoot, "runs", runId, "actions", "routing-v2-action.json"), `${JSON.stringify({
    runId,
    attemptId,
    action: "plugin.cache.publish",
    provider: "local-workspace",
    status: "spent",
    outcome: "success",
    receipt: {
      outcome: "success",
      evidenceIds: ["cache-publication-routing-v2"],
      providerReceipt
    }
  })}\n`);
  const marker = {
    schemaVersion: 2,
    state: "ready",
    version,
    target,
    targetDigest,
    sourceDigest: targetDigest,
    sourceBaselineRevision: sourceBinding.baseRevision,
    sourceHeadRevision: sourceBinding.headRevision,
    sourceBindingDigest: sourceBinding.digest,
    pluginBundleDigest: targetDigest,
    runId,
    attemptId,
    providerReceiptDigest: digestObject(providerReceipt)
  };
  const writeMarker = async (overrides = {}) => writeFile(
    path.join(cachePluginRoot, `${version}.ready.json`),
    `${JSON.stringify({ ...marker, ...overrides }, null, 2)}\n`
  );
  const snapshot = async () => capabilitySnapshot({
    cwd,
    stateRoot,
    env: { ...process.env, CODEX_HOME: codexHome },
    requiredCapabilities: ["skill:cached-advisor"]
  });
  const writeAction = async (evidenceIds = ["cache-publication-routing-v2"]) => writeFile(
    path.join(stateRoot, "runs", runId, "actions", "routing-v2-action.json"),
    `${JSON.stringify({
      runId,
      attemptId,
      action: "plugin.cache.publish",
      provider: "local-workspace",
      status: "spent",
      outcome: "success",
      receipt: {
        outcome: "success",
        evidenceIds,
        providerReceipt
      }
    })}\n`
  );
  await writeMarker();
  const available = (await snapshot()).capabilities.find((item) => item.id === "skill:cached-advisor");
  assert.equal(available.status, "available");
  assert.equal(available.source, skillPath);
  assert.equal(typeof available.fingerprint.digest, "string");
  await writeAction(["missing-evidence"]);
  const missingEvidence = (await snapshot()).capabilities.find((item) => item.id === "skill:cached-advisor");
  assert.equal(missingEvidence.status, "unavailable");
  await writeAction();
  await writeFile(
    path.join(cachePluginRoot, `${version}.ready.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      state: "ready",
      version,
      target,
      targetDigest
    })}\n`
  );
  const legacyMarker = (await snapshot()).capabilities.find((item) => item.id === "skill:cached-advisor");
  assert.equal(legacyMarker.status, "unavailable");
  await writeMarker();
  await unlink(path.join(cachePluginRoot, `${version}.ready.json`));
  const missingMarker = (await snapshot()).capabilities.find((item) => item.id === "skill:cached-advisor");
  assert.equal(missingMarker.status, "unavailable");
  await writeMarker();
  for (const overrides of [
    { sourceDigest: "a".repeat(64) },
    { pluginBundleDigest: "a".repeat(64) },
    { sourceBaselineRevision: marker.sourceHeadRevision },
    { sourceBindingDigest: "a".repeat(64) },
    { runId: "sbw-20260804T000000Z-000000000001" },
    { attemptId: "sbw-routing-v2-other-attempt" },
    { providerReceiptDigest: "a".repeat(64) }
  ]) {
    await writeMarker(overrides);
    const unavailable = (await snapshot()).capabilities.find((item) => item.id === "skill:cached-advisor");
    assert.equal(unavailable.status, "unavailable");
  }
});

test("capability and receipt digests change when an installed support skill changes in place", async () => {
  const cwd = await workspace();
  const stateRoot = path.join(cwd, "state");
  const skillDirectory = path.join(cwd, ".codex", "skills", "local-advisor");
  await mkdir(skillDirectory, { recursive: true });
  const skillPath = path.join(skillDirectory, "SKILL.md");
  await writeFile(skillPath, "# Local advisor\nversion one\n");
  await writeProfile(
    cwd,
    profile([
      rule("local-support", {
        match: {},
        entry: "review-issues",
        supportSkills: ["local-advisor"]
      })
    ])
  );
  const preview = await previewRoute({ cwd, stateRoot, goal: "review", scope: ["."] });
  const receipt = await recordRouteReceipt({ stateRoot, cwd, preview });
  await writeFile(skillPath, "# Local advisor\nversion two\n");
  const changed = await previewRoute({ cwd, stateRoot, goal: "review", scope: ["."] });
  assert.notEqual(changed.bindings.capabilityDigest, preview.bindings.capabilityDigest);
  await assert.rejects(
    validateRouteReceipt({ stateRoot, cwd, receiptId: receipt.receiptId }),
    /capabilityDigest/
  );
});

test("profile schema rejects unknown keys, excess support, and unsafe workspace symlinks", async () => {
  assert.throws(
    () =>
      validateRoutingProfile({
        schemaVersion: 1,
        unknown: true,
        rules: [rule("valid", { match: {}, entry: "auto" })]
      }),
    /unknown keys/
  );
  assert.throws(
    () =>
      validateRoutingProfile(
        profile([
          rule("too-many", {
            match: {},
            entry: "auto",
            supportSkills: ["one", "two", "three", "four"]
          })
        ])
      ),
    /exceeds 3 items/
  );
  const cwd = await workspace();
  const outside = await workspace();
  await writeFile(
    path.join(outside, "profile.json"),
    `${JSON.stringify(profile([rule("outside", { match: {}, entry: "auto" })]))}\n`
  );
  await symlink(outside, path.join(cwd, ".codex"));
  await assert.rejects(
    previewRoute({
      cwd,
      stateRoot: path.join(cwd, "state"),
      goal: "anything",
      scope: ["."]
    }),
    /symlink/
  );
});

test("personal Profile installation is relative, atomic, private, and immediately readable", async () => {
  const cwd = await workspace();
  const stateRoot = path.join(cwd, "state");
  const profileFile = "personal-profile.json";
  await writeFile(
    path.join(cwd, profileFile),
    `${JSON.stringify(
      profile([
        rule("personal-review", {
          match: { keywords: ["review"] },
          entry: "review-issues",
          minimumMode: "verified"
        })
      ])
    )}\n`
  );
  const installed = await installPersonalRoutingProfile({
    cwd,
    stateRoot,
    file: profileFile
  });
  assert.equal((await stat(installed.target)).mode & 0o777, 0o600);
  const route = await previewRoute({ cwd, stateRoot, goal: "review src", scope: ["src"] });
  assert.equal(route.source, "personal-profile");
  await assert.rejects(
    installPersonalRoutingProfile({ cwd, stateRoot, file: path.join(cwd, profileFile) }),
    /relative path/
  );
});

test("route receipts bind profiles and capabilities, expire safely, and are single-use", async () => {
  const cwd = await workspace();
  const stateRoot = path.join(cwd, "state");
  await writeProfile(
    cwd,
    profile([
      rule("review", {
        match: { keywords: ["review"] },
        entry: "review-issues",
        minimumMode: "verified"
      })
    ])
  );
  const preview = await previewRoute({ cwd, stateRoot, goal: "review src", scope: ["src"] });
  const recorded = await recordRouteReceipt({ stateRoot, cwd, preview });
  const valid = await validateRouteReceipt({
    stateRoot,
    cwd,
    receiptId: recorded.receiptId
  });
  assert.equal(valid.preview.routeDigest, preview.routeDigest);
  await claimRouteReceipt({ stateRoot, receiptId: recorded.receiptId });
  await assert.rejects(
    validateRouteReceipt({ stateRoot, cwd, receiptId: recorded.receiptId }),
    /already claimed/
  );

  const resumable = await recordRouteReceipt({ stateRoot, cwd, preview });
  const claimant = {
    kind: "direct-workspace-v1",
    ownershipNonce: "0123456789abcdef0123456789abcdef",
    repositoryId: "0123456789abcdef",
    taskId: "task-direct-claim"
  };
  const firstClaim = await claimRouteReceipt({
    stateRoot,
    receiptId: resumable.receiptId,
    claimant
  });
  assert.equal(firstClaim.resumed, false);
  const resumedClaim = await claimRouteReceipt({
    stateRoot,
    receiptId: resumable.receiptId,
    claimant
  });
  assert.equal(resumedClaim.resumed, true);
  const resumedValidation = await validateRouteReceipt({
    stateRoot,
    cwd,
    receiptId: resumable.receiptId,
    expectedClaimant: claimant
  });
  assert.equal(resumedValidation.claim.claimant.taskId, claimant.taskId);
  await assert.rejects(
    validateRouteReceipt({
      stateRoot,
      cwd,
      receiptId: resumable.receiptId,
      expectedClaimant: { ...claimant, taskId: "task-other-claim" }
    }),
    /different consumer/
  );

  const secondPreview = await previewRoute({
    cwd,
    stateRoot,
    goal: "review again",
    scope: ["src"]
  });
  const second = await recordRouteReceipt({ stateRoot, cwd, preview: secondPreview });
  const rawProfile = JSON.parse(
    await readFile(path.join(cwd, ".better-workflows", "profile.json"), "utf8")
  );
  rawProfile.rules[0].priority = 999;
  await writeProfile(cwd, rawProfile);
  await assert.rejects(
    validateRouteReceipt({ stateRoot, cwd, receiptId: second.receiptId }),
    /profileDigest/
  );

  const thirdPreview = await previewRoute({
    cwd,
    stateRoot,
    goal: "review expiry",
    scope: ["src"]
  });
  const third = await recordRouteReceipt({ stateRoot, cwd, preview: thirdPreview });
  const expired = JSON.parse(await readFile(third.path, "utf8"));
  expired.expiresAt = "2000-01-01T00:00:00.000Z";
  await writeFile(third.path, `${JSON.stringify(expired, null, 2)}\n`);
  await assert.rejects(
    validateRouteReceipt({ stateRoot, cwd, receiptId: third.receiptId }),
    /expired/
  );
});

test("legacy Codex workspace Profiles remain a single-path fallback and ambiguity fails closed", async () => {
  const cwd = await workspace();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-routing-legacy-profile-"));
  const legacy = profile([
    rule("legacy-review", { match: { keywords: ["legacy"] }, entry: "review-issues" })
  ]);
  await writeLegacyProfile(cwd, legacy);
  const fallback = await previewRoute({ cwd, stateRoot, goal: "legacy review", scope: ["."] });
  assert.equal(fallback.source, "workspace-profile");
  assert.equal(fallback.profileRule, "legacy-review");

  await writeProfile(cwd, legacy);
  await assert.rejects(
    previewRoute({ cwd, stateRoot, goal: "legacy review", scope: ["."] }),
    /Both v4 .* and legacy .* exist/
  );
});

test("workspace Profile discovery is anchored to the canonical Git root", async () => {
  const root = await gitWorkspace();
  const nested = path.join(root, "packages", "feature");
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-routing-git-root-profile-"));
  await mkdir(nested, { recursive: true });
  await writeProfile(root, profile([
    rule("root-review", { match: { keywords: ["root"] }, entry: "review-issues" })
  ]));
  const preview = await previewRoute({ cwd: nested, stateRoot, goal: "root review", scope: ["."] });
  assert.equal(preview.source, "workspace-profile");
  assert.equal(preview.profileRule, "root-review");
});

test("AutoRiskAssessmentV1 admits Direct only within every low-risk boundary", async () => {
  const cwd = await workspace();
  const direct = await assessAutoRisk({
    cwd,
    goal: "Rename one local label",
    scope: ["src/label.txt"],
    acceptanceDefined: true,
    mutationIntent: "modify",
    risk: {
      risk: 1,
      uncertainty: 0,
      blastRadius: 1,
      irreversibility: 0,
      evidenceGap: 0
    },
    basicCheckPlan: ["node --test label.test.mjs"]
  });
  assert.equal(direct.kind, "AutoRiskAssessmentV1");
  assert.equal(direct.decision, "direct-fast-path");
  assert.equal(direct.riskTotal, 2);
  assert.equal(direct.workspaceLifecycle, "not-applicable");
  assert.deepEqual(direct.reasonCodes, ["direct-threshold-satisfied"]);
  assert.match(direct.assessmentDigest, /^[a-f0-9]{64}$/);

  const unassessed = await assessAutoRisk({
    cwd,
    goal: "Do not infer missing risk scores",
    scope: ["src/label.txt"],
    acceptanceDefined: true,
    mutationIntent: "modify",
    risk: { risk: 0, irreversibility: 0 }
  });
  assert.equal(unassessed.decision, "evidence-required");
  assert.equal(unassessed.uncertainty, 3);
  assert.ok(unassessed.reasonCodes.includes("uncertainty-above-direct-limit"));
  assert.ok(unassessed.reasonCodes.includes("basic-check-plan-undefined"));

  for (const input of [
    { acceptanceDefined: false, expected: "acceptance-undefined" },
    { mutationIntent: "unknown", expected: "mutation-intent-unknown" },
    { risk: { risk: 1, uncertainty: 1, blastRadius: 1, irreversibility: 0, evidenceGap: 0 }, expected: "risk-total-above-direct-limit" },
    { risk: { risk: 0, uncertainty: 0, blastRadius: 0, irreversibility: 1, evidenceGap: 0 }, expected: "irreversibility-nonzero" },
    { hardExclusions: ["credential"], expected: "hard-exclusion:credential" },
    { protectedTarget: true, expected: "protected-target" },
    { integrationTarget: "origin/dev", expected: "remote-target" },
    { routeConstraint: true, expected: "explicit-route-or-mode-constraint" }
  ]) {
    const assessment = await assessAutoRisk({
      cwd,
      goal: "Bounded change",
      scope: ["src"],
      acceptanceDefined: input.acceptanceDefined ?? true,
      mutationIntent: input.mutationIntent ?? "modify",
      risk: input.risk ?? {},
      hardExclusions: input.hardExclusions ?? [],
      protectedTarget: input.protectedTarget ?? false,
      integrationTarget: input.integrationTarget ?? null,
      routeConstraint: input.routeConstraint ?? false
    });
    assert.equal(assessment.decision, "evidence-required");
    assert.ok(assessment.reasonCodes.includes(input.expected));
  }
});

test("Auto Direct rejects a basic check plan that cannot be executed by the bounded runner", async () => {
  const cwd = await workspace();
  await assert.rejects(
    assessAutoRisk({
      cwd,
      goal: "bounded change",
      acceptanceDefined: true,
      mutationIntent: "modify",
      integrationTarget: "feature",
      risk: { risk: 0, uncertainty: 0, blastRadius: 0, irreversibility: 0, evidenceGap: 0 },
      basicCheckPlan: Array.from({ length: 17 }, (_, index) => `check-${index}`)
    }),
    /exceeds 16 items/
  );
  await assert.rejects(
    assessAutoRisk({
      cwd,
      goal: "bounded change",
      acceptanceDefined: true,
      mutationIntent: "modify",
      integrationTarget: "feature",
      risk: { risk: 0, uncertainty: 0, blastRadius: 0, irreversibility: 0, evidenceGap: 0 },
      basicCheckPlan: ["looks fine\nbut is not one line"]
    }),
    /one-line names/
  );
});

test("Auto Direct requires an existing local integration target and explicit booleans", async () => {
  const cwd = await gitWorkspace();
  const base = {
    cwd,
    goal: "Bounded Git change",
    scope: ["app.txt"],
    acceptanceDefined: true,
    mutationIntent: "modify",
    risk: { risk: 0, uncertainty: 0, blastRadius: 0, irreversibility: 0, evidenceGap: 0 },
    basicCheckPlan: ["targeted app check"]
  };
  const missing = await assessAutoRisk({ ...base, integrationTarget: "missing-target" });
  assert.equal(missing.decision, "evidence-required");
  assert.equal(missing.integrationTargetRevision, null);
  assert.ok(missing.reasonCodes.includes("integration-target-unverified"));

  const existing = await assessAutoRisk({ ...base, integrationTarget: "feature" });
  assert.equal(existing.decision, "direct-fast-path");
  assert.match(existing.integrationTargetRevision, /^[a-f0-9]{40}$/);

  await assert.rejects(
    assessAutoRisk({ ...base, acceptanceDefined: "yes", integrationTarget: "feature" }),
    /explicit booleans/
  );
});

test("built-in Auto returns a reviewable Direct route only when acceptance and mutation intent are explicit", async () => {
  const cwd = await workspace();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-routing-direct-"));
  const direct = await previewRoute({
    cwd,
    stateRoot,
    goal: "Update one local label",
    scope: ["label.txt"],
    acceptanceDefined: true,
    mutationIntent: "modify",
    risk: { risk: 1, uncertainty: 0, blastRadius: 0, irreversibility: 0, evidenceGap: 0 },
    basicCheckPlan: ["targeted label test"]
  });
  assert.equal(direct.source, "built-in-auto");
  assert.equal(direct.effectiveMode, "direct");
  assert.equal(direct.needsSelection, false);
  assert.equal(direct.autoRiskAssessment.decision, "direct-fast-path");

  const protectedRoute = await previewRoute({
    cwd,
    stateRoot,
    goal: "Update one local label",
    scope: ["label.txt"],
    acceptanceDefined: true,
    mutationIntent: "modify",
    integrationTarget: "dev",
    protectedTarget: true
  });
  assert.equal(protectedRoute.needsSelection, true);
  assert.equal(protectedRoute.autoRiskAssessment.decision, "evidence-required");
  assert.ok(protectedRoute.autoRiskAssessment.reasonCodes.includes("protected-target"));
});
