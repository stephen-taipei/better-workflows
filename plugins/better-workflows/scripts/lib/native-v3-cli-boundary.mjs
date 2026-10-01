import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { assertNoSymlinkUnder, canonicalJson, digestObject, ensurePrivateDir } from "./core.mjs";
import { captureSourceBinding } from "./git.mjs";
import { assertNativeV3AutoCommandExecutionAllowed } from "./native-v3-auto-execution-admission.mjs";
import { assertPrivateStateBackendAvailableV1 } from "./private-state-backend-v1.mjs";
import {
  digestApprovalEnvelope,
  validateApprovalEnvelope
} from "./execution-admission-v1.mjs";
import {
  bindNativeCommandToApprovalEnvelope,
  createNativeCommandBinding,
  NATIVE_COMMAND_MAX_BINDING_BYTES,
  assertNativeCommandBindingMatchesApprovalEnvelope,
  readFreshNativeCommandBinding
} from "./native-command-binding-v1.mjs";
import {
  collectCooperativeNativeV3OwnerDecision,
  nativeV3AllocationKeyFor,
  prepareCooperativeNativeV3Approval
} from "./native-v3-cooperative-controller.mjs";
import {
  createNativeV3CommandRunner,
  requestNativeV3PreparedCommandStop,
  readNativeV3CommandSettlementObservation,
  isNativeV3CommandSettlementEffectNotSent,
  NATIVE_V3_COMMAND_RUNNER_TRUST_MODE
} from "./native-v3-command-runner.mjs";
import {
  createNativeV3PlanRunner,
  createNativeV3PlanTaskAdapterFromCommandRunner,
  createNativeV3PlanTaskAdapterFromCommandRunners
} from "./native-v3-plan-runner.mjs";
import { createNativeV3TrustPolicyReader } from "./native-v3-trust-policy.mjs";
import { readFreshWorkflowPlanV1 } from "./workflow-plan-v1.mjs";
import { validateNativeV3PlanRunnerCheckpointV1 } from "./native-v3-plan-runner-core.mjs";

const PREPARED_CLEANUP_WAIT_MS = 10_000;

// One observer for the exact references returned to this constructor. All
// requests precede observation; timeout/UNKNOWN is sticky for this observer.
function createPreparedCommandCleanup(runners, readScheduler, plan, runId) {
  let observation = null;
  return () => {
    if (observation !== null) return observation;
    let resolveObservation;
    observation = new Promise(resolve => { resolveObservation = resolve; });
    const cells = runners.map(runner => ({ runner, state: "pending", receipt: null, error: null }));
    const scheduler = readScheduler();
    if (scheduler !== null) cells.push({ scheduler, state: "pending", receipt: null, error: null });
    const deadline = performance.now() + PREPARED_CLEANUP_WAIT_MS;
    let finished = false;
    const unknown = message => fail("ENATIVE_V3_CLI_CLEANUP_UNKNOWN", message, "UNKNOWN");
    const failed = (cell, cause) => {
      if (finished) return;
      cell.state = "failed";
      cell.error = unknown("Prepared cleanup request or observation failed");
      cell.error.cause = cause;
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveObservation(Object.freeze({
        failures: Object.freeze(cells.filter(cell => cell.state !== "confirmed").map(cell =>
          cell.state === "failed" ? cell.error : unknown("Prepared cleanup exceeded its shared observation deadline"))),
        receipts: Object.freeze(cells.map(cell => cell.state === "confirmed" ? cell.receipt : null))
      }));
    };
    const timer = setTimeout(finish, PREPARED_CLEANUP_WAIT_MS);
    // Dispatch every owned request before assimilating any returned value.
    // Even a hostile Promise getter cannot suppress another legal request.
    for (const cell of cells) {
      try {
        // Factory-owned stop installs its memo/latch synchronously. A claimed
        // allocation is not eligible for this prepared cleanup route.
        cell.actual = cell.runner
          ? requestNativeV3PreparedCommandStop(cell.runner)
          : cell.scheduler.cancel({ reason: "cancel" });
      } catch (error) {
        failed(cell, error);
      }
    }
    const pending = cells.filter(cell => cell.state === "pending").map(async cell => {
      try {
        let value = await cell.actual;
        if (cell.scheduler) {
          const checkpoint = validateNativeV3PlanRunnerCheckpointV1(value, plan);
          if (checkpoint.runId !== runId || checkpoint.status !== "cancelled" ||
              checkpoint.cancelRequested !== true || checkpoint.cancelReason !== "cancel" ||
              checkpoint.dispatchBlocked !== true || checkpoint.reconcileRequired !== false || checkpoint.failure !== null ||
              Object.values(checkpoint.tasks).some(task => ["pending", "preparing", "dispatching", "unknown"].includes(task.status) ||
                task.outcome === "unknown" || task.lastError?.status === "UNKNOWN")) {
            throw unknown("Scheduler cancellation did not return an exact confirmed terminal checkpoint");
          }
          value = checkpoint;
        }
        if (!finished && performance.now() <= deadline) {
          cell.state = "confirmed";
          cell.receipt = value;
        }
      } catch (error) {
        failed(cell, error);
      }
    });
    // Keep handlers attached after timeout; late settlement cannot rewrite
    // the observation or trigger another stop/cancel request.
    Promise.all(pending).then(finish, finish);
    return observation;
  };
}

/**
 * The post-approved CLI boundary is the narrow adapter between persisted,
 * human-selected artifacts and the native V3 runner.  Its reader and boundary
 * exports deliberately do not prepare an allocation, approve an envelope, or
 * accept caller-owned authority inputs.  The explicit interactive export below
 * is the separate same-process preparation and TTY decision path.
 */
export const NATIVE_V3_CLI_BOUNDARY_SCHEMA_VERSION = 1;
export const NATIVE_V3_CLI_BOUNDARY_KIND = "NativeV3CliBoundaryV1";
export const NATIVE_V3_CLI_ARTIFACTS_KIND = "NativeV3CliArtifactsV1";
export const NATIVE_V3_CLI_INTERACTIVE_KIND = "NativeV3InteractiveCliRunV1";
export const NATIVE_V3_CLI_PLAN_INTERACTIVE_KIND = "NativeV3InteractiveCliPlanRunV1";
export const NATIVE_V3_CLI_MAX_ARTIFACT_BYTES = NATIVE_COMMAND_MAX_BINDING_BYTES;

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const OPTION_KEYS = new Set([
  "root",
  "planId",
  "bindingPath",
  "approvalPath",
  "expectedCommandDigest"
]);
const INTERACTIVE_OPTION_KEYS = new Set([
  "root",
  "planId",
  "runId",
  "executionId",
  "attemptId",
  "bindingPath",
  "approvalPath",
  "commandBinding",
  "requestedModel",
  "expiresAt",
  "ownerAbortSignal"
]);
const PLAN_INTERACTIVE_OPTION_KEYS = new Set([
  "root",
  "planId",
  "runId",
  "commandBindings",
  "parallelism",
  "ownerAbortSignal"
]);
const SOURCE_REQUEST_KEYS = new Set(["runId", "planId", "expected", "observedAt"]);

