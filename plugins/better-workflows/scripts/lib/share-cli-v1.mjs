import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getStateRoot } from "./core.mjs";
import {
  SHARE_ARTIFACT_KIND,
  SHARE_EXPORT_KIND,
  SHARE_LIMITS,
  ShareError,
  createShareCreatePermissionV1,
  createShareExpirePermissionV1,
  createShareExportPermissionV1,
  createShareReadPermissionV1,
  createShareRevokePermissionV1,
  createShareRevisionPermissionV1,
  createShareUnboundReadPermissionV1,
  createShareArtifactV1,
  expireShareArtifactV1,
  exportShareArtifactV1,
  listShareArtifactsV1,
  readShareArtifactV1,
  reviseShareArtifactV1,
  revokeShareArtifactV1,
  validateShareArtifactV1,
  validateShareExportV1
} from "./share-v1.mjs";
import {
  LOCAL_SOURCE_BINDING_V1,
  isLocalSourceBindingV1
} from "./share-source-observer-v1.mjs";

export const SHARE_CLI_SCHEMA_VERSION = 1;
export const SHARE_CLI_KIND = "ShareCliV1";
export const SHARE_CLI_MAX_INPUT_BYTES = SHARE_LIMITS.maxRecordBytes;
export const SHARE_CLI_MAX_OUTPUT_BYTES = SHARE_LIMITS.maxRecordBytes;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const COMMANDS = new Set([
  "help",
  "validate",
  "create",
  "revise",
  "read",
  "list",
  "export",
  "revoke",
  "expire"
]);
const BOOLEAN_OPTIONS = new Set(["json", "help"]);
const COMMON_OPTIONS = new Set(["state-root", "deadline-ms", "json", "help"]);
const INPUT_OPTIONS = new Set([...COMMON_OPTIONS, "share-id", "file"]);
const REVISION_OPTIONS = new Set([...INPUT_OPTIONS, "expected-revision"]);
const READ_OPTIONS = new Set([...COMMON_OPTIONS, "share-id", "revision"]);
const EXPORT_OPTIONS = new Set([...COMMON_OPTIONS, "share-id", "revision", "out"]);
const MUTATION_OPTIONS = new Set([...COMMON_OPTIONS, "share-id", "expected-revision", "reason"]);
const VALIDATE_OPTIONS = new Set([...COMMON_OPTIONS, "file"]);

const SHARE_INPUT_KEYS = new Set([
  "source",
  "target",
  "content",
  "selection",
  "privacy",
  "review",
  "expiresAt",
  "sourceValidity"
]);
const SHARE_SOURCE_VALIDITIES = new Set(["caller-asserted", LOCAL_SOURCE_BINDING_V1]);

const USAGE = Object.freeze([
  "share-cli-v1.mjs help [--json]",
  "share-cli-v1.mjs validate --file <share-artifact-or-export.json> [--state-root <absolute>] [--json]",
  "share-cli-v1.mjs create --share-id <id> --file <share-input.json> [--state-root <absolute>] [--deadline-ms <1..2000>] [--json]",
  "share-cli-v1.mjs revise --share-id <id> --file <share-input.json> --expected-revision <1..31> [--state-root <absolute>] [--deadline-ms <1..2000>] [--json]",
  "share-cli-v1.mjs read --share-id <id> [--revision <1..32>] [--state-root <absolute>] [--json]",
  "share-cli-v1.mjs list [--state-root <absolute>] [--json]",
  "share-cli-v1.mjs export --share-id <id> [--revision <1..32>] --out <new-json> [--state-root <absolute>] [--json]",
  "share-cli-v1.mjs revoke --share-id <id> --expected-revision <1..32> [--reason <text>] [--state-root <absolute>] [--json]",
  "share-cli-v1.mjs expire --share-id <id> --expected-revision <1..32> [--reason <text>] [--state-root <absolute>] [--json]"
]);

