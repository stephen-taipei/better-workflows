#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  checkPluginCache,
  removeUnreadyPluginCachePublication,
  publishPluginCache,
  recoverPendingPluginCachePublication
} from "../plugins/better-workflows/scripts/lib/publication.mjs";
import {
  digestObject,
  getCodexPluginCacheRoot,
  getStateRoot,
  listJsonRecords,
  loadRun,
  nowIso,
  safeJoin,
  sha256
} from "../plugins/better-workflows/scripts/lib/core.mjs";
import { validateTypedEvidenceRecord } from "../plugins/better-workflows/scripts/lib/evidence.mjs";
import { validateSelfImproveDeliveryHandoff } from "../plugins/better-workflows/scripts/lib/self-improve-handoff.mjs";
import { rm, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

function replayEvidenceShape(record) {
  const receipt = record?.receipt ?? {};
  return {
    id: record?.id ?? null,
    kind: record?.kind ?? null,
    summary: record?.summary ?? null,
    status: record?.status ?? null,
    acceptanceIds: record?.acceptanceIds ?? null,
    dependencyInputs: record?.dependencyInputs ?? null,
    dependencies: record?.dependencies ?? null,
    sourceKind: record?.sourceKind ?? null,
    sourceDigest: record?.sourceDigest ?? (receipt.payload ? digestObject(receipt.payload) : null),
    review: record?.review ?? null,
    providerExecution: record?.providerExecution ?? null,
    receipt: {
      contractId: receipt.contractId ?? null,
      contractVersion: receipt.contractVersion ?? null,
      runId: receipt.runId ?? null,
      producer: receipt.producer ?? null,
      inputBinding: receipt.inputBinding ?? null,
      payload: receipt.payload ?? null,
      payloadDigest: receipt.payloadDigest ?? null
    }
  };
}

function equivalentReplayEvidence(left, right) {
  return JSON.stringify(replayEvidenceShape(left)) === JSON.stringify(replayEvidenceShape(right));
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    options[key] = value;
    index += 1;
  }
  return { positional, options };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [command] = positional;
  if (!["check", "sync"].includes(command)) {
    throw new Error("Usage: node scripts/plugin-cache.mjs check [--cache-root <directory>] | sync [--handoff-run <pr-to-dev-run-id> --token <action-token>]");
  }
  const unknown = Object.keys(options).filter((key) => !["cache-root", "handoff-run", "token"].includes(key));
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(", ")}`);
  if (command === "check" && options["handoff-run"] !== undefined) {
    throw new Error("--handoff-run is only valid for sync");
  }
  if (command === "sync" && !options["handoff-run"]) {
    throw new Error("plugin cache sync requires --handoff-run <pr-to-dev-run-id> bound to a self-improve handoff");
  }
  if (command === "check" && options.token !== undefined) {
    throw new Error("--token is only valid for sync");
  }
  if (command === "sync" && !options.token) {
    throw new Error("plugin cache sync requires --token for the governed plugin.cache.publish action");
  }
  if (command === "sync" && options["cache-root"] !== undefined) {
    throw new Error("--cache-root override is only valid for check");
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourceRoot = path.join(repoRoot, "plugins", "better-workflows");
  const cacheRoot = command === "sync"
    ? getCodexPluginCacheRoot()
    : options["cache-root"]
      ? path.resolve(options["cache-root"])
      : getCodexPluginCacheRoot();
  const sbwPath = path.join(repoRoot, "plugins", "better-workflows", "scripts", "sbw.mjs");
  const stateRoot = getStateRoot();
  const runSbw = async (args) => {
    try {
      const output = await execFileAsync(process.execPath, [sbwPath, ...args], {
        cwd: repoRoot,
        env: { ...process.env, SBW_STATE_ROOT: stateRoot },
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024
      });
      return JSON.parse(output.stdout);
    } catch (error) {
      const detail = String(error.stdout ?? error.stderr ?? "").trim();
      throw new Error(detail || error.message);
    }
  };
  const loadPersistedEvidence = async (runId, evidenceId) => {
    const latestRun = await loadRun(stateRoot, runId);
    const records = await listJsonRecords(stateRoot, safeJoin(latestRun.runDir, "evidence"));
    return records.find((item) => item.id === evidenceId) ?? null;
  };
  const validatePersistedEvidence = async (record, runId) => {
    const latestRun = await loadRun(stateRoot, runId);
    await validateTypedEvidenceRecord(record, {
      ...latestRun,
      root: stateRoot,
      requireReconciled: false
    });
    return record;
  };
  const ensureEquivalentEvidence = async (record, runId, tempFiles) => {
    const existing = await loadPersistedEvidence(runId, record.id);
    if (existing) {
      await validatePersistedEvidence(existing, runId);
      if (!equivalentReplayEvidence(existing, record)) {
        throw new Error(`Persisted plugin cache evidence binding changed: ${record.id}`);
      }
      return existing;
    }
    const file = path.join(os.tmpdir(), `better-workflows-${record.id}-${randomUUID()}.json`);
    tempFiles.push(file);
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    try {
      return await runSbw(["evidence", "add", runId, "--file", file]);
    } catch (error) {
      const raced = await loadPersistedEvidence(runId, record.id);
      if (!raced) throw error;
      await validatePersistedEvidence(raced, runId);
      if (!equivalentReplayEvidence(raced, record)) {
        throw new Error(`Persisted plugin cache evidence binding changed: ${record.id}`);
      }
      return raced;
    }
  };
  let result;
  if (command === "sync") {
    const targetRunId = String(options["handoff-run"]);
    const targetRun = await loadRun(stateRoot, targetRunId);
    const evidence = await listJsonRecords(stateRoot, safeJoin(targetRun.runDir, "evidence"));
    const handoff = evidence.find((item) => item.kind === "self-improve-delivery-handoff" && item.status === "complete" && item.stale !== true && item.receipt?.payload);
    if (!handoff) throw new Error("plugin cache sync requires a fresh self-improve-delivery-handoff receipt");
    await validateSelfImproveDeliveryHandoff(handoff.receipt.payload, { ...targetRun, root: stateRoot });
    const payload = handoff.receipt.payload;
    const expectedSourceBinding = {
      pluginBundleDigest: payload.pluginBundleDigest,
      sourceBaselineRevision: payload.sourceBaselineRevision,
      sourceBindingDigest: payload.sourceBindingDigest,
      sourceHeadRevision: payload.sourceHeadRevision
    };
    let consumed = null;
    let publication = null;
    let reconciled = false;
    try {
      const tokenHash = sha256(String(options.token));
      const existingActions = await listJsonRecords(stateRoot, safeJoin(targetRun.runDir, "actions"));
      const existingAction = existingActions.find((action) => action.tokenHash === tokenHash);
      if (existingAction) {
        if (
          existingAction.action !== "plugin.cache.publish" ||
          existingAction.provider !== "local-workspace" ||
          existingAction.resource !== `plugin-cache:${payload.sourceHeadRevision}`
        ) {
          throw new Error("Existing action token is not bound to this exact plugin cache handoff");
        }
        if (existingAction.status === "spent" && existingAction.outcome === "success") {
          if (!existingAction.receipt) {
            throw new Error("Existing plugin cache success action has no persisted receipt; do not reuse its token");
          }
          const repairReceiptFile = path.join(os.tmpdir(), `better-workflows-cache-retry-${randomUUID()}.json`);
          try {
            await writeFile(repairReceiptFile, `${JSON.stringify(existingAction.receipt, null, 2)}\n`, { mode: 0o600 });
            const repairedResult = await runSbw([
              "action", "reconcile", targetRunId,
              "--attempt", existingAction.attemptId,
              "--outcome", "success",
              "--receipt", repairReceiptFile
            ]);
            const providerReceipt = existingAction.receipt.providerReceipt;
            publication = {
              ok: true,
              applied: providerReceipt.applied === true,
              noOp: providerReceipt.noOp === true,
              status: providerReceipt.noOp === true ? "identical" : "updated",
              version: providerReceipt.version,
              target: providerReceipt.target,
              sourceDigest: providerReceipt.sourceDigest,
              targetDigest: providerReceipt.targetDigest
            };
            reconciled = true;
            result = { ok: true, repaired: true, publication, action: repairedResult.action };
          } finally {
            await rm(repairReceiptFile, { force: true }).catch(() => undefined);
          }
        } else if (existingAction.status === "spent" && existingAction.outcome === "pending") {
          consumed = existingAction;
          publication = await recoverPendingPluginCachePublication({
            sourceRoot,
            cacheRoot,
            expectedSourceBinding,
            runId: targetRunId,
            attemptId: existingAction.attemptId
          });
        } else if (existingAction.status !== "issued") {
          throw new Error("Existing plugin cache action is not safely recoverable; do not reuse its token");
        }
      }
      if (!reconciled && !consumed) {
        const consumedResult = await runSbw([
          "action", "consume", targetRunId, "--token", String(options.token)
        ]);
        consumed = consumedResult.action;
        if (
          consumed.action !== "plugin.cache.publish" ||
          consumed.provider !== "local-workspace" ||
          consumed.resource !== `plugin-cache:${payload.sourceHeadRevision}`
        ) {
          throw new Error("Consumed action token is not bound to this exact plugin cache handoff");
        }
        publication = await publishPluginCache({
          sourceRoot,
          cacheRoot,
          expectedSourceBinding,
          publicationIdentity: {
            runId: targetRunId,
            attemptId: consumed.attemptId
          }
        });
      }
        if (!reconciled) {
          const request = {
          action: consumed.action,
          provider: consumed.provider,
          resource: consumed.resource,
          remoteRevision: consumed.remoteRevision,
          idempotencyKey: consumed.idempotencyKey,
          sourceRoot,
          cacheRoot,
          sourceBaselineRevision: payload.sourceBaselineRevision,
          sourceHeadRevision: payload.sourceHeadRevision,
          sourceBindingDigest: payload.sourceBindingDigest,
          pluginBundleDigest: payload.pluginBundleDigest
        };
        const response = {
          applied: publication.applied === true,
          noOp: publication.noOp === true,
          status: publication.status,
          version: publication.version,
          target: publication.target,
          sourceDigest: publication.sourceDigest,
          targetDigest: publication.targetDigest
        };
        const freshProviderReceipt = {
          action: consumed.action,
          provider: consumed.provider,
          resource: consumed.resource,
          outcome: "success",
          runId: targetRunId,
          attemptId: consumed.attemptId,
          idempotencyKey: consumed.idempotencyKey,
          remoteRevision: consumed.remoteRevision,
          executionId: `local-workspace:plugin.cache.publish:${consumed.attemptId}`,
          proofKind: "local-workspace:plugin.cache.publish",
          requestDigest: digestObject(request),
          responseDigest: digestObject(response),
          verifiedAt: nowIso(),
          terminalState: "success",
          sourceRoot,
          cacheRoot,
          version: publication.version,
          target: publication.target,
          sourceDigest: publication.sourceDigest,
          targetDigest: publication.targetDigest,
          applied: publication.applied === true,
          noOp: publication.noOp === true,
          sourceBaselineRevision: payload.sourceBaselineRevision,
          sourceHeadRevision: payload.sourceHeadRevision,
          sourceBindingDigest: payload.sourceBindingDigest,
          pluginBundleDigest: payload.pluginBundleDigest
        };
        const evidenceIds = [
          `cache-publication-${consumed.attemptId}`,
          `provider-reconciliation-${consumed.attemptId}`
        ];
        const persistedEvidence = await Promise.all(
          evidenceIds.map((evidenceId) => loadPersistedEvidence(targetRunId, evidenceId))
        );
        for (const existing of persistedEvidence.filter(Boolean)) {
          await validatePersistedEvidence(existing, targetRunId);
        }
        const persistedProviderReceipts = persistedEvidence
          .filter(Boolean)
          .map((existing) => existing.receipt?.payload?.receipt)
          .filter(Boolean);
        if (
          persistedProviderReceipts.some((existing) =>
            digestObject(existing) !== digestObject(persistedProviderReceipts[0])
          )
        ) {
          throw new Error("Persisted plugin cache evidence contains conflicting provider receipts");
        }
        const providerReceipt = persistedProviderReceipts[0] ?? freshProviderReceipt;
        const actionProof = {
          schemaVersion: 1,
          runId: targetRunId,
          actionAttemptId: consumed.attemptId,
          action: consumed.action,
          provider: consumed.provider,
          resource: consumed.resource,
          outcome: "success",
          idempotencyKey: consumed.idempotencyKey,
          remoteRevision: consumed.remoteRevision,
          providerExecutionId: providerReceipt.executionId,
          providerReceiptDigest: digestObject(providerReceipt)
        };
        const evidenceBase = {
          schemaVersion: 2,
          status: "complete",
          acceptanceIds: [],
          dependencyInputs: { files: [] },
            dependencies: { workflowVersion: "3.1.18", files: [] },
          receiptBase: {
            contractVersion: 1,
            runId: targetRunId,
            producer: { provider: "codex-root" },
            inputBinding: {
              runId: targetRunId,
              contractDigest: digestObject(targetRun.contract),
              remoteRevision: targetRun.contract.remoteRevision ?? null
            }
          }
        };
        const cacheEvidence = {
          ...evidenceBase,
          id: `cache-publication-${consumed.attemptId}`,
          kind: "cache-publication",
          summary: "Governed local-workspace publication reconciled the immutable plugin cache.",
          receipt: {
            ...evidenceBase.receiptBase,
            contractId: "evidence-contracts-v1:cache-publication",
            payload: {
              provider: "local-workspace",
              outcome: "success",
              status: publication.status,
              version: publication.version,
              target: publication.target,
              sourceRoot,
              sourceDigest: publication.sourceDigest,
              targetDigest: publication.targetDigest,
              sourceBaselineRevision: payload.sourceBaselineRevision,
              sourceHeadRevision: payload.sourceHeadRevision,
              sourceBindingDigest: payload.sourceBindingDigest,
              pluginBundleDigest: payload.pluginBundleDigest,
              actionProof,
              receipt: providerReceipt
            },
            payloadDigest: null,
            producedAt: nowIso()
          }
        };
        cacheEvidence.receipt.payloadDigest = digestObject(cacheEvidence.receipt.payload);
        const reconciliationEvidence = {
          ...evidenceBase,
          id: `provider-reconciliation-${consumed.attemptId}`,
          kind: "provider-reconciliation",
          summary: "Local workspace provider receipt was bound to the exact plugin cache action.",
          receipt: {
            ...evidenceBase.receiptBase,
            contractId: "evidence-contracts-v1:provider-reconciliation",
            payload: {
              provider: "local-workspace",
              receipt: providerReceipt,
              actionProof
            },
            payloadDigest: null,
            producedAt: nowIso()
          }
        };
        reconciliationEvidence.receipt.payloadDigest = digestObject(reconciliationEvidence.receipt.payload);
        const tempFiles = [];
        try {
          for (const evidence of [cacheEvidence, reconciliationEvidence]) {
            await ensureEquivalentEvidence(evidence, targetRunId, tempFiles);
          }
          const receiptFile = path.join(os.tmpdir(), `better-workflows-cache-receipt-${randomUUID()}.json`);
          tempFiles.push(receiptFile);
          const actionReceipt = {
            action: consumed.action,
            provider: consumed.provider,
            resource: consumed.resource,
            outcome: "success",
            runId: targetRunId,
            attemptId: consumed.attemptId,
            idempotencyKey: consumed.idempotencyKey,
            remoteRevision: consumed.remoteRevision,
            providerReceipt,
            evidenceIds: [cacheEvidence.id, reconciliationEvidence.id]
          };
          await writeFile(receiptFile, `${JSON.stringify(actionReceipt, null, 2)}\n`, { mode: 0o600 });
          const reconciledResult = await runSbw([
            "action", "reconcile", targetRunId,
            "--attempt", consumed.attemptId,
            "--outcome", "success",
            "--receipt", receiptFile
          ]);
          reconciled = true;
          result = { ok: true, publication, action: reconciledResult.action };
        } finally {
          await Promise.all(tempFiles.map((file) => rm(file, { force: true }).catch(() => undefined)));
        }
      }
    } catch (error) {
      let actionSucceeded = false;
      if (consumed?.attemptId && !reconciled) {
        try {
          const latest = await loadRun(stateRoot, targetRunId);
          const latestActions = await listJsonRecords(stateRoot, safeJoin(latest.runDir, "actions"));
          const successfulAction = latestActions.find((action) => (
            action.attemptId === consumed.attemptId &&
            action.status === "spent" &&
            action.outcome === "success"
          ));
          if (successfulAction) {
            actionSucceeded = true;
            const repairReceiptFile = path.join(os.tmpdir(), `better-workflows-cache-repair-${randomUUID()}.json`);
            try {
              if (!successfulAction.receipt) {
                throw new Error("Persisted plugin cache success action has no receipt for readiness repair");
              }
              await writeFile(repairReceiptFile, `${JSON.stringify(successfulAction.receipt, null, 2)}\n`, { mode: 0o600 });
              const repairedResult = await runSbw([
                "action", "reconcile", targetRunId,
                "--attempt", consumed.attemptId,
                "--outcome", "success",
                "--receipt", repairReceiptFile
              ]);
              reconciled = true;
              result = { ok: true, publication, action: repairedResult.action, repaired: true };
            } finally {
              await rm(repairReceiptFile, { force: true }).catch(() => undefined);
            }
          }
        } catch (repairError) {
          error.message = `${error.message}; cache readiness repair failed: ${repairError.message}`;
        }
      }
      if (consumed?.attemptId && !reconciled && !actionSucceeded) {
        const unknownReceipt = {
          action: consumed.action,
          provider: consumed.provider,
          resource: consumed.resource,
          outcome: "unknown",
          runId: targetRunId,
          attemptId: consumed.attemptId,
          idempotencyKey: consumed.idempotencyKey,
          remoteRevision: consumed.remoteRevision,
          providerReceipt: {
            action: consumed.action,
            provider: consumed.provider,
            resource: consumed.resource,
            outcome: "unknown",
            runId: targetRunId,
            attemptId: consumed.attemptId,
            idempotencyKey: consumed.idempotencyKey,
            remoteRevision: consumed.remoteRevision,
            executionId: `local-workspace:plugin.cache.publish:${consumed.attemptId}`,
            proofKind: "local-workspace:plugin.cache.publish",
            requestDigest: digestObject({ action: consumed.action, provider: consumed.provider, resource: consumed.resource }),
            responseDigest: digestObject({ outcome: "unknown", error: error.message }),
            verifiedAt: nowIso(),
            terminalState: "unknown",
            error: error.message
          }
        };
        const receiptFile = path.join(os.tmpdir(), `better-workflows-cache-unknown-${randomUUID()}.json`);
        try {
          await writeFile(receiptFile, `${JSON.stringify(unknownReceipt, null, 2)}\n`, { mode: 0o600 });
          await runSbw([
            "action", "reconcile", targetRunId,
            "--attempt", consumed.attemptId,
            "--outcome", "unknown",
            "--receipt", receiptFile
          ]);
        } catch (reconcileError) {
          error.message = `${error.message}; unknown reconciliation failed: ${reconcileError.message}`;
        } finally {
          await rm(receiptFile, { force: true }).catch(() => undefined);
        }
      }
      if (consumed?.attemptId && !actionSucceeded) {
        const latest = await loadRun(stateRoot, targetRunId);
        const latestActions = await listJsonRecords(stateRoot, safeJoin(latest.runDir, "actions"));
        actionSucceeded = latestActions.some((action) => (
          action.attemptId === consumed.attemptId &&
          action.status === "spent" &&
          action.outcome === "success"
        ));
      }
      if (publication?.applied && !reconciled && !actionSucceeded) {
        try {
          await removeUnreadyPluginCachePublication({
            cacheRoot,
            version: publication.version,
            target: publication.target,
            targetDigest: publication.targetDigest,
            runId: targetRunId,
            attemptId: consumed.attemptId
          });
        } catch (cleanupError) {
          error.message = `${error.message}; unready cache cleanup failed: ${cleanupError.message}`;
        }
      }
      if (!reconciled) throw error;
    }
  } else {
    result = await checkPluginCache({ sourceRoot, cacheRoot });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
