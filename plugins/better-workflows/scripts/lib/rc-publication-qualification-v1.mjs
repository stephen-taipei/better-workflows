// SPDX-License-Identifier: AGPL-3.0-only
// Installed, current observation of the unchanged RC qualification gates.
// Caller paths are locators only; authority and provider reads come from U1.
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestObject, sha256 } from "./core.mjs";
import {
  assertInstalledRcPublicationContextCurrentV1,
  assertInstalledRcPublicationContextV1,
  readInstalledRcAdapterConfigRecordV1,
  revalidateInstalledRcProjectionV1,
  rcPublicationGithubReadV1,
  rcPublicationVerifyGithubAttestationV1
} from "./rc-publication-installed-context-v1.mjs";
import { inspectInstalledFormalProtectedBundleV2 } from "./formal-protected-admission-v1.mjs";
import { loadHostSupportRegistry } from "./hosts.mjs";
import { inspectReleaseConformanceEnvelopeV1 } from "./release-conformance-envelope-v1.mjs";
import { productReleaseScope, productReleaseConformanceMatrix } from "./product-release-scope-v1.mjs";
import { PRODUCT_RELEASE_CHANNEL_CONTRACT_V1, assertProductReleaseTargetManifestV1 } from "./product-release-channel-v1.mjs";
import { verifyRuntimeQualificationV2 } from "./runtime-qualification-verifier-v2.mjs";
import { assertRootOwnedRuntimePathV2, observeRootOwnedRuntimeFileV2 } from "./runtime-qualification-v2.mjs";
import { observeWebsitePublicQaV1 } from "../../../../scripts/website-public-qa-observer-v1.mjs";
import { PUBLIC_DOC_PAGES } from "../../../../scripts/public-docs.mjs";

const INSTALL_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const POSITIVE_ID = /^[1-9][0-9]*$/;
const RUN_EVENTS = new Set(["push", "workflow_dispatch"]);
const HOST_WORKFLOW = ".github/workflows/host-conformance.yml";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const QA_WORKFLOW = ".github/workflows/website-public-qa.yml";
const VERSION_MANIFEST = "plugins/better-workflows/config/version-manifest-v1.json";
const SCOPE_MANIFEST = "plugins/better-workflows/config/product-release-scope-v1.json";
const CHANNEL_MANIFEST = "plugins/better-workflows/config/product-release-channel-v1.json";
const HOST_REGISTRY = "plugins/better-workflows/config/host-support-v1.json";
const HOSTS = Object.freeze(["codex", "gemini-cli", "qwen-code"]);
const RUNTIME_LANES = Object.freeze([
  Object.freeze({ id: "macos-node22", nodeVersion: "22.23.3" }),
  Object.freeze({ id: "macos-node24", nodeVersion: "24.21.0" })
]);
const resultBrands = new WeakMap();

function fail(message) { throw new Error(`Installed RC qualification HOLD: ${message}`); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} has missing or unexpected fields`);
  }
}
function positiveId(value, label) {
  if (typeof value !== "string" || !POSITIVE_ID.test(value)) fail(`${label} is not a positive canonical ID`);
  return value;
}
function absolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/.test(value)) {
    fail(`${label} is not a canonical absolute path`);
  }
  return value;
}
function inside(root, target, label) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label} must be an item below its fixed root`);
  }
  return target;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function sameDigest(left, right) { return digestObject(left) === digestObject(right); }

async function sourceFile(sourceRoot, relative, maxBytes = 8 * 1024 * 1024) {
  if (await realpath(sourceRoot) !== sourceRoot) fail(`source root is not a canonical physical directory: ${sourceRoot}`);
  const target = path.resolve(sourceRoot, ...relative.split("/"));
  inside(sourceRoot, target, `candidate source ${relative}`);
  const observed = await observeRootOwnedRuntimeFileV2(target, { maxBytes, includeBytes: true });
  if (!Buffer.isBuffer(observed.bytes) || observed.sha256 !== sha256(observed.bytes)) fail(`candidate source bytes are not stable: ${relative}`);
  return observed.bytes;
}

async function evidenceDirectory(evidenceRoot, value, label) {
  const target = absolutePath(value, label);
  inside(evidenceRoot, target, label);
  await assertRootOwnedRuntimePathV2(target, { directory: true });
  if (await realpath(target) !== target) fail(`${label} is not a canonical physical directory`);
  return target;
}

async function evidenceFile(evidenceRoot, value, label, maxBytes = 8 * 1024 * 1024) {
  const target = absolutePath(value, label);
  inside(evidenceRoot, target, label);
  const observation = await observeRootOwnedRuntimeFileV2(target, {
    maxBytes, exactMode: 0o600, includeBytes: true
  });
  if (!Buffer.isBuffer(observation.bytes) || observation.sha256 !== sha256(observation.bytes)) {
    fail(`${label} did not produce stable authenticated root-owned bytes`);
  }
  return { file: target, bytes: observation.bytes, sha256: observation.sha256, identity: observation.identity };
}

