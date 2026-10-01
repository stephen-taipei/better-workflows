import assert from "node:assert/strict";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { digestObject } from "./core.mjs";
import { captureSourceBinding } from "./git.mjs";
import { assertPhysicalPath, boundedFile } from "./native-review-runner.mjs";
import {
  DEFAULT_REVIEW_SHARDED_V2_POLICY,
  createTrustedReviewShardPlanV2,
  readReviewCheckpoint,
  validateReviewShardPlanV2,
  validateSealedReviewAggregate
} from "./native-review-sharded-v2.mjs";
import {
  NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL,
  NATIVE_REVIEW_SHARD_RUNNER_V2_RECEIPT_KIND,
  assertNativeReviewV2ProductionDeliveryAvailable,
  createNativeReviewHostExecutorV2,
  createNativeReviewV2EffectBinding,
  createTrustedReviewAdmissionV2,
  createTrustedReviewBudgetAuthorizationV2,
  createTrustedReviewOwnerLaunchCapabilityV2,
  executeNativeReviewShardV2,
  isTrustedReviewBudgetAuthorizationV2,
  replayNativeReviewShardV2
} from "./native-review-shard-runner-v2.mjs";
import {
  collectCooperativeNativeV3OwnerDecision,
  createCooperativeNativeV3Controller,
  nativeV3AllocationKeyFor,
  prepareCooperativeNativeV3Approval,
  revokeCooperativeNativeV3Controller
} from "./native-v3-cooperative-controller.mjs";
import { createNativeV3TrustPolicyReader, readInstalledNativeV3TrustPolicy } from "./native-v3-trust-policy.mjs";
import {
  buildWorkflowPlanV1,
  createTaskContractV3,
  persistWorkflowPlanV1
} from "./workflow-plan-v1.mjs";

export const NATIVE_REVIEW_CLI_V2_SCHEMA_VERSION = 1;
export const NATIVE_REVIEW_CLI_V2_KIND = "NativeReviewCliV2";
export const NATIVE_REVIEW_CLI_V2_PROTOCOL = NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL;
export const NATIVE_REVIEW_CLI_V2_ACCOUNTING_KIND = "local-lane-accounting-v1";
export const NATIVE_REVIEW_CLI_V2_PROVIDER_QUOTA_STATUS = "UNVERIFIED";

const MAX_INPUT_JSON_BYTES = 128 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RECEIPT_STATUSES = new Set(["COMPLETE", "PAUSED_BUDGET", "HOLD", "UNKNOWN", "BLOCKED"]);
const PREPARED = new WeakSet();
const OUTCOMES = new WeakSet();
const TEST_REVOKE_FAILURES = new WeakMap();
const NATIVE_REVIEW_V2_OWNER_BRIDGE_KIND = "NativeReviewV2OwnerBridgeV1";
const NATIVE_REVIEW_V2_OWNER_TASK_ID = "native-review-v2";
const NATIVE_REVIEW_V2_OWNER_UNIT_ID = "native-review-v2-effect";
const NATIVE_REVIEW_V2_OWNER_ACTION = "execute-native-review-v2";
const NATIVE_REVIEW_V2_OWNER_RECIPIENT = "native-review-v2-local-host";
const NATIVE_REVIEW_V2_OWNER_TRUST_MODE = "cooperative-user-mode";
// A complete source capture on macOS can approach the controller's 4s bound
// under concurrent Git activity. V2 uses that bounded maximum; each phase
// still performs a fresh capture and the runner's initialization deadline
// remains the overall bound.
const NATIVE_REVIEW_V2_FRESH_RESOLVER_TIMEOUT_MS = 4_000;

function nativeReviewV2OwnerRunId(authorization) {
  return `sbw-19700101T000000Z-${digestObject({
    schemaVersion: 1,
    kind: "NativeReviewV2OwnerRunIdV1",
    runId: authorization.runId,
    epoch: authorization.epoch,
    authorizationDigest: authorization.authDigest
  }).slice(0, 12)}`;
}

function nativeReviewV2OwnerLaneIdentity(authorization, lane) {
  const laneDigest = digestObject({
    schemaVersion: 1,
    kind: "NativeReviewV2OwnerLaneIdentityV1",
    authorizationDigest: authorization.authDigest,
    lane
  });
  return {
    executionId: `native-review-v2-${laneDigest.slice(0, 40)}`,
    attemptId: `attempt-${authorization.epoch}-${laneDigest.slice(0, 24)}`,
    taskId: `native-review-v2-task-${laneDigest.slice(0, 32)}`,
    unitId: `native-review-v2-unit-${laneDigest.slice(32, 64)}`
  };
}

function nativeReviewV2OwnerExpiry(value) {
  const candidate = value === undefined
    ? new Date(Date.now() + 15 * 60 * 1000)
    : new Date(value);
  assert(Number.isFinite(candidate.getTime()), "V2 owner approval expiry is invalid");
  return candidate.toISOString();
}

const DEFAULT_HOST_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  NODE_NO_WARNINGS: "1"
});

function object(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function knownOptions(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  assert.equal(unknown.length, 0, `Unknown ${label} field(s): ${unknown.join(", ")}`);
}

function required(value, label) {
  assert(value !== undefined && value !== null, `${label} is required`);
  return value;
}

function safeId(value, label) {
  assert(typeof value === "string" && SAFE_ID.test(value), `${label} must be a safe identifier`);
  return value;
}

function digest(value, label) {
  assert(typeof value === "string" && DIGEST.test(value), `${label} must be a SHA-256 digest`);
  return value;
}

function integer(value, label, { min = 0 } = {}) {
  assert(Number.isSafeInteger(value) && value >= min, `${label} must be a bounded integer`);
  return value;
}

function absolutePath(value, label) {
  assert(typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value &&
    !value.includes("\0") && !value.split(path.sep).includes(".."),
  `${label} must be an absolute normalized path`);
  return value;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function normalizeArgs(value = []) {
  assert(Array.isArray(value) && value.length <= 64, "V2 host args are bounded");
  return value.map((item, index) => {
    assert(typeof item === "string" && item.length <= 4096 && !item.includes("\0"),
      `V2 host args[${index}] is invalid`);
    return item;
  });
}

function normalizeEnv(value = DEFAULT_HOST_ENV) {
  object(value, "V2 host environment");
  const keys = Object.keys(value);
  assert(keys.length <= 128, "V2 host environment is bounded");
  for (const key of keys) {
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key), `V2 host environment key is invalid: ${key}`);
    assert(typeof value[key] === "string" && value[key].length <= 32 * 1024 && !value[key].includes("\0"),
      `V2 host environment value is invalid: ${key}`);
    assert(!/^(NODE_OPTIONS|NODE_PATH|NPM_CONFIG_|npm_config_|CODEX_HOME|CODEX_BINARY|SBW_STATE_ROOT|BW_NATIVE_REVIEW_INPUT_PATH)$/.test(key),
      `V2 host environment cannot select toolchain authority: ${key}`);
  }
  return Object.freeze({ ...value });
}

function normalizeBudgetOverride(value, label, { reservation = false } = {}) {
  if (value === undefined) return undefined;
  object(value, label);
  const keys = reservation
    ? ["elapsedMs", "tokenUnits", "costUnits", "attempts"]
    : ["elapsedMs", "tokenUnits", "costUnits", "attemptsUsed"];
  assert.deepEqual(Object.keys(value).sort(), keys.sort(), `${label} fields are not canonical`);
  for (const key of keys) integer(value[key], `${label}.${key}`, { min: reservation ? 1 : 0 });
  return Object.freeze({ ...value });
}

