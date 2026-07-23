import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  open,
  readFile,
  readdir,
  realpath
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteJson,
  digestObject,
  ensurePrivateDir,
  getStateRoot,
  nowIso,
  pluginRoot,
  readJson,
  safeJoin,
  sha256
} from "./core.mjs";
import { inspectCachedDeliberationRoster } from "./deliberation.mjs";
import { bundleDigest } from "./publication.mjs";

const CATALOG_PATH = path.join(pluginRoot(), "config", "entrypoint-catalog.json");
const PROFILE_RELATIVE_PATH = path.join(".codex", "better-workflows.json");
const PROFILE_SCHEMA_VERSION = 1;
const RECEIPT_SCHEMA_VERSION = 1;
const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_PROFILE_RULES = 128;
const MAX_STRING_LENGTH = 512;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,191}$/;
const RECEIPT_ID = /^route-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/;
const ROUTE_MODES = ["direct", "verified", "deep", "critical"];
const MODE_RANK = new Map(ROUTE_MODES.map((mode, index) => [mode, index]));
const BLOCKING_CAPABILITY_STATES = new Set([
  "unavailable",
  "unverified",
  "unsupported",
  "requires-authority"
]);

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function assertContained(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root: ${target}`);
  }
  return resolvedTarget;
}

async function assertSafePath(root, target, { allowMissing = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = assertContained(resolvedRoot, target, "Path");
  let current = resolvedRoot;
  if (await pathExists(current)) {
    const rootInfo = await lstat(current);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error(`Unsafe root path: ${current}`);
    }
  } else if (allowMissing) {
    return false;
  } else {
    throw new Error(`Missing root path: ${current}`);
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!(await pathExists(current))) {
      if (allowMissing) return false;
      throw new Error(`Missing path: ${current}`);
    }
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink path component: ${current}`);
  }
  return true;
}

