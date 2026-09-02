import assert from "node:assert/strict";
import test from "node:test";
import { buildRunMetrics, detectCostAnomalies, summarizeRunMetrics } from "../lib/metrics.mjs";

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
  assert.equal(metrics.repository, undefined);
  assert.match(metrics.repositoryDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(metrics), /\/repo/);
  assert.ok(metrics.metricWarnings.includes("provider-token-usage-unavailable"));
  assert.equal(metrics.interactionPromptCount, null);
  assert.ok(metrics.metricWarnings.includes("interaction-prompt-observation-unavailable"));
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
  assert.deepEqual(metrics.metricWarnings, ["interaction-prompt-observation-unavailable"]);
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
  assert.deepEqual(summary.repositoryCounts, { unknown: 3 });
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

function costMetric(runId, createdAt, elapsedWallTimeMs, tokens, overrides = {}) {
  return {
    runId,
    repositoryDigest: "a".repeat(64),
    template: "pr-to-dev",
    mode: "critical",
    interactionMode: "auto",
    createdAt,
    elapsedWallTimeMs,
    usage: tokens === null ? null : {
      input_tokens: tokens,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: 0
    },
    ...overrides
  };
}

test("cost anomaly report prioritizes material recent wall-time and token increases", () => {
  const metrics = [
    costMetric("baseline-1", "2026-08-31T01:00:00.000Z", 100, 100),
    costMetric("baseline-2", "2026-08-31T01:01:00.000Z", 110, 110),
    costMetric("baseline-3", "2026-08-31T01:02:00.000Z", 120, 120),
    costMetric("candidate-1", "2026-08-31T02:00:00.000Z", 300, 300),
    costMetric("candidate-2", "2026-08-31T02:01:00.000Z", 320, 320)
  ];
  const report = detectCostAnomalies(metrics, {
    baselineWindow: 3,
    candidateWindow: 2,
    minBaselineRuns: 3,
    elapsedAbsoluteMs: 50,
    elapsedRatio: 1.5,
    tokenAbsolute: 50,
    tokenRatio: 1.5
  });
  assert.equal(report.observeOnly, true);
  assert.deepEqual(report.anomalies.map((finding) => finding.id), ["elapsed-wall-time-increase", "provider-token-increase"]);
  assert.deepEqual(report.anomalies.map((finding) => finding.severity), ["P1", "P1"]);
  assert.equal(report.anomalies[0].baseline.median, 110);
  assert.equal(report.anomalies[0].candidate.median, 300);
  assert.equal(report.unknowns.length, 0);
});

test("cost anomaly report keeps missing observations unknown", () => {
  const metrics = [
    costMetric("baseline-1", "2026-08-31T01:00:00.000Z", 100, null),
    costMetric("baseline-2", "2026-08-31T01:01:00.000Z", 110, null),
    costMetric("baseline-3", "2026-08-31T01:02:00.000Z", 120, null),
    costMetric("candidate-1", "2026-08-31T02:00:00.000Z", 300, null),
    costMetric("candidate-2", "2026-08-31T02:01:00.000Z", 320, null)
  ];
  const report = detectCostAnomalies(metrics, {
    baselineWindow: 3,
    candidateWindow: 2,
    minBaselineRuns: 3,
    elapsedAbsoluteMs: 50,
    elapsedRatio: 1.5
  });
  assert.deepEqual(report.anomalies.map((finding) => finding.id), ["elapsed-wall-time-increase"]);
  assert.ok(report.unknowns.some((unknown) => unknown.id === "provider-token-usage-unavailable"));
  assert.ok(!report.unknowns.some((unknown) => unknown.id === "elapsed-time-unavailable"));
});

test("cost anomaly report does not infer a regression without a baseline window", () => {
  const report = detectCostAnomalies([
    costMetric("only-1", "2026-08-31T01:00:00.000Z", 900, 900),
    costMetric("only-2", "2026-08-31T02:00:00.000Z", 900, 900)
  ], { minBaselineRuns: 3 });
  assert.deepEqual(report.anomalies, []);
  assert.equal(report.unknowns[0].id, "insufficient-baseline-runs");
});
