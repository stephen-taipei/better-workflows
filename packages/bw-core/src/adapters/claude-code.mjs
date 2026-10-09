import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { beginActions, endActions, evaluateCommand, markNotRun } from "../actions.mjs";
import { completionStatus, describeEvidence, recordEvidence } from "../evidence.mjs";
import { appendEvent } from "../ledger.mjs";
import { defaultPolicy, loadPolicy } from "../policy.mjs";
import { classifyCommand } from "../classify.mjs";
import { reconcileOpen } from "../reconcile.mjs";
import { headCommit, openRepo, worktreeTree } from "../repo.mjs";
import { loadState, openActions } from "../state.mjs";
import { splitCommand } from "../command.mjs";

const HOST = "claude-code";
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_ONLY = new Set(["cat", "head", "tail", "less", "more", "jq", "grep", "rg", "ls", "wc", "file", "stat", "diff"]);
const PROTECTED_TEXT = [".better-workflows/", ".better-workflows\\", "/.git/better-workflows", ".git/better-workflows"];

// Tool results Claude Code writes when a call was refused before it ran.
// Anything else (including an interrupt) may have run, so it stays open.
const NOT_RUN = [
  /^Better Workflows: /,
  /doesn't want to proceed with this tool use\. The tool use was rejected/,
  /requested permissions to use .*, but you haven't granted it yet/,
  /^Permission to use .* has been denied/,
];

const preDecision = (decision, reason) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: `Better Workflows: ${reason}` },
});

