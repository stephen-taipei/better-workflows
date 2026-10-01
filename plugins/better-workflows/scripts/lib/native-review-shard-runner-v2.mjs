import assert from "node:assert/strict";
import { mkdir, lstat, readdir, realpath, rm } from "node:fs/promises";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

import { canonicalJson, digestObject } from "./core.mjs";
import { contentDigest } from "./native-review-content.mjs";
import { assertPhysicalPath, atomicJson, boundedFile, createJson } from "./native-review-runner.mjs";
import { createOwnedProcessAdapterV1, OWNED_PROCESS_MAX_OUTPUT_BYTES } from "./owned-process-adapter-v1.mjs";
import {
  isTrustedNativeV3Controller,
  NATIVE_V3_EFFECT_LAUNCH_AUTHORIZATION_KIND,
  NATIVE_V3_EFFECT_LAUNCH_RESERVATION_KIND
} from "./native-v3-cooperative-controller.mjs";
import {
  assertReviewShardPlanFresh,
  createReviewCheckpoint,
  createSealedReviewAggregate,
  createSealedReviewLaneReceipt,
  createSealedReviewUnitResult,
  persistReviewCheckpoint,
  readReviewCheckpoint,
  resumeReviewCheckpoint,
  validateReviewCheckpoint,
  validateReviewShardPlanV2,
  validateSealedReviewAggregate,
  validateSealedReviewLaneReceipt,
  validateSealedReviewUnitResult
} from "./native-review-sharded-v2.mjs";

export const NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL = "native-review-shard-runner-v2";
export const NATIVE_REVIEW_SHARD_RUNNER_V2_SCHEMA_VERSION = 1;
export const NATIVE_REVIEW_SHARD_RUNNER_V2_BUDGET_KIND = "NativeReviewBudgetAuthorizationV1";
export const NATIVE_REVIEW_SHARD_RUNNER_V2_ADMISSION_KIND = "NativeReviewAdmissionV1";
export const NATIVE_REVIEW_SHARD_RUNNER_V2_RECEIPT_KIND = "NativeReviewShardRunReceiptV2";
export const NATIVE_REVIEW_V2_EFFECT_BINDING_KIND = "NativeReviewV2EffectBindingV1";

const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_STATUSES = new Set(["COMPLETE", "PAUSED_BUDGET", "HOLD", "UNKNOWN", "BLOCKED"]);
const RESULT_VERDICTS = new Set(["PASS", "BLOCK", "UNKNOWN"]);
const BUDGET_AUTHORIZATIONS = new WeakSet();
const ADMISSIONS = new WeakSet();
const EXECUTOR_CAPABILITIES = new WeakSet();
const EXECUTOR_STARTS = new WeakMap();
const SIMULATION_EXECUTOR_CAPABILITIES = new WeakSet();
const SIMULATION_BUDGET_AUTHORIZATIONS = new WeakSet();
const SIMULATION_STOP_FAILURES = new WeakMap();
const OWNER_LAUNCH_CAPABILITIES = new WeakSet();
const OWNER_LAUNCH_TAILS = new WeakMap();
const SIMULATION_MODES = new Set(["success", "missing-page", "wrong-role", "timeout", "cancel"]);
const DEFAULT_SIMULATION_TIMEOUT_MS = 100;
const CHECKPOINT_SEAL_KEY_KIND = "NativeReviewCheckpointSealKeyV1";
const CHECKPOINT_SEAL_KIND = "NativeReviewCheckpointSealV1";
const CHECKPOINT_SEAL_MAC_KIND = "NativeReviewCheckpointSealMacInputV1";
const INITIALIZATION_PENDING_KIND = "NativeReviewInitializationPendingV1";
const INITIALIZATION_OUTCOME_KIND = "NativeReviewInitializationOutcomeV1";
const INITIALIZATION_OBSERVATION_KIND = "NativeReviewInitializationCleanupObservationV1";
const CHECKPOINT_SEAL_KEY_FILE = ".native-review-shard-runner-v2.key.json";
const CHECKPOINT_SEAL_MAX_BYTES = 128 * 1024;
const MAX_REVIEWER_INVOCATION_SOURCE_BYTES = 65_536;

class NativeReviewShardRunError extends Error {
  constructor(status, code, message, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NativeReviewShardRunError";
    this.status = status;
    this.code = code;
  }
}

class NativeReviewShardBudgetPause extends NativeReviewShardRunError {
  constructor(message) {
    super("PAUSED_BUDGET", "ENATIVE_REVIEW_BUDGET", message);
  }
}

/**
 * Deny-only production prerequisite. No trusted producer currently proves
 * closed reviewer input and immutable receiver/helper runtime provenance.
 * This grants no capability and accepts no caller-controlled trust selector.
 */
export function assertNativeReviewV2ProductionDeliveryAvailable() {
  throw new NativeReviewShardRunError("HOLD", "ENATIVE_REVIEW_TRUSTED_DELIVERY_REQUIRED",
    "Production native review V2 is unavailable: missing trusted source delivery with closed input and immutable runtime provenance");
}

function assertDiagnosticExecutor(executor) {
  if (!isSimulationExecutor(executor)) assertNativeReviewV2ProductionDeliveryAvailable();
}

function assertDiagnosticBudgetAuthorization(authorization) {
  if (!SIMULATION_BUDGET_AUTHORIZATIONS.has(authorization)) assertNativeReviewV2ProductionDeliveryAvailable();
}

function object(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function exact(value, keys, label) {
  object(value, label);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `Unexpected ${label} fields`);
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function safeId(value, label) {
  assert(typeof value === "string" && SAFE_ID.test(value), `${label} must be a safe identifier`);
  return value;
}

function digest(value, label) {
  assert(typeof value === "string" && DIGEST.test(value), `${label} must be a SHA-256 digest`);
  return value;
}

/**
 * Produce the immutable digest input for the V2 owner bridge.  This is a
 * pure binding constructor; it grants no authority and deliberately performs
 * no filesystem or process operation.  Both preparation and the final launch
 * capability use this one shape so a genuine approval cannot be attached to a
 * different command, source, budget, or state directory.
 */
export function createNativeReviewV2EffectBinding({
  plan,
  executor,
  authorization,
  stateDirectory,
  sourceBinding,
  ownerRunId,
  ownerExecutionId,
  ownerAttemptId,
  ownerApprovalExpiresAt,
  ownerTaskId = "native-review-v2",
  ownerUnitId = "native-review-v2-effect",
  lane = null
} = {}) {
  const requestFile = path.join(stateDirectory, `.native-review-v2-input-${ownerExecutionId}.json`);
  const body = {
    schemaVersion: 1,
    kind: NATIVE_REVIEW_V2_EFFECT_BINDING_KIND,
    planDigest: plan.planDigest,
    source: {
      revision: plan.source.head,
      digest: plan.source.sourceDigest
    },
    ownerSourceBinding: {
      revision: sourceBinding.revision,
      digest: sourceBinding.digest
    },
    command: executor.command,
    args: executor.args,
    cwd: executor.cwd,
    env: executor.env,
    timeoutMs: executor.timeoutMs,
    executorDigest: executor.capabilityDigest,
    authorizationDigest: authorization.authDigest,
    grantDigest: authorization.grantDigest,
    policyDigest: digestObject(plan.policy),
    maxBudget: authorization.maxBudget,
    reservation: authorization.reservation,
    runId: authorization.runId,
    epoch: authorization.epoch,
    owner: {
      runId: ownerRunId,
      taskId: ownerTaskId,
      unitId: ownerUnitId,
      executionId: ownerExecutionId,
      attemptId: ownerAttemptId,
      expiresAt: ownerApprovalExpiresAt
    },
    stateDirectory,
    requestFile,
    lane
  };
  return { ...body, effectBindingDigest: digestObject(body) };
}

function assertLaneBinding(value, label = "owner launch lane") {
  if (value === null) return null;
  exact(value, ["batchId", "roleId", "assignmentIds", "unitIds"], label);
  safeId(value.batchId, `${label}.batchId`);
  safeId(value.roleId, `${label}.roleId`);
  assert(Array.isArray(value.assignmentIds) && value.assignmentIds.length > 0 && value.assignmentIds.length <= 32,
    `${label}.assignmentIds is invalid`);
  assert(Array.isArray(value.unitIds) && value.unitIds.length === value.assignmentIds.length,
    `${label}.unitIds is invalid`);
  for (const [index, item] of value.assignmentIds.entries()) safeId(item, `${label}.assignmentIds[${index}]`);
  for (const [index, item] of value.unitIds.entries()) safeId(item, `${label}.unitIds[${index}]`);
  assert.equal(new Set(value.assignmentIds).size, value.assignmentIds.length,
    `${label}.assignmentIds contains duplicates`);
  assert.equal(new Set(value.unitIds).size, value.unitIds.length,
    `${label}.unitIds contains duplicates`);
  return value;
}

function assertBudgetShape(value, keys, label) {
  exact(value, keys, label);
  for (const key of keys) integer(value[key], `${label}.${key}`, { min: 0 });
  return value;
}

function assertOwnerEffectBinding(value, label = "owner launch effect binding") {
  exact(value, [
    "schemaVersion", "kind", "planDigest", "source", "ownerSourceBinding", "command", "args", "cwd", "env",
    "timeoutMs", "executorDigest", "authorizationDigest", "grantDigest", "policyDigest", "maxBudget",
    "reservation", "runId", "epoch", "owner", "stateDirectory", "requestFile", "lane", "effectBindingDigest"
  ], label);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, NATIVE_REVIEW_V2_EFFECT_BINDING_KIND);
  digest(value.planDigest, `${label}.planDigest`);
  exact(value.source, ["revision", "digest"], `${label}.source`);
  safeId(value.source.revision, `${label}.source.revision`);
  digest(value.source.digest, `${label}.source.digest`);
  exact(value.ownerSourceBinding, ["revision", "digest"], `${label}.ownerSourceBinding`);
  safeId(value.ownerSourceBinding.revision, `${label}.ownerSourceBinding.revision`);
  digest(value.ownerSourceBinding.digest, `${label}.ownerSourceBinding.digest`);
  absolutePath(value.command, `${label}.command`);
  assert(Array.isArray(value.args) && value.args.length <= 64 &&
    value.args.every((item) => typeof item === "string" && item.length <= 4096 && !item.includes("\0")),
  `${label}.args is invalid`);
  absolutePath(value.cwd, `${label}.cwd`);
  object(value.env, `${label}.env`);
  assert(Object.keys(value.env).length <= 128 && Object.keys(value.env).every((key) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value.env[key] === "string" &&
    value.env[key].length <= 32 * 1024 && !value.env[key].includes("\0")), `${label}.env is invalid`);
  integer(value.timeoutMs, `${label}.timeoutMs`, { min: 1 });
  digest(value.executorDigest, `${label}.executorDigest`);
  digest(value.authorizationDigest, `${label}.authorizationDigest`);
  digest(value.grantDigest, `${label}.grantDigest`);
  digest(value.policyDigest, `${label}.policyDigest`);
  assertBudgetShape(value.maxBudget, ["elapsedMs", "tokenUnits", "costUnits", "attemptsUsed"], `${label}.maxBudget`);
  assertBudgetShape(value.reservation, ["elapsedMs", "tokenUnits", "costUnits", "attempts"], `${label}.reservation`);
  safeId(value.runId, `${label}.runId`);
  integer(value.epoch, `${label}.epoch`, { min: 1 });
  exact(value.owner, ["runId", "taskId", "unitId", "executionId", "attemptId", "expiresAt"], `${label}.owner`);
  for (const key of ["runId", "taskId", "unitId", "executionId", "attemptId"]) safeId(value.owner[key], `${label}.owner.${key}`);
  assert(typeof value.owner.expiresAt === "string" && Number.isFinite(Date.parse(value.owner.expiresAt)),
    `${label}.owner.expiresAt is invalid`);
  absolutePath(value.stateDirectory, `${label}.stateDirectory`);
  absolutePath(value.requestFile, `${label}.requestFile`);
  assert.equal(path.dirname(value.requestFile), value.stateDirectory,
    `${label}.requestFile must be directly inside stateDirectory`);
  assertLaneBinding(value.lane, `${label}.lane`);
  digest(value.effectBindingDigest, `${label}.effectBindingDigest`);
  const { effectBindingDigest, ...body } = value;
  assert.equal(effectBindingDigest, digestObject(body), `${label}.effectBindingDigest is stale`);
  return value;
}

function assertOwnerLaunchMatchesExecutor(ownerLaunch, capability, context) {
  const effect = assertOwnerEffectBinding(ownerLaunch.effectBinding);
  assert.equal(effect.effectBindingDigest, ownerLaunch.effectBindingDigest,
    "owner launch effect binding digest is not bound to its capability");
  assert.equal(effect.planDigest, capability.planDigest, "owner launch plan is not bound to this executor");
  assert.equal(effect.executorDigest, capability.capabilityDigest, "owner launch executor is not bound");
  assert.equal(effect.command, capability.command, "owner launch command is not bound");
  assert.deepEqual(effect.args, capability.args, "owner launch arguments are not bound");
  assert.equal(effect.cwd, capability.cwd, "owner launch cwd is not bound");
  assert.deepEqual(effect.env, capability.env, "owner launch environment is not bound");
  assert.equal(effect.timeoutMs, capability.timeoutMs, "owner launch timeout is not bound");
  assert.equal(effect.runId, context.runId, "owner launch run is not bound");
  assert.equal(effect.epoch, context.epoch, "owner launch epoch is not bound");
  assert.equal(effect.authorizationDigest, context.authorizationDigest, "owner launch authorization is not bound");
  assert.equal(effect.grantDigest, context.grantDigest, "owner launch grant is not bound");
  assert.equal(effect.stateDirectory, context.stateDirectory, "owner launch state directory is not bound");
  assert.equal(effect.policyDigest, context.policyDigest, "owner launch policy is not bound");
  assert.deepEqual(effect.maxBudget, context.maxBudget, "owner launch maximum budget is not bound");
  assert.deepEqual(effect.reservation, context.reservation, "owner launch reservation is not bound");
  assert.equal(effect.source.revision, context.sourceRevision, "owner launch source revision is not bound");
  assert.equal(effect.source.digest, context.sourceDigest, "owner launch source digest is not bound");
  if (effect.lane !== null) {
    assert.equal(effect.lane.batchId, context.batch.batchId, "owner launch lane batch is not bound");
    assert.equal(effect.lane.roleId, context.role.id, "owner launch lane role is not bound");
    assert.deepEqual(effect.lane.assignmentIds, context.assignments.map(item => item.id),
      "owner launch lane assignments are not bound");
    assert.deepEqual(effect.lane.unitIds, context.units.map(item => item.id),
      "owner launch lane units are not bound");
  }
  return ownerLaunch;
}

function assertLaunchStartLive(context) {
  if (context.signal?.aborted || context.initializationSignal?.aborted) {
    throw new NativeReviewShardRunError("UNKNOWN", "ABORT_ERR",
      "review run was cancelled before the owner launch could start");
  }
}

function assertOwnerLaunchCapability(value, label = "owner launch capability") {
  assert(OWNER_LAUNCH_CAPABILITIES.has(value), `${label} must come from the trusted V3 controller bridge`);
  exact(value, ["kind", "controller", "binding", "authorityEpoch", "fence", "effectBindingDigest", "effectBinding"], label);
  assert.equal(value.kind, "NativeReviewV2TrustedLaunchCapabilityV1");
  assert(isTrustedNativeV3Controller(value.controller), `${label}.controller must be a trusted native V3 controller`);
  assert(typeof value.controller.commitEffectLaunch === "function" &&
      typeof value.controller.authorizeEffectLaunch === "function" &&
      typeof value.controller.commitAuthorizedEffectLaunch === "function",
    `${label}.controller cannot commit and authorize the launch boundary`);
  exact(value.binding, ["runId", "executionId", "attemptId", "unitId", "sourceBindingDigest", "policyDigest", "revision", "ownedResourceId"], `${label}.binding`);
  for (const key of ["runId", "executionId", "attemptId", "unitId", "revision", "ownedResourceId"]) {
    safeId(value.binding[key], `${label}.binding.${key}`);
  }
  for (const key of ["sourceBindingDigest", "policyDigest", "effectBindingDigest", "fence"]) {
    digest(value[key] ?? value.binding[key], `${label}.${key}`);
  }
  assertOwnerEffectBinding(value.effectBinding, `${label}.effectBinding`);
  assert.equal(value.effectBinding.effectBindingDigest, value.effectBindingDigest,
    `${label}.effectBindingDigest is not bound to its effect binding`);
  integer(value.authorityEpoch, `${label}.authorityEpoch`, { min: 1 });
  return value;
}

function assertLaunchReservation(value, ownerLaunch, label = "owner launch reservation") {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} is required`);
  assert.equal(value.kind, NATIVE_V3_EFFECT_LAUNCH_RESERVATION_KIND, `${label}.kind is invalid`);
  const binding = ownerLaunch.binding;
  for (const key of ["runId", "executionId", "attemptId", "unitId", "ownedResourceId", "sourceBindingDigest", "policyDigest", "revision"]) {
    assert.equal(value[key], binding[key], `${label}.${key} is not bound to the owner capability`);
  }
  assert.equal(value.authorityEpoch, ownerLaunch.authorityEpoch, `${label}.authorityEpoch is stale`);
  assert.equal(value.fence, ownerLaunch.fence, `${label}.fence is stale`);
  assert.equal(value.effectBindingDigest, ownerLaunch.effectBindingDigest, `${label}.effectBindingDigest is stale`);
  digest(value.digest, `${label}.digest`);
  assert.equal(value.status, "reserved", `${label}.status is invalid`);
  const { digest: suppliedDigest, ...body } = value;
  assert.equal(suppliedDigest, digestObject(body), `${label}.digest is stale`);
  return value;
}

function assertLaunchAuthorization(value, ownerLaunch, reservation, label = "owner launch authorization") {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} is required`);
  exact(value, [
    "schemaVersion", "kind", "authorizationId", "reservationId", "reservationDigest", "runId", "executionId",
    "attemptId", "unitId", "ownedResourceId", "sourceBindingDigest", "policyDigest", "revision",
    "effectBindingDigest", "authorityEpoch", "fence", "status", "authorizedAt", "digest"
  ], label);
  assert.equal(value.schemaVersion, 1, `${label}.schemaVersion is invalid`);
  assert.equal(value.kind, NATIVE_V3_EFFECT_LAUNCH_AUTHORIZATION_KIND, `${label}.kind is invalid`);
  for (const key of ["authorizationId", "reservationId", "runId", "executionId", "attemptId", "unitId", "ownedResourceId"]) {
    safeId(value[key], `${label}.${key}`);
  }
  for (const key of ["reservationDigest", "sourceBindingDigest", "policyDigest", "effectBindingDigest", "fence"]) {
    digest(value[key], `${label}.${key}`);
  }
  safeId(value.revision, `${label}.revision`);
  integer(value.authorityEpoch, `${label}.authorityEpoch`, { min: 1 });
  assert.equal(value.status, "authorized", `${label}.status is invalid`);
  assert(typeof value.authorizedAt === "string" && Number.isFinite(Date.parse(value.authorizedAt)),
    `${label}.authorizedAt is invalid`);
  const binding = ownerLaunch.binding;
  for (const key of ["runId", "executionId", "attemptId", "unitId", "ownedResourceId", "sourceBindingDigest", "policyDigest", "revision"]) {
    assert.equal(value[key], binding[key], `${label}.${key} is not bound to the owner capability`);
  }
  assert.equal(value.authorityEpoch, ownerLaunch.authorityEpoch, `${label}.authorityEpoch is stale`);
  assert.equal(value.fence, ownerLaunch.fence, `${label}.fence is stale`);
  assert.equal(value.effectBindingDigest, ownerLaunch.effectBindingDigest, `${label}.effectBindingDigest is stale`);
  assert.equal(value.reservationId, reservation.reservationId, `${label}.reservationId is not bound to the reservation`);
  assert.equal(value.reservationDigest, reservation.digest, `${label}.reservationDigest is stale`);
  digest(value.digest, `${label}.digest`);
  const { digest: suppliedDigest, ...body } = value;
  assert.equal(suppliedDigest, digestObject(body), `${label}.digest is stale`);
  return value;
}

