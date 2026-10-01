// SPDX-License-Identifier: AGPL-3.0-only
// Local crash-durable storage for the W5 operation reducer. Inputs must be
// plain data; JavaScript Proxies are outside this boundary. This journal does
// not authenticate provider evidence, prove that no older journal was restored,
// or grant stable release authority.
import { createHash } from "node:crypto";
import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { assertNoSymlinkUnder, atomicWriteJson, ensurePrivateDir, safeJoin } from "./core.mjs";
import { acquireScopedSqliteMutexV1 } from "./scoped-sqlite-mutex-v1.mjs";
import {
  appendW5PublicationOperationEventV1,
  replayW5PublicationOperationV1
} from "./w5-publication-operation-v1.mjs";

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_JOURNAL_BYTES = 3 * 1024 * 1024;
const NAMESPACE = "w5-publication-operation-v1";
const JOURNAL_KIND = "W5PublicationJournalV1";

export class W5PublicationJournalError extends Error {
  constructor(code, message, status = "HOLD", options) {
    super(message, options);
    this.name = "W5PublicationJournalError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = "HOLD", options) {
  throw new W5PublicationJournalError(code, message, status, options);
}

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail("EW5_JOURNAL_INVALID", `${label} has unexpected or missing fields`);
  }
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string") ||
      JSON.stringify(actual.sort()) !== JSON.stringify([...keys].sort()) ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor?.enumerable || !("value" in descriptor);
      })) fail("EW5_JOURNAL_INVALID", `${label} requires exact plain data fields`);
}

function validateIdentity(stateRoot, operationId) {
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)) {
    fail("EW5_JOURNAL_INVALID", "stateRoot must be an absolute path");
  }
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) {
    fail("EW5_JOURNAL_INVALID", "operationId is invalid");
  }
  const root = path.resolve(stateRoot);
  const directory = safeJoin(root, "w5-publication-operations");
  const operationDirectory = safeJoin(directory, operationId);
  return { root, directory, operationDirectory, journalPath: safeJoin(operationDirectory, "journal.json") };
}

