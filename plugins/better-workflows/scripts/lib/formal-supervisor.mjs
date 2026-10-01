// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formalEvaluatorState } from "./formal-evaluator.mjs";
import { createFormalSuiteEnvironment } from "./formal-environment.mjs";
import { createFormalOperation, FORMAL_FULL_PROFILE } from "./formal-operation.mjs";
import { formalCaptureSucceeded } from "./formal-suite-runner.mjs";
import { parseStrictJsonV1 } from "./strict-json-v1.mjs";
import { assertFormalProtectedInvocationV2 } from "./formal-protected-capture-client-v2.mjs";

const COORDINATOR = fileURLToPath(new URL("../formal-coordinator-worker.mjs", import.meta.url));
const COMMIT_WORKER = fileURLToPath(new URL("../formal-commit-worker.mjs", import.meta.url));
const PATH = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
const digest = value => createHash("sha256").update(value).digest("hex");
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/;
const absolute = value => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value;
const bindings = ["expectedHead", "expectedBase", "outerOwnerPid", "operationNonce", "launchRoot"];

function requestFor(options) {
  assertFormalProtectedInvocationV2(options);
  if (!options || Object.keys(options).some(key => !["cwd", "scriptPath", "expectedHead", "expectedBase", "launchRoot", "nodePaths", "replacementReason", "predecessorCompletionPath"].includes(key)) ||
      process.platform !== "darwin" || process.arch !== "arm64" || process.getuid() === 0 ||
      ![options.cwd, options.scriptPath, options.launchRoot, os.homedir(), process.execPath].every(absolute) ||
      !SHA.test(options.expectedHead ?? "") || !SHA.test(options.expectedBase ?? "") ||
      !/^\/private\/tmp\/bw-[A-Za-z0-9._-]+-formal-eval-[A-Za-z0-9._-]+$/.test(options.launchRoot) ||
      !options.nodePaths || Object.keys(options.nodePaths).sort().join(",") !== "node22,node24" ||
      !Object.values(options.nodePaths).every(absolute) ||
      (options.predecessorCompletionPath != null && (!absolute(options.predecessorCompletionPath) || !options.replacementReason)) ||
      (options.replacementReason != null && !["host-sleep", "sandbox-host-capability", "launch-environment", "command-interruption"].includes(options.replacementReason))) {
    throw new Error("Full formal supervisor requires exact nonroot macOS source/runtime options");
  }
  return { ...structuredClone(options), ownerHome: os.homedir(), outerOwnerPid: process.pid, operationNonce: randomBytes(16).toString("hex") };
}

function normalReply(capture, kind) {
  if (!formalCaptureSucceeded(capture) || capture.stderr !== "") throw new Error(`${kind} has no normal terminal and cleanup`);
  let reply;
  try { reply = parseStrictJsonV1(capture.stdout, { maxBytes: 64 * 1024 }); } catch { throw new Error(`${kind} acknowledgement is invalid`); }
  if (reply?.schemaVersion !== 1 || reply.kind !== kind || reply.operationCompletion !== "NOT_OBSERVED" || reply.releaseEligible !== false) {
    throw new Error(`${kind} acknowledgement has invalid completion claims`);
  }
  return reply;
}

function coordinatorContext(reply, request, elapsedMs) {
  const context = reply.context;
  if (reply.profileId !== FORMAL_FULL_PROFILE.id || reply.qualification !== "NOT_COMMITTED" || !context ||
      !bindings.every(key => reply[key] === request[key] && context[key] === request[key]) ||
      context.ownerHome !== request.ownerHome || context.slotPath !== `/private/tmp/bw-formal-evaluator-${process.getuid()}.lock` ||
      !["provisionalDigest", "ledgerDigest", "slotDigest"].every(key => DIGEST.test(reply[key] ?? "") && reply[key] === context[key]) ||
      typeof context.repositoryIdentity !== "string" || !/^(github:|origin-digest:|common:)[^\0\r\n]+$/.test(context.repositoryIdentity) ||
      context.ledgerPath !== path.join(request.ownerHome, ".better-workflows", "formal-evaluations", digest(context.repositoryIdentity), `${request.expectedHead}.json`) ||
      !Number.isFinite(reply.coordinatorElapsedMs) || reply.coordinatorElapsedMs < 0 || reply.coordinatorElapsedMs > elapsedMs) {
    throw new Error("Full formal coordinator acknowledgement changed source or ownership bindings");
  }
  return structuredClone(context);
}

function commitReply(capture, context) {
  const reply = normalReply(capture, "FullFormalCommitAckV1");
  if (reply.operationNonce !== context.operationNonce || reply.durableCommit !== true ||
      !["passed", "blocked"].includes(reply.qualificationStatus) ||
      ![reply.receiptDigest, reply.ledgerDigest].every(value => DIGEST.test(value ?? ""))) {
    throw new Error("Full formal commit acknowledgement changed its durable bindings");
  }
  return reply;
}

function releaseReply(capture, context, committed) {
  const reply = normalReply(capture, "FullFormalReleaseAckV1");
  if (reply.operationNonce !== context.operationNonce || reply.slotReleased !== true ||
      reply.receiptDigest !== committed.receiptDigest || reply.ledgerDigest !== committed.ledgerDigest ||
      reply.qualificationStatus !== committed.qualificationStatus ||
      ![reply.releaseRecordDigest, reply.releaseIntentDigest].every(value => DIGEST.test(value ?? ""))) {
    throw new Error("Full formal release acknowledgement changed its durable bindings");
  }
  return reply;
}

