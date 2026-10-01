import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendJournal } from "../lib/core.mjs";
import {
  createOwnedResourceAdapter,
  createTrustedControllerAdapter,
  computeExecutionScopeDigest,
  EXECUTION_EFFECT_NOT_SENT_KIND,
  isTrustedControllerAdapter,
  isTrustedOwnedResourceAdapter,
  isExecutionRuntimeEffectNotSent,
  loadExecutionRegistry,
  openExecutionRegistry,
  readExecutionSealedEffectArtifactV1,
  validateExecutionHandleV1,
  validateRecoveryPlanV1,
  validateStopReceiptV1,
  validateStopRequestV1
} from "../lib/execution-runtime-v1.mjs";

const RUN_ID = "sbw-20260914T083857Z-1c7d8a8f5b36";
const SOURCE_DIGEST = "a".repeat(64);
const POLICY_DIGEST = "b".repeat(64);
const ENVELOPE_DIGEST = "d".repeat(64);
const REVISION = "5ce26db556e3f747916aa77ba21838784ed66c80";
const RESOURCE_ID = "owned-resource-1";

function trustBoundary(id = "fixture-tcb") {
  return {
    id,
    verify: async ({ authorityDigest }) => ({
      kind: "TrustedControllerAttestationV1",
      controllerId: id,
      authorityDigest
    })
  };
}

function fixture({ epoch = 1, fence = "c".repeat(64), revision = REVISION } = {}) {
  const current = { epoch, fence, revision, revoked: false };
  const lifecycle = {
    incarnation: "controller-1",
    ownerLeaseId: "lease-1",
    status: "active",
    previousIncarnation: null,
    previousOwnerLeaseId: null
  };
  const authority = (request) => {
    const ownedResourceId = request.ownedResourceId ?? RESOURCE_ID;
    const scope = { ...request, ownedResourceId };
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
  return {
    current,
    lifecycle,
    controller: createTrustedControllerAdapter({
      readRunContract: async ({ runId }) => ({
        runId,
        revision: current.revision,
        sourceBindingDigest: SOURCE_DIGEST,
        policyDigest: POLICY_DIGEST,
        status: current.revoked ? "blocked" : "active"
      }),
      readSourceBinding: async ({ runId }) => ({ runId, revision: current.revision, digest: SOURCE_DIGEST }),
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
        capabilityDigest: "e".repeat(64),
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
      trustBoundary: trustBoundary()
    })
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
    ownedResourceId: RESOURCE_ID,
    ...overrides
  };
}

function digestObject(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(sort(value)), "utf8").digest("hex");
}

function registryDigest(value) {
  const { stateDigest: ignored, ...withoutDigest } = value;
  return digestObject(withoutDigest);
}

async function temporaryRoot(t, prefix = "sbw-execution-runtime-v1-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function runtime(t, options = {}) {
  const root = options.stateRoot ?? await temporaryRoot(t);
  const controllerFixture = options.fixture ?? fixture();
  const registry = await openExecutionRegistry({
    stateRoot: root,
    runId: RUN_ID,
    controller: controllerFixture.controller,
    resourceAdapter: options.resourceAdapter,
    clock: options.clock,
    journalWriter: options.journalWriter
  });
  return { root, registry, fixture: controllerFixture };
}

function successfulStopAdapter(calls = []) {
  return createOwnedResourceAdapter({
    stopOwned: async ({ request, ownedResourceId }) => {
      calls.push({ request, ownedResourceId });
      return {
        adapter: "fixture-owned-stop",
        ownedResourceId,
        confirmedOwnedScope: ownedResourceId === request.ownedResourceId,
        localOutcome: "stopped",
        remoteOutcome: "not-applicable"
      };
    }
  });
}

