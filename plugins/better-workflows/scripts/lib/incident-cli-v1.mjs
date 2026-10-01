import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getStateRoot } from "./core.mjs";
import { runIncidentRecoveryCliV1 } from "./incident-recovery-cli-v1.mjs";
import {
  INCIDENT_LIMITS,
  INCIDENT_PREPARATION_KIND,
  IncidentError,
  createIncidentDeletePermissionV1,
  createIncidentFirstReportPermissionV1,
  createIncidentPreparePermissionV1,
  createIncidentReadPermissionV1,
  createIncidentRevisionPermissionV1,
  createIncidentRevokePermissionV1,
  createIncidentReviewPermissionV1,
  createIncidentRevisionV1,
  createIncidentFirstReportV1,
  deleteIncidentV1,
  listIncidentsV1,
  prepareIncidentPublicationV1,
  readIncidentV1,
  revokeIncidentV1,
  submitIncidentReviewV1,
  verifyIncidentPublicationPreparationV1
} from "./incident-v1.mjs";

export const INCIDENT_CLI_SCHEMA_VERSION = 1;
export const INCIDENT_CLI_KIND = "IncidentCliV1";
export const INCIDENT_CLI_MAX_INPUT_BYTES = INCIDENT_LIMITS.maxRecordBytes;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMANDS = new Set([
  "help",
  "create",
  "report",
  "read",
  "show",
  "list",
  "revise",
  "review",
  "prepare-publication",
  "verify-preparation",
  "recovery",
  "revoke",
  "delete"
]);
const RECOVERY_COMMANDS = new Set(["prepare", "verify", "resume"]);
const BOOLEAN_OPTIONS = new Set(["json", "help"]);
const COMMON_OPTIONS = new Set(["state-root", "deadline-ms", "json", "help"]);
const INPUT_OPTIONS = new Set([...COMMON_OPTIONS, "incident-id", "file"]);
const REVISION_OPTIONS = new Set([...INPUT_OPTIONS, "expected-revision"]);
const READ_OPTIONS = new Set([...COMMON_OPTIONS, "incident-id", "revision"]);
const REVIEW_OPTIONS = new Set([
  ...COMMON_OPTIONS,
  "incident-id",
  "expected-revision",
  "role",
  "disposition",
  "reason"
]);
const PREPARE_OPTIONS = new Set([...COMMON_OPTIONS, "incident-id", "revision", "target-file"]);
const VERIFY_OPTIONS = new Set([...COMMON_OPTIONS, "file", "target-file", "preparation-path"]);
const MUTATION_OPTIONS = new Set([...COMMON_OPTIONS, "incident-id", "expected-revision", "reason"]);
const RECOVERY_OPTIONS = new Set([
  ...COMMON_OPTIONS,
  "incident-id", "incident-revision", "incident-digest", "run-id", "handle-id",
  "new-execution-id", "new-attempt-id", "reason", "out", "file"
]);
const REPORT_INPUT_KEYS = new Set(["content", "source", "capturedAt", "evidenceDigest"]);

