import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INCIDENT_LIMITS
} from "./incident-v1.mjs";
import {
  getStateRoot
} from "./core.mjs";
import {
  IncidentRecoveryError,
  prepareIncidentRecoveryV1,
  validateIncidentRecoveryPlanV1,
  verifyIncidentRecoveryV1
} from "./incident-recovery-v1.mjs";
import {
  isTrustedControllerAdapter,
  isTrustedOwnedResourceAdapter
} from "./execution-runtime-v1.mjs";
import { isNativeV3CommandRunner } from "./native-v3-command-runner.mjs";

export const INCIDENT_RECOVERY_CLI_SCHEMA_VERSION = 1;
export const INCIDENT_RECOVERY_CLI_KIND = "IncidentRecoveryCliV1";
export const INCIDENT_RECOVERY_CLI_MAX_INPUT_BYTES = INCIDENT_LIMITS.maxRecordBytes;
export const INCIDENT_RECOVERY_CLI_MAX_OUTPUT_BYTES = INCIDENT_LIMITS.maxRecordBytes;
export const INCIDENT_RECOVERY_CLI_MAX_PATH_BYTES = 4_096;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const COMMANDS = new Set(["help", "prepare", "verify", "resume"]);
const BOOLEAN_OPTIONS = new Set(["json", "help"]);
const COMMON_OPTIONS = new Set(["state-root", "deadline-ms", "json", "help"]);
const PREPARE_OPTIONS = new Set([
  ...COMMON_OPTIONS,
  "incident-id", "incident-revision", "incident-digest", "run-id", "handle-id",
  "new-execution-id", "new-attempt-id", "reason", "out"
]);
const PLAN_OPTIONS = new Set([...COMMON_OPTIONS, "file"]);
const USAGE = Object.freeze([
  "incident-recovery-cli-v1.mjs help [--json]",
  "incident-recovery-cli-v1.mjs prepare --incident-id <id> --incident-revision <1..64> --run-id <id> --handle-id <id> --new-execution-id <id> --new-attempt-id <id> --out <new-plan.json> [--incident-digest <sha256>] [--reason <text>] [--state-root <absolute>] [--deadline-ms <1..2000>] [--json]",
  "incident-recovery-cli-v1.mjs verify --file <plan.json> [--state-root <absolute>] [--deadline-ms <1..2000>] [--json]",
  "incident-recovery-cli-v1.mjs resume --file <plan.json> [--state-root <absolute>] [--deadline-ms <1..2000>] [--json] (standalone requires a trusted single-use resume runner; sbw supplies an allocation-backed bridge)"
]);

const CONTEXT_KEYS = new Set(["controller", "resourceAdapter", "runner", "cwd", "env"]);
const INTERNAL_FS_CODES = new Set(["EACCES", "EPERM", "ELOOP", "ENOTDIR", "EISDIR", "EINVAL"]);

export class IncidentRecoveryCliError extends Error {
  constructor(code, message, {
    status = "HOLD",
    exitCode = 2,
    details = undefined
  } = {}) {
    super(message);
    this.name = "IncidentRecoveryCliError";
    this.code = code;
    this.status = status;
    this.exitCode = exitCode;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, options = {}) {
  throw new IncidentRecoveryCliError(code, message, options);
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
  if (!isPlainObject(value)) fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} contains a symbol property`);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} could not be inspected`);
    }
    if (!descriptor || descriptor.get || descriptor.set) {
      fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} contains an accessor property`);
    }
  }
  return value;
}

function exactKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Reflect.ownKeys(value).filter((key) => typeof key !== "string" || !allowed.has(key));
  if (unknown.length > 0) fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} contains an unsupported field`);
}

