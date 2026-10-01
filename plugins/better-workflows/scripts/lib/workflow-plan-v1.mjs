import { chmod, open } from "node:fs/promises";
import path from "node:path";
import {
  assertNoSymlinkUnder,
  canonicalJson,
  canonicalizeScope,
  digestObject,
  ensurePrivateDir,
  getStateRoot,
  readJson,
  safeJoin
} from "./core.mjs";

export const WORKFLOW_PLAN_SCHEMA_VERSION = 1;
export const WORKFLOW_PLAN_KIND = "WorkflowPlanV1";
export const TASK_CONTRACT_SCHEMA_VERSION = 3;
export const TASK_CONTRACT_KIND = "TaskContractV3";
export const LEGACY_TASK_CONTRACT_V2_PROJECTION_KIND = "LegacyTaskContractV2Projection";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@~-]{0,127}$/;

export class WorkflowPlanValidationError extends Error {
  constructor(pathname, message) {
    super(pathname + ": " + message);
    this.name = "WorkflowPlanValidationError";
    this.code = "INVALID_WORKFLOW_PLAN";
    this.path = pathname;
  }
}

function fail(pathname, message) {
  throw new WorkflowPlanValidationError(pathname, message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value, pathname) {
  try {
    return structuredClone(value);
  } catch (error) {
    fail(pathname || "value", "must be structured-cloneable: " + error.message);
  }
}

function rejectUnknownKeys(value, allowed, pathname) {
  if (!isObject(value)) fail(pathname, "must be an object");
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) fail(pathname, "contains unknown field(s): " + unknown.join(", "));
}

function requireKeys(value, required, pathname) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(pathname, "requires " + key);
  }
}

function safeId(value, pathname) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(pathname, "must be a safe id");
  return value;
}

function nonEmptyString(value, pathname, max = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(pathname, "must be a non-empty bounded string");
  }
  return value.trim();
}

function digest(value, pathname) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(pathname, "must be a lowercase SHA-256 digest");
  return value;
}

function revision(value, pathname) {
  if (typeof value !== "string" || !REVISION.test(value)) fail(pathname, "must be a lowercase immutable revision");
  return value;
}

function uniqueStrings(value, pathname, { ids = false, allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(pathname, allowEmpty ? "must be an array" : "must be a non-empty array");
  }
  const result = value.map((item, index) => ids
    ? safeId(item, pathname + "[" + index + "]")
    : nonEmptyString(item, pathname + "[" + index + "]", 128));
  if (new Set(result).size !== result.length) fail(pathname, "must not contain duplicates");
  return [...result].sort();
}

function normalizePathList(value, pathname, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(pathname, allowEmpty ? "must be an array" : "must be a non-empty array");
  }
  const raw = value.map((item, index) => {
    if (typeof item !== "string") fail(pathname + "[" + index + "]", "must be a relative literal path");
    return item;
  });
  if (new Set(raw).size !== raw.length) fail(pathname, "must not contain duplicate paths");
  if (raw.length === 0 && allowEmpty) return [];
  try {
    return canonicalizeScope(raw);
  } catch (error) {
    fail(pathname, error.message);
  }
}

function normalizeScope(value, pathname = "scope") {
  rejectUnknownKeys(value, new Set(["include", "exclude"]), pathname);
  requireKeys(value, ["include"], pathname);
  const include = normalizePathList(value.include, pathname + ".include", { allowEmpty: false });
  const exclude = value.exclude === undefined ? [] : normalizePathList(value.exclude, pathname + ".exclude");
  return { include, exclude };
}

function normalizeSourceBinding(value, pathname) {
  rejectUnknownKeys(value, new Set(["revision", "digest"]), pathname);
  requireKeys(value, ["revision", "digest"], pathname);
  return {
    revision: revision(value.revision, pathname + ".revision"),
    digest: digest(value.digest, pathname + ".digest")
  };
}

function normalizePolicyBinding(value, pathname) {
  rejectUnknownKeys(value, new Set(["digest"]), pathname);
  requireKeys(value, ["digest"], pathname);
  return { digest: digest(value.digest, pathname + ".digest") };
}

function normalizeTemplateBinding(value, pathname) {
  rejectUnknownKeys(value, new Set(["id", "digest"]), pathname);
  requireKeys(value, ["id", "digest"], pathname);
  return {
    id: safeId(value.id, pathname + ".id"),
    digest: digest(value.digest, pathname + ".digest")
  };
}

function normalizeRouteBinding(value, pathname) {
  rejectUnknownKeys(value, new Set(["receiptId", "digest"]), pathname);
  requireKeys(value, ["digest"], pathname);
  const receiptId = value.receiptId === undefined || value.receiptId === null
    ? null
    : safeId(value.receiptId, pathname + ".receiptId");
  return { receiptId, digest: digest(value.digest, pathname + ".digest") };
}

