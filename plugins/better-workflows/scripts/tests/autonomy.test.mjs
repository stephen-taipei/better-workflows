import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertAutonomyAction,
  autonomyProfileDigest,
  buildAutonomyBinding,
  buildAutonomyDecisionReceipt,
  decideAutonomyAction,
  loadAutonomyProfile,
  validateAutonomyProfile
} from "../lib/autonomy.mjs";
import { buildContract } from "../lib/core.mjs";
import { hostBundleDigest, hostBundleFromStatus } from "../lib/host-bundle.mjs";

test("bounded-autopilot-v1 is canonical and digestable", async () => {
  const profile = await loadAutonomyProfile();
  assert.equal(profile.id, "bounded-autopilot-v1");
  assert.equal(profile.scope.pullRequestBase, "dev");
  assert.equal(profile.limits.maxPullRequests, 1);
  assert.match(autonomyProfileDigest(profile), /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => validateAutonomyProfile(profile));
});

test("autonomy action matrix keeps codex push and dev PR automatic", async () => {
  const profile = await loadAutonomyProfile();
  assert.equal(decideAutonomyAction(profile, "git.commit").decision, "auto-approved");
  assert.equal(
    decideAutonomyAction(profile, "git.push", { resource: "remote:origin:refs/heads/codex/feature" }).decision,
    "auto-approved"
  );
  assert.equal(decideAutonomyAction(profile, "pr.create", { scope: "dev" }).decision, "auto-approved");
  assert.equal(
    decideAutonomyAction(profile, "git.push", { resource: "remote:origin:refs/heads/dev" }).decision,
    "requires-human"
  );
  assert.equal(decideAutonomyAction(profile, "pr.merge", { resource: "pull/1" }).decision, "requires-human");
  assert.throws(() => assertAutonomyAction(profile, "pr.merge", { resource: "pull/1" }), /human approval/);
});

test("autonomy binding is run-scoped and expires", async () => {
  const profile = await loadAutonomyProfile();
  const binding = buildAutonomyBinding(profile);
  assert.equal(binding.id, profile.id);
  assert.equal(binding.profileDigest, autonomyProfileDigest(profile));
  assert.ok(Date.parse(binding.expiresAt) > Date.now());
  assert.throws(
    () => buildAutonomyBinding(profile, { expiresAt: new Date(Date.now() - 1000).toISOString() }),
    /expiry must be in the future/
  );
});

test("autonomy decisions are typed, run-bound, and token-bound receipts", async () => {
  const profile = await loadAutonomyProfile();
  const binding = buildAutonomyBinding(profile, {
    repository: "github.com/stephen-taipei/better-workflows",
    branch: "codex/feature",
    pathScope: ["plugins"]
  });
  const decision = decideAutonomyAction(profile, "git.commit");
  const receipt = buildAutonomyDecisionReceipt({
    runId: "sbw-test-run",
    binding,
    sourceBindingDigest: "a".repeat(64),
    request: { action: "git.commit", resource: "git:commit", scope: "plugins" },
    decision,
    tokenHash: "b".repeat(64)
  });
  assert.equal(receipt.kind, "autonomy-decision");
  assert.equal(receipt.decision, "auto-approved");
  assert.match(receipt.decisionId, /^[a-f0-9]{64}$/);
  assert.equal(receipt.profileDigest, binding.profileDigest);
  assert.equal(receipt.sourceBindingDigest, "a".repeat(64));
});

test("autonomy profile cannot be broadened by local edits", async () => {
  const profile = await loadAutonomyProfile();
  const broadened = structuredClone(profile);
  broadened.autoActions = [...broadened.autoActions, "pr.merge"];
  assert.throws(() => validateAutonomyProfile(broadened), /overlaps|canonical/);
});

test("autonomy profile is delivery-only and rejects non-codex PR or merge authority", async () => {
  const profile = await loadAutonomyProfile();
  assert.equal(decideAutonomyAction(profile, "pr.create", { scope: "main" }).decision, "requires-human");
  assert.equal(decideAutonomyAction(profile, "git.push", { resource: "remote:origin:refs/heads/feature" }).decision, "requires-human");
  assert.equal(decideAutonomyAction(profile, "git.push", { resource: "remote:origin:refs/heads/codex/feature" }).decision, "auto-approved");
  assert.equal(decideAutonomyAction(profile, "deploy").decision, "requires-human");
});