async function readSafeJson(root, target, { allowMissing = false } = {}) {
  if (!(await assertSafePath(root, target, { allowMissing }))) return null;
  const handle = await open(
    target,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Unsafe JSON path: ${target}`);
    if (info.size > MAX_PROFILE_BYTES) {
      throw new Error(`JSON file exceeds ${MAX_PROFILE_BYTES} bytes: ${target}`);
    }
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

function stringArray(value, label, { max = 128 } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} items`);
  const result = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${label} must contain non-empty strings`);
    const normalized = item.trim();
    if (normalized.length > MAX_STRING_LENGTH || normalized.includes("\0")) {
      throw new Error(`${label} contains an unsafe or overlong string`);
    }
    return normalized;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function validateRoute(route, label) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    throw new Error(`${label}.route must be an object`);
  }
  const unknownRouteKeys = Object.keys(route).filter(
    (key) => !["entry", "template", "minimumMode", "supportSkills", "requiredCapabilities"].includes(key)
  );
  if (unknownRouteKeys.length > 0) {
    throw new Error(`${label}.route has unknown keys: ${unknownRouteKeys.join(", ")}`);
  }
  const entry = route.entry == null ? null : String(route.entry);
  const template = route.template == null ? null : String(route.template);
  if (Boolean(entry) === Boolean(template)) {
    throw new Error(`${label}.route must define exactly one of entry or template`);
  }
  if (entry && !SAFE_ID.test(entry)) throw new Error(`${label}.route.entry is invalid`);
  if (template && !SAFE_ID.test(template)) throw new Error(`${label}.route.template is invalid`);
  const minimumMode = route.minimumMode == null ? null : String(route.minimumMode);
  if (minimumMode && !MODE_RANK.has(minimumMode)) {
    throw new Error(`${label}.route.minimumMode must be direct, verified, deep, or critical`);
  }
  const supportSkills = stringArray(route.supportSkills, `${label}.route.supportSkills`, { max: 3 });
  const requiredCapabilities = stringArray(
    route.requiredCapabilities,
    `${label}.route.requiredCapabilities`
  );
  for (const capability of requiredCapabilities) {
    if (!SAFE_CAPABILITY.test(capability) || !capability.includes(":")) {
      throw new Error(`${label}.route.requiredCapabilities contains an invalid capability`);
    }
  }
  return {
    entry,
    template,
    minimumMode,
    supportSkills,
    requiredCapabilities
  };
}

export function validateRoutingProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Routing Profile must be an object");
  }
  if (profile.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new Error(`Routing Profile schemaVersion must be ${PROFILE_SCHEMA_VERSION}`);
  }
  const unknownProfileKeys = Object.keys(profile).filter(
    (key) => !["schemaVersion", "rules"].includes(key)
  );
  if (unknownProfileKeys.length > 0) {
    throw new Error(`Routing Profile has unknown keys: ${unknownProfileKeys.join(", ")}`);
  }
  if (!Array.isArray(profile.rules) || profile.rules.length === 0) {
    throw new Error("Routing Profile rules must be a non-empty array");
  }
  if (profile.rules.length > MAX_PROFILE_RULES) {
    throw new Error(`Routing Profile exceeds ${MAX_PROFILE_RULES} rules`);
  }
  const ids = new Set();
  const rules = profile.rules.map((rule, index) => {
    const label = `rules[${index}]`;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`${label} must be an object`);
    }
    const unknownRuleKeys = Object.keys(rule).filter(
      (key) => !["id", "priority", "match", "route"].includes(key)
    );
    if (unknownRuleKeys.length > 0) {
      throw new Error(`${label} has unknown keys: ${unknownRuleKeys.join(", ")}`);
    }
    if (typeof rule.id !== "string" || !SAFE_ID.test(rule.id)) {
      throw new Error(`${label}.id is invalid`);
    }
    if (ids.has(rule.id)) throw new Error(`Duplicate routing rule id: ${rule.id}`);
    ids.add(rule.id);
    const priority = rule.priority ?? 0;
    if (!Number.isInteger(priority) || priority < -10_000 || priority > 10_000) {
      throw new Error(`${label}.priority must be an integer from -10000 to 10000`);
    }
    const match = rule.match ?? {};
    if (!match || typeof match !== "object" || Array.isArray(match)) {
      throw new Error(`${label}.match must be an object`);
    }
    const unknownMatchKeys = Object.keys(match).filter(
      (key) => !["keywords", "domains", "tags", "scopes"].includes(key)
    );
    if (unknownMatchKeys.length > 0) {
      throw new Error(`${label}.match has unknown keys: ${unknownMatchKeys.join(", ")}`);
    }
    return {
      id: rule.id,
      priority,
      match: {
        keywords: stringArray(match.keywords, `${label}.match.keywords`),
        domains: stringArray(match.domains, `${label}.match.domains`),
        tags: stringArray(match.tags, `${label}.match.tags`),
        scopes: stringArray(match.scopes, `${label}.match.scopes`)
      },
      route: validateRoute(rule.route, label)
    };
  });
  return { schemaVersion: PROFILE_SCHEMA_VERSION, rules };
}

export async function loadEntrypointCatalog() {
  const catalog = JSON.parse(await readFile(CATALOG_PATH, "utf8"));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.skills)) {
    throw new Error("Entrypoint catalog is invalid");
  }
  const ids = new Set();
  for (const entry of catalog.skills) {
    if (!entry || typeof entry.id !== "string" || !SAFE_ID.test(entry.id)) {
      throw new Error("Entrypoint catalog contains an invalid id");
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate entrypoint: ${entry.id}`);
    ids.add(entry.id);
  }
  return catalog;
}

async function loadTemplates() {
  const directory = path.join(pluginRoot(), "templates");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const templates = [];
  for (const name of names) {
    const value = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    if (value.name !== name.slice(0, -5)) throw new Error(`Template filename mismatch: ${name}`);
    templates.push(value);
  }
  return templates;
}

export async function pluginBundleDigest() {
  return bundleDigest(pluginRoot());
}

function codexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

function executableCandidates(command, env = process.env) {
  if (command === "node") return [process.execPath];
  if (command.includes(path.sep)) return [path.resolve(command)];
  return String(env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, command));
}

async function executablePath(command, env = process.env) {
  for (const candidate of executableCandidates(command, env)) {
    try {
      const info = await lstat(candidate);
      const resolvedPath = info.isSymbolicLink() ? await realpath(candidate) : candidate;
      const resolvedInfo = await lstat(resolvedPath);
      if (!resolvedInfo.isFile() || resolvedInfo.isSymbolicLink()) continue;
      await access(resolvedPath, fsConstants.X_OK);
      return { path: candidate, resolvedPath };
    } catch {
      // Continue through PATH candidates.
    }
  }
  return null;
}

