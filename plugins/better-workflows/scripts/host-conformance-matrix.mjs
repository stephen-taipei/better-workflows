#!/usr/bin/env node

import { releaseConformanceMatrix } from "./lib/hosts.mjs";

const include = (await releaseConformanceMatrix()).map((entry) => ({
  host_id: entry.hostId,
  os_id: entry.osId,
  runner: entry.runner,
  package: entry.packageName,
  package_version: entry.packageVersion,
  executable: entry.executable
}));

if (include.length !== 8) throw new Error(`Expected eight Tier 1 conformance combinations, found ${include.length}`);
process.stdout.write(`matrix=${JSON.stringify({ include })}\n`);
