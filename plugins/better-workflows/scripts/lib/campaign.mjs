import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { digestObject, nowIso, sha256 } from "./core.mjs";

const CAMPAIGN_SCHEMA_VERSION = 1;
export const CAMPAIGN_REPAIR_BUDGET = 5;
const CAMPAIGN_ID = /^campaign-[a-f0-9]{32}$/;
const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STALE_LOCK_MS = 5 * 60 * 1000;

function normalizedGoal(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function campaignIdentity(contract, sourceBinding) {
  const repositoryIdentityDigest = sourceBinding?.originIdentity?.present === true
    ? sourceBinding.originIdentity.digest
    : digestObject({
        kind: "git-common-dir-v1",
        device: sourceBinding?.gitCommonDir?.device ?? null,
        inode: sourceBinding?.gitCommonDir?.inode ?? null
      });
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    repositoryIdentityDigest,
    template: contract.template,
    goalDigest: sha256(normalizedGoal(contract.goal)),
    scopeDigest: digestObject(contract.scope?.include ?? [])
  };
}

export function deriveCampaignBinding(contract, sourceBinding) {
  const identity = campaignIdentity(contract, sourceBinding);
  if (!/^[a-f0-9]{64}$/.test(identity.repositoryIdentityDigest)) {
    throw new Error("Campaign binding requires one exact repository identity");
  }
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    campaignId: `campaign-${sha256(digestObject(identity)).slice(0, 32)}`,
    identity,
    repairBudget: CAMPAIGN_REPAIR_BUDGET
  };
}

function campaignDirectory(run) {
  const override = process.env.SBW_CAMPAIGN_ROOT;
  if (override) {
    if (!path.isAbsolute(override) || path.resolve(override) !== override) {
      throw new Error("SBW_CAMPAIGN_ROOT must be an absolute canonical path");
    }
    return override;
  }
  if (process.env.NODE_TEST_CONTEXT) {
    return path.join(os.tmpdir(), `better-workflows-campaign-tests-${process.pid}`);
  }
  const stateRoot = path.join(os.homedir(), ".better-workflows");
  if (!path.isAbsolute(stateRoot)) throw new Error("Campaign ledger requires an absolute host state root");
  return path.join(stateRoot, "campaigns");
}

function campaignPath(run) {
  const campaignId = run.manifest?.campaign?.campaignId;
  if (!CAMPAIGN_ID.test(String(campaignId ?? ""))) throw new Error("Run campaign binding is missing or invalid");
  return path.join(campaignDirectory(run), `${campaignId}.json`);
}

function unboundCampaignStatus() {
  return {
    campaignId: null,
    repairBudget: 0,
    repairEvents: 0,
    blockedPackages: 0,
    explicitRepairRounds: 0,
    remainingRepairs: 0,
    exhausted: true,
    legacyUnbound: true,
    blockedReason: "legacy-run-has-no-campaign-binding",
    events: []
  };
}

async function ensurePhysicalPrivateDirectory(target) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const canonical = await realpath(target);
  const resolved = path.resolve(target);
  const stableMacAlias = process.platform === "darwin" && (
    (resolved === "/var" || resolved.startsWith("/var/")) && canonical === `/private${resolved}` ||
    (resolved === "/tmp" || resolved.startsWith("/tmp/")) && canonical === `/private${resolved}`
  );
  if (canonical !== resolved && !stableMacAlias) throw new Error(`Campaign directory uses a symbolic path: ${target}`);
  const before = await lstat(target);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`Campaign path is not a physical directory: ${target}`);
  await chmod(target, 0o700);
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error(`Campaign path is not a directory: ${target}`);
}

