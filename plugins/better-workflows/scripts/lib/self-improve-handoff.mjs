import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  VERSION,
  digestObject,
  listJsonRecords,
  loadRun,
  nowIso,
  safeJoin,
  sha256
} from "./core.mjs";
import { captureSourceBinding } from "./git.mjs";
import { snapshotCandidate } from "./self-improve.mjs";
import { pluginBundleDigest } from "./routing.mjs";

export const SELF_IMPROVE_HANDOFF_KIND = "self-improve-delivery-handoff";
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

function assertDigest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function replayWitnessIdentity(replay, ledgerDigest) {
  return {
    execution: replay.execution,
    requestDigest: replay.requestDigest,
    hostExecutionPath: replay.hostExecutionPath,
    attestationDigest: replay.attestationDigest,
    resultReceiptDigest: replay.resultReceiptDigest,
    ledgerPath: replay.ledgerPath,
    ledgerDigest,
    responseDigest: replay.responseDigest,
    binaryDigest: replay.binaryDigest,
    trustRootDigest: replay.trustRootDigest
  };
}

async function replayDigest(replay) {
  if (!replay || replay.provider !== "codex" || replay.trustAttested !== true ||
      typeof replay.hostExecutionPath !== "string" || !SHA256.test(replay.attestationDigest) ||
      !SHA256.test(replay.resultReceiptDigest) || typeof replay.ledgerPath !== "string" ||
      !SHA256.test(replay.requestDigest) || !replay.execution ||
      typeof replay.responseDigest !== "string" || !SHA256.test(replay.responseDigest) ||
      typeof replay.binaryDigest !== "string" || !SHA256.test(replay.binaryDigest) ||
      typeof replay.trustRootDigest !== "string" || !SHA256.test(replay.trustRootDigest)) {
    throw new Error("Self-improve handoff contains an incomplete host witness");
  }
  const ledgerBytes = await readFile(path.resolve(replay.ledgerPath));
  const ledgerDigest = sha256(ledgerBytes);
  return digestObject(replayWitnessIdentity(replay, ledgerDigest));
}

function acceptedComparison(evidence) {
  return evidence.find((item) =>
    item.kind === "holdout-comparison" &&
    item.status === "complete" &&
    item.stale !== true &&
    item.evaluation?.backend === "codex" &&
    item.evaluation?.comparison?.accepted === true
  );
}

export async function collectSelfImproveDeliveryBinding(root, sourceRunId) {
  const sourceRun = await loadRun(root, sourceRunId);
  if (sourceRun.manifest.template !== "self-improve-ops") {
    throw new Error("Self-improve delivery handoff source must be a self-improve-ops run");
  }
  if (["stale", "indeterminate", "inconclusive", "blocked_external_reviewer"].includes(sourceRun.state.status)) {
    throw new Error("Self-improve delivery handoff source run is not deliverable");
  }
  const findings = await listJsonRecords(root, safeJoin(sourceRun.runDir, "findings"));
  if (findings.some((item) => ["P0", "P1"].includes(item.severity) && item.status === "open")) {
    throw new Error("Self-improve delivery handoff source has an unresolved P0/P1 finding");
  }
  const evidence = await listJsonRecords(root, safeJoin(sourceRun.runDir, "evidence"));
  const accepted = acceptedComparison(evidence);
  if (!accepted) throw new Error("Self-improve delivery handoff requires an accepted trusted Codex holdout comparison");
  const evaluation = accepted.evaluation;
  const candidateDigest = evaluation.candidate?.digest;
  const candidateRoot = evaluation.candidate?.candidateRoot;
  if (!SHA1.test(evaluation.baselineRevision ?? "") || !SHA1.test(evaluation.headRevision ?? "") ||
      !SHA256.test(evaluation.sourceBindingDigest ?? "") || !SHA256.test(evaluation.pluginBundleDigest ?? "") ||
      !SHA256.test(evaluation.requestManifestDigest ?? "") || !SHA256.test(candidateDigest ?? "") ||
      typeof candidateRoot !== "string" || !candidateRoot || !SHA256.test(digestObject(evaluation.comparison))) {
    throw new Error("Self-improve accepted comparison lacks complete delivery bindings");
  }
  if (sourceRun.manifest.baselineRevision !== evaluation.baselineRevision ||
      sourceRun.manifest.sourceBinding?.headRevision !== evaluation.headRevision ||
      sourceRun.manifest.sourceBinding?.digest !== evaluation.sourceBindingDigest) {
    throw new Error("Self-improve accepted comparison is not bound to its source run");
  }
  const currentSource = await captureSourceBinding(sourceRun.manifest.cwd, {
    baseRevision: evaluation.baselineRevision,
    requireClean: true
  });
  if (!currentSource || currentSource.headRevision !== evaluation.headRevision || currentSource.digest !== evaluation.sourceBindingDigest) {
    throw new Error("Self-improve source changed before delivery handoff");
  }
  if (await pluginBundleDigest() !== evaluation.pluginBundleDigest) {
    throw new Error("Self-improve plugin bundle changed before delivery handoff");
  }
  const currentCandidate = await snapshotCandidate({
    cwd: sourceRun.manifest.cwd,
    baselineRevision: evaluation.baselineRevision,
    candidateRoot
  });
  if (currentCandidate.digest !== candidateDigest) {
    throw new Error("Self-improve candidate bytes changed before delivery handoff");
  }
  const staging = evidence.find((item) => item.kind === "candidate-staging" && item.status === "complete" && item.stale !== true && item.evaluation?.candidate?.digest === candidateDigest);
  const training = evidence.find((item) => item.kind === "training-replay" && item.status === "complete" && item.stale !== true && item.evaluation?.candidate?.digest === candidateDigest);
  if (!staging || !training) throw new Error("Self-improve delivery handoff requires fresh staging and training evidence");
  const replays = [
    ...(training.evaluation?.replays ?? []),
    ...(accepted.evaluation?.candidateReplays ?? []),
    ...(accepted.evaluation?.baselineReplays ?? [])
  ];
  const replayKeys = new Set(replays.map((item) => `${item.execution?.role}:${item.execution?.attempt}`));
  if (replays.length !== 7 || replayKeys.size !== 7 || [...EXPECTED_REPLAYS].some((key) => !replayKeys.has(key))) {
    throw new Error("Self-improve delivery handoff requires exactly seven distinct replay witnesses");
  }
  const witnessDigests = (await Promise.all(replays.map(replayDigest))).sort();
  if (new Set(witnessDigests).size !== 7) throw new Error("Self-improve delivery handoff witnesses must be distinct");
  return {
    artifact: { kind: SELF_IMPROVE_HANDOFF_KIND, digest: digestObject(evaluation.comparison) },
    sourceRunId,
    sourceBaselineRevision: evaluation.baselineRevision,
    sourceHeadRevision: evaluation.headRevision,
    sourceBindingDigest: evaluation.sourceBindingDigest,
    pluginBundleDigest: evaluation.pluginBundleDigest,
    requestManifestDigest: evaluation.requestManifestDigest,
    comparisonDigest: digestObject(evaluation.comparison),
    candidateDigest,
    candidateRoot,
    witnessDigests
  };
}

