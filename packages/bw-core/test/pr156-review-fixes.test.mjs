import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as core from "../src/index.mjs";
import { handleClaudeCodeHook } from "../src/adapters/claude-code.mjs";
import { handleCodexHook } from "../src/adapters/codex.mjs";
import { fixtureRepo, writePolicy } from "./helpers.mjs";

const push = "git push origin HEAD:refs/heads/pr156-fixture";
const codex = (root, hook_event_name, fields = {}) => handleCodexHook({ cwd: root, hook_event_name, ...fields });
const decision = (result) => result.output?.hookSpecificOutput?.permissionDecision ?? result.output?.decision ?? null;
const completionRow = (id, exitCode) => JSON.stringify({
  type: "event_msg",
  payload: {
    type: "item_completed",
    item: { type: "CommandExecution", id, status: exitCode === 0 ? "completed" : "failed", exit_code: exitCode },
  },
});
const writeTranscript = (file, rows) => writeFile(file, rows.length ? `${rows.join("\n")}\n` : "");
const bashInput = (session, transcript, toolUseId, command) => ({
  session_id: session,
  transcript_path: transcript,
  tool_name: "Bash",
  tool_use_id: toolUseId,
  tool_input: { command },
});

async function probedFailedPush(t, name = "probed-failure") {
  const { root, base, repo } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow", "package-publish": "deny" } } });
  const session = `session-${name}`;
  const toolUseId = `push-${name}`;
  const transcript = path.join(base, `${name}.jsonl`);
  await writeTranscript(transcript, []);

  const first = await codex(root, "PreToolUse", bashInput(session, transcript, toolUseId, push));
  assert.equal(first.output, null);
  assert.equal(await readFile(transcript, "utf8"), "", "the refusal fixture has no item_completed row");
  const beforeProbe = [...(await core.loadState(repo)).actions.values()];
  assert.equal(beforeProbe.length, 1);
  assert.equal(beforeProbe[0].status, "pending", "there was no PostToolUse or completion");

  const trigger = await codex(root, "PreToolUse", bashInput(session, transcript, `trigger-${name}`, "npm publish"));
  assert.equal(decision(trigger), "deny", "the fixture policy denies the trigger action after probing");
  const action = [...(await core.loadState(repo)).actions.values()][0];
  assert.equal(action.status, "failed", "the local bare remote proves the feature ref is absent");
  assert.equal(action.history.at(-1).type, "action.reconciled");
  assert.equal(action.history.at(-1).method, "probe");
  return { root, base, repo, session, toolUseId, transcript, actionId: action.id };
}

test("Codex refusal without PostToolUse or completion permits a push retry and an isolated side effect", async (t) => {
  const firstFixture = await fixtureRepo(t);
  await writePolicy(firstFixture.root, { actions: { rules: { "git-push": "allow" } } });
  const transcript = path.join(firstFixture.base, "refused-push.jsonl");
  await writeTranscript(transcript, []);
  const session = "session-refused-push";
  const firstId = "refused-push";
  const first = await codex(firstFixture.root, "PreToolUse", bashInput(session, transcript, firstId, push));
  assert.equal(first.output, null);
  assert.equal(await readFile(transcript, "utf8"), "");

  const retry = await codex(firstFixture.root, "PreToolUse", bashInput(session, transcript, "retry-push", push));
  assert.equal(retry.output, null, "the same push is allowed after the absent-ref probe records failure");
  let actions = [...(await core.loadState(firstFixture.repo)).actions.values()];
  assert.deepEqual(actions.map((action) => action.status), ["failed", "pending"]);

  // A separate fixture prevents the retry's new pending action from affecting
  // the independent side-effect assertion.
  const otherFixture = await fixtureRepo(t);
  await writePolicy(otherFixture.root, { actions: { rules: { "git-push": "allow", "package-publish": "allow" } } });
  const otherTranscript = path.join(otherFixture.base, "refused-before-publish.jsonl");
  await writeTranscript(otherTranscript, []);
  const otherSession = "session-independent-effect";
  const refused = await codex(otherFixture.root, "PreToolUse", bashInput(otherSession, otherTranscript, "refused-before-publish", push));
  assert.equal(refused.output, null);
  const publish = await codex(otherFixture.root, "PreToolUse", bashInput(otherSession, otherTranscript, "publish-after-refusal", "npm publish"));
  assert.equal(publish.output, null, "a refused push does not block an unrelated side effect");
  actions = [...(await core.loadState(otherFixture.repo)).actions.values()];
  assert.deepEqual(actions.map((action) => [action.kind, action.status]), [["git-push", "failed"], ["package-publish", "pending"]]);
});

