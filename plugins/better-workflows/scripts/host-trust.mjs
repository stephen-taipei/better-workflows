#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TRUST_ROOT = "/etc/better-workflows/codex-trust-root.json";
const PRIVATE_KEY = "/private/var/db/better-workflows/codex-attestation-ed25519.raw";
const ATTESTATIONS = "/private/var/db/better-workflows/attestations";
const EXECUTIONS = "/private/var/db/better-workflows/executions";
const INSTALLED_SIGNER = "/private/var/db/better-workflows/bin/bw-host-trust.mjs";
const LEGACY_SIGNER = "/private/var/db/better-workflows/bin/bw-host-signer.swift";
const ISSUER = "better-workflows-local-host";
const HOST_SIGNER_VERSION = "2.0.0";
const HOST_SIGNER_CAPABILITIES = Object.freeze([
  "attestation",
  "native-review",
  "execution-witness",
  "execution-result",
  "execution-batch",
  "signer-upgrade"
]);
const SAFE_OUTPUT = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}\.json$/;
const SAFE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const MAX_PROMPT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

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
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY"
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

export function spawnCapture(command, args, { input, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = safeEnvironment(), uid, gid } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      ...(uid === undefined ? {} : { uid }),
      ...(gid === undefined ? {} : { gid }),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
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
      if (bytes > MAX_OUTPUT_BYTES) {
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
  await mkdir(target, { recursive: true, mode });
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== 0) {
    throw new Error(`Unsafe administrator directory: ${target}`);
  }
  await chmod(target, mode);
}

