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
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import {
  assertMutableRun,
  digestObject,
  loadDefaults,
  loadRun,
  nowIso,
  sha256,
  withRunLock
} from "./core.mjs";

const CAMPAIGN_SCHEMA_VERSION = 1;
export const CAMPAIGN_REPAIR_BUDGET = 5;
export const CAMPAIGN_MAX_RENEWALS = 3;
// Per approval, not a campaign-total grant. Every renewal needs its own exact
// host signature; three approvals can add at most six events to the original five.
export const CAMPAIGN_MAX_ADDITIONAL_REPAIRS = 2;
export const CAMPAIGN_MAX_EFFECTIVE_REPAIR_BUDGET =
  CAMPAIGN_REPAIR_BUDGET + CAMPAIGN_MAX_RENEWALS * CAMPAIGN_MAX_ADDITIONAL_REPAIRS;
export const CAMPAIGN_RENEWAL_ADMISSION_MS = 24 * 60 * 60 * 1000;
const RENEWAL_KIND = "campaign-repair-renewal-request";
const RENEWAL_MODEL = "campaign-repair-renewal-authorization";
const RENEWAL_REVIEWER = "better-workflows-campaign-renewal-human-approval";
const RENEWAL_ID = /^campaign-renewal-[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const CAMPAIGN_ID = /^campaign-[a-f0-9]{32}$/;
const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STALE_LOCK_MS = 5 * 60 * 1000;
const LOCK_WAIT_MS = 60_000;

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

function stateRootForRun(run) {
  const runDir = String(run?.runDir ?? "");
  if (!path.isAbsolute(runDir) || path.basename(path.dirname(runDir)) !== "runs") {
    throw new Error("Campaign admission requires an exact run state root");
  }
  return path.dirname(path.dirname(runDir));
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
    const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
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
    if (!event || !SAFE_EVENT_ID.test(String(event.eventId ?? "")) || ids.has(event.eventId) ||
        !["package-block", "repair-round", "repair-renewal"].includes(event.kind)) {
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
  // Renewal admission replays the complete source/sentinel and fixed-host
  // signature while holding this lock. Give an identical concurrent request a
  // bounded chance to observe its predecessor's commit; never steal a live lock.
  const deadline = performance.now() + LOCK_WAIT_MS;
  while (performance.now() < deadline) {
    try {
      handle = await open(lock, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await recoverAbandonedLock(lock)) continue;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!handle) throw new Error("Campaign repair ledger lock wait exceeded 60000ms; owner was not interrupted");
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

// updatedAt is an operational write timestamp. Everything else, including each
// predecessor event's original bytes, participates in the signed history anchor.
export function campaignHistoryDigest(ledger, events = ledger.events) {
  return digestObject({
    schemaVersion: ledger.schemaVersion,
    campaignId: ledger.campaignId,
    bindingDigest: ledger.bindingDigest,
    repairBudget: ledger.repairBudget,
    createdAt: ledger.createdAt,
    events
  });
}

function repairCounts(events) {
  const blockedPackages = events.filter((event) => event.kind === "package-block").length;
  const explicitRepairRounds = events.filter((event) => event.kind === "repair-round").length;
  return { blockedPackages, explicitRepairRounds,
    repairEvents: Math.max(0, blockedPackages - 1) + explicitRepairRounds };
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} fields are invalid`);
  }
}

export function validateCampaignRenewalRequest(request) {
  const continuation = [2, 3].includes(request?.schemaVersion);
  exactKeys(request, [
    "schemaVersion", "kind", "renewalId", "campaignId", "campaignBindingDigest",
    "predecessorHistoryDigest", "predecessorEventCount", "predecessorRepairEvents",
    "repairBudget", "additionalRepairs", "effectiveRepairBudget", "runId",
    "contractDigest", "sourceBindingDigest", "sentinelDigest", "base", "head",
    "reason", "createdAt", "expiresAt", "technicalGatesRequired", "grantsActionAuthority",
    ...(continuation ? ["renewalOrdinal", "predecessorRenewalCount", "predecessorEffectiveRepairBudget"] : [])
  ], "Campaign renewal request");
  const predecessorBudget = continuation ? request.predecessorEffectiveRepairBudget : CAMPAIGN_REPAIR_BUDGET;
  if (![1, 2, 3].includes(request.schemaVersion) || request.kind !== RENEWAL_KIND ||
      !RENEWAL_ID.test(request.renewalId) || !CAMPAIGN_ID.test(request.campaignId) ||
      !/^sbw-\d{8}T\d{6}Z-[a-f0-9]{12}$/.test(request.runId ?? "") ||
      !["campaignBindingDigest", "predecessorHistoryDigest", "contractDigest", "sourceBindingDigest", "sentinelDigest"]
        .every((key) => DIGEST.test(request[key])) ||
      !REVISION.test(request.base) || !REVISION.test(request.head) ||
      !Number.isSafeInteger(request.predecessorEventCount) || request.predecessorEventCount < 1 ||
      !Number.isSafeInteger(request.predecessorRepairEvents) || request.predecessorRepairEvents < CAMPAIGN_REPAIR_BUDGET ||
      request.predecessorRepairEvents > predecessorBudget ||
      request.repairBudget !== CAMPAIGN_REPAIR_BUDGET ||
      !Number.isSafeInteger(request.additionalRepairs) || request.additionalRepairs < 1 ||
      request.additionalRepairs > CAMPAIGN_MAX_ADDITIONAL_REPAIRS ||
      request.effectiveRepairBudget !== predecessorBudget + request.additionalRepairs ||
      request.technicalGatesRequired !== true || request.grantsActionAuthority !== false ||
      typeof request.reason !== "string" || !request.reason.trim() || request.reason.length > 2048) {
    throw new Error("Campaign renewal request binding or bounded quota is invalid");
  }
  if (continuation && (
    // The schema is an ordinal-specific authority boundary. Historical v1/v2
    // requests never acquire third-renewal semantics from a higher global cap.
    request.renewalOrdinal !== request.schemaVersion ||
    request.predecessorRenewalCount !== request.schemaVersion - 1 ||
    !Number.isSafeInteger(predecessorBudget) ||
    predecessorBudget < CAMPAIGN_REPAIR_BUDGET + request.predecessorRenewalCount ||
    predecessorBudget > CAMPAIGN_REPAIR_BUDGET + request.predecessorRenewalCount * CAMPAIGN_MAX_ADDITIONAL_REPAIRS ||
    request.predecessorRepairEvents < predecessorBudget ||
    request.effectiveRepairBudget > CAMPAIGN_REPAIR_BUDGET + request.renewalOrdinal * CAMPAIGN_MAX_ADDITIONAL_REPAIRS ||
    request.effectiveRepairBudget > CAMPAIGN_MAX_EFFECTIVE_REPAIR_BUDGET
  )) throw new Error("Campaign renewal continuation ordinal or bounded quota is invalid");
  const created = Date.parse(request.createdAt);
  const expires = Date.parse(request.expiresAt);
  if (typeof request.createdAt !== "string" || typeof request.expiresAt !== "string" ||
      !Number.isFinite(created) || !Number.isFinite(expires) || expires <= created ||
      expires - created > CAMPAIGN_RENEWAL_ADMISSION_MS) {
    throw new Error("Campaign renewal admission window is invalid");
  }
  return request;
}

export function campaignRenewalSignerBinding(request) {
  validateCampaignRenewalRequest(request);
  const requestDigest = digestObject(request);
  return {
    base: request.base, head: request.head,
    instructionDigest: requestDigest, model: RENEWAL_MODEL,
    packageId: `campaign-renewal-${requestDigest}`,
    promptDigest: requestDigest, reviewDigest: requestDigest,
    reviewerId: RENEWAL_REVIEWER, runId: request.runId,
    sentinelDigest: request.sentinelDigest, executionId: request.renewalId
  };
}

function assertRenewalPredecessor(run, ledger, request, events) {
  validateCampaignRenewalRequest(request);
  const predecessorRepairEvents = repairCounts(events).repairEvents;
  const predecessorBudget = request.schemaVersion === 1
    ? CAMPAIGN_REPAIR_BUDGET
    : request.predecessorEffectiveRepairBudget;
  if (request.campaignId !== run.manifest.campaign.campaignId ||
      request.campaignBindingDigest !== digestObject(run.manifest.campaign) ||
      request.predecessorHistoryDigest !== campaignHistoryDigest(ledger, events) ||
      request.predecessorEventCount !== events.length ||
      request.predecessorRepairEvents !== predecessorRepairEvents ||
      predecessorRepairEvents > predecessorBudget) {
    throw new Error("Campaign renewal predecessor history or campaign binding changed");
  }
  const renewals = events.filter((event) => event.kind === "repair-renewal");
  if (request.schemaVersion === 1) {
    // Historical v1 approvals remain first-renewal-only, with unchanged bytes
    // and signature binding. The new limit does not upgrade a prior approval.
    if (renewals.length !== 0) throw new Error("A legacy v1 second renewal is forbidden");
  } else if (renewals.length !== request.predecessorRenewalCount ||
      renewals.length + 1 !== request.renewalOrdinal ||
      renewals.length >= CAMPAIGN_MAX_RENEWALS ||
      request.predecessorEffectiveRepairBudget !== CAMPAIGN_REPAIR_BUDGET +
        renewals.reduce((total, event) => total + event.request.additionalRepairs, 0)) {
    throw new Error("Campaign renewal predecessor quota or renewal count changed");
  }
}

async function verifyRenewalAttestation(run, request, attestation, at) {
  exactKeys(attestation, ["path", "fileDigest", "attestationDigest"], "Campaign renewal attestation");
  if (typeof attestation.path !== "string" || !path.isAbsolute(attestation.path) ||
      !DIGEST.test(attestation.fileDigest) || !DIGEST.test(attestation.attestationDigest)) {
    throw new Error("Campaign renewal requires an exact host-signed user approval");
  }
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp) || timestamp < Date.parse(request.createdAt) || timestamp >= Date.parse(request.expiresAt)) {
    throw new Error("Campaign renewal approval is expired or not yet valid");
  }
  const { verifyTrustedNativeCriticAttestation } = await import("./providers.mjs");
  const verified = await verifyTrustedNativeCriticAttestation({
    attestationPath: attestation.path,
    workspaceRoot: run.manifest.cwd,
    binding: campaignRenewalSignerBinding(request),
    now: timestamp,
    requireFixedHostRoot: true,
    expectedFileDigest: attestation.fileDigest
  });
  if (verified.attestationPath !== attestation.path || verified.fileDigest !== attestation.fileDigest ||
      verified.attestationDigest !== attestation.attestationDigest ||
      Date.parse(verified.issuedAt) < Date.parse(request.createdAt) - 300_000 ||
      Date.parse(verified.expiresAt) - Date.parse(verified.issuedAt) > CAMPAIGN_RENEWAL_ADMISSION_MS) {
    throw new Error("Campaign renewal host approval digest or issuance binding changed");
  }
  return verified;
}

async function verifyRenewalEvent(run, ledger, event, index) {
  exactKeys(event, ["eventId", "kind", "request", "requestDigest", "attestation", "recordedAt"], "Campaign renewal event");
  if (event.kind !== "repair-renewal" || event.eventId !== event.request?.renewalId ||
      event.requestDigest !== digestObject(event.request)) {
    throw new Error("Campaign renewal event digest or identity is invalid");
  }
  assertRenewalPredecessor(run, ledger, event.request, ledger.events.slice(0, index));
  // Replay historical approval at its admission time. This is NOT a fresh
  // signer, review, or provider authorization and grants none of those powers.
  await verifyRenewalAttestation(run, event.request, event.attestation, event.recordedAt);
}

async function statusFromLedger(run, ledger) {
  const events = ledger?.events ?? [];
  const { blockedPackages, explicitRepairRounds, repairEvents } = repairCounts(events);
  // The first blocked package establishes the campaign baseline.  A new
  // blocked package is itself a repair wave; explicit in-package repair rounds
  // are waves too.  This preserves the documented five repairs while stopping
  // new run/package identities from resetting that total.
  let additionalRepairs = 0;
  let renewalCount = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.kind !== "repair-renewal") continue;
    await verifyRenewalEvent(run, ledger, event, index);
    renewalCount += 1;
    additionalRepairs += event.request.additionalRepairs;
  }
  if (renewalCount > CAMPAIGN_MAX_RENEWALS || additionalRepairs > CAMPAIGN_MAX_RENEWALS * CAMPAIGN_MAX_ADDITIONAL_REPAIRS) {
    throw new Error("Campaign renewal limit is invalid");
  }
  const effectiveRepairBudget = CAMPAIGN_REPAIR_BUDGET + additionalRepairs;
  if (repairEvents > effectiveRepairBudget) {
    throw new Error("Campaign repair ledger exceeds its effective budget");
  }
  return {
    campaignId: run.manifest.campaign.campaignId,
    repairBudget: CAMPAIGN_REPAIR_BUDGET,
    effectiveRepairBudget,
    additionalRepairs,
    renewalCount,
    renewalLimit: CAMPAIGN_MAX_RENEWALS,
    historyDigest: ledger ? campaignHistoryDigest(ledger) : null,
    repairEvents,
    blockedPackages,
    explicitRepairRounds,
    remainingRepairs: Math.max(0, effectiveRepairBudget - repairEvents),
    exhausted: repairEvents >= effectiveRepairBudget,
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
    throw new Error(`Campaign repair budget exhausted for ${identity}; require a bounded host-signed user renewal or a materially new goal, never reset run or package state`);
  }
  return status;
}

export async function recordCampaignRepairEvent(run, { eventId, kind, packageId, runId }) {
  if (!SAFE_EVENT_ID.test(String(eventId ?? "")) || !["package-block", "repair-round"].includes(kind)) {
    throw new Error("Campaign repair event is invalid");
  }
  return withCampaignLock(run, async (ledger) => {
    const existing = ledger.events.find((event) => event.eventId === eventId);
    if (existing) {
      if (existing.kind !== kind || existing.packageId !== packageId || existing.runId !== runId) {
        throw new Error("Campaign repair event identity conflicts with its original binding");
      }
      return { changed: false, ledger, value: await statusFromLedger(run, ledger) };
    }
    if ((await statusFromLedger(run, ledger)).exhausted) {
      throw new Error(`Campaign repair budget exhausted for ${run.manifest.campaign.campaignId}`);
    }
    ledger.events.push({ eventId, kind, packageId, runId, recordedAt: nowIso() });
    return { changed: true, ledger, value: await statusFromLedger(run, ledger) };
  });
}

async function currentRenewalRunBinding(run) {
  assertMutableRun(run, "Campaign renewal");
  const source = run.manifest.sourceBinding;
  if (!source || !REVISION.test(source.baseRevision) || !REVISION.test(source.headRevision) ||
      run.manifest.contractDigest !== digestObject(run.contract) ||
      digestObject(deriveCampaignBinding(run.contract, source)) !== digestObject(run.manifest.campaign)) {
    throw new Error("Campaign renewal requires an exact current contract and source binding");
  }
  const { captureSentinel, captureSourceBinding } = await import("./git.mjs");
  const current = await captureSourceBinding(run.manifest.cwd, { baseRevision: source.baseRevision, requireClean: true });
  const sentinel = await captureSentinel(run.manifest.cwd, run.contract, await loadDefaults());
  if (current?.digest !== source.digest || sentinel.complete !== true ||
      run.state.lastSentinelVerified !== true || run.state.lastSentinelComplete !== true ||
      sentinel.digest !== run.state.lastSentinel?.digest) {
    throw new Error("Campaign renewal source or complete sentinel changed");
  }
  return {
    runId: run.manifest.runId,
    contractDigest: run.manifest.contractDigest,
    sourceBindingDigest: current.digest,
    sentinelDigest: sentinel.digest,
    base: current.baseRevision,
    head: current.headRevision
  };
}

export async function prepareCampaignRenewal(run, { additionalRepairs, reason }) {
  const stateRoot = stateRootForRun(run);
  return withCampaignLock(run, async (ledger) => withRunLock(
    stateRoot,
    run.manifest.runId,
    async () => {
      const currentRun = await loadRun(stateRoot, run.manifest.runId);
      assertMutableRun(currentRun, "Campaign renewal");
      if (digestObject(currentRun.manifest.campaign) !== digestObject(run.manifest.campaign)) {
        throw new Error("Campaign renewal campaign binding changed before admission");
      }
      if (!ledger) throw new Error("Campaign renewal requires an existing exhausted campaign ledger");
      validateLedger(ledger, currentRun.manifest.campaign);
      const binding = await currentRenewalRunBinding(currentRun);
      const status = await statusFromLedger(currentRun, ledger);
      if (!status.exhausted || status.renewalCount >= CAMPAIGN_MAX_RENEWALS) {
        throw new Error("Campaign renewal requires exhaustion and an unused bounded renewal");
      }
      const createdAt = nowIso();
      const request = validateCampaignRenewalRequest({
        schemaVersion: status.renewalCount + 1, kind: RENEWAL_KIND,
        renewalId: `campaign-renewal-${randomBytes(16).toString("hex")}`,
        campaignId: currentRun.manifest.campaign.campaignId,
        campaignBindingDigest: digestObject(currentRun.manifest.campaign),
        predecessorHistoryDigest: campaignHistoryDigest(ledger),
        predecessorEventCount: ledger.events.length,
        predecessorRepairEvents: status.repairEvents,
        repairBudget: CAMPAIGN_REPAIR_BUDGET,
        additionalRepairs,
        effectiveRepairBudget: status.effectiveRepairBudget + additionalRepairs,
        ...(status.renewalCount === 0 ? {} : {
          renewalOrdinal: status.renewalCount + 1,
          predecessorRenewalCount: status.renewalCount,
          predecessorEffectiveRepairBudget: status.effectiveRepairBudget
        }),
        ...binding, reason, createdAt,
        expiresAt: new Date(Date.parse(createdAt) + CAMPAIGN_RENEWAL_ADMISSION_MS).toISOString(),
        technicalGatesRequired: true, grantsActionAuthority: false
      });
      return {
        changed: false,
        ledger,
        value: { request, requestDigest: digestObject(request), signerRequest: campaignRenewalSignerBinding(request) }
      };
    }
  ));
}

export async function renewCampaign(run, { request, attestation }) {
  validateCampaignRenewalRequest(request);
  const stateRoot = stateRootForRun(run);
  return withCampaignLock(run, async (ledger) => withRunLock(
    stateRoot,
    run.manifest.runId,
    async () => {
      const currentRun = await loadRun(stateRoot, run.manifest.runId);
      if (digestObject(currentRun.manifest.campaign) !== digestObject(run.manifest.campaign)) {
        throw new Error("Campaign renewal campaign binding changed before admission");
      }
      const prior = ledger.events.find((event) => event.eventId === request.renewalId);
      if (prior) {
        if (prior.kind !== "repair-renewal" || prior.requestDigest !== digestObject(request) ||
            digestObject(prior.attestation) !== digestObject(attestation)) {
          throw new Error("Campaign renewal retry conflicts with the immutable original approval");
        }
        return { changed: false, ledger, value: { idempotent: true, campaign: await statusFromLedger(currentRun, ledger), grantsActionAuthority: false } };
      }
      assertMutableRun(currentRun, "Campaign renewal");
      assertRenewalPredecessor(currentRun, ledger, request, ledger.events);
      const status = await statusFromLedger(currentRun, ledger);
      if (!status.exhausted || status.renewalCount >= CAMPAIGN_MAX_RENEWALS) {
        throw new Error("Campaign renewal requires exhaustion and an unused bounded renewal");
      }
      const current = await currentRenewalRunBinding(currentRun);
      for (const [key, value] of Object.entries(current)) {
        if (request[key] !== value) throw new Error(`Campaign renewal current ${key} binding changed`);
      }
      const recordedAt = nowIso();
      await verifyRenewalAttestation(currentRun, request, attestation, recordedAt);
      if (digestObject(await currentRenewalRunBinding(currentRun)) !== digestObject(current)) {
        throw new Error("Campaign renewal source changed before durable admission");
      }
      ledger.events.push({
        eventId: request.renewalId, kind: "repair-renewal",
        request: structuredClone(request), requestDigest: digestObject(request),
        attestation: structuredClone(attestation), recordedAt
      });
      return { changed: true, ledger, value: {
        idempotent: false, campaign: await statusFromLedger(currentRun, ledger), grantsActionAuthority: false
      } };
    }
  ));
}