function normalizeBindings(value, pathname = "bindings") {
  rejectUnknownKeys(value, new Set(["source", "policy", "template", "route"]), pathname);
  requireKeys(value, ["source", "policy", "template", "route"], pathname);
  return {
    source: normalizeSourceBinding(value.source, pathname + ".source"),
    policy: normalizePolicyBinding(value.policy, pathname + ".policy"),
    template: normalizeTemplateBinding(value.template, pathname + ".template"),
    route: normalizeRouteBinding(value.route, pathname + ".route")
  };
}

function normalizeModel(value, pathname) {
  if (typeof value !== "string" || !MODEL_ID.test(value)) fail(pathname, "must be a bounded model identity");
  return value;
}

function normalizeModelPolicy(value, pathname = "modelPolicy") {
  rejectUnknownKeys(value, new Set(["inherit", "allow", "deny", "requested", "reported", "attested"]), pathname);
  requireKeys(value, ["inherit", "allow", "deny"], pathname);
  if (typeof value.inherit !== "boolean") fail(pathname + ".inherit", "must be boolean");
  const allow = uniqueStrings(value.allow, pathname + ".allow").map((item, index) => {
    if (!MODEL_ID.test(item)) fail(pathname + ".allow[" + index + "]", "must be a bounded model identity");
    return item;
  });
  const deny = uniqueStrings(value.deny, pathname + ".deny").map((item, index) => {
    if (!MODEL_ID.test(item)) fail(pathname + ".deny[" + index + "]", "must be a bounded model identity");
    return item;
  });
  if (!value.inherit && allow.length === 0) fail(pathname, "must inherit or declare at least one allowed model");
  const identities = {};
  // Preserve legacy observation fields for canonical reads and digest compatibility;
  // plan-authoring entry points reject caller-supplied reported/attested values.
  for (const key of ["requested", "reported", "attested"]) {
    const item = value[key] === undefined || value[key] === null
      ? null
      : normalizeModel(value[key], pathname + "." + key);
    if (item !== null && deny.includes(item)) fail(pathname + "." + key, "is denied by model policy");
    if (item !== null && allow.length > 0 && !allow.includes(item)) {
      fail(pathname + "." + key, "is outside the declared allow set");
    }
    identities[key] = item;
  }
  return { inherit: value.inherit, allow, deny, ...identities };
}

function rejectAuthoredModelObservations(contract, pathname = "TaskContractV3") {
  const policies = [
    { pathname: pathname + ".modelPolicy", value: contract.modelPolicy },
    ...contract.graph.tasks.map((task) => ({
      pathname: pathname + ".graph.tasks." + task.id + ".modelPolicy",
      value: task.modelPolicy
    }))
  ];
  for (const { pathname: policyPath, value } of policies) {
    for (const key of ["reported", "attested"]) {
      if (value[key] !== null) {
        fail(policyPath + "." + key, "runtime model identity must come from a bound runtime observation, not a new plan");
      }
    }
  }
  return contract;
}

function integerBudget(value, pathname, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(pathname, "must be a positive integer");
    return null;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000) {
    fail(pathname, "must be a positive bounded integer");
  }
  return value;
}

function normalizeBudget(value, pathname = "budget") {
  rejectUnknownKeys(value, new Set(["attempts", "seconds", "tokens"]), pathname);
  requireKeys(value, ["attempts"], pathname);
  return {
    attempts: integerBudget(value.attempts, pathname + ".attempts"),
    seconds: integerBudget(value.seconds, pathname + ".seconds", { required: false }),
    tokens: integerBudget(value.tokens, pathname + ".tokens", { required: false })
  };
}

