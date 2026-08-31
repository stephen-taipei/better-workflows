import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInteractionAuthorizationReceipt,
  buildInteractionRequest,
  compareInteractionScopes,
  dedupeInteractionRequest,
  decideInteractionAuthorization,
  interactionScopeDigest,
  interactionScopeFromRoute,
  validateStandingInteractionAuthorization
} from "../lib/interaction-authorization.mjs";

const digest = (letter) => letter.repeat(64);

function scope(overrides = {}) {
  return {
    repository: "github.com/example/better-workflows",
    goalDigest: digest("a"),
    sourceBindingDigest: digest("b"),
    base: digest("c"),
    head: digest("d"),
    contractDigest: digest("e"),
    packageId: "review-123",
    packageDigest: digest("f"),
    instructionDigest: digest("1"),
    diffManifestDigest: digest("2"),
    recipient: "OpenAI Codex",
    provider: "codex",
    model: "gpt-5.5",
    reviewerId: "codex-native-review-v1",
    executionId: "native-review-v1-1",
    dataScope: ["src", "tests"],
    sideEffectKinds: ["read-only-review"],
    target: "dev",
    safetyConstraints: {
      sandbox: "read-only",
      ephemeral: true,
      noRemoteSideEffects: true
    },
    ...overrides
  };
}

function standingAuthorization(request, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "standing-interaction-authorization",
    authorizationId: "standing-v1",
    status: "active",
    scope: request.scope,
    scopeDigest: request.scopeDigest,
    issuedAt: "2026-08-31T00:00:00.000Z",
    expiresAt: null,
    autoRenewable: true,
    source: "user-standing-directive",
    technicalGateOnly: true,
    ...overrides
  };
}

test("default auto mode emits one stable HOLD without a standing directive", () => {
  const request = buildInteractionRequest({ scope: scope() });
  const first = decideInteractionAuthorization({ request });
  const second = decideInteractionAuthorization({ request });
  assert.equal(first.ok, false);
  assert.equal(first.decision, "requires-user");
  assert.equal(first.reason, "missing-standing-directive");
  assert.equal(first.requestDigest, second.requestDigest);
  assert.equal(first.hold.id, second.hold.id);
  assert.equal(first.hold.repeat, false);
  assert.equal(first.authorityClass, "interaction-only");
  assert.equal(first.technicalGatesRequired, true);
});

test("SOP route auto mode approves interaction without granting action authority", () => {
  const request = buildInteractionRequest({
    scope: scope({
      safetyConstraints: {
        ...scope().safetyConstraints,
        interactionPolicy: "sop-auto-v1"
      }
    })
  });
  const decision = decideInteractionAuthorization({ request });
  assert.equal(decision.ok, true);
  assert.equal(decision.decision, "auto-approved");
  assert.equal(decision.reason, "auto-mode-default");
  assert.equal(decision.implicit, true);
  assert.equal(decision.suppressDuplicatePrompt, true);
  assert.equal(decision.grantsActionAuthority, false);
  assert.equal(decision.technicalGatesRequired, true);
  const receipt = buildInteractionAuthorizationReceipt({ request, decision });
  assert.equal(receipt.implicit, true);
  assert.equal(receipt.grantsActionAuthority, false);
});

test("strict mode still requires a user decision for an SOP route", () => {
  const request = buildInteractionRequest({
    mode: "strict",
    scope: scope({
      safetyConstraints: {
        ...scope().safetyConstraints,
        interactionPolicy: "sop-auto-v1"
      }
    })
  });
  const decision = decideInteractionAuthorization({ request });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "strict-mode");
});

