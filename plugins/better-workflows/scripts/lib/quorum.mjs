import { createPublicKey, verify as verifySignature } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { canonicalJson, digestObject } from "./core.mjs";

export const QUORUM_POLICY_ID = "agent-review-quorum-v1";
export const QUORUM_MANIFEST_KIND = "quorum-manifest-v1";
export const QUORUM_EVIDENCE_KIND = "agent-review-quorum";
export const QUORUM_IDENTITY_REGISTRY_KIND = "agent-review-identity-registry-v1";
export const QUORUM_MAX_WINDOW_MS = 30 * 60 * 1000;
export const QUORUM_ROLES = Object.freeze([
  "security-architect",
  "implementation-architect",
  "adversarial-reviewer",
  "operator-ux-reviewer",
  "rollout-reviewer"
]);

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{40}$/;
const PROVIDER_FAMILY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const VERDICTS = new Set(["PASS", "BLOCK", "INCONCLUSIVE"]);
const ROUTES = new Set(["ordinary", "host-trusted"]);
const MANIFEST_KEYS = Object.freeze([
  "base",
  "blockers",
  "changedPaths",
  "contractDigest",
  "dissent",
  "dossierDigest",
  "expiresAt",
  "head",
  "identityRegistryDigest",
  "instructionDigest",
  "issuedAt",
  "kind",
  "manifestDigest",
  "mergeBase",
  "policyDigest",
  "policyId",
  "receipts",
  "reportDigest",
  "repository",
  "reviewPackageDigest",
  "reviewPackageId",
  "roleAssignmentDigest",
  "roleAssignments",
  "routing",
  "schemaVersion",
  "sourceBindingDigest",
  "sourceSentinelDigest",
  "templateDigest",
  "runId"
]);
const ASSIGNMENT_KEYS = Object.freeze([
  "identityId",
  "keyId",
  "model",
  "provider",
  "providerFamily",
  "publicKey",
  "role"
]);
const RECEIPT_KEYS = Object.freeze([
  "reviewBinding",
  "dependencies",
  "evidenceDigest",
  "executionId",
  "expiresAt",
  "identityId",
  "issuedAt",
  "keyId",
  "model",
  "provider",
  "providerFamily",
  "publicKey",
  "role",
  "signature",
  "verdict"
]);
const REVIEW_BINDING_KEYS = Object.freeze([
  "base",
  "contractDigest",
  "dossierDigest",
  "head",
  "identityRegistryDigest",
  "instructionDigest",
  "mergeBase",
  "repository",
  "reviewPackageDigest",
  "reviewPackageId",
  "runId",
  "sourceBindingDigest",
  "sourceSentinelDigest",
  "templateDigest"
]);
const IDENTITY_REGISTRY_KEYS = Object.freeze(["entries", "kind", "registryId", "schemaVersion"]);

const HIGH_RISK_PATTERNS = Object.freeze([
  /^\.github\/workflows\//,
  /^plugins\/better-workflows\/scripts\/lib\/git\.mjs$/,
  /^plugins\/better-workflows\/scripts\/(?:lib\/)?(?:attestations|core|evidence|graph|host-bundle|host-trust|providers|quorum|review|review-policy|routing|sbw|self-improve|self-improve-handoff|self-improve-replay|standing-consent)\.mjs$/,
  /^plugins\/better-workflows\/config\/(?:evidence-contracts-v1|entrypoint-catalog|.*(?:host-bundle|identity|quorum|routing|trust).*?)\.json$/,
  /^plugins\/better-workflows\/templates\/.+\.json$/,
  /^plugins\/better-workflows\/(?:\.codex-plugin|skills\/better-workflows)\//
]);

export const QUORUM_POLICY_DIGEST = digestObject({
  policyId: QUORUM_POLICY_ID,
  roles: QUORUM_ROLES,
  maxWindowMs: QUORUM_MAX_WINDOW_MS,
  minimumProviderFamilies: 3,
  maximumRolesPerProviderFamily: 2,
  securityRolesMustDiffer: true
});

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error(`${label} fields do not match the ${QUORUM_POLICY_ID} contract`);
  }
}