function ownerLaneDefinitions(plan) {
  const assignments = new Map(plan.assignments.map(item => [item.id, item]));
  const lanes = [];
  for (const batch of plan.batches) {
    for (const role of plan.roles.filter(item => item.required)) {
      const laneAssignments = batch.assignmentIds
        .map(assignmentId => assignments.get(assignmentId))
        .filter(item => item?.roleId === role.id);
      if (laneAssignments.length === 0) continue;
      lanes.push(Object.freeze({
        batchId: batch.batchId,
        roleId: role.id,
        assignmentIds: laneAssignments.map(item => item.id),
        unitIds: laneAssignments.map(item => item.unitId)
      }));
    }
  }
  assert(lanes.length > 0, "V2 owner approval requires at least one required lane");
  return lanes;
}

function ownerBridgeScope(plan, lane) {
  const laneUnits = new Set(lane.unitIds);
  const paths = new Set();
  for (const unit of plan.units) {
    if (!laneUnits.has(unit.id)) continue;
    if (typeof unit.path === "string") paths.add(unit.path);
    if (typeof unit.oldPath === "string") paths.add(unit.oldPath);
  }
  for (const entry of plan.context.paths) {
    if (typeof entry?.path === "string") paths.add(entry.path);
  }
  assert(paths.size > 0, "V2 owner approval requires a non-empty review scope");
  return { include: [...paths].sort(), exclude: [] };
}

function ownerBridgeBudget(authorization) {
  const reservation = authorization.reservation;
  return {
    attempts: reservation.attempts,
    seconds: Math.max(1, Math.ceil(reservation.elapsedMs / 1000)),
    tokens: reservation.tokenUnits
  };
}

function ownerApprovalProjection(value, label = "V2 owner approval") {
  object(value, label);
  knownOptions(value, [
    "kind", "ownerRunId", "bridgePlanId", "bridgePlanDigest", "bridgeContractDigest", "taskId", "unitId", "executionId",
    "attemptId", "sourceBinding", "policyDigest", "effectBindingDigest", "ownerApprovalRequest",
    "approvalEnvelope", "allocation", "lane"
  ], label);
  assert.equal(value.kind, NATIVE_REVIEW_V2_OWNER_BRIDGE_KIND);
  assert.match(value.ownerRunId, /^sbw-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/);
  for (const key of ["bridgePlanId", "taskId", "unitId", "executionId", "attemptId"]) safeId(value[key], `${label}.${key}`);
  for (const key of ["bridgePlanDigest", "bridgeContractDigest", "policyDigest", "effectBindingDigest"]) {
    digest(value[key], `${label}.${key}`);
  }
  assert(value.lane && typeof value.lane === "object" && !Array.isArray(value.lane), `${label}.lane is required`);
  knownOptions(value.lane, ["batchId", "roleId", "assignmentIds", "unitIds"], `${label}.lane`);
  safeId(value.lane.batchId, `${label}.lane.batchId`);
  safeId(value.lane.roleId, `${label}.lane.roleId`);
  assert(Array.isArray(value.lane.assignmentIds) && value.lane.assignmentIds.length > 0,
    `${label}.lane.assignmentIds is invalid`);
  assert(Array.isArray(value.lane.unitIds) && value.lane.unitIds.length === value.lane.assignmentIds.length,
    `${label}.lane.unitIds is invalid`);
  value.lane.assignmentIds.forEach((item, index) => safeId(item, `${label}.lane.assignmentIds[${index}]`));
  value.lane.unitIds.forEach((item, index) => safeId(item, `${label}.lane.unitIds[${index}]`));
  object(value.sourceBinding, `${label}.sourceBinding`);
  safeId(value.sourceBinding.revision, `${label}.sourceBinding.revision`);
  digest(value.sourceBinding.digest, `${label}.sourceBinding.digest`);
  object(value.ownerApprovalRequest, `${label}.ownerApprovalRequest`);
  object(value.approvalEnvelope, `${label}.approvalEnvelope`);
  object(value.allocation, `${label}.allocation`);
  safeId(value.allocation.ownedResourceId, `${label}.allocation.ownedResourceId`);
  integer(value.allocation.authorityEpoch, `${label}.allocation.authorityEpoch`, { min: 1 });
  digest(value.allocation.fence, `${label}.allocation.fence`);
  safeId(value.allocation.nonce, `${label}.allocation.nonce`);
  digest(value.ownerApprovalRequest.requestDigest, `${label}.ownerApprovalRequest.requestDigest`);
  assert(typeof value.ownerApprovalRequest.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.ownerApprovalRequest.expiresAt)),
  `${label}.ownerApprovalRequest.expiresAt must be an ISO timestamp`);
  digest(value.approvalEnvelope.digest, `${label}.approvalEnvelope.digest`);
  assert.equal(value.ownerApprovalRequest.candidateDigest, value.approvalEnvelope.digest);
  assert.equal(value.ownerApprovalRequest.effectBindingDigest, value.effectBindingDigest);
  assert.equal(value.ownerApprovalRequest.runId, value.ownerRunId);
  assert.equal(value.ownerApprovalRequest.planId, value.bridgePlanId);
  assert.equal(value.ownerApprovalRequest.planDigest, value.bridgePlanDigest);
  assert.equal(value.ownerApprovalRequest.contractDigest, value.bridgeContractDigest);
  assert.equal(value.ownerApprovalRequest.sourceBindingDigest, value.sourceBinding.digest);
  assert.equal(value.ownerApprovalRequest.policyDigest, value.policyDigest);
  assert.equal(value.ownerApprovalRequest.taskId, value.taskId);
  assert.equal(value.ownerApprovalRequest.unitId, value.unitId);
  assert.equal(value.ownerApprovalRequest.executionId, value.executionId);
  assert.equal(value.ownerApprovalRequest.attemptId, value.attemptId);
  assert.equal(value.ownerApprovalRequest.ownedResourceId, value.allocation.ownedResourceId);
  assert.equal(value.ownerApprovalRequest.nonce, value.allocation.nonce);
  assert.equal(value.approvalEnvelope.planDigest, value.bridgePlanDigest);
  assert.equal(value.approvalEnvelope.contractDigest, value.bridgeContractDigest);
  assert.equal(value.approvalEnvelope.sourceBindingDigest, value.sourceBinding.digest);
  assert.equal(value.approvalEnvelope.policyDigest, value.policyDigest);
  assert.equal(value.approvalEnvelope.runId, value.ownerApprovalRequest.runId);
  assert.equal(value.approvalEnvelope.executionId, value.executionId);
  assert.equal(value.approvalEnvelope.attemptId, value.attemptId);
  assert.equal(value.approvalEnvelope.taskId, value.taskId);
  assert.equal(value.approvalEnvelope.unitId, value.unitId);
  assert.equal(value.approvalEnvelope.ownedResourceId, value.allocation.ownedResourceId);
  assert.equal(value.approvalEnvelope.nonce, value.allocation.nonce);
  return value;
}

function ownerApprovalDigestProjection(value) {
  const owner = ownerApprovalProjection(value);
  return {
    lane: owner.lane,
    request: owner.ownerApprovalRequest.requestDigest,
    effect: owner.effectBindingDigest,
    plan: owner.bridgePlanDigest,
    run: owner.ownerRunId,
    task: owner.taskId,
    unit: owner.unitId,
    execution: owner.executionId,
    attempt: owner.attemptId
  };
}

function preparedDigestBody({ body, ownerApprovals }) {
  return {
    schemaVersion: body.schemaVersion,
    kind: body.kind,
    protocol: body.protocol,
    planDigest: body.plan.planDigest,
    sourceDigest: body.plan.source.sourceDigest,
    executorDigest: body.executor.capabilityDigest,
    authorizationDigest: body.authorization.authDigest,
    ownerApprovalDigests: ownerApprovals.map(ownerApprovalDigestProjection),
    runId: body.authorization.runId,
    epoch: body.authorization.epoch,
    stateDirectory: body.stateDirectory
  };
}

