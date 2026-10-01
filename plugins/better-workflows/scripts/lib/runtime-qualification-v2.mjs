// SPDX-License-Identifier: AGPL-3.0-only
// V2 target authority is provisioned outside the candidate. Structure is not authority.
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalJson, digestObject, sha256 } from "./core.mjs";
import { productReleaseScope } from "./product-release-scope-v1.mjs";
import { RUNTIME_QUALIFICATION_LANES, runtimeQualificationCommands, qualificationTapSummary } from "./runtime-qualification-v1.mjs";

export { RUNTIME_QUALIFICATION_LANES, runtimeQualificationCommands,
  qualificationTapSummary, runtimeTemporaryCleanupEligible } from "./runtime-qualification-v1.mjs";
export const RUNTIME_QUALIFICATION_TARGET_PATH_V2 = "/private/etc/better-workflows/runtime-qualification-target-v2.json";
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]*$/;
const MAX_POLICY_BYTES = 64 * 1024;
const exec = promisify(execFile);
const installedTargetPolicies = new WeakSet();
const installedTargetSnapshots = new WeakSet();
const stamp = (info) => ["dev", "ino", "size", "mode", "uid", "nlink", "ctimeNs", "mtimeNs"].map((key) => String(info[key]));
const sameStamp = (left, right) => JSON.stringify(stamp(left)) === JSON.stringify(stamp(right));
function keys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error("Runtime V2 policy has missing or unexpected fields");
}
function iso(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error("Runtime V2 policy timestamp is not canonical UTC");
  return parsed;
}

// Advisory validation. Only the fixed protected-file reader below grants target trust.
export function inspectRuntimeQualificationTargetV2(targetPolicy) {
  keys(targetPolicy, ["schemaVersion", "kind", "repository", "sourceRevision", "sourceRef", "workflow", "productReleaseScopeDigest", "validity", "githubCli"]);
  keys(targetPolicy.repository, ["name", "id"]);
  keys(targetPolicy.workflow, ["path", "sha256", "environment", "event"]);
  keys(targetPolicy.validity, ["notBefore", "expiresAt"]);
  keys(targetPolicy.githubCli, ["path", "sha256"]);
  if (targetPolicy.schemaVersion !== 2 || targetPolicy.kind !== "RuntimeQualificationTargetPolicyV2" ||
      typeof targetPolicy.repository.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(targetPolicy.repository.name) ||
      typeof targetPolicy.repository.id !== "string" || !ID.test(targetPolicy.repository.id) ||
      !SHA40.test(targetPolicy.sourceRevision ?? "") || targetPolicy.sourceRef !== "refs/heads/main" ||
      targetPolicy.workflow.path !== ".github/workflows/ci.yml" || !SHA256.test(targetPolicy.workflow.sha256 ?? "") ||
      targetPolicy.workflow.environment !== "v5-runtime-qualification" || targetPolicy.workflow.event !== "push" ||
      !SHA256.test(targetPolicy.productReleaseScopeDigest ?? "") || !SHA256.test(targetPolicy.githubCli.sha256 ?? "") ||
      typeof targetPolicy.githubCli.path !== "string" || !path.isAbsolute(targetPolicy.githubCli.path) ||
      path.resolve(targetPolicy.githubCli.path) !== targetPolicy.githubCli.path || /[\r\n\0]/.test(targetPolicy.githubCli.path) ||
      iso(targetPolicy.validity.notBefore) >= iso(targetPolicy.validity.expiresAt)) throw new Error("Runtime V2 target policy binding is invalid");
  if (Date.now() < iso(targetPolicy.validity.notBefore) || Date.now() >= iso(targetPolicy.validity.expiresAt)) throw new Error("Runtime V2 target policy is not currently valid");
  return Object.freeze({ matches: true, authority: "none" });
}

function parsePolicy(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_POLICY_BYTES) throw new Error("Runtime V2 target policy exceeds bounds");
  const text = bytes.toString("utf8");
  const targetPolicy = JSON.parse(text);
  inspectRuntimeQualificationTargetV2(targetPolicy);
  if (!bytes.equals(Buffer.from(canonicalJson(targetPolicy), "utf8"))) throw new Error("Runtime V2 target policy must use sorted canonical JSON bytes without a trailing newline");
  for (const value of Object.values(targetPolicy)) if (value && typeof value === "object") Object.freeze(value);
  return Object.freeze({ targetPolicy: Object.freeze(targetPolicy), targetPolicySha256: sha256(bytes) });
}

