import test from "node:test";
import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleCodexHook } from "../src/adapters/codex.mjs";
import { handleClaudeCodeHook } from "../src/adapters/claude-code.mjs";
import { openRepo, worktreeTree } from "../src/repo.mjs";
import { loadState } from "../src/state.mjs";
import { reconcileManually, reconcileOpen } from "../src/reconcile.mjs";
import { appendEvent } from "../src/ledger.mjs";
import { pendingFile } from "../src/adapters/shared.mjs";
import { fixtureRepo, sh, writePolicy } from "./helpers.mjs";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex");
const decision = (result) => result.output?.hookSpecificOutput?.permissionDecision ?? "defer";

async function readFixture(name) {
  return readFile(path.join(fixtureDir, name), "utf8");
}

function codexInput(root, hookEventName, options = {}) {
  const {
    session_id = "codex-session",
    turn_id = "turn-1",
    transcript_path = path.join(path.dirname(root), "transcript.jsonl"),
    ...fields
  } = options;
  return {
    hook_event_name: hookEventName,
    cwd: root,
    session_id,
    turn_id,
    transcript_path,
    ...fields,
  };
}

function capturedInput(capture, index, root, transcriptPath, overrides = {}) {
  const base = structuredClone(capture.events[index]);
  const { tool_input: inputOverrides, ...fields } = overrides;
  return {
    ...base,
    ...fields,
    cwd: root,
    transcript_path: transcriptPath,
    tool_input: { ...base.tool_input, ...(inputOverrides ?? {}) },
  };
}

async function codex(root, hookEventName, options = {}) {
  return handleCodexHook(codexInput(root, hookEventName, options));
}

function claudeInput(root, hookEventName, options = {}) {
  return {
    hook_event_name: hookEventName,
    cwd: root,
    session_id: "claude-session",
    ...options,
  };
}

async function claude(root, hookEventName, options = {}) {
  return handleClaudeCodeHook(claudeInput(root, hookEventName, options));
}

function itemCompleted(id, exitCode, extra = {}) {
  const item = { id, type: "CommandExecution", status: exitCode === 0 ? "completed" : "failed", ...extra };
  if (exitCode !== undefined) item.exit_code = exitCode;
  return { type: "event_msg", payload: { type: "item_completed", item } };
}

function turnAborted() {
  return { type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } };
}

async function writeTranscript(file, rows) {
  const text = rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n");
  await writeFile(file, text ? `${text}\n` : "");
}

async function stateAt(root) {
  return loadState(await openRepo(root));
}

function patchCase(cases, label) {
  return cases.events.find((event) => event.label === label);
}

test("captured PostToolUse events use matching transcript exit codes, never the empty tool_response", async (t) => {
  const capture = JSON.parse(await readFixture("captured-hooks.json"));
  const transcript = await readFixture("captured-transcript.jsonl");

  for (const [preIndex, postIndex, exitCode] of [[0, 1, 0], [2, 3, 1], [4, 5, 3]]) {
    const { root, base } = await fixtureRepo(t);
    await writePolicy(root, { completion: { require: ["test"] } });
    const transcriptPath = path.join(base, `captured-${exitCode}.jsonl`);
    await writeFile(transcriptPath, transcript);
    const session = capture.events[preIndex].session_id;
    const started = await codex(root, "SessionStart", {
      session_id: session,
      turn_id: capture.events[preIndex].turn_id,
      transcript_path: transcriptPath,
      source: "startup",
    });
    assert.match(started.output.hookSpecificOutput.additionalContext, /test/);
    await writeFile(path.join(root, "app.txt"), `edited for exit ${exitCode}\n`);

    const pre = await handleCodexHook(capturedInput(capture, preIndex, root, transcriptPath));
    const postInput = capturedInput(capture, postIndex, root, transcriptPath);
    assert.equal(postInput.tool_response, "");
    const post = await handleCodexHook(postInput);
    assert.equal(pre.output, null);
    assert.equal(post.output, null);

    const state = await stateAt(root);
    assert.equal(state.evidence.length, 1);
    assert.equal(state.evidence[0].host, "codex");
    assert.equal(state.evidence[0].exitCode, exitCode);
    const stopped = await codex(root, "Stop", {
      session_id: session,
      turn_id: capture.events[postIndex].turn_id,
      transcript_path: transcriptPath,
      stop_hook_active: false,
    });
    if (exitCode === 0) assert.equal(stopped.output, null);
    else {
      assert.equal(stopped.output.decision, "block");
      assert.match(stopped.output.reason, new RegExp(`exit ${exitCode}`));
    }
  }
});

