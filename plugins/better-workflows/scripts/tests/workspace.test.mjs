import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  directCompletionNotice,
  isProtectedBranch,
  workspaceCleanup,
  workspaceCreate,
  workspaceIntegrate,
  workspacePreflight,
  workspaceReconcileProtected,
  workspaceRegister,
  workspaceRebindTarget,
  workspaceStatus,
  workspaceValidate
} from "../lib/workspace.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function repository({ branch = "feature", prefix = "sbw-workspace-repo-" } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  await git(cwd, "init", "-q", "-b", branch);
  await git(cwd, "config", "user.name", "Better Workflows Tests");
  await git(cwd, "config", "user.email", "workspace-tests@example.invalid");
  await writeFile(path.join(cwd, "app.txt"), "base\n");
  await git(cwd, "add", "app.txt");
  await git(cwd, "commit", "-qm", "base");
  return cwd;
}

async function commitFile(cwd, file, contents, message) {
  await writeFile(path.join(cwd, file), contents);
  await git(cwd, "add", file);
  await git(cwd, "commit", "-qm", message);
  return (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
}

function passingChecks() {
  return [
    {
      name: "targeted node check",
      argv: ["node", "-e", "process.exit(0)"]
    }
  ];
}

test("workspace preflight does not create Git resources for non-repositories or read-only work", async () => {
  const nonGit = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-non-git-"));
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const absent = await workspacePreflight({ cwd: nonGit, stateRoot, intent: "modify" });
  assert.equal(absent.ok, true);
  assert.equal(absent.status, "not-a-git-repository");
  assert.equal(absent.workspaceLifecycle, "not-applicable");

  const cwd = await repository();
  const before = (await git(cwd, "worktree", "list", "--porcelain")).stdout;
  const readOnly = await workspacePreflight({ cwd, stateRoot, intent: "read-only" });
  const after = (await git(cwd, "worktree", "list", "--porcelain")).stdout;
  assert.equal(readOnly.status, "read-only");
  assert.equal(readOnly.workspaceLifecycle, "read-only");
  assert.equal(after, before);
});

test("dirty source and detached HEAD fail closed before branch or worktree creation", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  await writeFile(path.join(cwd, "dirty.txt"), "untracked\n");
  const dirty = await workspaceCreate({
    cwd,
    stateRoot,
    goal: "Change app",
    taskId: "task-dirty-source"
  });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.status, "dirty-source");
  await assert.rejects(git(cwd, "rev-parse", "--verify", "refs/heads/codex/change-app-source"));

  const renamedRepo = await repository();
  await git(renamedRepo, "mv", "app.txt", "renamed.txt");
  const renamed = await workspacePreflight({
    cwd: renamedRepo,
    stateRoot,
    intent: "modify"
  });
  assert.equal(renamed.ok, false);
  assert.equal(renamed.status, "dirty-source");
  assert.equal(renamed.sourceState.staged.length, 1);

  const detachedRepo = await repository();
  await git(detachedRepo, "checkout", "--detach", "-q");
  const detached = await workspacePreflight({
    cwd: detachedRepo,
    stateRoot,
    intent: "modify"
  });
  assert.equal(detached.ok, false);
  assert.equal(detached.status, "target-missing");
  assert.ok(detached.suggestions.some((item) => item.branch === "feature"));
});

