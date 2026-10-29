import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import * as core from "../src/index.mjs";
import { handleClaudeCodeHook } from "../src/adapters/claude-code.mjs";
import { handleCodexHook } from "../src/adapters/codex.mjs";
import { fixtureRepo, sh, writePolicy } from "./helpers.mjs";

const handlers = {
  codex: handleCodexHook,
  "claude-code": handleClaudeCodeHook,
};
const decision = (result) => result.output?.hookSpecificOutput?.permissionDecision ?? null;
const completionRow = (id, exitCode) => JSON.stringify({
  type: "event_msg",
  payload: {
    type: "item_completed",
    item: {
      id,
      type: "CommandExecution",
      status: exitCode === 0 ? "completed" : "failed",
      exit_code: exitCode,
    },
  },
});
const writeRows = (file, rows) => fs.promises.writeFile(file, rows.length ? rows.join("\n") + "\n" : "");

async function hook({
  host = "codex",
  root,
  name,
  session = "session-recovery",
  id,
  command,
  transcript,
  extra = {},
}) {
  const input = {
    cwd: root,
    session_id: session,
    turn_id: "turn-" + (id ?? name),
    hook_event_name: name,
    ...extra,
  };
  if (id !== undefined) input.tool_use_id = id;
  if (command !== undefined) {
    input.tool_name = "Bash";
    input.tool_input = { command };
  }
  if (transcript !== undefined) input.transcript_path = transcript;
  if (host === "claude-code" && name === "PostToolUse") {
    input.tool_response = { interrupted: false, stdout: "", stderr: "" };
  } else if (host === "codex" && name === "PostToolUse") {
    input.tool_response = "";
  }
  return handlers[host](input);
}

async function preTest(root, session, id, transcript, host = "codex") {
  return hook({ host, root, name: "PreToolUse", session, id, transcript, command: "npm test" });
}

async function postTest(root, session, id, transcript, host = "codex", exitCode = 0) {
  if (host === "codex") await writeRows(transcript, [completionRow(id, exitCode)]);
  return hook({ host, root, name: exitCode === 0 ? "PostToolUse" : "PostToolUseFailure", session, id, transcript, command: "npm test" });
}

async function currentEvidence(repo, kind = "test") {
  return core.evidenceStatus(
    await core.loadState(repo),
    kind,
    { tree: await core.worktreeTree(repo) },
  );
}

function findAction(state, toolUseId) {
  return [...state.actions.values()].find((action) => action.toolUseId === toolUseId);
}

function watchTranscriptReads(t, transcript) {
  const original = fs.promises.readFile;
  let count = 0;
  fs.promises.readFile = async function (file, ...args) {
    if (path.resolve(String(file)) === path.resolve(transcript)) count++;
    return original.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.promises.readFile = original;
    syncBuiltinESMExports();
  });
  return {
    count: () => count,
    reset: () => { count = 0; },
  };
}

test("Codex recovery follows same-transcript completion order when pending filenames sort in reverse", async (t) => {
  const { root, base, repo } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  const session = "session-delayed-order";
  const transcript = path.join(base, "completion-order.jsonl");
  await writeRows(transcript, []);
  await hook({ root, name: "SessionStart", session, transcript, extra: { source: "startup" } });
  await fs.promises.writeFile(path.join(root, "app.txt"), "changed\n");

  // For this session, check-a sorts before check-b in the adapter's pending
  // filename digest. The pending order is therefore the reverse of the rows.
  const failedId = "check-a";
  const passedId = "check-b";
  assert.ok(core.digest([session, failedId]) < core.digest([session, passedId]));
  await preTest(root, session, failedId, transcript);
  await preTest(root, session, passedId, transcript);
  await writeRows(transcript, [completionRow(passedId, 0), completionRow(failedId, 1)]);

  const stopped = await hook({ root, name: "Stop", session, transcript, extra: { stop_hook_active: false } });
  const evidence = await currentEvidence(repo);
  assert.ok(["failed", "uncertain", "stale", "missing", "unstable", "unattributed"].includes(evidence.status), evidence.status);
  assert.equal(stopped.output?.decision, "block");
});

