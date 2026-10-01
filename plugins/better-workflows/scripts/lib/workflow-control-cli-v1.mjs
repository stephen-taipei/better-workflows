import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  open,
  readdir,
  unlink
} from "node:fs/promises";
import path from "node:path";

import {
  assertNoSymlinkUnder,
  digestObject,
  ensurePrivateDir,
  getStateRoot,
  nowIso,
  readJson,
  safeJoin
} from "./core.mjs";
import {
  NATIVE_V3_PLAN_RUNNER_KIND,
  isNativeV3PlanRunner,
  isNativeV3PlanRunnerCheckpointInResumeLineage,
  readNativeV3PlanRunnerResumeReceipt,
  readNativeV3PlanRunnerCheckpoint
} from "./native-v3-plan-runner.mjs";
import {
  isNativeV3CommandRunner,
  NATIVE_V3_COMMAND_RUNNER_KIND
} from "./native-v3-command-runner.mjs";
import { validateStopReceiptV1 } from "./execution-runtime-v1.mjs";
import { readFreshWorkflowPlanV1 } from "./workflow-plan-v1.mjs";

export const WORKFLOW_CONTROL_SCHEMA_VERSION = 1;
export const WORKFLOW_CONTROL_REQUEST_KIND = "WorkflowControlRequestV1";
export const WORKFLOW_CONTROL_RESPONSE_KIND = "WorkflowControlResponseV1";
export const WORKFLOW_CONTROL_WATCH_KIND = "WorkflowControlWatchV1";
export const WORKFLOW_CONTROL_SAVE_KIND = "WorkflowControlSaveV1";
export const WORKFLOW_CONTROL_RESULT_KIND = "WorkflowControlResultV1";
export const WORKFLOW_CONTROL_MAX_WAIT_MS = 10_000;
export const WORKFLOW_CONTROL_DEFAULT_WAIT_MS = 2_000;
export const WORKFLOW_CONTROL_STOP_TIMEOUT_MS = 5_000;
export const WORKFLOW_CONTROL_CLOSE_TIMEOUT_MS = 1_000;
const WORKFLOW_CONTROL_RESUME_LINEAGE_ATTEMPTS = 16;
const WORKFLOW_CONTROL_RESUME_LINEAGE_RETRY_MS = 2;

const RUNNER_DIRECTORY = "native-v3-plan-runner-v1";
const CONTROL_DIRECTORY = "workflow-control-v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REQUESTED_BY = "sbw-workflow-control";
const CONTROL_ACTIONS = new Set(["pause", "resume", "stop"]);
const RESPONSE_STATUSES = new Set(["STOPPED", "PAUSED", "RESUMED", "HOLD", "UNKNOWN"]);
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function fail(code, message, status = "HOLD") {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlain(value, label) {
  if (!isPlainObject(value)) throw fail("EWORKFLOW_CONTROL_INPUT", `${label} must be a plain object`);
  return value;
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw fail("EWORKFLOW_CONTROL_INPUT", `${label} is invalid`);
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw fail("EWORKFLOW_CONTROL_INPUT", `${label} is invalid`);
  return value;
}

function assertIso(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw fail("EWORKFLOW_CONTROL_INPUT", `${label} is invalid`);
  }
  return value;
}

function resolveRootPath(root) {
  const value = root ?? getStateRoot();
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw fail("EWORKFLOW_CONTROL_INPUT", "state root must be an absolute path");
  }
  return path.resolve(value);
}

function controlRoot(root, runId) {
  return safeJoin(resolveRootPath(root), RUNNER_DIRECTORY, "runs", assertId(runId, "runId"), CONTROL_DIRECTORY);
}

function requestsRoot(root, runId) {
  return safeJoin(controlRoot(root, runId), "requests");
}

function responsesRoot(root, runId) {
  return safeJoin(controlRoot(root, runId), "responses");
}

function savesRoot(root, runId) {
  return safeJoin(controlRoot(root, runId), "saves");
}

function requestPath(root, runId, requestId) {
  return safeJoin(requestsRoot(root, runId), `${assertId(requestId, "requestId")}.json`);
}

function responsePath(root, runId, requestId) {
  return safeJoin(responsesRoot(root, runId), `${assertId(requestId, "requestId")}.json`);
}

function clone(value) {
  return structuredClone(value);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readControlJson(root, target) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assertNoSymlinkUnder(root, target);
    let handle;
    try {
      handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const before = await handle.stat();
      // A create-only hard-link publication has two links for the short period
      // between link(2) and temporary-name removal.  The bytes are already
      // complete and synced at that point, but a 2 -> 1 transition changes
      // ctime.  Discard that observation and retry once from the pathname so
      // the removed link cannot be confused with replacement of the target.
      if (!before.isFile() || before.nlink < 1 || before.nlink > 2) {
        throw fail("EWORKFLOW_CONTROL_FS", `Unsafe JSON path: ${target}`);
      }
      if (!Number.isSafeInteger(before.size) || before.size > MAX_FILE_BYTES) {
        throw fail("EWORKFLOW_CONTROL_SIZE", "workflow control record exceeds its bounded size");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      let targetInfo;
      try {
        await assertNoSymlinkUnder(root, target);
        targetInfo = await lstat(target);
      } catch (error) {
        const changed = fail("EWORKFLOW_CONTROL_FS", `workflow control JSON changed while being read: ${target}`, "UNKNOWN");
        changed.cause = error;
        throw changed;
      }
      const descriptorLinkDrop = before.nlink === 2 && after.nlink === 1;
      const targetLinkDrop = after.nlink === 2 && targetInfo.nlink === 1;
      const descriptorIdentityStable = after.isFile() && after.nlink >= 1 && after.nlink <= 2 &&
        before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
        before.uid === after.uid && before.gid === after.gid && before.size === after.size &&
        before.mtimeMs === after.mtimeMs;
      const targetIdentityStable = !targetInfo.isSymbolicLink() && targetInfo.isFile() &&
        targetInfo.nlink >= 1 && targetInfo.nlink <= 2 &&
        targetInfo.dev === after.dev && targetInfo.ino === after.ino && targetInfo.mode === after.mode &&
        targetInfo.uid === after.uid && targetInfo.gid === after.gid && targetInfo.size === after.size &&
        targetInfo.mtimeMs === after.mtimeMs;
      const descriptorTransitionStable = before.nlink === after.nlink && before.ctimeMs === after.ctimeMs;
      const targetTransitionStable = after.nlink === targetInfo.nlink && after.ctimeMs === targetInfo.ctimeMs;
      const snapshotStable = bytes.byteLength === before.size && descriptorIdentityStable &&
        targetIdentityStable && descriptorTransitionStable && targetTransitionStable;
      if (snapshotStable) return JSON.parse(bytes.toString("utf8"));
      const retryablePublication = attempt === 0 && bytes.byteLength === before.size &&
        descriptorIdentityStable && targetIdentityStable &&
        (descriptorTransitionStable || descriptorLinkDrop) &&
        (targetTransitionStable || targetLinkDrop) &&
        (descriptorLinkDrop || targetLinkDrop);
      if (!retryablePublication) {
        throw fail("EWORKFLOW_CONTROL_FS", `workflow control JSON changed while being read: ${target}`, "UNKNOWN");
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  throw fail("EWORKFLOW_CONTROL_FS", `workflow control JSON changed while being read: ${target}`, "UNKNOWN");
}

function boundedTimeout(value, label, fallback) {
  const timeout = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > WORKFLOW_CONTROL_MAX_WAIT_MS) {
    throw fail("EWORKFLOW_CONTROL_INPUT", `${label} must be an integer from 1 through ${WORKFLOW_CONTROL_MAX_WAIT_MS}`);
  }
  return timeout;
}

function awaitBounded(operation, timeoutMs, code, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(fail(code, message, "UNKNOWN"));
    }, timeoutMs);
    Promise.resolve(operation).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// Control records and saves are immutable evidence.  The complete bytes are
// first written and synced to a private temporary inode.  link(2) then
// publishes that inode under the final name with create-only semantics: a
// competing publisher receives EEXIST and can never replace the target.  A
// reader therefore observes either no file or a complete JSON file.
async function createOnlyJson(root, target, value) {
  const bytes = jsonBytes(value);
  if (bytes.byteLength > MAX_FILE_BYTES) throw fail("EWORKFLOW_CONTROL_SIZE", "workflow control record exceeds its bounded size", "HOLD");
  const parent = path.dirname(target);
  await assertNoSymlinkUnder(root, parent);
  await ensurePrivateDir(parent);
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await handle.close().catch(() => {});
    }
    await chmod(temporary, 0o600);
    try {
      await link(temporary, target);
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      const wrapped = fail("EWORKFLOW_CONTROL_PUBLISH", `workflow control record could not be atomically published: ${error?.message ?? String(error)}`, "UNKNOWN");
      wrapped.cause = error;
      throw wrapped;
    }
    await syncDirectory(parent);
    await unlink(temporary);
    await syncDirectory(parent);
    return true;
  } finally {
    // A failed or competing publication must not leave a half-written temp
    // artifact.  If unlink itself is unavailable after a successful link, the
    // final target remains complete and the original error is preserved.
    await unlink(temporary).catch(() => {});
  }
}

