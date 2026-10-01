import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { digestObject, sha256 } from "./core.mjs";

export const OFFLINE_TRY_SCHEMA_VERSION = 1;
export const OFFLINE_TRY_KIND = "OfflineSbwTryReceiptV1";
export const OFFLINE_TRY_MAX_MS = 90_000;

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(SCRIPT_DIRECTORY, "..", "sbw.mjs");
const SOURCE_PLUGIN_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");
const CHILD_STOP_RESERVE_MS = 500;
const CHILD_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SUPERVISOR_CLEANUP_GRACE_MS = 150;
const NON_CANCELLABLE_FILE_OPERATIONS = Object.freeze([
  "cp", "mkdir", "writeFile", "readFile", "lstat", "rm"
]);
const PLAN_ID = "offline-sbw-try-plan";
const TEMPLATE_ID = "auto";
const PLAN_GOAL = "Bounded offline free-core verification";

class OfflineTryError extends Error {
  constructor(message, code = "OFFLINE_TRY_FAILED") {
    super(message);
    this.name = "OfflineTryError";
    this.code = code;
  }
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function requireBudget(deadline, operation) {
  if (remainingMs(deadline) <= 0) {
    throw new OfflineTryError(`Offline smoke deadline expired before ${operation}`, "OFFLINE_TRY_DEADLINE_EXCEEDED");
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function collectOutput(state, chunk) {
  const bytes = Buffer.from(chunk);
  if (state.bytes >= CHILD_MAX_OUTPUT_BYTES) {
    state.truncated = true;
    return;
  }
  const remaining = CHILD_MAX_OUTPUT_BYTES - state.bytes;
  state.chunks.push(bytes.subarray(0, remaining));
  state.bytes += Math.min(bytes.byteLength, remaining);
  if (bytes.byteLength > remaining) state.truncated = true;
}

const OWNED_SUPERVISOR_SOURCE = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const targetCommand = process.argv[1];
const targetArgs = JSON.parse(process.argv[2]);
const cleanupGraceMs = Math.max(1, Number(process.argv[3]) || 150);
let target = null;
let targetExit = null;
let cleanupStarted = false;
let cleanupTimer = null;

function emit(event) {
  try {
    fs.writeSync(3, JSON.stringify({ schemaVersion: 1, ownerPid: process.pid, event, platform: process.platform }) + "\n");
  } catch {}
}

function signalTarget(signal) {
  if (!target || target.exitCode !== null) return false;
  try {
    target.kill(signal);
    return true;
  } catch (error) {
    return error && error.code === "ESRCH" ? false : false;
  }
}

function signalOwnedGroup(signal) {
  if (process.platform === "win32") return false;
  try {
    process.kill(-process.pid, signal);
    return true;
  } catch (error) {
    return error && error.code === "ESRCH" ? false : false;
  }
}

function beginCleanup(reason) {
  if (cleanupStarted) return;
  cleanupStarted = true;
  emit({ type: "cleanup-started", reason });
  const targetTermRequested = signalTarget("SIGTERM");
  emit({ type: "target-term-requested", requested: targetTermRequested });
  const groupTermRequested = process.platform !== "win32" && signalOwnedGroup("SIGTERM");
  emit({ type: "group-term-requested", requested: groupTermRequested });
  cleanupTimer = setTimeout(() => {
    const groupKillEligible = process.platform !== "win32";
    // The group leader is killed by this operation, so emit the requested
    // signal synchronously before making the final group call. The parent
    // also requires the supervisor close with SIGKILL before calling this
    // cleanup verified.
    emit({ type: "group-kill-requested", requested: groupKillEligible });
    const groupKillRequested = groupKillEligible && signalOwnedGroup("SIGKILL");
    if (process.platform === "win32") {
      const directKillRequested = signalTarget("SIGKILL");
      emit({ type: "windows-direct-kill-requested", requested: directKillRequested });
      emit({ type: "cleanup-complete", verified: false });
      process.exit(0);
    }
  }, cleanupGraceMs);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
  process.on(signal, () => beginCleanup("signal:" + signal));
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const command of String(chunk).split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    if (command === "finish" || command === "cleanup") beginCleanup(command);
  }
});

try {
  target = spawn(targetCommand, targetArgs, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  target.stdout?.pipe(process.stdout);
  target.stderr?.pipe(process.stderr);
  target.once("error", (error) => {
    targetExit = { code: null, signal: null, error: { code: error.code || "ERROR", message: error.message } };
    emit({ type: "target-error", ...targetExit });
  });
  target.once("close", (code, signal) => {
    targetExit = { code: code ?? null, signal: signal ?? null };
    emit({ type: "target-exit", ...targetExit });
  });
} catch (error) {
  targetExit = { code: null, signal: null, error: { code: error.code || "ERROR", message: error.message } };
  emit({ type: "target-error", ...targetExit });
}
`;

function signalProcessGroup(child, signal) {
  if (!child || child.exitCode !== null || !child.pid) return false;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function waitForClose(closePromise, deadline) {
  const remaining = remainingMs(deadline);
  if (remaining <= 0) return Promise.resolve({ closed: false, deadline: true });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ closed: false, deadline: true }), remaining);
  });
  return Promise.race([closePromise.then((value) => ({ closed: true, value })), timeout])
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

function safeError(error) {
  return {
    code: error?.code ?? "ERROR",
    message: error instanceof Error ? error.message : String(error)
  };
}

function ownedCleanupUnresolved(phases, processResult = null, bootstrap = []) {
  return phases.some((phase) => phase.unresolved === true || phase.processCleanup?.status === "UNKNOWN") ||
    processResult?.unresolved === true || processResult?.processCleanup?.status === "UNKNOWN" ||
    bootstrap.some((entry) => entry.kind === "command" &&
      (entry.unresolved === true || entry.processCleanup?.status !== "CLEAN"));
}

async function cleanupOwnedFixture(fixture, deadline, phases = [], processResult = null, bootstrap = []) {
  if (ownedCleanupUnresolved(phases, processResult, bootstrap)) {
    return {
      status: "UNKNOWN",
      removed: false,
      fixtureRoot: fixture?.root ?? null,
      elapsedMs: 0,
      reason: "owned-process-cleanup-unverified"
    };
  }
  return cleanupFixture(fixture, deadline);
}

function safeJson(value) {
  if (value === "" || value === null || value === undefined) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function compactResult(value) {
  if (!value || typeof value !== "object") return value ?? null;
  const result = {};
  for (const key of [
    "ok", "status", "planningOnly", "authorityGrantIssued", "effectAllowed", "externalNetworkUsed",
    "planId", "planDigest", "contractDigest", "path", "created", "mode", "direct", "runId",
    "routeReceipt", "currentDigest", "currentBindings"
  ]) {
    if (Object.hasOwn(value, key)) result[key] = structuredClone(value[key]);
  }
  if (Array.isArray(value.blockers)) result.blockers = value.blockers.map(String);
  if (value.sentinel && typeof value.sentinel === "object") {
    result.sentinel = {
      digest: value.sentinel.digest ?? null,
      complete: value.sentinel.complete === true,
      counts: value.sentinel.counts ?? null,
      uncertainty: value.sentinel.uncertainty ?? null
    };
  }
  if (value.currentBindings && typeof value.currentBindings === "object") {
    result.currentBindings = structuredClone(value.currentBindings);
  }
  return result;
}

function commandResultSummary(result) {
  const stdout = Buffer.from(result.stdout ?? "", "utf8");
  const stderr = Buffer.from(result.stderr ?? "", "utf8");
  const parsed = safeJson(result.stdout) ?? safeJson(result.stderr);
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut === true,
    elapsedMs: result.elapsedMs,
    ownerPid: result.ownerPid ?? null,
    ownerKind: result.ownerKind ?? null,
    ownerLost: result.ownerLost === true,
    unresolved: result.unresolved === true,
    processCleanup: result.processCleanup ?? null,
    supervisorEvents: Array.isArray(result.supervisorEvents) ? result.supervisorEvents : [],
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    resultDigest: parsed === null ? null : digestObject(parsed),
    result: compactResult(parsed),
    ...(parsed === null && (result.stdout || result.stderr)
      ? { parseError: "command did not emit a single JSON value" }
      : {}),
    ...(result.error ? { error: safeError(result.error) } : {})
  };
}

function safeEnv({ stateRoot, home, tmp }) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    CI: "1",
    CONTINUOUS_INTEGRATION: "1",
    NO_COLOR: "1",
    NODE_NO_WARNINGS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    SBW_STATE_ROOT: stateRoot,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_FUND: "false"
  };
}

async function runOwnedProcess(command, args, { cwd, env, deadline, waitBeforeCleanupMs = 0 } = {}) {
  requireBudget(deadline, `${command} ${args.join(" ")}`);
  const started = Date.now();
  const stdout = { chunks: [], bytes: 0, truncated: false };
  const stderr = { chunks: [], bytes: 0, truncated: false };
  let child;
  try {
    child = spawn(process.execPath, ["-e", OWNED_SUPERVISOR_SOURCE, command, JSON.stringify(args), String(SUPERVISOR_CLEANUP_GRACE_MS)], {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", "pipe"]
    });
  } catch (error) {
    return {
      command,
      args,
      elapsedMs: Date.now() - started,
      exitCode: null,
      signal: null,
      timedOut: false,
      unresolved: false,
      ownerLost: true,
      processCleanup: {
        status: "UNKNOWN",
        reason: "supervisor-spawn-failed",
        ownerPid: null,
        groupTermRequested: false,
        groupSignalRequested: false,
        groupTerminationObserved: false
      },
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      error
    };
  }
  child.stdout?.on("data", (chunk) => collectOutput(stdout, chunk));
  child.stderr?.on("data", (chunk) => collectOutput(stderr, chunk));
  let closeResolve;
  let closeReject;
  const closePromise = new Promise((resolve, reject) => {
    closeResolve = resolve;
    closeReject = reject;
  });
  let ownerError = null;
  let ownerClosed = false;
  child.once("error", (error) => {
    ownerError = error;
    closeReject(error);
  });
  child.once("close", (exitCode, signal) => {
    ownerClosed = true;
    closeResolve({ exitCode, signal });
  });

  const events = [];
  let controlBuffer = "";
  let targetResult = null;
  let targetResolve;
  const targetPromise = new Promise((resolve) => {
    targetResolve = resolve;
  });
  child.stdio?.[3]?.on("data", (chunk) => {
    controlBuffer += String(chunk);
    const lines = controlBuffer.split(/\r?\n/);
    controlBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        events.push({ type: "invalid-control", line: line.slice(0, 256) });
        continue;
      }
      events.push(event);
      if (event.event?.type === "target-exit" || event.event?.type === "target-error") {
        targetResult = {
          code: event.event.code ?? null,
          signal: event.event.signal ?? null,
          ...(event.event.error ? { error: event.event.error } : {})
        };
        targetResolve(targetResult);
      }
    }
  });

  const timeoutMs = Math.max(1, remainingMs(deadline) - CHILD_STOP_RESERVE_MS);
  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  let timedOut = false;
  let ownerLost = false;
  let completion;
  try {
    completion = await Promise.race([
      targetPromise.then((value) => ({ target: value })),
      closePromise.then(() => ({ ownerClosed: true })),
      timeoutPromise
    ]);
    if (completion?.ownerClosed) {
      ownerLost = targetResult === null;
    } else {
      timedOut = completion?.timedOut === true;
    }
  } catch (error) {
    ownerLost = true;
    completion = { error };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const requestCleanup = async (reason) => {
    if (remainingMs(deadline) <= 0) {
      return {
        status: "UNKNOWN",
        reason: "deadline-expired-before-cleanup",
        ownerPid: child.pid ?? null,
        groupTermRequested: false,
        groupSignalRequested: false,
        groupTerminationObserved: false,
        ownerClosed: ownerClosed === true
      };
    }
    let controlRequested = false;
    try {
      if (child.stdin?.writable) {
        child.stdin.write(`${reason}\n`);
        controlRequested = true;
      }
    } catch {
      controlRequested = false;
    }
    if (!controlRequested && !ownerClosed) {
      try {
        controlRequested = signalProcessGroup(child, "SIGTERM");
      } catch {
        controlRequested = false;
      }
    }
    const closed = await waitForClose(closePromise, deadline);
    const groupTermRequested = events.some((event) => event.event?.type === "group-term-requested" && event.event.requested === true);
    const groupKillRequested = events.some((event) => event.event?.type === "group-kill-requested" && event.event.requested === true) ||
      closed.value?.signal === "SIGKILL";
    const windowsCleanup = events.some((event) => event.event?.type === "windows-direct-kill-requested");
    const groupTerminationObserved = closed.closed === true && closed.value?.signal === "SIGKILL" && groupKillRequested === true;
    const verified = process.platform !== "win32" && controlRequested && groupTerminationObserved;
    return {
      status: verified ? "CLEAN" : "UNKNOWN",
      reason: verified ? "supervisor-group-teardown-observed" : "supervisor-cleanup-unverified",
      ownerPid: child.pid ?? null,
      controlRequested,
      groupTermRequested,
      groupSignalRequested: groupKillRequested,
      groupTerminationObserved,
      ownerClosed: closed.closed === true,
      ownerCloseSignal: closed.value?.signal ?? null,
      windowsCleanup,
      ...(closed.deadline ? { deadline: true } : {})
    };
  };

  let processCleanup;
  if (completion?.ownerClosed) {
    processCleanup = {
      status: "UNKNOWN",
      reason: "supervisor-owner-exited-before-target-or-cleanup",
      ownerPid: child.pid ?? null,
      groupTermRequested: false,
      groupSignalRequested: false,
      groupTerminationObserved: false,
      ownerClosed: true
    };
  } else if (timedOut) {
    processCleanup = await requestCleanup("cleanup");
  } else if (targetResult !== null) {
    if (Number.isFinite(waitBeforeCleanupMs) && waitBeforeCleanupMs > 0) {
      const holdMs = Math.min(waitBeforeCleanupMs, Math.max(0, remainingMs(deadline) - CHILD_STOP_RESERVE_MS));
      const holdWasBounded = holdMs < waitBeforeCleanupMs;
      if (holdMs > 0) await sleep(holdMs);
      if (holdWasBounded || remainingMs(deadline) <= CHILD_STOP_RESERVE_MS) timedOut = true;
    }
    processCleanup = await requestCleanup(timedOut ? "cleanup" : "finish");
  } else {
    ownerLost = true;
    processCleanup = {
      status: "UNKNOWN",
      reason: "target-result-unavailable",
      ownerPid: child.pid ?? null,
      groupTermRequested: false,
      groupSignalRequested: false,
      groupTerminationObserved: false,
      ownerClosed: ownerClosed === true
    };
  }
  if (processCleanup.status !== "CLEAN") ownerLost = true;
  return {
    command,
    args,
    elapsedMs: Date.now() - started,
    exitCode: targetResult?.code ?? null,
    signal: targetResult?.signal ?? null,
    timedOut,
    unresolved: processCleanup.ownerClosed !== true,
    ownerPid: child.pid ?? null,
    ownerKind: "detached-process-group-supervisor",
    ownerLost,
    targetResult,
    supervisorEvents: events,
    processCleanup,
    stdout: Buffer.concat(stdout.chunks).toString("utf8"),
    stderr: Buffer.concat(stderr.chunks).toString("utf8"),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    ...(ownerError ? { error: ownerError } : {})
  };
}

async function runGit(cwd, args, context) {
  const { onResult, ...processContext } = context;
  const result = await runOwnedProcess("git", args, processContext);
  onResult?.(result);
  const cleanupVerified = result.processCleanup?.status === "CLEAN";
  const accepted = result.timedOut === false &&
    result.exitCode === 0 &&
    result.unresolved === false &&
    result.ownerLost === false &&
    cleanupVerified;
  if (!accepted) {
    const cleanupFailure = !cleanupVerified || result.unresolved !== false || result.ownerLost !== false;
    const code = result.timedOut
      ? "OFFLINE_TRY_DEADLINE_EXCEEDED"
      : cleanupFailure
        ? "OFFLINE_TRY_FIXTURE_CLEANUP_UNVERIFIED"
        : "OFFLINE_TRY_FIXTURE_FAILED";
    throw new OfflineTryError(
      `Offline fixture git command failed: git ${args.join(" ")}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
      code
    );
  }
  return result;
}

