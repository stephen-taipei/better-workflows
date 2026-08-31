import { readdir } from "node:fs/promises";
import { campaignStatus } from "./campaign.mjs";
import {
  inspectRun,
  readJournalRecords,
  safeJoin
} from "./core.mjs";

export const RUN_METRICS_SCHEMA_VERSION = 1;

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
  for (const record of records) {
    const parsed = finiteTimestamp(record?.at ?? record?.createdAt ?? record?.finishedAt);
    if (parsed !== null && (latest === null || parsed > latest)) latest = parsed;
  }
  return latest;
}

function countMatching(records, predicate) {
  return records.reduce((count, record) => count + (predicate(record) ? 1 : 0), 0);
}

function metricWarnings({ run, journal, usage, campaign }) {
  const warnings = [];
  if (!TERMINAL_STATUSES.has(run.state?.status)) warnings.push("terminal-time-unknown");
  if (!usage) warnings.push("provider-token-usage-unavailable");
  if (campaign?.legacyUnbound) warnings.push("campaign-binding-unavailable");
  if (!journal.some((record) => record?.event === "run.created")) warnings.push("run-created-event-unavailable");
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
    TERMINAL_STATUSES.has(status) ? latestRecordTime(journal) : null
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
  const promptCount = countMatching(journal, (record) => /interaction|authorization.*prompt/i.test(String(record?.event ?? "")));
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
    repository: typeof run.manifest.cwd === "string" ? run.manifest.cwd : null,
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

