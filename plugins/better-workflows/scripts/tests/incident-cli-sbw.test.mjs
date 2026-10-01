import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";
import readline from "node:readline/promises";

import { INCIDENT_LIMITS } from "../lib/incident-v1.mjs";
import { digestObject, atomicWriteJson, sha256, BOUND_CREDENTIAL_WORKSPACE_ROOT } from "../lib/core.mjs";
import { captureSourceBinding } from "../lib/git.mjs";
import { autoPolicyDefinition } from "../lib/auto-policy-v1.mjs";
import {
  createTaskContractV3,
  buildWorkflowPlanV1,
  persistWorkflowPlanV1
} from "../lib/workflow-plan-v1.mjs";
import {
  bindNativeCommandToApprovalEnvelope,
  createNativeCommandBinding
} from "../lib/native-command-binding-v1.mjs";
import {
  createNativeV3TrustPolicyReader,
  readInstalledNativeV3TrustPolicy
} from "../lib/native-v3-trust-policy.mjs";
import {
  collectCooperativeNativeV3OwnerDecision,
  createCooperativeNativeV3RecoveryController,
  prepareCooperativeNativeV3Approval
} from "../lib/native-v3-cooperative-controller.mjs";
import {
  createNativeV3CommandRunner,
  NATIVE_V3_COMMAND_RUNNER_TRUST_MODE
} from "../lib/native-v3-command-runner.mjs";
import {
  createIncidentFirstReportPermissionV1,
  createIncidentFirstReportV1
} from "../lib/incident-v1.mjs";
import { incidentRecoveryEffectBindingDigestV1 } from "../lib/incident-recovery-v1.mjs";
import { runIncidentCli } from "../lib/incident-cli-v1.mjs";
import {
  __testWriteWorkflowResumeArtifact,
  createSbwIncidentRecoveryContext
} from "../sbw.mjs";

const execFile = promisify(execFileCallback);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const CLI_PATH = path.resolve(TEST_DIR, "../sbw.mjs");
const PRIVATE_SENTINEL = "PRIVATE_SENTINEL";
const POSIX = process.platform === "darwin" || process.platform === "linux";

function digestText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceFixture(variant = "base") {
  const revision = `fixture-${variant}`;
  return {
    revision,
    digest: digestText(`source:${revision}`),
    scope: "fixture/incidents"
  };
}

function contentFixture(variant = "base", { sensitive = false } = {}) {
  const content = {
    title: `Bounded incident ${variant}`,
    summary: `A model-free local report for ${variant}.`,
    facts: [`Observed fact for ${variant}.`, "No provider outcome is asserted."],
    impact: "Advisory impact is pending independent review."
  };
  if (sensitive) {
    content.privateNote = `${PRIVATE_SENTINEL} must not be persisted`;
    content.token = PRIVATE_SENTINEL;
  }
  return content;
}

function targetFixture(variant = "base") {
  return {
    kind: "wiki",
    id: `incident-${variant}`,
    revision: `target-${variant}-1`,
    digest: digestText(`target:${variant}`)
  };
}

async function tempFixture(t, prefix = "bw-incident-cli-v1-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = path.join(directory, "state");
  await writeFile(path.join(directory, "input.json"), "{}", "utf8");
  return {
    directory,
    stateRoot,
    inputFile: path.join(directory, "input.json"),
    targetFile: path.join(directory, "target.json"),
    preparationFile: path.join(directory, "preparation.json")
  };
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

async function runSbw(fixture, args) {
  try {
    const result = await execFile(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SBW_STATE_ROOT: fixture.stateRoot,
        HOME: path.join(fixture.directory, "home"),
        XDG_STATE_HOME: path.join(fixture.directory, "xdg"),
        NO_COLOR: "1",
        NODE_NO_WARNINGS: "1"
      },
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024
    });
    return {
      exitCode: 0,
      value: JSON.parse(result.stdout.trim()),
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    const stdout = error.stdout ?? "";
    let value;
    try {
      value = JSON.parse(stdout.trim());
    } catch {
      value = null;
    }
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      value,
      stdout,
      stderr: error.stderr ?? ""
    };
  }
}

async function runCli(fixture, args) {
  return runSbw(fixture, ["incident", ...args]);
}

async function markerValue(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function cliArgs(command, fixture, options = []) {
  return [command, ...options, "--state-root", fixture.stateRoot, "--json"];
}

function assertSuccess(result) {
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.value?.ok, true, result.stdout);
  return result.value;
}

function assertFailure(result, code, exitCode = 2) {
  assert.equal(result.exitCode, exitCode, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.value?.ok, false, result.stdout);
  assert.equal(result.value?.error?.code, code, result.stdout);
  return result.value;
}

async function assertNoSentinelOnDisk(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  await visit(root);
  for (const file of files) {
    assert.equal((await readFile(file, "utf8")).includes(PRIVATE_SENTINEL), false, file);
  }
}

async function runFixtureGit(cwd, args, environment = {}) {
  return execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: path.join(cwd, ".home"),
      ...environment
    },
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024
  });
}

