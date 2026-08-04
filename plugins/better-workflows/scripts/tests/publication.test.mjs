import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  bundleDigest,
  checkPluginCache,
  markPluginCacheReady,
  publishPluginCache
} from "../lib/publication.mjs";
import { captureSourceBinding } from "../lib/git.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function sourceFixture(version = "1.1.0+test.1") {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-source-"));
  await mkdir(path.join(sourceRoot, ".codex-plugin"));
  await writeFile(
    path.join(sourceRoot, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({ name: "better-workflows", version })}\n`
  );
  await writeFile(path.join(sourceRoot, "payload.txt"), "one\n");
  return sourceRoot;
}

async function trackedSourceFixture(version = "1.1.0+test.tracked") {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-git-source-"));
  const sourceRoot = path.join(repositoryRoot, "plugins", "better-workflows");
  await mkdir(path.join(sourceRoot, ".codex-plugin"), { recursive: true });
  await writeFile(
    path.join(sourceRoot, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({ name: "better-workflows", version })}\n`
  );
  await writeFile(path.join(sourceRoot, "payload.txt"), "one\n");
  await writeFile(path.join(sourceRoot, ".gitignore"), "ignored.txt\n");
  await git(repositoryRoot, "init", "-q", "-b", "dev");
  await git(repositoryRoot, "config", "user.name", "Better Workflows Publication Tests");
  await git(repositoryRoot, "config", "user.email", "publication-tests@example.invalid");
  await git(repositoryRoot, "add", ".");
  await git(repositoryRoot, "commit", "-qm", "fixture");
  return { repositoryRoot, sourceRoot };
}

test("plugin cache publication stages a new immutable version and verifies exact content", async () => {
  const sourceRoot = await sourceFixture();
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-cache-"));
  const cacheRoot = path.join(parent, "better-workflows");
  const before = await checkPluginCache({ sourceRoot, cacheRoot });
  assert.equal(before.status, "missing");
  const published = await publishPluginCache({ sourceRoot, cacheRoot });
  assert.equal(published.ok, true);
  assert.equal(published.applied, true);
  await markPluginCacheReady({
    cacheRoot,
    version: published.version,
    target: published.target,
    targetDigest: published.targetDigest,
    sourceDigest: published.sourceDigest,
    sourceBaselineRevision: null,
    sourceHeadRevision: null,
    sourceBindingDigest: null,
    pluginBundleDigest: published.sourceDigest
  });
  const noOp = await publishPluginCache({ sourceRoot, cacheRoot });
  assert.equal(noOp.noOp, true);
  assert.deepEqual(
    (await readdir(cacheRoot)).filter((name) => name.includes(".publish.lock") || name.includes(".stage-")),
    []
  );
});

test("plugin cache publication refuses same-version content drift", async () => {
  const sourceRoot = await sourceFixture("1.1.0+test.2");
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-drift-"));
  const cacheRoot = path.join(parent, "better-workflows");
  await publishPluginCache({ sourceRoot, cacheRoot });
  await writeFile(path.join(sourceRoot, "payload.txt"), "two\n");
  const drift = await checkPluginCache({ sourceRoot, cacheRoot });
  assert.equal(drift.status, "drifted");
  assert.deepEqual(drift.diff.changed, ["payload.txt"]);
  await assert.rejects(
    publishPluginCache({ sourceRoot, cacheRoot }),
    /Refusing to overwrite immutable cache version/
  );
});

test("plugin cache publication rejects hardlinked bundle files", async () => {
  const sourceRoot = await sourceFixture("1.1.0+test.3");
  await link(path.join(sourceRoot, "payload.txt"), path.join(sourceRoot, "payload-hardlink.txt"));
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-hardlink-"));
  await assert.rejects(
    checkPluginCache({ sourceRoot, cacheRoot: path.join(parent, "cache") }),
    /Unsafe plugin bundle file/
  );
});

