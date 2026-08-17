import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  cp,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  addEvidence,
  autonomousCommitAllocation,
  assertCurrentGitPushSourceBinding,
  assertProviderReceiptShape,
  buildBoundGitPushArgs,
  buildBoundGitPushEnvironment,
  buildActionsDispatchCommand,
  buildActionsDispatchProviderReceipt,
  BOUND_CREDENTIAL_WORKSPACE_ROOT,
  buildGitPushActionBinding,
  buildPrCreateCommand,
  buildContract,
  captureAutonomyReadinessSnapshot,
  cleanupRuns,
  consumeActionToken,
  completeRun,
  createRun,
  creationReservationKey,
  digestObject,
  execBoundGitProcess,
  execBoundGitHubCli,
  terminateBoundChildForTest,
  ensureStateRoot,
  executeActionToken,
  evaluateCompletion,
  getCodexPluginCacheRoot,
  getStateRoot,
  githubDispatchRefEndpoint,
  inspectRun,
  issueActionToken,
  loadDefaults,
  readBoundGitHubApi,
  readBoundGitHubCredential,
  assertBoundCredentialWorkspace,
  optionalBoundGitAuthorityOutput,
  readJson,
  registerOwnedResource,
  reconcileAction,
  resumeActionsDispatchObservation,
  resolveGitFetchOrigin,
  resolveGitPushDestination,
  resolveGitPushExecutionBinding,
  resolveOptionalBoundBranchRevision,
  routeMode,
  safeJoin,
  sha256,
  setRunStatus,
  updateState,
  verifyRequiredChecksProvider,
  verifyGitHubCredentialActor,
  validateWorkflowDispatchCapability,
  workflowDispatchObservationRef,
  workflowDispatchMinimumCreatedAt,
  withRunLock,
  withBoundGitCredential
} from "../lib/core.mjs";
import { captureSentinel } from "../lib/git.mjs";
import { buildAutonomyBinding, loadAutonomyProfile } from "../lib/autonomy.mjs";
import { checkPluginCache, publishPluginCache, verifyPluginCacheReady } from "../lib/publication.mjs";

const execFileAsync = promisify(execFile);
const SBW_CLI = fileURLToPath(new URL("../sbw.mjs", import.meta.url));

test("GitHub Actions dispatch ref endpoints encode slash-containing refs as one path parameter", () => {
  assert.equal(
    githubDispatchRefEndpoint("github.com/example/repo", "release/3.4"),
    "repos/example/repo/commits/release%2F3.4"
  );
  assert.equal(
    githubDispatchRefEndpoint("github.com/example/repo", "refs/tags/v3.4.0"),
    "repos/example/repo/commits/refs%2Ftags%2Fv3.4.0"
  );
  assert.equal(workflowDispatchObservationRef("refs/heads/dev"), "dev");
  assert.equal(workflowDispatchObservationRef("refs/tags/v3.4.0"), "v3.4.0");
  assert.equal(workflowDispatchObservationRef("release/3.4"), "release/3.4");
});

test("branch ref authority accepts only exact absence and strict commit output", async () => {
  const absent = {
    ok: false,
    stdout: "",
    stderr: "",
    code: 1,
    signal: null,
    timedOut: false,
    outputExceeded: false
  };
  assert.equal(optionalBoundGitAuthorityOutput(absent, "branch ref"), null);
  assert.equal(await resolveOptionalBoundBranchRevision(async () => absent, "refs/heads/missing"), null);
  for (const failure of [
    { ...absent, timedOut: true },
    { ...absent, outputExceeded: true },
    { ...absent, signal: "SIGTERM" },
    { ...absent, code: 128 }
  ]) {
    assert.throws(() => optionalBoundGitAuthorityOutput(failure, "branch ref"), /branch ref failed/);
    await assert.rejects(
      resolveOptionalBoundBranchRevision(async () => failure, "refs/heads/indeterminate"),
      /Git branch ref lookup failed/
    );
  }
  await assert.rejects(
    resolveOptionalBoundBranchRevision(async () => ({ ok: true, stdout: "unexpected\n", stderr: "" }), "refs/heads/noisy"),
    /malformed success output/
  );
  const revision = "a".repeat(40);
  let call = 0;
  assert.equal(await resolveOptionalBoundBranchRevision(async (args) => {
    call += 1;
    if (call === 1) {
      assert.deepEqual(args, ["show-ref", "--verify", "--quiet", "refs/heads/present"]);
      return { ok: true, stdout: "", stderr: "" };
    }
    assert.deepEqual(args, ["rev-parse", "--verify", "refs/heads/present^{commit}"]);
    return { ok: true, stdout: `${revision}\n`, stderr: "" };
  }, "refs/heads/present"), revision);
  for (const stdout of ["", revision, `${revision}\n${revision}\n`, `${"g".repeat(40)}\n`]) {
    let attempt = 0;
    await assert.rejects(
      resolveOptionalBoundBranchRevision(async () => {
        attempt += 1;
        return attempt === 1
          ? { ok: true, stdout: "", stderr: "" }
          : { ok: true, stdout, stderr: "" };
      }, "refs/heads/malformed"),
      /malformed commit revision/
    );
  }
});

test("CLI rejects workflow-only options before issuing non-dispatch actions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-action-option-"));
  const repository = path.join(root, "repository");
  const stateRoot = path.join(root, "state");
  try {
    await mkdir(repository, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "dev"], { cwd: repository });
    await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
    await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
    await writeFile(path.join(repository, "README.md"), "cli option guard\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repository });
    await execFileAsync("git", ["commit", "-qm", "cli option guard baseline"], { cwd: repository });
    const sourceHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" })).stdout.trim();
    const started = JSON.parse((await execFileAsync(process.execPath, [
      SBW_CLI, "run", "--template", "review-to-issues", "--mode", "verified", "--goal", "Review source", "--scope", "."
    ], { cwd: repository, encoding: "utf8", env: { ...process.env, SBW_STATE_ROOT: stateRoot } })).stdout);
    const inputFile = path.join(root, "inputs.json");
    await writeFile(inputFile, JSON.stringify({ example: "value" }));
    for (const option of [
      ["--workflow-file", ".github/workflows/ci.yml"],
      ["--input", "example=value"],
      ["--input-file", inputFile]
    ]) {
      await assert.rejects(
        execFileAsync(process.execPath, [
          SBW_CLI, "action", "issue", started.runId,
          "--action", "git.commit", "--provider", "git", "--resource", "fixture", "--remote-revision", sourceHead,
          ...option
        ], {
          cwd: repository,
          encoding: "utf8",
          env: { ...process.env, SBW_STATE_ROOT: stateRoot }
        }),
        (error) => {
          assert.match(error.stderr ?? "", /only valid for actions\.dispatch/);
          return true;
        }
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded process teardown refuses a recycled PGID when the stable leader is gone", () => {
  const pid = 424243;
  const calls = [];
  const probe = (target, signal) => {
    calls.push([target, signal]);
    if (target === pid) {
      const error = new Error("leader is gone");
      error.code = "ESRCH";
      throw error;
    }
    return undefined;
  };
  assert.equal(terminateBoundChildForTest(pid, "SIGTERM", probe), false);
  assert.deepEqual(calls, [[pid, 0]]);
});

function template() {
  return {
    requiredEvidence: ["preflight"],
    acceptance: [
      { id: "done", description: "The task is proven complete.", critical: true }
    ]
  };
}

function contract(overrides = {}) {
  const value = buildContract({
    template: "test",
    templateDefinition: template(),
    goal: "Test the workflow",
    scope: ["."],
    risk: { risk: 1, uncertainty: 1, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: ["deploy"],
    remoteRevision: "abc",
    ...overrides
  });
  return value;
}

async function autonomyActionFixture({
  remoteUrl = "https://github.com/example/repository.git",
  repositoryIdentity = "github.com/example/repository"
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-autonomy-action-"));
  const repository = path.join(root, "repository");
  const stateRoot = path.join(root, "state");
  await mkdir(path.join(repository, "allowed"), { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "codex/autonomy"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "autonomy@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Autonomy Test"], { cwd: repository });
  await execFileAsync("git", ["remote", "add", "origin", remoteUrl], { cwd: repository });
  await writeFile(path.join(repository, "allowed", "tracked.txt"), "baseline\n");
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: repository });
  const sourceHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" })).stdout.trim();
  const profile = await loadAutonomyProfile();
  const binding = buildAutonomyBinding(profile, {
    repository: repositoryIdentity,
    branch: "codex/autonomy",
    pathScope: ["allowed"]
  });
  const taskContract = buildContract({
    template: "pr-to-dev",
    templateDefinition: {
      requiredEvidence: ["preflight"],
      acceptance: [{ id: "done", description: "Autonomy action is bounded.", critical: true }]
    },
    goal: "Bound autonomous commits",
    scope: ["allowed"],
    remoteRevision: sourceHead,
    autonomyProfile: binding
  });
  const run = await createRun({ root: stateRoot, contract: taskContract, requestedMode: "critical", cwd: repository });
  await addEvidence(stateRoot, run.runId, {
    id: "preflight",
    kind: "preflight",
    summary: "Autonomy action fixture preflight",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: "e".repeat(64)
  });
  const inspected = await inspectRun(stateRoot, run.runId);
  const sentinelDigest = "f".repeat(64);
  const snapshot = await captureAutonomyReadinessSnapshot(
    repository,
    binding,
    inspected.manifest.autonomyProfile.sourceBindingDigest,
    { sentinelDigest }
  );
  await updateState(stateRoot, run.runId, (state) => ({
    ...state,
    lastSentinel: { label: "autonomy-test", digest: sentinelDigest },
    lastSentinelVerified: true,
    lastSentinelComplete: true,
    autonomy: { ...state.autonomy, status: "ready", blockedReason: null, snapshot }
  }));
  return { root, repository, stateRoot, run, binding, profile, sourceHead, sentinelDigest };
}

function autonomyCommitRequest(sourceHead, suffix) {
  return {
    action: "git.commit",
    provider: "git",
    resource: `commit:${suffix}`,
    remoteRevision: sourceHead,
    requiredEvidence: ["preflight"]
  };
}

async function autonomyCommitSuccessReceipt(fixture, spent, revision, evidenceId) {
  const commonDirectory = (await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
    cwd: fixture.repository,
    encoding: "utf8"
  })).stdout.trim();
  const repository = await realpath(
    path.isAbsolute(commonDirectory)
      ? commonDirectory
      : path.resolve(fixture.repository, commonDirectory)
  );
  const providerReceipt = {
    action: spent.action,
    provider: spent.provider,
    resource: spent.resource,
    outcome: "success",
    runId: spent.runId,
    attemptId: spent.attemptId,
    idempotencyKey: spent.idempotencyKey,
    remoteRevision: spent.remoteRevision,
    executionId: `git:${repository}:git.commit:${revision}`,
    proofKind: "git-commit",
    requestDigest: digestObject({
      action: spent.action,
      provider: spent.provider,
      resource: spent.resource,
      remoteRevision: spent.remoteRevision,
      repository
    }),
    responseDigest: digestObject({ repository, revision }),
    verifiedAt: new Date().toISOString(),
    terminalState: "success",
    created: true,
    revision
  };
  await addEvidence(fixture.stateRoot, fixture.run.runId, {
    id: evidenceId,
    kind: "preflight",
    summary: "Autonomous Git commit provider proof",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: sha256(evidenceId),
    receipt: {
      payload: {
        actionProof: {
          schemaVersion: 1,
          runId: spent.runId,
          actionAttemptId: spent.attemptId,
          action: spent.action,
          provider: spent.provider,
          resource: spent.resource,
          outcome: "success",
          idempotencyKey: spent.idempotencyKey,
          remoteRevision: spent.remoteRevision,
          providerExecutionId: providerReceipt.executionId,
          providerReceiptDigest: digestObject(providerReceipt)
        },
        receipt: providerReceipt
      }
    }
  });
  return {
    action: spent.action,
    provider: spent.provider,
    resource: spent.resource,
    outcome: "success",
    runId: spent.runId,
    attemptId: spent.attemptId,
    idempotencyKey: spent.idempotencyKey,
    remoteRevision: spent.remoteRevision,
    providerReceipt,
    evidenceIds: [evidenceId]
  };
}

test("autonomy action issuance and consumption revalidate the exact readiness snapshot", async () => {
  const fixture = await autonomyActionFixture();
  const defaults = await loadDefaults();
  const issued = await issueActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    autonomyCommitRequest(fixture.sourceHead, "first"),
    fixture.sentinelDigest,
    defaults
  );
  await execFileAsync("git", ["switch", "-qc", "dev"], { cwd: fixture.repository });
  await assert.rejects(
    consumeActionToken(fixture.stateRoot, fixture.run.runId, issued.token, fixture.sentinelDigest),
    /named codex\/\* branch/
  );
  await execFileAsync("git", ["switch", "-q", "codex/autonomy"], { cwd: fixture.repository });
  await writeFile(path.join(fixture.repository, "outside.txt"), "outside\n");
  await assert.rejects(
    issueActionToken(
      fixture.stateRoot,
      fixture.run.runId,
      autonomyCommitRequest(fixture.sourceHead, "outside"),
      fixture.sentinelDigest,
      defaults
    ),
    /path-outside-autonomy-scope/
  );
  await unlink(path.join(fixture.repository, "outside.txt"));
  await writeFile(
    path.join(fixture.repository, "allowed", "tracked.txt"),
    "x".repeat(fixture.profile.limits.maxDiffBytes + 4096)
  );
  await assert.rejects(
    issueActionToken(
      fixture.stateRoot,
      fixture.run.runId,
      autonomyCommitRequest(fixture.sourceHead, "oversized"),
      fixture.sentinelDigest,
      defaults
    ),
    /diff-byte-limit/
  );
});

test("autonomy commit issuance rejects legacy graft metadata after preflight", async () => {
  const fixture = await autonomyActionFixture();
  await writeFile(
    path.join(fixture.repository, ".git", "info", "grafts"),
    "# repository-local ancestry rewriting is forbidden\n"
  );
  await assert.rejects(
    issueActionToken(
      fixture.stateRoot,
      fixture.run.runId,
      autonomyCommitRequest(fixture.sourceHead, "grafted"),
      fixture.sentinelDigest,
      await loadDefaults()
    ),
    /Legacy Git graft ancestry metadata is not allowed/
  );
  assert.deepEqual((await inspectRun(fixture.stateRoot, fixture.run.runId)).actions, []);
});

test("autonomy commit issuance rejects oversized core.worktree authority output", async () => {
  const fixture = await autonomyActionFixture();
  const redirected = await mkdtemp(path.join(os.tmpdir(), "sbw-autonomy-core-worktree-target-"));
  const configPath = path.join(fixture.repository, ".git", "config");
  const config = await readFile(configPath, "utf8");
  const oversized = Array.from(
    { length: 4_200 },
    (_, index) => `\tworktree = ${"w".repeat(1_024)}${index}\n`
  ).join("");
  await writeFile(configPath, `${config}\n[core]\n${oversized}\tworktree = ${redirected}\n`);
  await assert.rejects(
    issueActionToken(
      fixture.stateRoot,
      fixture.run.runId,
      autonomyCommitRequest(fixture.sourceHead, "core-worktree-overflow"),
      fixture.sentinelDigest,
      await loadDefaults()
    ),
    /output exceeded/
  );
  assert.deepEqual((await inspectRun(fixture.stateRoot, fixture.run.runId)).actions, []);
});

test("autonomy snapshot pins its worktree across a transient core.worktree swap", async () => {
  const fixture = await autonomyActionFixture();
  const redirected = await mkdtemp(path.join(os.tmpdir(), "sbw-autonomy-core-worktree-swap-"));
  await mkdir(path.join(redirected, "allowed"), { recursive: true });
  await writeFile(path.join(redirected, "allowed", "tracked.txt"), "redirected bytes\n");
  const configPath = path.join(fixture.repository, ".git", "config");
  const originalConfig = await readFile(configPath, "utf8");
  const inspected = await inspectRun(fixture.stateRoot, fixture.run.runId);
  try {
    const snapshot = await captureAutonomyReadinessSnapshot(
      fixture.repository,
      fixture.binding,
      inspected.manifest.autonomyProfile.sourceBindingDigest,
      {
        sentinelDigest: fixture.sentinelDigest,
        beforeFinalCheck: () => writeFile(
          configPath,
          `${originalConfig}\n[core]\n\tworktree = ${redirected}\n`
        ),
        afterFinalCheck: () => writeFile(configPath, originalConfig)
      }
    );
    assert.equal(snapshot.headRevision, fixture.sourceHead);
    assert.equal(snapshot.changedFiles, 0);
  } finally {
    await writeFile(configPath, originalConfig);
  }
});

test("autonomy maxCommits counts immutable ancestry and outstanding tokens", async () => {
  const fixture = await autonomyActionFixture();
  for (let index = 0; index < fixture.profile.limits.maxCommits - 1; index += 1) {
    await execFileAsync("git", ["commit", "--allow-empty", "-qm", `autonomous-${index + 1}`], { cwd: fixture.repository });
  }
  const inspected = await inspectRun(fixture.stateRoot, fixture.run.runId);
  const snapshot = await captureAutonomyReadinessSnapshot(
    fixture.repository,
    fixture.binding,
    inspected.manifest.autonomyProfile.sourceBindingDigest,
    { sentinelDigest: fixture.sentinelDigest }
  );
  const ancestryOnly = await autonomousCommitAllocation(inspected.manifest, [], snapshot);
  assert.deepEqual(ancestryOnly, {
    ancestryCount: fixture.profile.limits.maxCommits - 1,
    outstanding: 0,
    allocated: fixture.profile.limits.maxCommits - 1
  });
  const withOutstanding = await autonomousCommitAllocation(inspected.manifest, [{
    action: "git.commit",
    status: "issued",
    autonomyDecision: { decision: "auto-approved" }
  }], snapshot);
  assert.deepEqual(withOutstanding, {
    ancestryCount: fixture.profile.limits.maxCommits - 1,
    outstanding: 1,
    allocated: fixture.profile.limits.maxCommits
  });
});

test("autonomy commit allocation reads raw parents instead of forged legacy graft ancestry", async () => {
  const fixture = await autonomyActionFixture();
  await execFileAsync("git", ["commit", "--allow-empty", "-qm", "first real commit"], {
    cwd: fixture.repository
  });
  await execFileAsync("git", ["commit", "--allow-empty", "-qm", "second real commit"], {
    cwd: fixture.repository
  });
  const forgedHead = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: fixture.repository,
    encoding: "utf8"
  })).stdout.trim();
  const inspected = await inspectRun(fixture.stateRoot, fixture.run.runId);
  const snapshot = await captureAutonomyReadinessSnapshot(
    fixture.repository,
    fixture.binding,
    inspected.manifest.autonomyProfile.sourceBindingDigest,
    { sentinelDigest: fixture.sentinelDigest }
  );
  await writeFile(
    path.join(fixture.repository, ".git", "info", "grafts"),
    `${forgedHead} ${fixture.sourceHead}\n`
  );
  const legacyCount = (await execFileAsync("git", [
    "--no-replace-objects", "rev-list", "--count", `${fixture.sourceHead}..${forgedHead}`
  ], { cwd: fixture.repository, encoding: "utf8" })).stdout.trim();
  assert.equal(legacyCount, "1");

  const allocation = await autonomousCommitAllocation(inspected.manifest, [], snapshot);
  assert.equal(allocation.ancestryCount, 2);
  assert.equal(allocation.allocated, 2);
});

test("autonomy commit issuance rejects a readiness head that advanced outside the operational source binding", async () => {
  const fixture = await autonomyActionFixture();
  await execFileAsync("git", ["commit", "--allow-empty", "-qm", "ungoverned commit"], {
    cwd: fixture.repository
  });
  const inspected = await inspectRun(fixture.stateRoot, fixture.run.runId);
  const advancedSnapshot = await captureAutonomyReadinessSnapshot(
    fixture.repository,
    fixture.binding,
    inspected.manifest.autonomyProfile.sourceBindingDigest,
    { sentinelDigest: fixture.sentinelDigest }
  );
  assert.notEqual(advancedSnapshot.headRevision, inspected.manifest.sourceBinding.headRevision);
  await updateState(fixture.stateRoot, fixture.run.runId, (state) => ({
    ...state,
    autonomy: { ...state.autonomy, status: "ready", snapshot: advancedSnapshot }
  }));

  await assert.rejects(
    issueActionToken(
      fixture.stateRoot,
      fixture.run.runId,
      autonomyCommitRequest(fixture.sourceHead, "after-ungoverned"),
      fixture.sentinelDigest,
      await loadDefaults()
    ),
    /readiness snapshot to match the operational source binding/
  );
  assert.deepEqual((await inspectRun(fixture.stateRoot, fixture.run.runId)).actions, []);
});

test("autonomy reconciliation rejects two commits created under one consumed token", async () => {
  const fixture = await autonomyActionFixture();
  const issued = await issueActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    { ...autonomyCommitRequest(fixture.sourceHead, "unused"), resource: "git:commit" },
    fixture.sentinelDigest,
    await loadDefaults()
  );
  const spent = await consumeActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    issued.token,
    fixture.sentinelDigest
  );
  await execFileAsync("git", ["commit", "--allow-empty", "-qm", "first autonomous commit"], {
    cwd: fixture.repository
  });
  await execFileAsync("git", ["commit", "--allow-empty", "-qm", "second autonomous commit"], {
    cwd: fixture.repository
  });
  const revision = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: fixture.repository,
    encoding: "utf8"
  })).stdout.trim();
  await writeFile(
    path.join(fixture.repository, ".git", "info", "grafts"),
    `${revision} ${fixture.sourceHead}\n`
  );
  const forgedCount = (await execFileAsync("git", [
    "--no-replace-objects", "rev-list", "--count", `${fixture.sourceHead}..${revision}`
  ], { cwd: fixture.repository, encoding: "utf8" })).stdout.trim();
  assert.equal(forgedCount, "1");
  const receipt = await autonomyCommitSuccessReceipt(fixture, spent, revision, "commit-proof-two-for-one");
  await assert.rejects(
    reconcileAction(fixture.stateRoot, fixture.run.runId, spent.attemptId, "success", receipt),
    /Legacy Git graft ancestry metadata is not allowed|exactly one commit per consumed token/
  );
  const inspected = await inspectRun(fixture.stateRoot, fixture.run.runId);
  assert.equal(inspected.manifest.sourceBinding.headRevision, fixture.sourceHead);
  assert.equal(inspected.state.autonomy.status, "ready");
});

