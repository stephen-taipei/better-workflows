import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  access,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  unlink
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteJson,
  digestObject,
  ensurePrivateDir,
  execBoundGit,
  execBoundProcess,
  nowIso,
  pluginRoot,
  readJson,
  safeJoin,
  sha256
} from "./core.mjs";

const POLICY_PATH = path.join(pluginRoot(), "config", "task-worktree-v1.json");
const GIT = "/usr/bin/git";
const GIT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const SHA1 = /^[a-f0-9]{40}$/;
const REPOSITORY_ID = /^[a-f0-9]{16}$/;
const TASK_ID = /^[a-z0-9][a-z0-9-]{5,63}$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{|\\|[~^:?*[\x00-\x20\x7f]))(?!.*\/$)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]+$/;
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
  for (const record of records) {
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
  for (const record of records) {
    if (record.startsWith("? ")) {
      state.untracked.push(record.slice(2));
      continue;
    }
    if (record.startsWith("u ")) {
      state.conflicts.push(record);
      continue;
    }
    if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const xy = record.split(" ", 3)[1] ?? "..";
      if (xy[0] !== ".") state.staged.push(record);
      if (xy[1] !== ".") state.unstaged.push(record);
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
  return lease;
}

export async function readWorkspaceLease({ stateRoot, repositoryId, taskId }) {
  return readLeaseAt(stateRoot, leasePath(stateRoot, repositoryId, normalizeTaskId(taskId)));
}

async function findLeaseByWorktree(stateRoot, repositoryId, targetPath) {
  const directory = leaseDirectory(stateRoot, repositoryId);
  if (!(await exists(directory))) return null;
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).slice(0, 256);
  const canonicalTarget = await realpath(targetPath).catch(() => path.resolve(targetPath));
  for (const name of names) {
    const target = safeJoin(directory, name);
    const lease = await readLeaseAt(stateRoot, target);
    const leaseWorktree = await realpath(lease.taskWorktree).catch(() => path.resolve(lease.taskWorktree));
    if (leaseWorktree === canonicalTarget && lease.lifecycleState !== "cleaned") return lease;
  }
  return null;
}

async function branchSuggestions(cwd, baseRevision, profileTarget = null) {
  const suggestions = [];
  const add = (branch, reason) => {
    if (!branch || !BRANCH.test(branch) || suggestions.some((item) => item.branch === branch)) return;
    suggestions.push({ branch, reason });
  };
  if (profileTarget && await resolveLocalBranch(cwd, profileTarget)) add(profileTarget, "repository-profile");
  if (await resolveLocalBranch(cwd, "dev")) add("dev", "feature-development-convention");
  const upstream = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allowFailure: true });
  if (upstream.ok) {
    const value = oneLine(upstream.stdout, "Upstream branch");
    add(value.startsWith("origin/") ? value.slice("origin/".length) : value, "current-upstream");
  }
  const containing = await git(cwd, ["for-each-ref", "--contains", baseRevision, "--format=%(refname:short)", "refs/heads"]);
  for (const branch of containing.stdout.split("\n").filter(Boolean).sort()) add(branch, "contains-base-revision");
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

