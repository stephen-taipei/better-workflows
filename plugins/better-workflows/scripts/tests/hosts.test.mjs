import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  hostConformance,
  hostDoctor,
  hostList,
  loadHostSupportRegistry,
  releaseConformanceMatrix,
  renderHostSupportHtml,
  renderHostSupportMarkdown
} from "../lib/hosts.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("host-support-v1 keeps one recommended reference, eight Tier 1 combinations, and Windows Preview", async () => {
  const registry = await loadHostSupportRegistry();
  const listed = await hostList();
  assert.equal(registry.id, "host-support-v1");
  assert.equal(listed.hosts.length, 9);
  assert.deepEqual(listed.recommended, registry.recommended);
  assert.equal(registry.recommended.label, "macOS + Codex");
  const matrix = await releaseConformanceMatrix();
  assert.equal(matrix.length, 8);
  assert.ok(matrix.every((entry) => entry.packageName && entry.packageVersion && entry.executable && entry.runner));
  assert.deepEqual(
    registry.hosts.filter((host) => host.supportTier === "tier1").map((host) => host.id).sort(),
    ["claude-code", "codex", "gemini-cli", "qwen-code"]
  );
  assert.ok(registry.hosts.every((host) => host.osSupport.windows === "preview"));
  assert.ok(registry.hosts.filter((host) => host.supportTier === "tier1").every((host) => host.conformancePackage));
  assert.ok(registry.hosts.filter((host) => host.supportTier === "tier1").every((host) => host.conformanceProbe));
  assert.ok(registry.hosts.filter((host) => host.supportTier === "tier1").every((host) => host.distributionRoot && host.helperPath));
  assert.ok(registry.hosts.filter((host) => host.supportTier !== "tier1").every((host) => host.conformancePackage === null));
  assert.ok(registry.hosts.filter((host) => host.supportTier !== "tier1").every((host) => host.conformanceProbe === null));
  assert.ok(registry.hosts.filter((host) => host.supportTier !== "tier1").every((host) => host.distributionRoot === null && host.helperPath === null));
  assert.ok(registry.hosts.filter((host) => host.supportTier === "preview").every((host) => host.manifestPath === `compatibility/preview/${host.id}.json`));
  const capabilityIds = registry.capabilityDefinitions.map((capability) => capability.id).sort();
  for (const host of registry.hosts) assert.deepEqual(Object.keys(host.capabilities).sort(), capabilityIds);
});

test("public host matrices are rendered from the registry without claiming native UX parity", async () => {
  const registry = await loadHostSupportRegistry();
  const markdown = renderHostSupportMarkdown(registry);
  const html = renderHostSupportHtml(registry);
  assert.match(markdown, /Recommended reference \| \*\*macOS \+ Codex\*\*/);
  assert.match(markdown, /\| AI hosts \| Support \| Core control plane \| Native and host-specific surfaces \|/);
  assert.match(markdown, /task-contract: native; typed-evidence: native; replay: native/);
  assert.match(markdown, /host-native UX may differ/);
  assert.match(markdown, /Windows \| Not covered by the v4\.0\.0 Tier 1 guarantee/);
  for (const host of registry.hosts) assert.match(html, new RegExp(host.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /Recommended on macOS/);
  assert.match(html, /class="capability-matrix"/);
});

test("public host-support declarations expose the five stable adapter types", async () => {
  const declarations = await readFile(path.join(pluginRoot, "types", "host-support-v1.d.ts"), "utf8");
  for (const name of ["HostId", "SupportTier", "CapabilityStatus", "HostAdapterManifest", "HostCapabilityReceipt"]) {
    assert.match(declarations, new RegExp(`export (?:type|interface) ${name}\\b`));
  }
  const packageManifest = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
  assert.equal(packageManifest.types, "types/host-support-v1.d.ts");
});

test("every Preview host ships an exact manual compatibility pack", async () => {
  const registry = await loadHostSupportRegistry();
  const instructions = await readFile(path.join(pluginRoot, "compatibility", "preview", "INSTRUCTIONS.md"), "utf8");
  assert.match(instructions, /not a native extension/);
  assert.match(instructions, /cannot upgrade a Preview combination to Tier 1/);
  assert.match(instructions, /XDG_STATE_HOME\/better-workflows/);
  for (const host of registry.hosts.filter((candidate) => candidate.supportTier === "preview")) {
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, host.manifestPath), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.id, "better-workflows-preview-host-pack");
    assert.equal(manifest.hostId, host.id);
    assert.equal(manifest.version, "4.0.0");
    assert.equal(manifest.supportTier, "preview");
    assert.equal(manifest.contextFileName, "compatibility/preview/INSTRUCTIONS.md");
    assert.equal(manifest.entrypoint, "scripts/sbw.mjs");
  }
});