test("matching late exit 0 upgrades a probe failure and denies the repeated push, with or without its sidecar", async (t) => {
  for (const removeSidecar of [false, true]) {
    const name = removeSidecar ? "late-success-no-sidecar" : "late-success-with-sidecar";
    const fixture = await probedFailedPush(t, name);
    if (removeSidecar) {
      const pendingDir = path.join(fixture.repo.stateDir, "pending");
      const files = await readdir(pendingDir);
      assert.equal(files.length, 1);
      await rm(path.join(pendingDir, files[0]));
    }
    await writeTranscript(fixture.transcript, [completionRow(fixture.toolUseId, 0)]);

    const retry = await codex(fixture.root, "PreToolUse", bashInput(fixture.session, fixture.transcript, `after-success-${name}`, push));
    assert.equal(decision(retry), "deny");
    assert.match(retry.output.hookSpecificOutput.permissionDecisionReason, /already succeeded/);
    const action = (await core.loadState(fixture.repo)).actions.get(fixture.actionId);
    assert.equal(action.status, "success");
    assert.equal(action.history.at(-1).type, "action.ended");
    assert.equal(action.history.at(-1).exitCode, 0);
    assert.deepEqual(
      [action.history.at(-1).host, action.history.at(-1).session, action.history.at(-1).toolUseId],
      ["codex", fixture.session, fixture.toolUseId],
    );
  }
});

test("a late exit 1 is consumed but leaves the probe failure unchanged", async (t) => {
  const fixture = await probedFailedPush(t, "late-exit-one");
  await writeTranscript(fixture.transcript, [completionRow(fixture.toolUseId, 1)]);
  await codex(fixture.root, "SessionStart", {
    session_id: fixture.session,
    transcript_path: fixture.transcript,
    source: "resume",
  });

  const state = await core.loadState(fixture.repo);
  const action = state.actions.get(fixture.actionId);
  assert.equal(action.status, "failed");
  assert.equal(action.history.length, 1);
  assert.equal(action.history.at(-1).type, "action.reconciled");
  assert.equal(action.history.at(-1).outcome, "failed");
  const consumed = (await core.readLedger(fixture.repo)).some((entry) => entry.type === "tool.consumed"
    && entry.data.host === "codex" && entry.data.session === fixture.session && entry.data.toolUseId === fixture.toolUseId);
  assert.equal(consumed, true, "the late nonzero completion is consumed once");
  assert.deepEqual(await readdir(path.join(fixture.repo.stateDir, "pending")), []);
});

test("a completion cannot cross host, session, or tool identity", async (t) => {
  const fixture = await probedFailedPush(t, "identity-boundary");
  await writeTranscript(fixture.transcript, [completionRow(fixture.toolUseId, 0)]);

  await handleClaudeCodeHook({
    cwd: fixture.root,
    hook_event_name: "SessionStart",
    session_id: fixture.session,
    transcript_path: fixture.transcript,
    source: "resume",
  });
  assert.equal((await core.loadState(fixture.repo)).actions.get(fixture.actionId).status, "failed", "another host cannot settle the Codex call");

  await codex(fixture.root, "SessionStart", {
    session_id: `${fixture.session}-other`,
    transcript_path: fixture.transcript,
    source: "resume",
  });
  assert.equal((await core.loadState(fixture.repo)).actions.get(fixture.actionId).status, "failed", "another session cannot settle the call");

  await writeTranscript(fixture.transcript, [completionRow("different-tool-id", 0)]);
  await codex(fixture.root, "SessionStart", {
    session_id: fixture.session,
    transcript_path: fixture.transcript,
    source: "resume",
  });
  assert.equal((await core.loadState(fixture.repo)).actions.get(fixture.actionId).status, "failed", "another tool id cannot settle the call");
});

