import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import readline from "node:readline/promises";

import { BOUND_CREDENTIAL_WORKSPACE_ROOT, digestObject, sha256 } from "../lib/core.mjs";
import { autoPolicyDefinition } from "../lib/auto-policy-v1.mjs";
import {
  bindNativeCommandToApprovalEnvelope,
  createNativeCommandBinding
} from "../lib/native-command-binding-v1.mjs";
import {
  createIncidentFirstReportPermissionV1,
  createIncidentFirstReportV1,
  createIncidentRevisionPermissionV1,
  createIncidentRevisionV1
} from "../lib/incident-v1.mjs";
import {
  incidentRecoveryEffectBindingDigestV1,
  prepareIncidentRecoveryV1,
  readIncidentRecoveryReportV1
} from "../lib/incident-recovery-v1.mjs";
import {
  collectCooperativeNativeV3OwnerDecision,
  createCooperativeNativeV3RecoveryController,
  nativeV3AllocationKeyFor,
  prepareCooperativeNativeV3Approval
} from "../lib/native-v3-cooperative-controller.mjs";
import {
  createNativeV3CommandRunner,
  isNativeV3EffectNotSent,
  NATIVE_V3_EFFECT_NOT_SENT_KIND
} from "../lib/native-v3-command-runner.mjs";
import {
  buildWorkflowPlanV1,
  createTaskContractV3,
  persistWorkflowPlanV1
} from "../lib/workflow-plan-v1.mjs";

const POSIX = process.platform === "darwin" || process.platform === "linux";
const TRUST_MODE = "cooperative-user-mode";
const RUN_ID = "sbw-20260915T172800Z-a1b2c3d4e5f6";
const PLAN_ID = "native-v3-command-runner-plan";
const TASK_ID = "native-command-task";
const UNIT_ID = "native-command-unit";
const RECIPIENT = "local-owned-process";
const MODEL = "gpt-5.6-luna";
const REVISION = "a".repeat(40);
const SOURCE_DIGEST = "b".repeat(64);
const POLICY_DIGEST = "c".repeat(64);
const TEMPLATE_DIGEST = "d".repeat(64);
const ROUTE_DIGEST = "e".repeat(64);
const EXPIRY = "2099-01-01T00:00:00.000Z";
const INCIDENT_ID = "incident-runtime-recovery";

const EXECUTABLE = `#!/bin/sh
set -eu
printf '%s' started > "$1"
while [ ! -f "$2" ]; do sleep 0.01; done
exit "$3"
`;

function clock() {
  return { now: () => new Date() };
}

async function collectFixedTTYOwnerDecision(root, requestDigest, allocationKey = undefined, { taskId = undefined, attemptId = undefined } = {}) {
  const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const createInterfaceMock = mock.method(readline, "createInterface", () => ({
    question: async (prompt, options) => {
      assert.match(prompt, /Plan:|Task:|Source revision:|Scope:/);
      assert.ok(options?.signal, "owner interaction must be abortable");
      return "approve";
    },
    close() {}
  }));
  try {
    return await collectCooperativeNativeV3OwnerDecision({
      stateRoot: root,
      runId: RUN_ID,
      taskId,
      attemptId,
      requestDigest,
      allocationKey,
      clock: clock()
    });
  } finally {
    createInterfaceMock.mock.restore();
    if (inputDescriptor) Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
    else delete process.stdin.isTTY;
    if (outputDescriptor) Object.defineProperty(process.stdout, "isTTY", outputDescriptor);
    else delete process.stdout.isTTY;
  }
}

async function markerValue(file) {
  try { return await readFile(file, "utf8"); } catch { return null; }
}

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return Boolean(await predicate());
}

async function within(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function hasOwnedAllocation(root) {
  try {
    const names = await readdir(path.join(root, "posix-owned-process-v1", "allocations"));
    return names.some((name) => /^[0-9a-f-]{36}\.json$/.test(name));
  } catch {
    return false;
  }
}

async function ownedAllocationRecords(root) {
  try {
    const names = await readdir(path.join(root, "posix-owned-process-v1", "allocations"));
    const records = [];
    for (const name of names.filter((item) => /^[0-9a-f-]{36}\.json$/.test(item))) {
      try {
        records.push(JSON.parse(await readFile(path.join(root, "posix-owned-process-v1", "allocations", name), "utf8")));
      } catch {
        // Atomic receipt writes can be observed between create and rename.
      }
    }
    return records;
  } catch {
    return [];
  }
}

async function withHiddenPath(target, callback, { directory = false } = {}) {
  const backup = `${target}.test-backup`;
  await rename(target, backup);
  try {
    if (directory) await mkdir(target, { mode: 0o700 });
    return await callback();
  } finally {
    if (directory) await rm(target, { recursive: true, force: true });
    await rename(backup, target);
  }
}

async function removeFixtureRoot(root) {
  let lastError = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      lastError = null;
    } catch (error) {
      lastError = error;
      if (!/[E](?:NOTEMPTY|BUSY|AGAIN)/.test(String(error?.code ?? ""))) throw error;
    }
    try {
      await readdir(root);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      let stableAbsent = true;
      for (let check = 0; check < 5; check += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          await readdir(root);
          stableAbsent = false;
          break;
        } catch (secondError) {
          if (secondError?.code !== "ENOENT") throw secondError;
        }
      }
      if (stableAbsent) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError ?? new Error(`owned fixture root remained after bounded cleanup: ${root}`);
}

function controllerStatePath(value) {
  return path.join(value.root, "native-v3-cooperative-controller-v1", "runs", RUN_ID, "controller.json");
}

function registryLeasePath(value) {
  return path.join(value.root, "execution-runtime-v1", "runs", RUN_ID, ".lease");
}

function statusIntent(status) {
  return status?.intent ?? status?.durable?.intent ?? status;
}

function taskContract({ mode = "single", seconds = 10, tokens = 100, autoPolicyId = null } = {}) {
  const taskCount = mode === "single" ? 1 : 2;
  const taskBudget = { attempts: 1, seconds, tokens };
  const tasks = [{
    id: TASK_ID,
    goal: "Run one approved local native command",
    dependencies: mode === "dependency" ? ["dependency-task"] : [],
    role: "root",
    writeOwner: { role: "root", paths: [] },
    budget: { ...taskBudget },
    acceptanceIds: ["command-complete"]
  }];
  if (mode === "multitask" || mode === "dependency") {
    tasks.push({
      id: "dependency-task",
      goal: "A second graph task that the command runner cannot select",
      dependencies: [],
      role: "root",
      writeOwner: { role: "root", paths: [] },
      budget: { ...taskBudget },
      acceptanceIds: ["command-complete"]
    });
  }
  return createTaskContractV3({
    contractId: "native-v3-command-runner-contract",
    goal: "Run one bounded approved native command",
    scope: { include: ["."], exclude: [] },
    bindings: {
      source: { revision: REVISION, digest: SOURCE_DIGEST },
      policy: { digest: POLICY_DIGEST },
      template: autoPolicyId === null
        ? { id: "native-v3-command-runner-template", digest: TEMPLATE_DIGEST }
        : { id: "auto", digest: digestObject(autoPolicyDefinition(autoPolicyId)) },
      route: { receiptId: null, digest: ROUTE_DIGEST }
    },
    roles: [{ id: "root", required: true }],
    modelPolicy: {
      inherit: false,
      allow: [MODEL],
      deny: [],
      requested: MODEL,
      reported: null,
      attested: null
    },
    budget: {
      attempts: taskCount,
      seconds: seconds * taskCount,
      tokens: tokens === null ? null : tokens * taskCount
    },
    acceptance: [{
      id: "command-complete",
      description: "The command result is durably recorded.",
      requiredEvidence: [],
      critical: true
    }],
    graph: { tasks }
  });
}

