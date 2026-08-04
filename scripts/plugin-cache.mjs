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
  publishPluginCache
} from "../plugins/better-workflows/scripts/lib/publication.mjs";
import {
  digestObject,
  getCodexPluginCacheRoot,
  getStateRoot,
  listJsonRecords,
  loadRun,
  nowIso,
  safeJoin
} from "../plugins/better-workflows/scripts/lib/core.mjs";
import { validateSelfImproveDeliveryHandoff } from "../plugins/better-workflows/scripts/lib/self-improve-handoff.mjs";
import { rm, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

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
        expectedSourceBinding
      });
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
      const providerReceipt = {
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
        dependencies: { workflowVersion: "3.0.0", files: [] },
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
          const file = path.join(os.tmpdir(), `better-workflows-${evidence.id}-${randomUUID()}.json`);
          tempFiles.push(file);
          await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
          await runSbw(["evidence", "add", targetRunId, "--file", file]);
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
    } catch (error) {
      if (consumed?.attemptId && !reconciled) {
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
      if (publication?.applied && !reconciled) {
        try {
          await removeUnreadyPluginCachePublication({
            cacheRoot,
            version: publication.version,
            target: publication.target,
            targetDigest: publication.targetDigest
          });
        } catch (cleanupError) {
          error.message = `${error.message}; unready cache cleanup failed: ${cleanupError.message}`;
        }
      }
      throw error;
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
