import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildWorkflowPlanV1
} from "../lib/workflow-plan-v1.mjs";
import {
  buildExecutionAdmission,
  digestActionCapability,
  digestExecutionAdmission,
  validateActionCapability,
  validateApprovalEnvelope,
  validateExecutionAdmission
} from "../lib/execution-admission-v1.mjs";
import {
  createOwnedResourceAdapter,
  createTrustedControllerAdapter,
  loadExecutionRegistry,
  openExecutionRegistry
} from "../lib/execution-runtime-v1.mjs";
import { digestObject } from "../lib/core.mjs";

const RUN_ID = "sbw-20260914T083857Z-1c7d8a8f5b36";
const REVISION = "5ce26db556e3f747916aa77ba21838784ed66c80";
const SOURCE_DIGEST = "a".repeat(64);
const POLICY_DIGEST = "b".repeat(64);
const TEMPLATE_DIGEST = "c".repeat(64);
const ROUTE_DIGEST = "d".repeat(64);
const FENCE = "e".repeat(64);
const MODEL_LUNA = "gpt-5.6-luna";
const MODEL_TERRA = "gpt-5.6-terra";
const MODEL_SOL = "gpt-5.6-sol";

function modelPolicy({
  inherit = true,
  allow = [],
  deny = [],
  requested = null,
  reported = null,
  attested = null
} = {}) {
  return { inherit, allow, deny, requested, reported, attested };
}

function contract({ parentModelPolicy = modelPolicy(), taskModelPolicy = undefined } = {}) {
  const task = {
    id: "task-1",
    goal: "Run one admitted action",
    dependencies: [],
    role: "root",
    writeOwner: { role: "root", paths: ["src/action"] },
    budget: { attempts: 1, seconds: 5, tokens: 50 },
    acceptanceIds: ["done"]
  };
  if (taskModelPolicy !== undefined) task.modelPolicy = taskModelPolicy;
  return {
    schemaVersion: 3,
    kind: "TaskContractV3",
    contractId: "admission-contract",
    goal: "Admit one bounded action",
    scope: { include: ["src"], exclude: [] },
    bindings: {
      source: { revision: REVISION, digest: SOURCE_DIGEST },
      policy: { digest: POLICY_DIGEST },
      template: { id: "admission-template", digest: TEMPLATE_DIGEST },
      route: { receiptId: "route-1", digest: ROUTE_DIGEST }
    },
    roles: [{ id: "root", required: true }],
    modelPolicy: parentModelPolicy,
    budget: { attempts: 1, seconds: 5, tokens: 50 },
    acceptance: [{ id: "done", description: "The action is admitted", requiredEvidence: [], critical: true }],
    graph: {
      tasks: [task]
    }
  };
}

function binding(overrides = {}) {
  return {
    runId: RUN_ID,
    executionId: "execution-1",
    attemptId: "attempt-1",
    unitId: "unit-1",
    sourceBindingDigest: SOURCE_DIGEST,
    policyDigest: POLICY_DIGEST,
    revision: REVISION,
    ownedResourceId: "owned-resource-1",
    ...overrides
  };
}

