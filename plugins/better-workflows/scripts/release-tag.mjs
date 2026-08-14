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

async function currentVersion(cwd) {
  const [packageJson, pluginManifest] = await Promise.all([
    readJson(path.join(cwd, REPOSITORY_PACKAGE)),
    readJson(path.join(cwd, PLUGIN_MANIFEST))
  ]);
  return versionSurfaces(packageJson, pluginManifest);
}

async function previousVersion(cwd, sha) {
  const parents = (await git(cwd, ["show", "-s", "--format=%P", sha])).split(/\s+/).filter(Boolean);
  if (parents.length === 0) return null;
  const packageJson = await readJsonAtCommit(cwd, parents[0], REPOSITORY_PACKAGE);
  return packageJson?.version ?? null;
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

  const [current, previous] = await Promise.all([
    currentVersion(cwd),
    previousVersion(cwd, sha)
  ]);
  if (!versionChanged(current, previous)) {
    return { status: "skipped", reason: "release-version-unchanged", branch, sha, version: current };
  }

  const tag = releaseTagName({ branch, version: current, sha });
  const existingCommit = await remoteTag(cwd, tag);
  if (existingCommit) {
    if (existingCommit !== sha) throw new Error(`${tag} already exists at ${existingCommit}; refusing to retarget it to ${sha}`);
    return { status: "existing", tag, branch, sha, version: current, pullNumber: pull.number };
  }

  if (env.RELEASE_TAG_DRY_RUN === "1") {
    return { status: "planned", tag, branch, sha, version: current, pullNumber: pull.number };
  }

  await git(cwd, ["config", "user.name", "github-actions[bot]"]);
  await git(cwd, ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  await git(cwd, ["tag", "--annotate", tag, sha, "--message", `Release ${tag}`]);
  await git(cwd, ["push", "origin", `refs/tags/${tag}`]);
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
