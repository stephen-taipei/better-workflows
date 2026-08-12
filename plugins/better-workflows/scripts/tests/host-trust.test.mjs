import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  EVALUATION_SCHEMA,
  privateKeyFromRaw,
  standingConsentSudoers,
  standingConsentSudoersEvidence,
  validateStandingConsentPolicy,
  validateSigningKeyPair,
  spawnCapture,
  validateExecutionRequest,
  validateProtectedDirectoryChain,
  validateProtectedParentChain
} from "../host-trust.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "host-trust.mjs"
);
const STANDING_CONSENT_POLICY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../config/self-improve-standing-consent-v1.json"
);

test("host signer reconstructs Ed25519 keys and signs canonical verifier payloads", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const reconstructed = privateKeyFromRaw(seed);
  const payload = {
    execution: { role: "candidate", attempt: 1 },
    provider: "codex",
    schemaVersion: 1
  };
  const bytes = Buffer.from(canonicalJson(payload), "utf8");
  const signature = sign(null, bytes, reconstructed);
  assert.equal(verify(null, bytes, publicKey, signature), true);
});

test("host execution response schema defines array items for Codex structured output", () => {
  const results = EVALUATION_SCHEMA.properties.results;
  assert.equal(results.type, "array");
  assert.equal(results.items.type, "object");
  assert.deepEqual(results.items.required, ["id", "disposition", "passedAssertions"]);
  assert.equal(results.items.properties.passedAssertions.type, "array");
  assert.equal(results.items.properties.passedAssertions.items.type, "string");
});

test("root signer validates the repository standing-consent policy without sanitizer drift", async () => {
  const policy = JSON.parse(await readFile(STANDING_CONSENT_POLICY, "utf8"));
  assert.deepEqual(validateStandingConsentPolicy(policy), policy);
  assert.throws(
    () => validateStandingConsentPolicy({
      ...policy,
      sanitization: { ...policy.sanitization, secretPattern: "a^" }
    }),
    /sanitization policy is invalid/
  );
  assert.throws(
    () => validateStandingConsentPolicy({
      ...policy,
      sanitization: { ...policy.sanitization, allowedPathPatterns: ["^.*$"] }
    }),
    /sanitization policy is invalid/
  );
});

test("host readiness proves the installed private key matches the trust-root public key", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const trust = {
    value: {
      issuer: "better-workflows-local-host",
      publicKeys: [{
        keyId: "codex-ed25519-test",
        algorithm: "ed25519",
        publicKey: publicKeyDer.toString("base64")
      }]
    },
    digest: createHash("sha256").update("trust-root").digest("hex")
  };
  const proof = await validateSigningKeyPair(trust, seed);
  assert.equal(proof.verified, true);
  assert.equal(proof.proof.keyId, "codex-ed25519-test");
  await assert.rejects(
    () => validateSigningKeyPair(trust, Buffer.alloc(32, 7)),
    /does not match the trust root public key/
  );
});

