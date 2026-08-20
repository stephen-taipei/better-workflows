import test from "node:test";
import assert from "node:assert/strict";
import {
  RELEASE_POLICY_RECEIPT_CONTEXT,
  RELEASE_POLICY_RECEIPT_PREFIX,
  RELEASE_POLICY_RECEIPT_ARTIFACT_KIND,
  RELEASE_POLICY_CLOSE_BINDING_ARTIFACT_KIND,
  assertClosedPolicyReceiptBinding,
  buildPolicyReceiptArtifact,
  buildClosedPolicyReceiptBinding,
  buildPolicyStatus,
  loadRequiredCheckPolicy,
  normalizeRequiredChecks,
  parseWorkflowRunReconciliationEvent,
  prepareReleasePolicyReceipt,
  policyDigest,
  publishReleasePolicyReceipt,
  waitForSourcePolicyReceipt
} from "../release-policy-receipt.mjs";

test("release policy receipt normalizes and digests the protected-branch policy", () => {
  const directPolicy = normalizeRequiredChecks({
    strict: true,
    contexts: ["test"],
    checks: [{ context: "test", app_id: 15368 }]
  });
  assert.deepEqual(directPolicy, [{ context: "test", appId: 15368, strict: true }]);
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
      if (url.endsWith("/branches/dev/protection/required_status_checks")) return { ok: true, status: 200, json: async () => ({ strict: true, contexts: ["test"], checks: [{ context: "test", app_id: 15368 }] }) };
      if (url.includes("/rulesets?includes_parents=true")) return { ok: true, status: 200, json: async () => [] };
      assert.equal(url, `https://api.github.com/repos/example/repo/statuses/${headSha}`);
      assert.equal(options.method, "POST");
      return { ok: true, status: 201, json: async () => ({}) };
    }
  });
  assert.equal(calls.length, 2);
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
      if (url.endsWith("/branches/dev/protection/required_status_checks")) return { ok: true, status: 200, json: async () => ({ strict: true, contexts: ["test"], checks: [{ context: "test", app_id: 15368 }] }) };
      if (url.includes("/rulesets?includes_parents=true")) return { ok: true, status: 200, json: async () => [] };
      assert.equal(url, `https://api.github.com/repos/example/repo/statuses/${headSha}`);
      assert.equal(options.method, "POST");
      return { ok: true, status: 201, json: async () => ({}) };
    }
  });
  assert.equal(calls.length, 5);
  assert.equal(result.status, "published");
  const body = JSON.parse(calls[4].options.body);
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
      fetchImpl: async (url) => url.endsWith("/branches/dev/protection/required_status_checks")
        ? { ok: true, status: 200, json: async () => ({ strict: true, contexts: ["test"], checks: [{ context: "test", app_id: 15368 }] }) }
        : url.includes("/rulesets?includes_parents=true")
          ? { ok: true, status: 200, json: async () => [] }
          : { ok: true, status: 201, json: async () => ({}) }
    }),
    /not bound to the current workflow/
  );
});

test("required-check policy loader binds the dedicated protection response and applicable rulesets", async () => {
  const calls = [];
  const policy = await loadRequiredCheckPolicy({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    branch: "dev",
    token: "token",
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/branches/dev/protection/required_status_checks")) {
        return { ok: true, status: 200, json: async () => ({ strict: true, contexts: ["test"], checks: [{ context: "test", app_id: 15368 }] }) };
      }
      if (url.endsWith("/rulesets?includes_parents=true&per_page=100&page=1")) {
        return { ok: true, status: 200, json: async () => [{ id: 7, enforcement: "active" }] };
      }
      if (url.endsWith("/rulesets/7")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            target: "branch",
            conditions: { ref_name: { include: ["refs/heads/*"], exclude: ["refs/heads/blocked"] } },
            rules: [{
              type: "required_status_checks",
              parameters: {
                strict_required_status_checks_policy: true,
                required_status_checks: [{ context: "security", integration_id: 42 }]
              }
            }]
          })
        };
      }
      throw new Error(`Unexpected policy URL: ${url}`);
    }
  });
  assert.deepEqual(policy, [
    { context: "security", appId: 42, strict: true },
    { context: "test", appId: 15368, strict: true }
  ]);
  assert.equal(calls[0], "https://api.github.com/repos/example/repo/branches/dev/protection/required_status_checks");
  assert.ok(calls.includes("https://api.github.com/repos/example/repo/rulesets?includes_parents=true&per_page=100&page=1"));
});