test("mutation lifecycle isolates, reuses by owner, validates, integrates with CAS, and cleans exact resources", async () => {
  const cwd = await repository({ prefix: "sbw workspace repo with spaces-" });
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw workspace state with spaces-"));
  const created = await workspaceCreate({
    cwd,
    stateRoot,
    goal: "Update app label",
    taskId: "task-happy-path"
  });
  assert.equal(created.ok, true);
  assert.equal(created.status, "isolated");
  assert.equal(created.lease.sourceBranch, "feature");
  assert.equal(created.lease.integrationTarget, "feature");
  assert.equal(created.lease.lifecycleState, "isolated");
  assert.equal(await realpath(created.lease.taskWorktree), created.lease.taskWorktree);

  const sourceResume = await workspaceCreate({
    cwd,
    stateRoot,
    goal: "Update app label",
    taskId: "task-happy-path"
  });
  assert.equal(sourceResume.ok, true);
  assert.equal(sourceResume.status, "reused");
  assert.equal(sourceResume.lease.ownershipNonce, created.lease.ownershipNonce);

  const reused = await workspacePreflight({
    cwd: created.lease.taskWorktree,
    stateRoot,
    intent: "modify",
    taskId: "task-happy-path"
  });
  assert.equal(reused.status, "task-worktree-reused");
  const conflict = await workspacePreflight({
    cwd: created.lease.taskWorktree,
    stateRoot,
    intent: "modify",
    taskId: "task-other-owner"
  });
  assert.equal(conflict.status, "ownership-conflict");

  const taskHead = await commitFile(created.lease.taskWorktree, "app.txt", "task\n", "task change");
  const validated = await workspaceValidate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId,
    checks: passingChecks()
  });
  assert.equal(validated.ok, true);
  assert.equal(validated.status, "integration-ready");
  assert.deepEqual(validated.validation.changedPaths, ["app.txt"]);
  assert.equal(validated.validation.head, taskHead);

  const integrated = await workspaceIntegrate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId
  });
  assert.equal(integrated.ok, true);
  assert.equal(integrated.integration.method, "clean-checkout-ff");
  assert.equal((await readFile(path.join(cwd, "app.txt"), "utf8")), "task\n");

  const cleaned = await workspaceCleanup({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId
  });
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.lease.lifecycleState, "cleaned");
  await assert.rejects(realpath(created.lease.taskWorktree));
  await assert.rejects(git(cwd, "rev-parse", "--verify", `refs/heads/${created.lease.taskBranch}`));
  const status = await workspaceStatus({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId
  });
  assert.equal(status.resources.taskWorktreeExists, false);
  assert.equal(status.resources.taskBranchRevision, null);
});

test("a verified host-provided task worktree is registered without nesting and remains host-owned after cleanup", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const hostRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-host-worktree-"));
  const taskWorktree = path.join(hostRoot, "task");
  const baseRevision = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
  const taskBranch = "codex/host-provided-task";
  await git(cwd, "worktree", "add", "-q", "-b", taskBranch, taskWorktree, baseRevision);
  const before = (await git(cwd, "worktree", "list", "--porcelain")).stdout;

  const registered = await workspaceRegister({
    cwd: taskWorktree,
    stateRoot,
    taskId: "task-host-provided",
    baseRevision,
    integrationTarget: "feature",
    sourceCheckout: cwd
  });
  assert.equal(registered.ok, true);
  assert.equal(registered.status, "registered");
  assert.equal(registered.lease.resourceOrigin, "host-provided");
  assert.equal(registered.lease.registration.resourceDisposition, "preserve-host-provided");
  assert.equal((await git(cwd, "worktree", "list", "--porcelain")).stdout, before);

  const reused = await workspacePreflight({
    cwd: taskWorktree,
    stateRoot,
    intent: "modify",
    taskId: "task-host-provided"
  });
  assert.equal(reused.status, "task-worktree-reused");
  const conflict = await workspacePreflight({
    cwd: taskWorktree,
    stateRoot,
    intent: "modify",
    taskId: "task-another-host"
  });
  assert.equal(conflict.status, "ownership-conflict");

  const taskHead = await commitFile(taskWorktree, "host.txt", "host task\n", "host task change");
  await workspaceValidate({
    stateRoot,
    repositoryId: registered.lease.repository.repositoryId,
    taskId: registered.lease.taskId,
    checks: passingChecks()
  });
  const integrated = await workspaceIntegrate({
    stateRoot,
    repositoryId: registered.lease.repository.repositoryId,
    taskId: registered.lease.taskId
  });
  assert.equal(integrated.ok, true);
  assert.equal((await git(cwd, "rev-parse", "HEAD")).stdout.trim(), taskHead);
  const cleaned = await workspaceCleanup({
    stateRoot,
    repositoryId: registered.lease.repository.repositoryId,
    taskId: registered.lease.taskId
  });
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.cleanup.removed.taskBranch, null);
  assert.equal(cleaned.cleanup.removed.taskWorktree, null);
  assert.equal(cleaned.cleanup.preserved.taskBranch, taskBranch);
  assert.equal(await realpath(taskWorktree), registered.lease.taskWorktree);
  assert.equal((await git(cwd, "rev-parse", "--verify", `refs/heads/${taskBranch}`)).stdout.trim(), taskHead);
  const status = await workspaceStatus({
    stateRoot,
    repositoryId: registered.lease.repository.repositoryId,
    taskId: registered.lease.taskId
  });
  assert.equal(status.resources.taskWorktreeExists, true);
  assert.equal(status.resources.cleanupDisposition, "preserve-host-provided");
});

