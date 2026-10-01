// SPDX-License-Identifier: AGPL-3.0-only
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { canonicalGovernedGithubRepository } from "./git-observation-v1.mjs";
import { captureFormalSuiteManifest, fixedToolPath, formalEvaluatorState, stableBootIdentity } from "./formal-evaluator.mjs";
import { evaluateFullFormalAttemptPolicy } from "./formal-commit.mjs";
import { createFormalSuiteEnvironment } from "./formal-environment.mjs";
import { formalHostStable, parseSleepWakeCounters, parseSleepWakeUuid } from "./formal-host-power.mjs";
import { formalCaptureSucceeded } from "./formal-suite-runner.mjs";
import { assertSameFormalRuntime, createFormalOperation, FORMAL_FULL_PROFILE, observeFormalRuntime, observeFormalRuntimes } from "./formal-operation.mjs";
import { parseStrictJsonV1 } from "./strict-json-v1.mjs";
import { assertFormalProtectedInvocationV2, assertFormalProtectedOuterOwnerV2, formalProtectedGitArgumentsV2, formalProtectedGitExecutableV2 } from "./formal-protected-capture-client-v2.mjs";

const { atomicReceipt, readJsonIfPresent, serializedReceipt, completeSuiteObservations,
  locateExecutable, physicalDirectory, terminalReceipt, validateAttemptLedger, parseProcessTable, isManagedLongSuite } = formalEvaluatorState;
const MAX_LANE_OUTPUT_BYTES = 32 * 1024 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const absolute = (value) => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value;
const SHA = /^[a-f0-9]{40}$/;
const slotIdentity = (info) => ({ dev: info.dev, ino: info.ino, size: info.size, uid: info.uid, mode: info.mode, nlink: info.nlink });

function requireSlotIdentity(info) {
  const identity = slotIdentity(info);
  if (!info.isFile() || info.isSymbolicLink() || !Object.values(identity).every((value) => Number.isSafeInteger(value) && value >= 0) ||
      identity.ino < 1 || identity.size < 1 || identity.uid !== process.getuid() || identity.nlink !== 1 || (identity.mode & 0o777) !== 0o600) {
    throw new Error("Full formal slot must retain its physical private owner identity");
  }
  return identity;
}

function validateRequest(request) {
  assertFormalProtectedInvocationV2(request);
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.getuid() === 0 ||
      !request || ![request.cwd, request.scriptPath, request.ownerHome, request.launchRoot].every(absolute) ||
      !SHA.test(request.expectedHead ?? "") || !SHA.test(request.expectedBase ?? "") ||
      !/^[a-f0-9]{32}$/.test(request.operationNonce ?? "") ||
      !Number.isSafeInteger(request.outerOwnerPid) || request.outerOwnerPid < 1 || request.outerOwnerPid === process.pid ||
      !/^\/private\/tmp\/bw-[A-Za-z0-9._-]+-formal-eval-[A-Za-z0-9._-]+$/.test(request.launchRoot) ||
      !request.nodePaths || Object.keys(request.nodePaths).sort().join(",") !== "node22,node24" ||
      (request.predecessorCompletionPath != null && !absolute(request.predecessorCompletionPath)) ||
      !Object.values(request.nodePaths).every(absolute)) {
    throw new Error("Full formal coordinator requires a nonroot macOS host and exact source/runtime/outer-owner bindings");
  }
}

async function checked(operation, stage, action) {
  operation.checkpoint(stage);
  const result = await action();
  operation.checkpoint(`${stage} complete`);
  return result;
}

async function probe(operation, command, args, cwd, env, maxOutputBytes = 1024 * 1024) {
  const result = await operation.capture(command, args, { cwd, env, maxOutputBytes });
  if (!formalCaptureSucceeded(result) || result.stderr !== "") throw new Error(`Full formal probe failed: ${command}`);
  return result.stdout;
}

