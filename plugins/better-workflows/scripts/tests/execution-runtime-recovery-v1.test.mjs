import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { digestObject } from "../lib/core.mjs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createOwnedResourceAdapter,
  createTrustedControllerAdapter,
  openExecutionRegistry,
  validateExecutionReconciliationV1
} from "../lib/execution-runtime-v1.mjs";

const RUN_ID = "sbw-20350101T000001Z-abcdef012345";
const SOURCE_DIGEST = "a".repeat(64);
const POLICY_DIGEST = "b".repeat(64);
const ENVELOPE_DIGEST = "c".repeat(64);
const REVISION = "20350101-recovery";
const RESOURCE_ID = "owned-resource-recovery";

function fixture({ epoch = 1, fence = "d".repeat(64) } = {}) {
  const current = { epoch, fence, revoked: false };
  const source = { revision: REVISION, digest: SOURCE_DIGEST };
  const lifecycle = {
    incarnation: "controller-recovery-1",
    ownerLeaseId: "lease-recovery-1",
    status: "active",
    previousIncarnation: null,
    previousOwnerLeaseId: null
  };
  const authority = (request) => {
    const scope = { ...request, ownedResourceId: request.ownedResourceId ?? RESOURCE_ID };
    return {
      kind: "TrustedExecutionAuthorityV1",
      status: current.revoked ? "revoked" : "active",
      revoked: current.revoked,
      ...scope,
      authorityEpoch: current.epoch,
      fence: current.fence,
      capabilityDigest: "e".repeat(64),
      envelopeDigest: ENVELOPE_DIGEST,
      envelope: { digest: ENVELOPE_DIGEST, scope }
    };
  };
  const controllerId = "recovery-controller";
  const trustBoundary = {
    id: controllerId,
    verify: async ({ authorityDigest }) => ({
      kind: "TrustedControllerAttestationV1",
      controllerId,
      authorityDigest
    })
  };
  const controller = createTrustedControllerAdapter({
    readRunContract: async ({ runId }) => ({
      runId,
      revision: REVISION,
      sourceBindingDigest: SOURCE_DIGEST,
      policyDigest: POLICY_DIGEST,
      status: current.revoked ? "blocked" : "active"
    }),
    readSourceBinding: async ({ runId }) => ({ runId, ...source }),
    readAuthority: async (request) => authority(request),
    readStopAuthority: async ({ runId, executionId, attemptId, unitId, ownedResourceId }) => ({
      kind: "TrustedStopAuthorityV1",
      status: "active",
      revoked: false,
      runId,
      executionId,
      attemptId,
      unitId,
      ownedResourceId,
      capabilityDigest: "f".repeat(64),
      envelopeDigest: ENVELOPE_DIGEST,
      envelope: {
        digest: ENVELOPE_DIGEST,
        scope: { runId, executionId, attemptId, unitId, ownedResourceId }
      }
    }),
    readControllerLifecycle: async ({ runId }) => ({
      kind: "ControllerLifecycleObservationV1",
      runId,
      ...lifecycle,
      observedAt: new Date().toISOString()
    }),
    trustBoundary
  });
  return { current, lifecycle, source, controller };
}

function binding(overrides = {}) {
  return {
    runId: RUN_ID,
    executionId: "execution-recovery",
    attemptId: "attempt-1",
    unitId: "unit-recovery",
    sourceBindingDigest: SOURCE_DIGEST,
    policyDigest: POLICY_DIGEST,
    revision: REVISION,
    ownedResourceId: RESOURCE_ID,
    ...overrides
  };
}

async function runtime(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-execution-recovery-v1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controllerFixture = options.fixture ?? fixture();
  const registry = await openExecutionRegistry({
    stateRoot: root,
    runId: RUN_ID,
    controller: controllerFixture.controller,
    resourceAdapter: options.resourceAdapter
  });
  return { root, registry, fixture: controllerFixture };
}

