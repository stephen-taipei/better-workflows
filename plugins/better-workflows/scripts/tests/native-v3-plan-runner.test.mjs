import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";
import readline from "node:readline/promises";

import { BOUND_CREDENTIAL_WORKSPACE_ROOT, digestObject, sha256, withRunLock } from "../lib/core.mjs";
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
  createNativeV3TestPlanTaskAdapter,
  createNativeV3TestPosixPlanTaskAdapter,
  readNativeV3PlanRunnerCheckpoint
} from "./native-v3-plan-runner-test-support.mjs";
import {
  createNativeV3PlanRunner as createProductionNativeV3PlanRunner,
  createNativeV3PlanTaskAdapterFromCommandRunner,
  createNativeV3PlanTaskAdapterFromCommandRunners,
  createNativeV3TrustedPlanTaskAdapter
} from "../lib/native-v3-plan-runner.mjs";
import {
  accumulateNativeV3PlanUsage,
  readNativeV3PlanRunnerCheckpoint as readCoreNativeV3PlanRunnerCheckpoint,
  validateNativeV3PlanRunnerCheckpointV1,
  validateNativeV3PlanRunnerCheckpointV2,
  validateNativeV3PlanTaskResult
} from "../lib/native-v3-plan-runner-core.mjs";
import {
  collectCooperativeNativeV3OwnerDecision,
  nativeV3AllocationKeyFor,
  prepareCooperativeNativeV3Approval
} from "../lib/native-v3-cooperative-controller.mjs";
import { createNativeV3CommandRunner } from "../lib/native-v3-command-runner.mjs";
import {
  digestApprovalEnvelope,
  digestActionCapability
} from "../lib/execution-admission-v1.mjs";
import {
  createOwnedResourceAdapter,
  createTrustedControllerAdapter
} from "../lib/execution-runtime-v1.mjs";

const REVISION = "a".repeat(40);
const SOURCE_DIGEST = "b".repeat(64);
const POLICY_DIGEST = "c".repeat(64);
const TEMPLATE_DIGEST = "d".repeat(64);
const ROUTE_DIGEST = "e".repeat(64);
const EXPIRY = "2035-01-01T00:00:00.000Z";
const TRUST_MODE = "cooperative-user-mode";
const PRODUCER_RUN_ID = "sbw-20350101T000001Z-abcdef012345";

function fixedClock() {
  return { now: () => new Date("2030-01-01T00:00:00.000Z") };
}

async function collectFixedTTYOwnerDecision(root, runId, requestDigest, { allocationKey = undefined, taskId = undefined, attemptId = undefined } = {}) {
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
      runId,
      requestDigest,
      ...(taskId === undefined ? {} : { taskId }),
      ...(attemptId === undefined ? {} : { attemptId }),
      clock: fixedClock(),
      ...(allocationKey === undefined ? {} : { allocationKey })
    });
  } finally {
    createInterfaceMock.mock.restore();
    if (inputDescriptor) Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
    else delete process.stdin.isTTY;
    if (outputDescriptor) Object.defineProperty(process.stdout, "isTTY", outputDescriptor);
    else delete process.stdout.isTTY;
  }
}

function shellQuote(value) {
  return `'${value}'`;
}