test("a background completion correlates by tool_use_id across turns", async (t) => {
  const capture = JSON.parse(await readFixture("captured-hooks.json"));
  const transcript = await readFixture("captured-transcript.jsonl");
  const { root, base } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  await writeFile(path.join(root, "app.txt"), "edited before background check\n");
  const transcriptPath = path.join(base, "background.jsonl");
  await writeFile(transcriptPath, transcript);
  const pre = capture.events[6];
  const post = capture.events[7];
  assert.equal(pre.tool_use_id, post.tool_use_id);
  assert.notEqual(pre.turn_id, post.turn_id);

  assert.equal((await handleCodexHook(capturedInput(capture, 6, root, transcriptPath))).output, null);
  const completion = await handleCodexHook(capturedInput(capture, 7, root, transcriptPath));
  assert.equal(completion.output, null);
  const state = await stateAt(root);
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidence[0].exitCode, 0);
});

test("a missing transcript result stays pending, then an unknown hook event backfills it", async (t) => {
  const { root, base } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
  const transcriptPath = path.join(base, "late-push.jsonl");
  await writeTranscript(transcriptPath, []);
  const toolUseId = "exec-late-push";
  const session = "session-late-push";
  assert.equal(decision(await codex(root, "PreToolUse", {
    session_id: session,
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "git push origin main" },
  })), "defer");
  const post = await codex(root, "PostToolUse", {
    session_id: session,
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "git push origin main" },
    tool_response: "",
  });
  assert.equal(post.output, null);
  let state = await stateAt(root);
  assert.equal([...state.actions.values()][0].status, "pending");

  await writeTranscript(transcriptPath, [itemCompleted(toolUseId, 0)]);
  const futureEvent = await codex(root, "FutureHookEvent", {
    session_id: session,
    turn_id: "turn-later",
    transcript_path: transcriptPath,
  });
  assert.deepEqual(futureEvent, { output: null, exitCode: 0 });
  state = await stateAt(root);
  assert.equal([...state.actions.values()][0].status, "success");
});

test("pending evidence is replayed before an apply_patch deny on the next event", async (t) => {
  const cases = JSON.parse(await readFixture("apply-patch-cases.json"));
  const { root, base } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  const transcriptPath = path.join(base, "late-test.jsonl");
  await writeTranscript(transcriptPath, []);
  const session = "session-late-test";
  await codex(root, "SessionStart", { session_id: session, transcript_path: transcriptPath, source: "startup" });
  await writeFile(path.join(root, "app.txt"), "changed before test\n");
  const toolUseId = "exec-late-test";
  assert.equal(decision(await codex(root, "PreToolUse", {
    session_id: session,
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "npm test" },
  })), "defer");
  await codex(root, "PostToolUse", {
    session_id: session,
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "npm test" },
    tool_response: "",
  });
  assert.equal((await stateAt(root)).evidence.length, 0);

  await writeTranscript(transcriptPath, [itemCompleted(toolUseId, 0)]);
  const deniedPatch = patchCase(cases, "add_better_workflows");
  const result = await codex(root, "PreToolUse", {
    ...deniedPatch,
    session_id: session,
    transcript_path: transcriptPath,
    tool_use_id: "patch-policy-file",
  });
  assert.equal(decision(result), "deny");
  const state = await stateAt(root);
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidence[0].exitCode, 0);
});

test("missing, corrupt, unmatched, or invalid exit codes never settle a result", async (t) => {
  const cases = [
    { name: "missing file", missing: true },
    { name: "corrupt line", raw: "{not-json}\n" },
    { name: "no matching id", rows: [itemCompleted("another-tool", 0)] },
    { name: "missing exit_code", rows: [itemCompleted("exec-invalid", undefined)] },
    { name: "string exit_code", rows: [itemCompleted("exec-invalid", "0")] },
  ];

  for (const [index, scenario] of cases.entries()) {
    const { root, base } = await fixtureRepo(t);
    await writePolicy(root, { completion: { require: ["test"] } });
    const transcriptPath = path.join(base, `invalid-${index}.jsonl`);
    if (!scenario.missing) {
      if (scenario.raw !== undefined) await writeFile(transcriptPath, scenario.raw);
      else await writeTranscript(transcriptPath, scenario.rows);
    }
    const session = `session-invalid-${index}`;
    await codex(root, "SessionStart", { session_id: session, transcript_path: transcriptPath, source: "startup" });
    await writeFile(path.join(root, "app.txt"), `edited ${index}\n`);
    const toolUseId = "exec-invalid";
    await codex(root, "PreToolUse", {
      session_id: session,
      transcript_path: transcriptPath,
      tool_name: "Bash",
      tool_use_id: toolUseId,
      tool_input: { command: "npm test" },
    });
    await codex(root, "PostToolUse", {
      session_id: session,
      transcript_path: transcriptPath,
      tool_name: "Bash",
      tool_use_id: toolUseId,
      tool_input: { command: "npm test" },
      tool_response: "",
    });
    await codex(root, "SessionStart", { session_id: session, transcript_path: transcriptPath, source: "resume" });
    assert.equal((await stateAt(root)).evidence.length, 0, scenario.name);
    const stop = await codex(root, "Stop", { session_id: session, transcript_path: transcriptPath, stop_hook_active: false });
    assert.equal(stop.output.decision, "block", scenario.name);
  }
});

