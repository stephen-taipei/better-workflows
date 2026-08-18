import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { githubGraphqlUrl, runReleaseTag } from "../release-tag.mjs";
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

function successfulRequiredCheckResponse(url, sha, context = "test") {
  if (url.endsWith("/branches/dev")) {
    return jsonResponse({ protected: true, protection: { required_status_checks: { contexts: [context], checks: [] } } });
  }
  if (url.includes(`/commits/${sha}/check-runs?per_page=100&page=1`)) {
    return jsonResponse({ check_runs: [{ id: 7, name: context, head_sha: sha, status: "completed", conclusion: "success" }] });
  }
  if (url.includes(`/commits/${sha}/statuses?per_page=100&page=1`)) {
    return jsonResponse([{ id: 7, context, state: "success" }]);
  }
  return null;
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

test("package and plugin manifest versions must agree", () => {
  assert.equal(versionSurfaces({ version: "3.4.10" }, { version: "3.4.10+codex.20260814T170343" }), "3.4.10");
  assert.throws(
    () => versionSurfaces({ version: "3.4.10" }, { version: "3.4.11+codex.build" }),
    /do not match/
  );
  assert.throws(() => normalizeStableVersion("3.4.10-dev.1"), /stable semver/);
});

test("only the exact merged PR result for the target branch is eligible", () => {
  const pull = { number: 42, base: { ref: "dev" }, merged_at: "2026-08-14T00:00:00Z", merge_commit_sha: SHA };
  assert.equal(findMergedPullRequest([pull], { branch: "dev", sha: SHA }), pull);
  assert.equal(findMergedPullRequest([pull], { branch: "main", sha: SHA }), null);
  assert.equal(findMergedPullRequest([{ ...pull, merge_commit_sha: "b".repeat(40) }], { branch: "dev", sha: SHA }), null);
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
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 7, base: { ref: "dev" }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: head }]);
      }
      const checkResponse = successfulRequiredCheckResponse(url, head);
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
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 8, base: { ref: "dev" }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: head }]);
      }
      const checkResponse = successfulRequiredCheckResponse(url, head);
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
    assert.deepEqual(reconciled, {
      status: "existing",
      tag,
      branch: "dev",
      sha: head,
      version: "3.4.13",
      pullNumber: 8,
      requiredChecks: {
        headSha: head,
        requiredRequirements: [{ context: "test", appId: null }],
        requiredContexts: ["test"],
        checkRuns: [{ id: "7", name: "test", status: "completed", conclusion: "success" }],
        statuses: []
      }
    });
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
    const fetchImpl = async (url) => {
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 9, base: { ref: "dev" }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: head }]);
      }
      const checkResponse = successfulRequiredCheckResponse(url, head, requiredContext);
      if (checkResponse) {
        if (url.includes(`/commits/${head}/check-runs?per_page=100&page=1`)) {
          return jsonResponse({ check_runs: [{ id: 7, name: requiredContext, head_sha: head, status: "completed", conclusion: checkConclusion }] });
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
      /all exact required checks and statuses to complete successfully/
    );
    checkConclusion = "success";
    const result = await runReleaseTag({
      cwd: work,
      fetchImpl,
      env
    });
    assert.equal(intermediate, await git(work, ["rev-parse", `${head}^1`]));
    assert.deepEqual(result, {
      status: "planned",
      tag: `v3.4.13-dev.${head.slice(0, 12)}`,
      branch: "dev",
      sha: head,
      version: "3.4.13",
      pullNumber: 9,
      requiredChecks: {
        headSha: head,
        requiredRequirements: [{ context: "test", appId: null }],
        requiredContexts: ["test"],
        checkRuns: [{ id: "7", name: "test", status: "completed", conclusion: "success" }],
        statuses: []
      }
    });
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
      if (url.endsWith("/graphql")) {
        const request = JSON.parse(options.body);
        graphqlCalls.push(request);
        if (request.query.includes("repository(owner")) return jsonResponse({ data: { repository: { id: "R_123" } } });
        return jsonResponse({ data: { updateRefs: { clientMutationId: null } } });
      }
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 12, base: { ref: "dev" }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${bump}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 11, base: { ref: "dev" }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: bump }]);
      }
      if (url.endsWith("/branches/dev")) {
        return jsonResponse({ protected: true, protection: { required_status_checks: { contexts: [], checks: [{ context: "test", app_id: requiredAppId }] } } });
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/check-runs?per_page=100&page=1`)) {
        return jsonResponse(
          { check_runs: [{ id: 7, name: "test", head_sha: bump, status: "completed", conclusion: candidateConclusion, app: { id: candidateAppId } }] },
          true,
          200,
          secondPageConclusion === null ? {} : { link: '<https://api.github.com/repos/example/repo/commits/bump/check-runs?per_page=100&page=2>; rel="next"' }
        );
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/check-runs?per_page=100&page=2`)) {
        return jsonResponse({ check_runs: [{ id: 8, name: "test", head_sha: bump, status: "completed", conclusion: secondPageConclusion, app: { id: candidateAppId } }] });
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/statuses?per_page=100&page=1`)) {
        return jsonResponse(
          [{ id: 7, context: "test", state: statusState }],
          true,
          200,
          secondStatusState === null ? {} : { link: '<https://api.github.com/repos/example/repo/commits/bump/statuses?per_page=100&page=2>; rel="next"' }
        );
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/statuses?per_page=100&page=2`)) {
        return jsonResponse([{ id: 8, context: "test", state: secondStatusState }]);
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
    assert.deepEqual(result, {
      status: "created",
      tag: `v3.4.13-dev.${bump.slice(0, 12)}`,
      branch: "dev",
      sha: bump,
      version: "3.4.13",
      pullNumber: 11,
      requiredChecks: {
        headSha: bump,
        requiredRequirements: [{ context: "test", appId: 123 }],
        checkRuns: [
          { id: "8", name: "test", status: "completed", conclusion: "success" }
        ],
        statuses: [],
        requiredContexts: ["test"]
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
      if (url.endsWith(`/repos/example/repo/commits/${unchangedHead}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 13, base: { ref: "dev" }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: unchangedHead }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${head}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 12, base: { ref: "dev" }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: head }]);
      }
      if (url.endsWith(`/repos/example/repo/commits/${bump}/pulls?per_page=100`)) {
        return jsonResponse([{ number: 11, base: { ref: "dev" }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: bump }]);
      }
      if (url.endsWith("/branches/dev")) {
        return jsonResponse({ protected: true, protection: { required_status_checks: { contexts: [], checks: [{ context: "test", app_id: 123 }] } } });
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/check-runs?per_page=100&page=1`)) {
        return jsonResponse({ check_runs: [{ id: 7, name: "test", head_sha: bump, status: "completed", conclusion: "success", app: { id: 123 } }] });
      }
      if (url.includes(`/repos/example/repo/commits/${bump}/statuses?per_page=100&page=1`)) {
        return jsonResponse([{ id: 7, context: "test", state: "failure" }]);
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
    assert.deepEqual(skipped, {
      status: "planned",
      tag: `v3.4.13-dev.${bump.slice(0, 12)}`,
      branch: "dev",
      sha: bump,
      version: "3.4.13",
      pullNumber: 11,
      requiredChecks: {
        headSha: bump,
        requiredRequirements: [{ context: "test", appId: 123 }],
        checkRuns: [{ id: "7", name: "test", status: "completed", conclusion: "success" }],
        statuses: [],
        requiredContexts: ["test"]
      }
    });
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
        return jsonResponse([{ number: 14, base: { ref: "dev" }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: regressedHead }]);
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
          return jsonResponse([{ number: 10, base: { ref: "dev" }, merged_at: "2026-08-15T00:00:00Z", merge_commit_sha: head }]);
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
