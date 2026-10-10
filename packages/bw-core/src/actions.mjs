import { randomUUID } from "node:crypto";
import { digest } from "./canonical.mjs";
import { classifyCommand } from "./classify.mjs";
import { appendEvent } from "./ledger.mjs";
import { ruleFor } from "./policy.mjs";
import { currentBranch, headCommit } from "./repo.mjs";
import { run } from "./process.mjs";
import { openActions } from "./state.mjs";

const RANK = { allow: 0, ask: 1, deny: 2 };

function strongest(a, b) {
  return RANK[b] > RANK[a] ? b : a;
}

export function actionKey(action, head) {
  return digest({ kind: action.kind, argv: action.argv, head });
}

// Decides whether a command line may run. Pure with respect to the ledger:
// it reads state but records nothing.
export function evaluateCommand({ command, policyInfo, state, head, now = new Date() }) {
  const { policy } = policyInfo;
  const classified = classifyCommand(command, policy);
  const reasons = [];
  let decision = "allow";
  const sideEffects = classified.actions.length > 0 || classified.opaque;

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

async function revParse(repo, rev) {
  const result = await run("git", ["rev-parse", "--verify", "-q", `${rev}^{commit}`], { cwd: repo.root });
  return result.code === 0 ? result.stdout.trim() : null;
}

async function upstreamRemote(repo, branch) {
  if (!branch) return "origin";
  const result = await run("git", ["config", "--get", `branch.${branch}.remote`], { cwd: repo.root });
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : "origin";
}

// What a push should have produced, captured before it runs.
async function pushExpectation(repo, target, branch) {
  const remote = target.remote ?? await upstreamRemote(repo, branch);
  const specs = target.refspecs.length ? target.refspecs : [branch ?? "HEAD"];
  const refs = [];
  for (const spec of specs) {
    const [rawSrc, rawDst] = spec.replace(/^\+/, "").split(":");
    const src = rawSrc === "HEAD" || rawSrc === "" ? branch : rawSrc;
    const dst = rawDst ?? src;
    if (!dst || dst.includes("*")) return { remote, refs: null };
    const ref = dst.startsWith("refs/") ? dst : `refs/heads/${dst}`;
    const sha = target.delete || rawSrc === "" ? null : await revParse(repo, rawSrc === "HEAD" ? "HEAD" : rawSrc);
    refs.push({ ref, sha });
  }
  return { remote, refs };
}

export async function beginActions(repo, evaluation, { command, tree, policyDigest, host = null, toolUseId = null }) {
  const [head, branch] = await Promise.all([headCommit(repo), currentBranch(repo)]);
  const ids = [];
  for (const action of evaluation.actions) {
    const id = `act_${randomUUID()}`;
    const expect = action.kind === "git-push" ? await pushExpectation(repo, action.target, branch) : null;
    await appendEvent(repo, "action.begun", {
      id, kind: action.kind, key: actionKey(action, head), argv: action.argv, target: action.target,
      command, head, branch, tree, expect, policyDigest, host, toolUseId,
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
