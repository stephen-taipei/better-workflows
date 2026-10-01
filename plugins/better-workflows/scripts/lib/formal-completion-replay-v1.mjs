// SPDX-License-Identifier: AGPL-3.0-only
// Shared replay of captured JSON data. No filesystem, current UID, process
// launch, signing, or publication authority is observed or granted here.
import { createHash } from "node:crypto";
import path from "node:path";
import { formalEvaluatorState, classifyFormalAttemptFailure } from "./formal-evaluator.mjs";
import { formalHostStable } from "./formal-host-power.mjs";
import { createFormalSuiteEnvironment } from "./formal-environment.mjs";
import { FORMAL_FULL_PROFILE, FORMAL_OPERATION_TIMEOUT_MS, FORMAL_OPERATION_RESERVE_MS } from "./formal-operation.mjs";
import { formalPassedClosureV1 } from "./formal-passed-closure-v1.mjs";
import { parseStrictJsonV1 } from "./strict-json-v1.mjs";

const { serializedReceipt, completeSuiteObservations, completeSuiteCleanupObservations } = formalEvaluatorState;
const parseTerminalJson = (text) => parseStrictJsonV1(text, { maxBytes: formalEvaluatorState.maxOutputBytes });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{32}$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const absolute = (p) => typeof p === "string" && path.isAbsolute(p) && path.resolve(p) === p;
const unknown = () => ({ schemaVersion: 1, failureClass: "UNKNOWN", eligibleReplacementReason: null });
const cutoff = FORMAL_OPERATION_TIMEOUT_MS - FORMAL_OPERATION_RESERVE_MS;
const isoTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function requireContext(context) {
  if (!context || !SHA.test(context.expectedHead ?? "") || !SHA.test(context.expectedBase ?? "") ||
      !NONCE.test(context.operationNonce ?? "") || !Number.isSafeInteger(context.outerOwnerPid) || context.outerOwnerPid < 1 ||
      !absolute(context.launchRoot) || !/^\/private\/tmp\/bw-[A-Za-z0-9._-]+-formal-eval-[A-Za-z0-9._-]+$/.test(context.launchRoot) ||
      !absolute(context.ownerHome) || typeof context.repositoryIdentity !== "string" ||
      !/^(github:|origin-digest:|common:)[^\0\r\n]+$/.test(context.repositoryIdentity) ||
      context.ledgerPath !== path.join(context.ownerHome, ".better-workflows", "formal-evaluations", hash(context.repositoryIdentity), `${context.expectedHead}.json`) ||
      !/^\/private\/tmp\/bw-formal-evaluator-(?:0|[1-9][0-9]*)\.lock$/.test(context.slotPath ?? "") ||
      ![context.ledgerDigest, context.slotDigest, context.provisionalDigest].every((v) => DIGEST.test(v ?? ""))) {
    throw new Error("Full formal commit requires exact source, owner, slot, ledger and provisional bindings");
  }
  return { provisional: path.join(context.launchRoot, "provisional.json"),
    receipt: path.join(context.launchRoot, "receipt.json"), intent: path.join(context.launchRoot, "commit-intent.json") };
}

function bindings(value, context) {
  return value?.operationNonce === context.operationNonce && value.outerOwnerPid === context.outerOwnerPid &&
    value.expectedHead === context.expectedHead && value.expectedBase === context.expectedBase &&
    value.launchRoot === context.launchRoot && value.profileId === FORMAL_FULL_PROFILE.id;
}

function validRuntime(value, index) {
  const lane = FORMAL_FULL_PROFILE.lanes[index];
  return value?.laneId === lane.id && value.nodeVersion === lane.nodeVersion &&
    value.platform === FORMAL_FULL_PROFILE.platform && value.arch === FORMAL_FULL_PROFILE.arch &&
    absolute(value.path) && DIGEST.test(value.executableSha256 ?? "");
}

function capturePassed(terminal) {
  return terminal?.exitStatusObserved === true && terminal.exitCode === 0 && terminal.signal === null &&
    terminal.timedOut === false && terminal.outputExceeded === false && terminal.groupTerminated === true &&
    DIGEST.test(terminal.stdoutSha256 ?? "") && DIGEST.test(terminal.stderrSha256 ?? "");
}

