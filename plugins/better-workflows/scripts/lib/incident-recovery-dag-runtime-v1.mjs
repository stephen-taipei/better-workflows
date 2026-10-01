import path from "node:path";
import os from "node:os";
import { lstat, readFile, realpath } from "node:fs/promises";
import { types as utilTypes } from "node:util";

import {
  digestObject,
  safeJoin
} from "./core.mjs";
import {
  INCIDENT_RECOVERY_DAG_ADMISSION_LEDGER_FILE,
  assertCommittedIncidentRecoveryDagAdmissionBatchV1,
  readCommittedIncidentRecoveryDagAdmissionBatchV1,
  validateIncidentRecoveryDagAdmissionLedgerV1
} from "./incident-recovery-dag-admission-v1.mjs";
import { validateIncidentRecoveryDagPlanV1 } from "./incident-recovery-dag-v1.mjs";
import {
  isTrustedControllerAdapter,
  openExecutionRegistry,
  readExecutionRecoveryHandoffV1,
  readExecutionRecoveryTaskEffectIntentV1,
  validateExecutionRecoveryHandoffClaimV1,
  validateExecutionRecoveryHandoffV1,
  validateExecutionRecoveryTaskEffectIntentV1,
  validateExecutionRecoveryTaskPermitConsumptionV1,
  validateExecutionRecoveryTaskReleaseV1,
  withExecutionRecoveryHandoffReadLeaseV1
} from "./execution-runtime-v1.mjs";

export const INCIDENT_RECOVERY_DAG_RUNTIME_SCHEMA_VERSION = 1;
export const INCIDENT_RECOVERY_DAG_RUNTIME_KIND = "IncidentRecoveryDagRuntimeHandoffV1";
export const INCIDENT_RECOVERY_DAG_RUNTIME_CLAIM_KIND = "IncidentRecoveryDagRuntimeClaimV1";
export const INCIDENT_RECOVERY_DAG_RUNTIME_TASK_RELEASE_KIND = "IncidentRecoveryDagRuntimeTaskReleaseV1";
export const INCIDENT_RECOVERY_DAG_RUNTIME_TASK_CONSUMPTION_KIND = "IncidentRecoveryDagRuntimeTaskConsumptionV1";
export const INCIDENT_RECOVERY_DAG_RUNTIME_TASK_EFFECT_INTENT_KIND = "IncidentRecoveryDagRuntimeTaskEffectIntentV1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const RUNTIME_DIRECTORY = "execution-runtime-v1";
const EFFECT_AUTHORITY = Object.freeze({
  mayCreateHandle: false,
  mayDispatch: false,
  mayPerformEffects: false
});
const RECOVERY_AUTHORITY = Object.freeze({
  mayUnblockHandle: false,
  mayDispatch: false,
  mayPerformEffects: false
});

export class IncidentRecoveryDagRuntimeError extends Error {
  constructor(code, message, status = "HOLD", details = undefined) {
    super(message);
    this.name = "IncidentRecoveryDagRuntimeError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, status = "HOLD", details = undefined) {
  throw new IncidentRecoveryDagRuntimeError(code, message, status, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} contains an accessor property`);
    }
  }
  return value;
}

function assertArray(value, label, maximum = 256) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length === 0 || value.length > maximum) {
    fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} is invalid`);
  }
  const length = value.length;
  let indexes = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} contains an unexpected property`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} contains an accessor property`);
    }
    indexes += 1;
  }
  if (indexes !== length) fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} must not be sparse`);
  return value;
}

function exactKeys(value, keys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} has an unexpected shape`);
  }
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} is invalid`);
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} is invalid`);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function same(left, right) {
  return digestObject(left) === digestObject(right);
}