test("autonomy reconciliation rejects an executable-bit change after consuming an untracked file snapshot", async () => {
  const fixture = await autonomyActionFixture();
  const created = path.join(fixture.repository, "allowed", "created.sh");
  await writeFile(created, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  await chmod(created, 0o644);
  await execFileAsync("git", ["config", "core.filemode", "true"], { cwd: fixture.repository });
  const inspected = await inspectRun(fixture.stateRoot, fixture.run.runId);
  const approvedSnapshot = await captureAutonomyReadinessSnapshot(
    fixture.repository,
    fixture.binding,
    inspected.manifest.autonomyProfile.sourceBindingDigest,
    { sentinelDigest: fixture.sentinelDigest }
  );
  assert.deepEqual(approvedSnapshot.untrackedManifest, [{
    path: "allowed/created.sh",
    type: "file",
    mode: "100644",
    bytes: 17,
    digest: sha256("#!/bin/sh\nexit 0\n")
  }]);
  await updateState(fixture.stateRoot, fixture.run.runId, (state) => ({
    ...state,
    autonomy: { ...state.autonomy, status: "ready", snapshot: approvedSnapshot }
  }));
  const issued = await issueActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    { ...autonomyCommitRequest(fixture.sourceHead, "untracked-mode"), resource: "git:commit" },
    fixture.sentinelDigest,
    await loadDefaults()
  );
  const spent = await consumeActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    issued.token,
    fixture.sentinelDigest
  );
  await chmod(created, 0o755);
  await execFileAsync("git", ["add", "allowed/created.sh"], { cwd: fixture.repository });
  await execFileAsync("git", ["commit", "-qm", "change untracked mode after approval"], { cwd: fixture.repository });
  const tree = (await execFileAsync("git", ["ls-tree", "HEAD", "--", "allowed/created.sh"], {
    cwd: fixture.repository,
    encoding: "utf8"
  })).stdout;
  assert.match(tree, /^100755 blob /);
  const revision = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: fixture.repository,
    encoding: "utf8"
  })).stdout.trim();
  const receipt = await autonomyCommitSuccessReceipt(fixture, spent, revision, "commit-proof-untracked-mode");
  await assert.rejects(
    reconcileAction(fixture.stateRoot, fixture.run.runId, spent.attemptId, "success", receipt),
    /changed the approved untracked path mode/
  );
  const after = await inspectRun(fixture.stateRoot, fixture.run.runId);
  assert.equal(after.manifest.sourceBinding.headRevision, fixture.sourceHead);
});

test("autonomy reconciliation preserves both sides of a tracked rename", async () => {
  const fixture = await autonomyActionFixture();
  await execFileAsync("git", ["mv", "allowed/tracked.txt", "allowed/renamed.txt"], { cwd: fixture.repository });
  const inspected = await inspectRun(fixture.stateRoot, fixture.run.runId);
  const approvedSnapshot = await captureAutonomyReadinessSnapshot(
    fixture.repository,
    fixture.binding,
    inspected.manifest.autonomyProfile.sourceBindingDigest,
    { sentinelDigest: fixture.sentinelDigest }
  );
  assert.deepEqual(approvedSnapshot.changedPaths, ["allowed/renamed.txt", "allowed/tracked.txt"]);
  await updateState(fixture.stateRoot, fixture.run.runId, (state) => ({
    ...state,
    autonomy: { ...state.autonomy, status: "ready", snapshot: approvedSnapshot }
  }));
  const issued = await issueActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    { ...autonomyCommitRequest(fixture.sourceHead, "rename"), resource: "git:commit" },
    fixture.sentinelDigest,
    await loadDefaults()
  );
  const spent = await consumeActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    issued.token,
    fixture.sentinelDigest
  );
  await execFileAsync("git", ["commit", "-qm", "governed tracked rename"], { cwd: fixture.repository });
  const revision = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: fixture.repository,
    encoding: "utf8"
  })).stdout.trim();
  const receipt = await autonomyCommitSuccessReceipt(fixture, spent, revision, "commit-proof-rename");
  const reconciled = await reconcileAction(
    fixture.stateRoot,
    fixture.run.runId,
    spent.attemptId,
    "success",
    receipt
  );
  assert.equal(reconciled.sourceBindingTransition.headRevision, revision);
});

test("a reconciled autonomous commit rotates the operational binding and reopens the governed push source gate after fresh preflight", async () => {
  const fixture = await autonomyActionFixture();
  await execFileAsync("git", ["config", "diff.external", "/bin/echo"], { cwd: fixture.repository });
  await writeFile(path.join(fixture.repository, "allowed", "tracked.txt"), "approved autonomous change\n");
  await writeFile(path.join(fixture.repository, "allowed", "created.txt"), "approved autonomous file\n");
  const approvedSnapshot = await captureAutonomyReadinessSnapshot(
    fixture.repository,
    fixture.binding,
    (await inspectRun(fixture.stateRoot, fixture.run.runId)).manifest.autonomyProfile.sourceBindingDigest,
    { sentinelDigest: fixture.sentinelDigest }
  );
  assert.equal(approvedSnapshot.untrackedManifest.find((item) => item.path === "allowed/created.txt")?.mode, "100644");
  await updateState(fixture.stateRoot, fixture.run.runId, (state) => ({
    ...state,
    autonomy: { ...state.autonomy, status: "ready", snapshot: approvedSnapshot }
  }));
  const issued = await issueActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    { ...autonomyCommitRequest(fixture.sourceHead, "unused"), resource: "git:commit" },
    fixture.sentinelDigest,
    await loadDefaults()
  );
  const spent = await consumeActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    issued.token,
    fixture.sentinelDigest
  );
  await execFileAsync("git", ["add", "allowed/tracked.txt", "allowed/created.txt"], { cwd: fixture.repository });
  await execFileAsync("git", ["commit", "-qm", "governed autonomous commit"], {
    cwd: fixture.repository
  });
  const revision = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: fixture.repository,
    encoding: "utf8"
  })).stdout.trim();
  const receipt = await autonomyCommitSuccessReceipt(fixture, spent, revision, "commit-proof-transition");
  const reconciled = await reconcileAction(
    fixture.stateRoot,
    fixture.run.runId,
    spent.attemptId,
    "success",
    receipt
  );
  assert.equal(reconciled.sourceBindingTransition.headRevision, revision);

  let inspected = await inspectRun(fixture.stateRoot, fixture.run.runId);
  assert.equal(inspected.manifest.sourceBinding.headRevision, revision);
  assert.equal(inspected.manifest.autonomyProfile.sourceBindingDigest, inspected.manifest.sourceBinding.digest);
  assert.equal(inspected.manifest.autonomyProfile.sourceHeadRevision, fixture.sourceHead);
  assert.equal(inspected.state.status, "blocked");
  assert.equal(inspected.state.autonomy.status, "blocked");
  assert.equal(inspected.state.autonomy.blockedReason, "autonomous-commit-reconciled");
  assert.equal(inspected.state.lastSentinel, null);
  assert.ok(inspected.evidence.every((item) => item.stale === true));
  assert.ok(inspected.manifest.sourceBindingHistory.some((item) => (
    item.kind === "autonomous-commit" &&
    item.actionAttemptId === spent.attemptId &&
    item.headRevision === revision
  )));

  const freshSentinelDigest = "9".repeat(64);
  await addEvidence(fixture.stateRoot, fixture.run.runId, {
    id: "preflight-after-autonomous-commit",
    kind: "preflight",
    summary: "Fresh preflight after autonomous commit",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: "8".repeat(64)
  });
  const freshSnapshot = await captureAutonomyReadinessSnapshot(
    fixture.repository,
    fixture.binding,
    inspected.manifest.autonomyProfile.sourceBindingDigest,
    { sentinelDigest: freshSentinelDigest }
  );
  await updateState(fixture.stateRoot, fixture.run.runId, (state) => ({
    ...state,
    status: "running",
    lastSentinel: { label: "post-commit", digest: freshSentinelDigest },
    lastSentinelVerified: true,
    lastSentinelComplete: true,
    autonomy: {
      ...state.autonomy,
      status: "ready",
      blockedReason: null,
      requiredAuthority: null,
      resumeFromStage: null,
      snapshot: freshSnapshot
    }
  }));
  inspected = await inspectRun(fixture.stateRoot, fixture.run.runId);
  const pushSourceBinding = await assertCurrentGitPushSourceBinding(inspected.manifest);
  assert.equal(pushSourceBinding.digest, inspected.manifest.sourceBinding.digest);
  assert.equal(pushSourceBinding.headRevision, revision);
  assert.equal((await resolveGitPushDestination(fixture.repository, "origin")).remoteRepository, fixture.binding.repository);
});

test("live integration: fresh autonomy preflight issues the same run's governed push token after commit reconciliation", {
  skip: !process.env.SBW_LIVE_GITHUB_REPOSITORY
}, async () => {
  const repositoryIdentity = String(process.env.SBW_LIVE_GITHUB_REPOSITORY);
  assert.match(repositoryIdentity, /^github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
  const fixture = await autonomyActionFixture({
    repositoryIdentity,
    remoteUrl: `https://${repositoryIdentity}.git`
  });
  await writeFile(path.join(fixture.repository, "allowed", "tracked.txt"), "live governed transition\n");
  const approvedSnapshot = await captureAutonomyReadinessSnapshot(
    fixture.repository,
    fixture.binding,
    (await inspectRun(fixture.stateRoot, fixture.run.runId)).manifest.autonomyProfile.sourceBindingDigest,
    { sentinelDigest: fixture.sentinelDigest }
  );
  await updateState(fixture.stateRoot, fixture.run.runId, (state) => ({
    ...state,
    autonomy: { ...state.autonomy, status: "ready", snapshot: approvedSnapshot }
  }));
  const issuedCommit = await issueActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    { ...autonomyCommitRequest(fixture.sourceHead, "live-push"), resource: "git:commit" },
    fixture.sentinelDigest,
    await loadDefaults()
  );
  const spentCommit = await consumeActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    issuedCommit.token,
    fixture.sentinelDigest
  );
  await execFileAsync("git", ["add", "allowed/tracked.txt"], { cwd: fixture.repository });
  await execFileAsync("git", ["commit", "-qm", "live governed commit"], { cwd: fixture.repository });
  const revision = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: fixture.repository,
    encoding: "utf8"
  })).stdout.trim();
  const commitReceipt = await autonomyCommitSuccessReceipt(
    fixture,
    spentCommit,
    revision,
    "commit-proof-live-push"
  );
  await reconcileAction(fixture.stateRoot, fixture.run.runId, spentCommit.attemptId, "success", commitReceipt);

  const cliEnvironment = { ...process.env, SBW_STATE_ROOT: fixture.stateRoot };
  await execFileAsync(process.execPath, [SBW_CLI, "sentinel", "capture", fixture.run.runId, "--label", "post-commit"], {
    cwd: fixture.repository,
    env: cliEnvironment,
    encoding: "utf8"
  });
  await execFileAsync(process.execPath, [SBW_CLI, "autonomy", "preflight", fixture.run.runId], {
    cwd: fixture.repository,
    env: cliEnvironment,
    encoding: "utf8"
  });
  const actor = (await execFileAsync("gh", ["api", "user", "--jq", ".login"], {
    cwd: fixture.repository,
    encoding: "utf8"
  })).stdout.trim();
  await addEvidence(fixture.stateRoot, fixture.run.runId, {
    id: "post-commit-preflight",
    kind: "preflight",
    summary: "Fresh real autonomy preflight after governed commit",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: sha256("post-commit-preflight")
  });
  await addEvidence(fixture.stateRoot, fixture.run.runId, {
    id: "post-commit-current-branch",
    kind: "current-branch",
    summary: "Current codex branch at reconciled commit",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: sha256(`current-branch:${revision}`),
    receipt: { producer: "git", payload: { ref: "codex/autonomy", revision } }
  });
  const pushResource = "remote:origin:refs/heads/codex/autonomy";
  await addEvidence(fixture.stateRoot, fixture.run.runId, {
    id: "post-commit-remote-authorization",
    kind: "remote-authorization",
    summary: "Live GitHub actor and dry-run authorization",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: sha256(`remote-authorization:${actor}:${revision}`),
    receipt: {
      producer: "git",
      payload: {
        action: "git.push",
        provider: "git",
        resource: pushResource,
        remoteRevision: fixture.sourceHead,
        repository: repositoryIdentity,
        actor,
        remote: "origin",
        ref: "refs/heads/codex/autonomy",
        credentialCheck: "github-cli-token-actor"
      }
    }
  });
  const ready = await inspectRun(fixture.stateRoot, fixture.run.runId);
  const push = await issueActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    {
      action: "git.push",
      provider: "git",
      resource: pushResource,
      remoteRevision: fixture.sourceHead,
      requiredEvidence: ["preflight", "remote-authorization", "current-branch"]
    },
    ready.state.lastSentinel.digest,
    await loadDefaults()
  );
  assert.equal(push.status, "issued");
  assert.equal(push.expectedRevision, revision);
  assert.equal(push.sourceBindingDigest, ready.manifest.sourceBinding.digest);
  assert.equal(push.autonomyDecision.decision, "auto-approved");
});

test("autonomous commit reconciliation repairs every persisted transition boundary idempotently", async () => {
  const fixture = await autonomyActionFixture();
  await writeFile(path.join(fixture.repository, "allowed", "tracked.txt"), "crash-retry change\n");
  const approvedSnapshot = await captureAutonomyReadinessSnapshot(
    fixture.repository,
    fixture.binding,
    (await inspectRun(fixture.stateRoot, fixture.run.runId)).manifest.autonomyProfile.sourceBindingDigest,
    { sentinelDigest: fixture.sentinelDigest }
  );
  await updateState(fixture.stateRoot, fixture.run.runId, (state) => ({
    ...state,
    autonomy: { ...state.autonomy, status: "ready", snapshot: approvedSnapshot }
  }));
  const issued = await issueActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    { ...autonomyCommitRequest(fixture.sourceHead, "crash-retry"), resource: "git:commit" },
    fixture.sentinelDigest,
    await loadDefaults()
  );
  const spent = await consumeActionToken(
    fixture.stateRoot,
    fixture.run.runId,
    issued.token,
    fixture.sentinelDigest
  );
  await execFileAsync("git", ["add", "allowed/tracked.txt"], { cwd: fixture.repository });
  await execFileAsync("git", ["commit", "-qm", "governed crash-retry commit"], { cwd: fixture.repository });
  const revision = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: fixture.repository,
    encoding: "utf8"
  })).stdout.trim();
  const receipt = await autonomyCommitSuccessReceipt(fixture, spent, revision, "commit-proof-crash-retry");
  const baselineState = path.join(fixture.root, "state-before-reconcile");
  await cp(fixture.stateRoot, baselineState, { recursive: true });

  for (const failAfter of [
    "provider-reservation",
    "source-manifest",
    "source-state",
    "action-persistence",
    "evidence-invalidation"
  ]) {
    await rm(fixture.stateRoot, { recursive: true, force: true });
    await cp(baselineState, fixture.stateRoot, { recursive: true });
    await assert.rejects(
      reconcileAction(
        fixture.stateRoot,
        fixture.run.runId,
        spent.attemptId,
        "success",
        receipt,
        { failAfter }
      ),
      new RegExp(`Injected autonomous Git commit reconciliation failure after ${failAfter}`)
    );
    await reconcileAction(fixture.stateRoot, fixture.run.runId, spent.attemptId, "success", receipt);
    await reconcileAction(fixture.stateRoot, fixture.run.runId, spent.attemptId, "success", receipt);

    const inspected = await inspectRun(fixture.stateRoot, fixture.run.runId);
    assert.equal(inspected.manifest.autonomyProfile.sourceHeadRevision, fixture.sourceHead);
    assert.equal(inspected.manifest.sourceBinding.headRevision, revision);
    assert.equal(inspected.state.status, "blocked");
    assert.equal(inspected.state.autonomy.status, "blocked");
    assert.equal(inspected.state.autonomy.snapshot, null);
    assert.equal(inspected.state.lastSentinel, null);
    assert.ok(inspected.evidence.every((item) => item.status !== "complete" || item.stale === true));
    assert.equal(inspected.actions.length, 1);
    assert.equal(inspected.actions[0].outcome, "success");
    assert.equal(inspected.actions[0].sourceBindingTransition.headRevision, revision);
    assert.equal(inspected.manifest.sourceBindingHistory.filter((item) => (
      item.kind === "autonomous-commit" && item.actionAttemptId === spent.attemptId
    )).length, 1);
    assert.equal((await readdir(path.join(fixture.stateRoot, "provider-executions"))).length, 1);
    const journal = (await readFile(path.join(inspected.runDir, "journal.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(journal.filter((item) => (
      item.event === "source-binding.autonomous-commit" && item.attemptId === spent.attemptId
    )).length, 1);
    assert.equal(journal.filter((item) => (
      item.event === "action.autonomous-commit-transition-repaired" && item.attemptId === spent.attemptId
    )).length, 1);
  }
});

test("git push action bindings persist the exact effective destination used by the fixed argv wrapper", () => {
  const providerExecutable = { path: "/usr/bin/git", digest: "a".repeat(64) };
  const pushUrl = "https://github.com/example/repository.git";
  const sourceBindingDigest = "c".repeat(64);
  const sourceRemoteBindingDigest = "d".repeat(64);
  const binding = buildGitPushActionBinding({
    remote: "origin",
    pushUrl,
    remoteRepository: "github.com/example/repository",
    sourceBindingDigest,
    sourceRemoteBindingDigest,
    expectedBranch: "feature",
    expectedRevision: "b".repeat(40),
    providerExecutable
  });

  assert.equal(binding.remote, "origin");
  assert.equal(binding.pushUrl, pushUrl);
  assert.equal(binding.pushUrlDigest, sha256(pushUrl));
  assert.equal(binding.sourceBindingDigest, sourceBindingDigest);
  assert.equal(binding.sourceRemoteBindingDigest, sourceRemoteBindingDigest);
  assert.deepEqual(binding.pushCommand, [
    "git",
    "push",
    "--porcelain",
    pushUrl,
    `${"b".repeat(40)}:refs/heads/feature`
  ]);
  assert.deepEqual(
    resolveGitPushExecutionBinding({
      ...binding,
      resource: "remote:origin:refs/heads/feature"
    }),
    {
      remote: "origin",
      pushUrl,
      ref: "refs/heads/feature",
      command: binding.pushCommand
    }
  );
});

test("git push execution clears ambient helpers and binds one captured credential file", () => {
  assert.deepEqual(
    buildBoundGitPushArgs(
      ["git", "push", "--porcelain", "https://github.com/example/repository.git", "abc:refs/heads/feature"],
      "/private/tmp/sbw-bound-credential/credentials",
      "/usr/bin/git"
    ),
    [
      "--no-replace-objects",
      "-c", "core.bare=true",
      "-c", "protocol.allow=never",
      "-c", "protocol.https.allow=always",
      "-c", "http.followRedirects=false",
      "-c", "http.proxy=",
      "-c", "http.sslVerify=true",
      "-c", "credential.helper=",
      "-c", "credential.helper=!/usr/bin/git credential-store --file='/private/tmp/sbw-bound-credential/credentials'",
      "-c", "credential.useHttpPath=true",
      "-c", "credential.interactive=false",
      "-c", "core.askPass=/usr/bin/false",
      "-c", "core.hooksPath=/dev/null",
      "push", "--porcelain", "https://github.com/example/repository.git", "abc:refs/heads/feature"
    ]
  );
  assert.throws(
    () => buildBoundGitPushArgs(["git", "push", "origin"], "relative-credential-file"),
    /canonical command and credential file/
  );
  assert.ok(buildBoundGitPushArgs(
    ["git", "push", "origin"],
    "/private/tmp/sbw bound/credential'$(touch injected)",
    "/usr/bin/git"
  ).includes("credential.helper=!/usr/bin/git credential-store --file='/private/tmp/sbw bound/credential'\\''$(touch injected)'"));
  assert.deepEqual(
    buildBoundGitPushEnvironment({
      isolatedHome: "/private/tmp/sbw-bound-git",
      gitDirectory: "/private/tmp/sbw-bound-git/git-dir",
      objectDirectory: "/private/tmp/source.git/objects"
    }),
    {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/private/tmp/sbw-bound-git",
      XDG_CONFIG_HOME: "/private/tmp/sbw-bound-git",
      TMPDIR: "/private/tmp/sbw-bound-git",
      LC_ALL: "C",
      GIT_DIR: "/private/tmp/sbw-bound-git/git-dir",
      GIT_COMMON_DIR: "/private/tmp/sbw-bound-git/git-dir",
      GIT_OBJECT_DIRECTORY: "/private/tmp/sbw-bound-git/git-dir/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/private/tmp/source.git/objects",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_GRAFT_FILE: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_ASKPASS: "/usr/bin/false",
      SSH_ASKPASS: "/usr/bin/false",
      SSH_ASKPASS_REQUIRE: "never",
      GIT_TERMINAL_PROMPT: "0"
    }
  );
  assert.throws(
    () => buildBoundGitPushEnvironment({
      isolatedHome: "/private/tmp/sbw-bound-git",
      gitDirectory: "/private/tmp/sbw-bound-git/git-dir",
      objectDirectory: "relative/objects"
    }),
    /objectDirectory must be a canonical absolute path/
  );
});