async function commitOwnerLaunch(ownerLaunch) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  assertOwnerLaunchCapability(ownerLaunch);
  const previous = OWNER_LAUNCH_TAILS.get(ownerLaunch) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const launchReservation = await ownerLaunch.controller.commitEffectLaunch({
      ...ownerLaunch.binding,
      authorityEpoch: ownerLaunch.authorityEpoch,
      fence: ownerLaunch.fence,
      effectBindingDigest: ownerLaunch.effectBindingDigest
    });
    const reservation = assertLaunchReservation(launchReservation, ownerLaunch);
    const launchAuthorization = await ownerLaunch.controller.authorizeEffectLaunch({
      ...ownerLaunch.binding,
      authorityEpoch: ownerLaunch.authorityEpoch,
      fence: ownerLaunch.fence,
      effectBindingDigest: ownerLaunch.effectBindingDigest,
      reservationId: reservation.reservationId,
      reservationDigest: reservation.digest
    });
    return {
      reservation,
      authorization: assertLaunchAuthorization(launchAuthorization, ownerLaunch, reservation)
    };
  });
  OWNER_LAUNCH_TAILS.set(ownerLaunch, operation);
  try {
    return await operation;
  } finally {
    if (OWNER_LAUNCH_TAILS.get(ownerLaunch) === operation) OWNER_LAUNCH_TAILS.delete(ownerLaunch);
  }
}

/**
 * This production entry rejects missing trusted delivery before touching the
 * controller. The preserved bridge binds the V2 host transport to an already
 * approved cooperative V3 allocation. The controller is retained privately so a
 * JSON copy cannot become a launch capability.  The executor obtains the
 * producer's reservation and authorization immediately before its host
 * capture.  The supervisor launch-frame linearization remains owned by the
 * POSIX adapter; this direct transport does not claim to close that later
 * revoke-to-spawn race.
 */
export async function createTrustedReviewOwnerLaunchCapabilityV2(options = {}) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  const { controller, binding, authorityEpoch, fence, effectBindingDigest, effectBinding } = options;
  assert(isTrustedNativeV3Controller(controller), "owner launch controller must come from the native V3 producer");
  assert(typeof controller.readExecutionBinding === "function" &&
      typeof controller.commitEffectLaunch === "function" &&
      typeof controller.authorizeEffectLaunch === "function" &&
      typeof controller.commitAuthorizedEffectLaunch === "function",
    "owner launch controller cannot attest, reserve, and authorize an effect boundary");
  exact(binding, ["runId", "executionId", "attemptId", "unitId", "sourceBindingDigest", "policyDigest", "revision", "ownedResourceId"], "owner launch binding");
  for (const key of ["runId", "executionId", "attemptId", "unitId", "revision", "ownedResourceId"]) {
    safeId(binding[key], `owner launch binding.${key}`);
  }
  for (const key of ["sourceBindingDigest", "policyDigest"]) digest(binding[key], `owner launch binding.${key}`);
  integer(authorityEpoch, "owner launch authorityEpoch", { min: 1 });
  digest(fence, "owner launch fence");
  digest(effectBindingDigest, "owner launch effectBindingDigest");
  assertOwnerEffectBinding(effectBinding);
  assert.equal(effectBinding.effectBindingDigest, effectBindingDigest,
    "owner launch effect binding digest is not bound to the supplied effect");
  const observed = await controller.readExecutionBinding({
    runId: binding.runId,
    binding: structuredClone(binding)
  });
  assert(observed && typeof observed === "object" && !Array.isArray(observed) && observed.authority,
    "owner launch controller returned no execution binding");
  const authority = observed.authority;
  for (const key of Object.keys(binding)) {
    assert.equal(authority[key], binding[key], `owner launch authority.${key} is not bound`);
  }
  assert.equal(authority.authorityEpoch, authorityEpoch, "owner launch authority epoch is stale");
  assert.equal(authority.fence, fence, "owner launch authority fence is stale");
  assert.equal(authority.status, "active", "owner launch authority is not active");
  assert.equal(authority.revoked, false, "owner launch authority is revoked");
  const capability = Object.freeze({
    kind: "NativeReviewV2TrustedLaunchCapabilityV1",
    controller,
    binding: deepFreeze(structuredClone(binding)),
    authorityEpoch,
    fence,
    effectBindingDigest,
    effectBinding: deepFreeze(structuredClone(effectBinding))
  });
  OWNER_LAUNCH_CAPABILITIES.add(capability);
  return assertOwnerLaunchCapability(capability);
}

function integer(value, label, { min = 0 } = {}) {
  assert(Number.isSafeInteger(value) && value >= min, `${label} must be a bounded integer`);
  return value;
}

function absolutePath(value, label) {
  assert(typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value && !value.includes("\0"),
    `${label} must be an absolute normalized path`);
  return value;
}

async function assertStateScopedFile(directory, target, label) {
  absolutePath(directory, `${label} stateDirectory`);
  absolutePath(target, label);
  await assertPhysicalPath(directory, `${label} stateDirectory`, { directory: true });
  const statePath = await realpath(directory);
  const parentPath = path.dirname(target);
  await assertPhysicalPath(parentPath, `${label} parent`, { directory: true });
  const physicalParent = await realpath(parentPath);
  const statePrefix = statePath.endsWith(path.sep) ? statePath : `${statePath}${path.sep}`;
  assert(physicalParent === statePath || physicalParent.startsWith(statePrefix),
    `${label} must be physically inside the runner state directory`);
  await assertPhysicalPath(target, label);
  return target;
}

function plainCopy(value) {
  return structuredClone(value);
}

function requiredAssignmentIds(plan) {
  return plan.assignments.filter(item => item.required).map(item => item.id);
}

function requiredLaneCount(plan) {
  return plan.batches.length * plan.roles.filter(item => item.required).length;
}

function assertBudgetAuthorization(value, plan, label = "budget authorization") {
  assertDiagnosticBudgetAuthorization(value);
  assert(BUDGET_AUTHORIZATIONS.has(value), `${label} must come from the trusted budget producer`);
  exact(value, ["schemaVersion", "kind", "protocol", "sealed", "planDigest", "sourceDigest", "policyDigest",
    "runId", "epoch", "executorDigest", "grantDigest", "maxBudget", "reservation", "authDigest"], label);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, NATIVE_REVIEW_SHARD_RUNNER_V2_BUDGET_KIND);
  assert.equal(value.protocol, NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL);
  assert.equal(value.sealed, true);
  const canonicalPlan = validateReviewShardPlanV2(plan);
  assert.equal(value.planDigest, canonicalPlan.planDigest);
  assert.equal(value.sourceDigest, canonicalPlan.source.sourceDigest);
  assert.equal(value.policyDigest, digestObject(canonicalPlan.policy));
  safeId(value.runId, `${label}.runId`);
  integer(value.epoch, `${label}.epoch`, { min: 1 });
  digest(value.executorDigest, `${label}.executorDigest`);
  digest(value.grantDigest, `${label}.grantDigest`);
  exact(value.maxBudget, ["elapsedMs", "tokenUnits", "costUnits", "attemptsUsed"], `${label}.maxBudget`);
  exact(value.reservation, ["elapsedMs", "tokenUnits", "costUnits", "attempts"], `${label}.reservation`);
  for (const key of Object.keys(value.maxBudget)) integer(value.maxBudget[key], `${label}.maxBudget.${key}`);
  for (const key of Object.keys(value.reservation)) integer(value.reservation[key], `${label}.reservation.${key}`, { min: 1 });
  assert(value.maxBudget.elapsedMs >= value.reservation.elapsedMs);
  assert(value.maxBudget.tokenUnits >= value.reservation.tokenUnits);
  assert(value.maxBudget.costUnits >= value.reservation.costUnits);
  assert(value.maxBudget.attemptsUsed >= value.reservation.attempts);
  assert.equal(value.maxBudget.elapsedMs <= canonicalPlan.policy.maxTotalTimeMs - canonicalPlan.policy.cleanupReserveMs, true,
    `${label}.maxBudget.elapsedMs must retain cleanup reserve`);
  const laneLimit = requiredLaneCount(canonicalPlan);
  assert(value.maxBudget.tokenUnits <= laneLimit, `${label}.maxBudget.tokenUnits exceeds the plan lane bound`);
  assert(value.maxBudget.costUnits <= laneLimit, `${label}.maxBudget.costUnits exceeds the plan lane bound`);
  assert(value.maxBudget.attemptsUsed <= laneLimit, `${label}.maxBudget.attemptsUsed exceeds the plan lane bound`);
  const { authDigest, ...authBody } = value;
  assert.equal(authDigest, digestObject(authBody), `${label}.authDigest is stale`);
  return value;
}

/**
 * Produce the bounded budget capability consumed by this runner. A budget is
 * currently minted only for private no-effect simulation diagnostics;
 * production is denied while trusted source delivery is missing. The caller may
 * choose a smaller reservation/cap, which can only pause work; every value is
 * bounded by the fixed V5 policy and the grant digest binds the choice to the
 * executor capability. The object is never accepted from JSON.
 */
export function createTrustedReviewBudgetAuthorizationV2({
  plan,
  executor,
  runId,
  epoch,
  grantDigest = undefined,
  maxBudget = undefined,
  reservation = undefined
} = {}) {
  assertDiagnosticExecutor(executor);
  const canonicalPlan = validateReviewShardPlanV2(plan);
  assertExecutorCapability(executor, canonicalPlan);
  if (canonicalPlan.budget.status !== "READY") {
    throw new NativeReviewShardBudgetPause("Review plan is PAUSED_BUDGET and cannot dispatch");
  }
  safeId(runId, "runId");
  integer(epoch, "epoch", { min: 1 });
  if (grantDigest !== undefined) digest(grantDigest, "grantDigest");
  const laneCount = requiredLaneCount(canonicalPlan);
  const defaultReservation = {
    elapsedMs: canonicalPlan.policy.targetTimeoutMs,
    tokenUnits: 1,
    costUnits: 1,
    attempts: 1
  };
  const normalizedReservation = { ...defaultReservation, ...(reservation ?? {}) };
  exact(normalizedReservation, ["elapsedMs", "tokenUnits", "costUnits", "attempts"], "budget reservation");
  for (const key of Object.keys(normalizedReservation)) integer(normalizedReservation[key], `reservation.${key}`, { min: 1 });
  const defaultMax = {
    elapsedMs: canonicalPlan.policy.maxTotalTimeMs - canonicalPlan.policy.cleanupReserveMs,
    tokenUnits: laneCount,
    costUnits: laneCount,
    attemptsUsed: laneCount
  };
  const normalizedMax = { ...defaultMax, ...(maxBudget ?? {}) };
  exact(normalizedMax, ["elapsedMs", "tokenUnits", "costUnits", "attemptsUsed"], "authorized review budget");
  for (const key of Object.keys(normalizedMax)) integer(normalizedMax[key], `maxBudget.${key}`);
  const body = {
    schemaVersion: 1,
    kind: NATIVE_REVIEW_SHARD_RUNNER_V2_BUDGET_KIND,
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    sealed: true,
    planDigest: canonicalPlan.planDigest,
    sourceDigest: canonicalPlan.source.sourceDigest,
    policyDigest: digestObject(canonicalPlan.policy),
    runId,
    epoch,
    executorDigest: executor.capabilityDigest,
    grantDigest,
    maxBudget: normalizedMax,
    reservation: normalizedReservation
  };
  const grantBody = {
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    kind: "NativeReviewHostBudgetGrantV1",
    planDigest: canonicalPlan.planDigest,
    executorDigest: executor.capabilityDigest,
    runId,
    epoch,
    maxBudget: normalizedMax,
    reservation: normalizedReservation
  };
  const expectedGrantDigest = digestObject(grantBody);
  if (grantDigest !== undefined) assert.equal(grantDigest, expectedGrantDigest, "grantDigest is not bound to the host executor budget");
  body.grantDigest = expectedGrantDigest;
  const authorization = deepFreeze({ ...body, authDigest: digestObject(body) });
  BUDGET_AUTHORIZATIONS.add(authorization);
  // Only an in-process no-effect simulation can reach this diagnostic mint.
  // The private brand is not persisted and cannot qualify legacy evidence.
  SIMULATION_BUDGET_AUTHORIZATIONS.add(authorization);
  assertBudgetAuthorization(authorization, canonicalPlan);
  return authorization;
}

function assertAdmission(value, plan, authorization) {
  assert(ADMISSIONS.has(value), "review admission must come from the trusted admission producer");
  exact(value, ["schemaVersion", "kind", "protocol", "sealed", "status", "planDigest", "sourceDigest", "policyDigest",
    "runId", "epoch", "grantDigest", "authDigest", "admissionDigest"], "review admission");
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, NATIVE_REVIEW_SHARD_RUNNER_V2_ADMISSION_KIND);
  assert.equal(value.protocol, NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL);
  assert.equal(value.sealed, true);
  assert.equal(value.status, "admitted");
  const canonicalPlan = validateReviewShardPlanV2(plan);
  assertBudgetAuthorization(authorization, canonicalPlan);
  assert.equal(value.planDigest, canonicalPlan.planDigest);
  assert.equal(value.sourceDigest, canonicalPlan.source.sourceDigest);
  assert.equal(value.policyDigest, digestObject(canonicalPlan.policy));
  assert.equal(value.runId, authorization.runId);
  assert.equal(value.epoch, authorization.epoch);
  assert.equal(value.grantDigest, authorization.grantDigest);
  assert.equal(value.authDigest, authorization.authDigest);
  const { admissionDigest, ...admissionBody } = value;
  assert.equal(admissionDigest, digestObject(admissionBody), "review admission digest is stale");
  return value;
}

/** Capture freshness for private simulation diagnostics; production admission is denied. */
export async function createTrustedReviewAdmissionV2({ plan, authorization } = {}) {
  assertDiagnosticBudgetAuthorization(authorization);
  const canonicalPlan = validateReviewShardPlanV2(plan);
  assertBudgetAuthorization(authorization, canonicalPlan);
  await assertReviewShardPlanFresh(canonicalPlan);
  const body = {
    schemaVersion: 1,
    kind: NATIVE_REVIEW_SHARD_RUNNER_V2_ADMISSION_KIND,
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    sealed: true,
    status: "admitted",
    planDigest: canonicalPlan.planDigest,
    sourceDigest: canonicalPlan.source.sourceDigest,
    policyDigest: digestObject(canonicalPlan.policy),
    runId: authorization.runId,
    epoch: authorization.epoch,
    grantDigest: authorization.grantDigest,
    authDigest: authorization.authDigest
  };
  const admission = deepFreeze({ ...body, admissionDigest: digestObject(body) });
  ADMISSIONS.add(admission);
  return assertAdmission(admission, canonicalPlan, authorization);
}

function assertSimulationExecutorCapability(value, plan) {
  assert(SIMULATION_EXECUTOR_CAPABILITIES.has(value),
    "review simulation executor must come from the explicit no-effect simulation producer");
  exact(value, ["schemaVersion", "kind", "protocol", "planDigest", "mode", "timeoutMs", "capabilityDigest"],
    "review simulation executor capability");
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, "NativeReviewSimulationExecutorCapabilityV1");
  assert.equal(value.protocol, NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL);
  const canonicalPlan = validateReviewShardPlanV2(plan);
  assert.equal(value.planDigest, canonicalPlan.planDigest);
  assert(SIMULATION_MODES.has(value.mode), "review simulation mode is invalid");
  assert(value.timeoutMs === null || Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 1,
    "review simulation timeout is invalid");
  const { capabilityDigest, ...body } = value;
  assert.equal(capabilityDigest, digestObject(body), "simulation executor capability digest is stale");
  return value;
}

function isSimulationExecutor(value) {
  return Boolean(value && SIMULATION_EXECUTOR_CAPABILITIES.has(value));
}

function assertExecutorCapability(value, plan) {
  if (isSimulationExecutor(value)) return assertSimulationExecutorCapability(value, plan);
  assertNativeReviewV2ProductionDeliveryAvailable();
  assert(EXECUTOR_CAPABILITIES.has(value), "review executor must come from the concrete host transport producer");
  exact(value, ["schemaVersion", "kind", "protocol", "planDigest", "command", "args", "cwd", "env", "timeoutMs", "capabilityDigest"], "review executor capability");
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, "NativeReviewHostExecutorCapabilityV1");
  assert.equal(value.protocol, NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL);
  const canonicalPlan = validateReviewShardPlanV2(plan);
  assert.equal(value.planDigest, canonicalPlan.planDigest);
  absolutePath(value.command, "executor.command");
  assert(Array.isArray(value.args) && value.args.every(item => typeof item === "string" && item.length <= 4096));
  absolutePath(value.cwd, "executor.cwd");
  object(value.env, "executor.env");
  assert(Object.keys(value.env).every(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value.env[key] === "string" && !value.env[key].includes("\0")));
  integer(value.timeoutMs, "executor.timeoutMs", { min: 1 });
  assert(value.timeoutMs <= canonicalPlan.policy.hardTimeoutMs, "executor timeout exceeds the v2 hard phase bound");
  const { capabilityDigest, ...body } = value;
  assert.equal(capabilityDigest, digestObject(body), "executor capability digest is stale");
  return value;
}

