import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  apacheClosureVerifierFromScan,
  scanPackage
} from "../../../../packages/better-workflows-wire/scripts/closure-check.mjs";
import {
  verifyLicenseInventory
} from "./license-inventory-v1.mjs";
import { assertNoSymlinkUnder, digestObject, ensurePrivateDir, safeJoin, sha256 } from "./core.mjs";
import { canonicalSourceRoot, runSourceGit } from "./git.mjs";
import { verifyReleaseLicenseArchive } from "./release-license-artifact-v1.mjs";
import {
  deriveReleaseProductSubject,
  releaseSubjectMetadata,
  revalidateReleaseProductSubject
} from "./release-license-subject-v1.mjs";
import { createRightsClearanceRequestV1 } from "./rights-clearance-request-v1.mjs";

export const RELEASE_LICENSE_GATE_SCHEMA_VERSION = 1;
export const RELEASE_LICENSE_GATE_KIND = "better-workflows-release-license-gate";
export const RELEASE_LICENSE_INVENTORY_ENV = "SBW_LICENSE_INVENTORY";
export const RELEASE_LICENSE_OUTER_BINDING_ENV = "SBW_LICENSE_OUTER_BINDING";
export const RELEASE_LICENSE_ARTIFACT_ENV = "SBW_LICENSE_ARTIFACT";
export const RELEASE_LICENSE_RECEIPT_ENV = "SBW_LICENSE_GATE_RECEIPT";
export const RELEASE_LICENSE_PACKAGE_ROOT = "packages/better-workflows-wire";
export const RELEASE_LICENSE_PACKAGE_NAME = "@better-workflows/wire";
export const RELEASE_LICENSE_BUILD_RECEIPT_PATH = "evidence/better-workflows-wire-build.json";
export const RELEASE_LICENSE_CLOSURE_RECEIPT_PATH = "evidence/better-workflows-wire-closure.json";

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\u0000).+$/;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function posixRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

async function pathComponentsAreRegular(root, target) {
  const relative = path.relative(root, path.resolve(target));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) return false;
  }
  return true;
}

function safeRelative(value) {
  return typeof value === "string" && SAFE_PATH.test(value) && !path.isAbsolute(value);
}

function baseResult({ sourceRevision = null, productVersion = null } = {}) {
  return {
    schemaVersion: RELEASE_LICENSE_GATE_SCHEMA_VERSION,
    kind: RELEASE_LICENSE_GATE_KIND,
    sourceRevision,
    productVersion,
    packageRoot: RELEASE_LICENSE_PACKAGE_ROOT,
    releaseDisposition: "HOLD",
    rightsReady: false,
    issues: []
  };
}

function hold(result, code, detail) {
  const issue = { code };
  if (detail) issue.detail = detail;
  result.issues.push(issue);
  return result;
}

function requiredSha(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!SHA40.test(normalized)) throw new Error(`${label} must be an exact lowercase commit SHA`);
  return normalized;
}

function requiredVersion(value) {
  const normalized = String(value ?? "").trim();
  if (!SEMVER.test(normalized)) throw new Error("Release license gate requires a valid product version");
  return normalized;
}

function normalizeBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return null;
}

async function readRegularFile(filePath, root = null) {
  let handle = null;
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    if (root && !(await pathComponentsAreRegular(root, filePath))) return null;
    const canonicalRoot = root ? await realpath(root) : null;
    const resolved = await realpath(filePath);
    if (canonicalRoot && !isInside(canonicalRoot, resolved)) return null;
    // Read through an opened descriptor after the canonical-boundary check so
    // a later pathname swap cannot redirect the bytes to another file.
    handle = await open(filePath, O_RDONLY | O_NOFOLLOW);
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || openedInfo.dev !== info.dev || openedInfo.ino !== info.ino) return null;
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readRelativeFile(root, relativePath) {
  if (!safeRelative(relativePath)) return null;
  const target = path.resolve(root, relativePath);
  if (!isInside(root, target)) return null;
  return readRegularFile(target, root);
}

async function readJsonInput(filePath, root = null) {
  const bytes = await readRegularFile(filePath, root);
  if (!bytes) return { bytes: null, value: null };
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return { bytes, value: null };
  }
}

function checkoutPath(root, value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const target = path.resolve(root, value);
  return isInside(root, target) ? target : null;
}

async function currentHead(cwd) {
  try {
    const result = await runSourceGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    return String(result.stdout).trim().toLowerCase();
  } catch {
    return null;
  }
}