async function ensureControlDirectories(root, runId) {
  const rootPath = resolveRootPath(root);
  await ensurePrivateDir(rootPath);
  await ensurePrivateDir(safeJoin(rootPath, RUNNER_DIRECTORY));
  await ensurePrivateDir(safeJoin(rootPath, RUNNER_DIRECTORY, "runs"));
  await ensurePrivateDir(safeJoin(rootPath, RUNNER_DIRECTORY, "runs", assertId(runId, "runId")));
  await ensurePrivateDir(controlRoot(rootPath, runId));
  await ensurePrivateDir(requestsRoot(rootPath, runId));
  await ensurePrivateDir(responsesRoot(rootPath, runId));
  await ensurePrivateDir(savesRoot(rootPath, runId));
}

function validateRequest(value, expected = {}) {
  assertPlain(value, "workflow control request");
  const keys = Object.keys(value).sort().join(",");
  const expectedKeys = [
    "action", "checkpointDigest", "contractDigest", "kind", "planDigest", "planId", "requestDigest",
    "requestId", "requestedAt", "requestedBy", "runId", "schemaVersion", "status"
  ].sort().join(",");
  if (keys !== expectedKeys || value.schemaVersion !== WORKFLOW_CONTROL_SCHEMA_VERSION ||
      value.kind !== WORKFLOW_CONTROL_REQUEST_KIND || !CONTROL_ACTIONS.has(value.action) ||
      value.status !== "requested" || value.requestedBy !== REQUESTED_BY) {
    throw fail("EWORKFLOW_CONTROL_REQUEST_INVALID", "workflow control request has an invalid shape");
  }
  assertId(value.requestId, "request.requestId");
  assertId(value.runId, "request.runId");
  assertId(value.planId, "request.planId");
  assertDigest(value.planDigest, "request.planDigest");
  assertDigest(value.contractDigest, "request.contractDigest");
  assertDigest(value.checkpointDigest, "request.checkpointDigest");
  assertIso(value.requestedAt, "request.requestedAt");
  assertDigest(value.requestDigest, "request.requestDigest");
  const { requestDigest: ignored, ...body } = value;
  if (digestObject(body) !== value.requestDigest) throw fail("EWORKFLOW_CONTROL_REQUEST_INVALID", "workflow control request digest is invalid");
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && value[key] !== expectedValue) {
      throw fail("EWORKFLOW_CONTROL_BINDING_DRIFT", `workflow control request ${key} is not bound to the current run`);
    }
  }
  return clone(value);
}

function errorProjection(error, fallbackCode, fallbackStatus = "UNKNOWN") {
  return {
    code: typeof error?.code === "string" && error.code.length > 0 ? error.code : fallbackCode,
    message: typeof error?.message === "string" && error.message.length > 0 ? error.message : fallbackCode,
    status: error?.status === "HOLD" || error?.status === "UNKNOWN" ? error.status : fallbackStatus
  };
}

function validateResponse(value, expectedRequest = null) {
  assertPlain(value, "workflow control response");
  const keys = Object.keys(value).sort().join(",");
  const expectedKeys = [
    "action", "checkpointDigest", "error", "kind", "physicalStopProven", "requestDigest", "requestId",
    "result", "responseDigest", "respondedAt", "runId", "schemaVersion", "status"
  ].sort().join(",");
  if (keys !== expectedKeys || value.schemaVersion !== WORKFLOW_CONTROL_SCHEMA_VERSION ||
      value.kind !== WORKFLOW_CONTROL_RESPONSE_KIND || !RESPONSE_STATUSES.has(value.status) ||
      typeof value.physicalStopProven !== "boolean" || (value.status === "STOPPED") !== value.physicalStopProven ||
      (value.status === "STOPPED" && value.action !== "stop") ||
      (value.status === "PAUSED" && value.action !== "pause") ||
      (value.status === "RESUMED" && value.action !== "resume") ||
      (value.result !== null && !isPlainObject(value.result)) ||
      (value.error !== null && !isPlainObject(value.error))) {
    throw fail("EWORKFLOW_CONTROL_RESPONSE_INVALID", "workflow control response has an invalid shape");
  }
  assertId(value.requestId, "response.requestId");
  assertId(value.runId, "response.runId");
  assertDigest(value.requestDigest, "response.requestDigest");
  if (value.checkpointDigest !== null) assertDigest(value.checkpointDigest, "response.checkpointDigest");
  assertIso(value.respondedAt, "response.respondedAt");
  assertDigest(value.responseDigest, "response.responseDigest");
  if (value.error !== null) {
    const errorKeys = Object.keys(value.error).sort().join(",");
    if (errorKeys !== "code,message,status" || typeof value.error.code !== "string" ||
        typeof value.error.message !== "string" || !["HOLD", "UNKNOWN"].includes(value.error.status)) {
      throw fail("EWORKFLOW_CONTROL_RESPONSE_INVALID", "workflow control response error is invalid");
    }
  }
  if (expectedRequest !== null && (value.requestId !== expectedRequest.requestId || value.runId !== expectedRequest.runId ||
      value.action !== expectedRequest.action || value.requestDigest !== expectedRequest.requestDigest)) {
    throw fail("EWORKFLOW_CONTROL_BINDING_DRIFT", "workflow control response is not bound to its request");
  }
  const { responseDigest: ignored, ...body } = value;
  if (digestObject(body) !== value.responseDigest) throw fail("EWORKFLOW_CONTROL_RESPONSE_INVALID", "workflow control response digest is invalid");
  return clone(value);
}

async function readResponse(root, runId, request, { missingOk = true } = {}) {
  try {
    return validateResponse(await readControlJson(resolveRootPath(root), responsePath(root, runId, request.requestId)), request);
  } catch (error) {
    if (missingOk && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readBoundState(root, runId) {
  const resolvedRootValue = resolveRootPath(root);
  const normalizedRunId = assertId(runId, "runId");
  let checkpoint;
  try {
    checkpoint = await readNativeV3PlanRunnerCheckpoint({ root: resolvedRootValue, runId: normalizedRunId });
  } catch (error) {
    if (error?.code === "EPLAN_RUNNER_STATE_MISSING") {
      throw fail("EWORKFLOW_CONTROL_STATE_MISSING", "native WorkflowPlan run checkpoint is absent", "HOLD");
    }
    throw error;
  }
  let plan;
  try {
    plan = await readFreshWorkflowPlanV1({
      root: resolvedRootValue,
      planId: checkpoint.planId,
      expected: {
        planDigest: checkpoint.planDigest,
        contractDigest: checkpoint.contractDigest
      }
    });
  } catch (error) {
    throw fail("EWORKFLOW_CONTROL_PLAN_DRIFT", `native WorkflowPlan binding could not be verified: ${error?.message ?? String(error)}`, "HOLD");
  }
  if (checkpoint.runId !== normalizedRunId || checkpoint.planId !== plan.planId ||
      checkpoint.planDigest !== plan.planDigest || checkpoint.contractDigest !== plan.contractDigest) {
    throw fail("EWORKFLOW_CONTROL_BINDING_DRIFT", "checkpoint is not bound to its immutable WorkflowPlan", "HOLD");
  }
  return { root: resolvedRootValue, runId: normalizedRunId, checkpoint, plan };
}

async function listRequests(root, runId, expected) {
  const directory = requestsRoot(root, runId);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw fail("EWORKFLOW_CONTROL_REQUEST_INVALID", `workflow control request entry is not a regular JSON file: ${entry.name}`);
    }
    const requestId = entry.name.slice(0, -5);
    const record = validateRequest(await readControlJson(resolveRootPath(root), safeJoin(directory, entry.name)), expected);
    if (record.requestId !== requestId) throw fail("EWORKFLOW_CONTROL_REQUEST_INVALID", "workflow control request filename does not match requestId");
    records.push(record);
  }
  return records.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt) || left.requestId.localeCompare(right.requestId));
}

