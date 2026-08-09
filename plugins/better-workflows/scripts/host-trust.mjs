#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// macOS exposes /etc as a symlink to /private/etc. Keep protected authority
// paths canonical so realpath checks do not reject an otherwise safe host.
const HOST_ETC = process.platform === "darwin" ? "/private/etc" : "/etc";
const TRUST_ROOT = `${HOST_ETC}/better-workflows/codex-trust-root.json`;
const CODEX_ALLOWLIST = `${HOST_ETC}/better-workflows/codex-binary-allowlist.json`;
const PRIVATE_KEY = "/private/var/db/better-workflows/codex-attestation-ed25519.raw";
const ATTESTATIONS = "/private/var/db/better-workflows/attestations";
const EXECUTIONS = "/private/var/db/better-workflows/executions";
const EXECUTION_BUNDLES = "/private/var/db/better-workflows/execution-bundles";
const INSTALLED_SIGNER = "/private/var/db/better-workflows/bin/bw-host-trust.mjs";
const READINESS_RECEIPT = "/private/var/db/better-workflows/host-readiness.json";
const STANDING_CONSENT_POLICY = `${HOST_ETC}/better-workflows/self-improve-standing-consent-policy.json`;
const STANDING_CONSENT_GRANT = `${HOST_ETC}/better-workflows/self-improve-standing-consent-grant.json`;
const STANDING_CONSENT_SUDOERS = `${HOST_ETC}/sudoers.d/better-workflows-self-improve`;
const VISUDO = "/usr/sbin/visudo";
const HOST_RUNTIME_ROOT = "/private/var/db/better-workflows/bin";
const EXECUTION_LAUNCHER = "/private/var/db/better-workflows/bin/bw-host-exec-launcher";
const EXECUTION_PROBE = "/private/var/db/better-workflows/bin/bw-host-execution-probe";
const LEGACY_SIGNER = "/private/var/db/better-workflows/bin/bw-host-signer.swift";
const SAFETY_REMEDIATION_POLICY_PATH = "plugins/better-workflows/config/self-improve-safety-remediation-v1.json";
const SAFETY_REMEDIATION_POLICY_ID = "self-improve-safety-remediation";
const SAFETY_REMEDIATION_POLICY_VERSION = "v1";
const QUALITY_REMEDIATION_POLICY_PATH = "plugins/better-workflows/config/self-improve-quality-remediation-v1.json";
const QUALITY_REMEDIATION_POLICY_ID = "self-improve-quality-remediation";
const QUALITY_REMEDIATION_POLICY_VERSION = "v1";
const POLICY_BINDINGS = Object.freeze({
  "safety-remediation-v1": Object.freeze({ path: SAFETY_REMEDIATION_POLICY_PATH, id: SAFETY_REMEDIATION_POLICY_ID, version: SAFETY_REMEDIATION_POLICY_VERSION }),
  "quality-remediation-v1": Object.freeze({ path: QUALITY_REMEDIATION_POLICY_PATH, id: QUALITY_REMEDIATION_POLICY_ID, version: QUALITY_REMEDIATION_POLICY_VERSION })
});
function policyBindingForPurpose(purpose) {
  return POLICY_BINDINGS[purpose] ?? null;
}
const NATIVE_COMPILER = "/usr/bin/clang";
const ISSUER = "better-workflows-local-host";
const HOST_SIGNER_VERSION = "2.4.0";
const HOST_SIGNER_CAPABILITIES = Object.freeze([
  "attestation",
  "native-review",
  "execution-witness",
  "execution-result",
  "execution-batch",
  "signer-upgrade",
  "native-launcher",
  "readiness-probe",
  "request-bound-execution",
  "standing-consent-admin",
  "standing-consent-execution"
]);
const SAFE_OUTPUT = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}\.json$/;
const SAFE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
// High-reasoning Codex replays can legitimately approach two minutes; retain
// a bounded host cutoff while leaving enough margin for provider latency.
const DEFAULT_TIMEOUT_MS = 180_000;
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const STANDING_CONSENT_MODE = "standing-user-consent";
const STANDING_CONSENT_PROVIDER = "codex";
const STANDING_CONSENT_OPERATION = "self-improve-evaluator-replay";
const STANDING_CONSENT_AUTHORITY_STATEMENT = "Permit the root-owned Better Workflows host signer to automatically execute sanitized, read-only, ephemeral self-improve evaluator replays for this repository with gpt-5.6-terra, up to eight requests per source-bound batch; this does not authorize repository, cache, delivery, deployment, or cleanup mutations.";
const STANDING_CONSENT_AUTHORITY_STATEMENT_DIGEST = createHash("sha256")
  .update(STANDING_CONSENT_AUTHORITY_STATEMENT, "utf8")
  .digest("hex");
const STANDING_CONSENT_POLICY_ID = "self-improve-standing-evaluator-consent";
const STANDING_CONSENT_POLICY_VERSION = "v1";
const STANDING_CONSENT_PURPOSES = Object.freeze([
  "ordinary",
  "evaluator-migration",
  "safety-remediation-v1",
  "quality-remediation-v1"
]);
const STANDING_CONSENT_DENIED_AUTHORITIES = Object.freeze([
  "git.commit",
  "plugin.cache.publish",
  "git.push",
  "pull.create",
  "pull.merge",
  "deploy",
  "cleanup"
]);
const STANDING_CONSENT_ALLOWED_PATH_PATTERNS = Object.freeze([
  "^(?:README|CODE_OF_CONDUCT|CONTRIBUTING|GOVERNANCE|SECURITY|SUPPORT)\\.md$",
  "^scripts/plugin-cache\\.mjs$",
  "^docs/README\\.(?:zh-TW|zh-CN|ja|ko)\\.md$",
  "^docs/details/(?:en|zh-TW|zh-CN|ja|ko)\\.md$",
  "^docs/guide/(?:architecture|cli-reference|getting-started|readme-quality|security|workflows)\\.md$",
  "^docs/assets/better-workflows-engineering-stack\\.svg$",
  "^plugins/better-workflows/(?:scripts/.+\\.(?:mjs|c)|skills/.+\\.md|templates/.+\\.json|fixtures/.+\\.(?:json|md|mjs)|config/.+\\.json|package\\.json|\\.codex-plugin/plugin\\.json)$"
]);
const STANDING_CONSENT_SECRET_PATTERN = "(?:api[_-]?key|password|passwd|secret|token|authorization)\\s*[:=]\\s*(?:\\\"[^\\\"\\s]{4,}\\\"|'[^'\\s]{4,}'|(?=[A-Za-z0-9+/_-]{8,}(?:\\s|$))(?=[A-Za-z0-9+/_-]*[0-9+/_-])[A-Za-z0-9+/_-]+)";
const STANDING_CONSENT_REQUIRED_PROMPT_LINES = Object.freeze([
  "You are classifying a staged workflow snapshot using a sanitized, bounded corpus.",
  "Do not use tools, access history, write files, or perform side effects.",
  "The result must be grounded solely in the candidate digest, complete changed-path digest manifest, and balanced sanitized samples below."
]);
const STANDING_CONSENT_REQUEST_ROOT_PREFIX = "/private/tmp/better-workflows-standing-consent-";
const CONSENT_SAFE_SUBDIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const STANDING_CONSENT_GRANT_FIELDS = Object.freeze([
  "authorityStatementDigest", "deniedAuthorities", "ephemeral", "expiresAt", "grantId", "hostRuntime", "hostSigner",
  "issuedAt", "issuer", "keyId", "kind", "maxRequests", "models", "operation", "policyDigest", "policyPath", "provider",
  "purposes", "readOnly", "repo", "requestRoot", "revokedAt", "sanitized", "schemaVersion", "subject"
]);

export const EVALUATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "disposition", "passedAssertions"],
        properties: {
          id: { type: "string" },
          disposition: {
            type: "string",
            enum: ["IMPLEMENT", "NO_CHANGE", "BLOCKED", "REJECTED_WITH_EVIDENCE"]
          },
          passedAssertions: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sorted(value));
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== expected.slice().sort().join("\0")) {
    throw new Error(`${label} fields do not match the standing-consent contract`);
  }
}

export function validateStandingConsentPolicy(value) {
  exactKeys(value, [
    "allowedModels", "allowedPurposes", "deniedAuthorities", "execution", "maxRequests", "operation",
    "policyId", "provider", "requestCounts", "sanitization", "schemaVersion", "version"
  ], "Standing-consent policy");
  if (value.schemaVersion !== 1 || value.policyId !== STANDING_CONSENT_POLICY_ID || value.version !== STANDING_CONSENT_POLICY_VERSION ||
      value.provider !== STANDING_CONSENT_PROVIDER || value.operation !== STANDING_CONSENT_OPERATION || value.maxRequests !== 8 ||
      canonicalJson(value.allowedModels) !== canonicalJson(["gpt-5.6-terra"]) ||
      canonicalJson(value.allowedPurposes) !== canonicalJson(STANDING_CONSENT_PURPOSES)) {
    throw new Error("Standing-consent policy identity or scope is invalid");
  }
  exactKeys(value.requestCounts, STANDING_CONSENT_PURPOSES, "Standing-consent request counts");
  for (const purpose of STANDING_CONSENT_PURPOSES) {
    if (value.requestCounts[purpose] !== (purpose === "evaluator-migration" ? 8 : 7)) {
      throw new Error(`Standing-consent request count is invalid for ${purpose}`);
    }
  }
  exactKeys(value.execution, ["ephemeral", "providerNetworkOnly", "sandbox", "tools"], "Standing-consent execution policy");
  if (value.execution.sandbox !== "read-only" || value.execution.ephemeral !== true ||
      value.execution.providerNetworkOnly !== true || value.execution.tools !== false) {
    throw new Error("Standing-consent execution policy must remain read-only, ephemeral, and tool-free");
  }
  exactKeys(value.sanitization, [
    "allowedPathPatterns", "maxBytes", "maxCases", "maxFiles", "promptSchema", "requiredPromptLines", "schema", "secretPattern"
  ], "Standing-consent sanitization policy");
  if (value.sanitization.schema !== "self-improve-balanced-material-v1" ||
      value.sanitization.promptSchema !== "self-improve-evaluation-prompt-v1" ||
      value.sanitization.maxFiles !== 24 || value.sanitization.maxBytes !== 96 * 1024 || value.sanitization.maxCases !== 28 ||
      canonicalJson(value.sanitization.allowedPathPatterns) !== canonicalJson(STANDING_CONSENT_ALLOWED_PATH_PATTERNS) ||
      canonicalJson(value.sanitization.requiredPromptLines) !== canonicalJson(STANDING_CONSENT_REQUIRED_PROMPT_LINES) ||
      value.sanitization.secretPattern !== STANDING_CONSENT_SECRET_PATTERN) {
    throw new Error("Standing-consent sanitization policy is invalid");
  }
  for (const pattern of value.sanitization.allowedPathPatterns) new RegExp(pattern);
  new RegExp(value.sanitization.secretPattern, "i");
  if (canonicalJson(value.deniedAuthorities) !== canonicalJson(STANDING_CONSENT_DENIED_AUTHORITIES)) {
    throw new Error("Standing-consent policy must deny every delivery and cleanup authority");
  }
  return value;
}

function validateStandingAuthorization(value) {
  exactKeys(value, [
    "ephemeral", "grantDigest", "grantId", "mode", "model", "policyDigest", "policyId", "policyVersion", "provider",
    "purpose", "readOnly", "repo", "requestCount", "requestRoot", "sanitized", "subject"
  ], "Standing authorization");
  exactKeys(value.subject, ["codexHomePath", "gid", "homePath", "uid", "username"], "Standing authorization subject");
  if (value.mode !== STANDING_CONSENT_MODE || !SAFE_EXECUTION_ID.test(value.grantId ?? "") || !SHA256.test(value.grantDigest ?? "") ||
      value.policyId !== STANDING_CONSENT_POLICY_ID || value.policyVersion !== STANDING_CONSENT_POLICY_VERSION || !SHA256.test(value.policyDigest ?? "") ||
      value.provider !== STANDING_CONSENT_PROVIDER || value.model !== "gpt-5.6-terra" || !STANDING_CONSENT_PURPOSES.includes(value.purpose) ||
      !Number.isInteger(value.requestCount) || value.requestCount !== (value.purpose === "evaluator-migration" ? 8 : 7) ||
      typeof value.repo !== "string" || !path.isAbsolute(value.repo) || path.resolve(value.repo) !== value.repo ||
      typeof value.requestRoot !== "string" || !path.isAbsolute(value.requestRoot) || path.resolve(value.requestRoot) !== value.requestRoot ||
      value.readOnly !== true || value.ephemeral !== true || value.sanitized !== true ||
      !Number.isInteger(value.subject.uid) || value.subject.uid <= 0 || !Number.isInteger(value.subject.gid) || value.subject.gid <= 0 ||
      typeof value.subject.username !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.subject.username) ||
      typeof value.subject.homePath !== "string" || !path.isAbsolute(value.subject.homePath) ||
      (value.subject.codexHomePath !== null && (typeof value.subject.codexHomePath !== "string" || !path.isAbsolute(value.subject.codexHomePath))) ||
      value.requestRoot !== `${STANDING_CONSENT_REQUEST_ROOT_PREFIX}${value.subject.uid}`) {
    throw new Error("Standing authorization is structurally invalid");
  }
  return value;
}

function escapeExtendedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function standingConsentSudoers({ grant, runtime }) {
  const commandRegex = [
    `^${escapeExtendedRegex(INSTALLED_SIGNER)}`,
    "execute-consented-batch",
    "--manifest",
    `${escapeExtendedRegex(grant.requestRoot)}/[A-Za-z0-9][A-Za-z0-9._-]{7,127}/attestation-requests\\.json`,
    "--confirm-digest",
    "[a-f0-9]{64}$"
  ].join(" ");
  return [
    "# Managed by Better Workflows. Revoke with sbw self-improve consent revoke.",
    `${grant.subject.username} ALL=(root) NOPASSWD:NOSETENV: sha256:${runtime.digest} ${runtime.path} ${commandRegex}`,
    ""
  ].join("\n");
}

export async function standingConsentSudoersEvidence({ grant, runtime, actualBytes = null }) {
  const expectedBytes = Buffer.from(standingConsentSudoers({ grant, runtime }), "utf8");
  if (actualBytes !== null) {
    if (!Buffer.isBuffer(actualBytes) || !actualBytes.equals(expectedBytes)) {
      throw new Error("Standing-consent sudoers rule does not match the signed grant");
    }
  }
  return {
    digest: await digest(expectedBytes),
    verification: actualBytes === null ? "deferred-to-root-execution" : "content-verified"
  };
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function digest(bytes) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
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

function safeEnvironment(extra = {}) {
  const allowed = [
    "LANG",
    "LC_ALL"
  ];
  const environment = {
    PATH: SAFE_PATH,
    ...Object.fromEntries(allowed
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]))
  };
  return { ...environment, ...extra };
}

