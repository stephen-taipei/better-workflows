import { constants as fsConstants } from "node:fs";
import assert from "node:assert/strict";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestObject } from "./core.mjs";
import { runSourceGit } from "./git.mjs";
import { fixedToolPath } from "./formal-evaluator.mjs";
import { spawnCapture } from "./process-capture.mjs";
import { SUPPORTED_CODEX_VERSIONS } from "./native-review-version.mjs";
import {
  SHARD_PROTOCOL, validateShardPolicy, createShardPlan, shardDigest
} from "./native-review-shards.mjs";
import { executeShardedReview, replayShardedReceipt } from "./native-review-shard-runner.mjs";
import {
  CONTENT_PROTOCOL, contentDigest, MAX_REVIEW_DIFF_BYTES, MAX_REVIEW_IMAGE_BYTES, MAX_REVIEW_PATHS,
  observeContentCoverage,
  readContentSnapshot, readContentStream
} from "./native-review-content.mjs";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TRACE_BYTES = 128 * 1024 * 1024;
const NATIVE_REVIEW_TIMEOUT_MS = 45 * 60 * 1000;
const NATIVE_REVIEW_TIMEOUT_GRACE_MS = 5 * 1000;
const REVIEW_PROTOCOL = "native-review-observed-content-v5";
export const NATIVE_REVIEW_FULL_SNAPSHOT_MODE_V1 = "full-snapshot-v1";
export const NATIVE_REVIEW_EMPTY_TREE_OID_V1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Explicit snapshot identity, never a BASE==HEAD empty-diff substitute. */
export function inspectNativeReviewSnapshotSubjectV1(value) {
  const fields = ["reviewMode", "base", "head", "mergeBase", "snapshotTreeOid", "fullUniverseDigest"];
  if (!value || Object.keys(value).sort().join(",") !== fields.sort().join(",") ||
      value.reviewMode !== NATIVE_REVIEW_FULL_SNAPSHOT_MODE_V1 || value.base !== NATIVE_REVIEW_EMPTY_TREE_OID_V1 ||
      !SHA.test(value.head ?? "") || value.head === value.base || value.mergeBase !== null ||
      !SHA.test(value.snapshotTreeOid ?? "") || !DIGEST.test(value.fullUniverseDigest ?? "")) {
    throw new Error("Full snapshot requires explicit empty-tree, actual HEAD/tree and complete universe binding");
  }
  return Object.freeze({ ...value });
}

export function nativeReviewDiffRevisionsV1({ base, head, reviewMode }) {
  if (reviewMode === undefined) return [`${base}..${head}`];
  if (reviewMode !== NATIVE_REVIEW_FULL_SNAPSHOT_MODE_V1 || base !== NATIVE_REVIEW_EMPTY_TREE_OID_V1 ||
      !SHA.test(head ?? "") || head === NATIVE_REVIEW_EMPTY_TREE_OID_V1) {
    throw new Error("Unknown native review mode or invalid snapshot base");
  }
  return [base, head];
}

/** Actual read-only public snapshot producer. It creates no signature or
 * review verdict; the existing observed shard executor consumes these bytes.
 */
export async function captureNativeReviewSnapshotIdentityV1(repository, head) {
  if (!SHA.test(head ?? "")) throw new Error("Snapshot HEAD must be exact");
  const git = (args, options = {}) => runSourceGit(repository, args, { ...options,
    validateWorktree: false, workTree: repository });
  const current = String((await git(["rev-parse", "--verify", "HEAD^{commit}"])).stdout).trim();
  const parents = String((await git(["rev-list", "--parents", "-n", "1", head])).stdout).trim();
  if (current !== head || parents !== head || String((await git(["status", "--porcelain=v1"])).stdout) !== "") {
    throw new Error("Bootstrap snapshot requires its actual clean parentless public candidate");
  }
  const tree = String((await git(["rev-parse", "--verify", `${head}^{tree}`])).stdout).trim();
  if (!SHA.test(tree)) throw new Error("Snapshot tree is missing");
  const raw = Buffer.from((await git(["ls-tree", "-r", "-z", "--full-tree", head],
    { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 })).stdout);
  if (!raw.length || raw.at(-1) !== 0) throw new Error("Full snapshot tree enumeration is empty/truncated");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  if (!Buffer.from(text).equals(raw)) throw new Error("Full snapshot paths are not lossless UTF-8");
  const records = text.split("\0").filter(Boolean).map(token => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(token);
    const relative = match?.[3];
    if (!match || !relative || relative.startsWith("/") || relative.includes("\\") || /[\0\r\n]/.test(relative) ||
        relative.split("/").some(part => ["", ".", ".."].includes(part))) throw new Error("Snapshot contains an indirect/unsupported/unsafe tracked path");
    return { path: relative, mode: match[1], type: "blob", oid: match[2] };
  }).sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (new Set(records.map(row => row.path)).size !== records.length) throw new Error("Snapshot tracked paths repeat");
  const manifest = normalizeManifest({ files: records.map(row => ({ status: "A", path: row.path })) });
  const subject = inspectNativeReviewSnapshotSubjectV1({ reviewMode: NATIVE_REVIEW_FULL_SNAPSHOT_MODE_V1,
    base: NATIVE_REVIEW_EMPTY_TREE_OID_V1, head, mergeBase: null, snapshotTreeOid: tree, fullUniverseDigest: digestObject(records) });
  return Object.freeze({ ...subject, manifest, records });
}

function snapshotSubject(packageValue) {
  if (packageValue.reviewMode === undefined) return null;
  return inspectNativeReviewSnapshotSubjectV1(Object.fromEntries(["reviewMode", "base", "head", "mergeBase", "snapshotTreeOid", "fullUniverseDigest"]
    .map(key => [key, packageValue[key]])));
}

