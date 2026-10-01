// SPDX-License-Identifier: AGPL-3.0-only
// Protected formal verification replays a signed, raw-byte-bound closure.
// Its result is an observation; publication still needs independent admission.
import { constants as fsConstants } from "node:fs";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { promisify, types as utilTypes } from "node:util";
import { canonicalJson } from "./core.mjs";
import { FORMAL_FULL_PROFILE } from "./formal-operation.mjs";
import { copyBoundedBytesV1, snapshotJsonDataV1 } from "./private-input-snapshot-v1.mjs";
import { parseStrictJsonV1 } from "./strict-json-v1.mjs";
import { replayFullFormalCompletionArtifactsV1 } from "./formal-completion-replay-v1.mjs";
import { evaluateFormalAttemptBudget } from "./formal-evaluator.mjs";

export const FORMAL_PROTECTED_POLICY_PATH = "/private/etc/better-workflows/formal-execution-policy-v1.json";
export const FORMAL_PROTECTED_ARTIFACT_ROOT = "/private/var/db/better-workflows/formal-attestations";
export const FORMAL_PROTECTED_POLICY_KIND = "FormalExecutionTrustPolicyV1";
export const FORMAL_PROTECTED_PAYLOAD_KIND = "FormalExecutionAttestationPayloadV1";
export const FORMAL_PROTECTED_BUNDLE_KIND = "FormalExecutionBundleV1";
export const FORMAL_PROTECTED_PURPOSE = "formal-execution-v1";
export const FORMAL_PROTECTED_AUDIENCE = "better-workflows-v5-release";
export const FORMAL_PROTECTED_REPOSITORY = "github:github.com/stephen-taipei/better-workflows";

const SHA256 = /^[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const REQUIRED_ROLES = Object.freeze([
  "aggregate", "commit-intent", "completion", "ledger-export", "node22-observations",
  "node24-observations", "provisional", "release-intent", "release-record", "suite-manifest"
]);
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_BUNDLE_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 24 * 1024 * 1024;
const POLICY_KEYS = ["schemaVersion", "kind", "issuer", "purpose", "audience", "repositoryIdentity", "profileId", "observerImageSha256", "ledgerEpoch", "keys", "runtimeLanes"];
const KEY_KEYS = ["keyId", "algorithm", "purpose", "publicKey", "status"];
const LANE_KEYS = ["id", "nodeVersion", "executableSha256"];
const PAYLOAD_KEYS = ["schemaVersion", "kind", "issuer", "keyId", "purpose", "audience", "repositoryIdentity", "expectedHead", "expectedBase", "profileId", "observerImageSha256", "ledgerEpoch", "terminalSequence", "suiteManifestSha256", "runtimeLanes", "artifactManifestSha256", "qualificationStatus", "operationCompletion", "cleanupConfirmed"];
const BUNDLE_KEYS = ["schemaVersion", "kind", "payload", "signature", "artifacts"];
const ARTIFACT_KEYS = ["role", "file", "sha256", "byteLength"];

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const execFileAsync = promisify(execFile);
const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const INSPECTION_REQUEST_FIELDS = Object.freeze(["policy", "bundle", "artifactBytes", "expectedHead", "expectedBase"]);

function hasDataDescriptorValue(descriptor) {
  return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function captureInspectionRequest(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    fail("EFORMAL_PROTECTED_SCHEMA", "Formal inspection request is invalid");
  }
  const captured = Object.create(null);
  for (const key of INSPECTION_REQUEST_FIELDS) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch {
      fail("EFORMAL_PROTECTED_SCHEMA", "Formal inspection request is invalid");
    }
    if (!hasDataDescriptorValue(descriptor)) {
      fail("EFORMAL_PROTECTED_SCHEMA", "Formal inspection request is invalid");
    }
    Object.defineProperty(captured, key, { value: descriptor.value, enumerable: true });
  }
  if (!isPlain(value)) fail("EFORMAL_PROTECTED_SCHEMA", "Formal inspection request is invalid");
  return captured;
}

function captureInspectionJsonData(value, maxBytes, code, message) {
  try {
    const snapshot = snapshotJsonDataV1(value, { maxBytes });
    return parseStrictJsonV1(JSON.stringify(snapshot), { maxBytes });
  } catch {
    fail(code, message);
  }
}

function captureInspectionArtifactBytes(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || !isPlain(value)) {
    fail("EFORMAL_PROTECTED_ARTIFACT", "Formal artifact bytes cannot be inspected safely");
  }
  const roles = [...REQUIRED_ROLES].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== roles.length || keys.some((key, index) => key !== roles[index])) {
    fail("EFORMAL_PROTECTED_ARTIFACT", "Formal artifact bytes are missing or unexpected");
  }

  const captured = Object.create(null);
  let totalBytes = 0;
  for (const role of roles) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, role); } catch {
      fail("EFORMAL_PROTECTED_ARTIFACT", "Formal artifact bytes cannot be inspected safely");
    }
    if (!hasDataDescriptorValue(descriptor)) {
      fail("EFORMAL_PROTECTED_ARTIFACT", "Formal artifact bytes cannot be inspected safely");
    }
    const remainingBytes = MAX_TOTAL_ARTIFACT_BYTES - totalBytes;
    if (remainingBytes < 1) {
      fail("EFORMAL_PROTECTED_ARTIFACT", "Formal artifact closure exceeds its byte bound");
    }
    let bytes;
    try {
      bytes = copyBoundedBytesV1(descriptor.value, {
        maxBytes: Math.min(MAX_ARTIFACT_BYTES, remainingBytes)
      });
    } catch {
      fail("EFORMAL_PROTECTED_ARTIFACT", "Formal artifact bytes cannot be inspected safely");
    }
    totalBytes += bytes.byteLength;
    Object.defineProperty(captured, role, { value: bytes, enumerable: true });
  }
  return captured;
}

export class FormalProtectedHoldError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FormalProtectedHoldError";
    this.code = code;
    this.status = "HOLD";
  }
}