test("advanced local target is merged in a candidate, revalidated, then fast-forwarded", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const created = await workspaceCreate({
    cwd,
    stateRoot,
    goal: "Add task file",
    taskId: "task-target-advanced"
  });
  await commitFile(created.lease.taskWorktree, "task.txt", "task\n", "task branch");
  await commitFile(cwd, "target.txt", "target\n", "target advanced");
  await workspaceValidate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId,
    checks: passingChecks()
  });
  const integrated = await workspaceIntegrate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId
  });
  assert.equal(integrated.ok, true);
  assert.equal(integrated.integration.method, "clean-checkout-ff");
  assert.equal(await readFile(path.join(cwd, "task.txt"), "utf8"), "task\n");
  assert.equal(await readFile(path.join(cwd, "target.txt"), "utf8"), "target\n");
  assert.equal((await git(cwd, "rev-list", "--parents", "-n", "1", "HEAD")).stdout.trim().split(" ").length, 3);
});

test("protected targets stop at PR ready and never authorize cleanup", async () => {
  const cwd = await repository({ branch: "dev" });
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const created = await workspaceCreate({
    cwd,
    stateRoot,
    goal: "Protected change",
    taskId: "task-protected-target"
  });
  assert.equal(created.lease.protectedTarget, true);
  await commitFile(created.lease.taskWorktree, "protected.txt", "change\n", "protected task");
  await workspaceValidate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId,
    checks: passingChecks()
  });
  const integration = await workspaceIntegrate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId
  });
  assert.equal(integration.status, "pr-required");
  assert.equal(integration.cleanupAllowed, false);
  await assert.rejects(
    workspaceCleanup({
      stateRoot,
      repositoryId: created.lease.repository.repositoryId,
      taskId: created.lease.taskId
    }),
    /terminal integration success|Protected delivery/
  );
});

