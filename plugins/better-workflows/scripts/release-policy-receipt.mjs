import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

export const RELEASE_POLICY_RECEIPT_CONTEXT = "better-workflows/release-policy-v1";
export const RELEASE_POLICY_RECEIPT_PREFIX = "better-workflows-policy-v1:";
export const RELEASE_POLICY_RECEIPT_WORKFLOW_FILE = ".github/workflows/ci.yml";
export const RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT = "pull_request_target";
export const RELEASE_POLICY_RECEIPT_PUBLISHER = "github-actions[bot]";
export const RELEASE_POLICY_RECEIPT_ARTIFACT_NAME = "better-workflows-release-policy-receipt";
export const RELEASE_POLICY_RECEIPT_ARTIFACT_FILE = "release-policy-receipt.json";
export const RELEASE_POLICY_RECEIPT_ARTIFACT_KIND = "better-workflows/release-policy-receipt-v2";

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
  const entries = [];
  for (const context of required.contexts ?? []) {
    if (typeof context !== "string" || context.length === 0) throw new Error("Release policy receipt received an invalid required status context");
    entries.push({ context, appId: null });
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
    entries.push({ context: check.context, appId });
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
  observedAt
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
  return {
    schemaVersion: 1,
    kind: RELEASE_POLICY_RECEIPT_ARTIFACT_KIND,
    repository: String(repository),
    workflowFile: RELEASE_POLICY_RECEIPT_WORKFLOW_FILE,
    workflowRunId: runId,
    eventName: RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT,
    eventAction: String(eventAction),
    branch: String(branch),
    pullNumber: normalizedPullNumber,
    headSha: normalizedHead,
    policy,
    policyDigest: policyDigest(policy),
    observedAt: new Date(observedMs).toISOString()
  };
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

export async function publishReleasePolicyReceipt({
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
  const policy = normalizeRequiredChecks(await requestJson({
    apiUrl,
    path: `/repos/${repository}/branches/${encodeURIComponent(branch)}`,
    token,
    fetchImpl
  }));
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
  const artifact = receipt
    ? buildPolicyReceiptArtifact({
      ...receipt,
      repository,
      branch,
      headSha: normalizedHead,
      policy
    })
    : null;
  return { status: "published", branch, headSha: normalizedHead, policy, policyDigest: digest, context: status.context, artifact };
}

async function main() {
  const eventName = String(process.env.GITHUB_EVENT_NAME ?? "");
  if (eventName !== RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT) {
    throw new Error(`Release policy receipt must run from the trusted ${RELEASE_POLICY_RECEIPT_WORKFLOW_EVENT} event`);
  }
  const eventAction = String(process.env.GITHUB_EVENT_ACTION ?? "");
  if (!["opened", "reopened", "synchronize"].includes(eventAction) || String(process.env.GITHUB_PR_MERGED ?? "") === "true") {
    throw new Error("Release policy receipt must run only for an unmerged pull-request pre-merge event");
  }
  const branch = String(process.env.GITHUB_BASE_REF ?? "");
  const headSha = assertSha(process.env.GITHUB_HEAD_SHA);
  const pullNumber = Number(process.env.GITHUB_PR_NUMBER);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) throw new Error("Release policy receipt requires a positive pull-request number");
  const repository = String(process.env.GITHUB_REPOSITORY ?? "");
  const apiUrl = String(process.env.GITHUB_API_URL ?? "https://api.github.com");
  const token = String(process.env.GITHUB_TOKEN ?? "");
  const runId = String(process.env.GITHUB_RUN_ID ?? "").trim();
  if (!process.env.GITHUB_SERVER_URL || !repository || !runId) throw new Error("Release policy receipt requires a trusted workflow run URL");
  const observedAt = new Date().toISOString();
  const targetUrl = new URL(`${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${encodeURIComponent(runId)}`);
  targetUrl.searchParams.set("phase", "pre-merge");
  targetUrl.searchParams.set("pr", String(pullNumber));
  targetUrl.searchParams.set("head", headSha);
  targetUrl.searchParams.set("base", branch);
  const result = await publishReleasePolicyReceipt({
    apiUrl,
    repository,
    branch,
    headSha,
    token,
    targetUrl: targetUrl.toString(),
    receipt: { pullNumber, workflowRunId: runId, eventAction, observedAt }
  });
  const artifactPath = String(process.env.RELEASE_POLICY_RECEIPT_FILE ?? "").trim();
  if (!artifactPath || !result.artifact) throw new Error("Release policy receipt requires an immutable artifact output path");
  await writeFile(artifactPath, `${JSON.stringify(result.artifact)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
