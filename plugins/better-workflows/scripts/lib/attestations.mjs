import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluationBindingDigest,
  loadFrozenEvaluationSuite,
  loadMigrationTargetSuite,
  loadPolicyBoundEvaluationPolicy,
  buildEvaluationPrompt,
  readSanitizedCandidateMaterial,
  readSanitizedBaselineMaterial,
  snapshotCandidate,
  snapshotBaselineForCandidate,
  selectEvaluatorMigrationCases,
  selectEvaluationCases,
  SELF_IMPROVE_CANONICAL_CORPUS,
  SELF_IMPROVE_MIGRATION_SOURCE_CORPUS,
  SELF_IMPROVE_V22_CORPUS,
  isPolicyBoundEvaluationPurpose,
  selectSafetyRemediationCases,
  selectQualityRemediationCases,
  ordinaryCorpusForBaseline
} from "./self-improve.mjs";
import { captureSourceBinding } from "./git.mjs";
import { bundleDigest } from "./publication.mjs";
import { binaryIdentity } from "./providers.mjs";
import { hostBundleFromStatus, hostBundleDigest } from "./host-bundle.mjs";
import {
  consentDigest,
  loadStandingConsentPolicy,
  matchStandingConsent,
  resolveStandingConsentAuthorization,
  STANDING_CONSENT_MANIFEST_SCHEMA_VERSION
} from "./standing-consent.mjs";

const HOST_TRUST_TOOL = "/private/var/db/better-workflows/bin/bw-host-trust.mjs";
const execFileAsync = promisify(execFile);
const HOST_RUNTIME_ROOT = "/private/var/db/better-workflows/bin";
const CODEX_TARGET_TRIPLE = process.platform === "darwin" && process.arch === "arm64"
  ? "aarch64-apple-darwin"
  : process.platform === "darwin" && process.arch === "x64"
    ? "x86_64-apple-darwin"
    : null;

async function verifyAdministratorRuntime(runtime) {
  if (!runtime || typeof runtime.path !== "string" || !path.isAbsolute(runtime.path) ||
      path.resolve(runtime.path) !== runtime.path || !/^[a-f0-9]{64}$/.test(runtime.digest ?? "")) {
    throw new Error("Administrator runtime binding is invalid");
  }
  const resolved = await realpath(runtime.path);
  if (resolved !== runtime.path) throw new Error("Administrator runtime path must already be canonical");
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== 0o755) {
    throw new Error("Administrator runtime must be a root-owned 0755 regular file");
  }
  const actualDigest = createHash("sha256").update(await readFile(resolved)).digest("hex");
  if (actualDigest !== runtime.digest) throw new Error("Administrator runtime digest mismatch");
}

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
  const signer = status?.signer;
  const hostBundle = hostBundleFromStatus(status);
  if (!status.ready || !runtime?.supported || typeof runtime.path !== "string" || !/^[a-f0-9]{64}$/.test(runtime.digest ?? "") ||
      !codexBinary?.supported || !/^[a-f0-9]{64}$/.test(codexBinary.registryDigest ?? "") || !Array.isArray(codexBinary.validEntries) ||
      runtime.path !== `${HOST_RUNTIME_ROOT}/bw-host-node.${runtime.digest}` ||
      !signer?.supported || signer.path !== HOST_TRUST_TOOL ||
      hostBundle.schemaVersion !== 1 || hostBundle.protocolVersion !== 1 ||
      hostBundle.bundleVersion !== signer.version || hostBundle.signerDigest !== signer.digest ||
      hostBundle.runtimeDigest !== runtime.digest) {
    throw new Error("Administrator host runtime or signed host bundle is not ready; run the separately governed host bootstrap or upgrade before generating replay requests");
  }
  return { path: runtime.path, digest: runtime.digest, codexBinary, hostBundle, standingConsent: status.standingConsent ?? null };
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function promptFileManifest(snapshot) {
  return (snapshot.files ?? []).map((file) => ({
    path: file.path,
    state: file.state,
    digest: file.digest,
    mode: file.mode ?? null,
    size: file.size ?? null
  }));
}

