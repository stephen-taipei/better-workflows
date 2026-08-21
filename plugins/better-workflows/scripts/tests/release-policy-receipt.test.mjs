import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  RELEASE_POLICY_RECEIPT_CONTEXT,
  RELEASE_POLICY_RECEIPT_PREFIX,
  RELEASE_POLICY_RECEIPT_ARTIFACT_KIND,
  RELEASE_POLICY_CLOSE_BINDING_ARTIFACT_KIND,
  assertPreMergePolicyReceiptArtifact,
  assertClosedPolicyReceiptBinding,
  assertExactReconciliationTrigger,
  canonicalWorkflowRunId,
  buildPolicyReceiptArtifact,
  buildClosedPolicyReceiptBinding,
  buildPolicyStatus,
  findClosedMergeWorkflowRun,
  loadRequiredCheckPolicy,
  normalizeRequiredChecks,
  parseWorkflowRunReconciliationEvent,
  prepareReleasePolicyReceipt,
  policyDigest,
  policyArtifactDigest,
  publishReleasePolicyReceipt,
  fetchWorkflowRunPolicyReceiptArtifact,
  waitForSourcePolicyReceipt
} from "../release-policy-receipt.mjs";

function withDownloadedArchiveDigest(artifact, digest = "d".repeat(64)) {
  Object.defineProperty(artifact, "downloadedArchiveDigest", {
    value: digest,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return artifact;
}

function zipStoredJson(filename, value) {
  const name = Buffer.from(filename);
  const data = Buffer.from(JSON.stringify(value));
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, end]);
}

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
  assert.throws(
    () => normalizeRequiredChecks({
      strict: true,
      contexts: ["test"],
      checks: [],
    }, { rulesetRequiredChecks: [{ context: "test", appId: null, strict: false }] }),
    /conflicting strictness/
  );
});

test("release policy loader fails closed when policy authorization is masked as not found", async () => {
  await assert.rejects(
    loadRequiredCheckPolicy({
      apiUrl: "https://api.github.com",
      repository: "example/repo",
      branch: "dev",
      token: "policy-reader",
      fetchImpl: async (url) => {
        if (url.endsWith("/branches/dev/protection/required_status_checks") || url.endsWith("/branches/dev")) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        throw new Error(`Unexpected masked-policy URL: ${url}`);
      }
    }),
    /HTTP 404/
  );
});

test("release policy loader does not trust branch and metadata-readable rulesets without Administration read", async () => {
  const calls = [];
  await assert.rejects(
    loadRequiredCheckPolicy({
      apiUrl: "https://api.github.com",
      repository: "example/repo",
      branch: "dev",
      token: "underprivileged-reader",
      requireAdministration: true,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.endsWith("/branches/dev/protection/required_status_checks")) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        if (url.endsWith("/branches/dev")) {
          return { ok: true, status: 200, json: async () => ({ name: "dev", protected: true }) };
        }
        if (url.endsWith("/rulesets?includes_parents=true&per_page=100&page=1")) {
          return { ok: true, status: 200, json: async () => [] };
        }
        if (url.endsWith("/rulesets/rule-suites?ref=refs%2Fheads%2Fdev&per_page=1&page=1")) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        throw new Error(`Unexpected masked-policy URL: ${url}`);
      }
    }),
    /HTTP 404/
  );
  assert.ok(calls.includes("https://api.github.com/repos/example/repo/branches/dev"));
  assert.ok(calls.includes("https://api.github.com/repos/example/repo/rulesets?includes_parents=true&per_page=100&page=1"));
  assert.ok(calls.includes("https://api.github.com/repos/example/repo/rulesets/rule-suites?ref=refs%2Fheads%2Fdev&per_page=1&page=1"));
});

