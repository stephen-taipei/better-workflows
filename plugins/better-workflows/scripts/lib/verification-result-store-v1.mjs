import { constants as fsConstants } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, link, mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  admitCurrentVerification,
  createCarryForwardFromPersistentStore,
  createIndependentComputeCache,
  runPureLocalValidator,
  sealVerificationResult,
  verifySealedResult
} from "./verification-incremental-v1.mjs";
import { canonicalJson, digestObject } from "./core.mjs";

export const VERIFICATION_RESULT_STORE_SCHEMA_VERSION = 1;
export const VERIFICATION_RESULT_STORE_KIND = "VerificationResultStoreRecordV1";
export const VERIFICATION_RESULT_STORE_WRITE_KIND = "VerificationResultStoreWriteV1";
export const VERIFICATION_RESULT_STORE_LOAD_KIND = "VerificationResultStoreLoadV1";
export const VERIFICATION_RESULT_STORE_KEY_FILE = ".verification-result-store-v1.key";

const HEX_DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODES = new Set(["full", "shadow"]);
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const STORE_DIRECTORY_MODE = 0o700;
const STORE_RECORD_MODE = 0o600;
const STORE_KEY_MODE = 0o600;
const STORE_KEY_BYTES = 32;
const STORE_AUTH_KIND = "VerificationResultStoreMacInputV1";
const STORE_AUTH_ALGORITHM = "HMAC-SHA256";
const ALLOWED_SYNC_DIRECTORY_ERRORS = new Set(["EINVAL", "ENOSYS", "ENOTSUP"]);
const GENUINE_STORE_INSTANCES = new WeakSet();
const STORE_DIRECTORIES = new WeakMap();
const AUTHENTICATED_STORE_LOADS = new WeakSet();
// macOS exposes /var and /tmp as system aliases. They are outside the
// caller-controlled store path; every component below them is still checked.
const TRUSTED_SYSTEM_SYMLINKS = new Set(["/var", "/tmp"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function assertGenuineStoreInstance(store) {
  if (!GENUINE_STORE_INSTANCES.has(store) || !STORE_DIRECTORIES.has(store)) {
    fail("Verification result store must be a genuine module-created instance");
  }
  return STORE_DIRECTORIES.get(store);
}

export function isGenuineVerificationResultStore(value) {
  return Boolean(value && GENUINE_STORE_INSTANCES.has(value) && STORE_DIRECTORIES.has(value));
}

function markAuthenticatedStoreLoad(value) {
  AUTHENTICATED_STORE_LOADS.add(value);
  return value;
}

export function isAuthenticatedVerificationResultStoreLoad(value) {
  return Boolean(value && AUTHENTICATED_STORE_LOADS.has(value));
}

function assertObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !HEX_DIGEST.test(value)) fail(`${label} must be a sha256 digest`);
  return value;
}

function assertDigestOrNull(value, label) {
  if (value !== null && value !== undefined) assertDigest(value, label);
  return value ?? null;
}

function assertSafeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function assertJsonValue(value, label = "value", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} must contain finite numbers`);
    return value;
  }
  if (typeof value !== "object") fail(`${label} must contain JSON values only`);
  if (seen.has(value)) fail(`${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`, seen));
  } else {
    for (const key of Object.keys(value)) {
      if (key.includes("\0") || value[key] === undefined) fail(`${label}.${key} is not valid JSON`);
      assertJsonValue(value[key], `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
  return value;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertExactKeys(value, keys, label) {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} contains unexpected or missing fields`);
  }
  return value;
}

function assertCanonicalAbsolutePath(value, label) {
  assertString(value, label);
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    fail(`${label} must be a canonical absolute path`);
  }
  return value;
}

function assertUnitDescriptor(unit) {
  assertObject(unit, "VerificationUnitV1");
  assertDigest(unit.unitDigest, "VerificationUnitV1.unitDigest");
  assertDigest(unit.cacheKey, "VerificationUnitV1.cacheKey");
  if (!isObject(unit.sourceBinding)) fail("VerificationUnitV1.sourceBinding is invalid");
  assertDigest(unit.sourceBinding.digest, "VerificationUnitV1.sourceBinding.digest");
  assertDigestOrNull(unit.relevantRevisionDigest, "VerificationUnitV1.relevantRevisionDigest");
  if (unit.effectAuthorized !== false) fail("VerificationUnitV1 cannot carry effect authority");
  return unit;
}

function assertSnapshot(value, label) {
  assertObject(value, label);
  assertExactKeys(value, ["kind", "status", "current", "contentDigest", "manifestDigest"], label);
  if (value.kind !== "HistoricalDependencySnapshotV1" || value.status !== "historical" || value.current !== false) {
    fail(`${label} is not a historical snapshot`);
  }
  assertDigest(value.contentDigest, `${label}.contentDigest`);
  assertDigest(value.manifestDigest, `${label}.manifestDigest`);
  return value;
}

function assertAdmissionShape(value, label = "VerificationAdmissionV1", { requireCacheEligible = true } = {}) {
  assertObject(value, label);
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "unitDigest",
    "cacheKey",
    "currentContentDigest",
    "currentManifestDigest",
    "snapshot",
    "status",
    "disposition",
    "reason",
    "cacheEligible",
    "effectAuthorized",
    "runId",
    "epoch",
    "unrelatedHeadDigest",
    "sourceBindingDigest",
    "relevantRevisionDigest",
    "admissionDigest"
  ], label);
  if (value.schemaVersion !== VERIFICATION_RESULT_STORE_SCHEMA_VERSION || value.kind !== "VerificationAdmissionV1") {
    fail(`${label} kind/version is invalid`);
  }
  assertDigest(value.unitDigest, `${label}.unitDigest`);
  assertDigest(value.cacheKey, `${label}.cacheKey`);
  assertDigest(value.currentContentDigest, `${label}.currentContentDigest`);
  assertDigest(value.currentManifestDigest, `${label}.currentManifestDigest`);
  assertSnapshot(value.snapshot, `${label}.snapshot`);
  if (value.snapshot.contentDigest !== value.currentContentDigest || value.snapshot.manifestDigest !== value.currentManifestDigest) {
    fail(`${label}.snapshot is not bound to its current digests`);
  }
  const isCacheEligible = value.status === "admitted" && value.disposition === "cache-eligible" && value.cacheEligible === true;
  const isHeldOrFullRequired = ["hold", "full-required"].includes(value.status) && value.disposition === "full-required" && value.cacheEligible === false;
  if (requireCacheEligible ? !isCacheEligible : !isCacheEligible && !isHeldOrFullRequired) {
    fail(`${label} has an invalid admission disposition`);
  }
  if (value.effectAuthorized !== false) fail(`${label} cannot carry effect authority`);
  if (value.runId !== null) assertSafeId(value.runId, `${label}.runId`);
  if (value.epoch !== null && (!Number.isSafeInteger(value.epoch) || value.epoch < 0)) fail(`${label}.epoch is invalid`);
  assertDigestOrNull(value.unrelatedHeadDigest, `${label}.unrelatedHeadDigest`);
  assertDigest(value.sourceBindingDigest, `${label}.sourceBindingDigest`);
  assertDigestOrNull(value.relevantRevisionDigest, `${label}.relevantRevisionDigest`);
  assertString(value.reason, `${label}.reason`);
  assertDigest(value.admissionDigest, `${label}.admissionDigest`);
  const withoutDigest = { ...value };
  delete withoutDigest.admissionDigest;
  if (digestObject(withoutDigest) !== value.admissionDigest) fail(`${label}.admissionDigest does not match its contents`);
  return value;
}

function assertAdmissionBoundToUnit(admission, unit, label = "VerificationAdmissionV1", options = {}) {
  assertAdmissionShape(admission, label, options);
  if (
    admission.unitDigest !== unit.unitDigest ||
    admission.cacheKey !== unit.cacheKey ||
    admission.sourceBindingDigest !== unit.sourceBinding.digest ||
    admission.relevantRevisionDigest !== (unit.relevantRevisionDigest ?? null)
  ) {
    fail(`${label} is bound to a different unit`);
  }
  return admission;
}

function assertResultBoundToFreshAdmission(result, unit, admission, label = "Verification result") {
  verifySealedResult(result);
  if (
    result.unitDigest !== unit.unitDigest ||
    result.cacheKey !== unit.cacheKey ||
    result.observedContentDigest !== admission.currentContentDigest ||
    result.snapshot.contentDigest !== admission.currentContentDigest
  ) {
    fail(`${label} is not bound to the fresh current admission`);
  }
  if (result.status !== "pass" || result.outcome !== "pass") fail(`${label} must be a passing result`);
  if (result.effectAuthorized !== false || result.authoritative !== false) fail(`${label} cannot carry effect authority`);
  return result;
}

function recordCoreFor(record) {
  const core = { ...record };
  delete core.recordDigest;
  delete core.integrity;
  return core;
}

function integrityPayload(record, unit) {
  return {
    schemaVersion: VERIFICATION_RESULT_STORE_SCHEMA_VERSION,
    kind: STORE_AUTH_KIND,
    record: recordCoreFor(record),
    recordDigest: record.recordDigest,
    unitDigest: unit.unitDigest,
    cacheKey: unit.cacheKey,
    rootDigest: unit.rootDigest,
    dependenciesDigest: digestObject(unit.dependencies),
    validatorDigest: digestObject(unit.validator),
    validatorSourceDigest: digestObject(unit.validatorSource),
    toolBinaryDigest: digestObject(unit.toolBinary),
    toolBinaryFingerprintDigest: digestObject(unit.toolBinaryFingerprint),
    configDigest: digestObject(unit.config),
    controlledEnvironmentDigest: digestObject(unit.controlledEnvironment),
    policyDigest: digestObject(unit.policy),
    sourceBindingDigest: unit.sourceBinding.digest,
    relevantRevisionDigest: unit.relevantRevisionDigest ?? null
  };
}

function macFor(key, payload) {
  return createHmac("sha256", key).update(canonicalJson(payload)).digest("hex");
}

function assertIntegrityShape(value, label = "VerificationResultStoreIntegrityV1") {
  assertObject(value, label);
  assertExactKeys(value, ["schemaVersion", "kind", "algorithm", "payloadDigest", "mac"], label);
  if (value.schemaVersion !== VERIFICATION_RESULT_STORE_SCHEMA_VERSION || value.kind !== STORE_AUTH_KIND || value.algorithm !== STORE_AUTH_ALGORITHM) {
    fail(`${label} kind/version/algorithm is invalid`);
  }
  assertDigest(value.payloadDigest, `${label}.payloadDigest`);
  assertDigest(value.mac, `${label}.mac`);
  return value;
}

function attachIntegrity(record, unit, key) {
  const payload = integrityPayload(record, unit);
  const integrity = {
    schemaVersion: VERIFICATION_RESULT_STORE_SCHEMA_VERSION,
    kind: STORE_AUTH_KIND,
    algorithm: STORE_AUTH_ALGORITHM,
    payloadDigest: digestObject(payload),
    mac: macFor(key, payload)
  };
  return deepFreeze({ ...record, integrity });
}

function verifyIntegrity(record, unit, key) {
  try {
    const integrity = assertIntegrityShape(record.integrity);
    const payload = integrityPayload(record, unit);
    if (integrity.payloadDigest !== digestObject(payload)) return false;
    const expected = Buffer.from(macFor(key, payload), "hex");
    const actual = Buffer.from(integrity.mac, "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function assertStoredRecord(value, unit) {
  assertObject(value, VERIFICATION_RESULT_STORE_KIND);
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "unitDigest",
    "cacheKey",
    "result",
    "admission",
    "sourceBindingDigest",
    "relevantRevisionDigest",
    "storedAtMs",
    "effectAuthorized",
    "authoritative",
    "integrity",
    "recordDigest"
  ], VERIFICATION_RESULT_STORE_KIND);
  if (value.schemaVersion !== VERIFICATION_RESULT_STORE_SCHEMA_VERSION || value.kind !== VERIFICATION_RESULT_STORE_KIND) {
    fail(`${VERIFICATION_RESULT_STORE_KIND} kind/version is invalid`);
  }
  assertUnitDescriptor(unit);
  assertDigest(value.unitDigest, `${VERIFICATION_RESULT_STORE_KIND}.unitDigest`);
  assertDigest(value.cacheKey, `${VERIFICATION_RESULT_STORE_KIND}.cacheKey`);
  if (value.unitDigest !== unit.unitDigest || value.cacheKey !== unit.cacheKey) {
    fail(`${VERIFICATION_RESULT_STORE_KIND} is bound to a different unit`);
  }
  assertDigest(value.sourceBindingDigest, `${VERIFICATION_RESULT_STORE_KIND}.sourceBindingDigest`);
  assertDigestOrNull(value.relevantRevisionDigest, `${VERIFICATION_RESULT_STORE_KIND}.relevantRevisionDigest`);
  if (value.sourceBindingDigest !== unit.sourceBinding.digest || value.relevantRevisionDigest !== (unit.relevantRevisionDigest ?? null)) {
    fail(`${VERIFICATION_RESULT_STORE_KIND} source/revision binding is invalid`);
  }
  if (!Number.isSafeInteger(value.storedAtMs) || value.storedAtMs < 0) fail(`${VERIFICATION_RESULT_STORE_KIND}.storedAtMs is invalid`);
  if (value.effectAuthorized !== false || value.authoritative !== false) fail(`${VERIFICATION_RESULT_STORE_KIND} cannot carry effect authority`);
  assertIntegrityShape(value.integrity);
  assertAdmissionBoundToUnit(value.admission, unit, `${VERIFICATION_RESULT_STORE_KIND}.admission`);
  verifySealedResult(value.result);
  if (typeof value.result.resultId !== "string") fail(`${VERIFICATION_RESULT_STORE_KIND}.result.resultId is invalid`);
  assertSafeId(value.result.resultId, `${VERIFICATION_RESULT_STORE_KIND}.result.resultId`);
  assertResultBoundToFreshAdmission(value.result, unit, value.admission, `${VERIFICATION_RESULT_STORE_KIND}.result`);
  assertDigest(value.recordDigest, `${VERIFICATION_RESULT_STORE_KIND}.recordDigest`);
  if (digestObject(recordCoreFor(value)) !== value.recordDigest) fail(`${VERIFICATION_RESULT_STORE_KIND}.recordDigest does not match its contents`);
  return value;
}

function noFollowFlags(base) {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW <= 0) {
    fail("Verification result store requires O_NOFOLLOW support");
  }
  return base | fsConstants.O_NOFOLLOW;
}

function assertOwnedPrivateStat(info, label, expectedDirectory, { allowTransientLink = false } = {}) {
  if (expectedDirectory ? !info.isDirectory() : !info.isFile()) fail(`${label} must be a ${expectedDirectory ? "directory" : "regular file"}`);
  if ((info.mode & 0o077) !== 0) fail(`${label} must not be group/world accessible`);
  if (!expectedDirectory && (allowTransientLink ? info.nlink < 1 || info.nlink > 2 : info.nlink !== 1)) {
    fail(`${label} must have exactly one link`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) fail(`${label} is not owned by the current user`);
}

async function ensureStoreDirectory(directory) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  const relative = path.relative(parsed.root, directory);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode: STORE_DIRECTORY_MODE });
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) {
      if (!TRUSTED_SYSTEM_SYMLINKS.has(current)) {
        fail(`Verification result store path contains a symlink: ${current}`);
      }
      info = await stat(current);
    }
    if (!info.isDirectory()) fail(`Verification result store path component is not a directory: ${current}`);
  }
  const info = await lstat(directory);
  assertOwnedPrivateStat(info, "Verification result store directory", true);
}

function sameStat(left, right) {
  return ["dev", "ino", "size", "mode", "nlink", "mtimeMs", "ctimeMs"].every((key) => left[key] === right[key]);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, noFollowFlags(fsConstants.O_RDONLY));
    await handle.sync();
  } catch (error) {
    if (!ALLOWED_SYNC_DIRECTORY_ERRORS.has(error?.code)) throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function storeKeyPath(directory) {
  return path.join(directory, VERIFICATION_RESULT_STORE_KEY_FILE);
}

async function readStableKey(filePath) {
  let handle;
  try {
    handle = await open(filePath, noFollowFlags(fsConstants.O_RDONLY));
    const before = await handle.stat();
    assertOwnedPrivateStat(before, "Verification result store key", false, { allowTransientLink: true });
    if (before.size !== STORE_KEY_BYTES) fail("Verification result store key has an invalid size");
    const key = await handle.readFile();
    const after = await handle.stat();
    if (!sameStat(before, after) || key.length !== STORE_KEY_BYTES) fail("Verification result store key changed during read");
    return key;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function readOrCreateStoreKey(directory, { create = false } = {}) {
  const filePath = storeKeyPath(directory);
  try {
    return { status: "valid", reason: "key-present", key: await readStableKey(filePath) };
  } catch (error) {
    if (!create || error?.code !== "ENOENT") {
      return { status: error?.code === "ENOENT" ? "missing" : "invalid", reason: error?.code === "ENOENT" ? "key-missing" : "key-invalid" };
    }
  }

  const generated = randomBytes(STORE_KEY_BYTES);
  const tempPath = path.join(directory, `.${VERIFICATION_RESULT_STORE_KEY_FILE}.${randomBytes(12).toString("hex")}.tmp`);
  let tempHandle;
  let linked = false;
  try {
    tempHandle = await open(tempPath, noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL), STORE_KEY_MODE);
    await tempHandle.writeFile(generated);
    await tempHandle.sync();
    const info = await tempHandle.stat();
    assertOwnedPrivateStat(info, "Verification result store temporary key", false);
    if (info.size !== STORE_KEY_BYTES) fail("Verification result store temporary key was truncated");
    await tempHandle.close();
    tempHandle = null;
    try {
      await link(tempPath, filePath);
      linked = true;
      await syncDirectory(directory);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (linked) await unlink(tempPath);
    try {
      return { status: "valid", reason: "key-created-or-present", key: await readStableKey(filePath) };
    } catch (error) {
      return { status: error?.code === "ENOENT" ? "missing" : "invalid", reason: error?.code === "ENOENT" ? "key-missing" : "key-invalid" };
    }
  } finally {
    if (tempHandle) await tempHandle.close().catch(() => undefined);
    await unlink(tempPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function readStableBytes(filePath) {
  let handle;
  try {
    handle = await open(filePath, noFollowFlags(fsConstants.O_RDONLY));
    const before = await handle.stat();
    assertOwnedPrivateStat(before, "Verification result store record", false);
    if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > MAX_RECORD_BYTES) {
      fail("Verification result store record size is outside the fixed bound");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameStat(before, after) || bytes.length !== before.size) fail("Verification result store record changed during read");
    return bytes;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function readRecord(filePath, unit) {
  let bytes;
  try {
    bytes = await readStableBytes(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", reason: "missing-record" };
    return { status: "invalid", reason: "invalid-record" };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text);
    assertJsonValue(parsed, VERIFICATION_RESULT_STORE_KIND);
    if (canonicalJson(parsed) !== text) fail("Verification result store record is not canonical JSON");
    assertStoredRecord(parsed, unit);
    return { status: "valid", reason: "record-valid", record: deepFreeze(parsed) };
  } catch {
    return { status: "invalid", reason: "invalid-record" };
  }
}

function buildStoredRecord({ unit, result, admission }) {
  const core = {
    schemaVersion: VERIFICATION_RESULT_STORE_SCHEMA_VERSION,
    kind: VERIFICATION_RESULT_STORE_KIND,
    unitDigest: unit.unitDigest,
    cacheKey: unit.cacheKey,
    result,
    admission,
    sourceBindingDigest: unit.sourceBinding.digest,
    relevantRevisionDigest: unit.relevantRevisionDigest ?? null,
    storedAtMs: Date.now(),
    effectAuthorized: false,
    authoritative: false
  };
  return deepFreeze({ ...core, recordDigest: digestObject(core) });
}

function writeResult(status, reason, filePath, recordDigest, stored) {
  return deepFreeze({
    schemaVersion: VERIFICATION_RESULT_STORE_SCHEMA_VERSION,
    kind: VERIFICATION_RESULT_STORE_WRITE_KIND,
    status,
    reason,
    stored,
    cacheHit: false,
    path: filePath,
    recordDigest
  });
}

function loadResult(reason, filePath, {
  result = null,
  admission = null,
  recordDigest = null,
  revalidated = false,
  hit = false,
  cacheHit = false
} = {}) {
  return deepFreeze({
    schemaVersion: VERIFICATION_RESULT_STORE_SCHEMA_VERSION,
    kind: VERIFICATION_RESULT_STORE_LOAD_KIND,
    hit,
    cacheHit,
    revalidated,
    reason,
    path: filePath,
    recordDigest,
    result,
    admission
  });
}

async function recomputeForLoad({
  root,
  unit,
  mode,
  runId,
  epoch,
  unrelatedHeadDigest,
  fresh,
  persisted,
  filePath,
  reason
}) {
  const produced = await runPureLocalValidator({ root, unit, mode, runId, epoch, unrelatedHeadDigest });
  const revalidated = sealVerificationResult({ unit, produced });
  const recordDigest = persisted.status === "valid" ? persisted.record.recordDigest : null;
  if (revalidated.status !== "pass" || revalidated.outcome !== "pass") {
    return loadResult(`revalidation-${revalidated.status}`, filePath, {
      result: revalidated,
      admission: fresh,
      recordDigest,
      revalidated: true
    });
  }
  if (revalidated.observedContentDigest !== fresh.currentContentDigest) {
    return loadResult("revalidation-content-mismatch", filePath, {
      result: revalidated,
      admission: fresh,
      recordDigest,
      revalidated: true
    });
  }
  return loadResult(`${reason}-recomputed`, filePath, {
    result: revalidated,
    admission: fresh,
    recordDigest,
    revalidated: true
  });
}

export class VerificationResultStoreV1 {
  #directory;

  constructor({ directory } = {}) {
    this.#directory = assertCanonicalAbsolutePath(directory, "directory");
    STORE_DIRECTORIES.set(this, this.#directory);
    GENUINE_STORE_INSTANCES.add(this);
  }

  recordPath({ unit } = {}) {
    assertUnitDescriptor(unit);
    return path.join(this.#directory, `${unit.cacheKey}.json`);
  }

  async put({ root, unit, result, admission = null, runId = null, epoch = null, unrelatedHeadDigest = null } = {}) {
    assertUnitDescriptor(unit);
    const inProcessCache = createIndependentComputeCache();
    inProcessCache.put(result);
    const fresh = await admitCurrentVerification({ root, unit, runId, epoch, unrelatedHeadDigest });
    assertAdmissionBoundToUnit(fresh, unit, "fresh admission");
    assertResultBoundToFreshAdmission(result, unit, fresh, "sealed verification result");
    if (admission !== null && admission !== undefined) {
      const supplied = assertAdmissionBoundToUnit(admission, unit, "supplied admission");
      if (
        supplied.currentContentDigest !== fresh.currentContentDigest ||
        supplied.status !== fresh.status ||
        supplied.disposition !== fresh.disposition ||
        supplied.cacheEligible !== fresh.cacheEligible
      ) {
        fail("supplied admission does not match the fresh current admission");
      }
    }
    const filePath = this.recordPath({ unit });
    await ensureStoreDirectory(this.#directory);
    const keyState = await readOrCreateStoreKey(this.#directory, { create: true });
    if (keyState.status !== "valid") fail(`Verification result store cannot use its ${keyState.reason}`);
    const record = attachIntegrity(buildStoredRecord({ unit, result, admission: fresh }), unit, keyState.key);
    const payload = Buffer.from(canonicalJson(record));
    if (payload.length > MAX_RECORD_BYTES) fail("Verification result store record exceeds the fixed size bound");
    const tempPath = path.join(this.#directory, `.${unit.cacheKey}.${randomBytes(12).toString("hex")}.tmp`);
    let tempHandle;
    try {
      tempHandle = await open(tempPath, noFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL), STORE_RECORD_MODE);
      await tempHandle.writeFile(payload);
      await tempHandle.sync();
      const info = await tempHandle.stat();
      if (info.size !== payload.length) fail("Verification result store temporary record was truncated");
      await tempHandle.close();
      tempHandle = null;
      try {
        await link(tempPath, filePath);
        await syncDirectory(this.#directory);
        return writeResult("stored", "record-published", filePath, record.recordDigest, true);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = await readRecord(filePath, unit);
        if (existing.status === "valid" && existing.record.recordDigest === record.recordDigest) {
          return writeResult("already-present", "record-already-present", filePath, record.recordDigest, false);
        }
        fail("Verification result store target already exists with an invalid or conflicting record");
      }
    } finally {
      if (tempHandle) await tempHandle.close().catch(() => undefined);
      await unlink(tempPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async createCarryForward(options = {}) {
    return createCarryForwardFromPersistentStore({ ...options, store: this });
  }

  async load(options = {}) {
    return loadStoreRecord(this, options);
  }
}

async function loadStoreRecord(store, {
  root,
  unit,
  mode = "full",
  runId = null,
  epoch = null,
  unrelatedHeadDigest = null
} = {}) {
  const directory = assertGenuineStoreInstance(store);
  assertUnitDescriptor(unit);
  if (!MODES.has(mode)) fail("mode must be full or shadow");
  const filePath = path.join(directory, `${unit.cacheKey}.json`);
  await ensureStoreDirectory(directory);
  const persisted = await readRecord(filePath, unit);
  const fresh = await admitCurrentVerification({ root, unit, runId, epoch, unrelatedHeadDigest });
  assertAdmissionBoundToUnit(fresh, unit, "fresh admission", { requireCacheEligible: false });
  if (fresh.status !== "admitted" || fresh.cacheEligible !== true) {
    return loadResult(`fresh-admission-${fresh.reason}`, filePath, {
      admission: fresh,
      recordDigest: persisted.status === "valid" ? persisted.record.recordDigest : null
    });
  }
  if (persisted.status !== "valid") {
    return recomputeForLoad({
      root,
      unit,
      mode,
      runId,
      epoch,
      unrelatedHeadDigest,
      fresh,
      persisted,
      filePath,
      reason: persisted.reason
    });
  }
  const keyState = await readOrCreateStoreKey(directory);
  if (keyState.status !== "valid") {
    return recomputeForLoad({
      root,
      unit,
      mode,
      runId,
      epoch,
      unrelatedHeadDigest,
      fresh,
      persisted,
      filePath,
      reason: keyState.reason
    });
  }
  if (!verifyIntegrity(persisted.record, unit, keyState.key)) {
    return recomputeForLoad({
      root,
      unit,
      mode,
      runId,
      epoch,
      unrelatedHeadDigest,
      fresh,
      persisted,
      filePath,
      reason: "integrity-invalid"
    });
  }
  if (persisted.record.result.mode !== mode) {
    return recomputeForLoad({
      root,
      unit,
      mode,
      runId,
      epoch,
      unrelatedHeadDigest,
      fresh,
      persisted,
      filePath,
      reason: "persisted-mode-mismatch"
    });
  }
  if (
    persisted.record.admission.currentContentDigest !== fresh.currentContentDigest ||
    persisted.record.result.observedContentDigest !== fresh.currentContentDigest
  ) {
    return recomputeForLoad({
      root,
      unit,
      mode,
      runId,
      epoch,
      unrelatedHeadDigest,
      fresh,
      persisted,
      filePath,
      reason: "persisted-admission-mismatch"
    });
  }
  return markAuthenticatedStoreLoad(loadResult("persisted-record-cache-hit", filePath, {
    result: persisted.record.result,
    admission: fresh,
    recordDigest: persisted.record.recordDigest,
    hit: true,
    cacheHit: true
  }));
}

export async function loadAuthenticatedVerificationResult(options = {}) {
  const { store, ...loadOptions } = options;
  assertGenuineStoreInstance(store);
  return loadStoreRecord(store, loadOptions);
}

export function createVerificationResultStore({ directory } = {}) {
  return new VerificationResultStoreV1({ directory });
}