function observation(request, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "ExecutionResourceObservationV1",
    observationId: `observation-${request.attemptId}`,
    runId: request.runId,
    handleId: request.handleId,
    intentId: request.intentId,
    executionId: request.executionId,
    attemptId: request.attemptId,
    unitId: request.unitId,
    sourceBindingDigest: request.sourceBindingDigest,
    policyDigest: request.policyDigest,
    revision: request.revision,
    authorityEpoch: request.authorityEpoch,
    fence: request.fence,
    ownedResourceId: request.ownedResourceId,
    controllerStatus: "terminated",
    providerOutcome: "not-sent",
    businessOutcome: null,
    observedAt: "2035-01-01T00:00:00.000Z",
    evidenceDigest: "1".repeat(64),
    ...overrides
  };
}

async function makeUnknown(registry, overrides = {}) {
  const handle = await registry.createExecutionHandle(binding(overrides));
  await assert.rejects(
    registry.execute(handle.handleId, async () => {
      throw new Error("provider status unavailable");
    }),
    /provider status unavailable/
  );
  const state = await registry.load();
  const intent = Object.values(state.intents).find((item) => item.handleId === handle.handleId);
  assert.equal(intent.status, "unknown");
  return { handle, intent };
}

function deferred() {
  let resolve;
  const promise = new Promise((value) => { resolve = value; });
  return { promise, resolve };
}

test("UNKNOWN reconciliation is bounded, typed, source-bound, and append-only", async (t) => {
  const modes = [
    { controllerStatus: "active", providerOutcome: "unknown" },
    { controllerStatus: "terminated", providerOutcome: "not-sent" }
  ];
  const queryCalls = [];
  const resourceAdapter = createOwnedResourceAdapter({
    stopOwned: async ({ ownedResourceId }) => ({
      ownedResourceId,
      confirmedOwnedScope: true,
      localOutcome: "stopped",
      remoteOutcome: "not-applicable"
    }),
    queryOwned: async ({ request }) => {
      queryCalls.push(request);
      return observation(request, modes.shift());
    }
  });
  const { registry, fixture } = await runtime(t, { resourceAdapter });
  const { handle } = await makeUnknown(registry);

  const first = await registry.reconcileUnknownExecution(handle.handleId);
  validateExecutionReconciliationV1(first.reconciliation);
  assert.equal(first.reconciliation.decision, "hold");
  assert.equal(first.reconciliations.length, 1);

  const second = await registry.reconcileUnknownExecution(handle.handleId);
  assert.equal(second.reconciliation.decision, "retryable");
  assert.equal(second.reconciliations.length, 2);
  assert.notEqual(second.reconciliations[0].reconciliationId, second.reconciliations[1].reconciliationId);
  assert.equal(queryCalls.length, 2);

  fixture.current.epoch = 2;
  fixture.current.fence = "e".repeat(64);
  const resumed = await registry.resumeExecution(handle.handleId, {
    executionId: "execution-recovery",
    attemptId: "attempt-2"
  });
  assert.equal(resumed.handle.authorityEpoch, 2);
  assert.equal(resumed.recoveryPlan.priorAttemptId, "attempt-1");
});

test("confirmed provider completion appends a terminal fact without redispatch, while business outcome stays separate", async (t) => {
  const resourceAdapter = createOwnedResourceAdapter({
    stopOwned: async ({ ownedResourceId }) => ({ ownedResourceId, confirmedOwnedScope: true, localOutcome: "stopped", remoteOutcome: "not-applicable" }),
    queryOwned: async ({ request }) => observation(request, {
      providerOutcome: "completed",
      businessOutcome: "unknown"
    })
  });
  const { registry, fixture } = await runtime(t, { resourceAdapter });
  const { handle } = await makeUnknown(registry);
  const result = await registry.reconcileUnknownExecution(handle.handleId);
  validateExecutionReconciliationV1(result.reconciliation);
  assert.equal(result.reconciliation.decision, "completed");
  assert.equal(result.reconciliation.observation.providerOutcome, "completed");
  assert.equal(result.reconciliation.observation.businessOutcome, "unknown");
  assert.equal(result.reconciliations.length, 1);
  assert.equal(result.intent.status, "unknown", "provider completion does not claim a business outcome");
  fixture.current.epoch = 2;
  fixture.current.fence = "e".repeat(64);
  await assert.rejects(
    registry.resumeExecution(handle.handleId, { executionId: "execution-recovery", attemptId: "attempt-2" }),
    (error) => error?.code === "EEXECUTION_RECONCILIATION_REQUIRED" && error?.status === "UNKNOWN"
  );
});

