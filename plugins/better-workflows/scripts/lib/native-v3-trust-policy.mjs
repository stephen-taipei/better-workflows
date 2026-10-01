import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { canonicalJson, pluginRoot } from "./core.mjs";

/**
 * Core-owned native V3 trust policy.
 *
 * The authoritative input is the installed plugin's fixed defaults file.  A
 * caller may ask for a fresh comparison, but cannot provide a policy path,
 * environment override, or policy data.  The installed file is intentionally
 * expected to grow an explicit `nativeExecution` section in a later slice;
 * until then this reader returns HOLD rather than assigning a trust mode.
 */

export const NATIVE_V3_TRUST_POLICY_SCHEMA_VERSION = 1;
export const NATIVE_V3_TRUST_POLICY_KIND = "NativeV3TrustPolicyV1";
export const NATIVE_V3_TRUST_POLICY_FIELD = "nativeExecution";
export const NATIVE_V3_TRUST_POLICY_RELATIVE_PATH = "config/defaults.json";
export const NATIVE_V3_TRUST_MODES = Object.freeze([
  "cooperative-user-mode",
  "host-attested"
]);
export const NATIVE_V3_TRUST_POLICY_MAX_BYTES = 256 * 1024;

const TRUST_POLICY_KEYS = new Set(["schemaVersion", "kind", "requiredTrustMode"]);
const READ_REQUEST_KEYS = new Set([
  "runId",
  "planId",
  "policyDigest",
  "requestedTrustMode",
  "observedAt",
  "sourceDigest"
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new NativeV3TrustPolicyValidationError(`${label} contains unknown field(s): ${unknown.join(", ")}`);
  }
  const missing = [...allowed].filter((key) => !Object.hasOwn(value, key)).sort();
  if (missing.length > 0) {
    throw new NativeV3TrustPolicyValidationError(`${label} requires field(s): ${missing.join(", ")}`);
  }
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new NativeV3TrustPolicyInputError(`${label} is invalid`);
  }
  return value;
}

function safeDigest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new NativeV3TrustPolicyInputError(`${label} is invalid`);
  }
  return value;
}

function safeObservedAt(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new NativeV3TrustPolicyInputError("observedAt is invalid");
  }
  return value;
}

function hold(code, message) {
  return new NativeV3TrustPolicyHoldError(code, message);
}

export class NativeV3TrustPolicyValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "NativeV3TrustPolicyValidationError";
    this.code = "INVALID_NATIVE_V3_TRUST_POLICY";
  }
}

export class NativeV3TrustPolicyInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "NativeV3TrustPolicyInputError";
    this.code = "ENATIVE_V3_TRUST_POLICY_INPUT";
  }
}

export class NativeV3TrustPolicyHoldError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NativeV3TrustPolicyHoldError";
    this.code = code;
    this.status = "HOLD";
  }
}

/**
 * Validate the closed policy projection.  This is a pure helper for fixtures
 * and digest calculation; it does not read a caller-supplied policy as an
 * authority source.
 */
export function validateNativeV3TrustPolicy(value) {
  if (!isPlainObject(value)) {
    throw new NativeV3TrustPolicyValidationError("Native V3 trust policy must be a plain object");
  }
  exactKeys(value, TRUST_POLICY_KEYS, "Native V3 trust policy");
  if (value.schemaVersion !== NATIVE_V3_TRUST_POLICY_SCHEMA_VERSION) {
    throw new NativeV3TrustPolicyValidationError("Native V3 trust policy schemaVersion is unsupported");
  }
  if (value.kind !== NATIVE_V3_TRUST_POLICY_KIND) {
    throw new NativeV3TrustPolicyValidationError("Native V3 trust policy kind is invalid");
  }
  if (!NATIVE_V3_TRUST_MODES.includes(value.requiredTrustMode)) {
    throw new NativeV3TrustPolicyValidationError("Native V3 trust policy requiredTrustMode is invalid");
  }
  return freezeDeep({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    requiredTrustMode: value.requiredTrustMode
  });
}

export function canonicalNativeV3TrustPolicyJson(value) {
  return canonicalJson(validateNativeV3TrustPolicy(value));
}

export function nativeV3TrustPolicyDigest(value) {
  return createHash("sha256")
    .update(canonicalNativeV3TrustPolicyJson(value), "utf8")
    .digest("hex");
}