test("host trust helper fixes authority paths and does not accept environment path overrides", async () => {
  const source = await readFile(SCRIPT, "utf8");
  assert.match(source, /const HOST_ETC = process\.platform === "darwin" \? "\/private\/etc" : "\/etc"/);
  assert.match(source, /`\$\{HOST_ETC\}\/better-workflows\/codex-trust-root\.json`/);
  assert.match(source, /"\/private\/var\/db\/better-workflows\/codex-attestation-ed25519\.raw"/);
  assert.match(source, /Refusing implicit rotation or overwrite/);
  assert.match(source, /execute-result/);
  assert.match(source, /execute-batch/);
  assert.match(source, /execution-ledger/);
  assert.match(source, /requireInstalledCapability/);
  assert.match(source, /spawnCapture/);
  assert.doesNotMatch(source, /function signResultRequest/);
  assert.match(source, /HOST_SIGNER_VERSION/);
  assert.match(source, /signer-upgrade/);
  assert.match(source, /responseDigest/);
  assert.match(source, /trustRootDigest/);
  assert.doesNotMatch(source, /BW_(?:TRUST|PRIVATE|ATTESTATION)/);
  assert.match(source, /command === "capabilities"/);
  assert.match(source, /uid: request\.uid/);
  assert.match(source, /binaryDigest/);
  assert.match(source, /outputExceeded/);
  assert.match(source, /\/private\/var\/db\/better-workflows\/execution-bundles/);
  assert.match(source, /validateRootOwnedDirectory/);
  assert.match(source, /EXECUTION_LAUNCHER/);
  assert.match(source, /requireTrustedRuntime/);
  assert.match(source, /requestDigest/);
  assert.match(source, /runAs/);
  assert.match(source, /SAFETY_REMEDIATION_POLICY_PATH/);
  assert.match(source, /self-improve-safety-remediation-v1\.json/);
  assert.match(source, /SAFETY_REMEDIATION_POLICY_VERSION/);
  assert.match(source, /QUALITY_REMEDIATION_POLICY_PATH/);
  assert.match(source, /self-improve-quality-remediation-v1\.json/);
  assert.match(source, /QUALITY_REMEDIATION_POLICY_VERSION/);
  assert.match(source, /HOST_SIGNER_VERSION = "2\.4\.0"/);
  assert.match(source, /standing-consent-admin/);
  assert.match(source, /standing-consent-execution/);
  assert.match(source, /STANDING_CONSENT_AUTHORITY_STATEMENT_DIGEST/);
  assert.match(source, /Standing-consent embedded policy source is not canonical or digest-bound/);
  assert.doesNotMatch(source, /readSourceFile\(request\.policyPath/);
  assert.match(source, /execute-consented-batch/);
  assert.match(source, /schemaVersion 4 standing authorization requires execute-consented-batch/);
  assert.match(source, /Standing-authorized execution requests require execute-consented-batch/);
  assert.match(source, /validateConsentedPrompt/);
  assert.match(source, /NOPASSWD:NOSETENV: sha256:/);
  assert.match(source, /maxOutputBytes = MAX_OUTPUT_BYTES/);
  assert.match(source, /runReadinessProbe/);
  assert.match(source, /chmod\(bundle, 0o755\)/);
  assert.match(source, /validateRootOwnedDirectory\(bundle, "Host execution bundle", 0o755\)/);
  assert.match(source, /compileNativeArtifact/);
  assert.match(source, /NATIVE_COMPILER/);
  assert.match(source, /isMachO/);
  assert.match(source, /CODEX_ALLOWLIST/);
  assert.match(source, /READINESS_RECEIPT/);
  assert.match(source, /HOST_BUNDLE_MANIFEST/);
  assert.match(source, /createHostBundleManifest/);
  assert.match(source, /ignoreHostBundle/);
  assert.match(source, /better-workflows-host-bundle/);
  assert.match(source, /supportedConsentSchemas/);
  assert.match(source, /host-readiness-receipt/);
  assert.match(source, /requireReadinessReceipt = true/);
  assert.match(source, /allowUnprovenReadiness/);
  assert.match(source, /requireApprovedCodexBinary/);
  assert.match(source, /approvedCodexAllowlistSource/);
  assert.match(source, /binaryApprovalDigest/);
  assert.match(source, /native Mach-O executable/);
  assert.match(source, /stale backup/);
  assert.match(source, /discardRollbackBackup/);
  assert.match(source, /fixed host runtime root/);
  assert.match(source, /--codex-binary/);
  assert.match(source, /currentRuntime\(manifest\.runtimePath\)/);
  assert.match(source, /validateManifestRunAs/);
  assert.match(source, /validateProtectedDirectoryChain/);
  assert.match(source, /validateProtectedParentChain/);
  assert.match(source, /secureDirectory\(ATTESTATIONS, 0o755\)/);
  assert.match(source, /secureDirectory\(EXECUTIONS, 0o755\)/);
  assert.match(source, /secureDirectory\(EXECUTION_BUNDLES, 0o755\)/);
  assert.match(source, /requestDigests/);
  assert.doesNotMatch(source, /os\.tmpdir\(\)/);
  assert.doesNotMatch(source, /"TMPDIR"|"TEMP"|"TMP"|"HTTP_PROXY"|"HTTPS_PROXY"|"SSL_CERT_FILE"/);
  const launcher = await readFile(path.join(path.dirname(SCRIPT), "host-exec-launcher.c"), "utf8");
  assert.match(launcher, /setgroups\(0, NULL\)/);
  assert.ok(launcher.indexOf("setgid(gid)") < launcher.indexOf("setgroups(0, NULL)"));
  assert.ok(launcher.indexOf("setgroups(0, NULL)") < launcher.indexOf("setuid(uid)"));
  assert.match(launcher, /defined\(__APPLE__\)/);
  assert.match(launcher, /getpwuid/);
  assert.match(launcher, /getgroups\(0, NULL\)/);
  assert.match(launcher, /argc - 8/);
  assert.doesNotMatch(launcher, /argc == 10/);
  assert.match(launcher, /execve\(/);
  assert.match(launcher, /root-owned 0755/);
  const probe = await readFile(path.join(path.dirname(SCRIPT), "host-execution-probe.c"), "utf8");
  assert.match(probe, /getuid/);
  assert.match(probe, /getgroups/);
  assert.match(probe, /defined\(__APPLE__\)/);
  assert.match(probe, /environment/);
  assert.match(probe, /argv0/);
});

test("host parent-chain validation rejects a user-owned parent around a regular leaf", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "better-workflows-parent-chain."));
  const leaf = path.join(root, "root-owned-shaped-leaf");
  try {
    await writeFile(leaf, "leaf");
    await assert.rejects(
      () => validateProtectedParentChain(leaf, "adversarial host artifact"),
      /unsafe parent directory|must already be canonical/
    );
    await assert.rejects(
      () => validateProtectedDirectoryChain(root, "adversarial host root"),
      /unsafe parent directory|must already be canonical/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host capture waits for SIGKILL escalation after output overflow", async () => {
  const result = await spawnCapture(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(3 * 1024 * 1024)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
  ], { timeoutMs: 10_000 });
  assert.equal(result.outputExceeded, true);
  assert.equal(result.signal, "SIGKILL");
});