function terminate(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child has already exited.
    }
  }
}

export function spawnCapture(command, args, {
  input,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  env = safeEnvironment(),
  uid,
  gid,
  launcherPath = null
} = {}) {
  return new Promise((resolve, reject) => {
    if (launcherPath && (uid === undefined || gid === undefined)) {
      reject(new Error("A native execution launcher requires uid and gid"));
      return;
    }
    const spawnOptions = {
      cwd: launcherPath ? "/" : cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    };
    if (!launcherPath) {
      if (uid !== undefined) spawnOptions.uid = uid;
      if (gid !== undefined) spawnOptions.gid = gid;
    }
    const child = spawn(
      launcherPath ?? command,
      launcherPath
        ? ["--uid", String(uid), "--gid", String(gid), "--cwd", cwd, "--binary", command, "--", ...args]
        : args,
      spawnOptions
    );
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let terminationRequested = false;
    let settled = false;
    let timeout;
    let forceKill;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      if (error) reject(error);
      else resolve(result);
    };
    const requestTermination = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      terminate(child, "SIGTERM");
      forceKill = setTimeout(() => terminate(child, "SIGKILL"), 2_000);
    };
    const collect = (bucket) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        outputExceeded = true;
        requestTermination();
        return;
      }
      if (!outputExceeded) bucket.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      if (!terminationRequested) finish(error);
    });
    child.on("close", (code, signal) => finish(null, {
      code,
      signal,
      timedOut,
      outputExceeded,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
    child.stdin.end(input);
    timeout = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);
  });
}

function extractJson(output) {
  const trimmed = String(output ?? "").trim()
    .replace(/^~~~(?:json)?\s*/i, "")
    .replace(/~~~\s*$/i, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Host Codex execution returned no JSON object");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function validateEvaluationResponse(response) {
  if (!response || typeof response !== "object" || Array.isArray(response) || !Array.isArray(response.results)) {
    throw new Error("Host Codex execution returned malformed evaluation output");
  }
  for (const item of response.results) {
    if (
      !item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).sort().join("\0") !== "disposition\0id\0passedAssertions" ||
      typeof item.id !== "string" ||
      !["IMPLEMENT", "NO_CHANGE", "BLOCKED", "REJECTED_WITH_EVIDENCE"].includes(item.disposition) ||
      !Array.isArray(item.passedAssertions) || item.passedAssertions.some((value) => typeof value !== "string")
    ) {
      throw new Error("Host Codex execution returned an invalid evaluation result");
    }
  }
  return response;
}

function requireSafeExecutionId(id) {
  if (typeof id !== "string" || !SAFE_EXECUTION_ID.test(id)) {
    throw new Error("execution.id is invalid");
  }
  return id;
}

function requireRoot() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("This host operation must be run by an administrator (uid 0)");
  }
}

async function secureDirectory(target, mode) {
  await validateProtectedParentChain(target, "Administrator directory");
  await mkdir(target, { recursive: true, mode });
  await validateProtectedDirectoryChain(target, "Administrator directory");
  await chmod(target, mode);
  await validateProtectedDirectoryChain(target, "Administrator directory");
}

export async function validateProtectedDirectoryChain(target, label) {
  const resolved = path.resolve(target);
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new Error(`${label} must already be canonical`);
  let directory = canonical;
  while (true) {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== 0 || ((info.mode & 0o777) & 0o022) !== 0) {
      throw new Error(`${label} contains an unsafe parent directory: ${directory}`);
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

export async function validateProtectedParentChain(target, label) {
  const parent = path.dirname(path.resolve(target));
  const canonicalParent = await realpath(parent);
  await validateProtectedDirectoryChain(canonicalParent, `${label} parent chain`);
}

async function validateRootOwnedDirectory(target, label, expectedMode) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== 0) {
    throw new Error(`${label} must be an administrator-owned directory`);
  }
  const mode = info.mode & 0o777;
  if (mode !== expectedMode) {
    throw new Error(`${label} mode must be ${expectedMode.toString(8)}, found ${mode.toString(8)}`);
  }
  const resolved = await realpath(target);
  if (resolved !== target) throw new Error(`${label} must already be canonical`);
  await validateProtectedParentChain(target, label);
  return info;
}

