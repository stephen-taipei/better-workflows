import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildContract, loadDefaults } from "../lib/core.mjs";
import { captureSentinel, compareSentinels } from "../lib/git.mjs";

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