test("host capture honors a caller-specific output limit before SIGKILL escalation", async () => {
  const result = await spawnCapture(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(64 * 1024)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
  ], { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 });
  assert.equal(result.outputExceeded, true);
  assert.ok(["SIGTERM", "SIGKILL"].includes(result.signal));
});

test("host execution request is a pre-execution contract and cannot carry caller result facts", () => {
  const request = {
    binaryApprovalDigest: "c".repeat(64),
    binaryDigest: "b".repeat(64),
    binaryPath: "/usr/bin/codex",
    codexHomePath: null,
    execution: {
      id: "run-holdout-candidate-1",
      runId: "run-12345678",
      suiteDigest: "suite-12345678",
      baselineRevision: "abcdef1234567890abcdef1234567890abcdef12",
      candidateDigest: "candidate-12345678",
      headRevision: "d".repeat(40),
      promptDigest: "a".repeat(64),
      role: "candidate",
      sourceBindingDigest: "e".repeat(64),
      attempt: 1
    },
    gid: 1000,
    homePath: "/home/test-user",
    model: "gpt-5.6-sol",
    pluginBundleDigest: "f".repeat(64),
    promptDigest: "a".repeat(64),
    promptPath: "/private/tmp/replay.prompt.txt",
    uid: 1000
  };
  assert.deepEqual(validateExecutionRequest(request), request);
  assert.throws(
    () => validateExecutionRequest({ ...request, responseDigest: "b".repeat(64) }),
    /execution request fields/
  );
  assert.throws(
    () => validateExecutionRequest({ ...request, binaryDigest: "not-a-digest" }),
    /binary digest is invalid/
  );
  assert.throws(
    () => validateExecutionRequest({ ...request, finishedAt: new Date().toISOString() }),
    /execution request fields/
  );
  const safetyExecution = {
    ...request.execution,
    purpose: "safety-remediation-v1",
    policyDigest: "1".repeat(64)
  };
  const safetyRequest = {
    ...request,
    execution: safetyExecution,
    purpose: "safety-remediation-v1",
    policyDigest: "1".repeat(64)
  };
  assert.deepEqual(validateExecutionRequest(safetyRequest), safetyRequest);
  assert.throws(
    () => validateExecutionRequest({ ...safetyRequest, policyDigest: "2".repeat(64) }),
    /bindings do not match/
  );
  const qualityRequest = {
    ...request,
    execution: {
      ...request.execution,
      purpose: "quality-remediation-v1",
      policyDigest: "3".repeat(64)
    },
    purpose: "quality-remediation-v1",
    policyDigest: "3".repeat(64)
  };
  assert.deepEqual(validateExecutionRequest(qualityRequest), qualityRequest);
});