/**
 * Production is denied before any executor is minted while trusted source
 * delivery is missing. The preserved child transport uses the existing host-trust process-group
 * supervisor; its stdout is untrusted review data and never an execution
 * attestation. This adapter is also suitable for a local fake provider, whose
 * output remains untrusted review data.  A real host cannot be started through
 * this capability without the trusted current V3 owner launch capability; use
 * the explicit no-effect simulation producer below for local fixture data.
 */
export async function createNativeReviewHostExecutorV2(options = {}) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  const { plan, command, args = [], cwd, env, timeoutMs = undefined } = options;
  const canonicalPlan = validateReviewShardPlanV2(plan);
  absolutePath(command, "executor.command");
  const executable = await assertPhysicalPath(command, "executor.command");
  const commandInfo = executable.components.at(-1);
  assert(commandInfo && !commandInfo.directory, "executor.command must be a file");
  assert(Array.isArray(args) && args.length <= 64 && args.every(item => typeof item === "string" && item.length <= 4096),
    "executor args are invalid or unbounded");
  absolutePath(cwd, "executor.cwd");
  await assertPhysicalPath(cwd, "executor.cwd", { directory: true });
  object(env, "executor.env");
  assert(Object.keys(env).length <= 128 && Object.keys(env).every(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
    typeof env[key] === "string" && !env[key].includes("\0") && env[key].length <= 32 * 1024), "executor environment is invalid");
  const selectedTimeout = timeoutMs ?? canonicalPlan.policy.hardTimeoutMs;
  integer(selectedTimeout, "executor.timeoutMs", { min: 1 });
  assert(selectedTimeout <= canonicalPlan.policy.hardTimeoutMs, "executor timeout exceeds the v2 hard phase bound");
  const body = {
    schemaVersion: 1,
    kind: "NativeReviewHostExecutorCapabilityV1",
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    planDigest: canonicalPlan.planDigest,
    command: executable.path,
    args: [...args],
    cwd,
    env: { ...env },
    timeoutMs: selectedTimeout
  };
  const capabilityDigest = digestObject(body);
  const capability = { ...body, capabilityDigest };
  const start = async (context, ownerLaunch) => {
    assertNativeReviewV2ProductionDeliveryAvailable();
    assert(context && context.planDigest === canonicalPlan.planDigest, "executor context is outside the frozen review plan");
    safeId(context.executionId, "executor context.executionId");
    assert(ownerLaunch !== undefined && ownerLaunch !== null,
      "a real host launch requires a trusted current V3 owner capability");
    assertLaunchStartLive(context);
    assertOwnerLaunchCapability(ownerLaunch);
    assertOwnerLaunchMatchesExecutor(ownerLaunch, capability, context);
    // A real V2 host is launched only by the existing POSIX adapter.  The
    // adapter owns the supervisor handshake and invokes the controller's
    // reservation -> authorization -> commitAuthorizedEffectLaunch CAS.  No
    // caller callback, PID, or serialized object is accepted at this seam.
    const handleId = `v2-${context.executionId}`;
    const intentId = `intent-${context.executionId}`;
    safeId(handleId, "V2 owned handleId");
    safeId(intentId, "V2 owned intentId");
    const ownedExecutionContext = Object.freeze({
      schemaVersion: 1,
      handleId,
      intentId,
      binding: structuredClone(ownerLaunch.binding),
      authorityEpoch: ownerLaunch.authorityEpoch,
      fence: ownerLaunch.fence
    });
    const adapter = createOwnedProcessAdapterV1({
      root: context.stateDirectory,
      trustedController: ownerLaunch.controller
    });
    const input = {
      protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
      planDigest: context.planDigest,
      admissionDigest: context.admissionDigest,
      epoch: context.epoch,
      executionId: context.executionId,
      batch: context.batch,
      assignments: context.assignments,
      role: context.role,
      units: context.units,
      context: context.context
    };
    const inputPath = ownerLaunch.effectBinding.requestFile;
    assert.equal(path.dirname(inputPath), context.stateDirectory,
      "V2 host request file is outside the bound state directory");
    await atomicJson(inputPath, input);
    const stopRequest = () => ({
      runId: ownerLaunch.binding.runId,
      handleId,
      ownedResourceId: ownerLaunch.binding.ownedResourceId,
      reason: "native-review-v2 cancellation",
      requestedBy: "native-review-shard-runner-v2"
    });
    let started = null;
    let stopPromise = null;
    let aborted = context.signal?.aborted === true || context.initializationSignal?.aborted === true;
    const stopOwned = () => {
      stopPromise ??= adapter.stopOwned({
        request: stopRequest(),
        ownedResourceId: ownerLaunch.binding.ownedResourceId,
        scope: { runId: ownerLaunch.binding.runId, handleId }
      });
      return stopPromise;
    };
    const forwardAbort = () => {
      aborted = true;
      void stopOwned().catch(() => {});
    };
    const forwardInitializationAbort = () => {
      aborted = true;
      void stopOwned().catch(() => {});
    };
    context.signal?.addEventListener("abort", forwardAbort, { once: true });
    context.initializationSignal?.addEventListener("abort", forwardInitializationAbort, { once: true });
    try {
      if (aborted) assertLaunchStartLive({ ...context, signal: { aborted: true } });
      started = await adapter.startOwned(ownedExecutionContext, {
        command: capability.command,
        args: capability.args,
        cwd: capability.cwd,
        // The POSIX supervisor deliberately gives the target no stdin.  The
        // request is therefore exposed through one run-scoped, atomically
        // written path that is itself bound by the owner effect digest.  The
        // reserved variable is a data channel; it cannot select a command or
        // alter the controller authority.
        env: { ...capability.env, BW_NATIVE_REVIEW_INPUT_PATH: inputPath },
        effectBindingDigest: ownerLaunch.effectBindingDigest,
        maxOutputBytes: OWNED_PROCESS_MAX_OUTPUT_BYTES
      });
      // The bounded initialization signal belongs only to the supervisor
      // handshake. Once startOwned has returned a live owned handle, the
      // outer startWithDeadline finally block closes that signal; carrying
      // it into the target lifetime would terminate a successfully-started
      // child as a false initialization cancellation.
      context.initializationSignal?.removeEventListener("abort", forwardInitializationAbort);
      // The initialization deadline may win while the adapter is completing
      // its trusted handshake.  Stop the owned allocation before publishing
      // a handle; a late start never becomes a live V2 lane.
      if (aborted || context.signal?.aborted || context.initializationSignal?.aborted) {
        const stopped = await stopOwned().catch(() => null);
        if (!stopped || stopped.localOutcome !== "stopped" || stopped.confirmedOwnedScope !== true) {
          const error = new NativeReviewShardRunError("UNKNOWN", "EOWNED_PROCESS_CLEANUP_UNKNOWN",
            "V2 host launch was cancelled but owned cleanup could not be proven");
          error.cleanup = stopped;
          throw error;
        }
        throw new NativeReviewShardRunError("UNKNOWN", "ABORT_ERR",
          "review run was cancelled before the owner launch could start");
      }
    } catch (error) {
      context.signal?.removeEventListener("abort", forwardAbort);
      context.initializationSignal?.removeEventListener("abort", forwardInitializationAbort);
      if (started === null) await stopOwned().catch(() => {});
      await rm(inputPath, { force: true }).catch(() => {});
      throw error;
    }
    const capture = started.completion;
    const wait = async () => {
      const observed = await capture;
      if (observed.outcome !== "stopped" || observed.groupTerminated !== true) {
        const error = new Error("host review executor timed out");
        error.code = observed.outcome === "indeterminate" ? "EOWNED_PROCESS_CLEANUP_UNKNOWN" : "ETIMEDOUT";
        error.execution = observed;
        throw error;
      }
      if (observed.outputExceeded) {
        const error = new Error("host review executor output exceeded its bound");
        error.code = "ERR_OUTPUT_LIMIT";
        throw error;
      }
      if (observed.code !== 0 || observed.signal !== null) {
        const error = new Error("host review executor did not exit cleanly");
        error.code = "EEXECUTION";
        error.execution = observed;
        throw error;
      }
      let envelope;
      try { envelope = JSON.parse(String(observed.stdout).trim()); }
      catch (error) { throw new NativeReviewShardRunError("HOLD", "ENATIVE_REVIEW_EXECUTOR_JSON", "host executor output is not JSON", error); }
      exact(envelope, ["eventStream", "usage"], "host executor envelope");
      assert(typeof envelope.eventStream === "string" && envelope.eventStream.length > 0);
      exact(envelope.usage, ["elapsedMs", "tokenUnits", "costUnits", "attemptsUsed"], "host executor usage");
      const execution = {
        executionId: context.executionId,
        traceSha256: contentDigest(Buffer.from(envelope.eventStream)),
        code: observed.code,
        signal: observed.signal,
        groupTerminated: observed.groupTerminated,
        cleaned: observed.groupTerminated === true
      };
      return { eventStream: envelope.eventStream, execution, usage: envelope.usage };
    };
    const stop = async reason => {
      aborted = true;
      const observed = await stopOwned().catch(() => null);
      return {
        groupTerminated: observed?.confirmedOwnedScope === true && observed?.localOutcome === "stopped",
        cleaned: observed?.confirmedOwnedScope === true && observed?.localOutcome === "stopped"
      };
    };
    return {
      wait,
      stop: async reason => {
        try { return await stop(reason); }
        finally {
          context.signal?.removeEventListener("abort", forwardAbort);
          context.initializationSignal?.removeEventListener("abort", forwardInitializationAbort);
          await rm(inputPath, { force: true }).catch(() => {});
        }
      }
    };
  };
  Object.freeze(capability);
  EXECUTOR_STARTS.set(capability, start);
  EXECUTOR_CAPABILITIES.add(capability);
  return assertExecutorCapability(capability, canonicalPlan);
}

function simulationEventStream(context, mode) {
  const roleId = mode === "wrong-role" ? "forged" : context.role.id;
  const events = [{
    type: "bw.transport.bound",
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    planDigest: context.planDigest,
    admissionDigest: context.admissionDigest,
    batchId: context.batch.batchId,
    roleId,
    assignmentIds: context.assignments.map(item => item.id),
    unitIds: context.units.map(item => item.id),
    executionId: context.executionId,
    contextDigest: context.context.digest
  }];
  context.assignments.forEach((assignment, assignmentIndex) => {
    const unit = context.units[assignmentIndex];
    assert(unit, "simulation assignment references an unknown unit");
    const pages = expectedPages(unit, 64 * 1024);
    pages.forEach((page, pageIndex) => {
      if (mode === "missing-page" && assignmentIndex === 0 && pageIndex === 0) return;
      events.push({
        type: "bw.content.page",
        protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
        assignmentId: assignment.id,
        unitId: unit.id,
        page
      });
      events.push({
        type: "bw.content.ack",
        protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
        assignmentId: assignment.id,
        unitId: unit.id,
        offset: page.offset,
        sha256: page.sha256,
        eof: page.eof
      });
    });
    events.push({
      type: "bw.review.final",
      protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
      assignmentId: assignment.id,
      unitId: unit.id,
      verdict: "PASS",
      reason: null,
      findings: []
    });
  });
  events.push({
    type: "bw.transport.terminal",
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    batchId: context.batch.batchId,
    roleId,
    assignmentIds: context.assignments.map(item => item.id),
    unitIds: context.units.map(item => item.id),
    executionId: context.executionId,
    contentEof: true,
    acknowledged: true
  });
  return events.map(event => JSON.stringify(event)).join("\n") + "\n";
}

async function createSimulationExecutor({ plan, mode = "success", timeoutMs = undefined, onStart = undefined, stopError = undefined } = {}) {
  const canonicalPlan = validateReviewShardPlanV2(plan);
  assert(SIMULATION_MODES.has(mode), "review simulation mode is invalid");
  if (timeoutMs !== undefined) integer(timeoutMs, "simulation timeoutMs", { min: 1 });
  if (onStart !== undefined) assert(typeof onStart === "function", "simulation onStart must be a function");
  if (stopError !== undefined) {
    exact(stopError, ["code", "message"], "simulation stop failure");
    assert(typeof stopError.code === "string" && stopError.code.length > 0, "simulation stop failure code is invalid");
    assert(typeof stopError.message === "string" && stopError.message.length > 0, "simulation stop failure message is invalid");
  }
  const body = {
    schemaVersion: 1,
    kind: "NativeReviewSimulationExecutorCapabilityV1",
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    planDigest: canonicalPlan.planDigest,
    mode,
    timeoutMs: timeoutMs ?? null
  };
  const capability = Object.freeze({ ...body, capabilityDigest: digestObject(body) });
  const start = async (context, ownerLaunch = null) => {
    assert(context && context.planDigest === canonicalPlan.planDigest,
      "simulation executor context is outside the frozen review plan");
    assert(ownerLaunch === undefined || ownerLaunch === null,
      "no-effect simulation executor cannot accept a host launch capability");
    if (onStart) await onStart(structuredClone(context));
    let stopped = false;
    let timeoutHandle;
    const wait = async () => {
      if (mode === "cancel") return new Promise(() => {});
      if (mode === "timeout") {
        return new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            timeoutHandle = undefined;
            const error = new Error("simulation host executor timed out");
            error.code = "ETIMEDOUT";
            reject(error);
          }, timeoutMs ?? DEFAULT_SIMULATION_TIMEOUT_MS);
        });
      }
      const eventStream = simulationEventStream(context, mode);
      return {
        eventStream,
        execution: {
          executionId: context.executionId,
          traceSha256: contentDigest(Buffer.from(eventStream)),
          code: 0,
          signal: null,
          groupTerminated: true,
          cleaned: true
        },
        usage: { elapsedMs: 1, tokenUnits: 1, costUnits: 1, attemptsUsed: 1 }
      };
    };
    const stop = async () => {
      stopped = true;
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      const failure = SIMULATION_STOP_FAILURES.get(capability);
      if (failure) {
        const error = new Error(failure.message);
        error.code = failure.code;
        throw error;
      }
      return { groupTerminated: true, cleaned: true };
    };
    return {
      wait,
      stop: async () => {
        if (!stopped) stopped = true;
        return stop();
      }
    };
  };
  EXECUTOR_STARTS.set(capability, start);
  SIMULATION_EXECUTOR_CAPABILITIES.add(capability);
  if (stopError !== undefined) SIMULATION_STOP_FAILURES.set(capability, Object.freeze({ ...stopError }));
  return assertSimulationExecutorCapability(capability, canonicalPlan);
}

/** Build an explicit no-effect fixture transport; this never starts a process. */
export async function createNativeReviewSimulationExecutorV2({ plan, mode = "success" } = {}) {
  return createSimulationExecutor({ plan, mode });
}

/** Test-only simulation hook for deterministic drift/cancellation/cleanup coverage. */
export async function __testCreateNativeReviewSimulationExecutorV2({ plan, mode = "success", timeoutMs = undefined, onStart = undefined, stopError = undefined } = {}) {
  return createSimulationExecutor({ plan, mode, timeoutMs, onStart, stopError });
}

function assertReviewerInvocationSourceBudget(units) {
  assert(Array.isArray(units) && units.length > 0, "review invocation must include source units");
  let totalBytes = 0;
  for (const [index, unit] of units.entries()) {
    assert(unit && typeof unit === "object" && !Array.isArray(unit), `review invocation unit ${index} is invalid`);
    const bytes = unit.source?.bytes;
    assert(Number.isSafeInteger(bytes) && bytes >= 0, `review invocation unit ${index} has invalid source bytes`);
    assert(totalBytes <= Number.MAX_SAFE_INTEGER - bytes, "review invocation source byte total exceeds the safe integer range");
    totalBytes += bytes;
  }
  if (totalBytes > MAX_REVIEWER_INVOCATION_SOURCE_BYTES) {
    throw new NativeReviewShardBudgetPause(
      `Review invocation pinned source exceeds ${MAX_REVIEWER_INVOCATION_SOURCE_BYTES} raw Git blob bytes; explicit rescope is required before dispatch`);
  }
  return totalBytes;
}

function startExecutor(executor, context, ownerLaunch = null) {
  assertDiagnosticExecutor(executor);
  assert(Array.isArray(context.units) && Array.isArray(context.assignments),
    "review invocation assignments and source units are required");
  assert.deepEqual(context.units.map(unit => unit.id), context.assignments.map(item => item.unitId),
    "review invocation source units do not match its assignments");
  assertReviewerInvocationSourceBudget(context.units);
  assertExecutorCapability(executor, context.plan);
  const start = EXECUTOR_STARTS.get(executor);
  assert(start, "review executor start capability is private");
  return start(context, ownerLaunch);
}

function validatePlanExecutionBounds(plan) {
  const contextBytes = plan.context.paths.reduce((sum, item) => sum + item.bytes, 0);
  assert.equal(contextBytes, plan.context.bytes);
  assert(contextBytes <= plan.policy.maxSharedContextBytes, "Review context exceeds the v2 shared-context budget");
  const units = new Map(plan.units.map(unit => [unit.id, unit]));
  for (const batch of plan.batches) {
    assert(batch.unitIds.length <= plan.policy.maxPrimaryUnits && batch.unitIds.length <= 32,
      "Review batch exceeds the primary-unit budget");
    for (const unitId of batch.unitIds) {
      const unit = units.get(unitId);
      assert(unit, "Review batch references an unknown unit");
      if (unit.kind !== "whole-file-integration") {
        assert(unit.source.bytes <= plan.policy.maxSourceBytes && unit.source.bytes <= 64 * 1024,
          "Review unit exceeds the source page budget");
      }
      assert(unit.source.pageDigests.length >= 1 && unit.source.pageDigests.length <= 4096,
        "Review unit page count is outside the bounded range");
    }
  }
}

function expectedPages(unit, maxSourceBytes) {
  const pages = [];
  let offset = 0;
  for (const sha256 of unit.source.pageDigests) {
    const bytes = unit.source.bytes === 0 ? 0 : Math.min(maxSourceBytes, unit.source.bytes - offset);
    pages.push({ offset, bytes, sha256, eof: offset + bytes === unit.source.bytes });
    offset += bytes;
  }
  assert.equal(offset, unit.source.bytes, "Review unit page digests do not cover source bytes");
  return pages;
}

function parseEventStream(eventStream, label) {
  assert(typeof eventStream === "string" && Buffer.byteLength(eventStream) > 0, `${label} event stream is required`);
  assert(eventStream.endsWith("\n"), `${label} event stream is truncated`);
  const lines = eventStream.split("\n").filter(Boolean);
  assert(lines.length <= 4096, `${label} event stream is too large`);
  return lines.map((line, index) => {
    assert(Buffer.byteLength(line) <= 1024 * 1024, `${label} event line exceeds transport limit`);
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new NativeReviewShardRunError("HOLD", "ENATIVE_REVIEW_EVENT_JSON", `${label} event ${index} is not JSON`, error);
    }
  });
}