export const NATIVE_REVIEW_PREPARATION_LIMITS = Object.freeze({
  maxPaths: MAX_REVIEW_PATHS,
  maxDiffBytes: MAX_REVIEW_DIFF_BYTES,
  maxImageBytes: MAX_REVIEW_IMAGE_BYTES,
  timeoutMs: 5 * 60 * 1000
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableMacAlias(requested, canonical) {
  if (process.platform !== "darwin" || requested === canonical) return false;
  return ["/var", "/tmp", "/etc"].some((alias) => (
    (requested === alias || requested.startsWith(`${alias}/`)) && canonical === `/private${requested}`
  ));
}

async function physicalPathSnapshot(target, label) {
  const raw = String(target ?? "");
  const resolved = path.resolve(raw);
  if (!path.isAbsolute(raw) || resolved !== raw || raw.includes("\0") || raw.split(path.sep).includes("..")) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  const parsed = path.parse(resolved);
  const components = [];
  let current = parsed.root;
  const rootInfo = await lstat(current);
  if (rootInfo.isSymbolicLink()) throw new Error(`${label} contains a symbolic-link path component`);
  components.push({ path: current, dev: rootInfo.dev, ino: rootInfo.ino, directory: rootInfo.isDirectory(), alias: false });
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
  const info = await lstat(current);
    let alias = false;
    let canonicalPath = current;
    if (info.isSymbolicLink()) {
      canonicalPath = await realpath(current).catch(() => null);
      alias = canonicalPath !== null && stableMacAlias(current, canonicalPath);
      if (!alias) throw new Error(`${label} contains a symbolic-link path component`);
    }
    const directory = alias ? (await lstat(canonicalPath)).isDirectory() : info.isDirectory();
    if (index < parts.length - 1 && !directory) {
      throw new Error(`${label} has a non-directory path component`);
    }
    components.push({ path: current, dev: info.dev, ino: info.ino, directory, alias, canonicalPath });
  }
  return Object.freeze({ path: resolved, components });
}

export async function assertPhysicalPath(target, label = "Path", { directory = false } = {}) {
  const snapshot = await physicalPathSnapshot(target, label);
  const leaf = snapshot.components.at(-1);
  if (directory && !leaf?.directory) throw new Error(`${label} must be a physical directory`);
  return snapshot;
}

export async function assertPhysicalSnapshot(snapshot, label) {
  for (const expected of snapshot.components) {
    const current = await lstat(expected.path);
    if (expected.alias) {
      const canonical = current.isSymbolicLink() ? await realpath(expected.path).catch(() => null) : expected.path;
      if (!current.isSymbolicLink() || canonical !== expected.canonicalPath) {
        throw new Error(`${label} changed during the operation`);
      }
    } else if (current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new Error(`${label} changed during the operation`);
    }
  }
  return snapshot;
}

async function openPhysicalFile(target, label, maximum = MAX_FILE_BYTES) {
  const snapshot = await physicalPathSnapshot(target, label);
  const canonical = await realpath(snapshot.path);
  if (canonical !== snapshot.path && !stableMacAlias(snapshot.path, canonical)) {
    throw new Error(`${label} must not resolve through an alias`);
  }
  const handle = await open(snapshot.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    const leaf = snapshot.components.at(-1);
    if (!info.isFile() || info.isSymbolicLink() || info.dev !== leaf.dev || info.ino !== leaf.ino || info.nlink !== 1 || info.size > maximum) {
      throw new Error(`${label} must be one bounded physical file`);
    }
    const bytes = await handle.readFile();
    if (bytes.length > maximum) throw new Error(`${label} grew beyond its byte budget`);
    await assertPhysicalSnapshot(snapshot, label);
    return { path: canonical, bytes, info, snapshot };
  } finally {
    await handle.close();
  }
}

export async function boundedFile(target, label, maximum) {
  return openPhysicalFile(target, label, maximum);
}

async function pathAbsent(target) {
  try { await lstat(target); return false; } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

// A version probe must not occupy the execution namespace or replace prepared inputs.
// Preserve drift artifacts for diagnosis; never delete/reuse an existing attempt.
async function preflightExecutionArtifacts(codex, options, { absent, prepared = [], directory = null }) {
  const assertArtifacts = async () => {
    try {
      for (const target of absent) if (!(await pathAbsent(target))) throw new Error("Artifact exists");
      if (directory) await assertPhysicalSnapshot(directory, "Prepared native review directory");
      for (const file of prepared) await assertFileUnchanged(file, "Prepared native review input");
    } catch {
      const code = "native-review-cli-preflight-cleanup-incomplete";
      throw Object.assign(new Error(code), { code });
    }
  };
  await assertArtifacts();
  let probeError;
  try { await preflightCodexVersion(codex, options); } catch (error) { probeError = error; }
  await assertArtifacts();
  if (probeError) throw probeError;
}

async function executable(target) {
  try { await access(target, fsConstants.X_OK); return true; } catch { return false; }
}

export function parseNativeReviewCodexCliVersionV1(stdout) {
  const match = /^codex-cli (\d+\.\d+\.\d+)$/.exec(String(stdout ?? "").trim());
  return match?.[1] ?? null;
}

async function preflightCodexVersion(codex, { cwd, env }) {
  let result;
  try {
    result = await spawnCapture(codex, ["--version"], {
      cwd, env, timeoutMs: 5_000, maxOutputBytes: 8_192
    });
  } catch (error) {
    const code = error.execution?.groupTerminated === false
      ? "native-review-cli-preflight-cleanup-incomplete"
      : "native-review-cli-version-unavailable";
    throw Object.assign(new Error(code), { code });
  }
  if (result.groupTerminated !== true) {
    throw Object.assign(new Error("native-review-cli-preflight-cleanup-incomplete"), {
      code: "native-review-cli-preflight-cleanup-incomplete"
    });
  }
  if (result.timedOut || result.outputExceeded || result.code !== 0) {
    throw Object.assign(new Error("native-review-cli-version-unavailable"), {
      code: "native-review-cli-version-unavailable"
    });
  }
  const version = parseNativeReviewCodexCliVersionV1(result.stdout);
  if (!version) {
    throw Object.assign(new Error("native-review-cli-version-format-invalid"), {
      code: "native-review-cli-version-format-invalid"
    });
  }
  if (!SUPPORTED_CODEX_VERSIONS.includes(version)) {
    throw Object.assign(new Error("native-review-cli-version-unsupported"), {
      code: "native-review-cli-version-unsupported"
    });
  }
  return version;
}

async function locateCodex() {
  const candidates = [
    process.env.CODEX_BINARY,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(path.dirname(process.execPath), "codex")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && await executable(candidate)) return realpath(candidate);
  }
  const pathDirectories = String(process.env.PATH ?? "").split(path.delimiter);
  for (const directory of pathDirectories) {
    const candidate = path.join(directory, "codex");
    if (await executable(candidate)) return realpath(candidate);
  }
  throw new Error("Native review runner cannot locate one executable Codex binary");
}

function normalizeManifest(payload) {
  if (!payload || !Array.isArray(payload.files)) throw new Error("Native review diff manifest requires files");
  const files = payload.files.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.status !== "string" || typeof item.path !== "string") {
      throw new Error("Native review diff manifest entry is invalid");
    }
    const expectedKeys = typeof item.oldPath === "string"
      ? ["oldPath", "path", "status"]
      : ["path", "status"];
    if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(expectedKeys)) {
      throw new Error("Native review diff manifest entry is not canonical");
    }
    if (!/^[ACDMRT][0-9]*$/.test(item.status)) {
      throw new Error("Native review diff manifest status is invalid");
    }
    const rename = item.status.startsWith("R") || item.status.startsWith("C");
    if (rename !== (typeof item.oldPath === "string")) {
      throw new Error("Native review diff manifest rename identity is invalid");
    }
    const paths = rename ? [item.oldPath, item.path] : [item.path];
    if (paths.some((value) => !value || value.startsWith("/") || value.includes("\0") || value.split("/").includes(".."))) {
      throw new Error("Native review diff manifest path is unsafe");
    }
    return {
      status: item.status,
      path: item.path,
      ...(rename ? { oldPath: item.oldPath } : {})
    };
  }).sort((left, right) => digestObject(left).localeCompare(digestObject(right)));
  for (let index = 1; index < files.length; index += 1) {
    if (digestObject(files[index - 1]) === digestObject(files[index])) {
      throw new Error("Native review diff manifest contains duplicate canonical records");
    }
  }
  return { files };
}

function manifestPaths(manifest) {
  return [...new Set(manifest.files.flatMap((item) => (
    item.status.startsWith("R") || item.status.startsWith("C")
      ? [item.oldPath, item.path]
      : [item.path]
  )))].sort();
}

function validatePackageIdentity(packageValue, { packageId, base, head, mergeBase, manifestValue, instructionBytes }) {
  const requiredFields = [
    "schemaVersion", "immutable", "packageId", "base", "head", "mergeBase", "scope", "scopeDigest",
    "diffManifest", "diffManifestDigest", "contractDigest", "templateDigest", "sentinelDigest", "instructionDigest"
  ];
  if (!packageValue || typeof packageValue !== "object" || Array.isArray(packageValue) ||
      requiredFields.some((field) => !Object.prototype.hasOwnProperty.call(packageValue, field)) ||
      ![1, 2].includes(packageValue.schemaVersion) || packageValue.immutable !== true) {
    throw new Error("Native review package is missing canonical schema fields");
  }
  if (packageValue.packageId !== packageId || packageValue.base !== base || packageValue.head !== head || packageValue.mergeBase !== mergeBase) {
    throw new Error("Native review package does not bind the exact immutable BASE..HEAD identity");
  }
  if (!Array.isArray(packageValue.scope) || packageValue.scope.length === 0 ||
      packageValue.scope.some((item) => typeof item !== "string" || !item || item.startsWith("/") || item.includes("\0") || item.split("/").includes("..")) ||
      packageValue.scopeDigest !== digestObject(packageValue.scope)) {
    throw new Error("Native review package scope binding is invalid");
  }
  for (const field of ["scopeDigest", "diffManifestDigest", "contractDigest", "templateDigest", "sentinelDigest", "instructionDigest"]) {
    if (!DIGEST.test(String(packageValue[field]))) throw new Error(`Native review package ${field} is invalid`);
  }
  if (packageValue.schemaVersion === 2) {
    const v2Fields = ["workUnitPolicy", "workUniverse", "workUniverseDigest", "reviewLanes", "reviewLanesDigest"];
    if (v2Fields.some((field) => !Object.prototype.hasOwnProperty.call(packageValue, field)) ||
        typeof packageValue.workUnitPolicy !== "string" || !Array.isArray(packageValue.workUniverse) ||
        !Array.isArray(packageValue.reviewLanes) || !DIGEST.test(String(packageValue.workUniverseDigest)) ||
        !DIGEST.test(String(packageValue.reviewLanesDigest)) ||
        packageValue.workUniverseDigest !== digestObject(packageValue.workUniverse) ||
        packageValue.reviewLanesDigest !== digestObject(packageValue.reviewLanes)) {
      throw new Error("Native review package v2 identity is invalid");
    }
  }
  if (packageValue.reviewProfileDigest !== undefined && !DIGEST.test(String(packageValue.reviewProfileDigest))) {
    throw new Error("Native review package review profile digest is invalid");
  }
  const snapshot = snapshotSubject(packageValue);
  if (snapshot && (JSON.stringify(packageValue.scope) !== JSON.stringify(["."]) ||
      packageValue.diffManifest.files.some(row => row.status !== "A" || row.oldPath !== undefined))) {
    throw new Error("Full snapshot scope must include the complete public tree as additions");
  }
  const packageManifest = normalizeManifest(packageValue.diffManifest);
  const suppliedManifest = normalizeManifest(manifestValue);
  if (packageValue.diffManifestDigest !== digestObject(packageManifest) ||
      digestObject(suppliedManifest) !== packageValue.diffManifestDigest) {
    throw new Error("Native review manifest does not match the immutable package manifest");
  }
  if (packageValue.instructionDigest !== sha256(instructionBytes)) {
    throw new Error("Native review instruction does not match the immutable package");
  }
  return { packageManifest, suppliedManifest, manifestPaths: manifestPaths(packageManifest) };
}

