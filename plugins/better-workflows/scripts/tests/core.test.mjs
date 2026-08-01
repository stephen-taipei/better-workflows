import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  addEvidence,
  assertProviderReceiptShape,
  buildContract,
  consumeActionToken,
  completeRun,
  createRun,
  digestObject,
  ensureStateRoot,
  evaluateCompletion,
  getStateRoot,
  inspectRun,
  issueActionToken,
  loadDefaults,
  readJson,
  registerOwnedResource,
  reconcileAction,
  routeMode,
  safeJoin,
  sha256,
  updateState
} from "../lib/core.mjs";
import { captureSentinel } from "../lib/git.mjs";

const execFileAsync = promisify(execFile);

function template() {
  return {
    requiredEvidence: ["preflight"],
    acceptance: [
      { id: "done", description: "The task is proven complete.", critical: true }
    ]
  };
}

function contract(overrides = {}) {
  const value = buildContract({
    template: "test",
    templateDefinition: template(),
    goal: "Test the workflow",
    scope: ["."],
    risk: { risk: 1, uncertainty: 1, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: ["deploy"],
    remoteRevision: "abc",
    ...overrides
  });
  return value;
}

test("PR creation receipts bind to the exact candidate source head", () => {
  const expectedHead = "a".repeat(40);
  const record = {
    action: "pr.create",
    provider: "github-cli",
    resource: "pull/new",
    outcome: "success",
    attemptId: "attempt-1",
    idempotencyKey: "idempotency-1",
    expectedHead,
    targetRef: "dev",
    creationPrecondition: { action: "pr.create", resource: "pull/new", state: "absent", number: null }
  };
  const receipt = {
    executionId: "github:test:pr.create:12",
    proofKind: "github-pr-create",
    requestDigest: "0".repeat(64),
    responseDigest: "1".repeat(64),
    verifiedAt: "2026-08-01T00:00:00.000Z",
    terminalState: "success",
    created: true,
    creationProof: {
      attemptId: record.attemptId,
      idempotencyKey: record.idempotencyKey,
      marker: `sbw:${record.attemptId}:${record.idempotencyKey}`
    },
    number: 12,
    head: "b".repeat(40),
    base: "dev",
    url: "https://github.com/example/repo/pull/12",
    creationPreconditionDigest: digestObject(record.creationPrecondition)
  };
  assert.throws(
    () => assertProviderReceiptShape(record, receipt),
    /GitHub pull request creation proof is incomplete/
  );
  assert.doesNotThrow(() => assertProviderReceiptShape(record, { ...receipt, head: expectedHead }));
});

test("pr.create cannot issue an unexecutable governed token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-pr-create-guard-"));
  const started = await createRun({
    root,
    contract: contract({ authority: ["pr.create"] }),
    requestedMode: "verified",
    cwd: root
  });
  await assert.rejects(
    issueActionToken(root, started.runId, {
      action: "pr.create",
      provider: "github-cli",
      resource: "pull/new",
      remoteRevision: "abc",
      requiredEvidence: ["base-revision"]
    }, "tree", { actionToken: { ttlSeconds: 60 } }),
    /Governed pr\.create is unavailable/
  );
});

test("auto routing follows risk and explicit modes never downgrade", () => {
  const value = contract();
  assert.equal(routeMode(value, "auto"), "verified");
  assert.equal(routeMode(value, "critical"), "critical");
  value.risk.irreversibility = 3;
  assert.equal(routeMode(value, "auto"), "critical");
});

test("direct mode creates no state directory", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-direct-"));
  const root = path.join(parent, "state-that-must-not-exist");
  const result = await createRun({
    root,
    contract: contract({
      risk: { risk: 0, uncertainty: 0, blastRadius: 0, irreversibility: 0, evidenceGap: 0 }
    }),
    requestedMode: "direct",
    cwd: parent
  });
  assert.equal(result.direct, true);
  await assert.rejects(access(root));
});

