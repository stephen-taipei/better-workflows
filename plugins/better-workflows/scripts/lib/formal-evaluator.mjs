import { constants as fsConstants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalGovernedGithubRepository } from "./git-observation-v1.mjs";
import { formalHostStable, parseSleepWakeCounters, parseSleepWakeUuid } from "./formal-host-power.mjs";
import { parseStrictJsonV1 } from "./strict-json-v1.mjs";
import { copyBoundedBytesV1 } from "./private-input-snapshot-v1.mjs";
import { spawnCapture } from "./process-capture.mjs";
import { formalCaptureObservation, formalCaptureSucceeded, formalSuiteCommand } from "./formal-suite-runner.mjs";

import { createFormalSuiteEnvironment } from "./formal-environment.mjs";
export { createFormalSuiteEnvironment } from "./formal-environment.mjs";

const execFileAsync = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const FORMAL_EVALUATOR_TIMEOUT_MS = 45 * 60 * 1000;
const FORMAL_EVALUATOR_CLEANUP_GRACE_MS = 5 * 1000;
const FORMAL_ATTEMPT_SCHEMA_VERSION = 1;
const FORMAL_STATE_MAX_BYTES = 2 * 1024 * 1024;
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

// Retired recipe CLI coverage remains in the owner-only source tree. A public
// projection contains only the explicitly allowed Auto suites; both source
// and projected evaluators sign the exact set they actually execute.
export function isEligibleFormalSuite(name) {
  return name.endsWith(".test.mjs") && name !== "recipes.test.mjs";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function captureFormalSuiteManifest({ repositoryRoot, scriptPath }) {
  const directory = path.join(path.dirname(scriptPath), "tests");
  const relativeDirectory = path.relative(repositoryRoot, directory);
  if (!relativeDirectory || relativeDirectory === ".." || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
    throw new Error("Formal evaluator suites must belong to the source repository");
  }
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("Formal suite directory must be physical");
  const names = (await readdir(directory)).filter(isEligibleFormalSuite).sort();
  if (names.length === 0) throw new Error("Formal evaluator found no suites");
  const files = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Formal suite must be a physical source file");
    files.push({ path: path.relative(repositoryRoot, file).split(path.sep).join("/"), sha256: sha256(await readFile(file)) });
  }
  return { files, digest: sha256(JSON.stringify(files)) };
}

function completeSuiteObservations(result, manifest, { repositoryRoot, cwd, nodePath }) {
  const report = result?.formalSuites;
  const expected = manifest.files.map((file) => file.path);
  if (result?.tests !== expected.length || report?.schemaVersion !== 1 || report.authority !== "none" ||
      JSON.stringify(report.expectedSuites) !== JSON.stringify(expected) ||
      !Array.isArray(report.observations) || report.observations.length !== expected.length) return false;
  return expected.every((file, index) => {
    const item = report.observations[index];
    const terminal = item?.terminal;
    return item?.path === file && item.status === "PASSED" && item.cwd === cwd &&
      JSON.stringify(item.command) === JSON.stringify(formalSuiteCommand(nodePath, path.join(repositoryRoot, file))) &&
      terminal?.exitStatusObserved === true && terminal.exitCode === 0 && terminal.signal === null && terminal.timedOut === false &&
      terminal.outputExceeded === false && terminal.groupTerminated === true &&
      /^[a-f0-9]{64}$/.test(terminal.stdoutSha256) && /^[a-f0-9]{64}$/.test(terminal.stderrSha256);
  });
}

