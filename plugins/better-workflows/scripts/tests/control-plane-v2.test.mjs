import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addEvidence,
  buildContract,
  createRun,
  digestObject,
  inspectRun,
  loadDefaults
} from "../lib/core.mjs";
import { loadEvidenceContracts } from "../lib/evidence.mjs";
import { deriveLedgerStatus, transitionLedger } from "../lib/ledger.mjs";
import { deliberateForRun } from "../lib/deliberation-receipt.mjs";
import { addReviewFinding, createReviewPackage, markBroadReviewComplete, recordRepairRound, reviewStatus, stableFindingId } from "../lib/review.mjs";
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

test("typed catalog covers exactly the 98 installed evidence kinds", async () => {
  const contracts = await loadEvidenceContracts({ refresh: true });
  assert.equal(Object.keys(contracts).length, 98);
  assert.ok(contracts["remote-sync"]);
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
  const status = await deriveLedgerStatus(root, started.runId);
  assert.ok(status.blockers.includes("invalid-typed-evidence:environment"));
  assert.equal(status.complete, false);
});

test("review package IDs are stable and bounded repair fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-review-"));
  const contract = buildContract({
    template: "test-review",
    templateDefinition: { ...contractTemplate, controlPlane: { ...contractTemplate.controlPlane, reviewPolicy: "code-v1" } },
    goal: "review",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: root });
  const base = "a".repeat(40);
  const digest = "b".repeat(64);
  const input = { root, runId: started.runId, base, head: base, scope: ["src"], diffManifest: { files: [] }, instructionDigest: digest, sentinelDigest: digest };
  const first = await createReviewPackage(input);
  const second = await createReviewPackage(input);
  assert.equal(first.packageId, second.packageId);
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
  for (let round = 0; round < 5; round += 1) await recordRepairRound(root, started.runId, first.packageId, { round });
  const status = await reviewStatus(root, started.runId);
  assert.equal(status.repairBudgetExhausted, true);
  assert.equal(status.complete, false);
  await assert.rejects(recordRepairRound(root, started.runId, first.packageId, {}), /budget exhausted/);
  await addReviewFinding(root, started.runId, {
    packageId: first.packageId,
    path: "src/a.ts",
    location: "1",
    rule: "unsafe",
    severity: "P1",
    status: "resolved",
    summary: "fixed"
  }, { update: true });
  const closed = await reviewStatus(root, started.runId);
  assert.equal(closed.scopedClosed, true);
  await markBroadReviewComplete(root, started.runId, first.packageId, base, digest);
  assert.equal((await reviewStatus(root, started.runId)).complete, true);
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
  await assert.rejects(stat(path.join((await inspectRun(root, started.runId)).runDir, "evidence-bundles")), /ENOENT/);
});
