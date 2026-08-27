#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, digestObject, safeJoin, sha256 } from "./lib/core.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(pluginRoot, "../..");
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function required(name, pattern = null) {
  const value = String(process.env[name] ?? "").trim();
  if (!value || (pattern && !pattern.test(value))) throw new Error(`Missing or invalid ${name}`);
  return value;
}

async function github(method, endpoint, body = null, accepted = [200]) {
  const response = await fetch(`${required("GITHUB_API_URL", /^https:\/\//)}/repos/${required("GITHUB_REPOSITORY")}${endpoint}`, {
    method,
    redirect: "error",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${required("GITHUB_TOKEN")}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28"
    },
    body: body === null ? undefined : JSON.stringify(body)
  });
  if (!accepted.includes(response.status)) {
    const detail = (await response.text()).slice(0, 1000).replaceAll(required("GITHUB_TOKEN"), "[redacted]");
    throw new Error(`GitHub ${method} ${endpoint} returned ${response.status}: ${detail}`);
  }
  if (response.status === 204 || response.status === 404) return null;
  return response.json();
}

async function exactJsonReceipt(file, expectedKind, sourceRevision) {
  const receipt = JSON.parse(await readFile(file, "utf8"));
  const { receiptDigest, ...payload } = receipt;
  if (!SHA256.test(receiptDigest) || digestObject(payload) !== receiptDigest) throw new Error(`Receipt digest mismatch: ${file}`);
  if (payload.kind !== expectedKind || payload.schemaVersion !== 1 || payload.sourceRevision !== sourceRevision || payload.result !== "PASS") {
    throw new Error(`Receipt identity or result mismatch: ${file}`);
  }
  return receipt;
}

async function peelTag(object) {
  let current = object;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current.type === "commit") return current.sha;
    if (current.type !== "tag" || !SHA40.test(current.sha)) throw new Error("Release tag object is malformed");
    const tag = await github("GET", `/git/tags/${current.sha}`);
    current = tag.object;
  }
  throw new Error("Release tag nesting exceeds the verification bound");
}

const sourceRevision = required("SBW_RELEASE_REVISION", SHA40);
const stateRoot = path.resolve(required("SBW_STATE_ROOT"));
const actor = required("GITHUB_ACTOR");
const runId = required("GITHUB_RUN_ID", /^[1-9][0-9]*$/);
if (required("GITHUB_EVENT_NAME") !== "workflow_dispatch") throw new Error("Stable release requires workflow_dispatch authority");
if (required("SBW_FRESH_TEST_RESULT") !== "PASS") throw new Error("Fresh release tests did not pass");

const versionManifest = JSON.parse(await readFile(path.join(pluginRoot, "config", "version-manifest-v1.json"), "utf8"));
const packageManifest = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
if (packageManifest.version !== versionManifest.version) throw new Error("Version surfaces disagree");
const confirmation = required("SBW_RELEASE_AUTHORITY_CONFIRMATION");
if (confirmation !== `release ${versionManifest.releaseName}`) throw new Error("Release authority confirmation does not match the version manifest");

const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
if (stdout.trim() !== sourceRevision) throw new Error("Checked-out release source drifted");
const mainRef = await github("GET", "/git/ref/heads/main");
if (mainRef.object?.type !== "commit" || mainRef.object.sha !== sourceRevision) throw new Error("origin/main is not the authorized release revision");

const checks = await github("GET", `/commits/${sourceRevision}/check-runs?per_page=100`);
const successfulTest = checks.check_runs?.some((check) => (
  check.name === "test" &&
  check.head_sha === sourceRevision &&
  check.status === "completed" &&
  check.conclusion === "success" &&
  check.app?.slug === "github-actions" &&
  typeof check.details_url === "string" &&
  check.details_url.startsWith(`https://github.com/${required("GITHUB_REPOSITORY")}/actions/runs/`)
));
if (!successfulTest) throw new Error("The exact release revision lacks a successful fresh required test check");

const hostReceiptPath = path.resolve(required("SBW_HOST_GATE_RECEIPT"));
const websiteReceiptPath = path.resolve(required("SBW_WEBSITE_QA_RECEIPT"));
const hostReceipt = await exactJsonReceipt(hostReceiptPath, "better-workflows-release-conformance-gate", sourceRevision);
const websiteReceipt = await exactJsonReceipt(websiteReceiptPath, "WorkspaceWebsitePublicQaReceiptV1", sourceRevision);
if (hostReceipt.requiredCombinations !== 8 || hostReceipt.receipts?.length !== 8) throw new Error("Eight Tier 1 conformance receipts are required");
if (websiteReceipt.locales?.length !== 41) throw new Error("Forty-one public locale receipts are required");
if (hostReceipt.registryDigest !== websiteReceipt.hostRegistryDigest) throw new Error("Host registry drifted between conformance and website QA");
if (!hostReceipt.receipts.every((receipt) => (
  receipt.attestation === "github-oidc-verified" &&
  SHA256.test(receipt.attestationVerificationDigest) &&
  SHA256.test(receipt.extensionProbeDigest) &&
  SHA256.test(receipt.helperDigest) &&
  ((receipt.hostId === "gemini-cli" || receipt.hostId === "qwen-code")
    ? SHA256.test(receipt.installedBundleDigest)
    : receipt.installedBundleDigest === null)
))) {
  throw new Error("Tier 1 conformance gate lacks exact attestation or installed-bundle digests");
}
if (websiteReceipt.authentication?.status !== "awaiting-github-oidc-attestation" || websiteReceipt.authentication?.releaseEligible !== false) {
  throw new Error("Website QA receipt bypassed its external attestation requirement");
}
const { stdout: websiteAttestationOutput } = await execFileAsync("gh", [
  "attestation", "verify", websiteReceiptPath,
  "--repo", required("GITHUB_REPOSITORY"),
  "--signer-workflow", `${required("GITHUB_REPOSITORY")}/.github/workflows/stable-release.yml`,
  "--deny-self-hosted-runners"
], {
  env: process.env,
  encoding: "utf8",
  timeout: 60_000,
  maxBuffer: 2 * 1024 * 1024
});

