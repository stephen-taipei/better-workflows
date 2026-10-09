import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { run } from "./process.mjs";

async function git(cwd, args, options = {}) {
  const result = await run("git", args, { cwd, ...options });
  if (result.code !== 0) {
    const reason = result.timedOut ? "timed out" : result.stderr.trim();
    throw new Error(`git ${args[0]} failed: ${reason}`);
  }
  return result.stdout;
}

// Returns null outside a Git work tree, so callers can stay inert there.
export async function openRepo(cwd = process.cwd()) {
  const probe = await run("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd });
  if (probe.code !== 0) return null;
  const [root, gitDir] = probe.stdout.trim().split("\n");
  const stateDir = path.join(gitDir, "better-workflows");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  return { root, gitDir, stateDir };
}

export async function headCommit(repo) {
  const result = await run("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: repo.root });
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function currentBranch(repo) {
  const result = await run("git", ["symbolic-ref", "-q", "--short", "HEAD"], { cwd: repo.root });
  return result.code === 0 ? result.stdout.trim() : null;
}

// Git tree object of the working tree as it is now: tracked changes plus
// untracked files that are not ignored. Uses a throwaway, empty index so the
// user's staging area is never touched and every file is hashed by content;
// seeding from the real index would trust stat data, which misses same-size
// edits made within the same second.
export async function worktreeTree(repo) {
  const index = path.join(repo.stateDir, `index-${process.pid}-${randomUUID()}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    await git(repo.root, ["add", "-A", "--", "."], { env, timeoutMs: 120_000 });
    return (await git(repo.root, ["write-tree"], { env })).trim();
  } finally {
    await rm(index, { force: true });
  }
}

export async function treeState(repo) {
  const [head, tree] = await Promise.all([headCommit(repo), worktreeTree(repo)]);
  return { head, tree };
}

export { git };