test("protected squash cleanup requires exact governed merge and remote-sync receipts", async () => {
  const cwd = await repository({ branch: "dev" });
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const baseRevision = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
  const created = await workspaceCreate({
    cwd,
    stateRoot,
    goal: "Protected squash change",
    taskId: "task-protected-squash"
  });
  const taskHead = await commitFile(created.lease.taskWorktree, "squash.txt", "squashed task\n", "task commit");
  await workspaceValidate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId,
    checks: passingChecks()
  });
  await writeFile(path.join(cwd, "squash.txt"), "squashed task\n");
  await git(cwd, "add", "squash.txt");
  await git(cwd, "commit", "-qm", "provider squash result");
  const mergeCommit = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
  assert.equal(await git(cwd, "merge-base", "--is-ancestor", taskHead, mergeCommit).then(() => true, () => false), false);

  const runId = "sbw-20260827T000000Z-123456789abc";
  const repositoryName = "github.com/example/repository";
  const providerExecutable = { path: "/usr/bin/false", digest: "e".repeat(64) };
  const mergeAttemptId = "merge-attempt-squash";
  const mergeCommand = [
    "gh", "pr", "merge", "44", "--repo", repositoryName,
    "--match-head-commit", taskHead, "--squash", "--delete-branch=false"
  ];
  const invocationId = `github-pr-merge-wrapper:${runId}:${mergeAttemptId}`;
  const mergeProviderReceipt = {
    action: "pr.merge",
    provider: "github-cli",
    resource: "pull/44",
    outcome: "success",
    runId,
    attemptId: mergeAttemptId,
    idempotencyKey: "merge-squash-idempotency",
    remoteRevision: baseRevision,
    executionId: `github:example/repository:pr.merge:44:${mergeCommit}`,
    proofKind: "github-pr-merge",
    requestDigest: "1".repeat(64),
    responseDigest: "2".repeat(64),
    verifiedAt: new Date().toISOString(),
    terminalState: "success",
    pr: 44,
    state: "MERGED",
    repository: repositoryName,
    baseRefName: "dev",
    mergeMethod: "squash",
    adminBypass: false,
    invocationId,
    mergeCommand,
    head: taskHead,
    mergeCommit,
    mergeBase: baseRevision,
    mergeHead: taskHead,
    providerExecutableDigest: providerExecutable.digest
  };
  const mergeAction = {
    schemaVersion: 1,
    status: "spent",
    outcome: "success",
    runId,
    action: "pr.merge",
    provider: "github-cli",
    resource: "pull/44",
    remoteRevision: baseRevision,
    reviewedHead: taskHead,
    targetRef: "dev",
    pullRequest: 44,
    mergeRepository: repositoryName,
    mergeMethod: "squash",
    adminBypass: false,
    attemptId: mergeAttemptId,
    idempotencyKey: "merge-squash-idempotency",
    providerExecutable,
    providerInvocation: { id: invocationId },
    mergeCommand,
    receipt: {
      action: "pr.merge",
      provider: "github-cli",
      resource: "pull/44",
      outcome: "success",
      runId,
      attemptId: mergeAttemptId,
      idempotencyKey: "merge-squash-idempotency",
      remoteRevision: baseRevision,
      providerReceipt: mergeProviderReceipt
    }
  };
  const syncAttemptId = "sync-attempt-squash";
  const syncRecord = {
    schemaVersion: 1,
    status: "spent",
    outcome: "success",
    runId,
    action: "remote.sync",
    provider: "git",
    resource: "refs/heads/dev",
    remoteRevision: baseRevision,
    reviewedHead: taskHead,
    pullRequest: 44,
    mergeCommit,
    attemptId: syncAttemptId,
    idempotencyKey: "sync-squash-idempotency",
    remote: "origin",
    remoteRepository: repositoryName,
    remoteUrlDigest: "3".repeat(64),
    sourceBindingDigest: "4".repeat(64),
    sourceRemoteBindingDigest: "5".repeat(64)
  };
  const syncProviderReceipt = {
    action: "remote.sync",
    provider: "git",
    resource: "refs/heads/dev",
    outcome: "success",
    runId,
    attemptId: syncAttemptId,
    idempotencyKey: syncRecord.idempotencyKey,
    remoteRevision: baseRevision,
    executionId: `git:example/repository:remote.sync:refs/heads/dev:${mergeCommit}`,
    proofKind: "git-remote-sync",
    requestDigest: "6".repeat(64),
    responseDigest: "7".repeat(64),
    verifiedAt: new Date().toISOString(),
    terminalState: "success",
    ref: "refs/heads/dev",
    remote: "origin",
    repository: created.lease.repository.commonDirectory,
    remoteRepository: repositoryName,
    remoteUrlDigest: syncRecord.remoteUrlDigest,
    sourceBindingDigest: syncRecord.sourceBindingDigest,
    sourceRemoteBindingDigest: syncRecord.sourceRemoteBindingDigest,
    providerRevision: mergeCommit,
    localRevision: mergeCommit
  };
  syncRecord.receipt = {
    action: "remote.sync",
    provider: "git",
    resource: "refs/heads/dev",
    outcome: "success",
    runId,
    attemptId: syncAttemptId,
    idempotencyKey: syncRecord.idempotencyKey,
    remoteRevision: baseRevision,
    providerReceipt: syncProviderReceipt
  };

  await assert.rejects(
    workspaceReconcileProtected({
      stateRoot,
      repositoryId: created.lease.repository.repositoryId,
      taskId: created.lease.taskId,
      runId,
      inspect: async () => ({
        manifest: { cwd: created.lease.taskWorktree, sourceBinding: { headRevision: taskHead } },
        actions: [
          {
            ...mergeAction,
            receipt: {
              ...mergeAction.receipt,
              providerReceipt: { ...mergeProviderReceipt, mergeHead: baseRevision }
            }
          },
          syncRecord
        ]
      })
    }),
    /exactly one matching successful governed action/
  );

  const reconciled = await workspaceReconcileProtected({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId,
    runId,
    inspect: async () => ({
      manifest: {
        cwd: created.lease.taskWorktree,
        sourceBinding: { headRevision: taskHead }
      },
      actions: [mergeAction, syncRecord]
    })
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.integration.method, "governed-pr-squash");
  assert.equal(reconciled.integration.mergeCommit, mergeCommit);

  const cleaned = await workspaceCleanup({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId
  });
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.cleanup.finalTargetRevision, mergeCommit);
  await assert.rejects(realpath(created.lease.taskWorktree));
  await assert.rejects(git(cwd, "rev-parse", "--verify", `refs/heads/${created.lease.taskBranch}`));
});

