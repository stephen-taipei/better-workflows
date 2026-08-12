import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildContract, loadDefaults } from "../lib/core.mjs";
import { captureSentinel, captureSourceBinding, compareSentinels, runSourceGit } from "../lib/git.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function repository() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sbw-git-"));
  await git(cwd, "init", "-q", "-b", "dev");
  await git(cwd, "config", "user.name", "Stephen Better Workflows Tests");
  await git(cwd, "config", "user.email", "sbw-tests@example.invalid");
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "a.txt"), "alpha\n");
  await writeFile(path.join(cwd, "src", "b.txt"), "beta\n");
  await symlink("a.txt", path.join(cwd, "src", "link"));
  await writeFile(path.join(cwd, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(path.join(cwd, ".gitignore"), ".secrets-marker\nnode_modules\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "test fixture");
  return cwd;
}

function taskContract() {
  return buildContract({
    template: "test",
    templateDefinition: {
      acceptance: [{ id: "done", description: "Done", critical: true }]
    },
    goal: "Capture repository authority",
    scope: ["src"],
    risk: { risk: 1, uncertainty: 1, blastRadius: 1, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    highRiskIgnored: [".secrets-marker"]
  });
}

test("bounded sentinel detects tracked, untracked, symlink, and high-risk ignored drift", async () => {
  const cwd = await repository();
  const defaults = await loadDefaults();
  const before = await captureSentinel(cwd, taskContract(), defaults);
  assert.equal(before.complete, true);
  assert.equal(before.symlinks.records.length, 1);
  assert.equal(before.attributes.records.length, 1);

  await writeFile(path.join(cwd, "src", "untracked.txt"), "new\n");
  await writeFile(path.join(cwd, ".secrets-marker"), "changed\n");
  await unlink(path.join(cwd, "src", "link"));
  await symlink("b.txt", path.join(cwd, "src", "link"));

  const after = await captureSentinel(cwd, taskContract(), defaults);
  const comparison = compareSentinels(before, after);
  assert.equal(comparison.same, false);
  assert.ok(comparison.changed.includes("statusDigest"));
  assert.ok(comparison.changed.includes("scopeDigest"));
  assert.ok(comparison.changed.includes("symlinks"));
  assert.ok(comparison.changed.includes("highRiskIgnored"));
});

test("volatile exclusions are explicit and do not pretend to be complete coverage", async () => {
  const cwd = await repository();
  const defaults = await loadDefaults();
  const before = await captureSentinel(cwd, taskContract(), defaults);
  await mkdir(path.join(cwd, "node_modules"));
  await writeFile(path.join(cwd, "node_modules", "volatile.js"), "noise\n");
  const after = await captureSentinel(cwd, taskContract(), defaults);
  assert.ok(after.exclusions.includes("node_modules"));
  assert.equal(compareSentinels(before, after).same, true);
});

test("source bindings pin base, head, and the exact diff manifest", async () => {
  const cwd = await repository();
  const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" })).stdout.trim();
  const before = await captureSourceBinding(cwd, { baseRevision: base });
  assert.equal(before.baseRevision, base);
  assert.equal(before.headRevision, base);
  assert.match(before.diffManifestDigest, /^[a-f0-9]{64}$/);

  await writeFile(path.join(cwd, "src", "a.txt"), "changed\n");
  await git(cwd, "add", "src/a.txt");
  await git(cwd, "commit", "-qm", "change source");
  const afterCommit = await captureSourceBinding(cwd, { baseRevision: base });
  assert.equal(afterCommit.worktreeClean, true);
  assert.notEqual(afterCommit.digest, before.digest);
  assert.notEqual(afterCommit.headRevision, before.headRevision);
  assert.notEqual(afterCommit.diffManifestDigest, before.diffManifestDigest);

  await writeFile(path.join(cwd, "src", "untracked.txt"), "untracked\n");
  const afterWorktree = await captureSourceBinding(cwd, { baseRevision: base });
  assert.equal(afterWorktree.worktreeClean, false);
  assert.notEqual(afterWorktree.digest, afterCommit.digest);
  assert.equal(afterWorktree.diffManifestDigest, afterCommit.diffManifestDigest);
  await assert.rejects(
    captureSourceBinding(cwd, { baseRevision: base, requireClean: true }),
    /clean index, tracked worktree, untracked surface, and ignored surface/
  );
});

test("source binding and sentinel reject legacy graft ancestry metadata", async () => {
  const cwd = await repository();
  const defaults = await loadDefaults();
  const commonDir = await realpath(path.join(cwd, ".git"));
  const graftsPath = path.join(commonDir, "info", "grafts");
  await writeFile(graftsPath, "# even an empty legacy graft authority surface is forbidden\n");
  await assert.rejects(captureSourceBinding(cwd), /Legacy Git graft ancestry metadata is not allowed/);
  await assert.rejects(
    captureSentinel(cwd, taskContract(), defaults),
    /Legacy Git graft ancestry metadata is not allowed/
  );
  await unlink(graftsPath);

  const linked = path.join(os.tmpdir(), `sbw-git-graft-linked-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await git(cwd, "worktree", "add", "-q", linked);
  const linkedGitDirOutput = (await execFileAsync("git", ["rev-parse", "--git-dir"], {
    cwd: linked,
    encoding: "utf8"
  })).stdout.trim();
  const linkedGitDir = await realpath(path.resolve(linked, linkedGitDirOutput));
  await mkdir(path.join(linkedGitDir, "info"), { recursive: true });
  await writeFile(path.join(linkedGitDir, "info", "grafts"), "# worktree-local graft surface\n");
  await assert.rejects(captureSourceBinding(linked), /Legacy Git graft ancestry metadata is not allowed/);
  await assert.rejects(
    captureSentinel(linked, taskContract(), defaults),
    /Legacy Git graft ancestry metadata is not allowed/
  );
});

test("source binding and sentinel reject shallow repository ancestry", async () => {
  const cwd = await repository();
  const defaults = await loadDefaults();
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8"
  })).stdout.trim();
  await writeFile(path.join(cwd, ".git", "shallow"), `${head}\n`);
  await assert.rejects(
    captureSourceBinding(cwd),
    /Shallow Git repositories are not allowed for immutable ancestry proofs/
  );
  await assert.rejects(
    captureSentinel(cwd, taskContract(), defaults),
    /Shallow Git repositories are not allowed for immutable ancestry proofs/
  );
});

test("runSourceGit preserves invalid UTF-8 and NUL bytes in committed objects", async () => {
  const cwd = await repository();
  const expected = Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x00, 0x80, 0xfe, 0x0a]);
  await writeFile(path.join(cwd, "src", "bytes.dat"), expected);
  await git(cwd, "add", "src/bytes.dat");
  await git(cwd, "commit", "-qm", "binary object fixture");
  const result = await runSourceGit(cwd, ["show", "HEAD:src/bytes.dat"], { encoding: "buffer" });
  assert.equal(Buffer.isBuffer(result.stdout), true);
  assert.deepEqual(result.stdout, expected);
});

test("source binding rejects a concurrent commit during the final stability check", async () => {
  const cwd = await repository();
  const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" })).stdout.trim();
  await assert.rejects(
    captureSourceBinding(cwd, {
      baseRevision: base,
      beforeFinalCheck: async () => {
        await writeFile(path.join(cwd, "src", "a.txt"), "concurrent commit\n");
        await git(cwd, "add", "src/a.txt");
        await git(cwd, "commit", "-qm", "concurrent source advance");
      }
    }),
    /changed during stable snapshot capture/
  );
});

test("source binding rejects a remote URL mutation during the final stability check", async () => {
  const cwd = await repository();
  await git(cwd, "remote", "add", "origin", "https://example.invalid/initial.git");
  await assert.rejects(
    captureSourceBinding(cwd, {
      beforeFinalCheck: () => git(cwd, "config", "remote.origin.url", "https://example.invalid/changed.git")
    }),
    /changed during stable snapshot capture/
  );
});

test("source bindings include canonical worktree, common-dir, and origin identity", async () => {
  const cwd = await repository();
  await git(cwd, "remote", "add", "origin", "https://example.invalid/better-workflows.git");
  const primary = await captureSourceBinding(cwd);
  assert.equal(primary.repositoryRoot, await realpath(cwd));
  assert.equal(primary.gitCommonDir.path, await realpath(path.join(cwd, ".git")));
  assert.equal(primary.originIdentity.present, true);
  assert.match(primary.originIdentity.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(primary.originIdentity.fetchUrls, ["https://example.invalid/better-workflows.git"]);
  assert.deepEqual(primary.originIdentity.pushUrls, []);

  await git(cwd, "config", "remote.origin.pushurl", "https://example.invalid/better-workflows-push.git");
  const withPushUrl = await captureSourceBinding(cwd);
  assert.deepEqual(withPushUrl.originIdentity.pushUrls, ["https://example.invalid/better-workflows-push.git"]);
  assert.notEqual(withPushUrl.digest, primary.digest);
  await git(cwd, "config", "--unset-all", "remote.origin.pushurl");

  const linked = path.join(os.tmpdir(), `sbw-git-linked-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await git(cwd, "worktree", "add", "-q", linked);
  const linkedBinding = await captureSourceBinding(linked);
  assert.notEqual(linkedBinding.gitDir.path, primary.gitDir.path);
  assert.equal(linkedBinding.gitCommonDir.path, primary.gitCommonDir.path);
  assert.notEqual(linkedBinding.digest, primary.digest);
});

test("source binding never treats oversized raw pushurl output as absence", async () => {
  const cwd = await repository();
  await git(cwd, "remote", "add", "origin", "https://github.com/example/repository.git");
  const configPath = path.join(cwd, ".git", "config");
  const config = await readFile(configPath, "utf8");
  await writeFile(configPath, `${config}\n[remote "origin"]\n\tpushurl = https://github.com/example/${"p".repeat(4 * 1024 * 1024 + 4096)}.git\n`);
  await assert.rejects(captureSourceBinding(cwd), /output exceeded/);
});

test("source bindings use the pinned Git executable instead of an ambient PATH shadow", async () => {
  const cwd = await repository();
  const expected = await captureSourceBinding(cwd);
  const shadowRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-git-shadow-"));
  await writeFile(path.join(shadowRoot, "git"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = shadowRoot;
  try {
    assert.deepEqual(await captureSourceBinding(cwd), expected);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test("source authority rejects a repository-local core.worktree redirect", async () => {
  const cwd = await repository();
  const redirected = await mkdtemp(path.join(os.tmpdir(), "sbw-git-core-worktree-redirect-"));
  await git(cwd, "config", "core.worktree", redirected);
  await writeFile(path.join(cwd, "src", "a.txt"), "dirty source bytes\n");
  await assert.rejects(
    captureSourceBinding(cwd),
    /core\.worktree configuration redirects away from|Git core\.worktree/
  );
  await assert.rejects(
    runSourceGit(cwd, ["status", "--porcelain"], { allowFailure: true }),
    /core\.worktree configuration redirects away from|Git core\.worktree/
  );
});

test("source bindings ignore mutable global Git URL rewrites", async () => {
  const cwd = await repository();
  await git(cwd, "remote", "add", "origin", "https://example.invalid/better-workflows.git");
  const expected = await captureSourceBinding(cwd);
  const globalConfig = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-git-global-config-")), "config");
  await writeFile(globalConfig, [
    '[url "ssh://rewritten.invalid/"]',
    "\tinsteadOf = https://example.invalid/",
    ""
  ].join("\n"));
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try {
    const rewritten = (await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }
    })).stdout.trim();
    assert.equal(rewritten, "ssh://rewritten.invalid/better-workflows.git");
    assert.deepEqual(await captureSourceBinding(cwd), expected);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
});

test("source bindings ignore command-scoped Git configuration", async () => {
  const cwd = await repository();
  await git(cwd, "remote", "add", "origin", "https://example.invalid/better-workflows.git");
  const expected = await captureSourceBinding(cwd);
  const injected = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url.ssh://rewritten.invalid/.insteadOf",
    GIT_CONFIG_VALUE_0: "https://example.invalid/",
    GIT_CONFIG_PARAMETERS: "'url.ssh://parameters.invalid/.insteadOf'='https://parameters.invalid/'"
  };
  const previous = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]));
  Object.assign(process.env, injected);
  try {
    assert.deepEqual(await captureSourceBinding(cwd), expected);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("source bindings ignore inherited Git repository and object routing", async () => {
  const cwd = await repository();
  const decoy = await repository();
  const expected = await captureSourceBinding(cwd);
  const injected = {
    GIT_DIR: path.join(decoy, ".git"),
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: path.join(decoy, ".git", "index"),
    GIT_COMMON_DIR: path.join(decoy, ".git"),
    GIT_OBJECT_DIRECTORY: path.join(decoy, ".git", "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(cwd, ".git", "objects"),
    GIT_NAMESPACE: "untrusted-namespace",
    GIT_REPLACE_REF_BASE: "refs/untrusted-replacements/",
    GIT_GRAFT_FILE: path.join(decoy, ".git", "info", "grafts"),
    GIT_SHALLOW_FILE: path.join(decoy, ".git", "shallow")
  };
  const previous = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]));
  Object.assign(process.env, injected);
  try {
    assert.deepEqual(await captureSourceBinding(cwd), expected);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("source bindings reject hidden assume-unchanged and skip-worktree tracked flags", async () => {
  const cwd = await repository();
  const tracked = "src/a.txt";
  try {
    await git(cwd, "update-index", "--assume-unchanged", tracked);
    const assumed = await captureSourceBinding(cwd, { requireClean: false });
    assert.equal(assumed.worktreeClean, false);
    assert.equal(assumed.hiddenIndexCount, 1);
    await assert.rejects(
      captureSourceBinding(cwd, { requireClean: true }),
      /visible tracked index flags/
    );
    await git(cwd, "update-index", "--no-assume-unchanged", tracked);
    await git(cwd, "update-index", "--skip-worktree", tracked);
    const skipped = await captureSourceBinding(cwd, { requireClean: false });
    assert.equal(skipped.worktreeClean, false);
    assert.equal(skipped.hiddenIndexCount, 1);
    await assert.rejects(
      captureSourceBinding(cwd, { requireClean: true }),
      /visible tracked index flags/
    );
  } finally {
    await git(cwd, "update-index", "--no-assume-unchanged", tracked).catch(() => undefined);
    await git(cwd, "update-index", "--no-skip-worktree", tracked).catch(() => undefined);
  }
});
