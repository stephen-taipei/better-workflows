import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertPolicyReceiptArtifact, assertSourcePolicyArtifactDigest, assertWorkflowRunTerminal, fetchPolicyReceiptArtifact, githubGraphqlUrl, pullRequestWorkflowObservation, releasePolicyPublisherAvailable, repositoryPullRequests, runReleaseTag as runReleaseTagImpl } from "../release-tag.mjs";
import {
  compareStableVersions,
  findMergedPullRequest,
  normalizeStableVersion,
  parseRemoteTagCommit,
  releaseTagName,
  releaseTagAtomicMutation,
  releaseTagParentRevision,
  remoteTagMatches,
  versionChanged,
  versionSurfaces
} from "../lib/release-tag.mjs";

const SHA = "a".repeat(40);
const execFileAsync = promisify(execFile);
let latestPolicyReceiptMetadata = {
  pullNumber: 11,
  headSha: SHA,
  mergeSha: SHA,
  base: "dev",
  policy: [{ context: "test", appId: null, strict: true }],
  mergedAt: "2026-08-15T00:00:00Z"
};
let policyArtifactUnavailableResponses = 0;
let policyWorkflowInProgressResponses = 0;

function zipStoredJson(filename, value) {
  const name = Buffer.from(filename);
  const data = Buffer.from(JSON.stringify(value));
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, end]);
}

function policyArtifactResponse(url) {
  const runMatch = /\/actions\/runs\/(\d+)\/artifacts/.exec(url) || /\/actions\/runs\/(\d+)\/receipt\.zip/.exec(url);
  if (!runMatch) return null;
  const runId = runMatch[1];
  if (url.includes("/artifacts") && policyArtifactUnavailableResponses > 0) {
    policyArtifactUnavailableResponses -= 1;
    return jsonResponse({ artifacts: [] });
  }
  const sourceRunId = "7";
  const sourceArtifact = {
    schemaVersion: 1,
    kind: "better-workflows/release-policy-receipt-v2",
    repository: "example/repo",
    workflowFile: ".github/workflows/ci.yml",
    workflowRunId: sourceRunId,
    eventName: "pull_request_target",
    eventAction: "synchronize",
    branch: latestPolicyReceiptMetadata.base,
    pullNumber: latestPolicyReceiptMetadata.pullNumber,
    headSha: latestPolicyReceiptMetadata.headSha,
    policy: latestPolicyReceiptMetadata.policy,
    policyDigest: createHash("sha256").update(JSON.stringify(latestPolicyReceiptMetadata.policy)).digest("hex"),
    observedAt: "2026-08-14T23:50:00.000Z"
  };
  const sourceArchive = zipStoredJson("release-policy-receipt.json", sourceArtifact);
  const sourceArchiveDigest = createHash("sha256").update(sourceArchive).digest("hex");
  const artifact = runId === sourceRunId ? sourceArtifact : {
    ...sourceArtifact,
    workflowRunId: runId,
    eventAction: "closed",
    mergeCommitSha: latestPolicyReceiptMetadata.mergeSha,
    mergedAt: latestPolicyReceiptMetadata.mergedAt,
    sourceWorkflowRunId: sourceRunId,
    sourcePolicyDigest: sourceArtifact.policyDigest,
    sourcePolicyArtifactDigest: sourceArchiveDigest,
    observedAt: new Date(Date.parse(latestPolicyReceiptMetadata.mergedAt) + 5 * 60 * 1000).toISOString()
  };
  const archive = zipStoredJson("release-policy-receipt.json", artifact);
  if (url.includes("/artifacts")) {
    return jsonResponse({ artifacts: [{
      id: 88,
      name: `better-workflows-release-policy-receipt-${runId}`,
      expired: false,
      digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      workflow_run: { id: Number(runId) },
      archive_download_url: `https://artifact.invalid/actions/runs/${runId}/receipt.zip`
    }] });
  }
  return {
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    async arrayBuffer() { return archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength); }
  };
}

function defaultBranchReleasePolicyResponse(url) {
  const activationText = "name: CI\non:\n  pull_request_target:\njobs:\n  release-policy-receipt:\n";
  const reconciliationText = "name: Release policy reconciliation\non:\n  workflow_run:\njobs:\n  release-policy-receipt:\n";
  if (url.endsWith("/repos/example/repo")) return jsonResponse({ default_branch: "main" });
  if (url.includes("/rulesets?includes_parents=true")) return jsonResponse([]);
  if (url.endsWith("/repos/example/repo/actions/workflows/ci.yml")) {
    return jsonResponse({ path: ".github/workflows/ci.yml", state: "active" });
  }
  if (url.endsWith("/repos/example/repo/actions/workflows/release-policy-reconcile.yml")) {
    return jsonResponse({ path: ".github/workflows/release-policy-reconcile.yml", state: "active" });
  }
  if (url.endsWith("/repos/example/repo/contents/.github/workflows/ci.yml?ref=main")) {
    return jsonResponse({
      type: "file",
      path: ".github/workflows/ci.yml",
      encoding: "base64",
      content: Buffer.from(activationText).toString("base64")
    });
  }
  if (url.endsWith("/repos/example/repo/contents/.github/workflows/release-policy-reconcile.yml?ref=main")) {
    return jsonResponse({
      type: "file",
      path: ".github/workflows/release-policy-reconcile.yml",
      encoding: "base64",
      content: Buffer.from(reconciliationText).toString("base64")
    });
  }
  return null;
}

function wrapFetchImpl(fetchImpl = fetch) {
  return async (url, options = {}) => defaultBranchReleasePolicyResponse(url) ?? policyArtifactResponse(url) ?? fetchImpl(url, options);
}

const runReleaseTag = (options = {}) => runReleaseTagImpl({
  sleepImpl: async () => {},
  allowSyntheticMissingPolicyWorkflow: true,
  ...options,
  env: { RELEASE_POLICY_ADMIN_TOKEN: "policy-token", ...(options.env ?? {}) },
  fetchImpl: wrapFetchImpl(options.fetchImpl)
});

async function git(cwd, args) {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

function jsonResponse(value, ok = true, status = 200, headers = {}) {
  return {
    ok,
    status,
    headers: { get(name) { return headers[String(name).toLowerCase()] ?? null; } },
    async json() { return value; }
  };
}

function successfulRequiredCheckResponse(url, sha, context = "test", pullNumber = 7) {
  if (url.endsWith("/branches/dev/protection/required_status_checks")) {
    return jsonResponse({ strict: true, contexts: [context], checks: [] });
  }
  const policyWorkflow = policyWorkflowResponse(url);
  if (policyWorkflow) return policyWorkflow;
  if (url.includes("/actions/runs?") && url.includes("event=pull_request") && url.includes("per_page=100&page=1")) {
    return jsonResponse({
      workflow_runs: [{
        id: 900,
        path: ".github/workflows/ci.yml",
        head_sha: sha,
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-14T23:30:00Z",
        completed_at: "2026-08-14T23:55:00Z",
        pull_requests: Array.from({ length: 200 }, (_, index) => ({
          number: index + 1,
          head: { sha },
          base: { ref: "dev", repo: { full_name: "example/repo" } }
        }))
      }]
    });
  }
  if (url.includes(`/commits/${sha}/check-runs?per_page=100&page=1`)) {
    return jsonResponse({ check_runs: [{ id: 7, name: context, head_sha: sha, status: "completed", conclusion: "success", created_at: "2026-08-14T23:50:00Z", completed_at: "2026-08-14T23:55:00Z" }] });
  }
  if (url.includes(`/commits/${sha}/statuses?per_page=100&page=1`)) {
    return jsonResponse([{ id: 7, context, state: "success", created_at: "2026-08-14T23:50:00Z", updated_at: "2026-08-14T23:55:00Z" }, policyReceiptStatus(context, "2026-08-20T00:50:00Z", null, { pullNumber, headSha: sha, mergeSha: sha, mergedAt: "2026-08-15T00:00:00Z" })]);
  }
  return null;
}

function policyReceiptStatus(context, updatedAt = "2026-08-20T00:50:00Z", appId = null, metadata = {}) {
  const policy = metadata.policy ?? [{ context, appId, strict: metadata.strict ?? true }];
  const policyDigest = createHash("sha256")
    .update(JSON.stringify(policy))
    .digest("hex");
  const pullNumber = Number(metadata.pullNumber ?? 11);
  const headSha = String(metadata.headSha ?? SHA);
  const mergeSha = String(metadata.mergeSha ?? headSha);
  const base = String(metadata.base ?? "dev");
  const baseSha = String(metadata.baseSha ?? "1".repeat(40));
  const mergedAt = String(metadata.mergedAt ?? "2026-08-15T00:00:00Z");
  latestPolicyReceiptMetadata = {
    pullNumber,
    headSha,
    mergeSha,
    base,
    baseSha,
    policy,
    mergedAt
  };
  return {
    id: 8,
    context: "better-workflows/release-policy-v1",
    state: "success",
    description: `better-workflows-policy-v1:${policyDigest}`,
    created_at: updatedAt,
    updated_at: updatedAt,
    creator: { login: "github-actions[bot]", type: "Bot" },
    target_url: `https://github.com/example/repo/actions/runs/8?phase=merge-bound&pr=${pullNumber}&head=${headSha}&base=${base}&merge=${mergeSha}&source=7`
  };
}

function policyWorkflowResponse(url) {
  const source = url.endsWith("/repos/example/repo/actions/runs/7");
  if (!source && !url.endsWith("/repos/example/repo/actions/runs/8")) return null;
  const mergedMs = Date.parse(latestPolicyReceiptMetadata.mergedAt);
  const closedAt = Number.isFinite(mergedMs) ? new Date(mergedMs + 5 * 60 * 1000).toISOString() : "2026-08-15T00:05:00Z";
  const workflow = {
    id: source ? 7 : 8,
    path: ".github/workflows/ci.yml",
    event: "pull_request_target",
    head_sha: latestPolicyReceiptMetadata.baseSha,
    head_branch: latestPolicyReceiptMetadata.base,
    status: source || policyWorkflowInProgressResponses === 0 ? "completed" : "in_progress",
    conclusion: source || policyWorkflowInProgressResponses === 0 ? "success" : null,
    created_at: source ? "2026-08-14T23:30:00Z" : new Date(mergedMs + 60 * 1000).toISOString(),
    completed_at: source ? "2026-08-14T23:45:00Z" : closedAt,
    repository: { full_name: "example/repo" },
    pull_requests: Array.from({ length: 200 }, (_, index) => ({
      number: index + 1,
      head: { sha: latestPolicyReceiptMetadata.headSha },
      base: { ref: latestPolicyReceiptMetadata.base, sha: latestPolicyReceiptMetadata.baseSha }
    }))
  };
  if (!source && policyWorkflowInProgressResponses > 0) policyWorkflowInProgressResponses -= 1;
  return jsonResponse(workflow);
}

function pullRequestWorkflowResponse(url, entries) {
  if (!url.includes("/actions/runs?") || !url.includes("event=pull_request") || !url.includes("per_page=100&page=1")) return null;
  return jsonResponse({
    workflow_runs: entries.map(({ sha, pullNumber, pullHeadSha = sha, baseRef = "dev", id = 900 + pullNumber, conclusion = "success" }) => ({
      id,
      path: ".github/workflows/ci.yml",
      head_sha: sha,
      event: "pull_request",
      status: conclusion === null ? "in_progress" : "completed",
      conclusion,
      created_at: "2026-08-14T23:30:00Z",
      completed_at: conclusion === null ? null : "2026-08-14T23:55:00Z",
      pull_requests: [{ number: pullNumber, head: { sha: pullHeadSha }, base: { ref: baseRef, repo: { full_name: "example/repo" } } }]
    }))
  });
}

test("release tag names distinguish stable main from dev prerelease integration", () => {
  assert.equal(releaseTagName({ branch: "main", version: "3.4.10", sha: SHA }), "v3.4.10");
  assert.equal(releaseTagName({ branch: "dev", version: "3.4.10", sha: SHA }), "v3.4.10-dev.aaaaaaaaaaaa");
});

test("only a version change creates a release candidate", () => {
  assert.equal(versionChanged("3.4.10", "3.4.9"), true);
  assert.equal(versionChanged("3.4.10", "3.4.10"), false);
  assert.equal(versionChanged("3.4.9", "3.4.10"), false);
  assert.equal(compareStableVersions("3.5.0", "3.4.99"), 1);
  assert.equal(compareStableVersions("3.4.9", "3.4.10"), -1);
  assert.equal(compareStableVersions("3.9007199254740993.0", "3.9007199254740992.0"), 1);
  assert.equal(compareStableVersions(`3.${"9".repeat(80)}.0`, `3.${"8".repeat(80)}.0`), 1);
  assert.equal(versionChanged("3.4.10", null), true);
  assert.equal(versionChanged("3.9007199254740993.0", "3.9007199254740992.0"), true);
});

test("remote-bound historical boundaries without CI workflow are unavailable to policy catch-up", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-policy-boundary-"));
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/scripts"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/scripts/release-policy-receipt.mjs"), "export {};\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "policy publisher without CI workflow"]);
    const revision = await git(work, ["rev-parse", "HEAD"]);
    assert.equal(
      await releasePolicyPublisherAvailable(work, revision, { repository: "example/repo", defaultBranchActivation: true }),
      false
    );
    assert.equal(await releasePolicyPublisherAvailable(work, revision), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package and plugin manifest versions must agree", () => {
  assert.equal(versionSurfaces({ version: "3.4.10" }, { version: "3.4.10+codex.20260814T170343" }), "3.4.10");
  assert.throws(
    () => versionSurfaces({ version: "3.4.10" }, { version: "3.4.11+codex.build" }),
    /do not match/
  );
  assert.throws(() => normalizeStableVersion("3.4.10-dev.1"), /stable semver/);
});

