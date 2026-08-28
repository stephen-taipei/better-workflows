import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

export const RELEASE_POLICY_RECEIPT_CONTEXT = "better-workflows/release-policy-v1";
export const RELEASE_POLICY_RECEIPT_PREFIX = "better-workflows-policy-v1:";
export const RELEASE_POLICY_RECEIPT_WORKFLOW_FILE = ".github/workflows/ci.yml";
export const RELEASE_POLICY_RECEIPT_WORKFLOW_ID = RELEASE_POLICY_RECEIPT_WORKFLOW_FILE.split("/").pop();
export const RELEASE_POLICY_RECEIPT_RECONCILIATION_WORKFLOW_FILE = ".github/workflows/release-policy-reconcile.yml";
export const RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT = "pull_request_target";
export const RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT = "workflow_run";
export const RELEASE_POLICY_RECEIPT_PUBLISHER = "github-actions[bot]";
export const RELEASE_POLICY_RECEIPT_ARTIFACT_NAME = "better-workflows-release-policy-receipt";
export const RELEASE_POLICY_RECEIPT_ARTIFACT_FILE = "release-policy-receipt.json";
export const RELEASE_POLICY_RECEIPT_ARTIFACT_KIND = "better-workflows/release-policy-receipt-v2";
export const RELEASE_POLICY_CLOSE_BINDING_ARTIFACT_NAME = "better-workflows-release-policy-close-binding";
export const RELEASE_POLICY_CLOSE_BINDING_ARTIFACT_FILE = "release-policy-close-binding.json";
export const RELEASE_POLICY_CLOSE_BINDING_ARTIFACT_KIND = "better-workflows/release-policy-close-binding-v1";
export const RELEASE_POLICY_RECEIPT_PREMERGE_ACTIONS = ["opened", "reopened", "synchronize"];
export const RELEASE_POLICY_RECEIPT_MERGE_ACTION = "closed";
export const RELEASE_POLICY_RECEIPT_SOURCE_POLL_ATTEMPTS = 12;
export const RELEASE_POLICY_RECEIPT_SOURCE_POLL_DELAY_MS = 5_000;
const RELEASE_POLICY_BRANCHES = new Set(["dev", "main"]);
const RECONCILIATION_PULL_PAGE_SIZE = 100;
const RECONCILIATION_PULL_MAX_PAGES = 10;

export class MissingPolicyCloseBindingArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = "MissingPolicyCloseBindingArtifactError";
  }
}

