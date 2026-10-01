// SPDX-License-Identifier: AGPL-3.0-only
// One installed RC operation authority. Production callers provide only a locator.
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { constants, closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, digestObject, sha256 } from "./core.mjs";
import { assertRootOwnedRuntimePathV2, observeRootOwnedRuntimeFileV2, readBoundedRuntimeFileV2,
  observeRuntimeSourceTreeV2, parseRuntimeProducerLsTreeV2 } from "./runtime-qualification-v2.mjs";
import { assertProductReleaseTargetManifestV1, resolveProductReleaseTargetV1 } from "./product-release-channel-v1.mjs";
import { productReleaseScope } from "./product-release-scope-v1.mjs";
import { createW5PublicReleaseCandidateBindingV1 } from "./w5-public-candidate-binding-v1.mjs";
import { readW5PublicationJournalV1 } from "./w5-publication-journal-v1.mjs";
import { runSourceGit, RC_SOURCE_GIT_EXECUTABLE_V1, RC_SOURCE_GIT_EXEC_PATH_V1,
  assertInstalledRcSourceGitScopeV1, assertCurrentRcSourceGitV1, markInstalledRcSourceGitEffectStartedV1 } from "./git.mjs";
import { verifyPublicSourceExportV2 } from "../../../../scripts/public-source-export-verifier-v2.mjs";

export const RC_PUBLICATION_POLICY_ROOT_V1 = "/private/etc/better-workflows/rc-publication-v1";
export const RC_PUBLICATION_STATE_ROOT_V1 = "/private/var/db/better-workflows/rc-publication-v1";
export const RC_PUBLICATION_IMAGE_ROOT_V1 = "/private/var/db/better-workflows/rc-publisher-images-v1";
const IMAGE_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const ENTRY = "plugins/better-workflows/scripts/publish-product-rc-v1.mjs";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DECIMAL = /^[1-9][0-9]*$/;
const EFFECTS = ["create-source-main", "create-rc-tag", "create-rc-prerelease"];
const contexts = new WeakMap();
const MAX_JSON = 4 * 1024 * 1024;

export class RcPublicationHoldErrorV1 extends Error {
  constructor(code, message, status = "HOLD") { super(message); this.name = "RcPublicationHoldErrorV1"; this.code = code; this.status = status; }
}
export function rcPublicationHoldV1(code, message, status = "HOLD") { throw new RcPublicationHoldErrorV1(code, message, status); }
const hold = rcPublicationHoldV1;
export function rcPublicationExactFieldsV1(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0") ||
      fields.some(key => { const d = Object.getOwnPropertyDescriptor(value, key); return !d?.enumerable || !("value" in d); })) {
    hold("ERC_SCHEMA", `${label} requires exact plain data fields`);
  }
  return value;
}
const exact = rcPublicationExactFieldsV1;
function freeze(value) { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function timestamp(value) { const n = typeof value === "string" ? Date.parse(value) : NaN; if (!Number.isFinite(n) || new Date(n).toISOString() !== value) hold("ERC_TIME", "Noncanonical authorization time"); return n; }
function absolute(value) { return typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value); }
function relative(value) { return typeof value === "string" && value.length <= 512 && !value.startsWith("/") && !/[\\\0\r\n]/.test(value) && value.split("/").every(p => p && p !== "." && p !== ".."); }
function same(a, b) { return canonicalJson(a) === canonicalJson(b); }
function validSha(value, pattern = SHA256) { if (!pattern.test(value ?? "")) hold("ERC_BINDING", "Invalid exact publication digest"); }
export function inspectRcPublicationOperationLocatorV1(request) {
  exact(request, ["operationId"], "RC operation request");
  if (typeof request.operationId !== "string" || !ID.test(request.operationId) || request.operationId.endsWith(".")) hold("ERC_LOCATOR", "Invalid RC operation locator");
  return request.operationId;
}
function actor(value) { exact(value, ["login", "id"], "actor"); if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.login ?? "") || !DECIMAL.test(value.id ?? "")) hold("ERC_ACTOR", "Actor identity is not frozen"); }
function cli(value) { exact(value, ["path", "sha256"], "CLI pin"); if (!absolute(value.path) || /[\s'"!]/.test(value.path)) hold("ERC_CLI", "CLI path is invalid"); validSha(value.sha256); }
export function assertRcPublicationPinnedNodeFlagsV1(execArgv) {
  // W3's parse-only ESM closure needs SourceTextModule on Node 22/24. This is
  // the only permitted runtime flag; loader, preload and environment overrides
  // remain forbidden by the installed invocation check below.
  if (!Array.isArray(execArgv) || execArgv.length !== 1 || execArgv[0] !== "--experimental-vm-modules") {
    hold("ERC_ENVIRONMENT", "Installed publisher requires its exact pinned Node parser flag");
  }
}
export function inspectRcPublicationPolicyV1(policy, operationId) {
  exact(policy, ["schemaVersion", "kind", "operationId", "imageManifestSha256", "actor", "cli", "target", "candidate", "productReleaseScopeDigest", "license", "rightsPolicySha256", "projectionApprovalSha256"], "RC installed policy");
  if (policy.schemaVersion !== 1 || policy.kind !== "InstalledProductRcPublicationPolicyV1" || policy.operationId !== operationId) hold("ERC_POLICY", "Installed RC policy identity differs");
  for (const key of ["imageManifestSha256", "productReleaseScopeDigest", "rightsPolicySha256", "projectionApprovalSha256"]) validSha(policy[key]);
  actor(policy.actor); exact(policy.cli, ["node", "gh", "git"], "CLI pins"); for (const pin of Object.values(policy.cli)) cli(pin);
  if (policy.cli.git.path !== RC_SOURCE_GIT_EXECUTABLE_V1) hold("ERC_CLI", "RC source and publication require the fixed direct CommandLineTools Git executable");
  exact(policy.target, ["repository", "sourceRef", "tagRef", "runtimeWorkflowPath", "hostWorkflowPath", "qaWorkflowPath", "qaWorkflowRef", "qaWorkflowSha", "siteOrigin", "siteIdentityDigest"], "public target");
  const t = policy.target; exact(t.repository, ["name", "id"], "repository");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t.repository.name ?? "") || !DECIMAL.test(t.repository.id ?? "") || !Number.isSafeInteger(Number(t.repository.id)) ||
      t.sourceRef !== "refs/heads/main" || t.runtimeWorkflowPath !== ".github/workflows/ci.yml" || t.hostWorkflowPath !== ".github/workflows/host-conformance.yml" ||
      t.qaWorkflowPath !== ".github/workflows/website-public-qa.yml" || t.qaWorkflowRef !== "refs/heads/main" ||
      !/^https:\/\/[A-Za-z0-9.-]+(?::443)?$/.test(t.siteOrigin ?? "")) hold("ERC_TARGET", "Exact public target or workflows are invalid");
  validSha(t.siteIdentityDigest); validSha(t.qaWorkflowSha, SHA40);
  exact(policy.candidate, ["publicRoot", "privateRoot", "publicCandidateSha", "publicTreeOid", "privateSourceSha", "privateSourceTreeOid", "expectedBase", "exportManifestSha256", "exportManifestDigest", "exportDigest", "releaseVersion"], "candidate");
  const c = policy.candidate;
  if (!absolute(c.publicRoot) || !absolute(c.privateRoot) || c.publicRoot === c.privateRoot || c.publicRoot === IMAGE_ROOT || c.privateRoot === IMAGE_ROOT || c.publicRoot.startsWith(`${IMAGE_ROOT}/`) || c.privateRoot.startsWith(`${IMAGE_ROOT}/`)) hold("ERC_SOURCE", "Candidate and installed image must be distinct");
  for (const key of ["publicCandidateSha", "publicTreeOid", "privateSourceSha", "privateSourceTreeOid", "expectedBase"]) validSha(c[key], SHA40);
  if (c.expectedBase !== c.publicCandidateSha) hold("ERC_FORMAL_BASE", "Initial parentless public RC formal baseline must be the public candidate itself; private source is provenance only");
  for (const key of ["exportManifestSha256", "exportManifestDigest", "exportDigest"]) validSha(c[key]);
  if (!/^5\.0\.0-rc\.(0|[1-9][0-9]*)$/.test(c.releaseVersion ?? "")) {
    hold("ERC_CHANNEL", "Policy does not bind the exact RC candidate/channel");
  }
  let releaseTag;
  try { releaseTag = resolveProductReleaseTargetV1(c.releaseVersion).releaseTag; }
  catch { hold("ERC_CHANNEL", "Policy does not bind the exact RC candidate/channel"); }
  if (t.tagRef !== `refs/tags/${releaseTag}` || t.qaWorkflowSha !== c.publicCandidateSha) {
    hold("ERC_CHANNEL", "Policy does not bind the exact RC candidate/channel");
  }
  exact(policy.license, ["inventoryPath", "inventorySha256", "outerBindingPath", "outerBindingSha256", "artifactPath", "artifactSha256", "releaseBodyPath", "releaseBodySha256"], "license inputs");
  for (const key of ["inventoryPath", "outerBindingPath", "artifactPath", "releaseBodyPath"]) if (!relative(policy.license[key])) hold("ERC_SOURCE", "License/release input path escapes the public checkout");
  for (const [key, expected] of Object.entries({
    inventoryPath: ".git/bw-rc-license-v1/inventory.json",
    outerBindingPath: ".git/bw-rc-license-v1/outer-binding.json",
    artifactPath: ".git/bw-rc-license-v1/verification-archive.tar.gz"
  })) if (policy.license[key] !== expected) hold("ERC_LICENSE_INPUT", "License carrier must use the protected Git metadata namespace");
  if (policy.license.releaseBodyPath !== "plugins/better-workflows/config/version-manifest-v1.json") hold("ERC_CHANGELOG", "RC release notes must derive from the exact committed version manifest");
  for (const key of ["inventorySha256", "outerBindingSha256", "artifactSha256", "releaseBodySha256"]) validSha(policy.license[key]);
  return policy;
}

async function protectedObservation(file, limit = MAX_JSON, mode = 0o644) {
  let observed;
  try { observed = await observeRootOwnedRuntimeFileV2(file, { maxBytes: limit, exactMode: mode, includeBytes: true }); }
  catch (error) {
    if (error.code !== "ENOENT") hold("ERC_INSTALLED_INPUT_UNTRUSTED", "A required fixed installed artifact is not physically root-protected and bounded");
    const name = path.basename(file);
    const code = { "policy.json": "ERC_POLICY_MISSING", "grant.json": "ERC_STAGED_GRANT_MISSING", "image-manifest.json": "ERC_IMAGE_MISSING", "projection-approval.json": "ERC_PROJECTION_APPROVAL_MISSING",
      "owner-authorization.json": "ERC_HUMAN_AUTHORIZATION_MISSING", "review-docs.json": "ERC_REVIEW_CONFIG_MISSING", "qualification.json": "ERC_QUALIFICATION_CONFIG_MISSING" }[name] ?? (name.startsWith("rights-") ? "ERC_RIGHTS_INPUT_MISSING" : "ERC_INSTALLED_INPUT_MISSING");
    hold(code, "An indispensable fixed installed input is absent");
  }
  return { file, limit, mode, ...observed };
}
function parseCanonical(bytes) {
  let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { hold("ERC_JSON", "Protected artifact is not valid bounded UTF-8 JSON"); }
  if (!Buffer.from(canonicalJson(value)).equals(bytes)) hold("ERC_JSON", "Protected artifact is not canonical sorted JSON bytes");
  return value;
}
async function protectedJson(file) { const observed = await protectedObservation(file); return { ...observed, value: parseCanonical(observed.bytes) }; }
function assertInvocation(operationId, policy) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || typeof process.getuid !== "function" || process.getuid() !== 0) hold("ERC_INSTALLATION_REQUIRED", "RC publisher requires independently installed macOS ARM64 root authority");
  assertRcPublicationPinnedNodeFlagsV1(process.execArgv);
  if (process.env.PATH !== "/usr/bin:/bin:/usr/sbin:/sbin" || Object.keys(process.env).some(key => /^(?:NODE_|LD_PRELOAD|DYLD_|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|HTTPS?_PROXY|ALL_PROXY|https?_proxy|all_proxy)/.test(key))) hold("ERC_ENVIRONMENT", "Installed publisher requires its fixed OS command search path and rejects loader/config/TLS/proxy injection");
  if (process.execPath !== policy.cli.node.path || !same(process.argv.slice(1), [path.join(IMAGE_ROOT, ENTRY), "--operation", operationId]) ||
      IMAGE_ROOT !== path.join(RC_PUBLICATION_IMAGE_ROOT_V1, policy.imageManifestSha256)) hold("ERC_IMAGE", "Invocation does not use the exact installed publisher image/entrypoint/runtime");
}
async function imageObservation(policyRoot, expectedDigest) {
  const record = await protectedJson(path.join(policyRoot, "image-manifest.json"));
  if (record.sha256 !== expectedDigest) hold("ERC_IMAGE", "Installed image manifest differs from the staged grant policy");
  exact(record.value, ["schemaVersion", "kind", "files"], "installed image manifest");
  if (record.value.schemaVersion !== 1 || record.value.kind !== "ProductRcPublisherImageV1" || !Array.isArray(record.value.files) || record.value.files.length < 3 || record.value.files.length > 8192) hold("ERC_IMAGE", "Installed image manifest is incomplete");
  const expected = new Map(); let total = 0; let previous = "";
  for (const file of record.value.files) {
    exact(file, ["path", "sha256", "mode"], "image file");
    if (!relative(file.path) || file.path <= previous || ![0o644, 0o755].includes(file.mode)) hold("ERC_IMAGE", "Image file manifest is not canonical/complete");
    validSha(file.sha256); previous = file.path; expected.set(file.path, file);
  }
  const observations = [record];
  async function walk(directory, prefix = "") {
    await assertRootOwnedRuntimePathV2(directory, { directory: true });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === IMAGE_ROOT && entry.name === ".git") hold("ERC_IMAGE", "Installed image must exclude Git metadata");
      const rel = `${prefix}${entry.name}`; const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) { await walk(file, `${rel}/`); continue; }
      const pin = expected.get(rel);
      if (!entry.isFile() || entry.isSymbolicLink() || !pin) hold("ERC_IMAGE", "Installed image has an unmanifested or nonphysical entry");
      const observed = await protectedObservation(file, 32 * 1024 * 1024, pin.mode);
      total += observed.bytes.length; if (total > 256 * 1024 * 1024 || observed.sha256 !== pin.sha256) hold("ERC_IMAGE", "Installed image bytes differ or exceed bounds");
      observations.push(observed); expected.delete(rel);
    }
  }
  await walk(IMAGE_ROOT);
  if (expected.size || !record.value.files.some(file => file.path === ENTRY)) hold("ERC_IMAGE", "Installed image manifest misses its actual source/entrypoint");
  return { observations, manifest: record.value };
}