async function hostObservation(operation, cwd, env) {
  const bootTime = (await probe(operation, "/usr/sbin/sysctl", ["-n", "kern.boottime"], cwd, env)).trim();
  const bootIdentity = stableBootIdentity(await probe(operation, "/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], cwd, env));
  const session = await probe(operation, "/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-k", "IOPMUserIsActive"], cwd, env, 2 * 1024 * 1024);
  if (!session.includes('"AppleClamshellState" = No') || !session.includes('"IOPMUserIsActive" = Yes')) {
    throw new Error("Full formal requires an open Mac lid and active user session");
  }
  const power = await probe(operation, "/usr/sbin/ioreg", ["-rd1", "-c", "IOPMrootDomain"], cwd, env, 2 * 1024 * 1024);
  const statistics = await probe(operation, "/usr/bin/pmset", ["-g", "stats"], cwd, env, 64 * 1024);
  return { platform: "darwin", bootTime, bootIdentity, sleepWakeUuid: parseSleepWakeUuid(power),
    sleepWakeCounters: parseSleepWakeCounters(statistics), clamshell: "open", userActive: true };
}

async function processObservation(operation, request, cwd, env) {
  const table = parseProcessTable(await probe(operation, "/bin/ps", ["-axo", "pid=,ppid=,command="], cwd, env, 4 * 1024 * 1024));
  const byPid = new Map(table.map((item) => [item.pid, item]));
  const ancestors = new Set([process.pid]);
  let cursor = byPid.get(process.pid)?.ppid;
  while (cursor && !ancestors.has(cursor)) { ancestors.add(cursor); cursor = byPid.get(cursor)?.ppid; }
  if (!(await assertFormalProtectedOuterOwnerV2(request.outerOwnerPid)) && !ancestors.has(request.outerOwnerPid)) throw new Error("Full formal outer owner is not a live ancestor of the coordinator");
  const conflicts = table.filter((item) => !ancestors.has(item.pid) && !item.command.includes(request.launchRoot) && isManagedLongSuite(item.command));
  if (conflicts.length) throw new Error("Full formal host has competing evaluator suites");
}

async function createSlot(context, operation) {
  const value = { schemaVersion: 2, kind: "FullFormalSlotV1", ownerPid: context.outerOwnerPid,
    operationNonce: context.operationNonce, launchRoot: context.launchRoot };
  await checked(operation, "slot acquisition", async () => {
    const handle = await open(context.slotPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(serializedReceipt(value), "utf8");
      await handle.sync();
      context.slotIdentity = requireSlotIdentity(await handle.stat());
    } finally { await handle.close(); }
    const directory = await open(path.dirname(context.slotPath), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  });
  context.slotDigest = hash(serializedReceipt(value));
}

async function assertSlot(context, operation) {
  const before = await checked(operation, "slot identity", async () => requireSlotIdentity(await lstat(context.slotPath)));
  if (!same(before, context.slotIdentity)) throw new Error("Full formal coordinator slot physical identity drifted");
  const observed = await checked(operation, "slot readback", () => readJsonIfPresent(context.slotPath, { withDigest: true }));
  const after = await checked(operation, "slot identity readback", async () => requireSlotIdentity(await lstat(context.slotPath)));
  if (observed?.receiptDigest !== context.slotDigest || !same(after, context.slotIdentity)) throw new Error("Full formal coordinator slot ownership drifted");
}

async function writeState(target, value, context, operation) {
  if (Buffer.byteLength(serializedReceipt(value)) > formalEvaluatorState.maxBytes) throw new Error("Full formal coordinator state exceeds the bounded reader");
  await assertSlot(context, operation);
  await checked(operation, "state write", () => atomicReceipt(target, value));
  const observed = await checked(operation, "state readback", () => readJsonIfPresent(target, { withDigest: true }));
  if (observed?.receiptDigest !== hash(serializedReceipt(value))) throw new Error("Full formal coordinator state drifted after write");
  return observed.receiptDigest;
}

function suiteResult(terminal) {
  try { return parseStrictJsonV1(terminal.stdout, { maxBytes: MAX_LANE_OUTPUT_BYTES }); } catch {
    try { const result = parseStrictJsonV1(terminal.stderr, { maxBytes: MAX_LANE_OUTPUT_BYTES }); return result?.ok === false ? result : null; } catch { return null; }
  }
}

/** Coordinator-only phase. Its normal response is provisional, not PASS. The
 * outer owner must supervise this process, then commit through the file-only
 * worker and separately prove operation completion. This function never
 * releases the outer-owned slot, including on exceptions or coordinator exit.
 */
export async function runFullFormalCoordinator(request) {
  request = structuredClone(request);
  validateRequest(request);
  const operation = createFormalOperation(); // includes all probes and slot acquisition
  const context = { expectedHead: request.expectedHead, expectedBase: request.expectedBase,
    outerOwnerPid: request.outerOwnerPid, operationNonce: request.operationNonce,
    ownerHome: request.ownerHome, launchRoot: request.launchRoot,
    slotPath: `/private/tmp/bw-formal-evaluator-${process.getuid()}.lock` };
  let reserved = false;
  try {
    const cwd = await checked(operation, "cwd resolution", () => realpath(request.cwd));
    const scriptPath = await checked(operation, "script resolution", () => realpath(request.scriptPath));
    const actualHome = await checked(operation, "owner home", () => realpath(os.homedir()));
    if (actualHome !== context.ownerHome) throw new Error("Full formal owner home differs from the host ledger namespace");
    try { await lstat(context.launchRoot); throw new Error("Full formal launch root already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const pathValue = await checked(operation, "fixed tool path", fixedToolPath);
    const env = createFormalSuiteEnvironment(pathValue, {});
    const gitPath = formalProtectedGitExecutableV2(await checked(operation, "git resolution", () => locateExecutable("git", pathValue)));
    await checked(operation, "gh resolution", () => locateExecutable("gh", pathValue));
    await checked(operation, "caffeinate availability", () => access("/usr/bin/caffeinate", constants.X_OK));
    const git = (args) => probe(operation, gitPath, formalProtectedGitArgumentsV2(args, cwd), cwd, env, 8 * 1024 * 1024).then((out) => out.trim());
    const repositoryRoot = await checked(operation, "repository resolution", async () => realpath(await git(["rev-parse", "--show-toplevel"])));
    if (scriptPath !== path.join(repositoryRoot, "plugins/better-workflows/scripts/sbw.mjs")) throw new Error("Full formal script is not the repository evaluator");
    if (await git(["rev-parse", "--verify", "HEAD^{commit}"]) !== context.expectedHead ||
        await git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"])) throw new Error("Full formal requires the exact clean committed source");
    await git(["merge-base", "--is-ancestor", context.expectedBase, context.expectedHead]);
    // A missing origin is the only fallback. Capture failure/timeout is not
    // interpreted as a different repository identity or a fresh attempt budget.
    const repositoryIdentity = async () => {
      const remotes = (await git(["remote"])).split("\n").filter(Boolean);
      if (remotes.includes("origin")) {
        const origin = await git(["remote", "get-url", "origin"]);
        const canonical = canonicalGovernedGithubRepository(origin);
        return canonical ? `github:${canonical}` : `origin-digest:${hash(origin)}`;
      }
      const common = await checked(operation, "common directory", async () => realpath(path.resolve(cwd, await git(["rev-parse", "--git-common-dir"]))));
      return `common:${common}`;
    };
    context.repositoryIdentity = await repositoryIdentity();
    context.ledgerPath = path.join(context.ownerHome, ".better-workflows", "formal-evaluations", hash(context.repositoryIdentity), `${context.expectedHead}.json`);
    const suiteManifest = await checked(operation, "suite manifest", () => captureFormalSuiteManifest({ repositoryRoot, scriptPath }));
    await processObservation(operation, request, cwd, env);
    const host = await hostObservation(operation, cwd, env);
    const runtimeIdentities = await observeFormalRuntimes({ nodePaths: request.nodePaths, operation, cwd, env });
    await createSlot(context, operation);
    await assertSlot(context, operation);
    if (await repositoryIdentity() !== context.repositoryIdentity) throw new Error("Full formal repository identity changed during admission");
    // Slot ownership serializes the shared repository+SHA ledger across profiles.
    const directory = path.dirname(context.ledgerPath);
    await checked(operation, "ledger directory", async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("Full formal ledger namespace is not physical");
      await chmod(directory, 0o700);
    });
    const prior = await checked(operation, "attempt history", () => readJsonIfPresent(context.ledgerPath, { withDigest: true }));
    const ledger = prior === null ? { schemaVersion: 1, head: context.expectedHead, attempts: [] } : validateAttemptLedger(prior.receipt, context.expectedHead);
    const previous = ledger.attempts.length === 1 && ledger.attempts[0].status === "blocked" ? ledger.attempts[0] : null;
    const predecessor = previous?.receiptPath && request.replacementReason
      ? await checked(operation, "predecessor", () => readJsonIfPresent(previous.receiptPath, { withDigest: true })) : null;
    let completion = null;
    if (request.predecessorCompletionPath != null) {
      if (previous?.profileId !== FORMAL_FULL_PROFILE.id || !request.replacementReason ||
          request.predecessorCompletionPath !== path.join(previous.launchRoot, "completion.json")) {
        throw new Error("Full formal predecessor completion must belong to the prior full attempt");
      }
      completion = await checked(operation, "predecessor completion", () => readJsonIfPresent(request.predecessorCompletionPath, { withDigest: true }));
      if (!completion) throw new Error("Full formal predecessor completion is missing");
    }
    const policy = await checked(operation, "attempt policy", () => evaluateFullFormalAttemptPolicy(ledger.attempts, request.replacementReason ?? null,
      predecessor ? { ...predecessor, expectedHead: context.expectedHead, expectedBase: context.expectedBase } : null, completion?.receipt ?? null, context));
    // Recheck after acquiring the slot and admission probes, before spending an attempt.
    if (await git(["rev-parse", "--verify", "HEAD^{commit}"]) !== context.expectedHead ||
        await git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"]) ||
        !same(await checked(operation, "suite admission recheck", () => captureFormalSuiteManifest({ repositoryRoot, scriptPath })), suiteManifest)) {
      throw new Error("Full formal source changed during admission");
    }
    await checked(operation, "launch directory", () => physicalDirectory(context.launchRoot));
    const environments = [];
    for (const lane of FORMAL_FULL_PROFILE.lanes) {
      const laneRoot = path.join(context.launchRoot, lane.id);
      await checked(operation, "lane directory", () => physicalDirectory(laneRoot));
      const paths = {};
      for (const [key, name] of [["SBW_STATE_ROOT", "state"], ["NPM_CONFIG_CACHE", "npm-cache"], ["TMPDIR", "tmp"]]) {
        paths[key] = (await checked(operation, "lane isolation", () => physicalDirectory(path.join(laneRoot, name)))).path;
      }
      environments.push(createFormalSuiteEnvironment(pathValue, paths));
    }
    const attempt = { attemptId: `formal-${hash(`${context.expectedHead}\0${context.launchRoot}`).slice(0, 24)}`,
      launchRoot: context.launchRoot, receiptPath: path.join(context.launchRoot, "receipt.json"),
      startedAt: new Date().toISOString(), status: "running", phase: "reserved", profileId: FORMAL_FULL_PROFILE.id,
      outerOwnerPid: context.outerOwnerPid, operationNonce: context.operationNonce, coordinatorPid: process.pid,
      replacementReason: request.replacementReason ?? null };
    if (completion) attempt.predecessorCompletion = { path: request.predecessorCompletionPath, digest: completion.receiptDigest,
      attemptId: previous.attemptId, receiptDigest: predecessor.receiptDigest };
    if (await repositoryIdentity() !== context.repositoryIdentity) throw new Error("Full formal repository identity changed before reservation");
    ledger.attempts.push(attempt);
    await writeState(context.ledgerPath, ledger, context, operation);
    reserved = true;
    const provisional = { schemaVersion: 2, kind: "FullFormalProvisionalV1", status: "running", phase: "awaiting-outer",
      profileId: FORMAL_FULL_PROFILE.id, operationNonce: context.operationNonce, outerOwnerPid: context.outerOwnerPid,
      expectedHead: context.expectedHead, expectedBase: context.expectedBase, launchRoot: context.launchRoot,
      formalAttemptId: attempt.attemptId, formalAttemptNumber: policy.attemptNumber, startedAt: attempt.startedAt,
      replacementReason: attempt.replacementReason, repositoryRoot, repositoryIdentity: context.repositoryIdentity, cwd, suiteManifest, host, runtimeIdentities,
      lanes: FORMAL_FULL_PROFILE.lanes.map((lane) => ({ id: lane.id, status: "NOT_RUN" })) };
    for (const [index, identity] of runtimeIdentities.entries()) {
      const lane = provisional.lanes[index];
      lane.status = "blocked";
      const laneEnv = environments[index];
      lane.environment = { id: "formal-minimal-v1", digest: hash(JSON.stringify(laneEnv)), variables: Object.keys(laneEnv).sort(),
        state: laneEnv.SBW_STATE_ROOT, npmCache: laneEnv.NPM_CONFIG_CACHE, temporary: laneEnv.TMPDIR };
      try {
        await assertSlot(context, operation);
        lane.runtimeBefore = await observeFormalRuntime({ nodePath: request.nodePaths[lane.id], laneId: lane.id, operation, cwd, env: laneEnv });
        assertSameFormalRuntime(identity, lane.runtimeBefore);
        const args = ["-dimsu", "/usr/bin/env", `PATH=${pathValue}`, `SBW_STATE_ROOT=${laneEnv.SBW_STATE_ROOT}`,
          `NPM_CONFIG_CACHE=${laneEnv.NPM_CONFIG_CACHE}`, `TMPDIR=${laneEnv.TMPDIR}`, "GIT_OPTIONAL_LOCKS=0", identity.path, scriptPath, "eval", "--formal-child"];
        await assertSlot(context, operation);
        lane.captureIndex = operation.snapshot().captures.length;
        let terminal;
        try { terminal = await operation.capture("/usr/bin/caffeinate", args, { cwd, env: laneEnv, lane: true, maxOutputBytes: MAX_LANE_OUTPUT_BYTES }); }
        catch (error) { terminal = error.execution; lane.terminal = terminalReceipt(terminal, terminal ? suiteResult(terminal) : null); throw error; }
        const result = suiteResult(terminal);
        lane.terminal = terminalReceipt(terminal, result);
        await assertSlot(context, operation);
        lane.runtimeAfter = await observeFormalRuntime({ nodePath: request.nodePaths[lane.id], laneId: lane.id, operation, cwd, env: laneEnv });
        assertSameFormalRuntime(identity, lane.runtimeAfter);
        await processObservation(operation, request, cwd, env);
        const postIdentity = await repositoryIdentity();
        const head = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
        const clean = !(await git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"]));
        const postManifest = await checked(operation, "suite postflight", () => captureFormalSuiteManifest({ repositoryRoot, scriptPath }));
        const postHost = await hostObservation(operation, cwd, env);
        lane.postflight = { head, clean, repositoryIdentity: postIdentity, host: postHost, suiteManifest: postManifest, suitesUnchanged: same(postManifest, suiteManifest),
          completeCoverage: completeSuiteObservations(result, suiteManifest, { repositoryRoot, cwd, nodePath: identity.path }) };
        if (formalCaptureSucceeded(terminal) && terminal.stderr === "" && result?.ok === true && head === context.expectedHead && clean &&
            postIdentity === context.repositoryIdentity && lane.postflight.suitesUnchanged && lane.postflight.completeCoverage && formalHostStable(host, postHost)) lane.status = "passed";
      } catch (error) { lane.error = String(error.message ?? "Full formal lane failed"); }
      if (lane.status !== "passed") break;
    }
    // Interruptions/unknown cleanup cannot be converted into a normal ack.
    operation.assertWithinDeadline();
    provisional.operation = operation.snapshot();
    context.provisionalDigest = await writeState(path.join(context.launchRoot, "provisional.json"), provisional, context, operation);
    attempt.phase = "awaiting-outer";
    context.ledgerDigest = await writeState(context.ledgerPath, ledger, context, operation);
    await assertSlot(context, operation);
    const elapsedMs = operation.assertWithinDeadline();
    return { schemaVersion: 1, kind: "FullFormalCoordinatorAckV1", profileId: FORMAL_FULL_PROFILE.id,
      expectedHead: context.expectedHead, expectedBase: context.expectedBase, operationNonce: context.operationNonce,
      outerOwnerPid: context.outerOwnerPid, launchRoot: context.launchRoot, provisionalDigest: context.provisionalDigest,
      ledgerDigest: context.ledgerDigest, slotDigest: context.slotDigest, context, coordinatorElapsedMs: elapsedMs,
      qualification: "NOT_COMMITTED", operationCompletion: "NOT_OBSERVED", releaseEligible: false };
  } catch (error) {
    // Useful to the outer supervisor for scoped recovery; never cleanup proof.
    error.coordinator = { context, reserved, operation: operation.snapshot(), releaseEligible: false };
    throw error;
  } finally { operation.dispose(); }
}
