import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { main } from "../src/cli.mjs";
import { appendEvent, readLedger } from "../src/ledger.mjs";
import { captureIo, fixtureRepo } from "./helpers.mjs";

async function cli(root, args, input) {
  const { io, out, err } = captureIo();
  io.stdin = Readable.from([Buffer.from(JSON.stringify(input ?? {}))]);
  const code = await main(args, { cwd: root, io });
  return { code, out: out.join(""), err: err.join("") };
}

test("the CLI routes Codex hooks and leaves native approval to Codex", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  const input = { cwd: root, session_id: "codex-cli", turn_id: "turn-cli" };
  const start = await cli(root, ["hook", "codex"], { ...input, hook_event_name: "SessionStart" });
  assert.equal(start.code, 0);
  assert.equal(JSON.parse(start.out).hookSpecificOutput.hookEventName, "SessionStart");
  const pre = { ...input, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "exec-cli", tool_input: { command: "git push origin main" } };
  const denied = await cli(root, ["hook", "codex"], pre);
  assert.equal(denied.code, 0);
  assert.equal(JSON.parse(denied.out).hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.out, /Codex hooks cannot ask; change the policy and retry/);
  assert.equal((await readLedger(repo)).some((e) => e.type === "action.begun"), false);
  const allowed = await cli(root, ["hook", "codex"], { ...pre, tool_input: { command: "git status" } });
  assert.equal(allowed.code, 0);
  assert.equal(allowed.out, "");
  for (const host of ["unsupported", "constructor", "__proto__"]) {
    const unknown = await cli(root, ["hook", host]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /hook supports: claude-code, codex/);
  }
});

test("status reports the latest session event for each host including a resumed session", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  const add = (host, session) => appendEvent(repo, "session.started", { host, session, tree: null, head: null });
  await add("claude-code", "shared-id");
  await add("codex", "shared-id");
  const resumed = await add("claude-code", "shared-id");
  const ledger = await readLedger(repo);
  const expected = Object.fromEntries(ledger.filter((e) => e.type === "session.started").map((e) => [e.data.host, { id: e.data.session, at: e.at }]));
  const json = await cli(root, ["status", "--json"]);
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.out).sessionsByHost, expected);
  assert.equal(expected["claude-code"].at, resumed.at);
  const human = await cli(root, ["status"]);
  assert.equal(human.code, 0);
  for (const [host, session] of Object.entries(expected)) {
    assert.ok(human.out.includes(`last session for ${host}: ${session.at} (${session.id})`));
  }
});