const USAGE = Object.freeze([
  "incident-cli-v1.mjs help [--json]",
  "incident-cli-v1.mjs create --incident-id <id> --file <content-source-json> [--state-root <absolute>] [--deadline-ms <1..2000>] [--json]",
  "incident-cli-v1.mjs report --incident-id <id> --file <content-source-json> [--state-root <absolute>] [--json] (alias of create)",
  "incident-cli-v1.mjs read --incident-id <id> [--revision <1..64>] [--state-root <absolute>] [--json]",
  "incident-cli-v1.mjs show --incident-id <id> [--revision <1..64>] [--state-root <absolute>] [--json] (alias of read)",
  "incident-cli-v1.mjs list [--state-root <absolute>] [--json]",
  "incident-cli-v1.mjs revise --incident-id <id> --file <content-source-json> --expected-revision <1..63> [--state-root <absolute>] [--json]",
  "incident-cli-v1.mjs review --incident-id <id> --expected-revision <1..63> --role <privacy|security|facts> --disposition <approved|rejected> --reason <text> [--state-root <absolute>] [--json]",
  "incident-cli-v1.mjs prepare-publication --incident-id <id> --revision <1..64> --target-file <target-json> [--state-root <absolute>] [--json]",
  "incident-cli-v1.mjs verify-preparation --file <preparation-json> --target-file <target-json> [--preparation-path <state-root-path>] [--state-root <absolute>] [--json]",
  "incident-cli-v1.mjs recovery prepare|verify|resume ... (trusted context required; see command-specific usage below)",
  "incident-cli-v1.mjs recovery prepare --incident-id <id> --incident-revision <1..64> --run-id <id> --handle-id <id> --new-execution-id <id> --new-attempt-id <id> --out <new-plan.json> [--incident-digest <sha256>] [--reason <text>] [--state-root <absolute>] [--deadline-ms <1..2000>] [--json]",
  "incident-cli-v1.mjs recovery verify --file <plan.json> [--state-root <absolute>] [--deadline-ms <1..2000>] [--json]",
  "incident-cli-v1.mjs recovery resume --file <plan.json> [--state-root <absolute>] [--deadline-ms <1..2000>] [--json] (standalone requires a trusted single-use resume runner; sbw supplies an allocation-backed bridge)",
  "incident-cli-v1.mjs revoke --incident-id <id> --expected-revision <1..64> [--reason <text>] [--state-root <absolute>] [--json]",
  "incident-cli-v1.mjs delete --incident-id <id> --expected-revision <1..64> [--reason <text>] [--state-root <absolute>] [--json]"
]);

export class IncidentCliError extends Error {
  constructor(code, message, { exitCode = 1, status = undefined, details = undefined } = {}) {
    super(message);
    this.name = "IncidentCliError";
    this.code = code;
    this.exitCode = exitCode;
    if (status !== undefined) this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, options = {}) {
  throw new IncidentCliError(code, message, options);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail("EINCIDENT_CLI_USAGE", `${label} must be a JSON object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("EINCIDENT_CLI_USAGE", `${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) fail("EINCIDENT_CLI_USAGE", `${label} contains an accessor property`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Reflect.ownKeys(value).filter((key) => typeof key !== "string" || !allowed.has(key));
  if (unknown.length > 0) fail("EINCIDENT_CLI_USAGE", `${label} contains an unsupported field`);
}

function requireKeys(value, keys, label) {
  for (const key of keys) if (!Object.hasOwn(value, key)) fail("EINCIDENT_CLI_USAGE", `${label} requires ${key}`);
}

function assertArgv(argv) {
  if (!Array.isArray(argv) || Object.getPrototypeOf(argv) !== Array.prototype) {
    fail("EINCIDENT_CLI_USAGE", "argv must be a standard array");
  }
  for (const item of argv) {
    if (typeof item !== "string") fail("EINCIDENT_CLI_USAGE", "argv contains a non-text argument");
  }
}

function addOption(options, key, value) {
  if (Object.hasOwn(options, key)) fail("EINCIDENT_CLI_USAGE", `--${key} may be provided only once`);
  options[key] = value;
}

export function parseIncidentCliArgs(argv) {
  assertArgv(argv);
  const positional = [];
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    if (token === "--") fail("EINCIDENT_CLI_USAGE", "-- is not accepted");
    const raw = token.slice(2);
    if (!raw || raw.includes("=") || !/^[a-z][a-z0-9-]*$/.test(raw)) {
      fail("EINCIDENT_CLI_USAGE", "invalid option syntax");
    }
    if (BOOLEAN_OPTIONS.has(raw)) {
      addOption(options, raw, true);
      continue;
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      fail("EINCIDENT_CLI_USAGE", `--${raw} requires one value`);
    }
    addOption(options, raw, argv[++index]);
  }
  const command = positional.length > 0 ? positional[0] : "help";
  if (!COMMANDS.has(command)) fail("EINCIDENT_CLI_USAGE", "unknown incident command");
  let subcommand = null;
  if (command === "recovery") {
    if (positional.length !== 2 || !RECOVERY_COMMANDS.has(positional[1])) {
      fail("EINCIDENT_CLI_USAGE", "recovery requires prepare, verify, or resume");
    }
    subcommand = positional[1];
  } else if (positional.length > 1) {
    fail("EINCIDENT_CLI_USAGE", "incident commands do not accept positional arguments");
  }
  return Object.freeze({ command, subcommand, options: Object.freeze(options) });
}

function assertKnownOptions(options, allowed, command) {
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail("EINCIDENT_CLI_USAGE", `${command} does not accept --${key}`);
  }
  if (options.json !== undefined && options.json !== true) fail("EINCIDENT_CLI_USAGE", "--json must be a flag");
  if (options.help !== undefined && options.help !== true) fail("EINCIDENT_CLI_USAGE", "--help must be a flag");
}

function stringOption(options, key, label, { required = false, maxBytes = null } = {}) {
  const value = options[key];
  if (value === undefined) {
    if (required) fail("EINCIDENT_CLI_USAGE", `${label} is required`);
    return null;
  }
  if (typeof value !== "string" || value.length === 0) fail("EINCIDENT_CLI_USAGE", `${label} must be one non-empty value`);
  if (maxBytes !== null && Buffer.byteLength(value, "utf8") > maxBytes) {
    fail("EINCIDENT_CLI_LIMIT", `${label} exceeds its bounded size`, { exitCode: 2 });
  }
  return value;
}

function integerOption(options, key, label, { required = false, min, max } = {}) {
  const value = stringOption(options, key, label, { required });
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) fail("EINCIDENT_CLI_USAGE", `${label} must be an integer`);
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < min || integer > max) {
    fail("EINCIDENT_CLI_USAGE", `${label} must be an integer from ${min} through ${max}`);
  }
  return integer;
}