async function fileFingerprint(target, { requireSingleLink = true } = {}) {
  const handle = await open(
    target,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || (requireSingleLink && info.nlink !== 1)) {
      throw new Error(`Unsafe capability file: ${target}`);
    }
    return {
      size: info.size,
      mode: info.mode & 0o777,
      digest: sha256(await handle.readFile())
    };
  } finally {
    await handle.close();
  }
}

async function installedSkillPath(skill, { cwd, env = process.env } = {}) {
  const shortName = skill.includes(":") ? skill.slice(skill.lastIndexOf(":") + 1) : skill;
  if (!SAFE_ID.test(shortName)) return null;
  const home = codexHome(env);
  const directCandidates = [
    path.join(pluginRoot(), "skills", shortName, "SKILL.md"),
    path.join(path.resolve(cwd), ".codex", "skills", shortName, "SKILL.md"),
    path.join(home, "skills", shortName, "SKILL.md"),
    path.join(os.homedir(), ".agents", "skills", shortName, "SKILL.md")
  ];
  for (const candidate of directCandidates) {
    try {
      const info = await lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return candidate;
    } catch {
      // Continue through bounded roots.
    }
  }
  const cacheRoot = path.join(home, "plugins", "cache");
  let marketplaces = [];
  try {
    marketplaces = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const marketplace of marketplaces.filter((entry) => entry.isDirectory()).slice(0, 64)) {
    const marketplaceRoot = path.join(cacheRoot, marketplace.name);
    const plugins = await readdir(marketplaceRoot, { withFileTypes: true }).catch(() => []);
    for (const plugin of plugins.filter((entry) => entry.isDirectory()).slice(0, 64)) {
      const pluginCacheRoot = path.join(marketplaceRoot, plugin.name);
      const versions = await readdir(pluginCacheRoot, { withFileTypes: true }).catch(() => []);
      for (const version of versions.filter((entry) => entry.isDirectory()).slice(0, 32)) {
        const candidate = path.join(pluginCacheRoot, version.name, "skills", shortName, "SKILL.md");
        try {
          const info = await lstat(candidate);
          if (info.isFile() && !info.isSymbolicLink()) return candidate;
        } catch {
          // Keep search bounded and read-only.
        }
      }
    }
  }
  return null;
}

function capabilityRecord(
  id,
  status,
  reason,
  source,
  checkedAt,
  fallback = null,
  fingerprint = null
) {
  return {
    id,
    status,
    reason,
    source: source ?? null,
    fingerprint,
    fallback,
    checkedAt
  };
}

async function cachedProviderRecords(requiredIds, checkedAt, stateRoot) {
  const requestedProviders = new Set(
    requiredIds
      .filter((id) => id.startsWith("provider:"))
      .map((id) => id.slice("provider:".length))
  );
  if (requestedProviders.size === 0) return new Map();
  const inspections = await Promise.all(
    ["medium", "high"].map((reasoningEffort) =>
      inspectCachedDeliberationRoster({ reasoningEffort, stateRoot }).catch((error) => ({
        cache: { status: "unavailable", reason: error.message },
        activeParticipants: [],
        unavailable: []
      }))
    )
  );
  const records = new Map();
  for (const provider of requestedProviders) {
    const active = inspections.flatMap((item) => item.activeParticipants ?? [])
      .filter((item) => item.provider === provider);
    const unavailable = inspections.flatMap((item) => item.unavailable ?? [])
      .filter((item) => item.provider === provider);
    const cacheHits = inspections.filter((item) => item.cache?.status === "hit");
    if (active.length > 0 && cacheHits.length > 0) {
      const fingerprint = digestObject(
        active.map((participant) => ({
          provider: participant.provider,
          model: participant.model,
          reasoningEffort: participant.reasoningEffort,
          binary: participant.metadata?.binary ?? null
        }))
      );
      records.set(
        `provider:${provider}`,
        capabilityRecord(
          `provider:${provider}`,
          "available",
          "A semantic CLI probe is present in a valid 24-hour roster cache",
          "deliberation-roster-cache",
          checkedAt,
          null,
          { digest: fingerprint }
        )
      );
    } else if (unavailable.length > 0 && cacheHits.length > 0) {
      records.set(
        `provider:${provider}`,
        capabilityRecord(
          `provider:${provider}`,
          "unavailable",
          unavailable.map((item) => item.reason).filter(Boolean).join("; ").slice(0, 500),
          "deliberation-roster-cache",
          checkedAt,
          "Re-authorize a sanitized roster refresh"
        )
      );
    } else {
      records.set(
        `provider:${provider}`,
        capabilityRecord(
          `provider:${provider}`,
          "requires-authority",
          "No valid cached semantic probe is available; capability snapshot never starts provider login or probes",
          null,
          checkedAt,
          "Run an authorized sanitized deliberation roster refresh"
        )
      );
    }
  }
  return records;
}