function validateExecutionEnvelope(raw) {
  exact(raw, ["eventStream", "execution", "usage"], "executor output");
  exact(raw.execution, ["executionId", "traceSha256", "code", "signal", "groupTerminated", "cleaned"], "executor execution");
  safeId(raw.execution.executionId, "executor.executionId");
  digest(raw.execution.traceSha256, "executor.traceSha256");
  assert.equal(raw.execution.code, 0, "review executor exited unsuccessfully");
  assert.equal(raw.execution.signal, null, "review executor was signalled");
  assert.equal(raw.execution.groupTerminated, true, "review executor group is not terminated");
  assert.equal(raw.execution.cleaned, true, "review executor cleanup is not confirmed");
  exact(raw.usage, ["elapsedMs", "tokenUnits", "costUnits", "attemptsUsed"], "executor usage");
  for (const key of Object.keys(raw.usage)) integer(raw.usage[key], `executor.usage.${key}`);
  assert.equal(raw.usage.attemptsUsed, 1, "one role×batch transport must consume one attempt");
  const events = parseEventStream(raw.eventStream, "executor");
  const traceSha256 = contentDigest(Buffer.from(raw.eventStream));
  assert.equal(raw.execution.traceSha256, traceSha256, "executor trace digest does not match event stream");
  return { events, execution: { ...raw.execution, traceSha256 }, usage: raw.usage };
}

function validateLaneExecutionOutput({ raw, plan, batch, assignments, admission }) {
  assert(Array.isArray(assignments) && assignments.length > 0, "review lane must contain at least one assignment");
  const envelope = validateExecutionEnvelope(raw);
  const { events } = envelope;
  const bound = events.shift();
  exact(bound, ["type", "protocol", "planDigest", "admissionDigest", "batchId", "roleId", "assignmentIds", "unitIds", "executionId", "contextDigest"], "transport binding");
  assert.equal(bound.type, "bw.transport.bound");
  assert.equal(bound.protocol, NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL);
  assert.equal(bound.planDigest, plan.planDigest);
  assert.equal(bound.admissionDigest, admission.admissionDigest);
  assert.equal(bound.batchId, batch.batchId);
  assert.equal(bound.roleId, assignments[0].roleId);
  assert(Array.isArray(bound.assignmentIds));
  assert(Array.isArray(bound.unitIds));
  assert.deepEqual(bound.assignmentIds, assignments.map(item => item.id));
  assert.deepEqual(bound.unitIds, assignments.map(item => item.unitId));
  assert.equal(bound.executionId, envelope.execution.executionId);
  assert.equal(bound.contextDigest, plan.context.digest);
  const outputs = [];
  for (const assignment of assignments) {
    const unit = plan.units.find(item => item.id === assignment.unitId);
    assert(unit, "lane assignment references an unknown unit");
    const expected = expectedPages(unit, plan.policy.maxSourceBytes);
    const pages = [];
    for (const expectedPage of expected) {
      const pageEvent = events.shift();
      exact(pageEvent, ["type", "protocol", "assignmentId", "unitId", "page"], "content page event");
      assert.equal(pageEvent.type, "bw.content.page");
      assert.equal(pageEvent.protocol, NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL);
      assert.equal(pageEvent.assignmentId, assignment.id);
      assert.equal(pageEvent.unitId, unit.id);
      exact(pageEvent.page, ["offset", "bytes", "sha256", "eof"], "content page");
      assert.deepEqual(pageEvent.page, expectedPage, "content page does not match the frozen source");
      const ack = events.shift();
      exact(ack, ["type", "protocol", "assignmentId", "unitId", "offset", "sha256", "eof"], "content ACK");
      assert.equal(ack.type, "bw.content.ack");
      assert.equal(ack.protocol, NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL);
      assert.equal(ack.assignmentId, assignment.id);
      assert.equal(ack.unitId, unit.id);
      assert.equal(ack.offset, expectedPage.offset);
      assert.equal(ack.sha256, expectedPage.sha256);
      assert.equal(ack.eof, expectedPage.eof);
      pages.push(expectedPage);
    }
    const final = events.shift();
    exact(final, ["type", "protocol", "assignmentId", "unitId", "verdict", "reason", "findings"], "review final");
    assert.equal(final.type, "bw.review.final");
    assert.equal(final.protocol, NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL);
    assert.equal(final.assignmentId, assignment.id);
    assert.equal(final.unitId, unit.id);
    assert(RESULT_VERDICTS.has(final.verdict));
    assert(final.reason === null || typeof final.reason === "string");
    assert(Array.isArray(final.findings));
    outputs.push({ assignment, unit, final, pages });
  }
  const terminal = events.shift();
  exact(terminal, ["type", "protocol", "batchId", "roleId", "assignmentIds", "unitIds", "executionId", "contentEof", "acknowledged"], "transport terminal");
  assert.equal(terminal.type, "bw.transport.terminal");
  assert.equal(terminal.protocol, NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL);
  assert.equal(terminal.batchId, batch.batchId);
  assert.equal(terminal.roleId, assignments[0].roleId);
  assert.deepEqual(terminal.assignmentIds, assignments.map(item => item.id));
  assert.deepEqual(terminal.unitIds, assignments.map(item => item.unitId));
  assert.equal(terminal.executionId, envelope.execution.executionId);
  assert.equal(terminal.contentEof, true);
  assert.equal(terminal.acknowledged, true);
  assert.equal(events.length, 0, "executor emitted events after terminal");
  return outputs.map(output => ({ ...output, execution: envelope.execution, usage: envelope.usage }));
}

function normalizedBudget(value) {
  return {
    elapsedMs: value.elapsedMs,
    tokenUnits: value.tokenUnits,
    costUnits: value.costUnits,
    attemptsUsed: value.attemptsUsed
  };
}

function addBudget(left, right) {
  return normalizedBudget({
    elapsedMs: left.elapsedMs + right.elapsedMs,
    tokenUnits: left.tokenUnits + right.tokenUnits,
    costUnits: left.costUnits + right.costUnits,
    attemptsUsed: left.attemptsUsed + right.attemptsUsed
  });
}

function subtractBudget(left, right) {
  return normalizedBudget({
    elapsedMs: left.elapsedMs - right.elapsedMs,
    tokenUnits: left.tokenUnits - right.tokenUnits,
    costUnits: left.costUnits - right.costUnits,
    attemptsUsed: left.attemptsUsed - right.attempts
  });
}

function withinBudget(value, maximum) {
  return value.elapsedMs <= maximum.elapsedMs && value.tokenUnits <= maximum.tokenUnits &&
    value.costUnits <= maximum.costUnits && value.attemptsUsed <= maximum.attemptsUsed;
}

function conservativeUsage(reported, reservation, startedAt) {
  return normalizedBudget({
    elapsedMs: Math.max(reservation.elapsedMs, reported.elapsedMs, Date.now() - startedAt),
    tokenUnits: Math.max(reservation.tokenUnits, reported.tokenUnits),
    costUnits: Math.max(reservation.costUnits, reported.costUnits),
    attemptsUsed: Math.max(reservation.attempts, reported.attemptsUsed)
  });
}

function budgetExceeded(value, maximum) {
  return !withinBudget(value, maximum);
}

function asRunError(error, fallbackStatus = "HOLD") {
  if (error instanceof NativeReviewShardRunError) return error;
  const message = String(error?.message ?? error);
  if (error?.code === "ETIMEDOUT" || error?.code === "ENATIVE_REVIEW_NO_PROGRESS" || error?.code === "ABORT_ERR") {
    return new NativeReviewShardRunError("UNKNOWN", error.code, message, error);
  }
  return new NativeReviewShardRunError(fallbackStatus, "ENATIVE_REVIEW_EXECUTION", message, error);
}

async function stopOwnedHandle(handle, reason, timeoutMs, timers) {
  assert(handle && typeof handle.stop === "function", "review executor handle must expose stop");
  let stopResult;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = timers.setTimeout(() => reject(new NativeReviewShardRunError("UNKNOWN", "ENATIVE_REVIEW_CLEANUP", "review executor cleanup deadline exceeded")), timeoutMs);
  });
  try {
    stopResult = await Promise.race([
      Promise.resolve().then(() => handle.stop({ reason, timeoutMs })),
      deadline
    ]);
  } catch (error) {
    throw new NativeReviewShardRunError("UNKNOWN", "ENATIVE_REVIEW_CLEANUP", String(error?.message ?? error), error);
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer);
  }
  exact(stopResult, ["groupTerminated", "cleaned"], "executor cleanup receipt");
  assert.equal(stopResult.groupTerminated, true, "review executor group termination is unknown");
  assert.equal(stopResult.cleaned, true, "review executor cleanup is unknown");
  return stopResult;
}

async function waitForHandle(handle, { signal, phaseTimeoutMs, noProgressTimeoutMs, timers }) {
  let lastProgress = Date.now();
  let progressTimer;
  let phaseTimer;
  let abortListener;
  let settled = false;
  const progress = () => { lastProgress = Date.now(); };
  const wait = Promise.resolve().then(() => handle.wait({ signal, reportProgress: progress,
    timeoutMs: phaseTimeoutMs, noProgressTimeoutMs }));
  const cancellation = new Promise((_, reject) => {
    abortListener = () => reject(new NativeReviewShardRunError("UNKNOWN", "ABORT_ERR", "review run was cancelled"));
    if (signal?.aborted) abortListener();
    else signal?.addEventListener("abort", abortListener, { once: true });
  });
  const deadline = new Promise((_, reject) => {
    phaseTimer = timers.setTimeout(() => reject(new NativeReviewShardRunError("UNKNOWN", "ETIMEDOUT", "review phase timed out")), phaseTimeoutMs);
  });
  const noProgress = new Promise((_, reject) => {
    progressTimer = timers.setInterval(() => {
      if (Date.now() - lastProgress >= noProgressTimeoutMs) {
        reject(new NativeReviewShardRunError("UNKNOWN", "ENATIVE_REVIEW_NO_PROGRESS", "review phase made no progress"));
      }
    }, Math.min(250, Math.max(1, noProgressTimeoutMs)));
  });
  try {
    const value = await Promise.race([wait, cancellation, deadline, noProgress]);
    settled = true;
    return value;
  } finally {
    if (phaseTimer !== undefined) timers.clearTimeout(phaseTimer);
    if (progressTimer !== undefined) timers.clearInterval(progressTimer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    if (!settled) void wait.catch(() => undefined);
  }
}

async function startWithDeadline(executor, context, signal, timeoutMs, timers, lifecycle = null) {
  let timer;
  let abortListener;
  let timedOut = false;
  let cancelled = false;
  const initializationDeadline = new AbortController();
  const start = Promise.resolve().then(() => executor.start({
    ...context,
    initializationSignal: initializationDeadline.signal
  }));
  const cancellation = new Promise((_, reject) => {
    abortListener = () => {
      cancelled = true;
      initializationDeadline.abort(new Error("review initialization was cancelled"));
      reject(new NativeReviewShardRunError("UNKNOWN", "ABORT_ERR", "review run was cancelled during initialization"));
    };
    if (signal?.aborted) abortListener();
    else signal?.addEventListener("abort", abortListener, { once: true });
  });
  const deadline = new Promise((_, reject) => {
    timer = timers.setTimeout(() => {
      timedOut = true;
      initializationDeadline.abort(new Error("review initialization deadline elapsed"));
      reject(new NativeReviewShardRunError("UNKNOWN", "ETIMEDOUT", "review executor initialization timed out"));
      }, timeoutMs);
    });
  try {
    return await Promise.race([start, cancellation, deadline]);
  } catch (error) {
    if (!timedOut && !cancelled && lifecycle) {
      await persistInitializationOutcome(lifecycle, {
        status: "UNKNOWN",
        phase: "initialization",
        reason: "initialization-failed",
        error
      });
    }
    if (lifecycle) error.initializationLifecycle = {
      pendingPath: lifecycle.pendingPath,
      outcomePath: lifecycle.outcomePath,
      lateObservationPath: lifecycle.lateObservationPath
    };
    throw error;
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    if (!initializationDeadline.signal.aborted) initializationDeadline.abort();
    if (timedOut || cancelled) {
      const reason = cancelled ? "initialization-abort" : "initialization-timeout";
      const lateSettlement = settleLateInitialization({ start, lifecycle, reason, timeoutMs, timers });
      if (lifecycle) lifecycle.lateSettlement = lateSettlement;
      void lateSettlement.catch(error => {
        if (lifecycle) lifecycle.lateError = initializationError(error);
      });
    }
  }
}

async function settleLateInitialization({ start, lifecycle, reason, timeoutMs, timers }) {
  if (!lifecycle) return;
  let lateStartTimedOut = false;
  let timer;
  const lateStartDeadline = new Promise((_, reject) => {
    timer = timers.setTimeout(() => {
      lateStartTimedOut = true;
      reject(new NativeReviewShardRunError("UNKNOWN", "ENATIVE_REVIEW_CLEANUP",
        "late review executor initialization deadline exceeded"));
    }, timeoutMs);
  });
  try {
    const handle = await Promise.race([start, lateStartDeadline]);
    await settleLateHandle({ handle, lifecycle, reason, timeoutMs, timers });
  } catch (error) {
    await persistInitializationOutcome(lifecycle, {
      status: "UNKNOWN",
      phase: "initialization",
      reason: lateStartTimedOut ? "late-start-timeout" : reason,
      error
    });
    if (lateStartTimedOut) {
      observeLateInitializationStart({ start, lifecycle, reason, timeoutMs, timers });
    }
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer);
  }
}

function observeLateInitializationStart({ start, lifecycle, reason, timeoutMs, timers }) {
  void Promise.resolve(start).then(
    handle => settleLateHandle({ handle, lifecycle, reason, timeoutMs, timers }),
    error => persistInitializationLateObservation(lifecycle, {
      status: "UNKNOWN",
      reason: "late-start-failed",
      error
    })
  ).catch(latePersistenceError => {
    lifecycle.latePersistenceError = initializationError(latePersistenceError);
  });
}

async function settleLateHandle({ handle, lifecycle, reason, timeoutMs, timers }) {
  try {
    assert(handle && typeof handle.stop === "function", "late review executor handle is incomplete");
  } catch (error) {
    if (lifecycle.finalized) {
      await persistInitializationLateObservation(lifecycle, {
        status: "UNKNOWN",
        reason: "late-handle-incomplete",
        error
      });
    } else {
      await persistInitializationOutcome(lifecycle, {
        status: "UNKNOWN",
        phase: "initialization",
        reason,
        error
      });
    }
    return;
  }

  let timer;
  let stopSettled = false;
  const stopPromise = Promise.resolve().then(() => handle.stop({ reason, timeoutMs }));
  const observedStop = stopPromise.then(value => {
    stopSettled = true;
    return value;
  }, error => {
    stopSettled = true;
    throw error;
  });
  const deadline = new Promise((_, reject) => {
    timer = timers.setTimeout(() => reject(new NativeReviewShardRunError("UNKNOWN", "ENATIVE_REVIEW_CLEANUP",
      "late review executor cleanup deadline exceeded")), timeoutMs);
  });
  try {
    const receipt = await Promise.race([observedStop, deadline]);
    initializationCleanup(receipt);
    if (lifecycle.finalized) {
      await persistInitializationLateObservation(lifecycle, {
        status: "CLEANED",
        reason: "late-cleanup-settled",
        cleanup: receipt
      });
    } else {
      await persistInitializationOutcome(lifecycle, {
        status: "CLEANED",
        phase: "cleanup",
        reason,
        cleanup: receipt
      });
    }
  } catch (error) {
    const observeLateStop = !stopSettled;
    await persistInitializationOutcome(lifecycle, {
      status: "UNKNOWN",
      phase: "cleanup",
      reason,
      error
    });
    if (observeLateStop || !stopSettled) {
      void observedStop.then(receipt => persistInitializationLateObservation(lifecycle, {
        status: "CLEANED",
        reason: "late-cleanup-settled",
        cleanup: receipt
      })).catch(lateError => {
        return persistInitializationLateObservation(lifecycle, {
          status: "UNKNOWN",
          reason: "late-cleanup-failed",
          error: lateError
        });
      }).catch(latePersistenceError => {
        lifecycle.latePersistenceError = initializationError(latePersistenceError);
      });
    } else if (lifecycle.finalized) {
      await persistInitializationLateObservation(lifecycle, {
        status: "UNKNOWN",
        reason: "late-cleanup-failed",
        error
      });
    }
  } finally {
    if (timer !== undefined) timers.clearTimeout(timer);
  }
}

/**
 * Test-only seam for the runner-owned initialization lifecycle. It exercises
 * the same deadline, late-handle, and durable cleanup path used by runLane;
 * it does not mint an executor capability or an execution authority.
 */
export async function __testStartWithDeadlineV2({
  directory,
  start,
  signal = new AbortController().signal,
  timeoutMs = 25,
  runId = "test-run",
  executionId = "exec-test",
  batchId = "batch-test",
  roleId = "role-test",
  assignmentId = "assignment-test",
  unitId = "unit-test",
  planDigest = "a".repeat(64),
  sourceDigest = "b".repeat(64),
  executorDigest = "c".repeat(64),
  admissionDigest = null
} = {}) {
  absolutePath(directory, "test initialization directory");
  assert(typeof start === "function", "test initialization start must be a function");
  integer(timeoutMs, "test initialization timeout", { min: 1 });
  const key = await ensureCheckpointSealKey(directory);
  const plan = { planDigest, source: { sourceDigest } };
  const authorization = { runId, epoch: 1, executorDigest };
  const context = {
    admissionDigest,
    executionId,
    batch: { batchId },
    role: { id: roleId },
    assignments: [{ id: assignmentId }],
    units: [{ id: unitId }]
  };
  const lifecycle = await beginInitializationLifecycle({ directory, plan, authorization, context,
    timeoutMs, key: key.key, keyId: key.keyId });
  return startWithDeadline({ start }, context, signal, timeoutMs, defaultTimers(), lifecycle);
}