test("merge conflict, dirty validation, and dirty cleanup preserve owned resources", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const created = await workspaceCreate({
    cwd,
    stateRoot,
    goal: "Conflicting change",
    taskId: "task-merge-conflict"
  });
  await commitFile(created.lease.taskWorktree, "app.txt", "task version\n", "task conflict");
  await commitFile(cwd, "app.txt", "target version\n", "target conflict");
  await workspaceValidate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId,
    checks: passingChecks()
  });
  const conflicted = await workspaceIntegrate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId
  });
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.status, "merge-conflict");
  assert.equal(await realpath(created.lease.taskWorktree), created.lease.taskWorktree);
  assert.equal((await git(cwd, "rev-parse", "--verify", `refs/heads/${created.lease.taskBranch}`)).stdout.trim().length, 40);

  const dirtyRepo = await repository();
  const dirtyState = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const dirtyCreated = await workspaceCreate({
    cwd: dirtyRepo,
    stateRoot: dirtyState,
    goal: "Dirty task",
    taskId: "task-dirty-validate"
  });
  await writeFile(path.join(dirtyCreated.lease.taskWorktree, "untracked.txt"), "dirty\n");
  const dirtyValidation = await workspaceValidate({
    stateRoot: dirtyState,
    repositoryId: dirtyCreated.lease.repository.repositoryId,
    taskId: dirtyCreated.lease.taskId,
    checks: passingChecks()
  });
  assert.equal(dirtyValidation.status, "validation-failed");
  assert.equal(await realpath(dirtyCreated.lease.taskWorktree), dirtyCreated.lease.taskWorktree);

  const cleanupRepo = await repository();
  const cleanupState = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const cleanupCreated = await workspaceCreate({
    cwd: cleanupRepo,
    stateRoot: cleanupState,
    goal: "Dirty cleanup",
    taskId: "task-dirty-cleanup"
  });
  await commitFile(cleanupCreated.lease.taskWorktree, "cleanup.txt", "task\n", "cleanup task");
  await workspaceValidate({
    stateRoot: cleanupState,
    repositoryId: cleanupCreated.lease.repository.repositoryId,
    taskId: cleanupCreated.lease.taskId,
    checks: passingChecks()
  });
  await workspaceIntegrate({
    stateRoot: cleanupState,
    repositoryId: cleanupCreated.lease.repository.repositoryId,
    taskId: cleanupCreated.lease.taskId
  });
  await writeFile(path.join(cleanupCreated.lease.taskWorktree, "late-untracked.txt"), "preserve me\n");
  await assert.rejects(
    workspaceCleanup({
      stateRoot: cleanupState,
      repositoryId: cleanupCreated.lease.repository.repositoryId,
      taskId: cleanupCreated.lease.taskId
    }),
    /dirty or drifted/
  );
  assert.equal(await realpath(cleanupCreated.lease.taskWorktree), cleanupCreated.lease.taskWorktree);
});

