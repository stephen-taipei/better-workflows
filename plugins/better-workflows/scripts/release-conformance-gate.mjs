#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteJson, digestObject, safeJoin, sha256 } from "./lib/core.mjs";
import { loadHostSupportRegistry, releaseConformanceMatrix } from "./lib/hosts.mjs";

const execFileAsync = promisify(execFile);
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TEST_FILES = Object.freeze([
  "plugins/better-workflows/scripts/tests/hosts.test.mjs",
  "plugins/better-workflows/scripts/tests/routing.test.mjs",
  "plugins/better-workflows/scripts/tests/workspace.test.mjs",
  "plugins/better-workflows/scripts/tests/providers.test.mjs",
  "plugins/better-workflows/scripts/tests/cli.test.mjs",
  "plugins/better-workflows/scripts/tests/control-plane-v2.test.mjs",
  "plugins/better-workflows/scripts/tests/self-improve.test.mjs"
]);
const COVERAGE = Object.freeze([
  "repo-discovery",
  "worktree-create-resume-integrate-cleanup",
  "auto-direct-routing",
  "evidence-route-replay",
  "provider-reconciliation"
]);

function required(name, pattern = null) {
  const value = String(process.env[name] ?? "").trim();
  if (!value || (pattern && !pattern.test(value))) throw new Error(`Missing or invalid ${name}`);
  return value;
}

async function jsonFiles(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(target);
      else if (!entry.isFile()) throw new Error(`Unsupported conformance artifact entry: ${target}`);
    }
  }
  await walk(directory);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

