#!/usr/bin/env node

import { productReleaseConformanceMatrix, productReleaseScope } from "./lib/product-release-scope-v1.mjs";
import { RUNTIME_QUALIFICATION_LANES } from "./lib/runtime-qualification-v1.mjs";

const include = (await productReleaseConformanceMatrix()).map((entry) => ({
  host_id: entry.hostId,
  os_id: entry.osId,
  runner: entry.runner,
  package: entry.packageName,
  package_version: entry.packageVersion,
  executable: entry.executable
}));

if (include.length === 0) throw new Error("The product release conformance matrix is empty");
process.stdout.write(`matrix=${JSON.stringify({ include })}\n`);
const { scope } = await productReleaseScope();
process.stdout.write(`runtime_enabled=${scope !== null}\n`);
process.stdout.write(`runtime_matrix=${JSON.stringify({ include: scope ? RUNTIME_QUALIFICATION_LANES.map((lane) => ({ lane: lane.id, node: lane.nodeVersion, runner: lane.runner })) : [] })}\n`);