function assertSha(value) {
  const sha = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Release policy receipt requires a commit SHA: ${sha || "<empty>"}`);
  return sha;
}

export function canonicalWorkflowRunId(value, label = "workflow run") {
  const raw = typeof value === "string"
    ? value.trim()
    : Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`Release policy receipt ${label} has a missing or unsafe workflow-run identity`);
  }
  return raw;
}

export function isValidPullRequestHeadRef(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 255) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{")) return false;
  if (/[\u0000-\u0020\u007f]/u.test(value)) return false;
  if (["~", "^", ":", "?", "*", "[", "\\"].some((token) => value.includes(token))) return false;
  return value.split("/").every((component) => (
    component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock")
  ));
}

export function normalizeRequiredChecks(payload, options = {}) {
  const nestedRequired = payload?.protection?.required_status_checks;
  const required = nestedRequired ?? payload;
  if (!required || typeof required !== "object" || Array.isArray(required) ||
      (nestedRequired && payload?.protected !== true)) {
    throw new Error("Release policy receipt requires an authoritative required status check response");
  }
  if (!Array.isArray(required.contexts) && !Array.isArray(required.checks)) {
    throw new Error("Release policy receipt requires a resolvable required status check configuration");
  }
  if (typeof required.strict !== "boolean") {
    throw new Error("Release policy receipt requires the protected-branch strict setting");
  }
  const entries = [];
  const structuredChecks = Array.isArray(required.checks) && required.checks.length > 0;
  for (const context of structuredChecks ? [] : (required.contexts ?? [])) {
    if (typeof context !== "string" || context.length === 0) throw new Error("Release policy receipt received an invalid required status context");
    entries.push({ context, appId: null, strict: required.strict });
  }
  for (const check of required.checks ?? []) {
    if (!check || typeof check.context !== "string" || check.context.length === 0) {
      throw new Error("Release policy receipt received an invalid app-bound required status check");
    }
    const rawAppId = check.app_id;
    const numericAppId = rawAppId === undefined || rawAppId === null || rawAppId === "" ? null : Number(rawAppId);
    const appId = numericAppId === null || numericAppId === -1 ? null : numericAppId;
    if (appId !== null && (!Number.isInteger(appId) || appId < 0)) {
      throw new Error("Release policy receipt received an invalid required status check app binding");
    }
    entries.push({ context: check.context, appId, strict: required.strict });
  }
  for (const check of options.rulesetRequiredChecks ?? []) {
    if (!check || typeof check.context !== "string" || check.context.length === 0 || typeof check.strict !== "boolean") {
      throw new Error("Release policy receipt received an invalid ruleset required status check");
    }
    const rawAppId = check.appId;
    const numericAppId = rawAppId === undefined || rawAppId === null || rawAppId === "" || rawAppId === -1 || rawAppId === "-1"
      ? null
      : Number(rawAppId);
    const appId = numericAppId === null ? null : numericAppId;
    if (appId !== null && (!Number.isInteger(appId) || appId < 0)) {
      throw new Error("Release policy receipt received an invalid ruleset required status check app binding");
    }
    entries.push({ context: check.context, appId, strict: check.strict });
  }
  const unique = new Map();
  for (const item of entries) {
    const key = `${item.context}\u0000${item.appId ?? "*"}`;
    const previous = unique.get(key);
    if (previous && previous.strict !== item.strict) {
      throw new Error(`Release policy receipt cannot reconcile conflicting strictness for required check ${item.context}`);
    }
    if (!previous) unique.set(key, item);
  }
  const normalized = [...unique.values()].sort((left, right) => (
    `${left.context}:${left.appId ?? ""}`.localeCompare(`${right.context}:${right.appId ?? ""}`)
  ));
  if (normalized.length === 0) throw new Error("Release policy receipt cannot publish an empty required-check policy");
  const contextCounts = new Map();
  for (const item of normalized) contextCounts.set(item.context, (contextCounts.get(item.context) ?? 0) + 1);
  if ([...contextCounts.values()].some((count) => count > 1)) {
    throw new Error("Release policy receipt cannot represent duplicate required-check contexts");
  }
  return normalized;
}

export function policyDigest(requirements) {
  return createHash("sha256").update(JSON.stringify(requirements)).digest("hex");
}

export function policyArtifactDigest(artifact) {
  const digest = String(artifact?.downloadedArchiveDigest ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Release policy receipt artifact is missing the exact downloaded archive digest");
  }
  return digest;
}

export function buildPolicyStatus({ headSha, digest, targetUrl }) {
  return {
    state: "success",
    context: RELEASE_POLICY_RECEIPT_CONTEXT,
    description: `${RELEASE_POLICY_RECEIPT_PREFIX}${digest}`,
    target_url: targetUrl,
    sha: assertSha(headSha)
  };
}

export function buildPolicyReceiptArtifact({
  repository,
  branch,
  headSha,
  pullNumber,
  policy,
  workflowRunId,
  workflowRunAttempt = "1",
  eventAction,
  observedAt,
  mergeCommitSha = null,
  mergedAt = null,
  sourceWorkflowRunId = null,
  sourceWorkflowRunAttempt = null,
  sourcePolicyDigest = null,
  sourcePolicyArtifactDigest = null,
  eventName = RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT,
  triggerWorkflowRunId = null,
  closedMergeWorkflowRunId = null,
  closedMergeWorkflowRunAttempt = null
}) {
  const normalizedHead = assertSha(headSha);
  const normalizedPullNumber = Number(pullNumber);
  if (!Number.isInteger(normalizedPullNumber) || normalizedPullNumber <= 0) {
    throw new Error("Release policy receipt artifact requires a positive pull-request number");
  }
  const observedMs = Date.parse(String(observedAt ?? ""));
  if (!Number.isFinite(observedMs)) throw new Error("Release policy receipt artifact requires an observation timestamp");
  let runId;
  try {
    runId = canonicalWorkflowRunId(workflowRunId, "receipt artifact");
  } catch {
    throw new Error("Release policy receipt artifact requires a workflow run id");
  }
  if (!/^\d+$/.test(runId)) throw new Error("Release policy receipt artifact requires a workflow run id");
  let runAttempt;
  try {
    runAttempt = canonicalWorkflowRunId(workflowRunAttempt, "receipt artifact run attempt");
  } catch {
    throw new Error("Release policy receipt artifact requires a workflow run attempt");
  }
  if (!repository || !branch || !eventAction) throw new Error("Release policy receipt artifact requires repository, branch, and event metadata");
  const normalizedEventName = String(eventName ?? "").trim();
  if (![RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT, RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT].includes(normalizedEventName)) {
    throw new Error("Release policy receipt artifact received an unsupported workflow event");
  }
  let normalizedTriggerRunId = "";
  let normalizedClosedMergeRunId = "";
  let normalizedClosedMergeRunAttempt = "";
  if (normalizedEventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT) {
    try {
      normalizedTriggerRunId = canonicalWorkflowRunId(triggerWorkflowRunId, "reconciliation receipt trigger");
    } catch {
      throw new Error("Workflow-run release policy receipt requires its triggering workflow run id");
    }
    try {
      normalizedClosedMergeRunId = canonicalWorkflowRunId(closedMergeWorkflowRunId, "reconciliation closed-merge run");
      normalizedClosedMergeRunAttempt = canonicalWorkflowRunId(closedMergeWorkflowRunAttempt, "reconciliation closed-merge run attempt");
    } catch {
      throw new Error("Workflow-run release policy receipt requires its independently verified closed-merge run binding");
    }
  }
  if (normalizedEventName === RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT && normalizedTriggerRunId) {
    throw new Error("Pull-request release policy receipt cannot carry a workflow-run trigger binding");
  }
  const artifact = {
    schemaVersion: 1,
    kind: RELEASE_POLICY_RECEIPT_ARTIFACT_KIND,
    repository: String(repository),
    workflowFile: normalizedEventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT
      ? RELEASE_POLICY_RECEIPT_RECONCILIATION_WORKFLOW_FILE
      : RELEASE_POLICY_RECEIPT_WORKFLOW_FILE,
    workflowRunId: runId,
    workflowRunAttempt: runAttempt,
    eventName: normalizedEventName,
    eventAction: String(eventAction),
    branch: String(branch),
    pullNumber: normalizedPullNumber,
    headSha: normalizedHead,
    policy,
    policyDigest: policyDigest(policy),
    observedAt: new Date(observedMs).toISOString()
  };
  if (RELEASE_POLICY_RECEIPT_PREMERGE_ACTIONS.includes(String(eventAction))) {
    if (normalizedEventName !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT) {
      throw new Error("Workflow-run release policy receipt cannot publish a pre-merge artifact");
    }
    return artifact;
  }
  if (String(eventAction) !== RELEASE_POLICY_RECEIPT_MERGE_ACTION) {
    throw new Error("Release policy receipt artifact received an unsupported pull-request event action");
  }
  const normalizedMergeCommitSha = assertSha(mergeCommitSha);
  const mergedMs = Date.parse(String(mergedAt ?? ""));
  const sourceRunId = String(sourceWorkflowRunId ?? "").trim();
  let sourceRunAttempt;
  try {
    sourceRunAttempt = canonicalWorkflowRunId(sourceWorkflowRunAttempt ?? runAttempt, "source policy receipt run attempt");
  } catch {
    throw new Error("Merge-bound release policy receipt artifact requires a source workflow run attempt");
  }
  const sourceDigest = String(sourcePolicyDigest ?? "").trim().toLowerCase();
  const sourceArtifactDigest = String(sourcePolicyArtifactDigest ?? "").trim().toLowerCase();
  if (!Number.isFinite(mergedMs) || !/^\d+$/.test(sourceRunId) || !/^[a-f0-9]{64}$/.test(sourceDigest) ||
      !/^[a-f0-9]{64}$/.test(sourceArtifactDigest)) {
    throw new Error("Merge-bound release policy receipt artifact requires merge and pre-merge continuity fields");
  }
  if (policyDigest(policy) !== sourceDigest) {
    throw new Error("Merge-bound release policy receipt rejects a changed required-check policy");
  }
  return {
    ...artifact,
    mergeCommitSha: normalizedMergeCommitSha,
    mergedAt: new Date(mergedMs).toISOString(),
    sourceWorkflowRunId: sourceRunId,
    sourceWorkflowRunAttempt: sourceRunAttempt,
    sourcePolicyDigest: sourceDigest,
    sourcePolicyArtifactDigest: sourceArtifactDigest,
    ...(normalizedEventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT
      ? {
          triggerWorkflowRunId: normalizedTriggerRunId,
          closedMergeWorkflowRunId: normalizedClosedMergeRunId,
          closedMergeWorkflowRunAttempt: normalizedClosedMergeRunAttempt
        }
      : {})
  };
}

export function buildClosedPolicyReceiptBinding({
  repository,
  branch,
  headSha,
  pullNumber,
  workflowRunId,
  workflowRunAttempt = "1",
  observedAt,
  mergeCommitSha,
  mergedAt,
  eventName = RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT,
  eventAction = RELEASE_POLICY_RECEIPT_MERGE_ACTION
}) {
  const normalizedHead = assertSha(headSha);
  const normalizedMergeCommit = assertSha(mergeCommitSha);
  const normalizedPullNumber = Number(pullNumber);
  let runId;
  try {
    runId = canonicalWorkflowRunId(workflowRunId, "close binding");
  } catch {
    throw new Error("Release policy close binding requires an observed closed-and-merged pull-request event");
  }
  let runAttempt;
  try {
    runAttempt = canonicalWorkflowRunId(workflowRunAttempt, "close binding run attempt");
  } catch {
    throw new Error("Release policy close binding requires a workflow run attempt");
  }
  const observedMs = Date.parse(String(observedAt ?? ""));
  const mergedMs = Date.parse(String(mergedAt ?? ""));
  if (!repository || !branch || !/^\d+$/.test(runId) || !Number.isInteger(normalizedPullNumber) || normalizedPullNumber <= 0 ||
      eventName !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT || eventAction !== RELEASE_POLICY_RECEIPT_MERGE_ACTION ||
      !Number.isFinite(observedMs) || !Number.isFinite(mergedMs) || observedMs < mergedMs) {
    throw new Error("Release policy close binding requires an observed closed-and-merged pull-request event");
  }
  return {
    schemaVersion: 1,
    kind: RELEASE_POLICY_CLOSE_BINDING_ARTIFACT_KIND,
    repository: String(repository),
    workflowFile: RELEASE_POLICY_RECEIPT_WORKFLOW_FILE,
    workflowRunId: runId,
    workflowRunAttempt: runAttempt,
    eventName,
    eventAction,
    branch: String(branch),
    pullNumber: normalizedPullNumber,
    headSha: normalizedHead,
    mergeCommitSha: normalizedMergeCommit,
    mergedAt: new Date(mergedMs).toISOString(),
    observedAt: new Date(observedMs).toISOString()
  };
}

function workflowRunTerminalTime(run) {
  const completedAt = Date.parse(String(run?.completed_at ?? ""));
  if (Number.isFinite(completedAt)) return completedAt;
  const updatedAt = Date.parse(String(run?.updated_at ?? ""));
  return Number.isFinite(updatedAt) ? updatedAt : Number.NaN;
}

function parseWorkflowRunReconciliationEnvelope(payload, { repository = null } = {}) {
  if (payload?.action !== "completed") {
    throw new Error("Workflow-run release policy reconciliation requires a completed event");
  }
  const run = payload?.workflow_run;
  if (!run || typeof run !== "object" || Array.isArray(run) ||
      String(run.path ?? "") !== RELEASE_POLICY_RECEIPT_WORKFLOW_FILE ||
      String(run.event ?? "") !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT ||
      String(run.status ?? "") !== "completed" || !String(run.conclusion ?? "") ||
      !Number.isFinite(workflowRunTerminalTime(run)) ||
      (repository !== null && String(run.repository?.full_name ?? "") !== String(repository))) {
    throw new Error("Workflow-run release policy reconciliation requires a completed pull-request-target source run");
  }
  const triggerWorkflowRunId = canonicalWorkflowRunId(run.id, "reconciliation trigger");
  return { run, triggerWorkflowRunId };
}

function reconciliationPullBinding(pull, triggerWorkflowRunId) {
  const pullNumber = Number(pull?.number);
  const branch = String(pull?.base?.ref ?? "").trim();
  const headSha = assertSha(pull?.head?.sha);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0 || !branch) {
    throw new Error("Workflow-run release policy reconciliation requires a complete pull-request binding");
  }
  return { triggerWorkflowRunId, pullNumber, branch, headSha };
}

export function parseWorkflowRunReconciliationEvent(payload, { repository = null } = {}) {
  const { run, triggerWorkflowRunId } = parseWorkflowRunReconciliationEnvelope(payload, { repository });
  const pullRequests = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  if (pullRequests.length !== 1) throw new Error("Workflow-run release policy reconciliation requires exactly one associated pull request");
  return reconciliationPullBinding(pullRequests[0], triggerWorkflowRunId);
}

async function repositoryPullRequestsForCommit({ apiUrl, repository, headSha, token, fetchImpl = fetch }) {
  const pulls = [];
  const listedByNumber = new Map();
  for (let page = 1; page <= RECONCILIATION_PULL_MAX_PAGES; page += 1) {
    const pageItems = await requestJson({
      apiUrl,
      path: `/repos/${repository}/commits/${headSha}/pulls?per_page=${RECONCILIATION_PULL_PAGE_SIZE}&page=${page}`,
      token,
      fetchImpl
    });
    if (!Array.isArray(pageItems)) {
      throw new Error("Workflow-run release policy reconciliation returned an invalid commit pull-request listing");
    }
    for (const pull of pageItems) {
      const pullNumber = Number(pull?.number);
      if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
        throw new Error("Workflow-run release policy reconciliation returned an invalid pull-request identity");
      }
      const serialized = JSON.stringify(pull);
      const prior = listedByNumber.get(pullNumber);
      if (prior) {
        if (prior !== serialized) {
          throw new Error(`Workflow-run release policy reconciliation returned an ambiguous duplicate pull-request identity: ${pullNumber}`);
        }
        continue;
      }
      listedByNumber.set(pullNumber, serialized);
      pulls.push(pull);
    }
    if (pageItems.length < RECONCILIATION_PULL_PAGE_SIZE) break;
    if (page === RECONCILIATION_PULL_MAX_PAGES) {
      throw new Error("Workflow-run release policy reconciliation exceeded its bounded commit pull-request listing");
    }
  }
  return pulls;
}

export async function resolveWorkflowRunReconciliationEvent({
  payload,
  apiUrl,
  repository,
  token,
  fetchImpl = fetch
}) {
  const { run, triggerWorkflowRunId } = parseWorkflowRunReconciliationEnvelope(payload, { repository });
  const pullRequests = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  if (pullRequests.length === 1) return reconciliationPullBinding(pullRequests[0], triggerWorkflowRunId);
  if (pullRequests.length > 1) {
    throw new Error("Workflow-run release policy reconciliation requires exactly one associated pull request");
  }
  const headSha = assertSha(run.head_sha);
  const headRef = typeof run.head_branch === "string" ? run.head_branch : "";
  if (!isValidPullRequestHeadRef(headRef)) {
    throw new Error("Workflow-run release policy reconciliation cannot recover an exact source branch");
  }
  const associatedPulls = await repositoryPullRequestsForCommit({
    apiUrl,
    repository,
    headSha,
    token,
    fetchImpl
  });
  const matches = associatedPulls.filter((pull) => (
    pull?.state === "closed" &&
    Number.isFinite(Date.parse(String(pull?.merged_at ?? ""))) &&
    /^[0-9a-f]{40}$/.test(String(pull?.merge_commit_sha ?? "").toLowerCase()) &&
    RELEASE_POLICY_BRANCHES.has(String(pull?.base?.ref ?? "")) &&
    String(pull?.head?.sha ?? "").toLowerCase() === headSha &&
    String(pull?.head?.ref ?? "") === headRef
  ));
  if (matches.length !== 1) {
    throw new Error("Workflow-run release policy reconciliation requires exactly one associated merged pull request for the sparse provider run");
  }
  return reconciliationPullBinding(matches[0], triggerWorkflowRunId);
}

export function assertExactReconciliationTrigger({ triggerWorkflowRunId, closedMergeRunId }) {
  let trigger;
  let closedMerge;
  try {
    trigger = canonicalWorkflowRunId(triggerWorkflowRunId, "reconciliation trigger");
    closedMerge = canonicalWorkflowRunId(closedMergeRunId, "closed-merge run");
  } catch {
    throw new Error("Workflow-run release policy reconciliation requires valid trigger and closed-merge workflow identities");
  }
  // The workflow_run event may be emitted by a later completed trusted
  // pull_request_target source run. Its identity need not equal the exact
  // closed-merge run, which is independently proven by its close binding.
  return { triggerWorkflowRunId: trigger, closedMergeRunId: closedMerge };
}

function readZipJsonEntry(buffer, filename) {
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  let offset = 0;
  while (offset + 46 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== centralSignature) {
      offset += 1;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (name === filename) {
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== localSignature) {
        throw new Error("Release policy artifact has an invalid local ZIP header");
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > buffer.length || uncompressedSize > 128 * 1024) {
        throw new Error("Release policy artifact entry exceeds its bounded size");
      }
      const compressed = buffer.subarray(dataStart, dataEnd);
      let contents;
      if (method === 0) contents = compressed;
      else if (method === 8) contents = inflateRawSync(compressed);
      else throw new Error("Release policy artifact uses an unsupported ZIP compression method");
      if (contents.length !== uncompressedSize) throw new Error("Release policy artifact has an invalid uncompressed size");
      return JSON.parse(contents.toString("utf8"));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Release policy artifact is missing ${filename}`);
}

