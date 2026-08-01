import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const VERSION = "3.0.0";
export const MODES = new Set(["auto", "direct", "verified", "deep", "critical"]);
export const RUN_STATES = new Set([
  "pending",
  "running",
  "completed",
  "failed_retryable",
  "failed_terminal",
  "stale",
  "no_op",
  "cancelled_superseded",
  "cancelled_evidence_sufficient",
  "blocked_external_reviewer",
  "inconclusive",
  "indeterminate"
]);
export const FINDING_STATES = new Set([
  "open",
  "resolved",
  "accepted-risk",
  "rejected-with-evidence"
]);

const RUN_ID = /^sbw-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULTS_PATH = path.join(PLUGIN_ROOT, "config", "defaults.json");
const DESTRUCTIVE_CLEANUP_ACTIONS = new Set([
  "actions.cancel",
  "pr.close",
  "branch.delete",
  "worktree.cleanup"
]);
const OWNED_RESOURCE_CREATION_ACTIONS = new Set([
  "branch.create",
  "worktree.create",
  "pr.create",
  "actions.dispatch"
]);
const OWNED_RESOURCE_CREATION_SCHEMAS = {
  "branch.create": {
    providers: new Set(["git"]),
    pattern: /^branch:[A-Za-z0-9._/-]+$/,
    prove: (receipt, resource) => (
      receipt.ref === resource.slice("branch:".length) &&
      typeof receipt.revision === "string" &&
      /^[a-f0-9]{7,64}$/i.test(receipt.revision)
    )
  },
  "worktree.create": {
    providers: new Set(["git"]),
    pattern: /^worktree:.+$/,
    prove: (receipt, resource) => (
      receipt.path === resource.slice("worktree:".length) &&
      typeof receipt.revision === "string" &&
      /^[a-f0-9]{7,64}$/i.test(receipt.revision)
    )
  },
  "pr.create": {
    providers: new Set(["github-cli"]),
    pattern: /^pull\/\d+$/,
    prove: (receipt, resource) => (
      receipt.number === Number(resource.slice("pull/".length)) &&
      typeof receipt.head === "string" && receipt.head.length > 0 &&
      typeof receipt.base === "string" && receipt.base.length > 0 &&
      typeof receipt.url === "string" && receipt.url.length > 0
    )
  },
  "actions.dispatch": {
    providers: new Set(["github-cli"]),
    pattern: /^(run|workflow):.+$/,
    prove: (receipt, resource) => {
      const separator = resource.indexOf(":");
      const kind = resource.slice(0, separator);
      const value = resource.slice(separator + 1);
      return (
        typeof receipt.runId === "string" && receipt.runId.length > 0 &&
        typeof receipt.url === "string" && receipt.url.length > 0 &&
        (kind === "run" ? receipt.runId === value : receipt.workflowName === value)
      );
    }
  }
};
const OWNED_RESOURCE = /^[^\0\r\n]{1,512}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const GIT_PUSH_RESOURCE = /^remote:([A-Za-z0-9._-]+):(refs\/heads\/[A-Za-z0-9._/-]+)$/;

const ACTION_PROVIDER_RECEIPT_SCHEMAS = {
  "branch.create:git": { proofKind: "git-branch-create" },
  "worktree.create:git": { proofKind: "git-worktree-create" },
  "git.commit:git": { proofKind: "git-commit" },
  "git.push:git": { proofKind: "git-push" },
  "branch.delete:git": { proofKind: "git-branch-delete" },
  "pr.create:github-cli": { proofKind: "github-pr-create" },
  "issue.create:github-cli": { proofKind: "github-issue-create" },
  "pr.close:github-cli": { proofKind: "github-pr-close" },
  "actions.dispatch:github-cli": { proofKind: "github-actions-dispatch" },
  "actions.cancel:github-cli": { proofKind: "github-actions-cancel" },
  "pr.merge:github-cli": { proofKind: "github-pr-merge" },
  "remote.sync:git": { proofKind: "git-remote-sync" },
  "worktree.cleanup:git": { proofKind: "git-worktree-cleanup" },
  "recipe.promote:local-workspace": { proofKind: "local-workspace:recipe.promote" },
  "artifact.promote:local-workspace": { proofKind: "local-workspace:artifact.promote" }
};
export function pluginRoot() {
  return PLUGIN_ROOT;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(value) {
  const hash = createHash("sha256");
  hash.update(Buffer.isBuffer(value) ? value : String(value));
  return hash.digest("hex");
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sorted(value));
}

export function digestObject(value) {
  return sha256(canonicalJson(value));
}