export class NativeV3CliBoundaryError extends Error {
  constructor(code, message, status = "HOLD") {
    super(message);
    this.name = "NativeV3CliBoundaryError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = "HOLD") {
  return new NativeV3CliBoundaryError(code, message, status);
}

function plain(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("ENATIVE_V3_CLI_INPUT", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw fail("ENATIVE_V3_CLI_INPUT", `${label} must be a plain object`);
  }
  return value;
}

function exactOptions(value, allowed, label) {
  plain(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw fail("ENATIVE_V3_CLI_INPUT", `${label} contains unknown option(s): ${unknown.join(", ")}`);
  }
}

function text(value, label, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw fail("ENATIVE_V3_CLI_INPUT", `${label} is invalid`);
  }
  if (pattern && !pattern.test(value)) throw fail("ENATIVE_V3_CLI_INPUT", `${label} is invalid`);
  return value;
}

function absolutePath(value, label) {
  const supplied = text(value, label);
  if (!path.isAbsolute(supplied)) throw fail("ENATIVE_V3_CLI_INPUT", `${label} must be absolute`);
  return path.resolve(supplied);
}

function identifier(value, label) {
  return text(value, label, ID);
}

function digest(value, label) {
  return text(value, label, DIGEST);
}

function abortSignal(value, label) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function" || typeof value.removeEventListener !== "function") {
    throw fail("ENATIVE_V3_CLI_INPUT", `${label} must be an AbortSignal`);
  }
  return value;
}

function throwIfAborted(signal, message = "Native V3 interactive owner approval was cancelled") {
  if (signal?.aborted) throw fail("EOWNER_INTERACTION_CANCELLED", message);
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function holdFrom(error, fallbackCode, prefix) {
  if (error instanceof NativeV3CliBoundaryError) return error;
  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : fallbackCode;
  const wrapped = fail(code, `${prefix}: ${error?.message ?? String(error)}`, error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD");
  wrapped.cause = error;
  return wrapped;
}

function pathInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function stateRelativePath(root, supplied, label) {
  const value = text(supplied, label);
  if (path.isAbsolute(value)) throw fail("ENATIVE_V3_CLI_PATH", `${label} must be relative to the state root`);
  const normalized = path.normalize(value);
  if (value !== normalized || normalized === "." || normalized.startsWith(`..${path.sep}`) || normalized === "..") {
    throw fail("ENATIVE_V3_CLI_PATH", `${label} must be a canonical state-relative path`);
  }
  const target = path.resolve(root, value);
  if (!pathInside(root, target)) throw fail("ENATIVE_V3_CLI_PATH", `${label} escapes the state root`);
  return target;
}

function fileSnapshot(info) {
  return ["dev", "ino", "mode", "nlink", "size", "mtimeMs", "ctimeMs"]
    .map((key) => info?.[key]);
}

function sameFileSnapshot(left, right) {
  return JSON.stringify(fileSnapshot(left)) === JSON.stringify(fileSnapshot(right));
}

async function privateStateRoot(root) {
  assertPrivateStateBackendAvailableV1();
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_CLI_STATE", "State root is unavailable");
  }
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw fail("ENATIVE_V3_CLI_STATE", "State root must be a private regular directory");
  }
  return info;
}

async function privateArtifactPath(root, target, label) {
  let current = root;
  const relative = path.relative(root, target);
  const components = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      throw holdFrom(error, "ENATIVE_V3_CLI_ARTIFACT_MISSING", `${label} is unavailable`);
    }
    if (info.isSymbolicLink()) throw fail("ENATIVE_V3_CLI_ARTIFACT_UNSAFE", `${label} contains a symlink`);
    if (index < components.length - 1) {
      if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
        throw fail("ENATIVE_V3_CLI_ARTIFACT_UNSAFE", `${label} contains an unsafe directory`);
      }
    }
  }
  const info = await lstat(target).catch((error) => {
    throw holdFrom(error, "ENATIVE_V3_CLI_ARTIFACT_MISSING", `${label} is unavailable`);
  });
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
    throw fail("ENATIVE_V3_CLI_ARTIFACT_UNSAFE", `${label} must be a private regular file`);
  }
  if (!Number.isSafeInteger(info.size) || info.size > NATIVE_V3_CLI_MAX_ARTIFACT_BYTES) {
    throw fail("ENATIVE_V3_CLI_ARTIFACT_OVERSIZE", `${label} exceeds the bounded size limit`);
  }
  return info;
}

