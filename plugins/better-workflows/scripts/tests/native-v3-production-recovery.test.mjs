import assert from "node:assert/strict";
import { execFile, spawn as nativeSpawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import test, { mock } from "node:test";
import readline from "node:readline/promises";

import { BOUND_CREDENTIAL_WORKSPACE_ROOT, sha256 } from "../lib/core.mjs";
import {
  bindNativeCommandToApprovalEnvelope,
  createNativeCommandBinding
} from "../lib/native-command-binding-v1.mjs";
import {
  collectCooperativeNativeV3OwnerDecision,
  createCooperativeNativeV3Controller,
  nativeV3AllocationKeyFor,
  prepareCooperativeNativeV3Approval,
  revokeCooperativeNativeV3Controller
} from "../lib/native-v3-cooperative-controller.mjs";
import {
  createNativeV3CommandRunner,
  reconcileNativeV3CommandRunner
} from "../lib/native-v3-command-runner.mjs";
import {
  buildWorkflowPlanV1,
  createTaskContractV3,
  persistWorkflowPlanV1
} from "../lib/workflow-plan-v1.mjs";
import {
  createOwnedResourceAdapter,
  createTrustedControllerAdapter
} from "../lib/execution-runtime-v1.mjs";
import { createPosixOwnedProcessAdapter } from "../lib/posix-owned-process-adapter.mjs";

const POSIX = process.platform === "darwin" || process.platform === "linux";
const TRUST_MODE = "cooperative-user-mode";
const PLAN_ID = "native-v3-production-recovery-plan";
const TASK_ID = "native-production-task";
const UNIT_ID = "native-production-unit";
const RECIPIENT = "local-owned-process";
const MODEL = "gpt-5.6-luna";
const REVISION = "a".repeat(40);
const SOURCE_DIGEST = "b".repeat(64);
const DRIFT_DIGEST = "f".repeat(64);
const POLICY_DIGEST = "c".repeat(64);
const TEMPLATE_DIGEST = "d".repeat(64);
const ROUTE_DIGEST = "e".repeat(64);
const EXPIRY = "2099-01-01T00:00:00.000Z";
const execFileAsync = promisify(execFile);

function clock() {
  return { now: () => new Date() };
}

function taskContract() {
  return createTaskContractV3({
    contractId: "native-v3-production-recovery-contract",
    goal: "Run one approved local command and recover its durable outcome",
    scope: { include: ["."], exclude: [] },
    bindings: {
      source: { revision: REVISION, digest: SOURCE_DIGEST },
      policy: { digest: POLICY_DIGEST },
      template: { id: "native-v3-production-recovery-template", digest: TEMPLATE_DIGEST },
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
    budget: { attempts: 2, seconds: 20, tokens: 200 },
    acceptance: [{
      id: "command-complete",
      description: "The command result is durably recorded.",
      requiredEvidence: [],
      critical: true
    }],
    graph: {
      tasks: [{
        id: TASK_ID,
        goal: "Run one approved local command",
        dependencies: [],
        role: "root",
        writeOwner: { role: "root", paths: [] },
        budget: { attempts: 2, seconds: 20, tokens: 200 },
        acceptanceIds: ["command-complete"]
      }]
    }
  });
}

async function approve(root, requestDigest, attemptId) {
  const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const createInterfaceMock = mock.method(readline, "createInterface", () => ({
    question: async (_prompt, options) => {
      assert.ok(options?.signal, "owner approval must be abortable");
      return "approve";
    },
    close() {}
  }));
  try {
    return await collectCooperativeNativeV3OwnerDecision({
      stateRoot: root,
      runId: "sbw-20260915T172800Z-a1b2c3d4e5f6",
      taskId: TASK_ID,
      attemptId,
      allocationKey: nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId }),
      requestDigest,
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

function runId() {
  return "sbw-20260915T172800Z-a1b2c3d4e5f6";
}

async function allocationRecords(root) {
  const directory = path.join(root, "posix-owned-process-v1", "allocations");
  let names;
  try { names = await readdir(directory); } catch { return []; }
  const output = [];
  for (const name of names.filter((item) => /^[0-9a-f-]{36}\.json$/.test(item))) {
    try { output.push(JSON.parse(await readFile(path.join(directory, name), "utf8"))); } catch { /* atomic write in flight */ }
  }
  return output;
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return Boolean(await predicate());
}

async function fixture(t, { sourceReader = null } = {}) {
  const root = await mkdtemp(path.join(BOUND_CREDENTIAL_WORKSPACE_ROOT, "bw-native-v3-production-recovery-"));
  const workspaceRoot = path.join(root, "workspace");
  const cwd = path.join(workspaceRoot, "approved");
  const bindingPath = path.join(root, "native-command-binding.json");
  const executable = path.join(cwd, "owned-command.sh");
  const logPath = path.join(cwd, "launch.log");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const script = "#!/bin/sh\nset -eu\nprintf '%s\\n' launched >> \"$1\"\nexit 0\n";
  await writeFile(executable, script, { mode: 0o755 });
  await writeFile(logPath, "", { mode: 0o600 });
  await chmod(executable, 0o755);
  const plan = buildWorkflowPlanV1({ taskContract: taskContract(), planId: PLAN_ID });
  await persistWorkflowPlanV1({ root, plan });
  const freshness = { sourceBinding: { revision: REVISION, digest: SOURCE_DIGEST }, policyDigest: POLICY_DIGEST };
  const callbacks = {
    readFreshSourceBinding: sourceReader ?? (async () => ({ ...freshness.sourceBinding })),
    readTrustPolicy: async () => ({ policyDigest: freshness.policyDigest, requiredTrustMode: TRUST_MODE })
  };
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspaceRoot, cwd, bindingPath, logPath, executable, plan, freshness, callbacks };
}

async function prepareAttempt(value, {
  attemptId,
  executionId,
  priorAttemptId = undefined,
  executable = value.executable,
  executableBody = "#!/bin/sh\nset -eu\nprintf '%s\\n' launched >> \"$1\"\nexit 0\n",
  freshResolverTimeoutMs = undefined
} = {}) {
  const source = value.freshness.sourceBinding;
  const template = createNativeCommandBinding({
    schemaVersion: 1,
    kind: "NativeCommandBindingV1",
    planDigest: value.plan.planDigest,
    contractDigest: value.plan.contractDigest,
    taskId: TASK_ID,
    unitId: UNIT_ID,
    sourceBindingDigest: SOURCE_DIGEST,
    policyDigest: POLICY_DIGEST,
    revision: REVISION,
    scope: { include: ["."], exclude: [] },
    recipient: RECIPIENT,
    executable,
    executableDigest: sha256(executableBody),
    args: [value.logPath],
    cwd: value.cwd,
    env: { PATH: "/usr/bin:/bin" },
    maxOutputBytes: 1024
  }, { workspaceRoot: value.workspaceRoot });
  const candidate = await prepareCooperativeNativeV3Approval({
    ...value.callbacks,
    stateRoot: value.root,
    planId: PLAN_ID,
    runId: runId(),
    taskId: TASK_ID,
    unitId: UNIT_ID,
    executionId,
    attemptId,
    allocationKey: nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId }),
    ...(priorAttemptId === undefined ? {} : {
      priorAttemptId,
      priorAllocationKey: nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: priorAttemptId })
    }),
    recipient: RECIPIENT,
    action: template.action,
    sourceBinding: source,
    policyDigest: POLICY_DIGEST,
    effectBindingDigest: template.commandDigest,
    requestedModel: MODEL,
    expiresAt: EXPIRY,
    trustMode: TRUST_MODE,
    clock: clock(),
    ...(freshResolverTimeoutMs === undefined ? {} : { freshResolverTimeoutMs })
  });
  const bound = bindNativeCommandToApprovalEnvelope(template, candidate.approvalEnvelope, { workspaceRoot: value.workspaceRoot });
  await writeFile(value.bindingPath, `${JSON.stringify(bound)}\n`, { mode: 0o600 });
  const ownerDecision = await approve(value.root, candidate.ownerApprovalRequest.requestDigest, attemptId);
  return { candidate, bound, ownerDecision };
}