async function fixture(t, { mode = "single", seconds = 10, tokens = 100, code = 0, allocationKey = undefined, autoPolicyId = null } = {}) {
  const root = await mkdtemp(path.join(BOUND_CREDENTIAL_WORKSPACE_ROOT, "sbw-native-v3-command-runner-"));
  let holdFreshReads = false;
  let releaseFreshReads;
  const freshReadGate = new Promise((resolve) => { releaseFreshReads = resolve; });
  let freshReadEnteredResolve;
  const freshReadEntered = new Promise((resolve) => { freshReadEnteredResolve = resolve; });
  t.after(() => {
    holdFreshReads = false;
    releaseFreshReads();
    return removeFixtureRoot(root);
  });
  const workspaceRoot = path.join(root, "workspace");
  const cwd = path.join(workspaceRoot, "approved");
  const executable = path.join(cwd, "owned-command.sh");
  const bindingPath = path.join(root, "native-command-binding.json");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const markerName = "target.marker";
  const releaseName = "target.release";
  const marker = path.resolve(cwd, markerName);
  const release = path.resolve(cwd, releaseName);
  await writeFile(executable, EXECUTABLE, { mode: 0o755 });
  await chmod(executable, 0o755);
  const taskContractValue = taskContract({ mode, seconds, tokens, autoPolicyId });
  const plan = buildWorkflowPlanV1({
    taskContract: taskContractValue,
    planId: PLAN_ID
  });
  await persistWorkflowPlanV1({ root, plan });
  const freshness = {
    sourceBinding: { revision: REVISION, digest: SOURCE_DIGEST },
    policyDigest: POLICY_DIGEST
  };
  const callbacks = {
    readFreshSourceBinding: async ({ runId }) => {
      assert.equal(runId, RUN_ID);
      // Dispatch performs its fresh reads before the POSIX adapter has a
      // durable allocation.  Gate only the later beforeLaunch read, so the
      // test can exercise startup pending without holding the registry lock.
      if (holdFreshReads && await hasOwnedAllocation(root)) {
        freshReadEnteredResolve();
        await freshReadGate;
      }
      return { ...freshness.sourceBinding };
    },
    readTrustPolicy: async ({ runId, requestedTrustMode }) => {
      assert.equal(runId, RUN_ID);
      assert.equal(requestedTrustMode, TRUST_MODE);
      return { policyDigest: freshness.policyDigest, requiredTrustMode: TRUST_MODE };
    }
  };
  const binding = createNativeCommandBinding({
    schemaVersion: 1,
    kind: "NativeCommandBindingV1",
    planDigest: plan.planDigest,
    contractDigest: plan.contractDigest,
    taskId: TASK_ID,
    unitId: UNIT_ID,
    sourceBindingDigest: SOURCE_DIGEST,
    policyDigest: POLICY_DIGEST,
    revision: REVISION,
    scope: { include: ["."], exclude: [] },
    recipient: RECIPIENT,
    executable,
    executableDigest: sha256(EXECUTABLE),
    args: [markerName, releaseName, String(code)],
    cwd,
    env: { PATH: "/usr/bin:/bin" },
    maxOutputBytes: 1024
  }, { workspaceRoot });
  const candidate = await prepareCooperativeNativeV3Approval({
    ...callbacks,
    stateRoot: root,
    planId: PLAN_ID,
    runId: RUN_ID,
    taskId: TASK_ID,
    unitId: UNIT_ID,
    executionId: `execution-${mode}-${seconds}`,
    attemptId: "attempt-1",
    recipient: RECIPIENT,
    action: binding.action,
    sourceBinding: { revision: REVISION, digest: SOURCE_DIGEST },
    policyDigest: POLICY_DIGEST,
    effectBindingDigest: binding.commandDigest,
    requestedModel: MODEL,
    expiresAt: EXPIRY,
    trustMode: TRUST_MODE,
    clock: clock(),
    allocationKey
  });
  const bound = bindNativeCommandToApprovalEnvelope(binding, candidate.approvalEnvelope, { workspaceRoot });
  await writeFile(bindingPath, `${JSON.stringify(bound)}\n`, { mode: 0o600 });
  const ownerDecision = await collectFixedTTYOwnerDecision(
    root,
    candidate.ownerApprovalRequest.requestDigest,
    allocationKey,
    { taskId: TASK_ID, attemptId: "attempt-1" }
  );
  return {
    root,
    workspaceRoot,
    cwd,
    executable,
    bindingPath,
    binding: bound,
    envelope: candidate.approvalEnvelope,
    ownerDecision,
    freshness,
    allocationKey,
    callbacks,
    marker,
    release,
    holdFreshReads: () => { holdFreshReads = true; },
    releaseFreshReads: () => {
      holdFreshReads = false;
      releaseFreshReads();
    },
    freshReadEntered
  };
}

function runnerOptions(fixtureValue, overrides = {}) {
  return {
    stateRoot: fixtureValue.root,
    root: fixtureValue.root,
    workspaceRoot: fixtureValue.workspaceRoot,
    planId: PLAN_ID,
    runId: RUN_ID,
    taskId: TASK_ID,
    unitId: UNIT_ID,
    executionId: fixtureValue.envelope.executionId,
    attemptId: fixtureValue.envelope.attemptId,
    bindingPath: fixtureValue.bindingPath,
    expectedCommandDigest: fixtureValue.binding.commandDigest,
    approvalEnvelope: fixtureValue.envelope,
    effectBindingDigest: fixtureValue.binding.commandDigest,
    ownerDecision: fixtureValue.ownerDecision,
    sourceBinding: { revision: REVISION, digest: SOURCE_DIGEST },
    policyDigest: POLICY_DIGEST,
    readFreshSourceBinding: fixtureValue.callbacks.readFreshSourceBinding,
    readTrustPolicy: fixtureValue.callbacks.readTrustPolicy,
    trustMode: TRUST_MODE,
    sourceCwd: undefined,
    requestedModel: MODEL,
    clock: clock(),
    allocationKey: fixtureValue.allocationKey,
    ...overrides
  };
}

async function startRunner(fixtureValue, overrides = {}) {
  return createNativeV3CommandRunner(runnerOptions(fixtureValue, overrides));
}