export async function assertRootOwnedRuntimePathV2(file, { directory = false } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file || /[\r\n\0]/.test(file)) throw new Error("Runtime trust path must be absolute and canonical");
  let current = path.parse(file).root;
  const rootInfo = await lstat(current, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== 0n || (rootInfo.mode & 0o022n) !== 0n) throw new Error("Runtime trust root is not protected");
  await assertNoRuntimeAclV2(current);
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current, { bigint: true });
    const leaf = current === file;
    if (info.isSymbolicLink() || info.uid !== 0n || (info.mode & 0o022n) !== 0n ||
        ((!leaf || directory) ? !info.isDirectory() : !info.isFile()) || (!directory && leaf && info.nlink !== 1n)) {
      throw new Error(`Runtime trust path is not protected: ${current}`);
    }
    await assertNoRuntimeAclV2(current);
  }
  if (await realpath(file) !== file) throw new Error("Runtime trust path changed during resolution");
}

async function assertNoRuntimeAclV2(file) {
  if (process.platform !== "darwin") throw new Error("Runtime V2 protected ACL inspection requires macOS");
  const { stdout } = await exec("/bin/ls", ["-lde", file], { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
  const lines = stdout.trimEnd().split("\n");
  if (lines.length !== 1 || !/^[d-][rwxStTs-]{9}@?$/.test(lines[0]?.split(/\s+/, 1)[0] ?? "")) throw new Error("Runtime V2 trust path has an ACL or unreadable ACL state");
}

export async function readBoundedRuntimeFileV2(file, maxBytes) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || await realpath(file) !== file) throw new Error("Runtime V2 file locator or limit is invalid");
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0) throw new Error("Runtime V2 file reads require O_NOFOLLOW");
  const beforePath = await lstat(file, { bigint: true });
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    const size = Number(before.size);
    if (!before.isFile() || before.nlink !== 1n || !Number.isSafeInteger(size) || size < 0 || size > maxBytes || !sameStamp(beforePath, before)) throw new Error("Runtime V2 file is not bounded and physical");
    const bytes = Buffer.alloc(size);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(bytes, position, size - position, position);
      if (bytesRead < 1) throw new Error("Runtime V2 file changed while reading");
      position += bytesRead;
    }
    if (!sameStamp(before, await handle.stat({ bigint: true })) || !sameStamp(before, await lstat(file, { bigint: true })) || await realpath(file) !== file) throw new Error("Runtime V2 file changed during observation");
    return bytes;
  } finally { await handle.close(); }
}

export async function observeRootOwnedRuntimeFileV2(file, { maxBytes, exactMode = null, executable = false, includeBytes = false }) {
  await assertRootOwnedRuntimePathV2(file);
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0) throw new Error("Runtime trust requires O_NOFOLLOW");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    const size = Number(before.size);
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & 0o022n) !== 0n ||
        !Number.isSafeInteger(size) || size < 1 || size > maxBytes ||
        (exactMode !== null && Number(before.mode & 0o777n) !== exactMode) || (executable && (before.mode & 0o111n) === 0n)) throw new Error("Runtime trust file identity or size is invalid");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    const chunks = [];
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead < 1) throw new Error("Runtime trust file changed while hashing");
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      if (includeBytes) chunks.push(Buffer.from(bytes));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if (!sameStamp(before, after) || !sameStamp(before, current)) throw new Error("Runtime trust file changed during observation");
    await assertRootOwnedRuntimePathV2(file);
    return { sha256: hash.digest("hex"), identity: stamp(before), ...(includeBytes ? { bytes: Buffer.concat(chunks) } : {}) };
  } finally { await handle.close(); }
}

export function loadRuntimeQualificationProducerTargetV2(environment = process.env) {
  const text = environment.SBW_RUNTIME_QUALIFICATION_TARGET_POLICY_JSON;
  const expected = environment.SBW_RUNTIME_QUALIFICATION_TARGET_POLICY_SHA256;
  if (typeof text !== "string" || !SHA256.test(expected ?? "")) throw new Error("Runtime V2 producer target policy is unbound");
  const snapshot = parsePolicy(Buffer.from(text, "utf8"));
  if (snapshot.targetPolicySha256 !== expected) throw new Error("Runtime V2 producer policy digest mismatch");
  return snapshot; // Producer configuration only; never a consumer trust input.
}

export async function readInstalledRuntimeQualificationTargetV2() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Runtime V2 protected target reader requires macOS ARM64");
  const observed = await observeRootOwnedRuntimeFileV2(RUNTIME_QUALIFICATION_TARGET_PATH_V2,
    { maxBytes: MAX_POLICY_BYTES, exactMode: 0o644, includeBytes: true });
  const snapshot = Object.freeze({ ...parsePolicy(observed.bytes), identity: Object.freeze(observed.identity) });
  installedTargetPolicies.add(snapshot.targetPolicy);
  installedTargetSnapshots.add(snapshot);
  return snapshot;
}