function fail(code, message) { throw new FormalProtectedHoldError(code, message); }
function exact(value, keys, label) {
  if (!isPlain(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail("EFORMAL_PROTECTED_SCHEMA", `${label} has an unexpected shape`);
  }
}
function string(value, label, pattern = SAFE_ID, max = 256) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || !pattern.test(value)) {
    fail("EFORMAL_PROTECTED_SCHEMA", `${label} is invalid`);
  }
  return value;
}
function base64(value, label, max = 8192) {
  string(value, label, BASE64, max);
  if (value.length % 4 !== 0 || Buffer.from(value, "base64").toString("base64") !== value) {
    fail("EFORMAL_PROTECTED_SCHEMA", `${label} is not canonical base64`);
  }
  return value;
}
function lane(value, index) {
  exact(value, LANE_KEYS, `runtimeLanes[${index}]`);
  string(value.id, `runtimeLanes[${index}].id`);
  string(value.nodeVersion, `runtimeLanes[${index}].nodeVersion`, /^\d+\.\d+\.\d+$/, 32);
  string(value.executableSha256, `runtimeLanes[${index}].executableSha256`, SHA256, 64);
  const expected = FORMAL_FULL_PROFILE.lanes[index];
  if (!expected || value.id !== expected.id || value.nodeVersion !== expected.nodeVersion) {
    fail("EFORMAL_PROTECTED_PROFILE", "Runtime lane order or version differs from the full formal profile");
  }
}
function runtimeLanes(value) {
  if (!Array.isArray(value) || value.length !== FORMAL_FULL_PROFILE.lanes.length) {
    fail("EFORMAL_PROTECTED_PROFILE", "The full formal runtime lanes are incomplete");
  }
  value.forEach(lane);
}

/** Pure trust material validation. It is not an authority-bearing API. */
export function validateFormalProtectedPolicyV1(value) {
  exact(value, POLICY_KEYS, "formal trust policy");
  if (value.schemaVersion !== 1 || value.kind !== FORMAL_PROTECTED_POLICY_KIND ||
      value.purpose !== FORMAL_PROTECTED_PURPOSE || value.audience !== FORMAL_PROTECTED_AUDIENCE ||
      value.profileId !== FORMAL_FULL_PROFILE.id) {
    fail("EFORMAL_PROTECTED_POLICY", "Formal trust policy version, purpose, audience or profile is invalid");
  }
  string(value.issuer, "policy.issuer");
  string(value.repositoryIdentity, "policy.repositoryIdentity", /^github:github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 256);
  if (value.repositoryIdentity !== FORMAL_PROTECTED_REPOSITORY) {
    fail("EFORMAL_PROTECTED_POLICY", "Formal trust policy targets another repository");
  }
  string(value.observerImageSha256, "policy.observerImageSha256", SHA256, 64);
  string(value.ledgerEpoch, "policy.ledgerEpoch", SHA256, 64);
  runtimeLanes(value.runtimeLanes);
  if (!Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 16) {
    fail("EFORMAL_PROTECTED_POLICY", "Formal trust policy key set is invalid");
  }
  const ids = new Set();
  for (const key of value.keys) {
    exact(key, KEY_KEYS, "formal trust key");
    string(key.keyId, "keyId");
    if (ids.has(key.keyId) || key.algorithm !== "ed25519" || key.purpose !== FORMAL_PROTECTED_PURPOSE ||
        !["active", "revoked"].includes(key.status)) {
      fail("EFORMAL_PROTECTED_POLICY", "Formal trust key is duplicated or has the wrong algorithm or purpose");
    }
    ids.add(key.keyId);
    base64(key.publicKey, "publicKey");
  }
  return value;
}

function validatePayload(value) {
  exact(value, PAYLOAD_KEYS, "formal attestation payload");
  if (value.schemaVersion !== 1 || value.kind !== FORMAL_PROTECTED_PAYLOAD_KIND ||
      value.purpose !== FORMAL_PROTECTED_PURPOSE || value.audience !== FORMAL_PROTECTED_AUDIENCE ||
      value.profileId !== FORMAL_FULL_PROFILE.id) {
    fail("EFORMAL_PROTECTED_SCHEMA", "Formal attestation payload version, purpose, audience or profile is invalid");
  }
  for (const key of ["issuer", "keyId", "repositoryIdentity"]) string(value[key], `payload.${key}`);
  for (const key of ["expectedHead", "expectedBase"]) string(value[key], `payload.${key}`, SHA40, 40);
  for (const key of ["observerImageSha256", "ledgerEpoch", "suiteManifestSha256", "artifactManifestSha256"]) {
    string(value[key], `payload.${key}`, SHA256, 64);
  }
  // V1 has a HEAD-only artifact namespace. A second attempt would overwrite
  // the first signed closure, so replacement needs a per-attempt V2 schema.
  if (value.terminalSequence !== 1) {
    fail("EFORMAL_PROTECTED_REPLACEMENT_UNAVAILABLE", "Formal replacement requires an immutable per-attempt bundle schema");
  }
  if (!["passed", "blocked"].includes(value.qualificationStatus) ||
      !["OBSERVED", "UNKNOWN"].includes(value.operationCompletion) || typeof value.cleanupConfirmed !== "boolean") {
    fail("EFORMAL_PROTECTED_SCHEMA", "Formal attestation terminal claims are invalid");
  }
  runtimeLanes(value.runtimeLanes);
  return value;
}

function validateArtifacts(value, head) {
  if (!Array.isArray(value) || value.length !== REQUIRED_ROLES.length) {
    fail("EFORMAL_PROTECTED_BUNDLE", "Formal artifact closure is incomplete");
  }
  const required = [...REQUIRED_ROLES].sort();
  const roles = value.map((entry) => entry?.role);
  if (JSON.stringify(roles) !== JSON.stringify(required)) {
    fail("EFORMAL_PROTECTED_BUNDLE", "Formal artifact roles must be complete and ordered");
  }
  let total = 0;
  for (const item of value) {
    exact(item, ARTIFACT_KEYS, "formal artifact record");
    if (item.file !== `${head}-${item.role}.json` || !Number.isSafeInteger(item.byteLength) ||
        item.byteLength < 1 || item.byteLength > MAX_ARTIFACT_BYTES) {
      fail("EFORMAL_PROTECTED_BUNDLE", "Formal artifact filename or byte bound is invalid");
    }
    string(item.sha256, "artifact.sha256", SHA256, 64);
    total += item.byteLength;
  }
  if (total > MAX_TOTAL_ARTIFACT_BYTES) fail("EFORMAL_PROTECTED_BUNDLE", "Formal artifact closure exceeds its byte bound");
}

export function validateFormalProtectedBundleV1(value) {
  exact(value, BUNDLE_KEYS, "formal bundle");
  if (value.schemaVersion !== 1 || value.kind !== FORMAL_PROTECTED_BUNDLE_KIND) {
    fail("EFORMAL_PROTECTED_BUNDLE", "Formal bundle version or kind is invalid");
  }
  const payload = validatePayload(value.payload);
  base64(value.signature, "bundle.signature", 1024);
  validateArtifacts(value.artifacts, payload.expectedHead);
  if (hash(Buffer.from(canonicalJson(value.artifacts), "utf8")) !== payload.artifactManifestSha256) {
    fail("EFORMAL_PROTECTED_BUNDLE", "Formal artifact manifest digest differs from signed payload");
  }
  if (value.artifacts.find((item) => item.role === "suite-manifest")?.sha256 !== payload.suiteManifestSha256) {
    fail("EFORMAL_PROTECTED_BUNDLE", "Formal suite manifest digest differs from signed payload");
  }
  return value;
}

