import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../config/autonomy/bounded-autopilot-v1.json"
);
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const PROFILE_ID = "bounded-autopilot-v1";
const CANONICAL_LIMITS = Object.freeze({
  maxFiles: 80,
  maxDiffBytes: 262144,
  maxDurationSeconds: 28800,
  maxCommits: 12,
  maxPullRequests: 1
});

export const AUTONOMY_PROFILE_ID = PROFILE_ID;
export const AUTONOMY_AUTO_ACTIONS = Object.freeze([
  "read",
  "test",
  "evaluator.replay",
  "git.commit",
  "plugin.cache.publish",
  "git.push.codex",
  "pr.create.dev"
]);
export const AUTONOMY_HUMAN_ACTIONS = Object.freeze([
  "host.bootstrap",
  "host.upgrade",
  "host.revoke",
  "pr.merge",
  "deploy",
  "git.push.dev",
  "git.push.main",
  "worktree.cleanup"
]);
export const AUTONOMY_DENIED_ACTIONS = Object.freeze([
  "password.capture",
  "sudo.unbounded",
  "admin.bypass",
  "shell.unpinned"
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function autonomyProfileDigest(profile) {
  return createHash("sha256").update(canonical(profile)).digest("hex");
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !SAFE_ID.test(item))) {
    throw new Error(`${label} must contain safe action identifiers`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
}

function validatePathScope(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  for (const item of value) {
    if (typeof item !== "string" || !item || item.startsWith("/") || item.startsWith(":") || item.includes("//") ||
        item.endsWith("/") || /[*?\[\]]/.test(item) || item.split("/").some((segment) => segment === ".." || (segment === "." && item !== "."))) {
      throw new Error(`${label} contains a non-literal relative path`);
    }
  }
}

export function validateAutonomyProfile(profile) {
  assertPlainObject(profile, "Autonomy profile");
  if (profile.schemaVersion !== 1) throw new Error("Autonomy profile schemaVersion must be 1");
  if (profile.id !== PROFILE_ID) throw new Error(`Unsupported autonomy profile: ${profile.id ?? "missing"}`);
  assertStringArray(profile.autoActions, "Autonomy profile autoActions");
  assertStringArray(profile.humanActions, "Autonomy profile humanActions");
  assertStringArray(profile.deniedActions, "Autonomy profile deniedActions");
  const auto = new Set(profile.autoActions);
  const human = new Set(profile.humanActions);
  const denied = new Set(profile.deniedActions);
  for (const action of auto) if (human.has(action) || denied.has(action)) throw new Error(`Autonomy action overlaps: ${action}`);
  for (const action of human) if (denied.has(action)) throw new Error(`Autonomy action overlaps: ${action}`);
  if (JSON.stringify(profile.autoActions) !== JSON.stringify(AUTONOMY_AUTO_ACTIONS)) throw new Error("Autonomy profile autoActions are not canonical");
  if (JSON.stringify(profile.humanActions) !== JSON.stringify(AUTONOMY_HUMAN_ACTIONS)) throw new Error("Autonomy profile humanActions are not canonical");
  if (JSON.stringify(profile.deniedActions) !== JSON.stringify(AUTONOMY_DENIED_ACTIONS)) throw new Error("Autonomy profile deniedActions are not canonical");
  assertPlainObject(profile.scope, "Autonomy profile scope");
  if (profile.scope.localBranchPattern !== "^codex/[A-Za-z0-9._/-]+$" || profile.scope.remoteBranchPattern !== "^codex/[A-Za-z0-9._/-]+$") {
    throw new Error("Autonomy profile branch bounds are not canonical");
  }
  if (profile.scope.pullRequestBase !== "dev" || profile.scope.maxPullRequests !== 1) throw new Error("Autonomy profile PR bounds are not canonical");
  assertPlainObject(profile.limits, "Autonomy profile limits");
  for (const key of Object.keys(CANONICAL_LIMITS)) {
    if (!Number.isInteger(profile.limits[key]) || profile.limits[key] !== CANONICAL_LIMITS[key]) {
      throw new Error(`Autonomy profile limit is not canonical: ${key}`);
    }
  }
  return profile;
}

export async function loadAutonomyProfile() {
  const profile = JSON.parse(await readFile(PROFILE_PATH, "utf8"));
  validateAutonomyProfile(profile);
  return profile;
}

export function autonomyProfilePath() {
  return PROFILE_PATH;
}

export function buildAutonomyBinding(profile, {
  expiresAt = null,
  repository = null,
  branch = null,
  pathScope = ["."]
} = {}) {
  validateAutonomyProfile(profile);
  const expiry = expiresAt ?? new Date(Date.now() + profile.limits.maxDurationSeconds * 1000).toISOString();
  const expiryMs = Date.parse(expiry);
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now() || expiryMs - Date.now() > profile.limits.maxDurationSeconds * 1000) {
    throw new Error("Autonomy profile expiry must be in the future and within the bounded duration");
  }
  if (repository !== null && (typeof repository !== "string" || !/^github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository))) {
    throw new Error("Autonomy binding repository identity is invalid");
  }
  if (branch !== null && (typeof branch !== "string" || !/^codex\/[A-Za-z0-9._/-]+$/.test(branch))) {
    throw new Error("Autonomy binding branch is outside the codex scope");
  }
  validatePathScope(pathScope, "Autonomy binding path scope");
  return {
    schemaVersion: 1,
    id: profile.id,
    profileDigest: autonomyProfileDigest(profile),
    selectedAt: new Date().toISOString(),
    expiresAt: expiry,
    repository,
    branch,
    pathScope: [...pathScope].map(String).sort(),
    scope: {
      localBranchPattern: profile.scope.localBranchPattern,
      remoteBranchPattern: profile.scope.remoteBranchPattern,
      pullRequestBase: profile.scope.pullRequestBase,
      maxPullRequests: profile.scope.maxPullRequests
    },
    limits: { ...profile.limits }
  };
}

