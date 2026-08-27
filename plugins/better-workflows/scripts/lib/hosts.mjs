import { constants as fsConstants } from "node:fs";
import { access, lstat, open, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteJson,
  digestObject,
  execBoundProcess,
  nowIso,
  pluginRoot,
  safeJoin,
  sha256
} from "./core.mjs";

const REGISTRY_PATH = path.join(pluginRoot(), "config", "host-support-v1.json");
const HOST_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUPPORT_TIERS = new Set(["tier1", "preview", "unsupported"]);
const CAPABILITY_STATUSES = new Set(["native", "core-bridge", "unavailable", "unverified"]);
const PLATFORM_TO_OS = new Map([
  ["darwin", "macos"],
  ["linux", "linux"],
  ["win32", "windows"]
]);
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function uniqueRecords(records, label) {
  const ids = new Set();
  for (const record of records) {
    if (!record || typeof record.id !== "string" || !HOST_ID.test(record.id)) {
      throw new Error(`${label} contains an invalid id`);
    }
    if (ids.has(record.id)) throw new Error(`${label} contains duplicate id: ${record.id}`);
    ids.add(record.id);
  }
  return ids;
}

function validateRegistry(registry) {
  exactKeys(
    registry,
    ["schemaVersion", "id", "recommended", "operatingSystems", "capabilityDefinitions", "hosts"],
    "Host support registry"
  );
  if (registry.schemaVersion !== 1 || registry.id !== "host-support-v1") {
    throw new Error("Host support registry identity is invalid");
  }
  if (!Array.isArray(registry.operatingSystems) || !Array.isArray(registry.capabilityDefinitions) || !Array.isArray(registry.hosts)) {
    throw new Error("Host support registry collections must be arrays");
  }
  const osIds = uniqueRecords(registry.operatingSystems, "operatingSystems");
  const capabilityIds = uniqueRecords(registry.capabilityDefinitions, "capabilityDefinitions");
  const hostIds = uniqueRecords(registry.hosts, "hosts");
  exactKeys(registry.recommended, ["hostId", "osId", "label", "reason"], "recommended");
  if (!hostIds.has(registry.recommended.hostId) || !osIds.has(registry.recommended.osId)) {
    throw new Error("Recommended host or operating system does not exist");
  }
  if (registry.recommended.hostId !== "codex" || registry.recommended.osId !== "macos") {
    throw new Error("host-support-v1 reference experience must remain macOS + Codex");
  }
  for (const operatingSystem of registry.operatingSystems) {
    exactKeys(operatingSystem, ["id", "displayName", "nodePlatform", "releaseStatus"], `operatingSystems.${operatingSystem.id}`);
    if (!SUPPORT_TIERS.has(operatingSystem.releaseStatus)) {
      throw new Error(`Invalid operating-system support tier: ${operatingSystem.id}`);
    }
    if (operatingSystem.id === "windows" && operatingSystem.releaseStatus === "tier1") {
      throw new Error("Windows must remain Preview for the v4.0.0 support contract");
    }
  }
  for (const capability of registry.capabilityDefinitions) {
    exactKeys(capability, ["id", "displayName"], `capabilityDefinitions.${capability.id}`);
  }
  for (const host of registry.hosts) {
    exactKeys(
      host,
      [
        "id",
        "displayName",
        "supportTier",
        "executable",
        "manifestPath",
        "extensionMechanism",
        "officialDocumentation",
        "osSupport",
        "capabilities",
        "limitations"
      ],
      `hosts.${host.id}`
    );
    if (!SUPPORT_TIERS.has(host.supportTier)) throw new Error(`Invalid support tier for ${host.id}`);
    if (typeof host.executable !== "string" || !host.executable || host.executable.includes(path.sep)) {
      throw new Error(`Host executable must be a command name: ${host.id}`);
    }
    if (host.manifestPath !== null && (typeof host.manifestPath !== "string" || path.isAbsolute(host.manifestPath) || host.manifestPath.includes(".."))) {
      throw new Error(`Host manifest path is unsafe: ${host.id}`);
    }
    exactKeys(host.osSupport, [...osIds], `hosts.${host.id}.osSupport`);
    for (const [osId, tier] of Object.entries(host.osSupport)) {
      if (!SUPPORT_TIERS.has(tier)) throw new Error(`Invalid ${host.id}/${osId} support tier`);
      if (osId === "windows" && tier === "tier1") throw new Error(`${host.id}/windows cannot be Tier 1 in v4.0.0`);
    }
    exactKeys(host.capabilities, [...capabilityIds], `hosts.${host.id}.capabilities`);
    for (const status of Object.values(host.capabilities)) {
      if (!CAPABILITY_STATUSES.has(status)) throw new Error(`Invalid capability status for ${host.id}`);
    }
    if (!Array.isArray(host.limitations) || host.limitations.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`Host limitations must be non-empty strings: ${host.id}`);
    }
  }
  const tierOneIds = registry.hosts.filter((host) => host.supportTier === "tier1").map((host) => host.id).sort();
  if (JSON.stringify(tierOneIds) !== JSON.stringify(["claude-code", "codex", "gemini-cli", "qwen-code"])) {
    throw new Error("v4.0.0 Tier 1 hosts must be Codex, Claude Code, Gemini CLI, and Qwen Code");
  }
  return registry;
}

