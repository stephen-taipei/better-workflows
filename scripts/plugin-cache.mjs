#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPluginCache,
  publishPluginCache
} from "../plugins/better-workflows/scripts/lib/publication.mjs";
import {
  getStateRoot,
  listJsonRecords,
  loadRun,
  safeJoin
} from "../plugins/better-workflows/scripts/lib/core.mjs";
import { validateSelfImproveDeliveryHandoff } from "../plugins/better-workflows/scripts/lib/self-improve-handoff.mjs";

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    options[key] = value;
    index += 1;
  }
  return { positional, options };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [command] = positional;
  if (!["check", "sync"].includes(command)) {
    throw new Error("Usage: node scripts/plugin-cache.mjs check|sync [--cache-root <directory>] [--handoff-run <pr-to-dev-run-id> for sync]");
  }
  const unknown = Object.keys(options).filter((key) => !["cache-root", "handoff-run"].includes(key));
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(", ")}`);
  if (command === "check" && options["handoff-run"] !== undefined) {
    throw new Error("--handoff-run is only valid for sync");
  }
  if (command === "sync" && !options["handoff-run"]) {
    throw new Error("plugin cache sync requires --handoff-run <pr-to-dev-run-id> bound to a self-improve handoff");
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourceRoot = path.join(repoRoot, "plugins", "better-workflows");
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  const cacheRoot = options["cache-root"]
    ? path.resolve(options["cache-root"])
    : path.join(codexHome, "plugins", "cache", "better-workflows", "better-workflows");
  let result;
  if (command === "sync") {
    const stateRoot = getStateRoot();
    const targetRunId = String(options["handoff-run"]);
    const targetRun = await loadRun(stateRoot, targetRunId);
    const evidence = await listJsonRecords(stateRoot, safeJoin(targetRun.runDir, "evidence"));
    const handoff = evidence.find((item) => item.kind === "self-improve-delivery-handoff" && item.status === "complete" && item.stale !== true && item.receipt?.payload);
    if (!handoff) throw new Error("plugin cache sync requires a fresh self-improve-delivery-handoff receipt");
    await validateSelfImproveDeliveryHandoff(handoff.receipt.payload, { ...targetRun, root: stateRoot });
    result = await publishPluginCache({ sourceRoot, cacheRoot });
  } else {
    result = await checkPluginCache({ sourceRoot, cacheRoot });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
