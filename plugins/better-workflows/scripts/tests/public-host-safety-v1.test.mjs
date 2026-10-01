// SPDX-License-Identifier: AGPL-3.0-only
// Public-safe extraction of existing host qualification and control-plane
// safety cases. The source suites stay unchanged; only these cases are projected.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  addEvidence, buildContract, createRun, digestObject,
  evaluateCompletion, inspectRun, loadDefaults, updateState,
  VERSION
} from "../lib/core.mjs";
import { deriveLedgerStatus, transitionLedger } from "../lib/ledger.mjs";
import { autoPolicyDefinition } from "../lib/auto-policy-v1.mjs";
import { captureSentinel } from "../lib/git.mjs";

const execFileAsync = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../sbw.mjs");

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function repository() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-repo-"));
  await git(cwd, "init", "-q", "-b", "dev");
  await git(cwd, "config", "user.name", "Stephen Better Workflows Tests");
  await git(cwd, "config", "user.email", "sbw-tests@example.invalid");
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "value.txt"), "one\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

async function cli(cwd, stateRoot, args, { allowFailure = false, env = {} } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd, encoding: "utf8", env: { ...process.env, SBW_STATE_ROOT: stateRoot, ...env },
      maxBuffer: 8 * 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr, json: JSON.parse(result.stdout) };
  } catch (error) {
    if (!allowFailure) throw error;
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "",
      json: error.stdout ? JSON.parse(error.stdout) : null };
  }
}

function canonicalAutoContract(policyId, goal, overrides = {}) {
  const policy = autoPolicyDefinition(policyId);
  const contract = buildContract({ template: "auto", templateDefinition: policy, goal, scope: ["."], ...overrides });
  contract.templateDigest = digestObject(policy);
  return contract;
}

async function gateRecord(run, kind, payload, id = kind) {
  const runId = run.runId ?? run.manifest.runId;
  const reviewBinding = ["pr-state", "required-checks"].includes(kind)
    ? { reviewHead: payload.head, reviewBase: payload.base, pullRequest: payload.pr,
      repository: payload.repository, baseRefName: payload.baseRefName,
      ...(kind === "required-checks" ? { observedAt: payload.observedAt } : {}) }
    : {};
  return {
    schemaVersion: 2, id, kind, status: "complete", summary: `Typed ${kind} evidence`,
    receipt: { contractId: `evidence-contracts-v1:${kind}`, contractVersion: 1, runId,
      producer: { provider: "codex-root" },
      inputBinding: { runId, contractDigest: digestObject(run.contract), remoteRevision: run.contract.remoteRevision ?? null,
        ...(run.state?.lastSentinel?.digest ? { sourceSentinelDigest: run.state.lastSentinel.digest } : {}), ...reviewBinding },
      payload, payloadDigest: digestObject(payload), producedAt: new Date().toISOString() }
  };
}