function materialBinding(snapshot, materials, policyDigest) {
  return {
    schemaVersion: 1,
    sanitizerPolicyDigest: policyDigest,
    snapshotDigest: snapshot.digest,
    files: promptFileManifest(snapshot),
    materialsDigest: consentDigest(materials)
  };
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

export function selectCodexBinaryPath(binaryPath, validEntries) {
  if (binaryPath) return binaryPath;
  if (!Array.isArray(validEntries) || validEntries.length !== 1) return null;
  const [entry] = validEntries;
  return entry && typeof entry.path === "string" && path.isAbsolute(entry.path)
    ? entry.path
    : null;
}

export function evaluationExecutionPlan(purpose) {
  return [
    { split: "train", role: "train-candidate", attempt: 1 },
    ...(purpose === "evaluator-migration"
      ? [{ split: "train", role: "train-baseline", attempt: 1 }]
      : []),
    { split: "holdout", role: "candidate", attempt: 1 },
    { split: "holdout", role: "candidate", attempt: 2 },
    { split: "holdout", role: "candidate", attempt: 3 },
    { split: "holdout", role: "baseline", attempt: 1 },
    { split: "holdout", role: "baseline", attempt: 2 },
    { split: "holdout", role: "baseline", attempt: 3 }
  ];
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
  const sourceBinding = await captureSourceBinding(resolvedRepo, { baseRevision: baselineRevision, requireClean: true });
  if (!sourceBinding?.headRevision || !sourceBinding.digest) {
    throw new Error("Attestation requests require an exact Git source binding");
  }
  const publishableBundleDigest = await bundleDigest(path.join(resolvedRepo, "plugins", "better-workflows"));
  const standingPolicy = await loadStandingConsentPolicy(resolvedRepo);
  const runtime = await installedRuntime();
  await verifyAdministratorRuntime(runtime);
  const selectedBinaryPath = selectCodexBinaryPath(binaryPath, runtime.codexBinary.validEntries);
  const binary = await codexExecutableIdentity(selectedBinaryPath);
  const resolvedBinary = binary.path;
  if (selectedBinaryPath && resolvedBinary !== selectedBinaryPath) {
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
  const policyBound = isPolicyBoundEvaluationPurpose(purpose);
  const policy = policyBound ? await loadPolicyBoundEvaluationPolicy({ cwd: resolvedRepo, purpose }) : null;
  const defaultCasesFile = purpose === "evaluator-migration"
    ? SELF_IMPROVE_MIGRATION_SOURCE_CORPUS
    : policyBound
      ? SELF_IMPROVE_V22_CORPUS
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
  if (policy && frozen.sourceDigest !== policy.sourceSuiteDigest) {
    throw new Error(`${purpose} source suite digest is not the policy-bound immutable corpus`);
  }
  const target = purpose === "evaluator-migration"
    ? await loadMigrationTargetSuite({
      cwd: resolvedRepo,
      casesFile: path.resolve(resolvedRepo, nextCasesFile ?? SELF_IMPROVE_CANONICAL_CORPUS)
    })
    : null;
  const suiteDigest = evaluationBindingDigest({
    purpose,
    sourceSuiteDigest: frozen.sourceDigest,
    targetSuiteDigest: target?.sourceDigest,
    policyDigest: policy?.digest
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
  const executions = evaluationExecutionPlan(purpose);
  const standingMatch = matchStandingConsent({
    hostStatus: { standingConsent: runtime.standingConsent },
    policy: standingPolicy,
    repo: resolvedRepo,
    model,
    purpose,
    runAs,
    requestCount: executions.length
  });
  const authorization = resolveStandingConsentAuthorization(
    { standingConsent: runtime.standingConsent },
    standingMatch
  );
  if (authorization && (
    !isWithin(authorization.requestRoot, outputDir) ||
    path.dirname(outputDir) !== authorization.requestRoot ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(path.basename(outputDir))
  )) {
    throw new Error(`Standing evaluator consent requires --output to be one safe direct child of ${authorization.requestRoot}`);
  }
  for (const split of ["train", "holdout"]) {
    const cases = purpose === "safety-remediation-v1"
      ? selectSafetyRemediationCases({ suite: frozen.suite, snapshot: candidate, split, policy })
      : purpose === "quality-remediation-v1"
        ? selectQualityRemediationCases({ suite: frozen.suite, snapshot: candidate, split, policy })
        : purpose === "evaluator-migration"
          ? selectEvaluatorMigrationCases({ suite: target.suite, split })
          : selectEvaluationCases({ suite: frozen.suite, snapshot: candidate, split });
    promptByRoleAndSplit.set(`candidate:${split}`, buildEvaluationPrompt({
      suite: { ...(purpose === "evaluator-migration" ? target.suite : frozen.suite), cases },
      candidate,
      materials: candidateMaterial
    }));
    promptByRoleAndSplit.set(`baseline:${split}`, buildEvaluationPrompt({
      suite: { ...(purpose === "evaluator-migration" ? target.suite : frozen.suite), cases },
      candidate: baseline,
      materials: baselineMaterial
    }));
  }
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  const records = [];
  for (const item of executions) {
    const promptRole = item.role.endsWith("baseline") ? "baseline" : "candidate";
    const execution = {
      id: `${runId}-${item.split}-${item.role}-${item.attempt}`,
      runId,
      suiteDigest,
      baselineRevision: frozen.baselineRevision,
      candidateDigest: candidate.digest,
      headRevision: sourceBinding.headRevision,
      promptDigest: createHash("sha256")
        .update(promptByRoleAndSplit.get(`${promptRole}:${item.split}`))
        .digest("hex"),
      role: item.role,
      sourceBindingDigest: sourceBinding.digest,
      attempt: item.attempt,
      ...(authorization ? { authorization } : {}),
      ...(policyBound ? { purpose, policyDigest: policy.digest } : {})
    };
    const prompt = promptByRoleAndSplit.get(`${promptRole}:${item.split}`);
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
      pluginBundleDigest: publishableBundleDigest,
      promptDigest,
      promptPath: promptFile,
      uid: runAs.uid,
      ...(authorization
        ? {
          authorization,
          materialBinding: materialBinding(
            promptRole === "baseline" ? baseline : candidate,
            promptRole === "baseline" ? baselineMaterial : candidateMaterial,
            standingPolicy.digest
          )
        }
        : {})
    };
    if (policyBound) {
      request.purpose = purpose;
      request.policyDigest = policy.digest;
    }
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
      requestDigest: createHash("sha256").update(bytes).digest("hex"),
      ...(authorization ? { authorizationDigest: consentDigest(authorization) } : {})
    });
  }
  const manifest = {
    schemaVersion: authorization ? STANDING_CONSENT_MANIFEST_SCHEMA_VERSION : policyBound ? 3 : 2,
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
    hostBundle: runtime.hostBundle,
    hostBundleDigest: hostBundleDigest(runtime.hostBundle),
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
    requests: records,
    ...(authorization
      ? {
        authorization,
        candidateRoot: candidate.candidateRoot,
        baselineSnapshotDigest: baseline.digest,
        standingConsentPolicyPath: standingPolicy.relativePath,
        standingConsentPolicyDigest: standingPolicy.digest
      }
      : {}),
    ...(policyBound
      ? {
        policyPath: policy.path,
        policyId: policy.policyId,
        policyVersion: policy.version,
        policyDigest: policy.digest
      }
      : {})
  };
  const manifestPath = path.join(outputDir, "attestation-requests.json");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes, { mode: 0o600, flag: "wx" });
  return {
    ok: true,
    ...manifest,
    manifestPath,
    manifestDigest: createHash("sha256").update(manifestBytes).digest("hex"),
    standingConsent: standingMatch,
    executeCommand: [
      "/usr/bin/sudo",
      ...(authorization ? ["-n"] : []),
      runtime.path,
      HOST_TRUST_TOOL,
      authorization ? "execute-consented-batch" : "execute-batch",
      "--manifest",
      manifestPath,
      "--confirm-digest",
      createHash("sha256").update(manifestBytes).digest("hex")
    ]
  };
}
