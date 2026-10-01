#!/usr/bin/env node

import path from "node:path";
import { atomicWriteJson, digestObject, safeJoin } from "../plugins/better-workflows/scripts/lib/core.mjs";
import { observeWebsitePublicQaV1 } from "./website-public-qa-observer-v1.mjs";

const SHA40 = /^[a-f0-9]{40}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function producerBinding(sourceRevision) {
  if (process.env.SBW_WEBSITE_PUBLIC_QA_ATTESTATION_REQUIRED !== "1") return null;
  const repository = String(process.env.GITHUB_REPOSITORY ?? "").trim();
  const repositoryId = String(process.env.GITHUB_REPOSITORY_ID ?? "").trim();
  const runId = String(process.env.GITHUB_RUN_ID ?? "").trim();
  const runAttempt = String(process.env.GITHUB_RUN_ATTEMPT ?? "").trim();
  const expectedWorkflowRef = `${repository}/.github/workflows/website-public-qa.yml@refs/heads/main`;
  if (process.env.GITHUB_ACTIONS !== "true" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !POSITIVE_INTEGER.test(repositoryId) || !POSITIVE_INTEGER.test(runId) || !POSITIVE_INTEGER.test(runAttempt) ||
      process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_SHA !== sourceRevision ||
      process.env.GITHUB_WORKFLOW_SHA !== sourceRevision || process.env.GITHUB_WORKFLOW_REF !== expectedWorkflowRef ||
      process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("Public QA attestation requires the exact source-bound main GitHub workflow attempt");
  }
  return Object.freeze({ kind: "WebsitePublicQaWorkflowBindingV1", repository, repositoryId, runId, runAttempt,
    workflowRef: expectedWorkflowRef, workflowSha: sourceRevision, sourceRef: "refs/heads/main",
    event: "workflow_dispatch", runnerEnvironment: "github-hosted" });
}

function required(name, pattern = null) {
  const value = String(process.env[name] ?? "").trim();
  if (!value || (pattern && !pattern.test(value))) throw new Error(`Missing or invalid ${name}`);
  return value;
}

const sourceRevision = required("SBW_RELEASE_REVISION", SHA40);
const stateRoot = path.resolve(required("SBW_STATE_ROOT"));
const baseReceipt = await observeWebsitePublicQaV1({ repositoryRoot: path.resolve("."), sourceRevision });
const producer = producerBinding(sourceRevision);
const { receiptDigest: _baseReceiptDigest, ...basePayload } = baseReceipt;
const payload = producer ? { ...basePayload, producer } : basePayload;
const receipt = Object.freeze({ ...payload, receiptDigest: digestObject(payload) });
const outputPath = safeJoin(stateRoot, "release-gates", sourceRevision, "website-public-qa.json");
await atomicWriteJson(stateRoot, outputPath, receipt);
process.stdout.write(`${JSON.stringify({ ok: true, outputPath, receiptDigest: receipt.receiptDigest,
  locales: receipt.locales.length, documentationRoutes: receipt.publicDocumentationRoutes.length, sourceRevision }, null, 2)}\n`);