test("GitHub credential acquisition invokes one explicit CLI and ignores ambient Git helpers and PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-bound-gh-credential-"));
  const fakeGh = path.join(root, "gh");
  const maliciousGit = path.join(root, "git");
  const marker = path.join(root, "malicious-git-ran");
  const token = ["ghp", "A".repeat(24)].join("_");
  await writeFile(fakeGh, `#!/bin/sh\n[ "$1" = auth ] && [ "$2" = token ] && [ "$3" = --hostname ] && [ "$4" = github.com ] || exit 9\nprintf '%s\\n' ${JSON.stringify(token)}\n`, { mode: 0o700 });
  await writeFile(maliciousGit, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o700 });
  const previous = {
    PATH: process.env.PATH,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
    GH_HOST: process.env.GH_HOST
  };
  process.env.PATH = root;
  process.env.GH_CONFIG_DIR = path.join(root, "malicious-gh-config");
  process.env.GH_HOST = "attacker.invalid";
  try {
    const credential = await readBoundGitHubCredential(await realpath(fakeGh), { homePath: await realpath(root) });
    assert.equal(credential.username, "x-access-token");
    assert.equal(credential.password, token);
    assert.equal(credential.source, "github-cli-auth-token");
    await assert.rejects(access(marker));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("bound Git credential staging uses a trusted root despite hostile TMPDIR and detects leaf substitution", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "sbw-bound-credential-source-"));
  await execFileAsync("git", ["init", "-q"], { cwd: source });
  await writeFile(path.join(source, "README.md"), "credential workspace\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: source });
  await execFileAsync("git", ["-c", "user.name=SBW", "-c", "user.email=sbw@example.invalid", "commit", "-qm", "fixture"], { cwd: source });
  const hostileRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-hostile-tmpdir-"));
  const hostileTarget = path.join(hostileRoot, "attacker-credential");
  await writeFile(hostileTarget, "https://attacker.invalid/\n", { mode: 0o600 });
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = hostileRoot;
  try {
    await withBoundGitCredential(
      source,
      "https://github.com/example/repository.git",
      { username: "x-access-token", password: "test-token" },
      "/usr/bin/git",
      async (context) => {
        assert.equal(path.dirname(context.isolatedHome), BOUND_CREDENTIAL_WORKSPACE_ROOT);
        const workspaceInfo = await lstat(context.isolatedHome);
        assert.equal(workspaceInfo.mode & 0o077, 0);
        await unlink(context.credentialFile);
        await symlink(hostileTarget, context.credentialFile);
        await assert.rejects(
          () => assertBoundCredentialWorkspace(context.isolatedHome, context.credentialFile),
          /unsafe/
        );
      }
    );
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  }
});

test("bound GitHub CLI execution terminates a hanging process group at the fixed deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-bound-gh-timeout-"));
  const hangingGh = path.join(root, "gh");
  await writeFile(hangingGh, "#!/bin/sh\nsleep 10\n", { mode: 0o700 });
  const executable = await realpath(hangingGh);
  await assert.rejects(
    () => execBoundGitHubCli(executable, ["api", "user"], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, LC_ALL: "C" },
      timeoutMs: 50
    }),
    (error) => error?.code === "ETIMEDOUT" && /50ms/.test(error.message)
  );
});

test("bound GitHub CLI environment drops ambient host, proxy, and Git authority overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-bound-gh-env-"));
  const previous = {
    GH_HOST: process.env.GH_HOST,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
    GIT_DIR: process.env.GIT_DIR,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED
  };
  process.env.GH_HOST = "attacker.invalid";
  process.env.GH_CONFIG_DIR = path.join(root, "attacker-config");
  process.env.GIT_DIR = path.join(root, "attacker-git");
  process.env.HTTPS_PROXY = "http://attacker.invalid:8080";
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const result = await execBoundGitHubCli("/usr/bin/env", [], {
      cwd: root,
      env: { HOME: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
      timeoutMs: 5_000
    });
    const received = Object.fromEntries(result.stdout.trim().split("\n").filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    assert.equal(received.GH_HOST, "github.com");
    assert.equal(received.GH_CONFIG_DIR, path.join(root, ".config", "gh"));
    assert.equal(received.XDG_CONFIG_HOME, path.join(root, ".config"));
    assert.equal(Object.hasOwn(received, "GIT_DIR"), false);
    assert.equal(Object.hasOwn(received, "HTTPS_PROXY"), false);
    assert.equal(Object.hasOwn(received, "NODE_TLS_REJECT_UNAUTHORIZED"), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("GitHub API actor reads use the exact credential captured for push", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-bound-gh-actor-binding-"));
  const fakeGh = path.join(root, "gh");
  await writeFile(fakeGh, [
    "#!/bin/sh",
    "if [ \"$1\" = \"auth\" ]; then",
    "  printf 'captured-token\\n'",
    "elif [ \"$GH_TOKEN\" = \"captured-token\" ]; then",
    "  if [ \"$2\" = \"user\" ]; then printf '{\"login\":\"actor-a\",\"id\":1}\\n'; else printf '{\"full_name\":\"example/repository\",\"permissions\":{\"push\":true}}\\n'; fi",
    "else",
    "  printf '{\"login\":\"actor-b\",\"id\":2}\\n'",
    "fi"
  ].join("\n"), { mode: 0o700 });
  const executable = await realpath(fakeGh);
  const previous = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.GH_TOKEN = "ambient-token";
  process.env.GITHUB_TOKEN = "ambient-secondary-token";
  try {
    const actor = await readBoundGitHubApi(root, executable, "user", {
      credential: { username: "x-access-token", password: "captured-token" },
      homePath: root
    });
    assert.deepEqual(actor, { login: "actor-a", id: 1 });
    const verified = await verifyGitHubCredentialActor(
      root,
      "https://github.com/example/repository.git",
      "github.com/example/repository",
      executable
    );
    assert.equal(verified.actor, "actor-a");
    assert.equal(verified.permissions.push, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("bound Git process terminates a hanging process group at the fixed deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-bound-git-timeout-"));
  const hanging = path.join(root, "git");
  await writeFile(hanging, "#!/bin/sh\nsleep 10\n", { mode: 0o700 });
  const executable = await realpath(hanging);
  await assert.rejects(
    () => execBoundGitProcess(executable, ["fetch"], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, LC_ALL: "C" },
      timeoutMs: 50
    }),
    (error) => error?.code === "ETIMEDOUT" && /50ms/.test(error.message)
  );
});

async function assertBoundProcessGone(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`bound child ${pid} survived process-group cleanup`);
}

async function successfulForkLauncher(root) {
  const launcher = path.join(root, "fork-success");
  const descendantSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 10000);";
  const source = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const pidPath = process.argv[2];",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
    "child.unref();",
    "fs.writeFileSync(pidPath, String(child.pid));"
  ].join(" ");
  await writeFile(launcher, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return realpath(launcher);
}

async function timeoutForkLauncher(root) {
  const launcher = path.join(root, "fork-timeout");
  const descendantSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 10000);";
  const source = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const pidPath = process.argv[2];",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
    "child.unref();",
    "fs.writeFileSync(pidPath, String(child.pid));",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 10000);"
  ].join(" ");
  await writeFile(launcher, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return realpath(launcher);
}

test("bound GitHub CLI timeout cleans a SIGTERM-ignoring descendant before rejecting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-bound-gh-timeout-group-"));
  const pidPath = path.join(root, "descendant.pid");
  try {
    const executable = await timeoutForkLauncher(root);
    await assert.rejects(
      () => execBoundGitHubCli(executable, [pidPath], {
        cwd: root,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, LC_ALL: "C" },
        timeoutMs: 500
      }),
      (error) => error?.code === "ETIMEDOUT"
    );
    await assertBoundProcessGone(Number((await readFile(pidPath, "utf8")).trim()));
  } finally {
    await unlink(pidPath).catch(() => undefined);
  }
});

test("bound Git timeout cleans a SIGTERM-ignoring descendant before rejecting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-bound-git-timeout-group-"));
  const pidPath = path.join(root, "descendant.pid");
  try {
    const executable = await timeoutForkLauncher(root);
    await assert.rejects(
      () => execBoundGitProcess(executable, [pidPath], {
        cwd: root,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, LC_ALL: "C" },
        timeoutMs: 500
      }),
      (error) => error?.code === "ETIMEDOUT"
    );
    await assertBoundProcessGone(Number((await readFile(pidPath, "utf8")).trim()));
  } finally {
    await unlink(pidPath).catch(() => undefined);
  }
});

test("bound GitHub CLI success cleans a descendant before resolving", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-bound-gh-success-group-"));
  const pidPath = path.join(root, "descendant.pid");
  try {
    const executable = await successfulForkLauncher(root);
    const result = await execBoundGitHubCli(executable, [pidPath], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, LC_ALL: "C" },
      timeoutMs: 5_000
    });
    assert.equal(result.groupTerminated, true);
    await assertBoundProcessGone(Number((await readFile(pidPath, "utf8")).trim()));
  } finally {
    await unlink(pidPath).catch(() => undefined);
  }
});

test("bound Git success cleans a descendant before resolving", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-bound-git-success-group-"));
  const pidPath = path.join(root, "descendant.pid");
  try {
    const executable = await successfulForkLauncher(root);
    const result = await execBoundGitProcess(executable, [pidPath], {
      cwd: root,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, LC_ALL: "C" },
      timeoutMs: 5_000
    });
    assert.equal(result.groupTerminated, true);
    await assertBoundProcessGone(Number((await readFile(pidPath, "utf8")).trim()));
  } finally {
    await unlink(pidPath).catch(() => undefined);
  }
});

test("withBoundGitCredential callback retains bounded descendant cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-bound-credential-success-group-"));
  const source = path.join(root, "source");
  const pidPath = path.join(root, "descendant.pid");
  await mkdir(source);
  await execFileAsync("git", ["init", "-q"], { cwd: source });
  await writeFile(path.join(source, "README.md"), "bound credential source\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: source });
  await execFileAsync("git", ["-c", "user.name=SBW", "-c", "user.email=sbw@example.invalid", "commit", "-qm", "fixture"], { cwd: source });
  try {
    const executable = await successfulForkLauncher(root);
    await withBoundGitCredential(
      source,
      "https://github.com/example/repository.git",
      { username: "x-access-token", password: "test-token" },
      "/usr/bin/git",
      async () => {
        const result = await execBoundGitProcess(executable, [pidPath], {
          cwd: root,
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, LC_ALL: "C" },
          timeoutMs: 5_000
        });
        assert.equal(result.groupTerminated, true);
      }
    );
    await assertBoundProcessGone(Number((await readFile(pidPath, "utf8")).trim()));
  } finally {
    await unlink(pidPath).catch(() => undefined);
  }
});

test("bound Git push context ignores mutable global and source-local transport config", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "sbw-bound-git-source-"));
  await execFileAsync("git", ["init", "-q"], { cwd: source });
  await writeFile(path.join(source, "README.md"), "bound object\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: source });
  await execFileAsync("git", ["-c", "user.name=SBW", "-c", "user.email=sbw@example.invalid", "commit", "-qm", "fixture"], { cwd: source });
  await execFileAsync("git", ["config", "url.ssh://local.invalid/.insteadOf", "https://github.com/"], { cwd: source });
  await execFileAsync("git", ["config", "http.proxy", "http://local.invalid:8080"], { cwd: source });
  const revision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" })).stdout.trim();

  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "sbw-bound-git-home-"));
  await writeFile(path.join(isolatedHome, ".gitconfig"), [
    '[url "ssh://global.invalid/"]',
    "\tinsteadOf = https://github.com/",
    "[http]",
    "\tproxy = http://global.invalid:8080",
    "\tsslVerify = false",
    ""
  ].join("\n"));
  const gitDirectory = path.join(isolatedHome, "git-dir");
  await mkdir(path.join(gitDirectory, "objects", "info"), { recursive: true });
  await mkdir(path.join(gitDirectory, "objects", "pack"), { recursive: true });
  await mkdir(path.join(gitDirectory, "refs", "heads"), { recursive: true });
  await writeFile(path.join(gitDirectory, "HEAD"), "ref: refs/heads/bound-empty\n");
  const objectDirectory = await realpath(path.join(source, ".git", "objects"));
  const env = buildBoundGitPushEnvironment({ isolatedHome, gitDirectory, objectDirectory });
  const listed = await execFileAsync("git", ["--no-replace-objects", "-c", "core.bare=true", "config", "--list", "--show-origin"], {
    cwd: source,
    encoding: "utf8",
    env
  });
  assert.doesNotMatch(listed.stdout, /(?:local|global)\.invalid|http\.proxy|http\.sslverify/i);
  await execFileAsync("git", ["--no-replace-objects", "-c", "core.bare=true", "cat-file", "-e", `${revision}^{commit}`], {
    cwd: source,
    env
  });
});

test("git push execution rejects an issued record that omits its remote binding", () => {
  assert.throws(
    () => resolveGitPushExecutionBinding({
      resource: "remote:origin:refs/heads/feature",
      expectedBranch: "feature",
      expectedRevision: "b".repeat(40),
      pushUrl: "https://github.com/example/repository.git",
      pushUrlDigest: sha256("https://github.com/example/repository.git"),
      remoteRepository: "github.com/example/repository",
      pushCommand: [
        "git",
        "push",
        "--porcelain",
        "https://github.com/example/repository.git",
        `${"b".repeat(40)}:refs/heads/feature`
      ]
    }),
    /Git push execution binding is inconsistent/
  );
});

test("git push destination binds a divergent pushurl and rejects multiple effective destinations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-git-push-destination-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/fetch-only.git"], { cwd: root });
  const pushUrl = "https://github.com/example/effective-push.git";
  await execFileAsync("git", ["config", "remote.origin.pushurl", pushUrl], { cwd: root });
  const sourceRemoteBindingDigest = digestObject({
    fetchUrls: ["https://github.com/example/fetch-only.git"],
    pushUrls: [pushUrl]
  });
  assert.deepEqual(
    await resolveGitPushDestination(root, "origin"),
    {
      remote: "origin",
      pushUrl,
      pushUrlDigest: sha256(pushUrl),
      remoteRepository: "github.com/example/effective-push",
      sourceRemoteBindingDigest
    }
  );
  await execFileAsync("git", ["config", "--add", "remote.origin.pushurl", "https://github.com/example/second-push.git"], { cwd: root });
  await assert.rejects(
    resolveGitPushDestination(root, "origin"),
    /exactly one raw origin URL and effective push URL/
  );
  await execFileAsync("git", ["config", "--unset-all", "remote.origin.pushurl"], { cwd: root });
  await execFileAsync("git", ["config", "remote.origin.pushurl", "https://embedded-token@github.com/example/effective-push.git"], { cwd: root });
  await assert.rejects(
    resolveGitPushDestination(root, "origin"),
    /credential-safe canonical HTTPS GitHub repository URL/
  );
});

test("git push destination ignores ambient config and local URL rewrites", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-git-push-authority-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  const origin = "https://github.com/example/source-bound.git";
  await execFileAsync("git", ["remote", "add", "origin", origin], { cwd: root });
  await execFileAsync("git", ["config", "url.https://rewritten.invalid/.insteadOf", "https://github.com/"], { cwd: root });
  assert.equal(
    (await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" })).stdout.trim(),
    "https://rewritten.invalid/example/source-bound.git"
  );
  const expected = await resolveGitPushDestination(root, "origin");
  const injected = {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "remote.origin.url",
    GIT_CONFIG_VALUE_0: "https://github.com/attacker/injected.git",
    GIT_CONFIG_KEY_1: "remote.origin.pushurl",
    GIT_CONFIG_VALUE_1: "https://github.com/attacker/injected-push.git",
    GIT_CONFIG_PARAMETERS: "'url.https://parameters.invalid/.insteadOf'='https://github.com/'"
  };
  const previous = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]));
  Object.assign(process.env, injected);
  try {
    await assert.rejects(
      resolveGitPushDestination(root, "origin"),
      /rejects ambient routing or configuration overrides/
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepEqual(await resolveGitPushDestination(root, "origin"), expected);
  assert.equal(expected.pushUrl, origin);
  assert.equal(expected.remoteRepository, "github.com/example/source-bound");
});

test("git push destination never treats oversized raw pushurl output as absence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-git-push-oversized-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/fetch-only.git"], { cwd: root });
  const configPath = path.join(root, ".git", "config");
  const config = await readFile(configPath, "utf8");
  await writeFile(configPath, `${config}\n[remote "origin"]\n\tpushurl = https://github.com/example/${"p".repeat(4 * 1024 * 1024 + 4096)}.git\n`);
  await assert.rejects(resolveGitPushDestination(root, "origin"), /output exceeded/);
});

test("git fetch authority binds the raw origin and rejects URL rewrite or ambiguity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-git-fetch-authority-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  const origin = "https://github.com/example/source-bound.git";
  await execFileAsync("git", ["remote", "add", "origin", origin], { cwd: root });
  await execFileAsync("git", ["config", "url.https://rewritten.invalid/.insteadOf", "https://github.com/"], { cwd: root });
  assert.equal(
    (await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" })).stdout.trim(),
    "https://rewritten.invalid/example/source-bound.git"
  );
  assert.deepEqual(await resolveGitFetchOrigin(root), {
    remote: "origin",
    remoteUrl: origin,
    remoteUrlDigest: sha256(origin),
    remoteRepository: "github.com/example/source-bound",
    sourceRemoteBindingDigest: digestObject({ fetchUrls: [origin], pushUrls: [] })
  });
  await execFileAsync("git", ["config", "--add", "remote.origin.url", "https://github.com/example/second.git"], { cwd: root });
  await assert.rejects(resolveGitFetchOrigin(root), /exactly one raw local origin URL/);
});

test("remote synchronization receipts bind the raw source remote identity", () => {
  const record = {
    action: "remote.sync",
    provider: "git",
    resource: "refs/heads/dev",
    outcome: "success",
    remote: "origin",
    remoteRepository: "github.com/example/repository",
    remoteUrlDigest: "a".repeat(64),
    sourceBindingDigest: "c".repeat(64),
    sourceRemoteBindingDigest: "b".repeat(64)
  };
  const receipt = {
    executionId: "git:repository:remote.sync:dev",
    proofKind: "git-remote-sync",
    requestDigest: "c".repeat(64),
    responseDigest: "d".repeat(64),
    verifiedAt: new Date().toISOString(),
    terminalState: "success",
    ref: "refs/heads/dev",
    remote: "origin",
    repository: "/private/tmp/repository.git",
    remoteRepository: record.remoteRepository,
    remoteUrlDigest: record.remoteUrlDigest,
    sourceBindingDigest: record.sourceBindingDigest,
    providerRevision: "e".repeat(40),
    localRevision: "e".repeat(40)
  };
  assert.throws(() => assertProviderReceiptShape(record, receipt), /remote synchronization proof is incomplete/i);
  assert.doesNotThrow(() => assertProviderReceiptShape(record, {
    ...receipt,
    sourceRemoteBindingDigest: record.sourceRemoteBindingDigest
  }));
});

test("PR creation receipts bind to the exact candidate source head", () => {
  const expectedHead = "a".repeat(40);
  const record = {
    action: "pr.create",
    provider: "github-cli",
    resource: "pull/new",
    outcome: "success",
    attemptId: "attempt-1",
    idempotencyKey: "idempotency-1",
    expectedHead,
    targetRef: "dev",
    creationPrecondition: { action: "pr.create", resource: "pull/new", state: "absent", number: null }
  };
  const receipt = {
    executionId: "github:test:pr.create:12",
    proofKind: "github-pr-create",
    requestDigest: "0".repeat(64),
    responseDigest: "1".repeat(64),
    verifiedAt: "2026-08-01T00:00:00.000Z",
    terminalState: "success",
    created: true,
    creationProof: {
      attemptId: record.attemptId,
      idempotencyKey: record.idempotencyKey,
      marker: `sbw:${record.attemptId}:${record.idempotencyKey}`
    },
    number: 12,
    head: "b".repeat(40),
    base: "dev",
    url: "https://github.com/example/repo/pull/12",
    creationPreconditionDigest: digestObject(record.creationPrecondition)
  };
  assert.throws(
    () => assertProviderReceiptShape(record, receipt),
    /GitHub pull request creation proof is incomplete/
  );
  assert.doesNotThrow(() => assertProviderReceiptShape(record, { ...receipt, head: expectedHead }));
});

test("PR creation command binds the target, head, and provider-native marker", () => {
  const command = buildPrCreateCommand({
    action: "pr.create",
    provider: "github-cli",
    resource: "pull/new",
    createRepository: "github.com/example/repo",
    targetRef: "dev",
    headBranch: "codex/feature",
    prTitle: "Better Workflows: delivery",
    prBodyPrefix: "Automated delivery.",
    attemptId: "attempt-1",
    idempotencyKey: "idempotency-1"
  });
  assert.deepEqual(command, [
    "gh",
    "pr",
    "create",
    "--repo",
    "github.com/example/repo",
    "--base",
    "dev",
    "--head",
    "codex/feature",
    "--title",
    "Better Workflows: delivery",
    "--body",
    "Automated delivery.\n\n<!-- sbw:attempt-1:idempotency-1 -->"
  ]);
});