// captureSourceBinding is intentionally a full Git/working-tree snapshot.
// Each controller phase must invoke it for itself. A completed observation is
// never cached across phases: the source may change after any observation, and
// a cached result cannot prove the bytes used by the next reservation,
// authorization, or launch commit.
function createFreshSourceResolver(repository, expected, {
  runId,
  planId,
  label = "V2 owner source binding",
  initialCaptures = []
} = {}) {
  assert(Array.isArray(initialCaptures), `${label} initial captures must be an array`);
  const bootstrap = [...initialCaptures];
  for (const capture of bootstrap) {
    if (!capture || typeof capture.then !== "function") {
      throw new Error(`${label} initial capture is invalid`);
    }
    capture.catch(() => {});
  }
  let serial = Promise.resolve();
  let driftError = null;
  const assertFresh = (fresh) => {
    if (driftError) throw driftError;
    if (!fresh || fresh.headRevision !== expected.revision || fresh.digest !== expected.digest) {
      const error = new Error(`${label} drifted`);
      error.code = "ESOURCE_BINDING_DRIFT";
      error.status = "HOLD";
      // Once a complete capture observes a different source, no later result
      // may reopen this owner lane. A caller retry must build a new epoch.
      driftError = error;
      throw error;
    }
    return { revision: fresh.headRevision, digest: fresh.digest };
  };
  const resolve = async ({ runId: requestedRunId, planId: requestedPlanId, expected: requestedExpected }) => {
    assert.equal(requestedRunId, runId);
    assert.equal(requestedPlanId, planId);
    if (requestedExpected !== undefined) assert.deepEqual(requestedExpected, expected);
    if (driftError) throw driftError;
    // The producer may provide a fixed number of complete observations for
    // controller bootstrap. They are consumed only by those first calls and
    // are never retained for reservation, authorization, or launch phases.
    // Every call after bootstrap starts a new complete capture at that phase.
    if (bootstrap.length > 0) return assertFresh(await bootstrap.shift());
    // Serialize callers, but await the complete capture in the phase that
    // requested it. The controller's bounded operation may return HOLD when
    // the trusted Git snapshot cannot finish within its callback budget;
    // retaining an earlier result would be an unsafe freshness downgrade.
    const next = serial.catch(() => undefined).then(() => startTrustedSourceCapture(repository));
    serial = next;
    const fresh = await next;
    return assertFresh(fresh);
  };
  return Object.freeze(resolve);
}

function startTrustedSourceCapture(repository) {
  return captureSourceBinding(repository, { requireClean: true });
}

async function admitNativeReviewV2Owner(prepared, ownerApprovalValue, ownerDecision) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  const owner = ownerApprovalProjection(ownerApprovalValue);
  const ownerRunId = owner.ownerRunId;
  const trustMode = NATIVE_REVIEW_V2_OWNER_TRUST_MODE;
  // The controller performs exactly two fresh reads while it bootstraps its
  // allocation. These complete observations are consumed only by those two
  // calls; subsequent execution-binding and launch phases use the resolver's
  // per-call capture path.
  const bootstrapCaptures = await Promise.all([
    startTrustedSourceCapture(prepared.plan.source.repository),
    startTrustedSourceCapture(prepared.plan.source.repository)
  ]);
  const readFreshSourceBinding = createFreshSourceResolver(
    prepared.plan.source.repository,
    owner.sourceBinding,
    {
      runId: ownerRunId,
      planId: owner.bridgePlanId,
      label: "Current V2 owner source binding",
      initialCaptures: bootstrapCaptures.map(value => Promise.resolve(value))
    }
  );
  const created = await createCooperativeNativeV3Controller({
    stateRoot: prepared.stateDirectory,
    planId: owner.bridgePlanId,
    runId: ownerRunId,
    taskId: owner.taskId,
    unitId: owner.unitId,
    executionId: owner.executionId,
    attemptId: owner.attemptId,
    approvalEnvelope: owner.approvalEnvelope,
    sourceBinding: owner.sourceBinding,
    policyDigest: owner.policyDigest,
    allocationKey: nativeV3AllocationKeyFor({ taskId: owner.taskId, attemptId: owner.attemptId }),
    trustMode,
    readFreshSourceBinding,
    readTrustPolicy: createNativeV3TrustPolicyReader(),
    freshResolverTimeoutMs: NATIVE_REVIEW_V2_FRESH_RESOLVER_TIMEOUT_MS,
    effectBindingDigest: owner.effectBindingDigest,
    ownerDecision
  });
  const binding = {
    runId: ownerRunId,
    executionId: owner.executionId,
    attemptId: owner.attemptId,
    unitId: owner.unitId,
    sourceBindingDigest: owner.sourceBinding.digest,
    policyDigest: owner.policyDigest,
    revision: owner.sourceBinding.revision,
    ownedResourceId: owner.allocation.ownedResourceId
  };
  const current = await created.controller.readExecutionBinding({
    runId: ownerRunId,
    binding
  });
  assert.equal(current.sourceBinding.digest, owner.sourceBinding.digest);
  assert.equal(current.sourceBinding.revision, owner.sourceBinding.revision);
  assert.equal(current.authority.status, "active");
  assert.equal(current.authority.revoked, false);
  assert.equal(current.authority.authorityEpoch, owner.allocation.authorityEpoch);
  assert.equal(current.authority.fence, owner.allocation.fence);
  return {
    owner,
    stateRoot: prepared.stateDirectory,
    runId: ownerRunId,
    created,
    readFreshSourceBinding,
    binding,
    current,
    receipt: Object.freeze({
      kind: "NativeReviewV2OwnerAdmissionV1",
      status: "admitted",
      ownerRunId,
      bridgePlanId: owner.bridgePlanId,
      bridgePlanDigest: owner.bridgePlanDigest,
      bridgeContractDigest: owner.bridgeContractDigest,
      ownerApprovalRequestDigest: owner.ownerApprovalRequest.requestDigest,
      lane: owner.lane,
      effectBindingDigest: owner.effectBindingDigest,
      sourceBinding: owner.sourceBinding,
      authorityEpoch: current.authority.authorityEpoch,
      fence: current.authority.fence,
      authorityDigest: digestObject(current.authority)
    })
  };
}

async function revokeNativeReviewV2Owner(admitted, injectedFailure = null) {
  if (injectedFailure) throw injectedFailure;
  const receipt = await revokeCooperativeNativeV3Controller({
    stateRoot: admitted.stateRoot,
    runId: admitted.runId,
    taskId: admitted.owner.taskId,
    attemptId: admitted.owner.attemptId,
    allocationKey: nativeV3AllocationKeyFor({ taskId: admitted.owner.taskId, attemptId: admitted.owner.attemptId }),
    expectedEpoch: admitted.current.authority.authorityEpoch,
    expectedFence: admitted.current.authority.fence,
    reason: "native-review-v2 execution finished"
  });
  return receipt;
}

function testRevokeFailureFor(prepared, index) {
  const failures = TEST_REVOKE_FAILURES.get(prepared);
  if (!failures?.has(index)) return null;
  const error = new Error(`test owner revocation failure at index ${index}`);
  error.code = "EOWNER_REVOCATION_TEST_FAILURE";
  return error;
}

