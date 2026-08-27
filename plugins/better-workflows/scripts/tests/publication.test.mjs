import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  bundleDigest,
  checkPluginCache,
  createProcessStartIdentityProbe,
  markPluginCacheReady,
  removeUnreadyPluginCachePublication,
  publishPluginCache,
  processIncarnationDigest,
  processLiveness,
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
  await mkdir(path.join(sourceRoot, "nested"));
  await writeFile(path.join(sourceRoot, "nested", "payload.txt"), "nested\n");
  return sourceRoot;
}

test("publication rejects an intermediate stage symlink without touching its external target", async () => {
  const version = "1.1.0+test.intermediate-stage-symlink";
  const sourceRoot = await sourceFixture(version);
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-intermediate-stage-"));
  const cacheRoot = path.join(parent, "cache");
  const external = path.join(parent, "external");
  const displaced = path.join(parent, "nested-displaced");
  await mkdir(cacheRoot);
  await mkdir(external);
  await writeFile(path.join(external, "sentinel.txt"), "outside\n");
  try {
    await assert.rejects(
      publishPluginCache({
        sourceRoot,
        cacheRoot,
        beforeRename: async ({ stage }) => {
          await rename(path.join(stage, "nested"), displaced);
          await symlink(external, path.join(stage, "nested"));
        }
      }),
      /ELOOP|symlink|cache|publication/
    );
    assert.equal(await readFile(path.join(external, "sentinel.txt"), "utf8"), "outside\n");
    await assert.rejects(access(path.join(cacheRoot, version)));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("unready cleanup removes an intermediate symlink as a leaf without touching its external target", async () => {
  const version = "1.1.0+test.intermediate-release-symlink";
  const sourceRoot = await sourceFixture(version);
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-intermediate-release-"));
  const cacheRoot = path.join(parent, "cache");
  const external = path.join(parent, "external");
  const displaced = path.join(parent, "nested-displaced");
  await mkdir(cacheRoot);
  await mkdir(external);
  await writeFile(path.join(external, "sentinel.txt"), "outside\n");
  try {
    const published = await publishPluginCache({
      sourceRoot,
      cacheRoot,
      publicationIdentity: {
        runId: "intermediate-release-run",
        attemptId: "intermediate-release-attempt"
      }
    });
    await removeUnreadyPluginCachePublication({
      cacheRoot,
      version,
      target: published.target,
      targetDigest: published.targetDigest,
      runId: "intermediate-release-run",
      attemptId: "intermediate-release-attempt",
      beforeTargetRemove: async ({ target }) => {
        await rename(path.join(target, "nested"), displaced);
        await symlink(external, path.join(target, "nested"));
      }
    });
    assert.equal(await readFile(path.join(external, "sentinel.txt"), "utf8"), "outside\n");
    await assert.rejects(access(published.target));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

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

test("plugin publication rejects a dirty source hidden by a local core.worktree redirect", async () => {
  const { repositoryRoot, sourceRoot } = await trackedSourceFixture("1.1.0+test.core-worktree");
  const redirected = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-core-worktree-redirect-"));
  await git(repositoryRoot, "config", "core.worktree", redirected);
  await writeFile(path.join(sourceRoot, "payload.txt"), "dirty source bytes\n");
  await assert.rejects(
    publishPluginCache({
      sourceRoot,
      cacheRoot: path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-core-worktree-cache-")), "cache")
    }),
    /core\.worktree configuration redirects away from|Git core\.worktree/
  );
});

test("publication rollback preserves a target replaced after rename", async () => {
  const version = "1.1.0+test.rollback-leaf-race";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-rollback-leaf-race-")), "cache");
  await assert.rejects(
    publishPluginCache({
      sourceRoot,
      cacheRoot,
      afterPublish: async ({ target }) => {
        await rm(target, { recursive: true, force: true });
        await mkdir(target, { recursive: true, mode: 0o700 });
        await writeFile(path.join(target, "foreign-rollback.txt"), "foreign rollback bytes\n");
        throw new Error("simulated post-rename publication failure");
      }
    }),
    /simulated post-rename publication failure|target rollback also failed/
  );
  const versionRoot = path.join(cacheRoot, version);
  assert.equal(await readFile(path.join(versionRoot, "foreign-rollback.txt"), "utf8"), "foreign rollback bytes\n");
  await assert.rejects(access(path.join(cacheRoot, `${version}.ready.json`)));
});

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
    (await readdir(cacheRoot)).filter((name) => !name.includes(".released-publication-") && (name.includes(".publish.lock") || name.includes(".stage-"))),
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

test("publication fails closed when the cache root is replaced before rename", async () => {
  const sourceRoot = await sourceFixture("1.1.0+test.cache-root-replacement");
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-cache-root-race-"));
  const cacheRoot = path.join(parent, "cache");
  const displaced = path.join(parent, "cache-displaced");
  const redirected = path.join(parent, "redirected");
  await mkdir(cacheRoot);
  await mkdir(redirected);
  try {
    await assert.rejects(
      publishPluginCache({
        sourceRoot,
        cacheRoot,
        beforeRename: async () => {
          await rename(cacheRoot, displaced);
          await symlink(redirected, cacheRoot);
        }
      }),
      /cache root identity changed|Unsafe cache directory/
    );
    assert.equal((await lstat(cacheRoot)).isSymbolicLink(), true);
    await assert.rejects(access(path.join(redirected, "1.1.0+test.cache-root-replacement")));
  } finally {
    await unlink(cacheRoot).catch(() => undefined);
    await rename(displaced, cacheRoot).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});

test("publication fails closed when a cache-root ancestor is replaced before rename", async () => {
  const sourceRoot = await sourceFixture("1.1.0+test.cache-parent-replacement");
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-cache-parent-race-"));
  const cacheRoot = path.join(parent, "cache");
  const displaced = `${parent}-displaced`;
  const redirected = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-cache-parent-redirect-"));
  await mkdir(cacheRoot);
  await mkdir(path.join(redirected, "cache"));
  try {
    await assert.rejects(
      publishPluginCache({
        sourceRoot,
        cacheRoot,
        beforeRename: async () => {
          await rename(parent, displaced);
          await symlink(redirected, parent);
        }
      }),
      /cache root identity changed|Unsafe cache directory/
    );
    assert.equal((await lstat(parent)).isSymbolicLink(), true);
    await assert.rejects(access(path.join(redirected, "cache", "1.1.0+test.cache-parent-replacement")));
  } finally {
    await unlink(parent).catch(() => undefined);
    await rename(displaced, parent).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
    await rm(redirected, { recursive: true, force: true });
  }
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
    (await readdir(cacheRoot)).filter((name) => !name.includes(".released-publication-") && (name.includes(".publish.lock") || name.includes(".stage-"))),
    []
  );
});

test("publication process liveness fails closed for an unobservable owner", async () => {
  const permissionError = Object.assign(new Error("process visibility denied"), { code: "EPERM" });
  const probe = () => { throw permissionError; };
  assert.equal(processLiveness(1234, probe), "unknown");
  assert.equal(
    await processIncarnationDigest(1234, {
      liveness: (pid) => processLiveness(pid, probe)
    }),
    "unknown"
  );
  const absentProbe = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
  assert.equal(processLiveness(1234, absentProbe), "absent");
});

test("publication process identity retries transient probes with a fixed budget", async () => {
  let startProbes = 0;
  let bootProbes = 0;
  const waits = [];
  const digest = await processIncarnationDigest(1234, {
    liveness: () => "alive",
    startIdentity: async () => {
      startProbes += 1;
      if (startProbes < 3) throw new Error("transient process start probe failure");
      return "123:456";
    },
    bootIdentity: async () => {
      bootProbes += 1;
      return "boot-id";
    },
    wait: async (milliseconds) => waits.push(milliseconds)
  });
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(startProbes, 3);
  assert.equal(bootProbes, 1);
  assert.deepEqual(waits, [50, 250]);
});

test("publication process identity exhaustion remains fail-closed", async () => {
  let startProbes = 0;
  let bootProbes = 0;
  const waits = [];
  const digest = await processIncarnationDigest(1234, {
    liveness: () => "alive",
    startIdentity: async () => {
      startProbes += 1;
      throw new Error("persistent process start probe failure");
    },
    bootIdentity: async () => {
      bootProbes += 1;
      return "boot-id";
    },
    wait: async (milliseconds) => waits.push(milliseconds)
  });
  assert.equal(digest, "unknown");
  assert.equal(startProbes, 3);
  assert.equal(bootProbes, 0);
  assert.deepEqual(waits, [50, 250]);
});

test("publication process identity does not probe an initially absent or unknown owner", async () => {
  for (const [liveness, expected] of [["absent", null], ["unknown", "unknown"]]) {
    let probes = 0;
    let waits = 0;
    assert.equal(await processIncarnationDigest(1234, {
      liveness: () => liveness,
      startIdentity: async () => { probes += 1; return "123:456"; },
      bootIdentity: async () => { probes += 1; return "boot-id"; },
      wait: async () => { waits += 1; }
    }), expected);
    assert.equal(probes, 0);
    assert.equal(waits, 0);
  }
});

test("publication process identity stops retrying when liveness changes", async () => {
  for (const [transition, expected] of [["absent", null], ["unknown", "unknown"]]) {
    const livenessStates = ["alive", transition];
    let startProbes = 0;
    let waits = 0;
    assert.equal(await processIncarnationDigest(1234, {
      liveness: () => livenessStates.shift() ?? transition,
      startIdentity: async () => {
        startProbes += 1;
        throw new Error("process identity probe failed during transition");
      },
      bootIdentity: async () => "boot-id",
      wait: async () => { waits += 1; }
    }), expected);
    assert.equal(startProbes, 1);
    assert.equal(waits, 0);
  }
});

test("publication process identity refreshes both components after a boot probe failure", async () => {
  let startProbes = 0;
  let bootProbes = 0;
  let waits = 0;
  const digest = await processIncarnationDigest(1234, {
    liveness: () => "alive",
    startIdentity: async () => {
      startProbes += 1;
      return `123:${startProbes}`;
    },
    bootIdentity: async () => {
      bootProbes += 1;
      if (bootProbes === 1) throw new Error("transient boot identity probe failure");
      return "boot-id";
    },
    wait: async () => { waits += 1; }
  });
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(startProbes, 2);
  assert.equal(bootProbes, 2);
  assert.equal(waits, 1);
});

test("publication process identity caches only a validated Darwin self identity", async () => {
  let startProbes = 0;
  let livenessProbes = 0;
  const startIdentity = createProcessStartIdentityProbe({
    platform: "darwin",
    selfPid: 1234,
    darwinProbe: async () => {
      startProbes += 1;
      return "123:456";
    }
  });
  const options = {
    liveness: () => {
      livenessProbes += 1;
      return "alive";
    },
    startIdentity,
    bootIdentity: async () => "boot-id"
  };
  assert.match(await processIncarnationDigest(1234, options), /^[a-f0-9]{64}$/);
  assert.match(await processIncarnationDigest(1234, options), /^[a-f0-9]{64}$/);
  assert.equal(startProbes, 1);
  assert.equal(livenessProbes, 4);
});

test("publication process identity does not cache failed or malformed Darwin self probes", async () => {
  const outcomes = [new Error("transient"), "", "malformed", "123:456"];
  let startProbes = 0;
  const startIdentity = createProcessStartIdentityProbe({
    platform: "darwin",
    selfPid: 1234,
    darwinProbe: async () => {
      const value = outcomes[startProbes];
      startProbes += 1;
      if (value instanceof Error) throw value;
      return value;
    }
  });
  await assert.rejects(startIdentity(1234), /transient/);
  await assert.rejects(startIdentity(1234), /malformed/);
  await assert.rejects(startIdentity(1234), /malformed/);
  assert.equal(await startIdentity(1234), "123:456");
  assert.equal(await startIdentity(1234), "123:456");
  assert.equal(startProbes, 4);
});

test("publication process identity never caches an external Darwin PID", async () => {
  let startProbes = 0;
  const startIdentity = createProcessStartIdentityProbe({
    platform: "darwin",
    selfPid: 1234,
    darwinProbe: async () => {
      startProbes += 1;
      return `789:${startProbes}`;
    }
  });
  assert.equal(await startIdentity(789), "789:1");
  assert.equal(await startIdentity(789), "789:2");
  assert.equal(startProbes, 2);
});

test("publication process identity shares an in-flight Darwin self probe and retries a shared rejection", async () => {
  let startProbes = 0;
  let rejectFirstProbe;
  const firstProbe = new Promise((resolve, reject) => { rejectFirstProbe = reject; });
  const startIdentity = createProcessStartIdentityProbe({
    platform: "darwin",
    selfPid: 1234,
    darwinProbe: async () => {
      startProbes += 1;
      if (startProbes === 1) return firstProbe;
      return "123:456";
    }
  });
  const pending = Promise.allSettled([startIdentity(1234), startIdentity(1234)]);
  rejectFirstProbe(new Error("shared transient rejection"));
  const shared = await pending;
  assert.equal(startProbes, 1);
  assert.deepEqual(shared.map((item) => item.status), ["rejected", "rejected"]);
  assert.match(shared[0].reason.message, /shared transient rejection/);
  assert.equal(await startIdentity(1234), "123:456");
  assert.equal(startProbes, 2);
});

test("a live separate publisher retains its process-incarnation lease", async () => {
  const version = "1.1.0+test.live-cross-process-lease";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-live-owner-")), "cache");
  const ownerReady = path.join(path.dirname(cacheRoot), "owner-ready");
  const publicationModule = pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "lib", "publication.mjs")).href;
  const childCode = `
    import { writeFile } from "node:fs/promises";
    import { publishPluginCache } from ${JSON.stringify(publicationModule)};
    await publishPluginCache({
      sourceRoot: ${JSON.stringify(sourceRoot)},
      cacheRoot: ${JSON.stringify(cacheRoot)},
      beforeRename: async () => {
        await writeFile(${JSON.stringify(ownerReady)}, "ready\\n");
        await new Promise(() => setInterval(() => undefined, 1000));
      }
    });
  `;
  const child = execFile(process.execPath, ["--input-type=module", "-e", childCode], { encoding: "utf8" }, () => undefined);
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await access(ownerReady).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await access(ownerReady);
    const lockName = (await readdir(cacheRoot)).find((name) => name.includes(".publish.lock-ready-"));
    assert.ok(lockName);
    const lockPath = path.join(cacheRoot, lockName);
    const before = await readFile(lockPath, "utf8");
    const owner = JSON.parse(before);
    assert.equal(owner.pid, child.pid);
    assert.match(owner.processStartDigest, /^[a-f0-9]{64}$/);
    await assert.rejects(
      publishPluginCache({ sourceRoot, cacheRoot }),
      /publication is already in progress|publication contenders did not settle/
    );
    assert.equal(await readFile(lockPath, "utf8"), before);
  } finally {
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
  }
  const published = await publishPluginCache({ sourceRoot, cacheRoot });
  assert.equal(published.ok, true);
  assert.equal(published.applied, true);
});

test("a published preparing lease blocks a later publisher before election", async () => {
  const version = "1.1.0+test.preparing-lease";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-preparing-lease-")), "cache");
  await mkdir(cacheRoot, { recursive: true });
  const ownerToken = "00000000-0000-4000-8000-000000000099";
  const preparingPath = path.join(cacheRoot, `.${version}.publish.lock-preparing-${ownerToken}`);
  await writeFile(preparingPath, `${JSON.stringify({
    version,
    pid: process.pid,
    ownerToken,
    createdAt: new Date().toISOString()
  })}\n`, { mode: 0o600 });

  await assert.rejects(
    publishPluginCache({ sourceRoot, cacheRoot }),
    /publication contenders did not settle/
  );
  assert.equal(JSON.parse(await readFile(preparingPath, "utf8")).ownerToken, ownerToken);
  await unlink(preparingPath);
  assert.equal((await publishPluginCache({ sourceRoot, cacheRoot })).ok, true);
});

test("publication reclaims a stale lease when its pid was reused by a different process incarnation", async () => {
  const version = "1.1.0+test.pid-reuse";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-pid-reuse-")), "cache");
  await mkdir(cacheRoot, { recursive: true });
  const ownerToken = "00000000-0000-4000-8000-000000000088";
  const stalePath = path.join(cacheRoot, `.${version}.publish.lock-ready-1-${ownerToken}`);
  await writeFile(stalePath, `${JSON.stringify({
    version,
    pid: process.pid,
    processStartDigest: "0".repeat(64),
    ownerToken,
    createdAt: "2020-01-01T00:00:00.000Z"
  })}\n`, { mode: 0o600 });

  const published = await publishPluginCache({ sourceRoot, cacheRoot });
  assert.equal(published.ok, true);
  await assert.rejects(access(stalePath));
});

test("stale-lock quarantine preserves a live pathname replacement and fails closed", async () => {
  const version = "1.1.0+test.stale-replacement-race";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-stale-replacement-")), "cache");
  await mkdir(cacheRoot, { recursive: true });
  const staleOwner = "00000000-0000-4000-8000-000000000077";
  const stalePath = path.join(cacheRoot, `.${version}.publish.lock-ready-1-${staleOwner}`);
  await writeFile(stalePath, `${JSON.stringify({
    version,
    pid: 999999999,
    processStartDigest: "0".repeat(64),
    ownerToken: staleOwner,
    createdAt: "2020-01-01T00:00:00.000Z"
  })}\n`, { mode: 0o600 });
  const replacement = {
    version,
    pid: process.pid,
    ownerToken: "live-replacement-owner",
    createdAt: new Date().toISOString()
  };
  let replaced = false;
  await assert.rejects(
    publishPluginCache({
      sourceRoot,
      cacheRoot,
      afterStaleLockValidated: async ({ lockPath }) => {
        if (replaced || lockPath !== stalePath) return;
        replaced = true;
        await unlink(lockPath);
        await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      }
    }),
    /lock identity changed while quarantining/
  );
  assert.equal(replaced, true);
  await assert.rejects(access(stalePath));
  const quarantine = (await readdir(cacheRoot)).find((name) => name.includes(".publish.lock.foreign-"));
  assert.ok(quarantine);
  assert.deepEqual(JSON.parse(await readFile(path.join(cacheRoot, quarantine), "utf8")), replacement);
  await assert.rejects(
    publishPluginCache({ sourceRoot, cacheRoot }),
    /publication is already in progress|publication contenders did not settle|lock owner cannot be proven absent/
  );
});

test("stale-lock release preserves a final pathname replacement and fails closed", async () => {
  const version = "1.1.0+test.stale-release-replacement";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-stale-release-replacement-")), "cache");
  await mkdir(cacheRoot, { recursive: true });
  const staleOwner = "00000000-0000-4000-8000-000000000078";
  const stalePath = path.join(cacheRoot, `.${version}.publish.lock-ready-1-${staleOwner}`);
  await writeFile(stalePath, `${JSON.stringify({
    version,
    pid: 999999999,
    processStartDigest: "0".repeat(64),
    ownerToken: staleOwner,
    createdAt: "2020-01-01T00:00:00.000Z"
  })}\n`, { mode: 0o600 });
  const replacement = {
    version,
    pid: 999999999,
    ownerToken: "final-release-replacement-owner",
    createdAt: new Date().toISOString()
  };
  let replaced = false;
  await assert.rejects(
    publishPluginCache({
      sourceRoot,
      cacheRoot,
      beforeStaleLockRelease: async ({ quarantinePath }) => {
        if (replaced) return;
        replaced = true;
        await unlink(quarantinePath);
        await writeFile(quarantinePath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      }
    }),
    /identity changed while releasing/
  );
  assert.equal(replaced, true);
  const foreign = (await readdir(cacheRoot)).find((name) => name.includes(".publish.lock.foreign-"));
  assert.ok(foreign);
  assert.deepEqual(JSON.parse(await readFile(path.join(cacheRoot, foreign), "utf8")), replacement);
  await assert.rejects(
    publishPluginCache({ sourceRoot, cacheRoot }),
    /owner cannot be proven absent|publication is already in progress|publication contenders did not settle/
  );
});

test("stale-lock quarantine permanently blocks a dead-pid pathname replacement", async () => {
  const version = "1.1.0+test.stale-replacement-dead-pid";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-stale-dead-replacement-")), "cache");
  await mkdir(cacheRoot, { recursive: true });
  const staleOwner = "00000000-0000-4000-8000-000000000099";
  const stalePath = path.join(cacheRoot, `.${version}.publish.lock-ready-1-${staleOwner}`);
  await writeFile(stalePath, `${JSON.stringify({
    version,
    pid: 999999999,
    processStartDigest: "0".repeat(64),
    ownerToken: staleOwner,
    createdAt: "2020-01-01T00:00:00.000Z"
  })}\n`, { mode: 0o600 });
  const replacement = {
    version,
    pid: 999999999,
    ownerToken: "dead-replacement-owner",
    createdAt: new Date().toISOString()
  };
  await assert.rejects(
    publishPluginCache({
      sourceRoot,
      cacheRoot,
      afterStaleLockValidated: async ({ lockPath }) => {
        await unlink(lockPath);
        await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      }
    }),
    /lock identity changed while quarantining/
  );
  const foreign = (await readdir(cacheRoot)).find((name) => name.includes(".publish.lock.foreign-"));
  assert.ok(foreign);
  assert.deepEqual(JSON.parse(await readFile(path.join(cacheRoot, foreign), "utf8")), replacement);
  await assert.rejects(
    publishPluginCache({ sourceRoot, cacheRoot }),
    /owner cannot be proven absent|publication is already in progress|publication contenders did not settle/
  );
  assert.deepEqual(JSON.parse(await readFile(path.join(cacheRoot, foreign), "utf8")), replacement);
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

test("unready cleanup preserves a marker replaced after ownership verification", async () => {
  const version = "1.1.0+test.marker-leaf-race";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-marker-leaf-race-")), "cache");
  const identity = { runId: "sbw-marker-leaf-race-run", attemptId: "sbw-marker-leaf-race-attempt" };
  const published = await publishPluginCache({ sourceRoot, cacheRoot, publicationIdentity: identity });
  const markerPath = path.join(cacheRoot, `${version}.ready.json`);
  const foreignMarker = { ...JSON.parse(await readFile(markerPath, "utf8")), runId: "foreign-marker-race-run" };
  await assert.rejects(
    removeUnreadyPluginCachePublication({
      cacheRoot,
      version,
      target: published.target,
      targetDigest: published.targetDigest,
      runId: identity.runId,
      attemptId: identity.attemptId,
      beforeMarkerRemove: async () => {
        await writeFile(markerPath, `${JSON.stringify(foreignMarker)}\n`, { mode: 0o600 });
      }
    }),
    /exact owned pending publication marker|publication marker ownership changed/
  );
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), foreignMarker);
  assert.equal((await bundleDigest(published.target)), published.targetDigest);
});

test("unready cleanup preserves a target replaced after digest verification", async () => {
  const version = "1.1.0+test.target-leaf-race";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-target-leaf-race-")), "cache");
  const identity = { runId: "sbw-target-leaf-race-run", attemptId: "sbw-target-leaf-race-attempt" };
  const published = await publishPluginCache({ sourceRoot, cacheRoot, publicationIdentity: identity });
  await assert.rejects(
    removeUnreadyPluginCachePublication({
      cacheRoot,
      version,
      target: published.target,
      targetDigest: published.targetDigest,
      runId: identity.runId,
      attemptId: identity.attemptId,
      beforeTargetRemove: async () => {
        await rm(published.target, { recursive: true, force: true });
        await mkdir(published.target, { recursive: true, mode: 0o700 });
        await writeFile(path.join(published.target, "foreign.txt"), "foreign target bytes\n");
      }
    }),
    /identity changed|EAGAIN/
  );
  assert.equal(await readFile(path.join(published.target, "foreign.txt"), "utf8"), "foreign target bytes\n");
  assert.equal(JSON.parse(await readFile(path.join(cacheRoot, `${version}.ready.json`), "utf8")).state, "pending");
});

test("ready marker commit preserves a target replaced after digest verification", async () => {
  const version = "1.1.0+test.ready-leaf-race";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-ready-leaf-race-")), "cache");
  const identity = { runId: "sbw-ready-leaf-race-run", attemptId: "sbw-ready-leaf-race-attempt" };
  const published = await publishPluginCache({ sourceRoot, cacheRoot, publicationIdentity: identity });
  await assert.rejects(
    markPluginCacheReady({
      cacheRoot,
      version,
      target: published.target,
      targetDigest: published.targetDigest,
      sourceDigest: published.sourceDigest,
      runId: identity.runId,
      attemptId: identity.attemptId,
      beforeMarkerCommit: async () => {
        await rm(published.target, { recursive: true, force: true });
        await mkdir(published.target, { recursive: true, mode: 0o700 });
        await writeFile(path.join(published.target, "foreign.txt"), "foreign ready bytes\n");
      }
    }),
    /guard identity changed|target identity changed/
  );
  assert.equal(await readFile(path.join(published.target, "foreign.txt"), "utf8"), "foreign ready bytes\n");
  assert.equal(JSON.parse(await readFile(path.join(cacheRoot, `${version}.ready.json`), "utf8")).state, "pending");
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
    (await readdir(cacheRoot)).filter((name) => !name.includes(".released-publication-") && (name.includes(".publish.lock") || name.includes(".stage-"))),
    []
  );
});

test("plugin cache publication reclaims a released 3.2.4 stale-lock quarantine", async () => {
  const version = "1.1.0+test.legacy-stale-lock-quarantine";
  const sourceRoot = await sourceFixture(version);
  const cacheRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-legacy-stale-lock-")), "cache");
  await mkdir(cacheRoot, { recursive: true });
  const legacyLock = path.join(cacheRoot, `.${version}.publish.lock.stale-00000000-0000-4000-8000-000000000001`);
  await writeFile(
    legacyLock,
    `${JSON.stringify({
      version,
      pid: 999999999,
      ownerToken: "legacy-dead-owner",
      createdAt: "2020-01-01T00:00:00.000Z"
    })}\n`,
    { mode: 0o600 }
  );

  const published = await publishPluginCache({ sourceRoot, cacheRoot });
  assert.equal((await checkPluginCache({ sourceRoot, cacheRoot })).ok, true);
  await assert.rejects(access(legacyLock), { code: "ENOENT" });
  assert.equal((await bundleDigest(published.target)), published.targetDigest);
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
  const markerPath = path.join(cacheRoot, `${published.version}.ready.json`);
  const originalMarker = JSON.parse(await readFile(markerPath, "utf8"));
  await assert.rejects(
    recoverPendingPluginCachePublication({
      sourceRoot,
      cacheRoot,
      expectedSourceBinding,
      runId,
      attemptId,
      beforeLock: async () => {
        await writeFile(markerPath, `${JSON.stringify({ ...originalMarker, attemptId: "swapped-at-lock-boundary" })}\n`, { mode: 0o600 });
      }
    }),
    /marker changed while acquiring its publication lease/
  );
  await writeFile(markerPath, `${JSON.stringify(originalMarker)}\n`, { mode: 0o600 });
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

test("pending recovery fails closed when the cache root is replaced after lease acquisition", async () => {
  const { repositoryRoot, sourceRoot } = await trackedSourceFixture("1.1.0+test.pending-root-replacement");
  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" })).stdout.trim();
  const sourceBinding = await captureSourceBinding(repositoryRoot, { baseRevision: baseline, requireClean: true });
  const pluginBundleDigest = await bundleDigest(sourceRoot);
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-pending-root-replacement-"));
  const cacheRoot = path.join(parent, "cache");
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
    publicationIdentity: { runId: "pending-root-run", attemptId: "pending-root-attempt" }
  });
  const moved = `${cacheRoot}.original`;
  const replacement = path.join(parent, "replacement");
  await mkdir(replacement, { mode: 0o700 });
  try {
    await assert.rejects(
      recoverPendingPluginCachePublication({
        sourceRoot,
        cacheRoot,
        expectedSourceBinding,
        runId: "pending-root-run",
        attemptId: "pending-root-attempt",
        afterLock: async () => {
          await rename(cacheRoot, moved);
          await symlink(replacement, cacheRoot);
        }
      }),
      /cache root identity changed/
    );
  } finally {
    await unlink(cacheRoot).catch(() => undefined);
    await rename(moved, cacheRoot).catch(() => undefined);
    await rm(published.target, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("pending recovery fails closed when a cache-root ancestor is replaced after lease acquisition", async () => {
  const { repositoryRoot, sourceRoot } = await trackedSourceFixture("1.1.0+test.pending-ancestor-replacement");
  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" })).stdout.trim();
  const sourceBinding = await captureSourceBinding(repositoryRoot, { baseRevision: baseline, requireClean: true });
  const pluginBundleDigest = await bundleDigest(sourceRoot);
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-publication-pending-ancestor-replacement-"));
  const cacheParent = path.join(parent, "cache-parent");
  const cacheRoot = path.join(cacheParent, "cache");
  await mkdir(cacheParent, { recursive: true, mode: 0o700 });
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
    publicationIdentity: { runId: "pending-ancestor-run", attemptId: "pending-ancestor-attempt" }
  });
  const movedParent = `${cacheParent}.original`;
  const replacement = path.join(parent, "ancestor-replacement");
  await mkdir(replacement, { mode: 0o700 });
  try {
    await assert.rejects(
      recoverPendingPluginCachePublication({
        sourceRoot,
        cacheRoot,
        expectedSourceBinding,
        runId: "pending-ancestor-run",
        attemptId: "pending-ancestor-attempt",
        afterLock: async () => {
          await rename(cacheParent, movedParent);
          await mkdir(cacheParent, { mode: 0o700 });
          await symlink(replacement, cacheRoot);
        }
      }),
      /cache root identity changed/
    );
  } finally {
    await unlink(cacheRoot).catch(() => undefined);
    await rm(cacheParent, { recursive: true, force: true }).catch(() => undefined);
    await rename(movedParent, cacheParent).catch(() => undefined);
    await rm(published.target, { recursive: true, force: true }).catch(() => undefined);
  }
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
  const decoy = await trackedSourceFixture("1.1.0+test.hidden-index-decoy");
  const target = path.join(sourceRoot, "payload.txt");
  await git(repositoryRoot, "update-index", "--assume-unchanged", "plugins/better-workflows/payload.txt");
  const previousGit = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE
  };
  process.env.GIT_DIR = path.join(decoy.repositoryRoot, ".git");
  process.env.GIT_WORK_TREE = decoy.repositoryRoot;
  process.env.GIT_INDEX_FILE = path.join(decoy.repositoryRoot, ".git", "index");
  try {
    await assert.rejects(
      checkPluginCache({ sourceRoot, cacheRoot: path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-publication-hidden-")), "cache") }),
      /hidden tracked index flags/
    );
  } finally {
    for (const [key, value] of Object.entries(previousGit)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
  assert.deepEqual((await readdir(cacheRoot)).filter((name) => !name.includes(".released-publication-")), []);
});
