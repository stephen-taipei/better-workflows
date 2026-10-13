import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, appendFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { appendEvent, ledgerPath, readLedger, verifyLedger } from "../src/ledger.mjs";
import { subtreeDigests, worktreeTree, treeState } from "../src/repo.mjs";
import { completionStatus, describeEvidence, recordEvidence, scopeDigests, scopeFor, snapshot } from "../src/evidence.mjs";
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

test("ledger notices whole entries cut from the end", async (t) => {
  const { repo } = await fixtureRepo(t);
  for (const i of [1, 2, 3]) await appendEvent(repo, "note", { i });
  const file = ledgerPath(repo);
  const original = await readFile(file, "utf8");
  await writeFile(file, original.split("\n").slice(0, 2).join("\n") + "\n");
  assert.match((await verifyLedger(repo)).error, /ends before its recorded head \(entry 3\)/);
  await rm(file);
  assert.match((await verifyLedger(repo)).error, /entries were removed/);
  await writeFile(file, original);
  await rm(path.join(repo.stateDir, "ledger.head"));
  assert.equal((await verifyLedger(repo)).entries, 3, "a ledger from before the head still reads");
  await appendEvent(repo, "note", { i: 4 });
  await writeFile(file, original);
  assert.equal((await verifyLedger(repo)).ok, false, "the next append anchors it");
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

test("ignored output a run writes does not make the run unstable", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  const policy = normalizePolicy({ completion: { require: ["test"] }, evidence: { ignore: ["coverage"] } });
  const { head } = await treeState(repo);
  const before = await worktreeTree(repo, { ignore: policy.evidence.ignore });
  await mkdir(path.join(root, "coverage"));
  await writeFile(path.join(root, "coverage", "lcov.info"), "TN:\n");
  assert.notEqual(await worktreeTree(repo), before, "without ignore the report changes the tree");
  const after = await worktreeTree(repo, { ignore: policy.evidence.ignore });
  assert.equal(after, before);
  await recordEvidence(repo, { kind: "test", command: "npm test", exitCode: 0, treeBefore: before, treeAfter: after, head });
  assert.equal(completionStatus(await loadState(repo), policy, after).results[0].status, "fresh");
});

test("scoped evidence stays fresh while files outside its scope change", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  for (const dir of ["plugin", "scripts"]) {
    await mkdir(path.join(root, dir));
    await writeFile(path.join(root, dir, "a.txt"), "a\n");
  }
  const scripts = { kind: "script-test", argv: [["make", "scripts"]], exact: true, scope: ["scripts", "plugin"] };
  const policy = normalizePolicy({
    completion: { require: ["plugin-test", "script-test"] },
    evidence: { kinds: [{ kind: "plugin-test", argv: [["make", "plugin"]], exact: true, scope: ["plugin"] }, scripts] },
  });
  const statuses = async (p = policy) => {
    const tree = await worktreeTree(repo);
    const results = completionStatus(await loadState(repo), p, await snapshot(repo, p, tree)).results;
    return results.map((r) => r.status);
  };
  const record = async (kind) => {
    const scope = scopeFor(policy, kind);
    const { head, tree } = await treeState(repo);
    const digests = scopeDigests(scope, await subtreeDigests(repo, tree, scope));
    await recordEvidence(repo, { kind, command: `make ${kind}`, exitCode: 0, treeBefore: tree, treeAfter: tree, head, scope, scopeBefore: digests, scopeAfter: digests });
  };
  assert.deepEqual(await statuses(), ["missing", "missing"]);
  await record("plugin-test");
  await record("script-test");
  assert.deepEqual(await statuses(), ["fresh", "fresh"]);

  await writeFile(path.join(root, "scripts", "a.txt"), "b\n");
  assert.deepEqual(await statuses(), ["fresh", "stale"], "a change under scripts/ only touches the kind scoped to it");
  await writeFile(path.join(root, "README.md"), "unrelated\n");
  assert.deepEqual(await statuses(), ["fresh", "stale"], "a change outside every scope touches nothing");
  await writeFile(path.join(root, "plugin", "a.txt"), "b\n");
  assert.deepEqual(await statuses(), ["stale", "stale"]);

  await record("plugin-test");
  assert.deepEqual(await statuses(), ["fresh", "stale"]);
  const widened = normalizePolicy({ completion: policy.completion, evidence: { kinds: [{ kind: "plugin-test", argv: [["make", "plugin"]], exact: true, scope: ["plugin", "scripts"] }, scripts] } });
  assert.equal((await statuses(widened))[0], "stale", "a result recorded under another scope does not count");
  const stale = completionStatus(await loadState(repo), widened, await snapshot(repo, widened, await worktreeTree(repo))).results[0];
  assert.match(describeEvidence(stale), /older state of plugin, scripts/);
});

test("the policy rejects scope and ignore paths that leave the repository or need exact", () => {
  assert.throws(() => normalizePolicy({ evidence: { ignore: ["../x"] } }), /inside the repository/);
  assert.throws(() => normalizePolicy({ evidence: { ignore: ["."] } }), /cannot be the repository root/);
  assert.throws(() => normalizePolicy({ evidence: { kinds: [{ kind: "test", argv: [["x"]], scope: ["a"] }] } }), /scope needs exact/);
  assert.throws(() => normalizePolicy({ evidence: { kinds: [
    { kind: "test", argv: [["x"]], exact: true, scope: ["a"] }, { kind: "test", argv: [["y"]], exact: true, scope: ["b"] },
  ] } }), /different scope/);
  const policy = normalizePolicy({ evidence: { ignore: ["dist/", "a\\b"], kinds: [{ kind: "test", argv: [["x"]], exact: true, scope: ["pkg/one/"] }] } });
  assert.deepEqual(policy.evidence.ignore, ["dist", "a/b"]);
  assert.deepEqual(scopeFor(policy, "test"), ["pkg/one"]);
  assert.equal(scopeFor(policy, "lint"), null);
});