/** Test-only seam for exercising complete owner revocation failure handling. */
export function __testConfigureNativeReviewV2RevokeFailures(prepared, failIndexes = []) {
  assertPrepared(prepared);
  assert(Array.isArray(failIndexes), "test revoke failure indexes must be an array");
  const failures = new Set();
  for (const [index, value] of failIndexes.entries()) {
    integer(value, `test revoke failure index ${index}`, { min: 0 });
    failures.add(value);
  }
  TEST_REVOKE_FAILURES.set(prepared, failures);
}

async function prepareNativeReviewV2OwnerApproval({
  plan,
  executor,
  authorization,
  repository,
  stateDirectory,
  ownerApprovalExpiresAt,
  lane
}) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  object(lane, "V2 owner lane");
  knownOptions(lane, ["batchId", "roleId", "assignmentIds", "unitIds"], "V2 owner lane");
  safeId(lane.batchId, "V2 owner lane.batchId");
  safeId(lane.roleId, "V2 owner lane.roleId");
  assert(Array.isArray(lane.assignmentIds) && lane.assignmentIds.length > 0,
    "V2 owner lane.assignmentIds is invalid");
  assert(Array.isArray(lane.unitIds) && lane.unitIds.length === lane.assignmentIds.length,
    "V2 owner lane.unitIds is invalid");
  lane.assignmentIds.forEach((item, index) => safeId(item, `V2 owner lane.assignmentIds[${index}]`));
  lane.unitIds.forEach((item, index) => safeId(item, `V2 owner lane.unitIds[${index}]`));
  const source = await startTrustedSourceCapture(repository);
  assert(source, "V2 owner approval requires a Git source binding");
  assert.equal(source.headRevision, plan.source.head, "V2 owner approval source revision is stale");
  const trustPolicy = await readInstalledNativeV3TrustPolicy();
  const ownerRunId = nativeReviewV2OwnerRunId(authorization);
  const identity = nativeReviewV2OwnerLaneIdentity(authorization, lane);
  const ownerExecutionId = identity.executionId;
  const ownerAttemptId = identity.attemptId;
  const ownerExpiry = nativeReviewV2OwnerExpiry(ownerApprovalExpiresAt);
  const effect = createNativeReviewV2EffectBinding({
    plan,
    executor,
    authorization,
    stateDirectory,
    sourceBinding: { revision: source.headRevision, digest: source.digest },
    ownerRunId,
    ownerExecutionId,
    ownerAttemptId,
    ownerApprovalExpiresAt: ownerExpiry,
    ownerTaskId: identity.taskId,
    ownerUnitId: identity.unitId,
    lane
  });
  const bridgePlanId = `native-review-v2-owner-${effect.effectBindingDigest.slice(0, 32)}`;
  const sourceBinding = { revision: source.headRevision, digest: source.digest };
  // Start the exact source snapshot before constructing/persisting the bridge
  // plan. The controller's first fresh read has a four-second bounded callback
  // window, while the trusted Git capture itself is intentionally complete
  // and may approach that bound on macOS.
  const bootstrapCapture = await startTrustedSourceCapture(repository);
  const readFreshSourceBinding = createFreshSourceResolver(
    repository,
    sourceBinding,
    {
      runId: ownerRunId,
      planId: bridgePlanId,
      label: "Current V2 owner source binding",
      initialCaptures: [Promise.resolve(bootstrapCapture)]
    }
  );
  const ownerBudget = ownerBridgeBudget(authorization);
  const scope = ownerBridgeScope(plan, lane);
  const modelPolicy = {
    inherit: true,
    allow: [],
    deny: [],
    requested: null,
    reported: null,
    attested: null
  };
  const taskContract = createTaskContractV3({
    contractId: `native-review-v2-owner-contract-${effect.effectBindingDigest.slice(0, 16)}`,
    goal: "Authorize one exact local native V2 review host effect",
    scope,
    bindings: {
      source: { revision: source.headRevision, digest: source.digest },
      policy: { digest: trustPolicy.policyDigest },
      template: {
        id: "native-review-v2-owner-bridge",
        digest: digestObject({
          schemaVersion: 1,
          kind: "NativeReviewV2OwnerBridgeTemplateBindingV1",
          effectBindingDigest: effect.effectBindingDigest
        })
      },
      route: {
        receiptId: null,
        digest: digestObject({
          schemaVersion: 1,
          kind: "NativeReviewV2OwnerBridgeRouteBindingV1",
          effectBindingDigest: effect.effectBindingDigest
        })
      }
    },
    roles: [{ id: "review-owner", required: true }],
    modelPolicy,
    budget: ownerBudget,
    acceptance: [{
      id: "owner-approved",
      description: "The exact V2 local host effect has an explicit owner approval.",
      requiredEvidence: [],
      critical: true
    }],
    graph: {
      tasks: [{
        id: identity.taskId,
        goal: "Authorize one exact local native V2 review host effect",
        dependencies: [],
        role: "review-owner",
        writeOwner: { role: "review-owner", paths: [] },
        modelPolicy,
        budget: ownerBudget,
        acceptanceIds: ["owner-approved"]
      }]
    }
  });
  const persisted = await persistWorkflowPlanV1({
    root: stateDirectory,
    plan: buildWorkflowPlanV1({ taskContract, planId: bridgePlanId })
  });
  const ownerPlan = persisted.plan;
  assert.equal(ownerPlan.planId, bridgePlanId, "V2 owner bridge plan id changed during persistence");
  const candidate = await prepareCooperativeNativeV3Approval({
    stateRoot: stateDirectory,
    planId: ownerPlan.planId,
    runId: ownerRunId,
    taskId: identity.taskId,
    unitId: identity.unitId,
    executionId: ownerExecutionId,
    attemptId: ownerAttemptId,
    allocationKey: nativeV3AllocationKeyFor({ taskId: identity.taskId, attemptId: ownerAttemptId }),
    recipient: NATIVE_REVIEW_V2_OWNER_RECIPIENT,
    action: NATIVE_REVIEW_V2_OWNER_ACTION,
    sourceBinding,
    policyDigest: trustPolicy.policyDigest,
    trustMode: NATIVE_REVIEW_V2_OWNER_TRUST_MODE,
    readFreshSourceBinding,
    readTrustPolicy: createNativeV3TrustPolicyReader(),
    freshResolverTimeoutMs: NATIVE_REVIEW_V2_FRESH_RESOLVER_TIMEOUT_MS,
    effectBindingDigest: effect.effectBindingDigest,
    expiresAt: ownerExpiry
  });
  const ownerApproval = {
    kind: NATIVE_REVIEW_V2_OWNER_BRIDGE_KIND,
    ownerRunId,
    bridgePlanId: ownerPlan.planId,
    bridgePlanDigest: ownerPlan.planDigest,
    bridgeContractDigest: ownerPlan.contractDigest,
    taskId: identity.taskId,
    unitId: identity.unitId,
    executionId: ownerExecutionId,
    attemptId: ownerAttemptId,
    sourceBinding,
    policyDigest: trustPolicy.policyDigest,
    effectBindingDigest: effect.effectBindingDigest,
    ownerApprovalRequest: candidate.ownerApprovalRequest,
    approvalEnvelope: candidate.approvalEnvelope,
    allocation: candidate.allocation,
    lane
  };
  return ownerApprovalProjection(ownerApproval);
}