async function prepareResumeRunnerOptions(fixtureValue, effectBindingDigest = fixtureValue.binding.commandDigest) {
  const executionId = "execution-resume-2";
  const attemptId = "attempt-resume-2";
  const allocationKey = nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId });
  const priorAllocationKey = nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" });
  const candidate = await prepareCooperativeNativeV3Approval({
    ...fixtureValue.callbacks,
    stateRoot: fixtureValue.root,
    planId: PLAN_ID,
    runId: RUN_ID,
    taskId: TASK_ID,
    unitId: UNIT_ID,
    executionId,
    attemptId,
    recipient: RECIPIENT,
    action: fixtureValue.binding.action,
    sourceBinding: { revision: REVISION, digest: SOURCE_DIGEST },
    policyDigest: POLICY_DIGEST,
    effectBindingDigest,
    requestedModel: MODEL,
    expiresAt: EXPIRY,
    trustMode: TRUST_MODE,
    clock: clock(),
    allocationKey,
    priorAttemptId: "attempt-1",
    priorAllocationKey
  });
  const bindingPath = path.join(fixtureValue.root, "native-command-binding-resume.json");
  const { approvalEnvelopeDigest: ignoredEnvelopeDigest, commandDigest: ignoredCommandDigest, ...unboundValue } = fixtureValue.binding;
  const unbound = createNativeCommandBinding(unboundValue, { workspaceRoot: fixtureValue.workspaceRoot });
  const bound = bindNativeCommandToApprovalEnvelope(unbound, candidate.approvalEnvelope, {
    workspaceRoot: fixtureValue.workspaceRoot
  });
  await writeFile(bindingPath, `${JSON.stringify(bound)}\n`, { mode: 0o600 });
  const ownerDecision = await collectFixedTTYOwnerDecision(
    fixtureValue.root,
    candidate.ownerApprovalRequest.requestDigest,
    allocationKey,
    { taskId: TASK_ID, attemptId }
  );
  return {
    executionId,
    attemptId,
    allocationKey,
    bindingPath,
    binding: bound,
    approvalEnvelope: candidate.approvalEnvelope,
    ownerDecision,
    resumeFromHandleId: undefined
  };
}

test("direct runner holds a persisted Auto read-only plan before creating effect authority", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const readOnlyPlanId = "native-v3-command-runner-read-only-plan";
  const readOnlyPlan = buildWorkflowPlanV1({
    taskContract: taskContract({ autoPolicyId: "read-only-v1" }),
    planId: readOnlyPlanId
  });
  await persistWorkflowPlanV1({ root: value.root, plan: readOnlyPlan });
  const { digest: ignoredDigest, ...unsignedEnvelope } = value.envelope;
  const reboundEnvelope = {
    ...unsignedEnvelope,
    planDigest: readOnlyPlan.planDigest,
    contractDigest: readOnlyPlan.contractDigest
  };
  const syntheticEnvelope = { ...reboundEnvelope, digest: digestObject(reboundEnvelope) };
  await assert.rejects(startRunner(value, {
    planId: readOnlyPlanId,
    approvalEnvelope: syntheticEnvelope
  }), {
    code: "EAUTO_V3_EXECUTION_POLICY_HOLD",
    status: "HOLD"
  });
  await assert.rejects(readFile(value.marker), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(value.root, "execution-runtime-v1", "runs")).catch(() => []), []);
});