test("validated no-op removes only its owned branch and worktree", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const created = await workspaceCreate({
    cwd,
    stateRoot,
    goal: "No operation",
    taskId: "task-no-op-cleanup"
  });
  await git(cwd, "branch", "unrelated-worktree");
  const unrelatedPath = await mkdtemp(path.join(os.tmpdir(), "sbw-unrelated-parent-"));
  const unrelatedWorktree = path.join(unrelatedPath, "checkout");
  await git(cwd, "worktree", "add", unrelatedWorktree, "unrelated-worktree");
  const unrelatedCanonical = await realpath(unrelatedWorktree);
  const validated = await workspaceValidate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId,
    checks: passingChecks()
  });
  assert.equal(validated.status, "no-op");
  const cleaned = await workspaceCleanup({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId
  });
  assert.equal(cleaned.status, "cleaned");
  assert.equal(cleaned.cleanup.finalTargetRevision, created.lease.baseRevision);
  assert.equal(await realpath(unrelatedWorktree), unrelatedCanonical);
  assert.match((await git(cwd, "rev-parse", "--verify", "refs/heads/unrelated-worktree")).stdout, /^[a-f0-9]{40}\n$/);
});

test("deleted or renamed integration targets require an explicit rebind", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const created = await workspaceCreate({
    cwd,
    stateRoot,
    goal: "Rebind target",
    taskId: "task-target-rebind"
  });
  await commitFile(created.lease.taskWorktree, "rebind.txt", "task\n", "task change");
  await git(cwd, "branch", "-m", "feature-next");
  await workspaceValidate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId,
    checks: passingChecks()
  });
  const missing = await workspaceIntegrate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId
  });
  assert.equal(missing.status, "target-missing");
  const rebound = await workspaceRebindTarget({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId,
    integrationTarget: "feature-next"
  });
  assert.equal(rebound.lease.integrationTarget, "feature-next");
  assert.equal(rebound.lease.targetRebindings.length, 1);
  const integrated = await workspaceIntegrate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId
  });
  assert.equal(integrated.status, "integrated");
});

test("target moving during both CAS attempts stops with target-drift and preserves the second candidate", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const created = await workspaceCreate({
    cwd,
    stateRoot,
    goal: "CAS drift",
    taskId: "task-cas-drift"
  });
  await commitFile(created.lease.taskWorktree, "task.txt", "task\n", "task change");
  await workspaceValidate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId,
    checks: passingChecks()
  });
  const drifted = await workspaceIntegrate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId,
    beforeTargetUpdate: async ({ attempt }) => {
      await commitFile(cwd, `drift-${attempt}.txt`, `drift ${attempt}\n`, `target drift ${attempt}`);
    }
  });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.status, "target-drift");
  assert.equal(drifted.lease.blockedState, "target-drift");
  assert.ok(drifted.lease.resources.integrationBranch);
  assert.equal(await realpath(drifted.lease.resources.integrationWorktree.path), drifted.lease.resources.integrationWorktree.path);
  assert.equal(await realpath(created.lease.taskWorktree), created.lease.taskWorktree);
});

test("a dirty target checkout blocks integration and preserves the validated task", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const created = await workspaceCreate({
    cwd,
    stateRoot,
    goal: "Dirty target guard",
    taskId: "task-dirty-target"
  });
  await commitFile(created.lease.taskWorktree, "task.txt", "task\n", "task change");
  await workspaceValidate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId,
    checks: passingChecks()
  });
  await writeFile(path.join(cwd, "target-untracked.txt"), "do not overwrite\n");
  const integrated = await workspaceIntegrate({
    stateRoot,
    repositoryId: created.lease.repository.repositoryId,
    taskId: created.lease.taskId
  });
  assert.equal(integrated.ok, false);
  assert.equal(integrated.status, "target-drift");
  assert.equal(await realpath(created.lease.taskWorktree), created.lease.taskWorktree);
  assert.equal(await readFile(path.join(cwd, "target-untracked.txt"), "utf8"), "do not overwrite\n");
});

