import { appendFile, mkdir, readFile, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { digest } from "./canonical.mjs";

const GENESIS = "0".repeat(64);
const LOCK_STALE_MS = 30_000;

export function ledgerPath(repo) {
  return path.join(repo.stateDir, "ledger.jsonl");
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
  let text;
  try {
    text = await readFile(ledgerPath(repo), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
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
  return entries;
}

export async function appendEvent(repo, type, data, { now = new Date() } = {}) {
  return withLock(repo, async () => {
    const entries = await readLedger(repo);
    const last = entries.at(-1);
    const entry = { seq: entries.length + 1, at: now.toISOString(), type, data, prev: last?.hash ?? GENESIS };
    entry.hash = entryHash(entry);
    await appendFile(ledgerPath(repo), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
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