export async function assertRuntimeQualificationTargetCurrentV2(snapshot) {
  if (!installedTargetSnapshots.has(snapshot)) throw new Error("Runtime V2 target snapshot was not obtained from the protected installation");
  const fresh = await readInstalledRuntimeQualificationTargetV2();
  if (fresh.targetPolicySha256 !== snapshot.targetPolicySha256 || JSON.stringify(fresh.identity) !== JSON.stringify(snapshot.identity)) throw new Error("Runtime V2 target policy changed or was revoked");
}

export function assertInstalledRuntimeQualificationTargetV2(targetPolicy) {
  if (!installedTargetPolicies.has(targetPolicy)) throw new Error("Runtime V2 target authority cannot come from caller data or CI configuration");
  inspectRuntimeQualificationTargetV2(targetPolicy);
}

export function runtimeQualificationArtifactNameV2(laneId, sourceRevision, runId, runAttempt) {
  if (!RUNTIME_QUALIFICATION_LANES.some((lane) => lane.id === laneId) || !SHA40.test(sourceRevision ?? "") ||
      !ID.test(runId ?? "") || !ID.test(runAttempt ?? "")) throw new Error("Runtime V2 artifact identity is invalid");
  return `better-workflows-runtime-v2-${laneId}-${sourceRevision}-${runId}-${runAttempt}`;
}

export function runtimeQualificationTapSummaryV2(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error("Runtime V2 TAP must be captured as raw bytes");
  return qualificationTapSummary(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
}

export async function runtimeQualificationPolicyV2({ sourceRoot, targetPolicy }) {
  inspectRuntimeQualificationTargetV2(targetPolicy);
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot) || path.resolve(sourceRoot) !== sourceRoot || await realpath(sourceRoot) !== sourceRoot) throw new Error("Runtime V2 source root must be explicit and canonical");
  const { scopeDigest } = await productReleaseScope();
  const candidateScope = JSON.parse(await readBoundedRuntimeFileV2(path.join(sourceRoot, "plugins/better-workflows/config/product-release-scope-v1.json"), 64 * 1024));
  if (!scopeDigest || scopeDigest !== targetPolicy.productReleaseScopeDigest || digestObject(candidateScope) !== scopeDigest) throw new Error("Runtime V2 product scope differs from the trusted contract");
  const workflowBytes = await readBoundedRuntimeFileV2(path.join(sourceRoot, targetPolicy.workflow.path), 1024 * 1024);
  if (sha256(workflowBytes) !== targetPolicy.workflow.sha256) throw new Error("Runtime V2 workflow differs from the owner-approved bytes");
  const filePaths = [...new Set(RUNTIME_QUALIFICATION_LANES.flatMap((lane) => runtimeQualificationCommands(lane.id)
    .flatMap((command) => command.args.filter((arg) => arg.startsWith("scripts/tests/")).map((file) => `plugins/better-workflows/${file}`))))].sort();
  const files = await Promise.all(filePaths.map(async (file) => ({ path: file, sha256: sha256(await readBoundedRuntimeFileV2(path.join(sourceRoot, file), 16 * 1024 * 1024)) })));
  const policy = { schemaVersion: 2, kind: "RuntimeQualificationPolicyV2", productVersion: "5.0.0",
    revision: "public-macos-node22-24-20260930-r1", coverage: "posix-process-and-runtime-features", fullEvaluatorIncluded: false,
    lanes: RUNTIME_QUALIFICATION_LANES.map((lane) => ({ ...lane, commands: runtimeQualificationCommands(lane.id) })), files,
    acceptance: { failures: 0, skipped: 0, cancelled: 0, todo: 0, processGroupsTerminated: true } };
  return { policy, policyDigest: digestObject(policy), scopeDigest };
}