test("Codex recovery accepts a success that follows a failure in the same transcript", async (t) => {
  const { root, base, repo } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  const session = "session-delayed-order";
  const transcript = path.join(base, "completion-order.jsonl");
  await writeRows(transcript, []);
  await hook({ root, name: "SessionStart", session, transcript, extra: { source: "startup" } });
  await fs.promises.writeFile(path.join(root, "app.txt"), "changed\n");

  const failedId = "check-a";
  const passedId = "check-b";
  assert.ok(core.digest([session, failedId]) < core.digest([session, passedId]));
  await preTest(root, session, failedId, transcript);
  await preTest(root, session, passedId, transcript);
  await writeRows(transcript, [completionRow(failedId, 1), completionRow(passedId, 0)]);

  const stopped = await hook({ root, name: "Stop", session, transcript, extra: { stop_hook_active: false } });
  assert.equal((await currentEvidence(repo)).status, "fresh");
  assert.equal(stopped.output, null);
});

test("a late recovery on a later hook cannot replace a newer failure", async (t) => {
  const { root, base, repo } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  const session = "session-cross-hook";
  const transcript = path.join(base, "cross-hook.jsonl");
  await writeRows(transcript, []);
  await hook({ root, name: "SessionStart", session, transcript, extra: { source: "startup" } });
  await fs.promises.writeFile(path.join(root, "app.txt"), "changed\n");

  const olderPass = "check-b";
  const newerFailure = "check-a";
  await preTest(root, session, olderPass, transcript);
  await preTest(root, session, newerFailure, transcript);

  // The newer failure becomes visible first. The older completion is added to
  // the transcript later, while its transcript position remains earlier.
  await writeRows(transcript, [completionRow(newerFailure, 1)]);
  await hook({ root, name: "PostToolUse", session, id: newerFailure, transcript, command: "npm test" });
  assert.equal((await currentEvidence(repo)).status, "failed");

  await writeRows(transcript, [completionRow(olderPass, 0), completionRow(newerFailure, 1)]);
  await hook({ root, name: "FutureHookEvent", session, transcript });
  const stopped = await hook({ root, name: "Stop", session, transcript, extra: { stop_hook_active: false } });
  assert.ok(["failed", "uncertain", "stale", "missing", "unstable", "unattributed"].includes((await currentEvidence(repo)).status));
  assert.equal(stopped.output?.decision, "block");
});

test("success without trusted cross-context order cannot clear a failure", async (t) => {
  for (const scenario of ["different-transcript", "different-session", "different-host"]) {
    await t.test(scenario, async (st) => {
      const { root, base, repo } = await fixtureRepo(st);
      await writePolicy(root, { completion: { require: ["test"] } });
      const failureSession = "session-failure";
      const successSession = scenario === "different-session" ? "session-success" : failureSession;
      const failureTranscript = path.join(base, "failure.jsonl");
      const successTranscript = path.join(base, "success.jsonl");
      await writeRows(failureTranscript, []);
      await writeRows(successTranscript, []);
      await hook({ root, name: "SessionStart", session: failureSession, transcript: failureTranscript, extra: { source: "startup" } });
      await fs.promises.writeFile(path.join(root, "app.txt"), "changed\n");

      const failureId = "test-failed";
      const successId = "test-passed";
      const host = scenario === "different-host" ? "claude-code" : "codex";
      // Both runs start before either result is recorded, so ledger order alone
      // cannot establish which check happened later across these contexts.
      await preTest(root, failureSession, failureId, failureTranscript);
      await preTest(root, successSession, successId, successTranscript, host);
      await postTest(root, failureSession, failureId, failureTranscript, "codex", 1);
      assert.equal((await currentEvidence(repo)).status, "failed");
      await postTest(root, successSession, successId, successTranscript, host, 0);

      const evidence = await currentEvidence(repo);
      const stopped = await hook({
        root,
        name: "Stop",
        session: failureSession,
        transcript: failureTranscript,
        extra: { stop_hook_active: false },
      });
      assert.notEqual(evidence.status, "fresh", scenario);
      assert.equal(stopped.output?.decision, "block", scenario);
    });
  }
});