const LOCAL_PERMISSION_BOUNDARY = Object.freeze({
  permissionScope: "local-operation-only",
  ownerActionAuthority: false,
  providerAuthority: false,
  publicationAuthority: false,
  evidenceTruth: false
});

export class ShareCliError extends Error {
  constructor(code, message, { exitCode = 1, details = undefined } = {}) {
    super(message);
    this.name = "ShareCliError";
    this.code = code;
    this.exitCode = exitCode;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, options = {}) {
  throw new ShareCliError(code, message, options);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail("ESHARE_CLI_INVALID", `${label} must be a JSON object`, { exitCode: 2 });
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("ESHARE_CLI_INVALID", `${label} contains a symbol property`, { exitCode: 2 });
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail("ESHARE_CLI_INVALID", `${label} shape could not be inspected`, { exitCode: 2 });
    }
    if (!descriptor || descriptor.get || descriptor.set) {
      fail("ESHARE_CLI_INVALID", `${label} contains an accessor property`, { exitCode: 2 });
    }
  }
  return value;
}

function exactKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Reflect.ownKeys(value).filter((key) => typeof key !== "string" || !allowed.has(key));
  if (unknown.length > 0) fail("ESHARE_CLI_INVALID", `${label} contains an unsupported field`, { exitCode: 2 });
}

function requireKeys(value, keys, label) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail("ESHARE_CLI_INVALID", `${label} requires ${key}`, { exitCode: 2 });
  }
}

function assertArgv(argv) {
  if (!Array.isArray(argv) || Object.getPrototypeOf(argv) !== Array.prototype) {
    fail("ESHARE_CLI_USAGE", "argv must be a standard array", { exitCode: 2 });
  }
  for (const item of argv) {
    if (typeof item !== "string") fail("ESHARE_CLI_USAGE", "argv contains a non-text argument", { exitCode: 2 });
  }
}

function addOption(options, key, value) {
  if (Object.hasOwn(options, key)) fail("ESHARE_CLI_USAGE", `--${key} may be provided only once`, { exitCode: 2 });
  options[key] = value;
}

export function parseShareCliArgs(argv) {
  assertArgv(argv);
  const positional = [];
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    if (token === "--") fail("ESHARE_CLI_USAGE", "-- is not accepted", { exitCode: 2 });
    const raw = token.slice(2);
    if (!raw || raw.includes("=") || !/^[a-z][a-z0-9-]*$/u.test(raw)) {
      fail("ESHARE_CLI_USAGE", "invalid option syntax", { exitCode: 2 });
    }
    if (BOOLEAN_OPTIONS.has(raw)) {
      addOption(options, raw, true);
      continue;
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      fail("ESHARE_CLI_USAGE", `--${raw} requires one value`, { exitCode: 2 });
    }
    addOption(options, raw, argv[++index]);
  }
  const command = positional.length > 0 ? positional[0] : "help";
  if (!COMMANDS.has(command)) fail("ESHARE_CLI_USAGE", "unknown share command", { exitCode: 2 });
  if (positional.length > 1) fail("ESHARE_CLI_USAGE", "share commands do not accept positional arguments", { exitCode: 2 });
  return Object.freeze({ command, options: Object.freeze(options) });
}

function assertKnownOptions(options, allowed, command) {
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail("ESHARE_CLI_USAGE", `${command} does not accept --${key}`, { exitCode: 2 });
  }
  if (options.json !== undefined && options.json !== true) fail("ESHARE_CLI_USAGE", "--json must be a flag", { exitCode: 2 });
  if (options.help !== undefined && options.help !== true) fail("ESHARE_CLI_USAGE", "--help must be a flag", { exitCode: 2 });
}