function requireKeys(value, keys, label) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} requires ${key}`);
  }
}

function assertArgv(argv) {
  if (!Array.isArray(argv) || Object.getPrototypeOf(argv) !== Array.prototype) {
    fail("EINCIDENT_RECOVERY_CLI_USAGE", "argv must be a standard array");
  }
  for (const item of argv) {
    if (typeof item !== "string") fail("EINCIDENT_RECOVERY_CLI_USAGE", "argv contains a non-text argument");
    if (Buffer.byteLength(item, "utf8") > INCIDENT_RECOVERY_CLI_MAX_PATH_BYTES) {
      fail("EINCIDENT_RECOVERY_CLI_LIMIT", "an argument exceeds the bounded size", { exitCode: 2 });
    }
  }
}

function addOption(options, key, value) {
  if (Object.hasOwn(options, key)) fail("EINCIDENT_RECOVERY_CLI_USAGE", `--${key} may be provided only once`);
  options[key] = value;
}

export function parseIncidentRecoveryCliArgs(argv) {
  assertArgv(argv);
  const positional = [];
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    if (token === "--") fail("EINCIDENT_RECOVERY_CLI_USAGE", "-- is not accepted");
    const raw = token.slice(2);
    if (!raw || raw.includes("=") || !/^[a-z][a-z0-9-]*$/u.test(raw)) {
      fail("EINCIDENT_RECOVERY_CLI_USAGE", "invalid option syntax");
    }
    if (BOOLEAN_OPTIONS.has(raw)) {
      addOption(options, raw, true);
      continue;
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      fail("EINCIDENT_RECOVERY_CLI_USAGE", `--${raw} requires one value`);
    }
    addOption(options, raw, argv[++index]);
  }
  const command = positional.length > 0 ? positional[0] : "help";
  if (!COMMANDS.has(command)) fail("EINCIDENT_RECOVERY_CLI_USAGE", "unknown incident recovery command");
  if (positional.length > 1) fail("EINCIDENT_RECOVERY_CLI_USAGE", "incident recovery commands do not accept positional arguments");
  return Object.freeze({ command, options: Object.freeze(options) });
}

function assertKnownOptions(options, allowed, command) {
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail("EINCIDENT_RECOVERY_CLI_USAGE", `${command} does not accept --${key}`);
  }
  if (options.json !== undefined && options.json !== true) {
    fail("EINCIDENT_RECOVERY_CLI_USAGE", "--json must be a flag");
  }
  if (options.help !== undefined && options.help !== true) {
    fail("EINCIDENT_RECOVERY_CLI_USAGE", "--help must be a flag");
  }
}

function stringOption(options, key, label, { required = false, maxBytes = null } = {}) {
  const value = options[key];
  if (value === undefined) {
    if (required) fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} is required`);
    return null;
  }
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} must be one non-empty value`);
  }
  if (maxBytes !== null && Buffer.byteLength(value, "utf8") > maxBytes) {
    fail("EINCIDENT_RECOVERY_CLI_LIMIT", `${label} exceeds the bounded size`, { exitCode: 2 });
  }
  return value;
}

function integerOption(options, key, label, { required = false, min, max } = {}) {
  const value = stringOption(options, key, label, { required });
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} must be an integer`);
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < min || integer > max) {
    fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} must be an integer from ${min} through ${max}`);
  }
  return integer;
}

function safeIdentifier(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} is invalid`);
  return value;
}

function safeDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} is invalid`);
  return value;
}

function rawPathHasTraversal(value) {
  return value.split(/[\\/]+/u).some((part) => part === "..");
}

function safePath(value, label, cwd) {
  const supplied = stringOption({ value }, "value", label, { required: true, maxBytes: INCIDENT_RECOVERY_CLI_MAX_PATH_BYTES });
  if (supplied === "-" || rawPathHasTraversal(supplied)) {
    fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} must be a non-traversing path`);
  }
  const resolved = path.isAbsolute(supplied) ? path.resolve(supplied) : path.resolve(cwd, supplied);
  if (resolved === path.parse(resolved).root) fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} is too broad`);
  return resolved;
}

function safeStateRoot(value, label) {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value) || rawPathHasTraversal(value) ||
      Buffer.byteLength(value, "utf8") > INCIDENT_RECOVERY_CLI_MAX_PATH_BYTES) {
    fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} must be an absolute path without traversal components`);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) fail("EINCIDENT_RECOVERY_CLI_USAGE", `${label} is too broad`);
  return resolved;
}