function pendingFile(repo, toolUseId) {
  return path.join(repo.stateDir, "pending", `${String(toolUseId).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

// Resolves symlinks in the longest existing prefix, so a path reached
// through a link (macOS /var -> /private/var) compares like the real one.
async function physicalPath(target) {
  let existing = target;
  const rest = [];
  for (;;) {
    try {
      return path.join(await realpath(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// The policy, the ledger and manual reconciliation belong to the person.
// The agent may read them but not change them.
function protectedBash(command) {
  const { commands } = splitCommand(command);
  const touches = PROTECTED_TEXT.some((text) => command.includes(text));
  if (touches && commands.some((argv) => !READ_ONLY.has(argv[0]) && !(argv[0] === "git" && ["diff", "log", "show", "status"].includes(argv[1])))) {
    return "the agent may read but not change .better-workflows/ or the Better Workflows ledger";
  }
  for (const argv of commands) {
    const bw = argv[0] === "bw" || argv.some((arg) => arg.endsWith("/bin/bw.mjs"));
    if (!bw) continue;
    if (argv.includes("init")) return "only a person creates the policy file";
    const i = argv.indexOf("reconcile");
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) return "only a person settles an action by hand; run `bw reconcile` without an id to let the read-only checks settle it";
  }
  return null;
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  return "";
}

// An action begun at PreToolUse gets no PostToolUse when the call is refused
// at the permission prompt. The transcript then holds a refusal as the
// tool's result, which proves the command never ran.
async function refusedInTranscript(transcriptPath, toolUseIds) {
  const refused = new Map();
  if (!transcriptPath || !toolUseIds.size) return refused;
  let text;
  try {
    text = await readFile(transcriptPath, "utf8");
  } catch {
    return refused;
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"tool_result"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "tool_result" || !toolUseIds.has(part.tool_use_id) || part.is_error !== true) continue;
      const result = resultText(part.content);
      if (NOT_RUN.some((pattern) => pattern.test(result))) refused.set(part.tool_use_id, result.split("\n")[0].slice(0, 200));
    }
  }
  return refused;
}

async function settleRefused(input, repo, state) {
  const pending = openActions(state).filter((a) => a.status === "pending" && a.host === HOST && a.toolUseId && a.toolUseId !== input.tool_use_id);
  if (!pending.length) return false;
  const refused = await refusedInTranscript(input.transcript_path, new Set(pending.map((a) => a.toolUseId)));
  for (const action of pending) {
    const reason = refused.get(action.toolUseId);
    if (reason) await markNotRun(repo, action.id, `refused before running: ${reason}`);
  }
  return refused.size > 0;
}

async function preToolUse(input, repo) {
  if (FILE_TOOLS.has(input.tool_name)) {
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (!target) return null;
    const [absolute, root, gitDir] = await Promise.all([
      physicalPath(path.resolve(input.cwd ?? repo.root, target)), physicalPath(repo.root), physicalPath(repo.gitDir),
    ]);
    if (isInside(absolute, path.join(root, ".better-workflows")) || isInside(absolute, gitDir)) {
      return preDecision("deny", `${target} is protected; the policy and ledger are changed by a person, not the agent`);
    }
    return null;
  }
  if (input.tool_name !== "Bash") return null;
  const command = String(input.tool_input?.command ?? "");
  const protectedReason = protectedBash(command);
  if (protectedReason) return preDecision("deny", protectedReason);

  const policyInfo = await loadPolicy(repo);
  let state = await loadState(repo);
  if (await settleRefused(input, repo, state)) state = await loadState(repo);
  const head = await headCommit(repo);
  let evaluation = evaluateCommand({ command, policyInfo, state, head });
  if ((evaluation.actions.length || evaluation.opaque) && openActions(state).length) {
    await reconcileOpen(repo);
    state = await loadState(repo);
    evaluation = evaluateCommand({ command, policyInfo, state, head });
  }
  if (evaluation.decision === "deny") return preDecision("deny", evaluation.reasons.join("; "));

  const tree = evaluation.actions.length || evaluation.evidence.length ? await worktreeTree(repo) : null;
  if (evaluation.actions.length) {
    await beginActions(repo, evaluation, { command, tree, policyDigest: policyInfo.digest, host: HOST, toolUseId: input.tool_use_id ?? null });
  }
  if (evaluation.evidence.length && input.tool_use_id) {
    const file = pendingFile(repo, input.tool_use_id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ kinds: [...new Set(evaluation.evidence.map((e) => e.kind))], command, treeBefore: tree }), { mode: 0o600 });
  }
  // Core only narrows what the host already allows; an allow defers to the
  // host's own permission rules instead of granting anything.
  return evaluation.decision === "ask" ? preDecision("ask", evaluation.reasons.join("; ")) : null;
}

function exitCodeFrom(input) {
  if (input.hook_event_name === "PostToolUse") return input.tool_response?.interrupted ? null : 0;
  if (input.is_interrupt) return null;
  const match = /^Exit code (\d+)/.exec(String(input.error ?? ""));
  return match ? Number(match[1]) : null;
}

async function postToolUse(input, repo) {
  if (input.tool_name !== "Bash" || !input.tool_use_id) return null;
  const exitCode = exitCodeFrom(input);
  const state = await loadState(repo);
  const ids = [...state.actions.values()].filter((a) => a.toolUseId === input.tool_use_id && a.status === "pending").map((a) => a.id);
  if (ids.length) await endActions(repo, ids, { exitCode, detail: exitCode === 0 ? null : String(input.error ?? "interrupted").slice(0, 500) });

  const file = pendingFile(repo, input.tool_use_id);
  let pending;
  try {
    pending = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  await rm(file, { force: true });
  const [treeAfter, head] = await Promise.all([worktreeTree(repo), headCommit(repo)]);
  for (const kind of pending.kinds) {
    await recordEvidence(repo, { kind, command: pending.command, exitCode, treeBefore: pending.treeBefore, treeAfter, head, host: HOST });
  }
  return null;
}

async function sessionStart(input, repo) {
  const [tree, head, policyInfo] = await Promise.all([worktreeTree(repo), headCommit(repo), loadPolicy(repo)]);
  await appendEvent(repo, "session.started", { session: input.session_id ?? null, source: input.source ?? null, tree, head, host: HOST });
  let state = await loadState(repo);
  if (await settleRefused(input, repo, state)) state = await loadState(repo);
  const lines = ["Better Workflows is active in this repository."];
  if (policyInfo.error) lines.push(`Policy file is invalid, so every side effect will be denied: ${policyInfo.error}`);
  if (policyInfo.policy.completion.require.length) {
    lines.push(`Before you report work as complete, these must pass on the final state of the files: ${policyInfo.policy.completion.require.join(", ")}. A result from before your last edit does not count.`);
  }
  const open = openActions(state);
  if (open.length) {
    lines.push("Earlier side effects have no confirmed result. Further side effects stay blocked until they are settled:");
    for (const action of open) lines.push(`- ${action.id} ${action.kind}: ${action.command}`);
  }
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } };
}

async function stop(input, repo) {
  await settleRefused(input, repo, await loadState(repo));
  const [policyInfo, state, tree] = await Promise.all([loadPolicy(repo), loadState(repo), worktreeTree(repo)]);
  if (!policyInfo.policy.completion.require.length) return null;
  const started = state.sessions.get(input.session_id ?? null);
  if (started && started.tree === tree) return null; // nothing changed in this session
  const completion = completionStatus(state, policyInfo.policy, tree);
  if (completion.ok) return null;
  const missing = completion.results.filter((r) => r.status !== "fresh").map(describeEvidence);
  if (input.stop_hook_active) {
    return { systemMessage: `Better Workflows: the agent stopped without fresh evidence. ${missing.join("; ")}.` };
  }
  return {
    decision: "block",
    reason: `Better Workflows: the files changed and the required evidence does not match them yet. ${missing.join("; ")}. Run the checks on the current files, fix any failure, then finish. If you cannot, say plainly which check is missing or failing.`,
  };
}

const HANDLERS = { PreToolUse: preToolUse, PostToolUse: postToolUse, PostToolUseFailure: postToolUse, SessionStart: sessionStart, Stop: stop, SubagentStop: stop };

// Returns { output, exitCode }. Never throws: a hook that crashes would
// leave the host guessing, so internal errors become explicit outcomes.
export async function handleClaudeCodeHook(input) {
  const handler = HANDLERS[input?.hook_event_name];
  if (!handler) return { output: null, exitCode: 0 };
  let repo;
  try {
    repo = await openRepo(input.cwd ?? process.cwd());
    if (!repo) return { output: null, exitCode: 0 };
    return { output: await handler(input, repo), exitCode: 0 };
  } catch (error) {
    const message = `Better Workflows hook error: ${error.message}`;
    if (input.hook_event_name === "PreToolUse" && input.tool_name === "Bash") {
      const { actions, opaque } = classifyCommand(String(input.tool_input?.command ?? ""), defaultPolicy());
      if (actions.length || opaque) return { output: preDecision("deny", `${message}; side effects are blocked until this is fixed`), exitCode: 0 };
    }
    return { output: { systemMessage: message }, exitCode: 0 };
  }
}