test("turn_aborted without PostToolUse or a matching completion remains pending", async (t) => {
  const captured = (await readFixture("captured-transcript.jsonl")).trim().split("\n").map((line) => JSON.parse(line));
  const aborts = captured.filter((row) => row.payload?.type === "turn_aborted");
  const { root, base } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
  const transcriptPath = path.join(base, "aborted-only.jsonl");
  await writeTranscript(transcriptPath, aborts);
  const session = "session-aborted";
  const toolUseId = "exec-aborted";
  await codex(root, "PreToolUse", {
    session_id: session,
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "git push origin main" },
  });
  // The host emits no PostToolUse for either an interrupt or a permission refusal.
  await codex(root, "SessionStart", { session_id: session, transcript_path: transcriptPath, source: "resume" });
  const action = [...(await stateAt(root)).actions.values()][0];
  assert.equal(action.status, "pending");
});

test("Codex maps policy ask to deny and protects Better Workflows commands", async (t) => {
  const { root } = await fixtureRepo(t);
  await writePolicy(root, {
    actions: {
      custom: [{ kind: "deploy", argv: [["./deploy.sh"]] }],
      rules: { deploy: "ask" },
    },
  });
  const asked = await codex(root, "PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "exec-ask",
    tool_input: { command: "./deploy.sh prod" },
  });
  assert.equal(decision(asked), "deny");
  assert.match(asked.output.hookSpecificOutput.permissionDecisionReason, /Codex 不支援 ask；請人調整 policy 後重試/);

  for (const command of [
    "bw run --kind test -- true",
    "bw init",
    "bw reconcile act_fixture",
  ]) {
    const result = await codex(root, "PreToolUse", {
      tool_name: "Bash",
      tool_use_id: `exec-${command.split(" ")[1]}`,
      tool_input: { command },
    });
    assert.equal(decision(result), "deny", command);
  }
});

test("apply_patch headers deny protected paths, symlinks, and unrecognized formats", async (t) => {
  const cases = JSON.parse(await readFixture("apply-patch-cases.json"));
  const { root, base } = await fixtureRepo(t);
  await symlink(root, path.join(base, "linked"));

  for (const label of [
    "add_better_workflows",
    "update_git_marker",
    "update_git_config",
    "delete_git_config",
    "move_to_protected",
    "symlinked_better_workflows",
    "unrecognized_header",
    "no_header",
  ]) {
    const fixture = patchCase(cases, label);
    const result = await codex(root, fixture.hook_event_name, {
      tool_name: fixture.tool_name,
      tool_use_id: `patch-${label}`,
      tool_input: fixture.tool_input,
    });
    assert.equal(decision(result), "deny", label);
  }
  const allowed = patchCase(cases, "allowed_source");
  assert.equal((await codex(root, allowed.hook_event_name, {
    tool_name: allowed.tool_name,
    tool_use_id: "patch-safe-source",
    tool_input: allowed.tool_input,
  })).output, null);
});

test("apply_patch protects linked worktree .git markers and the physical gitDir", async (t) => {
  const { root, base } = await fixtureRepo(t);
  const linked = path.join(base, "linked-worktree");
  sh(root, "worktree", "add", "--detach", linked, "HEAD");
  const linkedRepo = await openRepo(linked);
  const targets = [
    ".git",
    ".git/config",
    path.join(linkedRepo.gitDir, "HEAD"),
  ];

  for (const [index, target] of targets.entries()) {
    const command = `*** Begin Patch\n*** Add File: ${target}\n+fixture\n*** End Patch\n`;
    const result = await codex(linked, "PreToolUse", {
      tool_name: "apply_patch",
      tool_use_id: `linked-patch-${index}`,
      tool_input: { command },
    });
    assert.equal(decision(result), "deny", target);
  }
});

