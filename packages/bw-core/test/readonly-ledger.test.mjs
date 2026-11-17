import test from "node:test";
import assert from "node:assert/strict";
import { handleClaudeCodeHook } from "../src/adapters/claude-code.mjs";
import { fixtureRepo, writePolicy } from "./helpers.mjs";

// 2026-11-17, stephen.taipei ledger seq 431–433: an agent reading the ledger
// with ls, find, cat, tail and cut was refused as if it were changing it.

let next = 0;
const pre = (root, command) => handleClaudeCodeHook({
  hook_event_name: "PreToolUse", cwd: root, session_id: "s1",
  tool_name: "Bash", tool_input: { command: command.replaceAll("ROOT", root) }, tool_use_id: `toolu_r_${next += 1}`,
});
const decision = (result) => result.output?.hookSpecificOutput?.permissionDecision ?? "defer";

test("reading the ledger with the commands from the 2026-11-17 session is allowed", async (t) => {
  const { root } = await fixtureRepo(t);
  await writePolicy(root, {});
  for (const command of [
    "ls -la .git/better-workflows/ && find .git/better-workflows -type f -newer .git/HEAD -o -type f -mmin -600 | head -30",
    "cd ROOT/.git/better-workflows && cat ledger.head; echo; wc -l ledger.jsonl; tail -n 3 ledger.jsonl; ls -laR pending",
    "tail -n 3 ROOT/.git/better-workflows/ledger.jsonl | cut -c1-1500",
    "cat .git/better-workflows/ledger.jsonl 2>/dev/null",
    "grep -c seq .git/better-workflows/ledger.jsonl 2>&1 | head -1",
    "git log --oneline -- .better-workflows/policy.json",
  ]) {
    assert.equal(decision(await pre(root, command)), "defer", command);
  }
});

for (const command of [
  "cat /dev/null > .git/better-workflows/ledger.jsonl",
  "ls > .better-workflows/policy.json",
  "echo '{}' >> .git/better-workflows/ledger.jsonl",
  "cat .git/better-workflows/ledger.jsonl > /dev/null.txt",
  "git diff --output=.better-workflows/policy.json",
  "rg --pre ./x.sh foo .better-workflows",
  "find .git/better-workflows -name '*.json' -delete",
  "find .git/better-workflows -exec rm {} ;",
  "find .better-workflows -fprint .better-workflows/policy.json",
  "less -o .git/better-workflows/ledger.jsonl notes.txt",
  "file -C -m .better-workflows/policy.json",
  "cat $(rm .better-workflows/policy.json)",
  "cat `rm .better-workflows/policy.json`",
  "LESSOPEN='|./x.sh %s' less .better-workflows/policy.json",
  "env LESSOPEN=x less .better-workflows/policy.json",
  "ls; X=1 cat .better-workflows/policy.json",
  "cd .better-workflows && echo x > policy.json",
  "find .git/better-workflows | xargs rm",
]) {
  test(`a reader that writes, runs a program or hides a command is still refused: ${command}`, async (t) => {
    const { root } = await fixtureRepo(t);
    await writePolicy(root, {});
    const result = await pre(root, command);
    assert.equal(decision(result), "deny");
    assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /may read but not change/);
  });
}
