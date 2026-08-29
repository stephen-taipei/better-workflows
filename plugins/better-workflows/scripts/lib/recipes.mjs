import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addEvidence,
  appendJournal,
  assertMutableRun,
  assertSpentActionNonSourceAuthority,
  assertSpentActionProviderAuthority,
  atomicWriteJson,
  canonicalJson,
  digestObject,
  ensurePrivateDir,
  evaluateCompletion,
  getStateRoot,
  inspectRun,
  listJsonRecords,
  loadDefaults,
  loadRun,
  nowIso,
  pluginRoot,
  readJson,
  reconcileAction,
  safeJoin,
  sha256,
  withRunLock
} from "./core.mjs";
import { captureSentinel, captureSourceBinding, runSourceGit } from "./git.mjs";
import { pluginBundleDigest } from "./routing.mjs";

const RUNTIME_PATH = fileURLToPath(new URL("./recipe-runtime.mjs", import.meta.url));
const ARTIFACT_PUBLISHER_PATH = fileURLToPath(new URL("./recipe-artifact-publisher.mjs", import.meta.url));
const RECIPE_SCHEMA_VERSION = 1;
const CONFIG_SCHEMA_VERSION = 1;
const TRUST_SCHEMA_VERSION = 1;
const RECEIPT_SCHEMA_VERSION = 1;
const SAFE_RECIPE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_ARTIFACT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_SENTINEL_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RECEIPT_ID = /^recipe-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 300;
const DEFAULT_STDOUT_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TOTAL_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 100 * 1024 * 1024;
const CONFIG_RELATIVE = path.join(".codex", "better-workflows");
const ARTIFACT_RELATIVE = path.join(CONFIG_RELATIVE, "artifacts");
const RESERVED_READ_ROOT = CONFIG_RELATIVE.split(path.sep).join("/");
const RESERVED_ARTIFACT_AUTHORITY_COMPONENTS = new Set([
  ".git",
  ".gitattributes",
  ".gitignore",
  ".gitmodules"
]);
const REFERENCE_ROOT = path.join(pluginRoot(), "fixtures", "recipes");
const ALLOWED_BUILTIN_IMPORTS = new Set([
  "node:assert",
  "node:buffer",
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:path",
  "node:string_decoder",
  "node:url",
  "node:util"
]);

function recipeError(message) {
  return new Error(`Workspace recipe: ${message}`);
}

async function addActionEvidence(stateRoot, action, providerReceipt) {
  const run = await inspectRun(stateRoot, action.runId);
  const payload = {
    provider: action.provider,
    actionProof: {
      schemaVersion: 1,
      runId: action.runId,
      actionAttemptId: action.attemptId,
      action: action.action,
      provider: action.provider,
      resource: action.resource,
      outcome: "success",
      idempotencyKey: action.idempotencyKey,
      remoteRevision: action.remoteRevision,
      providerExecutionId: providerReceipt.executionId,
      providerReceiptDigest: digestObject(providerReceipt)
    },
    receipt: providerReceipt
  };
  const record = {
    id: `action-proof-${action.attemptId}`,
    kind: "provider-reconciliation",
    status: "complete",
    summary: `Provider receipt for ${action.action}`,
    acceptanceIds: [],
    dependencyInputs: { files: [] },
    sourceDigest: digestObject(payload),
    receipt: run.contract.schemaVersion === 2
      ? {
          contractId: "evidence-contracts-v1:provider-reconciliation",
          contractVersion: 1,
          runId: action.runId,
          producer: { provider: "codex-root" },
          inputBinding: {
            runId: action.runId,
            contractDigest: digestObject(run.contract),
            remoteRevision: run.contract.remoteRevision ?? null
          },
          payload,
          payloadDigest: digestObject(payload),
          producedAt: action.spentAt
        }
      : { payload }
  };
  if (run.contract.schemaVersion === 2) record.schemaVersion = 2;
  const existing = run.evidence.find((item) => item.id === record.id);
  if (existing) {
    if (
      existing.kind !== record.kind || existing.status !== "complete" ||
      existing.sourceDigest !== record.sourceDigest ||
      digestObject(existing.receipt?.payload ?? null) !== digestObject(payload)
    ) {
      throw recipeError("existing provider reconciliation evidence conflicts with this action receipt");
    }
    return existing;
  }
  return addEvidence(stateRoot, action.runId, record);
}

function sentinelPathBinding(sentinel, relativePath) {
  const matches = [
    ...(sentinel.scopeDigest?.records ?? [])
      .filter((item) => item.path === relativePath)
      .map((record) => ({ surface: "tracked", record })),
    ...(sentinel.untracked?.records ?? [])
      .filter((item) => item.path === relativePath)
      .map((record) => ({ surface: "untracked", record }))
  ];
  if (matches.length > 1) throw recipeError("source mutation path has ambiguous sentinel coverage");
  return matches[0] ?? null;
}

async function issuedSourceSentinel(stateRoot, run, action) {
  const binding = action.sourceAuthorityAtIssue?.sourceSentinel;
  if (
    !binding || !SAFE_SENTINEL_LABEL.test(binding.label ?? "") ||
    binding.digest !== action.treeDigest || !SHA256.test(binding.recordDigest ?? "")
  ) {
    throw recipeError("action lacks an immutable issued source sentinel");
  }
  const sentinel = await readJson(
    stateRoot,
    safeJoin(run.runDir, "sentinels", `${binding.label}.json`)
  );
  if (!sentinel.complete || sentinel.digest !== binding.digest) {
    throw recipeError("issued source sentinel is stale or incomplete");
  }
  return sentinel;
}

function providerActionSourceMutation({
  action,
  relativePath,
  beforeSentinel,
  afterSentinel,
  beforeSourceBinding,
  afterSourceBinding,
  recipeConfig = null
}) {
  const sourceChanged = beforeSourceBinding.digest !== afterSourceBinding.digest;
  const sentinelChanged = beforeSentinel.digest !== afterSentinel.digest;
  if (!sourceChanged && !sentinelChanged) return null;
  if (!sourceChanged || !sentinelChanged) {
    throw recipeError("source mutation sentinel and source binding disagree");
  }
  return {
    schemaVersion: 1,
    kind: "provider-action",
    actionAttemptId: action.attemptId,
    action: action.action,
    provider: action.provider,
    resource: action.resource,
    path: relativePath,
    sourceBinding: {
      from: beforeSourceBinding.digest,
      to: afterSourceBinding.digest,
      headRevision: afterSourceBinding.headRevision
    },
    sentinel: { from: beforeSentinel.digest, to: afterSentinel.digest },
    pathTransition: {
      before: sentinelPathBinding(beforeSentinel, relativePath),
      after: sentinelPathBinding(afterSentinel, relativePath)
    },
    ...(recipeConfig ? { recipeConfig } : {})
  };
}

function sourceRecoveryProjection(sentinel, allowedPaths) {
  const allowed = new Set(allowedPaths);
  const recordsWithoutAllowedPaths = (records) => (
    (records ?? []).filter((record) => !allowed.has(record.path))
  );
  return {
    schemaVersion: sentinel.schemaVersion,
    cwd: sentinel.cwd,
    complete: sentinel.complete,
    head: sentinel.head,
    indexDigest: sentinel.indexDigest,
    scopes: sentinel.scopes,
    scopeDigest: {
      complete: sentinel.scopeDigest?.complete,
      skipped: sentinel.scopeDigest?.skipped ?? [],
      records: recordsWithoutAllowedPaths(sentinel.scopeDigest?.records)
    },
    untracked: {
      complete: sentinel.untracked?.complete,
      skipped: sentinel.untracked?.skipped ?? [],
      records: recordsWithoutAllowedPaths(sentinel.untracked?.records)
    },
    authorityMetadata: sentinel.authorityMetadata,
    attributes: sentinel.attributes,
    exclusions: sentinel.exclusions,
    highRiskIgnored: sentinel.highRiskIgnored,
    submodules: sentinel.submodules,
    symlinks: {
      records: recordsWithoutAllowedPaths(sentinel.symlinks?.records)
    },
    skipped: sentinel.skipped ?? []
  };
}

function assertExpectedSourceRecovery(baseline, current, allowedPaths, context) {
  if (!baseline.complete || !current.complete) {
    throw recipeError(`${context} source sentinel is incomplete`);
  }
  if (
    digestObject(sourceRecoveryProjection(baseline, allowedPaths)) !==
    digestObject(sourceRecoveryProjection(current, allowedPaths))
  ) {
    throw recipeError(`${context} contains an undeclared source mutation`);
  }
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw recipeError(`${label} must be an object`);
  }
  return value;
}

function assertKnownKeys(value, keys, label) {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    throw recipeError(`${label} has unknown fields: ${unknown.join(", ")}`);
  }
}

function boundedInteger(value, label, minimum, maximum, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw recipeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

function pathContained(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (!relative || relative === ".") return resolvedTarget;
    throw recipeError(`${label} escapes the workspace`);
  }
  return resolvedTarget;
}

function artifactDestinationTouchesReservedAuthority(normalized) {
  const folded = normalized.toLowerCase();
  const foldedComponents = folded.split("/");
  const foldedReservedRoot = RESERVED_READ_ROOT.toLowerCase();
  return (
    foldedComponents.some((component) => RESERVED_ARTIFACT_AUTHORITY_COMPONENTS.has(component)) ||
    folded === foldedReservedRoot ||
    folded.startsWith(`${foldedReservedRoot}/`)
  );
}

function filesystemIdentity(info) {
  return `${String(info.dev)}:${String(info.ino)}`;
}

async function artifactPromotionProtectedIdentities(workspace) {
  const gitDirectory = (await runSourceGit(workspace.root, ["rev-parse", "--absolute-git-dir"], {
    maxBuffer: 1024 * 1024
  })).stdout.trim();
  const gitCommonDirectory = (await runSourceGit(workspace.root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ], { maxBuffer: 1024 * 1024 })).stdout.trim();
  const protectedRoots = [
    gitDirectory,
    gitCommonDirectory,
    workspace.paths.base,
    workspace.paths.recipes,
    workspace.paths.artifacts
  ];
  const identities = new Set();
  for (const candidate of protectedRoots) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(workspace.root, candidate);
    if (!(await exists(resolved))) continue;
    const canonical = await realpath(resolved);
    const info = await lstat(canonical);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw recipeError(`protected artifact authority root is unsafe: ${resolved}`);
    }
    identities.add(filesystemIdentity(info));
  }
  return identities;
}

async function assertSafeExistingPath(root, relativePath, label, { file = false } = {}) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0")
  ) {
    throw recipeError(`${label} must be a safe repo-relative path`);
  }
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized !== relativePath.replaceAll("\\", "/")) {
    throw recipeError(`${label} must not contain traversal or normalization aliases`);
  }
  const target = pathContained(root, path.join(root, ...normalized.split("/")), label);
  let current = path.resolve(root);
  const rootInfo = await lstat(current);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw recipeError("Git worktree root is unsafe");
  }
  for (const component of normalized.split("/").filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") throw recipeError(`${label} does not exist: ${relativePath}`);
      throw error;
    });
    if (info.isSymbolicLink()) throw recipeError(`${label} contains a symlink: ${relativePath}`);
  }
  const info = await lstat(target);
  if (file && (!info.isFile() || info.nlink !== 1)) {
    throw recipeError(`${label} must be a regular, non-hardlinked file`);
  }
  if (!file && !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) {
    throw recipeError(`${label} must be a safe file or directory`);
  }
  if (!file && info.isDirectory()) await assertSafeReadTree(target, label);
  return target;
}

async function assertSafeReadTree(directory, label) {
  const pending = [directory];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      visited += 1;
      if (visited > 100_000) throw recipeError(`${label} exceeds the 100000-entry validation bound`);
      const target = path.join(current, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw recipeError(`${label} contains a symlink: ${target}`);
      if (info.isDirectory()) {
        pending.push(target);
      } else if (!info.isFile() || info.nlink !== 1) {
        throw recipeError(`${label} contains an unsafe or hardlinked file: ${target}`);
      }
    }
  }
}

async function gitRoot(cwd = process.cwd()) {
  const { stdout } = await runSourceGit(cwd, ["rev-parse", "--show-toplevel"], { maxBuffer: 1024 * 1024 });
  const root = await realpath(stdout.trim());
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw recipeError("Git root is unsafe");
  return root;
}

function workspacePaths(root) {
  const base = path.join(root, CONFIG_RELATIVE);
  return {
    root,
    base,
    config: path.join(base, "config.json"),
    recipes: path.join(base, "recipes"),
    artifacts: path.join(base, "artifacts")
  };
}

