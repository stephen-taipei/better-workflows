import test from "node:test";
import assert from "node:assert/strict";
import { handleClaudeCodeHook } from "../src/adapters/claude-code.mjs";
import { reconcileOpen } from "../src/reconcile.mjs";
import { loadState } from "../src/state.mjs";
import { fixtureRepo, sh, writePolicy } from "./helpers.mjs";

// Push expectations the 2026-11-13 review found wrong: each of these was
// settled against a ref the push was never going to produce.

let next = 0;
const hook = (root, event, extra = {}) => handleClaudeCodeHook({ hook_event_name: event, cwd: root, session_id: "s1", ...extra });

async function setup(t) {
  const fixture = await fixtureRepo(t);
  await writePolicy(fixture.root, { actions: { default: "allow" } });
  sh(fixture.root, "add", "-A");
  sh(fixture.root, "commit", "-q", "-m", "policy");
  sh(fixture.root, "push", "-q", "origin", "main");
  return fixture;
}

// Runs the gate, then `between` in place of the command, then reports the
// call as failed (exit 128) or interrupted, and returns the probe's verdict.
async function settle(root, repo, command, between = () => {}, { interrupted = false } = {}) {
  const tool_use_id = `toolu_push_${next += 1}`;
  const gate = await hook(root, "PreToolUse", { tool_name: "Bash", tool_input: { command }, tool_use_id });
  assert.equal(gate.output, null, JSON.stringify(gate.output));
  between();
  if (interrupted) await hook(root, "PostToolUse", { tool_name: "Bash", tool_input: { command }, tool_use_id, tool_response: { interrupted: true } });
  else await hook(root, "PostToolUseFailure", { tool_name: "Bash", tool_input: { command }, tool_use_id, error: "Exit code 128\nfatal", is_interrupt: false });
  const [result] = await reconcileOpen(repo);
  return result;
}

const COMMIT_PUSH = "git commit -q --allow-empty -m next && git push -q";

test("a commit that was made but not pushed is not confirmed by the sha from before the line ran", async (t) => {
  const { root, repo } = await setup(t);
  const result = await settle(root, repo, COMMIT_PUSH, () => sh(root, "commit", "-q", "--allow-empty", "-m", "next"));
  assert.equal(result.outcome, "failed");
  assert.match(result.detail, /did not arrive/);
});

test("a commit and push that both ran before an interrupt is confirmed by the branch as it is now", async (t) => {
  const { root, repo } = await setup(t);
  const result = await settle(root, repo, COMMIT_PUSH, () => {
    sh(root, "commit", "-q", "--allow-empty", "-m", "next");
    sh(root, "push", "-q");
  }, { interrupted: true });
  assert.equal(result.outcome, "success");
});

test("a branch that moved again after the line cannot be told apart", async (t) => {
  const { root, repo } = await setup(t);
  const result = await settle(root, repo, COMMIT_PUSH, () => {
    sh(root, "commit", "-q", "--allow-empty", "-m", "next");
    sh(root, "push", "-q");
    sh(root, "commit", "-q", "--allow-empty", "-m", "later");
  }, { interrupted: true });
  assert.equal(result.outcome, "unknown");
});

test("a push after a command that moves nothing is settled as before", async (t) => {
  const { root, repo } = await setup(t);
  sh(root, "commit", "-q", "--allow-empty", "-m", "next");
  assert.equal((await settle(root, repo, "git status -s && git push -q")).outcome, "failed");
  const pushed = await settle(root, repo, "git status -s && git push -q origin main", () => sh(root, "push", "-q"), { interrupted: true });
  assert.equal(pushed.outcome, "success");
});

for (const command of ["git push --tags", "git push origin --tags", "git push --all origin", "git push --follow-tags origin main", "git push --mirror"]) {
  test(`a push of refs the line does not name is left for a person: ${command}`, async (t) => {
    const { root, repo } = await setup(t);
    sh(root, "tag", "v1");
    const result = await settle(root, repo, command);
    assert.equal(result.outcome, "unknown");
    assert.equal([...(await loadState(repo)).actions.values()][0].expect.refs, null);
  });
}

test("a pushed tag is not looked up as a branch", async (t) => {
  const { root, repo } = await setup(t);
  sh(root, "tag", "v1");
  const result = await settle(root, repo, "git push origin v1", () => sh(root, "push", "-q", "origin", "v1"), { interrupted: true });
  assert.equal(result.outcome, "unknown");
});

test("a commit pushed to an explicit ref is still probed", async (t) => {
  const { root, repo } = await setup(t);
  sh(root, "commit", "-q", "--allow-empty", "-m", "next");
  const sha = sh(root, "rev-parse", "HEAD");
  const command = `git push origin ${sha}:refs/heads/main`;
  assert.equal((await settle(root, repo, command)).outcome, "failed");
  const pushed = await settle(root, repo, `git push -q origin ${sha}:refs/heads/main`, () => sh(root, "push", "-q", "origin", `${sha}:refs/heads/main`), { interrupted: true });
  assert.equal(pushed.outcome, "success");
});
