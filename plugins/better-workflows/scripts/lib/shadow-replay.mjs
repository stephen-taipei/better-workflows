import { digestObject } from "./core.mjs";
import { summarizeRunMetrics } from "./metrics.mjs";

export const SHADOW_REPLAY_SCHEMA_VERSION = 1;
export const SHADOW_REPLAY_BINDING_KIND = "ShadowReplayBindingV1";
export const SHADOW_REPLAY_COMPARISON_KIND = "ShadowReplayComparisonV1";

const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^sbw-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODES = new Set(["auto", "direct", "verified", "deep", "critical"]);
const OUTCOMES = new Set(["success", "partial", "blocked", "inconclusive"]);
const STATUSES = new Set([
  "pending", "running", "completed", "no_op", "blocked", "inconclusive", "stale",
  "cancelled_superseded", "cancelled_evidence_sufficient", "failed_retryable", "failed_terminal"
]);
const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "reasoning_output_tokens"
];
const ACTION_OUTCOME_FIELDS = ["success", "failure", "pending", "unknown"];
const METRIC_KEYS = [
  "schemaVersion", "kind", "runId", "repositoryDigest", "template", "mode", "requestedMode",
  "interactionMode", "status", "outcome", "createdAt", "terminalAt", "elapsedWallTimeMs",
  "repairWaveCount", "resumeCount", "scopeDriftCount", "infrastructureReplacementCount",
  "interactionPromptCount", "evidenceCount", "actionCount", "actionOutcomes", "usage", "metricWarnings"
];
const BINDING_KEYS = [
  "schemaVersion", "kind", "repositoryDigest", "goalDigest", "scopeDigest", "suiteDigest",
  "acceptanceDigest", "template", "mode"
];

function fail(message) {
  throw new Error(`Shadow replay ${message}`);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} contains an unexpected or missing field`);
  }
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
}

function assertSafeLabel(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return;
  if (typeof value !== "string" || !SAFE_LABEL.test(value)) fail(`${label} is invalid`);
}

function assertNullableTimestamp(value, label) {
  if (value === null) return;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO timestamp or null`);
}

function assertNullableNonNegativeInteger(value, label) {
  if (value !== null && (!Number.isInteger(value) || value < 0)) fail(`${label} must be a non-negative integer or null`);
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
}