function installedDefaultsPath() {
  const root = pluginRoot();
  if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root) {
    throw hold("ENATIVE_V3_TRUST_POLICY_UNSAFE", "Installed plugin root is not an absolute canonical path");
  }
  return path.join(root, NATIVE_V3_TRUST_POLICY_RELATIVE_PATH);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return sameIdentity(left, right) &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function assertStableSnapshot(before, afterDescriptor, afterPath, bytesLength) {
  if (!afterDescriptor.isFile() || afterDescriptor.nlink !== 1 ||
      !afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.nlink !== 1 ||
      !sameFileSnapshot(before, afterDescriptor) ||
      !sameFileSnapshot(before, afterPath) ||
      bytesLength !== afterDescriptor.size || bytesLength !== afterPath.size) {
    throw hold("ENATIVE_V3_TRUST_POLICY_UNSAFE", "Installed native V3 trust policy changed while it was read");
  }
}

function assertStableDirectory(before, after, label) {
  if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) {
    throw hold("ENATIVE_V3_TRUST_POLICY_UNSAFE", `Installed native V3 trust policy ${label} directory changed while it was read`);
  }
}

async function readInstalledDefaults() {
  const root = pluginRoot();
  const target = installedDefaultsPath();
  const configDirectory = path.dirname(target);
  let rootInfo;
  let configInfo;
  try {
    rootInfo = await fsPromises.lstat(root);
    configInfo = await fsPromises.lstat(configDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw hold("ENATIVE_V3_TRUST_POLICY_MISSING", "Installed native V3 trust policy is missing");
    }
    throw hold("ENATIVE_V3_TRUST_POLICY_UNSAFE", "Installed native V3 trust policy path cannot be inspected safely");
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
      !configInfo.isDirectory() || configInfo.isSymbolicLink()) {
    throw hold("ENATIVE_V3_TRUST_POLICY_UNSAFE", "Installed native V3 trust policy path contains an unsafe directory");
  }

  let handle;
  try {
    const targetInfo = await fsPromises.lstat(target);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile() || targetInfo.nlink !== 1) {
      throw hold("ENATIVE_V3_TRUST_POLICY_UNSAFE", "Installed native V3 trust policy must be a regular single-link file");
    }
    if (targetInfo.size > NATIVE_V3_TRUST_POLICY_MAX_BYTES) {
      throw hold("ENATIVE_V3_TRUST_POLICY_UNSAFE", "Installed native V3 trust policy exceeds its bounded size");
    }
    handle = await fsPromises.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const beforeDescriptor = await handle.stat();
    if (!beforeDescriptor.isFile() || beforeDescriptor.nlink !== 1 || !sameFileSnapshot(targetInfo, beforeDescriptor)) {
      throw hold("ENATIVE_V3_TRUST_POLICY_UNSAFE", "Installed native V3 trust policy must be a regular single-link file");
    }
    const buffer = Buffer.allocUnsafe(NATIVE_V3_TRUST_POLICY_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const readResult = await handle.read({
        buffer,
        offset,
        length: buffer.length - offset,
        position: offset
      });
      const bytesRead = readResult?.bytesRead;
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - offset) {
        throw hold("ENATIVE_V3_TRUST_POLICY_UNSAFE", "Installed native V3 trust policy returned an invalid bounded read");
      }
      offset += bytesRead;
      if (bytesRead === 0) break;
    }
    const bytes = buffer.subarray(0, offset);
    const afterDescriptor = await handle.stat();
    const afterPath = await fsPromises.lstat(target);
    const afterRoot = await fsPromises.lstat(root);
    const afterConfig = await fsPromises.lstat(configDirectory);
    assertStableDirectory(rootInfo, afterRoot, "root");
    assertStableDirectory(configInfo, afterConfig, "config");
    assertStableSnapshot(targetInfo, afterDescriptor, afterPath, bytes.length);
    if (bytes.length > NATIVE_V3_TRUST_POLICY_MAX_BYTES) {
      throw hold("ENATIVE_V3_TRUST_POLICY_UNSAFE", "Installed native V3 trust policy exceeds its bounded size");
    }
    return { target, bytes };
  } catch (error) {
    if (error instanceof NativeV3TrustPolicyHoldError) throw error;
    if (error?.code === "ENOENT") {
      throw hold("ENATIVE_V3_TRUST_POLICY_MISSING", "Installed native V3 trust policy is missing");
    }
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw hold("ENATIVE_V3_TRUST_POLICY_UNSAFE", "Installed native V3 trust policy path is unsafe");
    }
    throw hold("ENATIVE_V3_TRUST_POLICY_READ_FAILED", "Installed native V3 trust policy could not be read safely");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseInstalledDefaults(bytes) {
  let defaults;
  try {
    defaults = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw hold("ENATIVE_V3_TRUST_POLICY_INVALID", "Installed defaults are not valid JSON");
  }
  if (!isPlainObject(defaults)) {
    throw hold("ENATIVE_V3_TRUST_POLICY_INVALID", "Installed defaults must be a plain object");
  }
  if (!Object.hasOwn(defaults, NATIVE_V3_TRUST_POLICY_FIELD)) {
    throw hold(
      "ENATIVE_V3_TRUST_POLICY_MISSING",
      "Installed defaults do not declare an explicit native V3 trust policy"
    );
  }
  try {
    return validateNativeV3TrustPolicy(defaults[NATIVE_V3_TRUST_POLICY_FIELD]);
  } catch (error) {
    if (error instanceof NativeV3TrustPolicyValidationError) {
      throw hold("ENATIVE_V3_TRUST_POLICY_INVALID", error.message);
    }
    throw error;
  }
}