function defaultConfig() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    enabled: false,
    artifactRetentionDays: 7,
    workspaceArtifactCapBytes: 100 * 1024 * 1024
  };
}

function validateConfig(value) {
  assertObject(value, "config.json");
  assertKnownKeys(
    value,
    ["schemaVersion", "enabled", "artifactRetentionDays", "workspaceArtifactCapBytes"],
    "config.json"
  );
  if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw recipeError(`config.json schemaVersion must be ${CONFIG_SCHEMA_VERSION}`);
  }
  if (typeof value.enabled !== "boolean") throw recipeError("config.json enabled must be boolean");
  boundedInteger(value.artifactRetentionDays, "artifactRetentionDays", 1, 365, 7);
  boundedInteger(
    value.workspaceArtifactCapBytes,
    "workspaceArtifactCapBytes",
    1024 * 1024,
    MAX_TOTAL_ARTIFACT_BYTES,
    MAX_TOTAL_ARTIFACT_BYTES
  );
  return value;
}

async function loadWorkspace(cwd, { initialized = true } = {}) {
  const root = await gitRoot(cwd);
  const paths = workspacePaths(root);
  if (!(await exists(paths.config))) {
    if (!initialized) return { root, paths, config: null };
    throw recipeError(`not initialized at ${root}; run "sbw recipe init" explicitly`);
  }
  await assertSafeExistingPath(root, `${RESERVED_READ_ROOT}/config.json`, "config.json", { file: true });
  const config = validateConfig(JSON.parse(await readFile(paths.config, "utf8")));
  return { root, paths, config };
}

function validateInputSchema(schema, label = "inputSchema", depth = 0) {
  if (depth > 6) throw recipeError(`${label} exceeds maximum nesting depth`);
  assertObject(schema, label);
  const allowed = [
    "type",
    "description",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "minimum",
    "maximum"
  ];
  assertKnownKeys(schema, allowed, label);
  if (!["object", "string", "number", "boolean", "array", "path"].includes(schema.type)) {
    throw recipeError(`${label}.type is unsupported`);
  }
  if (schema.description !== undefined && typeof schema.description !== "string") {
    throw recipeError(`${label}.description must be a string`);
  }
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) {
      throw recipeError(`${label}.additionalProperties must be false`);
    }
    assertObject(schema.properties ?? {}, `${label}.properties`);
    const keys = Object.keys(schema.properties ?? {});
    if (keys.length > 64) throw recipeError(`${label}.properties exceeds 64 fields`);
    for (const key of keys) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) {
        throw recipeError(`${label}.properties contains an unsafe key`);
      }
      validateInputSchema(schema.properties[key], `${label}.properties.${key}`, depth + 1);
    }
    if (!Array.isArray(schema.required)) throw recipeError(`${label}.required must be an array`);
    if (new Set(schema.required).size !== schema.required.length) {
      throw recipeError(`${label}.required contains duplicates`);
    }
    for (const key of schema.required) {
      if (!Object.hasOwn(schema.properties, key)) {
        throw recipeError(`${label}.required references unknown property: ${key}`);
      }
    }
  } else if (schema.type === "array") {
    validateInputSchema(schema.items, `${label}.items`, depth + 1);
    boundedInteger(schema.minItems, `${label}.minItems`, 0, 10_000, 0);
    boundedInteger(schema.maxItems, `${label}.maxItems`, 0, 10_000, 1000);
    if ((schema.minItems ?? 0) > (schema.maxItems ?? 1000)) {
      throw recipeError(`${label}.minItems exceeds maxItems`);
    }
  } else {
    for (const key of ["properties", "required", "additionalProperties", "items", "minItems", "maxItems"]) {
      if (schema[key] !== undefined) throw recipeError(`${label}.${key} is invalid for ${schema.type}`);
    }
  }
  return schema;
}