export function getStateRoot(env = process.env) {
  if (env.SBW_STATE_ROOT) return path.resolve(env.SBW_STATE_ROOT);
  const codexHome = env.CODEX_HOME
    ? path.resolve(env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sbw");
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function ensurePrivateDir(target) {
  if (await pathExists(target)) {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink directory: ${target}`);
    if (!info.isDirectory()) throw new Error(`Expected directory: ${target}`);
  } else {
    await mkdir(target, { recursive: true, mode: 0o700 });
  }
  await chmod(target, 0o700);
  return target;
}

export function safeJoin(root, ...parts) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...parts);
  const relative = path.relative(resolvedRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes root: ${target}`);
  }
  return target;
}

export async function assertNoSymlinkUnder(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = safeJoin(resolvedRoot, path.relative(resolvedRoot, path.resolve(target)));
  await ensurePrivateDir(resolvedRoot);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!(await pathExists(current))) break;
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink path component: ${current}`);
  }
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWriteJson(root, target, value) {
  const parent = path.dirname(target);
  await assertNoSymlinkUnder(root, parent);
  await ensurePrivateDir(parent);
  const temp = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temp, 0o600);
  await rename(temp, target);
  await chmod(target, 0o600);
  await fsyncDirectory(parent);
}

export async function readJson(root, target) {
  await assertNoSymlinkUnder(root, target);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error(`Unsafe JSON path: ${target}`);
  }
  return JSON.parse(await readFile(target, "utf8"));
}

export async function appendJournal(root, runDir, event, details = {}) {
  const target = safeJoin(runDir, "journal.jsonl");
  await assertNoSymlinkUnder(root, target);
  if (await pathExists(target)) {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`Unsafe journal path: ${target}`);
    }
  }
  const record = {
    at: nowIso(),
    event,
    ...details
  };
  const handle = await open(target, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(target, 0o600);
  return record;
}

export async function loadDefaults() {
  return JSON.parse(await readFile(DEFAULTS_PATH, "utf8"));
}

function riskValue(value) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0 || number > 3) {
    throw new Error("Risk dimensions must be integers from 0 to 3");
  }
  return number;
}

export function routeMode(contract, requested = "auto") {
  if (!MODES.has(requested)) throw new Error(`Unknown mode: ${requested}`);
  if (requested !== "auto") return requested;
  const risk = contract.risk ?? {};
  const values = [
    riskValue(risk.risk),
    riskValue(risk.uncertainty),
    riskValue(risk.blastRadius),
    riskValue(risk.irreversibility),
    riskValue(risk.evidenceGap)
  ];
  const [baseRisk, , blastRadius, irreversibility] = values;
  const score = values.reduce((sum, value) => sum + value, 0);
  if (irreversibility >= 3 || (baseRisk >= 3 && blastRadius >= 2) || score >= 11) return "critical";
  if (score >= 7) return "deep";
  if (score >= 3) return "verified";
  return "direct";
}

export function validateContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("TaskContract must be an object");
  }
  if (![1, 2].includes(contract.schemaVersion)) {
    throw new Error("TaskContract.schemaVersion must be 1 or 2");
  }
  if (typeof contract.goal !== "string" || !contract.goal.trim()) {
    throw new Error("TaskContract.goal is required");
  }
  if (typeof contract.template !== "string" || !contract.template) {
    throw new Error("TaskContract.template is required");
  }
  if (!contract.scope || !Array.isArray(contract.scope.include) || contract.scope.include.length === 0) {
    throw new Error("TaskContract.scope.include must be a non-empty array");
  }
  if (!Array.isArray(contract.acceptance) || contract.acceptance.length === 0) {
    throw new Error("TaskContract.acceptance must be a non-empty array");
  }
  if (!Array.isArray(contract.requiredEvidence)) {
    throw new Error("TaskContract.requiredEvidence must be an array");
  }
  const requiredEvidence = new Set();
  for (const kind of contract.requiredEvidence) {
    if (typeof kind !== "string" || !SAFE_ID.test(kind)) {
      throw new Error("Every required evidence kind must be a safe id");
    }
    if (requiredEvidence.has(kind)) throw new Error(`Duplicate required evidence kind: ${kind}`);
    requiredEvidence.add(kind);
  }
  const acceptanceIds = new Set();
  for (const item of contract.acceptance) {
    if (!item || typeof item.id !== "string" || !SAFE_ID.test(item.id)) {
      throw new Error("Every acceptance item needs a safe id");
    }
    if (acceptanceIds.has(item.id)) throw new Error(`Duplicate acceptance id: ${item.id}`);
    acceptanceIds.add(item.id);
    if (typeof item.description !== "string" || !item.description.trim()) {
      throw new Error(`Acceptance item ${item.id} needs a description`);
    }
  }
  if (!["public", "internal", "confidential", "regulated"].includes(contract.sensitivity)) {
    throw new Error("TaskContract.sensitivity is invalid");
  }
  for (const key of ["risk", "uncertainty", "blastRadius", "irreversibility", "evidenceGap"]) {
    riskValue(contract.risk?.[key]);
  }
  if (contract.authority?.rootOnlyMutation !== true) {
    throw new Error("TaskContract must require rootOnlyMutation");
  }
  if (contract.schemaVersion === 2) {
    const controlPlane = contract.controlPlane;
    if (!controlPlane || typeof controlPlane !== "object" || Array.isArray(controlPlane)) {
      throw new Error("TaskContract v2.controlPlane is required");
    }
    const policies = {
      evidencePolicy: new Set(["typed-v1"]),
      ledgerPolicy: new Set(["ledger-v1"]),
      reviewPolicy: new Set(["none", "static-v1", "code-v1", "finding-v1"]),
      designPacketPolicy: new Set(["none", "pilot-v1"]),
      refinementPolicy: new Set(["none", "pilot-v1"]),
      deliberationPolicy: new Set(["none", "allowed-v1"])
    };
    for (const [key, allowed] of Object.entries(policies)) {
      if (!allowed.has(controlPlane[key])) {
        throw new Error(`TaskContract v2.controlPlane.${key} is invalid`);
      }
    }
    if (!Array.isArray(contract.executionStages) || contract.executionStages.length === 0) {
      throw new Error("TaskContract v2.executionStages must be a non-empty array");
    }
    const stageIds = new Set();
    const stageBudgets = { regular: 3, review: 5, "side-effect": 1, authorization: 1 };
    for (const stage of contract.executionStages) {
      if (!stage || typeof stage.id !== "string" || !SAFE_ID.test(stage.id)) {
        throw new Error("Every TaskContract v2 execution stage needs a safe id");
      }
      if (stageIds.has(stage.id)) throw new Error(`Duplicate execution stage id: ${stage.id}`);
      stageIds.add(stage.id);
      if (!Array.isArray(stage.dependsOn ?? [])) throw new Error(`Stage ${stage.id} dependsOn must be an array`);
      if (!Array.isArray(stage.requiredEvidence ?? [])) {
        throw new Error(`Stage ${stage.id} requiredEvidence must be an array`);
      }
      const kind = String(stage.kind ?? "regular");
      if (!(kind in stageBudgets)) throw new Error(`Stage ${stage.id} kind is invalid`);
      if (stage.attemptBudget !== stageBudgets[kind]) {
        throw new Error(`Stage ${stage.id} must use the ${kind} attempt budget of ${stageBudgets[kind]}`);
      }
    }
    for (const stage of contract.executionStages) {
      for (const dependency of stage.dependsOn ?? []) {
        if (!stageIds.has(dependency)) throw new Error(`Stage ${stage.id} has unknown dependency: ${dependency}`);
      }
    }
    if (contract.actionStages !== undefined) {
      if (!contract.actionStages || typeof contract.actionStages !== "object" || Array.isArray(contract.actionStages)) {
        throw new Error("TaskContract v2.actionStages must be an object");
      }
      const actionGates = contract.actionGates ?? {};
      for (const [action, stageId] of Object.entries(contract.actionStages)) {
        if (!Object.hasOwn(actionGates, action)) {
          throw new Error(`TaskContract v2 action stage has no action gate: ${action}`);
        }
        if (typeof stageId !== "string" || !stageIds.has(stageId)) {
          throw new Error(`TaskContract v2 action stage is unknown: ${action}`);
        }
      }
      for (const action of Object.keys(contract.actionGates ?? {})) {
        if (!Object.hasOwn(contract.actionStages, action)) {
          throw new Error(`TaskContract v2 action gate has no execution stage: ${action}`);
        }
      }
    } else if (Object.keys(contract.actionGates ?? {}).length > 0) {
      throw new Error("TaskContract v2 action gates require actionStages");
    }
    if (contract.acceptanceEvidence !== undefined) {
      if (!contract.acceptanceEvidence || typeof contract.acceptanceEvidence !== "object") {
        throw new Error("TaskContract v2.acceptanceEvidence must be an object");
      }
      for (const item of contract.acceptance) {
        const required = contract.acceptanceEvidence[item.id];
        if (!Array.isArray(required) || required.length === 0) {
          throw new Error(`TaskContract v2 acceptanceEvidence is missing ${item.id}`);
        }
      }
    }
  }
  return contract;
}

export function buildContract({
  template,
  templateDefinition,
  goal,
  scope = ["."],
  risk = {},
  sensitivity = "internal",
  authority = [],
  agyAllowed = false,
  agySanitized = false,
  volatileExclusions = [],
  highRiskIgnored = [],
  remoteRevision = null
}) {
  const acceptance = templateDefinition.acceptance ?? [
    { id: "task-complete", description: "The requested task is complete.", critical: true }
  ];
  const requiredEvidence = templateDefinition.requiredEvidence ?? [];
  const isV2 = templateDefinition.controlPlane && Array.isArray(templateDefinition.executionStages);
  const acceptanceEvidence = Object.fromEntries(
    acceptance.map((item) => [item.id, [...requiredEvidence]])
  );
  return validateContract({
    schemaVersion: isV2 ? 2 : 1,
    goal,
    template,
    scope: { include: scope, exclude: [] },
    acceptance,
    requiredEvidence,
    authority: {
      rootOnlyMutation: true,
      externalSideEffects: authority
    },
    risk: {
      risk: riskValue(risk.risk),
      uncertainty: riskValue(risk.uncertainty),
      blastRadius: riskValue(risk.blastRadius),
      irreversibility: riskValue(risk.irreversibility),
      evidenceGap: riskValue(risk.evidenceGap)
    },
    sensitivity,
    agy: { allowed: Boolean(agyAllowed), sanitized: Boolean(agySanitized) },
    volatileExclusions,
    highRiskIgnored,
    remoteRevision,
    ...(isV2
      ? {
          controlPlane: structuredClone(templateDefinition.controlPlane),
          executionStages: structuredClone(templateDefinition.executionStages),
          actionGates: structuredClone(templateDefinition.actionGates ?? {}),
          ...(templateDefinition.actionStages
            ? { actionStages: structuredClone(templateDefinition.actionStages) }
            : {}),
          acceptanceEvidence
        }
      : {})
  });
}

function generateRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `sbw-${stamp}-${randomBytes(6).toString("hex")}`;
}

export function runDirectory(root, runId) {
  if (!RUN_ID.test(runId)) throw new Error(`Invalid run id: ${runId}`);
  return safeJoin(root, "runs", runId);
}

export async function ensureStateRoot(root = getStateRoot()) {
  await ensurePrivateDir(root);
  await ensurePrivateDir(safeJoin(root, "runs"));
  return root;
}

export async function createRun({ root = getStateRoot(), contract, requestedMode = "auto", cwd, baselineRevision = null }) {
  validateContract(contract);
  const mode = routeMode(contract, requestedMode);
  if (mode === "direct") {
    return { runId: null, mode, direct: true, contractDigest: digestObject(contract) };
  }
  await ensureStateRoot(root);
  let runId;
  let runDir;
  let stagingDir;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    runId = generateRunId();
    runDir = runDirectory(root, runId);
    stagingDir = safeJoin(root, "runs", `.creating-${runId}`);
    try {
      await mkdir(stagingDir, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || attempt === 7) throw error;
    }
  }
  try {
    await chmod(stagingDir, 0o700);
    for (const child of ["evidence", "findings", "sentinels", "actions"]) {
      await ensurePrivateDir(safeJoin(stagingDir, child));
    }
    const createdAt = nowIso();
    const manifest = {
      schemaVersion: 1,
      runId,
      version: VERSION,
      template: contract.template,
      mode,
      requestedMode,
      cwd: path.resolve(cwd),
      baselineRevision,
      createdAt,
      contractDigest: digestObject(contract),
      authority: {
        rootOnlyMutation: true,
        nativeSubagentsAreTrustedContract: true
      },
      ownedResources: []
    };
    const state = {
      schemaVersion: 1,
      runId,
      status: "running",
      mode,
      createdAt,
      updatedAt: createdAt,
      lastSentinel: null,
      lastSentinelVerified: false,
      lastSentinelComplete: false,
      sideEffects: []
    };
    await atomicWriteJson(root, safeJoin(stagingDir, "contract.json"), contract);
    await atomicWriteJson(root, safeJoin(stagingDir, "manifest.json"), manifest);
    await atomicWriteJson(root, safeJoin(stagingDir, "state.json"), state);
    if (contract.schemaVersion === 2) {
      const { initializeLedger } = await import("./ledger.mjs");
      await initializeLedger(root, stagingDir, contract, runId);
    }
    await appendJournal(root, stagingDir, "run.created", { mode, requestedMode });
    await rename(stagingDir, runDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { runId, mode, direct: false, contractDigest: digestObject(contract) };
}

export async function loadRun(root, runId) {
  const runDir = runDirectory(root, runId);
  await assertNoSymlinkUnder(root, runDir);
  return {
    runDir,
    manifest: await readJson(root, safeJoin(runDir, "manifest.json")),
    contract: await readJson(root, safeJoin(runDir, "contract.json")),
    state: await readJson(root, safeJoin(runDir, "state.json"))
  };
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function withRunLock(root, runId, callback, options = {}) {
  const runDir = runDirectory(root, runId);
  const lockPath = safeJoin(runDir, ".lease");
  const token = randomBytes(24).toString("hex");
  const ttlMs = options.ttlMs ?? 60_000;
  let acquired = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({
          token,
          pid: process.pid,
          host: os.hostname(),
          createdAt: nowIso(),
          expiresAt: new Date(Date.now() + ttlMs).toISOString()
        })}\n`
      );
      await handle.sync();
      await handle.close();
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readJson(root, lockPath).catch(() => null);
      const expired = existing && Date.parse(existing.expiresAt) < Date.now();
      if (!expired || processAlive(existing?.pid)) {
        throw new Error(`Run is leased by pid ${existing?.pid ?? "unknown"}`);
      }
      await rename(lockPath, safeJoin(runDir, `.lease.stale.${randomUUID()}`));
    }
  }
  if (!acquired) throw new Error("Unable to acquire run lease");
  try {
    return await callback({ token, runDir });
  } finally {
    const existing = await readJson(root, lockPath).catch(() => null);
    if (existing?.token === token) await unlink(lockPath).catch(() => undefined);
  }
}