export async function capabilitySnapshot({
  cwd = process.cwd(),
  stateRoot,
  env = process.env,
  requiredCapabilities = [],
  optionalCapabilities = [],
  includeInventory = false
} = {}) {
  const checkedAt = nowIso();
  const catalog = await loadEntrypointCatalog();
  const templates = await loadTemplates();
  const required = new Set(requiredCapabilities.map(String));
  const optional = new Set(optionalCapabilities.map(String));
  const ids = new Set([...required, ...optional]);
  if (includeInventory) {
    for (const entry of catalog.skills) ids.add(`entry:${entry.id}`);
    for (const template of templates) {
      ids.add(`template:${template.name}`);
      for (const skill of template.domainSkills ?? []) ids.add(`skill:${skill}`);
    }
    for (const command of ["node", "git", "gh", "codex", "agy"]) {
      ids.add(`command:${command}`);
    }
    for (const provider of ["codex", "claude", "gemini", "agy", "grok", "cursor", "kimi", "qwen", "kiro"]) {
      ids.add(`provider:${provider}`);
    }
    ids.add("mcp:host-tools");
  }
  const entryMap = new Map(catalog.skills.map((entry) => [entry.id, entry]));
  const templateMap = new Map(templates.map((template) => [template.name, template]));
  const providerRecords = await cachedProviderRecords([...ids], checkedAt, stateRoot);
  const capabilities = [];
  for (const id of [...ids].sort()) {
    if (!SAFE_CAPABILITY.test(id) || !id.includes(":")) {
      capabilities.push(capabilityRecord(id, "unsupported", "Capability id is invalid", null, checkedAt));
      continue;
    }
    const separator = id.indexOf(":");
    const type = id.slice(0, separator);
    const name = id.slice(separator + 1);
    if (type === "entry") {
      const entry = entryMap.get(name);
      const skill = entry ? await installedSkillPath(name, { cwd, env }) : null;
      capabilities.push(
        entry && skill
          ? capabilityRecord(
              id,
              "available",
              "Entrypoint catalog and selector skill are present",
              skill,
              checkedAt,
              null,
              {
                catalog: digestObject(entry),
                file: await fileFingerprint(skill)
              }
            )
          : capabilityRecord(id, "unavailable", "Entrypoint or selector skill is missing", null, checkedAt)
      );
    } else if (type === "template") {
      const template = templateMap.get(name);
      capabilities.push(
        template
          ? capabilityRecord(
              id,
              "available",
              "Machine-readable workflow template is present",
              path.join(pluginRoot(), "templates", `${name}.json`),
              checkedAt,
              null,
              { digest: digestObject(template) }
            )
          : capabilityRecord(id, "unavailable", "Workflow template is missing", null, checkedAt)
      );
    } else if (type === "skill") {
      const skill = await installedSkillPath(name, { cwd, env });
      capabilities.push(
        skill
          ? capabilityRecord(
              id,
              "available",
              "Support skill is installed",
              skill,
              checkedAt,
              null,
              await fileFingerprint(skill)
            )
          : capabilityRecord(id, "unavailable", "Support skill is not installed", null, checkedAt)
      );
    } else if (type === "command") {
      const executable = await executablePath(name, env);
      capabilities.push(
        executable
          ? capabilityRecord(
              id,
              "available",
              "Executable is present without invoking it",
              executable.path,
              checkedAt,
              null,
              {
                resolvedPath: executable.resolvedPath,
                ...await fileFingerprint(executable.resolvedPath, {
                  requireSingleLink: false
                })
              }
            )
          : capabilityRecord(id, "unavailable", "Executable was not found on PATH", null, checkedAt)
      );
    } else if (type === "provider") {
      capabilities.push(
        providerRecords.get(id) ??
          capabilityRecord(
            id,
            "requires-authority",
            "Provider capability requires a sanitized semantic probe",
            null,
            checkedAt
          )
      );
    } else if (type === "mcp") {
      capabilities.push(
        capabilityRecord(
          id,
          "unsupported",
          "The Node-only helper cannot attest host-exposed MCP tools",
          null,
          checkedAt,
          "Let the Codex host report MCP availability"
        )
      );
    } else {
      capabilities.push(
        capabilityRecord(id, "unsupported", `Unknown capability type: ${type}`, null, checkedAt)
      );
    }
  }
  const stable = capabilities.map(({ checkedAt: _checkedAt, ...record }) => record);
  const blockers = capabilities
    .filter((record) => required.has(record.id) && BLOCKING_CAPABILITY_STATES.has(record.status))
    .map((record) => `${record.id}:${record.status}`);
  return {
    schemaVersion: 1,
    checkedAt,
    capabilities,
    requiredCapabilities: [...required].sort(),
    optionalCapabilities: [...optional].sort(),
    blockers,
    digest: digestObject(stable)
  };
}

