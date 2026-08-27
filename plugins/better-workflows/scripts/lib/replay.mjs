import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { digestObject, sha256 } from "./core.mjs";
import { assertPayloadFields, assertRecordedEvidenceSemantics, loadEvidenceContracts } from "./evidence.mjs";
import { reduceLedgerSnapshot } from "./ledger.mjs";

export const REPLAY_MANIFEST_KIND = "evidence-replay-manifest-v1";
export const REPLAY_SCHEMA_VERSION = 1;
export const REPLAY_FILE_LIMIT_BYTES = 4 * 1024 * 1024;
export const REPLAY_RUN_LIMIT_BYTES = 32 * 1024 * 1024;
export const REPLAY_RUN_LIST_LIMIT = 200;
export const REPLAY_DIRECTORY_ENTRY_LIMIT = 10_000;

const RUN_ID = /^sbw-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const JSON_DIRECTORIES = [
  "evidence",
  "findings",
  "actions",
  "sentinels",
  "review-packages",
  "review-findings",
  "review-axes",
  "review-verifications",
  "review-coverage",
  "review-synthesis"
];
const CORE_FILES = ["manifest.json", "contract.json", "state.json"];
const OPTIONAL_FILES = ["ledger.json"];
const OUTCOMES = new Set([
  "RECORDED_COMPLETED",
  "UNSEALED",
  "HOLD",
  "INCONCLUSIVE",
  "INDETERMINATE",
  "CANCELLED",
  "LEGACY_RECORDED"
]);
const RECORD_STATUSES = new Set([
  "complete",
  "completed",
  "open",
  "closed",
  "resolved",
  "pending",
  "ready",
  "running",
  "in_progress",
  "issued",
  "spent",
  "success",
  "failure",
  "unknown",
  "indeterminate",
  "inconclusive",
  "blocked",
  "cancelled",
  "accepted-risk",
  "rejected-with-evidence",
  "resolved",
  "stale",
  "invalid"
]);

const SCENE_DEFINITIONS = [
  {
    no: "01",
    short: "Goal",
    accent: "#78a8ff",
    image: "scene-01-goal.webp",
    actor: "Captain Root",
    role: "GOAL KEEPER",
    title: "Goal 與 TaskContract 已記錄",
    dialogue: "本幕只重播已保存的目標與合約 binding，不從敘事推斷完成。",
    categories: ["contract"]
  },
  {
    no: "02",
    short: "Source",
    accent: "#f2c469",
    image: "scene-02-binding.webp",
    actor: "Sentinel",
    role: "SOURCE SENTINEL",
    title: "Source binding 與 sentinel",
    dialogue: "這是 recorded source snapshot；Replay 不執行 live Git freshness check。",
    categories: ["source"]
  },
  {
    no: "03",
    short: "Evidence",
    accent: "#ff8a72",
    image: "scene-03-evidence.webp",
    actor: "Scout Pixel",
    role: "EVIDENCE FINDER",
    title: "Typed evidence 的本地一致性",
    dialogue: "只顯示 allowlisted metadata 與 digest，不顯示 raw payload。",
    categories: ["evidence"]
  },
  {
    no: "04",
    short: "Verify",
    accent: "#c3b8ff",
    image: "scene-04-verifier.webp",
    actor: "Vera",
    role: "INDEPENDENT VERIFIER",
    title: "Findings 與反證狀態",
    dialogue: "Open、conflicting 或 inconclusive finding 不會被剪成成功結局。",
    categories: ["finding", "review-finding"]
  },
  {
    no: "05",
    short: "Ledger",
    accent: "#65d5cf",
    image: "scene-05-ledger.webp",
    actor: "Ledger",
    role: "STATE REDUCER",
    title: "Append-only ledger replay",
    dialogue: "使用與控制平面相同的純 deterministic reducer 重算 recorded task state。",
    categories: ["ledger"]
  },
  {
    no: "06",
    short: "Review",
    accent: "#c3b8ff",
    image: "scene-06-review.webp",
    actor: "Vera",
    role: "REVIEW PACKAGE",
    title: "Review package 與 closure",
    dialogue: "Replay 呈現保存的 package、finding 與 broad-review 狀態，不執行新審查。",
    categories: ["review", "review-finding"]
  },
  {
    no: "07",
    short: "Action",
    accent: "#f2c469",
    image: "scene-07-gate.webp",
    actor: "Sentinel",
    role: "SIDE-EFFECT GATE",
    title: "Action attempts 僅供對帳",
    dialogue: "Token、resource、credential 與 provider receipt 永不送到瀏覽器。",
    categories: ["action"]
  },
  {
    no: "08",
    short: "Reconcile",
    accent: "#65d5cf",
    image: "scene-08-reconcile.webp",
    actor: "Echo",
    role: "RECONCILER",
    title: "Recorded outcome",
    dialogue: "這是 presentation-only 結局，不是新的 PASS、授權或 live re-verification。",
    categories: ["outcome"]
  }
];

export class ReplayError extends Error {
  constructor(code, message, statusCode = 422) {
    super(message);
    this.name = "ReplayError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function replayError(code, message, statusCode = 422) {
  return new ReplayError(code, message, statusCode);
}

export function assertReplayRunId(runId) {
  if (!RUN_ID.test(String(runId ?? ""))) {
    throw replayError("REPLAY_INVALID_RUN_ID", "Replay run id is invalid", 400);
  }
  return String(runId);
}

function safeId(value, fallback = "unknown") {
  const normalized = String(value ?? "");
  return SAFE_ID.test(normalized) ? normalized : fallback;
}

function safeTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function safeDigest(value) {
  return DIGEST.test(String(value ?? "")) ? String(value) : null;
}

function safeRevision(value) {
  return SHA.test(String(value ?? "")) ? String(value) : null;
}

function safeStatus(value) {
  const normalized = String(value ?? "unknown").toLowerCase();
  return RECORD_STATUSES.has(normalized) ? normalized : "unknown";
}

function contained(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw replayError("REPLAY_PATH_ESCAPE", "Replay path escapes the state root", 400);
  }
  return resolvedTarget;
}