async function exclusiveWrite(target, bytes, mode) {
  await validateProtectedParentChain(target, "Administrator staging file");
  const handle = await open(target, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(target, mode);
}

async function syncDirectory(target) {
  const handle = await open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readSourceFile(target, confirmedDigest, label) {
  if (!SHA256.test(confirmedDigest)) throw new Error(`${label} digest must be SHA-256`);
  const resolved = path.resolve(target);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  const bytes = await readFile(resolved);
  if (await digest(bytes) !== confirmedDigest) throw new Error(`${label} digest does not match administrator-confirmed digest`);
  return { path: resolved, bytes, digest: confirmedDigest };
}

function isMachO(bytes) {
  if (bytes.length < 4) return false;
  const little = bytes.readUInt32LE(0);
  const big = bytes.readUInt32BE(0);
  return [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(little) ||
    [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(big);
}

async function compileNativeArtifact(source, label) {
  const stem = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const sourcePath = path.join(HOST_RUNTIME_ROOT, `.${stem}.${source.digest}.c`);
  const outputPath = path.join(HOST_RUNTIME_ROOT, `.${stem}.${source.digest}.tmp`);
  if (await exists(sourcePath) || await exists(outputPath)) {
    throw new Error(`Refusing to reuse ${label} compiler staging files`);
  }
  await exclusiveWrite(sourcePath, source.bytes, 0o600);
  try {
    await validateRootOwnedFile(sourcePath, `${label} compiler source`, 0o600);
    const result = await spawnCapture(NATIVE_COMPILER, [
      "-Wall", "-Wextra", "-Werror", "-O2", "-o", outputPath, sourcePath
    ], {
      cwd: "/",
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      env: safeEnvironment()
    });
    if (result.code !== 0 || result.signal !== null || result.timedOut || result.outputExceeded) {
      throw new Error(`${label} compilation failed: exit=${result.code ?? "null"}; signal=${result.signal ?? "none"}`);
    }
    await chmod(outputPath, 0o755);
    await validateRootOwnedFile(outputPath, `${label} compiled artifact`, 0o755);
    const bytes = await readFile(outputPath);
    if (!isMachO(bytes)) throw new Error(`${label} compiler output is not a supported macOS Mach-O executable`);
    return { path: outputPath, bytes, digest: await digest(bytes) };
  } finally {
    await unlink(sourcePath).catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
  }
}

async function replaceRootOwnedFile(target, source, mode, label) {
  const existing = await exists(target);
  let previous = null;
  let backupPath = null;
  let renamed = false;
  if (existing) {
    await validateRootOwnedFile(target, label, mode);
    const bytes = await readFile(target);
    const existingDigest = await digest(bytes);
    if (existingDigest === source.digest) return { changed: false, previous: { digest: existingDigest, path: target } };
    const backup = `${target}.${existingDigest}.bak`;
    if (await exists(backup)) {
      await validateRootOwnedFile(backup, `${label} stale backup`, mode);
      if (await digest(await readFile(backup)) !== existingDigest) {
        throw new Error(`Refusing to overwrite ${label} backup: ${backup}`);
      }
      await unlink(backup);
      await syncDirectory(path.dirname(target));
    }
    await exclusiveWrite(backup, bytes, mode);
    backupPath = backup;
    await validateRootOwnedFile(backup, `${label} backup`, mode);
    previous = { bytes, digest: existingDigest, path: backup };
  }
  const temporary = `${target}.${source.digest}.tmp`;
  if (await exists(temporary)) throw new Error(`Refusing to reuse ${label} staging file: ${temporary}`);
  try {
    await exclusiveWrite(temporary, source.bytes, mode);
    await validateRootOwnedFile(temporary, `${label} staging file`, mode);
    await syncDirectory(path.dirname(target));
    await rename(temporary, target);
    renamed = true;
    await syncDirectory(path.dirname(target));
    await validateRootOwnedFile(target, label, mode);
    const installedDigest = await digest(await readFile(target));
    if (installedDigest !== source.digest) throw new Error(`${label} digest changed during atomic installation`);
    return { changed: true, previous, installedDigest };
  } catch (error) {
    if (!renamed) {
      if (backupPath) await discardRollbackBackup({ path: backupPath }, label).catch(() => undefined);
      throw error;
    }
    try {
      await restoreRootOwnedFile(target, previous, mode, label);
      if (previous) await discardRollbackBackup(previous, label);
    } catch (rollbackError) {
      throw new Error(`${label} installation failed and rollback could not be proven: ${error.message}; ${rollbackError.message}`);
    }
    throw new Error(`${label} installation failed and was rolled back with exact prior artifact proven: ${error.message}`);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function restoreRootOwnedFile(target, previous, mode, label) {
  if (!previous) {
    await unlink(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await syncDirectory(path.dirname(target));
    return;
  }
  const bytes = await readFile(previous.path);
  if (await digest(bytes) !== previous.digest) throw new Error(`${label} rollback backup digest changed`);
  const temporary = `${target}.${previous.digest}.restore.tmp`;
  await exclusiveWrite(temporary, bytes, mode);
  await validateRootOwnedFile(temporary, `${label} rollback staging file`, mode);
  await rename(temporary, target);
  await syncDirectory(path.dirname(target));
  await validateRootOwnedFile(target, `${label} restored file`, mode);
  if (await digest(await readFile(target)) !== previous.digest) throw new Error(`${label} rollback digest could not be proven`);
}

async function discardRollbackBackup(previous, label) {
  if (!previous?.path || !previous.path.endsWith(".bak")) return;
  await unlink(previous.path).catch((error) => {
    if (error.code !== "ENOENT") throw new Error(`${label} rollback backup cleanup failed: ${error.message}`);
  });
  await syncDirectory(path.dirname(previous.path)).catch(() => undefined);
  if (await exists(previous.path)) throw new Error(`${label} rollback backup cleanup could not be proven`);
}

async function validateRootOwnedFile(target, label, expectedMode) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== 0) {
    throw new Error(`${label} must be an administrator-owned regular file`);
  }
  const mode = info.mode & 0o777;
  if (mode !== expectedMode) {
    throw new Error(`${label} mode must be ${expectedMode.toString(8)}, found ${mode.toString(8)}`);
  }
  await validateProtectedParentChain(target, label);
  return info;
}

async function validateCodexAllowlist() {
  await validateRootOwnedFile(CODEX_ALLOWLIST, "Approved Codex binary allowlist", 0o644);
  let directory = path.dirname(await realpath(CODEX_ALLOWLIST));
  while (true) {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== 0 || ((info.mode & 0o777) & 0o022) !== 0) {
      throw new Error(`Unsafe Codex allowlist parent directory: ${directory}`);
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const bytes = await readFile(CODEX_ALLOWLIST);
  const value = JSON.parse(bytes.toString("utf8"));
  if (value?.schemaVersion !== 1 || value.kind !== "codex-binary-allowlist" || !Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error("Approved Codex binary allowlist schema is invalid");
  }
  const paths = new Set();
  for (const entry of value.entries) {
    if (!entry || Object.keys(entry).sort().join("\0") !== "digest\0path" ||
        typeof entry.path !== "string" || !path.isAbsolute(entry.path) || path.resolve(entry.path) !== entry.path ||
        !SHA256.test(entry.digest) || paths.has(entry.path)) {
      throw new Error("Approved Codex binary allowlist entry is invalid");
    }
    paths.add(entry.path);
  }
  return { value, bytes, digest: await digest(bytes) };
}

async function currentRuntime(preferredPath = null) {
  await validateProtectedDirectoryChain(HOST_RUNTIME_ROOT, "Fixed host runtime root");
  const candidates = await readdirSafe(HOST_RUNTIME_ROOT);
  const targets = (preferredPath ? [preferredPath] : candidates
    .filter((name) => name.startsWith("bw-host-node."))
    .map((name) => path.join(HOST_RUNTIME_ROOT, name))
    .sort());
  let lastError = null;
  for (const target of targets) {
    try {
      if (path.resolve(target) !== target || !isWithin(HOST_RUNTIME_ROOT, target)) {
        throw new Error("Administrator Node runtime must be inside the fixed host runtime root");
      }
      const info = await validateRootOwnedFile(target, "Administrator Node runtime", 0o755);
      const bytes = await readFile(target);
      const runtimeDigest = await digest(bytes);
      if (path.basename(target) !== `bw-host-node.${runtimeDigest}`) {
        throw new Error("Administrator Node runtime filename is not digest-bound");
      }
      const canonical = await realpath(target);
      if (canonical !== target) throw new Error("Administrator Node runtime path must already be canonical");
      return { path: target, digest: runtimeDigest, mode: `0${(info.mode & 0o777).toString(8)}`, supported: true };
    } catch (error) {
      lastError = error;
    }
  }
  return targets.length > 0
    ? { path: targets.at(-1), digest: null, mode: null, supported: false, error: lastError?.message ?? "No valid administrator Node runtime" }
    : null;
}

async function readdirSafe(target) {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(target);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function currentFixedArtifact(target, label) {
  try {
    const info = await validateRootOwnedFile(target, label, 0o755);
    const bytes = await readFile(target);
    const canonical = await realpath(target);
    if (canonical !== target) throw new Error(`${label} path must already be canonical`);
    return { path: target, digest: await digest(bytes), mode: `0${(info.mode & 0o777).toString(8)}`, supported: true };
  } catch (error) {
    return { path: target, digest: null, mode: null, supported: false, error: error.message };
  }
}

async function requireTrustedRuntime() {
  const running = await realpath(process.execPath).catch(() => null);
  const runtime = await currentRuntime(running);
  if (!runtime?.supported || running !== runtime.path) {
    throw new Error("Administrator operation must run from the digest-bound root-owned Node runtime");
  }
  return runtime;
}

async function validateTrustRoot() {
  await validateRootOwnedFile(TRUST_ROOT, "Trust root", 0o644);
  let directory = path.dirname(await realpath(TRUST_ROOT));
  while (true) {
    const info = await lstat(directory);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      info.uid !== 0 ||
      ((info.mode & 0o777) & 0o022) !== 0
    ) {
      throw new Error(`Unsafe trust-root parent directory: ${directory}`);
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const bytes = await readFile(TRUST_ROOT);
  const value = JSON.parse(bytes.toString("utf8"));
  if (
    value.schemaVersion !== 1 ||
    value.issuer !== ISSUER ||
    !Array.isArray(value.publicKeys) ||
    value.publicKeys.length < 1
  ) {
    throw new Error("Trust root schema is invalid");
  }
  for (const key of value.publicKeys) {
    if (
      typeof key.keyId !== "string" ||
      key.algorithm !== "ed25519" ||
      typeof key.publicKey !== "string"
    ) {
      throw new Error("Trust root public key is invalid");
    }
    createPublicKey({
      key: Buffer.from(key.publicKey, "base64"),
      format: "der",
      type: "spki"
    });
  }
  return { value, digest: await digest(bytes) };
}

function signerCapabilities() {
  return {
    ok: true,
    kind: "host-signer-capabilities",
    schemaVersion: 1,
    version: HOST_SIGNER_VERSION,
    capabilities: [...HOST_SIGNER_CAPABILITIES]
  };
}

function isSignerCapabilityReport(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === "capabilities\0kind\0ok\0schemaVersion\0version" &&
    value.ok === true && value.kind === "host-signer-capabilities" && value.schemaVersion === 1 &&
    value.version === HOST_SIGNER_VERSION &&
    Array.isArray(value.capabilities) &&
    canonicalJson(value.capabilities) === canonicalJson(HOST_SIGNER_CAPABILITIES);
}

async function inspectSignerCapabilityReport(target, runtimePath) {
  const syntax = await spawnCapture(runtimePath, ["--check", target], {
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024
  });
  if (syntax.code !== 0 || syntax.signal !== null || syntax.timedOut) {
    throw new Error(`installed signer syntax check failed: exit=${syntax.code ?? "null"}; signal=${syntax.signal ?? "none"}`);
  }
  const reportResult = await spawnCapture(runtimePath, [target, "capabilities"], {
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024
  });
  if (reportResult.code !== 0 || reportResult.signal !== null || reportResult.timedOut) {
    throw new Error(`installed signer capability report failed: exit=${reportResult.code ?? "null"}; signal=${reportResult.signal ?? "none"}`);
  }
  let report;
  try {
    report = JSON.parse(reportResult.stdout);
  } catch {
    throw new Error("installed signer capability report is not JSON");
  }
  if (!isSignerCapabilityReport(report)) {
    throw new Error("installed signer capability report does not match the host protocol");
  }
  return report;
}

async function currentSigner() {
  const runtime = await currentRuntime();
  for (const target of [INSTALLED_SIGNER, LEGACY_SIGNER]) {
    if (!(await exists(target))) continue;
    try {
      const info = await validateRootOwnedFile(target, "Host signer", 0o755);
      const bytes = await readFile(target);
      const report = target === INSTALLED_SIGNER && runtime?.supported
        ? await inspectSignerCapabilityReport(target, runtime.path)
        : null;
      const supported = target === INSTALLED_SIGNER && report !== null && runtime?.supported === true;
      return {
        path: target,
        digest: await digest(bytes),
        mode: `0${(info.mode & 0o777).toString(8)}`,
        supported,
        version: report?.version ?? null,
        capabilities: report?.capabilities ?? [],
        ...(report ? { capabilityReport: report } : {})
      };
    } catch (error) {
      return {
        path: target,
        digest: null,
        mode: null,
        supported: false,
        version: null,
        capabilities: [],
        error: error.message,
        ...(runtime?.supported ? {} : { runtimeError: runtime?.error ?? "Administrator Node runtime is not installed" })
      };
    }
  }
  return null;
}

async function signingKeyPairChallenge(trust) {
  const key = trust.value.publicKeys[0];
  const trustedPublicKeyBytes = Buffer.from(key.publicKey, "base64");
  const challengePayload = {
    schemaVersion: 1,
    kind: "host-key-pair-challenge",
    issuer: trust.value.issuer,
    keyId: key.keyId,
    trustRootDigest: trust.digest
  };
  const challengeBytes = Buffer.from(canonicalJson(challengePayload), "utf8");
  return {
    key,
    trustedPublicKeyBytes,
    challengeBytes,
    proof: {
      schemaVersion: 1,
      algorithm: "ed25519",
      keyId: key.keyId,
      publicKeyDigest: await digest(trustedPublicKeyBytes),
      challengeDigest: await digest(challengeBytes)
    }
  };
}

export async function validateSigningKeyPair(trust, raw) {
  const privateKey = privateKeyFromRaw(raw);
  const challenge = await signingKeyPairChallenge(trust);
  const trustedPublicKey = createPublicKey({
    key: challenge.trustedPublicKeyBytes,
    format: "der",
    type: "spki"
  });
  const derivedPublicKeyBytes = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  if (!derivedPublicKeyBytes.equals(challenge.trustedPublicKeyBytes)) {
    throw new Error("Private signing key does not match the trust root public key");
  }
  const signature = sign(null, challenge.challengeBytes, privateKey);
  if (!verify(null, challenge.challengeBytes, trustedPublicKey, signature)) {
    throw new Error("Private signing key failed the trust root key-pair challenge");
  }
  return {
    privateKey,
    proof: challenge.proof,
    verified: true
  };
}

function readinessBinding({ trust, privateKey, keyPairProof, runtime, launcher, probe, codexBinary, signer }) {
  return {
    schemaVersion: 1,
    kind: "host-readiness-binding",
    trustRootDigest: trust.digest,
    privateKeyIdentity: privateKey.identity,
    keyPairProof,
    runtime: runtime ? { path: runtime.path, digest: runtime.digest } : null,
    launcher: { path: launcher.path, digest: launcher.digest },
    readinessProbe: { path: probe.path, digest: probe.digest },
    codexBinary: {
      registryDigest: codexBinary.registryDigest,
      validEntries: codexBinary.validEntries
    },
    signer: {
      path: signer?.path ?? null,
      digest: signer?.digest ?? null,
      version: signer?.version ?? null,
      capabilities: signer?.capabilities ?? []
    }
  };
}

async function currentReadinessReceipt(binding) {
  try {
    const info = await validateRootOwnedFile(READINESS_RECEIPT, "Host readiness receipt", 0o644);
    const bytes = await readFile(READINESS_RECEIPT);
    const receipt = JSON.parse(bytes.toString("utf8"));
    const expectedKeys = ["binding", "bindingDigest", "completedAt", "keyPairVerification", "kind", "probeResult", "probeResultDigest", "schemaVersion"];
    const bindingDigest = await digest(Buffer.from(canonicalJson(binding), "utf8"));
    if (Object.keys(receipt).sort().join("\0") !== expectedKeys.sort().join("\0") ||
        receipt.schemaVersion !== 2 || receipt.kind !== "host-readiness-receipt" ||
        typeof receipt.completedAt !== "string" || !SHA256.test(receipt.bindingDigest) ||
        receipt.bindingDigest !== bindingDigest || canonicalJson(receipt.binding) !== canonicalJson(binding) ||
        !receipt.probeResult || typeof receipt.probeResult !== "object" ||
        !SHA256.test(receipt.probeResultDigest) ||
        receipt.probeResultDigest !== await digest(Buffer.from(canonicalJson(receipt.probeResult), "utf8")) ||
        !receipt.keyPairVerification || receipt.keyPairVerification.verified !== true ||
        canonicalJson(receipt.keyPairVerification.proof) !== canonicalJson(binding.keyPairProof)) {
      throw new Error("Host readiness receipt does not bind the current protected host artifacts");
    }
    return {
      path: READINESS_RECEIPT,
      digest: await digest(bytes),
      mode: "0644",
      supported: true,
      bindingDigest: receipt.bindingDigest,
      completedAt: receipt.completedAt,
      keyPairVerification: receipt.keyPairVerification,
      probeResultDigest: receipt.probeResultDigest
    };
  } catch (error) {
    return {
      path: READINESS_RECEIPT,
      digest: null,
      mode: null,
      supported: false,
      error: error.code === "ENOENT" ? "Host readiness receipt is absent" : error.message
    };
  }
}

async function createReadinessReceipt(binding, probeResult, keyPairVerification) {
  if (!probeResult || typeof probeResult !== "object" || Array.isArray(probeResult)) {
    throw new Error("Host readiness receipt requires a verified behavioral probe result");
  }
  if (!keyPairVerification || keyPairVerification.verified !== true ||
      canonicalJson(keyPairVerification.proof) !== canonicalJson(binding.keyPairProof)) {
    throw new Error("Host readiness receipt requires a verified trust-root key-pair challenge");
  }
  const bindingDigest = await digest(Buffer.from(canonicalJson(binding), "utf8"));
  const probeResultDigest = await digest(Buffer.from(canonicalJson(probeResult), "utf8"));
  const payload = {
    schemaVersion: 2,
    kind: "host-readiness-receipt",
    completedAt: new Date().toISOString(),
    binding,
    bindingDigest,
    keyPairVerification,
    probeResult,
    probeResultDigest
  };
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  return { path: READINESS_RECEIPT, bytes, digest: await digest(bytes) };
}

function unsignedSignedValue(value) {
  const { signature, ...payload } = value;
  return payload;
}

async function validateStandingConsentSignature(grant, trust) {
  const key = trust.value.publicKeys.find((item) => item?.keyId === grant.keyId && item.algorithm === "ed25519");
  if (!key || typeof key.publicKey !== "string" || typeof grant.signature !== "string") {
    throw new Error("Standing-consent grant signature identity is invalid");
  }
  const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
  if (!verify(null, Buffer.from(canonicalJson(unsignedSignedValue(grant)), "utf8"), publicKey, Buffer.from(grant.signature, "base64"))) {
    throw new Error("Standing-consent grant signature is invalid");
  }
}

function validateStandingConsentGrantPayload(grant) {
  exactKeys(grant, STANDING_CONSENT_GRANT_FIELDS, "Standing-consent grant");
  exactKeys(grant.subject, ["codexHomePath", "gid", "homePath", "uid", "username"], "Standing-consent subject");
  exactKeys(grant.hostRuntime, ["digest", "path"], "Standing-consent runtime");
  exactKeys(grant.hostSigner, ["digest", "path", "version"], "Standing-consent signer");
  if (grant.schemaVersion !== 1 || grant.kind !== "self-improve-standing-consent-grant" ||
      !SAFE_EXECUTION_ID.test(grant.grantId ?? "") || grant.authorityStatementDigest !== STANDING_CONSENT_AUTHORITY_STATEMENT_DIGEST ||
      grant.provider !== STANDING_CONSENT_PROVIDER || grant.operation !== STANDING_CONSENT_OPERATION ||
      canonicalJson(grant.models) !== canonicalJson(["gpt-5.6-terra"]) ||
      canonicalJson(grant.purposes) !== canonicalJson(STANDING_CONSENT_PURPOSES) || grant.maxRequests !== 8 ||
      grant.policyPath !== STANDING_CONSENT_POLICY || !SHA256.test(grant.policyDigest ?? "") ||
      typeof grant.repo !== "string" || !path.isAbsolute(grant.repo) || path.resolve(grant.repo) !== grant.repo ||
      typeof grant.requestRoot !== "string" || grant.requestRoot !== `${STANDING_CONSENT_REQUEST_ROOT_PREFIX}${grant.subject.uid}` ||
      !Number.isInteger(grant.subject.uid) || grant.subject.uid <= 0 || !Number.isInteger(grant.subject.gid) || grant.subject.gid <= 0 ||
      typeof grant.subject.username !== "string" || !/^[A-Za-z0-9._-]+$/.test(grant.subject.username) ||
      typeof grant.subject.homePath !== "string" || !path.isAbsolute(grant.subject.homePath) ||
      (grant.subject.codexHomePath !== null && (typeof grant.subject.codexHomePath !== "string" || !path.isAbsolute(grant.subject.codexHomePath))) ||
      grant.readOnly !== true || grant.ephemeral !== true || grant.sanitized !== true ||
      canonicalJson(grant.deniedAuthorities) !== canonicalJson(STANDING_CONSENT_DENIED_AUTHORITIES) ||
      !SHA256.test(grant.hostRuntime.digest ?? "") || typeof grant.hostRuntime.path !== "string" || !path.isAbsolute(grant.hostRuntime.path) ||
      !SHA256.test(grant.hostSigner.digest ?? "") || grant.hostSigner.path !== INSTALLED_SIGNER || grant.hostSigner.version !== HOST_SIGNER_VERSION ||
      typeof grant.issuedAt !== "string" || !Number.isFinite(Date.parse(grant.issuedAt)) ||
      (grant.expiresAt !== null && (typeof grant.expiresAt !== "string" || !Number.isFinite(Date.parse(grant.expiresAt)))) ||
      (grant.revokedAt !== null && (typeof grant.revokedAt !== "string" || !Number.isFinite(Date.parse(grant.revokedAt))))) {
    throw new Error("Standing-consent grant payload is invalid");
  }
  return grant;
}

async function currentStandingConsent({ trust, runtime, signer }) {
  try {
    await validateRootOwnedFile(STANDING_CONSENT_POLICY, "Standing-consent policy", 0o644);
    const policyBytes = await readFile(STANDING_CONSENT_POLICY);
    const policy = validateStandingConsentPolicy(JSON.parse(policyBytes.toString("utf8")));
    const policyDigest = await digest(policyBytes);
    await validateRootOwnedFile(STANDING_CONSENT_GRANT, "Standing-consent grant", 0o644);
    const grantBytes = await readFile(STANDING_CONSENT_GRANT);
    const signedGrant = JSON.parse(grantBytes.toString("utf8"));
    exactKeys(signedGrant, [...STANDING_CONSENT_GRANT_FIELDS, "signature"], "Signed standing-consent grant");
    const grant = validateStandingConsentGrantPayload(unsignedSignedValue(signedGrant));
    await validateStandingConsentSignature(signedGrant, trust);
    if (grant.issuer !== trust.value.issuer || grant.policyDigest !== policyDigest ||
        canonicalJson(grant.hostRuntime) !== canonicalJson({ path: runtime?.path, digest: runtime?.digest }) ||
        canonicalJson(grant.hostSigner) !== canonicalJson({ path: signer?.path, digest: signer?.digest, version: signer?.version })) {
      throw new Error("Standing-consent grant is stale against the current host policy, runtime, or signer");
    }
    if (grant.revokedAt !== null) throw new Error("Standing-consent grant is revoked");
    if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Standing-consent grant is expired");
    await validateRootOwnedFile(STANDING_CONSENT_SUDOERS, "Standing-consent sudoers rule", 0o440);
    // sudoers(5) requires this file to remain root-owned and non-world-readable.
    // A non-root status probe therefore derives the expected digest from the
    // verified signed grant and defers byte-for-byte validation to the root
    // execute-consented-batch path. Root always reads and compares the file
    // before accepting a manifest.
    const sudoersBytes = typeof process.geteuid === "function" && process.geteuid() !== 0
      ? null
      : await readFile(STANDING_CONSENT_SUDOERS);
    const sudoersEvidence = await standingConsentSudoersEvidence({ grant, runtime, actualBytes: sudoersBytes });
    return {
      active: true,
      state: "active",
      policyPath: STANDING_CONSENT_POLICY,
      policyDigest,
      grantPath: STANDING_CONSENT_GRANT,
      grantDigest: await digest(Buffer.from(canonicalJson(grant), "utf8")),
      sudoersPath: STANDING_CONSENT_SUDOERS,
      sudoersDigest: sudoersEvidence.digest,
      sudoersVerification: sudoersEvidence.verification,
      grant,
      policy
    };
  } catch (error) {
    const artifactPresence = {
      policy: await exists(STANDING_CONSENT_POLICY),
      grant: await exists(STANDING_CONSENT_GRANT),
      sudoers: await exists(STANDING_CONSENT_SUDOERS)
    };
    const state = error.message === "Standing-consent grant is revoked"
      ? "revoked"
      : Object.values(artifactPresence).every((present) => !present)
        ? "not-installed"
        : "invalid";
    return {
      active: false,
      state,
      artifactPresence,
      policyPath: STANDING_CONSENT_POLICY,
      grantPath: STANDING_CONSENT_GRANT,
      sudoersPath: STANDING_CONSENT_SUDOERS,
      error: error.code === "ENOENT" ? "Standing evaluator consent is not installed" : error.message
    };
  }
}

async function status({ requireReadinessReceipt = true } = {}) {
  const trust = await validateTrustRoot();
  const keyInfo = await validateRootOwnedFile(PRIVATE_KEY, "Private signing key", 0o600);
  const keyPairProof = (await signingKeyPairChallenge(trust)).proof;
  const privateKey = {
    path: PRIVATE_KEY,
    bytes: keyInfo.size,
    mode: "0600",
    identity: {
      uid: keyInfo.uid,
      mode: keyInfo.mode & 0o777,
      device: Number.isSafeInteger(keyInfo.dev) ? keyInfo.dev : null,
      inode: Number.isSafeInteger(keyInfo.ino) ? keyInfo.ino : null,
      size: keyInfo.size,
      mtimeMs: keyInfo.mtimeMs,
      ctimeMs: keyInfo.ctimeMs
    },
    keyPairProof
  };
  const runtime = await currentRuntime();
  const launcher = await currentFixedArtifact(EXECUTION_LAUNCHER, "Native execution launcher");
  const probe = await currentFixedArtifact(EXECUTION_PROBE, "Host readiness probe");
  const codexBinary = await currentCodexApproval();
  const signer = await currentSigner();
  const binding = readinessBinding({
    trust,
    privateKey,
    keyPairProof,
    runtime,
    launcher,
    probe,
    codexBinary,
    signer
  });
  const readinessReceipt = await currentReadinessReceipt(binding);
  const standingConsent = await currentStandingConsent({ trust, runtime, signer });
  const staticReady = Boolean(signer?.supported && runtime?.supported && launcher.supported && probe.supported && codexBinary.supported);
  return {
    ok: true,
    provisioned: true,
    ready: staticReady && (!requireReadinessReceipt || readinessReceipt.supported),
    trustRoot: {
      path: TRUST_ROOT,
      issuer: trust.value.issuer,
      keyIds: trust.value.publicKeys.map((item) => item.keyId),
      digest: trust.digest,
      mode: "0644"
    },
    privateKey,
    keyPairVerification: readinessReceipt.keyPairVerification ?? null,
    runtime,
    launcher,
    readinessProbe: probe,
    codexBinary,
    signer,
    readinessReceipt,
    standingConsent
  };
}

async function validateConsentUserDirectory(target, subject, label, expectedMode = 0o700) {
  const resolved = path.resolve(target);
  if (resolved !== target) throw new Error(`${label} must already be canonical`);
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new Error(`${label} must not contain symlinks`);
  const info = await lstat(canonical);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== subject.uid || (info.mode & 0o777) !== expectedMode) {
    throw new Error(`${label} must be a subject-owned ${expectedMode.toString(8)} directory`);
  }
  return canonical;
}

async function validateConsentUserFile(target, subject, label, root) {
  if (typeof target !== "string" || !path.isAbsolute(target) || path.resolve(target) !== target || !isWithin(root, target)) {
    throw new Error(`${label} must be a canonical path inside the standing-consent request root`);
  }
  const canonical = await realpath(target);
  if (canonical !== target) throw new Error(`${label} must not be a symlink`);
  const info = await lstat(canonical);
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== subject.uid || (info.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must be a subject-owned 0600 regular file`);
  }
  return { path: canonical, info, bytes: await readFile(canonical) };
}

async function canonicalUsername(uid) {
  const result = await spawnCapture("/usr/bin/id", ["-un", String(uid)], {
    cwd: "/",
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    env: safeEnvironment()
  });
  const username = result.stdout.trim();
  if (result.code !== 0 || result.signal !== null || !/^[A-Za-z0-9._-]+$/.test(username)) {
    throw new Error("Standing-consent subject username could not be resolved safely");
  }
  return username;
}

function validateConsentInstallRequest(value) {
  exactKeys(value, [
    "authorityStatementDigest", "expiresAt", "grantId", "kind", "maxRequests", "models", "policyDigest", "policyPath",
    "policySource", "purposes", "repo", "requestRoot", "schemaVersion", "subject"
  ], "Standing-consent install request");
  exactKeys(value.subject, ["codexHomePath", "gid", "homePath", "uid", "username"], "Standing-consent install subject");
  if (value.schemaVersion !== 1 || value.kind !== "self-improve-standing-consent-install-request" ||
      !SAFE_EXECUTION_ID.test(value.grantId ?? "") || value.authorityStatementDigest !== STANDING_CONSENT_AUTHORITY_STATEMENT_DIGEST ||
      canonicalJson(value.models) !== canonicalJson(["gpt-5.6-terra"]) ||
      canonicalJson(value.purposes) !== canonicalJson(STANDING_CONSENT_PURPOSES) || value.maxRequests !== 8 || value.expiresAt !== null ||
      typeof value.repo !== "string" || !path.isAbsolute(value.repo) || path.resolve(value.repo) !== value.repo ||
      value.policyPath !== path.join(value.repo, "plugins/better-workflows/config/self-improve-standing-consent-v1.json") ||
      typeof value.policySource !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.policySource) ||
      !SHA256.test(value.policyDigest ?? "") || !Number.isInteger(value.subject.uid) || value.subject.uid <= 0 ||
      !Number.isInteger(value.subject.gid) || value.subject.gid <= 0 ||
      typeof value.subject.username !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.subject.username) ||
      typeof value.subject.homePath !== "string" || !path.isAbsolute(value.subject.homePath) ||
      (value.subject.codexHomePath !== null && (typeof value.subject.codexHomePath !== "string" || !path.isAbsolute(value.subject.codexHomePath))) ||
      value.requestRoot !== `${STANDING_CONSENT_REQUEST_ROOT_PREFIX}${value.subject.uid}`) {
    throw new Error("Standing-consent install request is invalid");
  }
  return value;
}

async function validateSudoersCandidate(bytes) {
  const temporary = path.join(path.dirname(STANDING_CONSENT_SUDOERS), `.better-workflows-self-improve.${process.pid}.${Date.now()}`);
  await exclusiveWrite(temporary, bytes, 0o440);
  try {
    const result = await spawnCapture(VISUDO, ["-cf", temporary], {
      cwd: "/",
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024,
      env: safeEnvironment()
    });
    if (result.code !== 0 || result.signal !== null || result.timedOut || result.outputExceeded) {
      throw new Error(`visudo rejected the standing-consent rule: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function installStandingConsent(requestPath, confirmedDigest) {
  requireRoot();
  await requireInstalledCapability("standing-consent-admin");
  if (!SHA256.test(confirmedDigest)) throw new Error("Standing-consent install request digest must be SHA-256");
  const preliminaryBytes = await readFile(path.resolve(requestPath));
  if (await digest(preliminaryBytes) !== confirmedDigest) throw new Error("Standing-consent install request digest changed");
  const request = validateConsentInstallRequest(JSON.parse(preliminaryBytes.toString("utf8")));
  const requestRoot = await validateConsentUserDirectory(request.requestRoot, request.subject, "Standing-consent request root");
  const requestFile = await validateConsentUserFile(path.resolve(requestPath), request.subject, "Standing-consent install request", requestRoot);
  if (await digest(requestFile.bytes) !== confirmedDigest) throw new Error("Standing-consent install request changed after identity validation");
  const repository = await realpath(request.repo);
  if (repository !== request.repo) throw new Error("Standing-consent repository must already be canonical");
  const username = await canonicalUsername(request.subject.uid);
  if (username !== request.subject.username) throw new Error("Standing-consent username does not match the subject uid");
  const homePath = await validateConsentUserDirectory(request.subject.homePath, request.subject, "Standing-consent subject home", (await lstat(request.subject.homePath)).mode & 0o777);
  if (((await lstat(homePath)).mode & 0o022) !== 0) throw new Error("Standing-consent subject home must not be group/world writable");
  if (request.subject.codexHomePath !== null) {
    const codexHome = await realpath(request.subject.codexHomePath);
    const info = await lstat(codexHome);
    if (codexHome !== request.subject.codexHomePath || info.isSymbolicLink() || !info.isDirectory() || info.uid !== request.subject.uid || ((info.mode & 0o777) & 0o022) !== 0) {
      throw new Error("Standing-consent Codex home identity is invalid");
    }
  }
  const policyBytes = Buffer.from(request.policySource, "base64");
  if (policyBytes.toString("base64") !== request.policySource || await digest(policyBytes) !== request.policyDigest) {
    throw new Error("Standing-consent embedded policy source is not canonical or digest-bound");
  }
  const policySource = { bytes: policyBytes, digest: request.policyDigest };
  const policy = validateStandingConsentPolicy(JSON.parse(policyBytes.toString("utf8")));
  const runtime = await currentRuntime();
  const signer = await currentSigner();
  if (!runtime?.supported || !signer?.supported || signer.path !== INSTALLED_SIGNER || signer.version !== HOST_SIGNER_VERSION) {
    throw new Error("Standing-consent install requires the current ready runtime and signer");
  }
  const trust = await validateTrustRoot();
  const key = trust.value.publicKeys[0];
  const grantPayload = validateStandingConsentGrantPayload({
    schemaVersion: 1,
    kind: "self-improve-standing-consent-grant",
    grantId: request.grantId,
    authorityStatementDigest: request.authorityStatementDigest,
    issuedAt: new Date().toISOString(),
    expiresAt: request.expiresAt,
    revokedAt: null,
    issuer: trust.value.issuer,
    keyId: key.keyId,
    repo: repository,
    provider: policy.provider,
    operation: policy.operation,
    models: policy.allowedModels,
    purposes: policy.allowedPurposes,
    maxRequests: policy.maxRequests,
    requestRoot,
    subject: request.subject,
    policyPath: STANDING_CONSENT_POLICY,
    policyDigest: request.policyDigest,
    readOnly: true,
    ephemeral: true,
    sanitized: true,
    deniedAuthorities: STANDING_CONSENT_DENIED_AUTHORITIES,
    hostRuntime: { path: runtime.path, digest: runtime.digest },
    hostSigner: { path: signer.path, digest: signer.digest, version: signer.version }
  });
  const signedGrant = await signPayload(grantPayload);
  const grantBytes = Buffer.from(`${JSON.stringify(signedGrant.signed, null, 2)}\n`);
  const sudoersBytes = Buffer.from(standingConsentSudoers({ grant: grantPayload, runtime }), "utf8");
  await validateSudoersCandidate(sudoersBytes);
  const changes = [];
  try {
    for (const [target, bytes, mode, label] of [
      [STANDING_CONSENT_POLICY, policySource.bytes, 0o644, "Standing-consent policy"],
      [STANDING_CONSENT_GRANT, grantBytes, 0o644, "Standing-consent grant"],
      [STANDING_CONSENT_SUDOERS, sudoersBytes, 0o440, "Standing-consent sudoers rule"]
    ]) {
      const source = { bytes, digest: await digest(bytes) };
      const change = await replaceRootOwnedFile(target, source, mode, label);
      if (change.changed) changes.push({ target, label, mode, previous: change.previous });
    }
    const next = await status();
    if (!next.standingConsent?.active) throw new Error(`Standing consent did not become active: ${next.standingConsent?.error ?? "unknown error"}`);
    return next.standingConsent;
  } catch (error) {
    const recoveryErrors = [];
    for (const change of changes.toReversed()) {
      try {
        await restoreRootOwnedFile(change.target, change.previous, change.mode, change.label);
        if (change.previous) await discardRollbackBackup(change.previous, change.label);
      } catch (recoveryError) {
        recoveryErrors.push(`${change.label}: ${recoveryError.message}`);
      }
    }
    if (recoveryErrors.length > 0) throw new Error(`Standing-consent install failed and rollback was incomplete: ${error.message}; ${recoveryErrors.join("; ")}`);
    throw new Error(`Standing-consent install rolled back: ${error.message}`);
  }
}

async function revokeStandingConsent(grantId) {
  requireRoot();
  await requireInstalledCapability("standing-consent-admin");
  if (!SAFE_EXECUTION_ID.test(grantId ?? "")) throw new Error("Standing-consent revoke requires a safe grant id");
  await validateRootOwnedFile(STANDING_CONSENT_GRANT, "Standing-consent grant", 0o644);
  const signed = JSON.parse((await readFile(STANDING_CONSENT_GRANT)).toString("utf8"));
  exactKeys(signed, [...STANDING_CONSENT_GRANT_FIELDS, "signature"], "Signed standing-consent grant");
  const grant = validateStandingConsentGrantPayload(unsignedSignedValue(signed));
  await validateStandingConsentSignature(signed, await validateTrustRoot());
  if (grant.grantId !== grantId) throw new Error("Standing-consent grant id does not match the installed grant");
  const revoked = { ...grant, revokedAt: new Date().toISOString() };
  const replacement = await signPayload(revoked);
  const bytes = Buffer.from(`${JSON.stringify(replacement.signed, null, 2)}\n`);
  await replaceRootOwnedFile(STANDING_CONSENT_GRANT, { bytes, digest: await digest(bytes) }, 0o644, "Standing-consent grant");
  await unlink(STANDING_CONSENT_SUDOERS).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return { ok: true, grantId, revokedAt: revoked.revokedAt };
}

async function provision() {
  requireRoot();
  await requireTrustedRuntime();
  for (const target of [TRUST_ROOT, PRIVATE_KEY, INSTALLED_SIGNER]) {
    if (await exists(target)) {
      throw new Error(`Refusing implicit rotation or overwrite: ${target}`);
    }
  }
  await secureDirectory("/private/etc/better-workflows", 0o755);
  await secureDirectory("/private/var/db/better-workflows", 0o711);
  await secureDirectory("/private/var/db/better-workflows/bin", 0o755);
  await secureDirectory(ATTESTATIONS, 0o755);
  await secureDirectory(EXECUTIONS, 0o755);
  await secureDirectory(EXECUTION_BUNDLES, 0o755);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
  const rawSeed = privateDer.subarray(-32);
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const keyId = `codex-ed25519-${new Date().toISOString().slice(0, 7)}`;
  const trustRoot = {
    schemaVersion: 1,
    issuer: ISSUER,
    publicKeys: [
      {
        keyId,
        algorithm: "ed25519",
        publicKey: publicDer.toString("base64")
      }
    ]
  };
  const created = [];
  try {
    await exclusiveWrite(PRIVATE_KEY, rawSeed, 0o600);
    created.push(PRIVATE_KEY);
    await exclusiveWrite(TRUST_ROOT, `${JSON.stringify(trustRoot, null, 2)}\n`, 0o644);
    created.push(TRUST_ROOT);
    await exclusiveWrite(
      INSTALLED_SIGNER,
      await readFile(fileURLToPath(import.meta.url)),
      0o755
    );
    created.push(INSTALLED_SIGNER);
    return await status();
  } catch (error) {
    for (const target of created.reverse()) {
      await unlink(target).catch(() => undefined);
    }
    throw error;
  }
}

export function privateKeyFromRaw(raw) {
  if (raw.length !== 32) throw new Error("Private signing key must contain a 32-byte Ed25519 seed");
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({
    key: Buffer.concat([prefix, raw]),
    format: "der",
    type: "pkcs8"
  });
}

function validateExecution(execution) {
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    throw new Error("execution must be an object");
  }
  const expected = [
    "attempt",
    "baselineRevision",
    "candidateDigest",
    "headRevision",
    "id",
    "promptDigest",
    "role",
    "runId",
    "sourceBindingDigest",
    "suiteDigest"
  ];
  const executionKeys = Object.keys(execution).sort();
  const policyBound = execution.purpose !== undefined || execution.policyDigest !== undefined;
  const standing = execution.authorization !== undefined;
  const expectedKeys = [
    ...expected,
    ...(policyBound ? ["policyDigest", "purpose"] : []),
    ...(standing ? ["authorization"] : [])
  ].sort();
  if (executionKeys.join("\0") !== expectedKeys.join("\0")) {
    throw new Error("execution fields do not match the verifier contract");
  }
  if (policyBound && (!policyBindingForPurpose(execution.purpose) || !SHA256.test(execution.policyDigest))) {
    throw new Error("Policy-bound execution binding is invalid");
  }
  if (standing) {
    const authorization = validateStandingAuthorization(execution.authorization);
    if (authorization.purpose !== (execution.purpose ?? authorization.purpose)) {
      throw new Error("Standing authorization purpose does not match the execution purpose");
    }
  }
  for (const key of expected.filter((item) => item !== "attempt")) {
    if (typeof execution[key] !== "string" || !execution[key]) {
      throw new Error(`execution.${key} must be a non-empty string`);
    }
  }
  requireSafeExecutionId(execution.id);
  if (!Number.isInteger(execution.attempt) || execution.attempt < 1 || execution.attempt > 3) {
    throw new Error("execution.attempt must be 1..3");
  }
  if (!SHA256.test(execution.promptDigest)) {
    throw new Error("execution.promptDigest must be a SHA-256 digest");
  }
  if (!SHA1.test(execution.headRevision)) {
    throw new Error("execution.headRevision must be a Git commit SHA");
  }
  if (!SHA256.test(execution.sourceBindingDigest)) {
    throw new Error("execution.sourceBindingDigest must be SHA-256");
  }
  return execution;
}

function validateMaterialBinding(value, authorization) {
  exactKeys(value, ["files", "materialsDigest", "sanitizerPolicyDigest", "schemaVersion", "snapshotDigest"], "Material binding");
  if (value.schemaVersion !== 1 || !SHA256.test(value.sanitizerPolicyDigest ?? "") ||
      value.sanitizerPolicyDigest !== authorization.policyDigest || !SHA256.test(value.snapshotDigest ?? "") ||
      !SHA256.test(value.materialsDigest ?? "") || !Array.isArray(value.files)) {
    throw new Error("Material binding is invalid");
  }
  for (const file of value.files) {
    exactKeys(file, ["digest", "mode", "path", "size", "state"], "Material manifest file");
    if (typeof file.path !== "string" || !file.path || path.isAbsolute(file.path) || file.path.includes("..") ||
        !["file", "missing"].includes(file.state) ||
        (file.state === "file" && (!SHA256.test(file.digest ?? "") || !Number.isInteger(file.size) || file.size < 0 || ![0o644, 0o755].includes(file.mode))) ||
        (file.state === "missing" && (file.digest !== null || file.size !== null || file.mode !== null))) {
      throw new Error("Material manifest contains an invalid file binding");
    }
  }
  return value;
}

async function canonicalBinary(supplied) {
  if (typeof supplied !== "string" || !path.isAbsolute(supplied)) {
    throw new Error("binaryPath must be absolute");
  }
  const resolved = await realpath(supplied);
  if (resolved !== supplied) throw new Error("binaryPath must already be canonical");
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink() || ((info.mode & 0o777) & 0o022) !== 0) {
    throw new Error("binaryPath must be a regular non-writable file");
  }
  return resolved;
}

async function currentCodexApproval() {
  try {
    const allowlist = await validateCodexAllowlist();
    const validEntries = [];
    for (const entry of allowlist.value.entries) {
      try {
        const resolved = await canonicalBinary(entry.path);
        const bytes = await readFile(resolved);
        const actualDigest = await digest(bytes);
        if (resolved === entry.path && isMachO(bytes) && actualDigest === entry.digest) {
          validEntries.push({ path: entry.path, digest: entry.digest });
        }
      } catch {
        // A stale or changed approved path keeps the host unready until re-approved.
      }
    }
    return {
      path: CODEX_ALLOWLIST,
      registryDigest: allowlist.digest,
      entries: allowlist.value.entries,
      validEntries,
      supported: validEntries.length > 0
    };
  } catch (error) {
    return {
      path: CODEX_ALLOWLIST,
      registryDigest: null,
      entries: [],
      validEntries: [],
      supported: false,
      error: error.message
    };
  }
}

async function requireApprovedCodexBinary(binaryPath, binaryDigest) {
  const resolved = await canonicalBinary(binaryPath);
  const allowlist = await validateCodexAllowlist();
  const approved = allowlist.value.entries.find((entry) => entry.path === resolved && entry.digest === binaryDigest);
  if (!approved) {
    throw new Error("Codex binary is not administrator-approved by the fixed host allowlist");
  }
  const bytes = await readFile(resolved);
  const actualDigest = await digest(bytes);
  if (!isMachO(bytes)) {
    throw new Error("Approved Codex binary must be a native Mach-O executable");
  }
  if (actualDigest !== binaryDigest) {
    throw new Error("Codex binary changed after administrator approval");
  }
  return { sourcePath: resolved, digest: actualDigest, registryDigest: allowlist.digest };
}

async function approvedCodexAllowlistSource(binaryPath, confirmedDigest) {
  const resolved = await canonicalBinary(binaryPath);
  const binaryBytes = await readFile(resolved);
  if (!isMachO(binaryBytes)) throw new Error("Approved Codex binary must be a native Mach-O executable");
  const actualDigest = await digest(binaryBytes);
  if (actualDigest !== confirmedDigest) {
    throw new Error("Approved Codex binary digest does not match administrator-confirmed digest");
  }
  let entries = [];
  if (await exists(CODEX_ALLOWLIST)) {
    entries = (await validateCodexAllowlist()).value.entries;
  }
  const next = [
    ...entries.filter((entry) => entry.path !== resolved),
    { path: resolved, digest: actualDigest }
  ].sort((left, right) => left.path.localeCompare(right.path));
  const value = {
    schemaVersion: 1,
    kind: "codex-binary-allowlist",
    entries: next
  };
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  return { path: resolved, digest: actualDigest, source: { bytes, digest: await digest(bytes) } };
}

export function validateExecutionRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("execution request must be an object");
  }
  const required = ["binaryApprovalDigest", "binaryDigest", "binaryPath", "codexHomePath", "execution", "gid", "homePath", "model", "pluginBundleDigest", "promptDigest", "promptPath", "uid"];
  const requestKeys = Object.keys(request).sort();
  const policyBound = request.purpose !== undefined || request.policyDigest !== undefined;
  const standing = request.authorization !== undefined || request.materialBinding !== undefined;
  const expectedKeys = [
    ...required,
    ...(policyBound ? ["policyDigest", "purpose"] : []),
    ...(standing ? ["authorization", "materialBinding"] : [])
  ].sort();
  if (requestKeys.join("\0") !== expectedKeys.join("\0")) {
    throw new Error("execution request fields do not match the signer contract");
  }
  if (policyBound && (!policyBindingForPurpose(request.purpose) || !SHA256.test(request.policyDigest))) {
    throw new Error("Policy-bound execution request binding is invalid");
  }
  if (!SHA256.test(request.promptDigest)) {
    throw new Error("execution request prompt digest is invalid");
  }
  if (!SHA256.test(request.binaryDigest)) {
    throw new Error("execution request binary digest is invalid");
  }
  if (!SHA256.test(request.binaryApprovalDigest)) {
    throw new Error("execution request binary approval digest is invalid");
  }
  if (!SHA256.test(request.pluginBundleDigest)) {
    throw new Error("execution request plugin bundle digest is invalid");
  }
  if (typeof request.promptPath !== "string" || !path.isAbsolute(request.promptPath)) {
    throw new Error("execution request prompt path must be absolute");
  }
  if (!Number.isInteger(request.uid) || request.uid <= 0 || !Number.isInteger(request.gid) || request.gid <= 0) {
    throw new Error("execution request run-as identity is invalid");
  }
  if (typeof request.homePath !== "string" || !path.isAbsolute(request.homePath)) {
    throw new Error("execution request home path must be absolute");
  }
  if (request.codexHomePath !== null && (typeof request.codexHomePath !== "string" || !path.isAbsolute(request.codexHomePath))) {
    throw new Error("execution request Codex home path must be absolute or null");
  }
  if (typeof request.model !== "string" || !request.model || request.model.length > 128) {
    throw new Error("execution request model is invalid");
  }
  validateExecution(request.execution);
  if (standing) {
    const authorization = validateStandingAuthorization(request.authorization);
    validateMaterialBinding(request.materialBinding, authorization);
    if (canonicalJson(request.execution.authorization) !== canonicalJson(authorization) ||
        authorization.model !== request.model || authorization.purpose !== (request.purpose ?? authorization.purpose) ||
        authorization.subject.uid !== request.uid || authorization.subject.gid !== request.gid ||
        authorization.subject.homePath !== request.homePath || authorization.subject.codexHomePath !== request.codexHomePath) {
      throw new Error("Standing request authorization does not match its execution, model, purpose, or run-as identity");
    }
  }
  if (policyBound && (request.execution.purpose !== request.purpose || request.execution.policyDigest !== request.policyDigest)) {
    throw new Error("Policy-bound request and execution bindings do not match");
  }
  if (!policyBound && (request.execution.purpose !== undefined || request.execution.policyDigest !== undefined)) {
    throw new Error("Ordinary execution request cannot carry a policy-bound binding");
  }
  if (request.promptDigest !== request.execution.promptDigest) {
    throw new Error("execution request prompt digest does not match execution");
  }
  return request;
}

async function requireInstalledCapability(
  capability,
  { allowUnprovenReadiness = false, allowUpgradeEntrypoint = false } = {}
) {
  await requireTrustedRuntime();
  const signer = await currentSigner();
  if (!signer?.supported || signer.path !== INSTALLED_SIGNER || !signer.capabilities.includes(capability)) {
    throw new Error(`Installed administrator signer lacks required capability: ${capability}`);
  }
  if (!allowUnprovenReadiness) {
    const readiness = await status();
    if (!readiness.ready) {
      throw new Error("Administrator host runtime readiness receipt is absent or stale");
    }
  }
  const running = await realpath(fileURLToPath(import.meta.url));
  const runningDigest = await digest(await readFile(running));
  if (!allowUpgradeEntrypoint && (running !== INSTALLED_SIGNER || runningDigest !== signer.digest)) {
    throw new Error("Administrator operation must run from the installed, capability-checked signer");
  }
  return signer;
}

async function signPayload(payload) {
  const trust = await validateTrustRoot();
  await validateRootOwnedFile(PRIVATE_KEY, "Private signing key", 0o600);
  const key = trust.value.publicKeys[0];
  const keyPair = await validateSigningKeyPair(trust, await readFile(PRIVATE_KEY));
  const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), keyPair.privateKey).toString("base64");
  return {
    signed: { ...payload, signature },
    trustRootDigest: await digest(Buffer.from(canonicalJson(trust.value), "utf8"))
  };
}

async function writeHostArtifact(target, value) {
  if (!path.isAbsolute(target)) throw new Error("Host artifact path must be absolute");
  await validateProtectedParentChain(target, "Host artifact");
  return exclusiveWrite(target, `${JSON.stringify(value, null, 2)}\n`, 0o644);
}

async function validatePrompt(request) {
  const target = path.resolve(request.promptPath);
  if (target !== request.promptPath) throw new Error("Execution request prompt path must already be canonical");
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || ((info.mode & 0o777) & 0o022) !== 0) {
    throw new Error("Execution request prompt must be a regular, non-writable file");
  }
  if (info.size > MAX_PROMPT_BYTES) throw new Error("Execution request prompt exceeds the configured limit");
  const bytes = await readFile(target);
  if (await digest(bytes) !== request.promptDigest) {
    throw new Error("Execution request prompt digest does not match the host-captured prompt");
  }
  return bytes;
}

async function validateRunAs(request) {
  const homePath = await realpath(request.homePath);
  if (homePath !== request.homePath) throw new Error("Execution request home path must already be canonical");
  const homeInfo = await lstat(homePath);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink() || homeInfo.uid !== request.uid || ((homeInfo.mode & 0o777) & 0o022) !== 0) {
    throw new Error("Execution request home directory is not owned and protected for the requested user");
  }
  let codexHomePath = null;
  if (request.codexHomePath !== null) {
    codexHomePath = await realpath(request.codexHomePath);
    if (codexHomePath !== request.codexHomePath) throw new Error("Execution request Codex home path must already be canonical");
    const codexInfo = await lstat(codexHomePath);
    if (!codexInfo.isDirectory() || codexInfo.isSymbolicLink() || codexInfo.uid !== request.uid || ((codexInfo.mode & 0o777) & 0o022) !== 0) {
      throw new Error("Execution request Codex home is not owned and protected for the requested user");
    }
  }
  return { uid: request.uid, gid: request.gid, homePath, codexHomePath };
}

async function executeResultRequest(
  requestPath,
  confirmedDigest,
  { includeResponse = false, commandArgs = null, internalProbe = false, requiredAuthorization = null } = {}
) {
  requireRoot();
  await requireInstalledCapability("execution-witness", {
    allowUnprovenReadiness: internalProbe,
    allowUpgradeEntrypoint: internalProbe
  });
  if (!SHA256.test(confirmedDigest)) throw new Error("confirmed execution request digest must be SHA-256");
  const resolvedRequest = path.resolve(requestPath);
  const requestBytes = await readFile(resolvedRequest);
  if (await digest(requestBytes) !== confirmedDigest) {
    throw new Error("execution request digest does not match administrator-confirmed digest");
  }
  const request = validateExecutionRequest(JSON.parse(requestBytes.toString("utf8")));
  if (request.authorization !== undefined && requiredAuthorization === null) {
    throw new Error("Standing-authorized execution requests require execute-consented-batch");
  }
  if (requiredAuthorization !== null && canonicalJson(request.authorization) !== canonicalJson(requiredAuthorization)) {
    throw new Error("Standing execution request authorization changed before execution");
  }
  const executionId = requireSafeExecutionId(request.execution.id);
  const binaryPath = await canonicalBinary(request.binaryPath);
  const binaryBytes = await readFile(binaryPath);
  const binaryDigest = await digest(binaryBytes);
  if (binaryDigest !== request.binaryDigest) {
    throw new Error("execution request binary digest does not match the administrator-confirmed binary");
  }
  if (internalProbe) {
    if (binaryPath !== EXECUTION_PROBE || commandArgs !== null && commandArgs.length !== 0) {
      throw new Error("Internal readiness execution must use the fixed zero-argument probe");
    }
  } else {
    const approval = await requireApprovedCodexBinary(binaryPath, request.binaryDigest);
    if (request.binaryApprovalDigest !== approval.registryDigest) {
      throw new Error("execution request binary approval registry digest does not match the installed allowlist");
    }
  }
  const promptBytes = await validatePrompt(request);
  const runAs = await validateRunAs(request);
  await validateRootOwnedFile(EXECUTION_LAUNCHER, "Native execution launcher", 0o755);
  await secureDirectory(EXECUTIONS, 0o755);
  await secureDirectory(ATTESTATIONS, 0o755);
  await secureDirectory(EXECUTION_BUNDLES, 0o755);
  const names = {
    binary: `${executionId}.codex`,
    attestation: `${executionId}.attestation.json`,
    receipt: `${executionId}.receipt.json`,
    ledgerStart: `${executionId}.ledger.start.json`,
    ledger: `${executionId}.ledger.json`,
    result: `${executionId}.result.json`,
    failure: `${executionId}.failure.json`
  };
  const targets = {
    binary: path.join(EXECUTIONS, names.binary),
    attestation: path.join(ATTESTATIONS, names.attestation),
    receipt: path.join(ATTESTATIONS, names.receipt),
    ledgerStart: path.join(EXECUTIONS, names.ledgerStart),
    ledger: path.join(EXECUTIONS, names.ledger),
    result: path.join(EXECUTIONS, names.result),
    failure: path.join(EXECUTIONS, names.failure)
  };
  for (const [label, target] of Object.entries(targets)) {
    if (path.dirname(target) !== (label === "attestation" || label === "receipt" ? ATTESTATIONS : EXECUTIONS)) {
      throw new Error("Host execution artifact path escapes its fixed root");
    }
    if (await exists(target)) throw new Error(`Refusing to reuse host execution artifact: ${target}`);
  }
  await exclusiveWrite(targets.binary, binaryBytes, 0o755);
  await validateRootOwnedFile(targets.binary, "Staged Codex binary", 0o755);
  const stagedBinaryPath = await realpath(targets.binary);
  if (stagedBinaryPath !== targets.binary) throw new Error("Staged Codex binary path must be canonical");
  const binary = {
    path: stagedBinaryPath,
    digest: binaryDigest,
    sourcePath: binaryPath,
    approvalDigest: request.binaryApprovalDigest
  };
  const trust = await validateTrustRoot();
  const key = trust.value.publicKeys[0];
  const issuedAt = new Date();
  const attestationPayload = {
    schemaVersion: 1,
    provider: "codex",
    kind: "execution-binding",
    model: request.model,
    issuer: trust.value.issuer,
    keyId: key.keyId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    binary,
    requestDigest: confirmedDigest,
    runAs,
    execution: request.execution
  };
  const attestationResult = await signPayload(attestationPayload);
  const attestationDigest = await digest(Buffer.from(canonicalJson(attestationPayload), "utf8"));
  await writeHostArtifact(targets.attestation, attestationResult.signed);
  const startedAt = new Date().toISOString();
  const ledgerStart = {
    schemaVersion: 1,
    provider: "codex",
    kind: "execution-ledger",
    state: "running",
    requestDigest: confirmedDigest,
    execution: request.execution,
    model: request.model,
    binary,
    runAs,
    promptDigest: request.promptDigest,
    startedAt
  };
  await writeHostArtifact(targets.ledgerStart, ledgerStart);
  const bundle = await mkdtemp(path.join(EXECUTION_BUNDLES, `${executionId}.`));
  // macOS getcwd requires directory read permission for a non-root probe;
  // the bundle contains only the public evaluation schema and is root-owned.
  await chmod(bundle, 0o755);
  await validateRootOwnedDirectory(bundle, "Host execution bundle", 0o755);
  const schemaPath = path.join(bundle, "evaluation.schema.json");
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  let result;
  let response;
  try {
    await writeFile(schemaPath, JSON.stringify(EVALUATION_SCHEMA), { mode: 0o644 });
    const args = commandArgs ?? [
      "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
      "-C", bundle, "--output-schema", schemaPath,
      "-m", request.model, "-c", "model_reasoning_effort=\"high\"", "-"
    ];
    result = await spawnCapture(stagedBinaryPath, args, (() => {
      const env = safeEnvironment({ HOME: runAs.homePath });
      delete env.CODEX_HOME;
      if (runAs.codexHomePath) env.CODEX_HOME = runAs.codexHomePath;
      return {
        input: promptBytes,
        cwd: bundle,
        timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        uid: request.uid,
        gid: request.gid,
        env,
        launcherPath: EXECUTION_LAUNCHER
      };
    })());
    if (result.outputExceeded) {
      throw new Error("Host Codex execution output exceeded the configured limit");
    }
    if (result.code !== 0 || result.signal !== null || result.timedOut) {
      throw new Error(`Host Codex execution failed: exit=${result.code ?? "null"}; signal=${result.signal ?? "none"}; timedOut=${result.timedOut}`);
    }
    response = validateEvaluationResponse(extractJson(result.stdout));
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const stdoutDigest = await digest(Buffer.from(result?.stdout ?? "", "utf8"));
    const stderrDigest = await digest(Buffer.from(result?.stderr ?? "", "utf8"));
    const failedLedger = {
      ...ledgerStart,
      state: "failed",
      finishedAt,
      exitCode: result?.code ?? null,
      signal: result?.signal ?? null,
      timedOut: result?.timedOut ?? false,
      responseDigest: null,
      stdoutDigest,
      stderrDigest
    };
    await writeHostArtifact(targets.ledger, {
      ...failedLedger,
      ledgerDigest: await digest(Buffer.from(canonicalJson(failedLedger), "utf8"))
    }).catch(() => undefined);
    await writeHostArtifact(targets.failure, {
      ...ledgerStart,
      state: "failed",
      finishedAt,
      exitCode: result?.code ?? null,
      signal: result?.signal ?? null,
      timedOut: result?.timedOut ?? false,
      stdoutDigest,
      stderrDigest,
      error: error.message
    }).catch(() => undefined);
    throw error;
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
  const finishedAt = new Date().toISOString();
  const responseDigest = await digest(Buffer.from(canonicalJson(response), "utf8"));
  const ledgerPayload = {
    ...ledgerStart,
    state: "complete",
    finishedAt,
    exitCode: 0,
    signal: null,
    timedOut: false,
    responseDigest,
    stdoutDigest: await digest(Buffer.from(result.stdout, "utf8")),
    stderrDigest: await digest(Buffer.from(result.stderr, "utf8"))
  };
  const ledgerDigest = await digest(Buffer.from(canonicalJson(ledgerPayload), "utf8"));
  await writeHostArtifact(targets.ledger, { ...ledgerPayload, ledgerDigest }).catch(async (error) => {
    if (error.code !== "EEXIST") throw error;
    throw new Error("Host execution ledger was unexpectedly reused");
  });
  const receiptPayload = {
    schemaVersion: 1,
    provider: "codex",
    kind: "execution-result",
    model: request.model,
    issuer: trust.value.issuer,
    keyId: key.keyId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    attestationDigest,
    trustRootDigest: await digest(Buffer.from(canonicalJson(trust.value), "utf8")),
    ledgerDigest,
    execution: request.execution,
    binary,
    requestDigest: confirmedDigest,
    runAs,
    promptDigest: request.promptDigest,
    responseDigest,
    exitCode: 0,
    signal: null,
    timedOut: false,
    startedAt,
    finishedAt
  };
  const receiptResult = await signPayload(receiptPayload);
  const receiptDigest = await digest(Buffer.from(canonicalJson(receiptPayload), "utf8"));
  await writeHostArtifact(targets.receipt, receiptResult.signed);
  const envelope = {
    schemaVersion: 1,
    provider: "codex",
    kind: "execution-result-envelope",
    execution: request.execution,
    model: request.model,
    binary,
    requestDigest: confirmedDigest,
    runAs,
    promptDigest: request.promptDigest,
    response,
    responseDigest,
    attestationPath: targets.attestation,
    attestationDigest,
    resultReceiptPath: targets.receipt,
    resultReceiptDigest: receiptDigest,
    ledgerPath: targets.ledger,
    ledgerDigest,
    trustRootDigest: receiptPayload.trustRootDigest,
    startedAt,
    finishedAt,
    exitCode: 0,
    signal: null,
    timedOut: false
  };
  await writeHostArtifact(targets.result, envelope);
  return {
    ok: true,
    executionId,
    resultPath: targets.result,
    receiptPath: targets.receipt,
    attestationPath: targets.attestation,
    ledgerPath: targets.ledger,
    ...(includeResponse ? { response, executionCwd: bundle, executionBinaryPath: stagedBinaryPath } : {})
  };
}

function expectedStandingAuthorization({ grant, grantDigest, policy, purpose, model, requestCount }) {
  return validateStandingAuthorization({
    mode: STANDING_CONSENT_MODE,
    grantId: grant.grantId,
    grantDigest,
    policyId: policy.policyId,
    policyVersion: policy.version,
    policyDigest: grant.policyDigest,
    repo: grant.repo,
    provider: grant.provider,
    model,
    purpose,
    requestCount,
    requestRoot: grant.requestRoot,
    subject: grant.subject,
    readOnly: true,
    ephemeral: true,
    sanitized: true
  });
}

async function validateCurrentCandidateMaterial(authorization, execution, binding) {
  if (execution.role === "baseline" || execution.role === "train-baseline") return;
  for (const file of binding.files) {
    const target = path.resolve(authorization.repo, file.path);
    if (!isWithin(authorization.repo, target)) throw new Error("Consented material path escapes the authorized repository");
    if (file.state === "missing") {
      if (await exists(target)) throw new Error(`Consented material unexpectedly exists: ${file.path}`);
      continue;
    }
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.size !== file.size || (info.mode & 0o111 ? 0o755 : 0o644) !== file.mode) {
      throw new Error(`Consented material identity changed: ${file.path}`);
    }
    if (await digest(await readFile(target)) !== file.digest) throw new Error(`Consented material digest changed: ${file.path}`);
  }
}

function parsePromptJsonLine(lines, marker) {
  const index = lines.indexOf(marker);
  if (index < 0 || index + 1 >= lines.length) throw new Error(`Consented prompt is missing ${marker}`);
  try {
    return JSON.parse(lines[index + 1]);
  } catch {
    throw new Error(`Consented prompt ${marker} payload is not canonical JSON`);
  }
}

async function validateConsentedPrompt(request, policy) {
  const promptBytes = await validatePrompt(request);
  const prompt = promptBytes.toString("utf8");
  if (Buffer.byteLength(prompt, "utf8") !== promptBytes.length) throw new Error("Consented prompt must be valid UTF-8");
  for (const line of policy.sanitization.requiredPromptLines) {
    if (!prompt.split("\n").includes(line)) throw new Error(`Consented prompt is missing required safety line: ${line}`);
  }
  const lines = prompt.split("\n");
  const candidateLine = lines.find((line) => line.startsWith("Candidate digest: "));
  if (!candidateLine || candidateLine.slice("Candidate digest: ".length) !== request.materialBinding.snapshotDigest) {
    throw new Error("Consented prompt snapshot digest does not match its material binding");
  }
  const files = parsePromptJsonLine(lines, "Changed-path digest manifest:");
  const materials = parsePromptJsonLine(lines, "Balanced candidate samples:");
  const cases = parsePromptJsonLine(lines, "Sanitized cases:");
  if (canonicalJson(files) !== canonicalJson(request.materialBinding.files)) {
    throw new Error("Consented prompt changed-path manifest does not match its signed request");
  }
  const allowedPatterns = policy.sanitization.allowedPathPatterns.map((value) => new RegExp(value));
  const secretPattern = new RegExp(policy.sanitization.secretPattern, "i");
  const paths = new Set();
  for (const file of files) {
    if (!allowedPatterns.some((pattern) => pattern.test(file.path))) throw new Error(`Consented prompt path is outside the policy allowlist: ${file.path}`);
    if (paths.has(file.path)) throw new Error("Consented prompt contains duplicate changed paths");
    paths.add(file.path);
  }
  if (!Array.isArray(materials) || materials.length > policy.sanitization.maxFiles ||
      await digest(Buffer.from(canonicalJson(materials), "utf8")) !== request.materialBinding.materialsDigest) {
    throw new Error("Consented prompt material list exceeds policy or changed after request generation");
  }
  let sampledBytes = 0;
  const materialPaths = new Set();
  for (const material of materials) {
    exactKeys(material, ["content", "digest", "evidenceIndex", "materialGroup", "path", "redacted", "sampledBytes", "truncated"], "Consented material");
    const bound = files.find((file) => file.path === material.path && file.state === "file" && file.digest === material.digest);
    if (!bound || materialPaths.has(material.path) || typeof material.content !== "string" ||
        typeof material.evidenceIndex !== "object" || material.evidenceIndex === null || Array.isArray(material.evidenceIndex) ||
        !Number.isInteger(material.sampledBytes) || material.sampledBytes < 0 || typeof material.truncated !== "boolean" || typeof material.redacted !== "boolean" ||
        !["runtime", "tests", "config", "skills", "templates", "fixtures", "metadata", "docs"].includes(material.materialGroup)) {
      throw new Error("Consented prompt contains an invalid material sample");
    }
    const materialText = canonicalJson({ content: material.content, evidenceIndex: material.evidenceIndex });
    if (secretPattern.test(materialText)) throw new Error(`Consented prompt contains secret-shaped material: ${material.path}`);
    sampledBytes += material.sampledBytes;
    materialPaths.add(material.path);
  }
  if (sampledBytes > policy.sanitization.maxBytes) throw new Error("Consented prompt exceeds the sanitized material byte budget");
  if (!Array.isArray(cases) || cases.length < 2 || cases.length > policy.sanitization.maxCases) {
    throw new Error("Consented prompt case count is outside policy");
  }
  const caseIds = new Set();
  for (const item of cases) {
    exactKeys(item, ["assertions", "id", "scenario"], "Consented evaluation case");
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(item.id) || caseIds.has(item.id) ||
        typeof item.scenario !== "string" || !item.scenario || item.scenario.length > 4000 || secretPattern.test(item.scenario) ||
        !Array.isArray(item.assertions) || item.assertions.length < 1 || item.assertions.length > 12) {
      throw new Error("Consented prompt contains an invalid or secret-shaped evaluation case");
    }
    caseIds.add(item.id);
    for (const assertion of item.assertions) {
      exactKeys(assertion, ["description", "id"], "Consented evaluation assertion");
      if (typeof assertion.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(assertion.id) ||
          typeof assertion.description !== "string" || !assertion.description || assertion.description.length > 4000 || secretPattern.test(assertion.description)) {
        throw new Error("Consented prompt contains an invalid or secret-shaped assertion");
      }
    }
  }
  await validateCurrentCandidateMaterial(request.authorization, request.execution, request.materialBinding);
}

