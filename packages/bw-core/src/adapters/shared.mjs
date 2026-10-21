import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { beginActions, endActions, evaluateCommand } from "../actions.mjs";
import { completionStatus, describeEvidence, describeSession, recordEvidence, scopeDigests, scopeFor, sessionSummary, snapshot } from "../evidence.mjs";
import { appendEvent, withLedgerLock } from "../ledger.mjs";
import { loadPolicy } from "../policy.mjs";
import { ghFailure, reconcileOpen } from "../reconcile.mjs";
import { headCommit, subtreeDigests, worktreeTree } from "../repo.mjs";
import { loadState, openActions } from "../state.mjs";
import { splitCommand } from "../command.mjs";
import { run } from "../process.mjs";

const READ_ONLY = new Set(["cat", "head", "tail", "less", "more", "jq", "grep", "rg", "ls", "wc", "file", "stat", "diff"]);
const PROTECTED_TEXT = [".better-workflows/", ".better-workflows\\", "/.git/better-workflows", ".git/better-workflows"];

// Refusals and questions are kept in the ledger too, so a review can count
// what the hooks stopped and not only what was let through. The decision
// stands even when the ledger cannot be written.
function gate(repo, event, decision, reason, { target = null } = {}) {
  const command = event.toolName === "Bash" ? String(event.command ?? "").slice(0, 500) : null;
  try {
    return appendEvent(repo, "tool.gated", {
      decision, reason, tool: event.toolName, command,
      target: command === null ? String(target ?? "") : null,
      host: event.host, session: event.sessionId ?? null,
    }).catch(() => null).then(() => ({ decision, reason }));
  } catch {
    // Refusing without a record is safer than letting the call through.
    return Promise.resolve({ decision, reason });
  }
}

export function pendingFile(repo, host, toolUseId) {
  const hostPart = String(host ?? "").replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  const idPart = String(toolUseId).replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(repo.stateDir, "pending", `${hostPart}-${idPart}.json`);
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
    const bw = argv.some((arg) => /(^|[/\\])bw(\.mjs)?$/.test(arg) || /^@better-workflows\/core(@|$)/.test(arg));
    if (!bw) continue;
    if (argv.includes("init")) return "only a person creates the policy file";
    // `bw run` records whatever exit code its command returns under any kind
    // it is given, so from the agent it would turn `true` into a passing test.
    if (argv.includes("run")) return "only a person records evidence through `bw run`; run the check itself (for example `npm test`) and the hooks record its result";
    const i = argv.indexOf("reconcile");
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) return "only a person settles an action by hand; run `bw reconcile` without an id to let the read-only checks settle it";
  }
  return null;
}

// `target` is host-derived detail kept outside the normalized event.
export async function protectedPath(event, repo, target) {
  if (!target) return null;
  const [absolute, root, gitDir] = await Promise.all([
    physicalPath(path.resolve(event.cwd ?? repo.root, target)), physicalPath(repo.root), physicalPath(repo.gitDir),
  ]);
  if (isInside(absolute, path.join(root, ".better-workflows")) || isInside(absolute, gitDir)) {
    return gate(repo, event, "deny", `${target} is protected; the policy and ledger are changed by a person, not the agent`, { target });
  }
  return null;
}

function applyDecisionMap(evaluation, mapEvaluation) {
  if (!mapEvaluation) return evaluation;
  const mapped = mapEvaluation(evaluation);
  return mapped && typeof mapped === "object" ? { ...evaluation, ...mapped } : evaluation;
}