async function within(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("execution handle binds the complete identity and execution scope digest excludes run and epoch", async (t) => {
  const { registry, fixture } = await runtime(t);
  const handle = await registry.createExecutionHandle(binding());
  validateExecutionHandleV1(handle);
  assert.equal(handle.runId, RUN_ID);
  assert.equal(handle.executionId, "execution-1");
  assert.equal(handle.attemptId, "attempt-1");
  assert.equal(handle.unitId, "unit-1");
  assert.equal(handle.sourceBindingDigest, SOURCE_DIGEST);
  assert.equal(handle.policyDigest, POLICY_DIGEST);
  assert.equal(handle.revision, REVISION);
  assert.equal(handle.authorityEpoch, 1);
  assert.equal(handle.fence, fixture.current.fence);
  assert.equal(
    computeExecutionScopeDigest({ ...binding(), authorityEpoch: 99, fence: "f".repeat(64), executionId: "other", attemptId: "other-attempt", runId: "sbw-20260101T000000Z-000000000000" }),
    handle.executionScopeDigest
  );
  const replay = await loadExecutionRegistry({ stateRoot: registry.root.replace(/\/execution-runtime-v1$/, ""), runId: RUN_ID, controller: fixture.controller });
  assert.deepEqual(replay.handles[handle.handleId], handle);
  assert.equal(replay.sequence, 1);
  const journal = JSON.parse((await readFile(path.join(registry.runDir, "journal.jsonl"), "utf8")).trim());
  assert.equal(journal.event, "execution-runtime.v1");
  assert.equal(journal.op, "handle.created");
});

test("journal writes a versioned map delta without embedding a registry snapshot", async (t) => {
  const { registry } = await runtime(t);
  const handle = await registry.createExecutionHandle(binding());
  await registry.execute(handle.handleId, async () => ({ outcome: "success", value: "delta" }));
  const records = (await readFile(path.join(registry.runDir, "journal.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 4);
  for (const record of records) {
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.kind, "ExecutionRegistryEventV2");
    assert.equal(record.runId, RUN_ID);
    assert.equal(record.state, undefined);
    assert.deepEqual(Object.keys(record.delta).sort(), ["handles", "intents", "recoveryPlans", "stopReceipts", "stopRequests"]);
    for (const map of Object.values(record.delta)) {
      assert.deepEqual(Object.keys(map).sort(), ["added", "removed", "updated"]);
      assert.deepEqual(map.removed, []);
    }
  }
  assert.equal(Object.keys(records[0].delta.handles.added).length, 1);
  assert.deepEqual(records[1].delta.handles, { added: {}, updated: {}, removed: [] });
  assert.equal(Object.keys(records[1].delta.intents.added).length, 1);
});

test("delta replay rejects unknown shape, operation, history deletion, and unrelated record changes", async (t) => {
  const cases = [
    {
      name: "unknown top-level key",
      mutate: (record) => { record.unexpected = true; },
      expected: /unexpected shape/
    },
    {
      name: "unknown operation",
      mutate: (record) => { record.op = "future.operation"; },
      expected: /unsupported operation|transition is invalid/
    },
    {
      name: "history deletion",
      mutate: (record) => {
        delete record.delta.handles.added[Object.keys(record.delta.handles.added)[0]];
        record.delta.handles.removed = ["missing-history-id"];
      },
      expected: /cannot delete append-only history/
    },
    {
      name: "unrelated map change",
      mutate: (record, handle) => {
        record.delta.intents.added["forged-intent"] = { handleId: handle.handleId };
      },
      expected: /intent|transition is invalid|unexpected shape/
    }
  ];
  for (const item of cases) {
    const { root, registry } = await runtime(t);
    const handle = await registry.createExecutionHandle(binding());
    const journalPath = path.join(registry.runDir, "journal.jsonl");
    const baseline = (await readFile(journalPath, "utf8")).trim();
    const forged = JSON.parse(baseline);
    item.mutate(forged, handle);
    await writeFile(journalPath, `${JSON.stringify(forged)}\n`, "utf8");
    await assert.rejects(
      loadExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture().controller }),
      item.expected,
      item.name
    );
  }
});

test("journal delta replay rejects a well-rehashed illegal handle transition", async (t) => {
  const { root, registry, fixture } = await runtime(t);
  const handle = await registry.createExecutionHandle(binding());
  const journalPath = path.join(registry.runDir, "journal.jsonl");
  const records = (await readFile(journalPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const forged = structuredClone(records[0]);
  forged.delta.handles.added[handle.handleId] = {
    ...forged.delta.handles.added[handle.handleId],
    status: "revoked",
    dispatchBlocked: true,
    revokedAt: handle.createdAt
  };
  const forgedState = JSON.parse(await readFile(registry.registryPath, "utf8"));
  forgedState.handles[handle.handleId] = structuredClone(forged.delta.handles.added[handle.handleId]);
  forgedState.stateDigest = registryDigest(forgedState);
  forged.stateDigest = forgedState.stateDigest;
  await writeFile(journalPath, `${JSON.stringify(forged)}\n`, "utf8");
  await writeFile(registry.registryPath, `${JSON.stringify(forgedState)}\n`, "utf8");

  await assert.rejects(
    loadExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller }),
    /journal transition is invalid|handle\.created|digest/
  );
});

test("journal delta replay binds handle authority observations independently of mutable origin", async (t) => {
  const { root, registry, fixture } = await runtime(t);
  const handle = await registry.createExecutionHandle(binding());
  const journalPath = path.join(registry.runDir, "journal.jsonl");
  const record = JSON.parse((await readFile(journalPath, "utf8")).trim());
  const forged = structuredClone(record);
  forged.delta.handles.added[handle.handleId] = {
    ...forged.delta.handles.added[handle.handleId],
    authorityEpoch: 2,
    fence: "f".repeat(64),
    origin: {
      ...forged.delta.handles.added[handle.handleId].origin,
      authorityEpoch: 2,
      fence: "f".repeat(64)
    }
  };
  const forgedState = JSON.parse(await readFile(registry.registryPath, "utf8"));
  forgedState.handles[handle.handleId] = structuredClone(forged.delta.handles.added[handle.handleId]);
  forgedState.stateDigest = registryDigest(forgedState);
  forged.stateDigest = forgedState.stateDigest;
  await writeFile(journalPath, `${JSON.stringify(forged)}\n`, "utf8");
  await writeFile(registry.registryPath, `${JSON.stringify(forgedState)}\n`, "utf8");

  await assert.rejects(
    loadExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller }),
    /observed authority|handle\.created|digest/
  );
});

test("validated replay cache preserves cold and warm state equality after cache loss", async (t) => {
  const { root, registry, fixture } = await runtime(t);
  const handle = await registry.createExecutionHandle(binding());
  await registry.execute(handle.handleId, async () => ({ outcome: "success", value: "cache" }));
  const warm = await registry.load();
  const coldModule = await import("../lib/execution-runtime-v1.mjs?cache-loss=fixture-v1");
  const coldController = coldModule.createTrustedControllerAdapter({
    readRunContract: fixture.controller.readRunContract,
    readSourceBinding: fixture.controller.readSourceBinding,
    readAuthority: fixture.controller.readAuthority,
    readStopAuthority: fixture.controller.readStopAuthority,
    readControllerLifecycle: fixture.controller.readControllerLifecycle,
    trustBoundary: {
      id: fixture.controller.controllerId,
      verify: async ({ authorityDigest }) => ({
        kind: "TrustedControllerAttestationV1",
        controllerId: fixture.controller.controllerId,
        authorityDigest
      })
    }
  });
  const cold = await coldModule.loadExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: coldController });
  assert.deepEqual(warm, cold);
});

test("validated replay cache rejects same-length prefix replacement and keeps the prior entry", async (t) => {
  const { registry } = await runtime(t);
  const handle = await registry.createExecutionHandle(binding());
  await registry.execute(handle.handleId, async () => ({ outcome: "success", value: "prefix" }));
  const journalPath = path.join(registry.runDir, "journal.jsonl");
  const original = await readFile(journalPath);
  const baseline = await registry.load();
  const forged = Buffer.from(original);
  const marker = Buffer.from("execution-runtime.v1");
  const markerOffset = forged.indexOf(marker);
  assert.notEqual(markerOffset, -1);
  forged[markerOffset + marker.length - 1] = "2".charCodeAt(0);
  assert.equal(forged.length, original.length);
  await writeFile(journalPath, forged);
  await assert.rejects(registry.load(), /unexpected event/);
  await writeFile(journalPath, original);
  assert.deepEqual(await registry.load(), baseline);
});

test("validated replay cache falls back after journal truncation", async (t) => {
  const { registry } = await runtime(t);
  const handle = await registry.createExecutionHandle(binding());
  await registry.execute(handle.handleId, async () => ({ outcome: "success", value: "truncate" }));
  const journalPath = path.join(registry.runDir, "journal.jsonl");
  const original = await readFile(journalPath);
  const firstLineEnd = original.indexOf(0x0a) + 1;
  await registry.load();
  await writeFile(journalPath, original.subarray(0, firstLineEnd));
  await assert.rejects(registry.load(), /ahead of its journal|diverges from journal|provenance/);
  await writeFile(journalPath, original);
  assert.equal((await registry.load()).sequence, 4);
});