async function fetchWorkflowRunArtifactJson({ apiUrl, repository, runId, runAttempt = null, token, artifactName, artifactFile, fetchImpl = fetch }) {
  let normalizedRunId;
  try {
    normalizedRunId = canonicalWorkflowRunId(runId, "artifact lookup workflow run");
  } catch {
    throw new Error("Release policy artifact lookup requires a canonical workflow run id");
  }
  let normalizedRunAttempt = null;
  if (runAttempt !== null && runAttempt !== undefined) {
    try {
      normalizedRunAttempt = canonicalWorkflowRunId(runAttempt, "artifact lookup workflow run attempt");
    } catch {
      throw new Error("Release policy artifact lookup requires a canonical workflow run attempt");
    }
  }
  const listedArtifacts = [];
  const listedById = new Map();
  let listedCount = 0;
  let reportedTotalCount = null;
  for (let page = 1; page <= 10; page += 1) {
    const payload = await requestJson({
      apiUrl,
      path: `/repos/${repository}/actions/runs/${encodeURIComponent(normalizedRunId)}/artifacts?per_page=100&page=${page}`,
      token,
      fetchImpl
    });
    if (!Array.isArray(payload?.artifacts)) {
      throw new Error(`Release policy workflow ${normalizedRunId} returned an invalid artifact listing`);
    }
    if (payload.total_count !== undefined) {
      if (!Number.isSafeInteger(payload.total_count) || payload.total_count < 0 ||
          (reportedTotalCount !== null && payload.total_count !== reportedTotalCount)) {
        throw new Error(`Release policy workflow ${normalizedRunId} returned an invalid artifact listing count`);
      }
      reportedTotalCount = payload.total_count;
    }
    listedCount += payload.artifacts.length;
    for (const artifact of payload.artifacts) {
      let artifactId;
      try {
        artifactId = canonicalWorkflowRunId(artifact?.id, "provider artifact");
      } catch {
        throw new Error(`Release policy workflow ${normalizedRunId} returned an invalid provider artifact identity`);
      }
      const serialized = JSON.stringify(artifact);
      const prior = listedById.get(artifactId);
      if (prior !== undefined) {
        if (prior !== serialized) {
          throw new Error(`Release policy workflow ${normalizedRunId} returned an ambiguous duplicate provider artifact: ${artifactId}`);
        }
        continue;
      }
      listedById.set(artifactId, serialized);
      listedArtifacts.push({ artifact, artifactId });
    }
    if (payload.artifacts.length < 100) {
      if (reportedTotalCount !== null && listedCount < reportedTotalCount) {
        throw new Error(`Release policy workflow ${normalizedRunId} artifact listing is incomplete`);
      }
      break;
    }
    if (page === 10) {
      throw new Error(`Release policy workflow ${normalizedRunId} artifact listing exceeded its bounded page limit`);
    }
  }
  const expectedName = normalizedRunAttempt === null
    ? `${artifactName}-${normalizedRunId}`
    : `${artifactName}-${normalizedRunId}-${normalizedRunAttempt}`;
  const named = listedArtifacts
    .filter(({ artifact }) => artifact?.name === expectedName)
    .map(({ artifact }) => artifact);
  if (named.length === 0 && artifactName === RELEASE_POLICY_CLOSE_BINDING_ARTIFACT_NAME) {
    throw new MissingPolicyCloseBindingArtifactError(`Release policy workflow ${normalizedRunId} has no immutable close binding artifact`);
  }
  if (named.length !== 1) throw new Error(`Release policy workflow ${normalizedRunId} must expose exactly one immutable policy artifact`);
  const artifact = named[0];
  let artifactWorkflowRunId = null;
  if (artifact.workflow_run?.id !== undefined) {
    try {
      artifactWorkflowRunId = canonicalWorkflowRunId(artifact.workflow_run.id, "provider artifact workflow run");
    } catch {
      throw new Error(`Release policy workflow ${normalizedRunId} exposed an invalid immutable policy artifact`);
    }
  }
  if (artifact.expired === true || (artifactWorkflowRunId !== null && artifactWorkflowRunId !== normalizedRunId)) {
    throw new Error(`Release policy workflow ${normalizedRunId} exposed an invalid immutable policy artifact`);
  }
  const downloadUrl = String(artifact.archive_download_url ?? "");
  if (!downloadUrl) throw new Error(`Release policy workflow ${normalizedRunId} returned no artifact download URL`);
  const response = await fetchImpl(downloadUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "better-workflows-release-policy-receipt"
    }
  });
  if (!response.ok || typeof response.arrayBuffer !== "function") {
    throw new Error(`Release policy workflow ${normalizedRunId} artifact download failed`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const downloadedArchiveDigest = createHash("sha256").update(archive).digest("hex");
  const declaredDigest = String(artifact.digest ?? "").replace(/^sha256:/i, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(declaredDigest)) {
    throw new Error(`Release policy workflow ${normalizedRunId} returned a missing or malformed artifact digest`);
  }
  if (downloadedArchiveDigest !== declaredDigest) {
    throw new Error(`Release policy workflow ${normalizedRunId} artifact digest drifted`);
  }
  const parsed = readZipJsonEntry(archive, artifactFile);
  if (normalizedRunAttempt !== null && String(parsed?.workflowRunAttempt ?? "") !== normalizedRunAttempt) {
    throw new Error(`Release policy workflow ${normalizedRunId} artifact is not bound to workflow run attempt ${normalizedRunAttempt}`);
  }
  Object.defineProperty(parsed, "downloadedArchiveDigest", {
    value: downloadedArchiveDigest,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return parsed;
}

export async function fetchWorkflowRunPolicyReceiptArtifact({ apiUrl, repository, runId, runAttempt = null, token, fetchImpl = fetch }) {
  return fetchWorkflowRunArtifactJson({
    apiUrl,
    repository,
    runId,
    runAttempt,
    token,
    artifactName: RELEASE_POLICY_RECEIPT_ARTIFACT_NAME,
    artifactFile: RELEASE_POLICY_RECEIPT_ARTIFACT_FILE,
    fetchImpl
  });
}

export async function fetchWorkflowRunCloseBindingArtifact({ apiUrl, repository, runId, runAttempt = null, token, fetchImpl = fetch }) {
  return fetchWorkflowRunArtifactJson({
    apiUrl,
    repository,
    runId,
    runAttempt,
    token,
    artifactName: RELEASE_POLICY_CLOSE_BINDING_ARTIFACT_NAME,
    artifactFile: RELEASE_POLICY_CLOSE_BINDING_ARTIFACT_FILE,
    fetchImpl
  });
}

export function assertClosedPolicyReceiptBinding({ run, pull, binding, repository = null }) {
  let runId;
  try {
    runId = canonicalWorkflowRunId(run?.id, "closed-merge run");
  } catch {
    throw new Error("Workflow-run release policy reconciliation requires the exact completed closed-and-merged pull-request-target run");
  }
  const pullNumber = Number(pull?.number);
  let runAttempt;
  try {
    runAttempt = canonicalWorkflowRunId(run?.run_attempt, "closed-merge run attempt");
  } catch {
    throw new Error("Workflow-run release policy reconciliation requires the exact completed closed-and-merged pull-request-target run");
  }
  const branch = String(pull?.base?.ref ?? "");
  const headSha = assertSha(pull?.head?.sha);
  const headRef = String(pull?.head?.ref ?? "");
  const mergeCommitSha = assertSha(pull?.merge_commit_sha);
  const mergedAtMs = Date.parse(String(pull?.merged_at ?? ""));
  const terminalAtMs = workflowRunTerminalTime(run);
  const runPullRequests = Array.isArray(run?.pull_requests) ? run.pull_requests : null;
  const associatedPull = runPullRequests?.find((item) => Number(item?.number) === pullNumber) ?? null;
  const runHeadSha = String(run?.head_sha ?? "").toLowerCase();
  const associatedProviderBinding = Boolean(associatedPull) &&
    String(associatedPull?.base?.ref ?? "") === branch &&
    String(associatedPull?.head?.sha ?? "").toLowerCase() === headSha &&
    runHeadSha === mergeCommitSha;
  const sparseProviderBinding = runPullRequests?.length === 0 &&
    Boolean(headRef) && String(run?.head_branch ?? "") === headRef && runHeadSha === headSha;
  if (!/^\d+$/.test(runId) || String(run?.path ?? "") !== RELEASE_POLICY_RECEIPT_WORKFLOW_FILE ||
      String(run?.event ?? "") !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT ||
      String(run?.status ?? "") !== "completed" || !String(run?.conclusion ?? "") ||
      !Number.isFinite(terminalAtMs) || terminalAtMs < mergedAtMs ||
      (repository !== null && String(run?.repository?.full_name ?? "") !== String(repository)) ||
      !Number.isInteger(pullNumber) || pullNumber <= 0 || !branch || pull?.state !== "closed" || pull?.merged !== true ||
      !Number.isFinite(mergedAtMs) || !/^[0-9a-f]{40}$/.test(runHeadSha) ||
      (!associatedProviderBinding && !sparseProviderBinding)) {
    throw new Error("Workflow-run release policy reconciliation requires the exact completed closed-and-merged pull-request-target run");
  }
  const bindingMergedAt = Date.parse(String(binding?.mergedAt ?? ""));
  const bindingObservedAt = Date.parse(String(binding?.observedAt ?? ""));
  if (!binding || binding.schemaVersion !== 1 || binding.kind !== RELEASE_POLICY_CLOSE_BINDING_ARTIFACT_KIND ||
      binding.workflowFile !== RELEASE_POLICY_RECEIPT_WORKFLOW_FILE || String(binding.workflowRunId) !== runId ||
      String(binding.workflowRunAttempt) !== runAttempt ||
      binding.eventName !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT || binding.eventAction !== RELEASE_POLICY_RECEIPT_MERGE_ACTION ||
      binding.repository !== (repository === null ? binding.repository : repository) || binding.branch !== branch ||
      Number(binding.pullNumber) !== pullNumber || String(binding.headSha ?? "").toLowerCase() !== headSha ||
      String(binding.mergeCommitSha ?? "").toLowerCase() !== mergeCommitSha ||
      !Number.isFinite(bindingMergedAt) || bindingMergedAt !== mergedAtMs ||
      !Number.isFinite(bindingObservedAt) || bindingObservedAt < mergedAtMs || bindingObservedAt > terminalAtMs) {
    throw new Error("Workflow-run release policy reconciliation requires an immutable closed-and-merged source binding");
  }
  return { runId, runAttempt, pullNumber, branch, headSha, mergeCommitSha, mergedAt: new Date(mergedAtMs).toISOString() };
}

async function requestJson({ apiUrl, path, token, options = {}, fetchImpl = fetch }) {
  const response = await fetchImpl(`${String(apiUrl).replace(/\/$/, "")}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "better-workflows-release-policy-receipt",
      ...(options.headers ?? {})
    }
  });
  if (!response.ok) {
    const error = new Error(`Release policy receipt GitHub request failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

async function repositoryCommitStatuses({ apiUrl, repository, sha, token, fetchImpl = fetch }) {
  const statuses = [];
  for (let page = 1; page <= 10; page += 1) {
    const payload = await requestJson({
      apiUrl,
      path: `/repos/${repository}/commits/${encodeURIComponent(sha)}/statuses?per_page=100&page=${page}`,
      token,
      fetchImpl
    });
    if (!Array.isArray(payload)) throw new Error("Release policy receipt status query returned an invalid payload");
    statuses.push(...payload);
    if (payload.length < 100) return statuses;
  }
  throw new Error("Release policy receipt status query exceeded its bounded page limit");
}

function sourcePolicyReceipt(status, { repository, branch, headSha, pullNumber, requireWorkflowRunAttempt = false }) {
  if (status?.context !== RELEASE_POLICY_RECEIPT_CONTEXT) return null;
  const rawStatusId = typeof status?.id === "string"
    ? status.id.trim()
    : Number.isSafeInteger(status?.id) && status.id >= 0 ? String(status.id) : "";
  if (!/^(0|[1-9]\d*)$/.test(rawStatusId)) {
    throw new Error("Release policy receipt source status has a missing or malformed provider identity");
  }
  let targetUrl;
  try {
    targetUrl = new URL(String(status.target_url ?? ""));
  } catch {
    throw new Error("Release policy receipt source status has a malformed provider URL");
  }
  const runMatch = /\/actions\/runs\/(\d+)(?:[/?]|$)/.exec(targetUrl.pathname);
  const description = String(status.description ?? "");
  const digest = description.startsWith(RELEASE_POLICY_RECEIPT_PREFIX)
    ? description.slice(RELEASE_POLICY_RECEIPT_PREFIX.length).toLowerCase()
    : "";
  if (
    targetUrl.pathname !== `/${repository}/actions/runs/${runMatch?.[1] ?? ""}` ||
    targetUrl.searchParams.get("phase") !== "pre-merge" ||
    targetUrl.searchParams.get("pr") !== String(pullNumber) ||
    targetUrl.searchParams.get("head") !== headSha ||
    targetUrl.searchParams.get("base") !== branch ||
    !runMatch?.[1]
  ) {
    throw new Error(`Release policy receipt source status has an invalid exact workflow binding: ${rawStatusId}`);
  }
  const workflowRunId = canonicalWorkflowRunId(runMatch[1], "source policy status workflow run");
  const rawRunAttempt = targetUrl.searchParams.get("attempt");
  let workflowRunAttempt = null;
  if (rawRunAttempt !== null) {
    try {
      workflowRunAttempt = canonicalWorkflowRunId(rawRunAttempt, "source policy status workflow run attempt");
    } catch {
      throw new Error(`Release policy receipt source status has an invalid workflow run attempt: ${rawStatusId}`);
    }
  } else if (requireWorkflowRunAttempt) {
    throw new Error(`Release policy receipt source status has no workflow run attempt: ${rawStatusId}`);
  }
  const originAt = Date.parse(String(status.created_at ?? status.started_at ?? ""));
  const terminalAt = Date.parse(String(status.updated_at ?? status.completed_at ?? ""));
  if (!Number.isFinite(originAt) || !Number.isFinite(terminalAt)) {
    throw new Error(`Release policy receipt source status has an invalid observation timestamp: ${rawStatusId}`);
  }
  return {
    status,
    statusId: rawStatusId,
    workflowRunId,
    workflowRunAttempt,
    state: String(status.state ?? ""),
    policyDigest: digest,
    originAt,
    terminalAt
  };
}

function compareDecimalIds(left, right) {
  const leftId = BigInt(String(left));
  const rightId = BigInt(String(right));
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

export function assertPreMergePolicyReceiptArtifact({ artifact, repository, branch, headSha, pullNumber, workflowRunId, workflowRunAttempt = null, statusObservedAt }) {
  const parseTimestamp = (value) => typeof value === "number" && Number.isFinite(value)
    ? value
    : Date.parse(String(value ?? ""));
  const observedAt = parseTimestamp(artifact?.observedAt);
  const statusAt = parseTimestamp(statusObservedAt);
  if (!artifact || artifact.schemaVersion !== 1 || artifact.kind !== RELEASE_POLICY_RECEIPT_ARTIFACT_KIND ||
      artifact.repository !== repository || artifact.workflowFile !== RELEASE_POLICY_RECEIPT_WORKFLOW_FILE ||
      artifact.workflowRunId !== String(workflowRunId) || artifact.eventName !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT ||
      (workflowRunAttempt !== null && String(artifact.workflowRunAttempt) !== String(workflowRunAttempt)) ||
      !RELEASE_POLICY_RECEIPT_PREMERGE_ACTIONS.includes(String(artifact.eventAction)) || artifact.branch !== branch ||
      Number(artifact.pullNumber) !== Number(pullNumber) || String(artifact.headSha ?? "").toLowerCase() !== String(headSha).toLowerCase() ||
      !Array.isArray(artifact.policy) || artifact.policy.length === 0 || artifact.policyDigest !== policyDigest(artifact.policy) ||
      !/^[a-f0-9]{64}$/.test(String(artifact.policyDigest ?? "")) || !Number.isFinite(observedAt) ||
      !Number.isFinite(statusAt) || observedAt > statusAt) {
    throw new Error("Release policy receipt source artifact is not bound to the trusted pre-merge workflow");
  }
  return artifact;
}

async function repositoryWorkflowRun({ apiUrl, repository, runId, token, fetchImpl = fetch }) {
  return requestJson({
    apiUrl,
    path: `/repos/${repository}/actions/runs/${encodeURIComponent(runId)}`,
    token,
    fetchImpl
  });
}

export async function findClosedMergeWorkflowRun({
  apiUrl,
  repository,
  branch,
  pullNumber,
  headSha,
  headRef = null,
  mergeCommitSha,
  mergedAt,
  token,
  fetchImpl = fetch,
  fetchCloseBindingImpl = fetchWorkflowRunCloseBindingArtifact
}) {
  const normalizedRepository = String(repository ?? "").trim();
  const normalizedBranch = String(branch ?? "").trim();
  const normalizedHeadRef = headRef === null || headRef === undefined ? "" : String(headRef);
  const normalizedPullNumber = Number(pullNumber);
  const normalizedHeadSha = assertSha(headSha);
  const normalizedMergeCommitSha = assertSha(mergeCommitSha);
  const mergedAtMs = Date.parse(String(mergedAt ?? ""));
  if (!normalizedRepository || !normalizedBranch || !Number.isInteger(normalizedPullNumber) || normalizedPullNumber <= 0 ||
      !Number.isFinite(mergedAtMs)) {
    throw new Error("Release policy reconciliation requires a complete merged pull-request binding");
  }
  if (normalizedHeadRef && !isValidPullRequestHeadRef(normalizedHeadRef)) {
    throw new Error("Release policy reconciliation requires an exact Git-compatible source branch");
  }
  const candidates = [];
  const branchFilters = [...new Set([normalizedHeadRef, normalizedBranch].filter(Boolean))];
  for (const branchFilter of branchFilters) {
    for (let page = 1; page <= 10; page += 1) {
      const payload = await requestJson({
        apiUrl,
        path: `/repos/${normalizedRepository}/actions/workflows/${encodeURIComponent(RELEASE_POLICY_RECEIPT_WORKFLOW_ID)}/runs?event=${RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT}&branch=${encodeURIComponent(branchFilter)}&per_page=100&page=${page}`,
        token,
        fetchImpl
      });
      if (!Array.isArray(payload?.workflow_runs)) {
        throw new Error("Release policy reconciliation returned an invalid workflow-run listing");
      }
      candidates.push(...payload.workflow_runs);
      if (payload.workflow_runs.length < 100) break;
      if (page === 10) throw new Error("Release policy reconciliation exceeded its bounded workflow-run listing");
    }
  }
  const matches = [];
  const listedById = new Map();
  for (const candidate of candidates) {
    let candidateId;
    try {
      candidateId = canonicalWorkflowRunId(candidate?.id, "workflow-run listing");
    } catch {
      throw new Error("Release policy reconciliation returned an invalid workflow-run identity");
    }
    const serializedCandidate = JSON.stringify(candidate);
    const priorCandidate = listedById.get(candidateId);
    if (priorCandidate) {
      if (priorCandidate !== serializedCandidate) {
        throw new Error(`Release policy reconciliation returned an ambiguous duplicate workflow-run identity: ${candidateId}`);
      }
      continue;
    }
    listedById.set(candidateId, serializedCandidate);
    const run = await repositoryWorkflowRun({ apiUrl, repository: normalizedRepository, runId: candidateId, token, fetchImpl });
    let returnedRunId;
    let returnedRunAttempt;
    try {
      returnedRunId = canonicalWorkflowRunId(run?.id, "workflow-run response");
      returnedRunAttempt = canonicalWorkflowRunId(run?.run_attempt, "workflow-run attempt response");
    } catch {
      continue;
    }
    if (returnedRunId !== candidateId) continue;
    const runPullRequests = Array.isArray(run?.pull_requests) ? run.pull_requests : null;
    const associatedPull = runPullRequests?.find((item) => Number(item?.number) === normalizedPullNumber) ?? null;
    const runHeadSha = String(run?.head_sha ?? "").toLowerCase();
    const associatedProviderBinding = Boolean(associatedPull) &&
      String(associatedPull?.base?.ref ?? "") === normalizedBranch &&
      String(associatedPull?.head?.sha ?? "").toLowerCase() === normalizedHeadSha &&
      runHeadSha === normalizedMergeCommitSha;
    // GitHub may omit pull_requests and expose the PR head instead of the
    // merge commit for pull_request_target runs. Accept that sparse envelope
    // only at the exact provider-filtered head branch; the immutable close
    // binding below must still prove the PR, head, merge commit, timestamp,
    // run id, and run attempt before this candidate is admitted.
    const sparseProviderEnvelope = runPullRequests?.length === 0 && Boolean(normalizedHeadRef) &&
      String(run?.head_branch ?? "") === normalizedHeadRef && runHeadSha === normalizedHeadSha;
    if (String(run?.path ?? "") !== RELEASE_POLICY_RECEIPT_WORKFLOW_FILE ||
        String(run?.event ?? "") !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT ||
        String(run?.status ?? "") !== "completed" || !String(run?.conclusion ?? "") ||
        !/^[0-9a-f]{40}$/.test(runHeadSha) || (!associatedProviderBinding && !sparseProviderEnvelope)) continue;
    const createdAtMs = Date.parse(String(run.created_at ?? ""));
    if (!Number.isFinite(createdAtMs) || createdAtMs < mergedAtMs) continue;
    const terminalAtMs = workflowRunTerminalTime(run);
    if (!Number.isFinite(terminalAtMs) || terminalAtMs < mergedAtMs) continue;
    let binding;
    try {
      binding = await fetchCloseBindingImpl({
        apiUrl,
        repository: normalizedRepository,
        runId: candidateId,
        runAttempt: returnedRunAttempt,
        token,
        fetchImpl
      });
    } catch (error) {
      if (error instanceof MissingPolicyCloseBindingArtifactError) continue;
      throw error;
    }
    assertClosedPolicyReceiptBinding({
      repository: normalizedRepository,
      run,
      pull: {
        number: normalizedPullNumber,
        state: "closed",
        merged: true,
        base: { ref: normalizedBranch },
        head: { sha: normalizedHeadSha, ref: normalizedHeadRef },
        merge_commit_sha: normalizedMergeCommitSha,
        merged_at: mergedAt
      },
      binding
    });
    matches.push({ run, binding });
  }
  if (matches.length === 0) {
    throw new MissingPolicyCloseBindingArtifactError("Release policy reconciliation has no exact completed closed-merge binding");
  }
  if (matches.length !== 1) {
    throw new Error("Release policy reconciliation found multiple exact completed closed-merge bindings");
  }
  return matches[0];
}

function sourceWorkflowRunMatches(run, {
  repository,
  branch,
  headSha,
  pullNumber,
  workflowRunId,
  workflowRunAttempt,
  mergedAtMs,
  statusOriginAtMs,
  statusObservedAtMs
}) {
  let returnedRunId;
  let expectedRunId;
  let returnedRunAttempt = null;
  try {
    returnedRunId = canonicalWorkflowRunId(run?.id, "source policy workflow run response");
    expectedRunId = canonicalWorkflowRunId(workflowRunId, "source policy workflow run binding");
    if (workflowRunAttempt !== null) {
      returnedRunAttempt = canonicalWorkflowRunId(run?.run_attempt, "source policy workflow run attempt");
    }
  } catch {
    return false;
  }
  if (!run || typeof run !== "object" || Array.isArray(run) ||
      returnedRunId !== expectedRunId || String(run.path ?? "") !== RELEASE_POLICY_RECEIPT_WORKFLOW_FILE ||
      String(run.event ?? "") !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT ||
      String(run.status ?? "") !== "completed" || String(run.conclusion ?? "") !== "success" ||
      !/^[0-9a-f]{40}$/.test(String(run.head_sha ?? "").toLowerCase()) ||
      String(run.repository?.full_name ?? "") !== repository ||
      (workflowRunAttempt !== null && returnedRunAttempt !== String(workflowRunAttempt)) ||
      !Array.isArray(run.pull_requests)) return false;
  const pull = run.pull_requests.find((item) => Number(item?.number) === Number(pullNumber));
  if (!pull || String(pull.base?.ref ?? "") !== branch || String(pull.head?.sha ?? "").toLowerCase() !== headSha) return false;
  const baseSha = String(pull.base?.sha ?? "").toLowerCase();
  if (baseSha && (!/^[0-9a-f]{40}$/.test(baseSha) || String(run.head_sha).toLowerCase() !== baseSha)) return false;
  if (!baseSha && run.head_branch !== undefined && String(run.head_branch) !== branch) return false;
  const createdAt = Date.parse(String(run.created_at ?? ""));
  const terminalAt = workflowRunTerminalTime(run);
  return Number.isFinite(createdAt) && Number.isFinite(terminalAt) && createdAt <= terminalAt &&
    Number.isFinite(statusOriginAtMs) && Number.isFinite(statusObservedAtMs) && statusOriginAtMs <= statusObservedAtMs &&
    (mergedAtMs === null || (createdAt <= mergedAtMs && terminalAt <= mergedAtMs && statusObservedAtMs <= mergedAtMs));
}

function sparseSourceWorkflowRunMatches(run, {
  repository,
  branch,
  headSha,
  headRef,
  pullNumber,
  source,
  artifact,
  artifactDigest,
  mergedAtMs
}) {
  const normalizedHeadRef = headRef === null || headRef === undefined ? "" : String(headRef);
  if (!isValidPullRequestHeadRef(normalizedHeadRef) || source?.workflowRunAttempt === null) return false;
  let returnedRunId;
  let returnedRunAttempt;
  try {
    returnedRunId = canonicalWorkflowRunId(run?.id, "sparse source policy workflow run response");
    returnedRunAttempt = canonicalWorkflowRunId(run?.run_attempt, "sparse source policy workflow run attempt");
  } catch {
    return false;
  }
  const createdAt = Date.parse(String(run?.created_at ?? ""));
  const terminalAt = workflowRunTerminalTime(run);
  const runPullRequests = Array.isArray(run?.pull_requests) ? run.pull_requests : null;
  return returnedRunId === String(source.workflowRunId) && returnedRunAttempt === String(source.workflowRunAttempt) &&
    String(run?.path ?? "") === RELEASE_POLICY_RECEIPT_WORKFLOW_FILE &&
    String(run?.event ?? "") === RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT &&
    String(run?.status ?? "") === "completed" && String(run?.conclusion ?? "") === "success" &&
    String(run?.repository?.full_name ?? "") === repository && runPullRequests?.length === 0 &&
    String(run?.head_sha ?? "").toLowerCase() === headSha && String(run?.head_branch ?? "") === normalizedHeadRef &&
    Number.isFinite(createdAt) && Number.isFinite(terminalAt) && createdAt <= terminalAt &&
    Number.isFinite(source.originAt) && Number.isFinite(source.terminalAt) && source.originAt <= source.terminalAt &&
    artifact?.repository === repository && artifact?.branch === branch && Number(artifact?.pullNumber) === Number(pullNumber) &&
    String(artifact?.headSha ?? "").toLowerCase() === headSha && String(artifact?.workflowRunId) === returnedRunId &&
    String(artifact?.workflowRunAttempt) === returnedRunAttempt && artifact?.policyDigest === source.policyDigest &&
    /^[a-f0-9]{64}$/.test(String(artifactDigest ?? "")) &&
    (mergedAtMs === null || (createdAt <= mergedAtMs && terminalAt <= mergedAtMs && source.terminalAt <= mergedAtMs));
}

function waitForReceiptSource(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function waitForSourcePolicyReceipt({
  apiUrl,
  repository,
  branch,
  headSha,
  headRef = null,
  pullNumber,
  token,
  fetchImpl = fetch,
  fetchArtifactImpl = fetchWorkflowRunPolicyReceiptArtifact,
  sleepImpl = waitForReceiptSource,
  attempts = RELEASE_POLICY_RECEIPT_SOURCE_POLL_ATTEMPTS,
  delayMs = RELEASE_POLICY_RECEIPT_SOURCE_POLL_DELAY_MS,
  mergedAt = null,
  requireWorkflowRunAttempt = false
}) {
  if (!Number.isInteger(attempts) || attempts <= 0) {
    throw new Error("Release policy receipt source polling requires a positive bounded attempt count");
  }
  const mergedAtMs = mergedAt === null ? null : Date.parse(String(mergedAt));
  if (mergedAt !== null && !Number.isFinite(mergedAtMs)) {
    throw new Error("Release policy receipt source polling requires a valid merge timestamp");
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const statuses = await repositoryCommitStatuses({ apiUrl, repository, sha: headSha, token, fetchImpl });
    const sourceById = new Map();
    const sources = [];
    for (const status of statuses) {
      if (status?.context !== RELEASE_POLICY_RECEIPT_CONTEXT) continue;
      const source = sourcePolicyReceipt(status, { repository, branch, headSha, pullNumber, requireWorkflowRunAttempt });
      if (!source) continue;
      const serialized = JSON.stringify(status);
      const prior = sourceById.get(source.statusId);
      if (prior) {
        if (prior !== serialized) {
          throw new Error(`Release policy receipt source status has an ambiguous duplicate provider identity: ${source.statusId}`);
        }
        continue;
      }
      sourceById.set(source.statusId, serialized);
      sources.push(source);
    }
    sources.sort((left, right) => left.originAt - right.originAt || compareDecimalIds(left.statusId, right.statusId));
    const source = sources.at(-1) ?? null;
    if (source) {
      let workflowRun;
      try {
        workflowRun = await repositoryWorkflowRun({
          apiUrl,
          repository,
          runId: source.workflowRunId,
          token,
          fetchImpl
        });
      } catch {
        workflowRun = null;
      }
      if (workflowRun && source.state === "success" && /^[a-f0-9]{64}$/.test(source.policyDigest)) {
        let artifact;
        let artifactDigest;
        try {
          artifact = await fetchArtifactImpl({
            apiUrl,
            repository,
            runId: source.workflowRunId,
            runAttempt: source.workflowRunAttempt,
            token,
            fetchImpl
          });
          assertPreMergePolicyReceiptArtifact({
            artifact,
            repository,
            branch,
            headSha,
            pullNumber,
            workflowRunId: source.workflowRunId,
            workflowRunAttempt: source.workflowRunAttempt,
            statusObservedAt: source.terminalAt
          });
          if (artifact.policyDigest !== source.policyDigest) {
            throw new Error("Release policy receipt source status disagrees with its immutable artifact");
          }
          artifactDigest = policyArtifactDigest(artifact);
        } catch {
          // The newest status is authoritative. Do not fall back to an older
          // status or treat an unavailable/forged artifact as continuity
          // evidence; retry the bounded window until the exact artifact is readable.
          artifact = null;
          artifactDigest = null;
        }
        const associatedProviderBinding = artifact && sourceWorkflowRunMatches(workflowRun, {
          repository,
          branch,
          headSha,
          pullNumber,
          workflowRunId: source.workflowRunId,
          workflowRunAttempt: source.workflowRunAttempt,
          mergedAtMs,
          statusOriginAtMs: source.originAt,
          statusObservedAtMs: source.terminalAt
        });
        const sparseProviderBinding = artifact && sparseSourceWorkflowRunMatches(workflowRun, {
          repository,
          branch,
          headSha,
          headRef,
          pullNumber,
          source,
          artifact,
          artifactDigest,
          mergedAtMs
        });
        if (artifact && (associatedProviderBinding || sparseProviderBinding)) {
          return {
            ...source,
            workflowRun,
            policyArtifact: artifact,
            policyArtifactDigest: artifactDigest,
            policyDigest: artifact.policyDigest
          };
        }
      }
    }
    if (attempt < attempts - 1) await sleepImpl(delayMs);
  }
  return null;
}

function rulesetRefPatternMatches(pattern, branch, defaultBranch) {
  if (pattern === "~ALL") return true;
  if (pattern === "~DEFAULT_BRANCH") {
    if (typeof defaultBranch !== "string" || !defaultBranch) {
      throw new Error("Release policy receipt ruleset requires the repository default branch to resolve ~DEFAULT_BRANCH");
    }
    return branch === defaultBranch;
  }
  if (typeof pattern !== "string" || !pattern.startsWith("refs/heads/")) {
    throw new Error(`Release policy receipt ruleset has an unsupported ref pattern: ${String(pattern)}`);
  }
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    if (character === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close < 0) throw new Error(`Release policy receipt ruleset has an unterminated ref character class: ${pattern}`);
      let classBody = pattern.slice(index + 1, close);
      if (!classBody) throw new Error(`Release policy receipt ruleset has an empty ref character class: ${pattern}`);
      if (classBody[0] === "!") classBody = `^${classBody.slice(1)}`;
      classBody = classBody.replace(/[\\\]]/g, "\\$&");
      source += `[${classBody}]`;
      index = close;
      continue;
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`).test(`refs/heads/${branch}`);
}

async function loadApplicableRulesetChecks({ apiUrl, repository, branch, token, fetchImpl = fetch }) {
  const listed = [];
  const pageSize = 100;
  const maxPages = 10;
  for (let page = 1; page <= maxPages; page += 1) {
    const pageItems = await requestJson({
      apiUrl,
      path: `/repos/${repository}/rulesets?includes_parents=true&per_page=${pageSize}&page=${page}`,
      token,
      fetchImpl
    });
    if (!Array.isArray(pageItems)) throw new Error("Release policy receipt ruleset query returned an invalid payload");
    listed.push(...pageItems);
    if (pageItems.length < pageSize) break;
    if (page === maxPages) throw new Error(`Release policy receipt ruleset query exceeded its bounded ${maxPages}-page limit`);
  }
  const checks = [];
  let defaultBranch = null;
  const resolveDefaultBranch = async () => {
    if (defaultBranch !== null) return defaultBranch;
    const repositoryPayload = await requestJson({
      apiUrl,
      path: `/repos/${repository}`,
      token,
      fetchImpl
    });
    if (typeof repositoryPayload?.default_branch !== "string" || !repositoryPayload.default_branch) {
      throw new Error("Release policy receipt cannot resolve the repository default branch for ruleset evaluation");
    }
    defaultBranch = repositoryPayload.default_branch;
    return defaultBranch;
  };
  for (const summary of listed.filter((item) => item?.enforcement === "active")) {
    const rulesetId = Number(summary?.id);
    if (!Number.isInteger(rulesetId) || rulesetId <= 0) {
      throw new Error("Release policy receipt ruleset listing contains an incomplete identity");
    }
    const detail = await requestJson({
      apiUrl,
      path: `/repos/${repository}/rulesets/${rulesetId}`,
      token,
      fetchImpl
    });
    const includes = detail?.conditions?.ref_name?.include;
    const excludes = detail?.conditions?.ref_name?.exclude ?? [];
    if (detail?.target === "branch" && !Array.isArray(includes)) {
      throw new Error("Release policy receipt ruleset has no complete ref-name condition");
    }
    if (detail?.target === "branch" && !Array.isArray(excludes)) {
      throw new Error("Release policy receipt ruleset has an invalid ref-name exclusion condition");
    }
    if (detail?.target !== "branch") continue;
    if (includes.length === 0) throw new Error("Release policy receipt ruleset has no complete ref-name condition");
    const patterns = [...includes, ...excludes];
    if (patterns.includes("~DEFAULT_BRANCH")) await resolveDefaultBranch();
    const appliesToTarget = includes.some((pattern) => rulesetRefPatternMatches(pattern, branch, defaultBranch)) &&
      !excludes.some((pattern) => rulesetRefPatternMatches(pattern, branch, defaultBranch));
    if (!appliesToTarget) continue;
    if (!Array.isArray(detail.rules)) throw new Error("Release policy receipt ruleset has no complete rule set");
    for (const rule of detail.rules.filter((item) => item?.type === "required_status_checks")) {
      const configured = rule.parameters?.required_status_checks;
      const strict = rule.parameters?.strict_required_status_checks_policy;
      if (!Array.isArray(configured) || typeof strict !== "boolean") {
        throw new Error("Release policy receipt ruleset has incomplete required status checks");
      }
      for (const check of configured) {
        const context = check?.context ?? check?.name;
        if (typeof context !== "string" || context.length === 0) {
          throw new Error("Release policy receipt ruleset has an incomplete required status check");
        }
        checks.push({ context, appId: check?.integration_id ?? null, strict });
      }
    }
  }
  return checks;
}

async function assertRepositoryAdministrationRead({ apiUrl, repository, branch, token, fetchImpl = fetch }) {
  const ruleSuites = await requestJson({
    apiUrl,
    path: `/repos/${repository}/rulesets/rule-suites?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=1&page=1`,
    token,
    fetchImpl
  });
  if (!Array.isArray(ruleSuites)) {
    throw new Error("Release policy receipt Administration-read probe returned an invalid payload");
  }
}

export async function loadRequiredCheckPolicy({ apiUrl, repository, branch, token, requireAdministration = false, fetchImpl = fetch }) {
  let branchProtection;
  let classicProtectionAbsent = false;
  try {
    branchProtection = await requestJson({
      apiUrl,
      path: `/repos/${repository}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
      token,
      fetchImpl
    });
  } catch (error) {
    if (error?.status !== 404 || requireAdministration !== true) throw error;
    // A branch lookup only proves that the target exists; it does not
    // distinguish absent classic protection from a permission-masked 404.
    await requestJson({
      apiUrl,
      path: `/repos/${repository}/branches/${encodeURIComponent(branch)}`,
      token,
      fetchImpl
    });
    classicProtectionAbsent = true;
  }
  const rulesetRequiredChecks = await loadApplicableRulesetChecks({ apiUrl, repository, branch, token, fetchImpl });
  if (classicProtectionAbsent) {
    // Listing repository rulesets only requires Metadata read and therefore
    // cannot authorize the 404 fallback. Listing rule suites requires
    // repository Administration read, so a successful response makes the
    // classic-protection absence authoritative for this credential.
    await assertRepositoryAdministrationRead({ apiUrl, repository, branch, token, fetchImpl });
    branchProtection = { strict: true, contexts: [], checks: [] };
  }
  return normalizeRequiredChecks(branchProtection, { rulesetRequiredChecks });
}

export async function prepareReleasePolicyReceipt({
  apiUrl,
  repository,
  branch,
  headSha,
  token,
  policyToken = token,
  targetUrl,
  receipt,
  fetchImpl = fetch
}) {
  if (!token || !policyToken || !repository || !branch) throw new Error("Release policy receipt requires provider and policy-reader credentials");
  const normalizedHead = assertSha(headSha);
  const policy = await loadRequiredCheckPolicy({ apiUrl, repository, branch, token: policyToken, requireAdministration: true, fetchImpl });
  const digest = policyDigest(policy);
  const artifact = receipt
    ? buildPolicyReceiptArtifact({
      ...receipt,
      repository,
      branch,
      headSha: normalizedHead,
      policy
    })
    : null;
  if (!artifact) throw new Error("Release policy receipt requires an immutable artifact before status publication");
  return { status: "prepared", branch, headSha: normalizedHead, policy, policyDigest: digest, context: RELEASE_POLICY_RECEIPT_CONTEXT, artifact, targetUrl };
}

function assertPreparedArtifact({ artifact, repository, branch, headSha, pullNumber, workflowRunId, workflowRunAttempt = null, eventAction, policy, eventName = RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT, triggerWorkflowRunId = null, closedMergeWorkflowRunId = null, closedMergeWorkflowRunAttempt = null }) {
  const expectedEventName = String(eventName ?? "").trim();
  const expectedTriggerRunId = String(triggerWorkflowRunId ?? "").trim();
  const expectedWorkflowFile = expectedEventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT
    ? RELEASE_POLICY_RECEIPT_RECONCILIATION_WORKFLOW_FILE
    : RELEASE_POLICY_RECEIPT_WORKFLOW_FILE;
  if (!artifact || artifact.schemaVersion !== 1 || artifact.kind !== RELEASE_POLICY_RECEIPT_ARTIFACT_KIND ||
      artifact.eventName !== expectedEventName || artifact.workflowFile !== expectedWorkflowFile ||
      artifact.repository !== repository || artifact.branch !== branch || artifact.headSha !== headSha ||
      Number(artifact.pullNumber) !== Number(pullNumber) || String(artifact.workflowRunId) !== String(workflowRunId) ||
      (workflowRunAttempt !== null && String(artifact.workflowRunAttempt) !== String(workflowRunAttempt)) ||
      artifact.eventAction !== eventAction || JSON.stringify(artifact.policy) !== JSON.stringify(policy) ||
      artifact.policyDigest !== policyDigest(policy) ||
      (expectedEventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT
        ? String(artifact.triggerWorkflowRunId ?? "") !== expectedTriggerRunId ||
          String(artifact.closedMergeWorkflowRunId ?? "") !== String(closedMergeWorkflowRunId ?? "") ||
          String(artifact.closedMergeWorkflowRunAttempt ?? "") !== String(closedMergeWorkflowRunAttempt ?? "")
        : artifact.triggerWorkflowRunId !== undefined)) {
    throw new Error("Release policy receipt artifact is not bound to the current workflow and required-check policy");
  }
}

export async function publishReleasePolicyReceipt({
  apiUrl,
  repository,
  branch,
  headSha,
  token,
  policyToken = token,
  targetUrl,
  artifact,
  pullNumber,
  workflowRunId,
  workflowRunAttempt = null,
  eventAction,
  eventName = RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT,
  triggerWorkflowRunId = null,
  closedMergeWorkflowRunId = null,
  closedMergeWorkflowRunAttempt = null,
  fetchImpl = fetch
}) {
  if (!token || !policyToken || !repository || !branch) throw new Error("Release policy receipt requires provider and policy-reader credentials");
  const normalizedHead = assertSha(headSha);
  const policy = await loadRequiredCheckPolicy({ apiUrl, repository, branch, token: policyToken, requireAdministration: true, fetchImpl });
  assertPreparedArtifact({ artifact, repository, branch, headSha: normalizedHead, pullNumber, workflowRunId, workflowRunAttempt, eventAction, policy, eventName, triggerWorkflowRunId, closedMergeWorkflowRunId, closedMergeWorkflowRunAttempt });
  const digest = policyDigest(policy);
  const status = buildPolicyStatus({ headSha: normalizedHead, digest, targetUrl });
  await requestJson({
    apiUrl,
    path: `/repos/${repository}/statuses/${normalizedHead}`,
    token,
    fetchImpl,
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: status.state,
        context: status.context,
        description: status.description,
        target_url: status.target_url
      })
    }
  });
  return { status: "published", branch, headSha: normalizedHead, policy, policyDigest: digest, context: status.context, artifact };
}

