#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// This file is safe only when invoked by the externally verified root-owned launcher.
import { constants as fsConstants } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";

const INSTALL = "/private/var/db/better-workflows/runtime-verifier-v2";
const NODE = `${INSTALL}/node`;
const LAUNCHER = `${INSTALL}/runtime-qualification-launch-v2.sh`;
const MANIFEST = `${INSTALL}/bootstrap-v2.json`;
const BUNDLE = `${INSTALL}/bundle`;
const GATE = `${BUNDLE}/plugins/better-workflows/scripts/runtime-qualification-gate-v2.mjs`;
const GATE_REL = "plugins/better-workflows/scripts/runtime-qualification-gate-v2.mjs";
const CORE_REL = "plugins/better-workflows/scripts/lib/core.mjs";
const CONSUMER_REL = "plugins/better-workflows/scripts/lib/runtime-qualification-verifier-v2.mjs";
const ALLOWED_ENV = new Set([
  "PATH", "LC_ALL", "LANG", "HOME", "SBW_RELEASE_REVISION", "SBW_CONFORMANCE_RUN_ID",
  "SBW_PUBLIC_SOURCE_ROOT", "SBW_RUNTIME_ARTIFACT_DIR", "SBW_STATE_ROOT"
]);
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_NODE_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_FILES = 16_384;
const MAX_BUNDLE_DIRECTORIES = 8_192;
const MAX_BUNDLE_ENTRIES = 32_768;
const MAX_BUNDLE_DEPTH = 128;
const MAX_BUNDLE_PATH_BYTES = 4_096;
const MAX_BUNDLE_TOTAL_PATH_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_PATH_SNAPSHOTS = MAX_BUNDLE_ENTRIES + MAX_BUNDLE_DEPTH + 256;
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const stampKeys = ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "ctimeNs", "mtimeNs"];
const stamp = (s) => Object.fromEntries(stampKeys.map((k) => [k, String(s[k])]));
const sameStamp = (a, b) => JSON.stringify(stamp(a)) === JSON.stringify(stamp(b));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let aclCache = new Map();
function fail() { throw new Error("Runtime V2 bootstrap HOLD"); }

function assertStartupBoundary() {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) || process.execArgv.length !== 0 ||
      process.argv.length !== 2 || process.argv[1] !== GATE || process.execPath !== NODE ||
      process.env.PATH !== "/usr/bin:/bin" || process.env.LC_ALL !== "C" || process.env.LANG !== "C") fail();
  for (const key of Object.keys(process.env)) if (!ALLOWED_ENV.has(key)) fail();
  const home = process.env.HOME;
  if (typeof home !== "string" || !home || !path.isAbsolute(home) || path.resolve(home) !== home || /[\r\n\0]/.test(home)) fail();
  if (["NODE_OPTIONS", "NODE_PATH"].some((k) => Object.hasOwn(process.env, k)) ||
      Object.keys(process.env).some((k) => k.startsWith("DYLD_") || k.startsWith("LD_"))) fail();
}

function assertNoAcl(file, observedStamp) {
  const key = JSON.stringify(observedStamp);
  if (aclCache.get(file) === key) return;
  const output = execFileSync("/bin/ls", ["-lde", file], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
  });
  const lines = output.replace(/\r/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const mode = lines[0]?.trimStart().split(/\s+/, 1)[0] ?? "";
  const modeWithoutXattrMarker = mode.endsWith("@") ? mode.slice(0, -1) : mode;
  // On macOS '@' marks extended attributes, not an ACL; '+' and ACL lines are rejected.
  if (lines.length !== 1 || mode.includes("+") || !/^[d-][rwxStTs-]{9}$/.test(modeWithoutXattrMarker)) fail();
  aclCache.set(file, key);
}