const tagName = versionManifest.releaseTag;
let tagCreated = false;
let tagRef = await github("GET", `/git/ref/tags/${encodeURIComponent(tagName)}`, null, [200, 404]);
if (tagRef) {
  if (await peelTag(tagRef.object) !== sourceRevision) throw new Error(`Existing ${tagName} points to a different commit`);
} else {
  const tagObject = await github("POST", "/git/tags", {
    tag: tagName,
    message: `${versionManifest.releaseName}\n\nEvidence gates: fresh CI, 8 Tier 1 conformance receipts, exact-SHA website deployment, and 41-locale public QA.`,
    object: sourceRevision,
    type: "commit"
  }, [201]);
  try {
    await github("POST", "/git/refs", { ref: `refs/tags/${tagName}`, sha: tagObject.sha }, [201]);
    tagCreated = true;
  } catch (error) {
    tagRef = await github("GET", `/git/ref/tags/${encodeURIComponent(tagName)}`);
    if (await peelTag(tagRef.object) !== sourceRevision) throw error;
  }
}

let release = await github("GET", `/releases/tags/${encodeURIComponent(tagName)}`, null, [200, 404]);
let releaseCreated = false;
if (release) {
  if (release.tag_name !== tagName || release.name !== versionManifest.releaseName || release.draft || release.prerelease) {
    throw new Error("Existing GitHub Release does not match the stable release contract");
  }
} else {
  release = await github("POST", "/releases", {
    tag_name: tagName,
    target_commitish: sourceRevision,
    name: versionManifest.releaseName,
    body: [
      "Evidence-first, risk-adaptive workflows for Codex, Claude Code, Gemini CLI, and Qwen Code on macOS/Linux.",
      "",
      "- Low-risk Auto tasks may use Direct with targeted checks.",
      "- Git mutations use task-owned worktrees and safe integration by default.",
      "- Protected delivery, Replay, evidence freshness, and cleanup remain fail-closed.",
      "- macOS + Codex is the official reference experience.",
      "",
      `Release evidence binds exact revision ${sourceRevision}, eight Tier 1 host/OS receipts, and 41 public locale pages.`,
      "",
      "Better Workflows blocks observable workflow errors; it does not claim statistical proof of lower long-term scope drift."
    ].join("\n"),
    draft: false,
    prerelease: false,
    make_latest: "true"
  }, [201]);
  releaseCreated = true;
}

const finalTagRef = await github("GET", `/git/ref/tags/${encodeURIComponent(tagName)}`);
if (await peelTag(finalTagRef.object) !== sourceRevision) throw new Error("Post-release tag reconciliation failed");
const finalRelease = await github("GET", `/releases/tags/${encodeURIComponent(tagName)}`);
if (finalRelease.draft || finalRelease.prerelease || finalRelease.name !== versionManifest.releaseName) throw new Error("Post-release GitHub Release reconciliation failed");

const payload = {
  schemaVersion: 1,
  kind: "better-workflows-stable-release-receipt",
  sourceRevision,
  version: versionManifest.version,
  tagName,
  releaseName: versionManifest.releaseName,
  actor,
  workflowRunId: runId,
  authorityConfirmation: confirmation,
  freshRequiredCheck: "test",
  hostGateReceiptDigest: hostReceipt.receiptDigest,
  websiteQaReceiptDigest: websiteReceipt.receiptDigest,
  websiteAttestationVerificationDigest: sha256(websiteAttestationOutput),
  publicContentDigest: websiteReceipt.contentDigest,
  tagCreated,
  releaseCreated,
  releaseId: finalRelease.id,
  releaseUrl: finalRelease.html_url,
  result: "PASS"
};
const receipt = { ...payload, receiptDigest: digestObject(payload) };
const outputPath = safeJoin(stateRoot, "release-gates", sourceRevision, "stable-release.json");
await atomicWriteJson(stateRoot, outputPath, receipt);
process.stdout.write(`${JSON.stringify({ ok: true, outputPath, receiptDigest: receipt.receiptDigest, tagName, releaseUrl: finalRelease.html_url, tagCreated, releaseCreated }, null, 2)}\n`);