test("partial journal tail never advances the validated replay cache", async (t) => {
  const { registry } = await runtime(t);
  const handle = await registry.createExecutionHandle(binding());
  await registry.execute(handle.handleId, async () => ({ outcome: "success", value: "partial" }));
  const journalPath = path.join(registry.runDir, "journal.jsonl");
  const original = await readFile(journalPath);
  const baseline = await registry.load();
  await writeFile(journalPath, Buffer.concat([original, Buffer.from('{"partial":')]));
  await assert.rejects(registry.load(), /partial tail/);
  await writeFile(journalPath, original);
  assert.deepEqual(await registry.load(), baseline);
});

test("two controllers append through the shared lock and converge on one replayed state", async (t) => {
  const firstFixture = fixture();
  const { root, registry: first } = await runtime(t, { fixture: firstFixture });
  await first.createExecutionHandle(binding());
  await first.load();
  const secondFixture = fixture();
  const second = await openExecutionRegistry({
    stateRoot: root,
    runId: RUN_ID,
    controller: secondFixture.controller
  });
  const firstHandle = await first.createExecutionHandle(binding({ executionId: "execution-2", attemptId: "attempt-2", unitId: "unit-2" }));
  const secondHandle = await second.createExecutionHandle(binding({ executionId: "execution-3", attemptId: "attempt-3", unitId: "unit-3" }));
  assert.notEqual(firstHandle.handleId, secondHandle.handleId);
  const firstState = await first.load();
  const secondState = await second.load();
  assert.deepEqual(firstState, secondState);
  assert.equal(Object.keys(firstState.handles).length, 3);
});

test("journal replay preserves one logical obligation across resume only", async (t) => {
  const { root, registry, fixture } = await runtime(t);
  const first = await registry.createExecutionHandle(binding());
  const second = await registry.createExecutionHandle(binding({
    executionId: "execution-2",
    attemptId: "attempt-2",
    unitId: "unit-2"
  }));
  const journalPath = path.join(registry.runDir, "journal.jsonl");
  const records = (await readFile(journalPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const forged = structuredClone(records[1]);
  const secondHandle = forged.delta.handles.added[second.handleId];
  secondHandle.unitId = first.unitId;
  secondHandle.executionScopeDigest = first.executionScopeDigest;
  secondHandle.obligationKey = first.obligationKey;
  secondHandle.origin.unitId = first.unitId;
  forged.payload.binding.unitId = first.unitId;
  forged.payload.executionScopeDigest = first.executionScopeDigest;
  const forgedState = JSON.parse(await readFile(registry.registryPath, "utf8"));
  forgedState.handles[second.handleId] = structuredClone(secondHandle);
  forgedState.stateDigest = registryDigest(forgedState);
  forged.stateDigest = forgedState.stateDigest;
  await writeFile(journalPath, `${JSON.stringify(records[0])}\n${JSON.stringify(forged)}\n`, "utf8");
  await writeFile(registry.registryPath, `${JSON.stringify(forgedState)}\n`, "utf8");

  await assert.rejects(
    loadExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller }),
    /obligation|reservation/
  );
});

test("registry rejects every rekeyed record map before replay", async (t) => {
  const controllerFixture = fixture();
  const { registry } = await runtime(t, {
    fixture: controllerFixture,
    resourceAdapter: successfulStopAdapter()
  });
  const handle = await registry.createExecutionHandle(binding());
  await registry.execute(handle.handleId, async () => ({ outcome: "success" }));
  await registry.requestStop(handle.handleId);
  controllerFixture.current.epoch = 2;
  controllerFixture.current.fence = "f".repeat(64);
  await registry.resumeExecution(handle.handleId, { executionId: "execution-1", attemptId: "attempt-2" });
  const baselineText = await readFile(registry.registryPath, "utf8");
  const baseline = JSON.parse(baselineText);
  const mapIdFields = {
    handles: "handleId",
    intents: "intentId",
    stopRequests: "stopRequestId",
    stopReceipts: "stopReceiptId",
    recoveryPlans: "recoveryPlanId"
  };
  for (const [mapKey, idField] of Object.entries(mapIdFields)) {
    const forged = structuredClone(baseline);
    const [recordId, record] = Object.entries(forged[mapKey])[0];
    const forgedMapId = `rekey-${mapKey}`;
    delete forged[mapKey][recordId];
    forged[mapKey][forgedMapId] = record;
    forged.stateDigest = registryDigest(forged);
    await writeFile(registry.registryPath, `${JSON.stringify(forged)}\n`, "utf8");
    await assert.rejects(
      loadExecutionRegistry({ stateRoot: registry.root.replace(/\/execution-runtime-v1$/, ""), runId: RUN_ID, controller: controllerFixture.controller }),
      new RegExp(`map key|${idField}`)
    );
    await writeFile(registry.registryPath, baselineText, "utf8");
  }
});

test("durable intent precedes the effect and concurrent callers allow one callback", async (t) => {
  const { root, registry, fixture } = await runtime(t);
  const handle = await registry.createExecutionHandle(binding());
  let calls = 0;
  const results = await Promise.allSettled([
    registry.execute(handle.handleId, async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { outcome: "success", value: "one" };
    }),
    registry.execute(handle.handleId, async () => {
      calls += 1;
      return { outcome: "success", value: "two" };
    })
  ]);
  assert.equal(calls, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(String(results.find((result) => result.status === "rejected").reason), /already in flight|Run is leased/);
  const state = await registry.load();
  const intent = Object.values(state.intents)[0];
  assert.equal(intent.status, "sealed");
  assert.equal(intent.callbackCalls, 1);
  await assert.rejects(
    readExecutionSealedEffectArtifactV1({ stateRoot: root, runId: RUN_ID, controller: fixture.controller, intentId: intent.intentId }),
    (error) => error.code === "EEXECUTION_SEALED_EFFECT_ARTIFACT_UNAVAILABLE" && error.status === "HOLD"
  );
});

