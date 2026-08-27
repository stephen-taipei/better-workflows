import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "../..");

async function source(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("main merges never auto-create stable tags", async () => {
  const ci = await source(".github/workflows/ci.yml");
  assert.match(ci, /github\.ref == 'refs\/heads\/dev'/);
  assert.doesNotMatch(ci, /github\.ref == 'refs\/heads\/main'/);
  assert.match(ci, /Stable main tags are created only by the release controller/);
});

test("Tier 1 conformance publishes exactly eight source-bound OIDC-attested receipts", async () => {
  const workflow = await source(".github/workflows/host-conformance.yml");
  const registry = JSON.parse(await source("plugins/better-workflows/config/host-support-v1.json"));
  const tierOne = registry.hosts.filter((host) => host.supportTier === "tier1");
  assert.equal(tierOne.length * 2, 8);
  assert.ok(tierOne.every((host) => host.conformancePackage?.name && host.conformancePackage?.version));
  assert.match(workflow, /host-conformance-matrix\.mjs/);
  assert.match(workflow, /fromJSON\(needs\.matrix\.outputs\.matrix\)/);
  for (const token of [
    "host-conformance-ci.mjs",
    "actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be",
    "workspace.test.mjs",
    "routing.test.mjs",
    "providers.test.mjs",
    "control-plane-v2.test.mjs",
    "self-improve.test.mjs",
    "CLI Direct Git route"
  ]) assert.match(workflow, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), token);
  for (const host of tierOne) assert.match(JSON.stringify(registry), new RegExp(host.conformancePackage.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const gate = await source("plugins/better-workflows/scripts/release-conformance-gate.mjs");
  assert.match(gate, /sourceRun\.path !== "\.github\/workflows\/host-conformance\.yml"/);
  assert.match(gate, /--signer-workflow/);
  assert.match(gate, /--deny-self-hosted-runners/);
  assert.match(gate, /Conformance test or coverage manifest is incomplete/);
});

test("stable release is dispatch-only and orders all gates before publication", async () => {
  const workflow = await source(".github/workflows/stable-release.yml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /environment: stable-release/);
  assert.match(workflow, /release Better Workflows v4\.0\.0/);
  const ordered = [
    "Run fresh release validation",
    "Download all eight source-bound conformance envelopes",
    "Verify OIDC attestations and the exact 8-combination matrix",
    "Verify the deployed exact SHA and all 41 public locale pages",
    "Attest the exact public website QA receipt",
    "Publish and reconcile the stable tag and GitHub Release"
  ];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(workflow.indexOf(ordered[index - 1]) < workflow.indexOf(ordered[index]), ordered[index]);
  }
});

test("release controller fails closed on main drift, conflicting tags, missing checks, and incomplete public evidence", async () => {
  const controller = await source("plugins/better-workflows/scripts/stable-release.mjs");
  assert.match(controller, /origin\/main is not the authorized release revision/);
  assert.match(controller, /Existing \$\{tagName\} points to a different commit/);
  assert.match(controller, /successful fresh required test check/);
  assert.match(controller, /check\.app\?\.slug === "github-actions"/);
  assert.match(controller, /requiredCombinations !== 8/);
  assert.match(controller, /locales\?\.length !== 41/);
  assert.match(controller, /draft: false/);
  assert.match(controller, /prerelease: false/);
  assert.match(controller, /--signer-workflow/);
  assert.match(controller, /--deny-self-hosted-runners/);
  assert.doesNotMatch(controller, /force/);

  const publicQa = await source("scripts/website-public-qa.mjs");
  assert.match(publicQa, /release\.revision !== sourceRevision/);
  assert.match(publicQa, /sha256\(manifestBuffer\) !== release\.contentDigest/);
  assert.match(publicQa, /manifestEntries\.get\(relativePath\) !== responseDigest/);
  assert.match(publicQa, /localeReceipts\.length === 41/);
});
