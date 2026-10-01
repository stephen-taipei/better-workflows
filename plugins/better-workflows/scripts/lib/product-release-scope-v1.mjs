// SPDX-License-Identifier: AGPL-3.0-only
// Release selection only. A scope digest is never execution or release authority.
import { lstat, readFile, readdir } from "node:fs/promises";
import { digestObject } from "./core.mjs";
import { releaseConformanceMatrix } from "./hosts.mjs";
import {
  PRODUCT_RC_ADMISSION_UNAVAILABLE,
  PRODUCT_RC_MANUAL_OPERATOR_PROCEDURE_REQUIRED,
  PRODUCT_RELEASE_CHANNEL_CONTRACT_V1,
  assertProductReleaseTargetManifestV1
} from "./product-release-channel-v1.mjs";

const VERSION_URL = new URL("../../config/version-manifest-v1.json", import.meta.url);
const SCOPE_URL = new URL("../../config/product-release-scope-v1.json", import.meta.url);
const CHANNEL_URL = new URL("../../config/product-release-channel-v1.json", import.meta.url);
const CATALOG_URL = new URL("../../config/entrypoint-catalog.json", import.meta.url);
const TEMPLATES_URL = new URL("../../templates/", import.meta.url);
const SKILLS_URL = new URL("../../skills/", import.meta.url);
const AUTO_SKILL_URL = new URL("../../skills/auto/", import.meta.url);
const CLAUDE_MARKETPLACE_URL = new URL("../../../../.claude-plugin/marketplace.json", import.meta.url);
const CLAUDE_PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
// The owner deferred claude-code qualification to V5.1 on 2026-09-28.
const V5_HOST_IDS = ["codex", "gemini-cli", "qwen-code"];