test("only the exact merged PR result for the target branch is eligible", () => {
  const pull = { number: 42, base: { ref: "dev" }, head: { sha: SHA }, merged_at: "2026-08-14T00:00:00Z", merge_commit_sha: SHA };
  assert.equal(findMergedPullRequest([pull], { branch: "dev", sha: SHA }), pull);
  assert.equal(findMergedPullRequest([pull], { branch: "main", sha: SHA }), null);
  assert.equal(findMergedPullRequest([{ ...pull, merge_commit_sha: "b".repeat(40) }], { branch: "dev", sha: SHA }), null);
});

test("workflow-run merge receipt requires its successful trusted trigger binding", () => {
  const policy = [{ context: "test", appId: null, strict: true }];
  const policyDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  const preMergeSha = "b".repeat(40);
  const mergeCommitSha = "c".repeat(40);
  const mergeTimeMs = Date.parse("2026-08-18T00:00:00Z");
  const payload = {
    schemaVersion: 1,
    kind: "better-workflows/release-policy-receipt-v2",
    repository: "example/repo",
    workflowFile: ".github/workflows/release-policy-reconcile.yml",
    workflowRunId: "44",
    eventName: "workflow_run",
    eventAction: "closed",
    branch: "dev",
    pullNumber: 17,
    headSha: preMergeSha,
    policy,
    policyDigest,
    observedAt: "2026-08-18T00:05:00Z",
    mergeCommitSha,
    mergedAt: "2026-08-18T00:00:00Z",
    sourceWorkflowRunId: "42",
    sourcePolicyDigest: policyDigest,
    sourcePolicyArtifactDigest: "e".repeat(64),
    triggerWorkflowRunId: "43",
    closedMergeWorkflowRunId: "99",
    closedMergeWorkflowRunAttempt: "1"
  };
  assert.doesNotThrow(() => assertPolicyReceiptArtifact(payload, {
    repository: "example/repo",
    branch: "dev",
    runId: "44",
    pullNumber: 17,
    preMergeSha,
    requiredPolicyDigest: policyDigest,
    mergeTimeMs,
    phase: "merge-bound",
    mergeCommitSha,
    expectedEventName: "workflow_run",
    triggerWorkflowRunId: "43",
    closedMergeWorkflowRunId: "99",
    closedMergeWorkflowRunAttempt: "1"
  }));
  assert.throws(() => assertPolicyReceiptArtifact(payload, {
    repository: "example/repo",
    branch: "dev",
    runId: "44",
    pullNumber: 17,
    preMergeSha,
    requiredPolicyDigest: policyDigest,
    mergeTimeMs,
    phase: "merge-bound",
    mergeCommitSha,
    expectedEventName: "workflow_run",
    triggerWorkflowRunId: "99",
    closedMergeWorkflowRunId: "99",
    closedMergeWorkflowRunAttempt: "1"
  }), /untrusted merge-bound policy artifact binding/);
  assert.throws(() => assertPolicyReceiptArtifact({ ...payload, closedMergeWorkflowRunId: "98" }, {
    repository: "example/repo",
    branch: "dev",
    runId: "44",
    pullNumber: 17,
    preMergeSha,
    requiredPolicyDigest: policyDigest,
    mergeTimeMs,
    phase: "merge-bound",
    mergeCommitSha,
    expectedEventName: "workflow_run",
    triggerWorkflowRunId: "43",
    closedMergeWorkflowRunId: "99",
    closedMergeWorkflowRunAttempt: "1"
  }), /untrusted merge-bound policy artifact binding/);
  const sourceArtifact = { schemaVersion: 1, kind: "better-workflows/release-policy-receipt-v2", observedAt: "2026-08-17T23:59:00.000Z" };
  const sourceArtifactDigest = "e".repeat(64);
  Object.defineProperty(sourceArtifact, "downloadedArchiveDigest", { value: sourceArtifactDigest, enumerable: false });
  assert.doesNotThrow(() => assertSourcePolicyArtifactDigest({ artifact: { sourcePolicyArtifactDigest: sourceArtifactDigest }, sourceArtifact }));
  assert.throws(
    () => assertSourcePolicyArtifactDigest({ artifact: {}, sourceArtifact }),
    /source policy artifact digest mismatch/
  );
  assert.throws(
    () => assertSourcePolicyArtifactDigest({ artifact: { sourcePolicyArtifactDigest: "f".repeat(64) }, sourceArtifact }),
    /source policy artifact digest mismatch/
  );
});

test("workflow-run terminal evidence requires completed_at and bounded terminal ordering", () => {
  const completedAt = Date.parse("2026-08-18T00:00:01Z");
  assert.equal(
    assertWorkflowRunTerminal({ status: "completed", conclusion: "success", created_at: "2026-08-17T23:59:00Z", completed_at: "2026-08-18T00:00:01Z" }),
    completedAt
  );
  assert.throws(
    () => assertWorkflowRunTerminal({ status: "completed", conclusion: "success", created_at: "2026-08-17T23:59:00Z" }),
    /completed_at terminal receipt/
  );
  assert.throws(
    () => assertWorkflowRunTerminal({ status: "completed", conclusion: "success", completed_at: "not-a-timestamp" }),
    /completed_at terminal receipt/
  );
  assert.throws(
    () => assertWorkflowRunTerminal({ status: "completed", conclusion: "success", completed_at: "2026-08-18T00:00:02Z" }, "workflow run", { notAfterMs: completedAt }),
    /completed_at terminal receipt/
  );
});

test("pull-request workflow selection does not fall back to an older pre-merge success", () => {
  const headSha = "b".repeat(40);
  const mergeTimeMs = Date.parse("2026-08-18T00:00:00Z");
  const result = pullRequestWorkflowObservation({
    workflowRuns: [
      {
        id: 41,
        path: ".github/workflows/ci.yml",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-17T23:50:00Z",
        completed_at: "2026-08-17T23:55:00Z",
        repository: { full_name: "example/repo" },
        pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev", repo: { full_name: "example/repo" } } }]
      },
      {
        id: 42,
        path: ".github/workflows/ci.yml",
        event: "pull_request",
        status: "in_progress",
        conclusion: null,
        created_at: "2026-08-18T00:01:00Z",
        completed_at: null,
        repository: { full_name: "example/repo" },
        pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev", repo: { full_name: "example/repo" } } }]
      }
    ],
    pullNumber: 17,
    expectedPreMergeSha: headSha,
    branch: "dev",
    repository: "example/repo",
    mergeTimeMs
  });
  assert.equal(result.state, "pending");
  assert.equal(result.run.id, 42);
  assert.throws(
    () => pullRequestWorkflowObservation({
      workflowRuns: [
        result.run,
        {
          ...result.run,
          id: 43,
          status: "in_progress",
          conclusion: null,
          created_at: undefined,
          started_at: undefined,
          completed_at: null
        }
      ],
      pullNumber: 17,
      expectedPreMergeSha: headSha,
      branch: "dev",
      repository: "example/repo",
      mergeTimeMs
    }),
    /missing or malformed origin timestamp/
  );
});

test("policy artifact continuity binds the exact downloaded archive bytes", async () => {
  const policy = [{ context: "test", appId: null, strict: true }];
  const receipt = {
    schemaVersion: 1,
    kind: "better-workflows/release-policy-receipt-v2",
    repository: "example/repo",
    workflowFile: ".github/workflows/ci.yml",
    workflowRunId: "42",
    workflowRunAttempt: "2",
    eventName: "pull_request_target",
    eventAction: "synchronize",
    branch: "dev",
    pullNumber: 17,
    headSha: "b".repeat(40),
    policy,
    policyDigest: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    observedAt: "2026-08-17T23:59:00Z"
  };
  const archive = zipStoredJson("release-policy-receipt.json", receipt);
  const archiveDigest = createHash("sha256").update(archive).digest("hex");
  const binding = {
    repository: "example/repo",
    branch: "dev",
    runId: "42",
    workflowRunAttempt: "2",
    pullNumber: 17,
    preMergeSha: receipt.headSha,
    requiredPolicyDigest: receipt.policyDigest,
    mergeTimeMs: null,
    phase: "pre-merge"
  };
  const fetchFor = (downloaded) => async (url) => {
    if (url.includes("/artifacts?")) return jsonResponse({ artifacts: [{
      name: "better-workflows-release-policy-receipt-42-2",
      expired: false,
      digest: `sha256:${archiveDigest}`,
      workflow_run: { id: 42, run_attempt: 2 },
      archive_download_url: "https://artifact.invalid/receipt.zip"
    }] });
    return {
      ok: true,
      status: 200,
      headers: { get() { return null; } },
      async arrayBuffer() { return downloaded.buffer.slice(downloaded.byteOffset, downloaded.byteOffset + downloaded.byteLength); }
    };
  };
  const fetched = await fetchPolicyReceiptArtifact({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    runId: "42",
    runAttempt: "2",
    token: "token",
    fetchImpl: fetchFor(archive),
    binding
  });
  assert.equal(fetched.downloadedArchiveDigest, archiveDigest);
  await assert.rejects(
    fetchPolicyReceiptArtifact({
      apiUrl: "https://api.github.com",
      repository: "example/repo",
      runId: "42",
      runAttempt: "2",
      token: "token",
      fetchImpl: fetchFor(Buffer.concat([archive, Buffer.from("\n")])),
      binding
    }),
    /artifact digest drifted/
  );
});

test("merge-bound policy artifact reruns select the exact target attempt and preserve source attempt", async () => {
  const policy = [{ context: "test", appId: null, strict: true }];
  const policyDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  const mergeTimeMs = Date.parse("2026-08-18T00:00:00Z");
  const receipt = {
    schemaVersion: 1,
    kind: "better-workflows/release-policy-receipt-v2",
    repository: "example/repo",
    workflowFile: ".github/workflows/ci.yml",
    workflowRunId: "42",
    workflowRunAttempt: "2",
    eventName: "pull_request_target",
    eventAction: "closed",
    branch: "dev",
    pullNumber: 17,
    headSha: "b".repeat(40),
    policy,
    policyDigest,
    observedAt: "2026-08-18T00:00:05Z",
    mergeCommitSha: "c".repeat(40),
    mergedAt: "2026-08-18T00:00:00Z",
    sourceWorkflowRunId: "41",
    sourceWorkflowRunAttempt: "4",
    sourcePolicyDigest: policyDigest,
    sourcePolicyArtifactDigest: "d".repeat(64)
  };
  const archive = zipStoredJson("release-policy-receipt.json", receipt);
  const archiveDigest = createHash("sha256").update(archive).digest("hex");
  const fetched = await fetchPolicyReceiptArtifact({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    runId: "42",
    runAttempt: "2",
    token: "token",
    fetchImpl: async (url) => url.includes("/artifacts?")
      ? jsonResponse({ artifacts: [
        { id: 41, name: "better-workflows-release-policy-receipt-42-1", expired: false, digest: "sha256:" + "e".repeat(64), workflow_run: { id: 42, run_attempt: 1 }, archive_download_url: "https://artifact.invalid/old.zip" },
        { id: 42, name: "better-workflows-release-policy-receipt-42-2", expired: false, digest: `sha256:${archiveDigest}`, workflow_run: { id: 42, run_attempt: 2 }, archive_download_url: "https://artifact.invalid/current.zip" }
      ] })
      : { ok: true, status: 200, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) },
    binding: {
      repository: "example/repo",
      branch: "dev",
      runId: "42",
      workflowRunAttempt: "2",
      pullNumber: 17,
      preMergeSha: receipt.headSha,
      requiredPolicyDigest: policyDigest,
      mergeTimeMs,
      phase: "merge-bound",
      mergeCommitSha: receipt.mergeCommitSha,
      sourceWorkflowRunAttempt: "4"
    }
  });
  assert.equal(fetched.workflowRunAttempt, "2");
  assert.equal(fetched.sourceWorkflowRunAttempt, "4");
});

test("delayed pre-merge policy artifacts require explicit source-run provenance", () => {
  const policy = [{ context: "test", appId: null, strict: true }];
  const policyDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  const preMergeSha = "d".repeat(40);
  const payload = {
    schemaVersion: 1,
    kind: "better-workflows/release-policy-receipt-v2",
    repository: "example/repo",
    workflowFile: ".github/workflows/ci.yml",
    workflowRunId: "52",
    eventName: "pull_request_target",
    eventAction: "synchronize",
    branch: "dev",
    pullNumber: 17,
    headSha: preMergeSha,
    policy,
    policyDigest,
    observedAt: "2026-08-18T00:00:05Z"
  };
  const binding = {
    repository: "example/repo",
    branch: "dev",
    runId: "52",
    pullNumber: 17,
    preMergeSha,
    requiredPolicyDigest: policyDigest,
    mergeTimeMs: Date.parse("2026-08-18T00:00:00Z"),
    phase: "pre-merge"
  };
  assert.throws(() => assertPolicyReceiptArtifact(payload, binding), /pre-merge policy evidence after/);
  assert.throws(() => assertPolicyReceiptArtifact(payload, { ...binding, allowPostMergeObservation: true }), /pre-merge policy evidence after/);
});