test("the SBW state root and generated run IDs use the canonical command name", async () => {
  assert.equal(getStateRoot({ CODEX_HOME: "/tmp/codex-home" }), "/tmp/codex-home/sbw");
  assert.equal(getStateRoot({ SBW_STATE_ROOT: "/tmp/custom-sbw-state" }), "/tmp/custom-sbw-state");
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-name-contract-"));
  const result = await createRun({
    root,
    contract: contract(),
    requestedMode: "verified",
    cwd: root
  });
  assert.match(result.runId, /^sbw-/);
});

test("run state is private and action tokens are one-shot with reconciliation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-core-"));
  const result = await createRun({
    root,
    contract: contract(),
    requestedMode: "verified",
    cwd: root
  });
  const run = await inspectRun(root, result.runId);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(run.runDir)).mode & 0o777, 0o700);

  await addEvidence(root, result.runId, {
    id: "preflight",
    kind: "preflight",
    summary: "Required preflight completed",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: "a".repeat(64)
  });
  await updateState(root, result.runId, (state) => ({
    ...state,
    lastSentinel: { label: "test", digest: "tree" },
    lastSentinelVerified: true,
    lastSentinelComplete: false
  }));

  const defaults = await loadDefaults();
  const incomplete = await evaluateCompletion(root, result.runId);
  assert.ok(incomplete.blockers.includes("bounded-sentinel-incomplete"));
  await assert.rejects(
    issueActionToken(
      root,
      result.runId,
      {
        action: "deploy",
        provider: "github",
        resource: "workflow:123",
        remoteRevision: "abc",
        requiredEvidence: ["preflight"]
      },
      "tree",
      defaults
    ),
    /incomplete bounded sentinel/
  );
  await updateState(root, result.runId, (state) => ({
    ...state,
    lastSentinelComplete: true
  }));
  const issued = await issueActionToken(
    root,
    result.runId,
    {
      action: "deploy",
      provider: "github",
      resource: "workflow:123",
      remoteRevision: "abc",
      requiredEvidence: ["preflight"]
    },
    "tree",
    defaults
  );
  const spent = await consumeActionToken(root, result.runId, issued.token, "tree");
  assert.equal(spent.status, "spent");
  assert.equal(spent.outcome, "pending");
  await assert.rejects(
    consumeActionToken(root, result.runId, issued.token, "tree"),
    /already consumed/
  );
  const timeoutProviderReceipt = {
    action: "deploy",
    provider: "github",
    resource: "workflow:123",
    outcome: "unknown",
    runId: spent.runId,
    attemptId: spent.attemptId,
    idempotencyKey: spent.idempotencyKey,
    remoteRevision: spent.remoteRevision,
    executionId: `github:timeout:${spent.attemptId}`,
    proofKind: "github:deploy",
    requestDigest: "f".repeat(64),
    responseDigest: "0".repeat(64),
    verifiedAt: "2026-08-01T00:00:00.000Z",
    terminalState: "unknown",
    reason: "provider-timeout"
  };
  const reconciled = await reconcileAction(
    root,
    result.runId,
    spent.attemptId,
    "unknown",
    {
      action: "deploy",
      provider: "github",
      resource: "workflow:123",
      outcome: "unknown",
      runId: spent.runId,
      attemptId: spent.attemptId,
      idempotencyKey: spent.idempotencyKey,
      remoteRevision: spent.remoteRevision,
      providerReceipt: timeoutProviderReceipt
    }
  );
  assert.equal(reconciled.outcome, "unknown");
  const completion = await evaluateCompletion(root, result.runId);
  assert.equal(completion.ok, false);
  assert.ok(completion.blockers.includes("side-effect-not-reconciled"));
  const terminalIssued = await issueActionToken(
    root,
    result.runId,
    {
      action: "deploy",
      provider: "github",
      resource: "workflow:terminal",
      remoteRevision: "abc",
      requiredEvidence: ["preflight"]
    },
    "tree",
    defaults
  );
  const reconciliationIssued = await issueActionToken(
    root,
    result.runId,
    {
      action: "deploy",
      provider: "github",
      resource: "workflow:reconcile-terminal",
      remoteRevision: "abc",
      requiredEvidence: ["preflight"]
    },
    "tree",
    defaults
  );
  const reconciliationSpent = await consumeActionToken(root, result.runId, reconciliationIssued.token, "tree");
  await updateState(root, result.runId, (state) => ({ ...state, status: "failed_terminal" }));
  await assert.rejects(
    consumeActionToken(root, result.runId, terminalIssued.token, "tree"),
    /Action token consumption cannot mutate a terminal run/
  );
  await assert.rejects(
    issueActionToken(root, result.runId, {
      action: "deploy",
      provider: "github",
      resource: "workflow:after-terminal",
      remoteRevision: "abc",
      requiredEvidence: ["preflight"]
    }, "tree", defaults),
    /Action token issuance cannot mutate a terminal run/
  );
  const terminalProviderReceipt = {
    action: "deploy",
    provider: "github",
    resource: "workflow:reconcile-terminal",
    outcome: "unknown",
    runId: reconciliationSpent.runId,
    attemptId: reconciliationSpent.attemptId,
    idempotencyKey: reconciliationSpent.idempotencyKey,
    remoteRevision: reconciliationSpent.remoteRevision,
    executionId: `github:terminal:${reconciliationSpent.attemptId}`,
    proofKind: "github:deploy",
    requestDigest: "a".repeat(64),
    responseDigest: "b".repeat(64),
    verifiedAt: "2026-08-01T00:00:00.000Z",
    terminalState: "unknown",
    reason: "terminal-run-test"
  };
  await assert.rejects(
    reconcileAction(root, result.runId, reconciliationSpent.attemptId, "unknown", {
      action: "deploy",
      provider: "github",
      resource: "workflow:reconcile-terminal",
      outcome: "unknown",
      runId: reconciliationSpent.runId,
      attemptId: reconciliationSpent.attemptId,
      idempotencyKey: reconciliationSpent.idempotencyKey,
      remoteRevision: reconciliationSpent.remoteRevision,
      providerReceipt: terminalProviderReceipt
    }),
    /Action reconciliation cannot mutate a terminal run/
  );
});