// Cleanup and qualification are separate observations. Ordinary test failures
// still report every suite and its actual process-group termination; interrupted
// or incomplete reports cannot establish that all nested groups have exited.
function completeSuiteCleanupObservations(result, manifest, { repositoryRoot, cwd, nodePath }) {
  const report = result?.formalSuites;
  if (!Array.isArray(manifest?.files) || manifest.files.length < 1) return false;
  const expected = manifest.files.map((file) => file.path);
  if (![true, false].includes(result?.ok) ||
      (result.tests !== undefined && result.tests !== expected.length) ||
      report?.schemaVersion !== 1 || report.authority !== "none" ||
      JSON.stringify(report.expectedSuites) !== JSON.stringify(expected) ||
      !Array.isArray(report.observations) || report.observations.length !== expected.length) return false;
  return expected.every((file, index) => {
    const item = report.observations[index];
    const terminal = item?.terminal;
    return item?.path === file && item.cwd === cwd &&
      JSON.stringify(item.command) === JSON.stringify(formalSuiteCommand(nodePath, path.join(repositoryRoot, file))) &&
      terminal?.exitStatusObserved === true && Number.isSafeInteger(terminal.pid) && terminal.pid > 0 &&
      Number.isSafeInteger(terminal.exitCode) && terminal.exitCode >= 0 &&
      item.status === (terminal.exitCode === 0 ? "PASSED" : "FAILED") &&
      terminal.signal === null && terminal.timedOut === false && terminal.outputExceeded === false &&
      terminal.groupTerminated === true && /^[a-f0-9]{64}$/.test(terminal.stdoutSha256) && /^[a-f0-9]{64}$/.test(terminal.stderrSha256);
  });
}

function terminalReceipt(terminal, result = null) {
  if (typeof terminal?.stdout === "string" && typeof terminal?.stderr === "string") {
    return { ...formalCaptureObservation(terminal), result, stdout: terminal.stdout, stderr: terminal.stderr };
  }
  const decoded = decodeTerminalOutput(terminal);
  return decoded ? terminalReceiptFromDecoded(terminal, result, decoded) : null;
}

function decodeTerminalOutput(terminal) {
  try {
    const stdoutBytes = copyBoundedBytesV1(terminal?.stdout, { maxBytes: MAX_OUTPUT_BYTES });
    const stderrBytes = copyBoundedBytesV1(terminal?.stderr, { maxBytes: MAX_OUTPUT_BYTES });
    if (stdoutBytes.byteLength > MAX_OUTPUT_BYTES - stderrBytes.byteLength) return null;
    const stdout = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdoutBytes);
    const stderr = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stderrBytes);
    if (!Buffer.from(stdout, "utf8").equals(stdoutBytes) ||
        !Buffer.from(stderr, "utf8").equals(stderrBytes)) return null;
    return { stdoutBytes, stderrBytes, stdout, stderr };
  } catch {
    return null;
  }
}

function terminalReceiptFromDecoded(terminal, result, decoded) {
  const capturedBytes = { ...terminal, stdout: decoded.stdoutBytes, stderr: decoded.stderrBytes };
  return { ...formalCaptureObservation(capturedBytes), result, stdout: decoded.stdout, stderr: decoded.stderr };
}

const unknownFailure = () => ({ schemaVersion: 1, failureClass: "UNKNOWN", eligibleReplacementReason: null });

