import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import readline from "node:readline/promises";

import { BOUND_CREDENTIAL_WORKSPACE_ROOT, digestObject, sha256 } from "../lib/core.mjs";
import {
  bindNativeCommandToApprovalEnvelope,
  createNativeCommandBinding
} from "../lib/native-command-binding-v1.mjs";
import {
  buildWorkflowPlanV1,
  createTaskContractV3,
  persistWorkflowPlanV1
} from "../lib/workflow-plan-v1.mjs";
import {
  createNativeV3PlanRunner,
  isNativeV3PlanRunner,
  readNativeV3PlanRunnerCheckpoint,
  readNativeV3PlanRunnerResumeReceipt
} from "../lib/native-v3-plan-runner-core.mjs";
import { createNativeV3PlanTaskAdapterFromCommandRunner } from "../lib/native-v3-trusted-plan-producer.mjs";
import {
  collectCooperativeNativeV3OwnerDecision,
  nativeV3AllocationKeyFor,
  prepareCooperativeNativeV3Approval
} from "../lib/native-v3-cooperative-controller.mjs";
import { createNativeV3CommandRunner } from "../lib/native-v3-command-runner.mjs";

const REVISION = "a".repeat(40);
const SOURCE_DIGEST = "b".repeat(64);
const POLICY_DIGEST = "c".repeat(64);
const TEMPLATE_DIGEST = "d".repeat(64);
const ROUTE_DIGEST = "e".repeat(64);
const EXPIRY = "2035-01-01T00:00:00.000Z";
const TRUST_MODE = "cooperative-user-mode";
const RUN_ID = "sbw-20350101T000002Z-abcdef012345";
const PLAN_ID = "native-v3-recovery-fixture";
const TASK_ID = "native";
const UNIT_ID = "unit-native";

function fixedClock() {
  return { now: () => new Date("2030-01-01T00:00:00.000Z") };
}

function shellQuote(value) {
  return `'${value}'`;
}

function makePlan({ attempts = 2, tokens = null, goal = "Run native recovery fixture" } = {}) {
  const task = {
    id: TASK_ID,
    goal,
    dependencies: [],
    role: "root",
    writeOwner: { role: "root", paths: ["src/native"] },
    budget: { attempts, seconds: 20, tokens },
    acceptanceIds: ["accept-native"]
  };
  const contract = createTaskContractV3({
    contractId: `${PLAN_ID}-contract`,
    goal: "Execute a bounded native V3 recovery fixture",
    // The fixture executable lives under the approved workspace root.  The
    // command binding scope is deliberately broad only inside that temporary
    // workspace; the production binding still enforces workspace containment.
    scope: { include: ["."], exclude: [] },
    bindings: {
      source: { revision: REVISION, digest: SOURCE_DIGEST },
      policy: { digest: POLICY_DIGEST },
      template: { id: "native-v3-recovery-template", digest: TEMPLATE_DIGEST },
      route: { receiptId: null, digest: ROUTE_DIGEST }
    },
    roles: [{ id: "root", required: true }],
    modelPolicy: { inherit: true, allow: [], deny: [], requested: null, reported: null, attested: null },
    budget: { attempts, seconds: 20, tokens },
    acceptance: [{
      id: "accept-native",
      description: "Native recovery fixture effect is durably accounted",
      requiredEvidence: [],
      critical: true
    }],
    graph: { tasks: [task] }
  });
  return buildWorkflowPlanV1({ taskContract: contract, planId: PLAN_ID });
}

async function collectFixedOwnerDecision(root, requestDigest, attemptId) {
  const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const createInterfaceMock = mock.method(readline, "createInterface", () => ({
    question: async (prompt, options) => {
      assert.match(prompt, /Plan:|Task:|Source revision:|Effect binding digest:/);
      assert.ok(options?.signal, "owner interaction must be abortable");
      return "approve";
    },
    close() {}
  }));
  try {
    return await collectCooperativeNativeV3OwnerDecision({
      stateRoot: root,
      runId: RUN_ID,
      taskId: TASK_ID,
      attemptId,
      allocationKey: nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId }),
      requestDigest,
      clock: fixedClock()
    });
  } finally {
    createInterfaceMock.mock.restore();
    if (inputDescriptor) Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
    else delete process.stdin.isTTY;
    if (outputDescriptor) Object.defineProperty(process.stdout, "isTTY", outputDescriptor);
    else delete process.stdout.isTTY;
  }
}

