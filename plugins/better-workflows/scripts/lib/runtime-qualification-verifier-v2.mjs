// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestObject, sha256 } from "./core.mjs";
import { runtimeGithubReadV2, verifyRuntimeAttestationV2 } from "./github-runtime-attestation-v2.mjs";
import {
  RUNTIME_QUALIFICATION_LANES, assertRootOwnedRuntimePathV2, readBoundedRuntimeFileV2,
  readInstalledRuntimeQualificationTargetV2, assertRuntimeQualificationTargetCurrentV2,
  runtimeQualificationPolicyV2, runtimeQualificationCommands, runtimeQualificationArtifactNameV2,
  inspectRuntimeQualificationEnvelopeV2, runtimeQualificationTapSummaryV2, observeRuntimeSourceTreeV2
} from "./runtime-qualification-v2.mjs";

const verifierRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const boundedFile = readBoundedRuntimeFileV2;
function inspectRun(run, targetPolicy, runId, runAttempt = null) {
  if (String(run.id) !== runId || run.path !== targetPolicy.workflow.path || run.head_branch !== "main" ||
      run.head_sha !== targetPolicy.sourceRevision || String(run.repository?.id) !== targetPolicy.repository.id ||
      run.repository?.full_name !== targetPolicy.repository.name || run.status !== "completed" || run.conclusion !== "success" ||
      run.event !== targetPolicy.workflow.event || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
      (runAttempt !== null && String(run.run_attempt) !== runAttempt)) throw new Error("Runtime V2 requires the exact completed successful public main workflow attempt");
  return String(run.run_attempt);
}

async function boundedLiveList(githubRead, endpoint, key) {
  const entries = [];
  let expectedCount = null;
  for (let page = 1; page <= 10; page += 1) {
    const response = await githubRead(`${endpoint}?per_page=100&page=${page}`);
    if (!Number.isSafeInteger(response.total_count) || response.total_count < 0 || response.total_count > 1000 ||
        !Array.isArray(response[key]) || response[key].length > 100 ||
        (expectedCount !== null && response.total_count !== expectedCount)) throw new Error("Runtime V2 live list is incomplete, drifting or exceeds bounds");
    expectedCount = response.total_count;
    entries.push(...response[key]);
    if (entries.length === expectedCount) break;
    if (entries.length > expectedCount || response[key].length !== 100 || page === 10) throw new Error("Runtime V2 live pagination does not cover its declared records");
  }
  if (entries.some((entry) => !Number.isSafeInteger(entry.id) || entry.id < 1) || new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Runtime V2 live IDs are invalid or duplicated");
  return entries;
}

async function observeLiveRuntimeEvidence(githubRead, targetPolicy, runId, runAttempt) {
  const endpoint = `repos/${targetPolicy.repository.name}/actions/runs/${runId}`;
  const jobs = await boundedLiveList(githubRead, `${endpoint}/attempts/${runAttempt}/jobs`, "jobs");
  const artifacts = await boundedLiveList(githubRead, `${endpoint}/artifacts`, "artifacts");
  const expectedSteps = ["Execute and capture runtime-v2 qualification", "Upload bounded runtime-v2 evidence", "Attest the exact successful runtime-v2 envelope"];
  return RUNTIME_QUALIFICATION_LANES.map((lane) => {
    const selectedJobs = jobs.filter((entry) => entry.name === `Runtime qualification v2 / ${lane.id}`);
    const artifactName = runtimeQualificationArtifactNameV2(lane.id, targetPolicy.sourceRevision, runId, runAttempt);
    const selectedArtifacts = artifacts.filter((entry) => entry.name === artifactName);
    if (selectedJobs.length !== 1 || selectedArtifacts.length !== 1) throw new Error("Runtime V2 live lane job/artifact is missing or duplicated");
    const job = selectedJobs[0];
    const artifact = selectedArtifacts[0];
    if (String(job.run_id) !== runId || job.head_sha !== targetPolicy.sourceRevision ||
        (job.run_attempt !== undefined && String(job.run_attempt) !== runAttempt) ||
        job.status !== "completed" || job.conclusion !== "success" || !Number.isSafeInteger(job.runner_id) || job.runner_id < 1 ||
        typeof job.runner_name !== "string" || !job.runner_name || !Array.isArray(job.labels) || !job.labels.includes(lane.runner) ||
        !Array.isArray(job.steps) || expectedSteps.some((name) => {
          const steps = job.steps.filter((step) => step.name === name);
          return steps.length !== 1 || steps[0].status !== "completed" || steps[0].conclusion !== "success";
        })) throw new Error("Runtime V2 live job did not execute and attest its exact lane successfully");
    if (artifact.expired !== false || !Number.isFinite(Date.parse(artifact.expires_at)) || Date.parse(artifact.expires_at) <= Date.now() ||
        !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > 40 * 1024 * 1024 ||
        !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") || String(artifact.workflow_run?.id) !== runId ||
        String(artifact.workflow_run?.repository_id) !== targetPolicy.repository.id ||
        String(artifact.workflow_run?.head_repository_id) !== targetPolicy.repository.id ||
        artifact.workflow_run?.head_branch !== "main" || artifact.workflow_run?.head_sha !== targetPolicy.sourceRevision) throw new Error("Runtime V2 live artifact is expired, replaced or bound to another source/run");
    // The ZIP digest is transport metadata; content authenticity comes from the
    // signed envelope and its raw log hashes, not an asserted ZIP comparison.
    return { laneId: lane.id, job: { id: job.id, name: job.name, runnerId: job.runner_id, runnerName: job.runner_name,
      labels: job.labels, startedAt: job.started_at, completedAt: job.completed_at, stepsDigest: digestObject(job.steps) },
      artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest, size: artifact.size_in_bytes,
        expired: artifact.expired, createdAt: artifact.created_at, updatedAt: artifact.updated_at, expiresAt: artifact.expires_at,
        workflowRun: artifact.workflow_run } };
  });
}

