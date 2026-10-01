import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import {
  canonicalJson,
  canonicalizeScope,
  digestObject,
  hasCredentialShapedMaterial,
  isCredentialShapedValue
} from "./core.mjs";
import {
  digestApprovalEnvelope,
  validateApprovalEnvelope
} from "./execution-admission-v1.mjs";
import {
  assertPrivateStateBackendAvailableV1,
  assertPrivateStatePathV1
} from "./private-state-backend-v1.mjs";

/**
 * Immutable description of one local command effect.
 *
 * This module only canonicalizes and freshly reads a binding.  It does not
 * spawn a process, grant approval, or mutate a WorkflowPlanV1.  The command
 * is intentionally represented as data so a later adapter can use the
 * approved bytes without accepting a caller supplied shell string.
 */

export const NATIVE_COMMAND_BINDING_SCHEMA_VERSION = 1;
export const NATIVE_COMMAND_BINDING_KIND = "NativeCommandBindingV1";
export const NATIVE_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;
export const NATIVE_COMMAND_MAX_BINDING_BYTES = 256 * 1024;
export const NATIVE_COMMAND_MAX_BINDING_JSON_BYTES = NATIVE_COMMAND_MAX_BINDING_BYTES;
export const NATIVE_COMMAND_ACTION_PREFIX = "native-command:";

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_PATH_BYTES = 4096;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_ARGS_BYTES = 64 * 1024;
const MAX_ENV_KEYS = 128;
const MAX_ENV_VALUE_BYTES = 4096;
const MAX_ENV_BYTES = 64 * 1024;
const LITERAL_CREDENTIAL_ASSIGNMENT = /(?:^|[\s,;\/\\])(?:token|secret|password|passwd|api[_-]?key|access[_-]?key)\s*[:=]\s*\S+/i;

const BINDING_KEYS = new Set([
  "schemaVersion",
  "kind",
  "planDigest",
  "contractDigest",
  "taskId",
  "unitId",
  "sourceBindingDigest",
  "policyDigest",
  "revision",
  "scope",
  "recipient",
    "action",
  "executable",
  "executableDigest",
  "args",
  "cwd",
  "env",
  "maxOutputBytes",
  "approvalEnvelopeDigest",
  "commandDigest"
]);

const SCOPE_KEYS = new Set(["include", "exclude"]);

