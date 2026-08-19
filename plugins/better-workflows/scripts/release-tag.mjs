import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import {
  assertCommitSha,
  compareStableVersions,
  findMergedPullRequest,
  isReleaseBranch,
  parseRemoteTagCommit,
  releaseTagName,
  releaseTagAtomicMutation,
  releaseTagParentRevision,
  versionChanged,
  versionSurfaces
} from "./lib/release-tag.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY_PACKAGE = "plugins/better-workflows/package.json";
const PLUGIN_MANIFEST = "plugins/better-workflows/.codex-plugin/plugin.json";
const RELEASE_WORKFLOW_TEST_CONTEXT = "test";
const RELEASE_WORKFLOW_TEST_APP_SLUG = "github-actions";
const RELEASE_WORKFLOW_FILE = ".github/workflows/ci.yml";
const RELEASE_POLICY_RECONCILIATION_WORKFLOW_FILE = ".github/workflows/release-policy-reconcile.yml";
const RELEASE_POLICY_RECEIPT_CONTEXT = "better-workflows/release-policy-v1";
const RELEASE_POLICY_RECEIPT_PREFIX = "better-workflows-policy-v1:";
const RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT = "pull_request_target";
const RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT = "workflow_run";
const RELEASE_POLICY_RECEIPT_ARTIFACT_NAME = "better-workflows-release-policy-receipt";
const RELEASE_POLICY_RECEIPT_ARTIFACT_FILE = "release-policy-receipt.json";
const RELEASE_POLICY_RECEIPT_ARTIFACT_KIND = "better-workflows/release-policy-receipt-v2";
const RELEASE_POLICY_RECEIPT_PREMERGE_ACTIONS = ["opened", "reopened", "synchronize"];
const RELEASE_POLICY_RECEIPT_MERGE_ACTION = "closed";
const CATCH_UP_HISTORY_LIMIT = 128;
const CATCH_UP_ARTIFACT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const REQUIRED_CHECK_POLL_ATTEMPTS = 31;
const REQUIRED_CHECK_POLL_DELAY_MS = 10_000;

class PendingPolicyReceiptArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = "PendingPolicyReceiptArtifactError";
  }
}

async function git(cwd, args) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 2 * 1024 * 1024
    });
    return result.stdout.trim();
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || "git command failed").trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readJsonAtCommit(cwd, revision, relativePath) {
  try {
    const raw = await git(cwd, ["show", `${revision}:${relativePath}`]);
    return JSON.parse(raw);
  } catch (error) {
    if (/(?:does not exist in|exists on disk, but not in)/.test(String(error.message))) return null;
    throw error;
  }
}

export async function repositoryPullRequests({ apiUrl, repository, sha, token, fetchImpl = fetch }) {
  const endpoint = `${apiUrl.replace(/\/$/, "")}/repos/${repository}/commits/${sha}/pulls?per_page=100`;
  const response = await fetchImpl(endpoint, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "better-workflows-release-tag"
    }
  });
  if (!response.ok) throw new Error(`GitHub associated-PR query failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("GitHub associated-PR query returned a non-array payload");
  if (payload.length >= 100) {
    throw new Error("GitHub associated-PR query returned a full first page; refusing incomplete PR association");
  }
  return payload;
}

async function pagedGitHubCollection({ apiUrl, pathName, key, token, fetchImpl = fetch, label }) {
  const records = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = pathName.includes("?") ? "&" : "?";
    const endpoint = `${apiUrl.replace(/\/$/, "")}${pathName}${separator}per_page=100&page=${page}`;
    const response = await fetchImpl(endpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "better-workflows-release-tag"
      }
    });
    if (!response.ok) throw new Error(`GitHub ${label} query failed with HTTP ${response.status}`);
    const payload = await response.json();
    const pageRecords = key === null ? payload : payload?.[key];
    if (!Array.isArray(pageRecords)) {
      throw new Error(`GitHub ${label} query returned no ${key ?? "top-level"} array`);
    }
    records.push(...pageRecords);
    const link = typeof response.headers?.get === "function" ? response.headers.get("link") ?? "" : "";
    if (/<[^>]+[?&]page=\d+[^>]*>;\s*rel="next"/.test(link)) continue;
    if (pageRecords.length < 100) return records;
  }
  throw new Error(`GitHub ${label} pagination exceeded the bounded page limit`);
}

async function repositoryCheckRuns({ apiUrl, repository, sha, token, fetchImpl = fetch }) {
  return pagedGitHubCollection({
    apiUrl,
    pathName: `/repos/${repository}/commits/${sha}/check-runs`,
    key: "check_runs",
    token,
    fetchImpl,
    label: "exact release check"
  });
}

async function repositoryWorkflowRuns({ apiUrl, repository, branch = null, sha = null, event = "push", createdFilter = null, token, fetchImpl = fetch }) {
  const query = new URLSearchParams();
  if (sha) query.set("head_sha", sha);
  query.set("event", event);
  if (branch) query.set("branch", branch);
  if (createdFilter) query.set("created", createdFilter);
  return pagedGitHubCollection({
    apiUrl,
    pathName: `/repos/${repository}/actions/runs?${query.toString()}`,
    key: "workflow_runs",
    token,
    fetchImpl,
    label: "exact release workflow"
  });
}

async function repositoryWorkflowRun({ apiUrl, repository, runId, token, fetchImpl = fetch }) {
  const endpoint = `${apiUrl.replace(/\/$/, "")}/repos/${repository}/actions/runs/${encodeURIComponent(runId)}`;
  const response = await fetchImpl(endpoint, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "better-workflows-release-tag"
    }
  });
  if (!response.ok) throw new Error(`GitHub release policy workflow query failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("GitHub release policy workflow query returned an invalid payload");
  }
  return payload;
}

async function repositoryWorkflowArtifacts({ apiUrl, repository, runId, token, fetchImpl = fetch }) {
  return pagedGitHubCollection({
    apiUrl,
    pathName: `/repos/${repository}/actions/runs/${encodeURIComponent(runId)}/artifacts`,
    key: "artifacts",
    token,
    fetchImpl,
    label: "release policy artifact"
  });
}

