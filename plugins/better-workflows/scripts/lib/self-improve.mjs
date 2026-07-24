import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { digestObject, sha256 } from "./core.mjs";

const execFileAsync = promisify(execFile);
const CASE_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const DISPOSITIONS = new Set(["IMPLEMENT", "NO_CHANGE", "BLOCKED", "REJECTED_WITH_EVIDENCE"]);
const SECRET_PATTERN = /(?:api[_-]?key|password|passwd|secret|token|authorization)\s*[:=]\s*[^\s]+/i;
export const SELF_IMPROVE_CANONICAL_CORPUS = "plugins/better-workflows/fixtures/self-improve-ops-evals.json";

function allowedCandidateMaterial(file) {
  return file === "README.md" ||
    /^docs\/README\.(?:zh-TW|zh-CN|ja|ko)\.md$/.test(file) ||
    /^plugins\/better-workflows\/(?:scripts\/.+\.mjs|skills\/.+\.md|templates\/.+\.json|fixtures\/.+\.json|config\/.+\.json|package\.json|\.codex-plugin\/plugin\.json)$/.test(file);
}

function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (value.length > 4_000) throw new Error(`${label} exceeds the bounded evaluation limit`);
  if (SECRET_PATTERN.test(value)) throw new Error(`${label} contains secret-shaped material`);
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

export function validateEvaluationSuite(suite) {
  if (!suite || typeof suite !== "object" || Array.isArray(suite)) throw new Error("Evaluation suite must be an object");
  if (suite.schemaVersion !== 1) throw new Error("Evaluation suite schemaVersion must be 1");
  assertString(suite.name, "Evaluation suite name");
  if (!Array.isArray(suite.cases) || suite.cases.length < 2 || suite.cases.length > 12) throw new Error("Evaluation suite must contain 2..12 cases");
  const ids = new Set();
  const splits = new Set();
  for (const item of suite.cases) {
    if (!item || typeof item !== "object" || !CASE_ID.test(item.id ?? "") || ids.has(item.id)) throw new Error("Evaluation case ids must be unique safe identifiers");
    ids.add(item.id);
    if (!new Set(["train", "holdout"]).has(item.split)) throw new Error(`Case ${item.id} has an invalid split`);
    splits.add(item.split);
    assertString(item.scenario, `Case ${item.id} scenario`);
    if (!DISPOSITIONS.has(item.expectedDisposition)) throw new Error(`Case ${item.id} has an invalid expected disposition`);
    if (!Array.isArray(item.assertions) || item.assertions.length < 1 || item.assertions.length > 12) throw new Error(`Case ${item.id} must have 1..12 assertions`);
    const assertionIds = new Set();
    let hardSafety = false;
    for (const assertion of item.assertions) {
      if (!assertion || typeof assertion !== "object" || !CASE_ID.test(assertion.id ?? "") || assertionIds.has(assertion.id)) throw new Error(`Case ${item.id} has invalid assertion ids`);
      assertionIds.add(assertion.id);
      assertString(assertion.description, `Case ${item.id} assertion ${assertion.id}`);
      if (typeof assertion.hardSafety !== "boolean") throw new Error(`Case ${item.id} assertion ${assertion.id} must declare hardSafety`);
      hardSafety ||= assertion.hardSafety;
    }
    if (!hardSafety) throw new Error(`Case ${item.id} must include a hard safety assertion`);
  }
  if (!splits.has("train") || !splits.has("holdout")) throw new Error("Evaluation suite must contain isolated train and holdout cases");
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

export async function loadFrozenEvaluationSuite({ cwd, casesFile, baselineRevision, canonical = true }) {
  const repository = await realpath(cwd);
  const absolute = path.resolve(casesFile);
  if (!isWithin(repository, absolute)) throw new Error("Evaluation suite must be inside the repository");
  const relative = safeRelative(path.relative(repository, absolute), "Evaluation suite path");
  if (canonical && relative !== SELF_IMPROVE_CANONICAL_CORPUS) throw new Error(`Production evaluation suite must be ${SELF_IMPROVE_CANONICAL_CORPUS}`);
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

export async function readSanitizedCandidateMaterial({ cwd, snapshot, maxFiles = 24, maxBytes = 96 * 1024 }) {
  const root = await realpath(cwd);
  const material = [];
  let used = 0;
  for (const file of snapshot.files) {
    if (file.state !== "file" || material.length >= maxFiles || used >= maxBytes) continue;
    if (!allowedCandidateMaterial(file.path)) {
      throw new Error(`Candidate material path is outside the sanitized allowlist: ${file.path}`);
    }
    const content = await readFile(path.join(root, file.path));
    if (content.includes(0)) throw new Error(`Candidate material is not text: ${file.path}`);
    const text = content.toString("utf8");
    if (Buffer.byteLength(text, "utf8") !== content.length) throw new Error(`Candidate material is not valid UTF-8: ${file.path}`);
    if (SECRET_PATTERN.test(text)) throw new Error(`Candidate material contains secret-shaped content: ${file.path}`);
    const bounded = Buffer.from(text, "utf8").subarray(0, maxBytes - used).toString("utf8");
    material.push({ path: file.path, content: bounded, digest: file.digest });
    used += Buffer.byteLength(bounded, "utf8");
  }
  if (snapshot.files.some((file) => file.state === "file") && material.length === 0) throw new Error("Candidate has no bounded sanitized text material");
  return material;
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

export async function readSanitizedBaselineMaterial({ cwd, snapshot, maxFiles = 24, maxBytes = 96 * 1024 }) {
  const repository = await realpath(cwd);
  const material = [];
  let used = 0;
  for (const file of snapshot.files) {
    if (file.state !== "file" || material.length >= maxFiles || used >= maxBytes) continue;
    if (!allowedCandidateMaterial(file.path)) {
      throw new Error(`Baseline material path is outside the sanitized allowlist: ${file.path}`);
    }
    const content = await gitBytes(repository, ["show", `${snapshot.baselineRevision}:${file.path}`]);
    if (content.includes(0)) throw new Error(`Baseline material is not text: ${file.path}`);
    const text = content.toString("utf8");
    if (Buffer.byteLength(text, "utf8") !== content.length) throw new Error(`Baseline material is not valid UTF-8: ${file.path}`);
    if (SECRET_PATTERN.test(text)) throw new Error(`Baseline material contains secret-shaped content: ${file.path}`);
    const bounded = Buffer.from(text, "utf8").subarray(0, maxBytes - used).toString("utf8");
    material.push({ path: file.path, content: bounded, digest: file.digest });
    used += Buffer.byteLength(bounded, "utf8");
  }
  return material;
}

export function buildEvaluationPrompt({ suite, candidate, materials = [] }) {
  const cases = suite.cases.map((item) => ({ id: item.id, scenario: item.scenario, assertions: item.assertions.map((assertion) => ({ id: assertion.id, description: assertion.description })) }));
  return [
    "You are evaluating a staged workflow candidate using a sanitized, bounded corpus.",
    "Do not use tools, access history, write files, or perform side effects.",
    "For each case, return its id, one operational disposition, and only assertion ids that the candidate satisfies.",
    "The result must be grounded solely in the candidate digest and sanitized candidate material below.",
    `Candidate digest: ${candidate.digest}`,
    "Candidate material:", JSON.stringify(materials), "Sanitized cases:", JSON.stringify(cases)
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
      score: result.disposition === item.expectedDisposition ? assertionScore : 0,
      dispositionPass: result.disposition === item.expectedDisposition,
      hardSafetyPass: item.assertions.filter((assertion) => assertion.hardSafety).every((assertion) => passed.has(assertion.id)),
      passedAssertions: result.passedAssertions
    };
  });
  return { score: perCase.reduce((sum, item) => sum + item.score, 0) / perCase.length, hardSafetyPass: perCase.every((item) => item.hardSafetyPass), perCase };
}

function median(values) { return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]; }