function stringOption(options, key, label, { required = false, maxBytes = null } = {}) {
  const value = options[key];
  if (value === undefined) {
    if (required) fail("ESHARE_CLI_USAGE", `${label} is required`, { exitCode: 2 });
    return null;
  }
  if (typeof value !== "string" || value.length === 0) fail("ESHARE_CLI_USAGE", `${label} must be one non-empty value`, { exitCode: 2 });
  if (maxBytes !== null && Buffer.byteLength(value, "utf8") > maxBytes) {
    fail("ESHARE_CLI_LIMIT", `${label} exceeds its bounded size`, { exitCode: 2 });
  }
  return value;
}

function integerOption(options, key, label, { required = false, min, max } = {}) {
  const value = stringOption(options, key, label, { required });
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) fail("ESHARE_CLI_USAGE", `${label} must be an integer`, { exitCode: 2 });
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < min || integer > max) {
    fail("ESHARE_CLI_USAGE", `${label} must be an integer from ${min} through ${max}`, { exitCode: 2 });
  }
  return integer;
}

function deadlineOption(options) {
  return integerOption(options, "deadline-ms", "--deadline-ms", {
    min: 1,
    max: SHARE_LIMITS.maxDeadlineMs
  });
}

function safeIdentifier(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail("ESHARE_CLI_USAGE", `${label} is invalid`, { exitCode: 2 });
  return value;
}

function rawPathHasTraversal(value) {
  return value.split(/[\\/]+/u).some((part) => part === "..");
}

function safePath(value, label, cwd) {
  if (typeof value !== "string" || value.length === 0 || value === "-") fail("ESHARE_CLI_USAGE", `${label} must be a path`, { exitCode: 2 });
  if (rawPathHasTraversal(value)) fail("ESHARE_CLI_USAGE", `${label} must not contain traversal components`, { exitCode: 2 });
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
  if (resolved === path.parse(resolved).root) fail("ESHARE_CLI_USAGE", `${label} is too broad`, { exitCode: 2 });
  return resolved;
}

async function inspectPathComponents(target, { allowMissingLeaf = false, label }) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const relative = path.relative(root, resolved);
  const components = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT" && allowMissingLeaf && index === components.length - 1) return;
      if (error.code === "ENOENT") fail("ESHARE_CLI_NOT_FOUND", `${label} has a missing path component`, { exitCode: 2 });
      fail("ESHARE_CLI_FS", `${label} could not be inspected`, { exitCode: 2 });
    }
    if (info.isSymbolicLink()) {
      const macAlias = process.platform === "darwin" &&
        ["/var", "/tmp", "/etc"].includes(current) &&
        await realpath(current).then((resolvedAlias) => resolvedAlias === path.join("/private", current.slice(1))).catch(() => false);
      if (!macAlias) fail("ESHARE_CLI_FS", `${label} contains a symbolic link`, { exitCode: 2 });
      continue;
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      fail("ESHARE_CLI_FS", `${label} has a non-directory parent`, { exitCode: 2 });
    }
  }
}

async function assertStateRoot(root) {
  await inspectPathComponents(root, { allowMissingLeaf: true, label: "state root" });
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("ESHARE_CLI_FS", "state root is not a regular directory", { exitCode: 2 });
  } catch (error) {
    if (error instanceof ShareCliError) throw error;
    if (error.code !== "ENOENT") fail("ESHARE_CLI_FS", "state root could not be inspected", { exitCode: 2 });
  }
}

function resolveStateRoot(options, env) {
  const raw = options["state-root"] ?? getStateRoot(env);
  if (typeof raw !== "string" || !path.isAbsolute(raw) || rawPathHasTraversal(raw)) {
    fail("ESHARE_CLI_USAGE", "state root must be an absolute path without traversal components", { exitCode: 2 });
  }
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root) fail("ESHARE_CLI_USAGE", "state root is too broad", { exitCode: 2 });
  return resolved;
}

