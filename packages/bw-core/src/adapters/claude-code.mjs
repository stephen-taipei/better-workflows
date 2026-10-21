import { readFile } from "node:fs/promises";
import { markNotRun } from "../actions.mjs";
import { classifyCommand } from "../classify.mjs";
import { defaultPolicy } from "../policy.mjs";
import { openRepo } from "../repo.mjs";
import { loadState, openActions } from "../state.mjs";
import { postBash, preBash, protectedPath, sessionStart, stopSession } from "./shared.mjs";

const HOST = "claude-code";
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

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

function normalizedEvent(input, finalExitCode = null, transcriptPath = input?.transcript_path ?? null) {
  return {
    host: HOST,
    sessionId: input?.session_id ?? null,
    turnId: input?.turn_id ?? null,
    toolUseId: input?.tool_use_id ?? null,
    toolName: input?.tool_name ?? null,
    command: input?.tool_name === "Bash" ? String(input?.tool_input?.command ?? "") : null,
    cwd: input?.cwd ?? null,
    finalExitCode,
    transcriptPath,
  };
}

function preOutput(result) {
  return result ? preDecision(result.decision, result.reason) : null;
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

async function settleRefused(event, repo, state) {
  const pending = openActions(state).filter((a) => a.status === "pending" && a.host === HOST && a.toolUseId && a.toolUseId !== event.toolUseId);
  if (!pending.length) return false;
  const refused = await refusedInTranscript(event.transcriptPath, new Set(pending.map((a) => a.toolUseId)));
  for (const action of pending) {
    const reason = refused.get(action.toolUseId);
    if (reason) await markNotRun(repo, action.id, `refused before running: ${reason}`);
  }
  return refused.size > 0;
}

async function preToolUse(input, repo) {
  const event = normalizedEvent(input);
  if (FILE_TOOLS.has(event.toolName)) {
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    return preOutput(await protectedPath(event, repo, target));
  }
  if (event.toolName !== "Bash") return null;
  return preOutput(await preBash(event, repo, {
    beforeEvaluate: (state) => settleRefused(event, repo, state),
  }));
}

function exitCodeFrom(input) {
  if (input.hook_event_name === "PostToolUse") return input.tool_response?.interrupted ? null : 0;
  if (input.is_interrupt) return null;
  const match = /^Exit code (\d+)/.exec(String(input.error ?? ""));
  return match ? Number(match[1]) : null;
}

async function postToolUse(input, repo) {
  const event = normalizedEvent(input, exitCodeFrom(input));
  await postBash(event, repo, { detail: input.error ?? "interrupted" });
  return null;
}

async function sessionStarted(input, repo) {
  const event = normalizedEvent(input);
  const context = await sessionStart(event, repo, {
    source: input.source ?? null,
    afterRecord: (state) => settleRefused(event, repo, state),
  });
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
}

function stopOutput(result) {
  if (!result) return null;
  return result.type === "message"
    ? { systemMessage: result.message }
    : { decision: "block", reason: result.reason };
}

async function stop(input, repo) {
  const event = normalizedEvent(input);
  return stopOutput(await stopSession(event, repo, {
    stopHookActive: input.stop_hook_active,
    beforeCompletion: (state) => settleRefused(event, repo, state),
  }));
}

// A subagent stopping is not the session finishing. SubagentStop carries the
// parent's session_id, so judging completion here would send a read-only
// subagent back for the parent's edits; the parent's Stop is the gate. What
// the person refused during the subagent is in the subagent's own transcript.
async function subagentStop(input, repo) {
  const event = normalizedEvent(input, null, input.agent_transcript_path ?? input.transcript_path ?? null);
  await settleRefused(event, repo, await loadState(repo));
  return null;
}

const HANDLERS = { PreToolUse: preToolUse, PostToolUse: postToolUse, PostToolUseFailure: postToolUse, SessionStart: sessionStarted, Stop: stop, SubagentStop: subagentStop };

// Returns { output, exitCode }. Never throws: a hook that crashes would
// leave the host guessing, so internal errors become explicit outcomes.
export async function handleClaudeCodeHook(input) {
  const handler = HANDLERS[input?.hook_event_name];
  if (!handler) return { output: null, exitCode: 0 };
  try {
    const repo = await openRepo(input.cwd ?? process.cwd());
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
