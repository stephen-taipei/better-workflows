import { constants as fsConstants } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  unlink
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteJson,
  assertProviderReceiptShape,
  digestObject,
  ensurePrivateDir,
  execBoundGit,
  execBoundProcess,
  hasCredentialShapedMaterial,
  inspectRun,
  nowIso,
  pluginRoot,
  readJson,
  safeJoin,
  sha256
} from "./core.mjs";
import { processIncarnationDigest } from "./publication.mjs";

const POLICY_PATH = path.join(pluginRoot(), "config", "task-worktree-v1.json");
const GIT = "/usr/bin/git";
const GIT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const SHA1 = /^[a-f0-9]{40}$/;
const REPOSITORY_ID = /^[a-f0-9]{16}$/;
const TASK_ID = /^[a-z0-9][a-z0-9-]{5,63}$/;
const ROUTE_RECEIPT_ID = /^route-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{|\\|[~^:?*[\x00-\x20\x7f]))(?!.*\/$)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]+$/;
const MAX_WORKSPACE_LEASE_RECORDS = 4096;
const WORKSPACE_LOCK_SCHEMA_VERSION = 1;
const DIRECT_CHECK_GUARD_ID = "trusted-node-offline-v1";
const DIRECT_CHECK_GUARD_SOURCE = [
  "'use strict';",
  "const { syncBuiltinESMExports } = require('node:module');",
  "const deny = (surface) => function sbwDirectNetworkDenied() { const error = new Error('Better Workflows Direct check denied network surface: ' + surface); error.code = 'SBW_DIRECT_NETWORK_DENIED'; throw error; };",
  "const bind = (target, key, surface) => { if (!target || !(key in target)) return; Object.defineProperty(target, key, { value: deny(surface), configurable: false, enumerable: target.propertyIsEnumerable?.(key) ?? false, writable: false }); };",
  "const net = require('node:net'); const tls = require('node:tls'); const http = require('node:http'); const https = require('node:https'); const http2 = require('node:http2'); const dgram = require('node:dgram'); const dns = require('node:dns');",
  "bind(net, 'connect', 'net.connect'); bind(net, 'createConnection', 'net.createConnection'); bind(net.Socket && net.Socket.prototype, 'connect', 'net.Socket.connect');",
  "bind(tls, 'connect', 'tls.connect'); bind(tls.TLSSocket && tls.TLSSocket.prototype, 'connect', 'tls.TLSSocket.connect');",
  "bind(http, 'request', 'http.request'); bind(http, 'get', 'http.get'); bind(http.Agent && http.Agent.prototype, 'createConnection', 'http.Agent.createConnection');",
  "bind(https, 'request', 'https.request'); bind(https, 'get', 'https.get'); bind(https.Agent && https.Agent.prototype, 'createConnection', 'https.Agent.createConnection');",
  "bind(http2, 'connect', 'http2.connect'); bind(dgram, 'createSocket', 'dgram.createSocket');",
  "for (const key of ['lookup','lookupService','resolve','resolve4','resolve6','resolveAny','resolveCaa','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','reverse']) bind(dns, key, 'dns.' + key);",
  "if (dns.promises) for (const key of ['lookup','lookupService','resolve','resolve4','resolve6','resolveAny','resolveCaa','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','reverse']) bind(dns.promises, key, 'dns.promises.' + key);",
  "const nodeOs = require('node:os'); bind(nodeOs, 'setPriority', 'os.setPriority'); bind(process, 'kill', 'process.kill'); bind(process, '_debugProcess', 'process._debugProcess');",
  "const sqlite = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : undefined; if (sqlite) { bind(sqlite, 'DatabaseSync', 'sqlite.DatabaseSync'); bind(sqlite, 'Database', 'sqlite.Database'); }",
  "bind(globalThis, 'fetch', 'global.fetch'); bind(globalThis, 'WebSocket', 'global.WebSocket'); bind(globalThis, 'EventSource', 'global.EventSource');",
  "if (globalThis.navigator) bind(globalThis.navigator, 'sendBeacon', 'navigator.sendBeacon');",
  "syncBuiltinESMExports();"
].join("\n");
const DIRECT_CHECK_GUARD_DIGEST = sha256(DIRECT_CHECK_GUARD_SOURCE);
const DIRECT_FORBIDDEN_NODE_ARGUMENT = /^(?:--(?:allow-|permission(?:=|$)|no-permission(?:=|$)|experimental-permission(?:=|$)|no-experimental-permission(?:=|$)|require(?:=|$)|import(?:=|$)|loader(?:=|$)|experimental-loader(?:=|$)|env-file(?:-if-exists)?(?:=|$)|openssl-config(?:=|$)|inspect(?:[-=]|$)|test-isolation(?:=|$)|snapshot-blob(?:=|$)|build-snapshot(?:-config)?(?:=|$)|experimental-sea-config(?:=|$)|run(?:=|$)|security-revert(?:=|$)|max[-_]old[-_]space[-_]size(?:=|$))|-r(?:$|.))/;
const LIFECYCLE = new Set([
  "planned",
  "target-bound",
  "isolated",
  "working",
  "validated",
  "integration-ready",
  "integrated",
  "cleanup-ready",
  "cleaned"
]);
const BLOCKED = new Set([
  "dirty-source",
  "target-missing",
  "target-drift",
  "ownership-conflict",
  "merge-conflict",
  "validation-failed",
  "unknown-integration"
]);

function gitEnvironment() {
  return {
    PATH: GIT_PATH,
    HOME: "/var/empty",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0"
  };
}

