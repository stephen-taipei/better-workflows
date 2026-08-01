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

function normalizeDiffManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.files)) {
    throw new Error("Review diff manifest must contain a files array");
  }
  const files = value.files.map((item) => {
    if (typeof item === "string") return { status: "M", path: item };
    if (!item || typeof item !== "object" || typeof item.status !== "string" || typeof item.path !== "string") {
      throw new Error("Review diff manifest entries require status and path");
    }
    return {
      status: item.status,
      path: item.path,
      ...(item.oldPath ? { oldPath: item.oldPath } : {})
    };
  }).sort((left, right) => digestObject(left).localeCompare(digestObject(right)));
  return { files };
}

async function deriveDiffManifest(cwd, base, head, scope) {
  const mergeBase = (await execFileAsync("git", ["merge-base", base, head], {
    cwd,
    encoding: "utf8"
  })).stdout.trim();
  const output = (await execFileAsync("git", [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    `${base}...${head}`,
    "--",
    ...scope
  ], { cwd, encoding: "utf8" })).stdout;
  const tokens = output.split("\0");
  const files = [];
  for (let index = 0; index < tokens.length - 1;) {
    const status = tokens[index++];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (!oldPath || !newPath) throw new Error("Git returned an incomplete rename diff manifest");
      files.push({ status, oldPath, path: newPath });
    } else {
      const filePath = tokens[index++];
      if (!filePath) throw new Error("Git returned an incomplete diff manifest");
      files.push({ status, path: filePath });
    }
  }
  return { mergeBase, diffManifest: normalizeDiffManifest({ files }) };
}

async function resolveCommit(cwd, revision, label) {
  const resolved = (await execFileAsync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    cwd,
    encoding: "utf8"
  })).stdout.trim();
  if (resolved !== revision) throw new Error(`Review ${label} does not resolve to the supplied commit`);
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
  if (scope.some((item) => typeof item !== "string" || !item || item.includes("\0") || item.startsWith("/"))) {
    throw new Error("Review scope contains an invalid path");
  }
  if (!DIGEST.test(instructionDigest) || !DIGEST.test(sentinelDigest)) {
    throw new Error("Review instruction and sentinel digests must be SHA-256 values");
  }
  if (run.contract.remoteRevision && run.contract.remoteRevision !== base) {
    throw new Error("Review BASE must match the run remote revision");
  }
  await resolveCommit(run.manifest.cwd, base, "BASE");
  await resolveCommit(run.manifest.cwd, head, "HEAD");
  const currentHead = (await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: run.manifest.cwd,
    encoding: "utf8"
  })).stdout.trim();
  if (currentHead !== head) throw new Error("Review HEAD must match the current checkout");
  if (run.state.lastSentinel?.digest && run.state.lastSentinel.digest !== sentinelDigest) {
    throw new Error("Review sentinel is not the verified current sentinel");
  }
  const { mergeBase, diffManifest: derivedDiffManifest } = await deriveDiffManifest(
    run.manifest.cwd,
    base,
    head,
    scope
  );
  const suppliedDiffManifest = normalizeDiffManifest(diffManifest);
  if (digestObject(suppliedDiffManifest) !== digestObject(derivedDiffManifest)) {
    throw new Error("Review diff manifest does not match Git BASE...HEAD");
  }
  const input = {
    base,
    head,
    mergeBase,
    scope,
    scopeDigest: digestObject(scope),
    diffManifest: derivedDiffManifest,
    diffManifestDigest: digestObject(derivedDiffManifest),
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

function validateFindingDisposition(finding) {
  const status = finding.status ?? "open";
  if (!["open", "resolved", "accepted-risk", "rejected-with-evidence"].includes(status)) {
    throw new Error("Review finding status is invalid");
  }
  if (status === "accepted-risk") {
    if (finding.severity === "P0") throw new Error("P0 review findings cannot be accepted as risk");
    if (!finding.owner || !finding.reason || !finding.expiry || Number.isNaN(Date.parse(finding.expiry))) {
      throw new Error("Accepted-risk review findings require owner, reason, and expiry");
    }
    if (Date.parse(finding.expiry) <= Date.now()) {
      throw new Error("Accepted-risk review finding expiry must be in the future");
    }
  }
  if (status === "rejected-with-evidence" && !finding.evidenceId) {
    throw new Error("Rejected review findings require evidenceId");
  }
  return status;
}

export async function addReviewFinding(root, runId, finding, { update = false } = {}) {
  const run = await loadRun(root, runId);
  if (!finding.packageId || !finding.path || !finding.location || !finding.rule) throw new Error("Review finding identity is required");
  if (!["P0", "P1", "P2", "P3"].includes(finding.severity)) throw new Error("Review finding severity is invalid");
  const status = validateFindingDisposition(finding);
  const id = stableFindingId(finding);
  const disposition = status === "accepted-risk"
    ? { owner: finding.owner, reason: finding.reason, expiry: finding.expiry }
    : status === "rejected-with-evidence"
      ? { evidenceId: finding.evidenceId }
      : {};
  const value = {
    schemaVersion: 1,
    id,
    packageId: finding.packageId,
    path: finding.path,
    location: finding.location,
    rule: finding.rule,
    severity: finding.severity,
    status,
    summary: String(finding.summary ?? ""),
    createdAt: finding.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    ...disposition
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
        ...disposition,
        updatedAt: nowIso()
      };
      for (const key of ["owner", "reason", "expiry", "evidenceId"]) {
        if (!Object.hasOwn(disposition, key)) delete next[key];
      }
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
  for (const finding of findings) validateFindingDisposition(finding);
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
  for (const finding of findings.filter((item) => item.packageId === packageIdValue)) {
    validateFindingDisposition(finding);
  }
  if (findings.some((item) => item.packageId === packageIdValue && item.status === "open")) {
    throw new Error("Broad review requires scoped findings to be closed");
  }
  const next = { ...value, broadReview: { required: true, complete: true, head, sentinelDigest, completedAt: nowIso() } };
  await atomicWriteJson(root, target, next);
  return next;
}
