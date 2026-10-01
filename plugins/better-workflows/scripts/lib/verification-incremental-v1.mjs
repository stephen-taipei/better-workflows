import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, readlink, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, digestObject, sha256 } from "./core.mjs";

export const INCREMENTAL_VERIFICATION_SCHEMA_VERSION = 1;
export const DEPENDENCY_MANIFEST_KIND = "DependencyFingerprintManifestV1";
export const VERIFICATION_UNIT_KIND = "VerificationUnitV1";
export const VERIFICATION_RESULT_KIND = "VerificationResultV1";
export const CARRY_FORWARD_KIND = "CarryForwardV1";
export const VERIFICATION_ADMISSION_KIND = "VerificationAdmissionV1";
export const REVISION_FREEZE_BINDING_KIND = "RevisionFreezeBindingV1";
export const FULL_SHADOW_COMPARISON_KIND = "FullShadowComparisonV1";
export const PURE_LOCAL_VALIDATOR_KIND = "PureLocalFileValidatorV1";

const HEX_DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODES = new Set(["full", "shadow"]);
const RESULTS = new Set(["pass", "fail", "unknown"]);
const MAX_GLOB_PATHS = 100_000;
const MAX_GLOB_MATCHES = 10_000;

const TRUSTED_VALIDATOR = new WeakSet();
const TRUSTED_TOOL = new WeakSet();
const CAPTURED_MANIFEST = new WeakSet();
const CREATED_UNIT = new WeakSet();
const PRODUCED_RESULT = new WeakSet();
const SEALED_RESULT = new WeakSet();
const CURRENT_ADMISSION = new WeakSet();
const CREATED_CARRY_FORWARD = new WeakSet();
const TRUSTED_CI_RECEIPT = new WeakSet();
const VALIDATOR_SOURCE_PATH = "plugins/better-workflows/scripts/lib/verification-incremental-v1.mjs";
const VALIDATOR_SOURCE_FILE = fileURLToPath(import.meta.url);
const CAPTURED_SNAPSHOTS = new WeakMap();
let validatorSourceFingerprintPromise;
let toolBinaryFingerprintPromise;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function assertObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  return value;
}

function assertString(value, label, { nonEmpty = true } = {}) {
  if (typeof value !== "string" || (nonEmpty && value.length === 0) || value.includes("\0")) {
    fail(`${label} must be a ${nonEmpty ? "non-empty " : ""}string`);
  }
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !HEX_DIGEST.test(value)) fail(`${label} must be a sha256 digest`);
  return value;
}

function assertSafeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function assertJsonValue(value, label = "value", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} must contain finite numbers`);
    return value;
  }
  if (typeof value !== "object") fail(`${label} must contain JSON values only`);
  if (seen.has(value)) fail(`${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`, seen));
  else {
    for (const [key, item] of Object.entries(value)) {
      assertString(key, `${label} key`);
      if (item === undefined) fail(`${label}.${key} must not be undefined`);
      assertJsonValue(item, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
  return value;
}

function cloneJson(value, label) {
  assertJsonValue(value, label);
  return JSON.parse(canonicalJson(value));
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function mark(value, identitySet) {
  identitySet.add(value);
  return value;
}

function hasMark(value, identitySet) {
  return Boolean(value && identitySet.has(value));
}

function normalizeRelativePath(value, label) {
  assertString(value, label);
  const posix = value.replaceAll("\\", "/");
  if (posix.startsWith("/") || /^[A-Za-z]:\//.test(posix)) fail(`${label} must be relative`);
  const parts = posix.split("/");
  if (parts.some((part) => part === "..")) fail(`${label} must not traverse outside the root`);
  const normalized = path.posix.normalize(posix);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    fail(`${label} must identify a path inside the root`);
  }
  return normalized;
}

function normalizeGlob(value, label) {
  assertString(value, label);
  const posix = value.replaceAll("\\", "/");
  if (posix.startsWith("/") || /^[A-Za-z]:\//.test(posix)) fail(`${label} must be relative`);
  if (posix.split("/").some((part) => part === "..")) fail(`${label} must not traverse outside the root`);
  if (posix === "" || posix === ".") fail(`${label} must not be empty`);
  return posix;
}

function normalizeList(value, label, normalizer) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return [...new Set(value.map((item, index) => normalizer(item, `${label}[${index}]`)))].sort();
}

function normalizeDescriptor(value, label) {
  assertObject(value, label);
  return cloneJson(value, label);
}

function normalizeEnvironment(value) {
  if (value === undefined) fail("controlledEnvironment is required; ambient process.env is not admitted");
  const environment = normalizeDescriptor(value, "controlledEnvironment");
  for (const [key, item] of Object.entries(environment)) {
    if (!SAFE_ID.test(key) && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) fail(`controlledEnvironment.${key} is invalid`);
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean" && item !== null) {
      fail(`controlledEnvironment.${key} must be a scalar`);
    }
  }
  return environment;
}

function normalizePolicy(value) {
  if (value === undefined) fail("policy is required for current admission");
  return normalizeDescriptor(value, "policy");
}

function normalizeConfig(value, dependencies) {
  const config = value === undefined ? {} : normalizeDescriptor(value, "config");
  if (!Array.isArray(config.checks) || config.checks.length === 0) {
    fail("config.checks must contain at least one declared pure local semantic check");
  }
  const declaredFiles = new Set([
    ...(dependencies?.files ?? []),
    ...((dependencies?.indirect ?? []).flatMap((item) => item.files ?? []))
  ]);
  config.checks = config.checks.map((item, index) => {
    const label = `config.checks[${index}]`;
    assertObject(item, label);
    const allowed = new Set(["kind", "path", "requiredKeys", "substring"]);
    for (const key of Object.keys(item)) if (!allowed.has(key)) fail(`${label}.${key} is not allowed`);
    const kind = assertString(item.kind, `${label}.kind`);
    const relative = normalizeRelativePath(item.path, `${label}.path`);
    if (!declaredFiles.has(relative)) fail(`${label}.path must be an explicit dependency file`);
    if (kind === "json-object") {
      if (!Array.isArray(item.requiredKeys)) fail(`${label}.requiredKeys must be an array`);
      const requiredKeys = [...new Set(item.requiredKeys.map((key, keyIndex) => assertString(key, `${label}.requiredKeys[${keyIndex}]`)))].sort();
      return { kind, path: relative, requiredKeys };
    }
    if (kind === "text-contains") {
      return { kind, path: relative, substring: assertString(item.substring, `${label}.substring`) };
    }
    fail(`${label}.kind must be json-object or text-contains`);
  });
  return config;
}

function normalizeBinding(value, label) {
  if (value === undefined || value === null) return { kind: "unspecified", digest: null };
  if (typeof value === "string") return { kind: "digest", digest: assertDigest(value, label) };
  const binding = normalizeDescriptor(value, label);
  if (binding.digest !== undefined) {
    assertDigest(binding.digest, `${label}.digest`);
    const withoutDigest = { ...binding };
    delete withoutDigest.digest;
    if (binding.digest !== digestObject(withoutDigest)) fail(`${label}.digest does not match its contents`);
    return binding;
  }
  return { ...binding, digest: digestObject(binding) };
}

function normalizeRevisionDigest(value, label) {
  if (value === undefined || value === null) return null;
  return assertDigest(value, label);
}

function publicValidator(value) {
  if (!hasMark(value, TRUSTED_VALIDATOR)) {
    fail("A trusted pure/reproducible validator descriptor is required; caller metadata cannot establish trust");
  }
  const descriptor = cloneJson(value, "validator");
  if (descriptor.kind !== PURE_LOCAL_VALIDATOR_KIND || descriptor.pure !== true || descriptor.reproducible !== true ||
      descriptor.trusted !== true || descriptor.effects !== false) {
    fail("Only the trusted pure local validator is admitted in this slice");
  }
  const unsigned = { ...descriptor };
  delete unsigned.digest;
  if (descriptor.digest !== digestObject(unsigned)) fail("Trusted validator digest does not match its contents");
  return descriptor;
}

function publicTool(value) {
  if (!hasMark(value, TRUSTED_TOOL)) {
    fail("A trusted tool binary descriptor is required; caller metadata cannot establish tool identity");
  }
  const descriptor = cloneJson(value, "toolBinary");
  if (descriptor.kind !== "builtin" || descriptor.reproducible !== true || descriptor.path !== null) {
    fail("Only the builtin pure local tool descriptor is admitted in this slice");
  }
  const unsigned = { ...descriptor };
  delete unsigned.digest;
  if (descriptor.digest !== digestObject(unsigned)) fail("Trusted tool digest does not match its contents");
  return descriptor;
}

const PURE_LOCAL_VALIDATOR_UNSIGNED = {
  schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
  kind: PURE_LOCAL_VALIDATOR_KIND,
  id: "better-workflows.pure-local-file-v1",
  version: 1,
  producer: "better-workflows",
  trust: "builtin",
  trusted: true,
  pure: true,
  reproducible: true,
  effects: false
};

export const PURE_LOCAL_VALIDATOR = deepFreeze(mark({
  ...PURE_LOCAL_VALIDATOR_UNSIGNED,
  digest: digestObject(PURE_LOCAL_VALIDATOR_UNSIGNED)
}, TRUSTED_VALIDATOR));

const PURE_LOCAL_TOOL_UNSIGNED = {
  schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
  kind: "builtin",
  id: "better-workflows.node-pure-local-runtime-v1",
  version: 1,
  path: null,
  reproducible: true
};

export const PURE_LOCAL_TOOL_BINARY = deepFreeze(mark({
  ...PURE_LOCAL_TOOL_UNSIGNED,
  digest: digestObject(PURE_LOCAL_TOOL_UNSIGNED)
}, TRUSTED_TOOL));

function dependencyDescriptor(value) {
  const dependencies = value === undefined ? {} : assertObject(value, "dependencies");
  const files = normalizeList(dependencies.files, "dependencies.files", normalizeRelativePath);
  const globs = normalizeList(dependencies.globs, "dependencies.globs", normalizeGlob);
  const indirectInput = dependencies.indirect === undefined ? [] : dependencies.indirect;
  if (!Array.isArray(indirectInput)) fail("dependencies.indirect must be an array");
  const ids = new Set();
  const indirect = indirectInput.map((item, index) => {
    const label = `dependencies.indirect[${index}]`;
    if (!isObject(item)) fail(`${label} must be an object; opaque indirect dependencies are unknown`);
    const id = assertSafeId(item.id, `${label}.id`);
    if (ids.has(id)) fail(`Duplicate indirect dependency id: ${id}`);
    ids.add(id);
    const normalized = {
      id,
      files: normalizeList(item.files, `${label}.files`, normalizeRelativePath),
      globs: normalizeList(item.globs, `${label}.globs`, normalizeGlob),
      unknown: item.unknown === true,
      reason: item.reason === undefined || item.reason === null ? null : assertString(item.reason, `${label}.reason`)
    };
    if (normalized.files.length === 0 && normalized.globs.length === 0 && !normalized.unknown) {
      fail(`${label} must declare files/globs or unknown: true`);
    }
    return normalized;
  }).sort((left, right) => left.id.localeCompare(right.id));
  const unknownDependencies = normalizeList(dependencies.unknown, "dependencies.unknown", (item, label) => assertString(item, label));
  return { files, globs, indirect, unknown: unknownDependencies };
}

function globToRegExp(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          expression += "(?:[^/]+/)*";
        } else expression += ".*";
      } else expression += "[^/]*";
    } else if (char === "?") expression += "[^/]";
    else if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) expression += "\\[";
      else {
        const body = pattern.slice(index + 1, end);
        if (!body || body.includes("\\")) expression += "\\[";
        else expression += `[${body.replaceAll("]", "\\]")}]`;
        index = end;
      }
    } else expression += /[\\^$+.()|{}]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${expression}$`);
}