async function git(cwd, args, { allowFailure = false } = {}) {
  const hardenedArgs = [
    "--no-replace-objects",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "commit.gpgsign=false",
    ...args
  ];
  try {
    const result = await execBoundGit(GIT, hardenedArgs, {
      cwd,
      env: gitEnvironment(),
      timeoutMs: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || "git command failed").trim();
    if (allowFailure) {
      return {
        ok: false,
        stdout: String(error.stdout ?? ""),
        stderr: detail,
        code: Number.isInteger(error.code) ? error.code : 1,
        signal: error.signal ?? null
      };
    }
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

function oneLine(output, label, pattern = null) {
  if (typeof output !== "string" || !output.endsWith("\n") || output.slice(0, -1).includes("\n")) {
    throw new Error(`${label} returned malformed output`);
  }
  const value = output.slice(0, -1);
  if (pattern && !pattern.test(value)) throw new Error(`${label} returned an invalid value`);
  return value;
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function branchRef(branch) {
  if (!BRANCH.test(branch)) throw new Error(`Unsafe branch name: ${branch}`);
  return `refs/heads/${branch}`;
}

function normalizeTaskId(taskId = null) {
  if (taskId === null || taskId === undefined || taskId === "") {
    return `task-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  }
  const value = String(taskId).toLowerCase();
  if (!TASK_ID.test(value)) throw new Error("taskId must be 6-64 lowercase letters, numbers, or hyphens");
  return value;
}

function goalSlug(goal) {
  const slug = String(goal ?? "task")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || "task";
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function validateDirectRouteBinding(binding) {
  exactKeys(binding, [
    "schemaVersion",
    "kind",
    "routeReceiptId",
    "assessmentDigest",
    "sourceRevision",
    "integrationTarget",
    "integrationTargetRevision",
    "basicCheckPlan",
    "boundAt",
    "bindingDigest"
  ], "Direct workspace route binding");
  const payload = { ...binding };
  delete payload.bindingDigest;
  if (
    binding.schemaVersion !== 1 ||
    binding.kind !== "DirectWorkspaceRouteBindingV1" ||
    !ROUTE_RECEIPT_ID.test(binding.routeReceiptId) ||
    !/^[a-f0-9]{64}$/.test(binding.assessmentDigest) ||
    !SHA1.test(binding.sourceRevision) ||
    !BRANCH.test(binding.integrationTarget) ||
    isProtectedBranch(binding.integrationTarget) ||
    !SHA1.test(binding.integrationTargetRevision) ||
    !Array.isArray(binding.basicCheckPlan) || binding.basicCheckPlan.length < 1 || binding.basicCheckPlan.length > 16 ||
    binding.basicCheckPlan.some((check) => typeof check !== "string" || !check.trim() || check.length > 160 || /[\r\n]/.test(check)) ||
    Number.isNaN(Date.parse(binding.boundAt)) ||
    !/^[a-f0-9]{64}$/.test(binding.bindingDigest) ||
    digestObject(payload) !== binding.bindingDigest
  ) {
    throw new Error("Direct workspace route binding identity or digest is invalid");
  }
  return binding;
}

export async function loadTaskWorktreePolicy() {
  const policy = JSON.parse(await readFile(POLICY_PATH, "utf8"));
  exactKeys(
    policy,
    [
      "schemaVersion",
      "id",
      "taskBranchPrefix",
      "integrationBranchPrefix",
      "protectedBranchPatterns",
      "directCheck",
      "integration",
      "lifecycle",
      "blockedStates",
      "authorizedActions",
      "forbiddenActions"
    ],
    "task-worktree-v1 policy"
  );
  if (policy.schemaVersion !== 1 || policy.id !== "task-worktree-v1") throw new Error("Invalid task-worktree-v1 identity");
  if (policy.taskBranchPrefix !== "codex/" || policy.integrationBranchPrefix !== "codex/integrate-") {
    throw new Error("task-worktree-v1 branch prefixes changed");
  }
  exactKeys(
    policy.directCheck,
    ["timeoutMs", "maxOutputBytes", "allowedExecutables", "isolation"],
    "task-worktree-v1 directCheck"
  );
  exactKeys(
    policy.directCheck.isolation,
    ["id", "nodePermissionModel", "networkGuard", "filesystemReads", "filesystemWrites"],
    "task-worktree-v1 directCheck isolation"
  );
  if (
    JSON.stringify(policy.directCheck.allowedExecutables) !== JSON.stringify(["node"]) ||
    policy.directCheck.isolation.id !== DIRECT_CHECK_GUARD_ID ||
    policy.directCheck.isolation.nodePermissionModel !== true ||
    policy.directCheck.isolation.networkGuard !== "deny-standard-node-network" ||
    policy.directCheck.isolation.filesystemReads !== "task-worktree-and-scratch-only" ||
    policy.directCheck.isolation.filesystemWrites !== "task-scoped-scratch-only"
  ) {
    throw new Error("task-worktree-v1 Direct check isolation policy changed");
  }
  if (policy.integration.casRetries !== 1 || policy.integration.allowRebase !== false || policy.integration.allowForce !== false) {
    throw new Error("task-worktree-v1 integration safety policy changed");
  }
  if (JSON.stringify(policy.lifecycle) !== JSON.stringify([...LIFECYCLE]) || JSON.stringify(policy.blockedStates) !== JSON.stringify([...BLOCKED])) {
    throw new Error("task-worktree-v1 lifecycle policy changed");
  }
  return policy;
}

export function isProtectedBranch(branch, patterns = ["main", "master", "dev", "develop", "release/*"]) {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/*")) return branch.startsWith(pattern.slice(0, -1));
    return branch === pattern;
  });
}

async function repositoryInfo(cwd) {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (!top.ok) {
    if (/not a git repository/i.test(top.stderr)) return null;
    throw new Error(`Repository discovery failed: ${top.stderr}`);
  }
  const topLevel = await realpath(oneLine(top.stdout, "Repository root"));
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDirectory = await realpath(oneLine(common.stdout, "Git common directory"));
  const objectFormatResult = await git(cwd, ["rev-parse", "--show-object-format"]);
  const objectFormat = oneLine(objectFormatResult.stdout, "Git object format");
  if (objectFormat !== "sha1") throw new Error(`Unsupported Git object format: ${objectFormat}`);
  const repositoryDigest = digestObject({ commonDirectory, objectFormat });
  return {
    topLevel,
    commonDirectory,
    objectFormat,
    repositoryDigest,
    repositoryId: repositoryDigest.slice(0, 16)
  };
}

async function headRevision(cwd) {
  return oneLine((await git(cwd, ["rev-parse", "HEAD"])).stdout, "HEAD revision", SHA1).toLowerCase();
}

async function currentBranch(cwd) {
  const result = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
  if (!result.ok) {
    if (result.code === 1) return null;
    throw new Error(`Source branch discovery failed: ${result.stderr}`);
  }
  const branch = oneLine(result.stdout, "Source branch");
  if (!BRANCH.test(branch)) throw new Error("Source branch name is unsafe");
  return branch;
}

async function resolveLocalBranch(cwd, branch) {
  const result = await git(cwd, ["rev-parse", "--verify", `${branchRef(branch)}^{commit}`], { allowFailure: true });
  if (!result.ok) {
    if (result.code === 1 || /unknown revision|Needed a single revision|not a valid object name/i.test(result.stderr)) return null;
    throw new Error(`Target branch resolution failed: ${result.stderr}`);
  }
  return oneLine(result.stdout, "Target branch revision", SHA1).toLowerCase();
}

function parseWorktreeList(output) {
  if (typeof output !== "string") throw new Error("Git worktree list returned non-text output");
  const records = [];
  let current = null;
  for (const token of output.split("\0")) {
    if (!token) {
      if (current) {
        records.push(current);
        current = null;
      }
      continue;
    }
    const separator = token.indexOf(" ");
    const key = separator === -1 ? token : token.slice(0, separator);
    const value = separator === -1 ? true : token.slice(separator + 1);
    if (key === "worktree") {
      if (current) records.push(current);
      current = { path: value, head: null, branch: null, bare: false, detached: false, locked: null, prunable: null };
      continue;
    }
    if (!current) throw new Error("Git worktree list began without a worktree record");
    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
    else if (key === "locked") current.locked = value === true ? "" : value;
    else if (key === "prunable") current.prunable = value === true ? "" : value;
    else throw new Error(`Unknown git worktree porcelain field: ${key}`);
  }
  if (current) records.push(current);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (typeof record.path !== "string" || !record.path || (record.head !== null && !SHA1.test(record.head))) {
      throw new Error("Git worktree list contains a malformed record");
    }
  }
  return records;
}

async function worktreeList(cwd) {
  return parseWorktreeList((await git(cwd, ["worktree", "list", "--porcelain", "-z"])).stdout);
}

function parseStatus(output) {
  const records = output.split("\0").filter(Boolean);
  const state = {
    clean: records.length === 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: []
  };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith("? ")) {
      state.untracked.push(record.slice(2));
      continue;
    }
    if (record.startsWith("u ")) {
      state.conflicts.push(record);
      continue;
    }
    if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const originalPath = record.startsWith("2 ") ? records[++index] : null;
      if (record.startsWith("2 ") && originalPath === undefined) {
        throw new Error("Git status porcelain v2 rename record is incomplete");
      }
      const xy = record.split(" ", 3)[1] ?? "..";
      const normalized = originalPath === null ? record : `${record}\0${originalPath}`;
      if (xy[0] !== ".") state.staged.push(normalized);
      if (xy[1] !== ".") state.unstaged.push(normalized);
      continue;
    }
    throw new Error("Git status porcelain v2 returned an unknown record");
  }
  return state;
}

async function worktreeState(cwd) {
  const status = parseStatus((await git(cwd, ["status", "--porcelain=v2", "--untracked-files=all", "-z"])).stdout);
  const submodules = await git(cwd, ["submodule", "status", "--recursive"], { allowFailure: true });
  if (!submodules.ok) throw new Error(`Submodule status is indeterminate: ${submodules.stderr}`);
  const dirtySubmodules = submodules.stdout
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.startsWith(" "));
  return {
    ...status,
    dirtySubmodules,
    clean: status.clean && dirtySubmodules.length === 0,
    digest: digestObject({ status, dirtySubmodules })
  };
}

function leaseDirectory(stateRoot, repositoryId) {
  if (!REPOSITORY_ID.test(String(repositoryId))) throw new Error("Invalid workspace repository id");
  return safeJoin(stateRoot, "workspace-leases", repositoryId);
}

function leasePath(stateRoot, repositoryId, taskId) {
  return safeJoin(leaseDirectory(stateRoot, repositoryId), `${taskId}.json`);
}

async function writeLease(stateRoot, target, lease) {
  const stable = {
    ...lease,
    updatedAt: nowIso()
  };
  delete stable.leaseDigest;
  const next = { ...stable, leaseDigest: digestObject(stable) };
  await atomicWriteJson(stateRoot, target, next);
  return next;
}

async function readLeaseAt(stateRoot, target) {
  const lease = await readJson(stateRoot, target);
  const stable = { ...lease };
  delete stable.leaseDigest;
  if (lease.schemaVersion !== 1 || lease.kind !== "TaskWorkspaceLeaseV1" || digestObject(stable) !== lease.leaseDigest) {
    throw new Error("Task workspace lease identity or digest is invalid");
  }
  if (!TASK_ID.test(lease.taskId) || !LIFECYCLE.has(lease.lifecycleState)) {
    throw new Error("Task workspace lease task or lifecycle is invalid");
  }
  if (lease.blockedState !== null && !BLOCKED.has(lease.blockedState)) {
    throw new Error("Task workspace lease blocked state is invalid");
  }
  if (lease.directRoute !== undefined && lease.directRoute !== null) validateDirectRouteBinding(lease.directRoute);
  return lease;
}

export async function readWorkspaceLease({ stateRoot, repositoryId, taskId }) {
  return readLeaseAt(stateRoot, leasePath(stateRoot, repositoryId, normalizeTaskId(taskId)));
}

async function leaseRecordNames(stateRoot, repositoryId) {
  const directory = leaseDirectory(stateRoot, repositoryId);
  if (!(await exists(directory))) return [];
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  if (names.length > MAX_WORKSPACE_LEASE_RECORDS) {
    throw new Error(`Workspace lease registry exceeds the safe scan limit of ${MAX_WORKSPACE_LEASE_RECORDS}`);
  }
  return names;
}

async function findLeaseByWorktree(stateRoot, repositoryId, targetPath) {
  const directory = leaseDirectory(stateRoot, repositoryId);
  const names = await leaseRecordNames(stateRoot, repositoryId);
  const canonicalTarget = await realpath(targetPath).catch(() => path.resolve(targetPath));
  for (const name of names) {
    const target = safeJoin(directory, name);
    const lease = await readLeaseAt(stateRoot, target);
    const leaseWorktree = await realpath(lease.taskWorktree).catch(() => path.resolve(lease.taskWorktree));
    if (leaseWorktree === canonicalTarget && lease.lifecycleState !== "cleaned") return lease;
  }
  return null;
}

async function findLeaseByTaskBranch(stateRoot, repositoryId, taskBranch) {
  const directory = leaseDirectory(stateRoot, repositoryId);
  const names = await leaseRecordNames(stateRoot, repositoryId);
  for (const name of names) {
    const lease = await readLeaseAt(stateRoot, safeJoin(directory, name));
    if (lease.taskBranch === taskBranch && lease.lifecycleState !== "cleaned") return lease;
  }
  return null;
}

async function branchSuggestions(cwd, baseRevision, profileTarget = null) {
  const suggestions = [];
  const add = async (branch, reason) => {
    if (!branch || !BRANCH.test(branch) || suggestions.some((item) => item.branch === branch)) return;
    if (!(await resolveLocalBranch(cwd, branch))) return;
    suggestions.push({ branch, reason });
  };
  await add(profileTarget, "repository-profile");
  await add("dev", "feature-development-convention");
  const upstream = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allowFailure: true });
  if (upstream.ok) {
    const value = oneLine(upstream.stdout, "Upstream branch");
    await add(value.startsWith("origin/") ? value.slice("origin/".length) : value, "current-upstream");
  }
  const originHead = await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { allowFailure: true });
  if (originHead.ok) {
    const value = oneLine(originHead.stdout, "origin/HEAD branch");
    await add(value.startsWith("origin/") ? value.slice("origin/".length) : value, "origin-head");
  }
  const containing = await git(cwd, ["for-each-ref", "--contains", baseRevision, "--format=%(refname:short)", "refs/heads"]);
  for (const branch of containing.stdout.split("\n").filter(Boolean).sort()) await add(branch, "contains-base-revision");
  return suggestions.slice(0, 3);
}

function preflightResult(base, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "WorkspacePreflightV1",
    checkedAt: nowIso(),
    ...base,
    ...overrides
  };
}

export async function workspacePreflight({
  cwd = process.cwd(),
  stateRoot,
  intent = "read-only",
  taskId = null,
  integrationTarget = null,
  profileTarget = null
} = {}) {
  if (!["read-only", "modify"].includes(intent)) throw new Error("Workspace intent must be read-only or modify");
  if (!stateRoot) throw new Error("Workspace preflight requires a state root");
  const resolvedCwd = await realpath(path.resolve(cwd));
  const repository = await repositoryInfo(resolvedCwd);
  if (!repository) {
    return preflightResult({
      ok: true,
      status: "not-a-git-repository",
      intent,
      repository: null,
      sourceBranch: null,
      baseRevision: null,
      integrationTarget: null,
      workspaceLifecycle: "not-applicable",
      blockers: [],
      suggestions: [],
      reuseLease: null
    });
  }
  const requestedTaskId = taskId ? normalizeTaskId(taskId) : null;
  const owned = await findLeaseByWorktree(stateRoot, repository.repositoryId, repository.topLevel);
  if (owned) {
    if (!requestedTaskId || owned.taskId !== requestedTaskId) {
      return preflightResult({
        ok: false,
        status: "ownership-conflict",
        intent,
        repository,
        sourceBranch: await currentBranch(resolvedCwd),
        baseRevision: await headRevision(resolvedCwd),
        integrationTarget: null,
        workspaceLifecycle: "isolated-worktree",
        blockers: ["ownership-conflict"],
        suggestions: [],
        reuseLease: null,
        ownerTaskId: owned.taskId
      });
    }
    return preflightResult({
      ok: true,
      status: "task-worktree-reused",
      intent,
      repository,
      sourceBranch: owned.sourceBranch,
      baseRevision: owned.baseRevision,
      integrationTarget: owned.integrationTarget,
      workspaceLifecycle: owned.protectedTarget ? "governed-pr" : "isolated-worktree",
      blockers: [],
      suggestions: [],
      reuseLease: owned
    });
  }
  const sourceBranch = await currentBranch(resolvedCwd);
  const baseRevision = await headRevision(resolvedCwd);
  if (intent === "read-only") {
    return preflightResult({
      ok: true,
      status: "read-only",
      intent,
      repository,
      sourceBranch,
      baseRevision,
      integrationTarget: integrationTarget ?? sourceBranch,
      workspaceLifecycle: "read-only",
      blockers: [],
      suggestions: [],
      reuseLease: null
    });
  }
  const sourceState = await worktreeState(resolvedCwd);
  if (!sourceState.clean) {
    return preflightResult({
      ok: false,
      status: "dirty-source",
      intent,
      repository,
      sourceBranch,
      baseRevision,
      integrationTarget: integrationTarget ?? sourceBranch,
      workspaceLifecycle: "isolated-worktree",
      blockers: ["dirty-source"],
      suggestions: [],
      reuseLease: null,
      sourceState
    });
  }
  const target = integrationTarget === null ? sourceBranch : String(integrationTarget);
  const suggestions = await branchSuggestions(resolvedCwd, baseRevision, profileTarget);
  if (target === null) {
    return preflightResult({
      ok: false,
      status: "target-missing",
      intent,
      repository,
      sourceBranch,
      baseRevision,
      integrationTarget: null,
      workspaceLifecycle: "isolated-worktree",
      blockers: ["target-missing"],
      suggestions,
      reuseLease: null
    });
  }
  if (!BRANCH.test(target) || target.startsWith("refs/remotes/") || target.startsWith("origin/")) {
    return preflightResult({
      ok: false,
      status: "target-missing",
      intent,
      repository,
      sourceBranch,
      baseRevision,
      integrationTarget: target,
      workspaceLifecycle: "governed-pr",
      blockers: ["integration-target-must-be-an-existing-local-branch"],
      suggestions,
      reuseLease: null
    });
  }
  const targetRevision = await resolveLocalBranch(resolvedCwd, target);
  if (!targetRevision) {
    return preflightResult({
      ok: false,
      status: "target-missing",
      intent,
      repository,
      sourceBranch,
      baseRevision,
      integrationTarget: target,
      workspaceLifecycle: "isolated-worktree",
      blockers: ["target-missing"],
      suggestions,
      reuseLease: null
    });
  }
  const policy = await loadTaskWorktreePolicy();
  const protectedTarget = isProtectedBranch(target, policy.protectedBranchPatterns);
  return preflightResult({
    ok: true,
    status: "ready",
    intent,
    repository,
    sourceBranch,
    baseRevision,
    integrationTarget: target,
    integrationTargetRevision: targetRevision,
    protectedTarget,
    workspaceLifecycle: protectedTarget ? "governed-pr" : "isolated-worktree",
    blockers: [],
    suggestions,
    reuseLease: null,
    sourceState
  });
}

function workspaceLockRecord(repositoryId, processIncarnation) {
  const payload = {
    schemaVersion: WORKSPACE_LOCK_SCHEMA_VERSION,
    repositoryId,
    token: randomBytes(24).toString("hex"),
    pid: process.pid,
    host: os.hostname(),
    processIncarnation,
    createdAt: nowIso()
  };
  return { ...payload, lockDigest: digestObject(payload) };
}

async function readWorkspaceLockRecord(stateRoot, target) {
  const record = await readJson(stateRoot, target);
  exactKeys(record, [
    "schemaVersion",
    "repositoryId",
    "token",
    "pid",
    "host",
    "processIncarnation",
    "createdAt",
    "lockDigest"
  ], "Repository workspace lock");
  const payload = { ...record };
  delete payload.lockDigest;
  if (
    record.schemaVersion !== WORKSPACE_LOCK_SCHEMA_VERSION ||
    !REPOSITORY_ID.test(record.repositoryId) ||
    !/^[a-f0-9]{48}$/.test(record.token) ||
    !Number.isInteger(record.pid) || record.pid < 1 ||
    typeof record.host !== "string" || !record.host ||
    !(record.processIncarnation === "unknown" || /^[a-f0-9]{64}$/.test(record.processIncarnation)) ||
    Number.isNaN(Date.parse(record.createdAt)) ||
    !/^[a-f0-9]{64}$/.test(record.lockDigest) ||
    digestObject(payload) !== record.lockDigest
  ) {
    throw new Error("Repository workspace lock identity or digest is invalid");
  }
  return record;
}

async function quarantineStaleWorkspaceLock(stateRoot, directory, target, expected) {
  const quarantine = safeJoin(directory, `${expected.repositoryId}.stale.${randomUUID()}`);
  try {
    await rename(target, quarantine);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const moved = await readWorkspaceLockRecord(stateRoot, quarantine);
  if (moved.lockDigest !== expected.lockDigest || moved.token !== expected.token) {
    try {
      await link(quarantine, target);
      const restored = await readWorkspaceLockRecord(stateRoot, target);
      if (restored.lockDigest !== moved.lockDigest || restored.token !== moved.token) {
        throw new Error("Restored repository workspace lock identity changed");
      }
      await unlink(quarantine);
    } catch (error) {
      throw new Error(`Repository workspace lock changed during stale reconciliation and was preserved at ${quarantine}: ${error.message}`);
    }
    throw new Error("Repository workspace lock changed during stale reconciliation and was restored");
  }
  await unlink(quarantine);
  return true;
}

async function releaseWorkspaceLock(stateRoot, directory, target, expected) {
  const release = safeJoin(directory, `${expected.repositoryId}.release.${randomUUID()}`);
  try {
    await rename(target, release);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Repository workspace lock vanished before release");
    throw error;
  }
  const moved = await readWorkspaceLockRecord(stateRoot, release);
  if (moved.lockDigest !== expected.lockDigest || moved.token !== expected.token) {
    try {
      await link(release, target);
      const restored = await readWorkspaceLockRecord(stateRoot, target);
      if (restored.lockDigest !== moved.lockDigest || restored.token !== moved.token) {
        throw new Error("Restored repository workspace lock identity changed");
      }
      await unlink(release);
    } catch (error) {
      throw new Error(`Repository workspace lock ownership changed before release and was preserved at ${release}: ${error.message}`);
    }
    throw new Error("Repository workspace lock ownership changed before release and was restored");
  }
  await unlink(release);
}

async function removeFailedWorkspaceLockWrite(target, handle) {
  if (!handle) return;
  const opened = await handle.stat().catch(() => null);
  const observed = await lstat(target).catch(() => null);
  if (opened && observed && opened.dev === observed.dev && opened.ino === observed.ino) {
    await unlink(target);
  }
}

async function withRepositoryLock(stateRoot, repositoryId, callback) {
  const directory = safeJoin(stateRoot, "workspace-locks");
  await ensurePrivateDir(directory);
  const target = safeJoin(directory, `${repositoryId}.lock`);
  const incarnation = await processIncarnationDigest(process.pid);
  const record = workspaceLockRecord(
    repositoryId,
    /^[a-f0-9]{64}$/.test(incarnation ?? "") ? incarnation : "unknown"
  );
  let acquired = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let handle;
    try {
      handle = await open(target, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        await removeFailedWorkspaceLockWrite(target, handle);
        throw error;
      }
      const existing = await readWorkspaceLockRecord(stateRoot, target);
      if (existing.repositoryId !== repositoryId || existing.host !== os.hostname()) {
        throw new Error("Repository workspace lock belongs to another repository or host");
      }
      if (existing.processIncarnation === "unknown") {
        throw new Error(`Repository workspace lock held by unverifiable pid ${existing.pid}`);
      }
      const observed = await processIncarnationDigest(existing.pid);
      if (observed === "unknown") {
        throw new Error(`Repository workspace lock owner pid ${existing.pid} cannot be verified`);
      }
      if (observed === existing.processIncarnation) {
        throw new Error(`Repository workspace lock is held by live pid ${existing.pid}`);
      }
      await quarantineStaleWorkspaceLock(stateRoot, directory, target, existing);
    } finally {
      await handle?.close();
    }
  }
  if (!acquired) throw new Error("Unable to acquire repository workspace lock after stale-owner reconciliation");
  try {
    return await callback();
  } finally {
    await releaseWorkspaceLock(stateRoot, directory, target, record);
  }
}

function baseLease({ taskId, goal, preflight, stateRoot }) {
  const policyDigest = null;
  const shortTaskId = taskId.replace(/^task-/, "").slice(-8);
  const taskBranch = `codex/${goalSlug(goal)}-${shortTaskId}`;
  const taskWorktree = safeJoin(stateRoot, "worktrees", preflight.repository.repositoryId, taskId);
  return {
    schemaVersion: 1,
    kind: "TaskWorkspaceLeaseV1",
    policyId: "task-worktree-v1",
    policyDigest,
    taskId,
    repository: preflight.repository,
    sourceCheckout: preflight.repository.topLevel,
    sourceBranch: preflight.sourceBranch,
    integrationTarget: preflight.integrationTarget,
    baseRevision: preflight.baseRevision,
    targetRevisionAtBind: preflight.integrationTargetRevision,
    protectedTarget: preflight.protectedTarget === true,
    resourceOrigin: "better-workflows",
    registration: null,
    taskBranch,
    taskWorktree,
    ownershipNonce: randomBytes(16).toString("hex"),
    lifecycleState: "planned",
    blockedState: null,
    createdAt: nowIso(),
    updatedAt: null,
    resources: {
      taskBranch: { ref: branchRef(taskBranch), createdAtRevision: null, currentRevision: null },
      taskWorktree: { path: taskWorktree, head: null },
      integrationBranch: null,
      integrationWorktree: null
    },
    targetRebindings: [],
    directRoute: null,
    validation: null,
    integration: null,
    cleanup: null,
    leaseDigest: null
  };
}

export async function workspaceRegister({
  cwd = process.cwd(),
  stateRoot,
  taskId,
  baseRevision,
  integrationTarget,
  sourceCheckout = null,
  sourceBranch = null
} = {}) {
  if (!stateRoot) throw new Error("Workspace registration requires a state root");
  const normalizedTaskId = normalizeTaskId(taskId);
  const base = String(baseRevision ?? "").toLowerCase();
  const targetBranch = String(integrationTarget ?? "");
  const originalBranch = String(sourceBranch ?? targetBranch);
  if (!SHA1.test(base)) throw new Error("Workspace registration requires an exact 40-character base revision");
  if (!BRANCH.test(targetBranch) || targetBranch.startsWith("origin/") || targetBranch.startsWith("refs/remotes/")) {
    throw new Error("Workspace registration requires an existing local integration target");
  }
  if (!BRANCH.test(originalBranch) || originalBranch.startsWith("origin/") || originalBranch.startsWith("refs/remotes/")) {
    throw new Error("Workspace registration requires an existing local source branch");
  }

  const requestedTaskPath = await realpath(path.resolve(cwd));
  const taskRepository = await repositoryInfo(requestedTaskPath);
  if (!taskRepository) throw new Error("Workspace registration requires a Git worktree");
  const taskPath = taskRepository.topLevel;
  const policy = await loadTaskWorktreePolicy();
  const taskBranch = await currentBranch(taskPath);
  const taskHead = await headRevision(taskPath);
  const taskState = await worktreeState(taskPath);
  if (!taskState.clean) throw new Error("Host-provided task worktree must be clean before registration");
  if (!taskBranch || !taskBranch.startsWith(policy.taskBranchPrefix) || taskBranch === targetBranch) {
    throw new Error(`Host-provided task branch must be a distinct ${policy.taskBranchPrefix} branch`);
  }
  if (taskHead !== base) {
    throw new Error("Host-provided task worktree must still be at the exact pre-mutation base revision");
  }

  const records = await worktreeList(taskPath);
  let taskRecord = null;
  for (const record of records) {
    const candidate = await realpath(record.path).catch(() => path.resolve(record.path));
    if (candidate === taskPath) {
      taskRecord = record;
      break;
    }
  }
  if (!taskRecord || taskRecord.bare || taskRecord.detached || taskRecord.prunable !== null ||
      taskRecord.branch !== branchRef(taskBranch) || taskRecord.head !== taskHead) {
    throw new Error("Host-provided task worktree does not match Git's exact worktree record");
  }

  let sourcePath;
  if (sourceCheckout !== null) {
    sourcePath = await realpath(path.resolve(String(sourceCheckout)));
  } else {
    let targetRecord = null;
    let fallback = null;
    for (const record of records) {
      const candidate = await realpath(record.path).catch(() => path.resolve(record.path));
      if (candidate === taskPath) continue;
      if (!fallback && !record.bare && !record.detached) fallback = record;
      if (record.branch === branchRef(targetBranch)) {
        targetRecord = record;
        break;
      }
    }
    const selected = targetRecord ?? fallback;
    if (!selected) {
      throw new Error("Workspace registration cannot infer a separate source checkout; provide --source-checkout");
    }
    sourcePath = await realpath(selected.path);
  }
  const sourceRepository = await repositoryInfo(sourcePath);
  if (!sourceRepository || sourceRepository.repositoryDigest !== taskRepository.repositoryDigest) {
    throw new Error("Workspace registration source checkout belongs to a different repository");
  }
  sourcePath = sourceRepository.topLevel;
  if (sourcePath === taskPath) throw new Error("Workspace registration source checkout must be separate from the task worktree");
  const sourceState = await worktreeState(sourcePath);
  if (!sourceState.clean) throw new Error("Workspace registration source checkout must be clean");
  const targetRevision = await resolveLocalBranch(sourcePath, targetBranch);
  const sourceRevision = await resolveLocalBranch(sourcePath, originalBranch);
  if (!targetRevision || !sourceRevision) throw new Error("Workspace registration source or integration branch is missing");
  const baseObject = await git(sourcePath, ["rev-parse", "--verify", `${base}^{commit}`], { allowFailure: true });
  if (!baseObject.ok || oneLine(baseObject.stdout, "Registration base revision", SHA1).toLowerCase() !== base) {
    throw new Error("Workspace registration base revision is unavailable");
  }
  if (!(await isAncestor(sourcePath, base, targetRevision))) {
    throw new Error("Workspace registration target no longer contains the task base revision");
  }
  if (!(await isAncestor(sourcePath, base, sourceRevision))) {
    throw new Error("Workspace registration source branch no longer contains the task base revision");
  }

  const existingByPath = await findLeaseByWorktree(stateRoot, sourceRepository.repositoryId, taskPath);
  if (existingByPath) {
    if (
      existingByPath.taskId === normalizedTaskId &&
      existingByPath.resourceOrigin === "host-provided" &&
      existingByPath.registration?.receiptDigest === digestObject(
        Object.fromEntries(Object.entries(existingByPath.registration).filter(([key]) => key !== "receiptDigest"))
      ) &&
      existingByPath.sourceCheckout === sourcePath &&
      existingByPath.sourceBranch === originalBranch &&
      existingByPath.integrationTarget === targetBranch &&
      existingByPath.baseRevision === base &&
      existingByPath.taskBranch === taskBranch &&
      existingByPath.taskWorktree === taskPath
    ) {
      return { ok: true, status: "reused", lease: existingByPath };
    }
    return { ok: false, status: "ownership-conflict", lease: existingByPath };
  }
  const sourceOwner = await findLeaseByWorktree(stateRoot, sourceRepository.repositoryId, sourcePath);
  if (sourceOwner && sourceOwner.taskId !== normalizedTaskId) {
    return { ok: false, status: "ownership-conflict", lease: sourceOwner };
  }
  const target = leasePath(stateRoot, sourceRepository.repositoryId, normalizedTaskId);
  if (await exists(target)) {
    return { ok: false, status: "ownership-conflict", lease: await readLeaseAt(stateRoot, target) };
  }
  const existingByBranch = await findLeaseByTaskBranch(stateRoot, sourceRepository.repositoryId, taskBranch);
  if (existingByBranch) return { ok: false, status: "ownership-conflict", lease: existingByBranch };

  return withRepositoryLock(stateRoot, sourceRepository.repositoryId, async () => {
    if (await exists(target)) {
      return { ok: false, status: "ownership-conflict", lease: await readLeaseAt(stateRoot, target) };
    }
    const lockedPathOwner = await findLeaseByWorktree(stateRoot, sourceRepository.repositoryId, taskPath);
    const lockedBranchOwner = await findLeaseByTaskBranch(stateRoot, sourceRepository.repositoryId, taskBranch);
    const lockedSourceOwner = await findLeaseByWorktree(stateRoot, sourceRepository.repositoryId, sourcePath);
    if (lockedPathOwner || lockedBranchOwner || (lockedSourceOwner && lockedSourceOwner.taskId !== normalizedTaskId)) {
      return { ok: false, status: "ownership-conflict", lease: lockedPathOwner ?? lockedBranchOwner ?? lockedSourceOwner };
    }
    const lockedTaskRepository = await repositoryInfo(taskPath);
    const lockedSourceRepository = await repositoryInfo(sourcePath);
    const lockedTaskState = await worktreeState(taskPath);
    const lockedSourceState = await worktreeState(sourcePath);
    const lockedTaskBranch = await currentBranch(taskPath);
    const lockedTaskHead = await headRevision(taskPath);
    const lockedTargetRevision = await resolveLocalBranch(sourcePath, targetBranch);
    const lockedSourceRevision = await resolveLocalBranch(sourcePath, originalBranch);
    const lockedRecords = await worktreeList(sourcePath);
    let lockedTaskRecord = null;
    for (const record of lockedRecords) {
      const candidate = await realpath(record.path).catch(() => path.resolve(record.path));
      if (candidate === taskPath) {
        lockedTaskRecord = record;
        break;
      }
    }
    if (
      !lockedTaskRepository ||
      !lockedSourceRepository ||
      lockedTaskRepository.repositoryDigest !== sourceRepository.repositoryDigest ||
      lockedSourceRepository.repositoryDigest !== sourceRepository.repositoryDigest ||
      !lockedTaskState.clean ||
      !lockedSourceState.clean ||
      lockedTaskBranch !== taskBranch ||
      lockedTaskHead !== base ||
      !lockedTargetRevision ||
      !lockedSourceRevision ||
      !lockedTaskRecord ||
      lockedTaskRecord.bare ||
      lockedTaskRecord.detached ||
      lockedTaskRecord.prunable !== null ||
      lockedTaskRecord.branch !== branchRef(taskBranch) ||
      lockedTaskRecord.head !== base ||
      !(await isAncestor(sourcePath, base, lockedTargetRevision)) ||
      !(await isAncestor(sourcePath, base, lockedSourceRevision))
    ) {
      throw new Error("Host-provided workspace changed while registration was being bound");
    }
    const preflight = {
      repository: sourceRepository,
      sourceBranch: originalBranch,
      integrationTarget: targetBranch,
      baseRevision: base,
      integrationTargetRevision: lockedTargetRevision,
      protectedTarget: isProtectedBranch(targetBranch, policy.protectedBranchPatterns)
    };
    const initial = baseLease({ taskId: normalizedTaskId, goal: taskBranch, preflight, stateRoot });
    const registrationPayload = {
      schemaVersion: 1,
      kind: "HostWorkspaceRegistrationV1",
      taskId: normalizedTaskId,
      repositoryDigest: sourceRepository.repositoryDigest,
      sourceCheckout: sourcePath,
      sourceBranch: originalBranch,
      integrationTarget: targetBranch,
      baseRevision: base,
      taskBranch,
      taskWorktree: taskPath,
      taskHead,
      resourceDisposition: "preserve-host-provided",
      registeredAt: nowIso()
    };
    const registration = { ...registrationPayload, receiptDigest: digestObject(registrationPayload) };
    const lease = await writeLease(stateRoot, target, {
      ...initial,
      policyDigest: digestObject(policy),
      sourceCheckout: sourcePath,
      sourceBranch: originalBranch,
      integrationTarget: targetBranch,
      baseRevision: base,
      targetRevisionAtBind: lockedTargetRevision,
      protectedTarget: preflight.protectedTarget,
      resourceOrigin: "host-provided",
      registration,
      taskBranch,
      taskWorktree: taskPath,
      lifecycleState: "isolated",
      resources: {
        taskBranch: { ref: branchRef(taskBranch), createdAtRevision: base, currentRevision: taskHead },
        taskWorktree: { path: taskPath, head: taskHead },
        integrationBranch: null,
        integrationWorktree: null
      }
    });
    return { ok: true, status: "registered", lease, registration };
  });
}

export async function workspaceRebindTarget({
  stateRoot,
  repositoryId,
  taskId,
  integrationTarget
}) {
  const target = leasePath(stateRoot, repositoryId, normalizeTaskId(taskId));
  let lease = await readLeaseAt(stateRoot, target);
  if (["integrated", "cleanup-ready", "cleaned"].includes(lease.lifecycleState)) {
    throw new Error(`Workspace target cannot be rebound from ${lease.lifecycleState}`);
  }
  if (lease.directRoute !== undefined && lease.directRoute !== null) {
    throw new Error("A started Direct route cannot change integration target; reassess and continue through a governed evidence route");
  }
  const branch = String(integrationTarget ?? "");
  if (!BRANCH.test(branch) || branch.startsWith("origin/") || branch.startsWith("refs/remotes/")) {
    throw new Error("Workspace integration target must be an existing local branch");
  }
  const revision = await resolveLocalBranch(lease.sourceCheckout, branch);
  if (!revision) throw new Error("Workspace integration target does not exist");
  const policy = await loadTaskWorktreePolicy();
  const previous = {
    integrationTarget: lease.integrationTarget,
    targetRevisionAtBind: lease.targetRevisionAtBind,
    reboundAt: nowIso()
  };
  lease = await writeLease(stateRoot, target, {
    ...lease,
    integrationTarget: branch,
    targetRevisionAtBind: revision,
    protectedTarget: isProtectedBranch(branch, policy.protectedBranchPatterns),
    blockedState: null,
    blockDetails: null,
    targetRebindings: [...(lease.targetRebindings ?? []), previous]
  });
  return { ok: true, status: "target-bound", lease };
}

async function assertDirectWorkspaceStartState(lease, expectedBinding) {
  const sourceState = await worktreeState(lease.sourceCheckout);
  const sourceHead = await headRevision(lease.sourceCheckout);
  const sourceBranch = await currentBranch(lease.sourceCheckout);
  const targetHead = await resolveLocalBranch(lease.sourceCheckout, lease.integrationTarget);
  const taskState = await worktreeState(lease.taskWorktree);
  const taskHead = await headRevision(lease.taskWorktree);
  const taskBranch = await currentBranch(lease.taskWorktree);
  const taskRecord = await worktreeRecordAtPath(lease.sourceCheckout, lease.taskWorktree);
  if (!sourceState.clean || sourceHead !== expectedBinding.sourceRevision || sourceBranch !== lease.sourceBranch ||
      targetHead !== expectedBinding.integrationTargetRevision || !taskState.clean || taskHead !== lease.baseRevision ||
      taskBranch !== lease.taskBranch || !taskRecord || taskRecord.head !== taskHead ||
      taskRecord.branch !== branchRef(lease.taskBranch)) {
    throw new Error("Direct workspace or source checkout drifted before route activation");
  }
}

export async function workspaceBeginDirect({
  stateRoot,
  repositoryId,
  taskId,
  routeReceiptId,
  assessmentDigest,
  sourceRevision,
  integrationTarget,
  integrationTargetRevision,
  basicCheckPlan
}) {
  if (!ROUTE_RECEIPT_ID.test(String(routeReceiptId))) throw new Error("Direct workspace start requires an exact route receipt id");
  if (!/^[a-f0-9]{64}$/.test(String(assessmentDigest))) throw new Error("Direct workspace start requires an exact assessment digest");
  if (!SHA1.test(String(sourceRevision)) || !SHA1.test(String(integrationTargetRevision))) {
    throw new Error("Direct workspace start requires exact source and integration target revisions");
  }
  const branch = String(integrationTarget ?? "");
  if (!BRANCH.test(branch) || branch.startsWith("origin/") || branch.startsWith("refs/remotes/") || isProtectedBranch(branch)) {
    throw new Error("Direct workspace start requires a non-protected local integration target");
  }
  if (!Array.isArray(basicCheckPlan) || basicCheckPlan.length < 1 || basicCheckPlan.length > 16 ||
      basicCheckPlan.some((check) => typeof check !== "string" || !check.trim() || check.length > 160 || /[\r\n]/.test(check)) ||
      new Set(basicCheckPlan.map((check) => check.trim())).size !== basicCheckPlan.length) {
    throw new Error("Direct workspace start requires 1-16 unique one-line basic check names");
  }
  const normalizedTaskId = normalizeTaskId(taskId);
  const target = leasePath(stateRoot, repositoryId, normalizedTaskId);
  const expectedBinding = {
    routeReceiptId: String(routeReceiptId),
    assessmentDigest: String(assessmentDigest),
    sourceRevision: String(sourceRevision).toLowerCase(),
    integrationTarget: branch,
    integrationTargetRevision: String(integrationTargetRevision).toLowerCase(),
    basicCheckPlan: basicCheckPlan.map((check) => check.trim())
  };
  return withRepositoryLock(stateRoot, repositoryId, async () => {
    let lease = await readLeaseAt(stateRoot, target);
    if (lease.lifecycleState === "working" && lease.directRoute) {
      const observed = {
        routeReceiptId: lease.directRoute.routeReceiptId,
        assessmentDigest: lease.directRoute.assessmentDigest,
        sourceRevision: lease.directRoute.sourceRevision,
        integrationTarget: lease.directRoute.integrationTarget,
        integrationTargetRevision: lease.directRoute.integrationTargetRevision,
        basicCheckPlan: lease.directRoute.basicCheckPlan
      };
      if (digestObject(observed) !== digestObject(expectedBinding)) {
        throw new Error("Direct workspace is already bound to a different route receipt or assessment");
      }
      await assertDirectWorkspaceStartState(lease, expectedBinding);
      return { ok: true, status: "working", lease, resumed: true };
    }
    if (lease.lifecycleState !== "isolated" || lease.blockedState !== null || (lease.directRoute !== undefined && lease.directRoute !== null)) {
      throw new Error("Direct workspace can start only from an unblocked isolated lease");
    }
    if (
      lease.sourceCheckout === lease.taskWorktree ||
      lease.baseRevision !== expectedBinding.sourceRevision ||
      lease.integrationTarget !== expectedBinding.integrationTarget ||
      lease.targetRevisionAtBind !== expectedBinding.integrationTargetRevision ||
      lease.protectedTarget
    ) {
      throw new Error("Direct workspace lease does not match the source-bound route assessment");
    }
    await assertDirectWorkspaceStartState(lease, expectedBinding);
    const directRoutePayload = {
      schemaVersion: 1,
      kind: "DirectWorkspaceRouteBindingV1",
      ...expectedBinding,
      boundAt: nowIso()
    };
    const directRoute = { ...directRoutePayload, bindingDigest: digestObject(directRoutePayload) };
    lease = await writeLease(stateRoot, target, {
      ...lease,
      lifecycleState: "working",
      directRoute
    });
    return { ok: true, status: "working", lease, resumed: false };
  });
}

async function setBlocked(stateRoot, target, lease, blockedState, details = null) {
  return writeLease(stateRoot, target, {
    ...lease,
    blockedState,
    blockDetails: details,
    lifecycleState: lease.lifecycleState
  });
}

export async function workspaceCreate({
  cwd = process.cwd(),
  stateRoot,
  goal,
  taskId = null,
  integrationTarget = null,
  profileTarget = null
} = {}) {
  if (!goal || !String(goal).trim()) throw new Error("workspace create requires a goal");
  const requestedTaskId = normalizeTaskId(taskId);
  let normalizedTaskId = requestedTaskId;
  let preflight = await workspacePreflight({
    cwd,
    stateRoot,
    intent: "modify",
    taskId: normalizedTaskId,
    integrationTarget,
    profileTarget
  });
  if (preflight.status === "task-worktree-reused") {
    return { ok: true, status: "reused", lease: preflight.reuseLease, preflight };
  }
  if (preflight.status === "not-a-git-repository") {
    return { ok: true, status: "not-a-git-repository", lease: null, preflight };
  }
  if (!preflight.ok) return { ok: false, status: preflight.status, lease: null, preflight };
  const repositoryId = preflight.repository.repositoryId;
  return withRepositoryLock(stateRoot, repositoryId, async () => {
    preflight = await workspacePreflight({
      cwd,
      stateRoot,
      intent: "modify",
      taskId: normalizedTaskId,
      integrationTarget,
      profileTarget
    });
    if (preflight.status === "task-worktree-reused") {
      return { ok: true, status: "reused", lease: preflight.reuseLease, preflight };
    }
    if (!preflight.ok || preflight.repository?.repositoryId !== repositoryId) {
      return { ok: false, status: preflight.status ?? "ownership-conflict", lease: null, preflight };
    }
    const policy = await loadTaskWorktreePolicy();
    let target = leasePath(stateRoot, repositoryId, normalizedTaskId);
    let resumed = false;
    let lease;
    if (await exists(target)) {
      lease = await readLeaseAt(stateRoot, target);
      if (lease.lifecycleState === "cleaned") {
        throw new Error("Task id was already used by a cleaned lease; generate a new task id");
      }
      if (
        lease.repository.repositoryDigest !== preflight.repository.repositoryDigest ||
        lease.sourceCheckout !== preflight.repository.topLevel ||
        lease.sourceBranch !== preflight.sourceBranch ||
        lease.integrationTarget !== preflight.integrationTarget ||
        lease.policyDigest !== digestObject(policy)
      ) {
        return { ok: false, status: "ownership-conflict", lease, preflight };
      }
      if (lease.blockedState !== null) {
        return { ok: false, status: lease.blockedState, lease, preflight };
      }
      resumed = true;
    } else {
      for (let collisionAttempt = 0; collisionAttempt < 8; collisionAttempt += 1) {
        const candidate = baseLease({ taskId: normalizedTaskId, goal, preflight, stateRoot });
        const branchOwner = await findLeaseByTaskBranch(stateRoot, repositoryId, candidate.taskBranch);
        const branchRevision = await resolveLocalBranch(cwd, candidate.taskBranch);
        const pathExists = await exists(candidate.taskWorktree);
        if (!(await exists(target)) && !branchOwner && branchRevision === null && !pathExists) {
          lease = candidate;
          lease.policyDigest = digestObject(policy);
          lease = await writeLease(stateRoot, target, lease);
          break;
        }
        normalizedTaskId = normalizeTaskId();
        target = leasePath(stateRoot, repositoryId, normalizedTaskId);
      }
      if (!lease) throw new Error("Unable to allocate a unique task branch and worktree after 8 attempts");
    }
    if (["isolated", "working", "validated", "integration-ready"].includes(lease.lifecycleState)) {
      const canonicalTaskWorktree = await realpath(lease.taskWorktree).catch(() => null);
      const branchRevision = await resolveLocalBranch(cwd, lease.taskBranch);
      const records = await worktreeList(cwd);
      const record = canonicalTaskWorktree
        ? records.find((candidate) => path.resolve(candidate.path) === canonicalTaskWorktree)
        : null;
      if (
        !record ||
        record.branch !== branchRef(lease.taskBranch) ||
        branchRevision === null ||
        record.head !== branchRevision
      ) {
        lease = await setBlocked(stateRoot, target, lease, "ownership-conflict", "recorded task worktree no longer matches its branch");
        return { ok: false, status: "ownership-conflict", lease, preflight };
      }
      return { ok: true, status: "reused", lease, preflight, resumed: true };
    }
    if (!["planned", "target-bound"].includes(lease.lifecycleState)) {
      return { ok: false, status: "ownership-conflict", lease, preflight };
    }
    const branchExisting = await resolveLocalBranch(cwd, lease.taskBranch);
    if (lease.lifecycleState === "planned" && (branchExisting || await exists(lease.taskWorktree))) {
      lease = await setBlocked(stateRoot, target, lease, "ownership-conflict", "task branch or worktree path already exists");
      return { ok: false, status: "ownership-conflict", lease, preflight };
    }
    if (lease.lifecycleState === "planned") {
      lease = await writeLease(stateRoot, target, { ...lease, lifecycleState: "target-bound" });
    }
    if (branchExisting !== null && branchExisting !== lease.baseRevision) {
      lease = await setBlocked(stateRoot, target, lease, "ownership-conflict", "task branch exists at an unexpected revision");
      return { ok: false, status: "ownership-conflict", lease, preflight };
    }
    if (branchExisting === null) {
      await git(cwd, ["branch", "--no-track", lease.taskBranch, lease.baseRevision]);
    }
    lease = await writeLease(stateRoot, target, {
      ...lease,
      resources: {
        ...lease.resources,
        taskBranch: {
          ...lease.resources.taskBranch,
          createdAtRevision: lease.baseRevision,
          currentRevision: lease.baseRevision
        }
      }
    });
    try {
      await ensurePrivateDir(path.dirname(lease.taskWorktree));
      if (!(await exists(lease.taskWorktree))) {
        await git(cwd, ["worktree", "add", lease.taskWorktree, lease.taskBranch]);
      }
    } catch (error) {
      const current = await resolveLocalBranch(cwd, lease.taskBranch);
      if (current === lease.baseRevision && !(await exists(lease.taskWorktree))) {
        await git(cwd, ["update-ref", "-d", branchRef(lease.taskBranch), lease.baseRevision]);
      }
      lease = await setBlocked(stateRoot, target, lease, "ownership-conflict", error.message);
      return { ok: false, status: "ownership-conflict", lease, preflight };
    }
    const canonicalTaskWorktree = await realpath(lease.taskWorktree);
    const records = await worktreeList(cwd);
    let record = null;
    for (const candidate of records) {
      const canonicalCandidate = await realpath(candidate.path).catch(() => path.resolve(candidate.path));
      if (canonicalCandidate === canonicalTaskWorktree) {
        record = candidate;
        break;
      }
    }
    const branchRevision = await resolveLocalBranch(cwd, lease.taskBranch);
    if (!record || record.branch !== branchRef(lease.taskBranch) || record.head !== lease.baseRevision || branchRevision !== lease.baseRevision) {
      lease = await setBlocked(stateRoot, target, lease, "ownership-conflict", "created worktree did not match the planned branch and revision");
      return { ok: false, status: "ownership-conflict", lease, preflight };
    }
    lease = await writeLease(stateRoot, target, {
      ...lease,
      taskWorktree: canonicalTaskWorktree,
      lifecycleState: "isolated",
      blockedState: null,
      resources: {
        ...lease.resources,
        taskWorktree: { path: canonicalTaskWorktree, head: lease.baseRevision }
      }
    });
    return {
      ok: true,
      status: resumed ? "reused" : "isolated",
      lease,
      preflight,
      resumed,
      taskIdRegenerated: !resumed && lease.taskId !== requestedTaskId
    };
  });
}

function checkPlan(input, policy) {
  if (!Array.isArray(input) || input.length === 0) throw new Error("Workspace validation requires at least one targeted check");
  if (input.length > 16) throw new Error("Workspace validation check plan exceeds 16 checks");
  return input.map((check, index) => {
    exactKeys(check, ["name", "argv"], `checks[${index}]`);
    if (typeof check.name !== "string" || !check.name.trim() || check.name.length > 160) {
      throw new Error(`checks[${index}].name is invalid`);
    }
    if (!Array.isArray(check.argv) || check.argv.length === 0 || check.argv.length > 64 ||
        check.argv.some((item) => typeof item !== "string" || item.length > 8192 || /[\0\r\n]/.test(item)) ||
        check.argv.reduce((sum, item) => sum + Buffer.byteLength(item), 0) > 64 * 1024) {
      throw new Error(`checks[${index}].argv is invalid`);
    }
    if (/[\r\n]/.test(check.name) || check.argv.some((item) => hasCredentialShapedMaterial(item))) {
      throw new Error(`checks[${index}] contains unsafe diagnostic or credential-shaped material`);
    }
    if (!policy.directCheck.allowedExecutables.includes(check.argv[0])) {
      throw new Error(`checks[${index}] executable is not allowed by task-worktree-v1`);
    }
    if (check.argv.slice(1).some((argument) => DIRECT_FORBIDDEN_NODE_ARGUMENT.test(argument))) {
      throw new Error(`checks[${index}] attempts to weaken Direct check isolation`);
    }
    return { name: check.name.trim(), argv: [...check.argv] };
  });
}

async function resolveExecutable(command, env = process.env) {
  if (command === "node") return realpath(process.execPath);
  for (const directory of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through PATH.
    }
  }
  throw new Error(`Targeted check executable is unavailable: ${command}`);
}

function directCheckFailure(error) {
  const stdout = String(error.stdout ?? "");
  const stderr = String(error.stderr ?? "");
  const diagnostic = `${stdout}\n${stderr}`;
  let failureCode = "process-failed";
  if (/SBW_DIRECT_NETWORK_DENIED/.test(diagnostic)) failureCode = "network-denied";
  else if (/ERR_ACCESS_DENIED/.test(diagnostic)) failureCode = "permission-denied";
  else if (error.code === "ETIMEDOUT") failureCode = "timeout";
  else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") failureCode = "output-limit";
  else if (error.code === "EPROCESSGROUP") failureCode = "process-group-unknown";
  return {
    failureCode,
    processCode: typeof error.code === "number" || typeof error.code === "string" ? String(error.code).slice(0, 64) : null,
    stdoutDigest: sha256(stdout),
    stderrDigest: sha256(stderr),
    outputBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr)
  };
}

async function runChecks(cwd, checks, policy, { stateRoot, repositoryId, taskId }) {
  if (!stateRoot || !REPOSITORY_ID.test(repositoryId) || !TASK_ID.test(taskId)) {
    throw new Error("Targeted checks require a task-scoped scratch identity");
  }
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 24) {
    throw new Error("Targeted Direct checks require Node.js 24 or newer");
  }
  const started = Date.now();
  const results = [];
  const scratchParent = safeJoin(stateRoot, "workspace-check-scratch", repositoryId, taskId);
  await ensurePrivateDir(scratchParent);
  const scratch = await realpath(await mkdtemp(path.join(scratchParent, "check-")));
  const guardPath = safeJoin(scratch, "direct-check-guard.cjs");
  await writeFile(guardPath, `${DIRECT_CHECK_GUARD_SOURCE}\n`, { flag: "wx", mode: 0o600 });
  try {
    for (const check of checks) {
      const elapsed = Date.now() - started;
      const remaining = policy.directCheck.timeoutMs - elapsed;
      if (remaining <= 0) {
        return { ok: false, results, failure: "targeted-check-plan-timeout" };
      }
      const executable = await resolveExecutable(check.argv[0]);
      const nodeArguments = check.argv.slice(1);
      const testIsolation = nodeArguments.some((argument) => argument === "--test" || argument.startsWith("--test="))
        ? ["--test-isolation=none"]
        : [];
      const guardedArguments = [
        "--permission",
        `--allow-fs-read=${cwd}${path.sep}`,
        `--allow-fs-read=${scratch}${path.sep}`,
        `--allow-fs-write=${scratch}${path.sep}`,
        "--require",
        guardPath,
        ...testIsolation,
        ...nodeArguments
      ];
      try {
        const result = await execBoundProcess(executable, guardedArguments, {
          cwd,
          env: {
            PATH: GIT_PATH,
            HOME: "/var/empty",
            TMPDIR: scratch,
            TMP: scratch,
            TEMP: scratch,
            LANG: "C",
            LC_ALL: "C",
            CI: "1",
            NO_COLOR: "1",
            NODE_OPTIONS: "",
            npm_config_offline: "true",
            npm_config_update_notifier: "false",
            PNPM_NETWORK_CONCURRENCY: "0"
          },
          timeoutMs: Math.min(30_000, remaining),
          maxBuffer: Math.min(policy.directCheck.maxOutputBytes, 4 * 1024 * 1024),
          encoding: "utf8",
          label: `Targeted check ${check.name}`
        });
        const stdout = String(result.stdout ?? "");
        const stderr = String(result.stderr ?? "");
        results.push({
          name: check.name,
          argv: check.argv,
          result: "PASS",
          isolation: policy.directCheck.isolation,
          guardDigest: DIRECT_CHECK_GUARD_DIGEST,
          stdoutDigest: sha256(stdout),
          stderrDigest: sha256(stderr),
          outputBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr)
        });
      } catch (error) {
        const failure = directCheckFailure(error);
        results.push({
          name: check.name,
          argv: check.argv,
          result: "FAIL",
          isolation: policy.directCheck.isolation,
          guardDigest: DIRECT_CHECK_GUARD_DIGEST,
          error: String(error.message).slice(0, 512),
          ...failure
        });
        return { ok: false, results, failure: "targeted-check-failed" };
      }
    }
    return { ok: true, results, durationMs: Date.now() - started };
  } finally {
    await rm(scratch, { recursive: true, force: false });
  }
}

async function changedPaths(cwd, baseRevision, head) {
  const result = await git(cwd, ["diff", "--name-status", "-z", `${baseRevision}..${head}`]);
  const tokens = result.stdout.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) throw new Error("Changed-path manifest has an invalid status");
    const count = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    for (let offset = 0; offset < count; offset += 1) {
      const value = tokens[index++];
      if (value === undefined || value.includes("\0")) throw new Error("Changed-path manifest is malformed");
      paths.push(value);
    }
  }
  return [...new Set(paths)].sort();
}

export async function workspaceValidate({ stateRoot, repositoryId, taskId, checks }) {
  const target = leasePath(stateRoot, repositoryId, normalizeTaskId(taskId));
  let lease = await readLeaseAt(stateRoot, target);
  if (!["isolated", "working", "validation-failed", "validated", "integration-ready"].includes(lease.lifecycleState) && lease.blockedState !== "validation-failed") {
    throw new Error(`Workspace lease cannot validate from ${lease.lifecycleState}`);
  }
  const policy = await loadTaskWorktreePolicy();
  const plan = checkPlan(checks, policy);
  if (lease.directRoute && digestObject(plan.map((check) => check.name)) !== digestObject(lease.directRoute.basicCheckPlan)) {
    throw new Error("Direct targeted checks do not match the route-bound basic check plan");
  }
  const state = await worktreeState(lease.taskWorktree);
  const head = await headRevision(lease.taskWorktree);
  const branch = await currentBranch(lease.taskWorktree);
  const taskRecord = await worktreeRecordAtPath(lease.sourceCheckout, lease.taskWorktree);
  const taskRefHead = await resolveLocalBranch(lease.sourceCheckout, lease.taskBranch);
  if (!state.clean || branch !== lease.taskBranch || taskRefHead !== head || !taskRecord ||
      taskRecord.head !== head || taskRecord.branch !== branchRef(lease.taskBranch)) {
    lease = await setBlocked(stateRoot, target, lease, "validation-failed", "task worktree must be clean and checked out on the owned task branch");
    return { ok: false, status: "validation-failed", lease, state };
  }
  const paths = await changedPaths(lease.taskWorktree, lease.baseRevision, head);
  const run = await runChecks(lease.taskWorktree, plan, policy, {
    stateRoot,
    repositoryId,
    taskId: lease.taskId
  });
  const postCheckState = await worktreeState(lease.taskWorktree);
  const postCheckHead = await headRevision(lease.taskWorktree);
  const postCheckBranch = await currentBranch(lease.taskWorktree);
  const postCheckRecord = await worktreeRecordAtPath(lease.sourceCheckout, lease.taskWorktree);
  const postCheckRefHead = await resolveLocalBranch(lease.sourceCheckout, lease.taskBranch);
  if (!postCheckState.clean || postCheckHead !== head || postCheckBranch !== lease.taskBranch ||
      postCheckRefHead !== head || !postCheckRecord || postCheckRecord.head !== head ||
      postCheckRecord.branch !== branchRef(lease.taskBranch)) {
    lease = await setBlocked(stateRoot, target, lease, "validation-failed", "task worktree or branch drifted while targeted checks were running");
    return { ok: false, status: "validation-failed", lease, state: postCheckState };
  }
  const validation = {
    schemaVersion: 1,
    head,
    baseRevision: lease.baseRevision,
    noOp: paths.length === 0,
    changedPaths: paths,
    changedPathsDigest: digestObject(paths),
    checks: run.results,
    checksDigest: digestObject(run.results),
    durationMs: run.durationMs ?? null,
    validatedAt: nowIso()
  };
  if (!run.ok) {
    lease = await writeLease(stateRoot, target, {
      ...lease,
      blockedState: "validation-failed",
      validation
    });
    return { ok: false, status: "validation-failed", lease, validation };
  }
  lease = await writeLease(stateRoot, target, {
    ...lease,
    lifecycleState: "integration-ready",
    blockedState: null,
    validation,
    resources: {
      ...lease.resources,
      taskBranch: { ...lease.resources.taskBranch, currentRevision: head },
      taskWorktree: { ...lease.resources.taskWorktree, head }
    }
  });
  return { ok: true, status: validation.noOp ? "no-op" : "integration-ready", lease, validation };
}

async function isAncestor(cwd, ancestor, descendant) {
  const result = await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFailure: true });
  if (result.ok) return true;
  if (result.code === 1) return false;
  throw new Error(`Git ancestry check failed: ${result.stderr}`);
}

async function exactCandidateMerge(cwd, createdFrom, taskHead, candidateHead) {
  if (candidateHead === createdFrom) return { ok: true, merged: false };
  const fastForward = await isAncestor(cwd, createdFrom, taskHead);
  if (fastForward) return { ok: candidateHead === taskHead, merged: candidateHead === taskHead };
  const parents = oneLine(
    (await git(cwd, ["rev-list", "--parents", "-n", "1", candidateHead])).stdout,
    "Integration candidate parents"
  ).split(" ");
  if (parents.length !== 3 || parents[0] !== candidateHead || parents[1] !== createdFrom || parents[2] !== taskHead) {
    return { ok: false, merged: true };
  }
  const expected = await git(cwd, ["merge-tree", "--write-tree", "--no-messages", createdFrom, taskHead], { allowFailure: true });
  if (!expected.ok) return { ok: false, merged: true };
  const expectedTree = oneLine(expected.stdout, "Expected integration tree", SHA1).toLowerCase();
  const actualTree = oneLine(
    (await git(cwd, ["rev-parse", "--verify", `${candidateHead}^{tree}`])).stdout,
    "Integration candidate tree",
    SHA1
  ).toLowerCase();
  return { ok: expectedTree === actualTree, merged: true };
}

async function worktreeRecordAtPath(cwd, targetPath) {
  const canonicalTarget = await realpath(targetPath).catch(() => path.resolve(targetPath));
  for (const record of await worktreeList(cwd)) {
    const canonicalRecord = await realpath(record.path).catch(() => path.resolve(record.path));
    if (canonicalRecord === canonicalTarget) return record;
  }
  return null;
}

async function removeOwnedCandidate(cwd, lease, expectedHead) {
  const worktree = lease.resources.integrationWorktree;
  const branch = lease.resources.integrationBranch;
  if (!worktree && !branch) return;
  if (!worktree || !branch || !SHA1.test(expectedHead ?? "")) {
    throw new Error("Run-owned integration candidate ownership is incomplete; preserving it");
  }
  const record = await worktreeRecordAtPath(cwd, worktree.path);
  if (await exists(worktree.path)) {
    const state = await worktreeState(worktree.path);
    const head = await headRevision(worktree.path);
    const checkedOutBranch = await currentBranch(worktree.path);
    if (
      !state.clean ||
      head !== expectedHead ||
      checkedOutBranch !== branch.name ||
      !record ||
      record.head !== expectedHead ||
      record.branch !== branchRef(branch.name)
    ) {
      throw new Error("Run-owned integration worktree is dirty or drifted; preserving it");
    }
    await git(cwd, ["worktree", "remove", worktree.path]);
  } else if (record) {
    throw new Error("Run-owned integration worktree path is missing but remains registered; preserving it");
  }
  const current = await resolveLocalBranch(cwd, branch.name);
  if (current !== null) {
    if (current !== expectedHead) throw new Error("Run-owned integration branch drifted; preserving it");
    await git(cwd, ["update-ref", "-d", branchRef(branch.name), expectedHead]);
  }
}

async function targetWorktree(cwd, targetBranch) {
  return (await worktreeList(cwd)).find((record) => record.branch === branchRef(targetBranch)) ?? null;
}

async function updateTarget({ cwd, targetBranch, expectedOld, candidateHead, stateRoot, repositoryId, taskId }) {
  const checkout = await targetWorktree(cwd, targetBranch);
  if (!checkout) {
    const result = await git(cwd, ["update-ref", branchRef(targetBranch), candidateHead, expectedOld], { allowFailure: true });
    return result.ok ? { ok: true, method: "update-ref-cas", checkout: null } : { ok: false, reason: result.stderr };
  }
  const checkoutPath = await realpath(checkout.path);
  const owner = await findLeaseByWorktree(stateRoot, repositoryId, checkoutPath);
  if (owner && owner.taskId !== taskId) return { ok: false, reason: "target-worktree-owned-by-another-task" };
  const state = await worktreeState(checkoutPath);
  const branch = await currentBranch(checkoutPath);
  const head = await headRevision(checkoutPath);
  if (!state.clean || branch !== targetBranch || head !== expectedOld) {
    return { ok: false, reason: "target-worktree-dirty-detached-switched-or-drifted" };
  }
  const result = await git(checkoutPath, ["merge", "--ff-only", candidateHead], { allowFailure: true });
  if (!result.ok) return { ok: false, reason: result.stderr };
  if (await headRevision(checkoutPath) !== candidateHead) {
    return { ok: false, reason: "target-checkout-did-not-reach-candidate-head" };
  }
  return { ok: true, method: "clean-checkout-ff", checkout: checkoutPath };
}

function integrationCandidateIdentity(stateRoot, repositoryId, taskId, attempt) {
  return {
    attempt,
    branch: `codex/integrate-${taskId.slice(-20)}-${attempt}`,
    worktree: safeJoin(stateRoot, "integration-worktrees", repositoryId, `${taskId}-${attempt}`)
  };
}

function recordedCandidateAttempt(lease) {
  const branch = lease.resources.integrationBranch;
  const worktree = lease.resources.integrationWorktree;
  if (!branch && !worktree) return null;
  if (!branch || !worktree) throw new Error("Integration candidate lease records are incomplete");
  if (Number.isInteger(branch.attempt) && branch.attempt > 0) return branch.attempt;
  const inferred = new RegExp(`^codex/integrate-${lease.taskId.slice(-20)}-(\\d+)$`).exec(branch.name);
  if (!inferred) throw new Error("Integration candidate attempt cannot be recovered");
  return Number(inferred[1]);
}

async function prepareIntegrationCandidate({ stateRoot, target, repositoryId, lease, attempt, targetRevision }) {
  const identity = integrationCandidateIdentity(stateRoot, repositoryId, lease.taskId, attempt);
  const recordedAttempt = recordedCandidateAttempt(lease);
  if (recordedAttempt !== null) {
    if (
      recordedAttempt !== attempt ||
      lease.resources.integrationBranch.name !== identity.branch ||
      path.resolve(lease.resources.integrationWorktree.path) !== path.resolve(identity.worktree) ||
      !SHA1.test(lease.resources.integrationBranch.createdFrom)
    ) {
      throw new Error("Recorded integration candidate identity does not match this attempt");
    }
  } else {
    if (await resolveLocalBranch(lease.sourceCheckout, identity.branch) || await exists(identity.worktree)) {
      throw new Error("Unowned integration candidate resource already exists");
    }
    lease = await writeLease(stateRoot, target, {
      ...lease,
      resources: {
        ...lease.resources,
        integrationBranch: {
          name: identity.branch,
          attempt,
          createdFrom: targetRevision,
          head: null,
          state: "planned"
        },
        integrationWorktree: { path: identity.worktree, head: null, state: "planned" }
      }
    });
  }
  const createdFrom = lease.resources.integrationBranch.createdFrom;
  let branchHead = await resolveLocalBranch(lease.sourceCheckout, identity.branch);
  if (branchHead === null) {
    await git(lease.sourceCheckout, ["branch", "--no-track", identity.branch, createdFrom]);
    branchHead = createdFrom;
  }
  await ensurePrivateDir(path.dirname(identity.worktree));
  if (!(await exists(identity.worktree))) {
    await git(lease.sourceCheckout, ["worktree", "add", identity.worktree, identity.branch]);
  }
  const candidatePath = await realpath(identity.worktree);
  const records = await worktreeList(lease.sourceCheckout);
  let record = null;
  for (const candidate of records) {
    const candidateRealPath = await realpath(candidate.path).catch(() => path.resolve(candidate.path));
    if (candidateRealPath === candidatePath) {
      record = candidate;
      break;
    }
  }
  branchHead = await resolveLocalBranch(lease.sourceCheckout, identity.branch);
  if (!record || record.branch !== branchRef(identity.branch) || record.head !== branchHead || !branchHead) {
    throw new Error("Integration candidate branch and worktree no longer match");
  }
  lease = await writeLease(stateRoot, target, {
    ...lease,
    resources: {
      ...lease.resources,
      integrationBranch: {
        ...lease.resources.integrationBranch,
        attempt,
        head: branchHead,
        state: "prepared"
      },
      integrationWorktree: {
        ...lease.resources.integrationWorktree,
        path: candidatePath,
        head: branchHead,
        state: "prepared"
      }
    }
  });
  return {
    lease,
    attempt,
    candidateBranch: identity.branch,
    candidatePath,
    candidateHead: branchHead,
    createdFrom
  };
}

export async function workspaceIntegrate({
  stateRoot,
  repositoryId,
  taskId,
  beforeTargetUpdate = null,
  afterTargetUpdate = null
}) {
  const target = leasePath(stateRoot, repositoryId, normalizeTaskId(taskId));
  let lease = await readLeaseAt(stateRoot, target);
  if (lease.lifecycleState === "integrated" && lease.blockedState === null && lease.integration) {
    const currentTarget = await resolveLocalBranch(lease.sourceCheckout, lease.integrationTarget);
    if (currentTarget && await isAncestor(lease.sourceCheckout, lease.integration.finalTargetRevision, currentTarget)) {
      return { ok: true, status: "integrated", lease, integration: lease.integration, resumed: true };
    }
    throw new Error("Recorded integration is no longer contained by its target");
  }
  if (lease.lifecycleState !== "integration-ready" || lease.blockedState !== null || !lease.validation) {
    throw new Error("Workspace integration requires an unblocked integration-ready lease");
  }
  if (beforeTargetUpdate !== null && typeof beforeTargetUpdate !== "function") {
    throw new Error("beforeTargetUpdate must be a function");
  }
  if (afterTargetUpdate !== null && typeof afterTargetUpdate !== "function") {
    throw new Error("afterTargetUpdate must be a function");
  }
  const taskState = await worktreeState(lease.taskWorktree);
  const taskHead = await headRevision(lease.taskWorktree);
  if (!taskState.clean || taskHead !== lease.validation.head || await currentBranch(lease.taskWorktree) !== lease.taskBranch) {
    lease = await setBlocked(stateRoot, target, lease, "validation-failed", "task worktree changed after validation");
    return { ok: false, status: "validation-failed", lease };
  }
  if (lease.protectedTarget) {
    return {
      ok: true,
      status: "pr-required",
      lifecycle: "governed-pr",
      taskBranch: lease.taskBranch,
      taskHead,
      integrationTarget: lease.integrationTarget,
      cleanupAllowed: false,
      lease
    };
  }
  const policy = await loadTaskWorktreePolicy();
  return withRepositoryLock(stateRoot, repositoryId, async () => {
    lease = await readLeaseAt(stateRoot, target);
    const lockedTaskState = await worktreeState(lease.taskWorktree);
    const lockedTaskHead = await headRevision(lease.taskWorktree);
    if (!lockedTaskState.clean || lockedTaskHead !== lease.validation.head || await currentBranch(lease.taskWorktree) !== lease.taskBranch) {
      lease = await setBlocked(stateRoot, target, lease, "validation-failed", "task worktree changed before integration lock acquisition");
      return { ok: false, status: "validation-failed", lease };
    }
    const recordedAttempt = recordedCandidateAttempt(lease);
    const firstAttempt = recordedAttempt ?? 1;
    for (let attempt = firstAttempt; attempt <= policy.integration.casRetries + 1; attempt += 1) {
      const targetRevision = await resolveLocalBranch(lease.sourceCheckout, lease.integrationTarget);
      if (!targetRevision) {
        lease = await setBlocked(stateRoot, target, lease, "target-missing", "integration target no longer resolves");
        return { ok: false, status: "target-missing", lease };
      }
      let candidate;
      try {
        candidate = await prepareIntegrationCandidate({
          stateRoot,
          target,
          repositoryId,
          lease,
          attempt,
          targetRevision
        });
        lease = candidate.lease;
      } catch (error) {
        lease = await setBlocked(stateRoot, target, lease, "ownership-conflict", error.message);
        return { ok: false, status: "ownership-conflict", lease };
      }
      let { candidateBranch, candidatePath, candidateHead, createdFrom } = candidate;
      let candidateMerge = await exactCandidateMerge(candidatePath, createdFrom, taskHead, candidateHead);
      if (!candidateMerge.ok) {
        lease = await setBlocked(stateRoot, target, lease, "unknown-integration", "integration candidate is not the exact merge of target and validated task head");
        return { ok: false, status: "unknown-integration", lease };
      }
      const targetAlreadyUpdated = targetRevision === candidateHead && candidateMerge.merged;
      if (targetRevision !== createdFrom && !targetAlreadyUpdated) {
        if (attempt <= policy.integration.casRetries) {
          await removeOwnedCandidate(lease.sourceCheckout, lease, candidateHead);
          lease = await writeLease(stateRoot, target, {
            ...lease,
            resources: { ...lease.resources, integrationBranch: null, integrationWorktree: null }
          });
          continue;
        }
        lease = await setBlocked(stateRoot, target, lease, "target-drift", "integration target moved after candidate creation");
        return { ok: false, status: "target-drift", lease };
      }
      if (!targetAlreadyUpdated && !candidateMerge.merged) {
        const ff = await isAncestor(candidatePath, createdFrom, taskHead);
        const merge = await git(
          candidatePath,
          ff
            ? ["merge", "--ff-only", lease.taskBranch]
            : ["merge", "--no-ff", "--no-edit", lease.taskBranch],
          { allowFailure: true }
        );
        if (!merge.ok) {
          await git(candidatePath, ["merge", "--abort"], { allowFailure: true });
          lease = await setBlocked(stateRoot, target, lease, "merge-conflict", merge.stderr);
          return { ok: false, status: "merge-conflict", lease };
        }
        candidateHead = await headRevision(candidatePath);
        candidateMerge = await exactCandidateMerge(candidatePath, createdFrom, taskHead, candidateHead);
        if (!candidateMerge.ok || !candidateMerge.merged) {
          lease = await setBlocked(stateRoot, target, lease, "unknown-integration", "created candidate is not the exact merge of target and validated task head");
          return { ok: false, status: "unknown-integration", lease };
        }
      }
      const candidateState = await worktreeState(candidatePath);
      const candidateRecord = await worktreeRecordAtPath(lease.sourceCheckout, candidatePath);
      const candidateRefHead = await resolveLocalBranch(lease.sourceCheckout, candidateBranch);
      if (!candidateState.clean || candidateRefHead !== candidateHead || !candidateRecord ||
          candidateRecord.head !== candidateHead || candidateRecord.branch !== branchRef(candidateBranch)) {
        lease = await setBlocked(stateRoot, target, lease, "unknown-integration", "candidate does not cleanly contain the validated task head");
        return { ok: false, status: "unknown-integration", lease };
      }
      const checks = lease.validation.checks.map((check) => ({ name: check.name, argv: check.argv }));
      const validation = await runChecks(candidatePath, checks, policy, {
        stateRoot,
        repositoryId,
        taskId: lease.taskId
      });
      if (!validation.ok) {
        lease = await setBlocked(stateRoot, target, lease, "validation-failed", validation);
        return { ok: false, status: "validation-failed", lease, validation };
      }
      const postCheckCandidateState = await worktreeState(candidatePath);
      const postCheckCandidateHead = await headRevision(candidatePath);
      const postCheckCandidateBranch = await currentBranch(candidatePath);
      const postCheckCandidateRecord = await worktreeRecordAtPath(lease.sourceCheckout, candidatePath);
      const postCheckCandidateRef = await resolveLocalBranch(lease.sourceCheckout, candidateBranch);
      if (!postCheckCandidateState.clean || postCheckCandidateHead !== candidateHead ||
          postCheckCandidateBranch !== candidateBranch || postCheckCandidateRef !== candidateHead ||
          !postCheckCandidateRecord || postCheckCandidateRecord.head !== candidateHead ||
          postCheckCandidateRecord.branch !== branchRef(candidateBranch)) {
        lease = await setBlocked(stateRoot, target, lease, "validation-failed", "integration candidate drifted while targeted checks were running");
        return { ok: false, status: "validation-failed", lease };
      }
      lease = await writeLease(stateRoot, target, {
        ...lease,
        resources: {
          ...lease.resources,
          integrationBranch: { ...lease.resources.integrationBranch, head: candidateHead, state: "validated" },
          integrationWorktree: { ...lease.resources.integrationWorktree, head: candidateHead, state: "validated" }
        }
      });
      if (!targetAlreadyUpdated && beforeTargetUpdate !== null) {
        await beforeTargetUpdate({
          attempt,
          targetRevision: createdFrom,
          candidateHead,
          lease
        });
      }
      const preUpdateCandidateState = await worktreeState(candidatePath);
      const preUpdateCandidateHead = await headRevision(candidatePath);
      const preUpdateCandidateBranch = await currentBranch(candidatePath);
      const preUpdateCandidateRecord = await worktreeRecordAtPath(lease.sourceCheckout, candidatePath);
      const preUpdateCandidateRef = await resolveLocalBranch(lease.sourceCheckout, candidateBranch);
      if (!preUpdateCandidateState.clean || preUpdateCandidateHead !== candidateHead ||
          preUpdateCandidateBranch !== candidateBranch || preUpdateCandidateRef !== candidateHead ||
          !preUpdateCandidateRecord || preUpdateCandidateRecord.head !== candidateHead ||
          preUpdateCandidateRecord.branch !== branchRef(candidateBranch)) {
        lease = await setBlocked(stateRoot, target, lease, "ownership-conflict", "validated integration candidate drifted before target update");
        return { ok: false, status: "ownership-conflict", lease };
      }
      const updated = targetAlreadyUpdated
        ? { ok: true, method: "recovered-target-update", checkout: null }
        : await updateTarget({
            cwd: lease.sourceCheckout,
            targetBranch: lease.integrationTarget,
            expectedOld: createdFrom,
            candidateHead,
            stateRoot,
            repositoryId,
            taskId: lease.taskId
          });
      if (!updated.ok) {
        if (attempt <= policy.integration.casRetries) {
          await removeOwnedCandidate(lease.sourceCheckout, lease, candidateHead);
          lease = await writeLease(stateRoot, target, {
            ...lease,
            resources: { ...lease.resources, integrationBranch: null, integrationWorktree: null }
          });
          continue;
        }
        lease = await setBlocked(stateRoot, target, lease, "target-drift", updated.reason);
        return { ok: false, status: "target-drift", lease };
      }
      if (!targetAlreadyUpdated && afterTargetUpdate !== null) {
        await afterTargetUpdate({ attempt, targetRevision: createdFrom, candidateHead, lease, updated });
      }
      const finalTarget = await resolveLocalBranch(lease.sourceCheckout, lease.integrationTarget);
      if (finalTarget !== candidateHead) {
        lease = await setBlocked(stateRoot, target, lease, "unknown-integration", "target reconciliation did not match the candidate head");
        return { ok: false, status: "unknown-integration", lease };
      }
      const integration = {
        schemaVersion: 1,
        method: updated.method,
        attempt,
        targetOldRevision: createdFrom,
        taskHead,
        candidateBranch,
        candidateWorktree: candidatePath,
        candidateHead,
        finalTargetRevision: finalTarget,
        checks: validation.results,
        checksDigest: digestObject(validation.results),
        integratedAt: nowIso()
      };
      lease = await writeLease(stateRoot, target, {
        ...lease,
        lifecycleState: "integrated",
        blockedState: null,
        integration
      });
      return { ok: true, status: "integrated", lease, integration };
    }
    throw new Error("Integration retry loop exhausted unexpectedly");
  });
}

function exactSuccessfulAction(actions, runId, predicate, label) {
  const matches = actions.filter((action) => (
    action.status === "spent" &&
    action.outcome === "success" &&
    action.runId === runId &&
    action.receipt?.action === action.action &&
    action.receipt?.provider === action.provider &&
    action.receipt?.resource === action.resource &&
    action.receipt?.outcome === action.outcome &&
    action.receipt?.runId === runId &&
    action.receipt?.attemptId === action.attemptId &&
    action.receipt?.idempotencyKey === action.idempotencyKey &&
    action.receipt?.remoteRevision === action.remoteRevision &&
    action.receipt?.providerReceipt?.action === action.action &&
    action.receipt?.providerReceipt?.provider === action.provider &&
    action.receipt?.providerReceipt?.resource === action.resource &&
    action.receipt?.providerReceipt?.outcome === action.outcome &&
    action.receipt?.providerReceipt?.runId === runId &&
    action.receipt?.providerReceipt?.attemptId === action.attemptId &&
    action.receipt?.providerReceipt?.idempotencyKey === action.idempotencyKey &&
    action.receipt?.providerReceipt?.remoteRevision === action.remoteRevision &&
    predicate(action, action.receipt.providerReceipt)
  ));
  if (matches.length !== 1) throw new Error(`${label} requires exactly one matching successful governed action`);
  const action = matches[0];
  assertProviderReceiptShape(action, action.receipt.providerReceipt, "success");
  return action;
}

export async function workspaceReconcileProtected({
  stateRoot,
  repositoryId,
  taskId,
  runId,
  inspect = inspectRun
}) {
  const target = leasePath(stateRoot, repositoryId, normalizeTaskId(taskId));
  let lease = await readLeaseAt(stateRoot, target);
  if (!lease.protectedTarget || lease.lifecycleState !== "integration-ready" || lease.blockedState !== null || !lease.validation) {
    throw new Error("Protected reconciliation requires an unblocked integration-ready protected lease");
  }
  if (typeof runId !== "string" || !runId) throw new Error("Protected reconciliation requires a governed run id");
  if (typeof inspect !== "function") throw new Error("Protected reconciliation inspector must be a function");

  return withRepositoryLock(stateRoot, repositoryId, async () => {
    lease = await readLeaseAt(stateRoot, target);
    if (!lease.protectedTarget || lease.lifecycleState !== "integration-ready" || lease.blockedState !== null || !lease.validation) {
      throw new Error("Protected reconciliation lease changed before the repository lock was acquired");
    }
    const run = await inspect(stateRoot, runId);
    const runRepository = await repositoryInfo(run.manifest?.cwd ?? "").catch(() => null);
    if (!runRepository || runRepository.repositoryDigest !== lease.repository.repositoryDigest) {
      throw new Error("Governed delivery run belongs to a different repository");
    }
    if (run.manifest?.sourceBinding?.headRevision !== lease.validation.head) {
      throw new Error("Governed delivery run is not bound to the validated task head");
    }
    const actions = Array.isArray(run.actions) ? run.actions : [];
    const taskHead = lease.validation.head;
    const mergeAction = exactSuccessfulAction(
      actions,
      runId,
      (action, receipt) => (
        action.action === "pr.merge" &&
        action.provider === "github-cli" &&
        action.reviewedHead === taskHead &&
        action.targetRef === lease.integrationTarget &&
        receipt.terminalState === "success" &&
        receipt.state === "MERGED" &&
        receipt.head === taskHead &&
        receipt.mergeHead === taskHead &&
        receipt.baseRefName === lease.integrationTarget &&
        ["merge", "squash"].includes(receipt.mergeMethod)
      ),
      "Protected reconciliation"
    );
    const mergeReceipt = mergeAction.receipt.providerReceipt;
    if (!SHA1.test(mergeReceipt.mergeCommit)) throw new Error("Protected merge receipt is missing an exact merge commit");
    const syncAction = exactSuccessfulAction(
      actions,
      runId,
      (action, receipt) => (
        action.action === "remote.sync" &&
        action.provider === "git" &&
        action.resource === `refs/heads/${lease.integrationTarget}` &&
        action.reviewedHead === taskHead &&
        action.pullRequest === mergeReceipt.pr &&
        action.mergeCommit === mergeReceipt.mergeCommit &&
        receipt.terminalState === "success" &&
        receipt.ref === `refs/heads/${lease.integrationTarget}` &&
        receipt.providerRevision === mergeReceipt.mergeCommit &&
        receipt.localRevision === mergeReceipt.mergeCommit
      ),
      "Protected target reconciliation"
    );
    const syncReceipt = syncAction.receipt.providerReceipt;
    const currentTarget = await resolveLocalBranch(lease.sourceCheckout, lease.integrationTarget);
    if (!currentTarget || !(await isAncestor(lease.sourceCheckout, syncReceipt.localRevision, currentTarget))) {
      lease = await setBlocked(stateRoot, target, lease, "unknown-integration", "local target does not contain the provider-reconciled merge commit");
      return { ok: false, status: "unknown-integration", lease };
    }
    if (mergeReceipt.mergeMethod === "merge" && !(await isAncestor(lease.sourceCheckout, taskHead, mergeReceipt.mergeCommit))) {
      lease = await setBlocked(stateRoot, target, lease, "unknown-integration", "merge commit does not contain the exact validated task head");
      return { ok: false, status: "unknown-integration", lease };
    }
    if (!(await isAncestor(lease.sourceCheckout, mergeReceipt.mergeCommit, currentTarget))) {
      lease = await setBlocked(stateRoot, target, lease, "unknown-integration", "current target no longer contains the reconciled merge commit");
      return { ok: false, status: "unknown-integration", lease };
    }
    const integration = {
      schemaVersion: 1,
      method: `governed-pr-${mergeReceipt.mergeMethod}`,
      taskHead,
      finalTargetRevision: syncReceipt.localRevision,
      observedTargetRevision: currentTarget,
      governedRunId: runId,
      mergeAttemptId: mergeAction.attemptId,
      syncAttemptId: syncAction.attemptId,
      pullRequest: mergeReceipt.pr,
      mergeCommit: mergeReceipt.mergeCommit,
      mergeReceiptDigest: digestObject(mergeReceipt),
      syncReceiptDigest: digestObject(syncReceipt),
      reconciledAt: nowIso()
    };
    lease = await writeLease(stateRoot, target, {
      ...lease,
      lifecycleState: "integrated",
      blockedState: null,
      integration
    });
    return { ok: true, status: "integrated", lease, integration };
  });
}

function cleanupEligible(lease) {
  return (
    lease.lifecycleState === "integrated" ||
    lease.lifecycleState === "cleanup-ready" ||
    (lease.lifecycleState === "integration-ready" && lease.validation?.noOp === true)
  );
}

function cleanupIsValidatedNoOp(lease) {
  return lease.lifecycleState === "integration-ready" && lease.validation?.noOp === true;
}

function cleanupReceiptPath(stateRoot, repositoryId, taskId) {
  return safeJoin(stateRoot, "workspace-cleanup", repositoryId, `${taskId}.json`);
}

async function readCleanupReceipt(stateRoot, target) {
  const receipt = await readJson(stateRoot, target);
  exactKeys(receipt, [
    "schemaVersion",
    "kind",
    "taskId",
    "repositoryDigest",
    "integrationTarget",
    "finalTargetRevision",
    "removed",
    "preserved",
    "cleanedAt",
    "receiptDigest"
  ], "Workspace cleanup receipt");
  const payload = { ...receipt };
  delete payload.receiptDigest;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "WorkspaceCleanupReceiptV1" ||
    !TASK_ID.test(receipt.taskId) ||
    !/^[a-f0-9]{64}$/.test(receipt.repositoryDigest) ||
    !BRANCH.test(receipt.integrationTarget) ||
    !SHA1.test(receipt.finalTargetRevision) ||
    !receipt.removed || typeof receipt.removed !== "object" || Array.isArray(receipt.removed) ||
    !(receipt.preserved === null || (typeof receipt.preserved === "object" && !Array.isArray(receipt.preserved))) ||
    Number.isNaN(Date.parse(receipt.cleanedAt)) ||
    !/^[a-f0-9]{64}$/.test(receipt.receiptDigest) ||
    digestObject(payload) !== receipt.receiptDigest
  ) {
    throw new Error("Workspace cleanup receipt identity or digest is invalid");
  }
  return receipt;
}

async function completedCleanupResult(stateRoot, repositoryId, lease) {
  const expectedPath = cleanupReceiptPath(stateRoot, repositoryId, lease.taskId);
  if (
    lease.lifecycleState !== "cleaned" ||
    lease.blockedState !== null ||
    lease.cleanup?.path !== expectedPath
  ) {
    throw new Error("Cleaned workspace lease is missing its exact cleanup receipt binding");
  }
  const cleanup = await readCleanupReceipt(stateRoot, expectedPath);
  if (
    cleanup.taskId !== lease.taskId ||
    cleanup.repositoryDigest !== lease.repository.repositoryDigest ||
    cleanup.integrationTarget !== lease.integrationTarget ||
    cleanup.receiptDigest !== lease.cleanup.receiptDigest
  ) {
    throw new Error("Cleaned workspace lease and cleanup receipt do not reconcile");
  }
  return {
    ok: true,
    status: "cleaned",
    lease,
    cleanup: { ...cleanup, path: expectedPath },
    resumed: true
  };
}

async function verifyCleanupTarget(lease, taskHead) {
  const integratedTargetHead = lease.validation.noOp
    ? lease.targetRevisionAtBind
    : lease.integration?.finalTargetRevision;
  const currentTargetHead = await resolveLocalBranch(lease.sourceCheckout, lease.integrationTarget);
  const governedSquash = (
    lease.integration?.method === "governed-pr-squash" &&
    lease.integration?.taskHead === taskHead &&
    SHA1.test(lease.integration?.mergeCommit ?? "") &&
    /^[a-f0-9]{64}$/.test(lease.integration?.mergeReceiptDigest ?? "") &&
    /^[a-f0-9]{64}$/.test(lease.integration?.syncReceiptDigest ?? "")
  );
  const taskContained = currentTargetHead
    ? (governedSquash
        ? await isAncestor(lease.sourceCheckout, lease.integration.mergeCommit, currentTargetHead)
        : await isAncestor(lease.sourceCheckout, taskHead, currentTargetHead))
    : false;
  if (
    !SHA1.test(integratedTargetHead ?? "") ||
    !currentTargetHead ||
    !(await isAncestor(lease.sourceCheckout, integratedTargetHead, currentTargetHead)) ||
    !taskContained
  ) {
    throw new Error("Integration target does not contain the reconciled task result; preserving task resources");
  }
  return currentTargetHead;
}

export async function workspaceCleanup({
  stateRoot,
  repositoryId,
  taskId,
  afterTaskWorktreeRemoval = null
}) {
  const target = leasePath(stateRoot, repositoryId, normalizeTaskId(taskId));
  let lease = await readLeaseAt(stateRoot, target);
  if (lease.lifecycleState === "cleaned") return completedCleanupResult(stateRoot, repositoryId, lease);
  if (afterTaskWorktreeRemoval !== null && typeof afterTaskWorktreeRemoval !== "function") {
    throw new Error("afterTaskWorktreeRemoval must be a function");
  }
  if (lease.blockedState !== null) throw new Error(`Cleanup is blocked by ${lease.blockedState}`);
  if (!cleanupEligible(lease)) {
    throw new Error("Cleanup requires terminal integration success or a validated no-op");
  }
  if (lease.protectedTarget &&
      !["integrated", "cleanup-ready"].includes(lease.lifecycleState) &&
      !cleanupIsValidatedNoOp(lease)) {
    throw new Error("Protected delivery cannot be cleaned before an exact provider merge receipt is reconciled");
  }
  const cwd = await realpath(process.cwd());
  const taskPath = await realpath(lease.taskWorktree).catch(() => path.resolve(lease.taskWorktree));
  if (cwd === taskPath || cwd.startsWith(`${taskPath}${path.sep}`)) {
    throw new Error("Run cleanup from outside the task worktree so Git can remove it safely");
  }
  return withRepositoryLock(stateRoot, repositoryId, async () => {
    lease = await readLeaseAt(stateRoot, target);
    if (lease.lifecycleState === "cleaned") return completedCleanupResult(stateRoot, repositoryId, lease);
    if (lease.blockedState !== null) throw new Error(`Cleanup is blocked by ${lease.blockedState}`);
    if (!cleanupEligible(lease)) {
      throw new Error("Cleanup lease changed before the repository lock was acquired");
    }
    if (lease.protectedTarget &&
        !["integrated", "cleanup-ready"].includes(lease.lifecycleState) &&
        !cleanupIsValidatedNoOp(lease)) {
      throw new Error("Protected delivery cannot be cleaned before an exact provider merge receipt is reconciled");
    }
    const taskHead = lease.validation?.head;
    if (!SHA1.test(taskHead ?? "")) throw new Error("Cleanup requires an exact validated task head");
    const preserveHostResources = lease.resourceOrigin === "host-provided";
    const taskWorktreeExists = await exists(lease.taskWorktree);
    const taskWorktreeRecord = await worktreeRecordAtPath(lease.sourceCheckout, lease.taskWorktree);
    if (taskWorktreeExists) {
      const taskState = await worktreeState(lease.taskWorktree);
      const observedTaskHead = await headRevision(lease.taskWorktree);
      const observedTaskBranch = await currentBranch(lease.taskWorktree);
      if (
        !taskState.clean ||
        observedTaskHead !== taskHead ||
        observedTaskBranch !== lease.taskBranch ||
        !taskWorktreeRecord ||
        taskWorktreeRecord.head !== taskHead ||
        taskWorktreeRecord.branch !== branchRef(lease.taskBranch)
      ) {
        throw new Error("Task worktree is dirty or drifted; preserving task resources");
      }
    } else if (taskWorktreeRecord) {
      throw new Error("Task worktree path is missing but remains registered; preserving task resources");
    } else if (lease.lifecycleState !== "cleanup-ready" || preserveHostResources) {
      throw new Error("Task worktree vanished before cleanup ownership was recorded");
    }
    const taskRefHead = await resolveLocalBranch(lease.sourceCheckout, lease.taskBranch);
    if (taskRefHead !== null && taskRefHead !== taskHead) {
      throw new Error("Task branch drifted during cleanup; preserving its ref");
    }
    if (taskRefHead === null && (lease.lifecycleState !== "cleanup-ready" || preserveHostResources)) {
      throw new Error("Task branch vanished before cleanup ownership was recorded");
    }
    const currentTargetHead = await verifyCleanupTarget(lease, taskHead);
    if (lease.lifecycleState !== "cleanup-ready") {
      lease = await writeLease(stateRoot, target, { ...lease, lifecycleState: "cleanup-ready" });
    }
    if (lease.resources.integrationWorktree || lease.resources.integrationBranch) {
      const candidateHead = lease.integration?.candidateHead ?? lease.resources.integrationBranch?.head;
      await removeOwnedCandidate(lease.sourceCheckout, lease, candidateHead);
      lease = await writeLease(stateRoot, target, {
        ...lease,
        resources: { ...lease.resources, integrationBranch: null, integrationWorktree: null }
      });
    }
    if (!preserveHostResources) {
      if (await exists(lease.taskWorktree)) {
        await git(lease.sourceCheckout, ["worktree", "remove", lease.taskWorktree]);
        lease = await writeLease(stateRoot, target, {
          ...lease,
          resources: { ...lease.resources, taskWorktree: null }
        });
        if (afterTaskWorktreeRemoval !== null) await afterTaskWorktreeRemoval({ lease, taskHead });
      } else if (await worktreeRecordAtPath(lease.sourceCheckout, lease.taskWorktree)) {
        throw new Error("Removed task worktree remains registered; preserving its branch");
      } else if (lease.resources.taskWorktree !== null) {
        lease = await writeLease(stateRoot, target, {
          ...lease,
          resources: { ...lease.resources, taskWorktree: null }
        });
      }
      const currentTaskRef = await resolveLocalBranch(lease.sourceCheckout, lease.taskBranch);
      if (currentTaskRef !== null) {
        if (currentTaskRef !== taskHead) throw new Error("Task branch drifted during cleanup; preserving its ref");
        await git(lease.sourceCheckout, ["update-ref", "-d", branchRef(lease.taskBranch), taskHead]);
      }
      if (lease.resources.taskBranch !== null) {
        lease = await writeLease(stateRoot, target, {
          ...lease,
          resources: { ...lease.resources, taskBranch: null }
        });
      }
    }
    const expectedRemoved = {
      taskBranch: preserveHostResources ? null : lease.taskBranch,
      taskWorktree: preserveHostResources ? null : lease.taskWorktree,
      integrationBranch: lease.integration?.candidateBranch ?? null,
      integrationWorktree: lease.integration?.candidateWorktree ?? null
    };
    const expectedPreserved = preserveHostResources
      ? {
          taskBranch: lease.taskBranch,
          taskWorktree: lease.taskWorktree,
          reason: "host-provided-resources-remain-under-host-ownership"
        }
      : null;
    const cleanupPath = cleanupReceiptPath(stateRoot, repositoryId, lease.taskId);
    let cleanup;
    if (await exists(cleanupPath)) {
      cleanup = await readCleanupReceipt(stateRoot, cleanupPath);
      if (
        cleanup.taskId !== lease.taskId ||
        cleanup.repositoryDigest !== lease.repository.repositoryDigest ||
        cleanup.integrationTarget !== lease.integrationTarget ||
        digestObject(cleanup.removed) !== digestObject(expectedRemoved) ||
        digestObject(cleanup.preserved) !== digestObject(expectedPreserved) ||
        !(await isAncestor(lease.sourceCheckout, cleanup.finalTargetRevision, currentTargetHead))
      ) {
        throw new Error("Existing cleanup receipt does not reconcile with the resumable cleanup state");
      }
    } else {
      const cleanupPayload = {
      schemaVersion: 1,
      kind: "WorkspaceCleanupReceiptV1",
      taskId: lease.taskId,
      repositoryDigest: lease.repository.repositoryDigest,
      integrationTarget: lease.integrationTarget,
      finalTargetRevision: currentTargetHead,
      removed: expectedRemoved,
      preserved: expectedPreserved,
      cleanedAt: nowIso()
      };
      cleanup = { ...cleanupPayload, receiptDigest: digestObject(cleanupPayload) };
      await atomicWriteJson(stateRoot, cleanupPath, cleanup);
    }
    lease = await writeLease(stateRoot, target, {
      ...lease,
      lifecycleState: "cleaned",
      cleanup: { ...cleanup, path: cleanupPath },
      resources: {
        taskBranch: preserveHostResources ? lease.resources.taskBranch : null,
        taskWorktree: preserveHostResources ? lease.resources.taskWorktree : null,
        integrationBranch: null,
        integrationWorktree: null
      }
    });
    return { ok: true, status: "cleaned", lease, cleanup: { ...cleanup, path: cleanupPath } };
  });
}

export async function workspaceStatus({ stateRoot, repositoryId, taskId }) {
  const lease = await readWorkspaceLease({ stateRoot, repositoryId, taskId });
  const resources = {
    taskWorktreeExists: lease.taskWorktree ? await exists(lease.taskWorktree) : false,
    taskBranchRevision: lease.taskBranch ? await resolveLocalBranch(lease.sourceCheckout, lease.taskBranch) : null,
    integrationTargetRevision: lease.integrationTarget ? await resolveLocalBranch(lease.sourceCheckout, lease.integrationTarget) : null,
    resourceOrigin: lease.resourceOrigin ?? "better-workflows",
    cleanupDisposition: lease.resourceOrigin === "host-provided" ? "preserve-host-provided" : "remove-run-owned"
  };
  return { ok: lease.blockedState === null, lease, resources };
}

export async function workspaceDirectCompletionNotice({ stateRoot, repositoryId, taskId }) {
  const lease = await readWorkspaceLease({ stateRoot, repositoryId, taskId });
  if (!lease.directRoute) throw new Error("Direct completion notice requires a route-bound Direct workspace lease");
  const completed = await completedCleanupResult(stateRoot, repositoryId, lease);
  const validation = lease.validation;
  if (!validation || !SHA1.test(validation.head ?? "") || !Array.isArray(validation.checks) ||
      validation.checks.length === 0 || validation.checks.some((check) => check?.result !== "PASS")) {
    throw new Error("Direct completion notice requires exact successful validation results");
  }
  const checkNames = validation.checks.map((check) => check.name);
  if (digestObject(checkNames) !== digestObject(lease.directRoute.basicCheckPlan)) {
    throw new Error("Direct completion notice checks differ from the route-bound basic check plan");
  }
  const noOp = validation.noOp === true;
  if (!noOp) {
    if (!lease.integration || lease.integration.taskHead !== validation.head ||
        !Array.isArray(lease.integration.checks) || lease.integration.checks.length === 0 ||
        lease.integration.checks.some((check) => check?.result !== "PASS")) {
      throw new Error("Direct completion notice requires exact successful integration validation");
    }
  }
  const currentTargetRevision = await verifyCleanupTarget(lease, validation.head);
  if (!(await isAncestor(lease.sourceCheckout, completed.cleanup.finalTargetRevision, currentTargetRevision))) {
    throw new Error("Direct completion notice cleanup receipt is stale relative to the current target");
  }
  const cleanupDisposition = lease.resourceOrigin === "host-provided"
    ? "preserve-host-provided"
    : "remove-run-owned";
  return {
    ok: true,
    status: "complete",
    targetBranch: lease.integrationTarget,
    targetRevision: currentTargetRevision,
    checks: checkNames,
    noOp,
    cleanupDisposition,
    cleanupReceiptDigest: completed.cleanup.receiptDigest,
    notice: directCompletionNotice({
      targetBranch: lease.integrationTarget,
      checks: checkNames,
      integrated: !noOp,
      cleaned: true,
      noOp,
      cleanupDisposition
    })
  };
}

export function directCompletionNotice({
  targetBranch,
  checks,
  integrated,
  cleaned,
  noOp = false,
  cleanupDisposition = "remove-run-owned"
}) {
  if (typeof noOp !== "boolean" || (!integrated && !noOp) || !cleaned) {
    throw new Error("Direct completion notice requires terminal integration or no-op reconciliation plus cleanup");
  }
  if (!BRANCH.test(String(targetBranch ?? "")) || String(targetBranch).startsWith("origin/") ||
      String(targetBranch).startsWith("refs/remotes/") || isProtectedBranch(String(targetBranch))) {
    throw new Error("Direct completion notice requires a non-protected local target branch");
  }
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > 16 ||
      checks.some((check) => typeof check !== "string" || !check.trim() || check.length > 160 || /[\r\n]/.test(check))) {
    throw new Error("Direct completion notice requires the target branch and actual checks");
  }
  if (!["remove-run-owned", "preserve-host-provided"].includes(cleanupDisposition)) {
    throw new Error("Direct completion notice cleanup disposition is invalid");
  }
  const isolationStatus = noOp
    ? cleanupDisposition === "preserve-host-provided"
      ? `Git 隔離狀態：已在 host 提供的本任務專屬 worktree 確認沒有 repository diff；Better Workflows 已完成 lease cleanup，task branch 與 worktree 依 host ownership 保留，交由 host 釋放。`
      : "Git 隔離狀態：已在本任務專屬 worktree 確認沒有 repository diff，並且只清理本任務擁有的 branch 與 worktree。"
    : cleanupDisposition === "preserve-host-provided"
      ? `Git 隔離狀態：已在 host 提供的本任務專屬 worktree 完成並安全整合至 ${targetBranch}；Better Workflows 已完成 lease cleanup，task branch 與 worktree 依 host ownership 保留，交由 host 釋放。`
      : `Git 隔離狀態：已在本任務專屬 worktree 完成，安全整合至 ${targetBranch}，並且只清理本任務擁有的 branch 與 worktree。`;
  return [
    "本次工作經 Auto 評估為範圍明確、可回復的低風險修改，因此採用 Direct 路徑，未啟用完整的 Better Workflows 證據工作流。",
    isolationStatus,
    `已完成的基本檢查：${checks.map((check) => check.trim()).join("、")}。`,
    "本次成果已通過上述基本檢查，但不等同於完整、可重播的證據驗證。如需升級驗證強度，請回覆「補做證據驗證」，Better Workflows 將至少改走 Verified 路徑。"
  ].join("\n\n");
}