async function removeFixtureRoot(root) {
  let allocationNames = [];
  try {
    allocationNames = (await readdir(path.join(root, "posix-owned-process-v1", "allocations")))
      .filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name));
  } catch (error) {
    if (error?.code === "ENOENT") allocationNames = [];
    else throw error;
  }
  for (const name of allocationNames) {
    let record;
    try {
      record = JSON.parse(await readFile(path.join(root, "posix-owned-process-v1", "allocations", name), "utf8"));
    } catch {
      throw new Error("incident recovery fixture cleanup evidence is unavailable");
    }
    if (record.groupTerminated !== true || record.phase !== "terminal") {
      throw new Error("incident recovery fixture cleanup is UNKNOWN; preserving the fixture");
    }
  }
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      lastError = null;
    } catch (error) {
      lastError = error;
      if (!["EAGAIN", "EBUSY", "ENOTEMPTY"].includes(error?.code)) throw error;
    }
    try {
      await readdir(root);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError ?? new Error("incident recovery fixture root remained after bounded cleanup");
}

async function collectRecoveryTTYOwnerDecision({
  stateRoot,
  runId,
  taskId,
  attemptId,
  allocationKey,
  requestDigest
}) {
  const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const createInterfaceMock = mock.method(readline, "createInterface", () => ({
    question: async (prompt, options) => {
      assert.match(prompt, /Plan:|Task:|Source revision:|Scope:/);
      assert.ok(options?.signal, "recovery owner interaction must be abortable");
      return "approve";
    },
    close() {}
  }));
  try {
    return await collectCooperativeNativeV3OwnerDecision({
      stateRoot,
      runId,
      taskId,
      attemptId,
      allocationKey,
      requestDigest
    });
  } finally {
    createInterfaceMock.mock.restore();
    if (inputDescriptor) Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
    else delete process.stdin.isTTY;
    if (outputDescriptor) Object.defineProperty(process.stdout, "isTTY", outputDescriptor);
    else delete process.stdout.isTTY;
  }
}

async function withRecoveryTTY(callback, { approvalDelayMs = 0, beforeApprove = undefined } = {}) {
  const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const createInterfaceMock = mock.method(readline, "createInterface", () => ({
    question: async (prompt, options) => {
      assert.match(prompt, /Plan:|Task:|Source revision:|Scope:/);
      assert.ok(options?.signal, "recovery owner interaction must be abortable");
      if (approvalDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, approvalDelayMs));
      if (beforeApprove) await beforeApprove();
      return "approve";
    },
    close() {}
  }));
  try {
    return await callback();
  } finally {
    createInterfaceMock.mock.restore();
    if (inputDescriptor) Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
    else delete process.stdin.isTTY;
    if (outputDescriptor) Object.defineProperty(process.stdout, "isTTY", outputDescriptor);
    else delete process.stdout.isTTY;
  }
}

test("sbw exposes incident routing while preserving existing CLI routes", async (t) => {
  const fixture = await tempFixture(t, "bw-incident-cli-sbw-routing-");
  const help = await runSbw(fixture, ["help", "--json"]);
  assert.equal(help.exitCode, 0, `${help.stderr}\n${help.stdout}`);
  assert.ok(help.value.usage.some((line) => line.includes("sbw incident help|create|report")));
  assert.ok(help.value.usage.some((line) => line.includes("sbw knowledge help|validate|save")));
  assert.ok(help.value.usage.some((line) => line.includes("sbw workflow resume")));

  const knowledgeHelp = await runSbw(fixture, ["knowledge", "help", "--json"]);
  assert.equal(knowledgeHelp.exitCode, 0, `${knowledgeHelp.stderr}\n${knowledgeHelp.stdout}`);
  assert.equal(knowledgeHelp.value.kind, "KnowledgeCliV1");
});