async function committedFileBytes(cwd, sourceRevision, relativePath) {
  try {
    const result = await runSourceGit(cwd, ["show", `${sourceRevision}:${relativePath}`], {
      encoding: "buffer",
      maxBuffer: 4 * 1024 * 1024
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : null;
  } catch {
    return null;
  }
}

async function sourcePackageSnapshotIssue({ repositoryRoot, sourceRevision, packageRecords }) {
  for (const expected of packageRecords) {
    const currentBytes = await readRelativeFile(repositoryRoot, expected.path);
    if (!currentBytes || sha256(currentBytes) !== expected.sha256) {
      return { code: "PACKAGE_SNAPSHOT_DRIFT", detail: `package file changed or became unavailable: ${expected.path}` };
    }
    const committedBytes = await committedFileBytes(repositoryRoot, sourceRevision, expected.path);
    if (!committedBytes || sha256(committedBytes) !== expected.sha256) {
      return { code: "SOURCE_PACKAGE_SNAPSHOT_DRIFT", detail: `scanner package bytes are not bound to ${sourceRevision}: ${expected.path}` };
    }
  }
  return null;
}

function sourceFilesDigest(records) {
  return sha256(Buffer.from(JSON.stringify(records.map((record) => ({
    path: record.path,
    sha256: record.sha256,
    mode: record.mode,
    gitBlobSha1: record.gitBlobSha1
  }))), "utf8"));
}

function sourceTreeDigest(records) {
  return sha256(Buffer.from(JSON.stringify(records.map((record) => ({
    path: record.path,
    mode: record.mode,
    objectId: record.objectId,
    size: record.size
  }))), "utf8"));
}

function sourcePackageRecords(scan, expectedRevision) {
  const sourceRevision = String(expectedRevision ?? "").trim().toLowerCase();
  if (!isObject(scan)
      || scan.universeKind !== "git-source-tree"
      || scan.sourceRevision !== sourceRevision
      || scan.packSource !== null
      || scan.packTool !== null
      || !Array.isArray(scan.packageFiles)
      || scan.packageFiles.length !== 0
      || scan.packageFilesSha256 !== null
      || scan.verified !== true
      || scan.independent !== true
      || !SHA40.test(sourceRevision)) return null;
  for (const field of ["coreImports", "indirectCoreImports", "unresolvedDependencies", "dynamicDependencies", "pathEscapes", "syntaxErrors", "scannerErrors"]) {
    if (!Array.isArray(scan[field]) || scan[field].length !== 0) return null;
  }
  if (!isObject(scan.packageManifest)
      || scan.packageManifest.path !== `${RELEASE_LICENSE_PACKAGE_ROOT}/package.json`
      || !SHA256.test(scan.packageManifest.sha256 ?? "")
      || !Array.isArray(scan.sourceFiles)
      || scan.sourceFiles.length === 0
      || !Array.isArray(scan.sourceTreeRecords)
      || scan.sourceTreeRecords.length !== scan.sourceFiles.length
      || !SHA256.test(scan.sourceFilesSha256 ?? "")
      || !SHA256.test(scan.sourceTreeSha256 ?? "")) return null;
  const sourceFiles = scan.sourceFiles.map((record) => ({
    path: record?.path,
    sha256: record?.sha256,
    mode: record?.mode,
    gitBlobSha1: record?.gitBlobSha1
  }));
  const sortedSourceFiles = sourceFiles.slice().sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(sourceFiles) !== JSON.stringify(sortedSourceFiles)
      || sourceFiles.some((record) => !safeRelative(record.path)
        || !record.path.startsWith(`${RELEASE_LICENSE_PACKAGE_ROOT}/`)
        || !SHA256.test(record.sha256 ?? "")
        || ![0o644, 0o755].includes(record.mode)
        || !SHA40.test(record.gitBlobSha1 ?? ""))
      || new Set(sourceFiles.map((record) => record.path)).size !== sourceFiles.length
      || sourceFilesDigest(sourceFiles) !== scan.sourceFilesSha256) return null;
  const sourceTreeRecords = scan.sourceTreeRecords.map((record) => ({
    path: record?.path,
    mode: record?.mode,
    objectId: record?.objectId,
    size: record?.size
  }));
  const sortedSourceTreeRecords = sourceTreeRecords.slice().sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(sourceTreeRecords) !== JSON.stringify(sortedSourceTreeRecords)
      || sourceTreeRecords.some((record) => !safeRelative(record.path)
        || !record.path.startsWith(`${RELEASE_LICENSE_PACKAGE_ROOT}/`)
        || ![0o644, 0o755].includes(record.mode)
        || !SHA40.test(record.objectId ?? "")
        || !Number.isSafeInteger(record.size)
        || record.size < 0)
      || new Set(sourceTreeRecords.map((record) => record.path)).size !== sourceTreeRecords.length
      || sourceTreeDigest(sourceTreeRecords) !== scan.sourceTreeSha256) return null;
  const sourceTreeByPath = new Map(sourceTreeRecords.map((record) => [record.path, record]));
  const packageRecords = sourceFiles.map(({ path: filePath, sha256: fileSha256 }) => ({ path: filePath, sha256: fileSha256 }));
  if (sourceFiles.some((record) => {
    const treeRecord = sourceTreeByPath.get(record.path);
    return !treeRecord || treeRecord.mode !== record.mode || treeRecord.objectId !== record.gitBlobSha1;
  })) return null;
  if (!isObject(scan.sourceReceipt)
      || scan.sourceReceipt.path !== RELEASE_LICENSE_CLOSURE_RECEIPT_PATH
      || scan.sourceReceipt.sha256 !== scan.closureReceipt?.sha256
      || scan.sourceReceipt.universeKind !== "git-source-tree"
      || scan.sourceReceipt.sourceRevision !== sourceRevision
      || scan.sourceReceipt.sourceFilesSha256 !== scan.sourceFilesSha256
      || scan.sourceReceipt.sourceTreeSha256 !== scan.sourceTreeSha256) return null;
  const buildBytes = normalizeBytes(scan.buildReceiptBytes);
  const closureBytes = normalizeBytes(scan.closureReceiptBytes);
  if (!buildBytes || !closureBytes
      || !isObject(scan.buildReceipt)
      || !isObject(scan.closureReceipt)
      || scan.buildReceipt.path !== RELEASE_LICENSE_BUILD_RECEIPT_PATH
      || scan.closureReceipt.path !== RELEASE_LICENSE_CLOSURE_RECEIPT_PATH
      || !SHA256.test(scan.buildReceipt.sha256 ?? "")
      || !SHA256.test(scan.closureReceipt.sha256 ?? "")
      || sha256(buildBytes) !== scan.buildReceipt.sha256
      || sha256(closureBytes) !== scan.closureReceipt.sha256) return null;
  let build;
  let closure;
  try {
    build = JSON.parse(buildBytes.toString("utf8"));
    closure = JSON.parse(closureBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(build) || !isObject(closure)
      || build.kind !== "better-workflows-apache-independent-build"
      || build.packageRoot !== RELEASE_LICENSE_PACKAGE_ROOT
      || build.universeKind !== "git-source-tree"
      || build.sourceRevision !== sourceRevision
      || build.sourceFilesSha256 !== scan.sourceFilesSha256
      || build.sourceTreeSha256 !== scan.sourceTreeSha256
      || build.packageFilesSha256 !== null
      || build.packTool !== null
      || build.independent !== true
      || !Array.isArray(build.coreImports)
      || build.coreImports.length !== 0
      || !Array.isArray(build.indirectCoreImports)
      || build.indirectCoreImports.length !== 0
      || closure.kind !== "better-workflows-apache-closure"
      || closure.packageRoot !== RELEASE_LICENSE_PACKAGE_ROOT
      || closure.universeKind !== "git-source-tree"
      || closure.sourceRevision !== sourceRevision
      || closure.sourceFilesSha256 !== scan.sourceFilesSha256
      || closure.sourceTreeSha256 !== scan.sourceTreeSha256
      || !Array.isArray(closure.packageFiles)
      || closure.packageFiles.length !== 0
      || closure.packageFilesSha256 !== null
      || closure.packTool !== null
      || JSON.stringify(closure.sourceFiles) !== JSON.stringify(sourceFiles)
      || JSON.stringify(closure.sourceTreeRecords) !== JSON.stringify(sourceTreeRecords)
      || !Array.isArray(closure.coreImports)
      || closure.coreImports.length !== 0
      || !Array.isArray(closure.indirectCoreImports)
      || closure.indirectCoreImports.length !== 0) return null;
  if (!isObject(scan.apacheEvidence)
      || scan.apacheEvidence.packageRoot !== RELEASE_LICENSE_PACKAGE_ROOT
      || scan.apacheEvidence.universeKind !== "git-source-tree"
      || scan.apacheEvidence.sourceRevision !== sourceRevision
      || scan.apacheEvidence.sourceFilesSha256 !== scan.sourceFilesSha256
      || scan.apacheEvidence.sourceTreeSha256 !== scan.sourceTreeSha256) return null;
  const proof = apacheClosureVerifierFromScan(scan);
  if (!proof?.verified || proof.universeKind !== "git-source-tree" || proof.sourceRevision !== sourceRevision) return null;
  return {
    records: packageRecords,
    sourceFiles,
    sourceTreeRecords,
    sourceFilesSha256: scan.sourceFilesSha256,
    sourceTreeSha256: scan.sourceTreeSha256
  };
}

function sourceApacheClosureVerifier(scan, packageRecords) {
  const sourceProof = apacheClosureVerifierFromScan(scan);
  if (!sourceProof?.verified
      || sourceProof.universeKind !== "git-source-tree"
      || sourceProof.sourceRevision !== scan?.sourceRevision) return null;
  const expectedPackageFiles = JSON.stringify(packageRecords);
  return (actual) => {
    if (!isObject(actual)
        || actual.packageRoot !== RELEASE_LICENSE_PACKAGE_ROOT
        || !Array.isArray(actual.packageFiles)
        || JSON.stringify(actual.packageFiles) !== expectedPackageFiles
        || actual.manifest?.path !== scan.packageManifest?.path
        || actual.manifest?.sha256 !== scan.packageManifest?.sha256
        || actual.build?.path !== scan.buildReceipt?.path
        || actual.build?.sha256 !== scan.buildReceipt?.sha256
        || actual.closure?.path !== scan.closureReceipt?.path
        || actual.closure?.sha256 !== scan.closureReceipt?.sha256) return null;
    return {
      verified: true,
      packageFilesSha256: actual.packageFilesSha256,
      manifestSha256: actual.manifest.sha256,
      buildSha256: actual.build.sha256,
      closureSha256: actual.closure.sha256,
      universeKind: sourceProof.universeKind,
      sourceRevision: sourceProof.sourceRevision,
      sourceFilesSha256: sourceProof.sourceFilesSha256,
      sourceTreeSha256: sourceProof.sourceTreeSha256
    };
  };
}

function receiptBytes(scan, key, refKey) {
  const bytes = normalizeBytes(scan?.[key]);
  const reference = scan?.[refKey];
  if (!bytes || !isObject(reference) || !safeRelative(reference.path) || !SHA256.test(reference.sha256 ?? "") || sha256(bytes) !== reference.sha256) return null;
  return { path: reference.path, sha256: reference.sha256, bytes };
}

function scanIssueDetail(scan) {
  const fields = ["coreImports", "indirectCoreImports", "unresolvedDependencies", "dynamicDependencies", "pathEscapes", "syntaxErrors", "scannerErrors"];
  return fields.flatMap((field) => Array.isArray(scan?.[field]) && scan[field].length > 0 ? [{ field, count: scan[field].length }] : []);
}

function scanBindingDigest(scan) {
  try { return digestObject(scan); } catch { return null; }
}

function addUniverseEntry(universe, entry) {
  if (!universe.has(entry.path)) universe.set(entry.path, entry);
}

function apacheEvidenceRefs(inventory) {
  const refs = [];
  for (const file of Array.isArray(inventory?.files) ? inventory.files : []) {
    if (!isObject(file)) continue;
    if (isObject(file.apacheEvidence)) {
      for (const ref of [file.apacheEvidence.packageManifest, file.apacheEvidence.buildReceipt, file.apacheEvidence.closureReceipt]) {
        if (isObject(ref) && typeof ref.path === "string") refs.push(ref.path);
      }
    }
    for (const ref of [file.rightsholder?.evidencePath, file.grant?.evidencePath]) {
      if (typeof ref === "string") refs.push(ref);
    }
  }
  return [...new Set(refs)];
}

function gatePayload({
  sourceRevision,
  productVersion,
  scan,
  packageVersion,
  releaseDisposition,
  rightsReady,
  inventoryInput,
  bindingInput,
  inventoryRelative,
  artifactRelative,
  artifactBytes,
  releaseSubject,
  inventoryResult,
  coverageProof,
  rightsClearanceRequest,
  issues
}) {
  return {
    schemaVersion: RELEASE_LICENSE_GATE_SCHEMA_VERSION,
    kind: RELEASE_LICENSE_GATE_KIND,
    sourceRevision,
    productVersion,
    packageRoot: RELEASE_LICENSE_PACKAGE_ROOT,
    packageName: RELEASE_LICENSE_PACKAGE_NAME,
    packageVersion: packageVersion ?? scan?.packageVersion ?? null,
    universeKind: scan?.universeKind ?? null,
    sourceFilesSha256: scan?.sourceFilesSha256 ?? null,
    sourceTreeSha256: scan?.sourceTreeSha256 ?? null,
    packageManifestSha256: scan?.packageManifest?.sha256 ?? null,
    packageFilesSha256: scan?.packageFilesSha256 ?? null,
    buildSha256: scan?.buildReceipt?.sha256 ?? null,
    closureSha256: scan?.closureReceipt?.sha256 ?? null,
    inputs: {
      inventoryPath: inventoryRelative ?? null,
      inventorySha256: inventoryInput?.bytes ? sha256(inventoryInput.bytes) : null,
      outerBindingPath: bindingInput?.path ?? null,
      outerBindingSha256: bindingInput?.bytes ? sha256(bindingInput.bytes) : null,
      artifactPath: artifactRelative ?? null,
      artifactSha256: artifactBytes ? sha256(artifactBytes) : null
    },
    artifactEvidence: artifactBytes ? {
      role: "verification-carrier",
      covers: "complete-git-tree-plus-closure-receipts",
      publication: "not-established-by-gate"
    } : null,
    inventoryManifestSha256: inventoryInput?.bytes ? sha256(inventoryInput.bytes) : null,
    artifactSha256: artifactBytes ? sha256(artifactBytes) : null,
    releaseSubject: releaseSubject ? releaseSubjectMetadata(releaseSubject) : null,
    scan,
    inventory: inventoryResult ?? null,
    coverageProof: coverageProof ?? null,
    rightsClearanceRequest: rightsClearanceRequest ? {
      kind: rightsClearanceRequest.kind,
      requestDigest: rightsClearanceRequest.requestDigest,
      fileCount: rightsClearanceRequest.fileCount,
      authority: "none"
    } : null,
    issues: Array.isArray(issues) ? issues : [],
    releaseDisposition,
    rightsReady: rightsReady === true,
    result: releaseDisposition === "READY" && rightsReady === true ? "PASS" : "HOLD"
  };
}

export function requiresReleaseLicenseGate(version) {
  const normalized = String(version ?? "").trim();
  if (!SEMVER.test(normalized)) throw new Error("Release license gate version must be valid semver");
  const match = /^(\d+)\./.exec(normalized);
  if (!match) throw new Error("Release license gate version must be valid semver");
  return Number(match[1]) >= 5;
}

export async function verifyReleaseLicenseGate({
  cwd = process.cwd(),
  sourceRevision,
  productVersion,
  inventoryPath = null,
  outerBindingPath = null,
  artifactPath = null,
  packFiles = null,
  scanPackageImpl = scanPackage,
  artifactCoverageVerifier = undefined
} = {}) {
  const result = baseResult({ sourceRevision, productVersion });
  let normalizedRevision;
  let normalizedVersion;
  try {
    normalizedRevision = requiredSha(sourceRevision, "sourceRevision");
    normalizedVersion = requiredVersion(productVersion);
  } catch (error) {
    return hold(result, "RELEASE_BINDING_INVALID", error instanceof Error ? error.message : "release binding is invalid");
  }
  result.sourceRevision = normalizedRevision;
  result.productVersion = normalizedVersion;
  result.inputs = {
    inventoryPath: typeof inventoryPath === "string" ? inventoryPath : null,
    inventorySha256: null,
    outerBindingPath: typeof outerBindingPath === "string" ? outerBindingPath : null,
    outerBindingSha256: null,
    artifactPath: typeof artifactPath === "string" ? artifactPath : null,
    artifactSha256: null
  };

  let repositoryRoot;
  try {
    repositoryRoot = await canonicalSourceRoot(cwd);
  } catch {
    return hold(result, "RELEASE_ROOT_UNAVAILABLE", "the release checkout must resolve to a trusted Git worktree");
  }
  const inventoryAbsolute = checkoutPath(repositoryRoot, inventoryPath);
  const bindingAbsolute = checkoutPath(repositoryRoot, outerBindingPath);
  if (!inventoryAbsolute || !bindingAbsolute) {
    return hold(result, "LICENSE_INPUT_MISSING", "SBW_LICENSE_INVENTORY and SBW_LICENSE_OUTER_BINDING must name files inside the release checkout");
  }

  // Bind the product subject before reading optional rights inputs.  A HOLD
  // caused by a missing or malformed inventory still needs an immutable
  // source/version subject in its persisted receipt; otherwise the negative
  // result cannot be replayed against the product bytes it was about to gate.
  const head = await currentHead(repositoryRoot);
  if (head !== normalizedRevision) return hold(result, "SOURCE_REVISION_MISMATCH", `checked-out HEAD ${head ?? "unavailable"} does not match ${normalizedRevision}`);
  let releaseSubject;
  try {
    releaseSubject = await deriveReleaseProductSubject({
      cwd: repositoryRoot,
      sourceRevision: normalizedRevision,
      productVersion: normalizedVersion
    });
  } catch (error) {
    return hold(result, "RELEASE_SUBJECT_UNVERIFIED", error instanceof Error ? error.message : "the V5 product release subject could not be verified");
  }
  result.releaseSubject = releaseSubjectMetadata(releaseSubject);

  const [inventoryInput, bindingInput] = await Promise.all([
    readJsonInput(inventoryAbsolute, repositoryRoot),
    readJsonInput(bindingAbsolute, repositoryRoot)
  ]);
  result.inputs.inventorySha256 = inventoryInput.bytes ? sha256(inventoryInput.bytes) : null;
  result.inputs.outerBindingSha256 = bindingInput.bytes ? sha256(bindingInput.bytes) : null;
  if (!inventoryInput.bytes || !isObject(inventoryInput.value)) return hold(result, "LICENSE_INVENTORY_UNAVAILABLE", "the release license inventory is missing, unreadable, or invalid JSON");
  if (!bindingInput.bytes || !isObject(bindingInput.value)) return hold(result, "LICENSE_BINDING_UNAVAILABLE", "the release license outer binding is missing, unreadable, or invalid JSON");

  const inventoryRelative = posixRelative(repositoryRoot, inventoryAbsolute);
  const outerBinding = bindingInput.value;
  if (outerBinding.manifestPath !== inventoryRelative) {
    return hold(result, "LICENSE_MANIFEST_PATH_MISMATCH", `outer binding manifestPath must equal ${inventoryRelative}`);
  }

  if (packFiles !== null) {
    return hold(result, "CLOSURE_NPM_UNIVERSE_REJECTED", "the V5 release gate requires the trusted exact-commit Git source-tree closure; npm distribution evidence is a separate receipt");
  }

  const packageDir = path.join(repositoryRoot, RELEASE_LICENSE_PACKAGE_ROOT);
  const scanOptions = {
    packageDir,
    repoRoot: repositoryRoot,
    packageRoot: RELEASE_LICENSE_PACKAGE_ROOT,
    sourceRevision: normalizedRevision,
    buildReceiptPath: RELEASE_LICENSE_BUILD_RECEIPT_PATH,
    closureReceiptPath: RELEASE_LICENSE_CLOSURE_RECEIPT_PATH
  };
  let trustedScan;
  try {
    trustedScan = await scanPackage(scanOptions);
  } catch (error) {
    return hold(result, "CLOSURE_SCAN_FAILED", error instanceof Error ? error.message : "closure scanner failed");
  }
  if (scanPackageImpl !== scanPackage) {
    let suppliedScan;
    try {
      suppliedScan = await scanPackageImpl(scanOptions);
    } catch (error) {
      return hold(result, "CLOSURE_SCAN_FAILED", error instanceof Error ? error.message : "closure scanner test seam failed");
    }
    if (scanBindingDigest(suppliedScan) === null || scanBindingDigest(suppliedScan) !== scanBindingDigest(trustedScan)) {
      return hold(result, "CLOSURE_SCAN_UNTRUSTED", "the injected scanner result does not match the trusted source scan for this exact revision");
    }
  }
  const scan = trustedScan;
  result.scan = scan;
  const headAfterScan = await currentHead(repositoryRoot);
  if (headAfterScan !== normalizedRevision) {
    return hold(result, "SOURCE_REVISION_CHANGED_DURING_GATE", `checked-out HEAD changed during closure scanning: ${headAfterScan ?? "unavailable"}`);
  }
  if (!isObject(scan) || scan.packageRoot !== RELEASE_LICENSE_PACKAGE_ROOT || scan.verified !== true || scan.independent !== true) {
    return hold(result, "CLOSURE_SCAN_UNVERIFIED", JSON.stringify(scanIssueDetail(scan)));
  }
  if (scan.universeKind !== "git-source-tree" || scan.sourceRevision !== normalizedRevision) {
    return hold(result, "CLOSURE_SOURCE_UNIVERSE_INVALID", "the release gate requires a source closure bound to the exact release commit");
  }
  const sourceScan = sourcePackageRecords(scan, normalizedRevision);
  if (!sourceScan) {
    return hold(result, "CLOSURE_SOURCE_UNIVERSE_INVALID", "scanner source records, receipts, or exact-commit binding are malformed");
  }
  const packageRecords = sourceScan.records;
  if (!isObject(scan.packageManifest) || scan.packageManifest.path !== `${RELEASE_LICENSE_PACKAGE_ROOT}/package.json` || !SHA256.test(scan.packageManifest.sha256 ?? "")) {
    return hold(result, "CLOSURE_MANIFEST_INVALID", "scanner package manifest binding is missing or malformed");
  }
  const buildReceipt = receiptBytes(scan, "buildReceiptBytes", "buildReceipt");
  const closureReceipt = receiptBytes(scan, "closureReceiptBytes", "closureReceipt");
  if (!buildReceipt || !closureReceipt || buildReceipt.path !== RELEASE_LICENSE_BUILD_RECEIPT_PATH || closureReceipt.path !== RELEASE_LICENSE_CLOSURE_RECEIPT_PATH) {
    return hold(result, "CLOSURE_RECEIPT_INVALID", "scanner build/closure receipt bytes are missing or drifted");
  }
  const initialSourceIssue = await sourcePackageSnapshotIssue({
    repositoryRoot,
    sourceRevision: normalizedRevision,
    packageRecords
  });
  if (initialSourceIssue) return hold(result, initialSourceIssue.code, initialSourceIssue.detail);

  const subjectEntries = Array.isArray(releaseSubject.entries) ? releaseSubject.entries : [];
  const sourceArchive = releaseSubject.archive;
  if (releaseSubject.source !== "git-tree-full"
      || !isObject(sourceArchive)
      || sourceArchive.kind !== "github-source-archive"
      || sourceArchive.attributes !== "absent"
      || sourceArchive.modeSemantics !== "git-tree"
      || sourceArchive.fileCount !== subjectEntries.length
      || sourceArchive.filesSha256 !== releaseSubject.filesSha256
      || sourceArchive.treeSha256 !== releaseSubject.treeSha256) {
    return hold(result, "RELEASE_SOURCE_ARCHIVE_BOUNDARY_INVALID", "the release subject is not bound to the complete exact-commit GitHub source archive universe");
  }
  const wireSubjectEntries = subjectEntries.filter((entry) => entry.path === RELEASE_LICENSE_PACKAGE_ROOT || entry.path.startsWith(`${RELEASE_LICENSE_PACKAGE_ROOT}/`));
  const wireSubjectRecords = wireSubjectEntries
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(wireSubjectRecords) !== JSON.stringify(packageRecords)) {
    return hold(result, "RELEASE_SUBJECT_WIRE_UNIVERSE_MISMATCH", "the source release subject wire files do not match the independent Git source-tree closure");
  }
  const packageUniverse = new Map();
  for (const entry of subjectEntries) {
    addUniverseEntry(packageUniverse, {
      path: entry.path,
      materialType: "source",
      sha256: entry.sha256,
      mode: entry.mode,
      content: entry.bytes
    });
  }
  const manifestBytes = packageUniverse.get(scan.packageManifest.path)?.content;
  let packageManifest = null;
  try { packageManifest = JSON.parse(manifestBytes?.toString("utf8") ?? ""); } catch { packageManifest = null; }
  if (!isObject(packageManifest) || packageManifest.name !== RELEASE_LICENSE_PACKAGE_NAME || packageManifest.license !== "Apache-2.0") {
    return hold(result, "PACKAGE_IDENTITY_INVALID", "the current package manifest is not the Apache wire package");
  }
  if (sha256(manifestBytes) !== scan.packageManifest.sha256) return hold(result, "PACKAGE_MANIFEST_DRIFT", "package manifest bytes do not match scanner evidence");
  const packageVersion = typeof packageManifest.version === "string" ? packageManifest.version : null;

  const generatedReceipts = new Map([
    [buildReceipt.path, buildReceipt.bytes],
    [closureReceipt.path, closureReceipt.bytes]
  ]);
  for (const [relativePath, bytes] of generatedReceipts) {
    addUniverseEntry(packageUniverse, {
      path: relativePath,
      materialType: "doc",
      sha256: sha256(bytes),
      mode: 0o644,
      content: bytes
    });
  }
  // Inventory metadata may classify an already admitted source path, but it
  // can never add a new distribution path to the source-derived denominator.
  for (const file of Array.isArray(inventoryInput.value.files) ? inventoryInput.value.files : []) {
    const existing = packageUniverse.get(file?.path);
    if (existing && typeof file?.materialType === "string") existing.materialType = file.materialType;
  }

  const artifactRelative = outerBinding.artifactPath;
  const gateIssues = [];
  const providedArtifactPath = typeof artifactPath === "string" && artifactPath.trim().length > 0 ? artifactPath : null;
  const physicalArtifactPath = providedArtifactPath !== null
    ? checkoutPath(repositoryRoot, providedArtifactPath)
    : (safeRelative(artifactRelative) ? checkoutPath(repositoryRoot, artifactRelative) : null);
  if (!safeRelative(artifactRelative)) {
    gateIssues.push({ code: "ARTIFACT_PATH_INVALID", detail: "outer binding artifactPath is not a safe checkout-relative path" });
  } else if (!physicalArtifactPath) {
    gateIssues.push({ code: "ARTIFACT_PATH_INVALID", detail: "outer binding artifactPath is not inside the release checkout" });
  } else if (posixRelative(repositoryRoot, physicalArtifactPath) !== artifactRelative) {
    gateIssues.push({ code: "ARTIFACT_PATH_MISMATCH", detail: "the artifact input path must equal outer binding artifactPath" });
  }
  const artifactBytes = physicalArtifactPath && safeRelative(artifactRelative) && posixRelative(repositoryRoot, physicalArtifactPath) === artifactRelative
    ? await readRegularFile(physicalArtifactPath, repositoryRoot)
    : null;
  result.inputs.artifactPath = artifactRelative ?? result.inputs.artifactPath;
  result.inputs.artifactSha256 = artifactBytes ? sha256(artifactBytes) : null;
  result.artifactEvidence = artifactBytes ? {
    role: "verification-carrier",
    covers: "complete-git-tree-plus-closure-receipts",
    publication: "not-established-by-gate"
  } : null;
  if (physicalArtifactPath && !artifactBytes && safeRelative(artifactRelative) && posixRelative(repositoryRoot, physicalArtifactPath) === artifactRelative) {
    gateIssues.push({ code: "ARTIFACT_UNAVAILABLE", detail: "outer binding artifact bytes could not be read from the release checkout" });
  }
  const expectedArchiveFiles = [
    ...subjectEntries.map((entry) => ({ path: entry.path, sha256: entry.sha256, mode: entry.mode })),
    ...[buildReceipt, closureReceipt].map((entry) => ({ path: entry.path, sha256: entry.sha256, mode: 0o644 }))
  ];
  const coverageProof = artifactBytes
    ? verifyReleaseLicenseArchive(artifactBytes, { expectedFiles: expectedArchiveFiles })
    : null;
  if (!coverageProof?.verified) {
    gateIssues.push({
      code: "ARTIFACT_SUBJECT_COVERAGE_MISMATCH",
      detail: coverageProof?.issues?.map((issue) => issue.code).join(",") ?? "artifact bytes are unavailable"
    });
  }
  let effectiveArtifactCoverageVerifier = artifactCoverageVerifier;
  if (artifactCoverageVerifier === undefined) {
    effectiveArtifactCoverageVerifier = () => coverageProof;
  } else if (artifactCoverageVerifier === null) {
    gateIssues.push({ code: "ARTIFACT_COVERAGE_VERIFIER_MISSING", detail: "an independent artifact-universe verifier is required" });
    effectiveArtifactCoverageVerifier = () => null;
  } else if (typeof artifactCoverageVerifier !== "function") {
    gateIssues.push({ code: "ARTIFACT_COVERAGE_VERIFIER_INVALID", detail: "artifact coverage must be verified by a function" });
    effectiveArtifactCoverageVerifier = () => null;
  }
  const {
    manifestBytes: _ignoredManifestBytes,
    artifactBytes: _ignoredArtifactBytes,
    ...bindingWithoutCallerBytes
  } = outerBinding;
  const boundOuterBinding = {
    ...bindingWithoutCallerBytes,
    manifestBytes: inventoryInput.bytes,
    ...(artifactBytes ? { artifactBytes } : {})
  };
  const inventoryResult = verifyLicenseInventory({
    inventory: inventoryInput.value,
    distributionFiles: [...packageUniverse.values()],
    outerBinding: boundOuterBinding,
    rootDir: repositoryRoot,
    expectedVersion: normalizedVersion,
    // The existing inventory contract compares this callback's legacy fields
    // to the actual distribution universe.  The adapter binds those fields to
    // the independently scanned Git source-tree records and receipt bytes;
    // it never treats caller-supplied verified/independent booleans as proof.
    apacheClosureVerifier: sourceApacheClosureVerifier(scan, packageRecords),
    artifactCoverageVerifier: effectiveArtifactCoverageVerifier
  });
  result.inventory = inventoryResult;
  result.coverageProof = coverageProof;
  const finalHead = await currentHead(repositoryRoot);
  if (finalHead !== normalizedRevision) {
    gateIssues.push({ code: "SOURCE_REVISION_CHANGED_DURING_GATE", detail: `checked-out HEAD changed before release admission: ${finalHead ?? "unavailable"}` });
  }
  const finalInventoryBytes = await readRegularFile(inventoryAbsolute, repositoryRoot);
  if (!finalInventoryBytes || sha256(finalInventoryBytes) !== sha256(inventoryInput.bytes)) {
    gateIssues.push({ code: "LICENSE_INPUT_CHANGED_DURING_GATE", detail: "the license inventory bytes changed before release admission" });
  }
  const finalBindingBytes = await readRegularFile(bindingAbsolute, repositoryRoot);
  if (!finalBindingBytes || sha256(finalBindingBytes) !== sha256(bindingInput.bytes)) {
    gateIssues.push({ code: "LICENSE_INPUT_CHANGED_DURING_GATE", detail: "the license outer binding bytes changed before release admission" });
  }
  if (physicalArtifactPath && artifactBytes) {
    const finalArtifactBytes = await readRegularFile(physicalArtifactPath, repositoryRoot);
    if (!finalArtifactBytes || sha256(finalArtifactBytes) !== sha256(artifactBytes)) {
      gateIssues.push({ code: "ARTIFACT_SNAPSHOT_DRIFT", detail: "artifact bytes changed before release admission" });
    }
  }
  const finalSourceIssue = await sourcePackageSnapshotIssue({
    repositoryRoot,
    sourceRevision: normalizedRevision,
    packageRecords
  });
  if (finalSourceIssue) gateIssues.push(finalSourceIssue);
  try {
    await revalidateReleaseProductSubject(releaseSubject, { cwd: repositoryRoot });
  } catch (error) {
    gateIssues.push({
      code: "RELEASE_SUBJECT_SNAPSHOT_DRIFT",
      detail: error instanceof Error ? error.message : "release subject source snapshot changed before admission"
    });
  }
  let rightsClearanceRequest = null;
  if (coverageProof?.verified
      && gateIssues.length === 0
      && inventoryResult.coverage?.complete === true
      && inventoryResult.schemaErrors?.length === 0) {
    try {
      rightsClearanceRequest = createRightsClearanceRequestV1({
        releaseSubject,
        generatedReceipts: [buildReceipt, closureReceipt],
        inventoryBytes: inventoryInput.bytes,
        artifactSha256: sha256(artifactBytes)
      });
    } catch (error) {
      gateIssues.push({
        code: "RIGHTS_CLEARANCE_REQUEST_UNAVAILABLE",
        detail: error instanceof Error ? error.message : "the exact rights review request could not be prepared"
      });
    }
  }
  result.rightsClearanceRequest = rightsClearanceRequest;
  if (requiresReleaseLicenseGate(normalizedVersion)) {
    // A public license reference does not establish per-file chain of title.
    // Keep V5 closed until a dedicated, trusted rights-clearance verifier is
    // bound to the complete exact source and artifact universe.
    gateIssues.push({
      code: "RIGHTS_CLEARANCE_UNAVAILABLE",
      detail: "a trusted full-universe rights-clearance verifier is not integrated"
    });
  }
  result.issues.push(...gateIssues);
  const ready = inventoryResult.releaseDisposition === "READY" && inventoryResult.rightsReady === true && gateIssues.length === 0;
  result.rightsReady = ready;
  result.releaseDisposition = ready ? "READY" : "HOLD";
  const payload = gatePayload({
    sourceRevision: normalizedRevision,
    productVersion: normalizedVersion,
    scan,
    packageVersion,
    releaseDisposition: result.releaseDisposition,
    rightsReady: result.rightsReady,
    inventoryInput,
    bindingInput: { ...bindingInput, path: posixRelative(repositoryRoot, bindingAbsolute) },
    inventoryRelative,
    artifactRelative,
    artifactBytes,
    releaseSubject,
    inventoryResult,
    coverageProof,
    rightsClearanceRequest,
    issues: result.issues
  });
  result.receipt = { ...payload, receiptDigest: digestObject(payload) };
  return result;
}

