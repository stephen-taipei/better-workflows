import {
  VERSION,
  digestObject,
  getCodexPluginCacheRoot,
  listJsonRecords,
  loadRun,
  nowIso,
  safeJoin
} from "./core.mjs";
import path from "node:path";
import { captureSourceBinding } from "./git.mjs";
import { verifySelfImproveDeliveryEvidence } from "./self-improve-replay.mjs";

export const SELF_IMPROVE_HANDOFF_KIND = "self-improve-delivery-handoff";
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function canonicalSourceCacheRoot(manifest) {
  const cacheRoot = manifest?.pluginCacheRoot;
  if (
    typeof cacheRoot !== "string" ||
    !path.isAbsolute(cacheRoot) ||
    path.resolve(cacheRoot) !== cacheRoot
  ) {
    throw new Error("Self-improve source run is missing its canonical plugin cache root");
  }
  return cacheRoot;
}

export async function collectSelfImproveDeliveryBinding(root, sourceRunId) {
  const sourceRun = await loadRun(root, sourceRunId);
  const evidence = await listJsonRecords(root, safeJoin(sourceRun.runDir, "evidence"));
  const verified = await verifySelfImproveDeliveryEvidence({
    root,
    runId: sourceRunId,
    run: sourceRun,
    evidence
  });
  const evaluation = verified.evaluation;
  const candidateDigest = evaluation.candidate?.digest;
  const candidateRoot = evaluation.candidate?.candidateRoot;
  return {
    artifact: { kind: SELF_IMPROVE_HANDOFF_KIND, digest: digestObject(evaluation.comparison) },
    sourceRunId,
    sourceBaselineRevision: evaluation.baselineRevision,
    sourceHeadRevision: evaluation.headRevision,
    sourceBindingDigest: evaluation.sourceBindingDigest,
    pluginBundleDigest: evaluation.pluginBundleDigest,
    requestManifestDigest: evaluation.requestManifestDigest,
    purpose: evaluation.purpose ?? "ordinary",
    policyDigest: evaluation.policyDigest ?? null,
    comparisonDigest: digestObject(evaluation.comparison),
    candidateDigest,
    candidateRoot,
    witnessDigests: verified.witnessDigests,
    cacheRoot: canonicalSourceCacheRoot(sourceRun.manifest)
  };
}

export async function validateSelfImproveDeliveryHandoff(payload, targetRun) {
  const expectedKeys = [
    "artifact", "cacheRoot", "candidateDigest", "candidateRoot", "comparisonDigest", "pluginBundleDigest",
    "policyDigest", "purpose", "requestManifestDigest", "sourceBaselineRevision", "sourceBindingDigest", "sourceHeadRevision",
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
      !["ordinary", "evaluator-migration", "safety-remediation-v1", "quality-remediation-v1"].includes(payload.purpose) ||
      (["safety-remediation-v1", "quality-remediation-v1"].includes(payload.purpose) ? !SHA256.test(payload.policyDigest) : payload.policyDigest !== null) ||
      typeof payload.cacheRoot !== "string" || !path.isAbsolute(payload.cacheRoot) ||
      !Array.isArray(payload.witnessDigests) || payload.witnessDigests.length !== 7 ||
      payload.witnessDigests.some((item) => !SHA256.test(item)) || new Set(payload.witnessDigests).size !== 7) {
    throw new Error("Self-improve delivery handoff payload is structurally invalid");
  }
  if (!targetRun.root) throw new Error("Self-improve delivery handoff validation requires its state root");
  const expected = await collectSelfImproveDeliveryBinding(targetRun.root, payload.sourceRunId);
  if (digestObject(expected) !== digestObject(payload)) {
    throw new Error("Self-improve delivery handoff is not bound to the accepted replay evidence");
  }
  const targetBinding = targetRun.manifest.sourceBinding;
  if (
    targetRun.manifest.pluginCacheRoot !== payload.cacheRoot ||
    payload.cacheRoot !== getCodexPluginCacheRoot()
  ) {
    throw new Error("Self-improve delivery handoff cache root is not bound to the target run and current environment");
  }
  if (
    !targetBinding ||
    targetBinding.baseRevision !== payload.sourceBaselineRevision ||
    targetBinding.headRevision !== payload.sourceHeadRevision ||
    targetBinding.digest !== payload.sourceBindingDigest
  ) {
    throw new Error("Self-improve delivery handoff target manifest is not bound to the source payload");
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
  await validateSelfImproveDeliveryHandoff(payload, { ...targetRun, root });
  const producer = { provider: "codex-root" };
  return {
    schemaVersion: 2,
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