/** Verify the signature and exact bytes, then replay all ten artifact roles.
 * A complete result is a formal verification observation, never release PASS.
 */
export function inspectFormalProtectedBundleV1(request) {
  const input = captureInspectionRequest(request);
  const policy = captureInspectionJsonData(input.policy, MAX_POLICY_BYTES,
    "EFORMAL_PROTECTED_POLICY", "Formal trust policy cannot be inspected safely");
  const bundle = captureInspectionJsonData(input.bundle, MAX_BUNDLE_BYTES,
    "EFORMAL_PROTECTED_BUNDLE", "Formal bundle cannot be inspected safely");
  const artifactBytes = captureInspectionArtifactBytes(input.artifactBytes);
  const expectedHead = input.expectedHead;
  const expectedBase = input.expectedBase;

  validateFormalProtectedPolicyV1(policy);
  validateFormalProtectedBundleV1(bundle);
  string(expectedHead, "expectedHead", SHA40, 40);
  string(expectedBase, "expectedBase", SHA40, 40);
  const payload = bundle.payload;
  if (payload.expectedHead !== expectedHead || payload.expectedBase !== expectedBase ||
      payload.issuer !== policy.issuer || payload.repositoryIdentity !== policy.repositoryIdentity ||
      payload.profileId !== policy.profileId || payload.observerImageSha256 !== policy.observerImageSha256 ||
      payload.ledgerEpoch !== policy.ledgerEpoch || !same(payload.runtimeLanes, policy.runtimeLanes)) {
    fail("EFORMAL_PROTECTED_BINDING", "Formal attestation differs from independently installed policy or candidate");
  }
  const key = policy.keys.find((entry) => entry.keyId === payload.keyId);
  if (!key || key.status !== "active") fail("EFORMAL_PROTECTED_KEY", "Formal observer key is absent or revoked");
  let valid = false;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
    valid = publicKey.asymmetricKeyType === "ed25519" && verifySignature(
      null, Buffer.from(canonicalJson(payload), "utf8"), publicKey, Buffer.from(bundle.signature, "base64")
    );
  } catch { valid = false; }
  if (!valid) fail("EFORMAL_PROTECTED_SIGNATURE", "Formal observer signature is invalid");
  if (!isPlain(artifactBytes) || Object.keys(artifactBytes).sort().join("\0") !== bundle.artifacts.map((entry) => entry.role).join("\0")) {
    fail("EFORMAL_PROTECTED_ARTIFACT", "Formal artifact bytes are missing or unexpected");
  }
  for (const item of bundle.artifacts) {
    const bytes = artifactBytes[item.role];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== item.byteLength || hash(bytes) !== item.sha256) {
      fail("EFORMAL_PROTECTED_ARTIFACT", `Formal artifact ${item.role} differs from the signed raw-byte digest`);
    }
  }
  // Legacy phase digests bind serializedReceipt bytes, including key order.
  // Parse the signed role bytes strictly; do not canonicalize their contents.
  const records = Object.create(null);
  for (const item of bundle.artifacts) {
    let receipt;
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(artifactBytes[item.role]);
      receipt = parseStrictJsonV1(text, { maxBytes: MAX_ARTIFACT_BYTES });
    } catch { fail("EFORMAL_PROTECTED_JSON", `Formal artifact ${item.role} is not strict JSON`); }
    records[item.role] = { receipt, receiptDigest: item.sha256 };
  }
  let replay;
  try {
    const provisional = records.provisional.receipt;
    const completion = records.completion.receipt;
    if (!same(records["suite-manifest"].receipt, provisional?.suiteManifest) ||
        !same(records["node22-observations"].receipt, provisional?.lanes?.[0]) ||
        !same(records["node24-observations"].receipt, provisional?.lanes?.[1]) ||
        !same(provisional?.runtimeIdentities?.map(runtime => ({ id: runtime.laneId,
          nodeVersion: runtime.nodeVersion, executableSha256: runtime.executableSha256 })), payload.runtimeLanes)) {
      fail("EFORMAL_PROTECTED_REPLAY", "Formal lane or suite artifact differs from the bound provisional");
    }
    replay = replayFullFormalCompletionArtifactsV1(completion, {
      expectedHead, expectedBase, repositoryIdentity: policy.repositoryIdentity,
      ownerHome: completion?.context?.ownerHome, ledgerPath: completion?.context?.ledgerPath
    }, { provisional: records.provisional, aggregate: records.aggregate, ledger: records["ledger-export"],
      commitIntent: records["commit-intent"], releaseIntent: records["release-intent"], releaseRecord: records["release-record"] });
    if (replay.formalAttemptNumber !== payload.terminalSequence ||
        replay.qualificationStatus !== payload.qualificationStatus ||
        replay.operationCompletion !== payload.operationCompletion || payload.cleanupConfirmed !== true) {
      fail("EFORMAL_PROTECTED_REPLAY", "Formal signed terminal claims differ from the complete replay");
    }
  } catch (error) {
    if (error instanceof FormalProtectedHoldError) throw error;
    fail("EFORMAL_PROTECTED_REPLAY", "Formal artifact closure is incomplete or inconsistent");
  }
  return Object.freeze({ schemaVersion: 1, kind: "FormalProtectedInspectionV1", authenticated: true,
    rawBytesBound: true, portableReplayComplete: true, authority: "none", admission: "HOLD", releaseEligible: false,
    reasonCode: "FORMAL_VERIFICATION_OBSERVATION_ONLY", expectedHead, expectedBase,
    formalAttemptId: replay.formalAttemptId, formalAttemptNumber: replay.formalAttemptNumber,
    receiptDigest: replay.receiptDigest, ledgerDigest: replay.ledgerDigest,
    qualificationStatus: replay.qualificationStatus, failureClassification: replay.failureClassification === null ? null :
      Object.freeze(replay.failureClassification), operationCompletion: replay.operationCompletion, cleanupConfirmed: true,
    policySha256: hash(Buffer.from(canonicalJson(policy), "utf8")),
    bundleSha256: hash(Buffer.from(canonicalJson(bundle), "utf8")) });
}

