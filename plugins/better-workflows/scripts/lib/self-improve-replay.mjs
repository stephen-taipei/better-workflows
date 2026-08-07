import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  digestObject,
  listJsonRecords,
  safeJoin,
  sha256
} from "./core.mjs";
import { captureSourceBinding } from "./git.mjs";
import {
  verifyTrustedCodexExecutionEnvelope
} from "./providers.mjs";
import {
  buildEvaluationPrompt,
  calibrateEvaluatorMigration,
  compareEvaluatorMigration,
  compareHoldout,
  compareQualityRemediation,
  compareSafetyRemediation,
  evaluationBindingDigest,
  loadFrozenEvaluationSuite,
  loadMigrationTargetSuite,
  loadPolicyBoundEvaluationPolicy,
  isPolicyBoundEvaluationPurpose,
  readSanitizedBaselineMaterial,
  readSanitizedCandidateMaterial,
  scoreEvaluation,
  selectEvaluationCases,
  selectQualityRemediationCases,
  selectSafetyRemediationCases,
  snapshotBaselineForCandidate,
  snapshotCandidate
} from "./self-improve.mjs";
import { pluginBundleDigest } from "./routing.mjs";

const HOST_EXECUTIONS_ROOT = "/private/var/db/better-workflows/executions";
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXPECTED_REPLAYS = new Set([
  "train-candidate:1",
  "candidate:1",
  "candidate:2",
  "candidate:3",
  "baseline:1",
  "baseline:2",
  "baseline:3"
]);

function isPathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requestRunAs(request) {
  return {
    uid: request.uid,
    gid: request.gid,
    homePath: request.homePath,
    codexHomePath: request.codexHomePath
  };
}

function validRunAs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== "codexHomePath\0gid\0homePath\0uid" ||
      !Number.isInteger(value.uid) || value.uid <= 0 || !Number.isInteger(value.gid) || value.gid <= 0) return false;
  for (const [key, nullable] of [["homePath", false], ["codexHomePath", true]]) {
    if (nullable && value[key] === null) continue;
    if (typeof value[key] !== "string" || !path.isAbsolute(value[key]) || path.resolve(value[key]) !== value[key]) return false;
  }
  return true;
}