async function acceptAttempt(value, prepared, {
  attemptId = "attempt-1",
  executionId = "execution-1",
  freshResolverTimeoutMs = undefined
} = {}) {
  return createCooperativeNativeV3Controller({
    stateRoot: value.root,
    planId: PLAN_ID,
    runId: runId(),
    taskId: TASK_ID,
    unitId: UNIT_ID,
    executionId,
    attemptId,
    allocationKey: nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId }),
    recipient: RECIPIENT,
    action: prepared.bound.action,
    approvalEnvelope: prepared.candidate.approvalEnvelope,
    effectBindingDigest: prepared.bound.commandDigest,
    ownerDecision: prepared.ownerDecision,
    sourceBinding: value.freshness.sourceBinding,
    policyDigest: POLICY_DIGEST,
    requestedModel: MODEL,
    readFreshSourceBinding: value.callbacks.readFreshSourceBinding,
    readTrustPolicy: value.callbacks.readTrustPolicy,
    trustMode: TRUST_MODE,
    clock: clock(),
    ...(freshResolverTimeoutMs === undefined ? {} : { freshResolverTimeoutMs })
  });
}

function runnerOptions(value, prepared, { attemptId, executionId, resumeFromHandleId = undefined, readFreshSourceBinding = value.callbacks.readFreshSourceBinding } = {}) {
  return {
    stateRoot: value.root,
    root: value.root,
    workspaceRoot: value.workspaceRoot,
    planId: PLAN_ID,
    runId: runId(),
    taskId: TASK_ID,
    unitId: UNIT_ID,
    executionId,
    attemptId,
    ...(resumeFromHandleId === undefined ? {} : { resumeFromHandleId }),
    allocationKey: nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId }),
    bindingPath: value.bindingPath,
    expectedCommandDigest: prepared.bound.commandDigest,
    approvalEnvelope: prepared.candidate.approvalEnvelope,
    effectBindingDigest: prepared.bound.commandDigest,
    ownerDecision: prepared.ownerDecision,
    sourceBinding: value.freshness.sourceBinding,
    policyDigest: POLICY_DIGEST,
    readFreshSourceBinding,
    readTrustPolicy: value.callbacks.readTrustPolicy,
    trustMode: TRUST_MODE,
    requestedModel: MODEL,
    clock: clock()
  };
}

async function runChildRecovery(value, request) {
  const moduleUrl = new URL("../lib/native-v3-command-runner.mjs", import.meta.url).href;
  const script = `import { reconcileNativeV3CommandRunner } from ${JSON.stringify(moduleUrl)};
const request = ${JSON.stringify(request)};
const result = await reconcileNativeV3CommandRunner({ ...request, readFreshSourceBinding: async () => request.sourceBinding, readTrustPolicy: async () => ({ policyDigest: request.policyDigest, requiredTrustMode: request.trustMode }) });
process.stdout.write(JSON.stringify(result));`;
  const child = execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve("."),
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" }
  });
  const { stdout } = await child;
  return JSON.parse(stdout);
}