async function readBoundedPrivateJson(root, target, label) {
  await privateStateRoot(root);
  const beforePath = await privateArtifactPath(root, target, label);
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const beforeHandle = await handle.stat();
    if (beforeHandle.isSymbolicLink?.() || !beforeHandle.isFile() || beforeHandle.nlink !== 1 ||
        (beforeHandle.mode & 0o077) !== 0 || !sameFileSnapshot(beforePath, beforeHandle)) {
      throw fail("ENATIVE_V3_CLI_ARTIFACT_DRIFT", `${label} changed before it was read`);
    }
    const buffer = Buffer.alloc(NATIVE_V3_CLI_MAX_ARTIFACT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read({
        buffer,
        offset: length,
        length: buffer.length - length,
        position: length
      });
      if (!Number.isInteger(result?.bytesRead) || result.bytesRead < 0 || result.bytesRead > buffer.length - length) {
        throw fail("ENATIVE_V3_CLI_ARTIFACT_READ", `${label} returned an invalid bounded read`);
      }
      length += result.bytesRead;
      if (result.bytesRead === 0) break;
    }
    if (length > NATIVE_V3_CLI_MAX_ARTIFACT_BYTES) {
      throw fail("ENATIVE_V3_CLI_ARTIFACT_OVERSIZE", `${label} exceeds the bounded size limit`);
    }
    const afterHandle = await handle.stat();
    if (length !== afterHandle.size) {
      throw fail("ENATIVE_V3_CLI_ARTIFACT_DRIFT", `${label} changed while it was read`);
    }
    // Rewalk the complete private path after reading.  Checking only the
    // opened inode and leaf path would miss a state directory replacement.
    await privateStateRoot(root);
    const afterPath = await privateArtifactPath(root, target, label);
    if (!sameFileSnapshot(beforePath, afterPath) || !sameFileSnapshot(beforeHandle, afterHandle)) {
      throw fail("ENATIVE_V3_CLI_ARTIFACT_DRIFT", `${label} changed while it was read`);
    }
    try {
      return JSON.parse(buffer.subarray(0, length).toString("utf8"));
    } catch (error) {
      throw holdFrom(error, "ENATIVE_V3_CLI_ARTIFACT_INVALID", `${label} is not valid JSON`);
    }
  } catch (error) {
    if (error instanceof NativeV3CliBoundaryError) throw error;
    if (["ENOENT", "ELOOP", "ENOTDIR", "EISDIR"].includes(error?.code)) {
      throw fail("ENATIVE_V3_CLI_ARTIFACT_UNSAFE", `${label} is unavailable or unsafe`);
    }
    throw holdFrom(error, "ENATIVE_V3_CLI_ARTIFACT_READ", `${label} could not be read safely`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readApprovalEnvelope(root, target) {
  const raw = await readBoundedPrivateJson(root, target, "ApprovalEnvelope");
  try {
    const envelope = validateApprovalEnvelope(raw);
    if (digestApprovalEnvelope(envelope) !== envelope.digest) {
      throw new Error("ApprovalEnvelope.digest is not bound to its exact contents");
    }
    return envelope;
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_APPROVAL_INVALID", "ApprovalEnvelope is invalid");
  }
}

function assertEqual(actual, expected, label, code = "ENATIVE_V3_CLI_ARTIFACT_DRIFT") {
  if (actual !== expected) throw fail(code, `${label} does not match the persisted artifact`);
}

function assertSingleDependencyFreeTask(plan, taskId) {
  const tasks = plan.taskContract?.graph?.tasks;
  if (!Array.isArray(tasks) || tasks.length !== 1) {
    throw fail("ENATIVE_V3_GRAPH_UNSUPPORTED", "Native V3 CLI boundary supports exactly one task", "HOLD");
  }
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw fail("ENATIVE_V3_GRAPH_UNSUPPORTED", `Native V3 task is missing: ${taskId}`, "HOLD");
  if (!Array.isArray(task.dependencies) || task.dependencies.length !== 0) {
    throw fail("ENATIVE_V3_GRAPH_UNSUPPORTED", "Native V3 CLI boundary does not select a task with dependencies", "HOLD");
  }
  return task;
}

function boundedInteger(value, label, { min = 1, max = 4096 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw fail("ENATIVE_V3_CLI_INPUT", `${label} is outside the bounded range`);
  }
  return value;
}

function nativeCliModelPolicyRestricted(policy) {
  return policy.allow.length > 0 || policy.deny.length > 0 ||
    policy.requested !== null || policy.inherit === false;
}

function assertNativeCliModelSelection(plan, task, requestedModel) {
  const parentPolicy = plan.taskContract.modelPolicy;
  const effectivePolicy = task.modelPolicy;
  const restricted = nativeCliModelPolicyRestricted(parentPolicy) ||
    nativeCliModelPolicyRestricted(effectivePolicy);
  if (requestedModel === undefined) {
    if (restricted) throw fail("ENATIVE_V3_MODEL_POLICY", "Native V3 CLI requires a requested model under the task model policy");
    return;
  }
  const denies = new Set([...parentPolicy.deny, ...effectivePolicy.deny]);
  if (denies.has(requestedModel)) throw fail("ENATIVE_V3_MODEL_POLICY", "Native V3 CLI requested model is denied by the task model policy");
  for (const allow of [parentPolicy.allow, effectivePolicy.allow]) {
    if (allow.length > 0 && !allow.includes(requestedModel)) {
      throw fail("ENATIVE_V3_MODEL_POLICY", "Native V3 CLI requested model is outside the task model policy allow set");
    }
  }
  if (effectivePolicy.requested !== null && requestedModel !== effectivePolicy.requested) {
    throw fail("ENATIVE_V3_MODEL_POLICY", "Native V3 CLI requested model does not match the effective task model policy");
  }
  if (effectivePolicy.requested === null && parentPolicy.requested !== null && requestedModel !== parentPolicy.requested) {
    throw fail("ENATIVE_V3_MODEL_POLICY", "Native V3 CLI requested model does not match the parent model policy");
  }
}

function topologicalTasks(plan) {
  const tasks = plan.taskContract?.graph?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw fail("ENATIVE_V3_PLAN_HOLD", "WorkflowPlan graph is unavailable", "HOLD");
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, task.dependencies.length]));
  const dependents = new Map(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dependency of task.dependencies) dependents.get(dependency).push(task.id);
  }
  const ready = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id).sort();
  const ordered = [];
  while (ready.length > 0) {
    const idValue = ready.shift();
    ordered.push(byId.get(idValue));
    for (const dependent of dependents.get(idValue).sort()) {
      const remaining = indegree.get(dependent) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (ordered.length !== tasks.length) throw fail("ENATIVE_V3_GRAPH_INVALID", "WorkflowPlan graph is not acyclic", "HOLD");
  return ordered;
}

function taskArtifactPath(root, runId, taskId, attemptNumber, fileName) {
  const taskKey = `task-${digestObject({ schemaVersion: 1, kind: "NativeV3CliTaskArtifactKeyV1", taskId })}`;
  const attemptKey = `attempt-${attemptNumber}`;
  return stateRelativePath(root, path.join("native-v3-cli", "runs", runId, "tasks", taskKey, attemptKey, fileName), fileName);
}

function planBindingEntry(value, index) {
  plain(value, `commandBindings[${index}]`);
  const allowed = ["commandBinding", "requestedModel", "expiresAt"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw fail("ENATIVE_V3_CLI_INPUT", `commandBindings[${index}].${key} is not supported`);
  }
  const commandBinding = plain(value.commandBinding, `commandBindings[${index}].commandBinding`);
  if (Object.hasOwn(commandBinding, "approvalEnvelopeDigest")) {
    throw fail("ENATIVE_V3_CLI_INPUT", "multi-task commandBinding must not carry an approvalEnvelopeDigest");
  }
  const requestedModel = value.requestedModel === undefined ? undefined : text(value.requestedModel, `commandBindings[${index}].requestedModel`);
  const expiresAt = value.expiresAt === undefined ? undefined : text(value.expiresAt, `commandBindings[${index}].expiresAt`);
  return { commandBinding, ...(requestedModel === undefined ? {} : { requestedModel }), ...(expiresAt === undefined ? {} : { expiresAt }) };
}

function assertBindingMatchesFreshPlan(binding, plan, sourceBinding) {
  const checks = [
    [binding.planDigest, plan.planDigest, "binding plan digest"],
    [binding.contractDigest, plan.contractDigest, "binding contract digest"],
    [binding.sourceBindingDigest, sourceBinding.digest, "binding source digest"],
    [binding.policyDigest, plan.taskContract.bindings.policy.digest, "binding policy digest"],
    [binding.revision, sourceBinding.revision, "binding revision"]
  ];
  for (const [actual, expected, label] of checks) assertEqual(actual, expected, label);
  if (!same(binding.scope, plan.taskContract.scope)) {
    throw fail("ENATIVE_V3_CLI_ARTIFACT_DRIFT", "Binding scope does not match the fresh workflow plan");
  }
}

async function assertInteractiveArtifactDestination(root, target, label) {
  await privateStateRoot(root);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
      throw fail("ENATIVE_V3_CLI_ARTIFACT_UNSAFE", `${label} already exists with an unsafe shape`);
    }
    throw fail("ENATIVE_V3_CLI_ARTIFACT_EXISTS", `${label} already exists; refusing to replace it`);
  } catch (error) {
    if (error instanceof NativeV3CliBoundaryError) throw error;
    if (error?.code === "ENOENT") return;
    throw holdFrom(error, "ENATIVE_V3_CLI_ARTIFACT_WRITE", `${label} cannot be reserved safely`);
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishInteractiveArtifactNoReplace(root, target, value) {
  const parent = path.dirname(target);
  await assertNoSymlinkUnder(root, parent);
  await ensurePrivateDir(parent);
  const temp = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temp, 0o600);
  // A hard-link publication makes the fully-synced temp visible under the
  // destination without the replacement semantics of rename(2).  EEXIST is
  // therefore a trustworthy competing-file result; the target is untouched.
  await link(temp, target);
  await syncDirectory(parent);
  await unlink(temp);
  await syncDirectory(parent);
}

