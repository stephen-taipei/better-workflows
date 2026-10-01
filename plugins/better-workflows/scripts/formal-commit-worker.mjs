// SPDX-License-Identifier: AGPL-3.0-only
// Internal file-only worker. The outer owner must supervise this process with
// its remaining operation deadline and observe its actual terminal/cleanup.
// Neither this response nor a persisted aggregate authenticates execution.
import { commitFullFormalAggregate, reconcileFullFormalAggregate, releaseOwnedFullFormalSlot, reconcileFullFormalRelease } from "./lib/formal-commit.mjs";

const MAX_REQUEST_BYTES = 64 * 1024;
let action;
let releaseRequest = false;
try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_REQUEST_BYTES) throw new Error("Full formal worker request exceeds its byte bound");
    chunks.push(bytes);
  }
  const request = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  releaseRequest = request?.kind === "FullFormalReleaseRequestV1";
  const validRoute = releaseRequest
    ? ["release", "reconcile"].includes(request.action) && Object.keys(request).sort().join(",") === "action,commitObservation,context,kind,schemaVersion,supervision"
    : request?.kind === "FullFormalCommitRequestV1" && ["commit", "reconcile"].includes(request.action) &&
      Object.keys(request).sort().join(",") === "action,context,kind,schemaVersion,supervision";
  if (request?.schemaVersion !== 1 || !validRoute) {
    throw new Error("Full formal worker request schema is invalid");
  }
  action = request.action;
  const result = releaseRequest
    ? await (action === "release" ? releaseOwnedFullFormalSlot : reconcileFullFormalRelease)(request.context, request.supervision, request.commitObservation)
    : await (action === "commit" ? commitFullFormalAggregate : reconcileFullFormalAggregate)(request.context, request.supervision);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, kind: "FullFormalCommitWorkerErrorV1",
    code: ["FORMAL_COMMIT_OUTCOME_UNKNOWN", "FORMAL_RELEASE_OUTCOME_UNKNOWN"].includes(error?.code) ? error.code : "FORMAL_COMMIT_WORKER_REJECTED",
    action: action ?? null, commitOutcome: action === "commit" || error?.code === "FORMAL_COMMIT_OUTCOME_UNKNOWN" ? "UNKNOWN" : "NOT_OBSERVED",
    ...(releaseRequest ? { releaseOutcome: action === "release" || error?.code === "FORMAL_RELEASE_OUTCOME_UNKNOWN" ? "UNKNOWN" : "NOT_OBSERVED" } : {}),
    operationCompletion: "NOT_OBSERVED", releaseEligible: false })}\n`);
}