test("fresh process reconciles a real completed allocation without redispatch", { skip: !POSIX }, async (t) => {
  let driftAfterTerminal = false;
  const value = await fixture(t, {
    sourceReader: async () => {
      const records = await allocationRecords(value?.root).catch(() => []);
      if (driftAfterTerminal || records.some((record) => record.phase === "terminal")) {
        return { revision: REVISION, digest: DRIFT_DIGEST };
      }
      return { revision: REVISION, digest: SOURCE_DIGEST };
    }
  });
  const prepared = await prepareAttempt(value, { attemptId: "attempt-1", executionId: "execution-1" });
  const runner = await createNativeV3CommandRunner(runnerOptions(value, prepared, { attemptId: "attempt-1", executionId: "execution-1" }));
  const execution = runner.execute().then((result) => ({ result }), (error) => ({ error }));
  const settled = await execution;
  assert.equal(settled.result, undefined);
  assert.ok(settled.error);
  assert.ok(settled.error.status === undefined || settled.error.status === "HOLD");
  const status = await runner.status();
  assert.equal(status.intent.status, "unknown");
  assert.equal(status.handle.status, "indeterminate");
  const launchRecords = await allocationRecords(value.root);
  assert.equal(launchRecords.length, 1);
  assert.match(launchRecords[0].launchAuthorizationDigest, /^[a-f0-9]{64}$/, "successful native launch must persist the second authorization CAS");
  assert.match(launchRecords[0].launchCommitmentDigest, /^[a-f0-9]{64}$/, "successful native launch must persist the owned spawn commitment");
  const recoveryRequest = {
    stateRoot: value.root,
    planId: PLAN_ID,
    runId: runId(),
    taskId: TASK_ID,
    unitId: UNIT_ID,
    executionId: "execution-1",
    attemptId: "attempt-1",
    handleId: status.handle.handleId,
    allocationKey: nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" }),
    sourceBinding: value.freshness.sourceBinding,
    policyDigest: POLICY_DIGEST,
    trustMode: TRUST_MODE,
    timeoutMs: 5_000
  };
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    reconcileNativeV3CommandRunner({
      ...recoveryRequest,
      abortSignal: alreadyAborted.signal,
      readFreshSourceBinding: async () => value.freshness.sourceBinding,
      readTrustPolicy: value.callbacks.readTrustPolicy
    }),
    (error) => error?.code === "EEXECUTION_RECONCILE_ABORTED"
  );
  driftAfterTerminal = true;
  await assert.rejects(
    reconcileNativeV3CommandRunner({
      ...recoveryRequest,
      readFreshSourceBinding: async () => ({ revision: REVISION, digest: DRIFT_DIGEST }),
      readTrustPolicy: value.callbacks.readTrustPolicy
    }),
    /source binding drifted|recovery scope/i
  );
  const recovered = await runChildRecovery(value, recoveryRequest);
  assert.equal(recovered.reconciliation.decision, "completed", JSON.stringify(recovered));
  assert.equal(recovered.reconciliation.observation.providerOutcome, "completed");
  assert.equal(recovered.reconciliation.observation.businessOutcome, null);
  const recoveredAgain = await runChildRecovery(value, recoveryRequest);
  assert.equal(recoveredAgain.reconciliation.decision, "completed", JSON.stringify(recoveredAgain));
  assert.equal(recoveredAgain.reconciliations.length, 2, "completed observations remain append-only");
  assert.equal(recoveredAgain.reconciliation.observation.businessOutcome, null);
  assert.equal((await readFile(value.logPath, "utf8")).trim(), "launched");
  await revokeCooperativeNativeV3Controller({
    stateRoot: value.root,
    runId: runId(),
    taskId: TASK_ID,
    attemptId: "attempt-1",
    allocationKey: recoveryRequest.allocationKey,
    expectedEpoch: recovered.handle.authorityEpoch,
    expectedFence: recovered.handle.fence,
    reason: "production recovery test revocation"
  });
  await assert.rejects(runChildRecovery(value, recoveryRequest), /active|revoked|recovery controller/i);
});

test("not-sent recovery requires a fresh epoch and launches the new allocation once", { skip: !POSIX }, async (t) => {
  let rejectDispatch = false;
  let value;
  const sourceReader = async () => {
    if (rejectDispatch) {
      const records = await allocationRecords(value.root);
      const registryPath = path.join(value.root, "execution-runtime-v1", "runs", runId(), "registry.json");
      try {
        const persisted = JSON.parse(await readFile(registryPath, "utf8"));
        if (Object.values(persisted.intents ?? {}).some((intent) => intent.status === "dispatching")) {
          const error = new Error("source binding was revoked before effect dispatch");
          error.code = "ENATIVE_COMMAND_BINDING_FS";
          error.status = "HOLD";
          throw error;
        }
      } catch (error) {
        if (error?.code === "ENATIVE_COMMAND_BINDING_FS") throw error;
      }
      void records;
    }
    return { revision: REVISION, digest: SOURCE_DIGEST };
  };
  value = await fixture(t, { sourceReader });
  const first = await prepareAttempt(value, { attemptId: "attempt-1", executionId: "execution-1" });
  const firstRunner = await createNativeV3CommandRunner(runnerOptions(value, first, {
    attemptId: "attempt-1",
    executionId: "execution-1",
    readFreshSourceBinding: sourceReader
  }));
  const firstHandle = (await firstRunner.status()).handle;
  rejectDispatch = true;
  const firstResult = await firstRunner.execute().then((result) => ({ result }), (error) => ({ error }));
  assert.equal(firstResult.result, undefined);
  assert.equal(firstResult.error.code, "EFFECT_NOT_SENT");
  const firstStatus = await firstRunner.status();
  assert.equal(firstStatus.intent.status, "not-sent");
  assert.equal(firstStatus.handle.status, "ready");

  rejectDispatch = false;
  const second = await prepareAttempt(value, {
    attemptId: "attempt-2",
    executionId: "execution-2",
    priorAttemptId: "attempt-1"
  });
  const secondRunner = await createNativeV3CommandRunner(runnerOptions(value, second, {
    attemptId: "attempt-2",
    executionId: "execution-2",
    resumeFromHandleId: firstHandle.handleId
  }));
  const result = await secondRunner.execute();
  assert.equal(result.outcome, "success");
  const secondStatus = await secondRunner.status();
  assert.equal(secondStatus.handle.status, "completed");
  assert.equal(secondStatus.intent.status, "sealed");
  assert.equal((await readFile(value.logPath, "utf8")).trim().split(/\n+/).length, 1);
  assert.equal(secondStatus.handle.authorityEpoch, 2);
});