test("late exit 0 cannot overwrite a manual failure", async (t) => {
  const { root, base, repo } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
  const session = "session-manual-failure";
  const toolUseId = "push-manual-failure";
  const transcript = path.join(base, "manual-failure.jsonl");
  await writeTranscript(transcript, []);
  assert.equal((await codex(root, "PreToolUse", bashInput(session, transcript, toolUseId, push))).output, null);
  const action = [...(await core.loadState(repo)).actions.values()][0];
  await core.reconcileManually(repo, action.id, "failed", "verified the local bare remote has no target ref");

  await writeTranscript(transcript, [completionRow(toolUseId, 0)]);
  await codex(root, "SessionStart", { session_id: session, transcript_path: transcript, source: "resume" });
  const final = (await core.loadState(repo)).actions.get(action.id);
  assert.equal(final.status, "failed");
  assert.equal(final.history.at(-1).type, "action.reconciled");
  assert.equal(final.history.at(-1).method, "manual");
});

test("a stale positive probe cannot overwrite a newer manual failure", async (t) => {
  const { root, base, repo } = await fixtureRepo(t);
  await writePolicy(root, { actions: { rules: { "git-push": "allow" } } });
  const session = "session-stale-probe";
  const toolUseId = "push-stale-probe";
  const transcript = path.join(base, "stale-probe.jsonl");
  await writeTranscript(transcript, []);
  assert.equal((await codex(root, "PreToolUse", bashInput(session, transcript, toolUseId, push))).output, null);
  const action = [...(await core.loadState(repo)).actions.values()][0];
  const { sha, ref } = action.expect.refs[0];

  let probeStartedResolve;
  const probeStarted = new Promise((resolve) => { probeStartedResolve = resolve; });
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  let reconciliation;
  try {
    reconciliation = core.reconcileOpen(repo, {
      exec: async () => {
        probeStartedResolve();
        await probeGate;
        return { code: 0, stdout: `${sha}\t${ref}\n`, stderr: "", timedOut: false };
      },
    });
    await Promise.race([
      probeStarted,
      reconciliation.then(() => { throw new Error("the pending push probe did not call exec"); }),
    ]);
    await core.reconcileManually(repo, action.id, "failed", "verified the local bare remote has no target ref");
  } finally {
    releaseProbe();
    if (reconciliation) await reconciliation.catch(() => {});
  }

  const [result] = await reconciliation;
  assert.equal(result.outcome, "failed");
  assert.match(result.detail, /stale probe result ignored/);
  const final = (await core.loadState(repo)).actions.get(action.id);
  assert.equal(final.status, "failed");
  assert.equal(final.history.at(-1).method, "manual");
  const retry = await codex(root, "PreToolUse", bashInput(session, transcript, "push-after-stale-probe", push));
  assert.equal(retry.output, null, "the stale positive probe did not block a legitimate retry");
});

test("an unknown custom action still blocks later side effects", async (t) => {
  const { root, base, repo } = await fixtureRepo(t);
  await writePolicy(root, {
    actions: {
      custom: [{ kind: "deploy", argv: [["./deploy.sh"]] }],
      rules: { deploy: "allow", "package-publish": "allow" },
    },
  });
  const session = "session-unknown-custom";
  const transcript = path.join(base, "unknown-custom.jsonl");
  await writeTranscript(transcript, []);
  const deploy = await codex(root, "PreToolUse", bashInput(session, transcript, "deploy-tool", "./deploy.sh prod"));
  assert.equal(deploy.output, null);

  const publish = await codex(root, "PreToolUse", bashInput(session, transcript, "publish-after-custom", "npm publish"));
  assert.equal(decision(publish), "deny");
  assert.match(publish.output.hookSpecificOutput.permissionDecisionReason, /unknown result/);
  const actions = [...(await core.loadState(repo)).actions.values()];
  assert.deepEqual(actions.map((action) => [action.kind, action.status]), [["deploy", "unknown"]]);
});

