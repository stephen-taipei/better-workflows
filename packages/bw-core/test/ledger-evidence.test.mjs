import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { appendEvent, ledgerPath, readLedger, verifyLedger } from "../src/ledger.mjs";
import { worktreeTree, treeState } from "../src/repo.mjs";
import { recordEvidence, completionStatus } from "../src/evidence.mjs";
import { loadState } from "../src/state.mjs";
import { normalizePolicy } from "../src/policy.mjs";
import { fixtureRepo, sh } from "./helpers.mjs";

test("ledger appends a hash chain that survives concurrent writers", async (t) => {
  const { repo } = await fixtureRepo(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => appendEvent(repo, "note", { i })));
  const entries = await readLedger(repo);
  assert.equal(entries.length, 20);
  assert.deepEqual(entries.map((e) => e.seq), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal((await verifyLedger(repo)).ok, true);
});

test("ledger rejects edited and truncated entries", async (t) => {
  const { repo } = await fixtureRepo(t);
  for (const i of [1, 2, 3]) await appendEvent(repo, "note", { i });
  const file = ledgerPath(repo);
  const original = await readFile(file, "utf8");
  await writeFile(file, original.replace('"i":2', '"i":9'));
  assert.match((await verifyLedger(repo)).error, /broken at entry 2/);
  await writeFile(file, original);
  await appendFile(file, '{"seq":4');
  assert.match((await verifyLedger(repo)).error, /incomplete entry/);
  await writeFile(file, original.split("\n").slice(1).join("\n"));
  assert.match((await verifyLedger(repo)).error, /broken at entry 1/);
});

test("tree digest follows content, includes untracked files, ignores ignored ones, leaves the index alone", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  const clean = await worktreeTree(repo);
  assert.equal(clean, sh(root, "rev-parse", "HEAD^{tree}"));
  await writeFile(path.join(root, "new.txt"), "x\n");
  const withUntracked = await worktreeTree(repo);
  assert.notEqual(withUntracked, clean);
  await mkdir(path.join(root, "ignored"));
  await writeFile(path.join(root, "ignored", "cache"), "y\n");
  assert.equal(await worktreeTree(repo), withUntracked);
  assert.equal(sh(root, "status", "--porcelain"), "?? new.txt");
  assert.equal(sh(root, "diff", "--cached", "--name-only"), "");
});

test("evidence is fresh only for the exact tree it passed on", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  const policy = normalizePolicy({ completion: { require: ["test"] } });
  const status = async () => completionStatus(await loadState(repo), policy, await worktreeTree(repo)).results[0].status;

  assert.equal(await status(), "missing");
  const { head, tree } = await treeState(repo);
  await recordEvidence(repo, { kind: "test", command: "npm test", exitCode: 0, treeBefore: tree, treeAfter: tree, head });
  assert.equal(await status(), "fresh");

  await writeFile(path.join(root, "app.txt"), "two\n");
  assert.equal(await status(), "stale", "an edit after the test makes the old pass stale");

  const edited = await worktreeTree(repo);
  await recordEvidence(repo, { kind: "test", command: "npm test", exitCode: 1, treeBefore: edited, treeAfter: edited, head });
  assert.equal(await status(), "failed");

  await writeFile(path.join(root, "app.txt"), "one\n");
  assert.equal(await status(), "fresh", "reverting to the tested content restores the earlier pass");

  await recordEvidence(repo, { kind: "test", command: "npm test", exitCode: 0, treeBefore: edited, treeAfter: tree, head });
  assert.equal(await status(), "unstable", "a run during which files changed proves nothing");
});
