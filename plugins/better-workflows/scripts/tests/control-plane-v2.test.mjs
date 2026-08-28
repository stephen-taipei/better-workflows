import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  addEvidence,
  addFinding,
  buildContract,
  consumeActionToken,
  createRun,
  digestObject,
  evaluateCompletion,
  executeActionToken,
  inspectRun,
  issueActionToken,
  listEffectiveEvidenceRecords,
  loadDefaults,
  refreshEvidence,
  rebindSourceBinding,
  sha256,
  supersedeEvidence,
  VERSION
} from "../lib/core.mjs";
import { admitTypedEvidence, assertPayloadFields, loadEvidenceContracts } from "../lib/evidence.mjs";
import { compileLedger, deriveLedgerStatus, transitionLedger } from "../lib/ledger.mjs";
import { deliberateForRun } from "../lib/deliberation-receipt.mjs";
import {
  addReviewFinding,
  assertReviewContinuity,
  createReviewPackage,
  markBroadReviewComplete,
  prepareFindingVerification,
  prepareReviewAxis,
  recordFindingVerification,
  recordRepairRound,
  recordReviewAxis,
  recordReviewCoverage,
  recordReviewSynthesis,
  reviewKernelStatus,
  reviewPackageDigest,
  reviewStatus,
  stableFindingId
} from "../lib/review.mjs";
import { updateState } from "../lib/core.mjs";
import { captureSentinel, captureSourceBinding } from "../lib/git.mjs";

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

const legacyReviewProfile = {
  schemaVersion: 1,
  id: "review-contract-v1",
  changedSurfaceAccounting: "diff-manifest-v1",
  anchorResolution: "package-bound-location-v1",
  findingVerification: "broad-review-v1",
  provenanceBinding: "review-package-v1",
  specBinding: "instruction-digest-v1"
};

const execFileAsync = promisify(execFile);
const SBW_CLI = fileURLToPath(new URL("../sbw.mjs", import.meta.url));

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

function currentEvidenceDependencies(run, files = []) {
  return {
    contractDigest: run.manifest.contractDigest,
    workflowVersion: VERSION,
    files,
    sourceBindingDigest: null,
    sourceSentinelDigest: null,
    policyDigest: digestObject({
      authority: run.contract.authority,
      sensitivity: run.contract.sensitivity,
      volatileExclusions: run.contract.volatileExclusions,
      highRiskIgnored: run.contract.highRiskIgnored
    }),
    promptDigest: null,
    model: null,
    reviewBinding: null,
    remoteRevision: run.contract.remoteRevision ?? null
  };
}