test("host validates standing evaluator authorization without broadening the execution contract", () => {
  const authorization = {
    mode: "standing-user-consent",
    grantId: "bw-standing-1000-v1",
    grantDigest: "1".repeat(64),
    policyId: "self-improve-standing-evaluator-consent",
    policyVersion: "v1",
    policyDigest: "2".repeat(64),
    repo: "/private/tmp/better-workflows-repository",
    provider: "codex",
    model: "gpt-5.6-terra",
    purpose: "ordinary",
    requestCount: 7,
    requestRoot: "/private/tmp/better-workflows-standing-consent-1000",
    subject: {
      uid: 1000,
      gid: 1000,
      username: "maintainer",
      homePath: "/home/maintainer",
      codexHomePath: "/home/maintainer/.codex"
    },
    readOnly: true,
    ephemeral: true,
    sanitized: true
  };
  const execution = {
    id: "run-holdout-candidate-1",
    runId: "run-12345678",
    suiteDigest: "suite-12345678",
    baselineRevision: "abcdef1234567890abcdef1234567890abcdef12",
    candidateDigest: "candidate-12345678",
    headRevision: "d".repeat(40),
    promptDigest: "a".repeat(64),
    role: "candidate",
    sourceBindingDigest: "e".repeat(64),
    attempt: 1,
    authorization
  };
  const request = {
    binaryApprovalDigest: "c".repeat(64),
    binaryDigest: "b".repeat(64),
    binaryPath: "/usr/bin/codex",
    codexHomePath: authorization.subject.codexHomePath,
    execution,
    gid: authorization.subject.gid,
    homePath: authorization.subject.homePath,
    model: authorization.model,
    pluginBundleDigest: "f".repeat(64),
    promptDigest: execution.promptDigest,
    promptPath: "/private/tmp/replay.prompt.txt",
    uid: authorization.subject.uid,
    authorization,
    materialBinding: {
      schemaVersion: 1,
      sanitizerPolicyDigest: authorization.policyDigest,
      snapshotDigest: "3".repeat(64),
      files: [{ path: "README.md", state: "missing", digest: null, mode: null, size: null }],
      materialsDigest: "4".repeat(64)
    }
  };
  assert.deepEqual(validateExecutionRequest(request), request);
  assert.throws(
    () => validateExecutionRequest({ ...request, model: "gpt-5.6-sol" }),
    /does not match its execution, model, purpose, or run-as identity/
  );
  assert.throws(
    () => validateExecutionRequest({ ...request, materialBinding: { ...request.materialBinding, sanitizerPolicyDigest: "5".repeat(64) } }),
    /Material binding is invalid/
  );
});

test("macOS visudo accepts the digest-bound standing-consent command regex", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "better-workflows-sudoers."));
  const target = path.join(root, "standing-consent");
  try {
    const rule = standingConsentSudoers({
      grant: {
        subject: { username: os.userInfo().username },
        requestRoot: "/private/tmp/better-workflows-standing-consent-501"
      },
      runtime: {
        path: `/private/var/db/better-workflows/bin/bw-host-node.${"a".repeat(64)}`,
        digest: "a".repeat(64)
      }
    });
    await writeFile(target, rule, { mode: 0o440 });
    const result = await spawnCapture("/usr/sbin/visudo", ["-cf", target], {
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-root consent status can derive sudoers evidence while root rejects content drift", async () => {
  const grant = {
    subject: { username: "maintainer" },
    requestRoot: "/private/tmp/better-workflows-standing-consent-501"
  };
  const runtime = {
    path: `/private/var/db/better-workflows/bin/bw-host-node.${"a".repeat(64)}`,
    digest: "a".repeat(64)
  };
  const expectedBytes = Buffer.from(standingConsentSudoers({ grant, runtime }), "utf8");
  const deferred = await standingConsentSudoersEvidence({ grant, runtime });
  const verified = await standingConsentSudoersEvidence({ grant, runtime, actualBytes: expectedBytes });
  assert.equal(deferred.digest, verified.digest);
  assert.equal(deferred.verification, "deferred-to-root-execution");
  assert.equal(verified.verification, "content-verified");
  await assert.rejects(
    () => standingConsentSudoersEvidence({ grant, runtime, actualBytes: Buffer.from("tampered\n") }),
    /does not match the signed grant/
  );
});