test("single native command records dispatching before a held success and seals only after code 0", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const runner = await startRunner(value);
  const execution = runner.execute();
  const executionSettlement = execution.then(
    (result) => ({ result }),
    (error) => ({ error })
  );
  try {
    assert.equal(await waitFor(async () => (await markerValue(value.marker)) === "started"), true);
    assert.equal(typeof runner.handleId, "string");
    const running = statusIntent(await runner.status());
    assert.equal(running.status, "dispatching");
    assert.equal(running.sealedAt, null);
    await writeFile(value.release, "release\n", { mode: 0o600 });
    const result = await within(execution, 5_000, "code 0 execution");
    assert.equal(result.outcome, "success");
    const sealed = statusIntent(await runner.status());
    assert.equal(sealed.status, "sealed");
    assert.equal(sealed.outcome, "success");
    const journalPath = path.join(value.root, "execution-runtime-v1", "runs", RUN_ID, "journal.jsonl");
    const events = (await readFile(journalPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    const artifactEvent = events.find((event) => event.op === "intent.sealed-with-effect" && event.payload.intentId === sealed.intentId);
    assert.ok(artifactEvent);
    assert.deepEqual(artifactEvent.payload.effect, {
      code: 0,
      groupTerminated: true,
      outcome: "success",
      outputExceeded: false,
      signal: null
    });
    assert.equal(artifactEvent.payload.effectDigest, sealed.effectDigest);
    assert.equal(artifactEvent.payload.effectByteLength, Buffer.byteLength(JSON.stringify(artifactEvent.payload.effect), "utf8"));
  } finally {
    await writeFile(value.release, "success-cleanup\n", { mode: 0o600 }).catch(() => {});
    await executionSettlement;
  }
});

test("native runner settles trusted elapsed usage while provider token budget remains unknown", { skip: !POSIX }, async (t) => {
  const value = await fixture(t, { tokens: null });
  const runner = await startRunner(value);
  const execution = runner.execute();
  try {
    assert.equal(await waitFor(async () => (await markerValue(value.marker)) === "started"), true);
    await writeFile(value.release, "unbounded-token-cleanup\n", { mode: 0o600 });
    const result = await within(execution, 5_000, "unbounded token execution");
    assert.equal(result.outcome, "success");
    assert.equal(result.budgetReceipt?.kind, "NativeV3CommandBudgetReceiptV1");
    assert.equal(result.budgetReceipt?.status, "settled");
    assert.equal(result.budgetReceipt?.usage?.attempts, 1);
    assert.equal(result.budgetReceipt?.usage?.tokens, null);
    assert.ok(Number.isSafeInteger(result.budgetReceipt?.usage?.seconds));
    assert.ok(result.budgetReceipt.usage.seconds >= 0 && result.budgetReceipt.usage.seconds <= 10);
    assert.equal(result.budgetReceipt?.decision, "settled-observed-runtime-usage");
  } finally {
    await writeFile(value.release, "unbounded-token-finally-cleanup\n", { mode: 0o600 }).catch(() => {});
    await execution.catch(() => {});
  }
});

test("native runner resumes a not-sent handle without treating the fresh admission as the old handle", { skip: !POSIX }, async (t) => {
  const firstAllocationKey = nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" });
  const value = await fixture(t, { allocationKey: firstAllocationKey });
  const originalReadFreshSourceBinding = value.callbacks.readFreshSourceBinding;
  let mutatePolicyAfterDispatch = true;
  const first = await startRunner(value, {
    readFreshSourceBinding: async (options) => {
      const result = await originalReadFreshSourceBinding(options);
      if (mutatePolicyAfterDispatch) {
        const registryPath = path.join(value.root, "execution-runtime-v1", "runs", RUN_ID, "registry.json");
        try {
          const persisted = JSON.parse(await readFile(registryPath, "utf8"));
          if (Object.values(persisted.intents ?? {}).some((intent) => intent.status === "dispatching")) {
            mutatePolicyAfterDispatch = false;
            const error = new Error("binding permission drift");
            error.code = "ENATIVE_COMMAND_BINDING_FS";
            error.status = "HOLD";
            throw error;
          }
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      return result;
    }
  });
  const firstHandle = (await first.status()).handle;
  assert.ok(firstHandle?.handleId);

  // Make the first dispatch fail in the pre-effect freshness gate. The
  // runtime records a durable not-sent fact and its trusted ledger path may
  // release only that reservation; a fresh controller must not be used as an
  // authority for the old handle.
  const failed = await first.execute().then(
    (result) => ({ result }),
    (error) => ({ error })
  );
  assert.equal(failed.result, undefined);
  assert.equal(failed.error?.code, "EFFECT_NOT_SENT");
  const ledgerPath = path.join(value.root, "execution-runtime-v1", "runs", RUN_ID, "execution-budget-ledger-v1", "ledger.json");
  const firstLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const firstReservation = Object.values(firstLedger.reservations)[0];
  assert.equal(firstReservation.runtime.handleId, firstHandle.handleId);
  assert.equal(firstReservation.status, "released");

  const next = await prepareResumeRunnerOptions(value);
  const resumed = await startRunner(value, {
    executionId: next.executionId,
    attemptId: next.attemptId,
    bindingPath: next.bindingPath,
    expectedCommandDigest: next.binding.commandDigest,
    approvalEnvelope: next.approvalEnvelope,
    effectBindingDigest: next.binding.commandDigest,
    ownerDecision: next.ownerDecision,
    allocationKey: next.allocationKey,
    resumeFromHandleId: firstHandle.handleId
  });
  const execution = resumed.execute();
  try {
    assert.equal(await waitFor(async () => (await markerValue(value.marker)) === "started"), true);
    await writeFile(value.release, "resume-cleanup\n", { mode: 0o600 });
    const result = await within(execution, 5_000, "resumed execution");
    assert.equal(result.outcome, "success");
    assert.equal(result.budgetReceipt?.status, "settled");
    assert.equal(result.budgetReceipt?.usage?.attempts, 1);
    assert.equal(result.budgetReceipt?.usage?.tokens, null);
  } finally {
    await writeFile(value.release, "resume-finally-cleanup\n", { mode: 0o600 }).catch(() => {});
    await execution.catch(() => {});
  }
});

test("native command exit code 7 is a durable failure", { skip: !POSIX }, async (t) => {
  const value = await fixture(t, { code: 7 });
  const runner = await startRunner(value);
  const execution = runner.execute();
  const executionSettlement = execution.then(
    (result) => ({ result }),
    (error) => ({ error })
  );
  try {
    assert.equal(await waitFor(async () => (await markerValue(value.marker)) === "started"), true);
    await writeFile(value.release, "release\n", { mode: 0o600 });
    const result = await within(execution, 5_000, "code 7 execution");
    assert.equal(result.outcome, "failure");
    const status = statusIntent(await runner.status());
    assert.equal(status.status, "sealed");
    assert.equal(status.outcome, "failure");
  } finally {
    await writeFile(value.release, "failure-cleanup\n", { mode: 0o600 }).catch(() => {});
    await executionSettlement;
  }
});

test("wrong command pin is rejected before any target dispatch", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    startRunner(value, { expectedCommandDigest: "0".repeat(64) }),
    /digest|binding|drift/i
  );
  assert.equal(await markerValue(value.marker), null);
});

test("runtime typed no-effect proof carries private exact runner evidence", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const originalReadFreshSourceBinding = value.callbacks.readFreshSourceBinding;
  let rejectWhileIntentIsDispatching = false;
  const runner = await startRunner(value, {
    readFreshSourceBinding: async (options) => {
      const result = await originalReadFreshSourceBinding(options);
      if (rejectWhileIntentIsDispatching) {
        const registryPath = path.join(value.root, "execution-runtime-v1", "runs", RUN_ID, "registry.json");
        const persisted = JSON.parse(await readFile(registryPath, "utf8"));
        if (Object.values(persisted.intents ?? {}).some((intent) => intent.status === "dispatching")) {
          const error = new Error("binding permission drift");
          error.code = "ENATIVE_COMMAND_BINDING_FS";
          error.status = "HOLD";
          throw error;
        }
      }
      return result;
    }
  });
  const handle = (await runner.status()).handle;
  assert.ok(handle);
  rejectWhileIntentIsDispatching = true;

  const settled = await runner.execute().then(
    (result) => ({ result }),
    (error) => ({ error })
  );
  assert.equal(settled.result, undefined);
  assert.equal(settled.error?.code, "EFFECT_NOT_SENT");
  assert.equal(settled.error?.status, "HOLD");
  assert.equal(settled.error?.cause?.code, "EFFECT_NOT_SENT");
  assert.equal(settled.error?.effectNotSent?.kind, NATIVE_V3_EFFECT_NOT_SENT_KIND);
  const expected = {
    runId: handle.runId,
    handleId: handle.handleId,
    ownedResourceId: handle.ownedResourceId
  };
  assert.equal(isNativeV3EffectNotSent(settled.error, expected), true);

  assert.equal(isNativeV3EffectNotSent({
    code: "EFFECT_NOT_SENT",
    effectNotSent: {
      schemaVersion: 1,
      kind: NATIVE_V3_EFFECT_NOT_SENT_KIND,
      ...expected,
      callbackStarted: false
    }
  }, expected), false);
  const copied = { ...settled.error };
  assert.equal(isNativeV3EffectNotSent(copied, expected), false);
  settled.error.effectNotSent = {
    ...settled.error.effectNotSent,
    ownedResourceId: "resource-attacker"
  };
  assert.equal(isNativeV3EffectNotSent(settled.error, expected), true);
  assert.equal(isNativeV3EffectNotSent(settled.error, {
    ...expected,
    ownedResourceId: "resource-attacker"
  }), false);

  const status = await runner.status();
  assert.equal(statusIntent(status)?.status, "not-sent");
  assert.equal(status.handle?.status, "ready");
  assert.equal(await markerValue(value.marker), null);
});