function captureCompleted(terminal) {
  return terminal?.exitStatusObserved === true && Number.isSafeInteger(terminal.pid) && terminal.pid > 0 &&
    Number.isSafeInteger(terminal.exitCode) && terminal.exitCode >= 0 && terminal.signal === null &&
    terminal.timedOut === false && terminal.outputExceeded === false && terminal.groupTerminated === true &&
    DIGEST.test(terminal.stdoutSha256 ?? "") && DIGEST.test(terminal.stderrSha256 ?? "");
}

function operationClean(value, acceptTerminal = capturePassed) {
  return value?.schemaVersion === 1 && value.authority === "none" && value.timeoutMs === FORMAL_OPERATION_TIMEOUT_MS &&
    value.cleanupReserveMs === FORMAL_OPERATION_RESERVE_MS && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 &&
    value.elapsedMs < cutoff && value.stopReason === null && value.activeCaptures === 0 && value.cleanupConfirmed === true &&
    Array.isArray(value.captures) && value.captures.length > 0 &&
    Array.from(value.captures).every((item, i) => acceptTerminal(item?.terminal) &&
      Array.isArray(item.command) && item.command.length > 0 && absolute(item.command[0]) &&
      Array.from(item.command).every((part) => typeof part === "string" && !part.includes("\0")) &&
      Number.isFinite(item.startedElapsedMs) && Number.isFinite(item.finishedElapsedMs) &&
      item.startedElapsedMs >= (i === 0 ? 0 : value.captures[i - 1].finishedElapsedMs) &&
      item.finishedElapsedMs >= item.startedElapsedMs && item.finishedElapsedMs <= value.elapsedMs);
}

// A normal failed suite can finish all owned groups without qualifying. This
// predicate is for owned cleanup only, never for PASS or replacement admission.
export function inspectFullFormalCleanup(value, context) {
  requireContext(context);
  validateProvisional(value, context);
  if (!operationClean(value.operation, captureCompleted)) return false;
  const capturedLanes = value.operation.captures.filter(item => item.command[0] === "/usr/bin/caffeinate");
  const lanes = value.lanes.filter(lane => lane.status !== "NOT_RUN");
  if (capturedLanes.length !== lanes.length || new Set(lanes.map(lane => lane.captureIndex)).size !== lanes.length) return false;
  return value.lanes.every((lane, index) => {
    if (lane.status === "NOT_RUN") return lane.captureIndex === undefined;
    const observed = value.operation.captures[lane.captureIndex], terminal = lane.terminal;
    const keys = ["pid", "exitStatusObserved", "exitCode", "signal", "timedOut", "outputExceeded", "groupTerminated", "stdoutSha256", "stderrSha256"];
    if (!Number.isSafeInteger(lane.captureIndex) || lane.captureIndex < 0 ||
        (index > 0 && lane.captureIndex <= value.lanes[index - 1].captureIndex) ||
        !captureCompleted(terminal) || !observed || !keys.every(key => observed.terminal?.[key] === terminal[key]) ||
        !same(observed.command.slice(-4), [value.runtimeIdentities[index].path,
          path.join(value.repositoryRoot, "plugins/better-workflows/scripts/sbw.mjs"), "eval", "--formal-child"]) ||
        !laneEnvironmentMatches(value, lane, observed.command) ||
        typeof terminal.stdout !== "string" || typeof terminal.stderr !== "string" ||
        terminal.stdoutSha256 !== hash(terminal.stdout) || terminal.stderrSha256 !== hash(terminal.stderr)) return false;
    let result;
    try { result = parseTerminalJson(terminal.exitCode === 0 ? terminal.stdout : terminal.stderr); } catch { return false; }
    return (terminal.exitCode === 0 ? terminal.stderr === "" && result?.ok === true : terminal.stdout === "" && result?.ok === false) &&
      same(result, terminal.result) && completeSuiteCleanupObservations(result, value.suiteManifest,
        { repositoryRoot: value.repositoryRoot, cwd: value.cwd, nodePath: value.runtimeIdentities[index].path });
  });
}