test("ruleset policy resolves default-branch and exclusion semantics, and rejects unsupported refs", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/branches/dev/protection/required_status_checks") || url.endsWith("/branches/main/protection/required_status_checks")) {
      return { ok: true, status: 200, json: async () => ({ strict: true, contexts: ["test"], checks: [] }) };
    }
    if (url.endsWith("/repos/example/repo")) return { ok: true, status: 200, json: async () => ({ default_branch: "main" }) };
    if (url.endsWith("/rulesets?includes_parents=true&per_page=100&page=1")) return { ok: true, status: 200, json: async () => [{ id: 8, enforcement: "active" }] };
    if (url.endsWith("/rulesets/8")) return {
      ok: true,
      status: 200,
      json: async () => ({
        target: "branch",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: ["refs/heads/blocked"] } },
        rules: [{ type: "required_status_checks", parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "default-only", integration_id: 42 }]
        } }]
      })
    };
    throw new Error(`Unexpected default-branch ruleset URL: ${url}`);
  };
  const devPolicy = await loadRequiredCheckPolicy({ apiUrl: "https://api.github.com", repository: "example/repo", branch: "dev", token: "token", fetchImpl });
  assert.deepEqual(devPolicy, [{ context: "test", appId: null, strict: true }]);
  const mainPolicy = await loadRequiredCheckPolicy({ apiUrl: "https://api.github.com", repository: "example/repo", branch: "main", token: "token", fetchImpl });
  assert.deepEqual(mainPolicy, [
    { context: "default-only", appId: 42, strict: true },
    { context: "test", appId: null, strict: true }
  ]);
  const unsupportedFetch = async (url) => {
    if (url.endsWith("/branches/dev/protection/required_status_checks")) return { ok: true, status: 200, json: async () => ({ strict: true, contexts: ["test"], checks: [] }) };
    if (url.endsWith("/rulesets?includes_parents=true&per_page=100&page=1")) return { ok: true, status: 200, json: async () => [{ id: 9, enforcement: "active" }] };
    if (url.endsWith("/rulesets/9")) return { ok: true, status: 200, json: async () => ({ target: "branch", conditions: { ref_name: { include: ["refs/pull/*/merge"] } }, rules: [] }) };
    throw new Error(`Unexpected unsupported ruleset URL: ${url}`);
  };
  await assert.rejects(
    loadRequiredCheckPolicy({ apiUrl: "https://api.github.com", repository: "example/repo", branch: "dev", token: "token", fetchImpl: unsupportedFetch }),
    /unsupported ref pattern/
  );
});

test("ruleset fnmatch keeps single-star exclusions from crossing branch slashes", async () => {
  const policy = await loadRequiredCheckPolicy({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    branch: "releases/2026/hotfix",
    token: "token",
    fetchImpl: async (url) => {
      if (url.endsWith("/branches/releases%2F2026%2Fhotfix/protection/required_status_checks")) return { ok: true, status: 200, json: async () => ({ strict: true, contexts: ["test"], checks: [] }) };
      if (url.endsWith("/rulesets?includes_parents=true&per_page=100&page=1")) return { ok: true, status: 200, json: async () => [{ id: 10, enforcement: "active" }] };
      if (url.endsWith("/rulesets/10")) return {
        ok: true,
        status: 200,
        json: async () => ({
          target: "branch",
          conditions: { ref_name: { include: ["refs/heads/releases/**"], exclude: ["refs/heads/releases/*"] } },
          rules: [{ type: "required_status_checks", parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: [{ context: "nested-release", integration_id: 42 }]
          } }]
        })
      };
      throw new Error(`Unexpected fnmatch URL: ${url}`);
    }
  });
  assert.deepEqual(policy, [
    { context: "nested-release", appId: 42, strict: true },
    { context: "test", appId: null, strict: true }
  ]);
});