export async function validateSelfImproveDeliveryHandoff(payload, targetRun) {
  const expectedKeys = [
    "artifact", "candidateDigest", "candidateRoot", "comparisonDigest", "pluginBundleDigest",
    "requestManifestDigest", "sourceBaselineRevision", "sourceBindingDigest", "sourceHeadRevision",
    "sourceRunId", "witnessDigests"
  ];
  if (!payload || Object.keys(payload).sort().join("\0") !== expectedKeys.sort().join("\0") ||
      targetRun.contract.template !== "pr-to-dev" ||
      targetRun.contract.upstreamSelfImproveRunId !== payload.sourceRunId ||
      payload.artifact?.kind !== SELF_IMPROVE_HANDOFF_KIND || payload.artifact?.digest !== payload.comparisonDigest ||
      typeof payload.candidateRoot !== "string" || !payload.candidateRoot || !SHA1.test(payload.sourceBaselineRevision) ||
      !SHA1.test(payload.sourceHeadRevision) || !SHA256.test(payload.candidateDigest) ||
      !SHA256.test(payload.sourceBindingDigest) || !SHA256.test(payload.pluginBundleDigest) ||
      !SHA256.test(payload.requestManifestDigest) || !SHA256.test(payload.comparisonDigest) ||
      !Array.isArray(payload.witnessDigests) || payload.witnessDigests.length !== 7 ||
      payload.witnessDigests.some((item) => !SHA256.test(item)) || new Set(payload.witnessDigests).size !== 7) {
    throw new Error("Self-improve delivery handoff payload is structurally invalid");
  }
  const expected = await collectSelfImproveDeliveryBinding(targetRun.root, payload.sourceRunId);
  if (digestObject(expected) !== digestObject(payload)) {
    throw new Error("Self-improve delivery handoff is not bound to the accepted replay evidence");
  }
  const currentSource = await captureSourceBinding(targetRun.manifest.cwd, {
    baseRevision: targetRun.manifest.sourceBinding?.baseRevision ?? payload.sourceBaselineRevision,
    requireClean: true
  });
  if (!currentSource || currentSource.headRevision !== payload.sourceHeadRevision || currentSource.digest !== payload.sourceBindingDigest) {
    throw new Error("Self-improve delivery handoff source binding does not match the target delivery run");
  }
  return expected;
}

export async function createSelfImproveDeliveryHandoff(root, targetRunId, sourceRunId) {
  const targetRun = await loadRun(root, targetRunId);
  if (targetRun.contract.template !== "pr-to-dev" || targetRun.contract.upstreamSelfImproveRunId !== sourceRunId) {
    throw new Error("Target pr-to-dev run is not explicitly bound to the requested self-improve run");
  }
  const payload = await collectSelfImproveDeliveryBinding(root, sourceRunId);
  await validateSelfImproveDeliveryHandoff(payload, targetRun);
  const producer = { provider: "codex-root" };
  return {
    id: `self-improve-handoff-${Date.now()}`,
    kind: SELF_IMPROVE_HANDOFF_KIND,
    status: "complete",
    summary: "Accepted self-improve replay handoff bound to the exact delivery candidate.",
    acceptanceIds: [],
    sourceDigest: digestObject(payload),
    dependencyInputs: { files: [] },
    dependencies: {
      contractDigest: targetRun.manifest.contractDigest,
      workflowVersion: VERSION,
      files: []
    },
    producer,
    receipt: {
      contractId: "evidence-contracts-v1:self-improve-delivery-handoff",
      contractVersion: 1,
      runId: targetRunId,
      producer,
      inputBinding: {
        runId: targetRunId,
        contractDigest: digestObject(targetRun.contract),
        remoteRevision: targetRun.contract.remoteRevision ?? null,
        sourceBindingDigest: targetRun.manifest.sourceBinding.digest
      },
      payload,
      payloadDigest: digestObject(payload),
      producedAt: nowIso()
    }
  };
}
