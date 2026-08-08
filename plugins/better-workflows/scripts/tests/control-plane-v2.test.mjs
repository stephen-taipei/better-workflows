import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  addEvidence,
  addFinding,
  buildContract,
  createRun,
  digestObject,
  inspectRun,
  issueActionToken,
  loadDefaults,
  rebindSourceBinding,
  sha256
} from "../lib/core.mjs";
import { assertPayloadFields, loadEvidenceContracts } from "../lib/evidence.mjs";
import { compileLedger, deriveLedgerStatus, transitionLedger } from "../lib/ledger.mjs";
import { deliberateForRun } from "../lib/deliberation-receipt.mjs";
import { addReviewFinding, createReviewPackage, markBroadReviewComplete, recordRepairRound, reviewPackageDigest, reviewStatus, stableFindingId } from "../lib/review.mjs";
import { updateState } from "../lib/core.mjs";
import { captureSentinel } from "../lib/git.mjs";

const contractTemplate = {
  requiredEvidence: ["environment-state"],
  acceptance: [{ id: "done", description: "Typed evidence proves completion.", critical: true }],
  controlPlane: {
    evidencePolicy: "typed-v1",
    ledgerPolicy: "ledger-v1",
    reviewPolicy: "none",
    designPacketPolicy: "none",
    refinementPolicy: "none",
    deliberationPolicy: "none"
  },
  executionStages: [{
    id: "environment",
    dependsOn: [],
    requiredEvidence: ["environment-state"],
    attemptBudget: 3,
    kind: "regular"
  }]
};

const execFileAsync = promisify(execFile);

function gitWithInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

async function typedRecord(run, id = "environment") {
  const payload = { items: [{ environment: "test" }] };
  return {
    schemaVersion: 2,
    id,
    kind: "environment-state",
    status: "complete",
    summary: "Typed environment evidence",
    receipt: {
      contractId: "evidence-contracts-v1:environment-state",
      contractVersion: 1,
      runId: run.runId,
      producer: { provider: "codex-root" },
      inputBinding: {
        runId: run.runId,
        contractDigest: digestObject(run.contract),
        remoteRevision: run.contract.remoteRevision ?? null
      },
      payload,
      payloadDigest: digestObject(payload),
      producedAt: new Date().toISOString()
    }
  };
}

async function gateRecord(run, kind, payload, id = kind) {
  const runId = run.runId ?? run.manifest.runId;
  const reviewBinding = ["pr-state", "required-checks"].includes(kind)
    ? {
        reviewHead: payload.head,
        reviewBase: payload.base,
        pullRequest: payload.pr,
        repository: payload.repository,
        baseRefName: payload.baseRefName,
        ...(kind === "required-checks" ? { observedAt: payload.observedAt } : {})
      }
    : {};
  return {
    schemaVersion: 2,
    id,
    kind,
    status: "complete",
    summary: `Typed ${kind} evidence`,
    receipt: {
      contractId: `evidence-contracts-v1:${kind}`,
      contractVersion: 1,
      runId,
      producer: { provider: "codex-root" },
      inputBinding: {
        runId,
        contractDigest: digestObject(run.contract),
        remoteRevision: run.contract.remoteRevision ?? null,
        ...reviewBinding
      },
      payload,
      payloadDigest: digestObject(payload),
      producedAt: new Date().toISOString()
    }
  };
}

test("typed catalog covers exactly the 99 installed evidence kinds", async () => {
  const contracts = await loadEvidenceContracts({ refresh: true });
  assert.equal(Object.keys(contracts).length, 99);
  assert.ok(contracts["remote-sync"]);
});