test("ruleset-only protected branches continue after an authoritative classic-protection absence", async () => {
  const calls = [];
  const policy = await loadRequiredCheckPolicy({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    branch: "dev",
    token: "admin-reader",
    requireAdministration: true,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/branches/dev/protection/required_status_checks")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (url.endsWith("/branches/dev")) {
        return { ok: true, status: 200, json: async () => ({ name: "dev", protected: true }) };
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
            conditions: { ref_name: { include: ["refs/heads/dev"] } },
            rules: [{ type: "required_status_checks", parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [{ context: "ruleset-only", integration_id: 42 }]
            } }]
          })
        };
      }
      if (url.endsWith("/rulesets/rule-suites?ref=refs%2Fheads%2Fdev&per_page=1&page=1")) {
        return { ok: true, status: 200, json: async () => [] };
      }
      throw new Error(`Unexpected ruleset-only URL: ${url}`);
    }
  });
  assert.deepEqual(policy, [{ context: "ruleset-only", appId: 42, strict: true }]);
  assert.ok(calls.includes("https://api.github.com/repos/example/repo/branches/dev"));
  assert.ok(calls.includes("https://api.github.com/repos/example/repo/rulesets/rule-suites?ref=refs%2Fheads%2Fdev&per_page=1&page=1"));
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
  const policy = [{ context: "test", appId: null, strict: true }];
  const artifact = buildPolicyReceiptArtifact({
    repository: "example/repo",
    branch: "dev",
    headSha: "b".repeat(40),
    pullNumber: 17,
    policy,
    workflowRunId: "42",
    eventAction: "synchronize",
    observedAt: "2026-08-18T00:00:00Z"
  });
  assert.equal(artifact.eventName, "pull_request_target");
  assert.equal(artifact.workflowFile, ".github/workflows/ci.yml");
  assert.equal(artifact.policyDigest, policyDigest(artifact.policy));
  assert.doesNotThrow(() => assertPreMergePolicyReceiptArtifact({
    artifact,
    repository: "example/repo",
    branch: "dev",
    headSha: "b".repeat(40),
    pullNumber: 17,
    workflowRunId: "42",
    statusObservedAt: "2026-08-18T00:00:02Z"
  }));
  withDownloadedArchiveDigest(artifact);
  assert.equal(policyArtifactDigest(artifact).length, 64);
  assert.throws(
    () => policyArtifactDigest({ ...artifact }),
    /missing the exact downloaded archive digest/
  );
  assert.throws(
    () => assertPreMergePolicyReceiptArtifact({
      artifact: { ...artifact, policyDigest: "f".repeat(64) },
      repository: "example/repo",
      branch: "dev",
      headSha: "b".repeat(40),
      pullNumber: 17,
      workflowRunId: "42",
      statusObservedAt: "2026-08-18T00:00:02Z"
    }),
    /not bound to the trusted pre-merge workflow/
  );
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
    sourcePolicyDigest: policyDigest(policy),
    sourcePolicyArtifactDigest: "d".repeat(64)
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
    sourcePolicyDigest: policyDigest(policy),
    sourcePolicyArtifactDigest: "e".repeat(64)
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
      repository: { full_name: "example/repo" },
      path: ".github/workflows/ci.yml",
      event: "pull_request_target",
      status: "completed",
      conclusion: "success",
      completed_at: "2026-08-18T00:00:06Z",
      pull_requests: [{ number: 17, head: { sha: "b".repeat(40) }, base: { ref: "dev" } }]
    }
  };
  assert.deepEqual(parseWorkflowRunReconciliationEvent(payload, { repository: "example/repo" }), {
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
  assert.throws(
    () => parseWorkflowRunReconciliationEvent(payload, { repository: "other/repo" }),
    /completed pull-request-target source run/
  );
});