test("mismatched and late reconciliation evidence never seals or authorizes a retry", async (t) => {
  const gate = deferred();
  const resourceAdapter = createOwnedResourceAdapter({
    stopOwned: async ({ ownedResourceId }) => ({ ownedResourceId, confirmedOwnedScope: true, localOutcome: "stopped", remoteOutcome: "not-applicable" }),
    queryOwned: async ({ request }) => {
      await gate.promise;
      return observation(request);
    }
  });
  const { registry } = await runtime(t, { resourceAdapter });
  const { handle } = await makeUnknown(registry);
  const pending = registry.reconcileUnknownExecution(handle.handleId, { timeoutMs: 2_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const other = await registry.createExecutionHandle(binding({ executionId: "execution-other", attemptId: "attempt-other", unitId: "unit-other" }));
  assert.ok(other.handleId);
  gate.resolve();
  await assert.rejects(pending, (error) => error?.code === "EEXECUTION_RECONCILE_RACE");
  const state = await registry.load();
  const intent = Object.values(state.intents).find((item) => item.handleId === handle.handleId);
  assert.equal(intent.reconciliation, undefined);
});

test("mismatched provider identity is rejected without a reconciliation record", async (t) => {
  const resourceAdapter = createOwnedResourceAdapter({
    stopOwned: async ({ ownedResourceId }) => ({ ownedResourceId, confirmedOwnedScope: true, localOutcome: "stopped", remoteOutcome: "not-applicable" }),
    queryOwned: async ({ request }) => observation(request, { ownedResourceId: "outside-resource" })
  });
  const { registry } = await runtime(t, { resourceAdapter });
  const { handle } = await makeUnknown(registry);
  await assert.rejects(
    registry.reconcileUnknownExecution(handle.handleId),
    (error) => error?.code === "EEXECUTION_RECONCILE_INVALID" && error?.status === "UNKNOWN"
  );
  const state = await registry.load();
  const intent = Object.values(state.intents).find((item) => item.handleId === handle.handleId);
  assert.equal(intent.reconciliation, undefined);
});

test("source drift after provider observation remains UNKNOWN and is never sealed", async (t) => {
  const controllerFixture = fixture();
  const resourceAdapter = createOwnedResourceAdapter({
    stopOwned: async ({ ownedResourceId }) => ({ ownedResourceId, confirmedOwnedScope: true, localOutcome: "stopped", remoteOutcome: "not-applicable" }),
    queryOwned: async ({ request }) => {
      controllerFixture.source.revision = "20350101-source-drift";
      return observation(request);
    }
  });
  const { registry } = await runtime(t, { resourceAdapter, fixture: controllerFixture });
  const { handle } = await makeUnknown(registry);
  await assert.rejects(
    registry.reconcileUnknownExecution(handle.handleId),
    (error) => error?.code === "EEXECUTION_RECONCILE_SOURCE_DRIFT" && error?.status === "UNKNOWN"
  );
  const state = await registry.load();
  const intent = Object.values(state.intents).find((item) => item.handleId === handle.handleId);
  assert.equal(intent.reconciliation, undefined);
});

test("reconciliation timeout is UNKNOWN and does not leave a retryable record", async (t) => {
  let observedSignal;
  let lateResolve;
  const resourceAdapter = createOwnedResourceAdapter({
    stopOwned: async ({ ownedResourceId }) => ({ ownedResourceId, confirmedOwnedScope: true, localOutcome: "stopped", remoteOutcome: "not-applicable" }),
    queryOwned: async (request, { signal }) => {
      observedSignal = signal;
      await new Promise((resolve) => { lateResolve = () => resolve(observation(request)); });
    }
  });
  const { registry } = await runtime(t, { resourceAdapter });
  const { handle } = await makeUnknown(registry);
  await assert.rejects(
    registry.reconcileUnknownExecution(handle.handleId, { timeoutMs: 25 }),
    (error) => error?.code === "EEXECUTION_RECONCILE_TIMEOUT" && error?.status === "UNKNOWN"
  );
  assert.equal(observedSignal.aborted, true);
  // A late provider callback may still settle in an adapter that cannot
  // cancel its underlying transport.  It must not be able to seal the old
  // snapshot or mint retry authority after the bounded call has returned.
  lateResolve();
  await new Promise((resolve) => setImmediate(resolve));
  const state = await registry.load();
  const intent = Object.values(state.intents).find((item) => item.handleId === handle.handleId);
  assert.equal(intent.reconciliation, undefined);
});

// Physical cleanup is not proof that an external effect was not sent.
test("STOPPED cannot bypass UNKNOWN reconciliation through a fresh attempt", async (t) => {
  let providerCalls = 0;
  let queries = 0;
  const resourceAdapter = createOwnedResourceAdapter({
    stopOwned: async ({ ownedResourceId }) => ({
      ownedResourceId, confirmedOwnedScope: true, localOutcome: "stopped", remoteOutcome: "not-applicable"
    }),
    queryOwned: async ({ request }) => {
      queries++;
      return observation(request, { providerOutcome: "unknown" });
    }
  });
  const { registry, fixture } = await runtime(t, { resourceAdapter });
  const handle = await registry.createExecutionHandle(binding());
  await assert.rejects(registry.execute(handle.handleId, async () => {
    providerCalls++;
    throw new Error("provider reply lost after request");
  }), /provider reply lost/);
  const stop = await registry.requestStop(handle.handleId);
  assert.equal(stop.outcome, "STOPPED");
  const before = await registry.load({ reconcile: false });
  assert.equal(before.handles[handle.handleId].status, "stopped");
  assert.equal(Object.values(before.intents)[0].status, "unknown");
  fixture.current.epoch = 2;
  fixture.current.fence = "e".repeat(64);
  await assert.rejects(
    registry.resumeExecution(handle.handleId, { executionId: "execution-recovery-2", attemptId: "attempt-2" }),
    (error) => error?.code === "EEXECUTION_RECONCILIATION_REQUIRED" && error?.status === "UNKNOWN"
  );
  assert.deepEqual(await registry.load({ reconcile: false }), before);
  assert.equal(providerCalls, 1);
  assert.equal(queries, 0, "resume must not invent a provider observation");
});

for (const providerOutcome of ["not-sent", "completed"]) {
  test(`a stopped UNKNOWN can be queried but only ${providerOutcome} evidence governs its recovery`, async t => {
    const resourceAdapter = createOwnedResourceAdapter({
      stopOwned: async ({ ownedResourceId }) => ({
        ownedResourceId, confirmedOwnedScope: true, localOutcome: "stopped", remoteOutcome: "not-applicable"
      }),
      queryOwned: async ({ request }) => observation(request, { providerOutcome })
    });
    const { registry, fixture } = await runtime(t, { resourceAdapter });
    const { handle } = await makeUnknown(registry);
    const stop = await registry.requestStop(handle.handleId);
    assert.equal(stop.outcome, "STOPPED");
    const stopped = await registry.load({ reconcile: false });
    const result = await registry.reconcileUnknownExecution(handle.handleId);
    assert.equal(result.reconciliation.decision, providerOutcome === "not-sent" ? "retryable" : "completed");
    const observed = await registry.load({ reconcile: false });
    assert.deepEqual(observed.handles, stopped.handles, "query cannot rewrite physical stop");
    assert.deepEqual(observed.stopReceipts, stopped.stopReceipts);
    assert.equal(Object.values(observed.intents)[0].status, "unknown", "the original outcome is retained");
    fixture.current.epoch = 2;
    fixture.current.fence = "e".repeat(64);
    const recovery = { executionId: "execution-recovery-2", attemptId: "attempt-2" };
    if (providerOutcome === "not-sent") {
      const resumed = await registry.resumeExecution(handle.handleId, recovery);
      assert.equal(resumed.handle.authorityEpoch, 2);
      assert.notEqual(resumed.handle.handleId, handle.handleId);
      const replayed = await registry.replay();
      assert.deepEqual(replayed.handles[handle.handleId], stopped.handles[handle.handleId]);
      assert.deepEqual(replayed.stopReceipts, stopped.stopReceipts);
    } else {
      await assert.rejects(registry.resumeExecution(handle.handleId, recovery),
        error => error?.code === "EEXECUTION_RECONCILIATION_REQUIRED" && error?.status === "UNKNOWN");
      assert.deepEqual(await registry.load({ reconcile: false }), observed);
    }
  });
}

test("stop cannot admit another attempt while the prior callback is still in flight", async t => {
  const resourceAdapter = createOwnedResourceAdapter({
    stopOwned: async ({ ownedResourceId }) => ({
      ownedResourceId, confirmedOwnedScope: true, localOutcome: "stopped", remoteOutcome: "not-applicable"
    })
  });
  const { registry, fixture } = await runtime(t, { resourceAdapter });
  const handle = await registry.createExecutionHandle(binding());
  const entered = deferred();
  const release = deferred();
  let effectCalls = 0;
  const execution = registry.execute(handle.handleId, async () => {
    effectCalls++;
    entered.resolve();
    await release.promise;
    return { outcome: "success" };
  }).then(result => ({ result }), error => ({ error }));
  try {
    await entered.promise;
    assert.equal((await registry.requestStop(handle.handleId)).outcome, "STOPPED");
    const stopped = await registry.load({ reconcile: false });
    assert.equal(Object.values(stopped.intents)[0].status, "dispatching");
    fixture.current.epoch = 2;
    fixture.current.fence = "e".repeat(64);
    await assert.rejects(registry.resumeExecution(handle.handleId, {
      executionId: "execution-recovery-2", attemptId: "attempt-2"
    }), error => error?.code === "EEXECUTION_RECONCILIATION_REQUIRED");
    assert.deepEqual(await registry.load({ reconcile: false }), stopped);
  } finally {
    release.resolve();
    await execution;
  }
  const final = await registry.load({ reconcile: false });
  assert.equal(Object.values(final.intents)[0].status, "unknown");
  assert.equal(final.handles[handle.handleId].dispatchBlocked, true);
  assert.equal(Object.keys(final.handles).length, 1);
  assert.equal(effectCalls, 1);
});

test("journal replay rejects a recovery event with its UNKNOWN reconciliation removed", async t => {
  const resourceAdapter = createOwnedResourceAdapter({
    stopOwned: async ({ ownedResourceId }) => ({
      ownedResourceId, confirmedOwnedScope: true, localOutcome: "stopped", remoteOutcome: "not-applicable"
    }),
    queryOwned: async ({ request }) => observation(request)
  });
  const { registry, fixture } = await runtime(t, { resourceAdapter });
  const { handle } = await makeUnknown(registry);
  const journalPath = path.join(registry.runDir, "journal.jsonl");
  const beforeBytes = await readFile(journalPath, "utf8");
  const before = JSON.parse(await readFile(registry.registryPath, "utf8"));
  await registry.reconcileUnknownExecution(handle.handleId);
  fixture.current.epoch = 2;
  fixture.current.fence = "e".repeat(64);
  const resumed = await registry.resumeExecution(handle.handleId, {
    executionId: "execution-recovery-2", attemptId: "attempt-2"
  });
  const validJournal = await readFile(journalPath, "utf8");
  const validState = await readFile(registry.registryPath, "utf8");
  const event = JSON.parse(validJournal.trim().split("\n").at(-1));
  assert.equal(event.op, "recovery.prepared");
  const forged = JSON.parse(validState);
  forged.sequence = before.sequence + 1;
  forged.intents = before.intents;
  const { stateDigest: ignored, ...body } = forged;
  forged.stateDigest = digestObject(body);
  event.sequence = forged.sequence;
  event.previousSequence = before.sequence;
  event.previousStateDigest = before.stateDigest;
  event.stateDigest = forged.stateDigest;
  try {
    await writeFile(journalPath, beforeBytes + JSON.stringify(event) + "\n");
    await writeFile(registry.registryPath, JSON.stringify(forged) + "\n");
    await assert.rejects(registry.replay(), /resolved outcome before a fresh attempt/);
  } finally {
    await writeFile(journalPath, validJournal);
    await writeFile(registry.registryPath, validState);
  }
  assert.ok((await registry.replay()).handles[resumed.handle.handleId]);
});