export function validateAutonomyBinding(binding) {
  assertPlainObject(binding, "TaskContract autonomyProfile");
  if (binding.schemaVersion !== 1 || binding.id !== PROFILE_ID || !SHA256.test(binding.profileDigest ?? "")) {
    throw new Error("TaskContract autonomyProfile binding is invalid");
  }
  const expiryMs = Date.parse(binding.expiresAt);
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now() || expiryMs - Date.now() > CANONICAL_LIMITS.maxDurationSeconds * 1000) {
    throw new Error("TaskContract autonomyProfile has expired or exceeds the bounded duration");
  }
  if (binding.repository !== null && (typeof binding.repository !== "string" || !/^github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(binding.repository))) {
    throw new Error("TaskContract autonomyProfile repository identity is invalid");
  }
  if (binding.branch !== null && (typeof binding.branch !== "string" || !/^codex\/[A-Za-z0-9._/-]+$/.test(binding.branch))) {
    throw new Error("TaskContract autonomyProfile branch is invalid");
  }
  validatePathScope(binding.pathScope, "TaskContract autonomyProfile path scope");
  assertPlainObject(binding.scope, "TaskContract autonomyProfile.scope");
  if (binding.scope.localBranchPattern !== "^codex/[A-Za-z0-9._/-]+$" ||
      binding.scope.remoteBranchPattern !== "^codex/[A-Za-z0-9._/-]+$" ||
      binding.scope.pullRequestBase !== "dev" || binding.scope.maxPullRequests !== 1) {
    throw new Error("TaskContract autonomyProfile scope is invalid");
  }
  assertPlainObject(binding.limits, "TaskContract autonomyProfile.limits");
  for (const key of Object.keys(CANONICAL_LIMITS)) {
    if (binding.limits[key] !== CANONICAL_LIMITS[key]) throw new Error(`TaskContract autonomyProfile limit is invalid: ${key}`);
  }
  return binding;
}

