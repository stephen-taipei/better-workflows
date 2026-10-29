#!/usr/bin/env node
// A minimal host built on the public API: decides whether one command line
// may run, runs it, and records what happened, the same steps the Claude
// Code adapter takes around a Bash call.
//
//   node guarded-run.mjs [--yes] -- <command line>
//
// Exit codes: the command's own exit code when it ran; 2 when Core refused
// it; 3 when the policy asks and --yes was not given. Unlike a hook, a
// wrapper only protects commands sent through it.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  beginActions, endActions, evaluateCommand, headCommit, loadPolicy, loadState, openActions,
  openRepo, reconcileOpen, recordEvidence, scopeDigests, scopeFor, snapshot, withLedgerLock, worktreeTree,
} from "@better-workflows/core";

const HOST = "guarded-run";
const args = process.argv.slice(2);
const dash = args.indexOf("--");
if (dash < 0 || dash === args.length - 1) {
  console.error("usage: guarded-run.mjs [--yes] -- <command line>");
  process.exit(1);
}
const yes = args.slice(0, dash).includes("--yes");
const command = args.slice(dash + 1).join(" ");

const repo = await openRepo(process.cwd());
if (!repo) {
  console.error("guarded-run: not inside a Git work tree");
  process.exit(1);
}
const policyInfo = await loadPolicy(repo);
// An exact evidence rule names the directory it must run in; `where.cd`
// lists the `cd` targets before the command on the line (null when they
// cannot be read), resolved against where this wrapper was started.
const real = (dir) => { try { return realpathSync(dir); } catch { return dir; } };
const ranWhereRequired = (where) => !where
  || (where.cd !== null && real(path.resolve(process.cwd(), ...where.cd)) === real(path.resolve(repo.root, where.cwd)));
const decide = async () => evaluateCommand({ command, policyInfo, state: await loadState(repo), head: await headCommit(repo) });

// 1. Decide. An earlier action with no confirmed result blocks every side
//    effect, so give the read-only probes one chance to settle it first.
let evaluation = await decide();
if ((evaluation.actions.length || evaluation.opaque) && openActions(await loadState(repo)).length) {
  await reconcileOpen(repo);
  evaluation = await decide();
}
const refuse = (code, label) => {
  console.error(`guarded-run: ${label}: ${evaluation.reasons.join("; ")}`);
  process.exit(code);
};
if (evaluation.decision === "deny") refuse(2, "denied");
if (evaluation.decision === "ask" && !yes) refuse(3, "needs approval (pass --yes)");

// 2. Record each side effect before it runs, deciding again under the
//    ledger lock so two processes cannot both start the same push.
const { ignore } = policyInfo.policy.evidence;
const treeBefore = await worktreeTree(repo, { ignore });
let ids = [];
if (evaluation.actions.length) {
  evaluation = await withLedgerLock(repo, async () => {
    const latest = await decide();
    if (latest.decision !== "deny") ids = await beginActions(repo, latest, { command, tree: treeBefore, policyDigest: policyInfo.digest, host: HOST });
    return latest;
  });
  if (evaluation.decision === "deny") refuse(2, "denied");
}
const before = await snapshot(repo, policyInfo.policy, treeBefore);

// 3. Run. A signal or a spawn error leaves the exit code unknown (null).
const order = { startedAfterSeq: (await loadState(repo)).seq, completion: null };
const run = spawnSync("bash", ["-c", command], { stdio: "inherit" });
const exitCode = run.error || run.signal ? null : run.status;

// 4. Report. Only exit 0 settles an action as success; anything else stays
//    unknown until `bw reconcile` checks the provider.
if (ids.length) await endActions(repo, ids, { exitCode, detail: exitCode === 0 ? null : `exit ${exitCode ?? "unknown"}` });
if (evaluation.evidence.length) {
  const [treeAfter, head] = await Promise.all([worktreeTree(repo, { ignore }), headCommit(repo)]);
  const after = await snapshot(repo, policyInfo.policy, treeAfter);
  for (const kind of new Set(evaluation.evidence.map((e) => e.kind))) {
    const runs = evaluation.evidence.filter((e) => e.kind === kind);
    const placed = runs.some((e) => ranWhereRequired(e.where));
    const excluded = !placed ? "directory" : runs.some((e) => e.attributable) ? null : "exit-code";
    const scope = scopeFor(policyInfo.policy, kind);
    const scoped = scope ? { scope, scopeBefore: scopeDigests(scope, before.digests), scopeAfter: scopeDigests(scope, after.digests) } : {};
    await recordEvidence(repo, { kind, command, exitCode, excluded, treeBefore, treeAfter, head, host: HOST, order, ...scoped });
  }
}
process.exit(exitCode ?? 1);