test("sbw incident routing runs a real advisory lifecycle across processes", async (t) => {
  const fixture = await tempFixture(t);
  await writeJson(fixture.inputFile, {
    content: contentFixture("base", { sensitive: true }),
    source: sourceFixture(),
    capturedAt: "2026-09-16T00:00:00.000Z"
  });
  await writeJson(fixture.targetFile, targetFixture());

  const help = assertSuccess(await runCli(fixture, ["help", "--json"]));
  assert.equal(help.kind, "IncidentCliV1");
  assert.ok(help.usage.some((line) => line.includes("incident-cli-v1.mjs list")));
  assert.ok(help.usage.some((line) => line.includes("incident-cli-v1.mjs report")));
  assert.ok(help.usage.some((line) => line.includes("recovery prepare|verify|resume")));

  const first = assertSuccess(await runCli(fixture, cliArgs("create", fixture, [
    "--incident-id", "incident-one", "--file", fixture.inputFile
  ])));
  assert.equal(first.operation, "incident.report");
  assert.equal(first.revision, 1);
  assert.equal(first.status, "ADVISORY");
  assert.equal(first.publication, "not-published");
  assert.equal(first.authority, "local-advisory-only");
  assert.deepEqual(first.localPermission, {
    permissionScope: "local-operation-only",
    ownerActionAuthority: false,
    providerAuthority: false,
    publicationAuthority: false,
    evidenceTruth: false
  });

  const show = assertSuccess(await runCli(fixture, cliArgs("show", fixture, ["--incident-id", "incident-one"])));
  assert.equal(show.incident.revision, 1);
  assert.equal(show.latestRevision, 1);
  assert.equal(show.incident.provenance.method, "model-free");
  assert.equal(JSON.stringify(show).includes(PRIVATE_SENTINEL), false);

  const historical = assertSuccess(await runCli(fixture, cliArgs("read", fixture, [
    "--incident-id", "incident-one", "--revision", "1"
  ])));
  assert.equal(historical.incident.revision, 1);

  const reportAlias = assertSuccess(await runCli(fixture, cliArgs("report", fixture, [
    "--incident-id", "incident-report-alias", "--file", fixture.inputFile
  ])));
  assert.equal(reportAlias.operation, "incident.report");
  const listed = assertSuccess(await runCli(fixture, cliArgs("list", fixture)));
  assert.deepEqual(listed.incidents.map(({ incidentId }) => incidentId), ["incident-one", "incident-report-alias"]);

  const reviewRequired = await runCli(fixture, cliArgs("prepare-publication", fixture, [
    "--incident-id", "incident-one", "--revision", "1", "--target-file", fixture.targetFile
  ]));
  assertFailure(reviewRequired, "EINCIDENT_REVIEW_REQUIRED");

  await writeJson(fixture.inputFile, {
    content: contentFixture("changed"),
    source: sourceFixture("changed")
  });
  const revised = assertSuccess(await runCli(fixture, cliArgs("revise", fixture, [
    "--incident-id", "incident-one", "--file", fixture.inputFile, "--expected-revision", "1"
  ])));
  assert.equal(revised.revision, 2);

  const staleRevision = await runCli(fixture, cliArgs("revise", fixture, [
    "--incident-id", "incident-one", "--file", fixture.inputFile, "--expected-revision", "1"
  ]));
  assertFailure(staleRevision, "EINCIDENT_STALE");

  let reviewedRevision = 2;
  for (const role of ["privacy", "security", "facts"]) {
    const review = assertSuccess(await runCli(fixture, cliArgs("review", fixture, [
      "--incident-id", "incident-one",
      "--expected-revision", String(reviewedRevision),
      "--role", role,
      "--disposition", "approved",
      "--reason", `${role} review is bounded and local.`
    ])));
    reviewedRevision = review.revision;
  }
  assert.equal(reviewedRevision, 5);

  const prepared = assertSuccess(await runCli(fixture, cliArgs("prepare-publication", fixture, [
    "--incident-id", "incident-one", "--revision", String(reviewedRevision), "--target-file", fixture.targetFile
  ])));
  assert.equal(prepared.published, false);
  assert.equal(prepared.authority, "local-advisory-only");
  assert.equal(prepared.preparationKind, "IncidentPublicationPreparationV1");
  await writeJson(fixture.preparationFile, prepared.preparation);

  const verified = assertSuccess(await runCli(fixture, cliArgs("verify-preparation", fixture, [
    "--file", fixture.preparationFile,
    "--target-file", fixture.targetFile,
    "--preparation-path", prepared.path
  ])));
  assert.equal(verified.valid, true);
  assert.equal(verified.published, false);
  assert.equal(verified.authority, "local-advisory-only");

  const unsafePreparationPath = await runCli(fixture, cliArgs("verify-preparation", fixture, [
    "--file", fixture.preparationFile,
    "--target-file", fixture.targetFile,
    "--preparation-path", "../outside.json"
  ]));
  assertFailure(unsafePreparationPath, "EINCIDENT_CLI_USAGE", 1);

  const driftedTarget = { ...targetFixture(), revision: "target-base-2" };
  await writeJson(fixture.targetFile, driftedTarget);
  const targetDrift = await runCli(fixture, cliArgs("verify-preparation", fixture, [
    "--file", fixture.preparationFile, "--target-file", fixture.targetFile
  ]));
  assertFailure(targetDrift, "EINCIDENT_STALE");
  await writeJson(fixture.targetFile, targetFixture());

  const revoked = assertSuccess(await runCli(fixture, cliArgs("revoke", fixture, [
    "--incident-id", "incident-one", "--expected-revision", String(reviewedRevision), "--reason", "owner requested local advisory revocation"
  ])));
  assert.equal(revoked.status, "REVOKED");
  assert.equal(revoked.authority, "local-advisory-only");

  const revokedShow = await runCli(fixture, cliArgs("show", fixture, ["--incident-id", "incident-one"]));
  assertFailure(revokedShow, "EINCIDENT_REVOKED");
  const revokedVerify = await runCli(fixture, cliArgs("verify-preparation", fixture, [
    "--file", fixture.preparationFile, "--target-file", fixture.targetFile
  ]));
  assertFailure(revokedVerify, "EINCIDENT_REVOKED");

  const recreateRevoked = await runCli(fixture, cliArgs("create", fixture, [
    "--incident-id", "incident-one", "--file", fixture.inputFile
  ]));
  assertFailure(recreateRevoked, "EINCIDENT_REVOKED");

  const remaining = assertSuccess(await runCli(fixture, cliArgs("list", fixture)));
  assert.deepEqual(remaining.incidents.map(({ incidentId }) => incidentId), ["incident-report-alias"]);
  const deleted = assertSuccess(await runCli(fixture, cliArgs("delete", fixture, [
    "--incident-id", "incident-report-alias", "--expected-revision", "1", "--reason", "remove local test record"
  ])));
  assert.equal(deleted.status, "REVOKED");
  const empty = assertSuccess(await runCli(fixture, cliArgs("list", fixture)));
  assert.deepEqual(empty.incidents, []);
  await assertNoSentinelOnDisk(fixture.stateRoot);
});