function normalizeMatchInput(values) {
  return new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean));
}

function scopeMatches(actualScope, configuredScope) {
  const actual = actualScope.replaceAll("\\", "/").replace(/^\.\//, "");
  const configured = configuredScope.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/\*$/, "");
  return actual === configured || actual.startsWith(`${configured}/`);
}

function ruleMatches(rule, input) {
  const goal = input.goal.toLowerCase();
  const domains = normalizeMatchInput(input.domains);
  const tags = normalizeMatchInput(input.tags);
  const categories = [
    [rule.match.keywords, (candidate) => goal.includes(candidate.toLowerCase())],
    [rule.match.domains, (candidate) => domains.has(candidate.toLowerCase())],
    [rule.match.tags, (candidate) => tags.has(candidate.toLowerCase())],
    [
      rule.match.scopes,
      (candidate) => input.scope.some((actualScope) => scopeMatches(actualScope, candidate))
    ]
  ];
  return categories.every(([configured, predicate]) => configured.length === 0 || configured.some(predicate));
}

function chooseRule(profile, input) {
  return profile.rules
    .map((rule, order) => ({ rule, order }))
    .filter(({ rule }) => ruleMatches(rule, input))
    .sort(
      (left, right) =>
        right.rule.priority - left.rule.priority || left.order - right.order
    )[0]?.rule ?? null;
}

async function loadProfiles({ cwd, stateRoot }) {
  const resolvedStateRoot = path.resolve(stateRoot ?? getStateRoot());
  const workspacePath = path.join(path.resolve(cwd), PROFILE_RELATIVE_PATH);
  const personalPath = safeJoin(resolvedStateRoot, "routing", "profile.json");
  const workspaceRaw = await readSafeJson(path.resolve(cwd), workspacePath, { allowMissing: true });
  const personalRaw = await readSafeJson(resolvedStateRoot, personalPath, { allowMissing: true });
  const workspace = workspaceRaw ? validateRoutingProfile(workspaceRaw) : null;
  const personal = personalRaw ? validateRoutingProfile(personalRaw) : null;
  return {
    workspace: workspace ? { path: workspacePath, profile: workspace, digest: digestObject(workspace) } : null,
    personal: personal ? { path: personalPath, profile: personal, digest: digestObject(personal) } : null
  };
}

function strongestMode(...modes) {
  const concrete = modes.filter((mode) => MODE_RANK.has(mode));
  if (concrete.length === 0) return "auto";
  return concrete.sort((left, right) => MODE_RANK.get(right) - MODE_RANK.get(left))[0];
}