function branchFromResource(resource) {
  const match = /^remote:[A-Za-z0-9._-]+:refs\/heads\/(.+)$/.exec(String(resource ?? ""));
  return match?.[1] ?? null;
}

export function classifyAutonomyAction(action, { resource = "", scope = "" } = {}) {
  if (action === "git.push") {
    const branch = branchFromResource(resource) ?? String(scope);
    if (branch === "dev") return "git.push.dev";
    if (branch === "main") return "git.push.main";
    return /^codex\/[A-Za-z0-9._/-]+$/.test(branch) ? "git.push.codex" : "git.push.other";
  }
  if (action === "pr.create") return String(scope) === "dev" ? "pr.create.dev" : "pr.create.other";
  return action;
}

export function decideAutonomyAction(profile, action, context = {}) {
  validateAutonomyProfile(profile);
  const classified = classifyAutonomyAction(action, context);
  if (profile.deniedActions.includes(classified) || profile.deniedActions.includes(action)) {
    return { decision: "denied", action, classifiedAction: classified, reason: "action-denied-by-profile" };
  }
  if (classified === "git.push.other" || classified === "pr.create.other") {
    return { decision: "requires-human", action, classifiedAction: classified, reason: "target-outside-profile" };
  }
  if (profile.autoActions.includes(classified) || profile.autoActions.includes(action)) {
    return { decision: "auto-approved", action, classifiedAction: classified, reason: "within-bounded-autopilot" };
  }
  if (profile.humanActions.includes(classified) || profile.humanActions.includes(action)) {
    return { decision: "requires-human", action, classifiedAction: classified, reason: "high-risk-action" };
  }
  return { decision: "denied", action, classifiedAction: classified, reason: "action-not-in-profile" };
}

export function assertAutonomyAction(profile, action, context = {}) {
  const decision = decideAutonomyAction(profile, action, context);
  if (decision.decision === "auto-approved") return decision;
  const prefix = decision.decision === "requires-human" ? "Autonomy policy requires human approval" : "Autonomy policy denied";
  throw new Error(`${prefix} for ${action}: ${decision.reason}`);
}

export function buildAutonomyDecisionReceipt({
  runId,
  binding,
  sourceBindingDigest = null,
  request,
  decision,
  tokenHash = null
}) {
  validateAutonomyBinding(binding);
  if (typeof runId !== "string" || !runId) throw new Error("Autonomy decision receipt runId is required");
  if (tokenHash !== null && (typeof tokenHash !== "string" || !SHA256.test(tokenHash))) {
    throw new Error("Autonomy decision receipt tokenHash is invalid");
  }
  if (!decision || !["auto-approved", "requires-human", "denied"].includes(decision.decision)) {
    throw new Error("Autonomy decision receipt decision is invalid");
  }
  const receipt = {
    schemaVersion: 1,
    kind: "autonomy-decision",
    runId,
    profileId: binding.id,
    profileDigest: binding.profileDigest,
    sourceBindingDigest,
    expiresAt: binding.expiresAt,
    action: request.action,
    classifiedAction: decision.classifiedAction,
    decision: decision.decision,
    reason: decision.reason,
    resource: request.resource,
    scope: request.scope ?? request.resource,
    tokenHash
  };
  return {
    ...receipt,
    decisionId: createHash("sha256").update(canonical(receipt)).digest("hex")
  };
}

export function validateAutonomyScope(binding, { branch = null, targetBase = null } = {}) {
  validateAutonomyBinding(binding);
  if (branch !== null && (!BRANCH.test(branch) || !new RegExp(binding.scope.remoteBranchPattern).test(branch))) {
    throw new Error("Autonomy policy branch scope is invalid");
  }
  if (targetBase !== null && targetBase !== binding.scope.pullRequestBase) {
    throw new Error("Autonomy policy PR base is invalid");
  }
}