function validateConfig(config, context) {
  exactKeys(config, ["schemaVersion", "kind", "operationId", "bindingDigest", "runtime", "host", "ci", "site", "changelog"], "qualification config");
  if (config.schemaVersion !== 1 || config.kind !== "InstalledRcQualificationConfigV1" ||
      config.operationId !== context.operationId || config.bindingDigest !== context.bindingDigest) {
    fail("qualification config does not bind the installed operation");
  }
  exactKeys(config.runtime, ["runId", "artifactDirectory"], "runtime locator");
  exactKeys(config.host, ["runId", "runAttempt", "artifactDirectory"], "host locator");
  exactKeys(config.ci, ["runId", "runAttempt"], "CI locator");
  exactKeys(config.site, ["runId", "runAttempt", "receiptFile", "artifactId"], "site locator");
  exactKeys(config.changelog, ["file", "sha256"], "changelog binding");
  positiveId(config.runtime.runId, "runtime runId");
  positiveId(config.host.runId, "host runId");
  positiveId(config.host.runAttempt, "host runAttempt");
  positiveId(config.ci.runId, "CI runId");
  positiveId(config.ci.runAttempt, "CI runAttempt");
  positiveId(config.site.runId, "site runId");
  positiveId(config.site.runAttempt, "site runAttempt");
  positiveId(config.site.artifactId, "site artifactId");
  if (config.runtime.runId !== config.ci.runId || config.host.artifactDirectory === config.runtime.artifactDirectory ||
      !SHA256.test(config.changelog.sha256 ?? "") || config.changelog.file !== VERSION_MANIFEST) {
    fail("qualification locators are inconsistent or changelog path is not the fixed version manifest");
  }
  const evidenceRoot = absolutePath(context.paths?.evidenceRoot, "installed evidence root");
  absolutePath(config.runtime.artifactDirectory, "runtime artifact directory");
  absolutePath(config.host.artifactDirectory, "host artifact directory");
  absolutePath(config.site.receiptFile, "site QA receipt file");
  return evidenceRoot;
}

async function listAll(githubRead, endpoint, property, label) {
  const records = [];
  let declared = null;
  for (let page = 1; page <= 10; page += 1) {
    const result = await githubRead(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!result || !Number.isSafeInteger(result.total_count) || result.total_count < 0 || result.total_count > 1000 ||
        !Array.isArray(result[property]) || result[property].length > 100 ||
        (declared !== null && result.total_count !== declared)) fail(`${label} pagination is incomplete or unstable`);
    declared = result.total_count;
    records.push(...result[property]);
    if (records.length === declared) break;
    if (records.length > declared || result[property].length !== 100 || page === 10) fail(`${label} records exceed their declared page set`);
  }
  const ids = records.map((entry) => Number(entry.id));
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) fail(`${label} IDs are invalid or duplicated`);
  return records;
}

function assertSuccessfulRun(run, { context, runId, runAttempt, workflow, events, label }) {
  if (!run || String(run.id) !== runId || run.path !== workflow || run.head_branch !== "main" ||
      run.head_sha !== context.candidate.publicCandidateSha || String(run.repository?.id) !== context.target.repository.id ||
      run.repository?.full_name !== context.target.repository.name || run.status !== "completed" || run.conclusion !== "success" ||
      !events.includes(run.event) || !Number.isSafeInteger(run.run_attempt) || String(run.run_attempt) !== runAttempt) {
    fail(`${label} is not the exact successful current main workflow attempt`);
  }
  return String(run.run_attempt);
}

async function assertPublicSourceCurrent(context, githubRead) {
  const repository = context.target.repository;
  const repo = await githubRead(`repos/${repository.name}`);
  const branch = await githubRead(`repos/${repository.name}/git/ref/heads/main`);
  const commit = await githubRead(`repos/${repository.name}/git/commits/${context.candidate.publicCandidateSha}`);
  if (!repo || String(repo.id) !== repository.id || repo.full_name !== repository.name || repo.private !== false ||
      repo.archived !== false || repo.disabled !== false || branch?.ref !== context.target.sourceRef ||
      branch.object?.type !== "commit" || branch.object.sha !== context.candidate.publicCandidateSha ||
      commit?.sha !== context.candidate.publicCandidateSha || commit.tree?.sha !== context.candidate.publicTreeOid) {
    fail("public repository/main/tree no longer match the installed candidate binding");
  }
  return Object.freeze({ repositoryId: String(repo.id), repository: repo.full_name,
    sourceRef: branch.ref, sourceRevision: branch.object.sha, publicTreeOid: commit.tree.sha });
}

