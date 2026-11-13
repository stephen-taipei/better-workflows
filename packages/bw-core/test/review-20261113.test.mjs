import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { handleClaudeCodeHook } from "../src/adapters/claude-code.mjs";
import { classifyCommand } from "../src/classify.mjs";
import { defaultPolicy } from "../src/policy.mjs";
import { reconcileOpen } from "../src/reconcile.mjs";
import { loadState } from "../src/state.mjs";
import { fixtureRepo, sh, writePolicy } from "./helpers.mjs";

// Findings of the 2026-11-13 review, each reproduced before it was fixed.

let next = 0;
const hook = (root, event, extra = {}) => handleClaudeCodeHook({ hook_event_name: event, cwd: root, session_id: "s1", ...extra });
const pre = (root, command, tool_use_id, input = {}) => hook(root, "PreToolUse", { tool_name: "Bash", tool_input: { command, ...input }, tool_use_id });
const decision = (result) => result.output?.hookSpecificOutput?.permissionDecision ?? "defer";

// What Claude Code 2.1.323 sends the moment a background call is started,
// while the command is still running.
const backgroundPost = (root, command, tool_use_id) => hook(root, "PostToolUse", {
  tool_name: "Bash", tool_input: { command, run_in_background: true }, tool_use_id,
  tool_response: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: "b6pr6c5aj" },
});

test("a check started in the background is not a pass", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "policy");
  await hook(root, "SessionStart", { source: "startup" });
  await writeFile(path.join(root, "app.txt"), "edited\n");
  const id = `toolu_bg_${next += 1}`;
  await pre(root, "npm test", id, { run_in_background: true });
  await backgroundPost(root, "npm test", id);
  const [record] = (await loadState(repo)).evidence;
  assert.equal(record.exitCode, null);
  assert.equal(record.attributed, false);
  assert.equal(record.excluded, "background");
  const stop = await hook(root, "Stop", { stop_hook_active: false });
  assert.equal(stop.output.decision, "block");
  assert.match(stop.output.reason, /started in the background.*run it in the foreground/);
});

test("a background call is recognised by its task id alone", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  const id = `toolu_bg_${next += 1}`;
  await pre(root, "npm test", id);
  await hook(root, "PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: id, tool_response: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b1" } });
  assert.equal((await loadState(repo)).evidence[0].excluded, "background");
});

test("a side effect started in the background stays unknown until it is checked", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
  await writeFile(path.join(root, "app.txt"), "two\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "two");
  const id = `toolu_bg_${next += 1}`;
  assert.equal(decision(await pre(root, "git push origin main", id, { run_in_background: true })), "defer");
  await backgroundPost(root, "git push origin main", id);
  const [action] = [...(await loadState(repo)).actions.values()];
  assert.equal(action.status, "unknown");
  assert.match(action.history.at(-1).detail, /background/);
  // The push never reached the remote; the probe says so.
  assert.equal((await reconcileOpen(repo))[0].outcome, "failed");
});

for (const command of [
  "rm -rf .better-workflows",
  "mv .better-workflows .bw-off",
  "cd .better-workflows && echo '{}' > policy.json",
  "git rm -rq .better-workflows",
  "git checkout HEAD~1 -- .better-workflows",
  "rm -rf \"$PWD/.better-workflows\"",
  "rm -rf .git/better-workflows",
]) {
  test(`the agent cannot remove or replace the policy directory: ${command}`, async (t) => {
    const { root } = await fixtureRepo(t);
    await writePolicy(root, { completion: { require: ["test"] } });
    const result = await pre(root, command, `toolu_p_${next += 1}`);
    assert.equal(decision(result), "deny");
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /may read but not change/);
  });
}

test("reading the policy directory and naming a sibling stay allowed", async (t) => {
  const { root } = await fixtureRepo(t);
  await writePolicy(root, {});
  for (const command of ["ls .better-workflows", "cat .better-workflows/policy.json", "rm -rf .better-workflows-old", "mkdir .better-workflows.bak"]) {
    assert.equal(decision(await pre(root, command, `toolu_p_${next += 1}`)), "defer", command);
  }
});

for (const command of [
  "GH_REPO=owner/other gh pr merge 43 --squash",
  "export GH_REPO=owner/other; gh pr merge 43 --squash",
  "GH_HOST=ghe.example.com gh pr create --fill",
  "GH_REPO=owner/other gh pr merge 43 -R owner/third",
  "GIT_DIR=/elsewhere/.git git push origin main",
  "env GIT_WORK_TREE=/elsewhere git push origin main",
]) {
  test(`an action retargeted through the environment is left for a person: ${command}`, async (t) => {
    const { root, repo } = await fixtureRepo(t);
    await writePolicy(root, { actions: { default: "allow" } });
    const [action] = classifyCommand(command, defaultPolicy()).actions;
    assert.equal(action.where.unresolved, true);
    const id = `toolu_e_${next += 1}`;
    assert.equal(decision(await pre(root, command, id)), "defer");
    await hook(root, "PostToolUseFailure", { tool_name: "Bash", tool_input: { command }, tool_use_id: id, error: "Exit code 1\nboom", is_interrupt: false });
    const calls = [];
    const exec = async (bin, args) => { calls.push([bin, ...args]); return { code: 0, stdout: '{"state":"MERGED"}', stderr: "" }; };
    const [result] = await reconcileOpen(repo, { exec });
    assert.equal(result.outcome, "unknown");
    assert.deepEqual(calls, [], "no probe runs against the hook's repository");
  });
}

test("a line that only mentions such a variable's name is unaffected", () => {
  for (const command of ["gh pr merge 43 --squash", "echo $GH_REPO && gh pr merge 43", "MY_GH_REPO=x gh pr merge 43"]) {
    assert.equal(classifyCommand(command, defaultPolicy()).actions[0].where?.unresolved, undefined, command);
  }
});
