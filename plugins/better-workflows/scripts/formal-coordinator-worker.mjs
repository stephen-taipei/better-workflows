// SPDX-License-Identifier: AGPL-3.0-only
// Internal supervised phase; only the outer owner may decide what follows its
// actual terminal result. No full qualification or slot release is implied.
import { runFullFormalCoordinator } from "./lib/formal-coordinator.mjs";
import { assertFormalProtectedInvocationV2 } from "./lib/formal-protected-capture-client-v2.mjs";

try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); length += bytes.length;
    if (length > 64 * 1024) throw new Error("Full formal coordinator request exceeds its byte bound");
    chunks.push(bytes);
  }
  const request = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  if (request?.schemaVersion !== 1 || request.kind !== "FullFormalCoordinatorRequestV1" ||
      Object.keys(request).sort().join(",") !== "kind,options,schemaVersion") throw new Error("Invalid full formal coordinator request");
  assertFormalProtectedInvocationV2(request.options);
  const result = await runFullFormalCoordinator(request.options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, kind: "FullFormalCoordinatorErrorV1",
    code: "FORMAL_COORDINATOR_INCOMPLETE", state: error?.coordinator ?? null,
    operationCompletion: "NOT_OBSERVED", releaseEligible: false })}\n`);
}