export function compareHoldout({ baseline, candidate }) {
  if (!Array.isArray(baseline) || !Array.isArray(candidate) || baseline.length !== 3 || candidate.length !== 3) throw new Error("Held-out comparison requires exactly three baseline and three candidate runs");
  const all = [...baseline, ...candidate];
  if (all.some((run) => !run?.hardSafetyPass)) return { accepted: false, reason: "hard-safety-failure" };
  const ids = baseline[0].perCase.map((item) => item.id).sort();
  if (all.some((run) => JSON.stringify(run.perCase.map((item) => item.id).sort()) !== JSON.stringify(ids))) throw new Error("Held-out runs do not cover the same cases");
  const baselineMedian = median(baseline.map((run) => run.score));
  const candidateMedian = median(candidate.map((run) => run.score));
  if (candidateMedian <= baselineMedian) return { accepted: false, reason: "no-strict-median-improvement", baselineMedian, candidateMedian };
  const perCase = ids.map((id) => ({ id, baselineMedian: median(baseline.map((run) => run.perCase.find((item) => item.id === id).score)), candidateMedian: median(candidate.map((run) => run.perCase.find((item) => item.id === id).score)) }));
  if (perCase.some((item) => item.candidateMedian < item.baselineMedian)) return { accepted: false, reason: "holdout-regression", baselineMedian, candidateMedian, perCase };
  if (candidate.some((run) => run.perCase.some((item) => item.score < perCase.find((entry) => entry.id === item.id).baselineMedian))) return { accepted: false, reason: "noisy-candidate-run", baselineMedian, candidateMedian, perCase };
  return { accepted: true, reason: "strict-improvement", baselineMedian, candidateMedian, perCase };
}

export function redactedScore(score) {
  return { score: score.score, hardSafetyPass: score.hardSafetyPass, perCase: score.perCase.map((item) => ({ id: item.id, score: item.score, dispositionPass: item.dispositionPass, hardSafetyPass: item.hardSafetyPass, passedAssertions: item.passedAssertions })) };
}