async function executeConsentedBatch(manifestPath, confirmedManifestDigest) {
  requireRoot();
  await requireInstalledCapability("standing-consent-execution");
  if (!SHA256.test(confirmedManifestDigest)) throw new Error("confirmed execution manifest digest must be SHA-256");
  const host = await status();
  const consent = host.standingConsent;
  if (!consent?.active) throw new Error(`Standing evaluator consent is unavailable: ${consent?.error ?? "not installed"}`);
  const grant = consent.grant;
  const requestRoot = await validateConsentUserDirectory(grant.requestRoot, grant.subject, "Standing-consent request root");
  const resolvedManifest = path.resolve(manifestPath);
  const outputDirectory = path.dirname(resolvedManifest);
  if (path.dirname(outputDirectory) !== requestRoot || !CONSENT_SAFE_SUBDIRECTORY.test(path.basename(outputDirectory)) ||
      path.basename(resolvedManifest) !== "attestation-requests.json") {
    throw new Error("Consented manifest must use one safe direct child of the fixed request root");
  }
  await validateConsentUserDirectory(outputDirectory, grant.subject, "Standing-consent batch directory");
  const manifestFile = await validateConsentUserFile(resolvedManifest, grant.subject, "Standing-consent manifest", outputDirectory);
  if (await digest(manifestFile.bytes) !== confirmedManifestDigest) throw new Error("Standing-consent manifest digest changed");
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  const policy = consent.policy;
  const expectedRequestCount = policy.requestCounts[manifest.purpose];
  const expectedAuthorization = expectedStandingAuthorization({
    grant,
    grantDigest: consent.grantDigest,
    policy,
    purpose: manifest.purpose,
    model: manifest.model,
    requestCount: expectedRequestCount
  });
  if (manifest.schemaVersion !== 4 || manifest.repo !== grant.repo || manifest.model !== "gpt-5.6-terra" ||
      !grant.purposes.includes(manifest.purpose) || !Array.isArray(manifest.requests) || manifest.requests.length !== expectedRequestCount ||
      !SHA256.test(manifest.baselineSnapshotDigest ?? "") ||
      manifest.standingConsentPolicyPath !== "plugins/better-workflows/config/self-improve-standing-consent-v1.json" ||
      manifest.standingConsentPolicyDigest !== grant.policyDigest || canonicalJson(manifest.authorization) !== canonicalJson(expectedAuthorization)) {
    throw new Error("Standing-consent manifest does not match the active root-owned grant");
  }
  for (const item of manifest.requests) {
    if (path.dirname(item.request) !== outputDirectory || path.basename(item.request) !== `${item.executionId}.request.json`) {
      throw new Error("Standing-consent request path escapes its batch directory");
    }
    const requestFile = await validateConsentUserFile(item.request, grant.subject, "Standing-consent execution request", outputDirectory);
    if (await digest(requestFile.bytes) !== item.requestDigest) throw new Error("Standing-consent execution request digest changed");
    const request = validateExecutionRequest(JSON.parse(requestFile.bytes.toString("utf8")));
    const expectedSnapshotDigest = item.role === "baseline" || item.role === "train-baseline"
      ? manifest.baselineSnapshotDigest
      : manifest.candidateDigest;
    if (path.dirname(request.promptPath) !== outputDirectory || canonicalJson(request.authorization) !== canonicalJson(expectedAuthorization) ||
        request.materialBinding.snapshotDigest !== expectedSnapshotDigest ||
        item.authorizationDigest !== await digest(Buffer.from(canonicalJson(expectedAuthorization), "utf8"))) {
      throw new Error("Standing-consent request authorization or prompt path is invalid");
    }
    await validateConsentUserFile(request.promptPath, grant.subject, "Standing-consent prompt", outputDirectory);
    await validateConsentedPrompt(request, policy);
  }
  return executeBatch(resolvedManifest, confirmedManifestDigest, { requiredAuthorization: expectedAuthorization });
}

