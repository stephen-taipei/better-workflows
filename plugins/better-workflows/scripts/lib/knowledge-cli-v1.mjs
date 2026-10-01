import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getStateRoot } from "./core.mjs";
import {
  KNOWLEDGE_NODE_LIMITS,
  KNOWLEDGE_NODE_EXPORT_KIND,
  KnowledgeNodeError,
  createKnowledgeDeletePermission,
  createKnowledgeExportPermission,
  createKnowledgeReadPermission,
  createKnowledgeRevokePermission,
  createKnowledgeSavePermission,
  deleteKnowledgeNodeV1,
  exportKnowledgeNodeV1,
  importKnowledgeExportV1,
  importKnowledgeNodeV1,
  listKnowledgeNodes,
  readKnowledgeNodeV1,
  revokeKnowledgeNodeV1,
  saveKnowledgeNodeV1,
  validateKnowledgeNodeExportV1,
  validateKnowledgeNodeV1
} from "./knowledge-v1.mjs";

export const KNOWLEDGE_CLI_SCHEMA_VERSION = 1;
export const KNOWLEDGE_CLI_KIND = "KnowledgeCliV1";
export const KNOWLEDGE_CLI_MAX_INPUT_BYTES = KNOWLEDGE_NODE_LIMITS.maxNodeBytes;
export const KNOWLEDGE_CLI_MAX_OUTPUT_BYTES = KNOWLEDGE_NODE_LIMITS.maxNodeBytes;

const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMANDS = new Set([
  "help", "validate", "save", "read", "list", "export", "import", "revoke", "delete"
]);
const REPEATABLE_OPTIONS = new Set(["candidate-id", "snippet-id"]);
const BOOLEAN_OPTIONS = new Set([
  "json", "help", "exclude-raw", "include-source-digest", "omit-source-digest"
]);
const COMMON_OPTIONS = new Set(["state-root", "deadline-ms", "json", "help"]);
const NODE_FILE_OPTIONS = new Set([...COMMON_OPTIONS, "file"]);
const MUTATION_OPTIONS = new Set([...COMMON_OPTIONS, "file", "node-id", "expected-revision"]);
const READ_OPTIONS = new Set([...COMMON_OPTIONS, "node-id", "revision"]);
const EXPORT_OPTIONS = new Set([
  ...COMMON_OPTIONS,
  "node-id", "revision", "candidate-id", "snippet-id", "out",
  "privacy-mode", "privacy-status", "exclude-raw", "unknown-content",
  "include-source-digest", "omit-source-digest"
]);

const USAGE = Object.freeze([
  "knowledge-cli-v1.mjs help [--json]",
  "knowledge-cli-v1.mjs validate --file <json> [--state-root <absolute>] [--deadline-ms <1..2000>] [--json]",
  "knowledge-cli-v1.mjs save --file <knowledge-node-json> --node-id <id> --expected-revision <0..127> [--state-root <absolute>] [--json]",
  "knowledge-cli-v1.mjs read --node-id <id> [--revision <1..128>] [--state-root <absolute>] [--json]",
  "knowledge-cli-v1.mjs list [--state-root <absolute>] [--json]",
  "knowledge-cli-v1.mjs export --node-id <id> --revision <1..128> --candidate-id <id> --snippet-id <id> --privacy-mode sanitized --privacy-status approved --exclude-raw --unknown-content blocked --include-source-digest|--omit-source-digest --out <new-json> [--state-root <absolute>] [--json]",
  "knowledge-cli-v1.mjs import --file <knowledge-node-json> --node-id <id> --expected-revision <0..127> [--state-root <absolute>] [--json]",
  "knowledge-cli-v1.mjs revoke --node-id <id> --expected-revision <1..128> [--state-root <absolute>] [--json]",
  "knowledge-cli-v1.mjs delete --node-id <id> --expected-revision <1..128> [--state-root <absolute>] [--json]"
]);