async function walkRelative(root) {
  const paths = [];
  async function visit(directory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      error.code = error.code ?? "GLOB_READ_FAILED";
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      paths.push(relative);
      if (paths.length > MAX_GLOB_PATHS) fail(`Glob enumeration exceeded ${MAX_GLOB_PATHS} paths`);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
    }
  }
  await visit(root, "");
  return paths;
}

async function enumerateGlob(root, pattern) {
  const all = await walkRelative(root);
  const matches = all.filter((candidate) => globToRegExp(pattern).test(candidate));
  if (matches.length > MAX_GLOB_MATCHES) fail(`Glob ${pattern} exceeded ${MAX_GLOB_MATCHES} matches`);
  return matches.sort();
}

function gitMode(info) {
  return info.mode & 0o7777;
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function stableFileFingerprint(file, reportedPath) {
  let info = await lstat(file);
  if (info.isSymbolicLink()) {
    const resolved = await realpath(file);
    info = await lstat(resolved);
    file = resolved;
  }
  if (!info.isFile()) return { path: reportedPath, type: "unknown", mode: gitMode(info), size: null, bytesDigest: null, status: "unknown", unknownReason: "tool-is-not-regular-file" };
  const bytes = await readFile(file);
  const after = await lstat(file);
  if (!sameStat(info, after)) return { path: reportedPath, type: "file", mode: gitMode(after), size: bytes.length, bytesDigest: sha256(bytes), status: "unknown", unknownReason: "unstable-tool-read" };
  return { path: reportedPath, type: "file", mode: gitMode(info), size: bytes.length, bytesDigest: sha256(bytes), status: "known", unknownReason: null };
}

async function validatorSourceFingerprint() {
  if (!validatorSourceFingerprintPromise) {
    validatorSourceFingerprintPromise = stableFileFingerprint(VALIDATOR_SOURCE_FILE, VALIDATOR_SOURCE_PATH).catch((error) => ({
      path: VALIDATOR_SOURCE_PATH,
      type: "unknown",
      mode: null,
      size: null,
      bytesDigest: null,
      status: "unknown",
      unknownReason: error.code ?? "validator-source-read-failed"
    }));
  }
  return validatorSourceFingerprintPromise;
}

async function toolBinaryFingerprint() {
  if (!toolBinaryFingerprintPromise) {
    toolBinaryFingerprintPromise = (async () => {
      const resolved = await realpath(process.execPath);
      return stableFileFingerprint(resolved, resolved);
    })().catch((error) => ({
      path: process.execPath,
      type: "unknown",
      mode: null,
      size: null,
      bytesDigest: null,
      status: "unknown",
      unknownReason: error.code ?? "tool-binary-read-failed"
    }));
  }
  return toolBinaryFingerprintPromise;
}

function isWithinPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function unknownDependencyFingerprint(relative, reason, { type = "unknown", mode = null, size = null, target = null } = {}) {
  return {
    path: relative,
    type,
    mode,
    size,
    bytesDigest: null,
    target,
    status: "unknown",
    unknownReason: reason
  };
}

async function canonicalDependencyRoot(root) {
  let before;
  try {
    before = await lstat(root);
  } catch (error) {
    return { root: null, reason: error.code ?? "root-lstat-failed" };
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    return { root: null, reason: "root-must-be-real-directory" };
  }
  let canonical;
  try {
    canonical = await realpath(root);
  } catch (error) {
    return { root: null, reason: error.code ?? "root-realpath-failed" };
  }
  let after;
  try {
    after = await lstat(root);
  } catch (error) {
    return { root: null, reason: error.code ?? "root-lstat-after-realpath-failed" };
  }
  if (after.isSymbolicLink() || !after.isDirectory() || !sameStat(before, after)) {
    return { root: null, reason: "root-path-race" };
  }
  return { root: canonical, reason: null };
}

function symlinkFingerprint(root, relative, absolute, info, componentKind) {
  return readlink(absolute, "utf8").then((target) => {
    const lexicalTarget = path.resolve(path.dirname(absolute), target);
    const targetReason = isWithinPath(root, lexicalTarget)
      ? "symlink-target-not-followed"
      : "symlink-target-escapes-root";
    return unknownDependencyFingerprint(relative, `${componentKind}-${targetReason}`, {
      type: "symlink",
      mode: gitMode(info),
      target
    });
  }).catch((error) => unknownDependencyFingerprint(relative, `${componentKind}-${error.code ?? "symlink-read-failed"}`, {
    type: "symlink",
    mode: gitMode(info)
  }));
}

async function inspectDependencyPath(root, relative) {
  const rootResult = await canonicalDependencyRoot(root);
  if (rootResult.root === null) {
    return {
      root: null,
      absolute: null,
      resolvedPath: null,
      identities: [],
      terminal: "unknown",
      fingerprint: unknownDependencyFingerprint(relative, rootResult.reason)
    };
  }
  const canonicalRoot = rootResult.root;
  const components = relative.split("/");
  let current = canonicalRoot;
  const identities = [];
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {
          root: canonicalRoot,
          absolute: current,
          resolvedPath: null,
          identities,
          terminal: "missing",
          fingerprint: {
            path: relative,
            type: "missing",
            mode: null,
            size: null,
            bytesDigest: null,
            target: null,
            status: "known",
            unknownReason: null
          }
        };
      }
      return {
        root: canonicalRoot,
        absolute: current,
        resolvedPath: null,
        identities,
        terminal: "unknown",
        fingerprint: unknownDependencyFingerprint(relative, error.code ?? "lstat-failed")
      };
    }
    const isLast = index === components.length - 1;
    identities.push({ path: current, info });
    if (info.isSymbolicLink()) {
      return {
        root: canonicalRoot,
        absolute: current,
        resolvedPath: null,
        identities,
        terminal: "symlink",
        fingerprint: await symlinkFingerprint(canonicalRoot, relative, current, info, isLast ? "symlink-dependency" : "symlink-parent")
      };
    }
    if (!isLast && !info.isDirectory()) {
      return {
        root: canonicalRoot,
        absolute: current,
        resolvedPath: null,
        identities,
        terminal: "unknown",
        fingerprint: unknownDependencyFingerprint(relative, "parent-not-directory", {
          type: info.isFile() ? "file" : "other",
          mode: gitMode(info),
          size: info.isFile() ? info.size : null
        })
      };
    }
    if (isLast) {
      let resolvedPath;
      try {
        resolvedPath = await realpath(current);
      } catch (error) {
        return {
          root: canonicalRoot,
          absolute: current,
          resolvedPath: null,
          identities,
          terminal: "unknown",
          fingerprint: unknownDependencyFingerprint(relative, error.code ?? "path-realpath-failed", {
            type: info.isFile() ? "file" : "unknown",
            mode: gitMode(info),
            size: info.isFile() ? info.size : null
          })
        };
      }
      if (!isWithinPath(canonicalRoot, resolvedPath)) {
        return {
          root: canonicalRoot,
          absolute: current,
          resolvedPath,
          identities,
          terminal: "unknown",
          fingerprint: unknownDependencyFingerprint(relative, "resolved-path-escapes-root", {
            type: info.isFile() ? "file" : "unknown",
            mode: gitMode(info),
            size: info.isFile() ? info.size : null
          })
        };
      }
      if (info.isDirectory()) {
        return {
          root: canonicalRoot,
          absolute: current,
          resolvedPath,
          identities,
          terminal: "directory",
          fingerprint: unknownDependencyFingerprint(relative, "directory-content-requires-declared-glob", {
            type: "directory",
            mode: gitMode(info)
          })
        };
      }
      if (!info.isFile()) {
        return {
          root: canonicalRoot,
          absolute: current,
          resolvedPath,
          identities,
          terminal: "other",
          fingerprint: unknownDependencyFingerprint(relative, "non-regular-file", {
            type: "other",
            mode: gitMode(info)
          })
        };
      }
      return {
        root: canonicalRoot,
        absolute: current,
        resolvedPath,
        identities,
        terminal: "file",
        info,
        fingerprint: {
          path: relative,
          type: "file",
          mode: gitMode(info),
          size: info.size,
          bytesDigest: null,
          target: null,
          status: "known",
          unknownReason: null
        }
      };
    }
  }
  return {
    root: canonicalRoot,
    absolute: current,
    resolvedPath: null,
    identities,
    terminal: "unknown",
    fingerprint: unknownDependencyFingerprint(relative, "path-inspection-incomplete")
  };
}