async function trustedProducerFixture(t, { executableBody = undefined, sleepSeconds = 0, exitCode = 0, taskSpecs = undefined } = {}) {
  const root = await mkdtemp(path.join(BOUND_CREDENTIAL_WORKSPACE_ROOT, "sbw-native-v3-plan-producer-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const workspaceRoot = path.join(root, "workspace");
  const cwd = path.join(workspaceRoot, "approved");
  const executable = path.join(cwd, "approved-command.sh");
  const counterPath = path.join(root, "effect-counter.log");
  const bindingPath = path.join(root, "native-command-binding.json");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const scriptBody = executableBody ?? [
    "#!/bin/sh",
    `printf 'started\\n' >> ${shellQuote(counterPath)}`,
    ...(sleepSeconds > 0 ? [`sleep ${sleepSeconds}`] : []),
    `exit ${exitCode}`,
    ""
  ].join("\n");
  await writeFile(executable, scriptBody, { mode: 0o755 });
  await chmod(executable, 0o755);

  const planId = "native-v3-plan-producer-fixture";
  const selectedTaskSpecs = taskSpecs ?? [{ id: "native", tokens: null, paths: ["src/native"] }];
  const taskId = selectedTaskSpecs[0].id;
  const unitId = `unit-${taskId}`;
  const plan = makePlan(selectedTaskSpecs, planId, ["."]);
  const executionId = `execution-${taskId}-producer-1`;
  const attemptId = `${taskId}.attempt.1`;
  await persistWorkflowPlanV1({ root, plan });
  const readFreshSourceBinding = async ({ runId }) => {
    assert.equal(runId, PRODUCER_RUN_ID);
    return { revision: REVISION, digest: SOURCE_DIGEST };
  };
  const readTrustPolicy = async ({ runId, requestedTrustMode }) => {
    assert.equal(runId, PRODUCER_RUN_ID);
    assert.equal(requestedTrustMode, TRUST_MODE);
    return { policyDigest: POLICY_DIGEST, requiredTrustMode: TRUST_MODE };
  };
  const binding = createNativeCommandBinding({
    schemaVersion: 1,
    kind: "NativeCommandBindingV1",
    planDigest: plan.planDigest,
    contractDigest: plan.contractDigest,
    taskId,
    unitId,
    sourceBindingDigest: SOURCE_DIGEST,
    policyDigest: POLICY_DIGEST,
    revision: REVISION,
    scope: plan.taskContract.scope,
    recipient: "native-v3-plan-producer-test",
    executable,
    executableDigest: sha256(scriptBody),
    args: [],
    cwd,
    env: { PATH: "/usr/bin:/bin" },
    maxOutputBytes: 1024
  }, { workspaceRoot });
  const prepared = await prepareCooperativeNativeV3Approval({
    stateRoot: root,
    planId,
    runId: PRODUCER_RUN_ID,
    taskId,
    unitId,
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
    expiresAt: EXPIRY,
    ...(selectedTaskSpecs.length > 1
      ? { allocationKey: nativeV3AllocationKeyFor({ taskId, attemptId }) }
      : {})
  });
  const bound = bindNativeCommandToApprovalEnvelope(binding, prepared.approvalEnvelope, { workspaceRoot });
  await writeFile(bindingPath, `${JSON.stringify(bound)}\n`, { mode: 0o600 });
  const ownerDecision = await collectFixedTTYOwnerDecision(
    root,
    PRODUCER_RUN_ID,
    prepared.ownerApprovalRequest.requestDigest,
    {
      allocationKey: selectedTaskSpecs.length > 1 ? nativeV3AllocationKeyFor({ taskId, attemptId }) : undefined,
      taskId: selectedTaskSpecs.length > 1 ? taskId : undefined,
      attemptId: selectedTaskSpecs.length > 1 ? attemptId : undefined
    }
  );
  const commandRunner = await createNativeV3CommandRunner({
    stateRoot: root,
    root,
    workspaceRoot,
    planId,
    runId: PRODUCER_RUN_ID,
    taskId,
    unitId,
    executionId: prepared.approvalEnvelope.executionId,
    attemptId: prepared.approvalEnvelope.attemptId,
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
    ...(selectedTaskSpecs.length > 1
      ? {
        planTaskMode: "trusted-plan-task",
        allocationKey: nativeV3AllocationKeyFor({ taskId, attemptId })
      }
      : {})
  });
  return { root, plan, planId, taskId, unitId, binding: bound, commandRunner, counterPath };
}

async function trustedProducerRunnerSetFixture(t, { taskSpecs, scriptBodies = {} } = {}) {
  const root = await mkdtemp(path.join(BOUND_CREDENTIAL_WORKSPACE_ROOT, "sbw-native-v3-plan-producer-set-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  const cwd = path.join(workspaceRoot, "approved");
  const counterPath = path.join(root, "effect-counter.log");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const planId = "native-v3-plan-producer-set-fixture";
  const plan = makePlan(taskSpecs, planId, ["."]);
  await persistWorkflowPlanV1({ root, plan });
  const readFreshSourceBinding = async ({ runId }) => {
    assert.equal(runId, PRODUCER_RUN_ID);
    return { revision: REVISION, digest: SOURCE_DIGEST };
  };
  const readTrustPolicy = async ({ runId, requestedTrustMode }) => {
    assert.equal(runId, PRODUCER_RUN_ID);
    assert.equal(requestedTrustMode, TRUST_MODE);
    return { policyDigest: POLICY_DIGEST, requiredTrustMode: TRUST_MODE };
  };
  const runners = [];
  for (const spec of taskSpecs) {
    const taskId = spec.id;
    const unitId = `unit-${taskId}`;
    const executionId = `execution-${taskId}-producer-1`;
    const attemptId = `${taskId}.attempt.1`;
    const executable = path.join(cwd, `${taskId}.sh`);
    const bindingPath = path.join(root, `native-command-binding-${taskId}.json`);
    const suppliedScriptBody = scriptBodies[taskId];
    const scriptBody = (typeof suppliedScriptBody === "function"
      ? suppliedScriptBody({ root, counterPath, cwd, taskId })
      : suppliedScriptBody) ?? [
      "#!/bin/sh",
      `printf '${taskId}\\n' >> ${shellQuote(counterPath)}`,
      "exit 0",
      ""
    ].join("\n");
    await writeFile(executable, scriptBody, { mode: 0o755 });
    await chmod(executable, 0o755);
    const binding = createNativeCommandBinding({
      schemaVersion: 1,
      kind: "NativeCommandBindingV1",
      planDigest: plan.planDigest,
      contractDigest: plan.contractDigest,
      taskId,
      unitId,
      sourceBindingDigest: SOURCE_DIGEST,
      policyDigest: POLICY_DIGEST,
      revision: REVISION,
      scope: plan.taskContract.scope,
      recipient: "native-v3-plan-producer-set-test",
      executable,
      executableDigest: sha256(scriptBody),
      args: [],
      cwd,
      env: { PATH: "/usr/bin:/bin" },
      maxOutputBytes: 1024
    }, { workspaceRoot });
    const allocationKey = nativeV3AllocationKeyFor({ taskId, attemptId });
    const prepared = await prepareCooperativeNativeV3Approval({
      stateRoot: root,
      planId,
      runId: PRODUCER_RUN_ID,
      taskId,
      unitId,
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
      expiresAt: EXPIRY,
      allocationKey
    });
    const bound = bindNativeCommandToApprovalEnvelope(binding, prepared.approvalEnvelope, { workspaceRoot });
    await writeFile(bindingPath, `${JSON.stringify(bound)}\n`, { mode: 0o600 });
    const ownerDecision = await collectFixedTTYOwnerDecision(
      root,
      PRODUCER_RUN_ID,
      prepared.ownerApprovalRequest.requestDigest,
      { allocationKey, taskId, attemptId }
    );
    runners.push(await createNativeV3CommandRunner({
      stateRoot: root,
      root,
      workspaceRoot,
      planId,
      runId: PRODUCER_RUN_ID,
      taskId,
      unitId,
      executionId: prepared.approvalEnvelope.executionId,
      attemptId: prepared.approvalEnvelope.attemptId,
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
      planTaskMode: "trusted-plan-task",
      allocationKey
    }));
  }
  return {
    root,
    plan,
    planId,
    runners,
    taskAdapter: createNativeV3PlanTaskAdapterFromCommandRunners({ runners }),
    counterPath
  };
}

async function runBoundedChild(source, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      child.once("close", () => {
        reject(new Error(`bounded child timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function effectCount(counterPath) {
  try {
    const value = (await readFile(counterPath, "utf8")).trim();
    return value === "" ? 0 : value.split("\n").length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function fixture(t, taskSpecs, { parallelism = 2, planId = "plan-runner-fixture", adapterOptions = {}, readFreshPlan, clock, stopWaitMs } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-native-v3-plan-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = makePlan(taskSpecs, planId);
  const events = [];
  const adapter = fakeAdapter(plan, events, adapterOptions);
  const runner = await createNativeV3PlanRunner({
    stateRoot: root,
    plan,
    planId,
    runId: "sbw-20350101T000000Z-0123456789ab",
    parallelism,
    taskAdapter: adapter.taskAdapter,
    readFreshPlan,
    clock,
    stopWaitMs
  });
  return { root, plan, events, adapter, runner };
}

function makePlan(taskSpecs, planId = "plan-runner-fixture", scopeInclude = ["src"]) {
  const normalized = taskSpecs.map((spec, index) => ({
    id: spec.id,
    goal: spec.goal ?? `Run ${spec.id}`,
    dependencies: [...(spec.dependencies ?? [])],
    role: spec.role ?? "root",
    writeOwner: { role: spec.writeRole ?? spec.role ?? "root", paths: spec.paths ?? [`src/${spec.id}`] },
    budget: {
      attempts: spec.attempts ?? 1,
      seconds: spec.seconds === undefined ? 10 : spec.seconds,
      tokens: spec.tokens === undefined ? 100 : spec.tokens
    },
    acceptanceIds: [`accept-${index}-${spec.id}`]
  }));
  const roleIds = new Set(normalized.flatMap((task) => [task.role, task.writeOwner.role]));
  const taskBudget = normalized.reduce((totals, task) => ({
    attempts: totals.attempts + task.budget.attempts,
    seconds: totals.seconds === null || task.budget.seconds === null ? null : totals.seconds + task.budget.seconds,
    tokens: totals.tokens === null || task.budget.tokens === null ? null : totals.tokens + task.budget.tokens
  }), { attempts: 0, seconds: 0, tokens: 0 });
  const contract = createTaskContractV3({
    contractId: `${planId}-contract`,
    goal: "Execute a bounded native V3 workflow plan",
    scope: { include: scopeInclude, exclude: [] },
    bindings: {
      source: { revision: REVISION, digest: SOURCE_DIGEST },
      policy: { digest: POLICY_DIGEST },
      template: { id: "native-v3-plan-runner-template", digest: TEMPLATE_DIGEST },
      route: { receiptId: null, digest: ROUTE_DIGEST }
    },
    roles: [...roleIds].sort().map((id) => ({ id, required: true })),
    modelPolicy: { inherit: true, allow: [], deny: [], requested: null, reported: null, attested: null },
    budget: taskBudget,
    acceptance: normalized.map((task) => ({
      id: task.acceptanceIds[0],
      description: `Evidence for ${task.id} is durably recorded`,
      requiredEvidence: [],
      critical: true
    })),
    graph: { tasks: normalized }
  });
  return buildWorkflowPlanV1({ taskContract: contract, planId });
}

function fakeAdapter(plan, events, options = {}) {
  const attempts = new Map();
  const executions = new Map();
  const behavior = options.behavior ?? {};
  const authorityReads = new Map();
  const runtimes = new Map();
  const adapter = createNativeV3TestPlanTaskAdapter({
    async prepareTask(context) {
      const task = context.task;
      const attemptNumber = context.attemptNumber;
      const key = `${task.id}:${attemptNumber}`;
      attempts.set(task.id, (attempts.get(task.id) ?? 0) + 1);
      events.push({ type: "prepare", taskId: task.id, attemptNumber });
      if (options.prepareGate) await options.prepareGate.promise;
      const executionId = `execution-${task.id}-${attemptNumber}`;
      const unitId = `unit-${task.id}`;
      const ownedResourceId = `resource-${task.id}-${attemptNumber}`;
      const binding = {
        runId: context.runId,
        executionId,
        attemptId: context.attemptId,
        unitId,
        ownedResourceId,
        sourceBindingDigest: SOURCE_DIGEST,
        policyDigest: POLICY_DIGEST,
        revision: REVISION
      };
      const runtime = { authorityEpoch: 1, fence: digestObject({ plan: plan.planDigest, task: task.id, attemptNumber }), revoked: false };
      runtimes.set(key, runtime);
      const common = {
        runId: context.runId,
        executionId,
        attemptId: context.attemptId,
        ownedResourceId,
        planDigest: plan.planDigest,
        contractDigest: plan.contractDigest,
        sourceBindingDigest: SOURCE_DIGEST,
        policyDigest: POLICY_DIGEST,
        revision: REVISION,
        taskId: task.id,
        unitId,
        scope: plan.taskContract.scope,
        recipient: `recipient-${task.id}`,
        action: `native-command:${task.id}`,
        budget: task.budget,
        expiresAt: options.expiry ?? EXPIRY,
        nonce: `nonce-${task.id}-${attemptNumber}`
      };
      const envelopeBase = {
        schemaVersion: 1,
        kind: "ApprovalEnvelope",
        envelopeId: `envelope-${task.id}-${attemptNumber}`,
        ...common
      };
      const envelope = { ...envelopeBase, digest: digestApprovalEnvelope({ ...envelopeBase, digest: digestObject(envelopeBase) }) };
      const authorityFor = () => {
        const fence = runtime.fence;
        const capabilityBase = {
          schemaVersion: 1,
          kind: "ActionCapabilityV1",
          capabilityId: `capability-${task.id}-${attemptNumber}`,
          envelopeDigest: envelope.digest,
          ...common,
          authorityEpoch: runtime.authorityEpoch,
          fence
        };
        const capabilityDigest = digestActionCapability(capabilityBase);
        return {
          kind: "TrustedExecutionAuthorityV1",
          status: runtime.revoked ? "revoked" : "active",
          revoked: runtime.revoked,
          ...binding,
          authorityEpoch: runtime.authorityEpoch,
          fence,
          capabilityDigest,
          envelopeDigest: envelope.digest,
          envelope,
          capability: capabilityBase,
          planDigest: plan.planDigest,
          contractDigest: plan.contractDigest,
          nonce: common.nonce
        };
      };
      const stopScope = { runId: context.runId, executionId, attemptId: context.attemptId, unitId, ownedResourceId };
      const stopEnvelope = { scope: stopScope, digest: digestObject({ scope: stopScope }) };
      const behaviorValue = behavior[task.id];
      let resolveExecution;
      let rejectExecution;
      const executionPromise = new Promise((resolve, reject) => {
        resolveExecution = resolve;
        rejectExecution = reject;
      });
      executions.set(key, { resolve: resolveExecution, reject: rejectExecution, promise: executionPromise });
      const onStop = async ({ reason }) => {
        events.push({ type: "stop", taskId: task.id, attemptNumber, reason });
        await options.onStop?.({ task, attemptNumber, context, binding });
        if (options.resolveOnStop !== false) resolveExecution({ outcome: "failure" });
      };
      const resourceAdapter = createOwnedResourceAdapter({
        label: `fixture-resource-${task.id}`,
        stopOwned: async ({ request, ownedResourceId: requestedResourceId }) => {
          await onStop({ reason: request?.reason ?? "cancel" });
          return {
            ownedResourceId: requestedResourceId,
            localOutcome: "stopped",
            remoteOutcome: "not-applicable",
            confirmedOwnedScope: true
          };
        }
      });
      const effect = async () => {
        events.push({ type: "execute", taskId: task.id, attemptNumber });
        options.advanceClockOnEffect?.({ task, attemptNumber });
        if (typeof behaviorValue === "function") return behaviorValue({ task, attemptNumber, context, executionPromise });
        if (behaviorValue && typeof behaviorValue[attemptNumber] === "function") {
          return behaviorValue[attemptNumber]({ task, attemptNumber, context, executionPromise });
        }
        return { outcome: "success" };
      };
      const prepared = {
        taskId: task.id,
        unitId,
        binding,
        controller: createTrustedControllerAdapter({
          trustBoundary: {
            id: `fixture-controller-${task.id}-${attemptNumber}`,
            verify: async ({ request, authority, authorityDigest, result, commitDigest }) => {
              if (authority) return { kind: "TrustedControllerAttestationV1", controllerId: `fixture-controller-${task.id}-${attemptNumber}`, authorityDigest };
              if (result) return { kind: "TrustedAdmissionSealAttestationV1", controllerId: `fixture-controller-${task.id}-${attemptNumber}`, commitDigest };
              throw new Error("fixture trust boundary received an unsupported attestation request");
            }
          },
          readRunContract: async () => ({
            schemaVersion: 3,
            kind: "RunContractV3",
            runId: context.runId,
            status: "active",
            plan: clonePlan(plan),
            planDigest: plan.planDigest,
            contractDigest: plan.contractDigest,
            revision: REVISION,
            sourceBindingDigest: SOURCE_DIGEST,
            policyDigest: POLICY_DIGEST
          }),
          readSourceBinding: async () => ({ runId: context.runId, revision: REVISION, digest: SOURCE_DIGEST }),
          readAuthority: async () => {
            const count = (authorityReads.get(key) ?? 0) + 1;
            authorityReads.set(key, count);
            options.advanceClockOnAuthorityRead?.({ task, attemptNumber, count });
            if (options.driftTask === task.id && count > 1) runtime.fence = digestObject({ drift: key, count });
            return authorityFor();
          },
          readStopAuthority: async () => ({
            kind: "TrustedStopAuthorityV1",
            status: "active",
            revoked: false,
            ...stopScope,
            capabilityDigest: "0".repeat(64),
            envelopeDigest: stopEnvelope.digest,
            envelope: stopEnvelope
          }),
          readControllerLifecycle: async () => ({
            kind: "ControllerLifecycleObservationV1",
            runId: context.runId,
            status: "active",
            incarnation: `fixture-incarnation-${task.id}-${attemptNumber}`,
            ownerLeaseId: `fixture-owner-lease-${task.id}-${attemptNumber}`,
            previousIncarnation: null,
            previousOwnerLeaseId: null,
            observedAt: "2030-01-01T00:00:00.000Z"
          }),
          commitAdmissionSeal: async ({ runId, handleId, intentId, admissionDigest, authorityEpoch, fence, outcome, effectDigest }) => ({
            schemaVersion: 1,
            kind: "TrustedAdmissionSealV1",
            status: "committed",
            runId,
            handleId,
            intentId,
            admissionDigest,
            authorityEpoch,
            fence,
            outcome,
            effectDigest,
            committedAt: "2030-01-01T00:00:00.000Z"
          })
        }),
        resourceAdapter,
        effect
      };
      if (options.revokeTask === task.id) {
        prepared.onDispatchReservation = ({ intent }) => {
          if (intent?.status !== "dispatching" || intent.dispatchReserved !== true) {
            throw new Error("fixture revocation requires a durable dispatch reservation");
          }
          runtime.revoked = true;
          events.push({
            type: "authority-revoked",
            taskId: task.id,
            attemptNumber,
            phase: "after-dispatch-reservation",
            intentStatus: intent.status,
            dispatchReserved: intent.dispatchReserved
          });
        };
      }
      if (options.addApprovalField) prepared.approved = true;
      return prepared;
    },
    attempts,
    executions
  });
  return { taskAdapter: adapter, attempts, executions, runtimes };
}

function clonePlan(plan) {
  return structuredClone(plan);
}

test("diamond DAG dispatches only ready tasks, runs the middle pair in bounded parallel, and reaches D once", async (t) => {
  const b = deferred();
  const c = deferred();
  const value = await fixture(t, [
    { id: "a", paths: ["src/a"] },
    { id: "b", dependencies: ["a"], paths: ["src/b"] },
    { id: "c", dependencies: ["a"], paths: ["src/c"] },
    { id: "d", dependencies: ["b", "c"], paths: ["src/d"] }
  ], { adapterOptions: { behavior: {
    b: () => b.promise,
    c: () => c.promise
  } } });
  const running = value.runner.run();
  await waitFor(
    () => value.events.filter((event) => event.type === "execute" && ["b", "c"].includes(event.taskId)).length === 2,
    "diamond middle tasks",
    30_000
  );
  assert.equal(value.events.some((event) => event.type === "execute" && event.taskId === "d"), false);
  b.resolve({ outcome: "success" });
  c.resolve({ outcome: "success" });
  const result = await running;
  assert.equal(result.status, "succeeded", JSON.stringify({ failure: result.failure, tasks: result.tasks, events: result.checkpoint.events }));
  assert.deepEqual(Object.fromEntries(Object.entries(result.tasks).map(([id, task]) => [id, task.status])), {
    a: "succeeded", b: "succeeded", c: "succeeded", d: "succeeded"
  });
  assert.equal(value.events.filter((event) => event.type === "execute" && event.taskId === "d").length, 1);
  assert.ok(result.checkpoint.events.find((event) => event.type === "task.dispatching" && event.taskId === "b"));
  assert.ok(result.checkpoint.events.find((event) => event.type === "task.dispatching" && event.taskId === "c"));
});

test("independent roots respect configured parallelism and do not dispatch the third root early", async (t) => {
  const left = deferred();
  const right = deferred();
  const third = deferred();
  const value = await fixture(t, [
    { id: "left", paths: ["src/left"] },
    { id: "right", paths: ["src/right"] },
    { id: "third", paths: ["src/third"] }
  ], { parallelism: 2, adapterOptions: { behavior: {
    left: () => left.promise,
    right: () => right.promise,
    third: () => third.promise
  } } });
  const running = value.runner.run();
  try {
    const unexpectedCompletion = running.then((result) => {
      throw new Error(`Plan completed before all independent roots dispatched: ${JSON.stringify(result)}`);
    });
    await Promise.race([
      waitFor(() => value.events.filter((event) => event.type === "execute").length === 2, "two independent roots"),
      unexpectedCompletion
    ]);
    assert.equal(value.events.some((event) => event.type === "execute" && event.taskId === "third"), false);
    left.resolve({ outcome: "success" });
    await Promise.race([
      waitFor(() => value.events.some((event) => event.type === "execute" && event.taskId === "third"), "third root after a slot opens"),
      unexpectedCompletion
    ]);
    right.resolve({ outcome: "success" });
    third.resolve({ outcome: "success" });
    const result = await running;
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(value.events.filter((event) => event.type === "execute").length, 3);
  } catch (error) {
    const state = await value.runner.inspect();
    throw new Error(`${error.message}: ${JSON.stringify({ failure: state.failure, tasks: state.tasks, events: state.events })}`, { cause: error });
  } finally {
    // Settle task-owned callbacks before fixture teardown even when an
    // assertion fails; deleting their checkpoint while they run hides the
    // original failure behind a late ENOENT rejection.
    left.resolve({ outcome: "success" });
    right.resolve({ outcome: "success" });
    third.resolve({ outcome: "success" });
    await Promise.allSettled([running]);
  }
});

test("a terminal task failure propagates to dependents without dispatching them", async (t) => {
  const value = await fixture(t, [
    { id: "failed", paths: ["src/failed"] },
    { id: "downstream", dependencies: ["failed"], paths: ["src/downstream"] }
  ], { adapterOptions: { behavior: {
    failed: () => ({ outcome: "failure" })
  } } });
  const result = await value.runner.run();
  assert.equal(result.status, "failed", JSON.stringify({ failure: result.failure, tasks: result.tasks }));
  assert.equal(result.tasks.failed.status, "failed");
  assert.equal(result.tasks.downstream.status, "blocked");
  assert.equal(value.events.some((event) => event.type === "execute" && event.taskId === "downstream"), false);
  assert.equal(result.dispatchBlocked, true);
});

test("known typed failure may consume its task attempt budget, while UNKNOWN is never retried", async (t) => {
  const retryValue = await fixture(t, [
    { id: "retry", attempts: 2, paths: ["src/retry"] }
  ], { adapterOptions: { behavior: {
    retry: {
      1: () => ({ outcome: "failure" }),
      2: () => ({ outcome: "success" })
    }
  } } });
  const retryResult = await retryValue.runner.run();
  assert.equal(retryResult.status, "succeeded", JSON.stringify(retryResult));
  assert.equal(retryValue.adapter.attempts.get("retry"), 2);

  const unknownValue = await fixture(t, [
    { id: "unknown", attempts: 2, paths: ["src/unknown"] }
  ], { adapterOptions: { behavior: {
    unknown: () => {
      const error = new Error("effect outcome is unknown");
      error.code = "EEXECUTION_EFFECT_UNKNOWN";
      error.status = "UNKNOWN";
      throw error;
    }
  } } });
  const unknownResult = await unknownValue.runner.run();
  assert.equal(unknownResult.status, "unknown", JSON.stringify({ failure: unknownResult.failure, tasks: unknownResult.tasks, events: unknownResult.checkpoint.events }));
  assert.equal(unknownValue.adapter.attempts.get("unknown"), 1);
  assert.equal(unknownResult.tasks.unknown.status, "unknown");
});

test("cancel fences the DAG, stops every owned active task, and prevents late dependent dispatch", async (t) => {
  const left = deferred();
  const right = deferred();
  const value = await fixture(t, [
    { id: "left", paths: ["src/left"] },
    { id: "right", paths: ["src/right"] },
    { id: "after", dependencies: ["left", "right"], paths: ["src/after"] }
  ], { parallelism: 2, adapterOptions: { behavior: {
    left: () => left.promise,
    right: () => right.promise
  }, onStop: ({ task }) => {
    if (task.id === "left") left.resolve({ outcome: "failure" });
    if (task.id === "right") right.resolve({ outcome: "failure" });
  } } });
  const running = value.runner.run();
  await Promise.race([
    waitFor(
      () => value.events.filter((event) => event.type === "execute").length === 2,
      "active tasks before cancel",
      10_000
    ),
    running.then(
      (result) => { throw new Error(`plan runner completed before both cancel targets became active: ${JSON.stringify(result)}`); },
      (error) => { throw error; }
    )
  ]);
  await value.runner.cancel();
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.dispatchBlocked, true);
  assert.equal(result.tasks.left.status, "cancelled");
  assert.equal(result.tasks.right.status, "cancelled");
  assert.equal(result.tasks.after.status, "cancelled");
  assert.equal(value.events.filter((event) => event.type === "stop").length, 2);
  assert.equal(value.events.some((event) => event.type === "execute" && event.taskId === "after"), false);
});

test("prepared task admission must remain current before dispatch", async (t) => {
  const value = await fixture(t, [{ id: "drift", paths: ["src/drift"] }], {
    adapterOptions: { driftTask: "drift" }
  });
  const result = await value.runner.run();
  assert.equal(result.status, "hold");
  assert.equal(result.failure.code, "EPLAN_RUNNER_ADMISSION");
  assert.equal(value.events.some((event) => event.type === "execute"), false);
  assert.equal(result.tasks.drift.status, "hold");
});

test("fresh plan drift is a HOLD before any task dispatch", async (t) => {
  const changedPlan = makePlan([{ id: "task", goal: "changed", paths: ["src/task"] }]);
  const value = await fixture(t, [{ id: "task", paths: ["src/task"] }], {
    readFreshPlan: async () => changedPlan
  });
  const result = await value.runner.run();
  assert.equal(result.status, "hold");
  assert.equal(result.failure.code, "EPLAN_SOURCE_DRIFT");
  assert.equal(value.events.some((event) => event.type === "execute"), false);
});

test("typed usage is charged to task and plan budgets and overrun is HOLD", async (t) => {
  for (const outcome of ["success", "failure"]) {
    for (const dimension of ["seconds", "tokens"]) {
      await t.test(`${outcome} with ${dimension} overrun preserves the effect without retry`, async (subtest) => {
        const usage = { seconds: 1, tokens: 1, [dimension]: 3 };
        const value = await fixture(subtest, [
          { id: "expensive", attempts: 2, seconds: 2, tokens: 2, paths: ["src/expensive"] },
          { id: "dependent", dependencies: ["expensive"], paths: ["src/dependent"] }
        ], { adapterOptions: { behavior: {
          expensive: () => ({ outcome, usage })
        } } });
        const result = await value.runner.run();
        assert.equal(result.status, "hold");
        assert.equal(result.failure.code, "EPLAN_BUDGET_EXCEEDED");
        assert.equal(result.dispatchBlocked, true);
        assert.equal(result.tasks.expensive.status, "hold");
        assert.equal(result.tasks.expensive.outcome, outcome);
        assert.deepEqual(result.tasks.expensive.usage, usage);
        assert.equal(result.tasks.expensive.attempts, 1);
        assert.equal(result.tasks.expensive.dispatches, 1);
        assert.equal(result.tasks.dependent.status, "blocked");
        assert.equal(result.tasks.dependent.dispatches, 0);
        assert.equal(result.budget.attemptsUsed, 1);
        assert.deepEqual({ seconds: result.budget.secondsUsed, tokens: result.budget.tokensUsed }, usage);
        const observed = result.checkpoint.events.filter((event) => event.type === "task.budget-exceeded");
        assert.equal(observed.length, 1);
        assert.equal(observed[0].detail.outcome, outcome);
        assert.deepEqual(observed[0].detail.usage, usage);

        const before = await value.runner.inspect();
        await value.runner.run();
        const reopened = await createNativeV3PlanRunner({
          stateRoot: value.root, plan: value.plan, planId: value.plan.planId,
          runId: before.runId, parallelism: before.parallelism, taskAdapter: value.adapter.taskAdapter
        });
        const replay = await reopened.run();
        assert.equal(replay.tasks.expensive.outcome, outcome);
        assert.equal((await reopened.inspect()).stateDigest, before.stateDigest);
        assert.equal(value.events.filter((event) => event.type === "execute").length, 1);
      });
    }
  }
});

test("native task usage preserves known dimensions and marks incomplete observations unknown", () => {
  assert.deepEqual(
    validateNativeV3PlanTaskResult({ outcome: "success", usage: { seconds: 2, tokens: 7 } }),
    { outcome: "success", usage: { seconds: 2, tokens: 7 } }
  );
  for (const usage of [undefined, null, {}, { seconds: 2 }, { tokens: 7 }, { seconds: null, tokens: 7 }]) {
    const result = validateNativeV3PlanTaskResult({ outcome: "success", usage });
    assert.equal(result.outcome, "success");
    assert.equal(result.usage.seconds === null || Number.isSafeInteger(result.usage.seconds), true);
    assert.equal(result.usage.tokens === null || Number.isSafeInteger(result.usage.tokens), true);
    assert.deepEqual(result.usage, {
      seconds: usage && usage.seconds !== undefined && usage.seconds !== null ? usage.seconds : null,
      tokens: usage && usage.tokens !== undefined && usage.tokens !== null ? usage.tokens : null
    });
  }
  assert.throws(
    () => validateNativeV3PlanTaskResult({ outcome: "success", usage: { seconds: 1, tokens: 2, extra: 3 } }),
    /unknown fields/i
  );
  assert.throws(
    () => validateNativeV3PlanTaskResult({ outcome: "success", usage: { seconds: "2", tokens: 2 } }),
    /bounded integer/i
  );
});

for (const [outcome, exitCode] of [["success", 0], ["failure", 1]]) {
  test(`native budget overrun with injected elapsed time preserves sealed ${outcome} across restart without another effect`, {
    skip: process.platform !== "darwin" && process.platform !== "linux"
  }, async (t) => {
    const value = await trustedProducerFixture(t, {
      exitCode,
      taskSpecs: [
        { id: "expensive", attempts: 2, seconds: 3, tokens: null, paths: ["src/expensive"] },
        { id: "dependent", dependencies: ["expensive"], tokens: null, paths: ["src/dependent"] }
      ]
    });
    const taskAdapter = createNativeV3PlanTaskAdapterFromCommandRunner({ runner: value.commandRunner });
    const options = {
      stateRoot: value.root, plan: value.plan, planId: value.planId,
      runId: PRODUCER_RUN_ID, parallelism: 2, taskAdapter
    };
    const runner = await createProductionNativeV3PlanRunner(options);
    // Inject a late monotonic observation, not a caller-authored usage
    // receipt. The real command still runs and seals through the production
    // registry and budget ledger; its wall-clock cancellation timer remains
    // enabled. Sleeping beyond that timer would correctly produce UNKNOWN
    // and would not exercise settlement of an already-observed outcome.
    let observedNs = process.hrtime.bigint();
    const elapsedClock = mock.method(process.hrtime, "bigint", () => {
      observedNs += 4_000_000_000n;
      return observedNs;
    });
    let result;
    try {
      result = await runner.run();
    } finally {
      elapsedClock.mock.restore();
    }
    assert.equal(result.status, "hold", JSON.stringify(result));
    assert.equal(result.failure.code, "EPLAN_BUDGET_EXCEEDED");
    assert.equal(result.dispatchBlocked, true);
    assert.equal(result.tasks.expensive.status, "hold");
    assert.equal(result.tasks.expensive.outcome, outcome);
    assert.equal(result.tasks.expensive.attempts, 1);
    assert.equal(result.tasks.expensive.dispatches, 1);
    assert.ok(result.tasks.expensive.usage.seconds > 3);
    assert.equal(result.tasks.expensive.usage.tokens, null);
    assert.equal(result.budget.secondsUsed, result.tasks.expensive.usage.seconds);
    assert.equal(result.budget.tokensUsed, null);
    assert.equal(result.budget.attemptsUsed, 1);
    assert.equal(result.tasks.dependent.status, "blocked");
    assert.equal(result.tasks.dependent.dispatches, 0);
    const observed = result.checkpoint.events.filter((event) => event.type === "task.budget-exceeded");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].detail.outcome, outcome);
    assert.deepEqual(observed[0].detail.usage, result.tasks.expensive.usage);
    assert.equal(await effectCount(value.counterPath), 1);

    const before = await runner.inspect();
    const reopened = await createProductionNativeV3PlanRunner(options);
    const replay = await reopened.run();
    assert.equal(replay.tasks.expensive.outcome, outcome);
    await assert.rejects(reopened.resume(), (error) => error?.code === "EPLAN_RUNNER_STATE");
    assert.equal((await reopened.inspect()).stateDigest, before.stateDigest);
    assert.equal(await effectCount(value.counterPath), 1);
  });
}

test("usage accounting keeps an unknown dimension sticky across concurrent settlement order", () => {
  const unknown = validateNativeV3PlanTaskResult({ outcome: "success", usage: { seconds: null, tokens: 4 } }).usage;
  const known = validateNativeV3PlanTaskResult({ outcome: "success", usage: { seconds: 3, tokens: 5 } }).usage;
  const afterUnknown = accumulateNativeV3PlanUsage({ seconds: 0, tokens: 0 }, unknown);
  const afterKnown = accumulateNativeV3PlanUsage(afterUnknown, known);
  assert.deepEqual(afterUnknown, { seconds: null, tokens: 4 });
  assert.deepEqual(afterKnown, { seconds: null, tokens: 9 });
  assert.deepEqual(
    accumulateNativeV3PlanUsage({ seconds: 0, tokens: 0 }, known),
    { seconds: 3, tokens: 5 }
  );
});

test("zero usage is retained only when cancellation has a not-started proof", async (t) => {
  const value = await fixture(t, [{ id: "never-started", paths: ["src/never-started"] }]);
  const result = await value.runner.cancel();
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.tasks["never-started"].usage, { seconds: 0, tokens: 0 });
  assert.deepEqual({ seconds: result.budget.secondsUsed, tokens: result.budget.tokensUsed }, { seconds: 0, tokens: 0 });
  assert.equal(value.events.some((event) => event.type === "execute"), false);
});

test("a stopped task after effect entry keeps unobserved usage UNKNOWN", async (t) => {
  const value = await trustedProducerFixture(t, {
    sleepSeconds: 5,
    taskSpecs: [{ id: "entered", paths: ["src/entered"] }]
  });
  const adapter = createNativeV3PlanTaskAdapterFromCommandRunner({ runner: value.commandRunner });
  const runner = await createProductionNativeV3PlanRunner({
    stateRoot: value.root,
    plan: value.plan,
    planId: value.planId,
    runId: PRODUCER_RUN_ID,
    parallelism: 1,
    taskAdapter: adapter,
    stopWaitMs: 2_000
  });
  const running = runner.run();
  await waitFor(() => effectCount(value.counterPath).then((count) => count === 1), "entered effect");
  const requested = await runner.cancel();
  const result = await running;
  assert.equal(requested.status, "cancelling");
  assert.ok(["cancelled", "unknown"].includes(result.status));
  assert.ok(["cancelled", "unknown"].includes(result.tasks.entered.status));
  assert.deepEqual(result.tasks.entered.usage, { seconds: null, tokens: null });
  assert.deepEqual({ seconds: result.budget.secondsUsed, tokens: result.budget.tokensUsed }, { seconds: null, tokens: null });
  assert.ok(result.tasks.entered.stopReceipt === null || result.tasks.entered.stopReceipt.outcome === "STOPPED");
});

test("pause fences unobserved usage and malformed results stay rejected", async (t) => {
  const pauseValue = await trustedProducerFixture(t, {
    sleepSeconds: 5,
    taskSpecs: [{ id: "paused-entered", paths: ["src/paused-entered"] }]
  });
  const pauseAdapter = createNativeV3PlanTaskAdapterFromCommandRunner({ runner: pauseValue.commandRunner });
  const pauseRunner = await createProductionNativeV3PlanRunner({
    stateRoot: pauseValue.root,
    plan: pauseValue.plan,
    planId: pauseValue.planId,
    runId: PRODUCER_RUN_ID,
    parallelism: 1,
    taskAdapter: pauseAdapter,
    stopWaitMs: 2_000
  });
  const running = pauseRunner.run();
  await waitFor(() => effectCount(pauseValue.counterPath).then((count) => count === 1), "paused effect");
  const paused = await pauseRunner.pause();
  assert.equal(paused.status, "unknown");
  assert.deepEqual(paused.tasks["paused-entered"].usage, { seconds: null, tokens: null });
  assert.deepEqual({ seconds: paused.budget.secondsUsed, tokens: paused.budget.tokensUsed }, { seconds: null, tokens: null });
  assert.equal((await running).status, "unknown");
  assert.throws(
    () => validateNativeV3PlanTaskResult({ outcome: "success", usage: { seconds: "not-an-integer", tokens: 1 } }),
    /bounded integer/i
  );
});

test("a native result without bounded usage holds the graph, preserves effect outcome, and cannot retry", {
  skip: process.platform !== "darwin" && process.platform !== "linux"
}, async (t) => {
  const value = await trustedProducerFixture(t, {
    taskSpecs: [
      { id: "measured-later", paths: ["src/measured-later"] },
      { id: "dependent", dependencies: ["measured-later"], paths: ["src/dependent"] }
    ]
  });
  const adapter = createNativeV3PlanTaskAdapterFromCommandRunner({ runner: value.commandRunner });
  const runner = await createProductionNativeV3PlanRunner({
    stateRoot: value.root,
    plan: value.plan,
    planId: value.planId,
    runId: PRODUCER_RUN_ID,
    parallelism: 2,
    taskAdapter: adapter
  });

  const result = await runner.run();
  assert.equal(result.usageSchemaVersion, 2);
  assert.equal(result.status, "hold");
  assert.equal(result.dispatchBlocked, true);
  assert.equal(result.failure.code, "EPLAN_USAGE_UNKNOWN");
  assert.equal(result.tasks["measured-later"].status, "hold");
  assert.equal(result.tasks["measured-later"].outcome, "success");
  assert.ok(Number.isSafeInteger(result.tasks["measured-later"].usage.seconds));
  assert.ok(result.tasks["measured-later"].usage.seconds > 0);
  assert.equal(result.tasks["measured-later"].usage.tokens, null);
  assert.equal(result.tasks.dependent.status, "blocked");
  assert.equal(result.tasks.dependent.dispatches, 0);
  assert.equal(result.budget.secondsUsed, result.tasks["measured-later"].usage.seconds);
  assert.equal(result.budget.tokensUsed, null);
  assert.equal(await effectCount(value.counterPath), 1);
  assert.equal(result.checkpoint.events.some((event) => event.type === "task.hold" && event.detail?.phase === "usage"), true);

  const beforeResume = await runner.inspect();
  await assert.rejects(runner.resume(), (error) => error?.code === "EPLAN_RUNNER_STATE");
  const afterResume = await runner.inspect();
  assert.equal(afterResume.stateDigest, beforeResume.stateDigest);
  assert.equal(await effectCount(value.counterPath), 1);
});

test("unknown usage cleans every active sibling before returning a terminal checkpoint", async (t) => {
  const value = await trustedProducerRunnerSetFixture(t, {
    taskSpecs: [
    { id: "a-unknown", paths: ["src/a-unknown"] },
    { id: "z-active", paths: ["src/z-active"] }
    ],
    scriptBodies: {
      "a-unknown": ({ counterPath }) => [
        "#!/bin/sh",
        `printf 'a-unknown\\n' >> ${shellQuote(counterPath)}`,
        "exit 0",
        ""
      ].join("\n"),
      "z-active": ({ root, counterPath }) => [
        "#!/bin/sh",
        `printf 'ready\\n' > ${shellQuote(path.join(root, "sibling-ready"))}`,
        `printf 'active-sibling\\n' >> ${shellQuote(counterPath)}`,
        "sleep 5",
        "exit 0",
        ""
      ].join("\n")
    }
  });
  const runner = await createProductionNativeV3PlanRunner({
    stateRoot: value.root,
    plan: value.plan,
    planId: value.planId,
    runId: PRODUCER_RUN_ID,
    parallelism: 2,
    taskAdapter: value.taskAdapter,
    stopWaitMs: 250
  });

  const result = await runner.run();
  assert.ok(["hold", "unknown"].includes(result.status));
  const usageTask = Object.values(result.tasks).find((task) => task.lastError?.code === "EPLAN_USAGE_UNKNOWN");
  assert.ok(usageTask, "one real task must be held for unknown bounded usage");
  assert.equal(usageTask.status, "hold");
  assert.equal(usageTask.outcome, "success");
  const sibling = Object.values(result.tasks).find((task) => task !== usageTask);
  assert.ok(sibling);
  assert.ok(["cancelled", "unknown"].includes(sibling.status));
  assert.notEqual(sibling.status, "dispatching");
  if (sibling.status === "unknown") {
    assert.equal(result.failure.code, "EPLAN_CLEANUP_UNKNOWN");
    assert.match(
      sibling.lastError?.code ?? "",
      /^(?:EPLAN_(?:RUNNER_STOP|CLEANUP_UNKNOWN|RUNNER_LATE_CALLBACK)|ENATIVE_V3_PLAN_CLEANUP_TIMEOUT)$/
    );
  } else {
    assert.equal(result.failure.code, "EPLAN_USAGE_UNKNOWN");
    assert.equal(sibling.stopReceipt?.outcome, "STOPPED");
  }
  assert.deepEqual(sibling.usage, { seconds: null, tokens: null });
  assert.deepEqual({ seconds: result.budget.secondsUsed, tokens: result.budget.tokensUsed }, { seconds: null, tokens: null });
  assert.ok((await effectCount(value.counterPath)) >= 1);
  assert.equal(result.checkpoint.events.some((event) =>
    event.type === "task.stop-observed" && event.taskId === sibling.taskId
  ), true);
  assert.equal(Object.values(result.tasks).some((task) => ["preparing", "dispatching"].includes(task.status)), false);
});

test("a late stopped-task callback cannot rewrite the sealed checkpoint", async (t) => {
  const late = deferred();
  const value = await fixture(t, [{ id: "late-callback", paths: ["src/late-callback"] }], {
    stopWaitMs: 25,
    adapterOptions: {
      behavior: { "late-callback": () => late.promise },
      resolveOnStop: false
    }
  });
  const running = value.runner.run();
  await waitFor(() => value.events.some((event) => event.type === "execute" && event.taskId === "late-callback"), "late callback effect");
  await value.runner.cancel();
  const result = await running;
  assert.ok(["cancelled", "unknown"].includes(result.status));
  assert.notEqual(result.tasks["late-callback"].status, "succeeded");
  const sealedDigest = result.checkpoint.stateDigest;
  late.resolve({ outcome: "success", usage: { seconds: 1, tokens: 1 } });
  await waitFor(async () => {
    try {
      const registry = JSON.parse(await readFile(path.join(
        value.root,
        "native-v3-plan-runner-v1",
        "execution-runtime",
        "late-callback",
        "runs",
        "sbw-20350101T000000Z-0123456789ab",
        "registry.json"
      ), "utf8"));
      return Object.values(registry.intents ?? {}).every((intent) => ["sealed", "unknown", "cancelled"].includes(intent.status));
    } catch {
      return false;
    }
  }, "late callback registry settlement");
  const afterLate = await value.runner.inspect();
  assert.equal(afterLate.stateDigest, sealedDigest);
  assert.notEqual(afterLate.tasks["late-callback"].status, "succeeded");
});

test("unknown usage on unbounded dimensions does not manufacture a zero or block the native task", {
  skip: process.platform !== "darwin" && process.platform !== "linux"
}, async (t) => {
  const value = await trustedProducerFixture(t, {
    taskSpecs: [{ id: "unbounded", seconds: null, tokens: null, paths: ["src/unbounded"] }]
  });
  const adapter = createNativeV3PlanTaskAdapterFromCommandRunner({ runner: value.commandRunner });
  const runner = await createProductionNativeV3PlanRunner({
    stateRoot: value.root,
    plan: value.plan,
    planId: value.planId,
    runId: PRODUCER_RUN_ID,
    parallelism: 1,
    taskAdapter: adapter
  });

  const result = await runner.run();
  assert.equal(result.status, "succeeded");
  assert.equal(result.failure, null);
  assert.ok(Number.isSafeInteger(result.tasks.unbounded.usage.seconds));
  assert.ok(result.tasks.unbounded.usage.seconds > 0);
  assert.equal(result.tasks.unbounded.usage.tokens, null);
  assert.equal(result.budget.secondsUsed, result.tasks.unbounded.usage.seconds);
  assert.equal(result.budget.tokensUsed, null);
  assert.equal(await effectCount(value.counterPath), 1);
});

test("legacy usage checkpoints remain inspectable and stoppable but cannot start or resume", {
  skip: process.platform !== "darwin" && process.platform !== "linux"
}, async (t) => {
  const value = await trustedProducerFixture(t);
  const adapter = createNativeV3PlanTaskAdapterFromCommandRunner({ runner: value.commandRunner });
  const runner = await createProductionNativeV3PlanRunner({
    stateRoot: value.root,
    plan: value.plan,
    planId: value.planId,
    runId: PRODUCER_RUN_ID,
    parallelism: 1,
    taskAdapter: adapter
  });
  const checkpointPath = path.join(value.root, "native-v3-plan-runner-v1", "runs", PRODUCER_RUN_ID, "checkpoint.json");
  const current = JSON.parse(await readFile(checkpointPath, "utf8"));
  delete current.usageSchemaVersion;
  current.stateDigest = digestObject({ ...current, stateDigest: undefined });
  await writeFile(checkpointPath, `${JSON.stringify(current)}\n`, { mode: 0o600 });
  const legacyBytes = await readFile(checkpointPath);

  const historical = await readCoreNativeV3PlanRunnerCheckpoint({ stateRoot: value.root, runId: PRODUCER_RUN_ID });
  assert.equal(historical.usageSchemaVersion, undefined);
  assert.deepEqual(await readFile(checkpointPath), legacyBytes);

  const legacyRunner = await createProductionNativeV3PlanRunner({
    stateRoot: value.root,
    plan: value.plan,
    planId: value.planId,
    runId: PRODUCER_RUN_ID,
    parallelism: 1,
    taskAdapter: adapter
  });
  assert.equal((await legacyRunner.inspect()).usageSchemaVersion, undefined);
  await assert.rejects(legacyRunner.run(), (error) => error?.code === "EPLAN_USAGE_SCHEMA_LEGACY");
  assert.deepEqual(await readFile(checkpointPath), legacyBytes);

  // An explicit local stop remains available for an old run and preserves its
  // old usage bytes; it is not a migration or a usage measurement.
  const legacyStopRunner = await createProductionNativeV3PlanRunner({
    stateRoot: value.root,
    plan: value.plan,
    planId: value.planId,
    runId: PRODUCER_RUN_ID,
    parallelism: 1,
    taskAdapter: adapter
  });
  const stopped = await legacyStopRunner.cancel();
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.usageSchemaVersion, undefined);
  assert.deepEqual(stopped.budget.secondsUsed, 0);
  assert.deepEqual(stopped.tasks.native.usage, { seconds: 0, tokens: 0 });
  assert.equal(await effectCount(value.counterPath), 0);
});

test("cross-task write conflict is rejected by the existing WorkflowPlanV1 validator", () => {
  assert.throws(() => makePlan([
    { id: "one", paths: ["src/shared"] },
    { id: "two", paths: ["src/shared/file"] }
  ]), /write owner conflict/i);
});

test("checkpoint is inspectable, digest-bound, and concurrent run calls do not duplicate dispatch", async (t) => {
  const value = await fixture(t, [{ id: "only", paths: ["src/only"] }]);
  const before = await readNativeV3PlanRunnerCheckpoint({ root: value.root, runId: "sbw-20350101T000000Z-0123456789ab" });
  assert.equal(before.status, "ready");
  assert.equal(before.tasks.only.status, "pending");
  const first = value.runner.run();
  const second = value.runner.run();
  assert.equal(await first, await second);
  assert.equal(value.events.filter((event) => event.type === "execute" && event.taskId === "only").length, 1);
  const after = await value.runner.inspect();
  assert.equal(after.status, "succeeded");
  assert.equal(after.stateDigest, digestObject({ ...after, stateDigest: undefined }));
  assert.equal((await readNativeV3PlanRunnerCheckpoint({ stateRoot: value.root, runId: "sbw-20350101T000000Z-0123456789ab" })).status, "succeeded");
});

test("standalone V1 checkpoint inspection rejects mixed versions and extra fields even with a matching digest", async (t) => {
  const runId = "sbw-20350101T000000Z-0123456789ab";
  const value = await fixture(t, [{ id: "only", paths: ["src/only"] }]);
  const checkpointPath = path.join(value.root, "native-v3-plan-runner-v1", "runs", runId, "checkpoint.json");
  const originalBytes = await readFile(checkpointPath);
  const original = JSON.parse(originalBytes);
  try {
    for (const mutation of [
      (checkpoint) => { checkpoint.schemaVersion = 2; },
      (checkpoint) => { checkpoint.kind = "NativeV3PlanRunnerCheckpointV2"; },
      (checkpoint) => { checkpoint.acceptance = { accepted: true }; },
      (checkpoint) => { checkpoint.usageSchemaVersion = 3; }
    ]) {
      const changed = structuredClone(original);
      mutation(changed);
      changed.stateDigest = digestObject({ ...changed, stateDigest: undefined });
      await writeFile(checkpointPath, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
      await assert.rejects(
        readCoreNativeV3PlanRunnerCheckpoint({ stateRoot: value.root, runId }),
        (error) => ["EPLAN_RUNNER_STATE_INVALID", "EPLAN_USAGE_SCHEMA_UNSUPPORTED"].includes(error?.code)
      );
    }
  } finally {
    await writeFile(checkpointPath, originalBytes, { mode: 0o600 });
  }
  assert.equal((await readCoreNativeV3PlanRunnerCheckpoint({ stateRoot: value.root, runId })).status, "ready");
});

test("V2 checkpoint codec is explicit and the V1 executor cannot mutate it", async (t) => {
  const runId = "sbw-20350101T000000Z-0123456789ab";
  const value = await fixture(t, [{ id: "only", paths: ["src/only"] }]);
  const checkpointPath = path.join(value.root, "native-v3-plan-runner-v1", "runs", runId, "checkpoint.json");
  const original = JSON.parse(await readFile(checkpointPath, "utf8"));
  const v2 = structuredClone(original);
  v2.schemaVersion = 2;
  v2.kind = "NativeV3PlanRunnerCheckpointV2";
  v2.usageSchemaVersion = 2;
  v2.tasks.only.effectAcceptance = null;
  v2.stateDigest = digestObject({ ...v2, stateDigest: undefined });

  assert.deepEqual(validateNativeV3PlanRunnerCheckpointV2(v2, value.plan), v2);
  assert.throws(
    () => validateNativeV3PlanRunnerCheckpointV1(v2, value.plan),
    (error) => error?.code === "EPLAN_RUNNER_STATE_INVALID"
  );
  for (const mutate of [
    (checkpoint) => { checkpoint.schemaVersion = 1; },
    (checkpoint) => { checkpoint.kind = "NativeV3PlanRunnerCheckpointV1"; },
    (checkpoint) => { delete checkpoint.tasks.only.effectAcceptance; },
    (checkpoint) => { checkpoint.tasks.only.status = "awaiting-acceptance"; },
    (checkpoint) => { checkpoint.tasks.only.effectAcceptance = { status: "accepted" }; }
  ]) {
    const changed = structuredClone(v2);
    mutate(changed);
    changed.stateDigest = digestObject({ ...changed, stateDigest: undefined });
    assert.throws(
      () => validateNativeV3PlanRunnerCheckpointV2(changed, value.plan),
      (error) => error?.code === "EPLAN_RUNNER_STATE_INVALID"
    );
  }
  const awaiting = structuredClone(v2);
  const task = awaiting.tasks.only;
  task.status = "awaiting-acceptance";
  task.attempts = 1;
  task.dispatches = 1;
  task.attemptId = "only.attempt.1";
  task.unitId = "unit-only";
  task.executionId = "execution-only";
  task.admissionDigest = "a".repeat(64);
  task.startedAt = "2030-01-01T00:00:00.000Z";
  task.outcome = "success";
  task.effectAcceptance = {
    schemaVersion: 1,
    kind: "NativeV3PlanEffectAcceptanceV1",
    status: "awaiting",
    runId,
    taskId: "only",
    attemptId: task.attemptId,
    unitId: task.unitId,
    executionId: task.executionId,
    handleId: "handle-only",
    intentId: "intent-only",
    outcome: "success",
    effectDigest: "b".repeat(64),
    effectByteLength: 42,
    journalSequence: 1,
    journalStateDigest: "c".repeat(64),
    acceptedAt: null
  };
  awaiting.budget.attemptsUsed = 1;
  awaiting.stateDigest = digestObject({ ...awaiting, stateDigest: undefined });
  assert.deepEqual(validateNativeV3PlanRunnerCheckpointV2(awaiting, value.plan), awaiting);
  const mismatched = structuredClone(awaiting);
  mismatched.tasks.only.effectAcceptance.intentId = "";
  mismatched.stateDigest = digestObject({ ...mismatched, stateDigest: undefined });
  assert.throws(
    () => validateNativeV3PlanRunnerCheckpointV2(mismatched, value.plan),
    (error) => error?.code === "EPLAN_RUNNER_INPUT"
  );
  // The pure codec intentionally validates shape only. Even a syntactically
  // accepted snapshot has no authority until a future runtime consumer checks
  // the actual sealed journal artifact and performs the acceptance CAS.
  const shapeOnlyAccepted = structuredClone(awaiting);
  shapeOnlyAccepted.tasks.only.status = "succeeded";
  shapeOnlyAccepted.tasks.only.finishedAt = "2030-01-01T00:00:01.000Z";
  shapeOnlyAccepted.tasks.only.effectAcceptance.status = "accepted";
  shapeOnlyAccepted.tasks.only.effectAcceptance.acceptedAt = "2030-01-01T00:00:01.000Z";
  shapeOnlyAccepted.stateDigest = digestObject({ ...shapeOnlyAccepted, stateDigest: undefined });
  assert.deepEqual(validateNativeV3PlanRunnerCheckpointV2(shapeOnlyAccepted, value.plan), shapeOnlyAccepted);

  await writeFile(checkpointPath, `${JSON.stringify(shapeOnlyAccepted)}\n`, { mode: 0o600 });
  await assert.rejects(
    readCoreNativeV3PlanRunnerCheckpoint({ stateRoot: value.root, runId }),
    (error) => error?.code === "EPLAN_CHECKPOINT_V2_NOT_ACTIVE" && error?.status === "HOLD"
  );
  await assert.rejects(
    value.runner.run(),
    (error) => error?.code === "EPLAN_RUNNER_STATE_INVALID" && error?.status === "HOLD"
  );
  assert.deepEqual(JSON.parse(await readFile(checkpointPath, "utf8")), shapeOnlyAccepted);
});

test("production V1 plan runner holds an observed V2 checkpoint before effect dispatch", {
  skip: process.platform !== "darwin" && process.platform !== "linux"
}, async (t) => {
  const value = await trustedProducerFixture(t);
  const adapter = createNativeV3PlanTaskAdapterFromCommandRunner({ runner: value.commandRunner });
  const runner = await createProductionNativeV3PlanRunner({
    stateRoot: value.root,
    plan: value.plan,
    planId: value.planId,
    runId: PRODUCER_RUN_ID,
    parallelism: 1,
    taskAdapter: adapter
  });
  const checkpointPath = path.join(value.root, "native-v3-plan-runner-v1", "runs", PRODUCER_RUN_ID, "checkpoint.json");
  const v2 = JSON.parse(await readFile(checkpointPath, "utf8"));
  v2.schemaVersion = 2;
  v2.kind = "NativeV3PlanRunnerCheckpointV2";
  v2.tasks.native.effectAcceptance = null;
  v2.stateDigest = digestObject({ ...v2, stateDigest: undefined });
  await writeFile(checkpointPath, `${JSON.stringify(v2)}\n`, { mode: 0o600 });

  assert.deepEqual(validateNativeV3PlanRunnerCheckpointV2(v2, value.plan), v2);
  await assert.rejects(
    runner.run(),
    (error) => error?.code === "EPLAN_CHECKPOINT_V2_NOT_ACTIVE" && error?.status === "HOLD"
  );
  assert.equal(await effectCount(value.counterPath), 0);
  assert.deepEqual(JSON.parse(await readFile(checkpointPath, "utf8")), v2);
});

test("checkpoint inspection retries only a transient regular publication observation", async (t) => {
  const runId = "sbw-20350101T000000Z-0123456789ab";
  const value = await fixture(t, [{ id: "linked", paths: ["src/linked"] }]);
  const checkpointPath = path.join(value.root, "native-v3-plan-runner-v1", "runs", runId, "checkpoint.json");
  const originalLstat = fsPromises.lstat;

  async function withCheckpointStat(overrides, callback) {
    let directReads = 0;
    const lstatMock = mock.method(fsPromises, "lstat", async (...args) => {
      const info = await originalLstat(...args);
      const stack = new Error().stack ?? "";
      const directCheckpointRead = args[0] === checkpointPath &&
        stack.includes("at async readJson") &&
        !stack.includes("at async assertNoSymlinkUnder");
      if (!directCheckpointRead) return info;
      directReads += 1;
      const active = typeof overrides === "function" ? overrides(directReads) : overrides;
      if (!active) return info;
      return new Proxy(info, {
        get(target, property) {
          if (property === "nlink" && active.nlink !== undefined) return active.nlink;
          if (property === "isFile" && active.isFile !== undefined) return () => active.isFile;
          if (property === "isSymbolicLink" && active.isSymbolicLink !== undefined) return () => active.isSymbolicLink;
          const result = Reflect.get(target, property, target);
          return typeof result === "function" ? result.bind(target) : result;
        }
      });
    });
    syncBuiltinESMExports();
    try {
      await callback(() => directReads);
    } finally {
      lstatMock.mock.restore();
      syncBuiltinESMExports();
    }
  }

  await withCheckpointStat((read) => read === 1
    ? { nlink: 2, isFile: true, isSymbolicLink: false }
    : null, async (readCount) => {
    assert.equal((await readCoreNativeV3PlanRunnerCheckpoint({ stateRoot: value.root, runId })).status, "ready");
    assert.equal(readCount(), 2, "the transient two-link observation must exercise one retry");
  });

  await withCheckpointStat((read) => read === 1
    ? { nlink: 0, isFile: true, isSymbolicLink: false }
    : null, async (readCount) => {
    assert.equal((await readCoreNativeV3PlanRunnerCheckpoint({ stateRoot: value.root, runId })).status, "ready");
    assert.equal(readCount(), 2, "an unlinked old inode must require a new strict path read");
  });

  await withCheckpointStat((read) => read <= 12
    ? { nlink: 2, isFile: true, isSymbolicLink: false }
    : null, async (readCount) => {
    assert.equal((await readCoreNativeV3PlanRunnerCheckpoint({ stateRoot: value.root, runId })).status, "ready");
    assert.equal(readCount(), 13, "a bounded slow publication must settle before the reader returns");
  });

  await withCheckpointStat({ nlink: 2, isFile: true, isSymbolicLink: false }, async (readCount) => {
    await assert.rejects(
      readCoreNativeV3PlanRunnerCheckpoint({ stateRoot: value.root, runId }),
      (error) => error?.code === "EUNSAFE_JSON_PATH"
    );
    assert.equal(readCount(), 26, "a stable hard link must remain rejected after the bounded retries");
  });

  await withCheckpointStat({ nlink: 0, isFile: true, isSymbolicLink: false }, async (readCount) => {
    await assert.rejects(
      readCoreNativeV3PlanRunnerCheckpoint({ stateRoot: value.root, runId }),
      (error) => error?.code === "EUNSAFE_JSON_PATH"
    );
    assert.equal(readCount(), 26, "a persistently unlinked inode must remain rejected after bounded retries");
  });

  for (const observation of [
    { nlink: 3, isFile: true, isSymbolicLink: false },
    { nlink: 1, isFile: false, isSymbolicLink: false },
    { nlink: 0, isFile: true, isSymbolicLink: true }
  ]) {
    await withCheckpointStat(observation, async (readCount) => {
      await assert.rejects(
        readCoreNativeV3PlanRunnerCheckpoint({ stateRoot: value.root, runId }),
        (error) => error?.code === "EUNSAFE_JSON_PATH"
      );
      assert.equal(readCount(), 1, "non-transient observations must fail without retry");
    });
  }
});

test("unknown adapter fields and caller approval booleans are rejected", async (t) => {
  const value = await fixture(t, [{ id: "shape", paths: ["src/shape"] }], {
    adapterOptions: { addApprovalField: true }
  });
  const result = await value.runner.run();
  assert.equal(result.status, "hold");
  assert.equal(result.failure.code, "EPLAN_RUNNER_ADAPTER");
  assert.equal(value.events.some((event) => event.type === "execute"), false);
});

test("a second controller persists cancellation without closing the active owner's dispatch", async (t) => {
  const execution = deferred();
  const value = await fixture(t, [{ id: "owned", paths: ["src/owned"] }], {
    adapterOptions: {
      behavior: { owned: () => execution.promise },
      onStop: () => execution.resolve({ outcome: "failure" })
    }
  });
  const firstRun = value.runner.run();
  await waitFor(() => value.events.some((event) => event.type === "execute" && event.taskId === "owned"), "active owner task");
  const second = await createNativeV3PlanRunner({
    stateRoot: value.root,
    plan: value.plan,
    planId: value.plan.planId,
    runId: value.runner.runId,
    parallelism: 2,
    taskAdapter: value.adapter.taskAdapter
  });

  const foreignCancellation = await second.cancel();
  assert.equal(foreignCancellation.status, "cancelling");
  assert.equal(foreignCancellation.reconcileRequired, true);
  assert.equal(foreignCancellation.failure.code, "EPLAN_OWNER_RECONCILE_REQUIRED");
  assert.equal(foreignCancellation.tasks.owned.status, "dispatching");
  assert.equal(value.events.some((event) => event.type === "stop" && event.taskId === "owned"), false);
  assert.equal((await second.reconcile()).status, "cancelling");

  const ownerResult = await firstRun;
  assert.equal(ownerResult.status, "cancelled");
  assert.equal(ownerResult.tasks.owned.status, "cancelled");
  assert.equal(value.events.filter((event) => event.type === "stop" && event.taskId === "owned").length, 1);
  assert.equal(value.events.filter((event) => event.type === "execute" && event.taskId === "owned").length, 1);
});

test("owner loss reconciliation marks a dispatching task UNKNOWN and exposes recovery HOLD", async (t) => {
  const value = await fixture(t, [{ id: "lost", paths: ["src/lost"] }]);
  const checkpointPath = path.join(
    value.root,
    "native-v3-plan-runner-v1",
    "runs",
    value.runner.runId,
    "checkpoint.json"
  );
  const current = await value.runner.inspect();
  const task = {
    ...current.tasks.lost,
    status: "dispatching",
    attempts: 1,
    dispatches: 1,
    attemptId: "lost.attempt.1",
    unitId: "unit-lost",
    executionId: "execution-lost-1",
    admissionDigest: "a".repeat(64),
    startedAt: "2030-01-01T00:00:00.000Z"
  };
  const stale = {
    ...current,
    status: "cancelling",
    dispatchBlocked: true,
    cancelRequested: true,
    cancelReason: "cancel",
    failure: {
      code: "EPLAN_OWNER_RECONCILE_REQUIRED",
      message: "owner process is unavailable",
      status: "UNKNOWN"
    },
    ownerId: "foreign-owner",
    ownerPid: 99_999_999,
    reconcileRequired: true,
    tasks: { ...current.tasks, lost: task },
    stateDigest: undefined
  };
  stale.stateDigest = digestObject({ ...stale, stateDigest: undefined });
  await writeFile(checkpointPath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });

  const reconciled = await value.runner.reconcile();
  assert.equal(reconciled.status, "unknown");
  assert.equal(reconciled.reconcileRequired, true);
  assert.equal(reconciled.failure.code, "EPLAN_OWNER_LOST_RECONCILE_REQUIRED");
  assert.equal(reconciled.tasks.lost.status, "unknown");
  assert.equal(reconciled.tasks.lost.outcome, "unknown");
  assert.equal(reconciled.dispatchBlocked, true);
});

test("expired V3 admission is HOLD before a handle or effect is dispatched", async (t) => {
  const value = await fixture(t, [{ id: "expired", paths: ["src/expired"] }], {
    adapterOptions: { expiry: "2020-01-01T00:00:00.000Z" }
  });
  const result = await value.runner.run();
  assert.equal(result.status, "hold");
  assert.equal(result.failure.code, "EPLAN_RUNNER_ADMISSION");
  assert.match(result.failure.message, /expired/i);
  assert.equal(result.tasks.expired.status, "hold");
  assert.equal(value.events.some((event) => event.type === "execute"), false);
});

test("equal expiry and CAS-after-expiry fail closed without a successful task", async (t) => {
  const equalNow = new Date(EXPIRY);
  const equalValue = await fixture(t, [{ id: "equal", paths: ["src/equal"] }], {
    clock: { now: () => equalNow },
    adapterOptions: { expiry: EXPIRY }
  });
  const equalResult = await equalValue.runner.run();
  assert.equal(equalResult.status, "hold");
  assert.equal(equalResult.tasks.equal.status, "hold");
  assert.equal(equalValue.events.some((event) => event.type === "execute"), false);

  let nowMs = Date.parse(EXPIRY) - 1;
  const casValue = await fixture(t, [{ id: "cas", paths: ["src/cas"] }], {
    clock: { now: () => new Date(nowMs) },
    adapterOptions: {
      expiry: EXPIRY,
      advanceClockOnEffect: () => { nowMs = Date.parse(EXPIRY); }
    }
  });
  const casResult = await casValue.runner.run();
  assert.notEqual(casResult.status, "succeeded");
  assert.notEqual(casResult.tasks.cas.status, "succeeded");
  assert.equal(casValue.events.filter((event) => event.type === "execute" && event.taskId === "cas").length, 1);
});

test("authority revocation after dispatch reservation blocks the effect callback", async (t) => {
  const value = await fixture(t, [{ id: "revoked", paths: ["src/revoked"] }], {
    adapterOptions: { revokeTask: "revoked" }
  });
  const result = await value.runner.run();
  assert.notEqual(result.status, "succeeded");
  assert.notEqual(result.tasks.revoked.status, "succeeded");
  assert.deepEqual(value.events.filter((event) => event.type === "authority-revoked"), [{
    type: "authority-revoked",
    taskId: "revoked",
    attemptNumber: 1,
    phase: "after-dispatch-reservation",
    intentStatus: "dispatching",
    dispatchReserved: true
  }]);
  assert.equal(value.events.some((event) => event.type === "execute" && event.taskId === "revoked"), false);
});

test("late prepare retries owned cleanup after the bounded pre-runner wait", async (t) => {
  const prepareGate = deferred();
  const value = await fixture(t, [{ id: "late", paths: ["src/late"] }], {
    stopWaitMs: 25,
    adapterOptions: { prepareGate }
  });
  const running = value.runner.run();
  await waitFor(() => value.events.some((event) => event.type === "prepare" && event.taskId === "late"), "late prepare entry");

  const cancellationRequest = await value.runner.cancel();
  assert.equal(cancellationRequest.status, "cancelling");

  const cancelled = await running;
  assert.equal(cancelled.status, "unknown");
  assert.equal(cancelled.tasks.late.status, "unknown");
  assert.equal(cancelled.tasks.late.lastError.code, "EPLAN_RUNNER_STOP_TIMEOUT");
  prepareGate.resolve();
  await waitFor(() => value.events.some((event) => event.type === "stop" && event.taskId === "late"), "late owned cleanup", 3_000);
  await waitFor(async () => {
    try {
      const registry = JSON.parse(await readFile(path.join(
        value.root,
        "native-v3-plan-runner-v1",
        "execution-runtime",
        "late",
        "runs",
        value.runner.runId,
        "registry.json"
      ), "utf8"));
      return Object.keys(registry.stopReceipts ?? {}).length === 1;
    } catch {
      return false;
    }
  }, "late stop receipt", 3_000);
  assert.equal(value.events.some((event) => event.type === "execute" && event.taskId === "late"), false);
});

test("production plan runner rejects caller-shaped adapters and accepts only a real command-runner capability", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async (t) => {
  const plan = makePlan([{ id: "native", paths: ["src/native"] }], "native-v3-plan-producer-negative");
  await assert.rejects(
    createProductionNativeV3PlanRunner({
      stateRoot: path.resolve(os.tmpdir()),
      plan,
      planId: plan.planId,
      runId: "sbw-20350101T000000Z-0123456789ab",
      parallelism: 1,
      taskAdapter: {
        schemaVersion: 1,
        kind: "NativeV3TrustedPlanTaskAdapterV2",
        prepareTask: async () => ({})
      }
    }),
    /taskAdapter|trusted|command runner/i
  );
  assert.throws(
    () => createNativeV3PlanTaskAdapterFromCommandRunner({ runner: {} }),
    /trusted|command runner|owner-decision/i
  );
  assert.throws(
    () => createNativeV3TrustedPlanTaskAdapter({ prepareTask: async () => ({}) }),
    /callback|approved|command runner/i
  );

  const value = await trustedProducerFixture(t);
  const spoofedRunner = {
    ...value.commandRunner,
    execute: value.commandRunner.execute,
    stop: value.commandRunner.stop,
    status: value.commandRunner.status
  };
  assert.throws(
    () => createNativeV3PlanTaskAdapterFromCommandRunner({ runner: spoofedRunner }),
    /trusted|command runner|owner-decision/i
  );
  const adapter = createNativeV3PlanTaskAdapterFromCommandRunner({ runner: value.commandRunner });
  await assert.rejects(adapter.prepareTask(), /plan task context/i);
  const prepared = await adapter.prepareTask({
    runId: PRODUCER_RUN_ID,
    planId: value.planId,
    planDigest: value.plan.planDigest,
    contractDigest: value.plan.contractDigest,
    taskId: value.taskId,
    attemptId: "native.attempt.1"
  });
  assert.deepEqual(Object.keys(prepared).sort(), ["binding", "kind", "schemaVersion", "taskId", "unitId"]);
  assert.equal(prepared.kind, "NativeV3PlanTaskTransferV1");
  assert.equal(prepared.schemaVersion, 1);
  assert.equal(Object.hasOwn(prepared, "controller"), false);
  assert.equal(Object.hasOwn(prepared, "resourceAdapter"), false);
  assert.equal(Object.hasOwn(prepared, "effect"), false);
  assert.equal(prepared.taskId, value.taskId);
  assert.equal(prepared.binding.runId, PRODUCER_RUN_ID);
  assert.equal(prepared.binding.attemptId, "native.attempt.1");
  await assert.rejects(value.commandRunner.execute(), /allocation|claimed|consumed/i);
  assert.equal(await effectCount(value.counterPath), 0);
  await assert.rejects(
    adapter.prepareTask({
      runId: PRODUCER_RUN_ID,
      planId: value.planId,
      planDigest: value.plan.planDigest,
      contractDigest: value.plan.contractDigest,
      taskId: value.taskId,
      attemptId: "native.attempt.1"
    }),
    /allocation|consumed|claimed/i
  );

  // This capability test exercises the real command-runner transfer and
  // effect path.  That runner currently has no trusted usage observation, so
  // use an explicitly unbounded plan rather than treating absent usage as
  // zero; finite budgets are covered by the HOLD regression above.
  const runValue = await trustedProducerFixture(t, {
    taskSpecs: [{ id: "native", seconds: null, tokens: null, paths: ["src/native"] }]
  });
  const runAdapter = createNativeV3PlanTaskAdapterFromCommandRunner({ runner: runValue.commandRunner });
  const runner = await createProductionNativeV3PlanRunner({
    stateRoot: runValue.root,
    plan: runValue.plan,
    planId: runValue.planId,
    runId: PRODUCER_RUN_ID,
    parallelism: 1,
    taskAdapter: runAdapter
  });
  const result = await runner.run();
  assert.equal(result.status, "succeeded");
  assert.equal(result.tasks.native.status, "succeeded");
  assert.equal(await effectCount(runValue.counterPath), 1);
  await assert.rejects(runValue.commandRunner.execute(), /allocation|claimed|consumed/i);
  assert.equal(await effectCount(runValue.counterPath), 1);
});

test("a command-runner claim before transfer prevents plan reuse and a second native effect", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async (t) => {
  const value = await trustedProducerFixture(t);
  const direct = await value.commandRunner.execute();
  assert.equal(direct.outcome, "success");
  assert.equal(await effectCount(value.counterPath), 1);

  const adapter = createNativeV3PlanTaskAdapterFromCommandRunner({ runner: value.commandRunner });
  const runner = await createProductionNativeV3PlanRunner({
    stateRoot: value.root,
    plan: value.plan,
    planId: value.planId,
    runId: PRODUCER_RUN_ID,
    parallelism: 1,
    taskAdapter: adapter
  });
  const result = await runner.run();
  assert.notEqual(result.status, "succeeded");
  assert.equal(result.tasks.native.status, "hold");
  assert.match(result.tasks.native.lastError.code, /ALLOCATION|RUNNER_INPUT|TASK_HOLD/);
  assert.equal(await effectCount(value.counterPath), 1);
});

test("command-runner and plan transfer races linearize to one native effect", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async (t) => {
  const value = await trustedProducerFixture(t);
  const adapter = createNativeV3PlanTaskAdapterFromCommandRunner({ runner: value.commandRunner });
  const runner = await createProductionNativeV3PlanRunner({
    stateRoot: value.root,
    plan: value.plan,
    planId: value.planId,
    runId: PRODUCER_RUN_ID,
    parallelism: 1,
    taskAdapter: adapter
  });
  const planOutcome = runner.run().then(
    (result) => ({ kind: "fulfilled", result }),
    (error) => ({ kind: "rejected", error })
  );
  const directOutcome = value.commandRunner.execute().then(
    (result) => ({ kind: "fulfilled", result }),
    (error) => ({ kind: "rejected", error })
  );
  const [plan, direct] = await Promise.all([planOutcome, directOutcome]);
  const count = await effectCount(value.counterPath);
  assert.equal(count, 1);
  const planSucceeded = plan.kind === "fulfilled" && plan.result.status === "succeeded";
  const directSucceeded = direct.kind === "fulfilled" && direct.result.outcome === "success";
  assert.equal(Number(planSucceeded) + Number(directSucceeded), 1);
  if (plan.kind === "rejected") assert.match(String(plan.error?.code ?? plan.error), /ALLOCATION|RUNNER/);
  if (direct.kind === "rejected") assert.match(String(direct.error?.code ?? direct.error), /ALLOCATION|RUNNER/);
});

test("a transferred command shares the original stop path and cannot relaunch after cancellation", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async (t) => {
  const value = await trustedProducerFixture(t, { sleepSeconds: 10 });
  const adapter = createNativeV3PlanTaskAdapterFromCommandRunner({ runner: value.commandRunner });
  const runner = await createProductionNativeV3PlanRunner({
    stateRoot: value.root,
    plan: value.plan,
    planId: value.planId,
    runId: PRODUCER_RUN_ID,
    parallelism: 1,
    taskAdapter: adapter,
    stopWaitMs: 2_000
  });
  const running = runner.run();
  await waitFor(() => effectCount(value.counterPath).then((count) => count === 1), "transferred native effect start");
  const cancellation = await runner.cancel();
  assert.equal(cancellation.status, "cancelling");
  const result = await running;
  assert.ok(["cancelled", "unknown"].includes(result.status));
  assert.notEqual(result.status, "succeeded");
  assert.equal(await effectCount(value.counterPath), 1);
  await assert.rejects(value.commandRunner.execute(), /allocation|claimed|consumed|stopped/i);
});

test("cleanup deadline remains bounded when task preparation never settles", async () => {
  const corePath = fileURLToPath(new URL("./native-v3-plan-runner-test-support.mjs", import.meta.url));
  const plan = makePlan([{ id: "never", paths: ["src/never"] }], "native-v3-plan-never-settles");
  const childSource = `
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createNativeV3PlanRunner, createNativeV3TestPlanTaskAdapter } from ${JSON.stringify(corePath)};
const plan = ${JSON.stringify(plan)};
const root = await mkdtemp(path.join(os.tmpdir(), "sbw-native-v3-plan-never-settles-child-"));
let markPreparationStarted;
const preparationStarted = new Promise((resolve) => { markPreparationStarted = resolve; });
const taskAdapter = createNativeV3TestPlanTaskAdapter({
  prepareTask: async () => {
    markPreparationStarted();
    return new Promise(() => {});
  }
});
const runner = await createNativeV3PlanRunner({
  stateRoot: root,
  plan,
  planId: plan.planId,
  runId: "sbw-20350101T000000Z-0123456789ab",
  parallelism: 1,
  stopWaitMs: 25,
  taskAdapter
});
const running = runner.run();
await preparationStarted;
await runner.cancel();
const result = await running;
process.stdout.write(JSON.stringify({
  status: result.status,
  taskStatus: result.tasks.never.status,
  errorCode: result.tasks.never.lastError?.code ?? null
}));
await rm(root, { recursive: true, force: true });
`;
  const child = await runBoundedChild(childSource);
  assert.equal(child.code, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.deepEqual(JSON.parse(child.stdout), {
    status: "unknown",
    taskStatus: "unknown",
    errorCode: "EPLAN_RUNNER_STOP_TIMEOUT"
  });
  assert.doesNotMatch(child.stderr, /unsettled top-level await/i);
});

test("POSIX plan adapter runs a real owned native process through the runtime gate", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-native-v3-plan-runner-posix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = makePlan([{ id: "native", paths: ["src/native"] }], "plan-runner-posix-fixture");
  const events = [];
  const fixtureAdapter = fakeAdapter(plan, events);
  const taskAdapter = createNativeV3TestPosixPlanTaskAdapter({
    stateRoot: root,
    prepareTask: async (context) => {
      const trusted = await fixtureAdapter.taskAdapter.prepareTask(context);
      return {
        taskId: trusted.taskId,
        unitId: trusted.unitId,
        binding: trusted.binding,
        controller: trusted.controller,
        command: process.execPath,
        args: ["-e", "process.stdout.write('native-v3-posix-ok')"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        maxOutputBytes: 4096
      };
    }
  });
  const runner = await createNativeV3PlanRunner({
    stateRoot: root,
    plan,
    planId: plan.planId,
    runId: "sbw-20350101T000000Z-0123456789ab",
    parallelism: 1,
    taskAdapter
  });
  const result = await runner.run();
  assert.equal(result.status, "succeeded");
  assert.equal(result.tasks.native.status, "succeeded");
  assert.equal(events.filter((event) => event.type === "prepare" && event.taskId === "native").length, 1);
});


for (const tokens of [null, 100]) {
  test(`production diamond preserves observed time and ${tokens === null ? "unbounded" : "bounded"} unknown tokens`, {
    skip: process.platform !== "darwin" && process.platform !== "linux"
  }, async (t) => {
    const value = await trustedProducerRunnerSetFixture(t, {
      taskSpecs: [
        { id: "a", tokens, paths: ["src/a"] },
        { id: "b", tokens, dependencies: ["a"], paths: ["src/b"] },
        { id: "c", tokens, dependencies: ["a"], paths: ["src/c"] },
        { id: "d", tokens, dependencies: ["b", "c"], paths: ["src/d"] }
      ]
    });
    const runner = await createProductionNativeV3PlanRunner({
      stateRoot: value.root,
      plan: value.plan,
      planId: value.planId,
      runId: PRODUCER_RUN_ID,
      parallelism: 2,
      taskAdapter: value.taskAdapter,
      clock: fixedClock()
    });
    const result = await runner.run();
    assert.equal(result.budget.tokensUsed, null, JSON.stringify(result));
    assert.ok(result.tasks.a.usage.seconds > 0, "monotonic runtime usage survives a fixed authority clock");
    if (tokens !== null) {
      assert.equal(result.status, "hold", JSON.stringify(result.failure));
      assert.equal(result.failure.code, "EPLAN_USAGE_UNKNOWN");
      assert.equal(result.tasks.a.outcome, "success");
      assert.equal(result.tasks.b.dispatches, 0);
      assert.equal(result.tasks.c.dispatches, 0);
      assert.equal(result.tasks.d.dispatches, 0);
      assert.equal(await effectCount(value.counterPath), 1);
      await assert.rejects(runner.resume(), (error) => error.code === "EPLAN_RUNNER_STATE");
      assert.equal(await effectCount(value.counterPath), 1);
    } else {
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      assert.equal(result.failure, null);
      assert.equal(await effectCount(value.counterPath), 4);
      for (const task of Object.values(result.tasks)) {
        assert.equal(task.dispatches, 1);
        assert.equal(task.status, "succeeded");
        assert.equal(task.usage.tokens, null);
        assert.ok(task.usage.seconds > 0);
      }
      assert.equal(result.budget.secondsUsed, Object.values(result.tasks).reduce((sum, task) => sum + task.usage.seconds, 0));
    }
  });
}

for (const control of ["stop", "pause"]) {
  test(`production ${control} wins after the settlement snapshot and before the task result CAS`, {
    skip: process.platform !== "darwin" && process.platform !== "linux"
  }, async (t) => {
    const value = await trustedProducerFixture(t);
    const runner = await createProductionNativeV3PlanRunner({
      stateRoot: value.root, plan: value.plan, planId: value.planId,
      runId: PRODUCER_RUN_ID, parallelism: 1,
      taskAdapter: createNativeV3PlanTaskAdapterFromCommandRunner({ runner: value.commandRunner }),
      clock: fixedClock()
    });
    const checkpointPath = path.join(value.root, "native-v3-plan-runner-v1", "runs", PRODUCER_RUN_ID, "checkpoint.json");
    const originalReadFile = fsPromises.readFile;
    let reached;
    let release;
    let intercepted = false;
    const atSettlementRead = new Promise((resolve) => { reached = resolve; });
    const releaseSnapshot = new Promise((resolve) => { release = resolve; });
    const readMock = mock.method(fsPromises, "readFile", async (...args) => {
      // Target the real unlocked settlement read, not a read while the plan
      // lease is held. Delay delivery of actual bytes without forging them.
      const stack = new Error().stack ?? "";
      const content = await originalReadFile(...args);
      if (!intercepted && args[0] === checkpointPath && stack.includes("at async settleTask (") && !stack.includes("at async withPlanLock")) {
        const snapshot = JSON.parse(content);
        if (snapshot.status === "running" && snapshot.tasks.native.status === "dispatching") {
          intercepted = true;
          reached();
          await releaseSnapshot;
        }
      }
      return content;
    });
    syncBuiltinESMExports();
    const running = runner.run();
    let controlPromise;
    let timer;
    try {
      await Promise.race([
        atSettlementRead,
        running.then(() => { throw new Error("run settled before the snapshot barrier"); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("settlement read not observed")), 30_000); })
      ]);
      clearTimeout(timer);
      controlPromise = runner[control]();
      await waitFor(async () => (await runner.inspect()).dispatchBlocked, "durable settlement fence");
      release();
      const result = await running;
      await controlPromise;
      assert.notEqual(result.status, "succeeded");
      assert.notEqual(result.tasks.native.status, "succeeded");
      assert.equal(result.dispatchBlocked, true);
      assert.equal(await effectCount(value.counterPath), 1);
      assert.equal(result.checkpoint.events.some((event) => event.type === "task.success"), false);
      const snapshot = await value.commandRunner.status();
      assert.equal(snapshot.handle.dispatchBlocked, true);
    } finally {
      clearTimeout(timer);
      release();
      await running.catch(() => {});
      await controlPromise?.catch(() => {});
      readMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

for (const observedNlink of [2, 0]) {
test(`production checkpoint observation fences on the plan lease with nlink ${observedNlink}`, {
  skip: process.platform !== "darwin" && process.platform !== "linux"
}, async (t) => {
  const value = await trustedProducerFixture(t, {
    taskSpecs: [{ id: "native", seconds: null, tokens: null, paths: ["src/native"] }]
  });
  const runner = await createProductionNativeV3PlanRunner({
    stateRoot: value.root, plan: value.plan, planId: value.planId,
    runId: PRODUCER_RUN_ID, parallelism: 1,
    taskAdapter: createNativeV3PlanTaskAdapterFromCommandRunner({ runner: value.commandRunner }),
    clock: fixedClock()
  });
  const runnerRoot = path.join(value.root, "native-v3-plan-runner-v1");
  const checkpointPath = path.join(runnerRoot, "runs", PRODUCER_RUN_ID, "checkpoint.json");
  const leasePath = path.join(runnerRoot, "runs", PRODUCER_RUN_ID, ".lease");
  const publicationLink = `${checkpointPath}.publication-link`;
  const releasePublication = deferred();
  let publicationReady = false;
  let publicationError;
  let leaseConflictObserved = false;
  let inspectionSettled = false;
  let inspection;
  let openMock;
  let lstatMock;
  const publication = withRunLock(runnerRoot, PRODUCER_RUN_ID, async () => {
    if (observedNlink === 2) await fsPromises.link(checkpointPath, publicationLink);
    try {
      publicationReady = true;
      await releasePublication.promise;
    } finally {
      if (observedNlink === 2) await fsPromises.unlink(publicationLink);
    }
  });
  publication.catch((error) => { publicationError = error; });
  try {
    await waitFor(() => publicationReady || publicationError, "checkpoint publisher lease");
    if (publicationError) throw publicationError;
    assert.equal((await fsPromises.lstat(checkpointPath)).nlink, observedNlink === 2 ? 2 : 1);
    if (observedNlink === 0) {
      const originalLstat = fsPromises.lstat;
      lstatMock = mock.method(fsPromises, "lstat", async (...args) => {
        const info = await originalLstat(...args);
        const stack = new Error().stack ?? "";
        if (args[0] !== checkpointPath || !stack.includes("at async readJson") || stack.includes("at async assertNoSymlinkUnder")) return info;
        return new Proxy(info, {
          get(target, property) {
            if (property === "nlink") return 0;
            const result = Reflect.get(target, property, target);
            return typeof result === "function" ? result.bind(target) : result;
          }
        });
      });
      syncBuiltinESMExports();
    }
    const originalOpen = fsPromises.open;
    openMock = mock.method(fsPromises, "open", async (...args) => {
      try {
        return await originalOpen(...args);
      } catch (error) {
        if (args[0] === leasePath && args[1] === "wx" && error?.code === "EEXIST") {
          leaseConflictObserved = true;
        }
        throw error;
      }
    });
    syncBuiltinESMExports();
    inspection = runner.inspect();
    inspection.then(() => { inspectionSettled = true; }, () => { inspectionSettled = true; });
    await waitFor(() => leaseConflictObserved, "checkpoint observation's actual plan lease conflict");
    assert.equal(inspectionSettled, false, "an unsafe checkpoint must not settle before its publisher releases the lease");
    lstatMock?.mock.restore();
    lstatMock = null;
    syncBuiltinESMExports();
    releasePublication.resolve();
    await publication;
    assert.equal((await inspection).status, "ready");
    assert.equal((await fsPromises.lstat(checkpointPath)).nlink, 1);
    openMock.mock.restore();
    openMock = null;
    syncBuiltinESMExports();

    const result = await runner.run();
    assert.equal(result.status, "succeeded", JSON.stringify(result.failure));
    assert.equal(await effectCount(value.counterPath), 1);
    if (observedNlink === 2) {
      await fsPromises.link(checkpointPath, publicationLink);
      try {
        await assert.rejects(
          runner.inspect(),
          (error) => error?.code === "EUNSAFE_JSON_PATH",
          "the lease fence must not accept a stable two-link checkpoint"
        );
      } finally {
        await fsPromises.unlink(publicationLink);
      }
    }
  } finally {
    releasePublication.resolve();
    await publication.catch(() => {});
    await inspection?.catch(() => {});
    openMock?.mock.restore();
    lstatMock?.mock.restore();
    syncBuiltinESMExports();
  }
});
}

test("production cancellation before the effect CAS cannot dispatch after not-started cleanup", {
  skip: process.platform !== "darwin" && process.platform !== "linux"
}, async (t) => {
  const value = await trustedProducerFixture(t, {
    taskSpecs: [{ id: "native", seconds: null, tokens: null, paths: ["src/native"] }]
  });
  const runner = await createProductionNativeV3PlanRunner({
    stateRoot: value.root, plan: value.plan, planId: value.planId,
    runId: PRODUCER_RUN_ID, parallelism: 1,
    taskAdapter: createNativeV3PlanTaskAdapterFromCommandRunner({ runner: value.commandRunner }),
    clock: fixedClock()
  });
  const checkpointPath = path.join(value.root, "native-v3-plan-runner-v1", "runs", PRODUCER_RUN_ID, "checkpoint.json");
  const originalReadFile = fsPromises.readFile;
  const beforeEffect = deferred();
  const releaseRead = deferred();
  let intercepted = false;
  const readMock = mock.method(fsPromises, "readFile", async (...args) => {
    const content = await originalReadFile(...args);
    const stack = new Error().stack ?? "";
    if (!intercepted && args[0] === checkpointPath && stack.includes("at async executeTask (")) {
      const snapshot = JSON.parse(content);
      if (snapshot.tasks.native.status === "dispatching") {
        intercepted = true;
        beforeEffect.resolve();
        await releaseRead.promise;
      }
    }
    return content;
  });
  syncBuiltinESMExports();
  const running = runner.run();
  let cancellation;
  let barrierTimer;
  try {
    await Promise.race([
      beforeEffect.promise,
      running.then(() => { throw new Error("run settled before the pre-effect barrier"); }),
      new Promise((_, reject) => { barrierTimer = setTimeout(() => reject(new Error("pre-effect read not observed")), 30_000); })
    ]);
    clearTimeout(barrierTimer);
    cancellation = runner.cancel();
    await waitFor(async () => (await runner.inspect()).dispatchBlocked, "durable pre-effect cancellation fence");
    releaseRead.resolve();
    const result = await running;
    await cancellation;
    assert.notEqual(result.status, "succeeded");
    assert.equal(await effectCount(value.counterPath), 0);
    assert.equal(result.checkpoint.events.some((event) => event.type === "task.success"), false);
  } finally {
    clearTimeout(barrierTimer);
    releaseRead.resolve();
    await running.catch(() => {});
    await cancellation?.catch(() => {});
    readMock.mock.restore();
    syncBuiltinESMExports();
  }
});
