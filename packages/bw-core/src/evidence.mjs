import { appendEvent } from "./ledger.mjs";
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
  scope = null, scopeBefore = null, scopeAfter = null, outputDigest = null, host = null, session = null,
}) {
  if (typeof kind !== "string" || !kind) throw new TypeError("Evidence needs a kind");
  if (!Number.isInteger(exitCode) && exitCode !== null) throw new TypeError("Evidence exitCode must be an integer or null");
  const payload = { kind, command, exitCode, treeBefore, treeAfter, head, scope, scopeBefore, scopeAfter, outputDigest, host, session };
  return appendEvent(repo, "evidence.recorded", excluded ? { ...payload, attributed: false, excluded } : payload);
}

// Evidence counts only when it passed and the files it covers did not
// change while it ran, and only for the exact content it ran on: the whole
// tree, or the scope paths when the policy declares them for the kind.
export function evidenceStatus(state, kind, snap, scope = null) {
  const records = state.evidence.filter((record) => record.kind === kind);
  const want = scope ? scopeDigests(scope, snap.digests) : null;
  const current = scope
    ? (record) => same(record.scope, scope) && same(record.scopeAfter, want)
    : (record) => !record.scope && record.treeAfter === snap.tree;
  const latest = records.filter(current).at(-1);
  if (latest) {
    if (latest.attributed === false) return { kind, status: "unattributed", evidence: latest };
    if (latest.exitCode !== 0) return { kind, status: "failed", evidence: latest };
    const moved = scope ? !same(latest.scopeBefore, latest.scopeAfter) : latest.treeBefore !== latest.treeAfter;
    if (moved) return { kind, status: "unstable", evidence: latest };
    return { kind, status: "fresh", evidence: latest };
  }
  if (records.length) return { kind, status: "stale", evidence: records.at(-1), scope };
  return { kind, status: "missing", evidence: null };
}

export function completionStatus(state, policy, snap) {
  if (typeof snap === "string") snap = { tree: snap, digests: {} };
  const results = policy.completion.require.map((kind) => evidenceStatus(state, kind, snap, scopeFor(policy, kind)));
  return { ok: results.every((result) => result.status === "fresh"), tree: snap.tree, results };
}

export function describeEvidence(result) {
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
