import { constants as fsConstants } from "node:fs";
import { performance } from "node:perf_hooks";
import { chmod, link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  assertNoSymlinkUnder,
  canonicalJson,
  digestObject,
  ensurePrivateDir,
  readJson,
  safeJoin
} from "./core.mjs";
import { captureSourceBinding } from "./git.mjs";
import { readInstalledNativeV3TrustPolicy } from "./native-v3-trust-policy.mjs";
import {
  validateWorkflowPlanV1
} from "./workflow-plan-v1.mjs";
import {
  admitCurrentVerification,
  captureDependencyManifest,
  createCarryForwardFromPersistentStore,
  createRevisionFreezeBinding,
  createVerificationUnit,
  PURE_LOCAL_TOOL_BINARY,
  PURE_LOCAL_VALIDATOR,
  runPureLocalValidator,
  sealVerificationResult
} from "./verification-incremental-v1.mjs";
import { createVerificationResultStore } from "./verification-result-store-v1.mjs";
import {
  runVerificationShadowRunV1,
  verifyVerificationShadowRunReceipt
} from "./verification-shadow-run-v1.mjs";

export const NATIVE_V3_VERIFICATION_CONSUMER_SCHEMA_VERSION = 1;
export const NATIVE_V3_VERIFICATION_CONSUMER_KIND = "NativeV3VerificationConsumerV1";
export const NATIVE_V3_VERIFICATION_TASK_HANDLE_KIND = "NativeV3VerificationTaskHandleV1";
export const NATIVE_V3_VERIFICATION_RECEIPT_KIND = "NativeV3VerificationReceiptV1";
export const NATIVE_V3_VERIFICATION_BOOTSTRAP_KIND = "NativeV3VerificationBootstrapReceiptV1";
export const NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION = 1;
export const NATIVE_V3_VERIFICATION_INSPECTION_KIND = "NativeV3VerificationInspectionV1";
export const NATIVE_V3_VERIFICATION_STORE_DIRECTORY = "verification-results-v1/shadow";
export const NATIVE_V3_VERIFICATION_RECEIPT_DIRECTORY = "verification-receipts-v1";
export const NATIVE_V3_VERIFICATION_MAX_RECEIPT_BYTES = 512 * 1024;