test("a new Pre after a known failure can establish a cross-context success fence", async (t) => {
  for (const scenario of ["different-session", "different-host"]) {
    await t.test(scenario, async (st) => {
      const { root, base, repo } = await fixtureRepo(st);
      await writePolicy(root, { completion: { require: ["test"] } });
      const failureSession = "session-failure-fence";
      const successSession = scenario === "different-session" ? "session-success-fence" : failureSession;
      const failureTranscript = path.join(base, "failure-fence.jsonl");
      const successTranscript = path.join(base, "success-fence.jsonl");
      await writeRows(failureTranscript, []);
      await writeRows(successTranscript, []);
      await hook({ root, name: "SessionStart", session: failureSession, transcript: failureTranscript, extra: { source: "startup" } });
      await fs.promises.writeFile(path.join(root, "app.txt"), "changed\n");

      const failedId = "fenced-failure";
      await preTest(root, failureSession, failedId, failureTranscript);
      await postTest(root, failureSession, failedId, failureTranscript, "codex", 1);
      assert.equal((await currentEvidence(repo)).status, "failed");

      const host = scenario === "different-host" ? "claude-code" : "codex";
      const passedId = "fenced-success";
      await preTest(root, successSession, passedId, successTranscript, host);
      await postTest(root, successSession, passedId, successTranscript, host, 0);
      assert.equal((await currentEvidence(repo)).status, "fresh", scenario);

      const stopped = await hook({
        root,
        name: "Stop",
        session: failureSession,
        transcript: failureTranscript,
        extra: { stop_hook_active: false },
      });
      assert.equal(stopped.output, null, scenario);
    });
  }
});

test("a new successful rerun after a known failure clears the failure", async (t) => {
  const { root, base, repo } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  const session = "session-explicit-rerun";
  const transcript = path.join(base, "rerun.jsonl");
  await writeRows(transcript, []);
  await hook({ root, name: "SessionStart", session, transcript, extra: { source: "startup" } });
  await fs.promises.writeFile(path.join(root, "app.txt"), "changed\n");

  const failedId = "failed-run";
  await preTest(root, session, failedId, transcript);
  await writeRows(transcript, [completionRow(failedId, 1)]);
  await hook({ root, name: "PostToolUseFailure", session, id: failedId, transcript, command: "npm test" });
  assert.equal((await currentEvidence(repo)).status, "failed");

  const passedId = "successful-rerun";
  await preTest(root, session, passedId, transcript);
  await writeRows(transcript, [completionRow(failedId, 1), completionRow(passedId, 0)]);
  await hook({ root, name: "PostToolUse", session, id: passedId, transcript, command: "npm test" });

  assert.equal((await currentEvidence(repo)).status, "fresh");
  const stopped = await hook({ root, name: "Stop", session, transcript, extra: { stop_hook_active: false } });
  assert.equal(stopped.output, null);
});

test("both hosts block a second active push and accept its late exit zero", async (t) => {
  for (const host of ["codex", "claude-code"]) {
    await t.test(host, async (st) => {
      const { root, base, repo } = await fixtureRepo(st);
      await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
      const session = "session-active-push-" + host;
      const transcript = path.join(base, "push.jsonl");
      await writeRows(transcript, []);

      const firstId = "push-first";
      assert.equal((await hook({
        host, root, name: "PreToolUse", session, id: firstId, transcript, command: "git push origin main",
      })).output, null);
      let state = await core.loadState(repo);
      assert.equal(findAction(state, firstId)?.status, "pending");

      // Inject an offline provider result. No network command or push is run.
      const injected = await core.reconcileOpen(repo, {
        exec: async (program, args) => {
          assert.equal(program, "git");
          assert.equal(args[0], "ls-remote");
          return { code: 1, stdout: "", stderr: "offline test probe", timedOut: false };
        },
      });
      assert.equal(injected[0]?.outcome, "unknown");
      sh(root, "remote", "set-url", "origin", path.join(base, "unavailable-origin.git"));

      const second = await hook({
        host, root, name: "PreToolUse", session, id: "push-second", transcript, command: "git push origin main",
      });
      assert.equal(decision(second), "deny", host);
      state = await core.loadState(repo);
      assert.equal(findAction(state, firstId)?.status, "unknown");

      if (host === "codex") await writeRows(transcript, [completionRow(firstId, 0)]);
      await hook({ host, root, name: "PostToolUse", session, id: firstId, transcript, command: "git push origin main" });
      state = await core.loadState(repo);
      assert.equal(findAction(state, firstId)?.status, "success", host);
    });
  }
});