function assertNoSensitiveMaterial(value, label = "input") {
  if (typeof value === "string") {
    if (/\/(?:Users|private|tmp|var|home)\//i.test(value) || /[A-Za-z]:\\/.test(value)) {
      fail(`${label} contains a filesystem path`);
    }
    if (/(?:password|secret|credential|ownerToken|accessToken|api[_-]?key)\s*[:=]/i.test(value) ||
        /(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{8,}/i.test(value)) {
      fail(`${label} contains disallowed sensitive material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveMaterial(item, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (new Set(["path", "prompt", "payload", "response", "providerResponse", "credential", "token", "secret", "password", "ownerToken", "accessToken"]).has(key)) {
        fail(`${label}.${key} is not allowed`);
      }
      assertNoSensitiveMaterial(item, `${label}.${key}`);
    }
  }
}

function validateUsage(value, label) {
  if (value === null) return;
  assertPlainObject(value, label);
  assertExactKeys(value, USAGE_FIELDS, label);
  for (const field of USAGE_FIELDS) assertNonNegativeInteger(value[field], `${label}.${field}`);
}

function validateActionOutcomes(value, label) {
  assertPlainObject(value, label);
  assertExactKeys(value, ACTION_OUTCOME_FIELDS, label);
  for (const field of ACTION_OUTCOME_FIELDS) assertNonNegativeInteger(value[field], `${label}.${field}`);
}

export function validateShadowMetric(metric, index = 0) {
  const label = `metrics[${index}]`;
  assertPlainObject(metric, label);
  assertExactKeys(metric, METRIC_KEYS, label);
  if (metric.schemaVersion !== 1 || metric.kind !== "RunEfficiencyMetricsV1") fail(`${label} schema is invalid`);
  if (typeof metric.runId !== "string" || !RUN_ID.test(metric.runId)) fail(`${label}.runId is invalid`);
  assertDigest(metric.repositoryDigest, `${label}.repositoryDigest`);
  assertSafeLabel(metric.template, `${label}.template`);
  assertSafeLabel(metric.mode, `${label}.mode`);
  assertSafeLabel(metric.requestedMode, `${label}.requestedMode`, { nullable: true });
  if (metric.requestedMode !== null && !MODES.has(metric.requestedMode)) fail(`${label}.requestedMode is invalid`);
  assertSafeLabel(metric.interactionMode, `${label}.interactionMode`);
  if (metric.interactionMode !== "auto" && metric.interactionMode !== "strict") fail(`${label}.interactionMode is invalid`);
  if (typeof metric.status !== "string" || !STATUSES.has(metric.status)) fail(`${label}.status is invalid`);
  if (metric.outcome !== null && (typeof metric.outcome !== "string" || !OUTCOMES.has(metric.outcome))) fail(`${label}.outcome is invalid`);
  assertNullableTimestamp(metric.createdAt, `${label}.createdAt`);
  assertNullableTimestamp(metric.terminalAt, `${label}.terminalAt`);
  assertNullableNonNegativeInteger(metric.elapsedWallTimeMs, `${label}.elapsedWallTimeMs`);
  for (const field of [
    "repairWaveCount", "resumeCount", "scopeDriftCount", "infrastructureReplacementCount", "interactionPromptCount"
  ]) assertNullableNonNegativeInteger(metric[field], `${label}.${field}`);
  for (const field of ["evidenceCount", "actionCount"]) assertNonNegativeInteger(metric[field], `${label}.${field}`);
  validateActionOutcomes(metric.actionOutcomes, `${label}.actionOutcomes`);
  validateUsage(metric.usage, `${label}.usage`);
  if (!Array.isArray(metric.metricWarnings) || metric.metricWarnings.length > 32 || metric.metricWarnings.some((warning) => typeof warning !== "string" || !SAFE_LABEL.test(warning))) {
    fail(`${label}.metricWarnings is invalid`);
  }
  assertNoSensitiveMaterial(metric, label);
  return metric;
}

export function validateShadowBinding(binding) {
  assertPlainObject(binding, "binding");
  assertExactKeys(binding, BINDING_KEYS, "binding");
  if (binding.schemaVersion !== SHADOW_REPLAY_SCHEMA_VERSION || binding.kind !== SHADOW_REPLAY_BINDING_KIND) {
    fail("binding schema is invalid");
  }
  for (const field of ["repositoryDigest", "goalDigest", "scopeDigest", "suiteDigest", "acceptanceDigest"]) {
    assertDigest(binding[field], `binding.${field}`);
  }
  assertSafeLabel(binding.template, "binding.template");
  if (!MODES.has(binding.mode)) fail("binding.mode is invalid");
  assertNoSensitiveMaterial(binding, "binding");
  return binding;
}

function normalizeMetrics(value, label) {
  const metrics = Array.isArray(value) ? value : value?.metrics;
  if (!Array.isArray(metrics)) fail(`${label} must contain a metrics array`);
  if (metrics.length === 0 || metrics.length > 500) fail(`${label} must contain 1 to 500 metrics`);
  const seen = new Set();
  metrics.forEach((metric, index) => {
    validateShadowMetric(metric, index);
    if (seen.has(metric.runId)) fail(`${label} contains duplicate runId ${metric.runId}`);
    seen.add(metric.runId);
  });
  return metrics.slice();
}

function metricTotal(summary, field) {
  const value = summary[field];
  return value && Number.isInteger(value.total) ? value.total : null;
}

function rate(summary, field) {
  const total = metricTotal(summary, field);
  return total === null || summary.runCount === 0 ? null : total / summary.runCount;
}

function compareRate(regressions, id, label, baseline, candidate, tolerance = 0) {
  if (baseline === null || candidate === null) return;
  if (candidate > baseline + tolerance) {
    regressions.push({ id, label, baseline, candidate, delta: candidate - baseline });
  }
}

function totalUsage(summary) {
  if (!summary.usage?.totals) return null;
  return Object.values(summary.usage.totals).reduce((sum, value) => sum + value, 0);
}

function detectRegressions(baseline, candidate) {
  const regressions = [];
  const materialCostFindings = [];
  const unknowns = [];
  const baselineMedian = baseline.elapsedWallTimeMs.medianMs;
  const candidateMedian = candidate.elapsedWallTimeMs.medianMs;
  if (baselineMedian !== null && candidateMedian !== null && candidateMedian > baselineMedian + Math.max(1_000, baselineMedian * 0.25)) {
    materialCostFindings.push({
      id: "elapsed-median-regression",
      baselineMs: baselineMedian,
      candidateMs: candidateMedian,
      deltaMs: candidateMedian - baselineMedian
    });
  }
  const baselineP95 = baseline.elapsedWallTimeMs.p95Ms;
  const candidateP95 = candidate.elapsedWallTimeMs.p95Ms;
  if (baselineP95 !== null && candidateP95 !== null && candidateP95 > baselineP95 + Math.max(1_000, baselineP95 * 0.25)) {
    materialCostFindings.push({
      id: "elapsed-p95-regression",
      baselineMs: baselineP95,
      candidateMs: candidateP95,
      deltaMs: candidateP95 - baselineP95
    });
  }
  compareRate(regressions, "interaction-prompt-regression", "interaction prompts per run", rate(baseline, "interactionPromptCount"), rate(candidate, "interactionPromptCount"));
  compareRate(regressions, "repair-wave-regression", "repair waves per run", rate(baseline, "repairWaveCount"), rate(candidate, "repairWaveCount"));
  compareRate(regressions, "resume-regression", "resumes per run", rate(baseline, "resumeCount"), rate(candidate, "resumeCount"));
  compareRate(regressions, "scope-drift-regression", "scope drifts per run", rate(baseline, "scopeDriftCount"), rate(candidate, "scopeDriftCount"));
  compareRate(regressions, "replacement-regression", "infrastructure replacements per run", rate(baseline, "infrastructureReplacementCount"), rate(candidate, "infrastructureReplacementCount"));
  for (const outcome of ["blocked", "inconclusive"]) {
    const baselineRate = baseline.runCount === 0 ? null : (baseline.outcomeCounts[outcome] ?? 0) / baseline.runCount;
    const candidateRate = candidate.runCount === 0 ? null : (candidate.outcomeCounts[outcome] ?? 0) / candidate.runCount;
    compareRate(regressions, `${outcome}-rate-regression`, `${outcome} runs per run`, baselineRate, candidateRate, 0.1);
  }
  const baselineUsage = totalUsage(baseline);
  const candidateUsage = totalUsage(candidate);
  if (baselineUsage === null || candidateUsage === null) {
    unknowns.push("provider-token-usage-unavailable");
  } else if (candidateUsage > baselineUsage + Math.max(100, baselineUsage * 0.25)) {
    materialCostFindings.push({
      id: "provider-token-regression",
      baselineTokens: baselineUsage,
      candidateTokens: candidateUsage,
      deltaTokens: candidateUsage - baselineUsage
    });
  }
  if (baseline.elapsedWallTimeMs.observedRuns === 0 || candidate.elapsedWallTimeMs.observedRuns === 0) {
    unknowns.push("elapsed-time-unavailable");
  }
  return { regressions, materialCostFindings, unknowns: [...new Set(unknowns)] };
}

/**
 * Compare two sanitized, same-binding metric batches. This is deliberately
 * observe-only: it never authorizes adoption, changes routing, or issues an
 * action token. Any malformed or mismatched input throws instead of producing
 * a partial comparison.
 */
export function compareShadowReplay({ baseline, candidate, binding, baselineLabel = "v1", candidateLabel = "v2" } = {}) {
  const normalizedBinding = validateShadowBinding(binding);
  const baselineMetrics = normalizeMetrics(baseline, "baseline");
  const candidateMetrics = normalizeMetrics(candidate, "candidate");
  if (baselineMetrics.length !== candidateMetrics.length) fail("baseline and candidate batch sizes differ");
  for (const [label, metrics] of [["baseline", baselineMetrics], ["candidate", candidateMetrics]]) {
    for (const metric of metrics) {
      if (metric.repositoryDigest !== normalizedBinding.repositoryDigest || metric.template !== normalizedBinding.template || metric.mode !== normalizedBinding.mode) {
        fail(`${label} metric is not bound to the comparison input`);
      }
    }
  }
  assertSafeLabel(baselineLabel, "baselineLabel");
  assertSafeLabel(candidateLabel, "candidateLabel");
  const baselineSummary = summarizeRunMetrics(baselineMetrics);
  const candidateSummary = summarizeRunMetrics(candidateMetrics);
  const detected = detectRegressions(baselineSummary, candidateSummary);
  return {
    schemaVersion: SHADOW_REPLAY_SCHEMA_VERSION,
    kind: SHADOW_REPLAY_COMPARISON_KIND,
    status: "observe-only",
    decision: "shadow-only",
    accepted: false,
    bindingDigest: digestObject(normalizedBinding),
    binding: normalizedBinding,
    pair: {
      baseline: { label: baselineLabel, runCount: baselineMetrics.length, summary: baselineSummary },
      candidate: { label: candidateLabel, runCount: candidateMetrics.length, summary: candidateSummary }
    },
    regressions: detected.regressions,
    materialCostFindings: detected.materialCostFindings,
    unknowns: detected.unknowns
  };
}