function routeFromEntry(entry, templateMap) {
  const template = entry.template === "auto" ? null : templateMap.get(entry.template);
  if (entry.template !== "auto" && !template) {
    throw new Error(`Entrypoint ${entry.id} references missing template ${entry.template}`);
  }
  return {
    entry: entry.id,
    template: template?.name ?? null,
    description: entry.description,
    baseMode: strongestMode(entry.mode, template?.defaultMode)
  };
}

function profileBindings(profiles) {
  return {
    workspace: profiles.workspace
      ? { path: profiles.workspace.path, digest: profiles.workspace.digest }
      : null,
    personal: profiles.personal
      ? { path: profiles.personal.path, digest: profiles.personal.digest }
      : null
  };
}

export async function previewRoute({
  cwd = process.cwd(),
  stateRoot,
  goal,
  scope = ["."],
  entry = null,
  template = null,
  mode = "auto",
  domains = [],
  tags = []
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const routeGoal = String(goal ?? "").trim();
  if (!routeGoal) throw new Error("route preview requires --goal");
  const routeScope = stringArray(scope, "scope");
  if (routeScope.length === 0) throw new Error("route preview requires at least one scope");
  if (entry && template) throw new Error("route preview accepts only one of --entry or --template");
  if (mode !== "auto" && !MODE_RANK.has(mode)) throw new Error(`Unknown route mode: ${mode}`);
  const catalog = await loadEntrypointCatalog();
  const templates = await loadTemplates();
  const catalogMap = new Map(catalog.skills.map((candidate) => [candidate.id, candidate]));
  const templateMap = new Map(templates.map((candidate) => [candidate.name, candidate]));
  const profiles = await loadProfiles({ cwd: resolvedCwd, stateRoot });
  const input = {
    goal: routeGoal,
    scope: routeScope.map(String),
    domains: stringArray(domains, "domains"),
    tags: stringArray(tags, "tags")
  };
  const workspaceRule = profiles.workspace
    ? chooseRule(profiles.workspace.profile, input)
    : null;
  const personalRule = profiles.personal
    ? chooseRule(profiles.personal.profile, input)
    : null;
  let selected;
  let source;
  let profileRule = null;
  const ignoredOverrides = [];
  if (entry) {
    const catalogEntry = catalogMap.get(String(entry));
    if (!catalogEntry) throw new Error(`Unknown entrypoint: ${entry}`);
    selected = routeFromEntry(catalogEntry, templateMap);
    source = "explicit-entry";
    if (workspaceRule) ignoredOverrides.push(`workspace-profile:${workspaceRule.id}`);
    if (personalRule) ignoredOverrides.push(`personal-profile:${personalRule.id}`);
  } else if (template) {
    const templateDefinition = templateMap.get(String(template));
    if (!templateDefinition) throw new Error(`Unknown template: ${template}`);
    selected = {
      entry: null,
      template: templateDefinition.name,
      description: templateDefinition.description,
      baseMode: templateDefinition.defaultMode
    };
    source = "explicit-template";
    if (workspaceRule) ignoredOverrides.push(`workspace-profile:${workspaceRule.id}`);
    if (personalRule) ignoredOverrides.push(`personal-profile:${personalRule.id}`);
  } else {
    const matched = workspaceRule
      ? { ...profiles.workspace, rule: workspaceRule, source: "workspace-profile" }
      : personalRule
        ? { ...profiles.personal, rule: personalRule, source: "personal-profile" }
        : null;
    if (matched) {
      profileRule = matched.rule;
      source = matched.source;
      if (matched.rule.route.entry) {
        const catalogEntry = catalogMap.get(matched.rule.route.entry);
        if (!catalogEntry) throw new Error(`Profile references unknown entrypoint: ${matched.rule.route.entry}`);
        selected = routeFromEntry(catalogEntry, templateMap);
      } else {
        const templateDefinition = templateMap.get(matched.rule.route.template);
        if (!templateDefinition) {
          throw new Error(`Profile references unknown template: ${matched.rule.route.template}`);
        }
        selected = {
          entry: null,
          template: templateDefinition.name,
          description: templateDefinition.description,
          baseMode: templateDefinition.defaultMode
        };
      }
      if (workspaceRule && personalRule) ignoredOverrides.push(`personal-profile:${personalRule.id}`);
    } else {
      selected = routeFromEntry(catalogMap.get("auto"), templateMap);
      source = "built-in-auto";
    }
  }
  const minimumMode = profileRule?.route.minimumMode ?? null;
  const effectiveMode = strongestMode(selected.baseMode, minimumMode, mode);
  const supportSkills = (profileRule?.route.supportSkills ?? []).slice(0, 3);
  const requiredCapabilities = [
    ...(selected.entry ? [`entry:${selected.entry}`] : []),
    ...(selected.template ? [`template:${selected.template}`] : []),
    ...(profileRule?.route.requiredCapabilities ?? [])
  ];
  const optionalCapabilities = supportSkills.map((skill) => `skill:${skill}`);
  const snapshot = await capabilitySnapshot({
    cwd: resolvedCwd,
    stateRoot,
    requiredCapabilities,
    optionalCapabilities
  });
  const availableOptional = new Set(
    snapshot.capabilities
      .filter((capability) => capability.status === "available")
      .map((capability) => capability.id)
  );
  const advisorySupportSkills = supportSkills.filter((skill) =>
    availableOptional.has(`skill:${skill}`)
  );
  const excludedSupportSkills = supportSkills
    .filter((skill) => !availableOptional.has(`skill:${skill}`))
    .map((skill) => ({
      skill,
      reason:
        snapshot.capabilities.find((capability) => capability.id === `skill:${skill}`)?.reason ??
        "capability not available"
    }));
  const catalogDigest = digestObject({
    catalog,
    templates: templates.map((value) => ({
      name: value.name,
      defaultMode: value.defaultMode,
      domainSkills: value.domainSkills ?? []
    }))
  });
  const bindings = {
    catalogDigest,
    profileDigest: digestObject(profileBindings(profiles)),
    goalDigest: digestObject({ goal: input.goal }),
    scopeDigest: digestObject({ cwd: resolvedCwd, scope: input.scope }),
    capabilityDigest: snapshot.digest,
    bundleDigest: await pluginBundleDigest()
  };
  const primary = {
    entry: selected.entry,
    template: selected.template,
    description: selected.description
  };
  const routeDigest = digestObject({
    source,
    primary,
    effectiveMode,
    profileRule: profileRule?.id ?? null,
    advisorySupportSkills,
    requiredCapabilities,
    bindings
  });
  return {
    schemaVersion: 1,
    ok: snapshot.blockers.length === 0,
    source,
    primary,
    effectiveMode,
    explicitMode: mode,
    profileRule: profileRule?.id ?? null,
    advisorySupportSkills,
    excludedSupportSkills,
    requiredCapabilities,
    capabilities: snapshot.capabilities,
    ignoredOverrides,
    blockers: snapshot.blockers,
    bindings,
    routeDigest,
    profilePrecedence: [
      "host-hard-constraints",
      "explicit-entry-template-mode",
      "workspace-profile",
      "personal-profile",
      "built-in-auto"
    ],
    hostConstraints: {
      status: "unverified",
      reason: "No Node-only host hard-constraint input was supplied"
    },
    needsSelection: !selected.template,
    input
  };
}

function generateReceiptId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `route-${stamp}-${randomBytes(6).toString("hex")}`;
}