test("target startup failure remains UNKNOWN after owned cleanup and cannot form a fresh effect attempt", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const neverSpawned = path.join(value.cwd, "never-spawned.sh");
  const neverSpawnedBody = "#!/definitely/missing/native-v3-interpreter\n";
  await writeFile(neverSpawned, neverSpawnedBody, { mode: 0o755 });
  await chmod(neverSpawned, 0o755);
  const first = await prepareAttempt(value, {
    attemptId: "attempt-1",
    executionId: "execution-1",
    executable: neverSpawned,
    executableBody: neverSpawnedBody
  });
  const firstRunner = await createNativeV3CommandRunner(runnerOptions(value, first, {
    attemptId: "attempt-1",
    executionId: "execution-1"
  }));
  const failed = await firstRunner.execute().then((result) => ({ result }), (error) => ({ error }));
  assert.equal(failed.result, undefined);
  assert.ok(failed.error);
  const firstStatus = await firstRunner.status();
  assert.equal(firstStatus.intent.status, "unknown");
  assert.equal(firstStatus.handle.status, "indeterminate");
  assert.equal(firstStatus.intent.callbackCalls, 1);
  assert.equal(firstStatus.intent.dispatchReserved, false);

  const reconciled = await reconcileNativeV3CommandRunner({
    stateRoot: value.root,
    planId: PLAN_ID,
    runId: runId(),
    taskId: TASK_ID,
    unitId: UNIT_ID,
    executionId: "execution-1",
    attemptId: "attempt-1",
    handleId: firstStatus.handle.handleId,
    allocationKey: nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" }),
    sourceBinding: value.freshness.sourceBinding,
    policyDigest: POLICY_DIGEST,
    trustMode: TRUST_MODE,
    readFreshSourceBinding: value.callbacks.readFreshSourceBinding,
    readTrustPolicy: value.callbacks.readTrustPolicy
  });
  assert.equal(reconciled.reconciliation.decision, "hold", JSON.stringify(reconciled));
  assert.equal(reconciled.reconciliation.observation.providerOutcome, "unknown");
  assert.equal(reconciled.reconciliation.observation.businessOutcome, null);
  const records = await allocationRecords(value.root);
  assert.equal(records.length, 1);
  assert.equal(records[0].launchRequested, true);
  assert.match(records[0].launchReservationDigest, /^[a-f0-9]{64}$/);
  assert.match(records[0].launchAuthorizationDigest, /^[a-f0-9]{64}$/);
  assert.equal(records[0].launchCommitmentDigest, null, "a target startup failure has no spawn acknowledgement or commitment");
  await assert.rejects(
    prepareAttempt(value, {
      attemptId: "attempt-2",
      executionId: "execution-2",
      priorAttemptId: "attempt-1"
    }),
    /prior controller allocation|recovery request/i
  );
  // A fresh recovery process has no live owned supervisor handle, so its
  // terminal-looking record remains HOLD.  The original adapter can resolve
  // only after its own bounded cleanup receipt is available.
  const sameProcess = await firstRunner.reconcile();
  assert.equal(sameProcess.reconciliation.decision, "hold");
  assert.equal(sameProcess.controllerResolution?.status, "cleanup-confirmed", JSON.stringify(sameProcess));
  const resolvedStatePath = path.join(value.root, "native-v3-cooperative-controller-v1", "runs", runId(), "allocations", nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" }), "controller.json");
  const resolvedState = JSON.parse(await readFile(resolvedStatePath, "utf8"));
  assert.equal(resolvedState.launchTransaction, null);
  assert.equal(resolvedState.launchResolution.status, "cleanup-confirmed");
  assert.equal(resolvedState.launchResolution.effectStarted, true);
  assert.equal(resolvedState.launchResolution.noSendProof, null);
  const revoked = await revokeCooperativeNativeV3Controller({
    stateRoot: value.root,
    runId: runId(),
    taskId: TASK_ID,
    attemptId: "attempt-1",
    allocationKey: nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" }),
    expectedEpoch: resolvedState.authorityEpoch,
    expectedFence: resolvedState.fence,
    reason: "resolve owned cleanup before revocation"
  });
  assert.equal(revoked.launchStatus, "cleanup-confirmed-before-revocation");
  assert.equal(revoked.completionStatus, "unresolved");
  const second = await prepareAttempt(value, {
    attemptId: "attempt-2",
    executionId: "execution-2",
    priorAttemptId: "attempt-1"
  });
  // Physical cleanup is a lifecycle fact only.  A new owner approval, new
  // epoch, or remaining budget cannot resolve the old effect.  Reject before
  // creating a new runtime handle, even if a later ledger would also HOLD.
  const runtimePath = path.join(value.root, "execution-runtime-v1", "runs", runId(), "registry.json");
  const beforeRegistry = await readFile(runtimePath, "utf8");
  await assert.rejects(
    createNativeV3CommandRunner(runnerOptions(value, second, {
      attemptId: "attempt-2",
      executionId: "execution-2",
      resumeFromHandleId: firstStatus.handle.handleId
    })),
    (error) => error.code === "EEXECUTION_RECONCILIATION_REQUIRED" && error.status === "UNKNOWN",
    "an unresolved effect cannot form a fresh attempt using physical cleanup"
  );
  const after = await firstRunner.status();
  assert.equal(await readFile(runtimePath, "utf8"), beforeRegistry, "rejected recovery cannot publish another handle");
  assert.equal(after.intent.status, "unknown");
  assert.equal(after.intent.cleanupResolution.status, "cleanup-confirmed");
  assert.equal((await readFile(value.logPath, "utf8")).trim(), "", "a held recovery must never launch the effect");
});

test("owned cleanup resolution accepts only the frozen factory adapter identity", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const prepared = await prepareAttempt(value, { attemptId: "attempt-1", executionId: "execution-1" });
  const accepted = await acceptAttempt(value, prepared);
  const genuine = createPosixOwnedProcessAdapter({ root: value.root, trustedController: accepted.controller });
  assert.equal(Object.isFrozen(genuine.resourceAdapter), true);

  let genericResolverCalls = 0;
  const genericFactoryAdapter = createOwnedResourceAdapter({
    stopOwned: async () => ({ status: "unknown" }),
    resolveOwnedLaunch: async () => {
      genericResolverCalls += 1;
      return { status: "cleanup-confirmed" };
    }
  });
  await assert.rejects(
    accepted.controller.resolveEffectLaunchTransaction({}, genericFactoryAdapter),
    /trusted POSIX owned resource adapter/
  );
  assert.equal(genericResolverCalls, 0, "generic callback adapter must never be invoked as production cleanup evidence");

  const forgedDerived = Object.create(genuine.resourceAdapter);
  Object.defineProperty(forgedDerived, "resolveOwnedLaunch", {
    value: async () => ({ status: "cleanup-confirmed" }),
    configurable: true,
    enumerable: true,
    writable: true
  });
  const forgedClone = { ...genuine.resourceAdapter, resolveOwnedLaunch: async () => ({ status: "cleanup-confirmed" }) };
  const forgedProxy = new Proxy(genuine.resourceAdapter, {
    get(target, property, receiver) {
      if (property === "resolveOwnedLaunch") return async () => ({ status: "cleanup-confirmed" });
      return Reflect.get(target, property, receiver);
    }
  });

  for (const forged of [forgedDerived, forgedClone, forgedProxy]) {
    await assert.rejects(
      accepted.controller.resolveEffectLaunchTransaction({}, forged),
      /requires a trusted owned resource adapter/
    );
  }
  assert.throws(
    () => Object.defineProperty(genuine.resourceAdapter, "resolveOwnedLaunch", { value: async () => ({}) }),
    TypeError
  );
});