async function assertReadOnlyRoot(root) {
  const resolved = path.resolve(root);
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    if (error.code === "ENOENT") throw replayError("REPLAY_STATE_ROOT_MISSING", "Replay state root does not exist", 404);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw replayError("REPLAY_UNSAFE_STATE_ROOT", "Replay state root must be a regular directory", 400);
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) {
    throw replayError("REPLAY_UNSAFE_STATE_ROOT", "Replay state root must be canonical and symlink-free", 400);
  }
  return resolved;
}

async function assertPathComponents(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = contained(resolvedRoot, target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw replayError("REPLAY_SYMLINK_REJECTED", "Replay refuses symbolic links", 400);
    }
  }
  return resolvedTarget;
}

async function readBoundedFile(root, target, budget, { optional = false } = {}) {
  let resolved;
  try {
    resolved = await assertPathComponents(root, target);
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
  let handle;
  try {
    handle = await open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === "ELOOP") throw replayError("REPLAY_SYMLINK_REJECTED", "Replay refuses symbolic links", 400);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      throw replayError("REPLAY_UNSAFE_FILE", "Replay accepts only single-link regular files", 400);
    }
    if (info.size > REPLAY_FILE_LIMIT_BYTES) {
      throw replayError("REPLAY_FILE_TOO_LARGE", "Replay JSON file exceeds the size limit", 413);
    }
    budget.bytes += info.size;
    if (budget.bytes > REPLAY_RUN_LIMIT_BYTES) {
      throw replayError("REPLAY_RUN_TOO_LARGE", "Replay run snapshot exceeds the size limit", 413);
    }
    const body = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
    const after = await handle.stat();
    if (extraBytes !== 0 || after.size !== info.size) {
      throw replayError("REPLAY_FILE_CHANGED", "Replay file changed during bounded read", 409);
    }
    return body.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function parseJson(buffer, relativePath) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw replayError("REPLAY_INVALID_JSON", `Replay record is invalid JSON: ${relativePath}`, 422);
  }
}

async function readJsonDirectory(root, runDir, name, budget, files) {
  const directory = contained(root, path.join(runDir, name));
  let info;
  try {
    await assertPathComponents(root, directory);
    info = await lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw replayError("REPLAY_UNSAFE_DIRECTORY", "Replay record directory is unsafe", 400);
  }
  const jsonEntries = [];
  const directoryHandle = await opendir(directory);
  for await (const entry of directoryHandle) {
    budget.entries += 1;
    if (budget.entries > REPLAY_DIRECTORY_ENTRY_LIMIT) {
      throw replayError("REPLAY_TOO_MANY_ENTRIES", "Replay run contains too many directory entries", 413);
    }
    if (entry.name.endsWith(".json")) jsonEntries.push(entry);
  }
  jsonEntries.sort((a, b) => a.name.localeCompare(b.name));
  const records = [];
  for (const entry of jsonEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw replayError("REPLAY_UNSAFE_FILE", "Replay record directory contains an unsafe JSON entry", 400);
    }
    if (!SAFE_ID.test(entry.name.slice(0, -5))) {
      throw replayError("REPLAY_UNSAFE_FILE_NAME", "Replay record filename is invalid", 400);
    }
    const absolute = path.join(directory, entry.name);
    const buffer = await readBoundedFile(root, absolute, budget);
    const relative = path.relative(runDir, absolute).split(path.sep).join("/");
    files[relative] = sha256(buffer);
    records.push(parseJson(buffer, relative));
  }
  return records;
}

async function captureRawRun(root, runId) {
  const canonicalRoot = await assertReadOnlyRoot(root);
  const safeRunId = assertReplayRunId(runId);
  const runsDirectory = contained(canonicalRoot, path.join(canonicalRoot, "runs"));
  await assertPathComponents(canonicalRoot, runsDirectory);
  const runsInfo = await lstat(runsDirectory);
  if (!runsInfo.isDirectory() || runsInfo.isSymbolicLink()) {
    throw replayError("REPLAY_UNSAFE_RUNS_ROOT", "Replay runs root is unsafe", 400);
  }
  const runDir = contained(canonicalRoot, path.join(runsDirectory, safeRunId));
  try {
    await assertPathComponents(canonicalRoot, runDir);
  } catch (error) {
    if (error.code === "ENOENT") throw replayError("REPLAY_RUN_NOT_FOUND", "Replay run was not found", 404);
    throw error;
  }
  const runInfo = await lstat(runDir);
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink()) {
    throw replayError("REPLAY_UNSAFE_RUN", "Replay run directory is unsafe", 400);
  }

  const budget = { bytes: 0, entries: 0 };
  const files = {};
  const parsed = {};
  for (const name of CORE_FILES) {
    const buffer = await readBoundedFile(canonicalRoot, path.join(runDir, name), budget);
    files[name] = sha256(buffer);
    parsed[name.slice(0, -5)] = parseJson(buffer, name);
  }
  for (const name of OPTIONAL_FILES) {
    const buffer = await readBoundedFile(canonicalRoot, path.join(runDir, name), budget, { optional: true });
    if (buffer) {
      files[name] = sha256(buffer);
      parsed[name.slice(0, -5)] = parseJson(buffer, name);
    } else {
      parsed[name.slice(0, -5)] = null;
    }
  }
  const directories = {};
  for (const name of JSON_DIRECTORIES) {
    directories[name] = await readJsonDirectory(canonicalRoot, runDir, name, budget, files);
  }
  return {
    root: canonicalRoot,
    runDir,
    runId: safeRunId,
    manifest: parsed.manifest,
    contract: parsed.contract,
    state: parsed.state,
    ledger: parsed.ledger,
    directories,
    identityDigest: digestObject(files),
    bytes: budget.bytes
  };
}

