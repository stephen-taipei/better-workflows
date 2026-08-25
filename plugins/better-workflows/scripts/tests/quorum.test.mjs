import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildContract,
  canonicalJson,
  createRun,
  digestObject,
  loadDefaults,
  loadRun,
  sha256,
  updateState
} from "../lib/core.mjs";
import { assertPayloadFields } from "../lib/evidence.mjs";
import { captureSentinel } from "../lib/git.mjs";
import { createReviewPackage, reviewPackageDigest } from "../lib/review.mjs";
import {
  QUORUM_POLICY_DIGEST,
  QUORUM_ROLES,
  buildQuorumEvidencePayload,
  classifyTrustTier,
  reduceQuorum,
  validateQuorumEvidencePayload
} from "../lib/quorum.mjs";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const MERGE_BASE = BASE;
const DIGEST = (label) => sha256(`quorum-fixture:${label}`);
const execFileAsync = promisify(execFile);

function timestampFixture({ expired = false } = {}) {
  const now = Date.now();
  const issued = expired ? now - 2 * 60 * 60 * 1000 : now - 60 * 1000;
  const expires = expired ? now - 60 * 60 * 1000 : now + 10 * 60 * 1000;
  return {
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(expires).toISOString()
  };
}

function signedReceipt({ role, index, providerFamily, verdict, timestamps, keys }) {
  const key = keys[index];
  const unsigned = {
    dependencies: {
      commandsDigest: DIGEST(`commands:${role}`),
      commonDependencyDigest: DIGEST("common-dependencies"),
      evidenceDigest: DIGEST(`evidence:${role}`)
    },
    evidenceDigest: DIGEST(`role-evidence:${role}`),
    executionId: `execution-${role}`,
    expiresAt: timestamps.expiresAt,
    identityId: `identity-${role}`,
    issuedAt: timestamps.issuedAt,
    keyId: `key-${role}`,
    model: `model-${index}`,
    provider: `provider-${index}`,
    providerFamily,
    publicKey: key.publicKey,
    role,
    verdict
  };
  const signature = sign(
    null,
    Buffer.from(canonicalJson(unsigned), "utf8"),
    key.privateKey
  ).toString("base64");
  return { ...unsigned, signature };
}

function buildManifest({
  changedPaths = ["src/feature.ts"],
  verdicts = {},
  providerFamilies = ["family-a", "family-b", "family-c", "family-d", "family-e"],
  expired = false
} = {}) {
  const timestamps = timestampFixture({ expired });
  const keys = QUORUM_ROLES.map(() => {
    const pair = generateKeyPairSync("ed25519");
    return {
      privateKey: pair.privateKey,
      publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64")
    };
  });
  const receipts = QUORUM_ROLES.map((role, index) => signedReceipt({
    role,
    index,
    providerFamily: providerFamilies[index],
    verdict: verdicts[role] ?? "PASS",
    timestamps,
    keys
  }));
  const roleAssignments = QUORUM_ROLES.map((role, index) => ({
    identityId: `identity-${role}`,
    keyId: `key-${role}`,
    model: `model-${index}`,
    provider: `provider-${index}`,
    providerFamily: providerFamilies[index],
    publicKey: keys[index].publicKey,
    role
  })).sort((left, right) => left.role.localeCompare(right.role));
  const manifest = {
    base: BASE,
    blockers: [],
    changedPaths,
    contractDigest: DIGEST("contract"),
    dissent: [],
    dossierDigest: DIGEST("dossier"),
    expiresAt: timestamps.expiresAt,
    head: HEAD,
    instructionDigest: DIGEST("instruction"),
    issuedAt: timestamps.issuedAt,
    kind: "quorum-manifest-v1",
    manifestDigest: null,
    mergeBase: MERGE_BASE,
    policyDigest: QUORUM_POLICY_DIGEST,
    policyId: "agent-review-quorum-v1",
    receipts,
    reportDigest: null,
    repository: "stephen-taipei/better-workflows",
    reviewPackageDigest: DIGEST("review-package"),
    reviewPackageId: "review-package-fixture",
    roleAssignmentDigest: digestObject(roleAssignments),
    roleAssignments,
    routing: classifyTrustTier(changedPaths).tier,
    schemaVersion: 1,
    sourceBindingDigest: DIGEST("source-binding"),
    sourceSentinelDigest: DIGEST("source-sentinel"),
    templateDigest: DIGEST("template"),
    runId: "sbw-20260825T000000Z-quorumfixture"
  };
  const withoutManifestDigest = { ...manifest };
  delete withoutManifestDigest.manifestDigest;
  delete withoutManifestDigest.reportDigest;
  manifest.manifestDigest = digestObject(withoutManifestDigest);
  const roleStatuses = receipts
    .map((receipt) => ({ role: receipt.role, verdict: receipt.verdict, executionId: receipt.executionId }))
    .sort((left, right) => left.role.localeCompare(right.role));
  manifest.reportDigest = digestObject({
    manifestDigest: manifest.manifestDigest,
    routing: manifest.routing,
    roleStatuses,
    blockers: [...new Set(receipts.filter((receipt) => receipt.verdict !== "PASS").map((receipt) => `${receipt.role}:${receipt.verdict}`))].sort()
  });
  return manifest;
}