async function inspectPathComponents(target, { allowMissingLeaf = false, label }) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const components = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT" && allowMissingLeaf && index === components.length - 1) return;
      if (error.code === "ENOENT") fail("EINCIDENT_RECOVERY_CLI_NOT_FOUND", `${label} is unavailable`);
      fail("EINCIDENT_RECOVERY_CLI_FS", `${label} could not be inspected`);
    }
    if (info.isSymbolicLink()) {
      const macAlias = process.platform === "darwin" &&
        ["/var", "/tmp", "/etc"].includes(current) &&
        await realpath(current)
          .then((resolvedAlias) => resolvedAlias === path.join("/private", current.slice(1)))
          .catch(() => false);
      if (!macAlias) fail("EINCIDENT_RECOVERY_CLI_FS", `${label} contains a symbolic link`);
      continue;
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      fail("EINCIDENT_RECOVERY_CLI_FS", `${label} has a non-directory parent`);
    }
  }
}

async function assertStateRoot(root) {
  await inspectPathComponents(root, { allowMissingLeaf: true, label: "state root" });
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("EINCIDENT_RECOVERY_CLI_FS", "state root is not a regular directory");
  } catch (error) {
    if (error instanceof IncidentRecoveryCliError) throw error;
    if (error.code !== "ENOENT") fail("EINCIDENT_RECOVERY_CLI_FS", "state root could not be inspected");
  }
}

function resolveStateRoot(options, env) {
  const raw = options["state-root"] ?? getStateRoot(env);
  return safeStateRoot(raw, "state root");
}

function fileSnapshot(info) {
  return [info?.dev, info?.ino, info?.mode, info?.nlink, info?.size, info?.mtimeMs, info?.ctimeMs];
}

function sameFileSnapshot(left, right) {
  return JSON.stringify(fileSnapshot(left)) === JSON.stringify(fileSnapshot(right));
}