async function writeJson(target, value) {
  await writeFile(target, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);
}

function bootstrapCommandStatus(result) {
  const cleanupVerified = result.processCleanup?.status === "CLEAN";
  const accepted = result.timedOut === false &&
    result.exitCode === 0 &&
    result.unresolved === false &&
    result.ownerLost === false &&
    cleanupVerified;
  if (accepted) return "PASS";
  if (result.timedOut || result.unresolved || result.ownerLost || !cleanupVerified) return "UNKNOWN";
  return "FAIL";
}

function recordBootstrapCommand(bootstrap, scope, args, result) {
  bootstrap.push({
    kind: "command",
    scope,
    status: bootstrapCommandStatus(result),
    command: ["git", ...args],
    ...commandResultSummary(result)
  });
}

async function createFixture({ root, deadline, env, bootstrap }) {
  const pluginRepository = path.join(root, "plugin-repository");
  const pluginCopy = path.join(pluginRepository, "plugins", "better-workflows");
  const repository = path.join(root, "repository");
  const stateRoot = path.join(root, "state");
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  await Promise.all([
    mkdir(path.dirname(pluginCopy), { recursive: true }),
    mkdir(path.join(repository, "src"), { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(tmp, { recursive: true })
  ]);
  // The real CLI refuses an uncommitted plugin source when it computes route
  // bindings.  Commit a disposable snapshot in the isolated fixture so this
  // smoke exercises the same clean-source gate without changing the caller's
  // repository or using a pre-trusted cache.
  requireBudget(deadline, "copy plugin runtime snapshot");
  await cp(SOURCE_PLUGIN_ROOT, pluginCopy, { recursive: true, force: true });
  requireBudget(deadline, "commit plugin runtime snapshot");
  const runFixtureGit = (cwd, scope, args) => runGit(cwd, args, {
    cwd,
    env,
    deadline,
    onResult: (result) => recordBootstrapCommand(bootstrap, scope, args, result)
  });
  await runFixtureGit(pluginRepository, "plugin repository setup", ["init", "-q", "-b", "offline-try-plugin"]);
  await runFixtureGit(pluginRepository, "plugin repository setup", ["config", "core.fsmonitor", "false"]);
  await runFixtureGit(pluginRepository, "plugin repository setup", ["add", "."]);
  await runFixtureGit(pluginRepository, "plugin repository setup", [
    "-c", "user.name=Offline Smoke Plugin", "-c", "user.email=offline-plugin@example.invalid",
    "commit", "-qm", "offline plugin fixture"
  ]);
  const pluginRevision = (await runFixtureGit(pluginRepository, "plugin repository verification", ["rev-parse", "HEAD"])).stdout.trim();
  const pluginStatus = (await runFixtureGit(pluginRepository, "plugin repository verification", ["status", "--porcelain=v1"])).stdout;
  if (!/^[0-9a-f]{40}$/.test(pluginRevision) || pluginStatus.length !== 0) {
    throw new OfflineTryError("Offline plugin runtime snapshot is not a clean committed tree", "OFFLINE_TRY_RUNTIME_SNAPSHOT_INVALID");
  }
  bootstrap.push({
    kind: "runtime",
    scope: "isolated committed plugin runtime",
    status: "PASS",
    repositoryRoot: pluginRepository,
    pluginRoot: pluginCopy,
    sourceRevision: pluginRevision,
    clean: true,
    cliPath: path.join(pluginCopy, "scripts", "sbw.mjs")
  });

  await runFixtureGit(repository, "isolated Git fixture setup", ["init", "-q", "-b", "offline-try"]);
  await runFixtureGit(repository, "isolated Git fixture setup", ["config", "core.fsmonitor", "false"]);
  await writeFile(path.join(repository, "README.md"), "offline free-core fixture\n", { encoding: "utf8", mode: 0o644 });
  await writeFile(path.join(repository, "src", "value.txt"), "one\n", { encoding: "utf8", mode: 0o644 });
  await runFixtureGit(repository, "isolated Git fixture setup", ["add", "README.md", "src/value.txt"]);
  await runFixtureGit(repository, "isolated Git fixture setup", [
    "-c", "user.name=Offline Smoke Fixture", "-c", "user.email=offline@example.invalid",
    "commit", "-qm", "offline fixture"
  ]);
  const repositoryStatus = (await runFixtureGit(repository, "isolated Git fixture verification", ["status", "--porcelain=v1"])).stdout;
  bootstrap.push({
    kind: "runtime",
    scope: "isolated Git fixture",
    status: repositoryStatus.length === 0 ? "PASS" : "FAIL",
    repositoryRoot: repository,
    clean: repositoryStatus.length === 0
  });

  const draft = {
    schemaVersion: 3,
    kind: "TaskContractV3",
    contractId: "offline-sbw-try-contract",
    goal: PLAN_GOAL,
    scope: { include: ["."], exclude: [] },
    roles: [{ id: "root", required: true }],
    modelPolicy: { inherit: true, allow: [], deny: [], requested: null, reported: null, attested: null },
    budget: { attempts: 1, seconds: 10, tokens: 100 },
    acceptance: [{
      id: "offline-plan",
      description: "The offline native plan is persisted and fresh-verifiable.",
      requiredEvidence: [],
      critical: true
    }],
    graph: {
      tasks: [{
        id: "plan",
        goal: "Persist the offline native plan",
        dependencies: [],
        role: "root",
        writeOwner: { role: "root", paths: [] },
        budget: { attempts: 1, seconds: 10, tokens: 100 },
        acceptanceIds: ["offline-plan"]
      }]
    }
  };
  const draftPath = path.join(root, "contract.json");
  await writeJson(draftPath, draft);
  return {
    root,
    pluginRepository,
    pluginCopy,
    pluginRevision,
    pluginClean: true,
    cliPath: path.join(pluginCopy, "scripts", "sbw.mjs"),
    repository,
    stateRoot,
    draftPath,
    home,
    tmp
  };
}

async function runCliPhase(fixture, phase, args, { deadline, env }) {
  const result = await runOwnedProcess(process.execPath, [fixture.cliPath ?? CLI_PATH, ...args], {
    cwd: fixture.repository,
    env: { ...env, SBW_STATE_ROOT: fixture.stateRoot },
    deadline
  });
  const summary = commandResultSummary(result);
  const value = safeJson(result.stdout) ?? safeJson(result.stderr);
  const processClean = result.processCleanup?.status === "CLEAN";
  const outcome = result.timedOut
    ? "UNKNOWN"
    : value?.ok === true && result.exitCode === 0 && processClean
      ? "PASS"
      : value?.ok === false && value?.status === "HOLD" && processClean
        ? "HOLD"
        : "FAIL";
  return {
    phase,
    status: outcome,
    command: [process.execPath, fixture.cliPath ?? CLI_PATH, ...args],
    ...summary
  };
}

function assertPassPhase(phase) {
  if (phase.status !== "PASS") {
    throw new OfflineTryError(
      `${phase.phase} did not pass: ${phase.error?.message ?? JSON.stringify(phase.result)}`,
      "OFFLINE_TRY_PHASE_FAILED"
    );
  }
}

function assertExpectedHoldPhase(phase, beforePlanDigest) {
  const result = phase.result;
  if (
    phase.status !== "HOLD" || phase.exitCode !== 2 || result?.ok !== false || result?.status !== "HOLD" ||
    !Array.isArray(result.blockers) || !result.blockers.includes("binding-drift:source digest")
  ) {
    throw new OfflineTryError(
      `offline source-drift negative did not produce the expected HOLD: ${JSON.stringify(result)}`,
      "OFFLINE_TRY_NEGATIVE_FAILED"
    );
  }
  return {
    expected: true,
    achieved: true,
    phase: phase.phase,
    status: result.status,
    ok: result.ok,
    exitCode: phase.exitCode,
    blockers: result.blockers,
    planDigestBefore: beforePlanDigest,
    planDigestAfter: result.planDigest ?? null,
    currentBindings: result.currentBindings ?? null,
    authorityGrantIssued: result.authorityGrantIssued === true,
    effectAllowed: result.effectAllowed === true,
    externalNetworkUsed: result.externalNetworkUsed === true
  };
}

async function cleanupFixture(fixture, deadline) {
  if (!fixture?.root) {
    return { status: "CLEAN", removed: true, fixtureRoot: null, elapsedMs: 0 };
  }
  const started = Date.now();
  const removal = rm(fixture.root, { recursive: true, force: true });
  let removed = false;
  let timedOut = false;
  let deadlineTimer;
  const deadlinePromise = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve("deadline"), Math.max(1, remainingMs(deadline)));
  });
  try {
    const result = await Promise.race([
      removal.then(() => "removed"),
      deadlinePromise
    ]);
    if (result === "removed") {
      try {
        await lstat(fixture.root);
      } catch (error) {
        removed = error?.code === "ENOENT";
      }
    } else {
      timedOut = true;
    }
  } catch (error) {
    return {
      status: "UNKNOWN",
      removed: false,
      fixtureRoot: fixture.root,
      elapsedMs: Date.now() - started,
      error: safeError(error)
    };
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
  return {
    status: timedOut ? "UNKNOWN" : removed ? "CLEAN" : "UNKNOWN",
    removed,
    fixtureRoot: fixture.root,
    elapsedMs: Date.now() - started,
    ...(timedOut ? { error: { code: "OFFLINE_TRY_CLEANUP_DEADLINE", message: "Fixture cleanup exceeded the operation deadline" } } : {})
  };
}