function validateInputValue(schema, value, root, label = "input") {
  if (schema.type === "object") {
    assertObject(value, label);
    const unknown = Object.keys(value).filter((key) => !Object.hasOwn(schema.properties, key));
    if (unknown.length > 0) throw recipeError(`${label} has unknown fields: ${unknown.join(", ")}`);
    for (const key of schema.required) {
      if (!Object.hasOwn(value, key)) throw recipeError(`${label}.${key} is required`);
    }
    const result = {};
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key)) result[key] = validateInputValue(child, value[key], root, `${label}.${key}`);
    }
    return result;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw recipeError(`${label} must be an array`);
    const min = schema.minItems ?? 0;
    const max = schema.maxItems ?? 1000;
    if (value.length < min || value.length > max) throw recipeError(`${label} length must be ${min}..${max}`);
    return value.map((item, index) => validateInputValue(schema.items, item, root, `${label}[${index}]`));
  }
  if (schema.type === "string" || schema.type === "path") {
    if (typeof value !== "string") throw recipeError(`${label} must be a string`);
    const min = schema.minLength ?? 0;
    const max = schema.maxLength ?? 16_384;
    if (value.length < min || value.length > max || value.includes("\0")) {
      throw recipeError(`${label} length or content is invalid`);
    }
    if (schema.type === "path") {
      if (path.isAbsolute(value)) throw recipeError(`${label} must be repo-relative`);
      const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
      if (normalized === ".." || normalized.startsWith("../") || normalized !== value.replaceAll("\\", "/")) {
        throw recipeError(`${label} contains traversal or normalization aliases`);
      }
      pathContained(root, path.join(root, ...normalized.split("/")), label);
      return normalized;
    }
    return value;
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw recipeError(`${label} must be a finite number`);
    if (schema.minimum !== undefined && value < schema.minimum) throw recipeError(`${label} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw recipeError(`${label} is above maximum`);
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw recipeError(`${label} must be boolean`);
    return value;
  }
  throw recipeError(`${label} uses an unsupported schema type`);
}

async function validateEntrySource(entryPath) {
  const source = await readFile(entryPath, "utf8");
  if (Buffer.byteLength(source) > 512 * 1024) throw recipeError("run.mjs exceeds 512 KiB");
  if (!/\bexport\s+default\s+(?:async\s+)?function\b/.test(source)) {
    throw recipeError("run.mjs must export a default function");
  }
  const importMatches = [...source.matchAll(/\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g)];
  for (const match of importMatches) {
    const specifier = match[1];
    if (!ALLOWED_BUILTIN_IMPORTS.has(specifier)) {
      throw recipeError(`run.mjs import is not allowed: ${specifier}`);
    }
  }
  const forbidden = [
    [/\bimport\s*\(/, "dynamic import"],
    [/\brequire\s*\(/, "require"],
    [/\bprocess\b/, "process"],
    [/\b(?:fetch|WebSocket|EventSource|BroadcastChannel)\b/, "network global"],
    [/\b(?:Worker|SharedWorker)\b/, "worker"],
    [/\b(?:eval|Function|WebAssembly)\b/, "dynamic code"],
    [/\b(?:link|linkSync|symlink|symlinkSync)\b/, "filesystem link"],
    [/\b(?:Bun|Deno)\b/, "alternate runtime"]
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(source)) throw recipeError(`run.mjs uses forbidden capability: ${label}`);
  }
  return { source, scriptDigest: sha256(source) };
}

export async function validateRecipeManifest(value, root, recipeDirectory) {
  assertObject(value, "recipe.json");
  assertKnownKeys(
    value,
    [
      "schemaVersion",
      "id",
      "version",
      "description",
      "entry",
      "readPaths",
      "inputSchema",
      "artifacts",
      "timeoutSeconds",
      "maxStdoutBytes",
      "maxTotalArtifactBytes"
    ],
    "recipe.json"
  );
  if (value.schemaVersion !== RECIPE_SCHEMA_VERSION) {
    throw recipeError(`recipe.json schemaVersion must be ${RECIPE_SCHEMA_VERSION}`);
  }
  if (typeof value.id !== "string" || !SAFE_RECIPE_ID.test(value.id)) {
    throw recipeError("recipe id must be safe kebab-case");
  }
  if (path.basename(recipeDirectory) !== value.id) throw recipeError("recipe directory must match recipe id");
  if (typeof value.version !== "string" || !SEMVER.test(value.version)) {
    throw recipeError("recipe version must be semver");
  }
  if (typeof value.description !== "string" || !value.description.trim() || value.description.length > 512) {
    throw recipeError("recipe description is required and limited to 512 characters");
  }
  if (value.entry !== "run.mjs") throw recipeError('recipe entry must be exactly "run.mjs"');
  if (!Array.isArray(value.readPaths) || value.readPaths.length > 128) {
    throw recipeError("readPaths must be an array with at most 128 paths");
  }
  if (new Set(value.readPaths).size !== value.readPaths.length) {
    throw recipeError("readPaths contains duplicates");
  }
  const readTargets = [];
  for (const [index, relative] of value.readPaths.entries()) {
    if (typeof relative !== "string") {
      throw recipeError(`readPaths[${index}] must be a string`);
    }
    const normalized = relative.replaceAll("\\", "/");
    if (
      normalized === "." ||
      normalized === RESERVED_READ_ROOT ||
      normalized.startsWith(`${RESERVED_READ_ROOT}/`) ||
      RESERVED_READ_ROOT.startsWith(`${normalized}/`)
    ) {
      throw recipeError(`readPaths[${index}] overlaps recipe control or artifact scope`);
    }
    readTargets.push(await assertSafeExistingPath(root, normalized, `readPaths[${index}]`));
  }
  for (let left = 0; left < value.readPaths.length; left += 1) {
    for (let right = left + 1; right < value.readPaths.length; right += 1) {
      const a = `${value.readPaths[left].replaceAll("\\", "/")}/`;
      const b = `${value.readPaths[right].replaceAll("\\", "/")}/`;
      if (a.startsWith(b) || b.startsWith(a)) {
        throw recipeError("readPaths must not overlap");
      }
    }
  }
  validateInputSchema(value.inputSchema);
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > 32) {
    throw recipeError("artifacts must declare 1..32 outputs");
  }
  const artifactIds = new Set();
  const artifactFiles = new Set();
  for (const [index, artifact] of value.artifacts.entries()) {
    assertObject(artifact, `artifacts[${index}]`);
    assertKnownKeys(artifact, ["id", "filename", "mediaType", "maxBytes", "promotable"], `artifacts[${index}]`);
    if (typeof artifact.id !== "string" || !SAFE_ARTIFACT_ID.test(artifact.id) || artifactIds.has(artifact.id)) {
      throw recipeError(`artifacts[${index}].id is invalid or duplicated`);
    }
    if (typeof artifact.filename !== "string" || !SAFE_FILENAME.test(artifact.filename) || artifactFiles.has(artifact.filename)) {
      throw recipeError(`artifacts[${index}].filename is invalid or duplicated`);
    }
    if (typeof artifact.mediaType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(artifact.mediaType)) {
      throw recipeError(`artifacts[${index}].mediaType is invalid`);
    }
    boundedInteger(artifact.maxBytes, `artifacts[${index}].maxBytes`, 1, MAX_TOTAL_ARTIFACT_BYTES, null);
    if (typeof artifact.promotable !== "boolean") throw recipeError(`artifacts[${index}].promotable must be boolean`);
    artifactIds.add(artifact.id);
    artifactFiles.add(artifact.filename);
  }
  const timeoutSeconds = boundedInteger(
    value.timeoutSeconds,
    "timeoutSeconds",
    1,
    MAX_TIMEOUT_SECONDS,
    DEFAULT_TIMEOUT_SECONDS
  );
  const maxStdoutBytes = boundedInteger(
    value.maxStdoutBytes,
    "maxStdoutBytes",
    1024,
    MAX_STDOUT_BYTES,
    DEFAULT_STDOUT_BYTES
  );
  const maxTotalArtifactBytes = boundedInteger(
    value.maxTotalArtifactBytes,
    "maxTotalArtifactBytes",
    1,
    MAX_TOTAL_ARTIFACT_BYTES,
    DEFAULT_TOTAL_ARTIFACT_BYTES
  );
  if (value.artifacts.reduce((sum, item) => sum + item.maxBytes, 0) > maxTotalArtifactBytes) {
    throw recipeError("declared artifact byte caps exceed maxTotalArtifactBytes");
  }
  const entryPath = await assertSafeExistingPath(
    root,
    path.relative(root, path.join(recipeDirectory, "run.mjs")).split(path.sep).join("/"),
    "run.mjs",
    { file: true }
  );
  const entry = await validateEntrySource(entryPath);
  return {
    manifest: {
      ...value,
      timeoutSeconds,
      maxStdoutBytes,
      maxTotalArtifactBytes
    },
    readTargets,
    entryPath,
    ...entry
  };
}

async function loadRecipe(cwd, id) {
  if (!SAFE_RECIPE_ID.test(String(id))) throw recipeError(`invalid recipe id: ${id}`);
  const workspace = await loadWorkspace(cwd);
  const directory = path.join(workspace.paths.recipes, String(id));
  const directoryInfo = await lstat(directory).catch((error) => {
    if (error.code === "ENOENT") throw recipeError(`unknown recipe: ${id}`);
    throw error;
  });
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw recipeError(`recipe directory is unsafe: ${id}`);
  }
  await assertRecipeTree(directory);
  const relativeManifest = path.relative(workspace.root, path.join(directory, "recipe.json")).split(path.sep).join("/");
  await assertSafeExistingPath(workspace.root, relativeManifest, "recipe.json", { file: true });
  const raw = JSON.parse(await readFile(path.join(directory, "recipe.json"), "utf8"));
  const validation = await validateRecipeManifest(raw, workspace.root, directory);
  return { ...workspace, directory, ...validation };
}

async function assertRecipeTree(directory) {
  await assertSafeReadTree(directory, "recipe directory");
  const pending = [{ directory, relative: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current.directory, { withFileTypes: true })) {
      const relative = path.posix.join(current.relative, entry.name);
      if (entry.isDirectory()) {
        pending.push({ directory: path.join(current.directory, entry.name), relative });
      } else if (entry.name.endsWith(".mjs") && relative !== "run.mjs") {
        throw recipeError(`v1 permits only the single entry module run.mjs: ${relative}`);
      }
    }
  }
}

async function executionBinding(recipe) {
  const manifestDigest = digestObject(recipe.manifest);
  const bundleDigest = await pluginBundleDigest();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 24) throw recipeError("workspace recipe execution requires Node.js 24 or newer");
  const workspaceDigest = sha256(await realpath(recipe.root));
  const executionDigest = digestObject({
    schemaVersion: 1,
    workspaceDigest,
    manifestDigest,
    scriptDigest: recipe.scriptDigest,
    pluginBundleDigest: bundleDigest,
    nodeMajor
  });
  return {
    workspaceDigest,
    manifestDigest,
    scriptDigest: recipe.scriptDigest,
    pluginBundleDigest: bundleDigest,
    nodeMajor,
    executionDigest
  };
}

function privateRecipePaths(stateRoot, workspaceDigest, recipeId) {
  const root = safeJoin(stateRoot, "workspaces", workspaceDigest, "recipes", recipeId);
  return {
    root,
    trust: safeJoin(root, "trust.json"),
    receipts: safeJoin(root, "receipts")
  };
}

function recipeConfigReplacementIntentPath(runDir, actionAttemptId) {
  if (!SAFE_SENTINEL_LABEL.test(actionAttemptId ?? "")) {
    throw recipeError("recipe config replacement attempt identity is unsafe");
  }
  return safeJoin(runDir, "local-provider-intents", `${actionAttemptId}.json`);
}

function recipeConfigReplacementBinding({
  runIdValue,
  action,
  target,
  parent,
  parentIdentity,
  targetName,
  artifact,
  priorTarget,
  publisherDigest
}) {
  const temporaryDigest = sha256(canonicalJson({
    runId: runIdValue,
    actionAttemptId: action.attemptId,
    target,
    artifactSha256: artifact.sha256,
    artifactBytes: artifact.bytes
  })).slice(0, 32);
  return {
    schemaVersion: 1,
    kind: "recipe-config-replacement",
    runId: runIdValue,
    actionAttemptId: action.attemptId,
    tokenHash: action.tokenHash,
    action: action.action,
    provider: action.provider,
    resource: action.resource,
    idempotencyKey: action.idempotencyKey,
    remoteRevision: action.remoteRevision,
    treeDigest: action.treeDigest,
    evidenceGateDigest: action.evidenceGateDigest,
    evidenceSupersessionFreshnessDigest: action.evidenceSupersessionFreshnessDigest,
    target,
    parent,
    parentIdentity,
    targetName,
    temporaryName: `.sbw-workspace-json-${temporaryDigest}.tmp`,
    artifactSha256: artifact.sha256,
    artifactBytes: artifact.bytes,
    priorTarget,
    publisherDigest
  };
}

function validateRecipeConfigReplacementIntent(intent, expected) {
  const binding = intent?.binding;
  if (
    !intent || intent.schemaVersion !== 1 || intent.kind !== "recipe-config-replacement" ||
    !["prepared", "published"].includes(intent.status) ||
    digestObject(binding ?? null) !== intent.bindingDigest ||
    binding.runId !== expected.runIdValue ||
    binding.actionAttemptId !== expected.action.attemptId ||
    binding.tokenHash !== expected.action.tokenHash ||
    binding.action !== expected.action.action ||
    binding.provider !== expected.action.provider ||
    binding.resource !== expected.action.resource ||
    binding.idempotencyKey !== expected.action.idempotencyKey ||
    binding.remoteRevision !== expected.action.remoteRevision ||
    binding.treeDigest !== expected.action.treeDigest ||
    binding.evidenceGateDigest !== expected.action.evidenceGateDigest ||
    binding.evidenceSupersessionFreshnessDigest !== expected.action.evidenceSupersessionFreshnessDigest ||
    binding.target !== expected.target ||
    binding.parent !== expected.parent ||
    binding.parentIdentity !== expected.parentIdentity ||
    binding.targetName !== expected.targetName ||
    !/^\.sbw-workspace-json-[a-f0-9]{32}\.tmp$/.test(binding.temporaryName ?? "") ||
    binding.artifactSha256 !== expected.artifact.sha256 ||
    binding.artifactBytes !== expected.artifact.bytes ||
    binding.priorTarget?.identity !== expected.priorTarget.identity ||
    binding.priorTarget?.sha256 !== expected.priorTarget.sha256 ||
    binding.priorTarget?.size !== expected.priorTarget.size ||
    binding.priorTarget?.nlink !== 1 ||
    binding.publisherDigest !== expected.publisherDigest ||
    (intent.status === "published" && !/^\d+:\d+$/.test(intent.targetIdentity ?? ""))
  ) {
    throw recipeError("recipe config replacement intent is stale or malformed");
  }
  const canonicalBinding = recipeConfigReplacementBinding(expected);
  if (digestObject(binding) !== digestObject(canonicalBinding)) {
    throw recipeError("recipe config replacement intent identity changed");
  }
  return intent;
}

async function writeRecipeConfigReplacementIntent(stateRoot, run, intent, event) {
  const target = recipeConfigReplacementIntentPath(run.runDir, intent.binding.actionAttemptId);
  await ensurePrivateDir(path.dirname(target));
  await atomicWriteJson(stateRoot, target, intent);
  await appendJournal(stateRoot, run.runDir, event, {
    attemptId: intent.binding.actionAttemptId,
    intentDigest: digestObject(intent),
    status: intent.status,
    target: intent.binding.target,
    targetIdentity: intent.targetIdentity ?? null
  });
  return intent;
}

async function readTrust(stateRoot, binding, recipeId) {
  const paths = privateRecipePaths(stateRoot, binding.workspaceDigest, recipeId);
  if (!(await exists(paths.trust))) return { paths, trust: null };
  const trust = await readJson(stateRoot, paths.trust);
  return { paths, trust };
}

async function assertTrusted(stateRoot, recipe, binding) {
  if (recipe.config.enabled !== true) throw recipeError("workspace execution is disabled until the first successful promotion");
  const { paths, trust } = await readTrust(stateRoot, binding, recipe.manifest.id);
  if (!trust) throw recipeError("recipe is untrusted; promote its current digest first");
  if (
    trust.schemaVersion !== TRUST_SCHEMA_VERSION ||
    trust.status !== "trusted" ||
    trust.executionDigest !== binding.executionDigest
  ) {
    throw recipeError("recipe trust is stale because its execution binding drifted");
  }
  const run = await inspectRun(stateRoot, trust.promotion.runId);
  const action = run.actions.find((item) => item.attemptId === trust.promotion.attemptId);
  if (!action || action.action !== "recipe.promote" || action.outcome !== "success") {
    throw recipeError("recipe promotion action is not reconciled successfully");
  }
  return { paths, trust };
}

function runId(prefix = "recipe") {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${prefix}-${timestamp}-${randomBytes(6).toString("hex")}`;
}

async function spawnRecipe(recipe, input, stagingPath, { preserve = false } = {}) {
  await mkdir(stagingPath, { recursive: false, mode: 0o700 });
  await chmod(stagingPath, 0o700);
  const source = await readFile(recipe.entryPath);
  const sourceDigest = sha256(source);
  if (sourceDigest !== recipe.scriptDigest) {
    throw recipeError("recipe source digest changed before execution");
  }
  const request = {
    entryPath: recipe.entryPath,
    scriptDigest: recipe.scriptDigest,
    sourceBase64: source.toString("base64"),
    input,
    workspacePath: recipe.root,
    artifactStagingPath: stagingPath,
    timeoutMs: recipe.manifest.timeoutSeconds * 1000
  };
  const args = [
    "--permission",
    "--no-addons",
    "--no-global-search-paths",
    "--disable-sigusr1",
    "--disallow-code-generation-from-strings",
    "--report-exclude-env",
    `--allow-fs-read=${RUNTIME_PATH}`,
    ...recipe.readTargets.map((target) => `--allow-fs-read=${target}`),
    `--allow-fs-write=${stagingPath}`,
    RUNTIME_PATH
  ];
  const child = spawn(process.execPath, args, {
    cwd: recipe.root,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      NODE_NO_WARNINGS: "1"
    }
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let outputBytes = 0;
  let outputExceeded = false;
  const append = (current, chunk) => {
    outputBytes += chunk.length;
    const next = Buffer.concat([current, chunk]);
    if (outputBytes > recipe.manifest.maxStdoutBytes) {
      outputExceeded = true;
      child.kill("SIGKILL");
      return next.subarray(0, recipe.manifest.maxStdoutBytes);
    }
    return next;
  };
  child.stdout.on("data", (chunk) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = append(stderr, chunk);
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  let killedForTimeout = false;
  const timedOut = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killedForTimeout = true;
      child.kill("SIGKILL");
    }, recipe.manifest.timeoutSeconds * 1000 + 1000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve(killedForTimeout);
    });
  });
  try {
    if (timedOut) throw recipeError("execution timed out");
    if (outputExceeded) throw recipeError("stdout or stderr exceeded maxStdoutBytes");
    let payload;
    try {
      payload = JSON.parse(stdout.toString("utf8"));
    } catch {
      throw recipeError(`runtime returned invalid JSON${stderr.length ? `: ${stderr.toString("utf8").trim()}` : ""}`);
    }
    if (!payload.ok) throw recipeError(`execution failed: ${payload.error ?? "unknown error"}`);
    const validated = await validateRecipeResult(recipe, payload.result, stagingPath);
    return { result: validated.result, artifacts: validated.artifacts, stderr: stderr.toString("utf8") };
  } catch (error) {
    if (!preserve) await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

async function validateRecipeResult(recipe, result, stagingPath) {
  assertObject(result, "recipe result");
  assertKnownKeys(result, ["summary", "evidenceCandidates", "artifacts", "proposals"], "recipe result");
  if (typeof result.summary !== "string" || !result.summary.trim() || result.summary.length > 4096) {
    throw recipeError("result.summary is required and limited to 4096 characters");
  }
  if (!Array.isArray(result.evidenceCandidates) || !Array.isArray(result.artifacts) || !Array.isArray(result.proposals)) {
    throw recipeError("result evidenceCandidates, artifacts, and proposals must be arrays");
  }
  if (result.evidenceCandidates.length > 128 || result.proposals.length > 128) {
    throw recipeError("result candidate or proposal count exceeds 128");
  }
  const declared = new Map(recipe.manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  const seen = new Set();
  const artifactRecords = [];
  let totalBytes = 0;
  for (const item of result.artifacts) {
    assertObject(item, "result.artifacts[]");
    assertKnownKeys(item, ["id"], "result.artifacts[]");
    if (typeof item.id !== "string" || seen.has(item.id) || !declared.has(item.id)) {
      throw recipeError(`result artifact id is unknown or duplicated: ${item.id}`);
    }
    const declaration = declared.get(item.id);
    const target = path.join(stagingPath, declaration.filename);
    const info = await lstat(target).catch((error) => {
      if (error.code === "ENOENT") throw recipeError(`declared artifact is missing: ${declaration.filename}`);
      throw error;
    });
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw recipeError(`artifact must be a regular non-hardlinked file: ${declaration.filename}`);
    }
    const resolved = await realpath(target);
    pathContained(stagingPath, resolved, "artifact");
    if (info.size > declaration.maxBytes) throw recipeError(`artifact exceeds maxBytes: ${declaration.id}`);
    totalBytes += info.size;
    if (totalBytes > recipe.manifest.maxTotalArtifactBytes) {
      throw recipeError("artifacts exceed maxTotalArtifactBytes");
    }
    artifactRecords.push({
      id: declaration.id,
      filename: declaration.filename,
      mediaType: declaration.mediaType,
      bytes: info.size,
      sha256: sha256(await readFile(target)),
      promotable: declaration.promotable
    });
    seen.add(item.id);
  }
  const extras = (await readdir(stagingPath)).filter(
    (name) => !artifactRecords.some((item) => item.filename === name)
  );
  if (extras.length > 0) throw recipeError(`staging contains undeclared outputs: ${extras.join(", ")}`);
  return {
    result: {
      summary: result.summary,
      evidenceCandidates: result.evidenceCandidates,
      artifacts: result.artifacts,
      proposals: result.proposals
    },
    artifacts: artifactRecords
  };
}

function parityDigest(execution) {
  return digestObject({
    result: execution.result,
    artifacts: execution.artifacts.map(({ id, filename, mediaType, bytes, sha256: digest }) => ({
      id,
      filename,
      mediaType,
      bytes,
      sha256: digest
    }))
  });
}

async function readWorkspaceFileRecord(target) {
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw recipeError(`unsafe workspace JSON target: ${target}`);
    }
    const bytes = await handle.readFile();
    return {
      identity: filesystemIdentity(info),
      nlink: info.nlink,
      size: info.size,
      sha256: sha256(bytes)
    };
  } finally {
    await handle.close();
  }
}

