import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  addEvidence,
  assertProviderReceiptShape,
  buildPrCreateCommand,
  buildContract,
  cleanupRuns,
  consumeActionToken,
  completeRun,
  createRun,
  digestObject,
  ensureStateRoot,
  executeActionToken,
  evaluateCompletion,
  getStateRoot,
  inspectRun,
  issueActionToken,
  loadDefaults,
  readJson,
  registerOwnedResource,
  reconcileAction,
  routeMode,
  safeJoin,
  sha256,
  setRunStatus,
  updateState,
  withRunLock
} from "../lib/core.mjs";
import { captureSentinel } from "../lib/git.mjs";

const execFileAsync = promisify(execFile);

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
    "example/repo",
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
  const reservationPath = path.join(root, "creation-reservations", `${sha256(resource)}.json`);
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
  const unknownReservationPath = path.join(root, "creation-reservations", `${sha256(unknownResource)}.json`);
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

test("unsupported GitHub Actions dispatch fails closed before issuing a token", async () => {
  await assert.rejects(
    issueActionToken("/private/tmp/sbw-unsupported-actions-dispatch", "sbw-20260803T000000Z-000000000000", {
      action: "actions.dispatch",
      provider: "github-cli",
      resource: "workflow:release.yml",
      remoteRevision: "abc",
      requiredEvidence: ["preflight"]
    }, "tree", {}),
    /unimplemented provider adapter/
  );
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
  const action = {
    schemaVersion: 1,
    tokenHash,
    status: "spent",
    outcome: "pending",
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
    providerAuthorization: {
      provider: "github-cli",
      repository: "github.com/example/repo",
      actor: "alice",
      permissions: { admin: false, maintain: false, push: true }
    },
    providerExecutable: null,
    creationPrecondition: { action: "pr.create", resource, state: "absent", number: null }
  };
  await writeFile(path.join(runDir, "actions", `${tokenHash}.json`), `${JSON.stringify(action)}\n`);
  const reservationPath = path.join(root, "creation-reservations", `${sha256(resource)}.json`);
  await mkdir(path.dirname(reservationPath), { recursive: true });
  await writeFile(reservationPath, `${JSON.stringify({
    runId: run.runId,
    resource,
    tokenHash,
    reservedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  })}\n`);
  const responsePath = path.join(root, "fake-pr-list.json");
  const argsPath = path.join(root, "fake-gh-args.txt");
  const fakeGh = path.join(bin, "gh");
  await writeFile(responsePath, "[[{\"number\":99,\"headRefOid\":\"other\",\"baseRefName\":\"dev\",\"url\":\"https://example.invalid/pull/99\"}]]\n");
  const ghScript = "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SBW_FAKE_PR_ARGS\"\nif [ \"$1\" = \"api\" ] && [ \"$2\" = \"user\" ]; then\n  printf '{\"login\":\"%s\"}\\n' \"${SBW_FAKE_GH_ACTOR:-alice}\"\nelif [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/example/repo\" ]; then\n  printf '{\"full_name\":\"example/repo\",\"permissions\":{\"admin\":false,\"maintain\":false,\"push\":%s}}\\n' \"${SBW_FAKE_GH_PUSH:-true}\"\nelse\n  cat \"$SBW_FAKE_PR_LIST\"\nfi\n";
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
  const priorResponse = process.env.SBW_FAKE_PR_LIST;
  const priorArgs = process.env.SBW_FAKE_PR_ARGS;
  const priorActor = process.env.SBW_FAKE_GH_ACTOR;
  const priorPush = process.env.SBW_FAKE_GH_PUSH;
  process.env.PATH = `${bin}:${priorPath}`;
  process.env.SBW_FAKE_PR_LIST = responsePath;
  process.env.SBW_FAKE_PR_ARGS = argsPath;
  process.env.SBW_FAKE_GH_ACTOR = "alice";
  process.env.SBW_FAKE_GH_PUSH = "true";
  try {
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "failure", receipt),
      /existing pull request; preserve the reservation/
    );
    await stat(reservationPath);
    process.env.SBW_FAKE_GH_ACTOR = "mallory";
    await assert.rejects(
      reconcileAction(root, run.runId, attemptId, "failure", receipt),
      /actor or permissions changed/
    );
    await stat(reservationPath);
    process.env.SBW_FAKE_GH_ACTOR = "alice";
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
    if (priorResponse === undefined) delete process.env.SBW_FAKE_PR_LIST;
    else process.env.SBW_FAKE_PR_LIST = priorResponse;
    if (priorArgs === undefined) delete process.env.SBW_FAKE_PR_ARGS;
    else process.env.SBW_FAKE_PR_ARGS = priorArgs;
    if (priorActor === undefined) delete process.env.SBW_FAKE_GH_ACTOR;
    else process.env.SBW_FAKE_GH_ACTOR = priorActor;
    if (priorPush === undefined) delete process.env.SBW_FAKE_GH_PUSH;
    else process.env.SBW_FAKE_GH_PUSH = priorPush;
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
    path.join(root, "creation-reservations", `${sha256(resource)}.json`),
    `${JSON.stringify({ runId: run.runId, resource, tokenHash, reservedAt: spentAt, expiresAt: new Date(Date.now() + 60_000).toISOString() })}\n`
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
    await assert.rejects(stat(path.join(root, "creation-reservations", `${sha256(resource)}.json`)));
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
    spentAt,
    receipt: { providerReceipt }
  };
  const runDir = path.join(root, "runs", run.runId);
  await writeFile(path.join(runDir, "actions", `${tokenHash}.json`), `${JSON.stringify(action)}\n`);
  const reservationPath = path.join(root, "creation-reservations", `${sha256(resource)}.json`);
  await mkdir(path.dirname(reservationPath), { recursive: true });
  await writeFile(reservationPath, `${JSON.stringify({
    runId: run.runId,
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
    /only supports github-cli pr\.merge and git\.push/
  );
  const state = await inspectRun(root, run.runId);
  assert.equal(state.actions.find((item) => item.tokenHash === sha256(issued.token)).status, "issued");
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
  const reservationPath = path.join(root, "creation-reservations", `${sha256(resource)}.json`);
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
  const expiredReservationPath = path.join(root, "creation-reservations", `${sha256(expiredResource)}.json`);
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
  const providerIdentity = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: providerRepo })).stdout.trim();
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