export async function assertReleaseLicenseGate(input = {}) {
  const result = await verifyReleaseLicenseGate(input);
  if (result.releaseDisposition !== "READY" || result.rightsReady !== true) {
    const reason = result.issues?.[0]?.code ?? result.inventory?.boundaryIssues?.[0]?.code ?? "LICENSE_GATE_HOLD";
    const error = new Error(`Release license gate is HOLD: ${reason}`);
    error.code = "RELEASE_LICENSE_GATE_HOLD";
    error.result = result;
    throw error;
  }
  return result;
}

function fallbackReceipt(result) {
  const payload = {
    schemaVersion: RELEASE_LICENSE_GATE_SCHEMA_VERSION,
    kind: RELEASE_LICENSE_GATE_KIND,
    sourceRevision: result?.sourceRevision ?? null,
    productVersion: result?.productVersion ?? null,
    packageRoot: RELEASE_LICENSE_PACKAGE_ROOT,
    packageName: RELEASE_LICENSE_PACKAGE_NAME,
    inputs: result?.inputs ?? null,
    releaseSubject: result?.releaseSubject ?? null,
    scan: result?.scan ?? null,
    inventory: result?.inventory ?? null,
    coverageProof: result?.coverageProof ?? null,
    rightsClearanceRequest: result?.rightsClearanceRequest ? {
      kind: result.rightsClearanceRequest.kind,
      requestDigest: result.rightsClearanceRequest.requestDigest,
      fileCount: result.rightsClearanceRequest.fileCount,
      authority: "none"
    } : null,
    artifactEvidence: result?.artifactEvidence ?? null,
    releaseDisposition: result?.releaseDisposition === "READY" ? "READY" : "HOLD",
    rightsReady: result?.rightsReady === true,
    issues: Array.isArray(result?.issues) ? result.issues : [],
    result: result?.releaseDisposition === "READY" && result?.rightsReady === true ? "PASS" : "HOLD"
  };
  return { ...payload, receiptDigest: digestObject(payload) };
}

function receiptFileBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function absoluteReceiptTarget(root, outputPath, result) {
  if (typeof root !== "string" || root.trim().length === 0) throw new Error("Release license receipt state root is required");
  const stateRoot = path.resolve(root);
  if (typeof outputPath === "string" && outputPath.trim().length > 0) {
    const target = path.isAbsolute(outputPath) ? path.resolve(outputPath) : safeJoin(stateRoot, outputPath);
    if (!isInside(stateRoot, target)) throw new Error("Release license receipt path must remain inside its state root");
    return { stateRoot, target };
  }
  const revision = SHA40.test(String(result?.sourceRevision ?? "")) ? result.sourceRevision : "unbound";
  return { stateRoot, target: safeJoin(stateRoot, "release-gates", revision, "license-gate.json") };
}

async function existingReceipt(target, stateRoot, expectedBytes) {
  try { await realpath(stateRoot); } catch { return null; }
  const bytes = await readRegularFile(target, stateRoot);
  if (!bytes) return null;
  if (!bytes.equals(expectedBytes)) throw new Error(`Immutable release license receipt path already contains different bytes: ${target}`);
  return bytes;
}

export async function persistReleaseLicenseGateReceipt({ result, stateRoot, outputPath = null } = {}) {
  const receipt = result?.receipt ?? fallbackReceipt(result);
  const { stateRoot: resolvedStateRoot, target } = absoluteReceiptTarget(stateRoot, outputPath, result);
  await ensurePrivateDir(resolvedStateRoot);
  await assertNoSymlinkUnder(resolvedStateRoot, path.dirname(target));
  await ensurePrivateDir(path.dirname(target));
  const bytes = receiptFileBytes(receipt);
  const existing = await existingReceipt(target, resolvedStateRoot, bytes);
  if (existing) return { path: target, sha256: sha256(existing), receiptDigest: receipt.receiptDigest };
  let handle = null;
  try {
    handle = await open(target, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const raced = await existingReceipt(target, resolvedStateRoot, bytes);
    if (!raced) throw new Error(`Immutable release license receipt was replaced during publication: ${target}`);
    return { path: target, sha256: sha256(raced), receiptDigest: receipt.receiptDigest };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  return { path: target, sha256: sha256(bytes), receiptDigest: receipt.receiptDigest };
}

export async function readReleaseLicenseGateReceipt({ stateRoot, receiptPath, sourceRevision = null, productVersion = null, requirePass = true } = {}) {
  const { stateRoot: resolvedStateRoot, target } = absoluteReceiptTarget(stateRoot, receiptPath, { sourceRevision });
  let canonicalStateRoot;
  try { canonicalStateRoot = await realpath(resolvedStateRoot); } catch {
    throw new Error(`Release license receipt is missing or unsafe: ${target}`);
  }
  const bytes = await readRegularFile(target, resolvedStateRoot);
  if (!bytes) throw new Error(`Release license receipt is missing or unsafe: ${target}`);
  let receipt;
  try { receipt = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`Release license receipt is not valid JSON: ${target}`); }
  const { receiptDigest, ...payload } = receipt ?? {};
  if (!SHA256.test(receiptDigest ?? "") || digestObject(payload) !== receiptDigest) throw new Error(`Release license receipt digest mismatch: ${target}`);
  if (sourceRevision !== null && payload.sourceRevision !== sourceRevision) throw new Error(`Release license receipt revision mismatch: ${target}`);
  if (productVersion !== null && payload.productVersion !== productVersion) throw new Error(`Release license receipt version mismatch: ${target}`);
  if (requirePass && (payload.result !== "PASS" || payload.releaseDisposition !== "READY" || payload.rightsReady !== true)) throw new Error(`Release license receipt is not a verified PASS: ${target}`);
  return { receipt, path: target, sha256: sha256(bytes), receiptDigest };
}