function evidenceContractId(kind) {
  return `evidence-contracts-v1:${kind}`;
}

function producerId(record) {
  const producer = record?.receipt?.producer;
  const value = typeof producer === "string"
    ? producer
    : producer?.provider ?? producer?.type ?? producer?.id;
  return SAFE_ID.test(String(value ?? "")) ? String(value) : null;
}

function satisfiesRecordedSuccess(payload, definition) {
  const predicate = definition?.success;
  if (!predicate) return true;
  const value = payload?.[predicate.field];
  if (predicate.equals !== undefined) return value === predicate.equals;
  if (Array.isArray(predicate.oneOf)) return predicate.oneOf.some((candidate) => value === candidate);
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

function recordedFreshnessBindingValid(binding, raw, contractDigest, definition, payload) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  if (definition.freshnessBinding.some((field) => !(field in binding))) return false;
  if (
    binding.runId !== raw.runId ||
    binding.contractDigest !== contractDigest ||
    binding.remoteRevision !== (raw.contract?.remoteRevision ?? null)
  ) return false;
  if (
    definition.freshnessBinding.includes("sourceBindingDigest") &&
    (!raw.manifest?.sourceBinding?.digest || binding.sourceBindingDigest !== raw.manifest.sourceBinding.digest)
  ) return false;
  if (
    definition.freshnessBinding.includes("sourceSentinelDigest") &&
    (!raw.state?.lastSentinel?.digest || binding.sourceSentinelDigest !== raw.state.lastSentinel.digest)
  ) return false;
  for (const [bindingField, payloadField] of [
    ["reviewHead", "head"],
    ["reviewBase", "base"],
    ["repository", "repository"],
    ["baseRefName", "baseRefName"],
    ["observedAt", "observedAt"]
  ]) {
    if (definition.freshnessBinding.includes(bindingField) && binding[bindingField] !== payload?.[payloadField]) {
      return false;
    }
  }
  if (
    definition.freshnessBinding.includes("pullRequest") &&
    String(binding.pullRequest) !== String(payload?.pr)
  ) return false;
  return true;
}

async function validateRecordedEvidence(record, raw, contractDigest, contracts) {
  const id = safeId(record?.id);
  const kind = safeId(record?.kind);
  const definition = contracts?.[kind];
  const receipt = record?.receipt;
  const admission = record?.typedAdmission;
  const binding = receipt?.inputBinding;
  const payload = receipt?.payload;
  const payloadDigest = payload && typeof payload === "object" && !Array.isArray(payload)
    ? digestObject(payload)
    : null;
  const producer = producerId(record);
  let payloadSchemaValid = false;
  if (definition && payload && typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload).length > 0) {
    try {
      assertPayloadFields(payload, definition.requiredFields, kind, definition.nullableFields ?? []);
      payloadSchemaValid = satisfiesRecordedSuccess(payload, definition);
    } catch {
      payloadSchemaValid = false;
    }
  }
  const independentCritic = record?.sourceKind === "independent-critic";
  const structurallyValid = Boolean(
    record?.schemaVersion === 2 &&
    EVIDENCE_ID.test(String(record?.id ?? "")) &&
    SAFE_ID.test(String(record?.kind ?? "")) &&
    definition &&
    admission &&
    receipt &&
    record.status === "complete" &&
    nonEmptyText(record.summary) &&
    receipt.contractId === definition.id &&
    receipt.contractId === evidenceContractId(kind) &&
    admission.contractId === receipt.contractId &&
    admission.contractVersion === 1 &&
    receipt.contractVersion === 1 &&
    receipt.runId === raw.runId &&
    producer &&
    definition.producerAllowlist.includes(producer) &&
    recordedFreshnessBindingValid(binding, raw, contractDigest, definition, payload) &&
    payloadSchemaValid &&
    DIGEST.test(String(payloadDigest ?? "")) &&
    receipt.payloadDigest === payloadDigest &&
    record.sourceDigest === payloadDigest &&
    safeTimestamp(receipt.producedAt) !== null &&
    safeTimestamp(admission.admittedAt) !== null &&
    admission.producer === producer &&
    (independentCritic ? admission.independentCritic === true : admission.independentCritic !== true) &&
    record.stale !== true
  );
  let valid = structurallyValid;
  if (valid) {
    try {
      await assertRecordedEvidenceSemantics(record, raw);
    } catch {
      valid = false;
    }
  }
  const unverifiable = structurallyValid && !valid && (
    independentCritic || kind === "self-improve-delivery-handoff"
  );
  return {
    valid,
    id,
    kind,
    digest: valid ? payloadDigest : safeDigest(record?.sourceDigest),
    blocker: valid
      ? null
      : unverifiable
        ? `UNVERIFIABLE_TYPED_EVIDENCE:${id}:${kind}`
        : `INVALID_TYPED_EVIDENCE:${id}`
  };
}

