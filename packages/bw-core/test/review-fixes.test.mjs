import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as core from "../src/index.mjs";
import { handleClaudeCodeHook } from "../src/adapters/claude-code.mjs";
import { handleCodexHook } from "../src/adapters/codex.mjs";
import { pendingFile } from "../src/adapters/shared.mjs";
import { main } from "../src/cli.mjs";
import { captureIo, fixtureRepo, writePolicy } from "./helpers.mjs";

const hosts = [["claude-code", handleClaudeCodeHook], ["codex", handleCodexHook]];
const warning = (v) => `ledger has entries from a newer Better Workflows (ledger v${v}); upgrade @better-workflows/core before running side effects`;
const input = (root, host, event, fields = {}) => ({ cwd: root, session_id: `${host}-version-test`, hook_event_name: event, ...fields });
const completionRow = (id) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id, status: "completed", exit_code: 0 } } });

// Simulate another writer without asking the current append API to forge a version.
async function appendRaw(repo, spec) {
  const prior = (await core.readLedger(repo)).at(-1);
  const entry = { ...spec, seq: (prior?.seq ?? 0) + 1, at: "2026-10-22T00:00:00.000Z", prev: prior?.hash ?? "0".repeat(64) };
  entry.hash = core.digest(entry);
  await appendFile(core.ledgerPath(repo), `${JSON.stringify(entry)}\n`);
  await writeFile(path.join(repo.stateDir, "ledger.head"), JSON.stringify({ seq: entry.seq, hash: entry.hash }));
  return entry;
}

async function cli(root, ...args) {
  const { io, out, err } = captureIo();
  const code = await main(args, { cwd: root, io });
  return { code, out: out.join(""), err: err.join("") };
}

test("twenty read-only Bash calls per host leave the ledger unchanged", async (t) => {
  for (const [host, handle] of hosts) {
    const { root, base, repo } = await fixtureRepo(t);
    await core.appendEvent(repo, "note", { seed: host });
    const before = await readFile(core.ledgerPath(repo), "utf8");
    const transcript = path.join(base, "read-only.jsonl");
    await writeFile(transcript, Array.from({ length: 20 }, (_, i) => completionRow(`read-${i}`)).join("\n") + "\n");
    for (let i = 0; i < 20; i++) {
      const fields = { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: `read-${i}`, transcript_path: transcript };
      assert.equal((await handle(input(root, host, "PreToolUse", fields))).output, null);
      assert.equal((await handle(input(root, host, "PostToolUse", { ...fields, tool_response: host === "codex" ? "" : {} }))).output, null);
    }
    assert.equal((await core.readLedger(repo)).length, 1, host);
    assert.equal(await readFile(core.ledgerPath(repo), "utf8"), before, host);
  }
});

test("legacy ledger bytes remain readable and unchanged when a v1 entry is appended", async (t) => {
  const { repo } = await fixtureRepo(t);
  const old = await appendRaw(repo, { type: "session.started", data: { host: "claude-code", session: "legacy" } });
  const bytes = await readFile(core.ledgerPath(repo), "utf8");
  assert.equal(Object.hasOwn(old, "v"), false);
  assert.equal((await core.readLedger(repo))[0].hash, old.hash);
  assert.equal((await core.loadState(repo)).sessions.has("legacy"), true);
  assert.equal((await core.verifyLedger(repo)).ok, true);
  assert.equal((await core.verifyLedger(repo)).maxVersion, 1);
  assert.equal(core.LEDGER_VERSION, 1);
  const added = await core.appendEvent(repo, "note", { afterUpgrade: true });
  assert.equal(added.v, 1);
  assert.equal(added.prev, old.hash);
  assert.ok((await readFile(core.ledgerPath(repo), "utf8")).startsWith(bytes));
  assert.equal(Object.hasOwn((await core.readLedger(repo))[0], "v"), false);
  assert.equal((await core.verifyLedger(repo)).ok, true);
});

test("the ledger hash authenticates the version field", async (t) => {
  const { repo } = await fixtureRepo(t);
  const entry = await core.appendEvent(repo, "note", {});
  assert.equal(entry.v, 1);
  for (const change of [({ ...entry, v: 2 }), Object.fromEntries(Object.entries(entry).filter(([k]) => k !== "v"))]) {
    await writeFile(core.ledgerPath(repo), `${JSON.stringify(change)}\n`);
    assert.equal((await core.verifyLedger(repo)).ok, false);
  }
});

test("invalid ledger versions are corruption even with a valid hash", async (t) => {
  const { repo } = await fixtureRepo(t);
  for (const v of ["x", null, 0, -1, 1.5, true]) {
    await writeFile(core.ledgerPath(repo), "");
    await rm(path.join(repo.stateDir, "ledger.head"), { force: true });
    await appendRaw(repo, { v, type: "note", data: {} });
    assert.equal((await core.verifyLedger(repo)).ok, false, `version ${JSON.stringify(v)}`);
    await assert.rejects(core.readLedger(repo));
  }
});

test("future entries are skipped in every projection and their maximum version persists", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  for (const type of ["evidence.recorded", "action.begun", "action.ended", "action.reconciled", "session.started", "completion.blocked", "tool.consumed"]) {
    await appendRaw(repo, { v: type === "session.started" ? 3 : 2, type, data: null });
  }
  await core.appendEvent(repo, "note", { laterV1: true });
  const state = await core.loadState(repo);
  assert.equal(state.newerLedger, 3);
  assert.equal(state.evidence.length, 0);
  for (const field of ["actions", "sessions", "hostSessions", "consumedTools"]) assert.equal(state[field].size, 0, field);
  const verified = await core.verifyLedger(repo);
  assert.equal(verified.ok, true);
  assert.equal(verified.maxVersion, 3);
  const policyInfo = { policy: core.normalizePolicy({ actions: { default: "allow" }, opaque: "allow" }) };
  for (const command of ["git push origin main", "echo $(date)"]) {
    const result = core.evaluateCommand({ command, policyInfo, state, head: "abc" });
    assert.equal(result.decision, "deny");
    assert.deepEqual(result.reasons, [warning(3)]);
  }
  assert.equal(core.evaluateCommand({ command: "ls", policyInfo, state, head: "abc" }).decision, "allow");
  const status = await cli(root, "status", "--json");
  assert.equal(status.code, 0);
  assert.deepEqual(JSON.parse(status.out).sessionsByHost, {});
  assert.equal(JSON.parse(status.out).newerLedger, 3);
  assert.match((await cli(root, "verify")).out, /ledger v3/);
});