// These keys can alter code loading or carry credentials.  An explicit env
// object is the complete allowlist; no process.env values are inherited.
const SENSITIVE_ENV_KEY = /(?:^|[_-])(?:token|secret|password|passwd|credential|private[_-]?key|api[_-]?key|access[_-]?key|authorization|bearer|cookie|session)(?:$|[_-])/i;
const DANGEROUS_ENV_KEYS = new Set([
  "BASH_ENV",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "IFS",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PERL5OPT",
  "PYTHONPATH",
  "RUBYOPT"
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plain(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fail("ENATIVE_COMMAND_BINDING", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw fail("ENATIVE_COMMAND_BINDING", `${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, allowed, label, required = []) {
  plain(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw fail("ENATIVE_COMMAND_BINDING", `${label} contains unknown field(s): ${unknown.join(", ")}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw fail("ENATIVE_COMMAND_BINDING", `${label} requires ${key}`);
    }
  }
  return value;
}

function boundedString(value, label, { max = 4096, allowEmpty = false, pattern = null } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > max ||
      /[\u0000-\u001f\u007f]/.test(value) || value.trim() !== value) {
    throw fail("ENATIVE_COMMAND_BINDING", `${label} is invalid`);
  }
  if (pattern && !pattern.test(value)) {
    throw fail("ENATIVE_COMMAND_BINDING", `${label} is invalid`);
  }
  return value;
}

function identifier(value, label) {
  return boundedString(value, label, { max: 256, pattern: ID });
}

function digest(value, label) {
  return boundedString(value, label, { max: 64, pattern: DIGEST });
}

function revision(value, label) {
  return boundedString(value, label, { max: 256, pattern: REVISION });
}

function clone(value) {
  try {
    return structuredClone(value);
  } catch (error) {
    throw fail("ENATIVE_COMMAND_BINDING", `value is not structured-cloneable: ${error.message}`);
  }
}

function normalizedScopePath(value, label) {
  boundedString(value, label, { max: MAX_PATH_BYTES });
  if (value === "") throw fail("ENATIVE_COMMAND_BINDING", `${label} is invalid`);
  return value;
}

function normalizeScope(value, label = "scope") {
  exactKeys(value, SCOPE_KEYS, label, ["include"]);
  if (!Array.isArray(value.include) || value.include.length === 0) {
    throw fail("ENATIVE_COMMAND_BINDING", `${label}.include must be a non-empty array`);
  }
  const exclude = value.exclude === undefined ? [] : value.exclude;
  if (!Array.isArray(exclude)) {
    throw fail("ENATIVE_COMMAND_BINDING", `${label}.exclude must be an array`);
  }
  const rawInclude = value.include.map((item, index) => normalizedScopePath(item, `${label}.include[${index}]`));
  const rawExclude = exclude.map((item, index) => normalizedScopePath(item, `${label}.exclude[${index}]`));
  const canonicalInclude = canonicalizeScope(rawInclude);
  const canonicalExclude = rawExclude.length === 0 ? [] : canonicalizeScope(rawExclude);
  if (canonicalInclude.length !== rawInclude.length || canonicalExclude.length !== rawExclude.length) {
    throw fail("ENATIVE_COMMAND_BINDING", `${label} contains duplicate paths`);
  }
  return { include: canonicalInclude, exclude: canonicalExclude };
}

function absolutePath(value, label) {
  const text = boundedString(value, label, { max: MAX_PATH_BYTES });
  if (!path.isAbsolute(text)) {
    throw fail("ENATIVE_COMMAND_BINDING", `${label} must be absolute`);
  }
  return path.normalize(text);
}

function normalizedWorkspaceRoot(value, label = "workspaceRoot") {
  return absolutePath(value, label);
}

function pathInside(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function scopeAllowsCwd(scope, workspaceRoot, cwd) {
  if (!pathInside(workspaceRoot, cwd)) return false;
  const relative = path.relative(workspaceRoot, cwd).split(path.sep).join("/") || ".";
  const included = scope.include.some((entry) => entry === "." || relative === entry || relative.startsWith(`${entry}/`));
  const excluded = scope.exclude.some((entry) => relative === entry || relative.startsWith(`${entry}/`));
  return included && !excluded;
}

function assertWorkspaceScope(scope, cwd, workspaceRoot) {
  if (workspaceRoot === undefined || workspaceRoot === null) {
    throw fail("ENATIVE_COMMAND_BINDING", "workspaceRoot is required to validate cwd scope");
  }
  const workspace = normalizedWorkspaceRoot(workspaceRoot);
  if (!scopeAllowsCwd(scope, workspace, cwd)) {
    throw fail("ENATIVE_COMMAND_BINDING_SCOPE", "cwd is outside the approved scope or workspace");
  }
  return workspace;
}

function contextualPathAllowed(value, { workspaceRoot = null, scope = null } = {}) {
  if (!workspaceRoot || !scope || !path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  if (value !== normalized) return false;
  return pathInside(workspaceRoot, normalized) && scopeAllowsCwd(scope, workspaceRoot, normalized);
}

function rejectCredentialMaterial(value, label, context = {}) {
  // Literal credentials are always rejected before any contextual exception.
  if (hasCredentialShapedMaterial(value) || LITERAL_CREDENTIAL_ASSIGNMENT.test(value)) {
    throw fail("ENATIVE_COMMAND_BINDING_SECRET", `${label} contains credential-shaped material`);
  }
  if (isCredentialShapedValue(value) &&
      !context.allowedValues?.has(value) && !contextualPathAllowed(value, context)) {
    throw fail("ENATIVE_COMMAND_BINDING_SECRET", `${label} contains credential-shaped material`);
  }
}

function normalizeArgs(value, context = {}) {
  if (!Array.isArray(value)) throw fail("ENATIVE_COMMAND_BINDING", "args must be an array");
  const result = [];
  let totalBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw fail("ENATIVE_COMMAND_BINDING", `args[${index}] is missing`);
    const item = boundedString(value[index], `args[${index}]`, { max: MAX_ARGUMENT_BYTES, allowEmpty: true });
    rejectCredentialMaterial(item, `args[${index}]`, context);
    totalBytes += Buffer.byteLength(item) + 1;
    if (totalBytes > MAX_ARGS_BYTES) throw fail("ENATIVE_COMMAND_BINDING", "args exceed the bounded size");
    result.push(item);
  }
  return result;
}

function normalizeEnv(value) {
  plain(value, "env");
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_ENV_KEYS) throw fail("ENATIVE_COMMAND_BINDING", "env has too many entries");
  let totalBytes = 0;
  const result = {};
  for (const key of keys) {
    boundedString(key, `env.${key}`, { max: 64, pattern: ENV_KEY });
    if (SENSITIVE_ENV_KEY.test(key) || DANGEROUS_ENV_KEYS.has(key.toUpperCase())) {
      throw fail("ENATIVE_COMMAND_BINDING_SECRET", `env.${key} is not an allowed environment key`);
    }
    const valueText = boundedString(value[key], `env.${key}`, { max: MAX_ENV_VALUE_BYTES, allowEmpty: true });
    rejectCredentialMaterial(valueText, `env.${key}`);
    totalBytes += Buffer.byteLength(key) + Buffer.byteLength(valueText);
    if (totalBytes > MAX_ENV_BYTES) throw fail("ENATIVE_COMMAND_BINDING", "env exceeds the bounded size");
    result[key] = valueText;
  }
  return result;
}

function commandCore(value) {
  const {
    commandDigest: ignored,
    // The action is a projection of the payload digest.  Including it in the
    // payload would create a digest cycle and would allow a generic action to
    // be mistaken for a command authorization.
    action: ignoredAction,
    // Exact envelope identity is checked separately.  It contains the
    // envelope nonce and allocation, so including it here would make the
    // command action depend on approval issuance.
    approvalEnvelopeDigest: ignoredEnvelope,
    ...core
  } = value;
  return core;
}

function commandDigest(value) {
  return digestObject(commandCore(value));
}

function normalizeBinding(value, {
  workspaceRoot = undefined,
  requireWorkspace = true,
  allowMissingDigest = false,
  allowMissingAction = false
} = {}) {
  const requiredKeys = [
    "schemaVersion", "kind", "planDigest", "contractDigest", "taskId", "unitId",
    "sourceBindingDigest", "policyDigest", "revision", "scope", "recipient",
    "executable", "executableDigest", "args", "cwd", "env", "maxOutputBytes"
  ];
  if (!allowMissingAction) requiredKeys.push("action");
  if (!allowMissingDigest) requiredKeys.push("commandDigest");
  exactKeys(value, BINDING_KEYS, NATIVE_COMMAND_BINDING_KIND, [
    ...requiredKeys
  ]);
  if (value.schemaVersion !== NATIVE_COMMAND_BINDING_SCHEMA_VERSION || value.kind !== NATIVE_COMMAND_BINDING_KIND) {
    throw fail("ENATIVE_COMMAND_BINDING", `${NATIVE_COMMAND_BINDING_KIND} version/kind is invalid`);
  }
  const scope = normalizeScope(value.scope);
  const executable = absolutePath(value.executable, "executable");
  const cwd = absolutePath(value.cwd, "cwd");
  const workspace = requireWorkspace ? assertWorkspaceScope(scope, cwd, workspaceRoot) :
    (workspaceRoot === undefined || workspaceRoot === null ? null : normalizedWorkspaceRoot(workspaceRoot));
  const planDigest = digest(value.planDigest, "planDigest");
  const contractDigest = digest(value.contractDigest, "contractDigest");
  const sourceBindingDigest = digest(value.sourceBindingDigest, "sourceBindingDigest");
  const policyDigest = digest(value.policyDigest, "policyDigest");
  const executableDigest = digest(value.executableDigest, "executableDigest");
  const revisionValue = revision(value.revision, "revision");
  const normalized = {
    schemaVersion: NATIVE_COMMAND_BINDING_SCHEMA_VERSION,
    kind: NATIVE_COMMAND_BINDING_KIND,
    planDigest,
    contractDigest,
    taskId: identifier(value.taskId, "taskId"),
    unitId: identifier(value.unitId, "unitId"),
    sourceBindingDigest,
    policyDigest,
    revision: revisionValue,
    scope,
    recipient: boundedString(value.recipient, "recipient", { max: 512 }),
    executable,
    executableDigest,
    args: normalizeArgs(value.args, {
      allowedValues: new Set([planDigest, contractDigest, sourceBindingDigest, policyDigest, executableDigest, revisionValue]),
      workspaceRoot: workspace,
      scope
    }),
    cwd,
    env: normalizeEnv(value.env),
    maxOutputBytes: value.maxOutputBytes,
    ...(value.approvalEnvelopeDigest === undefined ? {} : {
      approvalEnvelopeDigest: digest(value.approvalEnvelopeDigest, "approvalEnvelopeDigest")
    })
  };
  if (value.action !== undefined) {
    boundedString(value.action, "action", { max: 512 });
  }
  if (!allowMissingAction && value.action === undefined) {
    throw fail("ENATIVE_COMMAND_BINDING", "action is required");
  }
  if (!Number.isSafeInteger(normalized.maxOutputBytes) || normalized.maxOutputBytes < 1 ||
      normalized.maxOutputBytes > NATIVE_COMMAND_MAX_OUTPUT_BYTES) {
    throw fail("ENATIVE_COMMAND_BINDING", "maxOutputBytes must be between 1 and 64 KiB");
  }
  if (workspace !== null && !scopeAllowsCwd(scope, workspace, cwd)) {
    throw fail("ENATIVE_COMMAND_BINDING_SCOPE", "cwd is outside the approved scope or workspace");
  }
  const computed = commandDigest(normalized);
  const expectedAction = `${NATIVE_COMMAND_ACTION_PREFIX}${computed}`;
  if (value.action !== undefined && value.action !== expectedAction) {
    throw fail("ENATIVE_COMMAND_BINDING_DRIFT", "action is not the canonical command digest projection");
  }
  normalized.action = expectedAction;
  if (!allowMissingDigest && value.commandDigest === undefined) {
    throw fail("ENATIVE_COMMAND_BINDING", "commandDigest is required");
  }
  const supplied = value.commandDigest === undefined ? null : digest(value.commandDigest, "commandDigest");
  if (supplied !== null && supplied !== computed) {
    throw fail("ENATIVE_COMMAND_BINDING_DRIFT", "commandDigest is not bound to the canonical command data");
  }
  const result = { ...normalized, commandDigest: computed };
  if (Buffer.byteLength(canonicalJson(result), "utf8") > NATIVE_COMMAND_MAX_BINDING_BYTES) {
    throw fail("ENATIVE_COMMAND_BINDING", "binding exceeds the bounded serialized size");
  }
  return result;
}

/**
 * Build a canonical binding.  `workspaceRoot` is validation context and is
 * deliberately not copied into the digest-bound record.
 */
export function createNativeCommandBinding(value, options = {}) {
  return normalizeBinding(clone(value), {
    workspaceRoot: options.workspaceRoot ?? options.workspace,
    allowMissingDigest: true,
    allowMissingAction: true
  });
}

export const buildNativeCommandBinding = createNativeCommandBinding;

/**
 * Validate an already materialized binding against the current approved
 * workspace.  This is pure; filesystem checks belong to the fresh reader.
 */
export function validateNativeCommandBinding(value, options = {}) {
  return normalizeBinding(clone(value), { workspaceRoot: options.workspaceRoot ?? options.workspace });
}

/**
 * Return the canonical digest after shape validation.  A workspace is needed
 * when the caller wants scope enforcement as part of the digest operation;
 * callers using this as a pure digest helper must still use the fresh reader
 * before an effect is authorized.
 */
export function digestNativeCommandBinding(value, options = {}) {
  const normalized = normalizeBinding(clone(value), {
    workspaceRoot: options.workspaceRoot ?? options.workspace,
    requireWorkspace: false,
    allowMissingDigest: true,
    allowMissingAction: true
  });
  return normalized.commandDigest;
}

export const commandBindingDigest = digestNativeCommandBinding;

function envelopeMatchesBinding(binding, envelope) {
  const normalizedEnvelope = validateApprovalEnvelope(envelope);
  const checks = [
    ["planDigest", binding.planDigest, normalizedEnvelope.planDigest],
    ["contractDigest", binding.contractDigest, normalizedEnvelope.contractDigest],
    ["taskId", binding.taskId, normalizedEnvelope.taskId],
    ["unitId", binding.unitId, normalizedEnvelope.unitId],
    ["sourceBindingDigest", binding.sourceBindingDigest, normalizedEnvelope.sourceBindingDigest],
    ["policyDigest", binding.policyDigest, normalizedEnvelope.policyDigest],
    ["revision", binding.revision, normalizedEnvelope.revision],
    ["recipient", binding.recipient, normalizedEnvelope.recipient],
    ["action", binding.action, normalizedEnvelope.action]
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) throw fail("ENATIVE_COMMAND_BINDING_APPROVAL", `${label} differs from ApprovalEnvelope`);
  }
  if (canonicalJson(binding.scope) !== canonicalJson(normalizedEnvelope.scope)) {
    throw fail("ENATIVE_COMMAND_BINDING_APPROVAL", "scope differs from ApprovalEnvelope");
  }
  const envelopeDigest = digestApprovalEnvelope(normalizedEnvelope);
  if (binding.approvalEnvelopeDigest !== undefined && binding.approvalEnvelopeDigest !== envelopeDigest) {
    throw fail("ENATIVE_COMMAND_BINDING_APPROVAL", "approvalEnvelopeDigest differs from ApprovalEnvelope");
  }
  return { envelope: normalizedEnvelope, envelopeDigest };
}