test("post-callback failure preserves durable UNKNOWN and never claims effect-not-sent", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const originalReadFreshSourceBinding = value.callbacks.readFreshSourceBinding;
  let removeCwdAfterDispatching = false;
  const runner = await startRunner(value, {
    readFreshSourceBinding: async (options) => {
      const result = await originalReadFreshSourceBinding(options);
      if (removeCwdAfterDispatching) return result;
      const registryPath = path.join(value.root, "execution-runtime-v1", "runs", RUN_ID, "registry.json");
      let persisted;
      try {
        persisted = JSON.parse(await readFile(registryPath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return result;
        throw error;
      }
      if (Object.values(persisted.intents ?? {}).some((intent) => intent.status === "dispatching")) {
        removeCwdAfterDispatching = true;
        await rm(value.cwd, { recursive: true, force: true });
      }
      return result;
    }
  });

  const fault = await runner.execute().then(
    (result) => ({ result }),
    (error) => ({ error })
  );
  assert.equal(fault.result, undefined);
  const bindingFailure = fault.error?.code === "ENATIVE_COMMAND_BINDING_FS"
    ? fault.error
    : fault.error?.code === "EOWNED_PROCESS_CLEANUP_UNKNOWN"
      ? fault.error.cause
      : null;
  assert.equal(bindingFailure?.code, "ENATIVE_COMMAND_BINDING_FS");
  assert.match(bindingFailure?.message ?? "", /cwd|filesystem|binding/i);
  if (fault.error?.code === "EOWNED_PROCESS_CLEANUP_UNKNOWN") {
    assert.match(fault.error.message, /cleanup.*proven|owned process/i);
  }
  const status = await runner.status();
  assert.equal(statusIntent(status)?.status, "unknown");
  assert.equal(status.handle?.status, "indeterminate");
  assert.equal(status.handle?.dispatchBlocked, true);
  assert.equal(isNativeV3EffectNotSent(fault.error), false);
  const allocations = await ownedAllocationRecords(value.root);
  assert.equal(allocations.length, 1);
  const cleanupProofed = fault.error?.code === "ENATIVE_COMMAND_BINDING_FS";
  assert.equal(allocations.every((record) => cleanupProofed
    ? record.phase === "terminal" && record.startedAt === null && record.groupTerminated === true
    : record.phase === "indeterminate" && record.startedAt === null && record.groupTerminated === false
  ), true, JSON.stringify(allocations));
  assert.equal(await markerValue(value.marker), null);
});

test("runner roots must be absolute and binding aliases must be regular files", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    startRunner(value, { stateRoot: "relative-state-root" }),
    /absolute|stateRoot|root/i
  );
  await assert.rejects(
    startRunner(value, { workspaceRoot: "relative-workspace-root" }),
    /absolute|workspaceRoot/i
  );
  await assert.rejects(
    startRunner(value, { root: path.join(value.root, "different-root") }),
    /same directory|root|stateRoot/i
  );
  await assert.rejects(
    startRunner(value, { effectBindingDigest: "0".repeat(64) }),
    /effectBindingDigest|canonical|fresh/i
  );
  await assert.rejects(
    startRunner(value, { ownerDecision: { ...value.ownerDecision } }),
    /opaque|owner|decision/i
  );
  const alias = path.join(value.root, "binding-alias.json");
  await symlink(value.bindingPath, alias);
  await assert.rejects(
    startRunner(value, { bindingPath: alias }),
    /symlink|regular|filesystem|binding/i
  );
  assert.equal(await markerValue(value.marker), null);
});

test("command binding privacy is required before controller creation and again at launch", { skip: !POSIX }, async (t) => {
  const initial = await fixture(t);
  await chmod(initial.bindingPath, 0o644);
  await assert.rejects(
    startRunner(initial),
    /private|permissions|binding/i
  );
  assert.equal(await markerValue(initial.marker), null);

  const launch = await fixture(t);
  const runner = await startRunner(launch);
  await chmod(launch.bindingPath, 0o644);
  await assert.rejects(
    runner.execute(),
    /private|permissions|binding/i
  );
  assert.equal(await markerValue(launch.marker), null);
});

test("binding, executable, and policy drift fail closed before dispatch", { skip: !POSIX }, async (t) => {
  for (const kind of ["binding", "executable", "policy"]) {
    const value = await fixture(t);
    const original = JSON.parse(await readFile(value.bindingPath, "utf8"));
    const runner = await startRunner(value);
    if (kind === "binding") {
      await writeFile(value.bindingPath, `${JSON.stringify({ ...original, args: ["tampered"] })}\n`, { mode: 0o600 });
    } else if (kind === "executable") {
      await writeFile(value.executable, `${EXECUTABLE}# drift\n`, { mode: 0o755 });
      await chmod(value.executable, 0o755);
    } else {
      value.freshness.policyDigest = "f".repeat(64);
    }
    const execution = runner.execute();
    const executionSettlement = execution.then(
      (result) => ({ result }),
      (error) => ({ error })
    );
    await assert.rejects(execution, /binding|digest|drift|policy|fresh|authority|plan/i);
    await executionSettlement;
    assert.equal(await markerValue(value.marker), null);
  }
});

test("stop during an owned command cannot become a late success", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const runner = await startRunner(value);
  const execution = runner.execute().then((result) => ({ result }), (error) => ({ error }));
  try {
    assert.equal(await waitFor(async () => (await markerValue(value.marker)) === "started"), true);
    value.freshness.sourceBinding = { revision: REVISION, digest: "f".repeat(64) };
    const stop = await within(runner.stop({ reason: "cancel", requestedBy: "native-v3-command-runner" }), 5_000, "runner stop");
    assert.ok(stop);
    const settled = await within(execution, 5_000, "stopped execution");
    assert.equal(settled.result?.outcome === "success", false);
    assert.equal((await runner.status()).handle?.dispatchBlocked, true);
  } finally {
    await writeFile(value.release, "late-release\n", { mode: 0o600 }).catch(() => {});
    await execution;
  }
});

test("budget expiry stops a held command and never reports success", { skip: !POSIX }, async (t) => {
  const value = await fixture(t, { seconds: 1 });
  const runner = await startRunner(value);
  const execution = runner.execute().then((result) => ({ result }), (error) => ({ error }));
  try {
    assert.equal(await waitFor(async () => (await markerValue(value.marker)) === "started"), true);
    const settled = await within(execution, 5_000, "budget expiry");
    assert.equal(settled.result?.outcome === "success", false);
    const status = statusIntent(await runner.status());
    assert.equal(status.status, "unknown");
    const durable = await runner.status();
    assert.equal(durable.handle?.status, "indeterminate");
    assert.equal(durable.handle?.dispatchBlocked, true);
  } finally {
    await writeFile(value.release, "budget-cleanup\n", { mode: 0o600 }).catch(() => {});
    await execution;
  }
});

async function assertNoLateLaunch(value, execution, label) {
  const settled = await within(execution, 5_000, `${label} execution`);
  const allocationSettled = await within(
    waitFor(async () => {
      const records = await ownedAllocationRecords(value.root);
      return records.length > 0 && records.every((record) => (
        record.phase === "terminal" && record.groupTerminated === true && record.startedAt === null
      ));
    }, 5_000),
    6_000,
    `${label} allocation cleanup`
  );
  assert.equal(allocationSettled, true, `${label}: owned allocation did not reach a proven pre-launch terminal state`);
  assert.equal(await markerValue(value.marker), null, `${label}: target was launched after cancellation/failure`);
  assert.equal(settled.result?.outcome === "success", false, `${label}: failed execution became success`);
  return settled;
}

test("startup-pending stop authority read failure cannot launch the target", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const runner = await startRunner(value);
  value.holdFreshReads();
  const execution = runner.execute().then((result) => ({ result }), (error) => ({ error }));
  try {
    await within(value.freshReadEntered, 5_000, "beforeLaunch freshness gate");
    await withHiddenPath(controllerStatePath(value), async () => {
      await assert.rejects(
        within(runner.stop({ reason: "cancel", requestedBy: "native-v3-command-runner" }), 3_000, "stop authority read failure"),
        /authority|controller|state|active|read|unsafe|ENOENT/i
      );
    });
    value.releaseFreshReads();
    await assertNoLateLaunch(value, execution, "startup stop authority failure");
  } finally {
    value.releaseFreshReads();
    await writeFile(value.release, "authority-failure-cleanup\n", { mode: 0o600 }).catch(() => {});
    await within(execution, 12_000, "authority failure cleanup").catch(() => {});
  }
});