test("both hosts settle a custom deploy after its automatic probe is unknown", async (t) => {
  for (const host of ["codex", "claude-code"]) {
    await t.test(host, async (st) => {
      const { root, base, repo } = await fixtureRepo(st);
      await writePolicy(root, {
        actions: {
          custom: [{ kind: "deploy", argv: [["./deploy.sh"]] }],
          rules: { deploy: "allow" },
        },
      });
      const session = "session-deploy-" + host;
      const transcript = path.join(base, "deploy.jsonl");
      await writeRows(transcript, []);
      const firstId = "deploy-first";

      assert.equal((await hook({
        host, root, name: "PreToolUse", session, id: firstId, transcript, command: "./deploy.sh staging",
      })).output, null);
      const second = await hook({
        host, root, name: "PreToolUse", session, id: "deploy-second", transcript, command: "./deploy.sh staging",
      });
      assert.equal(decision(second), "deny", host);
      assert.equal(findAction(await core.loadState(repo), firstId)?.status, "unknown", host);

      if (host === "codex") await writeRows(transcript, [completionRow(firstId, 0)]);
      await hook({ host, root, name: "PostToolUse", session, id: firstId, transcript, command: "./deploy.sh staging" });
      assert.equal(findAction(await core.loadState(repo), firstId)?.status, "success", host);
    });
  }
});

test("a late post cannot replace a manual settlement", async (t) => {
  for (const host of ["codex", "claude-code"]) {
    await t.test(host, async (st) => {
      const { root, base, repo } = await fixtureRepo(st);
      await writePolicy(root, {
        actions: {
          custom: [{ kind: "deploy", argv: [["./deploy.sh"]] }],
          rules: { deploy: "allow" },
        },
      });
      const session = "session-manual-" + host;
      const transcript = path.join(base, "manual.jsonl");
      await writeRows(transcript, []);
      const id = "manual-deploy";
      await hook({ host, root, name: "PreToolUse", session, id, transcript, command: "./deploy.sh prod" });
      const action = findAction(await core.loadState(repo), id);
      assert.equal(action?.status, "pending", host);
      await core.reconcileManually(repo, action.id, "failed", "fixture confirms the deploy did not happen");

      if (host === "codex") await writeRows(transcript, [completionRow(id, 0)]);
      await hook({ host, root, name: "PostToolUse", session, id, transcript, command: "./deploy.sh prod" });
      assert.equal(findAction(await core.loadState(repo), id)?.status, "failed", host);
    });
  }
});

test("contradictory terminal transcript rows leave the action unconsumed", async (t) => {
  const { root, base, repo } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
  const session = "session-conflicting-completion";
  const transcript = path.join(base, "conflicting-completion.jsonl");
  const id = "push-conflicting-completion";
  await writeRows(transcript, []);

  assert.equal((await hook({
    root, name: "PreToolUse", session, id, transcript, command: "git push origin main",
  })).output, null);
  assert.equal(findAction(await core.loadState(repo), id)?.status, "pending");

  await writeRows(transcript, [completionRow(id, 0), completionRow(id, 1)]);
  await hook({ root, name: "FutureHookEvent", session, transcript });

  const state = await core.loadState(repo);
  assert.equal(state.consumedTools.size, 0);
  assert.equal(state.evidence.length, 0);
  assert.notEqual(findAction(state, id)?.status, "success");
});