function normalizeRoles(value, pathname = "roles") {
  if (!Array.isArray(value) || value.length === 0) fail(pathname, "must be a non-empty array");
  const roles = value.map((role, index) => {
    const rolePath = pathname + "[" + index + "]";
    rejectUnknownKeys(role, new Set(["id", "required"]), rolePath);
    requireKeys(role, ["id", "required"], rolePath);
    if (typeof role.required !== "boolean") fail(rolePath + ".required", "must be boolean");
    return { id: safeId(role.id, rolePath + ".id"), required: role.required };
  });
  const ids = new Set();
  for (const role of roles) {
    if (ids.has(role.id)) fail(pathname, "contains duplicate role: " + role.id);
    ids.add(role.id);
  }
  if (!roles.some((role) => role.required)) fail(pathname, "must declare at least one required role");
  return roles.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeAcceptance(value, pathname = "acceptance") {
  if (!Array.isArray(value) || value.length === 0) fail(pathname, "must be a non-empty array");
  const acceptance = value.map((item, index) => {
    const itemPath = pathname + "[" + index + "]";
    rejectUnknownKeys(item, new Set(["id", "description", "requiredEvidence", "critical"]), itemPath);
    requireKeys(item, ["id", "description"], itemPath);
    return {
      id: safeId(item.id, itemPath + ".id"),
      description: nonEmptyString(item.description, itemPath + ".description"),
      requiredEvidence: item.requiredEvidence === undefined
        ? []
        : uniqueStrings(item.requiredEvidence, itemPath + ".requiredEvidence", { ids: true }),
      critical: item.critical === undefined ? false : item.critical
    };
  });
  const ids = new Set();
  for (const item of acceptance) {
    if (typeof item.critical !== "boolean") fail(pathname, "acceptance " + item.id + " critical must be boolean");
    if (ids.has(item.id)) fail(pathname, "contains duplicate acceptance id: " + item.id);
    ids.add(item.id);
  }
  return acceptance.sort((left, right) => left.id.localeCompare(right.id));
}

function pathInScope(target, scope) {
  return scope.include.some((entry) => (
    entry === "." || target === entry || target.startsWith(entry + "/")
  )) && !scope.exclude.some((entry) => (
    target === entry || target.startsWith(entry + "/")
  ));
}

function pathsOverlap(left, right) {
  return left === "." || right === "." || left === right ||
    left.startsWith(right + "/") || right.startsWith(left + "/");
}

function normalizeWriteOwner(value, pathname, scope, roles) {
  rejectUnknownKeys(value, new Set(["role", "paths"]), pathname);
  requireKeys(value, ["role", "paths"], pathname);
  const role = safeId(value.role, pathname + ".role");
  if (!roles.some((item) => item.id === role)) fail(pathname + ".role", "references missing role: " + role);
  const paths = normalizePathList(value.paths, pathname + ".paths");
  for (const target of paths) {
    if (!pathInScope(target, scope)) fail(pathname + ".paths", "path is outside the declared scope: " + target);
  }
  return { role, paths };
}

function normalizeVerificationEnvironment(value, pathname) {
  if (!isObject(value)) fail(pathname, "must be an object");
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      fail(pathname + "." + key, "is a reserved environment key");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key)) {
      fail(pathname + "." + key, "must be a bounded environment key");
    }
    const item = value[key];
    if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      fail(pathname + "." + key, "must be a scalar");
    }
    if (typeof item === "string" && item.length > 4096) fail(pathname + "." + key, "is too long");
    if (typeof item === "number" && !Number.isFinite(item)) fail(pathname + "." + key, "must be finite");
    normalized[key] = item;
  }
  return normalized;
}

function verificationPathInScope(target, scope, pathname) {
  if (!pathInScope(target, scope)) fail(pathname, "path is outside the declared scope: " + target);
}

function normalizeVerificationGlob(value, pathname) {
  if (typeof value !== "string" || !value || value.includes("\0")) fail(pathname, "must be a non-empty relative glob");
  const posix = value.replaceAll("\\", "/");
  if (posix.startsWith("/") || /^[A-Za-z]:\//.test(posix) || posix.split("/").some((part) => part === "..")) {
    fail(pathname, "must be a relative glob inside the root");
  }
  return posix;
}

function normalizeVerificationGlobList(value, pathname) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(pathname, "must be an array");
  const normalized = value.map((item, index) => normalizeVerificationGlob(item, pathname + "[" + index + "]"));
  if (new Set(normalized).size !== normalized.length) fail(pathname, "must not contain duplicates");
  return [...new Set(normalized)].sort();
}

function globSegmentHasMagic(segment) {
  return /[*?[\]]/.test(segment);
}