test("destructive cleanup actions require an immutable run-owned resource receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-owned-resource-"));
  const cleanupTemplate = {
    requiredEvidence: ["actions-cleanup-plan"],
    acceptance: [{ id: "done", description: "Cleanup is governed.", critical: true }]
  };
  const cleanupContract = () => buildContract({
    template: "test-cleanup",
    templateDefinition: cleanupTemplate,
    goal: "Test cleanup ownership",
    scope: ["."],
    risk: { risk: 1, uncertainty: 1, blastRadius: 1, irreversibility: 1, evidenceGap: 1 },
    sensitivity: "internal",
    authority: ["branch.create", "branch.delete"],
    remoteRevision: "abc"
  });
  const addPlan = async (run, plan) => addEvidence(root, run.runId, {
    id: "actions-cleanup-plan",
    kind: "actions-cleanup-plan",
    summary: "Cleanup ownership plan",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: "a".repeat(64),
    receipt: { payload: plan }
  });
  const denied = await createRun({ root, contract: cleanupContract(), requestedMode: "verified", cwd: root });
  await updateState(root, denied.runId, (state) => ({
    ...state,
    lastSentinel: { label: "test", digest: "tree" },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const deniedResource = "branch:feature/owned";
  await addPlan(denied, {
    objective: "Delete only the owned branch",
    ownerRunId: denied.runId,
    action: "branch.delete",
    resources: [{ resource: deniedResource, ownerRunId: denied.runId, receiptDigest: "0".repeat(64) }]
  });
  await assert.rejects(
    registerOwnedResource(root, denied.runId, {
      resource: deniedResource,
      creationReceipt: {
        ownerRunId: denied.runId,
        resource: deniedResource,
        action: "branch.create",
        attemptId: "forged-attempt",
        runId: denied.runId,
        idempotencyKey: "forged-idempotency",
        remoteRevision: "abc",
        outcome: "success",
        provider: "git",
        providerReceipt: {
          provider: "git",
          action: "branch.create",
          resource: deniedResource,
          outcome: "success",
          runId: denied.runId,
          attemptId: "forged-attempt",
          idempotencyKey: "forged-idempotency",
          remoteRevision: "abc",
          executionId: "git:forged",
          created: true,
          ref: deniedResource.slice("branch:".length),
          revision: "a".repeat(40)
        },
        createdAt: "2026-08-01T00:00:00.000Z"
      }
    }),
    /structured execution proof|reconciled successful run action/
  );
  await assert.rejects(
    issueActionToken(root, denied.runId, {
      action: "branch.delete",
      provider: "git",
      resource: deniedResource,
      remoteRevision: "abc",
      requiredEvidence: ["actions-cleanup-plan"]
    }, "tree", await loadDefaults()),
    /immutable creation receipt/
  );

  const providerRepo = path.join(root, "provider-repo");
  await mkdir(providerRepo, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: providerRepo });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: providerRepo });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: providerRepo });
  await writeFile(path.join(providerRepo, "README.md"), "provider\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: providerRepo });
  await execFileAsync("git", ["commit", "-qm", "provider base"], { cwd: providerRepo });
  const registeredRun = await createRun({ root, contract: cleanupContract(), requestedMode: "verified", cwd: providerRepo });
  await updateState(root, registeredRun.runId, (state) => ({
    ...state,
    lastSentinel: { label: "test", digest: "tree" },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const resource = "branch:feature/registered";
  await addEvidence(root, registeredRun.runId, {
    id: "preflight",
    kind: "preflight",
    summary: "Creation action preflight",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: "b".repeat(64)
  });
  const creationIssued = await issueActionToken(root, registeredRun.runId, {
    action: "branch.create",
    provider: "git",
    resource,
    remoteRevision: "abc",
    requiredEvidence: ["preflight"]
  }, "tree", await loadDefaults());
  const reservationPath = path.join(root, "creation-reservations", `${sha256(resource)}.json`);
  const reservation = JSON.parse(await readFile(reservationPath, "utf8"));
  assert.equal(reservation.expiresAt, creationIssued.expiresAt);
  const expiredResource = "branch:feature/expired";
  const expiredIssued = await issueActionToken(root, registeredRun.runId, {
    action: "branch.create",
    provider: "git",
    resource: expiredResource,
    remoteRevision: "abc",
    requiredEvidence: ["preflight"]
  }, "tree", await loadDefaults());
  const expiredReservationPath = path.join(root, "creation-reservations", `${sha256(expiredResource)}.json`);
  const expiredReservation = JSON.parse(await readFile(expiredReservationPath, "utf8"));
  await writeFile(expiredReservationPath, `${JSON.stringify({ ...expiredReservation, expiresAt: "2020-01-01T00:00:00.000Z" })}\n`);
  const replacementIssued = await issueActionToken(root, registeredRun.runId, {
    action: "branch.create",
    provider: "git",
    resource: expiredResource,
    remoteRevision: "abc",
    requiredEvidence: ["preflight"]
  }, "tree", await loadDefaults());
  assert.notEqual(replacementIssued.token, expiredIssued.token);
  await writeFile(reservationPath, `${JSON.stringify({ ...reservation, tokenHash: "0".repeat(64) })}\n`);
  await assert.rejects(
    consumeActionToken(root, registeredRun.runId, creationIssued.token, "tree"),
    /creation reservation is missing, expired, or rebound/
  );
  await writeFile(reservationPath, `${JSON.stringify(reservation)}\n`);
  const creationSpent = await consumeActionToken(root, registeredRun.runId, creationIssued.token, "tree");
  const creationMarker = `sbw:${creationSpent.attemptId}:${creationSpent.idempotencyKey}`;
  const providerRevision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: providerRepo })).stdout.trim();
  await execFileAsync("git", [
    "update-ref",
    "-m",
    creationMarker,
    `refs/heads/${resource.slice("branch:".length)}`,
    providerRevision,
    "0".repeat(40)
  ], { cwd: providerRepo });
  const providerIdentity = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: providerRepo })).stdout.trim();
  const providerReceipt = {
    provider: "git",
    action: "branch.create",
    resource,
    outcome: "success",
    runId: creationSpent.runId,
    attemptId: creationSpent.attemptId,
    idempotencyKey: creationSpent.idempotencyKey,
    remoteRevision: creationSpent.remoteRevision,
    executionId: `git:${providerIdentity}:branch.create:${resource.slice("branch:".length)}:${providerRevision}`,
    proofKind: "git-branch-create",
    requestDigest: digestObject({ action: creationSpent.action, provider: creationSpent.provider, resource: creationSpent.resource, remoteRevision: creationSpent.remoteRevision, repository: providerIdentity }),
    responseDigest: digestObject({ ref: resource.slice("branch:".length), revision: providerRevision }),
    verifiedAt: "2026-08-01T00:00:00.000Z",
    terminalState: "success",
    created: true,
    creationProof: {
      attemptId: creationSpent.attemptId,
      idempotencyKey: creationSpent.idempotencyKey,
      marker: creationMarker,
      providerObjectId: `${resource.slice("branch:".length)}:${providerRevision}`
    },
    creationPreconditionDigest: digestObject(creationSpent.creationPrecondition),
    ref: resource.slice("branch:".length),
    revision: providerRevision
  };
  const actionEvidence = {
    id: "branch-create-proof",
    kind: "preflight",
    summary: "Provider branch creation receipt",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: "c".repeat(64),
    receipt: {
      payload: {
        actionProof: {
          schemaVersion: 1,
          runId: creationSpent.runId,
          actionAttemptId: creationSpent.attemptId,
          action: creationSpent.action,
          provider: creationSpent.provider,
          resource: creationSpent.resource,
          outcome: "success",
          idempotencyKey: creationSpent.idempotencyKey,
          remoteRevision: creationSpent.remoteRevision,
          providerExecutionId: providerReceipt.executionId,
          providerReceiptDigest: digestObject(providerReceipt)
        },
        receipt: providerReceipt
      }
    }
  };
  await addEvidence(root, registeredRun.runId, actionEvidence);
  await reconcileAction(root, registeredRun.runId, creationSpent.attemptId, "success", {
    action: "branch.create",
    provider: "git",
    resource,
    outcome: "success",
    runId: creationSpent.runId,
    attemptId: creationSpent.attemptId,
    idempotencyKey: creationSpent.idempotencyKey,
    remoteRevision: creationSpent.remoteRevision,
    providerReceipt,
    evidenceIds: [actionEvidence.id]
  });
  const creationReceipt = {
    ownerRunId: registeredRun.runId,
    runId: registeredRun.runId,
    resource,
    action: "branch.create",
    attemptId: creationSpent.attemptId,
    idempotencyKey: creationSpent.idempotencyKey,
    remoteRevision: creationSpent.remoteRevision,
    outcome: "success",
    provider: "git",
    providerReceipt,
    evidenceIds: [actionEvidence.id],
    createdAt: "2026-08-01T00:00:00.000Z"
  };
  const registered = await registerOwnedResource(root, registeredRun.runId, { resource, creationReceipt });
  await addPlan(registeredRun, {
    objective: "Delete only the owned branch",
    ownerRunId: registeredRun.runId,
    action: "branch.delete",
    resources: [{ resource, ownerRunId: registeredRun.runId, receiptDigest: registered.receiptDigest }]
  });
  const issued = await issueActionToken(root, registeredRun.runId, {
    action: "branch.delete",
    provider: "git",
    resource,
    remoteRevision: "abc",
    requiredEvidence: ["actions-cleanup-plan"]
  }, "tree", await loadDefaults());
  assert.equal(issued.action, "branch.delete");
});

