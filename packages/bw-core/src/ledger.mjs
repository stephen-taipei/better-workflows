import { appendFile, mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { digest } from "./canonical.mjs";

const GENESIS = "0".repeat(64);
const LOCK_STALE_MS = 30_000;

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

async function withLock(repo, fn) {
  const lock = path.join(repo.stateDir, "ledger.lock");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rmdir(lock).catch(() => {});
        continue;
      }
      if (attempt > 200) throw new Error("Ledger is locked by another process");
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
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
  return withLock(repo, async () => {
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
