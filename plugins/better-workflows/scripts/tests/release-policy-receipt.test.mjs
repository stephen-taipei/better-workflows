import test from "node:test";
import assert from "node:assert/strict";
import {
  RELEASE_POLICY_RECEIPT_CONTEXT,
  RELEASE_POLICY_RECEIPT_PREFIX,
  RELEASE_POLICY_RECEIPT_ARTIFACT_KIND,
  buildPolicyReceiptArtifact,
  buildPolicyStatus,
  normalizeRequiredChecks,
  parseWorkflowRunReconciliationEvent,
  prepareReleasePolicyReceipt,
  policyDigest,
  publishReleasePolicyReceipt,
  waitForSourcePolicyReceipt
} from "../release-policy-receipt.mjs";

test("release policy receipt normalizes and digests the protected-branch policy", () => {
  const policy = normalizeRequiredChecks({
    protected: true,
    protection: {
      required_status_checks: {
        contexts: ["lint"],
        checks: [{ context: "test", app_id: 123 }],
        strict: true
      }
    }
  });
  assert.deepEqual(policy, [
    { context: "lint", appId: null, strict: true },
    { context: "test", appId: 123, strict: true }
  ]);
  assert.match(policyDigest(policy), /^[a-f0-9]{64}$/);
  assert.throws(
    () => normalizeRequiredChecks({ protected: true, protection: { required_status_checks: { contexts: [], checks: [], strict: true } } }),
    /cannot publish an empty required-check policy/
  );
  assert.throws(
    () => normalizeRequiredChecks({ protected: true, protection: { required_status_checks: { contexts: ["test"], checks: [] } } }),
    /strict setting/
  );
});