test("terminal runs reject owned resource registration before manifest mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-terminal-resource-"));
  const run = await createRun({
    root,
    contract: contract({ authority: ["branch.create"] }),
    requestedMode: "verified",
    cwd: root
  });
  await updateState(root, run.runId, (state) => ({ ...state, status: "completed" }));
  await assert.rejects(
    registerOwnedResource(root, run.runId, {
      resource: "branch:feature/terminal",
      creationReceipt: {
        ownerRunId: run.runId,
        resource: "branch:feature/terminal",
        action: "branch.create",
        attemptId: "terminal-attempt",
        runId: run.runId,
        idempotencyKey: "terminal-idempotency",
        remoteRevision: "abc",
        outcome: "success",
        provider: "git",
        providerReceipt: {
          provider: "git",
          action: "branch.create",
          resource: "branch:feature/terminal",
          outcome: "success",
          runId: run.runId,
          attemptId: "terminal-attempt",
          idempotencyKey: "terminal-idempotency",
          remoteRevision: "abc",
          executionId: "git:terminal",
          proofKind: "git-branch-create",
          requestDigest: "0".repeat(64),
          responseDigest: "1".repeat(64),
          verifiedAt: "2026-08-01T00:00:00.000Z",
          terminalState: "success",
          creationProof: {
            attemptId: "terminal-attempt",
            idempotencyKey: "terminal-idempotency",
            marker: "sbw:terminal-attempt:terminal-idempotency"
          },
          created: true,
          ref: "feature/terminal",
          revision: "a".repeat(40)
        },
        createdAt: "2026-08-01T00:00:00.000Z"
      }
    }),
    /Owned resource registration cannot mutate a terminal run/
  );
});

