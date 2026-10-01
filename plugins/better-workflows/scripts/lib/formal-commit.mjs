// SPDX-License-Identifier: AGPL-3.0-only
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { formalEvaluatorState, evaluateFormalAttemptBudget, evaluateFormalAttemptPolicy } from "./formal-evaluator.mjs";
import { FORMAL_FULL_PROFILE } from "./formal-operation.mjs";
import { formalCompletionReplayV1State } from "./formal-completion-replay-v1.mjs";

const { atomicReceipt, readJsonIfPresent, serializedReceipt } = formalEvaluatorState;
const { requireContext: requireDataContext, inspectFullFormalCleanup: inspectDataCleanup,
  inspectFullFormalProvisional: inspectDataProvisional, boundStateFor, aggregateFor, committedLedger, intentFor,
  releaseNames: releaseDataNames, releaseIntentFor, releaseRecordFor, committedReleaseStateFor,
  releaseStateFor, validateCompletion, completionReplayFor } = formalCompletionReplayV1State;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function requireContext(context) {
  const names = requireDataContext(context);
  if (context.slotPath !== `/private/tmp/bw-formal-evaluator-${process.getuid()}.lock`) {
    throw new Error("Full formal commit requires exact source, owner, slot, ledger and provisional bindings");
  }
  return names;
}

export function inspectFullFormalCleanup(value, context) {
  requireContext(context);
  return inspectDataCleanup(value, context);
}

export function inspectFullFormalProvisional(value, context) {
  requireContext(context);
  return inspectDataProvisional(value, context);
}

async function readBoundState(context, { requireRunning = true, requireSlot = true } = {}) {
  const names = requireContext(context);
  const slot = requireSlot ? await readJsonIfPresent(context.slotPath, { withDigest: true }) : null;
  const ledger = await readJsonIfPresent(context.ledgerPath, { withDigest: true });
  const provisional = await readJsonIfPresent(names.provisional, { withDigest: true });
  return boundStateFor(context, { slot, ledger, provisional }, { requireRunning, requireSlot });
}