test("Claude evidence satisfies Codex Stop, and Codex evidence satisfies Claude Stop", async (t) => {
  const { root: claudeEvidenceRoot } = await fixtureRepo(t);
  await writePolicy(claudeEvidenceRoot, { completion: { require: ["test"] } });
  const codexSession = "codex-cross-host";
  await codex(claudeEvidenceRoot, "SessionStart", { session_id: codexSession, source: "startup" });
  await writeFile(path.join(claudeEvidenceRoot, "app.txt"), "edit before Claude test\n");
  const claudeToolId = "claude-evidence-call";
  const claudeTool = { tool_name: "Bash", tool_use_id: claudeToolId, tool_input: { command: "npm test" } };
  await claude(claudeEvidenceRoot, "PreToolUse", claudeTool);
  await claude(claudeEvidenceRoot, "PostToolUse", {
    ...claudeTool,
    tool_response: { stdout: "", stderr: "", interrupted: false },
  });
  assert.equal((await codex(claudeEvidenceRoot, "Stop", { session_id: codexSession, stop_hook_active: false })).output, null);

  const { root: codexEvidenceRoot, base } = await fixtureRepo(t);
  await writePolicy(codexEvidenceRoot, { completion: { require: ["test"] } });
  const claudeSession = "claude-cross-host";
  await claude(codexEvidenceRoot, "SessionStart", { session_id: claudeSession, source: "startup" });
  await writeFile(path.join(codexEvidenceRoot, "app.txt"), "edit before Codex test\n");
  const transcriptPath = path.join(base, "codex-cross-host.jsonl");
  const toolUseId = "codex-evidence-call";
  await writeTranscript(transcriptPath, [itemCompleted(toolUseId, 0)]);
  const tool = { tool_name: "Bash", tool_use_id: toolUseId, tool_input: { command: "npm test" } };
  await codex(codexEvidenceRoot, "PreToolUse", { ...tool, transcript_path: transcriptPath });
  await codex(codexEvidenceRoot, "PostToolUse", { ...tool, transcript_path: transcriptPath, tool_response: "" });
  assert.equal((await claude(codexEvidenceRoot, "Stop", { session_id: claudeSession, stop_hook_active: false })).output, null);
});

test("Claude push success blocks the same Codex push", async (t) => {
  const { root } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
  const tool = { tool_name: "Bash", tool_use_id: "claude-push", tool_input: { command: "git push origin main" } };
  assert.equal((await claude(root, "PreToolUse", tool)).output, null);
  await claude(root, "PostToolUse", {
    ...tool,
    tool_response: { stdout: "", stderr: "", interrupted: false },
  });

  const retry = await codex(root, "PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "codex-retry-push",
    tool_input: { command: "git push origin main" },
  });
  assert.equal(decision(retry), "deny");
  assert.match(retry.output.hookSpecificOutput.permissionDecisionReason, /already succeeded/);
});

test("an unknown Codex push blocks Claude's next side effect", async (t) => {
  const { root, base } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
  const transcriptPath = path.join(base, "push-unknown.jsonl");
  const toolUseId = "codex-push-unknown";
  await writeTranscript(transcriptPath, [itemCompleted(toolUseId, 3)]);
  const tool = { tool_name: "Bash", tool_use_id: toolUseId, tool_input: { command: "git push origin main" } };
  await codex(root, "PreToolUse", { ...tool, transcript_path: transcriptPath });
  await codex(root, "PostToolUse", { ...tool, transcript_path: transcriptPath, tool_response: "" });
  assert.equal([... (await stateAt(root)).actions.values()][0].status, "unknown");

  // A failed read-only provider probe must leave the result unknown and block the retry.
  sh(root, "remote", "set-url", "origin", path.join(base, "unavailable.git"));
  const retry = await claude(root, "PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "claude-next-side-effect",
    tool_input: { command: "git push origin main" },
  });
  assert.equal(decision(retry), "deny");
  assert.match(retry.output.hookSpecificOutput.permissionDecisionReason, /unknown result/);
});

