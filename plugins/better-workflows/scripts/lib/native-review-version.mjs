import assert from "node:assert/strict";

// Keep the native bridge fail-closed while allowing the current Codex CLI
// protocol revision.  A host upgrade must be explicitly admitted here before
// it can participate in a governed review; arbitrary version drift is never
// accepted implicitly.
export const SUPPORTED_CODEX_VERSIONS = Object.freeze(["0.153.4", "0.154.0", "0.155.0", "0.156.1"]);

const VERSION_PATTERN = /\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/;

export function parseCodexVersion(userAgent) {
  return String(userAgent ?? "").match(VERSION_PATTERN)?.[0] ?? null;
}

export function requireSupportedCodexVersion(userAgent) {
  const version = parseCodexVersion(userAgent);
  assert(version && SUPPORTED_CODEX_VERSIONS.includes(version),
    `Unsupported Codex app-server version: ${userAgent ?? "unknown"}`);
  return version;
}
