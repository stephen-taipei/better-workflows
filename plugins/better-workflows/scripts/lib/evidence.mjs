import { readFile } from "node:fs/promises";
import path from "node:path";
import { digestObject, pluginRoot } from "./core.mjs";

const CONTRACT_FILE = path.join(pluginRoot(), "config", "evidence-contracts-v1.json");
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const PRODUCER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PAYLOAD_FAMILIES = new Set([
  "revision-identity",
  "inventory-snapshot",
  "plan-design",
  "validation-test",
  "review-analysis",
  "authorization",
  "side-effect-result",
  "provider-reconciliation",
  "decision-disposition",
  "artifact-package"
]);
const INDEPENDENT_CRITIC_PRODUCERS = new Set(["agy", "codex", "codex-native-subagent"]);
let contractCache = null;

export async function loadEvidenceContracts({ refresh = false } = {}) {
  if (contractCache && !refresh) return contractCache;
  const value = JSON.parse(await readFile(CONTRACT_FILE, "utf8"));
  if (value?.schemaVersion !== 1 || !value.contracts || typeof value.contracts !== "object") {
    throw new Error("evidence-contracts-v1 must contain schemaVersion 1 and contracts");
  }
  const entries = Object.entries(value.contracts);
  if (entries.length !== 98) {
    throw new Error(`evidence-contracts-v1 must cover exactly 98 kinds, found ${entries.length}`);
  }
  for (const [kind, entry] of entries) {
    if (entry?.id !== `evidence-contracts-v1:${kind}`) {
      throw new Error(`Evidence contract id mismatch for ${kind}`);
    }
    if (!Array.isArray(entry.producerAllowlist) || entry.producerAllowlist.length === 0) {
      throw new Error(`Evidence contract producer allowlist is empty for ${kind}`);
    }
    if (!PAYLOAD_FAMILIES.has(entry.payloadFamily) || !Array.isArray(entry.requiredFields)) {
      throw new Error(`Evidence contract payload schema is invalid for ${kind}`);
    }
    if (!Array.isArray(entry.freshnessBinding) || !entry.freshnessBinding.includes("runId")) {
      throw new Error(`Evidence contract freshness binding is invalid for ${kind}`);
    }
  }
  const predicates = value.successPredicates ?? {};
  for (const [family, predicate] of Object.entries(predicates)) {
    if (!PAYLOAD_FAMILIES.has(family) || !predicate || typeof predicate.field !== "string") {
      throw new Error(`Evidence success predicate is invalid for ${family}`);
    }
    if (predicate.equals === undefined && !Array.isArray(predicate.oneOf) && predicate.nonEmpty !== true) {
      throw new Error(`Evidence success predicate has no comparison for ${family}`);
    }
  }
  contractCache = Object.fromEntries(entries.map(([kind, entry]) => [
    kind,
    { ...entry, success: predicates[entry.payloadFamily] ?? null }
  ]));
  return contractCache;
}

function producerId(producer) {
  if (typeof producer === "string") return producer;
  if (!producer || typeof producer !== "object") return "";
  return String(producer.provider ?? producer.type ?? producer.id ?? "");
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !HEX_DIGEST.test(value)) {
    throw new Error(`${label} must be a 64-character SHA-256 digest`);
  }
}

function assertPayloadFields(payload, requiredFields, kind) {
  for (const field of requiredFields) {
    if (!(field in payload) || payload[field] === null || payload[field] === "") {
      throw new Error(`Typed evidence ${kind} payload is missing required field: ${field}`);
    }
  }
}

function assertSemanticSuccess(payload, kind, definition) {
  const predicate = definition.success;
  if (!predicate) return;
  const value = payload[predicate.field];
  const matches = predicate.equals !== undefined
    ? value === predicate.equals
    : Array.isArray(predicate.oneOf)
      ? predicate.oneOf.some((candidate) => value === candidate)
      : Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
  if (!matches) throw new Error(`Typed evidence ${kind} payload ${predicate.field} failed its success predicate`);
}

