import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  lstat,
  unlink
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { VERSION, pluginRoot } from "./core.mjs";
import { pluginBundleDigest } from "./routing.mjs";

/**
 * The update notice is deliberately a small, local-only cache.  It does not
 * install anything and the only network operation it permits is the fixed
 * public GitHub release endpoint below.
 */
export const UPDATE_NOTICE_ENDPOINT =
  "https://api.github.com/repos/stephen-taipei/better-workflows/releases/latest";
export const UPDATE_NOTICE_STATE_VERSION = 1;
export const UPDATE_NOTICE_STATE_DIRECTORY = "update-notice-v1";
export const UPDATE_NOTICE_MODES = Object.freeze(["off", "manual", "automatic"]);
export const UPDATE_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_NOTICE_TIMEOUT_MS = 3_000;
export const UPDATE_NOTICE_MAX_BODY_BYTES = 64 * 1024;

const SETTINGS_FILE = "settings.json";
const RESULT_FILE = "last-result.json";
const ATTEMPTS_DIRECTORY = "attempts";
const ATTEMPT_PREFIX = "attempt-";
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ATTEMPT_NAME = /^attempt-(\d{1,17})-([0-9a-f-]{36})$/;
const TEMP_FILE = /^\.(?:settings\.json|last-result\.json)\.[0-9a-f-]{36}\.tmp$/;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const KNOWN_REASONS = new Set([
  "AUTOMATIC_DISABLED",
  "CONCURRENT_ATTEMPT",
  "HTTP_404",
  "HTTP_STATUS",
  "IN_FLIGHT",
  "MODE_OFF",
  "NETWORK_ERROR",
  "NOT_CHECKED",
  "RATE_LIMITED",
  "RESPONSE_INVALID",
  "RUNNING_INVALID",
  "RUNNING_REQUIRED",
  "STATE_INVALID",
  "STATE_MISSING",
  "TIMEOUT"
]);
const KNOWN_RESULT_STATUSES = new Set(["available", "current", "unknown"]);

class UpdateNoticeLocalError extends Error {
  constructor(message, code = "UPDATE_NOTICE_LOCAL_ERROR") {
    super(message);
    this.name = "UpdateNoticeLocalError";
    this.code = code;
  }
}

function localError(message) {
  return new UpdateNoticeLocalError(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateNow(now) {
  let value;
  try {
    value = now();
  } catch {
    throw localError("Update notice clock is unavailable");
  }
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw localError("Update notice clock is invalid");
  }
  return value;
}

function resolveRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw localError("Update notice root is required");
  }
  return path.resolve(root);
}

function statePath(root) {
  return path.join(root, UPDATE_NOTICE_STATE_DIRECTORY);
}

function settingsPath(root) {
  return path.join(statePath(root), SETTINGS_FILE);
}

function resultPath(root) {
  return path.join(statePath(root), RESULT_FILE);
}

function attemptsPath(root) {
  return path.join(statePath(root), ATTEMPTS_DIRECTORY);
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertRootDirectory(root, { allowMissing = false } = {}) {
  const info = await lstatOrNull(root);
  if (!info) {
    if (allowMissing) return false;
    throw localError("Update notice root is missing");
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw localError("Update notice root is unsafe");
  }
  return true;
}

function assertPrivateMode(info, label) {
  if ((info.mode & 0o077) !== 0) {
    throw localError(`${label} is not private`);
  }
}

async function assertPrivateDirectory(target, label, { allowMissing = false } = {}) {
  const info = await lstatOrNull(target);
  if (!info) {
    if (allowMissing) return false;
    throw localError(`${label} is missing`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw localError(`${label} is unsafe`);
  }
  assertPrivateMode(info, label);
  return true;
}

async function assertStatePathChain(root, target, { allowMissing = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw localError("Update notice path escapes its root");
  }
  let current = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstatOrNull(current);
    if (!info) {
      if (allowMissing) return false;
      throw localError("Update notice path is missing");
    }
    if (info.isSymbolicLink()) throw localError("Update notice path contains a symlink");
    if (current !== resolvedTarget && !info.isDirectory()) {
      throw localError("Update notice path contains a non-directory");
    }
  }
  return true;
}

async function readPrivateJson(root, target, label) {
  await assertStatePathChain(root, target);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw localError(`${label} is unsafe`);
  }
  assertPrivateMode(info, label);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(target, fsConstants.O_RDONLY | noFollow);
  try {
    const verified = await handle.stat();
    if (verified.isSymbolicLink() || !verified.isFile() || verified.nlink !== 1) {
      throw localError(`${label} is unsafe`);
    }
    assertPrivateMode(verified, label);
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof UpdateNoticeLocalError) throw error;
    throw localError(`${label} is invalid`);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}

