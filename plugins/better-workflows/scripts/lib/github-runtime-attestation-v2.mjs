// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { mkdtemp, chmod, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./core.mjs";
import { inspectRuntimeQualificationTargetV2, assertInstalledRuntimeQualificationTargetV2, observeRootOwnedRuntimeFileV2, readBoundedRuntimeFileV2 } from "./runtime-qualification-v2.mjs";

const exec = promisify(execFile);
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]*$/;

async function githubCli(targetPolicy) {
  assertInstalledRuntimeQualificationTargetV2(targetPolicy);
  const executable = targetPolicy.githubCli.path;
  const observed = await observeRootOwnedRuntimeFileV2(executable, { maxBytes: 512 * 1024 * 1024, executable: true });
  if (observed.sha256 !== targetPolicy.githubCli.sha256) throw new Error("Runtime V2 GitHub CLI differs from the protected target policy");
  return { executable, ...observed };
}

function runtimeGithubEnvironmentV2() {
  const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" };
  // Preserve already authorized authentication through the child environment,
  // never process argv, logs, caller policy, or custom loader/trust-root inputs.
  for (const key of ["HOME", "GH_TOKEN", "GITHUB_TOKEN"]) if (typeof process.env[key] === "string") environment[key] = process.env[key];
  return environment;
}