async function writeWorkspaceJson(
  root,
  target,
  value,
  { onBoundary = null, replacementBinding = null } = {}
) {
  if (onBoundary !== null && typeof onBoundary !== "function") {
    throw recipeError("workspace JSON boundary hook must be a function");
  }
  pathContained(root, target, "workspace JSON");
  const parentChain = await assertSafeDestination(root, target, new Set(), {
    requireCompleteParent: true
  });
  const parent = path.dirname(target);
  const parentIdentity = parentChain.at(-1)?.identity;
  if (!/^\d+:\d+$/.test(parentIdentity ?? "")) {
    throw recipeError("workspace JSON parent identity is missing");
  }
  const priorTarget = await readWorkspaceFileRecord(target);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const artifact = {
    sha256: sha256(bytes),
    bytes: bytes.length
  };
  const normalizedTarget = path.relative(root, target).split(path.sep).join("/");
  const normalizedParent = path.relative(root, parent).split(path.sep).join("/") || ".";
  let temporaryName = `.sbw-workspace-json-${randomBytes(16).toString("hex")}.tmp`;
  if (replacementBinding) {
    if (
      replacementBinding.kind !== "recipe-config-replacement" ||
      replacementBinding.target !== normalizedTarget ||
      replacementBinding.parent !== normalizedParent ||
      replacementBinding.parentIdentity !== parentIdentity ||
      replacementBinding.targetName !== path.basename(target) ||
      !/^\.sbw-workspace-json-[a-f0-9]{32}\.tmp$/.test(replacementBinding.temporaryName ?? "") ||
      replacementBinding.artifactSha256 !== artifact.sha256 ||
      replacementBinding.artifactBytes !== artifact.bytes ||
      digestObject(replacementBinding.priorTarget ?? null) !== digestObject(priorTarget)
    ) {
      throw recipeError("workspace JSON replacement binding is stale or malformed");
    }
    temporaryName = replacementBinding.temporaryName;
  }
  if (onBoundary) {
    await onBoundary("before-pinned-write", {
      target,
      parent,
      parentIdentity,
      priorTarget,
      temporaryName,
      artifact
    });
  }
  const published = await runPinnedArtifactPublisher({
    mode: "replace",
    parent,
    parentIdentity,
    targetName: path.basename(target),
    temporaryName,
    artifact,
    artifactBytes: bytes,
    targetIdentity: priorTarget?.identity ?? null,
    priorTarget
  });
  if (onBoundary) {
    await onBoundary("after-pinned-write", { target, parent, parentIdentity, priorTarget, receipt: published });
  }
  await assertSafeDestination(root, target, new Set(), {
    expectedParentChain: parentChain,
    requireCompleteParent: true
  });
  const current = await readWorkspaceFileRecord(target);
  if (
    !current || current.identity !== published.target.identity ||
    current.sha256 !== artifact.sha256 || current.size !== artifact.bytes
  ) {
    throw recipeError("workspace JSON changed at the final pinned write boundary");
  }
  return current;
}

export async function recipeInit(cwd) {
  const root = await gitRoot(cwd);
  const paths = workspacePaths(root);
  if (await exists(paths.base)) throw recipeError(`workspace recipe directory already exists: ${paths.base}`);
  await mkdir(paths.recipes, { recursive: true, mode: 0o755 });
  await mkdir(paths.artifacts, { recursive: true, mode: 0o700 });
  await writeWorkspaceJson(root, paths.config, defaultConfig());
  await writeFile(path.join(paths.artifacts, ".gitignore"), "*\n!.gitignore\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  return { ok: true, root, directory: paths.base, enabled: false };
}

async function copyReferenceRecipe(source, target) {
  await mkdir(target, { recursive: false, mode: 0o755 });
  for (const name of ["recipe.json", "run.mjs", "README.md"]) {
    await copyFile(path.join(source, name), path.join(target, name), fsConstants.COPYFILE_EXCL);
  }
  const sourceFixtures = path.join(source, "fixtures");
  if (await exists(sourceFixtures)) {
    const targetFixtures = path.join(target, "fixtures");
    await mkdir(targetFixtures, { mode: 0o755 });
    for (const name of await readdir(sourceFixtures)) {
      await copyFile(path.join(sourceFixtures, name), path.join(targetFixtures, name), fsConstants.COPYFILE_EXCL);
    }
  }
}

export async function recipeScaffold(cwd, id) {
  if (!SAFE_RECIPE_ID.test(String(id))) throw recipeError("recipe id must be safe kebab-case");
  const workspace = await loadWorkspace(cwd);
  const target = path.join(workspace.paths.recipes, String(id));
  if (await exists(target)) throw recipeError(`recipe already exists: ${id}`);
  const reference = path.join(REFERENCE_ROOT, String(id));
  if (await exists(reference)) {
    await copyReferenceRecipe(reference, target);
  } else {
    await mkdir(path.join(target, "fixtures"), { recursive: true, mode: 0o755 });
    await writeWorkspaceJson(workspace.root, path.join(target, "recipe.json"), {
      schemaVersion: 1,
      id: String(id),
      version: "0.1.0",
      description: "Describe this repeatable, read-only SOP.",
      entry: "run.mjs",
      readPaths: [],
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      },
      artifacts: [
        {
          id: "report",
          filename: "report.json",
          mediaType: "application/json",
          maxBytes: 1048576,
          promotable: true
        }
      ],
      timeoutSeconds: 60,
      maxStdoutBytes: 1048576,
      maxTotalArtifactBytes: 1048576
    });
    await writeFile(
      path.join(target, "run.mjs"),
      `import { writeFile } from "node:fs/promises";\nimport path from "node:path";\n\nexport default async function run(context) {\n  const report = { input: context.input };\n  await writeFile(path.join(context.artifactStagingPath, "report.json"), JSON.stringify(report, null, 2) + "\\n");\n  return {\n    summary: "Generated report.json",\n    evidenceCandidates: [],\n    artifacts: [{ id: "report" }],\n    proposals: []\n  };\n}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o644 }
    );
    await writeFile(
      path.join(target, "README.md"),
      `# ${id}\n\nA governed Better Workflows workspace recipe. Validate and review it before promotion.\n`,
      { encoding: "utf8", flag: "wx", mode: 0o644 }
    );
    await writeWorkspaceJson(workspace.root, path.join(target, "fixtures", "input.json"), {});
  }
  return { ok: true, id: String(id), directory: target, reference: await exists(reference) };
}

export async function recipeList(cwd) {
  const workspace = await loadWorkspace(cwd);
  const entries = await readdir(workspace.paths.recipes, { withFileTypes: true });
  const recipes = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !SAFE_RECIPE_ID.test(entry.name)) continue;
    try {
      const recipe = await loadRecipe(workspace.root, entry.name);
      const binding = await executionBinding(recipe);
      const { trust } = await readTrust(getStateRoot(), binding, entry.name);
      recipes.push({
        id: entry.name,
        version: recipe.manifest.version,
        valid: true,
        trusted: trust?.status === "trusted" && trust?.executionDigest === binding.executionDigest,
        executionDigest: binding.executionDigest
      });
    } catch (error) {
      recipes.push({ id: entry.name, valid: false, trusted: false, error: error.message });
    }
  }
  return { ok: true, root: workspace.root, enabled: workspace.config.enabled, recipes };
}

export async function recipeValidate(cwd, id) {
  const recipe = await loadRecipe(cwd, id);
  const binding = await executionBinding(recipe);
  return {
    ok: true,
    id: recipe.manifest.id,
    version: recipe.manifest.version,
    executionDigest: binding.executionDigest,
    bindings: binding
  };
}

async function fixtureInput(recipe) {
  const target = path.join(recipe.directory, "fixtures", "input.json");
  if (!(await exists(target))) throw recipeError("promotion requires fixtures/input.json");
  const relative = path.relative(recipe.root, target).split(path.sep).join("/");
  await assertSafeExistingPath(recipe.root, relative, "fixtures/input.json", { file: true });
  return validateInputValue(recipe.manifest.inputSchema, JSON.parse(await readFile(target, "utf8")), recipe.root);
}

async function loadRecipeConfigRecoveryIntent(stateRoot, runIdValue, attemptId, recipe) {
  const run = await inspectRun(stateRoot, runIdValue);
  const action = run.actions.find((item) => item.attemptId === attemptId);
  if (!action) return null;
  const intentPath = recipeConfigReplacementIntentPath(run.runDir, attemptId);
  if (!(await exists(intentPath))) return null;
  const intent = await readJson(stateRoot, intentPath);
  const target = recipe.paths.config;
  const parent = path.dirname(target);
  const parentChain = await assertSafeDestination(recipe.root, target, new Set(), {
    requireCompleteParent: true
  });
  const parentIdentity = parentChain.at(-1)?.identity;
  if (!/^\d+:\d+$/.test(parentIdentity ?? "")) {
    throw recipeError("recipe config replacement parent identity is missing");
  }
  const normalizedTarget = path.relative(recipe.root, target).split(path.sep).join("/");
  const normalizedParent = path.relative(recipe.root, parent).split(path.sep).join("/") || ".";
  const beforeConfig = { ...structuredClone(recipe.config), enabled: false };
  const afterConfig = { ...beforeConfig, enabled: true };
  const beforeBytes = Buffer.from(`${JSON.stringify(beforeConfig, null, 2)}\n`, "utf8");
  const afterBytes = Buffer.from(`${JSON.stringify(afterConfig, null, 2)}\n`, "utf8");
  const artifact = { sha256: sha256(afterBytes), bytes: afterBytes.length };
  const priorTarget = {
    identity: intent.binding?.priorTarget?.identity,
    nlink: 1,
    size: beforeBytes.length,
    sha256: sha256(beforeBytes)
  };
  const expected = {
    runIdValue,
    action,
    target: normalizedTarget,
    parent: normalizedParent,
    parentIdentity,
    targetName: path.basename(target),
    artifact,
    priorTarget,
    publisherDigest: sha256(await readFile(ARTIFACT_PUBLISHER_PATH))
  };
  validateRecipeConfigReplacementIntent(intent, expected);
  const currentTarget = await readWorkspaceFileRecord(target);
  if (recipe.config.enabled === true) {
    if (
      !currentTarget || currentTarget.sha256 !== artifact.sha256 ||
      currentTarget.size !== artifact.bytes ||
      (intent.status === "published" && currentTarget.identity !== intent.targetIdentity)
    ) {
      throw recipeError("recipe config replacement target is not replay-valid");
    }
  } else if (digestObject(currentTarget) !== digestObject(priorTarget)) {
    throw recipeError("recipe config replacement prior target changed");
  }
  const temporaryPath = path.join(parent, intent.binding.temporaryName);
  const temporary = await readWorkspaceFileRecord(temporaryPath);
  if (
    temporary &&
    (temporary.sha256 !== artifact.sha256 || temporary.size !== artifact.bytes || temporary.nlink !== 1)
  ) {
    throw recipeError("recipe config replacement temporary is not replay-valid");
  }
  if (recipe.config.enabled === true && temporary) {
    throw recipeError("published recipe config retained an unexpected temporary file");
  }
  if (intent.status === "published" && recipe.config.enabled !== true) {
    throw recipeError("published recipe config intent lost its target");
  }
  const temporaryRelative = normalizedParent === "."
    ? intent.binding.temporaryName
    : `${normalizedParent}/${intent.binding.temporaryName}`;
  return {
    run,
    action,
    intent,
    intentPath,
    expected,
    beforeConfig,
    afterConfig,
    afterBytes,
    parentChain,
    allowedPaths: [normalizedTarget, temporaryRelative]
  };
}