async function atomicWritePrivateJson(root, target, value, label) {
  const parent = path.dirname(target);
  await assertStatePathChain(root, parent);
  await assertPrivateDirectory(parent, "Update notice state directory");
  const current = await lstatOrNull(target);
  if (current) {
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1) {
      throw localError(`${label} is unsafe`);
    }
    assertPrivateMode(current, label);
  }
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o600
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
    await syncDirectory(parent);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function ensureRootForWrite(root) {
  const existing = await lstatOrNull(root);
  if (!existing) {
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  await assertRootDirectory(root);
}

async function ensureStateDirectory(root) {
  await ensureRootForWrite(root);
  const target = statePath(root);
  const existing = await lstatOrNull(target);
  if (!existing) {
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  await assertPrivateDirectory(target, "Update notice state directory");
  return target;
}

async function ensureAttemptsDirectory(root) {
  await ensureStateDirectory(root);
  const target = attemptsPath(root);
  const existing = await lstatOrNull(target);
  if (!existing) {
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  await assertPrivateDirectory(target, "Update notice attempts directory");
  return target;
}

function validateMode(mode) {
  if (!UPDATE_NOTICE_MODES.includes(mode)) {
    throw localError(`Update notice mode must be one of: ${UPDATE_NOTICE_MODES.join(", ")}`);
  }
  return mode;
}

function validateSettings(value) {
  if (!exactKeys(value, ["mode", "schemaVersion"]) || value.schemaVersion !== UPDATE_NOTICE_STATE_VERSION) {
    throw localError("Update notice settings are invalid");
  }
  validateMode(value.mode);
  return value.mode;
}

function validReason(value) {
  return typeof value === "string" && SAFE_REASON.test(value) && KNOWN_REASONS.has(value);
}

function validateVersion(value) {
  return typeof value === "string" && SEMANTIC_VERSION.test(value);
}

function validateStoredResult(value) {
  if (!isObject(value) || value.schemaVersion !== UPDATE_NOTICE_STATE_VERSION ||
      !KNOWN_RESULT_STATUSES.has(value.status) ||
      !Number.isSafeInteger(value.lastCheckedAt) || value.lastCheckedAt < 0) {
    throw localError("Update notice result is invalid");
  }
  const keys = Object.keys(value);
  const allowed = new Set(["schemaVersion", "status", "availableVersion", "releaseUrl", "lastCheckedAt", "reason"]);
  if (keys.some((key) => !allowed.has(key))) throw localError("Update notice result is invalid");
  if (value.availableVersion !== undefined && !validateVersion(value.availableVersion)) {
    throw localError("Update notice result version is invalid");
  }
  if (value.releaseUrl !== undefined &&
      (typeof value.releaseUrl !== "string" ||
       !/^https:\/\/github\.com\/stephen-taipei\/better-workflows\/releases\/tag\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value.releaseUrl))) {
    throw localError("Update notice result URL is invalid");
  }
  if ((value.availableVersion === undefined) !== (value.releaseUrl === undefined)) {
    throw localError("Update notice result release metadata is incomplete");
  }
  if (value.availableVersion !== undefined &&
      value.releaseUrl !== releaseUrlForTag(`v${value.availableVersion}`)) {
    throw localError("Update notice result release metadata does not match");
  }
  if (value.reason !== undefined && !validReason(value.reason)) {
    throw localError("Update notice result reason is invalid");
  }
  if (value.status === "available" && (value.availableVersion === undefined || value.releaseUrl === undefined)) {
    throw localError("Update notice available result is incomplete");
  }
  if (value.status === "unknown" && (value.availableVersion !== undefined || value.releaseUrl !== undefined)) {
    throw localError("Update notice unknown result contains release metadata");
  }
  if (value.status === "unknown" && value.reason === undefined) {
    throw localError("Update notice unknown result is incomplete");
  }
  return value;
}

function parseAttemptName(name) {
  const match = ATTEMPT_NAME.exec(name);
  if (!match) throw localError("Update notice attempt is unsafe");
  const at = Number(match[1]);
  if (!Number.isSafeInteger(at) || at < 0) throw localError("Update notice attempt is invalid");
  return at;
}

async function readAttempts(root) {
  const directory = attemptsPath(root);
  const exists = await assertPrivateDirectory(directory, "Update notice attempts directory", { allowMissing: true });
  if (!exists) return [];
  const names = await readdir(directory);
  const attempts = [];
  for (const name of names) {
    const at = parseAttemptName(name);
    const target = path.join(directory, name);
    // A competing caller may remove its own losing claim after readdir().
    // Treat only that disappearance as benign; an existing unsafe entry still
    // fails the private-state check below.
    const info = await lstatOrNull(target);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw localError("Update notice attempt is unsafe");
    }
    assertPrivateMode(info, "Update notice attempt");
    attempts.push({ name, at, path: target });
  }
  return attempts.sort((left, right) => left.at - right.at || left.name.localeCompare(right.name));
}

async function loadState(rootInput) {
  const root = resolveRoot(rootInput);
  const rootExists = await assertRootDirectory(root, { allowMissing: true });
  if (!rootExists) {
    return { root, stateExists: false, mode: "manual", result: null, attempts: [] };
  }
  const state = statePath(root);
  const stateExists = await assertPrivateDirectory(state, "Update notice state directory", { allowMissing: true });
  if (!stateExists) {
    return { root, stateExists: false, mode: "manual", result: null, attempts: [] };
  }
  const stateEntries = await readdir(state);
  const allowedEntries = new Set([SETTINGS_FILE, RESULT_FILE, ATTEMPTS_DIRECTORY]);
  if (stateEntries.some((name) => !allowedEntries.has(name) && !TEMP_FILE.test(name))) {
    throw localError("Update notice state contains an unsafe entry");
  }
  for (const name of stateEntries.filter((entry) => TEMP_FILE.test(entry))) {
    // An atomic writer may rename or remove this recognized temporary file
    // after readdir() and before this validation pass.  Its disappearance is
    // benign; only an existing residue needs the private-file checks below.
    const temporaryInfo = await lstatOrNull(path.join(state, name));
    if (!temporaryInfo) continue;
    if (temporaryInfo.isSymbolicLink() || !temporaryInfo.isFile() || temporaryInfo.nlink !== 1) {
      throw localError("Update notice temporary state file is unsafe");
    }
    assertPrivateMode(temporaryInfo, "Update notice temporary state file");
  }
  const settingsInfo = await lstatOrNull(settingsPath(root));
  let mode = "manual";
  if (settingsInfo) {
    mode = validateSettings(await readPrivateJson(root, settingsPath(root), "Update notice settings"));
  }
  const resultInfo = await lstatOrNull(resultPath(root));
  const result = resultInfo
    ? validateStoredResult(await readPrivateJson(root, resultPath(root), "Update notice result"))
    : null;
  const attempts = await readAttempts(root);
  return { root, stateExists: true, mode, result, attempts };
}

function cloneRunning(running) {
  if (running === null || running === undefined) return null;
  if (!isObject(running) || typeof running.semanticVersion !== "string" ||
      typeof running.buildVersion !== "string" || typeof running.bundleDigest !== "string" ||
      !validateVersion(running.semanticVersion)) {
    throw localError("Running plugin bundle is invalid");
  }
  return {
    semanticVersion: running.semanticVersion,
    buildVersion: running.buildVersion,
    bundleDigest: running.bundleDigest
  };
}

function compareVersions(left, right) {
  const leftParts = String(left).split(".").map((part) => BigInt(part));
  const rightParts = String(right).split(".").map((part) => BigInt(part));
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

function publicTime(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return new Date(value).toISOString();
}

function buildResult({ mode, status, running, availableVersion, releaseUrl, lastCheckedAt, nextCheckAt, reason }) {
  const result = { mode, status };
  if (availableVersion !== undefined) result.availableVersion = availableVersion;
  if (releaseUrl !== undefined) result.releaseUrl = releaseUrl;
  if (running !== null && running !== undefined) result.running = cloneRunning(running);
  if (lastCheckedAt !== undefined) result.lastCheckedAt = publicTime(lastCheckedAt);
  if (nextCheckAt !== undefined) result.nextCheckAt = publicTime(nextCheckAt);
  if (reason !== undefined) result.reason = reason;
  return result;
}

function newestAttempt(attempts) {
  return attempts.length > 0 ? attempts[attempts.length - 1].at : undefined;
}

function resultForState(state, running) {
  if (state.mode === "off") {
    return buildResult({ mode: "off", status: "disabled", running, reason: "MODE_OFF" });
  }
  const latestAttempt = newestAttempt(state.attempts);
  const latestCheckedAt = Math.max(
    state.result?.lastCheckedAt ?? -1,
    latestAttempt ?? -1
  );
  if (running === null) {
    return buildResult({
      mode: state.mode,
      status: "unknown",
      lastCheckedAt: latestCheckedAt >= 0 ? latestCheckedAt : undefined,
      nextCheckAt: latestCheckedAt >= 0 ? latestCheckedAt + UPDATE_NOTICE_INTERVAL_MS : undefined,
      reason: state.result ? "RUNNING_REQUIRED" : "NOT_CHECKED"
    });
  }
  if (state.result) {
    if ((state.result.status === "available" || state.result.status === "current") &&
        state.result.availableVersion !== undefined &&
        compareVersions(state.result.availableVersion, running.semanticVersion) <= 0) {
      return buildResult({
        mode: state.mode,
        status: "current",
        running,
        availableVersion: state.result.availableVersion,
        releaseUrl: state.result.releaseUrl,
        lastCheckedAt: state.result.lastCheckedAt,
        nextCheckAt: state.result.lastCheckedAt + UPDATE_NOTICE_INTERVAL_MS
      });
    }
    if (state.result.status === "current" && state.result.availableVersion !== undefined) {
      return buildResult({
        mode: state.mode,
        status: "available",
        running,
        availableVersion: state.result.availableVersion,
        releaseUrl: state.result.releaseUrl,
        lastCheckedAt: state.result.lastCheckedAt,
        nextCheckAt: state.result.lastCheckedAt + UPDATE_NOTICE_INTERVAL_MS
      });
    }
    return buildResult({
      mode: state.mode,
      status: state.result.status,
      running,
      availableVersion: state.result.availableVersion,
      releaseUrl: state.result.releaseUrl,
      lastCheckedAt: state.result.lastCheckedAt,
      nextCheckAt: state.result.lastCheckedAt + UPDATE_NOTICE_INTERVAL_MS,
      reason: state.result.reason
    });
  }
  return buildResult({
    mode: state.mode,
    status: "unknown",
    running,
    lastCheckedAt: latestAttempt,
    nextCheckAt: latestAttempt === undefined ? undefined : latestAttempt + UPDATE_NOTICE_INTERVAL_MS,
    reason: latestAttempt === undefined ? "NOT_CHECKED" : "IN_FLIGHT"
  });
}

/**
 * Capture the exact running bundle once.  Callers should hold this immutable
 * snapshot and pass it to checkForUpdates; the update check never recaptures
 * or mutates it.
 */
export async function captureRunningBundle() {
  const manifestPath = path.join(pluginRoot(), ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isObject(manifest) || typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw localError("Plugin manifest version is invalid");
  }
  return Object.freeze({
    semanticVersion: VERSION,
    buildVersion: manifest.version,
    bundleDigest: await pluginBundleDigest()
  });
}

export async function readUpdateStatus({ root, running = null } = {}) {
  let runningSnapshot;
  try {
    runningSnapshot = cloneRunning(running);
  } catch (error) {
    return buildResult({ mode: "manual", status: "unknown", reason: "RUNNING_INVALID" });
  }
  try {
    const state = await loadState(root);
    return resultForState(state, runningSnapshot);
  } catch {
    return buildResult({ mode: "manual", status: "unknown", running: runningSnapshot, reason: "STATE_INVALID" });
  }
}

export async function configureUpdateMode(mode, { root } = {}) {
  validateMode(mode);
  const resolvedRoot = resolveRoot(root);
  await ensureStateDirectory(resolvedRoot);
  await atomicWritePrivateJson(
    resolvedRoot,
    settingsPath(resolvedRoot),
    { schemaVersion: UPDATE_NOTICE_STATE_VERSION, mode },
    "Update notice settings"
  );
  return readUpdateStatus({ root: resolvedRoot, running: null });
}

function releaseUrlForTag(tag) {
  return `https://github.com/stephen-taipei/better-workflows/releases/tag/${tag}`;
}

class UpdateNoticeResponseError extends Error {}

function validateReleasePayload(value) {
  if (!isObject(value) || value.draft !== false || value.prerelease !== false ||
      typeof value.tag_name !== "string" || typeof value.html_url !== "string") {
    throw new UpdateNoticeResponseError("invalid release payload");
  }
  const match = RELEASE_TAG.exec(value.tag_name);
  if (!match) throw new UpdateNoticeResponseError("invalid release tag");
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  const releaseUrl = releaseUrlForTag(value.tag_name);
  if (value.html_url !== releaseUrl) throw new UpdateNoticeResponseError("invalid release URL");
  return { version, releaseUrl };
}

class UpdateNoticeTimeout extends Error {}

async function readLimitedBody(response, onReader) {
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    onReader(reader);
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value ?? "");
        total += chunk.byteLength;
        if (total > UPDATE_NOTICE_MAX_BODY_BYTES) throw new Error("body too large");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      try {
        void Promise.resolve(reader.cancel()).catch(() => {});
      } catch {
        // The bounded response result is already determined.
      }
      throw error;
    } finally {
      onReader(null);
    }
  }
  // A body without a bounded reader cannot prove the 64 KiB stream limit.
  // Native fetch exposes a ReadableStream; injected tests should do the same.
  throw new UpdateNoticeResponseError("response body stream is unavailable");
}