test("future ledgers block completion and both hosts despite fresh evidence or Stop shortcuts", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test", "lint"] }, actions: { default: "allow" } });
  for (const [host, handle] of hosts) await handle(input(root, host, "SessionStart"));
  const tree = await core.worktreeTree(repo);
  for (const kind of ["test", "lint"]) await core.recordEvidence(repo, { kind, command: `npm run ${kind}`, exitCode: 0, treeBefore: tree, treeAfter: tree, head: await core.headCommit(repo), host: "test" });
  const { policy } = await core.loadPolicy(repo);
  assert.equal(core.completionStatus(await core.loadState(repo), policy, tree).ok, true);
  await appendRaw(repo, { v: 2, type: "future.result", data: {} });
  const status = core.completionStatus(await core.loadState(repo), policy, tree);
  assert.equal(status.ok, false);
  assert.deepEqual(status.results.map((r) => [r.kind, r.status]), [["test", "missing"], ["lint", "missing"]]);
  for (const result of status.results) assert.match(core.describeEvidence(result), /upgrade @better-workflows\/core/);
  const ledgerBefore = await readFile(core.ledgerPath(repo), "utf8");
  for (const require of [["test", "lint"], []]) {
    if (!require.length) await writePolicy(root, { completion: { require } });
    for (const [host, handle] of hosts) {
      for (const active of [false, true, false]) {
        const result = await handle(input(root, host, "Stop", { stop_hook_active: active }));
        assert.equal(result.output?.decision, "block", `${host}, require=${require}, active=${active}`);
        assert.match(result.output.reason, /upgrade @better-workflows\/core/);
      }
    }
    const checked = await cli(root, "check-completion");
    assert.equal(checked.code, 2);
    assert.match(checked.out, /upgrade @better-workflows\/core/);
    const human = await cli(root, "status");
    assert.match(human.out.split("\n")[0], /Warning: .*ledger v2.*upgrade @better-workflows\/core/);
    const json = JSON.parse((await cli(root, "status", "--json")).out);
    assert.equal(json.newerLedger, 2);
    assert.match(json.warning, /upgrade @better-workflows\/core/);
    assert.equal(json.completion.ok, false);
  }
  assert.equal(await readFile(core.ledgerPath(repo), "utf8"), ledgerBefore, "blocked Stops and status do not append");
  assert.equal((await cli(root, "verify")).code, 0);
  assert.match((await cli(root, "verify")).out, /ledger v2/);
});

test("future-ledger recovery preserves tracked pending evidence until upgrade", async (t) => {
  for (const [host, handle] of hosts) {
    const { root, base, repo } = await fixtureRepo(t);
    const transcript = path.join(base, "pending.jsonl");
    await writeFile(transcript, "");
    const fields = { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "tracked", transcript_path: transcript };
    await handle(input(root, host, "PreToolUse", fields));
    const sidecar = pendingFile(repo, host, "tracked", `${host}-version-test`);
    const saved = await readFile(sidecar, "utf8");
    await appendRaw(repo, { v: 2, type: "future.result", data: {} });
    await writeFile(transcript, completionRow("tracked") + "\n");
    const ledgerBefore = await readFile(core.ledgerPath(repo), "utf8");
    await handle(input(root, host, "PostToolUse", { ...fields, tool_response: host === "codex" ? "" : {} }));
    const stopped = await handle(input(root, host, "Stop", { transcript_path: transcript }));
    assert.equal(stopped.output?.decision, "block");
    assert.equal(await readFile(sidecar, "utf8"), saved);
    assert.equal(await readFile(core.ledgerPath(repo), "utf8"), ledgerBefore);
  }
});

test("pre-upgrade actions without session metadata remain pending for reconciliation", async (t) => {
  for (const [host, handle] of hosts) {
    const { root, base, repo } = await fixtureRepo(t);
    await appendRaw(repo, { type: "action.begun", data: { id: "old-action", kind: "git-push", host, toolUseId: "old-call", command: "git push origin main" } });
    const transcript = path.join(base, "legacy-result.jsonl");
    await writeFile(transcript, completionRow("old-call") + "\n");
    await handle(input(root, host, "PostToolUse", { tool_name: "Bash", tool_use_id: "old-call", tool_input: { command: "git push origin main" }, transcript_path: transcript, tool_response: host === "codex" ? "" : {} }));
    assert.equal((await core.loadState(repo)).actions.get("old-action").status, "pending");
    assert.equal((await core.readLedger(repo)).length, 1);
    await core.reconcileManually(repo, "old-action", "failed", "Checked that the legacy push never reached the remote");
    assert.equal((await core.loadState(repo)).actions.get("old-action").status, "failed");
  }
});

test("both Stop handlers fail closed on an invalid ledger version", async (t) => {
  const { root, repo } = await fixtureRepo(t);
  await appendRaw(repo, { v: "x", type: "note", data: {} });
  for (const [host, handle] of hosts) assert.equal((await handle(input(root, host, "Stop"))).output?.decision, "block");
});
