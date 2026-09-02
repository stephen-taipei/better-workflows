import { constants as fsConstants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { fixedToolPath } from "./formal-evaluator.mjs";

const execFileAsync = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const NATIVE_REVIEW_TIMEOUT_MS = 45 * 60 * 1000;
const NATIVE_REVIEW_TIMEOUT_GRACE_MS = 5 * 1000;
const REVIEW_PROTOCOL = "native-review-tool-capable-v1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function boundedFile(target, label) {
  const canonical = await realpath(path.resolve(target));
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) {
    throw new Error(`${label} must be one bounded physical file`);
  }
  return { path: canonical, bytes: await readFile(canonical), info };
}

async function pathAbsent(target) {
  try { await lstat(target); return false; } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function executable(target) {
  try { await access(target, fsConstants.X_OK); return true; } catch { return false; }
}

async function locateCodex() {
  const candidates = [
    process.env.CODEX_BINARY,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(path.dirname(process.execPath), "codex")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && await executable(candidate)) return realpath(candidate);
  }
  const pathDirectories = String(process.env.PATH ?? "").split(path.delimiter);
  for (const directory of pathDirectories) {
    const candidate = path.join(directory, "codex");
    if (await executable(candidate)) return realpath(candidate);
  }
  throw new Error("Native review runner cannot locate one executable Codex binary");
}

async function locateGit() {
  for (const candidate of ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]) {
    if (await executable(candidate)) return realpath(candidate);
  }
  throw new Error("Native review runner cannot locate Git");
}

function normalizeManifest(payload) {
  if (!payload || !Array.isArray(payload.files)) throw new Error("Native review diff manifest requires files");
  const paths = [];
  for (const item of payload.files) {
    if (typeof item === "string") paths.push(item);
    else if (item && typeof item.path === "string") {
      if (typeof item.oldPath === "string") paths.push(item.oldPath);
      paths.push(item.path);
    } else throw new Error("Native review diff manifest entry is invalid");
  }
  if (paths.some((item) => !item || item.startsWith("/") || item.includes("\0") || item.split("/").includes(".."))) {
    throw new Error("Native review diff manifest path is unsafe");
  }
  return [...new Set(paths)].sort();
}

function parseNameStatus(output) {
  const tokens = Buffer.from(output).toString("utf8").split("\0");
  const paths = [];
  let index = 0;
  while (index < tokens.length && tokens[index]) {
    const status = tokens[index++];
    if (/^[RC]/.test(status)) {
      paths.push(tokens[index++], tokens[index++]);
    } else {
      paths.push(tokens[index++]);
    }
  }
  return [...new Set(paths.filter(Boolean))].sort();
}

function validateDisclosure(value, binding) {
  if (
    !value || value.schemaVersion !== 1 || value.kind !== "native-review-disclosure" ||
    value.authorized !== true || !SAFE_ID.test(String(value.authorizationId ?? "")) ||
    !Number.isFinite(Date.parse(value.approvedAt ?? ""))
  ) throw new Error("Native review disclosure authorization is invalid");
  for (const key of Object.keys(binding)) {
    if (value[key] !== binding[key]) throw new Error(`Native review disclosure authorization changed: ${key}`);
  }
  if (value.readOnly !== true || value.ephemeral !== true || value.remoteSideEffects !== false) {
    throw new Error("Native review disclosure authorization must remain read-only, ephemeral, and side-effect free");
  }
  return value;
}

function validateReview(value, { base, head, pathCount }) {
  const exactKeys = (target, keys) => (
    target && typeof target === "object" && !Array.isArray(target) &&
    JSON.stringify(Object.keys(target).sort()) === JSON.stringify([...keys].sort())
  );
  if (!value || value.schemaVersion !== 1 || !["PASS", "BLOCK"].includes(value.verdict) || !Array.isArray(value.findings)) {
    throw new Error("Native review final result does not match the frozen schema");
  }
  if (!exactKeys(value, ["schemaVersion", "verdict", "scopeCoverage", "findings"]) ||
      !exactKeys(value.scopeCoverage, ["base", "head", "manifestPathCount", "reviewedPathCount", "complete"])) {
    throw new Error("Native review final result contains an unfrozen field");
  }
  if (
    !value.scopeCoverage || value.scopeCoverage.base !== base || value.scopeCoverage.head !== head ||
    value.scopeCoverage.manifestPathCount !== pathCount || value.scopeCoverage.reviewedPathCount !== pathCount ||
    value.scopeCoverage.complete !== true
  ) throw new Error("Native review final result does not prove complete BASE..HEAD scope coverage");
  if (value.verdict === "PASS" && value.findings.length !== 0) throw new Error("Native review PASS cannot contain findings");
  if (value.verdict === "BLOCK" && value.findings.length === 0) throw new Error("Native review BLOCK requires at least one actionable finding");
  for (const finding of value.findings) {
    if (
      !finding || !["P0", "P1", "P2", "P3"].includes(finding.severity) ||
      !exactKeys(finding, ["severity", "path", "line", "title", "evidence", "requiredChange"]) ||
      typeof finding.path !== "string" || !finding.path || path.isAbsolute(finding.path) || finding.path.split("/").includes("..") ||
      typeof finding.title !== "string" || !finding.title.trim() ||
      !(finding.line === null || (Number.isInteger(finding.line) && finding.line > 0)) ||
      typeof finding.evidence !== "string" || typeof finding.requiredChange !== "string"
    ) {
      throw new Error("Native review finding is malformed");
    }
  }
  return value;
}