export async function loadHostExecutionRequestManifest({
  manifestPath,
  manifestDigest,
  cwd,
  runId,
  candidate,
  frozen,
  suiteDigest,
  purpose,
  target,
  model
}) {
  if (typeof manifestPath !== "string" || typeof manifestDigest !== "string" || !SHA256.test(manifestDigest)) {
    throw new Error("Codex evaluation requires --request-manifest and --request-manifest-digest");
  }
  const repository = await realpath(cwd);
  const policyBound = isPolicyBoundEvaluationPurpose(purpose);
  const policy = policyBound ? await loadPolicyBoundEvaluationPolicy({ cwd: repository, purpose }) : null;
  const expectedManifestSchema = policyBound ? 3 : 2;
  const resolvedManifest = path.resolve(manifestPath);
  if (isPathWithin(repository, resolvedManifest)) throw new Error("Execution request manifest must be outside the evaluated repository");
  const manifestInfo = await lstat(resolvedManifest);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile() || path.resolve(await realpath(resolvedManifest)) !== resolvedManifest) {
    throw new Error("Execution request manifest must be a canonical regular file");
  }
  const manifestBytes = await readFile(resolvedManifest);
  if (sha256(manifestBytes) !== manifestDigest) throw new Error("Execution request manifest digest does not match the confirmed manifest");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== expectedManifestSchema || manifest.repo !== repository || manifest.runId !== runId || manifest.model !== model ||
      manifest.purpose !== purpose || manifest.suiteDigest !== suiteDigest || manifest.baselineRevision !== frozen.baselineRevision ||
      manifest.candidateDigest !== candidate.digest || manifest.sourceSuiteDigest !== frozen.sourceDigest ||
      manifest.targetSuiteDigest !== (target?.sourceDigest ?? null) || typeof manifest.binaryPath !== "string" ||
      !path.isAbsolute(manifest.binaryPath) || !SHA256.test(manifest.binaryApprovalDigest) || !SHA256.test(manifest.binaryDigest) ||
      !SHA1.test(manifest.headRevision) || !SHA256.test(manifest.sourceBindingDigest) || !SHA256.test(manifest.pluginBundleDigest) ||
      typeof manifest.runtimePath !== "string" || !path.isAbsolute(manifest.runtimePath) || !SHA256.test(manifest.runtimeDigest) ||
      !Array.isArray(manifest.candidateFiles) || digestObject(manifest.candidateFiles) !== digestObject(candidate.files) ||
      manifest.policyPath !== (policy?.path ?? undefined) || manifest.policyId !== (policy?.policyId ?? undefined) ||
      manifest.policyVersion !== (policy?.version ?? undefined) || manifest.policyDigest !== (policy?.digest ?? undefined) ||
      !Array.isArray(manifest.requests) || manifest.requests.length !== 7 || !validRunAs(manifest.runAs)) {
    throw new Error("Execution request manifest is not bound to this run, suite, model, and candidate");
  }
  const currentSourceBinding = await captureSourceBinding(repository, { baseRevision: frozen.baselineRevision, requireClean: true });
  if (!currentSourceBinding || currentSourceBinding.headRevision !== manifest.headRevision || currentSourceBinding.digest !== manifest.sourceBindingDigest) {
    throw new Error("Execution request manifest source binding is stale");
  }
  if (await pluginBundleDigest() !== manifest.pluginBundleDigest) {
    throw new Error("Execution request manifest plugin bundle digest changed");
  }
  const completeJournal = path.join(HOST_EXECUTIONS_ROOT, `${manifestDigest}.batch.complete.json`);
  const journalInfo = await lstat(completeJournal);
  if (journalInfo.isSymbolicLink() || !journalInfo.isFile() || journalInfo.uid !== 0 || (journalInfo.mode & 0o777) !== 0o644 ||
      path.resolve(await realpath(completeJournal)) !== completeJournal) {
    throw new Error("Execution request manifest has no root-owned completed host batch journal");
  }
  const journal = JSON.parse((await readFile(completeJournal)).toString("utf8"));
  if (journal.schemaVersion !== 1 || journal.provider !== "codex" || journal.kind !== "execution-batch-journal" ||
      journal.state !== "complete" || journal.manifestDigest !== manifestDigest || !Array.isArray(journal.executionIds) ||
      !Array.isArray(journal.requestDigests) || journal.executionIds.length !== 7 || journal.requestDigests.length !== 7 ||
      journal.executionIds.length !== journal.outputs?.length) {
    throw new Error("Completed host batch journal does not prove this request manifest");
  }
  const bindings = new Map();
  const requestDigests = [];
  const executionIds = [];
  for (const item of manifest.requests) {
    if (!item || typeof item !== "object" || typeof item.executionId !== "string" || typeof item.request !== "string" ||
        !path.isAbsolute(item.request) || path.resolve(item.request) !== item.request || !SHA256.test(item.requestDigest) ||
        !SHA256.test(item.promptDigest) || !Number.isInteger(item.attempt) || typeof item.role !== "string") {
      throw new Error("Execution request manifest contains an invalid canonical request record");
    }
    const requestPath = path.resolve(item.request);
    if (isPathWithin(repository, requestPath)) throw new Error("Execution request files must be outside the evaluated repository");
    const requestInfo = await lstat(requestPath);
    if (requestInfo.isSymbolicLink() || !requestInfo.isFile() || path.resolve(await realpath(requestPath)) !== requestPath) {
      throw new Error("Execution request must be a canonical regular file");
    }
    const requestBytes = await readFile(requestPath);
    if (sha256(requestBytes) !== item.requestDigest) throw new Error("Execution request digest changed after administrator confirmation");
    const request = JSON.parse(requestBytes.toString("utf8"));
    if (!validRunAs(requestRunAs(request)) || request.model !== manifest.model || request.pluginBundleDigest !== manifest.pluginBundleDigest ||
        request.binaryPath !== manifest.binaryPath || request.binaryApprovalDigest !== manifest.binaryApprovalDigest || request.binaryDigest !== manifest.binaryDigest ||
        digestObject(requestRunAs(request)) !== digestObject(manifest.runAs) || request.promptDigest !== item.promptDigest ||
        request.execution?.id !== item.executionId || request.execution?.role !== item.role || request.execution?.attempt !== item.attempt ||
        request.execution?.headRevision !== manifest.headRevision || request.execution?.sourceBindingDigest !== manifest.sourceBindingDigest ||
        request.execution?.runId !== manifest.runId || request.execution?.suiteDigest !== manifest.suiteDigest ||
        request.execution?.baselineRevision !== manifest.baselineRevision || request.execution?.candidateDigest !== manifest.candidateDigest ||
        (policyBound && (request.purpose !== purpose || request.policyDigest !== policy.digest || request.execution?.purpose !== purpose || request.execution?.policyDigest !== policy.digest)) ||
        (!policyBound && (request.purpose !== undefined || request.policyDigest !== undefined || request.execution?.purpose !== undefined || request.execution?.policyDigest !== undefined))) {
      throw new Error("Execution request is not bound to the canonical request manifest");
    }
    if (bindings.has(item.executionId)) throw new Error("Execution request manifest contains duplicate execution IDs");
    bindings.set(item.executionId, {
      requestDigest: item.requestDigest,
      runAs: requestRunAs(request),
      headRevision: request.execution.headRevision,
      sourceBindingDigest: request.execution.sourceBindingDigest,
      pluginBundleDigest: request.pluginBundleDigest
    });
    requestDigests.push(item.requestDigest);
    executionIds.push(item.executionId);
  }
  if (digestObject(journal.executionIds) !== digestObject(executionIds) || digestObject(journal.requestDigests) !== digestObject(requestDigests)) {
    throw new Error("Completed host batch journal does not match the canonical request manifest");
  }
  bindings.headRevision = manifest.headRevision;
  bindings.sourceBindingDigest = manifest.sourceBindingDigest;
  bindings.pluginBundleDigest = manifest.pluginBundleDigest;
  bindings.purpose = manifest.purpose;
  bindings.policyDigest = manifest.policyDigest ?? null;
  return bindings;
}

