import { createHash } from "node:crypto";

/**
 * Interaction authorization is deliberately separate from action authority.
 * It answers only whether the root agent may suppress a duplicate user prompt
 * for the same material scope.  Action tokens, evidence gates, attestations,
 * provider reconciliation, and protected delivery remain authoritative.
 */

export const INTERACTION_AUTHORIZATION_SCHEMA_VERSION = 1;
export const INTERACTION_MODES = Object.freeze(["auto", "strict"]);
export const INTERACTION_AUTHORIZATION_KIND = "standing-interaction-authorization";
export const INTERACTION_REQUEST_KIND = "interaction-authorization-request";
export const INTERACTION_RECEIPT_KIND = "interaction-authorization-receipt";
export const INTERACTION_AUTHORITY_CLASS = "interaction-only";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FRESHNESS_REASONS = new Set([
  "freshness",
  "time",
  "receipt-refresh",
  "nonce-refresh",
  "exact-binding-refresh"
]);

// Keep this list closed.  An omitted field is normalized to null, so a newly
// supplied package/model/recipient/side effect is a material scope change.
export const INTERACTION_SCOPE_FIELDS = Object.freeze([
  "repository",
  "goalDigest",
  "sourceBindingDigest",
  "base",
  "head",
  "contractDigest",
  "packageId",
  "packageDigest",
  "instructionDigest",
  "diffManifestDigest",
  "recipient",
  "provider",
  "model",
  "reviewerId",
  "executionId",
  "dataScope",
  "sideEffectKinds",
  "target",
  "safetyConstraints"
]);

