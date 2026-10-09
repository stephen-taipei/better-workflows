import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { main } from "../src/cli.mjs";
import { captureIo, fixtureRepo } from "./helpers.mjs";

async function bw(cwd, ...argv) {
  const { io, out, err } = captureIo();
  const code = await main(argv, { cwd, io });
  return { code, out: out.join(""), err: err.join("") };
}

test("the stale-green story end to end through the CLI", async (t) => {
  const { root } = await fixtureRepo(t);
  assert.equal((await bw(root, "init")).code, 0);
  assert.equal((await bw(root, "init")).code, 1, "init never overwrites a policy");

  const missing = await bw(root, "check-completion");
  assert.equal(missing.code, 2);
  assert.match(missing.out, /test: never run/);

  assert.equal((await bw(root, "run", "--kind", "test", "--", process.execPath, "-e", "process.exit(0)")).code, 0);
  assert.equal((await bw(root, "check-completion")).code, 0);

  await writeFile(path.join(root, "app.txt"), "changed after the tests passed\n");
  const stale = await bw(root, "check-completion");
  assert.equal(stale.code, 2);
  assert.match(stale.out, /older tree/);

  const failing = await bw(root, "run", "--kind", "test", "--", process.execPath, "-e", "process.exit(3)");
  assert.equal(failing.code, 3, "run passes the command's exit code through");
  assert.match((await bw(root, "check-completion")).out, /failed \(exit 3\)/);

  const status = JSON.parse((await bw(root, "status", "--json")).out);
  assert.equal(status.policy.source, ".better-workflows/policy.json");
  assert.equal(status.completion.ok, false);
  assert.match((await bw(root, "verify")).out, /Ledger OK: 2 entries/);
});

test("check-command reports the gate decision as an exit code", async (t) => {
  const { root } = await fixtureRepo(t);
  assert.equal((await bw(root, "check-command", "git", "status")).code, 0);
  const ask = await bw(root, "check-command", "git push origin main");
  assert.equal(ask.code, 3);
  assert.deepEqual(JSON.parse(ask.out).actions, ["git-push"]);
});

test("usage errors exit 1 and outside a repository nothing is recorded", async (t) => {
  const { base } = await fixtureRepo(t);
  assert.equal((await bw(base, "status")).code, 1);
  assert.equal((await bw(base, "frobnicate")).code, 1);
  assert.equal((await bw(base, "run", "--", "true")).code, 1);
  assert.equal((await bw(base, "reconcile", "act_x", "--outcome")).code, 1);
});