async function cancelResponseBody(response) {
  try {
    if (response?.body && typeof response.body.cancel === "function") {
      await response.body.cancel();
    }
  } catch {
    // Cancellation is best effort; the public result remains bounded.
  }
}

async function fetchLatestRelease(fetchImpl) {
  if (typeof fetchImpl !== "function") return { ok: false, reason: "NETWORK_ERROR" };
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  let activeReader = null;
  let responseReceived = false;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new UpdateNoticeTimeout("update notice request timed out"));
    }, UPDATE_NOTICE_TIMEOUT_MS);
  });
  const request = Promise.resolve().then(() => fetchImpl(UPDATE_NOTICE_ENDPOINT, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "better-workflows-update-notice/1"
    },
    credentials: "omit",
    redirect: "error",
    signal: controller.signal
  }));
  // If an injected fetch ignores AbortSignal and settles after the deadline,
  // consume that late settlement and cancel any response body it produced.
  void request.then((response) => {
    if (timedOut) void cancelResponseBody(response);
  }, () => {});
  try {
    const response = await Promise.race([request, deadline]);
    responseReceived = true;
    if (!response || typeof response !== "object" || response.url !== UPDATE_NOTICE_ENDPOINT) {
      throw new UpdateNoticeResponseError("response URL is invalid");
    }
    if (response.status !== 200) {
      void cancelResponseBody(response);
      return { ok: false, reason: response.status === 404 ? "HTTP_404" : "HTTP_STATUS" };
    }
    const body = await Promise.race([
      readLimitedBody(response, (reader) => { activeReader = reader; }),
      deadline
    ]);
    let payload = body;
    if (typeof body === "string") {
      try {
        payload = JSON.parse(body);
      } catch {
        throw new UpdateNoticeResponseError("response JSON is invalid");
      }
    }
    return { ok: true, release: validateReleasePayload(payload) };
  } catch (error) {
    if (error instanceof UpdateNoticeTimeout || timedOut) return { ok: false, reason: "TIMEOUT" };
    if (error instanceof UpdateNoticeResponseError) return { ok: false, reason: "RESPONSE_INVALID" };
    if (responseReceived) return { ok: false, reason: "RESPONSE_INVALID" };
    return { ok: false, reason: "NETWORK_ERROR" };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (activeReader) {
      try {
        void Promise.resolve(activeReader.cancel()).catch(() => {});
      } catch {
        // Cancellation is best effort after the fixed deadline.
      }
      activeReader = null;
    }
    // Keep the promise rejection handled even when a fake implementation
    // returns after the total deadline has already completed the check.
    void rejectDeadline;
  }
}