async function assertPromotionRun(
  stateRoot,
  runIdValue,
  attemptId,
  recipe,
  binding,
  { recoveryPaths = [] } = {}
) {
  const run = await inspectRun(stateRoot, runIdValue);
  if (run.manifest.template !== "workspace-recipe") {
    throw recipeError("promotion run must use the workspace-recipe template");
  }
  if (await realpath(run.manifest.cwd) !== recipe.root) {
    throw recipeError("promotion run belongs to a different workspace");
  }
  const action = run.actions.find((item) => item.attemptId === attemptId);
  const resource = `recipe:${recipe.manifest.id}:${binding.executionDigest}`;
  if (
    !action ||
    action.action !== "recipe.promote" ||
    action.resource !== resource ||
    action.status !== "spent" ||
    !["pending", "success"].includes(action.outcome)
  ) {
    throw recipeError(`promotion requires one resumable recipe.promote attempt bound to ${resource}`);
  }
  const defaults = await loadDefaults();
  const baselineSentinel = await issuedSourceSentinel(stateRoot, run, action);
  const sentinel = await captureSentinel(run.manifest.cwd, run.contract, defaults);
  if (!sentinel.complete) {
    throw recipeError("promotion action tree binding is stale or incomplete");
  }
  if (sentinel.digest !== action.treeDigest && recipe.config.enabled !== true) {
    if (!Array.isArray(recoveryPaths) || recoveryPaths.length === 0) {
      throw recipeError("promotion action tree binding is stale or incomplete");
    }
    assertExpectedSourceRecovery(
      baselineSentinel,
      sentinel,
      recoveryPaths,
      "recipe config intent recovery"
    );
  }
  if (run.findings.some((item) => ["P0", "P1"].includes(item.severity) && item.status === "open")) {
    throw recipeError("promotion is blocked by an open P0/P1 finding");
  }
  if (run.contract.schemaVersion === 2) {
    const completion = await evaluateCompletion(stateRoot, runIdValue);
    const preActionBlockers = completion.blockers.filter((blocker) => (
      blocker !== "ledger:not-complete" && blocker !== "side-effect-not-reconciled"
    ));
    if (preActionBlockers.length > 0) {
      throw recipeError(`promotion run is incomplete: ${preActionBlockers.join(", ")}`);
    }
    return { run, action, baselineSentinel, currentSentinel: sentinel };
  }
  const completeEvidence = run.evidence.filter((item) => item.status === "complete" && !item.stale);
  const kinds = new Set(completeEvidence.map((item) => item.kind));
  const covered = new Set(completeEvidence.flatMap((item) => item.acceptanceIds));
  const missingKinds = run.contract.requiredEvidence.filter((kind) => !kinds.has(kind));
  const missingAcceptance = run.contract.acceptance.map((item) => item.id).filter((id) => !covered.has(id));
  if (missingKinds.length || missingAcceptance.length) {
    throw recipeError(
      `promotion run evidence is incomplete: ${[...missingKinds, ...missingAcceptance].join(", ")}`
    );
  }
  return { run, action, baselineSentinel, currentSentinel: sentinel };
}

async function currentLocalActionAttempt(stateRoot, run, expected, context) {
  const current = await readJson(
    stateRoot,
    safeJoin(run.runDir, "actions", `${expected.tokenHash}.json`)
  );
  if (
    current.status !== "spent" || current.attemptId !== expected.attemptId ||
    current.tokenHash !== expected.tokenHash || current.action !== expected.action ||
    current.provider !== expected.provider || current.resource !== expected.resource ||
    current.idempotencyKey !== expected.idempotencyKey ||
    current.remoteRevision !== expected.remoteRevision ||
    current.treeDigest !== expected.treeDigest ||
    current.evidenceGateDigest !== expected.evidenceGateDigest ||
    current.evidenceSupersessionFreshnessDigest !== expected.evidenceSupersessionFreshnessDigest ||
    !["pending", "success"].includes(current.outcome)
  ) {
    throw recipeError(`${context} is not bound to the consumed local provider action attempt`);
  }
  return current;
}

export async function recipePromote(cwd, id, options) {
  if (!options.run || !options.attempt || !options.confirmDigest) {
    throw recipeError("promote requires --run, --attempt, and --confirm-digest");
  }
  const onProviderBoundary = options.onProviderBoundary ?? null;
  if (onProviderBoundary !== null && typeof onProviderBoundary !== "function") {
    throw recipeError("recipe provider boundary hook must be a function");
  }
  const recipe = await loadRecipe(cwd, id);
  const binding = await executionBinding(recipe);
  if (!SHA256.test(options.confirmDigest) || options.confirmDigest !== binding.executionDigest) {
    throw recipeError(`confirmed digest does not match ${binding.executionDigest}`);
  }
  const stateRoot = getStateRoot();
  const configRecovery = await loadRecipeConfigRecoveryIntent(
    stateRoot,
    options.run,
    options.attempt,
    recipe
  );
  const promotion = await assertPromotionRun(
    stateRoot,
    options.run,
    options.attempt,
    recipe,
    binding,
    { recoveryPaths: configRecovery?.allowedPaths ?? [] }
  );
  const priorTrust = await readTrust(stateRoot, binding, recipe.manifest.id);
  if (
    priorTrust.trust &&
    priorTrust.trust.executionDigest !== binding.executionDigest &&
    priorTrust.trust.recipeVersion === recipe.manifest.version
  ) {
    throw recipeError("recipe content drift requires a version bump before re-promotion");
  }
  const input = await fixtureInput(recipe);
  const stagingOne = path.join(recipe.paths.artifacts, `.candidate-${runId("attempt")}`);
  const stagingTwo = path.join(recipe.paths.artifacts, `.candidate-${runId("attempt")}`);
  let first;
  let second;
  try {
    first = await spawnRecipe(recipe, input, stagingOne);
    second = await spawnRecipe(recipe, input, stagingTwo);
  } finally {
    await rm(stagingOne, { recursive: true, force: true });
    await rm(stagingTwo, { recursive: true, force: true });
  }
  const firstDigest = parityDigest(first);
  const secondDigest = parityDigest(second);
  if (firstDigest !== secondDigest) {
    throw recipeError("candidate dry-run parity failed");
  }
  const expectedPath = path.join(recipe.directory, "fixtures", "expected.json");
  if (await exists(expectedPath)) {
    await assertSafeExistingPath(
      recipe.root,
      path.relative(recipe.root, expectedPath).split(path.sep).join("/"),
      "fixtures/expected.json",
      { file: true }
    );
    const expected = JSON.parse(await readFile(expectedPath, "utf8"));
    if (digestObject(expected) !== firstDigest) {
      throw recipeError("fixture expected report does not match candidate output");
    }
  }
  const paths = privateRecipePaths(stateRoot, binding.workspaceDigest, recipe.manifest.id);
  const promotedAt = promotion.action.spentAt;
  const trust = {
    schemaVersion: TRUST_SCHEMA_VERSION,
    status: "trusted",
    recipeId: recipe.manifest.id,
    recipeVersion: recipe.manifest.version,
    promotedAt,
    executionDigest: binding.executionDigest,
    bindings: binding,
    fixtureParityDigest: firstDigest,
    promotion: {
      runId: options.run,
      attemptId: options.attempt,
      treeDigest: promotion.action.treeDigest
    }
  };
  const beforeConfig = { ...structuredClone(recipe.config), enabled: false };
  if (promotion.action.outcome === "success") {
    const completedTrust = await readTrust(stateRoot, binding, recipe.manifest.id);
    const completedConfig = validateConfig(JSON.parse(await readFile(recipe.paths.config, "utf8")));
    const completedReceipt = promotion.action.receipt?.providerReceipt;
    if (
      completedConfig.enabled !== true ||
      digestObject(completedTrust.trust ?? null) !== digestObject(trust) ||
      completedReceipt?.action !== "recipe.promote" ||
      completedReceipt?.attemptId !== promotion.action.attemptId ||
      completedReceipt?.sourceMutation?.path !== ".codex/better-workflows/config.json"
    ) {
      throw recipeError("completed recipe promotion is not replay-valid");
    }
    return {
      ok: true,
      id: recipe.manifest.id,
      executionDigest: binding.executionDigest,
      fixtureParityDigest: firstDigest,
      trusted: true
    };
  }
  if (onProviderBoundary) await onProviderBoundary("before-authority-replay");
  let afterConfig;
  await withRunLock(stateRoot, options.run, async () => {
    const run = await loadRun(stateRoot, options.run);
    assertMutableRun(run, "Recipe promotion provider invocation");
    const action = await currentLocalActionAttempt(
      stateRoot,
      run,
      promotion.action,
      "Recipe promotion provider invocation"
    );
    const liveConfig = validateConfig(JSON.parse(await readFile(recipe.paths.config, "utf8")));
    const intentPath = recipeConfigReplacementIntentPath(run.runDir, action.attemptId);
    let intent = await exists(intentPath) ? await readJson(stateRoot, intentPath) : null;
    let context = configRecovery;
    if (intent) {
      if (!context || digestObject(intent) !== digestObject(context.intent)) {
        throw recipeError("recipe config replacement intent changed after preflight");
      }
      const currentSentinel = await captureSentinel(recipe.root, run.contract, await loadDefaults());
      if (currentSentinel.digest === action.treeDigest) {
        await assertSpentActionProviderAuthority(
          stateRoot,
          options.run,
          run,
          action,
          "Recipe promotion provider recovery"
        );
      } else {
        await assertSpentActionNonSourceAuthority(
          stateRoot,
          options.run,
          run,
          action,
          "Recipe promotion provider recovery"
        );
        assertExpectedSourceRecovery(
          promotion.baselineSentinel,
          currentSentinel,
          context.allowedPaths,
          "recipe promotion recovery"
        );
      }
    } else {
      if (context || liveConfig.enabled === true) {
        throw recipeError("recipe config source mutation is missing its durable replacement intent");
      }
      await assertSpentActionProviderAuthority(
        stateRoot,
        options.run,
        run,
        action,
        "Recipe promotion provider invocation"
      );
      const currentSentinel = await captureSentinel(recipe.root, run.contract, await loadDefaults());
      if (currentSentinel.digest !== action.treeDigest) {
        throw recipeError("recipe promotion source changed before config replacement intent creation");
      }
      const target = recipe.paths.config;
      const parent = path.dirname(target);
      const parentChain = await assertSafeDestination(recipe.root, target, new Set(), {
        requireCompleteParent: true
      });
      const parentIdentity = parentChain.at(-1)?.identity;
      if (!/^\d+:\d+$/.test(parentIdentity ?? "")) {
        throw recipeError("recipe config replacement parent identity is missing");
      }
      const normalizedTarget = path.relative(recipe.root, target).split(path.sep).join("/");
      const normalizedParent = path.relative(recipe.root, parent).split(path.sep).join("/") || ".";
      const replacementBefore = { ...structuredClone(liveConfig), enabled: false };
      const replacementAfter = { ...replacementBefore, enabled: true };
      const artifactBytes = Buffer.from(`${JSON.stringify(replacementAfter, null, 2)}\n`, "utf8");
      const artifact = { sha256: sha256(artifactBytes), bytes: artifactBytes.length };
      const priorTarget = await readWorkspaceFileRecord(target);
      if (!priorTarget) throw recipeError("recipe config replacement prior target is missing");
      const expected = {
        runIdValue: options.run,
        action,
        target: normalizedTarget,
        parent: normalizedParent,
        parentIdentity,
        targetName: path.basename(target),
        artifact,
        priorTarget,
        publisherDigest: sha256(await readFile(ARTIFACT_PUBLISHER_PATH))
      };
      const replacementBinding = recipeConfigReplacementBinding(expected);
      intent = await writeRecipeConfigReplacementIntent(stateRoot, run, {
        schemaVersion: 1,
        kind: "recipe-config-replacement",
        binding: replacementBinding,
        bindingDigest: digestObject(replacementBinding),
        status: "prepared",
        targetIdentity: null,
        preparedAt: nowIso(),
        updatedAt: nowIso()
      }, "action.local-provider-config-intent-prepared");
      const temporaryRelative = normalizedParent === "."
        ? replacementBinding.temporaryName
        : `${normalizedParent}/${replacementBinding.temporaryName}`;
      context = {
        intent,
        expected,
        beforeConfig: replacementBefore,
        afterConfig: replacementAfter,
        afterBytes: artifactBytes,
        parentChain,
        allowedPaths: [normalizedTarget, temporaryRelative]
      };
      if (onProviderBoundary) {
        await onProviderBoundary("config-intent-prepared", {
          intent,
          target,
          parent,
          artifact,
          artifactBytes
        });
      }
    }
    await ensurePrivateDir(paths.root);
    await atomicWriteJson(stateRoot, paths.trust, trust);
    if (liveConfig.enabled !== true) {
      await writeWorkspaceJson(
        recipe.root,
        recipe.paths.config,
        { ...liveConfig, enabled: true },
        {
          replacementBinding: intent.binding,
          onBoundary: onProviderBoundary
            ? async (boundary, details) => onProviderBoundary(`config-${boundary}`, details)
            : null
        }
      );
    }
    const currentTarget = await readWorkspaceFileRecord(recipe.paths.config);
    if (
      !currentTarget || currentTarget.sha256 !== intent.binding.artifactSha256 ||
      currentTarget.size !== intent.binding.artifactBytes
    ) {
      throw recipeError("recipe config replacement target is not durable");
    }
    if (intent.status !== "published") {
      intent = await writeRecipeConfigReplacementIntent(stateRoot, run, {
        ...intent,
        status: "published",
        targetIdentity: currentTarget.identity,
        publishedAt: nowIso(),
        updatedAt: nowIso()
      }, "action.local-provider-config-intent-published");
    } else if (intent.targetIdentity !== currentTarget.identity) {
      throw recipeError("recipe config replacement target identity changed during replay");
    }
    afterConfig = validateConfig(JSON.parse(await readFile(recipe.paths.config, "utf8")));
  }, { ttlMs: 300_000 });
  const afterSentinel = await captureSentinel(recipe.root, promotion.run.contract, await loadDefaults());
  const beforeSourceBinding = promotion.action.sourceAuthorityAtIssue?.sourceBinding;
  if (!beforeSourceBinding) throw recipeError("promotion action source binding is missing");
  const afterSourceBinding = await captureSourceBinding(recipe.root, {
    baseRevision: beforeSourceBinding.baseRevision,
    requireClean: false
  });
  if (![beforeSourceBinding.digest, afterSourceBinding?.digest].includes(promotion.run.manifest.sourceBinding?.digest)) {
    throw recipeError("promotion run source binding is unrelated to the action transition");
  }
  const sourceMutation = providerActionSourceMutation({
    action: promotion.action,
    relativePath: ".codex/better-workflows/config.json",
    beforeSentinel: promotion.baselineSentinel,
    afterSentinel,
    beforeSourceBinding,
    afterSourceBinding,
    recipeConfig: { before: beforeConfig, after: afterConfig }
  });
  const providerReceipt = {
    provider: "local-workspace",
    action: "recipe.promote",
    resource: `recipe:${recipe.manifest.id}:${binding.executionDigest}`,
    outcome: "success",
    runId: promotion.action.runId,
    attemptId: promotion.action.attemptId,
    idempotencyKey: promotion.action.idempotencyKey,
    remoteRevision: promotion.action.remoteRevision,
    executionId: `local-workspace:recipe.promote:${promotion.action.attemptId}`,
    proofKind: "local-workspace:recipe.promote",
    requestDigest: sha256(canonicalJson({ action: promotion.action.action, provider: promotion.action.provider, resource: promotion.action.resource, remoteRevision: promotion.action.remoteRevision, idempotencyKey: promotion.action.idempotencyKey })),
    responseDigest: sha256(canonicalJson({
      kind: "workspace-recipe",
      digest: sha256(canonicalJson(trust)),
      ...(sourceMutation ? { sourceMutationDigest: digestObject(sourceMutation) } : {})
    })),
    verifiedAt: promotedAt,
    terminalState: "success",
    kind: "workspace-recipe",
    digest: sha256(canonicalJson(trust)),
    ...(sourceMutation ? { sourceMutation } : {})
  };
  const actionEvidence = await addActionEvidence(stateRoot, promotion.action, providerReceipt);
  await reconcileAction(
    stateRoot,
    options.run,
    options.attempt,
    "success",
    {
      action: "recipe.promote",
      provider: "local-workspace",
      resource: `recipe:${recipe.manifest.id}:${binding.executionDigest}`,
      outcome: "success",
      runId: promotion.action.runId,
      attemptId: promotion.action.attemptId,
      idempotencyKey: promotion.action.idempotencyKey,
      remoteRevision: promotion.action.remoteRevision,
      providerReceipt,
      evidenceIds: [actionEvidence.id]
    }
  );
  return {
    ok: true,
    id: recipe.manifest.id,
    executionDigest: binding.executionDigest,
    fixtureParityDigest: firstDigest,
    trusted: true
  };
}

