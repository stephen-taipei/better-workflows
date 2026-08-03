#!/usr/bin/env node

import {
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
  open,
  readFile,
  realpath,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TRUST_ROOT = "/etc/better-workflows/codex-trust-root.json";
const PRIVATE_KEY = "/private/var/db/better-workflows/codex-attestation-ed25519.raw";
const ATTESTATIONS = "/private/var/db/better-workflows/attestations";
const INSTALLED_SIGNER = "/private/var/db/better-workflows/bin/bw-host-trust.mjs";
const LEGACY_SIGNER = "/private/var/db/better-workflows/bin/bw-host-signer.swift";
const ISSUER = "better-workflows-local-host";
const SAFE_OUTPUT = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}\.json$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;

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

async function currentSigner() {
  for (const target of [INSTALLED_SIGNER, LEGACY_SIGNER]) {
    if (await exists(target)) {
      const info = await validateRootOwnedFile(target, "Host signer", 0o755);
      return {
        path: target,
        digest: await digest(await readFile(target)),
        mode: `0${(info.mode & 0o777).toString(8)}`
      };
    }
  }
  return null;
}

async function status() {
  const trust = await validateTrustRoot();
  const keyInfo = await validateRootOwnedFile(PRIVATE_KEY, "Private signing key", 0o600);
  const signer = await currentSigner();
  if (!signer) throw new Error("No administrator-owned host signer is installed");
  return {
    ok: true,
    provisioned: true,
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

async function signRequest(requestPath, confirmedDigest, outputName) {
  requireRoot();
  if (!SHA256.test(confirmedDigest)) throw new Error("confirmed request digest must be SHA-256");
  if (!SAFE_OUTPUT.test(outputName)) throw new Error("attestation output name is unsafe");
  const requestBytes = await readFile(path.resolve(requestPath));
  if ((await digest(requestBytes)) !== confirmedDigest) {
    throw new Error("request digest does not match administrator-confirmed digest");
  }
  const request = JSON.parse(requestBytes.toString("utf8"));
  if (Object.keys(request).sort().join("\0") !== "binaryPath\0execution\0model") {
    throw new Error("request fields do not match the signer contract");
  }
  if (typeof request.model !== "string" || !request.model || request.model.length > 128) {
    throw new Error("model is invalid");
  }
  const binaryPath = await canonicalBinary(request.binaryPath);
  const execution = validateExecution(request.execution);
  const trust = await validateTrustRoot();
  await validateRootOwnedFile(PRIVATE_KEY, "Private signing key", 0o600);
  const key = trust.value.publicKeys[0];
  const issuedAt = new Date();
  const payload = {
    schemaVersion: 1,
    provider: "codex",
    model: request.model,
    issuer: trust.value.issuer,
    keyId: key.keyId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    binary: {
      path: binaryPath,
      digest: await digest(await readFile(binaryPath))
    },
    execution
  };
  const privateKey = privateKeyFromRaw(await readFile(PRIVATE_KEY));
  const signature = sign(
    null,
    Buffer.from(canonicalJson(payload), "utf8"),
    privateKey
  ).toString("base64");
  const target = path.join(ATTESTATIONS, outputName);
  if (path.dirname(target) !== ATTESTATIONS) throw new Error("attestation path escapes its root");
  await exclusiveWrite(
    target,
    `${JSON.stringify({ ...payload, signature }, null, 2)}\n`,
    0o644
  );
  return target;
}

function validateResultRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("result request must be an object");
  }
  const required = [
    "attestationDigest",
    "attestationName",
    "binary",
    "execution",
    "exitCode",
    "finishedAt",
    "model",
    "promptDigest",
    "responseDigest",
    "signal",
    "startedAt",
    "timedOut",
    "trustRootDigest"
  ];
  if (Object.keys(request).sort().join("\0") !== required.slice().sort().join("\0")) {
    throw new Error("result request fields do not match the signer contract");
  }
  if (!SHA256.test(request.attestationDigest) || !SHA256.test(request.promptDigest) || !SHA256.test(request.responseDigest) || !SHA256.test(request.trustRootDigest)) {
    throw new Error("result request digests are invalid");
  }
  if (!SAFE_OUTPUT.test(request.attestationName)) throw new Error("result request attestation name is unsafe");
  if (typeof request.model !== "string" || !request.model || request.model.length > 128) {
    throw new Error("result request model is invalid");
  }
  validateExecution(request.execution);
  if (request.promptDigest !== request.execution.promptDigest) {
    throw new Error("result request prompt digest does not match execution");
  }
  if (
    !request.binary ||
    typeof request.binary !== "object" ||
    Array.isArray(request.binary) ||
    Object.keys(request.binary).sort().join("\0") !== "digest\0path" ||
    typeof request.binary.path !== "string" ||
    !path.isAbsolute(request.binary.path) ||
    !SHA256.test(request.binary.digest)
  ) {
    throw new Error("result request binary identity is invalid");
  }
  if (request.exitCode !== 0 || request.signal !== null || request.timedOut !== false) {
    throw new Error("result request must attest a successful, non-signalled execution");
  }
  for (const key of ["startedAt", "finishedAt"]) {
    const value = Date.parse(request[key]);
    if (!Number.isFinite(value)) throw new Error(`result request ${key} must be an ISO timestamp`);
  }
  if (Date.parse(request.finishedAt) < Date.parse(request.startedAt)) {
    throw new Error("result request finishedAt must not precede startedAt");
  }
  if (Date.parse(request.finishedAt) > Date.now() + 300_000) {
    throw new Error("result request finishedAt is too far in the future");
  }
  return request;
}