export async function loadHostSupportRegistry({ registryPath = REGISTRY_PATH } = {}) {
  return validateRegistry(JSON.parse(await readFile(registryPath, "utf8")));
}

export function normalizeHostOs(platform = process.platform) {
  return PLATFORM_TO_OS.get(platform) ?? "unsupported";
}

function findHost(registry, hostId) {
  const host = registry.hosts.find((candidate) => candidate.id === hostId);
  if (!host) throw new Error(`Unknown Better Workflows host: ${hostId}`);
  return host;
}

function findOperatingSystem(registry, osId) {
  const operatingSystem = registry.operatingSystems.find((candidate) => candidate.id === osId);
  if (!operatingSystem) throw new Error(`Unknown Better Workflows operating system: ${osId}`);
  return operatingSystem;
}

async function executableIdentity(command, env = process.env) {
  const candidates = String(env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      const resolvedPath = await realpath(candidate);
      const info = await lstat(resolvedPath);
      if (!info.isFile() || info.size > MAX_EXECUTABLE_BYTES) continue;
      return {
        command,
        path: candidate,
        resolvedPath,
        size: info.size,
        mode: info.mode & 0o777,
        digest: sha256(await readFile(resolvedPath))
      };
    } catch {
      // Continue through PATH without invoking the candidate.
    }
  }
  return null;
}

