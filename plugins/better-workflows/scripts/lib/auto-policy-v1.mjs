// SPDX-License-Identifier: AGPL-3.0-only
// A single public template contains complete, inert policy data. Selection
// grants no authority; the contract and action gates still require evidence.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const CATALOG_URL = new URL("../../templates/auto.json", import.meta.url);
const IDS = Object.freeze(["read-only-v1", "code-change-v1", "dev-publish-v1"]);
const DEV_TARGETS = new Set(["dev", "origin/dev", "refs/heads/dev"]);
const catalogBytes = readFileSync(CATALOG_URL);
const assertCatalogBytesUnchanged = createSourceIntegritySnapshot(
  catalogBytes,
  "Installed public Auto policy changed during this process"
);
const catalog = JSON.parse(catalogBytes.toString("utf8"));

if (catalog.schemaVersion !== 1 || catalog.kind !== "AutoPolicyCatalogV1" ||
    catalog.name !== "auto" || !catalog.variants ||
    JSON.stringify(Object.keys(catalog.variants).sort()) !== JSON.stringify([...IDS].sort())) {
  throw new Error("Public Auto policy catalog is invalid or incomplete");
}
for (const id of IDS) {
  const policy = catalog.variants[id];
  if (!policy || policy.name !== "auto" || policy.autoPolicyId !== id ||
      !Array.isArray(policy.executionStages) || !Array.isArray(policy.requiredEvidence) ||
      !policy.controlPlane || !policy.actionGates || !policy.actionStages) {
    throw new Error(`Public Auto policy is incomplete: ${id}`);
  }
}

export const AUTO_POLICY_IDS = IDS;

// Pure byte comparison: this helper cannot select a catalog or produce a
// policy binding. The installed policy remains rooted at CATALOG_URL above.
export function createSourceIntegritySnapshot(initialBytes, message = "Source bytes changed during this process") {
  const sourceDigest = (bytes) => {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("Source integrity requires bytes");
    return createHash("sha256").update(bytes).digest("hex");
  };
  const initialDigest = sourceDigest(initialBytes);
  return (currentBytes) => {
    if (sourceDigest(currentBytes) !== initialDigest) throw new Error(message);
  };
}

export function assertInstalledAutoPolicyUnchanged() {
  assertCatalogBytesUnchanged(readFileSync(CATALOG_URL));
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

export function autoPolicyDigest(value) {
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}

export function autoPolicyDefinition(id) {
  if (!IDS.includes(id)) throw new Error(`Unknown public Auto policy: ${id}`);
  return structuredClone(catalog.variants[id]);
}

export function autoPolicyTarget(id) {
  if (!IDS.includes(id)) throw new Error(`Unknown public Auto policy: ${id}`);
  return id === "dev-publish-v1" ? "dev" : null;
}

export function autoPolicyBinding(id) {
  return {
    schemaVersion: 1,
    id,
    policyDigest: autoPolicyDigest(autoPolicyDefinition(id)),
    target: autoPolicyTarget(id)
  };
}

export function assertAutoPolicyBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
      !IDS.includes(binding.id) ||
      autoPolicyDigest(binding) !== autoPolicyDigest(autoPolicyBinding(binding.id))) {
    throw new Error("Public Auto policy binding differs from the installed canonical policy");
  }
  return autoPolicyBinding(binding.id);
}

export function selectAutoPolicyId({ mutationIntent, integrationTarget, protectedTarget }) {
  if (mutationIntent === "read-only") return "read-only-v1";
  if (mutationIntent !== "modify") return null;
  const exactDev = DEV_TARGETS.has(String(integrationTarget ?? ""));
  if (protectedTarget === true && !exactDev) return null;
  return exactDev ? "dev-publish-v1" : "code-change-v1";
}