export async function recordRouteReceipt({ stateRoot, cwd = process.cwd(), preview }) {
  if (!preview || preview.schemaVersion !== 1) throw new Error("A route preview is required");
  if (!preview.ok) throw new Error(`Cannot record blocked route: ${preview.blockers.join(", ")}`);
  await ensurePrivateDir(stateRoot);
  const receiptId = generateReceiptId();
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptId,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    cwd: path.resolve(cwd),
    input: preview.input,
    requested: {
      entry: preview.source === "explicit-entry" ? preview.primary.entry : null,
      template: preview.source === "explicit-template" ? preview.primary.template : null,
      mode: preview.explicitMode
    },
    route: {
      source: preview.source,
      primary: preview.primary,
      effectiveMode: preview.effectiveMode,
      profileRule: preview.profileRule,
      advisorySupportSkills: preview.advisorySupportSkills
    },
    bindings: preview.bindings,
    routeDigest: preview.routeDigest
  };
  const target = safeJoin(stateRoot, "route-receipts", `${receiptId}.json`);
  await atomicWriteJson(stateRoot, target, receipt);
  return { receiptId, path: target, receipt };
}

export async function validateRouteReceipt({
  stateRoot,
  cwd = process.cwd(),
  receiptId
}) {
  if (!RECEIPT_ID.test(String(receiptId))) throw new Error("Invalid route receipt id");
  const target = safeJoin(stateRoot, "route-receipts", `${receiptId}.json`);
  const receipt = await readJson(stateRoot, target);
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION || receipt.receiptId !== receiptId) {
    throw new Error("Route receipt schema or identity is invalid");
  }
  if (!Number.isFinite(Date.parse(receipt.expiresAt)) || Date.parse(receipt.expiresAt) <= Date.now()) {
    throw new Error("Route receipt expired");
  }
  const claimPath = safeJoin(stateRoot, "route-receipts", `${receiptId}.claim`);
  if (await pathExists(claimPath)) throw new Error("Route receipt was already claimed");
  const resolvedCwd = path.resolve(cwd);
  if (receipt.cwd !== resolvedCwd) throw new Error("Route receipt workspace binding changed");
  const preview = await previewRoute({
    cwd: resolvedCwd,
    stateRoot,
    goal: receipt.input.goal,
    scope: receipt.input.scope,
    domains: receipt.input.domains,
    tags: receipt.input.tags,
    entry: receipt.requested.entry,
    template: receipt.requested.template,
    mode: receipt.requested.mode
  });
  const changed = Object.keys(receipt.bindings).filter(
    (key) => receipt.bindings[key] !== preview.bindings[key]
  );
  if (receipt.routeDigest !== preview.routeDigest) changed.push("routeDigest");
  if (changed.length > 0) {
    throw new Error(`Route receipt is stale: ${[...new Set(changed)].join(", ")}`);
  }
  if (!preview.ok) throw new Error(`Route receipt is blocked: ${preview.blockers.join(", ")}`);
  return { receipt, preview, path: target };
}

