#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// The producer runs the frozen commands itself; no environment PASS is accepted.
import { appendFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestObject, sha256 } from "./lib/core.mjs";
import { spawnCapture } from "./host-trust.mjs";
import { productReleaseScope } from "./lib/product-release-scope-v1.mjs";
import {
  RUNTIME_QUALIFICATION_LANES, loadRuntimeQualificationProducerTargetV2,
  runtimeQualificationTapSummaryV2, runtimeQualificationCommands, runtimeQualificationPolicyV2, runtimeTemporaryCleanupEligible, readRuntimeProducerTreeV2, observeRuntimeSourceTreeV2
} from "./lib/runtime-qualification-v2.mjs";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(pluginRoot, "../..");
function required(name, pattern) {
  const value = process.env[name];
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) throw new Error(`Missing or invalid ${name}`);
  return value;
}

let allocatedOutputRoot = null;
async function main() {
  const laneId = required("SBW_RUNTIME_LANE", /^macos-node(?:22|24)$/);
  const lane = RUNTIME_QUALIFICATION_LANES.find((entry) => entry.id === laneId);
  const revision = required("GITHUB_SHA", /^[a-f0-9]{40}$/);
  const repository = required("GITHUB_REPOSITORY");
  const repositoryId = required("GITHUB_REPOSITORY_ID", /^[1-9][0-9]*$/);
  const runId = required("GITHUB_RUN_ID", /^[1-9][0-9]*$/);
  const runAttempt = required("GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/);
  const runnerTemp = await realpath(required("RUNNER_TEMP"));
  if (runnerTemp === repositoryRoot || runnerTemp.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error("Runtime artifacts must be outside source");
  const outputRoot = path.join(runnerTemp, `sbw-runtime-v2-${laneId}-${revision}-${runId}-${runAttempt}`);
  await mkdir(outputRoot, { mode: 0o700 });
  allocatedOutputRoot = outputRoot; // Exclusive directory: never overwrite an earlier attempt.
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `directory=${outputRoot}\n`);
  const targetSnapshot = loadRuntimeQualificationProducerTargetV2();
  const { targetPolicy, targetPolicySha256 } = targetSnapshot;
  if (process.env.GITHUB_ACTIONS !== "true" || repository !== targetPolicy.repository.name || repositoryId !== targetPolicy.repository.id || revision !== targetPolicy.sourceRevision ||
      process.env.GITHUB_REF !== "refs/heads/main" ||
      process.env.GITHUB_WORKFLOW_REF !== `${repository}/${targetPolicy.workflow.path}@refs/heads/main` ||
      process.env.GITHUB_WORKFLOW_SHA !== revision || process.env.GITHUB_EVENT_NAME !== targetPolicy.workflow.event) {
    throw new Error("Runtime qualification requires the exact main GitHub workflow and repository");
  }
  if (process.platform !== lane.platform || process.arch !== lane.arch || process.versions.node !== lane.nodeVersion ||
      process.env.RUNNER_OS !== "macOS" || process.env.RUNNER_ARCH !== "ARM64" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("Runtime qualification host or exact Node version drifted from policy");
  }
  const sourceBefore = await observeRuntimeSourceTreeV2({ sourceRoot: repositoryRoot,
    treeRecords: await readRuntimeProducerTreeV2({ sourceRoot: repositoryRoot, sourceRevision: revision }) });
  const { scope, scopeDigest } = await productReleaseScope();
  if (!scope || !scope.runtimeLanes.some((entry) => entry.platform === lane.platform && entry.nodeMajor === Number(lane.nodeVersion.split(".")[0]))) {
    throw new Error("Runtime lane is outside the product release scope");
  }
  const { policy, policyDigest } = await runtimeQualificationPolicyV2({ sourceRoot: repositoryRoot, targetPolicy });
  const tempRoot = path.join(outputRoot, "tmp");
  await mkdir(tempRoot, { mode: 0o700 });
  const nodePath = await realpath(process.execPath);
  const nodeInfo = await lstat(nodePath);
  if (!nodeInfo.isFile()) throw new Error("Runtime executable must be a regular file");
  const nodeDigest = sha256(await readFile(nodePath));
  const controller = new AbortController();
  const commandEnvironment = { ...process.env, TMPDIR: tempRoot,
    SBW_STATE_ROOT: path.join(tempRoot, "state"), SBW_HOST_ID: "codex", NO_COLOR: "1" };
  delete commandEnvironment.NODE_OPTIONS;
  delete commandEnvironment.NODE_PATH;
  delete commandEnvironment.NODE_TEST_CONTEXT;
  for (const key of Object.keys(commandEnvironment)) if (/^(?:DYLD_|LD_)/.test(key) || /^(?:GH_TOKEN|GITHUB_TOKEN|ACTIONS_ID_TOKEN_REQUEST_|ACTIONS_RUNTIME_TOKEN)/.test(key) || key.startsWith("SBW_RUNTIME_QUALIFICATION_TARGET_POLICY_")) delete commandEnvironment[key];
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const commands = [];
  const expectedCommands = runtimeQualificationCommands(laneId);
  const startedAt = new Date().toISOString();
  let failure = null;
  let tempRemoved = false;
  try {
    for (const command of expectedCommands) {
      if (controller.signal.aborted) throw new Error("Runtime qualification cancelled before command start");
      const start = new Date().toISOString();
      const begin = performance.now();
      let capture;
      try {
        capture = await spawnCapture(nodePath, command.args, {
          cwd: pluginRoot,
          env: commandEnvironment,
          timeoutMs: 40 * 60_000, maxOutputBytes: 16 * 1024 * 1024, cleanupGraceMs: 5000,
          abortSignal: controller.signal, encoding: null,
          onSpawn: async (child) => appendFile(path.join(outputRoot, "resources.jsonl"), `${JSON.stringify({
            owner: laneId, startedAt: start,
            supervisor: { pid: child.pid, ppid: process.pid, command: child.spawnfile,
              argv: child.spawnargs, cwd: "/", detached: true },
            target: { command: nodePath, args: command.args, cwd: pluginRoot, pid: null },
            ports: [], sockets: []
          })}\n`, { mode: 0o600 })
        });
      } catch (error) {
        capture = error.execution;
        failure = error.message;
      }
      const record = { id: command.id, args: command.args, startedAt: start, finishedAt: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - begin), result: "UNKNOWN", tap: null };
      if (capture) {
        const stdout = Buffer.from(capture.stdout ?? "");
        const stderr = Buffer.from(capture.stderr ?? "");
        await writeFile(path.join(outputRoot, `${command.id}.stdout.tap`), stdout, { mode: 0o600, flag: "wx" });
        await writeFile(path.join(outputRoot, `${command.id}.stderr.log`), stderr, { mode: 0o600, flag: "wx" });
        Object.assign(record, { exitCode: capture.code, signal: capture.signal, timedOut: capture.timedOut,
          outputExceeded: capture.outputExceeded, processGroupTerminated: capture.groupTerminated,
          stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr) });
        if (!failure && !controller.signal.aborted && capture.code === 0 && capture.signal === null &&
            capture.timedOut === false && capture.outputExceeded === false && capture.groupTerminated === true) {
          try { record.tap = runtimeQualificationTapSummaryV2(stdout); record.result = "PASS"; }
          catch (error) { failure = error.message; record.result = "FAIL"; }
        } else {
          failure ??= "Runtime command did not complete successfully with proven process cleanup";
          record.result = capture.code === null || !capture.groupTerminated ? "UNKNOWN" : "FAIL";
        }
      }
      commands.push(record);
      if (failure) break;
    }
    const sourceAfter = await observeRuntimeSourceTreeV2({ sourceRoot: repositoryRoot,
      treeRecords: await readRuntimeProducerTreeV2({ sourceRoot: repositoryRoot, sourceRevision: revision }) });
    if (sourceAfter.expectedFilesDigest !== sourceBefore.expectedFilesDigest || sourceAfter.sourceInventoryDigest !== sourceBefore.sourceInventoryDigest ||
        sourceAfter.sourceSnapshotDigest !== sourceBefore.sourceSnapshotDigest ||
        (await runtimeQualificationPolicyV2({ sourceRoot: repositoryRoot, targetPolicy })).policyDigest !== policyDigest ||
        loadRuntimeQualificationProducerTargetV2().targetPolicySha256 !== targetPolicySha256 || sha256(await readFile(nodePath)) !== nodeDigest) {
      throw new Error("Runtime source, command coverage, or executable drifted during execution");
    }
  } catch (error) {
    failure ??= error.message;
  } finally {
    // Suites may allocate their own detached groups. A terminated capture group
    // alone is insufficient after a failure: retain their state for reconciliation.
    // Success also requires the suites' own cleanup assertions to have passed.
    if (runtimeTemporaryCleanupEligible(laneId, commands, { failure, aborted: controller.signal.aborted })) {
      try { await rm(tempRoot, { recursive: true }); tempRemoved = true; }
      catch (error) { failure ??= `Runtime temp cleanup failed: ${error.message}`; }
    }
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
  }
  if (controller.signal.aborted) failure ??= "Runtime qualification was cancelled";
  const resourcesPath = path.join(outputRoot, "resources.jsonl");
  let resourcesBytes = Buffer.alloc(0);
  try {
    const info = await lstat(resourcesPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error("Runtime resource log is not a bounded physical file");
    resourcesBytes = await readFile(resourcesPath);
  } catch (error) { failure ??= `Runtime resource log unavailable: ${error.message}`; }
  const payload = {
    schemaVersion: 2, kind: "RuntimeQualificationEnvelopeV2", sourceRevision: revision, targetPolicySha256,
    productReleaseScopeDigest: scopeDigest, policyDigest, sourceInventoryDigest: sourceBefore.sourceInventoryDigest, resourcesSha256: sha256(resourcesBytes), lane: { ...lane },
    host: { platform: process.platform, arch: process.arch, kernel: os.release(), osVersion: os.version(),
      runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null },
    runtime: { version: process.versions.node, executableSha256: nodeDigest },
    github: { repository, repositoryId, runId, runAttempt, workflowRef: process.env.GITHUB_WORKFLOW_REF,
      workflowSha: process.env.GITHUB_WORKFLOW_SHA, workflowFileSha256: targetPolicy.workflow.sha256,
      event: targetPolicy.workflow.event, environment: targetPolicy.workflow.environment, sourceRef: "refs/heads/main", runnerEnvironment: "github-hosted" },
    coverage: policy.coverage, fullEvaluatorIncluded: false, files: policy.files,
    startedAt, finishedAt: new Date().toISOString(), commands,
    cleanup: { tempRemoved, status: tempRemoved ? "VERIFIED_WITHIN_SUITE_SCOPE" : "UNCONFIRMED",
      evidence: ["capture-process-group", "successful-suite-cleanup-assertions"] },
    result: !failure && tempRemoved && commands.length === expectedCommands.length && commands.every((entry) => entry.result === "PASS") ? "PASS" : "HOLD",
    failure,
    authentication: { status: "awaiting-github-oidc-attestation", releaseEligible: false }
  };
  const envelope = { ...payload, envelopeDigest: digestObject(payload) };
  const file = path.join(outputRoot, "qualification.json");
  await writeFile(file, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `receipt=${file}\n`);
  process.stdout.write(`${JSON.stringify({ result: payload.result, file, laneId, failure })}\n`);
  if (payload.result !== "PASS") process.exitCode = 1;

}
try { await main(); }
catch (error) {
  const reason = String(error.message).slice(0, 1024);
  if (allocatedOutputRoot) {
    const payload = { schemaVersion: 2, kind: "RuntimeQualificationEnvelopeV2", result: "HOLD", failure: reason,
      fullEvaluatorIncluded: false, authentication: { status: "unavailable", releaseEligible: false } };
    const file = path.join(allocatedOutputRoot, "qualification.json");
    try {
      await writeFile(file, `${JSON.stringify({ ...payload, envelopeDigest: digestObject(payload) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `receipt=${file}\n`);
    } catch (writeError) { if (writeError.code !== "EEXIST") process.stderr.write("Runtime V2 failure receipt could not be retained\n"); }
  }
  process.stdout.write(`${JSON.stringify({ result: "HOLD", reason, releaseAuthority: "none" })}\n`);
  process.exitCode = 1;
}