async function assertCandidateSource(context) {
  const sourceRoot = absolutePath(context.candidate?.publicRoot, "candidate public root");
  if (await realpath(sourceRoot) !== sourceRoot || sourceRoot === INSTALL_ROOT || sourceRoot.startsWith(`${INSTALL_ROOT}${path.sep}`)) {
    fail("public candidate source is not separate from the installed verifier image");
  }
  const [manifestBytes, scopeBytes, channelBytes] = await Promise.all([
    sourceFile(sourceRoot, VERSION_MANIFEST, 512 * 1024),
    sourceFile(sourceRoot, SCOPE_MANIFEST, 64 * 1024),
    sourceFile(sourceRoot, CHANNEL_MANIFEST, 64 * 1024)
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const target = assertProductReleaseTargetManifestV1(manifest);
  const installedScope = await productReleaseScope();
  const sourceScope = JSON.parse(scopeBytes.toString("utf8"));
  const sourceChannel = JSON.parse(channelBytes.toString("utf8"));
  if (target.channel !== "rc" || target.releaseVersion !== context.releaseTarget?.releaseVersion ||
      target.releaseTargetDigest !== context.binding.releaseTargetDigest || target.releaseTag !== context.target.tagRef.slice("refs/tags/".length) ||
      manifest.breakingChanges instanceof Array === false || manifest.breakingChanges.length < 1 ||
      digestObject(sourceScope) !== installedScope.scopeDigest || installedScope.scopeDigest !== context.binding.productReleaseScopeDigest ||
      digestObject(sourceChannel) !== digestObject(PRODUCT_RELEASE_CHANNEL_CONTRACT_V1)) {
    fail("candidate version/channel/scope/changelog do not match the installed RC contract");
  }
  await sourceFile(sourceRoot, HOST_REGISTRY, 512 * 1024);
  const [installedRegistry, candidateRegistry] = await Promise.all([
    loadHostSupportRegistry(),
    loadHostSupportRegistry({ registryPath: path.join(sourceRoot, ...HOST_REGISTRY.split("/")) })
  ]);
  if (!sameDigest(candidateRegistry, installedRegistry)) fail("candidate host registry differs from the installed verifier image");
  const versionManifestHash = sha256(manifestBytes);
  const expectedInstalledSources = [
    "plugins/better-workflows/scripts/lib/rc-publication-qualification-v1.mjs",
    "plugins/better-workflows/scripts/lib/release-conformance-envelope-v1.mjs",
    "scripts/website-public-qa.mjs",
    "scripts/website-public-qa-observer-v1.mjs",
    "scripts/website-public-qa-documents.mjs"
  ];
  for (const relative of expectedInstalledSources) {
    const candidate = await sourceFile(sourceRoot, relative, 16 * 1024 * 1024);
    const installed = await sourceFile(INSTALL_ROOT, relative, 16 * 1024 * 1024);
    if (!candidate.equals(installed)) fail(`installed observer bytes differ from candidate source: ${relative}`);
  }
  return Object.freeze({ sourceRoot, scope: installedScope.scope, scopeDigest: installedScope.scopeDigest, registry: candidateRegistry,
    registryDigest: digestObject(candidateRegistry), releaseTarget: target, versionManifestHash,
    breakingChangesDigest: digestObject(manifest.breakingChanges) });
}

export async function verifyInstalledRcCandidateSourcePreflightV1(context) {
  await assertInstalledRcPublicationContextV1(context);
  await assertInstalledRcPublicationContextCurrentV1(context);
  const source = await assertCandidateSource(context);
  await assertInstalledRcPublicationContextCurrentV1(context);
  return Object.freeze({ publicCandidateSha: context.candidate.publicCandidateSha,
    scopeDigest: source.scopeDigest, registryDigest: source.registryDigest,
    versionManifestHash: source.versionManifestHash });
}

// Source consistency only: the installed observer fetches these rows from the
// bound provider. A caller's matching rows never authenticate qualification.
export function matchesRcCiCheckBindingV1(check, job, run, candidateSha, repository) {
  return Number.isSafeInteger(check?.id) && check.id > 0 && Number.isSafeInteger(job?.id) && job.id > 0 &&
    Number.isSafeInteger(run?.id) && run.id > 0 && Number.isSafeInteger(run.check_suite_id) && run.check_suite_id > 0 &&
    run.head_branch === "main" && run.head_sha === candidateSha &&
    check.name === "test" && check.head_sha === candidateSha && check.status === "completed" &&
    check.conclusion === "success" && check.app?.slug === "github-actions" &&
    check.check_suite?.id === run.check_suite_id &&
    job.check_run_url === `https://api.github.com/repos/${repository}/check-runs/${check.id}` &&
    typeof check.details_url === "string" && check.details_url.includes(`/actions/runs/${run.id}/job/${job.id}`);
}

async function observeCi(context, config, githubRead, source) {
  const runId = config.ci.runId;
  const runAttempt = config.ci.runAttempt;
  const repository = context.target.repository.name;
  const run = await githubRead(`repos/${repository}/actions/runs/${runId}`);
  assertSuccessfulRun(run, { context, runId, runAttempt, workflow: CI_WORKFLOW, events: ["push"], label: "CI" });
  const jobs = await listAll(githubRead, `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs`, "jobs", "CI attempt jobs");
  const testJobs = jobs.filter((job) => job.name === "test");
  if (testJobs.length !== 1) fail("CI exact success check job is missing or duplicated");
  const testJob = testJobs[0];
  if (String(testJob.run_id) !== runId || (testJob.run_attempt !== undefined && String(testJob.run_attempt) !== runAttempt) ||
      testJob.status !== "completed" || testJob.conclusion !== "success" || !Number.isSafeInteger(testJob.id)) {
    fail("CI test job is not successful for the configured attempt");
  }
  const checkRuns = await listAll(githubRead, `repos/${repository}/commits/${context.candidate.publicCandidateSha}/check-runs`, "check_runs", "CI check-runs");
  const matchingChecks = checkRuns.filter((check) => matchesRcCiCheckBindingV1(check, testJob, run,
    context.candidate.publicCandidateSha, repository));
  if (matchingChecks.length !== 1) fail("current GitHub Actions test check is absent, duplicated or not bound to the configured CI attempt");
  const workflowBytes = await sourceFile(source.sourceRoot, CI_WORKFLOW, 1024 * 1024);
  const runtime = await verifyRuntimeQualificationV2({
    sourceRevision: context.candidate.publicCandidateSha,
    sourceRoot: source.sourceRoot,
    runId,
    artifactDirectory: await evidenceDirectory(context.paths.evidenceRoot, config.runtime.artifactDirectory, "runtime artifact directory")
  });
  if (runtime.kind !== "RuntimeQualificationGateV2" || runtime.schemaVersion !== 2 || runtime.result !== "PASS" ||
      runtime.releaseAuthority !== "none" || runtime.fullEvaluatorIncluded !== false ||
      runtime.sourceRevision !== context.candidate.publicCandidateSha || runtime.sourceTreeSha !== context.candidate.publicTreeOid ||
      runtime.productReleaseScopeDigest !== source.scopeDigest || runtime.repository !== repository ||
      runtime.repositoryId !== context.target.repository.id || runtime.workflowFileSha256 !== sha256(workflowBytes) ||
      runtime.runId !== runId || runtime.runAttempt !== runAttempt || !Array.isArray(runtime.receipts) || runtime.receipts.length !== 2) {
    fail("Runtime V2 installed consumer did not return both exact same-attempt current lanes");
  }
  for (const lane of RUNTIME_LANES) {
    const receipts = runtime.receipts.filter((receipt) => receipt.laneId === lane.id);
    if (receipts.length !== 1 || receipts[0].nodeVersion !== lane.nodeVersion ||
        receipts[0].attestation !== "github-oidc-verified" || receipts[0].releaseAuthority !== "none" ||
        !SHA256.test(receipts[0].artifactSha256 ?? "") || !SHA256.test(receipts[0].envelopeDigest ?? "") ||
        !SHA256.test(receipts[0].verificationDigest ?? "") || !SHA256.test(receipts[0].certificateBindingDigest ?? "")) {
      fail(`Runtime V2 lane is missing exact attested evidence: ${lane.id}`);
    }
  }
  return Object.freeze({ workflow: CI_WORKFLOW, runId, runAttempt, runConclusion: run.conclusion,
    checkRunId: String(matchingChecks[0].id), checkJobId: String(testJob.id),
    runtimeReceiptDigest: runtime.receiptDigest, runtimeWorkflowSha256: runtime.workflowFileSha256,
    runtimeLanes: runtime.receipts.map((receipt) => ({ laneId: receipt.laneId, nodeVersion: receipt.nodeVersion,
      envelopeDigest: receipt.envelopeDigest, verificationDigest: receipt.verificationDigest,
      certificateBindingDigest: receipt.certificateBindingDigest })).sort((a, b) => a.laneId.localeCompare(b.laneId, "en")) });
}

async function observeHosts(context, config, githubRead, source) {
  const runId = config.host.runId;
  const runAttempt = config.host.runAttempt;
  const repository = context.target.repository.name;
  const artifactDirectory = await evidenceDirectory(context.paths.evidenceRoot, config.host.artifactDirectory, "host artifact directory");
  const run = await githubRead(`repos/${repository}/actions/runs/${runId}`);
  assertSuccessfulRun(run, { context, runId, runAttempt, workflow: HOST_WORKFLOW, events: [...RUN_EVENTS], label: "host conformance" });
  const jobs = await listAll(githubRead, `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs`, "jobs", "host attempt jobs");
  const artifacts = await listAll(githubRead, `repos/${repository}/actions/runs/${runId}/artifacts`, "artifacts", "host run artifacts");
  const expectedMatrix = await productReleaseConformanceMatrix();
  const expectedPairs = expectedMatrix.map((entry) => `${entry.hostId}/${entry.osId}`).sort();
  if (JSON.stringify(expectedPairs) !== JSON.stringify(HOSTS.map((host) => `${host}/macos`).sort())) fail("installed host matrix differs from the fixed three-host RC scope");
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  const expectedFiles = HOSTS.map((host) => `${host}-macos.json`).sort();
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
      JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(expectedFiles)) {
    fail("host evidence directory does not contain exactly the three expected envelope files");
  }
  const verified = [];
  for (const combination of expectedMatrix) {
    if (!HOSTS.includes(combination.hostId) || combination.osId !== "macos") fail("host matrix contains an out-of-scope platform");
    const name = `${combination.hostId}-${combination.osId}.json`;
    const file = path.join(artifactDirectory, name);
    const observed = await evidenceFile(context.paths.evidenceRoot, file, `host envelope ${name}`, 4 * 1024 * 1024);
    const envelope = JSON.parse(observed.bytes.toString("utf8"));
    const jobName = `${combination.hostId} / ${combination.osId}`;
    const selectedJobs = jobs.filter((job) => job.name === jobName);
    if (selectedJobs.length !== 1) fail(`host job is missing or duplicated: ${jobName}`);
    const job = selectedJobs[0];
    const requiredSteps = ["Install the pinned official host CLI", "Exercise the shared safety semantics", "Create source-bound conformance envelope"];
    if (String(job.run_id) !== runId || (job.run_attempt !== undefined && String(job.run_attempt) !== runAttempt) ||
        job.head_sha !== context.candidate.publicCandidateSha || job.status !== "completed" || job.conclusion !== "success" ||
        !Array.isArray(job.labels) || !job.labels.includes("macos-15") || !Array.isArray(job.steps) ||
        requiredSteps.some((stepName) => {
          const found = job.steps.filter((step) => step.name === stepName);
          return found.length !== 1 || found[0].status !== "completed" || found[0].conclusion !== "success";
        })) fail(`host job did not execute the exact source-bound qualification: ${jobName}`);
    const artifactName = `better-workflows-host-conformance-${combination.hostId}-${combination.osId}-${context.candidate.publicCandidateSha}`;
    const selectedArtifacts = artifacts.filter((artifact) => artifact.name === artifactName);
    if (selectedArtifacts.length !== 1) fail(`host artifact is missing, stale or duplicated: ${artifactName}`);
    const artifact = selectedArtifacts[0];
    if (artifact.expired !== false || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 ||
        artifact.size_in_bytes > 40 * 1024 * 1024 || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") ||
        String(artifact.workflow_run?.id) !== runId || String(artifact.workflow_run?.repository_id) !== context.target.repository.id ||
        String(artifact.workflow_run?.head_repository_id) !== context.target.repository.id || artifact.workflow_run?.head_branch !== "main" ||
        artifact.workflow_run?.head_sha !== context.candidate.publicCandidateSha) fail(`host artifact metadata is not bound to the exact current run: ${artifactName}`);
    const inspected = await inspectReleaseConformanceEnvelopeV1({
      file, envelope, combination, repositoryRoot: source.sourceRoot,
      sourceRevision: context.candidate.publicCandidateSha, repository, conformanceRunId: runId,
      runAttempt, registry: source.registry, registryDigest: source.registryDigest,
      scopeDigest: source.scopeDigest, matrix: expectedMatrix
    });
    const attestation = await rcPublicationVerifyGithubAttestationV1(context, {
      file, workflow: context.target.hostWorkflowPath, runId, runAttempt
    });
    if (attestation.authenticatedState !== "VERIFIED_CURRENT" || attestation.artifactSha256 !== observed.sha256 ||
        !SHA256.test(attestation.verificationDigest ?? "") || !SHA256.test(attestation.certificateBindingDigest ?? "")) {
      fail(`host envelope signature is not current for the exact attempt: ${jobName}`);
    }
    verified.push({ hostId: combination.hostId, osId: combination.osId, jobId: String(job.id),
      artifactId: String(artifact.id), artifactName, artifactDigest: artifact.digest, envelopeSha256: observed.sha256,
      envelopeDigest: inspected.envelopeDigest, coreReceiptDigest: inspected.coreReceiptDigest,
      verificationDigest: attestation.verificationDigest,
      certificateBindingDigest: attestation.certificateBindingDigest });
  }
  return Object.freeze({ workflow: HOST_WORKFLOW, runId, runAttempt, runConclusion: run.conclusion,
    receipts: verified.sort((a, b) => a.hostId.localeCompare(b.hostId, "en")) });
}

function assertQaReceipt(receipt, context, source, config) {
  const expectedLocales = source.scope.publicLocaleIds;
  const expectedRoutes = expectedLocales.flatMap((locale) => PUBLIC_DOC_PAGES.map(({ id }) => `${locale}/${id}`));
  if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== "WorkspaceWebsitePublicQaReceiptV1" ||
      receipt.sourceRevision !== context.candidate.publicCandidateSha || receipt.version !== context.releaseTarget.releaseVersion ||
      receipt.origin !== context.target.siteOrigin || receipt.result !== "PASS" ||
      receipt.authentication?.status !== "awaiting-github-oidc-attestation" || receipt.authentication?.releaseEligible !== false ||
      receipt.publicDocumentationPages !== PUBLIC_DOC_PAGES.length || !Array.isArray(receipt.locales) || receipt.locales.length !== expectedLocales.length ||
      !Array.isArray(receipt.publicDocumentationRoutes) || receipt.publicDocumentationRoutes.length !== expectedRoutes.length ||
      !receipt.producer || receipt.producer.kind !== "WebsitePublicQaWorkflowBindingV1" ||
      receipt.producer.repository !== context.target.repository.name || receipt.producer.repositoryId !== context.target.repository.id ||
      receipt.producer.runId !== config.site.runId || receipt.producer.runAttempt !== config.site.runAttempt ||
      receipt.producer.workflowRef !== `${context.target.repository.name}/${QA_WORKFLOW}@refs/heads/main` ||
      receipt.producer.workflowSha !== context.candidate.publicCandidateSha || receipt.producer.sourceRef !== "refs/heads/main" ||
      receipt.producer.event !== "workflow_dispatch" || receipt.producer.runnerEnvironment !== "github-hosted") {
    fail("website QA receipt lacks complete same-source public site coverage or exact producer binding");
  }
  const locales = receipt.locales.map((item) => item.locale);
  if (new Set(locales).size !== expectedLocales.length ||
      locales.some((locale) => !expectedLocales.includes(locale)) ||
      receipt.locales.some((item) => item.result !== "PASS" || !SHA256.test(item.responseDigest ?? ""))) {
    fail("website QA locale coverage is incomplete or duplicated");
  }
  const routes = receipt.publicDocumentationRoutes.map((item) => `${item.locale}/${item.page}`);
  if (new Set(routes).size !== expectedRoutes.length ||
      routes.some((route) => !expectedRoutes.includes(route)) ||
      receipt.publicDocumentationRoutes.some((item) => item.result !== "PASS" || !SHA256.test(item.responseDigest ?? ""))) {
    fail("website QA public documentation coverage is incomplete or duplicated");
  }
  const { receiptDigest, ...payload } = receipt;
  if (!SHA256.test(receiptDigest ?? "") || digestObject(payload) !== receiptDigest) fail("website QA receipt digest is invalid");
  return receipt;
}