function recordTimestamp(record) {
  return safeTimestamp(record?.receipt?.producedAt) ?? safeTimestamp(record?.updatedAt) ?? safeTimestamp(record?.createdAt);
}

async function sanitizeEvidence(records, raw, contractDigest, contracts, blockers) {
  const validRecords = new Set();
  const projected = await Promise.all(records.map(async (record) => {
    if (raw.contract?.schemaVersion !== 2) {
      return {
        category: "evidence",
        id: safeId(record?.id),
        kind: safeId(record?.kind),
        status: "unknown",
        stale: record?.stale === true,
        severity: null,
        producer: null,
        producedAt: recordTimestamp(record),
        digest: safeDigest(record?.sourceDigest)
      };
    }
    const validation = await validateRecordedEvidence(record, raw, contractDigest, contracts);
    if (validation.valid) validRecords.add(record);
    else blockers.push(validation.blocker);
    return {
      category: "evidence",
      id: validation.id,
      kind: validation.kind,
      status: validation.valid ? "complete" : "invalid",
      stale: record?.stale === true,
      severity: null,
      producer: producerId(record),
      producedAt: recordTimestamp(record),
      digest: validation.digest
    };
  }));
  projected.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  return { records: projected, validRecords };
}

function sanitizeFindings(records, category = "finding") {
  return records.map((record) => ({
    category,
    id: safeId(record?.id ?? record?.findingId),
    kind: safeId(record?.rule ?? record?.kind ?? "finding"),
    status: safeStatus(record?.status ?? record?.verification?.verdict),
    stale: record?.stale === true,
    severity: ["P0", "P1", "P2", "P3"].includes(record?.severity) ? record.severity : null,
    producer: null,
    producedAt: recordTimestamp(record),
    digest: safeDigest(record?.sourceDigest ?? record?.digest)
  })).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}

function sanitizeActions(records) {
  return records.map((record) => ({
    category: "action",
    id: safeId(record?.attemptId ?? record?.id),
    kind: safeId(record?.action ?? "action"),
    status: safeStatus(record?.outcome ?? record?.status),
    stale: false,
    severity: null,
    producer: SAFE_ID.test(String(record?.provider ?? "")) ? String(record.provider) : null,
    producedAt: safeTimestamp(record?.reconciledAt) ?? safeTimestamp(record?.createdAt),
    digest: null
  })).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}