export function parseFormalProtectedCanonicalJsonBytes(bytes, label = "formal protected artifact") {
  if (!(bytes instanceof Uint8Array)) fail("EFORMAL_PROTECTED_JSON", `${label} must be raw bytes`);
  const text = Buffer.from(bytes).toString("utf8");
  let value;
  try { value = JSON.parse(text); } catch { fail("EFORMAL_PROTECTED_JSON", `${label} is not JSON`); }
  if (!Buffer.from(canonicalJson(value), "utf8").equals(Buffer.from(bytes))) {
    fail("EFORMAL_PROTECTED_JSON", `${label} is not canonical JSON`);
  }
  return value;
}
function parseBoundedFormalProtectedCanonicalJsonBytes(bytes, label, maxBytes) {
  let stable, value;
  try {
    stable = copyBoundedBytesV1(bytes, { maxBytes });
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stable);
    value = parseStrictJsonV1(text, { maxBytes });
  } catch { fail("EFORMAL_PROTECTED_JSON", `${label} is not JSON`); }
  if (!Buffer.from(canonicalJson(value), "utf8").equals(Buffer.from(stable))) {
    fail("EFORMAL_PROTECTED_JSON", `${label} is not canonical JSON`);
  }
  return value;
}
/** Pure parser for macOS `ls -lde` output; unexpected formatting fails closed. */
export function validateFormalProtectedAclListingV1(listing) {
  if (typeof listing !== "string") fail("EFORMAL_PROTECTED_ACL", "Formal protected path ACL cannot be inspected");
  const lines = listing.trimEnd().split("\n");
  const mode = lines[0]?.split(/\s+/, 1)[0];
  if (lines.length !== 1 || !/^[d-][rwxStTs-]{9}@?$/.test(mode ?? "")) {
    fail("EFORMAL_PROTECTED_ACL", "Formal protected path has an ACL or unreadable ACL state");
  }
}
async function assertNoMacosAcl(target) {
  try {
    const { stdout } = await execFileAsync("/bin/ls", ["-lde", target], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, maxBuffer: 64 * 1024, timeout: 5000
    });
    validateFormalProtectedAclListingV1(stdout);
  } catch (error) {
    if (error instanceof FormalProtectedHoldError) throw error;
    fail("EFORMAL_PROTECTED_ACL", "Formal protected path ACL cannot be inspected");
  }
}
function statSame(left, right) {
  return ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"].every((key) => left[key] === right[key]);
}
async function rootChain(root, mode) {
  let current = root;
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
        (current === root && (info.mode & 0o777) !== mode)) {
      fail("EFORMAL_PROTECTED_PATH", "Formal trust or artifact root is not administrator protected");
    }
    await assertNoMacosAcl(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
async function readProtected(target, root, maxBytes, rootMode, fileMode) {
  if (path.dirname(target) !== root || path.resolve(target) !== target) {
    fail("EFORMAL_PROTECTED_PATH", "Formal artifact path escapes its fixed root");
  }
  let before, rootBefore;
  try {
    await rootChain(root, rootMode);
    rootBefore = await lstat(root);
    before = await lstat(target);
  } catch (error) {
    if (error instanceof FormalProtectedHoldError) throw error;
    fail(error?.code === "ENOENT" ? "EFORMAL_PROTECTED_MISSING" : "EFORMAL_PROTECTED_PATH", "Formal protected artifact is unavailable");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.nlink !== 1 ||
      (before.mode & 0o777) !== fileMode || before.size < 1 || before.size > maxBytes) {
    fail("EFORMAL_PROTECTED_PATH", "Formal protected artifact has unsafe ownership or size");
  }
  await assertNoMacosAcl(target);
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!statSame(before, opened)) fail("EFORMAL_PROTECTED_PATH", "Formal protected artifact changed before read");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) fail("EFORMAL_PROTECTED_READ", "Formal protected artifact has an incomplete read");
      offset += bytesRead;
    }
    if (!statSame(opened, await handle.stat()) || !statSame(opened, await lstat(target)) ||
        !statSame(rootBefore, await lstat(root))) {
      fail("EFORMAL_PROTECTED_PATH", "Formal protected artifact changed during read");
    }
    await assertNoMacosAcl(target);
    await rootChain(root, rootMode);
    return bytes;
  } catch (error) {
    if (error instanceof FormalProtectedHoldError) throw error;
    fail("EFORMAL_PROTECTED_READ", "Formal protected artifact could not be read safely");
  } finally { await handle?.close().catch(() => {}); }
}

/** Fixed-path production inspection. No policy, key, clock, verifier or raw
 * ledger can be injected by a caller. It cannot grant release authority.
 */
export async function inspectInstalledFormalProtectedBundleV1(options = {}) {
  exact(options, ["expectedHead", "expectedBase"], "formal inspection request");
  string(options.expectedHead, "expectedHead", SHA40, 40);
  string(options.expectedBase, "expectedBase", SHA40, 40);
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail("EFORMAL_PROTECTED_PLATFORM", "This protected formal policy is not installed for the current platform");
  }
  const policy = parseBoundedFormalProtectedCanonicalJsonBytes(await readProtected(FORMAL_PROTECTED_POLICY_PATH,
    path.dirname(FORMAL_PROTECTED_POLICY_PATH), MAX_POLICY_BYTES, 0o755, 0o644), "formal policy", MAX_POLICY_BYTES);
  const bundlePath = path.join(FORMAL_PROTECTED_ARTIFACT_ROOT, `${options.expectedHead}-bundle.json`);
  const bundle = parseBoundedFormalProtectedCanonicalJsonBytes(await readProtected(bundlePath, FORMAL_PROTECTED_ARTIFACT_ROOT,
    MAX_BUNDLE_BYTES, 0o700, 0o600), "formal bundle", MAX_BUNDLE_BYTES);
  validateFormalProtectedBundleV1(bundle);
  const artifactBytes = {};
  for (const item of bundle.artifacts) {
    artifactBytes[item.role] = await readProtected(path.join(FORMAL_PROTECTED_ARTIFACT_ROOT, item.file),
      FORMAL_PROTECTED_ARTIFACT_ROOT, MAX_ARTIFACT_BYTES, 0o700, 0o600);
  }
  return inspectFormalProtectedBundleV1({ policy, bundle, artifactBytes,
    expectedHead: options.expectedHead, expectedBase: options.expectedBase });
}