test("plugin cache publication rejects ignored or untracked source bytes in a tracked plugin", async () => {
  const { sourceRoot } = await trackedSourceFixture();
  await writeFile(path.join(sourceRoot, "ignored.txt"), "must not publish\n");
  await assert.rejects(
    checkPluginCache({ sourceRoot, cacheRoot: path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-untracked-")), "cache") }),
    /not a clean committed tree|untracked or ignored files/
  );
});

test("plugin cache publication rejects modified tracked plugin files", async () => {
  const { sourceRoot } = await trackedSourceFixture("1.1.0+test.modified");
  await writeFile(path.join(sourceRoot, "payload.txt"), "modified\n");
  await assert.rejects(
    checkPluginCache({ sourceRoot, cacheRoot: path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-modified-")), "cache") }),
    /not a clean committed tree/
  );
});

test("plugin cache publication rejects hidden tracked index flags", async () => {
  const { repositoryRoot, sourceRoot } = await trackedSourceFixture("1.1.0+test.hidden-index");
  const target = path.join(sourceRoot, "payload.txt");
  await git(repositoryRoot, "update-index", "--assume-unchanged", "plugins/better-workflows/payload.txt");
  try {
    await assert.rejects(
      checkPluginCache({ sourceRoot, cacheRoot: path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-hidden-")), "cache") }),
      /hidden tracked index flags/
    );
  } finally {
    await git(repositoryRoot, "update-index", "--no-assume-unchanged", "plugins/better-workflows/payload.txt").catch(() => undefined);
    await git(repositoryRoot, "update-index", "--no-skip-worktree", "plugins/better-workflows/payload.txt").catch(() => undefined);
    void target;
  }
});

test("plugin cache publication rejects an unrelated commit after the self-improve handoff", async () => {
  const { repositoryRoot, sourceRoot } = await trackedSourceFixture("1.1.0+test.binding");
  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" })).stdout.trim();
  const sourceBinding = await captureSourceBinding(repositoryRoot, { baseRevision: baseline, requireClean: true });
  const pluginBundleDigest = await bundleDigest(sourceRoot);
  await writeFile(path.join(repositoryRoot, "outside-plugin.txt"), "unrelated commit\n");
  await git(repositoryRoot, "add", "outside-plugin.txt");
  await git(repositoryRoot, "commit", "-qm", "advance unrelated repository head");
  await assert.rejects(
    publishPluginCache({
      sourceRoot,
      cacheRoot: path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-binding-")), "cache"),
      expectedSourceBinding: {
        pluginBundleDigest,
        sourceBaselineRevision: baseline,
        sourceBindingDigest: sourceBinding.digest,
        sourceHeadRevision: sourceBinding.headRevision
      }
    }),
    /source binding changed after self-improve handoff/
  );
});

test("plugin cache publication accepts a repository-root handoff for a plugin subtree", async () => {
  const { repositoryRoot, sourceRoot } = await trackedSourceFixture("1.1.0+test.canonical");
  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" })).stdout.trim();
  const sourceBinding = await captureSourceBinding(repositoryRoot, { baseRevision: baseline, requireClean: true });
  const pluginBundleDigest = await bundleDigest(sourceRoot);
  const published = await publishPluginCache({
    sourceRoot,
    cacheRoot: path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-canonical-")), "cache"),
    expectedSourceBinding: {
      pluginBundleDigest,
      sourceBaselineRevision: baseline,
      sourceBindingDigest: sourceBinding.digest,
      sourceHeadRevision: sourceBinding.headRevision
    }
  });
  assert.equal(published.ok, true);
  assert.equal(published.sourceDigest, pluginBundleDigest);
});

test("plugin cache publication uses the reviewed commit snapshot across a pre-rename source advance", async () => {
  const { repositoryRoot, sourceRoot } = await trackedSourceFixture("1.1.0+test.snapshot");
  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" })).stdout.trim();
  const sourceBinding = await captureSourceBinding(repositoryRoot, { baseRevision: baseline, requireClean: true });
  const pluginBundleDigest = await bundleDigest(sourceRoot);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-snapshot-")), "cache");
  await assert.rejects(
    publishPluginCache({
      sourceRoot,
      cacheRoot,
      expectedSourceBinding: {
        pluginBundleDigest,
        sourceBaselineRevision: baseline,
        sourceBindingDigest: sourceBinding.digest,
        sourceHeadRevision: sourceBinding.headRevision
      },
      beforeRename: async () => {
        await writeFile(path.join(sourceRoot, "payload.txt"), "interleaving plugin commit\n");
        await git(repositoryRoot, "add", "plugins/better-workflows/payload.txt");
        await git(repositoryRoot, "commit", "-qm", "advance plugin source during publication");
      }
    }),
    /source binding changed after self-improve handoff/
  );
  assert.deepEqual(await readdir(cacheRoot), []);
});