test("sbw incident routing keeps unsafe inputs and unsupported recovery fail-closed", async (t) => {
  const fixture = await tempFixture(t);
  const validInput = {
    content: contentFixture("negative"),
    source: sourceFixture("negative")
  };
  await writeJson(fixture.inputFile, validInput);

  const unknownArg = await runCli(fixture, cliArgs("create", fixture, ["--unknown", "value"]));
  assertFailure(unknownArg, "EINCIDENT_CLI_USAGE", 1);

  const traversal = await runCli(fixture, cliArgs("create", fixture, [
    "--incident-id", "incident-traversal", "--file", "../outside.json"
  ]));
  assertFailure(traversal, "EINCIDENT_CLI_USAGE", 1);

  const symlinkFile = path.join(fixture.directory, "input-link.json");
  await symlink(fixture.inputFile, symlinkFile);
  const symlinkResult = await runCli(fixture, cliArgs("create", fixture, [
    "--incident-id", "incident-symlink", "--file", symlinkFile
  ]));
  assertFailure(symlinkResult, "EINCIDENT_FS");
  assert.equal((await lstat(symlinkFile)).isSymbolicLink(), true);

  const malformedFile = path.join(fixture.directory, "malformed.json");
  await writeFile(malformedFile, "{not-json\n", "utf8");
  const malformed = await runCli(fixture, cliArgs("create", fixture, [
    "--incident-id", "incident-malformed", "--file", malformedFile
  ]));
  assertFailure(malformed, "EINCIDENT_INVALID");

  const oversizedFile = path.join(fixture.directory, "oversized.json");
  await writeFile(oversizedFile, "x".repeat(INCIDENT_LIMITS.maxRecordBytes + 1), "utf8");
  const oversized = await runCli(fixture, cliArgs("create", fixture, [
    "--incident-id", "incident-oversized", "--file", oversizedFile
  ]));
  assertFailure(oversized, "EINCIDENT_LIMIT");

  const sensitiveReviewInput = assertSuccess(await runCli(fixture, cliArgs("create", fixture, [
    "--incident-id", "incident-sensitive", "--file", fixture.inputFile
  ])));
  assert.equal(sensitiveReviewInput.revision, 1);
  const sensitiveReview = await runCli(fixture, cliArgs("review", fixture, [
    "--incident-id", "incident-sensitive",
    "--expected-revision", "1",
    "--role", "privacy",
    "--disposition", "approved",
    "--reason", `token=${PRIVATE_SENTINEL}`
  ]));
  assertFailure(sensitiveReview, "EINCIDENT_SENSITIVE");
  assert.equal(sensitiveReview.stdout.includes(PRIVATE_SENTINEL), false);
  assert.equal(sensitiveReview.stderr.includes(PRIVATE_SENTINEL), false);

  const unsafeTargetFile = path.join(fixture.directory, "unsafe-target.json");
  await writeJson(unsafeTargetFile, { ...targetFixture("unsafe"), id: "../outside" });
  const unsafeTarget = await runCli(fixture, cliArgs("prepare-publication", fixture, [
    "--incident-id", "incident-sensitive", "--revision", "1", "--target-file", unsafeTargetFile
  ]));
  assertFailure(unsafeTarget, "EINCIDENT_INVALID");

  for (const subcommand of ["prepare", "verify", "resume"]) {
    const recovery = await runCli(fixture, cliArgs("recovery", fixture, [subcommand]));
    assertFailure(recovery, "EINCIDENT_RECOVERY_CONTEXT_UNAVAILABLE");
    assert.match(recovery.value.error.message, /trusted execution context/);
  }

  const symlinkRoot = path.join(fixture.directory, "state-link");
  await symlink(fixture.stateRoot, symlinkRoot);
  const unsafeRoot = await runCli({ ...fixture, stateRoot: symlinkRoot }, [
    "list", "--state-root", symlinkRoot, "--json"
  ]);
  assertFailure(unsafeRoot, "EINCIDENT_FS");
  await assertNoSentinelOnDisk(fixture.stateRoot);
});