async function providerReconciliationSupersessionFixture({ dependencyPath = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-evidence-supersession-"));
  let dependencyInputs = { files: [] };
  let dependencyFiles = [];
  let absoluteDependencyPath = null;
  if (dependencyPath) {
    absoluteDependencyPath = path.join(root, dependencyPath);
    const dependencyBytes = Buffer.from("provider-dependency-v1\n");
    await writeFile(absoluteDependencyPath, dependencyBytes);
    const info = await stat(absoluteDependencyPath);
    dependencyInputs = { files: [dependencyPath] };
    dependencyFiles = [{
      path: dependencyPath,
      type: "file",
      mode: info.mode,
      size: info.size,
      digest: sha256(dependencyBytes)
    }];
  }
  const taskContract = buildContract({
    template: "test-v2-evidence-supersession",
    templateDefinition: {
      ...contractTemplate,
      requiredEvidence: ["provider-reconciliation"],
      executionStages: [{
        id: "provider",
        dependsOn: [],
        requiredEvidence: ["provider-reconciliation"],
        attemptBudget: 3,
        kind: "regular"
      }],
      actionStages: { "artifact.promote": "provider" },
      actionGates: { "artifact.promote": ["provider-reconciliation"] }
    },
    goal: "Recover a corrected same-attempt provider receipt",
    scope: ["."],
    risk: { risk: 2, uncertainty: 1, blastRadius: 1, irreversibility: 1, evidenceGap: 1 },
    sensitivity: "internal",
    authority: ["artifact.promote"],
    remoteRevision: "b".repeat(40)
  });
  const started = await createRun({ root, contract: taskContract, requestedMode: "verified", cwd: root });
  const run = await inspectRun(root, started.runId);
  const attemptId = "provider-attempt-1";
  const idempotencyKey = "provider-idempotency-1";
  const tokenHash = "a".repeat(64);
  const response = {
    artifact: "fixture-artifact",
    digest: "c".repeat(64),
    location: "/private/tmp/fixture-artifact"
  };
  const commonReceipt = {
    action: "artifact.promote",
    provider: "local-workspace",
    resource: "artifact/fixture-artifact",
    outcome: "success",
    runId: started.runId,
    attemptId,
    idempotencyKey,
    remoteRevision: taskContract.remoteRevision,
    executionId: `local:artifact.promote:${response.digest}`,
    proofKind: "local-workspace:artifact.promote",
    requestDigest: "d".repeat(64),
    verifiedAt: new Date().toISOString(),
    terminalState: "success",
    ...response
  };
  const malformedReceipt = {
    ...commonReceipt,
    responseDigest: digestObject({ ...response, baseRevision: taskContract.remoteRevision })
  };
  const correctedReceipt = {
    ...commonReceipt,
    responseDigest: digestObject(response)
  };
  const actionPath = path.join(run.runDir, "actions", `${tokenHash}.json`);
  const action = {
    schemaVersion: 1,
    tokenHash,
    status: "spent",
    outcome: "unknown",
    runId: started.runId,
    action: "artifact.promote",
    provider: "local-workspace",
    resource: "artifact/fixture-artifact",
    remoteRevision: taskContract.remoteRevision,
    attemptId,
    idempotencyKey
  };
  await writeFile(actionPath, `${JSON.stringify(action, null, 2)}\n`);
  const recordFor = (id, providerReceipt) => {
    const payload = {
      provider: "local-workspace",
      receipt: providerReceipt,
      actionProof: {
        schemaVersion: 1,
        runId: started.runId,
        actionAttemptId: attemptId,
        action: "artifact.promote",
        provider: "local-workspace",
        resource: "artifact/fixture-artifact",
        outcome: "success",
        idempotencyKey,
        remoteRevision: taskContract.remoteRevision,
        providerExecutionId: providerReceipt.executionId,
        providerReceiptDigest: digestObject(providerReceipt)
      }
    };
    return {
      schemaVersion: 2,
      id,
      kind: "provider-reconciliation",
      status: "complete",
      summary: `Provider reconciliation ${id}`,
      dependencyInputs,
      dependencies: currentEvidenceDependencies(run, dependencyFiles),
      receipt: {
        contractId: "evidence-contracts-v1:provider-reconciliation",
        contractVersion: 1,
        runId: started.runId,
        producer: { provider: "provider" },
        inputBinding: {
          runId: started.runId,
          contractDigest: digestObject(taskContract),
          remoteRevision: taskContract.remoteRevision
        },
        payload,
        payloadDigest: digestObject(payload),
        producedAt: new Date().toISOString()
      }
    };
  };
  const malformed = await addEvidence(root, started.runId, recordFor("provider-proof-malformed", malformedReceipt));
  const replacement = await addEvidence(root, started.runId, recordFor("provider-proof-corrected", correctedReceipt));
  const actionReceipt = {
    action: "artifact.promote",
    provider: "local-workspace",
    resource: "artifact/fixture-artifact",
    outcome: "success",
    runId: started.runId,
    attemptId,
    idempotencyKey,
    remoteRevision: taskContract.remoteRevision,
    providerReceipt: correctedReceipt,
    evidenceIds: [replacement.id]
  };
  await writeFile(actionPath, `${JSON.stringify({
    ...action,
    outcome: "success",
    receipt: actionReceipt,
    reconciledAt: new Date().toISOString()
  }, null, 2)}\n`);
  await updateState(root, started.runId, (state) => ({
    ...state,
    lastSentinel: { label: "fixture", digest: "e".repeat(64) },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  return {
    root,
    run,
    started,
    attemptId,
    malformed,
    replacement,
    dependencyPath: absoluteDependencyPath,
    dependencyOriginalBytes: absoluteDependencyPath ? Buffer.from("provider-dependency-v1\n") : null
  };
}

function reviewKernelTemplate() {
  return {
    ...contractTemplate,
    scope: ["src", "README.md"],
    reviewProfile: {
      schemaVersion: 1,
      id: "review-kernel-v2-pilot",
      changedSurfaceAccounting: "work-unit-accounting-v1",
      anchorResolution: "exact-quote-v1",
      findingVerification: "finder-verifier-v1",
      provenanceBinding: "host-attested-native-v1",
      specBinding: "instruction-digest-v1"
    },
    controlPlane: {
      ...contractTemplate.controlPlane,
      reviewPolicy: "code-v2-pilot",
      workUnitPolicy: "diff-files-v1",
      reviewLanes: [
        { id: "context-rich", role: "finder", contextProfile: "context-rich", required: true },
        { id: "low-context", role: "finder", contextProfile: "low-context", required: true },
        { id: "adversarial", role: "finder", contextProfile: "adversarial", required: true }
      ]
    }
  };
}

function attestedProviderExecution(input, reviewDigest, attestationDigest) {
  const identity = {
    provider: "codex-native-subagent",
    model: input.model,
    executionId: input.executionId,
    modelAssurance: "host-signed-attestation",
    trustAttested: true,
    promptDigest: input.inputDigest,
    reviewDigest,
    attestationDigest,
    transport: "native-subagent",
    sandbox: "read-only"
  };
  return { ...identity, executionDigest: digestObject(identity) };
}

async function admitKernelEvidence(root, run, kind, kernel) {
  const payload = kind === "work-unit-accounting"
    ? {
        result: true,
        packageId: kernel.packageId,
        repairRound: kernel.repairRound,
        workUniverseDigest: kernel.workUniverseDigest,
        reviewLanesDigest: kernel.reviewLanesDigest,
        axisSetDigest: kernel.axisSetDigest,
        coverageDigest: kernel.coverageDigest,
        items: kernel.coverage
      }
    : {
        result: true,
        packageId: kernel.packageId,
        repairRound: kernel.repairRound,
        workUniverseDigest: kernel.workUniverseDigest,
        axisSetDigest: kernel.axisSetDigest,
        verificationSetDigest: kernel.verificationSetDigest,
        coverageDigest: kernel.coverageDigest,
        findingSetDigest: kernel.findingSetDigest,
        convergenceDigest: kernel.convergenceDigest,
        items: kernel.findings
      };
  return addEvidence(root, run.runId, {
    schemaVersion: 2,
    id: `${kind}-${(kind === "work-unit-accounting" ? kernel.coverageDigest : kernel.convergenceDigest).slice(0, 24)}`,
    kind,
    status: "complete",
    summary: `Typed ${kind}`,
    acceptanceIds: [],
    dependencyInputs: { files: [] },
    receipt: {
      contractId: `evidence-contracts-v1:${kind}`,
      contractVersion: 1,
      runId: run.runId,
      producer: { provider: "better-workflows-kernel" },
      inputBinding: {
        runId: run.runId,
        contractDigest: digestObject(run.contract),
        remoteRevision: run.contract.remoteRevision ?? null
      },
      payload,
      payloadDigest: digestObject(payload),
      producedAt: new Date().toISOString()
    }
  });
}

async function reviewKernelFixture({ repeatedQuote = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-review-kernel-"));
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
  const source = repeatedQuote ? "repeat();\nrepeat();\n" : "export const a = 1;\n";
  await writeFile(path.join(repository, "src", "a.ts"), source);
  await execFileAsync("git", ["add", "src/a.ts"], { cwd: repository });
  await execFileAsync("git", ["commit", "-q", "-m", "change"], { cwd: repository });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const template = reviewKernelTemplate();
  const contract = buildContract({
    template: "self-improve-ops",
    templateDefinition: template,
    goal: "review kernel pilot",
    scope: ["src", "README.md"],
    risk: { risk: 1, uncertainty: 1, blastRadius: 1, irreversibility: 0, evidenceGap: 1 },
    sensitivity: "internal",
    authority: [],
    remoteRevision: base
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: repository });
  const run = { ...(await inspectRun(root, started.runId)), runId: started.runId };
  const sentinel = await captureSentinel(repository, contract, await loadDefaults());
  await updateState(root, started.runId, (state) => ({
    ...state,
    lastSentinel: { label: "review-kernel", digest: sentinel.digest },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const reviewPackage = await createReviewPackage({
    root,
    runId: started.runId,
    base,
    head,
    scope: ["src", "README.md"],
    diffManifest: { files: [{ status: "A", path: "src/a.ts" }] },
    instructionDigest: "d".repeat(64),
    sentinelDigest: sentinel.digest
  });
  assert.equal(reviewPackage.reviewProfileDigest, digestObject(contract.reviewProfile));
  return { root, repository, source, run, started, sentinel, reviewPackage };
}

async function recordAxis(root, runId, reviewPackage, lane, index, { findings = [], unitResults = null } = {}) {
  const inputDigest = sha256(`axis-input-${index}`);
  const input = {
    schemaVersion: 2,
    packageId: reviewPackage.packageId,
    axisId: lane.id,
    repairRound: reviewPackage.repairRounds,
    executionId: `axis-execution-${index}`,
    reviewerId: `axis-reviewer-${index}`,
    model: "gpt-5.6-codex",
    role: lane.role,
    contextProfile: lane.contextProfile,
    contextDigest: sha256(`context-${index}`),
    inputDigest,
    toolPolicyDigest: sha256("read-only-tools"),
    verdict: findings.length > 0 ? "BLOCK" : "PASS",
    unitResults: unitResults ?? reviewPackage.workUniverse.map((unit) => ({ unitId: unit.id, disposition: "reviewed-no-issue" })),
    findings
  };
  const prepared = await prepareReviewAxis(root, runId, input);
  return recordReviewAxis(root, runId, {
    ...input,
    providerExecution: attestedProviderExecution(input, prepared.reviewDigest, sha256(`attestation-${index}`))
  });
}

test("typed catalog covers exactly the 102 installed evidence kinds", async () => {
  const contracts = await loadEvidenceContracts({ refresh: true });
  assert.equal(Object.keys(contracts).length, 102);
  assert.ok(contracts["remote-sync"]);
  assert.ok(contracts["work-unit-accounting"]);
  assert.ok(contracts["review-kernel-summary"]);
  assert.ok(contracts["agent-review-quorum"]);
});

test("typed required-check admission uses the production host verifier and rejects forged, missing, altered, invalidly signed, and source-drifted approvals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-required-check-human-approval-"));
  const repository = path.join(root, "repository");
  const runId = "sbw-20260820T000000Z-123456789abc";
  const runDir = path.join(root, "runs", runId);
  const reviewPackageId = `review-${"c".repeat(32)}`;
  const sourceSentinelDigest = "4".repeat(64);
  const observedAt = new Date().toISOString();
  const completedAt = new Date(Date.parse(observedAt) - 1000).toISOString();
  await mkdir(repository);
  await execFileAsync("git", ["init", "-q", "-b", "codex/merge-approval-admission"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "sbw@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "SBW Test"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "base\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: repository });
  const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" })).stdout.trim();
  await writeFile(path.join(repository, "README.md"), "head\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "head"], { cwd: repository });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" })).stdout.trim();
  const sourceBinding = await captureSourceBinding(repository, { baseRevision: base, requireClean: true });
  const sourceBindingDigest = sourceBinding.digest;
  const contract = { schemaVersion: 2, remoteRevision: base };
  const manifest = {
    runId,
    cwd: repository,
    sourceBinding
  };
  const state = { lastSentinel: { digest: sourceSentinelDigest } };
  await mkdir(path.join(runDir, "review-packages"), { recursive: true });
  await writeFile(path.join(runDir, "state.json"), `${JSON.stringify(state)}\n`);
  await writeFile(path.join(runDir, "review-packages", `${reviewPackageId}.json`), `${JSON.stringify({
    packageId: reviewPackageId,
    head,
    base,
    broadReview: { complete: true }
  })}\n`);
  try {
    const authorization = {
      schemaVersion: 1,
      kind: "host-signed-pr-merge-authorization",
      action: "pr.merge",
      resource: "pull/21",
      runId,
      contractDigest: digestObject(contract),
      sourceBindingDigest,
      sourceSentinelDigest,
      reviewPackageId,
      repository: "github.com/example/repo",
      pr: 21,
      head,
      base,
      baseRefName: "dev",
      actor: "example-user",
      adminBypass: false,
      reviewPolicyException: "solo-repository-zero-review-v1",
      approvedAt: observedAt
    };
    const authorizationDigest = digestObject(authorization);
    let trustRoot = null;
    try {
      trustRoot = JSON.parse(await readFile("/private/etc/better-workflows/codex-trust-root.json", "utf8"));
    } catch {
      // Portable test hosts may not provision the administrator trust root.
      // Production admission must still reject an untrusted signer.
    }
    const attestationPath = path.join(root, "merge-approval.attestation.json");
    const invalidAttestation = {
      schemaVersion: 1,
      provider: "codex-native-subagent",
      base,
      head,
      instructionDigest: authorizationDigest,
      model: "pr-merge-human-authorization",
      packageId: `merge-approval-${authorizationDigest}`,
      promptDigest: authorizationDigest,
      reviewDigest: authorizationDigest,
      reviewerId: "better-workflows-pr-merge-human-approval",
      runId,
      sentinelDigest: sourceSentinelDigest,
      issuer: trustRoot?.issuer ?? "untrusted-test-issuer",
      keyId: trustRoot?.publicKeys?.[0]?.keyId ?? "untrusted-test-key",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      signature: Buffer.alloc(64).toString("base64")
    };
    const invalidAttestationRaw = `${JSON.stringify(invalidAttestation)}\n`;
    await writeFile(attestationPath, invalidAttestationRaw, { mode: 0o600 });
    const payload = {
      command: "pinned gh live required-check observation",
      result: true,
      pr: 21,
      head,
      base,
      repository: authorization.repository,
      baseRefName: "dev",
      checkSet: ["test"],
      providerRunIds: ["101"],
      conclusions: ["success"],
      checks: [{ name: "test#101", providerName: "test", providerRunId: "101", observationKind: "check-run", completedAt, conclusion: "success" }],
      requiredStatusChecks: ["test"],
      requiredStatusCheckApps: [{ context: "test", appId: 15368 }],
      provider: "github",
      providerExecutable: { path: "/usr/bin/false", digest: "5".repeat(64) },
      observedAt,
      humanApproval: {
        schemaVersion: 1,
        authorization,
        authorizationDigest,
        attestation: {
          path: attestationPath,
          attestationDigest: "6".repeat(64),
          fileDigest: sha256(await readFile(attestationPath))
        }
      }
    };
    const run = { root, runDir, manifest, contract, state };
    const forgedAuthorization = { ...authorization, sourceBindingDigest: "8".repeat(64) };
    const forgedPayload = {
      ...payload,
      humanApproval: {
        ...payload.humanApproval,
        authorization: forgedAuthorization,
        authorizationDigest: digestObject(forgedAuthorization)
      }
    };
    await assert.rejects(
      admitTypedEvidence(
        await gateRecord({ runId, contract }, "required-checks", forgedPayload, "required-checks-forged-human-approval"),
        run
      ),
      /human approval binding is incomplete/
    );
    await assert.rejects(
      admitTypedEvidence(
        await gateRecord({ runId, contract }, "required-checks", {
          ...payload,
          humanApproval: {
            ...payload.humanApproval,
            attestation: {
              ...payload.humanApproval.attestation,
              path: path.join(root, "missing.attestation.json")
            }
          }
        }, "required-checks-missing-attestation"),
        run
      ),
      /ENOENT|attestation/i
    );
    await writeFile(attestationPath, `${invalidAttestationRaw} `, { mode: 0o600 });
    await assert.rejects(
      admitTypedEvidence(
        await gateRecord({ runId, contract }, "required-checks", payload, "required-checks-altered-attestation"),
        run
      ),
      /attestation changed after authorization/
    );
    await writeFile(attestationPath, invalidAttestationRaw, { mode: 0o600 });
    await assert.rejects(
      admitTypedEvidence(
        await gateRecord({ runId, contract }, "required-checks", payload, "required-checks-invalid-signature"),
        run
      ),
      /signature is invalid|issuer is not trusted|key is not available|trust root is not provisioned/
    );
    await writeFile(path.join(repository, "README.md"), "drift\n");
    await assert.rejects(
      admitTypedEvidence(
        await gateRecord({ runId, contract }, "required-checks", payload, "required-checks-source-drift"),
        run
      ),
      /source registry binding is stale|source binding changed/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed handoff evidence admits only its declared nullable evaluator authorization and policy digest", async () => {
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
    evaluatorAuthorization: null,
    comparisonDigest: "6".repeat(64),
    candidateDigest: "7".repeat(64),
    candidateRoot: "/tmp/candidate",
    purpose: "evaluator-migration",
    policyDigest: null,
    witnessDigests: ["8".repeat(64)]
  };
  assert.deepEqual(definition.nullableFields, ["evaluatorAuthorization", "policyDigest"]);
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
  const missingEvaluatorAuthorization = { ...payload };
  delete missingEvaluatorAuthorization.evaluatorAuthorization;
  assert.throws(
    () => assertPayloadFields(missingEvaluatorAuthorization, definition.requiredFields, kind, definition.nullableFields),
    /missing required field: evaluatorAuthorization/
  );
});

test("single-task non-direct run creates one ledger and no automatic design or review artifacts", async () => {
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
  const artifacts = (await readdir(run.runDir)).sort();
  assert.deepEqual(artifacts.filter((name) => /ledger/i.test(name)), ["ledger.json"]);
  assert.deepEqual(artifacts.filter((name) => /design|review/i.test(name)), []);
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
  const reboundLedger = await deriveLedgerStatus(root, started.runId);
  assert.equal(reboundLedger.taskStates[0].state, "pending");
  assert.deepEqual(reboundLedger.blockers, []);
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
    checks: [{ name: "test#provider-run-1", providerName: "test", providerRunId: "provider-run-1", observationKind: "check-run", completedAt: new Date(Date.now() - 1000).toISOString(), conclusion: "SUCCESS" }],
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
      checks: [{ name: "test", providerRunId: "provider-run-1", observationKind: "check-run", conclusion: "SUCCESS" }]
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

test("same-attempt provider evidence supersession is append-only and restores deterministic ledger completion", async () => {
  const fixture = await providerReconciliationSupersessionFixture();
  try {
    const before = await deriveLedgerStatus(fixture.root, fixture.started.runId);
    assert.ok(before.blockers.includes(`invalid-typed-evidence:${fixture.malformed.id}`));
    const malformedPath = path.join(fixture.run.runDir, "evidence", `${fixture.malformed.id}.json`);
    const malformedBytes = await readFile(malformedPath, "utf8");
    const input = {
      schemaVersion: 1,
      id: "provider-proof-correction-1",
      supersededEvidenceId: fixture.malformed.id,
      supersededEvidenceDigest: digestObject(fixture.malformed),
      replacementEvidenceId: fixture.replacement.id,
      replacementEvidenceDigest: digestObject(fixture.replacement),
      actionAttemptId: fixture.attemptId,
      reason: "Correct the response digest while preserving the exact provider action attempt"
    };
    const inputPath = path.join(fixture.root, "supersession-input.json");
    await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
    const command = await execFileAsync(process.execPath, [
      SBW_CLI,
      "evidence",
      "supersede",
      fixture.started.runId,
      "--file",
      inputPath
    ], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, SBW_STATE_ROOT: fixture.root }
    });
    const supersession = JSON.parse(command.stdout).supersession;
    const retried = await supersedeEvidence(fixture.root, fixture.started.runId, input);
    assert.equal(digestObject(retried), digestObject(supersession));
    await assert.rejects(
      supersedeEvidence(fixture.root, fixture.started.runId, {
        ...input,
        id: "provider-proof-conflicting-correction"
      }),
      /already bound/
    );
    const journal = (await readFile(path.join(fixture.run.runDir, "journal.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(journal.filter((entry) => entry.event === "evidence.superseded").length, 1);
    assert.equal(await readFile(malformedPath, "utf8"), malformedBytes);
    assert.equal(supersession.actor, "root");
    assert.equal(supersession.action.attemptId, fixture.attemptId);
    const effective = await listEffectiveEvidenceRecords(fixture.root, fixture.started.runId);
    assert.deepEqual(effective.map((record) => record.id), [fixture.replacement.id]);
    const after = await deriveLedgerStatus(fixture.root, fixture.started.runId);
    assert.equal(after.blockers.some((item) => item.startsWith("invalid-typed-evidence:")), false);
    await transitionLedger(fixture.root, fixture.started.runId, {
      eventId: "start-provider",
      type: "start",
      taskId: "provider"
    });
    await transitionLedger(fixture.root, fixture.started.runId, {
      eventId: "complete-provider",
      type: "complete",
      taskId: "provider",
      evidenceKinds: ["provider-reconciliation"]
    });
    const terminalOne = await deriveLedgerStatus(fixture.root, fixture.started.runId);
    const terminalTwo = await deriveLedgerStatus(fixture.root, fixture.started.runId);
    assert.deepEqual(terminalTwo, terminalOne);
    assert.equal(terminalOne.complete, true);
    const completion = await evaluateCompletion(fixture.root, fixture.started.runId);
    assert.equal(completion.ok, true, completion.blockers.join(", "));
    assert.deepEqual(completion.evidence.map((record) => record.id), [fixture.replacement.id]);
    assert.deepEqual(completion.evidenceSupersessions.map((record) => record.id), [supersession.id]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resume freshness and action issuance preserve supersession-bound evidence bytes", async () => {
  const fixture = await providerReconciliationSupersessionFixture();
  try {
    const supersession = await supersedeEvidence(fixture.root, fixture.started.runId, {
      schemaVersion: 1,
      id: "provider-proof-immutable-refresh",
      supersededEvidenceId: fixture.malformed.id,
      supersededEvidenceDigest: digestObject(fixture.malformed),
      replacementEvidenceId: fixture.replacement.id,
      replacementEvidenceDigest: digestObject(fixture.replacement),
      actionAttemptId: fixture.attemptId,
      reason: "Preserve both provider receipts across resume and action freshness checks"
    });
    const malformedPath = path.join(fixture.run.runDir, "evidence", `${fixture.malformed.id}.json`);
    const replacementPath = path.join(fixture.run.runDir, "evidence", `${fixture.replacement.id}.json`);
    const originalBytes = await Promise.all([readFile(malformedPath, "utf8"), readFile(replacementPath, "utf8")]);
    const firstRefresh = await refreshEvidence(fixture.root, fixture.started.runId);
    const secondRefresh = await refreshEvidence(fixture.root, fixture.started.runId);
    assert.deepEqual(firstRefresh.immutableEvidenceIds, [fixture.replacement.id, fixture.malformed.id].sort());
    assert.deepEqual(secondRefresh.immutableEvidenceIds, firstRefresh.immutableEvidenceIds);
    assert.deepEqual(firstRefresh.immutableStale, []);
    const issued = await issueActionToken(fixture.root, fixture.started.runId, {
      action: "artifact.promote",
      provider: "local-workspace",
      resource: "artifact/fixture-artifact",
      remoteRevision: fixture.run.contract.remoteRevision,
      requiredEvidence: ["provider-reconciliation"]
    }, "e".repeat(64), await loadDefaults());
    assert.equal(issued.action, "artifact.promote");
    assert.equal(typeof issued.token, "string");
    assert.match(issued.evidenceSupersessionFreshnessDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      await Promise.all([readFile(malformedPath, "utf8"), readFile(replacementPath, "utf8")]),
      originalBytes
    );
    const replayOne = await listEffectiveEvidenceRecords(fixture.root, fixture.started.runId);
    const replayTwo = await listEffectiveEvidenceRecords(fixture.root, fixture.started.runId);
    assert.deepEqual(replayTwo, replayOne);
    assert.deepEqual(replayOne.map((record) => record.id), [fixture.replacement.id]);
    assert.equal(supersession.replacementEvidence.id, fixture.replacement.id);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("action authority recomputes immutable supersession freshness at issue and consume", async () => {
  const fixture = await providerReconciliationSupersessionFixture({
    dependencyPath: "provider-dependency.txt"
  });
  try {
    await supersedeEvidence(fixture.root, fixture.started.runId, {
      schemaVersion: 1,
      id: "provider-proof-freshness-authority",
      supersededEvidenceId: fixture.malformed.id,
      supersededEvidenceDigest: digestObject(fixture.malformed),
      replacementEvidenceId: fixture.replacement.id,
      replacementEvidenceDigest: digestObject(fixture.replacement),
      actionAttemptId: fixture.attemptId,
      reason: "Bind immutable provider receipts to action issue and consumption freshness"
    });
    const request = {
      action: "artifact.promote",
      provider: "local-workspace",
      resource: "artifact/fixture-artifact",
      remoteRevision: fixture.run.contract.remoteRevision,
      requiredEvidence: ["provider-reconciliation"]
    };
    await writeFile(fixture.dependencyPath, "provider-dependency-drifted\n");
    await assert.rejects(
      issueActionToken(
        fixture.root,
        fixture.started.runId,
        request,
        "e".repeat(64),
        await loadDefaults()
      ),
      /stale immutable supersession evidence|current canonical dependency projection/
    );

    await writeFile(fixture.dependencyPath, fixture.dependencyOriginalBytes);
    const issued = await issueActionToken(
      fixture.root,
      fixture.started.runId,
      request,
      "e".repeat(64),
      await loadDefaults()
    );
    assert.match(issued.evidenceSupersessionFreshnessDigest, /^[a-f0-9]{64}$/);
    await writeFile(fixture.dependencyPath, "provider-dependency-drifted-after-issue\n");
    await assert.rejects(
      consumeActionToken(fixture.root, fixture.started.runId, issued.token, "e".repeat(64)),
      /stale immutable supersession evidence|current canonical dependency projection|immutable evidence freshness changed/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("freshness transitions preserve an append-only digest chain from admitted evidence", async () => {
  const fixture = await providerReconciliationSupersessionFixture({
    dependencyPath: "provider-freshness-input.txt"
  });
  try {
    await writeFile(fixture.dependencyPath, "provider-freshness-input-drifted\n");
    const freshness = await refreshEvidence(fixture.root, fixture.started.runId);
    assert.deepEqual(freshness.stale.sort(), [fixture.malformed.id, fixture.replacement.id].sort());
    const journal = (await readFile(path.join(fixture.run.runDir, "journal.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const transitions = journal.filter((entry) => entry.event === "evidence.freshness-transition");
    assert.equal(transitions.length, 2);
    assert.ok(transitions.every((entry) => (
      /^[a-f0-9]{64}$/.test(entry.previousEvidenceDigest) &&
      /^[a-f0-9]{64}$/.test(entry.evidenceDigest) &&
      /^[a-f0-9]{64}$/.test(entry.immutableEvidenceDigest) &&
      /^[a-f0-9]{64}$/.test(entry.transitionDigest) &&
      entry.cause?.kind === "dependency-refresh"
    )));
    const replay = await listEffectiveEvidenceRecords(fixture.root, fixture.started.runId);
    assert.ok(replay.every((record) => record.stale === true));

    const malformedPath = path.join(fixture.run.runDir, "evidence", `${fixture.malformed.id}.json`);
    const staleRecord = JSON.parse(await readFile(malformedPath, "utf8"));
    await writeFile(malformedPath, `${JSON.stringify({
      ...staleRecord,
      dependencyInputs: { files: ["forged-missing-input.txt"] },
      dependencies: {
        ...staleRecord.dependencies,
        files: [{ path: "forged-missing-input.txt", type: "missing" }]
      },
      currentDependencyFiles: [{ path: "forged-missing-input.txt", type: "missing" }]
    }, null, 2)}\n`);
    await assert.rejects(
      listEffectiveEvidenceRecords(fixture.root, fixture.started.runId),
      /Evidence stale provenance is invalid/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evidence supersession replay rejects duplicate and filename-rebound identities", async () => {
  const duplicateCases = [
    {
      label: "target",
      duplicateName: "duplicate-target.json",
      record(fixture) { return fixture.malformed; }
    },
    {
      label: "replacement",
      duplicateName: "duplicate-replacement.json",
      record(fixture) { return fixture.replacement; }
    },
    {
      label: "valid and malformed target",
      duplicateName: "valid-target-alias.json",
      record(fixture) { return { ...fixture.replacement, id: fixture.malformed.id }; }
    }
  ];
  for (const duplicateCase of duplicateCases) {
    const fixture = await providerReconciliationSupersessionFixture();
    try {
      await supersedeEvidence(fixture.root, fixture.started.runId, {
        schemaVersion: 1,
        id: `provider-proof-duplicate-${duplicateCase.label.replaceAll(" ", "-")}`,
        supersededEvidenceId: fixture.malformed.id,
        supersededEvidenceDigest: digestObject(fixture.malformed),
        replacementEvidenceId: fixture.replacement.id,
        replacementEvidenceDigest: digestObject(fixture.replacement),
        actionAttemptId: fixture.attemptId,
        reason: "Reject duplicate persisted evidence identities during deterministic replay"
      });
      await writeFile(
        path.join(fixture.run.runDir, "evidence", duplicateCase.duplicateName),
        `${JSON.stringify(duplicateCase.record(fixture), null, 2)}\n`
      );
      await assert.rejects(
        listEffectiveEvidenceRecords(fixture.root, fixture.started.runId),
        /Evidence record id is duplicated/
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }

  const supersessionDuplicate = await providerReconciliationSupersessionFixture();
  try {
    const record = await supersedeEvidence(supersessionDuplicate.root, supersessionDuplicate.started.runId, {
      schemaVersion: 1,
      id: "provider-proof-duplicate-supersession",
      supersededEvidenceId: supersessionDuplicate.malformed.id,
      supersededEvidenceDigest: digestObject(supersessionDuplicate.malformed),
      replacementEvidenceId: supersessionDuplicate.replacement.id,
      replacementEvidenceDigest: digestObject(supersessionDuplicate.replacement),
      actionAttemptId: supersessionDuplicate.attemptId,
      reason: "Reject a duplicated supersession identity before evidence reduction"
    });
    await writeFile(
      path.join(supersessionDuplicate.run.runDir, "evidence-supersessions", "duplicate-supersession.json"),
      `${JSON.stringify(record, null, 2)}\n`
    );
    await assert.rejects(
      supersedeEvidence(supersessionDuplicate.root, supersessionDuplicate.started.runId, {
        schemaVersion: 1,
        id: record.id,
        supersededEvidenceId: supersessionDuplicate.malformed.id,
        supersededEvidenceDigest: digestObject(supersessionDuplicate.malformed),
        replacementEvidenceId: supersessionDuplicate.replacement.id,
        replacementEvidenceDigest: digestObject(supersessionDuplicate.replacement),
        actionAttemptId: supersessionDuplicate.attemptId,
        reason: record.reason
      }),
      /Evidence supersession record id is duplicated/
    );
    await assert.rejects(
      listEffectiveEvidenceRecords(supersessionDuplicate.root, supersessionDuplicate.started.runId),
      /Evidence supersession record id is duplicated/
    );
  } finally {
    await rm(supersessionDuplicate.root, { recursive: true, force: true });
  }

  const filenameMismatch = await providerReconciliationSupersessionFixture();
  try {
    await writeFile(
      path.join(filenameMismatch.run.runDir, "evidence", "wrong-filename.json"),
      `${JSON.stringify({ ...filenameMismatch.replacement, id: "filename-bound-evidence" }, null, 2)}\n`
    );
    await assert.rejects(
      listEffectiveEvidenceRecords(filenameMismatch.root, filenameMismatch.started.runId),
      /Evidence filename does not match record id/
    );
    await assert.rejects(
      addEvidence(filenameMismatch.root, filenameMismatch.started.runId, {
        ...filenameMismatch.replacement,
        id: "new-provider-proof"
      }),
      /Evidence filename does not match record id/
    );
  } finally {
    await rm(filenameMismatch.root, { recursive: true, force: true });
  }
});

test("evidence supersession rejects cross-attempt input and manually forged stale state", async () => {
  const fixture = await providerReconciliationSupersessionFixture();
  try {
    await assert.rejects(
      supersedeEvidence(fixture.root, fixture.started.runId, {
        schemaVersion: 1,
        id: "cross-attempt-correction",
        supersededEvidenceId: fixture.malformed.id,
        supersededEvidenceDigest: digestObject(fixture.malformed),
        replacementEvidenceId: fixture.replacement.id,
        replacementEvidenceDigest: digestObject(fixture.replacement),
        actionAttemptId: "different-attempt",
        reason: "A different attempt must never supersede this evidence"
      }),
      /actionAttemptId changed/
    );
    await assert.rejects(
      supersedeEvidence(fixture.root, fixture.started.runId, {
        schemaVersion: 1,
        id: "missing-replacement-correction",
        supersededEvidenceId: fixture.malformed.id,
        supersededEvidenceDigest: digestObject(fixture.malformed),
        replacementEvidenceId: "missing-provider-proof",
        replacementEvidenceDigest: "f".repeat(64),
        actionAttemptId: fixture.attemptId,
        reason: "A missing replacement must leave the original evidence blocking"
      }),
      /target or replacement is missing/
    );
    const replacementPath = path.join(fixture.run.runDir, "evidence", `${fixture.replacement.id}.json`);
    const replacementBytes = await readFile(replacementPath, "utf8");
    const policyDrifted = {
      ...fixture.replacement,
      dependencies: { ...fixture.replacement.dependencies, policyDigest: "f".repeat(64) }
    };
    await writeFile(replacementPath, `${JSON.stringify(policyDrifted, null, 2)}\n`);
    await assert.rejects(
      supersedeEvidence(fixture.root, fixture.started.runId, {
        schemaVersion: 1,
        id: "policy-drift-correction",
        supersededEvidenceId: fixture.malformed.id,
        supersededEvidenceDigest: digestObject(fixture.malformed),
        replacementEvidenceId: policyDrifted.id,
        replacementEvidenceDigest: digestObject(policyDrifted),
        actionAttemptId: fixture.attemptId,
        reason: "A policy-drifted replacement must not supersede current evidence"
      }),
      /source or policy binding changed/
    );
    await writeFile(replacementPath, replacementBytes);
    const malformedPath = path.join(fixture.run.runDir, "evidence", `${fixture.malformed.id}.json`);
    await writeFile(malformedPath, `${JSON.stringify({ ...fixture.malformed, stale: true }, null, 2)}\n`);
    const forged = await deriveLedgerStatus(fixture.root, fixture.started.runId);
    assert.ok(forged.blockers.some((item) => item.includes("Evidence stale provenance is invalid")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evidence supersession requires the current canonical policy dependency projection", async () => {
  const fixture = await providerReconciliationSupersessionFixture();
  try {
    const malformedPath = path.join(fixture.run.runDir, "evidence", `${fixture.malformed.id}.json`);
    const replacementPath = path.join(fixture.run.runDir, "evidence", `${fixture.replacement.id}.json`);
    const arbitraryPolicyDigest = "f".repeat(64);
    const malformed = {
      ...fixture.malformed,
      dependencies: { ...fixture.malformed.dependencies, policyDigest: arbitraryPolicyDigest }
    };
    const replacement = {
      ...fixture.replacement,
      dependencies: { ...fixture.replacement.dependencies, policyDigest: arbitraryPolicyDigest }
    };
    await writeFile(malformedPath, `${JSON.stringify(malformed, null, 2)}\n`);
    await writeFile(replacementPath, `${JSON.stringify(replacement, null, 2)}\n`);
    await assert.rejects(
      supersedeEvidence(fixture.root, fixture.started.runId, {
        schemaVersion: 1,
        id: "forged-shared-policy-correction",
        supersededEvidenceId: malformed.id,
        supersededEvidenceDigest: digestObject(malformed),
        replacementEvidenceId: replacement.id,
        replacementEvidenceDigest: digestObject(replacement),
        actionAttemptId: fixture.attemptId,
        reason: "Reject two identically forged policy projections for one provider action"
      }),
      /current canonical dependency projection/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("evidence supersession replay rejects tampered records and unjournaled legacy-shaped files", async () => {
  const fixture = await providerReconciliationSupersessionFixture();
  try {
    const input = {
      schemaVersion: 1,
      id: "provider-proof-correction-2",
      supersededEvidenceId: fixture.malformed.id,
      supersededEvidenceDigest: digestObject(fixture.malformed),
      replacementEvidenceId: fixture.replacement.id,
      replacementEvidenceDigest: digestObject(fixture.replacement),
      actionAttemptId: fixture.attemptId,
      reason: "Correct the malformed receipt using the reconciled replacement"
    };
    const record = await supersedeEvidence(fixture.root, fixture.started.runId, input);
    const supersessionPath = path.join(fixture.run.runDir, "evidence-supersessions", `${record.id}.json`);
    await writeFile(supersessionPath, `${JSON.stringify({ ...record, reason: `${record.reason} tampered` }, null, 2)}\n`);
    const tampered = await deriveLedgerStatus(fixture.root, fixture.started.runId);
    assert.ok(tampered.blockers.some((item) => item.startsWith("invalid-evidence-supersession:")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }

  const legacy = await providerReconciliationSupersessionFixture();
  try {
    const directory = path.join(legacy.run.runDir, "evidence-supersessions");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "manual.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "manual",
      runId: legacy.started.runId
    })}\n`);
    const status = await deriveLedgerStatus(legacy.root, legacy.started.runId);
    assert.ok(status.blockers.some((item) => item.startsWith("invalid-evidence-supersession:")));
  } finally {
    await rm(legacy.root, { recursive: true, force: true });
  }
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

test("ledger status reloads run state before validating sentinel-bound evidence", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-ledger-sentinel-workspace-"));
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Better Workflows Test"], { cwd: workspace });
  await writeFile(path.join(workspace, "source.txt"), "sentinel-bound\n");
  await execFileAsync("git", ["add", "source.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: workspace });

  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-v2-ledger-sentinel-state-"));
  const contract = buildContract({
    template: "test-ledger-sentinel",
    templateDefinition: {
      ...contractTemplate,
      requiredEvidence: ["decision-record"],
      executionStages: [{
        id: "decision",
        dependsOn: [],
        requiredEvidence: ["decision-record"],
        attemptBudget: 3,
        kind: "regular"
      }]
    },
    goal: "ledger sentinel-bound evidence",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: workspace });
  const sentinel = await captureSentinel(workspace, contract, await loadDefaults());
  await updateState(root, started.runId, (state) => ({
    ...state,
    lastSentinel: { label: "sentinel-bound-evidence", digest: sentinel.digest },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const run = await inspectRun(root, started.runId);
  const payload = { decision: "IMPLEMENT" };
  await addEvidence(root, started.runId, {
    schemaVersion: 2,
    id: "sentinel-bound-decision",
    kind: "decision-record",
    status: "complete",
    summary: "Decision is bound to the current source and sentinel",
    receipt: {
      contractId: "evidence-contracts-v1:decision-record",
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
  assert.deepEqual(status.readySet, ["decision"]);
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
  const contract = buildContract({
    template: "test-completion-sentinel",
    templateDefinition: {
      ...contractTemplate,
      requiredEvidence: ["decision-record"],
      executionStages: [{
        id: "decision",
        dependsOn: [],
        requiredEvidence: ["decision-record"],
        attemptBudget: 3,
        kind: "regular"
      }]
    },
    goal: "completion sentinel context",
    scope: ["."],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: []
  });
  const started = await createRun({ root, contract, requestedMode: "verified", cwd: workspace });
  const sentinel = await captureSentinel(workspace, contract, await loadDefaults());
  await updateState(root, started.runId, (state) => ({
    ...state,
    lastSentinel: { label: "completion-sentinel", digest: sentinel.digest },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const run = await inspectRun(root, started.runId);
  const payload = { decision: "IMPLEMENT" };
  await addEvidence(root, started.runId, {
    schemaVersion: 2,
    id: "completion-sentinel-decision",
    kind: "decision-record",
    status: "complete",
    summary: "Current decision evidence is bound to the completion sentinel",
    receipt: {
      contractId: "evidence-contracts-v1:decision-record",
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
    eventId: "start-completion-decision",
    type: "start",
    taskId: "decision",
    expectedLedgerDigest: digestObject(initialLedger)
  });
  const startedLedger = JSON.parse(await readFile(path.join(run.runDir, "ledger.json"), "utf8"));
  await transitionLedger(root, started.runId, {
    eventId: "complete-completion-decision",
    type: "complete",
    taskId: "decision",
    evidenceKinds: ["decision-record"],
    expectedLedgerDigest: digestObject(startedLedger)
  });

  const completion = await evaluateCompletion(root, started.runId);
  assert.equal(completion.ok, true);
  assert.equal(completion.blockers.includes("invalid-typed-evidence:completion-sentinel-decision"), false);

  await updateState(root, started.runId, (state) => ({
    ...state,
    lastSentinel: { label: "stale-completion-sentinel", digest: "f".repeat(64) }
  }));
  const staleCompletion = await evaluateCompletion(root, started.runId);
  assert.equal(staleCompletion.ok, false);
  assert.equal(staleCompletion.blockers.includes("invalid-typed-evidence:completion-sentinel-decision"), true);
  await rm(workspace, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
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

test("review package identity is pure across repeated and frozen digest inputs", () => {
  const mutable = { schemaVersion: 1, immutable: true, identityFields: ["base"] };
  const before = [...mutable.identityFields];
  const first = reviewPackageDigest(mutable);
  const second = reviewPackageDigest(mutable);
  assert.equal(first, second);
  assert.deepEqual(mutable.identityFields, before);
  const frozen = Object.freeze({ schemaVersion: 1, immutable: true, identityFields: Object.freeze(["base"]) });
  assert.doesNotThrow(() => reviewPackageDigest(frozen));
  assert.equal(reviewPackageDigest(frozen), reviewPackageDigest(frozen));
});

test("review packages reject head drift with stable finding identity, block after the fifth scoped repair round, and require final broad review", async () => {
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
    templateDefinition: {
      ...contractTemplate,
      scope: ["src", "README.md"],
      reviewProfile: legacyReviewProfile,
      controlPlane: { ...contractTemplate.controlPlane, reviewPolicy: "code-v1" }
    },
    goal: "review",
    scope: ["src", "README.md"],
    risk: { risk: 1, uncertainty: 0, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    authority: ["pr.merge"],
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
    instructionDigest: tampered.instructionDigest,
    reviewProfileDigest: tampered.reviewProfileDigest
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
    templateDefinition: {
      ...contractTemplate,
      scope: ["src", "README.md"],
      reviewProfile: legacyReviewProfile,
      controlPlane: { ...contractTemplate.controlPlane, reviewPolicy: "code-v1" }
    },
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
  const continuity = await assertReviewContinuity(root, started.runId);
  const runDir = (await inspectRun(root, started.runId)).runDir;
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], { cwd: repository });
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const fakeGh = path.join(bin, "gh");
  const providerCounter = path.join(root, "provider-counter");
  const providerMergeMarker = path.join(root, "provider-merge-invoked");
  const providerInjectionMode = path.join(root, "provider-injection-mode");
  const lateFindingId = stableFindingId({
    packageId: first.packageId,
    path: "src/a.ts",
    location: "late-provider-preflight",
    rule: "provider-preflight-continuity"
  });
  const lateFindingSource = path.join(root, "late-provider-finding.json");
  const lateFindingTarget = path.join(runDir, "review-findings", `${lateFindingId}.json`);
  const lateSupersessionSource = path.join(root, "late-provider-supersession.json");
  const lateSupersessionDirectory = path.join(runDir, "evidence-supersessions");
  const lateSupersessionTarget = path.join(lateSupersessionDirectory, "late-invalid-supersession.json");
  await mkdir(lateSupersessionDirectory, { recursive: true });
  await writeFile(lateFindingSource, `${JSON.stringify({
    schemaVersion: 1,
    id: lateFindingId,
    packageId: first.packageId,
    path: "src/a.ts",
    location: "late-provider-preflight",
    rule: "provider-preflight-continuity",
    severity: "P2",
    status: "open",
    summary: "A finding appeared after provider preflight began.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  })}\n`);
  await writeFile(lateSupersessionSource, `${JSON.stringify({
    schemaVersion: 1,
    id: "late-invalid-supersession",
    runId: started.runId
  })}\n`);
  const fakeGhScript = `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  printf '%s\\n' '{"login":"alice"}'
elif [ "$1" = "api" ] && [ "$2" = "repos/example/repo" ]; then
  printf '%s\\n' '{"full_name":"example/repo","permissions":{"admin":false,"maintain":false,"push":true}}'
elif [ "$1" = "api" ] && [ "$2" = "repos/example/repo/pulls/12" ]; then
  count=0
  if [ -f '${providerCounter}' ]; then count=$(/bin/cat '${providerCounter}'); fi
  count=$((count + 1))
  printf '%s' "$count" > '${providerCounter}'
  if [ "$count" -eq 2 ]; then
    if [ -f '${providerInjectionMode}' ]; then
      /bin/cp '${lateSupersessionSource}' '${lateSupersessionTarget}'
    else
      /bin/cp '${lateFindingSource}' '${lateFindingTarget}'
    fi
  fi
  printf '%s\\n' '{"number":12,"state":"open","head":{"sha":"${head}"},"base":{"ref":"main","sha":"${base}"},"mergeable":true,"mergeable_state":"clean"}'
elif [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  /usr/bin/touch '${providerMergeMarker}'
  printf '%s\\n' '{"merged":true}'
else
  exit 2
fi
`;
  await writeFile(fakeGh, fakeGhScript);
  await chmod(fakeGh, 0o755);
  const mergeToken = "review-provider-continuity-token";
  const mergeTokenHash = sha256(mergeToken);
  const providerExecutable = { path: await realpath(fakeGh), digest: sha256(fakeGhScript) };
  const providerAuthorization = {
    provider: "github-cli",
    actor: "alice",
    repository: "github.com/example/repo",
    permissions: { admin: false, maintain: false, push: true }
  };
  const mergeCommand = [
    "gh", "pr", "merge", "12", "--repo", "github.com/example/repo",
    "--match-head-commit", head, "--merge", "--delete-branch=false"
  ];
  const mergeActionRecord = {
    schemaVersion: 1,
    tokenHash: mergeTokenHash,
    status: "issued",
    outcome: null,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    runId: started.runId,
    action: "pr.merge",
    provider: "github-cli",
    resource: "pull/12",
    remoteRevision: base,
    treeDigest: sentinel.digest,
    contractDigest: digestObject(contract),
    evidenceSupersessionFreshnessDigest: digestObject([]),
    idempotencyKey: "review-provider-continuity-idempotency",
    reviewedHead: continuity.head,
    reviewPackageId: continuity.packageId,
    reviewContinuityDigest: continuity.continuityDigest,
    pullRequest: 12,
    mergeRepository: "github.com/example/repo",
    mergeCommand,
    mergeMethod: "merge",
    adminBypass: false,
    providerExecutable,
    providerAuthorizationExecutable: providerExecutable,
    providerAuthorization
  };
  await writeFile(path.join(runDir, "actions", `${mergeTokenHash}.json`), `${JSON.stringify(mergeActionRecord, null, 2)}\n`);
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath}`;
  try {
    await assert.rejects(
      executeActionToken(root, started.runId, mergeToken, sentinel.digest),
      /Review continuity requires a complete current review/
    );
  } finally {
    process.env.PATH = priorPath;
  }
  await assert.rejects(stat(providerMergeMarker));
  const stoppedMerge = (await inspectRun(root, started.runId)).actions.find((item) => item.tokenHash === mergeTokenHash);
  assert.equal(stoppedMerge.status, "spent");
  assert.equal(stoppedMerge.providerInvocation.dispatchState, "not-sent");
  await unlink(path.join(runDir, "actions", `${mergeTokenHash}.json`));
  await unlink(lateFindingTarget);
  assert.equal((await reviewStatus(root, started.runId)).complete, true);
  await unlink(providerCounter);
  await writeFile(providerInjectionMode, "supersession\n");
  const supersessionToken = "review-provider-supersession-token";
  const supersessionTokenHash = sha256(supersessionToken);
  await writeFile(path.join(runDir, "actions", `${supersessionTokenHash}.json`), `${JSON.stringify({
    ...mergeActionRecord,
    tokenHash: supersessionTokenHash,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: "review-provider-supersession-idempotency"
  }, null, 2)}\n`);
  process.env.PATH = `${bin}:${priorPath}`;
  try {
    await assert.rejects(
      executeActionToken(root, started.runId, supersessionToken, sentinel.digest),
      /Evidence supersession record keys are invalid/
    );
  } finally {
    process.env.PATH = priorPath;
  }
  await assert.rejects(stat(providerMergeMarker));
  const supersessionStoppedMerge = (await inspectRun(root, started.runId)).actions.find(
    (item) => item.tokenHash === supersessionTokenHash
  );
  assert.equal(supersessionStoppedMerge.status, "spent");
  assert.equal(supersessionStoppedMerge.providerInvocation.dispatchState, "not-sent");
  await unlink(path.join(runDir, "actions", `${supersessionTokenHash}.json`));
  await unlink(lateSupersessionTarget);
  await unlink(providerInjectionMode);
  await unlink(providerCounter);
  assert.equal((await reviewStatus(root, started.runId)).complete, true);
  const token = "review-continuity-token";
  const tokenHash = sha256(token);
  await writeFile(path.join(runDir, "actions", `${tokenHash}.json`), `${JSON.stringify({
    schemaVersion: 1,
    tokenHash,
    status: "issued",
    outcome: null,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    runId: started.runId,
    action: "worktree.cleanup",
    provider: "local-workspace",
    resource: "worktree:review-continuity",
    scope: null,
    remoteRevision: base,
    treeDigest: sentinel.digest,
    contractDigest: digestObject(contract),
    evidenceSupersessionFreshnessDigest: digestObject([]),
    idempotencyKey: "review-continuity-idempotency",
    reviewedHead: continuity.head,
    reviewPackageId: continuity.packageId,
    reviewContinuityDigest: continuity.continuityDigest
  }, null, 2)}\n`);
  await addReviewFinding(root, started.runId, {
    packageId: first.packageId,
    path: "src/a.ts",
    location: "3",
    rule: "post-authorization-finding",
    severity: "P2",
    status: "open",
    summary: "A finding added after issuance must invalidate consumption."
  });
  await assert.rejects(
    consumeActionToken(root, started.runId, token, sentinel.digest),
    /Review continuity requires a complete current review/
  );
  assert.equal((await inspectRun(root, started.runId)).actions.find((item) => item.tokenHash === tokenHash).status, "issued");
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

test("review kernel accounts every work unit, converges with zero findings, and invalidates broad review after receipt mutation", async () => {
  const fixture = await reviewKernelFixture();
  const { root, started, run, sentinel, reviewPackage } = fixture;
  assert.equal(reviewPackage.schemaVersion, 2);
  assert.equal(reviewPackage.workUniverse.length, 1);
  assert.equal(reviewPackage.workUniverseDigest, digestObject(reviewPackage.workUniverse));
  await assert.rejects(
    issueActionToken(root, started.runId, {
      action: "git.commit",
      provider: "git",
      resource: "commit:shadow-pilot",
      remoteRevision: reviewPackage.base,
      requiredEvidence: ["environment-state"]
    }, sentinel.digest, await loadDefaults()),
    /shadow-only/
  );
  const firstLane = reviewPackage.reviewLanes[0];
  const incompleteInput = {
    schemaVersion: 2,
    packageId: reviewPackage.packageId,
    axisId: firstLane.id,
    repairRound: 0,
    executionId: "missing-unit-execution",
    reviewerId: "missing-unit-reviewer",
    model: "gpt-5.6-codex",
    role: firstLane.role,
    contextProfile: firstLane.contextProfile,
    contextDigest: sha256("missing-context"),
    inputDigest: sha256("missing-input"),
    toolPolicyDigest: sha256("read-only-tools"),
    verdict: "PASS",
    unitResults: [],
    findings: []
  };
  await assert.rejects(prepareReviewAxis(root, started.runId, incompleteInput), /account for every work unit exactly once/);
  for (const [index, lane] of reviewPackage.reviewLanes.entries()) {
    await recordAxis(root, started.runId, reviewPackage, lane, index);
  }
  let kernel = await reviewKernelStatus(root, started.runId);
  assert.equal(kernel.convergence.axesComplete, true);
  assert.equal(kernel.convergence.coverageComplete, true);
  assert.equal(kernel.findings.length, 0);
  assert.equal(kernel.convergence.complete, true);
  assert.equal((await reviewStatus(root, started.runId)).scopedClosed, false);
  const coverage = await recordReviewCoverage(root, started.runId);
  const synthesis = await recordReviewSynthesis(root, started.runId);
  assert.equal(coverage.complete, true);
  assert.equal(synthesis.convergence.complete, true);
  kernel = await reviewKernelStatus(root, started.runId);
  await admitKernelEvidence(root, run, "work-unit-accounting", kernel);
  await admitKernelEvidence(root, run, "review-kernel-summary", kernel);
  assert.equal((await reviewStatus(root, started.runId)).scopedClosed, true);
  await markBroadReviewComplete(root, started.runId, reviewPackage.packageId, reviewPackage.head, sentinel.digest);
  assert.equal((await reviewStatus(root, started.runId)).complete, true);
  await recordAxis(root, started.runId, reviewPackage, firstLane, 99);
  const invalidated = await reviewStatus(root, started.runId);
  assert.equal(invalidated.kernel.convergence.axesComplete, false);
  assert.equal(invalidated.broadReviewComplete, false);
  assert.equal(invalidated.complete, false);
});

test("review kernel rejects finder self-verification and keeps ambiguous anchors blocking after refutation", async () => {
  const fixture = await reviewKernelFixture({ repeatedQuote: true });
  const { root, source, started, reviewPackage } = fixture;
  const unit = reviewPackage.workUniverse[0];
  const findingInput = {
    unitId: unit.id,
    path: unit.path,
    side: "head",
    anchor: {
      blob: unit.head.blob,
      contentDigest: sha256(source),
      quote: "repeat();",
      reportedLine: 1
    },
    rule: "duplicate-call",
    rootCause: "Repeated call has ambiguous source location",
    severity: "P2",
    claimStatus: "observed",
    summary: "The same call appears twice and cannot be uniquely anchored.",
    searchProof: ["Both occurrences are in the exact head blob."],
    counterEvidence: [],
    runtimeTrace: []
  };
  await recordAxis(root, started.runId, reviewPackage, reviewPackage.reviewLanes[0], 10, {
    findings: [findingInput],
    unitResults: [{ unitId: unit.id, disposition: "finding" }]
  });
  await recordAxis(root, started.runId, reviewPackage, reviewPackage.reviewLanes[1], 11, {
    findings: [{
      ...findingInput,
      anchor: { ...findingInput.anchor, reportedLine: 2 },
      severity: "P1",
      claimStatus: "inferred",
      summary: "A second finder independently located the same root cause.",
      searchProof: ["The low-context lane reproduced both exact occurrences."]
    }],
    unitResults: [{ unitId: unit.id, disposition: "finding" }]
  });
  await recordAxis(root, started.runId, reviewPackage, reviewPackage.reviewLanes[2], 12);
  let kernel = await reviewKernelStatus(root, started.runId);
  assert.equal(kernel.findings.length, 1);
  assert.equal(kernel.findings[0].anchor.resolution, "ambiguous");
  assert.equal(kernel.findings[0].claimConflict, false);
  assert.equal(kernel.findings[0].severity, "P1");
  assert.deepEqual(kernel.findings[0].searchProof, [
    "Both occurrences are in the exact head blob.",
    "The low-context lane reproduced both exact occurrences."
  ]);
  const claim = kernel.findings[0];
  const selfVerification = {
    schemaVersion: 2,
    packageId: reviewPackage.packageId,
    repairRound: 0,
    findingId: claim.id,
    claimDigest: claim.claimDigest,
    executionId: "self-verification-execution",
    reviewerId: "axis-reviewer-10",
    model: "gpt-5.6-codex",
    inputDigest: sha256("self-verification-input"),
    toolPolicyDigest: sha256("read-only-tools"),
    verdict: "REFUTED",
    evidence: ["Attempted self-verification must be rejected."],
    counterEvidence: []
  };
  await assert.rejects(prepareFindingVerification(root, started.runId, selfVerification), /finder cannot verify its own claim/);
  const verification = {
    ...selfVerification,
    executionId: "independent-verification-execution",
    reviewerId: "independent-verifier",
    inputDigest: sha256("independent-verification-input"),
    evidence: ["The duplicated quote cannot select one exact location." ]
  };
  const prepared = await prepareFindingVerification(root, started.runId, verification);
  await recordFindingVerification(root, started.runId, {
    ...verification,
    providerExecution: attestedProviderExecution(verification, prepared.reviewDigest, sha256("independent-verifier-attestation"))
  });
  kernel = await reviewKernelStatus(root, started.runId);
  assert.equal(kernel.findings[0].verificationVerdict, "REFUTED");
  assert.equal(kernel.findings[0].blocking, true);
  assert.equal(kernel.convergence.anchorsComplete, false);
  assert.equal(kernel.convergence.complete, false);
  const coverage = await recordReviewCoverage(root, started.runId);
  const synthesis = await recordReviewSynthesis(root, started.runId);
  assert.equal(coverage.complete, true);
  assert.equal(synthesis.convergence.complete, false);
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
  const unavailableRoster = {
    schemaVersion: 3,
    terminology: {
      modelBrands: ["Unavailable"],
      transportCommand: "sbw-unavailable-provider",
      transportModelBrands: ["Unavailable"],
      transportIsModelBrand: false
    },
    probeMarker: "SBW_UNAVAILABLE_PROVIDER",
    probeTimeoutSeconds: 1,
    rosterCacheHours: 24,
    maxParticipants: 1,
    providers: [{
      id: "unavailable",
      command: "sbw-unavailable-provider",
      probe: "text",
      external: true,
      models: [{
        model: "default",
        brand: "Unavailable",
        role: "unavailable-reviewer",
        capabilityRank: 1
      }]
    }],
    arbiterPriority: []
  };
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
      config: unavailableRoster,
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
      config: unavailableRoster,
      allowExternalProviders: false,
      sanitized: false,
      providers: []
    }),
    /Atomic deliberation cannot mutate a terminal run/
  );
  await assert.rejects(stat(path.join((await inspectRun(root, started.runId)).runDir, "evidence-bundles")), /ENOENT/);
});