test("workflow-run reconciliation requires the exact closed merge binding", () => {
  const headSha = "b".repeat(40);
  const mergeCommitSha = "c".repeat(40);
  const mergedAt = "2026-08-18T00:00:00Z";
  const run = {
    id: 43,
    run_attempt: 1,
    path: ".github/workflows/ci.yml",
    event: "pull_request_target",
    status: "completed",
    conclusion: "success",
    completed_at: "2026-08-18T00:00:06Z",
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
    workflowRunAttempt: "1",
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
    () => assertClosedPolicyReceiptBinding({ repository: "example/repo", run: { ...run, completed_at: undefined }, pull, binding }),
    /exact completed closed-and-merged pull-request-target run/
  );
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

test("workflow-run reconciliation rejects a pre-merge trigger when a different closed merge run is discovered", () => {
  assert.deepEqual(
    assertExactReconciliationTrigger({ triggerWorkflowRunId: "43", closedMergeRunId: "99" }),
    { triggerWorkflowRunId: "43", closedMergeRunId: "99" }
  );
  assert.throws(
    () => assertExactReconciliationTrigger({ triggerWorkflowRunId: "unsafe", closedMergeRunId: 99 }),
    /valid trigger and closed-merge workflow identities/
  );
});

test("workflow-run reconciliation canonicalizes large IDs and rejects unsafe identities", () => {
  assert.equal(canonicalWorkflowRunId("9007199254740993"), "9007199254740993");
  assert.equal(canonicalWorkflowRunId(99), "99");
  assert.throws(() => canonicalWorkflowRunId(9007199254740993), /missing or unsafe workflow-run identity/);
  assert.throws(() => canonicalWorkflowRunId("01"), /missing or unsafe workflow-run identity/);
});

test("delayed workflow-run reconciliation locates the exact closed merge run instead of the triggering pre-merge run", async () => {
  const headSha = "b".repeat(40);
  const mergeCommitSha = "c".repeat(40);
  const mergedAt = "2026-08-18T00:00:00Z";
  const binding = {
    schemaVersion: 1,
    kind: RELEASE_POLICY_CLOSE_BINDING_ARTIFACT_KIND,
    repository: "example/repo",
    workflowFile: ".github/workflows/ci.yml",
    workflowRunId: "99",
    eventName: "pull_request_target",
    eventAction: "closed",
    branch: "dev",
    pullNumber: 17,
    headSha,
    mergeCommitSha,
    mergedAt: "2026-08-18T00:00:00.000Z",
    observedAt: "2026-08-18T00:00:05.000Z"
  };
  const closedRun = {
    id: 99,
    path: ".github/workflows/ci.yml",
    event: "pull_request_target",
    status: "completed",
    conclusion: "success",
    head_sha: mergeCommitSha,
    created_at: "2026-08-18T00:00:01Z",
    completed_at: "2026-08-18T00:00:06Z",
    repository: { full_name: "example/repo" },
    pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev" } }]
  };
  const calls = [];
  const result = await findClosedMergeWorkflowRun({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    branch: "dev",
    pullNumber: 17,
    headSha,
    mergeCommitSha,
    mergedAt,
    token: "token",
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("/actions/workflows/ci.yml/runs?")) {
        return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ id: 7 }, { id: 99 }, { id: 99 }] }) };
      }
      if (url.endsWith("/actions/runs/7")) {
        return { ok: true, status: 200, json: async () => ({
          id: 7,
          path: ".github/workflows/ci.yml",
          event: "pull_request_target",
          status: "completed",
          conclusion: "success",
          head_sha: headSha,
          created_at: "2026-08-17T23:59:00Z",
          pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev" } }]
        }) };
      }
      if (url.endsWith("/actions/runs/99")) return { ok: true, status: 200, json: async () => closedRun };
      throw new Error(`Unexpected delayed reconciliation URL: ${url}`);
    },
    fetchCloseBindingImpl: async ({ runId }) => {
      assert.equal(runId, "99");
      return binding;
    }
  });
  assert.equal(result.run.id, 99);
  assert.equal(result.binding.workflowRunId, "99");
  assert.ok(calls.some((url) => url.endsWith("/actions/runs/99")));
  assert.ok(!calls.some((url) => url.endsWith("/actions/runs/43")));
});

test("closed merge workflow reconciliation rejects conflicting duplicate run identities", async () => {
  await assert.rejects(
    findClosedMergeWorkflowRun({
      apiUrl: "https://api.github.com",
      repository: "example/repo",
      branch: "dev",
      pullNumber: 17,
      headSha: "b".repeat(40),
      mergeCommitSha: "c".repeat(40),
      mergedAt: "2026-08-18T00:00:00Z",
      token: "token",
      fetchImpl: async (url) => url.includes("/actions/workflows/ci.yml/runs?")
        ? { ok: true, status: 200, json: async () => ({ workflow_runs: [{ id: 99 }, { id: 99, path: "other.yml" }] }) }
        : { ok: true, status: 200, json: async () => ({}) }
    }),
    /ambiguous duplicate workflow-run identity/
  );
});

