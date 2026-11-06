import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateCommand, beginActions, endActions } from "../src/actions.mjs";
import { classifyCommand } from "../src/classify.mjs";
import { loadPolicy } from "../src/policy.mjs";
import { reconcileOpen } from "../src/reconcile.mjs";
import { headCommit, worktreeTree } from "../src/repo.mjs";
import { loadState } from "../src/state.mjs";
import { fixtureRepo, sh, writePolicy } from "./helpers.mjs";

// Cases from a real ledger (2026-11-04): a session opened in one repository
// pushed and merged in others through `cd`, `git -C` and `gh -R`. Every probe
// ran in the hook's repository and reported success for actions that had
// failed there, and the gate then refused the real retry as already done.

const ALLOW = { actions: { rules: { "git-push": "allow", "gh-pr-merge": "allow", "gh-pr-create": "allow" } }, opaque: "allow" };

async function setup(t) {
  const fixture = await fixtureRepo(t);
  await writePolicy(fixture.root, ALLOW);
  sh(fixture.root, "add", "-A");
  sh(fixture.root, "commit", "-q", "-m", "policy");
  sh(fixture.root, "push", "-q", "origin", "main");
  return fixture;
}

async function gate(repo, command) {
  const [policyInfo, state, head] = await Promise.all([loadPolicy(repo), loadState(repo), headCommit(repo)]);
  return { evaluation: evaluateCommand({ command, policyInfo, state, head }), policyInfo };
}

async function attempt(repo, command, exitCode, cwd) {
  const { evaluation, policyInfo } = await gate(repo, command);
  assert.equal(evaluation.decision === "deny", false, evaluation.reasons.join("; "));
  const ids = await beginActions(repo, evaluation, { command, tree: await worktreeTree(repo), policyDigest: policyInfo.digest, cwd });
  await endActions(repo, ids, { exitCode });
  return ids;
}

// A second clone with its own commits and no remote at all.
async function otherClone(base, name = "scratch") {
  const dir = path.join(base, name);
  await mkdir(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  await writeFile(path.join(dir, "other.txt"), "other\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "other");
  return dir;
}

test("a push after cd into a clone without that remote is not confirmed from the hook's repository", async (t) => {
  const { base, repo } = await setup(t);
  const scratch = await otherClone(base);
  // The real command failed with "no such remote 'origin'" (exit 2), while
  // the hook's repository does have origin/main at its own HEAD.
  const command = `cd ${scratch} && git push -q -u origin main`;
  const [id] = await attempt(repo, command, 2, repo.root);
  const [result] = await reconcileOpen(repo);
  assert.equal(result.id, id);
  assert.equal(result.outcome, "unknown", "the push must not be confirmed by origin of another repository");
});

test("a push from another clone does not share a key with the same push here", async (t) => {
  const { base, repo } = await setup(t);
  const scratch = await otherClone(base);
  await attempt(repo, "git push -q -u origin main", 0, repo.root);
  const { evaluation } = await gate(repo, `cd ${scratch} && git push -q -u origin main`);
  assert.equal(evaluation.decision, "ask", "a cd before a side effect still asks");
  assert.ok(!evaluation.reasons.some((reason) => /already succeeded/.test(reason)), evaluation.reasons.join("; "));
});

test("git -C push is checked against the named repository, and a missing remote branch is a failure", async (t) => {
  const { base, repo } = await setup(t);
  const other = await otherClone(base, "apps");
  const otherRemote = path.join(base, "apps.git");
  sh(base, "init", "-q", "--bare", "-b", "main", otherRemote);
  sh(other, "remote", "add", "origin", otherRemote);
  sh(other, "checkout", "-q", "-b", "owner-only");
  // GitHub answered 500 "remote rejected"; the branch never reached origin.
  // The hook's repository has no such branch, so its sha used to be null and
  // matched the absent remote ref as "success".
  await attempt(repo, `git -C ${other} push --force-with-lease origin owner-only`, 1, repo.root);
  const [rejected] = await reconcileOpen(repo);
  assert.equal(rejected.outcome, "failed");
  assert.match(rejected.detail, /owner-only is absent/);

  sh(other, "push", "-q", "origin", "owner-only");
  await attempt(repo, `git -C ${other} push origin owner-only`, 1, repo.root);
  const [landed] = await reconcileOpen(repo);
  assert.equal(landed.outcome, "success");
});

test("a push of a ref that does not resolve here stays unknown instead of matching an absent remote ref", async (t) => {
  const { repo } = await setup(t);
  await attempt(repo, "git push origin no-such-branch", 1, repo.root);
  const [result] = await reconcileOpen(repo);
  assert.equal(result.outcome, "unknown");
});

test("gh pr merge -R is probed in the named repository", async (t) => {
  const { repo } = await setup(t);
  // The merge failed on a GraphQL error; #43 of the hook's own repository
  // had been merged weeks earlier.
  await attempt(repo, "gh pr merge 43 -R owner/other --merge", 1, repo.root);
  const calls = [];
  const exec = async (file, args) => {
    calls.push(args);
    const other = args.includes("-R") && args[args.indexOf("-R") + 1] === "owner/other";
    return { code: 0, stdout: JSON.stringify({ state: other ? "OPEN" : "MERGED" }), stderr: "" };
  };
  const [result] = await reconcileOpen(repo, { exec });
  assert.deepEqual(calls[0], ["pr", "view", "43", "-R", "owner/other", "--json", "state"]);
  assert.equal(result.outcome, "failed");

  // The retry is a new attempt, not "already succeeded".
  const { evaluation } = await gate(repo, "gh pr merge 43 -R owner/other --merge");
  assert.equal(evaluation.decision, "allow", evaluation.reasons.join("; "));
});

for (const command of ["cd {scratch} && gh pr create --head feature --title x --body y", "cd $D && gh pr merge 7"]) {
  test(`gh after a cd without -R is left for a person: ${command}`, async (t) => {
    const { base, repo } = await setup(t);
    const scratch = await otherClone(base);
    await attempt(repo, command.replace("{scratch}", scratch), 1, repo.root);
    const exec = async () => { throw new Error("no probe may run in the hook's repository"); };
    const [result] = await reconcileOpen(repo, { exec });
    assert.equal(result.outcome, "unknown");
    assert.match(result.detail, /another repository/);
  });
}

test("the -R value is not read as the pull request number", () => {
  const policy = { actions: { custom: [] }, evidence: { kinds: [] } };
  const [merge] = classifyCommand("gh pr merge -R owner/other 43 --squash", policy).actions;
  assert.equal(merge.target.pr, "43");
  assert.deepEqual(merge.where, { repo: "owner/other" });
  const [plain] = classifyCommand("gh pr merge 43", policy).actions;
  assert.equal(plain.where, undefined, "ordinary actions keep their old keys");
});