// Advisory structure check only. A matching JSON object never establishes
// execution, signature verification, or permission to publish a release.
export function inspectRuntimeQualificationEnvelopeV2(envelope, { sourceRevision, scopeDigest, policy, policyDigest, lane, runId, runAttempt, targetPolicy, targetPolicySha256, sourceInventoryDigest }) {
  inspectRuntimeQualificationTargetV2(targetPolicy);
  const { envelopeDigest, ...payload } = envelope ?? {};
  if (digestObject(payload) !== envelopeDigest || payload.kind !== "RuntimeQualificationEnvelopeV2" || payload.schemaVersion !== 2 ||
      payload.targetPolicySha256 !== targetPolicySha256 || !SHA256.test(targetPolicySha256 ?? "") ||
      sourceRevision !== targetPolicy.sourceRevision || scopeDigest !== targetPolicy.productReleaseScopeDigest || !SHA256.test(payload.resourcesSha256 ?? "") ||
      !SHA256.test(sourceInventoryDigest ?? "") || payload.sourceInventoryDigest !== sourceInventoryDigest ||
      payload.sourceRevision !== sourceRevision || payload.productReleaseScopeDigest !== scopeDigest || payload.policyDigest !== policyDigest ||
      digestObject(payload.lane) !== digestObject(lane) || digestObject(payload.files) !== digestObject(policy.files) ||
      payload.coverage !== policy.coverage || payload.fullEvaluatorIncluded !== false || payload.result !== "PASS" || payload.failure !== null ||
      payload.host?.platform !== lane.platform || payload.host?.arch !== lane.arch || payload.runtime?.version !== lane.nodeVersion ||
      !/^[a-f0-9]{64}$/.test(payload.runtime?.executableSha256 ?? "") || payload.cleanup?.tempRemoved !== true ||
      payload.cleanup?.status !== "VERIFIED_WITHIN_SUITE_SCOPE" ||
      digestObject(payload.cleanup?.evidence) !== digestObject(["capture-process-group", "successful-suite-cleanup-assertions"]) ||
      payload.authentication?.status !== "awaiting-github-oidc-attestation" || payload.authentication?.releaseEligible !== false) {
    throw new Error(`Runtime envelope policy, execution, or source mismatch: ${lane.id}`);
  }
  const expectedGithub = { repository: targetPolicy.repository.name, repositoryId: targetPolicy.repository.id,
    runId, runAttempt, workflowRef: `${targetPolicy.repository.name}/${targetPolicy.workflow.path}@refs/heads/main`,
    workflowSha: sourceRevision, workflowFileSha256: targetPolicy.workflow.sha256,
    event: targetPolicy.workflow.event, environment: targetPolicy.workflow.environment, sourceRef: "refs/heads/main", runnerEnvironment: "github-hosted" };
  if (digestObject(payload.github) !== digestObject(expectedGithub)) throw new Error("Runtime envelope workflow or attempt drift");
  const timestamp = (value) => {
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
  };
  const start = timestamp(payload.startedAt);
  const end = timestamp(payload.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("Runtime execution interval is invalid");
  const expectedCommands = runtimeQualificationCommands(lane.id);
  if (!Array.isArray(payload.commands) || payload.commands.length !== expectedCommands.length) throw new Error("Runtime command coverage incomplete");
  let previousEnd = start;
  for (const [index, expected] of expectedCommands.entries()) {
    const command = payload.commands[index];
    if (!command || command.id !== expected.id || digestObject(command.args) !== digestObject(expected.args) || command.result !== "PASS" ||
        command.exitCode !== 0 || command.signal !== null || command.timedOut !== false || command.outputExceeded !== false || command.processGroupTerminated !== true ||
        !/^[a-f0-9]{64}$/.test(command.stdoutSha256 ?? "") || !/^[a-f0-9]{64}$/.test(command.stderrSha256 ?? "")) {
      throw new Error("Runtime command lacks successful execution and cleanup");
    }
    const commandStart = timestamp(command.startedAt);
    const commandEnd = timestamp(command.finishedAt);
    if (!Number.isFinite(commandStart) || !Number.isFinite(commandEnd) || commandStart < previousEnd || commandEnd > end || commandEnd < commandStart ||
        !Number.isSafeInteger(command.elapsedMs) || command.elapsedMs < 0) throw new Error("Runtime command interval is invalid");
    previousEnd = commandEnd;
  }
  return Object.freeze({ matches: true, authority: "none", envelopeDigest });
}

const SOURCE_V2_SHA1 = /^[a-f0-9]{40}$/;
const SOURCE_V2_MAX_FILES = 10_000;
const SOURCE_V2_MAX_DIRECTORIES = 8192;
const SOURCE_V2_MAX_BYTES = 512 * 1024 * 1024;
const SOURCE_V2_MAX_FILE_BYTES = 32 * 1024 * 1024;
const SOURCE_V2_MAX_METADATA_BYTES = 4 * 1024 * 1024;
const SOURCE_V2_MAX_DEPTH = 32;
const SOURCE_V2_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function sourceFailureV2(message) {
  throw new Error("Runtime V2 source tree: " + message);
}
function sourcePathOrderV2(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function sourcePathKeyV2(value) {
  // Conservative Unicode alias detection, deliberately stricter than a specific
  // case-sensitive filesystem. NFC path spelling is separately required below.
  return value.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFC");
}
function assertSourcePathV2(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") ||
      Buffer.byteLength(value, "utf8") > 4096 || value.normalize("NFC") !== value ||
      /[\\<>:"|?*\u0000-\u001f\u007f]/u.test(value)) {
    sourceFailureV2("unsafe or noncanonical path");
  }
  const parts = value.split("/");
  if (parts.length > SOURCE_V2_MAX_DEPTH || parts.some((part) =>
    !part || part === "." || part === ".." || sourcePathKeyV2(part) === ".git" ||
    /[. ]$/u.test(part) || Buffer.byteLength(part, "utf8") > 255 ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    sourceFailureV2("unsafe path component: " + value);
  }
  return parts;
}
function sourceIdentityV2(info) {
  const fields = ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "ctimeNs", "mtimeNs"];
  if (fields.some((field) => typeof info[field] !== "bigint")) {
    sourceFailureV2("nanosecond physical file identity is unavailable");
  }
  return Object.freeze(fields.map((field) => String(info[field])));
}
function sameSourceIdentityV2(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function sourceGitModeV2(info) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n ||
      (info.mode & 0o7000n) !== 0n) {
    sourceFailureV2("nonregular, hard-linked, or special-mode source file");
  }
  // Git canonical regular-file mode records the owner execute bit, not umask.
  // Full POSIX mode/uid/gid are retained in the drift snapshot independently.
  return (info.mode & 0o100n) === 0n ? "100644" : "100755";
}
function sourceAbsoluteV2(sourceRoot, relative) {
  const absolute = relative ? path.join(sourceRoot, ...relative.split("/")) : sourceRoot;
  if (relative && (absolute === sourceRoot || !absolute.startsWith(sourceRoot + path.sep))) {
    sourceFailureV2("path escaped source root");
  }
  return absolute;
}

// This function validates caller data only. The authoritative consumer obtains
// records itself from approved gh: commit SHA -> tree SHA -> recursive tree,
// requiring returned SHA equality and truncated === false. No caller JSON is
// an admission authority. Leaf-only records also support the fresh-CI adapter.
export function inspectTrustedRuntimeSourceTreeV2(records) {
  if (!Array.isArray(records) || records.length < 1 ||
      records.length > SOURCE_V2_MAX_FILES + SOURCE_V2_MAX_DIRECTORIES) {
    sourceFailureV2("tree record count exceeds bounds or is empty");
  }
  const files = [];
  const derivedDirectories = new Set();
  const explicitDirectories = new Set();
  const recordPaths = new Set();
  const kinds = new Map();
  const folded = new Map();
  let declaredBytes = 0;

  function register(relative, kind) {
    const key = sourcePathKeyV2(relative);
    if (folded.has(key) && folded.get(key) !== relative) {
      sourceFailureV2("case/normalization collision: " + relative);
    }
    folded.set(key, relative);
    if (kinds.has(relative) && kinds.get(relative) !== kind) {
      sourceFailureV2("file/directory collision: " + relative);
    }
    kinds.set(relative, kind);
  }
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(record))) {
      sourceFailureV2("record must be plain data");
    }
    const allowed = new Set(["path", "mode", "type", "sha", "size", "url"]);
    for (const key of Reflect.ownKeys(record)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (typeof key !== "string" || !allowed.has(key) || !descriptor ||
          !descriptor.enumerable || !("value" in descriptor)) {
        sourceFailureV2("unexpected/non-data tree record field");
      }
    }
    const parts = assertSourcePathV2(record.path);
    if (recordPaths.has(record.path) || typeof record.sha !== "string" ||
        !SOURCE_V2_SHA1.test(record.sha)) sourceFailureV2("duplicate path or invalid object OID");
    recordPaths.add(record.path);
    for (let index = 1; index < parts.length; index += 1) {
      register(parts.slice(0, index).join("/"), "tree");
    }
    if (record.type === "tree" && record.mode === "040000") {
      register(record.path, "tree");
      explicitDirectories.add(record.path);
      continue;
    }
    if (record.type !== "blob" || !["100644", "100755"].includes(record.mode)) {
      // Includes mode120000 symlinks and mode160000/typecommit submodules.
      sourceFailureV2("unsupported object type/mode: " + record.path);
    }
    register(record.path, "blob");
    if (files.length >= SOURCE_V2_MAX_FILES) sourceFailureV2("too many files");
    let size = null;
    if (Object.hasOwn(record, "size")) {
      size = record.size;
      if (!Number.isSafeInteger(size) || size < 0 || size > SOURCE_V2_MAX_FILE_BYTES) {
        sourceFailureV2("invalid or oversized declared blob");
      }
      declaredBytes += size;
      if (declaredBytes > SOURCE_V2_MAX_BYTES) sourceFailureV2("declared source bytes exceed bounds");
    }
    files.push(Object.freeze({ path: record.path, mode: record.mode, sha: record.sha, size }));
    for (let index = 1; index < parts.length; index += 1) {
      derivedDirectories.add(parts.slice(0, index).join("/"));
    }
  }
  if (!files.length) sourceFailureV2("no materialized source files");
  if (derivedDirectories.size > SOURCE_V2_MAX_DIRECTORIES) sourceFailureV2("too many directories");
  for (const directory of explicitDirectories) {
    if (!derivedDirectories.has(directory)) {
      // Git does not ordinarily materialize empty trees in a checkout. Do not
      // silently drop them from the remote candidate's complete tree universe.
      sourceFailureV2("empty/unmaterialized Git tree is unsupported: " + directory);
    }
  }
  files.sort((left, right) => sourcePathOrderV2(left.path, right.path));
  const directories = Object.freeze([...derivedDirectories].sort(sourcePathOrderV2));
  const immutableFiles = Object.freeze(files);
  const fileBindings = immutableFiles.map(({ path: filePath, mode, sha }) =>
    Object.freeze({ path: filePath, mode, sha }));
  return Object.freeze({
    kind: "RuntimeSourceTreeInspectionV2", authority: "none", matches: true,
    files: immutableFiles, directories,
    expectedFilesDigest: digestObject(fileBindings)
  });
}

