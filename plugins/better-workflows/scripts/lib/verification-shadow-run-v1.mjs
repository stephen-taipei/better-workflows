import { performance } from "node:perf_hooks";

import { digestObject } from "./core.mjs";
import {
  admitCurrentVerification,
  compareDependencyManifests,
  compareFullShadow,
  captureDependencyManifest,
  createCarryForwardFromPersistentStore,
  PURE_LOCAL_TOOL_BINARY,
  PURE_LOCAL_VALIDATOR,
  runPureLocalValidator,
  sealVerificationResult
} from "./verification-incremental-v1.mjs";
import {
  isAuthenticatedVerificationResultStoreLoad,
  isGenuineVerificationResultStore,
  loadAuthenticatedVerificationResult
} from "./verification-result-store-v1.mjs";

export const VERIFICATION_SHADOW_RUN_SCHEMA_VERSION = 1;
export const VERIFICATION_SHADOW_RUN_KIND = "VerificationShadowRunReceiptV1";
export const VERIFICATION_SHADOW_RUN_DECISION = "shadow-only";

const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_ERROR_MESSAGE_LENGTH = 512;

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(`${label} must be a sha256 digest`);
  return value;
}

function assertSafeId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

async function assertTrustedUnitForRevision(unit) {
  // runPureLocalValidator checks the module-private unit brand before it
  // checks mode or touches root. The deliberately invalid mode is a pure
  // brand probe, so a caller-shaped unit cannot establish this binding.
  try {
    await runPureLocalValidator({ root: null, unit, mode: "__trusted-unit-probe__" });
  } catch (error) {
    if (error instanceof Error && error.message === "validator mode must be full or shadow") return unit;
    throw error;
  }
  fail("trusted unit probe unexpectedly ran");
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

function captureOptions(root, unit, { runId, epoch, unrelatedHeadDigest } = {}) {
  return {
    root,
    dependencies: unit.dependencies,
    validator: PURE_LOCAL_VALIDATOR,
    toolBinary: PURE_LOCAL_TOOL_BINARY,
    config: unit.config,
    controlledEnvironment: unit.controlledEnvironment,
    policy: unit.policy,
    sourceBinding: unit.sourceBinding,
    relevantRevisionDigest: unit.relevantRevisionDigest,
    unrelatedHeadDigest: unrelatedHeadDigest ?? null,
    runId: runId ?? null,
    epoch: epoch ?? null
  };
}

function projection(result) {
  if (result === null || result === undefined) return null;
  return {
    resultDigest: result.resultDigest,
    unitDigest: result.unitDigest,
    cacheKey: result.cacheKey,
    mode: result.mode,
    status: result.status,
    outcome: result.outcome,
    reason: result.reason,
    observedContentDigest: result.observedContentDigest,
    observedManifestDigest: result.observedManifestDigest,
    unknowns: result.unknowns,
    findings: result.findings
  };
}

function admissionProjection(admission) {
  if (admission === null || admission === undefined) return null;
  return {
    admissionDigest: admission.admissionDigest,
    unitDigest: admission.unitDigest,
    cacheKey: admission.cacheKey,
    currentContentDigest: admission.currentContentDigest,
    currentManifestDigest: admission.currentManifestDigest,
    status: admission.status,
    disposition: admission.disposition,
    reason: admission.reason,
    cacheEligible: admission.cacheEligible,
    sourceBindingDigest: admission.sourceBindingDigest,
    relevantRevisionDigest: admission.relevantRevisionDigest
  };
}

function shadowLoadProjection(loaded) {
  if (loaded === null || loaded === undefined) return null;
  return {
    reason: loaded.reason,
    hit: loaded.hit === true,
    cacheHit: loaded.cacheHit === true,
    revalidated: loaded.revalidated === true,
    recordDigest: loaded.recordDigest ?? null,
    authenticated: isAuthenticatedVerificationResultStoreLoad(loaded),
    resultDigest: loaded.result?.resultDigest ?? null,
    resultObservedContentDigest: loaded.result?.observedContentDigest ?? null,
    resultObservedManifestDigest: loaded.result?.observedManifestDigest ?? null,
    admissionDigest: loaded.admission?.admissionDigest ?? null,
    admissionCurrentContentDigest: loaded.admission?.currentContentDigest ?? null,
    admissionCurrentManifestDigest: loaded.admission?.currentManifestDigest ?? null
  };
}

function carryProjection(carry) {
  if (carry === null || carry === undefined) return null;
  return {
    carryDigest: carry.carryDigest,
    carryId: carry.carryId,
    unitDigest: carry.unitDigest,
    resultDigest: carry.resultDigest,
    admissionDigest: carry.admissionDigest,
    currentContentDigest: carry.currentContentDigest,
    currentRevisionDigest: carry.currentRevisionDigest,
    freshnessContentDigest: carry.freshness?.contentDigest ?? null,
    freshnessManifestDigest: carry.freshness?.manifestDigest ?? null,
    freshness: carry.freshness,
    accepted: carry.accepted === true,
    effectAuthorized: carry.effectAuthorized === true
  };
}

function bindingObservation(phase, contentDigest, manifestDigest, role = "current") {
  return {
    phase,
    role,
    contentDigest: contentDigest ?? null,
    manifestDigest: manifestDigest ?? null
  };
}

function bindingObservationIssues(observations, { baselineContentDigest, currentManifestDigest }) {
  const issues = [];
  for (const observation of observations) {
    const contentKnown = typeof observation.contentDigest === "string" && DIGEST.test(observation.contentDigest);
    const manifestKnown = typeof observation.manifestDigest === "string" && DIGEST.test(observation.manifestDigest);
    if (!contentKnown || !manifestKnown) {
      issues.push({
        kind: "observation-unknown",
        phase: observation.phase,
        role: observation.role,
        reason: "missing-or-invalid-binding",
        observedContentDigest: contentKnown ? observation.contentDigest : null,
        observedManifestDigest: manifestKnown ? observation.manifestDigest : null
      });
      continue;
    }
    if (observation.contentDigest !== baselineContentDigest) {
      issues.push({
        kind: "content-drift",
        phase: observation.phase,
        role: observation.role,
        expectedContentDigest: baselineContentDigest,
        observedContentDigest: observation.contentDigest
      });
    }
    // Current captures carry the same run/epoch observation binding. A
    // persisted shadow result is historical and is checked by its store MAC;
    // its manifest digest therefore must not be compared to this run's
    // observation metadata.
    if (observation.role === "current" && observation.manifestDigest !== currentManifestDigest) {
      issues.push({
        kind: "manifest-drift",
        phase: observation.phase,
        role: observation.role,
        expectedManifestDigest: currentManifestDigest,
        observedManifestDigest: observation.manifestDigest
      });
    }
  }
  return issues;
}

function operationError(error, operation) {
  const rawMessage = error instanceof Error ? error.message : String(error ?? operation);
  return {
    kind: "VerificationShadowRunOperationalErrorV1",
    operation,
    code: typeof error?.code === "string" && SAFE_ERROR_CODE.test(error.code) ? error.code : null,
    message: (rawMessage || operation).slice(0, MAX_ERROR_MESSAGE_LENGTH)
  };
}

function assertErrorProjection(value, label) {
  if (value === null || value === undefined) return null;
  assertObject(value, label);
  if (value.kind !== "VerificationShadowRunOperationalErrorV1") fail(`${label}.kind is invalid`);
  if (typeof value.operation !== "string" || value.operation.length === 0) fail(`${label}.operation is invalid`);
  if (value.code !== null && value.code !== undefined && (typeof value.code !== "string" || !SAFE_ERROR_CODE.test(value.code))) {
    fail(`${label}.code is invalid`);
  }
  if (typeof value.message !== "string" || value.message.length === 0 || value.message.length > MAX_ERROR_MESSAGE_LENGTH) {
    fail(`${label}.message is invalid`);
  }
  return value;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function dependencyDelta(unit, currentManifest, comparison) {
  const baselineConfigDigest = digestObject(unit.config);
  const currentConfigDigest = digestObject(currentManifest.config);
  const baselinePolicyDigest = digestObject(unit.policy);
  const currentPolicyDigest = digestObject(currentManifest.policy);
  const changes = comparison.changes.map((change) => ({ ...change }));
  const changeKinds = uniqueSorted(changes.map((change) => change.kind));
  const configPaths = new Set(unit.config.checks.map((check) => check.path));
  const configInputChanged = changes.some((change) =>
    (change.path !== undefined && configPaths.has(change.path)) ||
    (change.from !== undefined && configPaths.has(change.from)) ||
    (change.to !== undefined && configPaths.has(change.to))
  );
  const configDescriptorChanged = baselineConfigDigest !== currentConfigDigest;
  const policyChanged = baselinePolicyDigest !== currentPolicyDigest;
  return {
    kind: comparison.kind,
    digest: comparison.digest,
    baselineContentDigest: comparison.beforeContentDigest,
    currentContentDigest: comparison.afterContentDigest,
    currentManifestDigest: currentManifest.manifestDigest,
    changed: comparison.changed || configDescriptorChanged || policyChanged,
    changeKinds,
    changes,
    missing: {
      baseline: unit.baselineFingerprint.missing,
      current: currentManifest.missing
    },
    unknowns: currentManifest.unknowns,
    config: {
      baselineDigest: baselineConfigDigest,
      currentDigest: currentConfigDigest,
      descriptorChanged: configDescriptorChanged,
      inputChanged: configInputChanged,
      changed: configDescriptorChanged || configInputChanged
    },
    policy: {
      baselineDigest: baselinePolicyDigest,
      currentDigest: currentPolicyDigest,
      changed: policyChanged
    }
  };
}

function requiredCaseProjection(delta) {
  return {
    changed: delta.changed,
    missing: delta.missing,
    rename: delta.changes.filter((change) => change.kind === "rename"),
    config: delta.config,
    policy: delta.policy
  };
}

function classify({ full, admission, loaded, comparison, carry, observationIssues = [], shadowLoadError = null, carryForwardError = null }) {
  if (full.status === "unknown" || admission.status === "hold") {
    return { status: "unknown", reason: "full-or-admission-unknown" };
  }
  if (full.status !== "pass" || admission.status !== "admitted") {
    return { status: "fail", reason: "full-recompute-or-admission-failed" };
  }
  if (observationIssues.length > 0) {
    return { status: "unknown", reason: "observed-dependency-binding-drift" };
  }
  if (shadowLoadError !== null) {
    return { status: "hold", reason: "persistent-shadow-load-error" };
  }
  if (!loaded || loaded.hit !== true || loaded.cacheHit !== true || !isAuthenticatedVerificationResultStoreLoad(loaded)) {
    return { status: "hold", reason: "persistent-shadow-candidate-not-cache-hit" };
  }
  if (comparison.equivalent !== true) {
    return { status: "fail", reason: "full-shadow-results-differ" };
  }
  if (carryForwardError !== null) {
    return { status: "hold", reason: "persistent-carry-forward-error" };
  }
  if (!carry || carry.accepted !== true) {
    return { status: "hold", reason: "persistent-carry-forward-not-accepted" };
  }
  return { status: "pass", reason: "full-shadow-equivalent-with-fresh-carry" };
}

function assertReceiptShape(receipt) {
  assertObject(receipt, "VerificationShadowRunReceiptV1");
  if (receipt.schemaVersion !== VERIFICATION_SHADOW_RUN_SCHEMA_VERSION || receipt.kind !== VERIFICATION_SHADOW_RUN_KIND) {
    fail("VerificationShadowRunReceiptV1 kind/version is invalid");
  }
  assertDigest(receipt.unitDigest, "receipt.unitDigest");
  assertDigest(receipt.cacheKey, "receipt.cacheKey");
  assertDigest(receipt.baselineContentDigest, "receipt.baselineContentDigest");
  assertDigest(receipt.baselineManifestDigest, "receipt.baselineManifestDigest");
  assertDigest(receipt.currentContentDigest, "receipt.currentContentDigest");
  assertDigest(receipt.currentManifestDigest, "receipt.currentManifestDigest");
  if (!["pass", "fail", "hold", "unknown"].includes(receipt.status)) fail("receipt.status is invalid");
  if (!receipt.full || receipt.full.mode !== "full" || (receipt.shadow !== null && receipt.shadow?.mode !== "shadow")) {
    fail("receipt result modes are invalid");
  }
  if (!Array.isArray(receipt.phaseObservations) || receipt.phaseObservations.length === 0) fail("receipt.phaseObservations is invalid");
  for (const [index, observation] of receipt.phaseObservations.entries()) {
    assertObject(observation, `receipt.phaseObservations[${index}]`);
    if (typeof observation.phase !== "string" || observation.phase.length === 0) fail(`receipt.phaseObservations[${index}].phase is invalid`);
    if (observation.role !== "current" && observation.role !== "historical") fail(`receipt.phaseObservations[${index}].role is invalid`);
    if (observation.contentDigest !== null) assertDigest(observation.contentDigest, `receipt.phaseObservations[${index}].contentDigest`);
    if (observation.manifestDigest !== null) assertDigest(observation.manifestDigest, `receipt.phaseObservations[${index}].manifestDigest`);
  }
  if (!Array.isArray(receipt.observationIssues)) fail("receipt.observationIssues is invalid");
  for (const [index, issue] of receipt.observationIssues.entries()) {
    assertObject(issue, `receipt.observationIssues[${index}]`);
    if (typeof issue.kind !== "string" || issue.kind.length === 0) fail(`receipt.observationIssues[${index}].kind is invalid`);
    if (typeof issue.phase !== "string" || issue.phase.length === 0) fail(`receipt.observationIssues[${index}].phase is invalid`);
    if (issue.role !== "current" && issue.role !== "historical") fail(`receipt.observationIssues[${index}].role is invalid`);
    for (const field of ["expectedContentDigest", "observedContentDigest", "expectedManifestDigest", "observedManifestDigest"]) {
      if (issue[field] !== undefined && issue[field] !== null) assertDigest(issue[field], `receipt.observationIssues[${index}].${field}`);
    }
  }
  assertErrorProjection(receipt.shadowLoadError, "receipt.shadowLoadError");
  assertErrorProjection(receipt.carryForwardError, "receipt.carryForwardError");
  if (!Number.isFinite(receipt.timings.fullComputeMs) || receipt.timings.fullComputeMs < 0) fail("receipt full compute timing is invalid");
  if (!Number.isFinite(receipt.timings.fullAdmissionMs) || receipt.timings.fullAdmissionMs < 0) fail("receipt full admission timing is invalid");
  if (!Number.isFinite(receipt.timings.shadowLoadMs) || receipt.timings.shadowLoadMs < 0) fail("receipt shadow load timing is invalid");
  if (!Number.isFinite(receipt.timings.shadowCarryMs) || receipt.timings.shadowCarryMs < 0) fail("receipt shadow carry timing is invalid");
  if (receipt.accepted !== false || receipt.effectAuthorized !== false || receipt.mode !== "off") {
    fail("VerificationShadowRunReceiptV1 cannot authorize or activate automatic reuse");
  }
  return receipt;
}

export async function runVerificationShadowRunV1({
  root,
  unit,
  store,
  runId = null,
  epoch = null,
  unrelatedHeadDigest = null,
  currentRevisionDigest = null,
  carryId = null
} = {}) {
  if (!isGenuineVerificationResultStore(store)) {
    fail("VerificationShadowRunV1 requires a genuine module-created VerificationResultStoreV1 instance");
  }
  if (runId !== null && runId !== undefined) assertSafeId(runId, "runId");
  if (epoch !== null && epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 0)) {
    fail("epoch must be a non-negative safe integer");
  }
  if (currentRevisionDigest !== null && currentRevisionDigest !== undefined) {
    assertDigest(currentRevisionDigest, "currentRevisionDigest");
  }
  if (carryId !== null && carryId !== undefined) assertSafeId(carryId, "carryId");
  await assertTrustedUnitForRevision(unit);
  if (
    currentRevisionDigest !== null &&
    currentRevisionDigest !== undefined &&
    currentRevisionDigest !== (unit.relevantRevisionDigest ?? null)
  ) {
    fail("currentRevisionDigest must match the trusted unit relevantRevisionDigest");
  }

  const totalStartedAt = performance.now();
  const fullStartedAt = performance.now();
  const fullProduced = await runPureLocalValidator({
    root,
    unit,
    mode: "full",
    runId,
    epoch,
    unrelatedHeadDigest
  });
  const fullComputeMs = elapsed(fullStartedAt);
  const full = sealVerificationResult({ unit, produced: fullProduced });

  const admissionStartedAt = performance.now();
  const admission = await admitCurrentVerification({ root, unit, runId, epoch, unrelatedHeadDigest });
  const fullAdmissionMs = elapsed(admissionStartedAt);

  const fingerprintStartedAt = performance.now();
  const currentManifest = await captureDependencyManifest(captureOptions(root, unit, { runId, epoch, unrelatedHeadDigest }));
  const fingerprintCaptureMs = elapsed(fingerprintStartedAt);
  const comparison = compareDependencyManifests(unit.baselineFingerprint, currentManifest);
  const delta = dependencyDelta(unit, currentManifest, comparison);

  let loaded = null;
  let carry = null;
  let shadowLoadMs = 0;
  let shadowCarryMs = 0;
  let shadowLoadError = null;
  let carryForwardError = null;
  if (admission.status === "admitted" && admission.cacheEligible === true) {
    const shadowLoadStartedAt = performance.now();
    try {
      loaded = await loadAuthenticatedVerificationResult({
        store,
        root,
        unit,
        mode: "shadow",
        runId,
        epoch,
        unrelatedHeadDigest
      });
    } catch (error) {
      shadowLoadError = operationError(error, "shadow-load");
    } finally {
      shadowLoadMs = elapsed(shadowLoadStartedAt);
    }
    if (shadowLoadError === null && loaded.hit === true && loaded.cacheHit === true && isAuthenticatedVerificationResultStoreLoad(loaded)) {
      const shadowCarryStartedAt = performance.now();
      try {
        carry = await createCarryForwardFromPersistentStore({
          store,
          root,
          unit,
          admission,
          currentRevisionDigest: currentRevisionDigest ?? unit.relevantRevisionDigest,
          carryId,
          runId,
          epoch,
          unrelatedHeadDigest,
          mode: "shadow"
        });
      } catch (error) {
        carryForwardError = operationError(error, "shadow-carry");
      } finally {
        shadowCarryMs = elapsed(shadowCarryStartedAt);
      }
    }
  }

  const shadow = loaded?.hit === true && loaded?.cacheHit === true && isAuthenticatedVerificationResultStoreLoad(loaded) && loaded?.result
    ? loaded.result
    : null;
  const comparisonResult = shadow === null
    ? null
    : compareFullShadow({ full, shadow });
  const phaseObservations = [
    bindingObservation("full", full.observedContentDigest, full.observedManifestDigest),
    bindingObservation("admission", admission.currentContentDigest, admission.currentManifestDigest),
    bindingObservation("current-manifest", currentManifest.contentDigest, currentManifest.manifestDigest)
  ];
  if (loaded?.result) {
    phaseObservations.push(bindingObservation("shadow-load-result", loaded.result.observedContentDigest, loaded.result.observedManifestDigest, "historical"));
  }
  if (loaded?.admission) {
    phaseObservations.push(bindingObservation("shadow-load-admission", loaded.admission.currentContentDigest, loaded.admission.currentManifestDigest));
  }
  if (carry) {
    phaseObservations.push(bindingObservation("shadow-carry", carry.freshness?.contentDigest ?? carry.currentContentDigest, carry.freshness?.manifestDigest ?? null));
  }
  const observationIssues = bindingObservationIssues(phaseObservations, {
    baselineContentDigest: unit.baselineContentDigest,
    currentManifestDigest: currentManifest.manifestDigest
  });
  const outcome = classify({
    full,
    admission,
    loaded,
    comparison: comparisonResult ?? { equivalent: false },
    carry,
    observationIssues,
    shadowLoadError,
    carryForwardError
  });
  const unknowns = [
    ...full.unknowns,
    ...currentManifest.unknowns,
    ...(admission.status === "hold" ? [{ reason: admission.reason }] : []),
    ...(loaded !== null && loaded.cacheHit !== true ? [{ reason: "persistent-shadow-candidate-not-cache-hit" }] : []),
    ...observationIssues.map((issue) => ({
      reason: issue.kind,
      phase: issue.phase,
      role: issue.role,
      expectedContentDigest: issue.expectedContentDigest ?? null,
      observedContentDigest: issue.observedContentDigest ?? null,
      expectedManifestDigest: issue.expectedManifestDigest ?? null,
      observedManifestDigest: issue.observedManifestDigest ?? null
    })),
    ...(shadowLoadError === null ? [] : [{ reason: "persistent-shadow-load-error", operation: shadowLoadError.operation, message: shadowLoadError.message }]),
    ...(carryForwardError === null ? [] : [{ reason: "persistent-carry-forward-error", operation: carryForwardError.operation, message: carryForwardError.message }])
  ];
  const core = {
    schemaVersion: VERIFICATION_SHADOW_RUN_SCHEMA_VERSION,
    kind: VERIFICATION_SHADOW_RUN_KIND,
    decision: VERIFICATION_SHADOW_RUN_DECISION,
    mode: "off",
    status: outcome.status,
    reason: outcome.reason,
    runId: runId ?? null,
    epoch: epoch ?? null,
    unrelatedHeadDigest: unrelatedHeadDigest ?? null,
    unitDigest: unit.unitDigest,
    cacheKey: unit.cacheKey,
    baselineContentDigest: unit.baselineContentDigest,
    baselineManifestDigest: unit.baselineManifestDigest,
    currentContentDigest: currentManifest.contentDigest,
    currentManifestDigest: currentManifest.manifestDigest,
    relevantRevisionDigest: unit.relevantRevisionDigest,
    full: projection(full),
    shadow: projection(shadow),
    currentAdmission: admissionProjection(admission),
    shadowLoad: shadowLoadProjection(loaded),
    shadowLoadError,
    carryForward: carryProjection(carry),
    carryForwardError,
    phaseObservations,
    observationIssues,
    comparison: comparisonResult === null ? null : {
      kind: comparisonResult.kind,
      digest: comparisonResult.digest,
      fullResultDigest: comparisonResult.fullResultDigest,
      shadowResultDigest: comparisonResult.shadowResultDigest,
      equivalent: comparisonResult.equivalent,
      status: comparisonResult.status,
      decision: comparisonResult.decision,
      accepted: comparisonResult.accepted,
      effectAuthorized: comparisonResult.effectAuthorized
    },
    dependencyDelta: delta,
    requiredCases: requiredCaseProjection(delta),
    inputBinding: {
      configDigest: digestObject(unit.config),
      policyDigest: digestObject(unit.policy),
      controlledEnvironmentDigest: digestObject(unit.controlledEnvironment),
      sourceBindingDigest: unit.sourceBinding.digest,
      validatorDigest: unit.validator.digest,
      toolBinaryDigest: unit.toolBinary.digest
    },
    timings: {
      scope: "single-local-fixture-run",
      fullComputeMs,
      fullAdmissionMs,
      fingerprintCaptureMs,
      shadowLoadMs,
      shadowCarryMs,
      totalMs: elapsed(totalStartedAt)
    },
    unknowns,
    automaticQualification: {
      mode: "off",
      candidateEligible: false,
      accepted: false,
      reason: "paired-harness-is-observe-only",
      ci95LowerBound: null
    },
    accepted: false,
    effectAuthorized: false
  };
  const receipt = { ...core, receiptDigest: digestObject(core) };
  return deepFreeze(assertReceiptShape(receipt));
}

export function verifyVerificationShadowRunReceipt(receipt) {
  // This verifies only the receipt's internal digest consistency. It does not
  // authenticate the producer or grant authority to any decision label.
  const verified = assertReceiptShape(receipt);
  const withoutDigest = { ...verified };
  delete withoutDigest.receiptDigest;
  assertDigest(verified.receiptDigest, "receipt.receiptDigest");
  if (digestObject(withoutDigest) !== verified.receiptDigest) fail("receipt.receiptDigest does not match its contents");
  return verified;
}