function isRecent(at, nowValue) {
  return at > nowValue || nowValue - at < UPDATE_NOTICE_INTERVAL_MS;
}

function publicFailure(mode, running, reason, lastCheckedAt) {
  return buildResult({ mode, status: "unknown", running, reason, lastCheckedAt });
}

async function acquireAttempt(root, nowValue, { automatic, result }) {
  const directory = await ensureAttemptsDirectory(root);
  const existing = await readAttempts(root);
  const completedAt = result?.lastCheckedAt ?? -1;
  const isBlocking = (attempt) => isRecent(attempt.at, nowValue) &&
    (automatic || attempt.at > completedAt);
  if (existing.some(isBlocking)) {
    return { acquired: false, reason: automatic ? "RATE_LIMITED" : "CONCURRENT_ATTEMPT", lastCheckedAt: newestAttempt(existing) };
  }
  const name = `${ATTEMPT_PREFIX}${nowValue}-${randomUUID()}`;
  const owned = path.join(directory, name);
  await mkdir(owned, { mode: 0o700 });
  await chmod(owned, 0o700);
  const after = await readAttempts(root);
  const others = after.filter((attempt) => attempt.name !== name).filter(isBlocking);
  if (others.length > 0) {
    // This is the only path that removes a claim, and it removes only the
    // unique directory created by this invocation.
    const ownedInfo = await lstatOrNull(owned);
    if (ownedInfo && ownedInfo.isDirectory() && !ownedInfo.isSymbolicLink()) {
      await rmdir(owned).catch(() => {});
    }
    return {
      acquired: false,
      reason: automatic ? "RATE_LIMITED" : "CONCURRENT_ATTEMPT",
      lastCheckedAt: newestAttempt(after)
    };
  }
  return { acquired: true, path: owned };
}