function assertHold(manifest, pattern) {
  const result = reduceQuorum(manifest);
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "HOLD");
  if (pattern) assert.match(result.blockers.join("\n"), pattern);
  return result;
}

function refreshManifestDigest(manifest) {
  const identity = { ...manifest };
  delete identity.manifestDigest;
  delete identity.reportDigest;
  manifest.manifestDigest = digestObject(identity);
  const roleStatuses = manifest.receipts
    .map((receipt) => ({ role: receipt.role, verdict: receipt.verdict, executionId: receipt.executionId }))
    .sort((left, right) => left.role.localeCompare(right.role));
  const blockers = [
    ...(manifest.receipts.filter((receipt) => receipt.verdict !== "PASS").map((receipt) => `${receipt.role}:${receipt.verdict}`)),
    ...(manifest.blockers ?? []),
    ...(manifest.dissent ?? [])
  ];
  manifest.reportDigest = digestObject({
    manifestDigest: manifest.manifestDigest,
    routing: manifest.routing,
    roleStatuses,
    blockers: [...new Set(blockers)].sort()
  });
  return manifest;
}

test("five distinct roles with bounded diversity reduce to PASS for ordinary paths", () => {
  const manifest = buildManifest();
  const result = reduceQuorum(manifest);
  assert.equal(result.ok, true);
  assert.equal(result.verdict, "PASS");
  assert.equal(result.routing.tier, "ordinary");
  assert.equal(result.roleStatuses.length, 5);
  const payload = buildQuorumEvidencePayload(manifest, result);
  assert.doesNotThrow(() => assertPayloadFields(payload, ["decision", "manifest", "manifestDigest", "routing", "roleReceipts", "blockers", "reportDigest"], "agent-review-quorum"));
  assert.doesNotThrow(() => validateQuorumEvidencePayload(payload));
});

test("missing, duplicate, BLOCK, and INCONCLUSIVE receipts always HOLD", () => {
  const missing = buildManifest();
  missing.receipts = missing.receipts.slice(0, 4);
  assertHold(missing, /exactly five receipts|manifest digest mismatch/);

  const duplicate = buildManifest();
  duplicate.receipts[4] = duplicate.receipts[0];
  assertHold(duplicate, /role assignment|each role exactly once|execution identities/);

  for (const verdict of ["BLOCK", "INCONCLUSIVE"]) {
    const manifest = buildManifest({ verdicts: { "rollout-reviewer": verdict } });
    assertHold(manifest, new RegExp(`rollout-reviewer:${verdict}`));
  }
});

test("provider-family diversity and security/adversarial separation are enforced", () => {
  assertHold(buildManifest({ providerFamilies: ["family-a", "family-a", "family-a", "family-b", "family-b"] }), /at least three provider families/);
  assertHold(buildManifest({ providerFamilies: ["family-a", "family-b", "family-a", "family-c", "family-d"] }), /Security and adversarial/);
  assertHold(buildManifest({ providerFamilies: ["family-a", "family-b", "family-c", "family-c", "family-c"] }), /provider family cannot fill more than two/);
});

test("high-risk, unknown, stale, and tampered bindings fail closed", () => {
  const highRisk = buildManifest({ changedPaths: ["plugins/better-workflows/scripts/lib/core.mjs"] });
  assert.equal(classifyTrustTier(highRisk.changedPaths).tier, "host-trusted");
  assertHold(highRisk, /host-trusted review path/);

  const unknown = buildManifest({ changedPaths: [] });
  assertHold(unknown, /Unknown quorum routing tier|changedPaths must not be empty/);

  assertHold(buildManifest({ expired: true }), /stale or outside/);

  const tampered = buildManifest();
  tampered.head = "3".repeat(40);
  assertHold(tampered, /manifest digest mismatch|binding/);
});

test("classifier checks both sides of renames and rejects unsafe path syntax", () => {
  assert.equal(classifyTrustTier([{ oldPath: "src/old.ts", path: "src/new.ts" }]).tier, "ordinary");
  assert.equal(classifyTrustTier([{ oldPath: "src/old.ts", path: "plugins/better-workflows/scripts/lib/quorum.mjs" }]).tier, "host-trusted");
  assert.equal(classifyTrustTier([{ path: "../outside" }]).tier, "unknown");
});

test("revoked execution identities cannot replay an otherwise valid quorum", () => {
  const manifest = buildManifest();
  const result = reduceQuorum(manifest, { revokedIdentityIds: ["identity-security-architect"] });
  assert.equal(result.verdict, "HOLD");
  assert.match(result.blockers.join("\n"), /identity is revoked/);
});

