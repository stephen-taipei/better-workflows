import { constants as fsConstants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
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
const TERMINAL_RUN_STATES = new Set([
  "completed",
  "failed_terminal",
  "no_op",
  "cancelled_superseded",
  "cancelled_evidence_sufficient"
]);

const RUN_ID = /^sbw-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[a-f0-9]{40}$/i;
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
    pattern: /^pull\/(?:new|\d+)$/,
    prove: (receipt, resource) => (
      Number.isInteger(receipt.number) &&
      (resource === "pull/new" || receipt.number === Number(resource.slice("pull/".length))) &&
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
const EXECUTABLE_ACTION_PROVIDERS = new Set([
  "git.push:git",
  "pr.create:github-cli",
  "pr.merge:github-cli"
]);

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
  contract.scope.include = canonicalizeScope(contract.scope.include);
  if (contract.scope.exclude !== undefined) {
    if (!Array.isArray(contract.scope.exclude)) throw new Error("TaskContract.scope.exclude must be an array");
    contract.scope.exclude = contract.scope.exclude.length === 0 ? [] : canonicalizeScope(contract.scope.exclude);
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

export function canonicalizeScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) throw new Error("Scope must be a non-empty array");
  const normalized = [...new Set(scope.map((item) => String(item).replaceAll("\\", "/")))].sort();
  for (const item of normalized) {
    const segments = item.split("/");
    if (
      !item ||
      item !== "." && item.startsWith("./") ||
      item.startsWith("/") ||
      item.startsWith(":") ||
      /[*?\[\]]/.test(item) ||
      segments.some((segment) => segment === ".." || (segment === "." && item !== ".")) ||
      item.includes("//") ||
      item.endsWith("/")
    ) {
      throw new Error(`Scope contains a non-literal relative path: ${item}`);
    }
  }
  return normalized;
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
    const { captureSourceBinding } = await import("./git.mjs");
    const sourceBinding = await captureSourceBinding(path.resolve(cwd), {
      baseRevision: baselineRevision ?? contract.remoteRevision ?? null
    });
    const manifest = {
      schemaVersion: 1,
      runId,
      version: VERSION,
      template: contract.template,
      mode,
      requestedMode,
      cwd: path.resolve(cwd),
      baselineRevision,
      sourceBinding,
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
      if (!expired || existing?.host !== os.hostname() || processAlive(existing?.pid)) {
        if (expired && existing?.host && existing.host !== os.hostname()) {
          throw new Error(`Run lease expired on host ${existing.host}; refusing cross-host lease reclamation`);
        }
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

export function assertProviderReceiptShape(record, providerReceipt, outcome = record.outcome) {
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
  if (OWNED_RESOURCE_CREATION_ACTIONS.has(record.action) && outcome === "success") {
    const proof = providerReceipt.creationProof;
    if (
      !proof ||
      typeof proof !== "object" ||
      Array.isArray(proof) ||
      proof.attemptId !== record.attemptId ||
      proof.idempotencyKey !== record.idempotencyKey ||
      typeof proof.marker !== "string" ||
      proof.marker !== `sbw:${record.attemptId}:${record.idempotencyKey}`
    ) {
      throw new Error("Owned resource creation requires a provider-native idempotency proof");
    }
  }
  if (
    outcome === "success" &&
    record.action === "branch.create" &&
    (!providerReceipt.created || typeof providerReceipt.ref !== "string" || !providerReceipt.ref ||
      typeof providerReceipt.revision !== "string" || !/^[a-f0-9]{7,64}$/i.test(providerReceipt.revision))
  ) {
    throw new Error("Git branch creation proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "worktree.create" &&
    (!providerReceipt.created || typeof providerReceipt.path !== "string" || !providerReceipt.path ||
      typeof providerReceipt.revision !== "string" || !/^[a-f0-9]{7,64}$/i.test(providerReceipt.revision))
  ) {
    throw new Error("Git worktree creation proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "git.commit" &&
    (!providerReceipt.created || typeof providerReceipt.revision !== "string" ||
      !/^[a-f0-9]{7,64}$/i.test(providerReceipt.revision))
  ) {
    throw new Error("Git commit proof is incomplete");
  }
  if (
    outcome === "success" &&
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
    outcome === "success" &&
    record.action === "branch.delete" &&
    (!providerReceipt.deleted || typeof providerReceipt.ref !== "string" || !providerReceipt.ref ||
      (record.resource.startsWith("branch:") && providerReceipt.ref !== record.resource.slice("branch:".length)))
  ) {
    throw new Error("Git branch deletion proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "pr.create" &&
    (!providerReceipt.created || !Number.isInteger(providerReceipt.number) ||
      typeof providerReceipt.head !== "string" || !providerReceipt.head ||
      typeof providerReceipt.base !== "string" || !providerReceipt.base ||
      (record.expectedHead !== undefined &&
        (!SHA.test(record.expectedHead) || providerReceipt.head !== record.expectedHead)) ||
      (record.targetRef && providerReceipt.base !== record.targetRef) ||
      typeof providerReceipt.url !== "string" || !providerReceipt.url)
  ) {
    throw new Error("GitHub pull request creation proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "issue.create" &&
    (!providerReceipt.created || !Number.isInteger(providerReceipt.number) ||
      typeof providerReceipt.repository !== "string" || !providerReceipt.repository ||
      typeof providerReceipt.url !== "string" || !providerReceipt.url)
  ) {
    throw new Error("GitHub issue creation proof is incomplete");
  }
  if (
    outcome === "success" &&
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
    outcome === "success" &&
    record.action === "pr.merge" &&
    (!Number.isInteger(providerReceipt.pr) ||
      providerReceipt.pr !== Number(String(record.resource).replace(/^pull\//, "")) ||
      providerReceipt.state !== "MERGED" ||
      typeof providerReceipt.repository !== "string" || !providerReceipt.repository ||
      typeof providerReceipt.baseRefName !== "string" || !providerReceipt.baseRefName ||
      (record.targetRef && providerReceipt.baseRefName !== record.targetRef) ||
      providerReceipt.mergeMethod !== record.mergeMethod ||
      providerReceipt.adminBypass !== false ||
      providerReceipt.invocationId !== record.providerInvocation?.id ||
      JSON.stringify(providerReceipt.mergeCommand) !== JSON.stringify(record.mergeCommand) ||
      typeof providerReceipt.head !== "string" || !providerReceipt.head ||
      typeof providerReceipt.mergeCommit !== "string" || !providerReceipt.mergeCommit ||
      providerReceipt.mergeBase !== record.remoteRevision ||
      providerReceipt.mergeHead !== record.reviewedHead ||
      (record.mergeRepository && providerReceipt.repository !== record.mergeRepository) ||
      providerReceipt.providerExecutableDigest !== record.providerExecutable?.digest)
  ) {
    throw new Error("GitHub pull request merge proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "pr.close" &&
    (!Number.isInteger(providerReceipt.pr) ||
      providerReceipt.pr !== Number(String(record.resource).replace(/^pull\//, "")) ||
      providerReceipt.state !== "CLOSED" ||
      typeof providerReceipt.repository !== "string" || !providerReceipt.repository)
  ) {
    throw new Error("GitHub pull request close proof is incomplete");
  }
  if (
    outcome === "success" &&
    record.action === "actions.cancel" &&
    (!providerReceipt.cancelled || typeof providerReceipt.runId !== "string" || !providerReceipt.runId ||
      providerReceipt.terminalState !== "cancelled" || providerReceipt.conclusion !== "CANCELLED")
  ) {
    throw new Error("GitHub Actions cancellation proof is incomplete");
  }
  if (
    outcome === "success" &&
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
    outcome === "success" &&
    record.action === "worktree.cleanup" &&
    (!providerReceipt.removed || typeof providerReceipt.path !== "string" || !providerReceipt.path)
  ) {
    throw new Error("Git worktree cleanup proof is incomplete");
  }
  if (
    outcome === "success" &&
    OWNED_RESOURCE_CREATION_ACTIONS.has(record.action) &&
    typeof record.attemptId === "string" &&
    (!record.creationPrecondition ||
      record.creationPrecondition.state !== "absent" ||
      providerReceipt.creationPreconditionDigest !== digestObject(record.creationPrecondition))
  ) {
    throw new Error("Owned resource creation proof is not bound to the reserved absent precondition");
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

function creationReservationPath(root, resource) {
  return safeJoin(root, "creation-reservations", `${sha256(resource)}.json`);
}

async function reserveCreationResource(root, runId, resource, tokenHash, expiresAt) {
  const directory = safeJoin(root, "creation-reservations");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = creationReservationPath(root, resource);
  try {
    const handle = await open(target, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ runId, resource, tokenHash, reservedAt: nowIso(), expiresAt })}\n`);
    await handle.sync();
    await handle.close();
  } catch (error) {
    if (error.code === "EEXIST") {
      const existing = await readJson(root, target).catch(() => null);
      const existingAction = existing?.runId && existing?.tokenHash
        ? await readJson(root, safeJoin(runDirectory(root, existing.runId), "actions", `${existing.tokenHash}.json`)).catch(() => null)
        : null;
      if (
        existingAction?.status === "issued" &&
        Number.isFinite(Date.parse(existing?.expiresAt ?? "")) &&
        Date.parse(existing.expiresAt) <= Date.now()
      ) {
        await unlink(target).catch(() => undefined);
        return reserveCreationResource(root, runId, resource, tokenHash, expiresAt);
      }
      if (existingAction?.status === "spent" && existingAction?.outcome === "failure") {
        // A known failed creation did not acquire the resource. Recover the
        // reservation even if the process crashed before explicit release.
        await unlink(target).catch(() => undefined);
        return reserveCreationResource(root, runId, resource, tokenHash, expiresAt);
      }
      throw new Error("Owned resource creation is already reserved by another action");
    }
    throw error;
  }
}

async function releaseCreationResource(root, runId, resource, tokenHash = null) {
  const target = creationReservationPath(root, resource);
  const reservation = await readJson(root, target).catch(() => null);
  if (
    reservation?.runId === runId &&
    (tokenHash === null || reservation.tokenHash === tokenHash)
  ) await unlink(target).catch(() => undefined);
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
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Owned resource registration");
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
    if (creationReceipt.action === "pr.create" && !SHA.test(creationAction.expectedHead ?? "")) {
      throw new Error("Owned pull request registration requires an exact expected source head");
    }
    assertProviderReceiptShape({
      action: creationReceipt.action,
      provider: creationReceipt.provider,
      resource,
      expectedHead: creationAction.expectedHead
    }, creationReceipt.providerReceipt);
    const reservation = await readJson(root, creationReservationPath(root, resource)).catch(() => null);
    if (reservation?.runId !== runId || reservation.tokenHash !== creationAction.tokenHash) {
      throw new Error("Owned resource registration requires an exclusive creation reservation");
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
        attemptId: creationReceipt.attemptId,
        spentAt: creationAction.spentAt,
        providerAuthorization: creationAction.providerAuthorization,
        creationPrecondition: creationAction.creationPrecondition,
        expectedHead: creationAction.expectedHead
      },
      { providerReceipt: creationReceipt.providerReceipt }
    );
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
    assertMutableRun({ state: current }, "Run state");
    const next = await mutator(structuredClone(current));
    if (!RUN_STATES.has(next.status)) throw new Error(`Invalid run state: ${next.status}`);
    await assertNoPendingProviderExecution(root, runId, runDir, next.status);
    next.updatedAt = nowIso();
    await atomicWriteJson(root, target, next);
    await appendJournal(root, runDir, event, { from: current.status, to: next.status });
    return next;
  });
}

export async function rebindSourceBinding(root, runId, reason) {
  const normalizedReason = String(reason ?? "").trim();
  if (!normalizedReason || normalizedReason.length > 512 || /[\0\r\n]/.test(normalizedReason)) {
    throw new Error("Source binding rebind requires a concise reason without newlines");
  }
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Source binding rebind");
    const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
    if (actions.length > 0 || (run.state.sideEffects ?? []).length > 0) {
      throw new Error("Source binding rebind is only allowed before side effects are issued");
    }
    const packageEntries = await readdir(safeJoin(runDir, "review-packages"), { withFileTypes: true }).catch(() => []);
    const findingEntries = await readdir(safeJoin(runDir, "review-findings"), { withFileTypes: true }).catch(() => []);
    if (packageEntries.some((entry) => entry.isFile()) || findingEntries.some((entry) => entry.isFile())) {
      throw new Error("Source binding rebind is only allowed before independent review begins");
    }
    const { captureSourceBinding } = await import("./git.mjs");
    const current = await captureSourceBinding(run.manifest.cwd, {
      baseRevision: run.manifest.sourceBinding?.baseRevision ?? run.contract.remoteRevision ?? null
    });
    if (!current) throw new Error("Source binding is unavailable for this workspace");
    if (current.digest === run.manifest.sourceBinding?.digest) {
      return { ok: true, rebound: false, sourceBinding: current, state: run.state };
    }
    const reboundAt = nowIso();
    const nextManifest = {
      ...run.manifest,
      sourceBinding: current,
      sourceBindingHistory: [
        ...(Array.isArray(run.manifest.sourceBindingHistory) ? run.manifest.sourceBindingHistory : []),
        {
          from: run.manifest.sourceBinding?.digest ?? null,
          to: current.digest,
          headRevision: current.headRevision,
          reason: normalizedReason,
          at: reboundAt
        }
      ],
      updatedAt: reboundAt
    };
    const evidence = await listJsonRecords(root, safeJoin(runDir, "evidence"));
    for (const record of evidence) {
      if (record.status === "complete" && record.stale !== true) {
        await atomicWriteJson(root, safeJoin(runDir, "evidence", `${record.id}.json`), {
          ...record,
          stale: true,
          freshnessCheckedAt: reboundAt,
          staleReason: "source-binding-rebound"
        });
      }
    }
    if (run.contract.schemaVersion === 2 && run.contract.controlPlane?.ledgerPolicy === "ledger-v1") {
      const { initializeLedger } = await import("./ledger.mjs");
      await initializeLedger(root, runDir, run.contract, runId);
    }
    const nextState = {
      ...run.state,
      status: "running",
      lastSentinel: null,
      lastSentinelVerified: false,
      lastSentinelComplete: false,
      sourceBindingReboundAt: reboundAt,
      updatedAt: reboundAt
    };
    await atomicWriteJson(root, safeJoin(runDir, "manifest.json"), nextManifest);
    await atomicWriteJson(root, safeJoin(runDir, "state.json"), nextState);
    await appendJournal(root, runDir, "source-binding.rebound", {
      from: run.manifest.sourceBinding?.digest ?? null,
      to: current.digest,
      headRevision: current.headRevision,
      reason: normalizedReason
    });
    return { ok: true, rebound: true, sourceBinding: current, state: nextState };
  });
}

export function assertMutableRun(run, operation = "Run mutation") {
  const status = run?.state?.status ?? run?.status;
  if (TERMINAL_RUN_STATES.has(status)) {
    throw new Error(`${operation} cannot mutate a terminal run`);
  }
}

async function assertNoPendingProviderExecution(root, runId, runDir, nextStatus) {
  if (!TERMINAL_RUN_STATES.has(nextStatus)) return;
  const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
  const pending = actions.find((action) => (
    action.status === "spent" &&
    ["pending", "unknown"].includes(action.outcome) &&
    EXECUTABLE_ACTION_PROVIDERS.has(`${action.action}:${action.provider}`)
  ));
  if (pending) {
    throw new Error(`Run status transition blocked while provider action ${pending.attemptId ?? pending.tokenHash} is pending reconciliation`);
  }
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

export async function completeRun(root, runId, completionDecision) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const target = safeJoin(runDir, "state.json");
    const current = await readJson(root, target);
    assertMutableRun({ state: current }, "Run completion");
    const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
    const contract = await readJson(root, safeJoin(runDir, "contract.json"));
    const { captureSentinel } = await import("./git.mjs");
    const freshSentinel = await captureSentinel(manifest.cwd, contract, await loadDefaults());
    if (!freshSentinel.complete || freshSentinel.digest !== current.lastSentinel?.digest) {
      const next = {
        ...current,
        status: "inconclusive",
        lastSentinelVerified: false,
        lastSentinelComplete: false,
        completionBlockers: [
          ...(freshSentinel.complete ? [] : ["bounded-sentinel-incomplete"]),
          ...(freshSentinel.digest === current.lastSentinel?.digest ? [] : ["current-sentinel-drift"])
        ],
        sentinelDrift: freshSentinel.digest === current.lastSentinel?.digest
          ? current.sentinelDrift ?? null
          : { label: current.lastSentinel?.label ?? null, digest: freshSentinel.digest }
      };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "run.status", { from: current.status, to: next.status });
      return { ok: false, status: next.status, blockers: next.completionBlockers, state: next };
    }
    const result = await evaluateCompletion(root, runId);
    if (!result.ok) {
      const next = {
        ...current,
        status: "inconclusive",
        completionBlockers: result.blockers,
        updatedAt: nowIso()
      };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "run.status", { from: current.status, to: next.status });
      return { ok: false, status: next.status, blockers: result.blockers, state: next };
    }
    const terminalSentinel = await captureSentinel(manifest.cwd, contract, await loadDefaults());
    if (!terminalSentinel.complete || terminalSentinel.digest !== freshSentinel.digest) {
      const blockers = [
        ...(terminalSentinel.complete ? [] : ["bounded-sentinel-incomplete"]),
        ...(terminalSentinel.digest === freshSentinel.digest ? [] : ["current-sentinel-drift"])
      ];
      const next = {
        ...current,
        status: "inconclusive",
        lastSentinelVerified: false,
        lastSentinelComplete: false,
        completionBlockers: blockers,
        sentinelDrift: { label: current.lastSentinel?.label ?? null, digest: terminalSentinel.digest }
      };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "run.status", { from: current.status, to: next.status });
      return { ok: false, status: next.status, blockers, state: next };
    }
    const terminalResult = await evaluateCompletion(root, runId);
    if (!terminalResult.ok) {
      const next = {
        ...current,
        status: "inconclusive",
        completionBlockers: terminalResult.blockers,
        updatedAt: nowIso()
      };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "run.status", { from: current.status, to: next.status });
      return { ok: false, status: next.status, blockers: terminalResult.blockers, state: next };
    }
    const reviewDigest = contract.schemaVersion === 2 && contract.controlPlane?.reviewPolicy !== "none"
      ? digestObject(await (async () => {
        const { reviewStatus } = await import("./review.mjs");
        return reviewStatus(root, runId);
      })())
      : null;
    const finalWriteSentinel = await captureSentinel(manifest.cwd, contract, await loadDefaults());
    if (!finalWriteSentinel.complete || finalWriteSentinel.digest !== terminalSentinel.digest) {
      const blockers = [
        ...(finalWriteSentinel.complete ? [] : ["bounded-sentinel-incomplete"]),
        ...(finalWriteSentinel.digest === terminalSentinel.digest ? [] : ["current-sentinel-drift"])
      ];
      const next = {
        ...current,
        status: "inconclusive",
        lastSentinelVerified: false,
        lastSentinelComplete: false,
        completionBlockers: blockers,
        sentinelDrift: { label: current.lastSentinel?.label ?? null, digest: finalWriteSentinel.digest }
      };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "run.status", { from: current.status, to: next.status });
      return { ok: false, status: next.status, blockers, state: next };
    }
    const finalDecision = {
      ...completionDecision,
      evaluatedAt: nowIso(),
      evidenceDigest: digestObject(terminalResult.evidence.map((item) => ({
        id: item.id,
        kind: item.kind,
        sourceDigest: item.sourceDigest,
        stale: item.stale === true
      }))),
      ledgerDigest: contract.schemaVersion === 2
        ? digestObject(await readJson(root, safeJoin(runDir, "ledger.json")))
        : null,
      reviewDigest,
      sentinelDigest: finalWriteSentinel.digest
    };
    await assertNoPendingProviderExecution(root, runId, runDir, "completed");
    const next = {
      ...current,
      status: "completed",
      completedAt: finalDecision.evaluatedAt,
      completionBlockers: [],
      completionDecision: finalDecision,
      updatedAt: nowIso()
    };
    await atomicWriteJson(root, target, next);
    await appendJournal(root, runDir, "run.status", { from: current.status, to: next.status });
    return { ok: true, state: next };
  });
}

function validateRecordId(id, kind) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) throw new Error(`Invalid ${kind} id`);
}

export async function addEvidence(root, runId, record) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const boundRun = await loadRun(root, runId);
    assertMutableRun(boundRun, "Evidence");
    const admitted = boundRun.contract.schemaVersion === 2
      ? await (await import("./evidence.mjs")).admitTypedEvidence(record, { ...boundRun, root, requireReconciled: false })
      : record;
    validateRecordId(admitted.id, "evidence");
    if (admitted.status !== "complete") throw new Error("Evidence status must be complete");
    if (typeof admitted.kind !== "string" || typeof admitted.summary !== "string") {
      throw new Error("Evidence kind and summary are required");
    }
    if (!Array.isArray(admitted.acceptanceIds)) throw new Error("Evidence acceptanceIds must be an array");
    if (typeof admitted.sourceDigest !== "string" || admitted.sourceDigest.length < 16) {
      throw new Error("Evidence sourceDigest is required");
    }
    const target = safeJoin(runDir, "evidence", `${admitted.id}.json`);
    if (await pathExists(target)) throw new Error(`Evidence already exists: ${record.id}`);
    const value = {
      schemaVersion: 1,
      stale: false,
      createdAt: nowIso(),
      dependencies: {},
      producer: {},
      ...admitted
    };
    await atomicWriteJson(root, target, value);
    await appendJournal(root, runDir, "evidence.added", { evidenceId: admitted.id });
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
  if (["resolved", "rejected-with-evidence"].includes(record.status) && !record.evidenceId) {
    throw new Error("Resolved or rejected findings require evidenceId");
  }
  return record;
}

async function assertFindingEvidence(root, run, runDir, record) {
  if (!["resolved", "rejected-with-evidence"].includes(record.status)) return;
  if (run.contract.schemaVersion !== 2) {
    throw new Error("Resolved or rejected findings require typed evidence");
  }
  const evidence = (await listJsonRecords(root, safeJoin(runDir, "evidence"))).find(
    (item) => item.id === record.evidenceId
  );
  if (
    !evidence ||
    evidence.schemaVersion !== 2 ||
    evidence.stale === true ||
    !evidence.typedAdmission
  ) {
    throw new Error("Finding disposition requires current typed evidence");
  }
  const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
  await validateTypedEvidenceRecord(evidence, {
    manifest: run.manifest,
    contract: run.contract,
    root,
    runDir,
    requireReconciled: true
  });
  const payload = evidence.receipt?.payload;
  if (!Array.isArray(payload?.findingIds) || !payload.findingIds.includes(record.id)) {
    throw new Error("Finding disposition evidence is not bound to the finding");
  }
}

export async function addFinding(root, runId, record, { update = false } = {}) {
  validateFinding(record);
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Finding");
    await assertFindingEvidence(root, run, runDir, record);
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
  if (manifest.sourceBinding) {
    try {
      const { captureSourceBinding } = await import("./git.mjs");
      const currentSourceBinding = await captureSourceBinding(manifest.cwd, {
        baseRevision: manifest.sourceBinding.baseRevision
      });
      if (!currentSourceBinding || currentSourceBinding.digest !== manifest.sourceBinding.digest) {
        blockers.push("source-binding-drift");
      }
    } catch {
      blockers.push("source-binding-unavailable");
    }
  }
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
  if (actions.some((action) => action.status !== "spent" || ["unknown", "pending", "failure"].includes(action.outcome))) {
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
  if (contract.template === "pr-to-dev") {
    const remoteSyncAction = actions.find((action) => (
      action.action === "remote.sync" &&
      action.status === "spent" &&
      action.outcome === "success" &&
      action.resource === "refs/heads/dev" &&
      action.receipt?.providerReceipt
    ));
    if (remoteSyncAction) {
      try {
        await verifyProviderReceipt(manifest, { ...remoteSyncAction, outcome: "success" }, remoteSyncAction.receipt);
      } catch {
        blockers.push("remote-sync-live-state-stale");
      }
    }
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

async function currentProviderExecutableIdentity(command) {
  const supplied = (await execFileAsync("which", [command], { encoding: "utf8" })).stdout.trim();
  if (!supplied) throw new Error(`Provider executable is not available: ${command}`);
  const target = await realpath(supplied);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Provider executable must resolve to a regular file: ${command}`);
  }
  return { path: target, digest: sha256(await readFile(target)) };
}

export function buildPrCreateCommand(record) {
  if (
    !record ||
    record.action !== "pr.create" ||
    record.provider !== "github-cli" ||
    record.resource !== "pull/new" ||
    typeof record.createRepository !== "string" || !record.createRepository.startsWith("github.com/") ||
    typeof record.targetRef !== "string" || !record.targetRef ||
    typeof record.headBranch !== "string" || !record.headBranch ||
    typeof record.prTitle !== "string" || !record.prTitle ||
    typeof record.prBodyPrefix !== "string" || !record.prBodyPrefix ||
    typeof record.attemptId !== "string" || !record.attemptId ||
    typeof record.idempotencyKey !== "string" || !record.idempotencyKey
  ) {
    throw new Error("PR creation command binding is incomplete");
  }
  const marker = `sbw:${record.attemptId}:${record.idempotencyKey}`;
  return [
    "gh",
    "pr",
    "create",
    "--repo",
    record.createRepository.slice("github.com/".length),
    "--base",
    record.targetRef,
    "--head",
    record.headBranch,
    "--title",
    record.prTitle,
    "--body",
    `${record.prBodyPrefix}\n\n<!-- ${marker} -->`
  ];
}

function readGitCredential(cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["credential", "fill"], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Git credential helper failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      const values = {};
      for (const line of stdout.split("\n")) {
        const separator = line.indexOf("=");
        if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
      }
      resolve(values);
    });
    child.stdin.end(input);
  });
}

async function verifyGitHubCredentialActor(cwd, remoteUrl, repository) {
  let parsed;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new Error("Git push credential binding requires a parseable HTTPS remote");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw new Error("Git push credential binding requires the canonical github.com HTTPS remote");
  }
  const credential = await readGitCredential(
    cwd,
    [
      "protocol=https",
      "host=github.com",
      `path=${parsed.pathname.replace(/^\//, "")}`,
      ...(parsed.username ? [`username=${decodeURIComponent(parsed.username)}`] : []),
      "",
      ""
    ].join("\n")
  );
  if (typeof credential.username !== "string" || !credential.username ||
      typeof credential.password !== "string" || !credential.password) {
    throw new Error("Git push credential helper did not return an HTTPS credential");
  }
  const authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization,
    "user-agent": "better-workflows"
  };
  const userResponse = await fetch("https://api.github.com/user", { headers });
  if (!userResponse.ok) throw new Error(`Git credential actor lookup failed: HTTP ${userResponse.status}`);
  const user = await userResponse.json();
  const repositoryPath = repository.slice("github.com/".length);
  const repositoryResponse = await fetch(`https://api.github.com/repos/${repositoryPath}`, { headers });
  if (!repositoryResponse.ok) throw new Error(`Git credential repository lookup failed: HTTP ${repositoryResponse.status}`);
  const metadata = await repositoryResponse.json();
  const permissions = metadata.permissions ?? {};
  if (
    typeof user.login !== "string" || !user.login ||
    !Number.isInteger(user.id) ||
    metadata.full_name !== repositoryPath ||
    permissions.push !== true
  ) {
    throw new Error("Git credential is not bound to a GitHub actor with repository push permission");
  }
  return {
    actor: user.login,
    actorId: user.id,
    permissions: {
      admin: permissions.admin === true,
      maintain: permissions.maintain === true,
      push: permissions.push === true
    },
    source: "git-credential-helper"
  };
}

async function captureCreationPrecondition(cwd, action, resource) {
  if (action === "branch.create") {
    const ref = resource.slice("branch:".length);
    try {
      const revision = (await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${ref}^{commit}`], {
        cwd,
        encoding: "utf8"
      })).stdout.trim();
      return { action, resource, state: "present", revision };
    } catch (error) {
      if (error.code !== 128) throw error;
      return { action, resource, state: "absent", ref };
    }
  }
  if (action === "worktree.create") {
    const worktreePath = resource.slice("worktree:".length);
    const output = (await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8"
    })).stdout;
    const present = output.split(/\n\n+/).some((block) => block.split("\n").some((line) => line === `worktree ${worktreePath}`));
    return { action, resource, state: present || await pathExists(path.resolve(cwd, worktreePath)) ? "present" : "absent", path: worktreePath };
  }
  if (action === "pr.create") {
    if (resource === "pull/new") {
      return { action, resource, state: "absent", number: null };
    }
    const number = Number(resource.slice("pull/".length));
    try {
      const actual = JSON.parse((await execFileAsync("gh", ["pr", "view", String(number), "--json", "number,state"], {
        cwd,
        encoding: "utf8"
      })).stdout);
      return { action, resource, state: "present", number: actual.number, status: actual.state };
    } catch (error) {
      if (error.code !== 1) throw error;
      return { action, resource, state: "absent", number };
    }
  }
  if (action === "actions.dispatch" && resource.startsWith("run:")) {
    const runId = resource.slice("run:".length);
    try {
      const actual = JSON.parse((await execFileAsync("gh", ["run", "view", runId, "--json", "databaseId,status"], {
        cwd,
        encoding: "utf8"
      })).stdout);
      return { action, resource, state: "present", runId: String(actual.databaseId), status: actual.status };
    } catch (error) {
      if (error.code !== 1) throw error;
      return { action, resource, state: "absent", runId };
    }
  }
  return null;
}

async function verifyFailedCreationAbsence(manifest, record) {
  if (!OWNED_RESOURCE_CREATION_ACTIONS.has(record.action)) return null;
  const cwd = manifest.cwd;
  if (record.action === "pr.create" && record.provider === "github-cli") {
    const repository = record.createRepository ?? await currentRepositoryIdentity(cwd);
    const repositoryPath = repository.startsWith("github.com/")
      ? repository.slice("github.com/".length)
      : repository;
    const command = [
      "gh",
      "pr",
      "list",
      "--repo",
      repositoryPath,
      "--head",
      record.headBranch,
      "--base",
      record.targetRef,
      "--state",
      "all",
      "--json",
      "number,headRefOid,baseRefName,url"
    ];
    const output = await execFileAsync(command[0], command.slice(1), { cwd, encoding: "utf8" });
    let actual;
    try {
      actual = JSON.parse(output.stdout);
    } catch {
      throw new Error("Failed PR creation reconciliation did not return structured provider absence data");
    }
    if (!Array.isArray(actual)) {
      throw new Error("Failed PR creation reconciliation provider absence data is not an array");
    }
    if (actual.length > 0) {
      throw new Error("Failed PR creation reconciliation found an existing pull request; preserve the reservation and reconcile the provider outcome");
    }
    return {
      schemaVersion: 1,
      proofKind: "github-pr-create-absence",
      repository,
      headBranch: record.headBranch,
      targetRef: record.targetRef,
      expectedHead: record.expectedHead,
      command,
      observed: actual,
      responseDigest: digestObject(actual),
      observedAt: nowIso(),
      absent: true
    };
  }
  const precondition = await captureCreationPrecondition(cwd, record.action, record.resource);
  if (precondition?.state !== "absent") {
    throw new Error("Failed owned-resource creation reconciliation found an existing provider resource; preserve the reservation and reconcile the provider outcome");
  }
  return {
    schemaVersion: 1,
    proofKind: `${record.provider}-${record.action}-absence`,
    resource: record.resource,
    observed: precondition,
    responseDigest: digestObject(precondition),
    observedAt: nowIso(),
    absent: true
  };
}

async function verifyGitHubProviderAuthorization(cwd, repository) {
  if (!repository.startsWith("github.com/")) throw new Error("GitHub provider authorization requires a GitHub repository");
  const repositoryPath = repository.slice("github.com/".length);
  const actor = JSON.parse((await execFileAsync("gh", ["api", "user"], { cwd, encoding: "utf8" })).stdout);
  const metadata = JSON.parse((await execFileAsync("gh", ["api", `repos/${repositoryPath}`], { cwd, encoding: "utf8" })).stdout);
  const permissions = metadata.permissions ?? {};
  const authorization = {
    provider: "github-cli",
    actor: actor.login,
    repository,
    permissions: {
      admin: permissions.admin === true,
      maintain: permissions.maintain === true,
      push: permissions.push === true
    }
  };
  if (
    typeof authorization.actor !== "string" || !authorization.actor ||
    metadata.full_name !== repositoryPath ||
    !Object.values(authorization.permissions).some(Boolean)
  ) {
    throw new Error("GitHub provider authorization is not bound to an authenticated actor with repository access");
  }
  return authorization;
}

async function verifyGitPushCredential(cwd, remote, ref, revision, repository, expectedActor = null) {
  if (!repository.startsWith("github.com/")) {
    throw new Error("Git push authorization requires a GitHub-bound controlled push provider");
  }
  const remoteUrl = (await execFileAsync("git", ["remote", "get-url", remote], {
    cwd,
    encoding: "utf8"
  })).stdout.trim();
  if (repositoryIdentity(remoteUrl) !== repository) {
    throw new Error("Git push credential binding does not match the authorized repository");
  }
  await execFileAsync("git", ["push", "--dry-run", "--porcelain", remote, `${revision}:${ref}`], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
  const credentialActor = await verifyGitHubCredentialActor(cwd, remoteUrl, repository);
  if (expectedActor && credentialActor.actor !== expectedActor) {
    throw new Error("Git push credential actor does not match the authorized GitHub actor");
  }
  return {
    provider: "git",
    repository,
    remote,
    ref,
    revision,
    credentialCheck: "git-credential-actor",
    actor: credentialActor.actor,
    actorId: credentialActor.actorId,
    permissions: credentialActor.permissions,
    credentialSource: credentialActor.source
  };
}

async function verifyPullRequestBeforeMerge(cwd, record) {
  if (record.targetRef === "dev" && !/^[a-f0-9]{40}$/i.test(record.remoteRevision ?? "")) {
    throw new Error("Protected dev merge requires the exact reviewed base revision");
  }
  const repository = await currentRepositoryIdentity(cwd);
  if (record.mergeRepository && repository !== record.mergeRepository) {
    throw new Error("PR merge origin repository changed after authorization");
  }
  if (!repository.startsWith("github.com/")) throw new Error("PR merge requires a GitHub repository");
  const actual = JSON.parse((await execFileAsync("gh", [
    "api", `repos/${repository.slice("github.com/".length)}/pulls/${record.pullRequest}`
  ], { cwd, encoding: "utf8" })).stdout);
  if (
      actual.number !== record.pullRequest ||
    actual.state !== "open" ||
    actual.head?.sha !== record.reviewedHead ||
    (record.targetRef && actual.base?.ref !== record.targetRef) ||
    (record.remoteRevision && actual.base?.sha !== record.remoteRevision) ||
    actual.mergeable !== true ||
    actual.mergeable_state !== "clean"
  ) {
    throw new Error("Live pull request state is not an exact clean merge candidate");
  }
}

async function verifyMergeProviderAtInvocation(root, runId, record, manifest) {
  const repository = await currentRepositoryIdentity(manifest.cwd);
  if (repository !== record.mergeRepository) {
    throw new Error("PR merge provider repository changed before invocation");
  }
  const authorization = await verifyGitHubProviderAuthorization(manifest.cwd, repository);
  if (digestObject(authorization) !== digestObject(record.providerAuthorization)) {
    throw new Error("PR merge provider actor or permission changed before invocation");
  }
  await verifyPullRequestBeforeMerge(manifest.cwd, record);
  const contract = await readJson(root, safeJoin(runDirectory(root, runId), "contract.json"));
  if (!contract.actionGates?.[record.action]?.includes("required-checks")) return authorization;
  const run = await loadRun(root, runId);
  const evidence = await listJsonRecords(root, safeJoin(run.runDir, "evidence"));
  const requiredChecks = evidence.find((item) => {
    const payload = item.kind === "required-checks" ? item.receipt?.payload : null;
    return (
      item.status === "complete" &&
      item.stale !== true &&
      payload?.head === record.reviewedHead &&
      payload?.base === record.remoteRevision &&
      payload?.repository === repository
    );
  });
  if (!requiredChecks) throw new Error("PR merge invocation requires exact required-check evidence");
  const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
  await validateTypedEvidenceRecord(requiredChecks, {
    manifest: run.manifest,
    contract: run.contract,
    root,
    runDir: run.runDir,
    requireReconciled: true
  });
  await verifyRequiredChecksProvider(manifest.cwd, requiredChecks.receipt.payload);
  return authorization;
}

async function verifyCreateProviderAtInvocation(record, manifest) {
  const repository = await currentRepositoryIdentity(manifest.cwd);
  if (repository !== record.createRepository) {
    throw new Error("PR creation provider repository changed before invocation");
  }
  const authorization = await verifyGitHubProviderAuthorization(manifest.cwd, repository);
  if (digestObject(authorization) !== digestObject(record.providerAuthorization)) {
    throw new Error("PR creation provider actor or permission changed before invocation");
  }
  const currentHead = (await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: manifest.cwd,
    encoding: "utf8"
  })).stdout.trim();
  const currentBranch = (await execFileAsync("git", ["branch", "--show-current"], {
    cwd: manifest.cwd,
    encoding: "utf8"
  })).stdout.trim();
  if (currentHead !== record.expectedHead || currentBranch !== record.headBranch) {
    throw new Error("PR creation candidate changed before invocation");
  }
  const branchRef = `refs/heads/${record.headBranch}`;
  const remoteHead = (await execFileAsync("git", ["ls-remote", "origin", branchRef], {
    cwd: manifest.cwd,
    encoding: "utf8"
  })).stdout.trim().split(/\s+/)[0] ?? "";
  if (remoteHead !== record.expectedHead) {
    throw new Error("PR creation requires the pushed candidate branch to match the reviewed head");
  }
  const targetRef = `refs/heads/${record.targetRef}`;
  const remoteBase = (await execFileAsync("git", ["ls-remote", "origin", targetRef], {
    cwd: manifest.cwd,
    encoding: "utf8"
  })).stdout.trim().split(/\s+/)[0] ?? "";
  if (record.remoteRevision && remoteBase !== record.remoteRevision) {
    throw new Error("PR creation target branch changed before invocation");
  }
  return authorization;
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

async function verifyOwnedResourceCreationProof(manifest, record, providerReceipt) {
  if (!OWNED_RESOURCE_CREATION_ACTIONS.has(record.action) || record.outcome !== "success") return;
  const proof = providerReceipt.creationProof;
  const marker = `sbw:${record.attemptId}:${record.idempotencyKey}`;
  const spentAt = Date.parse(record.spentAt ?? "");
  if (!Number.isFinite(spentAt)) throw new Error("Owned resource creation action lacks a valid consumed timestamp");
  if (proof.marker !== marker || proof.attemptId !== record.attemptId || proof.idempotencyKey !== record.idempotencyKey) {
    throw new Error("Owned resource provider-native marker is not bound to the consumed action");
  }
  // GitHub and Git provider timestamps are commonly second-granular.
  const minimumObservedAt = spentAt - 2000;
  const assertObservedAt = (value, label) => {
    const observedAt = Date.parse(value ?? "");
    if (!Number.isFinite(observedAt) || observedAt < minimumObservedAt) {
      throw new Error(`${label} was not created after the action was consumed`);
    }
    return observedAt;
  };
  if (record.action === "branch.create" && record.provider === "git") {
    const ref = record.resource.slice("branch:".length);
    const actual = (await execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${ref}^{commit}`], {
      cwd: manifest.cwd,
      encoding: "utf8"
    })).stdout.trim();
    const reflog = (await execFileAsync("git", [
      "reflog", "show", "--format=%H%x00%gs%x00%cI", "-1", `refs/heads/${ref}`
    ], { cwd: manifest.cwd, encoding: "utf8" })).stdout.trim();
    const [revision, subject, observedAt] = reflog.split("\0");
    if (
      actual !== providerReceipt.revision ||
      revision !== actual ||
      !subject?.includes(marker) ||
      !Number.isFinite(Date.parse(observedAt)) ||
      Date.parse(observedAt) < minimumObservedAt ||
      proof.providerObjectId !== `${ref}:${actual}`
    ) {
      throw new Error("Git branch creation proof is missing the provider-native marked reflog event");
    }
    return;
  }
  if (record.action === "worktree.create" && record.provider === "git") {
    const worktreePath = record.resource.slice("worktree:".length);
    const output = (await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: manifest.cwd,
      encoding: "utf8"
    })).stdout;
    const match = output.split(/\n\n+/).map((block) => Object.fromEntries(
      block.split("\n").filter(Boolean).map((line) => {
        const separator = line.indexOf(" ");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
    )).find((item) => item.worktree === worktreePath);
    if (!match || match.HEAD !== providerReceipt.revision || proof.providerObjectId !== `${worktreePath}:${match.HEAD}`) {
      throw new Error("Git worktree creation proof does not match the live provider object");
    }
    const markerValue = (await execFileAsync("git", ["-C", worktreePath, "config", "--local", "--get", "sbw.creation-marker"], {
      cwd: manifest.cwd,
      encoding: "utf8"
    })).stdout.trim();
    const attemptValue = (await execFileAsync("git", ["-C", worktreePath, "config", "--local", "--get", "sbw.action-attempt"], {
      cwd: manifest.cwd,
      encoding: "utf8"
    })).stdout.trim();
    const worktreeMtime = (await stat(path.resolve(manifest.cwd, worktreePath))).mtimeMs;
    assertObservedAt(proof.observedAt, "Git worktree");
    if (markerValue !== marker || attemptValue !== record.attemptId || worktreeMtime < minimumObservedAt) {
      throw new Error("Git worktree creation proof lacks the provider-native marker and creation timestamp");
    }
    return;
  }
  if (record.action === "pr.create" && record.provider === "github-cli") {
    const repository = await currentRepositoryIdentity(manifest.cwd);
    const actual = JSON.parse((await execFileAsync("gh", [
      "api", `repos/${repository.slice("github.com/".length)}/pulls/${providerReceipt.number}`
    ], { cwd: manifest.cwd, encoding: "utf8" })).stdout);
    const createdAt = assertObservedAt(actual.created_at, "GitHub pull request");
    const actor = record.providerAuthorization?.actor;
    if (
      actual.node_id !== proof.providerObjectId ||
      actual.user?.login !== actor ||
      (record.expectedHead && actual.head?.sha !== record.expectedHead) ||
      typeof actual.body !== "string" ||
      !actual.body.includes(`<!-- ${marker} -->`) ||
      providerReceipt.url !== actual.html_url ||
      proof.observedAt !== actual.created_at ||
      createdAt < minimumObservedAt
    ) {
      throw new Error("GitHub pull request creation proof lacks provider-native actor, timestamp, or idempotency marker");
    }
    return;
  }
  if (record.action === "actions.dispatch" && record.provider === "github-cli") {
    const actual = JSON.parse((await execFileAsync("gh", [
      "run", "view", String(providerReceipt.runId), "--json",
      "databaseId,workflowName,url,status,conclusion,headSha,createdAt,displayTitle,actor"
    ], { cwd: manifest.cwd, encoding: "utf8" })).stdout);
    const createdAt = assertObservedAt(actual.createdAt, "GitHub Actions run");
    if (
      String(actual.databaseId) !== String(proof.providerObjectId) ||
      actual.actor?.login !== record.providerAuthorization?.actor ||
      typeof actual.displayTitle !== "string" ||
      !actual.displayTitle.includes(marker) ||
      proof.observedAt !== actual.createdAt ||
      createdAt < minimumObservedAt
    ) {
      throw new Error("GitHub Actions creation proof lacks provider-native actor, timestamp, or idempotency marker");
    }
  }
}

async function verifyProviderReceipt(manifest, record, receipt) {
  if (record.outcome !== "success") return;
  const providerReceipt = receipt.providerReceipt;
  const cwd = manifest.cwd;
  const key = `${record.action}:${record.provider}`;
  await verifyOwnedResourceCreationProof(manifest, record, providerReceipt);
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
        targetRef: record.targetRef ?? null,
        expectedHead: record.expectedHead ?? null
      },
      response,
      `github:${repository}:pr.create:${actual.number}:${actual.headRefOid}`
    );
    if (
      (record.resource !== "pull/new" && actual.number !== Number(String(record.resource).replace(/^pull\//, ""))) ||
      actual.number !== providerReceipt.number ||
      actual.headRefOid !== providerReceipt.head ||
      (record.expectedHead && actual.headRefOid !== record.expectedHead) ||
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
    const mergeDetails = JSON.parse((await execFileAsync("gh", [
      "api", `repos/${repository.slice("github.com/".length)}/commits/${mergeCommit}`
    ], { cwd, encoding: "utf8" })).stdout);
    const mergeParents = Array.isArray(mergeDetails.parents)
      ? mergeDetails.parents.map((parent) => parent?.sha).filter(Boolean)
      : [];
    const mergeBase = mergeParents[0];
    const mergeHead = mergeParents[1];
    const response = {
      number: actual.number,
      state: actual.state,
      head: actual.headRefOid,
      baseRefName: actual.baseRefName,
      mergeCommit,
      mergeBase,
      mergeHead,
      mergeParentCount: mergeParents.length,
      providerExecutableDigest: record.providerExecutable?.digest
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
        providerExecutable: record.providerExecutable,
        mergeRepository: record.mergeRepository,
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
      providerReceipt.repository !== repository ||
      providerReceipt.mergeBase !== record.remoteRevision ||
      mergeBase !== record.remoteRevision ||
      mergeParents.length !== 2 ||
      providerReceipt.mergeHead !== record.reviewedHead ||
      mergeHead !== record.reviewedHead ||
      providerReceipt.providerExecutableDigest !== record.providerExecutable?.digest
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
    `repos/${repositoryPath}/branches/${encodeURIComponent(payload.baseRefName)}/protection`
  ], { cwd, encoding: "utf8" })).stdout);
  if (protection.enforce_admins?.enabled !== true || !protection.required_status_checks) {
    throw new Error("Protected branch policy is missing enforce-admins or required status checks");
  }
  if (
    !protection.required_pull_request_reviews ||
    !Number.isInteger(protection.required_pull_request_reviews.required_approving_review_count) ||
    protection.required_pull_request_reviews.required_approving_review_count < 1
  ) {
    throw new Error("Protected branch policy is missing required pull-request reviews");
  }
  if (protection.allow_force_pushes?.enabled === true || protection.allow_deletions?.enabled === true) {
    throw new Error("Protected branch policy permits force-pushes or deletions");
  }
  const branchRules = JSON.parse((await execFileAsync("gh", [
    "api",
    `repos/${repositoryPath}/rules/branches/${encodeURIComponent(payload.baseRefName)}`
  ], { cwd, encoding: "utf8" })).stdout);
  if (!Array.isArray(branchRules)) {
    throw new Error("Protected branch rules could not be verified completely");
  }
  if (branchRules.some((rule) => !rule || typeof rule.type !== "string" || !rule.type)) {
    throw new Error("Protected branch rules contain an incomplete rule definition");
  }
  if (branchRules.some((rule) => ["deletion", "non_fast_forward"].includes(rule.type))) {
    throw new Error("Protected branch rules permit deletion or non-fast-forward updates");
  }
  const rulesetPages = JSON.parse((await execFileAsync("gh", [
    "api",
    "--paginate",
    "--slurp",
    `repos/${repositoryPath}/rulesets?includes_parents=true`
  ], { cwd, encoding: "utf8" })).stdout);
  if (!Array.isArray(rulesetPages) || rulesetPages.some((page) => !Array.isArray(page))) {
    throw new Error("Repository rulesets could not be verified completely");
  }
  const rulesets = rulesetPages.flat();
  const activeRulesets = rulesets.filter((item) => item?.enforcement === "active");
  if (activeRulesets.some((item) => !Number.isInteger(Number(item?.id)))) {
    throw new Error("Active repository ruleset listing contains an incomplete identity");
  }
  const branchRef = `refs/heads/${payload.baseRefName}`;
  const rulesetRequiredStatusChecks = [];
  const refPatternMatches = (pattern) => {
    if (pattern === "~ALL" || pattern === "~DEFAULT_BRANCH" || pattern === branchRef) return true;
    if (typeof pattern !== "string" || !pattern.includes("*")) return false;
    const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${escaped}$`).test(branchRef);
  };
  for (const listed of activeRulesets) {
    const detail = JSON.parse((await execFileAsync("gh", [
      "api",
      `repos/${repositoryPath}/rulesets/${Number(listed.id)}`
    ], { cwd, encoding: "utf8" })).stdout);
    const includes = detail.conditions?.ref_name?.include;
    if (detail.target === "branch" && !Array.isArray(includes)) {
      throw new Error("Active branch ruleset has no complete ref-name condition");
    }
    const appliesToTarget = detail.target === "branch" && Array.isArray(includes) && includes.some(refPatternMatches);
    if (appliesToTarget && !Array.isArray(detail.bypass_actors)) {
      throw new Error("Active protected branch ruleset has no complete bypass-actor policy");
    }
    if (appliesToTarget && detail.bypass_actors.length > 0) {
      throw new Error("Active protected branch ruleset permits bypass actors");
    }
    if (appliesToTarget && !Array.isArray(detail.rules)) {
      throw new Error("Active protected branch ruleset has no complete rule set");
    }
    const rules = Array.isArray(detail.rules) ? detail.rules : [];
    if (appliesToTarget && rules.some((rule) => ["deletion", "non_fast_forward"].includes(rule?.type))) {
      throw new Error("Active protected branch ruleset permits deletion or non-fast-forward updates");
    }
    const requiredStatusRules = rules.filter((rule) => rule?.type === "required_status_checks");
    for (const requiredStatusRule of requiredStatusRules) {
      if (appliesToTarget && !Array.isArray(requiredStatusRule.parameters?.required_status_checks)) {
        throw new Error("Active protected branch ruleset has incomplete required status checks");
      }
      if (appliesToTarget) {
        for (const check of requiredStatusRule.parameters.required_status_checks) {
          const name = check?.context ?? check?.name;
          if (typeof name !== "string" || !name) {
            throw new Error("Active protected branch ruleset has an incomplete required status check");
          }
          rulesetRequiredStatusChecks.push(name);
        }
      }
    }
    if (appliesToTarget && detail.enforcement !== "active") {
      throw new Error("Active protected branch ruleset detail changed enforcement state");
    }
    const pullRequestRule = rules.find((rule) => rule?.type === "pull_request");
    if (
      appliesToTarget &&
      pullRequestRule &&
      (!Number.isInteger(pullRequestRule.parameters?.required_approving_review_count) ||
        pullRequestRule.parameters.required_approving_review_count < 1)
    ) {
      throw new Error("Active protected branch ruleset has incomplete pull-request review policy");
    }
  }
  const requiredStatusProtection = JSON.parse((await execFileAsync("gh", [
    "api",
    `repos/${repositoryPath}/branches/${encodeURIComponent(payload.baseRefName)}/protection/required_status_checks`
  ], { cwd, encoding: "utf8" })).stdout);
  if (
    requiredStatusProtection.contexts !== undefined &&
    (!Array.isArray(requiredStatusProtection.contexts) ||
      requiredStatusProtection.contexts.some((context) => typeof context !== "string" || !context))
  ) {
    throw new Error("Protected branch status-check contexts contain malformed entries");
  }
  if (
    requiredStatusProtection.checks !== undefined &&
    (!Array.isArray(requiredStatusProtection.checks) ||
      requiredStatusProtection.checks.some((check) => {
        const name = check?.context ?? check?.name;
        return !check || typeof check !== "object" || typeof name !== "string" || !name;
      }))
  ) {
    throw new Error("Protected branch status-check objects contain malformed entries");
  }
  const requiredStatusChecks = [...new Set([
    ...(Array.isArray(requiredStatusProtection.contexts) ? requiredStatusProtection.contexts : []),
    ...(Array.isArray(requiredStatusProtection.checks) ? requiredStatusProtection.checks.map((check) => check.context ?? check.name) : []),
    ...rulesetRequiredStatusChecks
  ])].sort();
  const protectedCheckApps = (Array.isArray(requiredStatusProtection.checks)
    ? requiredStatusProtection.checks.map((check) => ({
        context: check.context ?? check.name,
        appId: check.app_id
      }))
    : []);
  if (
    requiredStatusChecks.length > 0 &&
    (protectedCheckApps.length === 0 || protectedCheckApps.some((check) => !Number.isInteger(check.appId)))
  ) {
    throw new Error("Protected required checks lack a verifiable GitHub App identity");
  }
  if (
    digestObject(protectedCheckApps.sort((left, right) => left.context.localeCompare(right.context))) !==
    digestObject([...(payload.requiredStatusCheckApps ?? [])].sort((left, right) => String(left?.context).localeCompare(String(right?.context))))
  ) {
    throw new Error("Required check evidence does not match protected GitHub App identities");
  }
  if (digestObject(requiredStatusChecks) !== digestObject([...payload.requiredStatusChecks].sort())) {
    throw new Error("Required checks evidence does not match the protected branch status-check set");
  }
  const workflowPages = JSON.parse((await execFileAsync("gh", [
    "api",
    "--paginate",
    "--slurp",
    `repos/${repositoryPath}/actions/runs?head_sha=${encodeURIComponent(payload.head)}&per_page=100`
  ], { cwd, encoding: "utf8" })).stdout);
  if (!Array.isArray(workflowPages) || workflowPages.some((page) => !page || !Array.isArray(page.workflow_runs))) {
    throw new Error("Required check provider response is not a complete GitHub workflow-run set");
  }
  const runs = workflowPages.flatMap((page) => page.workflow_runs)
    .filter((run) => run?.head_sha === payload.head);
  const workflowCount = workflowPages.reduce((sum, page) => sum + page.workflow_runs.length, 0);
  const workflowTotal = workflowPages[0]?.total_count;
  if (!Number.isInteger(workflowTotal) || workflowTotal !== workflowCount || runs.length === 0) {
    throw new Error("Required check provider response is not a complete GitHub workflow-run set");
  }
  const observedAt = Date.parse(payload.observedAt ?? "");
  if (!Number.isFinite(observedAt)) {
    throw new Error("Required check evidence must include a valid observation timestamp");
  }
  for (const run of runs) {
    const completedAt = run.completed_at ?? run.updated_at;
    if (
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      !Number.isFinite(Date.parse(completedAt ?? "")) ||
      Date.parse(completedAt) > observedAt
    ) {
      throw new Error(`Required check workflow run is not a fresh successful GitHub run: ${run.id}`);
    }
  }
  const checkRunPages = JSON.parse((await execFileAsync("gh", [
    "api",
    "--paginate",
    "--slurp",
    `repos/${repositoryPath}/commits/${encodeURIComponent(payload.head)}/check-runs?per_page=100`
  ], { cwd, encoding: "utf8" })).stdout);
  if (!Array.isArray(checkRunPages) || checkRunPages.some((page) => !page || !Array.isArray(page.check_runs))) {
    throw new Error("Required check provider response is not a complete GitHub check-run set");
  }
  const checkRuns = checkRunPages.flatMap((page) => page.check_runs)
    .filter((check) => check?.head_sha === payload.head);
  const checkRunCount = checkRunPages.reduce((sum, page) => sum + page.check_runs.length, 0);
  const checkRunTotal = checkRunPages[0]?.total_count;
  if (!Number.isInteger(checkRunTotal) || checkRunTotal !== checkRunCount || checkRuns.length === 0) {
    throw new Error("Required check provider response is not a complete GitHub check-run set");
  }
  const observedIds = new Set(payload.checks.map((check) => String(check.providerRunId)));
  const providerIds = new Set(checkRuns.map((check) => String(check.id)));
  if (observedIds.size !== checkRuns.length || observedIds.size !== payload.checks.length ||
      [...providerIds].some((id) => !observedIds.has(id))) {
    throw new Error("Required check evidence does not cover the complete GitHub check-run set");
  }
  const observedRequired = new Set(payload.checks.map((check) => check.providerName));
  if (requiredStatusChecks.some((name) => !observedRequired.has(name))) {
    throw new Error("Required check evidence does not include every protected status check");
  }
  for (const check of payload.checks) {
    const checkRun = checkRuns.find((candidate) => String(candidate.id) === String(check.providerRunId));
    const completedAt = checkRun?.completed_at ?? checkRun?.updated_at;
    const protectedApp = protectedCheckApps.find((candidate) => candidate.context === checkRun?.name);
    if (
      !checkRun ||
      checkRun.head_sha !== payload.head ||
      checkRun.status !== "completed" ||
      checkRun.conclusion !== "success" ||
      check.providerName !== checkRun.name ||
      !protectedApp ||
      checkRun.app?.id !== protectedApp.appId ||
      check.name !== `${checkRun.name}#${checkRun.id}` ||
      !Number.isFinite(Date.parse(completedAt ?? "")) ||
      Date.parse(completedAt) > observedAt
    ) {
      throw new Error(`Required check provider check-run is not a fresh successful GitHub check: ${check.providerRunId}`);
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

function assertRemoteAuthorizationEvidence(admittedEvidence, request, providerAuthorization, expectedRepository) {
  const exact = admittedEvidence.some((record) => {
    if (record.kind !== "remote-authorization" || record.status !== "complete" || record.stale) return false;
    const payload = record.receipt?.payload;
    const producer = typeof record.receipt?.producer === "string"
      ? record.receipt.producer
      : record.receipt?.producer?.provider;
    const gitPush = request.provider === "git" && request.action === "git.push"
      ? GIT_PUSH_RESOURCE.exec(request.resource)
      : null;
    return (
      payload?.action === request.action &&
      payload?.provider === request.provider &&
      payload?.resource === request.resource &&
      payload?.remoteRevision === request.remoteRevision &&
      typeof payload?.repository === "string" && payload.repository.length > 0 &&
      typeof payload?.actor === "string" && payload.actor.length > 0 &&
      (!gitPush || (
        ["git", "github-cli-and-git"].includes(producer) &&
        payload.repository === expectedRepository &&
        payload.remote === gitPush[1] &&
        payload.ref === gitPush[2] &&
        payload.credentialCheck === "git-credential-actor"
      )) &&
      (!providerAuthorization || (
        payload.repository === providerAuthorization.repository &&
        payload.actor === providerAuthorization.actor
      ))
    );
  });
  if (!exact) throw new Error("Action token denied until remote authorization is bound to the exact actor, provider, resource, and revision");
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

function assertPersistedSuccessfulMergeAction(actions, mergeBinding) {
  const mergeAction = actions.find((action) => (
    action.action === "pr.merge" &&
    action.status === "spent" &&
    action.outcome === "success" &&
    action.pullRequest === mergeBinding.pullRequest &&
    action.reviewedHead === mergeBinding.reviewedHead &&
    action.reviewPackageId === mergeBinding.reviewPackageId &&
    action.receipt?.providerReceipt?.mergeCommit === mergeBinding.mergeCommit
  ));
  if (!mergeAction) {
    throw new Error("Remote sync requires a persisted successful pr.merge action");
  }
  return mergeAction;
}

export async function issueActionToken(root, runId, request, currentTreeDigest, config) {
  for (const field of ["action", "provider", "resource", "remoteRevision"]) {
    if (typeof request[field] !== "string" || !request[field]) throw new Error(`Action ${field} is required`);
  }
  return withRunLock(root, runId, async ({ runDir }) => {
    const contract = await readJson(root, safeJoin(runDir, "contract.json"));
    const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
    const state = await readJson(root, safeJoin(runDir, "state.json"));
    assertMutableRun({ state }, "Action token issuance");
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
    const needsProviderAuthorization = request.requiredEvidence.includes("remote-authorization") ||
      request.action === "pr.merge" ||
      (OWNED_RESOURCE_CREATION_ACTIONS.has(request.action) && request.provider === "github-cli");
    if (request.requiredEvidence.includes("target-branch-dev") || request.action === "pr.merge" || needsProviderAuthorization) {
      repository = await currentRepositoryIdentity(manifest.cwd);
      if (request.requiredEvidence.includes("target-branch-dev") || request.action === "pr.merge") {
        assertTargetBranchEvidence(admittedEvidence, request, repository, contract.remoteRevision ?? null);
      }
    }
    const providerAuthorization = needsProviderAuthorization &&
      (request.provider === "github-cli" || (request.provider === "git" && repository?.startsWith("github.com/")))
      ? await verifyGitHubProviderAuthorization(manifest.cwd, repository)
      : null;
    if (request.requiredEvidence.includes("remote-authorization") && request.action !== "git.push") {
      assertRemoteAuthorizationEvidence(admittedEvidence, request, providerAuthorization, repository);
    }
    let actionBinding = {};
    if (request.action === "git.push") {
      if (!request.requiredEvidence.includes("remote-authorization")) {
        throw new Error("Governed git.push requires remote-authorization evidence");
      }
      const [, remote, ref] = GIT_PUSH_RESOURCE.exec(request.resource) ?? [];
      if (!remote) throw new Error("Git push resources must use remote:<name>:refs/heads/<branch>");
      if (contract.template === "pr-to-dev" && ref === "refs/heads/dev") {
        throw new Error("pr-to-dev forbids direct pushes to protected dev");
      }
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
        expectedRevision,
        providerExecutable: await currentProviderExecutableIdentity("git"),
        pushCommand: ["git", "push", "--porcelain", remote, `${expectedRevision}:${ref}`]
      };
      if (request.requiredEvidence.includes("remote-authorization")) {
        if (!providerAuthorization || request.provider !== "git") {
          throw new Error("Git push requires a live GitHub identity plus a controlled Git credential check");
        }
        actionBinding.gitCredentialCheck = await verifyGitPushCredential(
          manifest.cwd,
          remote,
          ref,
          expectedRevision,
          remoteRepository,
          providerAuthorization.actor
        );
        assertRemoteAuthorizationEvidence(admittedEvidence, request, providerAuthorization, repository);
      }
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
    if (request.action === "pr.create") {
      if (request.resource !== "pull/new") {
        throw new Error("Governed PR creation requires the pull/new resource");
      }
      const expectedHead = (await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
        cwd: manifest.cwd,
        encoding: "utf8"
      })).stdout.trim();
      if (!SHA.test(expectedHead)) throw new Error("PR creation requires an exact candidate source head");
      const targetRef = contract.template === "pr-to-dev" ? "dev" : String(request.scope ?? "");
      if (!/^[A-Za-z0-9._/-]+$/.test(targetRef)) {
        throw new Error("PR creation requires an exact target branch via --scope");
      }
      const headBranch = (await execFileAsync("git", ["branch", "--show-current"], {
        cwd: manifest.cwd,
        encoding: "utf8"
      })).stdout.trim();
      if (!/^[A-Za-z0-9._/-]+$/.test(headBranch) || headBranch === targetRef) {
        throw new Error("PR creation requires a distinct current candidate branch");
      }
      const goal = String(manifest.goal ?? "Better Workflows delivery").replace(/\s+/g, " ").trim();
      const prTitle = `Better Workflows: ${goal || "delivery"}`.slice(0, 240);
      const prBodyPrefix = [
        "Automated Better Workflows delivery.",
        "",
        `Goal: ${goal || "Better Workflows delivery"}`
      ].join("\n");
      actionBinding = {
        ...actionBinding,
        expectedHead,
        targetRef,
        headBranch,
        createRepository: repository,
        prTitle,
        prBodyPrefix,
        providerExecutable: await currentProviderExecutableIdentity("gh")
      };
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
        providerExecutable: await currentProviderExecutableIdentity("gh"),
        mergeRepository: repository,
        mergeCommand: [
          "gh",
          "pr",
          "merge",
          String(pullRequest),
          "--repo",
          repository.slice("github.com/".length),
          "--match-head-commit",
          currentHead,
          "--merge",
          "--delete-branch=false"
        ]
      };
    }
    if (providerAuthorization) actionBinding.providerAuthorization = providerAuthorization;
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
    let creationPrecondition = null;
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
        const mergeBinding = assertRemoteSyncMergeBinding(admittedEvidence, review.package, contract, repository);
        assertPersistedSuccessfulMergeAction(actions, mergeBinding);
        actionBinding = {
          ...actionBinding,
          ...mergeBinding
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
    let reservationHeld = false;
    const issuedAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    try {
      if (OWNED_RESOURCE_CREATION_ACTIONS.has(request.action)) {
        // Reserve before observing absence so an external creator cannot win the gap.
        await reserveCreationResource(root, runId, request.resource, tokenHash, expiresAt);
        reservationHeld = true;
        creationPrecondition = await captureCreationPrecondition(manifest.cwd, request.action, request.resource);
        if (!creationPrecondition || creationPrecondition.state !== "absent") {
          throw new Error("Owned resource creation requires an observed absent precondition after reservation");
        }
      }
      const record = {
        schemaVersion: 1,
        tokenHash,
        status: "issued",
        outcome: null,
        issuedAt,
        expiresAt,
        runId,
        action: request.action,
        provider: request.provider,
        resource: request.resource,
        scope: request.scope ?? request.resource,
        remoteRevision: request.remoteRevision,
        ...actionBinding,
        ...(creationPrecondition ? { creationPrecondition } : {}),
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
    } catch (error) {
      if (reservationHeld) await releaseCreationResource(root, runId, request.resource, tokenHash);
      throw error;
    }
  });
}

export async function consumeActionToken(root, runId, token, currentTreeDigest) {
  const tokenHash = sha256(token);
  return withRunLock(root, runId, async ({ runDir }) => {
    const state = await readJson(root, safeJoin(runDir, "state.json"));
    assertMutableRun({ state }, "Action token consumption");
    const target = safeJoin(runDir, "actions", `${tokenHash}.json`);
    const record = await readJson(root, target);
    if (record.status !== "issued") throw new Error("Action token was already consumed");
    if (Date.parse(record.expiresAt) <= Date.now()) throw new Error("Action token expired");
    if (OWNED_RESOURCE_CREATION_ACTIONS.has(record.action)) {
      const reservation = await readJson(root, creationReservationPath(root, record.resource)).catch(() => null);
      if (
        reservation?.runId !== runId ||
        reservation.tokenHash !== tokenHash ||
        reservation.expiresAt !== record.expiresAt ||
        Date.parse(reservation.expiresAt ?? "") <= Date.now()
      ) {
        throw new Error("Action token creation reservation is missing, expired, or rebound");
      }
    }
    if (record.treeDigest !== currentTreeDigest) throw new Error("Action token tree binding changed");
    const contract = await readJson(root, safeJoin(runDir, "contract.json"));
    if (record.contractDigest !== digestObject(contract)) throw new Error("Action token contract binding changed");
    const manifest = await readJson(root, safeJoin(runDir, "manifest.json"));
    if (record.providerAuthorization?.provider === "github-cli") {
      const repository = await currentRepositoryIdentity(manifest.cwd);
      const authorization = await verifyGitHubProviderAuthorization(manifest.cwd, repository);
      if (digestObject(authorization) !== digestObject(record.providerAuthorization)) {
        throw new Error("Action consumption denied because GitHub provider authorization changed");
      }
    }
    if (record.gitCredentialCheck) {
      const credentialCheck = await verifyGitPushCredential(
        manifest.cwd,
        record.gitCredentialCheck.remote,
        record.gitCredentialCheck.ref,
        record.gitCredentialCheck.revision,
        record.gitCredentialCheck.repository,
        record.providerAuthorization?.actor ?? null
      );
      if (digestObject(credentialCheck) !== digestObject(record.gitCredentialCheck)) {
        throw new Error("Action consumption denied because the controlled Git credential check changed");
      }
    }
    if (record.action === "pr.create" || record.action === "pr.merge" || record.action === "git.push") {
      const executable = await currentProviderExecutableIdentity(record.action === "git.push" ? "git" : "gh");
      if (digestObject(executable) !== digestObject(record.providerExecutable)) {
        throw new Error("Action consumption denied because the governed provider executable changed");
      }
    }
    if (record.action === "pr.merge") {
      await verifyPullRequestBeforeMerge(manifest.cwd, record);
      if (contract.actionGates?.[record.action]?.includes("required-checks")) {
        const repository = await currentRepositoryIdentity(manifest.cwd);
        const evidence = await listJsonRecords(root, safeJoin(runDir, "evidence"));
        const requiredChecks = evidence.find((item) => {
          const payload = item.kind === "required-checks" ? item.receipt?.payload : null;
          return (
            item.status === "complete" &&
            item.stale !== true &&
            payload?.head === record.reviewedHead &&
            payload?.base === record.remoteRevision &&
            payload?.repository === repository
          );
        });
        if (!requiredChecks) throw new Error("Action consumption denied until exact required-check evidence is present");
        const run = await loadRun(root, runId);
        const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
        await validateTypedEvidenceRecord(requiredChecks, {
          manifest: run.manifest,
          contract: run.contract,
          root,
          runDir,
          requireReconciled: true
        });
        await verifyRequiredChecksProvider(manifest.cwd, requiredChecks.receipt.payload);
      }
    }
    if (record.action === "remote.sync") {
      const actions = await listJsonRecords(root, safeJoin(runDir, "actions"));
      assertPersistedSuccessfulMergeAction(actions, record);
    }
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

export async function executeActionToken(root, runId, token, currentTreeDigest) {
  const actionRecord = await readJson(root, safeJoin(runDirectory(root, runId), "actions", `${sha256(token)}.json`));
  if (!EXECUTABLE_ACTION_PROVIDERS.has(`${actionRecord.action}:${actionRecord.provider}`)) {
    throw new Error("The governed provider execution path only supports github-cli pr.merge and git.push");
  }
  const consumed = await consumeActionToken(root, runId, token, currentTreeDigest);
  if (consumed.action === "git.push" && consumed.provider === "git") {
    const expectedCommand = consumed.pushCommand;
    if (!Array.isArray(expectedCommand) || expectedCommand.length !== 5 || expectedCommand[0] !== "git") {
      throw new Error("Git push execution command is not the fixed non-force invocation");
    }
    const manifest = await readJson(root, safeJoin(runDirectory(root, runId), "manifest.json"));
    const executable = await currentProviderExecutableIdentity("git");
    if (digestObject(executable) !== digestObject(consumed.providerExecutable)) {
      throw new Error("Git push execution denied because the governed provider executable changed");
    }
    const remote = consumed.remote;
    const ref = `refs/heads/${consumed.expectedBranch}`;
    const credentialCheck = await verifyGitPushCredential(
      manifest.cwd,
      remote,
      ref,
      consumed.expectedRevision,
      consumed.remoteRepository,
      consumed.providerAuthorization?.actor ?? null
    );
    if (digestObject(credentialCheck) !== digestObject(consumed.gitCredentialCheck)) {
      throw new Error("Git push execution denied because the credential actor changed");
    }
    const currentRevision = (await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: manifest.cwd,
      encoding: "utf8"
    })).stdout.trim();
    if (currentRevision !== consumed.expectedRevision) {
      throw new Error("Git push execution denied because the candidate revision changed");
    }
    return withRunLock(root, runId, async ({ runDir }) => {
      const run = await loadRun(root, runId);
      assertMutableRun(run, "Action provider execution");
      const target = safeJoin(runDir, "actions", `${consumed.tokenHash}.json`);
      const current = await readJson(root, target);
      if (current.status !== "spent" || current.attemptId !== consumed.attemptId) {
        throw new Error("Git push provider invocation is not bound to the consumed action attempt");
      }
      const startedAt = nowIso();
      let exitCode = 0;
      try {
        await execFileAsync(executable.path, expectedCommand.slice(1), {
          cwd: run.manifest.cwd,
          encoding: "utf8",
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
        });
      } catch (error) {
        exitCode = Number.isInteger(error?.code) ? error.code : 1;
      }
      const invocation = {
        schemaVersion: 1,
        id: `git-push-wrapper:${runId}:${consumed.attemptId}`,
        actionAttemptId: consumed.attemptId,
        provider: "git",
        command: expectedCommand,
        providerExecutable: executable,
        providerAuthorization: consumed.providerAuthorization,
        credentialActor: credentialCheck.actor,
        startedAt,
        finishedAt: nowIso(),
        exitCode
      };
      const next = { ...current, providerInvocation: invocation };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "action.provider-invoked", {
        attemptId: consumed.attemptId,
        invocationId: invocation.id,
        exitCode
      });
      return next;
    }, { ttlMs: 300_000 });
  }
  if (consumed.action === "pr.create" && consumed.provider === "github-cli") {
    const manifest = await readJson(root, safeJoin(runDirectory(root, runId), "manifest.json"));
    const executable = await currentProviderExecutableIdentity("gh");
    if (digestObject(executable) !== digestObject(consumed.providerExecutable)) {
      throw new Error("PR creation execution denied because the governed provider executable changed");
    }
    const providerAuthorization = await verifyCreateProviderAtInvocation(consumed, manifest);
    const expectedCommand = buildPrCreateCommand(consumed);
    return withRunLock(root, runId, async ({ runDir }) => {
      const run = await loadRun(root, runId);
      assertMutableRun(run, "Action provider execution");
      const target = safeJoin(runDir, "actions", `${consumed.tokenHash}.json`);
      const current = await readJson(root, target);
      if (current.status !== "spent" || current.attemptId !== consumed.attemptId) {
        throw new Error("PR creation provider invocation is not bound to the consumed action attempt");
      }
      const startedAt = nowIso();
      let exitCode = 0;
      try {
        await execFileAsync(executable.path, expectedCommand.slice(1), {
          cwd: run.manifest.cwd,
          encoding: "utf8"
        });
      } catch (error) {
        exitCode = Number.isInteger(error?.code) ? error.code : 1;
      }
      const invocation = {
        schemaVersion: 1,
        id: `github-pr-create-wrapper:${runId}:${consumed.attemptId}`,
        actionAttemptId: consumed.attemptId,
        provider: "github-cli",
        command: expectedCommand,
        providerExecutable: executable,
        providerAuthorization,
        startedAt,
        finishedAt: nowIso(),
        exitCode
      };
      const next = { ...current, providerInvocation: invocation };
      await atomicWriteJson(root, target, next);
      await appendJournal(root, runDir, "action.provider-invoked", {
        attemptId: consumed.attemptId,
        invocationId: invocation.id,
        exitCode
      });
      return next;
    }, { ttlMs: 300_000 });
  }
  if (consumed.action !== "pr.merge" || consumed.provider !== "github-cli") {
    throw new Error("The governed provider execution path only supports github-cli pr.create/pr.merge and git.push");
  }
  const expectedCommand = [
    "gh",
    "pr",
    "merge",
    String(consumed.pullRequest),
    "--repo",
    consumed.mergeRepository?.slice("github.com/".length),
    "--match-head-commit",
    consumed.reviewedHead,
    "--merge",
    "--delete-branch=false"
  ];
  if (!consumed.mergeRepository || JSON.stringify(consumed.mergeCommand) !== JSON.stringify(expectedCommand)) {
    throw new Error("PR merge execution command is not the fixed non-admin invocation");
  }
  const manifest = await readJson(root, safeJoin(runDirectory(root, runId), "manifest.json"));
  const executable = await currentProviderExecutableIdentity("gh");
  if (digestObject(executable) !== digestObject(consumed.providerExecutable)) {
    throw new Error("PR merge execution denied because the governed provider executable changed");
  }
  // Re-check provider actor, branch policy, PR head, and fresh checks immediately before gh invocation.
  const providerAuthorization = await verifyMergeProviderAtInvocation(root, runId, consumed, manifest);
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Action provider execution");
    const target = safeJoin(runDir, "actions", `${consumed.tokenHash}.json`);
    const current = await readJson(root, target);
    if (current.status !== "spent" || current.attemptId !== consumed.attemptId) {
      throw new Error("PR merge provider invocation is not bound to the consumed action attempt");
    }
    const startedAt = nowIso();
    let exitCode = 0;
    try {
      await execFileAsync(executable.path, expectedCommand.slice(1), { cwd: run.manifest.cwd, encoding: "utf8" });
    } catch (error) {
      exitCode = Number.isInteger(error?.code) ? error.code : 1;
    }
    const invocation = {
      schemaVersion: 1,
      id: `github-pr-merge-wrapper:${runId}:${consumed.attemptId}`,
      actionAttemptId: consumed.attemptId,
      provider: "github-cli",
      command: expectedCommand,
      adminBypass: false,
      providerExecutable: executable,
      providerAuthorization,
      startedAt,
      finishedAt: nowIso(),
      exitCode
    };
    const next = { ...current, providerInvocation: invocation };
    await atomicWriteJson(root, target, next);
    await appendJournal(root, runDir, "action.provider-invoked", {
      attemptId: consumed.attemptId,
      invocationId: invocation.id,
      exitCode
    });
    return next;
  }, { ttlMs: 300_000 });
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
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Action reconciliation");
    const records = await listJsonRecords(root, safeJoin(runDir, "actions"));
    const record = records.find((item) => item.attemptId === attemptId);
    if (!record) throw new Error(`Unknown action attempt: ${attemptId}`);
    if (record.status !== "spent" || record.outcome !== "pending") {
      throw new Error("Action attempt was already reconciled");
    }
    validateActionReceipt(record, outcome, receipt);
    if (outcome === "failure" && OWNED_RESOURCE_CREATION_ACTIONS.has(record.action)) {
      const failureAbsence = await verifyFailedCreationAbsence(run.manifest, record);
      receipt = {
        ...receipt,
        providerReceipt: {
          ...receipt.providerReceipt,
          failureAbsence
        }
      };
    }
    if (
      record.action === "pr.merge" &&
      outcome === "success" &&
      (!record.providerInvocation ||
        record.providerInvocation.provider !== "github-cli" ||
        record.providerInvocation.adminBypass !== false ||
        record.providerInvocation.exitCode !== 0 ||
        digestObject(record.providerInvocation.providerExecutable) !== digestObject(record.providerExecutable) ||
        JSON.stringify(record.providerInvocation.command) !== JSON.stringify(record.mergeCommand) ||
        receipt.providerReceipt.invocationId !== record.providerInvocation.id)
    ) {
      throw new Error("Successful PR merge reconciliation requires the governed non-admin provider wrapper");
    }
    if (
      record.action === "pr.create" &&
      outcome === "success" &&
      (!record.providerInvocation ||
        record.providerInvocation.provider !== "github-cli" ||
        record.providerInvocation.exitCode !== 0 ||
        digestObject(record.providerInvocation.providerExecutable) !== digestObject(record.providerExecutable) ||
        digestObject(record.providerInvocation.providerAuthorization) !== digestObject(record.providerAuthorization) ||
        JSON.stringify(record.providerInvocation.command) !== JSON.stringify(buildPrCreateCommand(record)))
    ) {
      throw new Error("Successful PR creation reconciliation requires the governed provider wrapper");
    }
    if (
      record.action === "git.push" &&
      outcome === "success" &&
      (!record.providerInvocation ||
        record.providerInvocation.provider !== "git" ||
        record.providerInvocation.exitCode !== 0 ||
        digestObject(record.providerInvocation.providerExecutable) !== digestObject(record.providerExecutable) ||
        digestObject(record.providerInvocation.providerAuthorization) !== digestObject(record.providerAuthorization) ||
        record.providerInvocation.credentialActor !== record.gitCredentialCheck?.actor ||
        JSON.stringify(record.providerInvocation.command) !== JSON.stringify(record.pushCommand))
    ) {
      throw new Error("Successful Git push reconciliation requires the governed actor-bound provider wrapper");
    }
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
    if (outcome === "failure" && OWNED_RESOURCE_CREATION_ACTIONS.has(record.action)) {
      await releaseCreationResource(root, runId, record.resource, record.tokenHash);
    }
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

async function reapExpiredCreationReservations(root) {
  const directory = safeJoin(root, "creation-reservations");
  if (!(await pathExists(directory))) return;
  await assertNoSymlinkUnder(root, directory);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const target = safeJoin(directory, entry.name);
    const reservation = await readJson(root, target).catch(() => null);
    if (!reservation?.runId || !reservation?.tokenHash || Date.parse(reservation.expiresAt ?? "") > Date.now()) continue;
    const action = await readJson(root, safeJoin(runDirectory(root, reservation.runId), "actions", `${reservation.tokenHash}.json`)).catch(() => null);
    if (!action || action.status === "issued") await unlink(target).catch(() => undefined);
  }
}

export async function cleanupRuns(root, { olderThanDays, apply = false }) {
  await ensureStateRoot(root);
  await reapExpiredCreationReservations(root);
  const runsRoot = safeJoin(root, "runs");
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const candidates = [];
  const candidateMtimes = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
    const runDir = runDirectory(root, entry.name);
    await assertNoSymlinkUnder(root, runDir);
    const state = await readJson(root, safeJoin(runDir, "state.json")).catch(() => null);
    const manifest = await readJson(root, safeJoin(runDir, "manifest.json")).catch(() => null);
    const actions = await listJsonRecords(root, safeJoin(runDir, "actions")).catch(() => []);
    const info = await stat(runDir);
    const ownedResources = Array.isArray(manifest?.ownedResources) ? manifest.ownedResources : [];
    const ownedResourcesCleared = ownedResources.every((entry) => actions.some((action) => (
      action.resource === entry.resource &&
      DESTRUCTIVE_CLEANUP_ACTIONS.has(action.action) &&
      action.status === "spent" &&
      action.outcome === "success" &&
      action.receipt?.providerReceipt?.resource === entry.resource
    )));
    const pendingSideEffect = actions.some((action) => action.status !== "spent" || ["pending", "unknown", "failure"].includes(action.outcome));
    if (
      state &&
      ["completed", "no_op", "cancelled_superseded", "cancelled_evidence_sufficient"].includes(state.status) &&
      info.mtimeMs < cutoff &&
      ownedResourcesCleared &&
      !pendingSideEffect
    ) {
      candidates.push(entry.name);
      candidateMtimes.set(entry.name, info.mtimeMs);
    }
  }
  if (apply) {
    for (const runId of candidates) {
      if (!(await pathExists(runDirectory(root, runId)))) continue;
      try {
        await withRunLock(root, runId, async ({ runDir }) => {
          const state = await readJson(root, safeJoin(runDir, "state.json")).catch(() => null);
          const manifest = await readJson(root, safeJoin(runDir, "manifest.json")).catch(() => null);
          const actions = await listJsonRecords(root, safeJoin(runDir, "actions")).catch(() => []);
          const ownedResources = Array.isArray(manifest?.ownedResources) ? manifest.ownedResources : [];
          const ownedResourcesCleared = ownedResources.every((entry) => actions.some((action) => (
            action.resource === entry.resource &&
            DESTRUCTIVE_CLEANUP_ACTIONS.has(action.action) &&
            action.status === "spent" &&
            action.outcome === "success" &&
            action.receipt?.providerReceipt?.resource === entry.resource
          )));
          const pendingSideEffect = actions.some((action) => action.status !== "spent" || ["pending", "unknown", "failure"].includes(action.outcome));
          const terminalAt = Date.parse(state?.updatedAt ?? "");
          const oldEnough = Number.isFinite(terminalAt)
            ? terminalAt < cutoff
            : candidateMtimes.get(runId) < cutoff;
          if (
            state &&
            ["completed", "no_op", "cancelled_superseded", "cancelled_evidence_sufficient"].includes(state.status) &&
            oldEnough &&
            ownedResourcesCleared &&
            !pendingSideEffect
          ) {
            for (const entry of ownedResources) await releaseCreationResource(root, runId, entry.resource);
            await rm(runDir, { recursive: true, force: false });
          }
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return { apply, candidates };
}