function assertProviderReceiptShape(record, providerReceipt, outcome = record.outcome) {
  const commonValid = (
    providerReceipt &&
    typeof providerReceipt === "object" &&
    !Array.isArray(providerReceipt) &&
    typeof providerReceipt.executionId === "string" &&
    providerReceipt.executionId.length > 0 &&
    typeof providerReceipt.proofKind === "string" &&
    providerReceipt.proofKind.length > 0 &&
    typeof providerReceipt.requestDigest === "string" &&
    SHA256_DIGEST.test(providerReceipt.requestDigest) &&
    typeof providerReceipt.responseDigest === "string" &&
    SHA256_DIGEST.test(providerReceipt.responseDigest) &&
    typeof providerReceipt.verifiedAt === "string" &&
    !Number.isNaN(Date.parse(providerReceipt.verifiedAt)) &&
    typeof providerReceipt.terminalState === "string" &&
    providerReceipt.terminalState.length > 0
  );
  if (!commonValid) throw new Error("Provider receipt lacks a structured execution proof");
  if (outcome === "success" && providerReceipt.terminalState !== "success") {
    throw new Error("Successful provider receipt must have terminalState success");
  }
  const schema = ACTION_PROVIDER_RECEIPT_SCHEMAS[`${record.action}:${record.provider}`];
  if (outcome === "success" && !schema) {
    throw new Error("Successful action requires an approved provider-specific receipt schema");
  }
  if (schema && providerReceipt.proofKind !== schema.proofKind) {
    throw new Error("Provider receipt proof kind does not match the action and provider");
  }
  if (!schema && providerReceipt.proofKind !== `${record.provider}:${record.action}`) {
    throw new Error("Provider receipt proof kind does not match the action and provider");
  }
  if (
    record.action === "branch.create" &&
    (!providerReceipt.created || typeof providerReceipt.ref !== "string" || !providerReceipt.ref ||
      typeof providerReceipt.revision !== "string" || !/^[a-f0-9]{7,64}$/i.test(providerReceipt.revision))
  ) {
    throw new Error("Git branch creation proof is incomplete");
  }
  if (
    record.action === "worktree.create" &&
    (!providerReceipt.created || typeof providerReceipt.path !== "string" || !providerReceipt.path ||
      typeof providerReceipt.revision !== "string" || !/^[a-f0-9]{7,64}$/i.test(providerReceipt.revision))
  ) {
    throw new Error("Git worktree creation proof is incomplete");
  }
  if (
    record.action === "git.commit" &&
    (!providerReceipt.created || typeof providerReceipt.revision !== "string" ||
      !/^[a-f0-9]{7,64}$/i.test(providerReceipt.revision))
  ) {
    throw new Error("Git commit proof is incomplete");
  }
  if (
    record.action === "git.push" &&
    (!providerReceipt.pushed || !GIT_PUSH_RESOURCE.test(record.resource) ||
      providerReceipt.remote !== GIT_PUSH_RESOURCE.exec(record.resource)?.[1] ||
      providerReceipt.ref !== GIT_PUSH_RESOURCE.exec(record.resource)?.[2] ||
      providerReceipt.remoteRepository !== record.remoteRepository ||
      providerReceipt.remoteUrlDigest !== record.remoteUrlDigest ||
      providerReceipt.expectedBranch !== record.expectedBranch ||
      providerReceipt.expectedRevision !== record.expectedRevision ||
      providerReceipt.localRevision !== record.expectedRevision ||
      typeof providerReceipt.revision !== "string" || !/^[a-f0-9]{7,64}$/i.test(providerReceipt.revision))
  ) {
    throw new Error("Git push proof is incomplete");
  }
  if (
    record.action === "branch.delete" &&
    (!providerReceipt.deleted || typeof providerReceipt.ref !== "string" || !providerReceipt.ref ||
      (record.resource.startsWith("branch:") && providerReceipt.ref !== record.resource.slice("branch:".length)))
  ) {
    throw new Error("Git branch deletion proof is incomplete");
  }
  if (
    record.action === "pr.create" &&
    (!providerReceipt.created || !Number.isInteger(providerReceipt.number) ||
      typeof providerReceipt.head !== "string" || !providerReceipt.head ||
      typeof providerReceipt.base !== "string" || !providerReceipt.base ||
      (record.targetRef && providerReceipt.base !== record.targetRef) ||
      typeof providerReceipt.url !== "string" || !providerReceipt.url)
  ) {
    throw new Error("GitHub pull request creation proof is incomplete");
  }
  if (
    record.action === "issue.create" &&
    (!providerReceipt.created || !Number.isInteger(providerReceipt.number) ||
      typeof providerReceipt.repository !== "string" || !providerReceipt.repository ||
      typeof providerReceipt.url !== "string" || !providerReceipt.url)
  ) {
    throw new Error("GitHub issue creation proof is incomplete");
  }
  if (
    record.action === "actions.dispatch" &&
    (!providerReceipt.created || typeof providerReceipt.runId !== "string" || !providerReceipt.runId ||
      typeof providerReceipt.url !== "string" || !providerReceipt.url ||
      providerReceipt.terminalState !== "success" ||
      !["SUCCESS", "success", "PASS", "pass"].includes(String(providerReceipt.conclusion)) ||
      (record.resource.startsWith("run:") && providerReceipt.runId !== record.resource.slice("run:".length)) ||
      (record.resource.startsWith("workflow:") && providerReceipt.workflowName !== record.resource.slice("workflow:".length)))
  ) {
    throw new Error("GitHub Actions dispatch proof is incomplete");
  }
  if (
    record.action === "pr.merge" &&
    (!Number.isInteger(providerReceipt.pr) ||
      providerReceipt.pr !== Number(String(record.resource).replace(/^pull\//, "")) ||
      providerReceipt.state !== "MERGED" ||
      typeof providerReceipt.repository !== "string" || !providerReceipt.repository ||
      typeof providerReceipt.baseRefName !== "string" || !providerReceipt.baseRefName ||
      (record.targetRef && providerReceipt.baseRefName !== record.targetRef) ||
      providerReceipt.mergeMethod !== record.mergeMethod ||
      providerReceipt.adminBypass !== false ||
      JSON.stringify(providerReceipt.mergeCommand) !== JSON.stringify(record.mergeCommand) ||
      typeof providerReceipt.head !== "string" || !providerReceipt.head ||
      typeof providerReceipt.mergeCommit !== "string" || !providerReceipt.mergeCommit)
  ) {
    throw new Error("GitHub pull request merge proof is incomplete");
  }
  if (
    record.action === "pr.close" &&
    (!Number.isInteger(providerReceipt.pr) ||
      providerReceipt.pr !== Number(String(record.resource).replace(/^pull\//, "")) ||
      providerReceipt.state !== "CLOSED" ||
      typeof providerReceipt.repository !== "string" || !providerReceipt.repository)
  ) {
    throw new Error("GitHub pull request close proof is incomplete");
  }
  if (
    record.action === "actions.cancel" &&
    (!providerReceipt.cancelled || typeof providerReceipt.runId !== "string" || !providerReceipt.runId ||
      providerReceipt.terminalState !== "cancelled" || providerReceipt.conclusion !== "CANCELLED")
  ) {
    throw new Error("GitHub Actions cancellation proof is incomplete");
  }
  if (
    record.action === "remote.sync" &&
    (typeof providerReceipt.ref !== "string" || !providerReceipt.ref ||
      providerReceipt.ref !== record.resource ||
      providerReceipt.remote !== record.remote ||
      typeof providerReceipt.repository !== "string" || !providerReceipt.repository ||
      providerReceipt.remoteRepository !== record.remoteRepository ||
      providerReceipt.remoteUrlDigest !== record.remoteUrlDigest ||
      typeof providerReceipt.providerRevision !== "string" ||
      !/^[a-f0-9]{7,64}$/i.test(providerReceipt.providerRevision) ||
      typeof providerReceipt.localRevision !== "string" ||
      !/^[a-f0-9]{7,64}$/i.test(providerReceipt.localRevision))
  ) {
    throw new Error("Git remote synchronization proof is incomplete");
  }
  if (
    record.action === "worktree.cleanup" &&
    (!providerReceipt.removed || typeof providerReceipt.path !== "string" || !providerReceipt.path)
  ) {
    throw new Error("Git worktree cleanup proof is incomplete");
  }
}

async function reserveProviderExecution(root, record, executionId) {
  const directory = safeJoin(root, "provider-executions");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = safeJoin(directory, `${sha256(executionId)}.json`);
  try {
    const handle = await open(target, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ executionId, runId: record.runId, attemptId: record.attemptId, recordedAt: nowIso() })}\n`);
    await handle.sync();
    await handle.close();
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Provider execution identity is already reserved globally");
    throw error;
  }
}

export async function registerOwnedResource(root, runId, { resource, creationReceipt }) {
  if (typeof resource !== "string" || !OWNED_RESOURCE.test(resource)) {
    throw new Error("Owned resource identity is invalid");
  }
  if (!creationReceipt || typeof creationReceipt !== "object" || Array.isArray(creationReceipt)) {
    throw new Error("Owned resource creation receipt is required");
  }
  if (
    creationReceipt.runId !== runId ||
    creationReceipt.ownerRunId !== runId ||
    creationReceipt.resource !== resource ||
    typeof creationReceipt.action !== "string" ||
    !creationReceipt.action ||
    !OWNED_RESOURCE_CREATION_ACTIONS.has(creationReceipt.action) ||
    typeof creationReceipt.attemptId !== "string" ||
    !creationReceipt.attemptId ||
    typeof creationReceipt.idempotencyKey !== "string" ||
    !creationReceipt.idempotencyKey ||
    typeof creationReceipt.remoteRevision !== "string" ||
    !creationReceipt.remoteRevision ||
    creationReceipt.outcome !== "success" ||
    typeof creationReceipt.provider !== "string" ||
    !creationReceipt.provider ||
    typeof creationReceipt.createdAt !== "string" ||
    Number.isNaN(Date.parse(creationReceipt.createdAt)) ||
    !Object.hasOwn(creationReceipt, "providerReceipt") ||
    !creationReceipt.providerReceipt ||
    typeof creationReceipt.providerReceipt !== "object" ||
    creationReceipt.providerReceipt.created !== true ||
    creationReceipt.providerReceipt.action !== creationReceipt.action ||
    creationReceipt.providerReceipt.resource !== resource ||
    creationReceipt.providerReceipt.outcome !== "success" ||
    creationReceipt.providerReceipt.runId !== runId ||
    creationReceipt.providerReceipt.attemptId !== creationReceipt.attemptId ||
    creationReceipt.providerReceipt.idempotencyKey !== creationReceipt.idempotencyKey ||
    creationReceipt.providerReceipt.remoteRevision !== creationReceipt.remoteRevision ||
    typeof creationReceipt.providerReceipt.executionId !== "string" ||
    !creationReceipt.providerReceipt.executionId
  ) {
    throw new Error("Owned resource creation receipt is not bound to this run and resource");
  }
  const receiptDigest = digestObject(creationReceipt);
  return withRunLock(root, runId, async ({ runDir }) => {
    const manifestPath = safeJoin(runDir, "manifest.json");
    const manifest = await readJson(root, manifestPath);
    const schema = OWNED_RESOURCE_CREATION_SCHEMAS[creationReceipt.action];
    assertProviderReceiptShape({
      action: creationReceipt.action,
      provider: creationReceipt.provider,
      resource
    }, creationReceipt.providerReceipt);
    if (
      !schema ||
      !schema.providers.has(creationReceipt.provider) ||
      !schema.pattern.test(resource) ||
      creationReceipt.providerReceipt.provider !== creationReceipt.provider ||
      !schema.prove(creationReceipt.providerReceipt, resource)
    ) {
      throw new Error("Owned resource creation receipt lacks action-specific provider creation proof");
    }
    await verifyProviderReceipt(
      manifest,
      {
        action: creationReceipt.action,
        provider: creationReceipt.provider,
        resource,
        outcome: "success",
        remoteRevision: creationReceipt.remoteRevision,
        idempotencyKey: creationReceipt.idempotencyKey,
        attemptId: creationReceipt.attemptId
      },
      { providerReceipt: creationReceipt.providerReceipt }
    );
    const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
    const creationAction = actions.find((action) => (
      action.attemptId === creationReceipt.attemptId &&
      action.status === "spent" &&
      action.outcome === "success" &&
      action.action === creationReceipt.action &&
      action.provider === creationReceipt.provider &&
      action.resource === resource &&
      digestObject(action.receipt?.providerReceipt) === digestObject(creationReceipt.providerReceipt)
    ));
    if (!creationAction) {
      throw new Error("Owned resource registration requires a reconciled successful run action");
    }
    if (!Array.isArray(manifest.ownedResources)) {
      throw new Error("Run manifest has no owned resource registry");
    }
    const existing = manifest.ownedResources.find((item) => item?.resource === resource);
    if (existing) {
      if (existing.ownerRunId !== runId || existing.receiptDigest !== receiptDigest) {
        throw new Error("Owned resource registration is immutable");
      }
      return existing;
    }
    const entry = {
      resource,
      ownerRunId: runId,
      receiptDigest,
      creationAttemptId: creationReceipt.attemptId,
      creationActionDigest: digestObject({
        attemptId: creationAction.attemptId,
        action: creationAction.action,
        resource: creationAction.resource,
        outcome: creationAction.outcome,
        receipt: creationAction.receipt
      }),
      registeredAt: nowIso()
    };
    const nextManifest = {
      ...manifest,
      ownedResources: [...manifest.ownedResources, entry]
    };
    await atomicWriteJson(root, manifestPath, nextManifest);
    await appendJournal(root, runDir, "resource.registered", entry);
    return entry;
  });
}

export async function bindLegacyRunTemplate(
  root,
  runId,
  { templateDigest, actionGates, requiredEvidence }
) {
  if (typeof templateDigest !== "string" || templateDigest.length < 16) {
    throw new Error("Legacy run migration requires a template digest");
  }
  if (!Array.isArray(requiredEvidence) || requiredEvidence.length === 0) {
    throw new Error("Legacy run migration requires template evidence minimums");
  }
  return withRunLock(root, runId, async ({ runDir }) => {
    const contractPath = safeJoin(runDir, "contract.json");
    const manifestPath = safeJoin(runDir, "manifest.json");
    const statePath = safeJoin(runDir, "state.json");
    const contract = await readJson(root, contractPath);
    const manifest = await readJson(root, manifestPath);
    const state = await readJson(root, statePath);
    const currentEvidence = new Set(contract.requiredEvidence ?? []);
    const missingEvidence = requiredEvidence.filter((kind) => !currentEvidence.has(kind));
    if (contract.templateDigest && contract.actionGates && missingEvidence.length === 0) {
      return { migrated: false, contract, manifest, state };
    }
    if (!["1.0.0", "2.0.1", "2.1.0", "2.5.0", "2.6.0"].includes(manifest.version)) {
      throw new Error(
        `Run ${runId} lacks current template minimums but was not created by a migratable workflow version`
      );
    }
    const nextContract = {
      ...contract,
      templateDigest,
      actionGates: structuredClone(actionGates ?? {}),
      requiredEvidence: [...new Set([...(contract.requiredEvidence ?? []), ...requiredEvidence])]
    };
    const migratedAt = nowIso();
    const nextManifest = {
      ...manifest,
      version: VERSION,
      migratedFromVersion: manifest.version,
      migratedAt,
      contractDigest: digestObject(nextContract)
    };
    const nextState = {
      ...state,
      status: "stale",
      updatedAt: migratedAt,
      lastSentinelVerified: false,
      lastSentinelComplete: false,
      migration: {
        kind: "legacy-template-binding",
        fromVersion: manifest.version,
        toVersion: VERSION,
        migratedAt
      }
    };
    const ledgerPath = safeJoin(runDir, "ledger.json");
    if (await pathExists(ledgerPath)) {
      const ledger = await readJson(root, ledgerPath);
      if (ledger.schemaVersion !== 1 || !Array.isArray(nextContract.executionStages)) {
        throw new Error("Legacy binding cannot safely reconcile the execution ledger");
      }
      const expectedTasks = nextContract.executionStages.map((stage) => ({
        id: String(stage.id),
        goal: String(stage.goal ?? stage.description ?? stage.id),
        dependencies: [...(stage.dependsOn ?? stage.dependencies ?? [])].map(String),
        requiredEvidence: [...(stage.requiredEvidence ?? [])].map(String),
        attemptBudget: Number(stage.attemptBudget ?? 3),
        kind: String(stage.kind ?? "regular")
      }));
      if (digestObject(ledger.tasks ?? []) !== digestObject(expectedTasks)) {
        throw new Error("Legacy binding cannot reconcile execution-stage identity drift");
      }
      await atomicWriteJson(root, ledgerPath, {
        ...ledger,
        contractDigest: nextManifest.contractDigest
      });
    }
    await atomicWriteJson(root, contractPath, nextContract);
    await atomicWriteJson(root, manifestPath, nextManifest);
    await atomicWriteJson(root, statePath, nextState);
    await appendJournal(root, runDir, "run.migrated", nextState.migration);
    return {
      migrated: true,
      contract: nextContract,
      manifest: nextManifest,
      state: nextState
    };
  });
}

export async function updateState(root, runId, mutator, event = "state.updated") {
  return withRunLock(root, runId, async ({ runDir }) => {
    const target = safeJoin(runDir, "state.json");
    const current = await readJson(root, target);
    const next = await mutator(structuredClone(current));
    if (!RUN_STATES.has(next.status)) throw new Error(`Invalid run state: ${next.status}`);
    next.updatedAt = nowIso();
    await atomicWriteJson(root, target, next);
    await appendJournal(root, runDir, event, { from: current.status, to: next.status });
    return next;
  });
}

export async function setRunStatus(root, runId, status, details = {}) {
  if (!RUN_STATES.has(status)) throw new Error(`Invalid run state: ${status}`);
  return updateState(
    root,
    runId,
    (state) => Object.assign(state, details, { status }),
    "run.status"
  );
}

function validateRecordId(id, kind) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) throw new Error(`Invalid ${kind} id`);
}

export async function addEvidence(root, runId, record) {
  const boundRun = await loadRun(root, runId);
  const admitted = boundRun.contract.schemaVersion === 2
    ? await (await import("./evidence.mjs")).admitTypedEvidence(record, { ...boundRun, root, requireReconciled: false })
    : record;
  record = admitted;
  validateRecordId(record.id, "evidence");
  if (record.status !== "complete") throw new Error("Evidence status must be complete");
  if (typeof record.kind !== "string" || typeof record.summary !== "string") {
    throw new Error("Evidence kind and summary are required");
  }
  if (!Array.isArray(record.acceptanceIds)) throw new Error("Evidence acceptanceIds must be an array");
  if (typeof record.sourceDigest !== "string" || record.sourceDigest.length < 16) {
    throw new Error("Evidence sourceDigest is required");
  }
  return withRunLock(root, runId, async ({ runDir }) => {
    const target = safeJoin(runDir, "evidence", `${record.id}.json`);
    if (await pathExists(target)) throw new Error(`Evidence already exists: ${record.id}`);
    const value = {
      schemaVersion: 1,
      stale: false,
      createdAt: nowIso(),
      dependencies: {},
      producer: {},
      ...record
    };
    await atomicWriteJson(root, target, value);
    await appendJournal(root, runDir, "evidence.added", { evidenceId: record.id });
    return value;
  });
}

function validateFinding(record) {
  validateRecordId(record.id, "finding");
  if (!["P0", "P1", "P2"].includes(record.severity)) throw new Error("Finding severity is invalid");
  if (!FINDING_STATES.has(record.status)) throw new Error("Finding status is invalid");
  if (typeof record.summary !== "string" || !record.summary.trim()) {
    throw new Error("Finding summary is required");
  }
  if (record.status === "accepted-risk") {
    if (record.severity === "P0") throw new Error("P0 findings cannot be accepted as risk");
    if (!record.owner || !record.reason || !record.expiry) {
      throw new Error("Accepted risk requires owner, reason, and expiry");
    }
    if (Date.parse(record.expiry) <= Date.now()) throw new Error("Accepted risk expiry must be in the future");
  }
  if (record.status === "rejected-with-evidence" && !record.evidenceId) {
    throw new Error("Rejected finding requires evidenceId");
  }
  return record;
}

export async function addFinding(root, runId, record, { update = false } = {}) {
  validateFinding(record);
  return withRunLock(root, runId, async ({ runDir }) => {
    const target = safeJoin(runDir, "findings", `${record.id}.json`);
    const exists = await pathExists(target);
    if (exists && !update) throw new Error(`Finding already exists: ${record.id}`);
    if (!exists && update) throw new Error(`Finding does not exist: ${record.id}`);
    const value = {
      schemaVersion: 1,
      createdAt: exists ? (await readJson(root, target)).createdAt : nowIso(),
      updatedAt: nowIso(),
      ...record
    };
    await atomicWriteJson(root, target, value);
    await appendJournal(root, runDir, update ? "finding.updated" : "finding.added", {
      findingId: record.id,
      status: record.status
    });
    return value;
  });
}

export async function listJsonRecords(root, directory) {
  if (!(await pathExists(directory))) return [];
  await assertNoSymlinkUnder(root, directory);
  const entries = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(entries.map((name) => readJson(root, safeJoin(directory, name))));
}

export async function evaluateCompletion(root, runId) {
  const { runDir, manifest, contract, state } = await loadRun(root, runId);
  const evidence = await listJsonRecords(root, safeJoin(runDir, "evidence"));
  const findings = await listJsonRecords(root, safeJoin(runDir, "findings"));
  const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
  const blockers = [];
  let completionReview = null;
  let admittedEvidence = evidence;
  for (const finding of findings) {
    if (["P0", "P1"].includes(finding.severity) && finding.status === "open") {
      blockers.push(`open-${finding.severity}:${finding.id}`);
    }
    if (
      finding.status === "accepted-risk" &&
      (!finding.owner || !finding.reason || Date.parse(finding.expiry) <= Date.now())
    ) {
      blockers.push(`invalid-accepted-risk:${finding.id}`);
    }
  }
  const availableEvidence = new Set(
    evidence
      .filter((item) => item.status === "complete" && !item.stale)
      .map((item) => item.kind)
  );
  if (contract.schemaVersion === 2) {
    const { isTypedEvidence, typedEvidenceKinds, validateTypedEvidenceRecord } = await import("./evidence.mjs");
    const validTypedEvidence = [];
    for (const record of evidence) {
      if (record.status === "complete" && !record.stale && !isTypedEvidence(record)) {
        blockers.push(`untyped-v2-evidence:${record.id}`);
      }
      if (isTypedEvidence(record)) {
        try {
          await validateTypedEvidenceRecord(record, { manifest, contract, root, runDir, requireReconciled: true });
          if (record.kind === "required-checks") {
            await verifyRequiredChecksProvider(manifest.cwd, record.receipt.payload);
          }
          validTypedEvidence.push(record);
        } catch (error) {
          blockers.push(`invalid-typed-evidence:${record.id ?? "unknown"}`);
        }
      }
    }
    admittedEvidence = validTypedEvidence;
    const typedKinds = typedEvidenceKinds(validTypedEvidence);
    for (const kind of contract.requiredEvidence) {
      if (!typedKinds.has(kind)) blockers.push(`missing-typed-evidence:${kind}`);
    }
    const acceptanceEvidence = contract.acceptanceEvidence ?? {};
    for (const item of contract.acceptance) {
      const required = acceptanceEvidence[item.id] ?? contract.requiredEvidence;
      if (required.some((kind) => !typedKinds.has(kind))) {
        blockers.push(`missing-typed-acceptance:${item.id}`);
      }
    }
    if (contract.controlPlane?.ledgerPolicy === "ledger-v1") {
      const { deriveLedgerStatus } = await import("./ledger.mjs");
      const ledger = await deriveLedgerStatus(root, runId);
      for (const blocker of ledger.blockers) blockers.push(`ledger:${blocker}`);
      if (!ledger.complete) blockers.push("ledger:not-complete");
    }
    if (contract.controlPlane?.reviewPolicy !== "none") {
      const { reviewStatus } = await import("./review.mjs");
      const review = await reviewStatus(root, runId);
      completionReview = review;
      if (!review.scopedClosed) blockers.push("review:scoped-closure-required");
      if (!review.broadReviewComplete) blockers.push("review:final-broad-review-required");
      if (review.openHigh.length > 0) blockers.push("review:open-high-findings");
    }
  } else {
    const covered = new Set(
      evidence
        .filter((item) => item.status === "complete" && !item.stale)
        .flatMap((item) => item.acceptanceIds)
    );
    for (const item of contract.acceptance) {
      if (!covered.has(item.id)) blockers.push(`missing-acceptance:${item.id}`);
    }
  }
  for (const kind of contract.requiredEvidence) {
    if (!availableEvidence.has(kind)) blockers.push(`missing-required-evidence:${kind}`);
  }
  if (!state.lastSentinelVerified) blockers.push("current-sentinel-not-verified");
  if (state.lastSentinelComplete !== true) blockers.push("bounded-sentinel-incomplete");
  if (["stale", "indeterminate", "inconclusive", "blocked_external_reviewer"].includes(state.status)) {
    blockers.push(`run-state:${state.status}`);
  }
  if (actions.some((action) => ["unknown", "pending", "failure"].includes(action.outcome))) {
    blockers.push("side-effect-not-reconciled");
  }
  if (
    contract.template === "pr-to-dev" &&
    availableEvidence.has("remote-sync") &&
    !actions.some((action) => (
      action.action === "remote.sync" &&
      action.status === "spent" &&
      action.outcome === "success" &&
      action.resource === "refs/heads/dev" &&
      action.receipt?.providerReceipt?.providerRevision === action.mergeCommit &&
      action.receipt?.providerReceipt?.localRevision === action.mergeCommit
    ))
  ) {
    blockers.push("missing-reconciled-action:remote.sync");
  }
  const { isIndependentCriticEvidence } = await import("./evidence.mjs");
  const hasIndependentCritic = admittedEvidence.some((item) => isIndependentCriticEvidence(item, {
    reviewPackage: completionReview?.package,
    sentinelDigest: state.lastSentinel?.digest
  }));
  if (["deep", "critical"].includes(manifest.mode) && !hasIndependentCritic) {
    blockers.push("missing-independent-critic");
  }
  if (
    manifest.mode === "critical" &&
    contract.agy?.required === true &&
    !admittedEvidence.some((item) => isIndependentCriticEvidence(item, {
      reviewPackage: completionReview?.package,
      sentinelDigest: state.lastSentinel?.digest
    }) && item.receipt?.producer?.provider === "agy")
  ) {
    blockers.push("missing-required-agy-critic");
  }
  return { ok: blockers.length === 0, blockers, evidence, findings, actions };
}

function assertCleanupResourceBinding(manifest, runId, request, cleanupPlan) {
  const payload = cleanupPlan?.receipt?.payload;
  if (
    !payload ||
    payload.ownerRunId !== runId ||
    payload.action !== request.action ||
    !Array.isArray(payload.resources)
  ) {
    throw new Error("Action token denied until cleanup resources are bound to this run and action");
  }
  const registry = Array.isArray(manifest.ownedResources)
    ? manifest.ownedResources.filter((entry) => entry && typeof entry === "object")
    : [];
  const registered = registry.find((entry) => entry.resource === request.resource);
  if (!registered || registered.ownerRunId !== runId || typeof registered.receiptDigest !== "string") {
    throw new Error("Action token denied until the cleanup resource has an immutable creation receipt");
  }
  const resources = payload.resources;
  const planned = resources.find((entry) => entry?.resource === request.resource);
  if (!planned || planned.ownerRunId !== runId || planned.receiptDigest !== registered.receiptDigest) {
    throw new Error("Action token denied until the cleanup plan matches the immutable resource registry");
  }
  for (const entry of resources) {
    const entryRegistered = registry.find((candidate) => candidate.resource === entry?.resource);
    if (
      !entryRegistered ||
      entry.ownerRunId !== runId ||
      entry.receiptDigest !== entryRegistered.receiptDigest ||
      typeof entry.resource !== "string" ||
      !OWNED_RESOURCE.test(entry.resource)
    ) {
      throw new Error("Action token denied until every cleanup resource is registry-bound");
    }
  }
}

function repositoryIdentity(value) {
  const raw = String(value ?? "").trim().replace(/\.git$/, "");
  if (!raw) return "";
  const ssh = raw.match(/^([^@]+)@([^:]+):(.+)$/);
  if (ssh) return `${ssh[2].toLowerCase()}/${ssh[3]}`;
  try {
    const parsed = new URL(raw);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return raw.toLowerCase();
  }
}

async function currentRepositoryIdentity(cwd) {
  const remote = (await execFileAsync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8"
  })).stdout.trim();
  const identity = repositoryIdentity(remote);
  if (!identity) throw new Error("PR merge requires a canonical origin repository identity");
  return identity;
}

async function currentGitProviderIdentity(cwd) {
  return (await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8"
  })).stdout.trim();
}

async function verifyPullRequestBeforeMerge(cwd, record) {
  const actual = JSON.parse((await execFileAsync("gh", [
    "pr", "view", String(record.pullRequest), "--json",
    "number,state,headRefOid,baseRefName,mergeable,mergeStateStatus"
  ], { cwd, encoding: "utf8" })).stdout);
  if (
    actual.number !== record.pullRequest ||
    actual.state !== "OPEN" ||
    actual.headRefOid !== record.reviewedHead ||
    (record.targetRef && actual.baseRefName !== record.targetRef) ||
    actual.mergeable !== "MERGEABLE" ||
    actual.mergeStateStatus !== "CLEAN"
  ) {
    throw new Error("Live pull request state is not an exact clean merge candidate");
  }
}

function assertRecomputedProviderReceipt(receipt, request, response, executionId) {
  if (
    receipt.requestDigest !== digestObject(request) ||
    receipt.responseDigest !== digestObject(response) ||
    receipt.executionId !== executionId
  ) {
    throw new Error("Provider receipt digests or execution identity do not match the observed provider result");
  }
}

async function verifyProviderReceipt(manifest, record, receipt) {
  if (record.outcome !== "success") return;
  const providerReceipt = receipt.providerReceipt;
  const cwd = manifest.cwd;
  const key = `${record.action}:${record.provider}`;
  if (key === "recipe.promote:local-workspace" || key === "artifact.promote:local-workspace") {
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, idempotencyKey: record.idempotencyKey },
      { kind: providerReceipt.kind, digest: providerReceipt.digest },
      `local-workspace:${record.action}:${record.attemptId}`
    );
    return;
  }
  if (key === "branch.create:git") {
    const expectedRef = record.resource.startsWith("branch:")
      ? record.resource.slice("branch:".length)
      : null;
    if (!expectedRef || providerReceipt.ref !== expectedRef) {
      throw new Error("Git branch creation proof is not bound to the requested resource");
    }
    const actual = (await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${providerReceipt.ref}^{commit}`], {
      cwd,
      encoding: "utf8"
    })).stdout.trim();
    const repository = await currentGitProviderIdentity(cwd);
    const response = { ref: providerReceipt.ref, revision: actual };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `git:${repository}:branch.create:${providerReceipt.ref}:${actual}`
    );
    if (actual !== providerReceipt.revision) throw new Error("Git branch creation proof does not match provider state");
    return;
  }
  if (key === "worktree.create:git") {
    const expectedPath = record.resource.startsWith("worktree:")
      ? record.resource.slice("worktree:".length)
      : null;
    if (!expectedPath || providerReceipt.path !== expectedPath) {
      throw new Error("Git worktree creation proof is not bound to the requested resource");
    }
    const output = (await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8"
    })).stdout;
    const blocks = output.split(/\n\n+/).map((block) => Object.fromEntries(
      block.split("\n").filter(Boolean).map((line) => {
        const separator = line.indexOf(" ");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
    ));
    const match = blocks.find((item) => item.worktree === providerReceipt.path);
    if (!match || match.HEAD !== providerReceipt.revision) {
      throw new Error("Git worktree creation proof does not match provider state");
    }
    const repository = await currentGitProviderIdentity(cwd);
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      { path: providerReceipt.path, revision: match.HEAD },
      `git:${repository}:worktree.create:${providerReceipt.path}:${match.HEAD}`
    );
    return;
  }
  if (key === "git.commit:git") {
    const actual = (await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd,
      encoding: "utf8"
    })).stdout.trim();
    const repository = await currentGitProviderIdentity(cwd);
    const response = { repository, revision: actual };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `git:${repository}:git.commit:${actual}`
    );
    if (actual !== providerReceipt.revision || (record.resource.startsWith("commit:") && actual !== record.resource.slice("commit:".length))) {
      throw new Error("Git commit proof does not match provider state");
    }
    return;
  }
  if (key === "git.push:git") {
    const [, remote, ref] = GIT_PUSH_RESOURCE.exec(record.resource) ?? [];
    const output = (await execFileAsync("git", ["ls-remote", remote, ref], {
      cwd,
      encoding: "utf8"
    })).stdout.trim();
    const revision = output.split(/\s+/)[0];
    if (!/^[a-f0-9]{40}$/i.test(revision)) throw new Error("Git push proof does not identify a remote revision");
    const remoteUrl = (await execFileAsync("git", ["remote", "get-url", remote], {
      cwd,
      encoding: "utf8"
    })).stdout.trim();
    const repository = repositoryIdentity(remoteUrl);
    const remoteUrlDigest = sha256(remoteUrl);
    if (repository !== record.remoteRepository || remoteUrlDigest !== record.remoteUrlDigest) {
      throw new Error("Git push proof does not match the remote bound when the action token was issued");
    }
    const localRevision = (await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd,
      encoding: "utf8"
    })).stdout.trim();
    if (localRevision !== record.expectedRevision || revision !== record.expectedRevision) {
      throw new Error("Git push proof does not match the candidate commit bound when the action token was issued");
    }
    const response = {
      repository,
      remote,
      ref,
      revision,
      localRevision,
      expectedBranch: record.expectedBranch,
      expectedRevision: record.expectedRevision,
      remoteUrlDigest
    };
    assertRecomputedProviderReceipt(
      providerReceipt,
      {
        action: record.action,
        provider: record.provider,
        resource: record.resource,
        remoteRevision: record.remoteRevision,
        repository,
        remote,
        ref,
        remoteRepository: record.remoteRepository,
        remoteUrlDigest: record.remoteUrlDigest,
        expectedBranch: record.expectedBranch,
        expectedRevision: record.expectedRevision
      },
      response,
      `git:${repository}:${remote}:git.push:${ref}:${revision}`
    );
    if (
      revision !== providerReceipt.revision ||
      providerReceipt.localRevision !== localRevision ||
      providerReceipt.expectedBranch !== record.expectedBranch ||
      providerReceipt.expectedRevision !== record.expectedRevision
    ) throw new Error("Git push proof does not match provider state");
    return;
  }
  if (key === "branch.delete:git") {
    const expectedRef = record.resource.startsWith("branch:") ? record.resource.slice("branch:".length) : null;
    if (!expectedRef || providerReceipt.ref !== expectedRef) throw new Error("Git branch deletion proof is not bound to the requested resource");
    const repository = await currentGitProviderIdentity(cwd);
    let present = true;
    try {
      await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${expectedRef}^{commit}`], { cwd, encoding: "utf8" });
    } catch {
      present = false;
    }
    if (present) throw new Error("Git branch deletion proof does not match provider state");
    const response = { ref: expectedRef, deleted: true };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `git:${repository}:branch.delete:${expectedRef}`
    );
    return;
  }
  if (key === "pr.create:github-cli") {
    const actual = JSON.parse((await execFileAsync("gh", [
      "pr", "view", String(providerReceipt.number), "--json", "number,headRefOid,baseRefName,url"
    ], { cwd, encoding: "utf8" })).stdout);
    const repository = await currentRepositoryIdentity(cwd);
    const response = {
      number: actual.number,
      head: actual.headRefOid,
      base: actual.baseRefName,
      url: actual.url
    };
    assertRecomputedProviderReceipt(
      providerReceipt,
      {
        action: record.action,
        provider: record.provider,
        resource: record.resource,
        remoteRevision: record.remoteRevision,
        repository,
        targetRef: record.targetRef ?? null
      },
      response,
      `github:${repository}:pr.create:${actual.number}:${actual.headRefOid}`
    );
    if (
      actual.number !== Number(String(record.resource).replace(/^pull\//, "")) ||
      actual.number !== providerReceipt.number ||
      actual.headRefOid !== providerReceipt.head ||
      actual.baseRefName !== providerReceipt.base ||
      (record.targetRef && actual.baseRefName !== record.targetRef) ||
      actual.url !== providerReceipt.url
    ) throw new Error("GitHub pull request creation proof does not match provider state");
    return;
  }
  if (key === "issue.create:github-cli") {
    const actual = JSON.parse((await execFileAsync("gh", [
      "issue", "view", String(providerReceipt.number), "--json", "number,state,url"
    ], { cwd, encoding: "utf8" })).stdout);
    const repository = await currentRepositoryIdentity(cwd);
    const response = { number: actual.number, state: actual.state, url: actual.url };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `github:${repository}:issue.create:${actual.number}`
    );
    if (
      actual.number !== providerReceipt.number ||
      actual.url !== providerReceipt.url ||
      providerReceipt.repository !== repository ||
      (record.resource.startsWith("issue/") && actual.number !== Number(record.resource.slice("issue/".length)))
    ) throw new Error("GitHub issue creation proof does not match provider state");
    return;
  }
  if (key === "actions.dispatch:github-cli") {
    const actual = JSON.parse((await execFileAsync("gh", [
      "run", "view", String(providerReceipt.runId), "--json", "databaseId,workflowName,url,status,conclusion,headSha"
    ], { cwd, encoding: "utf8" })).stdout);
    const repository = await currentRepositoryIdentity(cwd);
    const response = {
      runId: String(actual.databaseId),
      workflowName: actual.workflowName,
      url: actual.url,
      status: actual.status,
      conclusion: actual.conclusion,
      headSha: actual.headSha
    };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `github:${repository}:actions.dispatch:${actual.databaseId}`
    );
    if (
      String(actual.databaseId) !== String(providerReceipt.runId) ||
      actual.url !== providerReceipt.url ||
      actual.status !== "completed" ||
      actual.conclusion !== "SUCCESS" ||
      actual.headSha !== record.remoteRevision ||
      (record.resource.startsWith("workflow:") && actual.workflowName !== record.resource.slice("workflow:".length))
    ) throw new Error("GitHub Actions dispatch proof does not match provider state");
    return;
  }
  if (key === "actions.cancel:github-cli") {
    const actual = JSON.parse((await execFileAsync("gh", [
      "run", "view", String(providerReceipt.runId), "--json", "databaseId,status,conclusion,url"
    ], { cwd, encoding: "utf8" })).stdout);
    const repository = await currentRepositoryIdentity(cwd);
    const response = {
      runId: String(actual.databaseId),
      status: actual.status,
      conclusion: actual.conclusion,
      url: actual.url
    };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `github:${repository}:actions.cancel:${actual.databaseId}`
    );
    if (String(actual.databaseId) !== String(providerReceipt.runId) || actual.status !== "completed" || actual.conclusion !== "CANCELLED") {
      throw new Error("GitHub Actions cancellation proof does not match provider state");
    }
    return;
  }
  if (key === "pr.close:github-cli") {
    const actual = JSON.parse((await execFileAsync("gh", [
      "pr", "view", String(providerReceipt.pr), "--json", "number,state,url"
    ], { cwd, encoding: "utf8" })).stdout);
    const repository = await currentRepositoryIdentity(cwd);
    const response = { number: actual.number, state: actual.state, url: actual.url };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `github:${repository}:pr.close:${actual.number}`
    );
    if (actual.number !== providerReceipt.pr || actual.state !== "CLOSED" || providerReceipt.repository !== repository) {
      throw new Error("GitHub pull request close proof does not match provider state");
    }
    return;
  }
  if (key === "pr.merge:github-cli") {
    const actual = JSON.parse((await execFileAsync("gh", [
      "pr", "view", String(providerReceipt.pr), "--json", "number,state,headRefOid,baseRefName,mergeCommit"
    ], { cwd, encoding: "utf8" })).stdout);
    const mergeCommit = typeof actual.mergeCommit === "string" ? actual.mergeCommit : actual.mergeCommit?.oid;
    const repository = await currentRepositoryIdentity(cwd);
    const response = {
      number: actual.number,
      state: actual.state,
      head: actual.headRefOid,
      baseRefName: actual.baseRefName,
      mergeCommit
    };
    assertRecomputedProviderReceipt(
      providerReceipt,
      {
        action: record.action,
        provider: record.provider,
        resource: record.resource,
        remoteRevision: record.remoteRevision,
        repository,
        pr: actual.number,
        targetRef: record.targetRef ?? null,
        mergeMethod: record.mergeMethod,
        adminBypass: record.adminBypass,
        mergeCommand: record.mergeCommand
      },
      response,
      `github:${repository}:pr.merge:${actual.number}:${mergeCommit}`
    );
    if (
      actual.number !== Number(String(record.resource).replace(/^pull\//, "")) ||
      actual.number !== providerReceipt.pr ||
      actual.state !== "MERGED" ||
      actual.headRefOid !== providerReceipt.head ||
      actual.baseRefName !== providerReceipt.baseRefName ||
      mergeCommit !== providerReceipt.mergeCommit ||
      providerReceipt.repository !== repository
    ) throw new Error("GitHub pull request merge proof does not match provider state");
    return;
  }
  if (key === "remote.sync:git") {
    if (manifest.template === "pr-to-dev" && record.resource !== "refs/heads/dev") {
      throw new Error("pr-to-dev remote synchronization is restricted to refs/heads/dev");
    }
    const branchRef = /^refs\/heads\/(.+)$/.exec(record.resource)?.[1];
    if (!branchRef) throw new Error("Git remote synchronization resource must be refs/heads/<branch>");
    const remoteUrl = (await execFileAsync("git", ["remote", "get-url", record.remote], {
      cwd,
      encoding: "utf8"
    })).stdout.trim();
    const remoteRepository = repositoryIdentity(remoteUrl);
    const remoteUrlDigest = sha256(remoteUrl);
    if (remoteRepository !== record.remoteRepository || remoteUrlDigest !== record.remoteUrlDigest) {
      throw new Error("Git remote synchronization proof does not match the origin bound when the action token was issued");
    }
    const liveRemote = (await execFileAsync("git", ["ls-remote", record.remote, record.resource], {
      cwd,
      encoding: "utf8"
    })).stdout.trim();
    const providerRevision = liveRemote.split(/\s+/)[0];
    if (!/^[a-f0-9]{40}$/i.test(providerRevision)) {
      throw new Error("Git remote synchronization proof does not identify a live remote revision");
    }
    const localRevision = (await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${branchRef}^{commit}`], {
      cwd,
      encoding: "utf8"
    })).stdout.trim();
    const repository = await currentGitProviderIdentity(cwd);
    const response = {
      repository,
      ref: record.resource,
      remote: record.remote,
      remoteRepository,
      remoteUrlDigest,
      providerRevision,
      localRevision
    };
    assertRecomputedProviderReceipt(
      providerReceipt,
      {
        action: record.action,
        provider: record.provider,
        resource: record.resource,
        remoteRevision: record.remoteRevision,
        repository,
        ref: record.resource,
        remote: record.remote,
        remoteRepository,
        remoteUrlDigest
      },
      response,
      `git:${repository}:remote.sync:${record.resource}:${providerRevision}:${localRevision}`
    );
    if (
      providerRevision !== receipt.providerReceipt.providerRevision ||
      localRevision !== receipt.providerReceipt.localRevision ||
      providerReceipt.ref !== record.resource ||
      providerReceipt.repository !== repository
    ) {
      throw new Error("Git remote synchronization proof does not match provider state");
    }
    return;
  }
  if (key === "worktree.cleanup:git") {
    const expectedPath = record.resource.startsWith("worktree:")
      ? record.resource.slice("worktree:".length)
      : null;
    if (!expectedPath || providerReceipt.path !== expectedPath) {
      throw new Error("Git worktree cleanup proof is not bound to the requested resource");
    }
    const output = (await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8"
    })).stdout;
    const present = output.split(/\n\n+/).some((block) => block.split("\n").some((line) => line === `worktree ${providerReceipt.path}`));
    if (present) throw new Error("Git worktree cleanup proof does not match provider state");
    const repository = await currentGitProviderIdentity(cwd);
    const response = { path: providerReceipt.path, removed: true };
    assertRecomputedProviderReceipt(
      providerReceipt,
      { action: record.action, provider: record.provider, resource: record.resource, remoteRevision: record.remoteRevision, repository },
      response,
      `git:${repository}:worktree.cleanup:${providerReceipt.path}`
    );
  }
}