export async function inspectPublicDirectoryEntries(url) {
  let before;
  try {
    before = await lstat(url, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) return { entries: [], stable: false };
    const entries = await readdir(url, { withFileTypes: true });
    const after = await lstat(url, { bigint: true });
    return {
      entries,
      stable: after.isDirectory() && !after.isSymbolicLink() &&
        before.dev === after.dev && before.ino === after.ino &&
        before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { entries: [], stable: false };
    throw error;
  }
}

export async function productReleaseScope() {
  const manifest = JSON.parse(await readFile(VERSION_URL, "utf8"));
  const { version } = manifest;
  // Keep the V4 host registry and its historical eight-combination contract.
  if (typeof version === "string" && /^4\.\d+\.\d+$/.test(version)) return { version, scope: null, scopeDigest: null };
  const releaseTarget = assertProductReleaseTargetManifestV1(manifest);
  const channelContract = JSON.parse(await readFile(CHANNEL_URL, "utf8"));
  if (digestObject(channelContract) !== digestObject(PRODUCT_RELEASE_CHANNEL_CONTRACT_V1)) {
    throw new Error("Product release channels differ from the accepted RC/GA contract");
  }
  const scope = JSON.parse(await readFile(SCOPE_URL, "utf8"));
  const expected = {
    schemaVersion: 1,
    kind: "ProductReleaseScopeV1",
    id: "v5.0-rc1-macos-auto-bilingual-20261002-r1",
    productVersion: "5.0.0",
    publicEntrypointIds: ["auto"],
    publicTemplateIds: ["auto"],
    publicSkillIds: ["auto"],
    publicLocaleIds: ["en", "zh-Hant-TW"],
    deferredLocaleReleaseTag: "V5.0.rc2",
    hostIds: V5_HOST_IDS,
    hostOsIds: ["macos"],
    runtimeLanes: [{ platform: "darwin", nodeMajor: 22 }, { platform: "darwin", nodeMajor: 24 }],
    deferredPlatforms: ["linux", "win32"],
    deferredUntil: "5.1.0"
  };
  if (digestObject(scope) !== digestObject(expected)) {
    throw new Error("Product release scope differs from the accepted V5.0 macOS contract");
  }
  if (releaseTarget.productReleaseScopeId !== scope.id) {
    throw new Error("Product release channel target differs from the accepted source scope ID");
  }
  return { version, scope, scopeDigest: digestObject(scope), releaseTarget };
}

export async function productReleaseConformanceMatrix() {
  const { scope } = await productReleaseScope();
  const legacy = await releaseConformanceMatrix();
  if (!scope) return legacy;
  const matrix = legacy.filter((entry) => scope.hostIds.includes(entry.hostId) && scope.hostOsIds.includes(entry.osId));
  const expected = scope.hostIds.flatMap((hostId) => scope.hostOsIds.map((osId) => `${hostId}/${osId}`)).sort();
  const actual = matrix.map((entry) => `${entry.hostId}/${entry.osId}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Product release host combinations are missing or duplicated");
  }
  return matrix;
}

// Filesystem inventory is an early source check. The release publisher must
// additionally compare the exact tag tree and all produced artifacts.
export async function inspectProductPublicSurface() {
  const { scope } = await productReleaseScope();
  if (!scope) return { applicable: false, matches: true };
  const [templates, skills, catalogBytes, claudeMarketplacePresent, claudePluginManifestPresent] = await Promise.all([
    inspectPublicDirectoryEntries(TEMPLATES_URL),
    inspectPublicDirectoryEntries(SKILLS_URL),
    readFile(CATALOG_URL, "utf8"),
    lstat(CLAUDE_MARKETPLACE_URL).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    }),
    lstat(CLAUDE_PLUGIN_MANIFEST_URL).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    })
  ]);
  const autoSkill = skills.entries.find((entry) => entry.name === "auto" && entry.isDirectory())
    ? await inspectPublicDirectoryEntries(AUTO_SKILL_URL)
    : { entries: [], stable: false };
  const catalog = JSON.parse(catalogBytes);
  const actual = {
    templateFiles: templates.entries.map((entry) => entry.name).sort(),
    skillDirectories: skills.entries.map((entry) => entry.name).sort(),
    autoSkillFiles: autoSkill.entries.map((entry) => entry.name).sort(),
    entrypointIds: Array.isArray(catalog.skills)
      ? catalog.skills.map((entry) => entry.id).sort()
      : null,
    autoEntrypointTemplate: catalog.skills?.find((entry) => entry.id === "auto")?.template ?? null,
    claudeMarketplacePresent,
    claudePluginManifestPresent,
    entriesAreRegular: templates.stable && skills.stable && autoSkill.stable &&
      templates.entries.every((entry) => entry.isFile()) &&
      skills.entries.every((entry) => entry.isDirectory()) &&
      autoSkill.entries.every((entry) => entry.isFile())
  };
  const expected = {
    templateFiles: scope.publicTemplateIds.map((id) => `${id}.json`).sort(),
    skillDirectories: [...scope.publicSkillIds].sort(),
    autoSkillFiles: ["SKILL.md"],
    entrypointIds: [...scope.publicEntrypointIds].sort(),
    autoEntrypointTemplate: "auto",
    claudeMarketplacePresent: false,
    claudePluginManifestPresent: false,
    entriesAreRegular: true
  };
  return {
    applicable: true,
    matches: digestObject(actual) === digestObject(expected),
    expected,
    actual
  };
}

// V4's publisher cannot establish the additional V5 admission requirements.
// Keep this closed until actual verifier/producer integration replaces it; an
// environment variable, receipt-shaped JSON, or caller PASS cannot unlock it.
export async function assertProductStableAdmissionAvailable() {
  const { scope } = await productReleaseScope();
  if (scope) {
    const surface = await inspectProductPublicSurface();
    const reason = surface.matches
      ? "authenticated macOS runtime qualification, formal review, maintained-document disposition, canary, and publication-operation admission are not integrated"
      : "the source still contains non-public templates, skills, entrypoints, or a deferred host installation descriptor";
    const error = new Error(`V5 stable publication HOLD: ${reason}`);
    error.code = "V5_STABLE_ADMISSION_UNAVAILABLE";
    throw error;
  }
}

// RC1 uses the explicitly adopted owner-controlled manual procedure outside
// this installed CLI. No caller receipt, locator or env flag may turn it into
// INSTALLED_CURRENT. Other RC versions retain the protected installed route.
export async function assertProductRcAdmissionAvailable(request = undefined) {
  const { scope, releaseTarget } = await productReleaseScope();
  if (!scope || releaseTarget?.channel !== "rc") {
    const error = new Error("V5 RC admission requires the manifest's exact controlled RC version");
    error.code = "V5_RC_RELEASE_TARGET_REQUIRED";
    throw error;
  }
  if (releaseTarget.publicationMode === "OWNER_CONTROLLED_MANUAL") {
    const error = new Error("V5 RC1 publication requires the owner-controlled manual procedure and its durable exact operation record; this installed CLI cannot authorize or execute it");
    error.code = PRODUCT_RC_MANUAL_OPERATOR_PROCEDURE_REQUIRED;
    error.status = "HOLD";
    throw error;
  }
  if (request !== undefined) {
    const { runInstalledProductRcPublicationV1 } = await import("./rc-publication-publisher-v1.mjs");
    return runInstalledProductRcPublicationV1(request);
  }
  const surface = await inspectProductPublicSurface();
  const reason = surface.matches
    ? "this legacy invocation has no authenticated installed RC operation locator"
    : "the source still contains non-public templates, skills, entrypoints, or a deferred host installation descriptor";
  const error = new Error(`V5 RC publication HOLD: ${reason}`);
  error.code = PRODUCT_RC_ADMISSION_UNAVAILABLE;
  throw error;
}

// The selected version determines which still-closed gate is required. Calling
// the stable gate directly remains closed for every V5 target, including RC.
export async function assertProductReleaseAdmissionAvailable(request = undefined) {
  const { releaseTarget } = await productReleaseScope();
  return releaseTarget?.channel === "rc"
    ? assertProductRcAdmissionAvailable(request)
    : assertProductStableAdmissionAvailable();
}
