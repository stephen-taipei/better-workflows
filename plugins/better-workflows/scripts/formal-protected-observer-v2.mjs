#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Installed fixed producer; its root-owned broker alone launches the public worker.
import { runInstalledFormalProtectedObserverV2, runFormalObserverSuiteWorkerV2 } from "./lib/formal-protected-observer-v2.mjs";
import { parseStrictJsonV1 } from "./lib/strict-json-v1.mjs";

try {
  const args = process.argv.slice(2);
  let result;
  if (args.length === 1 && args[0] === "--internal-suite-worker-v2") {
    if (!process.channel || typeof process.send !== "function") throw new Error("Internal suite worker requires the root-owned inherited control pipe");
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 16 * 1024) throw new Error("Internal suite job exceeds its byte bound"); chunks.push(chunk); }
    result = await runFormalObserverSuiteWorkerV2(parseStrictJsonV1(Buffer.concat(chunks).toString("utf8"), { maxBytes: 16 * 1024 }));
  } else {
    if (args.length !== 4 || args[0] !== "--expected-head" || args[2] !== "--expected-base") {
      throw new Error("Usage: formal-protected-observer-v2.mjs --expected-head <exact SHA> --expected-base <exact SHA>");
    }
    result = await runInstalledFormalProtectedObserverV2({ expectedHead: args[1], expectedBase: args[3] });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${JSON.stringify({ schemaVersion: 2, kind: "FormalProtectedObserverHoldV2", status: "HOLD",
    code: error.code ?? "EFORMAL_OBSERVER_INCOMPLETE", message: error.message, authority: "none", releaseEligible: false,
    ownedResourceCandidates: error.ownedResourceCandidates ?? null })}\n`);
}