function sanitizeReview(records) {
  return records.map((record) => ({
    category: "review",
    id: safeId(record?.packageId ?? record?.id),
    kind: record?.broadReview?.complete === true ? "broad-review" : "review-package",
    status: record?.broadReview?.complete === true ? "complete" : "open",
    stale: false,
    severity: null,
    producer: null,
    producedAt: safeTimestamp(record?.broadReview?.completedAt) ?? safeTimestamp(record?.createdAt),
    digest: safeDigest(record?.digest ?? record?.packageDigest)
  })).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function recordedReferenceTime(raw) {
  const timestamp = safeTimestamp(raw.state?.updatedAt) ?? safeTimestamp(raw.manifest?.createdAt);
  return timestamp ? Date.parse(timestamp) : null;
}

function findingCompletionBlockers(records, raw, prefix = "FINDING") {
  const referenceTime = recordedReferenceTime(raw);
  const blockers = [];
  for (const record of records) {
    const id = safeId(record?.id ?? record?.findingId);
    const status = String(record?.status ?? "open").toLowerCase();
    if (["P0", "P1"].includes(record?.severity) && status === "open") {
      blockers.push(`OPEN_${record.severity}:${id}`);
    }
    if (status === "accepted-risk") {
      const expiry = safeTimestamp(record?.expiry);
      if (
        record?.severity === "P0" ||
        !nonEmptyText(record?.owner) ||
        !nonEmptyText(record?.reason) ||
        !expiry ||
        referenceTime === null ||
        Date.parse(expiry) <= referenceTime
      ) {
        blockers.push(`INVALID_ACCEPTED_RISK:${id}`);
      }
    }
    if (["resolved", "rejected-with-evidence"].includes(status) && !nonEmptyText(record?.evidenceId)) {
      blockers.push(`INVALID_${prefix}_DISPOSITION:${id}`);
    }
  }
  return blockers;
}

function findingDispositionEvidenceBlockers(records, raw, validRecords, {
  prefix = "FINDING",
  reviewPackage = null
} = {}) {
  const blockers = [];
  for (const record of records) {
    const status = String(record?.status ?? "open").toLowerCase();
    if (!["resolved", "rejected-with-evidence"].includes(status) || !nonEmptyText(record?.evidenceId)) continue;
    const findingId = safeId(record?.id ?? record?.findingId);
    const matches = raw.directories.evidence.filter((candidate) => candidate?.id === record.evidenceId);
    const evidence = matches.length === 1 ? matches[0] : null;
    const payload = evidence?.receipt?.payload;
    let bound = Boolean(
      evidence &&
      validRecords.has(evidence) &&
      Array.isArray(payload?.findingIds) &&
      payload.findingIds.filter((candidate) => candidate === (record?.id ?? record?.findingId)).length === 1
    );
    if (reviewPackage !== null) {
      bound = Boolean(
        bound &&
        evidence.kind === "patch-review" &&
        reviewPackage.schemaVersion === 1 &&
        reviewPackage.immutable === true &&
        payload.packageId === reviewPackage.packageId &&
        payload.base === reviewPackage.base &&
        payload.head === reviewPackage.head &&
        payload.scopeDigest === reviewPackage.scopeDigest &&
        payload.diffManifestDigest === reviewPackage.diffManifestDigest
      );
    }
    if (!bound) blockers.push(`INVALID_${prefix}_DISPOSITION:${findingId}`);
  }
  return blockers;
}

function actionCompletionBlockers(records) {
  const blockers = [];
  for (const record of records) {
    const id = safeId(record?.attemptId ?? record?.id);
    const status = String(record?.status ?? "unknown").toLowerCase();
    const outcome = String(record?.outcome ?? "unknown").toLowerCase();
    if (status !== "spent" || outcome !== "success") {
      blockers.push(`SIDE_EFFECT_NOT_RECONCILED:${id}`);
    }
  }
  return blockers;
}

function matchingValidEvidence(raw, validRecords, predicate) {
  return raw.directories.evidence.filter((record) => (
    validRecords.has(record) && predicate(record)
  ));
}

function reviewPackageBindingBlockers(reviewPackage, raw, contractDigest) {
  const blockers = [];
  const packageId = safeId(reviewPackage?.packageId ?? reviewPackage?.id);
  const expectedHead = safeRevision(raw.manifest?.sourceBinding?.headRevision);
  if (
    !reviewPackage ||
    reviewPackage.immutable !== true ||
    ![1, 2].includes(reviewPackage.schemaVersion) ||
    reviewPackage.head !== expectedHead ||
    reviewPackage.contractDigest !== contractDigest ||
    reviewPackage.templateDigest !== raw.contract?.templateDigest ||
    reviewPackage.sentinelDigest !== raw.state?.lastSentinel?.digest
  ) {
    blockers.push(`REVIEW_PACKAGE_BINDING_INVALID:${packageId}`);
  }
  if (!Array.isArray(reviewPackage?.scope) || reviewPackage.scopeDigest !== digestObject(reviewPackage.scope)) {
    blockers.push(`REVIEW_SCOPE_BINDING_INVALID:${packageId}`);
  }
  if (
    !reviewPackage?.diffManifest ||
    typeof reviewPackage.diffManifest !== "object" ||
    Array.isArray(reviewPackage.diffManifest) ||
    reviewPackage.diffManifestDigest !== digestObject(reviewPackage.diffManifest)
  ) {
    blockers.push(`REVIEW_DIFF_BINDING_INVALID:${packageId}`);
  }
  return blockers;
}

function legacyReviewBlockers(raw, reviewPackage, validRecords) {
  const packageId = safeId(reviewPackage?.packageId ?? reviewPackage?.id);
  const scopedFindings = raw.directories["review-findings"].filter((record) => record?.packageId === reviewPackage?.packageId);
  const blockers = [
    ...findingCompletionBlockers(scopedFindings, raw, "REVIEW_FINDING"),
    ...findingDispositionEvidenceBlockers(scopedFindings, raw, validRecords, {
      prefix: "REVIEW_FINDING",
      reviewPackage
    })
  ];
  const open = scopedFindings.filter((record) => String(record?.status ?? "open").toLowerCase() === "open");
  if (open.length > 0) blockers.push(`REVIEW_SCOPED_CLOSURE_REQUIRED:${packageId}`);
  if (Number(reviewPackage?.repairRounds) >= 5 && open.some((record) => ["P0", "P1"].includes(record?.severity))) {
    blockers.push(`REVIEW_REPAIR_BUDGET_EXHAUSTED:${packageId}`);
  }

  const broadReview = reviewPackage?.broadReview;
  if (
    broadReview?.complete !== true ||
    broadReview.head !== reviewPackage?.head ||
    broadReview.sentinelDigest !== raw.state?.lastSentinel?.digest ||
    broadReview.findingSetDigest !== digestObject(scopedFindings)
  ) {
    blockers.push(`REVIEW_BROAD_CLOSURE_REQUIRED:${packageId}`);
  }

  const diffReview = matchingValidEvidence(raw, validRecords, (record) => {
    const payload = record?.receipt?.payload;
    return record?.kind === "diff-review" && payload?.verdict === "PASS" &&
      payload.packageId === reviewPackage?.packageId &&
      payload.base === reviewPackage?.base &&
      payload.head === reviewPackage?.head &&
      payload.scopeDigest === reviewPackage?.scopeDigest &&
      payload.diffManifestDigest === reviewPackage?.diffManifestDigest &&
      payload.instructionDigest === reviewPackage?.instructionDigest;
  });
  if (diffReview.length !== 1) blockers.push(`REVIEW_DIFF_EVIDENCE_REQUIRED:${packageId}`);
  return blockers;
}

function kernelReviewBlockers(reviewPackage) {
  // review-kernel-v2 derives closure from signed axis and verification receipts,
  // exact anchors, coverage, synthesis, and current source blobs. Reconstructing
  // only its stored summaries would create a second, weaker authority path.
  // Replay therefore presents the records but never promotes a v2 terminal run
  // to RECORDED_COMPLETED without the authoritative reducer.
  return [`REVIEW_KERNEL_REPLAY_REQUIRES_REVERIFICATION:${safeId(reviewPackage?.packageId ?? reviewPackage?.id)}`];
}

function independentReviewBlockers(raw, reviewPackage, validRecords) {
  if (!["deep", "critical"].includes(raw.manifest?.mode)) return [];
  const binding = {
    packageId: reviewPackage?.packageId,
    base: reviewPackage?.base,
    head: reviewPackage?.head,
    scopeDigest: reviewPackage?.scopeDigest,
    diffManifestDigest: reviewPackage?.diffManifestDigest,
    instructionDigest: reviewPackage?.instructionDigest,
    sentinelDigest: raw.state?.lastSentinel?.digest
  };
  const matches = matchingValidEvidence(raw, validRecords, (record) => (
    record?.sourceKind === "independent-critic" &&
    record?.kind === "patch-review" &&
    record?.typedAdmission?.independentCritic === true &&
    record?.receipt?.payload?.verdict === "PASS" &&
    record?.review?.verdict === "PASS" &&
    record?.providerExecution?.modelAssurance === "host-signed-attestation" &&
    record?.providerExecution?.trustAttested === true &&
    Object.entries(binding).every(([key, value]) => record?.dependencies?.reviewBinding?.[key] === value)
  ));
  return matches.length === 1 ? [] : ["INDEPENDENT_REVIEW_REQUIRED"];
}

function reviewCompletionBlockers(raw, contractDigest, validRecords) {
  const policy = raw.contract?.controlPlane?.reviewPolicy ?? "none";
  if (policy === "none") return [];
  const expectedHead = safeRevision(raw.manifest?.sourceBinding?.headRevision);
  const matchingPackages = raw.directories["review-packages"].filter((record) => record?.head === expectedHead);
  if (matchingPackages.length !== 1) return ["REVIEW_CURRENT_PACKAGE_REQUIRED"];
  const reviewPackage = matchingPackages[0];
  const blockers = reviewPackageBindingBlockers(reviewPackage, raw, contractDigest);
  if (reviewPackage.schemaVersion === 1) blockers.push(...legacyReviewBlockers(raw, reviewPackage, validRecords));
  else if (reviewPackage.schemaVersion === 2) blockers.push(...kernelReviewBlockers(reviewPackage));
  else blockers.push("REVIEW_PACKAGE_SCHEMA_UNSUPPORTED");
  blockers.push(...independentReviewBlockers(raw, reviewPackage, validRecords));
  return blockers;
}

function recordedCompletionBlockers(raw, contractDigest, validRecords, validTypedKinds) {
  if (raw.contract?.schemaVersion !== 2) return [];
  const blockers = [
    ...findingCompletionBlockers(raw.directories.findings, raw),
    ...findingDispositionEvidenceBlockers(raw.directories.findings, raw, validRecords),
    ...actionCompletionBlockers(raw.directories.actions),
    ...reviewCompletionBlockers(raw, contractDigest, validRecords)
  ];
  if (raw.state?.lastSentinelVerified !== true) blockers.push("CURRENT_SENTINEL_NOT_VERIFIED");
  if (raw.state?.lastSentinelComplete !== true) blockers.push("BOUNDED_SENTINEL_INCOMPLETE");

  const availableKinds = new Set(validTypedKinds);
  for (const kind of Array.isArray(raw.contract?.requiredEvidence) ? raw.contract.requiredEvidence : []) {
    if (!availableKinds.has(kind)) blockers.push(`MISSING_TYPED_EVIDENCE:${safeId(kind)}`);
  }
  const acceptanceEvidence = raw.contract?.acceptanceEvidence;
  for (const item of Array.isArray(raw.contract?.acceptance) ? raw.contract.acceptance : []) {
    const required = Array.isArray(acceptanceEvidence?.[item?.id])
      ? acceptanceEvidence[item.id]
      : Array.isArray(raw.contract?.requiredEvidence) ? raw.contract.requiredEvidence : [];
    if (required.some((kind) => !availableKinds.has(kind))) {
      blockers.push(`MISSING_TYPED_ACCEPTANCE:${safeId(item?.id)}`);
    }
  }
  if (raw.contract?.controlPlane?.ledgerPolicy === "ledger-v1" && !raw.ledger) {
    blockers.push("LEDGER_NOT_FOUND");
  }
  return blockers;
}

function outcomeFromState(raw, blockers, ledgerStatus) {
  const status = String(raw.state?.status ?? "unknown").toLowerCase();
  if (status.startsWith("cancelled")) return "CANCELLED";
  if (status === "inconclusive") return "INCONCLUSIVE";
  if (status === "indeterminate") return "INDETERMINATE";
  if (["stale", "blocked", "hold", "failed_terminal", "blocked_external_reviewer"].includes(status)) return "HOLD";
  if (raw.contract?.schemaVersion !== 2) {
    if (["completed", "no_op"].includes(status)) return "LEGACY_RECORDED";
    if (["running", "pending", "ready", "failed_retryable"].includes(status)) return "UNSEALED";
    return "INDETERMINATE";
  }
  if (["completed", "no_op"].includes(status)) {
    return blockers.length === 0 && (!raw.ledger || ledgerStatus?.complete === true)
      ? "RECORDED_COMPLETED"
      : "HOLD";
  }
  if (["running", "pending", "ready", "failed_retryable"].includes(status)) return "UNSEALED";
  return "INDETERMINATE";
}

function sceneState(definition, records, outcome, ledgerStatus, raw) {
  if (definition.short === "Goal") return raw.contract ? "complete" : "unknown";
  if (definition.short === "Source") {
    if (raw.state?.lastSentinelVerified === true && raw.state?.lastSentinelComplete === true) return "complete";
    return raw.state?.lastSentinel ? "blocked" : "waiting";
  }
  if (definition.short === "Ledger") {
    if (!raw.ledger) return raw.contract?.schemaVersion === 2 ? "unknown" : "not-applicable";
    if (ledgerStatus?.blockers?.length) return "blocked";
    return ledgerStatus?.complete ? "complete" : ledgerStatus?.nextSlice ? "active" : "waiting";
  }
  if (definition.short === "Reconcile") {
    return outcome === "RECORDED_COMPLETED" ? "complete"
      : ["HOLD", "INCONCLUSIVE", "INDETERMINATE"].includes(outcome) ? "blocked"
        : outcome === "CANCELLED" ? "not-applicable" : "active";
  }
  if (records.some((record) => ["invalid", "blocked", "inconclusive", "indeterminate", "unknown"].includes(record.status))) return "blocked";
  if (records.some((record) => ["open", "pending", "ready", "running", "in_progress", "issued"].includes(record.status))) return "active";
  return records.length > 0 ? "complete" : "waiting";
}

function buildScenes(records, outcome, ledgerStatus, raw, blockers) {
  const ledgerRecords = raw.ledger ? [{
    category: "ledger",
    id: safeId(raw.ledger.runId, raw.runId),
    kind: "deterministic-ledger",
    status: ledgerStatus?.blockers?.length ? "blocked" : ledgerStatus?.complete ? "complete" : "running",
    stale: false,
    severity: null,
    producer: "root",
    producedAt: safeTimestamp(raw.ledger.createdAt),
    digest: safeDigest(digestObject(raw.ledger))
  }] : [];
  const outcomeRecords = [{
    category: "outcome",
    id: raw.runId,
    kind: "recorded-outcome",
    status: outcome === "RECORDED_COMPLETED" ? "complete" : outcome.toLowerCase(),
    stale: false,
    severity: null,
    producer: null,
    producedAt: safeTimestamp(raw.state?.updatedAt),
    digest: null
  }];
  const sourceRecords = [{
    category: "source",
    id: raw.runId,
    kind: "source-binding",
    status: raw.state?.lastSentinelVerified === true && raw.state?.lastSentinelComplete === true ? "complete" : "unknown",
    stale: raw.state?.lastSentinelVerified !== true,
    severity: null,
    producer: "git",
    producedAt: safeTimestamp(raw.state?.updatedAt),
    digest: safeDigest(raw.manifest?.sourceBinding?.digest)
  }];
  const contractRecords = [{
    category: "contract",
    id: raw.runId,
    kind: "task-contract",
    status: raw.contract ? "complete" : "unknown",
    stale: false,
    severity: null,
    producer: "root",
    producedAt: safeTimestamp(raw.manifest?.createdAt),
    digest: safeDigest(digestObject(raw.contract))
  }];
  const all = [...records, ...ledgerRecords, ...outcomeRecords, ...sourceRecords, ...contractRecords];
  return SCENE_DEFINITIONS.map((definition) => {
    const sceneRecords = all.filter((record) => definition.categories.includes(record.category));
    const state = sceneState(definition, sceneRecords, outcome, ledgerStatus, raw);
    return {
      no: definition.no,
      short: definition.short,
      accent: definition.accent,
      image: definition.image,
      alt: `${definition.actor} 呈現 ${definition.short} 階段的證據重播插圖`,
      actor: definition.actor,
      role: definition.role,
      title: definition.title,
      dialogue: definition.dialogue,
      state,
      badge: state.toUpperCase().replaceAll("-", "_"),
      fact: blockers.length > 0 && definition.short === "Reconcile"
        ? `Fail closed blockers: ${blockers.join(", ")}`
        : "Sanitized recorded projection; presentation only.",
      source: null,
      records: sceneRecords
    };
  });
}

async function projectRawRun(raw) {
  if (raw.manifest?.runId !== raw.runId || raw.state?.runId !== raw.runId) {
    throw replayError("REPLAY_RUN_BINDING_MISMATCH", "Replay run records disagree on run identity", 422);
  }
  const blockers = [];
  const contractDigest = digestObject(raw.contract);
  if (raw.manifest?.contractDigest !== contractDigest) blockers.push("CONTRACT_DIGEST_MISMATCH");
  if (raw.contract?.schemaVersion === 2 && raw.ledger && raw.ledger.contractDigest !== contractDigest) blockers.push("LEDGER_CONTRACT_MISMATCH");
  if (raw.ledger && raw.ledger.runId !== raw.runId) blockers.push("LEDGER_RUN_MISMATCH");

  const contracts = raw.contract?.schemaVersion === 2 ? await loadEvidenceContracts() : {};
  const sanitizedEvidence = await sanitizeEvidence(raw.directories.evidence, raw, contractDigest, contracts, blockers);
  const evidence = sanitizedEvidence.records;
  const validTypedKinds = evidence.filter((record) => record.status === "complete" && !record.stale).map((record) => record.kind);
  blockers.push(...recordedCompletionBlockers(raw, contractDigest, sanitizedEvidence.validRecords, validTypedKinds));
  let ledgerStatus = null;
  if (raw.ledger) {
    try {
      ledgerStatus = reduceLedgerSnapshot(raw.ledger, validTypedKinds);
      blockers.push(...ledgerStatus.blockers.map((blocker) => `LEDGER:${blocker}`));
    } catch {
      blockers.push("INVALID_LEDGER");
    }
  }
  const findings = sanitizeFindings(raw.directories.findings);
  const reviewFindings = sanitizeFindings(raw.directories["review-findings"], "review-finding");
  const actions = sanitizeActions(raw.directories.actions);
  const review = sanitizeReview(raw.directories["review-packages"]);
  const records = [...evidence, ...findings, ...reviewFindings, ...actions, ...review];
  const uniqueBlockers = [...new Set(blockers)].sort();
  const outcome = outcomeFromState(raw, uniqueBlockers, ledgerStatus);
  if (!OUTCOMES.has(outcome)) throw replayError("REPLAY_OUTCOME_INVALID", "Replay outcome is invalid");
  const scenes = buildScenes(records, outcome, ledgerStatus, raw, uniqueBlockers);

  const manifest = {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    kind: REPLAY_MANIFEST_KIND,
    rendererVersion: 1,
    run: {
      runId: raw.runId,
      template: safeId(raw.manifest?.template),
      mode: safeId(raw.manifest?.mode),
      contractSchemaVersion: Number(raw.contract?.schemaVersion) || null,
      status: safeId(raw.state?.status),
      createdAt: safeTimestamp(raw.state?.createdAt ?? raw.manifest?.createdAt),
      updatedAt: safeTimestamp(raw.state?.updatedAt),
      snapshotClass: outcome
    },
    bindings: {
      contract: safeDigest(contractDigest),
      sourceBinding: safeDigest(raw.manifest?.sourceBinding?.digest),
      sourceHead: safeRevision(raw.manifest?.sourceBinding?.headRevision),
      sentinel: safeDigest(raw.state?.lastSentinel?.digest),
      ledger: raw.ledger ? safeDigest(digestObject(raw.ledger)) : null,
      evidenceSet: safeDigest(digestObject(evidence)),
      findingSet: safeDigest(digestObject([...findings, ...reviewFindings])),
      reviewSet: safeDigest(digestObject(review)),
      actionSet: safeDigest(digestObject(actions))
    },
    assurance: {
      outcome,
      presentationOnly: true,
      liveReverified: false,
      mutableSnapshot: outcome === "UNSEALED",
      blockers: uniqueBlockers
    },
    scenes
  };
  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    generatedAt: safeTimestamp(raw.state?.updatedAt) ?? safeTimestamp(raw.manifest?.createdAt),
    manifest,
    manifestDigest: digestObject(manifest)
  };
}