test("host and session collisions do not consume another pending tool call", async (t) => {
  const { root: hostRoot, base: hostBase } = await fixtureRepo(t);
  await writePolicy(hostRoot, { completion: { require: ["test"] } });
  const sharedId = "same-tool-id";
  const codexTranscript = path.join(hostBase, "same-id-codex.jsonl");
  const claudeTranscript = path.join(hostBase, "same-id-claude.jsonl");
  await writeTranscript(codexTranscript, [itemCompleted(sharedId, 0)]);
  await writeTranscript(claudeTranscript, []);
  const claudeTool = { tool_name: "Bash", tool_use_id: sharedId, tool_input: { command: "npm test" } };
  await codex(hostRoot, "PreToolUse", {
    session_id: "same-session",
    transcript_path: codexTranscript,
    ...claudeTool,
  });
  await claude(hostRoot, "PreToolUse", {
    session_id: "same-session",
    transcript_path: claudeTranscript,
    ...claudeTool,
  });
  await codex(hostRoot, "PostToolUse", {
    session_id: "same-session",
    transcript_path: codexTranscript,
    ...claudeTool,
    tool_response: "",
  });
  let state = await stateAt(hostRoot);
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidence[0].host, "codex");
  await claude(hostRoot, "PostToolUseFailure", {
    session_id: "same-session",
    transcript_path: claudeTranscript,
    ...claudeTool,
    error: "Exit code 1\nfixture failure",
    is_interrupt: false,
  });
  state = await stateAt(hostRoot);
  assert.deepEqual(state.evidence.map((row) => [row.host, row.exitCode]).sort(), [["claude-code", 1], ["codex", 0]]);

  const { root: sessionRoot, base: sessionBase } = await fixtureRepo(t);
  await writePolicy(sessionRoot, { completion: { require: ["test"] } });
  const transcriptA = path.join(sessionBase, "session-a.jsonl");
  const transcriptB = path.join(sessionBase, "session-b.jsonl");
  await writeTranscript(transcriptA, []);
  await writeTranscript(transcriptB, [itemCompleted("reused-tool-id", 0)]);
  const sessionA = "codex-session-a";
  const sessionB = "codex-session-b";
  await codex(sessionRoot, "SessionStart", { session_id: sessionA, transcript_path: transcriptA, source: "startup" });
  await writeFile(path.join(sessionRoot, "app.txt"), "edit between sessions\n");
  await codex(sessionRoot, "SessionStart", { session_id: sessionB, transcript_path: transcriptB, source: "startup" });
  assert.equal((await codex(sessionRoot, "Stop", { session_id: sessionB, transcript_path: transcriptB, stop_hook_active: false })).output, null);
  assert.equal((await codex(sessionRoot, "Stop", { session_id: sessionA, transcript_path: transcriptA, stop_hook_active: false })).output.decision, "block");

  const reused = { tool_name: "Bash", tool_use_id: "reused-tool-id", tool_input: { command: "npm test" } };
  await codex(sessionRoot, "PreToolUse", { session_id: sessionA, transcript_path: transcriptA, ...reused });
  await codex(sessionRoot, "PreToolUse", { session_id: sessionB, transcript_path: transcriptB, ...reused });
  await codex(sessionRoot, "PostToolUse", { session_id: sessionB, transcript_path: transcriptB, ...reused, tool_response: "" });
  state = await stateAt(sessionRoot);
  assert.deepEqual(state.evidence.map((row) => [row.session, row.exitCode]), [[sessionB, 0]]);

  await writeTranscript(transcriptA, [itemCompleted("reused-tool-id", 1)]);
  await codex(sessionRoot, "FutureHookEvent", { session_id: sessionA, transcript_path: transcriptA, turn_id: "later-turn" });
  state = await stateAt(sessionRoot);
  assert.deepEqual(state.evidence.map((row) => [row.session, row.exitCode]).sort(), [[sessionA, 1], [sessionB, 0]]);
});

test("duplicate PreToolUse does not overwrite pending evidence; duplicate PostToolUse does not duplicate it", async (t) => {
  const { root, base } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  const transcriptPath = path.join(base, "duplicate.jsonl");
  await writeTranscript(transcriptPath, []);
  const session = "session-duplicate";
  await codex(root, "SessionStart", { session_id: session, transcript_path: transcriptPath, source: "startup" });
  await writeFile(path.join(root, "app.txt"), "tree before first PreToolUse\n");
  const tool = { tool_name: "Bash", tool_use_id: "exec-replayed", tool_input: { command: "npm test" } };
  await codex(root, "PreToolUse", { session_id: session, turn_id: "turn-first", transcript_path: transcriptPath, ...tool });
  await writeFile(path.join(root, "app.txt"), "tree after command started\n");
  await codex(root, "PreToolUse", { session_id: session, turn_id: "turn-replayed", transcript_path: transcriptPath, ...tool });
  await writeTranscript(transcriptPath, [itemCompleted("exec-replayed", 0)]);
  await codex(root, "PostToolUse", { session_id: session, turn_id: "turn-complete", transcript_path: transcriptPath, ...tool, tool_response: "" });
  let state = await stateAt(root);
  assert.equal(state.evidence.length, 1);
  assert.notEqual(state.evidence[0].treeBefore, state.evidence[0].treeAfter);
  const stop = await codex(root, "Stop", { session_id: session, transcript_path: transcriptPath, stop_hook_active: false });
  assert.equal(stop.output.decision, "block");
  assert.match(stop.output.reason, /files changed while it ran/);

  await codex(root, "PostToolUse", { session_id: session, turn_id: "turn-duplicate-post", transcript_path: transcriptPath, ...tool, tool_response: "" });
  state = await stateAt(root);
  assert.equal(state.evidence.length, 1);
});