async function readBoundedJsonFile(filePath, label) {
  await inspectPathComponents(filePath, { label });
  let beforePath;
  try {
    beforePath = await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") fail("EINCIDENT_RECOVERY_CLI_NOT_FOUND", `${label} does not exist`);
    fail("EINCIDENT_RECOVERY_CLI_FS", `${label} could not be inspected`);
  }
  if (beforePath.isSymbolicLink() || !beforePath.isFile() || beforePath.nlink !== 1 || (beforePath.mode & 0o077) !== 0) {
    fail("EINCIDENT_RECOVERY_CLI_FS", `${label} is not a private regular file`);
  }
  if (!Number.isSafeInteger(beforePath.size) || beforePath.size > INCIDENT_RECOVERY_CLI_MAX_INPUT_BYTES) {
    fail("EINCIDENT_RECOVERY_CLI_LIMIT", `${label} exceeds the bounded input size`);
  }
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const beforeHandle = await handle.stat();
    if (!beforeHandle.isFile() || beforeHandle.nlink !== 1 || (beforeHandle.mode & 0o077) !== 0 ||
        !sameFileSnapshot(beforePath, beforeHandle)) {
      fail("EINCIDENT_RECOVERY_CLI_FS", `${label} changed before it was read`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > INCIDENT_RECOVERY_CLI_MAX_INPUT_BYTES) {
      fail("EINCIDENT_RECOVERY_CLI_LIMIT", `${label} exceeds the bounded input size`);
    }
    const afterHandle = await handle.stat();
    if (!sameFileSnapshot(beforeHandle, afterHandle) || afterHandle.size !== bytes.byteLength) {
      fail("EINCIDENT_RECOVERY_CLI_FS", `${label} changed while it was read`);
    }
    const afterPath = await lstat(filePath).catch(() => null);
    if (!afterPath || afterPath.isSymbolicLink() || !sameFileSnapshot(beforePath, afterPath)) {
      fail("EINCIDENT_RECOVERY_CLI_FS", `${label} changed while it was read`);
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("EINCIDENT_RECOVERY_CLI_INVALID", `${label} is not valid JSON`);
    }
  } catch (error) {
    if (error instanceof IncidentRecoveryCliError) throw error;
    if (error.code === "ENOENT") fail("EINCIDENT_RECOVERY_CLI_NOT_FOUND", `${label} does not exist`);
    if (INTERNAL_FS_CODES.has(error.code)) fail("EINCIDENT_RECOVERY_CLI_FS", `${label} could not be read safely`);
    fail("EINCIDENT_RECOVERY_CLI_FS", `${label} could not be read safely`);
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
    fail("EINCIDENT_RECOVERY_CLI_FS", "recovery plan directory could not be synchronized");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeCreateOnlyJson(filePath, value) {
  const parent = path.dirname(filePath);
  await inspectPathComponents(parent, { label: "recovery plan output parent" });
  let parentInfo;
  try {
    parentInfo = await lstat(parent);
  } catch (error) {
    if (error.code === "ENOENT") fail("EINCIDENT_RECOVERY_CLI_NOT_FOUND", "recovery plan output parent is unavailable");
    fail("EINCIDENT_RECOVERY_CLI_FS", "recovery plan output parent could not be inspected");
  }
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || (parentInfo.mode & 0o077) !== 0) {
    fail("EINCIDENT_RECOVERY_CLI_FS", "recovery plan output parent is not private");
  }
  try {
    const existing = await lstat(filePath);
    if (existing.isSymbolicLink()) fail("EINCIDENT_RECOVERY_CLI_FS", "recovery plan output is a symbolic link");
    fail("EINCIDENT_RECOVERY_CLI_CONFLICT", "recovery plan output already exists; refusing overwrite");
  } catch (error) {
    if (error instanceof IncidentRecoveryCliError) throw error;
    if (error.code !== "ENOENT") fail("EINCIDENT_RECOVERY_CLI_FS", "recovery plan output could not be inspected");
  }
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    fail("EINCIDENT_RECOVERY_CLI_INVALID", "recovery plan could not be serialized");
  }
  if (bytes.byteLength > INCIDENT_RECOVERY_CLI_MAX_OUTPUT_BYTES) {
    fail("EINCIDENT_RECOVERY_CLI_LIMIT", "recovery plan exceeds the bounded output size");
  }
  const temporary = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let temporaryCreated = false;
  let published = false;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    temporaryCreated = true;
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporary, filePath);
      published = true;
    } catch (error) {
      if (error.code === "EEXIST") {
        const existing = await lstat(filePath).catch((statError) => {
          if (statError.code === "ENOENT") return null;
          throw statError;
        });
        if (existing?.isSymbolicLink()) fail("EINCIDENT_RECOVERY_CLI_FS", "recovery plan output is a symbolic link");
        fail("EINCIDENT_RECOVERY_CLI_CONFLICT", "recovery plan output already exists; refusing overwrite");
      }
      if (INTERNAL_FS_CODES.has(error.code)) fail("EINCIDENT_RECOVERY_CLI_FS", "recovery plan output could not be published safely");
      throw error;
    }
    const targetInfo = await lstat(filePath);
    const temporaryInfo = await lstat(temporary);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile() || targetInfo.nlink < 2 ||
        temporaryInfo.dev !== targetInfo.dev || temporaryInfo.ino !== targetInfo.ino ||
        (targetInfo.mode & 0o077) !== 0 || targetInfo.size !== bytes.byteLength) {
      fail("EINCIDENT_RECOVERY_CLI_FS", "recovery plan output failed its publication check");
    }
    await unlink(temporary);
    temporaryCreated = false;
    await syncDirectory(parent);
  } catch (error) {
    if (error instanceof IncidentRecoveryCliError) throw error;
    if (error.code === "EEXIST") fail("EINCIDENT_RECOVERY_CLI_CONFLICT", "recovery plan output already exists; refusing overwrite");
    fail("EINCIDENT_RECOVERY_CLI_FS", "recovery plan output could not be written safely");
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryCreated) await unlink(temporary).catch(() => {});
    // A published hard link contains a complete fsynced plan.  If the final
    // directory sync fails, retain that evidence and report the durability
    // failure; never replace it with a second write.
    void published;
  }
  return Object.freeze({ bytes: bytes.byteLength, mode: "0600", createOnly: true });
}