function responseSummary(response) {
  return {
    requestId: response.requestId,
    action: response.action,
    status: response.status,
    physicalStopProven: response.physicalStopProven,
    checkpointDigest: response.checkpointDigest,
    respondedAt: response.respondedAt,
    responseDigest: response.responseDigest,
    error: response.error
  };
}

function requestSummary(request) {
  return {
    requestId: request.requestId,
    action: request.action,
    requestedAt: request.requestedAt,
    requestDigest: request.requestDigest,
    checkpointDigest: request.checkpointDigest
  };
}

function verifiedResponseProjection(response, checkpoint, request, { trustedLineage = false } = {}) {
  const claimed = responseSummary(response);
  const hasStoppedClaim = response.status === "STOPPED";
  const confirmedStop = response.action === "stop" && hasStoppedClaim && response.physicalStopProven === true &&
    response.checkpointDigest === checkpoint?.stateDigest && isPlanStopProven(checkpoint);
  const hasPausedClaim = response.status === "PAUSED";
  const confirmedPause = response.action === "pause" && hasPausedClaim && response.physicalStopProven === false &&
    response.checkpointDigest === checkpoint?.stateDigest && isPlanPauseProven(checkpoint);
  const hasResumedClaim = response.status === "RESUMED";
  const resumeReceipt = response.action === "resume" && isPlainObject(response.result) &&
    isPlainObject(response.result.checkpoint) && isPlainObject(response.result.resumeReceipt)
    ? response.result.resumeReceipt
    : null;
  const confirmedResume = response.action === "resume" && hasResumedClaim && response.physicalStopProven === false &&
    response.result?.checkpoint?.stateDigest === response.checkpointDigest &&
    isPlanResumeProven(checkpoint, resumeReceipt, {
      requestDigest: request?.requestDigest,
      checkpointDigest: request?.checkpointDigest
    }, { trustedLineage });
  const status = (hasStoppedClaim && !confirmedStop) || (hasPausedClaim && !confirmedPause) || (hasResumedClaim && !confirmedResume)
    ? "UNKNOWN"
    : response.status;
  const physicalStopProven = confirmedStop;
  const confirmationError = hasStoppedClaim && !confirmedStop
    ? {
        code: "EWORKFLOW_CONTROL_STOP_UNPROVEN",
        message: "The response claimed STOPPED but the current durable native checkpoint did not prove cancellation",
        status: "UNKNOWN"
      }
    : hasPausedClaim && !confirmedPause
      ? {
          code: "EWORKFLOW_CONTROL_PAUSE_UNPROVEN",
          message: "The response claimed PAUSED but the current durable native checkpoint did not prove a safe dispatch-blocked pause",
          status: "UNKNOWN"
        }
      : hasResumedClaim && !confirmedResume
        ? {
            code: "EWORKFLOW_CONTROL_RESUME_UNPROVEN",
            message: "The response claimed RESUMED but the current durable native checkpoint did not prove a fresh resume transition",
            status: "UNKNOWN"
          }
        : response.error;
  return {
    requestId: response.requestId,
    action: response.action,
    status,
    physicalStopProven,
    respondedAt: response.respondedAt,
    responseDigest: response.responseDigest,
    error: confirmationError,
    claimed,
    confirmed: {
      status,
      physicalStopProven,
      checkpointDigest: typeof checkpoint?.stateDigest === "string" ? checkpoint.stateDigest : null,
      error: confirmationError
    }
  };
}

async function listResponses(root, runId, requests, checkpoint, options = {}) {
  const directory = responsesRoot(root, runId);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const byId = new Map(requests.map((request) => [request.requestId, request]));
  const records = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw fail("EWORKFLOW_CONTROL_RESPONSE_INVALID", `workflow control response entry is not a regular JSON file: ${entry.name}`);
    }
    const requestId = entry.name.slice(0, -5);
    const request = byId.get(requestId);
    if (!request) throw fail("EWORKFLOW_CONTROL_BINDING_DRIFT", "workflow control response has no matching request");
    const response = validateResponse(await readControlJson(resolveRootPath(root), safeJoin(directory, entry.name)), request);
    records.push(verifiedResponseProjection(response, checkpoint, request, options));
  }
  return records.sort((left, right) => left.respondedAt.localeCompare(right.respondedAt) || left.requestId.localeCompare(right.requestId));
}

function isPlanStopProven(checkpoint) {
  if (!isPlainObject(checkpoint) || checkpoint.status !== "cancelled" || checkpoint.dispatchBlocked !== true ||
      checkpoint.cancelRequested !== true || checkpoint.reconcileRequired === true) return false;
  for (const task of Object.values(checkpoint.tasks ?? {})) {
    if (["preparing", "dispatching"].includes(task.status) || task.status === "unknown") return false;
    if (task.stopReceipt !== null &&
        (task.stopReceipt.outcome !== "STOPPED" || task.stopReceipt.confirmedOwnedScope !== true || task.stopReceipt.localOutcome !== "stopped")) {
      return false;
    }
  }
  return true;
}

function isPlanPauseProven(checkpoint) {
  if (!isPlainObject(checkpoint) || checkpoint.status !== "paused" || checkpoint.dispatchBlocked !== true ||
      checkpoint.cancelRequested !== false || checkpoint.cancelReason !== "pause" || checkpoint.ownerId !== null ||
      checkpoint.ownerPid !== null || checkpoint.reconcileRequired !== false) return false;
  for (const task of Object.values(checkpoint.tasks ?? {})) {
    if (["preparing", "dispatching", "unknown"].includes(task.status)) return false;
  }
  return true;
}

function isCheckpointDigestSelfConsistent(checkpoint) {
  if (!isPlainObject(checkpoint) || typeof checkpoint.stateDigest !== "string" || !DIGEST.test(checkpoint.stateDigest)) {
    return false;
  }
  try {
    return digestObject({ ...checkpoint, stateDigest: undefined }) === checkpoint.stateDigest;
  } catch {
    return false;
  }
}

function hasContiguousCheckpointEvents(checkpoint) {
  return Number.isSafeInteger(checkpoint?.sequence) && checkpoint.sequence >= 0 &&
    Array.isArray(checkpoint?.events) && checkpoint.events.length === checkpoint.sequence &&
    checkpoint.events.every((event, index) => isPlainObject(event) && event.sequence === index + 1 &&
      typeof event.type === "string" && typeof event.at === "string" && Number.isFinite(Date.parse(event.at)) &&
      (event.taskId === null || typeof event.taskId === "string") &&
      (event.attemptId === null || typeof event.attemptId === "string") &&
      (event.detail === null || isPlainObject(event.detail)) &&
      (event.previousStateDigest === undefined || (typeof event.previousStateDigest === "string" && DIGEST.test(event.previousStateDigest))));
}