export async function buildReplaySnapshot(root, runId, options = {}) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const before = await captureRawRun(root, runId);
    if (typeof options.afterFirstRead === "function") await options.afterFirstRead({ attempt, before });
    const projected = await projectRawRun(before);
    const after = await captureRawRun(root, runId);
    if (before.identityDigest === after.identityDigest) return projected;
  }
  throw replayError("INDETERMINATE_SNAPSHOT_RACE", "Replay run changed while the snapshot was being built", 409);
}

async function runSummary(root, runId) {
  try {
    const snapshot = await buildReplaySnapshot(root, runId);
    return {
      runId,
      template: snapshot.manifest.run.template,
      mode: snapshot.manifest.run.mode,
      status: snapshot.manifest.run.status,
      updatedAt: snapshot.manifest.run.updatedAt,
      snapshotClass: snapshot.manifest.run.snapshotClass,
      manifestDigest: snapshot.manifestDigest
    };
  } catch (error) {
    return {
      runId,
      template: "unknown",
      mode: "unknown",
      status: "indeterminate",
      updatedAt: null,
      snapshotClass: "INDETERMINATE",
      manifestDigest: null,
      blockerCode: error instanceof ReplayError ? error.code : "REPLAY_READ_FAILED"
    };
  }
}

export async function listReplayRuns(root, { runId = null } = {}) {
  let canonicalRoot;
  try {
    canonicalRoot = await assertReadOnlyRoot(root);
  } catch (error) {
    if (error instanceof ReplayError && error.code === "REPLAY_STATE_ROOT_MISSING") {
      return {
        schemaVersion: 1,
        generatedAt: null,
        stateRootPresent: false,
        truncated: false,
        totalRuns: 0,
        runs: []
      };
    }
    throw error;
  }
  const runsDirectory = contained(canonicalRoot, path.join(canonicalRoot, "runs"));
  try {
    await assertPathComponents(canonicalRoot, runsDirectory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        schemaVersion: 1,
        generatedAt: null,
        stateRootPresent: true,
        truncated: false,
        totalRuns: 0,
        runs: []
      };
    }
    throw error;
  }
  const info = await lstat(runsDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw replayError("REPLAY_UNSAFE_RUNS_ROOT", "Replay runs root is unsafe", 400);
  }
  if (runId !== null) {
    const safeRunId = assertReplayRunId(runId);
    const summary = await runSummary(canonicalRoot, safeRunId);
    if (summary.blockerCode === "REPLAY_RUN_NOT_FOUND") {
      throw replayError("REPLAY_RUN_NOT_FOUND", "Replay run was not found", 404);
    }
    return {
      schemaVersion: 1,
      generatedAt: summary.updatedAt,
      stateRootPresent: true,
      truncated: false,
      totalRuns: 1,
      runs: [summary]
    };
  }
  const ids = [];
  let entries = 0;
  const directoryHandle = await opendir(runsDirectory);
  for await (const entry of directoryHandle) {
    entries += 1;
    if (entries > REPLAY_DIRECTORY_ENTRY_LIMIT) {
      throw replayError("REPLAY_TOO_MANY_RUNS", "Replay state root contains too many run entries", 413);
    }
    if (entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID.test(entry.name)) ids.push(entry.name);
  }
  const allIds = ids
    .sort()
    .reverse();
  const visibleIds = allIds.slice(0, REPLAY_RUN_LIST_LIMIT);
  const runs = [];
  for (const runId of visibleIds) runs.push(await runSummary(canonicalRoot, runId));
  runs.sort((left, right) => {
    const timestampOrder = String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
    return timestampOrder || right.runId.localeCompare(left.runId);
  });
  return {
    schemaVersion: 1,
    generatedAt: runs[0]?.updatedAt ?? null,
    stateRootPresent: true,
    truncated: allIds.length > visibleIds.length,
    totalRuns: allIds.length,
    runs
  };
}