async function countEffects(counterPath) {
  try {
    const contents = (await readFile(counterPath, "utf8")).trim();
    return contents === "" ? 0 : contents.split("\n").length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function makeFixture(t, { sleepSeconds = 0, tokens = null } = {}) {
  const root = await mkdtemp(path.join(BOUND_CREDENTIAL_WORKSPACE_ROOT, "sbw-native-v3-recovery-"));
  const workspaceRoot = path.join(root, "workspace");
  const cwd = path.join(workspaceRoot, "approved");
  const executable = path.join(cwd, "approved-command.sh");
  const counterPath = path.join(root, "effect-counter.log");
  const scriptBody = [
    "#!/bin/sh",
    `printf 'started\\n' >> ${shellQuote(counterPath)}`,
    ...(sleepSeconds > 0 ? [`sleep ${sleepSeconds}`] : []),
    "exit 0",
    ""
  ].join("\n");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await writeFile(executable, scriptBody, { mode: 0o755 });
  await chmod(executable, 0o755);
  const plan = makePlan({ tokens });
  await persistWorkflowPlanV1({ root, plan });

  const readFreshSourceBinding = async ({ runId }) => {
    assert.equal(runId, RUN_ID);
    return { revision: REVISION, digest: SOURCE_DIGEST };
  };
  const readTrustPolicy = async ({ runId, requestedTrustMode }) => {
    assert.equal(runId, RUN_ID);
    assert.equal(requestedTrustMode, TRUST_MODE);
    return { policyDigest: POLICY_DIGEST, requiredTrustMode: TRUST_MODE };
  };
  const commandRunners = [];
  t.after(async () => {
    for (const runner of commandRunners.reverse()) await runner.stop({ reason: "cancel" }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  async function createAttempt(attemptNumber) {
    const executionId = `execution-native-recovery-${attemptNumber}`;
    const attemptId = `native.attempt.${attemptNumber}`;
    const bindingPath = path.join(root, `native-command-binding-${attemptNumber}.json`);
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
      scope: plan.taskContract.scope,
      recipient: "native-v3-recovery-test",
      executable,
      executableDigest: sha256(scriptBody),
      args: [],
      cwd,
      env: { PATH: "/usr/bin:/bin" },
      maxOutputBytes: 1024
    }, { workspaceRoot });
    const prepared = await prepareCooperativeNativeV3Approval({
      stateRoot: root,
      planId: PLAN_ID,
      runId: RUN_ID,
      taskId: TASK_ID,
      unitId: UNIT_ID,
      executionId,
      attemptId,
      recipient: binding.recipient,
      action: binding.action,
      sourceBinding: { revision: REVISION, digest: SOURCE_DIGEST },
      policyDigest: POLICY_DIGEST,
      effectBindingDigest: binding.commandDigest,
      trustMode: TRUST_MODE,
      readFreshSourceBinding,
      readTrustPolicy,
      sourceCwd: workspaceRoot,
      clock: fixedClock(),
      allocationKey: nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId }),
      expiresAt: EXPIRY
    });
    const bound = bindNativeCommandToApprovalEnvelope(binding, prepared.approvalEnvelope, { workspaceRoot });
    await writeFile(bindingPath, `${JSON.stringify(bound)}\n`, { mode: 0o600 });
    const ownerDecision = await collectFixedOwnerDecision(root, prepared.ownerApprovalRequest.requestDigest, attemptId);
    const commandRunner = await createNativeV3CommandRunner({
      stateRoot: root,
      workspaceRoot,
      planId: PLAN_ID,
      runId: RUN_ID,
      taskId: TASK_ID,
      unitId: UNIT_ID,
      executionId,
      attemptId,
      bindingPath,
      expectedCommandDigest: bound.commandDigest,
      approvalEnvelope: prepared.approvalEnvelope,
      effectBindingDigest: bound.commandDigest,
      ownerDecision,
      sourceBinding: { revision: REVISION, digest: SOURCE_DIGEST },
      policyDigest: POLICY_DIGEST,
      readFreshSourceBinding,
      readTrustPolicy,
      trustMode: TRUST_MODE,
      sourceCwd: workspaceRoot,
      clock: fixedClock(),
      allocationKey: nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId }),
      planTaskMode: "trusted-plan-task"
    });
    commandRunners.push(commandRunner);
    return {
      commandRunner,
      adapter: createNativeV3PlanTaskAdapterFromCommandRunner({ runner: commandRunner })
    };
  }

  return { root, plan, counterPath, createAttempt };
}