export class KnowledgeCliError extends Error {
  constructor(code, message, { exitCode = 1, details = undefined } = {}) {
    super(message);
    this.name = "KnowledgeCliError";
    this.code = code;
    this.exitCode = exitCode;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, options = {}) {
  throw new KnowledgeCliError(code, message, options);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertArgv(argv) {
  if (!Array.isArray(argv) || Object.getPrototypeOf(argv) !== Array.prototype) {
    fail("EKNOWLEDGE_CLI_USAGE", "argv must be a standard array");
  }
  for (const item of argv) {
    if (typeof item !== "string") fail("EKNOWLEDGE_CLI_USAGE", "argv contains a non-text argument");
  }
}

function addOption(options, key, value) {
  if (REPEATABLE_OPTIONS.has(key)) {
    if (!Array.isArray(options[key])) options[key] = [];
    options[key].push(value);
    return;
  }
  if (Object.hasOwn(options, key)) fail("EKNOWLEDGE_CLI_USAGE", `--${key} may be provided only once`);
  options[key] = value;
}

export function parseKnowledgeCliArgs(argv) {
  assertArgv(argv);
  const positional = [];
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    if (token === "--") fail("EKNOWLEDGE_CLI_USAGE", "-- is not accepted");
    const raw = token.slice(2);
    if (!raw || raw.includes("=")) fail("EKNOWLEDGE_CLI_USAGE", `invalid option: ${token}`);
    if (!/^[a-z][a-z0-9-]*$/.test(raw)) fail("EKNOWLEDGE_CLI_USAGE", `invalid option: ${token}`);
    if (BOOLEAN_OPTIONS.has(raw)) {
      addOption(options, raw, true);
      continue;
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      fail("EKNOWLEDGE_CLI_USAGE", `--${raw} requires one value`);
    }
    addOption(options, raw, argv[++index]);
  }
  const command = positional.length > 0 ? positional[0] : "help";
  const rest = positional.slice(1);
  if (!COMMANDS.has(command)) fail("EKNOWLEDGE_CLI_USAGE", `unknown knowledge command: ${command}`);
  if (rest.length > 0) fail("EKNOWLEDGE_CLI_USAGE", `${command} does not accept positional arguments`);
  return Object.freeze({ command, options: Object.freeze(options) });
}

function assertKnownOptions(options, allowed, command) {
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail("EKNOWLEDGE_CLI_USAGE", `${command} does not accept --${key}`);
  }
  if (options.json !== undefined && options.json !== true) {
    fail("EKNOWLEDGE_CLI_USAGE", "--json must be used as a flag");
  }
  if (options.help !== undefined && options.help !== true) {
    fail("EKNOWLEDGE_CLI_USAGE", "--help must be used as a flag");
  }
}

function stringOption(options, key, label, { required = false } = {}) {
  const value = options[key];
  if (value === undefined) {
    if (required) fail("EKNOWLEDGE_CLI_USAGE", `${label} is required`);
    return null;
  }
  if (Array.isArray(value) || typeof value !== "string" || value.length === 0) {
    fail("EKNOWLEDGE_CLI_USAGE", `${label} must be one non-empty value`);
  }
  return value;
}

function integerOption(options, key, label, { required = false, min, max } = {}) {
  const value = stringOption(options, key, label, { required });
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) fail("EKNOWLEDGE_CLI_USAGE", `${label} must be an integer`);
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < min || integer > max) {
    fail("EKNOWLEDGE_CLI_USAGE", `${label} must be an integer from ${min} through ${max}`);
  }
  return integer;
}

function safeIdentifier(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail("EKNOWLEDGE_CLI_USAGE", `${label} is invalid`);
  return value;
}

function rawPathHasTraversal(value) {
  return value.split(/[\\/]+/u).some((part) => part === "..");
}

function safePath(value, label, cwd) {
  if (typeof value !== "string" || value.length === 0 || value === "-") {
    fail("EKNOWLEDGE_CLI_USAGE", `${label} must be a path`);
  }
  if (rawPathHasTraversal(value)) fail("EKNOWLEDGE_CLI_USAGE", `${label} must not contain traversal components`);
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
  if (resolved === path.parse(resolved).root) fail("EKNOWLEDGE_CLI_USAGE", `${label} is too broad`);
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
      if (error.code === "ENOENT") fail("EKNOWLEDGE_FS", `${label} has a missing path component`, { exitCode: 2 });
      throw error;
    }
    if (info.isSymbolicLink()) {
      // macOS exposes /var, /tmp, and /etc as stable aliases into /private.
      // They are OS path aliases, not caller-controlled components.  A link
      // anywhere below them remains rejected, including the final file.
      const macAlias = process.platform === "darwin" &&
        ["/var", "/tmp", "/etc"].includes(current) &&
        await realpath(current).then((resolved) => resolved === path.join("/private", current.slice(1))).catch(() => false);
      if (!macAlias) fail("EKNOWLEDGE_FS", `${label} contains a symbolic link`, { exitCode: 2 });
      continue;
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      fail("EKNOWLEDGE_FS", `${label} has a non-directory parent`, { exitCode: 2 });
    }
  }
}