const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODES = new Set(["off", "shadow"]);
const RECEIPT_STATUSES = new Set(["pass", "fail", "hold", "unknown", "bootstrap"]);
const CONSUMERS = new WeakSet();
const CONSUMER_CONTEXTS = new WeakMap();
const CONSUMER_APIS = new WeakMap();
const TASK_HANDLES = new WeakSet();
const TASK_CONTEXTS = new WeakMap();
const RECEIPTS = new WeakSet();
const RECEIPT_CONSUMERS = new WeakMap();
const INSPECTIONS = new WeakSet();
const ALLOWED_CONSUMER_KEYS = new Set(["plan", "repositoryRoot", "stateRoot"]);
const ALLOWED_OBSERVATION_KEYS = new Set(["runId", "epoch", "unrelatedHeadDigest"]);
const RESULT_PROJECTION_KEYS = new Set([
  "schemaVersion", "kind", "resultId", "resultDigest", "unitDigest", "cacheKey", "mode", "status",
  "outcome", "reason", "observedContentDigest", "observedManifestDigest", "snapshot", "findings", "unknowns",
  "producer", "verifier", "sealed", "authoritative", "effectAuthorized"
]);
const SHADOW_RESULT_PROJECTION_KEYS = new Set([
  "resultDigest", "unitDigest", "cacheKey", "mode", "status", "outcome", "reason",
  "observedContentDigest", "observedManifestDigest", "unknowns", "findings"
]);
const ADMISSION_PROJECTION_KEYS = new Set([
  "schemaVersion", "kind", "admissionDigest", "unitDigest", "cacheKey", "currentContentDigest",
  "currentManifestDigest", "snapshot", "status", "disposition", "cacheEligible", "runId", "epoch",
  "unrelatedHeadDigest", "sourceBindingDigest", "relevantRevisionDigest", "effectAuthorized"
]);
const SHADOW_ADMISSION_PROJECTION_KEYS = new Set([
  "admissionDigest", "unitDigest", "cacheKey", "currentContentDigest", "currentManifestDigest",
  "status", "disposition", "reason", "cacheEligible", "sourceBindingDigest", "relevantRevisionDigest"
]);
const CARRY_PROJECTION_KEYS = new Set([
  "schemaVersion", "kind", "carryId", "carryDigest", "unitDigest", "resultDigest", "admissionDigest",
  "cacheKey", "currentContentDigest", "currentRevisionDigest", "freshness", "provenance", "accepted",
  "effectAuthorized"
]);
const SHADOW_CARRY_PROJECTION_KEYS = new Set([
  "carryDigest", "carryId", "unitDigest", "resultDigest", "admissionDigest", "currentContentDigest",
  "currentRevisionDigest", "freshnessContentDigest", "freshnessManifestDigest", "freshness", "accepted",
  "effectAuthorized"
]);
const FREEZE_PROJECTION_KEYS = new Set([
  "schemaVersion", "kind", "unitDigest", "revisionReadyDigest", "finalFreezeDigest", "revisionReady",
  "finalFreeze", "edges", "cycle", "effectAuthorized", "bindingDigest"
]);
const SHADOW_RECEIPT_KEYS = new Set([
  "schemaVersion", "kind", "decision", "mode", "status", "reason", "runId", "epoch", "unrelatedHeadDigest",
  "unitDigest", "cacheKey", "baselineContentDigest", "baselineManifestDigest", "currentContentDigest",
  "currentManifestDigest", "relevantRevisionDigest", "full", "shadow", "currentAdmission", "shadowLoad",
  "shadowLoadError", "carryForward", "carryForwardError", "phaseObservations", "observationIssues",
  "comparison", "dependencyDelta", "requiredCases", "inputBinding", "timings", "unknowns",
  "automaticQualification", "accepted", "effectAuthorized", "receiptDigest"
]);
const HISTORICAL_SNAPSHOT_KEYS = new Set(["kind", "status", "current", "contentDigest", "manifestDigest", "capturedAtMs"]);
const ADMISSION_SNAPSHOT_KEYS = new Set(["kind", "status", "current", "contentDigest", "manifestDigest"]);
const PROVENANCE_KEYS = new Set(["producer", "verifier", "sourceBindingDigest"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function elapsed(startedAt) {
  return Number(Math.max(0, performance.now() - startedAt).toFixed(3));
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new NativeV3VerificationConsumerInputError(`${label} must be a plain object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new NativeV3VerificationConsumerInputError(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new NativeV3VerificationConsumerInputError(`${label} is invalid`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new NativeV3VerificationConsumerInputError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function canonicalAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    throw new NativeV3VerificationConsumerInputError(`${label} must be a canonical absolute path`);
  }
  return value;
}

function validateObservation(value = {}, label = "observation") {
  exactKeys(value, ALLOWED_OBSERVATION_KEYS, label);
  const runId = value.runId === undefined || value.runId === null ? null : safeId(value.runId, `${label}.runId`);
  const epoch = value.epoch === undefined || value.epoch === null ? null : value.epoch;
  if (epoch !== null && (!Number.isSafeInteger(epoch) || epoch < 0)) {
    throw new NativeV3VerificationConsumerInputError(`${label}.epoch must be a non-negative safe integer`);
  }
  const unrelatedHeadDigest = value.unrelatedHeadDigest === undefined || value.unrelatedHeadDigest === null
    ? null
    : digest(value.unrelatedHeadDigest, `${label}.unrelatedHeadDigest`);
  if (runId === null || epoch === null) {
    throw new NativeV3VerificationConsumerInputError(`${label} requires runId and epoch for a fresh per-attempt observation`);
  }
  return { runId, epoch, unrelatedHeadDigest };
}

function hold(code, message, cause = null) {
  const error = new NativeV3VerificationConsumerHoldError(code, message);
  if (cause !== null) error.cause = cause;
  return error;
}

function relativeArtifactPath(stateRoot, target) {
  return path.relative(stateRoot, target).replaceAll(path.sep, "/");
}

function relevantSourceDescriptor({ verification, policyDigest }) {
  // The Git source binding is checked separately at consumer creation and on
  // every attempt. It belongs to current admission and revision/freeze
  // lineage, not to the reusable compute key. Keep only the source context
  // that is relevant to this declared verification unit here.
  return {
    kind: "NativeV3RelevantVerificationSourceV1",
    verificationDigest: digestObject(verification),
    policyDigest
  };
}

function relevantRevisionDigest({ verification, policyDigest }) {
  // This identity is deliberately limited to the declared dependency and
  // verifier inputs. runId, epoch, unrelated HEAD, and the whole Git source
  // snapshot are current-admission/lineage inputs rather than compute-key
  // inputs.
  return digestObject({
    kind: "NativeV3RelevantVerificationRevisionV1",
    policyDigest,
    verification
  });
}

function verificationUnitId(planId, taskId) {
  return `verification-${digestObject({ planId, taskId }).slice(0, 24)}`;
}

function sourceInsideRepository(repositoryRoot, target) {
  const relative = path.relative(repositoryRoot, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function pathInDeclaredScope(target, scope) {
  const relative = target.replaceAll("\\", "/");
  return scope.include.some((entry) => entry === "." || relative === entry || relative.startsWith(entry + "/")) &&
    !scope.exclude.some((entry) => relative === entry || relative.startsWith(entry + "/"));
}

function assertManifestWithinScope(manifest, scope) {
  const observed = new Set([
    ...(manifest.entries ?? []).map((entry) => entry.path),
    ...(manifest.globListings ?? []).flatMap((listing) => listing.matches ?? [])
  ]);
  for (const relative of observed) {
    if (typeof relative !== "string" || !pathInDeclaredScope(relative, scope)) {
      throw hold("ENATIVE_V3_VERIFICATION_SCOPE_DRIFT", "Dependency capture observed a path outside the task scope");
    }
  }
  return manifest;
}

function sourceLineageStoreDirectory(stateRoot, source) {
  // The complete Git binding fences persistent reuse, but is deliberately
  // kept in the store namespace rather than the compute cache identity. A
  // plan for a new source revision therefore starts with a fresh candidate;
  // no trusted cross-revision lineage is assumed by this bridge.
  const lineageDigest = digestObject({
    kind: "NativeV3SourceLineageV1",
    revision: source.revision,
    digest: source.digest
  });
  return safeJoin(stateRoot, NATIVE_V3_VERIFICATION_STORE_DIRECTORY, lineageDigest);
}

async function resolveStateRootWithMissingLeaf(requested) {
  let probe = requested;
  const missingComponents = [];
  while (true) {
    try {
      const existing = await realpath(probe);
      return path.join(existing, ...missingComponents.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      missingComponents.push(path.basename(probe));
      probe = parent;
    }
  }
}

async function trustedSourceBinding(repositoryRoot, expected) {
  let captured;
  try {
    captured = await captureSourceBinding(repositoryRoot, { requireClean: true });
  } catch (error) {
    if (error?.status === "UNKNOWN") throw error;
    throw hold("ENATIVE_V3_VERIFICATION_SOURCE_UNAVAILABLE", "Current source binding is unavailable", error);
  }
  if (!captured || captured.repositoryRoot !== repositoryRoot ||
      captured.headRevision !== expected.revision || captured.digest !== expected.digest) {
    throw hold("ENATIVE_V3_VERIFICATION_SOURCE_DRIFT", "Current source binding does not match the immutable workflow plan");
  }
  return Object.freeze({
    revision: captured.headRevision,
    digest: captured.digest,
    repositoryRoot: captured.repositoryRoot
  });
}

async function trustedPolicy(expectedDigest) {
  let current;
  try {
    current = await readInstalledNativeV3TrustPolicy();
  } catch (error) {
    if (error?.status === "UNKNOWN") throw error;
    throw hold("ENATIVE_V3_VERIFICATION_POLICY_UNAVAILABLE", "Installed native V3 trust policy is unavailable", error);
  }
  if (!isPlainObject(current?.value) || current.digest !== expectedDigest || current.policyDigest !== expectedDigest ||
      digestObject(current.value) !== expectedDigest) {
    throw hold("ENATIVE_V3_VERIFICATION_POLICY_DRIFT", "Installed native V3 trust policy does not match the workflow plan");
  }
  return Object.freeze({
    value: deepFreeze(structuredClone(current.value)),
    digest: expectedDigest,
    sourceDigest: current.sourceDigest
  });
}

async function assertCurrentTrustedBindings(context) {
  const source = await trustedSourceBinding(context.repositoryRoot, context.plan.taskContract.bindings.source);
  const policy = await trustedPolicy(context.plan.taskContract.bindings.policy.digest);
  if (policy.digest !== context.policy.digest || source.digest !== context.source.digest) {
    throw hold("ENATIVE_V3_VERIFICATION_INPUT_BINDING_DRIFT", "Trusted source or policy changed since consumer creation");
  }
  return { source, policy };
}

function assertConsumer(value) {
  if (!CONSUMERS.has(value) || !CONSUMER_CONTEXTS.has(value)) {
    throw new NativeV3VerificationConsumerInputError("verification consumer must come from the trusted producer");
  }
  return CONSUMER_CONTEXTS.get(value);
}

function assertTaskHandle(value) {
  if (!TASK_HANDLES.has(value) || !TASK_CONTEXTS.has(value)) {
    throw new NativeV3VerificationConsumerInputError("verification task handle must come from the trusted consumer");
  }
  return TASK_CONTEXTS.get(value);
}

function errorProjection(error) {
  return {
    code: typeof error?.code === "string" ? error.code.slice(0, 96) : "ENATIVE_V3_VERIFICATION_ERROR",
    message: String(error?.message ?? error).slice(0, 512),
    status: error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
  };
}

function resultProjection(result) {
  if (!result) return null;
  return deepFreeze({
    schemaVersion: result.schemaVersion,
    kind: result.kind,
    resultId: result.resultId,
    resultDigest: result.resultDigest,
    unitDigest: result.unitDigest,
    cacheKey: result.cacheKey,
    mode: result.mode,
    status: result.status,
    outcome: result.outcome,
    reason: result.reason,
    observedContentDigest: result.observedContentDigest,
    observedManifestDigest: result.observedManifestDigest,
    snapshot: result.snapshot,
    findings: result.findings,
    unknowns: result.unknowns,
    producer: result.producer,
    verifier: result.verifier,
    sealed: result.sealed,
    authoritative: result.authoritative,
    effectAuthorized: result.effectAuthorized
  });
}

function admissionProjection(admission) {
  if (!admission) return null;
  return deepFreeze({
    schemaVersion: admission.schemaVersion,
    kind: admission.kind,
    admissionDigest: admission.admissionDigest,
    unitDigest: admission.unitDigest,
    cacheKey: admission.cacheKey,
    currentContentDigest: admission.currentContentDigest,
    currentManifestDigest: admission.currentManifestDigest,
    snapshot: admission.snapshot,
    status: admission.status,
    disposition: admission.disposition,
    cacheEligible: admission.cacheEligible,
    runId: admission.runId,
    epoch: admission.epoch,
    unrelatedHeadDigest: admission.unrelatedHeadDigest,
    sourceBindingDigest: admission.sourceBindingDigest,
    relevantRevisionDigest: admission.relevantRevisionDigest,
    effectAuthorized: admission.effectAuthorized
  });
}

function freezeProjection(binding) {
  return binding === null ? null : deepFreeze({
    schemaVersion: binding.schemaVersion,
    kind: binding.kind,
    unitDigest: binding.unitDigest,
    revisionReadyDigest: binding.revisionReadyDigest,
    finalFreezeDigest: binding.finalFreezeDigest,
    revisionReady: binding.revisionReady,
    finalFreeze: binding.finalFreeze,
    edges: binding.edges,
    cycle: binding.cycle,
    effectAuthorized: binding.effectAuthorized,
    bindingDigest: binding.bindingDigest
  });
}

function carryProjection(carry) {
  return carry === null ? null : deepFreeze({
    schemaVersion: carry.schemaVersion,
    kind: carry.kind,
    carryId: carry.carryId,
    carryDigest: carry.carryDigest,
    unitDigest: carry.unitDigest,
    resultDigest: carry.resultDigest,
    admissionDigest: carry.admissionDigest,
    cacheKey: carry.cacheKey,
    currentContentDigest: carry.currentContentDigest,
    currentRevisionDigest: carry.currentRevisionDigest,
    freshness: carry.freshness,
    provenance: carry.provenance,
    accepted: carry.accepted,
    effectAuthorized: carry.effectAuthorized
  });
}

function classifyOff(full, admission) {
  if (admission.status !== "admitted" || admission.cacheEligible !== true) {
    return { status: "hold", reason: admission.reason ?? "current-verification-admission-not-available" };
  }
  if (full.status === "unknown") return { status: "unknown", reason: full.reason };
  if (full.status !== "pass") return { status: "fail", reason: full.reason };
  if (full.observedContentDigest !== admission.currentContentDigest ||
      full.observedManifestDigest !== admission.currentManifestDigest) {
    return { status: "unknown", reason: "full-result-and-final-admission-drifted" };
  }
  return { status: "pass", reason: "full-recompute-and-fresh-admission-pass" };
}

function classifyShadow(shadowReceipt, admission) {
  if (admission.status !== "admitted" || admission.cacheEligible !== true) {
    return { status: "hold", reason: admission.reason ?? "current-verification-admission-not-available" };
  }
  if (shadowReceipt.status === "unknown") return { status: "unknown", reason: shadowReceipt.reason };
  if (shadowReceipt.status === "fail") return { status: "fail", reason: shadowReceipt.reason };
  if (shadowReceipt.status !== "pass") return { status: "hold", reason: shadowReceipt.reason };
  if (shadowReceipt.currentContentDigest !== admission.currentContentDigest ||
      shadowReceipt.currentManifestDigest !== admission.currentManifestDigest) {
    return { status: "unknown", reason: "shadow-receipt-and-final-admission-drifted" };
  }
  return { status: "pass", reason: "full-shadow-equivalent-with-fresh-carry" };
}

function automaticQualification() {
  return {
    mode: "off",
    candidateEligible: false,
    accepted: false,
    ci95LowerBound: null,
    reason: "production-consumer-is-observe-only-until-independent-ci-receipt"
  };
}

async function finaliseEvaluationFailure(context, taskContext, observation, startedAt, error, reason = null) {
  const unit = taskContext.unit;
  const mode = taskContext.task.verification.mode;
  return finaliseReceipt(context, {
    schemaVersion: NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION,
    kind: NATIVE_V3_VERIFICATION_RECEIPT_KIND,
    phase: "evaluation",
    mode,
    planId: context.plan.planId,
    planDigest: context.plan.planDigest,
    contractDigest: context.plan.contractDigest,
    runId: observation.runId,
    epoch: observation.epoch,
    unrelatedHeadDigest: observation.unrelatedHeadDigest,
    taskId: taskContext.taskId,
    unitId: unit.unitId,
    unitDigest: unit.unitDigest,
    cacheKey: unit.cacheKey,
    sourceBindingDigest: unit.sourceBinding.digest,
    relevantRevisionDigest: unit.relevantRevisionDigest,
    status: error?.status === "UNKNOWN" ? "unknown" : "hold",
    reason: reason ?? error?.code ?? "verification-evaluation-failed",
    error: errorProjection(error),
    full: null,
    shadow: null,
    currentAdmission: null,
    carryForward: null,
    revisionFreeze: null,
    automaticQualification: automaticQualification(),
    timings: { scope: "single-local-trusted-consumer", totalMs: elapsed(startedAt) },
    accepted: false,
    effectAuthorized: false
  });
}

async function finaliseBootstrapFailure(context, taskContext, observation, startedAt, error) {
  const unit = taskContext.unit;
  return finaliseReceipt(context, {
    schemaVersion: NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION,
    kind: NATIVE_V3_VERIFICATION_BOOTSTRAP_KIND,
    phase: "bootstrap",
    mode: "shadow",
    planId: context.plan.planId,
    planDigest: context.plan.planDigest,
    contractDigest: context.plan.contractDigest,
    runId: observation.runId,
    epoch: observation.epoch,
    unrelatedHeadDigest: observation.unrelatedHeadDigest,
    taskId: taskContext.taskId,
    unitId: unit.unitId,
    unitDigest: unit.unitDigest,
    cacheKey: unit.cacheKey,
    sourceBindingDigest: unit.sourceBinding.digest,
    relevantRevisionDigest: unit.relevantRevisionDigest,
    status: error?.status === "UNKNOWN" ? "unknown" : "hold",
    reason: error?.code ?? "verification-bootstrap-failed",
    error: errorProjection(error),
    candidate: null,
    currentAdmission: null,
    store: null,
    automaticQualification: automaticQualification(),
    timings: { scope: "single-local-trusted-consumer", totalMs: elapsed(startedAt) },
    accepted: false,
    effectAuthorized: false
  });
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function persistImmutableReceipt(stateRoot, receipt) {
  const serialized = `${JSON.stringify(receipt)}\n`;
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > NATIVE_V3_VERIFICATION_MAX_RECEIPT_BYTES) {
    throw hold("ENATIVE_V3_VERIFICATION_RECEIPT_TOO_LARGE", "Verification receipt exceeds its fixed size bound");
  }
  const directory = safeJoin(stateRoot, NATIVE_V3_VERIFICATION_RECEIPT_DIRECTORY, receipt.runId, receipt.taskId, String(receipt.epoch));
  await assertNoSymlinkUnder(stateRoot, directory);
  await ensurePrivateDir(directory);
  const target = safeJoin(directory, `${receipt.receiptDigest}.json`);
  const temporary = safeJoin(directory, `.${receipt.receiptDigest}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    try {
      await link(temporary, target);
      await syncDirectory(directory);
      return { status: "stored", path: relativeArtifactPath(stateRoot, target) };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readJson(stateRoot, target);
      if (canonicalJson(existing) !== canonicalJson(receipt)) {
        throw hold("ENATIVE_V3_VERIFICATION_RECEIPT_CONFLICT", "Immutable verification receipt path contains different content");
      }
      return { status: "already-present", path: relativeArtifactPath(stateRoot, target) };
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function receiptDigestCore(value) {
  const core = { ...value };
  delete core.receiptDigest;
  delete core.receiptPath;
  delete core.persistence;
  return core;
}

async function finaliseReceipt(context, value) {
  const core = deepFreeze(structuredClone(value));
  const receipt = deepFreeze({
    ...core,
    receiptDigest: digestObject(receiptDigestCore(core))
  });
  assertReceipt(receipt);
  const persistence = await persistImmutableReceipt(context.stateRoot, receipt);
  const returned = deepFreeze({
    ...receipt,
    receiptPath: persistence.path,
    persistence
  });
  RECEIPTS.add(returned);
  RECEIPT_CONSUMERS.set(returned, context.consumer);
  return returned;
}

function requireReceiptKeys(value, keys, label) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new NativeV3VerificationConsumerInputError(`${label} requires ${key}`);
  }
}

function exactProjectionKeys(value, keys, label) {
  exactKeys(value, keys, label);
  requireReceiptKeys(value, [...keys], label);
}

function boundedReceiptText(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
    throw new NativeV3VerificationConsumerInputError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function nullableReceiptDigest(value, label) {
  if (value === null || value === undefined) return null;
  return digest(value, label);
}

function assertReceiptError(value, label) {
  if (value === null) return null;
  exactKeys(value, new Set(["code", "message", "status"]), label);
  requireReceiptKeys(value, ["code", "message", "status"], label);
  boundedReceiptText(value.code, `${label}.code`);
  boundedReceiptText(value.message, `${label}.message`);
  if (value.status !== "HOLD" && value.status !== "UNKNOWN") {
    throw new NativeV3VerificationConsumerInputError(`${label}.status is invalid`);
  }
  return value;
}

function assertHistoricalSnapshotProjection(value, label, { requireTime = true } = {}) {
  if (!isPlainObject(value)) throw new NativeV3VerificationConsumerInputError(`${label} must be a plain object`);
  exactProjectionKeys(value, requireTime ? HISTORICAL_SNAPSHOT_KEYS : ADMISSION_SNAPSHOT_KEYS, label);
  if (value.kind !== "HistoricalDependencySnapshotV1" || value.status !== "historical" || value.current !== false) {
    throw new NativeV3VerificationConsumerInputError(`${label} must describe a historical dependency snapshot`);
  }
  digest(value.contentDigest, `${label}.contentDigest`);
  digest(value.manifestDigest, `${label}.manifestDigest`);
  if (requireTime && (!Number.isSafeInteger(value.capturedAtMs) || value.capturedAtMs < 0)) {
    throw new NativeV3VerificationConsumerInputError(`${label}.capturedAtMs is invalid`);
  }
  return value;
}

function assertProducerProjection(value, label) {
  exactProjectionKeys(value, new Set(["id", "digest", "trust"]), label);
  boundedReceiptText(value.id, `${label}.id`);
  digest(value.digest, `${label}.digest`);
  boundedReceiptText(value.trust, `${label}.trust`);
  return value;
}

function assertVerifierProjection(value, label) {
  exactProjectionKeys(value, new Set(["id", "digest", "provenance"]), label);
  boundedReceiptText(value.id, `${label}.id`);
  digest(value.digest, `${label}.digest`);
  boundedReceiptText(value.provenance, `${label}.provenance`);
  return value;
}

function assertProvenanceProjection(value, label, parent) {
  exactProjectionKeys(value, PROVENANCE_KEYS, label);
  assertProducerProjection(value.producer, `${label}.producer`);
  assertVerifierProjection(value.verifier, `${label}.verifier`);
  digest(value.sourceBindingDigest, `${label}.sourceBindingDigest`);
  if (parent?.sourceBindingDigest !== undefined && value.sourceBindingDigest !== parent.sourceBindingDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.sourceBindingDigest is not bound to the receipt`);
  }
  return value;
}

function assertObservationBinding(value, parent, label) {
  for (const field of ["runId", "epoch", "unrelatedHeadDigest"]) {
    if (value[field] !== parent[field]) {
      throw new NativeV3VerificationConsumerInputError(`${label}.${field} is not bound to the receipt observation`);
    }
  }
}

function assertAdmissionDecision(value, label) {
  if (!["admitted", "hold", "full-required"].includes(value.status)) {
    throw new NativeV3VerificationConsumerInputError(`${label}.status is invalid`);
  }
  const admitted = value.status === "admitted";
  const expectedDisposition = admitted ? "cache-eligible" : "full-required";
  if (value.disposition !== expectedDisposition || value.cacheEligible !== admitted) {
    throw new NativeV3VerificationConsumerInputError(`${label}.status/disposition/cacheEligible are inconsistent`);
  }
}

function assertReceiptProjection(value, label, parent, expectedMode = "full") {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new NativeV3VerificationConsumerInputError(`${label} must be an object or null`);
  exactProjectionKeys(value, RESULT_PROJECTION_KEYS, label);
  if (value.schemaVersion !== NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION || value.kind !== "VerificationResultV1") {
    throw new NativeV3VerificationConsumerInputError(`${label} kind/version is invalid`);
  }
  safeId(value.resultId, `${label}.resultId`);
  digest(value.resultDigest, `${label}.resultDigest`);
  if (value.unitDigest !== parent.unitDigest) throw new NativeV3VerificationConsumerInputError(`${label}.unitDigest is not bound to the receipt unit`);
  if (value.cacheKey !== parent.cacheKey) throw new NativeV3VerificationConsumerInputError(`${label}.cacheKey is not bound to the receipt unit`);
  if (value.mode !== expectedMode) throw new NativeV3VerificationConsumerInputError(`${label}.mode is invalid`);
  if (!["pass", "fail", "unknown"].includes(value.status)) throw new NativeV3VerificationConsumerInputError(`${label}.status is invalid`);
  if (value.outcome !== value.status) throw new NativeV3VerificationConsumerInputError(`${label}.outcome is not consistent with status`);
  boundedReceiptText(value.outcome, `${label}.outcome`);
  boundedReceiptText(value.reason, `${label}.reason`);
  digest(value.observedContentDigest, `${label}.observedContentDigest`);
  digest(value.observedManifestDigest, `${label}.observedManifestDigest`);
  const snapshot = assertHistoricalSnapshotProjection(value.snapshot, `${label}.snapshot`);
  if (snapshot.contentDigest !== value.observedContentDigest || snapshot.manifestDigest !== value.observedManifestDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.snapshot is not bound to observed digests`);
  }
  if (!Array.isArray(value.unknowns) || !Array.isArray(value.findings)) {
    throw new NativeV3VerificationConsumerInputError(`${label}.unknowns/findings must be arrays`);
  }
  assertProducerProjection(value.producer, `${label}.producer`);
  assertVerifierProjection(value.verifier, `${label}.verifier`);
  if (value.sealed !== true || value.effectAuthorized !== false) {
    throw new NativeV3VerificationConsumerInputError(`${label} must be sealed and cannot authorize effects`);
  }
  if (value.authoritative !== false) {
    throw new NativeV3VerificationConsumerInputError(`${label}.authoritative cannot grant authority`);
  }
  const withoutDigest = { ...value };
  delete withoutDigest.resultDigest;
  if (digestObject(withoutDigest) !== value.resultDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.resultDigest does not match its projection`);
  }
  return value;
}

function assertShadowResultProjection(value, label, parent, expectedMode = "full") {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new NativeV3VerificationConsumerInputError(`${label} must be an object or null`);
  exactProjectionKeys(value, SHADOW_RESULT_PROJECTION_KEYS, label);
  digest(value.resultDigest, `${label}.resultDigest`);
  if (value.unitDigest !== parent.unitDigest) throw new NativeV3VerificationConsumerInputError(`${label}.unitDigest is not bound to the receipt unit`);
  if (value.cacheKey !== parent.cacheKey) throw new NativeV3VerificationConsumerInputError(`${label}.cacheKey is not bound to the receipt unit`);
  if (value.mode !== expectedMode) throw new NativeV3VerificationConsumerInputError(`${label}.mode is invalid`);
  if (!["pass", "fail", "unknown"].includes(value.status)) throw new NativeV3VerificationConsumerInputError(`${label}.status is invalid`);
  if (value.outcome !== value.status) throw new NativeV3VerificationConsumerInputError(`${label}.outcome is not consistent with status`);
  boundedReceiptText(value.outcome, `${label}.outcome`);
  boundedReceiptText(value.reason, `${label}.reason`);
  digest(value.observedContentDigest, `${label}.observedContentDigest`);
  digest(value.observedManifestDigest, `${label}.observedManifestDigest`);
  if (!Array.isArray(value.unknowns) || !Array.isArray(value.findings)) {
    throw new NativeV3VerificationConsumerInputError(`${label}.unknowns/findings must be arrays`);
  }
  return value;
}

function assertAdmissionProjection(value, label, parent) {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new NativeV3VerificationConsumerInputError(`${label} must be an object or null`);
  exactProjectionKeys(value, ADMISSION_PROJECTION_KEYS, label);
  if (value.schemaVersion !== NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION || value.kind !== "VerificationAdmissionV1") {
    throw new NativeV3VerificationConsumerInputError(`${label} kind/version is invalid`);
  }
  digest(value.admissionDigest, `${label}.admissionDigest`);
  if (value.unitDigest !== parent.unitDigest) throw new NativeV3VerificationConsumerInputError(`${label}.unitDigest is not bound to the receipt unit`);
  if (value.cacheKey !== parent.cacheKey) throw new NativeV3VerificationConsumerInputError(`${label}.cacheKey is not bound to the receipt unit`);
  digest(value.currentContentDigest, `${label}.currentContentDigest`);
  digest(value.currentManifestDigest, `${label}.currentManifestDigest`);
  const snapshot = assertHistoricalSnapshotProjection(value.snapshot, `${label}.snapshot`, { requireTime: false });
  if (snapshot.contentDigest !== value.currentContentDigest || snapshot.manifestDigest !== value.currentManifestDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.snapshot is not bound to current digests`);
  }
  assertAdmissionDecision(value, label);
  safeId(value.runId, `${label}.runId`);
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 0) {
    throw new NativeV3VerificationConsumerInputError(`${label}.epoch is invalid`);
  }
  nullableReceiptDigest(value.unrelatedHeadDigest, `${label}.unrelatedHeadDigest`);
  assertObservationBinding(value, parent, label);
  digest(value.sourceBindingDigest, `${label}.sourceBindingDigest`);
  digest(value.relevantRevisionDigest, `${label}.relevantRevisionDigest`);
  if (value.sourceBindingDigest !== parent.sourceBindingDigest || value.relevantRevisionDigest !== parent.relevantRevisionDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label} source/revision binding is not bound to the receipt`);
  }
  if (value.effectAuthorized !== false) {
    throw new NativeV3VerificationConsumerInputError(`${label}.effectAuthorized cannot authorize effects`);
  }
  return value;
}

function assertShadowAdmissionProjection(value, label, parent) {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new NativeV3VerificationConsumerInputError(`${label} must be an object or null`);
  exactProjectionKeys(value, SHADOW_ADMISSION_PROJECTION_KEYS, label);
  digest(value.admissionDigest, `${label}.admissionDigest`);
  if (value.unitDigest !== parent.unitDigest) throw new NativeV3VerificationConsumerInputError(`${label}.unitDigest is not bound to the receipt unit`);
  if (value.cacheKey !== parent.cacheKey) throw new NativeV3VerificationConsumerInputError(`${label}.cacheKey is not bound to the receipt unit`);
  digest(value.currentContentDigest, `${label}.currentContentDigest`);
  digest(value.currentManifestDigest, `${label}.currentManifestDigest`);
  assertAdmissionDecision(value, label);
  boundedReceiptText(value.disposition, `${label}.disposition`);
  boundedReceiptText(value.reason, `${label}.reason`);
  if (typeof value.cacheEligible !== "boolean") throw new NativeV3VerificationConsumerInputError(`${label}.cacheEligible must be boolean`);
  digest(value.sourceBindingDigest, `${label}.sourceBindingDigest`);
  digest(value.relevantRevisionDigest, `${label}.relevantRevisionDigest`);
  if (value.relevantRevisionDigest !== parent.relevantRevisionDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label} source/revision binding is not bound to the receipt`);
  }
  return value;
}