export function inspectRcPublisherImageCandidateBindingV1(manifest, treeObservation) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== "ProductRcPublisherImageV1" ||
      !Array.isArray(manifest.files) || treeObservation?.kind !== "RuntimeSourceTreeObservationV2" ||
      treeObservation.matches !== true || !Array.isArray(treeObservation.files)) {
    hold("ERC_IMAGE_SOURCE", "Installed image lacks a complete verified public candidate tree");
  }
  const expected = treeObservation.files.map(file => ({ path: file.path, sha256: file.sha256,
    mode: file.mode === "100644" ? 0o644 : file.mode === "100755" ? 0o755 : null }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (expected.some(file => file.mode === null) || !same(manifest.files, expected)) {
    hold("ERC_IMAGE_SOURCE", "Installed image is not the complete exact public candidate tree");
  }
  return Object.freeze({ fileCount: treeObservation.fileCount, totalBytes: treeObservation.totalBytes,
    sourceInventoryDigest: treeObservation.sourceInventoryDigest,
    sourceSnapshotDigest: treeObservation.sourceSnapshotDigest });
}
export function inspectRcPublicationStagedGrantV1(grant, policy, policySha256, releaseTarget, w3) {
  exact(grant, ["schemaVersion", "kind", "operationId", "policySha256", "installedImageSha256", "actor", "cli", "target", "publicCandidateSha", "publicTreeOid", "privateSourceSha", "exportManifestDigest", "exportDigest", "productReleaseScopeDigest", "releaseTargetDigest", "projectionApprovalSha256", "effects", "prerequisiteIds", "approvedAt", "expiresAt", "ownerAuthorizationSha256"], "staged publication grant");
  if (grant.schemaVersion !== 1 || grant.kind !== "ProductRcPublicationStagedGrantV1" || grant.operationId !== policy.operationId || grant.policySha256 !== policySha256 ||
      grant.installedImageSha256 !== policy.imageManifestSha256 || !same(grant.actor, policy.actor) || !same(grant.cli, policy.cli) || !same(grant.target, policy.target) ||
      grant.publicCandidateSha !== w3.publicCandidateSha || grant.publicTreeOid !== w3.publicTreeOid || grant.privateSourceSha !== w3.privateSourceSha ||
      grant.exportManifestDigest !== w3.exportManifestDigest || grant.exportDigest !== w3.exportDigest || grant.productReleaseScopeDigest !== policy.productReleaseScopeDigest ||
      grant.releaseTargetDigest !== releaseTarget.releaseTargetDigest || grant.projectionApprovalSha256 !== policy.projectionApprovalSha256 ||
      !same(grant.effects, EFFECTS) || !same(grant.prerequisiteIds, releaseTarget.commonAcceptance) ||
      timestamp(grant.approvedAt) > Date.now() || timestamp(grant.expiresAt) <= Date.now() || timestamp(grant.approvedAt) >= timestamp(grant.expiresAt)) hold("ERC_GRANT", "Genuine immutable staged publication grant is missing, expired or mismatched");
  validSha(grant.ownerAuthorizationSha256);
}

export async function readInstalledRcPublicationGitPolicyV1(request) {
  const operationId = inspectRcPublicationOperationLocatorV1(request);
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.getuid?.() !== 0) hold("ERC_INSTALLATION_REQUIRED", "RC Git authority requires the installed root publisher invocation");
  const record = await protectedJson(path.join(RC_PUBLICATION_POLICY_ROOT_V1, operationId, "policy.json"));
  const policy = inspectRcPublicationPolicyV1(record.value, operationId);
  assertInvocation(operationId, policy);
  return freeze({ operationId, pin: { ...policy.cli.git }, policyObservation: {
    file: record.file, maxBytes: record.limit, exactMode: record.mode, executable: false, sha256: record.sha256, identity: [...record.identity]
  } });
}