function sameDigestList(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isPlanResumeProven(checkpoint, receipt, expected = {}, { trustedLineage = false } = {}) {
  if (!isPlainObject(checkpoint) || !isPlainObject(receipt) ||
      !["running", "succeeded", "failed", "hold", "cancelled"].includes(checkpoint.status) ||
      checkpoint.reconcileRequired === true ||
      receipt.schemaVersion !== 1 || receipt.kind !== "NativeV3PlanResumeTransitionReceiptV1" ||
      receipt.transition !== "run.resumed" || receipt.runId !== checkpoint.runId ||
      receipt.planId !== checkpoint.planId || receipt.planDigest !== checkpoint.planDigest ||
      receipt.contractDigest !== checkpoint.contractDigest || receipt.freshAdapter !== true ||
      receipt.freshEpoch !== receipt.ownerId || receipt.effectAllowed !== false ||
      !isPlainObject(receipt.currentAdmission) || receipt.currentAdmission.status !== "pending" ||
      !Array.isArray(receipt.currentAdmission.taskAdmissionDigests) ||
      !isPlainObject(receipt.resumeGrant) ||
      !isPlainObject(receipt.afterCheckpoint) ||
      !Array.isArray(receipt.lineageDigests) || receipt.lineageDigests.length === 0 ||
      !Number.isSafeInteger(receipt.beforeSequence) || !Number.isSafeInteger(receipt.afterSequence) ||
      receipt.afterSequence <= receipt.beforeSequence || receipt.afterSequence > checkpoint.sequence ||
      !Array.isArray(checkpoint.events)) return false;
  if (receipt.lineageDigests.some((value) => typeof value !== "string" || !DIGEST.test(value)) ||
      new Set(receipt.lineageDigests).size !== receipt.lineageDigests.length ||
      !receipt.lineageDigests.includes(receipt.afterCheckpointDigest)) return false;
  const { grantDigest: ignoredGrantDigest, ...resumeGrantBody } = receipt.resumeGrant;
  if (receipt.resumeGrant.kind !== "NativeV3PlanResumeTransitionGrantV1" ||
      receipt.resumeGrant.schemaVersion !== 1 ||
      receipt.resumeGrant.runId !== receipt.runId || receipt.resumeGrant.planId !== receipt.planId ||
      receipt.resumeGrant.planDigest !== receipt.planDigest ||
      receipt.resumeGrant.contractDigest !== receipt.contractDigest ||
      receipt.resumeGrant.requestDigest !== receipt.requestDigest ||
      receipt.resumeGrant.beforeCheckpointDigest !== receipt.beforeCheckpointDigest ||
      receipt.resumeGrant.afterCheckpointDigest !== receipt.afterCheckpointDigest ||
      receipt.resumeGrant.epoch !== receipt.ownerId || receipt.resumeGrant.ownerPid !== receipt.ownerPid ||
      receipt.resumeGrant.freshAdapter !== true || receipt.resumeGrant.effectAllowed !== false ||
      typeof receipt.resumeGrant.grantDigest !== "string" ||
      digestObject(resumeGrantBody) !== receipt.resumeGrant.grantDigest) return false;
  const { boundaryDigest: ignoredBoundaryDigest, ...admissionBoundaryBody } = receipt.currentAdmission;
  if (receipt.currentAdmission.kind !== "NativeV3PlanResumeAdmissionBoundaryV1" ||
      receipt.currentAdmission.schemaVersion !== 1 ||
      receipt.currentAdmission.runId !== receipt.runId || receipt.currentAdmission.planId !== receipt.planId ||
      receipt.currentAdmission.planDigest !== receipt.planDigest ||
      receipt.currentAdmission.contractDigest !== receipt.contractDigest ||
      receipt.currentAdmission.requestDigest !== receipt.requestDigest ||
      receipt.currentAdmission.epoch !== receipt.ownerId ||
      receipt.currentAdmission.resumeGrantDigest !== receipt.resumeGrant.grantDigest ||
      receipt.currentAdmission.effectAllowed !== false || typeof receipt.currentAdmission.boundaryDigest !== "string" ||
      digestObject(admissionBoundaryBody) !== receipt.currentAdmission.boundaryDigest) return false;
  const transitionCheckpoint = receipt.afterCheckpoint;
  if (!isCheckpointDigestSelfConsistent(transitionCheckpoint) ||
      transitionCheckpoint.kind !== "NativeV3PlanRunnerCheckpointV1" ||
      transitionCheckpoint.schemaVersion !== 1 ||
      transitionCheckpoint.runId !== receipt.runId || transitionCheckpoint.planId !== receipt.planId ||
      transitionCheckpoint.planDigest !== receipt.planDigest ||
      transitionCheckpoint.contractDigest !== receipt.contractDigest ||
      transitionCheckpoint.status !== "running" || transitionCheckpoint.dispatchBlocked !== false ||
      transitionCheckpoint.cancelRequested !== false || transitionCheckpoint.cancelReason !== null ||
      transitionCheckpoint.reconcileRequired !== false || transitionCheckpoint.ownerId !== receipt.ownerId ||
      transitionCheckpoint.ownerPid !== receipt.ownerPid || transitionCheckpoint.sequence !== receipt.afterSequence ||
      transitionCheckpoint.sequence - 1 !== receipt.beforeSequence ||
      !hasContiguousCheckpointEvents(transitionCheckpoint) || !isPlainObject(transitionCheckpoint.tasks) ||
      transitionCheckpoint.stateDigest !== receipt.afterCheckpointDigest) return false;
  const transitionAdmissionDigests = Object.values(transitionCheckpoint.tasks ?? {})
    .map((task) => task?.admissionDigest)
    .filter((value) => typeof value === "string")
    .sort();
  if (transitionAdmissionDigests.some((value) => !DIGEST.test(value)) ||
      !sameDigestList(transitionAdmissionDigests, [...receipt.currentAdmission.taskAdmissionDigests].sort())) return false;
  const transitionEvent = transitionCheckpoint.events[transitionCheckpoint.events.length - 1];
  if (!transitionEvent || transitionEvent.sequence !== receipt.afterSequence ||
      transitionEvent.previousStateDigest !== receipt.beforeCheckpointDigest ||
      transitionEvent.type !== "run.resumed" || transitionEvent.detail?.phase !== "resume" ||
      transitionEvent.detail?.freshAdapter !== true || transitionEvent.detail?.ownerId !== receipt.ownerId ||
      transitionEvent.detail?.ownerPid !== receipt.ownerPid) return false;
  if (!hasContiguousCheckpointEvents(checkpoint) ||
      checkpoint.sequence < transitionCheckpoint.sequence || checkpoint.events.length < transitionCheckpoint.events.length) return false;
  const prefix = checkpoint.events.slice(0, transitionCheckpoint.events.length);
  if (prefix.length !== transitionCheckpoint.events.length ||
      prefix.some((event, index) => digestObject(event) !== digestObject(transitionCheckpoint.events[index]))) return false;
  if (expected.requestDigest !== undefined && receipt.requestDigest !== expected.requestDigest) return false;
  if (expected.checkpointDigest !== undefined && receipt.beforeCheckpointDigest !== expected.checkpointDigest) return false;
  const event = checkpoint.events.find((candidate) => candidate?.sequence === receipt.afterSequence);
  if (checkpoint.ownerId !== receipt.ownerId || checkpoint.ownerPid !== receipt.ownerPid ||
      checkpoint.events.some((candidate) => candidate?.type === "run.resumed" && candidate.sequence > receipt.afterSequence)) {
    return false;
  }
  if (event?.type !== "run.resumed" || event.detail?.phase !== "resume" ||
      event.detail?.freshAdapter !== true || event.detail?.ownerId !== receipt.ownerId ||
      event.detail?.ownerPid !== receipt.ownerPid) return false;
  if (checkpoint.stateDigest === receipt.afterCheckpointDigest) {
    return true;
  }
  // A response can be read after the native runner has durably advanced the
  // DAG beyond the transition snapshot.  Accept only a contiguous, native
  // event suffix whose first predecessor is the exact transition digest and
  // whose final checkpoint was emitted by the live private runner lineage.  A
  // digest/event shape is not authenticity: without that process-local
  // provenance, a caller can append a plausible event and self-digest an
  // arbitrary task/admission state.
  if (trustedLineage !== true) return false;
  if (checkpoint.sequence <= receipt.afterSequence) return false;
  const suffix = checkpoint.events.slice(transitionCheckpoint.events.length);
  if (suffix.length !== checkpoint.sequence - receipt.afterSequence || suffix.length === 0) return false;
  const allowedTypes = new Set([
    "run.claimed", "run.cancel-requested", "run.pause-requested", "run.unknown-observed", "run.owner-reconcile",
    "run.terminal", "task.reserved", "task.verification-observed", "task.prepared", "task.dispatching",
    "task.stop-observed", "task.pause-observed", "task.success", "task.failure", "task.hold", "task.unknown",
    "task.cancelled", "task.result-invalid", "task.budget-exceeded", "tasks.dependency-blocked"
  ]);
  if (suffix.some((candidate, index) => {
    if (!isPlainObject(candidate) || !Number.isSafeInteger(candidate.sequence) ||
        candidate.sequence !== receipt.afterSequence + index + 1 || !allowedTypes.has(candidate.type) ||
        typeof candidate.previousStateDigest !== "string" || !DIGEST.test(candidate.previousStateDigest)) return true;
    return index === 0 && candidate.previousStateDigest !== receipt.afterCheckpointDigest;
  })) return false;
  return true;
}

function singleStopReceiptFromStatus(status, runner, expectedRunId) {
  if (!isNativeV3CommandRunner(runner) || runner.kind !== NATIVE_V3_COMMAND_RUNNER_KIND ||
      runner.runId !== expectedRunId || typeof runner.handleId !== "string" ||
      !isPlainObject(status) || status.kind !== "NativeV3CommandRunnerStatusV1" ||
      !isPlainObject(status.handle) || status.handle.handleId !== runner.handleId ||
      status.handle.runId !== expectedRunId || status.handle.status !== "stopped" ||
      status.handle.dispatchBlocked !== true || !Array.isArray(status.stopReceipts)) {
    return null;
  }
  for (const receipt of status.stopReceipts) {
    try {
      validateStopReceiptV1(receipt);
    } catch {
      continue;
    }
    if (receipt.outcome === "STOPPED" && receipt.confirmedOwnedScope === true &&
        receipt.localOutcome === "stopped" && receipt.runId === expectedRunId &&
        receipt.handleId === runner.handleId) {
      return receipt;
    }
  }
  return null;
}

function ownerRunnerKind(runner, expected) {
  if (!runner || typeof runner !== "object" || runner.runId !== expected.runId || runner.planId !== expected.planId) {
    return null;
  }
  if (runner.kind === NATIVE_V3_PLAN_RUNNER_KIND &&
      runner.planDigest === expected.planDigest && runner.contractDigest === expected.contractDigest &&
      typeof runner.cancel === "function" && typeof runner.inspect === "function") {
    return NATIVE_V3_PLAN_RUNNER_KIND;
  }
  if (runner.kind === NATIVE_V3_COMMAND_RUNNER_KIND && isNativeV3CommandRunner(runner) &&
      typeof runner.stop === "function" && typeof runner.status === "function") {
    return NATIVE_V3_COMMAND_RUNNER_KIND;
  }
  return null;
}

function validateExistingSave(value, expected) {
  try {
    if (!isPlainObject(value) || !isPlainObject(expected)) return false;
    const keys = Object.keys(value).sort().join(",");
    const expectedKeys = [
      "authorityGrantIssued", "checkpoint", "checkpointDigest", "contractDigest", "effectAllowed",
      "immutable", "kind", "plan", "planDigest", "planId", "runId", "saveId", "savedAt",
      "schemaVersion", "scope", "snapshotDigest"
    ].sort().join(",");
    if (keys !== expectedKeys || value.schemaVersion !== WORKFLOW_CONTROL_SCHEMA_VERSION ||
        value.kind !== WORKFLOW_CONTROL_SAVE_KIND || value.immutable !== true ||
        value.authorityGrantIssued !== false || value.effectAllowed !== false ||
        value.saveId !== expected.saveId || value.runId !== expected.runId || value.planId !== expected.planId ||
        value.planDigest !== expected.planDigest || value.contractDigest !== expected.contractDigest ||
        value.checkpointDigest !== expected.checkpointDigest) {
      return false;
    }
    assertId(value.saveId, "save.saveId");
    assertId(value.runId, "save.runId");
    assertId(value.planId, "save.planId");
    assertDigest(value.planDigest, "save.planDigest");
    assertDigest(value.contractDigest, "save.contractDigest");
    assertDigest(value.checkpointDigest, "save.checkpointDigest");
    assertDigest(value.snapshotDigest, "save.snapshotDigest");
    assertIso(value.savedAt, "save.savedAt");
    const { snapshotDigest: ignoredExistingDigest, ...existingBody } = value;
    if (digestObject(existingBody) !== value.snapshotDigest) return false;
    const { savedAt: ignoredExistingTime, ...existingStableBody } = existingBody;
    const { snapshotDigest: ignoredExpectedDigest, savedAt: ignoredExpectedTime, ...expectedStableBody } = expected;
    return digestObject(existingStableBody) === digestObject(expectedStableBody);
  } catch {
    return false;
  }
}

function buildResponse(request, { status, result = null, checkpointDigest = null, error = null }) {
  if (!RESPONSE_STATUSES.has(status)) throw fail("EWORKFLOW_CONTROL_RESPONSE_INVALID", "workflow control response status is invalid");
  const body = {
    schemaVersion: WORKFLOW_CONTROL_SCHEMA_VERSION,
    kind: WORKFLOW_CONTROL_RESPONSE_KIND,
    requestId: request.requestId,
    runId: request.runId,
    action: request.action,
    requestDigest: request.requestDigest,
    status,
    physicalStopProven: status === "STOPPED",
    result: result === null ? null : clone(result),
    checkpointDigest,
    error: error === null ? null : errorProjection(error, "EWORKFLOW_CONTROL_RESPONSE", status === "HOLD" ? "HOLD" : "UNKNOWN"),
    respondedAt: nowIso()
  };
  return { ...body, responseDigest: digestObject(body) };
}

async function persistResponse(root, request, response) {
  const target = responsePath(root, request.runId, request.requestId);
  const created = await createOnlyJson(resolveRootPath(root), target, response);
  if (created) return response;
  const existing = validateResponse(await readControlJson(resolveRootPath(root), target), request);
  if (existing.responseDigest !== response.responseDigest) {
    throw fail("EWORKFLOW_CONTROL_RESPONSE_COLLISION", "workflow control response is immutable and already differs", "UNKNOWN");
  }
  return existing;
}

async function waitForTrustedResumeLineage({ root, runId, checkpoint, resumeRequested }) {
  if (!resumeRequested) return false;
  const lineageInput = { root, runId, checkpoint };
  let trustedLineage = isNativeV3PlanRunnerCheckpointInResumeLineage(lineageInput);
  // The runner publishes the durable checkpoint before advancing its private
  // in-process lineage. A reader can therefore observe the new file in the
  // small interval before the private authenticity proof is visible. Yield a
  // bounded number of times only for a real resume request; forged or
  // recovered checkpoints never gain lineage and remain fail-closed.
  for (let attempt = 1; !trustedLineage && attempt < WORKFLOW_CONTROL_RESUME_LINEAGE_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, WORKFLOW_CONTROL_RESUME_LINEAGE_RETRY_MS));
    trustedLineage = isNativeV3PlanRunnerCheckpointInResumeLineage(lineageInput);
  }
  return trustedLineage;
}