test("revocation that wins the launch reservation CAS prevents the POSIX effect", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const prepared = await prepareAttempt(value, { attemptId: "attempt-1", executionId: "execution-1" });
  const accepted = await createCooperativeNativeV3Controller({
    stateRoot: value.root,
    planId: PLAN_ID,
    runId: runId(),
    taskId: TASK_ID,
    unitId: UNIT_ID,
    executionId: "execution-1",
    attemptId: "attempt-1",
    allocationKey: nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" }),
    recipient: RECIPIENT,
    action: prepared.bound.action,
    approvalEnvelope: prepared.candidate.approvalEnvelope,
    effectBindingDigest: prepared.bound.commandDigest,
    ownerDecision: prepared.ownerDecision,
    sourceBinding: value.freshness.sourceBinding,
    policyDigest: POLICY_DIGEST,
    requestedModel: MODEL,
    readFreshSourceBinding: value.callbacks.readFreshSourceBinding,
    readTrustPolicy: value.callbacks.readTrustPolicy,
    trustMode: TRUST_MODE,
    clock: clock()
  });
  const allocationKey = nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" });
  const adapter = createPosixOwnedProcessAdapter({
    root: value.root,
    trustedController: accepted.controller,
    beforeLaunch: async () => {
      await revokeCooperativeNativeV3Controller({
        stateRoot: value.root,
        runId: runId(),
        taskId: TASK_ID,
        attemptId: "attempt-1",
        allocationKey,
        expectedEpoch: accepted.authorityReceipt.authorityEpoch,
        expectedFence: accepted.authorityReceipt.fence,
        reason: "production launch reservation race"
      });
    }
  });
  const executionContext = {
    schemaVersion: 1,
    handleId: "race-handle",
    intentId: "race-intent",
    binding: {
      ...accepted.binding,
      ownedResourceId: accepted.authorityReceipt.ownedResourceId
    },
    authorityEpoch: accepted.authorityReceipt.authorityEpoch,
    fence: accepted.authorityReceipt.fence
  };
  await assert.rejects(
    adapter.startOwned(executionContext, {
      command: value.executable,
      args: [value.logPath],
      cwd: value.cwd,
      env: { PATH: "/usr/bin:/bin" },
      effectBindingDigest: prepared.bound.commandDigest
    }),
    /authority|active|revoked/i
  );
  assert.equal((await readFile(value.logPath, "utf8")).trim(), "");
  const records = await allocationRecords(value.root);
  assert.equal(records.length, 1);
  assert.equal(records[0].launchRequested, false);
  assert.equal(records[0].launchReservationDigest, null);
  assert.ok(records[0].noSendProof, "only a pre-reservation cleanup can carry no-send proof");
});

test("revocation after reservation but before authorization prevents any target effect", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const prepared = await prepareAttempt(value, { attemptId: "attempt-1", executionId: "execution-1" });
  const accepted = await acceptAttempt(value, prepared);
  const allocationKey = nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" });
  let intercepted = false;
  let revokeReceipt = null;
  let revokeError = null;
  const spawnImpl = (...args) => {
    const child = nativeSpawn(...args);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => {
      let message = null;
      try { message = JSON.parse(Buffer.from(chunk).toString("utf8")); } catch { /* let supervisor report protocol errors */ }
      if (!intercepted && message?.type === "launch" && message.reservationId) {
        intercepted = true;
        void revokeCooperativeNativeV3Controller({
          stateRoot: value.root,
          runId: runId(),
          taskId: TASK_ID,
          attemptId: "attempt-1",
          allocationKey,
          expectedEpoch: accepted.authorityReceipt.authorityEpoch,
          expectedFence: accepted.authorityReceipt.fence,
          reason: "revoke after reservation before authorization"
        }).then((receipt) => { revokeReceipt = receipt; write(chunk, ...rest); }, (error) => {
          revokeError = error;
          write(chunk, ...rest);
        });
        return true;
      }
      return write(chunk, ...rest);
    };
    return child;
  };
  const executionContext = {
    schemaVersion: 1,
    handleId: "reservation-race-handle",
    intentId: "reservation-race-intent",
    binding: { ...accepted.binding, ownedResourceId: accepted.authorityReceipt.ownedResourceId },
    authorityEpoch: accepted.authorityReceipt.authorityEpoch,
    fence: accepted.authorityReceipt.fence
  };
  await assert.rejects(
    createPosixOwnedProcessAdapter({ root: value.root, trustedController: accepted.controller, spawnImpl }).startOwned(executionContext, {
      command: value.executable,
      args: [value.logPath],
      cwd: value.cwd,
      env: { PATH: "/usr/bin:/bin" },
      effectBindingDigest: prepared.bound.commandDigest
    }),
    /authority|active|revoked/i
  );
  assert.equal(revokeError, null, revokeError?.stack);
  assert.equal(revokeReceipt?.status, "revoked");
  assert.equal(revokeReceipt?.launchStatus, "reserved-before-revocation");
  assert.equal(revokeReceipt?.completionStatus, "unresolved");
  assert.equal(intercepted, true);
  assert.equal((await readFile(value.logPath, "utf8")).trim(), "", "revocation won before authorization, so the target was never spawned");
  const records = await allocationRecords(value.root);
  assert.equal(records.length, 1);
  assert.equal(records[0].launchRequested, true);
  assert.match(records[0].launchReservationDigest, /^[a-f0-9]{64}$/);
  assert.equal(records[0].launchAuthorizationDigest, null);
  assert.equal(records[0].launchCommitmentDigest, null);
  assert.equal(records[0].noSendProof, null, "reservation crossed the no-send boundary even though authorization was denied");
});