// Execute from an independently installed root-owned verifier, never the candidate.
// The fixed external policy and actual gh observations cannot be supplied by callers.
// This scope proves runtime qualification only; formal coverage/publication stay closed.
export async function verifyRuntimeQualificationV2({ sourceRevision, sourceRoot, runId, artifactDirectory }) {
  if (typeof sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(sourceRevision) ||
      typeof runId !== "string" || !/^[1-9][0-9]*$/.test(runId) || typeof sourceRoot !== "string" ||
      !path.isAbsolute(sourceRoot) || path.resolve(sourceRoot) !== sourceRoot || typeof artifactDirectory !== "string" ||
      !path.isAbsolute(artifactDirectory) || path.resolve(artifactDirectory) !== artifactDirectory) throw new Error("Runtime V2 source/run/artifact locator is invalid");
  const snapshot = await readInstalledRuntimeQualificationTargetV2();
  const { targetPolicy, targetPolicySha256 } = snapshot;
  if (sourceRevision !== targetPolicy.sourceRevision) throw new Error("Runtime V2 candidate was not approved by the installed policy");
  await assertRootOwnedRuntimePathV2(verifierRoot, { directory: true });
  if (sourceRoot === verifierRoot || sourceRoot.startsWith(`${verifierRoot}${path.sep}`) ||
      artifactDirectory === verifierRoot || artifactDirectory.startsWith(`${verifierRoot}${path.sep}`)) throw new Error("Runtime V2 candidate/artifacts must be separate from its trusted installation");
  for (const directory of [sourceRoot, artifactDirectory]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("Runtime V2 source/artifact root is not a canonical physical directory");
  }
  const githubRead = async (endpoint) => JSON.parse(await runtimeGithubReadV2(["api", endpoint], { targetPolicy }));
  const repositoryEndpoint = `repos/${targetPolicy.repository.name}`;
  const assertRepository = async () => {
    const repo = await githubRead(repositoryEndpoint);
    const branch = await githubRead(`${repositoryEndpoint}/git/ref/heads/main`);
    if (String(repo.id) !== targetPolicy.repository.id || repo.full_name !== targetPolicy.repository.name ||
        repo.private !== false || repo.archived !== false || repo.disabled !== false ||
        branch.ref !== targetPolicy.sourceRef || branch.object?.type !== "commit" || branch.object.sha !== sourceRevision) throw new Error("Runtime V2 target repository or main revision changed");
  };
  await assertRepository();
  const observeApprovedSource = async () => {
    const commit = await githubRead(`${repositoryEndpoint}/git/commits/${sourceRevision}`);
    if (commit.sha !== sourceRevision || !/^[a-f0-9]{40}$/.test(commit.tree?.sha ?? "")) throw new Error("Runtime V2 remote commit/tree binding is invalid");
    const tree = await githubRead(`${repositoryEndpoint}/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.sha !== commit.tree.sha || tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error("Runtime V2 remote source tree is incomplete or unbound");
    return { treeSha: tree.sha, observation: await observeRuntimeSourceTreeV2({ sourceRoot, treeRecords: tree.tree }) };
  };
  const sourceBefore = await observeApprovedSource();
  const runEndpoint = `${repositoryEndpoint}/actions/runs/${runId}`;
  const runAttempt = inspectRun(await githubRead(runEndpoint), targetPolicy, runId);
  const liveEvidence = await observeLiveRuntimeEvidence(githubRead, targetPolicy, runId, runAttempt);
  const { policy, policyDigest, scopeDigest } = await runtimeQualificationPolicyV2({ sourceRoot, targetPolicy });
  const directories = await readdir(artifactDirectory, { withFileTypes: true });
  const names = RUNTIME_QUALIFICATION_LANES.map((lane) => runtimeQualificationArtifactNameV2(lane.id, sourceRevision, runId, runAttempt)).sort();
  if (directories.some((entry) => !entry.isDirectory() || entry.isSymbolicLink()) ||
      JSON.stringify(directories.map((entry) => entry.name).sort()) !== JSON.stringify(names)) throw new Error("Runtime V2 requires exactly the two artifacts from this run attempt");
  const receipts = [];
  const observedFiles = [];
  for (const lane of RUNTIME_QUALIFICATION_LANES) {
    const directory = path.join(artifactDirectory, runtimeQualificationArtifactNameV2(lane.id, sourceRevision, runId, runAttempt));
    const expectedCommands = runtimeQualificationCommands(lane.id);
    const expectedFiles = ["qualification.json", "resources.jsonl", ...expectedCommands.flatMap((command) => [`${command.id}.stdout.tap`, `${command.id}.stderr.log`])].sort();
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) || JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(expectedFiles)) throw new Error("Runtime V2 artifact file coverage differs from its fixed evidence set");
    const file = path.join(directory, "qualification.json");
    const envelopeBytes = await boundedFile(file, 1024 * 1024);
    const envelope = JSON.parse(envelopeBytes);
    const { envelopeDigest } = inspectRuntimeQualificationEnvelopeV2(envelope,
      { sourceRevision, scopeDigest, policy, policyDigest, lane, runId, runAttempt, targetPolicy, targetPolicySha256, sourceInventoryDigest: sourceBefore.observation.sourceInventoryDigest });
    observedFiles.push({ file, maxBytes: 1024 * 1024, sha256: sha256(envelopeBytes) });
    for (const [index, expected] of expectedCommands.entries()) {
      const command = envelope.commands[index];
      let capturedBytes = 0;
      for (const [suffix, digestKey] of [["stdout.tap", "stdoutSha256"], ["stderr.log", "stderrSha256"]]) {
        const logPath = path.join(directory, `${expected.id}.${suffix}`);
        const bytes = await boundedFile(logPath, 16 * 1024 * 1024);
        capturedBytes += bytes.length;
        if (capturedBytes > 16 * 1024 * 1024) throw new Error("Runtime V2 combined command output exceeds bounds");
        if (sha256(bytes) !== command[digestKey]) throw new Error("Runtime V2 raw log digest mismatch");
        if (suffix === "stdout.tap" && digestObject(runtimeQualificationTapSummaryV2(bytes)) !== digestObject(command.tap)) throw new Error("Runtime V2 TAP summary mismatch");
        observedFiles.push({ file: logPath, maxBytes: 16 * 1024 * 1024, sha256: sha256(bytes) });
      }
    }
    const resourcesPath = path.join(directory, "resources.jsonl");
    const resourcesBytes = await boundedFile(resourcesPath, 64 * 1024);
    if (sha256(resourcesBytes) !== envelope.resourcesSha256) throw new Error("Runtime V2 resource evidence digest mismatch");
    observedFiles.push({ file: resourcesPath, maxBytes: 64 * 1024, sha256: sha256(resourcesBytes) });
    const verification = await verifyRuntimeAttestationV2(file, { sourceRevision, runId, runAttempt, targetPolicy });
    if (verification.artifactSha256 !== sha256(envelopeBytes)) throw new Error("Runtime V2 verified envelope bytes differ from the inspected envelope");
    receipts.push({ laneId: lane.id, envelopeDigest, nodeVersion: lane.nodeVersion,
      ...liveEvidence.find((entry) => entry.laneId === lane.id), ...verification });
  }
  // Re-execute live observations to reject reruns, transfer, revocation and file drift.
  inspectRun(await githubRead(runEndpoint), targetPolicy, runId, runAttempt);
  if (digestObject(await observeLiveRuntimeEvidence(githubRead, targetPolicy, runId, runAttempt)) !== digestObject(liveEvidence)) throw new Error("Runtime V2 live job or artifact changed during verification");
  await assertRepository();
  const sourceAfter = await observeApprovedSource();
  if (sourceAfter.treeSha !== sourceBefore.treeSha || sourceAfter.observation.expectedFilesDigest !== sourceBefore.observation.expectedFilesDigest ||
      sourceAfter.observation.sourceInventoryDigest !== sourceBefore.observation.sourceInventoryDigest || sourceAfter.observation.sourceSnapshotDigest !== sourceBefore.observation.sourceSnapshotDigest) throw new Error("Runtime V2 candidate bytes or namespace changed during verification");
  const fresh = await runtimeQualificationPolicyV2({ sourceRoot, targetPolicy });
  if (fresh.policyDigest !== policyDigest || fresh.scopeDigest !== scopeDigest) throw new Error("Runtime V2 source coverage changed during verification");
  for (const observation of observedFiles) if (sha256(await boundedFile(observation.file, observation.maxBytes)) !== observation.sha256) throw new Error("Runtime V2 artifact or raw log changed during verification");
  await assertRuntimeQualificationTargetCurrentV2(snapshot);
  const payload = { schemaVersion: 2, kind: "RuntimeQualificationGateV2", sourceRevision, productReleaseScopeDigest: scopeDigest,
    targetPolicySha256, policyDigest, sourceTreeSha: sourceBefore.treeSha, sourceInventoryDigest: sourceBefore.observation.sourceInventoryDigest, repository: targetPolicy.repository.name, repositoryId: targetPolicy.repository.id,
    workflowFileSha256: targetPolicy.workflow.sha256, runId, runAttempt, coverage: policy.coverage, fullEvaluatorIncluded: false,
    result: "PASS", releaseAuthority: "none", receipts };
  return Object.freeze({ ...payload, receiptDigest: digestObject(payload) });
}
