import test from "node:test";
import assert from "node:assert/strict";
import { evidenceStatus } from "../src/evidence.mjs";

const snapshotId = "a".repeat(64);
const record = (seq, toolUseId, order, extra = {}) => ({
  kind: "test", command: "npm test", exitCode: 0,
  treeBefore: "current", treeAfter: "current", scope: null,
  host: "codex", session: "ordering", seq, toolUseId, order, ...extra,
});
const fence = (seq, position = null) => ({
  startedAfterSeq: seq,
  completion: position === null ? null : { snapshotId, position },
});
const status = (evidence) => evidenceStatus({ evidence }, "test", { tree: "current" });
const cycle = () => [record(3, "a", fence(1, 2)), record(4, "b", fence(3, 1))];

test("a trusted rerun fence can retire malformed older ordering metadata", () => {
  const malformed = record(1, "malformed", fence(-1));
  assert.equal(status([malformed]).status, "uncertain");
  const rerun = record(2, "rerun", fence(1));
  assert.equal(status([malformed, rerun]).status, "fresh");
  assert.equal(status([malformed, rerun]).evidence, rerun);
});

test("a rerun after every cycle member can retire the old cycle", () => {
  const records = cycle();
  assert.equal(status(records).status, "uncertain");
  const rerun = record(5, "rerun", fence(4));
  assert.equal(status([...records, rerun]).status, "fresh");
});

test("a covering fence cannot ignore reverse order in its own snapshot", () => {
  const records = cycle();
  const reversed = record(5, "reversed", fence(4, 0));
  assert.equal(status([...records, reversed]).status, "uncertain");
});

test("the fence that participates in a cycle cannot retire that cycle", () => {
  assert.equal(status(cycle()).status, "uncertain");
});

test("an unrelated maximum cannot conceal a cycle it does not fence", () => {
  assert.equal(status([...cycle(), record(5, "unrelated", fence(0))]).status, "uncertain");
});

test("a repeated call id cannot serve as the rerun that retires a cycle", () => {
  assert.equal(status([...cycle(), record(5, "a", fence(4))]).status, "uncertain");
});

test("malformed later fences cannot retire an earlier failure", () => {
  const failed = record(1, "failure", fence(0), { exitCode: 1 });
  for (const laterFence of [-1, 2, 100]) {
    const result = status([failed, record(2, "untrusted", fence(laterFence))]);
    assert.notEqual(result.status, "fresh");
  }
});

test("a recovered older pass cannot hide a later snapshot failure", () => {
  const failed = record(3, "failure", fence(0, 1), { exitCode: 1 });
  const olderPass = record(5, "older-pass", fence(0, 0));
  assert.equal(status([failed, olderPass]).status, "failed");
  assert.equal(status([olderPass, failed]).status, "failed");
});

test("incomparable successes remain uncertain until a fenced rerun", () => {
  const records = [record(1, "a", fence(0)), record(2, "b", fence(0))];
  assert.equal(status(records).status, "uncertain");
  assert.equal(status([...records, record(3, "c", fence(2))]).status, "fresh");
});

test("a long sequential session can select the final rerun", () => {
  const records = Array.from({ length: 10_000 }, (_, i) => record(i + 1, `run-${i}`, fence(i)));
  const result = status(records);
  assert.equal(result.status, "fresh");
  assert.equal(result.evidence, records.at(-1));
});