async function assertStateDirectoryParent(directory) {
  absolutePath(directory, "V2 stateDirectory");
  await assertPhysicalPath(path.dirname(directory), "V2 stateDirectory parent", { directory: true });
  try {
    await assertPhysicalPath(directory, "V2 stateDirectory", { directory: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return directory;
}

async function assertDirectStateChild(prepared, target, label) {
  absolutePath(target, label);
  const statePath = await realpath(prepared.stateDirectory);
  const parentPath = await realpath(path.dirname(target));
  assert.equal(parentPath, statePath, `${label} must be directly inside the bound state directory`);
  return target;
}

function accountingProjection() {
  return Object.freeze({
    kind: NATIVE_REVIEW_CLI_V2_ACCOUNTING_KIND,
    source: "runner checkpoint ledger",
    providerQuota: NATIVE_REVIEW_CLI_V2_PROVIDER_QUOTA_STATUS,
    providerQuotaAuthority: false
  });
}

function planProjection(plan) {
  const canonical = validateReviewShardPlanV2(plan);
  return Object.freeze({
    planId: canonical.planId,
    planDigest: canonical.planDigest,
    protocol: canonical.protocol,
    sourceDigest: canonical.source.sourceDigest,
    repository: canonical.source.repository,
    base: canonical.source.base,
    head: canonical.source.head,
    roles: canonical.roles,
    unitCount: canonical.units.length,
    assignmentCount: canonical.assignments.length,
    requiredAssignmentCount: canonical.assignments.filter(item => item.required).length,
    batchCount: canonical.batches.length,
    policy: canonical.policy,
    budget: canonical.budget
  });
}

/**
 * Build a V2 plan from the exact current Git source.  Roles, policy,
 * obligations, and a supplied manifest are review inputs; this function does
 * not turn any of them into an authority grant.
 */
export async function createNativeReviewV2Plan(options = {}) {
  knownOptions(options, [
    "repository", "base", "head", "roles", "contextPaths", "manifest", "obligations", "policy", "planId"
  ], "V2 plan");
  const plan = await createTrustedReviewShardPlanV2(options);
  return validateReviewShardPlanV2(plan);
}

/**
 * Prepare the only service object accepted by the V2 execution methods.
 * Production preparation is denied while trusted source delivery is missing.
 * Executor and budget capabilities are minted by the existing V2 producers;
 * a JSON copy, V1 object, or caller supplied digest is never accepted.
 */
export async function prepareNativeReviewV2(options = {}) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  knownOptions(options, [
    "repository", "base", "head", "roles", "contextPaths", "manifest", "obligations", "policy", "planId",
    "stateDirectory", "runId", "epoch", "command", "args", "cwd", "env", "timeoutMs", "maxBudget", "reservation",
    "ownerApprovalExpiresAt"
  ], "V2 preparation");
  const repository = absolutePath(required(options.repository, "V2 repository"), "V2 repository");
  const stateDirectory = absolutePath(required(options.stateDirectory, "V2 stateDirectory"), "V2 stateDirectory");
  const runId = safeId(required(options.runId, "V2 runId"), "V2 runId");
  const epoch = integer(required(options.epoch, "V2 epoch"), "V2 epoch", { min: 1 });
  const plan = await createNativeReviewV2Plan({
    repository,
    base: required(options.base, "V2 base"),
    head: required(options.head, "V2 head"),
    ...(options.roles === undefined ? {} : { roles: options.roles }),
    ...(options.contextPaths === undefined ? {} : { contextPaths: options.contextPaths }),
    ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
    ...(options.obligations === undefined ? {} : { obligations: options.obligations }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.planId === undefined ? {} : { planId: options.planId })
  });
  const cwd = absolutePath(options.cwd ?? repository, "V2 host cwd");
  assert.equal(cwd, plan.source.repository, "V2 host cwd must equal the frozen repository root");
  await assertStateDirectoryParent(stateDirectory);
  const command = absolutePath(required(options.command, "V2 host command"), "V2 host command");
  const args = normalizeArgs(options.args);
  const env = normalizeEnv(options.env);
  const maxBudget = normalizeBudgetOverride(options.maxBudget, "V2 maxBudget");
  const reservation = normalizeBudgetOverride(options.reservation, "V2 reservation", { reservation: true });
  const executor = await createNativeReviewHostExecutorV2({
    plan,
    command,
    args,
    cwd,
    env,
    timeoutMs: options.timeoutMs
  });
  const authOptions = { plan, executor, runId, epoch };
  if (maxBudget !== undefined) authOptions.maxBudget = maxBudget;
  if (reservation !== undefined) authOptions.reservation = reservation;
  const authorization = createTrustedReviewBudgetAuthorizationV2(authOptions);
  const lanes = ownerLaneDefinitions(plan);
  const ownerApprovals = [];
  // Cooperative controller preparation serializes on one run-level state
  // lock.  Keep the exact lane order while avoiding sibling lock timeouts;
  // dispatch itself remains independently concurrent in the runner.
  for (const lane of lanes) {
    ownerApprovals.push(await prepareNativeReviewV2OwnerApproval({
      plan,
      executor,
      authorization,
      repository,
      stateDirectory,
      ownerApprovalExpiresAt: options.ownerApprovalExpiresAt,
      lane
    }));
  }
  const ownerApproval = ownerApprovals[0];
  const body = {
    schemaVersion: NATIVE_REVIEW_CLI_V2_SCHEMA_VERSION,
    kind: NATIVE_REVIEW_CLI_V2_KIND,
    protocol: NATIVE_REVIEW_CLI_V2_PROTOCOL,
    plan,
    executor,
    authorization,
    stateDirectory,
    ownerApproval,
    ownerApprovals,
    lanes,
    accounting: accountingProjection(),
    host: Object.freeze({
      command: executor.command,
      args: executor.args,
      cwd: executor.cwd,
      capabilityDigest: executor.capabilityDigest,
      providerEvidence: "local-host-transport; live-provider-unverified"
    })
  };
  const prepared = deepFreeze({
    ...body,
    preparedDigest: digestObject(preparedDigestBody({ body, ownerApprovals }))
  });
  PREPARED.add(prepared);
  return prepared;
}

function assertPrepared(value) {
  assert(PREPARED.has(value), "V2 CLI preparation must come from the trusted in-process producer");
  knownOptions(value, [
    "schemaVersion", "kind", "protocol", "plan", "executor", "authorization", "stateDirectory", "ownerApproval", "ownerApprovals", "lanes", "accounting", "host", "preparedDigest"
  ], "V2 preparation");
  assert.equal(value.schemaVersion, NATIVE_REVIEW_CLI_V2_SCHEMA_VERSION);
  assert.equal(value.kind, NATIVE_REVIEW_CLI_V2_KIND);
  assert.equal(value.protocol, NATIVE_REVIEW_CLI_V2_PROTOCOL);
  const plan = validateReviewShardPlanV2(value.plan);
  assert(isTrustedReviewBudgetAuthorizationV2(value.authorization),
    "V2 CLI authorization must come from the trusted budget producer");
  assert.equal(value.authorization.planDigest, plan.planDigest);
  assert.equal(value.authorization.sourceDigest, plan.source.sourceDigest);
  assert.equal(value.authorization.executorDigest, value.executor.capabilityDigest);
  const lanes = ownerLaneDefinitions(plan);
  assert.deepEqual(value.lanes, lanes, "V2 owner lane manifest is stale");
  assert(Array.isArray(value.ownerApprovals) && value.ownerApprovals.length === lanes.length,
    "V2 owner approvals must cover the exact lane manifest");
  assert.deepEqual(value.ownerApproval, value.ownerApprovals[0], "V2 ownerApproval compatibility alias is stale");
  const approvalKeys = new Set();
  for (const [index, approvalValue] of value.ownerApprovals.entries()) {
    const owner = ownerApprovalProjection(approvalValue, `V2 owner approvals[${index}]`);
    const lane = lanes[index];
    assert.deepEqual(owner.lane, lane, `V2 owner approval ${index} is bound to a different lane`);
    assert.equal(owner.ownerRunId, nativeReviewV2OwnerRunId(value.authorization), "V2 owner run binding is stale");
    const identity = nativeReviewV2OwnerLaneIdentity(value.authorization, lane);
    assert.equal(owner.taskId, identity.taskId, "V2 owner task binding is stale");
    assert.equal(owner.unitId, identity.unitId, "V2 owner unit binding is stale");
    assert.equal(owner.executionId, identity.executionId, "V2 owner execution binding is stale");
    assert.equal(owner.attemptId, identity.attemptId, "V2 owner attempt binding is stale");
    // The review plan's manifest digest and the controller's full Git source
    // binding are distinct typed values. Bind both to the same exact revision;
    // never pretend the manifest digest is the controller freshness digest.
    assert.equal(owner.sourceBinding.revision, plan.source.head, "V2 owner source revision is stale");
    assert.equal(owner.effectBindingDigest, createNativeReviewV2EffectBinding({
      plan,
      executor: value.executor,
      authorization: value.authorization,
      stateDirectory: value.stateDirectory,
      sourceBinding: owner.sourceBinding,
      ownerRunId: owner.ownerRunId,
      ownerExecutionId: owner.executionId,
      ownerAttemptId: owner.attemptId,
      ownerApprovalExpiresAt: owner.ownerApprovalRequest.expiresAt,
      ownerTaskId: owner.taskId,
      ownerUnitId: owner.unitId,
      lane
    }).effectBindingDigest, "V2 owner effect binding is stale");
    const key = `${owner.lane.batchId}\u0000${owner.lane.roleId}`;
    assert(!approvalKeys.has(key), "V2 owner approvals contain a duplicate lane");
    approvalKeys.add(key);
  }
  assert.deepEqual([...approvalKeys].sort(), lanes.map(item => `${item.batchId}\u0000${item.roleId}`).sort(),
    "V2 owner approvals do not cover the lane manifest");
  absolutePath(value.stateDirectory, "V2 preparation stateDirectory");
  digest(value.preparedDigest, "V2 preparedDigest");
  assert.equal(value.preparedDigest, digestObject(preparedDigestBody({ body: value, ownerApprovals: value.ownerApprovals })),
    "V2 preparedDigest is stale");
  return value;
}

function assertRunnerReceipt(value, prepared, admission) {
  object(value, "V2 run receipt");
  const keys = [
    "schemaVersion", "kind", "protocol", "sealed", "runId", "planDigest", "sourceDigest", "epoch", "grantDigest",
    "admissionDigest", "status", "checkpointDigest", "checkpointSealDigest", "resultDigests", "laneReceiptDigests",
    "aggregateDigest", "coverage", "finalGate", "receiptDigest"
  ];
  assert.deepEqual(Object.keys(value).sort(), keys.sort(), "V2 run receipt fields are not canonical");
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, NATIVE_REVIEW_SHARD_RUNNER_V2_RECEIPT_KIND);
  assert.equal(value.protocol, NATIVE_REVIEW_SHARD_RUNNER_V2_PROTOCOL);
  assert.equal(value.sealed, true);
  assert.equal(value.runId, prepared.authorization.runId);
  assert.equal(value.planDigest, prepared.plan.planDigest);
  assert.equal(value.sourceDigest, prepared.plan.source.sourceDigest);
  assert.equal(value.epoch, prepared.authorization.epoch);
  assert.equal(value.grantDigest, prepared.authorization.grantDigest);
  assert.equal(value.admissionDigest, admission.admissionDigest);
  assert(RECEIPT_STATUSES.has(value.status));
  digest(value.checkpointDigest, "V2 receipt.checkpointDigest");
  digest(value.checkpointSealDigest, "V2 receipt.checkpointSealDigest");
  assert(Array.isArray(value.resultDigests));
  value.resultDigests.forEach(item => digest(item, "V2 receipt.resultDigest"));
  assert.equal(new Set(value.resultDigests).size, value.resultDigests.length);
  assert(Array.isArray(value.laneReceiptDigests));
  value.laneReceiptDigests.forEach(item => digest(item, "V2 receipt.laneReceiptDigest"));
  assert.equal(new Set(value.laneReceiptDigests).size, value.laneReceiptDigests.length);
  assert(value.aggregateDigest === null || DIGEST.test(value.aggregateDigest));
  knownOptions(value.coverage, ["expectedAssignments", "observedAssignments", "complete"], "V2 receipt coverage");
  integer(value.coverage.expectedAssignments);
  integer(value.coverage.observedAssignments);
  assert.equal(value.coverage.expectedAssignments, prepared.plan.assignments.filter(item => item.required).length);
  assert.equal(value.coverage.observedAssignments, value.resultDigests.length);
  assert.equal(value.coverage.complete, value.coverage.observedAssignments === value.coverage.expectedAssignments);
  knownOptions(value.finalGate, ["status", "authoritative"], "V2 receipt finalGate");
  assert.equal(value.finalGate.status, "REQUIRED");
  assert.equal(value.finalGate.authoritative, false);
  const body = { ...value };
  delete body.receiptDigest;
  assert.equal(value.receiptDigest, digestObject(body), "V2 receipt digest is stale");
  return deepFreeze(value);
}

async function readPersistedAggregate(prepared, aggregateDigest) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  digest(aggregateDigest, "V2 aggregateDigest");
  const directory = prepared.stateDirectory;
  await assertPhysicalPath(directory, "V2 aggregate stateDirectory", { directory: true });
  const aggregateDirectory = path.join(directory, "aggregates");
  await assertPhysicalPath(aggregateDirectory, "V2 aggregate directory", { directory: true });
  const target = path.join(aggregateDirectory, `${aggregateDigest}.json`);
  const file = await boundedFile(target, "V2 persisted aggregate", MAX_INPUT_JSON_BYTES);
  let value;
  try {
    value = JSON.parse(file.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`V2 persisted aggregate is not valid JSON: ${error.message}`);
  }
  const aggregate = validateSealedReviewAggregate(value, prepared.plan);
  assert.equal(aggregate.aggregateDigest, aggregateDigest);
  return aggregate;
}