async function prepareInteractiveArtifacts(options) {
  exactOptions(options, INTERACTIVE_OPTION_KEYS, "native V3 interactive CLI options");
  const root = absolutePath(options.root, "root");
  const planId = identifier(options.planId, "planId");
  const runId = identifier(options.runId, "runId");
  const executionId = identifier(options.executionId, "executionId");
  const attemptId = identifier(options.attemptId, "attemptId");
  const bindingPath = stateRelativePath(root, options.bindingPath, "bindingPath");
  const approvalPath = stateRelativePath(root, options.approvalPath, "approvalPath");
  const ownerAbortSignal = abortSignal(options.ownerAbortSignal, "ownerAbortSignal");
  if (bindingPath === approvalPath) {
    throw fail("ENATIVE_V3_CLI_PATH", "bindingPath and approvalPath must be different files");
  }
  throwIfAborted(ownerAbortSignal, "Native V3 interactive preparation was cancelled before owner approval");
  const commandInput = plain(options.commandBinding, "commandBinding");
  if (Object.hasOwn(commandInput, "approvalEnvelopeDigest")) {
    throw fail("ENATIVE_V3_CLI_INPUT", "interactive commandBinding must not carry an approvalEnvelopeDigest");
  }
  await privateStateRoot(root);

  let plan;
  try {
    plan = await readFreshWorkflowPlanV1({ root, planId });
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_PLAN_HOLD", "Workflow plan is unavailable or stale");
  }
  assertEqual(plan.planId, planId, "Workflow plan planId");
  assertNativeV3AutoCommandExecutionAllowed(plan);

  const taskId = identifier(commandInput.taskId, "commandBinding.taskId");
  const task = assertSingleDependencyFreeTask(plan, taskId);
  const currentSource = await captureCurrentSource(plan.taskContract.bindings.source);
  const sourceBinding = currentSource.sourceBinding;
  const policyDigest = plan.taskContract.bindings.policy.digest;
  const readTrustPolicy = createNativeV3TrustPolicyReader();
  try {
    await readTrustPolicy({
      runId,
      planId,
      policyDigest,
      requestedTrustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE
    });
  } catch (error) {
    throw holdFrom(error, "EPOLICY_TRUST_UNRESOLVED", "Installed native V3 trust policy is not admissible");
  }

  let binding;
  try {
    binding = createNativeCommandBinding(commandInput, { workspaceRoot: currentSource.repositoryRoot });
    assertBindingMatchesFreshPlan(binding, plan, sourceBinding);
    assertEqual(binding.taskId, task.id, "binding taskId");
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_BINDING_HOLD", "Interactive native command binding is not admissible");
  }

  return {
    root,
    planId,
    runId,
    executionId,
    attemptId,
    bindingPath,
    approvalPath,
    ownerAbortSignal,
    plan,
    task,
    binding,
    sourceBinding,
    workspaceRoot: currentSource.repositoryRoot,
    policyDigest,
    readTrustPolicy
  };
}

async function captureCurrentSource(expected) {
  let captured;
  try {
    captured = await captureSourceBinding(process.cwd(), { requireClean: true });
  } catch (error) {
    throw holdFrom(error, "ESOURCE_FRESHNESS_UNAVAILABLE", "Current canonical source binding is unavailable");
  }
  if (!captured || typeof captured.repositoryRoot !== "string" || !path.isAbsolute(captured.repositoryRoot)) {
    throw fail("ESOURCE_FRESHNESS_UNAVAILABLE", "Current canonical source binding is unavailable");
  }
  if (captured.headRevision !== expected.revision || captured.digest !== expected.digest) {
    throw fail("ESOURCE_BINDING_DRIFT", "Current canonical source binding does not match the persisted plan");
  }
  return {
    repositoryRoot: path.resolve(captured.repositoryRoot),
    sourceBinding: { revision: captured.headRevision, digest: captured.digest }
  };
}

function createFreshSourceReader({
  repositoryRoot,
  expected,
  runId,
  planId,
  root,
  approvalPath,
  bindingPath,
  expectedCommandDigest,
  workspaceRoot,
  approvalEnvelope
}) {
  return async (request = {}) => {
    exactOptions(request, SOURCE_REQUEST_KEYS, "fresh source binding request");
    assertEqual(request.runId, runId, "fresh source binding runId", "ESOURCE_BINDING_DRIFT");
    assertEqual(request.planId, planId, "fresh source binding planId", "ESOURCE_BINDING_DRIFT");
    if (request.expected !== undefined) {
      plain(request.expected, "fresh source binding expected");
      assertEqual(request.expected.revision, expected.revision, "fresh source binding revision", "ESOURCE_BINDING_DRIFT");
      assertEqual(request.expected.digest, expected.digest, "fresh source binding digest", "ESOURCE_BINDING_DRIFT");
    }
    let freshEnvelope;
    try {
      freshEnvelope = await readApprovalEnvelope(root, approvalPath);
    } catch (error) {
      throw holdFrom(error, "ENATIVE_V3_APPROVAL_DRIFT", "Approved native V3 envelope is unavailable or stale");
    }
    if (!same(freshEnvelope, approvalEnvelope)) {
      throw fail("ENATIVE_V3_APPROVAL_DRIFT", "Approved native V3 envelope changed after the initial read");
    }
    let freshBinding;
    try {
      freshBinding = await readFreshNativeCommandBinding({
        root,
        target: bindingPath,
        expectedDigest: expectedCommandDigest,
        workspaceRoot,
        requirePrivate: true
      });
      assertNativeCommandBindingMatchesApprovalEnvelope(freshBinding, freshEnvelope, { workspaceRoot });
    } catch (error) {
      throw holdFrom(error, "ENATIVE_V3_BINDING_DRIFT", "Approved native command binding is unavailable or stale");
    }
    let captured;
    try {
      captured = await captureSourceBinding(repositoryRoot, { requireClean: true });
    } catch (error) {
      throw holdFrom(error, "ESOURCE_FRESHNESS_UNAVAILABLE", "Current canonical source binding is unavailable");
    }
    if (!captured || path.resolve(captured.repositoryRoot) !== repositoryRoot ||
        captured.headRevision !== expected.revision || captured.digest !== expected.digest) {
      throw fail("ESOURCE_BINDING_DRIFT", "Current canonical source binding does not match the persisted plan");
    }
    return { revision: captured.headRevision, digest: captured.digest };
  };
}

function createPreparationSourceReader({ repositoryRoot, expected, runId, planId }) {
  return async (request = {}) => {
    exactOptions(request, SOURCE_REQUEST_KEYS, "fresh source binding request");
    assertEqual(request.runId, runId, "fresh source binding runId", "ESOURCE_BINDING_DRIFT");
    assertEqual(request.planId, planId, "fresh source binding planId", "ESOURCE_BINDING_DRIFT");
    if (request.expected !== undefined) {
      plain(request.expected, "fresh source binding expected");
      assertEqual(request.expected.revision, expected.revision, "fresh source binding revision", "ESOURCE_BINDING_DRIFT");
      assertEqual(request.expected.digest, expected.digest, "fresh source binding digest", "ESOURCE_BINDING_DRIFT");
    }
    let captured;
    try {
      captured = await captureSourceBinding(repositoryRoot, { requireClean: true });
    } catch (error) {
      throw holdFrom(error, "ESOURCE_FRESHNESS_UNAVAILABLE", "Current canonical source binding is unavailable");
    }
    if (!captured || path.resolve(captured.repositoryRoot) !== path.resolve(repositoryRoot) ||
        captured.headRevision !== expected.revision || captured.digest !== expected.digest) {
      throw fail("ESOURCE_BINDING_DRIFT", "Current canonical source binding does not match the interactive preparation");
    }
    return { revision: captured.headRevision, digest: captured.digest };
  };
}

function publicArtifacts(value) {
  return {
    schemaVersion: NATIVE_V3_CLI_BOUNDARY_SCHEMA_VERSION,
    kind: NATIVE_V3_CLI_ARTIFACTS_KIND,
    root: value.root,
    planId: value.planId,
    planDigest: value.plan.planDigest,
    contractDigest: value.plan.contractDigest,
    runId: value.envelope.runId,
    taskId: value.binding.taskId,
    unitId: value.binding.unitId,
    executionId: value.envelope.executionId,
    attemptId: value.envelope.attemptId,
    sourceBinding: { ...value.sourceBinding },
    policyDigest: value.policyDigest,
    workspaceRoot: value.workspaceRoot,
    bindingPath: value.bindingPath,
    approvalPath: value.approvalPath,
    expectedCommandDigest: value.expectedCommandDigest,
    plan: structuredClone(value.plan),
    envelope: structuredClone(value.envelope),
    binding: structuredClone(value.binding)
  };
}