export async function verifyRequiredChecksProvider(cwd, payload) {
  if (payload.provider !== "github") throw new Error("Required checks must be observed from GitHub");
  const repository = repositoryIdentity(payload.repository);
  const prefix = "github.com/";
  if (!repository.startsWith(prefix)) throw new Error("Required checks repository is not a GitHub repository");
  if (!Array.isArray(payload.requiredStatusChecks) || payload.requiredStatusChecks.length === 0) {
    throw new Error("Required checks evidence must include the protected branch status-check set");
  }
  const repositoryPath = repository.slice(prefix.length);
  const protection = JSON.parse((await execFileAsync("gh", [
    "api",
    `repos/${repositoryPath}/branches/${encodeURIComponent(payload.baseRefName)}/protection/required_status_checks`
  ], { cwd, encoding: "utf8" })).stdout);
  const requiredStatusChecks = [...new Set([
    ...(Array.isArray(protection.contexts) ? protection.contexts : []),
    ...(Array.isArray(protection.checks) ? protection.checks.map((check) => check?.context ?? check?.name) : [])
  ].filter((value) => typeof value === "string" && value))].sort();
  if (digestObject(requiredStatusChecks) !== digestObject([...payload.requiredStatusChecks].sort())) {
    throw new Error("Required checks evidence does not match the protected branch status-check set");
  }
  const response = JSON.parse((await execFileAsync("gh", [
    "api",
    `repos/${repositoryPath}/actions/runs?head_sha=${encodeURIComponent(payload.head)}&per_page=100`
  ], { cwd, encoding: "utf8" })).stdout);
  const runs = (Array.isArray(response.workflow_runs) ? response.workflow_runs : [])
    .filter((run) => run?.head_sha === payload.head);
  if (!Number.isInteger(response.total_count) || response.total_count !== runs.length || runs.length === 0) {
    throw new Error("Required check provider response is not a complete GitHub workflow-run set");
  }
  const observedAt = Date.parse(payload.observedAt ?? "");
  const observedIds = new Set(payload.checks.map((check) => String(check.providerRunId)));
  const providerIds = new Set(runs.map((run) => String(run.id)));
  if (observedIds.size !== runs.length || observedIds.size !== payload.checks.length ||
      [...providerIds].some((id) => !observedIds.has(id))) {
    throw new Error("Required check evidence does not cover the complete GitHub workflow-run set");
  }
  const observedRequired = new Set(payload.checks.map((check) => check.providerName));
  if (requiredStatusChecks.some((name) => !observedRequired.has(name))) {
    throw new Error("Required check evidence does not include every protected status check");
  }
  for (const check of payload.checks) {
    const run = runs.find((candidate) => String(candidate.id) === String(check.providerRunId));
    if (
      !run ||
      run.head_sha !== payload.head ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      (check.providerName !== run.name && check.providerName !== run.workflow_name) ||
      check.name !== `${run.name ?? run.workflow_name}#${run.id}` ||
      (Number.isFinite(observedAt) && Date.parse(run.completed_at ?? "") > observedAt)
    ) {
      throw new Error(`Required check provider run is not a fresh successful GitHub run: ${check.providerRunId}`);
    }
  }
}

