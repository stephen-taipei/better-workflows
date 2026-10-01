import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, lstat, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertNoSymlinkUnder,
  digestObject,
  ensurePrivateDir,
  getStateRoot,
  safeJoin
} from "./core.mjs";

export const SCOPED_SQLITE_MUTEX_SCHEMA_VERSION = 1;
export const SCOPED_SQLITE_MUTEX_KIND = "ScopedSqliteMutexV1";
export const SCOPED_SQLITE_MUTEX_STORE_DIRECTORY = "coordination-v1";
export const SCOPED_SQLITE_MUTEX_DATABASE_NAME = "scoped-sqlite-mutex-v1.sqlite";

const TABLE = "scoped_mutex_v1";
const DIGEST = /^[a-f0-9]{64}$/;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const OWNER_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_LEASE_MS = 30_000;
const MAX_LEASE_MS = 10 * 60_000;
const DEFAULT_BUSY_RETRY_MS = 1_000;
const MAX_BUSY_RETRY_MS = 5_000;
const DEFAULT_BUSY_RETRY_DELAY_MS = 10;
const MAX_BUSY_RETRY_DELAY_MS = 250;
const LOCAL_HOST = os.hostname();
const PROCESS_START_IDENTITY = `${new Date(Date.now() - Math.floor(process.uptime() * 1_000)).toISOString()}#${randomUUID()}`;

let sqliteModulePromise = null;

export class ScopedSqliteMutexError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ScopedSqliteMutexError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new ScopedSqliteMutexError(code, message, details);
}