async function readBoundedJsonFile(filePath, label, maxBytes = SHARE_CLI_MAX_INPUT_BYTES) {
  await inspectPathComponents(filePath, { label });
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      fail("ESHARE_CLI_FS", `${label} is not a regular single-link file`, { exitCode: 2 });
    }
    if (!Number.isSafeInteger(before.size) || before.size > maxBytes) {
      fail("ESHARE_CLI_LIMIT", `${label} exceeds its bounded input size`, { exitCode: 2 });
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail("ESHARE_CLI_FS", `${label} changed while being read`, { exitCode: 2 });
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("ESHARE_CLI_INVALID", `${label} is not valid JSON`, { exitCode: 2 });
    }
  } catch (error) {
    if (error instanceof ShareCliError) throw error;
    if (error.code === "ENOENT") fail("ESHARE_CLI_NOT_FOUND", `${label} does not exist`, { exitCode: 2 });
    if (["EACCES", "EPERM", "ELOOP", "ENOTDIR"].includes(error.code)) {
      fail("ESHARE_CLI_FS", `${label} could not be safely read`, { exitCode: 2 });
    }
    fail("ESHARE_CLI_FS", `${label} could not be read`, { exitCode: 2 });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    fail("ESHARE_CLI_FS", "share export directory could not be synchronized", { exitCode: 2 });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeCreateOnlyJson(filePath, value, label) {
  const parent = path.dirname(filePath);
  await inspectPathComponents(parent, { label: `${label} parent` });
  let parentInfo;
  try {
    parentInfo = await lstat(parent);
  } catch {
    fail("ESHARE_CLI_FS", `${label} parent does not exist`, { exitCode: 2 });
  }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail("ESHARE_CLI_FS", `${label} parent is unsafe`, { exitCode: 2 });
  try {
    const existing = await lstat(filePath);
    if (existing.isSymbolicLink()) fail("ESHARE_CLI_FS", `${label} target is a symbolic link`, { exitCode: 2 });
    fail("ESHARE_CLI_CONFLICT", `${label} already exists; refusing overwrite`, { exitCode: 2 });
  } catch (error) {
    if (error instanceof ShareCliError) throw error;
    if (error.code !== "ENOENT") fail("ESHARE_CLI_FS", `${label} target could not be inspected`, { exitCode: 2 });
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > SHARE_CLI_MAX_OUTPUT_BYTES) fail("ESHARE_CLI_LIMIT", `${label} exceeds its bounded output size`, { exitCode: 2 });
  const tempPrefix = `.${path.basename(filePath)}.${process.pid}.${randomUUID()}`;
  let tempPath;
  let handle;
  let tempCreated = false;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      tempPath = path.join(parent, `${tempPrefix}.${attempt}.tmp`);
      try {
        handle = await open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
        tempCreated = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    if (!handle || !tempPath) fail("ESHARE_CLI_FS", `${label} could not allocate a private temporary file`, { exitCode: 2 });
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      // Publish only the complete, fsynced inode.  A hard link is create-only
      // and therefore cannot replace an existing artifact or follow a target
      // symlink.
      await link(tempPath, filePath);
    } catch (error) {
      if (error.code === "EEXIST") {
        const existing = await lstat(filePath).catch((statError) => {
          if (statError.code === "ENOENT") return null;
          throw statError;
        });
        if (existing?.isSymbolicLink()) fail("ESHARE_CLI_FS", `${label} target is a symbolic link`, { exitCode: 2 });
        fail("ESHARE_CLI_CONFLICT", `${label} already exists; refusing overwrite`, { exitCode: 2 });
      }
      if (error.code === "ELOOP") fail("ESHARE_CLI_FS", `${label} target is a symbolic link`, { exitCode: 2 });
      throw error;
    }
    await unlink(tempPath);
    tempCreated = false;
    await syncDirectory(parent);
  } catch (error) {
    if (error instanceof ShareCliError) throw error;
    if (error.code === "EEXIST") fail("ESHARE_CLI_CONFLICT", `${label} already exists; refusing overwrite`, { exitCode: 2 });
    fail("ESHARE_CLI_FS", `${label} could not be written`, { exitCode: 2 });
  } finally {
    await handle?.close().catch(() => {});
    if (tempCreated && tempPath) await unlink(tempPath).catch(() => {});
  }
  return { bytes: bytes.byteLength, mode: "0600", createOnly: true };
}

