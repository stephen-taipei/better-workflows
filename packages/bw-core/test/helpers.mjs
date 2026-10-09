import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openRepo } from "../src/repo.mjs";

export function sh(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
}

// A repository with one commit, a bare "origin" and `main` tracking it.
export async function fixtureRepo(t) {
  const base = await mkdtemp(path.join(tmpdir(), "bw-core-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const remote = path.join(base, "origin.git");
  const root = path.join(base, "work");
  await mkdir(root);
  sh(base, "init", "-q", "--bare", "-b", "main", remote);
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.email", "test@example.com");
  sh(root, "config", "user.name", "Test");
  sh(root, "config", "commit.gpgsign", "false");
  await writeFile(path.join(root, "app.txt"), "one\n");
  await writeFile(path.join(root, ".gitignore"), "ignored/\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "init");
  sh(root, "remote", "add", "origin", remote);
  sh(root, "push", "-q", "-u", "origin", "main");
  const repo = await openRepo(root);
  return { base, root, remote, repo };
}

export async function writePolicy(root, policy) {
  await mkdir(path.join(root, ".better-workflows"), { recursive: true });
  await writeFile(path.join(root, ".better-workflows", "policy.json"), JSON.stringify(policy));
}

export function captureIo() {
  const out = [];
  const err = [];
  return { io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } }, out, err };
}