test("the same session id is isolated between Claude Code and Codex", async (t) => {
  const { root, base } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  const session = "shared-session-id";
  const transcriptPath = path.join(base, "shared-session.jsonl");
  await writeTranscript(transcriptPath, []);

  await claude(root, "SessionStart", { session_id: session, source: "startup" });
  await writeFile(path.join(root, "app.txt"), "edited between host starts\n");
  await codex(root, "SessionStart", {
    session_id: session,
    transcript_path: transcriptPath,
    source: "startup",
  });

  assert.equal((await codex(root, "Stop", {
    session_id: session,
    transcript_path: transcriptPath,
    stop_hook_active: false,
  })).output, null);
  const claudeStop = await claude(root, "Stop", { session_id: session, stop_hook_active: false });
  assert.equal(claudeStop.output.decision, "block");
});

test("concurrent duplicate PostToolUse events record evidence once", async (t) => {
  const { root, base } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  const transcriptPath = path.join(base, "concurrent-post.jsonl");
  const toolUseId = "concurrent-test-call";
  await writeTranscript(transcriptPath, [itemCompleted(toolUseId, 0)]);
  const tool = {
    session_id: "session-concurrent-post",
    turn_id: "turn-concurrent-post",
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "npm test" },
  };

  assert.equal((await codex(root, "PreToolUse", tool)).output, null);
  const posts = await Promise.all([
    codex(root, "PostToolUse", { ...tool, tool_response: "" }),
    codex(root, "PostToolUse", { ...tool, tool_response: "" }),
  ]);
  assert.deepEqual(posts.map(({ output }) => output), [null, null]);
  const evidence = (await stateAt(root)).evidence;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].exitCode, 0);
});

test("a late transcript success does not overwrite a manually settled failed action", async (t) => {
  const { root, base } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
  const transcriptPath = path.join(base, "manually-failed-push.jsonl");
  const toolUseId = "manually-failed-push";
  const tool = {
    session_id: "session-manual-reconcile",
    turn_id: "turn-manual-reconcile",
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "git push origin main" },
  };
  await writeTranscript(transcriptPath, []);
  assert.equal((await codex(root, "PreToolUse", tool)).output, null);
  const pendingAction = [...(await stateAt(root)).actions.values()][0];
  assert.equal(pendingAction.status, "pending");

  await reconcileManually(await openRepo(root), pendingAction.id, "failed", "fixture confirms the push did not happen");
  await writeTranscript(transcriptPath, [itemCompleted(toolUseId, 0)]);
  await codex(root, "PostToolUse", { ...tool, tool_response: "" });

  const settledAction = (await stateAt(root)).actions.get(pendingAction.id);
  assert.equal(settledAction.status, "failed");
  assert.equal(settledAction.history.length, 1);
  assert.equal(settledAction.history[0].method, "manual");
});

test("a delayed completion after turn_aborted settles successfully without PostToolUse", async (t) => {
  const { root, base } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
  const transcriptPath = path.join(base, "abort-then-complete.jsonl");
  const toolUseId = "abort-then-complete-push";
  const tool = {
    session_id: "session-abort-then-complete",
    turn_id: "turn-aborted",
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "git push origin main" },
  };
  await writeTranscript(transcriptPath, [turnAborted()]);
  assert.equal((await codex(root, "PreToolUse", tool)).output, null);
  await codex(root, "SessionStart", {
    session_id: tool.session_id,
    turn_id: tool.turn_id,
    transcript_path: transcriptPath,
    source: "resume",
  });
  let action = [...(await stateAt(root)).actions.values()][0];
  assert.equal(action.status, "pending");

  await writeTranscript(transcriptPath, [turnAborted(), itemCompleted(toolUseId, 0)]);
  await codex(root, "FutureHookEvent", {
    session_id: tool.session_id,
    turn_id: "turn-later",
    transcript_path: transcriptPath,
  });
  action = [...(await stateAt(root)).actions.values()][0];
  assert.equal(action.status, "success");
});


