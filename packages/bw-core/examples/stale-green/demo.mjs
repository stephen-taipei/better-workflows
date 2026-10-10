#!/usr/bin/env node
// Plays two short stories through the real Claude Code hook entrypoint,
// in a throwaway repository, with the same JSON Claude Code sends:
//   1. a test that passed before the last edit does not count as done;
//   2. a side effect whose result was lost is checked before anything else
//      runs: a push that landed is not repeated, and a deploy nobody can
//      read back blocks further side effects until a person settles it.
// Exits 1 if any step does not behave as described.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BW = fileURLToPath(new URL("../../bin/bw.mjs", import.meta.url));
const quiet = process.argv.includes("--quiet");
const base = mkdtempSync(path.join(tmpdir(), "bw-stale-green-"));
const repo = path.join(base, "app");
const remote = path.join(base, "origin.git");
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
delete gitEnv.NODE_TEST_CONTEXT; // the demo's own `node --test` must not report to an outer test runner
let failures = 0;
let toolUse = 0;

const say = (text = "") => { if (!quiet) console.log(text); };
const git = (...args) => execFileSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" }).trim();
const write = (file, text) => writeFileSync(path.join(repo, file), text);

function expect(label, actual, wanted) {
  const ok = actual === wanted;
  if (!ok) failures += 1;
  say(`   ${ok ? "✓" : "✗"} ${label}${ok ? "" : ` (expected ${wanted}, got ${actual})`}`);
}

function hook(event, fields = {}) {
  const input = JSON.stringify({ hook_event_name: event, session_id: "demo", cwd: repo, ...fields });
  const result = spawnSync(process.execPath, [BW, "hook", "claude-code"], { input, encoding: "utf8", env: gitEnv });
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

// What Claude Code does around one Bash call. `exitCode` overrides the real
// result, to stand in for a call whose outcome never came back.
function bash(command, { exitCode } = {}) {
  const tool_use_id = `toolu_demo_${toolUse += 1}`;
  const tool = { tool_name: "Bash", tool_input: { command }, tool_use_id };
  const pre = hook("PreToolUse", tool);
  const decision = pre?.hookSpecificOutput?.permissionDecision ?? "allow";
  if (decision === "deny") return { decision, reason: pre.hookSpecificOutput.permissionDecisionReason };
  const run = spawnSync("bash", ["-c", command], { cwd: repo, env: gitEnv, encoding: "utf8" });
  const code = exitCode ?? run.status;
  if (code === 0) hook("PostToolUse", { ...tool, tool_response: { stdout: run.stdout, stderr: run.stderr, interrupted: false } });
  else hook("PostToolUseFailure", { ...tool, error: `Exit code ${code}\n${run.stderr}`, is_interrupt: false });
  return { decision, code };
}

function stop() {
  const out = hook("Stop", { stop_hook_active: false });
  return out?.decision === "block" ? { blocked: true, reason: out.reason } : { blocked: false };
}

try {
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: gitEnv });
  mkdirSync(path.join(repo, "test"), { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "demo@example.com");
  git("config", "user.name", "Demo");
  write("sum.mjs", "export const sum = (a, b) => a + b;\n");
  write("test/sum.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "../sum.mjs";\ntest("sum", () => assert.equal(sum(2, 3), 5));\n');
  mkdirSync(path.join(repo, ".better-workflows"));
  write("deploy.sh", "#!/bin/sh\necho deployed\n");
  chmodSync(path.join(repo, "deploy.sh"), 0o755);
  write(".better-workflows/policy.json", `${JSON.stringify({
    version: 1,
    completion: { require: ["test"] },
    evidence: { kinds: [{ kind: "test", argv: [["node", "--test"]] }] },
    actions: { rules: { "git-push": "allow", deploy: "allow" }, custom: [{ kind: "deploy", argv: [["./deploy.sh"]] }] },
  }, null, 2)}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("remote", "add", "origin", remote);
  git("push", "-q", "-u", "origin", "main");

  hook("SessionStart", { source: "startup" });
  say("Story 1: an old green test does not finish the task\n");
  say("1. The agent runs the tests. They pass.");
  expect("node --test exits 0", bash("node --test").code, 0);
  say("2. The agent then edits sum.mjs and breaks it, and tries to finish.");
  write("sum.mjs", "export const sum = (a, b) => a - b;\n");
  let end = stop();
  expect("Stop is blocked: the passing run was on an older tree", end.blocked, true);
  say(`   → ${end.reason}`);
  say("3. The agent reruns the tests. They fail, so it still cannot finish.");
  expect("node --test exits 1", bash("node --test").code, 1);
  expect("Stop is blocked: the latest run failed", stop().blocked, true);
  say("4. The agent fixes the code and reruns the tests on the final files.");
  write("sum.mjs", "export const sum = (...n) => n.reduce((a, b) => a + b, 0);\n");
  expect("node --test exits 0", bash("node --test").code, 0);
  expect("Stop is allowed", stop().blocked, false);

  say("\nStory 2: a side effect whose result was lost is not repeated or stacked\n");
  git("commit", "-qam", "sum takes any number of arguments");
  say("1. The agent pushes. The push reaches the remote, but the call times out (exit 124).");
  expect("git push is allowed by the policy", bash("git push origin main", { exitCode: 124 }).decision, "allow");
  say("2. The agent retries the push. Before it runs, the hook reads the remote: the push already landed.");
  const retry = bash("git push origin main");
  expect("the retry is denied instead of pushing twice", retry.decision, "deny");
  say(`   → ${retry.reason}`);
  say("3. The agent deploys. The deploy times out too, and nothing can read back whether it happened.");
  expect("./deploy.sh is allowed by the policy", bash("./deploy.sh", { exitCode: 124 }).decision, "allow");
  say("4. The agent tries to deploy again, then to settle the deploy itself.");
  const again = bash("./deploy.sh");
  expect("the second deploy is denied while the first is unknown", again.decision, "deny");
  say(`   → ${again.reason}`);
  const open = JSON.parse(spawnSync(process.execPath, [BW, "status", "--json"], { cwd: repo, encoding: "utf8" }).stdout).openActions[0];
  const self = bash(`bw reconcile ${open.id} --outcome success --note "looks fine"`);
  expect("the agent cannot settle it by hand", self.decision, "deny");
  say("5. A person checks the deploy and settles it with a note. Side effects can continue.");
  const manual = spawnSync(process.execPath, [BW, "reconcile", open.id, "--outcome", "success", "--note", "checked the deploy log"], { cwd: repo, encoding: "utf8" });
  expect("bw reconcile <id> by a person settles it", manual.status, 0);
  expect("the next side effect goes back to the policy", bash("git push origin main --tags").decision, "allow");

  if (!quiet && !failures) {
    const verify = spawnSync(process.execPath, [BW, "verify"], { cwd: repo, encoding: "utf8" });
    say(`\nEvery step above is in the hash-chained ledger: ${verify.stdout.trim()}`);
  }
  say(failures ? `\n${failures} step(s) did not behave as described.` : "\nAll steps behaved as described.");
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