async function executeBatch(manifestPath, confirmedManifestDigest, { requiredAuthorization = null } = {}) {
  requireRoot();
  await requireInstalledCapability("execution-batch");
  if (!SHA256.test(confirmedManifestDigest)) throw new Error("confirmed execution manifest digest must be SHA-256");
  const manifestBytes = await readFile(path.resolve(manifestPath));
  if (await digest(manifestBytes) !== confirmedManifestDigest) {
    throw new Error("execution manifest digest does not match administrator-confirmed digest");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const policyBinding = policyBindingForPurpose(manifest.purpose);
  const standing = manifest.authorization !== undefined;
  if (standing && requiredAuthorization === null) {
    throw new Error("schemaVersion 4 standing authorization requires execute-consented-batch");
  }
  const expectedManifestSchema = standing ? 4 : policyBinding ? 3 : 2;
  const expectedRequestCount = manifest.purpose === "evaluator-migration" ? 8 : 7;
  if (manifest.schemaVersion !== expectedManifestSchema || !Array.isArray(manifest.requests) || manifest.requests.length !== expectedRequestCount) {
    throw new Error(`execution manifest must be schemaVersion ${expectedManifestSchema} with exactly ${expectedRequestCount} requests`);
  }
  if (manifest.schemaVersion !== expectedManifestSchema || !["ordinary", "evaluator-migration", "safety-remediation-v1", "quality-remediation-v1"].includes(manifest.purpose) ||
      (policyBinding
        ? manifest.policyPath !== policyBinding.path ||
          manifest.policyId !== policyBinding.id || manifest.policyVersion !== policyBinding.version || !SHA256.test(manifest.policyDigest)
        : manifest.policyPath !== undefined || manifest.policyId !== undefined || manifest.policyVersion !== undefined || manifest.policyDigest !== undefined) ||
      typeof manifest.runId !== "string" || !manifest.runId ||
      typeof manifest.model !== "string" || !manifest.model || typeof manifest.binaryPath !== "string" ||
      !path.isAbsolute(manifest.binaryPath) || !SHA256.test(manifest.binaryApprovalDigest) || !SHA256.test(manifest.binaryDigest) ||
      typeof manifest.runtimePath !== "string" || !path.isAbsolute(manifest.runtimePath) ||
      path.resolve(manifest.runtimePath) !== manifest.runtimePath || !SHA256.test(manifest.runtimeDigest) ||
      !SHA1.test(manifest.headRevision) || !SHA256.test(manifest.sourceBindingDigest) || !SHA256.test(manifest.pluginBundleDigest) ||
      typeof manifest.suiteDigest !== "string" || !manifest.suiteDigest ||
      typeof manifest.baselineRevision !== "string" || !manifest.baselineRevision ||
      typeof manifest.candidateDigest !== "string" || !manifest.candidateDigest ||
      !Array.isArray(manifest.requests) || manifest.requests.length !== expectedRequestCount ||
      (standing && (manifest.standingConsentPolicyPath !== "plugins/better-workflows/config/self-improve-standing-consent-v1.json" ||
        !SHA256.test(manifest.standingConsentPolicyDigest ?? "") || !SHA256.test(manifest.baselineSnapshotDigest ?? "") ||
        canonicalJson(validateStandingAuthorization(manifest.authorization)) !== canonicalJson(requiredAuthorization ?? manifest.authorization))) ||
      (!standing && (manifest.standingConsentPolicyPath !== undefined || manifest.standingConsentPolicyDigest !== undefined || manifest.baselineSnapshotDigest !== undefined))) {
    throw new Error("execution manifest must bind the administrator Node runtime digest");
  }
  const manifestRunAs = validateManifestRunAs(manifest.runAs);
  const runtime = await currentRuntime(manifest.runtimePath);
  if (!runtime?.supported || runtime.path !== manifest.runtimePath || runtime.digest !== manifest.runtimeDigest) {
    throw new Error("execution manifest runtime digest does not match the installed administrator runtime");
  }
  await requireApprovedCodexBinary(manifest.binaryPath, manifest.binaryDigest).then((approval) => {
    if (approval.registryDigest !== manifest.binaryApprovalDigest) {
      throw new Error("execution manifest binary approval registry digest does not match the installed allowlist");
    }
  });
  const prepared = [];
  const batchStem = path.join(EXECUTIONS, `${confirmedManifestDigest}.batch`);
  const batchStartPath = `${batchStem}.start.json`;
  const batchCompletePath = `${batchStem}.complete.json`;
  const batchFailurePath = `${batchStem}.failure.json`;
  for (const target of [batchStartPath, batchCompletePath, batchFailurePath]) {
    if (await exists(target)) throw new Error(`Refusing to reuse execution batch journal: ${target}`);
  }
  const ids = new Set();
  for (const item of manifest.requests) {
    if (!item || typeof item !== "object" ||
        typeof item.request !== "string" || !path.isAbsolute(item.request) || path.resolve(item.request) !== item.request ||
        !SHA256.test(item.requestDigest) || typeof item.executionId !== "string" ||
        typeof item.role !== "string" || !Number.isInteger(item.attempt) || !SHA256.test(item.promptDigest)) {
      throw new Error("execution manifest contains an invalid request reference");
    }
    const bytes = await readFile(item.request);
    if (await digest(bytes) !== item.requestDigest) throw new Error("execution manifest request digest changed");
    const request = validateExecutionRequest(JSON.parse(bytes.toString("utf8")));
    const requestRunAs = {
      uid: request.uid,
      gid: request.gid,
      homePath: request.homePath,
      codexHomePath: request.codexHomePath
    };
    if (request.model !== manifest.model || request.pluginBundleDigest !== manifest.pluginBundleDigest || request.binaryPath !== manifest.binaryPath || request.binaryDigest !== manifest.binaryDigest || request.binaryApprovalDigest !== manifest.binaryApprovalDigest ||
        canonicalJson(requestRunAs) !== canonicalJson(manifestRunAs) ||
        request.execution.runId !== manifest.runId || request.execution.suiteDigest !== manifest.suiteDigest ||
        request.execution.baselineRevision !== manifest.baselineRevision || request.execution.candidateDigest !== manifest.candidateDigest ||
        request.execution.headRevision !== manifest.headRevision || request.execution.sourceBindingDigest !== manifest.sourceBindingDigest ||
        request.execution.role !== item.role || request.execution.attempt !== item.attempt ||
        request.execution.id !== item.executionId || request.execution.promptDigest !== item.promptDigest ||
        (policyBinding && (request.purpose !== manifest.purpose || request.policyDigest !== manifest.policyDigest || request.execution.purpose !== manifest.purpose || request.execution.policyDigest !== manifest.policyDigest)) ||
        (!policyBinding && (request.purpose !== undefined || request.policyDigest !== undefined)) ||
        (request.execution.purpose !== undefined && request.execution.purpose !== manifest.purpose) ||
        (standing && (canonicalJson(request.authorization) !== canonicalJson(manifest.authorization) ||
          canonicalJson(request.execution.authorization) !== canonicalJson(manifest.authorization) ||
          request.materialBinding.snapshotDigest !== ((item.role === "baseline" || item.role === "train-baseline") ? manifest.baselineSnapshotDigest : manifest.candidateDigest) ||
          item.authorizationDigest !== await digest(Buffer.from(canonicalJson(manifest.authorization), "utf8")))) ||
        (!standing && (request.authorization !== undefined || request.materialBinding !== undefined || item.authorizationDigest !== undefined))) {
      throw new Error("execution manifest request does not match its canonical batch binding");
    }
    if (ids.has(request.execution.id)) throw new Error("execution manifest contains duplicate execution IDs");
    ids.add(request.execution.id);
    prepared.push({ requestPath: item.request, requestDigest: item.requestDigest, executionId: request.execution.id });
  }
  const batchStarted = {
    schemaVersion: 1,
    provider: "codex",
    kind: "execution-batch-journal",
    state: "running",
    manifestDigest: confirmedManifestDigest,
    executionIds: prepared.map((item) => item.executionId),
    requestDigests: prepared.map((item) => item.requestDigest),
    ...(standing ? { authorization: manifest.authorization } : {}),
    startedAt: new Date().toISOString()
  };
  await writeHostArtifact(batchStartPath, batchStarted);
  const outputs = [];
  try {
    for (const item of prepared) {
      outputs.push(await executeResultRequest(item.requestPath, item.requestDigest, { requiredAuthorization }));
    }
    await writeHostArtifact(batchCompletePath, {
      ...batchStarted,
      state: "complete",
      finishedAt: new Date().toISOString(),
      outputs
    });
    return { ok: true, manifestDigest: confirmedManifestDigest, outputs };
  } catch (error) {
    await writeHostArtifact(batchFailurePath, {
      ...batchStarted,
      state: "failed",
      finishedAt: new Date().toISOString(),
      completed: outputs,
      error: error.message
    }).catch(() => undefined);
    throw error;
  }
}

async function runReadinessProbe({ uid, gid, homePath, codexHomePath = null }) {
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) {
    throw new Error("Readiness probe requires a positive non-root uid and gid");
  }
  await validateProtectedDirectoryChain(EXECUTION_BUNDLES, "Host execution bundle root");
  const requestId = `host-readiness-${Date.now()}-${process.pid}`;
  const promptPath = path.join(EXECUTION_BUNDLES, `${requestId}.prompt.txt`);
  const requestPath = path.join(EXECUTION_BUNDLES, `${requestId}.request.json`);
  const promptBytes = Buffer.alloc(0);
  const promptDigest = await digest(promptBytes);
  const execution = {
    id: requestId,
    runId: "host-readiness-probe",
    suiteDigest: "host-readiness-probe",
    baselineRevision: "0000000000000000000000000000000000000000",
    candidateDigest: "0".repeat(64),
    headRevision: "0".repeat(40),
    promptDigest,
    role: "readiness-probe",
    sourceBindingDigest: "0".repeat(64),
    attempt: 1
  };
  const request = {
    binaryApprovalDigest: (await currentFixedArtifact(EXECUTION_PROBE, "Host readiness probe")).digest,
    binaryDigest: (await currentFixedArtifact(EXECUTION_PROBE, "Host readiness probe")).digest,
    binaryPath: EXECUTION_PROBE,
    codexHomePath,
    execution,
    gid,
    homePath,
    model: "host-readiness-probe",
    pluginBundleDigest: "0".repeat(64),
    promptDigest,
    promptPath,
    uid
  };
  const requestBytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
  await exclusiveWrite(promptPath, promptBytes, 0o600);
  await exclusiveWrite(requestPath, requestBytes, 0o600);
  try {
    const result = await executeResultRequest(requestPath, await digest(requestBytes), { includeResponse: true, commandArgs: [], internalProbe: true });
    const probe = result.response?.probe;
    const expectedEnvironment = Object.entries(safeEnvironment({
      HOME: homePath,
      ...(codexHomePath ? { CODEX_HOME: codexHomePath } : {})
    })).map(([key, value]) => `${key}=${value}`).sort();
    const actualEnvironment = Array.isArray(probe?.environment) ? probe.environment.slice().sort() : null;
    if (!probe || probe.uid !== uid || probe.euid !== uid || probe.gid !== gid || probe.egid !== gid ||
        !Array.isArray(probe.supplementaryGroups) || probe.supplementaryGroups.length !== 0 ||
        probe.cwd !== result.executionCwd || probe.argv0 !== result.executionBinaryPath ||
        canonicalJson(actualEnvironment) !== canonicalJson(expectedEnvironment)) {
      throw new Error("Host readiness probe did not prove the requested identity, cwd, empty supplementary groups, and fixed environment");
    }
    return { ...result, probe };
  } finally {
    await unlink(promptPath).catch(() => undefined);
    await unlink(requestPath).catch(() => undefined);
  }
}