export function validateIdentityRegistry(registry) {
  exactKeys(registry, IDENTITY_REGISTRY_KEYS, "Quorum identity registry");
  if (registry.schemaVersion !== 1 || registry.kind !== QUORUM_IDENTITY_REGISTRY_KIND) {
    throw new Error("Quorum identity registry identity is invalid");
  }
  requiredString(registry.registryId, "identity registry id", SAFE_ID);
  if (!Array.isArray(registry.entries) || registry.entries.length !== QUORUM_ROLES.length) {
    throw new Error(`Quorum identity registry requires exactly ${QUORUM_ROLES.length} entries`);
  }
  const normalized = registry.entries.map((entry) => {
    exactKeys(entry, ASSIGNMENT_KEYS, "Quorum identity registry entry");
    requiredString(entry.role, "registry role", SAFE_ID);
    if (!QUORUM_ROLES.includes(entry.role)) throw new Error(`Unknown quorum registry role: ${entry.role}`);
    requiredString(entry.identityId, "registry identityId", SAFE_ID);
    requiredString(entry.keyId, "registry keyId", SAFE_ID);
    requiredString(entry.provider, "registry provider", SAFE_ID);
    requiredString(entry.providerFamily, "registry providerFamily", PROVIDER_FAMILY);
    requiredString(entry.model, "registry model");
    requiredString(entry.publicKey, "registry publicKey");
    return { ...entry };
  }).sort((left, right) => left.role.localeCompare(right.role) || left.keyId.localeCompare(right.keyId));
  if (new Set(normalized.map((entry) => entry.role)).size !== normalized.length ||
      !QUORUM_ROLES.every((role) => normalized.some((entry) => entry.role === role))) {
    throw new Error("Quorum identity registry must cover every role");
  }
  if (new Set(normalized.map((entry) => entry.identityId)).size !== normalized.length ||
      new Set(normalized.map((entry) => entry.keyId)).size !== normalized.length ||
      new Set(normalized.map((entry) => entry.publicKey)).size !== normalized.length) {
    throw new Error("Quorum identity registry identities, keys, and public keys must be unique");
  }
  return { ...registry, entries: normalized };
}

function requiredString(value, field, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new Error(`Quorum ${field} is invalid`);
  }
  return value;
}

function requiredDigest(value, field) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`Quorum ${field} must be a SHA-256 digest`);
  return value;
}

function requiredRevision(value, field) {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error(`Quorum ${field} must be a full commit SHA`);
  return value;
}

function parseTime(value, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`Quorum ${field} must be an ISO timestamp`);
  return Date.parse(value);
}

function canonicalWithout(value, field) {
  const copy = structuredClone(value);
  delete copy[field];
  return copy;
}

function canonicalManifestIdentity(value) {
  const copy = structuredClone(value);
  delete copy.manifestDigest;
  delete copy.reportDigest;
  return copy;
}

function configuredIdentityRegistryPath() {
  // The registry is an operator-provisioned input, deliberately outside the
  // checked-out repository. A PR must not be able to add or replace its own
  // trust material; absent or unreadable registry state fails closed.
  const candidate = process.env.SBW_QUORUM_IDENTITY_REGISTRY;
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return null;
  const resolved = path.resolve(candidate);
  const relative = path.relative(process.cwd(), resolved);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return null;
  try {
    const info = lstatSync(resolved);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    return resolved;
  } catch {
    return null;
  }
}

export function loadConfiguredIdentityRegistry() {
  const registryPath = configuredIdentityRegistryPath();
  if (!registryPath) return null;
  try {
    return validateIdentityRegistry(JSON.parse(readFileSync(registryPath, "utf8")));
  } catch {
    return null;
  }
}

function verifyReceiptSignature(receipt) {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(receipt.publicKey, "base64"),
      format: "der",
      type: "spki"
    });
    return verifySignature(
      null,
      Buffer.from(canonicalJson(canonicalWithout(receipt, "signature")), "utf8"),
      publicKey,
      Buffer.from(receipt.signature, "base64")
    );
  } catch {
    return false;
  }
}

function normalizePath(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
    throw new Error("Quorum changed path is not a safe repository-relative path");
  }
  return value;
}

function changedPathsFromManifest(manifest) {
  if (!Array.isArray(manifest.changedPaths)) throw new Error("Quorum changedPaths must be an array");
  const paths = [];
  for (const item of manifest.changedPaths) {
    if (typeof item === "string") paths.push(normalizePath(item));
    else if (item && typeof item === "object") {
      if (typeof item.path === "string") paths.push(normalizePath(item.path));
      if (typeof item.oldPath === "string") paths.push(normalizePath(item.oldPath));
    } else {
      throw new Error("Quorum changedPaths entries must be strings or path objects");
    }
  }
  if (paths.length === 0) throw new Error("Quorum changedPaths must not be empty");
  return [...new Set(paths)].sort();
}