// The policy, initial evaluation, reconciliation and locked reevaluation all
// happen here. Hosts may map semantic decisions before any action is begun.
export async function preBash(event, repo, { beforeEvaluate, mapEvaluation } = {}) {
  const command = String(event.command ?? "");
  const protectedReason = protectedBash(command);
  if (protectedReason) return gate(repo, event, "deny", protectedReason);

  const policyInfo = await loadPolicy(repo);
  let state = await loadState(repo);
  if (beforeEvaluate && await beforeEvaluate(state)) state = await loadState(repo);
  const head = await headCommit(repo);
  let evaluation = applyDecisionMap(evaluateCommand({ command, policyInfo, state, head }), mapEvaluation);
  if ((evaluation.actions.length || evaluation.opaque) && openActions(state).length) {
    await reconcileOpen(repo);
    state = await loadState(repo);
    evaluation = applyDecisionMap(evaluateCommand({ command, policyInfo, state, head }), mapEvaluation);
  }
  if (evaluation.decision === "deny") return gate(repo, event, "deny", evaluation.reasons.join("; "));

  const { ignore } = policyInfo.policy.evidence;
  const tree = evaluation.actions.length || evaluation.evidence.length ? await worktreeTree(repo, { ignore }) : null;
  if (evaluation.actions.length) {
    // Decide again and record under the ledger lock, so two sessions cannot
    // both be let through for the same push before either has recorded it.
    evaluation = await withLedgerLock(repo, async () => {
      const latest = applyDecisionMap(
        evaluateCommand({ command, policyInfo, state: await loadState(repo), head: await headCommit(repo) }),
        mapEvaluation,
      );
      if (latest.decision !== "deny") {
        await beginActions(repo, latest, { command, tree, policyDigest: policyInfo.digest, host: event.host, toolUseId: event.toolUseId ?? null });
      }
      return latest;
    });
    if (evaluation.decision === "deny") return gate(repo, event, "deny", evaluation.reasons.join("; "));
  }
  if (evaluation.evidence.length && event.toolUseId) {
    const file = pendingFile(repo, event.host, event.toolUseId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const kinds = [...new Set(evaluation.evidence.map((e) => e.kind))];
    const placed = await Promise.all(evaluation.evidence.map((e) => ranWhereRequired(e, event, repo)));
    // Per kind, the reason none of its runs can count, if any: one that ran
    // where the policy says and decides the line's exit code is enough.
    const excluded = {};
    for (const kind of kinds) {
      const runs = evaluation.evidence.map((e, i) => ({ ...e, placed: placed[i] })).filter((e) => e.kind === kind);
      if (runs.some((e) => e.placed && e.attributable)) continue;
      excluded[kind] = runs.some((e) => e.placed) ? "exit-code" : "directory";
    }
    const before = await snapshot(repo, policyInfo.policy, tree);
    const scopes = {};
    for (const kind of kinds) {
      const scope = scopeFor(policyInfo.policy, kind);
      if (scope) scopes[kind] = { scope, before: scopeDigests(scope, before.digests) };
    }
    await writeFile(file, JSON.stringify({ kinds, excluded, command, treeBefore: tree, ignore, scopes }), { mode: 0o600 });
  }
  // Core only narrows what the host already allows; an allow defers to the
  // host's own permission rules instead of granting anything.
  return evaluation.decision === "ask" ? gate(repo, event, "ask", evaluation.reasons.join("; ")) : null;
}

// Whether an exact evidence run happened in the directory its rule names.
async function ranWhereRequired(evidence, event, repo) {
  if (!evidence.where) return true;
  if (!evidence.where.cd) return false;
  const [ran, wanted] = await Promise.all([
    physicalPath(path.resolve(event.cwd ?? repo.root, ...evidence.where.cd)),
    physicalPath(path.resolve(repo.root, evidence.where.cwd)),
  ]);
  return ran === wanted;
}

export async function postBash(event, repo, { detail } = {}) {
  if (event.toolName !== "Bash" || !event.toolUseId) return null;
  const exitCode = event.finalExitCode;
  const state = await loadState(repo);
  const ids = [...state.actions.values()]
    .filter((a) => a.host === event.host && a.toolUseId === event.toolUseId && a.status === "pending")
    .map((a) => a.id);
  if (ids.length) await endActions(repo, ids, { exitCode, detail: exitCode === 0 ? null : String(detail ?? "interrupted").slice(0, 500) });

  const file = pendingFile(repo, event.host, event.toolUseId);
  let pending;
  try {
    pending = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  await rm(file, { force: true });
  const [treeAfter, head] = await Promise.all([worktreeTree(repo, { ignore: pending.ignore ?? [] }), headCommit(repo)]);
  const scopes = pending.scopes ?? {};
  const after = await subtreeDigests(repo, treeAfter, [...new Set(Object.values(scopes).flatMap((s) => s.scope))]);
  for (const kind of pending.kinds) {
    const excluded = pending.excluded?.[kind] ?? null;
    const scoped = scopes[kind] ? { scope: scopes[kind].scope, scopeBefore: scopes[kind].before, scopeAfter: scopeDigests(scopes[kind].scope, after) } : {};
    await recordEvidence(repo, {
      kind, command: pending.command, exitCode, excluded, treeBefore: pending.treeBefore, treeAfter, head,
      host: event.host, session: event.sessionId ?? null, ...scoped,
    });
  }
  return null;
}

// Whether the policy or the ledger needs `gh`, so a missing or logged-out
// `gh` is reported at the start of the session rather than at the first
// pull request that then stays unknown.
async function ghWarning(policy, state) {
  const needsGh = Object.keys(policy.actions.rules).some((kind) => kind.startsWith("gh-")) || openActions(state).some((a) => a.kind.startsWith("gh-"));
  if (!needsGh) return null;
  const result = await run("gh", ["auth", "status"], { timeoutMs: 15_000 });
  return result.code === 0 ? null : ghFailure(result, "gh auth status");
}

export async function sessionStart(event, repo, { source = null, afterRecord } = {}) {
  const policyInfo = await loadPolicy(repo);
  const [tree, head] = await Promise.all([worktreeTree(repo, { ignore: policyInfo.policy.evidence.ignore }), headCommit(repo)]);
  await appendEvent(repo, "session.started", { session: event.sessionId ?? null, source, tree, head, host: event.host });
  let state = await loadState(repo);
  if (afterRecord && await afterRecord(state)) state = await loadState(repo);
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
  const gh = await ghWarning(policyInfo.policy, state);
  if (gh) lines.push(`Warning: ${gh}.`);
  return lines.join("\n");
}

export async function stopSession(event, repo, { stopHookActive = false, beforeCompletion } = {}) {
  if (beforeCompletion) await beforeCompletion(await loadState(repo));
  const policyInfo = await loadPolicy(repo);
  if (!policyInfo.policy.completion.require.length) return null;
  const [state, tree] = await Promise.all([loadState(repo), worktreeTree(repo, { ignore: policyInfo.policy.evidence.ignore })]);
  const session = event.sessionId ?? null;
  const started = state.sessions.get(session);
  if (started && started.tree === tree) return null; // nothing changed in this session
  const completion = completionStatus(state, policyInfo.policy, await snapshot(repo, policyInfo.policy, tree));
  if (completion.ok) return null;
  const missing = completion.results.filter((r) => r.status !== "fresh");
  const lines = missing.map(describeEvidence);
  // Counts for the agent to judge whether it is converging; Core does not
  // decide that, and a person extends authority, never the agent.
  const history = missing.map((r) => describeSession(sessionSummary(state, session, r.kind))).filter(Boolean);
  if (started?.blocks) history.push(`this session was already sent back ${started.blocks} time${started.blocks === 1 ? "" : "s"}`);
  const trend = history.length ? ` So far: ${history.join("; ")}.` : "";
  if (stopHookActive) {
    return { type: "message", message: `Better Workflows: the agent stopped without fresh evidence. ${lines.join("; ")}.${trend}` };
  }
  await appendEvent(repo, "completion.blocked", { session, missing: missing.map((r) => r.kind), tree });
  return {
    type: "block",
    reason: `Better Workflows: the files changed and the required evidence does not match them yet. ${lines.join("; ")}.${trend} Run the checks on the current files, fix any failure, then finish. If the same failure keeps coming back, stop and say plainly which check is failing and why, instead of trying again.`,
  };
}