function validateTimeout(timeoutMs, label) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > OFFLINE_TRY_MAX_MS) {
    throw new RangeError(label + " must be a positive integer no greater than " + OFFLINE_TRY_MAX_MS);
  }
}

function operationBounds(timeoutMs) {
  return {
    totalDeadlineMs: timeoutMs,
    deadlineIncludedCleanup: true,
    childStopReserveMs: CHILD_STOP_RESERVE_MS,
    supervisorCleanupGraceMs: SUPERVISOR_CLEANUP_GRACE_MS,
    nonCancellableFileOperations: [...NON_CANCELLABLE_FILE_OPERATIONS],
    deadlinePolicy: "UNKNOWN",
    noPhaseAfterDeadline: true
  };
}

function localOnlyScope() {
  return {
    accountRequired: false,
    paidFeatureRequired: false,
    cloudRequired: false,
    vmRequired: false,
    administratorRequired: false,
    credentialsUsed: false,
    networkUsed: false,
    remoteProviderUsed: false,
    replayServerUsed: false,
    remoteMutation: false
  };
}

export async function runOfflineOwnedProcessProbe(options = {}) {
  if (!Object.hasOwn(options, "timeoutMs")) {
    throw new RangeError("offline process probe timeoutMs is required");
  }
  const { timeoutMs } = options;
  validateTimeout(timeoutMs, "offline process probe timeoutMs");
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const deadline = started + timeoutMs;
  let fixture = null;
  let processResult = null;
  let fatal = null;
  try {
    const root = await mkdtemp(path.join(os.tmpdir(), "bw-v5-offline-process-probe-"));
    fixture = { root };
    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    const stateRoot = path.join(root, "state");
    const marker = path.join(root, "descendant");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(tmp, { recursive: true }),
      mkdir(stateRoot, { recursive: true })
    ]);
    const env = safeEnv({ stateRoot, home, tmp });
    const descendantSource = [
      'const fs = require("node:fs");',
      'const marker = process.argv[1];',
      'fs.writeFileSync(marker + ".started", String(process.pid));',
      'process.once("SIGTERM", () => { fs.writeFileSync(marker + ".terminated", "SIGTERM"); process.exit(0); });',
      'if (process.platform === "win32") setTimeout(() => process.exit(0), 250); else setInterval(() => {}, 1000);'
    ].join(String.fromCharCode(10));
    const leaderSource = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      'const marker = process.argv[1];',
      'const descendantSource = process.argv[2];',
      'spawn(process.execPath, ["-e", descendantSource, marker], { stdio: "ignore" });',
      'const waitUntil = Date.now() + 2_000;',
      'const waitForDescendant = () => {',
      '  if (fs.existsSync(marker + ".started")) { fs.writeFileSync(marker + ".leader-exited", "1"); process.exit(0); }',
      '  if (Date.now() >= waitUntil) { fs.writeFileSync(marker + ".leader-exited", "0"); process.exit(3); }',
      '  setTimeout(waitForDescendant, 5);',
      '};',
      'waitForDescendant();'
    ].join(String.fromCharCode(10));
    processResult = await runOwnedProcess(process.execPath, ["-e", leaderSource, marker, descendantSource], {
      cwd: root,
      env,
      deadline,
      // Keep the supervisor alive after the real target leader exits. The
      // deadline then exercises cleanup while the descendant remains owned.
      waitBeforeCleanupMs: timeoutMs
    });
    const readMarker = async (suffix) => {
      try {
        return (await readFile(marker + suffix, "utf8")).trim();
      } catch {
        return null;
      }
    };
    const [descendantStarted, leaderExited, descendantTerminated] = await Promise.all([
      readMarker(".started"),
      readMarker(".leader-exited"),
      readMarker(".terminated")
    ]);
    processResult.descendantProof = {
      started: descendantStarted !== null,
      leaderExited: leaderExited === "1",
      terminatedByOwnedGroupTerm: descendantTerminated === "SIGTERM",
      startedValue: descendantStarted,
      terminatedValue: descendantTerminated
    };
  } catch (error) {
    fatal = safeError(error);
  }
  const cleanup = await cleanupOwnedFixture(fixture, deadline, [], processResult);
  const elapsedMs = Date.now() - started;
  const descendantProof = processResult?.descendantProof ?? {
    started: false,
    leaderExited: false,
    terminatedByOwnedGroupTerm: false,
    startedValue: null,
    terminatedValue: null
  };
  const processClean = processResult?.processCleanup?.status === "CLEAN";
  const ok = processResult?.timedOut === true &&
    processClean &&
    descendantProof.started &&
    descendantProof.leaderExited &&
    descendantProof.terminatedByOwnedGroupTerm &&
    cleanup.status === "CLEAN" &&
    cleanup.removed === true &&
    fatal === null &&
    elapsedMs <= timeoutMs &&
    elapsedMs <= OFFLINE_TRY_MAX_MS;
  return {
    schemaVersion: OFFLINE_TRY_SCHEMA_VERSION,
    kind: "OfflineOwnedProcessProbeV1",
    ok,
    status: ok ? "PASS" : "UNKNOWN",
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs,
    timeoutMs,
    deadlineIncludedCleanup: true,
    bounds: operationBounds(timeoutMs),
    scope: {
      kind: "OfflineOwnedProcessProbeScopeV1",
      fixtureRoot: fixture?.root ?? null,
      ...localOnlyScope()
    },
    process: processResult ? {
      command: [process.execPath, "-e", "<leader-probe>"],
      elapsedMs: processResult.elapsedMs,
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      timedOut: processResult.timedOut,
      ownerPid: processResult.ownerPid,
      ownerKind: processResult.ownerKind,
      ownerLost: processResult.ownerLost,
      unresolved: processResult.unresolved,
      processCleanup: processResult.processCleanup,
      supervisorEvents: processResult.supervisorEvents
    } : null,
    descendantProof,
    cleanup,
    ...(fatal ? { error: fatal } : {})
  };
}