async function assertRootPath(file, leafKind) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || /[\r\n\0]/.test(file)) fail();
  const root = path.parse(file).root;
  let current = root;
  const components = file.slice(root.length).split(path.sep).filter(Boolean);
  const paths = [root];
  for (const part of components) { current = path.join(current, part); paths.push(current); }
  const identities = [];
  for (let i = 0; i < paths.length; i += 1) {
    const p = paths[i];
    const leaf = i === paths.length - 1;
    const s = await lstat(p, { bigint: true });
    const wantsDirectory = !leaf || leafKind === "directory";
    if (s.isSymbolicLink() || s.uid !== 0n || (s.mode & 0o022n) !== 0n || (s.mode & 0o7000n) !== 0n ||
        (wantsDirectory ? !s.isDirectory() : !s.isFile()) || (!wantsDirectory && s.nlink !== 1n) ||
        await realpath(p) !== p) fail();
    const observedStamp = stamp(s);
    assertNoAcl(p, observedStamp);
    identities.push({ path: p, stamp: observedStamp });
  }
  return identities;
}

async function hashRootFile(file, maxBytes, { bytes: wantBytes = false, executable = false, allowEmpty = false } = {}) {
  const pathsBefore = await assertRootPath(file, "file");
  if (!Number.isInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW <= 0) fail();
  const beforePath = await lstat(file, { bigint: true });
  const h = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const before = await h.stat({ bigint: true });
    const size = Number(before.size);
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & 0o022n) !== 0n ||
        (before.mode & 0o7000n) !== 0n || !sameStamp(beforePath, before) || !Number.isSafeInteger(size) ||
        size < (allowEmpty ? 0 : 1) || size > maxBytes || (executable && (before.mode & 0o111n) === 0n)) fail();
    const digest = createHash("sha256");
    const chunks = wantBytes ? [] : null;
    const buffer = Buffer.alloc(Math.max(1, Math.min(CHUNK_BYTES, size)));
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await h.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (bytesRead < 1) fail();
      const part = buffer.subarray(0, bytesRead);
      digest.update(part);
      if (chunks) chunks.push(Buffer.from(part));
      offset += bytesRead;
    }
    const afterFd = await h.stat({ bigint: true });
    const afterPath = await lstat(file, { bigint: true });
    const pathsAfter = await assertRootPath(file, "file");
    if (!sameStamp(before, afterFd) || !sameStamp(before, afterPath) ||
        JSON.stringify(pathsBefore) !== JSON.stringify(pathsAfter)) fail();
    return { sha256: digest.digest("hex"), size, mode: Number(before.mode & 0o777n).toString(8),
      identity: stamp(before), parentIdentities: pathsAfter, ...(chunks ? { bytes: Buffer.concat(chunks) } : {}) };
  } finally { await h.close(); }
}

function safeRelative(rel) {
  return typeof rel === "string" && rel.length > 0 && !rel.startsWith("/") && !rel.includes("\\") &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(rel) && rel.split("/").every((part) => part && part !== "." && part !== "..");
}
function decodeRawName(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > MAX_BUNDLE_PATH_BYTES || raw.includes(0) || raw.includes(0x2f)) fail();
  let name;
  try { name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); } catch { fail(); }
  if (Buffer.compare(Buffer.from(name, "utf8"), raw) !== 0 || !safeRelative(name)) fail();
  return name;
}
function addIdentitySnapshots(map, snapshots) {
  for (const item of snapshots) {
    const value = JSON.stringify(item.stamp);
    const prior = map.get(item.path);
    if (prior !== undefined && prior !== value) fail();
    map.set(item.path, value);
    if (map.size > MAX_BUNDLE_PATH_SNAPSHOTS) fail();
  }
}