test("pre-effect stop latches cancellation before an effectRun exists", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  let holdPreEffectRead = false;
  let releasePreEffectRead;
  const preEffectReadGate = new Promise((resolve) => { releasePreEffectRead = resolve; });
  let preEffectReadEnteredResolve;
  const preEffectReadEntered = new Promise((resolve) => { preEffectReadEnteredResolve = resolve; });
  const originalReadFreshSourceBinding = value.callbacks.readFreshSourceBinding;
  const runner = await startRunner(value, {
    readFreshSourceBinding: async (options) => {
      if (holdPreEffectRead) {
        holdPreEffectRead = false;
        assert.equal(await hasOwnedAllocation(value.root), false, "pre-effect gate must precede adapter allocation");
        preEffectReadEnteredResolve();
        await preEffectReadGate;
      }
      return originalReadFreshSourceBinding(options);
    }
  });
  holdPreEffectRead = true;
  const execution = runner.execute().then((result) => ({ result }), (error) => ({ error }));
  try {
    await within(preEffectReadEntered, 5_000, "pre-effect freshness gate");
    assert.equal(await hasOwnedAllocation(value.root), false);
    const stop = await within(
      runner.stop({ reason: "cancel", requestedBy: "native-v3-command-runner" }),
      3_000,
      "pre-effect cancellation"
    );
    assert.ok(stop);
    releasePreEffectRead();
    const settled = await within(execution, 5_000, "pre-effect cancellation");
    assert.equal(await markerValue(value.marker), null, "target was launched after a pre-effect stop failure");
    assert.equal(settled.result?.outcome === "success", false);
    const records = await ownedAllocationRecords(value.root);
    assert.equal(records.every((record) => record.startedAt === null && record.groupTerminated === true), true);
  } finally {
    holdPreEffectRead = false;
    releasePreEffectRead();
    await writeFile(value.release, "pre-effect-stop-failure-cleanup\n", { mode: 0o600 }).catch(() => {});
    await within(execution, 12_000, "pre-effect stop failure cleanup").catch(() => {});
  }
});

test("startup-pending registry lock failure cannot launch the target", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const runner = await startRunner(value);
  value.holdFreshReads();
  const execution = runner.execute().then((result) => ({ result }), (error) => ({ error }));
  try {
    await within(value.freshReadEntered, 5_000, "beforeLaunch freshness gate");
    const lease = registryLeasePath(value);
    await mkdir(lease, { mode: 0o700 });
    try {
      await assert.rejects(
        within(runner.stop({ reason: "cancel", requestedBy: "native-v3-command-runner" }), 3_000, "registry lock failure"),
        /lease|lock|registry|JSON|directory|unsafe|acquire/i
      );
    } finally {
      await rm(lease, { recursive: true, force: true });
    }
    value.releaseFreshReads();
    await assertNoLateLaunch(value, execution, "startup registry lock failure");
  } finally {
    value.releaseFreshReads();
    await writeFile(value.release, "registry-lock-failure-cleanup\n", { mode: 0o600 }).catch(() => {});
    await within(execution, 12_000, "registry lock failure cleanup").catch(() => {});
  }
});

test("registry handoff timeout stops the owned allocation before returning UNKNOWN", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const runner = await startRunner(value);
  const lease = registryLeasePath(value);
  const originalLstat = fsPromises.lstat;
  fsPromises.lstat = async function poisonedRegistryLease(target, ...args) {
    if (path.resolve(target) === lease) {
      // Keep the observation valid for readJson/withRunLock as well.  The
      // underlying file is still read normally, so lock cleanup can unlink a
      // real lease and this fault cannot strand a synthetic one.
      return { isFile: () => true, isSymbolicLink: () => false, nlink: 1 };
    }
    return originalLstat.call(this, target, ...args);
  };
  syncBuiltinESMExports();
  const execution = runner.execute().then((result) => ({ result }), (error) => ({ error }));
  try {
    const settled = await within(execution, 15_000, "registry handoff timeout");
    assert.equal(settled.result, undefined);
    assert.ok(["ENATIVE_V3_EXECUTION_UNKNOWN", "EEXECUTION_EFFECT_UNKNOWN"].includes(settled.error?.code));
    assert.equal(settled.error?.status, "UNKNOWN");
    assert.match(`${settled.error?.message ?? ""} ${settled.error?.cause?.message ?? ""}`, /lease|handoff|sibling/i);
    await assert.rejects(readFile(lease, "utf8"), { code: "ENOENT" });
    const durable = await runner.status();
    assert.equal(statusIntent(durable)?.status, "unknown");
    assert.equal(durable.handle?.status, "indeterminate");
    assert.equal(durable.handle?.dispatchBlocked, true);
    const records = await ownedAllocationRecords(value.root);
    assert.equal(records.length, 1);
    assert.equal(records.every((record) => (
      record.phase === "terminal" && record.groupTerminated === true
    )), true);
  } finally {
    fsPromises.lstat = originalLstat;
    syncBuiltinESMExports();
    await writeFile(value.release, "handoff-timeout-cleanup\n", { mode: 0o600 }).catch(() => {});
    await within(execution, 12_000, "handoff timeout cleanup").catch(() => {});
  }
});

test("budget timeout while startup is pending cannot launch after a failed stop read", { skip: !POSIX }, async (t) => {
  const value = await fixture(t, { seconds: 1 });
  const runner = await startRunner(value);
  value.holdFreshReads();
  const execution = runner.execute().then((result) => ({ result }), (error) => ({ error }));
  try {
    await within(value.freshReadEntered, 5_000, "beforeLaunch freshness gate");
    await withHiddenPath(controllerStatePath(value), async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_300));
    });
    value.releaseFreshReads();
    await assertNoLateLaunch(value, execution, "budget timeout stop failure");
  } finally {
    value.releaseFreshReads();
    await writeFile(value.release, "budget-stop-failure-cleanup\n", { mode: 0o600 }).catch(() => {});
    await within(execution, 12_000, "budget stop failure cleanup").catch(() => {});
  }
});

test("stale expected epoch, fence, or revision cannot stop the live resource", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const runner = await startRunner(value);
  const execution = runner.execute().then((result) => ({ result }), (error) => ({ error }));
  try {
    assert.equal(await waitFor(async () => (await markerValue(value.marker)) === "started"), true);
    const handle = (await runner.status()).handle;
    assert.ok(handle);
    const stale = [
      ["expectedEpoch", handle.authorityEpoch + 1],
      ["expectedFence", "0".repeat(64)],
      ["expectedRevision", "z".repeat(40)]
    ];
    for (const [key, supplied] of stale) {
      await assert.rejects(
        within(runner.stop({ reason: "cancel", requestedBy: "native-v3-command-runner", [key]: supplied }), 3_000, `${key} stale stop`),
        /mismatch|expected|stale|authority|fence|revision/i
      );
      assert.equal(await markerValue(value.marker), "started", `${key} stale stop killed the live target`);
      const durable = await runner.status();
      const status = statusIntent(durable);
      assert.equal(status.status, "dispatching");
      assert.equal(durable.handle?.dispatchBlocked, false);
    }
    await writeFile(value.release, "stale-stop-cleanup\n", { mode: 0o600 });
    const settled = await within(execution, 5_000, "stale stop completion");
    assert.equal(settled.result?.outcome, "success");
  } finally {
    await writeFile(value.release, "stale-stop-finally-cleanup\n", { mode: 0o600 }).catch(() => {});
    await within(execution, 12_000, "stale stop cleanup").catch(() => {});
  }
});

