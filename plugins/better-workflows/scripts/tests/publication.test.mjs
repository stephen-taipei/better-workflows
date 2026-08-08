import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  bundleDigest,
  checkPluginCache,
  markPluginCacheReady,
  removeUnreadyPluginCachePublication,
  publishPluginCache,
  recoverPendingPluginCachePublication,
  verifyPluginCacheReady
} from "../lib/publication.mjs";
import { captureSourceBinding } from "../lib/git.mjs";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

test("governed plugin cache sync cannot redirect publication to an arbitrary cache root", async () => {
  const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "..", "scripts", "plugin-cache.mjs");
  await assert.rejects(
    execFileAsync(process.execPath, [
      script,
      "sync",
      "--handoff-run", "run-placeholder",
      "--token", "token-placeholder",
      "--cache-root", path.join(os.tmpdir(), "untrusted-plugin-cache")
    ], { cwd: path.resolve(path.dirname(script)), encoding: "utf8" }),
    /--cache-root override is only valid for check/
  );
});

test("cache cleanup refuses to delete a ready publication", async () => {
  const sourceRoot = await sourceFixture("1.1.0+test.ready-cleanup");
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-ready-cleanup-")), "cache");
  const published = await publishPluginCache({ sourceRoot, cacheRoot });
  await markPluginCacheReady({
    cacheRoot,
    version: published.version,
    target: published.target,
    targetDigest: published.targetDigest,
    sourceDigest: published.sourceDigest
  });
  assert.equal((await verifyPluginCacheReady({
    cacheRoot,
    version: published.version,
    target: published.target,
    targetDigest: published.targetDigest
  })).ok, true);
  await assert.rejects(
    removeUnreadyPluginCachePublication({
      cacheRoot,
      version: published.version,
      target: published.target,
      targetDigest: published.targetDigest,
      runId: "sbw-ready-cleanup-run",
      attemptId: "sbw-ready-cleanup-attempt"
    }),
    /pending publication marker/
  );
  assert.equal((await checkPluginCache({ sourceRoot, cacheRoot })).ok, true);
});

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

test("plugin bundle digest uses Git executable-bit modes across checkout and archive materialization", async () => {
  const sourceRoot = await sourceFixture("1.1.0+test.git-mode-normalization");
  const payload = path.join(sourceRoot, "payload.txt");
  const checkoutDigest = await bundleDigest(sourceRoot);
  await chmod(payload, 0o664);
  assert.equal(await bundleDigest(sourceRoot), checkoutDigest);
  await chmod(payload, 0o755);
  const executableDigest = await bundleDigest(sourceRoot);
  await chmod(payload, 0o775);
  assert.equal(await bundleDigest(sourceRoot), executableDigest);
  assert.notEqual(executableDigest, checkoutDigest);
});

test("plugin cache publication reclaims a lock left by a hard-killed publisher", async () => {
  const sourceRoot = await sourceFixture("1.1.0+test.lock-recovery");
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-lock-recovery-")), "cache");
  const publicationIdentity = {
    runId: "sbw-lock-recovery-run",
    attemptId: "sbw-lock-recovery-attempt"
  };
  const publicationModule = pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "lib", "publication.mjs")).href;
  const childCode = `
    import { publishPluginCache } from ${JSON.stringify(publicationModule)};
    await publishPluginCache({
      sourceRoot: ${JSON.stringify(sourceRoot)},
      cacheRoot: ${JSON.stringify(cacheRoot)},
      publicationIdentity: ${JSON.stringify(publicationIdentity)},
      beforeRename: async () => process.kill(process.pid, "SIGKILL")
    });
  `;
  await assert.rejects(
    execFileAsync(process.execPath, ["--input-type=module", "-e", childCode], { encoding: "utf8" }),
    (error) => error.signal === "SIGKILL"
  );
  const published = await publishPluginCache({ sourceRoot, cacheRoot, publicationIdentity });
  assert.equal(published.ok, true);
  assert.equal(published.applied, true);
  assert.deepEqual(
    (await readdir(cacheRoot)).filter((name) => name.includes(".publish.lock") || name.includes(".stage-")),
    []
  );
});