function validateManifestRunAs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== "codexHomePath\0gid\0homePath\0uid" ||
      !Number.isInteger(value.uid) || value.uid <= 0 || !Number.isInteger(value.gid) || value.gid <= 0) {
    throw new Error("execution manifest run-as binding is invalid");
  }
  for (const [key, nullable] of [["homePath", false], ["codexHomePath", true]]) {
    if (nullable && value[key] === null) continue;
    if (typeof value[key] !== "string" || !path.isAbsolute(value[key]) || path.resolve(value[key]) !== value[key]) {
      throw new Error(`execution manifest ${key} binding is not canonical`);
    }
  }
  return value;
}

async function upgradeSigner(
  sourcePath,
  confirmedDigest,
  launcherSourcePath,
  launcherDigest,
  probeSourcePath,
  probeDigest,
  probeUid,
  probeGid,
  probeHomePath,
  probeCodexHomePath = null,
  approvedCodexBinaryPath,
  approvedCodexBinaryDigest
) {
  requireRoot();
  await requireTrustedRuntime();
  const source = await readSourceFile(sourcePath, confirmedDigest, "Signer source");
  const launcherSource = await readSourceFile(launcherSourcePath, launcherDigest, "Native launcher source");
  const probeSource = await readSourceFile(probeSourcePath, probeDigest, "Readiness probe source");
  const codexAllowlist = await approvedCodexAllowlistSource(approvedCodexBinaryPath, approvedCodexBinaryDigest);
  const text = source.bytes.toString("utf8");
  if (!text.includes(`const HOST_SIGNER_VERSION = "${HOST_SIGNER_VERSION}"`) ||
      !HOST_SIGNER_CAPABILITIES.every((capability) => text.includes(`"${capability}"`)) ||
      !text.includes('command === "capabilities"')) {
    throw new Error("signer source does not expose the required host capabilities");
  }
  const syntax = await spawnCapture(process.execPath, ["--check", source.path], {
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024
  });
  if (syntax.code !== 0 || syntax.signal !== null || syntax.timedOut) {
    throw new Error(`signer source syntax check failed: exit=${syntax.code ?? "null"}; signal=${syntax.signal ?? "none"}`);
  }
  await secureDirectory("/private/var/db/better-workflows", 0o711);
  await secureDirectory(path.dirname(CODEX_ALLOWLIST), 0o755);
  await secureDirectory(HOST_RUNTIME_ROOT, 0o755);
  await secureDirectory(ATTESTATIONS, 0o755);
  await secureDirectory(EXECUTIONS, 0o755);
  await secureDirectory(EXECUTION_BUNDLES, 0o755);
  const launcherArtifact = await compileNativeArtifact(launcherSource, "Native launcher");
  const probeArtifact = await compileNativeArtifact(probeSource, "Readiness probe");
  const changes = [];
  try {
    for (const [target, item, mode, label] of [
      [CODEX_ALLOWLIST, codexAllowlist.source, 0o644, "Approved Codex binary allowlist"],
      [EXECUTION_LAUNCHER, launcherArtifact, 0o755, "Native execution launcher"],
      [EXECUTION_PROBE, probeArtifact, 0o755, "Host readiness probe"],
      [INSTALLED_SIGNER, source, 0o755, "Installed host signer"]
    ]) {
      const change = await replaceRootOwnedFile(target, item, mode, label);
      if (change.changed) changes.push({ target, label, mode, previous: change.previous });
    }
    const installed = await status({ requireReadinessReceipt: false });
    if (!installed.ready) throw new Error("installed signer failed its static capability checks");
    const readinessProbe = await runReadinessProbe({
      uid: probeUid,
      gid: probeGid,
      homePath: probeHomePath,
      codexHomePath: probeCodexHomePath
    });
    const staticReady = await status({ requireReadinessReceipt: false });
    if (!staticReady.ready) throw new Error("installed signer failed its end-to-end readiness probe");
    const trust = await validateTrustRoot();
    const keyPair = await validateSigningKeyPair(trust, await readFile(PRIVATE_KEY));
    const probeResult = {
      executionId: readinessProbe.executionId,
      executionCwd: readinessProbe.executionCwd,
      executionBinaryPath: readinessProbe.executionBinaryPath,
      probe: readinessProbe.probe
    };
    const readinessReceipt = await createReadinessReceipt(readinessBinding({
      trust: {
        digest: staticReady.trustRoot.digest
      },
      privateKey: staticReady.privateKey,
      keyPairProof: staticReady.privateKey.keyPairProof,
      runtime: staticReady.runtime,
      launcher: staticReady.launcher,
      probe: staticReady.readinessProbe,
      codexBinary: staticReady.codexBinary,
      signer: staticReady.signer
    }), probeResult, { verified: keyPair.verified, proof: keyPair.proof });
    const readinessChange = await replaceRootOwnedFile(
      READINESS_RECEIPT,
      readinessReceipt,
      0o644,
      "Host readiness receipt"
    );
    if (readinessChange.changed) changes.push({
      target: READINESS_RECEIPT,
      label: "Host readiness receipt",
      mode: 0o644,
      previous: readinessChange.previous
    });
    const ready = await status();
    if (!ready.ready) throw new Error("installed signer failed its end-to-end readiness receipt verification");
    return {
      ...ready,
      readinessProbe,
      ...(changes.find((item) => item.target === INSTALLED_SIGNER)?.previous
        ? { previousSigner: { path: changes.find((item) => item.target === INSTALLED_SIGNER).previous.path, mode: "0755" } }
        : {})
    };
  } catch (error) {
    const recoveryErrors = [];
    for (const change of changes.toReversed()) {
      try {
        await restoreRootOwnedFile(change.target, change.previous, change.mode, change.label);
        if (change.previous) await discardRollbackBackup(change.previous, change.label);
      } catch (recoveryError) {
        recoveryErrors.push(`${change.label}: ${recoveryError.message}`);
      }
    }
    if (recoveryErrors.length > 0) {
      throw new Error(`signer upgrade failed and rollback could not be proven: ${error.message}; ${recoveryErrors.join("; ")}`);
    }
    throw new Error(`signer upgrade rolled back with exact prior artifacts proven: ${error.message}`);
  }
}