export async function readWorkflowControlObservation({ root = getStateRoot(), runId } = {}) {
  const state = await readBoundState(root, runId);
  const expected = {
    runId: state.runId,
    planId: state.plan.planId,
    planDigest: state.plan.planDigest,
    contractDigest: state.plan.contractDigest
  };
  const requests = await listRequests(state.root, state.runId, expected);
  const trustedLineage = await waitForTrustedResumeLineage({
    root: state.root,
    runId: state.runId,
    checkpoint: state.checkpoint,
    resumeRequested: requests.some((request) => request.action === "resume")
  });
  const responses = await listResponses(state.root, state.runId, requests, state.checkpoint, { trustedLineage });
  return {
    ...state,
    requests,
    responses,
    pending: requests.filter((request) => !responses.some((response) => response.requestId === request.requestId))
  };
}

export async function requestWorkflowControl({
  root = getStateRoot(),
  runId,
  action,
  requestId = randomUUID(),
  waitMs = WORKFLOW_CONTROL_DEFAULT_WAIT_MS
} = {}) {
  if (!CONTROL_ACTIONS.has(action)) throw fail("EWORKFLOW_CONTROL_INPUT", "workflow control action must be pause, resume, or stop");
  assertId(requestId, "requestId");
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > WORKFLOW_CONTROL_MAX_WAIT_MS) {
    throw fail("EWORKFLOW_CONTROL_INPUT", `workflow control waitMs must be an integer from 0 through ${WORKFLOW_CONTROL_MAX_WAIT_MS}`);
  }
  const state = await readBoundState(root, runId);
  if (action === "resume") {
    if (state.checkpoint.status === "unknown" || state.checkpoint.reconcileRequired === true) {
      throw fail("EWORKFLOW_RESUME_RECONCILIATION_REQUIRED", "the workflow is UNKNOWN and requires effect reconciliation before resume", "UNKNOWN");
    }
    if (state.checkpoint.status !== "paused") {
      throw fail("EWORKFLOW_RESUME_REQUIRES_PAUSED", "workflow resume requires a durably paused checkpoint", "HOLD");
    }
  }
  await ensureControlDirectories(state.root, state.runId);
  const requestBody = {
    schemaVersion: WORKFLOW_CONTROL_SCHEMA_VERSION,
    kind: WORKFLOW_CONTROL_REQUEST_KIND,
    requestId,
    runId: state.runId,
    action,
    planId: state.plan.planId,
    planDigest: state.plan.planDigest,
    contractDigest: state.plan.contractDigest,
    checkpointDigest: state.checkpoint.stateDigest,
    requestedBy: REQUESTED_BY,
    requestedAt: nowIso(),
    status: "requested"
  };
  const request = { ...requestBody, requestDigest: digestObject(requestBody) };
  const target = requestPath(state.root, state.runId, request.requestId);
  const created = await createOnlyJson(state.root, target, request);
  let effectiveRequest = request;
  if (!created) {
    effectiveRequest = validateRequest(await readControlJson(state.root, target), {
      runId: state.runId,
      planId: state.plan.planId,
      planDigest: state.plan.planDigest,
      contractDigest: state.plan.contractDigest
    });
    if (effectiveRequest.action !== action) throw fail("EWORKFLOW_CONTROL_REQUEST_COLLISION", "requestId is already bound to another workflow action", "HOLD");
  }
  const deadline = Date.now() + waitMs;
  let response = await readResponse(state.root, state.runId, effectiveRequest);
  while (response === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    response = await readResponse(state.root, state.runId, effectiveRequest);
  }
  let checkpoint = state.checkpoint;
  try {
    checkpoint = (await readBoundState(state.root, state.runId)).checkpoint;
  } catch {
    // The original bound state remains the only safe observation if a run
    // disappears while the external requester is waiting.
  }
  // A response file is immutable evidence, but its public fields are still a
  // claim.  Accept STOPPED only when the independently re-read native plan
  // checkpoint proves the owned cancellation; this prevents a pre-created or
  // copied JSON response from turning into a successful stop.
  const confirmedStop = effectiveRequest.action === "stop" && response?.action === "stop" &&
    response?.status === "STOPPED" && response?.checkpointDigest === checkpoint?.stateDigest &&
    isPlanStopProven(checkpoint);
  const confirmedPause = effectiveRequest.action === "pause" && response?.action === "pause" &&
    response?.status === "PAUSED" && response?.checkpointDigest === checkpoint?.stateDigest &&
    isPlanPauseProven(checkpoint);
  const trustedResumeLineage = await waitForTrustedResumeLineage({
    root: state.root,
    runId: state.runId,
    checkpoint,
    resumeRequested: effectiveRequest.action === "resume"
  });
  const confirmedResume = effectiveRequest.action === "resume" && state.checkpoint.status === "paused" &&
    response?.action === "resume" && response?.status === "RESUMED" &&
    response?.result?.checkpoint?.stateDigest === response?.checkpointDigest &&
    response?.checkpointDigest !== effectiveRequest.checkpointDigest &&
    isPlanResumeProven(checkpoint, response?.result?.resumeReceipt, {
      requestDigest: effectiveRequest.requestDigest,
      checkpointDigest: effectiveRequest.checkpointDigest
    }, { trustedLineage: trustedResumeLineage });
  const confirmed = confirmedStop || confirmedPause || confirmedResume;
  const status = confirmedStop
    ? "STOPPED"
    : confirmedPause
      ? "PAUSED"
      : confirmedResume
        ? "RESUMED"
        : ["STOPPED", "PAUSED", "RESUMED"].includes(response?.status)
          ? "UNKNOWN"
          : response?.status ?? "UNKNOWN";
  return {
    schemaVersion: WORKFLOW_CONTROL_SCHEMA_VERSION,
    kind: WORKFLOW_CONTROL_RESULT_KIND,
    ok: confirmed,
    status,
    operation: `workflow.${action}`,
    runId: state.runId,
    planId: state.plan.planId,
    planDigest: state.plan.planDigest,
    contractDigest: state.plan.contractDigest,
    requestId: effectiveRequest.requestId,
    requestCreated: created,
    request: effectiveRequest,
    response,
    checkpoint,
    requestPath: target,
    responsePath: responsePath(state.root, state.runId, effectiveRequest.requestId),
    authority: {
      authorityGrantIssued: false,
      effectAllowed: false,
      newEpochIssued: false,
      newAdmissionCreated: false,
      oldAuthorizationReused: false
    },
    ...(!confirmed && response?.status === "STOPPED" ? {
      error: {
        code: "EWORKFLOW_CONTROL_STOP_UNPROVEN",
        message: "The owner response claimed STOPPED but the durable native checkpoint did not prove cancellation",
        status: "UNKNOWN"
      }
    } : !confirmed && response?.status === "PAUSED" ? {
      error: {
        code: "EWORKFLOW_CONTROL_PAUSE_UNPROVEN",
        message: "The owner response claimed PAUSED but the durable native checkpoint did not prove a safe paused state",
        status: "UNKNOWN"
      }
    } : !confirmed && response?.status === "RESUMED" ? {
      error: {
        code: "EWORKFLOW_CONTROL_RESUME_UNPROVEN",
        message: "The owner response claimed RESUMED but the durable native checkpoint did not prove a fresh resume transition",
        status: "UNKNOWN"
      }
    } : response === null ? {
      error: {
        code: "EWORKFLOW_CONTROL_UNCONFIRMED",
        message: `workflow ${action} request was persisted but no active owner returned a bounded response`,
        status: "UNKNOWN"
      }
    } : response?.error ? { error: response.error } : {})
  };
}