async function manifestIdentity(host, root = pluginRoot()) {
  if (host.manifestPath === null) return null;
  const target = path.resolve(root, host.manifestPath);
  const relative = path.relative(path.resolve(root), target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Host manifest escapes plugin root: ${host.id}`);
  }
  const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 256 * 1024) {
      throw new Error(`Host manifest is unsafe: ${host.id}`);
    }
    const contents = await handle.readFile();
    return {
      path: target,
      digest: sha256(contents),
      manifest: JSON.parse(contents.toString("utf8"))
    };
  } finally {
    await handle.close();
  }
}

export async function hostList() {
  const registry = await loadHostSupportRegistry();
  return {
    schemaVersion: 1,
    registryId: registry.id,
    registryDigest: digestObject(registry),
    recommended: registry.recommended,
    operatingSystems: registry.operatingSystems,
    hosts: registry.hosts
  };
}

export async function hostDoctor({
  hostId = "codex",
  osId = normalizeHostOs(),
  env = process.env
} = {}) {
  const checkedAt = nowIso();
  const registry = await loadHostSupportRegistry();
  const host = findHost(registry, hostId);
  const operatingSystem = findOperatingSystem(registry, osId);
  const executable = await executableIdentity(host.executable, env);
  const manifest = await manifestIdentity(host);
  const supportTier = host.osSupport[osId];
  const blockers = [];
  if (!executable) blockers.push("host-executable-missing");
  if (host.manifestPath !== null && !manifest) blockers.push("host-manifest-missing");
  if (supportTier === "unsupported") blockers.push("host-os-unsupported");
  return {
    schemaVersion: 1,
    checkedAt,
    ok: blockers.length === 0,
    hostId,
    osId,
    supportTier,
    recommended: hostId === registry.recommended.hostId && osId === registry.recommended.osId,
    host,
    operatingSystem,
    executable,
    manifest: manifest ? { path: manifest.path, digest: manifest.digest, version: manifest.manifest.version ?? null } : null,
    blockers,
    registryDigest: digestObject(registry)
  };
}

async function versionProbe(executable) {
  if (!executable) return { ok: false, reason: "host-executable-missing" };
  const controlledPath = path.dirname(executable.resolvedPath);
  try {
    const result = await execBoundProcess(executable.resolvedPath, ["--version"], {
      cwd: os.tmpdir(),
      env: {
        PATH: controlledPath,
        HOME: "/var/empty",
        LANG: "C",
        LC_ALL: "C",
        NO_COLOR: "1",
        CI: "1"
      },
      timeoutMs: 10_000,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
      label: "Host version probe"
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(0, 512);
    return { ok: true, outputDigest: sha256(output), output };
  } catch (error) {
    return { ok: false, reason: String(error.message).slice(0, 512) };
  }
}

export async function hostConformance({
  hostId = "codex",
  osId = normalizeHostOs(),
  stateRoot = null,
  writeReceipt = false,
  env = process.env
} = {}) {
  const doctor = await hostDoctor({ hostId, osId, env });
  const registry = await loadHostSupportRegistry();
  const host = findHost(registry, hostId);
  const probe = await versionProbe(doctor.executable);
  const commonCapabilityIds = ["task-contract", "typed-evidence", "replay", "action-gate", "task-worktree"];
  const capabilities = commonCapabilityIds.map((capabilityId) => {
    const declared = host.capabilities[capabilityId];
    const passed = doctor.ok && probe.ok && (declared === "native" || declared === "core-bridge");
    return {
      id: capabilityId,
      declared,
      result: passed ? "PASS" : "FAIL",
      reason: passed ? "Host manifest, executable identity, and host-neutral core bridge are present" : doctor.blockers[0] ?? probe.reason ?? "capability unavailable"
    };
  });
  const payload = {
    schemaVersion: 1,
    kind: "HostCapabilityReceipt",
    producedAt: nowIso(),
    hostId,
    osId,
    supportTier: doctor.supportTier,
    registryId: registry.id,
    registryDigest: doctor.registryDigest,
    executable: doctor.executable,
    manifest: doctor.manifest,
    versionProbe: probe,
    capabilities,
    result: doctor.ok && probe.ok && capabilities.every((capability) => capability.result === "PASS") ? "PASS" : "FAIL",
    authentication: {
      status: "local-executable-binding",
      releaseEligible: false,
      requirement: "v4.0.0 release requires a CI/provider-authenticated envelope around this exact receipt digest"
    }
  };
  const receipt = { ...payload, receiptDigest: digestObject(payload) };
  let receiptPath = null;
  if (writeReceipt) {
    if (!stateRoot) throw new Error("Writing a conformance receipt requires a state root");
    receiptPath = safeJoin(stateRoot, "host-conformance", hostId, osId, `${receipt.receiptDigest}.json`);
    await atomicWriteJson(stateRoot, receiptPath, receipt);
  }
  return { ...receipt, receiptPath };
}

export async function releaseConformanceMatrix() {
  const registry = await loadHostSupportRegistry();
  return registry.hosts
    .filter((host) => host.supportTier === "tier1")
    .flatMap((host) => ["macos", "linux"].map((osId) => ({ hostId: host.id, osId })))
    .sort((left, right) => `${left.hostId}/${left.osId}`.localeCompare(`${right.hostId}/${right.osId}`, "en"));
}

export function renderHostSupportMarkdown(registry) {
  const tierOne = registry.hosts.filter((host) => host.supportTier === "tier1").map((host) => host.displayName).join(", ");
  const preview = registry.hosts.filter((host) => host.supportTier === "preview").map((host) => host.displayName).join(", ");
  return [
    "| Level | AI hosts | Operating systems | Promise |",
    "| --- | --- | --- | --- |",
    `| Recommended reference | **${registry.recommended.label}** | macOS | Deepest native integration and complete reference UX |`,
    `| Tier 1 | ${tierOne} | macOS, Linux | Shared core safety semantics; host-native UX may differ |`,
    `| Preview | ${preview} | macOS, Linux | Compatibility pack with published limitations |`,
    "| OS Preview | All listed hosts | Windows | Not covered by the v4.0.0 Tier 1 guarantee |"
  ].join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderHostSupportHtml(registry) {
  const rows = registry.hosts.map((host) => {
    const os = Object.entries(host.osSupport)
      .map(([osId, tier]) => `${osId}: ${tier}`)
      .join(" · ");
    const reference = host.id === registry.recommended.hostId ? " <strong>Recommended on macOS</strong>" : "";
    return `<tr><th scope="row">${escapeHtml(host.displayName)}${reference}</th><td>${escapeHtml(host.supportTier)}</td><td>${escapeHtml(os)}</td><td>${escapeHtml(host.extensionMechanism)}</td></tr>`;
  }).join("");
  return `<table class="support-matrix"><thead><tr><th>AI host</th><th>Support</th><th>OS coverage</th><th>Integration</th></tr></thead><tbody>${rows}</tbody></table>`;
}
