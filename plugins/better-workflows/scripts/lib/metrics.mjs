import { readdir } from "node:fs/promises";
import { campaignStatus } from "./campaign.mjs";
import {
  inspectRun,
  readJournalRecords,
  safeJoin,
  sha256
} from "./core.mjs";

export const RUN_METRICS_SCHEMA_VERSION = 1;
export const COST_ANOMALY_SCHEMA_VERSION = 1;

const USAGE_FIELDS = Object.freeze([
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "reasoning_output_tokens"
]);
const TERMINAL_STATUSES = new Set([
  "completed",
  "no_op",
  "blocked",
  "inconclusive",
  "stale",
  "cancelled_superseded",
  "cancelled_evidence_sufficient"
]);

const DEFAULT_COST_ANOMALY_OPTIONS = Object.freeze({
  baselineWindow: 5,
  candidateWindow: 2,
  minBaselineRuns: 3,
  elapsedRatio: 1.5,
  elapsedAbsoluteMs: 60_000,
  tokenRatio: 1.5,
  tokenAbsolute: 500
});

function finiteTimestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function terminalOutcome(status) {
  if (["completed", "no_op"].includes(status)) return "success";
  if (["blocked", "cancelled_superseded", "cancelled_evidence_sufficient"].includes(status)) return "blocked";
  if (["inconclusive", "stale"].includes(status)) return "inconclusive";
  if (status === "running") return null;
  return "partial";
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  let found = false;
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (!Number.isInteger(value) || value < 0) continue;
    total[field] += value;
    found = true;
  }
  return found;
}

function usageFrom(records) {
  const totals = Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
  let observed = false;
  for (const record of records) {
    observed = addUsage(totals, record?.usage) || observed;
    observed = addUsage(totals, record?.metadata?.usage) || observed;
    observed = addUsage(totals, record?.result?.usage) || observed;
  }
  return observed ? totals : null;
}

function latestRecordTime(records) {
  let latest = null;
  let latestValue = null;
  for (const record of records) {
    const value = record?.at ?? record?.createdAt ?? record?.finishedAt;
    const parsed = finiteTimestamp(value);
    if (parsed !== null && (latest === null || parsed > latest)) {
      latest = parsed;
      latestValue = value;
    }
  }
  return latestValue;
}

function terminalJournalTime(records) {
  let latest = null;
  let latestValue = null;
  for (const record of records) {
    if (!["run.status", "state.updated"].includes(record?.event)) continue;
    const nextStatus = record?.to ?? record?.status ?? record?.payload?.to ?? record?.details?.to;
    if (!TERMINAL_STATUSES.has(String(nextStatus))) continue;
    const value = record?.at ?? record?.createdAt ?? record?.finishedAt;
    const parsed = finiteTimestamp(value);
    if (parsed !== null && (latest === null || parsed > latest)) {
      latest = parsed;
      latestValue = value;
    }
  }
  return latestValue;
}

function countMatching(records, predicate) {
  return records.reduce((count, record) => count + (predicate(record) ? 1 : 0), 0);
}

function increment(counter, key) {
  const normalized = String(key ?? "unknown");
  counter[normalized] = (counter[normalized] ?? 0) + 1;
}

function numericTotal(metrics, field) {
  const observed = metrics.filter((metric) => Number.isInteger(metric?.[field]) && metric[field] >= 0);
  return {
    observedRuns: observed.length,
    total: observed.reduce((sum, metric) => sum + metric[field], 0)
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1));
  return values[index];
}