async function executeRuntimeGithubV2(args, targetPolicy) {
  const cli = await githubCli(targetPolicy);
  const result = await exec(cli.executable, args, { cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: runtimeGithubEnvironmentV2(), encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const fresh = await githubCli(targetPolicy);
  if (fresh.sha256 !== cli.sha256 || JSON.stringify(fresh.identity) !== JSON.stringify(cli.identity)) throw new Error("Runtime V2 GitHub CLI changed during evidence verification");
  return result.stdout;
}

export async function runtimeGithubReadV2(args, { targetPolicy }) {
  // This transport has no provider write operation and never resolves PATH.
  assertInstalledRuntimeQualificationTargetV2(targetPolicy);
  if (!Array.isArray(args) || args.length !== 2) throw new Error("Runtime V2 GitHub GET arguments are invalid");
  const operation = args[0];
  const endpoint = args[1];
  if (operation !== "api" || typeof endpoint !== "string" || /[\r\n\0]/.test(endpoint)) throw new Error("Runtime V2 GitHub GET arguments are invalid");
  const repositoryEndpoint = `repos/${targetPolicy.repository.name}`;
  const suffix = endpoint.slice(repositoryEndpoint.length);
  const permittedEndpoint = endpoint === repositoryEndpoint || endpoint.startsWith(`${repositoryEndpoint}/`) &&
    (/^\/git\/ref\/heads\/main$/.test(suffix) || /^\/actions\/runs\/[1-9][0-9]*$/.test(suffix) ||
      /^\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*\/jobs\?per_page=100&page=(?:[1-9]|10)$/.test(suffix) ||
      /^\/actions\/runs\/[1-9][0-9]*\/artifacts\?per_page=100&page=(?:[1-9]|10)$/.test(suffix) ||
      /^\/git\/commits\/[a-f0-9]{40}$/.test(suffix) || /^\/git\/trees\/[a-f0-9]{40}\?recursive=1$/.test(suffix));
  if (!permittedEndpoint) throw new Error("Runtime V2 GitHub transport permits only bounded GET operations");
  return executeRuntimeGithubV2(["api", endpoint, "--method", "GET", "--hostname", "github.com", "--header", "X-GitHub-Api-Version: 2022-11-28"], targetPolicy);
}

// Structural inspection only. The authoritative wrapper below obtains this
// output directly from successful gh signature verification, never caller JSON.
// Certificate fields are flattened in sigstore-go v0.6.2 certificate.Summary:
// https://github.com/sigstore/sigstore-go/blob/v0.6.2/pkg/fulcio/certificate/summarize.go
// https://cli.github.com/manual/gh_attestation_verify
export function inspectRuntimeAttestationOutputV2(output, { artifactSha256, sourceRevision, runId, runAttempt, targetPolicy }) {
  inspectRuntimeQualificationTargetV2(targetPolicy);
  if (sourceRevision !== targetPolicy.sourceRevision || !SHA256.test(artifactSha256) || !SHA40.test(sourceRevision) || !ID.test(String(runId)) || !ID.test(String(runAttempt))) {
    throw new Error("Runtime attestation expected binding is invalid");
  }
  if (typeof output !== "string" || Buffer.byteLength(output) > 4 * 1024 * 1024) throw new Error("Runtime attestation output exceeds bounds");
  const entries = JSON.parse(output);
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 30) throw new Error("No bounded verified attestation array");
  const repoUrl = `https://github.com/${targetPolicy.repository.name}`;
  const workflowUri = `${repoUrl}/${targetPolicy.workflow.path}@refs/heads/main`;
  const invocationUri = `${repoUrl}/actions/runs/${runId}/attempts/${runAttempt}`;
  const match = entries.find((entry) => {
    const verified = entry?.verificationResult;
    const cert = verified?.signature?.certificate;
    const statement = verified?.statement;
    return cert?.issuer === "https://token.actions.githubusercontent.com" &&
      cert.subjectAlternativeName === workflowUri && cert.buildSignerURI === workflowUri &&
      cert.buildSignerDigest === sourceRevision && cert.sourceRepositoryURI === repoUrl &&
      cert.sourceRepositoryDigest === sourceRevision && cert.sourceRepositoryRef === "refs/heads/main" &&
      cert.sourceRepositoryIdentifier === targetPolicy.repository.id &&
      cert.runInvocationURI === invocationUri && cert.runnerEnvironment === "github-hosted" &&
      cert.buildTrigger === targetPolicy.workflow.event && cert.sourceRepositoryVisibilityAtSigning === "public" &&
      Array.isArray(verified.verifiedTimestamps) && verified.verifiedTimestamps.length > 0 &&
      statement?._type === "https://in-toto.io/Statement/v1" && statement.predicateType === "https://slsa.dev/provenance/v1" &&
      Array.isArray(statement.subject) && statement.subject.some((subject) => subject?.digest?.sha256 === artifactSha256);
  });
  if (!match) throw new Error("No attestation certificate binds the exact repository, workflow, source, run attempt, hosted runner, and artifact");
  return { matches: true, authority: "none", certificateBindingDigest: sha256(JSON.stringify(match.verificationResult.signature.certificate)) };
}

export async function verifyRuntimeAttestationV2(file, binding) {
  const { targetPolicy, sourceRevision, runId, runAttempt } = binding ?? {};
  assertInstalledRuntimeQualificationTargetV2(targetPolicy);
  if (typeof sourceRevision !== "string" || sourceRevision !== targetPolicy.sourceRevision ||
      typeof runId !== "string" || !ID.test(runId) || typeof runAttempt !== "string" || !ID.test(runAttempt)) throw new Error("Runtime V2 attestation binding is invalid");
  const before = await readBoundedRuntimeFileV2(file, 1024 * 1024);
  const artifactSha256 = sha256(before);
  const temporaryDirectory = await mkdtemp(path.join(await realpath(os.tmpdir()), "sbw-runtime-v2-verify-"));
  try {
    await chmod(temporaryDirectory, 0o700);
    const snapshotFile = path.join(temporaryDirectory, "qualification.json");
    await writeFile(snapshotFile, before, { mode: 0o400, flag: "wx" });
    // This private call builds every verification flag here. The exported GET
    // transport cannot accept caller-selected trust roots or verifier arguments.
    const output = await executeRuntimeGithubV2([
      "attestation", "verify", snapshotFile, "--repo", targetPolicy.repository.name,
      "--signer-workflow", `${targetPolicy.repository.name}/${targetPolicy.workflow.path}`,
      "--cert-identity", `https://github.com/${targetPolicy.repository.name}/${targetPolicy.workflow.path}@refs/heads/main`,
      "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
      "--predicate-type", "https://slsa.dev/provenance/v1", "--deny-self-hosted-runners", "--format", "json"
    ], targetPolicy);
    const projection = inspectRuntimeAttestationOutputV2(output, { targetPolicy, sourceRevision, runId, runAttempt, artifactSha256 });
    if (sha256(await readBoundedRuntimeFileV2(snapshotFile, 1024 * 1024)) !== artifactSha256 || sha256(await readBoundedRuntimeFileV2(file, 1024 * 1024)) !== artifactSha256) throw new Error("Runtime artifact changed during signature verification");
    return Object.freeze({ artifactSha256, attestation: "github-oidc-verified", releaseAuthority: "none", verificationDigest: sha256(output), certificateBindingDigest: projection.certificateBindingDigest });
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
}
