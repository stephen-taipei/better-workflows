import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson, sha256 } from "./core.mjs";

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "BLOCK"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "issue", "evidence", "requiredChange"],
        properties: {
          severity: { type: "string", enum: ["P0", "P1", "P2"] },
          issue: { type: "string" },
          evidence: { type: "string" },
          requiredChange: { type: "string" }
        }
      }
    }
  }
};

const EVALUATION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["results"],
  properties: { results: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["id", "disposition", "passedAssertions"], properties: {
      id: { type: "string" },
      disposition: { type: "string", enum: ["IMPLEMENT", "NO_CHANGE", "BLOCKED", "REJECTED_WITH_EVIDENCE"] },
      passedAssertions: { type: "array", items: { type: "string" } }
    } } } }
};
const HOST_TRUST_ROOT_PATH = "/etc/better-workflows/codex-trust-root.json";

function safeEnvironment(extra = {}) {
  const allowed = [
    "PATH",
    "HOME",
    "CODEX_HOME",
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
  const env = {};
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

function terminateTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

export async function spawnCapture(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = safeEnvironment(),
    input,
    timeoutMs = 90_000,
    maxOutputBytes = 2 * 1024 * 1024
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      if (error) reject(error);
      else resolve(result);
    };
    const collect = (bucket) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminateTree(child, "SIGTERM");
        finish(new Error("Provider output exceeded the configured limit"));
        return;
      }
      bucket.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      finish(null, {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    const timeout = setTimeout(() => terminateTree(child, "SIGTERM"), timeoutMs);
    const forceKill = setTimeout(() => terminateTree(child, "SIGKILL"), timeoutMs + 2_000);
  });
}

async function commandPath(command) {
  const result = await spawnCapture("command", ["-v", command], {
    timeoutMs: 10_000,
    maxOutputBytes: 16_384
  }).catch(() => null);
  if (result?.code === 0 && result.stdout.trim()) return result.stdout.trim();
  const which = await spawnCapture("which", [command], {
    timeoutMs: 10_000,
    maxOutputBytes: 16_384
  });
  if (which.code !== 0 || !which.stdout.trim()) throw new Error(`Command not found: ${command}`);
  return which.stdout.trim();
}