test("associated PR discovery fails closed when the first page is full", async () => {
  await assert.rejects(
    repositoryPullRequests({
      apiUrl: "https://api.github.com",
      repository: "example/repo",
      sha: SHA,
      token: "test-token",
      fetchImpl: async () => jsonResponse(Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })))
    }),
    /full first page; refusing incomplete PR association/
  );
});

test("annotated and lightweight remote tags are compared by commit", () => {
  const output = [
    `${"b".repeat(40)}\trefs/tags/v3.4.10`,
    `${SHA}\trefs/tags/v3.4.10^{}`
  ].join("\n");
  assert.equal(parseRemoteTagCommit(output), SHA);
  assert.equal(remoteTagMatches(output, SHA), true);
  assert.equal(remoteTagMatches(output, "b".repeat(40)), false);
});

test("GitHub GraphQL endpoint maps GitHub.com and GHES API URLs", () => {
  assert.equal(githubGraphqlUrl("https://api.github.com"), "https://api.github.com/graphql");
  assert.equal(githubGraphqlUrl("https://ghe.example/api/v3"), "https://ghe.example/api/graphql");
  assert.equal(githubGraphqlUrl("https://ghe.example/api/v3/"), "https://ghe.example/api/graphql");
  assert.equal(githubGraphqlUrl("https://ghe.example/api/graphql"), "https://ghe.example/api/graphql");
});

test("release tag publication binds branch CAS and tag creation in one atomic GitHub mutation", () => {
  const mutation = releaseTagAtomicMutation({
    repositoryId: "R_123",
    branch: "dev",
    tag: "v3.4.10-dev.aaaaaaaaaaaa",
    sha: SHA
  });
  assert.match(mutation.query, /updateRefs/);
  assert.deepEqual(mutation.variables.refUpdates, [
    { name: "refs/heads/dev", beforeOid: SHA, afterOid: SHA, force: false },
    { name: "refs/tags/v3.4.10-dev.aaaaaaaaaaaa", beforeOid: "0".repeat(40), afterOid: SHA, force: false }
  ]);
  assert.equal(releaseTagParentRevision("0".repeat(40)), null);
  assert.equal(releaseTagParentRevision(SHA), SHA);
  assert.throws(() => releaseTagAtomicMutation({ repositoryId: "R_123", branch: "feature", tag: "v3.4.10", sha: SHA }), /dev or main/);
});

test("release tag fails closed when the atomic branch CAS observes a concurrent move", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-cas-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const base = await git(work, ["rev-parse", "HEAD"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "release"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    let mutationRequest;
    const fetchImpl = async (url, options = {}) => {
      const workflowResponse = pullRequestWorkflowResponse(url, [{ sha: head, pullNumber: 7 }]);
      if (workflowResponse) return workflowResponse;
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 7, base: { ref: "dev", sha: base }, head: { sha: head }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: head }]);
      }
      const checkResponse = successfulRequiredCheckResponse(url, head, "test", 7);
      if (checkResponse) return checkResponse;
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(options.body);
        if (body.query.startsWith("query(")) return jsonResponse({ data: { repository: { id: "R_123" } } });
        mutationRequest = body;
        return jsonResponse({ errors: [{ message: "expected branch tip does not match" }] });
      }
      throw new Error(`Unexpected release-tag fetch URL: ${url}`);
    };
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: base,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: head,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com"
        }
      }),
      /expected branch tip does not match/
    );
    assert.equal(mutationRequest.variables.refUpdates[0].beforeOid, head);
    assert.equal(mutationRequest.variables.refUpdates[0].afterOid, head);
    assert.equal(await git(work, ["ls-remote", "origin", "refs/tags/v3.4.13-dev." + head.slice(0, 12)]), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing release tag revalidates the remote branch tip before returning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-existing-race-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const bin = path.join(root, "bin");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await mkdir(bin, { recursive: true });
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const base = await git(work, ["rev-parse", "HEAD"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "release"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    const tag = `v3.4.13-dev.${head.slice(0, 12)}`;
    await git(work, ["tag", tag, head]);
    await git(work, ["push", "-q", "origin", `refs/tags/${tag}`]);
    const shim = path.join(bin, "git");
    const shimScript = `#!/bin/sh
if [ "$1" = "ls-remote" ] && [ "$2" = "--tags" ]; then
  /usr/bin/git --git-dir=${JSON.stringify(bare)} update-ref refs/heads/dev ${base}
fi
exec /usr/bin/git "$@"
`;
    await writeFile(shim, shimScript, { mode: 0o700 });
    const fetchImpl = async (url) => {
      const workflowResponse = pullRequestWorkflowResponse(url, [{ sha: head, pullNumber: 8 }]);
      if (workflowResponse) return workflowResponse;
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 8, base: { ref: "dev", sha: base }, head: { sha: head }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: head }]);
      }
      const checkResponse = successfulRequiredCheckResponse(url, head, "test", 8);
      if (checkResponse) return checkResponse;
      throw new Error(`Unexpected release-tag fetch URL: ${url}`);
    };
    const priorPath = process.env.PATH;
    process.env.PATH = `${bin}:${priorPath}`;
    try {
      await assert.rejects(
        runReleaseTag({
          cwd: work,
          fetchImpl,
          env: {
            GITHUB_EVENT_NAME: "push",
            GITHUB_EVENT_BEFORE: base,
            GITHUB_REF_NAME: "dev",
            GITHUB_REPOSITORY: "example/repo",
            GITHUB_SHA: head,
            GITHUB_TOKEN: "test-token",
            GITHUB_API_URL: "https://api.github.com"
          }
        }),
        /moved before existing release tag reconciliation/
      );
    } finally {
      process.env.PATH = priorPath;
    }
    await git(work, ["--git-dir", bare, "update-ref", "refs/heads/dev", head]);
    const reconciled = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: base,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: head,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com"
      }
    });
    const { mergeTimeReceipt: reconciledReceipt, ...reconciledChecks } = reconciled.requiredChecks;
    assert.deepEqual({ ...reconciled, requiredChecks: reconciledChecks }, {
      status: "existing",
      tag,
      branch: "dev",
      sha: head,
      version: "3.4.13",
      pullNumber: 8,
      requiredChecks: {
        headSha: head,
        requiredRequirements: [{ context: "test", appId: null, strict: true }],
        requiredContexts: ["test"],
        checkRuns: [{ id: "7", name: "test", status: "completed", conclusion: "success" }],
        statuses: []
      }
    });
    assert.equal(reconciledReceipt.kind, "merge-time-required-checks-v1");
    assert.equal(reconciledReceipt.preMergeSha, head);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merge-time policy receipt binds the pre-merge head separately from the merge commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-policy-head-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const syntheticMergeSha = "c".repeat(40);
  const pullNumber = 17;
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const eventBefore = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["switch", "-c", "feature/release"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "release source"]);
    const preMergeSha = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["switch", "dev"]);
    await git(work, ["merge", "--no-ff", "-qm", "merge result", "feature/release"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const mergeSha = await git(work, ["rev-parse", "HEAD"]);
    policyArtifactUnavailableResponses = 1;
    policyWorkflowInProgressResponses = 1;
    let newerPolicyStatus = null;
    let exerciseLatePolicy = false;
    let includePolicySelfContext = false;
    let policyStatusQueries = 0;
    let checkQueries = 0;
    const fetchImpl = async (url) => {
      if (url.endsWith(`/repos/example/repo/commits/${mergeSha}/pulls?per_page=100`)) {
        return jsonResponse([{
          number: pullNumber,
          base: { ref: "dev", sha: eventBefore },
          head: { sha: preMergeSha, ref: "feature/release" },
          merged_at: "2026-08-15T00:00:00Z",
          merge_commit_sha: mergeSha
        }]);
      }
      const workflowResponse = pullRequestWorkflowResponse(url, [
        { sha: syntheticMergeSha, pullHeadSha: preMergeSha, pullNumber, id: 901 },
        { sha: "d".repeat(40), pullHeadSha: "e".repeat(40), pullNumber, id: 999 }
      ]);
      if (workflowResponse) return workflowResponse;
      if (url.endsWith("/branches/dev/protection/required_status_checks")) {
        return jsonResponse({ strict: true, contexts: ["current-only"], checks: [] });
      }
      if (url.includes(`/commits/${syntheticMergeSha}/check-runs?per_page=100&page=1`)) {
        checkQueries += 1;
        if (exerciseLatePolicy && checkQueries === 1) {
          return jsonResponse({ check_runs: [{ id: 7, name: "test", head_sha: syntheticMergeSha, status: "in_progress", conclusion: null, created_at: "2026-08-14T23:50:00Z", completed_at: null }] });
        }
        return jsonResponse({ check_runs: [{ id: 7, name: "test", head_sha: syntheticMergeSha, status: "completed", conclusion: "success", created_at: "2026-08-14T23:50:00Z", completed_at: "2026-08-14T23:55:00Z" }] });
      }
      if (url.includes(`/commits/${syntheticMergeSha}/statuses?per_page=100&page=1`)) return jsonResponse([]);
      if (url.includes(`/commits/${preMergeSha}/statuses?per_page=100&page=1`)) {
        policyStatusQueries += 1;
        return jsonResponse([
          { id: 7, context: "test", state: "success", created_at: "2026-08-14T23:40:00Z", updated_at: "2026-08-14T23:40:00Z" },
          policyReceiptStatus("test", "2026-08-20T00:50:00Z", null, {
            pullNumber,
            headSha: preMergeSha,
            mergeSha,
            mergedAt: "2026-08-15T00:00:00Z",
            ...(includePolicySelfContext ? {
              policy: [
                { context: "better-workflows/release-policy-v1", appId: null, strict: true },
                { context: "test", appId: null, strict: true }
              ]
            } : {})
          }),
          ...(newerPolicyStatus && (!exerciseLatePolicy || policyStatusQueries >= 2) ? [newerPolicyStatus] : [])
        ]);
      }
      const policyWorkflow = policyWorkflowResponse(url);
      if (policyWorkflow) return policyWorkflow;
      throw new Error(`Unexpected merge-time policy fetch URL: ${url}`);
    };
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: eventBefore,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: mergeSha,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com",
        RELEASE_TAG_DRY_RUN: "1"
      }
    });
    assert.equal(result.status, "planned");
    assert.equal(result.sha, mergeSha);
    assert.equal(result.requiredChecks.mergeTimeReceipt.preMergeSha, preMergeSha);
    assert.equal(result.requiredChecks.mergeTimeReceipt.testedSha, syntheticMergeSha);
    assert.equal(result.requiredChecks.mergeTimeReceipt.mergeCommitSha, mergeSha);
    assert.deepEqual(result.requiredChecks.requiredRequirements, [{ context: "test", appId: null, strict: true }]);
    assert.equal(policyArtifactUnavailableResponses, 0);
    includePolicySelfContext = true;
    newerPolicyStatus = null;
    exerciseLatePolicy = false;
    policyStatusQueries = 0;
    checkQueries = 0;
    const selfContextResult = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: eventBefore,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: mergeSha,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com",
        RELEASE_TAG_DRY_RUN: "1"
      }
    });
    assert.equal(selfContextResult.status, "planned");
    assert.deepEqual(selfContextResult.requiredChecks.requiredRequirements, [
      { context: "better-workflows/release-policy-v1", appId: null, strict: true },
      { context: "test", appId: null, strict: true }
    ]);
    assert.deepEqual(selfContextResult.requiredChecks.statuses, []);
    assert.deepEqual(selfContextResult.requiredChecks.requiredContexts, [
      "better-workflows/release-policy-v1",
      "test"
    ]);
    assert.equal(selfContextResult.requiredChecks.mergeTimeReceipt.policyReceipt.context, "better-workflows/release-policy-v1");
    includePolicySelfContext = false;
    const newerPolicyBase = {
      ...policyReceiptStatus("test", "2026-08-20T01:00:00Z", null, { pullNumber, headSha: preMergeSha, mergeSha, mergedAt: "2026-08-15T00:00:00Z" }),
      id: 9,
      state: "pending"
    };
    newerPolicyStatus = newerPolicyBase;
    exerciseLatePolicy = true;
    policyStatusQueries = 0;
    checkQueries = 0;
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: eventBefore,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: mergeSha,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /unauthenticated merge-time required-check policy receipt/
    );
    exerciseLatePolicy = false;
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: eventBefore,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: mergeSha,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /unauthenticated merge-time required-check policy receipt/
    );
    newerPolicyStatus = { ...newerPolicyBase, id: 10, state: "success", target_url: "not-a-provider-url" };
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: eventBefore,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: mergeSha,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /unauthenticated merge-time required-check policy receipt/
    );
    newerPolicyStatus = {
      ...newerPolicyBase,
      id: 11,
      state: "success",
      target_url: newerPolicyBase.target_url.replace("phase=merge-bound", "phase=pre-merge")
    };
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: eventBefore,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: mergeSha,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /trusted merge-bound policy receipt/
    );
    const { updated_at: _updatedAt, ...missingTerminalPolicyStatus } = newerPolicyBase;
    newerPolicyStatus = { ...missingTerminalPolicyStatus, id: 12, state: "success" };
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: eventBefore,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: mergeSha,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /policy status without a valid terminal timestamp/
    );
    newerPolicyStatus = {
      ...newerPolicyBase,
      id: 13,
      state: "success",
      target_url: newerPolicyBase.target_url.replace("/actions/runs/8", "/actions/runs/0008")
    };
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: eventBefore,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: mergeSha,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /missing or unsafe workflow-run identity/
    );
  } finally {
    policyArtifactUnavailableResponses = 0;
    policyWorkflowInProgressResponses = 0;
    await rm(root, { recursive: true, force: true });
  }
});