test("queued registry work expires before the pump starts it and cannot run late", async (t) => {
  let releaseWriter;
  const writerGate = new Promise((resolve) => { releaseWriter = resolve; });
  let writerEnteredResolve;
  const writerEntered = new Promise((resolve) => { writerEnteredResolve = resolve; });
  let handleCreatedWrites = 0;
  const journalWriter = async (root, runDir, event, details) => {
    if (details?.op === "handle.created") {
      handleCreatedWrites += 1;
      writerEnteredResolve();
      await writerGate;
    }
    return appendJournal(root, runDir, event, details);
  };
  const { root, registry, fixture } = await runtime(t, { journalWriter });
  const first = registry.createExecutionHandle(binding());
  try {
    await within(writerEntered, 1_000, "held registry write");
    const secondRegistry = await openExecutionRegistry({
      stateRoot: root,
      runId: RUN_ID,
      controller: fixture.controller,
      journalWriter
    });
    await assert.rejects(
      secondRegistry.createExecutionHandle(binding({ executionId: "execution-queue-2", attemptId: "attempt-queue-2", unitId: "unit-queue-2" })),
      (error) => error?.code === "EEXECUTION_RUNTIME_QUEUE_TIMEOUT" && error?.status === "UNKNOWN"
    );
    assert.equal(handleCreatedWrites, 1, "an expired queued callback must not write after its promise rejected");
  } finally {
    releaseWriter();
    await within(first, 5_000, "held registry write cleanup");
  }
});

test("authority is rechecked after dispatch persistence and a revoked callback is not sent", async (t) => {
  const controllerFixture = fixture();
  const { root, registry } = await runtime(t, { fixture: controllerFixture });
  const handle = await registry.createExecutionHandle(binding());
  let calls = 0;
  await assert.rejects(
    registry.execute(handle.handleId, async () => {
      calls += 1;
      return { outcome: "success" };
    }, {
      faults: {
        afterDispatchBeforeEffect: async () => {
          controllerFixture.current.revoked = true;
        }
      }
    }),
    (error) => {
      assert.equal(error.code, "EFFECT_NOT_SENT");
      assert.match(error.message, /not sent/i);
      assert.equal(isExecutionRuntimeEffectNotSent(error, {
        runId: handle.runId,
        handleId: handle.handleId,
        ownedResourceId: handle.ownedResourceId
      }), true);
      assert.equal(isExecutionRuntimeEffectNotSent({ ...error }, {
        runId: handle.runId,
        handleId: handle.handleId,
        ownedResourceId: handle.ownedResourceId
      }), false);
      assert.equal(EXECUTION_EFFECT_NOT_SENT_KIND, "ExecutionEffectNotSentV1");
      return true;
    }
  );
  assert.equal(calls, 0);
  const state = await registry.load();
  const intent = Object.values(state.intents).find((value) => value.handleId === handle.handleId);
  assert.equal(intent.status, "not-sent");
  assert.equal(intent.callbackCalls, 0);
  assert.equal(intent.dispatchReserved, false);
  assert.equal(intent.notSentReason, "authority-stale-before-effect");
  const restarted = await loadExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: controllerFixture.controller });
  assert.equal(restarted.intents[intent.intentId].status, "not-sent");
  controllerFixture.current.revoked = false;
  const retried = await registry.execute(handle.handleId, async () => {
    calls += 1;
    return { outcome: "success", retried: true };
  });
  assert.equal(retried.outcome, "success");
  assert.equal(calls, 1);
});

test("lost dispatching intent cannot mint a not-sent proof", async (t) => {
  const controllerFixture = fixture();
  const { registry } = await runtime(t, { fixture: controllerFixture });
  const handle = await registry.createExecutionHandle(binding());
  const settled = await registry.execute(handle.handleId, async () => ({ outcome: "success" }), {
    faults: {
      afterDispatchBeforeEffect: async (intent) => {
        controllerFixture.lifecycle.status = "terminated";
        controllerFixture.lifecycle.previousIncarnation = intent.controllerIncarnation;
        controllerFixture.lifecycle.previousOwnerLeaseId = intent.ownerLeaseId;
        await registry.reconcileAfterControllerStop();
      }
    }
  }).then(
    (result) => ({ result }),
    (error) => ({ error })
  );
  assert.equal(settled.result, undefined);
  assert.equal(settled.error?.code, "EEXECUTION_EFFECT_UNKNOWN");
  assert.equal(settled.error?.status, "UNKNOWN");
  assert.match(settled.error?.cause?.message ?? "", /revoked|dispatch-blocked|execution intent/i);
  assert.equal(isExecutionRuntimeEffectNotSent(settled.error, {
    runId: handle.runId,
    handleId: handle.handleId,
    ownedResourceId: handle.ownedResourceId
  }), false);
  const state = await registry.load();
  const intent = Object.values(state.intents).find((value) => value.handleId === handle.handleId);
  assert.equal(intent.status, "unknown");
  assert.equal(state.handles[handle.handleId].status, "indeterminate");
  assert.equal(state.handles[handle.handleId].dispatchBlocked, true);
});

test("not-sent persistence failure returns UNKNOWN without minting a proof", async (t) => {
  const journalWriter = async (root, runDir, kind, event) => {
    if (event.op === "intent.not-sent") {
      throw Object.assign(new Error("simulated not-sent journal failure"), { code: "EJOURNAL_NOT_SENT" });
    }
    return appendJournal(root, runDir, kind, event);
  };
  const controllerFixture = fixture();
  const { registry } = await runtime(t, { fixture: controllerFixture, journalWriter });
  const handle = await registry.createExecutionHandle(binding());
  const settled = await registry.execute(handle.handleId, async () => ({ outcome: "success" }), {
    faults: {
      afterDispatchBeforeEffect: async () => {
        controllerFixture.current.revoked = true;
      }
    }
  }).then(
    (result) => ({ result }),
    (error) => ({ error })
  );
  assert.equal(settled.result, undefined);
  assert.equal(settled.error?.code, "EEXECUTION_EFFECT_UNKNOWN");
  assert.equal(settled.error?.status, "UNKNOWN");
  assert.match(settled.error?.cause?.message ?? "", /active|revoked|stale|authority/i);
  assert.equal(settled.error?.proofError?.code, "EJOURNAL_NOT_SENT");
  assert.equal(isExecutionRuntimeEffectNotSent(settled.error), false);
  const state = await registry.load();
  const intent = Object.values(state.intents).find((value) => value.handleId === handle.handleId);
  assert.equal(intent.status, "dispatching");
  assert.equal(intent.callbackCalls, 0);
  assert.equal(intent.dispatchReserved, true);
});