async function hashFile(target) {
  const resolved = await realpath(target);
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(resolved);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required`);
  return value;
}

async function secureJsonFile(file, label) {
  if (!path.isAbsolute(file)) throw new Error(`${label} must be an absolute host path`);
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  if (((info.mode & 0o777) & 0o022) !== 0) throw new Error(`${label} must not be group/world writable`);
  return { path: await realpath(file), info, value: JSON.parse(await readFile(file, "utf8")) };
}

async function hostAnchoredTrustRoot() {
  const trustRoot = await secureJsonFile(HOST_TRUST_ROOT_PATH, "Host Codex trust root").catch((error) => {
    if (error.code === "ENOENT") throw new Error("Host Codex trust root is not provisioned");
    throw error;
  });
  if (trustRoot.info.uid !== 0) throw new Error("Host Codex trust root must be owned by the host administrator");
  let directory = path.dirname(trustRoot.path);
  while (true) {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== 0 || ((info.mode & 0o777) & 0o022) !== 0) {
      throw new Error("Host Codex trust-root directory is not administrator-owned and immutable");
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return trustRoot;
}

function unsignedAttestation(attestation) {
  const { signature, ...payload } = attestation;
  return payload;
}

/**
 * Trust is not inferred from PATH, a self-hash, or a model response. The host
 * supplies a signed binding of the exact binary and requested model, verified
 * against a separately protected root outside the evaluated repository.
 */
export async function verifyTrustedCodexAttestation({ attestationPath, evaluationRoot, model }) {
  if (!attestationPath) throw new Error("Codex evaluation requires --trusted-codex-attestation");
  const evaluation = await realpath(evaluationRoot);
  const [attestationFile, trustRootFile] = await Promise.all([
    secureJsonFile(path.resolve(attestationPath), "Trusted Codex attestation"),
    hostAnchoredTrustRoot()
  ]);
  if (isWithin(evaluation, attestationFile.path)) throw new Error("Trusted Codex attestation must be a host-provided file outside the evaluated repository");
  const attestation = attestationFile.value;
  const trustRoot = trustRootFile.value;
  if (attestation?.schemaVersion !== 1 || trustRoot?.schemaVersion !== 1) throw new Error("Trusted Codex attestation and trust root schemaVersion must be 1");
  if (attestation.provider !== "codex" || attestation.model !== model) throw new Error("Trusted Codex attestation must bind provider codex and the requested model");
  if (attestation.issuer !== trustRoot.issuer) throw new Error("Trusted Codex attestation issuer is not trusted");
  const key = Array.isArray(trustRoot.publicKeys) ? trustRoot.publicKeys.find((item) => item?.keyId === attestation.keyId && item.algorithm === "ed25519") : null;
  if (!key || typeof key.publicKey !== "string") throw new Error("Trusted Codex attestation key is not available in the trust root");
  const issuedAt = Date.parse(requiredString(attestation.issuedAt, "Trusted Codex attestation issuedAt"));
  const expiresAt = Date.parse(requiredString(attestation.expiresAt, "Trusted Codex attestation expiresAt"));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > Date.now() + 300_000 || expiresAt <= Date.now()) throw new Error("Trusted Codex attestation is not currently valid");
  const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
  const signature = Buffer.from(requiredString(attestation.signature, "Trusted Codex attestation signature"), "base64");
  if (!verify(null, Buffer.from(canonicalJson(unsignedAttestation(attestation)), "utf8"), publicKey, signature)) throw new Error("Trusted Codex attestation signature is invalid");
  const binary = attestation.binary;
  if (!binary || typeof binary.path !== "string" || !path.isAbsolute(binary.path) || !/^[a-f0-9]{64}$/.test(binary.digest ?? "")) throw new Error("Trusted Codex attestation requires an absolute binary path and SHA-256 digest");
  const binaryInfo = await lstat(binary.path);
  if (binaryInfo.isSymbolicLink() || !binaryInfo.isFile()) throw new Error("Trusted Codex binary must be a regular non-symlink file");
  if ((((await stat(binary.path)).mode & 0o777) & 0o022) !== 0) throw new Error("Trusted Codex binary must not be group/world writable");
  const command = await realpath(binary.path);
  if (command !== binary.path) throw new Error("Trusted Codex attestation binary path must already be canonical");
  const digest = await hashFile(command);
  if (digest !== binary.digest) throw new Error("Trusted Codex binary digest does not match the signed attestation");
  return { command, metadata: {
    provider: "codex", requestedModel: model, reportedModel: model, modelAssurance: "host-signed-attestation", trustAttested: true,
    attestationDigest: sha256(canonicalJson(unsignedAttestation(attestation))), trustRootDigest: sha256(canonicalJson(trustRoot)),
    attestationPath: attestationFile.path, issuer: attestation.issuer, keyId: attestation.keyId, expiresAt: attestation.expiresAt, binary: { path: command, digest }
  } };
}

export async function binaryIdentity(command) {
  const target = await commandPath(command);
  return { path: target, digest: await hashFile(target) };
}

function extractJson(output) {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("Provider returned empty output");
  const withoutFence = trimmed
    .replace(/^~~~(?:json)?\s*/i, "")
    .replace(/~~~\s*$/i, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Provider did not return a JSON object");
  return JSON.parse(withoutFence.slice(start, end + 1));
}

function validateReview(review) {
  if (!review || !["PASS", "BLOCK"].includes(review.verdict)) {
    throw new Error("Critic verdict must be PASS or BLOCK");
  }
  if (typeof review.summary !== "string" || !Array.isArray(review.findings)) {
    throw new Error("Critic response schema is invalid");
  }
  for (const finding of review.findings) {
    if (
      !["P0", "P1", "P2"].includes(finding.severity) ||
      ["issue", "evidence", "requiredChange"].some((key) => typeof finding[key] !== "string")
    ) {
      throw new Error("Critic finding schema is invalid");
    }
  }
  return review;
}

function criticPrompt(prompt) {
  return [
    "You are an independent adversarial reviewer.",
    "In this workflow, Root means the main orchestrating Codex agent, never the Unix root user or elevated OS privileges.",
    "Do not use tools, browse, modify files, authorize side effects, or decide by majority vote.",
    "Return only one JSON object with verdict PASS or BLOCK, summary, and findings.",
    "Each finding must include severity P0/P1/P2, issue, evidence, and requiredChange.",
    "",
    prompt
  ].join("\n");
}

export async function runCodexCritic({ model, effort, prompt, timeoutMs = 120_000 }) {
  if (!model || !effort || !prompt) throw new Error("Codex critic requires model, effort, and prompt");
  const bundle = await mkdtemp(path.join(os.tmpdir(), "sbw-codex-critic-"));
  await chmod(bundle, 0o700);
  const schemaPath = path.join(bundle, "review.schema.json");
  await writeFile(schemaPath, `${JSON.stringify(REVIEW_SCHEMA, null, 2)}\n`, { mode: 0o600 });
  const identity = await binaryIdentity("codex");
  const startedAt = new Date().toISOString();
  try {
    const result = await spawnCapture(
      "codex",
      [
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "-C",
        bundle,
        "--output-schema",
        schemaPath,
        "-m",
        model,
        "-c",
        `model_reasoning_effort="${effort}"`,
        "-"
      ],
      {
        cwd: bundle,
        input: criticPrompt(prompt),
        timeoutMs,
        maxOutputBytes: 2 * 1024 * 1024
      }
    );
    if (result.code !== 0) {
      throw new Error(`Codex critic failed with exit ${result.code}: ${result.stderr.trim()}`);
    }
    const review = validateReview(extractJson(result.stdout));
    return {
      review,
      metadata: {
        provider: "codex",
        requestedModel: model,
        reportedModel: model,
        modelAssurance: "requested-not-attested",
        effort,
        binary: identity,
        startedAt,
        finishedAt: new Date().toISOString(),
        transport: "stdin",
        sandbox: "read-only",
        ephemeral: true
      }
    };
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
}

export async function runCodexEvaluation({ model, prompt, timeoutMs = 120_000, attestationPath, evaluationRoot }) {
  if (!model || !prompt || !evaluationRoot) throw new Error("Codex evaluation requires model, prompt, and evaluation root");
  const trusted = await verifyTrustedCodexAttestation({ attestationPath, evaluationRoot, model });
  const bundle = await mkdtemp(path.join(os.tmpdir(), "sbw-codex-evaluation-"));
  await chmod(bundle, 0o700);
  const schemaPath = path.join(bundle, "evaluation.schema.json");
  await writeFile(schemaPath, `${JSON.stringify(EVALUATION_SCHEMA, null, 2)}\n`, { mode: 0o600 });
  const startedAt = new Date().toISOString();
  try {
    const result = await spawnCapture(trusted.command, [
      "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
      "-C", bundle, "--output-schema", schemaPath, "-m", model, "-c", "model_reasoning_effort=\"high\"", "-"
    ], { cwd: bundle, input: prompt, timeoutMs, maxOutputBytes: 2 * 1024 * 1024 });
    if (result.code !== 0) throw new Error(`Codex evaluation failed with exit ${result.code}: ${result.stderr.trim()}`);
    const response = extractJson(result.stdout);
    if (!response || !Array.isArray(response.results)) throw new Error("Codex evaluation returned malformed structured output");
    return { response, metadata: { ...trusted.metadata, startedAt, finishedAt: new Date().toISOString(), transport: "stdin", sandbox: "read-only", ephemeral: true, outputSchema: "evaluation-v1" } };
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
}

export async function runAgyCritic({
  model,
  effort = "high",
  effortTransport = "native",
  prompt,
  contract,
  config,
  timeoutMs,
  command = "agy"
}) {
  if (!["medium", "high"].includes(effort)) {
    throw new Error("Agy reasoning effort must be medium or high");
  }
  if (!["native", "model-variant"].includes(effortTransport)) {
    throw new Error("Agy effort transport must be native or model-variant");
  }
  if (!contract.agy?.allowed || !contract.agy?.sanitized) {
    throw new Error("Agy requires explicit egress authorization and a sanitized bundle");
  }
  if (!config.providers.agy.allowedSensitivities.includes(contract.sensitivity)) {
    throw new Error(`Agy is unavailable for sensitivity: ${contract.sensitivity}`);
  }
  const fullPrompt = criticPrompt(prompt);
  const bytes = Buffer.byteLength(fullPrompt, "utf8");
  if (bytes > config.providers.agy.maxPromptBytes) {
    throw new Error(`Agy prompt exceeds byte limit: ${bytes}`);
  }
  const bundle = await mkdtemp(path.join(os.tmpdir(), "sbw-agy-critic-"));
  await chmod(bundle, 0o700);
  const identity = await binaryIdentity(command);
  const startedAt = new Date().toISOString();
  try {
    const args = [
      "--log-file",
      path.join(bundle, "agy.log"),
      `--prompt=${fullPrompt}`,
      "--sandbox",
      "--mode",
      "plan",
      "--model",
      model
    ];
    if (effortTransport === "native") args.push("--effort", effort);
    args.push(
      "--print-timeout",
      `${Math.ceil((timeoutMs ?? config.providers.agy.timeoutSeconds * 1000) / 1000)}s`
    );
    const result = await spawnCapture(
      command,
      args,
      {
        cwd: bundle,
        timeoutMs: timeoutMs ?? config.providers.agy.timeoutSeconds * 1000,
        maxOutputBytes: 1024 * 1024
      }
    );
    if (result.code !== 0) {
      throw new Error(`Agy critic failed with exit ${result.code}: ${result.stderr.trim()}`);
    }
    const review = validateReview(extractJson(result.stdout));
    return {
      review,
      metadata: {
        provider: "agy",
        requestedModel: model,
        reportedModel: model,
        modelAssurance: "requested-not-attested",
        reasoningEffort: effort,
        effortTransport,
        binary: identity,
        startedAt,
        finishedAt: new Date().toISOString(),
        transport: "argv",
        argvExposure: true,
        sanitized: true,
        promptBytes: bytes,
        sandboxRequested: true
      }
    };
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
}

export async function doctorCodex() {
  const identity = await binaryIdentity("codex");
  const version = await spawnCapture("codex", ["--version"], {
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  });
  return {
    ok: version.code === 0,
    version: version.stdout.trim(),
    binary: identity
  };
}

export async function doctorAgy({
  model,
  effort = "high",
  effortTransport = "native",
  command = "agy",
  timeoutMs = 45_000
}) {
  if (!["medium", "high"].includes(effort)) {
    throw new Error("Agy reasoning effort must be medium or high");
  }
  if (!["native", "model-variant"].includes(effortTransport)) {
    throw new Error("Agy effort transport must be native or model-variant");
  }
  const identity = await binaryIdentity(command);
  const bundle = await mkdtemp(path.join(os.tmpdir(), "sbw-agy-doctor-"));
  await chmod(bundle, 0o700);
  try {
    const args = [
      "--log-file",
      path.join(bundle, "agy.log"),
      "--prompt=Reply with exactly AGY_DOCTOR_OK and nothing else.",
      "--sandbox",
      "--mode",
      "plan",
      "--model",
      model
    ];
    if (effortTransport === "native") args.push("--effort", effort);
    args.push("--print-timeout", `${Math.ceil(timeoutMs / 1000)}s`);
    const result = await spawnCapture(
      command,
      args,
      { cwd: bundle, timeoutMs, maxOutputBytes: 256 * 1024 }
    );
    return {
      ok: result.code === 0 && result.stdout.trim() === "AGY_DOCTOR_OK",
      output: result.stdout.trim(),
      stderr: result.stderr.trim(),
      requestedModel: model,
      reasoningEffort: effort,
      effortTransport,
      binary: identity,
      transport: "argv",
      argvExposure: true
    };
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
}