function hold(code, message, details = undefined) {
  fail(code, message, { status: "HOLD", ...details });
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("ESCOPED_MUTEX_INVALID", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("ESCOPED_MUTEX_INVALID", `${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("ESCOPED_MUTEX_INVALID", `${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      fail("ESCOPED_MUTEX_INVALID", `${label}.${key} must be a data property`);
    }
  }
  return value;
}

function assertOptions(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Reflect.ownKeys(value).filter((key) => typeof key !== "string" || !allowed.has(key));
  if (unknown.length > 0) {
    fail("ESCOPED_MUTEX_INVALID", `${label} contains unknown field(s): ${unknown.map(String).sort().join(", ")}`);
  }
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("ESCOPED_MUTEX_INVALID", `${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function namespaceValue(value) {
  if (typeof value !== "string" || !NAMESPACE.test(value)) {
    fail("ESCOPED_MUTEX_INVALID", "namespace must be a bounded stable identifier");
  }
  return value;
}

function digestValue(value, label = "resourceDigest") {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail("ESCOPED_MUTEX_INVALID", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function stateRootValue(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("ESCOPED_MUTEX_INVALID", "stateRoot must be a non-empty filesystem path");
  }
  return path.resolve(value);
}

function runtimeVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) return null;
  return match.slice(1, 4).map(Number);
}

/**
 * node:sqlite became a supported Better Workflows dependency at Node 22.13.
 * Keep this check explicit so an older runtime fails closed before touching
 * state rather than falling through to a different lock implementation.
 */
export function assertScopedSqliteMutexRuntimeV1(version = process.versions.node) {
  const parsed = runtimeVersion(version);
  if (!parsed || parsed[0] < 22 || (parsed[0] === 22 && parsed[1] < 13)) {
    hold(
      "ESCOPED_MUTEX_RUNTIME_UNSUPPORTED",
      "scoped SQLite mutex requires Node 22.13 or newer",
      { observedVersion: typeof version === "string" ? version : null }
    );
  }
  return Object.freeze({ major: parsed[0], minor: parsed[1], patch: parsed[2] });
}

async function loadSqlite() {
  assertScopedSqliteMutexRuntimeV1();
  sqliteModulePromise ??= import("node:sqlite").catch((error) => {
    sqliteModulePromise = null;
    throw error;
  });
  let sqlite;
  try {
    sqlite = await sqliteModulePromise;
  } catch {
    hold("ESCOPED_MUTEX_RUNTIME_UNSUPPORTED", "node:sqlite is unavailable in this runtime");
  }
  if (typeof sqlite?.DatabaseSync !== "function") {
    hold("ESCOPED_MUTEX_RUNTIME_UNSUPPORTED", "node:sqlite DatabaseSync is unavailable in this runtime");
  }
  return sqlite;
}

export function scopedSqliteMutexDatabasePathV1(stateRoot = getStateRoot()) {
  const root = stateRootValue(stateRoot);
  return safeJoin(root, SCOPED_SQLITE_MUTEX_STORE_DIRECTORY, SCOPED_SQLITE_MUTEX_DATABASE_NAME);
}

async function ensurePrivateDatabaseFile(stateRoot) {
  const root = stateRootValue(stateRoot);
  await ensurePrivateDir(root);
  const directory = safeJoin(root, SCOPED_SQLITE_MUTEX_STORE_DIRECTORY);
  await assertNoSymlinkUnder(root, directory);
  await ensurePrivateDir(directory);
  const databasePath = safeJoin(directory, SCOPED_SQLITE_MUTEX_DATABASE_NAME);
  await assertNoSymlinkUnder(root, databasePath);
  let handle;
  try {
    handle = await open(
      databasePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );
  } catch (error) {
    if (error?.code !== "EEXIST") {
      hold("ESCOPED_MUTEX_STORAGE", "scoped mutex database could not be created");
    }
  } finally {
    if (handle) await handle.close();
  }
  let info;
  try {
    info = await lstat(databasePath);
  } catch {
    hold("ESCOPED_MUTEX_STORAGE", "scoped mutex database could not be inspected");
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    hold("ESCOPED_MUTEX_STORAGE", "scoped mutex database must be a regular single-link file");
  }
  try {
    await chmod(databasePath, 0o600);
  } catch {
    hold("ESCOPED_MUTEX_STORAGE", "scoped mutex database permissions could not be secured");
  }
  return databasePath;
}

function isSqliteBusy(error) {
  const code = `${error?.code ?? ""} ${error?.errcode ?? ""} ${error?.errstr ?? ""}`.toUpperCase();
  const message = String(error?.message ?? "").toUpperCase();
  return code.includes("SQLITE_BUSY") || code.includes("SQLITE_LOCKED") ||
    message.includes("DATABASE IS LOCKED") || message.includes("DATABASE TABLE IS LOCKED");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryPolicy(options) {
  const busyRetryMs = options.busyRetryMs === undefined
    ? DEFAULT_BUSY_RETRY_MS
    : boundedInteger(options.busyRetryMs, "busyRetryMs", 0, MAX_BUSY_RETRY_MS);
  const busyRetryDelayMs = options.busyRetryDelayMs === undefined
    ? DEFAULT_BUSY_RETRY_DELAY_MS
    : boundedInteger(options.busyRetryDelayMs, "busyRetryDelayMs", 1, MAX_BUSY_RETRY_DELAY_MS);
  return { busyRetryMs, busyRetryDelayMs };
}

function initializeDatabase(database) {
  database.exec("PRAGMA busy_timeout = 0");
  database.exec("PRAGMA journal_mode = DELETE");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      mutex_key TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      resource_digest TEXT NOT NULL,
      owner_token TEXT NOT NULL,
      owner_host TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      owner_start_identity TEXT NOT NULL,
      fence INTEGER NOT NULL,
      version INTEGER NOT NULL,
      acquired_at_ms INTEGER NOT NULL,
      renewed_at_ms INTEGER NOT NULL,
      lease_until_ms INTEGER NOT NULL,
      UNIQUE(namespace, resource_digest),
      CHECK(fence >= 1),
      CHECK(version >= 1),
      CHECK(owner_pid >= 1),
      CHECK(lease_until_ms >= renewed_at_ms)
    ) STRICT
  `);
}

function transaction(database, callback) {
  let begun = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    begun = true;
    const result = callback(database);
    database.exec("COMMIT");
    begun = false;
    return result;
  } catch (error) {
    if (begun) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Closing DatabaseSync below performs the final rollback. Preserve the
        // original error because it carries the fail-closed ownership result.
      }
    }
    throw error;
  }
}

async function withDatabase(stateRoot, policy, callback) {
  const sqlite = await loadSqlite();
  const databasePath = await ensurePrivateDatabaseFile(stateRoot);
  const deadline = Date.now() + policy.busyRetryMs;
  let attempts = 0;
  while (true) {
    attempts += 1;
    let database;
    try {
      database = new sqlite.DatabaseSync(databasePath);
      initializeDatabase(database);
      return callback(database);
    } catch (error) {
      if (error instanceof ScopedSqliteMutexError) throw error;
      if (!isSqliteBusy(error)) {
        hold("ESCOPED_MUTEX_STORAGE", "scoped mutex database operation failed");
      }
      if (Date.now() >= deadline) {
        hold("ESCOPED_MUTEX_BUSY", "scoped mutex database remained busy beyond the bounded retry window", { attempts });
      }
    } finally {
      try {
        database?.close();
      } catch {
        // A failed close cannot make an uncommitted transaction authoritative.
      }
    }
    const remaining = Math.max(0, deadline - Date.now());
    await sleep(Math.min(policy.busyRetryDelayMs, remaining));
  }
}

