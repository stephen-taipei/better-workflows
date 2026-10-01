// SPDX-License-Identifier: AGPL-3.0-only
// Shared source/envelope validation for the existing release gate and the
// installed RC qualification observer. Provider authenticity is checked by
// each trusted caller after this structural/source-bound validation.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { digestObject, sha256 } from "./core.mjs";
import { assertCodexInstallSmokeReceiptV1, inspectCodexPublicBundleV1 } from "./codex-install-smoke-v1.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMON_TEST_FILES = Object.freeze([
  "plugins/better-workflows/scripts/tests/codex-install-smoke-v1.test.mjs",
  "plugins/better-workflows/scripts/tests/hosts.test.mjs",
  "plugins/better-workflows/scripts/tests/routing.test.mjs",
  "plugins/better-workflows/scripts/tests/workspace.test.mjs",
  "plugins/better-workflows/scripts/tests/providers.test.mjs",
  "plugins/better-workflows/scripts/tests/public-host-safety-v1.test.mjs"
]);
const V4_ONLY_TEST_FILE = "plugins/better-workflows/scripts/tests/self-improve.test.mjs";
const BASE_COVERAGE = Object.freeze([
  "host-extension-validation",
  "repo-discovery",
  "worktree-create-resume-integrate-cleanup",
  "auto-direct-routing",
  "evidence-route-replay",
  "provider-reconciliation"
]);

function fail(message) { throw new Error(`Release conformance envelope invalid: ${message}`); }

