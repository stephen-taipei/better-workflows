import { appendJournal, assertMutableRun, atomicWriteJson, canonicalizeScope, digestObject, listJsonRecords, loadDefaults, loadRun, nowIso, readJson, safeJoin, sha256, withRunLock } from "./core.mjs";
import { captureSentinel, runSourceGit } from "./git.mjs";
import { reviewKernelEnabled } from "./review-policy.mjs";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REPAIR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVIEW_VERDICTS = new Set(["PASS", "BLOCK"]);
const VERIFICATION_VERDICTS = new Set(["CONFIRMED", "REFUTED", "PARTIAL", "OUT_OF_SCOPE", "INCONCLUSIVE"]);
const CLAIM_STATUSES = new Set(["observed", "inferred", "hypothesis"]);
const COVERAGE_DISPOSITIONS = new Set(["finding", "reviewed-no-issue", "policy-skipped", "blocked"]);

function packageDirectory(runDir) {
  return safeJoin(runDir, "review-packages");
}

function findingDirectory(runDir) {
  return safeJoin(runDir, "review-findings");
}

function axisDirectory(runDir) {
  return safeJoin(runDir, "review-axes");
}

function verificationDirectory(runDir) {
  return safeJoin(runDir, "review-verifications");
}

function coverageDirectory(runDir) {
  return safeJoin(runDir, "review-coverage");
}

function synthesisDirectory(runDir) {
  return safeJoin(runDir, "review-synthesis");
}

function packageId(input) {
  return `review-${sha256(digestObject(input)).slice(0, 32)}`;
}

const REVIEW_PACKAGE_IDENTITY_FIELDS = [
  "base",
  "head",
  "mergeBase",
  "scope",
  "scopeDigest",
  "diffManifest",
  "diffManifestDigest",
  "contractDigest",
  "templateDigest",
  "sentinelDigest",
  "instructionDigest"
];