async function assertPullEvidenceBinding(admittedEvidence, request, reviewPackage, contract, expectedRepository) {
  const pullMatch = /^pull\/(\d+)$/.exec(request.resource);
  if (!pullMatch) throw new Error("PR merge resources must use pull/<number>");
  const expectedBaseRef = contract.template === "pr-to-dev" ? "dev" : null;
  for (const kind of ["pr-state", "required-checks"]) {
    if (!request.requiredEvidence.includes(kind)) continue;
    const records = admittedEvidence.filter((item) => item.kind === kind && item.status === "complete" && !item.stale);
    if (records.length === 0) continue;
    const exact = records.some((record) => {
      const payload = record.receipt?.payload;
      return (
        String(payload?.pr) === pullMatch[1] &&
        payload?.head === reviewPackage.head &&
        payload?.base === reviewPackage.base &&
        payload?.repository === expectedRepository &&
        (expectedBaseRef === null || payload?.baseRefName === expectedBaseRef)
      );
    });
    if (!exact) {
      throw new Error(`Action token denied until ${kind} is bound to the exact reviewed PR head`);
    }
  }
}

function assertTargetBranchEvidence(admittedEvidence, request, expectedRepository, expectedRevision) {
  if (!request.requiredEvidence.includes("target-branch-dev")) return;
  const records = admittedEvidence.filter((item) => item.kind === "target-branch-dev" && item.status === "complete" && !item.stale);
  const exact = records.some((record) => {
    const payload = record.receipt?.payload;
    return (
      payload?.repository === expectedRepository &&
      payload?.ref === "dev" &&
      (!expectedRevision || payload?.revision === expectedRevision)
    );
  });
  if (!exact) throw new Error("Action token denied until target-branch-dev is bound to the selected repository and dev revision");
}

