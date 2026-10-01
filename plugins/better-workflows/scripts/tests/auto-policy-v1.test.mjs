// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertInstalledAutoPolicyUnchanged, autoPolicyBinding, autoPolicyDefinition,
  createSourceIntegritySnapshot
} from "../lib/auto-policy-v1.mjs";
import {
  buildContract, createRun, digestObject, executeActionToken,
  issueActionToken, loadRun, reconcileAction, routeMode, sha256,
  validateContract
} from "../lib/core.mjs";
import { buildTemplateGraph, graphHasErrors } from "../lib/graph.mjs";
import {
  assertProtectedDeliveryRequest,
  protectedDeliveryTarget
} from "../lib/protected-delivery.mjs";

function contractFor(id) {
  const policy = autoPolicyDefinition(id);
  const contract = buildContract({
    template: "auto",
    templateDefinition: policy,
    goal: `Exercise ${id}`,
    scope: ["."]
  });
  contract.templateDigest = digestObject(policy);
  return contract;
}

test("each public Auto variant binds a complete immutable policy and minimum mode", () => {
  for (const [id, mode, target] of [
    ["read-only-v1", "verified", null],
    ["code-change-v1", "deep", null],
    ["dev-publish-v1", "critical", "dev"]
  ]) {
    const contract = contractFor(id);
    assert.equal(validateContract(contract), contract);
    assert.equal(routeMode(contract, "auto"), mode);
    assert.equal(protectedDeliveryTarget(contract), target);
    assert.deepEqual(contract.autoPolicy, autoPolicyBinding(id));
    assert.throws(() => routeMode(contract, "direct"), /at least/);
    assert.equal(graphHasErrors(buildTemplateGraph({ template: autoPolicyDefinition(id), sourcePath: "templates/auto.json" })), false);
    if (id === "dev-publish-v1") {
      assert.equal(contract.requiredEvidence.length, 18);
      assert.equal(contract.executionStages.length, 6);
      assert.equal(contract.actionStages["worktree.create"], "inventory-plan");
      assert.deepEqual(contract.actionGates["worktree.create"], ["base-revision", "change-inventory", "repo-gates"]);
      assert.ok(autoPolicyDefinition(id).rootOnlyActions.includes("git worktree add"));
      assert.deepEqual(contract.authority.externalSideEffects, []);
      const explicitlyAuthorized = buildContract({ template: "auto", templateDefinition: autoPolicyDefinition(id),
        goal: "Create one run-owned detached worktree", authority: ["worktree.create"] });
      assert.deepEqual(explicitlyAuthorized.authority.externalSideEffects, ["worktree.create"]);
    }
  }
});

test("Auto policy source snapshot rejects changed catalog bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-auto-policy-fresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const copiedCatalog = path.join(root, "templates", "auto.json");
  await mkdir(path.dirname(copiedCatalog), { recursive: true });
  await copyFile(new URL("../../templates/auto.json", import.meta.url), copiedCatalog);
  const initialBytes = await readFile(copiedCatalog);
  const assertUnchanged = createSourceIntegritySnapshot(initialBytes);
  assert.doesNotThrow(assertInstalledAutoPolicyUnchanged);
  assert.doesNotThrow(() => assertUnchanged(initialBytes));
  await writeFile(copiedCatalog, `${await readFile(copiedCatalog, "utf8")}\n`);
  const changedBytes = await readFile(copiedCatalog);
  assert.throws(() => assertUnchanged(changedBytes), /changed during this process/);
});

test("Public Auto rejects missing or modified policy, action gates and authority", () => {
  const source = contractFor("dev-publish-v1");
  for (const mutate of [
    (contract) => { delete contract.autoPolicy; },
    (contract) => { contract.autoPolicy.target = "main"; },
    (contract) => { contract.requiredEvidence.pop(); },
    (contract) => { contract.actionGates["pr.merge"] = ["pr-state"]; },
    (contract) => { contract.actionGates["worktree.create"] = ["base-revision"]; },
    (contract) => { contract.actionStages["worktree.create"] = "commits"; },
    (contract) => { contract.executionStages[0].requiredEvidence.pop(); },
    (contract) => { contract.authority.externalSideEffects.push("release.publish"); },
    (contract) => { contract.authority.externalSideEffects.push("private.effect"); }
  ]) {
    const altered = structuredClone(source);
    mutate(altered);
    assert.throws(() => validateContract(altered));
  }
});

test("risk can raise an Auto variant's minimum mode", () => {
  const contract = contractFor("read-only-v1");
  contract.risk.irreversibility = 3;
  assert.equal(routeMode(contract, "auto"), "critical");
  assert.throws(() => routeMode(contract, "verified"), /at least critical/);
});

test("Auto protected delivery denies direct protected pushes and wrong PR target", () => {
  const contract = contractFor("dev-publish-v1");
  const remoteRevision = "a".repeat(40);
  for (const branch of ["dev", "main"]) {
    assert.throws(() => assertProtectedDeliveryRequest(contract, {
      action: "git.push",
      resource: `remote:origin:refs/heads/${branch}`,
      remoteRevision
    }), /forbids direct pushes/);
  }
  assert.throws(() => assertProtectedDeliveryRequest(contract, {
    action: "pr.create",
    resource: "pull/new",
    scope: "main",
    remoteRevision
  }), /PR scope must be dev/);
  assert.throws(() => protectedDeliveryTarget("auto"), /canonical policy binding/);
});

test("action issue, execute and reconcile reject a changed canonical Auto contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-auto-policy-action-"));
  try {
    const contract = contractFor("dev-publish-v1");
    const { runId } = await createRun({ root, contract, requestedMode: "critical", cwd: process.cwd() });
    const runDir = path.join(root, "runs", runId);
    const target = path.join(runDir, "contract.json");
    const changed = JSON.parse(await readFile(target, "utf8"));
    changed.actionGates["pr.merge"] = ["pr-state"];
    await writeFile(target, JSON.stringify(changed));
    await assert.rejects(() => loadRun(root, runId), /Public Auto contract actionGates/);
    await assert.rejects(() => issueActionToken(root, runId, {
      action: "git.push", provider: "git", resource: "remote:origin:refs/heads/codex/candidate",
      remoteRevision: "a".repeat(40)
    }, "b".repeat(64)), /Public Auto contract actionGates/);
    const token = "synthetic-test-token";
    await writeFile(path.join(runDir, "actions", `${sha256(token)}.json`), JSON.stringify({
      action: "git.push", provider: "git", tokenHash: sha256(token)
    }));
    await assert.rejects(() => executeActionToken(root, runId, token, "b".repeat(64)), /Public Auto contract actionGates/);
    await assert.rejects(() => reconcileAction(root, runId, "unknown-attempt", "unknown"), /Public Auto contract actionGates/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