test("typed handoff evidence admits only its declared nullable policy digest", async () => {
  const contracts = await loadEvidenceContracts({ refresh: true });
  const kind = "self-improve-delivery-handoff";
  const definition = contracts[kind];
  const payload = {
    artifact: { kind, digest: "0".repeat(64) },
    sourceRunId: "sbw-source",
    sourceBaselineRevision: "1".repeat(40),
    sourceHeadRevision: "2".repeat(40),
    sourceBindingDigest: "3".repeat(64),
    pluginBundleDigest: "4".repeat(64),
    requestManifestDigest: "5".repeat(64),
    comparisonDigest: "6".repeat(64),
    candidateDigest: "7".repeat(64),
    candidateRoot: "/tmp/candidate",
    purpose: "evaluator-migration",
    policyDigest: null,
    witnessDigests: ["8".repeat(64)]
  };
  assert.deepEqual(definition.nullableFields, ["policyDigest"]);
  assert.doesNotThrow(() => assertPayloadFields(
    payload,
    definition.requiredFields,
    kind,
    definition.nullableFields
  ));
  const missingPolicyDigest = { ...payload };
  delete missingPolicyDigest.policyDigest;
  assert.throws(
    () => assertPayloadFields(missingPolicyDigest, definition.requiredFields, kind, definition.nullableFields),
    /missing required field: policyDigest/
  );
  assert.throws(
    () => assertPayloadFields({ ...payload, purpose: null }, definition.requiredFields, kind, definition.nullableFields),
    /missing required field: purpose/
  );
});

test("real template contracts are v2 and initialize a static ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-contract-"));
  const contract = buildContract({
    template: "test-v2",
    templateDefinition: contractTemplate,
    goal: "v2 contract",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  assert.equal(contract.schemaVersion, 2);
  const result = await createRun({ root, contract, requestedMode: "verified", cwd: root });
  const run = await inspectRun(root, result.runId);
  const ledger = JSON.parse(await readFile(path.join(run.runDir, "ledger.json"), "utf8"));
  assert.equal(ledger.schemaVersion, 1);
  assert.deepEqual(ledger.tasks.map((item) => item.id), ["environment"]);
});

test("source binding can be explicitly rebound before review or side effects", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sbw-source-rebind-workspace-"));
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Better Workflows Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "source.txt"), "initial\n");
  await execFileAsync("git", ["add", "source.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: workspace });
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-source-rebind-state-"));
  const contract = buildContract({
    template: "test-source-rebind",
    templateDefinition: contractTemplate,
    goal: "source rebind",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: workspace });
  const before = await inspectRun(root, started.runId);
  await addEvidence(root, started.runId, await typedRecord({ runId: started.runId, contract: before.contract }));
  const initialLedger = JSON.parse(await readFile(path.join(before.runDir, "ledger.json"), "utf8"));
  await transitionLedger(root, started.runId, {
    eventId: "start-environment-before-rebind",
    type: "start",
    taskId: "environment",
    expectedLedgerDigest: digestObject(initialLedger)
  });
  const startedLedger = JSON.parse(await readFile(path.join(before.runDir, "ledger.json"), "utf8"));
  await transitionLedger(root, started.runId, {
    eventId: "complete-environment-before-rebind",
    type: "complete",
    taskId: "environment",
    evidenceKinds: ["environment-state"],
    expectedLedgerDigest: digestObject(startedLedger)
  });
  await writeFile(path.join(workspace, "source.txt"), "changed\n");
  await execFileAsync("git", ["add", "source.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-qm", "source change"], { cwd: workspace });
  const rebound = await rebindSourceBinding(root, started.runId, "commit stage completed");
  assert.equal(rebound.ok, true);
  assert.equal(rebound.rebound, true);
  assert.notEqual(rebound.sourceBinding.digest, before.manifest.sourceBinding.digest);
  assert.equal(rebound.state.lastSentinelVerified, false);
  const after = await inspectRun(root, started.runId);
  assert.equal(after.manifest.sourceBinding.digest, rebound.sourceBinding.digest);
  assert.equal(after.manifest.sourceBindingHistory.at(-1).reason, "commit stage completed");
  assert.equal(after.evidence.find((item) => item.kind === "environment-state").stale, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(after.runDir, "ledger.json"), "utf8")).events, []);
  assert.equal((await deriveLedgerStatus(root, started.runId)).taskStates[0].state, "pending");
  await assert.rejects(
    rebindSourceBinding(root, started.runId, "\n"),
    /concise reason/
  );
  await addFinding(root, started.runId, {
    id: "accepted-risk-before-rebind",
    severity: "P2",
    status: "accepted-risk",
    summary: "must be reassessed after source changes",
    owner: "owner",
    reason: "temporary bounded risk",
    expiry: new Date(Date.now() + 86_400_000).toISOString()
  });
  await writeFile(path.join(workspace, "source.txt"), "changed again\n");
  await execFileAsync("git", ["add", "source.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-qm", "second source change"], { cwd: workspace });
  await assert.rejects(
    rebindSourceBinding(root, started.runId, "accepted-risk must be reassessed"),
    /before independent review begins/
  );
});