function assertTrustedContext(context) {
  const value = context ?? {};
  exactKeys(value, CONTEXT_KEYS, "incident recovery CLI context");
  if (!isTrustedControllerAdapter(value.controller)) {
    fail("EINCIDENT_RECOVERY_CLI_AUTHORITY", "incident recovery CLI requires a trusted controller context");
  }
  if (value.resourceAdapter !== undefined && value.resourceAdapter !== null &&
      !isTrustedOwnedResourceAdapter(value.resourceAdapter)) {
    fail("EINCIDENT_RECOVERY_CLI_AUTHORITY", "incident recovery CLI requires a trusted owned-resource context");
  }
  if (value.runner !== undefined && value.runner !== null && !isNativeV3CommandRunner(value.runner)) {
    fail("EINCIDENT_RECOVERY_CLI_AUTHORITY", "incident recovery CLI requires a trusted native runner context");
  }
  const cwd = value.cwd ?? process.cwd();
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || rawPathHasTraversal(cwd)) {
    fail("EINCIDENT_RECOVERY_CLI_USAGE", "CLI cwd must be an absolute path without traversal components");
  }
  const env = value.env ?? process.env;
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    fail("EINCIDENT_RECOVERY_CLI_USAGE", "CLI environment must be an object");
  }
  return Object.freeze({
    controller: value.controller,
    resourceAdapter: value.resourceAdapter ?? null,
    runner: value.runner ?? null,
    cwd: path.resolve(cwd),
    env
  });
}

function prepareOptions(options, context) {
  assertKnownOptions(options, PREPARE_OPTIONS, "prepare");
  const stateRoot = resolveStateRoot(options, context.env);
  const incidentId = safeIdentifier(stringOption(options, "incident-id", "--incident-id", { required: true }), "--incident-id");
  const incidentRevision = integerOption(options, "incident-revision", "--incident-revision", {
    required: true,
    min: 1,
    max: INCIDENT_LIMITS.maxRevisionCount
  });
  const incidentDigest = options["incident-digest"] === undefined
    ? undefined
    : safeDigest(stringOption(options, "incident-digest", "--incident-digest"), "--incident-digest");
  const runId = safeIdentifier(stringOption(options, "run-id", "--run-id", { required: true }), "--run-id");
  const handleId = safeIdentifier(stringOption(options, "handle-id", "--handle-id", { required: true }), "--handle-id");
  const newExecutionId = safeIdentifier(stringOption(options, "new-execution-id", "--new-execution-id", { required: true }), "--new-execution-id");
  const newAttemptId = safeIdentifier(stringOption(options, "new-attempt-id", "--new-attempt-id", { required: true }), "--new-attempt-id");
  const reason = stringOption(options, "reason", "--reason", { maxBytes: 2_048 }) ?? undefined;
  const deadline = integerOption(options, "deadline-ms", "--deadline-ms", {
    min: 1,
    max: INCIDENT_LIMITS.maxDeadlineMs
  });
  const out = safePath(stringOption(options, "out", "--out", { required: true }), "--out", context.cwd);
  return { stateRoot, incidentId, incidentRevision, incidentDigest, runId, handleId, newExecutionId, newAttemptId, reason, deadlineMs: deadline, out };
}

function planFileOptions(options, context, command) {
  assertKnownOptions(options, PLAN_OPTIONS, command);
  const stateRoot = resolveStateRoot(options, context.env);
  const file = safePath(stringOption(options, "file", "--file", { required: true }), "--file", context.cwd);
  const deadline = integerOption(options, "deadline-ms", "--deadline-ms", {
    min: 1,
    max: INCIDENT_LIMITS.maxDeadlineMs
  });
  return { stateRoot, file, deadlineMs: deadline };
}