test("legacy and new evidence with no comparable order cannot be fresh", async (t) => {
  const { repo } = await fixtureRepo(t);
  const tree = await core.worktreeTree(repo);
  const head = await core.headCommit(repo);
  const common = {
    kind: "test",
    command: "npm test",
    treeBefore: tree,
    treeAfter: tree,
    head,
    scope: null,
    scopeBefore: null,
    scopeAfter: null,
    outputDigest: null,
    host: "codex",
  };

  await core.appendEvent(repo, "evidence.recorded", {
    ...common,
    exitCode: 1,
    session: "legacy-session",
  });
  await core.appendEvent(repo, "evidence.recorded", {
    ...common,
    exitCode: 0,
    session: "new-session",
    toolUseId: "new-success",
    order: { startedAfterSeq: null, completion: null },
  });

  const evidence = core.evidenceStatus(await core.loadState(repo), "test", { tree });
  assert.notEqual(evidence.status, "fresh");
});

test("malformed or cyclic ordering metadata cannot produce fresh evidence", async (t) => {
  const { repo } = await fixtureRepo(t);
  const tree = await core.worktreeTree(repo);
  const snapshotId = "a".repeat(64);
  const record = (overrides) => ({
    kind: "test",
    command: "npm test",
    exitCode: 0,
    treeBefore: tree,
    treeAfter: tree,
    head: "fixture-head",
    scope: null,
    scopeBefore: null,
    scopeAfter: null,
    outputDigest: null,
    host: "codex",
    session: "ordering-test",
    toolUseId: "run",
    seq: 1,
    ...overrides,
  });

  const malformed = [
    record({ order: { startedAfterSeq: -1, completion: null } }),
    record({ order: { startedAfterSeq: null, completion: { snapshotId: "bad", position: -1 } } }),
  ];
  for (const entry of malformed) {
    const result = core.evidenceStatus({ evidence: [entry] }, "test", { tree });
    assert.notEqual(result.status, "fresh");
  }

  // The ledger fence orders A before B, while positions in the same transcript
  // order B before A. Conflicting proof must fail closed.
  const cycle = [
    record({
      toolUseId: "run-a",
      seq: 3,
      order: { startedAfterSeq: 1, completion: { snapshotId, position: 2 } },
    }),
    record({
      toolUseId: "run-b",
      seq: 4,
      order: { startedAfterSeq: 3, completion: { snapshotId, position: 1 } },
    }),
  ];
  const result = core.evidenceStatus({ evidence: cycle }, "test", { tree });
  assert.notEqual(result.status, "fresh");
});

test("Codex skips transcript reads for read-only hooks with no pending call", async (t) => {
  const { root, base } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  const transcript = path.join(base, "read-only.jsonl");
  await writeRows(transcript, []);
  const reads = watchTranscriptReads(t, transcript);

  await hook({ root, name: "PreToolUse", session: "session-no-pending", id: "read-only", transcript, command: "ls" });
  await hook({ root, name: "PostToolUse", session: "session-no-pending", id: "read-only", transcript, command: "ls" });
  assert.equal(reads.count(), 0, "read-only hooks with no pending call must not read a transcript");
});

test("Codex reads one shared transcript at most once for 25 pending calls", async (t) => {
  const { root, base } = await fixtureRepo(t);
  await writePolicy(root, { completion: { require: ["test"] } });
  const transcript = path.join(base, "shared.jsonl");
  await writeRows(transcript, []);
  const reads = watchTranscriptReads(t, transcript);

  const session = "session-many-pending";
  for (let i = 0; i < 25; i++) {
    await preTest(root, session, "pending-" + i, transcript);
  }
  reads.reset();
  await hook({ root, name: "FutureHookEvent", session, transcript });
  assert.ok(reads.count() <= 1, "a shared transcript is read once per hook");
});