// Local policy observations only, never execution attestation or release
// authority. An allowlisted caller reason cannot fill missing observations.
export function classifyFormalAttemptFailure(receipt) {
  if (receipt?.schemaVersion !== 1 || receipt.status !== "blocked" || !SHA.test(receipt.expectedHead ?? "")) {
    return unknownFailure();
  }
  const post = receipt.postflight;
  const observations = receipt.terminal?.result?.formalSuites?.observations;
  const observedTestFailure = Array.isArray(observations) && observations.some((item) => {
    const terminal = item?.terminal;
    // Preserve a normal failed exit even if cancellation won the status race.
    return terminal?.exitStatusObserved === true && Number.isSafeInteger(terminal.exitCode) && terminal.exitCode > 0 &&
      terminal.signal === null && terminal.timedOut === false && terminal.outputExceeded === false;
  });
  if (observedTestFailure || post?.clean === false || post?.suitesUnchanged === false ||
      (SHA.test(post?.head ?? "") && post.head !== receipt.expectedHead)) {
    return { schemaVersion: 1, failureClass: "SOURCE_OR_TEST_FAILURE", eligibleReplacementReason: null };
  }
  const terminal = receipt.terminal;
  const before = receipt.host;
  const after = post?.host;
  const counters = ["sleepCount", "darkWakeCount", "userWakeCount"];
  // Only completed, successful suites with unchanged source can currently
  // establish host-sleep as the sole observed disqualifier. A raw signal,
  // timeout, capture exception, or dead PID does not prove that relationship.
  if ([receipt.repositoryRoot, receipt.cwd, receipt.executables?.node].every((value) =>
        typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value) &&
      Array.isArray(receipt.suiteManifest?.files) && receipt.suiteManifest.files.length > 0 &&
      Array.from(receipt.suiteManifest.files).every((file) => typeof file?.path === "string" &&
        file.path.length > 0 && !path.isAbsolute(file.path) && !file.path.includes("\0") &&
        !file.path.split("/").includes("..") && /^[a-f0-9]{64}$/.test(file.sha256 ?? "")) &&
      new Set(receipt.suiteManifest.files.map((file) => file.path)).size === receipt.suiteManifest.files.length &&
      receipt.suiteManifest.digest === sha256(JSON.stringify(receipt.suiteManifest.files)) &&
      terminal?.exitStatusObserved === true && terminal.exitCode === 0 && terminal.signal === null &&
      terminal.timedOut === false && terminal.outputExceeded === false && terminal.groupTerminated === true &&
      post?.head === receipt.expectedHead && post.clean === true && post.suitesUnchanged === true && post.completeCoverage === true &&
      post.suiteManifest?.digest === receipt.suiteManifest.digest &&
      JSON.stringify(post.suiteManifest.files) === JSON.stringify(receipt.suiteManifest.files) &&
      completeSuiteObservations(terminal.result, receipt.suiteManifest, {
        repositoryRoot: receipt.repositoryRoot, cwd: receipt.cwd, nodePath: receipt.executables.node
      }) && before?.platform === "darwin" && after?.platform === "darwin" &&
      formalHostStable(before, before) && formalHostStable(after, after) &&
      before.bootIdentity.toUpperCase() === after.bootIdentity.toUpperCase() &&
      counters.every((key) => after.sleepWakeCounters[key] >= before.sleepWakeCounters[key]) &&
      counters.some((key) => after.sleepWakeCounters[key] > before.sleepWakeCounters[key])) {
    return { schemaVersion: 1, failureClass: "INFRASTRUCTURE", eligibleReplacementReason: "host-sleep" };
  }
  return unknownFailure();
}

