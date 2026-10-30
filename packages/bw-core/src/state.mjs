import { entryVersion, LEDGER_VERSION, readLedger } from "./ledger.mjs";

const sessionKey = (host, session) => JSON.stringify([host ?? null, session ?? null]);

export const toolCallKey = (host, session, toolUseId) => JSON.stringify([host ?? null, session ?? null, toolUseId ?? null]);

const OPEN = new Set(["pending", "unknown"]);

// An automatic probe cannot prove that a call with no final result stopped.
// Keep old provisional unknown records recoverable after upgrading too.
export function awaitingCompletion(action) {
  const last = action.history.at(-1);
  return action.status === "pending" || (action.status === "unknown" && last?.type === "action.ended"
    && (last.awaitingCompletion === true || (last.exitCode === null && last.detail === "no result was recorded")));
}

// A probe that finds nothing settles the action as failed, so the call can
// be retried. A later exact exit 0 for that call may still raise it to
// success: that only blocks more, never less.
export function lateSuccessAllowed(action) {
  const last = action.history.at(-1);
  return action.status === "failed" && last?.type === "action.reconciled" && last.method === "probe";
}

// Folds the ledger into current evidence and action state.
export function reduceEntries(entries) {
  const evidence = [];
  const actions = new Map();
  const sessions = new Map();
  const hostSessions = new Map();
  const consumedTools = new Set();
  let newerLedger = null;
  for (const entry of entries) {
    const version = entryVersion(entry);
    if (version > LEDGER_VERSION) {
      newerLedger = Math.max(newerLedger ?? 0, version);
      continue; // Future data shapes are unknown, including known event names.
    }
    const { type, data, at, seq } = entry;
    if (type === "evidence.recorded") evidence.push({ ...data, at, seq });
    else if (type === "tool.consumed") consumedTools.add(toolCallKey(data.host, data.session, data.toolUseId));
    else if (type === "session.started") {
      const key = sessionKey(data.host, data.session);
      if (!hostSessions.has(key)) hostSessions.set(key, { ...data, at, seq, blocks: 0 });
      if (!sessions.has(data.session)) sessions.set(data.session, hostSessions.get(key));
    } else if (type === "completion.blocked") {
      const session = data.host === undefined ? sessions.get(data.session) : hostSessions.get(sessionKey(data.host, data.session));
      if (session) session.blocks += 1;
    } else if (type === "action.begun") actions.set(data.id, { ...data, status: "pending", at, seq, history: [] });
    else if (type === "action.ended" || type === "action.reconciled") {
      const action = actions.get(data.id);
      if (!action) continue;
      if (type === "action.ended" && !awaitingCompletion(action) && !(data.outcome === "success" && lateSuccessAllowed(action))) continue;
      action.status = data.outcome;
      action.history.push({ type, ...data, at, seq });
    }
  }
  return { evidence, actions, sessions, hostSessions, consumedTools, newerLedger, seq: entries.at(-1)?.seq ?? 0 };
}

export async function loadState(repo) {
  return reduceEntries(await readLedger(repo));
}

export function openActions(state) {
  return [...state.actions.values()].filter((action) => OPEN.has(action.status));
}

export function latestSession(state) {
  return [...state.sessions.values()].at(-1) ?? null;
}

// Keep sessions.get(id) available to existing callers; adapters use the host
// tuple so one host's unchanged session cannot bypass another host's Stop.
export function sessionFor(state, session, host) {
  if (session === null || session === undefined) return null;
  return state.hostSessions?.get(sessionKey(host, session)) ?? null;
}
