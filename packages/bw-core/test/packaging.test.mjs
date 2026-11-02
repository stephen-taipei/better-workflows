import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const commands = (config) => Object.values(config.hooks).flat().flatMap((group) => group.hooks.map((hook) => hook.command));

// Codex CLI 0.166.0 reads a root plugin.json before .codex-plugin/plugin.json.
// A root manifest with the Agent Plugins $schema loaded no hooks at all; one
// without it fell through to hooks/hooks.json and ran the Claude Code adapter.
test("Codex reads its own manifest and hook file", () => {
  assert.equal(existsSync(path.join(root, "plugin.json")), false, "a root plugin.json would take precedence over .codex-plugin/plugin.json in Codex");
  const manifest = read(".codex-plugin/plugin.json");
  const pkg = read("package.json");
  assert.equal(manifest.name, read(".claude-plugin/plugin.json").name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.hooks, "./hooks/codex.json");
  assert.ok(pkg.files.includes(".codex-plugin"), "package.json files must ship .codex-plugin");
  assert.ok(!pkg.files.includes("plugin.json"));

  const codex = read("hooks/codex.json");
  assert.deepEqual(Object.keys(codex.hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "Stop"]);
  for (const command of commands(codex)) assert.equal(command, 'node "${PLUGIN_ROOT}/bin/bw.mjs" hook codex');
});

test("Claude Code keeps hooks/hooks.json with the Claude Code adapter only", () => {
  for (const command of commands(read("hooks/hooks.json"))) assert.equal(command, 'node "${CLAUDE_PLUGIN_ROOT}/bin/bw.mjs" hook claude-code');
});