function assertRemoteSyncMergeBinding(admittedEvidence, reviewPackage, contract, expectedRepository) {
  const exact = admittedEvidence
    .filter((item) => item.kind === "merge-result" && item.status === "complete" && !item.stale)
    .map((item) => item.receipt?.payload)
    .find((payload) => (
      payload?.outcome === "success" &&
      payload?.reviewPackageId === reviewPackage.packageId &&
      payload?.head === reviewPackage.head &&
      payload?.base === reviewPackage.base &&
      payload?.baseRefName === "dev" &&
      payload?.repository === expectedRepository &&
      Number.isInteger(payload?.pr) &&
      typeof payload?.mergeCommit === "string" && /^[a-f0-9]{40}$/i.test(payload.mergeCommit)
    ));
  if (!exact) throw new Error("Action token denied until merge-result is bound to the exact reviewed PR and merge");
  return {
    mergeCommit: exact.mergeCommit,
    pullRequest: exact.pr,
    reviewedHead: reviewPackage.head,
    reviewPackageId: reviewPackage.packageId
  };
}

export async function issueActionToken(root, runId, request, currentTreeDigest, config) {
  for (const field of ["action", "provider", "resource", "remoteRevision"]) {
    if (typeof request[field] !== "string" || !request[field]) throw new Error(`Action ${field} is required`);
  }
  return withRunLock(root, runId, async ({ runDir }) => {
    const contract = await readJson(root, safeJoin(runDir, "contract.json"));
    const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
    const state = await readJson(root, safeJoin(runDir, "state.json"));
    const findings = await listJsonRecords(root, safeJoin(runDir, "findings"));
    const evidence = await listJsonRecords(root, safeJoin(runDir, "evidence"));
    const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
    if (!state.lastSentinelVerified || state.lastSentinel?.digest !== currentTreeDigest) {
      throw new Error("Action token requires a verified current-tree sentinel");
    }
    if (state.lastSentinelComplete !== true) {
      throw new Error("Action token denied by incomplete bounded sentinel");
    }
    if (findings.some((item) => ["P0", "P1"].includes(item.severity) && item.status === "open")) {
      throw new Error("Action token denied by unresolved P0/P1 finding");
    }
    if (!Array.isArray(request.requiredEvidence) || request.requiredEvidence.length === 0) {
      throw new Error("Action token requires a declared pre-action evidence gate");
    }
    if (contract.schemaVersion === 2) {
      const configuredGate = contract.actionGates?.[request.action];
      if (!Array.isArray(configuredGate) || configuredGate.length === 0) {
        throw new Error(`No pre-action evidence gate is defined for: ${request.action}`);
      }
      if (
        request.requiredEvidence.length !== configuredGate.length ||
        request.requiredEvidence.some((kind, index) => kind !== configuredGate[index])
      ) {
        throw new Error("Action token denied because caller-selected evidence does not match the contract action gate");
      }
    }
    let admittedEvidence = evidence;
    if (contract.schemaVersion === 2) {
      const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
      for (const item of evidence.filter((record) => record.schemaVersion === 2 && record.typedAdmission)) {
        await validateTypedEvidenceRecord(item, {
          manifest,
          contract,
          root,
          runDir,
          requireReconciled: true
        });
      }
      admittedEvidence = evidence.filter((item) => item.schemaVersion === 2 && item.typedAdmission);
    }
    if (
      contract.actionStages &&
      Object.hasOwn(contract.actionStages, request.action) &&
      !ACTION_PROVIDER_RECEIPT_SCHEMAS[`${request.action}:${request.provider}`]
    ) {
      throw new Error(`Action provider pair is not supported by a live receipt verifier: ${request.action}:${request.provider}`);
    }
    let repository = null;
    if (request.requiredEvidence.includes("target-branch-dev") || request.action === "pr.merge") {
      repository = await currentRepositoryIdentity(manifest.cwd);
      assertTargetBranchEvidence(admittedEvidence, request, repository, contract.remoteRevision ?? null);
    }
    let actionBinding = {};
    if (request.action === "git.push") {
      const [, remote, ref] = GIT_PUSH_RESOURCE.exec(request.resource) ?? [];
      if (!remote) throw new Error("Git push resources must use remote:<name>:refs/heads/<branch>");
      const remoteUrl = (await execFileAsync("git", ["remote", "get-url", remote], {
        cwd: manifest.cwd,
        encoding: "utf8"
      })).stdout.trim();
      const remoteRepository = repositoryIdentity(remoteUrl);
      if (!remoteRepository) throw new Error("Git push requires a canonical remote repository identity");
      if (contract.template === "pr-to-dev" && (remote !== "origin" || remoteRepository !== repository)) {
        throw new Error("pr-to-dev git.push must use the canonical origin repository");
      }
      const expectedBranch = ref.slice("refs/heads/".length);
      const expectedRevision = (await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
        cwd: manifest.cwd,
        encoding: "utf8"
      })).stdout.trim();
      actionBinding = {
        remoteRepository,
        remoteUrlDigest: sha256(remoteUrl),
        expectedBranch,
        expectedRevision
      };
      if (contract.template === "pr-to-dev") {
        const currentBranch = (await execFileAsync("git", ["branch", "--show-current"], {
          cwd: manifest.cwd,
          encoding: "utf8"
        })).stdout.trim();
        const currentBranchEvidence = admittedEvidence.find((item) => (
          item.kind === "current-branch" && item.status === "complete" && !item.stale &&
          item.receipt?.payload?.revision === expectedRevision &&
          [expectedBranch, `refs/heads/${expectedBranch}`].includes(item.receipt?.payload?.ref)
        ));
        if (currentBranch !== expectedBranch || !currentBranchEvidence) {
          throw new Error("pr-to-dev git.push must bind the current branch evidence to the pushed commit");
        }
      }
    }
    if (request.action === "pr.create" && contract.template === "pr-to-dev") {
      actionBinding.targetRef = "dev";
    }
    if (request.action === "pr.merge") {
      const pullRequest = Number(String(request.resource).replace(/^pull\//, ""));
      if (!Number.isInteger(pullRequest)) throw new Error("PR merge resources must use pull/<number>");
      const currentHead = (await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
        cwd: manifest.cwd,
        encoding: "utf8"
      })).stdout.trim();
      actionBinding = {
        ...actionBinding,
        pullRequest,
        reviewedHead: currentHead,
        ...(contract.template === "pr-to-dev" ? { targetRef: "dev" } : {}),
        mergeMethod: "merge",
        adminBypass: false,
        mergeCommand: ["gh", "pr", "merge", String(pullRequest), "--merge", "--delete-branch=false"]
      };
    }
    if (request.action === "remote.sync" && contract.template === "pr-to-dev" && request.resource !== "refs/heads/dev") {
      throw new Error("pr-to-dev remote synchronization is restricted to refs/heads/dev");
    }
    if (request.action === "remote.sync") {
      const remoteUrl = (await execFileAsync("git", ["remote", "get-url", "origin"], {
        cwd: manifest.cwd,
        encoding: "utf8"
      })).stdout.trim();
      const remoteRepository = repositoryIdentity(remoteUrl);
      if (!remoteRepository) throw new Error("Remote synchronization requires a canonical origin repository identity");
      actionBinding = {
        ...actionBinding,
        remote: "origin",
        remoteRepository,
        remoteUrlDigest: sha256(remoteUrl)
      };
    }
    if (request.action === "pr.merge" && contract.controlPlane?.reviewPolicy !== "none") {
      const { isIndependentCriticEvidence } = await import("./evidence.mjs");
      const { reviewStatus } = await import("./review.mjs");
      const review = await reviewStatus(root, runId);
      const currentHead = (await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
        cwd: manifest.cwd,
        encoding: "utf8"
      })).stdout.trim();
      if (!review.complete || review.package?.head !== currentHead) {
        throw new Error("Action token denied until the exact review package is complete");
      }
      const hasIndependentCritic = admittedEvidence.some((item) => isIndependentCriticEvidence(item, {
        reviewPackage: review.package,
        sentinelDigest: state.lastSentinel?.digest
      }));
      if (!hasIndependentCritic) throw new Error("Action token denied until the exact independent critic is admitted");
      await assertPullEvidenceBinding(admittedEvidence, request, review.package, contract, repository);
      actionBinding = {
        ...actionBinding,
        reviewedHead: review.package.head,
        reviewPackageId: review.package.packageId,
        pullRequest: Number(String(request.resource).replace(/^pull\//, ""))
      };
    }
    if (["remote.sync", "worktree.cleanup"].includes(request.action) && contract.controlPlane?.reviewPolicy !== "none") {
      const { reviewStatus } = await import("./review.mjs");
      const review = await reviewStatus(root, runId);
      if (!review.complete) throw new Error("Action token denied until the exact review package is complete");
      if (request.action === "remote.sync") {
        actionBinding = {
          ...actionBinding,
          ...assertRemoteSyncMergeBinding(admittedEvidence, review.package, contract, repository)
        };
      }
    }
    if (request.action === "pr.merge" && request.requiredEvidence.includes("required-checks")) {
      const currentHead = (await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
        cwd: manifest.cwd,
        encoding: "utf8"
      })).stdout.trim();
      const requiredChecks = admittedEvidence.find((item) => {
        const payload = item.kind === "required-checks" ? item.receipt?.payload : null;
        return payload?.head === currentHead && payload?.base === contract.remoteRevision && payload?.repository === repository;
      });
      if (!requiredChecks) throw new Error("Action token denied until exact required-check provider evidence is present");
      await verifyRequiredChecksProvider(manifest.cwd, requiredChecks.receipt.payload);
    }
    if (request.action === "pr.merge") {
      await verifyPullRequestBeforeMerge(manifest.cwd, actionBinding);
    }
    const availableEvidence = new Set(
      admittedEvidence
        .filter((item) => item.status === "complete" && !item.stale)
        .map((item) => item.kind)
    );
    const missingEvidence = request.requiredEvidence.filter((kind) => !availableEvidence.has(kind));
    if (missingEvidence.length > 0) {
      throw new Error(`Action token missing evidence: ${missingEvidence.join(", ")}`);
    }
    if (DESTRUCTIVE_CLEANUP_ACTIONS.has(request.action)) {
      if (!request.requiredEvidence.includes("actions-cleanup-plan")) {
        throw new Error("Destructive cleanup actions require actions-cleanup-plan evidence");
      }
      const cleanupPlan = admittedEvidence.find((item) => item.kind === "actions-cleanup-plan");
      assertCleanupResourceBinding(manifest, runId, request, cleanupPlan);
      if (
        contract.template === "pr-to-dev" &&
        !actions.some((action) => (
          action.action === "remote.sync" &&
          action.status === "spent" &&
          action.outcome === "success" &&
          action.resource === "refs/heads/dev" &&
          action.receipt?.providerReceipt?.providerRevision === action.mergeCommit &&
          action.receipt?.providerReceipt?.localRevision === action.mergeCommit
        ))
      ) {
        throw new Error("pr-to-dev cleanup requires a successful reconciled remote.sync action");
      }
    }
    const authorities = contract.authority?.externalSideEffects ?? [];
    if (!authorities.includes(request.action) && !authorities.includes("*")) {
      throw new Error(`Action not authorized by TaskContract: ${request.action}`);
    }
    if (contract.remoteRevision && contract.remoteRevision !== request.remoteRevision) {
      throw new Error("Remote revision does not match TaskContract");
    }
    if (contract.schemaVersion === 2 && contract.actionStages) {
      const stageId = contract.actionStages[request.action];
      if (!stageId) throw new Error(`No execution stage is bound to action: ${request.action}`);
      const { deriveLedgerStatus } = await import("./ledger.mjs");
      const ledger = await deriveLedgerStatus(root, runId);
      if (ledger.blockers.length > 0) {
        throw new Error(`Action token denied by execution ledger: ${ledger.blockers.join(", ")}`);
      }
      const stage = ledger.taskStates.find((item) => item.id === stageId);
      if (!stage || (stage.state !== "in_progress" && !ledger.readySet.includes(stageId))) {
        throw new Error(`Action token denied until execution stage is ready: ${stageId}`);
      }
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    const ttlSeconds = Number(request.ttlSeconds ?? config.actionToken.ttlSeconds);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) {
      throw new Error("Action token TTL must be 1..3600 seconds");
    }
    const issuedAt = nowIso();
    const record = {
      schemaVersion: 1,
      tokenHash,
      status: "issued",
      outcome: null,
      issuedAt,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      runId,
      action: request.action,
      provider: request.provider,
      resource: request.resource,
      scope: request.scope ?? request.resource,
      remoteRevision: request.remoteRevision,
      ...actionBinding,
      treeDigest: currentTreeDigest,
      contractDigest: digestObject(contract),
      idempotencyKey: `sbw-${runId}-${randomUUID()}`
    };
    await atomicWriteJson(root, safeJoin(runDir, "actions", `${tokenHash}.json`), record);
    await appendJournal(root, runDir, "action.issued", {
      action: record.action,
      provider: record.provider,
      resource: record.resource,
      tokenHash
    });
    return { token, ...record };
  });
}