function assertCarryFreshness(value, label) {
  exactProjectionKeys(value, new Set(["kind", "status", "current", "capturedAtMs", "contentDigest", "manifestDigest", "admissionDigest"]), label);
  if (value.kind !== "FreshCurrentAdmissionBoundaryV1" || value.status !== "fresh-capture" || value.current !== false) {
    throw new NativeV3VerificationConsumerInputError(`${label} is not a fresh current admission boundary`);
  }
  if (!Number.isSafeInteger(value.capturedAtMs) || value.capturedAtMs < 0) {
    throw new NativeV3VerificationConsumerInputError(`${label}.capturedAtMs is invalid`);
  }
  digest(value.contentDigest, `${label}.contentDigest`);
  digest(value.manifestDigest, `${label}.manifestDigest`);
  digest(value.admissionDigest, `${label}.admissionDigest`);
  return value;
}

function assertCarryProjection(value, label, parent) {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new NativeV3VerificationConsumerInputError(`${label} must be an object or null`);
  exactProjectionKeys(value, CARRY_PROJECTION_KEYS, label);
  if (value.schemaVersion !== NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION || value.kind !== "CarryForwardV1") {
    throw new NativeV3VerificationConsumerInputError(`${label} kind/version is invalid`);
  }
  digest(value.carryDigest, `${label}.carryDigest`);
  safeId(value.carryId, `${label}.carryId`);
  if (value.unitDigest !== parent.unitDigest || value.cacheKey !== parent.cacheKey) {
    throw new NativeV3VerificationConsumerInputError(`${label} unit/cache binding is not bound to the receipt`);
  }
  digest(value.resultDigest, `${label}.resultDigest`);
  digest(value.admissionDigest, `${label}.admissionDigest`);
  digest(value.currentContentDigest, `${label}.currentContentDigest`);
  digest(value.currentRevisionDigest, `${label}.currentRevisionDigest`);
  if (!parent.currentAdmission || value.admissionDigest !== parent.currentAdmission.admissionDigest ||
      value.currentContentDigest !== parent.currentAdmission.currentContentDigest ||
      value.currentRevisionDigest !== parent.relevantRevisionDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label} admission/revision binding is not bound to the receipt`);
  }
  const freshness = assertCarryFreshness(value.freshness, `${label}.freshness`);
  if (freshness.contentDigest !== value.currentContentDigest || freshness.manifestDigest !== parent.currentAdmission.currentManifestDigest ||
      freshness.admissionDigest !== value.admissionDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.freshness is not bound to current content`);
  }
  assertProvenanceProjection(value.provenance, `${label}.provenance`, parent);
  if (value.accepted !== true || value.effectAuthorized !== false) {
    throw new NativeV3VerificationConsumerInputError(`${label} cannot carry authority or an unaccepted value`);
  }
  const pairedResultDigest = parent.shadow?.carryForward?.resultDigest ?? null;
  if (pairedResultDigest !== null && value.resultDigest !== pairedResultDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.resultDigest is not bound to the paired shadow carry`);
  }
  const withoutDigest = { ...value };
  delete withoutDigest.carryDigest;
  if (digestObject(withoutDigest) !== value.carryDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.carryDigest does not match its projection`);
  }
  return value;
}