test("pause persists a pre-effect boundary and fresh resume executes the task exactly once", async (t) => {
  const fixture = await makeFixture(t);
  const first = await fixture.createAttempt(1);
  const second = await fixture.createAttempt(2);
  let drifted = false;
  const changedPlan = makePlan({ goal: "source-drifted recovery fixture" });
  const runner = await createNativeV3PlanRunner({
    stateRoot: fixture.root,
    plan: fixture.plan,
    planId: PLAN_ID,
    runId: RUN_ID,
    parallelism: 1,
    taskAdapter: first.adapter,
    readFreshPlan: async () => drifted ? changedPlan : fixture.plan,
    clock: fixedClock()
  });

  const paused = await runner.pause();
  assert.equal(paused.status, "paused");
  assert.equal(paused.dispatchBlocked, true);
  assert.equal(paused.tasks[TASK_ID].status, "pending");
  assert.deepEqual(paused.tasks[TASK_ID].attemptId, null);
  const pauseEvent = paused.events.find((event) => event.type === "run.paused");
  assert.deepEqual(pauseEvent.detail.freshAttemptTaskIds, [TASK_ID]);
  assert.equal(await countEffects(fixture.counterPath), 0);

  await assert.rejects(
    () => runner.resume({ taskAdapter: first.adapter }),
    (error) => error?.code === "EPLAN_RESUME_ADAPTER_REQUIRED" && error?.status === "HOLD"
  );
  drifted = true;
  await assert.rejects(
    () => runner.resume({ taskAdapter: second.adapter }),
    (error) => error?.code === "EPLAN_SOURCE_DRIFT" && error?.status === "HOLD"
  );
  drifted = false;

  // Resume through a new runner instance to exercise the durable checkpoint
  // boundary.  The old owner cannot carry its adapter/lease across this
  // handoff; the new instance must use the freshly approved attempt.
  const resumer = await createNativeV3PlanRunner({
    stateRoot: fixture.root,
    plan: fixture.plan,
    planId: PLAN_ID,
    runId: RUN_ID,
    parallelism: 1,
    taskAdapter: second.adapter,
    clock: fixedClock()
  });
  const transitionStartedAt = Date.now();
  const resumeReceipt = await resumer.resumeTransition({
    taskAdapter: second.adapter,
    controlRequestDigest: "f".repeat(64)
  });
  assert.ok(Date.now() - transitionStartedAt < 1_000, "resume transition must not wait for the full DAG run");
  assert.equal(isNativeV3PlanRunner(resumer), true);
  assert.equal(resumeReceipt.kind, "NativeV3PlanResumeTransitionReceiptV1");
  assert.equal(resumeReceipt.runId, RUN_ID);
  assert.equal(resumeReceipt.planId, PLAN_ID);
  assert.equal(resumeReceipt.requestDigest, "f".repeat(64));
  assert.equal(resumeReceipt.beforeCheckpointDigest, paused.stateDigest);
  assert.equal(resumeReceipt.freshAdapter, true);
  assert.equal(resumeReceipt.freshEpoch, resumeReceipt.ownerId);
  assert.equal(resumeReceipt.resumeGrant.kind, "NativeV3PlanResumeTransitionGrantV1");
  assert.equal(resumeReceipt.resumeGrant.epoch, resumeReceipt.freshEpoch);
  assert.equal(resumeReceipt.resumeGrant.effectAllowed, false);
  assert.equal(resumeReceipt.currentAdmission.status, "pending");
  assert.equal(resumeReceipt.currentAdmission.resumeGrantDigest, resumeReceipt.resumeGrant.grantDigest);
  assert.equal(resumeReceipt.effectAllowed, false);
  assert.equal(resumeReceipt.afterCheckpoint.stateDigest, resumeReceipt.afterCheckpointDigest);
  assert.equal(resumeReceipt.afterCheckpoint.sequence, resumeReceipt.afterSequence);
  assert.deepEqual(resumeReceipt.lineageDigests, [resumeReceipt.afterCheckpointDigest]);
  assert.equal(
    resumeReceipt.afterCheckpoint.events.at(-1).previousStateDigest,
    resumeReceipt.beforeCheckpointDigest
  );
  assert.deepEqual(
    readNativeV3PlanRunnerResumeReceipt(resumer, {
      requestDigest: "f".repeat(64),
      beforeCheckpointDigest: paused.stateDigest
    }),
    resumeReceipt
  );
  const forgedShape = {
    ...resumer,
    kind: resumer.kind,
    runId: RUN_ID,
    planId: PLAN_ID,
    resumeTransition: async () => resumeReceipt
  };
  assert.equal(isNativeV3PlanRunner(forgedShape), false);
  assert.equal(readNativeV3PlanRunnerResumeReceipt(forgedShape), null);
  const derivedShape = Object.create(resumer);
  assert.equal(isNativeV3PlanRunner(derivedShape), false);
  assert.equal(readNativeV3PlanRunnerResumeReceipt(derivedShape), null);
  const proxiedRunner = new Proxy(resumer, {});
  assert.equal(isNativeV3PlanRunner(proxiedRunner), false);
  assert.equal(readNativeV3PlanRunnerResumeReceipt(proxiedRunner), null);
  const result = await resumer.run();
  assert.equal(result.status, "succeeded");
  assert.equal(result.tasks[TASK_ID].status, "succeeded");
  assert.equal(result.tasks[TASK_ID].attemptId, "native.attempt.2");
  assert.equal(result.tasks[TASK_ID].attempts, 2);
  assert.equal(result.tasks[TASK_ID].dispatches, 1);
  assert.equal(await countEffects(fixture.counterPath), 1);
  const checkpoint = await readNativeV3PlanRunnerCheckpoint({ stateRoot: fixture.root, runId: RUN_ID });
  assert.equal(checkpoint.status, "succeeded");
  assert.ok(checkpoint.events.some((event) => event.type === "run.resumed"));
  assert.equal(checkpoint.events.filter((event) => event.type === "task.dispatching").length, 1);
  const progressedReceipt = readNativeV3PlanRunnerResumeReceipt(resumer, {
    requestDigest: "f".repeat(64),
    beforeCheckpointDigest: paused.stateDigest
  });
  assert.ok(progressedReceipt.lineageDigests.includes(checkpoint.stateDigest));
  assert.ok(progressedReceipt.lineageDigests.length > 1, "native progress must extend the private resume lineage");
  assert.equal((await runner.pause()).status, "succeeded", "a late pause must not reopen a terminal run");
});