test("revocation cannot complete until the owned supervisor acknowledges the spawn", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const prepared = await prepareAttempt(value, { attemptId: "attempt-1", executionId: "execution-1" });
  const accepted = await acceptAttempt(value, prepared);
  const allocationKey = nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" });
  let intercepted = false;
  let revokePromise = null;
  let supervisorReadyAt = null;
  const spawnImpl = (...args) => {
    const child = nativeSpawn(...args);
    const write = child.stdin.write.bind(child.stdin);
    let controlBuffer = "";
    child.stdio?.[3]?.on("data", (chunk) => {
      controlBuffer += Buffer.from(chunk).toString("utf8");
      let index;
      while ((index = controlBuffer.indexOf("\n")) >= 0) {
        const line = controlBuffer.slice(0, index);
        controlBuffer = controlBuffer.slice(index + 1);
        try {
          if (JSON.parse(line)?.type === "ready") supervisorReadyAt = Date.now();
        } catch { /* adapter owns protocol validation */ }
      }
    });
    child.stdin.write = (chunk, ...rest) => {
      let message = null;
      try { message = JSON.parse(Buffer.from(chunk).toString("utf8")); } catch { /* let supervisor report protocol errors */ }
      if (!intercepted && message?.type === "launch-go" && message.commitmentId) {
        intercepted = true;
        revokePromise = revokeCooperativeNativeV3Controller({
          stateRoot: value.root,
          runId: runId(),
          taskId: TASK_ID,
          attemptId: "attempt-1",
          allocationKey,
          expectedEpoch: accepted.authorityReceipt.authorityEpoch,
          expectedFence: accepted.authorityReceipt.fence,
          reason: "revoke waits for owned spawn acknowledgement"
        });
        setTimeout(() => write(chunk, ...rest), 150);
        return true;
      }
      return write(chunk, ...rest);
    };
    return child;
  };
  const executionContext = {
    schemaVersion: 1,
    handleId: "spawn-transaction-handle",
    intentId: "spawn-transaction-intent",
    binding: { ...accepted.binding, ownedResourceId: accepted.authorityReceipt.ownedResourceId },
    authorityEpoch: accepted.authorityReceipt.authorityEpoch,
    fence: accepted.authorityReceipt.fence
  };
  const adapter = createPosixOwnedProcessAdapter({ root: value.root, trustedController: accepted.controller, spawnImpl });
  const handle = await adapter.startOwned(executionContext, {
    command: value.executable,
    args: [value.logPath],
    cwd: value.cwd,
    env: { PATH: "/usr/bin:/bin" },
    effectBindingDigest: prepared.bound.commandDigest
  });
  const revokeResolvedAt = Date.now();
  const revoked = await revokePromise;
  assert.equal(intercepted, true);
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.launchStatus, "committed-before-revocation");
  assert.equal(revoked.completionStatus, "unresolved");
  assert.ok(supervisorReadyAt !== null && supervisorReadyAt <= revokeResolvedAt,
    "revocation must not complete before the supervisor reports the real target spawn");
  assert.equal(await waitFor(() => readFile(value.logPath, "utf8").then((content) => content.trim() === "launched").catch(() => false)), true);
  assert.match((await readFile(value.logPath, "utf8")).trim(), /^launched$/);
  const stopped = await adapter.stopOwned({ request: {
    runId: runId(),
    handleId: handle.handleId,
    ownedResourceId: handle.ownedResourceId,
    reason: "cleanup spawn transaction test"
  }});
  assert.ok(["stopped", "unknown"].includes(stopped.localOutcome));
  const records = await allocationRecords(value.root);
  assert.equal(records.length, 1);
  assert.match(records[0].launchCommitmentDigest, /^[a-f0-9]{64}$/);
});

test("revocation after durable authorization but before its frame delivery prevents spawn", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const prepared = await prepareAttempt(value, { attemptId: "attempt-1", executionId: "execution-1" });
  const accepted = await acceptAttempt(value, prepared);
  const allocationKey = nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" });
  let intercepted = false;
  let revokeReceipt = null;
  let revokeError = null;
  const spawnImpl = (...args) => {
    const child = nativeSpawn(...args);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => {
      let message = null;
      try { message = JSON.parse(Buffer.from(chunk).toString("utf8")); } catch { /* let supervisor report protocol errors */ }
      if (!intercepted && message?.type === "launch-authorized" && message.authorizationDigest) {
        intercepted = true;
        void revokeCooperativeNativeV3Controller({
          stateRoot: value.root,
          runId: runId(),
          taskId: TASK_ID,
          attemptId: "attempt-1",
          allocationKey,
          expectedEpoch: accepted.authorityReceipt.authorityEpoch,
          expectedFence: accepted.authorityReceipt.fence,
          reason: "revoke after durable authorization before frame delivery"
        }).then((receipt) => { revokeReceipt = receipt; write(chunk, ...rest); }, (error) => {
          revokeError = error;
          write(chunk, ...rest);
        });
        return true;
      }
      return write(chunk, ...rest);
    };
    return child;
  };
  const executionContext = {
    schemaVersion: 1,
    handleId: "authorization-frame-race-handle",
    intentId: "authorization-frame-race-intent",
    binding: { ...accepted.binding, ownedResourceId: accepted.authorityReceipt.ownedResourceId },
    authorityEpoch: accepted.authorityReceipt.authorityEpoch,
    fence: accepted.authorityReceipt.fence
  };
  await assert.rejects(
    createPosixOwnedProcessAdapter({ root: value.root, trustedController: accepted.controller, spawnImpl }).startOwned(executionContext, {
      command: value.executable,
      args: [value.logPath],
      cwd: value.cwd,
      env: { PATH: "/usr/bin:/bin" },
      effectBindingDigest: prepared.bound.commandDigest
    }),
    /authority|active|revoked/i
  );
  assert.equal(revokeError, null, revokeError?.stack);
  assert.equal(revokeReceipt?.status, "revoked");
  assert.equal(revokeReceipt?.launchStatus, "authorized-before-revocation");
  assert.equal(revokeReceipt?.completionStatus, "unresolved");
  assert.equal(intercepted, true);
  assert.equal((await readFile(value.logPath, "utf8")).trim(), "", "late authorization delivery must not spawn the target");
  const records = await allocationRecords(value.root);
  assert.equal(records.length, 1);
  assert.equal(records[0].launchRequested, true);
  assert.match(records[0].launchReservationDigest, /^[a-f0-9]{64}$/);
  assert.match(records[0].launchAuthorizationDigest, /^[a-f0-9]{64}$/);
  assert.equal(records[0].launchCommitmentDigest, null);
  assert.equal(records[0].noSendProof, null, "authorization crossed the no-send boundary even though the owned spawn was rejected");
});