export async function claimRouteReceipt({ stateRoot, receiptId }) {
  if (!RECEIPT_ID.test(String(receiptId))) throw new Error("Invalid route receipt id");
  const directory = safeJoin(stateRoot, "route-receipts");
  const target = safeJoin(directory, `${receiptId}.claim`);
  const handle = await open(target, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") throw new Error("Route receipt was already claimed");
    throw error;
  });
  try {
    await handle.writeFile(`${JSON.stringify({ receiptId, claimedAt: nowIso(), pid: process.pid })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return target;
}

export async function markRouteReceiptUsed({ stateRoot, receiptId, runId }) {
  const target = safeJoin(stateRoot, "route-receipts", `${receiptId}.json`);
  const receipt = await readJson(stateRoot, target);
  await atomicWriteJson(stateRoot, target, {
    ...receipt,
    usedAt: nowIso(),
    runId
  });
}

export async function showRoutingProfiles({ cwd = process.cwd(), stateRoot }) {
  const profiles = await loadProfiles({ cwd, stateRoot });
  return {
    schemaVersion: 1,
    precedence: ["workspace", "personal", "built-in-auto"],
    workspace: profiles.workspace,
    personal: profiles.personal
  };
}

export async function validateRoutingProfileFile({
  cwd = process.cwd(),
  file
}) {
  if (!file) throw new Error("route profile validate requires --file");
  if (path.isAbsolute(file) || String(file).split(/[\\/]/).includes("..")) {
    throw new Error("Profile file must be a relative path inside the workspace");
  }
  const root = path.resolve(cwd);
  const target = assertContained(root, path.resolve(root, file), "Profile file");
  const raw = await readSafeJson(root, target);
  const profile = validateRoutingProfile(raw);
  return { path: target, profile, digest: digestObject(profile) };
}

export async function installPersonalRoutingProfile({
  cwd = process.cwd(),
  stateRoot,
  file
}) {
  const validated = await validateRoutingProfileFile({ cwd, file });
  await ensurePrivateDir(stateRoot);
  const target = safeJoin(stateRoot, "routing", "profile.json");
  await atomicWriteJson(stateRoot, target, validated.profile);
  const installed = await readJson(stateRoot, target);
  if (digestObject(installed) !== validated.digest) {
    throw new Error("Installed Routing Profile digest mismatch");
  }
  return { source: validated.path, target, digest: validated.digest, profile: installed };
}