test("not-sent stale epoch requires fresh resume before retry", async (t) => {
  const controllerFixture = fixture();
  const { registry } = await runtime(t, { fixture: controllerFixture });
  const handle = await registry.createExecutionHandle(binding());
  let calls = 0;
  await assert.rejects(
    registry.execute(handle.handleId, async () => {
      calls += 1;
      return { outcome: "success" };
    }, {
      faults: {
        afterDispatchBeforeEffect: async () => {
          controllerFixture.current.epoch = 2;
          controllerFixture.current.fence = "f".repeat(64);
        }
      }
    }),
    (error) => error?.code === "EFFECT_NOT_SENT"
  );
  assert.equal(calls, 0);
  assert.equal((await registry.load()).intents[Object.keys((await registry.load()).intents)[0]].status, "not-sent");
  await assert.rejects(registry.execute(handle.handleId, async () => ({ outcome: "success" })), /stale|epoch|fence/i);
  const resumed = await registry.resumeExecution(handle.handleId, { executionId: "execution-1", attemptId: "attempt-2" });
  assert.equal(resumed.handle.authorityEpoch, 2);
  const result = await registry.execute(resumed.handle.handleId, async () => {
    calls += 1;
    return { outcome: "success", resumed: true };
  });
  assert.equal(result.outcome, "success");
  assert.equal(calls, 1);
});