function reviewPackageIdentity(value) {
  const fields = value.schemaVersion === 2
    ? ["schemaVersion", ...REVIEW_PACKAGE_IDENTITY_FIELDS, "workUnitPolicy", "reviewLanes", "reviewLanesDigest", "workUniverse", "workUniverseDigest"]
    : [...REVIEW_PACKAGE_IDENTITY_FIELDS];
  if (value.reviewProfileDigest !== undefined) fields.push("reviewProfileDigest");
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function reviewPackageIdIdentity(value) {
  return { immutable: value.immutable, ...reviewPackageIdentity(value) };
}

export function reviewPackageDigest(value) {
  return digestObject(reviewPackageIdentity(value));
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

function normalizeScope(scope) {
  return canonicalizeScope(scope);
}

function normalizeReviewLanes(lanes) {
  if (!Array.isArray(lanes) || lanes.length < 2 || lanes.length > 5) {
    throw new Error("Review kernel requires two to five declared lanes");
  }
  const seen = new Set();
  return lanes.map((lane) => {
    if (!lane || typeof lane !== "object" || Array.isArray(lane) || !SAFE_ID.test(String(lane.id ?? ""))) {
      throw new Error("Review kernel lane requires a safe id");
    }
    if (seen.has(lane.id)) throw new Error(`Duplicate review lane: ${lane.id}`);
    seen.add(lane.id);
    if (lane.role !== "finder" || !["context-rich", "low-context", "adversarial", "mechanical"].includes(lane.contextProfile)) {
      throw new Error(`Review kernel lane ${lane.id} has an invalid role or context profile`);
    }
    if (typeof lane.required !== "boolean") throw new Error(`Review kernel lane ${lane.id} must declare required`);
    return { id: lane.id, role: lane.role, contextProfile: lane.contextProfile, required: lane.required };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function workUnitId(item) {
  return `unit-${sha256(digestObject(item)).slice(0, 32)}`;
}

async function blobIdentity(cwd, revision, filePath) {
  const result = await runSourceGit(cwd, ["--literal-pathspecs", "ls-tree", "-z", revision, "--", filePath], { allowFailure: true });
  if (!result.ok || !result.stdout) return null;
  const record = result.stdout.split("\0").find(Boolean);
  const match = record?.match(/^(\d{6})\s+(\S+)\s+([0-9a-f]{40})\t(.+)$/s);
  return match ? { mode: match[1], type: match[2], blob: match[3] } : null;
}

async function deriveWorkUniverse(cwd, base, head, diffManifest) {
  const units = [];
  for (const entry of diffManifest.files) {
    const basePath = entry.oldPath ?? entry.path;
    const [baseIdentity, headIdentity] = await Promise.all([
      blobIdentity(cwd, base, basePath),
      blobIdentity(cwd, head, entry.path)
    ]);
    const statusKind = entry.status[0];
    if (
      !["A", "C", "D", "M", "R", "T"].includes(statusKind) ||
      (statusKind === "A" && (baseIdentity !== null || headIdentity === null)) ||
      (statusKind === "D" && (baseIdentity === null || headIdentity !== null)) ||
      (!["A", "D"].includes(statusKind) && (baseIdentity === null || headIdentity === null))
    ) {
      throw new Error(`Review work-unit Git identity is inconsistent for ${entry.path}`);
    }
    const unit = {
      status: entry.status,
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      base: baseIdentity,
      head: headIdentity
    };
    units.push({ id: workUnitId(unit), ...unit });
  }
  return units.sort((left, right) => left.id.localeCompare(right.id));
}

async function deriveDiffManifest(cwd, base, head, scope) {
  const mergeBase = (await runSourceGit(cwd, ["merge-base", base, head])).stdout.trim();
  const ancestor = await runSourceGit(cwd, ["merge-base", "--is-ancestor", base, head], { allowFailure: true });
  if (!ancestor.ok) {
    throw new Error("Review BASE must be an ancestor of HEAD");
  }
  if (ancestor.stdout !== "") {
    throw new Error("Review ancestry probe returned malformed success output");
  }
  const output = (await runSourceGit(cwd, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    `${base}..${head}`,
    "--",
    ...scope
  ])).stdout;
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
  const resolved = (await runSourceGit(cwd, ["rev-parse", "--verify", `${revision}^{commit}`])).stdout.trim();
  if (resolved !== revision) throw new Error(`Review ${label} does not resolve to the supplied commit`);
}

export async function createReviewPackage(request) {
  return withRunLock(request.root, request.runId, async ({ runDir }) => {
    const {
      root,
      runId,
      base,
      head,
      scope,
      diffManifest,
      instructionDigest,
      sentinelDigest
    } = request;
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Review package");
  if (!SHA.test(base) || !SHA.test(head)) throw new Error("Review BASE and HEAD must be 40-character revisions");
  if (!Array.isArray(scope) || scope.length === 0) throw new Error("Review scope must be non-empty");
  if (scope.some((item) => typeof item !== "string" || !item || item.includes("\0") || item.startsWith("/"))) {
    throw new Error("Review scope contains an invalid path");
  }
  const canonicalScope = normalizeScope(scope);
  const contractScope = run.contract.scope?.include;
  if (!Array.isArray(contractScope) || digestObject(canonicalScope) !== digestObject(normalizeScope(contractScope))) {
    throw new Error("Review scope must match the TaskContract scope");
  }
  if (!DIGEST.test(instructionDigest) || !DIGEST.test(sentinelDigest)) {
    throw new Error("Review instruction and sentinel digests must be SHA-256 values");
  }
  if (run.contract.remoteRevision && run.contract.remoteRevision !== base) {
    throw new Error("Review BASE must match the run remote revision");
  }
  await resolveCommit(run.manifest.cwd, base, "BASE");
  await resolveCommit(run.manifest.cwd, head, "HEAD");
  const currentHead = (await runSourceGit(run.manifest.cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  if (currentHead !== head) throw new Error("Review HEAD must match the current checkout");
  if (
    run.state.lastSentinelVerified !== true ||
    run.state.lastSentinelComplete !== true ||
    run.state.lastSentinel?.digest !== sentinelDigest
  ) throw new Error("Review sentinel is not a verified complete current sentinel");
  const { mergeBase, diffManifest: derivedDiffManifest } = await deriveDiffManifest(
    run.manifest.cwd,
    base,
    head,
    canonicalScope
  );
  if (mergeBase !== base) throw new Error("Review BASE must equal the Git merge base of HEAD");
  const suppliedDiffManifest = normalizeDiffManifest(diffManifest);
  if (digestObject(suppliedDiffManifest) !== digestObject(derivedDiffManifest)) {
    throw new Error("Review diff manifest does not match Git BASE...HEAD");
  }
  const input = {
    immutable: true,
    base,
    head,
    mergeBase,
    scope: canonicalScope,
    scopeDigest: digestObject(canonicalScope),
    diffManifest: derivedDiffManifest,
    diffManifestDigest: digestObject(derivedDiffManifest),
    contractDigest: digestObject(run.contract),
    templateDigest: run.contract.templateDigest,
    sentinelDigest,
    instructionDigest,
    ...(run.contract.reviewProfile
      ? { reviewProfileDigest: digestObject(run.contract.reviewProfile) }
      : {})
  };
  if (reviewKernelEnabled(run.contract.controlPlane?.reviewPolicy)) {
    const reviewLanes = normalizeReviewLanes(run.contract.controlPlane.reviewLanes);
    const requiredLanes = reviewLanes.filter((lane) => lane.required);
    if (requiredLanes.length < 2 || requiredLanes.every((lane) => lane.contextProfile === "low-context")) {
      throw new Error("Review kernel requires two required lanes including a non-low-context lane");
    }
    const workUniverse = await deriveWorkUniverse(run.manifest.cwd, base, head, derivedDiffManifest);
    Object.assign(input, {
      schemaVersion: 2,
      workUnitPolicy: run.contract.controlPlane.workUnitPolicy,
      reviewLanes,
      reviewLanesDigest: digestObject(reviewLanes),
      workUniverse,
      workUniverseDigest: digestObject(workUniverse)
    });
  }
  const id = packageId(input);
  const value = {
    schemaVersion: input.schemaVersion ?? 1,
    immutable: true,
    packageId: id,
    createdAt: nowIso(),
    ...input,
    repairRounds: 0,
    broadReview: { required: true, complete: false },
    findings: []
  };
    const target = safeJoin(packageDirectory(runDir), `${id}.json`);
    try {
      const existing = await readJson(root, target);
      if (digestObject(reviewPackageIdentity(existing)) !== digestObject(reviewPackageIdentity(value))) {
        throw new Error("Review package identity drifted");
      }
      return existing;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await atomicWriteJson(root, target, value);
    return value;
  });
}

export function stableFindingId({ packageId: id, path, location, rule }) {
  if (!id || typeof path !== "string" || typeof location !== "string" || typeof rule !== "string") {
    throw new Error("Finding identity requires package, path, location, and rule");
  }
  return `finding-${sha256(digestObject({ packageId: id, path, location, rule }))}`;
}

function boundedText(value, label, maximum = 2_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0\r]/.test(value)) {
    throw new Error(`${label} must be bounded non-empty text without control delimiters`);
  }
  return value.trim();
}

function boundedTextArray(value, label) {
  if (!Array.isArray(value) || value.length > 32) throw new Error(`${label} must be a bounded array`);
  return value.map((item, index) => boundedText(item, `${label}[${index}]`, 1_000));
}

function providerExecutionIdentity(execution) {
  return {
    provider: execution.provider,
    model: execution.model,
    executionId: execution.executionId,
    modelAssurance: execution.modelAssurance,
    trustAttested: execution.trustAttested,
    promptDigest: execution.promptDigest,
    reviewDigest: execution.reviewDigest,
    attestationDigest: execution.attestationDigest,
    transport: execution.transport,
    sandbox: execution.sandbox
  };
}

function validateReviewExecution(execution, reviewDigest, inputDigest, executionId) {
  if (
    !execution || typeof execution !== "object" || Array.isArray(execution) ||
    !SAFE_ID.test(String(execution.provider ?? "")) || !SAFE_ID.test(String(execution.model ?? "")) ||
    !SAFE_ID.test(String(execution.executionId ?? "")) || execution.executionId !== executionId ||
    execution.modelAssurance !== "host-signed-attestation" || execution.trustAttested !== true ||
    execution.promptDigest !== inputDigest || execution.reviewDigest !== reviewDigest ||
    !DIGEST.test(String(execution.attestationDigest ?? "")) || execution.transport !== "native-subagent" ||
    execution.sandbox !== "read-only" ||
    execution.executionDigest !== digestObject(providerExecutionIdentity(execution))
  ) {
    throw new Error("Review kernel provider execution is invalid or unattested");
  }
  return { ...providerExecutionIdentity(execution), executionDigest: execution.executionDigest };
}

function findingClaimIdentity(finding) {
  return {
    id: finding.id,
    unitId: finding.unitId,
    path: finding.path,
    side: finding.side,
    anchor: {
      side: finding.anchor.side,
      blob: finding.anchor.blob,
      contentDigest: finding.anchor.contentDigest,
      quote: finding.anchor.quote,
      quoteDigest: finding.anchor.quoteDigest,
      resolution: finding.anchor.resolution,
      resolvedLine: finding.anchor.resolvedLine
    },
    rule: finding.rule,
    rootCause: finding.rootCause
  };
}

const SEVERITY_RANK = new Map(["P0", "P1", "P2", "P3"].map((severity, rank) => [severity, rank]));
const CLAIM_STATUS_RANK = new Map(["observed", "inferred", "hypothesis"].map((status, rank) => [status, rank]));

function highestRanked(values, ranks) {
  return [...new Set(values)].sort((left, right) => (
    (ranks.get(left) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(right) ?? Number.MAX_SAFE_INTEGER) ||
    left.localeCompare(right)
  ))[0];
}

function deterministicTextUnion(findings, field) {
  return [...new Set(findings.flatMap((finding) => finding[field] ?? []))].sort();
}

function synthesizeClaim(findings) {
  const first = findings[0];
  const identity = findingClaimIdentity(first);
  const reportedLines = findings
    .map((finding) => finding.anchor.reportedLine)
    .filter((line) => Number.isInteger(line) && line > 0)
    .sort((left, right) => left - right);
  return {
    ...identity,
    anchor: { ...identity.anchor, reportedLine: reportedLines[0] ?? null },
    severity: highestRanked(findings.map((finding) => finding.severity), SEVERITY_RANK),
    originalSeverity: highestRanked(findings.map((finding) => finding.originalSeverity), SEVERITY_RANK),
    claimStatus: highestRanked(findings.map((finding) => finding.claimStatus), CLAIM_STATUS_RANK),
    summary: [...new Set(findings.map((finding) => finding.summary))].sort()[0],
    searchProof: deterministicTextUnion(findings, "searchProof"),
    counterEvidence: deterministicTextUnion(findings, "counterEvidence"),
    runtimeTrace: deterministicTextUnion(findings, "runtimeTrace")
  };
}

function axisReviewIdentity(value) {
  return {
    schemaVersion: value.schemaVersion,
    packageId: value.packageId,
    axisId: value.axisId,
    repairRound: value.repairRound,
    executionId: value.executionId,
    reviewerId: value.reviewerId,
    role: value.role,
    contextProfile: value.contextProfile,
    contextDigest: value.contextDigest,
    inputDigest: value.inputDigest,
    toolPolicyDigest: value.toolPolicyDigest,
    verdict: value.verdict,
    unitResults: value.unitResults,
    findings: value.findings
  };
}

async function resolveAnchor(cwd, reviewPackage, unit, finding) {
  const side = finding.side;
  if (!['base', 'head'].includes(side)) throw new Error("Review finding side must be base or head");
  const pathname = side === "base" ? (unit.oldPath ?? unit.path) : unit.path;
  if (finding.path !== pathname) throw new Error("Review finding path does not match its work unit side");
  const expected = unit[side];
  const anchor = finding.anchor;
  if (!expected || !anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
    throw new Error("Review finding requires an anchor on an existing blob");
  }
  if (anchor.blob !== expected.blob || !DIGEST.test(String(anchor.contentDigest ?? ""))) {
    throw new Error("Review finding anchor blob or content digest is invalid");
  }
  const blob = await runSourceGit(cwd, ["cat-file", "blob", expected.blob], { encoding: "buffer" });
  const bytes = blob.stdout;
  if (!Buffer.isBuffer(bytes) || sha256(bytes) !== anchor.contentDigest) {
    throw new Error("Review finding anchor content digest does not match Git");
  }
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Review finding anchors require UTF-8 text blobs");
  }
  const quote = boundedText(anchor.quote, "Review finding anchor quote", 500);
  const offsets = [];
  for (let offset = content.indexOf(quote); offset >= 0; offset = content.indexOf(quote, offset + Math.max(1, quote.length))) {
    offsets.push(offset);
    if (offsets.length > 1) break;
  }
  const resolution = offsets.length === 1 ? "exact" : offsets.length > 1 ? "ambiguous" : "missing";
  const resolvedLine = resolution === "exact" ? content.slice(0, offsets[0]).split("\n").length : null;
  return {
    side,
    blob: expected.blob,
    contentDigest: anchor.contentDigest,
    quote,
    quoteDigest: sha256(quote),
    reportedLine: Number.isInteger(anchor.reportedLine) && anchor.reportedLine > 0 ? anchor.reportedLine : null,
    resolution,
    resolvedLine
  };
}

export function stableReviewFindingV2Id({ packageId: id, path, side, anchor, rule, rootCause }) {
  if (!id || !path || !side || !anchor?.quoteDigest || !rule || !rootCause) {
    throw new Error("Review finding v2 identity is incomplete");
  }
  return `finding-v2-${sha256(digestObject({
    packageId: id,
    path,
    side,
    anchorDigest: anchor.quoteDigest,
    rule: rule.trim().toLowerCase(),
    rootCause: rootCause.trim().toLowerCase()
  }))}`;
}

async function normalizeAxisFinding(cwd, reviewPackage, units, axisId, finding) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding) || !SAFE_ID.test(String(finding.unitId ?? ""))) {
    throw new Error("Review axis finding requires a work unit id");
  }
  const unit = units.get(finding.unitId);
  if (!unit) throw new Error(`Review axis finding references an unknown work unit: ${finding.unitId}`);
  if (!["P0", "P1", "P2", "P3"].includes(finding.severity)) throw new Error("Review axis finding severity is invalid");
  if (!CLAIM_STATUSES.has(finding.claimStatus)) throw new Error("Review axis finding claimStatus is invalid");
  const anchor = await resolveAnchor(cwd, reviewPackage, unit, finding);
  const normalized = {
    unitId: unit.id,
    path: finding.path,
    side: finding.side,
    anchor,
    rule: boundedText(finding.rule, "Review axis finding rule", 256),
    rootCause: boundedText(finding.rootCause, "Review axis finding root cause", 1_000),
    severity: finding.severity,
    originalSeverity: finding.originalSeverity ?? finding.severity,
    claimStatus: finding.claimStatus,
    summary: boundedText(finding.summary, "Review axis finding summary", 2_000),
    searchProof: boundedTextArray(finding.searchProof ?? [], "Review axis finding search proof"),
    counterEvidence: boundedTextArray(finding.counterEvidence ?? [], "Review axis finding counter evidence"),
    runtimeTrace: boundedTextArray(finding.runtimeTrace ?? [], "Review axis finding runtime trace"),
    sourceAxisIds: [axisId]
  };
  if (!["P0", "P1", "P2", "P3"].includes(normalized.originalSeverity)) {
    throw new Error("Review axis finding original severity is invalid");
  }
  return { ...normalized, id: stableReviewFindingV2Id({ packageId: reviewPackage.packageId, ...normalized }) };
}

function normalizeUnitResults(results, workUniverse, findingIdsByUnit) {
  if (!Array.isArray(results)) throw new Error("Review axis unitResults must be an array");
  const expected = new Set(workUniverse.map((unit) => unit.id));
  const seen = new Set();
  const normalized = results.map((result) => {
    if (!result || typeof result !== "object" || Array.isArray(result) || !expected.has(result.unitId)) {
      throw new Error("Review axis unit result references an unknown work unit");
    }
    if (seen.has(result.unitId)) throw new Error(`Review axis duplicates work unit: ${result.unitId}`);
    seen.add(result.unitId);
    if (!COVERAGE_DISPOSITIONS.has(result.disposition)) throw new Error("Review axis work-unit disposition is invalid");
    const findingIds = [...(findingIdsByUnit.get(result.unitId) ?? [])].sort();
    if (result.disposition === "finding" && findingIds.length === 0) {
      throw new Error("Review axis finding disposition requires a durable finding");
    }
    if (result.disposition !== "finding" && findingIds.length > 0) {
      throw new Error("Review axis finding must use the finding disposition");
    }
    const reason = ["policy-skipped", "blocked"].includes(result.disposition)
      ? boundedText(result.reason, "Review axis work-unit reason", 1_000)
      : null;
    return { unitId: result.unitId, disposition: result.disposition, findingIds, ...(reason ? { reason } : {}) };
  }).sort((left, right) => left.unitId.localeCompare(right.unitId));
  if (seen.size !== expected.size) throw new Error("Review axis must account for every work unit exactly once");
  return normalized;
}

async function prepareReviewAxisForRun(root, run, input) {
    if (!reviewKernelEnabled(run.contract.controlPlane?.reviewPolicy)) {
      throw new Error("Review axes require code-v2-pilot");
    }
    if (!input || input.schemaVersion !== 2 || !SAFE_ID.test(String(input.axisId ?? "")) || !SAFE_ID.test(String(input.executionId ?? "")) || !SAFE_ID.test(String(input.reviewerId ?? ""))) {
      throw new Error("Review axis identity is invalid");
    }
    const targetPackage = safeJoin(packageDirectory(run.runDir), `${input.packageId}.json`);
    const reviewPackage = await readJson(root, targetPackage).catch((error) => {
      if (error.code === "ENOENT") throw new Error("Review axis references an unknown package");
      throw error;
    });
    if (reviewPackage.schemaVersion !== 2 || reviewPackage.head !== (await runSourceGit(run.manifest.cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim()) {
      throw new Error("Review axis requires the current v2 review package");
    }
    if (input.repairRound !== reviewPackage.repairRounds) throw new Error("Review axis repair round is stale");
    const lane = reviewPackage.reviewLanes.find((item) => item.id === input.axisId);
    if (!lane || input.role !== lane.role || input.contextProfile !== lane.contextProfile) {
      throw new Error("Review axis does not match its declared lane");
    }
    for (const [value, label] of [
      [input.contextDigest, "context"],
      [input.inputDigest, "input"],
      [input.toolPolicyDigest, "tool policy"]
    ]) {
      if (!DIGEST.test(String(value ?? ""))) throw new Error(`Review axis ${label} digest is invalid`);
    }
    if (!REVIEW_VERDICTS.has(input.verdict)) throw new Error("Review axis verdict is invalid");
    const units = new Map(reviewPackage.workUniverse.map((unit) => [unit.id, unit]));
    const findings = [];
    for (const finding of input.findings ?? []) {
      findings.push(await normalizeAxisFinding(run.manifest.cwd, reviewPackage, units, input.axisId, finding));
    }
    const duplicateFinding = findings.find((finding, index) => findings.findIndex((item) => item.id === finding.id) !== index);
    if (duplicateFinding) throw new Error(`Review axis duplicates finding: ${duplicateFinding.id}`);
    const findingIdsByUnit = new Map();
    for (const finding of findings) {
      findingIdsByUnit.set(finding.unitId, [...(findingIdsByUnit.get(finding.unitId) ?? []), finding.id]);
    }
    const unitResults = normalizeUnitResults(input.unitResults, reviewPackage.workUniverse, findingIdsByUnit);
    const mustBlock = findings.length > 0 || unitResults.some((item) => item.disposition === "blocked");
    if ((mustBlock && input.verdict !== "BLOCK") || (!mustBlock && input.verdict !== "PASS")) {
      throw new Error("Review axis verdict does not match its findings and work-unit dispositions");
    }
    const value = {
      schemaVersion: 2,
      packageId: reviewPackage.packageId,
      axisId: input.axisId,
      repairRound: input.repairRound,
      executionId: input.executionId,
      reviewerId: input.reviewerId,
      role: input.role,
      contextProfile: input.contextProfile,
      contextDigest: input.contextDigest,
      inputDigest: input.inputDigest,
      toolPolicyDigest: input.toolPolicyDigest,
      verdict: input.verdict,
      unitResults,
      findings: findings.sort((left, right) => left.id.localeCompare(right.id))
    };
    return { reviewPackage, value, reviewDigest: digestObject(axisReviewIdentity(value)) };
}

export async function prepareReviewAxis(root, runId, input) {
  const run = await loadRun(root, runId);
  const prepared = await prepareReviewAxisForRun(root, run, input);
  return { value: prepared.value, reviewDigest: prepared.reviewDigest };
}

export async function recordReviewAxis(root, runId, input) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Review axis");
    const { value, reviewDigest } = await prepareReviewAxisForRun(root, run, input);
    const providerExecution = validateReviewExecution(input.providerExecution, reviewDigest, input.inputDigest, value.executionId);
    const axisDigest = digestObject({ ...value, providerExecution });
    const existing = (await listJsonRecords(root, axisDirectory(runDir))).find((axis) => (
      axis.packageId === value.packageId && axis.executionId === value.executionId
    ));
    if (existing) {
      if (existing.axisDigest !== axisDigest) throw new Error("Review axis execution retry conflicts with the persisted receipt");
      return existing;
    }
    const record = { ...value, providerExecution, reviewDigest, axisDigest, recordedAt: nowIso() };
    const target = safeJoin(axisDirectory(runDir), `${value.repairRound}-${value.axisId}-${value.executionId}.json`);
    await atomicWriteJson(root, target, record);
    await appendJournal(root, runDir, "review.axis-recorded", {
      packageId: value.packageId,
      axisId: value.axisId,
      executionId: value.executionId,
      verdict: value.verdict,
      findingIds: value.findings.map((finding) => finding.id),
      axisDigest
    });
    return record;
  });
}