function serializedReceipt(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
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

export async function fixedToolPath() {
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

async function assertNoCompetingSuite(selfMarker = null) {
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
  // The evaluator is commonly launched through caffeinate or a terminal
  // wrapper. Those launcher processes can be siblings of the Node process in
  // the host process table and therefore fall outside the parent-chain
  // exclusion above. A fresh launch root is unique to this attempt; exclude
  // only command lines carrying that exact marker so a wrapper cannot report
  // itself while unrelated suites remain visible.
  const conflicts = table.filter((entry) => !excluded.has(entry.pid) &&
    !(selfMarker && entry.command.includes(selfMarker)) && isManagedLongSuite(entry.command));
  if (conflicts.length > 0) {
    throw new Error(`Formal evaluator slot is occupied by ${conflicts.map((item) => item.pid).join(",")}`);
  }
}

const BOOT_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function stableBootIdentity(value) {
  const identity = String(value ?? "").trim();
  if (!BOOT_SESSION_UUID.test(identity)) {
    throw new Error("Formal evaluator cannot parse kern.bootsessionuuid");
  }
  return identity.toUpperCase();
}

export async function hostPreflight() {
  if (process.platform !== "darwin") return { platform: process.platform };
  let bootTime;
  try {
    bootTime = String((await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" })).stdout).trim();
  } catch (error) {
    throw new Error(`Formal evaluator requires host-capable execution; kern.boottime is unavailable: ${error.message}`);
  }
  let bootSessionUuid;
  try {
    const result = await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" });
    if (String(result.stderr ?? "") !== "") {
      throw new Error("kern.bootsessionuuid emitted stderr");
    }
    bootSessionUuid = stableBootIdentity(result.stdout);
  } catch (error) {
    throw new Error(`Formal evaluator requires host-capable execution; kern.bootsessionuuid is unavailable: ${error.message}`);
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
  // SleepWakeUUID is transient: macOS can retire it after a successful wake.
  // Bind the since-boot counters as well, so an absent/retired UUID does not
  // block an awake host or hide a sleep/wake cycle during evaluation.
  const sleepWakeUuid = parseSleepWakeUuid(power);
  const statistics = String((await execFileAsync("/usr/bin/pmset", ["-g", "stats"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    env: { ...process.env, LANG: "C", LC_ALL: "C" }
  })).stdout);
  const sleepWakeCounters = parseSleepWakeCounters(statistics);
  return {
    platform: process.platform,
    bootTime,
    bootIdentity: bootSessionUuid,
    sleepWakeUuid,
    sleepWakeCounters,
    clamshell: "open",
    userActive: true
  };
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
    await handle.writeFile(serializedReceipt(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  const directory = await open(path.dirname(target), fsConstants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readJsonIfPresent(target, { withDigest = false } = {}) {
  try {
    const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > FORMAL_STATE_MAX_BYTES) {
        throw new Error(`Formal evaluator ledger is not a bounded physical file: ${target}`);
      }
      const bytes = await handle.readFile();
      const value = parseStrictJsonV1(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
        { maxBytes: FORMAL_STATE_MAX_BYTES });
      return withDigest ? { receipt: value, receiptDigest: sha256(bytes) } : value;
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
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        await handle.sync();
        const identity = await handle.stat();
        return { target, handle, identity, ownerBytes: `${process.pid}\n` };
      } catch (error) { await handle.close(); throw error; }
    } catch (error) {
      if (error.code !== "EEXIST" || attempt === 99) throw error;
      let ownerPid = null;
      let lockInfo = null;
      try {
        lockInfo = await lstat(target);
        if (!lockInfo.isFile() || lockInfo.isSymbolicLink() || lockInfo.nlink !== 1 || lockInfo.size > 512) {
          throw new Error("Formal evaluator slot ownership is unknown; explicit reconciliation is required");
        }
        const raw = (await readFile(target, "utf8")).trim();
        if (/^[1-9][0-9]{0,9}$/.test(raw)) ownerPid = Number(raw);
      } catch (readError) {
        if (readError.code === "ENOENT") continue;
        throw readError;
      }
      // JSON full-profile slots belong to an outer owner across lane gaps and
      // coordinator exit. Age or a dead PID cannot prove their nested cleanup.
      if (ownerPid === null) throw new Error("Formal evaluator non-legacy slot requires explicit reconciliation");
      let ownerAlive = false;
      if (ownerPid !== null) {
        try { process.kill(ownerPid, 0); ownerAlive = true; } catch (signalError) {
          if (signalError.code !== "ESRCH") ownerAlive = true;
        }
      }
      if (!ownerAlive) {
        // lstat/readFile/rm cannot implement atomic compare-and-unlink. Two
        // reclaimers could delete a newly acquired full-profile slot between
        // those operations. Admission never unlinks a slot it did not create.
        throw new Error("Formal evaluator stale legacy slot requires explicit reconciliation; refusing automatic reclamation");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Formal evaluator global slot could not be acquired");
}

async function releaseGlobalSlot(slot) {
  try {
    const current = await lstat(slot.target);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
        current.ino !== slot.identity.ino || current.dev !== slot.identity.dev || current.size !== Buffer.byteLength(slot.ownerBytes) ||
        await readFile(slot.target, "utf8") !== slot.ownerBytes) {
      throw new Error("Formal evaluator slot ownership changed; refusing release");
    }
    await rm(slot.target);
  } finally { await slot.handle.close(); }
}

async function formalAttemptLedger(cwd, gitPath, pathValue, expectedHead) {
  let identity;
  const remotes = (await git(cwd, gitPath, pathValue, ["remote"])).split(/\r?\n/).filter(Boolean);
  if (remotes.includes("origin")) {
    const origin = await git(cwd, gitPath, pathValue, ["remote", "get-url", "origin"]);
    const governedRepository = canonicalGovernedGithubRepository(origin);
    identity = governedRepository
      ? `github:${governedRepository}`
      : `origin-digest:${sha256(origin)}`;
  } else {
    const common = await git(cwd, gitPath, pathValue, ["rev-parse", "--git-common-dir"]);
    identity = `common:${await realpath(path.resolve(cwd, common))}`;
  }
  const stateRoot = path.join(await realpath(os.homedir()), ".better-workflows");
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
  requireLegacyAttemptRecovery(running);
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
        },
        failureClassification: unknownFailure()
      });
    }
  }
  await atomicReceipt(ledgerPath, ledger);
}

function requireLegacyAttemptRecovery(attempt) {
  if (["profileId", "outerOwnerPid", "operationNonce", "phase"].some((key) => Object.hasOwn(attempt, key))) {
    throw new Error("Formal evaluator outer-owned or unknown-profile attempt requires full reconciliation");
  }
}

export function reconcileInterruptedFormalAttempt(attempts, { alive, finishedAt }) {
  if (!Array.isArray(attempts)) throw new Error("Formal evaluator attempt history is invalid");
  const running = attempts.find((attempt) => attempt?.status === "running");
  if (!running) return { changed: false };
  requireLegacyAttemptRecovery(running);
  if (alive) throw new Error("Formal evaluator already has an in-progress attempt for this exact SHA");
  if (!Number.isFinite(Date.parse(finishedAt ?? ""))) throw new Error("Formal evaluator recovery requires a terminal timestamp");
  running.status = "blocked";
  running.finishedAt = finishedAt;
  running.blockReason = "recovered-unconfirmed-termination";
  running.failureClassification = unknownFailure();
  delete running.terminalReceiptDigest;
  return { changed: true, attempt: running };
}

export function evaluateFormalAttemptBudget(attempts, replacementReason = null) {
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

export function evaluateFormalAttemptPolicy(attempts, replacementReason = null, predecessor = null) {
  const policy = evaluateFormalAttemptBudget(attempts, replacementReason);
  if (attempts.length === 1) {
    const attempt = attempts[0];
    const receipt = predecessor?.receipt;
    if (attempt?.status !== "blocked" || !SHA.test(predecessor?.expectedHead ?? "") ||
        !SHA.test(predecessor?.expectedBase ?? "") || receipt?.schemaVersion !== 1 || receipt.status !== "blocked" ||
        receipt.expectedHead !== predecessor.expectedHead || receipt.expectedBase !== predecessor.expectedBase ||
        receipt.formalAttemptScope !== "local-repository-head" || receipt.formalAttemptNumber !== 1 ||
        receipt.formalAttemptId !== attempt.attemptId ||
        attempt.attemptId !== `formal-${sha256(`${receipt.expectedHead}\0${attempt.launchRoot}`).slice(0, 24)}` ||
        receipt.paths?.parent?.path !== attempt.launchRoot ||
        attempt.receiptPath !== path.join(attempt.launchRoot, "receipt.json") ||
        receipt.startedAt !== attempt.startedAt || receipt.finishedAt !== attempt.finishedAt ||
        receipt.replacementReason !== null || attempt.replacementReason !== null ||
        !/^[a-f0-9]{64}$/.test(attempt.terminalReceiptDigest ?? "") ||
        attempt.terminalReceiptDigest !== predecessor.receiptDigest) {
      throw new Error("Formal evaluator replacement requires verified predecessor receipt bindings; legacy or missing evidence remains UNKNOWN");
    }
    const classification = classifyFormalAttemptFailure(receipt);
    if (JSON.stringify(classification) !== JSON.stringify(receipt.failureClassification) ||
        JSON.stringify(classification) !== JSON.stringify(attempt.failureClassification)) {
      throw new Error("Formal evaluator predecessor failure classification does not match its observations");
    }
    if (classification.failureClass !== "INFRASTRUCTURE" || classification.eligibleReplacementReason !== replacementReason) {
      throw new Error(`Formal evaluator predecessor does not prove ${replacementReason}; failure class is ${classification.failureClass}`);
    }
  }
  return policy;
}

async function prepareFormalAttempt({ cwd, gitPath, pathValue, expectedHead, expectedBase, launchRoot, replacementReason, processMarker }) {
  const ledgerPath = await formalAttemptLedger(cwd, gitPath, pathValue, expectedHead);
  const existing = await readJsonIfPresent(ledgerPath);
  const ledger = existing
    ? validateAttemptLedger(existing, expectedHead)
    : { schemaVersion: FORMAL_ATTEMPT_SCHEMA_VERSION, head: expectedHead, attempts: [] };
  await recoverInterruptedAttempt(ledgerPath, ledger);
  const previous = ledger.attempts.length === 1 && ledger.attempts[0].status === "blocked" ? ledger.attempts[0] : null;
  const predecessor = previous?.receiptPath && REPLACEMENT_REASONS.has(replacementReason)
    ? await readJsonIfPresent(previous.receiptPath, { withDigest: true }) : null;
  const policy = evaluateFormalAttemptPolicy(ledger.attempts, replacementReason,
    predecessor ? { ...predecessor, expectedHead, expectedBase } : null);
  return {
    ledgerPath,
    ledger,
    attemptNumber: policy.attemptNumber,
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

async function finishFormalAttempt(context, receipt, receiptPath) {
  receipt.failureClassification = receipt.status === "blocked" ? classifyFormalAttemptFailure(receipt) : null;
  await atomicReceipt(receiptPath, receipt);
  context.attempt.status = receipt.status;
  context.attempt.finishedAt = receipt.finishedAt;
  context.attempt.receiptPath = receiptPath;
  context.attempt.failureClassification = receipt.failureClassification;
  context.attempt.terminalReceiptDigest = sha256(serializedReceipt(receipt));
  await atomicReceipt(context.ledgerPath, context.ledger);
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
  const pathValue = await fixedToolPath();
  const gitPath = await locateExecutable("git", pathValue);
  const ghPath = await locateExecutable("gh", pathValue);
  const head = await git(canonicalCwd, gitPath, pathValue, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head !== expectedHead) throw new Error(`Formal evaluator HEAD mismatch: ${head}`);
  const statusOutput = await git(canonicalCwd, gitPath, pathValue, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"]);
  if (statusOutput) throw new Error("Formal evaluator requires a clean committed tree");
  await git(canonicalCwd, gitPath, pathValue, ["merge-base", "--is-ancestor", expectedBase, expectedHead]);
  const repositoryRoot = await realpath(await git(canonicalCwd, gitPath, pathValue, ["rev-parse", "--show-toplevel"]));
  const suiteManifest = await captureFormalSuiteManifest({ repositoryRoot, scriptPath: canonicalScript });
  await assertNoCompetingSuite(launchRoot);
  const host = await hostPreflight();
  const command = "/usr/bin/caffeinate";
  if (!(await executable(command))) throw new Error("Formal evaluator requires /usr/bin/caffeinate");
  const attemptContext = await prepareFormalAttempt({
    cwd: canonicalCwd,
    gitPath,
    pathValue,
    expectedHead,
    expectedBase,
    launchRoot,
    replacementReason,
    processMarker: canonicalScript
  });
  const parent = await physicalDirectory(launchRoot);
  const state = await physicalDirectory(path.join(launchRoot, "state"));
  const npmCache = await physicalDirectory(path.join(launchRoot, "npm-cache"));
  const temporary = await physicalDirectory(path.join(launchRoot, "tmp"));
  const suiteEnv = createFormalSuiteEnvironment(pathValue, {
    TMPDIR: temporary.path,
    NPM_CONFIG_CACHE: npmCache.path,
    SBW_STATE_ROOT: state.path
  });
  const environmentPolicy = {
    id: "formal-minimal-v1",
    digest: sha256(JSON.stringify(suiteEnv)),
    variables: Object.keys(suiteEnv).sort()
  };
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
    startedAt: attemptContext.attempt.startedAt,
    expectedHead,
    expectedBase,
    formalAttemptId: attemptContext.attempt.attemptId,
    formalAttemptNumber: attemptContext.attemptNumber,
    replacementReason: attemptContext.attempt.replacementReason,
    formalAttemptScope: "local-repository-head",
    authentication: { status: "unsigned-local-observation", releaseEligible: false },
    suiteManifest,
    repositoryRoot,
    cwd: canonicalCwd,
    command: [command, ...envArguments],
    executables: { node: canonicalNode, git: gitPath, gh: ghPath, caffeinate: command },
    paths: { parent, state, npmCache, temporary },
    environment: environmentPolicy,
    host
  };
  await atomicReceipt(receiptPath, started);
  await reserveFormalAttempt(attemptContext);
  let terminal;
  try {
    terminal = await spawnCapture(command, envArguments, {
      cwd: canonicalCwd,
      env: suiteEnv,
      timeoutMs: FORMAL_EVALUATOR_TIMEOUT_MS,
      cleanupGraceMs: FORMAL_EVALUATOR_CLEANUP_GRACE_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      encoding: null,
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
      launchError: error.message,
      terminal: error.execution ? terminalReceipt(error.execution) : null
    };
    await finishFormalAttempt(attemptContext, blockedReceipt, receiptPath);
    throw error;
  }
  try {
    const decodedTerminal = decodeTerminalOutput(terminal);
    let result = null;
    if (decodedTerminal) {
      try { result = parseStrictJsonV1(decodedTerminal.stdout, { maxBytes: MAX_OUTPUT_BYTES }); } catch {
        // The CLI emits failures on stderr; retain their suite observations too.
        try {
          const failure = parseStrictJsonV1(decodedTerminal.stderr, { maxBytes: MAX_OUTPUT_BYTES });
          if (failure?.ok === false) result = failure;
        } catch { /* receipt retains raw diagnostics */ }
      }
    }
    const postHead = await git(canonicalCwd, gitPath, pathValue, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const postStatus = await git(canonicalCwd, gitPath, pathValue, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"]);
    await assertNoCompetingSuite(launchRoot);
    const postHost = await hostPreflight();
    const stableHost = formalHostStable(host, postHost);
    const postSuiteManifest = await captureFormalSuiteManifest({ repositoryRoot, scriptPath: canonicalScript });
    const suitesUnchanged = postSuiteManifest.digest === suiteManifest.digest;
    const completeCoverage = completeSuiteObservations(result, suiteManifest, { repositoryRoot, cwd: canonicalCwd, nodePath: canonicalNode });
    const passed = decodedTerminal !== null && formalCaptureSucceeded(terminal) && result?.ok === true && postHead === expectedHead && !postStatus &&
      stableHost && suitesUnchanged && completeCoverage;
    const finalReceipt = {
      ...started,
      status: passed ? "passed" : "blocked",
      finishedAt: new Date().toISOString(),
      terminal: decodedTerminal ? terminalReceiptFromDecoded(terminal, result, decodedTerminal) : null,
      postflight: {
        head: postHead,
        clean: postStatus.length === 0,
        host: postHost,
        suiteManifest: postSuiteManifest,
        suitesUnchanged,
        completeCoverage
      }
    };
    await finishFormalAttempt(attemptContext, finalReceipt, receiptPath);
    if (postHead !== expectedHead || postStatus) throw new Error("Formal evaluator changed the exact source tree");
    if (!stableHost) {
      throw new Error("Formal evaluator host boot or sleep/wake identity changed during execution");
    }
    if (!suitesUnchanged) throw new Error("Formal evaluator suite source closure changed during execution");
    if (!decodedTerminal || !formalCaptureSucceeded(terminal) || result?.ok !== true || !completeCoverage) {
      const error = new Error(!decodedTerminal
        ? "Formal evaluator terminal output is not lossless UTF-8"
        : result?.error ?? (!formalCaptureSucceeded(terminal)
          ? "Formal evaluator capture exit, bounds, or cleanup did not pass"
          : "Formal evaluator child coverage metadata is missing or incomplete"));
      error.exitCode = Number.isSafeInteger(terminal.code) && terminal.code > 0 ? terminal.code : 1;
      throw error;
    }
    return { ...result, formal: true, receipt: receiptPath, paths: finalReceipt.paths };
  } catch (error) {
    if (!attemptContext.attempt.finishedAt) {
      const blockedReceipt = {
        ...started,
        status: "blocked",
        finishedAt: new Date().toISOString(),
        terminal: terminalReceipt(terminal),
        postflightError: error.message
      };
      await finishFormalAttempt(attemptContext, blockedReceipt, receiptPath);
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

// Internal storage/observation primitives shared by the supervised full
// protocol. They confer no execution, signing, or publication authority.
export const formalEvaluatorState = Object.freeze({
  atomicReceipt, readJsonIfPresent, serializedReceipt, completeSuiteObservations, completeSuiteCleanupObservations,
  maxBytes: FORMAL_STATE_MAX_BYTES, maxOutputBytes: MAX_OUTPUT_BYTES,
  locateExecutable, physicalDirectory, terminalReceipt, validateAttemptLedger, parseProcessTable, isManagedLongSuite
});
