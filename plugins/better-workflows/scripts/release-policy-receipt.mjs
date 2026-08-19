import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export const RELEASE_POLICY_RECEIPT_CONTEXT = "better-workflows/release-policy-v1";
export const RELEASE_POLICY_RECEIPT_PREFIX = "better-workflows-policy-v1:";
export const RELEASE_POLICY_RECEIPT_WORKFLOW_FILE = ".github/workflows/ci.yml";
export const RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT = "pull_request_target";
export const RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT = "workflow_run";
export const RELEASE_POLICY_RECEIPT_PUBLISHER = "github-actions[bot]";
export const RELEASE_POLICY_RECEIPT_ARTIFACT_NAME = "better-workflows-release-policy-receipt";
export const RELEASE_POLICY_RECEIPT_ARTIFACT_FILE = "release-policy-receipt.json";
export const RELEASE_POLICY_RECEIPT_ARTIFACT_KIND = "better-workflows/release-policy-receipt-v2";
export const RELEASE_POLICY_RECEIPT_PREMERGE_ACTIONS = ["opened", "reopened", "synchronize"];
export const RELEASE_POLICY_RECEIPT_MERGE_ACTION = "closed";
export const RELEASE_POLICY_RECEIPT_SOURCE_POLL_ATTEMPTS = 12;
export const RELEASE_POLICY_RECEIPT_SOURCE_POLL_DELAY_MS = 5_000;

