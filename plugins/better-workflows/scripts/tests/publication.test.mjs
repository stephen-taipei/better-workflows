import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkPluginCache,
  publishPluginCache
} from "../lib/publication.mjs";

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