test("first rollout skips tagging until the trusted base contains the policy publisher", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-policy-bootstrap-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, ".github/workflows"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, ".github/workflows/ci.yml"), "name: CI\n");
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base without publisher"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const base = await git(work, ["rev-parse", "HEAD"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "first rollout"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl: async (url) => {
        if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
          return jsonResponse([{
            number: 18,
            base: { ref: "dev", sha: base },
            head: { sha: "b".repeat(40) },
            merged_at: "2026-08-15T00:00:00Z",
            merge_commit_sha: head
          }]);
        }
        throw new Error(`Unexpected bootstrap fetch URL: ${url}`);
      },
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: base,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: head,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com"
      }
    });
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "release-policy-receipt-bootstrap-pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release-policy bootstrap requires active default-branch workflow activation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-default-branch-activation-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, ".github/workflows"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows/scripts"), { recursive: true });
    await writeFile(path.join(work, ".github/workflows/ci.yml"), "name: CI\non:\n  pull_request_target:\njobs:\n  release-policy-receipt:\n");
    await writeFile(path.join(work, "plugins/better-workflows/scripts/release-policy-receipt.mjs"), "export {};\n");
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "trusted workflow base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const base = await git(work, ["rev-parse", "HEAD"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "version bump"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl: async (url) => {
        if (url.endsWith(`/repos/activation/repo/commits/${head}/pulls?per_page=100`)) {
          return jsonResponse([{ number: 19, base: { ref: "dev", sha: base }, head: { sha: head }, merged_at: "2026-08-19T00:00:00Z", merge_commit_sha: head }]);
        }
        if (url.endsWith("/repos/activation/repo")) return jsonResponse({ default_branch: "main" });
        if (url.endsWith("/repos/activation/repo/actions/workflows/ci.yml")) return jsonResponse({ path: ".github/workflows/ci.yml", state: "disabled_manually" });
        throw new Error(`Unexpected default-branch activation fetch URL: ${url}`);
      },
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: base,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "activation/repo",
        GITHUB_SHA: head,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com"
      }
    });
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "release-policy-receipt-bootstrap-pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap-skipped version bumps do not block a later publisher-backed catch-up", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-policy-bootstrap-catch-up-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, ".github/workflows"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows/scripts"), { recursive: true });
    const writeVersion = async (version) => {
      await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version }));
      await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: `${version}+codex.test` }));
    };
    await writeFile(path.join(work, ".github/workflows/ci.yml"), "name: CI\n");
    await writeVersion("3.4.12");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base without publisher"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const base = await git(work, ["rev-parse", "HEAD"]);

    await writeVersion("3.4.13");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "bootstrap version bump"]);
    const bootstrapBump = await git(work, ["rev-parse", "HEAD"]);

    await writeFile(path.join(work, "plugins/better-workflows/scripts/release-policy-receipt.mjs"), "export {};\n");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "publish release policy"]);
    const publisherBase = await git(work, ["rev-parse", "HEAD"]);

    await writeVersion("3.4.14");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "publisher-backed version bump"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const fetchImpl = async (url) => {
      const workflowResponse = pullRequestWorkflowResponse(url, [{ sha: head, pullNumber: 20 }]);
      if (workflowResponse) return workflowResponse;
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 20, base: { ref: "dev", sha: publisherBase }, head: { sha: head }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${bootstrapBump}/pulls?per_page=100`)) {
        // The live PR base has advanced, but the immutable first parent still
        // predates the publisher and must keep this bootstrap bump excluded.
        return jsonResponse([{ number: 18, base: { ref: "dev", sha: publisherBase }, head: { sha: bootstrapBump }, merged_at: "2026-08-17T00:00:00Z", merge_commit_sha: bootstrapBump }]);
      }
      if (url.includes(`/commits/${head}/statuses?per_page=100&page=1`)) {
        return jsonResponse([
          { id: 7, context: "test", state: "success", created_at: "2026-08-14T23:40:00Z", updated_at: "2026-08-14T23:40:00Z" },
          policyReceiptStatus("test", "2026-08-18T00:50:00Z", null, { pullNumber: 20, headSha: head, mergeSha: head, mergedAt: "2026-08-18T00:00:00Z" })
        ]);
      }
      const response = successfulRequiredCheckResponse(url, head, "test", 20);
      if (response) return response;
      if (url.includes("/commits/") && url.endsWith("/pulls?per_page=100")) return jsonResponse([]);
      throw new Error(`Unexpected bootstrap catch-up fetch URL: ${url}`);
    };
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: publisherBase,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: head,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com",
        RELEASE_TAG_DRY_RUN: "1"
      }
    });
    assert.equal(result.status, "planned");
    assert.equal(result.version, "3.4.14");
    assert.equal(result.sha, head);
    assert.equal(result.pullNumber, 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release eligibility uses the validated push-event parent across multi-commit integration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-parent-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const eventBefore = await git(work, ["rev-parse", "HEAD"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "version bump"]);
    const intermediate = await git(work, ["rev-parse", "HEAD"]);
    await writeFile(path.join(work, "README.md"), "follow-up commit\n");
    await git(work, ["add", "README.md"]);
    await git(work, ["commit", "-qm", "follow-up"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    let checkConclusion = "failure";
    let requiredContext = "integration-tag";
    let startedAtOnlyNewerFailure = false;
    let missingCompletedAt = false;
    let invalidCompletedAt = false;
    let largeIdConflict = false;
    let duplicateProviderObservation = false;
    let largeStatusConflict = false;
    let duplicateStatusObservation = false;
    let crossKindStatusConflict = false;
    let largeWorkflowConflict = false;
    let duplicateWorkflowObservation = false;
    const fetchImpl = async (url) => {
      if ((largeWorkflowConflict || duplicateWorkflowObservation) && url.includes("/actions/runs?") && url.includes("event=pull_request")) {
        const workflowSha = url.includes(`head_sha=${intermediate}`) ? intermediate : head;
        const workflowPullNumber = workflowSha === intermediate ? 10 : 9;
        const workflowRun = (id, conclusion) => ({
          id,
          path: ".github/workflows/ci.yml",
          head_sha: workflowSha,
          event: "pull_request",
          status: "completed",
          conclusion,
          created_at: "2026-08-14T23:30:00Z",
          completed_at: "2026-08-14T23:55:00Z",
          pull_requests: [{ number: workflowPullNumber, head: { sha: workflowSha }, base: { ref: "dev", repo: { full_name: "example/repo" } } }]
        });
        return jsonResponse(largeWorkflowConflict
          ? { workflow_runs: [workflowRun("9007199254740993", "failure"), workflowRun("9007199254740992", "success")] }
          : { workflow_runs: [workflowRun("9007199254740993", "success"), workflowRun("9007199254740993", "failure")] });
      }
      const workflowResponse = pullRequestWorkflowResponse(url, [
        { sha: head, pullNumber: 9 },
        { sha: intermediate, pullNumber: 10 }
      ]);
      if (workflowResponse) return workflowResponse;
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        // The exact PR base is the immutable integration boundary for the
        // multi-commit result; the push-event before SHA is only a batch
        // boundary and must not substitute for it.
        return jsonResponse([{ number: 9, base: { ref: "dev", sha: eventBefore }, head: { sha: head }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${intermediate}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 10, base: { ref: "dev" }, head: { sha: intermediate }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: intermediate }]);
      }
      if (url.includes(`/repos/example/repo/actions/runs?head_sha=${intermediate}&event=push&branch=dev&per_page=100&page=1`)) {
        return jsonResponse({ workflow_runs: [{ id: 7, path: ".github/workflows/ci.yml", head_sha: intermediate, head_branch: "dev", event: "push", status: "completed", conclusion: "success", created_at: "2026-08-14T23:50:00Z", completed_at: "2026-08-14T23:55:00Z" }] });
      }
      const checkSha = url.includes(`/commits/${intermediate}/`) ? intermediate : head;
      if (crossKindStatusConflict && checkSha === head && url.includes(`/commits/${head}/check-runs?per_page=100&page=1`)) {
        return jsonResponse({ check_runs: [{ id: 198, name: requiredContext, head_sha: head, status: "completed", conclusion: "failure", created_at: "2026-08-14T23:55:00Z", completed_at: "2026-08-14T23:55:00Z" }] });
      }
      if (crossKindStatusConflict && checkSha === head && url.includes(`/commits/${head}/statuses?per_page=100&page=1`)) {
        return jsonResponse([
          { id: 200, context: requiredContext, sha: head, state: "success", created_at: "2026-08-14T23:55:00Z", updated_at: "2026-08-14T23:55:00Z" },
          policyReceiptStatus(requiredContext, "2026-08-20T00:50:00Z", null, { pullNumber: 9, headSha: head, mergeSha: head, mergedAt: "2026-08-15T00:00:00Z" })
        ]);
      }
      if ((largeStatusConflict || duplicateStatusObservation) && url.includes("/statuses?per_page=100&page=1")) {
        const statusRecord = (id, state) => ({
          id,
          context: "test",
          sha: checkSha,
          state,
          created_at: "2026-08-14T23:55:00Z",
          updated_at: "2026-08-14T23:55:00Z"
        });
        return jsonResponse([
          ...(largeStatusConflict
            ? [statusRecord("9007199254740993", "failure"), statusRecord("9007199254740992", "success")]
            : [statusRecord("9007199254740993", "success"), statusRecord("9007199254740993", "failure")]),
          policyReceiptStatus("test", "2026-08-20T00:50:00Z", null, { pullNumber: checkSha === intermediate ? 10 : 9, headSha: checkSha, mergeSha: checkSha, mergedAt: "2026-08-15T00:00:00Z" })
        ]);
      }
      if (checkSha === intermediate && url.includes(`/commits/${intermediate}/check-runs?per_page=100&page=1`)) {
        return jsonResponse({ check_runs: [{ id: 7, name: requiredContext, head_sha: intermediate, status: "completed", conclusion: checkConclusion, created_at: "2026-08-14T23:50:00Z", completed_at: "2026-08-14T23:55:00Z", details_url: `https://github.com/example/repo/actions/runs/7/job/70`, app: { slug: "github-actions" } }] });
      }
      if (startedAtOnlyNewerFailure && checkSha === head && url.includes(`/commits/${head}/check-runs?per_page=100&page=1`)) {
        return jsonResponse({ check_runs: [
          { id: 7, name: requiredContext, head_sha: head, status: "completed", conclusion: "success", created_at: "2026-08-14T23:50:00Z", completed_at: "2026-08-14T23:55:00Z" },
          { id: 8, name: requiredContext, head_sha: head, status: "completed", conclusion: "failure", started_at: "2026-08-14T23:56:00Z", completed_at: "2026-08-14T23:57:00Z" }
        ] });
      }
      if ((missingCompletedAt || invalidCompletedAt) && checkSha === head && url.includes(`/commits/${head}/check-runs?per_page=100&page=1`)) {
        return jsonResponse({ check_runs: [
          { id: 7, name: requiredContext, head_sha: head, status: "completed", conclusion: "success", created_at: "2026-08-14T23:55:00Z", ...(invalidCompletedAt ? { completed_at: "not-a-timestamp" } : {}) }
        ] });
      }
      if (largeIdConflict && checkSha === head && url.includes(`/commits/${head}/check-runs?per_page=100&page=1`)) {
        return jsonResponse({ check_runs: [
          { id: "9007199254740993", name: requiredContext, head_sha: head, status: "completed", conclusion: "failure", created_at: "2026-08-14T23:55:00Z", completed_at: "2026-08-14T23:56:00Z" },
          { id: "9007199254740992", name: requiredContext, head_sha: head, status: "completed", conclusion: "success", created_at: "2026-08-14T23:55:00Z", completed_at: "2026-08-14T23:56:00Z" }
        ] });
      }
      if (duplicateProviderObservation && checkSha === head && url.includes(`/commits/${head}/check-runs?per_page=100&page=1`)) {
        return jsonResponse({ check_runs: [
          { id: "9007199254740993", name: requiredContext, head_sha: head, status: "completed", conclusion: "success", created_at: "2026-08-14T23:55:00Z", completed_at: "2026-08-14T23:56:00Z" },
          { id: "9007199254740993", name: requiredContext, head_sha: head, status: "completed", conclusion: "failure", created_at: "2026-08-14T23:55:00Z", completed_at: "2026-08-14T23:56:00Z" }
        ] });
      }
      const checkResponse = successfulRequiredCheckResponse(url, checkSha, requiredContext, checkSha === intermediate ? 10 : 9);
      if (checkResponse) {
        if (url.includes(`/commits/${checkSha}/check-runs?per_page=100&page=1`)) {
          return jsonResponse({ check_runs: [{ id: 7, name: requiredContext, head_sha: checkSha, status: "completed", conclusion: checkConclusion, created_at: "2026-08-14T23:50:00Z", completed_at: "2026-08-14T23:55:00Z" }] });
        }
        return checkResponse;
      }
      throw new Error(`Unexpected release-tag fetch URL: ${url}`);
    };
    const env = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_BEFORE: eventBefore,
      GITHUB_REF_NAME: "dev",
      GITHUB_REPOSITORY: "example/repo",
      GITHUB_SHA: head,
      GITHUB_TOKEN: "test-token",
      GITHUB_API_URL: "https://api.github.com",
      RELEASE_TAG_DRY_RUN: "1"
    };
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env }),
      /includes the integration-tag job/
    );
    requiredContext = "test";
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env }),
      /all exact required checks and statuses to complete successfully|lacks a timestamped test required check receipt|ambiguous at the same timestamp/
    );
    checkConclusion = "success";
    startedAtOnlyNewerFailure = true;
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env }),
      /all exact required checks and statuses to complete successfully/
    );
    startedAtOnlyNewerFailure = false;
    missingCompletedAt = true;
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env }),
      /all exact required checks and statuses to complete successfully|lacks a timestamped test required check receipt/
    );
    missingCompletedAt = false;
    invalidCompletedAt = true;
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env }),
      /all exact required checks and statuses to complete successfully|lacks a timestamped test required check receipt/
    );
    invalidCompletedAt = false;
    largeIdConflict = true;
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env }),
      /all exact required checks and statuses to complete successfully/
    );
    largeIdConflict = false;
    duplicateProviderObservation = true;
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env }),
      /ambiguous duplicate observation/
    );
    duplicateProviderObservation = false;
    largeStatusConflict = true;
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env }),
      /all exact required checks and statuses to complete successfully|lacks an exact required check/
    );
    largeStatusConflict = false;
    duplicateStatusObservation = true;
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env }),
      /ambiguous duplicate observation/
    );
    duplicateStatusObservation = false;
    crossKindStatusConflict = true;
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env }),
      /ambiguous at the same timestamp|all exact required checks/
    );
    crossKindStatusConflict = false;
    largeWorkflowConflict = true;
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env }),
      /lacks an exact successful test workflow check|lacks an exact successful pull-request workflow receipt|all exact required checks/
    );
    largeWorkflowConflict = false;
    duplicateWorkflowObservation = true;
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env }),
      /ambiguous duplicate observation/
    );
    duplicateWorkflowObservation = false;
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env
    });
    assert.equal(intermediate, await git(work, ["rev-parse", `${head}^1`]));
    const { mergeTimeReceipt: plannedReceipt, ...plannedChecks } = result.requiredChecks;
    assert.deepEqual({ ...result, requiredChecks: plannedChecks }, {
      status: "planned",
      tag: `v3.4.13-dev.${head.slice(0, 12)}`,
      branch: "dev",
      sha: head,
      version: "3.4.13",
      pullNumber: 9,
      requiredChecks: {
        headSha: head,
        requiredRequirements: [{ context: "test", appId: null, strict: true }],
        requiredContexts: ["test"],
        checkRuns: [{ id: "7", name: "test", status: "completed", conclusion: "success" }],
        statuses: []
      }
    });
    assert.equal(plannedReceipt.kind, "merge-time-required-checks-v1");
    assert.equal(plannedReceipt.preMergeSha, head);
    const unrelatedTree = await git(work, ["rev-parse", `${head}^{tree}`]);
    const unrelatedBefore = await git(work, ["commit-tree", unrelatedTree, "-m", "unrelated event parent"]);
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: unrelatedBefore,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: head,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /is not an ancestor of event SHA/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release eligibility does not launder an earlier bump through a later PR in one push", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-batch-laundered-pr-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const eventBefore = await git(work, ["rev-parse", "HEAD"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "earlier release bump"]);
    const earlierBump = await git(work, ["rev-parse", "HEAD"]);
    await writeFile(path.join(work, "README.md"), "unrelated merged PR\n");
    await git(work, ["add", "README.md"]);
    await git(work, ["commit", "-qm", "later unrelated PR"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const fetchImpl = async (url) => {
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 91, base: { ref: "dev", sha: earlierBump }, head: { sha: head }, merged_at: "2026-08-21T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${earlierBump}/pulls?per_page=100`)) return jsonResponse([]);
      throw new Error(`Unexpected batch-laundered release-tag fetch URL: ${url}`);
    };
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: eventBefore,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: head,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com",
        RELEASE_TAG_DRY_RUN: "1"
      }
    });
    assert.deepEqual(result, {
      status: "skipped",
      reason: "commit-is-not-an-exact-merged-pr-result",
      branch: "dev",
      sha: head
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release eligibility accepts a version-bump PR whose source is behind the target first parent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-behind-target-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    const writeVersion = async (version) => {
      await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version }));
      await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: `${version}+codex.test` }));
    };
    await writeVersion("3.4.12");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const base = await git(work, ["rev-parse", "HEAD"]);
    await writeFile(path.join(work, "target-only.txt"), "target branch moved\n");
    await git(work, ["add", "target-only.txt"]);
    await git(work, ["commit", "-qm", "target branch advance"]);
    const eventBefore = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["branch", "feature", base]);
    await git(work, ["switch", "feature"]);
    await writeVersion("3.4.13");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "version bump"]);
    const source = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["switch", "dev"]);
    await git(work, ["merge", "--no-ff", "-q", "feature", "-m", "merge version bump"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const mergedAt = "2026-08-18T00:00:00Z";
    const fetchImpl = async (url) => {
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 30, base: { ref: "dev", sha: eventBefore }, head: { sha: source }, merged_at: mergedAt, merge_commit_sha: head }]);
      }
      if (url.endsWith("/branches/dev/protection/required_status_checks")) {
        return jsonResponse({ strict: false, contexts: ["test"], checks: [] });
      }
      if (url.includes("/actions/runs?") && url.includes("event=pull_request")) {
        return pullRequestWorkflowResponse(url, [{ sha: source, pullNumber: 30 }]);
      }
      if (url.includes(`/commits/${source}/check-runs?per_page=100&page=1`)) {
        return jsonResponse({ check_runs: [{ id: 30, name: "test", head_sha: source, status: "completed", conclusion: "success", created_at: "2026-08-17T23:50:00Z", completed_at: "2026-08-17T23:55:00Z" }] });
      }
      if (url.includes(`/commits/${source}/statuses?per_page=100&page=1`)) {
        return jsonResponse([
          { id: 30, context: "test", state: "success", created_at: "2026-08-17T23:40:00Z", updated_at: "2026-08-17T23:40:00Z" },
          policyReceiptStatus("test", "2026-08-18T00:00:05Z", null, { pullNumber: 30, headSha: source, mergeSha: head, mergedAt, strict: false })
        ]);
      }
      const policyWorkflow = policyWorkflowResponse(url);
      if (policyWorkflow) return policyWorkflow;
      if (url.includes("/commits/") && url.endsWith("/pulls?per_page=100")) return jsonResponse([]);
      throw new Error(`Unexpected behind-target release-tag fetch URL: ${url}`);
    };
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: eventBefore,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: head,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com",
        RELEASE_TAG_DRY_RUN: "1"
      }
    });
    assert.equal(result.status, "planned");
    assert.equal(result.sha, head);
    assert.equal(result.version, "3.4.13");
    assert.equal(result.pullNumber, 30);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catch-up release workflow must belong to the target branch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-workflow-branch-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "version bump"]);
    const bump = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    await writeFile(path.join(work, "README.md"), "follow-up push\n");
    await git(work, ["add", "README.md"]);
    await git(work, ["commit", "-qm", "follow-up"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const fetchImpl = async (url) => {
      const workflowResponse = pullRequestWorkflowResponse(url, [{ sha: head, pullNumber: 72 }, { sha: bump, pullNumber: 71 }]);
      if (workflowResponse) return workflowResponse;
      const policyWorkflow = policyWorkflowResponse(url);
      if (policyWorkflow) return policyWorkflow;
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 72, base: { ref: "dev" }, head: { sha: head }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${bump}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 71, base: { ref: "dev" }, head: { sha: bump }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: bump }]);
      }
      if (url.endsWith("/branches/dev/protection/required_status_checks")) {
        return jsonResponse({ strict: true, contexts: ["test"], checks: [] });
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/check-runs?per_page=100&page=1`)) {
        return jsonResponse({ check_runs: [{ id: 71, name: "test", head_sha: bump, status: "completed", conclusion: "success", created_at: "2026-08-17T23:50:00Z", completed_at: "2026-08-17T23:55:00Z", details_url: "https://github.com/example/repo/actions/runs/71/job/1", app: { slug: "github-actions" } }] });
      }
      if (url.includes(`/repos/example/repo/actions/runs?head_sha=${bump}&event=push&branch=dev&per_page=100&page=1`)) {
        return jsonResponse({ workflow_runs: [{ id: 71, path: ".github/workflows/ci.yml", head_sha: bump, head_branch: "feature/release-test", event: "push", status: "completed", conclusion: "success", created_at: "2026-08-17T23:50:00Z", completed_at: "2026-08-17T23:55:00Z" }] });
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/statuses?per_page=100&page=1`)) {
        return jsonResponse([policyReceiptStatus("test", "2026-08-20T00:50:00Z", null, { pullNumber: 71, headSha: bump, mergeSha: bump, mergedAt: "2026-08-18T00:00:00Z" })]);
      }
      throw new Error(`Unexpected workflow-branch fetch URL: ${url}`);
    };
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: bump,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: head,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /lacks an exact successful test workflow check/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged-version direct push cannot publish an earlier release candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-unmerged-head-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    const writeVersion = async (version) => {
      await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version }));
      await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: `${version}+codex.test` }));
    };
    await writeVersion("3.4.12");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const eventBefore = await git(work, ["rev-parse", "HEAD"]);
    await writeVersion("3.4.13");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "merged version bump"]);
    const bump = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    await writeFile(path.join(work, "README.md"), "direct unchanged-version push\n");
    await git(work, ["add", "README.md"]);
    await git(work, ["commit", "-qm", "direct push"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const fetchImpl = async (url) => {
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) return jsonResponse([]);
      if (url.endsWith(`/repos/example/repo/commits/${bump}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 82, base: { ref: "dev" }, head: { sha: bump }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: bump }]);
      }
      throw new Error(`Unexpected unmerged-head fetch URL: ${url}`);
    };
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: eventBefore,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: head,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com",
        RELEASE_TAG_DRY_RUN: "1"
      }
    });
    assert.deepEqual(result, {
      status: "skipped",
      reason: "commit-is-not-an-exact-merged-pr-result",
      branch: "dev",
      sha: head
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source-unavailable merged PR uses provider-bound source content at final HEAD", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-rebase-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const eventBefore = await git(work, ["rev-parse", "HEAD"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "rebase version bump"]);
    await writeFile(path.join(work, "README.md"), "final rebased commit\n");
    await git(work, ["add", "README.md"]);
    await git(work, ["commit", "-qm", "rebase final commit"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const unavailableSourceSha = "f".repeat(40);
    const providerPackage = Buffer.from(JSON.stringify({ version: "3.4.13" })).toString("base64");
    const providerManifest = Buffer.from(JSON.stringify({ version: "3.4.13+codex.test" })).toString("base64");
    let followUp;
    const fetchImpl = async (url) => {
      if (url.endsWith(`/contents/plugins/better-workflows/package.json?ref=${unavailableSourceSha}`)) {
        return jsonResponse({ type: "file", path: "plugins/better-workflows/package.json", encoding: "base64", content: providerPackage });
      }
      if (url.endsWith(`/contents/plugins/better-workflows/.codex-plugin/plugin.json?ref=${unavailableSourceSha}`)) {
        return jsonResponse({ type: "file", path: "plugins/better-workflows/.codex-plugin/plugin.json", encoding: "base64", content: providerManifest });
      }
      const workflowResponse = pullRequestWorkflowResponse(url, [{ sha: head, pullHeadSha: unavailableSourceSha, pullNumber: 33 }]);
      if (workflowResponse) return workflowResponse;
      const policyWorkflow = policyWorkflowResponse(url);
      if (policyWorkflow) return policyWorkflow;
      if (followUp && url.endsWith(`/repos/example/repo/commits/${followUp}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 34, base: { ref: "dev", sha: head }, head: { sha: followUp }, merged_at: "2026-08-19T00:00:00Z", merge_commit_sha: followUp }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 33, base: { ref: "dev", sha: eventBefore }, head: { sha: unavailableSourceSha }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.includes("/commits/") && url.endsWith("/pulls?per_page=100")) return jsonResponse([]);
      if (url.endsWith("/branches/dev/protection/required_status_checks")) {
        return jsonResponse({ strict: true, contexts: ["lint"], checks: [] });
      }
      if (url.includes(`/commits/${head}/check-runs?per_page=100&page=1`)) {
        return jsonResponse({ check_runs: [
          { id: 33, name: "lint", head_sha: head, status: "completed", conclusion: "success", created_at: "2026-08-17T23:50:00Z", completed_at: "2026-08-17T23:55:00Z" },
          { id: 34, name: "test", head_sha: head, status: "completed", conclusion: "success", created_at: "2026-08-18T00:01:00Z", completed_at: "2026-08-18T00:05:00Z", details_url: "https://github.com/example/repo/actions/runs/33/job/1", app: { slug: "github-actions" } }
        ] });
      }
      if (url.includes(`/actions/runs?head_sha=${head}&event=push&branch=dev&per_page=100&page=1`)) {
        return jsonResponse({ workflow_runs: [{ id: 33, path: ".github/workflows/ci.yml", head_sha: head, head_branch: "dev", event: "push", status: "completed", conclusion: "success", created_at: "2026-08-18T00:01:00Z", completed_at: "2026-08-18T00:06:00Z" }] });
      }
      if (url.includes(`/commits/${unavailableSourceSha}/statuses?per_page=100&page=1`)) {
        return jsonResponse([policyReceiptStatus("lint", "2026-08-20T00:50:00Z", null, { pullNumber: 33, headSha: unavailableSourceSha, mergeSha: head, mergedAt: "2026-08-18T00:00:00Z" })]);
      }
      if (url.includes(`/commits/${head}/statuses?per_page=100&page=1`)) return jsonResponse([policyReceiptStatus("lint", "2026-08-20T00:50:00Z", null, { pullNumber: 33, headSha: head, mergeSha: head, mergedAt: "2026-08-18T00:00:00Z" })]);
      throw new Error(`Unexpected rebase release-tag fetch URL: ${url}`);
    };
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: eventBefore,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: head,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com",
        RELEASE_TAG_DRY_RUN: "1"
      }
    });
    assert.equal(result.status, "planned");
    assert.equal(result.sha, head);
    assert.equal(result.pullNumber, 33);
    assert.equal(result.tag, `v3.4.13-dev.${head.slice(0, 12)}`);
    await writeFile(path.join(work, "README.md"), "later unchanged push\n");
    await git(work, ["add", "README.md"]);
    await git(work, ["commit", "-qm", "later unchanged push"]);
    followUp = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const recovered = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: head,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: followUp,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com",
        RELEASE_TAG_DRY_RUN: "1"
      }
    });
    assert.equal(recovered.status, "planned");
    assert.equal(recovered.sha, head);
    assert.equal(recovered.version, "3.4.13");
    assert.equal(recovered.pullNumber, 33);
    assert.equal(recovered.tag, `v3.4.13-dev.${head.slice(0, 12)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catch-up rejects a direct version bump laundered through an unrelated PR", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-laundered-bump-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "direct version bump"]);
    const bump = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    await writeFile(path.join(work, "README.md"), "unrelated PR\n");
    await git(work, ["add", "README.md"]);
    await git(work, ["commit", "-qm", "unrelated PR"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const unavailableSourceSha = "e".repeat(40);
    const providerPackage = Buffer.from(JSON.stringify({ version: "3.4.12" })).toString("base64");
    const providerManifest = Buffer.from(JSON.stringify({ version: "3.4.12+codex.test" })).toString("base64");
    const fetchImpl = async (url) => {
      if (url.endsWith(`/contents/plugins/better-workflows/package.json?ref=${unavailableSourceSha}`)) {
        return jsonResponse({ type: "file", path: "plugins/better-workflows/package.json", encoding: "base64", content: providerPackage });
      }
      if (url.endsWith(`/contents/plugins/better-workflows/.codex-plugin/plugin.json?ref=${unavailableSourceSha}`)) {
        return jsonResponse({ type: "file", path: "plugins/better-workflows/.codex-plugin/plugin.json", encoding: "base64", content: providerManifest });
      }
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        // The PR branched before the unrelated direct bump; ancestry alone must
        // not make that bump eligible for the later PR.
        return jsonResponse([{ number: 44, base: { ref: "dev", sha: await git(work, ["rev-parse", `${bump}^`]) }, head: { sha: unavailableSourceSha }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${bump}/pulls?per_page=100`)) return jsonResponse([]);
      throw new Error(`Unexpected laundered-bump fetch URL: ${url}`);
    };
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: bump,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: head,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com",
        RELEASE_TAG_DRY_RUN: "1"
      }
    });
    assert.deepEqual(result, {
      status: "skipped",
      reason: "release-version-unchanged",
      branch: "dev",
      sha: head,
      version: "3.4.13"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dev release rejects republishing a stable version at a new commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-duplicate-published-version-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    const writeVersion = async (version) => {
      await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version }));
      await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: `${version}+codex.test` }));
    };
    await writeVersion("3.4.12");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    await writeVersion("3.4.13");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "first 3.4.13 bump"]);
    const firstBump = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const publishedTag = `v3.4.13-dev.${firstBump.slice(0, 12)}`;
    await git(work, ["tag", publishedTag, firstBump]);
    await git(work, ["push", "-q", "origin", `refs/tags/${publishedTag}`]);
    await writeVersion("3.4.12");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "version regression"]);
    const regression = await git(work, ["rev-parse", "HEAD"]);
    await writeVersion("3.4.13");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "restored 3.4.13 bump"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const fetchImpl = async (url) => {
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 52, base: { ref: "dev", sha: regression }, head: { sha: head }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.includes("/pulls?per_page=100")) return jsonResponse([]);
      throw new Error(`Unexpected duplicate-version fetch URL: ${url}`);
    };
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: regression,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: head,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /equals the highest published dev release 3\.4\.13.*expected tag is absent/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release publication rejects duplicate stable versions in one candidate batch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-duplicate-candidates-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    const writeVersion = async (version) => {
      await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version }));
      await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: `${version}+codex.test` }));
    };
    await writeVersion("3.4.12");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const eventBefore = await git(work, ["rev-parse", "HEAD"]);
    await writeVersion("3.4.13");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "first 3.4.13 bump"]);
    const firstBump = await git(work, ["rev-parse", "HEAD"]);
    await writeVersion("3.4.12");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "version regression"]);
    await writeVersion("3.4.13");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "second 3.4.13 bump"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const fetchImpl = async (url) => {
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 54, base: { ref: "dev", sha: eventBefore }, head: { sha: head }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${firstBump}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 53, base: { ref: "dev", sha: eventBefore }, head: { sha: firstBump }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: firstBump }]);
      }
      if (url.includes("/pulls?per_page=100")) return jsonResponse([]);
      throw new Error(`Unexpected duplicate-candidate fetch URL: ${url}`);
    };
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: eventBefore,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: head,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /Stable release version 3\.4\.13 has multiple eligible commits/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release eligibility catches up a version bump after a later non-version push", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-race-") );
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const eventBefore = await git(work, ["rev-parse", "HEAD"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "version bump"]);
    const bump = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    assert.equal(await git(work, ["ls-remote", "origin", `refs/tags/v3.4.13-dev.${bump.slice(0, 12)}`]), "");
    await writeFile(path.join(work, "README.md"), "follow-up push\n");
    await git(work, ["add", "README.md"]);
    await git(work, ["commit", "-qm", "follow-up"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    const graphqlCalls = [];
    let candidateConclusion = "failure";
    let secondPageConclusion = null;
    let secondStatusState = null;
    let candidateAppId = 999;
    let requiredAppId = 123;
    let statusState = "failure";
    const fetchImpl = async (url, options = {}) => {
      const policyWorkflow = policyWorkflowResponse(url);
      if (policyWorkflow) return policyWorkflow;
      const pullWorkflow = pullRequestWorkflowResponse(url, [{ sha: head, pullNumber: 12 }, { sha: bump, pullNumber: 11 }]);
      if (pullWorkflow) return pullWorkflow;
      if (url.endsWith("/graphql")) {
        const request = JSON.parse(options.body);
        graphqlCalls.push(request);
        if (request.query.includes("repository(owner")) return jsonResponse({ data: { repository: { id: "R_123" } } });
        return jsonResponse({ data: { updateRefs: { clientMutationId: null } } });
      }
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 12, base: { ref: "dev" }, head: { sha: head }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${bump}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 11, base: { ref: "dev" }, head: { sha: bump }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: bump }]);
      }
      if (url.endsWith("/branches/dev/protection/required_status_checks")) {
        return jsonResponse({ strict: true, contexts: ["test"], checks: [{ context: "test", app_id: requiredAppId }] });
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/check-runs?per_page=100&page=1`)) {
        return jsonResponse(
          { check_runs: [{ id: 7, name: "test", head_sha: bump, status: "completed", conclusion: candidateConclusion, created_at: "2026-08-14T23:57:00Z", completed_at: "2026-08-14T23:57:00Z", updated_at: "2026-08-14T23:57:00Z", details_url: `https://github.com/example/repo/actions/runs/7/job/70`, app: { id: candidateAppId, slug: "github-actions" } }] },
          true,
          200,
          secondPageConclusion === null ? {} : { link: '<https://api.github.com/repos/example/repo/commits/bump/check-runs?per_page=100&page=2>; rel="next"' }
        );
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/check-runs?per_page=100&page=2`)) {
        return jsonResponse({ check_runs: [
          { id: 8, name: "test", head_sha: bump, status: "completed", conclusion: secondPageConclusion, created_at: "2026-08-14T23:58:00Z", completed_at: "2026-08-14T23:58:00Z", updated_at: "2026-08-14T23:58:00Z", details_url: "https://github.com/example/repo/actions/runs/9/job/90", app: { id: candidateAppId, slug: "github-actions" } },
          { id: 80, name: "test", head_sha: bump, status: "completed", conclusion: "success", created_at: "2026-08-14T23:56:00Z", completed_at: "2026-08-15T00:02:00Z", updated_at: "2026-08-15T00:02:00Z", details_url: "https://github.com/example/repo/actions/runs/8/job/80", app: { id: candidateAppId, slug: "github-actions" } }
        ] });
      }
      if (url.includes(`/repos/example/repo/actions/runs?head_sha=${bump}&event=push&branch=dev&per_page=100&page=1`)) {
        return jsonResponse({ workflow_runs: [
          { id: 7, path: ".github/workflows/ci.yml", head_sha: bump, head_branch: "dev", event: "push", status: "completed", conclusion: "success", created_at: "2026-08-15T00:01:00Z", completed_at: "2026-08-15T00:01:00Z" },
          { id: 8, path: ".github/workflows/ci.yml", head_sha: bump, head_branch: "dev", event: "push", status: "completed", conclusion: "success", created_at: "2026-08-15T00:02:00Z", completed_at: "2026-08-15T00:02:00Z" }
        ] });
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/statuses?per_page=100&page=1`)) {
        return jsonResponse(
          [
            { id: 7, context: "test", state: statusState, created_at: "2026-08-14T23:40:00Z", updated_at: "2026-08-14T23:40:00Z" },
            policyReceiptStatus("test", "2026-08-20T00:50:00Z", requiredAppId, { pullNumber: 11, headSha: bump, mergeSha: bump, mergedAt: "2026-08-15T00:00:00Z" })
          ],
          true,
          200,
          secondStatusState === null ? {} : { link: '<https://api.github.com/repos/example/repo/commits/bump/statuses?per_page=100&page=2>; rel="next"' }
        );
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/statuses?per_page=100&page=2`)) {
        return jsonResponse([{ id: 8, context: "test", state: secondStatusState, created_at: "2026-08-14T23:41:00Z", updated_at: "2026-08-14T23:41:00Z" }]);
      }
      throw new Error(`Unexpected release-tag fetch URL: ${url}`);
    };
    const runEnv = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_BEFORE: bump,
      GITHUB_REF_NAME: "dev",
      GITHUB_REPOSITORY: "example/repo",
      GITHUB_SHA: head,
      GITHUB_TOKEN: "test-token",
      GITHUB_API_URL: "https://api.github.com"
    };
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env: runEnv }),
      /lacks an exact required check or status context/
    );
    candidateAppId = requiredAppId;
    statusState = "failure";
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env: runEnv }),
      /all exact required checks and statuses to complete successfully/
    );
    candidateConclusion = "success";
    secondPageConclusion = "failure";
    secondStatusState = "success";
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env: runEnv }),
      /all exact required checks and statuses to complete successfully/
    );
    secondPageConclusion = "success";
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env: runEnv
    });
    const { mergeTimeReceipt, ...requiredChecksWithoutReceipt } = result.requiredChecks;
    assert.deepEqual({ ...result, requiredChecks: requiredChecksWithoutReceipt }, {
      status: "created",
      tag: `v3.4.13-dev.${bump.slice(0, 12)}`,
      branch: "dev",
      sha: bump,
      version: "3.4.13",
      pullNumber: 11,
      requiredChecks: {
        headSha: bump,
        requiredRequirements: [{ context: "test", appId: 123, strict: true }],
        checkRuns: [
          { id: "8", name: "test", status: "completed", conclusion: "success" }
        ],
        statuses: [],
        requiredContexts: ["test"]
      }
    });
    assert.deepEqual(mergeTimeReceipt, {
      schemaVersion: 1,
      kind: "merge-time-required-checks-v1",
      headSha: bump,
      preMergeSha: bump,
      testedSha: bump,
      pullNumber: 11,
      mergeCommitSha: bump,
      mergedAt: "2026-08-15T00:00:00.000Z",
      requiredRequirements: [{ context: "test", appId: 123, strict: true }],
      requiredCheckPolicyDigest: "131729412bee25f687b37852637c8a4c18b148a2b3b55fd7133af1a128056c24",
      checkRuns: [{ id: "8", name: "test", status: "completed", conclusion: "success", recordedAt: "2026-08-14T23:58:00.000Z" }],
      statuses: [],
      policyReceipt: {
        context: "better-workflows/release-policy-v1",
        state: "success",
        description: "better-workflows-policy-v1:131729412bee25f687b37852637c8a4c18b148a2b3b55fd7133af1a128056c24",
        publisher: "github-actions[bot]",
        workflowRunId: "8",
        recordedAt: "2026-08-14T23:50:00.000Z",
        workflowRecordedAt: "2026-08-14T23:30:00.000Z"
      },
      preMergeWorkflow: {
        runId: "911",
        event: "pull_request",
        headSha: bump,
        conclusion: "success",
        recordedAt: "2026-08-14T23:55:00.000Z"
      },
      workflow: {
        runId: "8",
        runConclusion: "success",
        runRecordedAt: "2026-08-15T00:02:00.000Z",
        checkId: "80",
        checkConclusion: "success",
        checkRecordedAt: "2026-08-15T00:02:00.000Z"
      }
    });
    assert.equal(graphqlCalls.length, 2);
    assert.deepEqual(graphqlCalls[1].variables.refUpdates, [
      { name: "refs/heads/dev", beforeOid: head, afterOid: head, force: false },
      { name: `refs/tags/v3.4.13-dev.${bump.slice(0, 12)}`, beforeOid: "0".repeat(40), afterOid: bump, force: false }
    ]);
    await writeFile(path.join(work, "README-2.md"), "unchanged version\n");
    await git(work, ["add", "README-2.md"]);
    await git(work, ["commit", "-qm", "unchanged version"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const unchangedHead = await git(work, ["rev-parse", "HEAD"]);
    const unchangedFetch = async (url) => {
      const policyWorkflow = policyWorkflowResponse(url);
      if (policyWorkflow) return policyWorkflow;
      const pullWorkflow = pullRequestWorkflowResponse(url, [
        { sha: unchangedHead, pullNumber: 13 },
        { sha: head, pullNumber: 12 },
        { sha: bump, pullNumber: 11 }
      ]);
      if (pullWorkflow) return pullWorkflow;
      if (url.endsWith(`/repos/example/repo/commits/${unchangedHead}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 13, base: { ref: "dev" }, head: { sha: unchangedHead }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: unchangedHead }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 12, base: { ref: "dev" }, head: { sha: head }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${bump}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 11, base: { ref: "dev" }, head: { sha: bump }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: bump }]);
      }
      if (url.endsWith("/branches/dev/protection/required_status_checks")) {
        return jsonResponse({ strict: true, contexts: ["test"], checks: [{ context: "test", app_id: 123 }] });
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/check-runs?per_page=100&page=1`)) {
        return jsonResponse({ check_runs: [
          { id: 7, name: "test", head_sha: bump, status: "completed", conclusion: "success", created_at: "2026-08-14T23:57:00Z", completed_at: "2026-08-14T23:57:00Z", updated_at: "2026-08-14T23:57:00Z", details_url: "https://github.com/example/repo/actions/runs/9/job/90", app: { id: 123, slug: "github-actions" } },
          { id: 80, name: "test", head_sha: bump, status: "completed", conclusion: "success", created_at: "2026-08-14T23:56:00Z", completed_at: "2026-08-15T00:01:00Z", updated_at: "2026-08-15T00:01:00Z", details_url: "https://github.com/example/repo/actions/runs/7/job/70", app: { id: 123, slug: "github-actions" } }
        ] });
      }
      if (url.includes(`/repos/example/repo/actions/runs?head_sha=${bump}&event=push&branch=dev&per_page=100&page=1`)) {
        return jsonResponse({ workflow_runs: [{ id: 7, path: ".github/workflows/ci.yml", head_sha: bump, head_branch: "dev", event: "push", status: "completed", conclusion: "success", created_at: "2026-08-15T00:01:00Z", completed_at: "2026-08-15T00:01:00Z" }] });
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/statuses?per_page=100&page=1`)) {
        return jsonResponse([
          { id: 7, context: "test", state: "failure", created_at: "2026-08-14T23:40:00Z", updated_at: "2026-08-14T23:40:00Z" },
          policyReceiptStatus("test", "2026-08-20T00:50:00Z", 123, { pullNumber: 11, headSha: bump, mergeSha: bump, mergedAt: "2026-08-15T00:00:00Z" })
        ]);
      }
      throw new Error(`Unexpected unchanged release-tag fetch URL: ${url}`);
    };
    const skipped = await runReleaseTag({
      cwd: work,
      fetchImpl: unchangedFetch,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: head,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: unchangedHead,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com",
        RELEASE_TAG_DRY_RUN: "1"
      }
    });
    const { mergeTimeReceipt: skippedReceipt, ...skippedChecksWithoutReceipt } = skipped.requiredChecks;
    assert.deepEqual({ ...skipped, requiredChecks: skippedChecksWithoutReceipt }, {
      status: "planned",
      tag: `v3.4.13-dev.${bump.slice(0, 12)}`,
      branch: "dev",
      sha: bump,
      version: "3.4.13",
      pullNumber: 11,
      requiredChecks: {
        headSha: bump,
        requiredRequirements: [{ context: "test", appId: 123, strict: true }],
        checkRuns: [{ id: "7", name: "test", status: "completed", conclusion: "success" }],
        statuses: [],
        requiredContexts: ["test"]
      }
    });
    assert.equal(skippedReceipt.kind, "merge-time-required-checks-v1");
    assert.equal(skippedReceipt.pullNumber, 11);
    await git(work, ["tag", "v3.4.14-dev.aaaaaaaaaaaa", bump]);
    await git(work, ["push", "-q", "origin", "refs/tags/v3.4.14-dev.aaaaaaaaaaaa"]);
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl: unchangedFetch,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: head,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: unchangedHead,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /below the highest published dev release 3\.4\.14/
    );
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.14" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.14+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "higher version"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "version regression"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const regressedHead = await git(work, ["rev-parse", "HEAD"]);
    const regressionFetch = async (url) => {
      if (url.endsWith(`/repos/example/repo/commits/${regressedHead}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 14, base: { ref: "dev" }, head: { sha: regressedHead }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: regressedHead }]);
      }
      throw new Error(`Unexpected regression release-tag fetch URL: ${url}`);
    };
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl: regressionFetch,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: unchangedHead,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: regressedHead,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /history contains 3\.4\.14 above current 3\.4\.13/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catch-up fails closed when version surfaces are deleted and restored", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-surface-discontinuity-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const packagePath = path.join(work, "plugins/better-workflows/package.json");
  const pluginPath = path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.dirname(pluginPath), { recursive: true });
    await writeFile(packagePath, JSON.stringify({ version: "3.4.12" }));
    await writeFile(pluginPath, JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    await writeFile(packagePath, JSON.stringify({ version: "3.4.13" }));
    await writeFile(pluginPath, JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "version bump"]);
    await rm(pluginPath, { force: true });
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "delete version surface"]);
    await writeFile(pluginPath, JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "restore version surface"]);
    const eventBefore = await git(work, ["rev-parse", "HEAD"]);
    await writeFile(path.join(work, "README.md"), "unchanged release surface\n");
    await git(work, ["add", "README.md"]);
    await git(work, ["commit", "-qm", "unchanged push"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl: async (url) => {
          if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) return jsonResponse([]);
          throw new Error(`Unexpected surface-discontinuity fetch URL: ${url}`);
        },
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: eventBefore,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: head,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /version surfaces are missing at historical parent/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("consecutive version bumps are recovered in one atomic batch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-consecutive-bumps-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    const writeVersion = async (version) => {
      await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version }));
      await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: `${version}+codex.test` }));
    };
    await writeVersion("3.4.12");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const eventBefore = await git(work, ["rev-parse", "HEAD"]);
    await writeVersion("3.4.13");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "release 3.4.13"]);
    const bump13 = await git(work, ["rev-parse", "HEAD"]);
    await writeVersion("3.4.14");
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "release 3.4.14"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);

    let mutationCalls = 0;
    let mutationUpdates = null;
    const fetchImpl = async (url, options = {}) => {
      const policyWorkflow = policyWorkflowResponse(url);
      if (policyWorkflow) return policyWorkflow;
      const pullWorkflow = pullRequestWorkflowResponse(url, [{ sha: head, pullNumber: 14 }, { sha: bump13, pullNumber: 13 }]);
      if (pullWorkflow) return pullWorkflow;
      if (url.endsWith("/graphql")) {
        const request = JSON.parse(options.body);
        if (request.query.includes("repository(owner")) return jsonResponse({ data: { repository: { id: "R_123" } } });
        mutationCalls += 1;
        mutationUpdates = request.variables.refUpdates;
        for (const update of mutationUpdates.filter(({ name }) => name.startsWith("refs/tags/"))) {
          await git(bare, ["update-ref", update.name, update.afterOid]);
        }
        return jsonResponse({ data: { updateRefs: { clientMutationId: null } } });
      }
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 14, base: { ref: "dev", sha: eventBefore }, head: { sha: head }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${bump13}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 13, base: { ref: "dev" }, head: { sha: bump13 }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: bump13 }]);
      }
      if (url.endsWith("/branches/dev/protection/required_status_checks")) {
        return jsonResponse({ strict: true, contexts: ["lint"], checks: [] });
      }
      for (const sha of [bump13, head]) {
        if (url.includes(`/commits/${sha}/check-runs?per_page=100&page=1`)) {
          const checkRuns = [{ id: sha === bump13 ? 13 : 14, name: "lint", head_sha: sha, status: "completed", conclusion: "success", created_at: "2026-08-17T23:56:00Z", completed_at: "2026-08-17T23:57:00Z", updated_at: "2026-08-17T23:57:00Z" }];
          if (sha === bump13) {
            checkRuns.push({ id: 101, name: "test", head_sha: sha, status: "completed", conclusion: "success", created_at: "2026-08-17T23:59:00Z", completed_at: "2026-08-18T00:01:00Z", updated_at: "2026-08-18T00:01:00Z", details_url: "https://github.com/example/repo/actions/runs/101/job/1", app: { slug: "github-actions" } });
          }
          return jsonResponse({ check_runs: checkRuns });
        }
        if (url.includes(`/commits/${sha}/statuses?per_page=100&page=1`)) {
          return jsonResponse([policyReceiptStatus("lint", "2026-08-20T00:50:00Z", null, { pullNumber: sha === bump13 ? 13 : 14, headSha: sha, mergeSha: sha, mergedAt: "2026-08-18T00:00:00Z" })]);
        }
      }
      if (url.includes(`/actions/runs?head_sha=${bump13}&event=push&branch=dev&per_page=100&page=1`)) {
        return jsonResponse({ workflow_runs: [{ id: 101, path: ".github/workflows/ci.yml", head_sha: bump13, head_branch: "dev", event: "push", status: "completed", conclusion: "success", created_at: "2026-08-18T00:01:00Z", completed_at: "2026-08-18T00:01:00Z" }] });
      }
      throw new Error(`Unexpected consecutive-bump fetch URL: ${url}`);
    };
    const env = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_BEFORE: eventBefore,
      GITHUB_REF_NAME: "dev",
      GITHUB_REPOSITORY: "example/repo",
      GITHUB_SHA: head,
      GITHUB_TOKEN: "test-token",
      GITHUB_API_URL: "https://api.github.com"
    };
    const result = await runReleaseTag({ cwd: work, fetchImpl, env });
    assert.deepEqual(result.tags, [
      { tag: `v3.4.13-dev.${bump13.slice(0, 12)}`, sha: bump13, version: "3.4.13" },
      { tag: `v3.4.14-dev.${head.slice(0, 12)}`, sha: head, version: "3.4.14" }
    ]);
    assert.equal(result.requiredChecks.mergeTimeReceipt.kind, "merge-time-required-checks-v1");
    assert.equal(result.requiredChecks.mergeTimeReceipt.mergeCommitSha, bump13);
    assert.equal(result.requiredChecks.mergeTimeReceipt.requiredCheckPolicyDigest,
      "771bf6ad20392f2d828f9713244ee45b2f8a5d196f116fa8ac18c678769fde52");
    assert.equal(mutationCalls, 1);
    assert.deepEqual(mutationUpdates, [
      { name: "refs/heads/dev", beforeOid: head, afterOid: head, force: false },
      { name: `refs/tags/v3.4.13-dev.${bump13.slice(0, 12)}`, beforeOid: "0".repeat(40), afterOid: bump13, force: false },
      { name: `refs/tags/v3.4.14-dev.${head.slice(0, 12)}`, beforeOid: "0".repeat(40), afterOid: head, force: false }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catch-up history exhaustion fails closed instead of silently skipping an old bump", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-history-boundary-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "version bump"]);
    const bump = await git(work, ["rev-parse", "HEAD"]);
    for (let index = 0; index < 129; index += 1) {
      await git(work, ["commit", "--allow-empty", "-qm", `follow-up ${index + 1}`]);
    }
    await git(work, ["push", "-q", "origin", "dev"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    const fetchImpl = async (url) => {
      const policyWorkflow = policyWorkflowResponse(url);
      if (policyWorkflow) return policyWorkflow;
      const pullWorkflow = pullRequestWorkflowResponse(url, [{ sha: head, pullNumber: 32 }]);
      if (pullWorkflow) return pullWorkflow;
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 31, base: { ref: "dev" }, head: { sha: head }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.includes("/commits/") && url.endsWith("/pulls?per_page=100")) return jsonResponse([]);
      throw new Error(`Unexpected release-tag fetch URL: ${url}`);
    };
    await assert.rejects(
      runReleaseTag({
        cwd: work,
        fetchImpl,
        env: {
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_BEFORE: bump,
          GITHUB_REF_NAME: "dev",
          GITHUB_REPOSITORY: "example/repo",
          GITHUB_SHA: head,
          GITHUB_TOKEN: "test-token",
          GITHUB_API_URL: "https://api.github.com",
          RELEASE_TAG_DRY_RUN: "1"
        }
      }),
      /history exceeded bounded first-parent search of 128 commits/
    );
    assert.notEqual(bump, head);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exact HEAD version bump remains eligible past the catch-up history bound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-head-history-boundary-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const tree = await git(work, ["rev-parse", "HEAD^{tree}"]);
    let historyTip = await git(work, ["rev-parse", "HEAD"]);
    for (let index = 0; index < 130; index += 1) {
      historyTip = await git(work, ["commit-tree", tree, "-p", historyTip, "-m", `history ${index + 1}`]);
    }
    await git(work, ["update-ref", "refs/heads/dev", historyTip]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const eventBefore = historyTip;
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "fresh release after long history"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const fetchImpl = async (url) => {
      const policyWorkflow = policyWorkflowResponse(url);
      if (policyWorkflow) return policyWorkflow;
      const pullWorkflow = pullRequestWorkflowResponse(url, [{ sha: head, pullNumber: 32 }]);
      if (pullWorkflow) return pullWorkflow;
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 32, base: { ref: "dev", sha: eventBefore }, head: { sha: head }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.endsWith("/branches/dev/protection/required_status_checks")) {
        return jsonResponse({ strict: true, contexts: ["lint"], checks: [] });
      }
      if (url.includes(`/commits/${head}/check-runs?per_page=100&page=1`)) {
        return jsonResponse({ check_runs: [{ id: 32, name: "lint", head_sha: head, status: "completed", conclusion: "success", created_at: "2026-08-17T23:54:00Z", completed_at: "2026-08-17T23:55:00Z" }] });
      }
      if (url.includes(`/commits/${head}/statuses?per_page=100&page=1`)) return jsonResponse([policyReceiptStatus("lint", "2026-08-20T00:50:00Z", null, { pullNumber: 32, headSha: head, mergeSha: head, mergedAt: "2026-08-18T00:00:00Z" })]);
      if (url.includes("/commits/") && url.endsWith("/pulls?per_page=100")) return jsonResponse([]);
      throw new Error(`Unexpected long-history fetch URL: ${url}`);
    };
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: eventBefore,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: head,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com",
        RELEASE_TAG_DRY_RUN: "1"
      }
    });
    assert.equal(result.status, "planned");
    assert.equal(result.sha, head);
    assert.equal(result.tag, `v3.4.13-dev.${head.slice(0, 12)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the exact catch-up history boundary returns a deterministic no-op", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-root-boundary-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "root"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const tree = await git(work, ["rev-parse", "HEAD^{tree}"]);
    let head = await git(work, ["rev-parse", "HEAD"]);
    for (let index = 0; index < 127; index += 1) {
      head = await git(work, ["commit-tree", tree, "-p", head, "-m", `history ${index + 1}`]);
    }
    await git(work, ["update-ref", "refs/heads/dev", head]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const reconciledTag = `v3.4.12-dev.${head.slice(0, 12)}`;
    await git(work, ["tag", reconciledTag, head]);
    await git(work, ["push", "-q", "origin", `refs/tags/${reconciledTag}`]);
    const eventBefore = await git(work, ["rev-parse", "HEAD^1"]);
    const fetchImpl = async (url) => {
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 34, base: { ref: "dev" }, head: { sha: head }, merged_at: "2026-08-18T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.includes("/commits/") && url.endsWith("/pulls?per_page=100")) return jsonResponse([]);
      throw new Error(`Unexpected root-boundary fetch URL: ${url}`);
    };
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env: {
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_BEFORE: eventBefore,
        GITHUB_REF_NAME: "dev",
        GITHUB_REPOSITORY: "example/repo",
        GITHUB_SHA: head,
        GITHUB_TOKEN: "test-token",
        GITHUB_API_URL: "https://api.github.com",
        RELEASE_TAG_DRY_RUN: "1"
      }
    });
    assert.deepEqual(result, {
      status: "skipped",
      reason: "release-version-unchanged",
      branch: "dev",
      sha: head,
      version: "3.4.12"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catch-up publication requires the exact workflow test check on the release SHA", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-release-tag-workflow-test-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  try {
    await execFileAsync("git", ["init", "--bare", "-q", bare]);
    await execFileAsync("git", ["init", "-q", work]);
    await git(work, ["config", "user.email", "test@example.invalid"]);
    await git(work, ["config", "user.name", "release-test"]);
    await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
    await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.12+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "base"]);
    await git(work, ["branch", "-M", "dev"]);
    await git(work, ["remote", "add", "origin", bare]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const eventBefore = await git(work, ["rev-parse", "HEAD"]);
    await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
    await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
    await git(work, ["add", "."]);
    await git(work, ["commit", "-qm", "version bump"]);
    const bump = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    await writeFile(path.join(work, "README.md"), "follow-up push\n");
    await git(work, ["add", "README.md"]);
    await git(work, ["commit", "-qm", "follow-up"]);
    await git(work, ["push", "-q", "origin", "dev"]);
    const head = await git(work, ["rev-parse", "HEAD"]);
    let includeWorkflowTest = false;
    let workflowTestSlug = "untrusted-app";
    let delayedRequiredCheck = false;
    let requiredPolls = 0;
    let workflowScenario = "single";
    const fetchImpl = async (url) => {
      const policyWorkflow = policyWorkflowResponse(url);
      if (policyWorkflow) return policyWorkflow;
      const pullWorkflow = pullRequestWorkflowResponse(url, [{ sha: head, pullNumber: 22 }, { sha: bump, pullNumber: 21 }]);
      if (pullWorkflow) return pullWorkflow;
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 22, base: { ref: "dev" }, head: { sha: head }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${bump}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 21, base: { ref: "dev" }, head: { sha: bump }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: bump }]);
      }
      if (url.endsWith("/branches/dev/protection/required_status_checks")) {
        return jsonResponse({ strict: true, contexts: ["lint"], checks: [] });
      }
      if (url.includes(`/commits/${bump}/check-runs?per_page=100&page=1`)) {
        const requiredReady = !delayedRequiredCheck || requiredPolls++ >= 10;
        const checkRuns = requiredReady
          ? [{ id: 1, name: "lint", head_sha: bump, status: "completed", conclusion: "success", created_at: "2026-08-14T23:50:00Z", completed_at: "2026-08-14T23:55:00Z", updated_at: "2026-08-14T23:55:00Z" }]
          : [];
        if (includeWorkflowTest && requiredReady) {
          checkRuns.push({ id: 2, name: "test", head_sha: bump, status: "completed", conclusion: "success", created_at: "2026-08-15T00:01:00Z", completed_at: "2026-08-20T00:05:00Z", details_url: `https://github.com/example/repo/actions/runs/2/job/20`, app: { slug: workflowTestSlug } });
          if (workflowScenario === "old-success-new-failure") {
            checkRuns.push({ id: 3, name: "test", head_sha: bump, status: "completed", conclusion: "failure", created_at: "2026-08-18T00:01:00Z", completed_at: "2026-08-19T00:05:00Z", details_url: `https://github.com/example/repo/actions/runs/3/job/30`, app: { slug: workflowTestSlug } });
          } else if (workflowScenario === "old-success-new-pending") {
            checkRuns.push({ id: 3, name: "test", head_sha: bump, status: "in_progress", conclusion: null, created_at: "2026-08-18T00:01:00Z", details_url: `https://github.com/example/repo/actions/runs/3/job/30`, app: { slug: workflowTestSlug } });
          }
        }
        return jsonResponse({ check_runs: checkRuns });
      }
      if (url.includes(`/repos/example/repo/actions/runs?head_sha=${bump}&event=push&branch=dev&per_page=100&page=1`)) {
        const workflowRuns = [{ id: 2, path: ".github/workflows/ci.yml", head_sha: bump, head_branch: "dev", event: "push", status: "completed", conclusion: "success", created_at: "2026-08-15T00:01:00Z", completed_at: "2026-08-20T00:05:00Z" }];
        if (workflowScenario === "integration-tag-failure") {
          workflowRuns[0].conclusion = "failure";
        } else if (workflowScenario === "old-success-new-failure") {
          workflowRuns.push({ id: 3, path: ".github/workflows/ci.yml", head_sha: bump, head_branch: "dev", event: "push", status: "completed", conclusion: "failure", created_at: "2026-08-18T00:01:00Z", completed_at: "2026-08-19T00:05:00Z" });
        } else if (workflowScenario === "old-success-new-pending") {
          workflowRuns.push({ id: 3, path: ".github/workflows/ci.yml", head_sha: bump, head_branch: "dev", event: "push", status: "in_progress", conclusion: null, created_at: "2026-08-18T00:01:00Z" });
        } else if (workflowScenario === "old-success-new-unlinked-pending") {
          workflowRuns.push({ id: 3, path: ".github/workflows/ci.yml", head_sha: bump, head_branch: "dev", event: "push", status: "in_progress", conclusion: null, created_at: "2026-08-18T00:01:00Z" });
        }
        return jsonResponse({ workflow_runs: workflowRuns });
      }
      if (url.includes(`/commits/${bump}/statuses?per_page=100&page=1`)) {
        return jsonResponse([{ ...policyReceiptStatus("lint", "2026-08-20T00:50:00Z", null, { pullNumber: 21, headSha: bump, mergeSha: bump, mergedAt: "2026-08-15T00:00:00Z" }), id: 90 }]);
      }
      throw new Error(`Unexpected release-tag fetch URL: ${url}`);
    };
    const env = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_BEFORE: bump,
      GITHUB_REF_NAME: "dev",
      GITHUB_REPOSITORY: "example/repo",
      GITHUB_SHA: head,
      GITHUB_TOKEN: "test-token",
      GITHUB_API_URL: "https://api.github.com",
      RELEASE_TAG_DRY_RUN: "1"
    };
    await assert.rejects(
      runReleaseTag({ cwd: work, fetchImpl, env, sleepImpl: async () => {} }),
      /lacks an exact successful test workflow check/
    );
    includeWorkflowTest = true;
    for (const scenario of ["old-success-new-failure", "old-success-new-pending"]) {
      workflowScenario = scenario;
      requiredPolls = 0;
      await assert.rejects(
        runReleaseTag({ cwd: work, fetchImpl, env, sleepImpl: async () => {} }),
        /lacks an exact successful test workflow check/
      );
    }
    workflowScenario = "integration-tag-failure";
    workflowTestSlug = "github-actions";
    requiredPolls = 0;
    const catchUp = await runReleaseTag({ cwd: work, fetchImpl, env, sleepImpl: async () => {} });
    assert.equal(catchUp.status, "planned");
    assert.equal(catchUp.version, "3.4.13");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release parent version surfaces fail closed for missing and malformed files", async () => {
  for (const scenario of ["missing", "malformed"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `sbw-release-tag-parent-${scenario}-`));
    const bare = path.join(root, "origin.git");
    const work = path.join(root, "work");
    try {
      await execFileAsync("git", ["init", "--bare", "-q", bare]);
      await execFileAsync("git", ["init", "-q", work]);
      await git(work, ["config", "user.email", "test@example.invalid"]);
      await git(work, ["config", "user.name", "release-test"]);
      await mkdir(path.join(work, "plugins/better-workflows/.codex-plugin"), { recursive: true });
      await mkdir(path.join(work, "plugins/better-workflows"), { recursive: true });
      await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.12" }));
      if (scenario === "malformed") {
        await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), "{\n");
      }
      await git(work, ["add", "."]);
      await git(work, ["commit", "-qm", `${scenario} parent`]);
      await git(work, ["branch", "-M", "dev"]);
      await git(work, ["remote", "add", "origin", bare]);
      await git(work, ["push", "-q", "origin", "dev"]);
      const eventBefore = await git(work, ["rev-parse", "HEAD"]);
      await writeFile(path.join(work, "plugins/better-workflows/package.json"), JSON.stringify({ version: "3.4.13" }));
      await writeFile(path.join(work, "plugins/better-workflows/.codex-plugin/plugin.json"), JSON.stringify({ version: "3.4.13+codex.test" }));
      await git(work, ["add", "."]);
      await git(work, ["commit", "-qm", "release"]);
      await git(work, ["push", "-q", "origin", "dev"]);
      const head = await git(work, ["rev-parse", "HEAD"]);
      const fetchImpl = async (url) => {
        if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
          return jsonResponse([{ number: 10, base: { ref: "dev" }, head: { sha: head }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: head }]);
        }
        throw new Error(`Unexpected release-tag fetch URL: ${url}`);
      };
      await assert.rejects(
        runReleaseTag({
          cwd: work,
          fetchImpl,
          env: {
            GITHUB_EVENT_NAME: "push",
            GITHUB_EVENT_BEFORE: eventBefore,
            GITHUB_REF_NAME: "dev",
            GITHUB_REPOSITORY: "example/repo",
            GITHUB_SHA: head,
            GITHUB_TOKEN: "test-token",
            GITHUB_API_URL: "https://api.github.com",
            RELEASE_TAG_DRY_RUN: "1"
          }
        }),
        scenario === "missing" ? /Parent release version surfaces are incomplete/ : /Expected property name/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