async function assertStateRoot(root) {
  await inspectPathComponents(root, { allowMissingLeaf: true, label: "state root" });
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("EKNOWLEDGE_FS", "state root is not a regular directory", { exitCode: 2 });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function resolveStateRoot(options, env) {
  const raw = options["state-root"] ?? getStateRoot(env);
  if (typeof raw !== "string" || !path.isAbsolute(raw) || rawPathHasTraversal(raw)) {
    fail("EKNOWLEDGE_CLI_USAGE", "state root must be an absolute path without traversal components");
  }
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root) fail("EKNOWLEDGE_CLI_USAGE", "state root is too broad");
  return resolved;
}

async function readBoundedJsonFile(filePath, label, maxBytes = KNOWLEDGE_CLI_MAX_INPUT_BYTES) {
  await inspectPathComponents(filePath, { label });
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      fail("EKNOWLEDGE_FS", `${label} is not a regular private file`, { exitCode: 2 });
    }
    if (!Number.isSafeInteger(before.size) || before.size > maxBytes) {
      fail("EKNOWLEDGE_LIMIT", `${label} exceeds ${maxBytes} bytes`, { exitCode: 2 });
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail("EKNOWLEDGE_FS", `${label} changed while being read`, { exitCode: 2 });
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      fail("EKNOWLEDGE_INVALID", `${label} is not valid JSON: ${error.message}`, { exitCode: 2 });
    }
  } catch (error) {
    if (error instanceof KnowledgeCliError) throw error;
    if (error.code === "ELOOP") fail("EKNOWLEDGE_FS", `${label} contains a symbolic link`, { exitCode: 2 });
    if (error.code === "ENOENT") fail("EKNOWLEDGE_NOT_FOUND", `${label} does not exist`, { exitCode: 2 });
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeCreateOnlyJson(filePath, value, label) {
  await inspectPathComponents(path.dirname(filePath), { label: `${label} parent` });
  let parentInfo;
  try {
    parentInfo = await lstat(path.dirname(filePath));
  } catch (error) {
    if (error.code === "ENOENT") fail("EKNOWLEDGE_FS", `${label} parent does not exist`, { exitCode: 2 });
    throw error;
  }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail("EKNOWLEDGE_FS", `${label} parent is unsafe`, { exitCode: 2 });
  try {
    const existing = await lstat(filePath);
    if (existing.isSymbolicLink()) fail("EKNOWLEDGE_FS", `${label} target is a symbolic link`, { exitCode: 2 });
    fail("EKNOWLEDGE_CONFLICT", `${label} already exists; refusing overwrite`, { exitCode: 2 });
  } catch (error) {
    if (error instanceof KnowledgeCliError) throw error;
    if (error.code !== "ENOENT") throw error;
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > KNOWLEDGE_CLI_MAX_OUTPUT_BYTES) {
    fail("EKNOWLEDGE_LIMIT", `${label} exceeds ${KNOWLEDGE_CLI_MAX_OUTPUT_BYTES} bytes`, { exitCode: 2 });
  }
  const parent = path.dirname(filePath);
  const tempPrefix = `.${path.basename(filePath)}.${process.pid}.${randomUUID()}`;
  let tempPath;
  let handle;
  let tempCreated = false;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      tempPath = path.join(parent, `${tempPrefix}.${attempt}.tmp`);
      try {
        handle = await open(
          tempPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
          0o600
        );
        tempCreated = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    if (!handle || !tempPath) fail("EKNOWLEDGE_FS", `${label} could not allocate a private temporary file`, { exitCode: 2 });
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      // A hard-link publish is atomic and create-only: the complete, fsynced
      // inode becomes visible in one operation and an existing target wins.
      await link(tempPath, filePath);
    } catch (error) {
      if (error.code === "EEXIST") {
        const existing = await lstat(filePath).catch((statError) => {
          if (statError.code === "ENOENT") return null;
          throw statError;
        });
        if (existing?.isSymbolicLink()) fail("EKNOWLEDGE_FS", `${label} target is a symbolic link`, { exitCode: 2 });
        fail("EKNOWLEDGE_CONFLICT", `${label} already exists; refusing overwrite`, { exitCode: 2 });
      }
      if (error.code === "ELOOP") fail("EKNOWLEDGE_FS", `${label} target is a symbolic link`, { exitCode: 2 });
      throw error;
    }
    await unlink(tempPath);
    tempCreated = false;
    const directoryHandle = await open(parent, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close().catch(() => {});
    }
  } catch (error) {
    if (error.code === "EEXIST") fail("EKNOWLEDGE_CONFLICT", `${label} already exists; refusing overwrite`, { exitCode: 2 });
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    if (tempCreated && tempPath) await unlink(tempPath).catch(() => {});
  }
  return { path: filePath, bytes: bytes.byteLength, mode: "0600" };
}

