import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