function currentEvidenceDependencies(run, files = []) {
  return { contractDigest: run.manifest.contractDigest, workflowVersion: VERSION, files,
    sourceBindingDigest: null, sourceSentinelDigest: null,
    policyDigest: digestObject({ authority: run.contract.authority, sensitivity: run.contract.sensitivity,
      volatileExclusions: run.contract.volatileExclusions, highRiskIgnored: run.contract.highRiskIgnored }),
    promptDigest: null, model: null, reviewBinding: null, remoteRevision: run.contract.remoteRevision ?? null };
}
test("public Auto entry imports no private autonomy tooling", async () => {
  const source = await readFile(CLI, "utf8");
  assert.doesNotMatch(source, /["']\.\/lib\/autonomy(?:-preflight|-snapshot)?\.mjs["']/);
  assert.doesNotMatch(source, /\breadBoundHostStatus\b/);
  assert.doesNotMatch(source, /host subcommand[^\n]*\bconsent\b/);
});

test("public Auto CLI rejects private host consent before state initialization", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sbw-public-consent-boundary-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const stateRoot = path.join(cwd, "state");
  const helped = await cli(cwd, stateRoot, ["help"]);
  const usage = helped.json.usage.join("\n");
  assert.doesNotMatch(usage, /sbw (?:autonomy|host consent)\b/);
  for (const command of ["list", "doctor", "conformance"]) {
    assert.match(usage, new RegExp(`sbw host ${command}\\b`));
  }
  assert.match(usage, /sbw run --plan <plan-id> --command-binding-file/);
  assert.match(usage, /sbw workflow resume <run-id>/);
  for (const args of [
    ["host", "consent", "status", "--json"],
    ["host", "consent", "revoke", "--json"],
    ["host", "consent", "status", "--help"],
    ["host", "consent"]
  ]) {
    const result = await cli(cwd, stateRoot, args, { allowFailure: true });
    assert.equal(result.code, 1, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.ok, false);
    assert.equal(failure.code, "EWORKFLOW_PUBLIC_AUTO_REQUIRED");
    assert.equal(failure.status, "HOLD");
    await assert.rejects(access(stateRoot), { code: "ENOENT" });
  }
  assert.deepEqual(await readdir(cwd), []);
});

test("CLI Direct Git route requires an isolated lease and completes the owned workspace lifecycle without a run ledger", async () => {
  const cwd = await repository();
  await git(cwd, "checkout", "-qb", "feature");
  const stateRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-cli-direct-git-")), "state");
  const preview = await cli(cwd, stateRoot, [
    "route",
    "preview",
    "--goal",
    "Update one value",
    "--scope",
    "src/value.txt",
    "--mutation",
    "modify",
    "--acceptance-defined",
    "--risk",
    "1",
    "--uncertainty",
    "0",
    "--blast-radius",
    "0",
    "--irreversibility",
    "0",
    "--evidence-gap",
    "0",
    "--integration-target",
    "feature",
    "--basic-check",
    "targeted node check",
    "--record"
  ]);
  assert.equal(preview.json.effectiveMode, "direct");
  assert.equal(preview.json.autoRiskAssessment.workspaceLifecycle, "isolated-worktree");
  const missingLease = await cli(
    cwd,
    stateRoot,
    ["run", "--route-receipt", preview.json.receipt.id],
    { allowFailure: true }
  );
  assert.notEqual(missingLease.code, 0);
  assert.match(missingLease.stderr, /Auto fast-path Git mutation requires/);

  const created = await cli(cwd, stateRoot, [
    "workspace",
    "create",
    "--goal",
    "Update one value",
    "--task-id",
    "task-cli-direct",
    "--integration-target",
    "feature"
  ]);
  assert.equal(created.json.status, "isolated");
  const started = await cli(cwd, stateRoot, [
    "run",
    "--route-receipt",
    preview.json.receipt.id,
    "--workspace-task-id",
    created.json.lease.taskId,
    "--workspace-repository-id",
    created.json.lease.repository.repositoryId
  ]);
  assert.equal(started.json.direct, true);
  assert.equal(started.json.runId, null);
  assert.equal(started.json.workspaceLease.taskWorktree, created.json.lease.taskWorktree);
  assert.equal(started.json.workspaceLease.lifecycleState, "working");
  const resumedStart = await cli(cwd, stateRoot, [
    "run",
    "--route-receipt",
    preview.json.receipt.id,
    "--workspace-task-id",
    created.json.lease.taskId,
    "--workspace-repository-id",
    created.json.lease.repository.repositoryId
  ]);
  assert.equal(resumedStart.json.direct, true);
  assert.equal(resumedStart.json.workspaceLease.lifecycleState, "working");
  const conflictingLease = await cli(cwd, stateRoot, [
    "workspace",
    "create",
    "--goal",
    "Update a conflicting value",
    "--task-id",
    "task-conflicting-claim",
    "--integration-target",
    "feature"
  ]);
  assert.equal(conflictingLease.json.status, "isolated");
  const conflictingStart = await cli(cwd, stateRoot, [
    "run",
    "--route-receipt",
    preview.json.receipt.id,
    "--workspace-task-id",
    conflictingLease.json.lease.taskId,
    "--workspace-repository-id",
    conflictingLease.json.lease.repository.repositoryId
  ], { allowFailure: true });
  assert.notEqual(conflictingStart.code, 0);
  assert.match(conflictingStart.stderr, /different consumer/);
  await assert.rejects(access(path.join(stateRoot, "runs")));

  await writeFile(path.join(created.json.lease.taskWorktree, "src", "value.txt"), "two\n");
  await git(created.json.lease.taskWorktree, "add", "src/value.txt");
  await git(created.json.lease.taskWorktree, "commit", "-qm", "update value");
  const checkFile = path.join(stateRoot, "checks.json");
  await writeFile(checkFile, `${JSON.stringify([{ name: "targeted node check", argv: ["node", "-e", "process.exit(0)"] }])}\n`);
  const common = [
    "--repository-id",
    created.json.lease.repository.repositoryId,
    "--task-id",
    created.json.lease.taskId
  ];
  const validated = await cli(cwd, stateRoot, ["workspace", "validate", ...common, "--check-file", checkFile]);
  assert.equal(validated.json.status, "integration-ready");
  const integrated = await cli(cwd, stateRoot, ["workspace", "integrate", ...common]);
  assert.equal(integrated.json.status, "integrated");
  const cleaned = await cli(cwd, stateRoot, ["workspace", "cleanup", ...common]);
  assert.equal(cleaned.json.status, "cleaned");
  const completion = await cli(cwd, stateRoot, ["workspace", "completion-notice", ...common]);
  assert.equal(completion.json.status, "complete");
  assert.equal(completion.json.targetBranch, "feature");
  assert.deepEqual(completion.json.checks, ["targeted node check"]);
  assert.match(completion.json.notice, /本次工作經 Auto 評估為範圍明確、可回復的低風險修改，因此採用 Auto 快速路徑/);
  assert.match(completion.json.notice, /本次成果已通過上述基本檢查，但不等同於完整、可重播的證據驗證/);
  assert.equal(await readFile(path.join(cwd, "src", "value.txt"), "utf8"), "two\n");
  await assert.rejects(access(created.json.lease.taskWorktree));
});

test("CLI host list and conformance expose registry truth without turning a local receipt into release proof", async () => {
  const cwd = await repository();
  const stateRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-cli-host-state-")), "state");
  const listed = await cli(cwd, stateRoot, ["host", "list"]);
  assert.equal(listed.json.recommended.label, "macOS + Codex");
  assert.equal(listed.json.releaseConformanceMatrix.length, 8);
  assert.equal(listed.json.currentProductScope.version, "5.0.0-rc.1");
  assert.deepEqual(listed.json.currentProductConformanceMatrix.map((entry) => `${entry.hostId}/${entry.osId}`).sort(),
    ["codex/macos", "gemini-cli/macos", "qwen-code/macos"]);
  const deferred = await cli(cwd, stateRoot, ["host", "doctor", "claude-code", "--os", "macos"], { allowFailure: true });
  assert.equal(deferred.json.currentProductQualification.status, "deferred");
  assert.equal(deferred.json.currentProductQualification.deferredUntil, "5.1.0");
  assert.equal(deferred.json.currentProductQualification.authority, "none");
  await assert.rejects(access(stateRoot));
  const deferredConformance = await cli(cwd, stateRoot,
    ["host", "conformance", "claude-code", "--os", "macos", "--write-receipt"]);
  assert.equal(deferredConformance.json.result, "HOLD");
  assert.equal(deferredConformance.json.receiptPath, null);
  assert.equal(deferredConformance.json.currentProductQualification.status, "deferred");
  await assert.rejects(access(stateRoot));

  const bin = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-host-bin-"));
  const executable = path.join(bin, "codex");
  await writeFile(executable, "#!/bin/sh\nprintf 'codex-cli 0.150.1\\n'\n");
  await chmod(executable, 0o755);
  const conformance = await cli(
    cwd,
    stateRoot,
    ["host", "conformance", "codex", "--os", "macos", "--write-receipt"],
    { env: { PATH: bin } }
  );
  assert.equal(conformance.json.result, "PASS");
  assert.equal(conformance.json.authentication.releaseEligible, false);
  assert.equal(conformance.json.currentProductQualification.status, "in-scope");
  assert.equal(conformance.json.currentProductQualification.authority, "none");
  assert.match(conformance.json.receiptPath, /host-conformance/);
});

async function publicAutoContract(goal) {
  const catalog = JSON.parse(await readFile(path.resolve(path.dirname(CLI), "..", "templates", "auto.json"), "utf8"));
  return buildContract({
    template: "auto",
    templateDefinition: catalog.variants["read-only-v1"],
    goal,
    scope: ["src"]
  });
}

test("single-task non-direct run creates one ledger and no automatic design or review artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-contract-"));
  const contract = canonicalAutoContract("read-only-v1", "v2 contract");
  assert.equal(contract.schemaVersion, 2);
  const result = await createRun({ root, contract, requestedMode: "verified", cwd: root });
  const run = await inspectRun(root, result.runId);
  const ledger = JSON.parse(await readFile(path.join(run.runDir, "ledger.json"), "utf8"));
  assert.equal(ledger.schemaVersion, 1);
  assert.deepEqual(ledger.tasks.map((item) => item.id), ["inventory", "result"]);
  const artifacts = (await readdir(run.runDir)).sort();
  assert.deepEqual(artifacts.filter((name) => /ledger/i.test(name)), ["ledger.json"]);
  assert.deepEqual(artifacts.filter((name) => /design|review/i.test(name)), []);
});
test("provider reconciliation rejects structurally forged action proofs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-action-proof-"));
  const contract = canonicalAutoContract("dev-publish-v1", "provider proof");
  const started = await createRun({ root, contract, requestedMode: "critical", cwd: root });
  const run = await inspectRun(root, started.runId);
  await assert.rejects(
    addEvidence(root, started.runId, await gateRecord(run, "provider-reconciliation", {
      provider: "github-cli",
      receipt: { status: "success" },
      actionProof: {}
    })),
    /actionProof is structurally invalid/
  );
});
test("ledger status reloads run state before validating sentinel-bound evidence", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-ledger-sentinel-workspace-"));
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Better Workflows Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "source.txt"), "sentinel-bound\n");
  await execFileAsync("git", ["add", "source.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: workspace });

  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-ledger-sentinel-state-"));
  const contract = canonicalAutoContract("read-only-v1", "ledger sentinel-bound evidence");
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: workspace });
  const sentinel = await captureSentinel(workspace, contract, await loadDefaults());
  await updateState(root, started.runId, (state) => ({
    ...state,
    lastSentinel: { label: "sentinel-bound-evidence", digest: sentinel.digest },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const run = await inspectRun(root, started.runId);
  const payload = { items: [{ path: "source.txt" }] };
  await addEvidence(root, started.runId, {
    schemaVersion: 2,
    id: "sentinel-bound-source-inventory",
    kind: "source-inventory",
    status: "complete",
    summary: "Source inventory is bound to the current source and sentinel",
    receipt: {
      contractId: "evidence-contracts-v1:source-inventory",
      contractVersion: 1,
      runId: started.runId,
      producer: { provider: "codex-root" },
      inputBinding: {
        runId: started.runId,
        contractDigest: digestObject(run.contract),
        remoteRevision: null,
        sourceBindingDigest: run.manifest.sourceBinding.digest,
        sourceSentinelDigest: sentinel.digest
      },
      payload,
      payloadDigest: digestObject(payload),
      producedAt: new Date().toISOString()
    }
  });

  const status = await deriveLedgerStatus(root, started.runId);
  assert.deepEqual(status.blockers, []);
  assert.deepEqual(status.readySet, ["inventory"]);
});
test("completion validates sentinel-bound evidence with its loaded state", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-completion-sentinel-workspace-"));
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Better Workflows Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "source.txt"), "completion-sentinel-bound\n");
  await execFileAsync("git", ["add", "source.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: workspace });

  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-completion-sentinel-state-"));
  const contract = canonicalAutoContract("read-only-v1", "completion sentinel context");
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: workspace });
  const sentinel = await captureSentinel(workspace, contract, await loadDefaults());
  await updateState(root, started.runId, (state) => ({
    ...state,
    lastSentinel: { label: "completion-sentinel", digest: sentinel.digest },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const run = await inspectRun(root, started.runId);
  const payload = { items: [{ path: "source.txt" }] };
  await addEvidence(root, started.runId, {
    schemaVersion: 2,
    id: "completion-sentinel-inventory",
    kind: "source-inventory",
    status: "complete",
    summary: "Current source inventory is bound to the completion sentinel",
    receipt: {
      contractId: "evidence-contracts-v1:source-inventory",
      contractVersion: 1,
      runId: started.runId,
      producer: { provider: "codex-root" },
      inputBinding: {
        runId: started.runId,
        contractDigest: digestObject(run.contract),
        remoteRevision: null,
        sourceBindingDigest: run.manifest.sourceBinding.digest,
        sourceSentinelDigest: sentinel.digest
      },
      payload,
      payloadDigest: digestObject(payload),
      producedAt: new Date().toISOString()
    }
  });

  const initialLedger = JSON.parse(await readFile(path.join(run.runDir, "ledger.json"), "utf8"));
  await transitionLedger(root, started.runId, {
    eventId: "start-completion-inventory",
    type: "start",
    taskId: "inventory",
    expectedLedgerDigest: digestObject(initialLedger)
  });
  const startedLedger = JSON.parse(await readFile(path.join(run.runDir, "ledger.json"), "utf8"));
  await transitionLedger(root, started.runId, {
    eventId: "complete-completion-inventory",
    type: "complete",
    taskId: "inventory",
    evidenceKinds: ["source-inventory"],
    expectedLedgerDigest: digestObject(startedLedger)
  });
  await addEvidence(root, started.runId, await gateRecord(run, "observed-result", {
    items: [{ outcome: "observed" }]
  }, "completion-observed-result"));
  const afterInventory = JSON.parse(await readFile(path.join(run.runDir, "ledger.json"), "utf8"));
  await transitionLedger(root, started.runId, {
    eventId: "start-completion-result",
    type: "start",
    taskId: "result",
    expectedLedgerDigest: digestObject(afterInventory)
  });
  const startedResult = JSON.parse(await readFile(path.join(run.runDir, "ledger.json"), "utf8"));
  await transitionLedger(root, started.runId, {
    eventId: "complete-completion-result",
    type: "complete",
    taskId: "result",
    evidenceKinds: ["observed-result"],
    expectedLedgerDigest: digestObject(startedResult)
  });

  const completion = await evaluateCompletion(root, started.runId);
  assert.equal(completion.ok, true);
  assert.equal(completion.blockers.includes("invalid-typed-evidence:completion-sentinel-inventory"), false);

  await updateState(root, started.runId, (state) => ({
    ...state,
    lastSentinel: { label: "stale-completion-sentinel", digest: "f".repeat(64) }
  }));
  const staleCompletion = await evaluateCompletion(root, started.runId);
  assert.equal(staleCompletion.ok, false);
  assert.equal(staleCompletion.blockers.includes("invalid-typed-evidence:completion-sentinel-inventory"), true);
  await rm(workspace, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});
test("persisted typed evidence is revalidated before ledger admission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-evidence-tamper-"));
  const contract = canonicalAutoContract("read-only-v1", "typed evidence tamper");
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: root });
  const run = await inspectRun(root, started.runId);
  await addEvidence(root, started.runId, {
    ...await gateRecord(run, "observed-result", { items: [{ outcome: "observed" }] }, "observed-result-tamper"),
    dependencyInputs: { files: [] },
    dependencies: currentEvidenceDependencies(run, [])
  });
  const evidencePath = path.join(run.runDir, "evidence", "observed-result-tamper.json");
  const tampered = JSON.parse(await readFile(evidencePath, "utf8"));
  tampered.receipt.payloadDigest = "0".repeat(64);
  await writeFile(evidencePath, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(
    transitionLedger(root, started.runId, {
      eventId: "blocked-by-tampered-evidence",
      type: "start",
      taskId: "inventory"
    }),
    /Evidence immutable admission binding changed: observed-result-tamper/
  );
  const ledger = JSON.parse(await readFile(path.join(run.runDir, "ledger.json"), "utf8"));
  assert.equal(ledger.events.length, 0);
  const status = await deriveLedgerStatus(root, started.runId);
  assert.ok(status.blockers.some((item) => item.includes("Evidence immutable admission binding changed: observed-result-tamper")));
  assert.equal(status.complete, false);
});
