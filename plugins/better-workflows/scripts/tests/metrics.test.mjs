import assert from "node:assert/strict";
import test from "node:test";
import { buildRunMetrics, summarizeRunMetrics } from "../lib/metrics.mjs";

const run = {
  manifest: {
    runId: "sbw-20260831T010203Z-abcdef123456",
    cwd: "/repo",
    template: "pr-to-dev",
    mode: "critical",
    requestedMode: "auto",
    createdAt: "2026-08-31T01:02:03.000Z"
  },
  contract: { template: "pr-to-dev", interactionMode: "auto" },
  state: {
    runId: "sbw-20260831T010203Z-abcdef123456",
    status: "blocked",
    completedAt: "2026-08-31T01:12:03.000Z"
  }
};

test("run metrics classify terminal cost without treating missing usage as zero", () => {
  const metrics = buildRunMetrics({
    run,
    journal: [
      { at: "2026-08-31T01:02:03.000Z", event: "run.created" },
      { at: "2026-08-31T01:04:03.000Z", event: "run.resumed" },
      { at: "2026-08-31T01:12:03.000Z", event: "run.status", to: "blocked" }
    ],
    evidence: [{ id: "evidence-1" }],
    actions: [{ outcome: "unknown" }],
    campaign: { repairEvents: 2 }
  });
  assert.equal(metrics.outcome, "blocked");
  assert.equal(metrics.elapsedWallTimeMs, 600_000);
  assert.equal(metrics.resumeCount, 1);
  assert.equal(metrics.repairWaveCount, 2);
  assert.equal(metrics.usage, null);
  assert.ok(metrics.metricWarnings.includes("provider-token-usage-unavailable"));
  assert.equal(metrics.actionOutcomes.unknown, 1);
});

test("run metrics preserve observed provider token totals and classify completed runs", () => {
  const metrics = buildRunMetrics({
    run: {
      ...run,
      state: { ...run.state, status: "completed", completedAt: "2026-08-31T01:03:03.000Z" }
    },
    journal: [
      { at: "2026-08-31T01:02:03.000Z", event: "run.created" },
      { at: "2026-08-31T01:03:03.000Z", event: "provider.turn.completed", usage: { input_tokens: 10, output_tokens: 4 } }
    ],
    campaign: { repairEvents: 0 }
  });
  assert.equal(metrics.outcome, "success");
  assert.deepEqual(metrics.usage, {
    input_tokens: 10,
    output_tokens: 4,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    reasoning_output_tokens: 0
  });
  assert.deepEqual(metrics.metricWarnings, []);
});

test("run metrics anchor fallback terminal time to the terminal transition", () => {
  const metrics = buildRunMetrics({
    run: {
      ...run,
      state: { ...run.state, status: "blocked", completedAt: null, finishedAt: null }
    },
    journal: [
      { at: "2026-08-31T01:02:03.000Z", event: "run.created" },
      { at: "2026-08-31T01:12:03.000Z", event: "run.status", from: "running", to: "blocked" },
      { at: "2026-08-31T01:22:03.000Z", event: "evidence.added" }
    ]
  });
  assert.equal(metrics.terminalAt, "2026-08-31T01:12:03.000Z");
  assert.equal(metrics.elapsedWallTimeMs, 600_000);
  assert.ok(!metrics.metricWarnings.includes("terminal-time-unknown"));
});

test("run metrics summary exposes convergence cost without converting unknowns to zero", () => {
  const summary = summarizeRunMetrics([
    { runId: "b", template: "pr-to-dev", mode: "critical", outcome: "blocked", elapsedWallTimeMs: 300, repairWaveCount: null, resumeCount: 2, scopeDriftCount: 1, infrastructureReplacementCount: 1, interactionPromptCount: 3, metricWarnings: ["provider-token-usage-unavailable"] },
    { runId: "a", template: "pr-to-dev", mode: "critical", outcome: "success", elapsedWallTimeMs: 100, repairWaveCount: 1, resumeCount: 0, scopeDriftCount: 0, infrastructureReplacementCount: 0, interactionPromptCount: 0, usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 }, metricWarnings: [] },
    { runId: "c", template: "review-issues", mode: "deep", outcome: null, elapsedWallTimeMs: null, metricWarnings: ["terminal-time-unknown"] }
  ]);
  assert.equal(summary.runCount, 3);
  assert.equal(summary.terminalCount, 2);
  assert.deepEqual(summary.outcomeCounts, { success: 1, partial: 0, blocked: 1, inconclusive: 0, pending: 1 });
  assert.equal(summary.elapsedWallTimeMs.total, 400);
  assert.equal(summary.elapsedWallTimeMs.medianMs, 100);
  assert.equal(summary.elapsedWallTimeMs.p95Ms, 300);
  assert.deepEqual(summary.repairWaveCount, { observedRuns: 1, total: 1 });
  assert.deepEqual(summary.resumeCount, { observedRuns: 2, total: 2 });
  assert.equal(summary.usage.observedRuns, 1);
  assert.equal(summary.usage.totals.input_tokens, 10);
  assert.equal(summary.warningCounts["provider-token-usage-unavailable"], 1);
  assert.equal(summary.warningCounts["terminal-time-unknown"], 1);
  assert.deepEqual(summary.topCostRuns.map((run) => run.runId), ["b", "a"]);
});
