import { readLedger } from "./ledger.mjs";

const OPEN = new Set(["pending", "unknown"]);

// Folds the ledger into current evidence and action state.
export function reduceEntries(entries) {
  const evidence = [];
  const actions = new Map();
  const sessions = new Map();
  for (const { type, data, at, seq } of entries) {
    if (type === "evidence.recorded") evidence.push({ ...data, at, seq });
    else if (type === "session.started" && !sessions.has(data.session)) sessions.set(data.session, { ...data, at, seq });
    else if (type === "action.begun") actions.set(data.id, { ...data, status: "pending", at, seq, history: [] });
    else if (type === "action.ended" || type === "action.reconciled") {
      const action = actions.get(data.id);
      if (!action) continue;
      if (type === "action.ended" && action.status !== "pending") continue;
      action.status = data.outcome;
      action.history.push({ type, ...data, at, seq });
    }
  }
  return { evidence, actions, sessions };
}

export async function loadState(repo) {
  return reduceEntries(await readLedger(repo));
}

export function openActions(state) {
  return [...state.actions.values()].filter((action) => OPEN.has(action.status));
}