async function signNativeRequest(requestPath, confirmedDigest, outputName) {
  requireRoot();
  await requireInstalledCapability("native-review");
  if (!SHA256.test(confirmedDigest)) throw new Error("confirmed request digest must be SHA-256");
  if (!SAFE_OUTPUT.test(outputName)) throw new Error("attestation output name is unsafe");
  const requestBytes = await readFile(path.resolve(requestPath));
  if ((await digest(requestBytes)) !== confirmedDigest) {
    throw new Error("request digest does not match administrator-confirmed digest");
  }
  const request = JSON.parse(requestBytes.toString("utf8"));
  const required = ["base", "head", "instructionDigest", "model", "packageId", "promptDigest", "reviewDigest", "reviewerId", "runId", "sentinelDigest"];
  if (Object.keys(request).sort().join("\0") !== required.slice().sort().join("\0")) {
    throw new Error("native request fields do not match the signer contract");
  }
  if (!["base", "head"].every((key) => SHA1.test(request[key]))) throw new Error("native request revisions are invalid");
  if (!["instructionDigest", "promptDigest", "reviewDigest", "sentinelDigest"].every((key) => SHA256.test(request[key]))) {
    throw new Error("native request digests are invalid");
  }
  if (["model", "packageId", "reviewerId", "runId"].some((key) => typeof request[key] !== "string" || !request[key] || request[key].length > 256)) {
    throw new Error("native request identity is invalid");
  }
  const trust = await validateTrustRoot();
  await validateRootOwnedFile(PRIVATE_KEY, "Private signing key", 0o600);
  const key = trust.value.publicKeys[0];
  const issuedAt = new Date();
  const payload = {
    schemaVersion: 1,
    provider: "codex-native-subagent",
    ...request,
    issuer: trust.value.issuer,
    keyId: key.keyId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
  };
  const keyPair = await validateSigningKeyPair(trust, await readFile(PRIVATE_KEY));
  const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), keyPair.privateKey).toString("base64");
  const target = path.join(ATTESTATIONS, outputName);
  if (path.dirname(target) !== ATTESTATIONS) throw new Error("attestation path escapes its root");
  await exclusiveWrite(target, `${JSON.stringify({ ...payload, signature }, null, 2)}\n`, 0o644);
  return target;
}