async function readSignedCodexAttestation(name) {
  const target = path.join(ATTESTATIONS, name);
  if (path.dirname(target) !== ATTESTATIONS) throw new Error("attestation path escapes its root");
  await validateRootOwnedFile(target, "Codex attestation", 0o644);
  const attestation = JSON.parse((await readFile(target)).toString("utf8"));
  const trust = await validateTrustRoot();
  if (attestation?.schemaVersion !== 1 || attestation.provider !== "codex" || attestation.issuer !== trust.value.issuer) {
    throw new Error("result request references an invalid Codex attestation");
  }
  const key = trust.value.publicKeys.find((item) => item.keyId === attestation.keyId && item.algorithm === "ed25519");
  if (!key) throw new Error("result request attestation key is not trusted");
  const { signature, ...payload } = attestation;
  const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
  if (!verify(null, Buffer.from(canonicalJson(payload), "utf8"), publicKey, Buffer.from(signature ?? "", "base64"))) {
    throw new Error("result request attestation signature is invalid");
  }
  return { attestation, digest: await digest(Buffer.from(canonicalJson(payload), "utf8")) };
}

async function signResultRequest(requestPath, confirmedDigest, outputName) {
  requireRoot();
  if (!SHA256.test(confirmedDigest)) throw new Error("confirmed request digest must be SHA-256");
  if (!SAFE_OUTPUT.test(outputName)) throw new Error("result receipt output name is unsafe");
  const requestBytes = await readFile(path.resolve(requestPath));
  if ((await digest(requestBytes)) !== confirmedDigest) {
    throw new Error("request digest does not match administrator-confirmed digest");
  }
  const request = validateResultRequest(JSON.parse(requestBytes.toString("utf8")));
  const binaryPath = await canonicalBinary(request.binary.path);
  const binaryDigest = await digest(await readFile(binaryPath));
  if (binaryPath !== request.binary.path || binaryDigest !== request.binary.digest) {
    throw new Error("result request binary identity does not match the current host binary");
  }
  const signedAttestation = await readSignedCodexAttestation(request.attestationName);
  const attestation = signedAttestation.attestation;
  if (
    signedAttestation.digest !== request.attestationDigest ||
    attestation.model !== request.model ||
    canonicalJson(attestation.execution) !== canonicalJson(request.execution) ||
    canonicalJson(attestation.binary) !== canonicalJson(request.binary)
  ) {
    throw new Error("result request does not match its host-signed execution attestation");
  }
  const trust = await validateTrustRoot();
  const trustRootDigest = await digest(Buffer.from(canonicalJson(trust.value), "utf8"));
  if (request.trustRootDigest !== trustRootDigest) {
    throw new Error("result request trust-root digest does not match the current host trust root");
  }
  await validateRootOwnedFile(PRIVATE_KEY, "Private signing key", 0o600);
  const key = trust.value.publicKeys[0];
  const issuedAt = new Date();
  const payload = {
    schemaVersion: 1,
    provider: "codex",
    kind: "execution-result",
    model: request.model,
    issuer: trust.value.issuer,
    keyId: key.keyId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    attestationDigest: request.attestationDigest,
    trustRootDigest,
    execution: request.execution,
    binary: request.binary,
    promptDigest: request.promptDigest,
    responseDigest: request.responseDigest,
    exitCode: request.exitCode,
    signal: request.signal,
    timedOut: request.timedOut,
    startedAt: request.startedAt,
    finishedAt: request.finishedAt
  };
  const privateKey = privateKeyFromRaw(await readFile(PRIVATE_KEY));
  const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64");
  const target = path.join(ATTESTATIONS, outputName);
  if (path.dirname(target) !== ATTESTATIONS) throw new Error("result receipt path escapes its root");
  await exclusiveWrite(target, `${JSON.stringify({ ...payload, signature }, null, 2)}\n`, 0o644);
  return target;
}