// V2 is a separate installation and immutable two-attempt namespace. V1 stays
// unchanged; no V1 policy, signature or HEAD-only artifact is promoted to V2.
export const FORMAL_PROTECTED_POLICY_PATH_V2 = "/private/etc/better-workflows/formal-execution-policy-v2.json";
export const FORMAL_PROTECTED_ARTIFACT_ROOT_V2 = "/private/var/db/better-workflows/formal-attestations-v2";
export const FORMAL_PROTECTED_POLICY_KIND_V2 = "FormalExecutionTrustPolicyV2";
export const FORMAL_PROTECTED_PAYLOAD_KIND_V2 = "FormalExecutionAttestationPayloadV2";
export const FORMAL_PROTECTED_BUNDLE_KIND_V2 = "FormalExecutionBundleV2";
const V2_POLICY_KEYS = [...POLICY_KEYS, "publicTarget", "expectedBase", "executionSourceRoot", "suiteIdentity", "runtimePaths"];
const V2_PAYLOAD_KEYS = [...PAYLOAD_KEYS, "publicTarget", "predecessorBundleSha256", "replacementReason", "reservationSha256"];
const V2_LEDGER_KEYS = ["schemaVersion", "kind", "repository", "expectedHead", "expectedBase", "ledgerEpoch", "attempts"];
const V2_ATTEMPT_KEYS = ["terminalSequence", "reservationSha256", "bundleSha256", "status"];
const V2_RESERVATION_KEYS = ["schemaVersion", "kind", "repository", "expectedHead", "expectedBase", "ledgerEpoch", "terminalSequence", "predecessorBundleSha256", "replacementReason", "launchRoot"];
const V2_MAX_LEDGER_BYTES = 64 * 1024;
const absoluteV2 = value => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);

function captureV2Fields(value, fields, label) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || !isPlain(value)) {
    fail("EFORMAL_PROTECTED_SCHEMA", `${label} is invalid`);
  }
  const captured = Object.create(null);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!hasDataDescriptorValue(descriptor)) fail("EFORMAL_PROTECTED_SCHEMA", `${label} is invalid`);
    captured[key] = descriptor.value;
  }
  return captured;
}

// Same repository name/id and sourceRevision/sourceRef representation used by
// RuntimeQualificationTargetPolicyV2. Installation must establish publicness.
function publicTargetV2(value) {
  exact(value, ["repository", "sourceRevision", "sourceRef"], "formal public target");
  exact(value.repository, ["name", "id"], "formal public repository");
  string(value.repository.name, "publicTarget.repository.name", /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/, 256);
  string(value.repository.id, "publicTarget.repository.id", /^[1-9][0-9]*$/, 32);
  string(value.sourceRevision, "publicTarget.sourceRevision", SHA40, 40);
  if (value.sourceRef !== "refs/heads/main") fail("EFORMAL_PROTECTED_POLICY", "Formal public target requires its exact main namespace");
}

export function validateFormalProtectedPolicyV2(value) {
  exact(value, V2_POLICY_KEYS, "formal V2 trust policy");
  if (value.schemaVersion !== 2 || value.kind !== FORMAL_PROTECTED_POLICY_KIND_V2 ||
      value.purpose !== FORMAL_PROTECTED_PURPOSE || value.audience !== FORMAL_PROTECTED_AUDIENCE ||
      value.profileId !== FORMAL_FULL_PROFILE.id) fail("EFORMAL_PROTECTED_POLICY", "Formal V2 policy version, purpose, audience or profile is invalid");
  publicTargetV2(value.publicTarget);
  if (value.repositoryIdentity !== `github:github.com/${value.publicTarget.repository.name}`) {
    fail("EFORMAL_PROTECTED_POLICY", "Formal execution source must be the approved public projection repository");
  }
  string(value.issuer, "policy.issuer");
  for (const key of ["observerImageSha256", "ledgerEpoch"]) string(value[key], `policy.${key}`, SHA256, 64);
  string(value.expectedBase, "policy.expectedBase", SHA40, 40);
  if (!absoluteV2(value.executionSourceRoot)) fail("EFORMAL_PROTECTED_POLICY", "Formal public execution root must be frozen");
  exact(value.suiteIdentity, ["uid", "gid", "home"], "formal suite identity");
  if (![value.suiteIdentity.uid, value.suiteIdentity.gid].every(id => Number.isSafeInteger(id) && id > 0) ||
      !absoluteV2(value.suiteIdentity.home) || value.suiteIdentity.home === "/") {
    fail("EFORMAL_PROTECTED_POLICY", "Formal suites require a frozen nonroot identity and home");
  }
  runtimeLanes(value.runtimeLanes);
  exact(value.runtimePaths, ["node22", "node24"], "formal V2 runtime paths");
  if (!Object.values(value.runtimePaths).every(absoluteV2) || value.runtimePaths.node22 === value.runtimePaths.node24) {
    fail("EFORMAL_PROTECTED_PROFILE", "Formal V2 runtime paths must be distinct and frozen");
  }
  if (!Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 16) fail("EFORMAL_PROTECTED_POLICY", "Formal V2 dedicated key set is invalid");
  const ids = new Set();
  for (const key of value.keys) {
    exact(key, KEY_KEYS, "formal V2 trust key");
    string(key.keyId, "keyId", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 64);
    if (ids.has(key.keyId) || key.algorithm !== "ed25519" || key.purpose !== FORMAL_PROTECTED_PURPOSE ||
        !["active", "revoked"].includes(key.status)) fail("EFORMAL_PROTECTED_POLICY", "Formal V2 key purpose, algorithm, status or identity is invalid");
    ids.add(key.keyId); base64(key.publicKey, "publicKey");
  }
  return value;
}

function validatePayloadV2(value) {
  exact(value, V2_PAYLOAD_KEYS, "formal V2 attestation payload");
  if (value.schemaVersion !== 2 || value.kind !== FORMAL_PROTECTED_PAYLOAD_KIND_V2 ||
      value.purpose !== FORMAL_PROTECTED_PURPOSE || value.audience !== FORMAL_PROTECTED_AUDIENCE ||
      value.profileId !== FORMAL_FULL_PROFILE.id || ![1, 2].includes(value.terminalSequence)) {
    fail("EFORMAL_PROTECTED_SCHEMA", "Formal V2 payload version, scope or attempt ceiling is invalid");
  }
  for (const key of ["issuer", "keyId", "repositoryIdentity"]) string(value[key], `payload.${key}`);
  for (const key of ["expectedHead", "expectedBase"]) string(value[key], `payload.${key}`, SHA40, 40);
  for (const key of ["observerImageSha256", "ledgerEpoch", "suiteManifestSha256", "artifactManifestSha256", "reservationSha256"]) string(value[key], `payload.${key}`, SHA256, 64);
  publicTargetV2(value.publicTarget); runtimeLanes(value.runtimeLanes);
  if (value.repositoryIdentity !== `github:github.com/${value.publicTarget.repository.name}` ||
      value.expectedHead !== value.publicTarget.sourceRevision || !["passed", "blocked"].includes(value.qualificationStatus) ||
      value.operationCompletion !== "OBSERVED" || value.cleanupConfirmed !== true) fail("EFORMAL_PROTECTED_SCHEMA", "Formal V2 public source or terminal claims are invalid");
  if (value.terminalSequence === 1) {
    if (value.predecessorBundleSha256 !== null || value.replacementReason !== null) fail("EFORMAL_PROTECTED_REPLACEMENT", "Formal V2 primary cannot claim a predecessor or replacement");
  } else {
    string(value.predecessorBundleSha256, "predecessorBundleSha256", SHA256, 64);
    string(value.replacementReason, "replacementReason");
  }
  return value;
}