function verificationIdentity(value) {
  return {
    schemaVersion: value.schemaVersion,
    packageId: value.packageId,
    repairRound: value.repairRound,
    findingId: value.findingId,
    claimDigest: value.claimDigest,
    executionId: value.executionId,
    reviewerId: value.reviewerId,
    inputDigest: value.inputDigest,
    toolPolicyDigest: value.toolPolicyDigest,
    verdict: value.verdict,
    evidence: value.evidence,
    counterEvidence: value.counterEvidence
  };
}

async function prepareFindingVerificationForRun(root, run, input) {
    if (!reviewKernelEnabled(run.contract.controlPlane?.reviewPolicy)) throw new Error("Finding verification requires code-v2-pilot");
    if (!input || input.schemaVersion !== 2 || !SAFE_ID.test(String(input.executionId ?? "")) || !SAFE_ID.test(String(input.reviewerId ?? ""))) {
      throw new Error("Review finding verification identity is invalid");
    }
    const reviewPackage = await readJson(root, safeJoin(packageDirectory(run.runDir), `${input.packageId}.json`));
    if (reviewPackage.schemaVersion !== 2 || input.repairRound !== reviewPackage.repairRounds) {
      throw new Error("Review finding verification package or repair round is stale");
    }
    const axes = (await listJsonRecords(root, axisDirectory(run.runDir))).filter((axis) => (
      axis.packageId === input.packageId && axis.repairRound === input.repairRound
    ));
    const sources = axes.flatMap((axis) => axis.findings
      .filter((finding) => finding.id === input.findingId)
      .map((finding) => ({ axis, finding })));
    if (sources.length === 0) throw new Error("Review finding verification references an unknown current finding");
    const canonicalClaim = sources[0].finding;
    if (sources.some((source) => digestObject(findingClaimIdentity(source.finding)) !== digestObject(findingClaimIdentity(canonicalClaim)))) {
      throw new Error("Review finding claims conflict across finder axes");
    }
    if (input.claimDigest !== digestObject(findingClaimIdentity(canonicalClaim))) throw new Error("Review finding verification claim digest is stale");
    if (sources.some((source) => source.axis.executionId === input.executionId || source.axis.reviewerId === input.reviewerId)) {
      throw new Error("Review finding finder cannot verify its own claim");
    }
    if (!VERIFICATION_VERDICTS.has(input.verdict)) throw new Error("Review finding verification verdict is invalid");
    if (!DIGEST.test(String(input.inputDigest ?? "")) || !DIGEST.test(String(input.toolPolicyDigest ?? ""))) {
      throw new Error("Review finding verification input or tool-policy digest is invalid");
    }
    const value = {
      schemaVersion: 2,
      packageId: input.packageId,
      repairRound: input.repairRound,
      findingId: input.findingId,
      claimDigest: input.claimDigest,
      executionId: input.executionId,
      reviewerId: input.reviewerId,
      inputDigest: input.inputDigest,
      toolPolicyDigest: input.toolPolicyDigest,
      verdict: input.verdict,
      evidence: boundedTextArray(input.evidence ?? [], "Review finding verification evidence"),
      counterEvidence: boundedTextArray(input.counterEvidence ?? [], "Review finding verification counter evidence")
    };
    if (value.evidence.length === 0) throw new Error("Review finding verification requires evidence");
    return { value, reviewDigest: digestObject(verificationIdentity(value)) };
}

