import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  checkPluginCache,
  publishPluginCache
} from "../lib/publication.mjs";

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