function deadlineOption(options) {
  return integerOption(options, "deadline-ms", "--deadline-ms", {
    min: 1,
    max: KNOWLEDGE_NODE_LIMITS.maxDeadlineMs
  });
}

function normalizeNodeIdOption(options) {
  return safeIdentifier(stringOption(options, "node-id", "--node-id", { required: true }), "--node-id");
}

function normalizeRevisionOption(options, { required = false } = {}) {
  return integerOption(options, "revision", "--revision", {
    required,
    min: 1,
    max: KNOWLEDGE_NODE_LIMITS.maxRevisionCount
  });
}

function normalizeExpectedRevision(options) {
  return integerOption(options, "expected-revision", "--expected-revision", {
    required: true,
    min: 0,
    max: KNOWLEDGE_NODE_LIMITS.maxRevisionCount - 1
  });
}

function localPermissionBoundary() {
  return Object.freeze({
    permissionScope: "local-operation-only",
    ownerActionAuthority: false,
    providerAuthority: false,
    evidenceTruth: false
  });
}

function resultWithBoundary(value) {
  if (!isPlainObject(value)) return value;
  return Object.freeze({ ...value, localPermission: localPermissionBoundary() });
}

async function readNodeInput(options, cwd) {
  const file = safePath(stringOption(options, "file", "--file", { required: true }), "--file", cwd);
  const raw = await readBoundedJsonFile(file, "knowledge input JSON");
  return { file, raw };
}

function assertNodeBinding(node, nodeId, expectedRevision) {
  if (node.nodeId !== nodeId) fail("EKNOWLEDGE_CLI_USAGE", "--node-id does not match the input node");
  if (node.revision !== expectedRevision + 1 && expectedRevision !== 0) {
    // The core owns the exact revision relation.  This early check only
    // prevents a CLI request from silently targeting a different record.
    fail("EKNOWLEDGE_CLI_USAGE", "input node revision must be expected-revision plus one");
  }
  if (expectedRevision === 0 && node.revision !== 1) {
    fail("EKNOWLEDGE_CLI_USAGE", "initial save/import requires input revision 1");
  }
}

function normalizedPrivacy(options) {
  const mode = stringOption(options, "privacy-mode", "--privacy-mode", { required: true });
  const status = stringOption(options, "privacy-status", "--privacy-status", { required: true });
  const unknownContent = stringOption(options, "unknown-content", "--unknown-content", { required: true });
  if (mode !== "sanitized") fail("EKNOWLEDGE_CLI_USAGE", "--privacy-mode must be sanitized");
  if (status !== "approved") fail("EKNOWLEDGE_CLI_USAGE", "--privacy-status must be approved");
  if (unknownContent !== "blocked") fail("EKNOWLEDGE_CLI_USAGE", "--unknown-content must be blocked");
  if (options["exclude-raw"] !== true) fail("EKNOWLEDGE_CLI_USAGE", "export requires --exclude-raw");
  const include = options["include-source-digest"] === true;
  const omit = options["omit-source-digest"] === true;
  if (include === omit) fail("EKNOWLEDGE_CLI_USAGE", "export requires exactly one source-digest privacy decision");
  return {
    mode: "sanitized",
    status: "approved",
    excludeRaw: true,
    unknownContent: "blocked",
    includeSourceDigest: include
  };
}

function repeatableIds(options, key, label) {
  const values = options[key];
  if (!Array.isArray(values) || values.length === 0) fail("EKNOWLEDGE_CLI_USAGE", `${label} requires at least one repeated option`);
  return values.map((value) => safeIdentifier(value, label));
}