function assertShareInput(value) {
  exactKeys(value, SHARE_INPUT_KEYS, "share input");
  requireKeys(value, ["source", "target", "content", "selection", "privacy", "review", "expiresAt", "sourceValidity"], "share input");
  if (!SHARE_SOURCE_VALIDITIES.has(value.sourceValidity)) {
    fail("ESHARE_CLI_REVIEW_REQUIRED", "share source validity must be caller-asserted or local-record-v1", { exitCode: 2 });
  }
  return Object.freeze({
    source: value.source,
    target: value.target,
    content: value.content,
    selection: value.selection,
    privacy: value.privacy,
    review: value.review,
    expiresAt: value.expiresAt,
    sourceBinding: value.sourceValidity === LOCAL_SOURCE_BINDING_V1 ? LOCAL_SOURCE_BINDING_V1 : null
  });
}

async function readShareInput(options, context) {
  const file = safePath(stringOption(options, "file", "--file", { required: true }), "--file", context.cwd);
  const value = await readBoundedJsonFile(file, "share input JSON");
  return { file, value: assertShareInput(value) };
}

function shareIdOption(options) {
  return safeIdentifier(stringOption(options, "share-id", "--share-id", { required: true }), "--share-id");
}

function withDeadline(target, deadlineMs) {
  if (deadlineMs !== null) target.deadlineMs = deadlineMs;
  return target;
}

function resultWithBoundary(value, { sourceValidity = null } = {}) {
  if (!isPlainObject(value)) return value;
  return Object.freeze({
    ...value,
    ...(sourceValidity === null ? {} : { sourceValidity }),
    localPermission: LOCAL_PERMISSION_BOUNDARY
  });
}

function sourceValidityForBinding(sourceBinding) {
  return isLocalSourceBindingV1(sourceBinding) ? LOCAL_SOURCE_BINDING_V1 : "caller-asserted";
}

function sourceValidityForReadResult(result) {
  return sourceValidityForBinding(result?.artifact?.sourceBinding);
}

function sourceStatusForReadResult(result) {
  return isLocalSourceBindingV1(result?.artifact?.sourceBinding) ? "NOT_OBSERVED" : "CALLER_ASSERTED";
}

function sourceValidityForOperationResult(result) {
  if (result?.sourceStatus === "CURRENT") return LOCAL_SOURCE_BINDING_V1;
  if (result?.sourceStatus === "CALLER_ASSERTED") return "caller-asserted";
  return sourceValidityForBinding(result?.artifact?.sourceBinding);
}

async function commandHelp(options) {
  assertKnownOptions(options, new Set(["json", "help"]), "help");
  return {
    ok: true,
    schemaVersion: SHARE_CLI_SCHEMA_VERSION,
    kind: SHARE_CLI_KIND,
    usage: [...USAGE],
    notes: [
      "Create and revise accept sourceValidity caller-asserted or local-record-v1; local-record-v1 re-reads the bound Knowledge, Incident, or Share record before effect.",
      "local-record-v1 is current only when the local resolver matches the supplied source revision and digest; a caller-supplied marker or digest cannot mint that status.",
      "Export writes a validated sanitized ShareExportV1 with create-only atomic publication; it never publishes remotely.",
      "Local permissions separate CLI operations and do not grant owner, provider, action, publication, or evidence authority.",
      "Read reports the stored source binding and does not perform a fresh source observation; caller-asserted artifacts remain explicitly caller-asserted."
    ]
  };
}

