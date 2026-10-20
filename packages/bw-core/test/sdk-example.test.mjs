import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { completionStatus, loadPolicy, loadState, snapshot, worktreeTree } from "../src/index.mjs";
import { fixtureRepo, writePolicy } from "./helpers.mjs";

// The SDK guide walks through this example, so it must keep working.
const EXAMPLE = fileURLToPath(new URL("../examples/sdk/guarded-run.mjs", import.meta.url));
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
delete env.NODE_TEST_CONTEXT;

function guarded(root, ...args) {
  return spawnSync(process.execPath, [EXAMPLE, ...args], { cwd: root, env, encoding: "utf8" }).status;
}

async function complete(repo) {
  const { policy } = await loadPolicy(repo);
  const tree = await worktreeTree(repo, { ignore: policy.evidence.ignore });
  return completionStatus(await loadState(repo), policy, await snapshot(repo, policy, tree)).ok;
}

test("guarded-run records evidence, refuses a repeated push and stops at ask", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  await writePolicy(root, {
    completion: { require: ["test"] },
    evidence: { kinds: [{ kind: "test", argv: [["true"]] }] },
    actions: { rules: { "git-push": "allow" } },
  });
  assert.equal(await complete(repo), false);
  assert.equal(guarded(root, "--", "true"), 0);
  assert.equal(await complete(repo), true);
  await writeFile(path.join(root, "app.txt"), "two\n");
  assert.equal(await complete(repo), false, "an edit makes the earlier pass stale");

  assert.equal(guarded(root, "--", "git", "push", "-q", "origin", "main"), 0);
  assert.equal(guarded(root, "--", "git", "push", "-q", "origin", "main"), 2, "the same push at the same commit is refused");
  assert.equal(guarded(root, "--", "npm", "publish"), 3, "the default rule asks");
});