test("replaying a completed evidence call cannot certify a later tree", async (t) => {
  const { root, base, repo } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  const transcriptPath = path.join(base, "completed-call-replay.jsonl");
  const session = "session-completed-call-replay";
  const toolUseId = "completed-test-call";
  const tool = {
    session_id: session,
    turn_id: "turn-first-test",
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "npm test" },
  };
  await writeTranscript(transcriptPath, [itemCompleted(toolUseId, 0)]);
  await codex(root, "SessionStart", { session_id: session, transcript_path: transcriptPath, source: "startup" });
  assert.equal((await codex(root, "PreToolUse", tool)).output, null);
  await codex(root, "PostToolUse", { ...tool, tool_response: "" });

  let state = await stateAt(root);
  assert.equal(state.evidence.length, 1);
  const originalEvidence = state.evidence[0];
  const treeAtEvidence = await worktreeTree(repo);
  assert.equal(originalEvidence.treeAfter, treeAtEvidence);
  assert.equal(originalEvidence.exitCode, 0);

  await writeFile(path.join(root, "app.txt"), "changed after test evidence\n");
  const changedTree = await worktreeTree(repo);
  assert.notEqual(changedTree, originalEvidence.treeAfter);
  const stopAfterEdit = await codex(root, "Stop", {
    session_id: session,
    transcript_path: transcriptPath,
    stop_hook_active: false,
  });
  assert.equal(stopAfterEdit.output.decision, "block");

  const replayedPre = await codex(root, "PreToolUse", {
    ...tool,
    turn_id: "turn-replayed-test",
  });
  if (replayedPre.output === null) {
    await codex(root, "PostToolUse", {
      ...tool,
      turn_id: "turn-replayed-post",
      tool_response: "",
    });
  }

  state = await stateAt(root);
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidence[0].treeAfter, originalEvidence.treeAfter);
  assert.notEqual(state.evidence[0].treeAfter, changedTree);
  const stopAfterReplay = await codex(root, "Stop", {
    session_id: session,
    transcript_path: transcriptPath,
    stop_hook_active: false,
  });
  assert.equal(stopAfterReplay.output.decision, "block");
});