test("typed evidence rejects cross-run and caller-forged digests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-evidence-"));
  const contract = buildContract({
    template: "test-v2",
    templateDefinition: contractTemplate,
    goal: "typed evidence",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: root });
  const run = await inspectRun(root, started.runId);
  const valid = await typedRecord({ runId: started.runId, contract: run.contract });
  const forged = { ...valid, sourceDigest: "0".repeat(64) };
  await assert.rejects(addEvidence(root, started.runId, forged), /caller-forged/);
  const wrongRun = await typedRecord({ runId: "sbw-20260731T000000Z-000000000000", contract: run.contract }, "wrong-run");
  await assert.rejects(addEvidence(root, started.runId, wrongRun), /run binding is invalid/);
});

test("typed gate evidence rejects a failed result even when its shape is valid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-semantic-evidence-"));
  const contract = buildContract({
    template: "test-v2",
    templateDefinition: {
      ...contractTemplate,
      requiredEvidence: ["required-checks"],
      executionStages: [{
        ...contractTemplate.executionStages[0],
        requiredEvidence: ["required-checks"]
      }]
    },
    goal: "semantic evidence",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: root });
  const run = await inspectRun(root, started.runId);
  const pullEvidence = {
    pr: 1,
    head: "a".repeat(40),
    base: "b".repeat(40),
    repository: "github.com/example/test",
    baseRefName: "dev",
    checkSet: ["test"],
    providerRunIds: ["provider-run-1"],
    conclusions: ["SUCCESS"],
    checks: [{ name: "test", providerRunId: "provider-run-1", conclusion: "SUCCESS" }],
    requiredStatusChecks: ["test"],
    provider: "github",
    providerExecutable: { path: "/usr/bin/gh", digest: "0".repeat(64) },
    observedAt: new Date().toISOString()
  };
  await assert.rejects(
    addEvidence(root, started.runId, await gateRecord(run, "required-checks", { ...pullEvidence, command: "false", result: false })),
    /result failed its success predicate/
  );
  for (const providerExecutable of [{}, { path: "/usr/bin/gh", digest: "not-a-digest" }, { path: "/usr/bin/gh", digest: "0".repeat(64), extra: true }]) {
    await assert.rejects(
      addEvidence(root, started.runId, await gateRecord(run, "required-checks", {
        ...pullEvidence,
        command: "gh",
        providerExecutable,
        result: true
      }, "required-checks-invalid-executable")),
      /exact absolute path and SHA-256 digest object/
    );
  }
  await assert.rejects(
    addEvidence(root, started.runId, await gateRecord(run, "commit-history", { command: "false", result: false }, "commit-history-failed")),
    /result failed its success predicate/
  );
  await assert.rejects(
    addEvidence(root, started.runId, await gateRecord(run, "cleanup-manifest", { outcome: "failure" }, "cleanup-failed")),
    /outcome failed its success predicate/
  );
  await assert.rejects(
    addEvidence(root, started.runId, await gateRecord(run, "required-checks", {
      ...pullEvidence,
      command: "true",
      result: true,
      checkSet: ["test", "lint"],
      providerRunIds: ["provider-run-1"],
      conclusions: ["SUCCESS"],
      checks: [{ name: "test", providerRunId: "provider-run-1", conclusion: "SUCCESS" }]
    }, "required-checks-cardinality")),
    /provider observation is incomplete/
  );
  await addEvidence(root, started.runId, await gateRecord(run, "required-checks", { ...pullEvidence, command: "true", result: true }));
});

test("provider reconciliation rejects structurally forged action proofs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-action-proof-"));
  const contract = buildContract({
    template: "test-v2-provider-proof",
    templateDefinition: {
      ...contractTemplate,
      requiredEvidence: ["provider-reconciliation"],
      executionStages: [{
        ...contractTemplate.executionStages[0],
        requiredEvidence: ["provider-reconciliation"]
      }]
    },
    goal: "provider proof",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: root });
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

