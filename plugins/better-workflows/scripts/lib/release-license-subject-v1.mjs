import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import path from "node:path";
import { runSourceGit } from "./git.mjs";

export const RELEASE_PRODUCT_SUBJECT_SCHEMA_VERSION = 1;
export const RELEASE_PRODUCT_SUBJECT_KIND = "better-workflows-product-release-subject";

// The stable release is the exact commit's GitHub source archive as well as
// the tagged repository.  Keep the release denominator independent of the
// license inventory: every tracked regular file is admitted.  GitHub applies
// `.gitattributes` export-ignore rules when it creates a source archive, so a
// checked-in attributes file is rejected until its archive semantics are
// implemented and proven here.
export const RELEASE_PRODUCT_SUBJECT_ROOTS = Object.freeze([
  "."
]);
export const RELEASE_PRODUCT_SUBJECT_PATHS = Object.freeze([]);

export const RELEASE_PRODUCT_SUBJECT_CONTRACT = Object.freeze({
  kind: RELEASE_PRODUCT_SUBJECT_KIND,
  source: "git-tree-full",
  archive: "github-source-archive",
  attributes: "absent-required",
  modeSemantics: "git-tree",
  roots: RELEASE_PRODUCT_SUBJECT_ROOTS,
  paths: RELEASE_PRODUCT_SUBJECT_PATHS
});