test("known failed owned creation releases its reservation for a retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-creation-failure-retry-"));
  const repository = path.join(root, "repository");
  await mkdir(repository, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "retry\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: repository });
  const run = await createRun({
    root,
    contract: contract({ authority: ["branch.create"] }),
    requestedMode: "verified",
    cwd: repository
  });
  await addEvidence(root, run.runId, {
    id: "preflight",
    kind: "preflight",
    summary: "Creation retry preflight",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: "a".repeat(64)
  });
  await updateState(root, run.runId, (state) => ({
    ...state,
    lastSentinel: { label: "test", digest: "tree" },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const resource = "branch:feature/retry";
  const issued = await issueActionToken(root, run.runId, {
    action: "branch.create",
    provider: "git",
    resource,
    remoteRevision: "abc",
    requiredEvidence: ["preflight"]
  }, "tree", await loadDefaults());
  const spent = await consumeActionToken(root, run.runId, issued.token, "tree");
  const failedReceipt = {
    action: "branch.create",
    provider: "git",
    resource,
    outcome: "failure",
    runId: run.runId,
    attemptId: spent.attemptId,
    idempotencyKey: spent.idempotencyKey,
    remoteRevision: spent.remoteRevision,
    providerReceipt: {
      action: "branch.create",
      provider: "git",
      resource,
      outcome: "failure",
      runId: run.runId,
      attemptId: spent.attemptId,
      idempotencyKey: spent.idempotencyKey,
      remoteRevision: spent.remoteRevision,
      executionId: `git:${run.runId}:branch.create:failure`,
      proofKind: "git-branch-create",
      requestDigest: "0".repeat(64),
      responseDigest: "1".repeat(64),
      verifiedAt: new Date().toISOString(),
      terminalState: "failure"
    }
  };
  await reconcileAction(root, run.runId, spent.attemptId, "failure", failedReceipt);
  const reservationPath = path.join(root, "creation-reservations", `${creationReservationKey(issued.creationReservation)}.json`);
  await assert.rejects(stat(reservationPath));
  const retry = await issueActionToken(root, run.runId, {
    action: "branch.create",
    provider: "git",
    resource,
    remoteRevision: "abc",
    requiredEvidence: ["preflight"]
  }, "tree", await loadDefaults());
  assert.notEqual(retry.token, issued.token);
  const unknownResource = "branch:feature/unknown";
  const unknownIssued = await issueActionToken(root, run.runId, {
    action: "branch.create",
    provider: "git",
    resource: unknownResource,
    remoteRevision: "abc",
    requiredEvidence: ["preflight"]
  }, "tree", await loadDefaults());
  const unknownSpent = await consumeActionToken(root, run.runId, unknownIssued.token, "tree");
  const unknownReceipt = {
    action: "branch.create",
    provider: "git",
    resource: unknownResource,
    outcome: "unknown",
    runId: run.runId,
    attemptId: unknownSpent.attemptId,
    idempotencyKey: unknownSpent.idempotencyKey,
    remoteRevision: unknownSpent.remoteRevision,
    providerReceipt: {
      action: "branch.create",
      provider: "git",
      resource: unknownResource,
      outcome: "unknown",
      runId: run.runId,
      attemptId: unknownSpent.attemptId,
      idempotencyKey: unknownSpent.idempotencyKey,
      remoteRevision: unknownSpent.remoteRevision,
      executionId: `git:${run.runId}:branch.create:unknown`,
      proofKind: "git-branch-create",
      requestDigest: "0".repeat(64),
      responseDigest: "1".repeat(64),
      verifiedAt: new Date().toISOString(),
      terminalState: "unknown"
    }
  };
  await reconcileAction(root, run.runId, unknownSpent.attemptId, "unknown", unknownReceipt);
  const unknownReservationPath = path.join(root, "creation-reservations", `${creationReservationKey(unknownIssued.creationReservation)}.json`);
  await stat(unknownReservationPath);
  await assert.rejects(
    reconcileAction(root, run.runId, unknownSpent.attemptId, "failure", {
      ...unknownReceipt,
      outcome: "failure",
      providerReceipt: {
        ...unknownReceipt.providerReceipt,
        outcome: "failure",
        terminalState: "failure"
      }
    }),
    /already reconciled/
  );
  await stat(unknownReservationPath);
});

test("owned-resource reservations are scoped by provider repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-reservation-namespace-"));
  const repositoriesRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-reservation-repositories-"));
  const prepare = async (name) => {
    const cwd = path.join(repositoriesRoot, name);
    await mkdir(cwd, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd });
    await writeFile(path.join(cwd, "README.md"), `${name}\n`);
    await execFileAsync("git", ["add", "README.md"], { cwd });
    await execFileAsync("git", ["-c", "user.email=sbw@example.invalid", "-c", "user.name=SBW Test", "commit", "-qm", "baseline"], { cwd });
    const run = await createRun({
      root,
      contract: contract({ authority: ["branch.create"] }),
      requestedMode: "verified",
      cwd
    });
    await addEvidence(root, run.runId, {
      id: "preflight",
      kind: "preflight",
      summary: "Repository-scoped reservation preflight",
      status: "complete",
      acceptanceIds: [],
      sourceDigest: "e".repeat(64)
    });
    await updateState(root, run.runId, (state) => ({
      ...state,
      lastSentinel: { label: "test", digest: "tree" },
      lastSentinelVerified: true,
      lastSentinelComplete: true
    }));
    return run;
  };
  const [firstRun, secondRun] = await Promise.all([prepare("first"), prepare("second")]);
  const defaults = await loadDefaults();
  const [first, second] = await Promise.all([
    issueActionToken(root, firstRun.runId, {
      action: "branch.create",
      provider: "git",
      resource: "branch:shared",
      remoteRevision: "abc",
      requiredEvidence: ["preflight"]
    }, "tree", defaults),
    issueActionToken(root, secondRun.runId, {
      action: "branch.create",
      provider: "git",
      resource: "branch:shared",
      remoteRevision: "abc",
      requiredEvidence: ["preflight"]
    }, "tree", defaults)
  ]);
  assert.notEqual(
    creationReservationKey(first.creationReservation),
    creationReservationKey(second.creationReservation)
  );
  await stat(path.join(root, "creation-reservations", `${creationReservationKey(first.creationReservation)}.json`));
  await stat(path.join(root, "creation-reservations", `${creationReservationKey(second.creationReservation)}.json`));
});

test("creation reservation lease gives one concurrent same-repository attempt the winner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-reservation-lease-"));
  const repository = await mkdtemp(path.join(os.tmpdir(), "sbw-reservation-lease-repository-"));
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "lease\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["-c", "user.email=sbw@example.invalid", "-c", "user.name=SBW Test", "commit", "-qm", "baseline"], { cwd: repository });
  const [firstRun, secondRun] = await Promise.all([
    createRun({ root, contract: contract({ authority: ["branch.create"] }), requestedMode: "verified", cwd: repository }),
    createRun({ root, contract: contract({ authority: ["branch.create"] }), requestedMode: "verified", cwd: repository })
  ]);
  for (const run of [firstRun, secondRun]) {
    await addEvidence(root, run.runId, {
      id: "preflight",
      kind: "preflight",
      summary: "Concurrent reservation preflight",
      status: "complete",
      acceptanceIds: [],
      sourceDigest: "f".repeat(64)
    });
    await updateState(root, run.runId, (state) => ({
      ...state,
      lastSentinel: { label: "test", digest: "tree" },
      lastSentinelVerified: true,
      lastSentinelComplete: true
    }));
  }
  const defaults = await loadDefaults();
  const results = await Promise.allSettled([firstRun, secondRun].map((run) => issueActionToken(root, run.runId, {
    action: "branch.create",
    provider: "git",
    resource: "branch:concurrent",
    remoteRevision: "abc",
    requiredEvidence: ["preflight"]
  }, "tree", defaults)));
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.match(
    results.find((item) => item.status === "rejected").reason.message,
    /already reserved by another action|Creation resource is leased by pid/
  );

  const winner = results.find((item) => item.status === "fulfilled").value;
  const foreignLeaseIdentity = {
    ...winner.creationReservation,
    resource: "branch:foreign-host"
  };
  const foreignLeasePath = path.join(
    root,
    "creation-reservations",
    `.${creationReservationKey(foreignLeaseIdentity)}.lease`
  );
  await writeFile(foreignLeasePath, `${JSON.stringify({
    ...foreignLeaseIdentity,
    reservationKey: creationReservationKey(foreignLeaseIdentity),
    pid: 999999,
    host: `foreign-host-${os.hostname()}`,
    createdAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-01T00:00:01.000Z"
  })}\n`);
  await assert.rejects(
    issueActionToken(root, winner.runId, {
      action: "branch.create",
      provider: "git",
      resource: foreignLeaseIdentity.resource,
      remoteRevision: "abc",
      requiredEvidence: ["preflight"]
    }, "tree", defaults),
    /refusing cross-host lease reclamation/
  );
});

test("linked worktrees share the canonical Git reservation identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-linked-worktree-reservation-"));
  const repositoriesRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-linked-worktree-repositories-"));
  const repository = path.join(repositoriesRoot, "repository");
  const linkedWorktree = path.join(repositoriesRoot, "linked-worktree");
  await mkdir(repository, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "linked worktree\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["-c", "user.email=sbw@example.invalid", "-c", "user.name=SBW Test", "commit", "-qm", "baseline"], { cwd: repository });
  await execFileAsync("git", ["worktree", "add", "-q", "-b", "sbw-linked-worktree", linkedWorktree, "HEAD"], { cwd: repository });

  const prepare = async (cwd) => {
    const run = await createRun({
      root,
      contract: contract({ authority: ["branch.create"] }),
      requestedMode: "verified",
      cwd
    });
    await addEvidence(root, run.runId, {
      id: "preflight",
      kind: "preflight",
      summary: "Linked worktree reservation preflight",
      status: "complete",
      acceptanceIds: [],
      sourceDigest: "g".repeat(64)
    });
    await updateState(root, run.runId, (state) => ({
      ...state,
      lastSentinel: { label: "test", digest: "tree" },
      lastSentinelVerified: true,
      lastSentinelComplete: true
    }));
    return run;
  };
  const [mainRun, linkedRun] = await Promise.all([prepare(repository), prepare(linkedWorktree)]);
  const defaults = await loadDefaults();
  const results = await Promise.allSettled([mainRun, linkedRun].map((run) => issueActionToken(root, run.runId, {
    action: "branch.create",
    provider: "git",
    resource: "branch:linked-shared",
    remoteRevision: "abc",
    requiredEvidence: ["preflight"]
  }, "tree", defaults)));
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.match(
    results.find((item) => item.status === "rejected").reason.message,
    /already reserved by another action|Creation resource is leased by pid/
  );
});

test("GitHub Actions dispatch adapter binds a fixed command and one observed run", () => {
  const remoteRevision = "a".repeat(40);
  const dispatchNonce = "c".repeat(32);
  const inputs = {
    environment: "production",
    sbw_dispatch_nonce: dispatchNonce,
    sbw_expected_revision: remoteRevision,
    smoke: "true"
  };
  const workflowDispatchCapability = {
    schemaVersion: 1,
    workflowFile: ".github/workflows/release.yml",
    revision: remoteRevision,
    nonceInput: "sbw_dispatch_nonce",
    expectedRevisionInput: "sbw_expected_revision",
    runNameNonce: true,
    expectedRevisionGate: true,
    contentDigest: "d".repeat(64)
  };
  const record = {
    action: "actions.dispatch",
    provider: "github-cli",
    resource: "workflow:.github/workflows/release.yml",
    remoteRevision,
    dispatchRepository: "github.com/example/repo",
    workflowFile: ".github/workflows/release.yml",
    dispatchRef: "dev",
    dispatchNonce,
    dispatchInputs: inputs,
    dispatchInputsDigest: digestObject(inputs),
    workflowDispatchCapability,
    workflowDispatchCapabilityDigest: digestObject(workflowDispatchCapability),
    providerExecutable: { path: "/usr/local/bin/gh", digest: "b".repeat(64) },
    providerAuthorizationExecutable: { path: "/usr/local/bin/gh", digest: "b".repeat(64) },
    providerAuthorization: {
      provider: "github-cli",
      repository: "github.com/example/repo",
      actor: "alice",
      permissions: { admin: false, maintain: false, push: true }
    },
    runId: "sbw-20260814T000000Z-000000000000",
    attemptId: "attempt-1",
    idempotencyKey: "idempotency-1",
    providerInvocation: {
      id: "github-actions-dispatch-wrapper:run:attempt-1",
      workflowRun: {
        databaseId: 12345,
        workflowName: "Release",
        url: "https://github.com/example/repo/actions/runs/12345",
        displayTitle: `Release ${dispatchNonce}`,
        status: "completed",
        conclusion: "success",
        headSha: remoteRevision
      }
    }
  };
  assert.deepEqual(buildActionsDispatchCommand(record), [
    "gh", "workflow", "run", ".github/workflows/release.yml",
    "--repo", "example/repo", "--ref", "dev",
    "--raw-field", `environment=production`, "--raw-field", `sbw_dispatch_nonce=${dispatchNonce}`,
    "--raw-field", `sbw_expected_revision=${remoteRevision}`, "--raw-field", "smoke=true"
  ]);
  const receipt = buildActionsDispatchProviderReceipt(record);
  assert.equal(receipt.runId, "12345");
  assert.equal(receipt.repository, "github.com/example/repo");
  assert.equal(receipt.executionId, "github:github.com/example/repo:actions.dispatch:12345");
  assertProviderReceiptShape(record, receipt, "success");
  const observedNonzeroReceipt = buildActionsDispatchProviderReceipt({
    ...record,
    providerInvocation: { ...record.providerInvocation, exitCode: 23 }
  }, "success");
  assert.doesNotThrow(() => assertProviderReceiptShape({
    ...record,
    providerInvocation: { ...record.providerInvocation, exitCode: 23 }
  }, observedNonzeroReceipt, "success"));
  const failedRecord = {
    ...record,
    providerInvocation: {
      ...record.providerInvocation,
      workflowRun: { ...record.providerInvocation.workflowRun, conclusion: "failure" }
    }
  };
  const failedReceipt = buildActionsDispatchProviderReceipt(failedRecord, "failure");
  assert.equal(failedReceipt.terminalState, "failure");
  assert.doesNotThrow(() => assertProviderReceiptShape(failedRecord, failedReceipt, "failure"));
  assert.throws(
    () => buildActionsDispatchProviderReceipt(record, "failure"),
    /completed non-success workflow conclusion/
  );
  const unknownReceipt = buildActionsDispatchProviderReceipt(record, "unknown");
  assert.equal(unknownReceipt.terminalState, "unknown");
  assert.doesNotThrow(() => assertProviderReceiptShape(record, unknownReceipt, "unknown"));
  assert.throws(
    () => assertProviderReceiptShape(record, { ...unknownReceipt, terminalState: "failure" }, "unknown"),
    /remain indeterminate/
  );
  assert.throws(
    () => buildActionsDispatchCommand({ ...record, dispatchInputsDigest: "c".repeat(64) }),
    /input digest does not match/
  );
  assert.throws(
    () => buildActionsDispatchCommand({ ...record, dispatchNonce: "d".repeat(32) }),
    /provider-correlation nonce binding/
  );
  assert.throws(
    () => buildActionsDispatchCommand({ ...record, resource: "workflow:.github/workflows/other.yml" }),
    /resource is not bound to workflowFile/
  );
  assert.throws(
    () => buildActionsDispatchProviderReceipt({
      ...record,
      resource: "workflow:release"
    }),
    /resource is not bound to workflowFile/
  );
  assert.throws(
    () => buildActionsDispatchCommand({
      ...record,
      workflowFile: ".github/workflows/release/release.yml",
      resource: "workflow:.github/workflows/release/release.yml"
    }),
    /requires a repository workflow file/
  );
  assert.throws(
    () => buildActionsDispatchProviderReceipt({
      ...record,
      providerInvocation: {
        ...record.providerInvocation,
        workflowRun: { ...record.providerInvocation.workflowRun, displayTitle: "Release without correlation" }
      }
    }),
    /provider invocation is incomplete/
  );
});