async function sourceDirectoryNamesV2(directory, isRoot) {
  // opendir bounds allocation; readdir could allocate an attacker-sized list.
  const handle = await opendir(directory, { encoding: "buffer", bufferSize: 32 });
  const names = [];
  let entries = 0;
  try {
    while (true) {
      const entry = await handle.read();
      if (entry === null) break;
      if (++entries > SOURCE_V2_MAX_FILES + SOURCE_V2_MAX_DIRECTORIES + 1) {
        sourceFailureV2("physical directory entry count exceeds bounds");
      }
      if (!Buffer.isBuffer(entry.name)) sourceFailureV2("directory names were not returned as raw bytes");
      let name;
      try { name = SOURCE_V2_UTF8.decode(entry.name); }
      catch { sourceFailureV2("filesystem name is not strict UTF8"); }
      if (!Buffer.from(name, "utf8").equals(entry.name)) sourceFailureV2("noncanonical name bytes");
      if (isRoot && name === ".git") {
        const metadata = await lstat(path.join(directory, name), { bigint: true });
        if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
          sourceFailureV2("root Git metadata has unsafe type");
        }
        continue; // The sole exemption; never skip a nested .git or any ignore.
      }
      names.push(name);
    }
  } finally { await handle.close(); }
  names.sort(sourcePathOrderV2);
  return Object.freeze(names);
}
async function sourceDirectoryIdentityV2(directory) {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) {
    sourceFailureV2("directory is not physical/canonical");
  }
  return { identity: sourceIdentityV2(info), inode: String(info.dev) + ":" + String(info.ino) };
}

