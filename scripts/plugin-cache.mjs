#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPluginCache,
  publishPluginCache
} from "../plugins/better-workflows/scripts/lib/publication.mjs";

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
    throw new Error("Usage: node scripts/plugin-cache.mjs check|sync [--cache-root <directory>]");
  }
  const unknown = Object.keys(options).filter((key) => key !== "cache-root");
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(", ")}`);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourceRoot = path.join(repoRoot, "plugins", "better-workflows");
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  const cacheRoot = options["cache-root"]
    ? path.resolve(options["cache-root"])
    : path.join(codexHome, "plugins", "cache", "better-workflows", "better-workflows");
  const result = command === "sync"
    ? await publishPluginCache({ sourceRoot, cacheRoot })
    : await checkPluginCache({ sourceRoot, cacheRoot });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