function buildFixture({ parentModelPolicy = modelPolicy(), taskModelPolicy = undefined, selectedModel = undefined } = {}) {
  const taskContract = contract({ parentModelPolicy, taskModelPolicy });
  const plan = buildWorkflowPlanV1({ taskContract, planId: "admission-plan" });
  const current = {
    epoch: 1,
    fence: FENCE,
    action: "publish",
    nonce: "nonce-1",
    selectedModel,
    legacyAuthority: false,
    commitHook: null,
    commitCalls: 0,
    runContract: {
      schemaVersion: 3,
      kind: "RunContractV3",
      runId: RUN_ID,
      status: "active",
      planDigest: plan.planDigest,
      contractDigest: plan.contractDigest,
      taskContract: plan.taskContract,
      plan,
      revision: REVISION,
      sourceBindingDigest: SOURCE_DIGEST,
      policyDigest: POLICY_DIGEST
    }
  };
  const lifecycle = {
    incarnation: "controller-1",
    ownerLeaseId: "lease-1",
    status: "active",
    previousIncarnation: null,
    previousOwnerLeaseId: null
  };
  const makeAuthority = (request) => {
    if (current.legacyAuthority) {
      const scope = { ...request };
      return {
        kind: "TrustedExecutionAuthorityV1",
        status: "active",
        revoked: false,
        ...scope,
        authorityEpoch: current.epoch,
        fence: current.fence,
        capabilityDigest: "1".repeat(64),
        envelopeDigest: "2".repeat(64),
        envelope: { digest: "2".repeat(64), scope }
      };
    }
    const scope = { include: ["src"], exclude: [] };
    const common = {
      runId: request.runId,
      executionId: request.executionId,
      attemptId: request.attemptId,
      ownedResourceId: request.ownedResourceId,
      planDigest: plan.planDigest,
      contractDigest: plan.contractDigest,
      sourceBindingDigest: SOURCE_DIGEST,
      policyDigest: POLICY_DIGEST,
      revision: REVISION,
      taskId: "task-1",
      unitId: request.unitId,
      scope,
      recipient: "provider-1",
      action: current.action,
      budget: { attempts: 1, seconds: 5, tokens: 50 },
      expiresAt: "2099-01-01T00:00:00.000Z",
      nonce: current.nonce,
      ...(current.selectedModel === undefined ? {} : { requestedModel: current.selectedModel })
    };
    const envelopeBase = {
      schemaVersion: 1,
      kind: "ApprovalEnvelope",
      envelopeId: "envelope-1",
      ...common
    };
    const envelope = { ...envelopeBase, digest: digestObject(envelopeBase) };
    const capability = {
      schemaVersion: 1,
      kind: "ActionCapabilityV1",
      capabilityId: current.nonce === "nonce-1" ? "capability-1" : "capability-2",
      envelopeDigest: envelope.digest,
      ...common,
      authorityEpoch: current.epoch,
      fence: current.fence
    };
    return {
      kind: "TrustedExecutionAuthorityV1",
      status: "active",
      revoked: false,
      ...request,
      authorityEpoch: current.epoch,
      fence: current.fence,
      capabilityDigest: digestActionCapability(capability),
      envelopeDigest: envelope.digest,
      envelope,
      capability
    };
  };
  const trustBoundary = {
    id: "admission-tcb",
    verify: async ({ authorityDigest, commitDigest }) => commitDigest
      ? { kind: "TrustedAdmissionSealAttestationV1", controllerId: "admission-tcb", commitDigest }
      : { kind: "TrustedControllerAttestationV1", controllerId: "admission-tcb", authorityDigest }
  };
  const controller = createTrustedControllerAdapter({
    readRunContract: async () => current.runContract,
    readSourceBinding: async ({ runId }) => ({ runId, revision: REVISION, digest: SOURCE_DIGEST }),
    readAuthority: async (request) => makeAuthority(request),
    readControllerLifecycle: async ({ runId }) => ({ kind: "ControllerLifecycleObservationV1", runId, ...lifecycle, observedAt: new Date().toISOString() }),
    readStopAuthority: async ({ runId, executionId, attemptId, unitId, ownedResourceId }) => ({
      kind: "TrustedStopAuthorityV1",
      status: "active",
      revoked: false,
      runId,
      executionId,
      attemptId,
      unitId,
      ownedResourceId,
      capabilityDigest: "1".repeat(64),
      envelopeDigest: "2".repeat(64),
      envelope: {
        digest: "2".repeat(64),
        scope: { runId, executionId, attemptId, unitId, ownedResourceId }
      }
    }),
    commitAdmissionSeal: async (request) => {
      current.commitCalls += 1;
      const hook = current.commitHook;
      current.commitHook = null;
      if (hook) hook();
      const requested = {
        runId: request.admission.runId,
        executionId: request.admission.executionId,
        attemptId: request.admission.attemptId,
        unitId: request.admission.unitId,
        sourceBindingDigest: request.admission.sourceBindingDigest,
        policyDigest: request.admission.policyDigest,
        revision: request.admission.revision,
        ownedResourceId: request.admission.ownedResourceId
      };
      const currentAdmission = buildExecutionAdmission({
        runContract: current.runContract,
        authority: makeAuthority(requested),
        binding: requested
      }).admission;
      if (digestExecutionAdmission(currentAdmission) !== request.admissionDigest) {
        throw new Error("fixture durable admission CAS rejected a changed grant");
      }
      return {
        schemaVersion: 1,
        kind: "TrustedAdmissionSealV1",
        status: "committed",
        runId: request.runId,
        handleId: request.handleId,
        intentId: request.intentId,
        admissionDigest: request.admissionDigest,
        authorityEpoch: request.authorityEpoch,
        fence: request.fence,
        outcome: request.outcome,
        effectDigest: request.effectDigest,
        committedAt: new Date().toISOString()
      };
    },
    trustBoundary
  });
  return { current, plan, controller };
}

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-execution-admission-v1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("V3 projection validates native plan, closed grant shapes, and exact digests", () => {
  const fixture = buildFixture();
  const envelopeBase = {
    schemaVersion: 1,
    kind: "ApprovalEnvelope",
    envelopeId: "envelope-1",
    runId: RUN_ID,
    executionId: "execution-1",
    attemptId: "attempt-1",
    ownedResourceId: "owned-resource-1",
    planDigest: fixture.plan.planDigest,
    contractDigest: fixture.plan.contractDigest,
    sourceBindingDigest: SOURCE_DIGEST,
    policyDigest: POLICY_DIGEST,
    revision: REVISION,
    taskId: "task-1",
    unitId: "unit-1",
    scope: { include: ["src"], exclude: [] },
    recipient: "provider-1",
    action: "publish",
    budget: { attempts: 1, seconds: 5, tokens: 50 },
    expiresAt: "2099-01-01T00:00:00.000Z",
    nonce: "nonce-1"
  };
  const envelope = { ...envelopeBase, digest: digestObject(envelopeBase) };
  const capability = {
    schemaVersion: 1,
    kind: "ActionCapabilityV1",
    capabilityId: "capability-1",
    envelopeDigest: envelope.digest,
    runId: RUN_ID,
    executionId: "execution-1",
    attemptId: "attempt-1",
    ownedResourceId: "owned-resource-1",
    planDigest: fixture.plan.planDigest,
    contractDigest: fixture.plan.contractDigest,
    sourceBindingDigest: SOURCE_DIGEST,
    policyDigest: POLICY_DIGEST,
    revision: REVISION,
    taskId: "task-1",
    unitId: "unit-1",
    scope: { include: ["src"], exclude: [] },
    recipient: "provider-1",
    action: "publish",
    budget: { attempts: 1, seconds: 5, tokens: 50 },
    expiresAt: "2099-01-01T00:00:00.000Z",
    nonce: "nonce-1",
    authorityEpoch: 1,
    fence: FENCE
  };
  const result = buildExecutionAdmission({
    runContract: fixture.current.runContract,
    authority: { ...capability, status: "active", revoked: false, runId: RUN_ID, executionId: "execution-1", attemptId: "attempt-1", sourceBindingDigest: SOURCE_DIGEST, policyDigest: POLICY_DIGEST, revision: REVISION, ownedResourceId: "owned-resource-1", capability, envelope, envelopeDigest: envelope.digest, capabilityDigest: digestActionCapability(capability), authorityEpoch: 1, fence: FENCE },
    binding: binding()
  });
  validateExecutionAdmission(result.admission);
  validateApprovalEnvelope(envelope);
  validateActionCapability(capability);
  assert.equal(result.admission.planDigest, fixture.plan.planDigest);
  assert.equal(result.admission.nonce, "nonce-1");
  assert.equal(Object.hasOwn(result.admission, "requestedModel"), false);
  assert.equal(envelope.digest, "d5fc6dd8ffabe01607972550313ab75427ad451d59ac114196cfcaf898bdb1a2");
  assert.equal(digestActionCapability(capability), "79380de92f42e1aa1308f794298a1c290e5572ec5432bcfed1a1c595c20c813b");
  assert.equal(digestExecutionAdmission(result.admission), "7ca56a22564989b8e937cc36a2048f1973c3646343cbc860f9cc113c8388e902");
  assert.equal(digestExecutionAdmission(result.admission), digestObject(result.admission));
  assert.throws(() => validateActionCapability({ ...capability, approved: true }), /unexpected shape/);
  assert.throws(() => buildExecutionAdmission({
    runContract: { ...fixture.current.runContract, schemaVersion: 2 },
    authority: { ...capability, status: "active", revoked: false, runId: RUN_ID, executionId: "execution-1", attemptId: "attempt-1", sourceBindingDigest: SOURCE_DIGEST, policyDigest: POLICY_DIGEST, revision: REVISION, ownedResourceId: "owned-resource-1", capability, envelope, envelopeDigest: envelope.digest, capabilityDigest: digestActionCapability(capability), authorityEpoch: 1, fence: FENCE },
    binding: binding()
  }), /V3 run contract|native TaskContract/);
});