// Enumerates actual source bytes without invoking Git. Unknown/missing files and
// directories fail, including ignored files, .DS_Store, caches and nested .git.
// Return has no admission authority. A caller re-observes before/after all work
// and compares sourceInventoryDigest AND sourceSnapshotDigest.
export async function observeRuntimeSourceTreeV2({ sourceRoot, treeRecords }) {
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot) ||
      path.resolve(sourceRoot) !== sourceRoot || sourceRoot === path.parse(sourceRoot).root ||
      /[\r\n\0]/.test(sourceRoot) || await realpath(sourceRoot) !== sourceRoot) {
    sourceFailureV2("source root must be explicit, canonical and non-root");
  }
  const inspected = inspectTrustedRuntimeSourceTreeV2(treeRecords);
  const expectedFiles = new Map(inspected.files.map((file) => [file.path, file]));
  const expectedDirectories = new Set(inspected.directories);
  const expectedCase = new Map();
  for (const relative of [...expectedFiles.keys(), ...expectedDirectories]) {
    expectedCase.set(sourcePathKeyV2(relative), relative);
  }
  const stack = [""];
  const observedDirectories = new Map();
  const physicalInodes = new Set();
  const seenFilePaths = new Set();
  const actualCase = new Map();
  const files = [];
  const fileIdentities = new Map();
  let totalBytes = 0;

  while (stack.length) {
    const relativeDirectory = stack.pop();
    if (observedDirectories.has(relativeDirectory)) sourceFailureV2("directory was visited twice");
    const directory = sourceAbsoluteV2(sourceRoot, relativeDirectory);
    const beforeDirectory = await sourceDirectoryIdentityV2(directory);
    if (physicalInodes.has(beforeDirectory.inode)) sourceFailureV2("aliased/hard-linked directory");
    physicalInodes.add(beforeDirectory.inode);
    const names = await sourceDirectoryNamesV2(directory, relativeDirectory === "");
    observedDirectories.set(relativeDirectory, { before: beforeDirectory.identity, names });
    if (observedDirectories.size > SOURCE_V2_MAX_DIRECTORIES + 1) sourceFailureV2("too many physical directories");

    for (const name of names) {
      const relative = relativeDirectory ? relativeDirectory + "/" + name : name;
      assertSourcePathV2(relative);
      const folded = sourcePathKeyV2(relative);
      if (actualCase.has(folded) && actualCase.get(folded) !== relative ||
          expectedCase.has(folded) && expectedCase.get(folded) !== relative) {
        sourceFailureV2("physical path/case alias: " + relative);
      }
      actualCase.set(folded, relative);
      const absolute = sourceAbsoluteV2(sourceRoot, relative);
      const before = await lstat(absolute, { bigint: true });
      if (before.isSymbolicLink()) sourceFailureV2("physical symlink: " + relative);
      if (before.isDirectory()) {
        if (!expectedDirectories.has(relative) || expectedFiles.has(relative)) {
          sourceFailureV2("unknown or wrong-type directory: " + relative);
        }
        stack.push(relative);
        continue;
      }
      if (!before.isFile() || !expectedFiles.has(relative)) {
        sourceFailureV2("unknown, missing-type, or special file: " + relative);
      }
      const expected = expectedFiles.get(relative);
      const mode = sourceGitModeV2(before);
      const size = Number(before.size);
      if (mode !== expected.mode || !Number.isSafeInteger(size) || size < 0 ||
          size > SOURCE_V2_MAX_FILE_BYTES || expected.size !== null && size !== expected.size) {
        sourceFailureV2("file mode/size mismatch: " + relative);
      }
      totalBytes += size;
      if (totalBytes > SOURCE_V2_MAX_BYTES) sourceFailureV2("actual source bytes exceed bounds");
      const beforeIdentity = sourceIdentityV2(before);
      const bytes = await readBoundedRuntimeFileV2(absolute, SOURCE_V2_MAX_FILE_BYTES);
      const after = await lstat(absolute, { bigint: true });
      if (bytes.length !== size || !sameSourceIdentityV2(beforeIdentity, sourceIdentityV2(after)) ||
          sourceGitModeV2(after) !== mode) sourceFailureV2("file changed around raw-byte read: " + relative);
      const blobOid = createHash("sha1").update("blob " + bytes.length + "\0", "utf8").update(bytes).digest("hex");
      if (blobOid !== expected.sha) sourceFailureV2("raw file does not match approved Git blob: " + relative);
      if (seenFilePaths.has(relative)) sourceFailureV2("physical file duplicated");
      seenFilePaths.add(relative);
      fileIdentities.set(relative, beforeIdentity);
      files.push(Object.freeze({ path: relative, mode, blobOid, size, sha256: sha256(bytes) }));
    }
    const afterDirectory = await sourceDirectoryIdentityV2(directory);
    if (!sameSourceIdentityV2(beforeDirectory.identity, afterDirectory.identity)) {
      sourceFailureV2("directory changed while its entries were inspected");
    }
  }
  if (seenFilePaths.size !== expectedFiles.size ||
      [...expectedFiles.keys()].some((file) => !seenFilePaths.has(file)) ||
      observedDirectories.size !== expectedDirectories.size + 1 ||
      [...expectedDirectories].some((directory) => !observedDirectories.has(directory))) {
    sourceFailureV2("approved source file/directory inventory is incomplete");
  }
  files.sort((left, right) => sourcePathOrderV2(left.path, right.path));
  const beforeSnapshot = [];
  const afterSnapshot = [];
  for (const file of files) {
    const absolute = sourceAbsoluteV2(sourceRoot, file.path);
    const now = await lstat(absolute, { bigint: true });
    const afterIdentity = sourceIdentityV2(now);
    if (!sameSourceIdentityV2(fileIdentities.get(file.path), afterIdentity) ||
        sourceGitModeV2(now) !== file.mode || await realpath(absolute) !== absolute) {
      sourceFailureV2("file drifted after inventory read: " + file.path);
    }
    beforeSnapshot.push(Object.freeze({ type: "blob", path: file.path, identity: fileIdentities.get(file.path) }));
    afterSnapshot.push(Object.freeze({ type: "blob", path: file.path, identity: afterIdentity }));
  }
  for (const relative of [...observedDirectories.keys()].sort(sourcePathOrderV2)) {
    const absolute = sourceAbsoluteV2(sourceRoot, relative);
    const observed = observedDirectories.get(relative);
    const afterDirectory = await sourceDirectoryIdentityV2(absolute);
    const names = await sourceDirectoryNamesV2(absolute, relative === "");
    const finalDirectory = await sourceDirectoryIdentityV2(absolute);
    if (!sameSourceIdentityV2(observed.before, afterDirectory.identity) ||
        !sameSourceIdentityV2(observed.before, finalDirectory.identity) ||
        JSON.stringify(names) !== JSON.stringify(observed.names)) {
      sourceFailureV2("directory namespace drift: " + relative);
    }
    beforeSnapshot.push(Object.freeze({ type: "tree", path: relative, identity: observed.before, names: observed.names }));
    afterSnapshot.push(Object.freeze({ type: "tree", path: relative, identity: finalDirectory.identity, names }));
  }
  const immutableFiles = Object.freeze(files);
  const immutableBefore = Object.freeze(beforeSnapshot);
  const immutableAfter = Object.freeze(afterSnapshot);
  return Object.freeze({
    kind: "RuntimeSourceTreeObservationV2", authority: "none", matches: true,
    sourceRoot, fileCount: files.length, totalBytes,
    expectedFilesDigest: inspected.expectedFilesDigest,
    sourceInventoryDigest: digestObject(immutableFiles), // Portable raw-byte/mode inventory.
    sourceSnapshotDigest: digestObject({ sourceRoot, entries: immutableAfter }), // Host-local drift.
    files: immutableFiles,
    before: immutableBefore, after: immutableAfter
  });
}