async function commandValidate(options, context) {
  assertKnownOptions(options, VALIDATE_OPTIONS, "validate");
  if (options["state-root"] !== undefined) {
    const root = resolveStateRoot(options, context.env);
    await assertStateRoot(root);
  }
  const deadlineMs = deadlineOption(options);
  const file = safePath(stringOption(options, "file", "--file", { required: true }), "--file", context.cwd);
  const raw = await readBoundedJsonFile(file, "share validation JSON");
  if (raw?.kind === SHARE_EXPORT_KIND) {
    const exported = validateShareExportV1(raw);
    return resultWithBoundary({ ok: true, operation: "share.validate-export", inputKind: SHARE_EXPORT_KIND, export: exported });
  }
  if (raw?.kind !== SHARE_ARTIFACT_KIND) fail("ESHARE_CLI_INVALID", "validation input must be a ShareArtifactV1 or ShareExportV1", { exitCode: 2 });
  // The core validator owns the exact bounded traversal.  The CLI deadline is
  // parsed and bounded for a stable command contract; validation itself uses
  // the core's fixed bounded traversal and does not accept caller timeouts as
  // an authority override.
  void deadlineMs;
  return resultWithBoundary({ ok: true, operation: "share.validate", inputKind: SHARE_ARTIFACT_KIND, artifact: validateShareArtifactV1(raw) });
}

async function commandCreate(options, context) {
  assertKnownOptions(options, INPUT_OPTIONS, "create");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const shareId = shareIdOption(options);
  const deadlineMs = deadlineOption(options);
  const { value } = await readShareInput(options, context);
  const permission = createShareCreatePermissionV1({ stateRoot: root, shareId, ...value, expectedRevision: 0 });
  const result = await createShareArtifactV1(withDeadline({ stateRoot: root, shareId, ...value, permission }, deadlineMs));
  return resultWithBoundary({ ...result, inputKind: "ShareInputV1" }, { sourceValidity: sourceValidityForOperationResult(result) });
}

async function commandRevise(options, context) {
  assertKnownOptions(options, REVISION_OPTIONS, "revise");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const shareId = shareIdOption(options);
  const expectedRevision = integerOption(options, "expected-revision", "--expected-revision", {
    required: true,
    min: 1,
    max: SHARE_LIMITS.maxRevisionCount - 1
  });
  const deadlineMs = deadlineOption(options);
  const { value } = await readShareInput(options, context);
  const permission = createShareRevisionPermissionV1({ stateRoot: root, shareId, ...value, expectedRevision });
  const result = await reviseShareArtifactV1(withDeadline({ stateRoot: root, shareId, ...value, permission }, deadlineMs));
  return resultWithBoundary({ ...result, inputKind: "ShareInputV1" }, { sourceValidity: sourceValidityForOperationResult(result) });
}

async function commandRead(options, context) {
  assertKnownOptions(options, READ_OPTIONS, "read");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const shareId = shareIdOption(options);
  const revision = integerOption(options, "revision", "--revision", {
    min: 1,
    max: SHARE_LIMITS.maxRevisionCount
  });
  const deadlineMs = deadlineOption(options);
  const permission = createShareReadPermissionV1({ stateRoot: root, shareId, revision });
  const result = await readShareArtifactV1(withDeadline({ stateRoot: root, shareId, permission }, deadlineMs));
  return resultWithBoundary({ ...result, sourceStatus: sourceStatusForReadResult(result) }, { sourceValidity: sourceValidityForReadResult(result) });
}

async function commandList(options, context) {
  assertKnownOptions(options, COMMON_OPTIONS, "list");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const deadlineMs = deadlineOption(options);
  const permission = createShareUnboundReadPermissionV1({ stateRoot: root });
  const shares = await listShareArtifactsV1(withDeadline({ stateRoot: root, permission }, deadlineMs));
  return resultWithBoundary({ ok: true, operation: "share.list", shares });
}