test("matching active standing scope suppresses a duplicate prompt but grants no action authority", () => {
  const request = buildInteractionRequest({ scope: scope() });
  const decision = decideInteractionAuthorization({
    request,
    standingAuthorization: standingAuthorization(request)
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.decision, "auto-approved");
  assert.equal(decision.reason, "standing-scope-match");
  assert.equal(decision.suppressDuplicatePrompt, true);
  assert.equal(decision.grantsActionAuthority, false);
  assert.equal(decision.technicalGatesRequired, true);
});

test("review scopes accept forty-character Git revisions for base and head", () => {
  const request = buildInteractionRequest({
    scope: scope({
      base: "b".repeat(40),
      head: "c".repeat(40)
    })
  });
  assert.equal(request.scope.base, "b".repeat(40));
  assert.equal(request.scope.head, "c".repeat(40));
  assert.match(request.scopeDigest, /^[a-f0-9]{64}$/);
});

test("freshness-only renewal preserves the predecessor and never compares timestamps as scope", () => {
  const request = buildInteractionRequest({ scope: scope() });
  const decision = decideInteractionAuthorization({
    request,
    staleReason: "receipt-refresh",
    standingAuthorization: standingAuthorization(request, { status: "stale" })
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.renewed, true);
  assert.equal(decision.reason, "stale-scope-refresh");
  assert.equal(decision.predecessorAuthorizationId, "standing-v1");
  const renewed = buildInteractionAuthorizationReceipt({ request, decision });
  assert.equal(renewed.predecessorAuthorizationId, "standing-v1");
  assert.equal(renewed.grantsActionAuthority, false);
});

test("new package, model, recipient, repository, or side effect is material drift", () => {
  const original = scope();
  const changed = scope({
    packageId: "review-456",
    packageDigest: digest("3"),
    model: "gpt-5.6-sol",
    recipient: "different-recipient",
    repository: "github.com/example/other-repository",
    sideEffectKinds: ["read-only-review", "pr.create"]
  });
  const comparison = compareInteractionScopes(original, changed);
  assert.equal(comparison.same, false);
  assert.deepEqual(
    comparison.materialChanges.map((item) => item.field),
    ["repository", "packageId", "packageDigest", "recipient", "model", "sideEffectKinds"]
  );
  const request = buildInteractionRequest({ scope: changed });
  const decision = decideInteractionAuthorization({
    request,
    standingAuthorization: standingAuthorization(buildInteractionRequest({ scope: original }))
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "material-scope-change");
  assert.equal(decision.requiredAuthority, "user-standing-directive");
});

test("strict mode always asks, even when an exact standing directive exists", () => {
  const request = buildInteractionRequest({ scope: scope(), mode: "strict" });
  const decision = decideInteractionAuthorization({
    request,
    standingAuthorization: standingAuthorization(request)
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "strict-mode");
});

test("unknown stale reasons and incomplete scopes fail closed", () => {
  const incomplete = buildInteractionRequest({
    scope: { repository: scope().repository, goalDigest: scope().goalDigest }
  });
  const incompleteDecision = decideInteractionAuthorization({ request: incomplete });
  assert.equal(incompleteDecision.reason, "incomplete-scope");
  assert.ok(incompleteDecision.materialChanges.some((item) => item.field === "model"));

  const request = buildInteractionRequest({ scope: scope() });
  const unknownReason = decideInteractionAuthorization({
    request,
    staleReason: "package-rebuilt-after-block",
    standingAuthorization: standingAuthorization(request, { status: "stale" })
  });
  assert.equal(unknownReason.ok, false);
  assert.equal(unknownReason.reason, "unknown-stale-reason");
});

test("scope and request digests are deterministic and prior HOLDs deduplicate", () => {
  const first = buildInteractionRequest({ scope: scope() });
  const second = buildInteractionRequest({ scope: { ...scope(), dataScope: ["tests", "src"] } });
  assert.equal(first.scopeDigest, second.scopeDigest);
  assert.equal(first.requestDigest, second.requestDigest);
  const hold = buildInteractionAuthorizationReceipt({
    request: first,
    decision: decideInteractionAuthorization({ request: first })
  });
  const deduped = dedupeInteractionRequest(second, [hold]);
  assert.equal(deduped.deduplicated, true);
  assert.equal(deduped.nextPrompt, null);
  assert.equal(interactionScopeDigest(scope()), first.scopeDigest);
});

test("standing directives are closed, technical-gate-only records", () => {
  const request = buildInteractionRequest({ scope: scope() });
  assert.doesNotThrow(() => validateStandingInteractionAuthorization(standingAuthorization(request)));
  assert.throws(
    () => validateStandingInteractionAuthorization({ ...standingAuthorization(request), password: "secret" }),
    /unknown fields/
  );
  assert.equal(
    interactionScopeFromRoute({
      repository: "/repo",
      goal: "review the source",
      scope: ["tests", "src"],
      template: "review-issues",
      integrationTarget: "dev",
      protectedTarget: true,
      effectiveMode: "critical",
      mutationIntent: "read-only"
    }).dataScope.join(","),
    "src,tests"
  );
});