// The producer reads both trees and blobs from its fresh CI checkout. Never
// use status, the index, filters, or caller callbacks for expected source records.
export function parseRuntimeProducerLsTreeV2(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > SOURCE_V2_MAX_METADATA_BYTES) {
    sourceFailureV2("producer tree listing exceeds bounds");
  }
  const records = [];
  let start = 0;
  for (let cursor = 0; cursor < raw.length; cursor += 1) {
    if (raw[cursor] !== 0) continue;
    if (cursor === start || records.length >= SOURCE_V2_MAX_FILES + SOURCE_V2_MAX_DIRECTORIES) sourceFailureV2("invalid producer record count");
    const chunk = raw.subarray(start, cursor);
    start = cursor + 1;
    const tab = chunk.indexOf(9);
    if (tab < 1) sourceFailureV2("malformed producer tree record");
    let metadata;
    let filePath;
    try {
      metadata = SOURCE_V2_UTF8.decode(chunk.subarray(0, tab)).split(" ");
      filePath = SOURCE_V2_UTF8.decode(chunk.subarray(tab + 1));
    } catch { sourceFailureV2("producer tree record is not strict UTF8"); }
    if (metadata.length !== 3 || !SOURCE_V2_SHA1.test(metadata[2]) ||
        !(metadata[1] === "blob" && ["100644", "100755"].includes(metadata[0]) ||
          metadata[1] === "tree" && metadata[0] === "040000")) {
      sourceFailureV2("producer tree has symlink/gitlink or unsupported metadata");
    }
    records.push(Object.freeze({ mode: metadata[0], type: metadata[1], sha: metadata[2], path: filePath }));
  }
  if (start !== raw.length) sourceFailureV2("producer tree output lacks final NUL");
  inspectTrustedRuntimeSourceTreeV2(records);
  return Object.freeze(records);
}

const sourceGitExecV2 = promisify(execFile);
export async function readRuntimeProducerTreeV2({ sourceRoot, sourceRevision }) {
  if (typeof sourceRevision !== "string" || !SOURCE_V2_SHA1.test(sourceRevision) ||
      typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot) ||
      path.resolve(sourceRoot) !== sourceRoot || await realpath(sourceRoot) !== sourceRoot) {
    sourceFailureV2("producer candidate locator is invalid");
  }
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_") || /^(?:DYLD_|LD_)/.test(key)) delete environment[key];
  }
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    // The bounded tree observation must never fetch missing objects remotely.
    GIT_NO_LAZY_FETCH: "1"
  });
  const { stdout } = await sourceGitExecV2("/usr/bin/git", [
    "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "ls-tree", "-r", "-t", "-z", "--full-tree", sourceRevision
  ], { cwd: sourceRoot, env: environment, encoding: null, timeout: 30_000,
    maxBuffer: SOURCE_V2_MAX_METADATA_BYTES });
  return parseRuntimeProducerLsTreeV2(stdout);
}