test("Tier 1 bridge contexts use the host-neutral state root contract", async () => {
  const repoRoot = path.resolve(pluginRoot, "../..");
  for (const file of [
    path.join(repoRoot, "GEMINI.md"),
    path.join(repoRoot, "QWEN.md"),
    path.join(pluginRoot, "GEMINI.md"),
    path.join(pluginRoot, "QWEN.md")
  ]) {
    const content = await readFile(file, "utf8");
    assert.match(content, /XDG_STATE_HOME\/better-workflows/, file);
    assert.match(content, /SBW_STATE_ROOT/, file);
  }
});

test("host doctor and conformance bind an executable, manifest, registry, and non-release local receipt", async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "sbw-host-bin-"));
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-host-state-"));
  const executable = path.join(bin, "codex");
  await writeFile(executable, "#!/bin/sh\nprintf 'codex-cli 0.150.1\\n'\n");
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
  assert.match(receipt.versionProbe.runtime.digest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.versionProbe.runtime.path, process.execPath);
  assert.equal(receipt.versionProbe.expectedVersion, "0.150.1");
  assert.equal(receipt.versionProbe.versionMatched, true);
  assert.equal(receipt.extensionProbe.kind, "native-contract");
  assert.equal(receipt.extensionProbe.result, "PASS");
  assert.match(receipt.extensionProbe.probeDigest, /^[a-f0-9]{64}$/);
  assert.match(receipt.receiptDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await readFile(receipt.receiptPath, "utf8")).receiptDigest, receipt.receiptDigest);
});

test("Tier 1 bridge conformance executes each official extension validation path", async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "sbw-host-probes-"));
  const scripts = new Map([
    ["claude", [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then printf '2.1.247 (Claude Code)\\n'; exit 0; fi",
      "if [ \"$1\" = \"plugin\" ] && [ \"$2\" = \"validate\" ] && [ -f \"$3/.claude-plugin/plugin.json\" ] && [ \"$4\" = \"--strict\" ]; then printf 'valid claude plugin\\n'; exit 0; fi",
      "exit 9"
    ].join("\n")],
    ["gemini", [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then printf '0.57.0\\n'; exit 0; fi",
      "if [ \"$1\" = \"extensions\" ] && [ \"$2\" = \"validate\" ] && [ -f \"$3/gemini-extension.json\" ]; then printf 'valid gemini extension\\n'; exit 0; fi",
      "if [ \"$1\" = \"extensions\" ] && [ \"$2\" = \"install\" ] && [ \"$4\" = \"--consent\" ]; then",
      "  mkdir -p \"$HOME/.gemini/extensions/better-workflows\"",
      "  cp -R \"$3/.\" \"$HOME/.gemini/extensions/better-workflows\"",
      "  printf 'installed gemini extension\\n'",
      "  exit 0",
      "fi",
      "exit 9"
    ].join("\n")],
    ["qwen", [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then printf '0.22.2\\n'; exit 0; fi",
      "if [ \"$1\" = \"extensions\" ] && [ \"$2\" = \"install\" ] && [ \"$4\" = \"--consent\" ]; then",
      "  mkdir -p \"$HOME/.qwen/extensions/better-workflows\"",
      "  cp -R \"$3/.\" \"$HOME/.qwen/extensions/better-workflows\"",
      "  printf 'installed qwen extension\\n'",
      "  exit 0",
      "fi",
      "exit 9"
    ].join("\n")]
  ]);
  for (const [command, source] of scripts) {
    await writeFile(path.join(bin, command), `${source}\n`);
    await chmod(path.join(bin, command), 0o755);
  }
  for (const [hostId, expectedKind] of [
    ["claude-code", "cli-validate"],
    ["gemini-cli", "cli-validate-install"],
    ["qwen-code", "isolated-install"]
  ]) {
    const receipt = await hostConformance({ hostId, osId: "linux", env: { PATH: bin } });
    assert.equal(receipt.result, "PASS", `${hostId}: ${receipt.extensionProbe.reason}`);
    assert.equal(receipt.extensionProbe.kind, expectedKind);
    assert.equal(receipt.extensionProbe.result, "PASS");
    assert.match(receipt.extensionProbe.probeDigest, /^[a-f0-9]{64}$/);
    if (hostId === "gemini-cli" || hostId === "qwen-code") {
      assert.match(receipt.extensionProbe.installedManifestDigest, /^[a-f0-9]{64}$/);
      assert.equal(receipt.extensionProbe.installedHelperDigest, receipt.extensionProbe.helperDigest);
      assert.equal(receipt.extensionProbe.installedComponentDigest, receipt.extensionProbe.componentDigest);
      assert.equal(receipt.extensionProbe.installedBundleDigest, receipt.extensionProbe.bundleDigest);
      assert.equal(receipt.extensionProbe.installedBundleFileCount, receipt.extensionProbe.bundleFileCount);
      assert.equal(receipt.extensionProbe.installedBundleBytes, receipt.extensionProbe.bundleBytes);
      assert.ok(receipt.extensionProbe.bundleFileCount > 100);
    }
  }
});