export function parseNameStatus(output) {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output ?? "");
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0) {
    throw new Error("Native review Git name-status output is truncated");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Native review Git name-status output is not valid UTF-8");
  }
  const tokens = text.split("\0");
  if (tokens.at(-1) !== "") throw new Error("Native review Git name-status output is malformed");
  const files = [];
  let index = 0;
  while (index < tokens.length - 1) {
    const status = tokens[index++];
    if (!/^[ACDMRT][0-9]*$/.test(status)) {
      throw new Error("Native review Git name-status record is invalid");
    }
    const rename = status.startsWith("R") || status.startsWith("C");
    if (index >= tokens.length - 1 || !tokens[index]) {
      throw new Error("Native review Git name-status record is truncated");
    }
    const firstPath = tokens[index++];
    if (rename) {
      if (index >= tokens.length - 1 || !tokens[index]) {
        throw new Error("Native review Git name-status rename record is truncated");
      }
      files.push({ status, oldPath: firstPath, path: tokens[index++] });
    } else {
      files.push({ status, path: firstPath });
    }
  }
  if (files.length === 0) throw new Error("Native review Git name-status output is empty");
  return normalizeManifest({ files }).files;
}

export function validateGitDiffManifest(output, { packageManifest, suppliedManifest }) {
  const actualRecords = parseNameStatus(output);
  const expectedPackage = normalizeManifest(packageManifest).files;
  const expectedSupplied = normalizeManifest(suppliedManifest).files;
  const actual = JSON.stringify(actualRecords);
  if (actual !== JSON.stringify(expectedPackage) || actual !== JSON.stringify(expectedSupplied)) {
    throw new Error("Native review Git diff manifest does not match the exact canonical package and supplied records");
  }
  return actualRecords;
}

function validateDisclosure(value, binding) {
  if (
    !value || value.schemaVersion !== 1 || value.kind !== "native-review-disclosure" ||
    value.authorized !== true || !SAFE_ID.test(String(value.authorizationId ?? "")) ||
    !Number.isFinite(Date.parse(value.approvedAt ?? ""))
  ) throw new Error("Native review disclosure authorization is invalid");
  for (const key of Object.keys(binding)) {
    if (value[key] !== binding[key]) throw new Error(`Native review disclosure authorization changed: ${key}`);
  }
  if (value.readOnly !== true || value.ephemeral !== true || value.remoteSideEffects !== false) {
    throw new Error("Native review disclosure authorization must remain read-only, ephemeral, and side-effect free");
  }
  return value;
}

export function validateReview(value, { base, head, pathCount, manifestPaths }) {
  const exactKeys = (target, keys) => (
    target && typeof target === "object" && !Array.isArray(target) &&
    JSON.stringify(Object.keys(target).sort()) === JSON.stringify([...keys].sort())
  );
  if (!Array.isArray(manifestPaths) || manifestPaths.length !== pathCount || new Set(manifestPaths).size !== manifestPaths.length) {
    throw new Error("Native review frozen manifest path set is invalid");
  }
  const allowedPaths = new Set(manifestPaths);
  if (!value || value.schemaVersion !== 1 || !["PASS", "BLOCK"].includes(value.verdict) || !Array.isArray(value.findings)) {
    throw new Error("Native review final result does not match the frozen schema");
  }
  if (!exactKeys(value, ["schemaVersion", "verdict", "scopeCoverage", "findings"]) ||
      !exactKeys(value.scopeCoverage, ["base", "head", "manifestPathCount", "reviewedPathCount", "complete"])) {
    throw new Error("Native review final result contains an unfrozen field");
  }
  if (
    !value.scopeCoverage || value.scopeCoverage.base !== base || value.scopeCoverage.head !== head ||
    value.scopeCoverage.manifestPathCount !== pathCount || value.scopeCoverage.reviewedPathCount !== pathCount ||
    value.scopeCoverage.complete !== true
  ) throw new Error("Native review final result does not prove complete BASE..HEAD scope coverage");
  if (value.verdict === "PASS" && value.findings.length !== 0) throw new Error("Native review PASS cannot contain findings");
  if (value.verdict === "BLOCK" && value.findings.length === 0) throw new Error("Native review BLOCK requires at least one actionable finding");
  for (const finding of value.findings) {
    if (
      !finding || !["P0", "P1", "P2", "P3"].includes(finding.severity) ||
      !exactKeys(finding, ["severity", "path", "line", "title", "evidence", "requiredChange"]) ||
      typeof finding.path !== "string" || !finding.path || path.isAbsolute(finding.path) || finding.path.split("/").includes("..") ||
      typeof finding.title !== "string" || !finding.title.trim() ||
      !(finding.line === null || (Number.isInteger(finding.line) && finding.line > 0)) ||
      typeof finding.evidence !== "string" || typeof finding.requiredChange !== "string"
    ) {
      throw new Error("Native review finding is malformed");
    }
    if (!allowedPaths.has(finding.path)) {
      throw new Error("Native review finding path is outside the frozen manifest");
    }
  }
  return value;
}

export function reviewProtocol({ base, head, packageId, manifestPaths, content, protocol = REVIEW_PROTOCOL,
  parentContext = false, contextPaths = null, finalShape = null }) {
  if (contextPaths !== null) {
    assert(parentContext && Array.isArray(contextPaths) && contextPaths.length > 0 &&
      contextPaths.length <= MAX_REVIEW_PATHS &&
      new Set(contextPaths).size === contextPaths.length &&
      contextPaths.every((value) => typeof value === "string" && value && !path.isAbsolute(value) &&
        !value.split("/").some((part) => ["", ".", ".."].includes(part))),
    "Invalid frozen parent context path set");
  }
  const contextPathHint = parentContext && contextPaths
    ? [
      "The following JSON array is the exact path-name allowlist for bw_review.context. It contains names only, not extra source content. Select a path from this array before every context request; never guess or request a path outside it.",
      JSON.stringify(contextPaths)
    ].join("\n")
    : null;
  return Buffer.from([
    `Better Workflows native review protocol: ${protocol}`,
    base === NATIVE_REVIEW_EMPTY_TREE_OID_V1
      ? `Review the entire parentless public snapshot ${head}; the empty-tree BASE ${base} is a content baseline, not a prior commit. Every tracked path and its complete HEAD content is in the frozen stream.`
      : `Review only the exact Git range ${base}..${head}.`,
    `The immutable package is ${packageId}.`,
    "Do not substitute the current branch, working-tree diff, or another merge base.",
    `Reconcile every one of the ${manifestPaths.length} frozen manifest paths exactly once from the host content stream.`,
    "The host independently validates the content stream against the immutable manifest path set; do not infer coverage from a path count or a partial page. The path names are carried in each source-bound frame rather than duplicated in this prompt.",
    `You may use bw_review.context for bounded source context from pinned base/head Git objects. It may read only paths in the frozen ${parentContext ? "parent" : "manifest content stream"} index. Do not edit files or perform remote side effects.`,
    "Coverage is independently checked from direct tool response items under a pinned history budget, not raw execution logs or your final path count.",
    "Read all frozen diff streams by calling bw_review.content directly with {page:0,acknowledge:null}.",
    "While coverage is incomplete, issue only the next content request; do not summarize, explain, deliberate, or call bw_review.context between pages.",
    "Reserve analysis for after the final EOF acknowledgement so broad reviews do not spend the turn budget on per-page narration.",
    "Each response starts with BW_CONTENT_PAGE_V1 and a control object containing page, nextPage, eof and batchDigest; below that is the source-bound batch and its digest footer.",
    "The host controls the bounded output budget. Never wrap this tool in code mode, a shell, a summary, or another tool.",
    "If a response is incomplete, report BLOCK with the missing page instead of inferring hidden content.",
    "Continue with {page:nextPage,acknowledge:null} using the integer in the TOP page envelope until eof=true.",
    "Never copy, decode or repair the nested machine nextCursor. Full cursors remain host-owned proof data, not tool arguments.",
    "A BW_CONTENT_RETRY_V2 response delivers no content and does not advance: submit its exact expected request. There are at most two consecutive corrections at the current position. Only a valid next page or final acknowledgement resets that position budget; total corrections remain audited. Corrections do not restart review or extend its deadline.",
    "After inspecting the final batch, call bw_review.content with {page:null,acknowledge:batchDigest}.",
    "Only a contiguous observed frame chain plus that subsequent EOF acknowledgement counts as delivered content.",
    "This proves content observation only, not semantic approval. Inspect the changes, context, and security consequences independently.",
    "Initial image attachments contain the frozen changed binary images, not just file names/dimensions. Review their visual content too.",
    contextPathHint,
    `Frozen content index digest: ${content.indexSha256}`,
    "A page can contain several complete files; requesting its nextPage acknowledges that complete batch. Do not acknowledge only its last path.",
    ...content.images.map(image => `Image attachment ${image.path} (${image.revision}): ${image.file}`),
    "Your final message must be JSON only with this exact shape:",
    JSON.stringify(finalShape ?? {
      schemaVersion: 1,
      verdict: "PASS|BLOCK",
      scopeCoverage: {
        base,
        head,
        manifestPathCount: manifestPaths.length,
        reviewedPathCount: manifestPaths.length,
        complete: true
      },
      findings: [{
        severity: "P0|P1|P2|P3",
        path: "repository-relative path",
        line: null,
        title: "short title",
        evidence: "specific evidence",
        requiredChange: "required remediation"
      }]
    }),
    "A PASS result must have findings=[]. A BLOCK result must contain at least one actionable finding.",
    "The package-specific instruction follows:",
    ""
  ].join("\n"), "utf8");
}