/**
 * Bind an existing canonical command to the exact existing ApprovalEnvelope.
 * The envelope is validated in its current closed shape and is never amended
 * with a command field.  The returned binding carries the envelope digest,
 * while recipient/action remain direct, human-visible equality checks.
 */
export function bindNativeCommandToApprovalEnvelope(binding, approvalEnvelope, options = {}) {
  const normalized = normalizeBinding(clone(binding), {
    workspaceRoot: options.workspaceRoot ?? options.workspace,
    requireWorkspace: true
  });
  const { envelopeDigest } = envelopeMatchesBinding(normalized, approvalEnvelope);
  const bound = { ...normalized, approvalEnvelopeDigest: envelopeDigest };
  const computed = commandDigest(bound);
  return { ...bound, commandDigest: computed };
}

/**
 * Check an already envelope-bound binding without changing either input.
 */
export function assertNativeCommandBindingMatchesApprovalEnvelope(binding, approvalEnvelope, options = {}) {
  const normalized = normalizeBinding(clone(binding), {
    workspaceRoot: options.workspaceRoot ?? options.workspace,
    requireWorkspace: true
  });
  const { envelopeDigest } = envelopeMatchesBinding(normalized, approvalEnvelope);
  if (normalized.approvalEnvelopeDigest !== envelopeDigest) {
    throw fail("ENATIVE_COMMAND_BINDING_APPROVAL", "binding is not bound to this ApprovalEnvelope");
  }
  return true;
}