export async function prepareFindingVerification(root, runId, input) {
  const run = await loadRun(root, runId);
  return prepareFindingVerificationForRun(root, run, input);
}

export async function recordFindingVerification(root, runId, input) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Review finding verification");
    const { value, reviewDigest } = await prepareFindingVerificationForRun(root, run, input);
    const providerExecution = validateReviewExecution(input.providerExecution, reviewDigest, input.inputDigest, value.executionId);
    const verificationDigest = digestObject({ ...value, providerExecution });
    const existing = (await listJsonRecords(root, verificationDirectory(runDir))).find((item) => (
      item.packageId === value.packageId && item.findingId === value.findingId && item.executionId === value.executionId
    ));
    if (existing) {
      if (existing.verificationDigest !== verificationDigest) throw new Error("Review finding verification retry conflicts with the persisted receipt");
      return existing;
    }
    const record = { ...value, providerExecution, reviewDigest, verificationDigest, recordedAt: nowIso() };
    await atomicWriteJson(root, safeJoin(verificationDirectory(runDir), `${value.repairRound}-${value.findingId}-${value.executionId}.json`), record);
    await appendJournal(root, runDir, "review.finding-verified", {
      packageId: value.packageId,
      findingId: value.findingId,
      executionId: value.executionId,
      verdict: value.verdict,
      verificationDigest
    });
    return record;
  });
}