test("loading and executing another unit do not reconcile a live effect", async (t) => {
  const { registry } = await runtime(t);
  const first = await registry.createExecutionHandle(binding());
  const second = await registry.createExecutionHandle(binding({ executionId: "execution-2", attemptId: "attempt-2", unitId: "unit-2" }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let firstCalls = 0;
  const firstRun = registry.execute(first.handleId, async () => {
    firstCalls += 1;
    await gate;
    return { outcome: "success", unit: "first" };
  });
  for (let attempt = 0; attempt < 100 && firstCalls === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  const during = await registry.load();
  assert.equal(during.intents[Object.keys(during.intents)[0]].status, "dispatching");
  const secondResult = await registry.execute(second.handleId, async () => ({ outcome: "success", unit: "second" }));
  assert.equal(secondResult.outcome, "success");
  assert.equal(firstCalls, 1);
  release();
  const firstResult = await firstRun;
  assert.equal(firstResult.outcome, "success");
  assert.equal((await registry.load()).handles[first.handleId].status, "completed");
});

test("same logical obligation cannot be reserved under a different execution id", async (t) => {
  const { registry } = await runtime(t);
  await registry.createExecutionHandle(binding());
  await assert.rejects(
    registry.createExecutionHandle(binding({ executionId: "execution-2", attemptId: "attempt-2" })),
    /Logical obligation is already reserved/
  );
});

test("stale expected sequence is rejected by the registry CAS", async (t) => {
  const { registry } = await runtime(t);
  const handle = await registry.createExecutionHandle(binding());
  await assert.rejects(
    registry.execute(handle.handleId, async () => ({ outcome: "success" }), { expectedSequence: 0 }),
    /expected sequence mismatch/
  );
});

test("fault before intent produces zero effect and no partial registry intent", async (t) => {
  const { registry } = await runtime(t);
  const handle = await registry.createExecutionHandle(binding());
  let calls = 0;
  await assert.rejects(
    registry.execute(handle.handleId, async () => {
      calls += 1;
      return { outcome: "success" };
    }, { faults: { beforeIntent: async () => { throw new Error("before-intent-fault"); } } }),
    /before-intent-fault/
  );
  assert.equal(calls, 0);
  const state = await registry.load();
  assert.deepEqual(state.intents, {});
});

test("after effect before seal is recovered as UNKNOWN and cannot be called again", async (t) => {
  const { root, registry, fixture } = await runtime(t);
  const handle = await registry.createExecutionHandle(binding());
  let calls = 0;
  await assert.rejects(
    registry.execute(handle.handleId, async () => {
      calls += 1;
      return { outcome: "success", providerReceipt: "unsealed" };
    }, { faults: { afterEffectBeforeSeal: async () => { throw Object.assign(new Error("simulated crash"), { code: "SBW_TEST_CRASH_AFTER_EFFECT_BEFORE_SEAL" }); } } }),
    /simulated crash/
  );
  assert.equal(calls, 1);
  const recovered = await loadExecutionRegistry({ stateRoot: root, runId: RUN_ID, controller: fixture.controller });
  const recoveredIntent = Object.values(recovered.intents)[0];
  assert.equal(recoveredIntent.status, "dispatching", "ordinary load must not mutate a live dispatch");
  assert.equal(recoveredIntent.callbackCalls, 0);
  assert.equal(recoveredIntent.dispatchReserved, true);
  assert.equal(recoveredIntent.notSentAt, null);
  fixture.lifecycle.status = "terminated";
  fixture.lifecycle.incarnation = "controller-2";
  fixture.lifecycle.ownerLeaseId = "lease-2";
  fixture.lifecycle.previousIncarnation = "controller-1";
  fixture.lifecycle.previousOwnerLeaseId = "lease-1";
  const reconciled = await registry.reconcileAfterControllerStop();
  const reconciledIntent = Object.values(reconciled.intents)[0];
  assert.equal(reconciledIntent.status, "unknown");
  assert.equal(reconciledIntent.outcome, "unknown");
  assert.equal(reconciledIntent.callbackCalls, 0);
  assert.equal(reconciledIntent.dispatchReserved, true);
  assert.equal(reconciledIntent.notSentAt, null);
  assert.equal(reconciledIntent.lateCallback, true);
  await assert.rejects(registry.execute(handle.handleId, async () => {
    calls += 1;
    return { outcome: "success" };
  }), /UNKNOWN/);
  assert.equal(calls, 1);
});

test("revocation fences a late callback and leaves local/remote outcomes distinct", async (t) => {
  const calls = [];
  const resourceAdapter = successfulStopAdapter(calls);
  const { registry } = await runtime(t, { resourceAdapter });
  const handle = await registry.createExecutionHandle(binding());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let callbackCalls = 0;
  const running = registry.execute(handle.handleId, async () => {
    callbackCalls += 1;
    await gate;
    return { outcome: "success", value: "late" };
  });
  for (let attempt = 0; attempt < 100 && callbackCalls === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  const receipt = await registry.requestStop(handle.handleId, { reason: "cancel" });
  release();
  await assert.rejects(running, /Late callback rejected|stale|revoked/i);
  validateStopReceiptV1(receipt);
  assert.equal(receipt.localOutcome, "stopped");
  assert.equal(receipt.remoteOutcome, "not-applicable");
  assert.equal(receipt.outcome, "STOPPED");
  assert.equal(calls.length, 1);
  const state = await registry.load();
  const intent = Object.values(state.intents).find((value) => value.handleId === handle.handleId);
  assert.equal(intent.outcome, "unknown");
  assert.equal(intent.lateCallback, true);
});

test("stop receipt and late callback preserve physical and logical outcomes in either order", async (t) => {
  for (const order of ["receipt-first", "callback-first"]) {
    let releaseEffect;
    let releaseStopAdapter;
    let effectEnteredResolve;
    let stopAdapterEnteredResolve;
    const effectGate = new Promise((resolve) => { releaseEffect = resolve; });
    const stopAdapterGate = new Promise((resolve) => { releaseStopAdapter = resolve; });
    const effectEntered = new Promise((resolve) => { effectEnteredResolve = resolve; });
    const stopAdapterEntered = new Promise((resolve) => { stopAdapterEnteredResolve = resolve; });
    const calls = [];
    const resourceAdapter = createOwnedResourceAdapter({
      stopOwned: async ({ ownedResourceId }) => {
        calls.push(ownedResourceId);
        stopAdapterEnteredResolve();
        if (order === "callback-first") await stopAdapterGate;
        return {
          ownedResourceId,
          confirmedOwnedScope: true,
          localOutcome: "stopped",
          remoteOutcome: "not-applicable"
        };
      }
    });
    const { registry } = await runtime(t, { resourceAdapter });
    const handle = await registry.createExecutionHandle(binding({
      executionId: `execution-${order}`,
      attemptId: `attempt-${order}`
    }));
    let callbackCalls = 0;
    const running = registry.execute(handle.handleId, async () => {
      callbackCalls += 1;
      effectEnteredResolve();
      await effectGate;
      return { outcome: "success", value: order };
    });
    running.catch(() => {});
    let stopPromise = null;
    try {
      await within(effectEntered, 2_000, `${order} effect entry`);
      stopPromise = registry.requestStop(handle.handleId, { reason: "cancel" });
      stopPromise.catch(() => {});
      if (order === "callback-first") {
        await within(stopAdapterEntered, 2_000, `${order} stop adapter entry`);
      }
      if (order === "receipt-first") {
        const receipt = await within(stopPromise, 5_000, `${order} receipt`);
        releaseEffect();
        const runningResult = await within(
          running.then(() => ({ ok: true }), (error) => ({ ok: false, error: String(error?.message ?? error) })),
          5_000,
          `${order} late callback`
        );
        await assertStopOrderingOutcome({ order, receipt, runningResult, registry, handle, callbackCalls: () => callbackCalls, calls });
      } else {
        releaseEffect();
        const runningResult = await within(
          running.then(() => ({ ok: true }), (error) => ({ ok: false, error: String(error?.message ?? error) })),
          5_000,
          `${order} late callback`
        );
        releaseStopAdapter();
        const receipt = await within(stopPromise, 5_000, `${order} receipt`);
        await assertStopOrderingOutcome({ order, receipt, runningResult, registry, handle, callbackCalls: () => callbackCalls, calls });
      }
    } finally {
      releaseEffect();
      releaseStopAdapter();
      if (stopPromise) await within(stopPromise, 5_000, `${order} stop cleanup`).catch(() => {});
      await within(running, 5_000, `${order} execution cleanup`).catch(() => {});
    }
  }
});

async function assertStopOrderingOutcome({ order, receipt, runningResult, registry, handle, callbackCalls, calls }) {
  validateStopReceiptV1(receipt);
  assert.equal(receipt.outcome, "STOPPED");
  assert.equal(receipt.localOutcome, "stopped");
  assert.equal(receipt.remoteOutcome, "not-applicable");
  assert.equal(receipt.confirmedOwnedScope, true);
  assert.equal(runningResult.ok, false);
  assert.match(runningResult.error, /Late callback rejected|stale|revoked/i);
  assert.equal(callbackCalls(), 1);
  assert.equal(calls.length, 1);
  const state = await registry.load();
  const intent = Object.values(state.intents).find((value) => value.handleId === handle.handleId);
  const finalHandle = state.handles[handle.handleId];
  assert.equal(intent.status, "unknown");
  assert.equal(intent.outcome, "unknown");
  assert.equal(intent.lateCallback, true);
  assert.equal(finalHandle.dispatchBlocked, true);
  const journal = (await readFile(path.join(registry.runDir, "journal.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const receiptIndex = journal.findIndex((event) => event.op === "stop.receipt.sealed");
  const callbackIndex = journal.findIndex((event) => event.op === "intent.late-callback-rejected");
  assert.ok(receiptIndex >= 0);
  assert.ok(callbackIndex >= 0);
  if (order === "receipt-first") {
    assert.ok(receiptIndex < callbackIndex);
    assert.equal(finalHandle.status, "indeterminate");
  } else {
    assert.ok(callbackIndex < receiptIndex);
    assert.equal(finalHandle.status, "stopped");
  }
  // A consumer must inspect the STOPPED receipt and UNKNOWN intent together;
  // handle.status alone is order-dependent and does not prove physical stop.
}

test("effect error seals UNKNOWN after a concurrent stop lease without overwriting its fence", async (t) => {
  let releaseStopWriter;
  const stopWriterGate = new Promise((resolve) => { releaseStopWriter = resolve; });
  let stopWriterEnteredResolve;
  const stopWriterEntered = new Promise((resolve) => { stopWriterEnteredResolve = resolve; });
  let stopWriterHeld = false;
  const writer = async (root, runDir, event, details) => {
    if (details?.op === "stop.requested" && !stopWriterHeld) {
      stopWriterHeld = true;
      stopWriterEnteredResolve();
      await stopWriterGate;
    }
    return appendJournal(root, runDir, event, details);
  };
  const calls = [];
  const { registry } = await runtime(t, {
    resourceAdapter: successfulStopAdapter(calls),
    journalWriter: writer
  });
  const handle = await registry.createExecutionHandle(binding());
  let releaseEffect;
  const effectGate = new Promise((resolve) => { releaseEffect = resolve; });
  let effectEnteredResolve;
  const effectEntered = new Promise((resolve) => { effectEnteredResolve = resolve; });
  const running = registry.execute(handle.handleId, async () => {
    effectEnteredResolve();
    await effectGate;
    throw Object.assign(new Error("budget-cancel"), { code: "SBW_TEST_BUDGET_CANCEL" });
  });
  running.catch(() => {});
  let stopPromise = null;
  let releaseTimer = null;
  try {
    await within(effectEntered, 2_000, "effect entry");
    stopPromise = registry.requestStop(handle.handleId, { reason: "cancel" });
    stopPromise.catch(() => {});
    await within(stopWriterEntered, 2_000, "stop journal lease contention");
    releaseTimer = setTimeout(() => releaseStopWriter(), 150);
    releaseEffect();
    await assert.rejects(
      within(running, 5_000, "effect error under stop contention"),
      /budget-cancel/
    );
    const receipt = await within(stopPromise, 5_000, "stop receipt under contention");
    validateStopReceiptV1(receipt);
    assert.equal(receipt.outcome, "STOPPED");
    assert.equal(receipt.authorityEpoch, handle.authorityEpoch);
    assert.equal(receipt.fence, handle.fence);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.ownedResourceId, handle.ownedResourceId);
    const state = await registry.load();
    const intent = Object.values(state.intents).find((item) => item.handleId === handle.handleId);
    const request = Object.values(state.stopRequests).find((item) => item.handleId === handle.handleId);
    assert.equal(intent.status, "unknown");
    assert.equal(intent.outcome, "unknown");
    assert.equal(intent.dispatchReserved, false);
    assert.equal(intent.callbackCalls, 1);
    assert.equal(request.authorityEpoch, handle.authorityEpoch);
    assert.equal(request.fence, handle.fence);
    assert.equal(state.handles[handle.handleId].authorityEpoch, handle.authorityEpoch);
    assert.equal(state.handles[handle.handleId].fence, handle.fence);
    assert.equal(state.handles[handle.handleId].dispatchBlocked, true);
  } finally {
    if (releaseTimer !== null) clearTimeout(releaseTimer);
    releaseEffect();
    releaseStopWriter();
    if (stopPromise) await within(stopPromise, 5_000, "contention stop cleanup").catch(() => {});
    await within(running, 5_000, "contention execution cleanup").catch(() => {});
  }
});

test("invalid source and policy are rejected by fresh controller reads", async (t) => {
  const sourceMismatch = fixture();
  sourceMismatch.controller = createTrustedControllerAdapter({
    readRunContract: async ({ runId }) => ({ runId, revision: REVISION, sourceBindingDigest: "f".repeat(64), policyDigest: POLICY_DIGEST, status: "active" }),
    readSourceBinding: async ({ runId }) => ({ runId, revision: REVISION, digest: "f".repeat(64) }),
    readAuthority: async (request) => ({
      kind: "TrustedExecutionAuthorityV1", status: "active", revoked: false, ...request,
      authorityEpoch: 1, fence: "c".repeat(64), envelopeDigest: ENVELOPE_DIGEST,
      envelope: { digest: ENVELOPE_DIGEST, scope: request }
    }),
    trustBoundary: trustBoundary()
  });
  const sourceRuntime = await runtime(t, { fixture: sourceMismatch });
  await assert.rejects(sourceRuntime.registry.createExecutionHandle(binding()), /sourceBindingDigest|source binding/i);

  const policyMismatch = fixture();
  policyMismatch.controller = createTrustedControllerAdapter({
    readRunContract: async ({ runId }) => ({ runId, revision: REVISION, sourceBindingDigest: SOURCE_DIGEST, policyDigest: "f".repeat(64), status: "active" }),
    readSourceBinding: async ({ runId }) => ({ runId, revision: REVISION, digest: SOURCE_DIGEST }),
    readAuthority: async (request) => ({
      kind: "TrustedExecutionAuthorityV1", status: "active", revoked: false, ...request,
      authorityEpoch: 1, fence: "c".repeat(64), envelopeDigest: ENVELOPE_DIGEST,
      envelope: { digest: ENVELOPE_DIGEST, scope: request }
    }),
    trustBoundary: trustBoundary()
  });
  const policyRuntime = await runtime(t, { fixture: policyMismatch });
  await assert.rejects(policyRuntime.registry.createExecutionHandle(binding()), /policyDigest|policy digest/i);
});

test("resume creates a new epoch and preserves the original handle origin", async (t) => {
  const controllerFixture = fixture();
  const stopCalls = [];
  const { registry } = await runtime(t, {
    fixture: controllerFixture,
    resourceAdapter: successfulStopAdapter(stopCalls)
  });
  const oldHandle = await registry.createExecutionHandle(binding());
  const oldOrigin = structuredClone(oldHandle.origin);
  await registry.requestStop(oldHandle.handleId);
  controllerFixture.current.epoch = 2;
  controllerFixture.current.fence = "f".repeat(64);
  const resumed = await registry.resumeExecution(oldHandle.handleId, { executionId: "execution-1", attemptId: "attempt-2" });
  validateRecoveryPlanV1(resumed.recoveryPlan);
  assert.equal(resumed.handle.authorityEpoch, 2);
  assert.equal(resumed.recoveryPlan.oldAuthorityEpoch, 1);
  assert.equal(resumed.recoveryPlan.newAuthorityEpoch, 2);
  const after = await registry.load();
  assert.deepEqual(after.handles[oldHandle.handleId].origin, oldOrigin);
  assert.equal(after.handles[oldHandle.handleId].attemptId, "attempt-1");
  assert.equal(after.handles[resumed.handle.handleId].attemptId, "attempt-2");
  assert.equal(after.handles[resumed.handle.handleId].origin.resumedFromHandleId, oldHandle.handleId);
});

test("stop is restricted to the owned scope and unknown never becomes PASS", async (t) => {
  const calls = [];
  const { registry } = await runtime(t, { resourceAdapter: successfulStopAdapter(calls) });
  const handle = await registry.createExecutionHandle(binding());
  const receipt = await registry.requestStop(handle.handleId, { reason: "pause" });
  assert.equal(calls[0].ownedResourceId, RESOURCE_ID);
  assert.equal(calls[0].request.ownedResourceId, RESOURCE_ID);
  assert.equal(receipt.securityRcaRequired, false);
  const unknownRuntime = await runtime(t);
  const unknownHandle = await unknownRuntime.registry.createExecutionHandle(binding({ executionId: "execution-unknown", attemptId: "attempt-unknown" }));
  const unknown = await unknownRuntime.registry.requestStop(unknownHandle.handleId);
  assert.equal(unknown.outcome, "UNKNOWN");
  assert.notEqual(unknown.outcome, "PASS");
  assert.equal(unknown.remoteOutcome, "not-sent");
});

test("independent stop authority can stop an owned handle after dispatch authority revocation", async (t) => {
  const calls = [];
  const controllerFixture = fixture();
  const { registry } = await runtime(t, {
    fixture: controllerFixture,
    resourceAdapter: successfulStopAdapter(calls)
  });
  const handle = await registry.createExecutionHandle(binding());
  controllerFixture.current.revoked = true;
  controllerFixture.current.revision = "drifted-revision";
  const receipt = await registry.requestStop(handle.handleId, { reason: "controller-failure" });
  assert.equal(receipt.outcome, "STOPPED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ownedResourceId, RESOURCE_ID);
});

test("missing owned scope cannot establish an execution handle", async (t) => {
  const unowned = fixture();
  unowned.controller = createTrustedControllerAdapter({
    readRunContract: async ({ runId }) => ({ runId, revision: REVISION, sourceBindingDigest: SOURCE_DIGEST, policyDigest: POLICY_DIGEST, status: "active" }),
    readSourceBinding: async ({ runId }) => ({ runId, revision: REVISION, digest: SOURCE_DIGEST }),
    readAuthority: async (request) => ({
      kind: "TrustedExecutionAuthorityV1", status: "active", revoked: false,
      ...request, ownedResourceId: undefined, authorityEpoch: 1, fence: "c".repeat(64),
      capabilityDigest: "e".repeat(64), envelopeDigest: ENVELOPE_DIGEST,
      envelope: { digest: ENVELOPE_DIGEST, scope: request }
    }),
    trustBoundary: trustBoundary()
  });
  const { registry } = await runtime(t, { fixture: unowned });
  await assert.rejects(registry.createExecutionHandle(binding()), /scope does not match|ownedResourceId/i);
});

test("journal failure still invokes the trusted emergency stop adapter", async (t) => {
  let failJournal = false;
  const calls = [];
  const fixtureValue = fixture();
  const writer = async (...args) => {
    if (failJournal) throw new Error("log-failure");
    const { appendJournal } = await import("../lib/core.mjs");
    return appendJournal(...args);
  };
  const { registry } = await runtime(t, {
    fixture: fixtureValue,
    resourceAdapter: createOwnedResourceAdapter({
      stopOwned: async (request) => {
        calls.push(request);
        return { localOutcome: "unknown", remoteOutcome: "unknown", confirmedOwnedScope: false };
      }
    }),
    journalWriter: writer
  });
  const handle = await registry.createExecutionHandle(binding());
  failJournal = true;
  await assert.rejects(registry.requestStop(handle.handleId), (error) => {
    assert.equal(error.emergencyStopAttempted, true);
    return /log-failure/.test(error.message);
  });
  assert.equal(calls.length, 1);
});

test("trusted controller adapter, strict shapes, and path boundaries fail closed", async (t) => {
  const { registry } = await runtime(t);
  await assert.rejects(
    openExecutionRegistry({ stateRoot: await temporaryRoot(t), runId: RUN_ID, controller: { readRunContract() {}, readSourceBinding() {}, readAuthority() {} } }),
    /trusted controller adapter/i
  );
  const handle = await registry.createExecutionHandle(binding());
  assert.throws(() => validateExecutionHandleV1({ ...handle, __proto__: { polluted: true } }), /plain object|unexpected shape|forbidden/i);
  assert.throws(() => validateStopRequestV1({ __proto__: {} }), /plain object|unexpected shape/i);
  const outside = path.join(path.dirname(registry.root), "outside");
  await symlink(registry.root, outside);
  await assert.rejects(openExecutionRegistry({ stateRoot: outside, runId: "sbw-20260914T083857Z-abcdefabcdef", controller: fixture().controller }), /symlink|unsafe/i);
});

test("Windows private-state gate precedes execution registry root inspection", { concurrency: false }, async (t) => {
  const root = await temporaryRoot(t);
  const stateRootLink = path.join(root, "state-root-link");
  await symlink(root, stateRootLink, "dir");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(descriptor?.configurable, "process.platform must be configurable for this POSIX-hosted regression");
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    await assert.rejects(
      openExecutionRegistry({ stateRoot: stateRootLink, runId: RUN_ID, controller: fixture().controller }),
      { code: "EWINDOWS_PRIVATE_STATE_BACKEND_UNAVAILABLE", status: "HOLD" }
    );
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("controller and owned-resource brands accept only exact factory instances", async (t) => {
  let interceptedControllerCallback = 0;
  const genuineController = fixture().controller;
  assert.equal(Object.isFrozen(genuineController), true);
  assert.equal(isTrustedControllerAdapter(genuineController), true);

  const derivedController = Object.create(genuineController);
  assert.equal(isTrustedControllerAdapter(derivedController), false);

  const proxiedController = new Proxy(genuineController, {
    get(target, property, receiver) {
      if (property === "readRunContract") {
        interceptedControllerCallback += 1;
        return async () => {
          interceptedControllerCallback += 1;
          throw new Error("proxy callback must not run");
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  assert.equal(isTrustedControllerAdapter(proxiedController), false);

  const reflectedController = {};
  for (const symbol of Object.getOwnPropertySymbols(genuineController)) {
    Object.defineProperty(reflectedController, symbol, Object.getOwnPropertyDescriptor(genuineController, symbol));
  }
  if (Object.getOwnPropertySymbols(genuineController).length === 0) {
    Object.defineProperty(reflectedController, Symbol("trusted-execution-controller-v1"), { value: true });
  }
  assert.equal(isTrustedControllerAdapter(reflectedController), false);
  assert.equal(isTrustedControllerAdapter({ ...genuineController }), false);

  await assert.rejects(
    openExecutionRegistry({
      stateRoot: await temporaryRoot(t),
      runId: RUN_ID,
      controller: derivedController
    }),
    /trusted controller adapter/i
  );
  await assert.rejects(
    openExecutionRegistry({
      stateRoot: await temporaryRoot(t),
      runId: RUN_ID,
      controller: proxiedController
    }),
    /trusted controller adapter/i
  );
  assert.equal(interceptedControllerCallback, 0);

  const genuineResource = createOwnedResourceAdapter({ stopOwned: async () => ({}) });
  assert.equal(Object.isFrozen(genuineResource), true);
  assert.equal(isTrustedOwnedResourceAdapter(genuineResource), true);
  assert.equal(isTrustedOwnedResourceAdapter(Object.create(genuineResource)), false);
  assert.equal(isTrustedOwnedResourceAdapter(new Proxy(genuineResource, {})), false);
  assert.equal(isTrustedOwnedResourceAdapter({ ...genuineResource }), false);
});
