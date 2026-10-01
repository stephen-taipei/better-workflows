// SPDX-License-Identifier: AGPL-3.0-only
// Pure inspection only. The caller supplies the policy and the exact request;
// this module cannot establish their independent origin or grant release power.
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { canonicalJson, digestObject, sha256 } from "./core.mjs";

export const RIGHTS_CLEARANCE_POLICY_KIND = "BetterWorkflowsRightsTrustPolicyV1";
export const RIGHTS_CLEARANCE_ENVELOPE_KIND = "BetterWorkflowsRightsClearanceV1";
export const RIGHTS_CLEARANCE_PURPOSE = "legal-rights-clearance-v1";
export const RIGHTS_CLEARANCE_AUDIENCE = "better-workflows-v5-distribution";

const DOMAIN = Buffer.from("BetterWorkflowsRightsClearanceV1\0", "utf8");
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPOSITORY_ID = /^[1-9][0-9]{0,19}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const UTC_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*[\u0000-\u001f\u007f]).+$/;
const SCOPES = new Set(["public-source", "github-release"]);
const POLICY_KEYS = ["schemaVersion", "kind", "purpose", "audience", "targetRepositoryId", "productReleaseScopeDigest", "policyEpoch", "validFrom", "validUntil", "keys", "revokedEnvelopeSha256", "revokedRecordSha256"];
const KEY_KEYS = ["keyId", "algorithm", "role", "status", "publicKeySpkiBase64"];
const ENVELOPE_KEYS = ["payload", "signature"];
const EXPECTED_KEYS = ["targetRepositoryId", "operationId", "productReleaseScopeDigest", "distributionScope", "sourceRevision", "publicSourceRevision", "productVersion", "artifactSha256", "requestDigest"];
const PAYLOAD_KEYS = ["schemaVersion", "kind", "purpose", "audience", "targetRepositoryId", "operationId", "policyEpoch", "signerKeyId", "distributionScopes", "sourceRevision", "publicSourceRevision", "productVersion", "productReleaseScopeDigest", "requestDigest", "sourceFilesSha256", "sourceTreeSha256", "inventorySha256", "artifactSha256", "issuedAt", "expiresAt", "files"];
const FILE_KEYS = ["path", "sha256", "mode", "inventoryRecordSha256", "privateRecordSha256", "decision"];

export class RightsClearanceHoldError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RightsClearanceHoldError";
    this.code = code;
    this.status = "HOLD";
  }
}

function hold(code, message) {
  throw new RightsClearanceHoldError(code, message);
}

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, keys, label) {
  if (!plain(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    hold("ERIGHTS_SCHEMA", `${label} has an unexpected shape`);
  }
}

function match(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) hold("ERIGHTS_SCHEMA", `${label} is invalid`);
  return value;
}

function validTime(value, label) {
  match(value, UTC_TIME, label);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) hold("ERIGHTS_SCHEMA", `${label} is not an exact UTC timestamp`);
  return time;
}