function aggregateProjection(aggregate) {
  if (!aggregate) return null;
  return Object.freeze({
    aggregateDigest: aggregate.aggregateDigest,
    verdict: aggregate.verdict,
    authoritative: aggregate.authoritative,
    admission: aggregate.admission,
    coverage: aggregate.coverage,
    findingCount: aggregate.findings.length
  });
}

async function outcomeSummary(prepared, operation, raw, paths = {}) {
  const receipt = raw.receipt;
  assert(receipt, "V2 runner returned no receipt");
  const admission = raw.admission ?? await createTrustedReviewAdmissionV2({
    plan: prepared.plan,
    authorization: prepared.authorization
  });
  assertRunnerReceipt(receipt, prepared, admission);
  const aggregate = raw.aggregate ?? (receipt.aggregateDigest
    ? await readPersistedAggregate(prepared, receipt.aggregateDigest)
    : null);
  if (receipt.status === "COMPLETE") assert(aggregate, "V2 complete receipt is missing its aggregate");
  const checkpointPath = paths.checkpointPath ?? raw.checkpointPath ?? null;
  const receiptPath = paths.receiptPath ?? raw.receiptPath ?? null;
  const summary = {
    schemaVersion: NATIVE_REVIEW_CLI_V2_SCHEMA_VERSION,
    kind: NATIVE_REVIEW_CLI_V2_KIND,
    protocol: NATIVE_REVIEW_CLI_V2_PROTOCOL,
    operation,
    status: operation === "replay" ? "REPLAYED" : receipt.status,
    reviewStatus: receipt.status,
    plan: planProjection(prepared.plan),
    run: {
      runId: receipt.runId,
      epoch: receipt.epoch,
      sourceDigest: receipt.sourceDigest,
      checkpointPath,
      checkpointDigest: receipt.checkpointDigest,
      checkpointSealDigest: receipt.checkpointSealDigest,
      receiptPath,
      receiptDigest: receipt.receiptDigest
    },
    coverage: receipt.coverage,
    resultCount: receipt.resultDigests.length,
    aggregate: aggregateProjection(aggregate),
    finalGate: receipt.finalGate,
    accounting: prepared.accounting,
    providerEvidence: prepared.host.providerEvidence
  };
  return { summary: deepFreeze(summary), aggregate };
}