const SHA40 = /^[a-f0-9]{40}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*[\u0000-\u001f\u007f]).+$/;
const PRODUCT_MANIFEST_PATH = "plugins/better-workflows/config/version-manifest-v1.json";
const PLUGIN_MANIFEST_PATH = "plugins/better-workflows/package.json";
const WIRE_MANIFEST_PATH = "packages/better-workflows-wire/package.json";
const MAX_SUBJECT_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_SUBJECT_ENTRIES = 4096;
const SUPPORTED_RELEASE_PLATFORMS = new Set(["darwin", "linux"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha1GitBlob(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safePath(value) {
  return typeof value === "string"
    && SAFE_PATH.test(value)
    && !path.isAbsolute(value)
    && value.split("/").every((part) => part !== "." && part !== "..");
}

function stableFilesDigest(files) {
  return sha256(Buffer.from(JSON.stringify(files), "utf8"));
}

function gitTreeDigest(records) {
  return sha256(Buffer.from(JSON.stringify(records), "utf8"));
}

async function readBoundRegularFile(root, relativePath, expectedMode) {
  const target = path.resolve(root, relativePath);
  if (!isInside(root, target)) throw new Error(`release subject path escapes checkout: ${relativePath}`);
  let handle = null;
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`release subject path is not a regular file: ${relativePath}`);
    const resolved = await realpath(target);
    if (resolved !== target) throw new Error(`release subject path was redirected: ${relativePath}`);
    if ((info.mode & 0o7000) !== 0) throw new Error(`release subject path has unsupported special permission bits: ${relativePath}`);
    const mode = (info.mode & 0o100) === 0 ? 0o644 : 0o755;
    if (mode !== expectedMode) throw new Error(`release subject mode drifted: ${relativePath}`);
    handle = await open(target, O_RDONLY | O_NOFOLLOW);
    const opened = await handle.stat();
    const openedMode = (opened.mode & 0o100) === 0 ? 0o644 : 0o755;
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino ||
        (opened.mode & 0o7000) !== 0 || openedMode !== expectedMode) {
      throw new Error(`release subject path changed during read: ${relativePath}`);
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_SUBJECT_ENTRY_BYTES) throw new Error(`release subject entry exceeds the bounded size: ${relativePath}`);
    return { bytes, mode: expectedMode };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function parseTreeOutput(output) {
  if (!Buffer.isBuffer(output)) throw new Error("release subject Git tree output must be bytes");
  const records = [];
  const seen = new Set();
  for (const chunk of output.toString("utf8").split("\0")) {
    if (chunk.length === 0) continue;
    const separator = chunk.indexOf("\t");
    if (separator < 0) throw new Error("release subject Git tree entry is malformed");
    const metadata = chunk.slice(0, separator).trim().split(/\s+/);
    const filePath = chunk.slice(separator + 1);
    const [mode, type, objectId, sizeText] = metadata;
    if (mode === "120000") {
      throw new Error(`release subject contains a symlink, which is not admitted in the GitHub source archive universe: ${filePath}`);
    }
    if (mode === "160000" || type === "commit") {
      throw new Error(`release subject contains a gitlink, which is not admitted in the GitHub source archive universe: ${filePath}`);
    }
    if (!/^100(?:644|755)$/.test(mode) || type !== "blob" || !SHA40.test(objectId ?? "") || !/^\d+$/.test(sizeText ?? "")) {
      throw new Error(`release subject contains a non-regular or malformed Git entry: ${filePath}`);
    }
    if (!safePath(filePath) || seen.has(filePath)) {
      throw new Error(`release subject path is unsafe or duplicated: ${filePath}`);
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > MAX_SUBJECT_ENTRY_BYTES) {
      throw new Error(`release subject entry size is invalid: ${filePath}`);
    }
    seen.add(filePath);
    records.push({
      path: filePath,
      mode: mode === "100755" ? 0o755 : 0o644,
      objectId: objectId.toLowerCase(),
      size
    });
  }
  if (records.length === 0 || records.length > MAX_SUBJECT_ENTRIES) throw new Error("release subject Git tree is empty or exceeds its bound");
  records.sort((left, right) => left.path.localeCompare(right.path));
  return records;
}

function requiredSubjectPaths() {
  return [
    "COPYRIGHT",
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    PRODUCT_MANIFEST_PATH,
    PLUGIN_MANIFEST_PATH,
    WIRE_MANIFEST_PATH,
    "packages/better-workflows-wire/README.md",
    "packages/better-workflows-wire/LICENSE",
    "packages/better-workflows-wire/NOTICE"
  ];
}

function parseObject(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch (error) {
    throw new Error(`${label} is not a valid JSON object: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

function assertManifestContract(manifest, pluginManifest, wireManifest, productVersion) {
  if (manifest.version !== productVersion || !SEMVER.test(String(manifest.version ?? ""))) {
    throw new Error("release subject version manifest does not bind the requested product version");
  }
  if (JSON.stringify(manifest.releaseSubject) !== JSON.stringify(RELEASE_PRODUCT_SUBJECT_CONTRACT)) {
    throw new Error("release subject version manifest has an unexpected subject contract");
  }
  if (pluginManifest.name !== "better-workflows" || pluginManifest.version !== productVersion || pluginManifest.license !== "AGPL-3.0-only") {
    throw new Error("release subject plugin manifest is not the expected AGPL product");
  }
  if (wireManifest.name !== "@better-workflows/wire" || wireManifest.license !== "Apache-2.0" || !Array.isArray(wireManifest.files)) {
    throw new Error("release subject wire manifest is not the expected Apache package");
  }
  const declaredWirePaths = new Set([
    `${"packages/better-workflows-wire"}/package.json`,
    `${"packages/better-workflows-wire"}/README.md`,
    `${"packages/better-workflows-wire"}/LICENSE`,
    `${"packages/better-workflows-wire"}/NOTICE`
  ]);
  for (const file of wireManifest.files) {
    if (file === "src") declaredWirePaths.add("packages/better-workflows-wire/src");
    else if (typeof file !== "string") throw new Error("release subject wire files contract is malformed");
  }
  for (const required of ["packages/better-workflows-wire/src"]) {
    if (!declaredWirePaths.has(required)) throw new Error("release subject wire files contract omits src");
  }
}

function metadataFor(subject) {
  return {
    schemaVersion: subject.schemaVersion,
    kind: subject.kind,
    source: subject.source,
    archive: subject.archive,
    sourceRevision: subject.sourceRevision,
    productVersion: subject.productVersion,
    roots: subject.roots,
    paths: subject.paths,
    files: subject.files,
    filesSha256: subject.filesSha256,
    treeSha256: subject.treeSha256
  };
}

export function releaseSubjectMetadata(subject) {
  if (!subject || typeof subject !== "object") return null;
  return metadataFor(subject);
}

export async function deriveReleaseProductSubject({
  cwd = process.cwd(),
  sourceRevision,
  productVersion = null
} = {}) {
  if (!SUPPORTED_RELEASE_PLATFORMS.has(process.platform)) {
    throw new Error(`release subject verification is unsupported on ${process.platform}`);
  }
  const normalizedRevision = String(sourceRevision ?? "").trim().toLowerCase();
  if (!SHA40.test(normalizedRevision)) throw new Error("release subject requires an exact lowercase source commit SHA");
  const root = await realpath(cwd);
  const commit = await runSourceGit(root, ["rev-parse", "--verify", `${normalizedRevision}^{commit}`], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  if (String(commit.stdout).trim().toLowerCase() !== normalizedRevision) {
    throw new Error("release subject sourceRevision must resolve to the exact source commit");
  }
  const tree = await runSourceGit(root, [
    "ls-tree", "-r", "-z", "-l", "--full-tree", normalizedRevision
  ], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
  const records = parseTreeOutput(tree.stdout);
  const attributeFiles = records.filter((record) => (
    record.path === ".gitattributes" || record.path.endsWith("/.gitattributes")
  ));
  if (attributeFiles.length > 0) {
    throw new Error(`release subject cannot establish GitHub source archive equivalence while .gitattributes is present: ${attributeFiles.map((record) => record.path).join(", ")}`);
  }
  const byPath = new Map(records.map((record) => [record.path, record]));
  for (const required of requiredSubjectPaths()) {
    if (!byPath.has(required)) throw new Error(`release subject is missing required source path: ${required}`);
  }
  if (!records.some((record) => record.path.startsWith("packages/better-workflows-wire/src/"))) {
    throw new Error("release subject is missing the wire package src files");
  }
  const entries = [];
  for (const record of records) {
    const actual = await readBoundRegularFile(root, record.path, record.mode);
    const blobObjectId = sha1GitBlob(actual.bytes);
    if (blobObjectId !== record.objectId) throw new Error(`release subject source bytes do not match commit ${normalizedRevision}: ${record.path}`);
    entries.push({
      path: record.path,
      bytes: actual.bytes,
      mode: actual.mode,
      sha256: sha256(actual.bytes),
      gitBlobSha1: blobObjectId,
      size: actual.bytes.length
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const entryFiles = entries.map(({ path: filePath, sha256: digest, mode, gitBlobSha1 }) => ({
    path: filePath,
    sha256: digest,
    mode,
    gitBlobSha1
  }));
  const manifest = parseObject(entriesByPath.get(PRODUCT_MANIFEST_PATH).bytes, "release subject version manifest");
  const pluginManifest = parseObject(entriesByPath.get(PLUGIN_MANIFEST_PATH).bytes, "release subject plugin manifest");
  const wireManifest = parseObject(entriesByPath.get(WIRE_MANIFEST_PATH).bytes, "release subject wire manifest");
  const normalizedVersion = productVersion === null ? String(manifest.version ?? "") : String(productVersion).trim();
  if (!SEMVER.test(normalizedVersion)) throw new Error("release subject product version must be valid semver");
  assertManifestContract(manifest, pluginManifest, wireManifest, normalizedVersion);
  const treeRecords = records.map(({ path: filePath, mode, objectId, size }) => ({ path: filePath, mode, objectId, size }));
  const subject = {
    schemaVersion: RELEASE_PRODUCT_SUBJECT_SCHEMA_VERSION,
    kind: RELEASE_PRODUCT_SUBJECT_KIND,
    source: "git-tree-full",
    archive: {
      kind: "github-source-archive",
      fileCount: records.length,
      filesSha256: stableFilesDigest(entryFiles),
      treeSha256: gitTreeDigest(treeRecords),
      attributes: "absent",
      modeSemantics: "git-tree"
    },
    sourceRevision: normalizedRevision,
    productVersion: normalizedVersion,
    roots: [...RELEASE_PRODUCT_SUBJECT_ROOTS],
    paths: [...RELEASE_PRODUCT_SUBJECT_PATHS],
    files: entryFiles,
    filesSha256: stableFilesDigest(entryFiles),
    treeSha256: gitTreeDigest(treeRecords),
    entries,
    manifests: {
      version: { path: PRODUCT_MANIFEST_PATH, sha256: sha256(entriesByPath.get(PRODUCT_MANIFEST_PATH).bytes) },
      plugin: { path: PLUGIN_MANIFEST_PATH, sha256: sha256(entriesByPath.get(PLUGIN_MANIFEST_PATH).bytes) },
      wire: { path: WIRE_MANIFEST_PATH, sha256: sha256(entriesByPath.get(WIRE_MANIFEST_PATH).bytes) }
    }
  };
  return subject;
}

export async function revalidateReleaseProductSubject(subject, { cwd = process.cwd() } = {}) {
  if (!subject || typeof subject !== "object") throw new Error("release subject snapshot is required");
  const current = await deriveReleaseProductSubject({
    cwd,
    sourceRevision: subject.sourceRevision,
    productVersion: subject.productVersion
  });
  if (current.filesSha256 !== subject.filesSha256 || current.treeSha256 !== subject.treeSha256) {
    throw new Error("release subject source snapshot drifted");
  }
  return current;
}