async function collectArtifacts(options) {
  exactOptions(options, OPTION_KEYS, "native V3 CLI boundary options");
  const root = absolutePath(options.root, "root");
  const planId = identifier(options.planId, "planId");
  const bindingPath = stateRelativePath(root, options.bindingPath, "bindingPath");
  const approvalPath = stateRelativePath(root, options.approvalPath, "approvalPath");
  const expectedCommandDigest = digest(options.expectedCommandDigest, "expectedCommandDigest");
  await privateStateRoot(root);

  const envelope = await readApprovalEnvelope(root, approvalPath);
  let plan;
  try {
    plan = await readFreshWorkflowPlanV1({
      root,
      planId,
      expected: {
        planDigest: envelope.planDigest,
        contractDigest: envelope.contractDigest
      }
    });
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_PLAN_HOLD", "Persisted V3 plan is unavailable or stale");
  }
  assertEqual(plan.planId, planId, "WorkflowPlan planId");
  const task = assertSingleDependencyFreeTask(plan, envelope.taskId);
  assertEqual(envelope.budget.attempts, task.budget.attempts, "ApprovalEnvelope budget attempts");
  assertEqual(envelope.budget.seconds, task.budget.seconds, "ApprovalEnvelope budget seconds");
  assertEqual(envelope.budget.tokens, task.budget.tokens, "ApprovalEnvelope budget tokens");
  if (!same(envelope.scope, plan.taskContract.scope)) {
    throw fail("ENATIVE_V3_CLI_ARTIFACT_DRIFT", "ApprovalEnvelope scope does not match the persisted plan");
  }
  assertEqual(envelope.sourceBindingDigest, plan.taskContract.bindings.source.digest, "ApprovalEnvelope source binding digest");
  assertEqual(envelope.policyDigest, plan.taskContract.bindings.policy.digest, "ApprovalEnvelope policy digest");
  assertEqual(envelope.revision, plan.taskContract.bindings.source.revision, "ApprovalEnvelope source revision");

  const currentSource = await captureCurrentSource(plan.taskContract.bindings.source);
  const readTrustPolicy = createNativeV3TrustPolicyReader();
  try {
    await readTrustPolicy({
      runId: envelope.runId,
      planId,
      policyDigest: plan.taskContract.bindings.policy.digest,
      requestedTrustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE
    });
  } catch (error) {
    throw holdFrom(error, "EPOLICY_TRUST_UNRESOLVED", "Installed native V3 trust policy is not admissible");
  }

  let binding;
  try {
    binding = await readFreshNativeCommandBinding({
      root,
      target: bindingPath,
      expectedDigest: expectedCommandDigest,
      workspaceRoot: currentSource.repositoryRoot,
      requirePrivate: true
    });
    assertNativeCommandBindingMatchesApprovalEnvelope(binding, envelope, {
      workspaceRoot: currentSource.repositoryRoot
    });
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_BINDING_HOLD", "Native command binding is unavailable or stale");
  }
  const checks = [
    [binding.planDigest, plan.planDigest, "binding plan digest"],
    [binding.contractDigest, plan.contractDigest, "binding contract digest"],
    [binding.sourceBindingDigest, currentSource.sourceBinding.digest, "binding source digest"],
    [binding.policyDigest, plan.taskContract.bindings.policy.digest, "binding policy digest"],
    [binding.revision, currentSource.sourceBinding.revision, "binding revision"],
    [binding.taskId, envelope.taskId, "binding taskId"],
    [binding.unitId, envelope.unitId, "binding unitId"]
  ];
  for (const [actual, expected, label] of checks) assertEqual(actual, expected, label);

  return {
    root,
    planId,
    plan,
    envelope,
    binding,
    sourceBinding: currentSource.sourceBinding,
    workspaceRoot: currentSource.repositoryRoot,
    policyDigest: plan.taskContract.bindings.policy.digest,
    bindingPath,
    approvalPath,
    expectedCommandDigest,
    readTrustPolicy,
    readFreshSourceBinding: createFreshSourceReader({
      repositoryRoot: currentSource.repositoryRoot,
      expected: currentSource.sourceBinding,
      runId: envelope.runId,
      planId,
      root,
      approvalPath,
      bindingPath,
      expectedCommandDigest,
      workspaceRoot: currentSource.repositoryRoot,
      approvalEnvelope: envelope
    }),
    task
  };
}

/**
 * Read all execution artifacts and fresh code-owned bindings without creating
 * a controller, allocation, runner, or effect.
 */
export async function readNativeV3CliArtifacts(options = {}) {
  const artifacts = await collectArtifacts(options);
  return Object.freeze(publicArtifacts(artifacts));
}

/**
 * Prepare and run the explicit same-process cooperative owner flow.
 *
 * This is deliberately separate from `createNativeV3CliBoundary`: the latter
 * consumes already persisted artifacts, while this function creates the
 * controller-owned pending allocation, writes the exact bound artifacts,
 * collects the TTY decision, and only then constructs the runner.  The opaque
 * owner decision is kept in memory and is never serialized or reconstructed.
 */