async function createIntent(target, value) {
  const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(serializedReceipt(value), "utf8"); await handle.sync(); } finally { await handle.close(); }
  const directory = await open(path.dirname(target), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readExact(target, expected, label) {
  const observed = await readJsonIfPresent(target, { withDigest: true });
  if (observed?.receiptDigest !== hash(serializedReceipt(expected))) throw new Error(`Full formal ${label} readback conflicts with the bound operation`);
  return observed;
}

/** File-only terminalization. Never releases the outer-owned slot or starts a
 * child. A durable receipt/ledger pair is not proof of this process's cleanup.
 * After any mutation failure the caller must reconcile, never retry blindly.
 */
export async function commitFullFormalAggregate(context, supervision) {
  context = structuredClone(context);
  supervision = structuredClone(supervision);
  const state = await readBoundState(context);
  const aggregate = aggregateFor(state, context, supervision);
  const receiptDigest = hash(serializedReceipt(aggregate));
  const ledger = committedLedger(state.ledger.receipt, aggregate, receiptDigest);
  const intent = intentFor(state.ledger.receipt, aggregate, context);
  // Nesting an otherwise bounded input can grow it past the reader's limit.
  // Reject before intent creation so all durable states remain reconcilable.
  for (const [label, value] of [["aggregate", aggregate], ["intent", intent], ["ledger", ledger]]) {
    if (Buffer.byteLength(serializedReceipt(value), "utf8") > formalEvaluatorState.maxBytes) {
      throw new Error(`Full formal ${label} exceeds the bounded state size`);
    }
  }
  if (await readJsonIfPresent(state.names.receipt, { withDigest: true }) || await readJsonIfPresent(state.names.intent, { withDigest: true })) {
    throw new Error("Full formal commit already has durable state; use read-only reconciliation");
  }
  try {
    // Exclusive intent is the single-writer admission boundary. Once attempted,
    // even a filesystem error can have an unknown durable outcome.
    await createIntent(state.names.intent, intent);
    await readBoundState(context);
    await readExact(state.names.intent, intent, "intent");
    if (await readJsonIfPresent(state.names.receipt, { withDigest: true })) throw new Error("Full formal aggregate appeared during commit");
    await atomicReceipt(state.names.receipt, aggregate);
    await readBoundState(context);
    await readExact(state.names.intent, intent, "intent");
    await readExact(state.names.receipt, aggregate, "aggregate");
    await atomicReceipt(context.ledgerPath, ledger);
    await readBoundState(context, { requireRunning: false });
    await readExact(context.ledgerPath, ledger, "ledger");
    await readExact(state.names.receipt, aggregate, "aggregate");
    await readExact(state.names.intent, intent, "intent");
  } catch (cause) {
    throw Object.assign(new Error("Full formal commit outcome is unknown; use read-only reconciliation", { cause }),
      { code: "FORMAL_COMMIT_OUTCOME_UNKNOWN" });
  }
  return { schemaVersion: 1, kind: "FullFormalCommitAckV1", operationNonce: context.operationNonce,
    receiptDigest, ledgerDigest: intent.committedLedgerDigest, durableCommit: true,
    qualificationStatus: aggregate.status, operationCompletion: "NOT_OBSERVED", releaseEligible: false };
}

export async function reconcileFullFormalAggregate(context, supervision) {
  context = structuredClone(context);
  supervision = structuredClone(supervision);
  const state = await readBoundState(context, { requireRunning: false });
  const aggregate = aggregateFor(state, context, supervision);
  const receiptDigest = hash(serializedReceipt(aggregate));
  const receipt = await readJsonIfPresent(state.names.receipt, { withDigest: true });
  const intent = await readJsonIfPresent(state.names.intent, { withDigest: true });
  if (intent) {
    const original = intent.receipt?.originalLedger;
    if (!original || hash(serializedReceipt(original)) !== context.ledgerDigest ||
        intent.receiptDigest !== hash(serializedReceipt(intentFor(original, aggregate, context)))) {
      throw new Error("Full formal commit intent conflicts with the bound operation");
    }
  }
  if (receipt && !intent) throw new Error("Full formal aggregate has no commit intent");
  if (receipt && receipt.receiptDigest !== receiptDigest) throw new Error("Full formal aggregate conflicts with the bound operation");
  const committed = intent && receipt && state.ledger.receiptDigest === intent.receipt.committedLedgerDigest;
  if (!committed && (state.ledger.receiptDigest !== context.ledgerDigest || state.attempt.status !== "running" || state.attempt.phase !== "awaiting-outer")) {
    throw new Error("Full formal ledger conflicts with the bound operation");
  }
  return { schemaVersion: 1, kind: "FullFormalCommitReconciliationV1", operationNonce: context.operationNonce,
    durableCommit: Boolean(committed), commitState: committed ? "committed" : receipt ? "aggregate-only" : intent ? "intent-only" : "not-started",
    receiptDigest: receipt?.receiptDigest ?? null, ledgerDigest: state.ledger.receiptDigest,
    operationCompletion: "NOT_OBSERVED", releaseEligible: false };
}

function releaseNames(context) {
  requireContext(context);
  return releaseDataNames(context);
}

function sameSlotIdentity(info, context) {
  return info.isFile() && !info.isSymbolicLink() &&
    Object.entries(context.slotIdentity).every(([key, value]) => info[key] === value);
}

// Only the release reader may omit the live slot. Its proof remains the exact
// committed aggregate + complete ledger + exclusive commit intent; absence of
// a global lock never proves release. No public option exposes this switch.
async function committedReleaseState(context, supervision, requireSlot) {
  const state = await readBoundState(context, { requireRunning: false, requireSlot });
  const intent = await readJsonIfPresent(state.names.intent, { withDigest: true });
  const receipt = await readJsonIfPresent(state.names.receipt, { withDigest: true });
  const ledger = await readJsonIfPresent(context.ledgerPath, { withDigest: true });
  return committedReleaseStateFor(state, context, supervision, intent, receipt, ledger);
}

/** Normal owned release only. Identity snapshots are not atomic compare-unlink;
 * admission never reclaims slots and the exclusive intent admits one releaser.
 * Unknown outcomes are read back, never retried. The outer process must still
 * observe this worker's actual exit, cleanup, and final operation elapsed time.
 */
export async function releaseOwnedFullFormalSlot(context, supervision, commitObservation) {
  context = structuredClone(context); supervision = structuredClone(supervision); commitObservation = structuredClone(commitObservation);
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.getuid() === 0) throw new Error("Full formal release requires the nonroot macOS host");
  const names = releaseNames(context);
  const committed = await committedReleaseState(context, supervision, true);
  const intent = releaseIntentFor(context, supervision, commitObservation, committed);
  for (const value of [intent, releaseRecordFor(intent, commitObservation.observedAt)]) {
    if (Buffer.byteLength(serializedReceipt(value)) > formalEvaluatorState.maxBytes) throw new Error("Full formal release state exceeds the bounded reader");
  }
  if (await readJsonIfPresent(names.intent, { withDigest: true }) || await readJsonIfPresent(names.record, { withDigest: true })) {
    throw new Error("Full formal release already has durable state; use read-only reconciliation");
  }
  const handle = await open(context.slotPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const verifySlot = async () => {
    if (!sameSlotIdentity(await handle.stat(), context) || !sameSlotIdentity(await lstat(context.slotPath), context)) {
      throw new Error("Full formal slot physical identity changed; refusing release");
    }
    const buffer = Buffer.alloc(context.slotIdentity.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== context.slotIdentity.size || hash(buffer.subarray(0, bytesRead)) !== context.slotDigest ||
        !sameSlotIdentity(await handle.stat(), context) || !sameSlotIdentity(await lstat(context.slotPath), context)) {
      throw new Error("Full formal slot owner bytes or identity changed; refusing release");
    }
  };
  let releaseFailure;
  try {
    await verifySlot();
    await createIntent(names.intent, intent);
    await committedReleaseState(context, supervision, true);
    await readExact(names.intent, intent, "release intent");
    await verifySlot();
    await unlink(context.slotPath);
    const directory = await open(path.dirname(context.slotPath), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    // Do not inspect/unlink the pathname again: a new owner may now hold it.
    const record = releaseRecordFor(intent, new Date().toISOString());
    await atomicReceipt(names.record, record);
    await readExact(names.intent, intent, "release intent");
    const observed = await readExact(names.record, record, "release record");
    await committedReleaseState(context, supervision, false);
    return { schemaVersion: 1, kind: "FullFormalReleaseAckV1", operationNonce: context.operationNonce,
      releaseRecordDigest: observed.receiptDigest, releaseIntentDigest: record.intentDigest,
      receiptDigest: committed.receiptDigest, ledgerDigest: committed.ledgerDigest, slotReleased: true,
      qualificationStatus: committed.aggregate.status, operationCompletion: "NOT_OBSERVED", releaseEligible: false };
  } catch (cause) {
    releaseFailure = cause;
    throw Object.assign(new Error("Full formal release outcome is unknown; use read-only reconciliation", { cause }),
      { code: "FORMAL_RELEASE_OUTCOME_UNKNOWN" });
  } finally {
    try { await handle.close(); } catch (cause) {
      throw Object.assign(new Error("Full formal release handle cleanup is unknown; use read-only reconciliation", {
        cause: releaseFailure ? new AggregateError([releaseFailure, cause], "Release and handle cleanup failed") : cause
      }), { code: "FORMAL_RELEASE_OUTCOME_UNKNOWN" });
    }
  }
}

async function readReleaseState(context, supervision, commitObservation) {
  const names = releaseNames(context);
  const committed = await committedReleaseState(context, supervision, false);
  const intent = await readJsonIfPresent(names.intent, { withDigest: true });
  const record = await readJsonIfPresent(names.record, { withDigest: true });
  return releaseStateFor(context, supervision, commitObservation, committed, intent, record);
}

export async function reconcileFullFormalRelease(context, supervision, commitObservation) {
  context = structuredClone(context); supervision = structuredClone(supervision); commitObservation = structuredClone(commitObservation);
  const { committed, intent, record } = await readReleaseState(context, supervision, commitObservation);
  return { schemaVersion: 1, kind: "FullFormalReleaseReconciliationV1", operationNonce: context.operationNonce,
    releaseState: record ? "released" : intent ? "intent-only" : "not-started", slotReleased: record ? true : null,
    releaseIntentDigest: intent?.receiptDigest ?? null, releaseRecordDigest: record?.receiptDigest ?? null,
    receiptDigest: committed.receiptDigest, ledgerDigest: committed.ledgerDigest,
    operationCompletion: "NOT_OBSERVED", releaseEligible: false };
}

/** Replay the caller-retained outer observation against durable state. This is
 * read-only and never uses the current global slot: a new owner may hold it.
 * The observation remains unsigned; replay grants no publication authority.
 */
export async function replayFullFormalCompletion(completion, expectedContext) {
  const value = structuredClone(completion);
  const context = validateCompletion(value, expectedContext);
  requireContext(context);
  const released = await readReleaseState(context, value.supervision, value.commitObservation);
  return completionReplayFor(value, expectedContext, released);
}

// The full coordinator shares the legacy attempt ceiling and v1 replay. Only
// this two-lane route can replace a v2 predecessor, and it must rerun both lanes.
export async function evaluateFullFormalAttemptPolicy(attempts, replacementReason, predecessor, completion, context) {
  const policy = evaluateFormalAttemptBudget(attempts, replacementReason);
  const previous = attempts[0];
  if (previous?.profileId !== FORMAL_FULL_PROFILE.id && predecessor?.receipt?.schemaVersion !== 2) {
    if (completion != null) throw new Error("Formal completion is only valid for a full-v2 predecessor");
    return evaluateFormalAttemptPolicy(attempts, replacementReason, predecessor);
  }
  if (previous?.profileId !== FORMAL_FULL_PROFILE.id || predecessor?.receipt?.kind !== "FullFormalAggregateV1" ||
      predecessor.receipt.profileId !== FORMAL_FULL_PROFILE.id || predecessor.receipt.schemaVersion !== 2 ||
      previous.replacementReason !== null || predecessor.receipt.provisional?.replacementReason !== null ||
      predecessor.receiptDigest !== previous.terminalReceiptDigest || !completion) {
    throw new Error("Full formal replacement requires the original v2 aggregate and outer completion");
  }
  const replay = await replayFullFormalCompletion(completion, context);
  if (replay.formalAttemptId !== previous.attemptId || replay.formalAttemptNumber !== 1 ||
      replay.qualificationStatus !== "blocked" || replay.receiptDigest !== predecessor.receiptDigest ||
      !same(replay.failureClassification, previous.failureClassification) ||
      replay.failureClassification?.failureClass !== "INFRASTRUCTURE" ||
      replay.failureClassification.eligibleReplacementReason !== replacementReason) {
    throw new Error("Full formal predecessor observations do not authorize this infrastructure replacement");
  }
  return policy;
}
