import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertCommitSha,
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
    if (String(error.message).includes("does not exist in")) return null;
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

async function firstParentRevision(cwd, revision) {
  const output = await git(cwd, ["rev-list", "--parents", "-n", "1", revision]);
  const [observed, parent] = output.split(/\s+/);
  if (observed !== revision) throw new Error(`Commit parent lookup returned a different revision: ${observed}`);
  return parent ? releaseTagParentRevision(parent) : null;
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
  const pulls = await repositoryPullRequests({
    apiUrl: String(env.GITHUB_API_URL ?? "https://api.github.com"),
    repository,
    sha,
    token,
    fetchImpl
  });
  const pull = findMergedPullRequest(pulls, { branch, sha });
  if (!pull) {
    return { status: "skipped", reason: "commit-is-not-an-exact-merged-pr-result", branch, sha };
  }

  const targetParent = await firstParentRevision(cwd, sha);
  const [current, previous] = await Promise.all([
    currentVersion(cwd),
    previousVersion(cwd, targetParent)
  ]);
  if (!versionChanged(current, previous)) {
    return { status: "skipped", reason: "release-version-unchanged", branch, sha, version: current };
  }

  const tag = releaseTagName({ branch, version: current, sha });
  const existingCommit = await remoteTag(cwd, tag);
  if (existingCommit) {
    if (existingCommit !== sha) throw new Error(`${tag} already exists at ${existingCommit}; refusing to retarget it to ${sha}`);
    if (await remoteHead(cwd, branch) !== sha) {
      throw new Error(`Remote ${branch} moved before existing release tag reconciliation; refusing to report a stale tag as current`);
    }
    return { status: "existing", tag, branch, sha, version: current, pullNumber: pull.number };
  }

  if (env.RELEASE_TAG_DRY_RUN === "1") {
    return { status: "planned", tag, branch, sha, version: current, pullNumber: pull.number };
  }

  if (await remoteHead(cwd, branch) !== sha) {
    throw new Error(`Remote ${branch} moved before release tag publication; refusing to tag a stale commit`);
  }
  const apiUrl = String(env.GITHUB_API_URL ?? "https://api.github.com");
  const repositoryId = await githubRepositoryId({ apiUrl, repository, token, fetchImpl });
  const mutation = releaseTagAtomicMutation({ repositoryId, branch, tag, sha });
  const mutationData = await githubGraphql({
    apiUrl,
    token,
    fetchImpl,
    query: mutation.query,
    variables: mutation.variables
  });
  if (!mutationData.updateRefs) throw new Error("GitHub atomic release ref update returned no result");
  return { status: "created", tag, branch, sha, version: current, pullNumber: pull.number };
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
