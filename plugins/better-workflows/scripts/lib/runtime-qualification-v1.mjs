// SPDX-License-Identifier: AGPL-3.0-only
// This policy describes execution coverage; it does not authenticate receipts.
import { readFile } from "node:fs/promises";
import { digestObject, sha256 } from "./core.mjs";

export const RUNTIME_QUALIFICATION_WORKFLOW = ".github/workflows/host-conformance.yml";
export const RUNTIME_QUALIFICATION_REPOSITORY = "stephen-taipei/better-workflows";
export const RUNTIME_QUALIFICATION_REPOSITORY_ID = "1369419846";
export const RUNTIME_QUALIFICATION_LANES = Object.freeze([
  Object.freeze({ id: "macos-node22", platform: "darwin", arch: "arm64", runner: "macos-15", nodeVersion: "22.23.3" }),
  Object.freeze({ id: "macos-node24", platform: "darwin", arch: "arm64", runner: "macos-15", nodeVersion: "24.21.0" })
]);
const POSIX_SUITES = Object.freeze([
  "posix-owned-process-adapter", "native-v3-command-runner", "native-v3-production-recovery",
  "native-v3-plan-runner", "native-v3-plan-runner-recovery", "platform-receipts-v1"
].map((name) => `scripts/tests/${name}.test.mjs`));
const FEATURE_SUITES = Object.freeze(["runtime-support", "workspace", "auto-policy-v1"].map((name) => `scripts/tests/${name}.test.mjs`));
const PLUGIN_URL = new URL("../../", import.meta.url);

export function runtimeQualificationCommands(laneId) {
  const lane = RUNTIME_QUALIFICATION_LANES.find((entry) => entry.id === laneId);
  if (!lane) throw new Error("Unknown runtime qualification lane");
  return [
    { id: "posix-process", args: ["--experimental-vm-modules", "--test", "--test-reporter=tap", "--test-concurrency=1", ...POSIX_SUITES] },
    { id: "runtime-features", args: [...(lane.nodeVersion.startsWith("22.") ? ["--experimental-test-isolation=none"] : []), "--experimental-vm-modules", "--test", "--test-reporter=tap", "--test-concurrency=1", ...FEATURE_SUITES] }
  ];
}

export async function runtimeQualificationPolicy() {
  const files = await Promise.all([...POSIX_SUITES, ...FEATURE_SUITES].sort().map(async (file) => ({
    path: `plugins/better-workflows/${file}`, sha256: sha256(await readFile(new URL(file, PLUGIN_URL)))
  })));
  const policy = {
    schemaVersion: 1,
    kind: "RuntimeQualificationPolicyV1",
    productVersion: "5.0.0",
    revision: "macos-node22-24-20260929-r2",
    coverage: "posix-process-and-runtime-features",
    fullEvaluatorIncluded: false,
    pinsObservedFrom: "https://nodejs.org/dist/index.json",
    pinsObservedAt: "2026-09-27",
    lanes: RUNTIME_QUALIFICATION_LANES.map((lane) => ({ ...lane, commands: runtimeQualificationCommands(lane.id) })),
    files,
    acceptance: { failures: 0, skipped: 0, cancelled: 0, todo: 0, processGroupsTerminated: true }
  };
  return { policy, policyDigest: digestObject(policy) };
}

export function qualificationTapSummary(stdout) {
  const values = {};
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const matches = [...String(stdout).matchAll(new RegExp(`^# ${key} ([0-9]+)\\r?$`, "gm"))];
    if (matches.length !== 1) throw new Error(`Runtime TAP summary is missing or ambiguous: ${key}`);
    const value = Number(matches[0][1]);
    if (!Number.isSafeInteger(value)) throw new Error("Runtime TAP count exceeds bounds");
    values[key] = value;
  }
  if (values.tests < 1 || values.pass !== values.tests || ["fail", "cancelled", "skipped", "todo"].some((key) => values[key] !== 0)) {
    throw new Error("Runtime qualification requires nonempty execution with no failures, skips, cancellations, or todo");
  }
  return values;
}