function acceptedComparison(evidence) {
  return evidence.find((item) =>
    item.kind === "holdout-comparison" && item.status === "complete" && item.stale !== true &&
    item.evaluation?.backend === "codex" && item.evaluation?.comparison?.accepted === true
  );
}

function requiredReplayFields(replay) {
  return replay && replay.provider === "codex" && replay.trustAttested === true &&
    typeof replay.hostExecutionPath === "string" && SHA256.test(replay.attestationDigest) && typeof replay.attestationPath === "string" &&
    SHA256.test(replay.resultReceiptDigest) && typeof replay.resultReceiptPath === "string" && typeof replay.ledgerPath === "string" &&
    SHA256.test(replay.ledgerDigest) && SHA256.test(replay.requestDigest) && replay.execution && typeof replay.responseDigest === "string" &&
    SHA256.test(replay.responseDigest) && typeof replay.binaryPath === "string" && SHA256.test(replay.binaryDigest) &&
    typeof replay.trustRootDigest === "string" && SHA256.test(replay.trustRootDigest) && typeof replay.model === "string" &&
    typeof replay.expiresAt === "string" && replay.runAs && typeof replay.promptDigest === "string" && replay.response;
}

function witnessDigest(replay, witness) {
  const metadata = witness.metadata;
  return digestObject({
    execution: metadata.execution,
    requestDigest: metadata.requestDigest,
    hostExecutionPath: metadata.hostExecutionPath,
    attestationDigest: metadata.attestationDigest,
    resultReceiptDigest: metadata.resultReceiptDigest,
    ledgerPath: metadata.ledgerPath,
    ledgerDigest: metadata.ledgerDigest,
    responseDigest: metadata.responseDigest,
    binaryDigest: metadata.binary.digest,
    trustRootDigest: metadata.trustRootDigest,
    persistedExecution: replay.execution
  });
}