function validateStoredAxis(reviewPackage, axis) {
  if (
    axis.schemaVersion !== 2 || axis.packageId !== reviewPackage.packageId ||
    axis.repairRound !== reviewPackage.repairRounds
  ) throw new Error("Review axis receipt is stale or bound to a different package");
  const lane = reviewPackage.reviewLanes.find((item) => item.id === axis.axisId);
  if (!lane || lane.role !== axis.role || lane.contextProfile !== axis.contextProfile) {
    throw new Error("Review axis receipt does not match its declared lane");
  }
  const identity = axisReviewIdentity(axis);
  const reviewDigest = digestObject(identity);
  if (axis.reviewDigest !== reviewDigest) throw new Error("Review axis receipt digest is stale");
  const providerExecution = validateReviewExecution(axis.providerExecution, reviewDigest, axis.inputDigest, axis.executionId);
  if (axis.axisDigest !== digestObject({ ...identity, providerExecution })) {
    throw new Error("Review axis aggregate digest is stale");
  }
  return { ...axis, providerExecution };
}

function validateStoredVerification(reviewPackage, verification) {
  if (
    verification.schemaVersion !== 2 || verification.packageId !== reviewPackage.packageId ||
    verification.repairRound !== reviewPackage.repairRounds
  ) throw new Error("Review finding verification is stale or bound to a different package");
  const identity = verificationIdentity(verification);
  const reviewDigest = digestObject(identity);
  if (verification.reviewDigest !== reviewDigest) throw new Error("Review finding verification digest is stale");
  const providerExecution = validateReviewExecution(verification.providerExecution, reviewDigest, verification.inputDigest, verification.executionId);
  if (verification.verificationDigest !== digestObject({ ...identity, providerExecution })) {
    throw new Error("Review finding verification aggregate digest is stale");
  }
  return { ...verification, providerExecution };
}

function aggregateVerificationVerdict(verifications) {
  if (verifications.length === 0) return "UNVERIFIED";
  const verdicts = [...new Set(verifications.map((item) => item.verdict))];
  return verdicts.length === 1 ? verdicts[0] : "INCONCLUSIVE";
}

