import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { digestObject, sha256 } from "./core.mjs";

const execFileAsync = promisify(execFile);
const CASE_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const DISPOSITIONS = new Set(["IMPLEMENT", "NO_CHANGE", "BLOCKED", "REJECTED_WITH_EVIDENCE"]);
const SECRET_PATTERN = /(?:api[_-]?key|password|passwd|secret|token|authorization)\s*[:=]\s*(?:"[^"\s]{4,}"|'[^'\s]{4,}'|(?=[A-Za-z0-9+/_-]{8,}(?:\s|$))(?=[A-Za-z0-9+/_-]*[0-9+/_-])[A-Za-z0-9+/_-]+)/i;
export const SELF_IMPROVE_LEGACY_CORPUS = "plugins/better-workflows/fixtures/self-improve-ops-evals.json";
export const SELF_IMPROVE_CANONICAL_CORPUS = "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.json";
export const SELF_IMPROVE_EVALUATION_PURPOSES = new Set(["ordinary", "evaluator-migration"]);

const PUBLIC_ROOT_DOCUMENTS = new Set([
  "README.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "GOVERNANCE.md",
  "SECURITY.md",
  "SUPPORT.md"
]);
const MATERIAL_GROUPS = ["runtime", "tests", "config", "skills", "templates", "fixtures", "metadata", "docs"];

function allowedCandidateMaterial(file) {
  return PUBLIC_ROOT_DOCUMENTS.has(file) ||
    /^docs\/README\.(?:zh-TW|zh-CN|ja|ko)\.md$/.test(file) ||
    /^docs\/details\/(?:en|zh-TW|zh-CN|ja|ko)\.md$/.test(file) ||
    /^docs\/guide\/(?:architecture|cli-reference|getting-started|security|workflows)\.md$/.test(file) ||
    file === "docs/assets/better-workflows-engineering-stack.svg" ||
    /^plugins\/better-workflows\/(?:scripts\/.+\.mjs|skills\/.+\.md|templates\/.+\.json|fixtures\/.+\.(?:json|md|mjs)|config\/.+\.json|package\.json|\.codex-plugin\/plugin\.json)$/.test(file);
}

function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (value.length > 4_000) throw new Error(`${label} exceeds the bounded evaluation limit`);
  if (SECRET_PATTERN.test(value)) throw new Error(`${label} contains secret-shaped material`);
}

function assertExactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field(s): ${unknown.sort().join(", ")}`);
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeRelative(value, label) {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) throw new Error(`${label} must be a relative path`);
  const normalized = path.posix.normalize(value.replaceAll(path.sep, "/"));
  if (normalized === ".." || normalized.startsWith("../")) throw new Error(`${label} escapes its root`);
  return normalized;
}

function validateCases(cases, classIds = null) {
  if (!Array.isArray(cases) || cases.length < 2 || cases.length > 20) throw new Error("Evaluation suite must contain 2..20 cases");
  const ids = new Set();
  const splits = new Set();
  const classSplits = new Map();
  for (const item of cases) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Evaluation cases must be objects");
    assertExactKeys(item, new Set(["id", "split", "scenario", "expectedDisposition", "assertions", "evaluationClass"]), `Case ${item.id ?? "<unknown>"}`);
    if (!CASE_ID.test(item.id ?? "") || ids.has(item.id)) throw new Error("Evaluation case ids must be unique safe identifiers");
    ids.add(item.id);
    if (!new Set(["train", "holdout"]).has(item.split)) throw new Error(`Case ${item.id} has an invalid split`);
    splits.add(item.split);
    assertString(item.scenario, `Case ${item.id} scenario`);
    if (!DISPOSITIONS.has(item.expectedDisposition)) throw new Error(`Case ${item.id} has an invalid expected disposition`);
    if (classIds) {
      if (!classIds.has(item.evaluationClass)) throw new Error(`Case ${item.id} references an unknown evaluation class`);
      if (!classSplits.has(item.evaluationClass)) classSplits.set(item.evaluationClass, new Set());
      classSplits.get(item.evaluationClass).add(item.split);
    } else if (item.evaluationClass !== undefined) {
      throw new Error(`Legacy case ${item.id} cannot declare evaluationClass`);
    }
    if (!Array.isArray(item.assertions) || item.assertions.length < 1 || item.assertions.length > 12) throw new Error(`Case ${item.id} must have 1..12 assertions`);
    const assertionIds = new Set();
    let hardSafety = false;
    for (const assertion of item.assertions) {
      if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) throw new Error(`Case ${item.id} has malformed assertions`);
      assertExactKeys(assertion, new Set(["id", "description", "hardSafety"]), `Case ${item.id} assertion ${assertion.id ?? "<unknown>"}`);
      if (!CASE_ID.test(assertion.id ?? "") || assertionIds.has(assertion.id)) throw new Error(`Case ${item.id} has invalid assertion ids`);
      assertionIds.add(assertion.id);
      assertString(assertion.description, `Case ${item.id} assertion ${assertion.id}`);
      if (typeof assertion.hardSafety !== "boolean") throw new Error(`Case ${item.id} assertion ${assertion.id} must declare hardSafety`);
      hardSafety ||= assertion.hardSafety;
    }
    if (!hardSafety) throw new Error(`Case ${item.id} must include a hard safety assertion`);
  }
  if (!splits.has("train") || !splits.has("holdout")) throw new Error("Evaluation suite must contain isolated train and holdout cases");
  if (classIds) {
    for (const classId of classIds) {
      if (classSplits.get(classId)?.size !== 2) throw new Error(`Evaluation class ${classId} must contain train and holdout cases`);
    }
  }
}

export function validateEvaluationSuite(suite) {
  if (!suite || typeof suite !== "object" || Array.isArray(suite)) throw new Error("Evaluation suite must be an object");
  if (![1, 2].includes(suite.schemaVersion)) throw new Error("Evaluation suite schemaVersion must be 1 or 2");
  assertString(suite.name, "Evaluation suite name");
  if (suite.schemaVersion === 1) {
    assertExactKeys(suite, new Set(["schemaVersion", "name", "cases"]), "Legacy evaluation suite");
    validateCases(suite.cases);
    return suite;
  }
  assertExactKeys(suite, new Set(["schemaVersion", "name", "classes", "cases"]), "Evaluation suite v2");
  if (!Array.isArray(suite.classes) || suite.classes.length < 2 || suite.classes.length > 8) throw new Error("Evaluation suite v2 must contain 2..8 classes");
  const classIds = new Set();
  let invariantCount = 0;
  let improvementCount = 0;
  for (const item of suite.classes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Evaluation classes must be objects");
    assertExactKeys(item, new Set(["id", "kind", "paths", "description"]), `Evaluation class ${item.id ?? "<unknown>"}`);
    if (!CASE_ID.test(item.id ?? "") || classIds.has(item.id)) throw new Error("Evaluation class ids must be unique safe identifiers");
    classIds.add(item.id);
    assertString(item.description, `Evaluation class ${item.id} description`);
    if (!new Set(["invariant", "improvement"]).has(item.kind)) throw new Error(`Evaluation class ${item.id} has an invalid kind`);
    if (item.kind === "invariant") {
      invariantCount += 1;
      if (item.paths !== undefined) throw new Error(`Invariant evaluation class ${item.id} cannot declare paths`);
    } else {
      improvementCount += 1;
      if (!Array.isArray(item.paths) || item.paths.length < 1 || item.paths.length > 24) throw new Error(`Improvement evaluation class ${item.id} must declare 1..24 paths`);
      for (const [index, value] of item.paths.entries()) {
        const normalized = safeRelative(value, `Evaluation class ${item.id} path ${index}`);
        if (normalized !== value.replaceAll(path.sep, "/") || normalized === ".") throw new Error(`Evaluation class ${item.id} has a non-canonical path`);
      }
    }
  }
  if (invariantCount !== 1 || improvementCount < 1) throw new Error("Evaluation suite v2 requires exactly one invariant class and at least one improvement class");
  validateCases(suite.cases, classIds);
  return suite;
}

export async function readEvaluationSuite(file) {
  return validateEvaluationSuite(JSON.parse(await readFile(file, "utf8")));
}

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}

async function gitBytes(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  return Buffer.from(result.stdout);
}

export async function resolveBaselineRevision(cwd, revision) {
  assertString(revision, "Baseline revision");
  return (await git(cwd, ["rev-parse", "--verify", `${revision}^{commit}`])).trim();
}

export async function loadFrozenEvaluationSuite({ cwd, casesFile, baselineRevision, canonical = true, purpose = "ordinary" }) {
  const repository = await realpath(cwd);
  const absolute = path.resolve(casesFile);
  if (!isWithin(repository, absolute)) throw new Error("Evaluation suite must be inside the repository");
  const relative = safeRelative(path.relative(repository, absolute), "Evaluation suite path");
  if (!SELF_IMPROVE_EVALUATION_PURPOSES.has(purpose)) throw new Error("Unknown self-improve evaluation purpose");
  const canonicalPath = purpose === "evaluator-migration" ? SELF_IMPROVE_LEGACY_CORPUS : SELF_IMPROVE_CANONICAL_CORPUS;
  if (canonical && relative !== canonicalPath) throw new Error(`Production ${purpose} evaluation suite must be ${canonicalPath}`);
  const baseline = await resolveBaselineRevision(repository, baselineRevision);
  let frozen;
  try {
    frozen = await gitBytes(repository, ["show", `${baseline}:${relative}`]);
  } catch {
    throw new Error("Evaluation suite is absent from the immutable baseline");
  }
  const current = await readFile(absolute);
  if (!current.equals(frozen)) throw new Error("Evaluation suite drifted from the immutable baseline");
  return { suite: validateEvaluationSuite(JSON.parse(current.toString("utf8"))), baselineRevision: baseline, relativePath: relative, sourceDigest: sha256(current) };
}

export async function loadMigrationTargetSuite({ cwd, casesFile }) {
  const repository = await realpath(cwd);
  const absolute = path.resolve(casesFile);
  if (!isWithin(repository, absolute)) throw new Error("Migration target suite must be inside the repository");
  const relative = safeRelative(path.relative(repository, absolute), "Migration target suite path");
  if (relative !== SELF_IMPROVE_CANONICAL_CORPUS) throw new Error(`Migration target suite must be ${SELF_IMPROVE_CANONICAL_CORPUS}`);
  const bytes = await readFile(absolute);
  const suite = validateEvaluationSuite(JSON.parse(bytes.toString("utf8")));
  if (suite.schemaVersion !== 2) throw new Error("Migration target suite must use schemaVersion 2");
  return { suite, relativePath: relative, sourceDigest: sha256(bytes) };
}

export function evaluationBindingDigest({ purpose = "ordinary", sourceSuiteDigest, targetSuiteDigest = null }) {
  if (!SELF_IMPROVE_EVALUATION_PURPOSES.has(purpose)) throw new Error("Unknown self-improve evaluation purpose");
  if (purpose === "ordinary") return sourceSuiteDigest;
  if (!targetSuiteDigest) throw new Error("Evaluator migration requires a target suite digest");
  return digestObject({ purpose, sourceSuiteDigest, targetSuiteDigest });
}

function splitNul(value) {
  return value.split("\0").filter(Boolean).map((item) => item.replaceAll("\\", "/"));
}

function covered(root, file) {
  return root === "." || file === root || file.startsWith(`${root}/`);
}

export async function snapshotCandidate({ cwd, baselineRevision, candidateRoot }) {
  const repository = await realpath(cwd);
  const baseline = await resolveBaselineRevision(repository, baselineRevision);
  const absoluteRoot = path.resolve(repository, candidateRoot);
  const rootInfo = await lstat(absoluteRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Candidate root must be a real directory");
  const resolvedRoot = await realpath(absoluteRoot);
  if (!isWithin(repository, resolvedRoot)) throw new Error("Candidate root escapes the repository");
  const relativeRoot = safeRelative(path.relative(repository, resolvedRoot) || ".", "Candidate root");
  const changed = new Set(splitNul(await git(repository, ["diff", "--name-only", "--no-renames", "-z", baseline])));
  for (const file of splitNul(await git(repository, ["ls-files", "--others", "--exclude-standard", "-z"]))) changed.add(file);
  const uncovered = [...changed].filter((file) => !covered(relativeRoot, file));
  if (uncovered.length > 0) throw new Error(`Candidate root does not cover changed path(s): ${uncovered.sort().join(", ")}`);
  const files = [];
  for (const file of [...changed].filter((item) => covered(relativeRoot, item)).sort()) {
    const absolute = path.join(repository, file);
    const info = await lstat(absolute).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) files.push({ path: file, state: "missing", digest: null });
    else if (info.isFile() && !info.isSymbolicLink()) {
      const content = await readFile(absolute);
      files.push({ path: file, state: "file", digest: sha256(content), size: content.length });
    } else throw new Error(`Candidate contains non-regular file: ${file}`);
  }
  const snapshot = { baselineRevision: baseline, candidateRoot: relativeRoot, files };
  return { ...snapshot, digest: digestObject(snapshot) };
}

export async function snapshotBaselineForCandidate({ cwd, snapshot }) {
  const repository = await realpath(cwd);
  const files = [];
  for (const file of snapshot.files) {
    try {
      const content = await gitBytes(repository, ["show", `${snapshot.baselineRevision}:${file.path}`]);
      files.push({ path: file.path, state: "file", digest: sha256(content), size: content.length });
    } catch {
      files.push({ path: file.path, state: "missing", digest: null });
    }
  }
  const baseline = { baselineRevision: snapshot.baselineRevision, candidateRoot: snapshot.candidateRoot, files };
  return { ...baseline, digest: digestObject(baseline) };
}

export function candidateMaterialGroup(file) {
  if (file.startsWith("plugins/better-workflows/scripts/tests/")) return "tests";
  if (file.startsWith("plugins/better-workflows/scripts/")) return "runtime";
  if (file.startsWith("plugins/better-workflows/config/")) return "config";
  if (file.startsWith("plugins/better-workflows/skills/")) return "skills";
  if (file.startsWith("plugins/better-workflows/templates/")) return "templates";
  if (file.startsWith("plugins/better-workflows/fixtures/")) return "fixtures";
  if (file === "plugins/better-workflows/package.json" || file === "plugins/better-workflows/.codex-plugin/plugin.json") return "metadata";
  return "docs";
}

function safeUtf8Prefix(content, limit) {
  if (content.length <= limit) return content.toString("utf8");
  for (let end = limit; end >= Math.max(0, limit - 3); end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(0, end));
    } catch {
      // A valid UTF-8 sequence can cross a byte boundary by at most three bytes.
    }
  }
  throw new Error("Unable to create a valid UTF-8 sample");
}

function selectBalancedMaterialFiles(files, maxFiles) {
  const grouped = new Map(MATERIAL_GROUPS.map((group) => [group, []]));
  for (const file of files.filter((item) => item.state === "file")) grouped.get(candidateMaterialGroup(file.path)).push(file);
  for (const values of grouped.values()) values.sort((left, right) => left.path.localeCompare(right.path));
  const selected = [];
  for (let index = 0; selected.length < maxFiles; index += 1) {
    let added = false;
    for (const group of MATERIAL_GROUPS) {
      const file = grouped.get(group)[index];
      if (file && selected.length < maxFiles) {
        selected.push({ ...file, materialGroup: group });
        added = true;
      }
    }
    if (!added) break;
  }
  return selected;
}

async function readBalancedSanitizedMaterial({ snapshot, maxFiles, maxBytes, readContent, label }) {
  for (const file of snapshot.files) {
    if (!allowedCandidateMaterial(file.path)) throw new Error(`${label} material path is outside the sanitized allowlist: ${file.path}`);
  }
  const selected = selectBalancedMaterialFiles(snapshot.files, maxFiles);
  const selectedGroups = MATERIAL_GROUPS.filter((group) => selected.some((file) => file.materialGroup === group));
  const groupBudgets = new Map();
  const baseGroupBudget = Math.floor(maxBytes / Math.max(1, selectedGroups.length));
  let remainder = maxBytes - baseGroupBudget * selectedGroups.length;
  for (const group of selectedGroups) {
    groupBudgets.set(group, baseGroupBudget + (remainder > 0 ? 1 : 0));
    remainder = Math.max(0, remainder - 1);
  }
  const material = [];
  for (const group of selectedGroups) {
    const groupFiles = selected.filter((file) => file.materialGroup === group);
    const budget = groupBudgets.get(group);
    const baseFileBudget = Math.floor(budget / groupFiles.length);
    let fileRemainder = budget - baseFileBudget * groupFiles.length;
    for (const file of groupFiles) {
      const content = await readContent(file);
      if (content.includes(0)) throw new Error(`${label} material is not text: ${file.path}`);
      const text = content.toString("utf8");
      if (Buffer.byteLength(text, "utf8") !== content.length) throw new Error(`${label} material is not valid UTF-8: ${file.path}`);
      if (SECRET_PATTERN.test(text)) throw new Error(`${label} material contains secret-shaped content: ${file.path}`);
      const byteLimit = baseFileBudget + (fileRemainder > 0 ? 1 : 0);
      fileRemainder = Math.max(0, fileRemainder - 1);
      const bounded = safeUtf8Prefix(content, byteLimit);
      material.push({
        path: file.path,
        materialGroup: group,
        content: bounded,
        digest: file.digest,
        sampledBytes: Buffer.byteLength(bounded, "utf8"),
        truncated: content.length > byteLimit
      });
    }
  }
  if (snapshot.files.some((file) => file.state === "file") && material.length === 0) throw new Error(`${label} has no bounded sanitized text material`);
  return material;
}

export async function readSanitizedCandidateMaterial({ cwd, snapshot, maxFiles = 24, maxBytes = 96 * 1024 }) {
  const root = await realpath(cwd);
  return readBalancedSanitizedMaterial({
    snapshot,
    maxFiles,
    maxBytes,
    label: "Candidate",
    readContent: (file) => readFile(path.join(root, file.path))
  });
}

export async function readSanitizedBaselineMaterial({ cwd, snapshot, maxFiles = 24, maxBytes = 96 * 1024 }) {
  const repository = await realpath(cwd);
  return readBalancedSanitizedMaterial({
    snapshot,
    maxFiles,
    maxBytes,
    label: "Baseline",
    readContent: (file) => gitBytes(repository, ["show", `${snapshot.baselineRevision}:${file.path}`])
  });
}

function classMatchesPath(definition, file) {
  return definition.paths.some((candidate) => candidate.endsWith("/") ? file.startsWith(candidate) : file === candidate);
}

export function selectEvaluationCases({ suite, snapshot, split }) {
  if (!new Set(["train", "holdout"]).has(split)) throw new Error("Evaluation split must be train or holdout");
  if (suite.schemaVersion === 1) return suite.cases.filter((item) => item.split === split);
  const applicable = new Set(
    suite.classes
      .filter((definition) => definition.kind === "invariant" || snapshot.files.some((file) => classMatchesPath(definition, file.path)))
      .map((definition) => definition.id)
  );
  if (!suite.classes.some((definition) => definition.kind === "improvement" && applicable.has(definition.id))) {
    throw new Error("Evaluation v2 has no applicable improvement class for this candidate");
  }
  return suite.cases.filter((item) => item.split === split && applicable.has(item.evaluationClass));
}

export function calibrateEvaluatorMigration({ source, target, snapshot, materials, sourceDigest, targetDigest }) {
  if (source.schemaVersion !== 1 || target.schemaVersion !== 2) throw new Error("Evaluator migration must move from schemaVersion 1 to 2");
  const groups = [...new Set(materials.map((item) => item.materialGroup))].sort();
  const expectedGroups = [...new Set(snapshot.files.filter((item) => item.state === "file").map((item) => candidateMaterialGroup(item.path)))].sort();
  if (expectedGroups.some((group) => !groups.includes(group))) throw new Error("Evaluator migration sampling does not cover every changed material group");
  const selected = {
    train: selectEvaluationCases({ suite: target, snapshot, split: "train" }),
    holdout: selectEvaluationCases({ suite: target, snapshot, split: "holdout" })
  };
  const classKinds = new Map(target.classes.map((item) => [item.id, item.kind]));
  for (const [split, cases] of Object.entries(selected)) {
    const kinds = new Set(cases.map((item) => classKinds.get(item.evaluationClass)));
    if (!kinds.has("invariant") || !kinds.has("improvement")) throw new Error(`Evaluator migration ${split} calibration lacks invariant or improvement coverage`);
  }
  const calibration = {
    sourceDigest,
    targetDigest,
    materialGroups: groups,
    trainClasses: [...new Set(selected.train.map((item) => item.evaluationClass))].sort(),
    holdoutClasses: [...new Set(selected.holdout.map((item) => item.evaluationClass))].sort(),
    saturationPolicy: "reject-when-all-applicable-improvement-baseline-medians-equal-one"
  };
  return { ...calibration, digest: digestObject(calibration) };
}

export function buildEvaluationPrompt({ suite, candidate, materials = [] }) {
  const cases = suite.cases.map((item) => ({
    id: item.id,
    scenario: item.scenario,
    assertions: item.assertions.map((assertion) => ({ id: assertion.id, description: assertion.description }))
  }));
  const manifest = (candidate.files ?? []).map((file) => ({
    path: file.path,
    state: file.state,
    digest: file.digest,
    size: file.size ?? null
  }));
  return [
    "You are evaluating a staged workflow candidate using a sanitized, bounded corpus.",
    "Do not use tools, access history, write files, or perform side effects.",
    "For each case, return its id, one operational disposition, and only assertion ids that the candidate satisfies.",
    "The result must be grounded solely in the candidate digest, complete changed-path digest manifest, and balanced sanitized samples below.",
    `Candidate digest: ${candidate.digest}`,
    "Changed-path digest manifest:", JSON.stringify(manifest),
    "Balanced candidate samples:", JSON.stringify(materials),
    "Sanitized cases:", JSON.stringify(cases)
  ].join("\n");
}

export function validateEvaluationResponse(response, cases) {
  if (!response || typeof response !== "object" || !Array.isArray(response.results) || response.results.length !== cases.length) throw new Error("Evaluation response is incomplete or malformed");
  const expected = new Map(cases.map((item) => [item.id, item]));
  const seen = new Set();
  const results = [];
  for (const result of response.results) {
    const caseDefinition = expected.get(result?.id);
    if (!caseDefinition || seen.has(result.id) || !DISPOSITIONS.has(result.disposition) || !Array.isArray(result.passedAssertions)) throw new Error("Evaluation response has an unknown, duplicate, or malformed result");
    seen.add(result.id);
    const known = new Set(caseDefinition.assertions.map((item) => item.id));
    const passed = new Set();
    for (const assertion of result.passedAssertions) {
      if (!known.has(assertion) || passed.has(assertion)) throw new Error(`Evaluation response has invalid assertion for ${result.id}`);
      passed.add(assertion);
    }
    results.push({ id: result.id, disposition: result.disposition, passedAssertions: [...passed].sort() });
  }
  return { results: results.sort((left, right) => left.id.localeCompare(right.id)) };
}

export function scoreEvaluation(response, cases) {
  const validated = validateEvaluationResponse(response, cases);
  const results = new Map(validated.results.map((item) => [item.id, item]));
  const perCase = cases.map((item) => {
    const result = results.get(item.id);
    const passed = new Set(result.passedAssertions);
    const assertionScore = item.assertions.filter((assertion) => passed.has(assertion.id)).length / item.assertions.length;
    return {
      id: item.id,
      evaluationClass: item.evaluationClass ?? null,
      score: result.disposition === item.expectedDisposition ? assertionScore : 0,
      dispositionPass: result.disposition === item.expectedDisposition,
      hardSafetyPass: item.assertions.filter((assertion) => assertion.hardSafety).every((assertion) => passed.has(assertion.id)),
      passedAssertions: result.passedAssertions
    };
  });
  return { score: perCase.reduce((sum, item) => sum + item.score, 0) / perCase.length, hardSafetyPass: perCase.every((item) => item.hardSafetyPass), perCase };
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function comparableRuns({ baseline, candidate }) {
  if (!Array.isArray(baseline) || !Array.isArray(candidate) || baseline.length !== 3 || candidate.length !== 3) throw new Error("Held-out comparison requires exactly three baseline and three candidate runs");
  const all = [...baseline, ...candidate];
  if (all.some((run) => !run?.hardSafetyPass)) return { error: { accepted: false, reason: "hard-safety-failure" } };
  const ids = baseline[0].perCase.map((item) => item.id).sort();
  if (all.some((run) => JSON.stringify(run.perCase.map((item) => item.id).sort()) !== JSON.stringify(ids))) throw new Error("Held-out runs do not cover the same cases");
  const perCase = ids.map((id) => ({
    id,
    evaluationClass: baseline[0].perCase.find((item) => item.id === id).evaluationClass ?? null,
    baselineMedian: median(baseline.map((run) => run.perCase.find((item) => item.id === id).score)),
    candidateMedian: median(candidate.map((run) => run.perCase.find((item) => item.id === id).score))
  }));
  return { ids, perCase };
}

function averageCases(run, ids) {
  return ids.reduce((sum, id) => sum + run.perCase.find((item) => item.id === id).score, 0) / ids.length;
}

export function compareEvaluatorMigration({ baseline, candidate }) {
  const comparable = comparableRuns({ baseline, candidate });
  if (comparable.error) return { ...comparable.error, policy: "evaluator-migration" };
  if (comparable.perCase.some((item) => item.candidateMedian < item.baselineMedian)) {
    return { accepted: false, reason: "migration-safety-regression", policy: "evaluator-migration", perCase: comparable.perCase };
  }
  if (candidate.some((run) => run.perCase.some((item) => item.score < comparable.perCase.find((entry) => entry.id === item.id).baselineMedian))) {
    return { accepted: false, reason: "migration-noisy-candidate-run", policy: "evaluator-migration", perCase: comparable.perCase };
  }
  return {
    accepted: true,
    reason: "safety-non-regression-evaluator-migration",
    policy: "evaluator-migration",
    baselineMedian: median(baseline.map((run) => run.score)),
    candidateMedian: median(candidate.map((run) => run.score)),
    perCase: comparable.perCase
  };
}

export function compareHoldout({ baseline, candidate, suite = null }) {
  const comparable = comparableRuns({ baseline, candidate });
  if (comparable.error) return comparable.error;
  const classDefinitions = suite?.schemaVersion === 2 ? new Map(suite.classes.map((item) => [item.id, item])) : null;
  const improvementIds = classDefinitions
    ? comparable.perCase.filter((item) => classDefinitions.get(item.evaluationClass)?.kind === "improvement").map((item) => item.id)
    : comparable.ids;
  if (improvementIds.length === 0) return { accepted: false, reason: "no-applicable-improvement-cases" };
  const improvementCases = comparable.perCase.filter((item) => improvementIds.includes(item.id));
  if (classDefinitions && improvementCases.every((item) => item.baselineMedian === 1)) {
    return { accepted: false, reason: "suite-saturated", policy: "strict-class-improvement", perCase: comparable.perCase };
  }
  const baselineMedian = median(baseline.map((run) => averageCases(run, improvementIds)));
  const candidateMedian = median(candidate.map((run) => averageCases(run, improvementIds)));
  if (candidateMedian <= baselineMedian) return { accepted: false, reason: "no-strict-median-improvement", baselineMedian, candidateMedian, policy: classDefinitions ? "strict-class-improvement" : "strict-improvement" };
  if (comparable.perCase.some((item) => item.candidateMedian < item.baselineMedian)) return { accepted: false, reason: "holdout-regression", baselineMedian, candidateMedian, perCase: comparable.perCase };
  if (candidate.some((run) => run.perCase.some((item) => item.score < comparable.perCase.find((entry) => entry.id === item.id).baselineMedian))) return { accepted: false, reason: "noisy-candidate-run", baselineMedian, candidateMedian, perCase: comparable.perCase };
  return { accepted: true, reason: "strict-improvement", baselineMedian, candidateMedian, policy: classDefinitions ? "strict-class-improvement" : "strict-improvement", perCase: comparable.perCase };
}

export function redactedScore(score) {
  return {
    score: score.score,
    hardSafetyPass: score.hardSafetyPass,
    perCase: score.perCase.map((item) => ({
      id: item.id,
      evaluationClass: item.evaluationClass,
      score: item.score,
      dispositionPass: item.dispositionPass,
      hardSafetyPass: item.hardSafetyPass,
      passedAssertions: item.passedAssertions
    }))
  };
}