function globSegmentMatchesLiteral(pattern, literal) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      expression += ".*";
    } else if (character === "?") {
      expression += ".";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) {
        expression += "\\[";
      } else {
        const body = pattern.slice(index + 1, end);
        if (!body || body.includes("\\")) expression += "\\[";
        else expression += `[${body.replaceAll("]", "\\]")}]`;
        index = end;
      }
    } else {
      expression += /[\\^$+.()|{}]/.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${expression}$`).test(literal);
}

function globCanMatchPathWithPrefix(pattern, prefix) {
  const patternSegments = pattern.split("/");
  const prefixSegments = prefix === "." ? [] : prefix.split("/");
  const memo = new Map();
  function consume(patternIndex, prefixIndex) {
    const key = `${patternIndex}:${prefixIndex}`;
    if (memo.has(key)) return memo.get(key);
    if (prefixIndex === prefixSegments.length) {
      // Any remaining pattern segments can be satisfied by a suffix chosen
      // inside the same prefix. This is an existence check, not enumeration.
      memo.set(key, true);
      return true;
    }
    if (patternIndex >= patternSegments.length) {
      memo.set(key, false);
      return false;
    }
    const segment = patternSegments[patternIndex];
    const result = segment === "**"
      ? consume(patternIndex + 1, prefixIndex) || consume(patternIndex, prefixIndex + 1)
      : globSegmentMatchesLiteral(segment, prefixSegments[prefixIndex]) && consume(patternIndex + 1, prefixIndex + 1);
    memo.set(key, result);
    return result;
  }
  return consume(0, 0);
}

function globHasFixedScopePrefix(pattern, included) {
  if (included === ".") return true;
  const patternSegments = pattern.split("/");
  const includeSegments = included.split("/");
  if (patternSegments.length < includeSegments.length) return false;
  return includeSegments.every((segment, index) =>
    patternSegments[index] === segment && !globSegmentHasMagic(patternSegments[index])
  );
}

function verificationGlobInScope(pattern, scope, pathname) {
  if (!scope.include.some((included) => globHasFixedScopePrefix(pattern, included))) {
    fail(pathname, "glob is outside the declared scope: " + pattern);
  }
  for (const excluded of scope.exclude) {
    if (globCanMatchPathWithPrefix(pattern, excluded)) {
      fail(pathname, "glob overlaps an excluded scope: " + pattern);
    }
  }
}

function normalizeVerificationDependencies(value, pathname, scope) {
  if (!isObject(value)) fail(pathname, "must be an object");
  rejectUnknownKeys(value, new Set(["files", "globs", "indirect", "unknown"]), pathname);
  const files = normalizePathList(value.files === undefined ? [] : value.files, pathname + ".files");
  files.forEach((item, index) => verificationPathInScope(item, scope, pathname + ".files[" + index + "]"));
  const globs = normalizeVerificationGlobList(value.globs, pathname + ".globs");
  globs.forEach((item, index) => verificationGlobInScope(item, scope, pathname + ".globs[" + index + "]"));
  if (files.length > 4096 || globs.length > 4096) fail(pathname, "contains too many direct dependencies");
  const unknown = value.unknown === undefined ? [] : uniqueStrings(value.unknown, pathname + ".unknown");
  if (unknown.length > 4096) fail(pathname + ".unknown", "contains too many unknown dependencies");
  const indirectInput = value.indirect === undefined ? [] : value.indirect;
  if (!Array.isArray(indirectInput)) fail(pathname + ".indirect", "must be an array");
  if (indirectInput.length > 4096) fail(pathname + ".indirect", "contains too many indirect dependencies");
  const ids = new Set();
  const indirect = indirectInput.map((item, index) => {
    const itemPath = pathname + ".indirect[" + index + "]";
    rejectUnknownKeys(item, new Set(["id", "files", "globs", "unknown", "reason"]), itemPath);
    requireKeys(item, ["id"], itemPath);
    const id = safeId(item.id, itemPath + ".id");
    if (ids.has(id)) fail(itemPath + ".id", "is duplicated");
    ids.add(id);
    const itemFiles = normalizePathList(item.files === undefined ? [] : item.files, itemPath + ".files");
    itemFiles.forEach((entry, entryIndex) => verificationPathInScope(entry, scope, itemPath + ".files[" + entryIndex + "]"));
    const itemGlobs = normalizeVerificationGlobList(item.globs, itemPath + ".globs");
    itemGlobs.forEach((entry, entryIndex) => verificationGlobInScope(entry, scope, itemPath + ".globs[" + entryIndex + "]"));
    const isUnknown = item.unknown === true;
    if (item.unknown !== undefined && typeof item.unknown !== "boolean") fail(itemPath + ".unknown", "must be boolean");
    const reason = item.reason === undefined || item.reason === null
      ? null
      : nonEmptyString(item.reason, itemPath + ".reason", 1024);
    if (itemFiles.length === 0 && itemGlobs.length === 0 && !isUnknown) {
      fail(itemPath, "requires files/globs or unknown: true");
    }
    return { id, files: itemFiles, globs: itemGlobs, unknown: isUnknown, reason };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (files.length === 0 && globs.length === 0 && indirect.length === 0 && unknown.length === 0) {
    fail(pathname, "must declare at least one dependency or explicit unknown dependency");
  }
  return { files, globs, indirect, unknown };
}

function normalizeVerificationConfig(value, pathname, dependencies) {
  if (!isObject(value)) fail(pathname, "must be an object");
  rejectUnknownKeys(value, new Set(["checks"]), pathname);
  requireKeys(value, ["checks"], pathname);
  if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > 256) {
    fail(pathname + ".checks", "must be a non-empty bounded array");
  }
  const declaredFiles = new Set([
    ...dependencies.files,
    ...dependencies.indirect.flatMap((item) => item.files)
  ]);
  const checks = value.checks.map((item, index) => {
    const itemPath = pathname + ".checks[" + index + "]";
    rejectUnknownKeys(item, new Set(["kind", "path", "requiredKeys", "substring"]), itemPath);
    requireKeys(item, ["kind", "path"], itemPath);
    const kind = nonEmptyString(item.kind, itemPath + ".kind", 64);
    const relative = normalizePathList([item.path], itemPath + ".path")[0];
    if (!declaredFiles.has(relative)) fail(itemPath + ".path", "must be an explicit dependency file");
    if (kind === "json-object") {
      if (!Array.isArray(item.requiredKeys) || item.requiredKeys.length > 256) {
        fail(itemPath + ".requiredKeys", "must be a bounded array");
      }
      return {
        kind,
        path: relative,
        requiredKeys: uniqueStrings(item.requiredKeys, itemPath + ".requiredKeys")
      };
    }
    if (kind === "text-contains") {
      return { kind, path: relative, substring: nonEmptyString(item.substring, itemPath + ".substring", 4096) };
    }
    fail(itemPath + ".kind", "must be json-object or text-contains");
  });
  return { checks };
}

function normalizeVerificationDeclaration(value, pathname, scope) {
  if (!isObject(value)) fail(pathname, "must be an object");
  rejectUnknownKeys(value, new Set(["mode", "dependencies", "config", "controlledEnvironment"]), pathname);
  requireKeys(value, ["mode", "dependencies", "config", "controlledEnvironment"], pathname);
  if (value.mode !== "off" && value.mode !== "shadow") fail(pathname + ".mode", "must be off or shadow");
  const dependencies = normalizeVerificationDependencies(value.dependencies, pathname + ".dependencies", scope);
  const config = normalizeVerificationConfig(value.config, pathname + ".config", dependencies);
  const controlledEnvironment = normalizeVerificationEnvironment(value.controlledEnvironment, pathname + ".controlledEnvironment");
  return { mode: value.mode, dependencies, config, controlledEnvironment };
}

export function canonicalizeTaskVerificationDeclaration(value, { scope = null } = {}) {
  const normalizedScope = scope === null ? { include: ["."], exclude: [] } : normalizeScope(scope, "scope");
  return normalizeVerificationDeclaration(value, "verification", normalizedScope);
}

function normalizeGraph(value, { scope, roles, modelPolicy, budget, acceptance }, pathname = "graph") {
  rejectUnknownKeys(value, new Set(["tasks"]), pathname);
  requireKeys(value, ["tasks"], pathname);
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) fail(pathname + ".tasks", "must be a non-empty array");
  const acceptanceSet = new Set(acceptance.map((item) => item.id));
  const tasks = value.tasks.map((task, index) => {
    const taskPath = pathname + ".tasks[" + index + "]";
    rejectUnknownKeys(task, new Set(["id", "goal", "dependencies", "role", "writeOwner", "modelPolicy", "budget", "acceptanceIds", "verification"]), taskPath);
    requireKeys(task, ["id", "goal", "dependencies", "role", "writeOwner", "budget", "acceptanceIds"], taskPath);
    const dependencies = uniqueStrings(task.dependencies, taskPath + ".dependencies", { ids: true });
    const role = safeId(task.role, taskPath + ".role");
    if (!roles.some((item) => item.id === role)) fail(taskPath + ".role", "references missing role: " + role);
    const taskPolicy = task.modelPolicy === undefined
      ? modelPolicy
      : normalizeModelPolicy(task.modelPolicy, taskPath + ".modelPolicy");
    const taskBudget = normalizeBudget(task.budget, taskPath + ".budget");
    const acceptanceIds = uniqueStrings(task.acceptanceIds, taskPath + ".acceptanceIds", { ids: true, allowEmpty: false });
    for (const id of acceptanceIds) {
      if (!acceptanceSet.has(id)) fail(taskPath + ".acceptanceIds", "references missing acceptance: " + id);
    }
    return {
      id: safeId(task.id, taskPath + ".id"),
      goal: nonEmptyString(task.goal, taskPath + ".goal"),
      dependencies,
      role,
      writeOwner: normalizeWriteOwner(task.writeOwner, taskPath + ".writeOwner", scope, roles),
      modelPolicy: taskPolicy,
      budget: taskBudget,
      acceptanceIds,
      ...(task.verification === undefined
        ? {}
        : { verification: normalizeVerificationDeclaration(task.verification, taskPath + ".verification", scope) })
    };
  });
  const byId = new Map();
  for (const task of tasks) {
    if (byId.has(task.id)) fail(pathname + ".tasks", "contains duplicate task id: " + task.id);
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.id) fail(pathname + ".tasks." + task.id + ".dependencies", "cannot depend on itself");
      if (!byId.has(dependency)) fail(pathname + ".tasks." + task.id + ".dependencies", "references missing task: " + dependency);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(taskId) {
    if (visiting.has(taskId)) fail(pathname + ".tasks", "dependency cycle at " + taskId);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId).dependencies) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const task of tasks) visit(task.id);

  const assignedRoleIds = new Set();
  for (const task of tasks) {
    assignedRoleIds.add(task.role);
    assignedRoleIds.add(task.writeOwner.role);
  }
  for (const role of roles.filter((item) => item.required)) {
    if (!assignedRoleIds.has(role.id)) fail(pathname + ".tasks", "required role is unassigned: " + role.id);
  }

  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      const left = tasks[leftIndex];
      const right = tasks[rightIndex];
      for (const leftPath of left.writeOwner.paths) {
        for (const rightPath of right.writeOwner.paths) {
          if (pathsOverlap(leftPath, rightPath)) {
            fail(pathname + ".tasks", "write owner conflict: " + left.id + ":" + leftPath + " overlaps " + right.id + ":" + rightPath);
          }
        }
      }
    }
  }

  const usedAcceptance = new Set(tasks.flatMap((task) => task.acceptanceIds));
  for (const item of acceptance) {
    if (!usedAcceptance.has(item.id)) fail("acceptance", "is not assigned to any task: " + item.id);
  }

  const totals = { attempts: 0, seconds: 0, tokens: 0 };
  for (const task of tasks) {
    totals.attempts += task.budget.attempts;
    for (const key of ["seconds", "tokens"]) {
      const taskValue = task.budget[key];
      const contractValue = budget[key];
      if (contractValue === null && taskValue !== null) {
        fail(pathname + ".tasks." + task.id + ".budget." + key, "requires a contract budget." + key + " ceiling");
      }
      if (contractValue !== null && taskValue === null) {
        fail(pathname + ".tasks." + task.id + ".budget." + key, "must be bounded by contract budget." + key);
      }
      if (taskValue !== null) totals[key] += taskValue;
    }
  }
  for (const key of ["attempts", "seconds", "tokens"]) {
    if (budget[key] !== null && totals[key] > budget[key]) {
      fail("budget", key + " overflow: task total " + totals[key] + " exceeds " + budget[key]);
    }
  }
  return { tasks: tasks.sort((left, right) => left.id.localeCompare(right.id)) };
}

function canonicalizeTaskContractV3Internal(value, { allowMissingBindings = false } = {}) {
  const candidate = clone(value, "TaskContractV3");
  if (!isObject(candidate)) fail("TaskContractV3", "must be an object");
  const allowed = new Set([
    "schemaVersion", "kind", "contractId", "goal", "scope", "bindings",
    "roles", "modelPolicy", "budget", "acceptance", "graph"
  ]);
  rejectUnknownKeys(candidate, allowed, "TaskContractV3");
  const required = [...allowed].filter((key) => !(allowMissingBindings && key === "bindings"));
  requireKeys(candidate, required, "TaskContractV3");
  if (candidate.schemaVersion !== TASK_CONTRACT_SCHEMA_VERSION) fail("TaskContractV3.schemaVersion", "must be 3");
  if (candidate.kind !== TASK_CONTRACT_KIND) fail("TaskContractV3.kind", "must be " + TASK_CONTRACT_KIND);
  const scope = normalizeScope(candidate.scope);
  const bindings = candidate.bindings === undefined
    ? null
    : normalizeBindings(candidate.bindings);
  const roles = normalizeRoles(candidate.roles);
  const modelPolicy = normalizeModelPolicy(candidate.modelPolicy);
  const budget = normalizeBudget(candidate.budget);
  const acceptance = normalizeAcceptance(candidate.acceptance);
  const graph = normalizeGraph(candidate.graph, { scope, roles, modelPolicy, budget, acceptance });
  const canonical = {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    kind: TASK_CONTRACT_KIND,
    contractId: safeId(candidate.contractId, "TaskContractV3.contractId"),
    goal: nonEmptyString(candidate.goal, "TaskContractV3.goal"),
    scope, roles, modelPolicy, budget, acceptance, graph
  };
  if (bindings !== null) canonical.bindings = bindings;
  return canonical;
}

export function canonicalizeTaskContractV3(value) {
  return canonicalizeTaskContractV3Internal(value);
}

export function validateTaskContractV3(value) {
  return canonicalizeTaskContractV3(value);
}

/**
 * Validate the user-authored portion of a native V3 contract before fresh
 * source, policy, template, and route bindings are observed. This deliberately
 * returns no bindings; callers must hydrate and run validateTaskContractV3
 * again before persisting a plan.
 */
export function validateTaskContractV3Draft(value) {
  if (!isObject(value) || Object.hasOwn(value, "bindings")) {
    fail("TaskContractV3Draft.bindings", "must be omitted from a draft input");
  }
  return rejectAuthoredModelObservations(
    canonicalizeTaskContractV3Internal(value, { allowMissingBindings: true }),
    "TaskContractV3Draft"
  );
}

export function createTaskContractV3(value) {
  if (!isObject(value)) fail("TaskContractV3", "must be an object");
  return rejectAuthoredModelObservations(canonicalizeTaskContractV3({
    schemaVersion: value.schemaVersion === undefined ? TASK_CONTRACT_SCHEMA_VERSION : value.schemaVersion,
    kind: value.kind === undefined ? TASK_CONTRACT_KIND : value.kind,
    ...value
  }));
}

export function digestTaskContractV3(value) {
  return digestObject(canonicalizeTaskContractV3(value));
}

export function routeBindingFromPreview(preview, { receiptId = null } = {}) {
  if (!isObject(preview)) fail("routePreview", "must be an object");
  return normalizeRouteBinding({
    receiptId,
    digest: digest(preview.routeDigest, "routePreview.routeDigest")
  }, "bindings.route");
}

function planCore(value) {
  return {
    schemaVersion: WORKFLOW_PLAN_SCHEMA_VERSION,
    kind: WORKFLOW_PLAN_KIND,
    planId: value.planId,
    taskContract: value.taskContract,
    contractDigest: value.contractDigest
  };
}

export function buildWorkflowPlanV1({ taskContract, planId = null } = {}) {
  if (!isObject(taskContract)) fail("WorkflowPlanV1.taskContract", "must be a TaskContractV3 object");
  if (taskContract.schemaVersion === 2) {
    fail("WorkflowPlanV1.taskContract", "legacy TaskContract v2 requires explicit projectLegacyTaskContractV2 and cannot be a V3 authority");
  }
  const canonicalContract = rejectAuthoredModelObservations(canonicalizeTaskContractV3(taskContract));
  const contractDigest = digestObject(canonicalContract);
  const resolvedPlanId = planId === null
    ? "plan-" + contractDigest.slice(0, 32)
    : safeId(planId, "WorkflowPlanV1.planId");
  const core = planCore({ planId: resolvedPlanId, taskContract: canonicalContract, contractDigest });
  return { ...core, planDigest: digestObject(core) };
}

export function canonicalizeWorkflowPlanV1(value) {
  const candidate = clone(value, "WorkflowPlanV1");
  if (!isObject(candidate)) fail("WorkflowPlanV1", "must be an object");
  const allowed = new Set(["schemaVersion", "kind", "planId", "taskContract", "contractDigest", "planDigest"]);
  rejectUnknownKeys(candidate, allowed, "WorkflowPlanV1");
  requireKeys(candidate, [...allowed], "WorkflowPlanV1");
  if (candidate.schemaVersion !== WORKFLOW_PLAN_SCHEMA_VERSION) fail("WorkflowPlanV1.schemaVersion", "must be 1");
  if (candidate.kind !== WORKFLOW_PLAN_KIND) fail("WorkflowPlanV1.kind", "must be " + WORKFLOW_PLAN_KIND);
  const canonicalContract = canonicalizeTaskContractV3(candidate.taskContract);
  const canonicalContractDigest = digestObject(canonicalContract);
  if (candidate.contractDigest !== canonicalContractDigest) {
    fail("WorkflowPlanV1.contractDigest", "does not match the bound TaskContractV3");
  }
  digest(candidate.planDigest, "WorkflowPlanV1.planDigest");
  const core = planCore({
    planId: safeId(candidate.planId, "WorkflowPlanV1.planId"),
    taskContract: canonicalContract,
    contractDigest: canonicalContractDigest
  });
  const expectedPlanDigest = digestObject(core);
  if (candidate.planDigest !== expectedPlanDigest) fail("WorkflowPlanV1.planDigest", "does not match the immutable plan contents");
  return { ...core, planDigest: expectedPlanDigest };
}

export function validateWorkflowPlanV1(value) {
  return canonicalizeWorkflowPlanV1(value);
}

export function digestWorkflowPlanV1(value) {
  return canonicalizeWorkflowPlanV1(value).planDigest;
}

export function projectLegacyTaskContractV2(value, { reason = "legacy contract is not admitted as V3" } = {}) {
  if (!isObject(value) || value.schemaVersion !== 2) {
    fail("LegacyTaskContractV2Projection.sourceContract", "requires a TaskContract schemaVersion 2 object");
  }
  const sourceContract = clone(value, "LegacyTaskContractV2Projection.sourceContract");
  return {
    schemaVersion: 1,
    kind: LEGACY_TASK_CONTRACT_V2_PROJECTION_KIND,
    authoritative: false,
    admissionStatus: "legacy-projection",
    sourceSchemaVersion: 2,
    sourceContractDigest: digestObject(sourceContract),
    reason: nonEmptyString(reason, "LegacyTaskContractV2Projection.reason", 1024),
    sourceContract
  };
}

function assertPlanId(planId) {
  return safeId(planId, "planId");
}

export function workflowPlanDirectory(root, planId) {
  const resolvedRoot = path.resolve(root ?? getStateRoot());
  return safeJoin(resolvedRoot, "plans", assertPlanId(planId));
}

export function workflowPlanPath(root, planId) {
  return safeJoin(workflowPlanDirectory(root, planId), "plan.json");
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createImmutableJson(root, target, value) {
  const parent = path.dirname(target);
  await assertNoSymlinkUnder(root, parent);
  await ensurePrivateDir(parent);
  try {
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(target, 0o600);
    await syncDirectory(parent);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

export async function persistWorkflowPlanV1({ root = getStateRoot(), plan } = {}) {
  const canonical = canonicalizeWorkflowPlanV1(plan);
  const resolvedRoot = path.resolve(root);
  const target = workflowPlanPath(resolvedRoot, canonical.planId);
  await ensurePrivateDir(resolvedRoot);
  await ensurePrivateDir(safeJoin(resolvedRoot, "plans"));
  try {
    const existing = await readWorkflowPlanV1({ root: resolvedRoot, planId: canonical.planId });
    if (existing.planDigest !== canonical.planDigest) {
      throw new Error("Workflow plan " + canonical.planId + " is immutable and already bound to a different digest");
    }
    return { plan: existing, path: target, created: false };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  rejectAuthoredModelObservations(canonical.taskContract);
  const created = await createImmutableJson(resolvedRoot, target, canonical);
  if (!created) {
    const existing = await readWorkflowPlanV1({ root: resolvedRoot, planId: canonical.planId });
    if (existing.planDigest !== canonical.planDigest) {
      throw new Error("Workflow plan " + canonical.planId + " is immutable and already bound to a different digest");
    }
    return { plan: existing, path: target, created: false };
  }
  return { plan: canonical, path: target, created: true };
}

export async function readWorkflowPlanV1({ root = getStateRoot(), planId } = {}) {
  const resolvedRoot = path.resolve(root);
  const target = workflowPlanPath(resolvedRoot, planId);
  return canonicalizeWorkflowPlanV1(await readJson(resolvedRoot, target));
}

function expectedBindingDigest(expected) {
  if (expected === undefined || expected === null) return null;
  if (typeof expected === "string") return expected;
  if (isObject(expected)) return expected.digest ?? null;
  return null;
}

export async function readFreshWorkflowPlanV1({ root = getStateRoot(), planId, expected = null } = {}) {
  const plan = await readWorkflowPlanV1({ root, planId });
  if (expected === null || expected === undefined) return plan;
  if (!isObject(expected)) fail("freshness.expected", "must be an object");
  const bindings = plan.taskContract.bindings;
  const checks = [
    ["planDigest", expected.planDigest, plan.planDigest],
    ["contractDigest", expected.contractDigest, plan.contractDigest],
    ["sourceRevision", expected.sourceRevision ?? expected.source?.revision, bindings.source.revision],
    ["sourceDigest", expected.sourceDigest ?? expected.sourceBindingDigest ?? expected.source?.digest, bindings.source.digest],
    ["policyDigest", expected.policyDigest ?? expected.policy?.digest, bindings.policy.digest],
    ["templateDigest", expected.templateDigest ?? expected.template?.digest, bindings.template.digest],
    ["routeDigest", expected.routeDigest ?? expected.route?.digest, bindings.route.digest]
  ];
  for (const [label, expectedValue, actualValue] of checks) {
    if (expectedValue !== undefined && expectedValue !== null && expectedValue !== actualValue) {
      throw new Error("Workflow plan freshness check failed: " + label + " changed");
    }
  }
  const hasExpectedReceiptId = Object.hasOwn(expected, "routeReceiptId") ||
    (isObject(expected.route) && Object.hasOwn(expected.route, "receiptId"));
  const expectedReceiptId = Object.hasOwn(expected, "routeReceiptId")
    ? expected.routeReceiptId
    : expected.route?.receiptId;
  if (hasExpectedReceiptId && expectedReceiptId !== bindings.route.receiptId) {
    throw new Error("Workflow plan freshness check failed: route receipt changed");
  }
  for (const [label, expectedValue, actualValue] of [
    ["source", expectedBindingDigest(expected.source), bindings.source.digest],
    ["policy", expectedBindingDigest(expected.policy), bindings.policy.digest],
    ["template", expectedBindingDigest(expected.template), bindings.template.digest],
    ["route", expectedBindingDigest(expected.route), bindings.route.digest]
  ]) {
    if (expectedValue !== null && expectedValue !== actualValue) {
      throw new Error("Workflow plan freshness check failed: " + label + " binding changed");
    }
  }
  return plan;
}

export function isWorkflowPlanV1(value) {
  try {
    validateWorkflowPlanV1(value);
    return true;
  } catch {
    return false;
  }
}

export function canonicalWorkflowPlanJson(value) {
  return canonicalJson(canonicalizeWorkflowPlanV1(value));
}