export function changedPathsFromDiffManifest(diffManifest) {
  if (!diffManifest || typeof diffManifest !== "object" || !Array.isArray(diffManifest.files)) {
    throw new Error("Quorum review package diffManifest is invalid");
  }
  return changedPathsFromManifest({
    changedPaths: diffManifest.files.map((entry) => ({
      path: entry?.path,
      ...(entry?.oldPath ? { oldPath: entry.oldPath } : {})
    }))
  });
}

export function classifyTrustTier(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { tier: "unknown", highRiskPaths: [], reasons: ["changed-paths-unavailable"] };
  }
  try {
    const paths = changedPaths.flatMap((item) => {
      if (typeof item === "string") return [normalizePath(item)];
      if (!item || typeof item !== "object") throw new Error("invalid-path-entry");
      return [
        ...(item.path ? [normalizePath(item.path)] : []),
        ...(item.oldPath ? [normalizePath(item.oldPath)] : [])
      ];
    });
    if (paths.length === 0) return { tier: "unknown", highRiskPaths: [], reasons: ["changed-paths-unavailable"] };
    const highRiskPaths = [...new Set(paths.filter((value) => HIGH_RISK_PATTERNS.some((pattern) => pattern.test(value))))].sort();
    return highRiskPaths.length > 0
      ? { tier: "host-trusted", highRiskPaths, reasons: ["high-risk-authority-surface"] }
      : { tier: "ordinary", highRiskPaths: [], reasons: [] };
  } catch (error) {
    return { tier: "unknown", highRiskPaths: [], reasons: [error.message] };
  }
}

function validateAssignments(assignments, identityRegistry) {
  if (!Array.isArray(assignments) || assignments.length !== QUORUM_ROLES.length) {
    throw new Error(`Quorum requires exactly ${QUORUM_ROLES.length} role assignments`);
  }
  const normalized = assignments.map((assignment) => {
    exactKeys(assignment, ASSIGNMENT_KEYS, "Quorum role assignment");
    requiredString(assignment.role, "assignment role", SAFE_ID);
    if (!QUORUM_ROLES.includes(assignment.role)) throw new Error(`Unknown quorum role: ${assignment.role}`);
    requiredString(assignment.identityId, "assignment identityId", SAFE_ID);
    requiredString(assignment.keyId, "assignment keyId", SAFE_ID);
    requiredString(assignment.provider, "assignment provider", SAFE_ID);
    requiredString(assignment.providerFamily, "assignment providerFamily", PROVIDER_FAMILY);
    requiredString(assignment.model, "assignment model");
    requiredString(assignment.publicKey, "assignment publicKey");
    return { ...assignment };
  }).sort((left, right) => left.role.localeCompare(right.role));
  if (new Set(normalized.map((item) => item.role)).size !== QUORUM_ROLES.length) throw new Error("Quorum role assignments must contain each role exactly once");
  if (new Set(normalized.map((item) => item.identityId)).size !== normalized.length) throw new Error("Quorum role identities must be unique");
  if (new Set(normalized.map((item) => item.keyId)).size !== normalized.length) throw new Error("Quorum role keys must be unique");
  if (new Set(normalized.map((item) => item.publicKey)).size !== normalized.length) throw new Error("Quorum role public keys must be unique");
  const registry = validateIdentityRegistry(identityRegistry);
  const registryEntries = new Map(registry.entries.map((entry) => [
    `${entry.role}\0${entry.identityId}\0${entry.keyId}\0${entry.publicKey}`,
    entry
  ]));
  for (const assignment of normalized) {
    const key = `${assignment.role}\0${assignment.identityId}\0${assignment.keyId}\0${assignment.publicKey}`;
    const trusted = registryEntries.get(key);
    if (!trusted || ["provider", "providerFamily", "model"].some((field) => trusted[field] !== assignment[field])) {
      throw new Error(`Quorum role assignment ${assignment.role} is not present in the trusted identity registry`);
    }
  }
  return normalized;
}

function validateDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== ["commandsDigest", "commonDependencyDigest", "evidenceDigest"].sort().join("\0")) {
    throw new Error("Quorum receipt dependencies are invalid");
  }
  for (const field of ["commandsDigest", "commonDependencyDigest", "evidenceDigest"]) requiredDigest(value[field], `receipt dependencies.${field}`);
  return value;
}

function validateReviewBinding(binding, manifest, role) {
  exactKeys(binding, REVIEW_BINDING_KEYS, `Quorum receipt ${role} review binding`);
  for (const field of REVIEW_BINDING_KEYS) {
    if (binding[field] !== manifest[field]) {
      throw new Error(`Quorum receipt ${role} is not bound to the reviewed manifest ${field}`);
    }
  }
  return binding;
}

function validateReceipts(receipts, assignments, manifest, nowMs, manifestIssuedMs, manifestExpiresMs, revokedIdentityIds = []) {
  if (!Array.isArray(receipts) || receipts.length !== QUORUM_ROLES.length) throw new Error("Quorum requires exactly five receipts");
  const revoked = new Set(revokedIdentityIds);
  const assignmentMap = new Map(assignments.map((item) => [item.role, item]));
  const normalized = receipts.map((receipt) => {
    exactKeys(receipt, RECEIPT_KEYS, "Quorum receipt");
    validateReviewBinding(receipt.reviewBinding, manifest, receipt.role ?? "unknown");
    requiredString(receipt.role, "receipt role", SAFE_ID);
    if (!QUORUM_ROLES.includes(receipt.role)) throw new Error(`Unknown quorum receipt role: ${receipt.role}`);
    requiredString(receipt.executionId, "receipt executionId", SAFE_ID);
    requiredString(receipt.identityId, "receipt identityId", SAFE_ID);
    if (revoked.has(receipt.identityId)) throw new Error(`Quorum identity is revoked: ${receipt.identityId}`);
    requiredString(receipt.keyId, "receipt keyId", SAFE_ID);
    requiredString(receipt.provider, "receipt provider", SAFE_ID);
    requiredString(receipt.providerFamily, "receipt providerFamily", PROVIDER_FAMILY);
    requiredString(receipt.model, "receipt model");
    requiredString(receipt.publicKey, "receipt publicKey");
    requiredString(receipt.signature, "receipt signature");
    requiredDigest(receipt.evidenceDigest, "receipt evidenceDigest");
    if (!VERDICTS.has(receipt.verdict)) throw new Error(`Invalid quorum verdict: ${receipt.verdict}`);
    validateDependencies(receipt.dependencies);
    const issuedMs = parseTime(receipt.issuedAt, "receipt issuedAt");
    const expiresMs = parseTime(receipt.expiresAt, "receipt expiresAt");
    if (issuedMs > nowMs + 5 * 60 * 1000 || expiresMs <= nowMs || expiresMs <= issuedMs || expiresMs - issuedMs > QUORUM_MAX_WINDOW_MS) {
      throw new Error(`Quorum receipt ${receipt.role} is stale or outside the bounded window`);
    }
    if (issuedMs < manifestIssuedMs || expiresMs > manifestExpiresMs) throw new Error(`Quorum receipt ${receipt.role} exceeds the manifest window`);
    const assignment = assignmentMap.get(receipt.role);
    if (!assignment || assignment.identityId !== receipt.identityId || assignment.keyId !== receipt.keyId ||
        assignment.provider !== receipt.provider || assignment.providerFamily !== receipt.providerFamily ||
        assignment.model !== receipt.model || assignment.publicKey !== receipt.publicKey) {
      throw new Error(`Quorum receipt ${receipt.role} does not match its role assignment`);
    }
    if (!verifyReceiptSignature(receipt)) throw new Error(`Quorum receipt ${receipt.role} signature is invalid`);
    return { ...receipt };
  }).sort((left, right) => left.role.localeCompare(right.role));
  if (new Set(normalized.map((item) => item.role)).size !== QUORUM_ROLES.length) throw new Error("Quorum receipts must contain each role exactly once");
  if (new Set(normalized.map((item) => item.executionId)).size !== normalized.length) throw new Error("Quorum receipt execution identities must be unique");
  const familyCounts = new Map();
  for (const receipt of normalized) familyCounts.set(receipt.providerFamily, (familyCounts.get(receipt.providerFamily) ?? 0) + 1);
  if (familyCounts.size < 3) throw new Error("Quorum requires at least three provider families");
  if ([...familyCounts.values()].some((count) => count > 2)) throw new Error("A provider family cannot fill more than two quorum roles");
  const securityFamily = normalized.find((item) => item.role === "security-architect")?.providerFamily;
  const adversarialFamily = normalized.find((item) => item.role === "adversarial-reviewer")?.providerFamily;
  if (!securityFamily || securityFamily === adversarialFamily) throw new Error("Security and adversarial quorum roles must use different provider families");
  const securityProvider = normalized.find((item) => item.role === "security-architect")?.provider;
  const adversarialProvider = normalized.find((item) => item.role === "adversarial-reviewer")?.provider;
  if (!securityProvider || securityProvider === adversarialProvider) throw new Error("Security and adversarial quorum roles must use different providers");
  return normalized;
}