async function readPathComponents(root, target, label, lstatImpl) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!pathInside(resolvedRoot, resolvedTarget)) {
    throw fail("ENATIVE_COMMAND_BINDING_FS", `${label} escapes its filesystem root`);
  }
  let current = resolvedRoot;
  const components = path.relative(resolvedRoot, resolvedTarget).split(path.sep).filter(Boolean);
  let rootInfo;
  try {
    rootInfo = await lstatImpl(current);
  } catch {
    throw fail("ENATIVE_COMMAND_BINDING_FS", `${label} filesystem root is unavailable`);
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw fail("ENATIVE_COMMAND_BINDING_FS", `${label} filesystem root is unsafe`);
  }
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let info;
    try {
      info = await lstatImpl(current);
    } catch {
      throw fail("ENATIVE_COMMAND_BINDING_FS", `${label} path is unavailable`);
    }
    if (info.isSymbolicLink()) throw fail("ENATIVE_COMMAND_BINDING_FS", `${label} contains a symlink`);
    if (index < components.length - 1 && !info.isDirectory()) {
      throw fail("ENATIVE_COMMAND_BINDING_FS", `${label} contains a non-directory component`);
    }
  }
  return { path: resolvedTarget, info: components.length === 0 ? rootInfo : await lstatImpl(resolvedTarget) };
}