test("cache publication evidence requires a bound local-workspace action proof", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-cache-proof-"));
  const templateDefinition = {
    ...contractTemplate,
    requiredEvidence: ["cache-publication"],
    executionStages: [{
      ...contractTemplate.executionStages[0],
      requiredEvidence: ["cache-publication"]
    }]
  };
  const contract = buildContract({
    template: "test-v2-cache-proof",
    templateDefinition,
    goal: "cache proof",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: root });
  const run = await inspectRun(root, started.runId);
  await assert.rejects(
    addEvidence(root, started.runId, await gateRecord(run, "cache-publication", {
      provider: "local-workspace",
      outcome: "success",
      receipt: { status: "success" },
      actionProof: {}
    }, "forged-cache-proof")),
    /actionProof is structurally invalid/
  );
});

test("typed evidence rejects forged independent-critic provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-critic-provenance-"));
  const contract = buildContract({
    template: "test-v2",
    templateDefinition: contractTemplate,
    goal: "critic provenance",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: root });
  const run = await inspectRun(root, started.runId);
  const forged = {
    ...(await gateRecord(run, "environment-state", { items: [{ environment: "test" }] }, "forged-critic")),
    sourceKind: "independent-critic",
    review: { verdict: "PASS" }
  };
  await assert.rejects(addEvidence(root, started.runId, forged), /independent-critic provenance/);
});

test("ledger reducer derives ready set and rejects duplicate event identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-ledger-"));
  const contract = buildContract({
    template: "test-v2",
    templateDefinition: {
      ...contractTemplate,
      executionStages: [
        contractTemplate.executionStages[0],
        { id: "review", dependsOn: ["environment"], requiredEvidence: ["environment-state"], attemptBudget: 5, kind: "review" }
      ]
    },
    goal: "ledger",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: root });
  const run = await inspectRun(root, started.runId);
  await addEvidence(root, started.runId, await typedRecord({ runId: started.runId, contract: run.contract }));
  const initialLedger = JSON.parse(await readFile(path.join(run.runDir, "ledger.json"), "utf8"));
  await transitionLedger(root, started.runId, { eventId: "start-environment", type: "start", taskId: "environment", expectedLedgerDigest: digestObject(initialLedger) });
  await assert.rejects(
    transitionLedger(root, started.runId, { eventId: "stale-start", type: "start", taskId: "environment", expectedLedgerDigest: digestObject(initialLedger) }),
    /expected digest is stale/
  );
  const afterStart = JSON.parse(await readFile(path.join(run.runDir, "ledger.json"), "utf8"));
  await transitionLedger(root, started.runId, { eventId: "complete-environment", type: "complete", taskId: "environment", evidenceKinds: ["environment-state"], expectedLedgerDigest: digestObject(afterStart) });
  const status = await deriveLedgerStatus(root, started.runId);
  assert.deepEqual(status.readySet, ["review"]);
  await assert.rejects(
    transitionLedger(root, started.runId, { eventId: "complete-environment", type: "complete", taskId: "environment", evidenceKinds: ["environment-state"] }),
    /duplicate-event|invalid-complete/
  );
  await assert.rejects(
    transitionLedger(root, started.runId, { eventId: "non-root", type: "start", taskId: "review", actor: "subagent" }),
    /root-owned/
  );
});

test("ledger completion rejects self-reported evidence without a typed receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-ledger-forge-"));
  const contract = buildContract({
    template: "test-v2",
    templateDefinition: contractTemplate,
    goal: "ledger forged completion",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: root });
  await transitionLedger(root, started.runId, { eventId: "start-environment", type: "start", taskId: "environment" });
  await assert.rejects(
    transitionLedger(root, started.runId, { eventId: "forge-complete", type: "complete", taskId: "environment", evidenceKinds: ["environment-state"], summary: "PASS" }),
    /complete-without-typed-evidence/
  );
});

test("persisted typed evidence is revalidated before ledger admission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-evidence-tamper-"));
  const contract = buildContract({
    template: "test-v2",
    templateDefinition: contractTemplate,
    goal: "typed evidence tamper",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: root });
  const run = await inspectRun(root, started.runId);
  await addEvidence(root, started.runId, await typedRecord({ runId: started.runId, contract: run.contract }));
  const evidencePath = path.join(run.runDir, "evidence", "environment.json");
  const tampered = JSON.parse(await readFile(evidencePath, "utf8"));
  tampered.receipt.payloadDigest = "0".repeat(64);
  await writeFile(evidencePath, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(
    transitionLedger(root, started.runId, {
      eventId: "blocked-by-tampered-evidence",
      type: "start",
      taskId: "environment"
    }),
    /invalid-typed-evidence:environment/
  );
  const ledger = JSON.parse(await readFile(path.join(run.runDir, "ledger.json"), "utf8"));
  assert.equal(ledger.events.length, 0);
  const status = await deriveLedgerStatus(root, started.runId);
  assert.ok(status.blockers.includes("invalid-typed-evidence:environment"));
  assert.equal(status.complete, false);
});

