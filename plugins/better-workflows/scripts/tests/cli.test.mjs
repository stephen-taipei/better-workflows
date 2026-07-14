import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dw.mjs");

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function repository() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dw-cli-repo-"));
  await git(cwd, "init", "-q", "-b", "dev");
  await git(cwd, "config", "user.name", "Dynamic Workflow Tests");
  await git(cwd, "config", "user.email", "dw-tests@example.invalid");
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "value.txt"), "one\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

async function cli(cwd, stateRoot, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, DW_STATE_ROOT: stateRoot },
      maxBuffer: 8 * 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr, json: JSON.parse(result.stdout) };
  } catch (error) {
    if (!allowFailure) throw error;
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      json: error.stdout ? JSON.parse(error.stdout) : null
    };
  }
}

test("CLI creates a verified run and returns nonzero on authority drift", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "dw-cli-state-"));
  const started = await cli(cwd, stateRoot, [
    "run",
    "--template",
    "review-to-issues",
    "--mode",
    "verified",
    "--goal",
    "Review src",
    "--scope",
    "src"
  ]);
  assert.equal(started.json.ok, true);
  assert.equal(started.json.mode, "verified");
  assert.equal(typeof started.json.sentinel.counts.tracked, "number");
  assert.equal(typeof started.json.sentinel.manifest, "string");
  assert.equal("skipped" in started.json.sentinel, false);
  const runId = started.json.runId;

  const status = await cli(cwd, stateRoot, ["status", runId]);
  assert.equal(status.json.status, "running");
  assert.equal(status.json.lastSentinelVerified, true);
  assert.equal(status.json.lastSentinelComplete, true);

  const captured = await cli(cwd, stateRoot, [
    "sentinel",
    "capture",
    runId,
    "--label",
    "wave-1"
  ]);
  assert.equal(typeof captured.json.sentinel.counts.skipped, "number");
  assert.equal("skipped" in captured.json.sentinel, false);
  await writeFile(path.join(cwd, "src", "value.txt"), "two\n");
  const verification = await cli(
    cwd,
    stateRoot,
    ["sentinel", "verify", runId, "--label", "wave-1"],
    { allowFailure: true }
  );
  assert.equal(verification.code, 2);
  assert.equal(verification.json.ok, false);
  assert.ok(verification.json.changed.includes("statusDigest"));
});

test("CLI direct mode does not create durable state", async () => {
  const cwd = await repository();
  const parent = await mkdtemp(path.join(os.tmpdir(), "dw-cli-direct-"));
  const stateRoot = path.join(parent, "missing");
  const result = await cli(cwd, stateRoot, [
    "run",
    "--template",
    "ios-static-pbxproj",
    "--mode",
    "direct",
    "--goal",
    "Explain one line",
    "--scope",
    "src"
  ]);
  assert.equal(result.json.direct, true);
  await assert.rejects(access(stateRoot));
});

test("CLI lists exactly the installed workflow templates", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "dw-cli-list-"));
  const result = await cli(cwd, stateRoot, ["templates"]);
  assert.equal(result.json.templates.length, 8);
});