test("release policy receipt publishes only after the prepared artifact is bound", async () => {
  const headSha = "a".repeat(40);
  const policyResponse = {
    protected: true,
    protection: { required_status_checks: { contexts: ["test"], checks: [], strict: true } }
  };
  const calls = [];
  const prepared = await prepareReleasePolicyReceipt({
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
  assert.equal(calls.length, 1);
  assert.equal(prepared.status, "prepared");
  const result = await publishReleasePolicyReceipt({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    branch: "dev",
    headSha,
    token: "token",
    targetUrl: "https://github.com/example/repo/commit/a/checks",
    artifact: prepared.artifact,
    pullNumber: 17,
    workflowRunId: "42",
    eventAction: "synchronize",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/branches/dev")) return { ok: true, status: 200, json: async () => policyResponse };
      assert.equal(url, `https://api.github.com/repos/example/repo/statuses/${headSha}`);
      assert.equal(options.method, "POST");
      return { ok: true, status: 201, json: async () => ({}) };
    }
  });
  assert.equal(calls.length, 3);
  assert.equal(result.status, "published");
  const body = JSON.parse(calls[2].options.body);
  assert.equal(body.state, "success");
  assert.equal(body.context, RELEASE_POLICY_RECEIPT_CONTEXT);
  assert.equal(body.description, `${RELEASE_POLICY_RECEIPT_PREFIX}${result.policyDigest}`);
  assert.equal(buildPolicyStatus({ headSha, digest: result.policyDigest }).sha, headSha);
  assert.equal(result.artifact.kind, RELEASE_POLICY_RECEIPT_ARTIFACT_KIND);
  assert.equal(result.artifact.workflowRunId, "42");
  assert.equal(result.artifact.pullNumber, 17);
  assert.equal(result.artifact.policyDigest, result.policyDigest);
  await assert.rejects(
    publishReleasePolicyReceipt({
      apiUrl: "https://api.github.com",
      repository: "example/repo",
      branch: "dev",
      headSha,
      token: "token",
      targetUrl: "https://github.com/example/repo/commit/a/checks",
      artifact: { ...prepared.artifact, policyDigest: "f".repeat(64) },
      pullNumber: 17,
      workflowRunId: "42",
      eventAction: "synchronize",
      fetchImpl: async (url) => url.endsWith("/branches/dev")
        ? { ok: true, status: 200, json: async () => policyResponse }
        : { ok: true, status: 201, json: async () => ({}) }
    }),
    /not bound to the current workflow/
  );
});

test("policy receipt artifact deterministically binds its pre-merge identity and policy", () => {
  const artifact = buildPolicyReceiptArtifact({
    repository: "example/repo",
    branch: "dev",
    headSha: "b".repeat(40),
    pullNumber: 17,
    policy: [{ context: "test", appId: null, strict: true }],
    workflowRunId: "42",
    eventAction: "opened",
    observedAt: "2026-08-18T00:00:00Z"
  });
  assert.equal(artifact.eventName, "pull_request_target");
  assert.equal(artifact.workflowFile, ".github/workflows/ci.yml");
  assert.equal(artifact.policyDigest, policyDigest(artifact.policy));
});

test("merge-bound policy receipt binds merge commit and unchanged pre-merge policy", () => {
  const mergeCommitSha = "c".repeat(40);
  const policy = [{ context: "test", appId: null, strict: true }];
  const artifact = buildPolicyReceiptArtifact({
    repository: "example/repo",
    branch: "dev",
    headSha: "b".repeat(40),
    pullNumber: 17,
    policy,
    workflowRunId: "43",
    eventAction: "closed",
    observedAt: "2026-08-18T00:05:00Z",
    mergeCommitSha,
    mergedAt: "2026-08-18T00:00:00Z",
    sourceWorkflowRunId: "42",
    sourcePolicyDigest: policyDigest(policy)
  });
  assert.equal(artifact.eventAction, "closed");
  assert.equal(artifact.mergeCommitSha, mergeCommitSha);
  assert.equal(artifact.sourceWorkflowRunId, "42");
  assert.throws(
    () => buildPolicyReceiptArtifact({
      ...artifact,
      policy: [{ context: "different", appId: null, strict: true }],
      sourcePolicyDigest: policyDigest(policy)
    }),
    /changed required-check policy/
  );
  assert.throws(
    () => buildPolicyReceiptArtifact({
      ...artifact,
      policy: [{ context: "test", appId: null, strict: false }],
      sourcePolicyDigest: policyDigest(policy)
    }),
    /changed required-check policy/
  );
});

test("workflow-run reconciliation artifacts bind the completed source run", () => {
  const policy = [{ context: "test", appId: null, strict: true }];
  const artifact = buildPolicyReceiptArtifact({
    repository: "example/repo",
    branch: "dev",
    headSha: "b".repeat(40),
    pullNumber: 17,
    policy,
    workflowRunId: "44",
    eventName: "workflow_run",
    triggerWorkflowRunId: "43",
    eventAction: "closed",
    observedAt: "2026-08-18T00:05:00Z",
    mergeCommitSha: "c".repeat(40),
    mergedAt: "2026-08-18T00:00:00Z",
    sourceWorkflowRunId: "42",
    sourcePolicyDigest: policyDigest(policy)
  });
  assert.equal(artifact.eventName, "workflow_run");
  assert.equal(artifact.triggerWorkflowRunId, "43");
  assert.throws(
    () => buildPolicyReceiptArtifact({ ...artifact, triggerWorkflowRunId: null }),
    /triggering workflow run id/
  );
});

test("workflow-run reconciliation requires one successful pull-request-target source", () => {
  const payload = {
    action: "completed",
    workflow_run: {
      id: 43,
      path: ".github/workflows/ci.yml",
      event: "pull_request_target",
      status: "completed",
      conclusion: "success",
      pull_requests: [{ number: 17, head: { sha: "b".repeat(40) }, base: { ref: "dev" } }]
    }
  };
  assert.deepEqual(parseWorkflowRunReconciliationEvent(payload), {
    triggerWorkflowRunId: "43",
    pullNumber: 17,
    branch: "dev",
    headSha: "b".repeat(40)
  });
  assert.throws(
    () => parseWorkflowRunReconciliationEvent({ ...payload, workflow_run: { ...payload.workflow_run, conclusion: "failure" } }),
    /successful pull-request-target source run/
  );
  assert.throws(
    () => parseWorkflowRunReconciliationEvent({ ...payload, workflow_run: { ...payload.workflow_run, pull_requests: [] } }),
    /exactly one associated pull request/
  );
});

test("closed receipt polling waits for the exact pre-merge status within a bounded window", async () => {
  const headSha = "d".repeat(40);
  const sourceStatus = {
    id: 42,
    state: "success",
    context: RELEASE_POLICY_RECEIPT_CONTEXT,
    target_url: `https://github.com/example/repo/actions/runs/42?phase=pre-merge&pr=17&head=${headSha}&base=dev`,
    description: `${RELEASE_POLICY_RECEIPT_PREFIX}${"e".repeat(64)}`,
    updated_at: "2026-08-18T00:00:02Z"
  };
  let queries = 0;
  const sleeps = [];
  const source = await waitForSourcePolicyReceipt({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    branch: "dev",
    headSha,
    pullNumber: 17,
    token: "token",
    attempts: 3,
    delayMs: 5_000,
    sleepImpl: async (delay) => sleeps.push(delay),
    fetchImpl: async (url) => {
      queries += 1;
      assert.equal(url, `https://api.github.com/repos/example/repo/commits/${headSha}/statuses?per_page=100&page=1`);
      return { ok: true, status: 200, json: async () => (queries === 1 ? [] : [sourceStatus]) };
    }
  });
  assert.equal(source.workflowRunId, "42");
  assert.equal(source.policyDigest, "e".repeat(64));
  assert.deepEqual(sleeps, [5_000]);
  assert.equal(queries, 2);
});

test("closed receipt polling ignores a newer pre-merge status published after merge", async () => {
  const headSha = "f".repeat(40);
  const status = (id, updatedAt, workflowRunId) => ({
    id,
    state: "success",
    context: RELEASE_POLICY_RECEIPT_CONTEXT,
    target_url: `https://github.com/example/repo/actions/runs/${workflowRunId}?phase=pre-merge&pr=17&head=${headSha}&base=dev`,
    description: `${RELEASE_POLICY_RECEIPT_PREFIX}${id === 42 ? "a".repeat(64) : "b".repeat(64)}`,
    updated_at: updatedAt
  });
  const source = await waitForSourcePolicyReceipt({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    branch: "dev",
    headSha,
    pullNumber: 17,
    mergedAt: "2026-08-18T00:00:00Z",
    token: "token",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => [
        status(42, "2026-08-17T23:59:59Z", 42),
        status(43, "2026-08-18T00:00:02Z", 43)
      ]
    })
  });
  assert.equal(source.workflowRunId, "42");
  assert.equal(source.policyDigest, "a".repeat(64));
});
