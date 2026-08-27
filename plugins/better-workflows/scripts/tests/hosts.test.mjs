import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hostConformance,
  hostDoctor,
  hostList,
  loadHostSupportRegistry,
  releaseConformanceMatrix,
  renderHostSupportHtml,
  renderHostSupportMarkdown
} from "../lib/hosts.mjs";

test("host-support-v1 keeps one recommended reference, eight Tier 1 combinations, and Windows Preview", async () => {
  const registry = await loadHostSupportRegistry();
  const listed = await hostList();
  assert.equal(registry.id, "host-support-v1");
  assert.equal(listed.hosts.length, 9);
  assert.deepEqual(listed.recommended, registry.recommended);
  assert.equal(registry.recommended.label, "macOS + Codex");
  assert.equal((await releaseConformanceMatrix()).length, 8);
  assert.deepEqual(
    registry.hosts.filter((host) => host.supportTier === "tier1").map((host) => host.id).sort(),
    ["claude-code", "codex", "gemini-cli", "qwen-code"]
  );
  assert.ok(registry.hosts.every((host) => host.osSupport.windows === "preview"));
  const capabilityIds = registry.capabilityDefinitions.map((capability) => capability.id).sort();
  for (const host of registry.hosts) assert.deepEqual(Object.keys(host.capabilities).sort(), capabilityIds);
});

test("public host matrices are rendered from the registry without claiming native UX parity", async () => {
  const registry = await loadHostSupportRegistry();
  const markdown = renderHostSupportMarkdown(registry);
  const html = renderHostSupportHtml(registry);
  assert.match(markdown, /Recommended reference \| \*\*macOS \+ Codex\*\*/);
  assert.match(markdown, /host-native UX may differ/);
  assert.match(markdown, /Windows \| Not covered by the v4\.0\.0 Tier 1 guarantee/);
  for (const host of registry.hosts) assert.match(html, new RegExp(host.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /Recommended on macOS/);
});

test("host doctor and conformance bind an executable, manifest, registry, and non-release local receipt", async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "sbw-host-bin-"));
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-host-state-"));
  const executable = path.join(bin, "codex");
  await writeFile(executable, "#!/bin/sh\nprintf 'codex-test 4.0.0\\n'\n");
  await chmod(executable, 0o755);
  const env = { PATH: bin };
  const doctor = await hostDoctor({ hostId: "codex", osId: "macos", env });
  assert.equal(doctor.ok, true);
  assert.equal(doctor.recommended, true);
  assert.match(doctor.executable.digest, /^[a-f0-9]{64}$/);
  assert.match(doctor.manifest.digest, /^[a-f0-9]{64}$/);

  const receipt = await hostConformance({
    hostId: "codex",
    osId: "macos",
    stateRoot,
    writeReceipt: true,
    env
  });
  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.capabilities.length, 5);
  assert.ok(receipt.capabilities.every((capability) => capability.result === "PASS"));
  assert.equal(receipt.authentication.releaseEligible, false);
  assert.match(receipt.receiptDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await readFile(receipt.receiptPath, "utf8")).receiptDigest, receipt.receiptDigest);
});

test("host registry rejects Tier 1 Windows and duplicate host identities", async () => {
  const source = await loadHostSupportRegistry();
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-host-registry-"));
  const registryPath = path.join(directory, "registry.json");
  const windowsTierOne = structuredClone(source);
  windowsTierOne.hosts[0].osSupport.windows = "tier1";
  await writeFile(registryPath, `${JSON.stringify(windowsTierOne)}\n`);
  await assert.rejects(loadHostSupportRegistry({ registryPath }), /windows cannot be Tier 1/);

  const duplicate = structuredClone(source);
  duplicate.hosts.push(structuredClone(duplicate.hosts[0]));
  await writeFile(registryPath, `${JSON.stringify(duplicate)}\n`);
  await assert.rejects(loadHostSupportRegistry({ registryPath }), /duplicate id: codex/);
});

test("host doctor distinguishes a declared support tier from a missing local executable", async () => {
  const emptyPath = await mkdtemp(path.join(os.tmpdir(), "sbw-host-empty-"));
  const doctor = await hostDoctor({
    hostId: "claude-code",
    osId: "linux",
    env: { PATH: emptyPath }
  });
  assert.equal(doctor.supportTier, "tier1");
  assert.equal(doctor.ok, false);
  assert.deepEqual(doctor.blockers, ["host-executable-missing"]);
  assert.ok(doctor.manifest);
});