export async function consumeActionToken(root, runId, token, currentTreeDigest) {
  const tokenHash = sha256(token);
  return withRunLock(root, runId, async ({ runDir }) => {
    const target = safeJoin(runDir, "actions", `${tokenHash}.json`);
    const record = await readJson(root, target);
    if (record.status !== "issued") throw new Error("Action token was already consumed");
    if (Date.parse(record.expiresAt) <= Date.now()) throw new Error("Action token expired");
    if (record.treeDigest !== currentTreeDigest) throw new Error("Action token tree binding changed");
    const contract = await readJson(root, safeJoin(runDir, "contract.json"));
    if (record.contractDigest !== digestObject(contract)) throw new Error("Action token contract binding changed");
    const attemptId = randomUUID();
    const next = {
      ...record,
      status: "spent",
      outcome: "pending",
      spentAt: nowIso(),
      attemptId
    };
    await atomicWriteJson(root, target, next);
    await appendJournal(root, runDir, "action.consumed", { attemptId, tokenHash });
    return next;
  });
}

function validateActionReceipt(record, outcome, receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("Action reconciliation requires a structured provider receipt");
  }
  const bindingFields = ["runId", "attemptId", "idempotencyKey", "remoteRevision"];
  const receiptBindingValid = bindingFields.every((field) => receipt[field] === record[field]);
  if (
    receipt.action !== record.action ||
    receipt.provider !== record.provider ||
    receipt.resource !== record.resource ||
    receipt.outcome !== outcome ||
    !receiptBindingValid ||
    !receipt.providerReceipt ||
    typeof receipt.providerReceipt !== "object" ||
    Array.isArray(receipt.providerReceipt) ||
    receipt.providerReceipt.action !== record.action ||
    receipt.providerReceipt.resource !== record.resource ||
    receipt.providerReceipt.outcome !== outcome ||
    receipt.providerReceipt.provider !== record.provider ||
    !bindingFields.every((field) => receipt.providerReceipt[field] === record[field]) ||
    typeof receipt.providerReceipt.executionId !== "string" ||
    !receipt.providerReceipt.executionId
  ) {
    throw new Error("Action reconciliation receipt is not bound to the action attempt");
  }
  assertProviderReceiptShape(record, receipt.providerReceipt, outcome);
}

