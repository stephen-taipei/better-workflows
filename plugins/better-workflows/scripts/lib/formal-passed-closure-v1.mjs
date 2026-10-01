// SPDX-License-Identifier: AGPL-3.0-only
// Necessary passed closure over already schema-validated, fixed data.
// This boolean is neither sufficient formal qualification nor authority.
// Raw interpretation, private snapshotting, authenticity, runtime/host facts,
// complete suites and the outer completion remain the caller's obligations.
import path from "node:path";
import { FORMAL_FULL_PROFILE, FORMAL_OPERATION_TIMEOUT_MS, FORMAL_OPERATION_RESERVE_MS } from "./formal-operation.mjs";

const DIGEST = /^[a-f0-9]{64}$/;
const cutoff = FORMAL_OPERATION_TIMEOUT_MS - FORMAL_OPERATION_RESERVE_MS;
const absolute = value => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value;

// Preserve the producer's passed-terminal predicate; pid/raw-stream checks
// remain separate obligations of the complete lane and terminal validators.
function capturePassed(terminal) {
  return terminal?.exitStatusObserved === true && terminal.exitCode === 0 && terminal.signal === null &&
    terminal.timedOut === false && terminal.outputExceeded === false && terminal.groupTerminated === true &&
    DIGEST.test(terminal.stdoutSha256 ?? "") && DIGEST.test(terminal.stderrSha256 ?? "");
}

// Default passed-terminal operation closure from formal-commit.mjs.
// Completed-terminal cleanup and failure classification stay in that module.
function passedOperationClean(value) {
  return value?.schemaVersion === 1 && value.authority === "none" && value.timeoutMs === FORMAL_OPERATION_TIMEOUT_MS &&
    value.cleanupReserveMs === FORMAL_OPERATION_RESERVE_MS && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 &&
    value.elapsedMs < cutoff && value.stopReason === null && value.activeCaptures === 0 && value.cleanupConfirmed === true &&
    Array.isArray(value.captures) && value.captures.length > 0 &&
    Array.from(value.captures).every((item, i) => capturePassed(item?.terminal) &&
      Array.isArray(item.command) && item.command.length > 0 && absolute(item.command[0]) &&
      Array.from(item.command).every((part) => typeof part === "string" && !part.includes("\0")) &&
      Number.isFinite(item.startedElapsedMs) && Number.isFinite(item.finishedElapsedMs) &&
      item.startedElapsedMs >= (i === 0 ? 0 : value.captures[i - 1].finishedElapsedMs) &&
      item.finishedElapsedMs >= item.startedElapsedMs && item.finishedElapsedMs <= value.elapsedMs);
}

/** Necessary relation for a provisional whose qualification is claimed passed.
 * Do not use true as a PASS/admission receipt. A portable reader must require
 * this when a bound aggregate/completion claims passed, then keep its remaining
 * schema, authentication, full predicate coverage and HOLD gates.
 * No validator callback is accepted.
 */
export function formalPassedClosureV1(provisional) {
  return provisional?.profileId === FORMAL_FULL_PROFILE.id &&
    Array.isArray(provisional.lanes) && provisional.lanes.length === FORMAL_FULL_PROFILE.lanes.length &&
    passedOperationClean(provisional.operation) &&
    Array.from(provisional.lanes).every((lane, index) =>
      lane?.id === FORMAL_FULL_PROFILE.lanes[index].id && lane.status === "passed");
}