async function commandHelp(options) {
  assertKnownOptions(options, new Set(["json", "help"]), "help");
  return {
    ok: true,
    schemaVersion: KNOWLEDGE_CLI_SCHEMA_VERSION,
    kind: KNOWLEDGE_CLI_KIND,
    usage: [...USAGE],
    notes: [
      "All command results are JSON; --json is retained for sbw routing compatibility.",
      "Import accepts complete KnowledgeNodeV1 JSON or a validated KnowledgeNodeExportV1 under a new local node ID.",
      "Export writes sanitized KnowledgeNodeExportV1; import rehydrates only its selected fields under a new local node ID.",
      "Local permissions separate CLI operations and do not grant owner, provider, action, or evidence authority."
    ]
  };
}

async function commandValidate(options, context) {
  assertKnownOptions(options, NODE_FILE_OPTIONS, "validate");
  if (options["state-root"] !== undefined) {
    const root = resolveStateRoot(options, context.env);
    await assertStateRoot(root);
  }
  const deadlineMs = deadlineOption(options);
  const { file, raw } = await readNodeInput(options, context.cwd);
  if (raw?.kind === KNOWLEDGE_NODE_EXPORT_KIND) {
    const exported = validateKnowledgeNodeExportV1(raw, deadlineMs === null ? {} : { deadlineMs });
    return resultWithBoundary({ ok: true, operation: "knowledge.validate-export", file, inputKind: KNOWLEDGE_NODE_EXPORT_KIND, export: exported });
  }
  const node = validateKnowledgeNodeV1(raw, deadlineMs === null ? {} : { deadlineMs });
  return resultWithBoundary({ ok: true, operation: "knowledge.validate", file, node });
}

async function commandSave(options, context, { imported }) {
  assertKnownOptions(options, MUTATION_OPTIONS, imported ? "import" : "save");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const deadlineMs = deadlineOption(options);
  const expectedRevision = normalizeExpectedRevision(options);
  const nodeId = normalizeNodeIdOption(options);
  const { file, raw } = await readNodeInput(options, context.cwd);
  if (imported && raw?.kind === KNOWLEDGE_NODE_EXPORT_KIND) {
    const permission = createKnowledgeSavePermission({ stateRoot: root, nodeId, expectedRevision });
    const result = await importKnowledgeExportV1({
      stateRoot: root,
      export: raw,
      nodeId,
      permission,
      ...(deadlineMs === null ? {} : { deadlineMs })
    });
    return resultWithBoundary({ ...result, inputFile: file, inputKind: KNOWLEDGE_NODE_EXPORT_KIND });
  }
  if (!imported && raw?.kind === KNOWLEDGE_NODE_EXPORT_KIND) {
    fail("EKNOWLEDGE_CLI_USAGE", "save accepts complete KnowledgeNodeV1 input; use import for KnowledgeNodeExportV1");
  }
  const node = validateKnowledgeNodeV1(raw, deadlineMs === null ? {} : { deadlineMs });
  assertNodeBinding(node, nodeId, expectedRevision);
  const permission = createKnowledgeSavePermission({ stateRoot: root, nodeId, expectedRevision });
  const result = imported
    ? await importKnowledgeNodeV1({ stateRoot: root, node, permission, ...(deadlineMs === null ? {} : { deadlineMs }) })
    : await saveKnowledgeNodeV1({ stateRoot: root, node, permission, ...(deadlineMs === null ? {} : { deadlineMs }) });
  return resultWithBoundary({ ...result, inputFile: file, inputKind: "KnowledgeNode" });
}

async function commandRead(options, context) {
  assertKnownOptions(options, READ_OPTIONS, "read");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const deadlineMs = deadlineOption(options);
  const nodeId = normalizeNodeIdOption(options);
  const revision = normalizeRevisionOption(options);
  const permission = createKnowledgeReadPermission({ stateRoot: root, nodeId, revision });
  return resultWithBoundary(await readKnowledgeNodeV1({
    stateRoot: root,
    nodeId,
    permission,
    ...(deadlineMs === null ? {} : { deadlineMs })
  }));
}

async function commandList(options, context) {
  assertKnownOptions(options, COMMON_OPTIONS, "list");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const deadlineMs = deadlineOption(options);
  const permission = createKnowledgeReadPermission({ stateRoot: root });
  const nodes = await listKnowledgeNodes({
    stateRoot: root,
    permission,
    ...(deadlineMs === null ? {} : { deadlineMs })
  });
  return resultWithBoundary({ ok: true, operation: "knowledge.list", nodes });
}