async function observeSite(context, config, githubRead, source) {
  const runId = config.site.runId;
  const runAttempt = config.site.runAttempt;
  const repository = context.target.repository.name;
  const receiptFile = absolutePath(config.site.receiptFile, "site receipt file");
  const observed = await evidenceFile(context.paths.evidenceRoot, receiptFile, "site QA receipt", 4 * 1024 * 1024);
  const receipt = JSON.parse(observed.bytes.toString("utf8"));
  assertQaReceipt(receipt, context, source, config);
  const run = await githubRead(`repos/${repository}/actions/runs/${runId}`);
  assertSuccessfulRun(run, { context, runId, runAttempt, workflow: context.target.qaWorkflowPath,
    events: ["workflow_dispatch"], label: "website public QA" });
  const jobs = await listAll(githubRead, `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs`, "jobs", "website QA attempt jobs");
  const selectedJobs = jobs.filter((job) => job.name === "website-public-qa");
  if (selectedJobs.length !== 1) fail("website QA job is missing or duplicated");
  const job = selectedJobs[0];
  const requiredSteps = ["Require exact public main source before executing QA", "Run live source-bound public QA", "Upload exact website QA receipt", "Attest exact website QA receipt"];
  if (String(job.run_id) !== runId || (job.run_attempt !== undefined && String(job.run_attempt) !== runAttempt) ||
      job.head_sha !== context.candidate.publicCandidateSha || job.status !== "completed" || job.conclusion !== "success" ||
      !Array.isArray(job.steps) || requiredSteps.some((stepName) => {
        const found = job.steps.filter((step) => step.name === stepName);
        return found.length !== 1 || found[0].status !== "completed" || found[0].conclusion !== "success";
      })) fail("website QA workflow did not execute all exact-source producer steps");
  const artifacts = await listAll(githubRead, `repos/${repository}/actions/runs/${runId}/artifacts`, "artifacts", "website QA artifacts");
  const expectedName = `better-workflows-website-public-qa-${context.candidate.publicCandidateSha}-${runId}-${runAttempt}`;
  const matching = artifacts.filter((artifact) => String(artifact.id) === String(config.site.artifactId));
  if (matching.length !== 1) fail("configured site artifact ID is missing or duplicated in current provider readback");
  const artifact = matching[0];
  if (artifact.name !== expectedName || artifact.expired !== false || !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes < 1 || artifact.size_in_bytes > 64 * 1024 * 1024 || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") ||
      String(artifact.workflow_run?.id) !== runId || String(artifact.workflow_run?.repository_id) !== context.target.repository.id ||
      String(artifact.workflow_run?.head_repository_id) !== context.target.repository.id || artifact.workflow_run?.head_branch !== "main" ||
      artifact.workflow_run?.head_sha !== context.candidate.publicCandidateSha) fail("website QA artifact metadata is not bound to the exact run, attempt and source");
  const attestation = await rcPublicationVerifyGithubAttestationV1(context, {
    file: receiptFile, workflow: context.target.qaWorkflowPath, runId, runAttempt
  });
  if (attestation.authenticatedState !== "VERIFIED_CURRENT" || attestation.artifactSha256 !== observed.sha256 ||
      !SHA256.test(attestation.verificationDigest ?? "") || !SHA256.test(attestation.certificateBindingDigest ?? "")) {
    fail("website QA receipt has no current exact-source GitHub OIDC provenance");
  }
  const freshSite = await observeWebsitePublicQaV1({ repositoryRoot: source.sourceRoot, sourceRevision: context.candidate.publicCandidateSha });
  const { receiptDigest: _freshDigest, ...freshPayload } = freshSite;
  const { receiptDigest: _receiptDigest, producer: _producer, ...sourceBoundPayload } = receipt;
  if (!sameDigest(freshPayload, sourceBoundPayload)) fail("fresh live website observation differs from the attested QA producer receipt");
  return Object.freeze({ workflow: context.target.qaWorkflowPath, runId, runAttempt,
    jobId: String(job.id), artifactId: String(artifact.id), artifactName: artifact.name, artifactDigest: artifact.digest,
    receiptSha256: observed.sha256, receiptDigest: receipt.receiptDigest,
    verificationDigest: attestation.verificationDigest, certificateBindingDigest: attestation.certificateBindingDigest,
    localeCount: receipt.locales.length, publicDocumentationRouteCount: receipt.publicDocumentationRoutes.length,
    liveObservationDigest: freshSite.receiptDigest });
}

