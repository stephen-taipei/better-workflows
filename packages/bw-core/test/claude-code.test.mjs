import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
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

  const piped = bash(root, "npm test 2>&1 | tail -20");
  await piped.pre();
  await piped.ok();
  assert.match((await hook(root, "Stop", { stop_hook_active: false })).output.reason, /exit code came from another command/, "tail's exit 0 is not the tests'");

  const passing = bash(root, "set -o pipefail; npm test 2>&1 | tail -20");
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

test("the agent cannot record evidence through bw run", async (t) => {
  const { root } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  for (const command of [
    "bw run --kind test -- true",
    "npx bw run --kind test -- true",
    "node packages/bw-core/bin/bw.mjs run --kind test -- true",
    "cd packages/bw-core && node bin/bw.mjs run --kind test -- true",
    "npx @better-workflows/core@alpha run --kind test -- true",
  ]) assert.match((await bash(root, command).pre()).output.hookSpecificOutput.permissionDecisionReason, /only a person records evidence/, command);
  assert.equal(decision(await bash(root, "bw status").pre()), "defer");
  assert.equal(decision(await bash(root, "npm run build").pre()), "defer");
});

test("two sessions racing to the same push let only one through", async (t) => {
  const { root } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
  const results = await Promise.all([bash(root, "git push origin main").pre(), bash(root, "git push origin main").pre()]);
  assert.deepEqual(results.map(decision).sort(), ["defer", "deny"]);
  assert.match(results.find((r) => decision(r) === "deny").output.hookSpecificOutput.permissionDecisionReason, /unfinished result/);
  const { actions } = await loadState(await openRepo(root));
  assert.equal(actions.size, 1, "only the push let through is recorded");
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

test("an exact check counts only when it runs in the directory the policy names", async (t) => {
  const { root, base } = await fixtureRepo(t);
  await mkdir(path.join(root, "pkg"));
  await writeFile(path.join(root, "pkg", "a.txt"), "a\n");
  await writePolicy(root, {
    completion: { require: ["test", "unit"] },
    evidence: { kinds: [{ kind: "test", argv: [["npm", "test"]], exact: true }, { kind: "unit", argv: [["make", "unit"]], exact: true, cwd: "pkg" }] },
  });
  const run = async (command, cwd = root) => {
    const tool = { tool_name: "Bash", tool_input: { command }, tool_use_id: `toolu_${next += 1}` };
    await handleClaudeCodeHook({ hook_event_name: "PreToolUse", cwd, session_id: "s1", ...tool });
    await handleClaudeCodeHook({ hook_event_name: "PostToolUse", cwd, session_id: "s1", ...tool, tool_response: { stdout: "", stderr: "", interrupted: false } });
  };
  const missing = async () => (await hook(root, "Stop", { stop_hook_active: false })).output?.reason ?? "";
  await hook(root, "SessionStart", { source: "startup" });
  await writeFile(path.join(root, "app.txt"), "edited\n");

  await run("cd pkg && npm test");
  await run("npm test", path.join(root, "pkg"));
  await run("make unit");
  assert.match(await missing(), /test: the last run .* was not in the directory the policy names/);
  assert.match(await missing(), /unit: the last run .* was not in the directory/);

  const link = path.join(base, "linked");
  await symlink(root, link);
  await run("npm test", link); // the same root reached through a symlink
  await run("(cd pkg && make unit) && echo done");
  assert.equal(await missing(), "", "both ran where the policy says");

  await writeFile(path.join(root, "app.txt"), "edited again\n");
  await run("cd $PKG && make unit");
  await run("cd pkg; cd .. && npm test");
  assert.match(await missing(), /unit: the last run .* was not in the directory/, "a cd the hook cannot read does not count");
  assert.doesNotMatch(await missing(), /test:/);
});

test("Stop reports how the session has gone so the agent can judge whether to keep trying", async (t) => {
  const { root } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  await hook(root, "SessionStart", { source: "startup" });
  await writeFile(path.join(root, "app.txt"), "edit 1\n");
  for (const i of [1, 2]) {
    const failing = bash(root, "npm test");
    await failing.pre();
    await failing.fail(1);
    await writeFile(path.join(root, "app.txt"), `edit ${i + 1}\n`);
  }
  const first = (await hook(root, "Stop", { stop_hook_active: false })).output;
  assert.match(first.reason, /test ran 2 times on 2 states of the files this session, the last 2 failing/);
  assert.doesNotMatch(first.reason, /sent back/);
  const second = (await hook(root, "Stop", { stop_hook_active: false })).output;
  assert.match(second.reason, /already sent back 1 time\b/);
  assert.match((await hook(root, "Stop", { stop_hook_active: true })).output.systemMessage, /sent back 2 times/);
  const other = await handleClaudeCodeHook({ hook_event_name: "Stop", cwd: root, session_id: "s2", stop_hook_active: false });
  assert.doesNotMatch(other.output.reason, /So far/, "another session's runs are not this session's history");
});

test("a run that writes ignored output still counts, and scoped kinds survive edits elsewhere", async (t) => {
  const { root } = await fixtureRepo(t);
  await mkdir(path.join(root, "pkg"));
  await writeFile(path.join(root, "pkg", "a.txt"), "a\n");
  await writePolicy(root, {
    completion: { require: ["test", "unit"] },
    evidence: { ignore: ["coverage"], kinds: [{ kind: "unit", argv: [["make", "unit"]], exact: true, scope: ["pkg"] }] },
  });
  await hook(root, "SessionStart", { source: "startup" });
  const missing = async () => (await hook(root, "Stop", { stop_hook_active: false })).output?.reason ?? "";
  await writeFile(path.join(root, "app.txt"), "edited\n");

  const unit = bash(root, "make unit");
  await unit.pre();
  await unit.ok();
  const test1 = bash(root, "npm test");
  await test1.pre();
  await mkdir(path.join(root, "coverage"));
  await writeFile(path.join(root, "coverage", "lcov.info"), "TN:\n");
  await test1.ok();
  assert.equal(await missing(), "", "coverage output written during the run is ignored");

  await writeFile(path.join(root, "app.txt"), "edited again\n");
  const reason = await missing();
  assert.match(reason, /test: last result was for an older tree/);
  assert.doesNotMatch(reason, /unit:/, "the edit was outside pkg/, so unit is still fresh");
  await writeFile(path.join(root, "pkg", "a.txt"), "b\n");
  assert.match(await missing(), /unit: last result was for an older state of pkg/);
});

test("SessionStart warns when the policy needs gh but gh cannot be used", async (t) => {
  const { root } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "gh-pr-merge": "ask" } } });
  const dir = path.join(root, "..", "bin");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "gh"), "#!/bin/sh\necho 'You are not logged into any GitHub hosts. To log in, run: gh auth login' >&2\nexit 1\n", { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${PATH}`;
  t.after(() => { process.env.PATH = PATH; });
  const context = (await hook(root, "SessionStart", { source: "startup" })).output.hookSpecificOutput.additionalContext;
  assert.match(context, /Warning: gh is not logged in/);
});

test("a subagent stopping is not the session finishing; its own refusals settle from its transcript", async (t) => {
  // SubagentStop carries the parent's session_id, so judging completion there
  // sent a read-only subagent back for the parent's edits and logged a block.
  const { root } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] }, actions: { custom: [{ kind: "deploy", argv: [["./deploy.sh"]] }], rules: { deploy: "ask" } } });
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "policy");
  await hook(root, "SessionStart", { source: "startup" });
  await writeFile(path.join(root, "app.txt"), "edited by the parent\n");

  const refused = bash(root, "./deploy.sh prod");
  assert.equal(decision(await refused.pre()), "ask");
  const agentTranscript = path.join(root, "..", `agent-${next}.jsonl`);
  await writeFile(agentTranscript, `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "The user doesn't want to proceed with this tool use. The tool use was rejected.", is_error: true, tool_use_id: `toolu_${next}` }] } })}\n`);

  const sub = await hook(root, "SubagentStop", { stop_hook_active: false, agent_id: "a1", agent_type: "Explore", agent_transcript_path: agentTranscript });
  assert.equal(sub.output, null, "the subagent is not sent back for the parent's edits");
  const state = await loadState(await openRepo(root));
  assert.equal(state.sessions.get("s1")?.blocks ?? 0, 0, "no block is logged");
  assert.equal([...state.actions.values()].find((a) => a.toolUseId === `toolu_${next}`).status, "failed", "the refused deploy never ran");

  assert.equal((await hook(root, "Stop", { stop_hook_active: false })).output.decision, "block", "the session itself is still held to the evidence");
});