async function commandExport(options, context) {
  assertKnownOptions(options, EXPORT_OPTIONS, "export");
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const deadlineMs = deadlineOption(options);
  const nodeId = normalizeNodeIdOption(options);
  const revision = normalizeRevisionOption(options, { required: true });
  const candidateIds = repeatableIds(options, "candidate-id", "--candidate-id");
  const snippetIds = repeatableIds(options, "snippet-id", "--snippet-id");
  const out = safePath(stringOption(options, "out", "--out", { required: true }), "--out", context.cwd);
  const privacy = normalizedPrivacy(options);
  const permission = createKnowledgeExportPermission({
    stateRoot: root,
    nodeId,
    revision,
    candidateIds,
    snippetIds,
    privacy
  });
  const result = await exportKnowledgeNodeV1({
    stateRoot: root,
    nodeId,
    permission,
    ...(deadlineMs === null ? {} : { deadlineMs })
  });
  const artifact = await writeCreateOnlyJson(out, result.export, "knowledge export artifact");
  return resultWithBoundary({
    ok: true,
    operation: result.operation,
    nodeId,
    revision,
    exportDigest: result.exportDigest,
    artifact
  });
}

async function commandRevokeOrDelete(options, context, action) {
  assertKnownOptions(options, new Set([...COMMON_OPTIONS, "node-id", "expected-revision"]), action);
  const root = resolveStateRoot(options, context.env);
  await assertStateRoot(root);
  const deadlineMs = deadlineOption(options);
  const nodeId = normalizeNodeIdOption(options);
  const expectedRevision = integerOption(options, "expected-revision", "--expected-revision", {
    required: true,
    min: 1,
    max: KNOWLEDGE_NODE_LIMITS.maxRevisionCount
  });
  const permission = action === "revoke"
    ? createKnowledgeRevokePermission({ stateRoot: root, nodeId, expectedRevision })
    : createKnowledgeDeletePermission({ stateRoot: root, nodeId, expectedRevision });
  const result = action === "revoke"
    ? await revokeKnowledgeNodeV1({ stateRoot: root, nodeId, permission, ...(deadlineMs === null ? {} : { deadlineMs }) })
    : await deleteKnowledgeNodeV1({ stateRoot: root, nodeId, permission, ...(deadlineMs === null ? {} : { deadlineMs }) });
  return resultWithBoundary(result);
}

export async function handleKnowledgeCli(argv = [], { env = process.env, cwd = process.cwd() } = {}) {
  const parsed = parseKnowledgeCliArgs(argv);
  if (parsed.command === "help" || parsed.options.help === true) return commandHelp(parsed.options);
  switch (parsed.command) {
    case "validate":
      return commandValidate(parsed.options, { env, cwd });
    case "save":
      return commandSave(parsed.options, { env, cwd }, { imported: false });
    case "import":
      return commandSave(parsed.options, { env, cwd }, { imported: true });
    case "read":
      return commandRead(parsed.options, { env, cwd });
    case "list":
      return commandList(parsed.options, { env, cwd });
    case "export":
      return commandExport(parsed.options, { env, cwd });
    case "revoke":
    case "delete":
      return commandRevokeOrDelete(parsed.options, { env, cwd }, parsed.command);
    default:
      fail("EKNOWLEDGE_CLI_USAGE", `unsupported knowledge command: ${parsed.command}`);
  }
}

function normalizeError(error) {
  if (error instanceof KnowledgeCliError) return error;
  if (error instanceof KnowledgeNodeError) {
    return new KnowledgeCliError(error.code, error.message, { exitCode: 2, details: error.details });
  }
  if (error?.code === "EEXIST") return new KnowledgeCliError("EKNOWLEDGE_CONFLICT", error.message, { exitCode: 2 });
  if (["EACCES", "EPERM", "ELOOP", "ENOTDIR"].includes(error?.code)) {
    return new KnowledgeCliError("EKNOWLEDGE_FS", error.message, { exitCode: 2 });
  }
  return new KnowledgeCliError("EKNOWLEDGE_CLI_INTERNAL", error?.message ?? String(error), { exitCode: 2 });
}

export async function runKnowledgeCli(argv = [], context = {}) {
  try {
    return { exitCode: 0, value: await handleKnowledgeCli(argv, context) };
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

export async function main(argv = process.argv.slice(2)) {
  const result = await runKnowledgeCli(argv);
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  process.exitCode = result.exitCode;
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
