import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendJournal } from "../lib/core.mjs";
import {
  createOwnedResourceAdapter,
  createTrustedControllerAdapter,
  isExecutionRuntimeEffectNotSent,
  loadExecutionRegistry,
  openExecutionRegistry
} from "../lib/execution-runtime-v1.mjs";

// Synthetic controller and owned-resource observations. These exercise the
// real registry/journal, not a provider or physical process-stop attestation.
const RUN_ID = "sbw-20260918T090000Z-a123456789ab";
const SOURCE = "a".repeat(64);
const POLICY = "b".repeat(64);
const ENVELOPE = "d".repeat(64);
const REVISION = "5ce26db556e3f747916aa77ba21838784ed66c80";
const BINDING = Object.freeze({
  runId: RUN_ID, executionId: "execution-1", attemptId: "attempt-1", unitId: "unit-1",
  sourceBindingDigest: SOURCE, policyDigest: POLICY, revision: REVISION,
  ownedResourceId: "owned-resource-1"
});

function fixture() {
  const current = { epoch: 1, fence: "c".repeat(64) };
  const lifecycle = {
    incarnation: "controller-1", ownerLeaseId: "lease-1", status: "active",
    previousIncarnation: null, previousOwnerLeaseId: null
  };
  const controller = createTrustedControllerAdapter({
    readRunContract: async ({ runId }) => ({
      runId, revision: REVISION, sourceBindingDigest: SOURCE, policyDigest: POLICY, status: "active"
    }),
    readSourceBinding: async ({ runId }) => ({ runId, revision: REVISION, digest: SOURCE }),
    readAuthority: async request => ({
      kind: "TrustedExecutionAuthorityV1", status: "active", revoked: false, ...request,
      authorityEpoch: current.epoch, fence: current.fence,
      capabilityDigest: "e".repeat(64), envelopeDigest: ENVELOPE,
      envelope: { digest: ENVELOPE, scope: { ...request } }
    }),
    readStopAuthority: async request => ({
      kind: "TrustedStopAuthorityV1", status: "active", revoked: false, ...request,
      capabilityDigest: "e".repeat(64), envelopeDigest: ENVELOPE,
      envelope: { digest: ENVELOPE, scope: { ...request } }
    }),
    readControllerLifecycle: async ({ runId }) => ({
      kind: "ControllerLifecycleObservationV1", runId, ...lifecycle, observedAt: new Date().toISOString()
    }),
    trustBoundary: {
      id: "stop-race-fixture",
      verify: async ({ authorityDigest }) => ({
        kind: "TrustedControllerAttestationV1", controllerId: "stop-race-fixture", authorityDigest
      })
    }
  });
  return { current, lifecycle, controller };
}

function confirmedStop({ request, ownedResourceId }) {
  return {
    adapter: "synthetic-stop-race", ownedResourceId,
    confirmedOwnedScope: ownedResourceId === request.ownedResourceId,
    localOutcome: "stopped", remoteOutcome: "not-applicable"
  };
}

async function workspace(t, options = {}) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-stop-race-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const f = fixture();
  const registry = await openExecutionRegistry({ stateRoot, runId: RUN_ID, controller: f.controller, ...options });
  const handle = await registry.createExecutionHandle(BINDING);
  return { ...f, stateRoot, registry, handle };
}

