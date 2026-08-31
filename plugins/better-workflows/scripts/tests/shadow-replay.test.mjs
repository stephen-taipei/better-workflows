import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareShadowReplay } from "../lib/shadow-replay.mjs";

const execFileAsync = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sbw.mjs");

const digest = (letter) => letter.repeat(64);
const binding = {
  schemaVersion: 1,
  kind: "ShadowReplayBindingV1",
  repositoryDigest: digest("a"),
  goalDigest: digest("b"),
  scopeDigest: digest("c"),
  suiteDigest: digest("d"),
  acceptanceDigest: digest("e"),
  template: "pr-to-dev",
  mode: "critical"
};

function metric(suffix, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "RunEfficiencyMetricsV1",
    runId: `sbw-20260831T010203Z-${suffix}`,
    repositoryDigest: binding.repositoryDigest,
    template: binding.template,
    mode: binding.mode,
    requestedMode: "auto",
    interactionMode: "auto",
    status: "completed",
    outcome: "success",
    createdAt: "2026-08-31T01:02:03.000Z",
    terminalAt: "2026-08-31T01:02:04.000Z",
    elapsedWallTimeMs: 1_000,
    repairWaveCount: 0,
    resumeCount: 0,
    scopeDriftCount: 0,
    infrastructureReplacementCount: 0,
    interactionPromptCount: 0,
    evidenceCount: 3,
    actionCount: 0,
    actionOutcomes: { success: 0, failure: 0, pending: 0, unknown: 0 },
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: 0
    },
    metricWarnings: [],
    ...overrides
  };
}

test("shadow replay compares equal-bound batches as observe-only", () => {
  const result = compareShadowReplay({
    baseline: [metric("abcdef123456")],
    candidate: [metric("123456abcdef", { elapsedWallTimeMs: 1_100 })],
    binding
  });
  assert.equal(result.status, "observe-only");
  assert.equal(result.decision, "shadow-only");
  assert.equal(result.accepted, false);
  assert.match(result.bindingDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.pair.baseline.runCount, 1);
  assert.equal(result.pair.candidate.runCount, 1);
  assert.deepEqual(result.materialCostFindings, []);
  assert.deepEqual(result.unknowns, []);
});

test("shadow replay reports material elapsed and token regressions without authorizing adoption", () => {
  const result = compareShadowReplay({
    baseline: [
      metric("abcdef123456", { elapsedWallTimeMs: 1_000, usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } }),
      metric("abcdef123457", { elapsedWallTimeMs: 2_000, usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } })
    ],
    candidate: [
      metric("123456abcdef", { elapsedWallTimeMs: 3_000, usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } }),
      metric("123456abcde0", { elapsedWallTimeMs: 5_000, usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } })
    ],
    binding
  });
  assert.equal(result.accepted, false);
  assert.ok(result.materialCostFindings.some((finding) => finding.id === "elapsed-median-regression"));
  assert.ok(result.materialCostFindings.some((finding) => finding.id === "elapsed-p95-regression"));
  assert.ok(result.materialCostFindings.some((finding) => finding.id === "provider-token-regression"));
});

test("shadow replay fails closed on binding drift, duplicate runs, and path leakage", () => {
  assert.throws(
    () => compareShadowReplay({ baseline: [metric("abcdef123456")], candidate: [metric("123456abcdef", { repositoryDigest: digest("f") })], binding }),
    /not bound/
  );
  assert.throws(
    () => compareShadowReplay({ baseline: [metric("abcdef123456"), metric("abcdef123456")], candidate: [metric("123456abcdef"), metric("123456abcde0")], binding }),
    /duplicate runId/
  );
  assert.throws(
    () => compareShadowReplay({ baseline: [{ ...metric("abcdef123456"), repository: "/Users/private/repo" }], candidate: [metric("123456abcdef")], binding }),
    /unexpected or missing field|filesystem path/
  );
});

test("shadow replay preserves unknown token usage instead of coercing it to zero", () => {
  const result = compareShadowReplay({
    baseline: [metric("abcdef123456", { usage: null })],
    candidate: [metric("123456abcdef", { usage: null })],
    binding
  });
  assert.equal(result.pair.baseline.summary.usage, null);
  assert.equal(result.pair.candidate.summary.usage, null);
  assert.ok(result.unknowns.includes("provider-token-usage-unavailable"));
});

test("metrics shadow CLI reads sanitized files without writing or opening providers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-shadow-cli-"));
  const baselineFile = path.join(root, "baseline.json");
  const candidateFile = path.join(root, "candidate.json");
  const bindingFile = path.join(root, "binding.json");
  try {
    await Promise.all([
      writeFile(baselineFile, `${JSON.stringify([metric("abcdef123456")])}\n`, { mode: 0o600 }),
      writeFile(candidateFile, `${JSON.stringify([metric("123456abcdef")])}\n`, { mode: 0o600 }),
      writeFile(bindingFile, `${JSON.stringify(binding)}\n`, { mode: 0o600 })
    ]);
    const { stdout } = await execFileAsync(process.execPath, [CLI, "metrics", "shadow", "--baseline-file", baselineFile, "--candidate-file", candidateFile, "--binding-file", bindingFile], {
      env: { ...process.env, SBW_STATE_ROOT: path.join(root, "state") },
      encoding: "utf8"
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.shadow.accepted, false);
    assert.equal(parsed.shadow.decision, "shadow-only");
    assert.equal(await readFile(baselineFile, "utf8"), `${JSON.stringify([metric("abcdef123456")])}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