const sourceRevision = required("SBW_RELEASE_REVISION", SHA40);
const conformanceRunId = required("SBW_CONFORMANCE_RUN_ID", /^[1-9][0-9]*$/);
const repository = required("GITHUB_REPOSITORY", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const artifactDirectory = path.resolve(required("SBW_CONFORMANCE_ARTIFACT_DIR"));
const stateRoot = path.resolve(required("SBW_STATE_ROOT"));
const repositoryRoot = path.resolve(process.cwd());
const { stdout: runOutput } = await execFileAsync("gh", ["api", `repos/${repository}/actions/runs/${conformanceRunId}`], {
  env: process.env,
  encoding: "utf8",
  timeout: 60_000,
  maxBuffer: 2 * 1024 * 1024
});
const sourceRun = JSON.parse(runOutput);
if (
  String(sourceRun.id) !== conformanceRunId ||
  sourceRun.path !== ".github/workflows/host-conformance.yml" ||
  sourceRun.head_branch !== "main" ||
  sourceRun.head_sha !== sourceRevision ||
  !["push", "workflow_dispatch"].includes(sourceRun.event) ||
  sourceRun.status !== "completed" ||
  sourceRun.conclusion !== "success"
) {
  throw new Error("Tier 1 conformance workflow run is not an exact successful main run");
}
const registry = await loadHostSupportRegistry();
const registryDigest = digestObject(registry);
const matrix = await releaseConformanceMatrix();
const expected = new Map(matrix.map((entry) => [`${entry.hostId}-${entry.osId}.json`, entry]));
const files = await jsonFiles(artifactDirectory);
if (files.length !== expected.size) throw new Error(`Expected ${expected.size} conformance envelopes, found ${files.length}`);

const verified = [];
for (const file of files) {
  const combination = expected.get(path.basename(file));
  if (!combination) throw new Error(`Unexpected conformance envelope: ${file}`);
  expected.delete(path.basename(file));
  const envelope = JSON.parse(await readFile(file, "utf8"));
  const { envelopeDigest, ...payload } = envelope;
  if (!SHA256.test(envelopeDigest) || digestObject(payload) !== envelopeDigest) throw new Error(`Envelope digest mismatch: ${file}`);
  if (payload.kind !== "better-workflows-host-conformance-envelope" || payload.schemaVersion !== 1) throw new Error(`Envelope identity mismatch: ${file}`);
  if (payload.hostId !== combination.hostId || payload.osId !== combination.osId) throw new Error(`Envelope combination mismatch: ${file}`);
  if (payload.sourceRevision !== sourceRevision || payload.registryDigest !== registryDigest) throw new Error(`Envelope source or registry drift: ${file}`);
  const expectedWorkflowRef = `${repository}/.github/workflows/host-conformance.yml@refs/heads/main`;
  const expectedRunnerOs = payload.osId === "macos" ? "macOS" : "Linux";
  if (
    String(payload.github?.runId) !== conformanceRunId ||
    payload.github?.repository !== repository ||
    payload.github?.workflowRef !== expectedWorkflowRef ||
    payload.github?.sourceRef !== "refs/heads/main" ||
    payload.github?.runnerOs !== expectedRunnerOs
  ) throw new Error(`Envelope GitHub run mismatch: ${file}`);
  if (
    payload.hostPackage?.name !== combination.packageName ||
    payload.hostPackage?.version !== combination.packageVersion ||
    payload.hostPackage?.executable !== combination.executable
  ) throw new Error(`Envelope host package drift: ${file}`);
  if (payload.testSuite?.result !== "PASS" || payload.coreReceipt?.result !== "PASS") throw new Error(`Conformance did not pass: ${file}`);
  if (payload.authentication?.status !== "awaiting-github-oidc-attestation" || payload.authentication?.releaseEligible !== false) {
    throw new Error(`Envelope must require external attestation verification: ${file}`);
  }
  if (!payload.coreReceipt?.versionProbe?.runtime?.digest || !payload.coreReceipt?.executable?.digest) {
    throw new Error(`Executable or runtime identity missing: ${file}`);
  }
  const { receiptDigest, receiptPath: _receiptPath, ...corePayload } = payload.coreReceipt;
  if (!SHA256.test(receiptDigest) || digestObject(corePayload) !== receiptDigest || payload.coreReceiptDigest !== receiptDigest) {
    throw new Error(`Core receipt digest mismatch: ${file}`);
  }
  const testFiles = payload.testSuite.files ?? [];
  if (
    JSON.stringify(testFiles.map((entry) => entry.path).sort()) !== JSON.stringify([...TEST_FILES].sort()) ||
    JSON.stringify([...(payload.testSuite.coverage ?? [])].sort()) !== JSON.stringify([...COVERAGE].sort())
  ) throw new Error(`Conformance test or coverage manifest is incomplete: ${file}`);
  for (const testFile of testFiles) {
    const target = path.resolve(repositoryRoot, testFile.path);
    const relative = path.relative(repositoryRoot, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Conformance test path escapes the repository: ${testFile.path}`);
    }
    const current = sha256(await readFile(target));
    if (current !== testFile.digest) throw new Error(`Conformance test source drift: ${testFile.path}`);
  }
  const { stdout: attestationOutput } = await execFileAsync("gh", [
    "attestation", "verify", file,
    "--repo", repository,
    "--signer-workflow", `${repository}/.github/workflows/host-conformance.yml`,
    "--deny-self-hosted-runners",
    "--format", "json"
  ], {
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024
  });
  verified.push({
    hostId: payload.hostId,
    osId: payload.osId,
    envelopeDigest,
    coreReceiptDigest: receiptDigest,
    executableDigest: payload.coreReceipt.executable.digest,
    runtimeDigest: payload.coreReceipt.versionProbe.runtime.digest,
    attestation: "github-oidc-verified",
    attestationVerificationDigest: sha256(attestationOutput)
  });
}
if (expected.size > 0) throw new Error(`Missing conformance envelopes: ${[...expected].join(", ")}`);

verified.sort((left, right) => `${left.hostId}/${left.osId}`.localeCompare(`${right.hostId}/${right.osId}`, "en"));
const payload = {
  schemaVersion: 1,
  kind: "better-workflows-release-conformance-gate",
  sourceRevision,
  repository,
  conformanceRunId,
  registryId: registry.id,
  registryDigest,
  requiredCombinations: matrix.length,
  result: "PASS",
  receipts: verified
};
const receipt = { ...payload, receiptDigest: digestObject(payload) };
const outputPath = safeJoin(stateRoot, "release-gates", sourceRevision, "host-conformance.json");
await atomicWriteJson(stateRoot, outputPath, receipt);
process.stdout.write(`${JSON.stringify({ ok: true, outputPath, receiptDigest: receipt.receiptDigest, combinations: verified.length }, null, 2)}\n`);