function readZipJsonEntry(archive, filename) {
  const buffer = Buffer.isBuffer(archive) ? archive : Buffer.from(archive);
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  let offset = 0;
  while (offset + 46 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== centralSignature) {
      offset += 1;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (name === filename) {
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== localSignature) {
        throw new Error("Release policy artifact has an invalid local ZIP header");
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > buffer.length || uncompressedSize > 128 * 1024) {
        throw new Error("Release policy artifact entry exceeds its bounded size");
      }
      const compressed = buffer.subarray(dataStart, dataEnd);
      let contents;
      if (method === 0) contents = compressed;
      else if (method === 8) contents = inflateRawSync(compressed);
      else throw new Error("Release policy artifact uses an unsupported ZIP compression method");
      if (contents.length !== uncompressedSize) throw new Error("Release policy artifact has an invalid uncompressed size");
      return JSON.parse(contents.toString("utf8"));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Release policy artifact is missing ${filename}`);
}

function normalizePolicyReceiptRequirements(policy) {
  if (!Array.isArray(policy) || policy.length === 0) throw new Error("policy artifact requires non-empty requirements");
  const entries = policy.map((item) => {
    if (!item || typeof item.context !== "string" || !item.context ||
        (item.appId !== null && (!Number.isInteger(item.appId) || item.appId < 0)) ||
        typeof item.strict !== "boolean") {
      throw new Error("policy artifact contains an invalid requirement");
    }
    return { context: item.context, appId: item.appId, strict: item.strict };
  });
  const unique = new Map(entries.map((item) => [`${item.context}\u0000${item.appId ?? "*"}`, item]));
  return [...unique.values()].sort((left, right) => (
    `${left.context}:${left.appId ?? ""}`.localeCompare(`${right.context}:${right.appId ?? ""}`)
  ));
}

export function assertPolicyReceiptArtifact(payload, {
  repository,
  branch,
  runId,
  pullNumber,
  preMergeSha,
  requiredPolicyDigest,
  mergeTimeMs,
  phase = "pre-merge",
  mergeCommitSha = null,
  expectedEventName = null,
  triggerWorkflowRunId = null,
  allowPostMergeObservation = false
}) {
  let computedPolicyDigest = null;
  let normalizedPolicy = null;
  try {
    normalizedPolicy = normalizePolicyReceiptRequirements(payload?.policy);
    computedPolicyDigest = createHash("sha256").update(JSON.stringify(normalizedPolicy)).digest("hex");
  } catch {
    computedPolicyDigest = null;
  }
  const eventName = String(payload?.eventName ?? "");
  const expectedWorkflowFile = eventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT
    ? RELEASE_POLICY_RECONCILIATION_WORKFLOW_FILE
    : RELEASE_WORKFLOW_FILE;
  const expectedTrigger = String(triggerWorkflowRunId ?? "");
  const eventBindingInvalid = expectedEventName !== null
    ? eventName !== expectedEventName
    : (phase === "pre-merge" ? eventName !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT
      : ![RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT, RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT].includes(eventName));
  const triggerBindingInvalid = eventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT
    ? !/^\d+$/.test(String(payload?.triggerWorkflowRunId ?? "")) || (expectedTrigger && String(payload?.triggerWorkflowRunId) !== expectedTrigger)
    : payload?.triggerWorkflowRunId !== undefined;
  const commonBinding = !payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.schemaVersion !== 1 || payload.kind !== RELEASE_POLICY_RECEIPT_ARTIFACT_KIND ||
      payload.repository !== repository || payload.workflowFile !== expectedWorkflowFile ||
      String(payload.workflowRunId) !== String(runId) ||
      eventBindingInvalid || triggerBindingInvalid ||
      payload.branch !== branch || Number(payload.pullNumber) !== Number(pullNumber) ||
      String(payload.headSha).toLowerCase() !== String(preMergeSha).toLowerCase() ||
      JSON.stringify(payload.policy) !== JSON.stringify(normalizedPolicy) ||
      payload.policyDigest !== computedPolicyDigest ||
      (requiredPolicyDigest !== null && payload.policyDigest !== requiredPolicyDigest);
  if (phase === "pre-merge") {
    if (commonBinding || !RELEASE_POLICY_RECEIPT_PREMERGE_ACTIONS.includes(payload?.eventAction)) {
      throw new Error(`Release catch-up candidate ${preMergeSha} has an untrusted pre-merge policy artifact binding`);
    }
  } else if (phase === "merge-bound") {
    const mergedAt = Date.parse(String(payload?.mergedAt ?? ""));
    const normalizedMergeSha = String(mergeCommitSha ?? "").toLowerCase();
    const sourceRunId = String(payload?.sourceWorkflowRunId ?? "");
    const sourceDigest = String(payload?.sourcePolicyDigest ?? "").toLowerCase();
    if (commonBinding || payload?.eventAction !== RELEASE_POLICY_RECEIPT_MERGE_ACTION ||
        !/^[0-9a-f]{40}$/.test(normalizedMergeSha) || String(payload?.mergeCommitSha).toLowerCase() !== normalizedMergeSha ||
        !Number.isFinite(mergedAt) || mergedAt !== mergeTimeMs ||
        !/^\d+$/.test(sourceRunId) || !/^[a-f0-9]{64}$/.test(sourceDigest) || sourceDigest !== payload.policyDigest) {
      throw new Error(`Release catch-up candidate ${preMergeSha} has an untrusted merge-bound policy artifact binding`);
    }
  } else {
    throw new Error(`Release catch-up candidate ${preMergeSha} has an unsupported policy artifact phase`);
  }
  const observedAt = Date.parse(String(payload.observedAt ?? ""));
  if (!Number.isFinite(observedAt) ||
      (phase === "pre-merge" && !allowPostMergeObservation && mergeTimeMs !== null && observedAt > mergeTimeMs) ||
      (phase === "merge-bound" && observedAt < mergeTimeMs)) {
    throw new Error(`Release catch-up candidate ${preMergeSha} has pre-merge policy evidence after its pull-request merge`);
  }
  return { ...payload, policy: normalizedPolicy, observedAt: new Date(observedAt).toISOString() };
}

async function fetchPolicyReceiptArtifact({ apiUrl, repository, runId, token, fetchImpl, binding }) {
  const artifacts = await repositoryWorkflowArtifacts({ apiUrl, repository, runId, token, fetchImpl });
  const expectedName = `${RELEASE_POLICY_RECEIPT_ARTIFACT_NAME}-${runId}`;
  const named = artifacts.filter((artifact) => artifact?.name === expectedName);
  if (named.length === 0) throw new PendingPolicyReceiptArtifactError(`Release policy workflow ${runId} has not exposed its immutable policy artifact yet`);
  if (named.some((artifact) => artifact?.expired === true)) throw new Error(`Release policy workflow ${runId} exposed an expired immutable policy artifact`);
  const matches = named;
  if (matches.length !== 1) throw new Error(`Release policy workflow ${runId} must expose exactly one immutable policy artifact`);
  const artifact = matches[0];
  if (artifact.workflow_run?.id !== undefined && String(artifact.workflow_run.id) !== String(runId)) {
    throw new Error(`Release policy workflow ${runId} returned an artifact owned by a different workflow run`);
  }
  const downloadUrl = String(artifact.archive_download_url ?? "");
  if (!downloadUrl) throw new Error(`Release policy workflow ${runId} returned no artifact download URL`);
  const response = await fetchImpl(downloadUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "better-workflows-release-tag"
    }
  });
  if (!response.ok || typeof response.arrayBuffer !== "function") {
    throw new Error(`Release policy workflow ${runId} artifact download failed`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const declaredDigest = String(artifact.digest ?? "").replace(/^sha256:/, "");
  if (declaredDigest && /^[a-f0-9]{64}$/i.test(declaredDigest) && createHash("sha256").update(archive).digest("hex") !== declaredDigest.toLowerCase()) {
    throw new Error(`Release policy workflow ${runId} artifact digest drifted`);
  }
  return assertPolicyReceiptArtifact(readZipJsonEntry(archive, RELEASE_POLICY_RECEIPT_ARTIFACT_FILE), binding);
}

function workflowRunIdFromDetailsUrl(check) {
  const detailsUrl = String(check?.details_url ?? "");
  const match = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(detailsUrl);
  return match?.[1] ?? null;
}

async function repositoryCommitStatuses({ apiUrl, repository, sha, token, fetchImpl = fetch }) {
  return pagedGitHubCollection({
    apiUrl,
    pathName: `/repos/${repository}/commits/${sha}/statuses`,
    key: null,
    token,
    fetchImpl,
    label: "exact release status"
  });
}

async function repositoryRequiredChecks({ apiUrl, repository, branch, token, fetchImpl = fetch }) {
  const endpoint = `${apiUrl.replace(/\/$/, "")}/repos/${repository}/branches/${encodeURIComponent(branch)}`;
  const response = await fetchImpl(endpoint, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "better-workflows-release-tag"
    }
  });
  if (!response.ok) throw new Error(`GitHub protected branch query failed with HTTP ${response.status}`);
  const payload = await response.json();
  const protection = payload?.protection;
  const requiredStatusChecks = protection?.required_status_checks;
  if (payload?.protected !== true || !requiredStatusChecks || typeof requiredStatusChecks !== "object") {
    throw new Error(`GitHub branch ${branch} returned no resolvable required status check configuration`);
  }
  const required = [];
  if (!Array.isArray(requiredStatusChecks.contexts) && !Array.isArray(requiredStatusChecks.checks)) {
    throw new Error(`GitHub branch ${branch} returned no resolvable required status check configuration`);
  }
  if (typeof requiredStatusChecks.strict !== "boolean") {
    throw new Error(`GitHub branch ${branch} returned an invalid required status strict setting`);
  }
  for (const context of requiredStatusChecks.contexts ?? []) {
    if (typeof context !== "string" || context.length === 0) {
      throw new Error(`GitHub branch ${branch} returned an invalid required status context`);
    }
    required.push({ context, appId: null, strict: requiredStatusChecks.strict });
  }
  for (const check of requiredStatusChecks.checks ?? []) {
    if (!check || typeof check.context !== "string" || check.context.length === 0) {
      throw new Error(`GitHub branch ${branch} returned an invalid app-bound required status check`);
    }
    const rawAppId = check.app_id;
    const numericAppId = rawAppId === undefined || rawAppId === null || rawAppId === "" ? null : Number(rawAppId);
    const appId = numericAppId === null || numericAppId === -1 ? null : numericAppId;
    if (appId !== null && (!Number.isInteger(appId) || appId < 0)) {
      throw new Error(`GitHub branch ${branch} returned an invalid required status check app binding`);
    }
    required.push({ context: check.context, appId, strict: requiredStatusChecks.strict });
  }
  const unique = new Map(required.map((item) => [`${item.context}\u0000${item.appId ?? "*"}`, item]));
  const normalized = [...unique.values()].sort((left, right) => (
    `${left.context}:${left.appId ?? ""}`.localeCompare(`${right.context}:${right.appId ?? ""}`)
  ));
  if (normalized.length === 0) throw new Error(`GitHub branch ${branch} has no resolvable required status checks`);
  return normalized;
}

async function githubGraphql({ apiUrl, token, query, variables, fetchImpl = fetch }) {
  const response = await fetchImpl(githubGraphqlUrl(apiUrl), {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "better-workflows-release-tag"
    },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok) throw new Error(`GitHub GraphQL release mutation failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(`GitHub GraphQL release mutation was rejected: ${String(payload.errors[0]?.message ?? "unknown error")}`);
  }
  if (!payload?.data || typeof payload.data !== "object") {
    throw new Error("GitHub GraphQL release mutation returned no data");
  }
  return payload.data;
}

export function githubGraphqlUrl(apiUrl) {
  const normalized = String(apiUrl ?? "").replace(/\/+$/, "");
  if (!normalized) throw new Error("GitHub GraphQL endpoint requires a non-empty API URL");
  return normalized.replace(/\/api\/v3$/i, "/api/graphql").replace(/(?<!\/graphql)$/, "/graphql");
}