export async function spawnReview(
  command,
  args,
  {
    cwd,
    input,
    env = process.env,
    timeoutMs = NATIVE_REVIEW_TIMEOUT_MS,
    timeoutGraceMs = NATIVE_REVIEW_TIMEOUT_GRACE_MS,
    maxOutputBytes = MAX_FILE_BYTES,
    signal
  }
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(timeoutGraceMs) || timeoutGraceMs < 1) {
    throw new Error("Native review timeout policy is invalid");
  }
  const controller = new AbortController();
  let cancelledBy = null;
  const cancel = signal => {
    cancelledBy ??= signal;
    controller.abort();
  };
  const forwardTerm = () => cancel("SIGTERM");
  const forwardInt = () => cancel("SIGINT");
  const forwardAbort = () => cancel("parent abort");
  process.once("SIGTERM", forwardTerm);
  process.once("SIGINT", forwardInt);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    if (controller.signal.aborted) throw new Error("Native review cancelled before launch");
    // The shared capture keeps a stable supervisor alive through teardown and
    // awaits both close and group absence. Never publish terminal evidence from
    // a timer callback or assume that signalling the group proves its exit.
    const execution = await spawnCapture(command, args, {
      cwd, input, env, timeoutMs, cleanupGraceMs: timeoutGraceMs,
      maxOutputBytes, abortSignal: controller.signal
    });
    const failure = !execution.groupTerminated
      ? "Native review process cleanup could not be proven"
      : cancelledBy
        ? `Native review cancelled by ${cancelledBy}`
        : execution.timedOut
          ? `Native review timed out after ${timeoutMs}ms`
          : execution.outputExceeded
            ? "Native review transport output exceeded the bounded limit"
            : null;
    if (failure) {
      const error = new Error(failure);
      error.execution = execution;
      throw error;
    }
    return execution;
  } finally {
    process.off("SIGTERM", forwardTerm);
    process.off("SIGINT", forwardInt);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function atomicJson(target, value) {
  const parent = await assertPhysicalPath(path.dirname(target), "Native review write parent", { directory: true });
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await assertPhysicalSnapshot(parent, "Native review write parent");
    await rename(temporary, target);
    await assertPhysicalSnapshot(parent, "Native review write parent");
    const directory = await open(parent.path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
    try { await directory.sync(); } finally { await directory.close(); }
    await assertPhysicalSnapshot(parent, "Native review write parent");
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createJson(target, value) {
  return createBytes(target, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

export async function createBytes(target, bytes) {
  const parent = await assertPhysicalPath(path.dirname(target), "Native review write parent", { directory: true });
  const handle = await open(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  await assertPhysicalSnapshot(parent, "Native review write parent");
  const directory = await open(parent.path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try { await directory.sync(); } finally { await directory.close(); }
  await assertPhysicalSnapshot(parent, "Native review write parent");
}

export function createPreparationBudget(clock = Date.now) {
  if (typeof clock !== "function") throw new Error("Native review preparation clock is invalid");
  const startedAt = Number(clock());
  if (!Number.isFinite(startedAt)) throw new Error("Native review preparation clock is invalid");
  const deadlineAt = startedAt + NATIVE_REVIEW_PREPARATION_LIMITS.timeoutMs;
  let diffBytes = 0;
  let imageBytes = 0;
  const now = () => {
    const value = Number(clock());
    if (!Number.isFinite(value)) throw new Error("Native review preparation clock is invalid");
    return value;
  };
  const remainingMs = () => deadlineAt - now();
  const ensureTime = (label) => {
    const remaining = remainingMs();
    if (remaining < 1) throw new Error(`Native review content preparation deadline exceeded before ${label}`);
    return Math.min(30_000, Math.floor(remaining));
  };
  const addBytes = (kind, value, limit, current) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Native review ${kind} byte count is invalid`);
    }
    ensureTime(`${kind} accounting`);
    const total = current + value;
    if (total > limit) throw new Error(`Native review aggregate ${kind} budget exceeded`);
    return total;
  };
  return Object.freeze({
    remainingMs,
    gitTimeoutMs: () => ensureTime("Git operation"),
    beforeWrite: label => ensureTime(label),
    addDiffBytes: value => { diffBytes = addBytes("diff", value, NATIVE_REVIEW_PREPARATION_LIMITS.maxDiffBytes, diffBytes); return diffBytes; },
    addImageBytes: value => { imageBytes = addBytes("image", value, NATIVE_REVIEW_PREPARATION_LIMITS.maxImageBytes, imageBytes); return imageBytes; },
    get diffBytes() { return diffBytes; },
    get imageBytes() { return imageBytes; }
  });
}

export function validatePreparationPathCount(manifestPaths) {
  if (!Array.isArray(manifestPaths) || manifestPaths.length === 0 || manifestPaths.length > MAX_REVIEW_PATHS) {
    throw new Error(`Native review preparation path budget exceeded: ${manifestPaths?.length ?? "invalid"}/${MAX_REVIEW_PATHS}`);
  }
  return manifestPaths.length;
}

async function prepareContent({ repository, runDir, packageId, base, head, manifestPaths, binding }) {
  validatePreparationPathCount(manifestPaths);
  const preparation = createPreparationBudget();
  const runDirectory = await assertPhysicalPath(runDir, "Native review run directory", { directory: true });
  await assertPhysicalSnapshot(runDirectory, "Native review run directory");
  const contentRootPath = path.join(runDirectory.path, "native-review-content");
  await mkdir(contentRootPath, { recursive: true, mode: 0o700 });
  const contentRoot = await assertPhysicalPath(contentRootPath, "Native review content parent", { directory: true });
  await assertPhysicalSnapshot(runDirectory, "Native review run directory");
  const directory = path.join(contentRoot.path, packageId);
  await mkdir(directory, { mode: 0o700 });
  const contentDirectory = await assertPhysicalPath(directory, "Native review content directory", { directory: true });
  await assertPhysicalSnapshot(contentRoot, "Native review content parent");
  const streams = [];
  const images = [];
  for (const [position, relative] of manifestPaths.entries()) {
    const id = `s${String(position).padStart(6, "0")}`;
    // Repository identity and clean-tree state were already checked before
    // preparation. Keep each bounded Git call on the same remaining-time
    // budget without repeating worktree discovery for every frozen path.
    const git = (args, options = {}) => runSourceGit(repository, args, {
      ...options,
      timeoutMs: preparation.gitTimeoutMs(),
      validateWorktree: false,
      workTree: repository
    });
    const diff = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
      "--unified=3", ...nativeReviewDiffRevisionsV1({ base, head, reviewMode: binding.reviewMode }), "--", relative], { encoding: "buffer", maxBuffer: MAX_FILE_BYTES });
    preparation.beforeWrite(`diff stream ${relative}`);
    const bytes = Buffer.from(diff.stdout);
    if (!bytes.length) throw new Error(`Native review content stream is empty: ${relative}`);
    preparation.addDiffBytes(bytes.length);
    const stream = { id, binding: {
      base, head, packageSha256: binding.packageSha256, manifestSha256: binding.manifestSha256,
      path: relative, sha256: contentDigest(bytes), bytes: bytes.length
    } };
    preparation.beforeWrite(`diff stream ${relative}`);
    await createBytes(path.join(directory, `${id}.diff`), bytes);
    await assertPhysicalSnapshot(contentDirectory, "Native review content directory");
    streams.push(stream);
    if (/^Binary files .* differ$/m.test(bytes.toString("utf8"))) {
      for (const revision of binding.reviewMode ? [head] : [base, head]) {
        const tree = await git(["ls-tree", "-z", revision, "--", relative]);
        preparation.beforeWrite(`image ${relative}@${revision}`);
        if (!String(tree.stdout).length) continue;
        const blob = Buffer.from((await git(["show", `${revision}:${relative}`],
          { encoding: "buffer", maxBuffer: MAX_FILE_BYTES })).stdout);
        const png = blob.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const jpeg = blob[0] === 255 && blob[1] === 216 && blob[2] === 255;
        const webp = blob.subarray(0, 4).toString("ascii") === "RIFF" && blob.subarray(8, 12).toString("ascii") === "WEBP";
        if (!png && !jpeg && !webp) throw new Error(`Native review requires a separate supported artifact review for binary: ${relative}`);
        preparation.addImageBytes(blob.length);
        const file = path.join(directory, `${id}-${revision}.${png ? "png" : jpeg ? "jpg" : "webp"}`);
        preparation.beforeWrite(`image ${relative}@${revision}`);
        await createBytes(file, blob);
        await assertPhysicalSnapshot(contentDirectory, "Native review content directory");
        images.push({ path: relative, revision, file: await realpath(file), sha256: contentDigest(blob), bytes: blob.length });
      }
    }
  }
  const indexPath = path.join(directory, "index.json");
  preparation.beforeWrite("content index");
  await createJson(indexPath, { protocol: CONTENT_PROTOCOL, streams });
  await assertPhysicalSnapshot(runDirectory, "Native review run directory");
  await assertPhysicalSnapshot(contentRoot, "Native review content parent");
  await assertPhysicalSnapshot(contentDirectory, "Native review content directory");
  const indexFile = await openPhysicalFile(indexPath, "Native review content index");
  return { streams, images, indexPath: indexFile.path, indexSha256: contentDigest(indexFile.bytes), directory: await realpath(directory), directorySnapshot: contentDirectory,
    reader: fileURLToPath(new URL("../native-review-read.mjs", import.meta.url)) };
}

export async function verifyContent(content) {
  const directorySnapshot = await assertPhysicalPath(content.directory ?? path.dirname(content.indexPath), "Native review content directory", { directory: true });
  const { index, directory } = await readContentSnapshot(content.indexPath, content.indexSha256);
  if (directory !== directorySnapshot.path) throw new Error("Native review content directory is not canonical");
  const streams = [];
  for (const stream of index.streams) streams.push({ ...stream, bytes: await readContentStream(directory, stream) });
  for (const image of content.images) {
    const file = await boundedFile(image.file, "Native review attached image");
    if (file.path !== image.file || file.bytes.length !== image.bytes || contentDigest(file.bytes) !== image.sha256) {
      throw new Error("Native review attached image changed");
    }
  }
  await assertPhysicalSnapshot(directorySnapshot, "Native review content directory");
  return streams;
}

async function verifyPreparedSource(content, repository, binding, manifestPaths) {
  const observed = await verifyContent(content);
  if (JSON.stringify(observed.map(s => s.binding.path)) !== JSON.stringify(manifestPaths)) {
    throw new Error("Shard preparation omitted a manifest path");
  }
  const budget = createPreparationBudget(), expectedImages = [];
  const git = (args, options = {}) => runSourceGit(repository, args, { ...options, timeoutMs: budget.gitTimeoutMs(),
    validateWorktree: false, workTree: repository });
  for (const stream of observed) {
    const diff = await git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
      "--unified=3", ...nativeReviewDiffRevisionsV1(binding), "--", stream.binding.path], { encoding: "buffer", maxBuffer: MAX_FILE_BYTES });
    if (!Buffer.from(diff.stdout).equals(stream.bytes)) throw new Error("Shard preparation diff changed");
    if (/^Binary files .* differ$/m.test(stream.bytes.toString("utf8"))) {
      for (const revision of binding.reviewMode ? [binding.head] : [binding.base, binding.head]) {
        const tree = await git(["ls-tree", "-z", revision, "--", stream.binding.path]);
        if (!String(tree.stdout).length) continue;
        const blob = Buffer.from((await git(["show", `${revision}:${stream.binding.path}`], { encoding: "buffer", maxBuffer: MAX_FILE_BYTES })).stdout);
        budget.addImageBytes(blob.length);
        expectedImages.push({ path: stream.binding.path, revision, sha256: contentDigest(blob), bytes: blob.length });
      }
    }
  }
  const actualImages = content.images.map(({ path, revision, sha256, bytes }) => ({ path, revision, sha256, bytes }));
  if (JSON.stringify(actualImages) !== JSON.stringify(expectedImages)) throw new Error("Shard preparation omitted or changed image bytes");
  return observed;
}

async function assertFileUnchanged(original, label) {
  const current = await boundedFile(original.path, label);
  if (current.info.dev !== original.info.dev || current.info.ino !== original.info.ino ||
      !current.bytes.equals(original.bytes)) {
    throw new Error(`${label} changed during native review`);
  }
}

export async function validateShardedReviewReceipt(receiptPath, { binding: expected = {}, reviewPackage = null } = {}) {
  const replay = await replayShardedReceipt({ receiptPath, expectedBinding: expected,
    io: { boundedFile, verifyContent, validateReview } });
  const { receipt, plan, result } = replay, binding = receipt.binding;
  assert.equal(receiptPath, `${binding.resultPath}.receipt.json`, "Aggregate receipt path is not execution-bound");
  const inputs = {};
  assert.deepEqual(Object.keys(receipt.verification.inputs).sort(), ["authorization", "instruction", "manifest", "package", "policy"]);
  for (const [name, artifact] of Object.entries(receipt.verification.inputs)) {
    const file = await boundedFile(artifact.path, `Frozen ${name}`);
    assert.equal(contentDigest(file.bytes), artifact.sha256, `Frozen ${name} changed`);
    inputs[name] = file;
  }
  for (const [name, key] of [["package", "packageSha256"], ["manifest", "manifestSha256"],
    ["instruction", "instructionSha256"], ["policy", "shardPolicySha256"]]) {
    assert.equal(contentDigest(inputs[name].bytes), binding[key], `Aggregate ${name} binding changed`);
  }
  const authorization = validateDisclosure(JSON.parse(inputs.authorization.bytes), binding);
  assert(Date.parse(authorization.approvedAt) <= Date.parse(receipt.startedAt), "Disclosure was approved after launch");
  assert.deepEqual(validateShardPolicy(JSON.parse(inputs.policy.bytes)), plan.policy);
  const source = await assertPhysicalPath(binding.repository, "Sharded review repository", { directory: true });
  const currentHead = String((await runSourceGit(binding.repository, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout).trim();
  assert.equal(currentHead, binding.head, "Sharded review source HEAD is stale");
  assert.equal(String((await runSourceGit(binding.repository, ["status", "--porcelain=v1"])).stdout), "", "Sharded review source is dirty");
  const packageValue = JSON.parse(inputs.package.bytes), manifestValue = JSON.parse(inputs.manifest.bytes);
  const snapshot = snapshotSubject(packageValue);
  const observedSnapshot = snapshot ? await captureNativeReviewSnapshotIdentityV1(binding.repository, binding.head) : null;
  if (snapshot) {
    for (const key of ["reviewMode", "snapshotTreeOid", "fullUniverseDigest"]) assert.equal(binding[key], snapshot[key], "Snapshot receipt binding changed");
    assert.deepEqual(snapshot, snapshotSubject(observedSnapshot), "Actual public snapshot source changed");
    assert.deepEqual(normalizeManifest(manifestValue), observedSnapshot.manifest, "Full snapshot omitted a tracked path");
  } else if (binding.reviewMode !== undefined) throw new Error("Diff package cannot use a snapshot receipt");
  const mergeBase = snapshot ? null : String((await runSourceGit(binding.repository, ["merge-base", binding.base, binding.head])).stdout).trim();
  if (!snapshot) assert.equal(mergeBase, binding.base);
  const canonical = validatePackageIdentity(packageValue, { packageId: binding.packageId, base: binding.base, head: binding.head,
    mergeBase, manifestValue, instructionBytes: inputs.instruction.bytes });
  if (reviewPackage) {
    // Lifecycle annotations can legitimately change the live package's raw
    // file hash. The frozen authorization snapshot and canonical identity must
    // both remain exact; annotations never replace the original review scope.
    validatePackageIdentity(reviewPackage, { packageId: binding.packageId, base: binding.base, head: binding.head,
      mergeBase, manifestValue, instructionBytes: inputs.instruction.bytes });
    for (const field of ["schemaVersion", "immutable", "packageId", "base", "head", "mergeBase", "scope", "scopeDigest",
      "diffManifest", "diffManifestDigest", "contractDigest", "templateDigest", "sentinelDigest", "instructionDigest",
      "reviewProfileDigest", "workUnitPolicy", "workUniverse", "workUniverseDigest", "reviewLanes", "reviewLanesDigest",
      ...(snapshot ? ["reviewMode", "snapshotTreeOid", "fullUniverseDigest"] : [])]) {
      assert.deepEqual(packageValue[field], reviewPackage[field], `Sharded package identity changed: ${field}`);
    }
  }
  const diff = await runSourceGit(binding.repository, ["diff", "--name-status", "-z", ...nativeReviewDiffRevisionsV1(binding)],
    { encoding: "buffer", maxBuffer: MAX_FILE_BYTES });
  validateGitDiffManifest(diff.stdout, canonical);
  await verifyPreparedSource(receipt.verification.content, binding.repository, binding, canonical.manifestPaths);
  await assertPhysicalSnapshot(source, "Sharded review repository");
  const review = { ...result, ...(snapshot ? { scopeCoverage: { ...result.scopeCoverage,
    reviewMode: snapshot.reviewMode, snapshotTreeOid: snapshot.snapshotTreeOid, fullUniverseDigest: snapshot.fullUniverseDigest } } : {}), reviewProtocol: SHARD_PROTOCOL, shardProof: { schemaVersion: 1,
    planDigest: replay.receipt.planDigest, aggregateReceiptPath: receiptPath, aggregateReceiptSha256: replay.receiptSha256,
    executionId: binding.executionId } };
  // Existing host sign-native signs reviewDigest of this ENTIRE object; no
  // signer schema downgrade or new root capability is needed. Removing proof
  // changes the signed digest and therefore cannot reuse its attestation.
  return { ...replay, review, nativeInput: { reviewerId: binding.reviewerId, model: binding.model,
    executionId: binding.executionId, review }, signerBinding: {
    base: binding.base, head: binding.head, instructionDigest: binding.instructionSha256, model: binding.model,
    packageId: binding.packageId, promptDigest: binding.instructionSha256, reviewDigest: digestObject(review),
    reviewerId: binding.reviewerId, runId: binding.runId, sentinelDigest: packageValue.sentinelDigest, executionId: binding.executionId
  } };
}

export async function runNativeReview({
  runId,
  runDir,
  cwd,
  base,
  head,
  packageId,
  packagePath,
  manifestPath,
  instructionPath,
  authorizationPath,
  model = "gpt-5.6-luna",
  effort = "max",
  reviewerId,
  executionId,
  resultPath,
  shardPolicyPath = null,
  prepareOnly = false,
  reviewMode = undefined,
  timeoutMs = NATIVE_REVIEW_TIMEOUT_MS,
  timeoutGraceMs = NATIVE_REVIEW_TIMEOUT_GRACE_MS
}) {
  if (!SAFE_ID.test(String(runId ?? "")) || !SHA.test(String(base ?? "")) || !SHA.test(String(head ?? "")) || !SAFE_ID.test(String(packageId ?? "")) ||
      !SAFE_ID.test(String(model ?? "")) || !SAFE_ID.test(String(effort ?? "")) || !SAFE_ID.test(String(reviewerId ?? "")) || !SAFE_ID.test(String(executionId ?? ""))) {
    throw new Error("Native review exact identity is invalid");
  }
  if (!path.isAbsolute(resultPath) || path.resolve(resultPath) !== resultPath || !(await pathAbsent(resultPath))) {
    throw new Error("Native review result path must be absolute and absent");
  }
  const resultParentSnapshot = await assertPhysicalPath(path.dirname(resultPath), "Native review result parent", { directory: true });
  const resultDirectory = await realpath(path.dirname(resultPath));
  const resultDirectoryInfo = await lstat(resultDirectory);
  const requestedResultDirectory = path.dirname(resultPath);
  const resultParentAlias = stableMacAlias(requestedResultDirectory, resultDirectory);
  if ((resultDirectory !== resultParentSnapshot.path && !resultParentAlias) ||
      (resultDirectory !== requestedResultDirectory && !resultParentAlias) ||
      !resultDirectoryInfo.isDirectory() || resultDirectoryInfo.isSymbolicLink()) {
    throw new Error("Native review result parent must be one canonical physical directory");
  }
  const repositorySnapshot = await assertPhysicalPath(path.resolve(cwd), "Native review repository", { directory: true });
  const repository = await realpath(repositorySnapshot.path);
  const runDirectorySnapshot = await assertPhysicalPath(path.resolve(runDir), "Native review run directory", { directory: true });
  const canonicalRunDir = await realpath(runDirectorySnapshot.path);
  await assertPhysicalSnapshot(resultParentSnapshot, "Native review result parent");
  const packageFile = await boundedFile(packagePath, "Native review package");
  const manifestFile = await boundedFile(manifestPath, "Native review manifest");
  const instructionFile = await boundedFile(instructionPath, "Native review instruction");
  if (prepareOnly && !shardPolicyPath) throw new Error("Preparation requires an explicit shard policy");
  const authorizationFile = prepareOnly ? null : await boundedFile(authorizationPath, "Native review authorization");
  const shardPolicyFile = shardPolicyPath ? await boundedFile(shardPolicyPath, "Native review shard policy") : null;
  const shardPolicy = shardPolicyFile ? validateShardPolicy(JSON.parse(shardPolicyFile.bytes)) : null;
  const packageValue = JSON.parse(packageFile.bytes.toString("utf8"));
  const expectedPackagePath = path.join(await realpath(canonicalRunDir), "review-packages", `${packageId}.json`);
  if (packageFile.path !== expectedPackagePath) {
    throw new Error("Native review package must be the canonical run-owned immutable package");
  }
  const manifestValue = JSON.parse(manifestFile.bytes.toString("utf8"));
  // Source inspection must preserve the index regardless of ambient caller
  // settings. Reuse the bounded, isolated Git boundary for both phases.
  const headResult = String((await runSourceGit(repository, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout).trim();
  if (headResult !== head) throw new Error("Native review HEAD changed before launch");
  const clean = String((await runSourceGit(repository, ["status", "--porcelain=v1"])).stdout);
  if (clean) throw new Error("Native review requires a clean committed tree");
  const snapshot = snapshotSubject(packageValue);
  if (reviewMode !== undefined && reviewMode !== NATIVE_REVIEW_FULL_SNAPSHOT_MODE_V1 ||
      (snapshot?.reviewMode ?? undefined) !== reviewMode || snapshot && !shardPolicy) {
    throw new Error("Full snapshot requires its explicit package mode and the actual observed shard executor");
  }
  const observedSnapshot = snapshot ? await captureNativeReviewSnapshotIdentityV1(repository, head) : null;
  if (snapshot && (base !== snapshot.base || digestObject(snapshot) !== digestObject(snapshotSubject(observedSnapshot)))) {
    throw new Error("Native full snapshot actual HEAD/tree/universe differs from its package");
  }
  const mergeBase = snapshot ? null : String((await runSourceGit(repository, ["merge-base", base, head])).stdout).trim();
  if (!snapshot && mergeBase !== base) throw new Error("Native review BASE must equal the Git merge base of HEAD");
  const { packageManifest, suppliedManifest, manifestPaths } = validatePackageIdentity(packageValue, {
    packageId,
    base,
    head,
    mergeBase,
    manifestValue,
    instructionBytes: instructionFile.bytes
  });
  const diff = await runSourceGit(repository, ["diff", "--name-status", "-z", ...nativeReviewDiffRevisionsV1({ base, head, reviewMode })], {
    encoding: "buffer",
    maxBuffer: MAX_FILE_BYTES
  });
  const gitRecords = validateGitDiffManifest(diff.stdout, { packageManifest, suppliedManifest });
  const binding = {
    runId,
    repository,
    base,
    head,
    packageId,
    packageSha256: sha256(packageFile.bytes),
    manifestSha256: sha256(manifestFile.bytes),
    instructionSha256: sha256(instructionFile.bytes),
    reviewProtocol: shardPolicy ? SHARD_PROTOCOL : REVIEW_PROTOCOL,
    ...(snapshot ? { reviewMode: snapshot.reviewMode, snapshotTreeOid: snapshot.snapshotTreeOid, fullUniverseDigest: snapshot.fullUniverseDigest } : {}),
    ...(shardPolicy ? { shardPolicySha256: sha256(shardPolicyFile.bytes) } : {}),
    model,
    reasoningEffort: effort,
    reviewerId,
    executionId,
    resultPath
  };
  if (!shardPolicy) validateDisclosure(JSON.parse(authorizationFile.bytes.toString("utf8")), binding);
  const codex = prepareOnly ? null : await locateCodex();
  const toolPath = await fixedToolPath();
  const reviewPath = [...new Set([
    path.dirname(process.execPath),
    toolPath,
    process.env.PATH
  ].filter(Boolean).flatMap((value) => value.split(path.delimiter)))].join(path.delimiter);
  const launchEnv = { ...process.env, PATH: reviewPath };
  const bridge = fileURLToPath(new URL("../native-review-app-server.mjs", import.meta.url));
  const receiptPath = `${resultPath}.receipt.json`;
  const attemptDirectory = path.join(canonicalRunDir, "native-review-attempts");
  await assertPhysicalSnapshot(runDirectorySnapshot, "Native review run directory");
  await mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
  const attemptDirectorySnapshot = await assertPhysicalPath(attemptDirectory, "Native review attempt directory", { directory: true });
  await assertPhysicalSnapshot(runDirectorySnapshot, "Native review run directory");
  await chmod(attemptDirectory, 0o700);
  const attemptPath = path.join(attemptDirectory, `${packageId}.json`);
  if (!(await pathAbsent(attemptPath))) {
    throw new Error("Native review package already has a consumed model attempt");
  }
  if (!(await pathAbsent(receiptPath))) {
    throw new Error("Native review receipt path must be absent before consuming the package attempt");
  }
  // Single content/job creation is exclusive. Reject an unavailable CLI first.
  if (!shardPolicy) {
    await preflightExecutionArtifacts(codex, { cwd: repository, env: launchEnv }, {
      absent: [attemptPath, receiptPath, resultPath, `${resultPath}.events.jsonl`,
        path.join(canonicalRunDir, "native-review-content", packageId)]
    });
    for (const [file, label] of [[packageFile, "package"], [manifestFile, "manifest"],
      [instructionFile, "instruction"], [authorizationFile, "authorization"]]) {
      await assertFileUnchanged(file, label);
    }
    await assertPhysicalSnapshot(repositorySnapshot, "Native review repository");
    await assertPhysicalSnapshot(runDirectorySnapshot, "Native review run directory");
    await assertPhysicalSnapshot(attemptDirectorySnapshot, "Native review attempt directory");
    await assertPhysicalSnapshot(resultParentSnapshot, "Native review result parent");
    const actualHead = String((await runSourceGit(repository, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout).trim();
    const dirty = String((await runSourceGit(repository, ["status", "--porcelain=v1"])).stdout);
    if (actualHead !== head || dirty) throw new Error("Native review source changed");
  }
  const preparedPath = path.join(canonicalRunDir, "native-review-content", packageId, "shard-preparation.json");
  let content;
  if (shardPolicy && !(await pathAbsent(preparedPath))) {
    const preparedFile = await boundedFile(preparedPath, "Shard preparation");
    const prepared = JSON.parse(preparedFile.bytes);
    if (JSON.stringify(prepared.binding) !== JSON.stringify(binding)) throw new Error("Shard preparation binding changed");
    content = prepared.content;
    const expectedDirectory = path.dirname(preparedPath);
    if (content.directory !== expectedDirectory || content.indexPath !== path.join(expectedDirectory, "index.json")) {
      throw new Error("Shard preparation source directory changed");
    }
    // Rebuild every expected diff from pinned Git objects; a prepared index
    // cannot invent source bytes, paths or image attachments before authorization.
    await verifyPreparedSource(content, repository, binding, manifestPaths);
  } else {
    content = await prepareContent({ repository, runDir: canonicalRunDir, packageId, base, head, manifestPaths, binding });
    if (shardPolicy) await createJson(preparedPath, { binding, content });
  }
  // Reject invalid UTF-8, unsupported artifacts and stale snapshot bytes before
  // consuming any model attempt, rather than discovering them in a costly run.
  await verifyContent(content);
  await assertPhysicalSnapshot(repositorySnapshot, "Native review repository");
  await assertPhysicalSnapshot(runDirectorySnapshot, "Native review run directory");
  await assertPhysicalSnapshot(attemptDirectorySnapshot, "Native review attempt directory");
  await assertPhysicalSnapshot(resultParentSnapshot, "Native review result parent");
  if (shardPolicy) {
    const { index } = await readContentSnapshot(content.indexPath, content.indexSha256);
    const plan = createShardPlan({ binding, parentIndexSha256: content.indexSha256,
      streams: index.streams, images: content.images, policy: shardPolicy });
    const planPath = path.join(content.directory, "shard-plan.json");
    if (await pathAbsent(planPath)) await createJson(planPath, plan);
    else {
      const existing = await boundedFile(planPath, "Native review shard plan");
      if (shardDigest(JSON.parse(existing.bytes)) !== shardDigest(plan)) throw new Error("Native review shard plan changed");
    }
    const disclosureBinding = { ...binding, shardPlanDigest: shardDigest(plan),
      plannedExecutions: plan.plannedExecutions, totalTimeoutMs: shardPolicy.totalTimeoutMs };
    if (prepareOnly) return { ok: true, prepared: true, modelStarted: false, planPath,
      binding: disclosureBinding, shardCount: plan.shards.length, plannedExecutions: plan.plannedExecutions };
    validateDisclosure(JSON.parse(authorizationFile.bytes), disclosureBinding);
    const planFile = await boundedFile(planPath, "Native review shard plan");
    const assertFresh = async () => {
      for (const [file, label] of [[packageFile, "package"], [manifestFile, "manifest"], [instructionFile, "instruction"],
        [authorizationFile, "authorization"], [shardPolicyFile, "shard policy"], [planFile, "shard plan"]]) await assertFileUnchanged(file, label);
      await assertPhysicalSnapshot(repositorySnapshot, "Native review repository");
      await assertPhysicalSnapshot(runDirectorySnapshot, "Native review run directory");
      await assertPhysicalSnapshot(attemptDirectorySnapshot, "Native review attempt directory");
      await assertPhysicalSnapshot(resultParentSnapshot, "Native review result parent");
      const actualHead = String((await runSourceGit(repository, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout).trim();
      const dirty = String((await runSourceGit(repository, ["status", "--porcelain=v1"])).stdout);
      if (actualHead !== head || dirty) throw new Error("Native review source changed");
      if (snapshot && digestObject(snapshotSubject(await captureNativeReviewSnapshotIdentityV1(repository, head))) !== digestObject(snapshot)) {
        throw new Error("Full snapshot tree or tracked universe changed");
      }
      await verifyContent(content);
    };
    await assertFresh();
    // Prepared index/plan may exist; execution snapshots must follow preflight.
    const preparedDirectory = await assertPhysicalPath(content.directory, "Prepared native review directory", { directory: true });
    const preparedInputs = await Promise.all([content.indexPath, planPath, preparedPath]
      .map(target => boundedFile(target, "Prepared native review input")));
    await preflightExecutionArtifacts(codex, { cwd: repository, env: launchEnv }, {
      absent: [attemptPath, receiptPath, resultPath, `${receiptPath}.completion-candidate.json`,
        path.join(content.directory, "shards"),
        ...["package", "manifest", "instruction", "authorization", "policy"]
          .map(name => path.join(content.directory, `${name}.snapshot`))],
      prepared: preparedInputs, directory: preparedDirectory
    });
    await assertFresh();
    const inputs = {};
    for (const [name, file] of Object.entries({ package: packageFile, manifest: manifestFile, instruction: instructionFile,
      authorization: authorizationFile, policy: shardPolicyFile })) {
      const target = path.join(content.directory, `${name}.snapshot`);
      await createBytes(target, file.bytes);
      inputs[name] = { path: target, sha256: contentDigest(file.bytes) };
    }
    const verification = { planPath, content: { directory: content.directory, indexPath: content.indexPath,
      indexSha256: content.indexSha256, images: content.images }, inputs };
    const startedAt = new Date().toISOString();
    await createJson(attemptPath, { schemaVersion: 2, protocol: SHARD_PROTOCOL, status: "running", startedAt,
      binding: disclosureBinding, planPath, resultPath, receiptPath });
    return executeShardedReview({ plan, content, binding: disclosureBinding, instruction: instructionFile.bytes.toString("utf8"),
      codex, bridge, repository, resultPath, receiptPath, attemptPath, startedAt, verification,
      env: launchEnv,
      io: { createJson, createBytes, atomicJson, boundedFile, verifyContent, assertFresh, spawnReview, validateReview, reviewProtocol } });
  }
  const protocol = reviewProtocol({ base, head, packageId, manifestPaths, content });
  const reviewInput = Buffer.concat([protocol, instructionFile.bytes]);
  const jobPath = path.join(path.dirname(content.indexPath), "app-server-job.json");
  await createJson(jobPath, { schemaVersion: 1, codex, cwd: repository, model, reasoningEffort: effort, executionId, resultPath,
    prompt: reviewInput.toString("utf8"), content: { indexPath: content.indexPath, indexSha256: content.indexSha256 },
    images: content.images });
  const jobFile = await openPhysicalFile(jobPath, "Native review app-server job");
  const jobDigest = sha256(jobFile.bytes);
  const args = [bridge, jobPath, jobDigest];
  const tracePath = `${resultPath}.events.jsonl`;
  if (!(await pathAbsent(tracePath))) throw new Error("Native review event trace must be absent before launch");
  const startedAt = new Date().toISOString();
  await assertPhysicalSnapshot(resultParentSnapshot, "Native review result parent");
  await assertPhysicalSnapshot(attemptDirectorySnapshot, "Native review attempt directory");
  await createJson(attemptPath, {
    schemaVersion: 1,
    status: "running",
    startedAt,
    runId,
    packageId,
    reviewerId,
    executionId,
    resultPath,
    receiptPath
  });
  try {
    await atomicJson(receiptPath, { schemaVersion: 1, status: "running", startedAt, binding, command: [process.execPath, ...args] });
  } catch (error) {
    await atomicJson(attemptPath, {
      schemaVersion: 1,
      status: "blocked",
      startedAt,
      finishedAt: new Date().toISOString(),
      runId,
      packageId,
      reviewerId,
      executionId,
      resultPath,
      receiptPath,
      launchError: error.message
    }).catch(() => undefined);
    throw error;
  }
  let execution;
  try {
    await assertPhysicalSnapshot(repositorySnapshot, "Native review repository");
    await assertPhysicalSnapshot(runDirectorySnapshot, "Native review run directory");
    await assertPhysicalSnapshot(attemptDirectorySnapshot, "Native review attempt directory");
    await assertPhysicalSnapshot(resultParentSnapshot, "Native review result parent");
    execution = await spawnReview(process.execPath, args, {
      cwd: repository,
      input: "",
      env: launchEnv,
      timeoutMs,
      timeoutGraceMs,
      maxOutputBytes: MAX_TRACE_BYTES
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await atomicJson(receiptPath, {
      schemaVersion: 1, status: "blocked", startedAt, finishedAt, binding,
      command: [process.execPath, ...args], launchError: error.message,
      execution: error.execution ?? null
    }).catch(() => undefined);
    await atomicJson(attemptPath, {
      schemaVersion: 1, status: "blocked", startedAt, finishedAt,
      runId, packageId, reviewerId, executionId, resultPath, receiptPath,
      launchError: error.message,
      execution: error.execution ?? null
    });
    throw error;
  }
  // Keep the complete machine-readable events separately. Large traces must
  // never be silently trimmed to make a receipt fit an unrelated JSON limit.
  const eventStream = execution.stdout;
  execution = { ...execution, stdout: "", stdoutArtifact: {
    path: tracePath, sha256: contentDigest(eventStream), bytes: Buffer.byteLength(eventStream)
  } };
  try {
    await assertPhysicalSnapshot(repositorySnapshot, "Native review repository");
    await assertPhysicalSnapshot(runDirectorySnapshot, "Native review run directory");
    await assertPhysicalSnapshot(attemptDirectorySnapshot, "Native review attempt directory");
    await assertPhysicalSnapshot(resultParentSnapshot, "Native review result parent");
    await createBytes(tracePath, Buffer.from(eventStream));
    if (execution.code !== 0) {
      throw new Error(`Native review process exited ${execution.code ?? execution.signal}: ${execution.stderr.trim()}`);
    }
    const resultFile = await boundedFile(resultPath, "Native review result");
    const result = validateReview(JSON.parse(resultFile.bytes.toString("utf8")), {
      base,
      head,
      pathCount: manifestPaths.length,
      manifestPaths
    });
    const streams = await verifyContent(content);
    const contentCoverage = observeContentCoverage(eventStream, { ...content, streams, executionId, model, reasoningEffort: effort });
    if (!contentCoverage.complete) {
      const error = new Error(`Native review content coverage is incomplete: ${contentCoverage.observedPaths}/${contentCoverage.expectedPaths}; model path counts cannot authorize completion`);
      error.contentCoverage = contentCoverage;
      throw error;
    }
    await assertFileUnchanged(packageFile, "Native review package");
    await assertFileUnchanged(manifestFile, "Native review manifest");
    await assertFileUnchanged(instructionFile, "Native review instruction");
    await assertFileUnchanged(authorizationFile, "Native review authorization");
    await assertPhysicalSnapshot(repositorySnapshot, "Native review repository");
    await assertPhysicalSnapshot(runDirectorySnapshot, "Native review run directory");
    await assertPhysicalSnapshot(attemptDirectorySnapshot, "Native review attempt directory");
    await assertPhysicalSnapshot(resultParentSnapshot, "Native review result parent");
    const postHead = String((await runSourceGit(repository, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout).trim();
    const postClean = String((await runSourceGit(repository, ["status", "--porcelain=v1"])).stdout);
    if (postHead !== head || postClean) throw new Error("Native review changed the exact source tree");
    const receipt = {
      schemaVersion: 1,
      status: result.verdict === "PASS" ? "passed" : "blocked",
      finishedAt: new Date().toISOString(),
      binding,
      command: [process.execPath, ...args],
      execution,
      result,
      resultSha256: sha256(resultFile.bytes),
      sourceScope: { expected: manifestPaths.length, gitPaths: gitRecords.length, complete: true },
      scopeCoverage: { expected: manifestPaths.length, observed: contentCoverage.observedPaths, complete: contentCoverage.complete },
      contentCoverage,
      imageInputs: content.images,
      postflight: { head: postHead, clean: true }
    };
    await atomicJson(receiptPath, receipt);
    await atomicJson(attemptPath, {
      schemaVersion: 1,
      status: result.verdict === "PASS" ? "passed" : "blocked",
      finishedAt: receipt.finishedAt,
      runId,
      packageId,
      reviewerId,
      executionId,
      resultPath,
      resultSha256: receipt.resultSha256,
      receiptPath
    });
    return { ok: result.verdict === "PASS", result, resultSha256: receipt.resultSha256, receipt: receiptPath };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await atomicJson(receiptPath, {
      schemaVersion: 1,
      status: "blocked",
      finishedAt,
      binding,
      command: [process.execPath, ...args],
      execution,
      contentCoverage: error.contentCoverage ?? null,
      validationError: error.message
    }).catch(() => undefined);
    await atomicJson(attemptPath, {
      schemaVersion: 1,
      status: "blocked",
      finishedAt,
      runId,
      packageId,
      reviewerId,
      executionId,
      resultPath,
      receiptPath,
      validationError: error.message
    });
    throw error;
  }
}
