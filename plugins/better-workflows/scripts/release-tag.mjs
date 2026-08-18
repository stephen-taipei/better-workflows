import { readFile } from "node:fs/promises";
import path from "node:path";
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
    const endpoint = `${apiUrl.replace(/\/$/, "")}${pathName}?per_page=100&page=${page}`;
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

async function findCatchUpVersionBump({ cwd, branch, head, version, apiUrl, repository, token, fetchImpl }) {
  const revisions = (await git(cwd, ["rev-list", "--first-parent", "--max-count=128", head]))
    .split(/\s+/)
    .filter(Boolean);
  for (const candidate of revisions) {
    let parent;
    try {
      parent = await git(cwd, ["rev-parse", "--verify", `${candidate}^1`]);
    } catch {
      continue;
    }
    const candidateVersion = await versionAtCommit(cwd, candidate);
    if (candidateVersion !== null && compareStableVersions(candidateVersion, version) > 0) {
      throw new Error(`Release version history contains ${candidateVersion} above current ${version}; refusing catch-up publication`);
    }
    if (candidateVersion !== version) continue;
    const parentVersion = await versionAtCommit(cwd, parent);
    if (parentVersion === null || compareStableVersions(candidateVersion, parentVersion) <= 0) continue;
    try {
      await git(cwd, ["merge-base", "--is-ancestor", candidate, head]);
    } catch {
      continue;
    }
    const pulls = await repositoryPullRequests({
      apiUrl,
      repository,
      sha: candidate,
      token,
      fetchImpl
    });
    const pull = findMergedPullRequest(pulls, { branch, sha: candidate });
    if (pull) return { sha: candidate, pull, parentVersion };
  }
  return null;
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
    if (timeDelta !== 0) return timeDelta > 0 ? candidate : latest;
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

async function verifyCatchUpChecks({ apiUrl, repository, branch, sha, token, fetchImpl }) {
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
  const checkRuns = await repositoryCheckRuns({ apiUrl, repository, sha, token, fetchImpl });
  const statuses = await repositoryCommitStatuses({ apiUrl, repository, sha, token, fetchImpl });
  const observations = requiredRequirements.map((requirement) => {
    const { context, appId } = requirement;
    const matchingChecks = checkRuns.filter((check) => (
      String(check?.head_sha ?? "").toLowerCase() === sha &&
      String(check?.name ?? "") === context &&
      (appId === null || normalizeCheckAppId(check) === appId)
    ));
    const matchingStatuses = appId === null
      ? statuses.filter((status) => String(status?.context ?? "") === context)
      : [];
    const selected = latestRequiredObservation(matchingChecks, matchingStatuses);
    return { requirement, selected };
  });
  if (observations.some((item) => !item.selected)) {
    throw new Error(`Release catch-up lacks an exact required check or status context: ${sha}`);
  }
  if (observations.some((item) => (
    item.selected.kind === "check"
      ? item.selected.record.status !== "completed" || item.selected.record.conclusion !== "success"
      : item.selected.record.state !== "success"
  ))) {
    throw new Error(`Release catch-up requires all exact required checks and statuses to complete successfully: ${sha}`);
  }
  const requiredContexts = requiredRequirements.map((item) => item.context);
  return {
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
}

export async function runReleaseTag({ env = process.env, cwd = process.cwd(), fetchImpl = fetch } = {}) {
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
  let releaseSha = sha;
  let pull = findMergedPullRequest(pulls, { branch, sha });
  let requiredChecks = null;
  if (!versionChanged(current, previous)) {
    const catchUp = await findCatchUpVersionBump({
      cwd,
      branch,
      head: sha,
      version: current,
      apiUrl,
      repository,
      token,
      fetchImpl
    });
    if (!catchUp) {
      return { status: "skipped", reason: "release-version-unchanged", branch, sha, version: current };
    }
    releaseSha = catchUp.sha;
    pull = catchUp.pull;
  }
  if (!pull) {
    return { status: "skipped", reason: "commit-is-not-an-exact-merged-pr-result", branch, sha };
  }
  const highestPublished = await highestPublishedReleaseVersion(cwd, branch);
  if (highestPublished !== null && compareStableVersions(current, highestPublished) < 0) {
    throw new Error(`Release version ${current} is below the highest published ${branch} release ${highestPublished}; refusing release eligibility`);
  }
  requiredChecks = await verifyCatchUpChecks({ apiUrl, repository, branch, sha: releaseSha, token, fetchImpl });

  const tag = releaseTagName({ branch, version: current, sha: releaseSha });
  const existingCommit = await remoteTag(cwd, tag);
  if (existingCommit) {
    if (existingCommit !== releaseSha) throw new Error(`${tag} already exists at ${existingCommit}; refusing to retarget it to ${releaseSha}`);
    if (await remoteHead(cwd, branch) !== sha) {
      throw new Error(`Remote ${branch} moved before existing release tag reconciliation; refusing to report a stale tag as current`);
    }
    return { status: "existing", tag, branch, sha: releaseSha, version: current, pullNumber: pull.number, requiredChecks };
  }

  if (env.RELEASE_TAG_DRY_RUN === "1") {
    return { status: "planned", tag, branch, sha: releaseSha, version: current, pullNumber: pull.number, requiredChecks };
  }

  if (await remoteHead(cwd, branch) !== sha) {
    throw new Error(`Remote ${branch} moved before release tag publication; refusing to tag a stale commit`);
  }
  const repositoryId = await githubRepositoryId({ apiUrl, repository, token, fetchImpl });
  const mutation = releaseTagAtomicMutation({ repositoryId, branch, tag, sha: releaseSha, expectedBranchSha: sha });
  const mutationData = await githubGraphql({
    apiUrl,
    token,
    fetchImpl,
    query: mutation.query,
    variables: mutation.variables
  });
  if (!mutationData.updateRefs) throw new Error("GitHub atomic release ref update returned no result");
  return { status: "created", tag, branch, sha: releaseSha, version: current, pullNumber: pull.number, requiredChecks };
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