function assertFreezeProjection(value, label, parent) {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new NativeV3VerificationConsumerInputError(`${label} must be an object or null`);
  exactProjectionKeys(value, FREEZE_PROJECTION_KEYS, label);
  if (value.schemaVersion !== NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION || value.kind !== "RevisionFreezeBindingV1") {
    throw new NativeV3VerificationConsumerInputError(`${label} kind/version is invalid`);
  }
  if (value.unitDigest !== parent.unitDigest) throw new NativeV3VerificationConsumerInputError(`${label}.unitDigest is not bound to the receipt unit`);
  digest(value.revisionReadyDigest, `${label}.revisionReadyDigest`);
  digest(value.finalFreezeDigest, `${label}.finalFreezeDigest`);
  digest(value.bindingDigest, `${label}.bindingDigest`);
  if (value.revisionReadyDigest === value.finalFreezeDigest || value.cycle !== false || value.effectAuthorized !== false) {
    throw new NativeV3VerificationConsumerInputError(`${label} binding fields are invalid`);
  }
  if (!Array.isArray(value.edges) || value.edges.length !== 1 || !isPlainObject(value.edges[0])) {
    throw new NativeV3VerificationConsumerInputError(`${label}.edges must contain one edge`);
  }
  exactProjectionKeys(value.edges[0], new Set(["from", "to"]), `${label}.edges[0]`);
  if (value.edges[0].from !== "revision-ready" || value.edges[0].to !== "final-freeze") {
    throw new NativeV3VerificationConsumerInputError(`${label}.edges are not an acyclic revision-ready binding`);
  }
  const revisionReady = value.revisionReady;
  exactProjectionKeys(revisionReady, new Set(["schemaVersion", "kind", "unitDigest", "admissionDigest", "currentContentDigest", "revision", "digest"]), `${label}.revisionReady`);
  if (revisionReady.schemaVersion !== NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION || revisionReady.kind !== "RevisionReadyV1" ||
      revisionReady.unitDigest !== parent.unitDigest || revisionReady.digest !== value.revisionReadyDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.revisionReady is not bound to the receipt`);
  }
  digest(revisionReady.admissionDigest, `${label}.revisionReady.admissionDigest`);
  digest(revisionReady.currentContentDigest, `${label}.revisionReady.currentContentDigest`);
  if (!isPlainObject(revisionReady.revision)) throw new NativeV3VerificationConsumerInputError(`${label}.revisionReady.revision is invalid`);
  const revisionWithoutDigest = { ...revisionReady };
  delete revisionWithoutDigest.digest;
  if (digestObject(revisionWithoutDigest) !== revisionReady.digest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.revisionReady.digest does not match its node`);
  }
  const finalFreeze = value.finalFreeze;
  exactProjectionKeys(finalFreeze, new Set(["schemaVersion", "kind", "unitDigest", "revisionReadyDigest", "carryForwardDigest", "freeze", "digest"]), `${label}.finalFreeze`);
  if (finalFreeze.schemaVersion !== NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION || finalFreeze.kind !== "FinalFreezeV1" ||
      finalFreeze.unitDigest !== parent.unitDigest || finalFreeze.revisionReadyDigest !== value.revisionReadyDigest ||
      finalFreeze.digest !== value.finalFreezeDigest || !isPlainObject(finalFreeze.freeze)) {
    throw new NativeV3VerificationConsumerInputError(`${label}.finalFreeze is not bound to the receipt`);
  }
  if (parent.currentAdmission === null || revisionReady.admissionDigest !== parent.currentAdmission.admissionDigest ||
      revisionReady.currentContentDigest !== parent.currentAdmission.currentContentDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.revisionReady is not bound to current admission`);
  }
  const expectedCarryDigest = parent.carryForward?.carryDigest ?? null;
  if (finalFreeze.carryForwardDigest !== expectedCarryDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.finalFreeze is not bound to carry evidence`);
  }
  if (revisionReady.revision.relevantRevisionDigest !== undefined &&
      revisionReady.revision.relevantRevisionDigest !== parent.relevantRevisionDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.revisionReady.revision is not bound to the receipt revision`);
  }
  if (revisionReady.revision.sourceBindingDigest !== undefined) {
    digest(revisionReady.revision.sourceBindingDigest, `${label}.revisionReady.revision.sourceBindingDigest`);
  }
  if (finalFreeze.freeze.phase !== "revision-ready" || finalFreeze.freeze.mode !== parent.mode) {
    throw new NativeV3VerificationConsumerInputError(`${label}.finalFreeze.freeze is not bound to the receipt mode`);
  }
  if (finalFreeze.freeze.shadowReceiptDigest !== undefined &&
      finalFreeze.freeze.shadowReceiptDigest !== parent.shadow?.receiptDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.finalFreeze.freeze is not bound to the shadow receipt`);
  }
  const finalFreezeWithoutDigest = { ...finalFreeze };
  delete finalFreezeWithoutDigest.digest;
  if (digestObject(finalFreezeWithoutDigest) !== finalFreeze.digest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.finalFreeze.digest does not match its node`);
  }
  const withoutBindingDigest = { ...value };
  delete withoutBindingDigest.bindingDigest;
  if (digestObject(withoutBindingDigest) !== value.bindingDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.bindingDigest does not match its binding`);
  }
  return value;
}

