import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  privateKeyFromRaw,
  spawnCapture,
  validateExecutionRequest
} from "../host-trust.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "host-trust.mjs"
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

test("host trust helper fixes authority paths and does not accept environment path overrides", async () => {
  const source = await readFile(SCRIPT, "utf8");
  assert.match(source, /"\/etc\/better-workflows\/codex-trust-root\.json"/);
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
  assert.match(source, /maxOutputBytes = MAX_OUTPUT_BYTES/);
  assert.match(source, /runReadinessProbe/);
  assert.match(source, /compileNativeArtifact/);
  assert.match(source, /NATIVE_COMPILER/);
  assert.match(source, /isMachO/);
  assert.match(source, /CODEX_ALLOWLIST/);
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
  assert.match(source, /requestDigests/);
  assert.doesNotMatch(source, /os\.tmpdir\(\)/);
  assert.doesNotMatch(source, /"TMPDIR"|"TEMP"|"TMP"|"HTTP_PROXY"|"HTTPS_PROXY"|"SSL_CERT_FILE"/);
  const launcher = await readFile(path.join(path.dirname(SCRIPT), "host-exec-launcher.c"), "utf8");
  assert.match(launcher, /setgroups\(0, NULL\)/);
  assert.match(launcher, /getpwuid/);
  assert.match(launcher, /getgroups\(0, NULL\)/);
  assert.match(launcher, /argc - 8/);
  assert.doesNotMatch(launcher, /argc == 10/);
  assert.match(launcher, /execve\(/);
  assert.match(launcher, /root-owned 0755/);
  const probe = await readFile(path.join(path.dirname(SCRIPT), "host-execution-probe.c"), "utf8");
  assert.match(probe, /getuid/);
  assert.match(probe, /getgroups/);
  assert.match(probe, /environment/);
  assert.match(probe, /argv0/);
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
    gid: process.getgid(),
    homePath: process.env.HOME,
    model: "gpt-5.6-sol",
    promptDigest: "a".repeat(64),
    promptPath: "/private/tmp/replay.prompt.txt",
    uid: process.getuid()
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
});