export async function workflowResumeUnsupported({ root = getStateRoot(), runId, requestId, waitMs } = {}) {
  const state = await readBoundState(root, runId);
  if (state.checkpoint.status === "unknown" || state.checkpoint.reconcileRequired === true) {
    return {
      schemaVersion: WORKFLOW_CONTROL_SCHEMA_VERSION,
      kind: WORKFLOW_CONTROL_RESULT_KIND,
      ok: false,
      status: "UNKNOWN",
      operation: "workflow.resume",
      runId: state.runId,
      planId: state.plan.planId,
      planDigest: state.plan.planDigest,
      contractDigest: state.plan.contractDigest,
      checkpoint: state.checkpoint,
      authority: {
        authorityGrantIssued: false,
        effectAllowed: false,
        newEpochIssued: false,
        newAdmissionCreated: false,
        oldAuthorizationReused: false
      },
      error: {
        code: "EWORKFLOW_RESUME_RECONCILIATION_REQUIRED",
        message: "The workflow is UNKNOWN and requires trusted effect reconciliation before a new resume attempt",
        status: "UNKNOWN"
      }
    };
  }
  if (state.checkpoint.status !== "paused") {
    return {
      schemaVersion: WORKFLOW_CONTROL_SCHEMA_VERSION,
      kind: WORKFLOW_CONTROL_RESULT_KIND,
      ok: false,
      status: "HOLD",
      operation: "workflow.resume",
      runId: state.runId,
      planId: state.plan.planId,
      planDigest: state.plan.planDigest,
      contractDigest: state.plan.contractDigest,
      checkpoint: state.checkpoint,
      authority: {
        authorityGrantIssued: false,
        effectAllowed: false,
        newEpochIssued: false,
        newAdmissionCreated: false,
        oldAuthorizationReused: false
      },
      error: {
        code: "EWORKFLOW_RESUME_REQUIRES_PAUSED",
        message: "Workflow resume requires a durably paused checkpoint",
        status: "HOLD"
      }
    };
  }
  return requestWorkflowControl({ root: state.root, runId: state.runId, action: "resume", requestId, waitMs });
}

function resolveSaveTarget(root, runId, saveId, file) {
  if (file === undefined) return safeJoin(savesRoot(root, runId), `${assertId(saveId, "saveId")}.json`);
  if (typeof file !== "string" || file.length === 0 || file.length > 4096 || file.includes("\0")) {
    throw fail("EWORKFLOW_CONTROL_INPUT", "save file is invalid");
  }
  const stateRoot = resolveRootPath(root);
  const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(stateRoot, file);
  let target;
  try {
    target = safeJoin(stateRoot, path.relative(stateRoot, resolved));
  } catch {
    throw fail("EWORKFLOW_CONTROL_INPUT", "save file must remain under the state root");
  }
  if (target === stateRoot || path.extname(target) !== ".json") throw fail("EWORKFLOW_CONTROL_INPUT", "save file must be a JSON path under the state root");
  return target;
}