export async function createNativeV3InteractiveCliRun(options = {}) {
  const context = await prepareInteractiveArtifacts(options);
  throwIfAborted(context.ownerAbortSignal, "Native V3 interactive preparation was cancelled before owner approval");
  await Promise.all([
    assertInteractiveArtifactDestination(context.root, context.bindingPath, "binding artifact"),
    assertInteractiveArtifactDestination(context.root, context.approvalPath, "approval artifact")
  ]);

  let prepared;
  try {
    throwIfAborted(context.ownerAbortSignal, "Native V3 interactive preparation was cancelled before owner approval");
    prepared = await prepareCooperativeNativeV3Approval({
      stateRoot: context.root,
      planId: context.planId,
      runId: context.runId,
      taskId: context.binding.taskId,
      unitId: context.binding.unitId,
      executionId: context.executionId,
      attemptId: context.attemptId,
      recipient: context.binding.recipient,
      action: context.binding.action,
      requestedModel: options.requestedModel,
      sourceBinding: context.sourceBinding,
      policyDigest: context.policyDigest,
      trustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE,
      sourceCwd: context.workspaceRoot,
      readFreshSourceBinding: createPreparationSourceReader({
        repositoryRoot: context.workspaceRoot,
        expected: context.sourceBinding,
        runId: context.runId,
        planId: context.planId
      }),
      readTrustPolicy: context.readTrustPolicy,
      effectBindingDigest: context.binding.commandDigest,
      expiresAt: options.expiresAt
    });
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_CLI_PREPARE_HOLD", "Native V3 interactive preparation is not admissible");
  }
  throwIfAborted(context.ownerAbortSignal, "Native V3 interactive preparation was cancelled before owner approval");

  let bound;
  try {
    bound = bindNativeCommandToApprovalEnvelope(
      context.binding,
      prepared.approvalEnvelope,
      { workspaceRoot: context.workspaceRoot }
    );
    assertEqual(bound.commandDigest, context.binding.commandDigest, "bound command digest");
    assertEqual(bound.action, prepared.approvalEnvelope.action, "bound action");
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_CLI_BINDING_HOLD", "Native V3 interactive binding could not be bound");
  }

  try {
    throwIfAborted(context.ownerAbortSignal, "Native V3 interactive preparation was cancelled before owner approval");
    await publishInteractiveArtifactNoReplace(context.root, context.bindingPath, bound);
    await publishInteractiveArtifactNoReplace(context.root, context.approvalPath, prepared.approvalEnvelope);
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_CLI_ARTIFACT_WRITE", "Native V3 interactive artifacts could not be persisted");
  }

  let artifacts;
  try {
    artifacts = await collectArtifacts({
      root: context.root,
      planId: context.planId,
      bindingPath: path.relative(context.root, context.bindingPath),
      approvalPath: path.relative(context.root, context.approvalPath),
      expectedCommandDigest: bound.commandDigest
    });
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_CLI_ARTIFACT_HOLD", "Native V3 interactive artifacts are not freshly admissible");
  }
  throwIfAborted(context.ownerAbortSignal, "Native V3 interactive preparation was cancelled before owner approval");
  assertEqual(artifacts.binding.commandDigest, context.binding.commandDigest, "fresh effect binding digest");

  let ownerDecision;
  try {
    ownerDecision = await collectCooperativeNativeV3OwnerDecision({
      stateRoot: context.root,
      runId: context.runId,
      requestDigest: prepared.ownerApprovalRequest.requestDigest,
      abortSignal: context.ownerAbortSignal
    });
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_CLI_APPROVAL_HOLD", "Native V3 interactive owner approval was not recorded");
  }
  throwIfAborted(context.ownerAbortSignal, "Native V3 interactive preparation was cancelled after owner approval");

  const runnerOptions = {
    stateRoot: artifacts.root,
    root: artifacts.root,
    workspaceRoot: artifacts.workspaceRoot,
    planId: artifacts.planId,
    runId: artifacts.envelope.runId,
    taskId: artifacts.binding.taskId,
    unitId: artifacts.binding.unitId,
    executionId: artifacts.envelope.executionId,
    attemptId: artifacts.envelope.attemptId,
    bindingPath: artifacts.bindingPath,
    expectedCommandDigest: artifacts.expectedCommandDigest,
    approvalEnvelope: artifacts.envelope,
    sourceBinding: artifacts.sourceBinding,
    policyDigest: artifacts.policyDigest,
    readFreshSourceBinding: artifacts.readFreshSourceBinding,
    readTrustPolicy: artifacts.readTrustPolicy,
    trustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE,
    sourceCwd: artifacts.workspaceRoot,
    ownerDecision,
    effectBindingDigest: artifacts.binding.commandDigest
  };
  if (Object.hasOwn(artifacts.envelope, "requestedModel")) {
    runnerOptions.requestedModel = artifacts.envelope.requestedModel;
  }
  let runner;
  try {
    runner = await createNativeV3CommandRunner(runnerOptions);
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_CLI_RUNNER_HOLD", "Native V3 interactive runner is not admissible");
  }
  return Object.freeze({
    ...publicArtifacts(artifacts),
    schemaVersion: NATIVE_V3_CLI_BOUNDARY_SCHEMA_VERSION,
    kind: NATIVE_V3_CLI_INTERACTIVE_KIND,
    effectBindingDigest: artifacts.binding.commandDigest,
    ownerApprovalRequestDigest: prepared.ownerApprovalRequest.requestDigest,
    runner
  });
}

/**
 * Compose the existing singleton command preparation with the production
 * scheduler. The scheduler's first attempt identity must be selected before
 * owner approval; an already-approved allocation is never renamed. The full
 * stored plan is reused, without selecting or synthesizing a smaller graph.
 *
 * This is an in-process producer, not a terminal or qualification receipt.
 * Its run result is the original plan producer result. The separate passive
 * command reader preserves the admitted command DTO after ownership moves
 * to the scheduler, without invoking command.execute() a second time.
 */
export async function createNativeV3InteractiveCliSingleCommandPlanRun(options = {}) {
  exactOptions(options, INTERACTIVE_OPTION_KEYS, "native V3 single-command plan options");
  // Pin the option values across preparation awaits. Command data still goes
  // through the existing fresh binding and explicit owner admission path.
  options = Object.freeze({ ...options });
  const root = absolutePath(options.root, "root");
  const planId = identifier(options.planId, "planId");
  const attemptId = identifier(options.attemptId, "attemptId");
  const commandInput = plain(options.commandBinding, "commandBinding");
  const taskId = identifier(commandInput.taskId, "commandBinding.taskId");
  const plan = await readFreshWorkflowPlanV1({ root, planId });
  assertNativeV3AutoCommandExecutionAllowed(plan);
  const task = assertSingleDependencyFreeTask(plan, taskId);
  assertEqual(attemptId, `${task.id}.attempt.1`, "scheduler first attempt identity", "ENATIVE_V3_CLI_ATTEMPT_BINDING");

  // The existing boundary still owns all policy, source, command binding,
  // explicit owner decision and native allocation admission checks.
  const prepared = await createNativeV3InteractiveCliRun(options);
  const runner = prepared.runner;
  let runPromise = null;
  let stopPromise = null;
  let planRunner = null;
  const observeCleanup = createPreparedCommandCleanup([runner], () => planRunner, prepared.plan, prepared.runId);
  const stopPreparedRunner = () => {
    if (stopPromise !== null) return stopPromise;
    let resolveStop, rejectStop;
    stopPromise = new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    stopPromise.catch(() => {});
    observeCleanup().then(observation => {
      if (observation.failures.length > 0) throw observation.failures[0];
      return observation.receipts[0];
    }).then(resolveStop, rejectStop);
    return stopPromise;
  };
  try {
    throwIfAborted(options.ownerAbortSignal, "Native V3 single-command plan preparation was cancelled before scheduler construction");
    assertEqual(prepared.planDigest, plan.planDigest, "singleton plan digest");
    assertEqual(prepared.contractDigest, plan.contractDigest, "singleton contract digest");
    assertEqual(prepared.attemptId, attemptId, "approved scheduler attempt identity");
    const taskAdapter = createNativeV3PlanTaskAdapterFromCommandRunner({ runner });
    planRunner = await createNativeV3PlanRunner({
      stateRoot: root,
      plan: prepared.plan,
      planId,
      runId: prepared.runId,
      parallelism: 1,
      taskAdapter,
      readFreshPlan: ({ expected }) => readFreshWorkflowPlanV1({ root, planId, expected }),
      abortSignal: options.ownerAbortSignal
    });
    throwIfAborted(options.ownerAbortSignal, "Native V3 single-command plan preparation was cancelled before DAG dispatch");
    return Object.freeze({
      prepared,
      planRunner,
      run: () => {
        if (runPromise === null) {
          let operation;
          try {
            if (stopPromise !== null) {
              throw fail("ENATIVE_V3_CLI_PREPARED_STOP", "Prepared command cancellation prevents later scheduler dispatch", "HOLD");
            }
            operation = planRunner.run();
          } catch (error) {
            operation = Promise.reject(error);
          }
          runPromise = Promise.resolve(operation);
          runPromise.catch(() => {});
        }
        return runPromise;
      },
      readCommandSettlement: () => {
        const observation = readNativeV3CommandSettlementObservation(runner);
        return Object.freeze({
          observation,
          effectNotSent: isNativeV3CommandSettlementEffectNotSent(observation, runner)
        });
      },
      stopPreparedRunner
    });
  } catch (error) {
    try {
      await stopPreparedRunner();
    } catch (cleanupError) {
      const unknown = fail("ENATIVE_V3_CLI_CLEANUP_UNKNOWN", "Single-command plan composition failed and prepared handle cleanup was not confirmed", "UNKNOWN");
      unknown.cause = error;
      unknown.cleanupError = cleanupError;
      throw unknown;
    }
    throw error;
  }
}

