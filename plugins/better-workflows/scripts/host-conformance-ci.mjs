#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, digestObject, safeJoin, sha256 } from "./lib/core.mjs";
import { hostConformance, releaseConformanceMatrix } from "./lib/hosts.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(pluginRoot, "../..");
const SHA40 = /^[a-f0-9]{40}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const TEST_FILES = Object.freeze([
  "plugins/better-workflows/scripts/tests/hosts.test.mjs",
  "plugins/better-workflows/scripts/tests/routing.test.mjs",
  "plugins/better-workflows/scripts/tests/workspace.test.mjs",
  "plugins/better-workflows/scripts/tests/providers.test.mjs",
  "plugins/better-workflows/scripts/tests/cli.test.mjs",
  "plugins/better-workflows/scripts/tests/control-plane-v2.test.mjs",
  "plugins/better-workflows/scripts/tests/self-improve.test.mjs"
]);

function required(name, pattern = null) {
  const value = String(process.env[name] ?? "").trim();
  if (!value || (pattern && !pattern.test(value))) throw new Error(`Missing or invalid ${name}`);
  return value;
}

async function currentRevision() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  const revision = stdout.trim();
  if (!SHA40.test(revision)) throw new Error("Current Git revision is invalid");
  return revision;
}

const hostId = required("SBW_HOST_ID", /^[a-z0-9-]+$/);
const osId = required("SBW_OS_ID", /^(?:macos|linux)$/);
const sourceRevision = required("GITHUB_SHA", SHA40);
const repository = required("GITHUB_REPOSITORY", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const runId = required("GITHUB_RUN_ID", POSITIVE_INTEGER);
const runAttempt = required("GITHUB_RUN_ATTEMPT", POSITIVE_INTEGER);
const workflowRef = required("GITHUB_WORKFLOW_REF");
const sourceRef = required("GITHUB_REF");
const stateRoot = path.resolve(required("SBW_STATE_ROOT"));
if (process.env.GITHUB_ACTIONS !== "true") throw new Error("CI conformance envelope requires GitHub Actions");
if (required("SBW_CONFORMANCE_TEST_RESULT") !== "PASS") throw new Error("Conformance tests did not pass");
if (await currentRevision() !== sourceRevision) throw new Error("Conformance source revision drifted");
if (sourceRef !== "refs/heads/main" || workflowRef !== `${repository}/.github/workflows/host-conformance.yml@refs/heads/main`) {
  throw new Error("Release conformance must run from the exact main workflow");
}

const matrix = await releaseConformanceMatrix();
const matrixEntry = matrix.find((entry) => entry.hostId === hostId && entry.osId === osId);
if (!matrixEntry) {
  throw new Error(`Not a v4.0.0 Tier 1 combination: ${hostId}/${osId}`);
}
const packageName = required("SBW_HOST_PACKAGE");
const packageVersion = required("SBW_HOST_PACKAGE_VERSION");
const executableName = required("SBW_HOST_EXECUTABLE");
if (
  packageName !== matrixEntry.packageName ||
  packageVersion !== matrixEntry.packageVersion ||
  executableName !== matrixEntry.executable
) {
  throw new Error("Host conformance package or executable drifted from host-support-v1");
}

const coreReceipt = await hostConformance({ hostId, osId, env: process.env });
if (coreReceipt.result !== "PASS") {
  throw new Error(`Host conformance failed: ${hostId}/${osId}: ${coreReceipt.blockers?.join(", ") ?? "unknown"}`);
}

const testFiles = [];
for (const relativePath of TEST_FILES) {
  testFiles.push({
    path: relativePath,
    digest: sha256(await readFile(path.join(repositoryRoot, relativePath)))
  });
}

const payload = {
  schemaVersion: 1,
  kind: "better-workflows-host-conformance-envelope",
  sourceRevision,
  hostId,
  osId,
  registryDigest: coreReceipt.registryDigest,
  coreReceiptDigest: coreReceipt.receiptDigest,
  coreReceipt,
  hostPackage: {
    name: packageName,
    version: packageVersion,
    executable: executableName
  },
  testSuite: {
    result: "PASS",
    command: "pinned host version plus official extension probe; node --test hosts.test.mjs routing.test.mjs workspace.test.mjs providers.test.mjs; targeted CLI host/direct plus source-bound ledger, typed-evidence, completion Replay, and provider-reconciliation tests",
    coverage: [
      "host-extension-validation",
      "repo-discovery",
      "worktree-create-resume-integrate-cleanup",
      "auto-direct-routing",
      "evidence-route-replay",
      "provider-reconciliation"
    ],
    files: testFiles
  },
  github: {
    repository,
    runId,
    runAttempt,
    workflowRef,
    sourceRef,
    runnerOs: required("RUNNER_OS")
  },
  authentication: {
    status: "awaiting-github-oidc-attestation",
    releaseEligible: false,
    requirement: "Release controller must verify a GitHub artifact attestation for this exact envelope digest and source revision"
  }
};
const envelope = { ...payload, envelopeDigest: digestObject(payload) };
const outputPath = safeJoin(stateRoot, "release-conformance", sourceRevision, `${hostId}-${osId}.json`);
await atomicWriteJson(stateRoot, outputPath, envelope);
process.stdout.write(`${JSON.stringify({ ok: true, outputPath, envelopeDigest: envelope.envelopeDigest, hostId, osId, sourceRevision }, null, 2)}\n`);