test("ruleset policy pagination includes active rulesets after the first full page", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, enforcement: "inactive" }));
  const calls = [];
  const policy = await loadRequiredCheckPolicy({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    branch: "dev",
    token: "token",
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/branches/dev/protection/required_status_checks")) return { ok: true, status: 200, json: async () => ({ strict: true, contexts: ["test"], checks: [] }) };
      if (url.endsWith("/rulesets?includes_parents=true&per_page=100&page=1")) return { ok: true, status: 200, json: async () => firstPage };
      if (url.endsWith("/rulesets?includes_parents=true&per_page=100&page=2")) return { ok: true, status: 200, json: async () => [{ id: 101, enforcement: "active" }] };
      if (url.endsWith("/rulesets/101")) return {
        ok: true,
        status: 200,
        json: async () => ({
          target: "branch",
          conditions: { ref_name: { include: ["refs/heads/dev"] } },
          rules: [{ type: "required_status_checks", parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: [{ context: "late-policy", integration_id: 7 }]
          } }]
        })
      };
      throw new Error(`Unexpected pagination URL: ${url}`);
    }
  });
  assert.deepEqual(policy, [
    { context: "late-policy", appId: 7, strict: true },
    { context: "test", appId: null, strict: true }
  ]);
  assert.ok(calls.some((url) => url.endsWith("page=2")));
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
  assert.equal(artifact.workflowFile, ".github/workflows/release-policy-reconcile.yml");
  assert.equal(artifact.triggerWorkflowRunId, "43");
  assert.throws(
    () => buildPolicyReceiptArtifact({ ...artifact, triggerWorkflowRunId: null }),
    /triggering workflow run id/
  );
});

test("workflow-run reconciliation requires one completed pull-request-target source", () => {
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
  assert.equal(parseWorkflowRunReconciliationEvent({ ...payload, workflow_run: { ...payload.workflow_run, conclusion: "failure" } }).triggerWorkflowRunId, "43");
  assert.throws(
    () => parseWorkflowRunReconciliationEvent({ ...payload, workflow_run: { ...payload.workflow_run, pull_requests: [] } }),
    /exactly one associated pull request/
  );
});

test("workflow-run reconciliation requires the exact closed merge binding", () => {
  const headSha = "b".repeat(40);
  const mergeCommitSha = "c".repeat(40);
  const mergedAt = "2026-08-18T00:00:00Z";
  const run = {
    id: 43,
    path: ".github/workflows/ci.yml",
    event: "pull_request_target",
    status: "completed",
    conclusion: "success",
    head_sha: mergeCommitSha,
    repository: { full_name: "example/repo" },
    pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev" } }]
  };
  const pull = {
    number: 17,
    state: "closed",
    merged: true,
    base: { ref: "dev" },
    head: { sha: headSha },
    merge_commit_sha: mergeCommitSha,
    merged_at: mergedAt
  };
  const binding = {
    schemaVersion: 1,
    kind: RELEASE_POLICY_CLOSE_BINDING_ARTIFACT_KIND,
    repository: "example/repo",
    workflowFile: ".github/workflows/ci.yml",
    workflowRunId: "43",
    eventName: "pull_request_target",
    eventAction: "closed",
    branch: "dev",
    pullNumber: 17,
    headSha,
    mergeCommitSha,
    mergedAt: "2026-08-18T00:00:00.000Z",
    observedAt: "2026-08-18T00:00:05.000Z"
  };
  assert.doesNotThrow(() => assertClosedPolicyReceiptBinding({ repository: "example/repo", run, pull, binding }));
  assert.throws(
    () => assertClosedPolicyReceiptBinding({ repository: "example/repo", run, pull, binding: { ...binding, eventAction: "synchronize" } }),
    /immutable closed-and-merged source binding/
  );
  assert.throws(
    () => assertClosedPolicyReceiptBinding({ repository: "example/repo", run: { ...run, head_sha: "e".repeat(40) }, pull, binding }),
    /exact completed closed-and-merged pull-request-target run/
  );
  assert.deepEqual(buildClosedPolicyReceiptBinding({
    repository: "example/repo",
    branch: "dev",
    headSha,
    pullNumber: 17,
    workflowRunId: "43",
    observedAt: "2026-08-18T00:00:05Z",
    mergeCommitSha,
    mergedAt
  }), binding);
});