test("stale lock recovery preserves a foreign pending marker when the target is absent", async () => {
  const version = "1.1.0+test.stale-lock-foreign-marker";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-stale-foreign-marker-")), "cache");
  await mkdir(cacheRoot, { recursive: true });
  const sourceDigest = await bundleDigest(sourceRoot);
  const markerPath = path.join(cacheRoot, `${version}.ready.json`);
  const foreignMarker = {
    schemaVersion: 2,
    state: "pending",
    version,
    target: path.join(cacheRoot, version),
    targetDigest: sourceDigest,
    sourceDigest,
    sourceBaselineRevision: null,
    sourceHeadRevision: null,
    sourceBindingDigest: null,
    pluginBundleDigest: sourceDigest,
    runId: "sbw-foreign-pending-run",
    attemptId: "sbw-foreign-pending-attempt",
    providerReceiptDigest: null,
    updatedAt: "2026-08-08T00:00:00.000Z"
  };
  await writeFile(markerPath, `${JSON.stringify(foreignMarker, null, 2)}\n`, { mode: 0o600 });
  await writeFile(
    path.join(cacheRoot, `.${version}.publish.lock`),
    `${JSON.stringify({
      version,
      pid: 999999999,
      ownerToken: "dead-foreign-owner",
      createdAt: "2020-01-01T00:00:00.000Z"
    })}\n`,
    { mode: 0o600 }
  );

  await assert.rejects(
    publishPluginCache({
      sourceRoot,
      cacheRoot,
      publicationIdentity: {
        runId: "sbw-current-pending-run",
        attemptId: "sbw-current-pending-attempt"
      }
    }),
    /existing pending publication marker is not bound to this action attempt/
  );
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), foreignMarker);
  await assert.rejects(access(path.join(cacheRoot, version)));
});

test("publication failure preserves a pending marker owned by another action", async () => {
  const version = "1.1.0+test.foreign-marker";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-foreign-marker-")), "cache");
  const markerPath = path.join(cacheRoot, `${version}.ready.json`);
  const foreignMarker = {
    schemaVersion: 2,
    state: "pending",
    version,
    target: path.join(cacheRoot, version),
    targetDigest: "a".repeat(64),
    sourceDigest: "a".repeat(64),
    sourceBaselineRevision: null,
    sourceHeadRevision: null,
    sourceBindingDigest: null,
    pluginBundleDigest: "a".repeat(64),
    runId: "sbw-foreign-run",
    attemptId: "sbw-foreign-attempt",
    providerReceiptDigest: null,
    updatedAt: "2026-08-07T00:00:00.000Z"
  };
  await assert.rejects(
    publishPluginCache({
      sourceRoot,
      cacheRoot,
      publicationIdentity: {
        runId: "sbw-current-run",
        attemptId: "sbw-current-attempt"
      },
      beforeRename: async () => {
        await writeFile(markerPath, `${JSON.stringify(foreignMarker, null, 2)}\n`, { mode: 0o600 });
        throw new Error("simulated foreign marker replacement");
      }
    }),
    /simulated foreign marker replacement/
  );
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), foreignMarker);
  await assert.rejects(access(path.join(cacheRoot, version)));
});