export async function recipeRun(cwd, id, inputFile, { dryRun = false } = {}) {
  if (!inputFile) throw recipeError("run requires --input-file <json>");
  const recipe = await loadRecipe(cwd, id);
  const binding = await executionBinding(recipe);
  const stateRoot = getStateRoot();
  await assertTrusted(stateRoot, recipe, binding);
  const inputPath = path.resolve(cwd, inputFile);
  const input = validateInputValue(
    recipe.manifest.inputSchema,
    JSON.parse(await readFile(inputPath, "utf8")),
    recipe.root
  );
  const receiptId = runId();
  const startedAt = nowIso();
  const staging = path.join(recipe.paths.artifacts, `.staging-${receiptId}`);
  const execution = await spawnRecipe(recipe, input, staging);
  let artifactDirectory = null;
  if (dryRun) {
    await rm(staging, { recursive: true, force: true });
  } else {
    const currentBytes = await workspaceArtifactBytes(recipe.paths.artifacts);
    const newBytes = execution.artifacts.reduce((sum, item) => sum + item.bytes, 0);
    if (currentBytes + newBytes > recipe.config.workspaceArtifactCapBytes) {
      await rm(staging, { recursive: true, force: true });
      throw recipeError("workspace artifact cap would be exceeded");
    }
    artifactDirectory = path.join(recipe.paths.artifacts, receiptId);
    if (await exists(artifactDirectory)) throw recipeError(`artifact receipt already exists: ${receiptId}`);
    await rename(staging, artifactDirectory);
  }
  const privatePaths = privateRecipePaths(stateRoot, binding.workspaceDigest, recipe.manifest.id);
  await ensurePrivateDir(privatePaths.receipts);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptId,
    recipeId: recipe.manifest.id,
    recipeVersion: recipe.manifest.version,
    executionDigest: binding.executionDigest,
    startedAt,
    completedAt: nowIso(),
    dryRun,
    status: "complete",
    resultDigest: digestObject(execution.result),
    summaryDigest: sha256(execution.result.summary),
    artifactDirectory: dryRun ? null : path.relative(recipe.root, artifactDirectory).split(path.sep).join("/"),
    artifacts: execution.artifacts.map(({ id: artifactId, filename, mediaType, bytes, sha256: digest }) => ({
      id: artifactId,
      filename,
      mediaType,
      bytes,
      sha256: digest
    })),
    evidenceCandidateDigests: execution.result.evidenceCandidates.map((item) => digestObject(item)),
    proposalDigests: execution.result.proposals.map((item) => digestObject(item)),
    reconciliation: dryRun ? "discarded" : "published"
  };
  await atomicWriteJson(stateRoot, path.join(privatePaths.receipts, `${receiptId}.json`), receipt);
  return {
    ok: true,
    receiptId,
    dryRun,
    summary: execution.result.summary,
    evidenceCandidates: execution.result.evidenceCandidates,
    proposals: execution.result.proposals,
    artifacts: receipt.artifacts,
    artifactDirectory: receipt.artifactDirectory
  };
}

export async function recipeStatus(cwd, id) {
  const recipe = await loadRecipe(cwd, id);
  const binding = await executionBinding(recipe);
  const stateRoot = getStateRoot();
  const { paths, trust } = await readTrust(stateRoot, binding, recipe.manifest.id);
  const receipts = await listJsonRecords(stateRoot, paths.receipts);
  return {
    ok: true,
    id: recipe.manifest.id,
    version: recipe.manifest.version,
    enabled: recipe.config.enabled,
    executionDigest: binding.executionDigest,
    trusted: trust?.status === "trusted" && trust?.executionDigest === binding.executionDigest,
    trustDrifted: Boolean(trust && trust.executionDigest !== binding.executionDigest),
    promotedAt: trust?.promotedAt ?? null,
    receiptCount: receipts.length,
    lastReceipt: receipts.at(-1) ?? null
  };
}

export async function recipeUntrust(cwd, id) {
  const recipe = await loadRecipe(cwd, id);
  const binding = await executionBinding(recipe);
  const stateRoot = getStateRoot();
  const paths = privateRecipePaths(stateRoot, binding.workspaceDigest, recipe.manifest.id);
  if (!(await exists(paths.trust))) return { ok: true, id, removed: false };
  const trust = await readJson(stateRoot, paths.trust);
  await atomicWriteJson(stateRoot, paths.trust, {
    ...trust,
    status: "untrusted",
    untrustedAt: nowIso()
  });
  return { ok: true, id, removed: true };
}

async function findReceipt(stateRoot, receiptId, workspaceDigest) {
  if (!RECEIPT_ID.test(receiptId)) throw recipeError("invalid receipt id");
  if (!SHA256.test(workspaceDigest)) throw recipeError("invalid workspace digest");
  const workspaceRoot = safeJoin(stateRoot, "workspaces", workspaceDigest);
  if (!(await exists(workspaceRoot))) throw recipeError(`unknown receipt: ${receiptId}`);
  const matches = [];
  const recipesRoot = safeJoin(workspaceRoot, "recipes");
  if (!(await exists(recipesRoot))) throw recipeError(`unknown receipt: ${receiptId}`);
  for (const recipeEntry of await readdir(recipesRoot, { withFileTypes: true })) {
    if (!recipeEntry.isDirectory() || !SAFE_RECIPE_ID.test(recipeEntry.name)) continue;
    const target = safeJoin(recipesRoot, recipeEntry.name, "receipts", `${receiptId}.json`);
    if (await exists(target)) matches.push({ target, receipt: await readJson(stateRoot, target) });
  }
  if (matches.length !== 1) throw recipeError(`receipt lookup expected one match, found ${matches.length}`);
  return matches[0].receipt;
}

async function findArtifactAction(stateRoot, resource) {
  const runsRoot = safeJoin(stateRoot, "runs");
  const matches = [];
  for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("sbw-")) continue;
    const run = await inspectRun(stateRoot, entry.name).catch(() => null);
    if (!run) continue;
    for (const action of run.actions) {
      if (
        action.action === "artifact.promote" &&
        action.resource === resource &&
        action.status === "spent" &&
        ["pending", "success"].includes(action.outcome)
      ) {
        matches.push({ runId: entry.name, action });
      }
    }
  }
  if (matches.length !== 1) {
    throw recipeError(`artifact promotion requires one resumable action attempt; found ${matches.length}`);
  }
  return matches[0];
}

async function runPinnedArtifactPublisher({
  mode,
  parent,
  parentIdentity,
  targetName,
  temporaryName,
  artifact,
  artifactBytes,
  targetIdentity = null,
  priorTarget = null
}) {
  const args = [
    ARTIFACT_PUBLISHER_PATH,
    mode,
    parentIdentity,
    targetName,
    temporaryName,
    artifact.sha256,
    String(artifact.bytes),
    targetIdentity ?? "-",
    priorTarget?.sha256 ?? "-",
    priorTarget ? String(priorTarget.size) : "-"
  ];
  const child = spawn(process.execPath, args, {
    cwd: parent,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      NODE_NO_WARNINGS: "1"
    }
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let outputExceeded = false;
  const append = (current, chunk) => {
    const next = Buffer.concat([current, chunk]);
    if (next.length > 64 * 1024) {
      outputExceeded = true;
      child.kill("SIGKILL");
      return next.subarray(0, 64 * 1024);
    }
    return next;
  };
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  child.stdin.on("error", () => undefined);
  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(recipeError("pinned artifact publisher timed out"));
    }, 300_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  child.stdin.end(["link", "replace"].includes(mode) ? artifactBytes : undefined);
  const result = await completion;
  if (outputExceeded) throw recipeError("pinned artifact publisher output exceeded 64 KiB");
  if (result.code !== 0 || result.signal) {
    throw recipeError(
      `pinned artifact publisher failed${stderr.length ? `: ${stderr.toString("utf8").trim()}` : ""}`
    );
  }
  let payload;
  try {
    payload = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw recipeError("pinned artifact publisher returned invalid JSON");
  }
  if (
    payload?.ok !== true || payload.parentIdentity !== parentIdentity ||
    payload.target?.sha256 !== artifact.sha256 || payload.target?.size !== artifact.bytes ||
    !/^\d+:\d+$/.test(payload.target?.identity ?? "")
  ) {
    throw recipeError("pinned artifact publisher receipt is not bound to the requested artifact");
  }
  return payload;
}