async function signBatch(manifestPath, confirmedManifestDigest) {
  requireRoot();
  if (!SHA256.test(confirmedManifestDigest)) {
    throw new Error("confirmed manifest digest must be SHA-256");
  }
  const bytes = await readFile(path.resolve(manifestPath));
  if ((await digest(bytes)) !== confirmedManifestDigest) {
    throw new Error("manifest digest does not match administrator-confirmed digest");
  }
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(manifest.requests) || manifest.requests.length !== 7) {
    throw new Error("batch manifest must contain exactly seven requests");
  }
  const names = new Set();
  for (const item of manifest.requests) {
    if (
      typeof item.request !== "string" ||
      !SHA256.test(item.requestDigest) ||
      !SAFE_OUTPUT.test(item.attestationName) ||
      names.has(item.attestationName)
    ) {
      throw new Error("batch manifest contains an invalid or duplicate request");
    }
    names.add(item.attestationName);
    if (await exists(path.join(ATTESTATIONS, item.attestationName))) {
      throw new Error(`refusing to overwrite attestation: ${item.attestationName}`);
    }
  }
  const outputs = [];
  for (const item of manifest.requests) {
    outputs.push(await signRequest(item.request, item.requestDigest, item.attestationName));
  }
  return { ok: true, outputs };
}

async function signNativeRequest(requestPath, confirmedDigest, outputName) {
  requireRoot();
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
  if (command === "status") return status();
  if (command === "provision") return provision();
  if (command === "sign") {
    if (!options.request || !options["confirm-digest"] || !options.output) {
      throw new Error("sign requires --request, --confirm-digest, and --output");
    }
    return {
      ok: true,
      output: await signRequest(options.request, options["confirm-digest"], options.output)
    };
  }
  if (command === "sign-batch") {
    if (!options.manifest || !options["confirm-digest"]) {
      throw new Error("sign-batch requires --manifest and --confirm-digest");
    }
    return signBatch(options.manifest, options["confirm-digest"]);
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
  if (command === "sign-result") {
    if (!options.request || !options["confirm-digest"] || !options.output) {
      throw new Error("sign-result requires --request, --confirm-digest, and --output");
    }
    return {
      ok: true,
      output: await signResultRequest(options.request, options["confirm-digest"], options.output)
    };
  }
  throw new Error("usage: host-trust.mjs status|provision|sign|sign-batch|sign-native|sign-result");
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