function samePathInspection(left, right) {
  if (!left || !right || left.root !== right.root || left.terminal !== right.terminal ||
      left.fingerprint.type !== right.fingerprint.type || left.fingerprint.status !== right.fingerprint.status ||
      left.identities.length !== right.identities.length) return false;
  return left.identities.every((identity, index) => {
    const other = right.identities[index];
    return identity.path === other.path && sameStat(identity.info, other.info);
  });
}

function dependencySnapshotFingerprint(relative, inspection, bytes = null) {
  if (inspection.fingerprint.type !== "file" || inspection.fingerprint.status !== "known") {
    return inspection.fingerprint;
  }
  return {
    ...inspection.fingerprint,
    size: bytes === null ? inspection.fingerprint.size : bytes.length,
    bytesDigest: bytes === null ? null : sha256(bytes),
    status: bytes === null ? "unknown" : "known",
    unknownReason: bytes === null ? "dependency-bytes-unavailable" : null
  };
}

async function readDependencySnapshot(root, relative) {
  const before = await inspectDependencyPath(root, relative);
  if (before.terminal !== "file") return { fingerprint: before.fingerprint, bytes: null };
  let handle;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(before.absolute, flags);
    const opened = await handle.stat();
    if (!sameStat(before.info, opened)) {
      return { fingerprint: unknownDependencyFingerprint(relative, "path-race"), bytes: null };
    }
    const resolvedBefore = await realpath(before.absolute);
    if (resolvedBefore !== before.resolvedPath || !isWithinPath(before.root, resolvedBefore)) {
      return { fingerprint: unknownDependencyFingerprint(relative, "resolved-path-race"), bytes: null };
    }
    const beforeRead = await inspectDependencyPath(root, relative);
    if (!samePathInspection(before, beforeRead)) {
      return { fingerprint: unknownDependencyFingerprint(relative, "path-race"), bytes: null };
    }
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat();
    const after = await inspectDependencyPath(root, relative);
    if (!sameStat(opened, afterHandle) || !samePathInspection(before, after)) {
      return { fingerprint: unknownDependencyFingerprint(relative, "unstable-read"), bytes: null };
    }
    return { fingerprint: dependencySnapshotFingerprint(relative, after, bytes), bytes };
  } catch (error) {
    const current = await inspectDependencyPath(root, relative).catch(() => null);
    if (current?.fingerprint?.type === "symlink") return { fingerprint: current.fingerprint, bytes: null };
    return { fingerprint: unknownDependencyFingerprint(relative, error.code ?? "read-failed"), bytes: null };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function entryProjection(entry) {
  return {
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    size: entry.size,
    bytesDigest: entry.bytesDigest,
    target: entry.target ?? null,
    status: entry.status,
    unknownReason: entry.unknownReason ?? null,
    origins: entry.origins
  };
}

function addOrigin(map, relative, origin) {
  const existing = map.get(relative);
  if (existing) {
    existing.origins.push(origin);
    return;
  }
  map.set(relative, { path: relative, origins: [origin] });
}

function uniqueOrigins(origins) {
  const seen = new Set();
  return origins.filter((origin) => {
    const key = canonicalJson(origin);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function contentProjection(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    rootDigest: manifest.rootDigest,
    dependencies: manifest.dependencies,
    globListings: manifest.globListings,
    entries: manifest.entries.map(entryProjection),
    missing: manifest.missing,
    unknowns: manifest.unknowns,
    closureStatus: manifest.closureStatus,
    validator: manifest.validator,
    validatorSource: manifest.validatorSource,
    toolBinary: manifest.toolBinary,
    toolBinaryFingerprint: manifest.toolBinaryFingerprint,
    config: manifest.config,
    controlledEnvironment: manifest.controlledEnvironment,
    policy: manifest.policy,
    sourceBinding: manifest.sourceBinding,
    relevantRevisionDigest: manifest.relevantRevisionDigest
  };
}

function cacheIdentity(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    kind: "IndependentComputeCacheKeyV1",
    rootDigest: manifest.rootDigest,
    dependencies: manifest.dependencies,
    globListings: manifest.globListings,
    entries: manifest.entries.map(entryProjection),
    missing: manifest.missing,
    unknowns: manifest.unknowns,
    closureStatus: manifest.closureStatus,
    validator: manifest.validator,
    validatorSource: manifest.validatorSource,
    toolBinary: manifest.toolBinary,
    toolBinaryFingerprint: manifest.toolBinaryFingerprint,
    configDigest: digestObject(manifest.config),
    controlledEnvironmentDigest: digestObject(manifest.controlledEnvironment),
    policyDigest: digestObject(manifest.policy),
    sourceBindingDigest: manifest.sourceBinding.digest,
    relevantRevisionDigest: manifest.relevantRevisionDigest
  };
}

function merkleRoot(values) {
  const leaves = values.length > 0 ? [...values].sort() : [digestObject({ empty: true })];
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1] ?? level[index];
      next.push(sha256(`merkle-v1\0${level[index]}\0${right}`));
    }
    level = next;
  }
  return level[0];
}

function addUnknown(unknowns, item) {
  const key = canonicalJson(item);
  if (!unknowns.some((existing) => canonicalJson(existing) === key)) unknowns.push(item);
}

async function collectEntry(root, selected, relative, origin, unknowns) {
  addOrigin(selected, relative, origin);
  if (selected.get(relative).fingerprint) return;
  const snapshot = await readDependencySnapshot(root, relative);
  selected.get(relative).fingerprint = snapshot.fingerprint;
  if (snapshot.bytes !== null) selected.get(relative).bytes = Buffer.from(snapshot.bytes);
  if (snapshot.fingerprint.status === "unknown") addUnknown(unknowns, { path: relative, reason: snapshot.fingerprint.unknownReason });
}

function makeGlobLabel(scope, dependencyId, pattern) {
  return `${scope}:${dependencyId ?? "direct"}:${pattern}`;
}

async function collectGlob(root, selected, globListings, pattern, origin, unknowns) {
  let matches;
  try {
    matches = await enumerateGlob(root, pattern);
  } catch (error) {
    const listing = {
      scope: origin.scope,
      dependencyId: origin.dependencyId,
      pattern,
      matches: [],
      missing: false,
      status: "unknown",
      error: error.code ?? "glob-enumeration-failed"
    };
    listing.listingDigest = digestObject(listing);
    globListings.push(listing);
    addUnknown(unknowns, { glob: makeGlobLabel(origin.scope, origin.dependencyId, pattern), reason: listing.error });
    return;
  }
  const listing = {
    scope: origin.scope,
    dependencyId: origin.dependencyId,
    pattern,
    matches,
    missing: matches.length === 0,
    status: "known",
    error: null
  };
  listing.listingDigest = digestObject(listing);
  globListings.push(listing);
  for (const relative of matches) await collectEntry(root, selected, relative, { ...origin, kind: "glob", pattern }, unknowns);
}