test("closed receipt polling waits for the exact pre-merge status within a bounded window", async () => {
  const headSha = "d".repeat(40);
  const baseSha = "1".repeat(40);
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
      if (url.endsWith(`/actions/runs/42`)) return { ok: true, status: 200, json: async () => ({ id: 42, path: ".github/workflows/ci.yml", event: "pull_request_target", status: "completed", conclusion: "success", head_sha: baseSha, created_at: "2026-08-17T23:59:00Z", repository: { full_name: "example/repo" }, pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev", sha: baseSha } }] }) };
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
  const baseSha = "2".repeat(40);
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
    fetchImpl: async (url) => {
      if (url.endsWith("/actions/runs/42")) return { ok: true, status: 200, json: async () => ({ id: 42, path: ".github/workflows/ci.yml", event: "pull_request_target", status: "completed", conclusion: "success", head_sha: baseSha, created_at: "2026-08-17T23:59:59Z", repository: { full_name: "example/repo" }, pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev", sha: baseSha } }] }) };
      if (url.endsWith("/actions/runs/43")) return { ok: true, status: 200, json: async () => ({ id: 43, path: ".github/workflows/ci.yml", event: "pull_request_target", status: "completed", conclusion: "success", head_sha: baseSha, created_at: "2026-08-18T00:00:01Z", repository: { full_name: "example/repo" }, pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev", sha: baseSha } }] }) };
      return {
      ok: true,
      status: 200,
      json: async () => [
        status(42, "2026-08-17T23:59:59Z", 42),
        status(43, "2026-08-18T00:00:02Z", 43)
      ]
      };
    }
  });
  assert.equal(source.workflowRunId, "42");
  assert.equal(source.policyDigest, "a".repeat(64));
});

test("closed receipt rejects a source status observed after merge even when its run started before merge", async () => {
  const headSha = "e".repeat(40);
  const baseSha = "3".repeat(40);
  const status = {
    id: 52,
    state: "success",
    context: RELEASE_POLICY_RECEIPT_CONTEXT,
    target_url: `https://github.com/example/repo/actions/runs/52?phase=pre-merge&pr=17&head=${headSha}&base=dev`,
    description: `${RELEASE_POLICY_RECEIPT_PREFIX}${"c".repeat(64)}`,
    updated_at: "2026-08-18T00:00:05Z"
  };
  const source = await waitForSourcePolicyReceipt({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    branch: "dev",
    headSha,
    pullNumber: 17,
    mergedAt: "2026-08-18T00:00:00Z",
    token: "token",
    attempts: 1,
    fetchImpl: async (url) => {
      if (url.endsWith(`/commits/${headSha}/statuses?per_page=100&page=1`)) return { ok: true, status: 200, json: async () => [status] };
      if (url.endsWith("/actions/runs/52")) return { ok: true, status: 200, json: async () => ({
        id: 52,
        path: ".github/workflows/ci.yml",
        event: "pull_request_target",
        status: "completed",
        conclusion: "success",
        head_sha: baseSha,
        created_at: "2026-08-17T23:59:00Z",
        completed_at: "2026-08-18T00:00:04Z",
        repository: { full_name: "example/repo" },
        pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev", sha: baseSha } }]
      }) };
      throw new Error(`Unexpected source receipt URL: ${url}`);
    }
  });
  assert.equal(source, null);
});

test("closed receipt rejects a policy status observed after merge even when its run started before merge", async () => {
  const headSha = "9".repeat(40);
  const baseSha = "8".repeat(40);
  const status = {
    id: 92,
    state: "success",
    context: RELEASE_POLICY_RECEIPT_CONTEXT,
    target_url: `https://github.com/example/repo/actions/runs/92?phase=pre-merge&pr=17&head=${headSha}&base=dev`,
    description: `${RELEASE_POLICY_RECEIPT_PREFIX}${"f".repeat(64)}`,
    updated_at: "2026-08-18T00:00:05Z"
  };
  const source = await waitForSourcePolicyReceipt({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    branch: "dev",
    headSha,
    pullNumber: 17,
    mergedAt: "2026-08-18T00:00:00Z",
    token: "token",
    attempts: 1,
    fetchImpl: async (url) => {
      if (url.endsWith(`/commits/${headSha}/statuses?per_page=100&page=1`)) return { ok: true, status: 200, json: async () => [status] };
      if (url.endsWith("/actions/runs/92")) return { ok: true, status: 200, json: async () => ({
        id: 92,
        path: ".github/workflows/ci.yml",
        event: "pull_request_target",
        status: "completed",
        conclusion: "success",
        head_sha: baseSha,
        created_at: "2026-08-17T23:59:00Z",
        repository: { full_name: "example/repo" },
        pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev", sha: baseSha } }]
      }) };
      throw new Error(`Unexpected source receipt URL: ${url}`);
    }
  });
  assert.equal(source, null);
});