test("ordinary resume cannot bypass a prepared incident-recovery runtime claim", async (t) => {
  const fixture = await makeFixture(t);
  const first = await fixture.createAttempt(1);
  const second = await fixture.createAttempt(2);
  const runner = await createNativeV3PlanRunner({
    stateRoot: fixture.root,
    plan: fixture.plan,
    planId: PLAN_ID,
    runId: RUN_ID,
    parallelism: 1,
    taskAdapter: first.adapter,
    clock: fixedClock()
  });
  const paused = await runner.pause();
  const detail = {
    schemaVersion: 1,
    kind: "NativeV3PlanIncidentRecoveryBoundaryV1",
    recoveryId: "recovery-native-claim-gate",
    recoveryPlanDigest: "1".repeat(64),
    handoffId: "handoff-native-claim-gate",
    handoffDigest: "2".repeat(64),
    sourceCheckpointSequence: paused.sequence,
    sourceCheckpointStateDigest: paused.stateDigest,
    sourceRegistrySequence: 0,
    sourceRegistryStateDigest: "3".repeat(64),
    committedRegistrySequence: 1,
    committedRegistryStateDigest: "4".repeat(64),
    taskIds: [TASK_ID],
    preservedTaskIds: [],
    sourceTasks: { [TASK_ID]: structuredClone(paused.tasks[TASK_ID]) },
    entries: [{
      taskId: TASK_ID,
      handleId: "handle-native-claim-gate",
      attemptId: "native.attempt.1",
      handleDigest: "5".repeat(64),
      admissionDigest: "6".repeat(64)
    }],
    effectAuthority: {
      mayResume: false,
      mayDispatch: false,
      mayPerformEffects: false
    }
  };
  const event = {
    sequence: paused.sequence + 1,
    previousStateDigest: paused.stateDigest,
    type: "run.incident-recovery-prepared",
    at: "2030-01-01T00:00:01.000Z",
    taskId: null,
    attemptId: null,
    detail
  };
  const body = {
    ...structuredClone(paused),
    sequence: event.sequence,
    events: [...paused.events, event],
    updatedAt: event.at
  };
  delete body.stateDigest;
  const prepared = { ...body, stateDigest: digestObject(body) };
  const checkpointPath = path.join(
    fixture.root,
    "native-v3-plan-runner-v1",
    "runs",
    RUN_ID,
    "checkpoint.json"
  );
  await writeFile(checkpointPath, `${JSON.stringify(prepared)}\n`, { mode: 0o600 });

  const resumer = await createNativeV3PlanRunner({
    stateRoot: fixture.root,
    plan: fixture.plan,
    planId: PLAN_ID,
    runId: RUN_ID,
    parallelism: 1,
    taskAdapter: second.adapter,
    clock: fixedClock()
  });
  await assert.rejects(
    resumer.resumeTransition({ taskAdapter: second.adapter }),
    (error) => error?.code === "EPLAN_INCIDENT_RECOVERY_CLAIM_REQUIRED" && error?.status === "HOLD"
  );
  assert.equal(await countEffects(fixture.counterPath), 0);
  const after = await readNativeV3PlanRunnerCheckpoint({ stateRoot: fixture.root, runId: RUN_ID });
  assert.equal(after.stateDigest, prepared.stateDigest);
  assert.equal(after.events.some((candidate) => candidate.type === "run.resumed"), false);
});