function finaliseEntries(selected) {
  return [...selected.values()].map((item) => {
    const entry = item.fingerprint;
    return {
      ...entry,
      origins: uniqueOrigins(item.origins)
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function projectManifestForComparison(manifest) {
  if (manifest?.manifestDigest === undefined) return validateComparisonProjection(manifest, "Dependency manifest comparison input");
  const verified = assertDependencyManifest(manifest, { requireCaptured: false });
  return {
    schemaVersion: verified.schemaVersion,
    kind: verified.kind,
    rootDigest: verified.rootDigest,
    dependencies: verified.dependencies,
    globListings: verified.globListings,
    entries: verified.entries,
    missing: verified.missing,
    unknowns: verified.unknowns,
    closureStatus: verified.closureStatus,
    validator: verified.validator,
    validatorSource: verified.validatorSource,
    toolBinary: verified.toolBinary,
    toolBinaryFingerprint: verified.toolBinaryFingerprint,
    config: verified.config,
    controlledEnvironment: verified.controlledEnvironment,
    policy: verified.policy,
    sourceBinding: verified.sourceBinding,
    relevantRevisionDigest: verified.relevantRevisionDigest,
    contentDigest: verified.contentDigest,
    cacheKey: verified.cacheKey
  };
}

function validateComparisonProjection(value, label) {
  assertObject(value, label);
  if (value.kind !== DEPENDENCY_MANIFEST_KIND || value.schemaVersion !== INCREMENTAL_VERIFICATION_SCHEMA_VERSION) {
    fail(`${label} is not a DependencyFingerprintManifestV1`);
  }
  for (const [field, fieldLabel] of [["validatorSource", "validator source"], ["toolBinaryFingerprint", "tool binary fingerprint"]]) {
    const fingerprint = value[field];
    if (!isObject(fingerprint) || typeof fingerprint.path !== "string" || !["file", "unknown"].includes(fingerprint.type) ||
        !["known", "unknown"].includes(fingerprint.status)) fail(`${label}.${fieldLabel} fingerprint is invalid`);
    if (fingerprint.status === "known") {
      assertDigest(fingerprint.bytesDigest, `${label}.${fieldLabel}.bytesDigest`);
      if (!Number.isSafeInteger(fingerprint.size) || fingerprint.size < 0) fail(`${label}.${fieldLabel}.size is invalid`);
    }
  }
  if (!HEX_DIGEST.test(value.contentDigest ?? "") || !HEX_DIGEST.test(value.cacheKey ?? "")) fail(`${label} digest is invalid`);
  const expectedContent = digestObject({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    rootDigest: value.rootDigest,
    dependencies: value.dependencies,
    globListings: value.globListings,
    entries: value.entries.map(entryProjection),
    missing: value.missing,
    unknowns: value.unknowns,
    closureStatus: value.closureStatus,
    validator: value.validator,
    validatorSource: value.validatorSource,
    toolBinary: value.toolBinary,
    toolBinaryFingerprint: value.toolBinaryFingerprint,
    config: value.config,
    controlledEnvironment: value.controlledEnvironment,
    policy: value.policy,
    sourceBinding: value.sourceBinding,
    relevantRevisionDigest: value.relevantRevisionDigest
  });
  if (expectedContent !== value.contentDigest) fail(`${label}.contentDigest does not match its contents`);
  const expectedCache = digestObject({
    schemaVersion: value.schemaVersion,
    kind: "IndependentComputeCacheKeyV1",
    rootDigest: value.rootDigest,
    dependencies: value.dependencies,
    globListings: value.globListings,
    entries: value.entries.map(entryProjection),
    missing: value.missing,
    unknowns: value.unknowns,
    closureStatus: value.closureStatus,
    validator: value.validator,
    validatorSource: value.validatorSource,
    toolBinary: value.toolBinary,
    toolBinaryFingerprint: value.toolBinaryFingerprint,
    configDigest: digestObject(value.config),
    controlledEnvironmentDigest: digestObject(value.controlledEnvironment),
    policyDigest: digestObject(value.policy),
    sourceBindingDigest: value.sourceBinding.digest,
    relevantRevisionDigest: value.relevantRevisionDigest
  });
  if (expectedCache !== value.cacheKey) fail(`${label}.cacheKey does not match its contents`);
  return value;
}

function assertDependencyManifest(value, { requireCaptured = false } = {}) {
  if (requireCaptured && !hasMark(value, CAPTURED_MANIFEST)) {
    fail("A dependency manifest must come from the trusted local capture path");
  }
  const manifest = validateComparisonProjection(value, "Dependency manifest");
  if (!HEX_DIGEST.test(manifest.manifestDigest ?? "")) fail("Dependency manifest.manifestDigest is invalid");
  const withoutDigest = { ...manifest };
  delete withoutDigest.manifestDigest;
  if (digestObject(withoutDigest) !== manifest.manifestDigest) fail("Dependency manifest.manifestDigest does not match its contents");
  if (!manifest.observation || typeof manifest.observation !== "object") fail("Dependency manifest.observation is required");
  assertDigest(manifest.merkleRoot, "Dependency manifest.merkleRoot");
  if (merkleRoot(dependencyLeaves(manifest)) !== manifest.merkleRoot) fail("Dependency manifest.merkleRoot does not match its contents");
  if (!isObject(manifest.cacheIdentity) || digestObject(manifest.cacheIdentity) !== manifest.cacheKey) fail("Dependency manifest.cacheIdentity does not match its cacheKey");
  return manifest;
}

function dependencyLeaves(manifest) {
  return [
    ...manifest.entries.map((entry) => digestObject(entryProjection(entry))),
    ...manifest.globListings.map((listing) => listing.listingDigest),
    digestObject(manifest.validator),
    digestObject(manifest.validatorSource),
    digestObject(manifest.toolBinary),
    digestObject(manifest.toolBinaryFingerprint),
    digestObject(manifest.config),
    digestObject(manifest.controlledEnvironment),
    digestObject(manifest.policy),
    digestObject(manifest.sourceBinding),
    digestObject(manifest.dependencies),
    digestObject({ relevantRevisionDigest: manifest.relevantRevisionDigest })
  ];
}

export async function captureDependencyManifest({
  root,
  dependencies,
  validator = PURE_LOCAL_VALIDATOR,
  toolBinary = PURE_LOCAL_TOOL_BINARY,
  config = {},
  controlledEnvironment,
  policy,
  sourceBinding,
  relevantRevisionDigest = null,
  unrelatedHeadDigest = null,
  runId = null,
  epoch = null
} = {}) {
  assertString(root, "root");
  if (!path.isAbsolute(root) || path.resolve(root) !== root) fail("root must be a canonical absolute path");
  const rootResult = await canonicalDependencyRoot(root);
  if (rootResult.root === null) fail(`Cannot inspect root: ${rootResult.reason}`);
  const canonicalRoot = rootResult.root;
  const normalizedDependencies = dependencyDescriptor(dependencies);
  const normalizedValidator = publicValidator(validator);
  const normalizedTool = publicTool(toolBinary);
  const normalizedConfig = normalizeConfig(config, normalizedDependencies);
  const normalizedEnvironment = normalizeEnvironment(controlledEnvironment);
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedSourceBinding = normalizeBinding(sourceBinding, "sourceBinding");
  const normalizedRelevantRevision = normalizeRevisionDigest(relevantRevisionDigest, "relevantRevisionDigest");
  const normalizedValidatorSource = await validatorSourceFingerprint();
  const normalizedToolFingerprint = await toolBinaryFingerprint();
  const normalizedUnrelatedHead = normalizeRevisionDigest(unrelatedHeadDigest, "unrelatedHeadDigest");
  if (runId !== null && runId !== undefined) assertSafeId(runId, "runId");
  if (epoch !== null && epoch !== undefined) {
    if (!Number.isSafeInteger(epoch) || epoch < 0) fail("epoch must be a non-negative safe integer");
  }
  const selected = new Map();
  const globListings = [];
  const unknowns = normalizedDependencies.unknown.map((item) => ({ dependency: item, reason: "caller-declared-unknown" }));
  for (const relative of normalizedDependencies.files) await collectEntry(canonicalRoot, selected, relative, { scope: "direct", dependencyId: null, kind: "file", pattern: null }, unknowns);
  for (const pattern of normalizedDependencies.globs) await collectGlob(canonicalRoot, selected, globListings, pattern, { scope: "direct", dependencyId: null }, unknowns);
  for (const indirect of normalizedDependencies.indirect) {
    if (indirect.unknown) addUnknown(unknowns, { dependency: indirect.id, reason: indirect.reason ?? "caller-declared-unknown" });
    for (const relative of indirect.files) await collectEntry(canonicalRoot, selected, relative, { scope: "indirect", dependencyId: indirect.id, kind: "file", pattern: null }, unknowns);
    for (const pattern of indirect.globs) await collectGlob(canonicalRoot, selected, globListings, pattern, { scope: "indirect", dependencyId: indirect.id }, unknowns);
  }
  const entries = finaliseEntries(selected);
  const missing = {
    paths: entries.filter((entry) => entry.type === "missing").map((entry) => entry.path),
    globs: globListings.filter((listing) => listing.missing).map((listing) => makeGlobLabel(listing.scope, listing.dependencyId, listing.pattern)).sort()
  };
  for (const relative of missing.paths) addUnknown(unknowns, { path: relative, reason: "required-dependency-missing" });
  for (const glob of missing.globs) addUnknown(unknowns, { glob, reason: "required-glob-empty" });
  if (entries.length === 0 && globListings.length === 0) addUnknown(unknowns, { dependency: "closure", reason: "empty-closure" });
  if (normalizedValidatorSource.status === "unknown") addUnknown(unknowns, { validator: normalizedValidatorSource.path, reason: normalizedValidatorSource.unknownReason });
  if (normalizedToolFingerprint.status === "unknown") addUnknown(unknowns, { toolBinary: normalizedToolFingerprint.path, reason: normalizedToolFingerprint.unknownReason });
  const closureStatus = unknowns.length === 0 ? "complete" : "unknown";
  const normalizedUnknowns = unknowns.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const provisional = {
    schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
    kind: DEPENDENCY_MANIFEST_KIND,
    rootDigest: sha256(canonicalRoot),
    dependencies: normalizedDependencies,
    globListings: globListings.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
    entries,
    missing,
    unknowns: normalizedUnknowns,
    closureStatus,
    validator: normalizedValidator,
    validatorSource: normalizedValidatorSource,
    toolBinary: normalizedTool,
    toolBinaryFingerprint: normalizedToolFingerprint,
    config: normalizedConfig,
    controlledEnvironment: normalizedEnvironment,
    policy: normalizedPolicy,
    sourceBinding: normalizedSourceBinding,
    relevantRevisionDigest: normalizedRelevantRevision
  };
  const identity = cacheIdentity(provisional);
  const contentDigest = digestObject(contentProjection(provisional));
  const manifest = {
    ...provisional,
    merkleRoot: merkleRoot(dependencyLeaves({ ...provisional, globListings: provisional.globListings })),
    cacheIdentity: identity,
    cacheKey: digestObject(identity),
    contentDigest,
    observation: {
      runId: runId ?? null,
      epoch: epoch ?? null,
      unrelatedHeadDigest: normalizedUnrelatedHead
    }
  };
  manifest.manifestDigest = digestObject(manifest);
  const captured = deepFreeze(mark(manifest, CAPTURED_MANIFEST));
  const semanticPaths = new Set(normalizedConfig.checks.map((check) => check.path));
  const retainedBytes = new Map();
  for (const item of selected.values()) {
    if (item.bytes !== undefined && semanticPaths.has(item.fingerprint?.path) && item.fingerprint?.type === "file" && item.fingerprint.status === "known") {
      retainedBytes.set(item.fingerprint.path, Buffer.from(item.bytes).toString("base64"));
    }
  }
  CAPTURED_SNAPSHOTS.set(captured, Object.freeze({
    contentDigest: captured.contentDigest,
    manifestDigest: captured.manifestDigest,
    capturedAtMs: Date.now(),
    bytes: retainedBytes
  }));
  return captured;
}

export function createVerificationUnit({ unitId, manifest, description = null } = {}) {
  assertSafeId(unitId, "unitId");
  const verifiedManifest = assertDependencyManifest(manifest, { requireCaptured: true });
  const validator = verifiedManifest.validator;
  if (validator.kind !== PURE_LOCAL_VALIDATOR_KIND || validator.trusted !== true || validator.pure !== true || validator.reproducible !== true || validator.effects !== false) {
    fail("VerificationUnitV1 requires a trusted pure/reproducible validator");
  }
  if (description !== null && description !== undefined) assertString(description, "description");
  const core = {
    schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
    kind: VERIFICATION_UNIT_KIND,
    unitId,
    description: description ?? null,
    validator,
    validatorSource: verifiedManifest.validatorSource,
    toolBinary: verifiedManifest.toolBinary,
    toolBinaryFingerprint: verifiedManifest.toolBinaryFingerprint,
    dependencies: verifiedManifest.dependencies,
    config: verifiedManifest.config,
    controlledEnvironment: verifiedManifest.controlledEnvironment,
    policy: verifiedManifest.policy,
    sourceBinding: verifiedManifest.sourceBinding,
    relevantRevisionDigest: verifiedManifest.relevantRevisionDigest,
    rootDigest: verifiedManifest.rootDigest,
    baselineManifestDigest: verifiedManifest.manifestDigest,
    baselineContentDigest: verifiedManifest.contentDigest,
    cacheKey: verifiedManifest.cacheKey,
    baselineFingerprint: projectManifestForComparison(verifiedManifest),
    eligibility: verifiedManifest.closureStatus === "complete" ? "eligible" : "full-required",
    effectAuthorized: false
  };
  return deepFreeze(mark({ ...core, unitDigest: digestObject(core) }, CREATED_UNIT));
}

function assertVerificationUnit(value, { requireCreated = false } = {}) {
  if (requireCreated && !hasMark(value, CREATED_UNIT)) fail("VerificationUnitV1 must come from the trusted unit constructor");
  assertObject(value, "VerificationUnitV1");
  if (value.schemaVersion !== INCREMENTAL_VERIFICATION_SCHEMA_VERSION || value.kind !== VERIFICATION_UNIT_KIND) fail("VerificationUnitV1 kind/version is invalid");
  assertSafeId(value.unitId, "VerificationUnitV1.unitId");
  if (value.effectAuthorized !== false) fail("VerificationUnitV1 cannot carry effect authority");
  assertDigest(value.unitDigest, "VerificationUnitV1.unitDigest");
  const withoutDigest = { ...value };
  delete withoutDigest.unitDigest;
  if (digestObject(withoutDigest) !== value.unitDigest) fail("VerificationUnitV1.unitDigest does not match its contents");
  validateComparisonProjection(value.baselineFingerprint, "VerificationUnitV1.baselineFingerprint");
  return value;
}

function unitCaptureOptions(unit, root, options = {}) {
  return {
    root,
    dependencies: unit.dependencies,
    validator: PURE_LOCAL_VALIDATOR,
    toolBinary: PURE_LOCAL_TOOL_BINARY,
    config: unit.config,
    controlledEnvironment: unit.controlledEnvironment,
    policy: unit.policy,
    sourceBinding: unit.sourceBinding,
    relevantRevisionDigest: unit.relevantRevisionDigest,
    unrelatedHeadDigest: options.unrelatedHeadDigest ?? null,
    runId: options.runId ?? null,
    epoch: options.epoch ?? null
  };
}

function resultProjection(result) {
  return {
    schemaVersion: result.schemaVersion,
    kind: result.kind,
    unitDigest: result.unitDigest,
    cacheKey: result.cacheKey,
    mode: result.mode,
    status: result.status,
    outcome: result.outcome,
    reason: result.reason,
    observedContentDigest: result.observedContentDigest,
    observedManifestDigest: result.observedManifestDigest,
    snapshot: result.snapshot,
    findings: result.findings,
    unknowns: result.unknowns,
    producer: result.producer,
    verifier: result.verifier,
    effectAuthorized: result.effectAuthorized,
    authoritative: result.authoritative
  };
}

const HISTORICAL_SNAPSHOT_KIND = "HistoricalDependencySnapshotV1";

function historicalSnapshotFor(manifest) {
  const captured = CAPTURED_SNAPSHOTS.get(manifest);
  if (!captured || captured.contentDigest !== manifest.contentDigest || captured.manifestDigest !== manifest.manifestDigest) {
    fail("Verification manifest is not bound to its retained immutable snapshot");
  }
  const capturedAtMs = captured.capturedAtMs;
  if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0) fail("Verification manifest snapshot time is invalid");
  return {
    kind: HISTORICAL_SNAPSHOT_KIND,
    status: "historical",
    current: false,
    contentDigest: captured.contentDigest,
    manifestDigest: captured.manifestDigest,
    capturedAtMs
  };
}

function assertHistoricalSnapshot(value, label = "verification snapshot", { requireTime = true } = {}) {
  assertObject(value, label);
  if (value.kind !== HISTORICAL_SNAPSHOT_KIND || value.status !== "historical" || value.current !== false) fail(`${label} must describe a historical dependency snapshot`);
  assertDigest(value.contentDigest, `${label}.contentDigest`);
  assertDigest(value.manifestDigest, `${label}.manifestDigest`);
  if (requireTime && (!Number.isSafeInteger(value.capturedAtMs) || value.capturedAtMs < 0)) fail(`${label}.capturedAtMs is invalid`);
  return value;
}

async function runDeclaredSemanticChecks(unit, currentManifest) {
  const findings = [];
  const captured = CAPTURED_SNAPSHOTS.get(currentManifest);
  if (!captured || captured.contentDigest !== currentManifest.contentDigest || captured.manifestDigest !== currentManifest.manifestDigest) {
    return { status: "unknown", reason: "semantic-snapshot-unavailable", findings };
  }
  for (const check of unit.config.checks) {
    const entry = currentManifest.entries.find((candidate) => candidate.path === check.path);
    if (!entry || entry.type !== "file" || entry.status !== "known") {
      return { status: "unknown", reason: "semantic-input-unavailable", findings };
    }
    const encoded = captured.bytes.get(check.path);
    if (encoded === undefined) {
      return { status: "unknown", reason: "semantic-input-snapshot-unavailable", findings };
    }
    const bytes = Buffer.from(encoded, "base64");
    if (entry.size !== bytes.length || entry.bytesDigest !== sha256(bytes)) {
      return { status: "unknown", reason: "semantic-input-drift", findings };
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      findings.push({ kind: check.kind, path: check.path, reason: "invalid-utf8" });
      continue;
    }
    if (check.kind === "json-object") {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        findings.push({ kind: check.kind, path: check.path, reason: "invalid-json" });
        continue;
      }
      if (!isObject(parsed)) {
        findings.push({ kind: check.kind, path: check.path, reason: "json-value-is-not-an-object" });
        continue;
      }
      const missingKeys = check.requiredKeys.filter((key) => !Object.hasOwn(parsed, key));
      if (missingKeys.length > 0) findings.push({ kind: check.kind, path: check.path, reason: "missing-required-keys", missingKeys });
    } else if (check.kind === "text-contains" && !text.includes(check.substring)) {
      findings.push({ kind: check.kind, path: check.path, reason: "required-text-not-found" });
    }
  }
  return { status: findings.length === 0 ? "pass" : "fail", reason: findings.length === 0 ? "semantic-checks-pass" : "semantic-check-failure", findings };
}

function assertProducedResult(value, unit) {
  if (!hasMark(value, PRODUCED_RESULT)) fail("Caller-supplied verification result is rejected; run the trusted pure local validator first");
  assertObject(value, "produced verification result");
  assertVerificationUnit(unit, { requireCreated: true });
  if (value.unitDigest !== unit.unitDigest) fail("Verification result is bound to a different unit");
  if (!RESULTS.has(value.status) || !MODES.has(value.mode)) fail("Produced verification result status/mode is invalid");
  assertDigest(value.observedContentDigest, "Produced verification result.observedContentDigest");
  assertDigest(value.observedManifestDigest, "Produced verification result.observedManifestDigest");
  const snapshot = assertHistoricalSnapshot(value.snapshot, "Produced verification result.snapshot");
  if (snapshot.contentDigest !== value.observedContentDigest || snapshot.manifestDigest !== value.observedManifestDigest) {
    fail("Produced verification result snapshot is not bound to its observed digests");
  }
  if (value.effectAuthorized !== false || value.authoritative !== false) fail("Verification result cannot carry effect authority");
  return value;
}

export async function runPureLocalValidator({ root, unit, mode = "full", runId = null, epoch = null, unrelatedHeadDigest = null } = {}) {
  assertVerificationUnit(unit, { requireCreated: true });
  if (!MODES.has(mode)) fail("validator mode must be full or shadow");
  const currentManifest = await captureDependencyManifest(unitCaptureOptions(unit, root, { runId, epoch, unrelatedHeadDigest }));
  const historicalSnapshot = historicalSnapshotFor(currentManifest);
  const semantic = currentManifest.closureStatus === "complete"
    ? await runDeclaredSemanticChecks(unit, currentManifest)
    : { status: "unknown", reason: "semantic-input-unavailable", findings: [] };
  const fingerprintDrift = currentManifest.cacheKey !== unit.cacheKey || currentManifest.contentDigest !== unit.baselineContentDigest;
  let status = "pass";
  let reason = semantic.reason;
  let findings = semantic.findings;
  if (currentManifest.closureStatus !== "complete") {
    status = "unknown";
    reason = "unknown-dependency-closure";
  } else if (currentManifest.rootDigest !== unit.rootDigest) {
    status = "fail";
    reason = "source-root-drift";
  } else if (semantic.status === "unknown") {
    status = "unknown";
    reason = semantic.reason;
  } else if (semantic.status === "fail") {
    status = "fail";
    reason = "validator-input-failure";
  } else if (fingerprintDrift) {
    status = "fail";
    reason = "dependency-fingerprint-drift";
    findings = compareDependencyManifests(unit.baselineFingerprint, currentManifest).changes;
  }
  const produced = {
    schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
    kind: VERIFICATION_RESULT_KIND,
    unitDigest: unit.unitDigest,
    cacheKey: unit.cacheKey,
    mode,
    status,
    outcome: status,
    reason,
    observedContentDigest: currentManifest.contentDigest,
    observedManifestDigest: currentManifest.manifestDigest,
    snapshot: historicalSnapshot,
    findings,
    unknowns: currentManifest.unknowns,
    producer: {
      id: PURE_LOCAL_VALIDATOR.id,
      digest: PURE_LOCAL_VALIDATOR.digest,
      trust: PURE_LOCAL_VALIDATOR.trust
    },
    verifier: {
      id: "better-workflows.incremental-verifier-v1",
      digest: sha256("better-workflows.incremental-verifier-v1"),
      provenance: "in-process-trusted-verifier"
    },
    effectAuthorized: false,
    authoritative: false
  };
  return deepFreeze(mark(produced, PRODUCED_RESULT));
}

export function sealVerificationResult({ unit, produced, resultId = null } = {}) {
  assertVerificationUnit(unit, { requireCreated: true });
  assertProducedResult(produced, unit);
  if (resultId !== null && resultId !== undefined) assertSafeId(resultId, "resultId");
  const core = {
    ...resultProjection(produced),
    resultId: resultId ?? `result-${digestObject(resultProjection(produced)).slice(0, 24)}`,
    sealed: true
  };
  const sealed = { ...core, resultDigest: digestObject(core) };
  return deepFreeze(mark(sealed, SEALED_RESULT));
}

function assertSealedResult(value, { requireInProcess = false } = {}) {
  if (requireInProcess && !hasMark(value, SEALED_RESULT)) {
    fail("Caller-supplied result artifact is rejected; a fresh in-process sealed result is required");
  }
  assertObject(value, "sealed verification result");
  if (value.schemaVersion !== INCREMENTAL_VERIFICATION_SCHEMA_VERSION || value.kind !== VERIFICATION_RESULT_KIND || value.sealed !== true) fail("Verification result is not an immutable sealed artifact");
  assertDigest(value.resultDigest, "Verification result.resultDigest");
  const withoutDigest = { ...value };
  delete withoutDigest.resultDigest;
  if (digestObject(withoutDigest) !== value.resultDigest) fail("Verification result.resultDigest does not match its contents");
  if (!RESULTS.has(value.status) || !MODES.has(value.mode)) fail("Verification result status/mode is invalid");
  assertDigest(value.observedContentDigest, "Verification result.observedContentDigest");
  assertDigest(value.observedManifestDigest, "Verification result.observedManifestDigest");
  const snapshot = assertHistoricalSnapshot(value.snapshot, "Verification result.snapshot");
  if (snapshot.contentDigest !== value.observedContentDigest || snapshot.manifestDigest !== value.observedManifestDigest) {
    fail("Verification result snapshot is not bound to its observed digests");
  }
  if (value.effectAuthorized !== false || value.authoritative !== false) fail("Verification result cannot carry effect authority");
  if (!isObject(value.producer) || value.producer.id !== PURE_LOCAL_VALIDATOR.id || value.producer.digest !== PURE_LOCAL_VALIDATOR.digest) fail("Verification result producer provenance is not trusted");
  return value;
}

export function verifySealedResult(value) {
  return assertSealedResult(value);
}

export class IndependentComputeCacheV1 {
  #entries = new Map();

  put(result) {
    const verified = assertSealedResult(result, { requireInProcess: true });
    if (verified.status === "unknown") fail("Unknown verification results cannot enter the independent compute cache");
    this.#entries.set(verified.cacheKey, verified);
    return verified.resultDigest;
  }

  get(cacheKey) {
    assertDigest(cacheKey, "cacheKey");
    return this.#entries.get(cacheKey) ?? null;
  }

  has(cacheKey) {
    return this.get(cacheKey) !== null;
  }

  get size() {
    return this.#entries.size;
  }
}

export function createIndependentComputeCache() {
  return new IndependentComputeCacheV1();
}

function assertAdmission(value, { requireCurrent = false } = {}) {
  if (requireCurrent && !hasMark(value, CURRENT_ADMISSION)) fail("Current admission must come from a fresh trusted admission call");
  assertObject(value, "VerificationAdmissionV1");
  if (value.schemaVersion !== INCREMENTAL_VERIFICATION_SCHEMA_VERSION || value.kind !== VERIFICATION_ADMISSION_KIND) fail("VerificationAdmissionV1 kind/version is invalid");
  assertDigest(value.admissionDigest, "VerificationAdmissionV1.admissionDigest");
  const withoutDigest = { ...value };
  delete withoutDigest.admissionDigest;
  if (digestObject(withoutDigest) !== value.admissionDigest) fail("VerificationAdmissionV1.admissionDigest does not match its contents");
  assertDigest(value.currentContentDigest, "VerificationAdmissionV1.currentContentDigest");
  assertDigest(value.currentManifestDigest, "VerificationAdmissionV1.currentManifestDigest");
  assertHistoricalSnapshot(value.snapshot, "VerificationAdmissionV1.snapshot", { requireTime: false });
  if (value.snapshot.contentDigest !== value.currentContentDigest || value.snapshot.manifestDigest !== value.currentManifestDigest) {
    fail("VerificationAdmissionV1 snapshot is not bound to its current digests");
  }
  if (value.effectAuthorized !== false) fail("Current admission cannot authorize effects");
  return value;
}

export async function admitCurrentVerification({ root, unit, runId = null, epoch = null, unrelatedHeadDigest = null } = {}) {
  assertVerificationUnit(unit, { requireCreated: true });
  const currentManifest = await captureDependencyManifest(unitCaptureOptions(unit, root, { runId, epoch, unrelatedHeadDigest }));
  let status = "admitted";
  let disposition = "cache-eligible";
  let reason = "current-fingerprint-matches";
  if (currentManifest.closureStatus !== "complete") {
    status = "hold";
    disposition = "full-required";
    reason = "unknown-dependency-closure";
  } else if (currentManifest.rootDigest !== unit.rootDigest) {
    status = "full-required";
    disposition = "full-required";
    reason = "source-root-drift";
  } else if (currentManifest.cacheKey !== unit.cacheKey || currentManifest.contentDigest !== unit.baselineContentDigest) {
    status = "full-required";
    disposition = "full-required";
    reason = "dependency-fingerprint-drift";
  }
  const core = {
    schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
    kind: VERIFICATION_ADMISSION_KIND,
    unitDigest: unit.unitDigest,
    cacheKey: unit.cacheKey,
    currentContentDigest: currentManifest.contentDigest,
    currentManifestDigest: currentManifest.manifestDigest,
    snapshot: (() => {
      const captured = historicalSnapshotFor(currentManifest);
      return {
        kind: captured.kind,
        status: captured.status,
        current: captured.current,
        contentDigest: captured.contentDigest,
        manifestDigest: captured.manifestDigest
      };
    })(),
    status,
    disposition,
    reason,
    cacheEligible: status === "admitted",
    effectAuthorized: false,
    runId: runId ?? null,
    epoch: epoch ?? null,
    unrelatedHeadDigest: currentManifest.observation.unrelatedHeadDigest,
    sourceBindingDigest: unit.sourceBinding.digest,
    relevantRevisionDigest: unit.relevantRevisionDigest
  };
  return deepFreeze(mark({ ...core, admissionDigest: digestObject(core) }, CURRENT_ADMISSION));
}

export async function createCarryForward({
  root,
  unit,
  result,
  admission,
  currentRevisionDigest = null,
  carryId = null,
  runId = null,
  epoch = null,
  unrelatedHeadDigest = null
} = {}) {
  assertVerificationUnit(unit, { requireCreated: true });
  const sealed = assertSealedResult(result, { requireInProcess: true });
  const supplied = assertAdmission(admission, { requireCurrent: true });
  assertString(root, "root");
  const fresh = await admitCurrentVerification({
    root,
    unit,
    runId: runId ?? supplied.runId ?? null,
    epoch: epoch ?? supplied.epoch ?? null,
    unrelatedHeadDigest: unrelatedHeadDigest ?? supplied.unrelatedHeadDigest ?? null
  });
  const bindingFields = ["unitDigest", "cacheKey", "currentContentDigest", "status", "disposition", "cacheEligible", "sourceBindingDigest", "relevantRevisionDigest"];
  if (bindingFields.some((field) => supplied[field] !== fresh[field])) {
    fail("CarryForwardV1 supplied admission is stale; a fresh current admission is required");
  }
  const current = assertAdmission(fresh, { requireCurrent: true });
  return buildCarryForwardArtifact({ unit, sealed, current, currentRevisionDigest, carryId });
}

function buildCarryForwardArtifact({ unit, sealed, current, currentRevisionDigest = null, carryId = null }) {
  if (sealed.unitDigest !== unit.unitDigest || sealed.cacheKey !== unit.cacheKey || sealed.observedContentDigest !== current.currentContentDigest) {
    fail("CarryForwardV1 result is not bound to the fresh unit snapshot");
  }
  if (sealed.status !== "pass") fail("Only a passing sealed result can be carried forward");
  if (current.unitDigest !== unit.unitDigest || current.cacheKey !== unit.cacheKey || current.status !== "admitted" || current.cacheEligible !== true) {
    fail("CarryForwardV1 requires a fresh matching current admission");
  }
  const revision = current.relevantRevisionDigest;
  if (currentRevisionDigest !== null && currentRevisionDigest !== undefined) {
    const requestedRevision = assertDigest(currentRevisionDigest, "currentRevisionDigest");
    if (requestedRevision !== revision) fail("CarryForwardV1 currentRevisionDigest must match the fresh admission relevantRevisionDigest");
  }
  const core = {
    schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
    kind: CARRY_FORWARD_KIND,
    carryId: carryId ?? `carry-${digestObject({ unit: unit.unitDigest, result: sealed.resultDigest, admission: current.admissionDigest }).slice(0, 24)}`,
    unitDigest: unit.unitDigest,
    resultDigest: sealed.resultDigest,
    admissionDigest: current.admissionDigest,
    cacheKey: unit.cacheKey,
    currentContentDigest: current.currentContentDigest,
    currentRevisionDigest: revision,
    freshness: {
      kind: "FreshCurrentAdmissionBoundaryV1",
      status: "fresh-capture",
      current: false,
      capturedAtMs: Date.now(),
      contentDigest: current.currentContentDigest,
      manifestDigest: current.currentManifestDigest,
      admissionDigest: current.admissionDigest
    },
    provenance: {
      producer: sealed.producer,
      verifier: sealed.verifier,
      sourceBindingDigest: current.sourceBindingDigest
    },
    effectAuthorized: false,
    accepted: true
  };
  assertSafeId(core.carryId, "CarryForwardV1.carryId");
  return deepFreeze(mark({ ...core, carryDigest: digestObject(core) }, CREATED_CARRY_FORWARD));
}

export async function createCarryForwardFromPersistentStore({
  store,
  root,
  unit,
  admission = null,
  currentRevisionDigest = null,
  carryId = null,
  runId = null,
  epoch = null,
  unrelatedHeadDigest = null,
  mode = "full"
} = {}) {
  assertVerificationUnit(unit, { requireCreated: true });
  assertString(root, "root");
  const {
    isAuthenticatedVerificationResultStoreLoad,
    isGenuineVerificationResultStore,
    loadAuthenticatedVerificationResult
  } = await import("./verification-result-store-v1.mjs");
  if (!isGenuineVerificationResultStore(store)) {
    fail("Persistent CarryForwardV1 requires a genuine module-created VerificationResultStoreV1 instance");
  }
  const supplied = admission === null || admission === undefined ? null : assertAdmission(admission, { requireCurrent: true });
  const loaded = await loadAuthenticatedVerificationResult({ store,
    root,
    unit,
    mode,
    runId: runId ?? supplied?.runId ?? null,
    epoch: epoch ?? supplied?.epoch ?? null,
    unrelatedHeadDigest: unrelatedHeadDigest ?? supplied?.unrelatedHeadDigest ?? null
  });
  if (
    !isAuthenticatedVerificationResultStoreLoad(loaded) ||
    !loaded || loaded.kind !== "VerificationResultStoreLoadV1" || loaded.hit !== true || loaded.cacheHit !== true ||
    loaded.result === null || loaded.admission === null
  ) {
    fail("Persistent CarryForwardV1 requires an authenticated current cache hit");
  }
  const current = assertAdmission(loaded.admission, { requireCurrent: true });
  if (supplied !== null) {
    const bindingFields = ["unitDigest", "cacheKey", "currentContentDigest", "status", "disposition", "cacheEligible", "sourceBindingDigest", "relevantRevisionDigest"];
    if (bindingFields.some((field) => supplied[field] !== current[field])) {
      fail("CarryForwardV1 supplied admission is stale; a fresh current admission is required");
    }
  }
  const sealed = assertSealedResult(loaded.result);
  return buildCarryForwardArtifact({ unit, sealed, current, currentRevisionDigest, carryId });
}

function fingerprintComparable(entry) {
  return {
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    size: entry.size,
    bytesDigest: entry.bytesDigest,
    target: entry.target ?? null,
    status: entry.status,
    unknownReason: entry.unknownReason ?? null
  };
}

function entryChanged(left, right) {
  return canonicalJson(fingerprintComparable(left)) !== canonicalJson(fingerprintComparable(right));
}

export function compareDependencyManifests(previous, current) {
  const before = projectManifestForComparison(previous);
  const after = projectManifestForComparison(current);
  const beforeEntries = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterEntries = new Map(after.entries.map((entry) => [entry.path, entry]));
  const added = [];
  const deleted = [];
  const changes = [];
  for (const [relative, entry] of afterEntries) {
    if (!beforeEntries.has(relative)) added.push(entry);
    else if (entryChanged(beforeEntries.get(relative), entry)) {
      const oldEntry = beforeEntries.get(relative);
      if (oldEntry.type === "missing" && entry.type !== "missing") added.push(entry);
      else if (oldEntry.type !== "missing" && entry.type === "missing") deleted.push(oldEntry);
      else changes.push({ kind: "modify", path: relative, before: fingerprintComparable(oldEntry), after: fingerprintComparable(entry) });
    }
  }
  for (const [relative, entry] of beforeEntries) if (!afterEntries.has(relative)) deleted.push(entry);
  const consumedAdded = new Set();
  const consumedDeleted = new Set();
  for (const [deletedIndex, oldEntry] of deleted.entries()) {
    if (oldEntry.type !== "file" || oldEntry.bytesDigest === null) continue;
    const candidateIndex = added.findIndex((entry, index) => !consumedAdded.has(index) && entry.type === "file" && entry.bytesDigest === oldEntry.bytesDigest && entry.mode === oldEntry.mode);
    if (candidateIndex === -1) continue;
    const newEntry = added[candidateIndex];
    consumedAdded.add(candidateIndex);
    consumedDeleted.add(deletedIndex);
    changes.push({ kind: "rename", from: oldEntry.path, to: newEntry.path, bytesDigest: oldEntry.bytesDigest });
  }
  for (const [index, entry] of added.entries()) if (!consumedAdded.has(index)) changes.push({ kind: "add", path: entry.path, before: null, after: fingerprintComparable(entry) });
  for (const [index, entry] of deleted.entries()) if (!consumedDeleted.has(index)) changes.push({ kind: "delete", path: entry.path, before: fingerprintComparable(entry), after: null });
  const beforeGlobs = new Map(before.globListings.map((listing) => [makeGlobLabel(listing.scope, listing.dependencyId, listing.pattern), listing]));
  const afterGlobs = new Map(after.globListings.map((listing) => [makeGlobLabel(listing.scope, listing.dependencyId, listing.pattern), listing]));
  for (const [label, listing] of afterGlobs) {
    const old = beforeGlobs.get(label);
    if (!old || canonicalJson(old.matches) !== canonicalJson(listing.matches) || old.status !== listing.status) {
      changes.push({
        kind: "glob-listing",
        glob: label,
        before: old ? old.matches : null,
        after: listing.matches,
        status: listing.status
      });
    }
  }
  for (const [label, listing] of beforeGlobs) if (!afterGlobs.has(label)) changes.push({ kind: "glob-listing", glob: label, before: listing.matches, after: null, status: "removed" });
  changes.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return deepFreeze({
    schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
    kind: "DependencyManifestComparisonV1",
    beforeContentDigest: before.contentDigest,
    afterContentDigest: after.contentDigest,
    changed: changes.length > 0,
    changes,
    digest: digestObject({ beforeContentDigest: before.contentDigest, afterContentDigest: after.contentDigest, changes })
  });
}

function assertResultForComparison(value) {
  return assertSealedResult(value);
}

export function compareFullShadow({ full, shadow } = {}) {
  const fullResult = assertResultForComparison(full);
  const shadowResult = assertResultForComparison(shadow);
  if (fullResult.unitDigest !== shadowResult.unitDigest || fullResult.cacheKey !== shadowResult.cacheKey) fail("Full/shadow results are not bound to the same unit and cache key");
  const fullProjection = {
    unitDigest: fullResult.unitDigest,
    cacheKey: fullResult.cacheKey,
    status: fullResult.status,
    outcome: fullResult.outcome,
    reason: fullResult.reason,
    observedContentDigest: fullResult.observedContentDigest,
    snapshot: {
      kind: fullResult.snapshot.kind,
      status: fullResult.snapshot.status,
      contentDigest: fullResult.snapshot.contentDigest
    },
    findings: fullResult.findings,
    unknowns: fullResult.unknowns
  };
  const shadowProjection = {
    unitDigest: shadowResult.unitDigest,
    cacheKey: shadowResult.cacheKey,
    status: shadowResult.status,
    outcome: shadowResult.outcome,
    reason: shadowResult.reason,
    observedContentDigest: shadowResult.observedContentDigest,
    snapshot: {
      kind: shadowResult.snapshot.kind,
      status: shadowResult.snapshot.status,
      contentDigest: shadowResult.snapshot.contentDigest
    },
    findings: shadowResult.findings,
    unknowns: shadowResult.unknowns
  };
  return deepFreeze({
    schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
    kind: FULL_SHADOW_COMPARISON_KIND,
    unitDigest: fullResult.unitDigest,
    fullResultDigest: fullResult.resultDigest,
    shadowResultDigest: shadowResult.resultDigest,
    equivalent: canonicalJson(fullProjection) === canonicalJson(shadowProjection),
    status: "observe-only",
    decision: "shadow-only",
    accepted: false,
    effectAuthorized: false,
    digest: digestObject({ fullProjection, shadowProjection })
  });
}

export function createRevisionFreezeBinding({ unit, admission, carryForward = null, revision = null, freeze = null } = {}) {
  assertVerificationUnit(unit, { requireCreated: true });
  const current = assertAdmission(admission, { requireCurrent: true });
  if (current.status !== "admitted") fail("revisionReadyDigest requires an admitted current verification");
  const revisionPayload = cloneJson(revision ?? { digest: current.relevantRevisionDigest }, "revision");
  const freezePayload = cloneJson(freeze ?? { digest: current.relevantRevisionDigest }, "freeze");
  const carryDigest = carryForward === null ? null : (() => {
    if (!hasMark(carryForward, CREATED_CARRY_FORWARD)) fail("RevisionFreezeBindingV1 rejects caller-supplied CarryForwardV1 artifacts");
    assertObject(carryForward, "carryForward");
    assertDigest(carryForward.carryDigest, "carryForward.carryDigest");
    return carryForward.carryDigest;
  })();
  const revisionReadyCore = {
    schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
    kind: "RevisionReadyV1",
    unitDigest: unit.unitDigest,
    admissionDigest: current.admissionDigest,
    currentContentDigest: current.currentContentDigest,
    revision: revisionPayload
  };
  const revisionReadyDigest = digestObject(revisionReadyCore);
  const finalFreezeCore = {
    schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
    kind: "FinalFreezeV1",
    unitDigest: unit.unitDigest,
    revisionReadyDigest,
    carryForwardDigest: carryDigest,
    freeze: freezePayload
  };
  const finalFreezeDigest = digestObject(finalFreezeCore);
  if (revisionReadyDigest === finalFreezeDigest) fail("revisionReadyDigest and finalFreezeDigest must remain separate");
  const binding = {
    schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
    kind: REVISION_FREEZE_BINDING_KIND,
    unitDigest: unit.unitDigest,
    revisionReadyDigest,
    finalFreezeDigest,
    revisionReady: { ...revisionReadyCore, digest: revisionReadyDigest },
    finalFreeze: { ...finalFreezeCore, digest: finalFreezeDigest },
    edges: [{ from: "revision-ready", to: "final-freeze" }],
    cycle: false,
    effectAuthorized: false
  };
  return deepFreeze({ ...binding, bindingDigest: digestObject(binding) });
}

export function assertRevisionFreezeBinding(binding) {
  assertObject(binding, "RevisionFreezeBindingV1");
  if (binding.schemaVersion !== INCREMENTAL_VERIFICATION_SCHEMA_VERSION || binding.kind !== REVISION_FREEZE_BINDING_KIND) fail("RevisionFreezeBindingV1 kind/version is invalid");
  if (binding.effectAuthorized !== false || binding.cycle !== false) fail("RevisionFreezeBindingV1 cannot carry effect authority or a cycle");
  if (!Array.isArray(binding.edges) || binding.edges.length !== 1 || binding.edges[0].from !== "revision-ready" || binding.edges[0].to !== "final-freeze") fail("RevisionFreezeBindingV1 graph must be acyclic revision-ready to final-freeze");
  assertDigest(binding.revisionReadyDigest, "revisionReadyDigest");
  assertDigest(binding.finalFreezeDigest, "finalFreezeDigest");
  assertDigest(binding.revisionReady?.digest, "revisionReadyDigest");
  assertDigest(binding.finalFreeze?.digest, "finalFreezeDigest");
  if (binding.revisionReadyDigest !== binding.revisionReady.digest || binding.finalFreezeDigest !== binding.finalFreeze.digest) fail("RevisionFreezeBindingV1 top-level digest references do not match its nodes");
  if (binding.revisionReady.digest === binding.finalFreeze.digest) fail("revisionReadyDigest and finalFreezeDigest must be distinct");
  const revision = { ...binding.revisionReady };
  delete revision.digest;
  if (digestObject(revision) !== binding.revisionReady.digest) fail("revisionReadyDigest does not match its contents");
  const freeze = { ...binding.finalFreeze };
  delete freeze.digest;
  if (digestObject(freeze) !== binding.finalFreeze.digest) fail("finalFreezeDigest does not match its contents");
  const withoutBindingDigest = { ...binding };
  delete withoutBindingDigest.bindingDigest;
  if (digestObject(withoutBindingDigest) !== binding.bindingDigest) fail("RevisionFreezeBindingV1.bindingDigest does not match its contents");
  return binding;
}

export function evaluateAutoQualification({ fullShadow = null, validatorCorrectness = null, netBenefit = null, confidenceReceipt = null } = {}) {
  const lowerBound = confidenceReceipt?.ci95LowerBound;
  const eligible = Boolean(
    fullShadow?.equivalent === true &&
    validatorCorrectness?.passed === true &&
    netBenefit?.passed === true &&
    hasMark(confidenceReceipt, TRUSTED_CI_RECEIPT) &&
    confidenceReceipt?.kind === "Independent95CIReceiptV1" &&
    confidenceReceipt?.trusted === true &&
    typeof lowerBound === "number" && Number.isFinite(lowerBound) && lowerBound > 0
  );
  return deepFreeze({
    schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
    kind: "AutoQualificationDecisionV1",
    candidateEligible: eligible,
    mode: "off",
    accepted: false,
    reason: eligible ? "candidate-needs-separate-release-gate-before-activation" : "95-percent-ci-lower-bound-receipt-unavailable-or-not-strictly-positive",
    ci95LowerBound: typeof lowerBound === "number" && Number.isFinite(lowerBound) ? lowerBound : null,
    effectAuthorized: false
  });
}
