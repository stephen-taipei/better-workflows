import { appendEvent, newerLedgerWarning } from "./ledger.mjs";
import { subtreeDigests } from "./repo.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The directories a kind's result covers, as the policy declares them, or
// null when the kind is bound to the whole tree.
export function scopeFor(policy, kind) {
  return policy.evidence.kinds.find((rule) => rule.kind === kind)?.scope ?? null;
}

// The working copy as every scoped kind sees it: the whole tree plus the
// ids of each declared scope path inside it.
export async function snapshot(repo, policy, tree) {
  const paths = [...new Set(policy.evidence.kinds.flatMap((rule) => rule.scope ?? []))];
  return { tree, digests: await subtreeDigests(repo, tree, paths) };
}

export function scopeDigests(scope, digests) {
  return Object.fromEntries(scope.map((p) => [p, digests[p] ?? null]));
}

// `excluded` names why a run cannot count as a pass: "exit-code" when the
// line's exit code belongs to another command (`npm test | tail`), and
// "directory" when an exact rule's command ran outside its directory.
export async function recordEvidence(repo, {
  kind, command, exitCode, excluded = null, treeBefore, treeAfter, head,
  scope = null, scopeBefore = null, scopeAfter = null, outputDigest = null, host = null, session = null, toolUseId, order,
}) {
  if (typeof kind !== "string" || !kind) throw new TypeError("Evidence needs a kind");
  if (!Number.isInteger(exitCode) && exitCode !== null) throw new TypeError("Evidence exitCode must be an integer or null");
  const payload = {
    kind, command, exitCode, treeBefore, treeAfter, head, scope, scopeBefore, scopeAfter, outputDigest, host, session,
    ...(toolUseId === undefined ? {} : { toolUseId }), ...(order === undefined ? {} : { order }),
  };
  return appendEvent(repo, "evidence.recorded", excluded ? { ...payload, attributed: false, excluded } : payload);
}

const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;

// null is legacy provenance; false is malformed provenance. Neither can
// create causal order from append time, timestamps or file modification time.
function recordOrder(record) {
  if (!Object.hasOwn(record, "order")) return null;
  const order = record.order;
  if (!order || typeof order !== "object" || Array.isArray(order) || !nonnegative(record.seq) || record.seq === 0) return false;
  if (order.startedAfterSeq !== null && (!nonnegative(order.startedAfterSeq) || order.startedAfterSeq >= record.seq)) return false;
  const completion = order.completion;
  if (completion !== null && (!completion || record.host !== "codex" || typeof record.session !== "string" || !record.session
    || typeof record.toolUseId !== "string" || !record.toolUseId || !/^[a-f0-9]{64}$/.test(completion.snapshotId) || !nonnegative(completion.position))) return false;
  return order.startedAfterSeq === null && completion === null ? false : order;
}

const sameRun = (a, b) => a.record.toolUseId && a.record.host === b.record.host && a.record.session === b.record.session && a.record.toolUseId === b.record.toolUseId;

// The older record's seq is verified by the ledger even if its own ordering
// metadata is unusable. Only the later run may supply the Pre fence.
function ledgerPrecedes(a, b) {
  return b.order !== false && !sameRun(a, b) && nonnegative(a.record.seq) && a.record.seq > 0
    && nonnegative(b.order?.startedAfterSeq) && a.record.seq <= b.order.startedAfterSeq;
}

function precedes(a, b) {
  if (b.order === false || sameRun(a, b)) return false;
  if (ledgerPrecedes(a, b)) return true;
  if (a.order === false) return false;
  const first = a.record, second = b.record;
  const x = a.order?.completion, y = b.order?.completion;
  return Boolean(x && y && first.host === second.host && first.session === second.session && x.snapshotId === y.snapshotId && x.position < y.position);
}

function resultStatus(record, scope, order) {
  if (record.attributed === false) return "unattributed";
  if (record.exitCode !== 0) return "failed";
  if (scope ? !same(record.scopeBefore, record.scopeAfter) : record.treeBefore !== record.treeAfter) return "unstable";
  return order === false ? "uncertain" : "fresh";
}