function reviewProtocol({ base, head, packageId, manifestPaths }) {
  return Buffer.from([
    `Better Workflows native review protocol: ${REVIEW_PROTOCOL}`,
    `Review only the exact Git range ${base}..${head}.`,
    `The immutable package is ${packageId}.`,
    "Do not substitute the current branch, working-tree diff, or another merge base.",
    `Reconcile every one of these ${manifestPaths.length} manifest paths exactly once:`,
    ...manifestPaths.map((item) => `- ${item}`),
    "You may use read-only tools while reviewing. Do not edit files or perform remote side effects.",
    "Your final message must be JSON only with this exact shape:",
    JSON.stringify({
      schemaVersion: 1,
      verdict: "PASS|BLOCK",
      scopeCoverage: {
        base,
        head,
        manifestPathCount: manifestPaths.length,
        reviewedPathCount: manifestPaths.length,
        complete: true
      },
      findings: [{
        severity: "P0|P1|P2|P3",
        path: "repository-relative path",
        line: null,
        title: "short title",
        evidence: "specific evidence",
        requiredChange: "required remediation"
      }]
    }),
    "A PASS result must have findings=[]. A BLOCK result must contain at least one actionable finding.",
    "The package-specific instruction follows:",
    ""
  ].join("\n"), "utf8");
}

export function spawnReview(
  command,
  args,
  {
    cwd,
    input,
    env = process.env,
    timeoutMs = NATIVE_REVIEW_TIMEOUT_MS,
    timeoutGraceMs = NATIVE_REVIEW_TIMEOUT_GRACE_MS
  }
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(timeoutGraceMs) || timeoutGraceMs < 1) {
    return Promise.reject(new Error("Native review timeout policy is invalid"));
  }
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
    let size = 0;
    let settled = false;
    const terminateGroup = (signal) => {
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch { /* child may already be terminal */ }
    };
    const forwardTerm = () => terminateGroup("SIGTERM");
    const forwardInt = () => terminateGroup("SIGINT");
    const cleanup = () => {
      process.off("SIGTERM", forwardTerm);
      process.off("SIGINT", forwardInt);
    };
    process.once("SIGTERM", forwardTerm);
    process.once("SIGINT", forwardInt);
    let timeoutEscalation;
    const clearTimers = () => {
      clearTimeout(timeout);
      if (timeoutEscalation) clearTimeout(timeoutEscalation);
    };
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      terminateGroup("SIGTERM");
      timeoutEscalation = setTimeout(() => {
        terminateGroup("SIGKILL");
        settleReject(new Error(`Native review timed out after ${timeoutMs}ms`));
      }, timeoutGraceMs);
      timeoutEscalation.unref();
    }, timeoutMs);
    timeout.unref();
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) {
        terminateGroup("SIGTERM");
        if (!settled) {
          settleReject(new Error("Native review transport output exceeded the bounded limit"));
        }
      } else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimers();
        cleanup();
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimers();
        cleanup();
        resolve({
          pid: child.pid,
          code,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      }
    });
    child.stdin.end(input);
  });
}