function inputFor(value) {
  const input = JSON.stringify(value);
  if (Buffer.byteLength(input) > 64 * 1024) throw new Error("Full formal phase request exceeds its byte bound");
  return input;
}

/** Own the entire bounded lifecycle. All filesystem work stays in supervised
 * workers. The final response observes their real termination; no file worker
 * can certify its own future exit. This is unsigned local execution evidence,
 * not protected attestation or publication/replacement authority.
 */
export async function runFullFormalEvaluation(options) {
  const operation = createFormalOperation();
  let phase = "admission", request, context, supervision, commitObservation, committed, releaseObservation, released, phaseTerminal;
  const workerEnv = createFormalSuiteEnvironment(PATH, {});
  const observe = capture => ({ schemaVersion: 1, authority: "none", elapsedMs: operation.assertWithinDeadline(),
    observedAt: new Date().toISOString(), terminal: formalEvaluatorState.terminalReceipt(capture) });
  try {
    request = requestFor(options);
    phase = "coordinator";
    const coordinator = await operation.capture(process.execPath, [COORDINATOR], { cwd: request.cwd,
      env: { ...workerEnv, HOME: request.ownerHome }, kind: "coordinator", maxOutputBytes: 64 * 1024,
      input: inputFor({ schemaVersion: 1, kind: "FullFormalCoordinatorRequestV1", options: request }) });
    phaseTerminal = formalEvaluatorState.terminalReceipt(coordinator);
    const acknowledgement = normalReply(coordinator, "FullFormalCoordinatorAckV1");
    supervision = observe(coordinator);
    context = coordinatorContext(acknowledgement, request, supervision.elapsedMs);

    phase = "commit";
    phaseTerminal = null;
    const commit = await operation.capture(process.execPath, [COMMIT_WORKER], { cwd: request.cwd, env: workerEnv,
      maxOutputBytes: 64 * 1024, input: inputFor({ schemaVersion: 1, kind: "FullFormalCommitRequestV1", action: "commit", context, supervision }) });
    phaseTerminal = formalEvaluatorState.terminalReceipt(commit);
    committed = commitReply(commit, context);
    commitObservation = observe(commit);

    phase = "release";
    phaseTerminal = null;
    const release = await operation.capture(process.execPath, [COMMIT_WORKER], { cwd: request.cwd, env: workerEnv,
      maxOutputBytes: 64 * 1024, input: inputFor({ schemaVersion: 1, kind: "FullFormalReleaseRequestV1", action: "release", context, supervision, commitObservation }) });
    phaseTerminal = formalEvaluatorState.terminalReceipt(release);
    released = releaseReply(release, context, committed);
    releaseObservation = observe(release);
    const completion = { schemaVersion: 1, kind: "FullFormalCompletionV1", profileId: FORMAL_FULL_PROFILE.id, authority: "none",
      context, supervision, commitObservation, releaseObservation, committed, released, operation: operation.snapshot(),
      qualificationStatus: committed.qualificationStatus, operationCompletion: "OBSERVED", releaseEligible: false };
    // Include snapshot construction in the work cutoff and retain the same
    // final validated sample. No later snapshot may silently cross the cutoff.
    completion.operation.elapsedMs = operation.assertWithinDeadline();
    return completion;
  } catch (error) {
    if (error?.execution) phaseTerminal = formalEvaluatorState.terminalReceipt(error.execution);
    operation.fail(`full-${phase}-incomplete`);
    let reconciliation = null;
    // A diagnostic coordinator context is insufficient for either readback.
    // Once mutation was dispatched, reconciliation is the only permitted call.
    if (context && supervision && ["commit", "release"].includes(phase)) {
      const readback = phase === "release" && commitObservation
        ? { schemaVersion: 1, kind: "FullFormalReleaseRequestV1", action: "reconcile", context, supervision, commitObservation }
        : { schemaVersion: 1, kind: "FullFormalCommitRequestV1", action: "reconcile", context, supervision };
      try {
        const capture = await operation.readback(readback, { cwd: request.cwd, env: workerEnv });
        const expectedKind = readback.kind === "FullFormalReleaseRequestV1" ? "FullFormalReleaseReconciliationV1" : "FullFormalCommitReconciliationV1";
        const reply = normalReply(capture, expectedKind);
        if (reply.operationNonce !== context.operationNonce) throw new Error("Full formal readback nonce changed");
        reconciliation = { reply, terminal: formalEvaluatorState.terminalReceipt(capture) };
      } catch { /* Missing readback never supplies cleanup or unlocks a retry. */ }
    }
    return { schemaVersion: 1, kind: "FullFormalIncompleteV1", profileId: FORMAL_FULL_PROFILE.id, authority: "none", phase,
      request: request ?? null, phaseTerminal: phaseTerminal ?? null,
      context: context ?? null, supervision: supervision ?? null, commitObservation: commitObservation ?? null,
      releaseObservation: releaseObservation ?? null, committed: committed ?? null, reconciliation,
      operation: operation.snapshot(), qualificationStatus: committed?.qualificationStatus ?? "UNKNOWN",
      operationCompletion: "UNKNOWN", releaseEligible: false };
  } finally { operation.dispose(); }
}