async function immutableJson(target, value, label) {
  absolutePath(target, label);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const lock = `${target}.writer-lock`;
  try {
    try {
      await lstat(lock);
      throw new Error(`${label} has a competing writer`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await createJson(lock, { schemaVersion: 1, kind: "NativeReviewImmutableWriterLockV1" });
    try {
      try {
        const existing = await boundedFile(target, label);
        const expected = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
        assert.equal(contentDigest(existing.bytes), contentDigest(expected), `${label} changed by a late writer`);
        return { path: existing.path, sha256: contentDigest(existing.bytes) };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await atomicJson(target, value);
      const written = await boundedFile(target, label);
      return { path: written.path, sha256: contentDigest(written.bytes) };
    } finally {
      await rm(lock, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    await rm(lock, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function loadJson(target, label, maximum = 8 * 1024 * 1024) {
  const file = await boundedFile(target, label, maximum);
  let value;
  try {
    value = JSON.parse(file.bytes.toString("utf8"));
  } catch (error) {
    throw new NativeReviewShardRunError("HOLD", "ENATIVE_REVIEW_JSON", `${label} is not valid JSON`, error);
  }
  return { file, value };
}

function macFor(key, value) {
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
}

function assertMac(actual, expected, label) {
  digest(actual, `${label}.mac`);
  digest(expected, `${label}.expectedMac`);
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  assert.equal(left.length, right.length, `${label} MAC length is invalid`);
  assert(timingSafeEqual(left, right), `${label} MAC is invalid`);
}

function checkpointSealBody(value) {
  const body = { ...value };
  delete body.sealDigest;
  delete body.mac;
  return body;
}

function checkpointSealPath(checkpointPath) {
  return `${checkpointPath}.seal.json`;
}

function checkpointSealKeyPath(directory) {
  return path.join(directory, CHECKPOINT_SEAL_KEY_FILE);
}

function assertPrivateStateFile(file, label) {
  assert.equal(file.info.mode & 0o077, 0, `${label} must be private to the owner`);
  if (typeof process.getuid === "function") {
    assert.equal(file.info.uid, process.getuid(), `${label} is not owned by the current user`);
  }
}

async function readCheckpointSealKey(directory) {
  const loaded = await loadJson(checkpointSealKeyPath(directory), "Review checkpoint seal key", CHECKPOINT_SEAL_MAX_BYTES);
  assertPrivateStateFile(loaded.file, "Review checkpoint seal key");
  exact(loaded.value, ["schemaVersion", "kind", "keyId", "keyHex"], "Review checkpoint seal key");
  assert.equal(loaded.value.schemaVersion, 1);
  assert.equal(loaded.value.kind, CHECKPOINT_SEAL_KEY_KIND);
  assert(typeof loaded.value.keyHex === "string" && /^[a-f0-9]{64}$/.test(loaded.value.keyHex),
    "Review checkpoint seal key is invalid");
  const key = Buffer.from(loaded.value.keyHex, "hex");
  const keyId = contentDigest(key);
  assert.equal(loaded.value.keyId, keyId, "Review checkpoint seal key id is stale");
  return { key, keyId };
}

async function ensureCheckpointSealKey(directory) {
  try {
    return await readCheckpointSealKey(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  const keyId = contentDigest(key);
  const value = {
    schemaVersion: 1,
    kind: CHECKPOINT_SEAL_KEY_KIND,
    keyId,
    keyHex: key.toString("hex")
  };
  try {
    await createJson(checkpointSealKeyPath(directory), value);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return readCheckpointSealKey(directory);
}

function makeCheckpointSeal({ checkpoint, plan, authorization, sequence, previousSealDigest, checkpointPath, keyId, key }) {
  validateReviewCheckpoint(checkpoint, plan);
  assertBudgetAuthorization(authorization, plan);
  assert.equal(checkpoint.runId, authorization.runId);
  assert.equal(checkpoint.planDigest, plan.planDigest);
  assert.equal(checkpoint.sourceDigest, plan.source.sourceDigest);
  assert.equal(checkpoint.epoch, authorization.epoch);
  assert.equal(checkpoint.grantDigest, authorization.grantDigest);
  assert(Number.isSafeInteger(sequence) && sequence >= 0 && sequence <= 1_000_000,
    "checkpoint seal sequence is outside the bounded range");
  assert(previousSealDigest === null || DIGEST.test(previousSealDigest), "checkpoint seal predecessor is invalid");
  const body = {
    schemaVersion: 1,
    kind: CHECKPOINT_SEAL_KIND,
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    sealed: true,
    keyId,
    checkpointFile: path.basename(checkpointPath),
    runId: checkpoint.runId,
    planDigest: checkpoint.planDigest,
    sourceDigest: checkpoint.sourceDigest,
    epoch: checkpoint.epoch,
    executorDigest: authorization.executorDigest,
    grantDigest: checkpoint.grantDigest,
    admissionDigest: checkpoint.admissionDigest,
    checkpointDigest: checkpoint.checkpointDigest,
    checkpointSequence: sequence,
    status: checkpoint.status,
    completedAssignmentIds: [...checkpoint.completedAssignmentIds],
    nextBatchIndex: checkpoint.nextBatchIndex,
    budget: { ...checkpoint.budget },
    resultDigests: [...checkpoint.resultDigests],
    resumedFrom: checkpoint.resumedFrom,
    previousSealDigest,
    createdAt: checkpoint.createdAt
  };
  const sealDigest = digestObject(body);
  const mac = macFor(key, { kind: CHECKPOINT_SEAL_MAC_KIND, sealDigest, body });
  return deepFreeze({ ...body, sealDigest, mac });
}

function validateCheckpointSeal(value, {
  checkpoint = null,
  plan = null,
  authorization = null,
  checkpointPath = null,
  key,
  keyId
} = {}) {
  exact(value, ["schemaVersion", "kind", "protocol", "sealed", "keyId", "checkpointFile", "runId", "planDigest",
    "sourceDigest", "epoch", "executorDigest", "grantDigest", "admissionDigest", "checkpointDigest",
    "checkpointSequence", "status", "completedAssignmentIds", "nextBatchIndex", "budget", "resultDigests",
    "resumedFrom", "previousSealDigest", "createdAt", "sealDigest", "mac"], "Review checkpoint seal");
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, CHECKPOINT_SEAL_KIND);
  assert.equal(value.protocol, NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL);
  assert.equal(value.sealed, true);
  assert.equal(value.keyId, keyId ?? contentDigest(key));
  assert(typeof value.checkpointFile === "string" && value.checkpointFile === path.basename(value.checkpointFile) &&
    /^checkpoint-[0-9]{6}-[0-9]{6}\.json$/.test(value.checkpointFile), "Review checkpoint seal file binding is invalid");
  safeId(value.runId, "checkpoint seal.runId");
  digest(value.planDigest, "checkpoint seal.planDigest");
  digest(value.sourceDigest, "checkpoint seal.sourceDigest");
  integer(value.epoch, "checkpoint seal.epoch", { min: 1 });
  digest(value.executorDigest, "checkpoint seal.executorDigest");
  digest(value.grantDigest, "checkpoint seal.grantDigest");
  assert(value.admissionDigest === null || DIGEST.test(value.admissionDigest));
  digest(value.checkpointDigest, "checkpoint seal.checkpointDigest");
  integer(value.checkpointSequence, "checkpoint seal.checkpointSequence");
  assert(["READY", "RUNNING", "PAUSED", "PAUSED_BUDGET", "HOLD", "UNKNOWN", "BLOCKED", "COMPLETE"].includes(value.status));
  assert(Array.isArray(value.completedAssignmentIds));
  value.completedAssignmentIds.forEach(item => safeId(item, "checkpoint seal.assignmentId"));
  assert.deepEqual(value.completedAssignmentIds, [...value.completedAssignmentIds].sort());
  integer(value.nextBatchIndex, "checkpoint seal.nextBatchIndex");
  exact(value.budget, ["elapsedMs", "tokenUnits", "costUnits", "attemptsUsed"], "checkpoint seal.budget");
  for (const item of Object.values(value.budget)) integer(item, "checkpoint seal.budget value");
  assert(Array.isArray(value.resultDigests));
  value.resultDigests.forEach(item => digest(item, "checkpoint seal.resultDigest"));
  assert.deepEqual(value.resultDigests, [...new Set(value.resultDigests)].sort());
  assert(value.resumedFrom === null || DIGEST.test(value.resumedFrom));
  assert(typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)));
  digest(value.sealDigest, "checkpoint seal.sealDigest");
  assert.equal(value.sealDigest, digestObject(checkpointSealBody(value)), "Review checkpoint seal digest is stale");
  assertMac(value.mac, macFor(key, { kind: CHECKPOINT_SEAL_MAC_KIND, sealDigest: value.sealDigest, body: checkpointSealBody(value) }),
    "Review checkpoint seal");
  if (checkpointPath !== null) assert.equal(value.checkpointFile, path.basename(checkpointPath));
  if (plan) {
    const canonicalPlan = validateReviewShardPlanV2(plan);
    assert.equal(value.planDigest, canonicalPlan.planDigest);
    assert.equal(value.sourceDigest, canonicalPlan.source.sourceDigest);
  }
  if (authorization) {
    assertBudgetAuthorization(authorization, plan ?? { planDigest: value.planDigest });
    assert.equal(value.runId, authorization.runId);
    assert.equal(value.executorDigest, authorization.executorDigest);
  }
  if (checkpoint) {
    validateReviewCheckpoint(checkpoint, plan);
    for (const keyName of ["runId", "planDigest", "sourceDigest", "epoch", "grantDigest", "admissionDigest", "status",
      "completedAssignmentIds", "nextBatchIndex", "budget", "resultDigests", "resumedFrom", "createdAt"]) {
      assert.deepEqual(value[keyName], checkpoint[keyName], `Checkpoint seal ${keyName} is not bound to the checkpoint`);
    }
    assert.equal(value.checkpointDigest, checkpoint.checkpointDigest);
  }
  return deepFreeze(value);
}

async function readCheckpointSeal({ checkpointPath, checkpoint, plan, authorization, key, keyId } = {}) {
  const target = checkpointSealPath(checkpointPath);
  const loaded = await loadJson(target, "Review checkpoint seal", CHECKPOINT_SEAL_MAX_BYTES);
  return validateCheckpointSeal(loaded.value, { checkpoint, plan, authorization, checkpointPath, key, keyId });
}

async function writeCheckpointSeal({ checkpoint, plan, authorization, sequence, previousSealDigest, checkpointPath, key, keyId }) {
  const seal = makeCheckpointSeal({ checkpoint, plan, authorization, sequence, previousSealDigest, checkpointPath, keyId, key });
  const persisted = await immutableJson(checkpointSealPath(checkpointPath), seal, "Review checkpoint seal");
  const readBack = await loadJson(checkpointSealPath(checkpointPath), "Review checkpoint seal", CHECKPOINT_SEAL_MAX_BYTES);
  validateCheckpointSeal(readBack.value, { checkpoint, plan, authorization, checkpointPath, key, keyId });
  return { seal, persisted };
}

function initializationPaths(directory, executionId) {
  safeId(executionId, "initialization.executionId");
  const root = path.join(directory, "initialization");
  return {
    root,
    pendingPath: path.join(root, `${executionId}.pending.json`),
    outcomePath: path.join(root, `${executionId}.outcome.json`),
    lateObservationPath: path.join(root, `${executionId}.cleanup-late.json`)
  };
}

function initializationBody(value) {
  const body = { ...value };
  delete body.recordDigest;
  delete body.mac;
  return body;
}

function initializationError(error) {
  return {
    code: typeof error?.code === "string" && error.code ? error.code.slice(0, 128) : "ENATIVE_REVIEW_INITIALIZATION",
    message: String(error?.message ?? error).slice(0, 1024),
    status: error?.status === "UNKNOWN" ? "UNKNOWN" : null
  };
}

function initializationCleanup(value) {
  if (value === null || value === undefined) return null;
  exact(value, ["groupTerminated", "cleaned"], "initialization cleanup receipt");
  assert.equal(value.groupTerminated, true);
  assert.equal(value.cleaned, true);
  return {
    groupTerminated: true,
    cleaned: true,
    receiptDigest: digestObject(value)
  };
}

function signInitializationRecord(body, key, keyId) {
  const recordDigest = digestObject(body);
  const mac = macFor(key, { kind: `${body.kind}MacInputV1`, recordDigest, body });
  return deepFreeze({ ...body, recordDigest, mac, keyId });
}

function validateInitializationRecord(value, { key, keyId, kind, pending = null } = {}) {
  object(value, "initialization lifecycle record");
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, kind);
  assert.equal(value.protocol, NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL);
  assert.equal(value.sealed, true);
  assert.equal(value.keyId, keyId ?? contentDigest(key));
  digest(value.recordDigest, "initialization lifecycle record digest");
  digest(value.mac, "initialization lifecycle record MAC");
  assert.equal(value.recordDigest, digestObject(initializationBody(value)));
  assertMac(value.mac, macFor(key, { kind: `${value.kind}MacInputV1`, recordDigest: value.recordDigest, body: initializationBody(value) }),
    "initialization lifecycle record");
  if (kind === INITIALIZATION_PENDING_KIND) {
    exact(value, ["schemaVersion", "kind", "protocol", "sealed", "keyId", "status", "runId", "planDigest", "sourceDigest", "epoch",
      "executorDigest", "admissionDigest", "executionId", "batchId", "roleId", "assignmentIds", "unitIds", "timeoutMs",
      "createdAt", "recordDigest", "mac"], "initialization pending record");
    assert.equal(value.status, "PENDING");
    safeId(value.runId, "initialization pending.runId");
    digest(value.planDigest, "initialization pending.planDigest");
    digest(value.sourceDigest, "initialization pending.sourceDigest");
    integer(value.epoch, "initialization pending.epoch", { min: 1 });
    digest(value.executorDigest, "initialization pending.executorDigest");
    assert(value.admissionDigest === null || DIGEST.test(value.admissionDigest));
    safeId(value.executionId, "initialization pending.executionId");
    safeId(value.batchId, "initialization pending.batchId");
    safeId(value.roleId, "initialization pending.roleId");
    assert(Array.isArray(value.assignmentIds) && value.assignmentIds.length > 0);
    value.assignmentIds.forEach(item => safeId(item, "initialization pending.assignmentId"));
    assert.deepEqual(value.assignmentIds, [...value.assignmentIds]);
    assert(Array.isArray(value.unitIds) && value.unitIds.length === value.assignmentIds.length);
    value.unitIds.forEach(item => safeId(item, "initialization pending.unitId"));
    integer(value.timeoutMs, "initialization pending.timeoutMs", { min: 1 });
    assert(typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)));
  } else if (kind === INITIALIZATION_OUTCOME_KIND) {
    exact(value, ["schemaVersion", "kind", "protocol", "sealed", "keyId", "runId", "planDigest", "sourceDigest", "epoch",
      "executorDigest", "admissionDigest", "executionId", "pendingDigest", "status", "phase", "reason", "cleanup",
      "error", "observedAt", "recordDigest", "mac"], "initialization outcome record");
    safeId(value.runId, "initialization outcome.runId");
    digest(value.planDigest, "initialization outcome.planDigest");
    digest(value.sourceDigest, "initialization outcome.sourceDigest");
    integer(value.epoch, "initialization outcome.epoch", { min: 1 });
    digest(value.executorDigest, "initialization outcome.executorDigest");
    assert(value.admissionDigest === null || DIGEST.test(value.admissionDigest));
    safeId(value.executionId, "initialization outcome.executionId");
    digest(value.pendingDigest, "initialization outcome.pendingDigest");
    assert(["CLEANED", "UNKNOWN"].includes(value.status));
    assert(["initialization", "cleanup"].includes(value.phase));
    assert(typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 128);
    if (value.cleanup === null) assert(value.status === "UNKNOWN");
    else {
      exact(value.cleanup, ["groupTerminated", "cleaned", "receiptDigest"], "initialization outcome.cleanup");
      assert.equal(value.cleanup.groupTerminated, true);
      assert.equal(value.cleanup.cleaned, true);
      digest(value.cleanup.receiptDigest, "initialization outcome.cleanup.receiptDigest");
    }
    if (value.error === null) assert.equal(value.status, "CLEANED");
    else exact(value.error, ["code", "message", "status"], "initialization outcome.error");
    assert(typeof value.observedAt === "string" && Number.isFinite(Date.parse(value.observedAt)));
  } else {
    exact(value, ["schemaVersion", "kind", "protocol", "sealed", "keyId", "runId", "planDigest", "sourceDigest", "epoch",
      "executorDigest", "admissionDigest", "executionId", "pendingDigest", "outcomeDigest", "status", "reason", "cleanup",
      "error", "observedAt", "recordDigest", "mac"], "initialization cleanup observation");
    safeId(value.runId, "initialization observation.runId");
    digest(value.planDigest, "initialization observation.planDigest");
    digest(value.sourceDigest, "initialization observation.sourceDigest");
    integer(value.epoch, "initialization observation.epoch", { min: 1 });
    digest(value.executorDigest, "initialization observation.executorDigest");
    assert(value.admissionDigest === null || DIGEST.test(value.admissionDigest));
    safeId(value.executionId, "initialization observation.executionId");
    digest(value.pendingDigest, "initialization observation.pendingDigest");
    assert(value.outcomeDigest === null || DIGEST.test(value.outcomeDigest));
    assert(["CLEANED", "UNKNOWN"].includes(value.status));
    assert(typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 128);
    if (value.cleanup === null) assert.equal(value.status, "UNKNOWN");
    else {
      exact(value.cleanup, ["groupTerminated", "cleaned", "receiptDigest"], "initialization observation.cleanup");
      digest(value.cleanup.receiptDigest, "initialization observation.cleanup.receiptDigest");
    }
    if (value.error !== null) exact(value.error, ["code", "message", "status"], "initialization observation.error");
    assert(typeof value.observedAt === "string" && Number.isFinite(Date.parse(value.observedAt)));
  }
  if (pending) {
    validateInitializationRecord(pending, { key, keyId, kind: INITIALIZATION_PENDING_KIND });
    for (const keyName of ["runId", "planDigest", "sourceDigest", "epoch", "executorDigest", "admissionDigest", "executionId"]) {
      assert.deepEqual(value[keyName], pending[keyName], `initialization lifecycle ${keyName} is not bound to pending record`);
    }
    assert.equal(value.pendingDigest, pending.recordDigest);
  }
  return deepFreeze(value);
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function beginInitializationLifecycle({ directory, plan, authorization, context, timeoutMs, key, keyId }) {
  const paths = initializationPaths(directory, context.executionId);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  for (const target of [paths.pendingPath, paths.outcomePath, paths.lateObservationPath]) {
    if (await pathExists(target)) {
      throw new NativeReviewShardRunError("UNKNOWN", "ENATIVE_REVIEW_INIT_OUTSTANDING",
        `review initialization ${context.executionId} already has durable lifecycle evidence`);
    }
  }
  const pendingBody = {
    schemaVersion: 1,
    kind: INITIALIZATION_PENDING_KIND,
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    sealed: true,
    keyId,
    status: "PENDING",
    runId: authorization.runId,
    planDigest: plan.planDigest,
    sourceDigest: plan.source.sourceDigest,
    epoch: authorization.epoch,
    executorDigest: authorization.executorDigest,
    admissionDigest: context.admissionDigest,
    executionId: context.executionId,
    batchId: context.batch.batchId,
    roleId: context.role.id,
    assignmentIds: context.assignments.map(item => item.id),
    unitIds: context.units.map(item => item.id),
    timeoutMs,
    createdAt: new Date().toISOString()
  };
  const pending = signInitializationRecord(pendingBody, key, keyId);
  validateInitializationRecord(pending, { key, keyId, kind: INITIALIZATION_PENDING_KIND });
  await immutableJson(paths.pendingPath, pending, "Review initialization pending record");
  return { ...paths, pending, key, keyId, finalized: false, outcome: null, lateObservation: null };
}

async function persistInitializationOutcome(lifecycle, { status, phase, reason, cleanup = null, error = null }) {
  if (lifecycle.finalized) return lifecycle.outcome;
  const body = {
    schemaVersion: 1,
    kind: INITIALIZATION_OUTCOME_KIND,
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    sealed: true,
    keyId: lifecycle.keyId,
    runId: lifecycle.pending.runId,
    planDigest: lifecycle.pending.planDigest,
    sourceDigest: lifecycle.pending.sourceDigest,
    epoch: lifecycle.pending.epoch,
    executorDigest: lifecycle.pending.executorDigest,
    admissionDigest: lifecycle.pending.admissionDigest,
    executionId: lifecycle.pending.executionId,
    pendingDigest: lifecycle.pending.recordDigest,
    status,
    phase,
    reason,
    cleanup: initializationCleanup(cleanup),
    error: error === null ? null : initializationError(error),
    observedAt: new Date().toISOString()
  };
  const outcome = signInitializationRecord(body, lifecycle.key, lifecycle.keyId);
  validateInitializationRecord(outcome, { key: lifecycle.key, keyId: lifecycle.keyId, kind: INITIALIZATION_OUTCOME_KIND, pending: lifecycle.pending });
  await immutableJson(lifecycle.outcomePath, outcome, "Review initialization outcome record");
  lifecycle.finalized = true;
  lifecycle.outcome = outcome;
  return outcome;
}

async function persistInitializationLateObservation(lifecycle, { status, reason, cleanup = null, error = null }) {
  if (lifecycle.lateObservation) return lifecycle.lateObservation;
  const body = {
    schemaVersion: 1,
    kind: INITIALIZATION_OBSERVATION_KIND,
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    sealed: true,
    keyId: lifecycle.keyId,
    runId: lifecycle.pending.runId,
    planDigest: lifecycle.pending.planDigest,
    sourceDigest: lifecycle.pending.sourceDigest,
    epoch: lifecycle.pending.epoch,
    executorDigest: lifecycle.pending.executorDigest,
    admissionDigest: lifecycle.pending.admissionDigest,
    executionId: lifecycle.pending.executionId,
    pendingDigest: lifecycle.pending.recordDigest,
    outcomeDigest: lifecycle.outcome?.recordDigest ?? null,
    status,
    reason,
    cleanup: initializationCleanup(cleanup),
    error: error === null ? null : initializationError(error),
    observedAt: new Date().toISOString()
  };
  const observation = signInitializationRecord(body, lifecycle.key, lifecycle.keyId);
  validateInitializationRecord(observation, { key: lifecycle.key, keyId: lifecycle.keyId, kind: INITIALIZATION_OBSERVATION_KIND, pending: lifecycle.pending });
  await immutableJson(lifecycle.lateObservationPath, observation, "Review initialization late cleanup observation");
  lifecycle.lateObservation = observation;
  return observation;
}

function checkpointName(epoch, sequence) {
  return `checkpoint-${String(epoch).padStart(6, "0")}-${String(sequence).padStart(6, "0")}.json`;
}

function resultPath(directory, resultDigest) {
  return path.join(directory, "results", `${resultDigest}.json`);
}

function tracePath(directory, executionId) {
  return path.join(directory, "traces", `${executionId}.jsonl`);
}

function lanePath(directory, receiptDigest) {
  return path.join(directory, "lanes", `${receiptDigest}.json`);
}

function aggregatePath(directory, aggregateDigest) {
  return path.join(directory, "aggregates", `${aggregateDigest}.json`);
}

function receiptBody(value) {
  const body = { ...value };
  delete body.receiptDigest;
  return body;
}

function validateRunReceipt(value, plan, authorization, admission) {
  exact(value, ["schemaVersion", "kind", "protocol", "sealed", "runId", "planDigest", "sourceDigest", "epoch", "grantDigest",
    "admissionDigest", "status", "checkpointDigest", "checkpointSealDigest", "resultDigests", "laneReceiptDigests", "aggregateDigest", "coverage",
    "finalGate", "receiptDigest"], "native v2 run receipt");
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, NATIVE_REVIEW_SHARD_RUNNER_V2_RECEIPT_KIND);
  assert.equal(value.protocol, NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL);
  assert.equal(value.sealed, true);
  const canonicalPlan = validateReviewShardPlanV2(plan);
  assertBudgetAuthorization(authorization, canonicalPlan);
  assertAdmission(admission, canonicalPlan, authorization);
  safeId(value.runId, "receipt.runId");
  assert.equal(value.runId, authorization.runId);
  assert.equal(value.planDigest, canonicalPlan.planDigest);
  assert.equal(value.sourceDigest, canonicalPlan.source.sourceDigest);
  assert.equal(value.epoch, authorization.epoch, "replay receipt epoch does not match current authorization");
  assert.equal(value.grantDigest, authorization.grantDigest, "replay receipt grant does not match current authorization");
  assert.equal(value.admissionDigest, admission.admissionDigest);
  assert(RUN_STATUSES.has(value.status));
  digest(value.checkpointDigest, "receipt.checkpointDigest");
  digest(value.checkpointSealDigest, "receipt.checkpointSealDigest");
  assert(Array.isArray(value.resultDigests)); value.resultDigests.forEach(item => digest(item, "receipt.resultDigest"));
  assert.equal(new Set(value.resultDigests).size, value.resultDigests.length);
  assert(Array.isArray(value.laneReceiptDigests)); value.laneReceiptDigests.forEach(item => digest(item, "receipt.laneReceiptDigest"));
  assert.equal(new Set(value.laneReceiptDigests).size, value.laneReceiptDigests.length);
  assert(value.aggregateDigest === null || DIGEST.test(value.aggregateDigest));
  exact(value.coverage, ["expectedAssignments", "observedAssignments", "complete"], "receipt.coverage");
  integer(value.coverage.expectedAssignments); integer(value.coverage.observedAssignments);
  assert.equal(value.coverage.expectedAssignments, requiredAssignmentIds(canonicalPlan).length,
    "receipt coverage is not bound to the frozen review plan");
  assert.equal(value.coverage.observedAssignments, value.resultDigests.length,
    "receipt coverage does not match its result set");
  assert(value.coverage.observedAssignments <= value.coverage.expectedAssignments);
  assert.equal(value.coverage.complete, value.coverage.observedAssignments === value.coverage.expectedAssignments);
  if (value.coverage.complete) assert(value.aggregateDigest !== null, "complete receipt is missing its aggregate");
  if (value.aggregateDigest === null) assert.equal(value.coverage.complete, false,
    "receipt without an aggregate cannot claim complete coverage");
  exact(value.finalGate, ["status", "authoritative"], "receipt.finalGate");
  assert.equal(value.finalGate.status, "REQUIRED");
  assert.equal(value.finalGate.authoritative, false);
  assert.equal(value.receiptDigest, digestObject(receiptBody(value)), "receipt digest is stale");
  return deepFreeze(value);
}

function buildReceipt({ plan, authorization, admission, status, checkpoint, checkpointSeal, resultDigests, laneReceiptDigests = [], aggregateDigest = null }) {
  assert(checkpointSeal, "terminal receipt requires a durable checkpoint seal");
  const body = {
    schemaVersion: 1,
    kind: NATIVE_REVIEW_SHARD_RUNNER_V2_RECEIPT_KIND,
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    sealed: true,
    runId: authorization.runId,
    planDigest: plan.planDigest,
    sourceDigest: plan.source.sourceDigest,
    epoch: authorization.epoch,
    grantDigest: authorization.grantDigest,
    admissionDigest: admission.admissionDigest,
    status,
    checkpointDigest: checkpoint.checkpointDigest,
    checkpointSealDigest: checkpointSeal.sealDigest,
    resultDigests: [...resultDigests].sort(),
    laneReceiptDigests: [...laneReceiptDigests].sort(),
    aggregateDigest,
    coverage: {
      expectedAssignments: requiredAssignmentIds(plan).length,
      observedAssignments: resultDigests.length,
      complete: resultDigests.length === requiredAssignmentIds(plan).length
    },
    finalGate: { status: "REQUIRED", authoritative: false }
  };
  const receipt = deepFreeze({ ...body, receiptDigest: digestObject(body) });
  return validateRunReceipt(receipt, plan, authorization, admission);
}

async function persistResultArtifacts({ directory, result, eventStream, plan, authorization }) {
  assertDiagnosticBudgetAuthorization(authorization);
  const trace = await immutableJson(tracePath(directory, result.execution.executionId), {
    schemaVersion: 1,
    kind: "NativeReviewExecutionTraceV1",
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    runId: authorization.runId,
    planDigest: plan.planDigest,
    sourceDigest: plan.source.sourceDigest,
    epoch: authorization.epoch,
    executorDigest: authorization.executorDigest,
    executionId: result.execution.executionId,
    traceSha256: result.execution.traceSha256,
    eventStream
  }, "Review execution trace");
  const persisted = await immutableJson(resultPath(directory, result.resultDigest), result, "Review unit result");
  return { trace, result: persisted };
}

function validatePersistedResultTrace({ value, trace, plan, admission }) {
  const { assignment, unit } = assignmentFor(plan, value.assignmentId);
  assert.equal(value.roleId, assignment.roleId, "Persisted result role binding is stale");
  assert.equal(value.unitId, assignment.unitId, "Persisted result unit binding is stale");
  const traceEvents = parseEventStream(trace, "persisted executor");
  const bound = traceEvents[0];
  exact(bound, ["type", "protocol", "planDigest", "admissionDigest", "batchId", "roleId", "assignmentIds", "unitIds", "executionId", "contextDigest"], "persisted transport binding");
  const batch = plan.batches.find(item => item.batchId === bound.batchId);
  assert(batch, "Persisted result references an unknown review batch");
  const laneAssignmentIds = bound.assignmentIds;
  assert(Array.isArray(laneAssignmentIds) && laneAssignmentIds.length > 0, "Persisted lane assignment list is empty");
  const laneAssignments = laneAssignmentIds.map(item => assignmentFor(plan, item).assignment);
  assert(laneAssignments.every(item => item.roleId === bound.roleId), "Persisted lane mixes review roles");
  assert.deepEqual(laneAssignmentIds, batch.assignmentIds.filter(item => laneAssignments.some(assignment => assignment.id === item && assignment.roleId === bound.roleId)),
    "Persisted lane assignment order is not bound to its plan batch");
  assert(laneAssignments.some(item => item.id === assignment.id), "Persisted result is outside its execution lane");
  const verified = validateLaneExecutionOutput({
    raw: {
      eventStream: trace,
      execution: value.execution,
      // Usage is accounted in the immutable result/checkpoint ledger. The
      // trace replay only needs the required one-attempt shape to revalidate
      // the transport lifecycle and its result binding.
      usage: { elapsedMs: 0, tokenUnits: 0, costUnits: 0, attemptsUsed: 1 }
    },
    plan,
    batch,
    assignments: laneAssignments,
    admission
  });
  const selected = verified.find(item => item.assignment.id === assignment.id);
  assert(selected, "Persisted result is missing from its execution trace");
  assert.equal(selected.final.verdict, value.verdict, "Persisted result verdict is not bound to its trace");
  assert.equal(selected.final.reason, value.reason, "Persisted result reason is not bound to its trace");
  assert.deepEqual(selected.final.findings, value.findings, "Persisted result findings are not bound to its trace");
  assert.deepEqual(selected.pages, value.pages, "Persisted result pages are not bound to its trace");
}

async function loadPersistedResult({ directory, resultDigest, plan, admission, admissionDigest = undefined, traceBinding = null }) {
  const { file, value } = await loadJson(resultPath(directory, resultDigest), "Review unit result");
  validateSealedReviewUnitResult(value, plan);
  assert.equal(value.resultDigest, resultDigest);
  const traceFile = await loadJson(tracePath(directory, value.execution.executionId), "Review execution trace");
  exact(traceFile.value, ["schemaVersion", "kind", "protocol", "runId", "planDigest", "sourceDigest", "epoch", "executorDigest",
    "executionId", "traceSha256", "eventStream"], "execution trace");
  safeId(traceFile.value.runId, "execution trace.runId");
  digest(traceFile.value.planDigest, "execution trace.planDigest");
  digest(traceFile.value.sourceDigest, "execution trace.sourceDigest");
  integer(traceFile.value.epoch, "execution trace.epoch", { min: 1 });
  digest(traceFile.value.executorDigest, "execution trace.executorDigest");
  assert.equal(traceFile.value.planDigest, plan.planDigest);
  assert.equal(traceFile.value.sourceDigest, plan.source.sourceDigest);
  if (traceBinding) {
    assert.equal(traceFile.value.runId, traceBinding.runId, "execution trace runId is not bound to the current run");
    assert.equal(traceFile.value.executorDigest, traceBinding.executorDigest, "execution trace executor is not bound to the current host");
    if (traceBinding.epoch !== undefined && traceBinding.epoch !== null) {
      assert.equal(traceFile.value.epoch, traceBinding.epoch, "execution trace epoch is not bound to its checkpoint");
    }
  }
  assert.equal(traceFile.value.executionId, value.execution.executionId);
  assert.equal(traceFile.value.traceSha256, value.execution.traceSha256);
  assert.equal(contentDigest(Buffer.from(traceFile.value.eventStream)), value.execution.traceSha256);
  const traceAdmission = admission ?? { admissionDigest };
  validatePersistedResultTrace({ value, trace: traceFile.value.eventStream, plan, admission: traceAdmission });
  return { value, file, trace: traceFile.value.eventStream };
}

async function writeCheckpoint({ directory, plan, authorization, checkpoint, sequence, previousSealDigest, sealKey }) {
  assertDiagnosticBudgetAuthorization(authorization);
  const target = path.join(directory, checkpointName(authorization.epoch, sequence));
  const persisted = await persistReviewCheckpoint({ checkpoint, checkpointPath: target, plan });
  const seal = await writeCheckpointSeal({ checkpoint, plan, authorization, sequence, previousSealDigest,
    checkpointPath: persisted.path, key: sealKey.key, keyId: sealKey.keyId });
  return { checkpoint, path: persisted.path, sha256: persisted.sha256, seal: seal.seal, sealPath: seal.persisted.path };
}

function initialBudget() {
  return { elapsedMs: 0, tokenUnits: 0, costUnits: 0, attemptsUsed: 0 };
}

function assignmentFor(plan, assignmentId) {
  const assignment = plan.assignments.find(item => item.id === assignmentId);
  assert(assignment, `Unknown review assignment: ${assignmentId}`);
  const unit = plan.units.find(item => item.id === assignment.unitId);
  const role = plan.roles.find(item => item.id === assignment.roleId);
  assert(unit && role, "Review assignment references unknown role or unit");
  return { assignment, unit, role };
}

function laneAssignmentsForBatch(plan, batch, results) {
  const lanes = [];
  for (const role of plan.roles.filter(item => item.required)) {
    const assignments = batch.assignmentIds
      .filter(assignmentId => !results.has(assignmentId))
      .map(assignmentId => assignmentFor(plan, assignmentId))
      .filter(item => item.role.id === role.id);
    if (assignments.length) lanes.push({
      role,
      assignments,
      lane: {
        batchId: batch.batchId,
        roleId: role.id,
        assignmentIds: assignments.map(item => item.assignment.id),
        unitIds: assignments.map(item => item.unit.id)
      }
    });
  }
  return lanes;
}

function laneKey(lane) {
  return `${lane.batchId}\u0000${lane.roleId}`;
}

function ownerLaunchForLane(ownerLaunches, lane) {
  if (!Array.isArray(ownerLaunches)) return null;
  const matches = ownerLaunches.filter((candidate) => {
    const effectLane = candidate?.effectBinding?.lane;
    return effectLane && laneKey(effectLane) === laneKey(lane);
  });
  assert.equal(matches.length, 1, `exact trusted owner launch is required for lane ${laneKey(lane)}`);
  return matches[0];
}

async function runLane({ plan, batch, admission, authorization, role, assignments, executor, ownerLaunch = null, signal, budgetState, timers, directory,
  sealKey, initializationTimeoutMs }) {
  assertDiagnosticExecutor(executor);
  assertDiagnosticBudgetAuthorization(authorization);
  // Count each assigned source unit independently; repeated paths or views are delivered source again.
  assertReviewerInvocationSourceBudget(assignments.map(item => item.unit));
  const reservation = authorization.reservation;
  const projected = addBudget(addBudget(budgetState.committed, budgetState.inFlight), {
    elapsedMs: reservation.elapsedMs,
    tokenUnits: reservation.tokenUnits,
    costUnits: reservation.costUnits,
    attemptsUsed: reservation.attempts
  });
  if (!withinBudget(projected, authorization.maxBudget)) {
    throw new NativeReviewShardBudgetPause("Review budget exhausted before dispatch");
  }
  budgetState.inFlight = addBudget(budgetState.inFlight, {
    elapsedMs: reservation.elapsedMs,
    tokenUnits: reservation.tokenUnits,
    costUnits: reservation.costUnits,
    attemptsUsed: reservation.attempts
  });
  let handle = null;
  let cleaned = false;
  let cleanupReceipt = null;
  let lifecycle = null;
  let primaryError = null;
  let budgetSettled = false;
  let thrown = false;
  const startedAt = Date.now();
  const executionContext = deepFreeze({
    protocol: NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
    runId: authorization.runId,
    planDigest: plan.planDigest,
    admissionDigest: admission.admissionDigest,
    authorizationDigest: authorization.authDigest,
    grantDigest: authorization.grantDigest,
    epoch: authorization.epoch,
    sourceRevision: plan.source.head,
    sourceDigest: plan.source.sourceDigest,
    policyDigest: digestObject(plan.policy),
    maxBudget: plainCopy(authorization.maxBudget),
    reservation: plainCopy(authorization.reservation),
    stateDirectory: directory,
    executionId: `exec-${digestObject({ runId: authorization.runId, epoch: authorization.epoch, batchId: batch.batchId, roleId: role.id }).slice(0, 48)}`,
    batch: plainCopy({ batchId: batch.batchId, order: batch.order, unitIds: assignments.map(item => item.unit.id) }),
    assignments: plainCopy(assignments.map(item => item.assignment)),
    role: plainCopy(role),
    units: plainCopy(assignments.map(item => item.unit)),
    context: plainCopy(plan.context),
    phase: {
      initTimeoutMs: plan.policy.initTimeoutMs,
      targetTimeoutMs: plan.policy.targetTimeoutMs,
      softTimeoutMs: plan.policy.softTimeoutMs,
      hardTimeoutMs: plan.policy.hardTimeoutMs,
      noProgressTimeoutMs: plan.policy.noProgressTimeoutMs,
      cleanupReserveMs: plan.policy.cleanupReserveMs
    }
  });
  try {
    assert(!signal?.aborted, "review run was cancelled before dispatch");
    assertExecutorCapability(executor, plan);
    lifecycle = await beginInitializationLifecycle({ directory, plan, authorization, context: executionContext,
      timeoutMs: initializationTimeoutMs, key: sealKey.key, keyId: sealKey.keyId });
    handle = await startWithDeadline({ start: context => startExecutor(executor, { ...context, signal, plan }, ownerLaunch) }, executionContext,
      signal, initializationTimeoutMs, timers, lifecycle);
    assert(handle && typeof handle.wait === "function" && typeof handle.stop === "function", "review executor handle is incomplete");
    const raw = await waitForHandle(handle, {
      signal,
      // targetTimeoutMs is the worker target/reservation; hardTimeoutMs is the
      // actual upper bound enforced by the runner.
      phaseTimeoutMs: plan.policy.hardTimeoutMs,
      noProgressTimeoutMs: plan.policy.noProgressTimeoutMs,
      timers
    });
    const verified = validateLaneExecutionOutput({
      raw,
      plan,
      batch,
      assignments: assignments.map(item => item.assignment),
      admission
    });
    cleanupReceipt = await stopOwnedHandle(handle, "completed", plan.policy.cleanupReserveMs, timers);
    cleaned = true;
    await persistInitializationOutcome(lifecycle, {
      status: "CLEANED",
      phase: "cleanup",
      reason: "completed",
      cleanup: cleanupReceipt
    });
    assertDiagnosticExecutor(executor);
    assertDiagnosticBudgetAuthorization(authorization);
    const results = verified.map(item => createSealedReviewUnitResult({
      plan,
      roleId: role.id,
      unitId: item.unit.id,
      verdict: item.final.verdict,
      reason: item.final.reason,
      findings: item.final.findings,
      pages: item.pages,
      execution: item.execution
    }));
    // The child envelope is an observation, not a grant. Never let a lying
    // or under-reporting provider reduce the lane reservation; elapsed time
    // is sampled by this runner and all counters are conservatively charged.
    const actual = conservativeUsage(verified[0].usage, reservation, startedAt);
    budgetState.inFlight = subtractBudget(budgetState.inFlight, reservation);
    budgetState.committed = addBudget(budgetState.committed, actual);
    budgetSettled = true;
    const artifacts = [];
    for (const result of results) {
      artifacts.push(await persistResultArtifacts({ directory, result, eventStream: raw.eventStream, plan, authorization }));
    }
    if (budgetExceeded(budgetState.committed, authorization.maxBudget)) {
      return { results, artifacts, budgetPaused: true };
    }
    return { results, artifacts, budgetPaused: false };
  } catch (error) {
    primaryError = asRunError(error, "HOLD");
    thrown = true;
    throw primaryError;
  } finally {
    if (handle && !cleaned) {
      try {
        cleanupReceipt = await stopOwnedHandle(handle, primaryError?.code ?? "failed", plan.policy.cleanupReserveMs, timers);
        cleaned = true;
      } catch (cleanupError) {
        if (!primaryError) primaryError = asRunError(cleanupError, "UNKNOWN");
        else {
          primaryError.cleanup = cleanupError;
          // A primary HOLD cannot mask an unproven owned-process cleanup.  The
          // durable checkpoint and receipt must force reconciliation before a
          // later epoch can be considered for resume.
          primaryError.status = "UNKNOWN";
        }
      }
    }
    if (lifecycle && !lifecycle.finalized && handle && cleaned) {
      await persistInitializationOutcome(lifecycle, {
        status: "CLEANED",
        phase: "cleanup",
        reason: primaryError?.code ?? "completed",
        cleanup: cleanupReceipt
      });
    } else if (lifecycle && !lifecycle.finalized && handle && primaryError) {
      await persistInitializationOutcome(lifecycle, {
        status: "UNKNOWN",
        phase: "cleanup",
        reason: primaryError.code ?? "cleanup-failed",
        error: primaryError
      });
    }
    if (primaryError && !budgetSettled) {
      budgetState.inFlight = subtractBudget(budgetState.inFlight, reservation);
      budgetState.committed = addBudget(budgetState.committed, {
        elapsedMs: reservation.elapsedMs,
        tokenUnits: reservation.tokenUnits,
        costUnits: reservation.costUnits,
        attemptsUsed: reservation.attempts
      });
      budgetSettled = true;
    }
    if (primaryError && !thrown) throw primaryError;
  }
}

async function runBatch({ plan, batch, admission, authorization, lanes, executor, ownerLaunch = null, ownerLaunches = null, signal, budgetState, timers, directory,
  sealKey, initializationTimeoutMs }) {
  const controller = new AbortController();
  const abortParent = () => controller.abort(signal?.reason ?? new Error("review run was cancelled"));
  if (signal?.aborted) abortParent();
  else signal?.addEventListener("abort", abortParent, { once: true });
  let next = 0;
  let firstError = null;
  const completed = [];
  const worker = async () => {
    while (!controller.signal.aborted) {
      const index = next++;
      if (index >= lanes.length) return;
      const lane = lanes[index];
      try {
        const selectedOwnerLaunch = ownerLaunches === null
          ? ownerLaunch
          : ownerLaunchForLane(ownerLaunches, lane.lane);
        const output = await runLane({ plan, batch, admission, authorization, ...lane, executor,
          ownerLaunch: selectedOwnerLaunch,
          signal: controller.signal, budgetState, timers, directory, sealKey, initializationTimeoutMs });
        completed.push(...output.results.map((result, resultIndex) => ({
          result,
          artifacts: output.artifacts[resultIndex]
        })));
        if (output.budgetPaused) {
          firstError ??= new NativeReviewShardBudgetPause("Review budget exceeded after dispatch accounting");
          controller.abort(firstError);
        }
      } catch (error) {
        const candidateError = asRunError(error);
        // An UNKNOWN lane means an owned resource or provider outcome could
        // not be proven.  It must dominate an earlier HOLD from a sibling;
        // otherwise the durable run receipt could mask cleanup uncertainty.
        if (firstError === null || (candidateError.status === "UNKNOWN" && firstError.status !== "UNKNOWN")) {
          firstError = candidateError;
        }
        controller.abort(firstError);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(plan.policy.concurrency, lanes.length) }, () => worker()));
  } finally {
    if (signal && abortParent) signal.removeEventListener("abort", abortParent);
  }
  if (firstError) {
    firstError.completed = completed;
    throw firstError;
  }
  return completed;
}

function resultMapFromValues(values) {
  const map = new Map();
  for (const result of values) {
    assert(!map.has(result.assignmentId), "Duplicate completed review assignment");
    map.set(result.assignmentId, result);
  }
  return map;
}

function assertCompleteReplayBindings({ plan, checkpoint, checkpointSeal, receipt }) {
  const required = [...requiredAssignmentIds(plan)].sort();
  assert.equal(checkpoint.status, "COMPLETE", "replay checkpoint is not terminal complete");
  assert.equal(checkpointSeal.status, "COMPLETE", "replay checkpoint seal is not terminal complete");
  assert.deepEqual(checkpoint.completedAssignmentIds, required,
    "sealed checkpoint completed assignments do not cover the required result set");
  assert.deepEqual(checkpointSeal.completedAssignmentIds, required,
    "checkpoint seal completed assignments do not cover the required result set");
  assert.deepEqual(checkpoint.resultDigests, checkpointSeal.resultDigests,
    "checkpoint result set is not bound to its authenticated seal");
  assert.deepEqual(receipt.resultDigests, checkpointSeal.resultDigests,
    "replay receipt result set differs from the authenticated checkpoint");
  assert.deepEqual(receipt.coverage, {
    expectedAssignments: required.length,
    observedAssignments: checkpointSeal.resultDigests.length,
    complete: true
  }, "replay receipt coverage is not bound to the authenticated checkpoint");
  assert(receipt.aggregateDigest !== null, "complete replay receipt is missing its aggregate");
  assert.equal(receipt.laneReceiptDigests.length,
    plan.roles.filter(role => role.required).length,
    "complete replay receipt has an unexpected lane count");
}

async function loadCheckpointResults({ directory, checkpoint, plan, admission, authorization }) {
  const values = [];
  for (const resultDigest of checkpoint.resultDigests) {
    const loaded = await loadPersistedResult({ directory, resultDigest, plan,
      admissionDigest: checkpoint.admissionDigest,
      traceBinding: {
        runId: authorization.runId,
        executorDigest: authorization.executorDigest,
        epoch: checkpoint.epoch
      } });
    values.push(loaded.value);
  }
  const resultMap = resultMapFromValues(values);
  assert.deepEqual([...resultMap.keys()].sort(), checkpoint.completedAssignmentIds,
    "Checkpoint completed assignments are not bound to its persisted result set");
  return resultMap;
}

async function readCheckpointSealHistory({ directory, plan, authorization, sealKey }) {
  const names = await readdir(directory);
  const sealNames = names.filter(name => /^checkpoint-[0-9]{6}-[0-9]{6}\.json\.seal\.json$/.test(name));
  assert(sealNames.length <= 4096, "Review checkpoint seal history exceeds its bounded size");
  const entries = [];
  for (const sealName of sealNames) {
    const checkpointFile = sealName.slice(0, -".seal.json".length);
    const checkpointPath = path.join(directory, checkpointFile);
    const checkpoint = validateReviewCheckpoint((await loadJson(checkpointPath, "Review checkpoint", CHECKPOINT_SEAL_MAX_BYTES)).value, plan);
    const loaded = await loadJson(path.join(directory, sealName), "Review checkpoint seal", CHECKPOINT_SEAL_MAX_BYTES);
    const seal = validateCheckpointSeal(loaded.value, { checkpoint, plan, key: sealKey.key, keyId: sealKey.keyId, checkpointPath });
    const match = /^checkpoint-(\d{6})-(\d{6})\.json\.seal\.json$/.exec(sealName);
    assert(match, "Review checkpoint seal filename is invalid");
    assert.equal(seal.epoch, Number(match[1]), "Review checkpoint seal epoch is not bound to its filename");
    assert.equal(seal.checkpointSequence, Number(match[2]), "Review checkpoint seal sequence is not bound to its filename");
    if (seal.runId === authorization.runId && seal.planDigest === plan.planDigest &&
        seal.sourceDigest === plan.source.sourceDigest && seal.executorDigest === authorization.executorDigest) {
      entries.push({ checkpoint, seal, checkpointPath });
    }
  }
  entries.sort((left, right) => left.seal.epoch - right.seal.epoch || left.seal.checkpointSequence - right.seal.checkpointSequence);
  const tuples = new Set();
  for (const entry of entries) {
    const tuple = `${entry.seal.epoch}:${entry.seal.checkpointSequence}`;
    assert(!tuples.has(tuple), "Review checkpoint seal history contains a duplicate epoch/sequence");
    tuples.add(tuple);
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.seal.checkpointSequence > 0) {
      const predecessor = entries.find(item => item.seal.epoch === entry.seal.epoch &&
        item.seal.checkpointSequence === entry.seal.checkpointSequence - 1);
      assert(predecessor, "Review checkpoint seal history has a sequence gap");
      assert.equal(entry.seal.previousSealDigest, predecessor.seal.sealDigest,
        "Review checkpoint seal history predecessor is stale");
    } else {
      const predecessor = entries[index - 1] ?? null;
      assert(!predecessor || predecessor.seal.epoch < entry.seal.epoch,
        "Review checkpoint seal history is not ordered by epoch");
      assert.equal(entry.seal.previousSealDigest, predecessor?.seal.sealDigest ?? null,
        "Review checkpoint resume seal is not chained to the latest prior epoch");
    }
  }
  return entries;
}

function sameInitializationBinding(value, { plan, authorization, previousEpoch }) {
  return value.runId === authorization.runId &&
    value.planDigest === plan.planDigest &&
    value.sourceDigest === plan.source.sourceDigest &&
    value.executorDigest === authorization.executorDigest &&
    value.epoch <= previousEpoch;
}

/**
 * A resume may only create a new launch epoch after every historical owned
 * initialization has durable cleanup proof.  An UNKNOWN outcome is
 * reconciled only by its own cleanup receipt or a later signed CLEANED
 * observation; an absent or UNKNOWN observation remains fail-closed.
 */
async function assertResumeCleanupReconciled({ directory, plan, authorization, previousEpoch, sealKey }) {
  const fail = message => {
    throw new NativeReviewShardRunError("UNKNOWN", "ENATIVE_REVIEW_RESUME_CLEANUP", message);
  };
  try {
    const initializationDirectory = path.join(directory, "initialization");
    let names;
    try {
      names = await readdir(initializationDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const pendingNames = names.filter(name => name.endsWith(".pending.json"));
    const pendingIds = new Set();
    for (const pendingName of pendingNames) {
      const executionId = pendingName.slice(0, -".pending.json".length);
      safeId(executionId, "resume initialization.executionId");
      pendingIds.add(executionId);
      const pendingPath = path.join(initializationDirectory, pendingName);
      const pending = validateInitializationRecord(
        (await loadJson(pendingPath, "Review initialization pending record", CHECKPOINT_SEAL_MAX_BYTES)).value,
        { key: sealKey.key, keyId: sealKey.keyId, kind: INITIALIZATION_PENDING_KIND }
      );
      if (!sameInitializationBinding(pending, { plan, authorization, previousEpoch })) continue;
      const outcomePath = path.join(initializationDirectory, `${executionId}.outcome.json`);
      if (!(await pathExists(outcomePath))) fail(`resume found unfinished initialization cleanup for ${executionId}`);
      const outcome = validateInitializationRecord(
        (await loadJson(outcomePath, "Review initialization outcome record", CHECKPOINT_SEAL_MAX_BYTES)).value,
        { key: sealKey.key, keyId: sealKey.keyId, kind: INITIALIZATION_OUTCOME_KIND, pending }
      );
      if (!sameInitializationBinding(outcome, { plan, authorization, previousEpoch })) {
        fail(`resume initialization cleanup binding changed for ${executionId}`);
      }
      if (outcome.status === "CLEANED" || outcome.cleanup !== null) continue;
      const latePath = path.join(initializationDirectory, `${executionId}.cleanup-late.json`);
      if (!(await pathExists(latePath))) fail(`resume requires cleanup reconciliation for ${executionId}`);
      const late = validateInitializationRecord(
        (await loadJson(latePath, "Review initialization late cleanup observation", CHECKPOINT_SEAL_MAX_BYTES)).value,
        { key: sealKey.key, keyId: sealKey.keyId, kind: INITIALIZATION_OBSERVATION_KIND, pending }
      );
      if (late.outcomeDigest !== outcome.recordDigest || late.status !== "CLEANED" || late.cleanup === null) {
        fail(`resume cleanup reconciliation is not proven for ${executionId}`);
      }
    }
    for (const outcomeName of names.filter(name => name.endsWith(".outcome.json"))) {
      const executionId = outcomeName.slice(0, -".outcome.json".length);
      safeId(executionId, "resume initialization.executionId");
      if (pendingIds.has(executionId)) continue;
      const outcome = validateInitializationRecord(
        (await loadJson(path.join(initializationDirectory, outcomeName), "Review initialization outcome record", CHECKPOINT_SEAL_MAX_BYTES)).value,
        { key: sealKey.key, keyId: sealKey.keyId, kind: INITIALIZATION_OUTCOME_KIND }
      );
      if (sameInitializationBinding(outcome, { plan, authorization, previousEpoch })) {
        fail(`resume found orphaned initialization cleanup for ${executionId}`);
      }
    }
  } catch (error) {
    if (error instanceof NativeReviewShardRunError && error.code === "ENATIVE_REVIEW_RESUME_CLEANUP") throw error;
    throw new NativeReviewShardRunError("UNKNOWN", "ENATIVE_REVIEW_RESUME_CLEANUP",
      String(error?.message ?? error), error);
  }
}

async function assertResumeCheckpointIsLatest({ directory, checkpointPath, checkpoint, plan, authorization, sealKey }) {
  const targetPath = absolutePath(checkpointPath, "resume checkpointPath");
  assert.equal(await realpath(path.dirname(targetPath)), await realpath(directory),
    "resume checkpoint must be inside the runner state directory");
  const targetSeal = await readCheckpointSeal({ checkpointPath: targetPath, checkpoint, plan, key: sealKey.key, keyId: sealKey.keyId });
  assert.equal(targetSeal.runId, authorization.runId, "resume checkpoint belongs to a different run");
  assert.equal(targetSeal.executorDigest, authorization.executorDigest, "resume checkpoint belongs to a different executor");
  const history = await readCheckpointSealHistory({ directory, plan, authorization, sealKey });
  const target = history.find(entry => path.basename(entry.checkpointPath) === path.basename(targetPath) &&
    entry.seal.sealDigest === targetSeal.sealDigest);
  assert(target, "resume checkpoint seal is absent from the durable history");
  const latest = history.at(-1);
  assert(latest, "resume requires a durable checkpoint seal history");
  assert.equal(target.seal.sealDigest, latest.seal.sealDigest, "resume checkpoint is a stale or rolled-back history entry");
  return targetSeal;
}

function checkpointBudgetFromState(state) {
  assert.equal(state.inFlight.elapsedMs, 0);
  assert.equal(state.inFlight.tokenUnits, 0);
  assert.equal(state.inFlight.costUnits, 0);
  assert.equal(state.inFlight.attemptsUsed, 0);
  return normalizedBudget(state.committed);
}

async function terminalReceipt({ directory, plan, authorization, admission, status, checkpoint, checkpointPath, checkpointSeal, results }) {
  assertDiagnosticBudgetAuthorization(authorization);
  const required = requiredAssignmentIds(plan);
  const values = [...results.values()];
  const resultDigests = values.map(item => item.resultDigest);
  const laneReceiptDigests = [];
  let aggregateDigest = null;
  if (status === "COMPLETE" && resultDigests.length === required.length) {
    const lanes = [];
    for (const role of plan.roles.filter(item => item.required)) {
      const roleResults = values.filter(item => item.roleId === role.id);
      const lane = createSealedReviewLaneReceipt({ plan, roleId: role.id, results: roleResults });
      await immutableJson(lanePath(directory, lane.receiptDigest), lane, "Review lane receipt");
      lanes.push(lane);
      laneReceiptDigests.push(lane.receiptDigest);
    }
    const aggregate = createSealedReviewAggregate({ plan, laneReceipts: lanes,
      unitResults: values.filter(item => plan.assignments.find(a => a.id === item.assignmentId)?.required) });
    await immutableJson(aggregatePath(directory, aggregate.aggregateDigest), aggregate, "Review aggregate");
    aggregateDigest = aggregate.aggregateDigest;
    status = aggregate.verdict === "BLOCK" ? "BLOCKED" : aggregate.verdict === "UNKNOWN" ? "UNKNOWN" : "COMPLETE";
  }
  const receipt = buildReceipt({ plan, authorization, admission, status, checkpoint, checkpointSeal,
    resultDigests, laneReceiptDigests, aggregateDigest });
  const persisted = await immutableJson(path.join(directory, `receipt-${String(authorization.epoch).padStart(6, "0")}.json`), receipt, "Review run receipt");
  return { receipt, persisted, checkpointPath, receiptPath: persisted.path, aggregateDigest };
}

function defaultTimers() {
  return { setTimeout, clearTimeout, setInterval, clearInterval };
}

function validateRunnerOptions(options) {
  object(options, "runner options");
  assert(options.plan, "runner plan is required");
  assert(options.authorization, "runner budget authorization is required");
  assert(options.executor, "runner executor is required");
  const plan = validateReviewShardPlanV2(options.plan);
  assertExecutorCapability(options.executor, options.plan);
  if (isSimulationExecutor(options.executor)) {
    assert(options.ownerLaunch === undefined || options.ownerLaunch === null,
      "no-effect simulation cannot receive a host launch capability");
    assert(options.ownerLaunches === undefined || options.ownerLaunches === null,
      "no-effect simulation cannot receive host launch capabilities");
  } else {
    const expectedLaneCount = requiredLaneCount(plan);
    if (options.ownerLaunches !== undefined && options.ownerLaunches !== null) {
      assert(Array.isArray(options.ownerLaunches), "runner ownerLaunches must be an array");
      assert.equal(options.ownerLaunches.length, expectedLaneCount,
        "runner ownerLaunches must cover every required batch×role lane");
      const seen = new Set();
      for (const [index, ownerLaunch] of options.ownerLaunches.entries()) {
        assertOwnerLaunchCapability(ownerLaunch, `runner ownerLaunches[${index}]`);
        const lane = ownerLaunch.effectBinding.lane;
        assertLaneBinding(lane, `runner ownerLaunches[${index}].effectBinding.lane`);
        assert(lane !== null, `runner ownerLaunches[${index}] must bind an exact lane`);
        const key = laneKey(lane);
        assert(!seen.has(key), `runner ownerLaunches contains duplicate lane ${key}`);
        seen.add(key);
      }
      const expected = new Set(plan.batches.flatMap(batch => plan.roles.filter(role => role.required)
        .map(role => `${batch.batchId}\u0000${role.id}`)));
      assert.deepEqual([...seen].sort(), [...expected].sort(),
        "runner ownerLaunches do not cover the required lane set");
      assert(options.ownerLaunch === undefined || options.ownerLaunch === null,
        "runner cannot combine a lane array with the legacy owner launch");
    } else {
      assert(expectedLaneCount === 1,
        "a multi-lane real host run requires one genuine owner launch capability per lane");
      assert(options.ownerLaunch !== undefined && options.ownerLaunch !== null,
        "a real host launch requires a trusted current V3 owner capability");
      assertOwnerLaunchCapability(options.ownerLaunch);
      assert.equal(options.ownerLaunch.effectBinding.lane, null,
        "the legacy single-lane owner launch must not claim a different lane");
    }
  }
  absolutePath(options.stateDirectory, "runner stateDirectory");
  if (options.initializationTimeoutMs !== undefined) {
    integer(options.initializationTimeoutMs, "runner initializationTimeoutMs", { min: 1 });
  }
  return options;
}

/**
 * Execute every required role×unit assignment in bounded role×batch lanes.
 * Only private no-effect simulation diagnostics can currently reach this
 * lifecycle. Their COMPLETE/PASS data grants no production qualification,
 * and every resume/replay route remains denied.
 * One lane is one host transport for all units in a plan batch; its JSONL,
 * final text, and typed process receipt are revalidated here. The executor
 * cannot submit a sealed or authoritative result.
 */
export async function executeNativeReviewShardV2(options = {}) {
  const executor = options?.executor;
  assertDiagnosticExecutor(executor);
  const resumeFrom = options.resumeFrom ?? null;
  // Resume/replay never promotes metadata-only generic or simulation traces.
  if (resumeFrom !== null) assertNativeReviewV2ProductionDeliveryAvailable();
  validateRunnerOptions(options);
  const plan = validateReviewShardPlanV2(options.plan);
  validatePlanExecutionBounds(plan);
  const authorization = assertBudgetAuthorization(options.authorization, plan);
  // Deadline timers are runner-owned policy primitives. A caller-supplied
  // timer table could disable the init, hard, no-progress, or cleanup gates.
  const timers = defaultTimers();
  const signal = options.signal ?? new AbortController().signal;
  const directory = options.stateDirectory;
  const initializationTimeoutMs = options.initializationTimeoutMs ?? plan.policy.initTimeoutMs;
  integer(initializationTimeoutMs, "runner initializationTimeoutMs", { min: 1 });
  assert(initializationTimeoutMs <= plan.policy.initTimeoutMs, "runner initialization timeout cannot exceed the V2 policy bound");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([mkdir(path.join(directory, "results"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(directory, "traces"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(directory, "lanes"), { recursive: true, mode: 0o700 }),
    mkdir(path.join(directory, "aggregates"), { recursive: true, mode: 0o700 })]);
  const sealKey = await ensureCheckpointSealKey(directory);
  const admission = await createTrustedReviewAdmissionV2({ plan, authorization });
  assert.equal(authorization.executorDigest, executor.capabilityDigest,
    "review budget authorization is bound to a different host executor");
  let previous = resumeFrom;
  let previousSeal = null;
  if (typeof previous === "string") {
    const previousPath = absolutePath(previous, "resume checkpointPath");
    previous = await readReviewCheckpoint({ checkpointPath: previousPath, plan });
    previousSeal = await assertResumeCheckpointIsLatest({ directory, checkpointPath: previousPath, checkpoint: previous,
      plan, authorization, sealKey });
  }
  let checkpoint;
  let checkpointSequence = 0;
  let results = new Map();
  if (previous) {
    validateReviewCheckpoint(previous, plan);
    assert.equal(previous.runId, authorization.runId);
    assert.equal(previous.planDigest, plan.planDigest);
    assert(authorization.epoch > previous.epoch, "resume requires a newer authorization epoch");
    assert.equal(previous.status === "COMPLETE", false, "completed review cannot be resumed");
    await assertResumeCleanupReconciled({ directory, plan, authorization, previousEpoch: previous.epoch, sealKey });
    results = await loadCheckpointResults({ directory, checkpoint: previous, plan, admission, authorization });
    checkpoint = resumeReviewCheckpoint({ checkpoint: previous, plan, newEpoch: authorization.epoch,
      newGrantDigest: authorization.grantDigest, newAdmissionDigest: admission.admissionDigest });
  } else {
    checkpoint = createReviewCheckpoint({ plan, runId: authorization.runId, epoch: authorization.epoch,
      grantDigest: authorization.grantDigest, admissionDigest: admission.admissionDigest, status: "READY" });
  }
  let lastSealDigest = previousSeal?.sealDigest ?? null;
  const first = await writeCheckpoint({ directory, plan, authorization, checkpoint, sequence: checkpointSequence++,
    previousSealDigest: lastSealDigest, sealKey });
  lastSealDigest = first.seal.sealDigest;
  const budgetState = { committed: normalizedBudget(checkpoint.budget), inFlight: initialBudget() };
  let currentBatchIndex = checkpoint.nextBatchIndex;
  if (signal.aborted) {
    const halted = createReviewCheckpoint({ plan, runId: authorization.runId, epoch: authorization.epoch,
      grantDigest: authorization.grantDigest, admissionDigest: admission.admissionDigest, status: "UNKNOWN",
      completedAssignmentIds: [...results.keys()], nextBatchIndex: checkpoint.nextBatchIndex,
      budget: checkpointBudgetFromState(budgetState), resultDigests: [...results.values()].map(item => item.resultDigest),
      resumedFrom: previous?.checkpointDigest ?? null });
    const saved = await writeCheckpoint({ directory, plan, authorization, checkpoint: halted, sequence: checkpointSequence++,
      previousSealDigest: lastSealDigest, sealKey });
    lastSealDigest = saved.seal.sealDigest;
    return terminalReceipt({ directory, plan, authorization, admission, status: "UNKNOWN", checkpoint: saved.checkpoint,
      checkpointPath: saved.path, checkpointSeal: saved.seal, results });
  }
  try {
    for (let batchIndex = checkpoint.nextBatchIndex; batchIndex < plan.batches.length; batchIndex += 1) {
      currentBatchIndex = batchIndex;
      await assertReviewShardPlanFresh(plan);
      const batch = plan.batches[batchIndex];
      const pending = batch.assignmentIds.filter(id => !results.has(id) && plan.assignments.find(item => item.id === id)?.required);
      if (!pending.length) continue;
      const lanes = laneAssignmentsForBatch(plan, batch, results);
      try {
        const completed = await runBatch({ plan, batch, admission, authorization, lanes, executor,
          ownerLaunch: options.ownerLaunch ?? null,
          ownerLaunches: options.ownerLaunches ?? null,
          signal, budgetState, timers, directory, sealKey, initializationTimeoutMs });
        for (const item of completed) results.set(item.result.assignmentId, item.result);
        const nextCheckpoint = createReviewCheckpoint({ plan, runId: authorization.runId, epoch: authorization.epoch,
          grantDigest: authorization.grantDigest, admissionDigest: admission.admissionDigest, status: "RUNNING",
          completedAssignmentIds: [...results.keys()], nextBatchIndex: batchIndex + 1,
          budget: checkpointBudgetFromState(budgetState), resultDigests: [...results.values()].map(item => item.resultDigest) });
        checkpoint = nextCheckpoint;
        const saved = await writeCheckpoint({ directory, plan, authorization, checkpoint, sequence: checkpointSequence++,
          previousSealDigest: lastSealDigest, sealKey });
        lastSealDigest = saved.seal.sealDigest;
      } catch (error) {
        for (const item of error.completed ?? []) results.set(item.result.assignmentId, item.result);
        const runError = asRunError(error);
        const halted = createReviewCheckpoint({ plan, runId: authorization.runId, epoch: authorization.epoch,
          grantDigest: authorization.grantDigest, admissionDigest: admission.admissionDigest,
          status: runError.status, completedAssignmentIds: [...results.keys()], nextBatchIndex: batchIndex,
          budget: checkpointBudgetFromState(budgetState), resultDigests: [...results.values()].map(item => item.resultDigest) });
        const saved = await writeCheckpoint({ directory, plan, authorization, checkpoint: halted, sequence: checkpointSequence++,
          previousSealDigest: lastSealDigest, sealKey });
        lastSealDigest = saved.seal.sealDigest;
        return terminalReceipt({ directory, plan, authorization, admission, status: runError.status, checkpoint: saved.checkpoint,
          checkpointPath: saved.path, checkpointSeal: saved.seal, results });
      }
    }
    await assertReviewShardPlanFresh(plan);
    assert.equal(results.size, requiredAssignmentIds(plan).length, "Review execution did not cover every required role×unit assignment");
    const complete = createReviewCheckpoint({ plan, runId: authorization.runId, epoch: authorization.epoch,
      grantDigest: authorization.grantDigest, admissionDigest: admission.admissionDigest, status: "COMPLETE",
      completedAssignmentIds: [...results.keys()], nextBatchIndex: plan.batches.length,
      budget: checkpointBudgetFromState(budgetState), resultDigests: [...results.values()].map(item => item.resultDigest) });
    const saved = await writeCheckpoint({ directory, plan, authorization, checkpoint: complete, sequence: checkpointSequence++,
      previousSealDigest: lastSealDigest, sealKey });
    lastSealDigest = saved.seal.sealDigest;
    return terminalReceipt({ directory, plan, authorization, admission, status: "COMPLETE", checkpoint: saved.checkpoint,
      checkpointPath: saved.path, checkpointSeal: saved.seal, results });
  } catch (error) {
    const runError = asRunError(error, "HOLD");
    const halted = createReviewCheckpoint({ plan, runId: authorization.runId, epoch: authorization.epoch,
      grantDigest: authorization.grantDigest, admissionDigest: admission.admissionDigest, status: runError.status,
      completedAssignmentIds: [...results.keys()], nextBatchIndex: currentBatchIndex,
      budget: checkpointBudgetFromState(budgetState), resultDigests: [...results.values()].map(item => item.resultDigest) });
    const saved = await writeCheckpoint({ directory, plan, authorization, checkpoint: halted, sequence: checkpointSequence++,
      previousSealDigest: lastSealDigest, sealKey });
    lastSealDigest = saved.seal.sealDigest;
    return terminalReceipt({ directory, plan, authorization, admission, status: runError.status, checkpoint: saved.checkpoint,
      checkpointPath: saved.path, checkpointSeal: saved.seal, results });
  }
}

/** Deny every production replay, including generic and simulation history without trusted delivery. */
export async function replayNativeReviewShardV2(options = {}) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  const { plan, authorization, stateDirectory, checkpointPath, receiptPath = undefined } = options;
  const canonicalPlan = validateReviewShardPlanV2(plan);
  assertBudgetAuthorization(authorization, canonicalPlan);
  absolutePath(stateDirectory, "replay stateDirectory");
  const admission = await createTrustedReviewAdmissionV2({ plan: canonicalPlan, authorization });
  const canonicalCheckpointPath = absolutePath(checkpointPath, "checkpointPath");
  assert.equal(await realpath(path.dirname(canonicalCheckpointPath)), await realpath(stateDirectory),
    "replay checkpoint must be inside the runner state directory");
  const sealKey = await ensureCheckpointSealKey(stateDirectory);
  const checkpointFile = await readReviewCheckpoint({ checkpointPath: canonicalCheckpointPath, plan: canonicalPlan });
  const checkpointSeal = await readCheckpointSeal({ checkpointPath: canonicalCheckpointPath, checkpoint: checkpointFile,
    plan: canonicalPlan, authorization, key: sealKey.key, keyId: sealKey.keyId });
  assert.equal(checkpointSeal.epoch, authorization.epoch, "replay checkpoint seal epoch does not match current authorization");
  const target = receiptPath ?? path.join(stateDirectory, `receipt-${String(authorization.epoch).padStart(6, "0")}.json`);
  await assertStateScopedFile(stateDirectory, target, "replay receiptPath");
  const { value: receipt } = await loadJson(target, "Review run receipt");
  validateRunReceipt(receipt, canonicalPlan, authorization, admission);
  assert.equal(receipt.receiptDigest, digestObject(receiptBody(receipt)), "replay receipt digest is stale");
  assert.equal(receipt.status, "COMPLETE", "only a terminal complete receipt can be replayed");
  assert.equal(receipt.checkpointDigest, checkpointFile.checkpointDigest);
  assert.equal(receipt.checkpointSealDigest, checkpointSeal.sealDigest);
  assertCompleteReplayBindings({ plan: canonicalPlan, checkpoint: checkpointFile, checkpointSeal, receipt });
  assert.equal(checkpointFile.epoch, authorization.epoch);
  const values = [];
  for (const resultDigest of receipt.resultDigests) {
    values.push((await loadPersistedResult({ directory: stateDirectory, resultDigest, plan: canonicalPlan, admission,
      traceBinding: { runId: authorization.runId, executorDigest: authorization.executorDigest, epoch: authorization.epoch } })).value);
  }
  const resultMap = resultMapFromValues(values);
  assert.deepEqual([...resultMap.keys()].sort(), checkpointSeal.completedAssignmentIds,
    "replay result assignments differ from the authenticated checkpoint");
  assert.deepEqual([...resultMap.values()].map(item => item.resultDigest).sort(), checkpointSeal.resultDigests,
    "replay result bodies differ from the authenticated checkpoint result set");
  const expectedLanes = canonicalPlan.roles.filter(role => role.required).map(role =>
    createSealedReviewLaneReceipt({ plan: canonicalPlan, roleId: role.id,
      results: values.filter(item => item.roleId === role.id) }));
  const expectedLaneByDigest = new Map(expectedLanes.map(lane => [lane.receiptDigest, lane]));
  assert.deepEqual(receipt.laneReceiptDigests, [...expectedLaneByDigest.keys()].sort(),
    "replay lane set is not bound to its authenticated result set");
  const lanes = [];
  for (const laneDigest of receipt.laneReceiptDigests) {
    const lane = (await loadJson(lanePath(stateDirectory, laneDigest), "Review lane receipt")).value;
    const validated = validateSealedReviewLaneReceipt(lane, canonicalPlan);
    assert.deepEqual(validated, expectedLaneByDigest.get(laneDigest),
      "replay lane receipt is not bound to the authenticated result set");
    lanes.push(validated);
  }
  const aggregate = validateSealedReviewAggregate(
    (await loadJson(aggregatePath(stateDirectory, receipt.aggregateDigest), "Review aggregate")).value,
    canonicalPlan
  );
  assert.equal(aggregate.aggregateDigest, receipt.aggregateDigest);
  assert.deepEqual(aggregate.laneReceiptDigests, receipt.laneReceiptDigests,
    "replay aggregate lanes are not bound to the receipt");
  assert.deepEqual(aggregate.resultDigests, receipt.resultDigests,
    "replay aggregate results are not bound to the receipt");
  const expected = createSealedReviewAggregate({ plan: canonicalPlan, laneReceipts: lanes,
    unitResults: values.filter(item => canonicalPlan.assignments.find(a => a.id === item.assignmentId)?.required) });
  assert.deepEqual(expected, aggregate, "replayed aggregate differs from persisted aggregate");
  assert.equal(aggregate.authoritative, false);
  assert.equal(aggregate.admission.status, "REQUIRED");
  return { status: "REPLAYED", receipt, checkpoint: checkpointFile, admission, aggregate, results: values };
}

export function isTrustedReviewBudgetAuthorizationV2(value) {
  return BUDGET_AUTHORIZATIONS.has(value);
}

export function isTrustedReviewAdmissionV2(value) {
  return ADMISSIONS.has(value);
}