// Recovery may append old completions last. Find all maximal results using
// only a validated Pre ledger fence or positions in the identical snapshot.
function maximalResults(candidates) {
  const newest = candidates.reduce((a, b) => a.record.seq > b.record.seq ? a : b);
  // Normal sequential reruns take linear time. This also retires an older
  // conflict only when the new fence covers everyone and no proof reverses it.
  if (newest.order && candidates.every((a) => a === newest || (ledgerPrecedes(a, newest) && !precedes(newest, a)))) {
    return { maxima: [newest], cycle: false };
  }
  // Unusual overlaps use implicit edges: quadratic time, linear storage.
  const incoming = candidates.map(() => 0), hasLater = candidates.map(() => false);
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = 0; j < candidates.length; j += 1) {
      if (i !== j && precedes(candidates[i], candidates[j])) { incoming[j] += 1; hasLater[i] = true; }
    }
  }
  const ready = incoming.flatMap((count, i) => count === 0 ? [i] : []);
  for (const i of ready) {
    for (let j = 0; j < candidates.length; j += 1) {
      if (incoming[j] > 0 && precedes(candidates[i], candidates[j]) && --incoming[j] === 0) ready.push(j);
    }
  }
  return { maxima: candidates.filter((_, i) => !hasLater[i]), cycle: ready.length !== candidates.length };
}

// Only stable, attributable passing evidence for the current content counts.
// Unknown or conflicting provenance remains blocking until a proven rerun.
export function evidenceStatus(state, kind, snap, scope = null) {
  const records = state.evidence.filter((record) => record.kind === kind);
  const want = scope ? scopeDigests(scope, snap.digests) : null;
  const current = scope
    ? (record) => same(record.scope, scope) && same(record.scopeAfter, want)
    : (record) => !record.scope && record.treeAfter === snap.tree;
  const candidates = records.filter(current).map((record) => ({ record, order: recordOrder(record) }));
  if (candidates.length) {
    const { maxima, cycle } = maximalResults(candidates);
    const results = (cycle ? candidates : maxima).map(({ record, order }) => ({ kind, status: resultStatus(record, scope, order), evidence: record }));
    const blocked = results.find((result) => result.status !== "fresh");
    if (!cycle && results.length === 1 && results[0].status !== "uncertain") return results[0];
    const result = blocked ?? { kind, status: "uncertain", evidence: results.at(-1)?.evidence ?? candidates.at(-1).record };
    const detail = result.status === "failed" ? `a run failed (exit ${result.evidence.exitCode})` : `a run is ${result.status}`;
    return { ...result, reason: `${detail}; result order is unconfirmed; rerun the check after these results are recorded` };
  }
  if (records.length) return { kind, status: "stale", evidence: records.at(-1), scope };
  return { kind, status: "missing", evidence: null };
}

export function completionStatus(state, policy, snap) {
  if (typeof snap === "string") snap = { tree: snap, digests: {} };
  if (state.newerLedger) {
    const reason = newerLedgerWarning(state.newerLedger);
    const results = policy.completion.require.map((kind) => ({ kind, status: "missing", evidence: null, reason }));
    return { ok: false, tree: snap.tree, results, newerLedger: state.newerLedger, reason };
  }
  const results = policy.completion.require.map((kind) => evidenceStatus(state, kind, snap, scopeFor(policy, kind)));
  return { ok: results.every((result) => result.status === "fresh"), tree: snap.tree, results };
}

export function describeEvidence(result) {
  if (result.reason) return `${result.kind}: ${result.reason}`;
  switch (result.status) {
    case "fresh": return `${result.kind}: passed on the current files`;
    case "failed": return `${result.kind}: last run on the current files failed (exit ${result.evidence.exitCode})`;
    case "unattributed":
      return result.evidence.excluded === "directory"
        ? `${result.kind}: the last run (\`${result.evidence.command}\`) was not in the directory the policy names for it, so it checked only part of the repository`
        : `${result.kind}: the last run's exit code came from another command on the same line (\`${result.evidence.command}\`); run it alone or join commands with &&`;
    case "unstable": return `${result.kind}: files changed while it ran, so the result does not belong to one state of the files`;
    case "stale":
      return result.scope
        ? `${result.kind}: last result was for an older state of ${result.scope.join(", ")}; files there changed since then`
        : `${result.kind}: last result was for an older tree; files changed since then`;
    default: return `${result.kind}: never run`;
  }
}

// How one session has gone for a kind. Core only counts; whether the run
// is converging or going in circles is the agent's call, or the person's.
export function sessionSummary(state, session, kind, host) {
  const runs = state.evidence.filter((r) => r.session === session && r.kind === kind && (host === undefined || r.host === host) && r.attributed !== false);
  let failing = 0;
  for (const run of runs.slice().reverse()) {
    if (run.exitCode === 0) break;
    failing += 1;
  }
  return { kind, runs: runs.length, trees: new Set(runs.map((r) => r.treeAfter)).size, failing };
}

export function describeSession(summary) {
  if (!summary.runs) return null;
  const streak = summary.failing ? `, the last ${summary.failing} failing` : "";
  return `${summary.kind} ran ${summary.runs} time${summary.runs === 1 ? "" : "s"} on ${summary.trees} state${summary.trees === 1 ? "" : "s"} of the files this session${streak}`;
}