function validateBinding(value, label) {
  exactKeys(value, [
    "runId", "executionId", "attemptId", "unitId", "ownedResourceId",
    "sourceBindingDigest", "policyDigest", "revision"
  ], label);
  for (const key of ["runId", "executionId", "attemptId", "unitId", "ownedResourceId"]) {
    assertId(value[key], `${label}.${key}`);
  }
  assertDigest(value.sourceBindingDigest, `${label}.sourceBindingDigest`);
  assertDigest(value.policyDigest, `${label}.policyDigest`);
  if (typeof value.revision !== "string" || value.revision.length === 0 || value.revision.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(value.revision)) {
    fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label}.revision is invalid`);
  }
  return clone(value);
}

async function canonicalDirectory(value, label, { rejectBroad = false } = {}) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} must be an absolute path`);
  }
  const resolved = path.resolve(value);
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} must already exist: ${error.message}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} must be a real directory`);
  }
  let canonical;
  try {
    canonical = await realpath(resolved);
  } catch (error) {
    fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} cannot be resolved canonically: ${error.message}`);
  }
  if (canonical !== resolved) fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} is not its canonical path`);
  if (rejectBroad) {
    const unsafe = new Set([path.parse(canonical).root]);
    for (const candidate of [os.homedir(), os.tmpdir(), "/tmp", "/private/tmp"]) {
      const candidateCanonical = await realpath(candidate).catch(() => null);
      if (candidateCanonical) unsafe.add(candidateCanonical);
    }
    if (unsafe.has(canonical)) fail("EINCIDENT_DAG_RUNTIME_INPUT", `${label} must be a dedicated task directory`);
  }
  return {
    path: canonical,
    device: String(info.dev),
    inode: String(info.ino)
  };
}

async function assertNoSymlinkUnderReadOnly(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = safeJoin(resolvedRoot, path.relative(resolvedRoot, path.resolve(target)));
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  const components = relative.split(path.sep).filter(Boolean);
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = path.join(current, components[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) fail("EINCIDENT_DAG_RUNTIME_INPUT", `refusing symlink path component: ${current}`);
    if (index < components.length - 1 && !info.isDirectory()) {
      fail("EINCIDENT_DAG_RUNTIME_INPUT", `expected directory path component: ${current}`);
    }
  }
}

async function canonicalRuntimeRoots(stateRoot, runId) {
  const state = await canonicalDirectory(stateRoot, "stateRoot", { rejectBroad: true });
  const runtimePath = safeJoin(state.path, RUNTIME_DIRECTORY);
  await assertNoSymlinkUnderReadOnly(state.path, runtimePath);
  const runtime = await canonicalDirectory(runtimePath, "runtimeRoot");
  const runDirectory = safeJoin(runtime.path, "runs", runId);
  const journalPath = safeJoin(runDirectory, "journal.jsonl");
  const registryPath = safeJoin(runDirectory, "registry.json");
  await assertNoSymlinkUnderReadOnly(runtime.path, journalPath);
  await assertNoSymlinkUnderReadOnly(runtime.path, registryPath);
  const admissionStateRootDigest = digestObject({
    schemaVersion: 1,
    canonicalPath: state.path,
    device: state.device,
    inode: state.inode
  });
  const runtimeScopeDigest = digestObject({
    schemaVersion: 1,
    stateRoot: state,
    runtimeRoot: runtime,
    runId,
    journalRelativePath: `runs/${runId}/journal.jsonl`,
    registryRelativePath: `runs/${runId}/registry.json`
  });
  return { state, runtime, admissionStateRootDigest, runtimeScopeDigest };
}

async function readCommittedAdmissionBatchReadOnly(stateRoot, runId, authorityId) {
  const storageScopeDigest = digestObject({ schemaVersion: 1, stateRoot: path.resolve(stateRoot), runId });
  const ledgerPath = safeJoin(
    stateRoot,
    "runs",
    runId,
    INCIDENT_RECOVERY_DAG_ADMISSION_LEDGER_FILE
  );
  await assertNoSymlinkUnderReadOnly(stateRoot, ledgerPath);
  const info = await lstat(ledgerPath);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", "durable admission ledger path is unsafe", "UNKNOWN");
  }
  const ledger = validateIncidentRecoveryDagAdmissionLedgerV1(
    JSON.parse(await readFile(ledgerPath, "utf8")),
    { runId, storageScopeDigest }
  );
  const batchId = ledger.authorityIndex[authorityId];
  if (!batchId || !ledger.records[batchId]) {
    fail("EINCIDENT_DAG_RUNTIME_MISSING", "durable DAG admission batch does not exist");
  }
  return assertCommittedIncidentRecoveryDagAdmissionBatchV1(ledger.records[batchId]);
}

async function assertRootIdentitiesUnchanged(roots) {
  for (const [label, identity] of [["stateRoot", roots.state], ["runtimeRoot", roots.runtime]]) {
    let current;
    try {
      current = await canonicalDirectory(identity.path, label, { rejectBroad: label === "stateRoot" });
    } catch (error) {
      fail(
        "EINCIDENT_DAG_RUNTIME_ROOT",
        `${label} identity became unresolved during the runtime handoff: ${error.message}`,
        "UNKNOWN"
      );
    }
    if (!same(current, identity)) {
      fail("EINCIDENT_DAG_RUNTIME_ROOT", `${label} identity changed during the runtime handoff`, "UNKNOWN");
    }
  }
}

function validateChildren(value, batch, plan) {
  const children = assertArray(value, "children").map((child, index) => {
    const label = `children[${index}]`;
    exactKeys(child, ["taskId", "binding", "controller"], label);
    const taskId = assertId(child.taskId, `${label}.taskId`);
    const binding = validateBinding(child.binding, `${label}.binding`);
    if (!isTrustedControllerAdapter(child.controller) || typeof child.controller.readExecutionBinding !== "function") {
      fail("EINCIDENT_DAG_RUNTIME_CONTROLLER", `${label}.controller must be one exact atomic branded controller`);
    }
    return { taskId, binding, controller: child.controller };
  });
  if (new Set(children.map((child) => child.taskId)).size !== children.length ||
      children.some((child, index) => index > 0 && child.taskId < children[index - 1].taskId)) {
    fail("EINCIDENT_DAG_RUNTIME_INPUT", "children must be unique and sorted by taskId");
  }
  if (children.length !== batch.taskIds.length || children.some((child, index) => child.taskId !== batch.taskIds[index])) {
    fail("EINCIDENT_DAG_RUNTIME_BINDING", "children do not exactly cover the committed admission batch");
  }
  const controllerObjects = new Set();
  const controllerIds = new Set();
  const planTasks = new Map(plan.tasks.map((task) => [task.taskId, task]));
  return children.map((child, index) => {
    const admissionEntry = batch.admissions[index];
    const task = planTasks.get(child.taskId);
    if (!task || task.disposition !== "recover" || admissionEntry.taskId !== child.taskId ||
        !same(admissionEntry.binding, child.binding)) {
      fail("EINCIDENT_DAG_RUNTIME_BINDING", `child ${child.taskId} is not exact to the recovery plan and admission batch`);
    }
    if (controllerObjects.has(child.controller) || controllerIds.has(child.controller.controllerId)) {
      fail("EINCIDENT_DAG_RUNTIME_CONTROLLER", "each recovery child requires a distinct branded controller identity");
    }
    controllerObjects.add(child.controller);
    controllerIds.add(child.controller.controllerId);
    return {
      taskId: child.taskId,
      binding: child.binding,
      controller: child.controller,
      admission: admissionEntry.admission,
      priorHandleId: task.runtime?.handleId ?? null
    };
  });
}

function assertPlanAndBatch(planValue, batchValue) {
  let plan;
  let batch;
  try {
    plan = validateIncidentRecoveryDagPlanV1(planValue);
    batch = assertCommittedIncidentRecoveryDagAdmissionBatchV1(batchValue);
  } catch (error) {
    fail("EINCIDENT_DAG_RUNTIME_INPUT", `plan or admission batch is invalid: ${error.message}`, error?.status ?? "HOLD");
  }
  const recoverTaskIds = plan.tasks.filter((task) => task.disposition === "recover").map((task) => task.taskId);
  if (plan.status !== "prepared" || batch.batchId !== batch.authorityId || batch.runId !== plan.workflow.runId ||
      batch.recoveryId !== plan.recoveryId || batch.recoveryPlanDigest !== plan.manifestDigest ||
      !same(batch.taskIds, recoverTaskIds) || batch.effectAuthority.mayCreateHandle !== false ||
      batch.effectAuthority.mayDispatch !== false || batch.effectAuthority.mayPerformEffects !== false) {
    fail("EINCIDENT_DAG_RUNTIME_BINDING", "plan and committed admission batch are not exact or non-effecting");
  }
  return { plan, batch };
}

function mapRuntimeError(error) {
  if (error instanceof IncidentRecoveryDagRuntimeError) return error;
  return new IncidentRecoveryDagRuntimeError(
    error?.code ?? "EINCIDENT_DAG_RUNTIME_HANDOFF",
    error?.message ?? "DAG runtime handoff failed without a stable error",
    error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD",
    error?.details
  );
}

function assertHandoffMatchesAdmissionBatch(handoff, batch, roots) {
  if (handoff.handoffId !== batch.batchId || handoff.runId !== batch.runId ||
      handoff.recoveryId !== batch.recoveryId || handoff.batchDigest !== batch.batchDigest ||
      handoff.recoveryPlanDigest !== batch.recoveryPlanDigest ||
      handoff.authorityDigest !== batch.authorityDigest ||
      handoff.authorityReceiptDigest !== batch.consumptionReceipt.receiptDigest ||
      handoff.admissionStateRootDigest !== roots.admissionStateRootDigest ||
      handoff.admissionStorageScopeDigest !== batch.storageScopeDigest ||
      handoff.runtimeScopeDigest !== roots.runtimeScopeDigest ||
      !same(handoff.taskIds, batch.taskIds) || handoff.entries.length !== batch.admissions.length) {
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", "runtime handoff provenance does not exactly match its committed admission batch", "UNKNOWN");
  }
  for (let index = 0; index < batch.admissions.length; index += 1) {
    const admitted = batch.admissions[index];
    const marker = handoff.entries[index];
    if (marker.taskId !== admitted.taskId ||
        marker.executionId !== admitted.binding.executionId ||
        marker.attemptId !== admitted.binding.attemptId ||
        marker.unitId !== admitted.binding.unitId ||
        marker.ownedResourceId !== admitted.binding.ownedResourceId ||
        marker.bindingDigest !== digestObject(admitted.binding) ||
        marker.admissionDigest !== admitted.admissionDigest ||
        marker.reservationKey !== admitted.reservationKey) {
      fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", `runtime handoff child ${admitted.taskId} is not exact to its committed admission`, "UNKNOWN");
    }
  }
}

function registryHead(value) {
  exactKeys(value, ["sequence", "stateDigest"], "runtime registry head");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", "runtime registry head sequence is invalid", "UNKNOWN");
  }
  assertDigest(value.stateDigest, "runtime registry head stateDigest");
  return clone(value);
}

function publicResult({ plan, batch, roots, runtimeResult }) {
  let handoff;
  try {
    handoff = validateExecutionRecoveryHandoffV1(runtimeResult.handoff, {
      handoffId: batch.batchId,
      runId: plan.workflow.runId,
      recoveryId: plan.recoveryId,
      batchDigest: batch.batchDigest,
      runtimeScopeDigest: roots.runtimeScopeDigest
    });
    assertHandoffMatchesAdmissionBatch(handoff, batch, roots);
  } catch (error) {
    if (error instanceof IncidentRecoveryDagRuntimeError) throw error;
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", `runtime handoff readback is invalid: ${error.message}`, "UNKNOWN");
  }
  if (handoff.recoveryPlanDigest !== plan.manifestDigest ||
      runtimeResult.handles.some((handle) => handle.dispatchBlocked !== true || handle.status !== "ready") ||
      !same(runtimeResult.effectAuthority, { mayDispatch: false, mayPerformEffects: false }) ||
      Object.values(EFFECT_AUTHORITY).some((value) => value !== false)) {
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", "runtime handoff readback is not exact and non-effecting", "UNKNOWN");
  }
  return freezeDeep({
    schemaVersion: INCIDENT_RECOVERY_DAG_RUNTIME_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_DAG_RUNTIME_KIND,
    status: "committed",
    plan: clone(plan),
    batch: clone(batch),
    handoff: clone(handoff),
    handles: clone(runtimeResult.handles),
    recoveryPlans: clone(runtimeResult.recoveryPlans),
    registryHead: registryHead(runtimeResult.registryHead),
    journalReadback: clone(runtimeResult.journalReadback),
    rootBinding: {
      stateRoot: clone(roots.state),
      runtimeRoot: clone(roots.runtime),
      admissionStateRootDigest: roots.admissionStateRootDigest,
      runtimeScopeDigest: roots.runtimeScopeDigest
    },
    effectAuthority: clone(EFFECT_AUTHORITY)
  });
}

async function readExactRecoveryRuntimeContext({ stateRoot, runId, handoffId, controller }) {
  if (!isTrustedControllerAdapter(controller)) {
    fail("EINCIDENT_DAG_RUNTIME_CONTROLLER", "recovery authority requires one exact branded controller");
  }
  const roots = await canonicalRuntimeRoots(stateRoot, runId);
  const batch = await readCommittedAdmissionBatchReadOnly(roots.state.path, runId, handoffId)
    .catch((error) => { throw mapRuntimeError(error); });
  let runtimeResult;
  try {
    runtimeResult = await readExecutionRecoveryHandoffV1({
      stateRoot: roots.state.path,
      registryRoot: roots.runtime.path,
      runId,
      handoffId,
      controller
    });
  } catch (error) {
    throw mapRuntimeError(error);
  }
  let handoff;
  try {
    handoff = validateExecutionRecoveryHandoffV1(runtimeResult.handoff, {
      handoffId,
      runId,
      batchDigest: batch.batchDigest,
      runtimeScopeDigest: roots.runtimeScopeDigest
    });
    assertHandoffMatchesAdmissionBatch(handoff, batch, roots);
  } catch (error) {
    if (error instanceof IncidentRecoveryDagRuntimeError) throw error;
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", `durable runtime handoff is invalid: ${error.message}`, "UNKNOWN");
  }
  await assertRootIdentitiesUnchanged(roots);
  return { roots, batch, handoff };
}

export async function commitIncidentRecoveryDagRuntimeHandoffV1(options = {}) {
  const optionsLabel = "commitIncidentRecoveryDagRuntimeHandoffV1 options";
  assertPlainObject(options, optionsLabel);
  exactKeys(
    options,
    Object.hasOwn(options, "clock")
      ? ["stateRoot", "plan", "batch", "children", "clock"]
      : ["stateRoot", "plan", "batch", "children"],
    optionsLabel
  );
  const { plan, batch } = assertPlanAndBatch(options.plan, options.batch);
  const children = validateChildren(options.children, batch, plan);
  const roots = await canonicalRuntimeRoots(options.stateRoot, plan.workflow.runId);
  let durableBatch;
  try {
    durableBatch = await readCommittedIncidentRecoveryDagAdmissionBatchV1({
      stateRoot: roots.state.path,
      runId: batch.runId,
      authorityId: batch.authorityId
    });
  } catch (error) {
    throw mapRuntimeError(error);
  }
  if (!same(durableBatch, batch)) {
    fail("EINCIDENT_DAG_RUNTIME_BINDING", "caller admission batch differs from the canonical durable batch");
  }
  const registry = await openExecutionRegistry({
    stateRoot: roots.state.path,
    registryRoot: roots.runtime.path,
    runId: plan.workflow.runId,
    controller: children[0].controller,
    ...(options.clock === undefined ? {} : { clock: options.clock })
  }).catch((error) => { throw mapRuntimeError(error); });
  await assertRootIdentitiesUnchanged(roots);
  let runtimeResult;
  try {
    runtimeResult = await registry.commitRecoveryHandoffBatch({
      seed: {
        handoffId: batch.batchId,
        recoveryId: plan.recoveryId,
        batchDigest: batch.batchDigest,
        recoveryPlanDigest: plan.manifestDigest,
        authorityDigest: batch.authorityDigest,
        authorityReceiptDigest: batch.consumptionReceipt.receiptDigest,
        admissionStateRootDigest: roots.admissionStateRootDigest,
        admissionStorageScopeDigest: batch.storageScopeDigest,
        runtimeScopeDigest: roots.runtimeScopeDigest,
        sourceRegistrySequence: plan.registry.sequence,
        sourceRegistryStateDigest: plan.registry.stateDigest
      },
      children
    });
  } catch (error) {
    throw mapRuntimeError(error);
  }
  await assertRootIdentitiesUnchanged(roots);
  return publicResult({ plan, batch, roots, runtimeResult });
}

export async function claimIncidentRecoveryDagRuntimeHandoffV1(options = {}) {
  const label = "claimIncidentRecoveryDagRuntimeHandoffV1 options";
  assertPlainObject(options, label);
  exactKeys(
    options,
    Object.hasOwn(options, "clock")
      ? ["stateRoot", "runId", "handoffId", "controller", "checkpoint", "clock"]
      : ["stateRoot", "runId", "handoffId", "controller", "checkpoint"],
    label
  );
  const runId = assertId(options.runId, `${label}.runId`);
  const handoffId = assertId(options.handoffId, `${label}.handoffId`);
  const { roots, batch, handoff } = await readExactRecoveryRuntimeContext({
    stateRoot: options.stateRoot,
    runId,
    handoffId,
    controller: options.controller
  });
  let runtimeResult;
  try {
    const registry = await openExecutionRegistry({
      stateRoot: roots.state.path,
      registryRoot: roots.runtime.path,
      runId,
      controller: options.controller,
      ...(options.clock === undefined ? {} : { clock: options.clock })
    });
    runtimeResult = await registry.claimRecoveryHandoff({
      handoffId,
      checkpoint: options.checkpoint
    });
  } catch (error) {
    throw mapRuntimeError(error);
  }
  let claim;
  try {
    claim = validateExecutionRecoveryHandoffClaimV1(runtimeResult.claim, {
      runId,
      handoffId,
      handoffDigest: handoff.handoffDigest
    });
  } catch (error) {
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", `runtime recovery claim readback is invalid: ${error.message}`, "UNKNOWN");
  }
  if (claim.recoveryPlanDigest !== batch.recoveryPlanDigest || !same(claim.taskIds, batch.taskIds) ||
      !same(runtimeResult.effectAuthority, RECOVERY_AUTHORITY)) {
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", "runtime recovery claim is not exact and non-effecting", "UNKNOWN");
  }
  await assertRootIdentitiesUnchanged(roots);
  return freezeDeep({
    schemaVersion: INCIDENT_RECOVERY_DAG_RUNTIME_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_DAG_RUNTIME_CLAIM_KIND,
    status: "claimed",
    handoff: clone(handoff),
    claim: clone(claim),
    registryHead: registryHead(runtimeResult.registryHead),
    journalReadback: clone(runtimeResult.journalReadback),
    rootBinding: {
      stateRoot: clone(roots.state),
      runtimeRoot: clone(roots.runtime),
      admissionStateRootDigest: roots.admissionStateRootDigest,
      runtimeScopeDigest: roots.runtimeScopeDigest
    },
    effectAuthority: clone(RECOVERY_AUTHORITY)
  });
}

export async function authorizeIncidentRecoveryDagRuntimeTaskReleaseV1(options = {}) {
  const label = "authorizeIncidentRecoveryDagRuntimeTaskReleaseV1 options";
  assertPlainObject(options, label);
  exactKeys(
    options,
    Object.hasOwn(options, "clock")
      ? ["stateRoot", "runId", "handoffId", "claimId", "taskId", "controller", "checkpoint", "clock"]
      : ["stateRoot", "runId", "handoffId", "claimId", "taskId", "controller", "checkpoint"],
    label
  );
  const runId = assertId(options.runId, `${label}.runId`);
  const handoffId = assertId(options.handoffId, `${label}.handoffId`);
  const claimId = assertId(options.claimId, `${label}.claimId`);
  const taskId = assertId(options.taskId, `${label}.taskId`);
  const { roots, handoff } = await readExactRecoveryRuntimeContext({
    stateRoot: options.stateRoot,
    runId,
    handoffId,
    controller: options.controller
  });
  let runtimeResult;
  try {
    const registry = await openExecutionRegistry({
      stateRoot: roots.state.path,
      registryRoot: roots.runtime.path,
      runId,
      controller: options.controller,
      ...(options.clock === undefined ? {} : { clock: options.clock })
    });
    runtimeResult = await registry.authorizeRecoveryHandoffTaskRelease({
      handoffId,
      claimId,
      taskId,
      checkpoint: options.checkpoint
    });
  } catch (error) {
    throw mapRuntimeError(error);
  }
  let release;
  try {
    release = validateExecutionRecoveryTaskReleaseV1(runtimeResult.release, {
      runId,
      handoffId,
      claimId,
      taskId
    });
  } catch (error) {
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", `runtime task release readback is invalid: ${error.message}`, "UNKNOWN");
  }
  if (release.handoffDigest !== handoff.handoffDigest || !same(runtimeResult.effectAuthority, RECOVERY_AUTHORITY)) {
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", "runtime task release is not exact and non-effecting", "UNKNOWN");
  }
  await assertRootIdentitiesUnchanged(roots);
  return freezeDeep({
    schemaVersion: INCIDENT_RECOVERY_DAG_RUNTIME_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_DAG_RUNTIME_TASK_RELEASE_KIND,
    status: "authorized",
    handoff: clone(handoff),
    release: clone(release),
    registryHead: registryHead(runtimeResult.registryHead),
    journalReadback: clone(runtimeResult.journalReadback),
    rootBinding: {
      stateRoot: clone(roots.state),
      runtimeRoot: clone(roots.runtime),
      admissionStateRootDigest: roots.admissionStateRootDigest,
      runtimeScopeDigest: roots.runtimeScopeDigest
    },
    effectAuthority: clone(RECOVERY_AUTHORITY)
  });
}

export async function consumeIncidentRecoveryDagRuntimeTaskReleaseV1(options = {}) {
  const label = "consumeIncidentRecoveryDagRuntimeTaskReleaseV1 options";
  assertPlainObject(options, label);
  exactKeys(
    options,
    Object.hasOwn(options, "clock")
      ? ["stateRoot", "runId", "handoffId", "claimId", "releaseId", "taskId", "controller", "clock"]
      : ["stateRoot", "runId", "handoffId", "claimId", "releaseId", "taskId", "controller"],
    label
  );
  const runId = assertId(options.runId, `${label}.runId`);
  const handoffId = assertId(options.handoffId, `${label}.handoffId`);
  const claimId = assertId(options.claimId, `${label}.claimId`);
  const releaseId = assertId(options.releaseId, `${label}.releaseId`);
  const taskId = assertId(options.taskId, `${label}.taskId`);
  const { roots, handoff } = await readExactRecoveryRuntimeContext({
    stateRoot: options.stateRoot,
    runId,
    handoffId,
    controller: options.controller
  });
  let runtimeResult;
  try {
    const registry = await openExecutionRegistry({
      stateRoot: roots.state.path,
      registryRoot: roots.runtime.path,
      runId,
      controller: options.controller,
      ...(options.clock === undefined ? {} : { clock: options.clock })
    });
    runtimeResult = await registry.consumeRecoveryHandoffTaskRelease({
      handoffId,
      claimId,
      releaseId,
      taskId
    });
  } catch (error) {
    throw mapRuntimeError(error);
  }
  let consumption;
  try {
    consumption = validateExecutionRecoveryTaskPermitConsumptionV1(runtimeResult.consumption, {
      runId,
      handoffId,
      claimId,
      releaseId,
      taskId
    });
  } catch (error) {
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", `runtime task consumption readback is invalid: ${error.message}`, "UNKNOWN");
  }
  if (consumption.handoffDigest !== handoff.handoffDigest ||
      !same(runtimeResult.effectAuthority, RECOVERY_AUTHORITY)) {
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", "runtime task consumption is not exact and non-effecting", "UNKNOWN");
  }
  await assertRootIdentitiesUnchanged(roots);
  return freezeDeep({
    schemaVersion: INCIDENT_RECOVERY_DAG_RUNTIME_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_DAG_RUNTIME_TASK_CONSUMPTION_KIND,
    status: "consumed",
    handoff: clone(handoff),
    consumption: clone(consumption),
    registryHead: registryHead(runtimeResult.registryHead),
    journalReadback: clone(runtimeResult.journalReadback),
    rootBinding: {
      stateRoot: clone(roots.state),
      runtimeRoot: clone(roots.runtime),
      admissionStateRootDigest: roots.admissionStateRootDigest,
      runtimeScopeDigest: roots.runtimeScopeDigest
    },
    effectAuthority: clone(RECOVERY_AUTHORITY)
  });
}

function recoveryTaskEffectIntentPublicResult({ roots, handoff, runtimeResult, status, expected = {} }) {
  let intent;
  try {
    intent = validateExecutionRecoveryTaskEffectIntentV1(runtimeResult.intent, {
      runId: handoff.runId,
      handoffId: handoff.handoffId,
      status,
      ...expected
    });
  } catch (error) {
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", `runtime task effect intent readback is invalid: ${error.message}`, "UNKNOWN");
  }
  if (intent.handoffDigest !== handoff.handoffDigest ||
      !same(runtimeResult.effectAuthority, RECOVERY_AUTHORITY)) {
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", "runtime task effect intent is not exact and non-effecting", "UNKNOWN");
  }
  return freezeDeep({
    schemaVersion: INCIDENT_RECOVERY_DAG_RUNTIME_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_DAG_RUNTIME_TASK_EFFECT_INTENT_KIND,
    status,
    handoff: clone(handoff),
    intent: clone(intent),
    registryHead: registryHead(runtimeResult.registryHead),
    journalReadback: clone(runtimeResult.journalReadback),
    rootBinding: {
      stateRoot: clone(roots.state),
      runtimeRoot: clone(roots.runtime),
      admissionStateRootDigest: roots.admissionStateRootDigest,
      runtimeScopeDigest: roots.runtimeScopeDigest
    },
    effectAuthority: clone(RECOVERY_AUTHORITY)
  });
}

async function mutateIncidentRecoveryDagRuntimeTaskEffectIntent({
  options,
  handoffId,
  method,
  request,
  status,
  expected
}) {
  const runId = assertId(options.runId, `${method}.runId`);
  const context = await readExactRecoveryRuntimeContext({
    stateRoot: options.stateRoot,
    runId,
    handoffId,
    controller: options.controller
  });
  let runtimeResult;
  try {
    const registry = await openExecutionRegistry({
      stateRoot: context.roots.state.path,
      registryRoot: context.roots.runtime.path,
      runId,
      controller: options.controller,
      ...(options.clock === undefined ? {} : { clock: options.clock })
    });
    runtimeResult = await registry[method](request);
  } catch (error) {
    throw mapRuntimeError(error);
  }
  const resultStatus = status ?? runtimeResult.intent?.status;
  const result = recoveryTaskEffectIntentPublicResult({
    roots: context.roots,
    handoff: context.handoff,
    runtimeResult,
    status: resultStatus,
    expected
  });
  await assertRootIdentitiesUnchanged(context.roots);
  return result;
}

/** Journal-only intent creation; the exact recovery handle remains blocked. */
export async function createIncidentRecoveryDagRuntimeTaskEffectIntentV1(options = {}) {
  const label = "createIncidentRecoveryDagRuntimeTaskEffectIntentV1 options";
  assertPlainObject(options, label);
  exactKeys(
    options,
    Object.hasOwn(options, "clock")
      ? ["stateRoot", "runId", "handoffId", "consumptionId", "taskId", "handleId", "controller", "clock"]
      : ["stateRoot", "runId", "handoffId", "consumptionId", "taskId", "handleId", "controller"],
    label
  );
  const handoffId = assertId(options.handoffId, `${label}.handoffId`);
  const consumptionId = assertId(options.consumptionId, `${label}.consumptionId`);
  const taskId = assertId(options.taskId, `${label}.taskId`);
  const handleId = assertId(options.handleId, `${label}.handleId`);
  return mutateIncidentRecoveryDagRuntimeTaskEffectIntent({
    options,
    handoffId,
    method: "createRecoveryTaskEffectIntent",
    request: { consumptionId, taskId, handleId },
    status: null,
    expected: { consumptionId, taskId, handleId }
  });
}

/** Journal-only dispatch reservation; it is not dispatch or effect authority. */
export async function reserveIncidentRecoveryDagRuntimeTaskEffectIntentV1(options = {}) {
  const label = "reserveIncidentRecoveryDagRuntimeTaskEffectIntentV1 options";
  assertPlainObject(options, label);
  exactKeys(
    options,
    Object.hasOwn(options, "clock")
      ? ["stateRoot", "runId", "handoffId", "intentId", "controller", "clock"]
      : ["stateRoot", "runId", "handoffId", "intentId", "controller"],
    label
  );
  const handoffId = assertId(options.handoffId, `${label}.handoffId`);
  const intentId = assertId(options.intentId, `${label}.intentId`);
  return mutateIncidentRecoveryDagRuntimeTaskEffectIntent({
    options,
    handoffId,
    method: "reserveRecoveryTaskEffectIntent",
    request: { intentId },
    status: "dispatch-reserved",
    expected: { intentId }
  });
}

/** Records an exact pre-effect not-sent terminal transition without unblocking. */
export async function recordIncidentRecoveryDagRuntimeTaskEffectNotSentV1(options = {}) {
  const label = "recordIncidentRecoveryDagRuntimeTaskEffectNotSentV1 options";
  assertPlainObject(options, label);
  exactKeys(
    options,
    Object.hasOwn(options, "clock")
      ? ["stateRoot", "runId", "handoffId", "intentId", "reason", "controller", "clock"]
      : ["stateRoot", "runId", "handoffId", "intentId", "reason", "controller"],
    label
  );
  const handoffId = assertId(options.handoffId, `${label}.handoffId`);
  const intentId = assertId(options.intentId, `${label}.intentId`);
  const reason = assertId(options.reason, `${label}.reason`);
  return mutateIncidentRecoveryDagRuntimeTaskEffectIntent({
    options,
    handoffId,
    method: "recordRecoveryTaskEffectNotSent",
    request: { intentId, reason },
    status: "not-sent",
    expected: { intentId }
  });
}

/** Records ambiguity without invoking a provider, effect callback, or reconciler. */
export async function recordIncidentRecoveryDagRuntimeTaskEffectUnknownV1(options = {}) {
  const label = "recordIncidentRecoveryDagRuntimeTaskEffectUnknownV1 options";
  assertPlainObject(options, label);
  exactKeys(
    options,
    Object.hasOwn(options, "clock")
      ? ["stateRoot", "runId", "handoffId", "intentId", "reason", "controller", "clock"]
      : ["stateRoot", "runId", "handoffId", "intentId", "reason", "controller"],
    label
  );
  const handoffId = assertId(options.handoffId, `${label}.handoffId`);
  const intentId = assertId(options.intentId, `${label}.intentId`);
  const reason = assertId(options.reason, `${label}.reason`);
  return mutateIncidentRecoveryDagRuntimeTaskEffectIntent({
    options,
    handoffId,
    method: "recordRecoveryTaskEffectUnknown",
    request: { intentId, reason },
    status: "unknown",
    expected: { intentId }
  });
}

/** Observation-only durable task effect-intent read. */
export async function readIncidentRecoveryDagRuntimeTaskEffectIntentV1(options = {}) {
  const label = "readIncidentRecoveryDagRuntimeTaskEffectIntentV1 options";
  assertPlainObject(options, label);
  exactKeys(options, ["stateRoot", "runId", "handoffId", "intentId", "controller"], label);
  const runId = assertId(options.runId, `${label}.runId`);
  const handoffId = assertId(options.handoffId, `${label}.handoffId`);
  const intentId = assertId(options.intentId, `${label}.intentId`);
  const context = await readExactRecoveryRuntimeContext({
    stateRoot: options.stateRoot,
    runId,
    handoffId,
    controller: options.controller
  });
  let runtimeResult;
  try {
    runtimeResult = await readExecutionRecoveryTaskEffectIntentV1({
      stateRoot: context.roots.state.path,
      registryRoot: context.roots.runtime.path,
      runId,
      controller: options.controller,
      intentId
    });
  } catch (error) {
    throw mapRuntimeError(error);
  }
  const result = recoveryTaskEffectIntentPublicResult({
    roots: context.roots,
    handoff: context.handoff,
    runtimeResult,
    status: runtimeResult.intent?.status,
    expected: { intentId }
  });
  await assertRootIdentitiesUnchanged(context.roots);
  return result;
}

export async function readIncidentRecoveryDagRuntimeHandoffV1(options = {}) {
  exactKeys(options, ["stateRoot", "runId", "handoffId", "controller"], "readIncidentRecoveryDagRuntimeHandoffV1 options");
  const runId = assertId(options.runId, "runId");
  const handoffId = assertId(options.handoffId, "handoffId");
  if (!isTrustedControllerAdapter(options.controller)) {
    fail("EINCIDENT_DAG_RUNTIME_CONTROLLER", "read requires one exact branded controller");
  }
  const roots = await canonicalRuntimeRoots(options.stateRoot, runId);
  const batch = await readCommittedAdmissionBatchReadOnly(roots.state.path, runId, handoffId)
    .catch((error) => { throw mapRuntimeError(error); });
  let result;
  try {
    result = await readExecutionRecoveryHandoffV1({
      stateRoot: roots.state.path,
      registryRoot: roots.runtime.path,
      runId,
      handoffId,
      controller: options.controller
    });
  } catch (error) {
    throw mapRuntimeError(error);
  }
  let handoff;
  try {
    handoff = validateExecutionRecoveryHandoffV1(result.handoff, {
      handoffId,
      runId,
      batchDigest: batch.batchDigest,
      runtimeScopeDigest: roots.runtimeScopeDigest
    });
    assertHandoffMatchesAdmissionBatch(handoff, batch, roots);
  } catch (error) {
    if (error instanceof IncidentRecoveryDagRuntimeError) throw error;
    fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", `durable runtime handoff is invalid: ${error.message}`, "UNKNOWN");
  }
  await assertRootIdentitiesUnchanged(roots);
  return freezeDeep({
    handoff: clone(handoff),
    handles: clone(result.handles),
    recoveryPlans: clone(result.recoveryPlans),
    registryHead: registryHead(result.registryHead),
    journalReadback: clone(result.journalReadback),
    rootBinding: {
      stateRoot: clone(roots.state),
      runtimeRoot: clone(roots.runtime),
      admissionStateRootDigest: roots.admissionStateRootDigest,
      runtimeScopeDigest: roots.runtimeScopeDigest
    },
    effectAuthority: clone(EFFECT_AUTHORITY)
  });
}

export async function withIncidentRecoveryDagRuntimeHandoffReadLeaseV1(options = {}, callback) {
  exactKeys(
    options,
    ["stateRoot", "runId", "handoffId", "controller"],
    "withIncidentRecoveryDagRuntimeHandoffReadLeaseV1 options"
  );
  if (typeof callback !== "function") {
    fail("EINCIDENT_DAG_RUNTIME_INPUT", "runtime handoff read-lease callback must be callable");
  }
  const runId = assertId(options.runId, "runId");
  const handoffId = assertId(options.handoffId, "handoffId");
  if (!isTrustedControllerAdapter(options.controller)) {
    fail("EINCIDENT_DAG_RUNTIME_CONTROLLER", "read lease requires one exact branded controller");
  }
  const roots = await canonicalRuntimeRoots(options.stateRoot, runId);
  const batch = await readCommittedAdmissionBatchReadOnly(roots.state.path, runId, handoffId)
    .catch((error) => { throw mapRuntimeError(error); });
  let callbackStarted = false;
  try {
    return await withExecutionRecoveryHandoffReadLeaseV1({
      stateRoot: roots.state.path,
      registryRoot: roots.runtime.path,
      runId,
      handoffId,
      controller: options.controller
    }, async (result) => {
      let handoff;
      try {
        handoff = validateExecutionRecoveryHandoffV1(result.handoff, {
          handoffId,
          runId,
          batchDigest: batch.batchDigest,
          runtimeScopeDigest: roots.runtimeScopeDigest
        });
        assertHandoffMatchesAdmissionBatch(handoff, batch, roots);
      } catch (error) {
        if (error instanceof IncidentRecoveryDagRuntimeError) throw error;
        fail("EINCIDENT_DAG_RUNTIME_UNKNOWN", `durable runtime handoff is invalid: ${error.message}`, "UNKNOWN");
      }
      await assertRootIdentitiesUnchanged(roots);
      const readback = freezeDeep({
        handoff: clone(handoff),
        handles: clone(result.handles),
        recoveryPlans: clone(result.recoveryPlans),
        registryHead: registryHead(result.registryHead),
        journalReadback: clone(result.journalReadback),
        rootBinding: {
          stateRoot: clone(roots.state),
          runtimeRoot: clone(roots.runtime),
          admissionStateRootDigest: roots.admissionStateRootDigest,
          runtimeScopeDigest: roots.runtimeScopeDigest
        },
        effectAuthority: clone(EFFECT_AUTHORITY)
      });
      callbackStarted = true;
      return callback(readback);
    });
  } catch (error) {
    if (callbackStarted || error instanceof IncidentRecoveryDagRuntimeError) throw error;
    throw mapRuntimeError(error);
  }
}
