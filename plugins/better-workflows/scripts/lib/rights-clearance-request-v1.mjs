import { canonicalJson, digestObject, sha256 } from "./core.mjs";

export const RIGHTS_CLEARANCE_REQUEST_SCHEMA_VERSION = 1;
export const RIGHTS_CLEARANCE_REQUEST_KIND = "better-workflows-rights-clearance-request";

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*[\u0000-\u001f\u007f]).+$/;
const GENERATED_RECEIPT_PATHS = Object.freeze([
  "evidence/better-workflows-wire-build.json",
  "evidence/better-workflows-wire-closure.json"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safePath(value) {
  return typeof value === "string"
    && SAFE_PATH.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function validFile(file) {
  return isObject(file)
    && safePath(file.path)
    && SHA256.test(file.sha256 ?? "")
    && [0o644, 0o755].includes(file.mode);
}

function byPath(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function candidateGaps(record) {
  const gaps = [];
  if (record.disposition !== "include") gaps.push("DISPOSITION_UNRESOLVED");
  if (record.origin?.kind === "unknown") gaps.push("ORIGIN_UNKNOWN");
  if (record.origin?.kind === "generated" && !record.generatedFrom) gaps.push("GENERATED_LINEAGE_MISSING");
  if (record.origin?.kind === "upstream" && !record.origin.sourceOffer) gaps.push("UPSTREAM_SOURCE_OFFER_MISSING");
  if (record.rightsholder?.kind === "unknown") gaps.push("RIGHTSHOLDER_UNKNOWN");
  if (record.grant?.kind === "unknown") gaps.push("GRANT_UNKNOWN");
  return gaps;
}

function exactUniverse(releaseSubject, generatedReceipts) {
  if (!isObject(releaseSubject)
      || releaseSubject.source !== "git-tree-full"
      || !SHA40.test(releaseSubject.sourceRevision ?? "")
      || !SEMVER.test(releaseSubject.productVersion ?? "")
      || !SHA256.test(releaseSubject.filesSha256 ?? "")
      || !SHA256.test(releaseSubject.treeSha256 ?? "")
      || !Array.isArray(releaseSubject.files)
      || !Array.isArray(releaseSubject.entries)
      || releaseSubject.files.length !== releaseSubject.entries.length
      || sha256(Buffer.from(JSON.stringify(releaseSubject.files), "utf8")) !== releaseSubject.filesSha256
      || releaseSubject.archive?.filesSha256 !== releaseSubject.filesSha256
      || releaseSubject.archive?.treeSha256 !== releaseSubject.treeSha256
      || releaseSubject.archive?.fileCount !== releaseSubject.files.length
      || releaseSubject.archive?.kind !== "github-source-archive") {
    throw new Error("rights request requires a complete exact-commit release subject");
  }
  const sourceFiles = new Map();
  for (const file of releaseSubject.files) {
    if (!validFile(file) || sourceFiles.has(file.path)) throw new Error("rights request source files are unsafe or duplicated");
    sourceFiles.set(file.path, file);
  }
  const seenEntries = new Set();
  for (const entry of releaseSubject.entries) {
    const file = sourceFiles.get(entry?.path);
    if (!file || seenEntries.has(entry.path) || !validFile(entry) || entry.sha256 !== file.sha256 || entry.mode !== file.mode
        || !Buffer.isBuffer(entry.bytes) || sha256(entry.bytes) !== file.sha256) {
      throw new Error("rights request source entries do not match the release subject");
    }
    seenEntries.add(entry.path);
  }
  if (!Array.isArray(generatedReceipts) || generatedReceipts.length !== GENERATED_RECEIPT_PATHS.length) {
    throw new Error("rights request requires both exact generated closure receipts");
  }
  const universe = new Map([...sourceFiles].map(([filePath, file]) => [filePath, {
    path: filePath, sha256: file.sha256, mode: file.mode
  }]));
  const seenReceipts = new Set();
  for (const receipt of generatedReceipts) {
    const bytes = Buffer.isBuffer(receipt?.bytes) ? receipt.bytes : null;
    if (!GENERATED_RECEIPT_PATHS.includes(receipt?.path)
        || seenReceipts.has(receipt.path)
        || universe.has(receipt.path)
        || !SHA256.test(receipt.sha256 ?? "")
        || !bytes
        || sha256(bytes) !== receipt.sha256) {
      throw new Error("rights request generated closure receipts are incomplete or drifted");
    }
    seenReceipts.add(receipt.path);
    universe.set(receipt.path, { path: receipt.path, sha256: receipt.sha256, mode: 0o644 });
  }
  return [...universe.values()].sort(byPath);
}

/**
 * Make an owner-review request from already verified release inputs. This is
 * an exact, reproducible worklist; it never grants distribution rights.
 */
export function createRightsClearanceRequestV1({
  releaseSubject,
  generatedReceipts,
  inventoryBytes,
  artifactSha256
} = {}) {
  const universe = exactUniverse(releaseSubject, generatedReceipts);
  if (!Buffer.isBuffer(inventoryBytes) || !SHA256.test(artifactSha256 ?? "")) {
    throw new Error("rights request requires exact inventory bytes and artifact digest");
  }
  let inventory;
  try { inventory = JSON.parse(inventoryBytes.toString("utf8")); } catch {
    throw new Error("rights request inventory is not valid JSON");
  }
  if (!isObject(inventory)
      || inventory.kind !== "better-workflows-license-inventory"
      || inventory.productVersion !== releaseSubject.productVersion
      || !Array.isArray(inventory.files)
      || inventory.files.length !== universe.length) {
    throw new Error("rights request inventory does not cover the exact product version and universe");
  }
  const inventoryByPath = new Map();
  for (const record of inventory.files) {
    if (!isObject(record) || !safePath(record.path) || !SHA256.test(record.sha256 ?? "") || inventoryByPath.has(record.path)) {
      throw new Error("rights request inventory has unsafe or duplicate file records");
    }
    inventoryByPath.set(record.path, record);
  }
  const files = universe.map((file) => {
    const record = inventoryByPath.get(file.path);
    if (!record || record.sha256 !== file.sha256) {
      throw new Error(`rights request inventory path or digest mismatch: ${file.path}`);
    }
    return {
      ...file,
      inventoryRecordSha256: digestObject(record),
      materialType: record.materialType ?? null,
      publicScope: record.publicScope ?? null,
      disposition: record.disposition ?? null,
      candidateGaps: candidateGaps(record),
      ownerReviewRequired: true
    };
  });
  const payload = {
    schemaVersion: RIGHTS_CLEARANCE_REQUEST_SCHEMA_VERSION,
    kind: RIGHTS_CLEARANCE_REQUEST_KIND,
    sourceRevision: releaseSubject.sourceRevision,
    productVersion: releaseSubject.productVersion,
    sourceFilesSha256: releaseSubject.filesSha256,
    sourceTreeSha256: releaseSubject.treeSha256,
    inventorySha256: sha256(inventoryBytes),
    artifactSha256,
    fileCount: files.length,
    files,
    authority: "none",
    rightsReady: false
  };
  return { ...payload, requestDigest: digestObject(payload) };
}

export function verifyRightsClearanceRequestV1({ request, ...inputs } = {}) {
  let expected;
  try { expected = createRightsClearanceRequestV1(inputs); } catch (error) {
    return { verified: false, issue: error instanceof Error ? error.message : String(error) };
  }
  try {
    if (!isObject(request) || canonicalJson(request) !== canonicalJson(expected)) {
      return { verified: false, issue: "rights request differs from exact release inputs" };
    }
  } catch {
    return { verified: false, issue: "rights request is not canonical data" };
  }
  return { verified: true, requestDigest: expected.requestDigest, fileCount: expected.fileCount, authority: "none" };
}