function scopeForFixture(fixture) {
  return {
    kind: "OfflineSbwTryScopeV1",
    repositoryRoot: fixture?.repository ?? null,
    stateRoot: fixture?.stateRoot ?? null,
    runtimePluginRoot: fixture?.pluginCopy ?? null,
    runtimePluginRepository: fixture?.pluginRepository ?? null,
    runtimePluginRevision: fixture?.pluginRevision ?? null,
    runtimePluginClean: fixture?.pluginClean === true,
    sourceInclude: ["README.md", "src/value.txt"],
    packageFixture: "Auto native plan and run",
    ...localOnlyScope()
  };
}

function isOfflineTryPass({ bootstrap = [], phases = [], expectedHold = null, cleanup = null, fatal = null, elapsedMs = Infinity, timeoutMs = null } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > OFFLINE_TRY_MAX_MS) return false;
  const expectedPhases = ["workflow.plan", "verify.plan", "run.create", "verify.plan-source-drift"];
  const executablePhases = phases.filter((phase) => phase.phase !== "verify.plan-source-drift");
  const timedOutIndex = phases.findIndex((phase) => phase.timedOut === true);
  const allOwnedCleanupVerified = phases.length > 0 && phases.every((phase) =>
    phase.unresolved !== true && phase.processCleanup?.status === "CLEAN"
  );
  const allBootstrapVerified = bootstrap.length > 0 && bootstrap.every((entry) => {
    if (entry.kind === "command") {
      return entry.status === "PASS" &&
        entry.unresolved === false &&
        entry.ownerLost === false &&
        entry.processCleanup?.status === "CLEAN";
    }
    return entry.kind === "runtime" && entry.status === "PASS" && entry.clean === true;
  });
  return fatal === null &&
    allBootstrapVerified &&
    phases.length === expectedPhases.length &&
    phases.every((phase, index) => phase.phase === expectedPhases[index]) &&
    executablePhases.every((phase) => phase.status === "PASS") &&
    allOwnedCleanupVerified &&
    (timedOutIndex < 0 || timedOutIndex === phases.length - 1) &&
    expectedHold?.achieved === true &&
    cleanup?.status === "CLEAN" &&
    cleanup?.removed === true &&
    elapsedMs <= timeoutMs &&
    elapsedMs <= OFFLINE_TRY_MAX_MS;
}