test("generic finding dispositions and terminal mutations fail closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-terminal-mutations-"));
  const contract = buildContract({
    template: "test-terminal-mutations",
    templateDefinition: contractTemplate,
    goal: "terminal mutation guards",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: root });
  const run = await inspectRun(root, started.runId);
  await addEvidence(root, started.runId, await typedRecord({ runId: started.runId, contract: run.contract }));
  await addFinding(root, started.runId, {
    id: "generic-finding",
    severity: "P1",
    status: "open",
    summary: "must be dispositioned with proof"
  });
  await assert.rejects(
    addFinding(root, started.runId, {
      id: "generic-finding",
      severity: "P1",
      status: "resolved",
      summary: "missing disposition proof"
    }, { update: true }),
    /require evidenceId/
  );
  await assert.rejects(
    addFinding(root, started.runId, {
      id: "generic-finding",
      severity: "P1",
      status: "resolved",
      evidenceId: "environment",
      summary: "unbound disposition proof"
    }, { update: true }),
    /not bound to the finding/
  );
  await updateState(root, started.runId, (state) => ({ ...state, status: "completed" }));
  await assert.rejects(
    addEvidence(root, started.runId, await typedRecord({ runId: started.runId, contract: run.contract }, "after-terminal")),
    /Evidence cannot mutate a terminal run/
  );
  await assert.rejects(
    addFinding(root, started.runId, {
      id: "generic-finding",
      severity: "P1",
      status: "open",
      summary: "post-terminal mutation"
    }, { update: true }),
    /Finding cannot mutate a terminal run/
  );
});

test("ledger compilation rejects a terminal run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-terminal-ledger-"));
  const started = await createRun({
    root,
    contract: buildContract({
      template: "test-terminal-ledger",
      templateDefinition: {
        ...contractTemplate,
        controlPlane: { ...contractTemplate.controlPlane, designPacketPolicy: "pilot-v1" }
      },
      goal: "terminal ledger mutation",
      scope: ["."],
      risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
      sensitivity: "internal",
      authority: ["git.commit"],
      remoteRevision: "remote"
    }),
    requestedMode: "verified",
    cwd: root
  });
  await updateState(root, started.runId, (state) => ({ ...state, status: "completed" }));
  await assert.rejects(
    compileLedger(root, started.runId, {
      schemaVersion: 1,
      id: "terminal-packet",
      objective: "Must not mutate a completed run",
      constraints: [],
      acceptanceIds: [],
      tasks: []
    }),
    /Ledger compilation cannot mutate a terminal run/
  );
});