async function observeChangelog(context, config, source) {
  const bytes = await sourceFile(source.sourceRoot, config.changelog.file, 512 * 1024);
  const digest = sha256(bytes);
  if (digest !== config.changelog.sha256 || digest !== source.versionManifestHash) fail("changelog/version-manifest bytes drifted from the fixed source binding");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.version !== context.releaseTarget.releaseVersion || manifest.releaseTag !== context.releaseTarget.releaseTag ||
      !Array.isArray(manifest.breakingChanges) || manifest.breakingChanges.length < 1) fail("RC version manifest lacks its exact release target or changelog");
  return Object.freeze({ file: config.changelog.file, sha256: digest, releaseVersion: manifest.version,
    releaseTag: manifest.releaseTag, breakingChangesDigest: digestObject(manifest.breakingChanges) });
}

export function matchesRcFormalTargetBindingV1(publicTarget, context) {
  if (!publicTarget || typeof publicTarget !== "object" || Array.isArray(publicTarget) ||
      !context?.target?.repository || !context?.target?.sourceRef || !context?.candidate?.publicCandidateSha) return false;
  return sameDigest(publicTarget, {
    repository: { name: context.target.repository.name, id: context.target.repository.id },
    sourceRevision: context.candidate.publicCandidateSha,
    sourceRef: context.target.sourceRef
  });
}