export async function runOfflineSbwTry(options = {}) {
  if (!Object.hasOwn(options, "timeoutMs")) {
    throw new RangeError("offline try timeoutMs is required");
  }
  const { timeoutMs } = options;
  validateTimeout(timeoutMs, "offline try timeoutMs");
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const deadline = started + timeoutMs;
  let fixture = null;
  const phases = [];
  const bootstrap = [];
  let expectedHold = {
    expected: true,
    achieved: false,
    phase: "verify.plan-source-drift",
    status: null,
    ok: null,
    exitCode: null,
    blockers: [],
    planDigestBefore: null,
    planDigestAfter: null,
    planFileDigestBefore: null,
    planFileDigestAfter: null,
    currentBindings: null,
    authorityGrantIssued: false,
    effectAllowed: false,
    externalNetworkUsed: false
  };
  let fatal = null;
  let planDigestBefore = null;
  let planFileDigestBefore = null;
  let env = null;
  try {
    const root = await mkdtemp(path.join(os.tmpdir(), "bw-v5-offline-try-"));
    fixture = { root };
    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    const stateRoot = path.join(root, "state");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(tmp, { recursive: true }),
      mkdir(stateRoot, { recursive: true })
    ]);
    env = safeEnv({ stateRoot, home, tmp });
    fixture = await createFixture({ root, deadline, env, bootstrap });

    requireBudget(deadline, "workflow plan");
    const planned = await runCliPhase(fixture, "workflow.plan", [
      "workflow", "plan", "--contract", fixture.draftPath, "--plan-id", PLAN_ID,
      "--goal", PLAN_GOAL, "--scope", ".", "--template", TEMPLATE_ID
    ], { deadline, env });
    phases.push(planned);
    assertPassPhase(planned);
    planDigestBefore = planned.result?.planDigest ?? null;

    const verified = await runCliPhase(fixture, "verify.plan", ["verify", "plan", PLAN_ID], { deadline, env });
    phases.push(verified);
    assertPassPhase(verified);
    if (planDigestBefore === null || planDigestBefore !== (verified.result?.planDigest ?? null)) {
      throw new OfflineTryError("Plan verification did not preserve the persisted plan digest", "OFFLINE_TRY_PLAN_BINDING_MISSING");
    }

    const planPath = path.join(fixture.stateRoot, "plans", PLAN_ID, "plan.json");
    planFileDigestBefore = sha256(await readFile(planPath));

    const runCreated = await runCliPhase(fixture, "run.create", [
      "run", "--template", TEMPLATE_ID, "--mode", "verified", "--goal", PLAN_GOAL, "--scope", "src"
    ], { deadline, env });
    phases.push(runCreated);
    assertPassPhase(runCreated);

    requireBudget(deadline, "source-drift negative");
    await writeFile(path.join(fixture.repository, "src", "value.txt"), "two\n", { encoding: "utf8", mode: 0o644 });
    const drifted = await runCliPhase(fixture, "verify.plan-source-drift", ["verify", "plan", PLAN_ID], { deadline, env });
    phases.push(drifted);
    expectedHold = assertExpectedHoldPhase(drifted, planDigestBefore);

    const planFileDigestAfter = sha256(await readFile(planPath));
    if (planFileDigestBefore === null || planFileDigestAfter !== planFileDigestBefore) {
      throw new OfflineTryError("Source-drift verification mutated the persisted plan artifact", "OFFLINE_TRY_PLAN_MUTATED");
    }
    const planDigestAfter = drifted.result?.planDigest ?? null;
    if (planDigestBefore === null || planDigestAfter !== planDigestBefore) {
      throw new OfflineTryError("Source-drift verification changed the persisted plan digest", "OFFLINE_TRY_PLAN_BINDING_CHANGED");
    }
    expectedHold.planDigestAfter = planDigestAfter;
    expectedHold.planFileDigestBefore = planFileDigestBefore;
    expectedHold.planFileDigestAfter = planFileDigestAfter;
  } catch (error) {
    fatal = safeError(error);
  }
  const cleanupDeadline = deadline;
  const cleanup = await cleanupOwnedFixture(fixture, cleanupDeadline, phases, null, bootstrap);
  const elapsedMs = Date.now() - started;
  const allRequiredPass = isOfflineTryPass({ bootstrap, phases, expectedHold, cleanup, fatal, elapsedMs, timeoutMs });
  const result = {
    schemaVersion: OFFLINE_TRY_SCHEMA_VERSION,
    kind: OFFLINE_TRY_KIND,
    ok: allRequiredPass,
    status: allRequiredPass ? "PASS" : "UNKNOWN",
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs,
    timeoutMs,
    deadlineIncludedCleanup: true,
    bounds: operationBounds(timeoutMs),
    scope: scopeForFixture(fixture),
    bootstrap,
    phases,
    expectedHold,
    authority: {
      authorityGrantIssued: false,
      effectAllowed: false,
      externalNetworkUsed: false,
      remoteMutation: false
    },
    cleanup,
    ...(fatal ? { error: fatal } : {})
  };
  if (elapsedMs > OFFLINE_TRY_MAX_MS && !result.error) {
    result.error = { code: "OFFLINE_TRY_TOTAL_DEADLINE_EXCEEDED", message: "Offline smoke exceeded the 90 second bound" };
  }
  return result;
}
