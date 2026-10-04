import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Recorded private R7 source identity, verified at public extraction time.
// This structural checker grants no runtime, dispatch or effect authority.
const R7_SOURCE_DIGEST = "2694daf569ea621e21bbb607631c037034399a7f21c81042a7188acab4c4934b";
// Reviewed R8 public rows have a separate identity; this does not reread or
// authenticate the private original. An intentional matrix revision needs review.
const R8_ROWS_DIGEST = "04f898b8b7913da21b58eed41e2daa1eae9462832f0758bd6f4010d0a5e4bd86";
// Reviewed immutable planning metadata; mutable execution state stays outside.
const REVIEWED_BACKLOG_METADATA_DIGEST = "788fb69987c733a01d4b566535ee71b1f69cb161472c479a8f357832a8acf4a8";
// No READY packet is currently reviewed. Root must verify actual source/policy,
// dependencies and admission before a reviewed revision adds a packet digest.
// A digest declared by the packet itself cannot establish that frozen baseline.
const REVIEWED_READY_PACKET_DIGESTS = Object.freeze({});
const IMMUTABLE_TASK_FIELDS = Object.freeze([
  "code", "title", "issueNumber", "sources", "owner", "version", "requirements", "dependencies",
  "reservedPaths", "contract", "localeIds", "dispatchMode", "readOnlyInspectionAllowed"
]);
// Only these execution annotations may vary without changing the pinned metadata.
// contractDigest is derived separately from the pinned planning contract.
const MUTABLE_TASK_FIELDS = Object.freeze(["state", "detail", "readinessBlocker", "dispatchPacket"]);
const BACKLOG_ROOT_FIELDS = Object.freeze([
  "developmentBase", "kind", "schemaVersion", "sourceNumberNamespace", "sourceRepository", "tasks"
]);
const REQUIREMENTS_ROOT_FIELDS = Object.freeze([
  "schemaVersion", "kind", "sourceDigest", "developmentBase", "counts", "rows", "coverage",
  "leafTrackingTotal", "gaEligibleTotal"
]);
const REQUIREMENT_COUNTS = Object.freeze({ 必交: 74, 決策: 17, 條件: 9, 研究: 2 });
const TASK_REQUIRED_FIELDS = Object.freeze([
  "code", "contract", "contractDigest", "dependencies", "detail", "dispatchMode", "issueNumber",
  "owner", "requirements", "reservedPaths", "sources", "state", "title", "version"
]);
const TASK_OPTIONAL_FIELDS = Object.freeze([
  "readOnlyInspectionAllowed", ...MUTABLE_TASK_FIELDS.filter(key => !TASK_REQUIRED_FIELDS.includes(key))
]);
const CONTRACT_KEYS = ["base", "beforeWrite", "code", "compatibility", "forbidden", "owner", "reservedPaths"];
const SUMMARY_IDS = new Set(["33", "36", "82", "87", "88", "89"]);
const SUB_IDS = ["33a", "33b", "33c", "33d", "33e", "33f",
  "36a", "36b", "82a", "82b", "87a", "87b", "88a", "88b", "89a", "89b"];
const EXPECTED_LEAVES = [...Array.from({ length: 92 }, (_, i) => String(i + 1))
  .filter(id => !SUMMARY_IDS.has(id)), ...SUB_IDS].sort();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function validatedRequirementsContext(requirements, base, sourceDigest) {
  assert.ok(requirements && typeof requirements === "object" && !Array.isArray(requirements), "dispatch requirements context missing");
  exact(requirements, REQUIREMENTS_ROOT_FIELDS, "requirements root");
  exact(requirements.counts, Object.keys(REQUIREMENT_COUNTS), "requirements counts");
  exact(requirements.coverage, EXPECTED_LEAVES, "requirements coverage");
  assert.equal(requirements.kind, "V51RequirementsCatalog", "requirements kind drift");
  assert.equal(requirements.schemaVersion, 1);
  assert.ok(Array.isArray(requirements.rows), "requirements rows must be an array");
  assert.equal(requirements.sourceDigest, R7_SOURCE_DIGEST, "R7 source identity drift");
  assert.equal(requirements.sourceDigest, sourceDigest, "dispatch requirements source mismatch");
  assert.equal(requirements.developmentBase, base, "dispatch requirements base mismatch");
  assert.match(base, /^[a-f0-9]{40}$/);
  const rowMap = new Map(requirements.rows.map(row => [row.id, row]));
  assert.equal(rowMap.size, requirements.rows.length, "duplicate requirement ID");
  const leaves = requirements.rows.filter(row => row.category !== "彙總");
  assert.deepEqual(leaves.map(row => row.id).sort(), EXPECTED_LEAVES, "leaf ID set drift");
  assert.equal(leaves.length, 102, "leaf denominator drift");
  assert.equal(requirements.leafTrackingTotal, 102);
  assert.equal(requirements.gaEligibleTotal, 100, "P1 research must stay outside GA");
  for (const [category, count] of Object.entries(REQUIREMENT_COUNTS)) {
    assert.equal(leaves.filter(row => row.category === category).length, count, category);
    assert.equal(requirements.counts[category], count);
  }
  assert.equal(rowMap.get("91")?.category, "必交", "website leaf missing");
  assert.equal(hash(requirements.rows), R8_ROWS_DIGEST, "reviewed R8 rows drift");
  return rowMap;
}

