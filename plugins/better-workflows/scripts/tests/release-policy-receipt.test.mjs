import test from "node:test";
import assert from "node:assert/strict";
import {
  RELEASE_POLICY_RECEIPT_CONTEXT,
  RELEASE_POLICY_RECEIPT_PREFIX,
  RELEASE_POLICY_RECEIPT_ARTIFACT_KIND,
  buildPolicyReceiptArtifact,
  buildPolicyStatus,
  normalizeRequiredChecks,
  policyDigest,
  publishReleasePolicyReceipt
} from "../release-policy-receipt.mjs";

test("release policy receipt normalizes and digests the protected-branch policy", () => {
  const policy = normalizeRequiredChecks({
    protected: true,
    protection: {
      required_status_checks: {
        contexts: ["lint"],
        checks: [{ context: "test", app_id: 123 }]
      }
    }
  });
  assert.deepEqual(policy, [
    { context: "lint", appId: null },
    { context: "test", appId: 123 }
  ]);
  assert.match(policyDigest(policy), /^[a-f0-9]{64}$/);
  assert.throws(
    () => normalizeRequiredChecks({ protected: true, protection: { required_status_checks: { contexts: [], checks: [] } } }),
    /cannot publish an empty required-check policy/
  );
});

test("release policy receipt publishes one exact status bound to the policy digest", async () => {
  const headSha = "a".repeat(40);
  const policyResponse = {
    protected: true,
    protection: { required_status_checks: { contexts: ["test"], checks: [] } }
  };
  const calls = [];
  const result = await publishReleasePolicyReceipt({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    branch: "dev",
    headSha,
    token: "token",
    targetUrl: "https://github.com/example/repo/commit/a/checks",
    receipt: {
      pullNumber: 17,
      workflowRunId: "42",
      eventAction: "synchronize",
      observedAt: "2026-08-18T00:00:00Z"
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/branches/dev")) return { ok: true, status: 200, json: async () => policyResponse };
      assert.equal(url, `https://api.github.com/repos/example/repo/statuses/${headSha}`);
      assert.equal(options.method, "POST");
      return { ok: true, status: 201, json: async () => ({}) };
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(result.status, "published");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.state, "success");
  assert.equal(body.context, RELEASE_POLICY_RECEIPT_CONTEXT);
  assert.equal(body.description, `${RELEASE_POLICY_RECEIPT_PREFIX}${result.policyDigest}`);
  assert.equal(buildPolicyStatus({ headSha, digest: result.policyDigest }).sha, headSha);
  assert.equal(result.artifact.kind, RELEASE_POLICY_RECEIPT_ARTIFACT_KIND);
  assert.equal(result.artifact.workflowRunId, "42");
  assert.equal(result.artifact.pullNumber, 17);
  assert.equal(result.artifact.policyDigest, result.policyDigest);
});

test("policy receipt artifact deterministically binds its pre-merge identity and policy", () => {
  const artifact = buildPolicyReceiptArtifact({
    repository: "example/repo",
    branch: "dev",
    headSha: "b".repeat(40),
    pullNumber: 17,
    policy: [{ context: "test", appId: null }],
    workflowRunId: "42",
    eventAction: "opened",
    observedAt: "2026-08-18T00:00:00Z"
  });
  assert.equal(artifact.eventName, "pull_request_target");
  assert.equal(artifact.workflowFile, ".github/workflows/ci.yml");
  assert.equal(artifact.policyDigest, policyDigest(artifact.policy));
});