export async function verifySelfImproveDeliveryEvidence({ root, runId, run, evidence }) {
  if (!run || run.manifest.template !== "self-improve-ops") throw new Error("Self-improve delivery verification requires a self-improve-ops run");
  if (["stale", "indeterminate", "inconclusive", "blocked_external_reviewer"].includes(run.state.status)) {
    throw new Error("Self-improve delivery source run is not deliverable");
  }
  const findings = await listJsonRecords(root, safeJoin(run.runDir, "findings"));
  if (findings.some((item) => ["P0", "P1"].includes(item.severity) && item.status === "open")) {
    throw new Error("Self-improve delivery source has an unresolved P0/P1 finding");
  }
  const accepted = acceptedComparison(evidence);
  if (!accepted) throw new Error("Self-improve delivery requires an accepted trusted Codex holdout comparison");
  const evaluation = accepted.evaluation;
  const purpose = evaluation.purpose ?? "ordinary";
  const policyBound = isPolicyBoundEvaluationPurpose(purpose);
  const policy = policyBound ? await loadPolicyBoundEvaluationPolicy({ cwd: run.manifest.cwd, purpose }) : null;
  const candidateDigest = evaluation.candidate?.digest;
  const candidateRoot = evaluation.candidate?.candidateRoot;
  if (!SHA1.test(evaluation.baselineRevision ?? "") || !SHA1.test(evaluation.headRevision ?? "") ||
      !SHA256.test(evaluation.sourceBindingDigest ?? "") || !SHA256.test(evaluation.pluginBundleDigest ?? "") ||
      !SHA256.test(evaluation.requestManifestDigest ?? "") || !SHA256.test(candidateDigest ?? "") ||
      (policyBound && (!policy || evaluation.policyPath !== policy.path || evaluation.policyId !== policy.policyId || evaluation.policyVersion !== policy.version || evaluation.policyDigest !== policy.digest)) ||
      (!policyBound && (evaluation.policyDigest ?? null) !== null) ||
      typeof candidateRoot !== "string" || !candidateRoot || !SHA256.test(digestObject(evaluation.comparison))) {
    throw new Error("Self-improve accepted comparison lacks complete delivery bindings");
  }
  if (evaluation.baselineRevision !== run.manifest.baselineRevision ||
      run.manifest.sourceBinding?.headRevision !== evaluation.headRevision ||
      run.manifest.sourceBinding?.digest !== evaluation.sourceBindingDigest) {
    throw new Error("Self-improve accepted comparison is not bound to its source run");
  }
  const staging = evidence.find((item) => item.kind === "candidate-staging" && item.status === "complete" && item.stale !== true && item.evaluation?.candidate?.digest === candidateDigest);
  const training = evidence.find((item) => item.kind === "training-replay" && item.status === "complete" && item.stale !== true && item.evaluation?.candidate?.digest === candidateDigest);
  if (!staging || !training) throw new Error("Self-improve delivery requires fresh candidate staging and training replay evidence");
  const replays = [
    ...(training.evaluation?.replays ?? []),
    ...(accepted.evaluation?.candidateReplays ?? []),
    ...(accepted.evaluation?.baselineReplays ?? [])
  ];
  const replayKeys = new Set(replays.map((item) => `${item.execution?.role}:${item.execution?.attempt}`));
  if (replays.length !== 7 || replayKeys.size !== 7 || [...EXPECTED_REPLAYS].some((key) => !replayKeys.has(key)) || replays.some((item) => !requiredReplayFields(item))) {
    throw new Error("Self-improve delivery requires exactly seven complete host-owned Codex execution witnesses");
  }
  const bindings = new Set(replays.map((item) => digestObject({
    binaryDigest: item.binaryDigest,
    trustRootDigest: item.trustRootDigest,
    issuer: item.issuer,
    keyId: item.keyId,
    model: item.model
  })));
  if (bindings.size !== 1) throw new Error("Self-improve delivery requires one consistent host binary, trust root, issuer, key, and model across every replay");
  if (new Set(replays.map((item) => item.execution.id)).size !== 7 || new Set(replays.map((item) => item.requestDigest)).size !== 7 ||
      new Set(replays.map((item) => item.hostExecutionPath)).size !== 7 || new Set(replays.map((item) => item.attestationPath)).size !== 7 ||
      new Set(replays.map((item) => item.resultReceiptPath)).size !== 7 || new Set(replays.map((item) => item.ledgerPath)).size !== 7) {
    throw new Error("Self-improve delivery requires seven distinct confirmed requests, host execution witnesses, attestations, receipts, and ledgers");
  }
  const expectedExecutions = new Set(EXPECTED_REPLAYS);
  for (const replay of replays) {
    const execution = replay.execution;
    if (execution.runId !== runId || execution.suiteDigest !== evaluation.suiteDigest || execution.baselineRevision !== evaluation.baselineRevision ||
        execution.candidateDigest !== candidateDigest || execution.headRevision !== evaluation.headRevision || execution.sourceBindingDigest !== evaluation.sourceBindingDigest ||
        (policyBound && (execution.purpose !== purpose || execution.policyDigest !== policy.digest)) ||
        (!policyBound && (execution.purpose !== undefined || execution.policyDigest !== undefined)) ||
        replay.model !== (evaluation.model ?? replays[0].model) || !expectedExecutions.delete(`${execution.role}:${execution.attempt}`)) {
      throw new Error("Self-improve delivery execution binding is incomplete, duplicated, or mismatched");
    }
  }
  if (expectedExecutions.size !== 0) throw new Error("Self-improve delivery is missing a required signed replay execution");
  const currentSourceBinding = await captureSourceBinding(run.manifest.cwd, { baseRevision: evaluation.baselineRevision, requireClean: true });
  if (!currentSourceBinding || currentSourceBinding.headRevision !== evaluation.headRevision || currentSourceBinding.digest !== evaluation.sourceBindingDigest) {
    throw new Error("Self-improve delivery source binding changed after held-out evaluation");
  }
  if (await pluginBundleDigest() !== evaluation.pluginBundleDigest) throw new Error("Self-improve delivery plugin bundle changed after held-out evaluation");
  const frozen = await loadFrozenEvaluationSuite({
    cwd: run.manifest.cwd,
    casesFile: path.join(run.manifest.cwd, evaluation.suitePath),
    baselineRevision: evaluation.baselineRevision,
    canonical: true,
    purpose
  });
  if (policy && frozen.sourceDigest !== policy.sourceSuiteDigest) {
    throw new Error(`${purpose} corpus changed after delivery evaluation`);
  }
  const currentCandidate = await snapshotCandidate({ cwd: run.manifest.cwd, baselineRevision: evaluation.baselineRevision, candidateRoot });
  if (currentCandidate.digest !== candidateDigest) throw new Error("Self-improve candidate changed after held-out evaluation");
  const currentBaseline = await snapshotBaselineForCandidate({ cwd: run.manifest.cwd, snapshot: currentCandidate });
  const candidateMaterial = await readSanitizedCandidateMaterial({ cwd: run.manifest.cwd, snapshot: currentCandidate });
  const baselineMaterial = await readSanitizedBaselineMaterial({ cwd: run.manifest.cwd, snapshot: currentBaseline });
  const replayCases = purpose === "safety-remediation-v1"
    ? selectSafetyRemediationCases({ suite: frozen.suite, snapshot: currentCandidate, split: "holdout", policy })
    : purpose === "quality-remediation-v1"
      ? selectQualityRemediationCases({ suite: frozen.suite, snapshot: currentCandidate, split: "holdout", policy })
    : selectEvaluationCases({ suite: frozen.suite, snapshot: currentCandidate, split: "holdout" });
  const candidatePrompt = buildEvaluationPrompt({ suite: { ...frozen.suite, cases: replayCases }, candidate: currentCandidate, materials: candidateMaterial });
  const baselinePrompt = buildEvaluationPrompt({ suite: { ...frozen.suite, cases: replayCases }, candidate: currentBaseline, materials: baselineMaterial });
  const migrationTarget = purpose === "evaluator-migration"
    ? await loadMigrationTargetSuite({ cwd: run.manifest.cwd, casesFile: path.join(run.manifest.cwd, evaluation.targetSuitePath) })
    : null;
  const requestBindings = await loadHostExecutionRequestManifest({
    manifestPath: evaluation.requestManifestPath,
    manifestDigest: evaluation.requestManifestDigest,
    cwd: run.manifest.cwd,
    runId,
    candidate: currentCandidate,
    frozen,
    suiteDigest: evaluation.suiteDigest,
    purpose,
    target: migrationTarget,
    model: evaluation.model ?? replays[0].model
  });
  const trainCases = purpose === "safety-remediation-v1"
    ? selectSafetyRemediationCases({ suite: frozen.suite, snapshot: currentCandidate, split: "train", policy })
    : purpose === "quality-remediation-v1"
      ? selectQualityRemediationCases({ suite: frozen.suite, snapshot: currentCandidate, split: "train", policy })
    : selectEvaluationCases({ suite: frozen.suite, snapshot: currentCandidate, split: "train" });
  const trainPrompt = buildEvaluationPrompt({ suite: { ...frozen.suite, cases: trainCases }, candidate: currentCandidate, materials: candidateMaterial });
  const trustedScores = [];
  for (const replay of replays) {
    const prompt = replay.execution.role === "baseline" ? baselinePrompt : replay.execution.role === "candidate" ? candidatePrompt : trainPrompt;
    const requestBinding = requestBindings.get(replay.execution.id);
    if (!requestBinding || replay.requestDigest !== requestBinding.requestDigest ||
        replay.runAs === undefined || digestObject(replay.runAs) !== digestObject(requestBinding.runAs)) {
      throw new Error("Self-improve delivery replay is not bound to the canonical request manifest");
    }
    const witness = await verifyTrustedCodexExecutionEnvelope({
      hostExecutionPath: replay.hostExecutionPath,
      evaluationRoot: run.manifest.cwd,
      model: replay.model,
      execution: replay.execution,
      prompt,
      response: replay.response,
      expectedRequestDigest: requestBinding.requestDigest,
      expectedRunAs: requestBinding.runAs
    });
    const metadata = witness.metadata;
    if (digestObject(witness.response) !== digestObject(replay.response) || metadata.attestationDigest !== replay.attestationDigest ||
        metadata.attestationPath !== path.resolve(replay.attestationPath) || metadata.binary.digest !== replay.binaryDigest || metadata.binary.path !== path.resolve(replay.binaryPath) ||
        metadata.trustRootDigest !== replay.trustRootDigest || metadata.issuer !== replay.issuer || metadata.keyId !== replay.keyId ||
        metadata.requestDigest !== replay.requestDigest || digestObject(metadata.runAs) !== digestObject(replay.runAs) ||
        metadata.resultReceiptDigest !== replay.resultReceiptDigest || metadata.resultReceiptPath !== path.resolve(replay.resultReceiptPath) ||
        metadata.ledgerDigest !== replay.ledgerDigest || metadata.ledgerPath !== path.resolve(replay.ledgerPath) || metadata.responseDigest !== replay.responseDigest ||
        metadata.hostExecutionPath !== path.resolve(replay.hostExecutionPath) || metadata.execution.headRevision !== evaluation.headRevision ||
        metadata.execution.sourceBindingDigest !== evaluation.sourceBindingDigest || metadata.expiresAt !== replay.expiresAt) {
      throw new Error("Self-improve delivery host execution witness binding changed after replay");
    }
    const scoreCases = replay.execution.role === "train-candidate" ? trainCases : replayCases;
    trustedScores.push({ replay, witness, score: scoreEvaluation(witness.response, scoreCases) });
  }
  if (policyBound && trustedScores.find((item) => item.replay.execution.role === "train-candidate")?.score.hardSafetyPass !== true) {
    throw new Error(`${purpose} delivery training replay failed its hard-safety gate`);
  }
  const trustedCandidateScores = trustedScores.filter((item) => item.replay.execution.role === "candidate").map((item) => item.score);
  const trustedBaselineScores = trustedScores.filter((item) => item.replay.execution.role === "baseline").map((item) => item.score);
  const trustedComparison = purpose === "evaluator-migration"
    ? compareEvaluatorMigration({ baseline: trustedBaselineScores, candidate: trustedCandidateScores, suite: frozen.suite })
    : purpose === "safety-remediation-v1"
      ? compareSafetyRemediation({ baseline: trustedBaselineScores, candidate: trustedCandidateScores, suite: frozen.suite, policy })
      : purpose === "quality-remediation-v1"
        ? compareQualityRemediation({ baseline: trustedBaselineScores, candidate: trustedCandidateScores, suite: frozen.suite, policy })
      : compareHoldout({ baseline: trustedBaselineScores, candidate: trustedCandidateScores, suite: frozen.suite });
  if (digestObject(trustedComparison) !== digestObject(evaluation.comparison) || trustedComparison.accepted !== true) {
    throw new Error("Self-improve delivery trusted replay responses do not reproduce the persisted accepted comparison");
  }
  if (purpose === "evaluator-migration") {
    if (evaluation.comparison?.policy !== "evaluator-migration") throw new Error("Evaluator migration delivery requires the dedicated safety non-regression policy");
    const migration = evidence.find((item) =>
      (item.kind === "evaluation-migration" || item.sourceKind === "evaluation-migration") && item.status === "complete" && item.stale !== true &&
      item.evaluation?.suiteDigest === evaluation.suiteDigest && item.evaluation?.candidate?.digest === candidateDigest && item.evaluation?.calibration?.digest
    );
    if (!migration) throw new Error("Evaluator migration delivery requires fresh deterministic migration calibration");
    if (migrationTarget.sourceDigest !== evaluation.targetSuiteDigest) throw new Error("Evaluator migration target suite changed after replay");
    const binding = evaluationBindingDigest({ purpose, sourceSuiteDigest: frozen.sourceDigest, targetSuiteDigest: migrationTarget.sourceDigest });
    if (binding !== evaluation.suiteDigest) throw new Error("Evaluator migration suite binding changed after replay");
    const calibration = calibrateEvaluatorMigration({
      source: frozen.suite,
      target: migrationTarget.suite,
      snapshot: currentCandidate,
      materials: candidateMaterial,
      sourceDigest: frozen.sourceDigest,
      targetDigest: migrationTarget.sourceDigest
    });
    if (calibration.digest !== migration.evaluation.calibration.digest) throw new Error("Evaluator migration calibration changed after replay");
  } else if (policyBound) {
    if (evaluation.comparison?.policy !== policy.policyId) throw new Error(`${purpose} delivery requires its dedicated versioned policy`);
    const binding = evaluationBindingDigest({ purpose, sourceSuiteDigest: frozen.sourceDigest, policyDigest: policy.digest });
    if (binding !== evaluation.suiteDigest) throw new Error(`${purpose} policy or suite binding changed after replay`);
    if (evaluation.comparison?.policyVersion !== policy.version) throw new Error(`${purpose} policy version changed after replay`);
  } else if (evaluation.comparison?.policy !== "strict-class-improvement") {
    throw new Error("Ordinary self-improve delivery requires strict relevant-class improvement");
  }
  const verifiedReplays = trustedScores.map(({ replay, witness }) => ({ replay, witness }));
  const witnessDigests = verifiedReplays.map(({ replay, witness }) => witnessDigest(replay, witness)).sort();
  if (new Set(witnessDigests).size !== 7) throw new Error("Self-improve delivery witnesses must be distinct");
  return {
    accepted,
    staging,
    training,
    evaluation,
    replays,
    candidate: currentCandidate,
    sourceBinding: currentSourceBinding,
    comparison: trustedComparison,
    witnessDigests,
    verifiedReplays
  };
}