async function commandHelp(options) {
  assertKnownOptions(options, new Set(["json", "help"]), "help");
  return {
    ok: true,
    schemaVersion: INCIDENT_RECOVERY_CLI_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_CLI_KIND,
    usage: [...USAGE],
    notes: [
      "Prepare and verify require a trusted controller object supplied by the embedding caller; JSON cannot create authority.",
      "Prepare writes only a validated IncidentRecoveryPlanV1 using a same-directory fsynced create-only publication with mode 0600.",
      "Verify re-reads current incident, runtime, source, policy, intent, and admission through the trusted core; stale or unresolved UNKNOWN remains blocked.",
      "Resume consumes one trusted native runner that is already bound to the recovery plan; a caller-supplied JSON runner or callback cannot launch an effect."
    ]
  };
}

async function commandPrepare(options, context) {
  const input = prepareOptions(options, context);
  await assertStateRoot(input.stateRoot);
  const result = await prepareIncidentRecoveryV1({
    stateRoot: input.stateRoot,
    incidentId: input.incidentId,
    incidentRevision: input.incidentRevision,
    ...(input.incidentDigest === undefined ? {} : { incidentDigest: input.incidentDigest }),
    runId: input.runId,
    handleId: input.handleId,
    newExecutionId: input.newExecutionId,
    newAttemptId: input.newAttemptId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    controller: context.controller,
    resourceAdapter: context.resourceAdapter,
    ...(input.deadlineMs === null ? {} : { deadlineMs: input.deadlineMs })
  });
  const plan = validateIncidentRecoveryPlanV1(result.plan);
  const artifact = await writeCreateOnlyJson(input.out, plan);
  return Object.freeze({
    ok: true,
    schemaVersion: INCIDENT_RECOVERY_CLI_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_CLI_KIND,
    operation: "incident.recovery.prepare",
    status: "prepared",
    recoveryId: plan.recoveryId,
    planDigest: plan.planDigest,
    proof: plan.proof,
    artifact: {
      kind: plan.kind,
      digest: plan.planDigest,
      ...artifact
    }
  });
}

async function readAndValidatePlan(options, context, command) {
  const input = planFileOptions(options, context, command);
  await assertStateRoot(input.stateRoot);
  const raw = await readBoundedJsonFile(input.file, "incident recovery plan");
  let plan;
  try {
    plan = validateIncidentRecoveryPlanV1(raw);
  } catch (error) {
    if (error instanceof IncidentRecoveryError) {
      fail("EINCIDENT_RECOVERY_CLI_INVALID", "incident recovery plan is invalid", { details: { cause: error.code } });
    }
    fail("EINCIDENT_RECOVERY_CLI_INVALID", "incident recovery plan is invalid");
  }
  return { ...input, plan };
}

async function commandVerify(options, context) {
  const input = await readAndValidatePlan(options, context, "verify");
  const result = await verifyIncidentRecoveryV1({
    stateRoot: input.stateRoot,
    plan: input.plan,
    controller: context.controller,
    resourceAdapter: context.resourceAdapter,
    ...(input.deadlineMs === null ? {} : { deadlineMs: input.deadlineMs })
  });
  return Object.freeze({
    ok: true,
    schemaVersion: INCIDENT_RECOVERY_CLI_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_CLI_KIND,
    operation: "incident.recovery.verify",
    status: "verified",
    recoveryId: input.plan.recoveryId,
    planDigest: input.plan.planDigest,
    proof: input.plan.proof,
    verification: result
  });
}