async function readLedger(target) {
  try {
    const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) {
        throw new Error("Campaign ledger is not a bounded regular file");
      }
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function validateLedger(value, binding) {
  if (
    !value || value.schemaVersion !== CAMPAIGN_SCHEMA_VERSION ||
    value.campaignId !== binding.campaignId ||
    value.bindingDigest !== digestObject(binding) ||
    value.repairBudget !== CAMPAIGN_REPAIR_BUDGET ||
    !Array.isArray(value.events)
  ) throw new Error("Campaign ledger binding is invalid");
  const ids = new Set();
  for (const event of value.events) {
    if (!event || !SAFE_EVENT_ID.test(String(event.eventId ?? "")) || ids.has(event.eventId)) {
      throw new Error("Campaign ledger event identity is invalid or duplicated");
    }
    ids.add(event.eventId);
  }
  return value;
}

async function writeLedger(target, value) {
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  const directory = await open(path.dirname(target), fsConstants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function recoverAbandonedLock(lock) {
  let info;
  try {
    info = await stat(lock);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return false;
  let ownerPid = null;
  try {
    const raw = (await readFile(lock, "utf8")).trim();
    if (/^[1-9][0-9]{0,9}$/.test(raw)) ownerPid = Number(raw);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  if (ownerPid !== null) {
    try {
      process.kill(ownerPid, 0);
      return false;
    } catch (error) {
      if (error.code !== "ESRCH") return false;
    }
  }
  try {
    const latest = await stat(lock);
    if (latest.ino !== info.ino || latest.dev !== info.dev || latest.mtimeMs !== info.mtimeMs) return false;
    await rm(lock);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function withCampaignLock(run, callback) {
  const directory = campaignDirectory(run);
  await ensurePhysicalPrivateDirectory(directory);
  const target = campaignPath(run);
  const lock = `${target}.lock`;
  let handle;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(lock, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || attempt === 99) throw error;
      if (await recoverAbandonedLock(lock)) continue;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!handle) throw new Error("Campaign repair ledger lock could not be acquired");
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
    const binding = run.manifest.campaign;
    const existing = await readLedger(target);
    const ledger = existing
      ? validateLedger(existing, binding)
      : {
          schemaVersion: CAMPAIGN_SCHEMA_VERSION,
          campaignId: binding.campaignId,
          bindingDigest: digestObject(binding),
          repairBudget: CAMPAIGN_REPAIR_BUDGET,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          events: []
        };
    const result = await callback(ledger);
    if (result.changed) {
      result.ledger.updatedAt = nowIso();
      await writeLedger(target, result.ledger);
    }
    return result.value;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(lock, { force: true }).catch(() => undefined);
  }
}

function statusFromLedger(run, ledger) {
  const events = ledger?.events ?? [];
  const blockedPackages = events.filter((event) => event.kind === "package-block").length;
  const explicitRepairRounds = events.filter((event) => event.kind === "repair-round").length;
  // The first blocked package establishes the campaign baseline.  A new
  // blocked package is itself a repair wave; explicit in-package repair rounds
  // are waves too.  This preserves the documented five repairs while stopping
  // new run/package identities from resetting that total.
  const repairEvents = Math.max(0, blockedPackages - 1) + explicitRepairRounds;
  return {
    campaignId: run.manifest.campaign.campaignId,
    repairBudget: CAMPAIGN_REPAIR_BUDGET,
    repairEvents,
    blockedPackages,
    explicitRepairRounds,
    remainingRepairs: Math.max(0, CAMPAIGN_REPAIR_BUDGET - repairEvents),
    exhausted: repairEvents >= CAMPAIGN_REPAIR_BUDGET,
    events
  };
}

export async function campaignStatus(run) {
  if (!CAMPAIGN_ID.test(String(run.manifest?.campaign?.campaignId ?? ""))) {
    return unboundCampaignStatus();
  }
  const target = campaignPath(run);
  const value = await readLedger(target);
  return statusFromLedger(run, value ? validateLedger(value, run.manifest.campaign) : null);
}

export async function assertCampaignRepairAvailable(run) {
  const status = await campaignStatus(run);
  if (status.exhausted) {
    const identity = status.campaignId ?? "legacy-unbound-run";
    throw new Error(`Campaign repair budget exhausted for ${identity}; start a materially new goal instead of resetting run or package state`);
  }
  return status;
}

export async function recordCampaignRepairEvent(run, { eventId, kind, packageId, runId }) {
  if (!SAFE_EVENT_ID.test(String(eventId ?? "")) || !["package-block", "repair-round"].includes(kind)) {
    throw new Error("Campaign repair event is invalid");
  }
  return withCampaignLock(run, async (ledger) => {
    const existing = ledger.events.find((event) => event.eventId === eventId);
    if (existing) return { changed: false, ledger, value: statusFromLedger(run, ledger) };
    if (statusFromLedger(run, ledger).exhausted) {
      throw new Error(`Campaign repair budget exhausted for ${run.manifest.campaign.campaignId}`);
    }
    ledger.events.push({ eventId, kind, packageId, runId, recordedAt: nowIso() });
    return { changed: true, ledger, value: statusFromLedger(run, ledger) };
  });
}