test("closed receipt polling waits for the exact pre-merge status within a bounded window", async () => {
  const headSha = "d".repeat(40);
  const baseSha = "1".repeat(40);
  const policy = [{ context: "test", appId: null, strict: true }];
  const sourceDigest = policyDigest(policy);
  const sourceStatus = {
    id: 42,
    state: "success",
    context: RELEASE_POLICY_RECEIPT_CONTEXT,
    target_url: `https://github.com/example/repo/actions/runs/42?phase=pre-merge&pr=17&head=${headSha}&base=dev`,
    description: `${RELEASE_POLICY_RECEIPT_PREFIX}${sourceDigest}`,
    created_at: "2026-08-18T00:00:01Z",
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
      if (url.endsWith(`/actions/runs/42`)) return { ok: true, status: 200, json: async () => ({ id: 42, path: ".github/workflows/ci.yml", event: "pull_request_target", status: "completed", conclusion: "success", head_sha: baseSha, created_at: "2026-08-17T23:59:00Z", completed_at: "2026-08-17T23:59:30Z", repository: { full_name: "example/repo" }, pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev", sha: baseSha } }] }) };
      queries += 1;
      assert.equal(url, `https://api.github.com/repos/example/repo/commits/${headSha}/statuses?per_page=100&page=1`);
      return { ok: true, status: 200, json: async () => (queries === 1 ? [] : [sourceStatus]) };
    },
    fetchArtifactImpl: async ({ runId }) => {
      assert.equal(runId, "42");
      return withDownloadedArchiveDigest(buildPolicyReceiptArtifact({
        repository: "example/repo",
        branch: "dev",
        headSha,
        pullNumber: 17,
        policy,
        workflowRunId: runId,
        eventAction: "synchronize",
        observedAt: "2026-08-18T00:00:01Z"
      }));
    }
  });
  assert.equal(source.workflowRunId, "42");
  assert.equal(source.policyDigest, sourceDigest);
  assert.equal(source.policyArtifactDigest.length, 64);
  assert.deepEqual(sleeps, [5_000]);
  assert.equal(queries, 2);
});

test("source status terminal proof cannot fall back to its origin timestamp", async () => {
  const headSha = "8".repeat(40);
  const status = {
    id: 77,
    state: "success",
    context: RELEASE_POLICY_RECEIPT_CONTEXT,
    target_url: `https://github.com/example/repo/actions/runs/77?phase=pre-merge&pr=17&head=${headSha}&base=dev`,
    description: `${RELEASE_POLICY_RECEIPT_PREFIX}${"a".repeat(64)}`,
    created_at: "2026-08-18T00:00:01Z"
  };
  await assert.rejects(
    waitForSourcePolicyReceipt({
      apiUrl: "https://api.github.com",
      repository: "example/repo",
      branch: "dev",
      headSha,
      pullNumber: 17,
      token: "token",
      attempts: 1,
      fetchImpl: async (url) => {
        assert.equal(url, `https://api.github.com/repos/example/repo/commits/${headSha}/statuses?per_page=100&page=1`);
        return { ok: true, status: 200, json: async () => [status] };
      }
    }),
    /invalid observation timestamp/
  );
});

test("source workflow receipt rejects unsafe numeric workflow identities", async () => {
  const headSha = "7".repeat(40);
  const baseSha = "6".repeat(40);
  const status = {
    id: 78,
    state: "success",
    context: RELEASE_POLICY_RECEIPT_CONTEXT,
    target_url: `https://github.com/example/repo/actions/runs/78?phase=pre-merge&pr=17&head=${headSha}&base=dev`,
    description: `${RELEASE_POLICY_RECEIPT_PREFIX}${"b".repeat(64)}`,
    created_at: "2026-08-18T00:00:01Z",
    updated_at: "2026-08-18T00:00:02Z"
  };
  const source = await waitForSourcePolicyReceipt({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    branch: "dev",
    headSha,
    pullNumber: 17,
    token: "token",
    attempts: 1,
    fetchImpl: async (url) => {
      if (url.endsWith(`/repos/example/repo/commits/${headSha}/statuses?per_page=100&page=1`)) {
        return { ok: true, status: 200, json: async () => [status] };
      }
      if (url.endsWith("/actions/runs/78")) {
        return { ok: true, status: 200, json: async () => ({
          id: Number.MAX_SAFE_INTEGER + 2,
          path: ".github/workflows/ci.yml",
          event: "pull_request_target",
          status: "completed",
          conclusion: "success",
          head_sha: baseSha,
          created_at: "2026-08-17T23:59:00Z",
          completed_at: "2026-08-17T23:59:30Z",
          repository: { full_name: "example/repo" },
          pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev", sha: baseSha } }]
        }) };
      }
      throw new Error(`Unexpected unsafe workflow identity URL: ${url}`);
    }
  });
  assert.equal(source, null);
});

test("policy artifact lookup enumerates bounded pages before enforcing exact-name uniqueness", async () => {
  let pageRequests = 0;
  await assert.rejects(
    fetchWorkflowRunPolicyReceiptArtifact({
      apiUrl: "https://api.github.com",
      repository: "example/repo",
      runId: "88",
      token: "token",
      fetchImpl: async (url) => {
        if (!url.includes("/artifacts?")) throw new Error(`Unexpected artifact download URL: ${url}`);
        pageRequests += 1;
        if (url.endsWith("page=1")) {
          return { ok: true, status: 200, json: async () => ({ artifacts: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `other-${index}`, expired: false })) }) };
        }
        return { ok: true, status: 200, json: async () => ({ artifacts: [
          { id: 101, name: "better-workflows-release-policy-receipt-88", expired: false },
          { id: 102, name: "better-workflows-release-policy-receipt-88", expired: false }
        ] }) };
      }
    }),
    /must expose exactly one immutable policy artifact/
  );
  assert.equal(pageRequests, 2);
});

