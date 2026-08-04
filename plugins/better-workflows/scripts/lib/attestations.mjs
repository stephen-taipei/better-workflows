import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluationBindingDigest,
  loadFrozenEvaluationSuite,
  loadMigrationTargetSuite,
  buildEvaluationPrompt,
  readSanitizedCandidateMaterial,
  readSanitizedBaselineMaterial,
  snapshotCandidate,
  snapshotBaselineForCandidate,
  selectEvaluationCases,
  SELF_IMPROVE_CANONICAL_CORPUS,
  SELF_IMPROVE_MIGRATION_SOURCE_CORPUS,
  ordinaryCorpusForBaseline
} from "./self-improve.mjs";
import { captureSourceBinding } from "./git.mjs";
import { bundleDigest } from "./publication.mjs";
import { binaryIdentity } from "./providers.mjs";

const HOST_TRUST_TOOL = "/private/var/db/better-workflows/bin/bw-host-trust.mjs";
const execFileAsync = promisify(execFile);
const HOST_RUNTIME_ROOT = "/private/var/db/better-workflows/bin";
const CODEX_TARGET_TRIPLE = process.platform === "darwin" && process.arch === "arm64"
  ? "aarch64-apple-darwin"
  : process.platform === "darwin" && process.arch === "x64"
    ? "x86_64-apple-darwin"
    : null;
const HOST_ADMIN_SHELL = [
  "set -eu",
  "runtime_digest=\"$1\"",
  "manifest=\"$2\"",
  "manifest_digest=\"$3\"",
  "printf '%s\\n' \"$runtime_digest\" | /usr/bin/grep -Eq '^[a-f0-9]{64}$' || { echo 'runtime digest is not a SHA-256 value' >&2; exit 126; }",
  `target=\"${HOST_RUNTIME_ROOT}/bw-host-node.$runtime_digest\"`,
  "[ ! -L \"$target\" ] && [ -f \"$target\" ] && [ \"$(/usr/bin/stat -f %u \"$target\")\" = \"0\" ] && [ \"$(/usr/bin/stat -f %Lp \"$target\")\" = \"755\" ] || { echo 'administrator runtime target is not root-owned 0755' >&2; exit 126; }",
  "actual=$(/usr/bin/shasum -a 256 \"$target\" | /usr/bin/awk '{print $1}')",
  "[ \"$actual\" = \"$runtime_digest\" ] || { echo 'administrator runtime digest mismatch' >&2; exit 126; }",
  "exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \"$target\" \"${HOST_TRUST_TOOL}\" execute-batch --manifest \"$manifest\" --confirm-digest \"$manifest_digest\""
].join("\n");