async function captureBundle() {
  const identitiesByPath = new Map();
  const records = [];
  const seenFiles = new Map();
  let fileCount = 0;
  let directoryCount = 0;
  let entryCount = 0;
  let totalBytes = 0;
  let totalPathBytes = 0;
  let bundleDevice = null;
  function addRecordPath(rel) {
    const bytes = Buffer.byteLength(rel, "utf8");
    if (bytes > MAX_BUNDLE_PATH_BYTES) fail();
    totalPathBytes += bytes;
    if (totalPathBytes > MAX_BUNDLE_TOTAL_PATH_BYTES) fail();
  }
  async function walk(dir, rel, depth) {
    if (depth > MAX_BUNDLE_DEPTH) fail();
    const pathsBefore = await assertRootPath(dir, "directory");
    const before = await lstat(dir, { bigint: true });
    if (JSON.stringify(pathsBefore.at(-1)?.stamp) !== JSON.stringify(stamp(before))) fail();
    if (bundleDevice === null) bundleDevice = before.dev;
    else if (before.dev !== bundleDevice) fail();
    addIdentitySnapshots(identitiesByPath, pathsBefore);
    if (++directoryCount > MAX_BUNDLE_DIRECTORIES) fail();
    addRecordPath(rel);
    records.push({ path: rel, kind: "directory", mode: Number(before.mode & 0o777n).toString(8) });
    const directory = await opendir(dir, { encoding: "buffer", bufferSize: 64 });
    const entries = [];
    try {
      for (;;) {
        const entry = await directory.read();
        if (entry === null) break;
        if (++entryCount > MAX_BUNDLE_ENTRIES || !Buffer.isBuffer(entry.name)) fail();
        const rawName = Buffer.from(entry.name);
        const name = decodeRawName(rawName);
        entries.push({ entry, rawName, name });
      }
    } finally { await directory.close(); }
    entries.sort((a, b) => Buffer.compare(a.rawName, b.rawName));
    for (const { entry, name } of entries) {
      const childRel = rel === "." ? name : `${rel}/${name}`;
      if (!safeRelative(childRel) || Buffer.byteLength(childRel, "utf8") > MAX_BUNDLE_PATH_BYTES) fail();
      const full = path.join(dir, name);
      if (entry.isSymbolicLink()) fail();
      if (entry.isDirectory()) { await walk(full, childRel, depth + 1); continue; }
      if (!entry.isFile() || ++fileCount > MAX_BUNDLE_FILES) fail();
      addRecordPath(childRel);
      const obs = await hashRootFile(full, MAX_BUNDLE_FILE_BYTES, { allowEmpty: true });
      if (obs.identity.dev !== String(bundleDevice)) fail();
      totalBytes += obs.size;
      if (totalBytes > MAX_BUNDLE_BYTES) fail();
      addIdentitySnapshots(identitiesByPath, obs.parentIdentities);
      records.push({ path: childRel, kind: "file", mode: obs.mode, size: obs.size, sha256: obs.sha256 });
      seenFiles.set(childRel, obs.sha256);
    }
    const after = await lstat(dir, { bigint: true });
    const pathsAfter = await assertRootPath(dir, "directory");
    if (!sameStamp(before, after) || JSON.stringify(pathsBefore) !== JSON.stringify(pathsAfter)) fail();
  }
  await walk(BUNDLE, ".", 0);
  records.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  const identities = [...identitiesByPath.entries()].map(([path, encodedStamp]) => ({ path, stamp: JSON.parse(encodedStamp) }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  const treeSha256 = sha256(Buffer.from(JSON.stringify(records), "utf8"));
  return { treeSha256, records, identities, files: seenFiles };
}

function parseManifest(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail(); }
  const sortedKeys = ["bundleTreeSha256", "gateSha256", "kind", "launcherSha256", "nodeSha256", "schemaVersion"];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(sortedKeys)) fail();
  const manifest = {
    bundleTreeSha256: parsed.bundleTreeSha256,
    gateSha256: parsed.gateSha256,
    kind: parsed.kind,
    launcherSha256: parsed.launcherSha256,
    nodeSha256: parsed.nodeSha256,
    schemaVersion: parsed.schemaVersion
  };
  if (manifest.schemaVersion !== 1 || manifest.kind !== "RuntimeVerifierBootstrapManifestV2" ||
      !SHA256.test(manifest.nodeSha256) || !SHA256.test(manifest.gateSha256) ||
      !SHA256.test(manifest.launcherSha256) || !SHA256.test(manifest.bundleTreeSha256) ||
      text !== JSON.stringify(manifest)) fail();
  return manifest;
}