async function observeFormal(context) {
  const formal = await inspectInstalledFormalProtectedBundleV2({
    expectedHead: context.candidate.publicCandidateSha,
    expectedBase: context.candidate.expectedBase
  });
  if (formal.schemaVersion !== 2 || formal.kind !== "FormalProtectedInspectionV2" ||
      formal.expectedHead !== context.candidate.publicCandidateSha || formal.expectedBase !== context.candidate.expectedBase ||
      !matchesRcFormalTargetBindingV1(formal.publicTarget, context) ||
      formal.authenticated !== true || formal.rawBytesBound !== true || formal.portableReplayComplete !== true ||
      formal.cleanupConfirmed !== true || formal.qualificationStatus !== "passed" || formal.operationCompletion !== "OBSERVED" ||
      formal.admission !== "HOLD" || formal.releaseEligible !== false) {
    fail("installed Formal V2 consumer did not observe the exact successful protected evaluation");
  }
  return Object.freeze({ expectedHead: formal.expectedHead, expectedBase: formal.expectedBase,
    publicTarget: formal.publicTarget,
    qualificationStatus: formal.qualificationStatus, operationCompletion: formal.operationCompletion,
    authenticated: formal.authenticated, rawBytesBound: formal.rawBytesBound,
    portableReplayComplete: formal.portableReplayComplete, cleanupConfirmed: formal.cleanupConfirmed,
    protectedLedgerSha256: formal.protectedLedgerSha256, reservationSha256: formal.reservationSha256,
    policySha256: formal.policySha256, bundleSha256: formal.bundleSha256,
    admission: formal.admission, releaseEligible: formal.releaseEligible });
}

