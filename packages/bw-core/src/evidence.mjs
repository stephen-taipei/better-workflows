import { appendEvent } from "./ledger.mjs";

export async function recordEvidence(repo, { kind, command, exitCode, treeBefore, treeAfter, head, outputDigest = null, host = null }) {
  if (typeof kind !== "string" || !kind) throw new TypeError("Evidence needs a kind");
  if (!Number.isInteger(exitCode) && exitCode !== null) throw new TypeError("Evidence exitCode must be an integer or null");
  return appendEvent(repo, "evidence.recorded", { kind, command, exitCode, treeBefore, treeAfter, head, outputDigest, host });
}

// Evidence counts only when it passed and the tree did not change while it
// ran, and only for the exact tree it ran on.
export function evidenceStatus(state, kind, tree) {
  const records = state.evidence.filter((record) => record.kind === kind);
  const forTree = records.filter((record) => record.treeAfter === tree);
  const latest = forTree.at(-1);
  if (latest) {
    if (latest.exitCode !== 0) return { kind, status: "failed", evidence: latest };
    if (latest.treeBefore !== latest.treeAfter) return { kind, status: "unstable", evidence: latest };
    return { kind, status: "fresh", evidence: latest };
  }
  if (records.length) return { kind, status: "stale", evidence: records.at(-1) };
  return { kind, status: "missing", evidence: null };
}

export function completionStatus(state, policy, tree) {
  const results = policy.completion.require.map((kind) => evidenceStatus(state, kind, tree));
  return { ok: results.every((result) => result.status === "fresh"), tree, results };
}

export function describeEvidence(result) {
  switch (result.status) {
    case "fresh": return `${result.kind}: passed on the current tree`;
    case "failed": return `${result.kind}: last run on the current tree failed (exit ${result.evidence.exitCode})`;
    case "unstable": return `${result.kind}: files changed while it ran, so the result does not belong to one tree`;
    case "stale": return `${result.kind}: last result was for an older tree; files changed since then`;
    default: return `${result.kind}: never run`;
  }
}