test("apply_patch protects linked worktree common-dir config and symlinks to it", async (t) => {
  const { root, base } = await fixtureRepo(t);
  const linked = path.join(base, "linked-worktree-common-config");
  sh(root, "worktree", "add", "--detach", linked, "HEAD");
  const linkedRepo = await openRepo(linked);
  const commonDir = sh(linked, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const commonConfig = path.join(commonDir, "config");
  const commonConfigLink = path.join(linked, "common-config-link");
  await symlink(commonConfig, commonConfigLink);
  const targets = [path.join(linkedRepo.gitDir, "HEAD"), commonConfig, "common-config-link"];
  const outcomes = [];

  for (const [index, target] of targets.entries()) {
    const command = `*** Begin Patch\n*** Add File: ${target}\n+fixture\n*** End Patch\n`;
    const result = await codex(linked, "PreToolUse", {
      tool_name: "apply_patch",
      tool_use_id: `linked-common-patch-${index}`,
      tool_input: { command },
    });
    outcomes.push({ target, decision: decision(result) });
  }

  assert.deepEqual(outcomes.map(({ decision: result }) => result), ["deny", "deny", "deny"], JSON.stringify(outcomes));
});


test("a stale failed push probe cannot overwrite an explicit PostToolUse success", async (t) => {
  const { root, base, repo } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
  const transcriptPath = path.join(base, "push-probe-race.jsonl");
  const session = "session-push-probe-race";
  const toolUseId = "push-probe-race";
  const tool = {
    session_id: session,
    turn_id: "turn-push-start",
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "git push origin main" },
  };
  await writeTranscript(transcriptPath, []);
  assert.equal((await codex(root, "PreToolUse", tool)).output, null);
  const pendingAction = [...(await stateAt(root)).actions.values()][0];
  assert.equal(pendingAction.status, "pending");

  let probeStartedResolve;
  const probeStarted = new Promise((resolve) => { probeStartedResolve = resolve; });
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  let reconciliation;
  let postPromise;
  let postTimeout;
  try {
    reconciliation = reconcileOpen(repo, {
      exec: async () => {
        probeStartedResolve();
        await probeGate;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await Promise.race([
      probeStarted,
      reconciliation.then(() => { throw new Error("the pending push probe did not call exec"); }),
    ]);

    await writeTranscript(transcriptPath, [itemCompleted(toolUseId, 0)]);
    postPromise = codex(root, "PostToolUse", { ...tool, turn_id: "turn-push-complete", tool_response: "" });
    const post = await Promise.race([
      postPromise,
      new Promise((_, reject) => {
        postTimeout = setTimeout(() => reject(new Error("PostToolUse blocked while the provider probe was pending")), 5_000);
      }),
    ]);
    clearTimeout(postTimeout);
    postTimeout = null;
    assert.equal(post.output, null);
    assert.equal((await stateAt(root)).actions.get(pendingAction.id).status, "success");
  } finally {
    if (postTimeout) clearTimeout(postTimeout);
    releaseProbe();
    if (reconciliation) await reconciliation.catch(() => {});
    if (postPromise) await postPromise.catch(() => {});
  }

  const probes = await reconciliation;
  assert.equal(probes[0].outcome, "success");
  assert.equal((await stateAt(root)).actions.get(pendingAction.id).status, "success");
  const retry = await codex(root, "PreToolUse", {
    ...tool,
    session_id: session,
    turn_id: "turn-push-retry",
    tool_use_id: "push-probe-race-retry",
  });
  assert.equal(decision(retry), "deny");
  assert.match(retry.output.hookSpecificOutput.permissionDecisionReason, /already succeeded/);
});

test("a consumed evidence call cannot be rebound after PostToolUse snapshot failure", async (t) => {
  const { root, base, repo } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  const transcriptPath = path.join(base, "post-snapshot-failure.jsonl");
  const session = "session-post-snapshot-failure";
  const toolUseId = "post-snapshot-failure-test";
  const tool = {
    session_id: session,
    turn_id: "turn-snapshot-failure",
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "npm test" },
  };
  await writeTranscript(transcriptPath, []);
  await codex(root, "SessionStart", { session_id: session, transcript_path: transcriptPath, source: "startup" });
  assert.equal((await codex(root, "PreToolUse", tool)).output, null);

  const sidecar = pendingFile(repo, "codex", toolUseId, session);
  const pending = JSON.parse(await readFile(sidecar, "utf8"));
  assert.notEqual(pending.ignore, undefined);
  pending.ignore = {};
  await writeFile(sidecar, JSON.stringify(pending));
  await writeTranscript(transcriptPath, [itemCompleted(toolUseId, 0)]);
  await codex(root, "PostToolUse", { ...tool, tool_response: "" });
  assert.equal((await stateAt(root)).evidence.length, 0);

  await writeFile(path.join(root, "app.txt"), "changed after snapshot failure\n");
  const changedTree = await worktreeTree(repo);
  await codex(root, "PreToolUse", {
    ...tool,
    turn_id: "turn-snapshot-failure-replay",
  });

  const stopped = await codex(root, "Stop", {
    session_id: session,
    transcript_path: transcriptPath,
    stop_hook_active: false,
  });
  assert.equal(stopped.output.decision, "block");
  const state = await stateAt(root);
  assert.equal(state.evidence.length, 0);
  assert.notEqual(changedTree, pending.treeBefore);
});


test("a stale probe preserves a newer unknown reconciliation history entry", async (t) => {
  const { root, base, repo } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
  const transcriptPath = path.join(base, "unknown-history-race.jsonl");
  const session = "session-unknown-history-race";
  const toolUseId = "unknown-history-race-push";
  const tool = {
    session_id: session,
    turn_id: "turn-unknown-push",
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "git push origin main" },
  };
  await writeTranscript(transcriptPath, []);
  await codex(root, "PreToolUse", tool);
  await writeTranscript(transcriptPath, [itemCompleted(toolUseId, 3)]);
  await codex(root, "PostToolUse", { ...tool, tool_response: "" });

  const action = [...(await stateAt(root)).actions.values()][0];
  assert.equal(action.status, "unknown");
  assert.equal(action.history.length, 1);

  let probeStartedResolve;
  const probeStarted = new Promise((resolve) => { probeStartedResolve = resolve; });
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  let reconciliation;
  try {
    reconciliation = reconcileOpen(repo, {
      exec: async () => {
        probeStartedResolve();
        await probeGate;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await Promise.race([
      probeStarted,
      reconciliation.then(() => { throw new Error("the unknown push probe did not call exec"); }),
    ]);

    await appendEvent(repo, "action.reconciled", {
      id: action.id,
      outcome: "unknown",
      method: "probe",
      detail: "newer concurrent probe could not confirm the push",
    });
    const concurrentState = (await stateAt(root)).actions.get(action.id);
    assert.equal(concurrentState.status, "unknown");
    assert.equal(concurrentState.history.length, 2);
    assert.equal(concurrentState.history[1].detail, "newer concurrent probe could not confirm the push");
  } finally {
    releaseProbe();
    if (reconciliation) await reconciliation.catch(() => {});
  }

  const probeResults = await reconciliation;
  assert.equal(probeResults[0].outcome, "unknown");
  const finalAction = (await stateAt(root)).actions.get(action.id);
  assert.equal(finalAction.status, "unknown");
  assert.equal(finalAction.history.length, 2);
  assert.equal(finalAction.history[1].outcome, "unknown");
  assert.equal(finalAction.history[1].detail, "newer concurrent probe could not confirm the push");
});