function parse(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    options[key] = value;
    index += 1;
  }
  return { positional, options };
}

async function main() {
  const { positional, options } = parse(process.argv.slice(2));
  const [command] = positional;
  if (command === "capabilities") return signerCapabilities();
  if (command === "status") return status();
  if (command === "provision") return provision();
  if (command === "upgrade") {
    if (!options.source || !options["confirm-digest"] || !options.launcher || !options["launcher-digest"] ||
        !options.probe || !options["probe-digest"] || !options["probe-uid"] || !options["probe-gid"] || !options["probe-home"] ||
        !options["codex-binary"] || !options["codex-binary-digest"]) {
      throw new Error("upgrade requires --source, --confirm-digest, --launcher, --launcher-digest, --probe, --probe-digest, --probe-uid, --probe-gid, --probe-home, --codex-binary, and --codex-binary-digest");
    }
    return upgradeSigner(
      options.source,
      options["confirm-digest"],
      options.launcher,
      options["launcher-digest"],
      options.probe,
      options["probe-digest"],
      Number(options["probe-uid"]),
      Number(options["probe-gid"]),
      options["probe-home"],
      options["probe-codex-home"] ?? null,
      options["codex-binary"],
      options["codex-binary-digest"]
    );
  }
  if (command === "execute-result") {
    if (!options.request || !options["confirm-digest"]) {
      throw new Error("execute-result requires --request and --confirm-digest");
    }
    return executeResultRequest(options.request, options["confirm-digest"]);
  }
  if (command === "execute-batch") {
    if (!options.manifest || !options["confirm-digest"]) {
      throw new Error("execute-batch requires --manifest and --confirm-digest");
    }
    return executeBatch(options.manifest, options["confirm-digest"]);
  }
  if (command === "execute-consented-batch") {
    if (!options.manifest || !options["confirm-digest"]) {
      throw new Error("execute-consented-batch requires --manifest and --confirm-digest");
    }
    return executeConsentedBatch(options.manifest, options["confirm-digest"]);
  }
  if (command === "install-consent") {
    if (!options.request || !options["confirm-digest"]) {
      throw new Error("install-consent requires --request and --confirm-digest");
    }
    return installStandingConsent(options.request, options["confirm-digest"]);
  }
  if (command === "revoke-consent") {
    if (!options["grant-id"]) throw new Error("revoke-consent requires --grant-id");
    return revokeStandingConsent(options["grant-id"]);
  }
  if (command === "sign-native") {
    if (!options.request || !options["confirm-digest"] || !options.output) {
      throw new Error("sign-native requires --request, --confirm-digest, and --output");
    }
    return {
      ok: true,
      output: await signNativeRequest(options.request, options["confirm-digest"], options.output)
    };
  }
  throw new Error("usage: host-trust.mjs capabilities|status|provision|upgrade|execute-result|execute-batch|execute-consented-batch|install-consent|revoke-consent|sign-native");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