test("sbw incident routing revision CAS permits one concurrent writer and rejects stale retry", async (t) => {
  const fixture = await tempFixture(t);
  const firstInput = path.join(fixture.directory, "first.json");
  const secondInput = path.join(fixture.directory, "second.json");
  const thirdInput = path.join(fixture.directory, "third.json");
  await writeJson(firstInput, { content: contentFixture("cas-first"), source: sourceFixture("cas-first") });
  await writeJson(secondInput, { content: contentFixture("cas-second"), source: sourceFixture("cas-second") });
  await writeJson(thirdInput, { content: contentFixture("cas-third"), source: sourceFixture("cas-third") });
  const first = assertSuccess(await runCli(fixture, cliArgs("create", fixture, [
    "--incident-id", "incident-cas", "--file", firstInput
  ])));
  assert.equal(first.revision, 1);

  const [left, right] = await Promise.all([
    runCli(fixture, cliArgs("revise", fixture, [
      "--incident-id", "incident-cas", "--file", secondInput, "--expected-revision", "1"
    ])),
    runCli(fixture, cliArgs("revise", fixture, [
      "--incident-id", "incident-cas", "--file", thirdInput, "--expected-revision", "1"
    ]))
  ]);
  const successes = [left, right].filter((result) => result.exitCode === 0);
  const failures = [left, right].filter((result) => result.exitCode !== 0);
  assert.equal(successes.length, 1, JSON.stringify([left, right]));
  assert.equal(failures.length, 1, JSON.stringify([left, right]));
  assert.equal(failures[0].value?.ok, false);
  assert.ok(["EINCIDENT_LOCKED", "EINCIDENT_STALE"].includes(failures[0].value?.error?.code), JSON.stringify(failures[0]));

  const final = assertSuccess(await runCli(fixture, cliArgs("show", fixture, ["--incident-id", "incident-cas"])));
  assert.equal(final.latestRevision, 2);
  assert.equal(final.incident.revision, 2);

  const stale = await runCli(fixture, cliArgs("revise", fixture, [
    "--incident-id", "incident-cas", "--file", thirdInput, "--expected-revision", "1"
  ]));
  assertFailure(stale, "EINCIDENT_STALE");
  const stillFinal = assertSuccess(await runCli(fixture, cliArgs("show", fixture, ["--incident-id", "incident-cas"])));
  assert.equal(stillFinal.latestRevision, 2);
});