test("completion requires every declared evidence kind independently of acceptance coverage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-required-evidence-"));
  const result = await createRun({
    root,
    contract: contract(),
    requestedMode: "verified",
    cwd: root
  });
  await addEvidence(root, result.runId, {
    id: "shortcut",
    kind: "unrelated-shortcut",
    summary: "Acceptance is covered without the required preflight kind",
    status: "complete",
    acceptanceIds: ["done"],
    sourceDigest: "b".repeat(64)
  });
  await updateState(root, result.runId, (state) => ({
    ...state,
    lastSentinel: { label: "test", digest: "tree" },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));

  const completion = await evaluateCompletion(root, result.runId);
  assert.equal(completion.ok, false);
  assert.ok(completion.blockers.includes("missing-required-evidence:preflight"));
  assert.ok(!completion.blockers.includes("missing-acceptance:done"));
});

test("completion re-captures the sentinel inside the final gate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-completion-sentinel-"));
  const repository = path.join(root, "repository");
  await mkdir(repository, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "stable\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: repository });
  const taskContract = contract();
  const run = await createRun({ root: path.join(root, "state"), contract: taskContract, requestedMode: "verified", cwd: repository });
  const runRoot = path.join(root, "state");
  const sentinel = await captureSentinel(repository, taskContract, await loadDefaults());
  await updateState(runRoot, run.runId, (state) => ({
    ...state,
    lastSentinel: { label: "initial", digest: sentinel.digest },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  await addEvidence(runRoot, run.runId, {
    id: "preflight",
    kind: "preflight",
    summary: "Final-gate sentinel test evidence",
    status: "complete",
    acceptanceIds: ["done"],
    sourceDigest: "d".repeat(64)
  });
  await writeFile(path.join(repository, "README.md"), "drifted\n");
  const completed = await completeRun(runRoot, run.runId, { decision: "complete" });
  assert.equal(completed.ok, false);
  assert.equal(completed.status, "inconclusive");
  assert.ok(completed.blockers.includes("current-sentinel-drift"));
  await updateState(runRoot, run.runId, (state) => ({ ...state, status: "failed_terminal" }));
  await assert.rejects(
    completeRun(runRoot, run.runId, { decision: "complete" }),
    /Run completion cannot mutate a terminal run/
  );
});

test("state root symlinks and hardlinked JSON are rejected", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-links-"));
  const actual = path.join(parent, "actual");
  const alias = path.join(parent, "alias");
  await mkdir(actual, { mode: 0o700 });
  await symlink(actual, alias);
  await assert.rejects(ensureStateRoot(alias), /symlink/);

  const root = path.join(parent, "state");
  const result = await createRun({
    root,
    contract: contract(),
    requestedMode: "verified",
    cwd: parent
  });
  const run = await inspectRun(root, result.runId);
  const external = path.join(parent, "external.json");
  const hardlink = safeJoin(run.runDir, "evidence", "hardlink.json");
  await writeFile(external, "{}\n", { mode: 0o600 });
  await link(external, hardlink);
  await assert.rejects(readJson(root, hardlink), /Unsafe JSON path/);
});