async function makeOutcome(prepared, operation, raw, paths = {}) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  const { summary } = await outcomeSummary(prepared, operation, raw, paths);
  const outcome = deepFreeze({
    schemaVersion: NATIVE_REVIEW_CLI_V2_SCHEMA_VERSION,
    kind: NATIVE_REVIEW_CLI_V2_KIND,
    protocol: NATIVE_REVIEW_CLI_V2_PROTOCOL,
    operation,
    preparedDigest: prepared.preparedDigest,
    result: raw,
    summary
  });
  OUTCOMES.add(outcome);
  return outcome;
}

async function runPrepared(prepared, operation, {
  resumeFrom = undefined,
  signal = undefined,
  initializationTimeoutMs = undefined,
  ownerDecision = undefined
  } = {}) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  assertPrepared(prepared);
  await assertStateDirectoryParent(prepared.stateDirectory);
  const approvals = prepared.ownerApprovals.map(item => ownerApprovalProjection(item));
  const decisions = ownerDecision === undefined
    ? null
    : approvals.length === 1 && !Array.isArray(ownerDecision)
      ? [ownerDecision]
      : (() => {
          assert(Array.isArray(ownerDecision),
            "multi-lane V2 execution requires one genuine owner decision per lane");
          assert.equal(ownerDecision.length, approvals.length,
            "V2 owner decisions must cover the exact prepared lane manifest");
          return [...ownerDecision];
        })();
  // The V2 runner's budget authorization is deliberately not an owner grant.
  // Reconstruct every cooperative owner allocation immediately before handing
  // control to the runner.  Each allocation has its own task/attempt/fence;
  // a broad parent approval cannot be reused for another lane.
  const ownerAdmissions = [];
  const ownerLaunches = [];
  const ownerRevocations = [];
  const revokedAdmissions = new Set();
  let raw;
  try {
    for (const [index, ownerApproval] of approvals.entries()) {
      const ownerAdmission = await admitNativeReviewV2Owner(prepared, ownerApproval, decisions?.[index]);
      ownerAdmissions.push(ownerAdmission);
      const effectBinding = createNativeReviewV2EffectBinding({
        plan: prepared.plan,
        executor: prepared.executor,
        authorization: prepared.authorization,
        stateDirectory: prepared.stateDirectory,
        sourceBinding: ownerApproval.sourceBinding,
        ownerRunId: ownerApproval.ownerRunId,
        ownerExecutionId: ownerApproval.executionId,
        ownerAttemptId: ownerApproval.attemptId,
        ownerApprovalExpiresAt: ownerApproval.ownerApprovalRequest.expiresAt,
        ownerTaskId: ownerApproval.taskId,
        ownerUnitId: ownerApproval.unitId,
        lane: ownerApproval.lane
    });
      assert.equal(effectBinding.effectBindingDigest, ownerApproval.effectBindingDigest,
        "V2 owner effect binding changed before launch");
      ownerLaunches.push(await createTrustedReviewOwnerLaunchCapabilityV2({
        controller: ownerAdmission.created.controller,
        binding: ownerAdmission.binding,
        authorityEpoch: ownerAdmission.current.authority.authorityEpoch,
        fence: ownerAdmission.current.authority.fence,
        effectBindingDigest: ownerAdmission.owner.effectBindingDigest,
        effectBinding
      }));
    }
    const options = {
      plan: prepared.plan,
      authorization: prepared.authorization,
      executor: prepared.executor,
      stateDirectory: prepared.stateDirectory,
      ownerLaunches
    };
    if (resumeFrom !== undefined) options.resumeFrom = absolutePath(resumeFrom, "V2 resume checkpointPath");
    if (signal !== undefined) options.signal = signal;
    if (initializationTimeoutMs !== undefined) options.initializationTimeoutMs = integer(initializationTimeoutMs, "V2 initializationTimeoutMs", { min: 1 });
    raw = await executeNativeReviewShardV2(options);
    for (const [index, ownerAdmission] of ownerAdmissions.entries()) {
      ownerRevocations.push(await revokeNativeReviewV2Owner(ownerAdmission, testRevokeFailureFor(prepared, index)));
      revokedAdmissions.add(ownerAdmission);
    }
  } catch (error) {
    // Keep every owner dispatch authority closed even when admission, the
    // runner, or another lane fails.  Attempt every remaining admission before
    // surfacing a revoke failure; one unresolved allocation must not prevent
    // later allocations from being closed.
    const revokeFailures = [];
    let firstRevokeError = null;
    for (const [index, ownerAdmission] of ownerAdmissions.entries()) {
      if (revokedAdmissions.has(ownerAdmission)) continue;
      try {
        ownerRevocations.push(await revokeNativeReviewV2Owner(ownerAdmission, testRevokeFailureFor(prepared, index)));
        revokedAdmissions.add(ownerAdmission);
      } catch (revokeError) {
        revokeError.cause = error;
        firstRevokeError ??= revokeError;
        revokeFailures.push({
          index,
          ownerRunId: ownerAdmission.runId,
          taskId: ownerAdmission.owner.taskId,
          attemptId: ownerAdmission.owner.attemptId,
          allocationKey: nativeV3AllocationKeyFor({
            taskId: ownerAdmission.owner.taskId,
            attemptId: ownerAdmission.owner.attemptId
          }),
          code: revokeError?.code ?? "UNKNOWN",
          message: String(revokeError?.message ?? revokeError).slice(0, 1024)
        });
      }
    }
    if (firstRevokeError) {
      firstRevokeError.revokeFailures = revokeFailures;
      throw firstRevokeError;
    }
    throw error;
  }
  const ownerResult = {
    ownerAdmissions: ownerAdmissions.map(item => item.receipt),
    ownerRevocations,
    ...(ownerAdmissions.length === 1 ? {
      ownerAdmission: ownerAdmissions[0].receipt,
      ownerRevocation: ownerRevocations[0]
    } : {})
  };
  return makeOutcome(prepared, operation, {
    ...raw,
    ...ownerResult
  });
}

export async function runNativeReviewV2(options = {}) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  knownOptions(options, ["prepared", "signal", "initializationTimeoutMs", "ownerDecision"], "V2 run");
  return runPrepared(required(options.prepared, "V2 prepared"), "run", options);
}

export async function resumeNativeReviewV2(options = {}) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  knownOptions(options, ["prepared", "checkpointPath", "signal", "initializationTimeoutMs", "ownerDecision"], "V2 resume");
  const prepared = required(options.prepared, "V2 prepared");
  const checkpointPath = absolutePath(required(options.checkpointPath, "V2 resume checkpointPath"), "V2 resume checkpointPath");
  await assertDirectStateChild(prepared, checkpointPath, "V2 resume checkpointPath");
  return runPrepared(prepared, "resume", { ...options, resumeFrom: checkpointPath });
}