async function atomicJson(target, value) {
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, target);
  const directory = await open(path.dirname(target), fsConstants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function createJson(target, value) {
  const handle = await open(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  const directory = await open(path.dirname(target), fsConstants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function assertFileUnchanged(original, label) {
  const current = await boundedFile(original.path, label);
  if (current.info.dev !== original.info.dev || current.info.ino !== original.info.ino ||
      !current.bytes.equals(original.bytes)) {
    throw new Error(`${label} changed during native review`);
  }
}

export async function runNativeReview({
  runId,
  runDir,
  cwd,
  base,
  head,
  packageId,
  packagePath,
  manifestPath,
  instructionPath,
  authorizationPath,
  model,
  reviewerId,
  executionId,
  resultPath,
  timeoutMs = NATIVE_REVIEW_TIMEOUT_MS,
  timeoutGraceMs = NATIVE_REVIEW_TIMEOUT_GRACE_MS
}) {
  if (!SAFE_ID.test(String(runId ?? "")) || !SHA.test(String(base ?? "")) || !SHA.test(String(head ?? "")) || !SAFE_ID.test(String(packageId ?? "")) ||
      !SAFE_ID.test(String(model ?? "")) || !SAFE_ID.test(String(reviewerId ?? "")) || !SAFE_ID.test(String(executionId ?? ""))) {
    throw new Error("Native review exact identity is invalid");
  }
  if (!path.isAbsolute(resultPath) || path.resolve(resultPath) !== resultPath || !(await pathAbsent(resultPath))) {
    throw new Error("Native review result path must be absolute and absent");
  }
  const resultDirectory = await realpath(path.dirname(resultPath));
  const resultDirectoryInfo = await lstat(resultDirectory);
  const requestedResultDirectory = path.dirname(resultPath);
  const stableMacAlias = process.platform === "darwin" && (
    (requestedResultDirectory === "/var" || requestedResultDirectory.startsWith("/var/")) && resultDirectory === `/private${requestedResultDirectory}` ||
    (requestedResultDirectory === "/tmp" || requestedResultDirectory.startsWith("/tmp/")) && resultDirectory === `/private${requestedResultDirectory}`
  );
  if ((resultDirectory !== requestedResultDirectory && !stableMacAlias) || !resultDirectoryInfo.isDirectory() || resultDirectoryInfo.isSymbolicLink()) {
    throw new Error("Native review result parent must be one canonical physical directory");
  }
  const repository = await realpath(path.resolve(cwd));
  const canonicalRunDir = await realpath(path.resolve(runDir));
  const packageFile = await boundedFile(packagePath, "Native review package");
  const expectedPackagePath = path.join(canonicalRunDir, "review-packages", `${packageId}.json`);
  if (packageFile.path !== expectedPackagePath) {
    throw new Error("Native review package must be the canonical run-owned immutable package");
  }
  const manifestFile = await boundedFile(manifestPath, "Native review manifest");
  const instructionFile = await boundedFile(instructionPath, "Native review instruction");
  const authorizationFile = await boundedFile(authorizationPath, "Native review authorization");
  const packageValue = JSON.parse(packageFile.bytes.toString("utf8"));
  if (packageValue.packageId !== packageId || packageValue.base !== base || packageValue.head !== head || packageValue.immutable !== true) {
    throw new Error("Native review package does not bind the exact immutable BASE..HEAD identity");
  }
  const manifestValue = JSON.parse(manifestFile.bytes.toString("utf8"));
  const manifestPaths = normalizeManifest(manifestValue);
  const gitPath = await locateGit();
  const headResult = String((await execFileAsync(gitPath, ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: repository, encoding: "utf8" })).stdout).trim();
  if (headResult !== head) throw new Error("Native review HEAD changed before launch");
  const clean = String((await execFileAsync(gitPath, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: repository, encoding: "utf8" })).stdout);
  if (clean) throw new Error("Native review requires a clean committed tree");
  const diff = await execFileAsync(gitPath, ["diff", "--name-status", "-z", `${base}..${head}`], {
    cwd: repository,
    encoding: "buffer",
    maxBuffer: MAX_FILE_BYTES
  });
  const gitPaths = parseNameStatus(diff.stdout);
  if (JSON.stringify(gitPaths) !== JSON.stringify(manifestPaths)) {
    throw new Error("Native review manifest does not cover the exact BASE..HEAD path set");
  }
  const binding = {
    runId,
    repository,
    base,
    head,
    packageId,
    packageSha256: sha256(packageFile.bytes),
    manifestSha256: sha256(manifestFile.bytes),
    instructionSha256: sha256(instructionFile.bytes),
    reviewProtocol: REVIEW_PROTOCOL,
    model,
    reviewerId,
    executionId,
    resultPath
  };
  validateDisclosure(JSON.parse(authorizationFile.bytes.toString("utf8")), binding);
  const protocol = reviewProtocol({ base, head, packageId, manifestPaths });
  const reviewInput = Buffer.concat([protocol, instructionFile.bytes]);
  const codex = await locateCodex();
  const toolPath = await fixedToolPath();
  const reviewPath = [...new Set([
    path.dirname(process.execPath),
    toolPath,
    process.env.PATH
  ].filter(Boolean).flatMap((value) => value.split(path.delimiter)))].join(path.delimiter);
  const args = [
    "-a", "never",
    "exec",
    "--model", model,
    "--sandbox", "read-only",
    "--cd", repository,
    "--ephemeral",
    "--ignore-user-config",
    "--output-last-message", resultPath,
    "-"
  ];
  const receiptPath = `${resultPath}.receipt.json`;
  const attemptDirectory = path.join(canonicalRunDir, "native-review-attempts");
  await mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
  const attemptDirectoryInfo = await lstat(attemptDirectory);
  if (!attemptDirectoryInfo.isDirectory() || attemptDirectoryInfo.isSymbolicLink()) {
    throw new Error("Native review attempt directory is unsafe");
  }
  await chmod(attemptDirectory, 0o700);
  const attemptPath = path.join(attemptDirectory, `${packageId}.json`);
  if (!(await pathAbsent(attemptPath))) {
    throw new Error("Native review package already has a consumed model attempt");
  }
  if (!(await pathAbsent(receiptPath))) {
    throw new Error("Native review receipt path must be absent before consuming the package attempt");
  }
  const startedAt = new Date().toISOString();
  await createJson(attemptPath, {
    schemaVersion: 1,
    status: "running",
    startedAt,
    runId,
    packageId,
    reviewerId,
    executionId,
    resultPath,
    receiptPath
  });
  try {
    await atomicJson(receiptPath, { schemaVersion: 1, status: "running", startedAt, binding, command: [codex, ...args] });
  } catch (error) {
    await atomicJson(attemptPath, {
      schemaVersion: 1,
      status: "blocked",
      startedAt,
      finishedAt: new Date().toISOString(),
      runId,
      packageId,
      reviewerId,
      executionId,
      resultPath,
      receiptPath,
      launchError: error.message
    }).catch(() => undefined);
    throw error;
  }
  let execution;
  try {
    execution = await spawnReview(codex, args, {
      cwd: repository,
      input: reviewInput,
      env: { ...process.env, PATH: reviewPath },
      timeoutMs,
      timeoutGraceMs
    });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await atomicJson(receiptPath, {
      schemaVersion: 1, status: "blocked", startedAt, finishedAt, binding,
      command: [codex, ...args], launchError: error.message
    }).catch(() => undefined);
    await atomicJson(attemptPath, {
      schemaVersion: 1, status: "blocked", startedAt, finishedAt,
      runId, packageId, reviewerId, executionId, resultPath, receiptPath,
      launchError: error.message
    });
    throw error;
  }
  if (execution.code !== 0) {
    const finishedAt = new Date().toISOString();
    await atomicJson(receiptPath, { schemaVersion: 1, status: "blocked", finishedAt, binding, execution });
    await atomicJson(attemptPath, { schemaVersion: 1, status: "blocked", finishedAt, runId, packageId, reviewerId, executionId, resultPath, receiptPath });
    throw new Error(`Native review process exited ${execution.code ?? execution.signal}: ${execution.stderr.trim()}`);
  }
  try {
    const resultFile = await boundedFile(resultPath, "Native review result");
    const result = validateReview(JSON.parse(resultFile.bytes.toString("utf8")), {
      base,
      head,
      pathCount: manifestPaths.length
    });
    await assertFileUnchanged(packageFile, "Native review package");
    await assertFileUnchanged(manifestFile, "Native review manifest");
    await assertFileUnchanged(instructionFile, "Native review instruction");
    await assertFileUnchanged(authorizationFile, "Native review authorization");
    const postHead = String((await execFileAsync(gitPath, ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: repository, encoding: "utf8" })).stdout).trim();
    const postClean = String((await execFileAsync(gitPath, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: repository, encoding: "utf8" })).stdout);
    if (postHead !== head || postClean) throw new Error("Native review changed the exact source tree");
    const receipt = {
      schemaVersion: 1,
      status: result.verdict === "PASS" ? "passed" : "blocked",
      finishedAt: new Date().toISOString(),
      binding,
      command: [codex, ...args],
      execution,
      result,
      resultSha256: sha256(resultFile.bytes),
      scopeCoverage: { expected: manifestPaths.length, observed: gitPaths.length, complete: true },
      postflight: { head: postHead, clean: true }
    };
    await atomicJson(receiptPath, receipt);
    await atomicJson(attemptPath, {
      schemaVersion: 1,
      status: result.verdict === "PASS" ? "passed" : "blocked",
      finishedAt: receipt.finishedAt,
      runId,
      packageId,
      reviewerId,
      executionId,
      resultPath,
      resultSha256: receipt.resultSha256,
      receiptPath
    });
    return { ok: result.verdict === "PASS", result, resultSha256: receipt.resultSha256, receipt: receiptPath };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await atomicJson(receiptPath, {
      schemaVersion: 1,
      status: "blocked",
      finishedAt,
      binding,
      command: [codex, ...args],
      execution,
      validationError: error.message
    }).catch(() => undefined);
    await atomicJson(attemptPath, {
      schemaVersion: 1,
      status: "blocked",
      finishedAt,
      runId,
      packageId,
      reviewerId,
      executionId,
      resultPath,
      receiptPath,
      validationError: error.message
    });
    throw error;
  }
}
