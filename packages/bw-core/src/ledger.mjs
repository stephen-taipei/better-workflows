import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { digest } from "./canonical.mjs";

const GENESIS = "0".repeat(64);

export function ledgerPath(repo) {
  return path.join(repo.stateDir, "ledger.jsonl");
}

// The last entry's seq and hash, kept beside the ledger. The chain alone cannot
// show that whole entries were cut from the end, so a ledger shorter than its
// head is broken. Editing both files together still goes unseen.
function headPath(repo) {
  return path.join(repo.stateDir, "ledger.head");
}

async function readHead(repo) {
  try {
    return JSON.parse(await readFile(headPath(repo), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null; // a ledger from before the head existed
    throw new Error("Ledger head is not valid JSON");
  }
}

function checkHead(entries, head) {
  if (!head || head.seq === 0) return;
  // A crash between appending and writing the head leaves the ledger ahead of
  // it, never behind.
  if (entries[head.seq - 1]?.hash !== head.hash) {
    throw new Error(`Ledger ends before its recorded head (entry ${head.seq}); entries were removed`);
  }
}

async function writeHead(repo, entry) {
  const temp = `${headPath(repo)}.${process.pid}`;
  await writeFile(temp, `${JSON.stringify({ seq: entry.seq, hash: entry.hash })}\n`, { mode: 0o600 });
  await rename(temp, headPath(repo));
}

function entryHash(entry) {
  const { hash, ...body } = entry;
  return digest(body);
}

// The lock is a directory holding its owner. It is taken back only from an
// owner on this machine whose process is gone, never for being old: a slow
// holder still owns it, and two writers would fork the chain.
const LOCK_WAIT_MS = 10_000;
const ORPHAN_MS = 60_000; // a lock whose owner file never got written
const held = new AsyncLocalStorage();

function lockPath(repo) {
  return path.join(repo.stateDir, "ledger.lock");
}

async function readOwner(dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function abandoned(dir, owner) {
  if (owner) return owner.host === hostname() && Number.isInteger(owner.pid) && !alive(owner.pid);
  const info = await stat(dir).catch(() => null);
  return Boolean(info) && Date.now() - info.mtimeMs > ORPHAN_MS;
}

// Moves an abandoned lock aside under a unique name, so of several waiters
// only one takes it, and puts it back if it turned out to be a new owner's.
async function takeBack(lock, owner) {
  const aside = `${lock}.reaped-${randomUUID()}`;
  try {
    await rename(lock, aside);
  } catch {
    return;
  }
  const found = await readOwner(aside);
  const same = owner ? found?.token === owner.token : !found && await abandoned(aside, null);
  if (!same) {
    await rename(aside, lock).catch(() => {});
    return;
  }
  await rm(aside, { recursive: true, force: true });
}

async function acquire(repo) {
  const lock = lockPath(repo);
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readOwner(lock);
      if (await abandoned(lock, owner)) {
        await takeBack(lock, owner);
        continue;
      }
      if (Date.now() > deadline) {
        const who = owner ? `process ${owner.pid} on ${owner.host}` : "an unknown process";
        throw new Error(`Ledger is locked by ${who}; if it is no longer running, remove ${lock}`);
      }
      await sleep(25);
      continue;
    }
    try {
      await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), token }), { mode: 0o600 });
    } catch (error) {
      await rm(lock, { recursive: true, force: true });
      throw error;
    }
    return token;
  }
}

async function release(repo, token) {
  const lock = lockPath(repo);
  if ((await readOwner(lock))?.token !== token) return;
  await rm(lock, { recursive: true, force: true });
}

// Runs fn as the only writer of the ledger. Appends inside it reuse the
// lock, so a caller can read the state, decide and record in one step.
export async function withLedgerLock(repo, fn) {
  if (held.getStore() === repo.stateDir) return fn();
  const token = await acquire(repo);
  try {
    return await held.run(repo.stateDir, fn);
  } finally {
    await release(repo, token);
  }
}

// Reads every entry and verifies the hash chain. A broken chain is an error:
// nothing built on a tampered or truncated ledger can be trusted.
export async function readLedger(repo) {
  const head = await readHead(repo);
  let text;
  try {
    text = await readFile(ledgerPath(repo), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    text = "";
  }
  const entries = [];
  let prev = GENESIS;
  const lines = text.split("\n");
  if (lines.at(-1) !== "") throw new Error("Ledger ends with an incomplete entry");
  for (const [index, line] of lines.slice(0, -1).entries()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`Ledger entry ${index + 1} is not valid JSON`);
    }
    if (entry.seq !== index + 1 || entry.prev !== prev || entry.hash !== entryHash(entry)) {
      throw new Error(`Ledger hash chain is broken at entry ${index + 1}`);
    }
    entries.push(entry);
    prev = entry.hash;
  }
  checkHead(entries, head);
  return entries;
}

export async function appendEvent(repo, type, data, { now = new Date() } = {}) {
  return withLedgerLock(repo, async () => {
    const entries = await readLedger(repo);
    const last = entries.at(-1);
    const entry = { seq: entries.length + 1, at: now.toISOString(), type, data, prev: last?.hash ?? GENESIS };
    entry.hash = entryHash(entry);
    await appendFile(ledgerPath(repo), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    await writeHead(repo, entry);
    return entry;
  });
}

export async function verifyLedger(repo) {
  try {
    const entries = await readLedger(repo);
    return { ok: true, entries: entries.length, head: entries.at(-1)?.hash ?? GENESIS };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
