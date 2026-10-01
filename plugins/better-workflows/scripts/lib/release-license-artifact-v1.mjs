import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const RELEASE_LICENSE_ARTIFACT_FORMAT = "ustar-gzip-v1";
export const RELEASE_LICENSE_ARTIFACT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const RELEASE_LICENSE_ARTIFACT_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const RELEASE_LICENSE_ARTIFACT_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
export const RELEASE_LICENSE_ARTIFACT_MAX_ENTRIES = 4096;
export const RELEASE_LICENSE_ARTIFACT_MAX_COMPRESSION_RATIO = 1000;

const SHA256 = /^[a-f0-9]{64}$/;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableFilesDigest(files) {
  return sha256(Buffer.from(JSON.stringify(files), "utf8"));
}

function safeArchivePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\u0000") || value.startsWith("/")) return false;
  const parts = value.split("/");
  return parts.length > 0 && parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function decodeField(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\0+$/, "");
  } catch {
    return null;
  }
}

function readOctal(bytes) {
  const text = bytes.toString("ascii").replace(/\0/g, "").trim();
  if (!/^[0-7]+$/.test(text)) return null;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : null;
}

function allZero(bytes) {
  for (const value of bytes) if (value !== 0) return false;
  return true;
}

function archiveIssue(code, detail = null) {
  return detail === null ? { code } : { code, detail };
}

function compareFileLists(actual, actualModes, expected) {
  if (!Array.isArray(expected)) return archiveIssue("EXPECTED_UNIVERSE_INVALID");
  const normalized = [];
  const expectedModes = new Map();
  const seen = new Set();
  for (const item of expected) {
    if (!isObject(item) || !safeArchivePath(item.path) || !SHA256.test(item.sha256 ?? "") || seen.has(item.path)) {
      return archiveIssue("EXPECTED_UNIVERSE_INVALID");
    }
    if (item.mode !== undefined && (!Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777)) {
      return archiveIssue("EXPECTED_UNIVERSE_INVALID");
    }
    seen.add(item.path);
    normalized.push({ path: item.path, sha256: item.sha256 });
    if (item.mode !== undefined) expectedModes.set(item.path, item.mode);
  }
  normalized.sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(actual) !== JSON.stringify(normalized)) {
    return archiveIssue("ARCHIVE_COVERAGE_MISMATCH", `expected=${JSON.stringify(normalized)};actual=${JSON.stringify(actual)}`);
  }
  const actualModeByPath = new Map((Array.isArray(actualModes) ? actualModes : []).map((entry) => [entry.path, entry.mode]));
  for (const [filePath, expectedMode] of expectedModes) {
    if (actualModeByPath.get(filePath) !== expectedMode) {
      return archiveIssue("ARCHIVE_MODE_MISMATCH", `path=${filePath};expected=${expectedMode};actual=${actualModeByPath.get(filePath) ?? "missing"}`);
    }
  }
  return null;
}

function tarHeader({ path, size, mode = 0o644 }) {
  const bytes = Buffer.alloc(512, 0);
  const parts = path.split("/");
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name, "utf8") > 100) {
    const split = parts.findIndex((_, index) => Buffer.byteLength(parts.slice(0, index).join("/"), "utf8") <= 155 && Buffer.byteLength(parts.slice(index).join("/"), "utf8") <= 100);
    if (split <= 0) throw new Error(`Archive path exceeds ustar limits: ${path}`);
    prefix = parts.slice(0, split).join("/");
    name = parts.slice(split).join("/");
  }
  if (Buffer.byteLength(name, "utf8") > 100 || Buffer.byteLength(prefix, "utf8") > 155) throw new Error(`Archive path exceeds ustar limits: ${path}`);
  bytes.write(name, 0, "utf8");
  bytes.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, "ascii");
  bytes.write("0000000\0", 108, "ascii");
  bytes.write("0000000\0", 116, "ascii");
  const sizeText = size.toString(8).padStart(11, "0");
  bytes.write(`${sizeText}\0`, 124, "ascii");
  bytes.write("00000000000\0", 136, "ascii");
  bytes[156] = 0x30;
  bytes.write("ustar\0", 257, "ascii");
  bytes.write("00", 263, "ascii");
  bytes.write(prefix, 345, "utf8");
  bytes.fill(0x20, 148, 156);
  let checksum = 0;
  for (const value of bytes) checksum += value;
  bytes.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return bytes;
}

/**
 * Build the bounded release archive consumed by verifyReleaseLicenseArchive.
 * The caller supplies already-attested bytes; this helper never invents a
 * rights record or uses a caller-supplied digest as content.
 */