test("an unacknowledged owned launch stays UNKNOWN and blocks revocation success", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const prepared = await prepareAttempt(value, { attemptId: "attempt-1", executionId: "execution-1" });
  const accepted = await acceptAttempt(value, prepared);
  const allocationKey = nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" });
  let intercepted = false;
  let revokePromise = null;
  const spawnImpl = (...args) => {
    const child = nativeSpawn(...args);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => {
      let message = null;
      try { message = JSON.parse(Buffer.from(chunk).toString("utf8")); } catch { /* let supervisor report protocol errors */ }
      if (!intercepted && message?.type === "launch-go" && message.commitmentId) {
        intercepted = true;
        revokePromise = revokeCooperativeNativeV3Controller({
          stateRoot: value.root,
          runId: runId(),
          taskId: TASK_ID,
          attemptId: "attempt-1",
          allocationKey,
          expectedEpoch: accepted.authorityReceipt.authorityEpoch,
          expectedFence: accepted.authorityReceipt.fence,
          reason: "revoke while owned launch acknowledgement is unknown"
        }).then((result) => ({ result }), (error) => ({ error }));
        // Let the controller's bounded acknowledgement timeout happen before
        // delivering the frame.  The supervisor must already have received
        // launch-commit-rejected and must not revive this delayed frame.
        setTimeout(() => write(chunk, ...rest), 2_500);
        return true;
      }
      return write(chunk, ...rest);
    };
    return child;
  };
  const executionContext = {
    schemaVersion: 1,
    handleId: "unknown-launch-handle",
    intentId: "unknown-launch-intent",
    binding: { ...accepted.binding, ownedResourceId: accepted.authorityReceipt.ownedResourceId },
    authorityEpoch: accepted.authorityReceipt.authorityEpoch,
    fence: accepted.authorityReceipt.fence
  };
  const started = await createPosixOwnedProcessAdapter({ root: value.root, trustedController: accepted.controller, spawnImpl }).startOwned(executionContext, {
    command: value.executable,
    args: [value.logPath],
    cwd: value.cwd,
    env: { PATH: "/usr/bin:/bin" },
    effectBindingDigest: prepared.bound.commandDigest
  }).then((result) => ({ result }), (error) => ({ error }));
  assert.ok(started.error);
  assert.equal(intercepted, true);
  const revoked = await revokePromise;
  assert.ok(revoked.error);
  assert.equal(revoked.error.code, "EOWNER_REVOCATION_UNKNOWN");
  assert.equal(revoked.error.status, "HOLD");
  const statePath = path.join(value.root, "native-v3-cooperative-controller-v1", "runs", runId(), "allocations", allocationKey, "controller.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.launchTransaction.status, "unknown");
  assert.equal(state.launchCommitment, null);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal((await readFile(value.logPath, "utf8")).trim(), "", "a delayed launch frame cannot revive an unresolved transaction");
  const restartedAdapter = createPosixOwnedProcessAdapter({ root: value.root, trustedController: accepted.controller });
  const resolutionRequest = {
    ...accepted.binding,
    handleId: executionContext.handleId,
    intentId: executionContext.intentId,
    authorityEpoch: state.launchTransaction.authorityEpoch,
    fence: state.launchTransaction.fence,
    transactionId: state.launchTransaction.transactionId,
    transactionDigest: state.launchTransaction.digest
  };
  await assert.rejects(
    accepted.controller.resolveEffectLaunchTransaction(resolutionRequest, restartedAdapter.resourceAdapter),
    (error) => error?.code === "EOWNER_LAUNCH_RESOLUTION_UNKNOWN" && error?.status === "HOLD"
  );
  const stillUnknown = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(stillUnknown.launchTransaction.status, "unknown", "a restarted adapter cannot clear UNKNOWN from PID absence alone");
});