test("pause after effect entry becomes UNKNOWN, cleans the owned process, and cannot blind-resume", async (t) => {
  const fixture = await makeFixture(t, { sleepSeconds: 5 });
  const attempt = await fixture.createAttempt(1);
  const runner = await createNativeV3PlanRunner({
    stateRoot: fixture.root,
    plan: fixture.plan,
    planId: PLAN_ID,
    runId: RUN_ID,
    parallelism: 1,
    taskAdapter: attempt.adapter,
    clock: fixedClock(),
    stopWaitMs: 2_000
  });

  const running = runner.run();
  await waitFor(() => countEffects(fixture.counterPath).then((count) => count === 1), "owned process effect entry");
  const paused = await runner.pause();
  const result = await running;
  assert.equal(paused.status, "unknown");
  assert.equal(paused.dispatchBlocked, true);
  assert.equal(paused.reconcileRequired, true);
  assert.equal(result.status, "unknown");
  assert.equal(result.tasks[TASK_ID].status, "unknown");
  assert.equal(result.failure.code, "EPLAN_PAUSE_RECONCILIATION_REQUIRED");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await countEffects(fixture.counterPath), 1);
  await assert.rejects(
    () => runner.resume({ taskAdapter: attempt.adapter }),
    (error) => error?.code === "EPLAN_RESUME_RECONCILIATION_REQUIRED" && error?.status === "UNKNOWN"
  );
});

test("fresh resume holds a completed native task when bounded token usage is unknown", async (t) => {
  const fixture = await makeFixture(t, { tokens: 100 });
  const first = await fixture.createAttempt(1);
  const second = await fixture.createAttempt(2);
  const runner = await createNativeV3PlanRunner({
    stateRoot: fixture.root,
    plan: fixture.plan,
    planId: PLAN_ID,
    runId: RUN_ID,
    parallelism: 1,
    taskAdapter: first.adapter,
    clock: fixedClock()
  });

  assert.equal((await runner.pause()).status, "paused");
  const resumer = await createNativeV3PlanRunner({
    stateRoot: fixture.root,
    plan: fixture.plan,
    planId: PLAN_ID,
    runId: RUN_ID,
    parallelism: 1,
    taskAdapter: second.adapter,
    clock: fixedClock()
  });
  await resumer.resumeTransition({
    taskAdapter: second.adapter,
    controlRequestDigest: "f".repeat(64)
  });

  const result = await resumer.run();
  assert.equal(result.status, "hold");
  assert.equal(result.failure.code, "EPLAN_USAGE_UNKNOWN");
  assert.equal(result.dispatchBlocked, true);
  assert.equal(result.tasks[TASK_ID].status, "hold");
  assert.equal(result.tasks[TASK_ID].outcome, "success");
  assert.ok(Number.isSafeInteger(result.tasks[TASK_ID].usage.seconds));
  assert.equal(result.tasks[TASK_ID].usage.tokens, null);
  assert.equal(result.tasks[TASK_ID].dispatches, 1);
  assert.equal(await countEffects(fixture.counterPath), 1);
});