async function observeQualification(context, phase) {
  await assertInstalledRcPublicationContextV1(context);
  await assertInstalledRcPublicationContextCurrentV1(context);
  if (context.authenticatedState !== "INSTALLED_CURRENT" || context.target?.repository?.name !== context.binding?.repository?.name ||
      context.target.repository.id !== context.binding.repository.id || context.candidate?.publicCandidateSha !== context.binding.publicCandidateSha ||
      context.candidate.publicTreeOid !== context.binding.publicTreeOid || context.target.sourceRef !== "refs/heads/main" ||
      context.target.hostWorkflowPath !== HOST_WORKFLOW || context.target.runtimeWorkflowPath !== CI_WORKFLOW ||
      context.target.qaWorkflowPath !== QA_WORKFLOW || context.target.qaWorkflowRef !== "refs/heads/main" ||
      context.target.qaWorkflowSha !== context.candidate.publicCandidateSha || context.target.siteOrigin !== "https://betterworkflows.dev" ||
      context.releaseTarget?.channel !== "rc" || context.releaseTarget.releaseTargetDigest !== context.binding.releaseTargetDigest ||
      context.target.tagRef !== `refs/tags/${context.releaseTarget.releaseTag}`) {
    fail("installed context does not bind the exact public RC candidate, target and three workflows");
  }
  const projectionBefore = await revalidateInstalledRcProjectionV1(context);
  if (projectionBefore.publicCandidateSha !== context.candidate.publicCandidateSha ||
      projectionBefore.publicTreeOid !== context.candidate.publicTreeOid ||
      projectionBefore.productReleaseScopeDigest !== context.binding.productReleaseScopeDigest ||
      projectionBefore.exportManifestDigest !== context.binding.exportManifestDigest) {
    fail("current public projection differs from its installed source binding");
  }
  const configRecord = await readInstalledRcAdapterConfigRecordV1(context, "qualification");
  if (!configRecord || !Buffer.isBuffer(configRecord.bytes) || !SHA256.test(configRecord.sha256 ?? "") ||
      configRecord.sha256 !== sha256(configRecord.bytes) || !configRecord.identity) fail("qualification config did not come from the fixed installed root reader");
  const config = configRecord.value;
  const evidenceRoot = validateConfig(config, context);
  await assertRootOwnedRuntimePathV2(evidenceRoot, { directory: true });
  await evidenceDirectory(evidenceRoot, config.runtime.artifactDirectory, "runtime artifact directory");
  await evidenceDirectory(evidenceRoot, config.host.artifactDirectory, "host artifact directory");
  const githubRead = (endpoint) => rcPublicationGithubReadV1(context, endpoint);
  const source = await assertCandidateSource(context);
  const repositoryBefore = await assertPublicSourceCurrent(context, githubRead);
  const [formal, ci, hosts, site, changelog] = await Promise.all([
    observeFormal(context), observeCi(context, config, githubRead, source),
    observeHosts(context, config, githubRead, source), observeSite(context, config, githubRead, source),
    observeChangelog(context, config, source)
  ]);
  if (hosts.runId !== config.host.runId || hosts.runAttempt !== config.host.runAttempt ||
      site.runId !== config.site.runId || site.runAttempt !== config.site.runAttempt ||
      ci.runId !== config.ci.runId || ci.runAttempt !== config.ci.runAttempt) fail("qualification stage observations changed their configured run bindings");
  const repositoryAfter = await assertPublicSourceCurrent(context, githubRead);
  if (!sameDigest(repositoryBefore, repositoryAfter)) fail("public source/main/tree changed during qualification observation");
  const projectionAfter = await revalidateInstalledRcProjectionV1(context);
  if (projectionAfter.publicCandidateSha !== projectionBefore.publicCandidateSha ||
      projectionAfter.publicTreeOid !== projectionBefore.publicTreeOid ||
      projectionAfter.exportManifestDigest !== projectionBefore.exportManifestDigest ||
      projectionAfter.productReleaseScopeDigest !== projectionBefore.productReleaseScopeDigest) {
    fail("installed public projection changed during qualification observation");
  }
  const freshConfigRecord = await readInstalledRcAdapterConfigRecordV1(context, "qualification");
  if (freshConfigRecord.sha256 !== configRecord.sha256 || !sameDigest(freshConfigRecord.identity, configRecord.identity)) {
    fail("root-owned qualification config changed during provider observation");
  }
  await assertInstalledRcPublicationContextCurrentV1(context);
  const evidence = freeze({
    operationId: context.operationId, bindingDigest: context.bindingDigest,
    publicCandidateSha: context.candidate.publicCandidateSha, publicTreeOid: context.candidate.publicTreeOid,
    productReleaseScopeDigest: source.scopeDigest, releaseTargetDigest: source.releaseTarget.releaseTargetDigest,
    phase, repository: repositoryAfter, changelog, formal, ci, hosts, site
  });
  const evidenceDigest = digestObject(evidence);
  const result = freeze({ schemaVersion: 1, kind: "InstalledRcQualificationResultV1",
    authenticatedState: "VERIFIED_CURRENT", operationId: context.operationId,
    bindingDigest: context.bindingDigest, publicCandidateSha: context.candidate.publicCandidateSha,
    publicTreeOid: context.candidate.publicTreeOid, phase, evidenceDigest, evidence });
  resultBrands.set(result, Object.freeze({ context, phase, evidenceDigest, bindingDigest: context.bindingDigest }));
  return result;
}