/**
 * Prepare every task attempt in one WorkflowPlan run, collect an explicit
 * owner decision for each allocation, and only then hand the complete
 * approved runner set to the production DAG scheduler.  This keeps the
 * plan-level run identity stable while isolating each task/attempt's private
 * controller state and one-shot runtime handle.
 */
export async function createNativeV3InteractiveCliPlanRun(options = {}) {
  exactOptions(options, PLAN_INTERACTIVE_OPTION_KEYS, "native V3 interactive CLI plan options");
  const root = absolutePath(options.root, "root");
  const planId = identifier(options.planId, "planId");
  const runId = identifier(options.runId, "runId");
  const parallelism = boundedInteger(options.parallelism ?? 2, "parallelism", { min: 1, max: 64 });
  const ownerAbortSignal = abortSignal(options.ownerAbortSignal, "ownerAbortSignal");
  if (!Array.isArray(options.commandBindings) || options.commandBindings.length === 0 || options.commandBindings.length > 4096) {
    throw fail("ENATIVE_V3_CLI_INPUT", "commandBindings must be a non-empty bounded array");
  }
  throwIfAborted(ownerAbortSignal, "Native V3 interactive plan preparation was cancelled before owner approval");
  await privateStateRoot(root);

  let plan;
  try {
    plan = await readFreshWorkflowPlanV1({ root, planId });
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_PLAN_HOLD", "Workflow plan is unavailable or stale");
  }
  assertEqual(plan.planId, planId, "Workflow plan planId");
  assertNativeV3AutoCommandExecutionAllowed(plan);
  const orderedTasks = topologicalTasks(plan);
  const supplied = options.commandBindings.map((value, index) => planBindingEntry(value, index));
  const currentSource = await captureCurrentSource(plan.taskContract.bindings.source);
  const sourceBinding = currentSource.sourceBinding;
  const policyDigest = plan.taskContract.bindings.policy.digest;
  const readTrustPolicy = createNativeV3TrustPolicyReader();

  const byTask = new Map();
  for (const [index, entry] of supplied.entries()) {
    let binding;
    try {
      binding = createNativeCommandBinding(entry.commandBinding, { workspaceRoot: currentSource.repositoryRoot });
      assertBindingMatchesFreshPlan(binding, plan, sourceBinding);
      if (byTask.has(binding.taskId)) throw fail("ENATIVE_V3_CLI_INPUT", `duplicate command binding for task ${binding.taskId}`);
      const task = plan.taskContract.graph.tasks.find((candidate) => candidate.id === binding.taskId);
      if (!task) throw fail("ENATIVE_V3_CLI_INPUT", `commandBindings[${index}] names no WorkflowPlan task`);
      assertNativeCliModelSelection(plan, task, entry.requestedModel);
      byTask.set(binding.taskId, { ...entry, binding, task });
    } catch (error) {
      throw holdFrom(error, "ENATIVE_V3_BINDING_HOLD", `commandBindings[${index}] is not admissible`);
    }
  }
  if (byTask.size !== orderedTasks.length || orderedTasks.some((task) => !byTask.has(task.id))) {
    throw fail("ENATIVE_V3_CLI_INPUT", "commandBindings must cover every WorkflowPlan task exactly once", "HOLD");
  }
  try {
    await readTrustPolicy({
      runId,
      planId,
      policyDigest,
      requestedTrustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE
    });
  } catch (error) {
    throw holdFrom(error, "EPOLICY_TRUST_UNRESOLVED", "Installed native V3 trust policy is not admissible");
  }

  const runners = [];
  const taskArtifacts = [];
  let planRunner = null;
  const observeCleanup = createPreparedCommandCleanup(runners, () => planRunner, plan, runId);
  const stopCreatedRunners = () => observeCleanup().then(observation => observation.failures.slice());
  try {
    for (const task of orderedTasks) {
      const entry = byTask.get(task.id);
      for (let attemptNumber = 1; attemptNumber <= task.budget.attempts; attemptNumber += 1) {
        throwIfAborted(ownerAbortSignal, "Native V3 interactive plan preparation was cancelled before owner approval");
        const attemptId = `${task.id}.attempt.${attemptNumber}`;
        const executionId = `execution-${digestObject({
          schemaVersion: 1,
          kind: "NativeV3CliPlanExecutionIdentityV1",
          runId,
          planId,
          taskId: task.id,
          attemptId
        }).slice(0, 48)}`;
        const allocationKey = nativeV3AllocationKeyFor({ taskId: task.id, attemptId });
        const bindingPath = taskArtifactPath(root, runId, task.id, attemptNumber, "binding.json");
        const approvalPath = taskArtifactPath(root, runId, task.id, attemptNumber, "approval.json");
        await Promise.all([
          assertInteractiveArtifactDestination(root, bindingPath, `${task.id} binding artifact`),
          assertInteractiveArtifactDestination(root, approvalPath, `${task.id} approval artifact`)
        ]);
        let prepared;
        try {
          prepared = await prepareCooperativeNativeV3Approval({
            stateRoot: root,
            planId,
            runId,
            taskId: task.id,
            unitId: entry.binding.unitId,
            executionId,
            attemptId,
            allocationKey,
            recipient: entry.binding.recipient,
            action: entry.binding.action,
            requestedModel: entry.requestedModel,
            sourceBinding,
            policyDigest,
            trustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE,
            sourceCwd: currentSource.repositoryRoot,
            readFreshSourceBinding: createPreparationSourceReader({
              repositoryRoot: currentSource.repositoryRoot,
              expected: sourceBinding,
              runId,
              planId
            }),
            readTrustPolicy,
            effectBindingDigest: entry.binding.commandDigest,
            ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt })
          });
        } catch (error) {
          throw holdFrom(error, "ENATIVE_V3_CLI_PREPARE_HOLD", `Native V3 task ${task.id} preparation is not admissible`);
        }
        throwIfAborted(ownerAbortSignal, "Native V3 interactive plan preparation was cancelled before owner approval");

        let bound;
        try {
          bound = bindNativeCommandToApprovalEnvelope(entry.binding, prepared.approvalEnvelope, {
            workspaceRoot: currentSource.repositoryRoot
          });
          assertEqual(bound.commandDigest, entry.binding.commandDigest, `${task.id} bound command digest`);
        } catch (error) {
          throw holdFrom(error, "ENATIVE_V3_CLI_BINDING_HOLD", `Native V3 task ${task.id} binding could not be bound`);
        }
        try {
          await publishInteractiveArtifactNoReplace(root, bindingPath, bound);
          await publishInteractiveArtifactNoReplace(root, approvalPath, prepared.approvalEnvelope);
        } catch (error) {
          throw holdFrom(error, "ENATIVE_V3_CLI_ARTIFACT_WRITE", `Native V3 task ${task.id} artifacts could not be persisted`);
        }

        let freshBinding;
        let freshEnvelope;
        try {
          freshEnvelope = await readApprovalEnvelope(root, approvalPath);
          freshBinding = await readFreshNativeCommandBinding({
            root,
            target: bindingPath,
            expectedDigest: bound.commandDigest,
            workspaceRoot: currentSource.repositoryRoot,
            requirePrivate: true
          });
          assertNativeCommandBindingMatchesApprovalEnvelope(freshBinding, freshEnvelope, {
            workspaceRoot: currentSource.repositoryRoot
          });
          assertEqual(freshBinding.taskId, task.id, `${task.id} fresh binding taskId`);
          assertEqual(freshEnvelope.attemptId, attemptId, `${task.id} fresh approval attemptId`);
        } catch (error) {
          throw holdFrom(error, "ENATIVE_V3_CLI_ARTIFACT_HOLD", `Native V3 task ${task.id} artifacts are not freshly admissible`);
        }
        let ownerDecision;
        try {
          ownerDecision = await collectCooperativeNativeV3OwnerDecision({
            stateRoot: root,
            runId,
            taskId: task.id,
            attemptId,
            allocationKey,
            requestDigest: prepared.ownerApprovalRequest.requestDigest,
            abortSignal: ownerAbortSignal
          });
        } catch (error) {
          throw holdFrom(error, "ENATIVE_V3_CLI_APPROVAL_HOLD", `Native V3 task ${task.id} owner approval was not recorded`);
        }
        throwIfAborted(ownerAbortSignal, "Native V3 interactive plan preparation was cancelled after owner approval");
        const readFreshSourceBinding = createFreshSourceReader({
          repositoryRoot: currentSource.repositoryRoot,
          expected: sourceBinding,
          runId,
          planId,
          root,
          approvalPath,
          bindingPath,
          expectedCommandDigest: freshBinding.commandDigest,
          workspaceRoot: currentSource.repositoryRoot,
          approvalEnvelope: freshEnvelope
        });
        const runnerOptions = {
          stateRoot: root,
          root,
          workspaceRoot: currentSource.repositoryRoot,
          planId,
          runId,
          taskId: task.id,
          unitId: freshBinding.unitId,
          executionId: freshEnvelope.executionId,
          attemptId: freshEnvelope.attemptId,
          allocationKey,
          planTaskMode: "trusted-plan-task",
          bindingPath: path.relative(root, bindingPath),
          expectedCommandDigest: freshBinding.commandDigest,
          approvalEnvelope: freshEnvelope,
          sourceBinding,
          policyDigest,
          readFreshSourceBinding,
          readTrustPolicy,
          trustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE,
          sourceCwd: currentSource.repositoryRoot,
          ownerDecision,
          effectBindingDigest: freshBinding.commandDigest
        };
        if (entry.requestedModel !== undefined) runnerOptions.requestedModel = entry.requestedModel;
        let runner;
        try {
          runner = await createNativeV3CommandRunner(runnerOptions);
        } catch (error) {
          throw holdFrom(error, "ENATIVE_V3_CLI_RUNNER_HOLD", `Native V3 task ${task.id} runner is not admissible`);
        }
        runners.push(runner);
        taskArtifacts.push(Object.freeze({
          taskId: task.id,
          unitId: freshBinding.unitId,
          attemptId: freshEnvelope.attemptId,
          executionId: freshEnvelope.executionId,
          allocationKey,
          bindingPath: path.relative(root, bindingPath),
          approvalPath: path.relative(root, approvalPath),
          commandDigest: freshBinding.commandDigest,
          approvalEnvelopeDigest: freshEnvelope.digest,
          ownerApprovalRequestDigest: prepared.ownerApprovalRequest.requestDigest,
          handleId: runner.handleId
        }));
      }
    }
    throwIfAborted(ownerAbortSignal, "Native V3 interactive plan preparation was cancelled before DAG dispatch");
    const taskAdapter = createNativeV3PlanTaskAdapterFromCommandRunners({ runners });
    planRunner = await createNativeV3PlanRunner({
      stateRoot: root,
      plan,
      planId,
      runId,
      parallelism,
      taskAdapter,
      abortSignal: ownerAbortSignal
    });
    return Object.freeze({
      schemaVersion: NATIVE_V3_CLI_BOUNDARY_SCHEMA_VERSION,
      kind: NATIVE_V3_CLI_PLAN_INTERACTIVE_KIND,
      root,
      planId,
      planDigest: plan.planDigest,
      contractDigest: plan.contractDigest,
      runId,
      workspaceRoot: currentSource.repositoryRoot,
      sourceBinding: { ...sourceBinding },
      policyDigest,
      parallelism,
      tasks: Object.freeze(taskArtifacts.map((value) => ({ ...value }))),
      planRunner,
      // The CLI may fail a final pre-dispatch gate after this preparation
      // returns. Cancellation of an unstarted plan has no active task set,
      // so the caller must also revoke every precreated ready handle.
      stopPreparedRunners: stopCreatedRunners
    });
  } catch (error) {
    const stopFailures = await stopCreatedRunners();
    if (stopFailures.length > 0) {
      const cleanupError = fail("ENATIVE_V3_CLI_CLEANUP_UNKNOWN", "Native V3 plan preparation failed and a previously approved task could not be stopped", "UNKNOWN");
      cleanupError.cause = error;
      cleanupError.stopFailures = stopFailures.map((item) => ({ code: item?.code ?? "UNKNOWN", message: item?.message ?? String(item) }));
      throw cleanupError;
    }
    throw error;
  }
}