test("GitHub Actions preflight failure has an explicit not-sent terminal proof", async () => {
  const remoteRevision = "a".repeat(40);
  const dispatchNonce = "c".repeat(32);
  const inputs = { sbw_dispatch_nonce: dispatchNonce, sbw_expected_revision: remoteRevision };
  const invocation = {
    id: "github-actions-dispatch-wrapper:run:not-sent",
    provider: "github-cli",
    dispatchState: "not-sent",
    exitCode: null,
    startedAt: "2026-08-15T00:00:00.000Z",
    finishedAt: "2026-08-15T00:00:01.000Z",
    errorDigest: "e".repeat(64)
  };
  const record = {
    action: "actions.dispatch",
    provider: "github-cli",
    resource: "workflow:.github/workflows/ci.yml",
    remoteRevision,
    dispatchRepository: "github.com/example/repo",
    workflowFile: ".github/workflows/ci.yml",
    dispatchRef: "dev",
    dispatchNonce,
    dispatchInputs: inputs,
    dispatchInputsDigest: digestObject(inputs),
    workflowDispatchCapabilityDigest: "d".repeat(64),
    dispatchCommand: ["gh", "workflow", "run", ".github/workflows/ci.yml", "--repo", "example/repo", "--ref", "dev"],
    providerExecutable: { path: "/usr/local/bin/gh", digest: "b".repeat(64) },
    providerAuthorizationExecutable: { path: "/usr/local/bin/gh", digest: "b".repeat(64) },
    providerAuthorization: { provider: "github-cli", repository: "github.com/example/repo", actor: "alice" },
    runId: "sbw-20260814T000000Z-000000000000",
    attemptId: "not-sent-attempt",
    idempotencyKey: "not-sent-idempotency",
    providerInvocation: invocation
  };
  const receipt = buildActionsDispatchProviderReceipt(record, "failure");
  assert.equal(receipt.created, false);
  assert.equal(receipt.dispatchState, "not-sent");
  assert.equal(receipt.terminalState, "failure");
  assertProviderReceiptShape(record, receipt, "failure");
  assert.throws(
    () => buildActionsDispatchProviderReceipt(record, "success"),
    /only reconcile as terminal failure/
  );

  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-actions-dispatch-not-sent-reconcile-"));
  const repository = path.join(stateRoot, "repository");
  try {
    await mkdir(repository, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "dev"], { cwd: repository });
    await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
    await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
    await writeFile(path.join(repository, "README.md"), "not-sent dispatch\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repository });
    await execFileAsync("git", ["commit", "-qm", "not-sent dispatch baseline"], { cwd: repository });
    const run = await createRun({
      root: stateRoot,
      contract: contract({ authority: ["actions.dispatch"], remoteRevision }),
      requestedMode: "critical",
      cwd: repository
    });
    const action = {
      ...record,
      runId: run.runId,
      tokenHash: sha256("not-sent-reconcile-token"),
      status: "spent",
      outcome: "pending",
      providerInvocation: { ...invocation, actionAttemptId: "not-sent-reconcile-attempt" },
      attemptId: "not-sent-reconcile-attempt"
    };
    const actionPath = path.join(stateRoot, "runs", run.runId, "actions", `${action.tokenHash}.json`);
    await writeFile(actionPath, `${JSON.stringify(action)}\n`);
    const actionReceipt = {
      action: action.action,
      provider: action.provider,
      resource: action.resource,
      outcome: "failure",
      runId: action.runId,
      attemptId: action.attemptId,
      idempotencyKey: action.idempotencyKey,
      remoteRevision: action.remoteRevision,
      providerReceipt: buildActionsDispatchProviderReceipt(action, "failure")
    };
    const reconciled = await reconcileAction(stateRoot, run.runId, action.attemptId, "failure", actionReceipt);
    assert.equal(reconciled.outcome, "failure");
    assert.equal(reconciled.receipt.providerReceipt.created, false);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("GitHub Actions failure conclusion is reconciled against live provider state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-actions-dispatch-failure-reconcile-"));
  const repository = path.join(root, "repository");
  const bin = path.join(root, "bin");
  await mkdir(repository, { recursive: true });
  await mkdir(bin, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "dev"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "dispatch failure\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: repository });

  const remoteRevision = "a".repeat(40);
  const dispatchNonce = "c".repeat(32);
  const workflowFile = ".github/workflows/release.yml";
  const resource = `workflow:${workflowFile}`;
  const inputs = {
    sbw_dispatch_nonce: dispatchNonce,
    sbw_expected_revision: remoteRevision
  };
  const workflowDispatchCapability = {
    schemaVersion: 1,
    workflowFile,
    revision: remoteRevision,
    nonceInput: "sbw_dispatch_nonce",
    expectedRevisionInput: "sbw_expected_revision",
    runNameNonce: true,
    expectedRevisionGate: true,
    contentDigest: "d".repeat(64)
  };
  const taskContract = contract({ authority: ["actions.dispatch"], remoteRevision });
  const run = await createRun({ root, contract: taskContract, requestedMode: "critical", cwd: repository });
  const runDir = path.join(root, "runs", run.runId);
  const tokenHash = sha256("actions-dispatch-failure-token");
  const attemptId = "actions-dispatch-failure-attempt";
  const idempotencyKey = "actions-dispatch-failure-idempotency";
  const providerAuthorization = {
    provider: "github-cli",
    repository: "github.com/example/repo",
    actor: "alice",
    permissions: { admin: false, maintain: false, push: true }
  };
  const responsePath = path.join(root, "workflow-run.json");
  const fakeGh = path.join(bin, "gh");
  const ghScript = `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  printf '{"login":"alice"}\\n'
elif [ "$1" = "api" ] && [ "$2" = "repos/example/repo" ]; then
  printf '{"full_name":"example/repo","permissions":{"admin":false,"maintain":false,"push":true}}\\n'
elif [ "$1" = "run" ] && [ "$2" = "view" ]; then
  cat ${JSON.stringify(responsePath)}
else
  exit 9
fi
`;
  await writeFile(fakeGh, ghScript, { mode: 0o700 });
  const providerExecutable = { path: await realpath(fakeGh), digest: sha256(ghScript) };
  const workflowRun = {
    databaseId: 12345,
    workflowName: "Release",
    url: "https://github.com/example/repo/actions/runs/12345",
    displayTitle: `Release ${dispatchNonce}`,
    status: "completed",
    conclusion: "failure",
    headSha: remoteRevision
  };
  const providerInvocation = {
    id: `github-actions-dispatch-wrapper:${run.runId}:${attemptId}`,
    provider: "github-cli",
    command: ["gh", "workflow", "run", workflowFile, "--repo", "example/repo", "--ref", "dev"],
    providerExecutable,
    providerAuthorizationExecutable: providerExecutable,
    providerAuthorization,
    exitCode: 23,
    dispatchState: "sent",
    workflowRun
  };
  const action = {
    schemaVersion: 1,
    tokenHash,
    status: "spent",
    outcome: "pending",
    runId: run.runId,
    action: "actions.dispatch",
    provider: "github-cli",
    resource,
    remoteRevision,
    attemptId,
    idempotencyKey,
    dispatchRepository: "github.com/example/repo",
    workflowFile,
    dispatchRef: "dev",
    dispatchNonce,
    dispatchInputs: inputs,
    dispatchInputsDigest: digestObject(inputs),
    workflowDispatchCapability,
    workflowDispatchCapabilityDigest: digestObject(workflowDispatchCapability),
    dispatchCommand: providerInvocation.command,
    providerExecutable,
    providerAuthorizationExecutable: providerExecutable,
    providerAuthorization,
    providerInvocation
  };
  await writeFile(path.join(runDir, "actions", `${tokenHash}.json`), `${JSON.stringify(action)}\n`);
  const receipt = buildActionsDispatchProviderReceipt(action, "failure");
  const actionReceipt = {
    action: action.action,
    provider: action.provider,
    resource,
    outcome: "failure",
    runId: run.runId,
    attemptId,
    idempotencyKey,
    remoteRevision,
    providerReceipt: receipt
  };
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath}`;
  try {
    await writeFile(
      path.join(runDir, "actions", `${tokenHash}.json`),
      `${JSON.stringify({
        ...action,
        providerInvocation: { ...providerInvocation, providerAuthorizationExecutable: undefined }
      })}\n`
    );
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "failure", actionReceipt),
      /governed provider wrapper/
    );
    await writeFile(path.join(runDir, "actions", `${tokenHash}.json`), `${JSON.stringify(action)}\n`);
    await writeFile(responsePath, `${JSON.stringify({
      databaseId: 12345,
      workflowName: "Release",
      url: workflowRun.url,
      status: "completed",
      conclusion: "success",
      headSha: remoteRevision,
      displayTitle: workflowRun.displayTitle
    })}\n`);
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "failure", actionReceipt),
      /Provider receipt digests|completed non-success|does not match provider state/
    );
    await writeFile(responsePath, `${JSON.stringify({
      databaseId: 12345,
      workflowName: "Release",
      url: workflowRun.url,
      status: "completed",
      conclusion: "failure",
      headSha: remoteRevision,
      displayTitle: workflowRun.displayTitle
    })}\n`);
    const reconciled = await reconcileAction(root, run.runId, attemptId, "failure", actionReceipt);
    assert.equal(reconciled.outcome, "failure");
    assert.equal(reconciled.receipt.providerReceipt.terminalState, "failure");
  } finally {
    process.env.PATH = priorPath;
  }
});

test("GitHub Actions dispatch observation lower bound uses provider-start time", async () => {
  const providerStartedAt = "2026-08-15T00:00:00.000Z";
  const providerReturnedAt = "2026-08-15T00:00:20.000Z";
  const runCreatedAt = "2026-08-15T00:00:05.000Z";
  const lowerBoundAtProviderStart = workflowDispatchMinimumCreatedAt(providerStartedAt);
  const lowerBoundAtProviderReturn = workflowDispatchMinimumCreatedAt(providerReturnedAt);

  assert.ok(Date.parse(runCreatedAt) >= lowerBoundAtProviderStart);
  assert.ok(Date.parse(runCreatedAt) < lowerBoundAtProviderReturn);

  const source = await readFile(new URL("../lib/core.mjs", import.meta.url), "utf8");
  const providerStartIndex = source.indexOf("dispatchObservationStartedAt = nowIso();");
  const preCallPersistIndex = source.indexOf("observationStartedAt: dispatchObservationStartedAt", providerStartIndex);
  const providerCallIndex = source.indexOf("await execBoundGitHubCli(providerExecutablePath, expectedCommand.slice(1)");
  const observationIndex = source.indexOf("dispatchObservationStartedAt\n      );", providerCallIndex);
  assert.ok(providerStartIndex >= 0);
  assert.ok(preCallPersistIndex > providerStartIndex);
  assert.ok(preCallPersistIndex < providerCallIndex);
  assert.ok(providerCallIndex > providerStartIndex);
  assert.ok(observationIndex > providerCallIndex);
});

test("GitHub Actions dispatch reconciliation resumes an indeterminate observation exactly once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-actions-dispatch-resume-"));
  const repository = path.join(root, "repository");
  const bin = path.join(root, "bin");
  await mkdir(repository, { recursive: true });
  await mkdir(bin, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "dev"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "dispatch resume\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "dispatch resume baseline"], { cwd: repository });
  const run = await createRun({
    root,
    contract: contract({ authority: ["actions.dispatch"], remoteRevision: "a".repeat(40) }),
    requestedMode: "verified",
    cwd: repository
  });
  const runDir = path.join(root, "runs", run.runId);
  const actionDir = path.join(runDir, "actions");
  await mkdir(actionDir, { recursive: true });
  const tokenHash = sha256("dispatch-resume-token");
  const attemptId = "dispatch-resume-attempt";
  const dispatchNonce = "b".repeat(32);
  const remoteRevision = "a".repeat(40);
  const dispatchedAt = new Date(Date.now() - 1_000).toISOString();
  const createdAt = new Date().toISOString();
  const workflowRun = {
    databaseId: 54321,
    workflowName: "Release",
    url: "https://github.com/example/repo/actions/runs/54321",
    status: "completed",
    conclusion: "success",
    headSha: remoteRevision,
    headBranch: "dev",
    createdAt,
    startedAt: createdAt,
    displayTitle: `Release ${dispatchNonce}`
  };
  const listPath = path.join(root, "workflow-runs.json");
  const viewPath = path.join(root, "workflow-run.json");
  await writeFile(listPath, `${JSON.stringify([workflowRun])}\n`);
  await writeFile(viewPath, `${JSON.stringify(workflowRun)}\n`);
  const ghScript = `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  printf '%s\\n' '{"login":"alice"}'
elif [ "$1" = "api" ] && [ "$2" = "repos/example/repo" ]; then
  printf '%s\\n' '{"full_name":"example/repo","permissions":{"admin":false,"maintain":false,"push":true}}'
elif [ "$1" = "run" ] && [ "$2" = "list" ]; then
  sleep 0.2
  cat ${JSON.stringify(listPath)}
elif [ "$1" = "run" ] && [ "$2" = "view" ]; then
  cat ${JSON.stringify(viewPath)}
else
  exit 9
fi
`;
  const fakeGh = path.join(bin, "gh");
  await writeFile(fakeGh, ghScript, { mode: 0o700 });
  const providerExecutable = { path: await realpath(fakeGh), digest: sha256(ghScript) };
  const providerAuthorization = {
    provider: "github-cli",
    repository: "github.com/example/repo",
    actor: "alice",
    permissions: { admin: false, maintain: false, push: true }
  };
  const action = {
    schemaVersion: 1,
    tokenHash,
    status: "spent",
    outcome: "pending",
    runId: run.runId,
    action: "actions.dispatch",
    provider: "github-cli",
    resource: "workflow:.github/workflows/release.yml",
    remoteRevision,
    attemptId,
    idempotencyKey: "dispatch-resume-idempotency",
    dispatchRepository: "github.com/example/repo",
    workflowFile: ".github/workflows/release.yml",
    dispatchRef: "dev",
    dispatchNonce,
    dispatchInputs: { sbw_dispatch_nonce: dispatchNonce, sbw_expected_revision: remoteRevision },
    dispatchCommand: ["gh", "workflow", "run", ".github/workflows/release.yml", "--repo", "example/repo", "--ref", "dev"],
    providerExecutable,
    providerAuthorizationExecutable: providerExecutable,
    providerAuthorization,
    providerInvocation: {
      schemaVersion: 1,
      id: `github-actions-dispatch-wrapper:${run.runId}:${attemptId}`,
      actionAttemptId: attemptId,
      provider: "github-cli",
      command: ["gh", "workflow", "run", ".github/workflows/release.yml", "--repo", "example/repo", "--ref", "dev"],
      providerExecutable,
      providerAuthorizationExecutable: providerExecutable,
      providerAuthorization,
      startedAt: dispatchedAt,
      finishedAt: dispatchedAt,
      exitCode: null,
      dispatchState: "sent-or-indeterminate",
      preexistingRunIds: ["100"],
      observationStartedAt: dispatchedAt,
      errorDigest: sha256("observation timeout")
    }
  };
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${priorPath}`;
  try {
    await writeFile(path.join(actionDir, `${tokenHash}.json`), `${JSON.stringify(action)}\n`);
    await writeFile(path.join(actionDir, `${tokenHash}.json`), `${JSON.stringify({
      ...action,
      providerInvocation: {
        ...action.providerInvocation,
        dispatchState: "preflight",
        finishedAt: action.providerInvocation.startedAt,
        preexistingRunIds: [],
        errorDigest: undefined,
        workflowRun: undefined
      }
    })}\n`);
    const recoveredNotSent = await resumeActionsDispatchObservation(root, run.runId, attemptId);
    assert.equal(recoveredNotSent.providerInvocation.dispatchState, "not-sent");
    assert.equal(recoveredNotSent.providerInvocation.exitCode, null);
    assert.match(recoveredNotSent.providerInvocation.errorDigest, /^[a-f0-9]{64}$/);

    await writeFile(path.join(actionDir, `${tokenHash}.json`), `${JSON.stringify(action)}\n`);
    const promoted = await resumeActionsDispatchObservation(root, run.runId, attemptId);
    assert.equal(promoted.providerInvocation.dispatchState, "sent");
    assert.equal(promoted.providerInvocation.workflowRun.databaseId, 54321);
    assert.equal(promoted.providerInvocation.errorDigest, undefined);

    await writeFile(path.join(actionDir, `${tokenHash}.json`), `${JSON.stringify({
      ...action,
      providerInvocation: { ...action.providerInvocation, exitCode: undefined }
    })}\n`);
    await assert.rejects(
      resumeActionsDispatchObservation(root, run.runId, attemptId),
      /recorded provider exit code and dispatch timestamp/
    );

    await writeFile(listPath, `${JSON.stringify([workflowRun, { ...workflowRun, databaseId: 54322 }])}\n`);
    await writeFile(path.join(actionDir, `${tokenHash}.json`), `${JSON.stringify({
      ...action,
      providerInvocation: { ...action.providerInvocation }
    })}\n`);
    await assert.rejects(
      resumeActionsDispatchObservation(root, run.runId, attemptId),
      /more than one unclaimed matching run/
    );
    const persisted = JSON.parse(await readFile(path.join(actionDir, `${tokenHash}.json`), "utf8"));
    assert.equal(persisted.providerInvocation.dispatchState, "sent-or-indeterminate");
    assert.equal(persisted.providerInvocation.workflowRun, undefined);

    await writeFile(listPath, `${JSON.stringify([workflowRun])}\n`);
    await writeFile(path.join(actionDir, `${tokenHash}.json`), `${JSON.stringify(action)}\n`);
    let mutationResolve;
    const mutationDone = new Promise((resolve) => { mutationResolve = resolve; });
    const mutationTimer = setTimeout(async () => {
      await writeFile(path.join(actionDir, `${tokenHash}.json`), `${JSON.stringify({
        ...action,
        providerInvocation: { ...action.providerInvocation, errorDigest: sha256("concurrent-provider-writer") }
      })}\n`);
      mutationResolve();
    }, 50);
    await assert.rejects(
      resumeActionsDispatchObservation(root, run.runId, attemptId),
      /changed during resumable reconciliation/
    );
    await mutationDone;
    clearTimeout(mutationTimer);
    const raced = JSON.parse(await readFile(path.join(actionDir, `${tokenHash}.json`), "utf8"));
    assert.equal(raced.providerInvocation.errorDigest, sha256("concurrent-provider-writer"));
  } finally {
    process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub Actions dispatch invocation failure stays indeterminate and rejects without retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-actions-dispatch-invocation-failure-"));
  const repository = path.join(root, "repository");
  const bin = path.join(root, "bin");
  await mkdir(path.join(repository, ".github", "workflows"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "codex/dispatch-failure"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], { cwd: repository });
  const workflowFile = ".github/workflows/release.yml";
  await writeFile(path.join(repository, workflowFile), [
    "name: Release",
    "run-name: Release ${{ inputs.sbw_dispatch_nonce }}",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      sbw_dispatch_nonce:",
    "        required: true",
    "        type: string",
    "      sbw_expected_revision:",
    "        required: true",
    "        type: string",
    "jobs:",
    "  release:",
    "    if: github.sha == inputs.sbw_expected_revision",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo release"
  ].join("\n") + "\n");
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "dispatch failure fixture"], { cwd: repository });
  const remoteRevision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const taskContract = contract({
    authority: ["actions.dispatch"],
    remoteRevision,
    templateDefinition: {
      requiredEvidence: ["remote-authorization"],
      acceptance: [{ id: "done", description: "Dispatch failure is bounded.", critical: true }]
    }
  });
  const run = await createRun({ root, contract: taskContract, requestedMode: "verified", cwd: repository });
  const resource = `workflow:${workflowFile}`;
  await addEvidence(root, run.runId, {
    id: "dispatch-remote-authorization",
    kind: "remote-authorization",
    summary: "Dispatch provider authorization",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: sha256(`remote-authorization:actions.dispatch:${remoteRevision}`),
    receipt: {
      producer: "github-cli",
      payload: {
        action: "actions.dispatch",
        provider: "github-cli",
        resource,
        remoteRevision,
        repository: "github.com/example/repo",
        actor: "alice"
      }
    }
  });
  await updateState(root, run.runId, (state) => ({
    ...state,
    lastSentinel: { label: "dispatch-failure-test", digest: "tree" },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const fakeGh = path.join(bin, "gh");
  const fakeGhScript = `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  printf '%s\\n' '{"login":"alice"}'
elif [ "$1" = "api" ] && [ "$2" = "repos/example/repo" ]; then
  printf '%s\\n' '{"full_name":"example/repo","permissions":{"admin":false,"maintain":false,"push":true}}'
elif [ "$1" = "api" ] && [ "$2" = "repos/example/repo/commits/dev" ]; then
  printf '%s\\n' '{"sha":"${remoteRevision}"}'
elif [ "$1" = "run" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[]'
elif [ "$1" = "workflow" ] && [ "$2" = "run" ]; then
  printf '%s\\n' 'provider dispatch failed before acceptance' >&2
  exit 23
else
  exit 9
fi
`;
  await writeFile(fakeGh, fakeGhScript, { mode: 0o700 });
  const providerExecutable = { path: await realpath(fakeGh), digest: sha256(fakeGhScript) };
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath}`;
  try {
    await assert.rejects(
      issueActionToken(root, run.runId, {
        action: "actions.dispatch",
        provider: "github-cli",
        resource,
        scope: "dev",
        workflowFile,
        dispatchInputs: { release_token: "ghp_1234567890abcdefghijklmnopqrstuvwxyz" },
        remoteRevision,
        requiredEvidence: ["remote-authorization"]
      }, "tree", await loadDefaults()),
      /workflow input must be non-sensitive/
    );
    for (const sensitiveKey of ["releaseToken", "apiKey", "accessToken", "clientSecret", "passwordValue"]) {
      await assert.rejects(
        issueActionToken(root, run.runId, {
          action: "actions.dispatch",
          provider: "github-cli",
          resource,
          scope: "dev",
          workflowFile,
          dispatchInputs: { [sensitiveKey]: "opaque-value" },
          remoteRevision,
          requiredEvidence: ["remote-authorization"]
        }, "tree", await loadDefaults()),
        /workflow input must be non-sensitive/
      );
    }
    assert.deepEqual((await inspectRun(root, run.runId)).actions, []);
    const issued = await issueActionToken(root, run.runId, {
      action: "actions.dispatch",
      provider: "github-cli",
      resource,
      scope: "dev",
      workflowFile,
      dispatchInputs: { environment: "test" },
      remoteRevision,
      requiredEvidence: ["remote-authorization"]
    }, "tree", await loadDefaults());
    assert.equal(issued.providerExecutable.path, providerExecutable.path);
    let failure;
    await assert.rejects(
      executeActionToken(root, run.runId, issued.token, "tree"),
      (error) => {
        failure = error;
        return error.code === "SBW_ACTIONS_DISPATCH_INDETERMINATE" &&
          error.providerInvocation?.dispatchState === "sent-or-indeterminate" &&
          error.providerInvocation?.exitCode === 23;
      }
    );
    assert.match(failure.message, /automatic retry is prohibited/);
    const action = (await inspectRun(root, run.runId)).actions.find((item) => item.tokenHash === sha256(issued.token));
    assert.equal(action.status, "spent");
    assert.equal(action.outcome, "pending");
    assert.equal(action.providerInvocation.dispatchState, "sent-or-indeterminate");
    assert.equal(action.providerInvocation.exitCode, 23);
    assert.match(action.providerInvocation.errorDigest, /^[a-f0-9]{64}$/);
    await assert.rejects(
      executeActionToken(root, run.runId, issued.token, "tree"),
      /Action token was already consumed/
    );
  } finally {
    process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub Actions dispatch final ref drift is explicitly not-sent before provider invocation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-actions-dispatch-ref-drift-"));
  const repository = path.join(root, "repository");
  const bin = path.join(root, "bin");
  await mkdir(path.join(repository, ".github", "workflows"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "codex/ref-drift"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], { cwd: repository });
  const workflowFile = ".github/workflows/release.yml";
  await writeFile(path.join(repository, workflowFile), [
    "name: Release",
    "run-name: Release ${{ inputs.sbw_dispatch_nonce }}",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      sbw_dispatch_nonce:",
    "        required: true",
    "        type: string",
    "      sbw_expected_revision:",
    "        required: true",
    "        type: string",
    "jobs:",
    "  release:",
    "    if: github.sha == inputs.sbw_expected_revision",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo release"
  ].join("\n") + "\n");
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "dispatch ref drift fixture"], { cwd: repository });
  const remoteRevision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const driftRevision = "b".repeat(40);
  const taskContract = contract({
    authority: ["actions.dispatch"],
    remoteRevision,
    templateDefinition: {
      requiredEvidence: ["remote-authorization"],
      acceptance: [{ id: "done", description: "Dispatch ref drift is not sent.", critical: true }]
    }
  });
  const run = await createRun({ root, contract: taskContract, requestedMode: "verified", cwd: repository });
  const resource = `workflow:${workflowFile}`;
  await addEvidence(root, run.runId, {
    id: "dispatch-ref-drift-remote-authorization",
    kind: "remote-authorization",
    summary: "Dispatch provider authorization",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: sha256(`remote-authorization:actions.dispatch:${remoteRevision}`),
    receipt: {
      producer: "github-cli",
      payload: {
        action: "actions.dispatch",
        provider: "github-cli",
        resource,
        remoteRevision,
        repository: "github.com/example/repo",
        actor: "alice"
      }
    }
  });
  await updateState(root, run.runId, (state) => ({
    ...state,
    lastSentinel: { label: "dispatch-ref-drift-test", digest: "tree" },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const refCountPath = path.join(root, "ref-count");
  const providerCallPath = path.join(root, "provider-call");
  const fakeGh = path.join(bin, "gh");
  const fakeGhScript = `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  printf '%s\\n' '{"login":"alice"}'
elif [ "$1" = "api" ] && [ "$2" = "repos/example/repo" ]; then
  printf '%s\\n' '{"full_name":"example/repo","permissions":{"admin":false,"maintain":false,"push":true}}'
elif [ "$1" = "api" ] && [ "$2" = "repos/example/repo/commits/dev" ]; then
  count=0
  if [ -f ${JSON.stringify(refCountPath)} ]; then count=$(cat ${JSON.stringify(refCountPath)}); fi
  count=$((count + 1))
  printf '%s' "$count" > ${JSON.stringify(refCountPath)}
  if [ "$count" -ge 3 ]; then
    printf '%s\\n' '{"sha":"${driftRevision}"}'
  else
    printf '%s\\n' '{"sha":"${remoteRevision}"}'
  fi
elif [ "$1" = "run" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[]'
elif [ "$1" = "workflow" ] && [ "$2" = "run" ]; then
  : > ${JSON.stringify(providerCallPath)}
else
  exit 9
fi
`;
  await writeFile(fakeGh, fakeGhScript, { mode: 0o700 });
  const providerExecutable = { path: await realpath(fakeGh), digest: sha256(fakeGhScript) };
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath}`;
  try {
    const issued = await issueActionToken(root, run.runId, {
      action: "actions.dispatch",
      provider: "github-cli",
      resource,
      scope: "dev",
      workflowFile,
      dispatchInputs: { environment: "test" },
      remoteRevision,
      requiredEvidence: ["remote-authorization"]
    }, "tree", await loadDefaults());
    assert.equal(issued.providerExecutable.path, providerExecutable.path);
    await assert.rejects(
      executeActionToken(root, run.runId, issued.token, "tree"),
      /GitHub Actions dispatch ref changed immediately before provider invocation/
    );
    const action = (await inspectRun(root, run.runId)).actions.find((item) => item.tokenHash === sha256(issued.token));
    assert.equal(action.status, "spent");
    assert.equal(action.outcome, "pending");
    assert.equal(action.providerInvocation.dispatchState, "not-sent");
    assert.equal(action.providerInvocation.exitCode, null);
    await assert.rejects(access(providerCallPath));
  } finally {
    process.env.PATH = priorPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub Actions dispatch capability requires nonce-aware workflow metadata", () => {
  const revision = "a".repeat(40);
  const workflow = [
    "name: Release",
    "run-name: Release ${{ inputs.sbw_dispatch_nonce }}",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      sbw_dispatch_nonce:",
    "        required: true",
    "        type: string",
    "      sbw_expected_revision:",
    "        required: true",
    "        type: string",
    "jobs:",
    "  release:",
    "    runs-on: ubuntu-latest",
    "    if: ${{ github.sha == inputs.sbw_expected_revision }}"
  ].join("\n");
  const capability = validateWorkflowDispatchCapability(
    workflow,
    ".github/workflows/release.yml",
    revision
  );
  assert.equal(capability.nonceInput, "sbw_dispatch_nonce");
  assert.equal(capability.runNameNonce, true);
  assert.match(capability.contentDigest, /^[a-f0-9]{64}$/);
  const nonceBlock = "      sbw_dispatch_nonce:\n        required: true\n        type: string\n";
  const revisionBlock = "      sbw_expected_revision:\n        required: true\n        type: string\n";
  assert.doesNotThrow(() => validateWorkflowDispatchCapability(
    workflow.replace(`${nonceBlock}${revisionBlock}`, `${revisionBlock}${nonceBlock}`),
    ".github/workflows/release.yml",
    revision
  ));
  assert.throws(
    () => validateWorkflowDispatchCapability(
      workflow.replace("  release:", "  \"ev\\u0069l\":"),
      ".github/workflows/release.yml",
      revision
    ),
    /unsupported or unparsed jobs mapping entry/
  );
  assert.throws(
    () => validateWorkflowDispatchCapability(
      workflow.replace("jobs:", "\"jo\\u0062s\":"),
      ".github/workflows/release.yml",
      revision
    ),
    /unsupported or unparsed top-level mapping entry|jobs block/
  );
  assert.throws(
    () => validateWorkflowDispatchCapability(
      workflow.replace("  workflow_dispatch:", "  workflow_dispatch: {inputs: {}}"),
      ".github/workflows/release.yml",
      revision
    ),
    /flow mappings and sequences/
  );
  assert.throws(
    () => validateWorkflowDispatchCapability(
      workflow.replace("name: Release", "name: !str Release"),
      ".github/workflows/release.yml",
      revision
    ),
    /YAML tags/
  );
  const ordinaryBlock = "      ordinary_input:\n        required: false\n        type: string\n";
  for (const variant of [
    workflow.replace("      sbw_dispatch_nonce:", ordinaryBlock + "      sbw_dispatch_nonce:"),
    workflow.replace("      sbw_expected_revision:", ordinaryBlock + "      sbw_expected_revision:"),
    workflow.replace("jobs:", ordinaryBlock + "jobs:")
  ]) {
    assert.doesNotThrow(() => validateWorkflowDispatchCapability(
      variant,
      ".github/workflows/release.yml",
      revision
    ));
  }
  for (const replacement of [
    ["        type: string", "        type: boolean"],
    ["        type: string", "        type: choice\n        options:\n          - safe"],
    ["        type: string", "        type: number"]
  ]) {
    assert.throws(
      () => validateWorkflowDispatchCapability(
        workflow.replace(...replacement),
        ".github/workflows/release.yml",
        revision
      ),
      /required: true and type: string|incompatible schema/
    );
  }
  assert.throws(
    () => validateWorkflowDispatchCapability(
      workflow.replace(
        "      sbw_dispatch_nonce:\n        required: true\n        type: string",
        "      sbw_dispatch_nonce: true"
      ),
      ".github/workflows/release.yml",
      revision
    ),
    /nested string schema/
  );
  assert.throws(
    () => validateWorkflowDispatchCapability(
      workflow.replace("workflow_dispatch:", "push:"),
      ".github/workflows/release.yml",
      revision
    ),
    /workflow_dispatch/
  );
  assert.throws(
    () => validateWorkflowDispatchCapability(
      workflow.replace("sbw_dispatch_nonce", "other_input"),
      ".github/workflows/release.yml",
      revision
    ),
    /reserved sbw_dispatch_nonce|run-name/
  );
  assert.throws(
    () => validateWorkflowDispatchCapability(
      workflow.replace("github.sha == inputs.sbw_expected_revision", "github.sha != inputs.sbw_expected_revision"),
      ".github/workflows/release.yml",
      revision
    ),
    /exact sbw_expected_revision gate/
  );
  assert.throws(
    () => validateWorkflowDispatchCapability(
      workflow.replace("    if: ${{ github.sha == inputs.sbw_expected_revision }}", "    # if: ${{ github.sha == inputs.sbw_expected_revision }}"),
      ".github/workflows/release.yml",
      revision
    ),
    /exact sbw_expected_revision gate/
  );
  assert.throws(
    () => validateWorkflowDispatchCapability(
      `${workflow}\njobs:\n  duplicate:\n    if: \${{ github.sha == inputs.sbw_expected_revision }}`,
      ".github/workflows/release.yml",
      revision
    ),
    /duplicate top-level key: jobs/
  );
  assert.throws(
    () => validateWorkflowDispatchCapability(
      workflow.replace("  workflow_dispatch:", "  workflow_dispatch:\n  workflow_dispatch:"),
      ".github/workflows/release.yml",
      revision
    ),
    /duplicate on block key: workflow_dispatch/
  );
  assert.throws(
    () => validateWorkflowDispatchCapability(
      workflow.replace("      sbw_dispatch_nonce:", "      sbw_dispatch_nonce:\n      sbw_dispatch_nonce:"),
      ".github/workflows/release.yml",
      revision
    ),
    /duplicate workflow_dispatch input key: sbw_dispatch_nonce/
  );
  assert.throws(
    () => validateWorkflowDispatchCapability(
      workflow.replace("jobs:", "jobs: &shared_jobs"),
      ".github/workflows/release.yml",
      revision
    ),
    /anchors, aliases, and merge keys are unsupported/
  );
  assert.throws(
    () => validateWorkflowDispatchCapability(
      workflow.replace("run-name: Release ${{ inputs.sbw_dispatch_nonce }}", "run-name: Release # ${{ inputs.sbw_dispatch_nonce }}"),
      ".github/workflows/release.yml",
      revision
    ),
    /run-name/
  );
});

test("contract-deferred actions fail closed in the core lifecycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-deferred-action-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "deferred action\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=sbw@example.invalid", "-c", "user.name=SBW Test", "commit", "-qm", "baseline"], { cwd: root });
  const deferredTemplate = {
    ...template(),
    controlPlane: {
      evidencePolicy: "typed-v1",
      ledgerPolicy: "ledger-v1",
      reviewPolicy: "none",
      designPacketPolicy: "none",
      refinementPolicy: "none",
      deliberationPolicy: "none"
    },
    executionStages: [{
      id: "preflight",
      goal: "preflight",
      dependsOn: [],
      requiredEvidence: ["preflight"],
      attemptBudget: 3,
      kind: "regular"
    }],
    actionStages: {},
    actionGates: {},
    deferredActions: ["workflow.dispatch", "deploy"]
  };
  const run = await createRun({
    root,
    contract: buildContract({
      template: "deferred-test",
      templateDefinition: deferredTemplate,
      goal: "deferred action lifecycle",
      scope: ["."],
      risk: { risk: 2, uncertainty: 2, blastRadius: 2, irreversibility: 2, evidenceGap: 2 },
      sensitivity: "internal",
      authority: ["deploy"],
      remoteRevision: "abc"
    }),
    requestedMode: "critical",
    cwd: root
  });
  await assert.rejects(
    issueActionToken(root, run.runId, {
      action: "deploy",
      provider: "github",
      resource: "workflow:1",
      remoteRevision: "abc",
      requiredEvidence: ["preflight"]
    }, "tree", await loadDefaults()),
    /action is deferred until its provider adapter is implemented/
  );
  const inspected = await inspectRun(root, run.runId);
  const tokenHash = sha256("deferred-token");
  await writeFile(path.join(root, "runs", run.runId, "actions", `${tokenHash}.json`), `${JSON.stringify({
    schemaVersion: 1,
    tokenHash,
    status: "issued",
    outcome: null,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    runId: run.runId,
    action: "deploy",
    provider: "github",
    resource: "workflow:1",
    remoteRevision: "abc",
    treeDigest: "tree",
    contractDigest: digestObject(inspected.contract),
    idempotencyKey: "deferred-idempotency"
  })}\n`);
  await assert.rejects(
    consumeActionToken(root, run.runId, "deferred-token", "tree"),
    /action is deferred until its provider adapter is implemented/
  );
  const completion = await evaluateCompletion(root, run.runId);
  assert.ok(completion.blockers.includes("deferred-governed-action:deploy"));
});

test("required-check probes require a bound executable identity and reject path drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-required-check-provider-"));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const fakeGh = path.join(bin, "gh");
  const script = "#!/bin/sh\nexit 0\n";
  await writeFile(fakeGh, script);
  await chmod(fakeGh, 0o755);
  const identity = { path: await realpath(fakeGh), digest: sha256(script) };
  const payload = { provider: "github", repository: "github.com/example/repo" };
  await assert.rejects(
    verifyRequiredChecksProvider(root, payload),
    /recorded executable identity/
  );
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath}`;
  try {
    await writeFile(fakeGh, `${script}# drift\n`);
    await assert.rejects(
      verifyRequiredChecksProvider(root, payload, identity),
      /governed provider executable changed/
    );
  } finally {
    process.env.PATH = priorPath;
  }
});