test("multitask and dependency plans are held before native dispatch", { skip: !POSIX }, async (t) => {
  for (const mode of ["multitask", "dependency"]) {
    const value = await fixture(t, { mode });
    await assert.rejects(
      startRunner(value),
      (error) => {
        assert.equal(error.status, "HOLD");
        return true;
      }
    );
    assert.equal(await markerValue(value.marker), null);
  }
});

test("incident recovery performs one fresh runtime resume and one owned launch", { skip: !POSIX }, async (t) => {
  const firstAllocationKey = nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" });
  const value = await fixture(t, { allocationKey: firstAllocationKey });
  const originalReadFreshSourceBinding = value.callbacks.readFreshSourceBinding;
  let failAfterDispatch = true;
  const failingReadFreshSourceBinding = async (options) => {
    const result = await originalReadFreshSourceBinding(options);
    if (failAfterDispatch) {
      const registryPath = path.join(value.root, "execution-runtime-v1", "runs", RUN_ID, "registry.json");
      try {
        const persisted = JSON.parse(await readFile(registryPath, "utf8"));
        if (Object.values(persisted.intents ?? {}).some((intent) => intent.status === "dispatching")) {
          failAfterDispatch = false;
          const error = new Error("incident recovery source binding gate");
          error.code = "ENATIVE_COMMAND_BINDING_FS";
          error.status = "HOLD";
          throw error;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return result;
  };
  const first = await startRunner(value, { readFreshSourceBinding: failingReadFreshSourceBinding });
  const firstHandle = (await first.status()).handle;
  await assert.rejects(first.execute(), (error) => error?.code === "EFFECT_NOT_SENT");
  assert.equal((await first.status()).intent.status, "not-sent");

  await createIncidentFirstReportV1({
    stateRoot: value.root,
    incidentId: INCIDENT_ID,
    content: {
      title: "Native command recovery",
      summary: "A local command was proven not sent before launch.",
      facts: ["The first command did not invoke the owned process."],
      impact: "A fresh owner approval is required before retry."
    },
    source: { revision: REVISION, digest: SOURCE_DIGEST, scope: "runtime/incidents" },
    capturedAt: "2035-01-01T00:00:00.000Z",
    permission: createIncidentFirstReportPermissionV1({
      stateRoot: value.root,
      incidentId: INCIDENT_ID
    })
  });
  const recoveredController = await createCooperativeNativeV3RecoveryController({
    stateRoot: value.root,
    runId: RUN_ID,
    planId: PLAN_ID,
    taskId: TASK_ID,
    unitId: UNIT_ID,
    executionId: firstHandle.executionId,
    attemptId: firstHandle.attemptId,
    allocationKey: firstAllocationKey,
    sourceBinding: { revision: REVISION, digest: SOURCE_DIGEST },
    policyDigest: POLICY_DIGEST,
    readFreshSourceBinding: value.callbacks.readFreshSourceBinding,
    readTrustPolicy: value.callbacks.readTrustPolicy,
    trustMode: TRUST_MODE,
    clock: clock()
  });
  const recovery = await prepareIncidentRecoveryV1({
    stateRoot: value.root,
    incidentId: INCIDENT_ID,
    incidentRevision: 1,
    runId: RUN_ID,
    handleId: firstHandle.handleId,
    newExecutionId: "execution-resume-2",
    newAttemptId: "attempt-resume-2",
    controller: recoveredController.controller
  });
  const recoveryEffectBindingDigest = incidentRecoveryEffectBindingDigestV1({
    commandDigest: value.binding.commandDigest,
    recoveryPlanDigest: recovery.plan.planDigest
  });
  const next = await prepareResumeRunnerOptions(value, recoveryEffectBindingDigest);
  assert.equal(next.executionId, recovery.plan.newExecutionId);
  assert.equal(next.attemptId, recovery.plan.newAttemptId);
  const resumeControllerStatePath = path.join(
    value.root,
    "native-v3-cooperative-controller-v1",
    "runs",
    RUN_ID,
    "allocations",
    next.allocationKey,
    "controller.json"
  );
  const resumeControllerState = JSON.parse(await readFile(resumeControllerStatePath, "utf8"));
  assert.equal(resumeControllerState.ownerApprovalRequest.effectBindingDigest, recoveryEffectBindingDigest);
  assert.equal(resumeControllerState.ownerApprovalDecision.effectBindingDigest, recoveryEffectBindingDigest);
  const recoveryRunnerOptions = (incidentRecoveryPlan, effectBindingDigest = recoveryEffectBindingDigest) => ({
    executionId: next.executionId,
    attemptId: next.attemptId,
    bindingPath: next.bindingPath,
    expectedCommandDigest: next.binding.commandDigest,
    approvalEnvelope: next.approvalEnvelope,
    effectBindingDigest,
    ownerDecision: next.ownerDecision,
    allocationKey: next.allocationKey,
    resumeFromHandleId: firstHandle.handleId,
    incidentRecoveryPlan
  });
  const substitutedPlan = { ...recovery.plan, reason: "substituted recovery target" };
  await assert.rejects(
    startRunner(value, recoveryRunnerOptions(substitutedPlan)),
    (error) => error?.code === "EINCIDENT_RECOVERY_INTEGRITY"
  );
  assert.equal(await markerValue(value.marker), null, "a substituted recovery plan must not launch the target");
  await assert.rejects(
    startRunner(value, recoveryRunnerOptions(recovery.plan, next.binding.commandDigest)),
    (error) => error?.code === "ENATIVE_V3_BINDING_APPROVAL"
  );
  const resumed = await startRunner(value, recoveryRunnerOptions(recovery.plan));
  const execution = resumed.execute();
  const duplicateExecution = resumed.execute();
  try {
    assert.equal(await waitFor(async () => (await markerValue(value.marker)) === "started"), true);
    await writeFile(value.release, "incident-recovery-cleanup\n", { mode: 0o600 });
    const result = await within(execution, 5_000, "incident recovery execution");
    assert.equal(result.outcome, "success");
    assert.equal((await within(duplicateExecution, 5_000, "duplicate incident recovery execution")).outcome, "success");
    const status = await resumed.status();
    assert.equal(status.handle.origin.resumedFromHandleId, firstHandle.handleId);
    assert.equal(status.intent.status, "sealed");
    const allocations = await ownedAllocationRecords(value.root);
    assert.equal(allocations.length, 1, "the proven not-sent predecessor must not launch an allocation");
    assert.equal(allocations[0].handleId, status.handle.handleId);
    assert.equal(allocations[0].effectStarted, true);

    await createIncidentRevisionV1({
      stateRoot: value.root,
      incidentId: INCIDENT_ID,
      content: {
        title: "Native command recovery revision",
        summary: "The advisory incident changed after the launch completed.",
        facts: ["A later local revision must not authorize a replay of the old plan."],
        impact: "The original recovery binding is stale."
      },
      source: { revision: REVISION, digest: SOURCE_DIGEST, scope: "runtime/incidents" },
      capturedAt: "2035-01-01T00:00:01.000Z",
      permission: createIncidentRevisionPermissionV1({
        stateRoot: value.root,
        incidentId: INCIDENT_ID,
        expectedRevision: 1
      })
    });
    await assert.rejects(
      readIncidentRecoveryReportV1({ stateRoot: value.root, plan: recovery.plan }),
      (error) => error?.code === "EINCIDENT_RECOVERY_STALE" && error?.status === "HOLD"
    );
    assert.equal((await ownedAllocationRecords(value.root)).length, 1, "incident drift must not create a second owned effect");
  } finally {
    await writeFile(value.release, "incident-recovery-finally-cleanup\n", { mode: 0o600 }).catch(() => {});
    await execution.catch(() => {});
  }
});

test("incident recovery final launch fence rejects a revision committed after beforeLaunch", { skip: !POSIX }, async (t) => {
  const firstAllocationKey = nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" });
  const value = await fixture(t, { allocationKey: firstAllocationKey });
  const originalReadFreshSourceBinding = value.callbacks.readFreshSourceBinding;
  let failAfterDispatch = true;
  const failingReadFreshSourceBinding = async (options) => {
    const result = await originalReadFreshSourceBinding(options);
    if (failAfterDispatch) {
      const registryPath = path.join(value.root, "execution-runtime-v1", "runs", RUN_ID, "registry.json");
      try {
        const persisted = JSON.parse(await readFile(registryPath, "utf8"));
        if (Object.values(persisted.intents ?? {}).some((intent) => intent.status === "dispatching")) {
          failAfterDispatch = false;
          const error = new Error("incident recovery source binding gate");
          error.code = "ENATIVE_COMMAND_BINDING_FS";
          error.status = "HOLD";
          throw error;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return result;
  };
  const first = await startRunner(value, { readFreshSourceBinding: failingReadFreshSourceBinding });
  const firstHandle = (await first.status()).handle;
  await assert.rejects(first.execute(), (error) => error?.code === "EFFECT_NOT_SENT");
  assert.equal((await first.status()).intent.status, "not-sent");

  await createIncidentFirstReportV1({
    stateRoot: value.root,
    incidentId: INCIDENT_ID,
    content: {
      title: "Native command recovery final fence",
      summary: "A local command was proven not sent before launch.",
      facts: ["The final launch must be ordered against later incident revisions."],
      impact: "A revision committed before the final fence must block the old recovery plan."
    },
    source: { revision: REVISION, digest: SOURCE_DIGEST, scope: "runtime/incidents" },
    capturedAt: "2035-01-01T00:00:00.000Z",
    permission: createIncidentFirstReportPermissionV1({ stateRoot: value.root, incidentId: INCIDENT_ID })
  });
  const recoveredController = await createCooperativeNativeV3RecoveryController({
    stateRoot: value.root,
    runId: RUN_ID,
    planId: PLAN_ID,
    taskId: TASK_ID,
    unitId: UNIT_ID,
    executionId: firstHandle.executionId,
    attemptId: firstHandle.attemptId,
    allocationKey: firstAllocationKey,
    sourceBinding: { revision: REVISION, digest: SOURCE_DIGEST },
    policyDigest: POLICY_DIGEST,
    readFreshSourceBinding: value.callbacks.readFreshSourceBinding,
    readTrustPolicy: value.callbacks.readTrustPolicy,
    trustMode: TRUST_MODE,
    clock: clock()
  });
  const recovery = await prepareIncidentRecoveryV1({
    stateRoot: value.root,
    incidentId: INCIDENT_ID,
    incidentRevision: 1,
    runId: RUN_ID,
    handleId: firstHandle.handleId,
    newExecutionId: "execution-resume-2",
    newAttemptId: "attempt-resume-2",
    controller: recoveredController.controller
  });
  const recoveryEffectBindingDigest = incidentRecoveryEffectBindingDigestV1({
    commandDigest: value.binding.commandDigest,
    recoveryPlanDigest: recovery.plan.planDigest
  });
  const next = await prepareResumeRunnerOptions(value, recoveryEffectBindingDigest);
  const controllerPath = path.join(
    value.root,
    "native-v3-cooperative-controller-v1",
    "runs",
    RUN_ID,
    "allocations",
    next.allocationKey,
    "controller.json"
  );
  let releaseFinalGate;
  let finalGateEnteredResolve;
  const finalGate = new Promise((resolve) => { releaseFinalGate = resolve; });
  const finalGateEntered = new Promise((resolve) => { finalGateEnteredResolve = resolve; });
  let gateArmed = false;
  let gateUsed = false;
  const gatedReadFreshSourceBinding = async (options) => {
    const result = await value.callbacks.readFreshSourceBinding(options);
    if (gateArmed && !gateUsed) {
      try {
        const state = JSON.parse(await readFile(controllerPath, "utf8"));
        if (state.launchReservation && state.launchAuthorization === null && state.launchCommitment === null) {
          gateUsed = true;
          finalGateEnteredResolve();
          await finalGate;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return result;
  };
  const recoveryRunnerOptions = {
    executionId: next.executionId,
    attemptId: next.attemptId,
    bindingPath: next.bindingPath,
    expectedCommandDigest: next.binding.commandDigest,
    approvalEnvelope: next.approvalEnvelope,
    effectBindingDigest: recoveryEffectBindingDigest,
    ownerDecision: next.ownerDecision,
    allocationKey: next.allocationKey,
    resumeFromHandleId: firstHandle.handleId,
    incidentRecoveryPlan: recovery.plan,
    readFreshSourceBinding: gatedReadFreshSourceBinding
  };
  const resumed = await startRunner(value, recoveryRunnerOptions);
  gateArmed = true;
  const execution = resumed.execute();
  try {
    await within(finalGateEntered, 5_000, "incident final launch fence gate");
    await createIncidentRevisionV1({
      stateRoot: value.root,
      incidentId: INCIDENT_ID,
      content: {
        title: "Native command recovery final fence revision",
        summary: "The incident changed after beforeLaunch but before the final owned launch transaction.",
        facts: ["The revision fence must order this update before the old launch plan."],
        impact: "The resumed target must not spawn from the stale recovery revision."
      },
      source: { revision: REVISION, digest: SOURCE_DIGEST, scope: "runtime/incidents" },
      capturedAt: "2035-01-01T00:00:01.000Z",
      permission: createIncidentRevisionPermissionV1({
        stateRoot: value.root,
        incidentId: INCIDENT_ID,
        expectedRevision: 1
      })
    });
    releaseFinalGate();
    await assert.rejects(
      within(execution, 5_000, "stale incident recovery execution"),
      (error) => error?.code === "EINCIDENT_RECOVERY_STALE"
    );
    assert.equal(await markerValue(value.marker), null, "incident revision drift at the final fence must prevent the target launch");
    const allocationRecords = await ownedAllocationRecords(value.root);
    const resumedAllocationRecords = allocationRecords.filter((record) => record.attemptId === next.attemptId);
    assert.equal(resumedAllocationRecords.some((record) => record.launchCommitmentDigest !== null || record.localOutcome === "started"), false, "a stale incident plan must not record a committed target launch");
  } finally {
    releaseFinalGate();
    await execution.catch(() => {});
    await writeFile(value.release, "incident-final-fence-cleanup\n", { mode: 0o600 }).catch(() => {});
  }
});