export function validateV51Catalog(requirements, backlog) {
  const rowMap = validatedRequirementsContext(requirements, backlog?.developmentBase, requirements?.sourceDigest);
  const leaves = requirements.rows.filter(row => row.category !== "彙總");
  exact(backlog, BACKLOG_ROOT_FIELDS, "backlog root");
  assert.equal(backlog.schemaVersion, 1);
  for (const key of ["kind", "sourceRepository", "sourceNumberNamespace"]) text(backlog[key], "backlog " + key);
  assert.ok(Array.isArray(backlog.tasks), "backlog tasks must be an array");
  for (const task of backlog.tasks) validateTaskShape(task);
  const tasks = new Map(backlog.tasks.map(task => [task.code, task]));
  assert.equal(tasks.size, backlog.tasks.length, "duplicate task code");
  const owners = new Map();
  const numbers = new Set();
  for (const task of tasks.values()) {
    assert.ok(["R", "W", "Q"].includes(task.owner));
    assert.ok(["READY", "BLOCKED", "UNTRIGGERED"].includes(task.state));
    assert.ok(["V5.0", "V5.1"].includes(task.version));
    assert.equal(new Set(task.requirements).size, task.requirements.length);
    for (const id of task.requirements) assert.ok(rowMap.has(id) && rowMap.get(id).category !== "彙總", "invalid leaf " + id);
    for (const dependency of task.dependencies) assert.ok(tasks.has(dependency), "missing dependency " + dependency);
    assert.ok(task.contract && typeof task.contract === "object" && !Array.isArray(task.contract), "planning contract missing");
    const localeTask = /^RC2-L(12|14|13)$/.test(task.code);
    assert.deepEqual(Object.keys(task.contract).sort(), [...CONTRACT_KEYS, ...(localeTask ? ["localeIds", "provenance"] : [])].sort(),
      "unknown or missing planning contract field");
    for (const field of ["reservedPaths", "beforeWrite", "forbidden"])
      assert.ok(Array.isArray(task.contract[field]) && task.contract[field].length > 0
        && task.contract[field].every(value => typeof value === "string" && value.trim()), "invalid planning contract " + field);
    assert.ok(task.contract.compatibility === null || typeof task.contract.compatibility === "string", "invalid compatibility");
    if (localeTask) {
      assert.deepEqual(task.contract.localeIds, task.localeIds, "locale contract mismatch");
      assert.equal(task.contract.localeIds.length, Number(task.code.slice(5)), "locale count mismatch");
      assert.ok(typeof task.contract.provenance === "string" && task.contract.provenance.trim(), "locale provenance missing");
    }
    const digest = createHash("sha256").update(JSON.stringify(canonical(task.contract))).digest("hex");
    assert.equal(digest, task.contractDigest, "contract digest drift " + task.code);
    assert.equal(task.contract.code, task.code, "contract code mismatch");
    assert.equal(task.contract.base, backlog.developmentBase, "contract base mismatch");
    assert.equal(task.contract.owner, task.owner, "contract owner mismatch");
    assert.deepEqual(task.contract.reservedPaths, task.reservedPaths, "contract paths mismatch");
    const categories = task.requirements.map(id => rowMap.get(id).category);
    if (categories.includes("研究")) assert.equal(task.state, "UNTRIGGERED", "P1 remains outside this execution");
    if (task.state === "READY") {
      validateV51DispatchPacket(task, task.dispatchPacket, backlog.developmentBase, requirements.sourceDigest, requirements);
      assert.ok(Object.hasOwn(REVIEWED_READY_PACKET_DIGESTS, task.code), "READY requires a reviewed dispatch packet baseline");
      assert.equal(task.dispatchPacket.packetDigest, REVIEWED_READY_PACKET_DIGESTS[task.code], "reviewed dispatch packet drift");
    }
    if (task.issueNumber !== null) {
      assert.ok(Number.isSafeInteger(task.issueNumber) && task.issueNumber > 0);
      assert.ok(!numbers.has(task.issueNumber), "duplicate issue number");
      numbers.add(task.issueNumber);
    }
    if (task.owner !== "R") for (const path of task.reservedPaths) {
      const reserved = portablePathKey(path, "unsafe reserved path");
      for (const previous of owners.keys()) assert.ok(previous !== reserved
        && !previous.startsWith(reserved + "/") && !reserved.startsWith(previous + "/"), "overlapping worker scope " + reserved);
      owners.set(reserved, task.code);
    }
  }
  for (const row of leaves) {
    const actual = [...tasks.values()].filter(task => task.requirements.includes(row.id)).map(task => task.code);
    assert.ok(actual.length, "uncovered leaf " + row.id);
    assert.deepEqual(requirements.coverage[row.id], actual, "coverage drift " + row.id);
  }
  const done = new Set();
  function visit(code, active) {
    assert.ok(!active.has(code), "dependency cycle " + code);
    if (done.has(code)) return;
    const next = new Set(active).add(code);
    for (const dependency of tasks.get(code).dependencies) visit(dependency, next);
    done.add(code);
  }
  for (const code of tasks.keys()) visit(code, new Set());
  assert.equal(tasks.size, 122, "reviewed task count drift");
  const localeGroups = [...tasks.values()].filter(task => Array.isArray(task.localeIds))
    .map(task => [task.code, task.localeIds.length]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  assert.deepEqual(localeGroups, [["RC2-L12", 12], ["RC2-L13", 13], ["RC2-L14", 14]], "reviewed RC2 locale group sizes drift");
  const localeIds = [...tasks.values()].flatMap(task => task.localeIds ?? []);
  assert.equal(localeIds.length, 39, "reviewed RC2 locale count drift");
  assert.equal(new Set(localeIds).size, 39, "RC2 locale IDs must remain globally unique");
  const metadata = {
    kind: backlog.kind, schemaVersion: backlog.schemaVersion, developmentBase: backlog.developmentBase,
    sourceNumberNamespace: backlog.sourceNumberNamespace, sourceRepository: backlog.sourceRepository,
    tasks: backlog.tasks.map(task => Object.fromEntries(IMMUTABLE_TASK_FIELDS
      .filter(key => Object.hasOwn(task, key)).map(key => [key, task[key]])))
      .sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
  };
  assert.equal(hash(metadata), REVIEWED_BACKLOG_METADATA_DIGEST, "reviewed backlog metadata drift");
  return { tasks: tasks.size, leaf: leaves.length, counts: requirements.counts, mappedIssues: numbers.size };
}

function validateTaskShape(task) {
  assert.ok(task && typeof task === "object" && !Array.isArray(task), "task record must be an object");
  const localeTask = typeof task.code === "string" && /^RC2-L(12|14|13)$/.test(task.code);
  exact(task, [...TASK_REQUIRED_FIELDS, ...(localeTask ? ["localeIds"] : []),
    ...TASK_OPTIONAL_FIELDS.filter(key => Object.hasOwn(task, key))], "task record");
  text(task.code, "task code"); text(task.title, "task title");
  assert.equal(typeof task.detail, "string", "task detail must be a string");
  if (Object.hasOwn(task, "readOnlyInspectionAllowed"))
    assert.equal(typeof task.readOnlyInspectionAllowed, "boolean", "task readOnlyInspectionAllowed must be boolean");
  if (Object.hasOwn(task, "readinessBlocker")) text(task.readinessBlocker, "task readinessBlocker");
  if (Object.hasOwn(task, "dispatchPacket"))
    assert.ok(task.dispatchPacket && typeof task.dispatchPacket === "object" && !Array.isArray(task.dispatchPacket),
      "task dispatchPacket must be an object");
}

function hash(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function exact(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label + " must be an object");
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label + " has unknown or missing field");
}
function text(value, label) { assert.ok(typeof value === "string" && value.trim(), label + " missing"); }
function strings(value, label) {
  assert.ok(Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string" && item.trim()), label + " missing");
}
function timestamp(value, label) {
  assert.ok(typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, label + " must be an ISO UTC timestamp");
}
function sha256(value, label) { assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), label + " invalid"); }
// Conservative lexical identity for unknown/cross-platform hosts. This is an
// ASCII path contract, not a Unicode filesystem equivalence implementation.
// Preserve the original spelling in records; fold only the comparison key.
// Physical symlink/hardlink/short-name identity remains Root admission work.
function portablePathKey(value, label) {
  assert.ok(typeof value === "string" && /^[A-Za-z0-9._/-]+$/.test(value),
    label + ": portable ASCII repository path required");
  const parts = value.split("/");
  assert.ok(parts.every(part => part && part !== "." && part !== ".." && !part.endsWith(".")
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
    label + ": invalid or platform-aliased component");
  return value.toLowerCase();
}
// Entry criteria are frozen planning semantics, not adoption/outcome criteria.
const CONDITIONAL_CRITERIA = Object.freeze({
  "34": "storage-hotspot-v1",
  "36b": "track-r-entry-v1", "37": "track-r-entry-v1", "38": "track-r-entry-v1",
  "39": "track-r-entry-v1", "40": "track-r-entry-v1", "41": "track-r-entry-v1",
  "42": "track-r-entry-v1", "43": "track-r-entry-v1"
});

function validateConditionalTrigger(packet, rows, base, sourceDigest) {
  const trigger = packet.conditionalTrigger;
  exact(trigger, ["evaluatedAt", "bindings"], "conditional trigger");
  timestamp(trigger.evaluatedAt, "conditional trigger evaluation");
  const evaluatedMs = Date.parse(trigger.evaluatedAt);
  assert.ok(evaluatedMs < Date.parse(packet.workspaceLease.expiresAt) && evaluatedMs < Date.parse(packet.budget.deadline),
    "conditional trigger snapshot must precede lease and budget expiry");
  assert.ok(Array.isArray(trigger.bindings), "conditional trigger bindings missing");
  const ids = trigger.bindings.map(binding => binding?.leafId);
  assert.equal(new Set(ids).size, ids.length, "duplicate conditional trigger leaf");
  assert.deepEqual([...ids].sort(), rows.map(row => row.id).sort(), "conditional trigger leaves mismatch");
  for (const binding of trigger.bindings) {
    exact(binding, ["leafId", "rowDigest", "criterionId", "evidenceDigest", "sourceDigest", "base", "policyDigest", "observedAt", "expiresAt"], "conditional trigger binding");
    const row = rows.find(row => row.id === binding.leafId);
    sha256(binding.rowDigest, "conditional trigger row digest");
    assert.equal(binding.rowDigest, hash(row), "conditional trigger row mismatch");
    assert.equal(binding.criterionId, CONDITIONAL_CRITERIA[row.id], "conditional trigger criterion mismatch");
    sha256(binding.evidenceDigest, "conditional trigger evidence digest");
    assert.equal(binding.sourceDigest, sourceDigest, "conditional trigger source mismatch");
    assert.equal(binding.base, base, "conditional trigger base mismatch");
    sha256(binding.policyDigest, "conditional trigger policy digest");
    assert.equal(binding.policyDigest, packet.contractDetails.policyBinding.digest, "conditional trigger policy mismatch");
    timestamp(binding.observedAt, "conditional trigger observation");
    timestamp(binding.expiresAt, "conditional trigger expiry");
    assert.ok(Date.parse(binding.observedAt) <= evaluatedMs && evaluatedMs < Date.parse(binding.expiresAt),
      "conditional trigger observation is not current at evaluation");
  }
}

// Structural validation only; this export does not establish catalog READY.
export function validateV51DispatchPacket(task, packet, base, sourceDigest, requirements) {
  const rowMap = validatedRequirementsContext(requirements, base, sourceDigest);
  assert.ok(Array.isArray(task.requirements) && new Set(task.requirements).size === task.requirements.length, "dispatch task requirements invalid");
  const rows = task.requirements.map(id => {
    const row = rowMap.get(id);
    assert.ok(row && row.category !== "彙總", "invalid dispatch leaf " + id);
    assert.notEqual(row.category, "研究", "P1 remains outside this execution");
    return row;
  });
  const conditionalRows = rows.filter(row => row.category === "條件");
  assert.ok(packet && packet.schemaVersion === 2, "READY needs a frozen dispatch packet");
  exact(packet, ["schemaVersion", "issue", "owner", "integrationOwner", "reviewers", "sourceDigest", "base", "contractDigest",
    "contractDetails", "reservedPaths", "workspaceLease", "environment", "acceptance", "budget", "stopConditions", "rollback",
    "lifecycle", "dependencyReceipts", "packetDigest", ...(conditionalRows.length ? ["conditionalTrigger"] : [])], "dispatch packet");
  assert.equal(packet.issue, task.code, "dispatch issue mismatch");
  exact(packet.owner, ["id", "role"], "dispatch owner"); text(packet.owner.id, "dispatch owner ID");
  assert.equal(packet.owner.role, task.owner, "dispatch owner role mismatch");
  exact(packet.integrationOwner, ["id", "role"], "dispatch integration owner"); text(packet.integrationOwner.id, "dispatch integration owner ID");
  assert.equal(packet.integrationOwner.role, "R", "dispatch integration owner must be Root");
  assert.ok(Array.isArray(packet.reviewers) && packet.reviewers.length > 0, "dispatch reviewer missing");
  const reviewerIds = new Set();
  for (const reviewer of packet.reviewers) {
    exact(reviewer, ["id", "role"], "dispatch reviewer"); text(reviewer.id, "dispatch reviewer ID");
    assert.ok(["R", "W", "Q"].includes(reviewer.role), "invalid dispatch reviewer role");
    assert.ok(reviewer.id !== packet.owner.id && !reviewerIds.has(reviewer.id), "dispatch reviewer must be distinct"); reviewerIds.add(reviewer.id);
  }
  assert.equal(packet.sourceDigest, sourceDigest, "dispatch source mismatch");
  assert.equal(packet.base, base, "dispatch base mismatch");
  assert.equal(packet.contractDigest, task.contractDigest, "dispatch contract mismatch");
  assert.deepEqual(packet.reservedPaths, task.reservedPaths, "dispatch paths mismatch");
  if (task.owner !== "R") {
    const writePaths = [];
    for (const path of packet.reservedPaths) {
      const key = portablePathKey(path, "unsafe reserved path");
      assert.ok(writePaths.every(previous => previous !== key && !previous.startsWith(key + "/")
        && !key.startsWith(previous + "/")), "overlapping worker scope " + path);
      writePaths.push(key);
    }
  }
  const details = packet.contractDetails;
  exact(details, ["schema", "exports", "errors", "callbacks", "bytes", "storage", "sourceBinding", "policyBinding"], "dispatch contract details");
  for (const key of ["schema", "exports", "errors", "callbacks", "bytes", "storage"]) text(details[key], "dispatch contract " + key);
  exact(details.sourceBinding, ["base", "head", "files"], "dispatch contract source binding");
  assert.equal(details.sourceBinding.base, base, "dispatch source binding base mismatch");
  assert.equal(details.sourceBinding.head, base, "dispatch source binding head mismatch");
  assert.ok(Array.isArray(details.sourceBinding.files) && details.sourceBinding.files.length > 0, "dispatch source files missing");
  const filePaths = new Set();
  for (const file of details.sourceBinding.files) {
    exact(file, ["path", "status", "sha256"], "dispatch source file"); text(file.path, "dispatch source path");
    const fileKey = portablePathKey(file.path, "unsafe dispatch source path");
    assert.ok(!filePaths.has(fileKey), "duplicate dispatch source path"); filePaths.add(fileKey);
    assert.ok(["PRESENT", "ABSENT"].includes(file.status), "invalid dispatch source file status");
    if (file.status === "PRESENT") sha256(file.sha256, "dispatch source file digest"); else assert.equal(file.sha256, null, "absent source must have null digest");
  }
  exact(details.policyBinding, ["id", "digest"], "dispatch contract policy binding"); text(details.policyBinding.id, "dispatch policy ID");
  sha256(details.policyBinding.digest, "dispatch policy digest");
  exact(packet.workspaceLease, ["id", "ownerId", "branch", "worktreePath", "expiresAt"], "dispatch workspace lease");
  for (const key of ["id", "branch", "worktreePath"]) text(packet.workspaceLease[key], "dispatch workspace lease " + key);
  assert.ok(packet.workspaceLease.branch.startsWith("codex/"), "dispatch branch must use codex prefix");
  assert.equal(packet.workspaceLease.ownerId, packet.owner.id, "dispatch lease owner mismatch"); timestamp(packet.workspaceLease.expiresAt, "dispatch lease expiry");
  exact(packet.environment, ["host", "nodeVersion", "toolVersions"], "dispatch environment");
  exact(packet.environment.host, ["os", "arch"], "dispatch host"); text(packet.environment.host.os, "dispatch host OS"); text(packet.environment.host.arch, "dispatch host architecture");
  assert.ok(typeof packet.environment.nodeVersion === "string" && /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(packet.environment.nodeVersion), "dispatch Node version missing");
  const tools = packet.environment.toolVersions;
  assert.ok(tools && typeof tools === "object" && !Array.isArray(tools) && Object.keys(tools).length > 0, "dispatch tool versions missing");
  for (const [tool, version] of Object.entries(tools)) { assert.ok(/^[A-Za-z0-9_.+-]+$/.test(tool), "invalid dispatch tool name"); text(version, "dispatch tool version"); }
  exact(packet.acceptance, ["commands", "positiveCases", "negativeCases", "compatibility"], "dispatch acceptance");
  for (const key of ["commands", "positiveCases", "negativeCases"]) strings(packet.acceptance[key], "dispatch acceptance " + key);
  assert.ok(packet.acceptance.compatibility === null || typeof packet.acceptance.compatibility === "string", "invalid dispatch compatibility");
  assert.equal(packet.acceptance.compatibility, task.contract.compatibility, "dispatch compatibility mismatch");
  exact(packet.budget, ["attempts", "deadline", "tokenBudget", "unknownTokens", "noProgressLimit"], "dispatch budget");
  assert.ok(Number.isSafeInteger(packet.budget.attempts) && packet.budget.attempts > 0, "invalid dispatch attempt budget"); timestamp(packet.budget.deadline, "dispatch deadline");
  assert.ok(packet.budget.tokenBudget === null || (Number.isSafeInteger(packet.budget.tokenBudget) && packet.budget.tokenBudget > 0), "invalid dispatch token budget");
  assert.ok(["STOP", "BOUND_BY_ATTEMPTS_AND_DEADLINE"].includes(packet.budget.unknownTokens), "invalid unknown token rule");
  assert.equal(packet.budget.noProgressLimit, 2, "dispatch no-progress limit must remain two"); strings(packet.stopConditions, "dispatch stop conditions");
  exact(packet.rollback, ["trigger", "procedure"], "dispatch rollback"); text(packet.rollback.trigger, "dispatch rollback trigger"); text(packet.rollback.procedure, "dispatch rollback procedure");
  exact(packet.lifecycle, ["ownerId", "recordPidPpidDescendants", "recordCwd", "recordPortsSockets", "cleanupMethod"], "dispatch lifecycle");
  assert.equal(packet.lifecycle.ownerId, packet.owner.id, "dispatch lifecycle owner mismatch");
  for (const key of ["recordPidPpidDescendants", "recordCwd", "recordPortsSockets"]) assert.equal(packet.lifecycle[key], true, "dispatch lifecycle must record " + key);
  text(packet.lifecycle.cleanupMethod, "dispatch lifecycle cleanup method");
  assert.ok(Array.isArray(packet.dependencyReceipts), "dispatch dependency receipts missing");
  const receiptTasks = packet.dependencyReceipts.map(receipt => receipt?.task);
  assert.equal(new Set(receiptTasks).size, receiptTasks.length, "duplicate dispatch dependency receipt");
  assert.deepEqual([...receiptTasks].sort(), [...task.dependencies].sort(), "dispatch dependency receipts mismatch");
  for (const receipt of packet.dependencyReceipts) {
    exact(receipt, ["task", "sourceDigest", "base", "receiptDigest"], "dispatch dependency receipt");
    assert.equal(receipt.base, base, "dispatch dependency receipt base mismatch"); assert.equal(receipt.sourceDigest, sourceDigest, "dispatch dependency receipt source mismatch");
    sha256(receipt.receiptDigest, "dispatch dependency receipt digest");
  }
  if (conditionalRows.length) validateConditionalTrigger(packet, conditionalRows, base, sourceDigest);
  const unsigned = Object.fromEntries(Object.entries(packet).filter(([key]) => key !== "packetDigest"));
  assert.equal(packet.packetDigest, hash(unsigned), "dispatch packet digest drift");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = new URL("../docs/plans/", import.meta.url);
  const [requirements, backlog] = await Promise.all(["v5-1-requirements.json", "v5-1-backlog.json"]
    .map(async name => JSON.parse(await readFile(new URL(name, base), "utf8"))));
  console.log(JSON.stringify(validateV51Catalog(requirements, backlog), null, 2));
}