export function createReleaseLicenseArchive(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > RELEASE_LICENSE_ARTIFACT_MAX_ENTRIES) {
    throw new Error("release license archive requires a bounded non-empty entry list");
  }
  const normalized = [];
  const seen = new Set();
  let uncompressedBytes = 0;
  for (const entry of entries) {
    const path = entry?.path;
    const bytes = Buffer.isBuffer(entry?.bytes)
      ? entry.bytes
      : entry?.bytes instanceof Uint8Array
        ? Buffer.from(entry.bytes)
        : typeof entry?.bytes === "string"
          ? Buffer.from(entry.bytes, "utf8")
          : null;
    if (!safeArchivePath(path) || !bytes || seen.has(path)) throw new Error(`invalid or duplicate release archive entry: ${String(path)}`);
    // Preserve ordinary source permission bits when the caller supplies them;
    // special file bits and non-regular tar members are never admitted.
    const mode = entry?.mode === undefined ? 0o644 : entry.mode;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error(`release archive entry mode is unsupported: ${path}`);
    if (bytes.length > RELEASE_LICENSE_ARTIFACT_MAX_ENTRY_BYTES) throw new Error(`release archive entry exceeds the bounded size: ${path}`);
    const padding = (512 - (bytes.length % 512)) % 512;
    const tarEntryBytes = 512 + bytes.length + padding;
    if (uncompressedBytes + tarEntryBytes + 1024 > RELEASE_LICENSE_ARTIFACT_MAX_UNCOMPRESSED_BYTES) {
      throw new Error("release license archive exceeds the bounded uncompressed size");
    }
    seen.add(path);
    uncompressedBytes += tarEntryBytes;
    normalized.push({ path, bytes, mode });
  }
  normalized.sort((left, right) => left.path.localeCompare(right.path));
  const chunks = [];
  for (const entry of normalized) {
    chunks.push(tarHeader({ path: entry.path, size: entry.bytes.length, mode: entry.mode }));
    chunks.push(entry.bytes);
    const padding = (512 - (entry.bytes.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  const tar = Buffer.concat(chunks);
  if (tar.length !== uncompressedBytes + 1024 || tar.length > RELEASE_LICENSE_ARTIFACT_MAX_UNCOMPRESSED_BYTES) {
    throw new Error("release license archive exceeded the bounded tar size");
  }
  const archive = gzipSync(tar, { mtime: 0 });
  if (archive.length === 0 || archive.length > RELEASE_LICENSE_ARTIFACT_MAX_ARCHIVE_BYTES || tar.length > archive.length * RELEASE_LICENSE_ARTIFACT_MAX_COMPRESSION_RATIO) {
    throw new Error("release license archive exceeded the bounded gzip size or compression ratio");
  }
  return archive;
}

/**
 * Parse archive bytes independently and return the complete regular-file
 * universe. expectedFiles is only a comparison target; returned files always
 * come from archive member bytes and hashes.
 */
export function verifyReleaseLicenseArchive(archiveBytes, { expectedFiles = null } = {}) {
  const bytes = Buffer.isBuffer(archiveBytes)
    ? archiveBytes
    : archiveBytes instanceof Uint8Array
      ? Buffer.from(archiveBytes)
      : null;
  const result = {
    verified: false,
    format: RELEASE_LICENSE_ARTIFACT_FORMAT,
    artifactSha256: bytes ? sha256(bytes) : null,
    files: [],
    modes: [],
    filesSha256: null,
    entryCount: 0,
    uncompressedBytes: 0,
    issues: []
  };
  if (!bytes) {
    result.issues.push(archiveIssue("ARCHIVE_BYTES_INVALID"));
    return result;
  }
  if (bytes.length === 0 || bytes.length > RELEASE_LICENSE_ARTIFACT_MAX_ARCHIVE_BYTES) {
    result.issues.push(archiveIssue("ARCHIVE_SIZE_OUT_OF_BOUNDS"));
    return result;
  }
  let tar;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: RELEASE_LICENSE_ARTIFACT_MAX_UNCOMPRESSED_BYTES });
  } catch {
    result.issues.push(archiveIssue("ARCHIVE_GZIP_INVALID"));
    return result;
  }
  if (tar.length === 0 || tar.length > RELEASE_LICENSE_ARTIFACT_MAX_UNCOMPRESSED_BYTES || tar.length > bytes.length * RELEASE_LICENSE_ARTIFACT_MAX_COMPRESSION_RATIO) {
    result.issues.push(archiveIssue("ARCHIVE_BOMB_BOUNDS"));
    return result;
  }
  result.uncompressedBytes = tar.length;
  let offset = 0;
  let consumedBytes = 0;
  let terminated = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (allZero(header)) {
      if (offset + 1024 > tar.length || !allZero(tar.subarray(offset + 512, offset + 1024))) {
        result.issues.push(archiveIssue("ARCHIVE_TERMINATOR_INVALID"));
      } else {
        terminated = true;
        offset += 1024;
        if (!allZero(tar.subarray(offset))) result.issues.push(archiveIssue("ARCHIVE_TRAILING_BYTES"));
      }
      break;
    }
    if (result.entryCount >= RELEASE_LICENSE_ARTIFACT_MAX_ENTRIES) {
      result.issues.push(archiveIssue("ARCHIVE_ENTRY_COUNT_OUT_OF_BOUNDS"));
      break;
    }
    const storedChecksum = readOctal(header.subarray(148, 156));
    let computedChecksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      computedChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (storedChecksum === null || storedChecksum !== computedChecksum) {
      result.issues.push(archiveIssue("ARCHIVE_CHECKSUM_INVALID"));
      break;
    }
    const name = decodeField(header.subarray(0, 100));
    const prefix = decodeField(header.subarray(345, 500));
    if (name === null || prefix === null) result.issues.push(archiveIssue("ARCHIVE_PATH_ENCODING_INVALID"));
    const path = name !== null && prefix !== null && name && prefix ? `${prefix}/${name}` : name;
    const typeflag = header[156];
    const mode = readOctal(header.subarray(100, 108));
    const size = readOctal(header.subarray(124, 136));
    if (!path || !safeArchivePath(path)) result.issues.push(archiveIssue("ARCHIVE_PATH_UNSAFE", path));
    if (typeflag !== 0 && typeflag !== 0x30) result.issues.push(archiveIssue("ARCHIVE_NONREGULAR_ENTRY", path ?? null));
    if (mode === null || mode > 0o777) result.issues.push(archiveIssue("ARCHIVE_MODE_INVALID", path ?? null));
    if (size === null || size > RELEASE_LICENSE_ARTIFACT_MAX_ENTRY_BYTES) {
      result.issues.push(archiveIssue("ARCHIVE_ENTRY_SIZE_OUT_OF_BOUNDS", path ?? null));
      break;
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const padding = (512 - (size % 512)) % 512;
    const tarEntryBytes = 512 + size + padding;
    if (consumedBytes + tarEntryBytes + 1024 > RELEASE_LICENSE_ARTIFACT_MAX_UNCOMPRESSED_BYTES) {
      result.issues.push(archiveIssue("ARCHIVE_UNCOMPRESSED_SIZE_OUT_OF_BOUNDS", path ?? null));
      break;
    }
    if (dataEnd + padding > tar.length) {
      result.issues.push(archiveIssue("ARCHIVE_ENTRY_TRUNCATED", path ?? null));
      break;
    }
    const data = tar.subarray(dataStart, dataEnd);
    if (!allZero(tar.subarray(dataEnd, dataEnd + padding))) result.issues.push(archiveIssue("ARCHIVE_PADDING_INVALID", path ?? null));
    if (path && safeArchivePath(path) && (typeflag === 0 || typeflag === 0x30)) {
      if (result.files.some((entry) => entry.path === path)) result.issues.push(archiveIssue("ARCHIVE_DUPLICATE_PATH", path));
      else {
        result.files.push({ path, sha256: sha256(data) });
        result.modes.push({ path, mode });
      }
    }
    result.entryCount += 1;
    consumedBytes += tarEntryBytes;
    offset = dataEnd + padding;
  }
  if (!terminated) result.issues.push(archiveIssue("ARCHIVE_TERMINATOR_MISSING"));
  if (result.files.length === 0) result.issues.push(archiveIssue("ARCHIVE_FILE_UNIVERSE_EMPTY"));
  result.files.sort((left, right) => left.path.localeCompare(right.path));
  result.modes.sort((left, right) => left.path.localeCompare(right.path));
  result.filesSha256 = result.files.length > 0 ? stableFilesDigest(result.files) : null;
  const expectedIssue = expectedFiles === null ? null : compareFileLists(result.files, result.modes, expectedFiles);
  if (expectedIssue) result.issues.push(expectedIssue);
  result.verified = result.issues.length === 0 && (expectedFiles === null || expectedIssue === null);
  return result;
}