async function runPinnedDestinationParentCreator({ parent, parentIdentity, component }) {
  const args = [
    ARTIFACT_PUBLISHER_PATH,
    "mkdir",
    parentIdentity,
    component
  ];
  const child = spawn(process.execPath, args, {
    cwd: parent,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      NODE_NO_WARNINGS: "1"
    }
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let outputExceeded = false;
  const append = (current, chunk) => {
    const next = Buffer.concat([current, chunk]);
    if (next.length > 64 * 1024) {
      outputExceeded = true;
      child.kill("SIGKILL");
      return next.subarray(0, 64 * 1024);
    }
    return next;
  };
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(recipeError("pinned destination parent creator timed out"));
    }, 300_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  if (outputExceeded) throw recipeError("pinned destination parent creator output exceeded 64 KiB");
  if (result.code !== 0 || result.signal) {
    throw recipeError(
      `pinned destination parent creator failed${stderr.length ? `: ${stderr.toString("utf8").trim()}` : ""}`
    );
  }
  let payload;
  try {
    payload = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw recipeError("pinned destination parent creator returned invalid JSON");
  }
  if (
    payload?.ok !== true || payload.parentIdentity !== parentIdentity ||
    payload.state !== "directory-ready" || !/^\d+:\d+$/.test(payload.child?.identity ?? "")
  ) {
    throw recipeError("pinned destination parent receipt is not bound to the requested component");
  }
  return payload;
}

function artifactPublicationIntentPath(runDir, action) {
  if (!SAFE_SENTINEL_LABEL.test(action.attemptId ?? "")) {
    throw recipeError("artifact publication attempt identity is unsafe");
  }
  return safeJoin(runDir, "local-provider-intents", `${action.attemptId}.json`);
}

function artifactPublicationBinding({
  runIdValue,
  action,
  normalized,
  parentRelative,
  parentIdentity,
  targetName,
  temporaryName,
  artifact,
  publisherDigest
}) {
  return {
    schemaVersion: 1,
    kind: "artifact-publication",
    runId: runIdValue,
    actionAttemptId: action.attemptId,
    tokenHash: action.tokenHash,
    action: action.action,
    provider: action.provider,
    resource: action.resource,
    idempotencyKey: action.idempotencyKey,
    remoteRevision: action.remoteRevision,
    treeDigest: action.treeDigest,
    evidenceGateDigest: action.evidenceGateDigest,
    evidenceSupersessionFreshnessDigest: action.evidenceSupersessionFreshnessDigest,
    target: normalized,
    parent: parentRelative,
    parentIdentity,
    targetName,
    temporaryName,
    artifactSha256: artifact.sha256,
    artifactBytes: artifact.bytes,
    publisherDigest
  };
}

function validateArtifactPublicationIntent(intent, expected) {
  if (
    !intent || intent.schemaVersion !== 1 || intent.kind !== "artifact-publication" ||
    !["prepared", "linked", "published"].includes(intent.status) ||
    digestObject(intent.binding ?? null) !== intent.bindingDigest ||
    intent.binding.runId !== expected.runIdValue ||
    intent.binding.actionAttemptId !== expected.action.attemptId ||
    intent.binding.tokenHash !== expected.action.tokenHash ||
    intent.binding.action !== expected.action.action ||
    intent.binding.provider !== expected.action.provider ||
    intent.binding.resource !== expected.action.resource ||
    intent.binding.idempotencyKey !== expected.action.idempotencyKey ||
    intent.binding.remoteRevision !== expected.action.remoteRevision ||
    intent.binding.treeDigest !== expected.action.treeDigest ||
    intent.binding.evidenceGateDigest !== expected.action.evidenceGateDigest ||
    intent.binding.evidenceSupersessionFreshnessDigest !== expected.action.evidenceSupersessionFreshnessDigest ||
    intent.binding.target !== expected.normalized ||
    intent.binding.parent !== expected.parentRelative ||
    intent.binding.parentIdentity !== expected.parentIdentity ||
    intent.binding.targetName !== expected.targetName ||
    !/^\.sbw-artifact-[a-f0-9]{32}\.tmp$/.test(intent.binding.temporaryName ?? "") ||
    intent.binding.artifactSha256 !== expected.artifact.sha256 ||
    intent.binding.artifactBytes !== expected.artifact.bytes ||
    intent.binding.publisherDigest !== expected.publisherDigest ||
    (["linked", "published"].includes(intent.status) && !/^\d+:\d+$/.test(intent.targetIdentity ?? ""))
  ) {
    throw recipeError("artifact publication intent is stale or malformed");
  }
  return intent;
}

async function writeArtifactPublicationIntent(stateRoot, run, intent, event) {
  const target = artifactPublicationIntentPath(run.runDir, { attemptId: intent.binding.actionAttemptId });
  await ensurePrivateDir(path.dirname(target));
  await atomicWriteJson(stateRoot, target, intent);
  await appendJournal(stateRoot, run.runDir, event, {
    attemptId: intent.binding.actionAttemptId,
    intentDigest: digestObject(intent),
    status: intent.status,
    target: intent.binding.target,
    targetIdentity: intent.targetIdentity ?? null
  });
  return intent;
}

async function publishArtifactWithIntent({
  stateRoot,
  pending,
  baselineSentinel,
  workspace,
  target,
  normalized,
  parentChain,
  protectedIdentities,
  artifact,
  artifactBytes,
  onDestinationBoundary
}) {
  return withRunLock(stateRoot, pending.runId, async () => {
    const run = await loadRun(stateRoot, pending.runId);
    assertMutableRun(run, "Artifact promotion provider invocation");
    const action = await currentLocalActionAttempt(
      stateRoot,
      run,
      pending.action,
      "Artifact promotion provider invocation"
    );
    let checkedParentChain = await assertSafeDestination(
      workspace.root,
      target,
      protectedIdentities,
      { expectedParentChain: parentChain }
    );
    const parent = path.dirname(target);
    const parentRelative = path.relative(workspace.root, parent).split(path.sep).join("/") || ".";
    const targetName = path.basename(target);
    const publisherDigest = sha256(await readFile(ARTIFACT_PUBLISHER_PATH));
    const intentPath = artifactPublicationIntentPath(run.runDir, action);
    let intent = await exists(intentPath) ? await readJson(stateRoot, intentPath) : null;
    const currentSentinel = await captureSentinel(workspace.root, run.contract, await loadDefaults());
    if (intent) {
      checkedParentChain = await assertSafeDestination(
        workspace.root,
        target,
        protectedIdentities,
        { expectedParentChain: checkedParentChain, requireCompleteParent: true }
      );
      const parentIdentity = checkedParentChain.at(-1)?.identity;
      if (!/^\d+:\d+$/.test(parentIdentity ?? "")) {
        throw recipeError("artifact destination parent identity is missing");
      }
      const expected = {
        runIdValue: pending.runId,
        action,
        normalized,
        parentRelative,
        parentIdentity,
        targetName,
        artifact,
        publisherDigest
      };
      intent = validateArtifactPublicationIntent(intent, expected);
      if (currentSentinel.digest === action.treeDigest) {
        await assertSpentActionProviderAuthority(
          stateRoot,
          pending.runId,
          run,
          action,
          "Artifact promotion provider recovery"
        );
      } else {
        await assertSpentActionNonSourceAuthority(
          stateRoot,
          pending.runId,
          run,
          action,
          "Artifact promotion provider recovery"
        );
        const temporaryRelative = parentRelative === "."
          ? intent.binding.temporaryName
          : `${parentRelative}/${intent.binding.temporaryName}`;
        assertExpectedSourceRecovery(
          baselineSentinel,
          currentSentinel,
          [normalized, temporaryRelative],
          "artifact promotion recovery"
        );
      }
    } else {
      await assertSpentActionProviderAuthority(
        stateRoot,
        pending.runId,
        run,
        action,
        "Artifact promotion provider invocation"
      );
      if (currentSentinel.digest !== action.treeDigest) {
        throw recipeError("artifact promotion source changed before publication intent creation");
      }
      checkedParentChain = await ensureSafeDestinationParents(
        workspace.root,
        target,
        protectedIdentities,
        checkedParentChain,
        onDestinationBoundary
      );
      const parentIdentity = checkedParentChain.at(-1)?.identity;
      if (!/^\d+:\d+$/.test(parentIdentity ?? "")) {
        throw recipeError("artifact destination parent identity is missing");
      }
      const expected = {
        runIdValue: pending.runId,
        action,
        normalized,
        parentRelative,
        parentIdentity,
        targetName,
        artifact,
        publisherDigest
      };
      const binding = artifactPublicationBinding({
        ...expected,
        temporaryName: `.sbw-artifact-${randomBytes(16).toString("hex")}.tmp`
      });
      intent = await writeArtifactPublicationIntent(stateRoot, run, {
        schemaVersion: 1,
        kind: "artifact-publication",
        binding,
        bindingDigest: digestObject(binding),
        status: "prepared",
        targetIdentity: null,
        preparedAt: nowIso(),
        updatedAt: nowIso()
      }, "action.local-provider-intent-prepared");
    }
    const parentIdentity = checkedParentChain.at(-1)?.identity;
    if (!/^\d+:\d+$/.test(parentIdentity ?? "")) {
      throw recipeError("artifact destination parent identity is missing");
    }
    if (onDestinationBoundary) {
      await onDestinationBoundary("before-copy", { target, parent, intent });
    }
    checkedParentChain = await assertSafeDestination(workspace.root, target, protectedIdentities, {
      expectedParentChain: checkedParentChain,
      requireCompleteParent: true
    });
    if (onDestinationBoundary) {
      await onDestinationBoundary("before-link", { target, parent, intent });
    }
    checkedParentChain = await assertSafeDestination(workspace.root, target, protectedIdentities, {
      expectedParentChain: checkedParentChain,
      requireCompleteParent: true
    });
    if (onDestinationBoundary) {
      await onDestinationBoundary("after-parent-check", { target, parent, intent });
    }
    const linked = await runPinnedArtifactPublisher({
      mode: "link",
      parent,
      parentIdentity,
      targetName,
      temporaryName: intent.binding.temporaryName,
      artifact,
      artifactBytes,
      targetIdentity: intent.targetIdentity
    });
    if (onDestinationBoundary) {
      await onDestinationBoundary("after-artifact-link", { target, parent, intent, receipt: linked });
    }
    if (intent.targetIdentity && intent.targetIdentity !== linked.target.identity) {
      throw recipeError("artifact publication target identity changed during recovery");
    }
    intent = await writeArtifactPublicationIntent(stateRoot, run, {
      ...intent,
      status: "linked",
      targetIdentity: linked.target.identity,
      linkedAt: intent.linkedAt ?? nowIso(),
      updatedAt: nowIso()
    }, "action.local-provider-intent-linked");
    const published = await runPinnedArtifactPublisher({
      mode: "finalize",
      parent,
      parentIdentity,
      targetName,
      temporaryName: intent.binding.temporaryName,
      artifact,
      artifactBytes,
      targetIdentity: intent.targetIdentity
    });
    if (onDestinationBoundary) {
      await onDestinationBoundary("after-artifact-finalize", { target, parent, intent, receipt: published });
    }
    intent = await writeArtifactPublicationIntent(stateRoot, run, {
      ...intent,
      status: "published",
      publishedAt: intent.publishedAt ?? nowIso(),
      updatedAt: nowIso()
    }, "action.local-provider-intent-published");
    return { intent, publisherReceipt: published, parentChain: checkedParentChain };
  }, { ttlMs: 300_000 });
}

