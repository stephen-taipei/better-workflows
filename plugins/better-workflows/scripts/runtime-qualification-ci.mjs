#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// The producer runs the frozen commands itself; no environment PASS is accepted.
import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { digestObject, sha256 } from "./lib/core.mjs";
import { spawnCapture } from "./host-trust.mjs";
import { productReleaseScope } from "./lib/product-release-scope-v1.mjs";
import {
  RUNTIME_QUALIFICATION_LANES, RUNTIME_QUALIFICATION_REPOSITORY,
  RUNTIME_QUALIFICATION_REPOSITORY_ID, RUNTIME_QUALIFICATION_WORKFLOW,
  qualificationTapSummary, runtimeQualificationCommands, runtimeQualificationPolicy, runtimeTemporaryCleanupEligible
} from "./lib/runtime-qualification-v1.mjs";

const exec = promisify(execFile);
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(pluginRoot, "../..");
function required(name, pattern) {
  const value = process.env[name];
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) throw new Error(`Missing or invalid ${name}`);
  return value;
}
async function git(args) {
  return (await exec("/usr/bin/git", args, { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}

const laneId = required("SBW_RUNTIME_LANE", /^macos-node(?:22|24)$/);
const lane = RUNTIME_QUALIFICATION_LANES.find((entry) => entry.id === laneId);
const revision = required("GITHUB_SHA", /^[a-f0-9]{40}$/);
const repository = required("GITHUB_REPOSITORY");
const repositoryId = required("GITHUB_REPOSITORY_ID", /^[1-9][0-9]*$/);
const runId = required("GITHUB_RUN_ID", /^[1-9][0-9]*$/);
const runAttempt = required("GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/);
if (process.env.GITHUB_ACTIONS !== "true" || repository !== RUNTIME_QUALIFICATION_REPOSITORY || repositoryId !== RUNTIME_QUALIFICATION_REPOSITORY_ID ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_WORKFLOW_REF !== `${repository}/${RUNTIME_QUALIFICATION_WORKFLOW}@refs/heads/main` ||
    process.env.GITHUB_WORKFLOW_SHA !== revision || !["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME)) {
  throw new Error("Runtime qualification requires the exact main GitHub workflow and repository");
}
if (process.platform !== lane.platform || process.arch !== lane.arch || process.versions.node !== lane.nodeVersion ||
    process.env.RUNNER_OS !== "macOS" || process.env.RUNNER_ARCH !== "ARM64" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("Runtime qualification host or exact Node version drifted from policy");
}
if (await git(["rev-parse", "HEAD"]) !== revision || await git(["status", "--porcelain=v1", "--untracked-files=all"])) {
  throw new Error("Runtime qualification requires the exact clean candidate");
}
const { scope, scopeDigest } = await productReleaseScope();
if (!scope || !scope.runtimeLanes.some((entry) => entry.platform === lane.platform && entry.nodeMajor === Number(lane.nodeVersion.split(".")[0]))) {
  throw new Error("Runtime lane is outside the product release scope");
}
const { policy, policyDigest } = await runtimeQualificationPolicy();
const runnerTemp = await realpath(required("RUNNER_TEMP"));
if (runnerTemp === repositoryRoot || runnerTemp.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error("Runtime artifacts must be outside source");
const outputRoot = path.join(runnerTemp, `sbw-runtime-${laneId}-${runId}-${runAttempt}`);
await mkdir(outputRoot, { mode: 0o700 }); // Exclusive directory: never overwrite an earlier attempt.
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `directory=${outputRoot}\n`);
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
delete commandEnvironment.NODE_TEST_CONTEXT;
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
        abortSignal: controller.signal,
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
        try { record.tap = qualificationTapSummary(stdout.toString("utf8")); record.result = "PASS"; }
        catch (error) { failure = error.message; record.result = "FAIL"; }
      } else {
        failure ??= "Runtime command did not complete successfully with proven process cleanup";
        record.result = capture.code === null || !capture.groupTerminated ? "UNKNOWN" : "FAIL";
      }
    }
    commands.push(record);
    if (failure) break;
  }
  if (await git(["rev-parse", "HEAD"]) !== revision || await git(["status", "--porcelain=v1", "--untracked-files=all"]) ||
      (await runtimeQualificationPolicy()).policyDigest !== policyDigest || sha256(await readFile(nodePath)) !== nodeDigest) {
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
const payload = {
  schemaVersion: 1, kind: "RuntimeQualificationEnvelopeV1", sourceRevision: revision,
  productReleaseScopeDigest: scopeDigest, policyDigest, lane: { ...lane },
  host: { platform: process.platform, arch: process.arch, kernel: os.release(), osVersion: os.version(),
    runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null },
  runtime: { version: process.versions.node, executableSha256: nodeDigest },
  github: { repository, repositoryId, runId, runAttempt, workflowRef: process.env.GITHUB_WORKFLOW_REF,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA, sourceRef: "refs/heads/main", runnerEnvironment: "github-hosted" },
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