/**
 * Read the fixed installed defaults file once and return its current policy
 * projection.  Extra arguments are rejected so callers cannot redirect the
 * authority source.
 */
export async function readInstalledNativeV3TrustPolicy(...args) {
  if (args.length !== 0) {
    throw new NativeV3TrustPolicyInputError("Installed native V3 trust policy has no caller-selectable options");
  }
  const { target, bytes } = await readInstalledDefaults();
  const value = parseInstalledDefaults(bytes);
  const policyDigest = nativeV3TrustPolicyDigest(value);
  const sourceDigest = createHash("sha256").update(bytes).digest("hex");
  return Object.freeze({
    ...value,
    policyDigest,
    digest: policyDigest,
    sourceDigest,
    path: target,
    relativePath: NATIVE_V3_TRUST_POLICY_RELATIVE_PATH,
    value
  });
}

function validateReadRequest(request) {
  if (!isPlainObject(request)) {
    throw new NativeV3TrustPolicyInputError("Native V3 trust policy read request must be a plain object");
  }
  const unknown = Object.keys(request).filter((key) => !READ_REQUEST_KEYS.has(key)).sort();
  if (unknown.length > 0) {
    throw new NativeV3TrustPolicyInputError(`Native V3 trust policy read request contains unknown option(s): ${unknown.join(", ")}`);
  }
  if (Object.hasOwn(request, "runId")) safeId(request.runId, "runId");
  if (Object.hasOwn(request, "planId")) safeId(request.planId, "planId");
  if (Object.hasOwn(request, "policyDigest")) safeDigest(request.policyDigest, "policyDigest");
  if (Object.hasOwn(request, "sourceDigest")) safeDigest(request.sourceDigest, "sourceDigest");
  if (Object.hasOwn(request, "requestedTrustMode") && !NATIVE_V3_TRUST_MODES.includes(request.requestedTrustMode)) {
    throw new NativeV3TrustPolicyInputError("requestedTrustMode is invalid");
  }
  if (Object.hasOwn(request, "observedAt")) safeObservedAt(request.observedAt);
  if (!Object.hasOwn(request, "policyDigest")) {
    throw hold("ENATIVE_V3_TRUST_POLICY_EXPECTED_DIGEST", "Fresh native V3 trust policy requires an expected policyDigest");
  }
  if (!Object.hasOwn(request, "requestedTrustMode")) {
    throw hold("ENATIVE_V3_TRUST_POLICY_EXPECTED_MODE", "Fresh native V3 trust policy requires requestedTrustMode");
  }
  return request;
}

/**
 * Re-read the fixed installed policy and compare it to the caller's existing
 * plan binding.  The callback result intentionally exposes only the two
 * fields consumed by the cooperative controller.
 */
export async function readFreshNativeV3TrustPolicy(request = {}) {
  const checked = validateReadRequest(request);
  const current = await readInstalledNativeV3TrustPolicy();
  if (checked.policyDigest !== current.policyDigest ||
      (checked.sourceDigest !== undefined && checked.sourceDigest !== current.sourceDigest)) {
    throw hold("ENATIVE_V3_TRUST_POLICY_DRIFT", "Fresh installed native V3 trust policy does not match its admission binding");
  }
  if (checked.requestedTrustMode !== current.requiredTrustMode) {
    throw hold("ENATIVE_V3_TRUST_MODE_MISMATCH", "The installed native V3 trust policy requires a different trust mode");
  }
  return Object.freeze({
    policyDigest: current.policyDigest,
    requiredTrustMode: current.requiredTrustMode
  });
}

/**
 * Produce the resolver shape expected by the native V3 controller.  It has no
 * configuration argument; the installed bundle remains the sole authority.
 */
export function createNativeV3TrustPolicyReader(...args) {
  if (args.length !== 0) {
    throw new NativeV3TrustPolicyInputError("Native V3 trust policy reader has no caller-selectable options");
  }
  return readFreshNativeV3TrustPolicy;
}

export const createNativeV3TrustPolicyResolver = createNativeV3TrustPolicyReader;