async function captureInstallation() {
  aclCache = new Map();
  if (process.execPath !== NODE || await realpath(process.execPath) !== NODE ||
      await realpath(process.argv[1]) !== GATE) fail();
  const manifestObs = await hashRootFile(MANIFEST, MAX_MANIFEST_BYTES, { bytes: true });
  const manifest = parseManifest(manifestObs.bytes);
  const nodeObs = await hashRootFile(NODE, MAX_NODE_BYTES, { executable: true });
  const launcherObs = await hashRootFile(LAUNCHER, 1024 * 1024, { executable: true });
  const bundle = await captureBundle();
  if (nodeObs.sha256 !== manifest.nodeSha256 || launcherObs.sha256 !== manifest.launcherSha256 ||
      bundle.files.get(GATE_REL) !== manifest.gateSha256 || bundle.treeSha256 !== manifest.bundleTreeSha256 ||
      !bundle.files.has(CORE_REL) || !bundle.files.has(CONSUMER_REL)) fail();
  const observations = {
    manifest: { sha256: manifestObs.sha256, identity: manifestObs.identity, parentIdentities: manifestObs.parentIdentities },
    node: { sha256: nodeObs.sha256, identity: nodeObs.identity, parentIdentities: nodeObs.parentIdentities },
    launcher: { sha256: launcherObs.sha256, identity: launcherObs.identity, parentIdentities: launcherObs.parentIdentities },
    bundleTreeSha256: bundle.treeSha256, bundleRecords: bundle.records, bundleIdentities: bundle.identities
  };
  return { manifest, observations, snapshotSha256: sha256(Buffer.from(JSON.stringify(observations), "utf8")) };
}

async function assertCurrentSnapshot(first) {
  const second = await captureInstallation();
  if (second.snapshotSha256 !== first.snapshotSha256) fail();
}
function required(name, pattern) {
  const value = process.env[name];
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) fail();
  return value;
}
function requiredPath(name) {
  const value = required(name);
  if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/.test(value)) fail();
  return value;
}

async function main() {
  let first;
  try {
    assertStartupBoundary();
    first = await captureInstallation();
  } catch {
    process.stderr.write("Runtime V2 bootstrap HOLD; no audit receipt written\n");
    process.exitCode = 1;
    return;
  }

  let core;
  let consumer;
  let receipt;
  let sourceRevision;
  try {
    // Literal relative specifiers keep the public module-closure scanner resolvable.
    core = await import("./lib/core.mjs");
    consumer = await import("./lib/runtime-qualification-verifier-v2.mjs");
    sourceRevision = required("SBW_RELEASE_REVISION", /^[a-f0-9]{40}$/);
    const runId = required("SBW_CONFORMANCE_RUN_ID", /^[1-9][0-9]*$/);
    const sourceRoot = requiredPath("SBW_PUBLIC_SOURCE_ROOT");
    const artifactDirectory = requiredPath("SBW_RUNTIME_ARTIFACT_DIR");
    const stateRoot = requiredPath("SBW_STATE_ROOT");
    receipt = await consumer.verifyRuntimeQualificationV2({ sourceRevision, sourceRoot, runId, artifactDirectory });
    await assertCurrentSnapshot(first);
    const outputPath = core.safeJoin(stateRoot, "release-gates", sourceRevision, "runtime-qualification-v2.json");
    await core.atomicWriteJson(stateRoot, outputPath, receipt);
    process.stdout.write(`${JSON.stringify({ result: "PASS", outputPath, receiptDigest: receipt.receiptDigest,
      lanes: receipt.receipts.length, fullEvaluatorIncluded: false, releaseAuthority: "none" })}\n`);
  } catch {
    try {
      await assertCurrentSnapshot(first);
      process.stdout.write(`${JSON.stringify({ result: "HOLD", reason: "runtime verification failed",
        fullEvaluatorIncluded: false, releaseAuthority: "none" })}\n`);
    } catch {
      process.stderr.write("Runtime V2 installation drift; no trusted audit result\n");
    }
    process.exitCode = 1;
  }
}
await main();
