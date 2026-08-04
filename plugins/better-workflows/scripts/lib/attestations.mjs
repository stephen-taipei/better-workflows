import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
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
import { binaryIdentity } from "./providers.mjs";

const HOST_TRUST_TOOL = "/private/var/db/better-workflows/bin/bw-host-trust.mjs";

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
  const resolvedBinary = binaryPath
    ? await realpath(binaryPath)
    : (await binaryIdentity("codex")).path;
  if (binaryPath && resolvedBinary !== binaryPath) {
    throw new Error("Codex binary argument must already be canonical");
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
      promptDigest: createHash("sha256")
        .update(promptByRoleAndSplit.get(`${item.role === "train-candidate" ? "candidate" : item.role}:${item.split}`))
        .digest("hex"),
      role: item.role,
      attempt: item.attempt
    };
    const prompt = promptByRoleAndSplit.get(`${item.role === "train-candidate" ? "candidate" : item.role}:${item.split}`);
    const promptBytes = Buffer.from(prompt);
    const promptFilename = `${execution.id}.prompt.txt`;
    const promptFile = path.join(outputDir, promptFilename);
    await writeFile(promptFile, promptBytes, { mode: 0o600, flag: "wx" });
    const promptDigest = createHash("sha256").update(promptBytes).digest("hex");
    const request = { model, binaryPath: resolvedBinary, execution, promptDigest, promptPath: promptFile };
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
      executionId: execution.id
    });
  }
  const manifest = {
    schemaVersion: 2,
    repo: resolvedRepo,
    runId,
    model,
    binaryPath: resolvedBinary,
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
      process.execPath,
      HOST_TRUST_TOOL,
      "execute-batch",
      "--manifest",
      manifestPath,
      "--confirm-digest",
      createHash("sha256").update(manifestBytes).digest("hex")
    ]
  };
}