export function validateFormalProtectedBundleV2(value) {
  exact(value, BUNDLE_KEYS, "formal V2 bundle");
  if (value.schemaVersion !== 2 || value.kind !== FORMAL_PROTECTED_BUNDLE_KIND_V2) fail("EFORMAL_PROTECTED_BUNDLE", "Formal V2 bundle version or kind is invalid");
  const payload = validatePayloadV2(value.payload);
  base64(value.signature, "bundle.signature", 1024);
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== REQUIRED_ROLES.length ||
      !same(value.artifacts.map(item => item?.role), [...REQUIRED_ROLES].sort())) fail("EFORMAL_PROTECTED_BUNDLE", "Formal V2 artifact roles must be complete and ordered");
  let total = 0;
  for (const item of value.artifacts) {
    exact(item, ARTIFACT_KEYS, "formal V2 artifact record");
    if (item.file !== `${payload.expectedHead}-attempt-${payload.terminalSequence}-${item.role}.json` ||
        !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > MAX_ARTIFACT_BYTES) fail("EFORMAL_PROTECTED_BUNDLE", "Formal V2 artifact namespace or byte bound is invalid");
    string(item.sha256, "artifact.sha256", SHA256, 64); total += item.byteLength;
  }
  if (total > MAX_TOTAL_ARTIFACT_BYTES || hash(Buffer.from(canonicalJson(value.artifacts))) !== payload.artifactManifestSha256 ||
      value.artifacts.find(item => item.role === "suite-manifest").sha256 !== payload.suiteManifestSha256) fail("EFORMAL_PROTECTED_BUNDLE", "Formal V2 artifact or suite manifest is not signed exactly");
  return value;
}

function parseV2Record(bytes, label, maxBytes) {
  let captured;
  try { captured = copyBoundedBytesV1(bytes, { maxBytes }); } catch { fail("EFORMAL_PROTECTED_JSON", `${label} exceeds its raw-byte bound`); }
  return { value: parseBoundedFormalProtectedCanonicalJsonBytes(captured, label, maxBytes), sha256: hash(captured) };
}

function captureV2Closure(value) {
  const input = captureV2Fields(value, ["bundle", "artifactBytes", "reservationBytes"], "formal V2 closure request");
  return { bundle: captureInspectionJsonData(input.bundle, MAX_BUNDLE_BYTES, "EFORMAL_PROTECTED_BUNDLE", "Formal V2 bundle cannot be inspected safely"),
    artifactBytes: captureInspectionArtifactBytes(input.artifactBytes),
    reservation: parseV2Record(input.reservationBytes, "formal V2 immutable reservation", V2_MAX_LEDGER_BYTES) };
}

function replayV2Execution(policy, artifactBytes, expectedHead, expectedBase, terminalSequence, launchRoot) {
  const records = Object.create(null);
  for (const role of REQUIRED_ROLES) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(artifactBytes[role]);
      records[role] = { receipt: parseStrictJsonV1(text, { maxBytes: MAX_ARTIFACT_BYTES }), receiptDigest: hash(artifactBytes[role]) };
    } catch { fail("EFORMAL_PROTECTED_JSON", `Formal V2 ${role} is not strict JSON`); }
  }
  try {
    const provisional = records.provisional.receipt, completion = records.completion.receipt;
    if (expectedHead !== policy.publicTarget.sourceRevision || expectedBase !== policy.expectedBase ||
        provisional?.repositoryRoot !== policy.executionSourceRoot || provisional?.cwd !== policy.executionSourceRoot ||
        completion?.context?.ownerHome !== policy.suiteIdentity.home || completion?.context?.slotIdentity?.uid !== policy.suiteIdentity.uid ||
        completion?.context?.launchRoot !== launchRoot ||
        !same(records["suite-manifest"].receipt, provisional?.suiteManifest) ||
        !same(records["node22-observations"].receipt, provisional?.lanes?.[0]) ||
        !same(records["node24-observations"].receipt, provisional?.lanes?.[1]) ||
        !same(provisional?.runtimeIdentities?.map(runtime => ({ id: runtime.laneId, nodeVersion: runtime.nodeVersion,
          executableSha256: runtime.executableSha256 })), policy.runtimeLanes) ||
        provisional?.runtimeIdentities?.some(runtime => runtime.path !== policy.runtimePaths[runtime.laneId])) {
      fail("EFORMAL_PROTECTED_REPLAY", "Formal V2 public execution, suite identity, runtime or role projection differs from installed policy");
    }
    const replay = replayFullFormalCompletionArtifactsV1(completion, { expectedHead, expectedBase,
      repositoryIdentity: policy.repositoryIdentity, ownerHome: policy.suiteIdentity.home, ledgerPath: completion.context.ledgerPath },
    { provisional: records.provisional, aggregate: records.aggregate, ledger: records["ledger-export"], commitIntent: records["commit-intent"],
      releaseIntent: records["release-intent"], releaseRecord: records["release-record"] });
    if (replay.formalAttemptNumber !== terminalSequence) fail("EFORMAL_PROTECTED_REPLAY", "Formal V2 local and protected attempt numbers differ");
    return { replay, records };
  } catch (error) {
    if (error instanceof FormalProtectedHoldError) throw error;
    fail("EFORMAL_PROTECTED_REPLAY", "Formal V2 closure is incomplete or inconsistent");
  }
}

/** Unsigned data verifier for the future protected executor. Caller data cannot
 * prove who captured it and cannot become signing or publication admission.
 */
export function inspectFormalProtectedExecutionArtifactsV2(request) {
  const input = captureV2Fields(request, ["policy", "artifactBytes", "expectedHead", "expectedBase", "terminalSequence", "launchRoot"], "formal V2 execution data request");
  const policy = captureInspectionJsonData(input.policy, MAX_POLICY_BYTES, "EFORMAL_PROTECTED_POLICY", "Formal V2 policy cannot be inspected safely");
  validateFormalProtectedPolicyV2(policy);
  if (![1, 2].includes(input.terminalSequence)) fail("EFORMAL_PROTECTED_REPLACEMENT", "Formal V2 exact-SHA budget is at most two attempts");
  const { replay } = replayV2Execution(policy, captureInspectionArtifactBytes(input.artifactBytes),
    input.expectedHead, input.expectedBase, input.terminalSequence, input.launchRoot);
  return Object.freeze({ ...replay, schemaVersion: 2, kind: "FormalProtectedExecutionDataObservationV2",
    authenticated: false, captureAuthenticated: false, signingEligible: false, producerStatus: "NOT_IMPLEMENTED", admission: "HOLD" });
}