test("typed admission revalidates the source-bound review package and payload shape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-quorum-admission-"));
  const repository = path.join(root, "repository");
  await mkdir(repository, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "codex/quorum-fixture"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "quorum@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Quorum Fixture"], { cwd: repository });
  await mkdir(path.join(repository, "src"), { recursive: true });
  await writeFile(path.join(repository, "src", "feature.ts"), "base\n");
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: repository });
  const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  await writeFile(path.join(repository, "src", "feature.ts"), "head\n");
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", ["commit", "-qm", "head"], { cwd: repository });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const template = JSON.parse(await readFile(path.resolve("plugins/better-workflows/templates/pr-to-dev-agent-quorum.json"), "utf8"));
  const contract = buildContract({
    template: template.name,
    templateDefinition: template,
    goal: "Admit a source-bound quorum",
    scope: ["."],
    remoteRevision: base
  });
  contract.templateDigest = digestObject(template);
  const created = await createRun({ root, contract, requestedMode: "critical", cwd: repository });
  const run = await loadRun(root, created.runId);
  const sentinel = await captureSentinel(repository, run.contract, await loadDefaults());
  await updateState(root, created.runId, (state) => ({
    ...state,
    lastSentinel: { label: "quorum-admission", digest: sentinel.digest },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  }));
  const reviewPackage = await createReviewPackage({
    root,
    runId: created.runId,
    base,
    head,
    scope: ["."],
    diffManifest: { files: [{ status: "M", path: "src/feature.ts" }] },
    instructionDigest: DIGEST("instruction"),
    sentinelDigest: sentinel.digest
  });
  const manifest = refreshManifestDigest(buildManifest());
  Object.assign(manifest, {
    runId: created.runId,
    repository,
    base,
    head,
    mergeBase: base,
    contractDigest: digestObject(contract),
    templateDigest: contract.templateDigest,
    sourceBindingDigest: run.manifest.sourceBinding.digest,
    sourceSentinelDigest: sentinel.digest,
    reviewPackageId: reviewPackage.packageId,
    reviewPackageDigest: reviewPackageDigest(reviewPackage),
    instructionDigest: reviewPackage.instructionDigest
  });
  refreshManifestDigest(manifest);
  const result = reduceQuorum(manifest, {
    expected: {
      runId: created.runId,
      sourceBindingDigest: run.manifest.sourceBinding.digest,
      sourceSentinelDigest: sentinel.digest,
      contractDigest: digestObject(contract),
      templateDigest: contract.templateDigest,
      reviewPackageId: reviewPackage.packageId,
      reviewPackageDigest: reviewPackageDigest(reviewPackage),
      base,
      head,
      mergeBase: base,
      changedPaths: ["src/feature.ts"]
    }
  });
  assert.ok(result.ok, JSON.stringify(result));
  const manifestPath = path.join(root, "quorum-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const cli = await execFileAsync(
    process.execPath,
    [path.resolve("plugins/better-workflows/scripts/sbw.mjs"), "review", "quorum", "verify", created.runId, "--file", manifestPath],
    { cwd: repository, env: { ...process.env, SBW_STATE_ROOT: root } }
  );
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.ok, true);
  assert.equal(cliResult.report.hostSignerInvoked, false);
  assert.equal(cliResult.result.verdict, "PASS");
  const cliRun = await execFileAsync(
    process.execPath,
    [path.resolve("plugins/better-workflows/scripts/sbw.mjs"), "review", "quorum", "run", created.runId, "--file", manifestPath],
    { cwd: repository, env: { ...process.env, SBW_STATE_ROOT: root } }
  );
  const runResult = JSON.parse(cliRun.stdout);
  assert.equal(runResult.ok, true);
  assert.equal(runResult.report.hostSignerInvoked, false);
  assert.equal(runResult.evidence.kind, "agent-review-quorum");
  assert.equal(runResult.evidence.typedAdmission.producer, "quorum-verifier");
  const cliStatus = await execFileAsync(
    process.execPath,
    [path.resolve("plugins/better-workflows/scripts/sbw.mjs"), "review", "quorum", "status", created.runId],
    { cwd: repository, env: { ...process.env, SBW_STATE_ROOT: root } }
  );
  const statusResult = JSON.parse(cliStatus.stdout);
  assert.equal(statusResult.ok, true);
  assert.equal(statusResult.records.length, 1);
  assert.equal(statusResult.records[0].verdict, "PASS");
  await rm(root, { recursive: true, force: true });
});

test("legacy policy inputs cannot be interpreted as quorum evidence", () => {
  const manifest = buildManifest();
  const result = reduceQuorum(manifest);
  const payload = buildQuorumEvidencePayload(manifest, result);
  payload.decision.policyId = "code-v1";
  assert.throws(() => validateQuorumEvidencePayload(payload), /not bound to the verified manifest/);
});
