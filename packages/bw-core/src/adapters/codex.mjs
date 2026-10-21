import { readFile } from "node:fs/promises";
import { openRepo } from "../repo.mjs";
import { pendingBash, postBash, preBash, protectedPath, sessionStart, stopSession } from "./shared.mjs";

const HOST = "codex";
const validId = (value) => typeof value === "string" && value.length > 0;
const preDecision = (reason) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Better Workflows: ${reason}` },
});

function normalizedEvent(input) {
  return {
    host: HOST, sessionId: input?.session_id ?? null, turnId: input?.turn_id ?? null,
    toolUseId: input?.tool_use_id ?? null, toolName: input?.tool_name ?? null,
    command: typeof input?.tool_input?.command === "string" ? input.tool_input.command : null,
    cwd: input?.cwd ?? null, finalExitCode: null, transcriptPath: input?.transcript_path ?? null,
  };
}

// An empty tool_response and turn_aborted say nothing about execution.
// Only the matching completed CommandExecution supplies a final exit code.
async function transcriptExitCode(transcriptPath, toolUseId) {
  if (!transcriptPath || !toolUseId) return null;
  let text;
  try { text = await readFile(transcriptPath, "utf8"); } catch { return null; }
  for (const line of text.split("\n").reverse()) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const item = entry?.payload?.item;
    if (entry?.type !== "event_msg" || entry?.payload?.type !== "item_completed" || item?.type !== "CommandExecution" || item.id !== toolUseId) continue;
    return ["completed", "failed"].includes(item.status) && Number.isInteger(item.exit_code) ? item.exit_code : null;
  }
  return null;
}

async function recoverPending(event, repo) {
  for (const pending of await pendingBash(event, repo)) {
    const transcriptPath = pending.transcriptPath ?? event.transcriptPath;
    const finalExitCode = await transcriptExitCode(transcriptPath, pending.toolUseId);
    if (!Number.isInteger(finalExitCode)) continue;
    await postBash({
      host: HOST, sessionId: pending.sessionId, turnId: pending.turnId ?? null,
      toolUseId: pending.toolUseId, toolName: "Bash", command: pending.command,
      cwd: pending.cwd ?? repo.root, finalExitCode, transcriptPath,
    }, repo, { detail: `exit ${finalExitCode}`, requireKnownExitCode: true });
  }
}

// Read path headers only. Unknown or missing headers cannot establish which
// files the host would edit, so they are denied rather than interpreted.
function patchPaths(command) {
  if (typeof command !== "string") throw new Error("apply_patch command is missing or unreadable");
  const paths = [];
  for (const line of command.split(/\r?\n/)) {
    if (!line.startsWith("*** ")) continue;
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (match && match[1].trim() && !match[1].includes("\0")) paths.push(match[1].trim());
    else if (!["*** Begin Patch", "*** End Patch", "*** End of File"].includes(line)) throw new Error("apply_patch has an unreadable path header");
  }
  if (!paths.length) throw new Error("apply_patch has no readable path headers");
  return paths;
}

async function preToolUse(event, repo) {
  if (event.toolName === "apply_patch") {
    for (const target of patchPaths(event.command)) {
      const result = await protectedPath(event, repo, target);
      if (result) return preDecision(result.reason);
    }
    return null;
  }
  if (event.toolName !== "Bash") return null;
  if (event.command === null || !validId(event.sessionId) || !validId(event.toolUseId)) {
    throw new Error("Bash requires a readable command, session_id and tool_use_id");
  }
  const result = await preBash(event, repo, {
    mapEvaluation: (evaluation) => evaluation.decision === "ask"
      ? { decision: "deny", reasons: ["Codex 不支援 ask；請人調整 policy 後重試", ...evaluation.reasons] }
      : null,
  });
  return result ? preDecision(result.reason) : null;
}

export async function handleCodexHook(input) {
  try {
    const event = normalizedEvent(input);
    const repo = await openRepo(event.cwd ?? process.cwd());
    if (!repo) return { output: null, exitCode: 0 };
    // Recovery precedes every dispatch, including Stop, file edits and events
    // this adapter does not otherwise handle. Turn ids are never match keys.
    if (validId(event.sessionId)) await recoverPending(event, repo);
    let output = null;
    switch (input?.hook_event_name) {
      case "PreToolUse": output = await preToolUse(event, repo); break;
      case "PostToolUse": {
        if (!validId(event.sessionId) || !validId(event.toolUseId)) break;
        event.finalExitCode = await transcriptExitCode(event.transcriptPath, event.toolUseId);
        if (Number.isInteger(event.finalExitCode)) await postBash(event, repo, { detail: `exit ${event.finalExitCode}`, requireKnownExitCode: true });
        break;
      }
      case "SessionStart": {
        if (!validId(event.sessionId)) throw new Error("SessionStart requires session_id");
        const context = await sessionStart(event, repo, { source: input.source ?? null });
        output = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
        break;
      }
      case "Stop": {
        const result = await stopSession(event, repo, { stopHookActive: input.stop_hook_active });
        if (result) output = result.type === "message" ? { systemMessage: result.message } : { decision: "block", reason: result.reason };
        break;
      }
    }
    return { output, exitCode: 0 };
  } catch (error) {
    const message = `Better Workflows hook error: ${error.message}`;
    return { output: input?.hook_event_name === "PreToolUse" ? preDecision(message) : { systemMessage: message }, exitCode: 0 };
  }
}