function rowForKey(database, mutexKey) {
  return database.prepare(`
    SELECT mutex_key, namespace, resource_digest, owner_token, owner_host,
           owner_pid, owner_start_identity, fence, version, acquired_at_ms,
           renewed_at_ms, lease_until_ms
      FROM ${TABLE}
     WHERE mutex_key = ?
  `).get(mutexKey) ?? null;
}

function validateOwnerRow(row, expected) {
  if (!row || typeof row !== "object") hold("ESCOPED_MUTEX_INTEGRITY", "scoped mutex owner row is missing");
  if (
    row.mutex_key !== expected.mutexKey ||
    row.namespace !== expected.namespace ||
    row.resource_digest !== expected.resourceDigest ||
    typeof row.owner_token !== "string" || !OWNER_TOKEN.test(row.owner_token) ||
    typeof row.owner_host !== "string" || row.owner_host.length === 0 || row.owner_host.length > 255 ||
    !Number.isSafeInteger(row.owner_pid) || row.owner_pid < 1 ||
    typeof row.owner_start_identity !== "string" || row.owner_start_identity.length === 0 || row.owner_start_identity.length > 256 ||
    !Number.isSafeInteger(row.fence) || row.fence < 1 ||
    !Number.isSafeInteger(row.version) || row.version < 1 ||
    !Number.isSafeInteger(row.acquired_at_ms) ||
    !Number.isSafeInteger(row.renewed_at_ms) ||
    !Number.isSafeInteger(row.lease_until_ms) ||
    row.lease_until_ms < row.renewed_at_ms
  ) {
    hold("ESCOPED_MUTEX_INTEGRITY", "scoped mutex owner row is malformed");
  }
  return row;
}

function ownerLiveness(row) {
  if (row.owner_host !== LOCAL_HOST) return "cross-host";
  // ESRCH is the only reclaim proof.  A successful signal probe is treated as
  // live even when the PID may have been reused: the stored start identity is
  // metadata and cannot independently prove that this process incarnation is
  // the original owner, so PID reuse remains HOLD/fail-closed.
  try {
    process.kill(row.owner_pid, 0);
    return "live";
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    return "unknown";
  }
}

function ownerConflict(row, mutexKey) {
  // lease_until_ms is heartbeat metadata for observability and renewal.  It
  // never authorizes automatic expiry or reclamation; only ESRCH above does.
  const liveness = ownerLiveness(row);
  if (liveness === "cross-host") {
    hold("ESCOPED_MUTEX_CROSS_HOST", "scoped mutex belongs to another host and cannot be recovered automatically", { mutexKey });
  }
  if (liveness === "live") {
    hold("ESCOPED_MUTEX_HELD", "scoped mutex is held by a live owner", { mutexKey });
  }
  if (liveness !== "dead") {
    hold("ESCOPED_MUTEX_OWNER_UNKNOWN", "scoped mutex owner liveness could not be proven", { mutexKey });
  }
  return "dead";
}

function snapshot(row, recovered = false) {
  return Object.freeze({
    schemaVersion: SCOPED_SQLITE_MUTEX_SCHEMA_VERSION,
    kind: SCOPED_SQLITE_MUTEX_KIND,
    mutexKey: row.mutex_key,
    namespace: row.namespace,
    resourceDigest: row.resource_digest,
    ownerToken: row.owner_token,
    fence: Number(row.fence),
    version: Number(row.version),
    acquiredAtMs: Number(row.acquired_at_ms),
    renewedAtMs: Number(row.renewed_at_ms),
    leaseUntilMs: Number(row.lease_until_ms),
    recovered
  });
}

function newOwner(namespace, resourceDigest, mutexKey, leaseMs) {
  const now = Date.now();
  return {
    mutex_key: mutexKey,
    namespace,
    resource_digest: resourceDigest,
    owner_token: randomUUID(),
    owner_host: LOCAL_HOST,
    owner_pid: process.pid,
    owner_start_identity: PROCESS_START_IDENTITY,
    fence: 1,
    version: 1,
    acquired_at_ms: now,
    renewed_at_ms: now,
    lease_until_ms: now + leaseMs
  };
}