async function commandResume(options, context) {
  const input = await readAndValidatePlan(options, context, "resume");
  if (context.runner === null) {
    return Object.freeze({
      ok: false,
      schemaVersion: INCIDENT_RECOVERY_CLI_SCHEMA_VERSION,
      kind: INCIDENT_RECOVERY_CLI_KIND,
      operation: "incident.recovery.resume",
      status: "HOLD",
      recoveryId: input.plan.recoveryId,
      planDigest: input.plan.planDigest,
      error: {
        code: "EINCIDENT_RECOVERY_RESUME_SEAM",
        message: "incident recovery has no trusted single-use resume runner"
      }
    });
  }
  const runner = context.runner;
  if (runner.planId === undefined || runner.planId.length === 0 || runner.runId !== input.plan.runId ||
      runner.attemptId !== input.plan.newAttemptId) {
    fail("EINCIDENT_RECOVERY_BINDING", "trusted resume runner is not bound to the recovery plan", { status: "HOLD" });
  }
  let before;
  try {
    before = await runner.status();
  } catch (error) {
    fail("EINCIDENT_RECOVERY_UNKNOWN", "trusted resume runner status could not be observed", {
      status: "UNKNOWN",
      exitCode: 3,
      details: safeErrorDetails({ cause: error?.code })
    });
  }
  assertResumeRunnerHandle(before, input.plan);
  if (before.handle.status !== "ready" || before.intent !== null) {
    fail("EINCIDENT_RECOVERY_RESUME_REPLAY", "trusted resume runner is no longer unused", { status: "HOLD" });
  }
  let execution;
  try {
    execution = await runner.execute();
  } catch (error) {
    let observed = null;
    try {
      observed = await runner.status();
    } catch {
      // The execution error is already treated as an unresolved runtime fact.
    }
    if (observed?.handle) {
      assertResumeRunnerHandle(observed, input.plan);
    }
    const unknown = error?.status === "UNKNOWN" || observed?.handle?.status === "indeterminate" || observed?.intent?.status === "unknown";
    fail(
      unknown ? "EINCIDENT_RECOVERY_UNKNOWN" : (error?.code ?? "EINCIDENT_RECOVERY_RESUME"),
      unknown ? "incident recovery resume outcome is unresolved" : "incident recovery resume did not complete",
      {
        status: unknown ? "UNKNOWN" : "HOLD",
        exitCode: unknown ? 3 : 2,
        details: safeErrorDetails({ cause: error?.code })
      }
    );
  }
  let after;
  try {
    after = await runner.status();
  } catch (error) {
    fail("EINCIDENT_RECOVERY_UNKNOWN", "incident recovery resume outcome could not be read back", {
      status: "UNKNOWN",
      exitCode: 3,
      details: safeErrorDetails({ cause: error?.code })
    });
  }
  assertResumeRunnerHandle(after, input.plan);
  if (after.handle.status !== "completed" || after.intent?.status !== "sealed" || execution?.outcome !== "success") {
    const unknown = after.handle.status === "indeterminate" || after.intent?.status === "unknown";
    fail(
      unknown ? "EINCIDENT_RECOVERY_UNKNOWN" : "EINCIDENT_RECOVERY_RESUME",
      unknown ? "incident recovery resume outcome is unresolved" : "incident recovery runner did not seal a successful effect",
      { status: unknown ? "UNKNOWN" : "HOLD", exitCode: unknown ? 3 : 2 }
    );
  }
  return Object.freeze({
    ok: true,
    schemaVersion: INCIDENT_RECOVERY_CLI_SCHEMA_VERSION,
    kind: INCIDENT_RECOVERY_CLI_KIND,
    operation: "incident.recovery.resume",
    status: "resumed",
    recoveryId: input.plan.recoveryId,
    planDigest: input.plan.planDigest,
    effect: "launched-once",
    execution,
    handle: after.handle,
    intent: after.intent
  });
}

function assertResumeRunnerHandle(status, plan) {
  if (!status || typeof status !== "object" || !status.handle || typeof status.handle !== "object") {
    fail("EINCIDENT_RECOVERY_UNKNOWN", "trusted resume runner returned no durable handle", { status: "UNKNOWN", exitCode: 3 });
  }
  const handle = status.handle;
  if (handle.runId !== plan.runId || handle.executionId !== plan.newExecutionId ||
      handle.attemptId !== plan.newAttemptId || handle.unitId !== plan.unitId ||
      handle.sourceBindingDigest !== plan.sourceBindingDigest || handle.policyDigest !== plan.policyDigest ||
      handle.revision !== plan.revision || handle.ownedResourceId !== plan.ownedResourceId ||
      handle.origin?.resumedFromHandleId !== plan.handleId || handle.origin?.priorAttemptId !== plan.priorAttemptId) {
    fail("EINCIDENT_RECOVERY_BINDING", "trusted resume handle is not bound to the recovery plan", { status: "HOLD" });
  }
}

