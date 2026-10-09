import { readFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "./ledger.mjs";
import { run } from "./process.mjs";
import { loadState, openActions } from "./state.mjs";

const unknown = (detail) => ({ outcome: "unknown", detail });

// Read-only probes. Each answers "did the side effect happen?" from the
// provider itself, never from the agent's account of it.
export const PROBES = {
  async "git-push"(action, { repo, exec }) {
    const expect = action.expect;
    if (!expect?.refs) return unknown("push target could not be determined; reconcile manually");
    for (const { ref, sha } of expect.refs) {
      const result = await exec("git", ["ls-remote", "--", expect.remote, ref], { cwd: repo.root, timeoutMs: 30_000 });
      if (result.code !== 0) return unknown(`git ls-remote failed: ${result.stderr.trim() || "timed out"}`);
      const remoteSha = result.stdout.split("\n").find((line) => line.endsWith(`\t${ref}`))?.split("\t")[0] ?? null;
      if (remoteSha !== sha) return { outcome: "failed", detail: `${expect.remote} ${ref} is ${remoteSha ?? "absent"}, expected ${sha ?? "absent"}` };
    }
    return { outcome: "success", detail: `${expect.remote} has the expected refs` };
  },
  async "gh-pr-merge"(action, { repo, exec }) {
    const args = ["pr", "view", ...(action.target.pr ? [action.target.pr] : []), "--json", "state"];
    const result = await exec("gh", args, { cwd: repo.root, timeoutMs: 30_000 });
    if (result.code !== 0) return unknown(`gh pr view failed: ${result.stderr.trim() || "timed out"}`);
    const state = JSON.parse(result.stdout).state;
    return state === "MERGED" ? { outcome: "success", detail: "pull request is merged" } : { outcome: "failed", detail: `pull request is ${state}` };
  },
  async "gh-pr-create"(action, { repo, exec }) {
    const head = action.target.head ?? action.branch;
    if (!head) return unknown("pull request head branch is unknown");
    const result = await exec("gh", ["pr", "list", "--head", head, "--state", "all", "--json", "number", "--limit", "1"], { cwd: repo.root, timeoutMs: 30_000 });
    if (result.code !== 0) return unknown(`gh pr list failed: ${result.stderr.trim() || "timed out"}`);
    const found = JSON.parse(result.stdout);
    return found.length ? { outcome: "success", detail: `pull request #${found[0].number} exists` } : { outcome: "failed", detail: "no pull request for that branch" };
  },
  async "gh-release"(action, { repo, exec }) {
    const { operation, tag } = action.target;
    if (!tag || (operation !== "create" && operation !== "delete")) return unknown(`release ${operation} needs manual reconciliation`);
    const result = await exec("gh", ["release", "view", tag, "--json", "tagName"], { cwd: repo.root, timeoutMs: 30_000 });
    const exists = result.code === 0;
    if (!exists && !/not found/i.test(result.stderr)) return unknown(`gh release view failed: ${result.stderr.trim() || "timed out"}`);
    const success = operation === "create" ? exists : !exists;
    return { outcome: success ? "success" : "failed", detail: `release ${tag} ${exists ? "exists" : "does not exist"}` };
  },
  async "package-publish"(action, { repo, exec }) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(repo.root, "package.json"), "utf8"));
    } catch {
      return unknown("package.json not readable at the repository root");
    }
    const spec = `${manifest.name}@${manifest.version}`;
    const result = await exec("npm", ["view", spec, "version"], { cwd: repo.root, timeoutMs: 30_000 });
    if (result.code === 0 && result.stdout.trim() === manifest.version) return { outcome: "success", detail: `${spec} is published` };
    if (/E404|404 Not Found/.test(result.stderr)) return { outcome: "failed", detail: `${spec} is not published` };
    return unknown(`npm view failed: ${result.stderr.trim() || "timed out"}`);
  },
};

export async function reconcileOpen(repo, { exec = run } = {}) {
  const state = await loadState(repo);
  const results = [];
  for (const action of openActions(state)) {
    const probe = PROBES[action.kind];
    let result;
    try {
      result = probe ? await probe(action, { repo, exec }) : unknown(`no automatic check for ${action.kind}; reconcile manually`);
    } catch (error) {
      result = unknown(`check failed: ${error.message}`);
    }
    if (result.outcome !== "unknown") {
      await appendEvent(repo, "action.reconciled", { id: action.id, outcome: result.outcome, method: "probe", detail: result.detail });
    } else if (action.status === "pending") {
      await appendEvent(repo, "action.ended", { id: action.id, outcome: "unknown", exitCode: null, detail: "no result was recorded" });
    }
    results.push({ id: action.id, kind: action.kind, ...result });
  }
  return results;
}

// For actions no probe can settle. Meant for a person, not the agent; host
// adapters must block the agent from running it.
export async function reconcileManually(repo, id, outcome, note) {
  if (outcome !== "success" && outcome !== "failed") throw new Error("Outcome must be success or failed");
  if (!note) throw new Error("A manual reconciliation needs a note saying how the outcome was checked");
  const state = await loadState(repo);
  const action = state.actions.get(id);
  if (!action) throw new Error(`Unknown action ${id}`);
  if (action.status !== "pending" && action.status !== "unknown") throw new Error(`Action ${id} is already ${action.status}`);
  return appendEvent(repo, "action.reconciled", { id, outcome, method: "manual", detail: note });
}