test("review packages prove the Git manifest and dispositions fail closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-review-"));
  const repository = path.join(root, "repository");
  await mkdir(repository, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "base\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: repository });
  const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  await mkdir(path.join(repository, "src"));
  await writeFile(path.join(repository, "src", "a.ts"), "export const a = 1;\n");
  await execFileAsync("git", ["add", "src/a.ts"], { cwd: repository });
  await execFileAsync("git", ["commit", "-q", "-m", "change"], { cwd: repository });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const contract = buildContract({
    template: "test-review",
    templateDefinition: { ...contractTemplate, scope: ["src", "README.md"], controlPlane: { ...contractTemplate.controlPlane, reviewPolicy: "code-v1" } },
    goal: "review",
    scope: ["src", "README.md"],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: [],
    remoteRevision: base
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: repository });
  const sentinel = await captureSentinel(repository, contract, await loadDefaults());
  await updateState(root, started.runId, (state) => ({
    ...state,
    lastSentinel: { label: "review", digest: sentinel.digest },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const digest = "b".repeat(64);
  const input = {
    root,
    runId: started.runId,
    base,
    head,
    scope: ["src", "README.md"],
    diffManifest: { files: [{ status: "A", path: "src/a.ts" }] },
    instructionDigest: digest,
    sentinelDigest: sentinel.digest
  };
  const first = await createReviewPackage(input);
  const second = await createReviewPackage(input);
  assert.equal(first.packageId, second.packageId);
  const reordered = await createReviewPackage({ ...input, scope: ["README.md", "src"] });
  assert.equal(reordered.packageId, first.packageId);
  const packagePath = path.join((await inspectRun(root, started.runId)).runDir, "review-packages", `${first.packageId}.json`);
  const tampered = JSON.parse(await readFile(packagePath, "utf8"));
  tampered.diffManifest = { files: [] };
  tampered.diffManifestDigest = digestObject(tampered.diffManifest);
  const tamperedIdentity = {
    immutable: tampered.immutable,
    base: tampered.base,
    head: tampered.head,
    mergeBase: tampered.mergeBase,
    scope: tampered.scope,
    scopeDigest: tampered.scopeDigest,
    diffManifest: tampered.diffManifest,
    diffManifestDigest: tampered.diffManifestDigest,
    contractDigest: tampered.contractDigest,
    templateDigest: tampered.templateDigest,
    sentinelDigest: tampered.sentinelDigest,
    instructionDigest: tampered.instructionDigest
  };
  tampered.packageId = `review-${sha256(digestObject(tamperedIdentity)).slice(0, 32)}`;
  await writeFile(packagePath, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(
    reviewStatus(root, started.runId),
    /does not match the live Git BASE\.\.HEAD diff/
  );
  await writeFile(packagePath, `${JSON.stringify(first, null, 2)}\n`);
  const divergentBlob = (await gitWithInput(repository, ["hash-object", "-w", "--stdin"], "divergent\n")).stdout.trim();
  const baseTree = (await execFileAsync("git", ["rev-parse", `${base}^{tree}`], { cwd: repository })).stdout.trim();
  const divergentTree = (await gitWithInput(
    repository,
    ["mktree"],
    `${(await execFileAsync("git", ["ls-tree", baseTree], { cwd: repository })).stdout}100644 blob ${divergentBlob}\tdivergent.txt\n`
  )).stdout.trim();
  const divergentBase = (await execFileAsync("git", ["commit-tree", divergentTree, "-p", base, "-m", "divergent base"], { cwd: repository })).stdout.trim();
  const divergentContract = buildContract({
    template: "test-review-divergent",
    templateDefinition: { ...contractTemplate, scope: ["src", "README.md"], controlPlane: { ...contractTemplate.controlPlane, reviewPolicy: "code-v1" } },
    goal: "review divergent base",
    scope: ["src", "README.md"],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: [],
    remoteRevision: divergentBase
  });
  const divergentRun = await createRun({ root, contract: divergentContract, requestedMode: "verified", cwd: repository });
  const divergentSentinel = await captureSentinel(repository, divergentContract, await loadDefaults());
  await updateState(root, divergentRun.runId, (state) => ({
    ...state,
    lastSentinel: { label: "divergent-review", digest: divergentSentinel.digest },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  await assert.rejects(
    createReviewPackage({ ...input, runId: divergentRun.runId, base: divergentBase, sentinelDigest: divergentSentinel.digest }),
    /BASE must be an ancestor of HEAD/
  );
  await assert.rejects(
    createReviewPackage({ ...input, diffManifest: { files: [] } }),
    /does not match Git BASE\.\.\.HEAD/
  );
  await assert.rejects(
    createReviewPackage({ ...input, scope: ["."] }),
    /scope must match the TaskContract scope/
  );
  await assert.rejects(
    createReviewPackage({ ...input, scope: ["src", ":(exclude)src/a.ts"] }),
    /non-literal relative path/
  );
  await assert.rejects(
    addReviewFinding(root, started.runId, {
      packageId: "review-unknown-package",
      path: "src/a.ts",
      location: "1",
      rule: "unsafe",
      severity: "P1",
      status: "open",
      summary: "must stay attached to a real package"
    }),
    /references unknown package/
  );
  await assert.rejects(
    addReviewFinding(root, started.runId, {
      packageId: first.packageId,
      path: "src/a.ts",
      location: "1",
      rule: "unsafe",
      severity: "P0",
      status: "accepted-risk",
      owner: "owner",
      reason: "reason",
      expiry: new Date(Date.now() + 86_400_000).toISOString()
    }),
    /P0 review findings cannot be accepted/
  );
  const finding = await addReviewFinding(root, started.runId, {
    packageId: first.packageId,
    path: "src/a.ts",
    location: "1",
    rule: "unsafe",
    severity: "P1",
    status: "open",
    summary: "repair me"
  });
  assert.equal(finding.id, stableFindingId({ packageId: first.packageId, path: "src/a.ts", location: "1", rule: "unsafe" }));
  const accepted = await addReviewFinding(root, started.runId, {
    packageId: first.packageId,
    path: "src/a.ts",
    location: "2",
    rule: "risk",
    severity: "P2",
    status: "accepted-risk",
    owner: "owner",
    reason: "bounded exception",
    expiry: new Date(Date.now() + 86_400_000).toISOString()
  });
  assert.equal(accepted.owner, "owner");
  assert.equal(accepted.reason, "bounded exception");
  assert.ok(accepted.expiry);
  await addEvidence(root, started.runId, await gateRecord(
    { runId: started.runId, contract: (await inspectRun(root, started.runId)).contract },
    "patch-review",
    {
      verdict: "PASS",
      findingCount: 0,
      findingIds: [finding.id, accepted.id],
      packageId: first.packageId,
      base: first.base,
      head: first.head,
      scopeDigest: first.scopeDigest,
      diffManifestDigest: first.diffManifestDigest
    },
    "review-proof"
  ));
  const packageDigest = reviewPackageDigest(first);
  const repairResult = (round) => ({
    repairAttemptId: `repair-${round}`,
    idempotencyKey: `repair-key-${round}`,
    packageDigest,
    round
  });
  const firstRepair = await recordRepairRound(root, started.runId, first.packageId, repairResult(0));
  const retriedRepair = await recordRepairRound(root, started.runId, first.packageId, repairResult(0));
  assert.equal(retriedRepair.repairRounds, firstRepair.repairRounds);
  for (let round = 1; round < 5; round += 1) await recordRepairRound(root, started.runId, first.packageId, repairResult(round));
  const status = await reviewStatus(root, started.runId);
  assert.equal(status.repairBudgetExhausted, true);
  assert.equal(status.complete, false);
  const repairRetry = await createReviewPackage(input);
  assert.equal(repairRetry.packageId, first.packageId);
  await assert.rejects(recordRepairRound(root, started.runId, first.packageId, repairResult(5)), /budget exhausted/);
  await addReviewFinding(root, started.runId, {
    packageId: first.packageId,
    path: "src/a.ts",
    location: "1",
    rule: "unsafe",
    severity: "P1",
    status: "resolved",
    evidenceId: "review-proof",
    summary: "fixed"
  }, { update: true });
  const closed = await reviewStatus(root, started.runId);
  assert.equal(closed.scopedClosed, true);
  await addReviewFinding(root, started.runId, {
    packageId: first.packageId,
    path: "src/a.ts",
    location: "2",
    rule: "risk",
    severity: "P2",
    status: "resolved",
    evidenceId: "review-proof",
    summary: "accepted risk expired by policy"
  }, { update: true });
  assert.equal((await reviewStatus(root, started.runId)).scopedClosed, true);
  await addEvidence(root, started.runId, await gateRecord(
    { runId: started.runId, contract: (await inspectRun(root, started.runId)).contract },
    "diff-review",
    {
      verdict: "PASS",
      findingCount: 0,
      packageId: first.packageId,
      base: first.base,
      head,
      scopeDigest: first.scopeDigest,
      diffManifestDigest: first.diffManifestDigest,
      instructionDigest: first.instructionDigest
    },
    "diff-review-proof"
  ));
  const driftPath = path.join(repository, "workspace-drift.txt");
  await writeFile(driftPath, "drift\n");
  await assert.rejects(
    markBroadReviewComplete(root, started.runId, first.packageId, head, sentinel.digest),
    /verified complete current sentinel/
  );
  await unlink(driftPath);
  const restoredSentinel = await captureSentinel(repository, contract, await loadDefaults());
  assert.equal(restoredSentinel.digest, sentinel.digest);
  await markBroadReviewComplete(root, started.runId, first.packageId, head, sentinel.digest);
  assert.equal((await reviewStatus(root, started.runId)).complete, true);
  const broadRetry = await createReviewPackage(input);
  assert.equal(broadRetry.packageId, first.packageId);
  await updateState(root, started.runId, (state) => ({ ...state, status: "completed" }));
  await assert.rejects(
    addReviewFinding(root, started.runId, {
      packageId: first.packageId,
      path: "src/a.ts",
      location: "3",
      rule: "post-completion-mutation",
      severity: "P1",
      status: "open",
      summary: "must be rejected after terminal completion"
    }),
    /cannot mutate a terminal run/
  );
  await assert.rejects(
    createReviewPackage({ ...input, instructionDigest: "c".repeat(64) }),
    /Review package cannot mutate a terminal run/
  );
});

test("action tokens require the mapped ledger stage to be ready", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-action-ledger-"));
  const template = {
    ...contractTemplate,
    requiredEvidence: ["environment-state"],
    actionGates: { "git.commit": ["environment-state"] },
    actionStages: { "git.commit": "review" },
    executionStages: [
      contractTemplate.executionStages[0],
      { id: "review", dependsOn: ["environment"], requiredEvidence: ["environment-state"], attemptBudget: 5, kind: "review" }
    ]
  };
  const contract = buildContract({
    template: "test-v2-action",
    templateDefinition: template,
    goal: "ledger action gate",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: ["git.commit"],
    remoteRevision: "remote"
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: root });
  const run = await inspectRun(root, started.runId);
  await addEvidence(root, started.runId, await typedRecord({ runId: started.runId, contract: run.contract }));
  await updateState(root, started.runId, (state) => ({
    ...state,
    lastSentinel: { label: "test", digest: "tree" },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const defaults = await loadDefaults();
  await assert.rejects(
    issueActionToken(root, started.runId, {
      action: "git.commit",
      provider: "git",
      resource: "commit:test",
      remoteRevision: "remote",
      requiredEvidence: ["environment-state"]
    }, "tree", defaults),
    /execution stage is ready: review/
  );
  const initialLedger = JSON.parse(await readFile(path.join(run.runDir, "ledger.json"), "utf8"));
  await transitionLedger(root, started.runId, { eventId: "start-environment", type: "start", taskId: "environment", expectedLedgerDigest: digestObject(initialLedger) });
  const startedLedger = JSON.parse(await readFile(path.join(run.runDir, "ledger.json"), "utf8"));
  await transitionLedger(root, started.runId, { eventId: "complete-environment", type: "complete", taskId: "environment", evidenceKinds: ["environment-state"], expectedLedgerDigest: digestObject(startedLedger) });
  await assert.rejects(
    issueActionToken(root, started.runId, {
      action: "git.commit",
      provider: "git",
      resource: "commit:test",
      remoteRevision: "remote",
      requiredEvidence: ["caller-selected-shortcut"]
    }, "tree", defaults),
    /caller-selected evidence does not match the contract action gate/
  );
  const issued = await issueActionToken(root, started.runId, {
    action: "git.commit",
    provider: "git",
    resource: "commit:test",
    remoteRevision: "remote",
    requiredEvidence: ["environment-state"]
  }, "tree", defaults);
  assert.equal(issued.action, "git.commit");
});

test("atomic deliberation emits no partial bundle on failed arbitration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-deliberation-"));
  const contract = buildContract({
    template: "test-deliberation",
    templateDefinition: { ...contractTemplate, controlPlane: { ...contractTemplate.controlPlane, deliberationPolicy: "allowed-v1" } },
    goal: "deliberation",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: process.cwd() });
  const sentinel = await captureSentinel(process.cwd(), contract, await loadDefaults());
  await updateState(root, started.runId, (state) => ({
    ...state,
    lastSentinel: { label: "current", digest: sentinel.digest },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  await assert.rejects(
    deliberateForRun({
      root,
      runId: started.runId,
      prompt: "bounded decision",
      config: { schemaVersion: 1, providers: [], arbiterPriority: [], probeTimeoutSeconds: 1, maxParticipants: 0 },
      allowExternalProviders: false,
      sanitized: false,
      providers: []
    }),
    /No previously proven participant/
  );
  await updateState(root, started.runId, (state) => ({ ...state, status: "completed" }));
  await assert.rejects(
    deliberateForRun({
      root,
      runId: started.runId,
      prompt: "post-terminal decision",
      config: { schemaVersion: 1, providers: [], arbiterPriority: [], probeTimeoutSeconds: 1, maxParticipants: 0 },
      allowExternalProviders: false,
      sanitized: false,
      providers: []
    }),
    /Atomic deliberation cannot mutate a terminal run/
  );
  await assert.rejects(stat(path.join((await inspectRun(root, started.runId)).runDir, "evidence-bundles")), /ENOENT/);
});
