import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";

const PINNED_GIT = "/usr/bin/git";
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

/**
 * Read one repository-relative object from an exact revision for native review.
 * Replacement refs are explicitly disabled both in the environment and in the
 * Git invocation so a local repository cannot substitute context bytes while
 * retaining the requested revision identity.
 */
export async function readPinnedGitObject({ cwd, revision, relative, executionId = "native-review", diagnostic = () => {} }) {
  const info = await lstat(PINNED_GIT);
  if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o111)) {
    throw new Error("Pinned Git reader is unavailable");
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  Object.assign(env, {
    PATH: "/usr/bin:/bin",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C"
  });
  return new Promise((resolve, reject) => {
    const proc = spawn(PINNED_GIT, ["--no-replace-objects", "-c", "core.fsmonitor=false", "--literal-pathspecs", "-C", cwd,
      "show", `${revision}:${relative}`], { env, stdio: ["ignore", "pipe", "pipe"] });
    diagnostic("bw.git_object.child", { owner: executionId, pid: proc.pid, ppid: process.pid, cwd });
    const chunks = [];
    let size = 0;
    let stderr = "";
    proc.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_OBJECT_BYTES) proc.kill("SIGTERM");
      else chunks.push(chunk);
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16_384); });
    proc.once("error", reject);
    proc.once("close", (code, signal) => {
      diagnostic("bw.git_object.closed", { owner: executionId, pid: proc.pid, code, signal });
      const message = stderr.trim();
      // A manifest path can legitimately be absent from one side of an
      // addition/deletion. Keep that fact source-bound and explicit.
      if (code === 128 && !signal && (message.includes(" does not exist in ") ||
        message.includes(" exists on disk, but not in "))) return resolve(null);
      if (code !== 0 || signal || size > MAX_OBJECT_BYTES) {
        return reject(new Error(`Pinned Git object read failed: ${message || code || signal}`));
      }
      resolve(Buffer.concat(chunks));
    });
  });
}
