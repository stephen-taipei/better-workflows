// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCodexInstallSmokeReceiptV1, inspectCodexPublicBundleV1, runCodexInstallSmokeV1 } from "../lib/codex-install-smoke-v1.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

async function fakeCodex(t, { extraPrivateTemplate = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-fake-codex-install-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "codex.mjs");
  const source = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const repository = process.cwd();
const plugin = path.join(repository, "plugins", "better-workflows");
const manifest = JSON.parse(fs.readFileSync(path.join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
const installedPath = path.join(process.env.CODEX_HOME, "plugins", "cache", "better-workflows", "better-workflows", manifest.version);
if (args.join(" ") === "--version") {
  process.stdout.write("codex-cli 0.150.1\\n");
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
  process.stdout.write(JSON.stringify({ marketplaceName: "better-workflows", installedRoot: args[3], alreadyAdded: false }));
} else if (args[0] === "plugin" && args[1] === "add") {
  fs.mkdirSync(path.dirname(installedPath), { recursive: true });
  fs.cpSync(plugin, installedPath, { recursive: true });
  if (${JSON.stringify(extraPrivateTemplate)}) {
    fs.writeFileSync(path.join(installedPath, "templates", "private.json"), "{}\\n");
  }
  process.stdout.write(JSON.stringify({ pluginId: "better-workflows@better-workflows", version: manifest.version, installedPath }));
} else if (args[0] === "plugin" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ installed: [{ pluginId: "better-workflows@better-workflows", version: manifest.version, installed: true, enabled: true }] }));
} else {
  process.stderr.write("unsupported fake Codex command\\n");
  process.exitCode = 2;
}
`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

test("isolated Codex installation binds the complete Auto-only bundle", async (t) => {
  const codexExecutable = await fakeCodex(t);
  const receipt = await runCodexInstallSmokeV1({ repositoryRoot, codexExecutable });
  assert.equal(receipt.result, "PASS");
  assert.equal(receipt.codexVersion, "codex-cli 0.150.1");
  assert.equal(receipt.sourceBundleDigest, receipt.installedBundleDigest);
  assert.deepEqual(receipt.installedCliTemplateIds, ["auto"]);
  assert.ok(receipt.bundleFileCount > 100);
  assert.equal(receipt.releaseAuthority, "none");
  const { source, manifest } = await inspectCodexPublicBundleV1(repositoryRoot);
  const pinned = { source, manifest, codexVersion: "codex-cli 0.150.1", nodeVersion: process.versions.node };
  assert.equal(assertCodexInstallSmokeReceiptV1(receipt, pinned), source.digest);
  assert.throws(() => assertCodexInstallSmokeReceiptV1(null, pinned), /pinned CLI and exact public Auto bundle/);
  for (const changed of [
    { ...receipt, nodeVersion: "0.0.0" },
    { ...receipt, pluginVersion: "0.0.0" },
    { ...receipt, sourceBundleDigest: "0".repeat(64) },
    { ...receipt, installedBundleDigest: "0".repeat(64) },
    { ...receipt, bundleFileCount: receipt.bundleFileCount - 1 },
    { ...receipt, installedCliTemplateIds: [] },
    { ...receipt, installedCliTemplateIds: ["auto", "private"] },
    { ...receipt, codexVersion: "codex-cli 0.156.1" },
    { ...receipt, releaseAuthority: "stable" },
    { ...receipt, extra: true }
  ]) {
    assert.throws(() => assertCodexInstallSmokeReceiptV1(changed, pinned), /pinned CLI and exact public Auto bundle/);
  }
});

test("isolated Codex installation rejects an added private template", async (t) => {
  const codexExecutable = await fakeCodex(t, { extraPrivateTemplate: true });
  let failure;
  try {
    await runCodexInstallSmokeV1({ repositoryRoot, codexExecutable });
  } catch (error) {
    failure = error;
  }
  if (typeof failure?.inspectionRoot === "string") {
    t.after(async () => rm(failure.inspectionRoot, { recursive: true, force: true }));
  }
  assert.equal(failure?.code, "ECODEX_INSTALL_SMOKE");
  assert.match(failure.cause?.message ?? "", /not exactly Auto/);
  assert.ok(failure.inspectionRoot?.startsWith(await realpath(os.tmpdir())));
});

test("isolated Codex installation rejects a plugin path symlink", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "sbw-codex-symlink-source-"));
  t.after(async () => rm(repository, { recursive: true, force: true }));
  await mkdir(path.join(repository, ".agents", "plugins"), { recursive: true });
  await mkdir(path.join(repository, "plugins"));
  await writeFile(
    path.join(repository, ".agents", "plugins", "marketplace.json"),
    await readFile(path.join(repositoryRoot, ".agents", "plugins", "marketplace.json"))
  );
  await symlink(path.join(repositoryRoot, "plugins", "better-workflows"), path.join(repository, "plugins", "better-workflows"));
  await assert.rejects(
    runCodexInstallSmokeV1({ repositoryRoot: repository, codexExecutable: process.execPath }),
    /source path contains a symlink/
  );
});