test("unready cache cleanup preserves a target and pending marker owned by another action", async () => {
  const version = "1.1.0+test.foreign-cleanup-marker";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-foreign-cleanup-")), "cache");
  const published = await publishPluginCache({
    sourceRoot,
    cacheRoot,
    publicationIdentity: {
      runId: "sbw-current-cleanup-run",
      attemptId: "sbw-current-cleanup-attempt"
    }
  });
  const markerPath = path.join(cacheRoot, `${version}.ready.json`);
  const foreignMarker = {
    ...JSON.parse(await readFile(markerPath, "utf8")),
    runId: "sbw-foreign-cleanup-run",
    attemptId: "sbw-foreign-cleanup-attempt",
    updatedAt: "2026-08-08T00:00:00.000Z"
  };
  await writeFile(markerPath, `${JSON.stringify(foreignMarker, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    removeUnreadyPluginCachePublication({
      cacheRoot,
      version,
      target: published.target,
      targetDigest: published.targetDigest,
      runId: "sbw-current-cleanup-run",
      attemptId: "sbw-current-cleanup-attempt"
    }),
    /exact owned pending publication marker/
  );
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), foreignMarker);
  assert.equal((await bundleDigest(published.target)), published.targetDigest);
});

test("ready finalization serializes cleanup under the publication lock", async () => {
  const version = "1.1.0+test.ready-cleanup-lock";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-ready-lock-")), "cache");
  const identity = {
    runId: "sbw-ready-lock-run",
    attemptId: "sbw-ready-lock-attempt"
  };
  const published = await publishPluginCache({
    sourceRoot,
    cacheRoot,
    publicationIdentity: identity
  });
  let signalReadyLock;
  let releaseReadyLock;
  const readyLockAcquired = new Promise((resolve) => { signalReadyLock = resolve; });
  const allowReadyWrite = new Promise((resolve) => { releaseReadyLock = resolve; });
  const finalizing = markPluginCacheReady({
    cacheRoot,
    version,
    target: published.target,
    targetDigest: published.targetDigest,
    sourceDigest: published.sourceDigest,
    runId: identity.runId,
    attemptId: identity.attemptId,
    afterLock: async () => {
      signalReadyLock();
      await allowReadyWrite;
    }
  });
  await readyLockAcquired;
  await assert.rejects(
    removeUnreadyPluginCachePublication({
      cacheRoot,
      version,
      target: published.target,
      targetDigest: published.targetDigest,
      runId: identity.runId,
      attemptId: identity.attemptId
    }),
    /publication is already in progress/
  );
  assert.equal((await bundleDigest(published.target)), published.targetDigest);
  assert.equal(JSON.parse(await readFile(path.join(cacheRoot, `${version}.ready.json`), "utf8")).state, "pending");
  releaseReadyLock();
  await finalizing;
  assert.equal((await bundleDigest(published.target)), published.targetDigest);
  assert.equal(JSON.parse(await readFile(path.join(cacheRoot, `${version}.ready.json`), "utf8")).state, "ready");
});

test("concurrent stale-lock reclaimers cannot steal a successor publication lock", async () => {
  const sourceRoot = await sourceFixture("1.1.0+test.concurrent-lock-recovery");
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-concurrent-lock-"));
  const cacheRoot = path.join(parent, "cache");
  await mkdir(cacheRoot, { recursive: true });
  const version = "1.1.0+test.concurrent-lock-recovery";
  await writeFile(
    path.join(cacheRoot, `.${version}.publish.lock`),
    `${JSON.stringify({
      version,
      pid: 999999999,
      ownerToken: "stale-owner",
      createdAt: "2020-01-01T00:00:00.000Z"
    })}\n`,
    { mode: 0o600 }
  );
  const publicationModule = pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "lib", "publication.mjs")).href;
  const releaseFile = path.join(parent, "release");
  const readyFiles = [path.join(parent, "ready-a"), path.join(parent, "ready-b")];
  const startedFiles = [path.join(parent, "started-a"), path.join(parent, "started-b")];
  const childCode = (index) => `
    import { access, writeFile } from "node:fs/promises";
    import { publishPluginCache } from ${JSON.stringify(publicationModule)};
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    await writeFile(${JSON.stringify(startedFiles[index])}, "started");
    await publishPluginCache({
      sourceRoot: ${JSON.stringify(sourceRoot)},
      cacheRoot: ${JSON.stringify(cacheRoot)},
      beforeRename: async () => {
        await writeFile(${JSON.stringify(readyFiles[index])}, "ready");
        while (true) {
          try { await access(${JSON.stringify(releaseFile)}); break; }
          catch { await delay(10); }
        }
      }
    });
  `;
  const runChild = (index) => execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", childCode(index)],
    { encoding: "utf8" }
  ).then(() => ({ ok: true })).catch((error) => ({ ok: false, error }));
  const children = [runChild(0), runChild(1)];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await Promise.all(startedFiles.map((file) => access(file).then(() => true).catch(() => false))).then((items) => items.every(Boolean))) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await Promise.all(readyFiles.map((file) => access(file).then(() => true).catch(() => false))).then((items) => items.some(Boolean))) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await writeFile(releaseFile, "release");
  const results = await Promise.all(children);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => !item.ok).length, 1);
  assert.equal((await checkPluginCache({ sourceRoot, cacheRoot })).ok, true);
  assert.deepEqual(
    (await readdir(cacheRoot)).filter((name) => name.includes(".publish.lock") || name.includes(".stage-")),
    []
  );
});

test("pending plugin cache recovery is bound to the consumed attempt and never republishes", async () => {
  const { repositoryRoot, sourceRoot } = await trackedSourceFixture("1.1.0+test.pending-recovery");
  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" })).stdout.trim();
  const sourceBinding = await captureSourceBinding(repositoryRoot, { baseRevision: baseline, requireClean: true });
  const pluginBundleDigest = await bundleDigest(sourceRoot);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-pending-recovery-")), "cache");
  const runId = "sbw-pending-recovery-run";
  const attemptId = "sbw-pending-recovery-attempt";
  const expectedSourceBinding = {
    pluginBundleDigest,
    sourceBaselineRevision: baseline,
    sourceBindingDigest: sourceBinding.digest,
    sourceHeadRevision: sourceBinding.headRevision
  };
  const published = await publishPluginCache({
    sourceRoot,
    cacheRoot,
    expectedSourceBinding,
    publicationIdentity: { runId, attemptId }
  });
  const targetBefore = await stat(published.target);
  const recovered = await recoverPendingPluginCachePublication({
    sourceRoot,
    cacheRoot,
    expectedSourceBinding,
    runId,
    attemptId
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.targetDigest, published.targetDigest);
  assert.equal((await stat(published.target)).size, targetBefore.size);
  await assert.rejects(
    recoverPendingPluginCachePublication({
      sourceRoot,
      cacheRoot,
      expectedSourceBinding,
      runId,
      attemptId: "different-attempt"
    }),
    /not bound to this action attempt/
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