async function main() {
  const phase = String(process.env.RELEASE_POLICY_RECEIPT_PHASE ?? "").trim();
  if (phase !== "prepare" && phase !== "publish" && phase !== "close-binding") {
    throw new Error("Release policy receipt requires RELEASE_POLICY_RECEIPT_PHASE=prepare, publish, or close-binding");
  }
  const eventName = String(process.env.GITHUB_EVENT_NAME ?? "");
  const repository = String(process.env.GITHUB_REPOSITORY ?? "");
  const apiUrl = String(process.env.GITHUB_API_URL ?? "https://api.github.com");
  const token = String(process.env.GITHUB_TOKEN ?? "");
  const policyToken = String(process.env.RELEASE_POLICY_ADMIN_TOKEN ?? "").trim();
  const runId = String(process.env.GITHUB_RUN_ID ?? "").trim();
  const runAttempt = String(process.env.GITHUB_RUN_ATTEMPT ?? "").trim();
  try {
    canonicalWorkflowRunId(runAttempt, "workflow run attempt");
  } catch {
    throw new Error("Release policy receipt requires a trusted workflow run attempt");
  }
  if (!process.env.GITHUB_SERVER_URL || !repository || !runId) throw new Error("Release policy receipt requires a trusted workflow run URL");
  if ((phase === "prepare" || phase === "publish") && !policyToken) {
    throw new Error("Release policy receipt requires RELEASE_POLICY_ADMIN_TOKEN with repository Administration read permission");
  }
  let eventAction = String(process.env.GITHUB_EVENT_ACTION ?? "");
  let branch;
  let headSha;
  let headRef = null;
  let pullNumber;
  let mergeCommitSha = null;
  let mergedAt = null;
  let triggerWorkflowRunId = null;
  let closedMergeWorkflowRunId = null;
  let closedMergeWorkflowRunAttempt = null;
  if (eventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT) {
    const eventPath = String(process.env.GITHUB_EVENT_PATH ?? "").trim();
    if (!eventPath) throw new Error("Workflow-run release policy reconciliation requires GITHUB_EVENT_PATH");
    const eventPayload = JSON.parse(await readFile(eventPath, "utf8"));
    const binding = await resolveWorkflowRunReconciliationEvent({
      payload: eventPayload,
      apiUrl,
      repository,
      token
    });
    triggerWorkflowRunId = binding.triggerWorkflowRunId;
    pullNumber = binding.pullNumber;
    branch = binding.branch;
    headSha = binding.headSha;
    const pull = await requestJson({
      apiUrl,
      path: `/repos/${repository}/pulls/${pullNumber}`,
      token
    });
    if (Number(pull?.number) !== pullNumber || pull?.state !== "closed" || pull?.merged !== true ||
        String(pull?.base?.ref ?? "") !== branch || String(pull?.head?.sha ?? "").toLowerCase() !== headSha) {
      console.log(JSON.stringify({ status: "skipped", reason: "pull-request-not-merged" }));
      return;
    }
    mergeCommitSha = assertSha(pull.merge_commit_sha);
    mergedAt = String(pull.merged_at ?? "");
    if (!Number.isFinite(Date.parse(mergedAt))) throw new Error("Workflow-run release policy reconciliation requires a valid merge timestamp");
    headRef = typeof pull?.head?.ref === "string" ? pull.head.ref : "";
    if (!isValidPullRequestHeadRef(headRef)) {
      throw new Error("Workflow-run release policy reconciliation requires an exact source branch");
    }
    let closeBinding;
    try {
      const closedMerge = await findClosedMergeWorkflowRun({
        apiUrl,
        repository,
        branch,
        pullNumber,
        headSha,
        headRef,
        mergeCommitSha,
        mergedAt,
        token
      });
      assertExactReconciliationTrigger({
        triggerWorkflowRunId,
        closedMergeRunId: closedMerge.run?.id
      });
      closeBinding = closedMerge.binding;
      closedMergeWorkflowRunId = canonicalWorkflowRunId(closedMerge.run?.id, "reconciliation closed-merge run");
      closedMergeWorkflowRunAttempt = canonicalWorkflowRunId(closedMerge.run?.run_attempt, "reconciliation closed-merge run attempt");
      if (String(closeBinding?.workflowRunId) !== closedMergeWorkflowRunId ||
          String(closeBinding?.workflowRunAttempt) !== closedMergeWorkflowRunAttempt) {
        throw new Error("Workflow-run release policy reconciliation closed-merge binding does not match its verified run");
      }
    } catch (error) {
      if (error instanceof MissingPolicyCloseBindingArtifactError) {
        console.log(JSON.stringify({ status: "skipped", reason: "no-closed-merge-binding" }));
        return;
      }
      throw error;
    }
    eventAction = RELEASE_POLICY_RECEIPT_MERGE_ACTION;
  } else if (eventName === RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT) {
    const merged = String(process.env.GITHUB_PR_MERGED ?? "") === "true";
    if (!RELEASE_POLICY_RECEIPT_PREMERGE_ACTIONS.includes(eventAction) && !(eventAction === RELEASE_POLICY_RECEIPT_MERGE_ACTION && merged)) {
      if (eventAction === RELEASE_POLICY_RECEIPT_MERGE_ACTION && !merged) {
        console.log(JSON.stringify({ status: "skipped", reason: "pull-request-not-merged" }));
        return;
      }
      throw new Error("Release policy receipt must run only for an unmerged pre-merge event or a merged closed event");
    }
    branch = String(process.env.GITHUB_BASE_REF ?? "");
    headSha = assertSha(process.env.GITHUB_HEAD_SHA);
    headRef = String(process.env.GITHUB_HEAD_REF ?? "");
    if (!isValidPullRequestHeadRef(headRef)) {
      throw new Error("Release policy receipt requires an exact source branch");
    }
    pullNumber = Number(process.env.GITHUB_PR_NUMBER);
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) throw new Error("Release policy receipt requires a positive pull-request number");
    if (eventAction === RELEASE_POLICY_RECEIPT_MERGE_ACTION) {
      mergeCommitSha = assertSha(process.env.GITHUB_MERGE_COMMIT_SHA);
      mergedAt = String(process.env.GITHUB_PR_MERGED_AT ?? "");
    }
  } else {
    throw new Error(`Release policy receipt must run from the trusted ${RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT} or ${RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT} event`);
  }
  const observedAt = new Date().toISOString();
  if (phase === "close-binding") {
    if (eventName !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT || eventAction !== RELEASE_POLICY_RECEIPT_MERGE_ACTION ||
        !mergeCommitSha || !mergedAt) {
      throw new Error("Release policy close binding requires a merged pull-request-target event");
    }
    const artifactPath = String(process.env.RELEASE_POLICY_RECEIPT_FILE ?? "").trim();
    if (!artifactPath) throw new Error("Release policy close binding requires an immutable artifact output path");
    const binding = buildClosedPolicyReceiptBinding({
      repository,
      branch,
      headSha,
      pullNumber,
      workflowRunId: runId,
      workflowRunAttempt: runAttempt,
      observedAt,
      mergeCommitSha,
      mergedAt
    });
    await writeFile(artifactPath, `${JSON.stringify(binding)}\n`, { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ status: "prepared-close-binding", artifact: binding }));
    return;
  }
  const targetUrl = new URL(`${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${encodeURIComponent(runId)}`);
  targetUrl.searchParams.set("phase", eventAction === RELEASE_POLICY_RECEIPT_MERGE_ACTION ? "merge-bound" : "pre-merge");
  targetUrl.searchParams.set("attempt", runAttempt);
  targetUrl.searchParams.set("pr", String(pullNumber));
  targetUrl.searchParams.set("head", headSha);
  targetUrl.searchParams.set("base", branch);
  if (eventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT) targetUrl.searchParams.set("trigger", triggerWorkflowRunId);
  if (eventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT) {
    targetUrl.searchParams.set("closed", closedMergeWorkflowRunId);
    targetUrl.searchParams.set("closedAttempt", closedMergeWorkflowRunAttempt);
  }
  let receipt = {
    pullNumber,
    workflowRunId: runId,
    workflowRunAttempt: runAttempt,
    eventAction,
    observedAt,
    eventName,
    triggerWorkflowRunId,
    closedMergeWorkflowRunId,
    closedMergeWorkflowRunAttempt
  };
  if (eventAction === RELEASE_POLICY_RECEIPT_MERGE_ACTION) {
    const source = await waitForSourcePolicyReceipt({
      apiUrl,
      repository,
      branch,
      headSha,
      headRef,
      pullNumber,
      mergedAt,
      token,
      requireWorkflowRunAttempt: true
    });
    if (!source) throw new Error("Merge-bound release policy receipt requires one exact pre-merge policy status");
    targetUrl.searchParams.set("merge", mergeCommitSha);
    targetUrl.searchParams.set("source", source.workflowRunId);
    if (source.workflowRunAttempt !== null) targetUrl.searchParams.set("sourceAttempt", source.workflowRunAttempt);
    receipt = {
      ...receipt,
      mergeCommitSha,
      mergedAt,
      sourceWorkflowRunId: source.workflowRunId,
      sourceWorkflowRunAttempt: source.workflowRunAttempt,
      sourcePolicyDigest: source.policyDigest,
      sourcePolicyArtifactDigest: source.policyArtifactDigest
    };
  }
  const artifactPath = String(process.env.RELEASE_POLICY_RECEIPT_FILE ?? "").trim();
  if (!artifactPath) throw new Error("Release policy receipt requires an immutable artifact output path");
  if (phase === "prepare") {
    const prepared = await prepareReleasePolicyReceipt({
      apiUrl,
      repository,
      branch,
      headSha,
      token,
      policyToken,
      targetUrl: targetUrl.toString(),
      receipt
    });
    await writeFile(artifactPath, `${JSON.stringify(prepared.artifact)}\n`, { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify(prepared));
    return;
  }
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  if (eventAction === RELEASE_POLICY_RECEIPT_MERGE_ACTION &&
      (artifact.sourceWorkflowRunId !== receipt.sourceWorkflowRunId || artifact.sourcePolicyDigest !== receipt.sourcePolicyDigest ||
       artifact.sourcePolicyArtifactDigest !== receipt.sourcePolicyArtifactDigest ||
       (eventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT &&
        (artifact.closedMergeWorkflowRunId !== receipt.closedMergeWorkflowRunId ||
         artifact.closedMergeWorkflowRunAttempt !== receipt.closedMergeWorkflowRunAttempt)))) {
    throw new Error("Merge-bound release policy receipt artifact does not match the current pre-merge source");
  }
  const result = await publishReleasePolicyReceipt({
    apiUrl,
    repository,
    branch,
    headSha,
    token,
    policyToken,
    targetUrl: targetUrl.toString(),
    artifact,
    pullNumber,
    workflowRunId: runId,
    workflowRunAttempt: runAttempt,
    eventAction,
    eventName,
    triggerWorkflowRunId,
    closedMergeWorkflowRunId,
    closedMergeWorkflowRunAttempt
  });
  console.log(JSON.stringify(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