test("branch collisions and task-owned subdirectories never overwrite or share resources", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const first = await workspaceCreate({
    cwd,
    stateRoot,
    goal: "Collision task",
    taskId: "task-alpha-12345678"
  });
  assert.equal(first.ok, true);
  await mkdir(path.join(first.lease.taskWorktree, "src"));
  const reused = await workspacePreflight({
    cwd: path.join(first.lease.taskWorktree, "src"),
    stateRoot,
    intent: "modify",
    taskId: first.lease.taskId
  });
  assert.equal(reused.status, "task-worktree-reused");
  const collision = await workspaceCreate({
    cwd,
    stateRoot,
    goal: "Collision task",
    taskId: "task-beta-12345678"
  });
  assert.equal(collision.ok, false);
  assert.equal(collision.status, "ownership-conflict");
  assert.equal(collision.lease.taskBranch, first.lease.taskBranch);
  assert.notEqual(collision.lease.taskWorktree, first.lease.taskWorktree);
  assert.equal(await realpath(first.lease.taskWorktree), first.lease.taskWorktree);
});

test("nested repositories have independent identities and branch policy is explicit", async () => {
  const parent = await repository();
  const child = path.join(parent, "nested");
  await mkdir(child);
  await git(child, "init", "-q", "-b", "feature");
  await git(child, "config", "user.name", "Better Workflows Tests");
  await git(child, "config", "user.email", "workspace-tests@example.invalid");
  await writeFile(path.join(child, "child.txt"), "child\n");
  await git(child, "add", "child.txt");
  await git(child, "commit", "-qm", "child");
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const parentPreflight = await workspacePreflight({ cwd: parent, stateRoot, intent: "read-only" });
  const childPreflight = await workspacePreflight({ cwd: child, stateRoot, intent: "read-only" });
  assert.notEqual(parentPreflight.repository.repositoryId, childPreflight.repository.repositoryId);
  assert.equal(isProtectedBranch("main"), true);
  assert.equal(isProtectedBranch("release/4.0"), true);
  assert.equal(isProtectedBranch("feature"), false);
});

test("repository discovery canonicalizes symlinks and dirty submodules fail closed", async () => {
  const cwd = await repository();
  const linkParent = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-link-"));
  const linked = path.join(linkParent, "repository-link");
  await symlink(cwd, linked, "dir");
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-workspace-state-"));
  const linkedPreflight = await workspacePreflight({ cwd: linked, stateRoot, intent: "read-only" });
  assert.equal(linkedPreflight.repository.topLevel, await realpath(cwd));

  const child = await repository({ prefix: "sbw-submodule-source-" });
  await git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "vendor/child");
  await git(cwd, "commit", "-qm", "add submodule");
  await writeFile(path.join(cwd, "vendor", "child", "app.txt"), "dirty submodule\n");
  const dirty = await workspacePreflight({ cwd, stateRoot, intent: "modify" });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.status, "dirty-source");
  assert.ok(dirty.sourceState.dirtySubmodules.length > 0 || dirty.sourceState.unstaged.length > 0);
});

test("Direct completion notice is impossible before both integration and cleanup", () => {
  assert.throws(
    () => directCompletionNotice({ targetBranch: "feature", checks: ["node test"], integrated: true, cleaned: false }),
    /terminal integration and cleanup/
  );
  const notice = directCompletionNotice({
    targetBranch: "feature",
    checks: ["node test"],
    integrated: true,
    cleaned: true
  });
  assert.match(notice, /不等同於完整、可重播的證據驗證/);
  assert.match(notice, /補做證據驗證/);
  const hostNotice = directCompletionNotice({
    targetBranch: "feature",
    checks: ["node test"],
    integrated: true,
    cleaned: true,
    cleanupDisposition: "preserve-host-provided"
  });
  assert.match(hostNotice, /host ownership 保留/);
  assert.doesNotMatch(hostNotice, /清理本任務擁有的 branch/);
});
