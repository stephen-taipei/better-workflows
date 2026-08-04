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
import path from "node:path";
import { fileURLToPath } from "node:url";

const TRUST_ROOT = "/etc/better-workflows/codex-trust-root.json";
const CODEX_ALLOWLIST = "/etc/better-workflows/codex-binary-allowlist.json";
const PRIVATE_KEY = "/private/var/db/better-workflows/codex-attestation-ed25519.raw";
const ATTESTATIONS = "/private/var/db/better-workflows/attestations";
const EXECUTIONS = "/private/var/db/better-workflows/executions";
const EXECUTION_BUNDLES = "/private/var/db/better-workflows/execution-bundles";
const INSTALLED_SIGNER = "/private/var/db/better-workflows/bin/bw-host-trust.mjs";
const READINESS_RECEIPT = "/private/var/db/better-workflows/host-readiness.json";
const HOST_RUNTIME_ROOT = "/private/var/db/better-workflows/bin";
const EXECUTION_LAUNCHER = "/private/var/db/better-workflows/bin/bw-host-exec-launcher";
const EXECUTION_PROBE = "/private/var/db/better-workflows/bin/bw-host-execution-probe";
const LEGACY_SIGNER = "/private/var/db/better-workflows/bin/bw-host-signer.swift";
const NATIVE_COMPILER = "/usr/bin/clang";
const ISSUER = "better-workflows-local-host";
const HOST_SIGNER_VERSION = "2.1.0";
const HOST_SIGNER_CAPABILITIES = Object.freeze([
  "attestation",
  "native-review",
  "execution-witness",
  "execution-result",
  "execution-batch",
  "signer-upgrade",
  "native-launcher",
  "readiness-probe",
  "request-bound-execution"
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

function readinessBinding({ trust, privateKey, runtime, launcher, probe, codexBinary, signer }) {
  return {
    schemaVersion: 1,
    kind: "host-readiness-binding",
    trustRootDigest: trust.digest,
    privateKeyDigest: privateKey.digest,
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
    const expectedKeys = ["binding", "bindingDigest", "completedAt", "kind", "schemaVersion"];
    const bindingDigest = await digest(Buffer.from(canonicalJson(binding), "utf8"));
    if (Object.keys(receipt).sort().join("\0") !== expectedKeys.sort().join("\0") ||
        receipt.schemaVersion !== 1 || receipt.kind !== "host-readiness-receipt" ||
        typeof receipt.completedAt !== "string" || !SHA256.test(receipt.bindingDigest) ||
        receipt.bindingDigest !== bindingDigest || canonicalJson(receipt.binding) !== canonicalJson(binding)) {
      throw new Error("Host readiness receipt does not bind the current protected host artifacts");
    }
    return {
      path: READINESS_RECEIPT,
      digest: await digest(bytes),
      mode: "0644",
      supported: true,
      bindingDigest: receipt.bindingDigest,
      completedAt: receipt.completedAt
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

async function createReadinessReceipt(binding) {
  const bindingDigest = await digest(Buffer.from(canonicalJson(binding), "utf8"));
  const payload = {
    schemaVersion: 1,
    kind: "host-readiness-receipt",
    completedAt: new Date().toISOString(),
    binding,
    bindingDigest
  };
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  return { path: READINESS_RECEIPT, bytes, digest: await digest(bytes) };
}

async function status({ requireReadinessReceipt = true } = {}) {
  const trust = await validateTrustRoot();
  const keyInfo = await validateRootOwnedFile(PRIVATE_KEY, "Private signing key", 0o600);
  const privateKey = {
    path: PRIVATE_KEY,
    bytes: keyInfo.size,
    digest: await digest(await readFile(PRIVATE_KEY)),
    mode: "0600"
  };
  const runtime = await currentRuntime();
  const launcher = await currentFixedArtifact(EXECUTION_LAUNCHER, "Native execution launcher");
  const probe = await currentFixedArtifact(EXECUTION_PROBE, "Host readiness probe");
  const codexBinary = await currentCodexApproval();
  const signer = await currentSigner();
  const binding = readinessBinding({ trust, privateKey, runtime, launcher, probe, codexBinary, signer });
  const readinessReceipt = await currentReadinessReceipt(binding);
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
    runtime,
    launcher,
    readinessProbe: probe,
    codexBinary,
    signer,
    readinessReceipt
  };
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
  if (!SHA1.test(execution.headRevision)) {
    throw new Error("execution.headRevision must be a Git commit SHA");
  }
  if (!SHA256.test(execution.sourceBindingDigest)) {
    throw new Error("execution.sourceBindingDigest must be SHA-256");
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
  if (Object.keys(request).sort().join("\0") !== required.slice().sort().join("\0")) {
    throw new Error("execution request fields do not match the signer contract");
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
  if (request.promptDigest !== request.execution.promptDigest) {
    throw new Error("execution request prompt digest does not match execution");
  }
  return request;
}

async function requireInstalledCapability(capability, { allowUnprovenReadiness = false } = {}) {
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

async function executeResultRequest(requestPath, confirmedDigest, { includeResponse = false, commandArgs = null, internalProbe = false } = {}) {
  requireRoot();
  await requireInstalledCapability("execution-witness", { allowUnprovenReadiness: internalProbe });
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
  await chmod(bundle, 0o711);
  await validateRootOwnedDirectory(bundle, "Host execution bundle", 0o711);
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
  if (manifest.schemaVersion !== 2 || typeof manifest.runId !== "string" || !manifest.runId ||
      typeof manifest.model !== "string" || !manifest.model || typeof manifest.binaryPath !== "string" ||
      !path.isAbsolute(manifest.binaryPath) || !SHA256.test(manifest.binaryApprovalDigest) || !SHA256.test(manifest.binaryDigest) ||
      typeof manifest.runtimePath !== "string" || !path.isAbsolute(manifest.runtimePath) ||
      path.resolve(manifest.runtimePath) !== manifest.runtimePath || !SHA256.test(manifest.runtimeDigest) ||
      !SHA1.test(manifest.headRevision) || !SHA256.test(manifest.sourceBindingDigest) || !SHA256.test(manifest.pluginBundleDigest) ||
      typeof manifest.suiteDigest !== "string" || !manifest.suiteDigest ||
      typeof manifest.baselineRevision !== "string" || !manifest.baselineRevision ||
      typeof manifest.candidateDigest !== "string" || !manifest.candidateDigest ||
      !Array.isArray(manifest.requests) || manifest.requests.length !== 7) {
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
        request.execution.id !== item.executionId || request.execution.promptDigest !== item.promptDigest) {
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
    startedAt: new Date().toISOString()
  };
  await writeHostArtifact(batchStartPath, batchStarted);
  const outputs = [];
  try {
    for (const item of prepared) outputs.push(await executeResultRequest(item.requestPath, item.requestDigest));
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
    const readinessReceipt = await createReadinessReceipt(readinessBinding({
      trust: {
        digest: staticReady.trustRoot.digest
      },
      privateKey: staticReady.privateKey,
      runtime: staticReady.runtime,
      launcher: staticReady.launcher,
      probe: staticReady.readinessProbe,
      codexBinary: staticReady.codexBinary,
      signer: staticReady.signer
    }));
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