export async function saveWorkflowControlSnapshot({ root = getStateRoot(), runId, saveId = randomUUID(), file } = {}) {
  assertId(saveId, "saveId");
  const state = await readBoundState(root, runId);
  await ensureControlDirectories(state.root, state.runId);
  const target = resolveSaveTarget(state.root, state.runId, saveId, file);
  const body = {
    schemaVersion: WORKFLOW_CONTROL_SCHEMA_VERSION,
    kind: WORKFLOW_CONTROL_SAVE_KIND,
    saveId,
    runId: state.runId,
    planId: state.plan.planId,
    planDigest: state.plan.planDigest,
    contractDigest: state.plan.contractDigest,
    scope: clone(state.plan.taskContract.scope),
    checkpointDigest: state.checkpoint.stateDigest,
    plan: clone(state.plan),
    checkpoint: clone(state.checkpoint),
    savedAt: nowIso(),
    immutable: true,
    authorityGrantIssued: false,
    effectAllowed: false
  };
  const snapshot = { ...body, snapshotDigest: digestObject(body) };
  const created = await createOnlyJson(state.root, target, snapshot);
  if (!created) {
    const existing = await readControlJson(state.root, target);
    if (!validateExistingSave(existing, snapshot)) {
      throw fail("EWORKFLOW_CONTROL_SAVE_COLLISION", "workflow save path is immutable and already contains a different snapshot", "HOLD");
    }
    return {
      schemaVersion: WORKFLOW_CONTROL_SCHEMA_VERSION,
      kind: WORKFLOW_CONTROL_RESULT_KIND,
      ok: true,
      status: "SAVED",
      operation: "workflow.save",
      runId: state.runId,
      planId: state.plan.planId,
      planDigest: state.plan.planDigest,
      contractDigest: state.plan.contractDigest,
      saveId,
      path: target,
      created: false,
      snapshotDigest: existing.snapshotDigest,
      checkpointDigest: state.checkpoint.stateDigest,
      authority: {
        authorityGrantIssued: false,
        effectAllowed: false
      }
    };
  }
  return {
    schemaVersion: WORKFLOW_CONTROL_SCHEMA_VERSION,
    kind: WORKFLOW_CONTROL_RESULT_KIND,
    ok: true,
    status: "SAVED",
    operation: "workflow.save",
    runId: state.runId,
    planId: state.plan.planId,
    planDigest: state.plan.planDigest,
    contractDigest: state.plan.contractDigest,
    saveId,
    path: target,
    created,
    snapshotDigest: snapshot.snapshotDigest,
    checkpointDigest: state.checkpoint.stateDigest,
    authority: {
      authorityGrantIssued: false,
      effectAllowed: false
    }
  };
}

