import { constants as fsConstants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalGovernedGithubRepository } from "./autonomy-snapshot.mjs";

const execFileAsync = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const FORMAL_ATTEMPT_SCHEMA_VERSION = 1;
const REPLACEMENT_REASONS = new Set([
  "host-sleep",
  "sandbox-host-capability",
  "launch-environment",
  "command-interruption"
]);
const FIXED_PATH_CANDIDATES = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin"
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(target) {
  try { await lstat(target); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function executable(target) {
  try { await access(target, fsConstants.X_OK); return true; } catch { return false; }
}

async function fixedPath() {
  const available = [];
  for (const directory of FIXED_PATH_CANDIDATES) {
    if (await exists(directory)) available.push(directory);
  }
  return available.join(path.delimiter);
}

async function locateExecutable(name, pathValue) {
  for (const directory of pathValue.split(path.delimiter)) {
    const candidate = path.join(directory, name);
    if (await executable(candidate)) return realpath(candidate);
  }
  throw new Error(`Formal evaluator requires executable ${name} in the fixed PATH`);
}

async function git(cwd, executablePath, pathValue, args) {
  const result = await execFileAsync(executablePath, args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: pathValue,
      HOME: "/var/empty",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0"
    },
    maxBuffer: 8 * 1024 * 1024
  });
  return String(result.stdout ?? "").trim();
}

function parseProcessTable(output) {
  return String(output).split("\n").map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

function isManagedLongSuite(command) {
  if (/plugins\/better-workflows\/scripts\/sbw\.mjs\s+eval\b/.test(command)) {
    return true;
  }
  return /node(?:\s+\S+)*\s+--test\b.*(?:core|control-plane-v2|recipes|publication|release-policy-receipt|release-tag)\.test\.mjs\b/.test(command);
}

async function assertNoCompetingSuite() {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  const table = parseProcessTable(stdout);
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const excluded = new Set([process.pid]);
  let cursor = byPid.get(process.pid)?.ppid;
  while (cursor && !excluded.has(cursor)) {
    excluded.add(cursor);
    cursor = byPid.get(cursor)?.ppid;
  }
  const conflicts = table.filter((entry) => !excluded.has(entry.pid) && isManagedLongSuite(entry.command));
  if (conflicts.length > 0) {
    throw new Error(`Formal evaluator slot is occupied by ${conflicts.map((item) => item.pid).join(",")}`);
  }
}

async function hostPreflight() {
  if (process.platform !== "darwin") return { platform: process.platform };
  let bootTime;
  try {
    bootTime = String((await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" })).stdout).trim();
  } catch (error) {
    throw new Error(`Formal evaluator requires host-capable execution; kern.boottime is unavailable: ${error.message}`);
  }
  const ioreg = String((await execFileAsync("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-k", "IOPMUserIsActive"], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024
  })).stdout);
  if (!ioreg.includes('"AppleClamshellState" = No')) throw new Error("Formal evaluator requires an open Mac lid");
  if (!ioreg.includes('"IOPMUserIsActive" = Yes')) throw new Error("Formal evaluator requires an active user session");
  const power = String((await execFileAsync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPMrootDomain"], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024
  })).stdout);
  const sleepWakeUuid = /"SleepWakeUUID"\s*=\s*"([^"]+)"/.exec(power)?.[1] ?? null;
  if (!sleepWakeUuid) throw new Error("Formal evaluator cannot bind the current SleepWakeUUID");
  return { platform: process.platform, bootTime, sleepWakeUuid, clamshell: "open", userActive: true };
}