test("runtime persists one V3 reservation in the existing journal and consumes current admission", async (t) => {
  const fixture = buildFixture();
  const root = await tempRoot(t);
  const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
  const handle = await registry.createExecutionHandle(binding());
  const state = await registry.load();
  assert.equal(state.admissions[handle.handleId].nonce, "nonce-1");
  assert.equal(Object.hasOwn(state.admissions[handle.handleId], "requestedModel"), false);
  const records = (await readFile(path.join(registry.runDir, "journal.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records[0].op, "handle.created");
  assert.equal(records[0].payload.admission.kind, "ExecutionAdmissionV1");
  let calls = 0;
  const result = await registry.execute(handle.handleId, async () => { calls += 1; return { outcome: "success", receipt: "r1" }; });
  assert.equal(result.outcome, "success");
  assert.equal(calls, 1);
});

test("same epoch/fence grant drift and run-contract downgrade are fail closed", async (t) => {
  const fixture = buildFixture();
  const root = await tempRoot(t);
  const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
  const handle = await registry.createExecutionHandle(binding());
  fixture.current.action = "delete";
  await assert.rejects(registry.execute(handle.handleId, async () => ({ outcome: "success" })), /drifted|not bound|digest/);
  fixture.current.action = "publish";
  fixture.current.runContract = { runId: RUN_ID, revision: REVISION, sourceBindingDigest: SOURCE_DIGEST, policyDigest: POLICY_DIGEST, status: "active" };
  await assert.rejects(registry.execute(handle.handleId, async () => ({ outcome: "success" })), /downgrade|V3/);
});

test("post-callback V3 grant drift becomes UNKNOWN and is never retried", async (t) => {
  const fixture = buildFixture();
  const root = await tempRoot(t);
  const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
  const handle = await registry.createExecutionHandle(binding());
  let calls = 0;
  await assert.rejects(registry.execute(handle.handleId, async () => {
    calls += 1;
    fixture.current.action = "archive";
    return { outcome: "success", value: "late" };
  }), /Late callback rejected|stale|drifted|not bound/);
  const state = await registry.load();
  const intent = Object.values(state.intents).find((value) => value.handleId === handle.handleId);
  assert.equal(calls, 1);
  assert.equal(intent.status, "unknown");
  assert.equal(intent.outcome, "unknown");
  assert.equal(intent.lateCallback, true);
  await assert.rejects(registry.execute(handle.handleId, async () => {
    calls += 1;
    return { outcome: "success" };
  }), /UNKNOWN/);
  assert.equal(calls, 1);
});

test("post-callback TCB durable admission CAS rejects a grant changed after the fresh read", async (t) => {
  const fixture = buildFixture();
  const root = await tempRoot(t);
  const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
  const handle = await registry.createExecutionHandle(binding());
  fixture.current.commitHook = () => { fixture.current.action = "archive"; };
  let calls = 0;
  await assert.rejects(registry.execute(handle.handleId, async () => {
    calls += 1;
    return { outcome: "success", value: "guarded" };
  }), /V3 admission seal rejected|durable admission CAS/);
  const state = await registry.load();
  const intent = Object.values(state.intents).find((value) => value.handleId === handle.handleId);
  assert.equal(calls, 1);
  assert.equal(fixture.current.commitCalls, 1);
  assert.equal(intent.status, "unknown");
  assert.equal(intent.outcome, "unknown");
  await assert.rejects(registry.execute(handle.handleId, async () => ({ outcome: "success" })), /UNKNOWN/);
});

test("revoke after durable dispatch records EFFECT_NOT_SENT with zero callbacks", async (t) => {
  const fixture = buildFixture();
  const root = await tempRoot(t);
  const resourceAdapter = createOwnedResourceAdapter({
    stopOwned: async ({ ownedResourceId, request }) => ({
      adapter: "admission-test-stop",
      ownedResourceId,
      confirmedOwnedScope: ownedResourceId === request.ownedResourceId,
      localOutcome: "stopped",
      remoteOutcome: "not-applicable"
    })
  });
  const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller, resourceAdapter });
  const handle = await registry.createExecutionHandle(binding());
  let calls = 0;
  await assert.rejects(registry.execute(handle.handleId, async () => {
    calls += 1;
    return { outcome: "success" };
  }, { faults: {
    afterDispatchBeforeEffect: async () => { await registry.requestStop(handle.handleId, { reason: "cancel" }); }
  } }), (error) => error?.code === "EFFECT_NOT_SENT");
  assert.equal(calls, 0);
  const reloaded = await loadExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
  const intent = Object.values(reloaded.intents).find((value) => value.handleId === handle.handleId);
  assert.equal(intent.status, "not-sent");
  assert.equal(intent.callbackCalls, 0);
  assert.equal(intent.dispatchReserved, false);
  assert.equal(reloaded.handles[handle.handleId].dispatchBlocked, true);
});

test("a V3 controller without a durable admission CAS stays HOLD before dispatch", async (t) => {
  const fixture = buildFixture();
  const controller = createTrustedControllerAdapter({
    readRunContract: async () => fixture.current.runContract,
    readSourceBinding: async ({ runId }) => ({ runId, revision: REVISION, digest: SOURCE_DIGEST }),
    readAuthority: async (request) => fixture.controller.readAuthority(request),
    readControllerLifecycle: async ({ runId }) => ({
      kind: "ControllerLifecycleObservationV1",
      runId,
      incarnation: "controller-1",
      ownerLeaseId: "lease-1",
      status: "active",
      previousIncarnation: null,
      previousOwnerLeaseId: null,
      observedAt: new Date().toISOString()
    }),
    trustBoundary: {
      id: "missing-cas-tcb",
      verify: async ({ authorityDigest }) => ({ kind: "TrustedControllerAttestationV1", controllerId: "missing-cas-tcb", authorityDigest })
    }
  });
  const root = await tempRoot(t);
  const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller });
  const handle = await registry.createExecutionHandle(binding());
  let calls = 0;
  await assert.rejects(registry.execute(handle.handleId, async () => {
    calls += 1;
    return { outcome: "success" };
  }), (error) => error?.code === "EADMISSION_HOLD");
  assert.equal(calls, 0);
  const state = await registry.load();
  assert.equal(Object.keys(state.intents).length, 0);
});

