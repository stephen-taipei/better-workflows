import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadFrozenEvaluationSuite,
  snapshotCandidate,
  SELF_IMPROVE_CANONICAL_CORPUS
} from "./self-improve.mjs";
import { binaryIdentity } from "./providers.mjs";

const HOST_TRUST_TOOL = fileURLToPath(new URL("../host-trust.mjs", import.meta.url));

export async function generateAttestationRequests({
  repo,
  runId,
  baselineRevision,
  candidateRoot,
  model,
  outputDirectory,
  binaryPath = null
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
  const frozen = await loadFrozenEvaluationSuite({
    cwd: resolvedRepo,
    casesFile: path.join(resolvedRepo, SELF_IMPROVE_CANONICAL_CORPUS),
    baselineRevision,
    canonical: true
  });
  const candidate = await snapshotCandidate({
    cwd: resolvedRepo,
    baselineRevision: frozen.baselineRevision,
    candidateRoot
  });
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
      suiteDigest: frozen.sourceDigest,
      baselineRevision: frozen.baselineRevision,
      candidateDigest: candidate.digest,
      role: item.role,
      attempt: item.attempt
    };
    const request = { model, binaryPath: resolvedBinary, execution };
    const filename = `${execution.id}.request.json`;
    const file = path.join(outputDir, filename);
    const bytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
    await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
    records.push({
      executionId: execution.id,
      role: item.role,
      attempt: item.attempt,
      request: file,
      requestDigest: createHash("sha256").update(bytes).digest("hex"),
      attestationName: `${execution.id}.json`
    });
  }
  const manifest = {
    schemaVersion: 1,
    repo: resolvedRepo,
    runId,
    model,
    binaryPath: resolvedBinary,
    suiteDigest: frozen.sourceDigest,
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
    signCommand: [
      "sudo",
      process.execPath,
      HOST_TRUST_TOOL,
      "sign-batch",
      "--manifest",
      manifestPath,
      "--confirm-digest",
      createHash("sha256").update(manifestBytes).digest("hex")
    ]
  };
}