function deadlineOption(options) {
  return integerOption(options, "deadline-ms", "--deadline-ms", {
    min: 1,
    max: INCIDENT_LIMITS.maxDeadlineMs
  });
}

function safeIdentifier(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail("EINCIDENT_CLI_USAGE", `${label} is invalid`);
  return value;
}

function rawPathHasTraversal(value) {
  return value.split(/[\\/]+/u).some((part) => part === "..");
}

function safePath(value, label, cwd) {
  if (typeof value !== "string" || value.length === 0 || value === "-") fail("EINCIDENT_CLI_USAGE", `${label} must be a path`);
  if (rawPathHasTraversal(value)) fail("EINCIDENT_CLI_USAGE", `${label} must not contain traversal components`);
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
  if (resolved === path.parse(resolved).root) fail("EINCIDENT_CLI_USAGE", `${label} is too broad`);
  return resolved;
}

async function inspectPathComponents(target, { allowMissingLeaf = false, label }) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const relative = path.relative(root, resolved);
  let current = root;
  const components = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT" && allowMissingLeaf && index === components.length - 1) return;
      if (error.code === "ENOENT") fail("EINCIDENT_FS", `${label} has a missing path component`, { exitCode: 2 });
      fail("EINCIDENT_FS", `${label} could not be inspected`, { exitCode: 2 });
    }
    if (info.isSymbolicLink()) {
      const macAlias = process.platform === "darwin" &&
        ["/var", "/tmp", "/etc"].includes(current) &&
        await realpath(current).then((resolvedAlias) => resolvedAlias === path.join("/private", current.slice(1))).catch(() => false);
      if (!macAlias) fail("EINCIDENT_FS", `${label} contains a symbolic link`, { exitCode: 2 });
      continue;
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      fail("EINCIDENT_FS", `${label} has a non-directory parent`, { exitCode: 2 });
    }
  }
}

async function assertStateRoot(root) {
  await inspectPathComponents(root, { allowMissingLeaf: true, label: "state root" });
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("EINCIDENT_FS", "state root is not a regular directory", { exitCode: 2 });
  } catch (error) {
    if (error instanceof IncidentCliError) throw error;
    if (error.code !== "ENOENT") fail("EINCIDENT_FS", "state root could not be inspected", { exitCode: 2 });
  }
}

function resolveStateRoot(options, env) {
  const raw = options["state-root"];
  if (raw !== undefined) {
    if (typeof raw !== "string" || !path.isAbsolute(raw) || rawPathHasTraversal(raw)) {
      fail("EINCIDENT_CLI_USAGE", "state root must be an absolute path without traversal components");
    }
  }
  const resolved = path.resolve(raw ?? getStateRoot(env));
  if (resolved === path.parse(resolved).root) fail("EINCIDENT_CLI_USAGE", "state root is too broad");
  return resolved;
}