test("a V3 capability cannot be reused in another run namespace", async (t) => {
  const source = buildFixture();
  const reused = await source.controller.readAuthority(binding());
  const otherRun = "sbw-20260914T083858Z-1c7d8a8f5b36";
  const other = buildFixture();
  other.current.runContract = { ...other.current.runContract, runId: otherRun };
  const controller = createTrustedControllerAdapter({
    readRunContract: async () => other.current.runContract,
    readSourceBinding: async ({ runId }) => ({ runId, revision: REVISION, digest: SOURCE_DIGEST }),
    readAuthority: async () => ({
      ...reused,
      runId: otherRun,
      executionId: "execution-cross-run",
      attemptId: "attempt-cross-run",
      unitId: "unit-cross-run",
      ownedResourceId: "owned-resource-cross-run"
    }),
    trustBoundary: {
      id: "cross-run-tcb",
      verify: async ({ authorityDigest }) => ({ kind: "TrustedControllerAttestationV1", controllerId: "cross-run-tcb", authorityDigest })
    }
  });
  const root = await tempRoot(t);
  const registry = await openExecutionRegistry({ stateRoot: root, runId: otherRun, controller });
  await assert.rejects(registry.createExecutionHandle(binding({
    runId: otherRun,
    executionId: "execution-cross-run",
    attemptId: "attempt-cross-run",
    unitId: "unit-cross-run",
    ownedResourceId: "owned-resource-cross-run"
  })), /runId|bound|admission|scope/);
});

