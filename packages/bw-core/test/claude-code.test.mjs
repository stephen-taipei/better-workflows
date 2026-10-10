import test from "node:test";
import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { handleClaudeCodeHook } from "../src/adapters/claude-code.mjs";
import { loadState } from "../src/state.mjs";
import { openRepo } from "../src/repo.mjs";
import { fixtureRepo, sh, writePolicy } from "./helpers.mjs";

let next = 0;
const hook = (root, event, extra = {}) => handleClaudeCodeHook({ hook_event_name: event, cwd: root, session_id: "s1", ...extra });
const bash = (root, command) => {
  const tool_use_id = `toolu_${next += 1}`;
  return {
    pre: () => hook(root, "PreToolUse", { tool_name: "Bash", tool_input: { command }, tool_use_id }),
    ok: () => hook(root, "PostToolUse", { tool_name: "Bash", tool_input: { command }, tool_use_id, tool_response: { stdout: "", stderr: "", interrupted: false } }),
    fail: (code) => hook(root, "PostToolUseFailure", { tool_name: "Bash", tool_input: { command }, tool_use_id, error: `Exit code ${code}\nboom`, is_interrupt: false }),
  };
};
const decision = (result) => result.output?.hookSpecificOutput?.permissionDecision ?? "defer";

test("Stop blocks once when files changed without fresh tests, then warns the person", async (t) => {
  const { root } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "policy");
  assert.match((await hook(root, "SessionStart", { source: "startup" })).output.hookSpecificOutput.additionalContext, /must pass on the final state/);
  assert.equal((await hook(root, "Stop", { stop_hook_active: false })).output, null, "no edits, no requirement");

  const first = bash(root, "npm test");
  await first.pre();
  await first.ok();
  await writeFile(path.join(root, "app.txt"), "edited after the test\n");

  const blocked = (await hook(root, "Stop", { stop_hook_active: false })).output;
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /older tree/);
  assert.match((await hook(root, "Stop", { stop_hook_active: true })).output.systemMessage, /stopped without fresh evidence/);

  const failing = bash(root, "npm test");
  await failing.pre();
  await failing.fail(1);
  assert.match((await hook(root, "Stop", { stop_hook_active: false })).output.reason, /failed \(exit 1\)/);

  const passing = bash(root, "npm test 2>&1 | tail -20");
  await passing.pre();
  await passing.ok();
  assert.equal((await hook(root, "Stop", { stop_hook_active: false })).output, null);
});

test("side effects follow the policy and an unknown result blocks the next one", async (t) => {
  const { root } = await fixtureRepo(t);
  await writePolicy(root, { actions: { custom: [{ kind: "deploy", argv: [["./deploy.sh"]] }], rules: { deploy: "allow", "package-publish": "deny" } } });
  assert.equal(decision(await bash(root, "npm publish").pre()), "deny");
  assert.equal(decision(await bash(root, "git push").pre()), "ask");

  const deploy = bash(root, "./deploy.sh prod");
  assert.equal(decision(await deploy.pre()), "defer", "allow never grants more than the host's own permissions");
  await deploy.fail(124);
  const again = await bash(root, "./deploy.sh prod").pre();
  assert.equal(decision(again), "deny");
  assert.match(again.output.hookSpecificOutput.permissionDecisionReason, /unknown result/);
  assert.equal(decision(await bash(root, "npm test").pre()), "defer", "read-only work continues");
  const actions = [...(await loadState(await openRepo(root))).actions.values()];
  assert.equal(actions.find((a) => a.kind === "deploy").status, "unknown");
  // The push that was only asked about already matches the remote, so the
  // read-only probe settled it rather than leaving it open.
  assert.equal(actions.find((a) => a.kind === "git-push").status, "success");
});

test("the agent cannot edit the policy, the ledger or settle actions by hand", async (t) => {
  const { root } = await fixtureRepo(t);
  const edit = (file_path) => hook(root, "PreToolUse", { tool_name: "Write", tool_input: { file_path, content: "{}" }, tool_use_id: "w1" });
  assert.equal(decision(await edit(".better-workflows/policy.json")), "deny");
  assert.equal(decision(await edit(path.join(root, ".git", "better-workflows", "ledger.jsonl"))), "deny");
  assert.equal(decision(await edit("src/app.ts")), "defer");
  for (const command of [
    "echo '{\"actions\":{\"default\":\"allow\"}}' > .better-workflows/policy.json",
    "rm .git/better-workflows/ledger.jsonl",
    "bw reconcile act_123 --outcome success --note done",
    "node packages/bw-core/bin/bw.mjs init",
  ]) assert.equal(decision(await bash(root, command).pre()), "deny", command);
  assert.equal(decision(await bash(root, "cat .better-workflows/policy.json").pre()), "defer");
  assert.equal(decision(await bash(root, "bw reconcile").pre()), "defer");
});

test("outside a Git repository the hooks stay out of the way", async (t) => {
  const { base } = await fixtureRepo(t);
  const result = await handleClaudeCodeHook({ hook_event_name: "PreToolUse", cwd: base, tool_name: "Bash", tool_input: { command: "git push" } });
  assert.deepEqual(result, { output: null, exitCode: 0 });
});

test("a side effect refused at the prompt is settled from the transcript, an unexplained one stays open", async (t) => {
  const { root } = await fixtureRepo(t);
  await writePolicy(root, { actions: { custom: [{ kind: "deploy", argv: [["./deploy.sh"]] }], rules: { deploy: "ask" } } });
  const transcript = path.join(root, "..", `transcript-${next}.jsonl`);
  const toolResult = (id, content) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content, is_error: true, tool_use_id: id }] } });

  const refused = bash(root, "./deploy.sh prod");
  assert.equal(decision(await refused.pre()), "ask");
  const refusedId = `toolu_${next}`;
  await writeFile(transcript, `${toolResult(refusedId, "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).")}\n`);
  const retry = await hook(root, "PreToolUse", { tool_name: "Bash", tool_input: { command: "./deploy.sh prod" }, tool_use_id: "toolu_retry", transcript_path: transcript });
  assert.equal(decision(retry), "ask", "a refused call never ran, so it must not block the retry");
  const repo = await openRepo(root);
  let state = await loadState(repo);
  const settled = [...state.actions.values()].find((a) => a.toolUseId === refusedId);
  assert.equal(settled.status, "failed");
  assert.match(settled.history[0].detail, /refused before running/);

  // The retry got no Post either, and its result is not a refusal: it may have run.
  await writeFile(transcript, `${toolResult("toolu_retry", "[Request interrupted by user for tool use]")}\n`, { flag: "a" });
  const third = await hook(root, "PreToolUse", { tool_name: "Bash", tool_input: { command: "./deploy.sh prod" }, tool_use_id: "toolu_third", transcript_path: transcript });
  assert.equal(decision(third), "deny");
  state = await loadState(repo);
  assert.equal([...state.actions.values()].find((a) => a.toolUseId === "toolu_retry").status, "unknown");
});

test("a protected path reached through a symlinked directory is still protected", async (t) => {
  const { root, base } = await fixtureRepo(t);
  const link = path.join(base, "linked");
  await symlink(root, link);
  const result = await handleClaudeCodeHook({
    hook_event_name: "PreToolUse", cwd: link, session_id: "s1", tool_name: "Write",
    tool_input: { file_path: path.join(link, ".better-workflows", "policy.json"), content: "{}" }, tool_use_id: "w2",
  });
  assert.equal(decision(result), "deny");
});