export async function recipeArtifactPromote(
  cwd,
  receiptId,
  artifactId,
  destination,
  { onDestinationBoundary = null } = {}
) {
  if (!artifactId || !destination) {
    throw recipeError("artifact promote requires --artifact <id> --to <relative-path>");
  }
  if (onDestinationBoundary !== null && typeof onDestinationBoundary !== "function") {
    throw recipeError("artifact destination boundary hook must be a function");
  }
  const workspace = await loadWorkspace(cwd);
  const stateRoot = getStateRoot();
  const workspaceDigest = sha256(await realpath(workspace.root));
  const receipt = await findReceipt(stateRoot, receiptId, workspaceDigest);
  if (receipt.dryRun || !receipt.artifactDirectory) throw recipeError("dry-run receipts have no promotable artifacts");
  const artifact = receipt.artifacts.find((item) => item.id === artifactId);
  if (!artifact) throw recipeError(`unknown artifact: ${artifactId}`);
  const recipe = await loadRecipe(workspace.root, receipt.recipeId);
  const binding = await executionBinding(recipe);
  if (receipt.executionDigest !== binding.executionDigest) {
    throw recipeError("artifact receipt is stale because recipe sources or runtime bindings changed");
  }
  const declaration = recipe.manifest.artifacts.find((item) => item.id === artifactId);
  if (!declaration?.promotable) throw recipeError(`artifact is not promotable: ${artifactId}`);
  const normalized = String(destination).replaceAll("\\", "/");
  const destinationComponents = normalized.split("/");
  if (
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.normalize(normalized) !== normalized ||
    /[\0\r\n\t]/.test(normalized) ||
    destinationComponents.some((component) => /[\0\r\n\t]/.test(component)) ||
    artifactDestinationTouchesReservedAuthority(normalized)
  ) {
    throw recipeError("--to must be a safe tracked repo-relative path outside Git authority and .codex/better-workflows");
  }
  const target = path.join(workspace.root, ...normalized.split("/"));
  pathContained(workspace.root, target, "artifact destination");
  const resource = `artifact:${receiptId}:${artifactId}:${normalized}`;
  const pending = await findArtifactAction(stateRoot, resource);
  const pendingRun = await inspectRun(stateRoot, pending.runId);
  if (await realpath(pendingRun.manifest.cwd) !== workspace.root) {
    throw recipeError("artifact promotion action belongs to a different workspace");
  }
  const baselineSentinel = await issuedSourceSentinel(stateRoot, pendingRun, pending.action);
  const currentSentinel = await captureSentinel(
    pendingRun.manifest.cwd,
    pendingRun.contract,
    await loadDefaults()
  );
  if (!currentSentinel.complete) {
    throw recipeError("artifact promotion action tree binding is stale or incomplete");
  }
  if (
    pendingRun.findings.some(
      (item) => ["P0", "P1"].includes(item.severity) && item.status === "open"
    )
  ) {
    throw recipeError("artifact promotion is blocked by an open P0/P1 finding");
  }
  const source = path.join(workspace.root, ...receipt.artifactDirectory.split("/"), artifact.filename);
  await assertSafeExistingPath(
    workspace.root,
    path.relative(workspace.root, source).split(path.sep).join("/"),
    "artifact source",
    { file: true }
  );
  const artifactBytes = await readFile(source);
  if (sha256(artifactBytes) !== artifact.sha256) throw recipeError("artifact digest drifted");
  const protectedIdentities = await artifactPromotionProtectedIdentities(workspace);
  let parentChain = await assertSafeDestination(workspace.root, target, protectedIdentities);
  if (pending.action.outcome === "success") {
    parentChain = await assertSafeDestination(workspace.root, target, protectedIdentities, {
      expectedParentChain: parentChain,
      requireCompleteParent: true
    });
    const targetInfo = await lstat(target);
    const providerReceipt = pending.action.receipt?.providerReceipt;
    if (
      !targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.nlink !== 1 ||
      sha256(await readFile(target)) !== artifact.sha256 ||
      providerReceipt?.action !== "artifact.promote" ||
      providerReceipt?.attemptId !== pending.action.attemptId ||
      providerReceipt?.digest !== artifact.sha256 ||
      providerReceipt?.sourceMutation?.path !== normalized
    ) {
      throw recipeError("completed artifact promotion is not replay-valid");
    }
    return { ok: true, receiptId, artifactId, destination: normalized, sha256: artifact.sha256 };
  }
  if (onDestinationBoundary) {
    await onDestinationBoundary("before-authority-replay", { target, parent: path.dirname(target) });
  }
  const publication = await publishArtifactWithIntent({
    stateRoot,
    pending,
    baselineSentinel,
    workspace,
    target,
    normalized,
    parentChain,
    protectedIdentities,
    artifact,
    artifactBytes,
    onDestinationBoundary
  });
  parentChain = await assertSafeDestination(workspace.root, target, protectedIdentities, {
    expectedParentChain: publication.parentChain,
    requireCompleteParent: true
  });
  const targetInfo = await lstat(target);
  if (
    targetInfo.isSymbolicLink() || !targetInfo.isFile() || targetInfo.nlink !== 1 ||
    sha256(await readFile(target)) !== artifact.sha256 ||
    filesystemIdentity(targetInfo) !== publication.intent.targetIdentity
  ) {
    throw recipeError("artifact destination changed at the final write boundary");
  }
  const afterSentinel = await captureSentinel(
    pendingRun.manifest.cwd,
    pendingRun.contract,
    await loadDefaults()
  );
  const beforeSourceBinding = pending.action.sourceAuthorityAtIssue?.sourceBinding;
  if (!beforeSourceBinding) throw recipeError("artifact action source binding is missing");
  const afterSourceBinding = await captureSourceBinding(workspace.root, {
    baseRevision: beforeSourceBinding.baseRevision,
    requireClean: false
  });
  if (![beforeSourceBinding.digest, afterSourceBinding?.digest].includes(pendingRun.manifest.sourceBinding?.digest)) {
    throw recipeError("artifact run source binding is unrelated to the action transition");
  }
  const sourceMutation = providerActionSourceMutation({
    action: pending.action,
    relativePath: normalized,
    beforeSentinel: baselineSentinel,
    afterSentinel,
    beforeSourceBinding,
    afterSourceBinding
  });
  if (!sourceMutation) throw recipeError("artifact promotion did not produce a source transition");
  const providerReceipt = {
    provider: "local-workspace",
    action: "artifact.promote",
    resource,
    outcome: "success",
    runId: pending.action.runId,
    attemptId: pending.action.attemptId,
    idempotencyKey: pending.action.idempotencyKey,
    remoteRevision: pending.action.remoteRevision,
    executionId: `local-workspace:artifact.promote:${pending.action.attemptId}`,
    proofKind: "local-workspace:artifact.promote",
    requestDigest: sha256(canonicalJson({ action: pending.action.action, provider: pending.action.provider, resource: pending.action.resource, remoteRevision: pending.action.remoteRevision, idempotencyKey: pending.action.idempotencyKey })),
    responseDigest: sha256(canonicalJson({
      kind: "workspace-artifact",
      digest: artifact.sha256,
      sourceMutationDigest: digestObject(sourceMutation)
    })),
    verifiedAt: pending.action.spentAt,
    terminalState: "success",
    kind: "workspace-artifact",
    digest: artifact.sha256,
    sourceMutation
  };
  const actionEvidence = await addActionEvidence(stateRoot, pending.action, providerReceipt);
  await reconcileAction(
    stateRoot,
    pending.runId,
    pending.action.attemptId,
    "success",
    {
      action: "artifact.promote",
      provider: "local-workspace",
      resource,
      outcome: "success",
      runId: pending.action.runId,
      attemptId: pending.action.attemptId,
      idempotencyKey: pending.action.idempotencyKey,
      remoteRevision: pending.action.remoteRevision,
      providerReceipt,
      evidenceIds: [actionEvidence.id]
    }
  );
  return { ok: true, receiptId, artifactId, destination: normalized, sha256: artifact.sha256 };
}

export async function recipePrune(cwd, { apply = false } = {}) {
  const workspace = await loadWorkspace(cwd);
  const cutoff = Date.now() - workspace.config.artifactRetentionDays * 86_400_000;
  const entries = await readdir(workspace.paths.artifacts, { withFileTypes: true });
  const candidates = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.name === ".gitignore") continue;
    if (!entry.isDirectory() || !RECEIPT_ID.test(entry.name)) {
      throw recipeError(`unsafe artifact retention entry: ${entry.name}`);
    }
    const target = path.join(workspace.paths.artifacts, entry.name);
    const info = await stat(target);
    let bytes = 0;
    for (const child of await readdir(target, { withFileTypes: true })) {
      if (!child.isFile() || child.isSymbolicLink()) throw recipeError(`unsafe artifact entry: ${entry.name}/${child.name}`);
      bytes += (await lstat(path.join(target, child.name))).size;
    }
    totalBytes += bytes;
    if (info.mtimeMs < cutoff) candidates.push({ receiptId: entry.name, bytes });
  }
  const overCap = totalBytes > workspace.config.workspaceArtifactCapBytes;
  if (apply) {
    for (const item of candidates) {
      await rm(path.join(workspace.paths.artifacts, item.receiptId), { recursive: true, force: false });
    }
  }
  return {
    ok: true,
    apply,
    retentionDays: workspace.config.artifactRetentionDays,
    workspaceArtifactCapBytes: workspace.config.workspaceArtifactCapBytes,
    totalBytes,
    overCap,
    candidates
  };
}

async function assertSafeDestination(
  root,
  target,
  protectedIdentities = new Set(),
  { expectedParentChain = null, requireCompleteParent = false } = {}
) {
  pathContained(root, target, "artifact destination");
  const relative = path.relative(root, path.dirname(target));
  let current = path.resolve(root);
  const rootInfo = await lstat(current);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw recipeError("Git worktree root is unsafe");
  }
  const parentChain = [{ relative: ".", identity: filesystemIdentity(rootInfo) }];
  let complete = true;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!(await exists(current))) {
      complete = false;
      break;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw recipeError(`unsafe artifact destination parent: ${current}`);
    }
    if (protectedIdentities.has(filesystemIdentity(info))) {
      throw recipeError(`artifact destination resolves through Git authority or reserved recipe state: ${current}`);
    }
    parentChain.push({
      relative: path.relative(root, current).split(path.sep).join("/"),
      identity: filesystemIdentity(info)
    });
  }
  if (requireCompleteParent && !complete) {
    throw recipeError("artifact destination parent is missing at the write boundary");
  }
  if (expectedParentChain !== null && digestObject(parentChain) !== digestObject(expectedParentChain)) {
    throw recipeError("artifact destination ancestry changed at the write boundary");
  }
  return parentChain;
}

async function ensureSafeDestinationParents(
  root,
  target,
  protectedIdentities,
  expectedParentChain,
  onDestinationBoundary = null
) {
  const parent = path.dirname(target);
  let parentChain = expectedParentChain;
  let current = path.resolve(root);
  for (const component of path.relative(root, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const verified = await assertSafeDestination(root, target, protectedIdentities, {
      expectedParentChain: parentChain
    });
    parentChain = verified;
    if (await exists(current)) continue;
    const pinnedParent = path.dirname(current);
    const pinnedParentIdentity = parentChain.at(-1)?.identity;
    if (!/^\d+:\d+$/.test(pinnedParentIdentity ?? "")) {
      throw recipeError("artifact destination ancestor identity is missing");
    }
    if (onDestinationBoundary) {
      await onDestinationBoundary("before-parent-create", {
        target,
        parent: pinnedParent,
        component,
        parentIdentity: pinnedParentIdentity
      });
    }
    const receipt = await runPinnedDestinationParentCreator({
      parent: pinnedParent,
      parentIdentity: pinnedParentIdentity,
      component
    });
    if (onDestinationBoundary) {
      await onDestinationBoundary("after-parent-create", {
        target,
        parent: pinnedParent,
        component,
        parentIdentity: pinnedParentIdentity,
        receipt
      });
    }
    parentChain = await assertSafeDestination(root, target, protectedIdentities);
    if (parentChain.at(-1)?.identity !== receipt.child.identity) {
      throw recipeError("artifact destination component changed after pinned creation");
    }
  }
  return assertSafeDestination(root, target, protectedIdentities, {
    expectedParentChain: parentChain,
    requireCompleteParent: true
  });
}

async function workspaceArtifactBytes(artifactsRoot) {
  let total = 0;
  for (const entry of await readdir(artifactsRoot, { withFileTypes: true })) {
    if (entry.name === ".gitignore" || entry.name.startsWith(".staging-") || entry.name.startsWith(".candidate-")) {
      continue;
    }
    if (!entry.isDirectory() || !RECEIPT_ID.test(entry.name)) {
      throw recipeError(`unsafe workspace artifact entry: ${entry.name}`);
    }
    const directory = path.join(artifactsRoot, entry.name);
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (!child.isFile() || child.isSymbolicLink()) {
        throw recipeError(`unsafe workspace artifact file: ${entry.name}/${child.name}`);
      }
      const info = await lstat(path.join(directory, child.name));
      if (info.nlink !== 1) throw recipeError(`hardlinked workspace artifact: ${entry.name}/${child.name}`);
      total += info.size;
    }
  }
  return total;
}