async function deriveReviewKernel(root, run, reviewPackage) {
  if (!reviewPackage || reviewPackage.schemaVersion !== 2) return null;
  const allAxes = (await listJsonRecords(root, axisDirectory(run.runDir)))
    .filter((item) => item.packageId === reviewPackage.packageId && item.repairRound === reviewPackage.repairRounds)
    .map((item) => validateStoredAxis(reviewPackage, item))
    .sort((left, right) => left.axisDigest.localeCompare(right.axisDigest));
  const allVerifications = (await listJsonRecords(root, verificationDirectory(run.runDir)))
    .filter((item) => item.packageId === reviewPackage.packageId && item.repairRound === reviewPackage.repairRounds)
    .map((item) => validateStoredVerification(reviewPackage, item))
    .sort((left, right) => left.verificationDigest.localeCompare(right.verificationDigest));
  const requiredLanes = reviewPackage.reviewLanes.filter((lane) => lane.required);
  const axesByLane = new Map(reviewPackage.reviewLanes.map((lane) => [
    lane.id,
    allAxes.filter((axis) => axis.axisId === lane.id)
  ]));
  const laneConflicts = reviewPackage.reviewLanes
    .filter((lane) => (axesByLane.get(lane.id) ?? []).length > 1)
    .map((lane) => lane.id);
  const missingRequiredLanes = requiredLanes
    .filter((lane) => (axesByLane.get(lane.id) ?? []).length !== 1)
    .map((lane) => lane.id);
  const executionUses = new Map();
  for (const receipt of [...allAxes, ...allVerifications]) {
    executionUses.set(receipt.executionId, (executionUses.get(receipt.executionId) ?? 0) + 1);
  }
  const reusedExecutionIds = [...executionUses.entries()]
    .filter(([, count]) => count > 1)
    .map(([executionId]) => executionId)
    .sort();
  const coverage = reviewPackage.workUniverse.map((unit) => {
    const lanes = requiredLanes.map((lane) => {
      const axis = (axesByLane.get(lane.id) ?? [])[0] ?? null;
      const result = axis?.unitResults.find((item) => item.unitId === unit.id) ?? null;
      return {
        axisId: lane.id,
        contextProfile: lane.contextProfile,
        executionId: axis?.executionId ?? null,
        disposition: result?.disposition ?? "missing",
        findingIds: result?.findingIds ?? [],
        ...(result?.reason ? { reason: result.reason } : {})
      };
    });
    const accounted = lanes.every((lane) => !["missing", "blocked"].includes(lane.disposition));
    const substantivelyReviewed = lanes.some((lane) => ["finding", "reviewed-no-issue"].includes(lane.disposition));
    return { unitId: unit.id, path: unit.path, lanes, complete: accounted && substantivelyReviewed };
  });
  const claimsById = new Map();
  for (const axis of allAxes) {
    for (const finding of axis.findings) {
      const claimDigest = digestObject(findingClaimIdentity(finding));
      const entry = claimsById.get(finding.id) ?? { claims: [], sources: [] };
      entry.claims.push({ claimDigest, finding });
      entry.sources.push({ axisId: axis.axisId, executionId: axis.executionId, reviewerId: axis.reviewerId });
      claimsById.set(finding.id, entry);
    }
  }
  const findings = [...claimsById.entries()].map(([findingId, entry]) => {
    const claimDigests = [...new Set(entry.claims.map((item) => item.claimDigest))];
    const claimConflict = claimDigests.length !== 1;
    const claimDigest = claimDigests[0];
    const verifications = allVerifications.filter((item) => item.findingId === findingId && item.claimDigest === claimDigest);
    const selfVerification = verifications.some((verification) => entry.sources.some((source) => (
      source.executionId === verification.executionId || source.reviewerId === verification.reviewerId
    )));
    const verificationVerdict = claimConflict || selfVerification
      ? "INCONCLUSIVE"
      : aggregateVerificationVerdict(verifications);
    const finding = synthesizeClaim(entry.claims.map((item) => item.finding));
    const exactAnchor = finding.anchor.resolution === "exact";
    const blocking = !exactAnchor || !["REFUTED", "OUT_OF_SCOPE"].includes(verificationVerdict);
    return {
      ...finding,
      claimDigest,
      sourceAxisIds: [...new Set(entry.sources.map((source) => source.axisId))].sort(),
      sourceExecutionIds: [...new Set(entry.sources.map((source) => source.executionId))].sort(),
      verificationVerdict,
      verificationIds: verifications.map((item) => item.verificationDigest),
      claimConflict,
      selfVerification,
      blocking
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const axisSetDigest = digestObject(allAxes.map((axis) => axis.axisDigest));
  const verificationSetDigest = digestObject(allVerifications.map((item) => item.verificationDigest));
  const coverageDigest = digestObject({
    packageId: reviewPackage.packageId,
    repairRound: reviewPackage.repairRounds,
    workUniverseDigest: reviewPackage.workUniverseDigest,
    requiredLaneIds: requiredLanes.map((lane) => lane.id),
    axisSetDigest,
    coverage
  });
  const findingSetDigest = digestObject(findings);
  const axesComplete = missingRequiredLanes.length === 0 && laneConflicts.length === 0 && reusedExecutionIds.length === 0;
  const coverageComplete = axesComplete && coverage.every((item) => item.complete);
  const blockingFindingIds = findings.filter((finding) => finding.blocking).map((finding) => finding.id);
  const anchorsComplete = findings.every((finding) => finding.anchor.resolution === "exact");
  const verificationsComplete = findings.every((finding) => ["CONFIRMED", "REFUTED", "PARTIAL", "OUT_OF_SCOPE"].includes(finding.verificationVerdict));
  const convergence = {
    axesComplete,
    coverageComplete,
    anchorsComplete,
    verificationsComplete,
    missingRequiredLanes,
    laneConflicts,
    reusedExecutionIds,
    blockingFindingIds,
    complete: axesComplete && coverageComplete && anchorsComplete && verificationsComplete && blockingFindingIds.length === 0
  };
  const convergenceDigest = digestObject({
    packageId: reviewPackage.packageId,
    repairRound: reviewPackage.repairRounds,
    axisSetDigest,
    verificationSetDigest,
    coverageDigest,
    findingSetDigest,
    convergence
  });
  return {
    schemaVersion: 2,
    packageId: reviewPackage.packageId,
    repairRound: reviewPackage.repairRounds,
    workUniverseDigest: reviewPackage.workUniverseDigest,
    reviewLanesDigest: reviewPackage.reviewLanesDigest,
    axes: allAxes,
    verifications: allVerifications,
    axisSetDigest,
    verificationSetDigest,
    coverage,
    coverageDigest,
    findings,
    findingSetDigest,
    convergence,
    convergenceDigest
  };
}

async function currentReviewPackage(root, run) {
  const packages = await listJsonRecords(root, packageDirectory(run.runDir));
  const currentHead = (await runSourceGit(run.manifest.cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  const matches = packages.filter((item) => item.head === currentHead);
  if (matches.length > 1) throw new Error("Review has multiple packages for the current HEAD");
  return matches[0] ?? null;
}

export async function reviewKernelStatus(root, runId) {
  const run = await loadRun(root, runId);
  return deriveReviewKernel(root, run, await currentReviewPackage(root, run));
}

export async function recordReviewCoverage(root, runId) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Review work-unit coverage");
    const reviewPackage = await currentReviewPackage(root, run);
    const kernel = await deriveReviewKernel(root, run, reviewPackage);
    if (!kernel) throw new Error("Review work-unit coverage requires a current v2 review package");
    const value = {
      schemaVersion: 2,
      packageId: kernel.packageId,
      repairRound: kernel.repairRound,
      workUniverseDigest: kernel.workUniverseDigest,
      reviewLanesDigest: kernel.reviewLanesDigest,
      axisSetDigest: kernel.axisSetDigest,
      coverage: kernel.coverage,
      coverageDigest: kernel.coverageDigest,
      complete: kernel.convergence.coverageComplete,
      recordedAt: nowIso()
    };
    const target = safeJoin(coverageDirectory(runDir), `${kernel.repairRound}-${kernel.coverageDigest}.json`);
    try {
      const existing = await readJson(root, target);
      if (digestObject({ ...existing, recordedAt: null }) !== digestObject({ ...value, recordedAt: null })) {
        throw new Error("Review coverage retry conflicts with the persisted receipt");
      }
      return existing;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await atomicWriteJson(root, target, value);
    await appendJournal(root, runDir, "review.coverage-recorded", {
      packageId: kernel.packageId,
      coverageDigest: kernel.coverageDigest,
      complete: value.complete
    });
    return value;
  });
}

export async function recordReviewSynthesis(root, runId) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Review synthesis");
    const reviewPackage = await currentReviewPackage(root, run);
    const kernel = await deriveReviewKernel(root, run, reviewPackage);
    if (!kernel) throw new Error("Review synthesis requires a current v2 review package");
    const value = {
      schemaVersion: 2,
      packageId: kernel.packageId,
      repairRound: kernel.repairRound,
      workUniverseDigest: kernel.workUniverseDigest,
      axisSetDigest: kernel.axisSetDigest,
      verificationSetDigest: kernel.verificationSetDigest,
      coverageDigest: kernel.coverageDigest,
      findingSetDigest: kernel.findingSetDigest,
      findings: kernel.findings,
      convergence: kernel.convergence,
      convergenceDigest: kernel.convergenceDigest,
      recordedAt: nowIso()
    };
    const target = safeJoin(synthesisDirectory(runDir), `${kernel.repairRound}-${kernel.convergenceDigest}.json`);
    try {
      const existing = await readJson(root, target);
      if (digestObject({ ...existing, recordedAt: null }) !== digestObject({ ...value, recordedAt: null })) {
        throw new Error("Review synthesis retry conflicts with the persisted receipt");
      }
      return existing;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await atomicWriteJson(root, target, value);
    await appendJournal(root, runDir, "review.synthesis-recorded", {
      packageId: kernel.packageId,
      convergenceDigest: kernel.convergenceDigest,
      complete: kernel.convergence.complete
    });
    return value;
  });
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
  if (status === "resolved" && !finding.evidenceId) {
    throw new Error("Resolved review findings require evidenceId");
  }
  return status;
}

async function assertFindingEvidence(root, run, finding) {
  if (!["resolved", "rejected-with-evidence"].includes(finding.status)) return;
  const evidence = (await listJsonRecords(root, safeJoin(run.runDir, "evidence"))).find(
    (item) => item.id === finding.evidenceId
  );
  if (!evidence || evidence.stale || evidence.schemaVersion !== 2 || !evidence.typedAdmission) {
    throw new Error(`Review finding ${finding.id ?? "unknown"} references unverified evidence`);
  }
  const { validateTypedEvidenceRecord } = await import("./evidence.mjs");
  await validateTypedEvidenceRecord(evidence, run);
  if (evidence.kind !== "patch-review") {
    throw new Error(`Review finding ${finding.id ?? "unknown"} must reference patch-review evidence`);
  }
  const payload = evidence.receipt?.payload;
  const reviewPackage = await readJson(root, safeJoin(packageDirectory(run.runDir), `${finding.packageId}.json`)).catch(() => null);
  const bound = (
    reviewPackage &&
    reviewPackage.schemaVersion === 1 &&
    reviewPackage.immutable === true &&
    payload?.packageId === reviewPackage.packageId &&
    payload?.base === reviewPackage.base &&
    payload?.head === reviewPackage.head &&
    payload?.scopeDigest === reviewPackage.scopeDigest &&
    payload?.diffManifestDigest === reviewPackage.diffManifestDigest &&
    Array.isArray(payload?.findingIds) &&
    payload.findingIds.includes(finding.id)
  );
  if (!bound) {
    throw new Error(`Review finding ${finding.id ?? "unknown"} is not bound to its immutable review package`);
  }
}

async function assertBroadReviewEvidence(root, run, reviewPackage, kernel = null) {
  if (run.contract.controlPlane?.reviewPolicy === "none") return;
  const evidence = await listJsonRecords(root, safeJoin(run.runDir, "evidence"));
  const { isIndependentCriticEvidence, validateTypedEvidenceRecord } = await import("./evidence.mjs");
  if (reviewPackage.schemaVersion === 2) {
    const liveKernel = kernel ?? await deriveReviewKernel(root, run, reviewPackage);
    if (!liveKernel?.convergence.complete) throw new Error("Broad review requires converged review-kernel state");
    const accounting = evidence.find((item) => (
      item.kind === "work-unit-accounting" && item.status === "complete" && !item.stale &&
      item.receipt?.payload?.result === true && item.receipt?.payload?.packageId === reviewPackage.packageId &&
      item.receipt?.payload?.workUniverseDigest === liveKernel.workUniverseDigest &&
      item.receipt?.payload?.axisSetDigest === liveKernel.axisSetDigest &&
      item.receipt?.payload?.coverageDigest === liveKernel.coverageDigest
    ));
    if (!accounting) throw new Error("Broad review requires current work-unit-accounting evidence");
    await validateTypedEvidenceRecord(accounting, { ...run, root });
    const summary = evidence.find((item) => (
      item.kind === "review-kernel-summary" && item.status === "complete" && !item.stale &&
      item.receipt?.payload?.result === true && item.receipt?.payload?.packageId === reviewPackage.packageId &&
      item.receipt?.payload?.axisSetDigest === liveKernel.axisSetDigest &&
      item.receipt?.payload?.verificationSetDigest === liveKernel.verificationSetDigest &&
      item.receipt?.payload?.findingSetDigest === liveKernel.findingSetDigest &&
      item.receipt?.payload?.convergenceDigest === liveKernel.convergenceDigest
    ));
    if (!summary) throw new Error("Broad review requires current review-kernel-summary evidence");
    await validateTypedEvidenceRecord(summary, { ...run, root });
    return;
  }
  const diff = evidence.find((item) => (
    item.kind === "diff-review" &&
    item.status === "complete" &&
    !item.stale &&
    item.receipt?.payload?.verdict === "PASS" &&
    item.receipt?.payload?.packageId === reviewPackage.packageId &&
    item.receipt?.payload?.base === reviewPackage.base &&
    item.receipt?.payload?.head === reviewPackage.head &&
    item.receipt?.payload?.scopeDigest === reviewPackage.scopeDigest &&
    item.receipt?.payload?.diffManifestDigest === reviewPackage.diffManifestDigest &&
    item.receipt?.payload?.instructionDigest === reviewPackage.instructionDigest
  ));
  if (!diff) throw new Error("Broad review requires final package-bound diff-review evidence");
  await validateTypedEvidenceRecord(diff, run);
  if (run.manifest.mode === "critical") {
    const critic = evidence.find((item) => (
      isIndependentCriticEvidence(item, {
        reviewPackage,
        sentinelDigest: run.state.lastSentinel?.digest
      })
    ));
    if (!critic) throw new Error("Critical broad review requires an exact independent critic receipt");
    await validateTypedEvidenceRecord(critic, run);
  }
}

export async function addReviewFinding(root, runId, finding, { update = false } = {}) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Review findings");
    if (!finding.packageId || !finding.path || !finding.location || !finding.rule) throw new Error("Review finding identity is required");
    if (!["P0", "P1", "P2", "P3"].includes(finding.severity)) throw new Error("Review finding severity is invalid");
    const packageTarget = safeJoin(packageDirectory(runDir), `${finding.packageId}.json`);
    const reviewPackage = await readJson(root, packageTarget).catch((error) => {
      if (error.code === "ENOENT") throw new Error(`Review finding references unknown package: ${finding.packageId}`);
      throw error;
    });
    if (
      reviewPackage.schemaVersion !== 1 ||
      reviewPackage.immutable !== true ||
      reviewPackage.contractDigest !== digestObject(run.contract) ||
      reviewPackage.templateDigest !== run.contract.templateDigest
    ) {
      throw new Error("Review finding package is bound to a different contract or template");
    }
    const status = validateFindingDisposition(finding);
    const id = stableFindingId(finding);
    await assertFindingEvidence(root, run, { ...finding, id, status });
    const disposition = status === "accepted-risk"
      ? { owner: finding.owner, reason: finding.reason, expiry: finding.expiry }
      : ["resolved", "rejected-with-evidence"].includes(status)
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
    const target = safeJoin(findingDirectory(runDir), `${id}.json`);
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
  });
}