async function syncDirectory(directory) {
  const handle = await open(directory, O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensureChildDirectory(parent, child) {
  try {
    await mkdir(child, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await ensurePrivateDir(child);
  // Sync on retries too: an earlier call may have created child and then
  // failed before its directory entry became durable.
  await syncDirectory(parent);
}

async function prepareBasePath(identity) {
  if (!Number.isInteger(O_NOFOLLOW) || O_NOFOLLOW <= 0) {
    fail("EW5_JOURNAL_PLATFORM", "Publication journal requires no-follow file opens");
  }
  try {
    await lstat(identity.root);
  } catch (error) {
    if (error?.code === "ENOENT") fail("EW5_JOURNAL_ROOT_MISSING", "Caller must provide an existing private state root");
    throw error;
  }
  await ensurePrivateDir(identity.root);
  await assertNoSymlinkUnder(identity.root, identity.directory);
  await ensureChildDirectory(identity.root, identity.directory);
}

async function prepareOperationPath(identity, { create = false } = {}) {
  await assertNoSymlinkUnder(identity.root, identity.operationDirectory);
  if (create) {
    await ensureChildDirectory(identity.directory, identity.operationDirectory);
  } else {
    try {
      await lstat(identity.operationDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") fail("EW5_JOURNAL_MISSING", "Publication operation directory is absent");
      throw error;
    }
    await ensurePrivateDir(identity.operationDirectory);
  }
  await assertNoSymlinkUnder(identity.root, identity.journalPath);
}

function assertFile(info) {
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
      info.size > MAX_JOURNAL_BYTES) {
    fail("EW5_JOURNAL_PATH", "Publication journal is not a bounded owner-private regular file");
  }
}

async function readEvents(identity, operationId, { missingAllowed = false } = {}) {
  let handle;
  try {
    handle = await open(identity.journalPath, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT" && missingAllowed) return { events: [], info: null };
    if (error?.code === "ENOENT") fail("EW5_JOURNAL_MISSING", "Publication journal is absent");
    throw error;
  }
  try {
    const info = await handle.stat();
    assertFile(info);
    const bytes = await handle.readFile();
    if (bytes.length !== info.size || bytes.length === 0) {
      fail("EW5_JOURNAL_CORRUPT", "Publication journal has truncated or empty bytes");
    }
    let journal;
    try {
      journal = JSON.parse(bytes.toString("utf8"));
    } catch (cause) {
      fail("EW5_JOURNAL_CORRUPT", "Publication journal contains malformed JSON", "HOLD", { cause });
    }
    exact(journal, ["schemaVersion", "kind", "operationId", "events"], "journal snapshot");
    if (journal.schemaVersion !== 1 || journal.kind !== JOURNAL_KIND || journal.operationId !== operationId ||
        !Array.isArray(journal.events)) {
      fail("EW5_JOURNAL_CORRUPT", "Publication journal snapshot identity is invalid");
    }
    replayBound(journal.events, operationId);
    return { events: journal.events, info };
  } finally {
    await handle.close();
  }
}

function replayBound(events, operationId, expectedHeadDigest, expectedEventCount) {
  const input = { events };
  if (expectedHeadDigest !== undefined || expectedEventCount !== undefined) {
    input.expectedHeadDigest = expectedHeadDigest;
    input.expectedEventCount = expectedEventCount;
  }
  const replay = replayW5PublicationOperationV1(input);
  if (replay.operationId !== null && replay.operationId !== operationId) {
    fail("EW5_JOURNAL_BINDING", "Publication journal belongs to another operation");
  }
  return replay;
}

function result(replay, journalPath, appended = null, idempotent = null) {
  return Object.freeze({
    journalPath,
    replay,
    appended,
    idempotent,
    persistence: "LOCAL_DURABLE_UNATTESTED",
    recoveryMode: replay.operationStatus === "INTENT_PENDING" || replay.operationStatus === "UNKNOWN"
      ? "RECONCILE_ONLY" : "LOCAL_ONLY",
    releaseEligible: false
  });
}

async function withOperationLock(identity, operationId, callback) {
  const resourceDigest = createHash("sha256").update(operationId).digest("hex");
  const mutex = await acquireScopedSqliteMutexV1({
    stateRoot: identity.root,
    namespace: NAMESPACE,
    resourceDigest
  });
  try {
    await mutex.assertOwned();
    return await callback();
  } finally {
    await mutex.release();
  }
}

export async function readW5PublicationJournalV1(input) {
  const keys = ["stateRoot", "operationId", ...["expectedHeadDigest", "expectedEventCount"].filter((key) => Object.hasOwn(input ?? {}, key))];
  exact(input, keys, "journal read input");
  const identity = validateIdentity(input.stateRoot, input.operationId);
  await prepareBasePath(identity);
  return withOperationLock(identity, input.operationId, async () => {
    await prepareOperationPath(identity);
    const { events } = await readEvents(identity, input.operationId);
    const replay = replayBound(events, input.operationId, input.expectedHeadDigest, input.expectedEventCount);
    return result(replay, identity.journalPath);
  });
}

export async function appendW5PublicationJournalV1(input) {
  exact(input, ["stateRoot", "operationId", "request", "expectedHeadDigest", "expectedEventCount"], "journal append input");
  const identity = validateIdentity(input.stateRoot, input.operationId);
  await prepareBasePath(identity);
  return withOperationLock(identity, input.operationId, async () => {
    await prepareOperationPath(identity, { create: true });
    const prior = await readEvents(identity, input.operationId, { missingAllowed: true });
    if (!prior.info && (await readdir(identity.operationDirectory)).length > 0) {
      fail("EW5_JOURNAL_INCOMPLETE", "Uncommitted publication snapshot requires inspection before retry");
    }
    replayBound(prior.events, input.operationId);
    const proposed = appendW5PublicationOperationEventV1({
      events: prior.events,
      request: input.request,
      expectedHeadDigest: input.expectedHeadDigest,
      expectedEventCount: input.expectedEventCount
    });
    if (proposed.event.operationId !== input.operationId) {
      fail("EW5_JOURNAL_BINDING", "Request operationId differs from the journal operationId");
    }
    if (proposed.idempotent) return result(proposed.replay, identity.journalPath, false, true);
    const journal = {
      schemaVersion: 1,
      kind: JOURNAL_KIND,
      operationId: input.operationId,
      events: proposed.events
    };
    if (Buffer.byteLength(`${JSON.stringify(journal, null, 2)}\n`, "utf8") > MAX_JOURNAL_BYTES) {
      fail("EW5_JOURNAL_LIMIT", "Publication journal would exceed its byte bound");
    }
    try {
      // A synced temp file and atomic rename preserve the previous valid
      // snapshot if a write is interrupted. atomicWriteJson also syncs the
      // operation directory after the rename.
      await atomicWriteJson(identity.root, identity.journalPath, journal);
    } catch (cause) {
      fail("EW5_JOURNAL_APPEND_UNKNOWN", "Publication journal write outcome requires reconciliation", "UNKNOWN", { cause });
    }
    let written;
    try {
      written = await readEvents(identity, input.operationId);
      const replay = replayBound(written.events, input.operationId);
      if (written.events.length !== prior.events.length + 1 || replay.headDigest !== proposed.event.eventDigest) {
        fail("EW5_JOURNAL_APPEND_UNKNOWN", "Publication journal readback differs from appended event", "UNKNOWN");
      }
      return result(replay, identity.journalPath, true, false);
    } catch (cause) {
      if (cause?.code === "EW5_JOURNAL_APPEND_UNKNOWN") throw cause;
      fail("EW5_JOURNAL_APPEND_UNKNOWN", "Publication journal readback requires reconciliation", "UNKNOWN", { cause });
    }
  });
}