function positiveInteger(value, fallback, maximum = 500) {
  return Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

function nonNegativeNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizedCostAnomalyOptions(options = {}) {
  const baselineWindow = positiveInteger(options.baselineWindow, DEFAULT_COST_ANOMALY_OPTIONS.baselineWindow);
  const candidateWindow = positiveInteger(options.candidateWindow, DEFAULT_COST_ANOMALY_OPTIONS.candidateWindow);
  return {
    baselineWindow,
    candidateWindow,
    minBaselineRuns: Math.min(
      baselineWindow,
      positiveInteger(options.minBaselineRuns, DEFAULT_COST_ANOMALY_OPTIONS.minBaselineRuns)
    ),
    elapsedRatio: Math.max(1, nonNegativeNumber(options.elapsedRatio, DEFAULT_COST_ANOMALY_OPTIONS.elapsedRatio)),
    elapsedAbsoluteMs: nonNegativeNumber(options.elapsedAbsoluteMs, DEFAULT_COST_ANOMALY_OPTIONS.elapsedAbsoluteMs),
    tokenRatio: Math.max(1, nonNegativeNumber(options.tokenRatio, DEFAULT_COST_ANOMALY_OPTIONS.tokenRatio)),
    tokenAbsolute: nonNegativeNumber(options.tokenAbsolute, DEFAULT_COST_ANOMALY_OPTIONS.tokenAbsolute)
  };
}

function metricTokenTotal(metric) {
  if (!metric?.usage || typeof metric.usage !== "object" || Array.isArray(metric.usage)) return null;
  const values = USAGE_FIELDS.map((field) => metric.usage[field]);
  if (values.some((value) => !Number.isInteger(value) || value < 0)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function costGroup(metric) {
  return {
    repositoryDigest: metric?.repositoryDigest ?? "unknown",
    template: metric?.template ?? "unknown",
    mode: metric?.mode ?? "unknown",
    interactionMode: metric?.interactionMode ?? "unknown"
  };
}

function costGroupKey(group) {
  return [group.repositoryDigest, group.template, group.mode, group.interactionMode].join("|");
}

function medianObserved(metrics, selector) {
  const values = metrics.map(selector).filter((value) => Number.isInteger(value) && value >= 0).sort((left, right) => left - right);
  return { observedRuns: values.length, median: values.length > 0 ? percentile(values, 0.5) : null };
}

function materialIncrease(baseline, candidate, ratio, absolute) {
  if (baseline === null || candidate === null || candidate <= baseline + absolute) return false;
  return baseline === 0 ? candidate > absolute : candidate >= baseline * ratio;
}

/**
 * Identify recent, materially more expensive runs without converting missing
 * observations to zero. The report is diagnostic only; it never changes a
 * route, grants authority, or triggers a provider action.
 */
export function detectCostAnomalies(metrics = [], options = {}) {
  if (!Array.isArray(metrics)) throw new Error("Run metrics must be an array");
  const normalized = normalizedCostAnomalyOptions(options);
  const ordered = metrics.slice().sort((left, right) => (
    (finiteTimestamp(left?.createdAt) ?? Number.MIN_SAFE_INTEGER) -
    (finiteTimestamp(right?.createdAt) ?? Number.MIN_SAFE_INTEGER)
  ) || String(left?.runId ?? "").localeCompare(String(right?.runId ?? "")));
  const groups = new Map();
  for (const metric of ordered) {
    const group = costGroup(metric);
    const key = costGroupKey(group);
    if (!groups.has(key)) groups.set(key, { group, metrics: [] });
    groups.get(key).metrics.push(metric);
  }
  const anomalies = [];
  const unknowns = [];
  for (const { group, metrics: grouped } of groups.values()) {
    if (grouped.length <= normalized.minBaselineRuns) {
      unknowns.push({
        id: "insufficient-baseline-runs",
        group,
        observedRuns: grouped.length,
        requiredRuns: normalized.minBaselineRuns + 1
      });
      continue;
    }
    const candidate = grouped.slice(-normalized.candidateWindow);
    const baseline = grouped.slice(0, -normalized.candidateWindow).slice(-normalized.baselineWindow);
    if (baseline.length < normalized.minBaselineRuns) {
      unknowns.push({
        id: "insufficient-baseline-runs",
        group,
        observedRuns: baseline.length,
        requiredRuns: normalized.minBaselineRuns
      });
      continue;
    }
    const baselineElapsed = medianObserved(baseline, (metric) => metric?.elapsedWallTimeMs);
    const candidateElapsed = medianObserved(candidate, (metric) => metric?.elapsedWallTimeMs);
    if (baselineElapsed.median === null || candidateElapsed.median === null) {
      unknowns.push({ id: "elapsed-time-unavailable", group, baselineObservedRuns: baselineElapsed.observedRuns, candidateObservedRuns: candidateElapsed.observedRuns });
    } else if (materialIncrease(
      baselineElapsed.median,
      candidateElapsed.median,
      normalized.elapsedRatio,
      normalized.elapsedAbsoluteMs
    )) {
      const ratio = baselineElapsed.median === 0 ? null : candidateElapsed.median / baselineElapsed.median;
      anomalies.push({
        id: "elapsed-wall-time-increase",
        severity: ratio !== null && ratio >= 2 ? "P1" : "P2",
        metric: "elapsedWallTimeMs",
        group,
        baseline: { runCount: baseline.length, observedRuns: baselineElapsed.observedRuns, median: baselineElapsed.median },
        candidate: { runCount: candidate.length, observedRuns: candidateElapsed.observedRuns, median: candidateElapsed.median },
        delta: candidateElapsed.median - baselineElapsed.median,
        ratio
      });
    }
    const baselineTokens = medianObserved(baseline, metricTokenTotal);
    const candidateTokens = medianObserved(candidate, metricTokenTotal);
    if (baselineTokens.median === null || candidateTokens.median === null) {
      unknowns.push({ id: "provider-token-usage-unavailable", group, baselineObservedRuns: baselineTokens.observedRuns, candidateObservedRuns: candidateTokens.observedRuns });
    } else if (materialIncrease(
      baselineTokens.median,
      candidateTokens.median,
      normalized.tokenRatio,
      normalized.tokenAbsolute
    )) {
      const ratio = baselineTokens.median === 0 ? null : candidateTokens.median / baselineTokens.median;
      anomalies.push({
        id: "provider-token-increase",
        severity: ratio !== null && ratio >= 2 ? "P1" : "P2",
        metric: "providerTokens",
        group,
        baseline: { runCount: baseline.length, observedRuns: baselineTokens.observedRuns, median: baselineTokens.median },
        candidate: { runCount: candidate.length, observedRuns: candidateTokens.observedRuns, median: candidateTokens.median },
        delta: candidateTokens.median - baselineTokens.median,
        ratio
      });
    }
  }
  anomalies.sort((left, right) => (
    (left.severity === "P1" ? 0 : 1) - (right.severity === "P1" ? 0 : 1) ||
    left.id.localeCompare(right.id) ||
    costGroupKey(left.group).localeCompare(costGroupKey(right.group))
  ));
  unknowns.sort((left, right) => left.id.localeCompare(right.id) || costGroupKey(left.group).localeCompare(costGroupKey(right.group)));
  return {
    schemaVersion: COST_ANOMALY_SCHEMA_VERSION,
    kind: "CostAnomalyReportV1",
    observeOnly: true,
    anomalies,
    unknowns
  };
}

function metricWarnings({ run, journal, usage, campaign }) {
  const warnings = [];
  if (!TERMINAL_STATUSES.has(run.state?.status)) warnings.push("terminal-time-unknown");
  if (!usage) warnings.push("provider-token-usage-unavailable");
  if (campaign?.legacyUnbound) warnings.push("campaign-binding-unavailable");
  if (!journal.some((record) => record?.event === "run.created")) warnings.push("run-created-event-unavailable");
  if (!journal.some((record) => /interaction|authorization.*(?:prompt|request|hold|decision)/i.test(String(record?.event ?? "")))) {
    warnings.push("interaction-prompt-observation-unavailable");
  }
  return warnings;
}

/**
 * Build sanitized, read-only efficiency metadata from persisted run records.
 * Prompts, provider responses, and credentials are intentionally omitted.
 */
export function buildRunMetrics({ run, journal = [], evidence = [], actions = [], campaign = null } = {}) {
  if (!run?.manifest || !run?.state) throw new Error("Run manifest and state are required for metrics");
  const status = String(run.state.status ?? "unknown");
  const createdAt = run.manifest.createdAt ?? run.state.createdAt ?? journal.find((record) => record?.event === "run.created")?.at ?? null;
  const terminalAt = run.state.completedAt ?? run.state.finishedAt ?? (
    TERMINAL_STATUSES.has(status) ? terminalJournalTime(journal) ?? latestRecordTime(journal) : null
  );
  const createdMs = finiteTimestamp(createdAt);
  const terminalMs = finiteTimestamp(terminalAt);
  const elapsedWallTimeMs = createdMs !== null && terminalMs !== null && terminalMs >= createdMs
    ? terminalMs - createdMs
    : null;
  const usage = usageFrom(journal);
  const resumeCount = countMatching(journal, (record) => /(?:^|[.:-])resume(?:d)?(?:$|[.:-])/i.test(String(record?.event ?? "")));
  const scopeDriftCount = countMatching(journal, (record) => /drift|rebound|stale/i.test(String(record?.event ?? "")));
  const replacementCount = countMatching(journal, (record) => /replacement|formal.*attempt/i.test(String(record?.event ?? "")));
  const interactionEvents = journal.filter((record) => /interaction|authorization.*(?:prompt|request|hold|decision)/i.test(String(record?.event ?? "")));
  const promptCount = interactionEvents.length === 0
    ? null
    : countMatching(interactionEvents, (record) => /interaction|authorization.*(?:prompt|request|hold)/i.test(String(record?.event ?? "")));
  const actionOutcomes = Object.fromEntries(
    ["success", "failure", "pending", "unknown"].map((value) => [
      value,
      actions.filter((action) => action?.outcome === value).length
    ])
  );
  return {
    schemaVersion: RUN_METRICS_SCHEMA_VERSION,
    kind: "RunEfficiencyMetricsV1",
    runId: run.manifest.runId ?? run.state.runId ?? null,
    // Keep cross-project grouping possible without disclosing a local
    // checkout path.  Metrics are safe to export to a shadow comparison.
    repositoryDigest: typeof run.manifest.cwd === "string" ? sha256(run.manifest.cwd) : null,
    template: run.manifest.template ?? run.contract?.template ?? null,
    mode: run.manifest.mode ?? run.state.mode ?? null,
    requestedMode: run.manifest.requestedMode ?? null,
    interactionMode: run.contract?.interactionMode ?? "auto",
    status,
    outcome: terminalOutcome(status),
    createdAt,
    terminalAt,
    elapsedWallTimeMs,
    repairWaveCount: Number.isInteger(campaign?.repairEvents) ? campaign.repairEvents : null,
    resumeCount,
    scopeDriftCount,
    infrastructureReplacementCount: replacementCount,
    interactionPromptCount: promptCount,
    evidenceCount: evidence.length,
    actionCount: actions.length,
    actionOutcomes,
    usage,
    metricWarnings: metricWarnings({ run, journal, usage, campaign })
  };
}

/**
 * Aggregate sanitized run metrics without treating missing observations as
 * zero. This is intentionally read-only and contains no prompts, payloads,
 * provider responses, credentials, or filesystem paths.
 */
export function summarizeRunMetrics(metrics = []) {
  if (!Array.isArray(metrics)) throw new Error("Run metrics must be an array");
  const ordered = metrics.slice().sort((left, right) => String(left?.runId ?? "").localeCompare(String(right?.runId ?? "")));
  const outcomeCounts = { success: 0, partial: 0, blocked: 0, inconclusive: 0, pending: 0 };
  const repositoryCounts = {};
  const modeCounts = {};
  const templateCounts = {};
  const warningCounts = {};
  for (const metric of ordered) {
    const outcome = metric?.outcome === null || metric?.outcome === undefined ? "pending" : String(metric.outcome);
    outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
    increment(repositoryCounts, metric?.repositoryDigest);
    increment(modeCounts, metric?.mode);
    increment(templateCounts, metric?.template);
    for (const warning of Array.isArray(metric?.metricWarnings) ? metric.metricWarnings : []) {
      increment(warningCounts, warning);
    }
  }
  const elapsed = ordered
    .map((metric) => metric?.elapsedWallTimeMs)
    .filter((value) => Number.isInteger(value) && value >= 0)
    .sort((left, right) => left - right);
  const usageMetrics = ordered.filter((metric) => metric?.usage && typeof metric.usage === "object");
  const usageTotals = usageMetrics.length === 0
    ? null
    : Object.fromEntries(USAGE_FIELDS.map((field) => [
      field,
      usageMetrics.reduce((sum, metric) => sum + (Number.isInteger(metric.usage[field]) && metric.usage[field] >= 0 ? metric.usage[field] : 0), 0)
    ]));
  const topCostRuns = ordered
    .filter((metric) => Number.isInteger(metric?.elapsedWallTimeMs) && metric.elapsedWallTimeMs >= 0)
    .sort((left, right) => right.elapsedWallTimeMs - left.elapsedWallTimeMs || String(left.runId).localeCompare(String(right.runId)))
    .slice(0, 10)
    .map((metric) => ({
      runId: metric.runId ?? null,
      template: metric.template ?? null,
      mode: metric.mode ?? null,
      outcome: metric.outcome ?? null,
      elapsedWallTimeMs: metric.elapsedWallTimeMs,
      repairWaveCount: Number.isInteger(metric.repairWaveCount) ? metric.repairWaveCount : null,
      resumeCount: Number.isInteger(metric.resumeCount) ? metric.resumeCount : null,
      scopeDriftCount: Number.isInteger(metric.scopeDriftCount) ? metric.scopeDriftCount : null,
      infrastructureReplacementCount: Number.isInteger(metric.infrastructureReplacementCount)
        ? metric.infrastructureReplacementCount
        : null,
      interactionPromptCount: Number.isInteger(metric.interactionPromptCount) ? metric.interactionPromptCount : null
    }));
  return {
    schemaVersion: RUN_METRICS_SCHEMA_VERSION,
    kind: "RunEfficiencySummaryV1",
    runCount: ordered.length,
    terminalCount: ordered.filter((metric) => metric?.outcome !== null && metric?.outcome !== undefined).length,
    outcomeCounts,
    repositoryCounts,
    modeCounts,
    templateCounts,
    elapsedWallTimeMs: {
      observedRuns: elapsed.length,
      total: elapsed.length > 0 ? elapsed.reduce((sum, value) => sum + value, 0) : null,
      medianMs: elapsed.length > 0 ? percentile(elapsed, 0.5) : null,
      p95Ms: elapsed.length > 0 ? percentile(elapsed, 0.95) : null
    },
    repairWaveCount: numericTotal(ordered, "repairWaveCount"),
    resumeCount: numericTotal(ordered, "resumeCount"),
    scopeDriftCount: numericTotal(ordered, "scopeDriftCount"),
    infrastructureReplacementCount: numericTotal(ordered, "infrastructureReplacementCount"),
    interactionPromptCount: numericTotal(ordered, "interactionPromptCount"),
    usage: usageTotals === null ? null : { observedRuns: usageMetrics.length, totals: usageTotals },
    warningCounts,
    topCostRuns,
    costAnomalies: detectCostAnomalies(ordered)
  };
}

export async function readRunMetrics(root, runId) {
  const inspected = await inspectRun(root, runId);
  const journal = await readJournalRecords(root, inspected.runDir);
  const campaign = await campaignStatus(inspected).catch(() => null);
  return buildRunMetrics({
    run: inspected,
    journal,
    evidence: inspected.evidence,
    actions: inspected.actions,
    campaign
  });
}

export async function listRunMetrics(root, { limit = 50 } = {}) {
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
    throw new Error("Metrics limit must be an integer from 1 to 500");
  }
  const runsRoot = safeJoin(root, "runs");
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const runIds = entries
    .filter((entry) => entry.isDirectory() && /^sbw-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/.test(entry.name))
    .map((entry) => entry.name);
  const metrics = [];
  for (const runId of runIds) metrics.push(await readRunMetrics(root, runId));
  metrics.sort((left, right) => (finiteTimestamp(right.createdAt) ?? 0) - (finiteTimestamp(left.createdAt) ?? 0));
  return metrics.slice(0, parsedLimit);
}