async function physicalDirectory(target, mode = 0o700) {
  await mkdir(target, { mode });
  await chmod(target, mode);
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Formal evaluator path is not a physical directory: ${target}`);
  return { path: target, inode: info.ino, device: info.dev, mode: info.mode & 0o777 };
}

async function atomicReceipt(target, value) {
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  const directory = await open(path.dirname(target), fsConstants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readJsonIfPresent(target) {
  try {
    const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024) {
        throw new Error(`Formal evaluator ledger is not a bounded physical file: ${target}`);
      }
      return JSON.parse(await handle.readFile("utf8"));
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function acquireGlobalSlot() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "host";
  const target = path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), `bw-formal-evaluator-${uid}.lock`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = await open(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.sync();
      return { target, handle };
    } catch (error) {
      if (error.code !== "EEXIST" || attempt === 99) throw error;
      let ownerPid = null;
      let lockInfo = null;
      try {
        lockInfo = await lstat(target);
        const raw = (await readFile(target, "utf8")).trim();
        if (/^[1-9][0-9]{0,9}$/.test(raw)) ownerPid = Number(raw);
      } catch (readError) {
        if (readError.code === "ENOENT") continue;
        throw readError;
      }
      let ownerAlive = false;
      if (ownerPid !== null) {
        try { process.kill(ownerPid, 0); ownerAlive = true; } catch (signalError) {
          if (signalError.code !== "ESRCH") ownerAlive = true;
        }
      }
      if (!ownerAlive && (ownerPid !== null || Date.now() - lockInfo.mtimeMs > 5000)) {
        const current = await lstat(target).catch(() => null);
        if (current && current.ino === lockInfo.ino && current.dev === lockInfo.dev) {
          await rm(target, { force: true });
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Formal evaluator global slot could not be acquired");
}

async function releaseGlobalSlot(slot) {
  await slot.handle.close().catch(() => undefined);
  await rm(slot.target, { force: true }).catch(() => undefined);
}

async function formalAttemptLedger(cwd, gitPath, pathValue, expectedHead) {
  let identity;
  try {
    const origin = await git(cwd, gitPath, pathValue, ["remote", "get-url", "origin"]);
    const governedRepository = canonicalGovernedGithubRepository(origin);
    identity = governedRepository
      ? `github:${governedRepository}`
      : `origin-digest:${sha256(origin)}`;
  } catch {
    const common = await git(cwd, gitPath, pathValue, ["rev-parse", "--git-common-dir"]);
    identity = `common:${await realpath(path.resolve(cwd, common))}`;
  }
  const stateRoot = path.join(os.homedir(), ".better-workflows");
  const directory = path.join(stateRoot, "formal-evaluations", sha256(identity));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Formal evaluator attempt ledger directory is unsafe");
  return path.join(directory, `${expectedHead}.json`);
}

function validateAttemptLedger(value, expectedHead) {
  if (
    !value || value.schemaVersion !== FORMAL_ATTEMPT_SCHEMA_VERSION ||
    value.head !== expectedHead || !Array.isArray(value.attempts) || value.attempts.length > 2
  ) throw new Error("Formal evaluator attempt ledger is invalid");
  for (const attempt of value.attempts) {
    if (
      !attempt || !["running", "passed", "blocked"].includes(attempt.status) ||
      typeof attempt.attemptId !== "string" || !path.isAbsolute(attempt.launchRoot) ||
      (attempt.evaluatorPid !== undefined && (!Number.isInteger(attempt.evaluatorPid) || attempt.evaluatorPid <= 0)) ||
      (attempt.processMarker !== undefined && !path.isAbsolute(attempt.processMarker)) ||
      (attempt.receiptPath !== undefined && attempt.receiptPath !== path.join(attempt.launchRoot, "receipt.json"))
    ) throw new Error("Formal evaluator attempt ledger entry is invalid");
  }
  return value;
}

async function attemptProcessAlive(attempt) {
  if (!Number.isInteger(attempt.evaluatorPid) || attempt.evaluatorPid <= 0) return false;
  try {
    process.kill(attempt.evaluatorPid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code !== "EPERM") throw error;
  }
  try {
    const result = await execFileAsync("/bin/ps", ["-p", String(attempt.evaluatorPid), "-o", "command="], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    const command = String(result.stdout ?? "");
    if (!command.trim()) return false;
    return typeof attempt.processMarker !== "string" || (
      command.includes(attempt.processMarker) && command.includes("--formal-child")
    );
  } catch (error) {
    if (error.code === 1) return false;
    // If process inspection is unavailable but signal probing proved that the
    // PID exists, fail closed rather than treating an active evaluator as dead.
    return true;
  }
}

async function recoverInterruptedAttempt(ledgerPath, ledger) {
  const running = ledger.attempts.find((attempt) => attempt.status === "running");
  if (!running) return;
  const alive = await attemptProcessAlive(running);
  reconcileInterruptedFormalAttempt(ledger.attempts, {
    alive,
    finishedAt: new Date().toISOString()
  });
  if (running.receiptPath) {
    const receipt = await readJsonIfPresent(running.receiptPath);
    if (receipt?.status === "running") {
      await atomicReceipt(running.receiptPath, {
        ...receipt,
        status: "blocked",
        finishedAt: running.finishedAt,
        recovery: {
          reason: running.blockReason,
          evaluatorPid: running.evaluatorPid ?? null
        }
      });
    }
  }
  await atomicReceipt(ledgerPath, ledger);
}

export function reconcileInterruptedFormalAttempt(attempts, { alive, finishedAt }) {
  if (!Array.isArray(attempts)) throw new Error("Formal evaluator attempt history is invalid");
  const running = attempts.find((attempt) => attempt?.status === "running");
  if (!running) return { changed: false };
  if (alive) throw new Error("Formal evaluator already has an in-progress attempt for this exact SHA");
  if (!Number.isFinite(Date.parse(finishedAt ?? ""))) throw new Error("Formal evaluator recovery requires a terminal timestamp");
  running.status = "blocked";
  running.finishedAt = finishedAt;
  running.blockReason = "recovered-command-interruption";
  return { changed: true, attempt: running };
}

export function evaluateFormalAttemptPolicy(attempts, replacementReason = null) {
  if (!Array.isArray(attempts) || attempts.length > 2) throw new Error("Formal evaluator attempt history is invalid");
  if (attempts.some((attempt) => attempt?.status === "passed")) {
    throw new Error("Formal evaluator already has a terminal PASS for this exact SHA");
  }
  if (attempts.some((attempt) => attempt?.status === "running")) {
    throw new Error("Formal evaluator already has an in-progress attempt for this exact SHA");
  }
  if (attempts.length === 0 && replacementReason) {
    throw new Error("Formal evaluator primary attempt cannot declare a replacement reason");
  }
  if (attempts.length === 1 && !REPLACEMENT_REASONS.has(String(replacementReason ?? ""))) {
    throw new Error("Formal evaluator replacement requires one approved infrastructure reason");
  }
  if (attempts.length >= 2) {
    throw new Error("Formal evaluator exact-SHA attempt budget exhausted; create a repaired SHA instead of a third attempt");
  }
  return { attemptNumber: attempts.length + 1, replacement: attempts.length === 1 };
}

async function prepareFormalAttempt({ cwd, gitPath, pathValue, expectedHead, launchRoot, replacementReason, processMarker }) {
  const ledgerPath = await formalAttemptLedger(cwd, gitPath, pathValue, expectedHead);
  const existing = await readJsonIfPresent(ledgerPath);
  const ledger = existing
    ? validateAttemptLedger(existing, expectedHead)
    : { schemaVersion: FORMAL_ATTEMPT_SCHEMA_VERSION, head: expectedHead, attempts: [] };
  await recoverInterruptedAttempt(ledgerPath, ledger);
  evaluateFormalAttemptPolicy(ledger.attempts, replacementReason);
  return {
    ledgerPath,
    ledger,
    attempt: {
      attemptId: `formal-${sha256(`${expectedHead}\0${launchRoot}`).slice(0, 24)}`,
      launchRoot,
      receiptPath: path.join(launchRoot, "receipt.json"),
      processMarker,
      replacementReason: replacementReason || null,
      status: "running",
      startedAt: new Date().toISOString()
    }
  };
}

async function reserveFormalAttempt(context) {
  context.ledger.attempts.push(context.attempt);
  await atomicReceipt(context.ledgerPath, context.ledger);
}

async function finishFormalAttempt(context, status, receiptPath) {
  context.attempt.status = status;
  context.attempt.finishedAt = new Date().toISOString();
  context.attempt.receiptPath = receiptPath;
  await atomicReceipt(context.ledgerPath, context.ledger);
}

function spawnCapture(command, args, options) {
  return new Promise((resolve, reject) => {
    const { onSpawn, ...spawnOptions } = options;
    const child = spawn(command, args, {
      ...spawnOptions,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let total = 0;
    let settled = false;
    const terminateGroup = (signal) => {
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch { /* the child may already be terminal */ }
    };
    const forwardTerm = () => terminateGroup("SIGTERM");
    const forwardInt = () => terminateGroup("SIGINT");
    const cleanup = () => {
      process.off("SIGTERM", forwardTerm);
      process.off("SIGINT", forwardInt);
    };
    process.once("SIGTERM", forwardTerm);
    process.once("SIGINT", forwardInt);
    const ready = Promise.resolve().then(() => onSpawn?.(child)).catch((error) => {
      terminateGroup("SIGTERM");
      throw error;
    });
    const capture = (target) => (chunk) => {
      total += chunk.length;
      if (total > MAX_OUTPUT_BYTES) {
        terminateGroup("SIGTERM");
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("Formal evaluator output exceeded the bounded limit"));
        }
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", async (error) => {
      try { await ready; } catch (readyError) { error = readyError; }
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
    child.once("close", async (code, signal) => {
      try {
        await ready;
        if (!settled) {
          settled = true;
          cleanup();
          resolve({
            pid: child.pid,
            code,
            signal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8")
          });
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      }
    });
  });
}

async function runFormalEvaluatorLocked({
  cwd,
  scriptPath,
  nodePath = process.execPath,
  expectedHead,
  expectedBase,
  launchRoot,
  replacementReason = null
}) {
  if (!SHA.test(String(expectedHead ?? "")) || !SHA.test(String(expectedBase ?? ""))) {
    throw new Error("Formal evaluator requires exact 40-character HEAD and BASE revisions");
  }
  const canonicalCwd = await realpath(path.resolve(cwd));
  const canonicalScript = await realpath(path.resolve(scriptPath));
  const canonicalNode = await realpath(path.resolve(nodePath));
  if (!path.isAbsolute(launchRoot) || path.resolve(launchRoot) !== launchRoot || !/^\/private\/tmp\/bw-[A-Za-z0-9._-]+-formal-eval-[A-Za-z0-9._-]+$/.test(launchRoot)) {
    throw new Error("Formal evaluator launch root must be a canonical /private/tmp/bw-*-formal-eval-* path");
  }
  if (await exists(launchRoot)) throw new Error("Formal evaluator launch root already exists; never reuse an attempt path");
  const pathValue = await fixedPath();
  const gitPath = await locateExecutable("git", pathValue);
  const ghPath = await locateExecutable("gh", pathValue);
  const head = await git(canonicalCwd, gitPath, pathValue, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head !== expectedHead) throw new Error(`Formal evaluator HEAD mismatch: ${head}`);
  const statusOutput = await git(canonicalCwd, gitPath, pathValue, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"]);
  if (statusOutput) throw new Error("Formal evaluator requires a clean committed tree");
  await git(canonicalCwd, gitPath, pathValue, ["merge-base", "--is-ancestor", expectedBase, expectedHead]);
  await assertNoCompetingSuite();
  const host = await hostPreflight();
  const command = "/usr/bin/caffeinate";
  if (!(await executable(command))) throw new Error("Formal evaluator requires /usr/bin/caffeinate");
  const attemptContext = await prepareFormalAttempt({
    cwd: canonicalCwd,
    gitPath,
    pathValue,
    expectedHead,
    launchRoot,
    replacementReason,
    processMarker: canonicalScript
  });
  const parent = await physicalDirectory(launchRoot);
  const state = await physicalDirectory(path.join(launchRoot, "state"));
  const npmCache = await physicalDirectory(path.join(launchRoot, "npm-cache"));
  const temporary = await physicalDirectory(path.join(launchRoot, "tmp"));
  const receiptPath = path.join(launchRoot, "receipt.json");
  const envArguments = [
    "-dimsu",
    "/usr/bin/env",
    `PATH=${pathValue}`,
    `SBW_STATE_ROOT=${state.path}`,
    `NPM_CONFIG_CACHE=${npmCache.path}`,
    `TMPDIR=${temporary.path}`,
    "GIT_OPTIONAL_LOCKS=0",
    canonicalNode,
    canonicalScript,
    "eval",
    "--formal-child"
  ];
  const started = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    expectedHead,
    expectedBase,
    cwd: canonicalCwd,
    command: [command, ...envArguments],
    executables: { node: canonicalNode, git: gitPath, gh: ghPath, caffeinate: command },
    paths: { parent, state, npmCache, temporary },
    host
  };
  await atomicReceipt(receiptPath, started);
  await reserveFormalAttempt(attemptContext);
  let terminal;
  try {
    terminal = await spawnCapture(command, envArguments, {
      cwd: canonicalCwd,
      env: process.env,
      onSpawn: async (child) => {
        attemptContext.attempt.evaluatorPid = child.pid;
        started.evaluatorPid = child.pid;
        await atomicReceipt(receiptPath, started);
        await atomicReceipt(attemptContext.ledgerPath, attemptContext.ledger);
      }
    });
  } catch (error) {
    const blockedReceipt = {
      ...started,
      status: "blocked",
      finishedAt: new Date().toISOString(),
      launchError: error.message
    };
    await atomicReceipt(receiptPath, blockedReceipt);
    await finishFormalAttempt(attemptContext, "blocked", receiptPath);
    throw error;
  }
  try {
    let result = null;
    try { result = JSON.parse(terminal.stdout.trim()); } catch { /* receipt retains raw diagnostics */ }
    const postHead = await git(canonicalCwd, gitPath, pathValue, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const postStatus = await git(canonicalCwd, gitPath, pathValue, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"]);
    await assertNoCompetingSuite();
    const postHost = await hostPreflight();
    const stableHost = host.bootTime === postHost.bootTime && host.sleepWakeUuid === postHost.sleepWakeUuid;
    const passed = terminal.code === 0 && result?.ok === true && postHead === expectedHead && !postStatus && stableHost;
    const finalReceipt = {
      ...started,
      status: passed ? "passed" : "blocked",
      finishedAt: new Date().toISOString(),
      terminal: {
        pid: terminal.pid,
        exitCode: terminal.code,
        signal: terminal.signal,
        result,
        stdout: terminal.stdout,
        stderr: terminal.stderr
      },
      postflight: {
        head: postHead,
        clean: postStatus.length === 0,
        host: postHost
      }
    };
    await atomicReceipt(receiptPath, finalReceipt);
    await finishFormalAttempt(attemptContext, passed ? "passed" : "blocked", receiptPath);
    if (postHead !== expectedHead || postStatus) throw new Error("Formal evaluator changed the exact source tree");
    if (!stableHost) {
      throw new Error("Formal evaluator host boot or sleep/wake identity changed during execution");
    }
    if (terminal.code !== 0 || result?.ok !== true) {
      const error = new Error(result?.error ?? `Formal evaluator exited ${terminal.code ?? terminal.signal ?? "unknown"}`);
      error.exitCode = terminal.code ?? 1;
      throw error;
    }
    return { ...result, formal: true, receipt: receiptPath, paths: finalReceipt.paths };
  } catch (error) {
    if (!attemptContext.attempt.finishedAt) {
      const blockedReceipt = {
        ...started,
        status: "blocked",
        finishedAt: new Date().toISOString(),
        terminal: {
          pid: terminal.pid,
          exitCode: terminal.code,
          signal: terminal.signal,
          stdout: terminal.stdout,
          stderr: terminal.stderr
        },
        postflightError: error.message
      };
      await atomicReceipt(receiptPath, blockedReceipt).catch(() => undefined);
      await finishFormalAttempt(attemptContext, "blocked", receiptPath);
    }
    throw error;
  }
}

export async function runFormalEvaluator(options) {
  const slot = await acquireGlobalSlot();
  try {
    return await runFormalEvaluatorLocked(options);
  } finally {
    await releaseGlobalSlot(slot);
  }
}
