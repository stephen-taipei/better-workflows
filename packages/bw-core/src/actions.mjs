import { randomUUID } from "node:crypto";
import path from "node:path";
import { digest } from "./canonical.mjs";
import { classifyCommand } from "./classify.mjs";
import { appendEvent, newerLedgerWarning } from "./ledger.mjs";
import { ruleFor } from "./policy.mjs";
import { currentBranch, headCommit } from "./repo.mjs";
import { run } from "./process.mjs";
import { openActions } from "./state.mjs";

const RANK = { allow: 0, ask: 1, deny: 2 };

function strongest(a, b) {
  return RANK[b] > RANK[a] ? b : a;
}

// `where` joins the key only when the command points somewhere else, so the
// same push from another clone is not mistaken for one already done here.
export function actionKey(action, head) {
  return digest({ kind: action.kind, argv: action.argv, head, ...(action.where ? { where: action.where } : {}) });
}

// Decides whether a command line may run. Pure with respect to the ledger:
// it reads state but records nothing.
export function evaluateCommand({ command, policyInfo, state, head, now = new Date() }) {
  const { policy } = policyInfo;
  const classified = classifyCommand(command, policy);
  const reasons = [];
  let decision = "allow";
  const sideEffects = classified.actions.length > 0 || classified.opaque;

  if (sideEffects && state.newerLedger) {
    return { decision: "deny", reasons: [`${newerLedgerWarning(state.newerLedger)} before running side effects`], ...classified };
  }
  if (sideEffects && policyInfo.error) {
    return { decision: "deny", reasons: [`policy file is invalid: ${policyInfo.error}`], ...classified };
  }
  if (sideEffects) {
    const open = openActions(state);
    if (open.length) {
      decision = "deny";
      for (const action of open) {
        reasons.push(`earlier ${action.kind} (${action.id}) has an ${action.status === "pending" ? "unfinished" : "unknown"} result; run \`bw reconcile\` before any other side effect`);
      }
    }
  }
  for (const action of classified.actions) {
    const rule = ruleFor(policy, action.kind, now);
    decision = strongest(decision, rule.decision);
    reasons.push(`${action.kind}: ${rule.reason}`);
    const key = actionKey(action, head);
    const done = [...state.actions.values()].find((prior) => prior.key === key && prior.status === "success");
    if (done) {
      decision = "deny";
      reasons.push(`${action.kind}: the same action already succeeded at this commit (${done.id})`);
    }
  }
  if (classified.opaque) {
    decision = strongest(decision, policy.opaque.decision);
    reasons.push(`command uses substitution, eval or a nested shell, so its effects cannot be checked (opaque is ${policy.opaque.decision})`);
  }
  if (classified.actions.length && classified.changesDirectory) {
    decision = strongest(decision, "ask");
    reasons.push("command changes directory before a side effect, so its target repository is uncertain");
  }
  return { decision, reasons, ...classified };
}

async function revParse(dir, rev) {
  const result = await run("git", ["rev-parse", "--verify", "-q", `${rev}^{commit}`], { cwd: dir });
  return result.code === 0 ? result.stdout.trim() : null;
}

async function upstreamRemote(dir, branch) {
  if (!branch) return "origin";
  const result = await run("git", ["config", "--get", `branch.${branch}.remote`], { cwd: dir });
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : "origin";
}

// The work tree a git command runs in after its `cd`s and `-C`s, or null
// when that cannot be known without running the shell.
export async function gitDirectoryFor(action, base) {
  const where = action.where;
  if (!where) return null;
  if (where.unresolved || where.cd === null) return null;
  const steps = [...(where.cd ?? []), ...(where.dirs ?? [])];
  if (steps.some((step) => typeof step !== "string" || /^~|\$/.test(step))) return null;
  const result = await run("git", ["rev-parse", "--show-toplevel"], { cwd: path.resolve(base, ...steps) });
  return result.code === 0 ? result.stdout.trim() : null;
}

// What a push should have produced, captured before it runs. A ref whose
// commit cannot be resolved makes the whole expectation unknown: a missing
// sha must never compare equal to a missing remote ref.
async function pushExpectation(dir, target, branch) {
  const remote = target.remote ?? await upstreamRemote(dir, branch);
  const specs = target.refspecs.length ? target.refspecs : [branch ?? "HEAD"];
  const refs = [];
  for (const spec of specs) {
    const [rawSrc, rawDst] = spec.replace(/^\+/, "").split(":");
    const src = rawSrc === "HEAD" || rawSrc === "" ? branch : rawSrc;
    const dst = rawDst ?? src;
    if (!dst || dst.includes("*")) return { remote, refs: null };
    const ref = dst.startsWith("refs/") ? dst : `refs/heads/${dst}`;
    const deleting = target.delete || rawSrc === "";
    const sha = deleting ? null : await revParse(dir, rawSrc === "HEAD" ? "HEAD" : rawSrc);
    if (!deleting && !sha) return { remote, refs: null };
    refs.push({ ref, sha });
  }
  return { remote, refs };
}

async function pushTargetExpectation(repo, action, branch, cwd) {
  if (!action.where) return pushExpectation(repo.root, action.target, branch);
  const dir = await gitDirectoryFor(action, cwd ?? repo.root);
  if (!dir) return { remote: action.target.remote ?? null, refs: null, cwd: null };
  const result = await run("git", ["symbolic-ref", "-q", "--short", "HEAD"], { cwd: dir });
  const dirBranch = result.code === 0 ? result.stdout.trim() : null;
  return { ...(await pushExpectation(dir, action.target, dirBranch)), cwd: dir };
}

export async function beginActions(repo, evaluation, { command, tree, policyDigest, host = null, toolUseId = null, session, turnId, cwd, transcriptPath, startedAfterSeq }) {
  const [head, branch] = await Promise.all([headCommit(repo), currentBranch(repo)]);
  const ids = [];
  for (const action of evaluation.actions) {
    const id = `act_${randomUUID()}`;
    const expect = action.kind === "git-push" ? await pushTargetExpectation(repo, action, branch, cwd) : null;
    // The work tree a `cd`-ed or `-C` command resolved to, so a probe can
    // tell a cd into a subdirectory of this repository from one elsewhere.
    const location = action.where ? (expect?.cwd ?? await gitDirectoryFor(action, cwd ?? repo.root)) : undefined;
    await appendEvent(repo, "action.begun", {
      id, kind: action.kind, key: actionKey(action, head), argv: action.argv, target: action.target,
      ...(action.where ? { where: action.where, location } : {}),
      command, head, branch, tree, expect, policyDigest, host, toolUseId,
      ...(startedAfterSeq === undefined ? {} : { startedAfterSeq }),
      ...(session === undefined ? {} : { session, turnId: turnId ?? null, cwd: cwd ?? null, transcriptPath: transcriptPath ?? null }),
    });
    ids.push(id);
  }
  return ids;
}

// Exit 0 is the only result treated as known. Anything else may have
// partially reached the provider, so it stays unknown until reconciled.
export async function endActions(repo, ids, { exitCode, detail = null }) {
  const outcome = exitCode === 0 ? "success" : "unknown";
  for (const id of ids) await appendEvent(repo, "action.ended", { id, outcome, exitCode: exitCode ?? null, detail });
  return outcome;
}

// Only for a call the host proves it refused before running, so nothing
// can have reached the provider.
export async function markNotRun(repo, id, detail) {
  return appendEvent(repo, "action.ended", { id, outcome: "failed", exitCode: null, detail });
}