export async function handleIncidentRecoveryCliV1(argv = [], context = {}) {
  const parsed = parseIncidentRecoveryCliArgs(argv);
  if (parsed.command === "help" || parsed.options.help === true) return commandHelp(parsed.options);
  const trustedContext = assertTrustedContext(context);
  switch (parsed.command) {
    case "prepare":
      return commandPrepare(parsed.options, trustedContext);
    case "verify":
      return commandVerify(parsed.options, trustedContext);
    case "resume":
      return commandResume(parsed.options, trustedContext);
    default:
      fail("EINCIDENT_RECOVERY_CLI_USAGE", "unsupported incident recovery command");
  }
}

function safeErrorCode(value, fallback) {
  return typeof value === "string" && /^[A-Z0-9_]{1,96}$/u.test(value) ? value : fallback;
}

function safeErrorDetails(value) {
  if (!isPlainObject(value)) return undefined;
  const details = {};
  if (typeof value.cause === "string" && /^[A-Z0-9_]{1,96}$/u.test(value.cause)) details.cause = value.cause;
  return Object.keys(details).length > 0 ? details : undefined;
}

function normalizeError(error) {
  if (error instanceof IncidentRecoveryCliError) return error;
  if (error instanceof IncidentRecoveryError) {
    const status = error.status === "UNKNOWN" ? "UNKNOWN" : "HOLD";
    return new IncidentRecoveryCliError(
      safeErrorCode(error.code, "EINCIDENT_RECOVERY_CLI_CORE"),
      typeof error.message === "string" && error.message.length > 0 ? error.message : "incident recovery operation was blocked",
      { status, exitCode: status === "UNKNOWN" ? 3 : 2, details: safeErrorDetails(error.details) }
    );
  }
  if (error?.code === "ENOENT") {
    return new IncidentRecoveryCliError("EINCIDENT_RECOVERY_CLI_NOT_FOUND", "incident recovery input is unavailable", { exitCode: 2 });
  }
  if (INTERNAL_FS_CODES.has(error?.code)) {
    return new IncidentRecoveryCliError("EINCIDENT_RECOVERY_CLI_FS", "incident recovery filesystem operation was blocked", { exitCode: 2 });
  }
  return new IncidentRecoveryCliError("EINCIDENT_RECOVERY_CLI_INTERNAL", "incident recovery operation failed", { exitCode: 2 });
}

export async function runIncidentRecoveryCliV1(argv = [], context = {}) {
  try {
    const value = await handleIncidentRecoveryCliV1(argv, context);
    if (value?.ok === false && value?.status === "UNKNOWN") return { exitCode: 3, value };
    if (value?.ok === false && value?.status === "HOLD") return { exitCode: 2, value };
    return { exitCode: 0, value };
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      exitCode: normalized.exitCode,
      value: {
        ok: false,
        status: normalized.status,
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.details === undefined ? {} : { details: normalized.details })
        }
      }
    };
  }
}

export async function prepareIncidentRecoveryCliV1(options = {}, context = {}) {
  assertPlainObject(options, "prepare options");
  const trustedContext = assertTrustedContext(context);
  return commandPrepare(options, trustedContext);
}

export async function verifyIncidentRecoveryCliV1(options = {}, context = {}) {
  assertPlainObject(options, "verify options");
  const trustedContext = assertTrustedContext(context);
  return commandVerify(options, trustedContext);
}

export async function resumeIncidentRecoveryCliV1(options = {}, context = {}) {
  assertPlainObject(options, "resume options");
  const trustedContext = assertTrustedContext(context);
  return commandResume(options, trustedContext);
}

export async function main(argv = process.argv.slice(2), context = {}) {
  const result = await runIncidentRecoveryCliV1(argv, context);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  process.exitCode = result.exitCode;
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