async function githubRepositoryId({ apiUrl, repository, token, fetchImpl = fetch }) {
  const match = /^(?<owner>[A-Za-z0-9-]+)\/(?<name>[A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match) throw new Error("GITHUB_REPOSITORY must be owner/repository for release tagging");
  const data = await githubGraphql({
    apiUrl,
    token,
    fetchImpl,
    query: "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}",
    variables: { owner: match.groups.owner, name: match.groups.name }
  });
  const id = data.repository?.id;
  if (typeof id !== "string" || !id) throw new Error("GitHub repository id was not returned for release tagging");
  return id;
}

async function currentVersion(cwd) {
  const [packageJson, pluginManifest] = await Promise.all([
    readJson(path.join(cwd, REPOSITORY_PACKAGE)),
    readJson(path.join(cwd, PLUGIN_MANIFEST))
  ]);
  return versionSurfaces(packageJson, pluginManifest);
}

async function versionAtCommit(cwd, revision) {
  const [packageJson, pluginManifest] = await Promise.all([
    readJsonAtCommit(cwd, revision, REPOSITORY_PACKAGE),
    readJsonAtCommit(cwd, revision, PLUGIN_MANIFEST)
  ]);
  if (!packageJson || !pluginManifest) return null;
  return versionSurfaces(packageJson, pluginManifest);
}

async function versionAtProviderCommit({ apiUrl, repository, revision, token, fetchImpl = fetch }) {
  const normalizedRevision = String(revision ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalizedRevision) || !String(repository ?? "").trim()) return null;
  const readProviderFile = async (relativePath) => {
    const endpoint = `${String(apiUrl ?? "https://api.github.com").replace(/\/$/, "")}/repos/${repository}/contents/${relativePath}?ref=${normalizedRevision}`;
    const response = await fetchImpl(endpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "better-workflows-release-tag"
      }
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub exact PR head content query failed with HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || payload.type !== "file" || payload.path !== relativePath || payload.encoding !== "base64" || typeof payload.content !== "string") return null;
    try {
      return JSON.parse(Buffer.from(payload.content.replace(/\s+/g, ""), "base64").toString("utf8"));
    } catch {
      return null;
    }
  };
  const [packageJson, pluginManifest] = await Promise.all([
    readProviderFile(REPOSITORY_PACKAGE),
    readProviderFile(PLUGIN_MANIFEST)
  ]);
  if (!packageJson || !pluginManifest) return null;
  try {
    return versionSurfaces(packageJson, pluginManifest);
  } catch {
    return null;
  }
}

async function previousVersion(cwd, revision) {
  if (revision === null) return null;
  const [packageJson, pluginManifest] = await Promise.all([
    readJsonAtCommit(cwd, revision, REPOSITORY_PACKAGE),
    readJsonAtCommit(cwd, revision, PLUGIN_MANIFEST)
  ]);
  if (!packageJson || !pluginManifest) {
    throw new Error("Parent release version surfaces are incomplete");
  }
  return versionSurfaces(packageJson, pluginManifest);
}

async function remoteHead(cwd, branch) {
  const output = await git(cwd, ["ls-remote", "origin", `refs/heads/${branch}`]);
  const [sha] = output.split(/\s+/);
  return sha;
}