function safeStatePath(value, label, root) {
  if (typeof value !== "string" || value.length === 0 || rawPathHasTraversal(value)) {
    fail("EINCIDENT_CLI_USAGE", `${label} must be a non-traversing state path`);
  }
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("EINCIDENT_CLI_USAGE", `${label} must remain within state root`);
  }
  return resolved;
}

async function readBoundedJsonFile(filePath, label, maxBytes = INCIDENT_CLI_MAX_INPUT_BYTES) {
  await inspectPathComponents(filePath, { label });
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      fail("EINCIDENT_FS", `${label} is not a regular single-link file`, { exitCode: 2 });
    }
    if (!Number.isSafeInteger(before.size) || before.size > maxBytes) {
      fail("EINCIDENT_LIMIT", `${label} exceeds the bounded input size`, { exitCode: 2 });
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail("EINCIDENT_FS", `${label} changed while being read`, { exitCode: 2 });
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("EINCIDENT_INVALID", `${label} is not valid JSON`, { exitCode: 2 });
    }
  } catch (error) {
    if (error instanceof IncidentCliError) throw error;
    if (error.code === "ENOENT") fail("EINCIDENT_NOT_FOUND", `${label} does not exist`, { exitCode: 2 });
    if (["EACCES", "EPERM", "ELOOP", "ENOTDIR"].includes(error.code)) {
      fail("EINCIDENT_FS", `${label} could not be safely read`, { exitCode: 2 });
    }
    fail("EINCIDENT_FS", `${label} could not be read`, { exitCode: 2 });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readInput(options, context, label) {
  const file = safePath(stringOption(options, "file", "--file", { required: true }), "--file", context.cwd);
  const value = await readBoundedJsonFile(file, label);
  return { file, value };
}

function reportInput(value) {
  exactKeys(value, REPORT_INPUT_KEYS, "incident input");
  requireKeys(value, ["content", "source"], "incident input");
  return value;
}

function targetInput(value) {
  return assertPlainObject(value, "incident target input");
}

function preparationInput(value) {
  return assertPlainObject(value, "incident preparation input");
}

function withDeadline(target, deadlineMs) {
  if (deadlineMs !== null) target.deadlineMs = deadlineMs;
  return target;
}

function resultWithBoundary(value) {
  if (!isPlainObject(value)) return value;
  return Object.freeze({
    ...value,
    localPermission: Object.freeze({
      permissionScope: "local-operation-only",
      ownerActionAuthority: false,
      providerAuthority: false,
      publicationAuthority: false,
      evidenceTruth: false
    })
  });
}

async function commandHelp(options) {
  assertKnownOptions(options, new Set(["json", "help"]), "help");
  return {
    ok: true,
    schemaVersion: INCIDENT_CLI_SCHEMA_VERSION,
    kind: INCIDENT_CLI_KIND,
    usage: [...USAGE],
    notes: [
      "Create and revise accept a bounded JSON envelope containing content and source; no raw private payload is added by this CLI.",
      "Preparation verifies an unpublished advisory receipt only; it never publishes, grants owner approval, or invokes a provider.",
      "All permissions are opaque local core capabilities and do not establish owner, provider, action, or evidence authority."
    ]
  };
}

async function commandCreate(options, context) {
  assertKnownOptions(options, INPUT_OPTIONS, "create");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const incidentId = safeIdentifier(stringOption(options, "incident-id", "--incident-id", { required: true }), "--incident-id");
  const deadlineMs = deadlineOption(options);
  const input = reportInput((await readInput(options, context, "incident input JSON")).value);
  const permission = createIncidentFirstReportPermissionV1({ stateRoot: root, incidentId });
  const request = withDeadline({
    stateRoot: root,
    incidentId,
    content: input.content,
    source: input.source,
    permission
  }, deadlineMs);
  if (Object.hasOwn(input, "capturedAt")) request.capturedAt = input.capturedAt;
  if (Object.hasOwn(input, "evidenceDigest")) request.evidenceDigest = input.evidenceDigest;
  const result = await createIncidentFirstReportV1(request);
  return resultWithBoundary({ ...result, inputKind: "IncidentReportInputV1" });
}

async function commandRevise(options, context) {
  assertKnownOptions(options, REVISION_OPTIONS, "revise");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const incidentId = safeIdentifier(stringOption(options, "incident-id", "--incident-id", { required: true }), "--incident-id");
  const expectedRevision = integerOption(options, "expected-revision", "--expected-revision", {
    required: true,
    min: 1,
    max: INCIDENT_LIMITS.maxRevisionCount - 1
  });
  const deadlineMs = deadlineOption(options);
  const input = reportInput((await readInput(options, context, "incident input JSON")).value);
  const permission = createIncidentRevisionPermissionV1({ stateRoot: root, incidentId, expectedRevision });
  const request = withDeadline({
    stateRoot: root,
    incidentId,
    content: input.content,
    source: input.source,
    permission
  }, deadlineMs);
  if (Object.hasOwn(input, "capturedAt")) request.capturedAt = input.capturedAt;
  if (Object.hasOwn(input, "evidenceDigest")) request.evidenceDigest = input.evidenceDigest;
  const result = await createIncidentRevisionV1(request);
  return resultWithBoundary({ ...result, inputKind: "IncidentReportInputV1" });
}

async function commandRead(options, context) {
  assertKnownOptions(options, READ_OPTIONS, "read");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const incidentId = safeIdentifier(stringOption(options, "incident-id", "--incident-id", { required: true }), "--incident-id");
  const revision = integerOption(options, "revision", "--revision", {
    min: 1,
    max: INCIDENT_LIMITS.maxRevisionCount
  });
  const deadlineMs = deadlineOption(options);
  const permission = createIncidentReadPermissionV1({ stateRoot: root, incidentId, revision });
  return resultWithBoundary(await readIncidentV1(withDeadline({ stateRoot: root, incidentId, permission }, deadlineMs)));
}

async function commandList(options, context) {
  assertKnownOptions(options, COMMON_OPTIONS, "list");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const deadlineMs = deadlineOption(options);
  const permission = createIncidentReadPermissionV1({ stateRoot: root });
  const incidents = await listIncidentsV1(withDeadline({ stateRoot: root, permission }, deadlineMs));
  return resultWithBoundary({ ok: true, operation: "incident.list", incidents });
}

async function commandReview(options, context) {
  assertKnownOptions(options, REVIEW_OPTIONS, "review");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const incidentId = safeIdentifier(stringOption(options, "incident-id", "--incident-id", { required: true }), "--incident-id");
  const expectedRevision = integerOption(options, "expected-revision", "--expected-revision", {
    required: true,
    min: 1,
    max: INCIDENT_LIMITS.maxRevisionCount - 1
  });
  const role = stringOption(options, "role", "--role", { required: true });
  if (!["privacy", "security", "facts"].includes(role)) fail("EINCIDENT_CLI_USAGE", "--role is invalid");
  const disposition = stringOption(options, "disposition", "--disposition", { required: true });
  if (!["approved", "rejected"].includes(disposition)) fail("EINCIDENT_CLI_USAGE", "--disposition is invalid");
  const reason = stringOption(options, "reason", "--reason", {
    required: true,
    maxBytes: INCIDENT_LIMITS.maxReviewReasonBytes
  });
  const deadlineMs = deadlineOption(options);
  const permission = createIncidentReviewPermissionV1({ stateRoot: root, incidentId, expectedRevision, role });
  const result = await submitIncidentReviewV1(withDeadline({
    stateRoot: root,
    incidentId,
    review: { role, disposition, reason },
    permission
  }, deadlineMs));
  return resultWithBoundary(result);
}

async function commandPrepare(options, context) {
  assertKnownOptions(options, PREPARE_OPTIONS, "prepare-publication");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const incidentId = safeIdentifier(stringOption(options, "incident-id", "--incident-id", { required: true }), "--incident-id");
  const revision = integerOption(options, "revision", "--revision", {
    required: true,
    min: 1,
    max: INCIDENT_LIMITS.maxRevisionCount
  });
  const deadlineMs = deadlineOption(options);
  const targetFile = safePath(stringOption(options, "target-file", "--target-file", { required: true }), "--target-file", context.cwd);
  const target = targetInput(await readBoundedJsonFile(targetFile, "incident target JSON"));
  const permission = createIncidentPreparePermissionV1({ stateRoot: root, incidentId, revision, target });
  const result = await prepareIncidentPublicationV1(withDeadline({ stateRoot: root, incidentId, permission }, deadlineMs));
  return resultWithBoundary({ ...result, targetFile, inputKind: "IncidentTargetV1", preparationKind: INCIDENT_PREPARATION_KIND });
}

async function commandVerify(options, context) {
  assertKnownOptions(options, VERIFY_OPTIONS, "verify-preparation");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const deadlineMs = deadlineOption(options);
  const preparationFile = safePath(stringOption(options, "file", "--file", { required: true }), "--file", context.cwd);
  const preparation = preparationInput(await readBoundedJsonFile(preparationFile, "incident preparation JSON"));
  const targetFile = safePath(stringOption(options, "target-file", "--target-file", { required: true }), "--target-file", context.cwd);
  const target = targetInput(await readBoundedJsonFile(targetFile, "incident target JSON"));
  const request = withDeadline({ stateRoot: root, preparation, target }, deadlineMs);
  if (options["preparation-path"] !== undefined) {
    request.preparationPath = safeStatePath(options["preparation-path"], "--preparation-path", root);
  }
  const result = await verifyIncidentPublicationPreparationV1(request);
  return resultWithBoundary({ ...result, preparationFile, targetFile, inputKind: INCIDENT_PREPARATION_KIND });
}

async function commandRevokeOrDelete(options, context, action) {
  assertKnownOptions(options, MUTATION_OPTIONS, action);
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const incidentId = safeIdentifier(stringOption(options, "incident-id", "--incident-id", { required: true }), "--incident-id");
  const expectedRevision = integerOption(options, "expected-revision", "--expected-revision", {
    required: true,
    min: 1,
    max: INCIDENT_LIMITS.maxRevisionCount
  });
  const reason = stringOption(options, "reason", "--reason", {
    maxBytes: INCIDENT_LIMITS.maxReviewReasonBytes
  });
  const deadlineMs = deadlineOption(options);
  const permission = action === "revoke"
    ? createIncidentRevokePermissionV1({ stateRoot: root, incidentId, expectedRevision })
    : createIncidentDeletePermissionV1({ stateRoot: root, incidentId, expectedRevision });
  const request = withDeadline({ stateRoot: root, incidentId, permission }, deadlineMs);
  if (reason !== null) request.reason = reason;
  const result = action === "revoke"
    ? await revokeIncidentV1(request)
    : await deleteIncidentV1(request);
  return resultWithBoundary(result);
}

const RECOVERY_RESULT = Symbol("incident-cli-recovery-result");
const SAFE_RECOVERY_CODE = /^E(?:OWNER|SOURCE|POLICY|INCIDENT_RECOVERY|NATIVE_V3|EXECUTION|EFFECT|ALLOCATION|HOST|STOP|WORKFLOW_RESUME)(?:_[A-Z0-9]+)+$/u;

function safeRecoveryCode(value) {
  if (value === "EWORKFLOW_PUBLIC_AUTO_REQUIRED") return value;
  return typeof value === "string" && SAFE_RECOVERY_CODE.test(value)
    ? value
    : "EINCIDENT_RECOVERY_CONTEXT_UNAVAILABLE";
}

function safeRecoveryStatus(value) {
  return value === "UNKNOWN" ? "UNKNOWN" : "HOLD";
}

function safeRecoveryDetails(value) {
  const cause = value?.cause;
  return typeof cause === "string" && /^[A-Z0-9_]{1,96}$/u.test(cause)
    ? { cause }
    : undefined;
}

function safeRecoveryError(error) {
  const status = safeRecoveryStatus(error?.status);
  return new IncidentCliError(
    safeRecoveryCode(error?.code),
    status === "UNKNOWN"
      ? "incident recovery trusted context requires bounded reconciliation"
      : "incident recovery trusted context is unavailable",
    {
      status,
      exitCode: status === "UNKNOWN" ? 3 : 2,
      details: safeRecoveryDetails(error)
    }
  );
}

function recoveryArgv(options, subcommand) {
  const argv = [subcommand];
  for (const key of [
    "state-root", "deadline-ms", "incident-id", "incident-revision", "incident-digest", "run-id", "handle-id",
    "new-execution-id", "new-attempt-id", "reason", "out", "file"
  ]) {
    if (options[key] !== undefined) argv.push(`--${key}`, options[key]);
  }
  if (options.json === true) argv.push("--json");
  return argv;
}

async function commandRecovery(options, subcommand, context) {
  assertKnownOptions(options, RECOVERY_OPTIONS, `recovery ${subcommand}`);
  if (typeof context.recoveryContextFactory !== "function") {
    throw new IncidentCliError(
      "EINCIDENT_RECOVERY_CONTEXT_UNAVAILABLE",
      "incident recovery requires an internal trusted execution context",
      { exitCode: 2 }
    );
  }
  let recoveryContext;
  try {
    recoveryContext = await context.recoveryContextFactory(Object.freeze({
      subcommand,
      options: Object.freeze({ ...options }),
      env: context.env,
      cwd: context.cwd
    }));
  } catch (error) {
    // The context factory runs at the trust boundary.  Even an object that
    // happens to be an IncidentCliError may have been supplied by an
    // untrusted adapter, so preserve only the bounded recovery code/status
    // vocabulary and never forward its message or details.
    throw safeRecoveryError(error);
  }
  if (recoveryContext === null || recoveryContext === undefined) {
    throw new IncidentCliError(
      "EINCIDENT_RECOVERY_CONTEXT_UNAVAILABLE",
      "incident recovery trusted execution context is unavailable",
      { exitCode: 2 }
    );
  }
  const result = await runIncidentRecoveryCliV1(recoveryArgv(options, subcommand), recoveryContext);
  return { [RECOVERY_RESULT]: result };
}

export async function handleIncidentCli(argv = [], {
  env = process.env,
  cwd = process.cwd(),
  recoveryContextFactory = undefined
} = {}) {
  const parsed = parseIncidentCliArgs(argv);
  if (parsed.command === "help" || parsed.options.help === true) return commandHelp(parsed.options);
  switch (parsed.command) {
    case "create":
    case "report":
      return commandCreate(parsed.options, { env, cwd });
    case "read":
    case "show":
      return commandRead(parsed.options, { env, cwd });
    case "list":
      return commandList(parsed.options, { env, cwd });
    case "revise":
      return commandRevise(parsed.options, { env, cwd });
    case "review":
      return commandReview(parsed.options, { env, cwd });
    case "prepare-publication":
      return commandPrepare(parsed.options, { env, cwd });
    case "verify-preparation":
      return commandVerify(parsed.options, { env, cwd });
    case "recovery":
      return commandRecovery(parsed.options, parsed.subcommand, { env, cwd, recoveryContextFactory });
    case "revoke":
    case "delete":
      return commandRevokeOrDelete(parsed.options, { env, cwd }, parsed.command);
    default:
      fail("EINCIDENT_CLI_USAGE", "unsupported incident command");
  }
}

function normalizeError(error) {
  if (error instanceof IncidentCliError) return error;
  if (error instanceof IncidentError) return new IncidentCliError(error.code, error.message, { exitCode: 2 });
  if (["EACCES", "EPERM", "ELOOP", "ENOTDIR", "ENOENT"].includes(error?.code)) {
    return new IncidentCliError(error.code === "ENOENT" ? "EINCIDENT_NOT_FOUND" : "EINCIDENT_FS", "incident CLI filesystem operation failed", { exitCode: 2 });
  }
  if (error?.status === "UNKNOWN" || error?.status === "HOLD" || SAFE_RECOVERY_CODE.test(error?.code ?? "")) {
    return safeRecoveryError(error);
  }
  return new IncidentCliError("EINCIDENT_CLI_INTERNAL", "incident CLI operation failed", { exitCode: 2 });
}

export async function runIncidentCli(argv = [], context = {}) {
  try {
    const value = await handleIncidentCli(argv, context);
    if (value && value[RECOVERY_RESULT]) return value[RECOVERY_RESULT];
    return { exitCode: 0, value };
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      exitCode: normalized.exitCode,
      value: {
        ok: false,
        ...(normalized.status === undefined ? {} : { status: normalized.status }),
        error: { code: normalized.code, message: normalized.message }
      }
    };
  }
}

export async function main(argv = process.argv.slice(2), context = {}) {
  const result = await runIncidentCli(argv, context);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  process.exitCode = result.exitCode;
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