test("recovery rejects a nonce already reserved by another handle without a partial journal", async (t) => {
  const fixture = buildFixture();
  const root = await tempRoot(t);
  // Reach the nonce gate through a confirmed stop. An absent adapter leaves
  // an indeterminate handle and is deliberately rejected before admission.
  const resourceAdapter = createOwnedResourceAdapter({
    stopOwned: async ({ ownedResourceId, request }) => ({
      adapter: "admission-recovery-test-stop",
      ownedResourceId,
      confirmedOwnedScope: ownedResourceId === request.ownedResourceId,
      localOutcome: "stopped",
      remoteOutcome: "not-applicable"
    })
  });
  const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller, resourceAdapter });
  const first = await registry.createExecutionHandle(binding());
  const receipt = await registry.requestStop(first.handleId, { reason: "cancel" });
  assert.equal(receipt.outcome, "STOPPED");
  const stopped = await registry.load();
  assert.equal(stopped.handles[first.handleId].status, "stopped");
  assert.equal(stopped.handles[first.handleId].dispatchBlocked, true);
  assert.equal(Object.keys(stopped.intents).length, 0);
  fixture.current.nonce = "nonce-2";
  fixture.current.epoch = 2;
  fixture.current.fence = "f".repeat(64);
  await registry.createExecutionHandle(binding({
    executionId: "execution-2",
    attemptId: "attempt-2",
    unitId: "unit-2",
    ownedResourceId: "owned-resource-2"
  }));
  const journalPath = path.join(registry.runDir, "journal.jsonl");
  const before = await readFile(journalPath, "utf8");
  fixture.current.epoch = 3;
  fixture.current.fence = "9".repeat(64);
  await assert.rejects(registry.resumeExecution(first.handleId, {
    executionId: "execution-recovery",
    attemptId: "attempt-recovery"
  }), /already reserved|nonce/);
  const after = await readFile(journalPath, "utf8");
  assert.equal(after, before);
  const state = await registry.load();
  assert.equal(Object.keys(state.recoveryPlans).length, 0);
  assert.equal(Object.keys(state.handles).length, 2);
});