test("failed PR creation preserves its reservation until provider absence is proven", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-pr-failure-absence-"));
  const repository = path.join(root, "repository");
  const bin = path.join(root, "bin");
  await mkdir(repository, { recursive: true });
  await mkdir(bin, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "pr failure\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: repository });
  const run = await createRun({
    root,
    contract: contract({ authority: ["pr.create"] }),
    requestedMode: "verified",
    cwd: repository
  });
  const runDir = path.join(root, "runs", run.runId);
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const tokenHash = sha256("pr-failure-token");
  const attemptId = "pr-failure-attempt";
  const idempotencyKey = "pr-failure-idempotency";
  const resource = "pull/new";
  const creationReservation = {
    provider: "github-cli",
    repository: "github.com/example/repo",
    action: "pr.create",
    resource
  };
  const action = {
    schemaVersion: 1,
    tokenHash,
    status: "spent",
    outcome: "unknown",
    runId: run.runId,
    action: "pr.create",
    provider: "github-cli",
    resource,
    remoteRevision: "abc",
    attemptId,
    idempotencyKey,
    expectedHead: head,
    targetRef: "dev",
    headBranch: "codex/feature",
    createRepository: "github.com/example/repo",
    creationReservation,
    providerAuthorization: {
      provider: "github-cli",
      repository: "github.com/example/repo",
      actor: "alice",
      permissions: { admin: false, maintain: false, push: true }
    },
    providerExecutable: null,
    providerInvocation: { dispatchState: "sent-or-indeterminate" },
    creationPrecondition: { action: "pr.create", resource, state: "absent", number: null }
  };
  await writeFile(path.join(runDir, "actions", `${tokenHash}.json`), `${JSON.stringify(action)}\n`);
  const reservationPath = path.join(root, "creation-reservations", `${creationReservationKey(creationReservation)}.json`);
  await mkdir(path.dirname(reservationPath), { recursive: true });
  await writeFile(reservationPath, `${JSON.stringify({
    runId: run.runId,
    ...creationReservation,
    reservationKey: creationReservationKey(creationReservation),
    resource,
    tokenHash,
    reservedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  })}\n`);
  const responsePath = path.join(root, "fake-pr-list.json");
  const actorPath = path.join(root, "fake-gh-actor.txt");
  const pushPath = path.join(root, "fake-gh-push.txt");
  const argsPath = path.join(root, "fake-gh-args.txt");
  const fakeGh = path.join(bin, "gh");
  await writeFile(responsePath, "[[{\"number\":99,\"headRefOid\":\"other\",\"baseRefName\":\"dev\",\"url\":\"https://example.invalid/pull/99\"}]]\n");
  await writeFile(actorPath, "alice\n");
  await writeFile(pushPath, "true\n");
  const ghScript = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(argsPath)}
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  printf '{"login":"%s"}\\n' "$(cat ${JSON.stringify(actorPath)})"
elif [ "$1" = "api" ] && [ "$2" = "repos/example/repo" ]; then
  printf '{"full_name":"example/repo","permissions":{"admin":false,"maintain":false,"push":%s}}\\n' "$(cat ${JSON.stringify(pushPath)})"
else
  cat ${JSON.stringify(responsePath)}
fi
`;
  await writeFile(fakeGh, ghScript);
  await chmod(fakeGh, 0o755);
  action.providerExecutable = { path: await realpath(fakeGh), digest: sha256(ghScript) };
  await writeFile(path.join(runDir, "actions", `${tokenHash}.json`), `${JSON.stringify(action)}\n`);
  const receipt = {
    action: "pr.create",
    provider: "github-cli",
    resource,
    outcome: "failure",
    runId: run.runId,
    attemptId,
    idempotencyKey,
    remoteRevision: "abc",
    providerReceipt: {
      action: "pr.create",
      provider: "github-cli",
      resource,
      outcome: "failure",
      runId: run.runId,
      attemptId,
      idempotencyKey,
      remoteRevision: "abc",
      executionId: "github:example/repo:pr.create:failure",
      proofKind: "github-pr-create",
      requestDigest: "0".repeat(64),
      responseDigest: "1".repeat(64),
      verifiedAt: new Date().toISOString(),
      terminalState: "failure"
    }
  };
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath}`;
  try {
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "failure", receipt),
      /existing pull request; preserve the reservation/
    );
    await stat(reservationPath);
    await writeFile(actorPath, "mallory\n");
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "failure", receipt),
      /actor or permissions changed/
    );
    await stat(reservationPath);
    await writeFile(actorPath, "alice\n");
    await writeFile(fakeGh, `${ghScript}\n# executable drift\n`);
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "failure", receipt),
      /governed provider executable changed/
    );
    await stat(reservationPath);
    await writeFile(fakeGh, ghScript);
    await execFileAsync("git", ["remote", "set-url", "origin", "https://github.com/other/repo.git"], { cwd: repository });
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "failure", receipt),
      /origin repository changed/
    );
    await stat(reservationPath);
    await execFileAsync("git", ["remote", "set-url", "origin", "https://github.com/example/repo.git"], { cwd: repository });
    assert.match(await readFile(argsPath, "utf8"), /api --paginate --slurp repos\/example\/repo\/pulls\?state=all&head=example%3Acodex%2Ffeature&base=dev&per_page=100/);
    await writeFile(responsePath, "[[]]\n");
    const reconciled = await reconcileAction(root, run.runId, attemptId, "failure", receipt);
    assert.equal(reconciled.receipt.providerReceipt.failureAbsence.absent, true);
    await assert.rejects(stat(reservationPath));
  } finally {
    process.env.PATH = priorPath;
  }
});

test("unknown PR creation can recover the same attempt into canonical ownership after provider proof", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-pr-unknown-success-"));
  const repository = path.join(root, "repository");
  const bin = path.join(root, "bin");
  await mkdir(repository, { recursive: true });
  await mkdir(bin, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "recover PR\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: repository });
  const run = await createRun({
    root,
    contract: contract({ authority: ["pr.create"] }),
    requestedMode: "verified",
    cwd: repository
  });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const attemptId = "pr-recover-attempt";
  const idempotencyKey = "pr-recover-idempotency";
  const tokenHash = sha256("pr-recover-token");
  const remoteRevision = "c".repeat(40);
  const resource = "pull/new";
  const targetRef = "dev";
  const number = 17;
  const url = `https://github.com/example/repo/pull/${number}`;
  const creationReservation = {
    provider: "github-cli",
    repository: "github.com/example/repo",
    action: "pr.create",
    resource
  };
  const spentAt = new Date(Date.now() - 1000).toISOString();
  const createdAt = new Date().toISOString();
  const creationPrecondition = { action: "pr.create", resource, state: "absent", number: null };
  const marker = `sbw:${attemptId}:${idempotencyKey}`;
  const actionBase = {
    schemaVersion: 1,
    tokenHash,
    status: "spent",
    outcome: "pending",
    runId: run.runId,
    action: "pr.create",
    provider: "github-cli",
    resource,
    remoteRevision,
    attemptId,
    idempotencyKey,
    expectedHead: head,
    targetRef,
    headBranch: "codex/feature",
    createRepository: "github.com/example/repo",
    creationReservation,
    prTitle: "Better Workflows: recovery",
    prBodyPrefix: "Automated delivery.",
    creationPrecondition,
    providerAuthorization: {
      provider: "github-cli",
      repository: "github.com/example/repo",
      actor: "alice",
      permissions: { admin: false, maintain: false, push: true }
    },
    providerExecutable: null,
    spentAt
  };
  const providerInvocation = {
    id: `github-pr-create-wrapper:${run.runId}:${attemptId}`,
    provider: "github-cli",
    command: buildPrCreateCommand(actionBase),
    providerExecutable: actionBase.providerExecutable,
    providerAuthorization: actionBase.providerAuthorization,
    exitCode: 1
  };
  const action = { ...actionBase, providerInvocation };
  const providerReceipt = {
    action: "pr.create",
    provider: "github-cli",
    resource,
    outcome: "success",
    runId: run.runId,
    attemptId,
    idempotencyKey,
    remoteRevision,
    executionId: `github:github.com/example/repo:pr.create:${number}:${head}`,
    proofKind: "github-pr-create",
    requestDigest: digestObject({
      action: "pr.create",
      provider: "github-cli",
      resource,
      remoteRevision,
      repository: "github.com/example/repo",
      targetRef,
      expectedHead: head
    }),
    responseDigest: digestObject({ number, head, base: targetRef, url }),
    verifiedAt: createdAt,
    terminalState: "success",
    created: true,
    creationProof: {
      attemptId,
      idempotencyKey,
      marker,
      providerObjectId: "node-17",
      observedAt: createdAt
    },
    creationPreconditionDigest: digestObject(creationPrecondition),
    number,
    head,
    base: targetRef,
    url
  };
  const actionEvidence = {
    id: "pr-recovery-proof",
    kind: "preflight",
    summary: "Provider proof for recovered PR creation",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: "d".repeat(64),
    receipt: {
      payload: {
        actionProof: {
          schemaVersion: 1,
          runId: run.runId,
          actionAttemptId: attemptId,
          action: "pr.create",
          provider: "github-cli",
          resource,
          outcome: "success",
          idempotencyKey,
          remoteRevision,
          providerExecutionId: providerReceipt.executionId,
          providerReceiptDigest: digestObject(providerReceipt)
        },
        receipt: providerReceipt
      }
    }
  };
  const runDir = path.join(root, "runs", run.runId);
  await writeFile(path.join(runDir, "actions", `${tokenHash}.json`), `${JSON.stringify(action)}\n`);
  await mkdir(path.join(root, "creation-reservations"), { recursive: true });
  await writeFile(
    path.join(root, "creation-reservations", `${creationReservationKey(creationReservation)}.json`),
    `${JSON.stringify({
      ...creationReservation,
      reservationKey: creationReservationKey(creationReservation),
      runId: run.runId,
      tokenHash,
      reservedAt: spentAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })}\n`
  );
  const apiResponse = JSON.stringify({
    node_id: "node-17",
    created_at: createdAt,
    user: { login: "alice" },
    head: { sha: head },
    body: `<!-- ${marker} -->`,
    html_url: url
  });
  const prViewResponse = JSON.stringify({ number, headRefOid: head, baseRefName: targetRef, url });
  const fakeGh = path.join(bin, "gh");
  const ghScript = `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  printf '%s\\n' '{"login":"alice"}'
elif [ "$1" = "api" ] && [ "$2" = "repos/example/repo" ]; then
  printf '%s\\n' '{"full_name":"example/repo","permissions":{"admin":false,"maintain":false,"push":true}}'
elif [ "$1" = "api" ]; then
  printf '%s\\n' '${apiResponse}'
else
  printf '%s\\n' '${prViewResponse}'
fi
`;
  await writeFile(fakeGh, ghScript);
  await chmod(fakeGh, 0o755);
  const providerExecutable = { path: await realpath(fakeGh), digest: sha256(ghScript) };
  actionBase.providerExecutable = providerExecutable;
  providerInvocation.providerExecutable = providerExecutable;
  action.providerExecutable = providerExecutable;
  await writeFile(path.join(runDir, "actions", `${tokenHash}.json`), `${JSON.stringify(action)}\n`);
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath}`;
  try {
    await addEvidence(root, run.runId, actionEvidence);
    await reconcileAction(root, run.runId, attemptId, "unknown", {
      action: "pr.create",
      provider: "github-cli",
      resource,
      outcome: "unknown",
      runId: run.runId,
      attemptId,
      idempotencyKey,
      remoteRevision,
      providerReceipt: {
        action: "pr.create",
        provider: "github-cli",
        resource,
        outcome: "unknown",
        runId: run.runId,
        attemptId,
        idempotencyKey,
        remoteRevision,
        executionId: providerReceipt.executionId,
        proofKind: "github-pr-create",
        requestDigest: "0".repeat(64),
        responseDigest: "1".repeat(64),
        verifiedAt: createdAt,
        terminalState: "unknown",
        reason: "provider-timeout"
      }
    });
    const alternateExecutionId = `github:github.com/example/repo:pr.create:alternate:${head}`;
    const alternateExecutionPath = path.join(
      root,
      "provider-executions",
      `${sha256(alternateExecutionId)}.json`
    );
    await mkdir(path.dirname(alternateExecutionPath), { recursive: true });
    await writeFile(alternateExecutionPath, `${JSON.stringify({
      schemaVersion: 1,
      executionId: alternateExecutionId,
      runId: run.runId,
      attemptId,
      tokenHash,
      action: "pr.create",
      outcome: "success",
      recordedAt: new Date().toISOString()
    })}\n`);
    const unknownExecutionPath = path.join(
      root,
      "provider-executions",
      `${sha256(providerReceipt.executionId)}.json`
    );
    const unknownReservation = JSON.parse(await readFile(unknownExecutionPath, "utf8"));
    await writeFile(unknownExecutionPath, `${JSON.stringify({
      ...unknownReservation,
      supersededBy: alternateExecutionId,
      supersededAt: new Date().toISOString()
    })}\n`);
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "success", {
        action: "pr.create",
        provider: "github-cli",
        resource,
        outcome: "success",
        runId: run.runId,
        attemptId,
        idempotencyKey,
        remoteRevision,
        providerReceipt,
        evidenceIds: [actionEvidence.id]
      }),
      /superseded by another identity/
    );
    await writeFile(fakeGh, `${ghScript}\n# spoofed provider binary\n`);
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "success", {
        action: "pr.create",
        provider: "github-cli",
        resource,
        outcome: "success",
        runId: run.runId,
        attemptId,
        idempotencyKey,
        remoteRevision,
        providerReceipt,
        evidenceIds: [actionEvidence.id]
      }),
      /governed provider executable changed/
    );
    await writeFile(fakeGh, ghScript);
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "success", {
        action: "pr.create",
        provider: "github-cli",
        resource,
        outcome: "success",
        runId: run.runId,
        attemptId,
        idempotencyKey,
        remoteRevision,
        providerReceipt,
        evidenceIds: [actionEvidence.id]
      }),
      /superseded by another identity/
    );
    await unlink(alternateExecutionPath);
    const mismatchedActionId = `github:github.com/example/repo:other-action:${head}`;
    const mismatchedActionPath = path.join(
      root,
      "provider-executions",
      `${sha256(mismatchedActionId)}.json`
    );
    await writeFile(mismatchedActionPath, `${JSON.stringify({
      schemaVersion: 1,
      executionId: mismatchedActionId,
      runId: run.runId,
      attemptId,
      tokenHash,
      action: "other.action",
      outcome: "success",
      recordedAt: new Date().toISOString()
    })}\n`);
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "success", {
        action: "pr.create",
        provider: "github-cli",
        resource,
        outcome: "success",
        runId: run.runId,
        attemptId,
        idempotencyKey,
        remoteRevision,
        providerReceipt,
        evidenceIds: [actionEvidence.id]
      }),
      /bound to a different action/
    );
    await unlink(mismatchedActionPath);
    const providerExecutionPath = path.join(
      root,
      "provider-executions",
      `${sha256(providerReceipt.executionId)}.json`
    );
    await mkdir(path.dirname(providerExecutionPath), { recursive: true });
    await writeFile(providerExecutionPath, `${JSON.stringify({
      executionId: providerReceipt.executionId,
      runId: run.runId,
      attemptId,
      tokenHash,
      action: "pr.create",
      outcome: "failure",
      recordedAt: new Date().toISOString()
    })}\n`);
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "success", {
        action: "pr.create",
        provider: "github-cli",
        resource,
        outcome: "success",
        runId: run.runId,
        attemptId,
        idempotencyKey,
        remoteRevision,
        providerReceipt,
        evidenceIds: [actionEvidence.id]
      }),
      /Legacy provider execution reservation/
    );
    await writeFile(providerExecutionPath, `${JSON.stringify({
      schemaVersion: 1,
      executionId: providerReceipt.executionId,
      runId: run.runId,
      attemptId,
      tokenHash,
      action: "pr.create",
      outcome: "failure",
      recordedAt: new Date().toISOString()
    })}\n`);
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "success", {
        action: "pr.create",
        provider: "github-cli",
        resource,
        outcome: "success",
        runId: run.runId,
        attemptId,
        idempotencyKey,
        remoteRevision,
        providerReceipt,
        evidenceIds: [actionEvidence.id]
      }),
      /different terminal outcome/
    );
    await writeFile(providerExecutionPath, `${JSON.stringify({
      schemaVersion: 1,
      executionId: providerReceipt.executionId,
      runId: run.runId,
      attemptId,
      tokenHash,
      action: "pr.create",
      outcome: "success",
      recordedAt: new Date().toISOString()
    })}\n`);
    const recovered = await reconcileAction(root, run.runId, attemptId, "success", {
      action: "pr.create",
      provider: "github-cli",
      resource,
      outcome: "success",
      runId: run.runId,
      attemptId,
      idempotencyKey,
      remoteRevision,
      providerReceipt,
      evidenceIds: [actionEvidence.id]
    });
    assert.equal(recovered.outcome, "success");
    assert.equal(recovered.ownedResource, `pull/${number}`);
    const manifest = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8"));
    assert.equal(manifest.ownedResources[0].resource, `pull/${number}`);
    await assert.rejects(stat(path.join(root, "creation-reservations", `${creationReservationKey(creationReservation)}.json`)));
  } finally {
    process.env.PATH = priorPath;
  }
});