async function validateActionEvidenceBinding(root, runDir, record, attemptId, outcome, receipt) {
  if (outcome !== "success") return;
  if (!Array.isArray(receipt.evidenceIds) || receipt.evidenceIds.length === 0) {
    throw new Error("Successful action reconciliation requires action-bound evidence IDs");
  }
  if (new Set(receipt.evidenceIds).size !== receipt.evidenceIds.length) {
    throw new Error("Action-bound evidence IDs must be unique");
  }
  const evidence = await listJsonRecords(root, safeJoin(runDir, "evidence"));
  for (const evidenceId of receipt.evidenceIds) {
    const item = evidence.find((candidate) => candidate.id === evidenceId);
    const payload = item?.receipt?.payload;
    const proof = payload?.actionProof;
    if (
      !item ||
      item.status !== "complete" ||
      item.stale === true ||
      !payload ||
      !proof ||
      proof.schemaVersion !== 1 ||
      proof.runId !== record.runId ||
      proof.actionAttemptId !== attemptId ||
      proof.action !== record.action ||
      proof.provider !== record.provider ||
      proof.resource !== record.resource ||
      proof.outcome !== "success" ||
      proof.idempotencyKey !== record.idempotencyKey ||
      proof.remoteRevision !== record.remoteRevision ||
      proof.providerExecutionId !== receipt.providerReceipt.executionId ||
      proof.providerReceiptDigest !== digestObject(receipt.providerReceipt) ||
      !payload.receipt ||
      digestObject(payload.receipt) !== digestObject(receipt.providerReceipt)
    ) {
      throw new Error("Action-bound evidence does not prove the reconciled side effect");
    }
  }
}

export async function reconcileAction(root, runId, attemptId, outcome, receipt = null) {
  if (!["success", "failure", "unknown"].includes(outcome)) {
    throw new Error("Action outcome must be success, failure, or unknown");
  }
  return withRunLock(root, runId, async ({ runDir }) => {
    const records = await listJsonRecords(root, safeJoin(runDir, "actions"));
    const record = records.find((item) => item.attemptId === attemptId);
    if (!record) throw new Error(`Unknown action attempt: ${attemptId}`);
    if (record.status !== "spent" || record.outcome !== "pending") {
      throw new Error("Action attempt was already reconciled");
    }
    validateActionReceipt(record, outcome, receipt);
    const duplicateExecution = records.some((candidate) => (
      candidate.tokenHash !== record.tokenHash &&
      candidate.receipt?.providerReceipt?.executionId === receipt.providerReceipt.executionId
    ));
    if (duplicateExecution) {
      throw new Error("Provider execution identity is already bound to another action attempt");
    }
    await validateActionEvidenceBinding(root, runDir, record, attemptId, outcome, receipt);
    const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
    if (record.action === "pr.merge" && outcome === "success") {
      const { reviewStatus } = await import("./review.mjs");
      const review = await reviewStatus(root, runId);
      if (!review.complete ||
          review.package?.head !== receipt.providerReceipt.head ||
          receipt.providerReceipt.pr !== record.pullRequest ||
          receipt.providerReceipt.head !== record.reviewedHead) {
        throw new Error("PR merge receipt is not bound to the complete reviewed PR head");
      }
    }
    if (record.action === "remote.sync" && outcome === "success") {
      const mergeAction = records.find((candidate) => (
        candidate.action === "pr.merge" &&
        candidate.outcome === "success" &&
        candidate.pullRequest === record.pullRequest &&
        candidate.reviewedHead === record.reviewedHead &&
        candidate.reviewPackageId === record.reviewPackageId &&
        candidate.receipt?.providerReceipt?.pr === record.pullRequest &&
        candidate.receipt?.providerReceipt?.head === record.reviewedHead &&
        typeof candidate.receipt?.providerReceipt?.mergeCommit === "string" &&
        candidate.receipt.providerReceipt.mergeCommit === record.mergeCommit
      ));
      const mergeCommit = mergeAction?.receipt?.providerReceipt?.mergeCommit;
      if (!mergeCommit || receipt.providerReceipt.providerRevision !== mergeCommit || receipt.providerReceipt.localRevision !== mergeCommit) {
        throw new Error("Remote sync receipt is not bound to the reconciled PR merge commit");
      }
    }
    await verifyProviderReceipt(manifest, { ...record, outcome }, receipt);
    await reserveProviderExecution(root, record, receipt.providerReceipt.executionId);
    const target = safeJoin(runDir, "actions", `${record.tokenHash}.json`);
    const next = {
      ...record,
      outcome,
      receipt,
      reconciledAt: nowIso()
    };
    await atomicWriteJson(root, target, next);
    await appendJournal(root, runDir, "action.reconciled", { attemptId, outcome });
    return next;
  });
}

export async function inspectRun(root, runId) {
  const run = await loadRun(root, runId);
  return {
    ...run,
    evidence: await listJsonRecords(root, safeJoin(run.runDir, "evidence")),
    findings: await listJsonRecords(root, safeJoin(run.runDir, "findings")),
    actions: await listJsonRecords(root, safeJoin(run.runDir, "actions"))
  };
}

export async function cleanupRuns(root, { olderThanDays, apply = false }) {
  await ensureStateRoot(root);
  const runsRoot = safeJoin(root, "runs");
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
    const runDir = runDirectory(root, entry.name);
    await assertNoSymlinkUnder(root, runDir);
    const state = await readJson(root, safeJoin(runDir, "state.json")).catch(() => null);
    const info = await stat(runDir);
    if (
      state &&
      ["completed", "no_op", "cancelled_superseded", "cancelled_evidence_sufficient"].includes(state.status) &&
      info.mtimeMs < cutoff
    ) {
      candidates.push(entry.name);
    }
  }
  if (apply) {
    for (const runId of candidates) {
      const runDir = runDirectory(root, runId);
      await assertNoSymlinkUnder(root, runDir);
      await rm(runDir, { recursive: true, force: false });
    }
  }
  return { apply, candidates };
}