test("unconfirmed stop without an intent rejects V3 recovery before reserving a fresh nonce", async (t) => {
  const fixture = buildFixture();
  const root = await tempRoot(t);
  const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
  const handle = await registry.createExecutionHandle(binding());
  const receipt = await registry.requestStop(handle.handleId, { reason: "cancel" });
  assert.equal(receipt.outcome, "UNKNOWN");
  const stopped = await registry.load();
  assert.equal(stopped.handles[handle.handleId].status, "indeterminate");
  assert.equal(stopped.handles[handle.handleId].dispatchBlocked, true);
  assert.equal(Object.keys(stopped.intents).length, 0);
  fixture.current.nonce = "nonce-2";
  fixture.current.epoch = 2;
  fixture.current.fence = "f".repeat(64);
  const journalPath = path.join(registry.runDir, "journal.jsonl");
  const before = await readFile(journalPath, "utf8");
  await assert.rejects(registry.resumeExecution(handle.handleId, {
    executionId: "execution-recovery",
    attemptId: "attempt-recovery"
  }), (error) => error.code === "EEXECUTION_RECONCILIATION_REQUIRED" && error.status === "UNKNOWN");
  assert.equal(await readFile(journalPath, "utf8"), before);
  assert.deepEqual(await registry.load(), stopped);
});