export function validateQuorumManifest(manifest, { now = new Date(), allowHostTrustedRoute = false, expected = {}, revokedIdentityIds = [], identityRegistry = null } = {}) {
  exactKeys(manifest, MANIFEST_KEYS, "Quorum manifest");
  if (manifest.schemaVersion !== 1 || manifest.kind !== QUORUM_MANIFEST_KIND || manifest.policyId !== QUORUM_POLICY_ID) {
    throw new Error("Quorum manifest identity is invalid");
  }
  for (const field of [
    "runId",
    "repository",
    "base",
    "head",
    "mergeBase",
    "identityRegistryDigest",
    "sourceBindingDigest",
    "sourceSentinelDigest",
    "contractDigest",
    "templateDigest",
    "reviewPackageId",
    "reviewPackageDigest",
    "instructionDigest",
    "dossierDigest",
    "policyDigest"
  ]) {
    if (expected[field] !== undefined && expected[field] !== null && manifest[field] !== expected[field]) {
      throw new Error(`Quorum manifest binding does not match ${field}`);
    }
  }
  requiredString(manifest.runId, "runId", SAFE_ID);
  requiredString(manifest.repository, "repository");
  requiredRevision(manifest.base, "base");
  requiredRevision(manifest.head, "head");
  requiredRevision(manifest.mergeBase, "mergeBase");
  for (const field of ["sourceBindingDigest", "sourceSentinelDigest", "contractDigest", "templateDigest", "reviewPackageDigest", "instructionDigest", "dossierDigest", "policyDigest", "identityRegistryDigest", "roleAssignmentDigest", "reportDigest"]) {
    requiredDigest(manifest[field], field);
  }
  requiredString(manifest.reviewPackageId, "reviewPackageId", SAFE_ID);
  if (!ROUTES.has(manifest.routing)) throw new Error(`Unknown quorum routing tier: ${manifest.routing}`);
  const issuedMs = parseTime(manifest.issuedAt, "issuedAt");
  const expiresMs = parseTime(manifest.expiresAt, "expiresAt");
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs) || issuedMs > nowMs + 5 * 60 * 1000 || expiresMs <= nowMs || expiresMs <= issuedMs || expiresMs - issuedMs > QUORUM_MAX_WINDOW_MS) {
    throw new Error("Quorum manifest is stale or outside the bounded window");
  }
  const trustedRegistry = validateIdentityRegistry(identityRegistry ?? loadConfiguredIdentityRegistry());
  if (manifest.identityRegistryDigest !== digestObject(trustedRegistry)) {
    throw new Error("Quorum identity registry digest mismatch");
  }
  const assignments = validateAssignments(manifest.roleAssignments, trustedRegistry);
  if (manifest.roleAssignmentDigest !== digestObject(assignments)) throw new Error("Quorum role assignment digest mismatch");
  const changedPaths = changedPathsFromManifest(manifest);
  for (const field of ["blockers", "dissent"]) {
    if (!Array.isArray(manifest[field]) || manifest[field].some((item) => typeof item !== "string" || !item)) {
      throw new Error(`Quorum manifest ${field} must be a string array`);
    }
  }
  if (expected.changedPaths !== undefined && digestObject(changedPaths) !== digestObject([...expected.changedPaths].sort())) {
    throw new Error("Quorum manifest changed paths do not match the immutable review package");
  }
  const routing = classifyTrustTier(changedPaths);
  if (routing.tier === "unknown") throw new Error(`Quorum routing is inconclusive: ${routing.reasons.join(", ")}`);
  if (manifest.routing !== routing.tier) throw new Error(`Quorum routing tier does not match changed paths: expected ${routing.tier}`);
  if (routing.tier === "host-trusted" && !allowHostTrustedRoute) throw new Error("High-risk changes require the host-trusted review path");
  if (manifest.policyDigest !== QUORUM_POLICY_DIGEST) throw new Error("Quorum policy digest is not the installed policy");
  const receipts = validateReceipts(manifest.receipts, assignments, manifest, nowMs, issuedMs, expiresMs, revokedIdentityIds);
  const manifestDigest = digestObject(canonicalManifestIdentity(manifest));
  if (manifest.manifestDigest !== manifestDigest) throw new Error("Quorum manifest digest mismatch");
  const roleStatuses = receipts.map((receipt) => ({ role: receipt.role, verdict: receipt.verdict, executionId: receipt.executionId }));
  const blockers = [
    ...(receipts.filter((receipt) => receipt.verdict !== "PASS").map((receipt) => `${receipt.role}:${receipt.verdict}`)),
    ...(manifest.blockers ?? []),
    ...(manifest.dissent ?? [])
  ];
  const reportDigest = digestObject({
    manifestDigest,
    routing: manifest.routing,
    roleStatuses,
    blockers: [...new Set(blockers)].sort()
  });
  if (manifest.reportDigest !== reportDigest) throw new Error("Quorum report digest mismatch");
  const verdict = blockers.length === 0 && receipts.every((receipt) => receipt.verdict === "PASS") ? "PASS" : "HOLD";
  return {
    ok: verdict === "PASS" && manifest.routing === "ordinary",
    verdict,
    manifestDigest,
    reportDigest,
    routing,
    roleStatuses,
    receiptDigests: receipts.map((receipt) => digestObject(canonicalWithout(receipt, "signature"))),
    blockers: [...new Set(blockers)].sort(),
    dissent: [...(manifest.dissent ?? [])]
  };
}