test("TaskContract cannot attach bounded autonomy to another template or protected authority", async () => {
  const profile = await loadAutonomyProfile();
  const binding = buildAutonomyBinding(profile, {
    repository: "github.com/stephen-taipei/better-workflows",
    branch: "codex/feature",
    pathScope: ["plugins"]
  });
  const templateDefinition = {
    name: "pr-to-dev",
    defaultMode: "critical",
    requiredEvidence: ["current-revision"],
    acceptance: [{ id: "complete", description: "Complete", critical: true }],
    actionGates: {}
  };
  assert.doesNotThrow(() => buildContract({
    template: "pr-to-dev",
    templateDefinition,
    goal: "bounded delivery",
    scope: ["plugins"],
    autonomyProfile: binding
  }));
  assert.throws(() => buildContract({
    template: "review-to-issues",
    templateDefinition: { ...templateDefinition, name: "review-to-issues" },
    goal: "invalid autonomy",
    scope: ["plugins"],
    autonomyProfile: binding
  }), /only valid for pr-to-dev/);
  assert.throws(() => buildContract({
    template: "pr-to-dev",
    templateDefinition,
    goal: "protected merge",
    scope: ["plugins"],
    authority: ["pr.merge"],
    autonomyProfile: binding
  }), /outside bounded-autopilot-v1/);
});

test("autonomy denies passwords, unpinned shells, protected pushes, merge, deploy, and cleanup", async () => {
  const profile = await loadAutonomyProfile();
  for (const action of ["password.capture", "sudo.unbounded", "admin.bypass", "shell.unpinned"]) {
    assert.equal(decideAutonomyAction(profile, action).decision, "denied");
  }
  for (const action of ["git.push", "pr.merge", "deploy", "worktree.cleanup"]) {
    const context = action === "git.push" ? { resource: "remote:origin:refs/heads/main" } : {};
    assert.equal(decideAutonomyAction(profile, action, context).decision, "requires-human");
  }
});

test("autonomy binding rejects invalid repository, branch, path, expiry, and limits", async () => {
  const profile = await loadAutonomyProfile();
  assert.throws(() => buildAutonomyBinding(profile, { repository: "evil.example/repo" }), /repository identity/);
  assert.throws(() => buildAutonomyBinding(profile, { branch: "dev" }), /codex scope/);
  assert.throws(() => buildAutonomyBinding(profile, { pathScope: ["../outside"] }), /path scope/);
  const binding = buildAutonomyBinding(profile, { repository: "github.com/stephen-taipei/better-workflows", branch: "codex/feature", pathScope: ["plugins"] });
  assert.throws(() => validateAutonomyProfile({ ...profile, limits: { ...profile.limits, maxFiles: 81 } }), /canonical/);
  assert.throws(() => validateAutonomyProfile({ ...profile, autoActions: [...profile.autoActions, "pr.merge"] }), /canonical|overlaps/);
  assert.equal(binding.repository, "github.com/stephen-taipei/better-workflows");
});

test("root-owned host bundle binding uses protocol artifacts, not repository source bytes", () => {
  const status = {
    signer: { path: "/private/var/db/better-workflows/bin/bw-host-trust.mjs", version: "2.4.0", digest: "a".repeat(64) },
    runtime: { digest: "b".repeat(64) },
    launcher: { digest: "c".repeat(64) },
    readinessReceipt: {
      digest: "d".repeat(64),
      bindingDigest: "e".repeat(64),
      binding: {
        signer: { version: "2.4.0", digest: "a".repeat(64) },
        runtime: { digest: "b".repeat(64) },
        launcher: { digest: "c".repeat(64) }
      }
    }
  };
  const bundle = hostBundleFromStatus(status);
  assert.equal(bundle.runtimeDigest, status.runtime.digest);
  assert.match(hostBundleDigest(bundle), /^[a-f0-9]{64}$/);
});

test("attestation runtime no longer couples ordinary source edits to signer digest", async () => {
  const source = await readFile(new URL("../lib/attestations.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /SOURCE_HOST_TRUST_TOOL/);
  assert.doesNotMatch(source, /signer\.digest !== sourceSignerDigest/);
  assert.match(source, /hostBundle/);
});