test("tampering the durable V3 admission payload is rejected before the callback", async (t) => {
  const fixture = buildFixture();
  const root = await tempRoot(t);
  const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
  const handle = await registry.createExecutionHandle(binding());
  const journalPath = path.join(registry.runDir, "journal.jsonl");
  const records = (await readFile(journalPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  records[0].payload.admission.action = "archive";
  await writeFile(journalPath, `${JSON.stringify(records[0])}\n`);
  let calls = 0;
  await assert.rejects(registry.execute(handle.handleId, async () => {
    calls += 1;
    return { outcome: "success" };
  }), /transition|digest|admission/);
  assert.equal(calls, 0);
});

test("a persisted V3 handle cannot read back through a fully legacy contract and authority", async (t) => {
  const fixture = buildFixture();
  const root = await tempRoot(t);
  const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
  const handle = await registry.createExecutionHandle(binding());
  fixture.current.legacyAuthority = true;
  fixture.current.runContract = { runId: RUN_ID, revision: REVISION, sourceBindingDigest: SOURCE_DIGEST, policyDigest: POLICY_DIGEST, status: "active" };
  let calls = 0;
  await assert.rejects(registry.execute(handle.handleId, async () => {
    calls += 1;
    return { outcome: "success" };
  }), /downgrade|V3/);
  assert.equal(calls, 0);
});

test("V5 model admission binds the TCB-selected requested model and never fabricates assurance", async () => {
  const fixture = buildFixture({
    parentModelPolicy: modelPolicy({ allow: [MODEL_LUNA], requested: MODEL_LUNA }),
    selectedModel: MODEL_LUNA
  });
  const authority = await fixture.controller.readAuthority(binding());
  const current = buildExecutionAdmission({
    runContract: fixture.current.runContract,
    authority,
    binding: binding()
  });
  assert.equal(current.envelope.requestedModel, MODEL_LUNA);
  assert.equal(current.capability.requestedModel, MODEL_LUNA);
  assert.equal(current.admission.requestedModel, MODEL_LUNA);
  assert.equal(fixture.plan.taskContract.modelPolicy.requested, MODEL_LUNA);
  assert.equal(fixture.plan.taskContract.modelPolicy.reported, null);
  assert.equal(fixture.plan.taskContract.modelPolicy.attested, null);
  assert.equal(Object.hasOwn(current.admission, "reportedModel"), false);
  assert.equal(Object.hasOwn(current.admission, "attestedModel"), false);

  const mismatchedCapability = structuredClone(authority.capability);
  mismatchedCapability.requestedModel = MODEL_TERRA;
  const mismatchedAuthority = {
    ...authority,
    capability: mismatchedCapability,
    capabilityDigest: digestActionCapability(mismatchedCapability)
  };
  assert.throws(() => buildExecutionAdmission({
    runContract: fixture.current.runContract,
    authority: mismatchedAuthority,
    binding: binding()
  }), /model|drifted|bound/i);
  const missingCapabilityModel = structuredClone(authority);
  delete missingCapabilityModel.capability.requestedModel;
  missingCapabilityModel.capabilityDigest = digestActionCapability(missingCapabilityModel.capability);
  assert.throws(() => buildExecutionAdmission({
    runContract: fixture.current.runContract,
    authority: missingCapabilityModel,
    binding: binding()
  }), /model|drifted|bound/i);
  assert.throws(() => validateActionCapability({ ...authority.capability, requestedModel: null }), /model|invalid|shape/i);
  const nullModel = buildFixture({
    parentModelPolicy: modelPolicy({ allow: [MODEL_LUNA], requested: MODEL_LUNA }),
    selectedModel: null
  });
  await assert.rejects(nullModel.controller.readAuthority(binding()), /model|invalid|shape/i);
});

test("V5 selected model reaches the real dispatch callback and persists through reload", async (t) => {
  const fixture = buildFixture({
    parentModelPolicy: modelPolicy({ allow: [MODEL_LUNA], requested: MODEL_LUNA }),
    selectedModel: MODEL_LUNA
  });
  const root = await tempRoot(t);
  const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
  const handle = await registry.createExecutionHandle(binding());
  let callbackAdmission;
  const result = await registry.execute(handle.handleId, async (context) => {
    callbackAdmission = context.admission;
    return { outcome: "success", observedModel: context.admission.requestedModel };
  });
  assert.equal(result.outcome, "success");
  assert.equal(result.effect.observedModel, MODEL_LUNA);
  assert.equal(callbackAdmission.requestedModel, MODEL_LUNA);
  assert.equal(Object.hasOwn(callbackAdmission, "reportedModel"), false);
  assert.equal(Object.hasOwn(callbackAdmission, "attestedModel"), false);
  assert.equal(result.intent.status, "sealed");
  const loaded = await registry.load();
  assert.ok(result.intent.admissionSeal);
  assert.equal(result.intent.admissionSeal.admissionDigest, digestExecutionAdmission(loaded.admissions[handle.handleId]));
  assert.equal(loaded.admissions[handle.handleId].requestedModel, MODEL_LUNA);
  assert.equal(loaded.intents[result.intent.intentId].status, "sealed");
  const reloaded = await loadExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
  assert.equal(reloaded.admissions[handle.handleId].requestedModel, MODEL_LUNA);
  assert.equal(reloaded.intents[result.intent.intentId].admissionSeal.admissionDigest,
    digestExecutionAdmission(reloaded.admissions[handle.handleId]));
});

test("V5 model policy gate applies parent/task deny-wins and allow intersection", async (t) => {
  const cases = [
    {
      name: "allow intersection admits only the shared model",
      parent: modelPolicy({ allow: [MODEL_LUNA, MODEL_TERRA] }),
      task: modelPolicy({ allow: [MODEL_TERRA, MODEL_SOL], requested: MODEL_TERRA }),
      selected: MODEL_TERRA,
      admitted: true
    },
    {
      name: "parent deny wins over the intersection",
      parent: modelPolicy({ allow: [MODEL_LUNA, MODEL_TERRA], deny: [MODEL_TERRA] }),
      task: modelPolicy({ allow: [MODEL_TERRA, MODEL_SOL], requested: MODEL_TERRA }),
      selected: MODEL_TERRA,
      admitted: false
    },
    {
      name: "task deny wins over the intersection",
      parent: modelPolicy({ allow: [MODEL_LUNA, MODEL_TERRA] }),
      task: modelPolicy({ allow: [MODEL_TERRA], deny: [MODEL_TERRA] }),
      selected: MODEL_TERRA,
      admitted: false
    },
    {
      name: "a model outside the parent allow set is rejected",
      parent: modelPolicy({ allow: [MODEL_LUNA, MODEL_TERRA] }),
      task: modelPolicy({ allow: [MODEL_TERRA, MODEL_SOL], requested: MODEL_SOL }),
      selected: MODEL_SOL,
      admitted: false
    },
    {
      name: "a constrained policy cannot omit the model request",
      parent: modelPolicy({ allow: [MODEL_LUNA] }),
      task: undefined,
      selected: undefined,
      admitted: false
    },
    {
      name: "inherit false cannot omit the model request",
      parent: modelPolicy({ inherit: false, allow: [MODEL_LUNA] }),
      task: undefined,
      selected: undefined,
      admitted: false
    }
  ];
  for (const item of cases) {
    const fixture = buildFixture({
      parentModelPolicy: item.parent,
      taskModelPolicy: item.task,
      selectedModel: item.selected
    });
    const root = await tempRoot(t);
    const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
    if (item.admitted) {
      const handle = await registry.createExecutionHandle(binding());
      const state = await registry.load();
      assert.equal(state.admissions[handle.handleId].requestedModel, item.selected, item.name);
    } else {
      await assert.rejects(registry.createExecutionHandle(binding()), /model|policy|allow|deny|admission/i, item.name);
    }
  }
});

test("V5 inherit uses the parent request only as a default and never substitutes a task pin", async (t) => {
  const parent = modelPolicy({ allow: [MODEL_LUNA, MODEL_TERRA], requested: MODEL_LUNA });
  const override = modelPolicy({ allow: [MODEL_LUNA, MODEL_TERRA], requested: MODEL_TERRA });
  const overriddenLuna = buildFixture({ parentModelPolicy: parent, taskModelPolicy: override, selectedModel: MODEL_LUNA });
  const overriddenRoot = await tempRoot(t);
  const overriddenRegistry = await openExecutionRegistry({ stateRoot: overriddenRoot, runId: RUN_ID, controller: overriddenLuna.controller });
  await assert.rejects(overriddenRegistry.createExecutionHandle(binding()), /model|request|policy|admission/i);

  const overriddenTerra = buildFixture({ parentModelPolicy: parent, taskModelPolicy: override, selectedModel: MODEL_TERRA });
  const overriddenTerraRoot = await tempRoot(t);
  const overriddenTerraRegistry = await openExecutionRegistry({ stateRoot: overriddenTerraRoot, runId: RUN_ID, controller: overriddenTerra.controller });
  await overriddenTerraRegistry.createExecutionHandle(binding());

  const inherited = modelPolicy({ allow: [MODEL_LUNA, MODEL_TERRA], requested: null });
  const inheritedTerra = buildFixture({ parentModelPolicy: parent, taskModelPolicy: inherited, selectedModel: MODEL_TERRA });
  const inheritedTerraRoot = await tempRoot(t);
  const inheritedTerraRegistry = await openExecutionRegistry({ stateRoot: inheritedTerraRoot, runId: RUN_ID, controller: inheritedTerra.controller });
  await assert.rejects(inheritedTerraRegistry.createExecutionHandle(binding()), /model|request|policy|admission/i);

  const inheritedLuna = buildFixture({ parentModelPolicy: parent, taskModelPolicy: inherited, selectedModel: MODEL_LUNA });
  const inheritedLunaRoot = await tempRoot(t);
  const inheritedLunaRegistry = await openExecutionRegistry({ stateRoot: inheritedLunaRoot, runId: RUN_ID, controller: inheritedLuna.controller });
  await inheritedLunaRegistry.createExecutionHandle(binding());
});

test("model request drift after dispatch is rejected before the effect callback", async (t) => {
  const unconstrained = modelPolicy({ allow: [MODEL_LUNA, MODEL_TERRA] });
  const fixture = buildFixture({
    parentModelPolicy: unconstrained,
    taskModelPolicy: unconstrained,
    selectedModel: MODEL_TERRA
  });
  const root = await tempRoot(t);
  const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
  const handle = await registry.createExecutionHandle(binding());
  let calls = 0;
  await assert.rejects(registry.execute(handle.handleId, async () => {
    calls += 1;
    return { outcome: "success" };
  }, {
    faults: {
      afterDispatchBeforeEffect: async () => { fixture.current.selectedModel = MODEL_LUNA; }
    }
  }), (error) => error?.code === "EFFECT_NOT_SENT" || /drift|model|not sent|admission/i.test(error?.message ?? ""));
  assert.equal(calls, 0);
  const state = await registry.load();
  const intent = Object.values(state.intents).find((value) => value.handleId === handle.handleId);
  assert.equal(intent.status, "not-sent");
  assert.equal(intent.callbackCalls, 0);
  assert.equal(intent.dispatchReserved, false);
});

test("persisted requested-model tampering fails replay without silently rehashing state", async (t) => {
  const fixture = buildFixture({
    parentModelPolicy: modelPolicy({ allow: [MODEL_LUNA], requested: MODEL_LUNA }),
    selectedModel: MODEL_LUNA
  });
  const root = await tempRoot(t);
  const registry = await openExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
  await registry.createExecutionHandle(binding());
  const journalPath = path.join(registry.runDir, "journal.jsonl");
  const records = (await readFile(journalPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const registryBefore = await readFile(registry.registryPath, "utf8");
  records[0].payload.admission.requestedModel = MODEL_TERRA;
  await writeFile(journalPath, `${JSON.stringify(records[0])}\n`);
  await assert.rejects(
    loadExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller }),
    /transition|digest|admission|model/i
  );
  assert.equal(await readFile(registry.registryPath, "utf8"), registryBefore);
});