/**
 * Build the already-approved native V3 runner from the exact persisted
 * artifacts and the opaque owner decision minted by the same process's
 * interactive TTY flow.  The sidecar is deliberately separate from the
 * JSON options so it cannot be reconstructed from persisted artifacts or
 * cause this post-approved boundary to open an implicit TTY prompt.
 * The cooperative controller still requires its previously prepared pending
 * allocation; this function never creates one.
 */
export async function createNativeV3CliBoundary(options = {}, ownerDecision = undefined) {
  const artifacts = await collectArtifacts(options);
  assertNativeV3AutoCommandExecutionAllowed(artifacts.plan);
  if (ownerDecision === undefined) {
    throw fail(
      "EOWNER_APPROVAL_REQUIRED",
      "Post-approved native V3 CLI boundary requires an opaque same-process owner decision"
    );
  }
  const runnerOptions = {
    stateRoot: artifacts.root,
    root: artifacts.root,
    workspaceRoot: artifacts.workspaceRoot,
    planId: artifacts.planId,
    runId: artifacts.envelope.runId,
    taskId: artifacts.binding.taskId,
    unitId: artifacts.binding.unitId,
    executionId: artifacts.envelope.executionId,
    attemptId: artifacts.envelope.attemptId,
    bindingPath: artifacts.bindingPath,
    expectedCommandDigest: artifacts.expectedCommandDigest,
    approvalEnvelope: artifacts.envelope,
    sourceBinding: artifacts.sourceBinding,
    policyDigest: artifacts.policyDigest,
    readFreshSourceBinding: artifacts.readFreshSourceBinding,
    readTrustPolicy: artifacts.readTrustPolicy,
    trustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE,
    sourceCwd: artifacts.workspaceRoot,
    ownerDecision,
    effectBindingDigest: artifacts.binding.commandDigest
  };
  if (Object.hasOwn(artifacts.envelope, "requestedModel")) {
    runnerOptions.requestedModel = artifacts.envelope.requestedModel;
  }
  let runner;
  try {
    runner = await createNativeV3CommandRunner(runnerOptions);
  } catch (error) {
    throw holdFrom(error, "ENATIVE_V3_CLI_RUNNER_HOLD", "Native V3 runner is not admissible");
  }
  return Object.freeze({
    ...publicArtifacts(artifacts),
    schemaVersion: NATIVE_V3_CLI_BOUNDARY_SCHEMA_VERSION,
    kind: NATIVE_V3_CLI_BOUNDARY_KIND,
    runner
  });
}

export default createNativeV3CliBoundary;