function base64(value, label, maxBytes) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    hold("ERIGHTS_SCHEMA", `${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== value) {
    hold("ERIGHTS_SCHEMA", `${label} is not canonical base64`);
  }
  return bytes;
}

function canonicalBytes(bytes, maxBytes, label) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
    hold("ERIGHTS_BYTES", `${label} bytes are missing or outside the size limit`);
  }
  if (typeof SharedArrayBuffer !== "undefined" && bytes.buffer instanceof SharedArrayBuffer) {
    hold("ERIGHTS_BYTES", `${label} cannot use shared mutable bytes`);
  }
  const raw = Buffer.from(bytes);
  let value;
  try { value = JSON.parse(raw.toString("utf8")); } catch {
    hold("ERIGHTS_JSON", `${label} is not JSON`);
  }
  if (!plain(value) || !Buffer.from(canonicalJson(value), "utf8").equals(raw)) {
    hold("ERIGHTS_JSON", `${label} is not canonical JSON`);
  }
  return { value, raw };
}

function objectSnapshot(value, maxBytes, label) {
  if (!plain(value)) hold("ERIGHTS_SCHEMA", `${label} must be a plain object`);
  let json;
  try { json = canonicalJson(value); } catch { hold("ERIGHTS_SCHEMA", `${label} cannot be serialized`); }
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > maxBytes) {
    hold("ERIGHTS_SCHEMA", `${label} exceeds the size limit`);
  }
  let snapshot;
  try { snapshot = JSON.parse(json); } catch { hold("ERIGHTS_SCHEMA", `${label} is not JSON data`); }
  if (!plain(snapshot)) hold("ERIGHTS_SCHEMA", `${label} is not a JSON object`);
  return snapshot;
}

function orderedUnique(values, pattern, label, max = 4096) {
  if (!Array.isArray(values) || values.length > max) hold("ERIGHTS_SCHEMA", `${label} is invalid`);
  let previous = null;
  for (const value of values) {
    match(value, pattern, label);
    if (previous !== null && previous >= value) hold("ERIGHTS_SCHEMA", `${label} is not strictly ordered and unique`);
    previous = value;
  }
  return values;
}

function safePath(value) {
  return typeof value === "string" && SAFE_PATH.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function validatePolicy(policy) {
  exact(policy, POLICY_KEYS, "rights policy");
  if (policy.schemaVersion !== 1 || policy.kind !== RIGHTS_CLEARANCE_POLICY_KIND ||
      policy.purpose !== RIGHTS_CLEARANCE_PURPOSE || policy.audience !== RIGHTS_CLEARANCE_AUDIENCE) {
    hold("ERIGHTS_POLICY", "Rights policy identity is invalid");
  }
  match(policy.targetRepositoryId, REPOSITORY_ID, "target repository ID");
  match(policy.productReleaseScopeDigest, SHA256, "product release scope digest");
  match(policy.policyEpoch, SHA256, "policy epoch");
  if (validTime(policy.validFrom, "policy.validFrom") >= validTime(policy.validUntil, "policy.validUntil")) {
    hold("ERIGHTS_POLICY", "Rights policy validity interval is invalid");
  }
  if (!Array.isArray(policy.keys) || policy.keys.length < 1 || policy.keys.length > 16) {
    hold("ERIGHTS_POLICY", "Rights policy has no bounded key set");
  }
  let previousKey = null;
  for (const key of policy.keys) {
    exact(key, KEY_KEYS, "rights policy key");
    match(key.keyId, SAFE_ID, "key ID");
    if (previousKey !== null && previousKey >= key.keyId) hold("ERIGHTS_POLICY", "Rights policy keys are not strictly ordered and unique");
    previousKey = key.keyId;
    if (key.algorithm !== "ed25519" || key.role !== "legal-rights-clearance" || !["active", "revoked"].includes(key.status)) {
      hold("ERIGHTS_POLICY", "Rights policy key has the wrong role or status");
    }
    const publicKeyBytes = base64(key.publicKeySpkiBase64, "policy public key", 1024);
    try {
      const publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
      if (publicKey.asymmetricKeyType !== "ed25519" ||
          !publicKey.export({ format: "der", type: "spki" }).equals(publicKeyBytes)) {
        hold("ERIGHTS_POLICY", "Rights policy key is not canonical Ed25519 SPKI");
      }
    } catch (error) {
      if (error instanceof RightsClearanceHoldError) throw error;
      hold("ERIGHTS_POLICY", "Rights policy public key is invalid");
    }
  }
  orderedUnique(policy.revokedEnvelopeSha256, SHA256, "revoked envelope digests");
  orderedUnique(policy.revokedRecordSha256, SHA256, "revoked record digests");
}

function validateRequest(request) {
  if (!plain(request) || request.schemaVersion !== 1 || request.kind !== "better-workflows-rights-clearance-request" ||
      request.authority !== "none" || request.rightsReady !== false || !Array.isArray(request.files) ||
      request.files.length < 1 || request.files.length > 4096 || request.fileCount !== request.files.length) {
    hold("ERIGHTS_REQUEST", "Exact rights request is invalid");
  }
  const { requestDigest, ...payload } = request;
  if (!SHA256.test(requestDigest ?? "") || digestObject(payload) !== requestDigest) {
    hold("ERIGHTS_REQUEST", "Rights request digest is invalid");
  }
  for (const key of ["sourceFilesSha256", "sourceTreeSha256", "inventorySha256", "artifactSha256"]) {
    match(request[key], SHA256, `request.${key}`);
  }
  match(request.sourceRevision, SHA40, "request.sourceRevision");
  match(request.productVersion, SEMVER, "request.productVersion");
  let previous = null;
  for (const file of request.files) {
    if (!plain(file) || !safePath(file.path) || !SHA256.test(file.sha256 ?? "") ||
        !SHA256.test(file.inventoryRecordSha256 ?? "") || ![0o644, 0o755].includes(file.mode)) {
      hold("ERIGHTS_REQUEST", "Rights request contains an invalid file");
    }
    if (previous !== null && previous >= file.path) hold("ERIGHTS_REQUEST", "Rights request paths are not strictly ordered and unique");
    previous = file.path;
  }
}

function validatePayload(payload, request, policy, expected, nowMs) {
  exact(payload, PAYLOAD_KEYS, "clearance payload");
  if (payload.schemaVersion !== 1 || payload.kind !== RIGHTS_CLEARANCE_ENVELOPE_KIND ||
      payload.purpose !== RIGHTS_CLEARANCE_PURPOSE || payload.audience !== RIGHTS_CLEARANCE_AUDIENCE) {
    hold("ERIGHTS_ENVELOPE", "Clearance envelope identity is invalid");
  }
  match(payload.targetRepositoryId, REPOSITORY_ID, "payload.targetRepositoryId");
  match(payload.operationId, SAFE_ID, "payload.operationId");
  match(payload.signerKeyId, SAFE_ID, "payload.signerKeyId");
  match(payload.sourceRevision, SHA40, "payload.sourceRevision");
  match(payload.publicSourceRevision, SHA40, "payload.publicSourceRevision");
  match(payload.productVersion, SEMVER, "payload.productVersion");
  for (const key of ["policyEpoch", "productReleaseScopeDigest", "requestDigest", "sourceFilesSha256", "sourceTreeSha256", "inventorySha256", "artifactSha256"]) {
    match(payload[key], SHA256, `payload.${key}`);
  }
  if (payload.targetRepositoryId !== expected.targetRepositoryId ||
      payload.targetRepositoryId !== policy.targetRepositoryId ||
      payload.operationId !== expected.operationId ||
      payload.policyEpoch !== policy.policyEpoch ||
      payload.productReleaseScopeDigest !== expected.productReleaseScopeDigest ||
      payload.productReleaseScopeDigest !== policy.productReleaseScopeDigest ||
      payload.sourceRevision !== request.sourceRevision || payload.sourceRevision !== expected.sourceRevision ||
      payload.publicSourceRevision !== expected.publicSourceRevision ||
      payload.productVersion !== request.productVersion || payload.productVersion !== expected.productVersion ||
      payload.requestDigest !== request.requestDigest || payload.requestDigest !== expected.requestDigest ||
      payload.sourceFilesSha256 !== request.sourceFilesSha256 ||
      payload.sourceTreeSha256 !== request.sourceTreeSha256 ||
      payload.inventorySha256 !== request.inventorySha256 ||
      payload.artifactSha256 !== request.artifactSha256 || payload.artifactSha256 !== expected.artifactSha256) {
    hold("ERIGHTS_BINDING", "Clearance differs from the independently expected release inputs");
  }
  orderedUnique(payload.distributionScopes, /^(?:public-source|github-release)$/, "distribution scopes", 2);
  if (!SCOPES.has(expected.distributionScope) || !payload.distributionScopes.includes(expected.distributionScope)) {
    hold("ERIGHTS_SCOPE", "Clearance does not cover the expected distribution scope");
  }
  const issuedAt = validTime(payload.issuedAt, "payload.issuedAt");
  const expiresAt = validTime(payload.expiresAt, "payload.expiresAt");
  const policyFrom = validTime(policy.validFrom, "policy.validFrom");
  const policyUntil = validTime(policy.validUntil, "policy.validUntil");
  if (issuedAt < policyFrom || issuedAt >= expiresAt || expiresAt > policyUntil ||
      nowMs < issuedAt || nowMs >= expiresAt || nowMs < policyFrom || nowMs >= policyUntil) {
    hold("ERIGHTS_EXPIRED", "Rights policy or clearance is not current");
  }
  if (!Array.isArray(payload.files) || payload.files.length !== request.files.length) {
    hold("ERIGHTS_COVERAGE", "Clearance does not cover the full release universe");
  }
  for (let index = 0; index < request.files.length; index += 1) {
    const file = payload.files[index];
    const source = request.files[index];
    exact(file, FILE_KEYS, `clearance file ${index}`);
    if (file.path !== source.path || file.sha256 !== source.sha256 || file.mode !== source.mode ||
        file.inventoryRecordSha256 !== source.inventoryRecordSha256 || file.decision !== "include" ||
        !SHA256.test(file.privateRecordSha256 ?? "")) {
      hold("ERIGHTS_COVERAGE", `Clearance file ${index} differs from the full release universe`);
    }
  }
}

/**
 * Inspect raw, canonical policy and envelope bytes against an exact request.
 * The trusted controller must independently source the policy, rederive the
 * request, verify that publicSourceRevision has the same exact Git tree as
 * sourceRevision, establish legal authority, and hold the publication credential.
 */
export function inspectRightsClearanceEnvelopeV1({
  policyBytes,
  envelopeBytes,
  request,
  privateRecords,
  expected,
  nowMs
} = {}) {
  // Copy the raw trust inputs before touching caller objects with accessors.
  // The same private snapshots feed parsing, revocation and receipt digests.
  const policyInput = canonicalBytes(policyBytes, 64 * 1024, "rights policy");
  const envelopeInput = canonicalBytes(envelopeBytes, 2 * 1024 * 1024, "rights envelope");
  const expectedSnapshot = objectSnapshot(expected, 16 * 1024, "independent expectation");
  const requestSnapshot = objectSnapshot(request, 4 * 1024 * 1024, "exact rights request");
  exact(expectedSnapshot, EXPECTED_KEYS, "independent expectation");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    hold("ERIGHTS_EXPECTED", "Independent expectation and time are required");
  }
  for (const [key, pattern] of [["targetRepositoryId", REPOSITORY_ID], ["operationId", SAFE_ID],
    ["productReleaseScopeDigest", SHA256], ["sourceRevision", SHA40], ["publicSourceRevision", SHA40], ["productVersion", SEMVER],
    ["artifactSha256", SHA256], ["requestDigest", SHA256]]) {
    match(expectedSnapshot[key], pattern, `expected.${key}`);
  }
  if (!SCOPES.has(expectedSnapshot.distributionScope)) hold("ERIGHTS_EXPECTED", "Expected distribution scope is invalid");
  validateRequest(requestSnapshot);
  const policy = policyInput.value;
  const envelope = envelopeInput.value;
  validatePolicy(policy);
  exact(envelope, ENVELOPE_KEYS, "rights envelope");
  const payload = envelope.payload;
  validatePayload(payload, requestSnapshot, policy, expectedSnapshot, nowMs);
  const envelopeDigest = sha256(envelopeInput.raw);
  if (policy.revokedEnvelopeSha256.includes(envelopeDigest)) hold("ERIGHTS_REVOKED", "Rights clearance was revoked");
  const key = policy.keys.find((entry) => entry.keyId === payload.signerKeyId);
  if (!key || key.status !== "active") hold("ERIGHTS_KEY", "Rights clearance signer is absent or revoked");
  const signature = base64(envelope.signature, "clearance signature", 128);
  if (signature.length !== 64) hold("ERIGHTS_SIGNATURE", "Ed25519 signature length is invalid");
  let signatureValid = false;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key.publicKeySpkiBase64, "base64"), format: "der", type: "spki" });
    signatureValid = verifySignature(null, Buffer.concat([DOMAIN, Buffer.from(canonicalJson(payload), "utf8")]), publicKey, signature);
  } catch { signatureValid = false; }
  if (!signatureValid) hold("ERIGHTS_SIGNATURE", "Rights clearance signature is invalid");
  if (!(privateRecords instanceof Map)) hold("ERIGHTS_RECORDS", "Private rights record bytes are missing");
  // Bypass overridable Map subclass methods and copy record bytes exactly once.
  // No caller accessor is read again after this snapshot.
  const recordsSnapshot = new Map();
  let snapshotBytes = 0;
  try {
    for (const [digest, recordBytes] of Map.prototype.entries.call(privateRecords)) {
      if (!SHA256.test(digest ?? "") || !(recordBytes instanceof Uint8Array) ||
          recordBytes.byteLength < 1 || recordBytes.byteLength > 16 * 1024 * 1024 ||
          (typeof SharedArrayBuffer !== "undefined" && recordBytes.buffer instanceof SharedArrayBuffer)) {
        hold("ERIGHTS_RECORDS", "Private rights record set contains an invalid entry");
      }
      snapshotBytes += recordBytes.byteLength;
      if (recordsSnapshot.size >= requestSnapshot.files.length || snapshotBytes > 64 * 1024 * 1024) {
        hold("ERIGHTS_RECORDS", "Private rights record set exceeds the count or byte limit");
      }
      recordsSnapshot.set(digest, Buffer.from(recordBytes));
    }
  } catch (error) {
    if (error instanceof RightsClearanceHoldError) throw error;
    hold("ERIGHTS_RECORDS", "Private rights record set cannot be snapshotted");
  }
  const requiredDigests = new Set(payload.files.map((file) => file.privateRecordSha256));
  if (recordsSnapshot.size !== requiredDigests.size) hold("ERIGHTS_RECORDS", "Private rights record set has missing or extra entries");
  for (const digest of requiredDigests) {
    if (policy.revokedRecordSha256.includes(digest)) hold("ERIGHTS_REVOKED", "A private rights record was revoked");
    const bytes = recordsSnapshot.get(digest);
    if (!bytes || sha256(bytes) !== digest) {
      hold("ERIGHTS_RECORDS", "Private rights record bytes differ from signed digest");
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "BetterWorkflowsRightsClearanceInspectionV1",
    signatureVerified: true,
    requestFilesBound: true,
    privateRecordBytesBound: true,
    fileCount: payload.files.length,
    privateRecordCount: requiredDigests.size,
    signerKeyId: key.keyId,
    policySha256: sha256(policyInput.raw),
    envelopeSha256: envelopeDigest,
    requestDigest: requestSnapshot.requestDigest,
    sourceRevision: requestSnapshot.sourceRevision,
    publicSourceRevision: payload.publicSourceRevision,
    targetRepositoryId: payload.targetRepositoryId,
    authority: "none",
    releaseEligible: false
  });
}