function sameFileState(left, right) {
  if (!left || !right) return false;
  return ["dev", "ino", "mode", "nlink", "size", "mtimeMs", "ctimeMs"]
    .every((key) => left[key] === right[key]);
}

async function hashStableRegularFile(target, beforePath, lstatImpl, openImpl) {
  if (!beforePath.isFile() || beforePath.nlink !== 1) {
    throw fail("ENATIVE_COMMAND_BINDING_FS", "executable must be a regular single-link file");
  }
  let handle;
  try {
    handle = await openImpl(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const beforeHandle = await handle.stat();
    if (beforeHandle.isSymbolicLink?.() || !beforeHandle.isFile() || beforeHandle.nlink !== 1 ||
        !sameFileState(beforePath, beforeHandle)) {
      throw fail("ENATIVE_COMMAND_BINDING_DRIFT", "executable changed before hashing");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, position);
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const afterHandle = await handle.stat();
    const afterPath = await lstatImpl(target).catch(() => null);
    if (!afterPath || afterPath.isSymbolicLink() || !afterPath.isFile() || afterPath.nlink !== 1 ||
        !sameFileState(beforePath, afterPath) || !sameFileState(beforeHandle, afterHandle)) {
      throw fail("ENATIVE_COMMAND_BINDING_DRIFT", "executable changed during hashing");
    }
    return hash.digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ELOOP" || error?.code === "EISDIR") {
      throw fail("ENATIVE_COMMAND_BINDING_FS", "executable is unavailable or unsafe");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readContextualArgumentPaths(args, scope, workspaceRoot, lstatImpl, expected = null) {
  const paths = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!isCredentialShapedValue(value) || !path.isAbsolute(value)) continue;
    const target = path.normalize(value);
    if (value !== target) {
      throw fail("ENATIVE_COMMAND_BINDING_FS", `args[${index}] path must be canonical`);
    }
    if (!pathInside(workspaceRoot, target) || !scopeAllowsCwd(scope, workspaceRoot, target)) {
      throw fail("ENATIVE_COMMAND_BINDING_FS", `args[${index}] path is outside the approved scope or workspace`);
    }
    let current;
    try {
      current = await readPathComponents(workspaceRoot, target, `args[${index}]`, lstatImpl);
    } catch (error) {
      if (error?.code === "ENATIVE_COMMAND_BINDING_FS") throw error;
      throw fail("ENATIVE_COMMAND_BINDING_FS", `args[${index}] path is unavailable or unsafe`);
    }
    if (!current.info.isFile() || current.info.nlink !== 1) {
      throw fail("ENATIVE_COMMAND_BINDING_FS", `args[${index}] must be a regular single-link file`);
    }
    const previous = expected?.find((item) => item.index === index);
    if (previous && (previous.path !== current.path || !sameFileState(previous.info, current.info))) {
      throw fail("ENATIVE_COMMAND_BINDING_DRIFT", `args[${index}] changed during fresh validation`);
    }
    paths.push({ index, path: current.path, info: current.info });
  }
  if (expected && expected.length !== paths.length) {
    throw fail("ENATIVE_COMMAND_BINDING_DRIFT", "contextual command argument paths changed during fresh validation");
  }
  return paths;
}

/**
 * Recheck command paths against the live filesystem.  This intentionally
 * lives apart from canonicalization because symlink and executable state are
 * observations, not immutable plan bytes.
 */
export async function validateNativeCommandBindingFilesystem(binding, options = {}) {
  const workspaceRoot = options.workspaceRoot ?? options.workspace;
  const normalized = validateNativeCommandBinding(binding, { workspaceRoot });
  const lstatImpl = options.lstatImpl ?? lstat;
  const workspace = await readPathComponents(workspaceRoot, workspaceRoot, "workspaceRoot", lstatImpl);
  const cwd = await readPathComponents(workspace.path, normalized.cwd, "cwd", lstatImpl);
  if (!cwd.info.isDirectory()) throw fail("ENATIVE_COMMAND_BINDING_FS", "cwd must be a directory");
  const argumentPaths = await readContextualArgumentPaths(normalized.args, normalized.scope, workspace.path, lstatImpl);
  const executableRoot = path.parse(normalized.executable).root;
  const executable = await readPathComponents(executableRoot, normalized.executable, "executable", lstatImpl);
  if (!executable.info.isFile()) throw fail("ENATIVE_COMMAND_BINDING_FS", "executable must be a regular file");
  if (executable.info.nlink !== 1) throw fail("ENATIVE_COMMAND_BINDING_FS", "executable must have one link");
  if (process.platform !== "win32" && (executable.info.mode & 0o111) === 0) {
    throw fail("ENATIVE_COMMAND_BINDING_FS", "executable is not executable");
  }
  const executableDigest = await hashStableRegularFile(
    normalized.executable,
    executable.info,
    lstatImpl,
    options.openImpl ?? open
  );
  if (executableDigest !== normalized.executableDigest) {
    throw fail("ENATIVE_COMMAND_BINDING_DRIFT", "executableDigest does not match the current executable bytes");
  }
  await readContextualArgumentPaths(normalized.args, normalized.scope, workspace.path, lstatImpl, argumentPaths);
  return normalized;
}

function resolveBindingPath(root, target) {
  if (typeof target !== "string" || target.length === 0) {
    throw fail("ENATIVE_COMMAND_BINDING_FS", "binding path is required");
  }
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.isAbsolute(target) ? path.resolve(target) : path.resolve(resolvedRoot, target);
  if (!pathInside(resolvedRoot, resolvedTarget)) {
    throw fail("ENATIVE_COMMAND_BINDING_FS", "binding path escapes its state root");
  }
  return { root: resolvedRoot, target: resolvedTarget };
}

/**
 * Read and freshly validate a binding file.  This is read-only and never
 * rewrites the plan or binding.  The optional expected digest detects a file
 * swap between plan preparation and execution.
 */
export async function readFreshNativeCommandBinding({
  root,
  target,
  bindingPath = undefined,
  expectedDigest = undefined,
  commandDigest: expectedCommandDigest = undefined,
  workspaceRoot,
  workspace,
  requirePrivate = false,
  lstatImpl = lstat,
  openImpl = open
} = {}) {
  if (requirePrivate) assertPrivateStateBackendAvailableV1();
  const resolved = resolveBindingPath(root, target ?? bindingPath);
  const file = await readPathComponents(resolved.root, resolved.target, "binding", lstatImpl);
  if (!file.info.isFile() || file.info.nlink !== 1) {
    throw fail("ENATIVE_COMMAND_BINDING_FS", "binding must be a regular single-link file");
  }
  if (requirePrivate) {
    try {
      assertPrivateStatePathV1({
        root: resolved.root,
        target: resolved.target,
        info: file.info,
        kind: "file",
        label: "binding file"
      });
    } catch (error) {
      if (error?.code === "EWINDOWS_PRIVATE_STATE_BACKEND_UNAVAILABLE") throw error;
      throw fail("ENATIVE_COMMAND_BINDING_FS", error?.message ?? "binding file must be private");
    }
  }
  if (!Number.isSafeInteger(file.info.size) || file.info.size > NATIVE_COMMAND_MAX_BINDING_BYTES) {
    throw fail("ENATIVE_COMMAND_BINDING_FS", "binding JSON exceeds the fixed size limit");
  }
  let handle;
  let raw;
  try {
    handle = await openImpl(resolved.target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const beforeHandle = await handle.stat();
    if (beforeHandle.isSymbolicLink?.() || !beforeHandle.isFile() || beforeHandle.nlink !== 1 ||
        !sameFileState(file.info, beforeHandle)) {
      throw fail("ENATIVE_COMMAND_BINDING_DRIFT", "binding changed before read");
    }
    const buffer = Buffer.alloc(NATIVE_COMMAND_MAX_BINDING_BYTES + 1);
    let length = 0;
    while (length <= NATIVE_COMMAND_MAX_BINDING_BYTES) {
      const read = await handle.read(buffer, length, Math.min(64 * 1024, buffer.length - length), length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
      if (length > NATIVE_COMMAND_MAX_BINDING_BYTES) throw fail("ENATIVE_COMMAND_BINDING_FS", "binding JSON exceeds the fixed size limit");
    }
    raw = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    const afterHandle = await handle.stat();
    const afterPath = await lstatImpl(resolved.target).catch(() => null);
    if (!afterPath || afterPath.isSymbolicLink() || !afterPath.isFile() || afterPath.nlink !== 1 ||
        !sameFileState(file.info, afterPath) || !sameFileState(beforeHandle, afterHandle)) {
      throw fail("ENATIVE_COMMAND_BINDING_DRIFT", "binding changed during fresh read");
    }
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ELOOP" || error?.code === "EISDIR" || error instanceof SyntaxError) {
      throw fail("ENATIVE_COMMAND_BINDING_FS", "binding JSON is invalid or unsafe");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  const normalized = await validateNativeCommandBindingFilesystem(raw, {
    workspaceRoot: workspaceRoot ?? workspace,
    lstatImpl,
    openImpl
  });
  const expected = expectedDigest ?? expectedCommandDigest;
  if (expected !== undefined) digest(expected, "expectedDigest");
  if (expected !== undefined && normalized.commandDigest !== expected) {
    throw fail("ENATIVE_COMMAND_BINDING_DRIFT", "fresh binding digest differs from the expected digest");
  }
  const after = await lstatImpl(resolved.target).catch(() => null);
  if (!after || after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 || !sameFileState(file.info, after)) {
    throw fail("ENATIVE_COMMAND_BINDING_DRIFT", "binding changed during fresh read");
  }
  return normalized;
}