function assertShadowCarryProjection(value, label, parent) {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new NativeV3VerificationConsumerInputError(`${label} must be an object or null`);
  exactProjectionKeys(value, SHADOW_CARRY_PROJECTION_KEYS, label);
  digest(value.carryDigest, `${label}.carryDigest`);
  safeId(value.carryId, `${label}.carryId`);
  if (value.unitDigest !== parent.unitDigest || value.admissionDigest !== parent.currentAdmission?.admissionDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label} unit/admission binding is not bound to the shadow receipt`);
  }
  for (const field of ["resultDigest", "currentContentDigest", "currentRevisionDigest"]) {
    digest(value[field], `${label}.${field}`);
  }
  if (value.currentContentDigest !== parent.currentAdmission.currentContentDigest ||
      value.currentRevisionDigest !== parent.relevantRevisionDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label} content/revision binding is not bound to the shadow receipt`);
  }
  const freshness = assertCarryFreshness(value.freshness, `${label}.freshness`);
  if (value.freshnessContentDigest !== freshness.contentDigest || value.freshnessManifestDigest !== freshness.manifestDigest ||
      freshness.contentDigest !== value.currentContentDigest || freshness.admissionDigest !== value.admissionDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.freshness is not internally consistent`);
  }
  if (value.accepted !== true || value.effectAuthorized !== false) {
    throw new NativeV3VerificationConsumerInputError(`${label} cannot carry authority or an unaccepted value`);
  }
  return value;
}

function assertShadowOperationalError(value, label) {
  if (value === null) return null;
  exactProjectionKeys(value, new Set(["kind", "operation", "code", "message"]), label);
  if (value.kind !== "VerificationShadowRunOperationalErrorV1") throw new NativeV3VerificationConsumerInputError(`${label}.kind is invalid`);
  boundedReceiptText(value.operation, `${label}.operation`);
  if (value.code !== null && value.code !== undefined) boundedReceiptText(value.code, `${label}.code`);
  boundedReceiptText(value.message, `${label}.message`);
  return value;
}

function assertShadowProjection(value, label, parent) {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new NativeV3VerificationConsumerInputError(`${label} must be an object or null`);
  exactProjectionKeys(value, SHADOW_RECEIPT_KEYS, label);
  if (value.schemaVersion !== NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION || value.kind !== "VerificationShadowRunReceiptV1" ||
      value.decision !== "shadow-only" || value.mode !== "off") {
    throw new NativeV3VerificationConsumerInputError(`${label} kind/version is invalid`);
  }
  digest(value.receiptDigest, `${label}.receiptDigest`);
  if (value.unitDigest !== parent.unitDigest || value.cacheKey !== parent.cacheKey) {
    throw new NativeV3VerificationConsumerInputError(`${label} unit/cache binding is not bound to the receipt`);
  }
  assertObservationBinding(value, parent, label);
  digest(value.baselineContentDigest, `${label}.baselineContentDigest`);
  digest(value.baselineManifestDigest, `${label}.baselineManifestDigest`);
  digest(value.relevantRevisionDigest, `${label}.relevantRevisionDigest`);
  if (value.relevantRevisionDigest !== parent.relevantRevisionDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.relevantRevisionDigest is not bound to the receipt`);
  }
  if (!["pass", "fail", "hold", "unknown"].includes(value.status)) throw new NativeV3VerificationConsumerInputError(`${label}.status is invalid`);
  boundedReceiptText(value.reason, `${label}.reason`);
  digest(value.currentContentDigest, `${label}.currentContentDigest`);
  digest(value.currentManifestDigest, `${label}.currentManifestDigest`);
  const full = assertShadowResultProjection(value.full, `${label}.full`, value, "full");
  const shadow = assertShadowResultProjection(value.shadow, `${label}.shadow`, value, "shadow");
  if (full === null || full.observedContentDigest !== value.currentContentDigest || full.observedManifestDigest !== value.currentManifestDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.full is not bound to current observation`);
  }
  if (shadow !== null && shadow.unitDigest !== value.unitDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.shadow is not bound to the receipt unit`);
  }
  const admission = assertShadowAdmissionProjection(value.currentAdmission, `${label}.currentAdmission`, value);
  if (admission === null || admission.currentContentDigest !== value.currentContentDigest || admission.currentManifestDigest !== value.currentManifestDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.currentAdmission is not bound to current observation`);
  }
  if (!Array.isArray(value.phaseObservations) || value.phaseObservations.length === 0) {
    throw new NativeV3VerificationConsumerInputError(`${label}.phaseObservations must be a non-empty array`);
  }
  for (const [index, observation] of value.phaseObservations.entries()) {
    exactProjectionKeys(observation, new Set(["phase", "role", "contentDigest", "manifestDigest"]), `${label}.phaseObservations[${index}]`);
    boundedReceiptText(observation.phase, `${label}.phaseObservations[${index}].phase`);
    if (observation.role !== "current" && observation.role !== "historical") {
      throw new NativeV3VerificationConsumerInputError(`${label}.phaseObservations[${index}].role is invalid`);
    }
    nullableReceiptDigest(observation.contentDigest, `${label}.phaseObservations[${index}].contentDigest`);
    nullableReceiptDigest(observation.manifestDigest, `${label}.phaseObservations[${index}].manifestDigest`);
  }
  if (!Array.isArray(value.observationIssues)) throw new NativeV3VerificationConsumerInputError(`${label}.observationIssues must be an array`);
  for (const [index, issue] of value.observationIssues.entries()) {
    if (!isPlainObject(issue)) throw new NativeV3VerificationConsumerInputError(`${label}.observationIssues[${index}] must be an object`);
    boundedReceiptText(issue.kind, `${label}.observationIssues[${index}].kind`);
    boundedReceiptText(issue.phase, `${label}.observationIssues[${index}].phase`);
    if (issue.role !== "current" && issue.role !== "historical") throw new NativeV3VerificationConsumerInputError(`${label}.observationIssues[${index}].role is invalid`);
    for (const field of ["expectedContentDigest", "observedContentDigest", "expectedManifestDigest", "observedManifestDigest"]) {
      if (issue[field] !== undefined && issue[field] !== null) digest(issue[field], `${label}.observationIssues[${index}].${field}`);
    }
  }
  assertShadowOperationalError(value.shadowLoadError, `${label}.shadowLoadError`);
  assertShadowOperationalError(value.carryForwardError, `${label}.carryForwardError`);
  if (value.shadowLoad !== null) {
    exactProjectionKeys(value.shadowLoad, new Set([
      "reason", "hit", "cacheHit", "revalidated", "recordDigest", "authenticated", "resultDigest",
      "resultObservedContentDigest", "resultObservedManifestDigest", "admissionDigest",
      "admissionCurrentContentDigest", "admissionCurrentManifestDigest"
    ]), `${label}.shadowLoad`);
    boundedReceiptText(value.shadowLoad.reason, `${label}.shadowLoad.reason`);
    for (const field of ["hit", "cacheHit", "revalidated", "authenticated"]) {
      if (typeof value.shadowLoad[field] !== "boolean") throw new NativeV3VerificationConsumerInputError(`${label}.shadowLoad.${field} is invalid`);
    }
    for (const field of ["recordDigest", "resultDigest", "resultObservedContentDigest", "resultObservedManifestDigest", "admissionDigest", "admissionCurrentContentDigest", "admissionCurrentManifestDigest"]) {
      nullableReceiptDigest(value.shadowLoad[field], `${label}.shadowLoad.${field}`);
    }
  }
  assertShadowCarryProjection(value.carryForward, `${label}.carryForward`, value);
  if (value.carryForward !== null && (shadow === null || value.carryForward.resultDigest !== shadow.resultDigest)) {
    throw new NativeV3VerificationConsumerInputError(`${label}.carryForward is not bound to the shadow result`);
  }
  if (value.comparison !== null) {
    exactProjectionKeys(value.comparison, new Set(["kind", "digest", "fullResultDigest", "shadowResultDigest", "equivalent", "status", "decision", "accepted", "effectAuthorized"]), `${label}.comparison`);
    boundedReceiptText(value.comparison.kind, `${label}.comparison.kind`);
    digest(value.comparison.digest, `${label}.comparison.digest`);
    digest(value.comparison.fullResultDigest, `${label}.comparison.fullResultDigest`);
    nullableReceiptDigest(value.comparison.shadowResultDigest, `${label}.comparison.shadowResultDigest`);
    if (typeof value.comparison.equivalent !== "boolean" || value.comparison.status !== "observe-only" ||
        value.comparison.decision !== "shadow-only" || value.comparison.accepted !== false || value.comparison.effectAuthorized !== false) {
      throw new NativeV3VerificationConsumerInputError(`${label}.comparison is inconsistent`);
    }
    if (value.comparison.fullResultDigest !== full.resultDigest ||
        value.comparison.shadowResultDigest !== (shadow?.resultDigest ?? null)) {
      throw new NativeV3VerificationConsumerInputError(`${label}.comparison is not bound to its result projections`);
    }
    if (value.status === "pass" && value.comparison.equivalent !== true) {
      throw new NativeV3VerificationConsumerInputError(`${label}.pass status requires an equivalent comparison`);
    }
  }
  if (!isPlainObject(value.dependencyDelta) || !isPlainObject(value.requiredCases)) {
    throw new NativeV3VerificationConsumerInputError(`${label}.dependencyDelta/requiredCases are invalid`);
  }
  exactProjectionKeys(value.inputBinding, new Set([
    "configDigest", "policyDigest", "controlledEnvironmentDigest", "sourceBindingDigest", "validatorDigest", "toolBinaryDigest"
  ]), `${label}.inputBinding`);
  for (const field of Object.keys(value.inputBinding)) digest(value.inputBinding[field], `${label}.inputBinding.${field}`);
  exactProjectionKeys(value.timings, new Set(["scope", "fullComputeMs", "fullAdmissionMs", "fingerprintCaptureMs", "shadowLoadMs", "shadowCarryMs", "totalMs"]), `${label}.timings`);
  if (value.timings.scope !== "single-local-fixture-run") throw new NativeV3VerificationConsumerInputError(`${label}.timings.scope is invalid`);
  for (const field of ["fullComputeMs", "fullAdmissionMs", "fingerprintCaptureMs", "shadowLoadMs", "shadowCarryMs", "totalMs"]) {
    if (!Number.isFinite(value.timings[field]) || value.timings[field] < 0) throw new NativeV3VerificationConsumerInputError(`${label}.timings.${field} is invalid`);
  }
  if (!Array.isArray(value.unknowns)) throw new NativeV3VerificationConsumerInputError(`${label}.unknowns must be an array`);
  exactProjectionKeys(value.automaticQualification, new Set(["mode", "candidateEligible", "accepted", "reason", "ci95LowerBound"]), `${label}.automaticQualification`);
  if (value.automaticQualification.mode !== "off" || value.automaticQualification.candidateEligible !== false ||
      value.automaticQualification.accepted !== false || value.automaticQualification.ci95LowerBound !== null) {
    throw new NativeV3VerificationConsumerInputError(`${label}.automaticQualification is invalid`);
  }
  boundedReceiptText(value.automaticQualification.reason, `${label}.automaticQualification.reason`);
  if (value.accepted !== false || value.effectAuthorized !== false) throw new NativeV3VerificationConsumerInputError(`${label} cannot authorize effects`);
  const withoutDigest = { ...value };
  delete withoutDigest.receiptDigest;
  if (digestObject(withoutDigest) !== value.receiptDigest) {
    throw new NativeV3VerificationConsumerInputError(`${label}.receiptDigest does not match its contents`);
  }
  return value;
}

function assertReceiptEnvelope(value) {
  if (!isPlainObject(value)) throw new NativeV3VerificationConsumerInputError("verification receipt must be a plain object");
  const isBootstrap = value.kind === NATIVE_V3_VERIFICATION_BOOTSTRAP_KIND;
  const allowed = new Set(isBootstrap ? [
    "schemaVersion", "kind", "phase", "mode", "planId", "planDigest", "contractDigest", "runId", "epoch",
    "unrelatedHeadDigest", "taskId", "unitId", "unitDigest", "cacheKey", "sourceBindingDigest", "relevantRevisionDigest",
    "status", "reason", "error", "candidate", "currentAdmission", "store", "automaticQualification", "timings",
    "accepted", "effectAuthorized", "receiptDigest", "receiptPath", "persistence"
  ] : [
    "schemaVersion", "kind", "phase", "mode", "planId", "planDigest", "contractDigest", "runId", "epoch",
    "unrelatedHeadDigest", "taskId", "unitId", "unitDigest", "cacheKey", "sourceBindingDigest", "relevantRevisionDigest",
    "status", "reason", "error", "full", "shadow", "currentAdmission", "carryForward", "revisionFreeze",
    "automaticQualification", "timings", "accepted", "effectAuthorized", "receiptDigest", "receiptPath", "persistence"
  ]);
  exactKeys(value, allowed, "verification receipt");
  requireReceiptKeys(value, [
    "schemaVersion", "kind", "phase", "mode", "planId", "planDigest", "contractDigest", "runId", "epoch",
    "unrelatedHeadDigest", "taskId", "unitId", "unitDigest", "cacheKey", "sourceBindingDigest", "relevantRevisionDigest",
    "status", "reason", "error", "currentAdmission", "automaticQualification", "timings", "accepted", "effectAuthorized", "receiptDigest"
  ], "verification receipt");
  if (value.schemaVersion !== NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION ||
      (![NATIVE_V3_VERIFICATION_RECEIPT_KIND, NATIVE_V3_VERIFICATION_BOOTSTRAP_KIND].includes(value.kind))) {
    throw new NativeV3VerificationConsumerInputError("verification receipt kind/version is invalid");
  }
  if (isBootstrap !== (value.phase === "bootstrap")) throw new NativeV3VerificationConsumerInputError("verification receipt phase is not bound to its kind");
  if (!isBootstrap && value.phase !== "evaluation") throw new NativeV3VerificationConsumerInputError("verification receipt phase is invalid");
  if (isBootstrap && value.mode !== "shadow") throw new NativeV3VerificationConsumerInputError("bootstrap receipt mode is invalid");
  if (!MODES.has(value.mode)) throw new NativeV3VerificationConsumerInputError("verification receipt mode is invalid");
  safeId(value.planId, "receipt.planId");
  digest(value.planDigest, "receipt.planDigest");
  digest(value.contractDigest, "receipt.contractDigest");
  safeId(value.runId, "receipt.runId");
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 0) throw new NativeV3VerificationConsumerInputError("receipt.epoch is invalid");
  nullableReceiptDigest(value.unrelatedHeadDigest, "receipt.unrelatedHeadDigest");
  safeId(value.taskId, "receipt.taskId");
  safeId(value.unitId, "receipt.unitId");
  digest(value.unitDigest, "receipt.unitDigest");
  digest(value.cacheKey, "receipt.cacheKey");
  digest(value.sourceBindingDigest, "receipt.sourceBindingDigest");
  digest(value.relevantRevisionDigest, "receipt.relevantRevisionDigest");
  const statuses = isBootstrap ? new Set(["hold", "fail", "unknown", "bootstrap"]) : new Set(["pass", "fail", "hold", "unknown"]);
  if (!statuses.has(value.status)) throw new NativeV3VerificationConsumerInputError("verification receipt status is invalid");
  boundedReceiptText(value.reason, "receipt.reason");
  assertReceiptError(value.error, "receipt.error");
  if (!isPlainObject(value.automaticQualification) || value.automaticQualification.mode !== "off" ||
      value.automaticQualification.candidateEligible !== false || value.automaticQualification.accepted !== false ||
      value.automaticQualification.ci95LowerBound !== null) {
    throw new NativeV3VerificationConsumerInputError("receipt.automaticQualification is invalid");
  }
  boundedReceiptText(value.automaticQualification.reason, "receipt.automaticQualification.reason");
  if (!isPlainObject(value.timings) || value.timings.scope !== "single-local-trusted-consumer" ||
      !Number.isFinite(value.timings.totalMs) || value.timings.totalMs < 0) {
    throw new NativeV3VerificationConsumerInputError("receipt.timings is invalid");
  }
  if (value.accepted !== false || value.effectAuthorized !== false) {
    throw new NativeV3VerificationConsumerInputError("verification receipt cannot carry authority or acceptance");
  }
  assertAdmissionProjection(value.currentAdmission, "receipt.currentAdmission", value);
  if (isBootstrap) {
    assertReceiptProjection(value.candidate, "receipt.candidate", value, "shadow");
    if (value.store !== null && !isPlainObject(value.store)) throw new NativeV3VerificationConsumerInputError("receipt.store is invalid");
    if (value.status === "bootstrap" && (value.candidate === null || value.store === null)) {
      throw new NativeV3VerificationConsumerInputError("bootstrap receipt requires candidate and store evidence");
    }
  } else {
    requireReceiptKeys(value, ["full", "shadow", "carryForward", "revisionFreeze"], "verification receipt");
    if (value.mode === "off" && (value.shadow !== null || value.carryForward !== null)) {
      throw new NativeV3VerificationConsumerInputError("off receipt cannot contain shadow or carry evidence");
    }
    if (value.mode === "off") {
      assertReceiptProjection(value.full, "receipt.full", value, "full");
    } else {
      assertShadowResultProjection(value.full, "receipt.full", value, "full");
    }
    assertShadowProjection(value.shadow, "receipt.shadow", value);
    if (value.mode === "shadow" && value.shadow !== null) {
      if (canonicalJson(value.full) !== canonicalJson(value.shadow.full)) {
        throw new NativeV3VerificationConsumerInputError("shadow receipt full projection is not bound to the consumer full projection");
      }
      const shadowAdmission = value.shadow.currentAdmission;
      if (value.currentAdmission === null ||
          shadowAdmission.admissionDigest !== value.currentAdmission.admissionDigest ||
          shadowAdmission.unitDigest !== value.currentAdmission.unitDigest ||
          shadowAdmission.cacheKey !== value.currentAdmission.cacheKey ||
          shadowAdmission.currentContentDigest !== value.currentAdmission.currentContentDigest ||
          shadowAdmission.currentManifestDigest !== value.currentAdmission.currentManifestDigest ||
          shadowAdmission.status !== value.currentAdmission.status ||
          shadowAdmission.disposition !== value.currentAdmission.disposition ||
          shadowAdmission.cacheEligible !== value.currentAdmission.cacheEligible ||
          shadowAdmission.sourceBindingDigest !== value.currentAdmission.sourceBindingDigest ||
          shadowAdmission.relevantRevisionDigest !== value.currentAdmission.relevantRevisionDigest) {
        throw new NativeV3VerificationConsumerInputError("shadow receipt admission is not bound to the consumer admission");
      }
    }
    assertCarryProjection(value.carryForward, "receipt.carryForward", value);
    assertFreezeProjection(value.revisionFreeze, "receipt.revisionFreeze", value);
    if (value.status !== "pass" && (value.carryForward !== null || value.revisionFreeze !== null)) {
      throw new NativeV3VerificationConsumerInputError("non-pass receipt cannot contain accepted carry or freeze evidence");
    }
    if (value.mode === "shadow" && value.status === "pass" && (value.shadow === null || value.carryForward === null || value.revisionFreeze === null)) {
      throw new NativeV3VerificationConsumerInputError("shadow pass receipt is missing paired evidence");
    }
    if (value.status === "pass" && (value.currentAdmission === null || value.full === null || value.revisionFreeze === null)) {
      throw new NativeV3VerificationConsumerInputError("pass receipt is missing current admission or freeze evidence");
    }
    if (value.status === "pass") {
      if (value.currentAdmission.status !== "admitted" || value.currentAdmission.cacheEligible !== true ||
          value.full.status !== "pass" || value.full.outcome !== "pass" ||
          value.full.observedContentDigest !== value.currentAdmission.currentContentDigest ||
          value.full.observedManifestDigest !== value.currentAdmission.currentManifestDigest) {
        throw new NativeV3VerificationConsumerInputError("pass receipt result is not bound to its admitted current observation");
      }
      if (value.mode === "shadow" && (
        value.shadow.status !== "pass" ||
        value.shadow.currentContentDigest !== value.currentAdmission.currentContentDigest ||
        value.shadow.currentManifestDigest !== value.currentAdmission.currentManifestDigest
      )) {
        throw new NativeV3VerificationConsumerInputError("shadow pass receipt is not bound to its admitted current observation");
      }
    }
  }
  if (value.receiptPath !== undefined) {
    if (typeof value.receiptPath !== "string" || path.isAbsolute(value.receiptPath) || value.receiptPath.includes("\0")) {
      throw new NativeV3VerificationConsumerInputError("receipt.receiptPath must be relative");
    }
  }
  if (value.persistence !== undefined) {
    exactKeys(value.persistence, new Set(["status", "path"]), "receipt.persistence");
    boundedReceiptText(value.persistence.status, "receipt.persistence.status");
    boundedReceiptText(value.persistence.path, "receipt.persistence.path");
  }
  return value;
}

function assertReceipt(value) {
  assertReceiptEnvelope(value);
  digest(value.receiptDigest, "receipt.receiptDigest");
  if (digestObject(receiptDigestCore(value)) !== value.receiptDigest) {
    throw new NativeV3VerificationConsumerInputError("verification receipt digest does not match its contents");
  }
  return value;
}

export function verifyNativeV3VerificationReceipt(value) {
  // This checks typed shape, bindings, and digest consistency only. It does
  // not authenticate a disk receipt or grant authority to any decision.
  return assertReceipt(value);
}

export function isNativeV3VerificationReceipt(value) {
  // Only receipts returned by this process carry the private brand. A receipt
  // read from disk remains validly digest-checkable but is not authenticated.
  return Boolean(value && RECEIPTS.has(value));
}

export function isNativeV3VerificationReceiptBoundToConsumer(receipt, consumer) {
  return Boolean(
    isNativeV3VerificationReceipt(receipt) &&
    isNativeV3VerificationConsumer(consumer) &&
    RECEIPT_CONSUMERS.get(receipt) === consumer
  );
}

export async function readNativeV3VerificationReceipt({ stateRoot, receiptPath } = {}) {
  const root = canonicalAbsolutePath(stateRoot, "stateRoot");
  if (typeof receiptPath !== "string" || path.isAbsolute(receiptPath) || receiptPath.includes("\0")) {
    throw new NativeV3VerificationConsumerInputError("receiptPath must be a relative path");
  }
  const target = safeJoin(root, receiptPath);
  return assertReceipt(await readJson(root, target));
}

class NativeV3VerificationConsumerV1 {
  async prepareTask(options = {}) {
    const context = assertConsumer(this);
    exactKeys(options, new Set(["taskId"]), "prepareTask options");
    const taskId = safeId(options.taskId, "taskId");
    const task = context.tasks.get(taskId);
    if (!task) throw new NativeV3VerificationConsumerInputError(`unknown verification task: ${taskId}`);
    const existing = context.prepared.get(taskId);
    if (existing) return existing;
    if (!task.verification) {
      throw new NativeV3VerificationConsumerInputError(`WorkflowPlan task ${taskId} has no verification declaration`);
    }
    const relevantSourceBinding = relevantSourceDescriptor({
      verification: task.verification,
      policyDigest: context.policy.digest
    });
    const manifest = assertManifestWithinScope(await captureDependencyManifest({
      root: context.repositoryRoot,
      dependencies: task.verification.dependencies,
      validator: PURE_LOCAL_VALIDATOR,
      toolBinary: PURE_LOCAL_TOOL_BINARY,
      config: task.verification.config,
      controlledEnvironment: task.verification.controlledEnvironment,
      policy: context.policy.value,
      sourceBinding: relevantSourceBinding,
      relevantRevisionDigest: relevantRevisionDigest({
        verification: task.verification,
        policyDigest: context.policy.digest
      })
    }), context.plan.taskContract.scope);
    const unit = createVerificationUnit({
      unitId: verificationUnitId(context.plan.planId, taskId),
      manifest,
      description: task.goal
    });
    const handle = deepFreeze({
      schemaVersion: NATIVE_V3_VERIFICATION_CONSUMER_SCHEMA_VERSION,
      kind: NATIVE_V3_VERIFICATION_TASK_HANDLE_KIND,
      planId: context.plan.planId,
      planDigest: context.plan.planDigest,
      contractDigest: context.plan.contractDigest,
      taskId,
      unitId: unit.unitId,
      unitDigest: unit.unitDigest,
      cacheKey: unit.cacheKey,
      mode: task.verification.mode,
      rootDigest: unit.rootDigest,
      sourceBindingDigest: unit.sourceBinding.digest,
      relevantRevisionDigest: unit.relevantRevisionDigest,
      effectAuthorized: false
    });
    TASK_HANDLES.add(handle);
    TASK_CONTEXTS.set(handle, { consumer: this, taskId, task, unit });
    context.prepared.set(taskId, handle);
    return handle;
  }

  /**
   * Read the current trusted bindings for a prepared task without evaluating
   * the validator, loading a shadow result, or publishing a receipt.  The
   * private inspection brand is only useful to this process; it never grants
   * authority to a caller.
   */
  async inspectTask(options = {}) {
    const context = assertConsumer(this);
    exactKeys(options, new Set(["taskId", "runId", "epoch", "unrelatedHeadDigest"]), "inspectTask options");
    const taskId = safeId(options.taskId, "taskId");
    const observation = options.runId === undefined && options.epoch === undefined && options.unrelatedHeadDigest === undefined
      ? { runId: null, epoch: null, unrelatedHeadDigest: null }
      : validateObservation({
          runId: options.runId,
          epoch: options.epoch,
          unrelatedHeadDigest: options.unrelatedHeadDigest
        }, "inspectTask observation");
    const handle = await this.prepareTask({ taskId });
    const taskContext = assertTaskHandle(handle);
    const base = {
      schemaVersion: NATIVE_V3_VERIFICATION_CONSUMER_SCHEMA_VERSION,
      kind: NATIVE_V3_VERIFICATION_INSPECTION_KIND,
      planId: handle.planId,
      planDigest: handle.planDigest,
      contractDigest: handle.contractDigest,
      taskId,
      unitId: handle.unitId,
      unitDigest: handle.unitDigest,
      cacheKey: handle.cacheKey,
      mode: handle.mode,
      relevantRevisionDigest: handle.relevantRevisionDigest,
      handle,
      status: "unknown",
      reason: "current trusted inspection is unavailable",
      error: null,
      currentAdmission: null,
      readOnly: true,
      accepted: false,
      effectAuthorized: false
    };
    try {
      await assertCurrentTrustedBindings(context);
      const admission = await admitCurrentVerification({
        root: context.repositoryRoot,
        unit: taskContext.unit,
        runId: observation.runId,
        epoch: observation.epoch,
        unrelatedHeadDigest: observation.unrelatedHeadDigest
      });
      await assertCurrentTrustedBindings(context);
      const inspected = deepFreeze({
        ...base,
        status: admission.status === "admitted" && admission.cacheEligible === true ? "current" : "hold",
        reason: admission.reason,
        currentAdmission: admissionProjection(admission)
      });
      INSPECTIONS.add(inspected);
      return inspected;
    } catch (error) {
      const inspected = deepFreeze({
        ...base,
        status: error?.status === "UNKNOWN" ? "unknown" : "hold",
        reason: error?.code ?? "current-trusted-inspection-failed",
        error: errorProjection(error)
      });
      INSPECTIONS.add(inspected);
      return inspected;
    }
  }

  async evaluateTask(handle, options = {}) {
    const context = assertConsumer(this);
    const taskContext = assertTaskHandle(handle);
    if (taskContext.consumer !== this) throw new NativeV3VerificationConsumerInputError("verification task handle belongs to another consumer");
    const observation = validateObservation(options, "evaluateTask options");
    const unit = taskContext.unit;
    const task = taskContext.task;
    const startedAt = performance.now();
    try {
      await assertCurrentTrustedBindings(context);
    } catch (error) {
      return finaliseEvaluationFailure(context, taskContext, observation, startedAt, error, error?.code ?? "trusted-source-or-policy-unavailable");
    }

    if (task.verification.mode === "off") {
      try {
        const fullProduced = await runPureLocalValidator({
          root: context.repositoryRoot,
          unit,
          mode: "full",
          runId: observation.runId,
          epoch: observation.epoch,
          unrelatedHeadDigest: observation.unrelatedHeadDigest
        });
        const full = sealVerificationResult({ unit, produced: fullProduced });
        const admission = await admitCurrentVerification({
          root: context.repositoryRoot,
          unit,
          runId: observation.runId,
          epoch: observation.epoch,
          unrelatedHeadDigest: observation.unrelatedHeadDigest
        });
        await assertCurrentTrustedBindings(context);
        const outcome = classifyOff(full, admission);
        const revisionFreeze = outcome.status === "pass"
          ? createRevisionFreezeBinding({
              unit,
              admission,
              revision: {
                sourceRevision: context.source.revision,
                sourceBindingDigest: context.source.digest,
                relevantRevisionDigest: unit.relevantRevisionDigest
              },
              freeze: { phase: "revision-ready", mode: "off" }
            })
          : null;
        return finaliseReceipt(context, {
          schemaVersion: NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION,
          kind: NATIVE_V3_VERIFICATION_RECEIPT_KIND,
          phase: "evaluation",
          mode: "off",
          planId: context.plan.planId,
          planDigest: context.plan.planDigest,
          contractDigest: context.plan.contractDigest,
          runId: observation.runId,
          epoch: observation.epoch,
          unrelatedHeadDigest: observation.unrelatedHeadDigest,
          taskId: taskContext.taskId,
          unitId: unit.unitId,
          unitDigest: unit.unitDigest,
          cacheKey: unit.cacheKey,
          sourceBindingDigest: unit.sourceBinding.digest,
          relevantRevisionDigest: unit.relevantRevisionDigest,
          status: outcome.status,
          reason: outcome.reason,
          error: null,
          full: resultProjection(full),
          shadow: null,
          currentAdmission: admissionProjection(admission),
          carryForward: null,
          revisionFreeze: freezeProjection(revisionFreeze),
          automaticQualification: automaticQualification(),
          timings: { scope: "single-local-trusted-consumer", totalMs: elapsed(startedAt) },
          accepted: false,
          effectAuthorized: false
        });
    } catch (error) {
      return finaliseEvaluationFailure(context, taskContext, observation, startedAt, error);
    }
    }

    let shadowReceipt;
    try {
      shadowReceipt = verifyVerificationShadowRunReceipt(await runVerificationShadowRunV1({
        root: context.repositoryRoot,
        unit,
        store: context.store,
        runId: observation.runId,
        epoch: observation.epoch,
        unrelatedHeadDigest: observation.unrelatedHeadDigest,
        currentRevisionDigest: unit.relevantRevisionDigest,
        carryId: `carry-${digestObject({ taskId: taskContext.taskId, runId: observation.runId, epoch: observation.epoch }).slice(0, 24)}`
      }));
    } catch (error) {
      return finaliseEvaluationFailure(context, taskContext, observation, startedAt, error, error?.code ?? "verification-shadow-run-failed");
    }
    let admission;
    try {
      admission = await admitCurrentVerification({
        root: context.repositoryRoot,
        unit,
        runId: observation.runId,
        epoch: observation.epoch,
        unrelatedHeadDigest: observation.unrelatedHeadDigest
      });
    } catch (error) {
      return finaliseEvaluationFailure(context, taskContext, observation, startedAt, error, "current-admission-failed");
    }
    try {
      await assertCurrentTrustedBindings(context);
    } catch (error) {
      return finaliseEvaluationFailure(context, taskContext, observation, startedAt, error, error?.code ?? "trusted-source-or-policy-unavailable");
    }
    const outcome = classifyShadow(shadowReceipt, admission);
    let carry = null;
    let carryError = null;
    let revisionFreeze = null;
    if (outcome.status === "pass") {
      try {
        carry = await createCarryForwardFromPersistentStore({
          store: context.store,
          root: context.repositoryRoot,
          unit,
          admission,
          currentRevisionDigest: unit.relevantRevisionDigest,
          carryId: shadowReceipt.carryForward?.carryId ?? null,
          runId: observation.runId,
          epoch: observation.epoch,
          unrelatedHeadDigest: observation.unrelatedHeadDigest,
          mode: "shadow"
        });
        const pairedCarry = shadowReceipt.carryForward;
        const carryBindingFields = [
          "carryId",
          "unitDigest",
          "resultDigest",
          "admissionDigest",
          "currentContentDigest",
          "currentRevisionDigest"
        ];
        if (!pairedCarry || shadowReceipt.cacheKey !== carry.cacheKey || carryBindingFields.some((field) => pairedCarry[field] !== carry[field])) {
          throw hold("ENATIVE_V3_VERIFICATION_CARRY_DRIFT", "Shadow carry binding changed between paired run and final freeze");
        }
        await assertCurrentTrustedBindings(context);
        revisionFreeze = createRevisionFreezeBinding({
          unit,
          admission,
          carryForward: carry,
          revision: {
            sourceRevision: context.source.revision,
            sourceBindingDigest: context.source.digest,
            relevantRevisionDigest: unit.relevantRevisionDigest
          },
          freeze: { phase: "revision-ready", mode: "shadow", shadowReceiptDigest: shadowReceipt.receiptDigest }
        });
      } catch (error) {
        carryError = errorProjection(error);
        revisionFreeze = null;
      }
    }
    const finalStatus = carryError === null ? outcome.status : "hold";
    return finaliseReceipt(context, {
      schemaVersion: NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION,
      kind: NATIVE_V3_VERIFICATION_RECEIPT_KIND,
      phase: "evaluation",
      mode: "shadow",
      planId: context.plan.planId,
      planDigest: context.plan.planDigest,
      contractDigest: context.plan.contractDigest,
      runId: observation.runId,
      epoch: observation.epoch,
      unrelatedHeadDigest: observation.unrelatedHeadDigest,
      taskId: taskContext.taskId,
      unitId: unit.unitId,
      unitDigest: unit.unitDigest,
      cacheKey: unit.cacheKey,
      sourceBindingDigest: unit.sourceBinding.digest,
      relevantRevisionDigest: unit.relevantRevisionDigest,
      status: finalStatus,
      reason: carryError === null ? outcome.reason : "persistent-carry-forward-failed-before-freeze",
      error: carryError,
      full: shadowReceipt.full,
      shadow: shadowReceipt,
      currentAdmission: admissionProjection(admission),
      carryForward: carryProjection(carry),
      revisionFreeze: freezeProjection(revisionFreeze),
      automaticQualification: automaticQualification(),
      timings: { scope: "single-local-trusted-consumer", totalMs: elapsed(startedAt) },
      accepted: false,
      effectAuthorized: false
    });
  }

  async bootstrapTask(handle, options = {}) {
    const context = assertConsumer(this);
    const taskContext = assertTaskHandle(handle);
    if (taskContext.consumer !== this) throw new NativeV3VerificationConsumerInputError("verification task handle belongs to another consumer");
    const observation = validateObservation(options, "bootstrapTask options");
    if (taskContext.task.verification.mode !== "shadow") {
      throw new NativeV3VerificationConsumerInputError("bootstrapTask requires a shadow verification declaration");
    }
    const startedAt = performance.now();
    try {
      await assertCurrentTrustedBindings(context);
      const produced = await runPureLocalValidator({
        root: context.repositoryRoot,
        unit: taskContext.unit,
        mode: "shadow",
        runId: observation.runId,
        epoch: observation.epoch,
        unrelatedHeadDigest: observation.unrelatedHeadDigest
      });
      const result = sealVerificationResult({ unit: taskContext.unit, produced });
      const admission = await admitCurrentVerification({
        root: context.repositoryRoot,
        unit: taskContext.unit,
        runId: observation.runId,
        epoch: observation.epoch,
        unrelatedHeadDigest: observation.unrelatedHeadDigest
      });
      await assertCurrentTrustedBindings(context);
      if (result.status !== "pass" || admission.status !== "admitted" || admission.cacheEligible !== true ||
          result.observedContentDigest !== admission.currentContentDigest ||
          result.observedManifestDigest !== admission.currentManifestDigest) {
        return finaliseReceipt(context, {
        schemaVersion: NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION,
        kind: NATIVE_V3_VERIFICATION_BOOTSTRAP_KIND,
        phase: "bootstrap",
        mode: "shadow",
        planId: context.plan.planId,
        planDigest: context.plan.planDigest,
        contractDigest: context.plan.contractDigest,
        runId: observation.runId,
        epoch: observation.epoch,
        unrelatedHeadDigest: observation.unrelatedHeadDigest,
        taskId: taskContext.taskId,
        unitId: taskContext.unit.unitId,
        unitDigest: taskContext.unit.unitDigest,
        cacheKey: taskContext.unit.cacheKey,
        sourceBindingDigest: taskContext.unit.sourceBinding.digest,
        relevantRevisionDigest: taskContext.unit.relevantRevisionDigest,
        status: result.status === "unknown" || admission.status !== "admitted" ? "hold" : "fail",
        reason: "bootstrap-candidate-not-cache-eligible",
        error: null,
        candidate: resultProjection(result),
        currentAdmission: admissionProjection(admission),
        store: null,
        automaticQualification: automaticQualification(),
        timings: { scope: "single-local-trusted-consumer", totalMs: elapsed(startedAt) },
        accepted: false,
        effectAuthorized: false
        });
      }
      const written = await context.store.put({
        root: context.repositoryRoot,
        unit: taskContext.unit,
        result,
        admission,
        runId: observation.runId,
        epoch: observation.epoch,
        unrelatedHeadDigest: observation.unrelatedHeadDigest
      });
      await assertCurrentTrustedBindings(context);
      return finaliseReceipt(context, {
      schemaVersion: NATIVE_V3_VERIFICATION_RECEIPT_SCHEMA_VERSION,
      kind: NATIVE_V3_VERIFICATION_BOOTSTRAP_KIND,
      phase: "bootstrap",
      mode: "shadow",
      planId: context.plan.planId,
      planDigest: context.plan.planDigest,
      contractDigest: context.plan.contractDigest,
      runId: observation.runId,
      epoch: observation.epoch,
      unrelatedHeadDigest: observation.unrelatedHeadDigest,
      taskId: taskContext.taskId,
      unitId: taskContext.unit.unitId,
      unitDigest: taskContext.unit.unitDigest,
      cacheKey: taskContext.unit.cacheKey,
      sourceBindingDigest: taskContext.unit.sourceBinding.digest,
      relevantRevisionDigest: taskContext.unit.relevantRevisionDigest,
      status: "bootstrap",
      reason: "trusted-shadow-candidate-stored-without-hit",
      error: null,
      candidate: resultProjection(result),
      currentAdmission: admissionProjection(admission),
      store: {
        status: written.status,
        recordDigest: written.recordDigest,
        path: typeof written.path === "string" ? relativeArtifactPath(context.stateRoot, written.path) : null,
        cacheHit: false
      },
      automaticQualification: automaticQualification(),
      timings: { scope: "single-local-trusted-consumer", totalMs: elapsed(startedAt) },
      accepted: false,
      effectAuthorized: false
      });
    } catch (error) {
      return finaliseBootstrapFailure(context, taskContext, observation, startedAt, error);
    }
  }
}

// The instance is frozen by the factory below, while the prototype is frozen
// here so a caller cannot replace evaluate/prepare/inspect after receiving a
// genuine consumer and thereby replay an old branded receipt.
Object.freeze(NativeV3VerificationConsumerV1.prototype);

export class NativeV3VerificationConsumerInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "NativeV3VerificationConsumerInputError";
    this.code = "ENATIVE_V3_VERIFICATION_INPUT";
  }
}

export class NativeV3VerificationConsumerHoldError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NativeV3VerificationConsumerHoldError";
    this.code = code;
    this.status = "HOLD";
  }
}

export function isNativeV3VerificationConsumer(value) {
  return Boolean(value && CONSUMERS.has(value) && CONSUMER_CONTEXTS.has(value));
}

/**
 * Return the process-owned method seam for a genuine consumer.
 *
 * The returned bound methods are captured before the consumer is exposed and
 * are immutable.  Callers cannot replace an instance or prototype method and
 * make a caller-supplied evaluation look like a trusted receipt.
 */
export function getNativeV3VerificationConsumerApi(value) {
  if (!isNativeV3VerificationConsumer(value) || !CONSUMER_APIS.has(value)) {
    throw new NativeV3VerificationConsumerInputError("verification consumer must come from the trusted producer");
  }
  return CONSUMER_APIS.get(value);
}

export function isNativeV3VerificationTaskHandle(value) {
  return Boolean(value && TASK_HANDLES.has(value) && TASK_CONTEXTS.has(value));
}

export function isNativeV3VerificationInspection(value) {
  return Boolean(value && INSPECTIONS.has(value));
}

export async function createNativeV3VerificationConsumer(options = {}) {
  exactKeys(options, ALLOWED_CONSUMER_KEYS, "createNativeV3VerificationConsumer options");
  const plan = validateWorkflowPlanV1(options.plan);
  const requestedRepositoryRoot = canonicalAbsolutePath(options.repositoryRoot, "repositoryRoot");
  let repositoryRoot;
  try {
    repositoryRoot = await realpath(requestedRepositoryRoot);
  } catch (error) {
    throw new NativeV3VerificationConsumerInputError(`repositoryRoot cannot be resolved: ${error.code ?? "realpath-failed"}`);
  }
  const requestedStateRoot = canonicalAbsolutePath(options.stateRoot, "stateRoot");
  let stateInfo = null;
  try {
    stateInfo = await lstat(requestedStateRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new NativeV3VerificationConsumerInputError(`stateRoot cannot be inspected: ${error.code ?? "lstat-failed"}`);
    }
  }
  if (stateInfo?.isSymbolicLink?.()) {
    throw new NativeV3VerificationConsumerInputError("stateRoot must not be a symlink");
  }
  if (stateInfo !== null && !stateInfo.isDirectory()) {
    throw new NativeV3VerificationConsumerInputError("stateRoot must be a directory");
  }
  let stateRoot;
  try {
    stateRoot = await realpath(requestedStateRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new NativeV3VerificationConsumerInputError(`stateRoot cannot be resolved: ${error.code ?? "realpath-failed"}`);
    }
    // The state root may be created by the first receipt write. Resolve the
    // nearest existing ancestor so a missing leaf below a symlink alias
    // cannot bypass repository separation below.
    try {
      stateRoot = await resolveStateRootWithMissingLeaf(requestedStateRoot);
    } catch (resolveError) {
      throw new NativeV3VerificationConsumerInputError(`stateRoot cannot be resolved: ${resolveError.code ?? "realpath-failed"}`);
    }
  }
  if (repositoryRoot === stateRoot || sourceInsideRepository(repositoryRoot, stateRoot)) {
    throw new NativeV3VerificationConsumerInputError("stateRoot must be separate from and outside repositoryRoot");
  }
  const source = await trustedSourceBinding(repositoryRoot, plan.taskContract.bindings.source);
  const policy = await trustedPolicy(plan.taskContract.bindings.policy.digest);
  const tasks = new Map(plan.taskContract.graph.tasks.map((task) => [task.id, task]));
  const consumer = new NativeV3VerificationConsumerV1();
  CONSUMERS.add(consumer);
  CONSUMER_CONTEXTS.set(consumer, {
    consumer,
    plan,
    repositoryRoot,
    stateRoot,
    source,
    policy,
    tasks,
    prepared: new Map(),
    store: createVerificationResultStore({ directory: sourceLineageStoreDirectory(stateRoot, source) })
  });
  CONSUMER_APIS.set(consumer, Object.freeze({
    prepareTask: consumer.prepareTask.bind(consumer),
    inspectTask: consumer.inspectTask.bind(consumer),
    evaluateTask: consumer.evaluateTask.bind(consumer),
    bootstrapTask: consumer.bootstrapTask.bind(consumer)
  }));
  return Object.freeze(consumer);
}