async function exerciseIncidentRecovery(t, { approvalDelayMs = 0, driftDuringApproval = false, privateTemplate = false } = {}) {
  // Use the runtime's physical POSIX temp root: /private/tmp on macOS,
  // /tmp on Linux. Do not create a macOS-only directory on the CI host.
  const directory = await mkdtemp(path.join(BOUND_CREDENTIAL_WORKSPACE_ROOT, "bw-v5-incident-cli-bridge-"));
  let marker = null;
  t.after(async () => {
    if (marker !== null) await rm(marker, { force: true });
    await removeFixtureRoot(directory);
  });
  const repositoryRoot = path.join(directory, "source");
  const stateRoot = path.join(directory, "state");
  const home = path.join(directory, "home");
  await mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await mkdir(home, { recursive: true, mode: 0o700 });
  await runFixtureGit(repositoryRoot, ["init", "-q", "-b", "main"]);
  await runFixtureGit(repositoryRoot, ["config", "user.email", "fixture@example.invalid"]);
  await runFixtureGit(repositoryRoot, ["config", "user.name", "V5 fixture"]);
  await writeFile(path.join(repositoryRoot, "README.md"), "clean source fixture\n", { mode: 0o600 });
  await runFixtureGit(repositoryRoot, ["add", "README.md"]);
  await runFixtureGit(repositoryRoot, ["commit", "-qm", "fixture source"]);

  const sourceCapture = await captureSourceBinding(repositoryRoot, { requireClean: true });
  const sourceBinding = {
    revision: sourceCapture.headRevision,
    digest: sourceCapture.digest
  };
  const trustPolicy = await readInstalledNativeV3TrustPolicy();
  const policyDigest = trustPolicy.policyDigest;
  const runId = "sbw-20350101T000000Z-0123456789ab";
  const planId = "incident-cli-bridge-plan";
  const taskId = "incident-cli-bridge-task";
  const unitId = "incident-cli-bridge-unit";
  const incidentId = "incident-cli-bridge";
  const model = "gpt-5.6-luna";
  const templateDigest = privateTemplate
    ? digestObject({ schemaVersion: 1, kind: "IncidentCliBridgeTemplateV1" })
    : digestObject(autoPolicyDefinition("code-change-v1"));
  const routeDigest = digestObject({ schemaVersion: 1, kind: "IncidentCliBridgeRouteV1" });
  const taskBudget = { attempts: 1, seconds: 20, tokens: 100 };
  const taskContract = createTaskContractV3({
    contractId: "incident-cli-bridge-contract",
    goal: "Prove one bounded incident recovery launch through the executable CLI route",
    scope: { include: ["."], exclude: [] },
    bindings: {
      source: sourceBinding,
      policy: { digest: policyDigest },
      template: { id: privateTemplate ? "incident-cli-bridge-template" : "auto", digest: templateDigest },
      route: { receiptId: null, digest: routeDigest }
    },
    roles: [{ id: "root", required: true }],
    modelPolicy: {
      inherit: false,
      allow: [model],
      deny: [],
      requested: model,
      reported: null,
      attested: null
    },
    budget: taskBudget,
    acceptance: [{
      id: "command-complete",
      description: "The recovered command completes and its effect is durably recorded.",
      requiredEvidence: [],
      critical: true
    }],
    graph: {
      tasks: [{
        id: taskId,
        goal: "Execute the one approved local recovery command",
        dependencies: [],
        role: "root",
        writeOwner: { role: "root", paths: [".git"] },
        budget: taskBudget,
        acceptanceIds: ["command-complete"]
      }]
    }
  });
  const workflowPlan = buildWorkflowPlanV1({ taskContract, planId });
  await persistWorkflowPlanV1({ root: stateRoot, plan: workflowPlan });

  // Keep the effect inside the task's declared .git write ownership. Pass a
  // short relative argument so the binding does not mistake it for a secret.
  marker = path.join(repositoryRoot, ".git", `bwrec-${randomBytes(6).toString("hex")}`);
  const executable = path.join(directory, "owned-command.sh");
  const executableBytes = "#!/bin/sh\nset -eu\nprintf '%s' launched >> \"$1\"\n";
  await writeFile(executable, executableBytes, { mode: 0o700 });
  await chmod(executable, 0o700);
  const bindingPath = path.join(stateRoot, "native-v3-cli", "runs", runId, "binding.json");
  const approvalPath = path.join(stateRoot, "native-v3-cli", "runs", runId, "approval.json");
  const initialAttemptId = `${taskId}.attempt.1`;
  const initialExecutionId = "incident-cli-bridge-execution-1";
  let failInitialBeforeLaunch = true;
  const readFreshSourceBinding = async ({ runId: requestedRunId, planId: requestedPlanId }) => {
    assert.equal(requestedRunId, runId);
    assert.equal(requestedPlanId, planId);
    const captured = await captureSourceBinding(repositoryRoot, { requireClean: true });
    if (failInitialBeforeLaunch) {
      const registryPath = path.join(stateRoot, "execution-runtime-v1", "runs", runId, "registry.json");
      try {
        const state = JSON.parse(await readFile(registryPath, "utf8"));
        if (Object.values(state.intents ?? {}).some((intent) => intent.status === "dispatching")) {
          failInitialBeforeLaunch = false;
          const error = new Error("fixture forces a durable not-sent predecessor before the first target launch");
          error.code = "ENATIVE_COMMAND_BINDING_FS";
          error.status = "HOLD";
          throw error;
        }
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENATIVE_COMMAND_BINDING_FS") throw error;
        if (error?.code === "ENATIVE_COMMAND_BINDING_FS") throw error;
      }
    }
    return { revision: captured.headRevision, digest: captured.digest };
  };
  const readTrustPolicy = async ({ runId: requestedRunId, planId: requestedPlanId, policyDigest: expectedDigest, requestedTrustMode }) => {
    assert.equal(requestedRunId, runId);
    assert.equal(requestedPlanId, planId);
    assert.equal(expectedDigest, policyDigest);
    assert.equal(requestedTrustMode, "cooperative-user-mode");
    return { policyDigest, requiredTrustMode: "cooperative-user-mode" };
  };
  const commandBinding = createNativeCommandBinding({
    schemaVersion: 1,
    kind: "NativeCommandBindingV1",
    planDigest: workflowPlan.planDigest,
    contractDigest: workflowPlan.contractDigest,
    taskId,
    unitId,
    sourceBindingDigest: sourceBinding.digest,
    policyDigest,
    revision: sourceBinding.revision,
    scope: { include: ["."], exclude: [] },
    recipient: "incident-recovery-local-command",
    executable,
    executableDigest: sha256(executableBytes),
    args: [path.relative(repositoryRoot, marker)],
    cwd: repositoryRoot,
    env: { PATH: "/usr/bin:/bin" },
    maxOutputBytes: 1024
  }, { workspaceRoot: repositoryRoot });
  const initialPrepared = await prepareCooperativeNativeV3Approval({
    stateRoot,
    planId,
    runId,
    taskId,
    unitId,
    executionId: initialExecutionId,
    attemptId: initialAttemptId,
    recipient: commandBinding.recipient,
    action: commandBinding.action,
    requestedModel: model,
    sourceBinding,
    policyDigest,
    effectBindingDigest: commandBinding.commandDigest,
    trustMode: "cooperative-user-mode",
    sourceCwd: repositoryRoot,
    readFreshSourceBinding,
    readTrustPolicy,
    expiresAt: "2099-01-01T00:00:00.000Z",
    freshResolverTimeoutMs: 4_000
  });
  const initialBinding = bindNativeCommandToApprovalEnvelope(commandBinding, initialPrepared.approvalEnvelope, {
    workspaceRoot: repositoryRoot
  });
  await atomicWriteJson(stateRoot, bindingPath, initialBinding);
  await atomicWriteJson(stateRoot, approvalPath, initialPrepared.approvalEnvelope);
  const initialOwnerDecision = await collectRecoveryTTYOwnerDecision({
    stateRoot,
    runId,
    taskId,
    attemptId: initialAttemptId,
    requestDigest: initialPrepared.ownerApprovalRequest.requestDigest
  });
  const initialRunner = await createNativeV3CommandRunner({
    stateRoot,
    root: stateRoot,
    workspaceRoot: repositoryRoot,
    planId,
    runId,
    taskId,
    unitId,
    executionId: initialExecutionId,
    attemptId: initialAttemptId,
    bindingPath: path.relative(stateRoot, bindingPath),
    expectedCommandDigest: initialBinding.commandDigest,
    approvalEnvelope: initialPrepared.approvalEnvelope,
    effectBindingDigest: commandBinding.commandDigest,
    ownerDecision: initialOwnerDecision,
    sourceBinding,
    policyDigest,
    readFreshSourceBinding,
    readTrustPolicy,
    sourceCwd: repositoryRoot,
    trustMode: "cooperative-user-mode",
    requestedModel: model,
    freshResolverTimeoutMs: 4_000
  });
  await assert.rejects(initialRunner.execute(), (error) => error?.code === "EFFECT_NOT_SENT");
  const initialStatus = await initialRunner.status();
  assert.equal(initialStatus.intent.status, "not-sent");
  assert.equal(await markerValue(marker), null);

  await createIncidentFirstReportV1({
    stateRoot,
    incidentId,
    content: {
      title: "Native recovery fixture",
      summary: "A not-sent native command requires a fresh owner decision.",
      facts: ["The first launch was blocked before an owned process started."],
      impact: "A bounded local recovery is required."
    },
    source: { ...sourceBinding, scope: "fixture/incidents" },
    capturedAt: "2099-01-01T00:00:00.000Z",
    permission: createIncidentFirstReportPermissionV1({ stateRoot, incidentId })
  });

  const cliContext = {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SBW_STATE_ROOT: stateRoot,
      HOME: home,
      XDG_STATE_HOME: path.join(directory, "xdg"),
      NO_COLOR: "1",
      NODE_NO_WARNINGS: "1"
    },
    recoveryContextFactory: (request) => createSbwIncidentRecoveryContext(request)
  };
  const recoveryPlanPath = path.join(directory, "recovery-plan.json");
  const prepareResult = await runIncidentCli([
    "recovery", "prepare",
    "--incident-id", incidentId,
    "--incident-revision", "1",
    "--run-id", runId,
    "--handle-id", initialStatus.handle.handleId,
    "--new-execution-id", "incident-cli-bridge-execution-2",
    "--new-attempt-id", `${taskId}.attempt.2`,
    "--out", recoveryPlanPath,
    "--state-root", stateRoot,
    "--json"
  ], cliContext);
  assert.equal(prepareResult.exitCode, 0, JSON.stringify(prepareResult));
  assert.equal(prepareResult.value.ok, true);
  assert.equal(prepareResult.value.status, "prepared");
  assert.equal((await lstat(recoveryPlanPath)).mode & 0o077, 0);

  const verifyResult = await runIncidentCli([
    "recovery", "verify",
    "--file", recoveryPlanPath,
    "--state-root", stateRoot,
    "--json"
  ], cliContext);
  assert.equal(verifyResult.exitCode, 0, JSON.stringify(verifyResult));
  assert.equal(verifyResult.value.ok, true);
  assert.equal(verifyResult.value.status, "verified");

  if (privateTemplate) {
    const privateResume = await withRecoveryTTY(() => runIncidentCli([
      "recovery", "resume",
      "--file", recoveryPlanPath,
      "--state-root", stateRoot,
      "--json"
    ], cliContext));
    assert.equal(privateResume.exitCode, 2, JSON.stringify(privateResume));
    assert.equal(privateResume.value.ok, false);
    assert.equal(privateResume.value.status, "HOLD");
    assert.equal(privateResume.value.error.code, "EWORKFLOW_PUBLIC_AUTO_REQUIRED");
    assert.equal(await markerValue(marker), null);
    return;
  }

  // A resume whose bounded budget cannot cover its remaining source reads must
  // fail closed before any effect-bearing runner exists.  It reports HOLD and
  // launches nothing; it never reports UNKNOWN, and it leaves the allocation
  // resumable so the real resume below still succeeds.
  const starvedResume = await withRecoveryTTY(() => runIncidentCli([
    "recovery", "resume",
    "--file", recoveryPlanPath,
    "--state-root", stateRoot,
    "--deadline-ms", "1",
    "--json"
  ], cliContext));
  assert.notEqual(starvedResume.exitCode, 0, JSON.stringify(starvedResume));
  assert.equal(starvedResume.value.ok, false, JSON.stringify(starvedResume));
  assert.notEqual(starvedResume.value.status, "UNKNOWN", JSON.stringify(starvedResume));
  assert.notEqual(starvedResume.exitCode, 3, JSON.stringify(starvedResume));
  assert.equal(await markerValue(marker), null);

  const resumeResult = await withRecoveryTTY(() => runIncidentCli([
    "recovery", "resume",
    "--file", recoveryPlanPath,
    "--state-root", stateRoot,
    "--json"
  ], cliContext), {
    approvalDelayMs,
    beforeApprove: driftDuringApproval
      ? () => writeFile(path.join(repositoryRoot, "README.md"), "changed during owner approval\n")
      : undefined
  });
  if (driftDuringApproval) {
    assert.equal(resumeResult.exitCode, 2, JSON.stringify(resumeResult));
    assert.equal(resumeResult.value.ok, false);
    assert.equal(resumeResult.value.status, "HOLD");
    assert.match(resumeResult.value.error.code, /^(ESOURCE_FRESHNESS_UNAVAILABLE|ESOURCE_BINDING_DRIFT)$/u);
    assert.equal(await markerValue(marker), null);
    await assertNoSentinelOnDisk(stateRoot);
    return;
  }
  assert.equal(resumeResult.exitCode, 0, JSON.stringify(resumeResult));
  assert.equal(resumeResult.value.ok, true, JSON.stringify(resumeResult));
  assert.equal(resumeResult.value.status, "resumed");
  assert.equal(resumeResult.value.effect, "launched-once");
  assert.equal(await markerValue(marker), "launched");

  const secondResume = await runIncidentCli([
    "recovery", "resume",
    "--file", recoveryPlanPath,
    "--state-root", stateRoot,
    "--json"
  ], cliContext);
  assert.notEqual(secondResume.exitCode, 0);
  assert.equal(await markerValue(marker), "launched");
  await assertNoSentinelOnDisk(stateRoot);
}