function insertOwner(database, owner) {
  database.prepare(`
    INSERT INTO ${TABLE} (
      mutex_key, namespace, resource_digest, owner_token, owner_host,
      owner_pid, owner_start_identity, fence, version, acquired_at_ms,
      renewed_at_ms, lease_until_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    owner.mutex_key,
    owner.namespace,
    owner.resource_digest,
    owner.owner_token,
    owner.owner_host,
    owner.owner_pid,
    owner.owner_start_identity,
    owner.fence,
    owner.version,
    owner.acquired_at_ms,
    owner.renewed_at_ms,
    owner.lease_until_ms
  );
}

function createHandle({ stateRoot, policy, owner, leaseMs, recovered }) {
  let version = owner.version;
  let lastRenewedAtMs = owner.renewed_at_ms;
  let leaseUntilMs = owner.lease_until_ms;
  let released = false;
  let operationChain = Promise.resolve();
  const expected = {
    mutexKey: owner.mutex_key,
    namespace: owner.namespace,
    resourceDigest: owner.resource_digest
  };

  const serialize = (callback) => {
    const operation = operationChain.then(callback, callback);
    operationChain = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const currentSnapshot = () => snapshot({
    ...owner,
    version,
    renewed_at_ms: lastRenewedAtMs,
    lease_until_ms: leaseUntilMs
  }, recovered);

  const handle = {
    get mutexKey() { return owner.mutex_key; },
    get namespace() { return owner.namespace; },
    get resourceDigest() { return owner.resource_digest; },
    get ownerToken() { return owner.owner_token; },
    get fence() { return owner.fence; },
    get recovered() { return recovered; },
    snapshot: currentSnapshot,
    assertOwned() {
      return serialize(async () => {
        if (released) hold("ESCOPED_MUTEX_LOST", "scoped mutex has already been released", { mutexKey: owner.mutex_key });
        const observedLeaseUntilMs = await withDatabase(stateRoot, policy, (database) => transaction(database, (active) => {
          const row = rowForKey(active, owner.mutex_key);
          if (!row) hold("ESCOPED_MUTEX_LOST", "scoped mutex ownership is no longer present", { mutexKey: owner.mutex_key });
          validateOwnerRow(row, expected);
          if (
            row.owner_token !== owner.owner_token ||
            row.owner_host !== owner.owner_host ||
            row.owner_pid !== owner.owner_pid ||
            row.owner_start_identity !== owner.owner_start_identity ||
            row.fence !== owner.fence ||
            row.version !== version
          ) {
            hold("ESCOPED_MUTEX_LOST", "scoped mutex ownership changed", { mutexKey: owner.mutex_key });
          }
          return Number(row.lease_until_ms);
        }));
        leaseUntilMs = observedLeaseUntilMs;
        return currentSnapshot();
      });
    },
    renew(options = {}) {
      return serialize(async () => {
        assertOptions(options, new Set(["leaseMs"]), "renew options");
        if (released) hold("ESCOPED_MUTEX_LOST", "scoped mutex has already been released", { mutexKey: owner.mutex_key });
        const nextLeaseMs = options.leaseMs === undefined
          ? leaseMs
          : boundedInteger(options.leaseMs, "renew.leaseMs", 100, MAX_LEASE_MS);
        const renewedAtMs = Date.now();
        const nextVersion = version + 1;
        const nextLeaseUntilMs = renewedAtMs + nextLeaseMs;
        await withDatabase(stateRoot, policy, (database) => transaction(database, (active) => {
          const changed = active.prepare(`
            UPDATE ${TABLE}
               SET version = ?, renewed_at_ms = ?, lease_until_ms = ?
             WHERE mutex_key = ? AND owner_token = ? AND owner_host = ?
               AND owner_pid = ? AND owner_start_identity = ?
               AND fence = ? AND version = ?
          `).run(
            nextVersion,
            renewedAtMs,
            nextLeaseUntilMs,
            owner.mutex_key,
            owner.owner_token,
            owner.owner_host,
            owner.owner_pid,
            owner.owner_start_identity,
            owner.fence,
            version
          );
          if (Number(changed.changes) !== 1) {
            hold("ESCOPED_MUTEX_LOST", "scoped mutex could not be renewed because ownership changed", { mutexKey: owner.mutex_key });
          }
          return true;
        }));
        version = nextVersion;
        lastRenewedAtMs = renewedAtMs;
        leaseUntilMs = nextLeaseUntilMs;
        return currentSnapshot();
      });
    },
    release() {
      return serialize(async () => {
        if (released) return Object.freeze({ released: false, alreadyReleased: true });
        await withDatabase(stateRoot, policy, (database) => transaction(database, (active) => {
          const changed = active.prepare(`
            DELETE FROM ${TABLE}
             WHERE mutex_key = ? AND owner_token = ? AND owner_host = ?
               AND owner_pid = ? AND owner_start_identity = ?
               AND fence = ?
          `).run(
            owner.mutex_key,
            owner.owner_token,
            owner.owner_host,
            owner.owner_pid,
            owner.owner_start_identity,
            owner.fence
          );
          if (Number(changed.changes) === 1) {
            return true;
          }
          const row = rowForKey(active, owner.mutex_key);
          if (row === null) {
            hold("ESCOPED_MUTEX_LOST", "scoped mutex disappeared before its first release", { mutexKey: owner.mutex_key });
          }
          hold("ESCOPED_MUTEX_LOST", "scoped mutex could not be released because ownership changed", { mutexKey: owner.mutex_key });
        }));
        released = true;
        return Object.freeze({ released: true, alreadyReleased: false });
      });
    }
  };
  return Object.freeze(handle);
}

/**
 * Acquire a process-scoped mutex keyed only by namespace/resourceDigest.
 * Recovery is permitted solely after the recorded local PID is proven dead by
 * ESRCH. Live/reused-PID, cross-host, EPERM, malformed, and otherwise unknown
 * owners remain HOLD. The lease is heartbeat metadata, never an expiry grant.
 */
export async function acquireScopedSqliteMutexV1(options = {}) {
  assertOptions(options, new Set([
    "stateRoot", "namespace", "resourceDigest", "leaseMs", "busyRetryMs", "busyRetryDelayMs"
  ]), "acquireScopedSqliteMutexV1 options");
  const stateRoot = stateRootValue(options.stateRoot ?? getStateRoot());
  const namespace = namespaceValue(options.namespace);
  const resourceDigest = digestValue(options.resourceDigest);
  const leaseMs = options.leaseMs === undefined
    ? DEFAULT_LEASE_MS
    : boundedInteger(options.leaseMs, "leaseMs", 100, MAX_LEASE_MS);
  const policy = retryPolicy(options);
  const mutexKey = digestObject({ namespace, resourceDigest });
  const proposed = newOwner(namespace, resourceDigest, mutexKey, leaseMs);

  const acquired = await withDatabase(stateRoot, policy, (database) => transaction(database, (active) => {
    const present = rowForKey(active, mutexKey);
    if (present === null) {
      insertOwner(active, proposed);
      return { owner: proposed, recovered: false };
    }
    const prior = validateOwnerRow(present, { mutexKey, namespace, resourceDigest });
    ownerConflict(prior, mutexKey);
    const now = Date.now();
    const recoveredOwner = {
      ...proposed,
      fence: Number(prior.fence) + 1,
      version: Number(prior.version) + 1,
      acquired_at_ms: now,
      renewed_at_ms: now,
      lease_until_ms: now + leaseMs
    };
    const changed = active.prepare(`
      UPDATE ${TABLE}
         SET owner_token = ?, owner_host = ?, owner_pid = ?,
             owner_start_identity = ?, fence = ?, version = ?,
             acquired_at_ms = ?, renewed_at_ms = ?, lease_until_ms = ?
       WHERE mutex_key = ? AND owner_token = ? AND version = ?
    `).run(
      recoveredOwner.owner_token,
      recoveredOwner.owner_host,
      recoveredOwner.owner_pid,
      recoveredOwner.owner_start_identity,
      recoveredOwner.fence,
      recoveredOwner.version,
      recoveredOwner.acquired_at_ms,
      recoveredOwner.renewed_at_ms,
      recoveredOwner.lease_until_ms,
      mutexKey,
      prior.owner_token,
      prior.version
    );
    if (Number(changed.changes) !== 1) {
      hold("ESCOPED_MUTEX_OWNER_UNKNOWN", "scoped mutex changed during dead-owner recovery", { mutexKey });
    }
    return { owner: recoveredOwner, recovered: true };
  }));

  return createHandle({ stateRoot, policy, owner: acquired.owner, leaseMs, recovered: acquired.recovered });
}