export async function reviewStatus(root, runId) {
  const run = await loadRun(root, runId);
  const packages = await listJsonRecords(root, packageDirectory(run.runDir));
  const legacyFindings = await listJsonRecords(root, findingDirectory(run.runDir));
  const expectedContractDigest = digestObject(run.contract);
  for (const value of packages) {
    if (
      ![1, 2].includes(value.schemaVersion) ||
      value.immutable !== true ||
      value.contractDigest !== expectedContractDigest ||
      value.templateDigest !== run.contract.templateDigest ||
      (run.contract.remoteRevision && value.base !== run.contract.remoteRevision)
    ) {
      throw new Error("Review package is bound to a different contract or template");
    }
    if (run.contract.reviewProfile && value.reviewProfileDigest !== digestObject(run.contract.reviewProfile)) {
      throw new Error("Review package is bound to a different review profile");
    }
    if (value.scopeDigest !== digestObject(value.scope) || value.diffManifestDigest !== digestObject(value.diffManifest)) {
      throw new Error("Review package identity digest is stale");
    }
    if (value.schemaVersion === 2) {
      if (!reviewKernelEnabled(run.contract.controlPlane?.reviewPolicy) || value.workUnitPolicy !== "diff-files-v1" || value.workUnitPolicy !== run.contract.controlPlane.workUnitPolicy) {
        throw new Error("Review kernel package policy is not enabled by the TaskContract");
      }
      const lanes = normalizeReviewLanes(value.reviewLanes);
      if (
        digestObject(lanes) !== value.reviewLanesDigest ||
        value.reviewLanesDigest !== digestObject(normalizeReviewLanes(run.contract.controlPlane.reviewLanes)) ||
        value.workUniverseDigest !== digestObject(value.workUniverse)
      ) throw new Error("Review kernel package lane or work-universe digest is stale");
    }
    if (value.packageId !== packageId(reviewPackageIdIdentity(value))) {
      throw new Error("Review package id is not bound to its complete identity");
    }
    const { mergeBase, diffManifest } = await deriveDiffManifest(
      run.manifest.cwd,
      value.base,
      value.head,
      value.scope
    );
    if (mergeBase !== value.mergeBase || digestObject(diffManifest) !== value.diffManifestDigest) {
      throw new Error("Review package diff manifest does not match the live Git BASE..HEAD diff");
    }
    if (value.schemaVersion === 2) {
      const workUniverse = await deriveWorkUniverse(run.manifest.cwd, value.base, value.head, diffManifest);
      if (digestObject(workUniverse) !== value.workUniverseDigest) {
        throw new Error("Review package work universe does not match the live Git BASE..HEAD blobs");
      }
    }
  }
  for (const finding of legacyFindings) {
    if (!packages.some((item) => item.packageId === finding.packageId)) {
      throw new Error(`Review finding references unknown package: ${finding.packageId}`);
    }
    validateFindingDisposition(finding);
    await assertFindingEvidence(root, run, finding);
  }
  const currentHead = (await runSourceGit(run.manifest.cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  const matchingPackages = packages.filter((item) => item.head === currentHead);
  if (matchingPackages.length > 1) throw new Error("Review has multiple packages for the current HEAD");
  const scoped = matchingPackages[0] ?? null;
  const kernel = scoped?.schemaVersion === 2 ? await deriveReviewKernel(root, run, scoped) : null;
  const scopedFindings = scoped?.schemaVersion === 2
    ? kernel.findings
    : scoped
      ? legacyFindings.filter((item) => item.packageId === scoped.packageId)
      : [];
  const openHigh = scopedFindings.filter((item) => (
    ["P0", "P1"].includes(item.severity) && (scoped?.schemaVersion === 2 ? item.blocking : item.status === "open")
  ));
  const repairBudgetExhausted = Boolean(scoped?.repairRounds >= 5 && openHigh.length > 0);
  const broadSentinelMatches = (
    run.state.lastSentinelVerified === true &&
    run.state.lastSentinelComplete === true &&
    typeof run.state.lastSentinel?.digest === "string" &&
    scoped?.broadReview?.sentinelDigest === run.state.lastSentinel.digest
  );
  const broadHeadMatches = scoped?.head === currentHead;
  const findingSetDigest = digestObject(scopedFindings);
  let kernelReceiptsComplete = true;
  if (kernel) {
    const coverage = await listJsonRecords(root, coverageDirectory(run.runDir));
    const synthesis = await listJsonRecords(root, synthesisDirectory(run.runDir));
    kernelReceiptsComplete = Boolean(
      coverage.some((item) => (
        item.packageId === kernel.packageId && item.repairRound === kernel.repairRound &&
        item.axisSetDigest === kernel.axisSetDigest && item.coverageDigest === kernel.coverageDigest && item.complete === true
      )) &&
      synthesis.some((item) => (
        item.packageId === kernel.packageId && item.repairRound === kernel.repairRound &&
        item.axisSetDigest === kernel.axisSetDigest && item.verificationSetDigest === kernel.verificationSetDigest &&
        item.findingSetDigest === kernel.findingSetDigest && item.convergenceDigest === kernel.convergenceDigest &&
        item.convergence?.complete === true
      ))
    );
  }
  let broadEvidenceComplete = false;
  if (scoped?.broadReview?.complete) {
    try {
      await assertBroadReviewEvidence(root, run, scoped, kernel);
      broadEvidenceComplete = true;
    } catch {
      broadEvidenceComplete = false;
    }
  }
  const scopedClosed = Boolean(scoped && !repairBudgetExhausted && (
    kernel ? kernel.convergence.complete && kernelReceiptsComplete : scopedFindings.every((item) => item.status !== "open")
  ));
  const broadBindingsMatch = Boolean(
    scoped?.broadReview?.findingSetDigest === findingSetDigest &&
    (!kernel || (
      scoped.broadReview.axisSetDigest === kernel.axisSetDigest &&
      scoped.broadReview.verificationSetDigest === kernel.verificationSetDigest &&
      scoped.broadReview.coverageDigest === kernel.coverageDigest &&
      scoped.broadReview.convergenceDigest === kernel.convergenceDigest
    ))
  );
  const broadReviewComplete = Boolean(
    scoped?.broadReview?.complete && broadEvidenceComplete && broadBindingsMatch &&
    scoped.broadReview.head === scoped.head && broadHeadMatches && broadSentinelMatches
  );
  const continuityDigest = scoped ? digestObject({
    policy: run.contract.controlPlane?.reviewPolicy,
    packageId: scoped.packageId,
    packageDigest: reviewPackageDigest(scoped),
    head: scoped.head,
    sentinelDigest: run.state.lastSentinel?.digest ?? null,
    findingSetDigest,
    ...(kernel ? {
      axisSetDigest: kernel.axisSetDigest,
      verificationSetDigest: kernel.verificationSetDigest,
      coverageDigest: kernel.coverageDigest,
      convergenceDigest: kernel.convergenceDigest
    } : {})
  }) : null;
  return {
    package: scoped,
    findings: scopedFindings,
    openHigh,
    repairBudgetExhausted,
    scopedClosed,
    kernel,
    kernelReceiptsComplete,
    findingSetDigest,
    continuityDigest,
    broadReviewComplete,
    complete: Boolean(scopedClosed && broadReviewComplete)
  };
}

export async function recordRepairRound(root, runId, packageIdValue, result) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Review repair");
    const target = safeJoin(packageDirectory(runDir), `${packageIdValue}.json`);
    const value = await readJson(root, target);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Review repair result must be an object");
    }
    const { repairAttemptId, idempotencyKey, packageDigest } = result;
    if (!REPAIR_ID.test(String(repairAttemptId ?? "")) || !REPAIR_ID.test(String(idempotencyKey ?? ""))) {
      throw new Error("Review repair requires stable repairAttemptId and idempotencyKey");
    }
    if (!DIGEST.test(String(packageDigest ?? "")) || packageDigest !== reviewPackageDigest(value)) {
      throw new Error("Review repair package digest does not match the immutable package");
    }
    const requestDigest = digestObject(result);
    const priorAttempts = Array.isArray(value.repairAttempts) ? value.repairAttempts : [];
    const existing = priorAttempts.find((attempt) => attempt.repairAttemptId === repairAttemptId);
    if (existing) {
      if (
        existing.idempotencyKey !== idempotencyKey ||
        existing.packageDigest !== packageDigest ||
        existing.requestDigest !== requestDigest
      ) {
        throw new Error("Review repair retry conflicts with the existing repair attempt");
      }
      return value;
    }
    const nextRound = Number(value.repairRounds ?? 0) + 1;
    if (nextRound > 5) throw new Error("Scoped review repair budget exhausted");
    const next = {
      ...value,
      repairRounds: nextRound,
      repairAttempts: [
        ...priorAttempts,
        { repairAttemptId, idempotencyKey, packageDigest, requestDigest, recordedAt: nowIso() }
      ],
      lastRepair: { at: nowIso(), ...result }
    };
    await atomicWriteJson(root, target, next);
    return next;
  });
}