export function reduceQuorum(manifest, options = {}) {
  try {
    return validateQuorumManifest(manifest, options);
  } catch (error) {
    const manifestDigest = manifest && typeof manifest === "object" ? digestObject(canonicalManifestIdentity(manifest)) : null;
    return {
      ok: false,
      verdict: "HOLD",
      manifestDigest,
      reportDigest: null,
      routing: { tier: "unknown", highRiskPaths: [], reasons: [error.message] },
      roleStatuses: [],
      receiptDigests: [],
      blockers: [error.message],
      dissent: []
    };
  }
}

export function buildQuorumEvidencePayload(manifest, result) {
  if (!result?.ok || result.verdict !== "PASS") throw new Error("Only a passing quorum can become typed evidence");
  return {
    decision: { policyId: QUORUM_POLICY_ID, verdict: result.verdict },
    manifest,
    manifestDigest: result.manifestDigest,
    routing: manifest.routing,
    roleReceipts: result.receiptDigests,
    blockers: result.blockers,
    reportDigest: result.reportDigest
  };
}

export function validateQuorumEvidencePayload(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Quorum evidence payload is required");
  const required = ["decision", "manifest", "manifestDigest", "routing", "roleReceipts", "blockers", "reportDigest"];
  if (required.some((field) => !(field in payload))) throw new Error("Quorum evidence payload is incomplete");
  const result = validateQuorumManifest(payload.manifest, options);
  if (!result.ok || result.verdict !== "PASS") throw new Error(`Quorum evidence is not a PASS: ${result.blockers.join(", ")}`);
  if (payload.decision?.policyId !== QUORUM_POLICY_ID || payload.decision?.verdict !== "PASS" ||
      payload.manifestDigest !== result.manifestDigest || payload.reportDigest !== result.reportDigest ||
      payload.routing !== payload.manifest.routing || JSON.stringify(payload.roleReceipts) !== JSON.stringify(result.receiptDigests) ||
      digestObject(payload.blockers) !== digestObject(result.blockers)) {
    throw new Error("Quorum evidence payload is not bound to the verified manifest");
  }
  return result;
}

export function isQuorumEvidence(record, options = {}) {
  if (record?.schemaVersion !== 2 || record?.kind !== QUORUM_EVIDENCE_KIND || record?.stale === true) return false;
  try {
    validateQuorumEvidencePayload(record.receipt?.payload, options);
    return true;
  } catch {
    return false;
  }
}