test("policy artifact lookup selects the exact rerun attempt for one workflow run", async () => {
  const policy = [{ context: "test", appId: null, strict: true }];
  const makeArtifact = (attempt) => buildPolicyReceiptArtifact({
    repository: "example/repo",
    branch: "dev",
    headSha: "a".repeat(40),
    pullNumber: 17,
    policy,
    workflowRunId: "88",
    workflowRunAttempt: String(attempt),
    eventAction: "synchronize",
    observedAt: "2026-08-18T00:00:01Z"
  });
  const attemptOne = zipStoredJson("release-policy-receipt.json", makeArtifact(1));
  const attemptTwo = zipStoredJson("release-policy-receipt.json", makeArtifact(2));
  const digestOne = createHash("sha256").update(attemptOne).digest("hex");
  const digestTwo = createHash("sha256").update(attemptTwo).digest("hex");
  const fetched = await fetchWorkflowRunPolicyReceiptArtifact({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    runId: "88",
    runAttempt: "2",
    token: "token",
    fetchImpl: async (url) => {
      if (url.includes("/artifacts?")) return {
        ok: true,
        status: 200,
        json: async () => ({ artifacts: [
          { id: 1, name: "better-workflows-release-policy-receipt-88-1", expired: false, digest: `sha256:${digestOne}`, workflow_run: { id: 88, run_attempt: 1 }, archive_download_url: "https://artifact.invalid/attempt-1.zip" },
          { id: 2, name: "better-workflows-release-policy-receipt-88-2", expired: false, digest: `sha256:${digestTwo}`, workflow_run: { id: 88, run_attempt: 2 }, archive_download_url: "https://artifact.invalid/attempt-2.zip" }
        ] })
      };
      const archive = url.endsWith("attempt-2.zip") ? attemptTwo : attemptOne;
      return { ok: true, status: 200, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) };
    }
  });
  assert.equal(fetched.workflowRunAttempt, "2");
  assert.equal(fetched.workflowRunId, "88");
});