test("Tier 1 conformance fails closed on a mismatched package version or rejected extension", async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "sbw-host-probe-failures-"));
  const codex = path.join(bin, "codex");
  await writeFile(codex, "#!/bin/sh\nprintf 'codex-cli 0.149.0\\n'\n");
  await chmod(codex, 0o755);
  const wrongVersion = await hostConformance({ hostId: "codex", osId: "macos", env: { PATH: bin } });
  assert.equal(wrongVersion.result, "FAIL");
  assert.equal(wrongVersion.versionProbe.reason, "host-version-output-does-not-match-pinned-package");

  const claude = path.join(bin, "claude");
  await writeFile(claude, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then printf '2.1.247 (Claude Code)\\n'; exit 0; fi",
    "printf 'invalid plugin\\n' >&2",
    "exit 7"
  ].join("\n"));
  await chmod(claude, 0o755);
  const rejectedExtension = await hostConformance({ hostId: "claude-code", osId: "linux", env: { PATH: bin } });
  assert.equal(rejectedExtension.result, "FAIL");
  assert.equal(rejectedExtension.extensionProbe.result, "FAIL");
  assert.match(rejectedExtension.extensionProbe.reason, /Host extension probe claude-code (?:primary )?failed/);
});

test("installed extension conformance rejects helper drift after a successful host install", async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "sbw-host-installed-drift-"));
  const qwen = path.join(bin, "qwen");
  await writeFile(qwen, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then printf '0.22.2\\n'; exit 0; fi",
    "if [ \"$1\" = \"extensions\" ] && [ \"$2\" = \"install\" ]; then",
    "  mkdir -p \"$HOME/.qwen/extensions/better-workflows\"",
    "  cp -R \"$3/.\" \"$HOME/.qwen/extensions/better-workflows\"",
    "  printf 'drifted helper\\n' > \"$HOME/.qwen/extensions/better-workflows/plugins/better-workflows/scripts/sbw.mjs\"",
    "  exit 0",
    "fi",
    "exit 9"
  ].join("\n"));
  await chmod(qwen, 0o755);
  const receipt = await hostConformance({ hostId: "qwen-code", osId: "linux", env: { PATH: bin } });
  assert.equal(receipt.result, "FAIL");
  assert.match(receipt.extensionProbe.reason, /Installed host helper differs from the source-bound helper/);
});

test("installed extension conformance rejects an incomplete runtime bundle", async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "sbw-host-installed-omission-"));
  const qwen = path.join(bin, "qwen");
  await writeFile(qwen, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then printf '0.22.2\\n'; exit 0; fi",
    "if [ \"$1\" = \"extensions\" ] && [ \"$2\" = \"install\" ]; then",
    "  mkdir -p \"$HOME/.qwen/extensions/better-workflows\"",
    "  cp -R \"$3/.\" \"$HOME/.qwen/extensions/better-workflows\"",
    "  rm \"$HOME/.qwen/extensions/better-workflows/plugins/better-workflows/config/task-worktree-v1.json\"",
    "  exit 0",
    "fi",
    "exit 9"
  ].join("\n"));
  await chmod(qwen, 0o755);
  const receipt = await hostConformance({ hostId: "qwen-code", osId: "linux", env: { PATH: bin } });
  assert.equal(receipt.result, "FAIL");
  assert.match(receipt.extensionProbe.reason, /Installed host bundle differs from the complete source-bound distribution/);
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

test("host registry cannot replace an official v4 package or conformance probe", async () => {
  const source = await loadHostSupportRegistry();
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-host-contract-registry-"));
  const registryPath = path.join(directory, "registry.json");
  const packageDrift = structuredClone(source);
  packageDrift.hosts.find((host) => host.id === "gemini-cli").conformancePackage.name = "@example/fake-gemini";
  await writeFile(registryPath, `${JSON.stringify(packageDrift)}\n`);
  await assert.rejects(loadHostSupportRegistry({ registryPath }), /release contract drifted: gemini-cli/);

  const probeDrift = structuredClone(source);
  probeDrift.hosts.find((host) => host.id === "qwen-code").conformanceProbe.arguments = ["--version", "{distributionRoot}"];
  await writeFile(registryPath, `${JSON.stringify(probeDrift)}\n`);
  await assert.rejects(loadHostSupportRegistry({ registryPath }), /release contract drifted: qwen-code/);
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

test("every Tier 1 bridge has a version-aligned manifest and a real non-symlink component", async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "sbw-tier1-host-bin-"));
  const commands = new Map([
    ["codex", "codex"],
    ["claude-code", "claude"],
    ["gemini-cli", "gemini"],
    ["qwen-code", "qwen"]
  ]);
  for (const command of commands.values()) {
    const executable = path.join(bin, command);
    await writeFile(executable, `#!/bin/sh\nprintf '${command}-test 4.0.0\\n'\n`);
    await chmod(executable, 0o755);
  }
  for (const [hostId] of commands) {
    const doctor = await hostDoctor({ hostId, osId: "linux", env: { PATH: bin } });
    assert.equal(doctor.ok, true, `${hostId}: ${doctor.blockers.join(", ")}`);
    assert.equal(doctor.manifest.version.startsWith("4.0.0"), true, hostId);
  }
});
