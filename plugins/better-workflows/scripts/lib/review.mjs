import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWriteJson, digestObject, listJsonRecords, loadRun, nowIso, readJson, safeJoin, sha256 } from "./core.mjs";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function packageDirectory(runDir) {
  return safeJoin(runDir, "review-packages");
}

function findingDirectory(runDir) {
  return safeJoin(runDir, "review-findings");
}

function packageId(input) {
  return `review-${sha256(digestObject(input)).slice(0, 32)}`;
}

async function assertAncestor(cwd, base, head) {
  if (base === head) return;
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", base, head], { cwd });
  } catch {
    throw new Error("Review package requires BASE to be an ancestor of HEAD");
  }
}

export async function createReviewPackage({
  root,
  runId,
  base,
  head,
  scope,
  diffManifest,
  instructionDigest,
  sentinelDigest
}) {
  const run = await loadRun(root, runId);
  if (!SHA.test(base) || !SHA.test(head)) throw new Error("Review BASE and HEAD must be 40-character revisions");
  if (!Array.isArray(scope) || scope.length === 0) throw new Error("Review scope must be non-empty");
  if (!diffManifest || typeof diffManifest !== "object" || Array.isArray(diffManifest)) {
    throw new Error("Review diff manifest is required");
  }
  if (!DIGEST.test(instructionDigest) || !DIGEST.test(sentinelDigest)) {
    throw new Error("Review instruction and sentinel digests must be SHA-256 values");
  }
  await assertAncestor(run.manifest.cwd, base, head);
  const input = {
    base,
    head,
    scope,
    scopeDigest: digestObject(scope),
    diffManifest,
    diffManifestDigest: digestObject(diffManifest),
    contractDigest: digestObject(run.contract),
    templateDigest: run.contract.templateDigest,
    sentinelDigest,
    instructionDigest
  };
  const id = packageId(input);
  const value = {
    schemaVersion: 1,
    immutable: true,
    packageId: id,
    createdAt: nowIso(),
    ...input,
    repairRounds: 0,
    broadReview: { required: true, complete: false },
    findings: []
  };
  const target = safeJoin(packageDirectory(run.runDir), `${id}.json`);
  try {
    const existing = await readJson(root, target);
    const { createdAt: _existingCreatedAt, ...existingIdentity } = existing;
    const { createdAt: _createdAt, ...valueIdentity } = value;
    if (digestObject(existingIdentity) !== digestObject(valueIdentity)) throw new Error("Review package identity drifted");
    return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWriteJson(root, target, value);
  return value;
}

export function stableFindingId({ packageId: id, path, location, rule }) {
  if (!id || typeof path !== "string" || typeof location !== "string" || typeof rule !== "string") {
    throw new Error("Finding identity requires package, path, location, and rule");
  }
  return `finding-${sha256(digestObject({ packageId: id, path, location, rule }))}`;
}

export async function addReviewFinding(root, runId, finding, { update = false } = {}) {
  const run = await loadRun(root, runId);
  if (!finding.packageId || !finding.path || !finding.location || !finding.rule) throw new Error("Review finding identity is required");
  if (!["P0", "P1", "P2", "P3"].includes(finding.severity)) throw new Error("Review finding severity is invalid");
  if (!["open", "resolved", "accepted-risk", "rejected-with-evidence"].includes(finding.status ?? "open")) {
    throw new Error("Review finding status is invalid");
  }
  if (finding.status === "accepted-risk" && (!finding.owner || !finding.reason || !finding.expiry || Number.isNaN(Date.parse(finding.expiry)))) {
    throw new Error("Accepted-risk review findings require owner, reason, and expiry");
  }
  const id = stableFindingId(finding);
  const value = {
    schemaVersion: 1,
    id,
    packageId: finding.packageId,
    path: finding.path,
    location: finding.location,
    rule: finding.rule,
    severity: finding.severity,
    status: finding.status ?? "open",
    summary: String(finding.summary ?? ""),
    createdAt: finding.createdAt ?? nowIso(),
    updatedAt: nowIso()
  };
  const target = safeJoin(findingDirectory(run.runDir), `${id}.json`);
  try {
    const existing = await readJson(root, target);
    if (existing.packageId !== value.packageId || existing.path !== value.path || existing.location !== value.location || existing.rule !== value.rule) {
      throw new Error("Finding identity collision");
    }
    if (update) {
      const next = {
        ...existing,
        severity: value.severity,
        status: value.status,
        summary: value.summary,
        ...(finding.owner ? { owner: finding.owner } : {}),
        ...(finding.reason ? { reason: finding.reason } : {}),
        ...(finding.expiry ? { expiry: finding.expiry } : {}),
        updatedAt: nowIso()
      };
      await atomicWriteJson(root, target, next);
      return next;
    }
    return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWriteJson(root, target, value);
  return value;
}

export async function reviewStatus(root, runId) {
  const run = await loadRun(root, runId);
  const packageDir = packageDirectory(run.runDir);
  let packages = [];
  try {
    const { readdir } = await import("node:fs/promises");
    packages = await Promise.all((await readdir(packageDir)).filter((file) => file.endsWith(".json")).sort().map((file) => readJson(root, safeJoin(packageDir, file))));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const findings = [];
  try {
    const { readdir } = await import("node:fs/promises");
    const dir = findingDirectory(run.runDir);
    findings.push(...await Promise.all((await readdir(dir)).filter((file) => file.endsWith(".json")).sort().map((file) => readJson(root, safeJoin(dir, file)))));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const expectedContractDigest = digestObject(run.contract);
  for (const value of packages) {
    if (value.contractDigest !== expectedContractDigest || value.templateDigest !== run.contract.templateDigest) {
      throw new Error("Review package is bound to a different contract or template");
    }
    if (value.scopeDigest !== digestObject(value.scope) || value.diffManifestDigest !== digestObject(value.diffManifest)) {
      throw new Error("Review package identity digest is stale");
    }
  }
  let currentHead = null;
  try {
    currentHead = (await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: run.manifest.cwd,
      encoding: "utf8"
    })).stdout.trim();
  } catch {
    currentHead = null;
  }
  const scoped = packages.find((item) => item.head === currentHead) ?? packages[0] ?? null;
  const scopedFindings = scoped
    ? findings.filter((item) => item.packageId === scoped.packageId)
    : [];
  const openHigh = scopedFindings.filter((item) => ["P0", "P1"].includes(item.severity) && item.status === "open");
  const repairBudgetExhausted = Boolean(scoped?.repairRounds >= 5 && openHigh.length > 0);
  const broadSentinelMatches = !run.state.lastSentinel?.digest || scoped?.broadReview?.sentinelDigest === run.state.lastSentinel.digest;
  const broadHeadMatches = !currentHead || scoped?.head === currentHead;
  return {
    package: scoped,
    findings: scopedFindings,
    openHigh,
    repairBudgetExhausted,
    scopedClosed: Boolean(scoped && !repairBudgetExhausted && openHigh.length === 0 && scopedFindings.every((item) => item.status !== "open")),
    broadReviewComplete: Boolean(scoped?.broadReview?.complete && scoped.broadReview.head === scoped.head && broadHeadMatches && broadSentinelMatches),
    complete: Boolean(scoped && !repairBudgetExhausted && openHigh.length === 0 && scoped.broadReview?.complete && scoped.broadReview.head === scoped.head && broadHeadMatches && broadSentinelMatches)
  };
}

export async function recordRepairRound(root, runId, packageIdValue, result) {
  const run = await loadRun(root, runId);
  const target = safeJoin(packageDirectory(run.runDir), `${packageIdValue}.json`);
  const value = await readJson(root, target);
  const nextRound = Number(value.repairRounds ?? 0) + 1;
  if (nextRound > 5) throw new Error("Scoped review repair budget exhausted");
  const next = {
    ...value,
    repairRounds: nextRound,
    lastRepair: { at: nowIso(), ...result }
  };
  await atomicWriteJson(root, target, next);
  return next;
}

export async function markBroadReviewComplete(root, runId, packageIdValue, head, sentinelDigest) {
  const run = await loadRun(root, runId);
  if (!SHA.test(head) || !DIGEST.test(sentinelDigest)) throw new Error("Broad review binding is invalid");
  const target = safeJoin(packageDirectory(run.runDir), `${packageIdValue}.json`);
  const value = await readJson(root, target);
  if (head !== value.head) throw new Error("Broad review must bind the final HEAD");
  if (run.state.lastSentinel?.digest && sentinelDigest !== run.state.lastSentinel.digest) {
    throw new Error("Broad review sentinel is not the verified current sentinel");
  }
  try {
    const currentHead = (await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: run.manifest.cwd,
      encoding: "utf8"
    })).stdout.trim();
    if (currentHead && currentHead !== head) throw new Error("Broad review must bind the current HEAD");
  } catch (error) {
    if (error.message === "Broad review must bind the current HEAD") throw error;
  }
  const findings = await listJsonRecords(root, findingDirectory(run.runDir));
  if (findings.some((item) => item.packageId === packageIdValue && item.status === "open")) {
    throw new Error("Broad review requires scoped findings to be closed");
  }
  const next = { ...value, broadReview: { required: true, complete: true, head, sentinelDigest, completedAt: nowIso() } };
  await atomicWriteJson(root, target, next);
  return next;
}
