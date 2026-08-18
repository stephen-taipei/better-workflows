import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
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
const RELEASE_POLICY_RECEIPT_CONTEXT = "better-workflows/release-policy-v1";
const RELEASE_POLICY_RECEIPT_PREFIX = "better-workflows-policy-v1:";
const RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT = "pull_request_target";
const RELEASE_POLICY_RECEIPT_PUBLISHER = "github-actions[bot]";
const CATCH_UP_HISTORY_LIMIT = 128;
const REQUIRED_CHECK_POLL_ATTEMPTS = 31;
const REQUIRED_CHECK_POLL_DELAY_MS = 10_000;

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

async function repositoryPullRequests({ apiUrl, repository, sha, token, fetchImpl = fetch }) {
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

async function repositoryWorkflowRuns({ apiUrl, repository, branch = null, sha = null, event = "push", token, fetchImpl = fetch }) {
  const query = new URLSearchParams();
  if (sha) query.set("head_sha", sha);
  query.set("event", event);
  if (branch) query.set("branch", branch);
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
  for (const context of requiredStatusChecks.contexts ?? []) {
    if (typeof context !== "string" || context.length === 0) {
      throw new Error(`GitHub branch ${branch} returned an invalid required status context`);
    }
    required.push({ context, appId: null });
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
    required.push({ context: check.context, appId });
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

async function findEligibleVersionBumps({ cwd, branch, head, currentVersion, highestPublished, eventVersionChanged, eventParentVersion, headPull, apiUrl, repository, token, fetchImpl }) {
  const revisions = (await git(cwd, ["rev-list", "--first-parent", `--max-count=${CATCH_UP_HISTORY_LIMIT}`, head]))
    .split(/\s+/)
    .filter(Boolean);
  const candidates = [];
  const seen = [];
  const pullCache = new Map();
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
    if (candidateVersion === null) continue;
    const parentVersion = await versionAtCommit(cwd, parent);
    seen.push({ order, sha: candidate, version: candidateVersion });
    if (parentVersion === null || compareStableVersions(candidateVersion, parentVersion) <= 0) continue;
    try {
      await git(cwd, ["merge-base", "--is-ancestor", candidate, head]);
    } catch {
      continue;
    }
    let releaseSha = candidate;
    let pull = await loadPull(candidate);
    if (!pull) {
      for (let index = seen.length - 2; index >= 0; index -= 1) {
        const descendant = seen[index];
        if (descendant.version !== candidateVersion) continue;
        const descendantPull = await loadPull(descendant.sha);
        if (!descendantPull) continue;
        let pullBaseSha;
        try {
          pullBaseSha = assertCommitSha(descendantPull.base?.sha);
        } catch {
          continue;
        }
        if (pullBaseSha === candidate) continue;
        try {
          await git(cwd, ["merge-base", "--is-ancestor", pullBaseSha, candidate]);
          await git(cwd, ["merge-base", "--is-ancestor", candidate, descendant.sha]);
        } catch {
          continue;
        }
        releaseSha = descendant.sha;
        pull = descendantPull;
        break;
      }
    }
    if (!pull) continue;
    const tag = releaseTagName({ branch, version: candidateVersion, sha: releaseSha });
    const existingCommit = await remoteTag(cwd, tag);
    if (existingCommit && existingCommit !== releaseSha) {
      throw new Error(`${tag} already exists at ${existingCommit}; refusing to retarget it to ${releaseSha}`);
    }
    candidates.push({
      order,
      sha: releaseSha,
      pull,
      parentVersion,
      version: candidateVersion,
      tag,
      existingCommit
    });
  }
  let hasExplicitHeadCandidate = false;
  if (eventVersionChanged && headPull && !candidates.some((candidate) => candidate.sha === head)) {
    const tag = releaseTagName({ branch, version: currentVersion, sha: head });
    const existingCommit = await remoteTag(cwd, tag);
    if (existingCommit && existingCommit !== head) {
      throw new Error(`${tag} already exists at ${existingCommit}; refusing to retarget it to ${head}`);
    }
    candidates.push({
      order: -1,
      sha: head,
      pull: headPull,
      parentVersion: eventParentVersion,
      version: currentVersion,
      tag,
      existingCommit
    });
    hasExplicitHeadCandidate = true;
  }
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

function policyReceiptMatches(record, policyDigest) {
  return record?.state === "success" &&
    String(record?.context ?? "") === RELEASE_POLICY_RECEIPT_CONTEXT &&
    String(record?.description ?? "") === `${RELEASE_POLICY_RECEIPT_PREFIX}${policyDigest}` &&
    String(record?.creator?.login ?? "") === RELEASE_POLICY_RECEIPT_PUBLISHER &&
    policyReceiptRunId(record) !== null;
}

async function verifyPolicyReceipt({ record, policyDigest, apiUrl, repository, mergeTimeMs, token, fetchImpl, candidateSha, pullNumber }) {
  if (!policyReceiptMatches(record, policyDigest)) {
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
  const workflowRun = await repositoryWorkflowRun({ apiUrl, repository, runId, token, fetchImpl });
  if (
    String(workflowRun?.id ?? "") !== runId ||
    workflowRun?.path !== RELEASE_WORKFLOW_FILE ||
    workflowRun?.event !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT ||
    workflowRun?.status !== "completed" ||
    workflowRun?.conclusion !== "success" ||
    workflowRun?.repository?.full_name !== repository ||
    !Array.isArray(workflowRun?.pull_requests) ||
    !workflowRun.pull_requests.some((pull) => Number(pull?.number) === pullNumber)
  ) {
    throw new Error(`Release catch-up candidate ${candidateSha} has untrusted merge-time policy workflow provenance`);
  }
  const recordedAt = observationTime(record);
  const workflowAt = observationTime(workflowRun);
  if (!Number.isFinite(recordedAt) || !Number.isFinite(workflowAt) || recordedAt > mergeTimeMs || workflowAt > mergeTimeMs) {
    throw new Error(`Release catch-up candidate ${candidateSha} has merge-time policy provenance after its pull-request merge`);
  }
  return { record, workflowRun };
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

function pullRequestWorkflowObservation({ workflowRuns, pullNumber }) {
  const matchingRuns = workflowRuns.filter((run) => (
    run?.path === RELEASE_WORKFLOW_FILE &&
    run?.event === "pull_request" &&
    Array.isArray(run?.pull_requests) &&
    run.pull_requests.some((pull) => Number(pull?.number) === pullNumber)
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
  const match = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(targetUrl);
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
  sleepImpl = waitForReleaseChecks
}) {
  const requiredRequirements = await repositoryRequiredChecks({ apiUrl, repository, branch, token, fetchImpl });
  const selfContexts = new Set(["integration-tag", "tag merged release version"]);
  if (requiredRequirements.some(({ context }) => {
    const normalized = context.toLowerCase();
    return [...selfContexts].some((selfContext) => (
      normalized === selfContext || normalized.endsWith(` / ${selfContext}`) || normalized.endsWith(`: ${selfContext}`)
    ));
  })) {
    throw new Error("Release tag required-check configuration includes the integration-tag job; refusing a circular gate");
  }
  let observations = [];
  let workflowObservation = { state: "success", run: null, check: null };
  let workflowState = workflowObservation.state;
  const mergeTimeMs = mergeTime === null ? null : Date.parse(String(mergeTime));
  if (mergeTime !== null && !Number.isFinite(mergeTimeMs)) {
    throw new Error(`Release catch-up candidate ${sha} lacks a valid pull-request merge timestamp`);
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
  const requiredPolicyDigest = digestRequiredCheckPolicy(requiredRequirements);
  let policyReceipt = null;
  let preMergeWorkflowObservation = { state: mergeTime === null ? "success" : "missing", run: null };
  for (let attempt = 0; attempt < REQUIRED_CHECK_POLL_ATTEMPTS; attempt += 1) {
    if (mergeTime !== null) {
      const pullRequestRuns = await repositoryWorkflowRuns({
        apiUrl,
        repository,
        event: "pull_request",
        pullNumber,
        token,
        fetchImpl
      });
      preMergeWorkflowObservation = pullRequestWorkflowObservation({ workflowRuns: pullRequestRuns, pullNumber });
      if (preMergeWorkflowObservation.state === "success") {
        const workflowHeadSha = assertCommitSha(preMergeWorkflowObservation.run.head_sha);
        if (workflowHeadSha !== normalizedPreMergeSha) {
          throw new Error(`Release catch-up candidate ${sha} has a pull-request workflow receipt for a different pre-merge SHA`);
        }
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
    const statuses = await repositoryCommitStatuses({ apiUrl, repository, sha: testedRevision, token, fetchImpl });
    const policyStatuses = mergeTime !== null && normalizedPreMergeSha && normalizedPreMergeSha !== testedRevision
      ? await repositoryCommitStatuses({ apiUrl, repository, sha: normalizedPreMergeSha, token, fetchImpl })
      : statuses;
    observations = requiredRequirements.map((requirement) => {
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
    if (mergeTimeMs !== null) {
      const policyRecords = policyStatuses.filter((status) => String(status?.context ?? "") === RELEASE_POLICY_RECEIPT_CONTEXT);
      if (policyRecords.length > 0) {
        const policyRecord = latestObservation(policyRecords)?.record ?? null;
        policyReceipt = await verifyPolicyReceipt({
          record: policyRecord,
          policyDigest: requiredPolicyDigest,
          apiUrl,
          repository,
          mergeTimeMs,
          token,
          fetchImpl,
          candidateSha: sha,
          pullNumber
        });
      }
    }
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
      const timestamp = observationTime(record);
      if (!Number.isFinite(timestamp)) {
        throw new Error(`Release catch-up candidate ${sha} lacks a timestamped ${label} receipt`);
      }
      if (phase === "pre-merge" && timestamp > mergedAtMs) {
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
          publisher: policyReceipt.record.creator.login,
          workflowRunId: String(policyReceipt.workflowRun.id),
          recordedAt: observedAt(policyReceipt.record, "merge-time required-check policy"),
          workflowRecordedAt: observedAt(policyReceipt.workflowRun, "merge-time policy workflow")
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
  if (!headPull) {
    return { status: "skipped", reason: "commit-is-not-an-exact-merged-pr-result", branch, sha };
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
    headPull,
    apiUrl,
    repository,
    token,
    fetchImpl
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