test("bounded fresh resolver releases the launch lock for revocation", { skip: !POSIX }, async (t) => {
  let hang = false;
  let releaseResolver = null;
  const value = await fixture(t, {
    sourceReader: async () => {
      if (hang) await new Promise((resolve) => { releaseResolver = resolve; });
      return { revision: REVISION, digest: SOURCE_DIGEST };
    }
  });
  const prepared = await prepareAttempt(value, { attemptId: "attempt-1", executionId: "execution-1" });
  const accepted = await acceptAttempt(value, prepared);
  const allocationKey = nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" });
  const reservation = await accepted.controller.commitEffectLaunch({
    ...accepted.binding,
    authorityEpoch: accepted.authorityReceipt.authorityEpoch,
    fence: accepted.authorityReceipt.fence,
    effectBindingDigest: prepared.bound.commandDigest
  });
  hang = true;
  const authorizationRequest = {
    ...accepted.binding,
    authorityEpoch: reservation.authorityEpoch,
    fence: reservation.fence,
    effectBindingDigest: reservation.effectBindingDigest,
    reservationId: reservation.reservationId,
    reservationDigest: reservation.digest
  };
  const authorizationPromise = accepted.controller.authorizeEffectLaunch(authorizationRequest).then(
    (result) => ({ result }),
    (error) => ({ error })
  );
  assert.equal(await waitFor(() => typeof releaseResolver === "function", 1_000), true, "fresh source resolver did not enter the bounded callback");
  const revokeStarted = Date.now();
  const revokePromise = revokeCooperativeNativeV3Controller({
    stateRoot: value.root,
    runId: runId(),
    taskId: TASK_ID,
    attemptId: "attempt-1",
    allocationKey,
    expectedEpoch: accepted.authorityReceipt.authorityEpoch,
    expectedFence: accepted.authorityReceipt.fence,
    reason: "bounded resolver timeout test"
  });
  const [authorization, revoked] = await Promise.all([authorizationPromise, revokePromise]);
  releaseResolver?.();
  assert.equal(authorization.result, undefined);
  assert.equal(authorization.error?.code, "EOWNER_LOCK_TIMEOUT", authorization.error?.stack);
  assert.equal(revoked.status, "revoked");
  assert.ok(Date.now() - revokeStarted < 4_500, "revocation remained bounded behind the stalled resolver");
  const statePath = path.join(value.root, "native-v3-cooperative-controller-v1", "runs", runId(), "allocations", allocationKey, "controller.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.launchAuthorization, null, "timed-out authorization must not be persisted late");
});

test("a bounded complete capture window admits a real POSIX lane without late dispatch", { skip: !POSIX }, async (t) => {
  let sourceReads = 0;
  const value = await fixture(t, {
    sourceReader: async () => {
      sourceReads += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { revision: REVISION, digest: SOURCE_DIGEST };
    }
  });
  for (const [index, invalid] of [0, -1, 1.5, Number.NaN, 4_001].entries()) {
    await assert.rejects(
      prepareAttempt(value, {
        attemptId: `invalid-timeout-${index}`,
        executionId: `invalid-timeout-execution-${index}`,
        freshResolverTimeoutMs: invalid
      }),
      /freshResolverTimeoutMs/
    );
  }
  const prepared = await prepareAttempt(value, {
    attemptId: "attempt-1",
    executionId: "execution-1",
    freshResolverTimeoutMs: 3_500
  });
  const accepted = await acceptAttempt(value, prepared, { freshResolverTimeoutMs: 3_500 });
  const executionContext = {
    schemaVersion: 1,
    handleId: "bounded-capture-handle",
    intentId: "bounded-capture-intent",
    binding: { ...accepted.binding, ownedResourceId: accepted.authorityReceipt.ownedResourceId },
    authorityEpoch: accepted.authorityReceipt.authorityEpoch,
    fence: accepted.authorityReceipt.fence
  };
  const adapter = createPosixOwnedProcessAdapter({ root: value.root, trustedController: accepted.controller });
  const startedAt = Date.now();
  const handle = await adapter.startOwned(executionContext, {
    command: value.executable,
    args: [value.logPath],
    cwd: value.cwd,
    env: { PATH: "/usr/bin:/bin" },
    effectBindingDigest: prepared.bound.commandDigest
  });
  const completion = await handle.completion;
  const elapsedMs = Date.now() - startedAt;
  assert.equal(completion.outcome, "stopped");
  assert.equal(completion.code, 0);
  assert.equal(completion.signal, null);
  assert.equal(completion.groupTerminated, true);
  assert.ok(elapsedMs < 15_000, `bounded POSIX lane exceeded its test budget: ${elapsedMs}ms`);
  assert.ok(sourceReads >= 5, `expected every launch boundary to capture source, got ${sourceReads}`);
  assert.equal((await readFile(value.logPath, "utf8")).trim(), "launched");
  const records = await allocationRecords(value.root);
  assert.equal(records.length, 1);
  assert.equal(records[0].phase, "terminal");
  assert.equal(records[0].groupTerminated, true);
  assert.equal(records[0].launchRequested, true);
  assert.match(records[0].launchCommitmentDigest, /^[a-f0-9]{64}$/);
  await revokeCooperativeNativeV3Controller({
    stateRoot: value.root,
    runId: runId(),
    taskId: TASK_ID,
    attemptId: "attempt-1",
    allocationKey: nativeV3AllocationKeyFor({ taskId: TASK_ID, attemptId: "attempt-1" }),
    expectedEpoch: accepted.authorityReceipt.authorityEpoch,
    expectedFence: accepted.authorityReceipt.fence,
    reason: "bounded complete capture lane finished"
  });
});

test("production reconciliation rejects caller query seams and stale recovery identity", { skip: !POSIX }, async (t) => {
  const value = await fixture(t);
  const prepared = await prepareAttempt(value, { attemptId: "attempt-1", executionId: "execution-1" });
  await assert.rejects(
    reconcileNativeV3CommandRunner({
      stateRoot: value.root,
      planId: PLAN_ID,
      runId: runId(),
      taskId: TASK_ID,
      unitId: UNIT_ID,
      executionId: "execution-1",
      attemptId: "attempt-1",
      handleId: "handle-does-not-exist",
      sourceBinding: value.freshness.sourceBinding,
      policyDigest: POLICY_DIGEST,
      trustMode: TRUST_MODE,
      readFreshSourceBinding: value.callbacks.readFreshSourceBinding,
      readTrustPolicy: value.callbacks.readTrustPolicy,
      fakeCallerPid: process.pid
    }),
    /unknown option|fakeCallerPid|handle|allocation|recovery/i
  );
  const forgedGenericController = createTrustedControllerAdapter({
    readRunContract: async () => ({}),
    readSourceBinding: async () => ({}),
    readAuthority: async () => ({}),
    readExecutionBinding: async () => ({ authority: {} }),
    trustBoundary: {
      id: "forged-generic-controller",
      verify: async ({ authorityDigest }) => ({
        kind: "TrustedControllerAttestationV1",
        controllerId: "forged-generic-controller",
        authorityDigest
      })
    }
  });
  assert.throws(
    () => createPosixOwnedProcessAdapter({ root: value.root, trustedController: forgedGenericController }),
    /native V3 controller producer/i
  );
  assert.equal(prepared.candidate.approvalEnvelope.ownedResourceId.length > 0, true);
});