function inspectV2Ledger(value, policy, expectedHead, expectedBase) {
  exact(value, V2_LEDGER_KEYS, "formal V2 protected attempt ledger");
  if (value.schemaVersion !== 2 || value.kind !== "FormalProtectedAttemptLedgerV2" || !same(value.repository, policy.publicTarget.repository) ||
      value.expectedHead !== expectedHead || value.expectedBase !== expectedBase || value.ledgerEpoch !== policy.ledgerEpoch ||
      !Array.isArray(value.attempts) || value.attempts.length < 1 || value.attempts.length > 2) fail("EFORMAL_PROTECTED_REPLACEMENT", "Formal V2 protected exact-SHA history is invalid");
  value.attempts.forEach((attempt, index) => {
    exact(attempt, V2_ATTEMPT_KEYS, "formal V2 protected attempt");
    string(attempt.reservationSha256, "attempt.reservationSha256", SHA256, 64);
    if (attempt.terminalSequence !== index + 1 || !["reserved", "terminal"].includes(attempt.status) ||
        (attempt.status === "reserved" ? attempt.bundleSha256 !== null : !SHA256.test(attempt.bundleSha256 ?? ""))) fail("EFORMAL_PROTECTED_REPLACEMENT", "Formal V2 attempt cannot be reordered, overwritten or reset");
  });
  if (value.attempts.some(attempt => attempt.status !== "terminal")) fail("EFORMAL_PROTECTED_PRODUCER_PENDING", "Formal protected executor or durable terminal outcome is incomplete");
}

function inspectV2Closure(closure, policy, ledger, expectedHead, expectedBase) {
  const { bundle, artifactBytes, reservation } = closure;
  validateFormalProtectedBundleV2(bundle);
  const payload = bundle.payload, sequence = payload.terminalSequence, attempt = ledger.attempts[sequence - 1];
  if (!attempt || payload.expectedHead !== expectedHead || payload.expectedBase !== expectedBase || expectedHead !== policy.publicTarget.sourceRevision ||
      expectedBase !== policy.expectedBase || !same(payload.publicTarget, policy.publicTarget) || payload.repositoryIdentity !== policy.repositoryIdentity ||
      payload.issuer !== policy.issuer || payload.profileId !== policy.profileId || payload.observerImageSha256 !== policy.observerImageSha256 ||
      payload.ledgerEpoch !== policy.ledgerEpoch || !same(payload.runtimeLanes, policy.runtimeLanes)) fail("EFORMAL_PROTECTED_BINDING", "Formal V2 attestation differs from independently installed public source policy");
  const key = policy.keys.find(entry => entry.keyId === payload.keyId);
  if (!key || key.status !== "active") fail("EFORMAL_PROTECTED_KEY", "Formal V2 observer key is absent or revoked");
  let valid = false;
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
    valid = publicKey.asymmetricKeyType === "ed25519" && verifySignature(null, Buffer.from(canonicalJson(payload)), publicKey, Buffer.from(bundle.signature, "base64"));
  } catch { valid = false; }
  if (!valid) fail("EFORMAL_PROTECTED_SIGNATURE", "Formal V2 observer signature is invalid");
  if (attempt.bundleSha256 !== hash(Buffer.from(canonicalJson(bundle))) || attempt.reservationSha256 !== reservation.sha256 ||
      payload.reservationSha256 !== reservation.sha256) fail("EFORMAL_PROTECTED_REPLACEMENT", "Formal V2 bundle or immutable reservation differs from protected history");
  for (const item of bundle.artifacts) {
    const bytes = artifactBytes[item.role];
    if (bytes.byteLength !== item.byteLength || hash(bytes) !== item.sha256) fail("EFORMAL_PROTECTED_ARTIFACT", `Formal V2 ${item.role} raw bytes differ from their signature`);
  }
  const reserved = reservation.value;
  exact(reserved, V2_RESERVATION_KEYS, "formal V2 immutable reservation");
  if (reserved.schemaVersion !== 2 || reserved.kind !== "FormalProtectedAttemptReservationV2" || !same(reserved.repository, policy.publicTarget.repository) ||
      reserved.expectedHead !== expectedHead || reserved.expectedBase !== expectedBase || reserved.ledgerEpoch !== policy.ledgerEpoch ||
      reserved.terminalSequence !== sequence || reserved.predecessorBundleSha256 !== payload.predecessorBundleSha256 ||
      reserved.replacementReason !== payload.replacementReason || !/^\/private\/tmp\/bw-[A-Za-z0-9._-]+-formal-eval-[A-Za-z0-9._-]+$/.test(reserved.launchRoot ?? "")) {
    fail("EFORMAL_PROTECTED_REPLACEMENT", "Formal V2 immutable reservation does not bind this execution");
  }
  const result = replayV2Execution(policy, artifactBytes, expectedHead, expectedBase, sequence, reserved.launchRoot);
  if (result.replay.qualificationStatus !== payload.qualificationStatus || result.replay.operationCompletion !== payload.operationCompletion ||
      result.records.provisional.receipt.replacementReason !== payload.replacementReason) fail("EFORMAL_PROTECTED_REPLAY", "Formal V2 signed terminal or replacement claims differ from replay");
  return result;
}