export async function inspectReleaseConformanceEnvelopeV1({
  file, envelope, combination, repositoryRoot, sourceRevision, repository,
  conformanceRunId, runAttempt, registry, registryDigest, scopeDigest, matrix
}) {
  if (!file || !envelope || !combination || !path.isAbsolute(repositoryRoot) ||
      !/^[a-f0-9]{40}$/.test(sourceRevision ?? "") ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      !/^[1-9][0-9]*$/.test(conformanceRunId ?? "") || !/^[1-9][0-9]*$/.test(runAttempt ?? "")) {
    fail("expected binding is invalid");
  }
  const { envelopeDigest, ...payload } = envelope;
  if (!SHA256.test(envelopeDigest ?? "") || digestObject(payload) !== envelopeDigest) fail(`envelope digest mismatch: ${file}`);
  if (payload.kind !== "better-workflows-host-conformance-envelope" || payload.schemaVersion !== 1) fail(`envelope identity mismatch: ${file}`);
  if (payload.hostId !== combination.hostId || payload.osId !== combination.osId) fail(`combination mismatch: ${file}`);
  if (payload.sourceRevision !== sourceRevision || payload.registryDigest !== registryDigest) fail(`source or registry drift: ${file}`);
  if ((payload.productReleaseScopeDigest ?? null) !== scopeDigest) fail(`product release scope drift: ${file}`);
  const registryHost = registry.hosts.find((host) => host.id === payload.hostId);
  if (!registryHost || registryHost.supportTier !== "tier1") fail(`host is not Tier 1: ${file}`);
  const expectedWorkflowRef = `${repository}/.github/workflows/host-conformance.yml@refs/heads/main`;
  const expectedRunnerOs = payload.osId === "macos" ? "macOS" : "Linux";
  if (String(payload.github?.runId) !== conformanceRunId || String(payload.github?.runAttempt) !== runAttempt ||
      payload.github?.repository !== repository || payload.github?.workflowRef !== expectedWorkflowRef ||
      payload.github?.sourceRef !== "refs/heads/main" || payload.github?.runnerOs !== expectedRunnerOs) fail(`GitHub run mismatch: ${file}`);
  if (payload.hostPackage?.name !== combination.packageName || payload.hostPackage?.version !== combination.packageVersion ||
      payload.hostPackage?.executable !== combination.executable) fail(`host package drift: ${file}`);
  if (payload.testSuite?.result !== "PASS" || payload.coreReceipt?.result !== "PASS") fail(`conformance did not pass: ${file}`);
  if (payload.coreReceipt.hostId !== payload.hostId || payload.coreReceipt.osId !== payload.osId ||
      payload.coreReceipt.registryDigest !== registryDigest || payload.coreReceipt.supportTier !== "tier1") fail(`core receipt binding mismatch: ${file}`);
  if (payload.authentication?.status !== "awaiting-github-oidc-attestation" || payload.authentication?.releaseEligible !== false) {
    fail(`envelope must require external attestation verification: ${file}`);
  }
  if (!payload.coreReceipt?.versionProbe?.runtime?.digest || !payload.coreReceipt?.executable?.digest) fail(`executable or runtime identity missing: ${file}`);
  if (payload.coreReceipt.versionProbe.expectedVersion !== combination.packageVersion || payload.coreReceipt.versionProbe.versionMatched !== true) {
    fail(`pinned host version was not proven: ${file}`);
  }
  const { probeDigest, ...extensionProbePayload } = payload.coreReceipt.extensionProbe ?? {};
  if (!SHA256.test(probeDigest ?? "") || digestObject(extensionProbePayload) !== probeDigest || extensionProbePayload.result !== "PASS") {
    fail(`official host extension probe is missing or invalid: ${file}`);
  }
  const expectedProbeKind = {
    codex: "native-contract", "claude-code": "cli-validate",
    "gemini-cli": "cli-validate-install", "qwen-code": "isolated-install"
  }[payload.hostId];
  if (extensionProbePayload.kind !== expectedProbeKind || !SHA256.test(extensionProbePayload.helperDigest ?? "")) fail(`host helper or extension probe kind is invalid: ${file}`);
  if (payload.coreReceipt.manifest?.digest !== extensionProbePayload.manifestDigest) fail(`doctor and extension probe manifest bindings differ: ${file}`);
  const distributionPrefix = registryHost.distributionRoot === "plugin" ? ["plugins", "better-workflows"] : [];
  const currentManifestDigest = sha256(await readFile(path.join(repositoryRoot, ...distributionPrefix, registryHost.manifestPath)));
  const currentHelperDigest = sha256(await readFile(path.join(repositoryRoot, ...distributionPrefix, registryHost.helperPath)));
  if (currentManifestDigest !== extensionProbePayload.manifestDigest || currentHelperDigest !== extensionProbePayload.helperDigest) fail(`host manifest or helper drifted from exact release source: ${file}`);
  const installedBundleRequired = payload.hostId === "gemini-cli" || payload.hostId === "qwen-code";
  if (installedBundleRequired && (!SHA256.test(extensionProbePayload.manifestDigest ?? "") ||
      extensionProbePayload.installedManifestDigest !== extensionProbePayload.manifestDigest ||
      extensionProbePayload.installedHelperDigest !== extensionProbePayload.helperDigest ||
      !SHA256.test(extensionProbePayload.componentDigest ?? "") || extensionProbePayload.installedComponentDigest !== extensionProbePayload.componentDigest ||
      !SHA256.test(extensionProbePayload.bundleDigest ?? "") || extensionProbePayload.installedBundleDigest !== extensionProbePayload.bundleDigest ||
      !Number.isInteger(extensionProbePayload.bundleFileCount) || extensionProbePayload.bundleFileCount < 1 ||
      extensionProbePayload.installedBundleFileCount !== extensionProbePayload.bundleFileCount ||
      !Number.isInteger(extensionProbePayload.bundleBytes) || extensionProbePayload.bundleBytes < 1 ||
      extensionProbePayload.installedBundleBytes !== extensionProbePayload.bundleBytes)) fail(`installed host distribution is not source-identical: ${file}`);
  const codexInstallRequired = Boolean(scopeDigest && payload.hostId === "codex");
  if (codexInstallRequired) {
    try {
      const codexPublicBundle = await inspectCodexPublicBundleV1(repositoryRoot);
      assertCodexInstallSmokeReceiptV1(payload.codexInstallSmoke, {
        source: codexPublicBundle.source, manifest: codexPublicBundle.manifest,
        codexVersion: `codex-cli ${combination.packageVersion}`, nodeVersion: "24.21.0"
      });
    } catch (error) { throw new Error(`Codex isolated Auto installation is missing or source-drifted: ${file}`, { cause: error }); }
  } else if (Object.hasOwn(payload, "codexInstallSmoke")) fail(`unexpected Codex isolated installation receipt: ${file}`);
  const { receiptDigest, receiptPath: _receiptPath, ...corePayload } = payload.coreReceipt;
  if (!SHA256.test(receiptDigest ?? "") || digestObject(corePayload) !== receiptDigest || payload.coreReceiptDigest !== receiptDigest) fail(`core receipt digest mismatch: ${file}`);
  const testFiles = payload.testSuite.files ?? [];
  const testFilesForScope = scopeDigest ? COMMON_TEST_FILES : [...COMMON_TEST_FILES, V4_ONLY_TEST_FILE];
  const expectedCoverage = codexInstallRequired ? [...BASE_COVERAGE, "codex-isolated-install-auto"] : BASE_COVERAGE;
  if (JSON.stringify(testFiles.map((entry) => entry.path).sort()) !== JSON.stringify([...testFilesForScope].sort()) ||
      JSON.stringify([...(payload.testSuite.coverage ?? [])].sort()) !== JSON.stringify([...expectedCoverage].sort())) fail(`conformance test or coverage manifest is incomplete: ${file}`);
  for (const testFile of testFiles) {
    const target = path.resolve(repositoryRoot, testFile.path);
    const relative = path.relative(repositoryRoot, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`conformance test path escapes repository: ${testFile.path}`);
    if (sha256(await readFile(target)) !== testFile.digest) fail(`conformance test source drift: ${testFile.path}`);
  }
  return Object.freeze({
    payload, envelopeDigest, coreReceiptDigest: receiptDigest,
    executableDigest: payload.coreReceipt.executable.digest,
    runtimeDigest: payload.coreReceipt.versionProbe.runtime.digest,
    extensionProbeDigest: probeDigest, helperDigest: extensionProbePayload.helperDigest,
    installedBundleDigest: codexInstallRequired ? payload.codexInstallSmoke.installedBundleDigest :
      installedBundleRequired ? extensionProbePayload.installedBundleDigest : null,
    codexInstallRequired, matrixCount: matrix.length
  });
}