async function installedRuntime() {
  let status;
  try {
    const result = await execFileAsync(process.execPath, [HOST_TRUST_TOOL, "status"], {
      encoding: "utf8",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
      maxBuffer: 1024 * 1024
    });
    status = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Administrator host status is unavailable; run host-trust upgrade first: ${error.message}`);
  }
  const runtime = status?.runtime;
  const codexBinary = status?.codexBinary;
  if (!status.ready || !runtime?.supported || typeof runtime.path !== "string" || !/^[a-f0-9]{64}$/.test(runtime.digest ?? "") ||
      !codexBinary?.supported || !/^[a-f0-9]{64}$/.test(codexBinary.registryDigest ?? "") || !Array.isArray(codexBinary.validEntries) ||
      runtime.path !== `${HOST_RUNTIME_ROOT}/bw-host-node.${runtime.digest}`) {
    throw new Error("Administrator host runtime is not ready; install the fixed root-owned runtime, launcher, probe, signer, and approved Codex binary before generating replay requests");
  }
  return { path: runtime.path, digest: runtime.digest, codexBinary };
}

function isMachO(bytes) {
  if (bytes.length < 4) return false;
  const little = bytes.readUInt32LE(0);
  const big = bytes.readUInt32BE(0);
  return [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(little) ||
    [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(big);
}

async function codexExecutableIdentity(binaryPath) {
  const supplied = await binaryIdentity(binaryPath ?? "codex");
  const candidates = [supplied.path];
  if (!binaryPath && CODEX_TARGET_TRIPLE) {
    const packageRoot = path.resolve(path.dirname(supplied.path), "..");
    candidates.push(path.join(packageRoot, "vendor", CODEX_TARGET_TRIPLE, "bin", "codex"));
    try {
      const require = createRequire(supplied.path);
      const packageName = CODEX_TARGET_TRIPLE === "aarch64-apple-darwin"
        ? "@openai/codex-darwin-arm64"
        : "@openai/codex-darwin-x64";
      const packageJson = require.resolve(`${packageName}/package.json`);
      candidates.push(path.join(path.dirname(packageJson), "vendor", CODEX_TARGET_TRIPLE, "bin", "codex"));
    } catch {
      // The wrapper's adjacent vendor path remains the only fallback.
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const identity = await binaryIdentity(candidate);
      if (isMachO(await readFile(identity.path))) return identity;
    } catch {
      // Try the next deterministic vendor location.
    }
  }
  throw new Error("Codex replay requires an administrator-approved native Mach-O Codex executable; the JS wrapper and incomplete vendor bundles are rejected");
}

export async function generateAttestationRequests({
  repo,
  runId,
  baselineRevision,
  candidateRoot,
  model,
  outputDirectory,
  binaryPath = null,
  casesFile = null,
  purpose = "ordinary",
  nextCasesFile = null
}) {
  const resolvedRepo = await realpath(repo);
  const sourceBinding = await captureSourceBinding(resolvedRepo, { baseRevision: baselineRevision });
  if (!sourceBinding?.headRevision || !sourceBinding.digest) {
    throw new Error("Attestation requests require an exact Git source binding");
  }
  const publishableBundleDigest = await bundleDigest(path.join(resolvedRepo, "plugins", "better-workflows"));
  const runtime = await installedRuntime();
  const binary = await codexExecutableIdentity(binaryPath);
  const resolvedBinary = binary.path;
  if (binaryPath && resolvedBinary !== binaryPath) {
    throw new Error("Codex binary argument must already be canonical");
  }
  const approvedBinary = runtime.codexBinary.validEntries.find((entry) => entry.path === resolvedBinary && entry.digest === binary.digest);
  if (!approvedBinary) {
    throw new Error("Codex binary is not administrator-approved by the fixed host allowlist");
  }
  const outputDir = path.resolve(outputDirectory);
  if (
    outputDir === resolvedRepo ||
    outputDir.startsWith(`${resolvedRepo}${path.sep}`)
  ) {
    throw new Error("Attestation requests must be written outside the repository");
  }
  const defaultCasesFile = purpose === "evaluator-migration"
    ? SELF_IMPROVE_MIGRATION_SOURCE_CORPUS
    : await ordinaryCorpusForBaseline({ cwd: resolvedRepo, baselineRevision });
  const frozen = await loadFrozenEvaluationSuite({
    cwd: resolvedRepo,
    casesFile: path.resolve(
      resolvedRepo,
      casesFile ?? defaultCasesFile
    ),
    baselineRevision,
    canonical: true,
    purpose
  });
  const target = purpose === "evaluator-migration"
    ? await loadMigrationTargetSuite({
      cwd: resolvedRepo,
      casesFile: path.resolve(resolvedRepo, nextCasesFile ?? SELF_IMPROVE_CANONICAL_CORPUS)
    })
    : null;
  const suiteDigest = evaluationBindingDigest({
    purpose,
    sourceSuiteDigest: frozen.sourceDigest,
    targetSuiteDigest: target?.sourceDigest
  });
  const candidate = await snapshotCandidate({
    cwd: resolvedRepo,
    baselineRevision: frozen.baselineRevision,
    candidateRoot
  });
  const candidateMaterial = await readSanitizedCandidateMaterial({
    cwd: resolvedRepo,
    snapshot: candidate
  });
  const baseline = await snapshotBaselineForCandidate({ cwd: resolvedRepo, snapshot: candidate });
  const baselineMaterial = await readSanitizedBaselineMaterial({ cwd: resolvedRepo, snapshot: baseline });
  const promptByRoleAndSplit = new Map();
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function" || process.getuid() <= 0 || process.getgid() <= 0) {
    throw new Error("Execution requests must be generated by the non-root maintainer user");
  }
  const homePath = await realpath(process.env.HOME ?? "").catch(() => {
    throw new Error("Execution requests require a canonical maintainer HOME");
  });
  let codexHomePath = null;
  const requestedCodexHome = process.env.CODEX_HOME ?? path.join(homePath, ".codex");
  try {
    codexHomePath = await realpath(requestedCodexHome);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const runAs = {
    uid: process.getuid(),
    gid: process.getgid(),
    homePath,
    codexHomePath
  };
  for (const split of ["train", "holdout"]) {
    const cases = selectEvaluationCases({ suite: frozen.suite, snapshot: candidate, split });
    promptByRoleAndSplit.set(`candidate:${split}`, buildEvaluationPrompt({
      suite: { ...frozen.suite, cases },
      candidate,
      materials: candidateMaterial
    }));
    promptByRoleAndSplit.set(`baseline:${split}`, buildEvaluationPrompt({
      suite: { ...frozen.suite, cases },
      candidate: baseline,
      materials: baselineMaterial
    }));
  }
  const executions = [
    { split: "train", role: "train-candidate", attempt: 1 },
    { split: "holdout", role: "candidate", attempt: 1 },
    { split: "holdout", role: "candidate", attempt: 2 },
    { split: "holdout", role: "candidate", attempt: 3 },
    { split: "holdout", role: "baseline", attempt: 1 },
    { split: "holdout", role: "baseline", attempt: 2 },
    { split: "holdout", role: "baseline", attempt: 3 }
  ];
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  const records = [];
  for (const item of executions) {
    const execution = {
      id: `${runId}-${item.split}-${item.role}-${item.attempt}`,
      runId,
      suiteDigest,
      baselineRevision: frozen.baselineRevision,
      candidateDigest: candidate.digest,
      headRevision: sourceBinding.headRevision,
      promptDigest: createHash("sha256")
        .update(promptByRoleAndSplit.get(`${item.role === "train-candidate" ? "candidate" : item.role}:${item.split}`))
        .digest("hex"),
      role: item.role,
      sourceBindingDigest: sourceBinding.digest,
      attempt: item.attempt
    };
    const prompt = promptByRoleAndSplit.get(`${item.role === "train-candidate" ? "candidate" : item.role}:${item.split}`);
    const promptBytes = Buffer.from(prompt);
    const promptFilename = `${execution.id}.prompt.txt`;
    const promptFile = path.join(outputDir, promptFilename);
    await writeFile(promptFile, promptBytes, { mode: 0o600, flag: "wx" });
    const promptDigest = createHash("sha256").update(promptBytes).digest("hex");
    const request = {
      binaryApprovalDigest: runtime.codexBinary.registryDigest,
      binaryDigest: binary.digest,
      binaryPath: resolvedBinary,
      codexHomePath,
      execution,
      gid: runAs.gid,
      homePath,
      model,
      promptDigest,
      promptPath: promptFile,
      uid: runAs.uid
    };
    const filename = `${execution.id}.request.json`;
    const file = path.join(outputDir, filename);
    const bytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
    await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
    records.push({
      executionId: execution.id,
      role: item.role,
      attempt: item.attempt,
      promptDigest: execution.promptDigest,
      prompt: promptFile,
      request: file,
      requestDigest: createHash("sha256").update(bytes).digest("hex")
    });
  }
  const manifest = {
    schemaVersion: 2,
    repo: resolvedRepo,
    runId,
    model,
    binaryPath: resolvedBinary,
    binaryApprovalDigest: runtime.codexBinary.registryDigest,
    binaryDigest: binary.digest,
    headRevision: sourceBinding.headRevision,
    sourceBindingDigest: sourceBinding.digest,
    runtimePath: runtime.path,
    runtimeDigest: runtime.digest,
    pluginBundleDigest: publishableBundleDigest,
    runAs,
    purpose,
    suitePath: frozen.relativePath,
    sourceSuiteDigest: frozen.sourceDigest,
    targetSuitePath: target?.relativePath ?? null,
    targetSuiteDigest: target?.sourceDigest ?? null,
    suiteDigest,
    baselineRevision: frozen.baselineRevision,
    candidateDigest: candidate.digest,
    candidateFiles: candidate.files,
    requests: records
  };
  const manifestPath = path.join(outputDir, "attestation-requests.json");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes, { mode: 0o600, flag: "wx" });
  return {
    ok: true,
    ...manifest,
    manifestPath,
    manifestDigest: createHash("sha256").update(manifestBytes).digest("hex"),
    executeCommand: [
      "sudo",
      "/bin/sh",
      "-c",
      HOST_ADMIN_SHELL,
      "better-workflows-admin",
      runtime.digest,
      manifestPath,
      createHash("sha256").update(manifestBytes).digest("hex")
    ]
  };
}
