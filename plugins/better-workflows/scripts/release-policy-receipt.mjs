import { createHash } from "node:crypto";

export const RELEASE_POLICY_RECEIPT_CONTEXT = "better-workflows/release-policy-v1";
export const RELEASE_POLICY_RECEIPT_PREFIX = "better-workflows-policy-v1:";

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
  return { status: "published", branch, headSha: normalizedHead, policy, policyDigest: digest, context: status.context };
}

async function main() {
  const eventName = String(process.env.GITHUB_EVENT_NAME ?? "");
  const branch = eventName === "pull_request"
    ? String(process.env.GITHUB_BASE_REF ?? "")
    : String(process.env.GITHUB_REF_NAME ?? "");
  const headSha = eventName === "pull_request"
    ? String(process.env.GITHUB_HEAD_SHA ?? "")
    : String(process.env.GITHUB_SHA ?? "");
  const repository = String(process.env.GITHUB_REPOSITORY ?? "");
  const apiUrl = String(process.env.GITHUB_API_URL ?? "https://api.github.com");
  const token = String(process.env.GITHUB_TOKEN ?? "");
  const targetUrl = process.env.GITHUB_SERVER_URL && repository
    ? `${process.env.GITHUB_SERVER_URL}/${repository}/commit/${assertSha(headSha)}/checks`
    : undefined;
  console.log(JSON.stringify(await publishReleasePolicyReceipt({
    apiUrl,
    repository,
    branch,
    headSha,
    token,
    targetUrl
  })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