function assertIndependentCriticBinding(record, run) {
  const binding = record.dependencies?.reviewBinding;
  const required = ["packageId", "base", "head", "scopeDigest", "diffManifestDigest", "instructionDigest", "sentinelDigest"];
  if (run.contract.controlPlane?.reviewPolicy === "code-v1") {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      throw new Error("Typed evidence independent-critic review binding is required");
    }
    for (const field of required) {
      if (typeof binding[field] !== "string" || !binding[field]) {
        throw new Error(`Typed evidence independent-critic review binding is missing: ${field}`);
      }
    }
  }
  const execution = record.providerExecution;
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    throw new Error("Typed evidence independent-critic provider execution is required");
  }
  if (
    execution.provider !== producerId(record.receipt?.producer) ||
    execution.model !== record.dependencies?.model ||
    execution.promptDigest !== record.dependencies?.promptDigest ||
    execution.reviewDigest !== digestObject(record.review) ||
    execution.sandbox !== "read-only" ||
    typeof execution.executionDigest !== "string" ||
    execution.executionDigest !== digestObject({
      provider: execution.provider,
      model: execution.model,
      promptDigest: execution.promptDigest,
      reviewDigest: execution.reviewDigest,
      transport: execution.transport,
      sandbox: execution.sandbox
    })
  ) {
    throw new Error("Typed evidence independent-critic provider execution is invalid");
  }
}

function assertFreshBinding(receipt, run, definition, kind) {
  const binding = receipt.inputBinding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error(`Typed evidence ${kind} inputBinding is required`);
  }
  for (const field of definition.freshnessBinding) {
    if (!(field in binding)) {
      throw new Error(`Typed evidence ${kind} freshness binding is missing: ${field}`);
    }
  }
  if (binding.runId !== run.manifest.runId) {
    throw new Error(`Typed evidence ${kind} is bound to a different run`);
  }
  const contractDigest = digestObject(run.contract);
  if (binding.contractDigest !== contractDigest) {
    throw new Error(`Typed evidence ${kind} contract binding is stale`);
  }
  if (binding.remoteRevision !== (run.contract.remoteRevision ?? null)) {
    throw new Error(`Typed evidence ${kind} remote revision binding is stale`);
  }
}

export async function admitTypedEvidence(record, run, { persisted = false } = {}) {
  if (run.contract?.schemaVersion !== 2) {
    return { ...record, schemaVersion: 1 };
  }
  if (!record || record.schemaVersion !== 2) {
    throw new Error("v2 runs require EvidenceRecord schemaVersion 2");
  }
  if (typeof record.kind !== "string" || !record.kind) {
    throw new Error("Typed evidence kind is required");
  }
  const contracts = await loadEvidenceContracts();
  const definition = contracts[record.kind];
  if (!definition) throw new Error(`Unknown typed evidence kind: ${record.kind}`);
  if (record.status !== "complete") throw new Error("Typed evidence status must be complete");
  if (typeof record.summary !== "string" || !record.summary.trim()) {
    throw new Error("Typed evidence summary is required");
  }
  const receipt = record.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`Typed evidence ${record.kind} receipt is required`);
  }
  if (receipt.contractId !== definition.id || receipt.contractVersion !== 1) {
    throw new Error(`Typed evidence ${record.kind} contract id/version is invalid`);
  }
  if (typeof receipt.runId !== "string" || receipt.runId !== run.manifest.runId) {
    throw new Error(`Typed evidence ${record.kind} receipt run binding is invalid`);
  }
  const producer = producerId(receipt.producer);
  if (!PRODUCER_ID.test(producer) || !definition.producerAllowlist.includes(producer)) {
    throw new Error(`Typed evidence ${record.kind} producer is not authorized`);
  }
  if (record.sourceKind === "independent-critic") {
    if (
      record.kind !== "patch-review" ||
      !INDEPENDENT_CRITIC_PRODUCERS.has(producer) ||
      record.review?.verdict !== "PASS" ||
      !record.dependencies?.promptDigest ||
      !record.dependencies?.model
    ) {
      throw new Error("Typed evidence independent-critic provenance is invalid");
    }
    assertIndependentCriticBinding(record, run);
  }
  assertFreshBinding(receipt, run, definition, record.kind);
  if (!receipt.payload || typeof receipt.payload !== "object" || Array.isArray(receipt.payload)) {
    throw new Error(`Typed evidence ${record.kind} payload must be a non-empty object`);
  }
  if (Object.keys(receipt.payload).length === 0) {
    throw new Error(`Typed evidence ${record.kind} payload must not be empty`);
  }
  assertPayloadFields(receipt.payload, definition.requiredFields, record.kind);
  assertSemanticSuccess(receipt.payload, record.kind, definition);
  const payloadDigest = digestObject(receipt.payload);
  assertDigest(receipt.payloadDigest, `Typed evidence ${record.kind} payloadDigest`);
  if (receipt.payloadDigest !== payloadDigest) {
    throw new Error(`Typed evidence ${record.kind} payload digest mismatch`);
  }
  if (record.sourceDigest !== undefined && record.sourceDigest !== payloadDigest) {
    throw new Error(`Typed evidence ${record.kind} sourceDigest is caller-forged`);
  }
  if (typeof receipt.producedAt !== "string" || Number.isNaN(Date.parse(receipt.producedAt))) {
    throw new Error(`Typed evidence ${record.kind} producedAt is invalid`);
  }
  const normalized = {
    ...record,
    schemaVersion: 2,
    sourceDigest: payloadDigest,
    acceptanceIds: [],
    receipt: {
      ...receipt,
      payloadDigest
    },
    typedAdmission: {
      contractId: definition.id,
      contractVersion: 1,
      admittedAt: new Date().toISOString(),
      producer,
      ...(record.sourceKind === "independent-critic" ? { independentCritic: true } : {})
    }
  };
  return normalized;
}