export async function markBroadReviewComplete(root, runId, packageIdValue, head, sentinelDigest) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Broad review");
    if (!SHA.test(head) || !DIGEST.test(sentinelDigest)) throw new Error("Broad review binding is invalid");
    const currentSentinel = await captureSentinel(run.manifest.cwd, run.contract, await loadDefaults());
    if (
      !currentSentinel.complete ||
      currentSentinel.digest !== run.state.lastSentinel?.digest ||
      currentSentinel.digest !== sentinelDigest
    ) throw new Error("Broad review sentinel is not a verified complete current sentinel");
    const target = safeJoin(packageDirectory(runDir), `${packageIdValue}.json`);
    const value = await readJson(root, target);
    if (head !== value.head) throw new Error("Broad review must bind the final HEAD");
    if (
      run.state.lastSentinelVerified !== true ||
      run.state.lastSentinelComplete !== true ||
      sentinelDigest !== run.state.lastSentinel?.digest
    ) throw new Error("Broad review sentinel is not a verified complete current sentinel");
    const currentHead = (await runSourceGit(run.manifest.cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    if (currentHead !== head) throw new Error("Broad review must bind the current HEAD");
    const status = await reviewStatus(root, runId);
    if (status.package?.packageId !== packageIdValue || !status.scopedClosed) {
      throw new Error("Broad review requires current scoped review state to be closed");
    }
    await assertBroadReviewEvidence(root, run, value, status.kernel);
    const bindings = {
      findingSetDigest: status.findingSetDigest,
      ...(status.kernel ? {
        axisSetDigest: status.kernel.axisSetDigest,
        verificationSetDigest: status.kernel.verificationSetDigest,
        coverageDigest: status.kernel.coverageDigest,
        convergenceDigest: status.kernel.convergenceDigest
      } : {})
    };
    if (
      value.broadReview?.complete === true && value.broadReview.head === head &&
      value.broadReview.sentinelDigest === sentinelDigest &&
      Object.entries(bindings).every(([key, binding]) => value.broadReview[key] === binding)
    ) return value;
    const next = {
      ...value,
      broadReview: { required: true, complete: true, head, sentinelDigest, ...bindings, completedAt: nowIso() }
    };
    await atomicWriteJson(root, target, next);
    return next;
  });
}

export async function assertReviewContinuity(root, runId, expected = null) {
  const status = await reviewStatus(root, runId);
  if (!status.complete || !status.package || !status.continuityDigest) {
    throw new Error("Review continuity requires a complete current review");
  }
  if (expected && (
    expected.packageId !== status.package.packageId ||
    expected.head !== status.package.head ||
    expected.continuityDigest !== status.continuityDigest
  )) throw new Error("Review continuity changed after authorization");
  return {
    packageId: status.package.packageId,
    head: status.package.head,
    continuityDigest: status.continuityDigest
  };
}
