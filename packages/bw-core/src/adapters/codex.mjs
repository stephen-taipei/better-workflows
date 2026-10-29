import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { digest, sha256 } from "../canonical.mjs";
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

// One immutable snapshot supplies both exit codes and completion order.
// Contradictory results for one call cannot establish a known outcome.
async function transcriptCompletions(canonicalPath, event, toolUseIds) {
  const results = new Map();
  let bytes;
  try { bytes = await readFile(canonicalPath); } catch { return results; }
  const snapshotId = digest([HOST, event.sessionId, canonicalPath, sha256(bytes)]);
  for (const [position, line] of bytes.toString("utf8").split("\n").entries()) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const item = entry?.payload?.item;
    if (entry?.type !== "event_msg" || entry?.payload?.type !== "item_completed" || item?.type !== "CommandExecution" || !toolUseIds.has(item.id)) continue;
    const exitCode = ["completed", "failed"].includes(item.status) && Number.isInteger(item.exit_code) ? item.exit_code : null;
    if (results.has(item.id)) {
      if (results.get(item.id)?.exitCode !== exitCode) results.set(item.id, null);
    } else results.set(item.id, exitCode === null ? null : { exitCode, completion: { snapshotId, position } });
  }
  return results;
}

async function recoverPending(event, repo) {
  const groups = new Map();
  for (const pending of await pendingBash(event, repo)) {
    const transcriptPath = pending.transcriptPath ?? event.transcriptPath;
    if (typeof transcriptPath !== "string" || !transcriptPath) continue;
    let canonicalPath;
    try { canonicalPath = await realpath(path.resolve(pending.cwd ?? repo.root, transcriptPath)); } catch { continue; }
    if (!groups.has(canonicalPath)) groups.set(canonicalPath, []);
    groups.get(canonicalPath).push(pending);
  }
  for (const [canonicalPath, pendingCalls] of groups) {
    const results = await transcriptCompletions(canonicalPath, event, new Set(pendingCalls.map((p) => p.toolUseId)));
    for (const pending of pendingCalls) {
      const result = results.get(pending.toolUseId);
      if (!result) continue;
      await postBash({
        host: HOST, sessionId: pending.sessionId, turnId: pending.turnId ?? null,
        toolUseId: pending.toolUseId, toolName: "Bash", command: pending.command,
        cwd: pending.cwd ?? repo.root, finalExitCode: result.exitCode, completion: result.completion, transcriptPath: canonicalPath,
      }, repo, { detail: `exit ${result.exitCode}`, requireKnownExitCode: true });
    }
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
      ? { decision: "deny", reasons: ["Codex hooks cannot ask; change the policy and retry", ...evaluation.reasons] }
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
    if (input?.hook_event_name === "Stop") return { output: { decision: "block", reason: message }, exitCode: 0 };
    return { output: input?.hook_event_name === "PreToolUse" ? preDecision(message) : { systemMessage: message }, exitCode: 0 };
  }
}