export async function loadInstalledRcPublicationContextV1(request) {
  const operationId = inspectRcPublicationOperationLocatorV1(request);
  // Fixed host paths only; no candidate policy, environment flag or caller JSON.
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.getuid?.() !== 0) hold("ERC_INSTALLATION_REQUIRED", "RC publication authority is not installed in this invocation");
  const policyRoot = path.join(RC_PUBLICATION_POLICY_ROOT_V1, operationId);
  const policyRecord = await protectedJson(path.join(policyRoot, "policy.json"));
  const policy = inspectRcPublicationPolicyV1(policyRecord.value, operationId); assertInvocation(operationId, policy);
  assertInstalledRcSourceGitScopeV1(policy.cli.git, operationId);
  await assertCurrentRcSourceGitV1();
  const image = await imageObservation(policyRoot, policy.imageManifestSha256);
  const observations = [policyRecord, ...image.observations];
  for (const pin of Object.values(policy.cli)) {
    const observed = await observeRootOwnedRuntimeFileV2(pin.path, { maxBytes: 512 * 1024 * 1024, executable: true });
    if (observed.sha256 !== pin.sha256) hold("ERC_CLI", "Installed command executable differs from its exact pin");
    observations.push({ ...observed, file: pin.path, limit: 512 * 1024 * 1024, executable: true });
  }
  for (const root of [policy.candidate.publicRoot, policy.candidate.privateRoot]) if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) hold("ERC_SOURCE", "Candidate source root is not physical/canonical");
  await assertRootOwnedRuntimePathV2(policy.candidate.publicRoot, { directory: true });
  const publicConfig = await protectedObservation(path.join(policy.candidate.publicRoot, ".git", "config"), 16 * 1024);
  const config = await runSourceGit(policy.candidate.publicRoot, ["config", "--local", "--null", "--list"], { encoding: "utf8", maxBuffer: 16 * 1024 });
  const coreValues = new Map();
  for (const record of String(config.stdout).split("\0").filter(Boolean)) {
    const index = record.indexOf("\n"), key = record.slice(0, index), value = record.slice(index + 1);
    if (index < 1 || coreValues.has(key) || !/^core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)$/.test(key)) hold("ERC_SOURCE_GIT_CONFIG", "Public candidate Git config has a redirect, hook, include, remote or unsupported setting");
    coreValues.set(key, value);
  }
  for (const [key, value] of coreValues) if (["core.ignorecase", "core.precomposeunicode"].includes(key) ? !["true", "false"].includes(value) : value !== (key === "core.repositoryformatversion" ? "0" : key === "core.bare" ? "false" : "true")) hold("ERC_SOURCE_GIT_CONFIG", "Public candidate Git config differs from its isolated source repository");
  for (const key of ["core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates"]) if (!coreValues.has(key)) hold("ERC_SOURCE_GIT_CONFIG", "Public candidate Git config is incomplete");
  observations.push(publicConfig);
  const exportRecord = await protectedObservation(path.join(policyRoot, "export-manifest.json"), 8 * 1024 * 1024);
  if (exportRecord.sha256 !== policy.candidate.exportManifestSha256) hold("ERC_SOURCE", "Fixed projection manifest bytes differ");
  const verification = await verifyPublicSourceExportV2({ sourceRepository: policy.candidate.privateRoot, manifestBytes: exportRecord.bytes, outputDirectory: policy.candidate.publicRoot });
  const { kind: ignoredKind, authority: ignoredAuthority, verifiedSurface: ignoredSurface, ...projection } = verification;
  const w3 = { ...projection, schemaVersion: 2, kind: "W3LocalPublicCandidateV2", status: "LOCAL_PROJECTION_VERIFIED", authority: "none", verifiedSurface: "local-git-ref-object-graph-only" };
  for (const key of ["publicCandidateSha", "publicTreeOid", "privateSourceSha", "privateSourceTreeOid", "exportManifestDigest", "exportDigest"]) if (w3[key] !== policy.candidate[key]) hold("ERC_SOURCE", "Installed policy does not match actual public projection");
  if (w3.productReleaseScopeDigest !== policy.productReleaseScopeDigest) hold("ERC_SCOPE", "Public projection scope differs");
  let imageTreeRecords, imageTreeBinding;
  try {
    const listed = await runSourceGit(policy.candidate.publicRoot,
      ["ls-tree", "-r", "-t", "-z", "--full-tree", policy.candidate.publicCandidateSha],
      { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
    imageTreeRecords = parseRuntimeProducerLsTreeV2(listed.stdout);
    imageTreeBinding = inspectRcPublisherImageCandidateBindingV1(image.manifest,
      await observeRuntimeSourceTreeV2({ sourceRoot: IMAGE_ROOT, treeRecords: imageTreeRecords }));
  } catch {
    hold("ERC_IMAGE_SOURCE", "Installed image does not match the independently verified complete public candidate tree");
  }
  const approval = await protectedJson(path.join(policyRoot, "projection-approval.json"));
  if (approval.sha256 !== policy.projectionApprovalSha256 || approval.sha256 !== w3.approvalArtifactSha256) hold("ERC_PROJECTION_APPROVAL", "Projection approval is not the independently installed reviewed artifact");
  exact(approval.value, ["schemaVersion", "kind", "operationId", "privateSourceSha", "privateSourceTreeOid", "projectionBodyDigest", "productReleaseScopeDigest", "approvedAt", "approval"], "projection approval");
  const exportManifest = JSON.parse(exportRecord.bytes);
  const { approvalArtifact: omittedApproval, ...projectionBody } = exportManifest;
  if (approval.value.schemaVersion !== 1 || approval.value.kind !== "ProductRcPublicProjectionOwnerApprovalV1" || approval.value.operationId !== operationId || approval.value.approval !== "HUMAN_EXPLICIT" ||
      approval.value.privateSourceSha !== w3.privateSourceSha || approval.value.privateSourceTreeOid !== w3.privateSourceTreeOid ||
      approval.value.projectionBodyDigest !== digestObject(projectionBody) || approval.value.productReleaseScopeDigest !== policy.productReleaseScopeDigest || timestamp(approval.value.approvedAt) > Date.now()) hold("ERC_PROJECTION_APPROVAL", "Projection owner approval differs from the exact reviewed projection");
  // The reviewed projection body excludes only its approval-artifact pointer.
  // The subsequent immutable staged grant binds the resulting exact public SHA.
  const manifestBytes = await readBoundedRuntimeFileV2(path.join(policy.candidate.publicRoot, "plugins/better-workflows/config/version-manifest-v1.json"), 128 * 1024);
  const releaseTarget = assertProductReleaseTargetManifestV1(JSON.parse(manifestBytes));
  if (releaseTarget.channel !== "rc" || releaseTarget.releaseVersion !== policy.candidate.releaseVersion) hold("ERC_CHANNEL", "Only exact controlled RC publication is available");
  const scopeBytes = await readBoundedRuntimeFileV2(path.join(policy.candidate.publicRoot, "plugins/better-workflows/config/product-release-scope-v1.json"), 128 * 1024);
  const installedScope = await productReleaseScope();
  if (installedScope.scopeDigest !== policy.productReleaseScopeDigest || digestObject(JSON.parse(scopeBytes)) !== installedScope.scopeDigest || installedScope.releaseTarget?.releaseTargetDigest !== releaseTarget.releaseTargetDigest) hold("ERC_SCOPE", "Committed/installed release scope differs from the accepted RC contract");
  const grantRecord = await protectedJson(path.join(policyRoot, "grant.json"));
  inspectRcPublicationStagedGrantV1(grantRecord.value, policy, policyRecord.sha256, releaseTarget, w3);
  const ownerRecord = await protectedObservation(path.join(policyRoot, "owner-authorization.json"));
  if (ownerRecord.sha256 !== grantRecord.value.ownerAuthorizationSha256) hold("ERC_OWNER_AUTHORIZATION", "Staged grant lacks its exact independently installed human authorization record");
  const authorization = parseCanonical(ownerRecord.bytes);
  exact(authorization, ["schemaVersion", "kind", "operationId", "approval", "grantSubjectDigest", "approvedAt"], "owner publication authorization");
  const { ownerAuthorizationSha256: omittedOwnerHash, ...grantSubject } = grantRecord.value;
  if (authorization.schemaVersion !== 1 || authorization.kind !== "ProductRcPublicationOwnerAuthorizationV1" || authorization.operationId !== operationId ||
      authorization.approval !== "HUMAN_EXPLICIT" || authorization.grantSubjectDigest !== digestObject(grantSubject) || authorization.approvedAt !== grantRecord.value.approvedAt) hold("ERC_OWNER_AUTHORIZATION", "Installed human authorization is not for this exact staged grant subject");
  // Root provisioning authenticates the original owner record. This reader never
  // manufactures consent from empty-target consent or a caller approval field.
  const w5 = createW5PublicReleaseCandidateBindingV1({ w3Candidate: w3, expectedProductReleaseScopeDigest: policy.productReleaseScopeDigest,
    target: { provider: "github", repositoryId: Number(policy.target.repository.id), repository: policy.target.repository.name,
      workflowPath: policy.target.runtimeWorkflowPath, sourceRef: policy.target.sourceRef, tagRef: policy.target.tagRef, siteIdentityDigest: policy.target.siteIdentityDigest },
    grantDigest: grantRecord.sha256, releaseVersion: releaseTarget.releaseVersion, expectedReleaseTargetDigest: releaseTarget.releaseTargetDigest });
  const stateRoot = path.join(RC_PUBLICATION_STATE_ROOT_V1, operationId);
  await assertRootOwnedRuntimePathV2(RC_PUBLICATION_STATE_ROOT_V1, { directory: true });
  if (((await lstat(RC_PUBLICATION_STATE_ROOT_V1)).mode & 0o777) !== 0o700) hold("ERC_STATE", "Shared publication coordination root must already be root-private");
  await assertRootOwnedRuntimePathV2(stateRoot, { directory: true });
  if (((await lstat(stateRoot)).mode & 0o777) !== 0o700) hold("ERC_STATE", "Authoritative publication state root must already be root-private");
  const commandsRoot = path.join(stateRoot, "commands");
  try { await mkdir(commandsRoot, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  await assertRootOwnedRuntimePathV2(commandsRoot, { directory: true });
  if (((await lstat(commandsRoot)).mode & 0o777) !== 0o700) hold("ERC_STATE", "Owned command namespace must remain root-private");
  const binding = { operationId, publicCandidateSha: w3.publicCandidateSha, publicTreeOid: w3.publicTreeOid, privateSourceSha: w3.privateSourceSha,
    exportManifestDigest: w3.exportManifestDigest, productReleaseScopeDigest: policy.productReleaseScopeDigest, releaseTargetDigest: releaseTarget.releaseTargetDigest,
    repository: policy.target.repository, sourceRef: policy.target.sourceRef, tagRef: policy.target.tagRef, siteIdentityDigest: policy.target.siteIdentityDigest,
    actor: policy.actor, installedImageSha256: policy.imageManifestSha256, policySha256: policyRecord.sha256, grantDigest: grantRecord.sha256 };
  const context = freeze({ operationId, authenticatedState: "INSTALLED_CURRENT", policySha256: policyRecord.sha256, grantDigest: grantRecord.sha256,
    installedImageSha256: policy.imageManifestSha256, binding, bindingDigest: w5.bindingDigest, releaseTarget, candidate: policy.candidate, cli: policy.cli,
    target: policy.target, grant: grantRecord.value, w3Candidate: w3, preparePayload: w5.payload, license: policy.license,
    paths: { policyRoot, stateRoot, coordinationRoot: RC_PUBLICATION_STATE_ROOT_V1, commandsRoot, evidenceRoot: path.join(stateRoot, "evidence"), reviewDocsConfig: path.join(policyRoot, "review-docs.json"), qualificationConfig: path.join(policyRoot, "qualification.json") } });
  observations.push(exportRecord, approval, grantRecord, ownerRecord);
  contexts.set(context, { observations, policy, imageTreeRecords, imageTreeBinding, extraObservations: new Map() });
  await assertInstalledRcPublicationContextCurrentV1(context);
  return context;
}
export function assertInstalledRcPublicationContextV1(context) {
  if (!context || !contexts.has(context)) hold("ERC_CONTEXT", "Publication requires an actual installed authority context, never a caller clone");
  return context;
}
export async function assertInstalledRcPublicationContextCurrentV1(context) {
  assertInstalledRcPublicationContextV1(context); const data = contexts.get(context);
  assertInvocation(context.operationId, data.policy);
  assertInstalledRcSourceGitScopeV1(context.cli.git, context.operationId);
  await assertCurrentRcSourceGitV1();
  if (timestamp(context.grant.expiresAt) <= Date.now()) hold("ERC_GRANT_EXPIRED", "Staged publication grant expired");
  for (const previous of [...data.observations, ...data.extraObservations.values()]) {
    const current = await observeRootOwnedRuntimeFileV2(previous.file, { maxBytes: previous.limit, exactMode: previous.mode ?? null, executable: previous.executable ?? false });
    if (current.sha256 !== previous.sha256 || !same(current.identity, previous.identity)) hold("ERC_INSTALLED_DRIFT", "Installed authority/image/CLI/trust input changed");
  }
  let currentImageTree;
  try { currentImageTree = await observeRuntimeSourceTreeV2({ sourceRoot: IMAGE_ROOT, treeRecords: data.imageTreeRecords }); }
  catch { hold("ERC_IMAGE_SOURCE", "Installed image namespace changed after candidate binding"); }
  if (currentImageTree.sourceInventoryDigest !== data.imageTreeBinding.sourceInventoryDigest ||
      currentImageTree.sourceSnapshotDigest !== data.imageTreeBinding.sourceSnapshotDigest) {
    hold("ERC_IMAGE_SOURCE", "Installed image namespace changed after candidate binding");
  }
  return context;
}
export async function revalidateInstalledRcProjectionV1(context) {
  await assertInstalledRcPublicationContextCurrentV1(context);
  const bytes = await readBoundedRuntimeFileV2(path.join(context.paths.policyRoot, "export-manifest.json"), 8 * 1024 * 1024);
  const observed = await verifyPublicSourceExportV2({ sourceRepository: context.candidate.privateRoot, manifestBytes: bytes, outputDirectory: context.candidate.publicRoot });
  for (const key of ["publicCandidateSha", "publicTreeOid", "privateSourceSha", "privateSourceTreeOid", "exportManifestDigest", "exportDigest", "approvalArtifactSha256", "moduleClosureReceiptDigest"]) if (observed[key] !== context.w3Candidate[key]) hold("ERC_SOURCE_DRIFT", "Actual W3 source/object graph changed since installed admission");
  return context.w3Candidate;
}
export async function readInstalledRcAdapterConfigV1(context, id) {
  return (await readInstalledRcAdapterConfigRecordV1(context, id)).value;
}
export async function readInstalledRcAdapterConfigRecordV1(context, id) {
  assertInstalledRcPublicationContextV1(context);
  const file = id === "review-docs" ? context.paths.reviewDocsConfig : id === "qualification" ? context.paths.qualificationConfig : null;
  if (!file) hold("ERC_ADAPTER_CONFIG", "Unknown fixed RC adapter config");
  const record = await protectedJson(file);
  if (record.value.operationId !== context.operationId || record.value.bindingDigest !== context.bindingDigest) hold("ERC_ADAPTER_BINDING", "Installed adapter config belongs to another operation/candidate/grant");
  const prior = contexts.get(context).extraObservations.get(file);
  if (prior && (prior.sha256 !== record.sha256 || !same(prior.identity, record.identity))) hold("ERC_ADAPTER_DRIFT", "Fixed adapter config changed within this installed invocation");
  contexts.get(context).extraObservations.set(file, record);
  return Object.freeze({ value: freeze(record.value), bytes: Buffer.from(record.bytes), sha256: record.sha256, identity: Object.freeze({ ...record.identity }) });
}
export async function readInstalledRcRightsInputsV1(context, scope) {
  assertInstalledRcPublicationContextV1(context);
  if (!["public-source", "github-release"].includes(scope)) hold("ERC_RIGHTS_SCOPE", "Unknown distribution scope");
  const policy = await protectedObservation(path.join(context.paths.policyRoot, "rights-policy.json"), 64 * 1024);
  if (policy.sha256 !== contexts.get(context).policy.rightsPolicySha256) hold("ERC_RIGHTS_POLICY", "Dedicated rights policy differs from installed pin");
  const envelope = await protectedObservation(path.join(context.paths.policyRoot, `rights-${scope}.json`), 2 * 1024 * 1024);
  const value = parseCanonical(envelope.bytes); const files = value?.payload?.files;
  if (!Array.isArray(files) || !files.length || files.length > 4098) hold("ERC_RIGHTS_RECORDS", "Signed rights record index is absent or too large");
  const privateRecords = new Map(); let total = 0;
  for (const digest of new Set(files.map(file => file.privateRecordSha256))) {
    validSha(digest); const observed = await protectedObservation(path.join(context.paths.policyRoot, "private-records", `${digest}.json`), 16 * 1024 * 1024, 0o600);
    total += observed.bytes.length; if (total > 64 * 1024 * 1024 || observed.sha256 !== digest) hold("ERC_RIGHTS_RECORDS", "Private rights record bytes differ or exceed bounds");
    privateRecords.set(digest, observed.bytes); contexts.get(context).extraObservations.set(observed.file, observed);
  }
  for (const record of [policy, envelope]) contexts.get(context).extraObservations.set(record.file, record);
  return { policyBytes: Buffer.from(policy.bytes), envelopeBytes: Buffer.from(envelope.bytes), privateRecords };
}

// License carriers live under the protected public Git metadata directory.
// Pin both their bytes and physical identity before the license gate reads them;
// the context's normal current-state check reobserves them before every effect.
export async function readInstalledRcLicenseCarrierV1(context, fileKey) {
  assertInstalledRcPublicationContextV1(context);
  const fields = {
    inventoryPath: ["inventorySha256", 8 * 1024 * 1024],
    outerBindingPath: ["outerBindingSha256", 2 * 1024 * 1024],
    artifactPath: ["artifactSha256", 32 * 1024 * 1024]
  };
  if (!Object.hasOwn(fields, fileKey)) hold("ERC_LICENSE_INPUT", "Unknown installed license carrier");
  const [shaKey, limit] = fields[fileKey];
  const file = path.join(context.candidate.publicRoot, context.license[fileKey]);
  const observed = await protectedObservation(file, limit);
  if (observed.sha256 !== context.license[shaKey]) hold("ERC_LICENSE_INPUT", "Protected license carrier differs from its installed pin");
  const prior = contexts.get(context).extraObservations.get(file);
  if (prior && (prior.sha256 !== observed.sha256 || !same(prior.identity, observed.identity))) {
    hold("ERC_LICENSE_INPUT_DRIFT", "Protected license carrier identity changed within the installed operation");
  }
  contexts.get(context).extraObservations.set(file, observed);
  return Buffer.from(observed.bytes);
}

function environment() {
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_EXEC_PATH: RC_SOURCE_GIT_EXEC_PATH_V1 };
  for (const key of ["HOME", "GH_TOKEN", "GITHUB_TOKEN"]) if (typeof process.env[key] === "string") env[key] = process.env[key];
  return env;
}
function persistOwnedCommand(file, record) {
  const bytes = canonicalJson(record);
  if (Buffer.byteLength(bytes) > 64 * 1024) hold("ERC_COMMAND_LEDGER", "Owned command ledger exceeds its private finite bound");
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  const directory = openSync(path.dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
// Fixed installed Node keeper. The CLI is never the detached group leader.
// Only this live leader signals its own group (PID 0); the publisher and ledger
// reader never signal a numeric PID/PGID, including after the native handle exits.
const RC_COMMAND_KEEPER_V1 = String.raw`/* BW_FIXED_INSTALLED_RC_COMMAND_KEEPER_V1 */
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const parent = process.ppid;
const PS_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' };
if (process.getuid() !== 0 || process.execArgv.length !== 3 || process.execArgv[0] !== '--input-type=commonjs' || process.execArgv[1] !== '-e') throw new Error('Installed RC keeper requires its fixed root runtime');
let self = null, owned = false, record = null, file = null, target = null;
let cleaning = false, targetClosed = false, cleaned = false, forced = false, outputBytes = 0;
let forceTimer = null, pollTimer = null, releaseTimer = null;
const canonical = value => JSON.stringify(value, function(key, item) {
  return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item;
});
function persist() {
  if (!record) return;
  const bytes = canonical(record);
  if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error('Owned command ledger exceeds bound');
  const temporary = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function send(body) { if (process.connected) { try { process.send(body, () => {}); } catch {} } }
function unknown() {
  owned = false; forced = true;
  clearTimeout(forceTimer); clearTimeout(pollTimer);
  if (record) { record.state = 'OWNERSHIP_UNKNOWN'; record.cleanupVerified = false; record.stopReason = 'OWNERSHIP_UNKNOWN'; try { persist(); } catch {} }
  send({ kind: 'RcCommandKeeperFaultV1', reason: 'OWNERSHIP_UNKNOWN' });
  process.exit(1); // Unknown identity grants no signal to any group.
}
async function members() {
  const observation = await new Promise((resolve, reject) => {
    let observer;
    observer = execFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { env: PS_ENV, timeout: 1000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve({ stdout, observerPid: observer.pid }));
  });
  const rows = String(observation.stdout).trim().split('\n').filter(Boolean).map(line => {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+[0-9]{1,2}\s+[0-9:]{8}\s+[0-9]{4})\s*$/.exec(line);
    if (!match) throw new Error('Unbounded or unknown process identity');
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startedAt: match[4].replace(/\s+/g, ' ') };
  });
  const current = rows.find(row => row.pid === process.pid);
  if (!current || current.pgid !== process.pid || (!self && current.ppid !== parent) || (self && current.startedAt !== self.startedAt)) { const error = new Error('Keeper no longer owns its original group'); error.ownershipUnknown = true; throw error; }
  if (!self) self = current;
  owned = true;
  return rows.filter(row => row.pgid === process.pid && row.pid !== process.pid && row.pid !== observation.observerPid);
}
function forceCleanup() {
  if (forced || cleaned) return;
  if (!owned || !self || self.pid !== process.pid || self.pgid !== process.pid) return unknown();
  forced = true;
  if (record) { record.state = 'FORCE_CLEANUP'; record.cleanupVerified = false; record.outputBytes = outputBytes; record.stopReason ??= 'CLEANUP_DEADLINE'; try { persist(); } catch {} }
  send({ kind: 'RcCommandKeeperFaultV1', reason: record?.stopReason ?? 'PARENT_DISCONNECTED' });
  // The issuer is still the original live leader. SIGKILL includes this keeper;
  // its eventual native close never authorizes a later numeric group signal.
  try { process.kill(0, 'SIGKILL'); } catch { unknown(); }
}
async function pollCleanup() {
  if (forced || cleaned) return;
  try {
    const remaining = await members();
    if (forced || cleaned) return;
    if (remaining.length === 0 && (!target || targetClosed)) {
      cleaned = true; clearTimeout(forceTimer);
      if (record) { record.state = 'CLEANED'; record.cleanupVerified = true; record.outputBytes = outputBytes; record.closedAt = new Date().toISOString(); persist(); }
      send({ kind: 'RcCommandKeeperCleanedV1', record });
      // The durable cleanup proof precedes release. The parent records the
      // keeper's actual exit and observes absence before accepting CLOSED.
      if (!process.connected) return process.exit(1);
      releaseTimer = setTimeout(() => process.exit(1), 1000);
      return;
    }
    pollTimer = setTimeout(pollCleanup, 50);
  } catch (error) {
    if (error.ownershipUnknown || !owned) unknown();
    else { if (record) record.stopReason ??= 'GROUP_OBSERVATION_FAILED'; forceCleanup(); }
  }
}
function stop(reason) {
  if (record && reason !== 'COMMAND_EXIT') { record.stopReason ??= reason; try { persist(); } catch {} }
  if (cleaned) return process.exit(1);
  if (cleaning || forced) return;
  cleaning = true;
  if (!owned || !self) return unknown();
  if (record) { record.state = 'CLEANING'; record.outputBytes = outputBytes; try { persist(); } catch {} }
  // SIGTERM is caught by this keeper; cooperative group members exit while
  // the original leader remains alive for the bounded cleanup observation.
  try { process.kill(0, 'SIGTERM'); } catch { return unknown(); }
  forceTimer = setTimeout(forceCleanup, 1000);
  void pollCleanup();
}
const deadline = setTimeout(() => stop('COMMAND_DEADLINE'), 60_000);
const parentWatch = setInterval(() => { if (process.ppid !== parent || !process.connected) stop('PARENT_DISCONNECTED'); }, 25);
for (const signal of ['SIGINT', 'SIGHUP', 'SIGQUIT']) process.on(signal, () => stop('PUBLISHER_CANCELLED'));
process.on('SIGTERM', () => { if (!cleaning) stop('PUBLISHER_CANCELLED'); });
process.on('disconnect', () => stop('PARENT_DISCONNECTED'));
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => stop('OUTPUT_CHANNEL_CLOSED'));
process.on('message', message => {
  if (message?.kind === 'RcCommandKeeperCancelV1') return stop('PUBLISHER_CANCELLED');
  if (message?.kind === 'RcCommandKeeperReleaseV1' && cleaned) {
    clearTimeout(releaseTimer); clearTimeout(deadline); clearInterval(parentWatch);
    return process.exit(record?.stopReason ? 1 : 0);
  }
  if (message?.kind !== 'RcCommandKeeperStartV1' || record || cleaning || !owned || !process.connected || process.ppid !== parent) return stop('KEEPER_PROTOCOL');
  const incoming = message.record;
  const expectedFile = '/private/var/db/better-workflows/rc-publication-v1/' + incoming?.operationId + '/commands/' + incoming?.commandRecordId + '.json';
  if (!incoming || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(incoming.operationId) || !/^[a-f0-9-]{36}$/.test(incoming.commandRecordId) || message.file !== expectedFile ||
      !['gh', 'git'].includes(incoming.commandId) || incoming.pid !== process.pid || incoming.ppid !== parent || incoming.pgid !== process.pid || incoming.processStartedAt !== self.startedAt ||
      !incoming.keeperRuntime || !Array.isArray(incoming.args) || incoming.args.length > 128 || incoming.args.some(arg => typeof arg !== 'string' || /[\0\r\n]/.test(arg)) || Buffer.byteLength(canonical(incoming.args)) > 16 * 1024 ||
      typeof incoming.executable !== 'string' || !path.isAbsolute(incoming.executable) || /[\0\r\n]/.test(incoming.executable) ||
      incoming.keeperRuntime.path !== process.execPath || incoming.keeperRuntime.nodeVersion !== process.versions.node || incoming.keeperRuntime.sourceSha256 !== createHash('sha256').update(process.execArgv[2]).digest('hex') ||
      !Number.isSafeInteger(incoming.maxBytes) || incoming.maxBytes < 1 || incoming.maxBytes > 4 * 1024 * 1024 || incoming.cwd !== process.cwd()) return stop('KEEPER_PROTOCOL');
  record = incoming; file = message.file;
  record.state = 'DISPATCHING';
  try { persist(); } catch { return stop('LEDGER_UNAVAILABLE'); }
  try { target = spawn(record.executable, record.args, { cwd: record.cwd, env: process.env, detached: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { record.commandExit = { code: null, signal: null, spawnError: 'SPAWN_FAILED' }; targetClosed = true; return stop('COMMAND_SPAWN_FAILED'); }
  const capture = destination => bytes => {
    outputBytes += bytes.length;
    if (outputBytes > record.maxBytes) { stop('OUTPUT_LIMIT'); target.stdout.destroy(); target.stderr.destroy(); return; }
    if (!destination.write(bytes)) { const source = destination === process.stdout ? target.stdout : target.stderr; source.pause(); destination.once('drain', () => source.resume()); }
  };
  target.stdout.on('data', capture(process.stdout)); target.stderr.on('data', capture(process.stderr));
  target.stdin.on('error', () => {});
  target.on('error', () => { record.commandExit = { code: null, signal: null, spawnError: 'SPAWN_FAILED' }; stop('COMMAND_SPAWN_FAILED'); });
  target.on('exit', (code, signal) => { record.commandExit = { code, signal, spawnError: null }; stop('COMMAND_EXIT'); });
  target.on('close', (code, signal) => { targetClosed = true; record.commandExit ??= { code, signal, spawnError: null }; if (!cleaning) stop('COMMAND_EXIT'); });
  record.targetPid = target.pid ?? null; record.targetPpid = process.pid; record.targetPgid = process.pid;
  record.targetStartedAt = new Date().toISOString(); record.targetStartSource = 'NATIVE_SPAWN_OBSERVED'; record.state = 'STARTED';
  try { persist(); } catch { return stop('LEDGER_UNAVAILABLE'); }
  send({ kind: 'RcCommandKeeperStartedV1', targetPid: record.targetPid });
  process.stdin.pipe(target.stdin);
});
void members().then(remaining => { if (remaining.length) return unknown(); if (!cleaning && process.connected) send({ kind: 'RcCommandKeeperReadyV1', identity: self }); }).catch(unknown);
`;
// End fixed installed RC keeper.

const PS_ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" });
async function observeRcCommandGroupsV1() {
  const before = await observeRootOwnedRuntimeFileV2("/bin/ps", { maxBytes: 16 * 1024 * 1024, executable: true });
  const output = await new Promise((resolve, reject) => execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, env: PS_ENVIRONMENT }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const after = await observeRootOwnedRuntimeFileV2("/bin/ps", { maxBytes: 16 * 1024 * 1024, executable: true });
  if (before.sha256 !== after.sha256 || !same(before.identity, after.identity)) hold("ERC_CLEANUP_UNKNOWN", "OS process observer changed during reconciliation");
  return String(output).trim().split("\n").filter(Boolean).map(line => {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+[0-9]{1,2}\s+[0-9:]{8}\s+[0-9]{4})\s*$/.exec(line);
    if (!match) hold("ERC_CLEANUP_UNKNOWN", "OS process ownership observation is unreadable");
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startedAt: match[4].replace(/\s+/g, " ") };
  });
}
function assertRcCommandRecordV1(context, record, commandRecordId) {
  if (!record || typeof record !== "object" || record.schemaVersion !== 1 || record.kind !== "InstalledRcOwnedCommandV1" || record.commandRecordId !== commandRecordId ||
      record.operationId !== context.operationId || record.bindingDigest !== context.bindingDigest || !["gh", "git"].includes(record.commandId) ||
      record.executable !== context.cli[record.commandId].path || record.executableSha256 !== context.cli[record.commandId].sha256 ||
      record.keeperRuntime?.path !== context.cli.node.path || record.keeperRuntime.sha256 !== context.cli.node.sha256 || record.keeperRuntime.sourceSha256 !== sha256(RC_COMMAND_KEEPER_V1) ||
      !same(record.keeperRuntime.argv, ["--input-type=commonjs", "-e", RC_COMMAND_KEEPER_V1]) ||
      !Array.isArray(record.args) || record.args.length > 128 || record.args.some(arg => typeof arg !== "string" || /[\0\r\n]/.test(arg)) || Buffer.byteLength(canonicalJson(record.args)) > 16 * 1024 ||
      !Number.isSafeInteger(record.maxBytes) || record.maxBytes < 1 || record.maxBytes > MAX_JSON || !Number.isSafeInteger(record.outputBytes) || record.outputBytes < 0 ||
      !absolute(record.cwd) || ![IMAGE_ROOT, context.candidate.publicRoot].includes(record.cwd) ||
      !Number.isSafeInteger(record.publisherPid) || record.publisherPid <= 1 || record.ppid !== record.publisherPid ||
      (record.pid !== null && (!Number.isSafeInteger(record.pid) || record.pid <= 1 || record.pgid !== record.pid || typeof record.processStartedAt !== "string"))) {
    hold("ERC_CLEANUP_UNKNOWN", "Command ownership record is not for this exact installed keeper/operation");
  }
  return record;
}
export async function rcPublicationAssertOwnedCleanupV1(context) {
  assertInstalledRcPublicationContextV1(context);
  const entries = await readdir(context.paths.commandsRoot, { withFileTypes: true });
  if (entries.length > 4096) hold("ERC_CLEANUP", "Owned command ledger exceeded its finite bound");
  const closed = [], groups = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9-]{36}\.json$/.test(entry.name)) hold("ERC_CLEANUP_UNKNOWN", "Owned command ledger has an incomplete or unknown entry");
    const observed = await protectedObservation(path.join(context.paths.commandsRoot, entry.name), 64 * 1024, 0o600);
    const record = assertRcCommandRecordV1(context, parseCanonical(observed.bytes), entry.name.slice(0, -5));
    // Even an absent/reused numeric group cannot turn an incomplete ownership
    // receipt into CLOSED. This reader has no cleanup or signalling authority.
    if (record.state !== "CLOSED" || record.cleanupVerified !== true || record.pid === null ||
        record.outputBytes > record.maxBytes || !Number.isSafeInteger(record.targetPid) || record.targetPid <= 1 || record.targetPpid !== record.pid || record.targetPgid !== record.pgid ||
        !record.commandExit || !(Number.isInteger(record.commandExit.code) && record.commandExit.signal === null || record.commandExit.code === null && /^SIG[A-Z0-9]+$/.test(record.commandExit.signal ?? "")) ||
        record.commandExit.spawnError !== null || !record.keeperExit || !Number.isInteger(record.keeperExit.code) || record.keeperExit.signal !== null) {
      hold("ERC_CLEANUP_UNKNOWN", "Previous command has no complete stable-keeper cleanup/actual-exit receipt");
    }
    groups.push(record.pgid); closed.push(observed.sha256);
  }
  if (groups.length) {
    const rows = await observeRcCommandGroupsV1();
    if (rows.some(row => groups.includes(row.pgid))) hold("ERC_CLEANUP_UNKNOWN", "A recorded group number is present; ownership is unknown and no signal is authorized");
  }
  return Object.freeze({ ownedCleanupVerified: true, commandLedgerDigest: digestObject(closed.sort()) });
}
// Bounded owned subprocess transport. No caller-selected executable or env.
async function executeInstalledRcCommandV1(context, commandId, args, { input = null, cwd = IMAGE_ROOT, maxBytes = 4 * 1024 * 1024, providerEffect = false } = {}) {
  assertInstalledRcPublicationContextV1(context);
  assertInstalledRcSourceGitScopeV1(context.cli.git, context.operationId);
  await assertCurrentRcSourceGitV1();
  if (!["gh", "git"].includes(commandId) || !Array.isArray(args) || args.length > 128 || args.some(arg => typeof arg !== "string" || /[\0\r\n]/.test(arg)) ||
      Buffer.byteLength(canonicalJson(args)) > 16 * 1024 || ![IMAGE_ROOT, context.candidate.publicRoot].includes(cwd) ||
      (input !== null && (typeof input !== "string" || Buffer.byteLength(input) > MAX_JSON)) || typeof providerEffect !== "boolean" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_JSON) hold("ERC_COMMAND", "Invalid bounded internal installed command");
  const pin = context.cli[commandId];
  const [before, nodeBefore] = await Promise.all([
    observeRootOwnedRuntimeFileV2(pin.path, { maxBytes: 512 * 1024 * 1024, executable: true }),
    observeRootOwnedRuntimeFileV2(context.cli.node.path, { maxBytes: 512 * 1024 * 1024, executable: true })
  ]);
  if (before.sha256 !== pin.sha256 || nodeBefore.sha256 !== context.cli.node.sha256) hold("ERC_CLI", "Installed command/keeper runtime differs before dispatch");
  const commandRecordId = randomUUID(), commandFile = path.join(context.paths.commandsRoot, `${commandRecordId}.json`);
  let ownership = { schemaVersion: 1, kind: "InstalledRcOwnedCommandV1", commandRecordId, operationId: context.operationId, bindingDigest: context.bindingDigest,
    commandId, executable: pin.path, executableSha256: pin.sha256, executableIdentity: before.identity, args, cwd,
    stdinSha256: input === null ? null : sha256(Buffer.from(input)), startedAt: new Date().toISOString(), publisherPid: process.pid, publisherPpid: process.ppid,
    pid: null, ppid: process.pid, pgid: null, processStartedAt: null,
    keeperRuntime: { path: context.cli.node.path, sha256: context.cli.node.sha256, identity: nodeBefore.identity, nodeVersion: process.versions.node, sourceSha256: sha256(RC_COMMAND_KEEPER_V1), argv: ["--input-type=commonjs", "-e", RC_COMMAND_KEEPER_V1] },
    targetPid: null, targetPpid: null, targetPgid: null, targetStartedAt: null, targetStartSource: null, commandExit: null, keeperExit: null,
    outputBytes: 0, maxBytes, state: "PLANNED", stopReason: null, cleanupVerified: false, closedAt: null };
  persistOwnedCommand(commandFile, ownership); // Durable before any keeper/CLI spawn.
  let result;
  try { result = await new Promise((resolve, reject) => {
    if (providerEffect) markInstalledRcSourceGitEffectStartedV1(context.cli.git, context.operationId);
    const child = spawn(context.cli.node.path, ownership.keeperRuntime.argv, { cwd, env: environment(), detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    let stdout = [], stderr = [], size = 0, failed = null, ready = false, released = false;
    const cancel = () => { if (child.connected) { try { child.send({ kind: "RcCommandKeeperCancelV1" }, () => {}); } catch {} } };
    const fail = error => { failed ??= error; cancel(); };
    const interrupted = () => fail(new RcPublicationHoldErrorV1("ERC_COMMAND_CANCELLED", "Installed publisher command was cancelled", "UNKNOWN"));
    const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
    for (const signal of signals) process.on(signal, interrupted);
    const timer = setTimeout(() => fail(new RcPublicationHoldErrorV1("ERC_COMMAND_DEADLINE", "Installed keeper did not close within its bounded deadline", "UNKNOWN")), 62_000);
    const capture = destination => bytes => {
      size += bytes.length;
      if (size > maxBytes) fail(new RcPublicationHoldErrorV1("ERC_COMMAND_OUTPUT", "Installed command output exceeded bound", "UNKNOWN"));
      else destination.push(bytes);
    };
    child.stdout.on("data", capture(stdout)); child.stderr.on("data", capture(stderr)); child.stdin.on("error", () => {});
    child.on("error", () => fail(new RcPublicationHoldErrorV1("ERC_COMMAND_KEEPER", "Pinned installed keeper could not execute", "UNKNOWN")));
    child.on("message", message => {
      try {
        if (message?.kind === "RcCommandKeeperReadyV1" && !ready) {
          const identity = message.identity;
          if (identity?.pid !== child.pid || identity.ppid !== process.pid || identity.pgid !== child.pid || typeof identity.startedAt !== "string") throw new Error("Unknown keeper identity");
          ready = true; ownership.pid = child.pid; ownership.pgid = child.pid; ownership.processStartedAt = identity.startedAt; ownership.state = "KEEPER_READY";
          persistOwnedCommand(commandFile, ownership); // CLI is still unspawned.
          if (!failed && child.connected) child.send({ kind: "RcCommandKeeperStartV1", file: commandFile, record: ownership }, () => {});
        } else if (message?.kind === "RcCommandKeeperStartedV1" && ready && !released) {
          if (!Number.isSafeInteger(message.targetPid) || message.targetPid <= 1) throw new Error("Unknown command native handle");
        } else if (message?.kind === "RcCommandKeeperCleanedV1" && ready && !released) {
          const record = assertRcCommandRecordV1(context, message.record, commandRecordId);
          if (record.pid !== child.pid || record.state !== "CLEANED" || !record.cleanupVerified || !record.commandExit || record.maxBytes !== maxBytes ||
              !same(record.args, args) || record.stdinSha256 !== ownership.stdinSha256) throw new Error("Unknown keeper cleanup receipt");
          released = true; ownership = record;
          if (record.stopReason) failed ??= new RcPublicationHoldErrorV1("ERC_COMMAND_STOPPED", "Installed command stopped before a successful transport result", "UNKNOWN");
          if (child.connected) child.send({ kind: "RcCommandKeeperReleaseV1" }, () => {});
        } else if (message?.kind === "RcCommandKeeperFaultV1") fail(new RcPublicationHoldErrorV1("ERC_COMMAND_CLEANUP", "Installed keeper cleanup is unknown", "UNKNOWN"));
        else throw new Error("Unknown keeper protocol message");
      } catch { fail(new RcPublicationHoldErrorV1("ERC_COMMAND_OWNERSHIP", "Installed command ownership transition is unknown", "UNKNOWN")); }
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer); for (const item of signals) process.off(item, interrupted);
      // Native handle is closed: no kill(), PID-0 probe or numeric group signal.
      // Only protected ledger and bounded OS observations can establish absence.
      try {
        const record = assertRcCommandRecordV1(context, parseCanonical((await protectedObservation(commandFile, 64 * 1024, 0o600)).bytes), commandRecordId);
        const rows = await observeRcCommandGroupsV1();
        const cleanupVerified = released && record.state === "CLEANED" && record.cleanupVerified === true && record.pid === child.pid &&
          !rows.some(row => row.pgid === record.pgid) && signal === null && Number.isInteger(code);
        record.state = "CLOSED"; record.cleanupVerified = cleanupVerified; record.keeperExit = { code, signal }; record.closedAt = new Date().toISOString();
        persistOwnedCommand(commandFile, record); ownership = record;
        if (!cleanupVerified) failed ??= new RcPublicationHoldErrorV1("ERC_COMMAND_CLEANUP", "Owned keeper/group absence is unverified; no retry is authorized", "UNKNOWN");
        if (code !== 0 || signal !== null) failed ??= new RcPublicationHoldErrorV1("ERC_COMMAND_KEEPER", "Installed keeper did not complete its acknowledged release", "UNKNOWN");
      } catch { failed ??= new RcPublicationHoldErrorV1("ERC_COMMAND_CLEANUP", "Owned command closure could not be durably reconciled", "UNKNOWN"); }
      if (failed) reject(failed);
      else resolve({ code: ownership.commandExit.code, signal: ownership.commandExit.signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.end(input === null ? undefined : input);
  }); } catch (error) {
    if (providerEffect) { error.status = "UNKNOWN"; error.reconciliationRequired = true; }
    throw error;
  }
  try {
    const [after, nodeAfter] = await Promise.all([
      observeRootOwnedRuntimeFileV2(pin.path, { maxBytes: 512 * 1024 * 1024, executable: true }),
      observeRootOwnedRuntimeFileV2(context.cli.node.path, { maxBytes: 512 * 1024 * 1024, executable: true })
    ]);
    if (after.sha256 !== before.sha256 || !same(after.identity, before.identity) || nodeAfter.sha256 !== nodeBefore.sha256 || !same(nodeAfter.identity, nodeBefore.identity)) hold("ERC_CLI_DRIFT", "Installed command/keeper runtime changed while executing", "UNKNOWN");
    await assertCurrentRcSourceGitV1();
  } catch (error) {
    if (providerEffect || error.status === "UNKNOWN") {
      error.status = "UNKNOWN"; error.reconciliationRequired = true;
      error.commandResult = Object.freeze({ code: result.code, signal: result.signal });
    }
    throw error;
  }
  return result;
}
function parseResponse(output) {
  const match = /^(?:HTTP\/\d(?:\.\d)?\s+)([1-5][0-9]{2})[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(output);
  if (!match) hold("ERC_PROVIDER_RESPONSE", "Bounded provider response has no authenticated HTTP status");
  let body; try { body = match[2].trim() === "" ? null : JSON.parse(match[2]); } catch { hold("ERC_PROVIDER_RESPONSE", "Provider response is not bounded JSON"); }
  return { status: Number(match[1]), body };
}
export async function rcPublicationGithubReadV1(context, endpoint) {
  assertInstalledRcPublicationContextV1(context);
  const prefix = `repos/${context.target.repository.name}`;
  if (typeof endpoint !== "string" || endpoint.length > 1024 || /[\s\0#\\]/.test(endpoint) || endpoint.includes("..") || endpoint.includes(":") ||
      !(endpoint === "user" || endpoint === prefix || endpoint.startsWith(`${prefix}/`))) hold("ERC_PROVIDER_SCOPE", "Read transport permits only the exact bound repository/actor");
  const response = await executeInstalledRcCommandV1(context, "gh", ["api", endpoint, "--include", "--method", "GET", "--hostname", "github.com", "--header", "X-GitHub-Api-Version: 2022-11-28"]);
  const parsed = parseResponse(response.stdout);
  if (parsed.status === 404) return null;
  if (response.code !== 0 || parsed.status !== 200) hold("ERC_PROVIDER_READ", "Exact provider read did not complete successfully");
  return parsed.body;
}
export async function rcPublicationGithubAllRefsV1(context) {
  assertInstalledRcPublicationContextV1(context);
  const prefix = `repos/${context.target.repository.name}`;
  const response = await executeInstalledRcCommandV1(context, "gh", ["api", `${prefix}/git/matching-refs/?per_page=100`, "--include", "--method", "GET", "--hostname", "github.com"]);
  const parsed = parseResponse(response.stdout);
  if (parsed.status === 409 && parsed.body?.message === "Git Repository is empty.") {
    const [branches, tags, main] = await Promise.all([
      rcPublicationGithubReadV1(context, `${prefix}/branches?per_page=100`),
      rcPublicationGithubReadV1(context, `${prefix}/tags?per_page=100`),
      rcPublicationGithubReadV1(context, `${prefix}/git/ref/heads/main`)
    ]);
    if (Array.isArray(branches) && !branches.length && Array.isArray(tags) && !tags.length && main === null) return [];
  }
  if (response.code !== 0 || parsed.status !== 200 || !Array.isArray(parsed.body) || parsed.body.length > 2) hold("ERC_REFS", "Exact publication repository refs are unavailable or conflicting");
  return parsed.body;
}
export function deriveRcPublicationReleaseBodyV1(bytes, releaseTarget, candidateSha) {
  let manifest; try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { hold("ERC_CHANGELOG", "Actual committed changelog manifest is invalid"); }
  const target = assertProductReleaseTargetManifestV1(manifest);
  if (target.channel !== "rc" || target.releaseTargetDigest !== releaseTarget.releaseTargetDigest || !SHA40.test(candidateSha ?? "") ||
      !Array.isArray(manifest.breakingChanges) || !manifest.breakingChanges.length || manifest.breakingChanges.length > 100 ||
      manifest.breakingChanges.some(change => typeof change !== "string" || !change.trim() || change.length > 4096 || /[\0\r]/.test(change))) hold("ERC_CHANGELOG", "Genuine exact-RC changelog is absent or differs from the publication");
  return ["Controlled release candidate for the accepted macOS Auto scope.", "This prerelease does not establish GA acceptance or V5 completion.",
    "GA retains 30 natural days, 20 consecutive eligible starts, and three repositories.", "", `Exact public source: ${candidateSha}`, "", "## Changes", "", ...manifest.breakingChanges.map(change => `- ${change}`)].join("\n");
}
// The fixed image builds the three commands. No endpoint, payload, credential,
// approval or executable is selected by a production caller.
export async function rcPublicationDispatchEffectV1(context, attemptId, effect) {
  await assertInstalledRcPublicationContextCurrentV1(context);
  const steps = { "create-source-main": "sourcepublished", "create-rc-tag": "tagcreated", "create-rc-prerelease": "released" };
  const step = steps[effect];
  const journal = await readW5PublicationJournalV1({ stateRoot: context.paths.stateRoot, operationId: context.operationId });
  if (!step || !context.grant.effects.includes(effect) || journal.replay.bindingDigest !== context.bindingDigest || journal.replay.pending?.status !== "INTENT" ||
      journal.replay.pending.step !== step || journal.replay.pending.attemptId !== attemptId) hold("ERC_INTENT", "Exact valid staged grant and durable current intent are required before dispatch");
  if (effect === "create-source-main") {
    const response = await executeInstalledRcCommandV1(context, "git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c",
      `credential.helper=!${context.cli.gh.path} auth git-credential`, "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "http.followRedirects=false", "push", "--porcelain", `https://github.com/${context.target.repository.name}.git`,
      `${context.candidate.publicCandidateSha}:${context.target.sourceRef}`], { cwd: context.candidate.publicRoot, providerEffect: true });
    return { code: response.code, signal: response.signal, payloadDigest: digestObject({ repository: context.target.repository, ref: context.target.sourceRef, publicCandidateSha: context.candidate.publicCandidateSha, createOnly: true }) };
  }
  const prefix = `repos/${context.target.repository.name}`;
  let endpoint, payload;
  if (effect === "create-rc-tag") {
    endpoint = `${prefix}/git/refs`;
    payload = { ref: context.target.tagRef, sha: context.candidate.publicCandidateSha };
  } else {
    endpoint = `${prefix}/releases`;
    const bytes = await readBoundedRuntimeFileV2(path.join(context.candidate.publicRoot, context.license.releaseBodyPath), 128 * 1024);
    if (sha256(bytes) !== context.license.releaseBodySha256) hold("ERC_CHANGELOG", "The exact publication body changed");
    const body = deriveRcPublicationReleaseBodyV1(bytes, context.releaseTarget, context.candidate.publicCandidateSha);
    payload = { tag_name: context.releaseTarget.releaseTag, target_commitish: context.candidate.publicCandidateSha, name: context.releaseTarget.releaseName,
      body, draft: false, prerelease: true, make_latest: "false", generate_release_notes: false };
  }
  const response = await executeInstalledRcCommandV1(context, "gh", ["api", endpoint, "--include", "--method", "POST", "--hostname", "github.com", "--header", "X-GitHub-Api-Version: 2022-11-28", "--input", "-"], { input: canonicalJson(payload), providerEffect: true });
  let parsed;
  try { parsed = parseResponse(response.stdout); }
  catch (error) { error.status = "UNKNOWN"; throw error; }
  return { code: response.code, httpStatus: parsed.status, payloadDigest: digestObject(payload) };
}
export async function rcPublicationVerifyGithubAttestationV1(context, { file, workflow, runId, runAttempt }) {
  assertInstalledRcPublicationContextV1(context);
  if (!absolute(file) || !file.startsWith(`${context.paths.evidenceRoot}/`) || ![context.target.runtimeWorkflowPath, context.target.hostWorkflowPath, context.target.qaWorkflowPath].includes(workflow) ||
      !DECIMAL.test(runId ?? "") || !DECIMAL.test(runAttempt ?? "")) hold("ERC_ATTESTATION_SCOPE", "Attestation verifier requires fixed operation evidence/workflow/run attempt");
  const record = await protectedObservation(file, 4 * 1024 * 1024, 0o600);
  const repository = context.target.repository.name, repoUrl = `https://github.com/${repository}`, workflowUri = `${repoUrl}/${workflow}@refs/heads/main`;
  const output = await executeInstalledRcCommandV1(context, "gh", ["attestation", "verify", file, "--repo", repository, "--signer-workflow", `${repository}/${workflow}`,
    "--cert-identity", workflowUri, "--cert-oidc-issuer", "https://token.actions.githubusercontent.com", "--predicate-type", "https://slsa.dev/provenance/v1", "--deny-self-hosted-runners", "--format", "json"]);
  if (output.code !== 0) hold("ERC_ATTESTATION", "Actual GitHub attestation signature verification failed");
  let entries; try { entries = JSON.parse(output.stdout); } catch { hold("ERC_ATTESTATION", "Actual verified provenance is not JSON"); }
  const matched = Array.isArray(entries) && entries.length <= 30 && entries.find(entry => {
    const v = entry?.verificationResult, c = v?.signature?.certificate, s = v?.statement;
    return c?.issuer === "https://token.actions.githubusercontent.com" && c.subjectAlternativeName === workflowUri && c.buildSignerURI === workflowUri &&
      c.buildSignerDigest === context.candidate.publicCandidateSha && c.sourceRepositoryURI === repoUrl && c.sourceRepositoryDigest === context.candidate.publicCandidateSha &&
      c.sourceRepositoryRef === "refs/heads/main" && c.sourceRepositoryIdentifier === context.target.repository.id && c.sourceRepositoryVisibilityAtSigning === "public" &&
      (workflow === context.target.hostWorkflowPath ? ["push", "workflow_dispatch"].includes(c.buildTrigger) : c.buildTrigger === (workflow === context.target.runtimeWorkflowPath ? "push" : "workflow_dispatch")) &&
      c.runInvocationURI === `${repoUrl}/actions/runs/${runId}/attempts/${runAttempt}` && c.runnerEnvironment === "github-hosted" &&
      Array.isArray(v.verifiedTimestamps) && v.verifiedTimestamps.length && s?._type === "https://in-toto.io/Statement/v1" && s.predicateType === "https://slsa.dev/provenance/v1" &&
      s.subject?.some(subject => subject.digest?.sha256 === record.sha256);
  });
  if (!matched || sha256(await readBoundedRuntimeFileV2(file, 4 * 1024 * 1024)) !== record.sha256) hold("ERC_ATTESTATION_BINDING", "Verified provenance/file differs from exact public candidate/workflow/run/attempt");
  contexts.get(context).extraObservations.set(file, record);
  return freeze({ artifactSha256: record.sha256, verificationDigest: sha256(output.stdout), certificateBindingDigest: digestObject(matched.verificationResult.signature.certificate), authenticatedState: "VERIFIED_CURRENT" });
}