function storedResultForRelease(mode, running, release, checkedAt) {
  const comparison = compareVersions(release.version, running.semanticVersion);
  return comparison > 0
    ? {
        mode,
        status: "available",
        running,
        availableVersion: release.version,
        releaseUrl: release.releaseUrl,
        lastCheckedAt: checkedAt
      }
    : {
        mode,
        status: "current",
        running,
        availableVersion: release.version,
        releaseUrl: release.releaseUrl,
        lastCheckedAt: checkedAt
      };
}

async function persistResult(root, result) {
  const checkedAt = typeof result.lastCheckedAt === "number"
    ? result.lastCheckedAt
    : Date.parse(String(result.lastCheckedAt));
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) {
    throw localError("Update notice result timestamp is invalid");
  }
  const stored = {
    schemaVersion: UPDATE_NOTICE_STATE_VERSION,
    status: result.status,
    lastCheckedAt: checkedAt
  };
  if (result.availableVersion !== undefined) stored.availableVersion = result.availableVersion;
  if (result.releaseUrl !== undefined) stored.releaseUrl = result.releaseUrl;
  if (result.reason !== undefined) stored.reason = result.reason;
  await atomicWritePrivateJson(root, resultPath(root), stored, "Update notice result");
}

export async function checkForUpdates({
  root,
  running,
  automatic = false,
  fetchImpl = globalThis.fetch,
  now = () => Date.now()
} = {}) {
  let runningSnapshot;
  try {
    runningSnapshot = cloneRunning(running);
  } catch {
    return publicFailure("manual", null, "RUNNING_INVALID");
  }
  if (runningSnapshot === null) return publicFailure("manual", null, "RUNNING_REQUIRED");
  let nowValue;
  try {
    nowValue = validateNow(now);
  } catch {
    return publicFailure("manual", runningSnapshot, "STATE_INVALID");
  }
  let state;
  try {
    state = await loadState(root);
  } catch (error) {
    return publicFailure("manual", runningSnapshot, "STATE_INVALID");
  }
  if (state.mode === "off") {
    return buildResult({ mode: "off", status: "disabled", running: runningSnapshot, reason: "MODE_OFF" });
  }
  if (automatic === true && state.mode !== "automatic") {
    return buildResult({ mode: state.mode, status: "skipped", running: runningSnapshot, reason: "AUTOMATIC_DISABLED" });
  }
  try {
    await ensureStateDirectory(state.root);
    // Re-read after creating the state directory so a concurrent configure
    // operation wins without an update check overwriting its settings.
    state = await loadState(state.root);
    if (state.mode === "off") {
      return buildResult({ mode: "off", status: "disabled", running: runningSnapshot, reason: "MODE_OFF" });
    }
    if (automatic === true && state.mode !== "automatic") {
      return buildResult({ mode: state.mode, status: "skipped", running: runningSnapshot, reason: "AUTOMATIC_DISABLED" });
    }
    const attempt = await acquireAttempt(state.root, nowValue, {
      automatic: automatic === true,
      result: state.result
    });
    if (!attempt.acquired) {
      return buildResult({
        mode: state.mode,
        status: "skipped",
        running: runningSnapshot,
        lastCheckedAt: attempt.lastCheckedAt,
        reason: attempt.reason
      });
    }
    const outcome = await fetchLatestRelease(fetchImpl);
    if (!outcome.ok) {
      const failure = publicFailure(state.mode, runningSnapshot, outcome.reason, nowValue);
      await persistResult(state.root, failure);
      return failure;
    }
    const success = storedResultForRelease(state.mode, runningSnapshot, outcome.release, nowValue);
    const publicSuccess = buildResult(success);
    await persistResult(state.root, publicSuccess);
    return publicSuccess;
  } catch {
    // Claims are intentionally left in place on every failure, including a
    // crash between claim creation and result persistence.  Only fixed public
    // reason codes escape this boundary.
    return publicFailure(state.mode, runningSnapshot, "STATE_INVALID", nowValue);
  }
}