const DIGEST_FIELDS = new Set([
  "goalDigest",
  "sourceBindingDigest",
  "base",
  "head",
  "contractDigest",
  "packageDigest",
  "instructionDigest",
  "diffManifestDigest"
]);
const NULLABLE_FIELDS = new Set([
  "sourceBindingDigest",
  "base",
  "head",
  "contractDigest",
  "packageId",
  "packageDigest",
  "instructionDigest",
  "diffManifestDigest",
  "recipient",
  "provider",
  "model",
  "reviewerId",
  "executionId",
  "target"
]);
const ARRAY_FIELDS = new Set(["dataScope", "sideEffectKinds"]);
const REQUIRED_SCOPE_FIELDS = Object.freeze([
  "repository",
  "goalDigest",
  "recipient",
  "provider",
  "model",
  "dataScope",
  "sideEffectKinds",
  "target",
  "safetyConstraints"
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function normalizeString(value, label, { nullable = false } = {}) {
  if (value === undefined || value === null) {
    if (nullable) return null;
    throw new Error(`${label} is required`);
  }
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeDigest(value, label, { nullable = false } = {}) {
  const normalized = normalizeString(value, label, { nullable });
  if (normalized === null) return null;
  if (!SHA256.test(normalized)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return normalized;
}

function normalizeStringArray(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.includes("\0"))) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  const normalized = [...new Set(value.map((item) => item.trim()))].sort();
  return normalized;
}

function normalizeConstraints(value) {
  if (value === undefined || value === null) return {};
  assertPlainObject(value, "Interaction safetyConstraints");
  // The canonical serializer intentionally preserves array order for safety
  // constraints: changing an ordered policy is a material change.
  return JSON.parse(JSON.stringify(value));
}

function normalizeScopeForComparison(scope) {
  assertPlainObject(scope, "Interaction scope");
  const unknown = Object.keys(scope).filter((key) => !INTERACTION_SCOPE_FIELDS.includes(key));
  if (unknown.length > 0) throw new Error(`Interaction scope has unknown fields: ${unknown.join(", ")}`);
  const normalized = {};
  for (const key of INTERACTION_SCOPE_FIELDS) {
    if (ARRAY_FIELDS.has(key)) {
      normalized[key] = normalizeStringArray(scope[key], `Interaction scope.${key}`);
    } else if (key === "safetyConstraints") {
      normalized[key] = normalizeConstraints(scope[key]);
    } else if (DIGEST_FIELDS.has(key)) {
      normalized[key] = normalizeDigest(scope[key], `Interaction scope.${key}`, { nullable: NULLABLE_FIELDS.has(key) });
    } else {
      normalized[key] = normalizeString(scope[key], `Interaction scope.${key}`, { nullable: NULLABLE_FIELDS.has(key) });
    }
  }
  return normalized;
}

export function normalizeInteractionScope(scope) {
  return normalizeScopeForComparison(scope);
}

export function interactionScopeDigest(scope) {
  return digest(normalizeScopeForComparison(scope));
}

export function interactionRequestDigest({ scopeDigest, mode = "auto" }) {
  if (!SHA256.test(String(scopeDigest ?? ""))) throw new Error("Interaction scope digest is invalid");
  if (!INTERACTION_MODES.includes(mode)) throw new Error("Interaction mode must be auto or strict");
  return digest({ schemaVersion: INTERACTION_AUTHORIZATION_SCHEMA_VERSION, scopeDigest, mode });
}

export function buildInteractionRequest({ scope, mode = "auto", requiredScopeFields = REQUIRED_SCOPE_FIELDS } = {}) {
  if (!INTERACTION_MODES.includes(mode)) throw new Error("Interaction mode must be auto or strict");
  const normalizedScope = normalizeScopeForComparison(scope);
  const required = [...new Set(requiredScopeFields.map(String))];
  const unknownRequired = required.filter((key) => !INTERACTION_SCOPE_FIELDS.includes(key));
  if (unknownRequired.length > 0) throw new Error(`Interaction required scope field is unknown: ${unknownRequired.join(", ")}`);
  const scopeDigest = digest(normalizedScope);
  return {
    schemaVersion: INTERACTION_AUTHORIZATION_SCHEMA_VERSION,
    kind: INTERACTION_REQUEST_KIND,
    mode,
    scope: normalizedScope,
    scopeDigest,
    requiredScopeFields: required,
    requestDigest: interactionRequestDigest({ scopeDigest, mode }),
    dedupeKey: `interaction:${interactionRequestDigest({ scopeDigest, mode })}`
  };
}

function missingRequiredScope(scope, requiredScopeFields) {
  return requiredScopeFields.filter((key) => {
    const value = scope[key];
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (value && typeof value === "object") return Object.keys(value).length === 0;
    return value === "";
  });
}

export function compareInteractionScopes(previousScope, requestedScope) {
  const previous = normalizeScopeForComparison(previousScope);
  const requested = normalizeScopeForComparison(requestedScope);
  const materialChanges = INTERACTION_SCOPE_FIELDS
    .filter((key) => canonical(previous[key]) !== canonical(requested[key]))
    .map((field) => ({ field, previous: previous[field], requested: requested[field] }));
  return {
    same: materialChanges.length === 0,
    materialChanges,
    previousScopeDigest: digest(previous),
    requestedScopeDigest: digest(requested)
  };
}

function validateTimestamp(value, label, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new Error(`${label} is required`);
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

export function validateStandingInteractionAuthorization(value) {
  assertPlainObject(value, "Standing interaction authorization");
  const expectedKeys = [
    "schemaVersion",
    "kind",
    "authorizationId",
    "status",
    "scope",
    "scopeDigest",
    "issuedAt",
    "expiresAt",
    "autoRenewable",
    "source",
    "technicalGateOnly"
  ];
  const unknown = Object.keys(value).filter((key) => !expectedKeys.includes(key));
  if (unknown.length > 0) throw new Error(`Standing interaction authorization has unknown fields: ${unknown.join(", ")}`);
  if (value.schemaVersion !== INTERACTION_AUTHORIZATION_SCHEMA_VERSION || value.kind !== INTERACTION_AUTHORIZATION_KIND) {
    throw new Error("Standing interaction authorization schema or kind is invalid");
  }
  if (typeof value.authorizationId !== "string" || !SAFE_ID.test(value.authorizationId)) {
    throw new Error("Standing interaction authorization id is invalid");
  }
  if (!["active", "stale"].includes(value.status)) throw new Error("Standing interaction authorization status is invalid");
  const scope = normalizeScopeForComparison(value.scope);
  const scopeDigest = digest(scope);
  if (value.scopeDigest !== scopeDigest) throw new Error("Standing interaction authorization scope digest does not match");
  const issuedAt = validateTimestamp(value.issuedAt, "Standing interaction authorization issuedAt");
  const expiresAt = validateTimestamp(value.expiresAt, "Standing interaction authorization expiresAt", { nullable: true });
  if (value.autoRenewable !== true || value.source !== "user-standing-directive" || value.technicalGateOnly !== true) {
    throw new Error("Standing interaction authorization is not an explicit bounded directive");
  }
  return {
    ...value,
    scope,
    scopeDigest,
    issuedAt,
    expiresAt
  };
}

function hold(request, reason, materialChanges = []) {
  return {
    ok: false,
    decision: "requires-user",
    reason,
    requestDigest: request.requestDigest,
    scopeDigest: request.scopeDigest,
    requiredAuthority: "user-standing-directive",
    materialChanges,
    hold: {
      schemaVersion: INTERACTION_AUTHORIZATION_SCHEMA_VERSION,
      id: `interaction-hold-${request.requestDigest.slice(0, 24)}`,
      dedupeKey: request.dedupeKey,
      repeat: false,
      message: "One user authorization is required for this exact material scope; reuse this HOLD instead of asking again."
    },
    authorityClass: INTERACTION_AUTHORITY_CLASS,
    technicalGatesRequired: true
  };
}

export function decideInteractionAuthorization({
  request,
  standingAuthorization = null,
  staleReason = null,
  now = new Date()
} = {}) {
  if (!request || request.kind !== INTERACTION_REQUEST_KIND) throw new Error("A valid interaction request is required");
  const normalizedRequest = buildInteractionRequest({
    scope: request.scope,
    mode: request.mode,
    requiredScopeFields: request.requiredScopeFields
  });
  if (normalizedRequest.scopeDigest !== request.scopeDigest || normalizedRequest.requestDigest !== request.requestDigest) {
    throw new Error("Interaction request digest or scope binding changed");
  }
  const missing = missingRequiredScope(normalizedRequest.scope, normalizedRequest.requiredScopeFields);
  if (missing.length > 0) return hold(normalizedRequest, "incomplete-scope", missing.map((field) => ({ field })));
  if (normalizedRequest.mode === "strict") return hold(normalizedRequest, "strict-mode");
  if (standingAuthorization === null) return hold(normalizedRequest, "missing-standing-directive");
  const standing = validateStandingInteractionAuthorization(standingAuthorization);
  const comparison = compareInteractionScopes(standing.scope, normalizedRequest.scope);
  if (!comparison.same) return hold(normalizedRequest, "material-scope-change", comparison.materialChanges);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("Interaction decision time is invalid");
  const expired = standing.expiresAt !== null && Date.parse(standing.expiresAt) <= nowMs;
  const stale = standing.status === "stale" || expired || staleReason !== null;
  if (stale && (staleReason !== null && !FRESHNESS_REASONS.has(String(staleReason)))) {
    return hold(normalizedRequest, "unknown-stale-reason");
  }
  return {
    ok: true,
    decision: "auto-approved",
    reason: stale ? "stale-scope-refresh" : "standing-scope-match",
    renewed: stale,
    predecessorAuthorizationId: standing.authorizationId,
    requestDigest: normalizedRequest.requestDigest,
    scopeDigest: normalizedRequest.scopeDigest,
    authorityClass: INTERACTION_AUTHORITY_CLASS,
    technicalGatesRequired: true,
    suppressDuplicatePrompt: true,
    // This field is intentionally explicit so callers cannot mistake this
    // UX decision for an action-token or remote-authority grant.
    grantsActionAuthority: false
  };
}

export function buildInteractionAuthorizationReceipt({ request, decision, predecessor = null, createdAt = new Date() } = {}) {
  if (!request || request.kind !== INTERACTION_REQUEST_KIND) throw new Error("A valid interaction request is required");
  if (!decision || !["auto-approved", "requires-user"].includes(decision.decision)) {
    throw new Error("Interaction decision is invalid");
  }
  const normalizedRequest = buildInteractionRequest({
    scope: request.scope,
    mode: request.mode,
    requiredScopeFields: request.requiredScopeFields
  });
  if (normalizedRequest.requestDigest !== request.requestDigest) throw new Error("Interaction receipt request binding changed");
  const receipt = {
    schemaVersion: INTERACTION_AUTHORIZATION_SCHEMA_VERSION,
    kind: INTERACTION_RECEIPT_KIND,
    authorityClass: INTERACTION_AUTHORITY_CLASS,
    requestDigest: request.requestDigest,
    scopeDigest: request.scopeDigest,
    decision: decision.decision,
    reason: decision.reason,
    renewed: decision.renewed === true,
    predecessorAuthorizationId: decision.predecessorAuthorizationId ?? predecessor?.authorizationId ?? null,
    grantsActionAuthority: false,
    technicalGatesRequired: true,
    createdAt: validateTimestamp(createdAt instanceof Date ? createdAt.toISOString() : createdAt, "Interaction receipt createdAt")
  };
  if (decision.decision === "requires-user") {
    receipt.hold = decision.hold ?? hold(normalizedRequest, decision.reason).hold;
  }
  return receipt;
}

export function dedupeInteractionRequest(request, priorReceipts = []) {
  if (!request || request.kind !== INTERACTION_REQUEST_KIND) throw new Error("A valid interaction request is required");
  if (!Array.isArray(priorReceipts)) throw new Error("Prior interaction receipts must be an array");
  const existing = priorReceipts.find((receipt) => receipt?.kind === INTERACTION_RECEIPT_KIND && receipt.requestDigest === request.requestDigest);
  return {
    deduplicated: Boolean(existing),
    requestDigest: request.requestDigest,
    existing: existing ?? null,
    nextPrompt: existing ? null : request
  };
}

export function interactionScopeFromRoute({
  repository,
  goal,
  scope = ["."],
  integrationTarget = null,
  protectedTarget = false,
  effectiveMode = "auto",
  template = null,
  mutationIntent = "unknown"
} = {}) {
  return normalizeInteractionScope({
    repository: normalizeString(repository, "Route repository"),
    goalDigest: digest({ goal: normalizeString(goal, "Route goal") }),
    dataScope: normalizeStringArray(scope, "Route scope"),
    sideEffectKinds: template ? [template] : [],
    target: integrationTarget,
    safetyConstraints: {
      effectiveMode,
      protectedTarget: protectedTarget === true,
      mutationIntent
    }
  });
}

export function freshnessOnlyReason(value) {
  return FRESHNESS_REASONS.has(String(value ?? ""));
}