function expectedProof(handle) {
  return { runId: RUN_ID, handleId: handle.handleId, ownedResourceId: handle.ownedResourceId };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function intentFor(state, handle) {
  const intents = Object.values(state.intents).filter(item => item.handleId === handle.handleId);
  assert.equal(intents.length, 1);
  return intents[0];
}

for (const reason of ["cancel", "pause", "security-p0"]) {
  test(`${reason} before callback seals not-sent without undoing the stop fence`, async t => {
    const w = await workspace(t, { resourceAdapter: createOwnedResourceAdapter({ stopOwned: confirmedStop }) });
    let calls = 0;
    let stopped;
    let error;
    await assert.rejects(w.registry.execute(w.handle.handleId, async () => {
      calls++;
      return { outcome: "success" };
    }, { faults: {
      afterDispatchBeforeEffect: async () => {
        const receipt = await w.registry.requestStop(w.handle.handleId, { reason });
        assert.equal(receipt.outcome, "STOPPED");
        assert.equal(receipt.securityRcaRequired, reason === "security-p0");
        stopped = await w.registry.load();
      }
    } }), caught => {
      error = caught;
      return isExecutionRuntimeEffectNotSent(caught, expectedProof(w.handle));
    });
    assert.equal(calls, 0);
    assert.equal(isExecutionRuntimeEffectNotSent({ ...error }, expectedProof(w.handle)), false);
    const state = await loadExecutionRegistry({ stateRoot: w.stateRoot, runId: RUN_ID, controller: w.controller });
    const intent = intentFor(state, w.handle);
    assert.equal(intent.status, "not-sent");
    assert.equal(intent.callbackCalls, 0);
    assert.equal(intent.dispatchReserved, false);
    assert.equal(intent.outcome, null);
    assert.equal(intent.effectDigest, null);
    assert.deepEqual(state.handles, stopped.handles);
    assert.deepEqual(state.stopRequests, stopped.stopRequests);
    assert.deepEqual(state.stopReceipts, stopped.stopReceipts);
    assert.deepEqual(state.admissions, stopped.admissions);
    assert.equal(state.handles[w.handle.handleId].status, "stopped");
    assert.equal(state.handles[w.handle.handleId].dispatchBlocked, true);
    const journalPath = path.join(w.registry.runDir, "journal.jsonl");
    const before = await readFile(journalPath, "utf8");
    await assert.rejects(w.registry.execute(w.handle.handleId, async () => {
      calls++;
      return { outcome: "success" };
    }), /revoked|dispatch-blocked/);
    assert.equal(calls, 0);
    assert.equal(await readFile(journalPath, "utf8"), before);
  });
}

test("not-sent may precede the stop receipt while the revoked handle stays fenced", { timeout: 10000 }, async t => {
  const entered = deferred();
  const release = deferred();
  let pendingStop;
  const w = await workspace(t, { resourceAdapter: createOwnedResourceAdapter({
    stopOwned: async request => {
      entered.resolve();
      await release.promise;
      return confirmedStop(request);
    }
  }) });
  let calls = 0;
  try {
    await assert.rejects(w.registry.execute(w.handle.handleId, async () => {
      calls++;
      return { outcome: "success" };
    }, { faults: {
      afterDispatchBeforeEffect: async () => {
        pendingStop = w.registry.requestStop(w.handle.handleId, { reason: "cancel" });
        pendingStop.catch(() => {});
        await entered.promise;
      }
    } }), error => isExecutionRuntimeEffectNotSent(error, expectedProof(w.handle)));
    const state = await w.registry.load();
    assert.equal(calls, 0);
    assert.equal(intentFor(state, w.handle).status, "not-sent");
    assert.equal(state.handles[w.handle.handleId].status, "revoked");
    assert.equal(state.handles[w.handle.handleId].dispatchBlocked, true);
    assert.equal(Object.keys(state.stopReceipts).length, 0);
  } finally {
    release.resolve();
    if (pendingStop) await pendingStop;
  }
  const state = await w.registry.replay();
  assert.equal(intentFor(state, w.handle).status, "not-sent");
  assert.equal(state.handles[w.handle.handleId].status, "stopped");
  assert.equal(state.handles[w.handle.handleId].dispatchBlocked, true);
  assert.equal(Object.values(state.stopReceipts)[0].outcome, "STOPPED");
});

test("an unconfirmed stop retains indeterminate lifecycle even with a not-sent effect", async t => {
  const w = await workspace(t);
  let calls = 0;
  let stopped;
  await assert.rejects(w.registry.execute(w.handle.handleId, async () => {
    calls++;
    return { outcome: "success" };
  }, { faults: {
    afterDispatchBeforeEffect: async () => {
      const receipt = await w.registry.requestStop(w.handle.handleId);
      assert.equal(receipt.outcome, "UNKNOWN");
      stopped = await w.registry.load();
    }
  } }), error => isExecutionRuntimeEffectNotSent(error, expectedProof(w.handle)));
  const state = await w.registry.load();
  assert.equal(calls, 0);
  assert.equal(intentFor(state, w.handle).status, "not-sent");
  assert.deepEqual(state.handles, stopped.handles);
  assert.deepEqual(state.stopReceipts, stopped.stopReceipts);
  assert.equal(state.handles[w.handle.handleId].status, "indeterminate");
  assert.equal(state.handles[w.handle.handleId].dispatchBlocked, true);
  w.current.epoch++;
  w.current.fence = "f".repeat(64);
  const journalPath = path.join(w.registry.runDir, "journal.jsonl");
  const before = await readFile(journalPath, "utf8");
  await assert.rejects(w.registry.resumeExecution(w.handle.handleId, {
    executionId: "recovery-1", attemptId: "recovery-attempt-1"
  }), error => error.code === "EEXECUTION_RECONCILIATION_REQUIRED");
  assert.equal(await readFile(journalPath, "utf8"), before);
});

test("failed not-sent persistence never mints a retry proof after a confirmed stop", async t => {
  const w = await workspace(t, {
    resourceAdapter: createOwnedResourceAdapter({ stopOwned: confirmedStop }),
    journalWriter: async (root, runDir, event, payload) => {
      if (payload.op === "intent.not-sent") throw new Error("synthetic not-sent write failure");
      return appendJournal(root, runDir, event, payload);
    }
  });
  let calls = 0;
  let before;
  const journalPath = path.join(w.registry.runDir, "journal.jsonl");
  await assert.rejects(w.registry.execute(w.handle.handleId, async () => {
    calls++;
    return { outcome: "success" };
  }, { faults: {
    afterDispatchBeforeEffect: async () => {
      await w.registry.requestStop(w.handle.handleId);
      before = await readFile(journalPath, "utf8");
    }
  } }), error => {
    assert.equal(error.code, "EEXECUTION_EFFECT_UNKNOWN");
    assert.equal(error.proofError?.message, "synthetic not-sent write failure");
    assert.equal(isExecutionRuntimeEffectNotSent(error), false);
    return true;
  });
  assert.equal(calls, 0);
  assert.equal(await readFile(journalPath, "utf8"), before);
  const state = await w.registry.replay();
  assert.equal(intentFor(state, w.handle).status, "dispatching");
  assert.equal(intentFor(state, w.handle).dispatchReserved, true);
  assert.equal(state.handles[w.handle.handleId].status, "stopped");
  assert.equal(state.handles[w.handle.handleId].dispatchBlocked, true);
});

test("controller-recovered UNKNOWN cannot be overwritten by a live pre-callback frame", async t => {
  const w = await workspace(t);
  let calls = 0;
  let recovered;
  await assert.rejects(w.registry.execute(w.handle.handleId, async () => {
    calls++;
    return { outcome: "success" };
  }, { faults: {
    afterDispatchBeforeEffect: async () => {
      Object.assign(w.lifecycle, {
        status: "terminated", incarnation: "controller-2", ownerLeaseId: "lease-2",
        previousIncarnation: "controller-1", previousOwnerLeaseId: "lease-1"
      });
      await w.registry.reconcileAfterControllerStop();
      recovered = await w.registry.load();
    }
  } }), error => error.code === "EEXECUTION_EFFECT_UNKNOWN" && !isExecutionRuntimeEffectNotSent(error));
  assert.equal(calls, 0);
  const state = await w.registry.replay();
  assert.deepEqual(state, recovered);
  assert.equal(intentFor(state, w.handle).status, "unknown");
  assert.equal(intentFor(state, w.handle).notSentAt, null);
  assert.equal(state.handles[w.handle.handleId].dispatchBlocked, true);
});

for (const outcome of ["return", "throw"]) {
  test(`a callback that began before stop stays UNKNOWN on ${outcome}`, async t => {
    const w = await workspace(t, { resourceAdapter: createOwnedResourceAdapter({ stopOwned: confirmedStop }) });
    let calls = 0;
    await assert.rejects(w.registry.execute(w.handle.handleId, async () => {
      calls++;
      await w.registry.requestStop(w.handle.handleId);
      if (outcome === "throw") throw new Error("synthetic post-effect failure");
      return { outcome: "success" };
    }), error => {
      assert.equal(isExecutionRuntimeEffectNotSent(error), false);
      if (outcome === "return") assert.equal(error.code, "ESTALE_EXECUTION");
      else assert.equal(error.message, "synthetic post-effect failure");
      return true;
    });
    const state = await w.registry.replay();
    const intent = intentFor(state, w.handle);
    assert.equal(calls, 1);
    assert.equal(intent.status, "unknown");
    assert.equal(intent.callbackCalls, 1);
    assert.equal(intent.notSentAt, null);
    assert.equal(intent.notSentReason, null);
    assert.equal(Object.values(state.stopReceipts)[0].outcome, "STOPPED");
    assert.equal(state.handles[w.handle.handleId].dispatchBlocked, true);
    await assert.rejects(w.registry.execute(w.handle.handleId, async () => {
      calls++;
      return { outcome: "success" };
    }), error => error.code === "EEXECUTION_EFFECT_UNKNOWN");
    assert.equal(calls, 1);
  });
}