export function runtimeTemporaryCleanupEligible(laneId, commands, { failure, aborted }) {
  const expected = runtimeQualificationCommands(laneId);
  return failure === null && aborted === false && Array.isArray(commands) && commands.length === expected.length &&
    expected.every((command, index) => {
      const entry = commands[index];
      return entry?.id === command.id && entry.result === "PASS" &&
        entry.processGroupTerminated === true && entry.exitCode === 0 && entry.signal === null &&
        entry.timedOut === false && entry.outputExceeded === false;
    });
}

// Advisory structure check only. A matching JSON object never establishes
// execution, signature verification, or permission to publish a release.
export function inspectRuntimeQualificationEnvelope(envelope, { sourceRevision, scopeDigest, policy, policyDigest, lane, runId, runAttempt }) {
  const { envelopeDigest, ...payload } = envelope ?? {};
  if (digestObject(payload) !== envelopeDigest || payload.kind !== "RuntimeQualificationEnvelopeV1" || payload.schemaVersion !== 1 ||
      payload.sourceRevision !== sourceRevision || payload.productReleaseScopeDigest !== scopeDigest || payload.policyDigest !== policyDigest ||
      digestObject(payload.lane) !== digestObject(lane) || digestObject(payload.files) !== digestObject(policy.files) ||
      payload.coverage !== policy.coverage || payload.fullEvaluatorIncluded !== false || payload.result !== "PASS" || payload.failure !== null ||
      payload.host?.platform !== lane.platform || payload.host?.arch !== lane.arch || payload.runtime?.version !== lane.nodeVersion ||
      !/^[a-f0-9]{64}$/.test(payload.runtime?.executableSha256 ?? "") || payload.cleanup?.tempRemoved !== true ||
      payload.cleanup?.status !== "VERIFIED_WITHIN_SUITE_SCOPE" ||
      digestObject(payload.cleanup?.evidence) !== digestObject(["capture-process-group", "successful-suite-cleanup-assertions"]) ||
      payload.authentication?.status !== "awaiting-github-oidc-attestation" || payload.authentication?.releaseEligible !== false) {
    throw new Error(`Runtime envelope policy, execution, or source mismatch: ${lane.id}`);
  }
  const expectedGithub = { repository: RUNTIME_QUALIFICATION_REPOSITORY, repositoryId: RUNTIME_QUALIFICATION_REPOSITORY_ID,
    runId, runAttempt, workflowRef: `${RUNTIME_QUALIFICATION_REPOSITORY}/${RUNTIME_QUALIFICATION_WORKFLOW}@refs/heads/main`,
    workflowSha: sourceRevision, sourceRef: "refs/heads/main", runnerEnvironment: "github-hosted" };
  if (digestObject(payload.github) !== digestObject(expectedGithub)) throw new Error("Runtime envelope workflow or attempt drift");
  const timestamp = (value) => {
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
  };
  const start = timestamp(payload.startedAt);
  const end = timestamp(payload.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("Runtime execution interval is invalid");
  const expectedCommands = runtimeQualificationCommands(lane.id);
  if (!Array.isArray(payload.commands) || payload.commands.length !== expectedCommands.length) throw new Error("Runtime command coverage incomplete");
  let previousEnd = start;
  for (const [index, expected] of expectedCommands.entries()) {
    const command = payload.commands[index];
    if (!command || command.id !== expected.id || digestObject(command.args) !== digestObject(expected.args) || command.result !== "PASS" ||
        command.exitCode !== 0 || command.signal !== null || command.timedOut !== false || command.outputExceeded !== false || command.processGroupTerminated !== true ||
        !/^[a-f0-9]{64}$/.test(command.stdoutSha256 ?? "") || !/^[a-f0-9]{64}$/.test(command.stderrSha256 ?? "")) {
      throw new Error("Runtime command lacks successful execution and cleanup");
    }
    const commandStart = timestamp(command.startedAt);
    const commandEnd = timestamp(command.finishedAt);
    if (!Number.isFinite(commandStart) || !Number.isFinite(commandEnd) || commandStart < previousEnd || commandEnd > end || commandEnd < commandStart ||
        !Number.isSafeInteger(command.elapsedMs) || command.elapsedMs < 0) throw new Error("Runtime command interval is invalid");
    previousEnd = commandEnd;
  }
  return Object.freeze({ matches: true, authority: "none", envelopeDigest });
}