test("successful PR creation canonicalizes ownership and prevents a retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-pr-owned-canonicalization-"));
  const repository = path.join(root, "repository");
  const bin = path.join(root, "bin");
  await mkdir(repository, { recursive: true });
  await mkdir(bin, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "canonicalize\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: repository });
  await execFileAsync("git", ["switch", "-c", "codex/feature"], { cwd: repository });
  const run = await createRun({
    root,
    contract: contract({ authority: ["pr.create"] }),
    requestedMode: "verified",
    cwd: repository
  });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const attemptId = "pr-success-attempt";
  const idempotencyKey = "pr-success-idempotency";
  const tokenHash = sha256("pr-success-token");
  const remoteRevision = "b".repeat(40);
  const resource = "pull/new";
  const creationReservation = {
    provider: "github-cli",
    repository: "github.com/example/repo",
    action: "pr.create",
    resource
  };
  const ownedResource = "pull/12";
  const targetRef = "dev";
  const url = "https://github.com/example/repo/pull/12";
  const spentAt = new Date(Date.now() - 1000).toISOString();
  const createdAt = new Date().toISOString();
  const creationPrecondition = { action: "pr.create", resource, state: "absent", number: null };
  const marker = `sbw:${attemptId}:${idempotencyKey}`;
  const response = { number: 12, head, base: targetRef, url };
  const providerReceipt = {
    action: "pr.create",
    provider: "github-cli",
    resource,
    outcome: "success",
    runId: run.runId,
    attemptId,
    idempotencyKey,
    remoteRevision,
    executionId: `github:github.com/example/repo:pr.create:12:${head}`,
    proofKind: "github-pr-create",
    requestDigest: digestObject({
      action: "pr.create",
      provider: "github-cli",
      resource,
      remoteRevision,
      repository: "github.com/example/repo",
      targetRef,
      expectedHead: head
    }),
    responseDigest: digestObject(response),
    verifiedAt: createdAt,
    terminalState: "success",
    created: true,
    creationProof: {
      attemptId,
      idempotencyKey,
      marker,
      providerObjectId: "node-12",
      observedAt: createdAt
    },
    creationPreconditionDigest: digestObject(creationPrecondition),
    number: 12,
    head,
    base: targetRef,
    url
  };
  const action = {
    schemaVersion: 1,
    tokenHash,
    status: "spent",
    outcome: "success",
    runId: run.runId,
    action: "pr.create",
    provider: "github-cli",
    resource,
    remoteRevision,
    attemptId,
    idempotencyKey,
    expectedHead: head,
    targetRef,
    creationPrecondition,
    providerAuthorization: {
      provider: "github-cli",
      repository: "github.com/example/repo",
      actor: "alice",
      permissions: { admin: false, maintain: false, push: true }
    },
    createRepository: "github.com/example/repo",
    creationReservation,
    spentAt,
    receipt: { providerReceipt }
  };
  const runDir = path.join(root, "runs", run.runId);
  await writeFile(path.join(runDir, "actions", `${tokenHash}.json`), `${JSON.stringify(action)}\n`);
  const reservationPath = path.join(root, "creation-reservations", `${creationReservationKey(creationReservation)}.json`);
  await mkdir(path.dirname(reservationPath), { recursive: true });
  await writeFile(reservationPath, `${JSON.stringify({
    runId: run.runId,
    ...creationReservation,
    reservationKey: creationReservationKey(creationReservation),
    resource,
    tokenHash,
    reservedAt: spentAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  })}\n`);
  const fakeGh = path.join(bin, "gh");
  const apiResponse = JSON.stringify({
    node_id: "node-12",
    created_at: createdAt,
    user: { login: "alice" },
    head: { sha: head },
    body: `<!-- ${marker} -->`,
    html_url: url
  });
  const prViewResponse = JSON.stringify({ number: 12, headRefOid: head, baseRefName: targetRef, url });
  const ghScript = `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  printf '%s\\n' '{"login":"alice"}'
elif [ "$1" = "api" ] && [ "$2" = "repos/example/repo" ]; then
  printf '%s\\n' '{"full_name":"example/repo","permissions":{"admin":false,"maintain":false,"push":true}}'
elif [ "$1" = "api" ]; then
  printf '%s\\n' '${apiResponse}'
else
  printf '%s\\n' '${prViewResponse}'
fi
`;
  await writeFile(fakeGh, ghScript);
  await chmod(fakeGh, 0o755);
  action.providerExecutable = { path: await realpath(fakeGh), digest: sha256(ghScript) };
  await writeFile(path.join(runDir, "actions", `${tokenHash}.json`), `${JSON.stringify(action)}\n`);
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath}`;
  try {
    const registered = await registerOwnedResource(root, run.runId, {
      resource: ownedResource,
      creationReceipt: {
        ownerRunId: run.runId,
        runId: run.runId,
        resource: ownedResource,
        creationResource: resource,
        action: "pr.create",
        attemptId,
        idempotencyKey,
        remoteRevision,
        outcome: "success",
        provider: "github-cli",
        providerReceipt,
        evidenceIds: [],
        createdAt
      }
    });
    assert.equal(registered.resource, ownedResource);
    assert.equal(registered.creationResource, resource);
    await assert.rejects(stat(reservationPath));
    const manifest = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.ownedResources, [registered]);
    await assert.rejects(
      issueActionToken(root, run.runId, {
        action: "pr.create",
        provider: "github-cli",
        resource,
        remoteRevision: "abc",
        requiredEvidence: ["preflight"]
      }, "tree", await loadDefaults()),
      /PR creation already succeeded for this run/
    );
  } finally {
    process.env.PATH = priorPath;
  }
});

test("merged owned pull requests satisfy terminal cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-merged-owned-cleanup-"));
  const run = await createRun({
    root,
    contract: contract({ authority: ["pr.merge"] }),
    requestedMode: "verified",
    cwd: root
  });
  const runDir = path.join(root, "runs", run.runId);
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    ownedResources: [{
      resource: "pull/12",
      creationResource: "pull/new",
      ownerRunId: run.runId,
      receiptDigest: "a".repeat(64),
      creationAttemptId: "pr-create-attempt",
      creationActionDigest: "b".repeat(64),
      registeredAt: "2026-08-01T00:00:00.000Z"
    }]
  })}\n`);
  await writeFile(path.join(runDir, "actions", "merge.json"), `${JSON.stringify({
    action: "pr.merge",
    resource: "pull/12",
    status: "spent",
    outcome: "success",
    receipt: { providerReceipt: { pr: 12, state: "MERGED" } }
  })}\n`);
  await writeFile(path.join(runDir, "state.json"), `${JSON.stringify({
    ...JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")),
    status: "completed",
    updatedAt: "2020-01-01T00:00:00.000Z"
  })}\n`);
  const result = await cleanupRuns(root, { olderThanDays: -1, apply: false });
  assert.deepEqual(result.candidates, [run.runId]);
});

test("scope rejects Git pathspec magic", () => {
  assert.throws(
    () => contract({ scope: [":(exclude)plugins/better-workflows/scripts/lib/core.mjs"] }),
    /non-literal relative path/
  );
});

test("pr.create requires a verified current-tree sentinel before issuing a token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-pr-create-guard-"));
  const started = await createRun({
    root,
    contract: contract({ authority: ["pr.create"] }),
    requestedMode: "verified",
    cwd: root
  });
  await assert.rejects(
    issueActionToken(root, started.runId, {
      action: "pr.create",
      provider: "github-cli",
      resource: "pull/new",
      remoteRevision: "abc",
      requiredEvidence: ["base-revision"]
    }, "tree", { actionToken: { ttlSeconds: 60 } }),
    /verified current-tree sentinel/
  );
});

test("pr-to-dev merge requires the run-owned canonical pull request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-pr-merge-ownership-"));
  const prToDevTemplate = JSON.parse(await readFile(
    path.join(path.dirname(new URL(import.meta.url).pathname), "../../templates/pr-to-dev.json"),
    "utf8"
  ));
  const run = await createRun({
    root,
    contract: buildContract({
      template: "pr-to-dev",
      templateDefinition: prToDevTemplate,
      goal: "Require owned PR merge",
      scope: ["."],
      risk: { risk: 3, uncertainty: 2, blastRadius: 2, irreversibility: 2, evidenceGap: 2 },
      authority: ["pr.merge"],
      remoteRevision: "abc"
    }),
    requestedMode: "critical",
    cwd: root
  });
  await assert.rejects(
    issueActionToken(root, run.runId, {
      action: "pr.merge",
      provider: "github-cli",
      resource: "pull/12",
      remoteRevision: "abc",
      requiredEvidence: ["pr-state"]
    }, "tree", await loadDefaults()),
    /run-owned canonical pull request/
  );
});

test("unsupported action execution does not consume its token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-unsupported-action-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "unsupported action\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=sbw@example.invalid", "-c", "user.name=SBW Test", "commit", "-qm", "baseline"], { cwd: root });
  const run = await createRun({
    root,
    contract: contract({ authority: ["branch.create"] }),
    requestedMode: "verified",
    cwd: root
  });
  await addEvidence(root, run.runId, {
    id: "preflight",
    kind: "preflight",
    summary: "Unsupported execution preflight",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: "a".repeat(64)
  });
  await updateState(root, run.runId, (state) => ({
    ...state,
    lastSentinel: { label: "test", digest: "tree" },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const issued = await issueActionToken(root, run.runId, {
    action: "branch.create",
    provider: "git",
    resource: "branch:unsupported",
    remoteRevision: "abc",
    requiredEvidence: ["preflight"]
  }, "tree", await loadDefaults());
  await assert.rejects(
    executeActionToken(root, run.runId, issued.token, "tree"),
    /only supports fixed GitHub\/Git provider adapters/
  );
  const state = await inspectRun(root, run.runId);
  assert.equal(state.actions.find((item) => item.tokenHash === sha256(issued.token)).status, "issued");
});

test("wrapper-backed actions reject direct consume before spending the token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-direct-consume-wrapper-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "wrapper consume\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=sbw@example.invalid", "-c", "user.name=SBW Test", "commit", "-qm", "baseline"], { cwd: root });
  const run = await createRun({
    root,
    contract: contract({ authority: ["git.push"] }),
    requestedMode: "verified",
    cwd: root
  });
  const token = "wrapper-token";
  const tokenHash = sha256(token);
  await writeFile(path.join(root, "runs", run.runId, "actions", `${tokenHash}.json`), `${JSON.stringify({
    schemaVersion: 1,
    tokenHash,
    status: "issued",
    outcome: null,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    runId: run.runId,
    action: "git.push",
    provider: "git",
    resource: "remote:origin:refs/heads/feature",
    remoteRevision: "abc",
    treeDigest: "tree",
    contractDigest: digestObject((await inspectRun(root, run.runId)).contract),
    idempotencyKey: "wrapper-idempotency"
  })}\n`);
  await assert.rejects(
    consumeActionToken(root, run.runId, token, "tree", { forExecution: true }),
    /Wrapper-backed governed actions must use action execute/
  );
  const state = await inspectRun(root, run.runId);
  assert.equal(state.actions[0].status, "issued");
});

test("plugin cache success reconciliation repairs a pending marker without republishing", async () => {
  const stateRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "sbw-cache-repair-state-")));
  const repository = path.join(stateRoot, "repository");
  const sourceRoot = path.join(repository, "plugins", "better-workflows");
  await mkdir(path.join(sourceRoot, ".codex-plugin"), { recursive: true });
  await writeFile(path.join(sourceRoot, ".codex-plugin", "plugin.json"), `${JSON.stringify({ name: "better-workflows", version: "1.1.0+repair" })}\n`);
  await writeFile(path.join(sourceRoot, "payload.txt"), "repair\n");
  await execFileAsync("git", ["init", "-q", "-b", "dev"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "cache repair fixture"], { cwd: repository });
  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" })).stdout.trim();
  const priorCodexHome = process.env.CODEX_HOME;
  const priorStateRoot = process.env.SBW_STATE_ROOT;
  process.env.CODEX_HOME = path.join(stateRoot, "codex-home");
  delete process.env.SBW_STATE_ROOT;
  try {
    const cacheRoot = getCodexPluginCacheRoot();
    const run = await createRun({
      root: stateRoot,
      contract: contract({ authority: ["plugin.cache.publish"], remoteRevision: "remote" }),
      requestedMode: "verified",
      cwd: repository,
      baselineRevision: baseline
    });
    const runDetails = await inspectRun(stateRoot, run.runId);
    await addEvidence(stateRoot, run.runId, {
      id: "preflight",
      kind: "preflight",
      summary: "Cache repair preflight",
      status: "complete",
      acceptanceIds: [],
      sourceDigest: "a".repeat(64)
    });
    await updateState(stateRoot, run.runId, (state) => ({
      ...state,
      lastSentinel: { label: "cache-repair", digest: "tree" },
      lastSentinelVerified: true,
      lastSentinelComplete: true
    }));
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" })).stdout.trim();
    const issued = await issueActionToken(stateRoot, run.runId, {
      action: "plugin.cache.publish",
      provider: "local-workspace",
      resource: `plugin-cache:${head}`,
      remoteRevision: "remote",
      requiredEvidence: ["preflight"]
    }, "tree", await loadDefaults());
    const alternateHome = path.join(stateRoot, "alternate-codex-home");
    process.env.CODEX_HOME = alternateHome;
    await assert.rejects(
      consumeActionToken(stateRoot, run.runId, issued.token, "tree"),
      /different canonical cache root/
    );
    process.env.CODEX_HOME = path.join(stateRoot, "codex-home");
    const consumed = await consumeActionToken(stateRoot, run.runId, issued.token, "tree");
    const sourceBefore = await checkPluginCache({ sourceRoot, cacheRoot });
    const expectedSourceBinding = {
      pluginBundleDigest: sourceBefore.sourceDigest,
      sourceBaselineRevision: runDetails.manifest.sourceBinding.baseRevision,
      sourceBindingDigest: runDetails.manifest.sourceBinding.digest,
      sourceHeadRevision: head
    };
    const publication = await publishPluginCache({ sourceRoot, cacheRoot, expectedSourceBinding });
    const request = {
      action: consumed.action,
      provider: consumed.provider,
      resource: consumed.resource,
      remoteRevision: consumed.remoteRevision,
      idempotencyKey: consumed.idempotencyKey,
      sourceRoot,
      cacheRoot,
      sourceBaselineRevision: expectedSourceBinding.sourceBaselineRevision,
      sourceHeadRevision: expectedSourceBinding.sourceHeadRevision,
      sourceBindingDigest: expectedSourceBinding.sourceBindingDigest,
      pluginBundleDigest: expectedSourceBinding.pluginBundleDigest
    };
    const response = {
      applied: publication.applied === true,
      noOp: publication.noOp === true,
      status: publication.status,
      version: publication.version,
      target: publication.target,
      sourceDigest: publication.sourceDigest,
      targetDigest: publication.targetDigest
    };
    const providerReceipt = {
      action: consumed.action,
      provider: consumed.provider,
      resource: consumed.resource,
      outcome: "success",
      runId: run.runId,
      attemptId: consumed.attemptId,
      idempotencyKey: consumed.idempotencyKey,
      remoteRevision: consumed.remoteRevision,
      executionId: `local-workspace:plugin.cache.publish:${consumed.attemptId}`,
      proofKind: "local-workspace:plugin.cache.publish",
      requestDigest: digestObject(request),
      responseDigest: digestObject(response),
      verifiedAt: new Date().toISOString(),
      terminalState: "success",
      sourceRoot,
      cacheRoot,
      version: publication.version,
      target: publication.target,
      sourceDigest: publication.sourceDigest,
      targetDigest: publication.targetDigest,
      applied: publication.applied === true,
      noOp: publication.noOp === true,
      sourceBaselineRevision: expectedSourceBinding.sourceBaselineRevision,
      sourceHeadRevision: expectedSourceBinding.sourceHeadRevision,
      sourceBindingDigest: expectedSourceBinding.sourceBindingDigest,
      pluginBundleDigest: expectedSourceBinding.pluginBundleDigest
    };
    const actionProof = {
      schemaVersion: 1,
      runId: run.runId,
      actionAttemptId: consumed.attemptId,
      action: consumed.action,
      provider: consumed.provider,
      resource: consumed.resource,
      outcome: "success",
      idempotencyKey: consumed.idempotencyKey,
      remoteRevision: consumed.remoteRevision,
      providerExecutionId: providerReceipt.executionId,
      providerReceiptDigest: digestObject(providerReceipt)
    };
    const actionEvidence = {
      id: "cache-repair-proof",
      kind: "preflight",
      summary: "Cache repair provider proof",
      status: "complete",
      acceptanceIds: [],
      sourceDigest: "b".repeat(64),
      receipt: { payload: { actionProof, receipt: providerReceipt } }
    };
    await addEvidence(stateRoot, run.runId, actionEvidence);
    const actionReceipt = {
      action: consumed.action,
      provider: consumed.provider,
      resource: consumed.resource,
      outcome: "success",
      runId: run.runId,
      attemptId: consumed.attemptId,
      idempotencyKey: consumed.idempotencyKey,
      remoteRevision: consumed.remoteRevision,
      providerReceipt,
      evidenceIds: [actionEvidence.id]
    };
    const first = await reconcileAction(stateRoot, run.runId, consumed.attemptId, "success", actionReceipt);
    assert.equal(first.outcome, "success");
    const actionPath = path.join(runDetails.runDir, "actions", `${consumed.tokenHash}.json`);
    const persisted = JSON.parse(await readFile(actionPath, "utf8"));
    const markerPath = path.join(cacheRoot, `${publication.version}.ready.json`);
    const readyMarker = JSON.parse(await readFile(markerPath, "utf8"));
    await writeFile(markerPath, `${JSON.stringify({ ...readyMarker, state: "pending" })}\n`);
    const targetBeforeRepair = await stat(publication.target);
    const repaired = await reconcileAction(stateRoot, run.runId, consumed.attemptId, "success", persisted.receipt);
    assert.equal(repaired.cacheReadyRepairReceiptDigest, digestObject(providerReceipt));
    const targetAfterRepair = await stat(publication.target);
    assert.equal(targetAfterRepair.size, targetBeforeRepair.size);
    assert.equal((await verifyPluginCacheReady({
      cacheRoot,
      version: publication.version,
      target: publication.target,
      targetDigest: publication.targetDigest,
      sourceDigest: providerReceipt.sourceDigest,
      sourceBaselineRevision: providerReceipt.sourceBaselineRevision,
      sourceHeadRevision: providerReceipt.sourceHeadRevision,
      sourceBindingDigest: providerReceipt.sourceBindingDigest,
      pluginBundleDigest: providerReceipt.pluginBundleDigest,
      runId: run.runId,
      attemptId: consumed.attemptId,
      providerReceiptDigest: digestObject(providerReceipt)
    })).ok, true);
  } finally {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
    if (priorStateRoot === undefined) delete process.env.SBW_STATE_ROOT;
    else process.env.SBW_STATE_ROOT = priorStateRoot;
  }
});

test("indeterminate wrapper executions cannot be reconciled as terminal failure", async () => {
  for (const [action, provider] of [["git.push", "git"], ["pr.merge", "github-cli"]]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "sbw-indeterminate-wrapper-"));
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await writeFile(path.join(root, "README.md"), `${action}\n`);
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["-c", "user.email=sbw@example.invalid", "-c", "user.name=SBW Test", "commit", "-qm", "baseline"], { cwd: root });
    const run = await createRun({
      root,
      contract: contract({ authority: [action] }),
      requestedMode: "critical",
      cwd: root
    });
    const tokenHash = sha256(`${action}-indeterminate-token`);
    await writeFile(path.join(root, "runs", run.runId, "actions", `${tokenHash}.json`), `${JSON.stringify({
      schemaVersion: 1,
      tokenHash,
      status: "spent",
      outcome: "pending",
      runId: run.runId,
      action,
      provider,
      resource: action === "git.push" ? "remote:origin:refs/heads/feature" : "pull/42",
      remoteRevision: "abc",
      attemptId: `${action}-attempt`,
      idempotencyKey: `${action}-idempotency`,
      providerInvocation: { dispatchState: "sent-or-indeterminate" }
    })}\n`);
    await assert.rejects(
      reconcileAction(root, run.runId, `${action}-attempt`, "failure"),
      /Indeterminate wrapper execution cannot be reconciled as failure/
    );
    assert.equal((await inspectRun(root, run.runId)).actions[0].outcome, "pending");
  }
});

test("auto routing follows risk and explicit modes never downgrade", () => {
  const value = contract();
  assert.equal(routeMode(value, "auto"), "verified");
  assert.equal(routeMode(value, "critical"), "critical");
  value.risk.irreversibility = 3;
  assert.equal(routeMode(value, "auto"), "critical");
});