test("closed receipt polling blocks a newer pre-merge status published after merge", async () => {
  const headSha = "f".repeat(40);
  const baseSha = "2".repeat(40);
  const policy = [{ context: "test", appId: null, strict: true }];
  const sourceDigest = policyDigest(policy);
  const status = (id, updatedAt, workflowRunId) => ({
    id,
    state: "success",
    context: RELEASE_POLICY_RECEIPT_CONTEXT,
    target_url: `https://github.com/example/repo/actions/runs/${workflowRunId}?phase=pre-merge&pr=17&head=${headSha}&base=dev`,
    description: `${RELEASE_POLICY_RECEIPT_PREFIX}${id === 42 ? sourceDigest : "b".repeat(64)}`,
    created_at: updatedAt,
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
    attempts: 1,
    fetchImpl: async (url) => {
      if (url.endsWith("/actions/runs/42")) return { ok: true, status: 200, json: async () => ({ id: 42, path: ".github/workflows/ci.yml", event: "pull_request_target", status: "completed", conclusion: "success", head_sha: baseSha, created_at: "2026-08-17T23:59:59Z", completed_at: "2026-08-17T23:59:59Z", repository: { full_name: "example/repo" }, pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev", sha: baseSha } }] }) };
      if (url.endsWith("/actions/runs/43")) return { ok: true, status: 200, json: async () => ({ id: 43, path: ".github/workflows/ci.yml", event: "pull_request_target", status: "completed", conclusion: "success", head_sha: baseSha, created_at: "2026-08-18T00:00:01Z", completed_at: "2026-08-18T00:00:03Z", repository: { full_name: "example/repo" }, pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev", sha: baseSha } }] }) };
      return {
      ok: true,
      status: 200,
      json: async () => [
        status(42, "2026-08-17T23:59:59Z", 42),
        status(43, "2026-08-18T00:00:02Z", 43)
      ]
      };
    },
    fetchArtifactImpl: async ({ runId }) => {
      assert.equal(runId, "42");
      return withDownloadedArchiveDigest(buildPolicyReceiptArtifact({
        repository: "example/repo",
        branch: "dev",
        headSha,
        pullNumber: 17,
        policy,
        workflowRunId: runId,
        eventAction: "synchronize",
        observedAt: "2026-08-17T23:59:58Z"
      }));
    }
  });
  assert.equal(source, null);
});

test("closed receipt polling orders equal-time provider IDs numerically and rejects conflicting duplicates", async () => {
  const headSha = "1".repeat(40);
  const baseSha = "2".repeat(40);
  const policy = [{ context: "test", appId: null, strict: true }];
  const sourceDigest = policyDigest(policy);
  const status = (id, digest = sourceDigest) => ({
    id,
    state: "success",
    context: RELEASE_POLICY_RECEIPT_CONTEXT,
    target_url: `https://github.com/example/repo/actions/runs/${id}?phase=pre-merge&pr=17&head=${headSha}&base=dev`,
    description: `${RELEASE_POLICY_RECEIPT_PREFIX}${digest}`,
    created_at: "2026-08-18T00:00:01Z",
    updated_at: "2026-08-18T00:00:02Z"
  });
  const run = (id) => ({
    id: Number(id),
    path: ".github/workflows/ci.yml",
    event: "pull_request_target",
    status: "completed",
    conclusion: "success",
    head_sha: baseSha,
    created_at: "2026-08-17T23:59:59Z",
    completed_at: "2026-08-18T00:00:00Z",
    repository: { full_name: "example/repo" },
    pull_requests: [{ number: 17, head: { sha: headSha }, base: { ref: "dev", sha: baseSha } }]
  });
  const source = await waitForSourcePolicyReceipt({
    apiUrl: "https://api.github.com",
    repository: "example/repo",
    branch: "dev",
    headSha,
    pullNumber: 17,
    token: "token",
    fetchImpl: async (url) => {
      if (url.endsWith("/actions/runs/10")) return { ok: true, status: 200, json: async () => run("10") };
      if (url.includes("/commits/")) return { ok: true, status: 200, json: async () => [status("9"), status("10")] };
      throw new Error(`Unexpected source ordering URL: ${url}`);
    },
    fetchArtifactImpl: async ({ runId }) => {
      assert.equal(runId, "10");
      return withDownloadedArchiveDigest(buildPolicyReceiptArtifact({
        repository: "example/repo",
        branch: "dev",
        headSha,
        pullNumber: 17,
        policy,
        workflowRunId: runId,
        eventAction: "synchronize",
        observedAt: "2026-08-18T00:00:01Z"
      }));
    }
  });
  assert.equal(source.workflowRunId, "10");
  await assert.rejects(
    waitForSourcePolicyReceipt({
      apiUrl: "https://api.github.com",
      repository: "example/repo",
      branch: "dev",
      headSha,
      pullNumber: 17,
      token: "token",
      attempts: 1,
      fetchImpl: async (url) => url.includes("/commits/")
        ? { ok: true, status: 200, json: async () => [status("10"), status("10", "a".repeat(64))] }
        : { ok: true, status: 200, json: async () => run("10") }
    }),
    /ambiguous duplicate provider identity/
  );
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
    created_at: "2026-08-17T23:59:55Z",
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
    created_at: "2026-08-17T23:59:55Z",
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
