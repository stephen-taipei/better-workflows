import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerPath = fileURLToPath(new URL("../lib/native-review-shard-runner-v2.mjs", import.meta.url));

async function loadBudgetChecker() {
  const source = await readFile(runnerPath, "utf8");
  const constant = source.match(/const MAX_REVIEWER_INVOCATION_SOURCE_BYTES = ([0-9_]+);/);
  assert.ok(constant, "reviewer invocation aggregate source constant must remain explicit");
  const maxBytes = Number(constant[1].replaceAll("_", ""));
  assert.equal(maxBytes, 65_536);

  const start = source.indexOf("function assertReviewerInvocationSourceBudget(units) {");
  const end = source.indexOf("\n\nfunction startExecutor", start);
  assert.notEqual(start, -1, "aggregate source budget checker must exist");
  assert.notEqual(end, -1, "aggregate source budget checker must remain directly before startExecutor");
  const functionSource = source.slice(start, end);

  class BudgetPause extends Error {
    constructor(message) {
      super(message);
      this.status = "PAUSED_BUDGET";
      this.code = "ENATIVE_REVIEW_BUDGET";
    }
  }

  const factory = new Function(
    "assert",
    "NativeReviewShardBudgetPause",
    "MAX_REVIEWER_INVOCATION_SOURCE_BYTES",
    `${functionSource}\nreturn assertReviewerInvocationSourceBudget;`
  );
  return { source, maxBytes, BudgetPause, check: factory(assert, BudgetPause, maxBytes) };
}

test("reviewer aggregate source budget accepts the exact 65536-byte boundary and counts every assigned source", async () => {
  const { check, maxBytes } = await loadBudgetChecker();
  const repeated = { source: { bytes: 32_768 } };
  assert.equal(check([repeated, repeated]), maxBytes, "repeated source assignments are charged independently");
  assert.equal(check([{ source: { bytes: 1 } }, { source: { bytes: maxBytes - 1 } }]), maxBytes);
});

test("reviewer aggregate source budget pauses before dispatch at 65537 bytes", async () => {
  const { check, maxBytes, BudgetPause } = await loadBudgetChecker();
  assert.throws(
    () => check([{ source: { bytes: 32_768 } }, { source: { bytes: 32_769 } }]),
    error => error instanceof BudgetPause && error.code === "ENATIVE_REVIEW_BUDGET" &&
      error.status === "PAUSED_BUDGET" && error.message.includes(String(maxBytes))
  );
});

test("reviewer aggregate source budget rejects malformed and unsafe byte counts", async () => {
  const { check } = await loadBudgetChecker();
  assert.throws(() => check([]), /must include source units/);
  assert.throws(() => check([{ source: { bytes: -1 } }]), /invalid source bytes/);
  assert.throws(() => check([{ source: { bytes: 1.5 } }]), /invalid source bytes/);
  assert.throws(
    () => check([{ source: { bytes: Number.MAX_SAFE_INTEGER } }, { source: { bytes: 1 } }]),
    /safe integer range/
  );
});

test("both executor entry points enforce the aggregate source budget before host dispatch", async () => {
  const { source } = await loadBudgetChecker();
  assert.match(
    source,
    /function startExecutor\([\s\S]*?assertReviewerInvocationSourceBudget\(context\.units\);[\s\S]*?assertExecutorCapability/
  );
  assert.match(
    source,
    /async function runLane\([\s\S]*?assertReviewerInvocationSourceBudget\(assignments\.map\(item => item\.unit\)\);[\s\S]*?const reservation/
  );
});

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, startMarker);
  assert.notEqual(end, -1, endMarker);
  return source.slice(start, end);
}
function extractFunction(source, name, startMarker, endMarker, bindings) {
  return new Function(...Object.keys(bindings),
    sliceBetween(source, startMarker, endMarker) + "\nreturn " + name + ";")(...Object.values(bindings));
}
async function loadIsolatedEntryGuards() {
  const source = await readFile(runnerPath, "utf8");
  const classes = sliceBetween(source, "class NativeReviewShardRunError extends Error {",
    "\n\n/**\n * Deny-only production prerequisite.");
  const BudgetPause = new Function(classes + "\nreturn NativeReviewShardBudgetPause;")();
  const check = extractFunction(source, "assertReviewerInvocationSourceBudget",
    "function assertReviewerInvocationSourceBudget(units) {", "\n\nfunction startExecutor(",
    { assert, NativeReviewShardBudgetPause: BudgetPause, MAX_REVIEWER_INVOCATION_SOURCE_BYTES: 65_536 });
  return { source, BudgetPause, check };
}
test("actual isolated startExecutor guard rejects overflow before capability or start", async () => {
  const { source, BudgetPause, check } = await loadIsolatedEntryGuards();
  const executor = {}; let capabilityCalls = 0; let startCalls = 0;
  const entry = extractFunction(source, "startExecutor",
    "function startExecutor(executor, context, ownerLaunch = null) {", "\n\nfunction validatePlanExecutionBounds(", {
      assert, assertDiagnosticExecutor() {}, assertReviewerInvocationSourceBudget: check,
      assertExecutorCapability() { capabilityCalls += 1; },
      EXECUTOR_STARTS: new WeakMap([[executor, () => { startCalls += 1; }]])
    });
  const unit = { id: "u", source: { bytes: 65_537 } };
  assert.throws(() => entry(executor, { units: [unit], assignments: [{ unitId: "u" }], plan: {} }),
    error => error instanceof BudgetPause && error.code === "ENATIVE_REVIEW_BUDGET");
  assert.equal(capabilityCalls, 0); assert.equal(startCalls, 0);
});
test("actual isolated runLane guard rejects overflow before reservation or initialization", async () => {
  const { source, BudgetPause, check } = await loadIsolatedEntryGuards();
  let reservationReads = 0;
  const entry = extractFunction(source, "runLane", "async function runLane({", "\n\nasync function runBatch(", {
    assert, assertDiagnosticExecutor() {}, assertDiagnosticBudgetAuthorization() {},
    assertReviewerInvocationSourceBudget: check
  });
  const authorization = { get reservation() { reservationReads += 1; throw new Error("reservation boundary reached"); } };
  await assert.rejects(entry({ assignments: [{ unit: { source: { bytes: 65_537 } } }], authorization, executor: {} }),
    error => error instanceof BudgetPause && error.code === "ENATIVE_REVIEW_BUDGET");
  assert.equal(reservationReads, 0);
});