function assertSha(value) {
  const sha = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Release policy receipt requires a commit SHA: ${sha || "<empty>"}`);
  return sha;
}

export function normalizeRequiredChecks(payload) {
  const protection = payload?.protection;
  const required = protection?.required_status_checks;
  if (payload?.protected !== true || !required || typeof required !== "object") {
    throw new Error("Release policy receipt requires a protected branch with required status checks");
  }
  if (!Array.isArray(required.contexts) && !Array.isArray(required.checks)) {
    throw new Error("Release policy receipt requires a resolvable required status check configuration");
  }
  if (typeof required.strict !== "boolean") {
    throw new Error("Release policy receipt requires the protected-branch strict setting");
  }
  const entries = [];
  for (const context of required.contexts ?? []) {
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
  const unique = new Map(entries.map((item) => [`${item.context}\u0000${item.appId ?? "*"}`, item]));
  const normalized = [...unique.values()].sort((left, right) => (
    `${left.context}:${left.appId ?? ""}`.localeCompare(`${right.context}:${right.appId ?? ""}`)
  ));
  if (normalized.length === 0) throw new Error("Release policy receipt cannot publish an empty required-check policy");
  return normalized;
}

export function policyDigest(requirements) {
  return createHash("sha256").update(JSON.stringify(requirements)).digest("hex");
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
  eventAction,
  observedAt,
  mergeCommitSha = null,
  mergedAt = null,
  sourceWorkflowRunId = null,
  sourcePolicyDigest = null,
  eventName = RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT,
  triggerWorkflowRunId = null
}) {
  const normalizedHead = assertSha(headSha);
  const normalizedPullNumber = Number(pullNumber);
  if (!Number.isInteger(normalizedPullNumber) || normalizedPullNumber <= 0) {
    throw new Error("Release policy receipt artifact requires a positive pull-request number");
  }
  const observedMs = Date.parse(String(observedAt ?? ""));
  if (!Number.isFinite(observedMs)) throw new Error("Release policy receipt artifact requires an observation timestamp");
  const runId = String(workflowRunId ?? "").trim();
  if (!/^\d+$/.test(runId)) throw new Error("Release policy receipt artifact requires a workflow run id");
  if (!repository || !branch || !eventAction) throw new Error("Release policy receipt artifact requires repository, branch, and event metadata");
  const normalizedEventName = String(eventName ?? "").trim();
  if (![RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT, RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT].includes(normalizedEventName)) {
    throw new Error("Release policy receipt artifact received an unsupported workflow event");
  }
  const normalizedTriggerRunId = String(triggerWorkflowRunId ?? "").trim();
  if (normalizedEventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT && !/^\d+$/.test(normalizedTriggerRunId)) {
    throw new Error("Workflow-run release policy receipt requires its triggering workflow run id");
  }
  if (normalizedEventName === RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT && normalizedTriggerRunId) {
    throw new Error("Pull-request release policy receipt cannot carry a workflow-run trigger binding");
  }
  const artifact = {
    schemaVersion: 1,
    kind: RELEASE_POLICY_RECEIPT_ARTIFACT_KIND,
    repository: String(repository),
    workflowFile: RELEASE_POLICY_RECEIPT_WORKFLOW_FILE,
    workflowRunId: runId,
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
  const sourceDigest = String(sourcePolicyDigest ?? "").trim().toLowerCase();
  if (!Number.isFinite(mergedMs) || !/^\d+$/.test(sourceRunId) || !/^[a-f0-9]{64}$/.test(sourceDigest)) {
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
    sourcePolicyDigest: sourceDigest,
    ...(normalizedEventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT
      ? { triggerWorkflowRunId: normalizedTriggerRunId }
      : {})
  };
}

export function parseWorkflowRunReconciliationEvent(payload) {
  if (payload?.action !== "completed") {
    throw new Error("Workflow-run release policy reconciliation requires a completed event");
  }
  const run = payload?.workflow_run;
  if (!run || typeof run !== "object" || Array.isArray(run) ||
      String(run.path ?? "") !== RELEASE_POLICY_RECEIPT_WORKFLOW_FILE ||
      String(run.event ?? "") !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT ||
      String(run.status ?? "") !== "completed" || String(run.conclusion ?? "") !== "success") {
    throw new Error("Workflow-run release policy reconciliation requires a successful pull-request-target source run");
  }
  const triggerWorkflowRunId = String(run.id ?? "").trim();
  if (!/^\d+$/.test(triggerWorkflowRunId)) throw new Error("Workflow-run release policy reconciliation requires a triggering workflow run id");
  const pullRequests = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  if (pullRequests.length !== 1) throw new Error("Workflow-run release policy reconciliation requires exactly one associated pull request");
  const pull = pullRequests[0];
  const pullNumber = Number(pull?.number);
  const branch = String(pull?.base?.ref ?? "").trim();
  const headSha = assertSha(pull?.head?.sha);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0 || !branch) {
    throw new Error("Workflow-run release policy reconciliation requires a complete pull-request binding");
  }
  return { triggerWorkflowRunId, pullNumber, branch, headSha };
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
  if (!response.ok) throw new Error(`Release policy receipt GitHub request failed with HTTP ${response.status}`);
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

function sourcePolicyReceipt(status, { repository, branch, headSha, pullNumber, mergedAtMs = null }) {
  if (status?.state !== "success" || status?.context !== RELEASE_POLICY_RECEIPT_CONTEXT) return null;
  let targetUrl;
  try {
    targetUrl = new URL(String(status.target_url ?? ""));
  } catch {
    return null;
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
    !runMatch?.[1] ||
    !/^[a-f0-9]{64}$/.test(digest)
  ) return null;
  const updatedAt = Date.parse(String(status.updated_at ?? status.created_at ?? ""));
  if (!Number.isFinite(updatedAt) || (mergedAtMs !== null && updatedAt > mergedAtMs)) return null;
  return { status, workflowRunId: runMatch[1], policyDigest: digest, updatedAt };
}

function waitForReceiptSource(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function waitForSourcePolicyReceipt({
  apiUrl,
  repository,
  branch,
  headSha,
  pullNumber,
  token,
  fetchImpl = fetch,
  sleepImpl = waitForReceiptSource,
  attempts = RELEASE_POLICY_RECEIPT_SOURCE_POLL_ATTEMPTS,
  delayMs = RELEASE_POLICY_RECEIPT_SOURCE_POLL_DELAY_MS,
  mergedAt = null
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
    const source = statuses
      .map((status) => sourcePolicyReceipt(status, { repository, branch, headSha, pullNumber, mergedAtMs }))
      .filter(Boolean)
      .sort((left, right) => right.updatedAt - left.updatedAt || String(right.status.id ?? "").localeCompare(String(left.status.id ?? "")))[0];
    if (source) return source;
    if (attempt < attempts - 1) await sleepImpl(delayMs);
  }
  return null;
}

async function loadRequiredCheckPolicy({ apiUrl, repository, branch, token, fetchImpl = fetch }) {
  return normalizeRequiredChecks(await requestJson({
    apiUrl,
    path: `/repos/${repository}/branches/${encodeURIComponent(branch)}`,
    token,
    fetchImpl
  }));
}

export async function prepareReleasePolicyReceipt({
  apiUrl,
  repository,
  branch,
  headSha,
  token,
  targetUrl,
  receipt,
  fetchImpl = fetch
}) {
  if (!token || !repository || !branch) throw new Error("Release policy receipt requires repository, branch, and token");
  const normalizedHead = assertSha(headSha);
  const policy = await loadRequiredCheckPolicy({ apiUrl, repository, branch, token, fetchImpl });
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

function assertPreparedArtifact({ artifact, repository, branch, headSha, pullNumber, workflowRunId, eventAction, policy, eventName = RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT, triggerWorkflowRunId = null }) {
  const expectedEventName = String(eventName ?? "").trim();
  const expectedTriggerRunId = String(triggerWorkflowRunId ?? "").trim();
  if (!artifact || artifact.schemaVersion !== 1 || artifact.kind !== RELEASE_POLICY_RECEIPT_ARTIFACT_KIND ||
      artifact.eventName !== expectedEventName || artifact.workflowFile !== RELEASE_POLICY_RECEIPT_WORKFLOW_FILE ||
      artifact.repository !== repository || artifact.branch !== branch || artifact.headSha !== headSha ||
      Number(artifact.pullNumber) !== Number(pullNumber) || String(artifact.workflowRunId) !== String(workflowRunId) ||
      artifact.eventAction !== eventAction || JSON.stringify(artifact.policy) !== JSON.stringify(policy) ||
      artifact.policyDigest !== policyDigest(policy) ||
      (expectedEventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT
        ? String(artifact.triggerWorkflowRunId ?? "") !== expectedTriggerRunId
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
  targetUrl,
  artifact,
  pullNumber,
  workflowRunId,
  eventAction,
  eventName = RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT,
  triggerWorkflowRunId = null,
  fetchImpl = fetch
}) {
  if (!token || !repository || !branch) throw new Error("Release policy receipt requires repository, branch, and token");
  const normalizedHead = assertSha(headSha);
  const policy = await loadRequiredCheckPolicy({ apiUrl, repository, branch, token, fetchImpl });
  assertPreparedArtifact({ artifact, repository, branch, headSha: normalizedHead, pullNumber, workflowRunId, eventAction, policy, eventName, triggerWorkflowRunId });
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
  if (phase !== "prepare" && phase !== "publish") {
    throw new Error("Release policy receipt requires RELEASE_POLICY_RECEIPT_PHASE=prepare or publish");
  }
  const eventName = String(process.env.GITHUB_EVENT_NAME ?? "");
  const repository = String(process.env.GITHUB_REPOSITORY ?? "");
  const apiUrl = String(process.env.GITHUB_API_URL ?? "https://api.github.com");
  const token = String(process.env.GITHUB_TOKEN ?? "");
  const runId = String(process.env.GITHUB_RUN_ID ?? "").trim();
  if (!process.env.GITHUB_SERVER_URL || !repository || !runId) throw new Error("Release policy receipt requires a trusted workflow run URL");
  let eventAction = String(process.env.GITHUB_EVENT_ACTION ?? "");
  let branch;
  let headSha;
  let pullNumber;
  let mergeCommitSha = null;
  let mergedAt = null;
  let triggerWorkflowRunId = null;
  if (eventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT) {
    const eventPath = String(process.env.GITHUB_EVENT_PATH ?? "").trim();
    if (!eventPath) throw new Error("Workflow-run release policy reconciliation requires GITHUB_EVENT_PATH");
    const eventPayload = JSON.parse(await readFile(eventPath, "utf8"));
    const binding = parseWorkflowRunReconciliationEvent(eventPayload);
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
  const targetUrl = new URL(`${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${encodeURIComponent(runId)}`);
  targetUrl.searchParams.set("phase", eventAction === RELEASE_POLICY_RECEIPT_MERGE_ACTION ? "merge-bound" : "pre-merge");
  targetUrl.searchParams.set("pr", String(pullNumber));
  targetUrl.searchParams.set("head", headSha);
  targetUrl.searchParams.set("base", branch);
  if (eventName === RELEASE_POLICY_RECEIPT_RECONCILIATION_EVENT) targetUrl.searchParams.set("trigger", triggerWorkflowRunId);
  let receipt = { pullNumber, workflowRunId: runId, eventAction, observedAt, eventName, triggerWorkflowRunId };
  if (eventAction === RELEASE_POLICY_RECEIPT_MERGE_ACTION) {
    const source = await waitForSourcePolicyReceipt({
      apiUrl,
      repository,
      branch,
      headSha,
      pullNumber,
      mergedAt,
      token
    });
    if (!source) throw new Error("Merge-bound release policy receipt requires one exact pre-merge policy status");
    targetUrl.searchParams.set("merge", mergeCommitSha);
    targetUrl.searchParams.set("source", source.workflowRunId);
    receipt = {
      ...receipt,
      mergeCommitSha,
      mergedAt,
      sourceWorkflowRunId: source.workflowRunId,
      sourcePolicyDigest: source.policyDigest
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
      targetUrl: targetUrl.toString(),
      receipt
    });
    await writeFile(artifactPath, `${JSON.stringify(prepared.artifact)}\n`, { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify(prepared));
    return;
  }
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  if (eventAction === RELEASE_POLICY_RECEIPT_MERGE_ACTION &&
      (artifact.sourceWorkflowRunId !== receipt.sourceWorkflowRunId || artifact.sourcePolicyDigest !== receipt.sourcePolicyDigest)) {
    throw new Error("Merge-bound release policy receipt artifact does not match the current pre-merge source");
  }
  const result = await publishReleasePolicyReceipt({
    apiUrl,
    repository,
    branch,
    headSha,
    token,
    targetUrl: targetUrl.toString(),
    artifact,
    pullNumber,
    workflowRunId: runId,
    eventAction,
    eventName,
    triggerWorkflowRunId
  });
  console.log(JSON.stringify(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