test("a sidecar-free late exit 1 for a probe failure is consumed once across transcript replays", async (t) => {
  const fixture = await probedFailedPush(t, "late-exit-one-no-sidecar");
  const pendingDir = path.join(fixture.repo.stateDir, "pending");
  const files = await readdir(pendingDir);
  assert.equal(files.length, 1);
  await rm(path.join(pendingDir, files[0]));
  await writeTranscript(fixture.transcript, [completionRow(fixture.toolUseId, 1)]);

  const resume = { session_id: fixture.session, transcript_path: fixture.transcript, source: "resume" };
  await codex(fixture.root, "SessionStart", resume);
  let action = (await core.loadState(fixture.repo)).actions.get(fixture.actionId);
  assert.equal(action.status, "failed");
  assert.equal(action.history.length, 1);
  assert.equal(action.history.at(-1).type, "action.reconciled");
  assert.equal(action.history.at(-1).outcome, "failed");
  const countConsumed = async () => (await core.readLedger(fixture.repo)).filter((entry) => entry.type === "tool.consumed"
    && entry.data.host === "codex" && entry.data.session === fixture.session && entry.data.toolUseId === fixture.toolUseId).length;
  assert.equal(await countConsumed(), 1);
  assert.deepEqual(await readdir(pendingDir), []);

  // The unchanged transcript still contains exit 1; the durable consumed marker
  // prevents a later hook from processing the missing-sidecar call again.
  await codex(fixture.root, "SessionStart", resume);
  action = (await core.loadState(fixture.repo)).actions.get(fixture.actionId);
  assert.equal(action.status, "failed");
  assert.equal(action.history.length, 1);
  assert.equal(await countConsumed(), 1);
  assert.deepEqual(await readdir(pendingDir), []);
});

test("missing or malformed completion after sidecar loss stays failed until matching exit 0 arrives", async (t) => {
  const invalidTranscripts = [
    {
      name: "missing-exit-code",
      rows: (toolUseId) => [JSON.stringify({
        type: "event_msg",
        payload: { type: "item_completed", item: { type: "CommandExecution", id: toolUseId, status: "completed" } },
      })],
    },
    { name: "malformed-row", rows: () => ["{not-json}"] },
  ];

  for (const scenario of invalidTranscripts) {
    const fixture = await probedFailedPush(t, `invalid-late-completion-${scenario.name}`);
    const pendingDir = path.join(fixture.repo.stateDir, "pending");
    const files = await readdir(pendingDir);
    assert.equal(files.length, 1);
    await rm(path.join(pendingDir, files[0]));
    await writeTranscript(fixture.transcript, scenario.rows(fixture.toolUseId));

    const resume = { session_id: fixture.session, transcript_path: fixture.transcript, source: "resume" };
    await codex(fixture.root, "SessionStart", resume);
    let action = (await core.loadState(fixture.repo)).actions.get(fixture.actionId);
    assert.equal(action.status, "failed", scenario.name);
    assert.equal(action.history.length, 1, scenario.name);
    let consumed = (await core.readLedger(fixture.repo)).filter((entry) => entry.type === "tool.consumed"
      && entry.data.host === "codex" && entry.data.session === fixture.session && entry.data.toolUseId === fixture.toolUseId);
    assert.equal(consumed.length, 0, scenario.name);
    assert.deepEqual(await readdir(pendingDir), [], scenario.name);

    await writeTranscript(fixture.transcript, [completionRow(fixture.toolUseId, 0)]);
    await codex(fixture.root, "SessionStart", resume);
    action = (await core.loadState(fixture.repo)).actions.get(fixture.actionId);
    assert.equal(action.status, "success", scenario.name);
    assert.equal(action.history.at(-1).type, "action.ended", scenario.name);
    assert.equal(action.history.at(-1).exitCode, 0, scenario.name);
    consumed = (await core.readLedger(fixture.repo)).filter((entry) => entry.type === "tool.consumed"
      && entry.data.host === "codex" && entry.data.session === fixture.session && entry.data.toolUseId === fixture.toolUseId);
    assert.equal(consumed.length, 1, scenario.name);
  }
});
