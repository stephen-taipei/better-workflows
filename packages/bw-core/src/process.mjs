import { execFile } from "node:child_process";

const MAX_BUFFER = 8 * 1024 * 1024;

// Runs a program without a shell. Never throws for a non-zero exit; callers
// read `code`. `code` is null when the process timed out or failed to start.
export function run(file, args, { cwd, env, timeoutMs = 30_000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr, timedOut: false });
      const timedOut = error.killed === true && error.signal != null;
      const code = typeof error.code === "number" ? error.code : null;
      resolve({ code: timedOut ? null : code, stdout: stdout ?? "", stderr: stderr ?? String(error.message), timedOut });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