test("direct mode creates no state directory", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-direct-"));
  const root = path.join(parent, "state-that-must-not-exist");
  const result = await createRun({
    root,
    contract: contract({
      risk: { risk: 0, uncertainty: 0, blastRadius: 0, irreversibility: 0, evidenceGap: 0 }
    }),
    requestedMode: "direct",
    cwd: parent
  });
  assert.equal(result.direct, true);
  await assert.rejects(access(root));
});

test("the SBW state root and generated run IDs use the canonical command name", async () => {
  assert.equal(getStateRoot({ CODEX_HOME: "/tmp/codex-home" }), "/tmp/codex-home/sbw");
  assert.equal(getStateRoot({ SBW_STATE_ROOT: "/tmp/custom-sbw-state" }), "/tmp/custom-sbw-state");
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-name-contract-"));
  const result = await createRun({
    root,
    contract: contract(),
    requestedMode: "verified",
    cwd: root
  });
  assert.match(result.runId, /^sbw-/);
});

test("run state is private and action tokens are one-shot with reconciliation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-core-"));
  const result = await createRun({
    root,
    contract: contract(),
    requestedMode: "verified",
    cwd: root
  });
  const run = await inspectRun(root, result.runId);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(run.runDir)).mode & 0o777, 0o700);

  await addEvidence(root, result.runId, {
    id: "preflight",
    kind: "preflight",
    summary: "Required preflight completed",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: "a".repeat(64)
  });
  await updateState(root, result.runId, (state) => ({
    ...state,
    lastSentinel: { label: "test", digest: "tree" },
    lastSentinelVerified: true,
    lastSentinelComplete: false
  }));

  const defaults = await loadDefaults();
  const incomplete = await evaluateCompletion(root, result.runId);
  assert.ok(incomplete.blockers.includes("bounded-sentinel-incomplete"));
  await assert.rejects(
    issueActionToken(
      root,
      result.runId,
      {
        action: "deploy",
        provider: "github",
        resource: "workflow:123",
        remoteRevision: "abc",
        requiredEvidence: ["preflight"]
      },
      "tree",
      defaults
    ),
    /incomplete bounded sentinel/
  );
  await updateState(root, result.runId, (state) => ({
    ...state,
    lastSentinelComplete: true
  }));
  const issued = await issueActionToken(
    root,
    result.runId,
    {
      action: "deploy",
      provider: "github",
      resource: "workflow:123",
      remoteRevision: "abc",
      requiredEvidence: ["preflight"]
    },
    "tree",
    defaults
  );
  const spent = await consumeActionToken(root, result.runId, issued.token, "tree");
  assert.equal(spent.status, "spent");
  assert.equal(spent.outcome, "pending");
  await assert.rejects(
    consumeActionToken(root, result.runId, issued.token, "tree"),
    /already consumed/
  );
  const timeoutProviderReceipt = {
    action: "deploy",
    provider: "github",
    resource: "workflow:123",
    outcome: "unknown",
    runId: spent.runId,
    attemptId: spent.attemptId,
    idempotencyKey: spent.idempotencyKey,
    remoteRevision: spent.remoteRevision,
    executionId: `github:timeout:${spent.attemptId}`,
    proofKind: "github:deploy",
    requestDigest: "f".repeat(64),
    responseDigest: "0".repeat(64),
    verifiedAt: "2026-08-01T00:00:00.000Z",
    terminalState: "unknown",
    reason: "provider-timeout"
  };
  const reconciled = await reconcileAction(
    root,
    result.runId,
    spent.attemptId,
    "unknown",
    {
      action: "deploy",
      provider: "github",
      resource: "workflow:123",
      outcome: "unknown",
      runId: spent.runId,
      attemptId: spent.attemptId,
      idempotencyKey: spent.idempotencyKey,
      remoteRevision: spent.remoteRevision,
      providerReceipt: timeoutProviderReceipt
    }
  );
  assert.equal(reconciled.outcome, "unknown");
  const completion = await evaluateCompletion(root, result.runId);
  assert.equal(completion.ok, false);
  assert.ok(completion.blockers.includes("side-effect-not-reconciled"));
  const terminalIssued = await issueActionToken(
    root,
    result.runId,
    {
      action: "deploy",
      provider: "github",
      resource: "workflow:terminal",
      remoteRevision: "abc",
      requiredEvidence: ["preflight"]
    },
    "tree",
    defaults
  );
  const reconciliationIssued = await issueActionToken(
    root,
    result.runId,
    {
      action: "deploy",
      provider: "github",
      resource: "workflow:reconcile-terminal",
      remoteRevision: "abc",
      requiredEvidence: ["preflight"]
    },
    "tree",
    defaults
  );
  const reconciliationSpent = await consumeActionToken(root, result.runId, reconciliationIssued.token, "tree");
  await updateState(root, result.runId, (state) => ({ ...state, status: "failed_terminal" }));
  await assert.rejects(
    consumeActionToken(root, result.runId, terminalIssued.token, "tree"),
    /Action token consumption cannot mutate a terminal run/
  );
  await assert.rejects(
    issueActionToken(root, result.runId, {
      action: "deploy",
      provider: "github",
      resource: "workflow:after-terminal",
      remoteRevision: "abc",
      requiredEvidence: ["preflight"]
    }, "tree", defaults),
    /Action token issuance cannot mutate a terminal run/
  );
  const terminalProviderReceipt = {
    action: "deploy",
    provider: "github",
    resource: "workflow:reconcile-terminal",
    outcome: "unknown",
    runId: reconciliationSpent.runId,
    attemptId: reconciliationSpent.attemptId,
    idempotencyKey: reconciliationSpent.idempotencyKey,
    remoteRevision: reconciliationSpent.remoteRevision,
    executionId: `github:terminal:${reconciliationSpent.attemptId}`,
    proofKind: "github:deploy",
    requestDigest: "a".repeat(64),
    responseDigest: "b".repeat(64),
    verifiedAt: "2026-08-01T00:00:00.000Z",
    terminalState: "unknown",
    reason: "terminal-run-test"
  };
  await assert.rejects(
    reconcileAction(root, result.runId, reconciliationSpent.attemptId, "unknown", {
      action: "deploy",
      provider: "github",
      resource: "workflow:reconcile-terminal",
      outcome: "unknown",
      runId: reconciliationSpent.runId,
      attemptId: reconciliationSpent.attemptId,
      idempotencyKey: reconciliationSpent.idempotencyKey,
      remoteRevision: reconciliationSpent.remoteRevision,
      providerReceipt: terminalProviderReceipt
    }),
    /Action reconciliation cannot mutate a terminal run/
  );
});

test("destructive cleanup actions require an immutable run-owned resource receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-owned-resource-"));
  const cleanupTemplate = {
    requiredEvidence: ["actions-cleanup-plan"],
    acceptance: [{ id: "done", description: "Cleanup is governed.", critical: true }]
  };
  const cleanupContract = () => buildContract({
    template: "test-cleanup",
    templateDefinition: cleanupTemplate,
    goal: "Test cleanup ownership",
    scope: ["."],
    risk: { risk: 1, uncertainty: 1, blastRadius: 1, irreversibility: 1, evidenceGap: 1 },
    sensitivity: "internal",
    authority: ["branch.create", "branch.delete"],
    remoteRevision: "abc"
  });
  const addPlan = async (run, plan) => addEvidence(root, run.runId, {
    id: "actions-cleanup-plan",
    kind: "actions-cleanup-plan",
    summary: "Cleanup ownership plan",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: "a".repeat(64),
    receipt: { payload: plan }
  });
  const denied = await createRun({ root, contract: cleanupContract(), requestedMode: "verified", cwd: root });
  await updateState(root, denied.runId, (state) => ({
    ...state,
    lastSentinel: { label: "test", digest: "tree" },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const deniedResource = "branch:feature/owned";
  await addPlan(denied, {
    objective: "Delete only the owned branch",
    ownerRunId: denied.runId,
    action: "branch.delete",
    resources: [{ resource: deniedResource, ownerRunId: denied.runId, receiptDigest: "0".repeat(64) }]
  });
  await assert.rejects(
    registerOwnedResource(root, denied.runId, {
      resource: deniedResource,
      creationReceipt: {
        ownerRunId: denied.runId,
        resource: deniedResource,
        action: "branch.create",
        attemptId: "forged-attempt",
        runId: denied.runId,
        idempotencyKey: "forged-idempotency",
        remoteRevision: "abc",
        outcome: "success",
        provider: "git",
        providerReceipt: {
          provider: "git",
          action: "branch.create",
          resource: deniedResource,
          outcome: "success",
          runId: denied.runId,
          attemptId: "forged-attempt",
          idempotencyKey: "forged-idempotency",
          remoteRevision: "abc",
          executionId: "git:forged",
          created: true,
          ref: deniedResource.slice("branch:".length),
          revision: "a".repeat(40)
        },
        createdAt: "2026-08-01T00:00:00.000Z"
      }
    }),
    /structured execution proof|reconciled successful run action/
  );
  await assert.rejects(
    issueActionToken(root, denied.runId, {
      action: "branch.delete",
      provider: "git",
      resource: deniedResource,
      remoteRevision: "abc",
      requiredEvidence: ["actions-cleanup-plan"]
    }, "tree", await loadDefaults()),
    /immutable creation receipt/
  );

  const providerRepo = path.join(root, "provider-repo");
  await mkdir(providerRepo, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: providerRepo });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: providerRepo });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: providerRepo });
  await writeFile(path.join(providerRepo, "README.md"), "provider\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: providerRepo });
  await execFileAsync("git", ["commit", "-qm", "provider base"], { cwd: providerRepo });
  const registeredRun = await createRun({ root, contract: cleanupContract(), requestedMode: "verified", cwd: providerRepo });
  await updateState(root, registeredRun.runId, (state) => ({
    ...state,
    lastSentinel: { label: "test", digest: "tree" },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const resource = "branch:feature/registered";
  await addEvidence(root, registeredRun.runId, {
    id: "preflight",
    kind: "preflight",
    summary: "Creation action preflight",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: "b".repeat(64)
  });
  const creationIssued = await issueActionToken(root, registeredRun.runId, {
    action: "branch.create",
    provider: "git",
    resource,
    remoteRevision: "abc",
    requiredEvidence: ["preflight"]
  }, "tree", await loadDefaults());
  const reservationPath = path.join(root, "creation-reservations", `${creationReservationKey(creationIssued.creationReservation)}.json`);
  const reservation = JSON.parse(await readFile(reservationPath, "utf8"));
  assert.equal(reservation.expiresAt, creationIssued.expiresAt);
  const expiredResource = "branch:feature/expired";
  const expiredIssued = await issueActionToken(root, registeredRun.runId, {
    action: "branch.create",
    provider: "git",
    resource: expiredResource,
    remoteRevision: "abc",
    requiredEvidence: ["preflight"]
  }, "tree", await loadDefaults());
  const expiredReservationPath = path.join(root, "creation-reservations", `${creationReservationKey(expiredIssued.creationReservation)}.json`);
  const expiredReservation = JSON.parse(await readFile(expiredReservationPath, "utf8"));
  await writeFile(expiredReservationPath, `${JSON.stringify({ ...expiredReservation, expiresAt: "2020-01-01T00:00:00.000Z" })}\n`);
  const replacementIssued = await issueActionToken(root, registeredRun.runId, {
    action: "branch.create",
    provider: "git",
    resource: expiredResource,
    remoteRevision: "abc",
    requiredEvidence: ["preflight"]
  }, "tree", await loadDefaults());
  assert.notEqual(replacementIssued.token, expiredIssued.token);
  await writeFile(reservationPath, `${JSON.stringify({ ...reservation, tokenHash: "0".repeat(64) })}\n`);
  await assert.rejects(
    consumeActionToken(root, registeredRun.runId, creationIssued.token, "tree"),
    /creation reservation is missing, expired, or rebound/
  );
  await writeFile(reservationPath, `${JSON.stringify(reservation)}\n`);
  const creationSpent = await consumeActionToken(root, registeredRun.runId, creationIssued.token, "tree");
  const creationMarker = `sbw:${creationSpent.attemptId}:${creationSpent.idempotencyKey}`;
  const providerRevision = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: providerRepo })).stdout.trim();
  await execFileAsync("git", [
    "update-ref",
    "-m",
    creationMarker,
    `refs/heads/${resource.slice("branch:".length)}`,
    providerRevision,
    "0".repeat(40)
  ], { cwd: providerRepo });
  const providerCommonDir = (await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: providerRepo })).stdout.trim();
  const providerIdentity = await realpath(
    path.isAbsolute(providerCommonDir) ? providerCommonDir : path.resolve(providerRepo, providerCommonDir)
  );
  const providerReceipt = {
    provider: "git",
    action: "branch.create",
    resource,
    outcome: "success",
    runId: creationSpent.runId,
    attemptId: creationSpent.attemptId,
    idempotencyKey: creationSpent.idempotencyKey,
    remoteRevision: creationSpent.remoteRevision,
    executionId: `git:${providerIdentity}:branch.create:${resource.slice("branch:".length)}:${providerRevision}`,
    proofKind: "git-branch-create",
    requestDigest: digestObject({ action: creationSpent.action, provider: creationSpent.provider, resource: creationSpent.resource, remoteRevision: creationSpent.remoteRevision, repository: providerIdentity }),
    responseDigest: digestObject({ ref: resource.slice("branch:".length), revision: providerRevision }),
    verifiedAt: "2026-08-01T00:00:00.000Z",
    terminalState: "success",
    created: true,
    creationProof: {
      attemptId: creationSpent.attemptId,
      idempotencyKey: creationSpent.idempotencyKey,
      marker: creationMarker,
      providerObjectId: `${resource.slice("branch:".length)}:${providerRevision}`
    },
    creationPreconditionDigest: digestObject(creationSpent.creationPrecondition),
    ref: resource.slice("branch:".length),
    revision: providerRevision
  };
  const actionEvidence = {
    id: "branch-create-proof",
    kind: "preflight",
    summary: "Provider branch creation receipt",
    status: "complete",
    acceptanceIds: [],
    sourceDigest: "c".repeat(64),
    receipt: {
      payload: {
        actionProof: {
          schemaVersion: 1,
          runId: creationSpent.runId,
          actionAttemptId: creationSpent.attemptId,
          action: creationSpent.action,
          provider: creationSpent.provider,
          resource: creationSpent.resource,
          outcome: "success",
          idempotencyKey: creationSpent.idempotencyKey,
          remoteRevision: creationSpent.remoteRevision,
          providerExecutionId: providerReceipt.executionId,
          providerReceiptDigest: digestObject(providerReceipt)
        },
        receipt: providerReceipt
      }
    }
  };
  await addEvidence(root, registeredRun.runId, actionEvidence);
  await reconcileAction(root, registeredRun.runId, creationSpent.attemptId, "success", {
    action: "branch.create",
    provider: "git",
    resource,
    outcome: "success",
    runId: creationSpent.runId,
    attemptId: creationSpent.attemptId,
    idempotencyKey: creationSpent.idempotencyKey,
    remoteRevision: creationSpent.remoteRevision,
    providerReceipt,
    evidenceIds: [actionEvidence.id]
  });
  const creationReceipt = {
    ownerRunId: registeredRun.runId,
    runId: registeredRun.runId,
    resource,
    action: "branch.create",
    attemptId: creationSpent.attemptId,
    idempotencyKey: creationSpent.idempotencyKey,
    remoteRevision: creationSpent.remoteRevision,
    outcome: "success",
    provider: "git",
    providerReceipt,
    evidenceIds: [actionEvidence.id],
    createdAt: "2026-08-01T00:00:00.000Z"
  };
  const registered = await registerOwnedResource(root, registeredRun.runId, { resource, creationReceipt });
  await addPlan(registeredRun, {
    objective: "Delete only the owned branch",
    ownerRunId: registeredRun.runId,
    action: "branch.delete",
    resources: [{ resource, ownerRunId: registeredRun.runId, receiptDigest: registered.receiptDigest }]
  });
  const issued = await issueActionToken(root, registeredRun.runId, {
    action: "branch.delete",
    provider: "git",
    resource,
    remoteRevision: "abc",
    requiredEvidence: ["actions-cleanup-plan"]
  }, "tree", await loadDefaults());
  assert.equal(issued.action, "branch.delete");
});

test("terminal runs reject owned resource registration before manifest mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-terminal-resource-"));
  const run = await createRun({
    root,
    contract: contract({ authority: ["branch.create"] }),
    requestedMode: "verified",
    cwd: root
  });
  await updateState(root, run.runId, (state) => ({ ...state, status: "completed" }));
  await assert.rejects(
    registerOwnedResource(root, run.runId, {
      resource: "branch:feature/terminal",
      creationReceipt: {
        ownerRunId: run.runId,
        resource: "branch:feature/terminal",
        action: "branch.create",
        attemptId: "terminal-attempt",
        runId: run.runId,
        idempotencyKey: "terminal-idempotency",
        remoteRevision: "abc",
        outcome: "success",
        provider: "git",
        providerReceipt: {
          provider: "git",
          action: "branch.create",
          resource: "branch:feature/terminal",
          outcome: "success",
          runId: run.runId,
          attemptId: "terminal-attempt",
          idempotencyKey: "terminal-idempotency",
          remoteRevision: "abc",
          executionId: "git:terminal",
          proofKind: "git-branch-create",
          requestDigest: "0".repeat(64),
          responseDigest: "1".repeat(64),
          verifiedAt: "2026-08-01T00:00:00.000Z",
          terminalState: "success",
          creationProof: {
            attemptId: "terminal-attempt",
            idempotencyKey: "terminal-idempotency",
            marker: "sbw:terminal-attempt:terminal-idempotency"
          },
          created: true,
          ref: "feature/terminal",
          revision: "a".repeat(40)
        },
        createdAt: "2026-08-01T00:00:00.000Z"
      }
    }),
    /Owned resource registration cannot mutate a terminal run/
  );
});

test("terminal status rejects pending governed provider execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-pending-provider-"));
  const run = await createRun({
    root,
    contract: buildContract({
      template: "test-pending-provider",
      templateDefinition: { requiredEvidence: [], acceptance: [{ id: "done", description: "Provider execution is governed.", critical: true }] },
      goal: "Block cancellation during provider execution",
      scope: ["."],
      risk: { risk: 1, uncertainty: 1, blastRadius: 1, irreversibility: 1, evidenceGap: 1 },
      sensitivity: "internal",
      authority: ["pr.merge"],
      remoteRevision: "abc"
    }),
    requestedMode: "verified",
    cwd: root
  });
  const runDir = path.join(root, "runs", run.runId);
  await writeFile(path.join(runDir, "actions", "pending.json"), `${JSON.stringify({
    action: "pr.merge",
    provider: "github-cli",
    status: "spent",
    outcome: "pending",
    attemptId: "pending-provider-attempt"
  })}\n`);
  await assert.rejects(
    setRunStatus(root, run.runId, "cancelled_superseded"),
    /pending reconciliation/
  );
  assert.equal((await inspectRun(root, run.runId)).state.status, "running");
});

test("expired leases from another host are not reclaimed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-foreign-lease-"));
  const run = await createRun({
    root,
    contract: contract(),
    requestedMode: "verified",
    cwd: root
  });
  const runDir = path.join(root, "runs", run.runId);
  await writeFile(path.join(runDir, ".lease"), `${JSON.stringify({
    token: "foreign-token",
    pid: 1,
    host: "foreign-host",
    createdAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-01T00:00:01.000Z"
  })}\n`);
  await assert.rejects(
    withRunLock(root, run.runId, async () => undefined),
    /refusing cross-host lease reclamation/
  );
});

test("completion requires every declared evidence kind independently of acceptance coverage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-required-evidence-"));
  const result = await createRun({
    root,
    contract: contract(),
    requestedMode: "verified",
    cwd: root
  });
  await addEvidence(root, result.runId, {
    id: "shortcut",
    kind: "unrelated-shortcut",
    summary: "Acceptance is covered without the required preflight kind",
    status: "complete",
    acceptanceIds: ["done"],
    sourceDigest: "b".repeat(64)
  });
  await updateState(root, result.runId, (state) => ({
    ...state,
    lastSentinel: { label: "test", digest: "tree" },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));

  const completion = await evaluateCompletion(root, result.runId);
  assert.equal(completion.ok, false);
  assert.ok(completion.blockers.includes("missing-required-evidence:preflight"));
  assert.ok(!completion.blockers.includes("missing-acceptance:done"));
});

test("completion re-captures the sentinel inside the final gate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-completion-sentinel-"));
  const repository = path.join(root, "repository");
  await mkdir(repository, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "stable\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: repository });
  const taskContract = contract();
  const run = await createRun({ root: path.join(root, "state"), contract: taskContract, requestedMode: "verified", cwd: repository });
  const runRoot = path.join(root, "state");
  const sentinel = await captureSentinel(repository, taskContract, await loadDefaults());
  await updateState(runRoot, run.runId, (state) => ({
    ...state,
    lastSentinel: { label: "initial", digest: sentinel.digest },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  await addEvidence(runRoot, run.runId, {
    id: "preflight",
    kind: "preflight",
    summary: "Final-gate sentinel test evidence",
    status: "complete",
    acceptanceIds: ["done"],
    sourceDigest: "d".repeat(64)
  });
  await writeFile(path.join(repository, "README.md"), "drifted\n");
  const completed = await completeRun(runRoot, run.runId, { decision: "complete" });
  assert.equal(completed.ok, false);
  assert.equal(completed.status, "inconclusive");
  assert.ok(completed.blockers.includes("current-sentinel-drift"));
  await updateState(runRoot, run.runId, (state) => ({ ...state, status: "failed_terminal" }));
  await assert.rejects(
    completeRun(runRoot, run.runId, { decision: "complete" }),
    /Run completion cannot mutate a terminal run/
  );
});

test("state root symlinks and hardlinked JSON are rejected", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-links-"));
  const actual = path.join(parent, "actual");
  const alias = path.join(parent, "alias");
  await mkdir(actual, { mode: 0o700 });
  await symlink(actual, alias);
  await assert.rejects(ensureStateRoot(alias), /symlink/);

  const root = path.join(parent, "state");
  const result = await createRun({
    root,
    contract: contract(),
    requestedMode: "verified",
    cwd: parent
  });
  const run = await inspectRun(root, result.runId);
  const external = path.join(parent, "external.json");
  const hardlink = safeJoin(run.runDir, "evidence", "hardlink.json");
  await writeFile(external, "{}\n", { mode: 0o600 });
  await link(external, hardlink);
  await assert.rejects(readJson(root, hardlink), /Unsafe JSON path/);
});