async function remoteTag(cwd, tag) {
  const output = await git(cwd, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  return parseRemoteTagCommit(output);
}

async function highestPublishedReleaseVersion(cwd, branch) {
  const output = await git(cwd, ["ls-remote", "--tags", "origin"]);
  const pattern = branch === "main"
    ? /^refs\/tags\/v(\d+\.\d+\.\d+)$/
    : /^refs\/tags\/v(\d+\.\d+\.\d+)-dev\.[0-9a-f]+$/;
  let highest = null;
  for (const line of output.split("\n")) {
    const reference = line.split(/\s+/)[1] ?? "";
    const match = pattern.exec(reference);
    if (!match) continue;
    if (highest === null || compareStableVersions(match[1], highest) > 0) highest = match[1];
  }
  return highest;
}

async function validatedEventBeforeRevision(cwd, before, head) {
  const targetParent = releaseTagParentRevision(before);
  if (targetParent === null) return null;
  const observed = await git(cwd, ["rev-parse", "--verify", `${targetParent}^{commit}`]);
  if (observed !== targetParent) {
    throw new Error(`Push event before revision lookup returned a different revision: ${observed}`);
  }
  try {
    await git(cwd, ["merge-base", "--is-ancestor", targetParent, head]);
  } catch {
    throw new Error(`Push event before revision ${targetParent} is not an ancestor of event SHA ${head}; refusing release eligibility`);
  }
  return targetParent;
}

async function defaultBranchReleasePolicyActivation({ apiUrl, repository, token, fetchImpl = fetch }) {
  const root = `${String(apiUrl ?? "https://api.github.com").replace(/\/$/, "")}/repos/${repository}`;
  const requestOptions = {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "better-workflows-release-tag"
    }
  };
  const repositoryResponse = await fetchImpl(root, requestOptions);
  if (!repositoryResponse.ok) throw new Error(`GitHub repository metadata query failed with HTTP ${repositoryResponse.status}`);
  const repositoryPayload = await repositoryResponse.json();
  const defaultBranch = String(repositoryPayload?.default_branch ?? "").trim();
  if (!/^[A-Za-z0-9._/-]{1,255}$/.test(defaultBranch)) return false;
  const loadWorkflow = async (workflowFile) => {
    const workflowResponse = await fetchImpl(`${root}/actions/workflows/${workflowFile.split("/").pop()}`, requestOptions);
    if (!workflowResponse.ok) return null;
    const workflowPayload = await workflowResponse.json();
    if (workflowPayload?.path !== workflowFile || workflowPayload?.state !== "active") return null;
    const contentResponse = await fetchImpl(`${root}/contents/${workflowFile}?ref=${encodeURIComponent(defaultBranch)}`, requestOptions);
    if (!contentResponse.ok) return null;
    const contentPayload = await contentResponse.json();
    if (contentPayload?.type !== "file" || contentPayload?.path !== workflowFile || contentPayload?.encoding !== "base64" || typeof contentPayload?.content !== "string") return null;
    try {
      return Buffer.from(contentPayload.content.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return null;
    }
  };
  const ciWorkflowText = await loadWorkflow(RELEASE_WORKFLOW_FILE);
  if (ciWorkflowText === null) return false;
  const reconciliationWorkflowText = await loadWorkflow(RELEASE_POLICY_RECONCILIATION_WORKFLOW_FILE);
  return ciWorkflowText !== null && reconciliationWorkflowText !== null &&
    /(?:^|\n)\s*pull_request_target\s*:/.test(ciWorkflowText) &&
    /(?:^|\n)\s*release-policy-receipt\s*:/.test(ciWorkflowText) &&
    /(?:^|\n)\s*workflow_run\s*:/.test(reconciliationWorkflowText) &&
    /(?:^|\n)\s*release-policy-receipt\s*:/.test(reconciliationWorkflowText);
}

async function releasePolicyPublisherAvailable(cwd, baseSha, remoteContext = {}) {
  const revision = String(baseSha ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) return true;
  try {
    await git(cwd, ["cat-file", "-e", `${revision}:.github/workflows/ci.yml`]);
  } catch {
    // Synthetic test repositories and older checkouts without the workflow do
    // not participate in the release-policy rollout gate.
    return true;
  }
  try {
    await git(cwd, ["cat-file", "-e", `${revision}:plugins/better-workflows/scripts/release-policy-receipt.mjs`]);
  } catch {
    return false;
  }
  if (!remoteContext.repository) return true;
  if (!remoteContext.defaultBranchActivation) {
    remoteContext.defaultBranchActivation = defaultBranchReleasePolicyActivation(remoteContext);
  }
  return remoteContext.defaultBranchActivation;
}

async function revisionIsAncestor(cwd, ancestor, descendant) {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function revisionExists(cwd, revision) {
  try {
    await git(cwd, ["cat-file", "-e", `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function authenticatedPullVersionTransition(cwd, pull, currentVersion, { apiUrl, repository, token, fetchImpl = fetch, immutableBaseSha = null } = {}) {
  const suppliedBaseSha = String(immutableBaseSha ?? "").trim().toLowerCase();
  const baseSha = suppliedBaseSha || String(pull?.base?.sha ?? "").trim().toLowerCase();
  const sourceSha = String(pull?.head?.sha ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(baseSha) || !/^[0-9a-f]{40}$/.test(sourceSha)) return null;
  if (!(await revisionExists(cwd, baseSha))) return null;
  const baseVersion = await versionAtCommit(cwd, baseSha);
  if (!baseVersion) return null;
  const mergeSha = String(pull?.merge_commit_sha ?? "").trim().toLowerCase();
  const exactMergeMatchesSource = async (sourceVersion) => {
    if (!suppliedBaseSha) return true;
    if (!/^[0-9a-f]{40}$/.test(mergeSha) || !(await revisionExists(cwd, mergeSha)) ||
        !(await revisionIsAncestor(cwd, baseSha, mergeSha))) return false;
    const mergeVersion = await versionAtCommit(cwd, mergeSha);
    return Boolean(mergeVersion) && compareStableVersions(mergeVersion, sourceVersion) === 0;
  };
  const sourceAvailable = await revisionExists(cwd, sourceSha);
  if (sourceAvailable) {
    // An immutable push-event parent is the target branch's first parent. A
    // normal PR may be based on an older target revision, so that parent need
    // not be an ancestor of the PR head; the exact merge result must instead
    // bind both revisions and carry the same version as the source tree.
    if (!suppliedBaseSha && !(await revisionIsAncestor(cwd, baseSha, sourceSha))) return null;
    const sourceVersion = await versionAtCommit(cwd, sourceSha);
    if (!baseVersion || !sourceVersion || compareStableVersions(sourceVersion, baseVersion) <= 0) return null;
    if (compareStableVersions(sourceVersion, currentVersion) !== 0) return null;
    if (!(await exactMergeMatchesSource(sourceVersion))) return null;
    return { baseSha, sourceSha, baseVersion, version: sourceVersion };
  }

  // A deleted, fork, squash, or rebased PR head may be absent from the target
  // checkout. Re-read the exact head tree through the provider at its immutable
  // SHA, then require the exact merge result to expose the same version. This
  // prevents an unrelated base-branch bump from being attributed to the PR.
  const sourceVersion = await versionAtProviderCommit({ apiUrl, repository, revision: sourceSha, token, fetchImpl });
  if (!sourceVersion || compareStableVersions(sourceVersion, baseVersion) <= 0 || compareStableVersions(sourceVersion, currentVersion) !== 0) return null;
  if (!/^[0-9a-f]{40}$/.test(mergeSha) || !(await revisionExists(cwd, mergeSha))) return null;
  if (!(await revisionIsAncestor(cwd, baseSha, mergeSha))) return null;
  const mergeVersion = await versionAtCommit(cwd, mergeSha);
  if (!mergeVersion || compareStableVersions(mergeVersion, sourceVersion) !== 0) return null;
  return {
    baseSha,
    sourceSha,
    baseVersion,
    version: sourceVersion,
    sourceUnavailable: true
  };
}

async function findEligibleVersionBumps({ cwd, branch, head, currentVersion, highestPublished, eventVersionChanged, eventParentVersion, eventParentRevision, headPull, apiUrl, repository, token, fetchImpl, publisherContext }) {
  const revisions = (await git(cwd, ["rev-list", "--first-parent", `--max-count=${CATCH_UP_HISTORY_LIMIT}`, head]))
    .split(/\s+/)
    .filter(Boolean);
  const candidates = [];
  const versionSurfaceHistoryBound = eventParentVersion !== null;
  const pullCache = new Map();
  const publisherAvailabilityCache = new Map();
  const pullTransitionCache = new Map();
  const loadPull = async (sha) => {
    if (pullCache.has(sha)) return pullCache.get(sha);
    const pull = sha === head
      ? headPull
      : findMergedPullRequest(await repositoryPullRequests({
        apiUrl,
        repository,
        sha,
        token,
        fetchImpl
      }), { branch, sha });
    pullCache.set(sha, pull);
    return pull;
  };
  const publisherAvailableAtRevision = async (revision) => {
    const boundary = String(revision ?? "").trim().toLowerCase();
    // Synthetic repositories may omit an event parent; retain their existing
    // behavior while real GitHub candidates use an immutable Git boundary.
    if (!/^[0-9a-f]{40}$/.test(boundary)) return true;
    if (!publisherAvailabilityCache.has(boundary)) {
      publisherAvailabilityCache.set(boundary, releasePolicyPublisherAvailable(cwd, boundary, publisherContext));
    }
    return publisherAvailabilityCache.get(boundary);
  };
  const pullVersionTransition = async (pull, immutableBaseSha = null) => {
    const key = `${String(pull?.merge_commit_sha ?? pull?.head?.sha ?? "").toLowerCase()}\u0000${String(immutableBaseSha ?? "").toLowerCase()}`;
    if (!key) return null;
    if (!pullTransitionCache.has(key)) {
      pullTransitionCache.set(key, authenticatedPullVersionTransition(cwd, pull, currentVersion, {
        apiUrl,
        repository,
        token,
        fetchImpl,
        immutableBaseSha
      }));
    }
    return pullTransitionCache.get(key);
  };
  const addCandidate = async ({ order, sha, pull, parentVersion, version, publisherBoundary, authenticatedRange = false }) => {
    if (!(await publisherAvailableAtRevision(publisherBoundary))) return false;
    const tag = releaseTagName({ branch, version, sha });
    const existingCommit = await remoteTag(cwd, tag);
    if (existingCommit && existingCommit !== sha) {
      throw new Error(`${tag} already exists at ${existingCommit}; refusing to retarget it to ${sha}`);
    }
    candidates.push({ order, sha, pull, parentVersion, version, tag, existingCommit, authenticatedRange });
    return true;
  };
  for (const [order, candidate] of revisions.entries()) {
    let parent;
    try {
      parent = await git(cwd, ["rev-parse", "--verify", `${candidate}^1`]);
    } catch {
      continue;
    }
    const candidateVersion = await versionAtCommit(cwd, candidate);
    if (candidateVersion !== null && compareStableVersions(candidateVersion, currentVersion) > 0) {
      throw new Error(`Release version history contains ${candidateVersion} above current ${currentVersion}; refusing catch-up publication`);
    }
    if (candidateVersion === null) {
      if (versionSurfaceHistoryBound) {
        throw new Error(`Release version surfaces are missing at historical candidate ${candidate}; refusing eligibility`);
      }
      continue;
    }
    const parentVersion = await versionAtCommit(cwd, parent);
    if (parentVersion === null) {
      if (versionSurfaceHistoryBound) {
        throw new Error(`Release version surfaces are missing at historical parent ${parent}; refusing eligibility`);
      }
      continue;
    }
    if (compareStableVersions(candidateVersion, parentVersion) <= 0) {
      // A rebased multi-commit PR may carry the version change in an earlier
      // source commit while its exact merged result has no first-parent delta.
      // Reconstruct the authenticated PR range from its immutable base to
      // source head, and attribute the net change only to that exact result.
      const pull = await loadPull(candidate);
      const transition = await pullVersionTransition(pull, candidate === head ? eventParentRevision : null);
      if (!transition || String(pull?.merge_commit_sha ?? "").toLowerCase() !== candidate) continue;
      await addCandidate({
        order,
        sha: candidate,
        pull,
        parentVersion: transition.baseVersion,
        version: transition.version,
        publisherBoundary: transition.baseSha,
        authenticatedRange: true
      });
      continue;
    }
    try {
      await git(cwd, ["merge-base", "--is-ancestor", candidate, head]);
    } catch {
      continue;
    }
    const pull = await loadPull(candidate);
    // A version-bump commit without its own exact merged PR is untrusted.
    // Ancestry/equal-version checks cannot prove that a later PR introduced
    // the version change, so never launder the candidate through a descendant.
    if (pull && candidate === head) {
      // The event-head candidate must be attributable to this exact PR's
      // immutable base-to-source range; the push event parent alone can span
      // unrelated commits from the same multi-commit push.
      const transition = await pullVersionTransition(pull, eventParentRevision);
      if (!transition || String(pull?.merge_commit_sha ?? "").toLowerCase() !== candidate) continue;
      await addCandidate({
        order: -1,
        sha: candidate,
        pull,
        parentVersion: transition.baseVersion,
        version: transition.version,
        publisherBoundary: transition.baseSha,
        authenticatedRange: true
      });
      continue;
    }
    if (pull && candidate !== head) {
      // Prefer an immutable PR range whenever the provider exposes one. Older
      // synthetic fixtures may omit that proof and retain the legacy parent
      // boundary path, but they must not participate in authenticated
      // duplicate-version ambiguity checks.
      const transition = await pullVersionTransition(pull);
      if (transition && String(pull?.merge_commit_sha ?? "").toLowerCase() === candidate) {
        await addCandidate({
          order,
          sha: candidate,
          pull,
          parentVersion: transition.baseVersion,
          version: transition.version,
          publisherBoundary: transition.baseSha,
          authenticatedRange: true
        });
        continue;
      }
    }
    if (pull && !headPull && candidate !== head) {
      // Catch-up may recover a rebase-style merge after a later push, but only
      // when the historical PR exposes the same authenticated range proof.
      const transition = await pullVersionTransition(pull);
      if (!transition || String(pull?.merge_commit_sha ?? "").toLowerCase() !== candidate) continue;
      await addCandidate({
        order,
        sha: candidate,
        pull,
        parentVersion: transition.baseVersion,
        version: transition.version,
        publisherBoundary: transition.baseSha,
        authenticatedRange: true
      });
      continue;
    }
    if (pull) {
      // A bump merged before the release-policy publisher existed on its PR
      // base can never acquire the required immutable pre-merge receipt. Treat
      // that bootstrap boundary as a durable historical exclusion so it cannot
      // strand later eligible candidates in catch-up verification.
      await addCandidate({
        order,
        sha: candidate,
        pull,
        parentVersion,
        version: candidateVersion,
        publisherBoundary: parent,
        authenticatedRange: false
      });
      continue;
    }
  }
  let hasExplicitHeadCandidate = false;
  hasExplicitHeadCandidate = candidates.some((candidate) => candidate.sha === head && candidate.version === currentVersion);
  if (revisions.length === CATCH_UP_HISTORY_LIMIT && !candidates.some((candidate) => candidate.sha === head)) {
    const oldest = revisions.at(-1);
    try {
      await git(cwd, ["rev-parse", "--verify", `${oldest}^1`]);
    } catch {
      return candidates;
    }
    if (highestPublished !== null && compareStableVersions(currentVersion, highestPublished) <= 0) {
      return candidates;
    }
    throw new Error(`Release catch-up history exceeded bounded first-parent search of ${CATCH_UP_HISTORY_LIMIT} commits; refusing to report release-version-unchanged`);
  }
  const candidateVersions = new Map();
  for (const candidate of candidates) {
    const prior = candidateVersions.get(candidate.version);
    if (prior && prior.sha !== candidate.sha && prior.authenticatedRange && candidate.authenticatedRange && !prior.existingCommit && !candidate.existingCommit) {
      throw new Error(`Stable release version ${candidate.version} has multiple eligible commits (${prior.sha} and ${candidate.sha}); refusing ambiguous release publication`);
    }
    if (!prior) candidateVersions.set(candidate.version, candidate);
  }
  const byTag = new Map();
  const filteredCandidates = hasExplicitHeadCandidate
    ? candidates.filter((candidate) => candidate.sha === head || candidate.version !== currentVersion)
    : candidates;
  for (const candidate of filteredCandidates) {
    const prior = byTag.get(candidate.tag);
    if (prior && prior.sha !== candidate.sha) {
      throw new Error(`${candidate.tag} has multiple eligible version-bump commits; refusing ambiguous release reconciliation`);
    }
    if (!prior) byTag.set(candidate.tag, candidate);
  }
  return [...byTag.values()].sort((left, right) => (
    compareStableVersions(left.version, right.version) || right.order - left.order
  ));
}

function normalizeCheckAppId(check) {
  const value = check?.app?.id ?? check?.app_id;
  if (value === undefined || value === null || value === "") return null;
  const appId = Number(value);
  return Number.isInteger(appId) && appId >= 0 ? appId : null;
}

function observationTime(record) {
  for (const field of ["completed_at", "updated_at", "created_at", "started_at"]) {
    const value = Date.parse(String(record?.[field] ?? ""));
    if (Number.isFinite(value)) return value;
  }
  return Number.NEGATIVE_INFINITY;
}

function workflowOriginTime(record) {
  const value = Date.parse(String(record?.created_at ?? ""));
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function observationId(record) {
  const value = Number(record?.id);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function latestObservation(records) {
  return records.reduce((latest, record, index) => {
    const candidate = { record, index };
    if (!latest) return candidate;
    const timeDelta = observationTime(candidate.record) - observationTime(latest.record);
    if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta > 0 ? candidate : latest;
    const idDelta = observationId(candidate.record) - observationId(latest.record);
    if (idDelta !== 0) return idDelta > 0 ? candidate : latest;
    return candidate.index > latest.index ? candidate : latest;
  }, null);
}

function latestRequiredObservation(checks, statuses) {
  const check = latestObservation(checks);
  const status = latestObservation(statuses);
  if (!check) return status ? { kind: "status", ...status } : null;
  if (!status) return { kind: "check", ...check };
  const checkTime = observationTime(check.record);
  const statusTime = observationTime(status.record);
  if (checkTime !== statusTime) return checkTime > statusTime ? { kind: "check", ...check } : { kind: "status", ...status };
  const checkId = observationId(check.record);
  const statusId = observationId(status.record);
  return checkId >= statusId ? { kind: "check", ...check } : { kind: "status", ...status };
}

function waitForReleaseChecks(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function digestRequiredCheckPolicy(requirements) {
  return createHash("sha256").update(JSON.stringify(requirements)).digest("hex");
}

function policyReceiptMatches(record) {
  return record?.state === "success" &&
    String(record?.context ?? "") === RELEASE_POLICY_RECEIPT_CONTEXT &&
    policyReceiptRunId(record) !== null;
}

async function verifyPolicyReceipt({ record, policyDigest, apiUrl, repository, branch, mergeTimeMs, token, fetchImpl, candidateSha, preMergeSha, pullNumber, mergeCommitSha }) {
  if (!policyReceiptMatches(record)) {
    throw new Error(`Release catch-up candidate ${candidateSha} has an unauthenticated merge-time required-check policy receipt`);
  }
  const runId = policyReceiptRunId(record);
  let targetUrl;
  try {
    targetUrl = new URL(String(record.target_url));
  } catch {
    throw new Error(`Release catch-up candidate ${candidateSha} has an invalid merge-time policy workflow URL`);
  }
  if (targetUrl.pathname !== `/${repository}/actions/runs/${runId}`) {
    throw new Error(`Release catch-up candidate ${candidateSha} has a policy workflow URL for a different repository`);
  }
  const phase = targetUrl.searchParams.get("phase");
  if (mergeTimeMs !== null && phase !== "merge-bound") {
    throw new Error(`Release catch-up candidate ${candidateSha} lacks a trusted merge-bound policy receipt`);
  }
  if (
    targetUrl.searchParams.get("pr") !== String(pullNumber) ||
    targetUrl.searchParams.get("head") !== preMergeSha ||
    targetUrl.searchParams.get("base") !== branch ||
    (phase === "merge-bound" && targetUrl.searchParams.get("merge") !== mergeCommitSha) ||
    (phase === "merge-bound" && !/^\d+$/.test(targetUrl.searchParams.get("source") ?? "")) ||
    (phase !== "merge-bound" && targetUrl.searchParams.has("trigger")) ||
    (phase !== "merge-bound" && phase !== "pre-merge")
  ) {
    throw new Error(`Release catch-up candidate ${candidateSha} has a policy receipt for a different pull request boundary`);
  }
  const workflowRun = await repositoryWorkflowRun({ apiUrl, repository, runId, token, fetchImpl });
  const workflowEvent = String(workflowRun?.event ?? "");
  const triggerWorkflowRunId = targetUrl.searchParams.get("trigger");
  const expectedReceiptWorkflowFile = workflowEvent === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT
    ? RELEASE_POLICY_RECONCILIATION_WORKFLOW_FILE
    : RELEASE_WORKFLOW_FILE;
  const commonWorkflowBindingInvalid = String(workflowRun?.id ?? "") !== runId ||
    workflowRun?.path !== expectedReceiptWorkflowFile ||
    workflowRun?.repository?.full_name !== repository;
  const pullRequestTargetPull = Array.isArray(workflowRun?.pull_requests)
    ? workflowRun.pull_requests.find((pull) => Number(pull?.number) === pullNumber)
    : null;
  const pullRequestTargetBindingInvalid = workflowEvent === RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT && (
    !pullRequestTargetPull ||
    String(pullRequestTargetPull?.base?.ref ?? "") !== branch ||
    String(pullRequestTargetPull?.head?.sha ?? "").toLowerCase() !== preMergeSha ||
    !/^[0-9a-f]{40}$/.test(String(workflowRun?.head_sha ?? "").toLowerCase()) ||
    (pullRequestTargetPull?.base?.sha !== undefined && String(workflowRun.head_sha).toLowerCase() !== String(pullRequestTargetPull.base.sha).toLowerCase()) ||
    (pullRequestTargetPull?.base?.sha === undefined && workflowRun?.head_branch !== undefined && workflowRun.head_branch !== branch)
  );
  const reconciliationBindingInvalid = workflowEvent === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT && (
    phase !== "merge-bound" || !/^\d+$/.test(triggerWorkflowRunId ?? "")
  );
  if (commonWorkflowBindingInvalid || (workflowEvent !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT && workflowEvent !== RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT) ||
      pullRequestTargetBindingInvalid || reconciliationBindingInvalid) {
    throw new Error(`Release catch-up candidate ${candidateSha} has untrusted merge-time policy workflow provenance`);
  }
  const workflowStatus = String(workflowRun?.status ?? "");
  const workflowConclusion = String(workflowRun?.conclusion ?? "");
  if (workflowStatus !== "completed") {
    if (["queued", "in_progress", "requested", "waiting", "pending"].includes(workflowStatus)) return null;
    throw new Error(`Release catch-up candidate ${candidateSha} has malformed merge-time policy workflow status`);
  }
  if (workflowConclusion !== "success") {
    throw new Error(`Release catch-up candidate ${candidateSha} has an unsuccessful merge-time policy workflow`);
  }
  const workflowAt = observationTime(workflowRun);
  if (!Number.isFinite(workflowAt) || (phase === "pre-merge" ? workflowAt > mergeTimeMs : workflowAt < mergeTimeMs)) {
    throw new Error(`Release catch-up candidate ${candidateSha} has pre-merge policy workflow provenance after its pull-request merge`);
  }
  let triggerWorkflowRun = null;
  if (workflowEvent === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT) {
    triggerWorkflowRun = await repositoryWorkflowRun({ apiUrl, repository, runId: triggerWorkflowRunId, token, fetchImpl });
    const triggerPull = Array.isArray(triggerWorkflowRun?.pull_requests)
      ? triggerWorkflowRun.pull_requests.find((pull) => Number(pull?.number) === pullNumber)
      : null;
    if (
      String(triggerWorkflowRun?.id ?? "") !== triggerWorkflowRunId ||
      triggerWorkflowRun?.path !== RELEASE_WORKFLOW_FILE ||
      triggerWorkflowRun?.event !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT ||
      triggerWorkflowRun?.status !== "completed" ||
      triggerWorkflowRun?.conclusion !== "success" ||
      triggerWorkflowRun?.repository?.full_name !== repository ||
      !triggerPull ||
      String(triggerPull?.base?.ref ?? "") !== branch ||
      String(triggerPull?.head?.sha ?? "").toLowerCase() !== preMergeSha
    ) {
      throw new Error(`Release catch-up candidate ${candidateSha} has untrusted workflow-run reconciliation trigger provenance`);
    }
  }
  let artifact;
  try {
    artifact = await fetchPolicyReceiptArtifact({
      apiUrl,
      repository,
      runId,
      token,
      fetchImpl,
      binding: {
        repository,
        branch,
        runId,
        pullNumber,
        preMergeSha,
        requiredPolicyDigest: policyDigest,
        mergeTimeMs,
        phase,
        mergeCommitSha,
        expectedEventName: workflowEvent,
        triggerWorkflowRunId
      }
    });
  } catch (error) {
    if (error instanceof PendingPolicyReceiptArtifactError && phase === "merge-bound") return null;
    throw error;
  }
  if (String(record?.description ?? "") !== `${RELEASE_POLICY_RECEIPT_PREFIX}${artifact.policyDigest}`) {
    throw new Error(`Release catch-up candidate ${candidateSha} has a policy status that disagrees with its immutable artifact`);
  }
  if (phase === "pre-merge") return { record, workflowRun, artifact };
  const sourceRunId = String(artifact.sourceWorkflowRunId);
  if (targetUrl.searchParams.get("source") !== sourceRunId) {
    throw new Error(`Release catch-up candidate ${candidateSha} has a merge-bound receipt for a different source workflow`);
  }
  const sourceWorkflowRun = await repositoryWorkflowRun({ apiUrl, repository, runId: sourceRunId, token, fetchImpl });
  const sourcePull = Array.isArray(sourceWorkflowRun?.pull_requests)
    ? sourceWorkflowRun.pull_requests.find((pull) => Number(pull?.number) === pullNumber)
    : null;
  if (
    String(sourceWorkflowRun?.id ?? "") !== sourceRunId ||
    sourceWorkflowRun?.path !== RELEASE_WORKFLOW_FILE ||
    sourceWorkflowRun?.event !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT ||
    sourceWorkflowRun?.status !== "completed" ||
    sourceWorkflowRun?.conclusion !== "success" ||
    sourceWorkflowRun?.repository?.full_name !== repository ||
    !sourcePull ||
    String(sourcePull?.base?.ref ?? "") !== branch ||
    String(sourcePull?.head?.sha ?? "").toLowerCase() !== preMergeSha ||
    !/^[0-9a-f]{40}$/.test(String(sourceWorkflowRun?.head_sha ?? "").toLowerCase()) ||
    (sourcePull?.base?.sha !== undefined && String(sourceWorkflowRun.head_sha).toLowerCase() !== String(sourcePull.base.sha).toLowerCase()) ||
    (sourcePull?.base?.sha === undefined && sourceWorkflowRun?.head_branch !== undefined && sourceWorkflowRun.head_branch !== branch)
  ) {
    throw new Error(`Release catch-up candidate ${candidateSha} has untrusted pre-merge policy workflow continuity`);
  }
  const sourceWorkflowAt = workflowOriginTime(sourceWorkflowRun);
  if (!Number.isFinite(sourceWorkflowAt) || sourceWorkflowAt > mergeTimeMs) {
    throw new Error(`Release catch-up candidate ${candidateSha} has pre-merge policy workflow provenance after its pull-request merge`);
  }
  let sourceArtifact;
  try {
    sourceArtifact = await fetchPolicyReceiptArtifact({
      apiUrl,
      repository,
      runId: sourceRunId,
      token,
      fetchImpl,
      binding: {
        repository,
        branch,
        runId: sourceRunId,
        pullNumber,
        preMergeSha,
        requiredPolicyDigest: artifact.policyDigest,
        mergeTimeMs,
        phase: "pre-merge",
        mergeCommitSha,
        allowPostMergeObservation: true
      }
    });
  } catch (error) {
    if (error instanceof PendingPolicyReceiptArtifactError) return null;
    throw error;
  }
  if (sourceArtifact.policyDigest !== artifact.sourcePolicyDigest || JSON.stringify(sourceArtifact.policy) !== JSON.stringify(artifact.policy)) {
    throw new Error(`Release catch-up candidate ${candidateSha} has a merge-bound policy continuity digest mismatch`);
  }
  return { record, workflowRun, triggerWorkflowRun, artifact, sourceWorkflowRun, sourceArtifact };
}

function requiredObservationState(selected) {
  if (!selected) return "missing";
  if (selected.kind === "check") {
    if (selected.record.status !== "completed" || !selected.record.conclusion) return "pending";
    return selected.record.conclusion === "success" ? "success" : "failure";
  }
  if (selected.record.state === "success") return "success";
  return ["pending", "queued", "in_progress"].includes(String(selected.record.state)) ? "pending" : "failure";
}

function workflowTestObservation({ branch, checkRuns, workflowRuns, sha }) {
  const candidateChecks = checkRuns.filter((check) => (
    String(check?.head_sha ?? "").toLowerCase() === sha &&
    String(check?.name ?? "") === RELEASE_WORKFLOW_TEST_CONTEXT &&
    String(check?.app?.slug ?? "") === RELEASE_WORKFLOW_TEST_APP_SLUG
  ));
  const matchingRuns = workflowRuns.filter((run) => (
    run?.path === RELEASE_WORKFLOW_FILE &&
    String(run?.head_sha ?? "").toLowerCase() === sha &&
    run?.event === "push" &&
    run?.head_branch === branch
  ));
  const latestRun = latestObservation(matchingRuns)?.record ?? null;
  if (!latestRun) return { state: "missing", run: null, check: null };
  const runId = String(latestRun.id ?? "");
  const latestCheck = latestObservation(
    candidateChecks.filter((candidate) => workflowRunIdFromDetailsUrl(candidate) === runId)
  )?.record ?? null;
  if (!latestCheck || latestCheck.status !== "completed" || !latestCheck.conclusion ||
      latestRun.status !== "completed" || !latestRun.conclusion) {
    return { state: "pending", run: latestRun, check: latestCheck };
  }
  return {
    state: latestCheck.conclusion === "success" && latestRun.conclusion === "success"
      ? "success"
      : "failure",
    run: latestRun,
    check: latestCheck
  };
}

function pullRequestWorkflowObservation({ workflowRuns, pullNumber, expectedPreMergeSha = null, branch, repository, mergeTimeMs = null }) {
  const expectedHead = expectedPreMergeSha ? String(expectedPreMergeSha).toLowerCase() : null;
  const expectedRepository = String(repository ?? "").toLowerCase();
  const matchingRuns = workflowRuns.filter((run) => (
    run?.path === RELEASE_WORKFLOW_FILE &&
    run?.event === "pull_request" &&
    Array.isArray(run?.pull_requests) &&
    run.pull_requests.some((pull) => {
      const baseRepository = String(
        pull?.base?.repo?.full_name ??
        pull?.base?.repository?.full_name ??
        run?.repository?.full_name ??
        ""
      ).toLowerCase();
      return Number(pull?.number) === pullNumber &&
        (!expectedHead || String(pull?.head?.sha ?? "").toLowerCase() === expectedHead) &&
        (!branch || String(pull?.base?.ref ?? "") === branch) &&
        (!expectedRepository || baseRepository === expectedRepository);
    }) &&
    (mergeTimeMs === null || observationTime(run) <= mergeTimeMs)
  ));
  const latestRun = latestObservation(matchingRuns)?.record ?? null;
  if (!latestRun) return { state: "missing", run: null };
  if (latestRun.status !== "completed" || !latestRun.conclusion) {
    return { state: "pending", run: latestRun };
  }
  return {
    state: latestRun.conclusion === "success" ? "success" : "failure",
    run: latestRun
  };
}

function policyReceiptRunId(record) {
  const targetUrl = String(record?.target_url ?? "");
  const match = /\/actions\/runs\/(\d+)(?:[/?]|$)/.exec(targetUrl);
  return match?.[1] ?? null;
}

async function verifyCatchUpChecks({
  apiUrl,
  repository,
  branch,
  sha,
  token,
  fetchImpl,
  requireWorkflowTest = false,
  mergeTime = null,
  pullNumber = null,
  mergeCommitSha = sha,
  preMergeSha = sha,
  preMergeHeadRef = null,
  sleepImpl = waitForReleaseChecks
}) {
  const currentRequirements = await repositoryRequiredChecks({ apiUrl, repository, branch, token, fetchImpl });
  const selfContexts = new Set(["integration-tag", "tag merged release version"]);
  const assertNoCircularRequirements = (requirements) => {
    if (requirements.some(({ context }) => {
      const normalized = context.toLowerCase();
      return [...selfContexts].some((selfContext) => (
        normalized === selfContext || normalized.endsWith(` / ${selfContext}`) || normalized.endsWith(`: ${selfContext}`)
      ));
    })) throw new Error("Release tag required-check configuration includes the integration-tag job; refusing a circular gate");
  };
  assertNoCircularRequirements(currentRequirements);
  let requiredRequirements = mergeTime === null ? currentRequirements : null;
  let observations = [];
  let workflowObservation = { state: "success", run: null, check: null };
  let workflowState = workflowObservation.state;
  const mergeTimeMs = mergeTime === null ? null : Date.parse(String(mergeTime));
  if (mergeTime !== null && !Number.isFinite(mergeTimeMs)) {
    throw new Error(`Release catch-up candidate ${sha} lacks a valid pull-request merge timestamp`);
  }
  if (mergeTimeMs !== null && Date.now() - mergeTimeMs > CATCH_UP_ARTIFACT_MAX_AGE_MS) {
    throw new Error(`Release catch-up candidate ${sha} exceeds the ${CATCH_UP_ARTIFACT_MAX_AGE_MS / (24 * 60 * 60 * 1000)}-day policy artifact horizon`);
  }
  let normalizedPreMergeSha;
  try {
    normalizedPreMergeSha = assertCommitSha(preMergeSha);
  } catch {
    normalizedPreMergeSha = null;
  }
  if (mergeTime !== null && !normalizedPreMergeSha) {
    throw new Error(`Release catch-up candidate ${sha} lacks an immutable pre-merge commit binding`);
  }
  let testedRevision = normalizedPreMergeSha ?? sha;
  let requiredPolicyDigest = mergeTime === null ? digestRequiredCheckPolicy(currentRequirements) : null;
  let policyReceipt = null;
  let policyStatuses = [];
  let preMergeWorkflowObservation = { state: mergeTime === null ? "success" : "missing", run: null };
  for (let attempt = 0; attempt < REQUIRED_CHECK_POLL_ATTEMPTS; attempt += 1) {
    if (mergeTime !== null && !policyReceipt) {
      policyStatuses = await repositoryCommitStatuses({ apiUrl, repository, sha: normalizedPreMergeSha, token, fetchImpl });
      const policyRecords = policyStatuses.filter((status) => {
        if (String(status?.context ?? "") !== RELEASE_POLICY_RECEIPT_CONTEXT) return false;
        if (mergeTime === null) return true;
        try {
          return new URL(String(status.target_url ?? "")).searchParams.get("phase") === "merge-bound";
        } catch {
          return false;
        }
      });
      if (policyRecords.length > 0) {
        const policyRecord = latestObservation(policyRecords)?.record ?? null;
        policyReceipt = await verifyPolicyReceipt({
          record: policyRecord,
          policyDigest: null,
          apiUrl,
          repository,
          branch,
          mergeTimeMs,
          token,
          fetchImpl,
          candidateSha: sha,
          preMergeSha: normalizedPreMergeSha,
          pullNumber,
          mergeCommitSha
        });
        if (policyReceipt) {
          requiredRequirements = policyReceipt.artifact.policy;
          requiredPolicyDigest = policyReceipt.artifact.policyDigest;
          assertNoCircularRequirements(requiredRequirements);
        }
      }
      if (!policyReceipt) {
        if (attempt < REQUIRED_CHECK_POLL_ATTEMPTS - 1) await sleepImpl(REQUIRED_CHECK_POLL_DELAY_MS);
        continue;
      }
    }
    if (mergeTime !== null) {
      const pullRequestRuns = await repositoryWorkflowRuns({
        apiUrl,
        repository,
        branch: preMergeHeadRef,
        event: "pull_request",
        createdFilter: `<=${new Date(mergeTimeMs).toISOString()}`,
        pullNumber,
        token,
        fetchImpl
      });
      preMergeWorkflowObservation = pullRequestWorkflowObservation({
        workflowRuns: pullRequestRuns,
        pullNumber,
        expectedPreMergeSha: normalizedPreMergeSha,
        branch,
        repository,
        mergeTimeMs
      });
      if (preMergeWorkflowObservation.state === "success") {
        const workflowHeadSha = assertCommitSha(preMergeWorkflowObservation.run.head_sha);
        // GitHub pull_request workflows commonly run on a synthetic merge
        // revision. Keep the PR head binding separately, then verify checks
        // against the exact revision recorded by the trusted workflow run.
        testedRevision = workflowHeadSha;
      }
    }
    const checkRuns = await repositoryCheckRuns({ apiUrl, repository, sha: testedRevision, token, fetchImpl });
    const workflowCheckRuns = requireWorkflowTest
      ? await repositoryCheckRuns({ apiUrl, repository, sha, token, fetchImpl })
      : [];
    const workflowRuns = requireWorkflowTest
      ? await repositoryWorkflowRuns({ apiUrl, repository, branch, sha, token, fetchImpl })
      : [];
    // Legacy appId:null commit statuses are published on the immutable PR head,
    // while check-runs remain bound to the workflow-tested revision (which may
    // be a synthetic merge SHA). Keep those identities separate.
    const statusRevision = mergeTime === null ? testedRevision : normalizedPreMergeSha;
    const statuses = await repositoryCommitStatuses({ apiUrl, repository, sha: statusRevision, token, fetchImpl });
    observations = (requiredRequirements ?? []).map((requirement) => {
      const { context, appId } = requirement;
      const matchingChecks = checkRuns.filter((check) => (
        String(check?.head_sha ?? "").toLowerCase() === testedRevision &&
        String(check?.name ?? "") === context &&
        (appId === null || normalizeCheckAppId(check) === appId) &&
        (mergeTimeMs === null || observationTime(check) <= mergeTimeMs)
      ));
      const matchingStatuses = appId === null
        ? statuses.filter((status) => (
          String(status?.context ?? "") === context &&
          (mergeTimeMs === null || observationTime(status) <= mergeTimeMs)
        ))
        : [];
      const selected = latestRequiredObservation(matchingChecks, matchingStatuses);
      return { requirement, selected, state: requiredObservationState(selected) };
    });
    workflowObservation = requireWorkflowTest
      ? workflowTestObservation({ branch, checkRuns: workflowCheckRuns, workflowRuns, sha })
      : { state: "success", run: null, check: null };
    workflowState = workflowObservation.state;
    if (observations.some((item) => item.state === "failure")) {
      throw new Error(`Release catch-up requires all exact required checks and statuses to complete successfully: ${sha}`);
    }
    if (workflowState === "failure" && observations.every((item) => item.state === "success")) {
      throw new Error(`Release catch-up lacks an exact successful ${RELEASE_WORKFLOW_TEST_CONTEXT} workflow check: ${sha}`);
    }
    if (observations.every((item) => item.state === "success") && workflowState === "success" && preMergeWorkflowObservation.state === "success" && (mergeTime === null || policyReceipt)) break;
    if (attempt < REQUIRED_CHECK_POLL_ATTEMPTS - 1) await sleepImpl(REQUIRED_CHECK_POLL_DELAY_MS);
  }
  if (observations.some((item) => item.state === "missing")) {
    throw new Error(`Release catch-up lacks an exact required check or status context: ${sha}`);
  }
  if (observations.some((item) => item.state !== "success")) {
    throw new Error(`Release catch-up requires all exact required checks and statuses to complete successfully: ${sha}`);
  }
  if (mergeTime !== null && preMergeWorkflowObservation.state !== "success") {
    throw new Error(`Release catch-up lacks an exact successful pull-request workflow receipt: ${sha}`);
  }
  if (mergeTime !== null && !policyReceipt) {
    throw new Error(`Release catch-up lacks an authenticated merge-time required-check policy receipt: ${sha}`);
  }
  if (requireWorkflowTest && workflowState !== "success") {
    throw new Error(`Release catch-up lacks an exact successful ${RELEASE_WORKFLOW_TEST_CONTEXT} workflow check: ${sha}`);
  }
  const requiredContexts = requiredRequirements.map((item) => item.context);
  const result = {
    headSha: sha,
    requiredRequirements,
    requiredContexts,
    checkRuns: observations
      .filter((item) => item.selected.kind === "check")
      .map((item) => ({
        id: String(item.selected.record.id ?? ""),
        name: String(item.selected.record.name ?? ""),
        status: item.selected.record.status,
        conclusion: item.selected.record.conclusion
      }))
      .sort((left, right) => `${left.name}:${left.id}`.localeCompare(`${right.name}:${right.id}`)),
    statuses: observations
      .filter((item) => item.selected.kind === "status")
      .map((item) => ({
        context: String(item.selected.record.context),
        state: item.selected.record.state
      }))
      .sort((left, right) => `${left.context}:${left.state}`.localeCompare(`${right.context}:${right.state}`))
  };
  if (mergeTime !== null) {
    const mergedAtMs = mergeTimeMs;
    let normalizedMergeCommit;
    try {
      normalizedMergeCommit = assertCommitSha(mergeCommitSha);
    } catch {
      normalizedMergeCommit = null;
    }
    if (!Number.isInteger(pullNumber) || pullNumber <= 0 || normalizedMergeCommit !== sha) {
      throw new Error(`Release catch-up candidate ${sha} lacks an immutable merged pull-request binding`);
    }
    const observedAt = (record, label, phase = "pre-merge") => {
      const timestamp = phase === "pre-merge-origin" ? workflowOriginTime(record) : observationTime(record);
      if (!Number.isFinite(timestamp)) {
        throw new Error(`Release catch-up candidate ${sha} lacks a timestamped ${label} receipt`);
      }
      if ((phase === "pre-merge" || phase === "pre-merge-origin") && timestamp > mergedAtMs) {
        throw new Error(`Release catch-up candidate ${sha} has ${label} evidence after its pull-request merge`);
      }
      if (phase === "post-merge" && timestamp < mergedAtMs) {
        throw new Error(`Release catch-up candidate ${sha} has ${label} evidence before its pull-request merge`);
      }
      return new Date(timestamp).toISOString();
    };
    const mergeTimeReceipt = {
      schemaVersion: 1,
      kind: "merge-time-required-checks-v1",
      headSha: sha,
      preMergeSha: normalizedPreMergeSha,
      testedSha: testedRevision,
      pullNumber,
      mergeCommitSha,
      mergedAt: new Date(mergedAtMs).toISOString(),
      requiredRequirements: result.requiredRequirements,
      requiredCheckPolicyDigest: requiredPolicyDigest,
      checkRuns: [],
      statuses: [],
      ...(policyReceipt ? {
        policyReceipt: {
          context: RELEASE_POLICY_RECEIPT_CONTEXT,
          state: policyReceipt.record.state,
          description: policyReceipt.record.description,
          publisher: String(policyReceipt.record?.creator?.login ?? "github-actions[bot]"),
          workflowRunId: String(policyReceipt.workflowRun.id),
          recordedAt: policyReceipt.sourceArtifact?.observedAt ?? policyReceipt.artifact.observedAt,
          workflowRecordedAt: observedAt(policyReceipt.sourceWorkflowRun ?? policyReceipt.workflowRun, "pre-merge policy workflow", "pre-merge-origin")
        }
      } : {}),
      preMergeWorkflow: {
        runId: String(preMergeWorkflowObservation.run.id ?? ""),
        event: preMergeWorkflowObservation.run.event,
        headSha: testedRevision,
        conclusion: preMergeWorkflowObservation.run.conclusion,
        recordedAt: observedAt(preMergeWorkflowObservation.run, "pull-request workflow")
      }
    };
    for (const item of observations) {
      const recordedAt = observedAt(item.selected.record, `${item.requirement.context} required check`);
      if (item.selected.kind === "check") {
        mergeTimeReceipt.checkRuns.push({
          id: String(item.selected.record.id ?? ""),
          name: String(item.selected.record.name ?? ""),
          status: item.selected.record.status,
          conclusion: item.selected.record.conclusion,
          recordedAt
        });
      } else {
        mergeTimeReceipt.statuses.push({
          context: String(item.selected.record.context ?? ""),
          state: item.selected.record.state,
          recordedAt
        });
      }
    }
    if (requireWorkflowTest) {
      if (!workflowObservation.run || !workflowObservation.check) {
        throw new Error(`Release catch-up candidate ${sha} lacks a timestamped workflow test receipt`);
      }
      mergeTimeReceipt.workflow = {
        runId: String(workflowObservation.run.id ?? ""),
        runConclusion: workflowObservation.run.conclusion,
        runRecordedAt: observedAt(workflowObservation.run, "workflow run", "post-merge"),
        checkId: String(workflowObservation.check.id ?? ""),
        checkConclusion: workflowObservation.check.conclusion,
        checkRecordedAt: observedAt(workflowObservation.check, "workflow test check", "post-merge")
      };
    }
    result.mergeTimeReceipt = mergeTimeReceipt;
  }
  return result;
}

export async function runReleaseTag({
  env = process.env,
  cwd = process.cwd(),
  fetchImpl = fetch,
  sleepImpl = waitForReleaseChecks
} = {}) {
  const eventName = String(env.GITHUB_EVENT_NAME ?? "");
  const branch = String(env.GITHUB_REF_NAME ?? "");
  if (eventName !== "push" || !isReleaseBranch(branch)) {
    return { status: "skipped", reason: "not-a-dev-or-main-push", branch };
  }

  const sha = assertCommitSha(env.GITHUB_SHA);
  const head = await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head !== sha) throw new Error(`Checked-out HEAD ${head} does not match event SHA ${sha}`);
  if (await remoteHead(cwd, branch) !== sha) {
    throw new Error(`Remote ${branch} moved after the workflow event; refusing to tag a stale commit`);
  }

  const token = String(env.GITHUB_TOKEN ?? "");
  const repository = String(env.GITHUB_REPOSITORY ?? "");
  if (!token || !repository) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required for release tagging");
  const apiUrl = String(env.GITHUB_API_URL ?? "https://api.github.com");
  const pulls = await repositoryPullRequests({
    apiUrl,
    repository,
    sha,
    token,
    fetchImpl
  });
  const targetParent = await validatedEventBeforeRevision(cwd, env.GITHUB_EVENT_BEFORE, sha);
  const [current, previous] = await Promise.all([
    currentVersion(cwd),
    previousVersion(cwd, targetParent)
  ]);
  if (previous !== null && compareStableVersions(current, previous) < 0) {
    throw new Error(`Release version ${current} is lower than its parent ${previous}; refusing release eligibility`);
  }
  const versionWasChanged = versionChanged(current, previous);
  const headPull = findMergedPullRequest(pulls, { branch, sha });
  // Bind the bootstrap gate to the validated push-event parent whenever one
  // exists; the live PR base ref may have advanced since the merge.
  const publisherBoundary = targetParent ?? headPull?.base?.sha;
  const publisherContext = { apiUrl, repository, token, fetchImpl };
  if (!(await releasePolicyPublisherAvailable(cwd, publisherBoundary, publisherContext))) {
    return {
      status: "skipped",
      reason: "release-policy-receipt-bootstrap-pending",
      branch,
      sha,
      version: current,
      ...(headPull ? { pullNumber: headPull.number } : {})
    };
  }
  const highestPublished = await highestPublishedReleaseVersion(cwd, branch);
  const candidates = await findEligibleVersionBumps({
    cwd,
    branch,
    head: sha,
    currentVersion: current,
    highestPublished,
    eventVersionChanged: versionWasChanged,
    eventParentVersion: previous,
    eventParentRevision: targetParent,
    headPull,
    apiUrl,
    repository,
    token,
    fetchImpl,
    publisherContext
  });
  if (highestPublished !== null && compareStableVersions(current, highestPublished) < 0) {
    throw new Error(`Release version ${current} is below the highest published ${branch} release ${highestPublished}; refusing release eligibility`);
  }
  const pendingCandidates = candidates.filter((candidate) => !candidate.existingCommit);
  const candidatesByVersion = new Map();
  for (const candidate of candidates) {
    const prior = candidatesByVersion.get(candidate.version);
    if (prior && prior.sha !== candidate.sha) {
      throw new Error(`Stable release version ${candidate.version} has multiple eligible commits (${prior.sha} and ${candidate.sha}); refusing ambiguous release publication`);
    }
    if (!prior) candidatesByVersion.set(candidate.version, candidate);
  }
  if (highestPublished !== null) {
    const duplicatePending = pendingCandidates.find((candidate) => (
      compareStableVersions(candidate.version, highestPublished) === 0
    ));
    if (duplicatePending) {
      throw new Error(`Release version ${duplicatePending.version} equals the highest published ${branch} release ${highestPublished} but its expected tag is absent; refusing duplicate stable release publication`);
    }
    const regressedPending = pendingCandidates.find((candidate) => (
      compareStableVersions(candidate.version, highestPublished) < 0
    ));
    if (regressedPending) {
      throw new Error(`Release version ${regressedPending.version} is below the highest published ${branch} release ${highestPublished}; refusing release eligibility`);
    }
  }
  if (pendingCandidates.length === 0) {
    if (!versionWasChanged) {
      return { status: "skipped", reason: "release-version-unchanged", branch, sha, version: current };
    }
    const existing = candidates.find((candidate) => candidate.sha === sha);
    if (!existing) {
      return { status: "skipped", reason: "commit-is-not-an-exact-merged-pr-result", branch, sha };
    }
    const requiredChecks = await verifyCatchUpChecks({
      apiUrl,
      repository,
      branch,
      sha: existing.sha,
      token,
      fetchImpl,
      // Historical candidates need an immutable post-merge workflow receipt;
      // the event-head candidate is already serialized behind integration-tag
      // `needs: test` in the push workflow, so its workflow gate is separate.
      requireWorkflowTest: existing.sha !== sha,
      mergeTime: existing.pull.merged_at,
      pullNumber: existing.pull.number,
      mergeCommitSha: existing.pull.merge_commit_sha,
      preMergeSha: existing.pull.head?.sha,
      preMergeHeadRef: existing.pull.head?.ref,
      sleepImpl
    });
    if (await remoteHead(cwd, branch) !== sha) {
      throw new Error(`Remote ${branch} moved before existing release tag reconciliation; refusing to report a stale tag as current`);
    }
    return {
      status: "existing",
      tag: existing.tag,
      branch,
      sha: existing.sha,
      version: existing.version,
      pullNumber: existing.pull.number,
      requiredChecks
    };
  }

  const checkedCandidates = [];
  for (const candidate of pendingCandidates) {
    const requiredChecks = await verifyCatchUpChecks({
      apiUrl,
      repository,
      branch,
      sha: candidate.sha,
      token,
      fetchImpl,
      // Historical candidates need an immutable post-merge workflow receipt;
      // the event-head candidate is already serialized behind integration-tag
      // `needs: test` in the push workflow, so its workflow gate is separate.
      requireWorkflowTest: candidate.sha !== sha,
      mergeTime: candidate.pull.merged_at,
      pullNumber: candidate.pull.number,
      mergeCommitSha: candidate.pull.merge_commit_sha,
      preMergeSha: candidate.pull.head?.sha,
      preMergeHeadRef: candidate.pull.head?.ref,
      sleepImpl
    });
    checkedCandidates.push({ candidate, requiredChecks });
  }
  const firstChecked = checkedCandidates[0];
  if (env.RELEASE_TAG_DRY_RUN === "1") {
    const result = {
      status: "planned",
      tag: firstChecked.candidate.tag,
      branch,
      sha: firstChecked.candidate.sha,
      version: firstChecked.candidate.version,
      pullNumber: firstChecked.candidate.pull.number,
      requiredChecks: firstChecked.requiredChecks
    };
    if (checkedCandidates.length > 1) {
      result.tags = checkedCandidates.map(({ candidate }) => ({ tag: candidate.tag, sha: candidate.sha, version: candidate.version }));
    }
    return result;
  }

  if (await remoteHead(cwd, branch) !== sha) {
    throw new Error(`Remote ${branch} moved before release tag publication; refusing to tag a stale commit`);
  }
  const repositoryId = await githubRepositoryId({ apiUrl, repository, token, fetchImpl });
  const mutation = releaseTagAtomicMutation({
    repositoryId,
    branch,
    tag: firstChecked.candidate.tag,
    sha: firstChecked.candidate.sha,
    expectedBranchSha: sha,
    tagUpdates: checkedCandidates.map(({ candidate }) => ({ tag: candidate.tag, sha: candidate.sha }))
  });
  const mutationData = await githubGraphql({
    apiUrl,
    token,
    fetchImpl,
    query: mutation.query,
    variables: mutation.variables
  });
  if (!mutationData.updateRefs) throw new Error("GitHub atomic release ref update returned no result");
  const result = {
    status: "created",
    tag: firstChecked.candidate.tag,
    branch,
    sha: firstChecked.candidate.sha,
    version: firstChecked.candidate.version,
    pullNumber: firstChecked.candidate.pull.number,
    requiredChecks: firstChecked.requiredChecks
  };
  if (checkedCandidates.length > 1) {
    result.tags = checkedCandidates.map(({ candidate }) => ({ tag: candidate.tag, sha: candidate.sha, version: candidate.version }));
  }
  return result;
}

function mainModule() {
  return path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url));
}

if (mainModule()) {
  runReleaseTag()
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