export async function verifyInstalledRcQualificationV1(context) {
  return observeQualification(context, "qualification");
}

export async function verifyInstalledRcFreshProviderEvidenceV1(context) {
  return observeQualification(context, "fresh");
}

export async function assertInstalledRcQualificationResultV1(result, context, phase = "qualification") {
  if (!new Set(["qualification", "fresh"]).has(phase)) fail("result assertion phase is invalid");
  const brand = result && typeof result === "object" ? resultBrands.get(result) : null;
  if (!brand || brand.context !== context || brand.phase !== phase || result.kind !== "InstalledRcQualificationResultV1" ||
      result.authenticatedState !== "VERIFIED_CURRENT" || result.operationId !== context?.operationId ||
      result.bindingDigest !== context?.bindingDigest || result.publicCandidateSha !== context?.candidate?.publicCandidateSha ||
      result.publicTreeOid !== context?.candidate?.publicTreeOid || result.phase !== phase ||
      result.evidenceDigest !== brand.evidenceDigest || result.evidence?.phase !== phase ||
      digestObject(result.evidence) !== result.evidenceDigest) {
    fail("qualification result is caller-created, cloned, stale or bound to another context/phase");
  }
  await assertInstalledRcPublicationContextV1(context);
  await assertInstalledRcPublicationContextCurrentV1(context);
  if (brand.bindingDigest !== context.bindingDigest) fail("qualification result binding changed");
  return result;
}