async function exclusiveWrite(target, bytes, mode) {
  const handle = await open(target, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(target, mode);
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
  return info;
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

async function inspectSignerCapabilityReport(target) {
  const syntax = await spawnCapture(process.execPath, ["--check", target], {
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024
  });
  if (syntax.code !== 0 || syntax.signal !== null || syntax.timedOut) {
    throw new Error(`installed signer syntax check failed: exit=${syntax.code ?? "null"}; signal=${syntax.signal ?? "none"}`);
  }
  const reportResult = await spawnCapture(process.execPath, [target, "capabilities"], {
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
  for (const target of [INSTALLED_SIGNER, LEGACY_SIGNER]) {
    if (!(await exists(target))) continue;
    try {
      const info = await validateRootOwnedFile(target, "Host signer", 0o755);
      const bytes = await readFile(target);
      const report = target === INSTALLED_SIGNER
        ? await inspectSignerCapabilityReport(target)
        : null;
      const supported = target === INSTALLED_SIGNER && report !== null;
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
        error: error.message
      };
    }
  }
  return null;
}

async function status() {
  const trust = await validateTrustRoot();
  const keyInfo = await validateRootOwnedFile(PRIVATE_KEY, "Private signing key", 0o600);
  const signer = await currentSigner();
  return {
    ok: true,
    provisioned: true,
    ready: Boolean(signer?.supported),
    trustRoot: {
      path: TRUST_ROOT,
      issuer: trust.value.issuer,
      keyIds: trust.value.publicKeys.map((item) => item.keyId),
      digest: trust.digest,
      mode: "0644"
    },
    privateKey: {
      path: PRIVATE_KEY,
      bytes: keyInfo.size,
      mode: "0600"
    },
    signer
  };
}

async function provision() {
  requireRoot();
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
    "id",
    "promptDigest",
    "role",
    "runId",
    "suiteDigest"
  ];
  if (Object.keys(execution).sort().join("\0") !== expected.join("\0")) {
    throw new Error("execution fields do not match the verifier contract");
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
  return execution;
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

export function validateExecutionRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("execution request must be an object");
  }
  const required = ["binaryDigest", "binaryPath", "codexHomePath", "execution", "gid", "homePath", "model", "promptDigest", "promptPath", "uid"];
  if (Object.keys(request).sort().join("\0") !== required.slice().sort().join("\0")) {
    throw new Error("execution request fields do not match the signer contract");
  }
  if (!SHA256.test(request.promptDigest)) {
    throw new Error("execution request prompt digest is invalid");
  }
  if (!SHA256.test(request.binaryDigest)) {
    throw new Error("execution request binary digest is invalid");
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
  if (request.promptDigest !== request.execution.promptDigest) {
    throw new Error("execution request prompt digest does not match execution");
  }
  return request;
}

async function requireInstalledCapability(capability) {
  const signer = await currentSigner();
  if (!signer?.supported || signer.path !== INSTALLED_SIGNER || !signer.capabilities.includes(capability)) {
    throw new Error(`Installed administrator signer lacks required capability: ${capability}`);
  }
  const running = await realpath(fileURLToPath(import.meta.url));
  const runningDigest = await digest(await readFile(running));
  if (running !== INSTALLED_SIGNER || runningDigest !== signer.digest) {
    throw new Error("Administrator operation must run from the installed, capability-checked signer");
  }
  return signer;
}

async function signPayload(payload) {
  const trust = await validateTrustRoot();
  await validateRootOwnedFile(PRIVATE_KEY, "Private signing key", 0o600);
  const key = trust.value.publicKeys[0];
  const privateKey = privateKeyFromRaw(await readFile(PRIVATE_KEY));
  const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64");
  return {
    signed: { ...payload, signature },
    trustRootDigest: await digest(Buffer.from(canonicalJson(trust.value), "utf8"))
  };
}

async function writeHostArtifact(target, value) {
  if (!path.isAbsolute(target)) throw new Error("Host artifact path must be absolute");
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
  return { homePath, codexHomePath };
}

async function executeResultRequest(requestPath, confirmedDigest) {
  requireRoot();
  await requireInstalledCapability("execution-witness");
  if (!SHA256.test(confirmedDigest)) throw new Error("confirmed execution request digest must be SHA-256");
  const resolvedRequest = path.resolve(requestPath);
  const requestBytes = await readFile(resolvedRequest);
  if (await digest(requestBytes) !== confirmedDigest) {
    throw new Error("execution request digest does not match administrator-confirmed digest");
  }
  const request = validateExecutionRequest(JSON.parse(requestBytes.toString("utf8")));
  const executionId = requireSafeExecutionId(request.execution.id);
  const binaryPath = await canonicalBinary(request.binaryPath);
  const binaryBytes = await readFile(binaryPath);
  const binaryDigest = await digest(binaryBytes);
  if (binaryDigest !== request.binaryDigest) {
    throw new Error("execution request binary digest does not match the administrator-confirmed binary");
  }
  const promptBytes = await validatePrompt(request);
  const runAs = await validateRunAs(request);
  await secureDirectory(EXECUTIONS, 0o755);
  await secureDirectory(ATTESTATIONS, 0o755);
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
  const binary = { path: stagedBinaryPath, digest: binaryDigest };
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
    promptDigest: request.promptDigest,
    startedAt
  };
  await writeHostArtifact(targets.ledgerStart, ledgerStart);
  const bundle = await mkdtemp(path.join(os.tmpdir(), "better-workflows-host-execution-"));
  await chmod(bundle, 0o711);
  const schemaPath = path.join(bundle, "evaluation.schema.json");
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  let result;
  let response;
  try {
    await writeFile(schemaPath, JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["results"],
      properties: { results: { type: "array" } }
    }), { mode: 0o644 });
    result = await spawnCapture(stagedBinaryPath, [
      "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
      "-C", bundle, "--output-schema", schemaPath,
      "-m", request.model, "-c", "model_reasoning_effort=\"high\"", "-"
    ], (() => {
      const env = safeEnvironment({ HOME: runAs.homePath });
      delete env.CODEX_HOME;
      if (runAs.codexHomePath) env.CODEX_HOME = runAs.codexHomePath;
      return { input: promptBytes, cwd: bundle, timeoutMs, uid: request.uid, gid: request.gid, env };
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
    await writeHostArtifact(targets.failure, {
      ...ledgerStart,
      state: "failed",
      finishedAt,
      exitCode: result?.code ?? null,
      signal: result?.signal ?? null,
      timedOut: result?.timedOut ?? false,
      stdoutDigest: await digest(Buffer.from(result?.stdout ?? "", "utf8")),
      stderrDigest: await digest(Buffer.from(result?.stderr ?? "", "utf8")),
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
  return { ok: true, executionId, resultPath: targets.result, receiptPath: targets.receipt, attestationPath: targets.attestation, ledgerPath: targets.ledger };
}

async function executeBatch(manifestPath, confirmedManifestDigest) {
  requireRoot();
  await requireInstalledCapability("execution-batch");
  if (!SHA256.test(confirmedManifestDigest)) throw new Error("confirmed execution manifest digest must be SHA-256");
  const manifestBytes = await readFile(path.resolve(manifestPath));
  if (await digest(manifestBytes) !== confirmedManifestDigest) {
    throw new Error("execution manifest digest does not match administrator-confirmed digest");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.requests) || manifest.requests.length !== 7) {
    throw new Error("execution manifest must be schemaVersion 2 with exactly seven requests");
  }
  const prepared = [];
  const ids = new Set();
  for (const item of manifest.requests) {
    if (typeof item.request !== "string" || !path.isAbsolute(item.request) || !SHA256.test(item.requestDigest)) {
      throw new Error("execution manifest contains an invalid request reference");
    }
    const bytes = await readFile(item.request);
    if (await digest(bytes) !== item.requestDigest) throw new Error("execution manifest request digest changed");
    const request = validateExecutionRequest(JSON.parse(bytes.toString("utf8")));
    if (ids.has(request.execution.id)) throw new Error("execution manifest contains duplicate execution IDs");
    ids.add(request.execution.id);
    prepared.push({ requestPath: item.request, requestDigest: item.requestDigest });
  }
  const outputs = [];
  for (const item of prepared) outputs.push(await executeResultRequest(item.requestPath, item.requestDigest));
  return { ok: true, manifestDigest: confirmedManifestDigest, outputs };
}

async function upgradeSigner(sourcePath, confirmedDigest) {
  requireRoot();
  if (!SHA256.test(confirmedDigest)) throw new Error("confirmed signer digest must be SHA-256");
  const source = path.resolve(sourcePath);
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new Error("Signer source must be a regular non-symlink file");
  const bytes = await readFile(source);
  if (await digest(bytes) !== confirmedDigest) throw new Error("signer source digest does not match administrator-confirmed digest");
  const text = bytes.toString("utf8");
  if (!text.includes(`const HOST_SIGNER_VERSION = "${HOST_SIGNER_VERSION}"`) ||
      !HOST_SIGNER_CAPABILITIES.every((capability) => text.includes(`"${capability}"`)) ||
      !text.includes('command === "capabilities"')) {
    throw new Error("signer source does not expose the required host capabilities");
  }
  const syntax = await spawnCapture(process.execPath, ["--check", source], {
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024
  });
  if (syntax.code !== 0 || syntax.signal !== null || syntax.timedOut) {
    throw new Error(`signer source syntax check failed: exit=${syntax.code ?? "null"}; signal=${syntax.signal ?? "none"}`);
  }
  await secureDirectory("/private/var/db/better-workflows", 0o711);
  await secureDirectory("/private/var/db/better-workflows/bin", 0o755);
  const existing = await exists(INSTALLED_SIGNER);
  let backup = null;
  const temporary = `${INSTALLED_SIGNER}.${confirmedDigest}.tmp`;
  if (existing) {
    await validateRootOwnedFile(INSTALLED_SIGNER, "Installed host signer", 0o755);
    const existingBytes = await readFile(INSTALLED_SIGNER);
    const existingDigest = await digest(existingBytes);
    if (existingDigest === confirmedDigest) return await status();
    backup = `${INSTALLED_SIGNER}.${existingDigest}.bak`;
    if (await exists(backup)) throw new Error(`Refusing to overwrite signer backup: ${backup}`);
  }
  try {
    if (backup) await rename(INSTALLED_SIGNER, backup);
    await exclusiveWrite(temporary, bytes, 0o755);
    await rename(temporary, INSTALLED_SIGNER);
    const installed = await status();
    if (!installed.ready) throw new Error("installed signer failed its syntax and behavioral capability checks");
    return { ...installed, ...(backup ? { previousSigner: { path: backup, mode: "0755" } } : {}) };
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (await exists(INSTALLED_SIGNER)) {
      const quarantine = `${INSTALLED_SIGNER}.${confirmedDigest}.${Date.now()}.failed`;
      await rename(INSTALLED_SIGNER, quarantine).catch(() => undefined);
    }
    if (backup && await exists(backup)) {
      await rename(backup, INSTALLED_SIGNER).catch(() => undefined);
    }
    throw new Error(`signer upgrade rolled back after failed validation: ${error.message}`);
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
  const privateKey = privateKeyFromRaw(await readFile(PRIVATE_KEY));
  const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64");
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
    if (!options.source || !options["confirm-digest"]) {
      throw new Error("upgrade requires --source and --confirm-digest");
    }
    return upgradeSigner(options.source, options["confirm-digest"]);
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
  if (command === "sign-native") {
    if (!options.request || !options["confirm-digest"] || !options.output) {
      throw new Error("sign-native requires --request, --confirm-digest, and --output");
    }
    return {
      ok: true,
      output: await signNativeRequest(options.request, options["confirm-digest"], options.output)
    };
  }
  throw new Error("usage: host-trust.mjs capabilities|status|provision|upgrade|execute-result|execute-batch|sign-native");
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