export function inspectFormalProtectedBundleV2(request) {
  const input = captureV2Fields(request, ["policy", "bundle", "artifactBytes", "expectedHead", "expectedBase", "ledgerBytes", "reservationBytes", "predecessor"], "formal V2 inspection request");
  const policy = captureInspectionJsonData(input.policy, MAX_POLICY_BYTES, "EFORMAL_PROTECTED_POLICY", "Formal V2 policy cannot be inspected safely");
  validateFormalProtectedPolicyV2(policy);
  string(input.expectedHead, "expectedHead", SHA40, 40); string(input.expectedBase, "expectedBase", SHA40, 40);
  const ledger = parseV2Record(input.ledgerBytes, "formal V2 protected attempt ledger", V2_MAX_LEDGER_BYTES);
  inspectV2Ledger(ledger.value, policy, input.expectedHead, input.expectedBase);
  const closure = captureV2Closure(input);
  if (closure.bundle.payload?.terminalSequence !== ledger.value.attempts.length) fail("EFORMAL_PROTECTED_REPLACEMENT", "Formal V2 reader must inspect the latest reserved attempt without fallback");
  const result = inspectV2Closure(closure, policy, ledger.value, input.expectedHead, input.expectedBase);
  if (ledger.value.attempts.length === 1) {
    if (input.predecessor !== null) fail("EFORMAL_PROTECTED_REPLACEMENT", "Formal V2 primary cannot have caller predecessor evidence");
  } else {
    const priorClosure = captureV2Closure(input.predecessor);
    if (priorClosure.bundle.payload?.terminalSequence !== 1 || closure.bundle.payload.predecessorBundleSha256 !== ledger.value.attempts[0].bundleSha256) {
      fail("EFORMAL_PROTECTED_REPLACEMENT", "Formal V2 replacement has no exact immutable primary predecessor");
    }
    const prior = inspectV2Closure(priorClosure, policy, ledger.value, input.expectedHead, input.expectedBase);
    const attempts = prior.records["ledger-export"].receipt.attempts;
    try { evaluateFormalAttemptBudget(attempts, closure.bundle.payload.replacementReason); } catch { fail("EFORMAL_PROTECTED_REPLACEMENT", "Formal V2 shared primary/replacement budget refuses this history"); }
    if (prior.replay.qualificationStatus !== "blocked" || prior.replay.failureClassification?.failureClass !== "INFRASTRUCTURE" ||
        prior.replay.failureClassification.eligibleReplacementReason !== closure.bundle.payload.replacementReason ||
        !same(result.records["ledger-export"].receipt.attempts.slice(0, 1), attempts)) {
      fail("EFORMAL_PROTECTED_REPLACEMENT", "Formal V2 predecessor does not prove the original eligible infrastructure replacement");
    }
  }
  const replay = result.replay;
  return Object.freeze({ ...replay, schemaVersion: 2, kind: "FormalProtectedInspectionV2", authenticated: true,
    rawBytesBound: true, portableReplayComplete: true, cleanupConfirmed: true, admission: "HOLD", releaseEligible: false,
    reasonCode: "FORMAL_VERIFICATION_OBSERVATION_ONLY", publicTarget: captureInspectionJsonData(policy.publicTarget, MAX_POLICY_BYTES, "EFORMAL_PROTECTED_POLICY", "Formal V2 target cannot be copied"),
    protectedLedgerSha256: ledger.sha256, reservationSha256: closure.reservation.sha256,
    policySha256: hash(Buffer.from(canonicalJson(policy))), bundleSha256: hash(Buffer.from(canonicalJson(closure.bundle))) });
}

function namespaceV2(policy, expectedHead) {
  return path.join(FORMAL_PROTECTED_ARTIFACT_ROOT_V2, policy.publicTarget.repository.id, expectedHead);
}

async function readV2Closure(root, expectedHead, sequence) {
  const directory = path.join(root, `attempt-${sequence}`);
  const bundle = parseBoundedFormalProtectedCanonicalJsonBytes(await readProtected(path.join(directory, "bundle.json"), directory,
    MAX_BUNDLE_BYTES, 0o700, 0o600), "formal V2 bundle", MAX_BUNDLE_BYTES);
  validateFormalProtectedBundleV2(bundle);
  if (bundle.payload.expectedHead !== expectedHead || bundle.payload.terminalSequence !== sequence) fail("EFORMAL_PROTECTED_BINDING", "Formal V2 immutable bundle pathname differs from payload");
  const artifactBytes = {};
  for (const item of bundle.artifacts) artifactBytes[item.role] = await readProtected(path.join(directory, item.file), directory, MAX_ARTIFACT_BYTES, 0o700, 0o600);
  const reservationBytes = await readProtected(path.join(directory, "reservation.json"), directory, V2_MAX_LEDGER_BYTES, 0o700, 0o600);
  return { bundle, artifactBytes, reservationBytes };
}

/** Only fixed protected paths supply production V2 policy and budget history.
 * No caller trust/key/raw ledger, policy path or fallback attempt is accepted.
 */
export async function inspectInstalledFormalProtectedBundleV2(options = {}) {
  exact(options, ["expectedHead", "expectedBase"], "formal V2 installed inspection request");
  string(options.expectedHead, "expectedHead", SHA40, 40); string(options.expectedBase, "expectedBase", SHA40, 40);
  if (process.platform !== "darwin" || process.arch !== "arm64") fail("EFORMAL_PROTECTED_PLATFORM", "Formal V2 protected installation requires macOS ARM64");
  const policyBytes = await readProtected(FORMAL_PROTECTED_POLICY_PATH_V2, path.dirname(FORMAL_PROTECTED_POLICY_PATH_V2), MAX_POLICY_BYTES, 0o755, 0o644);
  const policy = parseBoundedFormalProtectedCanonicalJsonBytes(policyBytes, "formal V2 policy", MAX_POLICY_BYTES);
  validateFormalProtectedPolicyV2(policy);
  if (options.expectedHead !== policy.publicTarget.sourceRevision || options.expectedBase !== policy.expectedBase) fail("EFORMAL_PROTECTED_BINDING", "Formal V2 public candidate is not installed exactly");
  const root = namespaceV2(policy, options.expectedHead), ledgerPath = path.join(root, "attempt-ledger.json");
  const ledgerBytes = await readProtected(ledgerPath, root, V2_MAX_LEDGER_BYTES, 0o700, 0o600);
  const ledger = parseV2Record(ledgerBytes, "formal V2 protected attempt ledger", V2_MAX_LEDGER_BYTES);
  inspectV2Ledger(ledger.value, policy, options.expectedHead, options.expectedBase);
  const sequence = ledger.value.attempts.length, closure = await readV2Closure(root, options.expectedHead, sequence);
  const predecessor = sequence === 2 ? await readV2Closure(root, options.expectedHead, 1) : null;
  const result = inspectFormalProtectedBundleV2({ ...closure, policy, ledgerBytes, predecessor, expectedHead: options.expectedHead, expectedBase: options.expectedBase });
  const policyAfter = await readProtected(FORMAL_PROTECTED_POLICY_PATH_V2, path.dirname(FORMAL_PROTECTED_POLICY_PATH_V2), MAX_POLICY_BYTES, 0o755, 0o644);
  const ledgerAfter = await readProtected(ledgerPath, root, V2_MAX_LEDGER_BYTES, 0o700, 0o600);
  if (hash(policyAfter) !== hash(policyBytes) || hash(ledgerAfter) !== hash(ledgerBytes)) fail("EFORMAL_PROTECTED_BINDING", "Formal V2 policy, revocation or attempt history changed during inspection");
  return result;
}