function validateProvisional(value, context) {
  const files = value?.suiteManifest?.files;
  if (value?.schemaVersion !== 2 || value.kind !== "FullFormalProvisionalV1" || value.status !== "running" ||
      value.phase !== "awaiting-outer" || !bindings(value, context) ||
      value.repositoryIdentity !== context.repositoryIdentity ||
      !absolute(value.repositoryRoot) || !absolute(value.cwd) || !isoTime(value.startedAt) ||
      !Array.isArray(files) || files.length < 1 ||
      !Array.from(files).every((file) => /^plugins\/better-workflows\/scripts\/tests\/[^/]+\.test\.mjs$/.test(file?.path ?? "") && DIGEST.test(file?.sha256 ?? "")) ||
      !same(files.map((f) => f.path), [...new Set(files.map((f) => f.path))].sort()) ||
      value.suiteManifest.digest !== hash(JSON.stringify(files)) ||
      !Array.isArray(value.runtimeIdentities) || value.runtimeIdentities.length !== 2 ||
      !Array.from(value.runtimeIdentities).every(validRuntime) || value.runtimeIdentities[0].path === value.runtimeIdentities[1].path ||
      !Array.isArray(value.lanes) || value.lanes.length !== 2 ||
      !Array.from(value.lanes).every((lane, i) => lane?.id === FORMAL_FULL_PROFILE.lanes[i].id && ["passed", "blocked", "NOT_RUN"].includes(lane.status)) ||
      value.host?.platform !== "darwin" || !formalHostStable(value.host, value.host)) {
    throw new Error("Full formal provisional schema, profile, source, runtime or lane bindings are invalid");
  }
  const relative = path.relative(value.repositoryRoot, value.cwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Full formal cwd escapes source");
  let stopped = false;
  for (const lane of value.lanes) {
    if (stopped && lane.status !== "NOT_RUN") throw new Error("Full formal dispatched a lane after failure");
    if (lane.status === "NOT_RUN" && (lane.terminal != null || lane.postflight != null || lane.runtimeBefore != null || lane.runtimeAfter != null)) {
      throw new Error("Full formal NOT_RUN lane contains execution observations");
    }
    if (lane.status !== "passed") stopped = true;
  }
}

function laneComplete(value, lane, index) {
  const post = lane.postflight;
  const observed = value.operation?.captures?.[lane.captureIndex];
  const terminalKeys = ["pid", "exitStatusObserved", "exitCode", "signal", "timedOut", "outputExceeded", "groupTerminated", "stdoutSha256", "stderrSha256"];
  let parsed;
  try { parsed = parseTerminalJson(lane.terminal?.stdout); } catch { return false; }
  return Number.isSafeInteger(lane.captureIndex) && lane.captureIndex >= 0 &&
    (index === 0 || lane.captureIndex > value.lanes[index - 1].captureIndex) &&
    observed?.command?.[0] === "/usr/bin/caffeinate" &&
    same(observed.command.slice(-4), [value.runtimeIdentities[index].path,
      path.join(value.repositoryRoot, "plugins/better-workflows/scripts/sbw.mjs"), "eval", "--formal-child"]) &&
    laneEnvironmentMatches(value, lane, observed.command) &&
    terminalKeys.every((key) => observed.terminal?.[key] === lane.terminal?.[key]) &&
    same(lane.runtimeBefore, value.runtimeIdentities[index]) && same(lane.runtimeAfter, value.runtimeIdentities[index]) &&
    capturePassed(lane.terminal) && lane.terminal.result?.ok === true &&
    lane.terminal.stderr === "" && lane.terminal.stdoutSha256 === hash(lane.terminal.stdout) &&
    lane.terminal.stderrSha256 === hash("") && same(parsed, lane.terminal.result) &&
    post?.head === value.expectedHead && post.clean === true && post.suitesUnchanged === true && post.completeCoverage === true &&
    post.repositoryIdentity === value.repositoryIdentity &&
    same(post.suiteManifest, value.suiteManifest) &&
    completeSuiteObservations(lane.terminal.result, value.suiteManifest,
      { repositoryRoot: value.repositoryRoot, cwd: value.cwd, nodePath: value.runtimeIdentities[index].path });
}

function laneEnvironmentMatches(value, lane, command) {
  try {
    const pathValue = command[3]?.startsWith("PATH=") ? command[3].slice(5) : null;
    const root = path.join(value.launchRoot, lane.id);
    const env = createFormalSuiteEnvironment(pathValue, { SBW_STATE_ROOT: path.join(root, "state"),
      NPM_CONFIG_CACHE: path.join(root, "npm-cache"), TMPDIR: path.join(root, "tmp") });
    return same(command.slice(0, -4), ["/usr/bin/caffeinate", "-dimsu", "/usr/bin/env", `PATH=${pathValue}`,
      `SBW_STATE_ROOT=${env.SBW_STATE_ROOT}`, `NPM_CONFIG_CACHE=${env.NPM_CONFIG_CACHE}`, `TMPDIR=${env.TMPDIR}`, "GIT_OPTIONAL_LOCKS=0"]) &&
      lane.environment?.id === "formal-minimal-v1" && lane.environment.digest === hash(JSON.stringify(env)) &&
      same(lane.environment.variables, Object.keys(env).sort()) && lane.environment.state === env.SBW_STATE_ROOT &&
      lane.environment.npmCache === env.NPM_CONFIG_CACHE && lane.environment.temporary === env.TMPDIR;
  } catch { return false; }
}

// This is replay of unsigned observations. The caller still needs the outer
// terminalizer result/cleanup, and release needs independent authenticated facts.
export function inspectFullFormalProvisional(value, context) {
  requireContext(context);
  validateProvisional(value, context);
  const classes = value.lanes.map((lane, i) => classifyFormalAttemptFailure({ schemaVersion: 1, status: "blocked",
    expectedHead: value.expectedHead, repositoryRoot: value.repositoryRoot, cwd: value.cwd,
    executables: { node: value.runtimeIdentities[i].path }, suiteManifest: value.suiteManifest,
    host: value.host, terminal: lane.terminal, postflight: lane.postflight }));
  let classification = unknown();
  if (classes.some((c) => c.failureClass === "SOURCE_OR_TEST_FAILURE")) classification = classes.find((c) => c.failureClass === "SOURCE_OR_TEST_FAILURE");
  if (value.lanes.some((lane) => typeof lane.postflight?.repositoryIdentity === "string" && lane.postflight.repositoryIdentity !== value.repositoryIdentity)) {
    classification = { schemaVersion: 1, failureClass: "SOURCE_OR_TEST_FAILURE", eligibleReplacementReason: null };
  }
  const passed = classification.failureClass !== "SOURCE_OR_TEST_FAILURE" && formalPassedClosureV1(value) &&
    value.lanes.every((lane, i) => laneComplete(value, lane, i) && formalHostStable(value.host, lane.postflight.host));
  if (passed) classification = null;
  else if (classification.failureClass !== "SOURCE_OR_TEST_FAILURE" && operationClean(value.operation)) {
    const failedIndex = value.lanes.findIndex((lane) => lane.status === "blocked");
    if (failedIndex >= 0 && classes[failedIndex].eligibleReplacementReason === "host-sleep" &&
        value.lanes.every((lane, i) => i > failedIndex ? lane.status === "NOT_RUN" :
          laneComplete(value, lane, i) && (i === failedIndex || formalHostStable(value.host, lane.postflight.host)))) {
      classification = classes[failedIndex];
    }
  }
  return { status: passed ? "passed" : "blocked", failureClassification: classification, authority: "none" };
}

function validateOuter(supervision, context) {
  const terminal = supervision?.terminal;
  if (supervision?.schemaVersion !== 1 || supervision.authority !== "none" || !capturePassed(terminal) ||
      !Number.isFinite(supervision.elapsedMs) || supervision.elapsedMs < 0 || supervision.elapsedMs >= cutoff || !isoTime(supervision.observedAt) ||
      typeof terminal.stdout !== "string" || terminal.stderr !== "" ||
      terminal.stdoutSha256 !== hash(terminal.stdout) || terminal.stderrSha256 !== hash(terminal.stderr)) {
    throw new Error("Full formal outer capture is incomplete; nested cleanup cannot be inferred");
  }
  let reply;
  try { reply = parseTerminalJson(terminal.stdout); } catch { throw new Error("Full formal coordinator acknowledgement is invalid"); }
  if (reply?.schemaVersion !== 1 || reply.kind !== "FullFormalCoordinatorAckV1" || reply.provisionalDigest !== context.provisionalDigest ||
      reply.ledgerDigest !== context.ledgerDigest || reply.slotDigest !== context.slotDigest || !bindings(reply, context)) {
    throw new Error("Full formal outer acknowledgement does not bind this provisional observation");
  }
}

function boundStateFor(context, { slot = null, ledger, provisional }, { requireRunning = true, requireSlot = true } = {}) {
  const names = requireContext(context);
  if ((requireSlot && (slot?.receiptDigest !== context.slotDigest || slot.receipt?.schemaVersion !== 2 || slot.receipt.kind !== "FullFormalSlotV1" ||
      slot.receipt.ownerPid !== context.outerOwnerPid || slot.receipt.operationNonce !== context.operationNonce || slot.receipt.launchRoot !== context.launchRoot)) ||
      provisional?.receiptDigest !== context.provisionalDigest || ledger?.receipt?.schemaVersion !== 1 || ledger.receipt.head !== context.expectedHead ||
      !Array.isArray(ledger.receipt.attempts) || ledger.receipt.attempts.length < 1 || ledger.receipt.attempts.length > 2) {
    throw new Error("Full formal slot, ledger or provisional bytes drifted");
  }
  const attempts = ledger.receipt.attempts;
  const attempt = attempts.at(-1);
  const expectedId = `formal-${hash(`${context.expectedHead}\0${context.launchRoot}`).slice(0, 24)}`;
  if (!attempt || attempt.attemptId !== expectedId || attempt.launchRoot !== context.launchRoot || attempt.receiptPath !== names.receipt ||
      attempt.profileId !== FORMAL_FULL_PROFILE.id || attempt.operationNonce !== context.operationNonce || attempt.outerOwnerPid !== context.outerOwnerPid ||
      provisional.receipt.formalAttemptId !== expectedId || provisional.receipt.formalAttemptNumber !== attempts.length ||
      !isoTime(attempt.startedAt) || provisional.receipt.startedAt !== attempt.startedAt || attempts.slice(0, -1).some((a) => a?.status !== "blocked") ||
      hash(serializedReceipt(ledger.receipt)) !== ledger.receiptDigest ||
      (requireRunning && ["finishedAt", "terminalReceiptDigest", "failureClassification"].some((key) => Object.hasOwn(attempt, key))) ||
      (requireRunning && (ledger.receiptDigest !== context.ledgerDigest || attempt.status !== "running" || attempt.phase !== "awaiting-outer"))) {
    throw new Error("Full formal attempt owner, budget or commit phase is invalid");
  }
  return { names, slot, ledger, provisional, attempt };
}

function aggregateFor(state, context, supervision) {
  validateOuter(supervision, context);
  const inspected = inspectFullFormalProvisional(state.provisional.receipt, context);
  if (supervision.elapsedMs < state.provisional.receipt.operation?.elapsedMs ||
      Date.parse(supervision.observedAt) < Date.parse(state.attempt.startedAt)) {
    throw new Error("Full formal outer observation predates the coordinator");
  }
  return { schemaVersion: 2, kind: "FullFormalAggregateV1", profileId: FORMAL_FULL_PROFILE.id,
    ...inspected, operationNonce: context.operationNonce, outerOwnerPid: context.outerOwnerPid,
    expectedHead: context.expectedHead, expectedBase: context.expectedBase, launchRoot: context.launchRoot,
    formalAttemptId: state.attempt.attemptId, formalAttemptNumber: state.ledger.receipt.attempts.length,
    startedAt: state.attempt.startedAt, finishedAt: supervision.observedAt, provisionalDigest: context.provisionalDigest,
    provisional: state.provisional.receipt, supervision,
    authentication: { status: "unsigned-local-observation", releaseEligible: false },
    operationCompletion: "NOT_OBSERVED" };
}

function committedLedger(original, aggregate, receiptDigest) {
  const ledger = structuredClone(original);
  Object.assign(ledger.attempts.at(-1), { status: aggregate.status, phase: "qualification-committed",
    finishedAt: aggregate.finishedAt, terminalReceiptDigest: receiptDigest, failureClassification: aggregate.failureClassification });
  return ledger;
}

function intentFor(original, aggregate, context) {
  const receiptDigest = hash(serializedReceipt(aggregate));
  return { schemaVersion: 1, kind: "FullFormalCommitIntentV1", operationNonce: context.operationNonce,
    outerOwnerPid: context.outerOwnerPid, launchRoot: context.launchRoot, ledgerDigest: context.ledgerDigest,
    provisionalDigest: context.provisionalDigest, receiptDigest,
    committedLedgerDigest: hash(serializedReceipt(committedLedger(original, aggregate, receiptDigest))),
    originalLedger: original };
}

function releaseNames(context) {
  requireContext(context);
  const identity = context.slotIdentity;
  if (!identity || Object.keys(identity).sort().join(",") !== "dev,ino,mode,nlink,size,uid" ||
      !Object.values(identity).every(v => Number.isSafeInteger(v) && v >= 0) || identity.ino < 1 ||
      identity.size < 1 || identity.size > 4096 || context.slotPath !== `/private/tmp/bw-formal-evaluator-${identity.uid}.lock` || identity.nlink !== 1 ||
      (identity.mode & 0o777) !== 0o600) throw new Error("Full formal release requires the original private slot identity");
  return { intent: path.join(context.launchRoot, "release-intent.json"), record: path.join(context.launchRoot, "slot-release.json") };
}

function validateCommitObservation(observation, supervision, context, committed) {
  const t = observation?.terminal;
  if (observation?.schemaVersion !== 1 || observation.authority !== "none" || !capturePassed(t) ||
      !Number.isSafeInteger(t.pid) || t.pid < 1 || typeof t.stdout !== "string" || t.stderr !== "" ||
      t.stdoutSha256 !== hash(t.stdout) || t.stderrSha256 !== hash("") ||
      !Number.isFinite(observation.elapsedMs) || observation.elapsedMs < supervision.elapsedMs || observation.elapsedMs >= cutoff ||
      !isoTime(observation.observedAt) || Date.parse(observation.observedAt) < Date.parse(supervision.observedAt)) {
    throw new Error("Full formal commit-worker terminal or cleanup is incomplete");
  }
  let ack;
  try { ack = parseTerminalJson(t.stdout); } catch { throw new Error("Full formal commit acknowledgement is invalid"); }
  if (ack?.schemaVersion !== 1 || ack.kind !== "FullFormalCommitAckV1" || ack.operationNonce !== context.operationNonce ||
      ack.receiptDigest !== committed.receiptDigest || ack.ledgerDigest !== committed.ledgerDigest || ack.durableCommit !== true ||
      ack.qualificationStatus !== committed.aggregate.status || ack.operationCompletion !== "NOT_OBSERVED" || ack.releaseEligible !== false) {
    throw new Error("Full formal commit acknowledgement does not match durable state");
  }
}

function releaseIntentFor(context, supervision, commitObservation, committed) {
  validateCommitObservation(commitObservation, supervision, context, committed);
  return { schemaVersion: 1, kind: "FullFormalReleaseIntentV1", context, supervision, commitObservation,
    receiptDigest: committed.receiptDigest, ledgerDigest: committed.ledgerDigest,
    qualificationStatus: committed.aggregate.status, operationCompletion: "NOT_OBSERVED", releaseEligible: false };
}

function releaseRecordFor(intent, releasedAt) {
  if (!isoTime(releasedAt) || Date.parse(releasedAt) < Date.parse(intent.commitObservation.observedAt)) {
    throw new Error("Full formal release timestamp predates commit-worker observation");
  }
  return { schemaVersion: 1, kind: "FullFormalSlotReleaseV1", intentDigest: hash(serializedReceipt(intent)),
    operationNonce: intent.context.operationNonce, outerOwnerPid: intent.context.outerOwnerPid,
    launchRoot: intent.context.launchRoot, slotDigest: intent.context.slotDigest, slotIdentity: intent.context.slotIdentity,
    receiptDigest: intent.receiptDigest, ledgerDigest: intent.ledgerDigest, qualificationStatus: intent.qualificationStatus,
    unlinkObserved: true, directorySyncObserved: true, releasedAt, operationCompletion: "NOT_OBSERVED", releaseEligible: false };
}


function committedReleaseStateFor(state, context, supervision, intent, receipt, currentLedger) {
  const aggregate = aggregateFor(state, context, supervision);
  if (!same(parseTerminalJson(supervision.terminal.stdout).context, context)) {
    throw new Error("Full formal release context differs from coordinator acquisition evidence");
  }
  const receiptDigest = hash(serializedReceipt(aggregate));
  const original = intent?.receipt?.originalLedger;
  if (!original || hash(serializedReceipt(original)) !== context.ledgerDigest ||
      intent.receiptDigest !== hash(serializedReceipt(intentFor(original, aggregate, context)))) {
    throw new Error("Full formal release has no matching commit intent");
  }
  if (receipt?.receiptDigest !== receiptDigest) {
    throw new Error("Full formal release aggregate readback conflicts with the bound operation");
  }
  const ledger = committedLedger(original, aggregate, receiptDigest);
  const ledgerDigest = hash(serializedReceipt(ledger));
  if (currentLedger?.receiptDigest !== ledgerDigest) {
    throw new Error("Full formal release committed ledger readback conflicts with the bound operation");
  }
  if (!inspectFullFormalCleanup(state.provisional.receipt, context)) throw new Error("Full formal nested cleanup is incomplete");
  return { state, aggregate, receiptDigest, ledgerDigest };
}

function releaseStateFor(context, supervision, commitObservation, committed, intent, record) {
  const expected = releaseIntentFor(context, supervision, commitObservation, committed);
  if (intent && intent.receiptDigest !== hash(serializedReceipt(expected))) throw new Error("Full formal release intent conflicts with this operation");
  if (record && !intent) throw new Error("Full formal release record has no intent");
  if (record && record.receiptDigest !== hash(serializedReceipt(releaseRecordFor(expected, record.receipt?.releasedAt)))) {
    throw new Error("Full formal release record conflicts with this operation");
  }
  return { committed, intent, record };
}

function validateCompletion(value, expectedContext) {
  const context = value?.context;
  requireContext(context);
  if (!["expectedHead", "expectedBase", "ownerHome", "repositoryIdentity", "ledgerPath"].every(key =>
      typeof expectedContext?.[key] === "string" && context[key] === expectedContext[key]) ||
      value.schemaVersion !== 1 || value.kind !== "FullFormalCompletionV1" || value.profileId !== FORMAL_FULL_PROFILE.id ||
      value.authority !== "none" || value.releaseEligible !== false || value.operationCompletion !== "OBSERVED" ||
      !["passed", "blocked"].includes(value.qualificationStatus) || !operationClean(value.operation) || value.operation.captures.length !== 3) {
    throw new Error("Full formal completion has no matching source, repository or complete operation");
  }
  return context;
}

function completionReplayFor(value, expectedContext, { committed, intent, record }) {
  const context = validateCompletion(value, expectedContext);
  if (!intent || !record || value.qualificationStatus !== committed.aggregate.status) {
    throw new Error("Full formal completion has no durable owned release");
  }
  const observations = [value.supervision, value.commitObservation, value.releaseObservation];
  const captures = value.operation.captures;
  const scripts = ["formal-coordinator-worker.mjs", "formal-commit-worker.mjs", "formal-commit-worker.mjs"];
  const terminalKeys = ["pid", "exitStatusObserved", "exitCode", "signal", "timedOut", "outputExceeded", "groupTerminated", "stdoutSha256", "stderrSha256"];
  for (let index = 0; index < observations.length; index++) {
    const observed = observations[index], captured = captures[index], t = observed?.terminal;
    if (observed?.schemaVersion !== 1 || observed.authority !== "none" || !capturePassed(t) ||
        !Number.isSafeInteger(t.pid) || t.pid < 1 || typeof t.stdout !== "string" || t.stderr !== "" ||
        t.stdoutSha256 !== hash(t.stdout) || t.stderrSha256 !== hash("") ||
        !isoTime(observed.observedAt) || (index > 0 && Date.parse(observed.observedAt) < Date.parse(observations[index - 1].observedAt)) ||
        !Number.isFinite(observed.elapsedMs) || observed.elapsedMs < captured.finishedElapsedMs ||
        observed.elapsedMs > (index < 2 ? captures[index + 1].startedElapsedMs : value.operation.elapsedMs) ||
        !terminalKeys.every(key => captured.terminal[key] === t[key]) ||
        captured.kind !== (index === 0 ? "coordinator" : "probe") || captured.command.length !== 2 ||
        captured.command[0] !== captures[0].command[0] ||
        captured.command[1] !== path.join(committed.state.provisional.receipt.repositoryRoot, "plugins/better-workflows/scripts", scripts[index])) {
      throw new Error("Full formal completion phase terminal, command or timing is incomplete");
    }
  }
  const coordinatorAck = parseTerminalJson(value.supervision.terminal.stdout);
  if (coordinatorAck.qualification !== "NOT_COMMITTED" || coordinatorAck.operationCompletion !== "NOT_OBSERVED" ||
      coordinatorAck.releaseEligible !== false || !Number.isFinite(coordinatorAck.coordinatorElapsedMs) ||
      coordinatorAck.coordinatorElapsedMs < committed.state.provisional.receipt.operation.elapsedMs ||
      coordinatorAck.coordinatorElapsedMs > captures[0].finishedElapsedMs - captures[0].startedElapsedMs ||
      coordinatorAck.coordinatorElapsedMs > value.supervision.elapsedMs) {
    throw new Error("Full formal completion coordinator acknowledgement is inconsistent");
  }
  const commitAck = parseTerminalJson(value.commitObservation.terminal.stdout);
  const releaseAck = parseTerminalJson(value.releaseObservation.terminal.stdout);
  if (!same(value.committed, commitAck) || !same(value.released, releaseAck) ||
      releaseAck?.schemaVersion !== 1 || releaseAck.kind !== "FullFormalReleaseAckV1" ||
      releaseAck.operationNonce !== context.operationNonce || releaseAck.slotReleased !== true ||
      releaseAck.releaseRecordDigest !== record.receiptDigest || releaseAck.releaseIntentDigest !== intent.receiptDigest ||
      releaseAck.receiptDigest !== committed.receiptDigest || releaseAck.ledgerDigest !== committed.ledgerDigest ||
      releaseAck.qualificationStatus !== committed.aggregate.status || releaseAck.operationCompletion !== "NOT_OBSERVED" ||
      releaseAck.releaseEligible !== false || Date.parse(value.releaseObservation.observedAt) < Date.parse(record.receipt.releasedAt)) {
    throw new Error("Full formal completion acknowledgement differs from durable release");
  }
  return { schemaVersion: 1, kind: "FullFormalCompletionReplayV1", profileId: FORMAL_FULL_PROFILE.id,
    authority: "none", expectedHead: context.expectedHead, expectedBase: context.expectedBase,
    formalAttemptId: committed.aggregate.formalAttemptId, formalAttemptNumber: committed.aggregate.formalAttemptNumber,
    receiptDigest: committed.receiptDigest, ledgerDigest: committed.ledgerDigest,
    qualificationStatus: committed.aggregate.status, failureClassification: committed.aggregate.failureClassification,
    operationCompletion: "OBSERVED", releaseEligible: false };
}


/** Replay a complete durable closure that the reader has already byte-bound.
 * Qualification remains an observation and confers no release authority.
 */
export function replayFullFormalCompletionArtifactsV1(completion, expectedContext, artifacts) {
  const value = structuredClone(completion);
  const captured = structuredClone(artifacts);
  const context = validateCompletion(value, expectedContext);
  releaseNames(context);
  const state = boundStateFor(context, { provisional: captured.provisional, ledger: captured.ledger },
    { requireRunning: false, requireSlot: false });
  const committed = committedReleaseStateFor(state, context, value.supervision,
    captured.commitIntent, captured.aggregate, captured.ledger);
  const released = releaseStateFor(context, value.supervision, value.commitObservation, committed,
    captured.releaseIntent, captured.releaseRecord);
  return completionReplayFor(value, expectedContext, released);
}

// Internal data predicates shared with the local filesystem adapter. Callers
// must retain that adapter's current-UID, safe-read and owned-slot checks.
export const formalCompletionReplayV1State = Object.freeze({
  requireContext, inspectFullFormalProvisional, inspectFullFormalCleanup, boundStateFor,
  aggregateFor, committedLedger, intentFor, releaseNames, releaseIntentFor, releaseRecordFor,
  committedReleaseStateFor, releaseStateFor, validateCompletion, completionReplayFor
});
