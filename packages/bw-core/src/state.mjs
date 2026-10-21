import { readLedger } from "./ledger.mjs";

const sessionKey = (host, session) => JSON.stringify([host ?? null, session ?? null]);

export const toolCallKey = (host, session, toolUseId) => JSON.stringify([host ?? null, session ?? null, toolUseId ?? null]);

const OPEN = new Set(["pending", "unknown"]);

// Folds the ledger into current evidence and action state.
export function reduceEntries(entries) {
  const evidence = [];
  const actions = new Map();
  const sessions = new Map();
  const hostSessions = new Map();
  const consumedTools = new Set();
  for (const { type, data, at, seq } of entries) {
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
      if (type === "action.ended" && action.status !== "pending") continue;
      action.status = data.outcome;
      action.history.push({ type, ...data, at, seq });
    }
  }
  return { evidence, actions, sessions, hostSessions, consumedTools };
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
