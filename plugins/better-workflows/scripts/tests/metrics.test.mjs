import assert from "node:assert/strict";
import test from "node:test";
import { buildRunMetrics } from "../lib/metrics.mjs";

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