async function commandExport(options, context) {
  assertKnownOptions(options, EXPORT_OPTIONS, "export");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const shareId = shareIdOption(options);
  const revision = integerOption(options, "revision", "--revision", {
    min: 1,
    max: SHARE_LIMITS.maxRevisionCount
  });
  const out = safePath(stringOption(options, "out", "--out", { required: true }), "--out", context.cwd);
  const deadlineMs = deadlineOption(options);
  const permission = createShareExportPermissionV1({ stateRoot: root, shareId, revision });
  const result = await exportShareArtifactV1(withDeadline({ stateRoot: root, shareId, permission }, deadlineMs));
  const output = await writeCreateOnlyJson(out, result.export, "share export artifact");
  return resultWithBoundary({
    ok: true,
    operation: result.operation,
    shareId: result.shareId,
    revision: result.revision,
    exportDigest: result.exportDigest,
    output,
    published: false,
    remoteShare: false,
    authority: "local-advisory-only",
    sourceStatus: result.sourceStatus
  }, { sourceValidity: sourceValidityForOperationResult(result) });
}

async function commandMutation(options, context, action) {
  assertKnownOptions(options, MUTATION_OPTIONS, action);
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const shareId = shareIdOption(options);
  const expectedRevision = integerOption(options, "expected-revision", "--expected-revision", {
    required: true,
    min: 1,
    max: SHARE_LIMITS.maxRevisionCount
  });
  const reason = stringOption(options, "reason", "--reason", { maxBytes: SHARE_LIMITS.maxReasonBytes });
  const deadlineMs = deadlineOption(options);
  const permission = action === "revoke"
    ? createShareRevokePermissionV1({ stateRoot: root, shareId, expectedRevision })
    : createShareExpirePermissionV1({ stateRoot: root, shareId, expectedRevision });
  const request = withDeadline({ stateRoot: root, shareId, permission }, deadlineMs);
  if (reason !== null) request.reason = reason;
  const result = action === "revoke"
    ? await revokeShareArtifactV1(request)
    : await expireShareArtifactV1(request);
  return resultWithBoundary(result);
}

export async function handleShareCli(argv = [], { env = process.env, cwd = process.cwd() } = {}) {
  const parsed = parseShareCliArgs(argv);
  if (parsed.command === "help" || parsed.options.help === true) return commandHelp(parsed.options);
  switch (parsed.command) {
    case "validate":
      return commandValidate(parsed.options, { env, cwd });
    case "create":
      return commandCreate(parsed.options, { env, cwd });
    case "revise":
      return commandRevise(parsed.options, { env, cwd });
    case "read":
      return commandRead(parsed.options, { env, cwd });
    case "list":
      return commandList(parsed.options, { env, cwd });
    case "export":
      return commandExport(parsed.options, { env, cwd });
    case "revoke":
    case "expire":
      return commandMutation(parsed.options, { env, cwd }, parsed.command);
    default:
      fail("ESHARE_CLI_USAGE", "unsupported share command", { exitCode: 2 });
  }
}

function normalizeError(error) {
  if (error instanceof ShareCliError) return error;
  if (error instanceof ShareError) return new ShareCliError(error.code, error.message, { exitCode: 2 });
  if (["EACCES", "EPERM", "ELOOP", "ENOTDIR", "ENOENT"].includes(error?.code)) {
    return new ShareCliError(error.code === "ENOENT" ? "ESHARE_CLI_NOT_FOUND" : "ESHARE_CLI_FS", "share CLI filesystem operation failed", { exitCode: 2 });
  }
  return new ShareCliError("ESHARE_CLI_INTERNAL", "share CLI operation failed", { exitCode: 2 });
}

export async function runShareCli(argv = [], context = {}) {
  try {
    return { exitCode: 0, value: await handleShareCli(argv, context) };
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      exitCode: normalized.exitCode,
      value: {
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.details === undefined ? {} : { details: normalized.details })
        }
      }
    };
  }
}

export async function main(argv = process.argv.slice(2), context = {}) {
  const result = await runShareCli(argv, context);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  process.exitCode = result.exitCode;
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