/** Collect one explicit owner decision for every exact prepared V2 lane. */
export async function collectNativeReviewV2OwnerDecision(options = {}) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  knownOptions(options, ["prepared", "signal"], "V2 owner approval");
  const prepared = assertPrepared(required(options.prepared, "V2 prepared"));
  const decisions = [];
  for (const ownerValue of prepared.ownerApprovals) {
    const owner = ownerApprovalProjection(ownerValue);
    decisions.push(await collectCooperativeNativeV3OwnerDecision({
      stateRoot: prepared.stateDirectory,
      runId: owner.ownerRunId,
      taskId: owner.taskId,
      attemptId: owner.attemptId,
      allocationKey: nativeV3AllocationKeyFor({ taskId: owner.taskId, attemptId: owner.attemptId }),
      requestDigest: owner.ownerApprovalRequest.requestDigest,
      ...(options.signal === undefined ? {} : { abortSignal: options.signal })
    }));
  }
  return decisions.length === 1 ? decisions[0] : Object.freeze(decisions);
}

export async function replayNativeReviewV2(options = {}) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  knownOptions(options, ["prepared", "checkpointPath", "receiptPath"], "V2 replay");
  const prepared = assertPrepared(required(options.prepared, "V2 prepared"));
  const checkpointPath = absolutePath(required(options.checkpointPath, "V2 replay checkpointPath"), "V2 replay checkpointPath");
  await assertDirectStateChild(prepared, checkpointPath, "V2 replay checkpointPath");
  const receiptPath = options.receiptPath === undefined
    ? undefined
    : absolutePath(options.receiptPath, "V2 replay receiptPath");
  if (receiptPath !== undefined) {
    await assertDirectStateChild(prepared, receiptPath, "V2 replay receiptPath");
  }
  const raw = await replayNativeReviewShardV2({
    plan: prepared.plan,
    authorization: prepared.authorization,
    stateDirectory: prepared.stateDirectory,
    checkpointPath,
    receiptPath
  });
  return makeOutcome(prepared, "replay", raw, {
    checkpointPath,
    receiptPath: receiptPath ?? path.join(prepared.stateDirectory,
      `receipt-${String(prepared.authorization.epoch).padStart(6, "0")}.json`)
  });
}

async function checkpointForReceipt(prepared, checkpointDigest) {
  await assertPhysicalPath(prepared.stateDirectory, "V2 progress stateDirectory", { directory: true });
  const entries = await readdir(prepared.stateDirectory, { withFileTypes: true });
  const candidates = entries.filter(entry => entry.isFile() && /^checkpoint-[0-9]{6}-[0-9]{6}\.json$/.test(entry.name));
  assert(candidates.length <= 512, "V2 checkpoint history exceeds its inspection bound");
  for (const entry of candidates.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(prepared.stateDirectory, entry.name);
    const file = await boundedFile(target, "V2 progress checkpoint", MAX_INPUT_JSON_BYTES);
    let value;
    try { value = JSON.parse(file.bytes.toString("utf8")); } catch { continue; }
    if (value?.checkpointDigest === checkpointDigest) return target;
  }
  throw new Error("V2 receipt checkpoint is absent from the durable state directory");
}

/** Production progress/aggregate qualification is denied while trusted delivery is missing. */
export async function getNativeReviewV2Progress(options = {}) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  knownOptions(options, ["prepared"], "V2 progress");
  const prepared = assertPrepared(required(options.prepared, "V2 prepared"));
  const admission = await createTrustedReviewAdmissionV2({ plan: prepared.plan, authorization: prepared.authorization });
  try {
    await assertPhysicalPath(prepared.stateDirectory, "V2 progress stateDirectory", { directory: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        schemaVersion: NATIVE_REVIEW_CLI_V2_SCHEMA_VERSION,
        kind: NATIVE_REVIEW_CLI_V2_KIND,
        protocol: NATIVE_REVIEW_CLI_V2_PROTOCOL,
        status: "NOT_STARTED",
        observed: false,
        plan: planProjection(prepared.plan),
        accounting: prepared.accounting,
        providerEvidence: prepared.host.providerEvidence
      });
    }
    throw error;
  }
  const receiptPath = path.join(prepared.stateDirectory,
    `receipt-${String(prepared.authorization.epoch).padStart(6, "0")}.json`);
  let file;
  try {
    file = await boundedFile(receiptPath, "V2 progress receipt", MAX_INPUT_JSON_BYTES);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        schemaVersion: NATIVE_REVIEW_CLI_V2_SCHEMA_VERSION,
        kind: NATIVE_REVIEW_CLI_V2_KIND,
        protocol: NATIVE_REVIEW_CLI_V2_PROTOCOL,
        status: "NOT_STARTED",
        observed: false,
        plan: planProjection(prepared.plan),
        accounting: prepared.accounting,
        providerEvidence: prepared.host.providerEvidence
      });
    }
    throw error;
  }
  let receipt;
  try { receipt = JSON.parse(file.bytes.toString("utf8")); } catch (error) {
    throw new Error(`V2 progress receipt is not valid JSON: ${error.message}`);
  }
  assertRunnerReceipt(receipt, prepared, admission);
  let aggregate = null;
  const checkpointPath = await checkpointForReceipt(prepared, receipt.checkpointDigest);
  const checkpoint = await readReviewCheckpoint({ checkpointPath, plan: prepared.plan });
  assert.equal(checkpoint.runId, prepared.authorization.runId);
  assert.equal(checkpoint.epoch, prepared.authorization.epoch);
  assert.equal(checkpoint.grantDigest, prepared.authorization.grantDigest);
  assert.equal(checkpoint.sourceDigest, prepared.plan.source.sourceDigest);
  if (receipt.aggregateDigest !== null) {
    const replay = await replayNativeReviewShardV2({
      plan: prepared.plan,
      authorization: prepared.authorization,
      stateDirectory: prepared.stateDirectory,
      checkpointPath,
      receiptPath
    });
    aggregate = replay.aggregate;
  }
  return Object.freeze({
    schemaVersion: NATIVE_REVIEW_CLI_V2_SCHEMA_VERSION,
    kind: NATIVE_REVIEW_CLI_V2_KIND,
    protocol: NATIVE_REVIEW_CLI_V2_PROTOCOL,
    status: receipt.status,
    observed: true,
    plan: planProjection(prepared.plan),
    run: {
      runId: receipt.runId,
      epoch: receipt.epoch,
      sourceDigest: receipt.sourceDigest,
      checkpointPath,
      checkpointDigest: receipt.checkpointDigest,
      checkpointSealDigest: receipt.checkpointSealDigest,
      receiptPath,
      receiptDigest: receipt.receiptDigest
    },
    coverage: receipt.coverage,
    resultCount: receipt.resultDigests.length,
    aggregate: aggregateProjection(aggregate),
    checkpointVerification: aggregate === null ? "bounded-shape-observation" : "authenticated-replay",
    finalGate: receipt.finalGate,
    accounting: prepared.accounting,
    providerEvidence: prepared.host.providerEvidence
  });
}

export async function getNativeReviewV2Aggregate(options = {}) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  knownOptions(options, ["prepared"], "V2 aggregate");
  const prepared = assertPrepared(required(options.prepared, "V2 prepared"));
  const progress = await getNativeReviewV2Progress({ prepared });
  if (!progress.observed || progress.aggregate === null) return null;
  return readPersistedAggregate(prepared, progress.aggregate.aggregateDigest);
}

export function summarizeNativeReviewV2(outcome) {
  assertNativeReviewV2ProductionDeliveryAvailable();
  assert(OUTCOMES.has(outcome), "V2 summary requires an outcome from the trusted CLI service");
  return outcome.summary;
}

export function isPreparedNativeReviewV2(value) {
  return PREPARED.has(value);
}

export async function readNativeReviewV2JsonFile(filePath, label = "V2 CLI JSON input") {
  const target = absolutePath(filePath, label);
  const file = await boundedFile(target, label, MAX_INPUT_JSON_BYTES);
  try { return JSON.parse(file.bytes.toString("utf8")); } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

export { DEFAULT_REVIEW_SHARDED_V2_POLICY };