export async function validateTypedEvidenceRecord(record, run) {
  if (!record || record.schemaVersion !== 2 || !record.typedAdmission) {
    throw new Error("Evidence record is not a typed-v1 admission");
  }
  if (!EVIDENCE_ID.test(String(record.id ?? ""))) {
    throw new Error("Typed evidence id is invalid");
  }
  const admitted = await admitTypedEvidence(record, run, { persisted: true });
  if (admitted.sourceDigest !== record.sourceDigest || admitted.receipt.payloadDigest !== record.receipt.payloadDigest) {
    throw new Error("Typed evidence admission changed after persistence");
  }
  return admitted;
}

export function isTypedEvidence(record) {
  return record?.schemaVersion === 2 && record?.typedAdmission?.contractVersion === 1;
}

export function isIndependentCriticEvidence(record, expectedBinding = null) {
  const binding = record?.dependencies?.reviewBinding;
  const expected = expectedBinding?.reviewPackage
    ? {
        packageId: expectedBinding.reviewPackage.packageId,
        base: expectedBinding.reviewPackage.base,
        head: expectedBinding.reviewPackage.head,
        scopeDigest: expectedBinding.reviewPackage.scopeDigest,
        diffManifestDigest: expectedBinding.reviewPackage.diffManifestDigest,
        instructionDigest: expectedBinding.reviewPackage.instructionDigest,
        sentinelDigest: expectedBinding.sentinelDigest
      }
    : null;
  return Boolean(
    isTypedEvidence(record) &&
    record.sourceKind === "independent-critic" &&
    record.kind === "patch-review" &&
    record.typedAdmission?.independentCritic === true &&
    INDEPENDENT_CRITIC_PRODUCERS.has(record.typedAdmission?.producer) &&
    record.receipt?.payload?.verdict === "PASS" &&
    record.review?.verdict === "PASS" &&
    Boolean(record.dependencies?.promptDigest) &&
    Boolean(record.dependencies?.model) &&
    (!expected || (binding && Object.entries(expected).every(([key, value]) => binding[key] === value)))
  );
}

export function typedEvidenceKinds(records) {
  return new Set(
    records.filter((record) => isTypedEvidence(record) && !record.stale).map((record) => record.kind)
  );
}