test("sbw incident recovery rebuilds a trusted context and launches one fresh local effect", { skip: !POSIX }, async (t) => {
  await exerciseIncidentRecovery(t);
});

test("incident recovery keeps private-template observation available but refuses its resume effect", { skip: !POSIX }, async (t) => {
  await exerciseIncidentRecovery(t, { privateTemplate: true });
});

test("incident recovery gives post-approval reads fresh bounded windows after slow human approval", { skip: !POSIX }, async (t) => {
  // A human decision may legitimately outlast the 4s context discovery phase.
  // It must not shrink the new runner's later resolver windows to 1ms.
  await exerciseIncidentRecovery(t, { approvalDelayMs: 4_500 });
});

test("incident recovery rechecks source drift after slow human approval without launching", { skip: !POSIX }, async (t) => {
  await exerciseIncidentRecovery(t, { approvalDelayMs: 4_500, driftDuringApproval: true });
});

test("workflow resume artifacts reuse only an exact private immutable value", async (t) => {
  const directory = await mkdtemp(path.join(BOUND_CREDENTIAL_WORKSPACE_ROOT, "bw-v5-resume-artifact-"));
  t.after(() => removeFixtureRoot(directory));
  const stateRoot = path.join(directory, "state");
  const resumeRoot = path.join(stateRoot, "native-v3-cli", "runs", "fixture-run", "resumes", "fixture");
  const target = path.join(resumeRoot, "binding.json");
  const approvalTarget = path.join(resumeRoot, "approval.json");
  const value = { schemaVersion: 1, kind: "WorkflowResumeArtifactFixtureV1", digest: digestText("exact") };
  const approval = { ...value, kind: "WorkflowResumeApprovalFixtureV1" };

  await __testWriteWorkflowResumeArtifact({ root: stateRoot, target, value });
  // A crash between the two publications leaves one exact artifact behind.
  // Retrying that artifact and then publishing the absent peer must converge
  // without replacing either file.
  await __testWriteWorkflowResumeArtifact({ root: stateRoot, target, value });
  await assert.rejects(readFile(approvalTarget), (error) => error?.code === "ENOENT");
  await __testWriteWorkflowResumeArtifact({ root: stateRoot, target: approvalTarget, value: approval });
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), value);
  assert.deepEqual(JSON.parse(await readFile(approvalTarget, "utf8")), approval);
  assert.equal((await lstat(target)).mode & 0o077, 0);

  const drifted = { ...value, digest: digestText("drifted") };
  await atomicWriteJson(stateRoot, target, drifted);
  await assert.rejects(
    __testWriteWorkflowResumeArtifact({ root: stateRoot, target, value }),
    (error) => error?.code === "EWORKFLOW_RESUME_ARTIFACT_EXISTS" && error?.status === "HOLD"
  );
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), drifted);

  await chmod(approvalTarget, 0o644);
  await assert.rejects(
    __testWriteWorkflowResumeArtifact({ root: stateRoot, target: approvalTarget, value: approval }),
    (error) => error?.code === "EWORKFLOW_RESUME_ARTIFACT_EXISTS" && error?.status === "HOLD"
  );
});