export async function startWorkflowControlWatcher({
  root = getStateRoot(),
  runId,
  planId,
  planDigest,
  contractDigest,
  getRunner,
  isOwnerActive = () => true,
  stopRunner,
  resumeRunner,
  pollMs = 25,
  stopTimeoutMs = WORKFLOW_CONTROL_STOP_TIMEOUT_MS,
  closeTimeoutMs = WORKFLOW_CONTROL_CLOSE_TIMEOUT_MS
} = {}) {
  const stateRoot = resolveRootPath(root);
  const normalizedRunId = assertId(runId, "runId");
  assertId(planId, "planId");
  assertDigest(planDigest, "planDigest");
  assertDigest(contractDigest, "contractDigest");
  if (typeof getRunner !== "function" || typeof stopRunner !== "function") {
    throw fail("EWORKFLOW_CONTROL_INPUT", "workflow control watcher requires owner runner callbacks");
  }
  if (resumeRunner !== undefined && typeof resumeRunner !== "function") {
    throw fail("EWORKFLOW_CONTROL_INPUT", "workflow control watcher resumeRunner must be callable");
  }
  if (!Number.isSafeInteger(pollMs) || pollMs < 5 || pollMs > 1_000) {
    throw fail("EWORKFLOW_CONTROL_INPUT", "workflow control watcher pollMs is out of bounds");
  }
  const boundedStopTimeoutMs = boundedTimeout(stopTimeoutMs, "workflow control stopTimeoutMs", WORKFLOW_CONTROL_STOP_TIMEOUT_MS);
  const boundedCloseTimeoutMs = boundedTimeout(closeTimeoutMs, "workflow control closeTimeoutMs", WORKFLOW_CONTROL_CLOSE_TIMEOUT_MS);
  await ensureControlDirectories(stateRoot, normalizedRunId);
  const expected = { runId: normalizedRunId, planId, planDigest, contractDigest };
  let closed = false;
  let timer = null;
  let inFlight = Promise.resolve();

  async function readStopProof(runnerKind, runner, deadline) {
    const read = () => runnerKind === NATIVE_V3_PLAN_RUNNER_KIND
      ? readNativeV3PlanRunnerCheckpoint({ root: stateRoot, runId: normalizedRunId })
      : runner.status();
    let observation = null;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw fail("EWORKFLOW_CONTROL_STATUS_TIMEOUT", "the owner stop proof did not settle before its bounded deadline", "UNKNOWN");
      }
      observation = await awaitBounded(
        read(),
        remaining,
        "EWORKFLOW_CONTROL_STATUS_TIMEOUT",
        "the owner stop proof did not settle before its bounded deadline"
      );
      const pending = runnerKind === NATIVE_V3_PLAN_RUNNER_KIND
        ? observation?.status === "cancelling"
        : observation?.status !== "stopped";
      if (!pending) return observation;
      const sleepFor = Math.min(25, Math.max(1, deadline - Date.now()));
      if (sleepFor <= 0) {
        throw fail("EWORKFLOW_CONTROL_STATUS_TIMEOUT", "the owner stop proof did not settle before its bounded deadline", "UNKNOWN");
      }
      await new Promise((resolve) => setTimeout(resolve, sleepFor));
    }
  }

  async function readPlanCheckpoint(deadline, code, message) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw fail(code, message, "UNKNOWN");
    return awaitBounded(
      readNativeV3PlanRunnerCheckpoint({ root: stateRoot, runId: normalizedRunId }),
      remaining,
      code,
      message
    );
  }

  async function persistPauseResponse(request, activeRunner, runnerKind) {
    if (runnerKind !== NATIVE_V3_PLAN_RUNNER_KIND || typeof activeRunner.pause !== "function") {
      await persistResponse(stateRoot, request, buildResponse(request, {
        status: "HOLD",
        error: {
          code: "EWORKFLOW_PAUSE_RUNNER_UNSUPPORTED",
          message: "The active owner is not a trusted native WorkflowPlan runner with a pause capability",
          status: "HOLD"
        }
      }));
      return;
    }
    const deadline = Date.now() + boundedStopTimeoutMs;
    let pauseError = null;
    let checkpoint = null;
    try {
      await awaitBounded(
        activeRunner.pause({ reason: "pause" }),
        Math.max(1, deadline - Date.now()),
        "EWORKFLOW_CONTROL_PAUSE_TIMEOUT",
        "the owner pause operation did not settle before its bounded deadline"
      );
      if (closed || !isOwnerActive()) return;
      checkpoint = await readPlanCheckpoint(
        deadline,
        "EWORKFLOW_CONTROL_PAUSE_TIMEOUT",
        "the owner pause proof did not settle before its bounded deadline"
      );
    } catch (error) {
      pauseError = error;
      if (closed || !isOwnerActive() || error?.code === "EWORKFLOW_CONTROL_PAUSE_TIMEOUT") return;
      try {
        checkpoint = await readPlanCheckpoint(
          deadline,
          "EWORKFLOW_CONTROL_PAUSE_TIMEOUT",
          "the owner pause proof did not settle before its bounded deadline"
        );
      } catch {}
    }
    if (closed || !isOwnerActive()) return;
    const physicalPauseProven = pauseError === null && isPlanPauseProven(checkpoint);
    const unknown = checkpoint?.status === "unknown" || checkpoint?.reconcileRequired === true || pauseError?.status === "UNKNOWN";
    await persistResponse(stateRoot, request, buildResponse(request, {
      status: physicalPauseProven ? "PAUSED" : unknown ? "UNKNOWN" : "HOLD",
      result: physicalPauseProven ? checkpoint : null,
      checkpointDigest: isPlainObject(checkpoint) && typeof checkpoint.stateDigest === "string"
        ? checkpoint.stateDigest
        : null,
      error: physicalPauseProven ? null : pauseError ?? (unknown
        ? {
            code: "EWORKFLOW_PAUSE_RECONCILIATION_REQUIRED",
            message: "The owner pause reached an UNKNOWN or reconciliation-required state; no resume is permitted",
            status: "UNKNOWN"
          }
        : {
            code: "EWORKFLOW_PAUSE_UNPROVEN",
            message: "The owner pause callback returned without a durable dispatch-blocked paused proof",
            status: "HOLD"
          })
    }));
  }

  async function persistResumeResponse(request, activeRunner, runnerKind) {
    if (runnerKind !== NATIVE_V3_PLAN_RUNNER_KIND || !isNativeV3PlanRunner(activeRunner) ||
        typeof activeRunner.resumeTransition !== "function") {
      await persistResponse(stateRoot, request, buildResponse(request, {
        status: "HOLD",
        error: {
          code: "EWORKFLOW_RESUME_RUNNER_UNSUPPORTED",
          message: "The active owner is not a trusted native WorkflowPlan runner with a transition receipt capability",
          status: "HOLD"
        }
      }));
      return;
    }
    const deadline = Date.now() + boundedStopTimeoutMs;
    let operation = null;
    let operationError = null;
    let operationSettled = false;
    let resumeReceipt = null;
    try {
      // The optional callback is only a delivery hook for the already-branded
      // plan runner.  It cannot mint authority: only the runner's private
      // transition API can mint the receipt that is required below.  The
      // default path returns at the transition boundary rather than waiting
      // for the whole DAG run.
      operation = resumeRunner === undefined
        ? activeRunner.resumeTransition({ controlRequestDigest: request.requestDigest })
        : resumeRunner({ runner: activeRunner, request });
    } catch (error) {
      operationError = error;
      operationSettled = true;
    }
    if (!operationSettled) {
      Promise.resolve(operation).then(
        () => { operationSettled = true; },
        (error) => { operationError = error; operationSettled = true; }
      ).catch(() => {});
    }

    let checkpoint = null;
    let proof = false;
    let timeoutError = null;
    while (Date.now() < deadline) {
      if (closed || !isOwnerActive()) return;
      try {
        checkpoint = await readPlanCheckpoint(
          deadline,
          "EWORKFLOW_CONTROL_RESUME_TIMEOUT",
          "the owner resume proof did not settle before its bounded deadline"
        );
      } catch (error) {
        timeoutError = error;
        break;
      }
      // A durable-looking checkpoint is not enough while the owner operation
      // is still pending.  A delivery callback may have written a forged
      // checkpoint and then reject; wait for the operation to settle and keep
      // that rejection authoritative.
      if (operationSettled && operationError === null) {
        resumeReceipt = readNativeV3PlanRunnerResumeReceipt(activeRunner, {
          requestDigest: request.requestDigest,
          beforeCheckpointDigest: request.checkpointDigest,
          runId: request.runId,
          planId: request.planId,
          planDigest: request.planDigest,
          contractDigest: request.contractDigest
        });
      }
      // A resolved owner operation without the private native transition
      // receipt is already a definitive HOLD.  Do not spend the full stop
      // window waiting for a callback to manufacture evidence after it has
      // returned; only the genuine runner receipt can authorize RESUMED.
      if (operationSettled && operationError === null && resumeReceipt === null) break;
      proof = operationSettled && operationError === null && resumeReceipt !== null &&
        checkpoint?.stateDigest !== request.checkpointDigest && isPlanResumeProven(checkpoint, resumeReceipt, {
          requestDigest: request.requestDigest,
          checkpointDigest: request.checkpointDigest
        }, {
          trustedLineage: isNativeV3PlanRunnerCheckpointInResumeLineage({
            root: stateRoot,
            runId: normalizedRunId,
            checkpoint
          })
        });
      if (proof || operationError !== null || (operationSettled && checkpoint?.status !== "running")) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    if (!proof && timeoutError === null && !operationSettled && Date.now() >= deadline) {
      timeoutError = fail(
        "EWORKFLOW_CONTROL_RESUME_TIMEOUT",
        "the owner resume proof did not settle before its bounded deadline",
        "UNKNOWN"
      );
    }
    if (closed || !isOwnerActive()) return;
    const error = proof && operationError === null ? null : operationError ?? timeoutError ?? {
      code: "EWORKFLOW_RESUME_UNPROVEN",
      message: "The owner resume callback returned without a fresh durable resume proof",
      status: "HOLD"
    };
    const unknown = !proof && (error?.status === "UNKNOWN" || checkpoint?.status === "unknown" || checkpoint?.reconcileRequired === true);
    await persistResponse(stateRoot, request, buildResponse(request, {
      status: proof ? "RESUMED" : unknown ? "UNKNOWN" : "HOLD",
      result: proof ? { checkpoint, resumeReceipt } : null,
      checkpointDigest: isPlainObject(checkpoint) && typeof checkpoint.stateDigest === "string"
        ? checkpoint.stateDigest
        : null,
      error
    }));
  }

  async function consume() {
    if (closed || !isOwnerActive()) return;
    const requests = await listRequests(stateRoot, normalizedRunId, expected);
    for (const request of requests) {
      if (closed || !isOwnerActive()) return;
      if (await readResponse(stateRoot, normalizedRunId, request)) continue;
      const activeRunner = getRunner();
      const runnerKind = ownerRunnerKind(activeRunner, expected);
      if (runnerKind === null) {
        await persistResponse(stateRoot, request, buildResponse(request, {
          status: "UNKNOWN",
          error: {
            code: "EWORKFLOW_CONTROL_OWNER_BINDING",
            message: "The active owner runner is not the trusted runner bound to this WorkflowPlan run",
            status: "UNKNOWN"
          }
        }));
        continue;
      }
      if (request.action === "pause") {
        await persistPauseResponse(request, activeRunner, runnerKind);
        continue;
      }
      if (request.action === "resume") {
        await persistResumeResponse(request, activeRunner, runnerKind);
        continue;
      }
      let result = null;
      let checkpoint = null;
      let stopError = null;
      const stopDeadline = Date.now() + boundedStopTimeoutMs;
      try {
        result = await awaitBounded(
          stopRunner({ runner: activeRunner, request }),
          Math.max(1, stopDeadline - Date.now()),
          "EWORKFLOW_CONTROL_STOP_TIMEOUT",
          "the owner stop operation did not settle before its bounded deadline"
        );
        if (closed || !isOwnerActive()) return;
        checkpoint = await readStopProof(runnerKind, activeRunner, stopDeadline);
      } catch (error) {
        stopError = error;
        if (closed || !isOwnerActive() || error?.code === "EWORKFLOW_CONTROL_STOP_TIMEOUT") return;
        // A callback may reject after it has requested a physical stop.  Read
        // the durable proof once, but keep the response UNKNOWN because the
        // callback itself did not complete successfully.  The read is bounded
        // as well; a hanging status path cannot keep the watcher alive.
        try {
          checkpoint = await readStopProof(runnerKind, activeRunner, stopDeadline);
        } catch {}
      }
      if (closed || !isOwnerActive()) return;
      const singleStopReceipt = runnerKind === NATIVE_V3_COMMAND_RUNNER_KIND
        ? singleStopReceiptFromStatus(checkpoint, activeRunner, normalizedRunId)
        : null;
      const physicalStopProven = stopError === null &&
        (runnerKind === NATIVE_V3_PLAN_RUNNER_KIND
          ? isPlanStopProven(checkpoint)
          : singleStopReceipt !== null);
      const responseResult = physicalStopProven
        ? runnerKind === NATIVE_V3_PLAN_RUNNER_KIND ? checkpoint : singleStopReceipt
        : null;
      await persistResponse(stateRoot, request, buildResponse(request, {
        status: physicalStopProven ? "STOPPED" : "UNKNOWN",
        result: responseResult,
        checkpointDigest: isPlainObject(checkpoint) && typeof checkpoint.stateDigest === "string"
          ? checkpoint.stateDigest
          : null,
        error: physicalStopProven ? null : stopError ?? {
          code: "EWORKFLOW_STOP_UNPROVEN",
          message: "The owner stop callback returned without a physical STOPPED proof",
          status: "UNKNOWN"
        }
      }));
    }
  }

  const schedule = () => {
    if (closed) return;
    timer = setTimeout(() => {
      inFlight = consume().catch(() => {}).finally(schedule);
    }, pollMs);
  };
  inFlight = consume().catch(() => {}).finally(schedule);

  return Object.freeze({
    async close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      try {
        await awaitBounded(
          inFlight,
          boundedCloseTimeoutMs,
          "EWORKFLOW_CONTROL_CLOSE_TIMEOUT",
          "the workflow control watcher did not close before its bounded deadline"
        );
        return { closed: true, completed: true };
      } catch (error) {
        return {
          closed: true,
          completed: false,
          error: errorProjection(error, "EWORKFLOW_CONTROL_CLOSE_TIMEOUT", "UNKNOWN")
        };
      }
    }
  });
}
