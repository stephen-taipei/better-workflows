import { readdir } from "node:fs/promises";
import { deliberate } from "./deliberation.mjs";
import {
  atomicWriteJson,
  assertMutableRun,
  digestObject,
  loadDefaults,
  listJsonRecords,
  loadRun,
  nowIso,
  readJson,
  safeJoin,
  sha256,
  withRunLock
} from "./core.mjs";
import { captureSentinel } from "./git.mjs";

function bundlePath(runDir, bundleId) {
  return safeJoin(runDir, "evidence-bundles", `${bundleId}.json`);
}

async function existingBundles(root, runDir) {
  const directory = safeJoin(runDir, "evidence-bundles");
  try {
    const entries = await readdir(directory);
    return Promise.all(
      entries.filter((entry) => entry.endsWith(".json")).sort().map((entry) => readJson(root, safeJoin(directory, entry)))
    );
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function participantStatuses(result) {
  const available = new Set((result.perspectives ?? []).map((item) => `${item.provider}:${item.model}`));
  return [
    ...(result.roster?.activeParticipants ?? []).map((item) => ({
      provider: item.provider,
      model: item.model,
      role: item.role,
      status: available.has(`${item.provider}:${item.model}`) ? "complete" : "failed"
    })),
    ...(result.roster?.unavailable ?? []).map((item) => ({
      provider: item.provider,
      model: item.model,
      role: item.role,
      status: "unavailable",
      reason: item.reason
    }))
  ];
}

async function deliberateForRunLocked({
  root,
  runId,
  prompt,
  config,
  allowExternalProviders = false,
  sanitized = false,
  refresh = false,
  reasoningEffort = "auto",
  mode = "deep",
  timeoutSeconds,
  providers = []
}) {
  const run = await loadRun(root, runId);
  assertMutableRun(run, "Atomic deliberation");
  if (run.contract.schemaVersion !== 2 || run.contract.controlPlane?.deliberationPolicy !== "allowed-v1") {
    throw new Error("Atomic deliberation is not enabled for this run");
  }
  if (run.state.lastSentinelVerified !== true || run.state.lastSentinelComplete !== true) {
    throw new Error("Atomic deliberation requires a verified complete current sentinel");
  }
  const currentSentinel = await captureSentinel(run.manifest.cwd, run.contract, await loadDefaults());
  if (!currentSentinel.complete || currentSentinel.digest !== run.state.lastSentinel?.digest) {
    throw new Error("Atomic deliberation requires the current sentinel to remain unchanged");
  }
  if (allowExternalProviders) {
    if (!sanitized) throw new Error("External deliberation requires sanitized material");
    if (!["public", "internal"].includes(run.contract.sensitivity)) {
      throw new Error("External deliberation is denied for confidential or regulated runs");
    }
    const authority = run.contract.authority?.externalSideEffects ?? [];
    if (!authority.includes("deliberation.external") && !authority.includes("*")) {
      throw new Error("Run lacks external deliberation egress authority");
    }
  }
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Deliberation prompt is required");
  const promptDigest = sha256(prompt);
  const inputDigest = digestObject({
    runId,
    contractDigest: digestObject(run.contract),
    sentinelDigest: run.state.lastSentinel.digest,
    promptDigest,
    allowExternalProviders: Boolean(allowExternalProviders),
    sanitized: Boolean(sanitized),
    reasoningEffort,
    mode,
    providers: [...providers].sort()
  });
  const bundleId = `bundle-${inputDigest.slice(0, 24)}`;
  const bundles = await existingBundles(root, run.runDir);
  const existing = bundles.find((item) => item.inputDigest === inputDigest);
  if (existing) {
    return {
      ok: true,
      idempotent: true,
      bundleId: existing.bundleId,
      digest: existing.digest,
      participants: existing.participantStatuses,
      decisionSummary: existing.decisionSummary
    };
  }
  const result = await deliberate({
    prompt,
    config,
    allowExternalProviders,
    sanitized,
    refresh,
    reasoningEffort,
    mode,
    timeoutSeconds,
    providers
  });
  if (!result.ok || !result.decision) {
    throw new Error(result.error ?? "Deliberation did not produce a decision");
  }
  const statuses = participantStatuses(result);
  const decisionSummary = String(result.decision.summary ?? result.decision.recommendation ?? "Decision recorded");
  const bundle = {
    schemaVersion: 1,
    bundleId,
    runId,
    inputDigest,
    promptDigest,
    sentinelDigest: run.state.lastSentinel.digest,
    contractDigest: digestObject(run.contract),
    producedAt: nowIso(),
    roster: result.roster,
    perspectives: result.perspectives,
    arbiter: result.arbiter,
    decision: result.decision,
    decisionSummary,
    participantStatuses: statuses,
    derivedEvidence: [
      { kind: "deliberation-roster", status: "complete" },
      { kind: "role-perspective-matrix", status: "complete" },
      { kind: "claim-reconciliation", status: "complete" },
      { kind: "decision-record", status: "complete" }
    ],
    digest: digestObject({
      bundleId,
      runId,
      inputDigest,
      promptDigest,
      sentinelDigest: run.state.lastSentinel.digest,
      roster: result.roster,
      perspectives: result.perspectives,
      arbiter: result.arbiter,
      decision: result.decision,
      participantStatuses: statuses
    })
  };
  const directory = safeJoin(run.runDir, "evidence-bundles");
  await atomicWriteJson(root, bundlePath(run.runDir, bundleId), bundle);
  return {
    ok: true,
    idempotent: false,
    bundleId,
    digest: bundle.digest,
    participants: statuses,
    decisionSummary
  };
}

// Deliberation is an idempotent receipt operation. Hold the run lease across
// the existing-bundle check, provider execution, and atomic write so concurrent
// retries cannot execute the same input twice or overwrite the first receipt.
export async function deliberateForRun(args) {
  return withRunLock(args.root, args.runId, async () => deliberateForRunLocked(args));
}