async function withRepositoryLock(stateRoot, repositoryId, callback) {
  const directory = safeJoin(stateRoot, "workspace-locks");
  await ensurePrivateDir(directory);
  const target = safeJoin(directory, `${repositoryId}.lock`);
  const handle = await open(target, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") throw new Error("Repository workspace lock is already held");
    throw error;
  });
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: nowIso() })}\n`);
    await handle.sync();
    return await callback();
  } finally {
    await handle.close();
    await unlink(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
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
    validation: null,
    integration: null,
    cleanup: null,
    leaseDigest: null
  };
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
  const normalizedTaskId = normalizeTaskId(taskId);
  const preflight = await workspacePreflight({
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
  const policy = await loadTaskWorktreePolicy();
  const target = leasePath(stateRoot, preflight.repository.repositoryId, normalizedTaskId);
  if (await exists(target)) {
    const existing = await readLeaseAt(stateRoot, target);
    if (existing.lifecycleState !== "cleaned") {
      return { ok: false, status: "ownership-conflict", lease: existing, preflight };
    }
    throw new Error("Task id was already used by a cleaned lease; generate a new task id");
  }
  let lease = baseLease({ taskId: normalizedTaskId, goal, preflight, stateRoot });
  lease.policyDigest = digestObject(policy);
  lease = await writeLease(stateRoot, target, lease);
  return withRepositoryLock(stateRoot, preflight.repository.repositoryId, async () => {
    const branchExisting = await resolveLocalBranch(cwd, lease.taskBranch);
    if (branchExisting || await exists(lease.taskWorktree)) {
      lease = await setBlocked(stateRoot, target, lease, "ownership-conflict", "task branch or worktree path already exists");
      return { ok: false, status: "ownership-conflict", lease, preflight };
    }
    lease = await writeLease(stateRoot, target, { ...lease, lifecycleState: "target-bound" });
    await git(cwd, ["branch", "--no-track", lease.taskBranch, lease.baseRevision]);
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
      await git(cwd, ["worktree", "add", lease.taskWorktree, lease.taskBranch]);
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
    return { ok: true, status: "isolated", lease, preflight };
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
    if (!Array.isArray(check.argv) || check.argv.length === 0 || check.argv.length > 64 || check.argv.some((item) => typeof item !== "string" || item.includes("\0"))) {
      throw new Error(`checks[${index}].argv is invalid`);
    }
    if (!policy.directCheck.allowedExecutables.includes(check.argv[0])) {
      throw new Error(`checks[${index}] executable is not allowed by task-worktree-v1`);
    }
    return { name: check.name.trim(), argv: [...check.argv] };
  });
}

async function resolveExecutable(command, env = process.env) {
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

async function runChecks(cwd, checks, policy) {
  const started = Date.now();
  const results = [];
  for (const check of checks) {
    const elapsed = Date.now() - started;
    const remaining = policy.directCheck.timeoutMs - elapsed;
    if (remaining <= 0) {
      return { ok: false, results, failure: "targeted-check-plan-timeout" };
    }
    const executable = await resolveExecutable(check.argv[0]);
    try {
      const result = await execBoundProcess(executable, check.argv.slice(1), {
        cwd,
        env: {
          PATH: process.env.PATH ?? GIT_PATH,
          HOME: "/var/empty",
          LANG: "C",
          LC_ALL: "C",
          CI: "1",
          NO_COLOR: "1",
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
        stdoutDigest: sha256(stdout),
        stderrDigest: sha256(stderr),
        outputBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr)
      });
    } catch (error) {
      results.push({
        name: check.name,
        argv: check.argv,
        result: "FAIL",
        error: String(error.message).slice(0, 1024)
      });
      return { ok: false, results, failure: "targeted-check-failed" };
    }
  }
  return { ok: true, results, durationMs: Date.now() - started };
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
  const state = await worktreeState(lease.taskWorktree);
  const head = await headRevision(lease.taskWorktree);
  const branch = await currentBranch(lease.taskWorktree);
  if (!state.clean || branch !== lease.taskBranch) {
    lease = await setBlocked(stateRoot, target, lease, "validation-failed", "task worktree must be clean and checked out on the owned task branch");
    return { ok: false, status: "validation-failed", lease, state };
  }
  const paths = await changedPaths(lease.taskWorktree, lease.baseRevision, head);
  const run = await runChecks(lease.taskWorktree, plan, policy);
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

async function removeOwnedCandidate(cwd, lease, expectedHead) {
  const worktree = lease.resources.integrationWorktree;
  const branch = lease.resources.integrationBranch;
  if (worktree && await exists(worktree.path)) {
    const state = await worktreeState(worktree.path);
    if (!state.clean) throw new Error("Run-owned integration worktree is dirty; preserving it");
    await git(cwd, ["worktree", "remove", worktree.path]);
  }
  if (branch) {
    const current = await resolveLocalBranch(cwd, branch.name);
    if (current !== null) {
      if (current !== expectedHead) throw new Error("Run-owned integration branch drifted; preserving it");
      await git(cwd, ["update-ref", "-d", branchRef(branch.name), expectedHead]);
    }
  }
}

async function targetWorktree(cwd, targetBranch) {
  return (await worktreeList(cwd)).find((record) => record.branch === branchRef(targetBranch)) ?? null;
}

async function updateTarget({ cwd, targetBranch, expectedOld, candidateHead, candidateBranch, stateRoot, repositoryId, taskId }) {
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
  const result = await git(checkoutPath, ["merge", "--ff-only", candidateBranch], { allowFailure: true });
  if (!result.ok) return { ok: false, reason: result.stderr };
  if (await headRevision(checkoutPath) !== candidateHead) {
    return { ok: false, reason: "target-checkout-did-not-reach-candidate-head" };
  }
  return { ok: true, method: "clean-checkout-ff", checkout: checkoutPath };
}

export async function workspaceIntegrate({
  stateRoot,
  repositoryId,
  taskId,
  beforeTargetUpdate = null
}) {
  const target = leasePath(stateRoot, repositoryId, normalizeTaskId(taskId));
  let lease = await readLeaseAt(stateRoot, target);
  if (lease.lifecycleState !== "integration-ready" || lease.blockedState !== null || !lease.validation) {
    throw new Error("Workspace integration requires an unblocked integration-ready lease");
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
    for (let attempt = 0; attempt <= policy.integration.casRetries; attempt += 1) {
      const targetRevision = await resolveLocalBranch(lease.sourceCheckout, lease.integrationTarget);
      if (!targetRevision) {
        lease = await setBlocked(stateRoot, target, lease, "target-missing", "integration target no longer resolves");
        return { ok: false, status: "target-missing", lease };
      }
      const candidateBranch = `codex/integrate-${lease.taskId.slice(-20)}-${attempt + 1}`;
      let candidatePath = safeJoin(stateRoot, "integration-worktrees", repositoryId, `${lease.taskId}-${attempt + 1}`);
      if (await resolveLocalBranch(lease.sourceCheckout, candidateBranch) || await exists(candidatePath)) {
        lease = await setBlocked(stateRoot, target, lease, "ownership-conflict", "integration candidate resource already exists");
        return { ok: false, status: "ownership-conflict", lease };
      }
      await git(lease.sourceCheckout, ["branch", "--no-track", candidateBranch, targetRevision]);
      await ensurePrivateDir(path.dirname(candidatePath));
      await git(lease.sourceCheckout, ["worktree", "add", candidatePath, candidateBranch]);
      candidatePath = await realpath(candidatePath);
      lease = await writeLease(stateRoot, target, {
        ...lease,
        resources: {
          ...lease.resources,
          integrationBranch: { name: candidateBranch, createdFrom: targetRevision, head: targetRevision },
          integrationWorktree: { path: candidatePath, head: targetRevision }
        }
      });
      const ff = await isAncestor(candidatePath, targetRevision, taskHead);
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
      const candidateHead = await headRevision(candidatePath);
      const candidateState = await worktreeState(candidatePath);
      if (!candidateState.clean || !(await isAncestor(candidatePath, taskHead, candidateHead))) {
        lease = await setBlocked(stateRoot, target, lease, "unknown-integration", "candidate does not cleanly contain the validated task head");
        return { ok: false, status: "unknown-integration", lease };
      }
      const checks = lease.validation.checks.map((check) => ({ name: check.name, argv: check.argv }));
      const validation = await runChecks(candidatePath, checks, policy);
      if (!validation.ok) {
        lease = await setBlocked(stateRoot, target, lease, "validation-failed", validation);
        return { ok: false, status: "validation-failed", lease, validation };
      }
      lease = await writeLease(stateRoot, target, {
        ...lease,
        resources: {
          ...lease.resources,
          integrationBranch: { ...lease.resources.integrationBranch, head: candidateHead },
          integrationWorktree: { ...lease.resources.integrationWorktree, head: candidateHead }
        }
      });
      if (beforeTargetUpdate !== null) {
        if (typeof beforeTargetUpdate !== "function") throw new Error("beforeTargetUpdate must be a function");
        await beforeTargetUpdate({
          attempt: attempt + 1,
          targetRevision,
          candidateHead,
          lease
        });
      }
      const updated = await updateTarget({
        cwd: lease.sourceCheckout,
        targetBranch: lease.integrationTarget,
        expectedOld: targetRevision,
        candidateHead,
        candidateBranch,
        stateRoot,
        repositoryId,
        taskId: lease.taskId
      });
      if (!updated.ok) {
        if (attempt < policy.integration.casRetries) {
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
      const finalTarget = await resolveLocalBranch(lease.sourceCheckout, lease.integrationTarget);
      if (finalTarget !== candidateHead) {
        lease = await setBlocked(stateRoot, target, lease, "unknown-integration", "target reconciliation did not match the candidate head");
        return { ok: false, status: "unknown-integration", lease };
      }
      const integration = {
        schemaVersion: 1,
        method: updated.method,
        attempt: attempt + 1,
        targetOldRevision: targetRevision,
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

export async function workspaceCleanup({ stateRoot, repositoryId, taskId }) {
  const target = leasePath(stateRoot, repositoryId, normalizeTaskId(taskId));
  let lease = await readLeaseAt(stateRoot, target);
  if (lease.blockedState !== null) throw new Error(`Cleanup is blocked by ${lease.blockedState}`);
  if (lease.lifecycleState !== "integrated" && !(lease.lifecycleState === "integration-ready" && lease.validation?.noOp === true)) {
    throw new Error("Cleanup requires terminal integration success or a validated no-op");
  }
  if (lease.protectedTarget && lease.lifecycleState !== "integrated") {
    throw new Error("Protected delivery cannot be cleaned before an exact provider merge receipt is reconciled");
  }
  const cwd = await realpath(process.cwd());
  const taskPath = await realpath(lease.taskWorktree).catch(() => path.resolve(lease.taskWorktree));
  if (cwd === taskPath || cwd.startsWith(`${taskPath}${path.sep}`)) {
    throw new Error("Run cleanup from outside the task worktree so Git can remove it safely");
  }
  return withRepositoryLock(stateRoot, repositoryId, async () => {
    const taskState = await worktreeState(lease.taskWorktree);
    const taskHead = await headRevision(lease.taskWorktree);
    if (!taskState.clean || taskHead !== lease.validation.head) {
      throw new Error("Task worktree is dirty or drifted; preserving task resources");
    }
    const integratedTargetHead = lease.validation.noOp
      ? lease.targetRevisionAtBind
      : lease.integration?.finalTargetRevision;
    const currentTargetHead = await resolveLocalBranch(lease.sourceCheckout, lease.integrationTarget);
    if (
      !integratedTargetHead ||
      !currentTargetHead ||
      !(await isAncestor(lease.sourceCheckout, integratedTargetHead, currentTargetHead)) ||
      !(await isAncestor(lease.sourceCheckout, taskHead, currentTargetHead))
    ) {
      throw new Error("Integration target does not contain the exact task head; preserving task resources");
    }
    lease = await writeLease(stateRoot, target, { ...lease, lifecycleState: "cleanup-ready" });
    if (lease.resources.integrationWorktree || lease.resources.integrationBranch) {
      await removeOwnedCandidate(lease.sourceCheckout, lease, lease.integration.candidateHead);
      lease = await writeLease(stateRoot, target, {
        ...lease,
        resources: { ...lease.resources, integrationBranch: null, integrationWorktree: null }
      });
    }
    await git(lease.sourceCheckout, ["worktree", "remove", lease.taskWorktree]);
    const taskRefHead = await resolveLocalBranch(lease.sourceCheckout, lease.taskBranch);
    if (taskRefHead !== taskHead) throw new Error("Task branch drifted during cleanup; preserving its ref");
    await git(lease.sourceCheckout, ["update-ref", "-d", branchRef(lease.taskBranch), taskHead]);
    const cleanupPayload = {
      schemaVersion: 1,
      kind: "WorkspaceCleanupReceiptV1",
      taskId: lease.taskId,
      repositoryDigest: lease.repository.repositoryDigest,
      integrationTarget: lease.integrationTarget,
      finalTargetRevision: currentTargetHead,
      removed: {
        taskBranch: lease.taskBranch,
        taskWorktree: lease.taskWorktree,
        integrationBranch: lease.integration?.candidateBranch ?? null,
        integrationWorktree: lease.integration?.candidateWorktree ?? null
      },
      cleanedAt: nowIso()
    };
    const cleanup = { ...cleanupPayload, receiptDigest: digestObject(cleanupPayload) };
    const cleanupPath = safeJoin(stateRoot, "workspace-cleanup", repositoryId, `${lease.taskId}.json`);
    await atomicWriteJson(stateRoot, cleanupPath, cleanup);
    lease = await writeLease(stateRoot, target, {
      ...lease,
      lifecycleState: "cleaned",
      cleanup: { ...cleanup, path: cleanupPath },
      resources: {
        taskBranch: null,
        taskWorktree: null,
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
    integrationTargetRevision: lease.integrationTarget ? await resolveLocalBranch(lease.sourceCheckout, lease.integrationTarget) : null
  };
  return { ok: lease.blockedState === null, lease, resources };
}

export function directCompletionNotice({ targetBranch, checks, integrated, cleaned }) {
  if (!integrated || !cleaned) throw new Error("Direct completion notice requires terminal integration and cleanup");
  if (!targetBranch || !Array.isArray(checks) || checks.length === 0) {
    throw new Error("Direct completion notice requires the target branch and actual checks");
  }
  return [
    "本次工作經 Auto 評估為範圍明確、可回復的低風險修改，因此採用 Direct 路徑，未啟用完整的 Better Workflows 證據工作流。",
    `Git 隔離狀態：已在本任務專屬 worktree 完成，安全整合至 ${targetBranch}，並且只清理本任務擁有的 branch 與 worktree。`,
    `已完成的基本檢查：${checks.join("、")}。`,
    "本次成果已通過上述基本檢查，但不等同於完整、可重播的證據驗證。如需升級驗證強度，請回覆「補做證據驗證」，Better Workflows 將至少改走 Verified 路徑。"
  ].join("\n\n");
}
