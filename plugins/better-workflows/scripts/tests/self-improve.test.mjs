import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pluginRoot } from "../lib/core.mjs";
import {
  buildEvaluationPrompt,
  calibrateEvaluatorMigration,
  compareEvaluatorMigration,
  compareHoldout,
  readSanitizedCandidateMaterial,
  scoreEvaluation,
  selectEvaluationCases,
  validateEvaluationSuite
} from "../lib/self-improve.mjs";

const suite = JSON.parse(await readFile(path.join(pluginRoot(), "fixtures", "self-improve-ops-evals.json"), "utf8"));
const suiteV2 = JSON.parse(await readFile(path.join(pluginRoot(), "fixtures", "self-improve-ops-evals-v2.json"), "utf8"));

function run(score, hardSafetyPass = true) {
  return { score, hardSafetyPass, perCase: [{ id: "a", evaluationClass: null, score, hardSafetyPass }] };
}

test("self-improve corpus validates split isolation, uniqueness, and secret-shaped material", () => {
  assert.equal(validateEvaluationSuite(suite).cases.length, 6);
  assert.equal(validateEvaluationSuite(suiteV2).classes.length, 5);
  const duplicate = structuredClone(suite);
  duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(() => validateEvaluationSuite(duplicate), /unique/);
  const secret = structuredClone(suite);
  secret.cases[0].scenario = "token=not-allowed";
  assert.throws(() => validateEvaluationSuite(secret), /secret-shaped/);
  const noHoldout = structuredClone(suite);
  for (const item of noHoldout.cases) item.split = "train";
  assert.throws(() => validateEvaluationSuite(noHoldout), /isolated/);
});

test("evaluation v2 rejects unknown fields, missing class splits, and unsafe paths", () => {
  const unknown = structuredClone(suiteV2);
  unknown.classes[0].authority = "invented";
  assert.throws(() => validateEvaluationSuite(unknown), /unknown field/);
  const missingSplit = structuredClone(suiteV2);
  missingSplit.cases = missingSplit.cases.filter((item) => !(item.evaluationClass === "sanitizer-coverage" && item.split === "holdout"));
  assert.throws(() => validateEvaluationSuite(missingSplit), /train and holdout/);
  const traversal = structuredClone(suiteV2);
  traversal.classes.find((item) => item.kind === "improvement").paths = ["../private"];
  assert.throws(() => validateEvaluationSuite(traversal), /escapes/);
});

test("holdout aggregation fails closed for safety failure, tie, regression, and noisy runs", () => {
  assert.equal(compareHoldout({ baseline: [run(0.4), run(0.4), run(0.4)], candidate: [run(0.6, false), run(0.6), run(0.6)] }).reason, "hard-safety-failure");
  assert.equal(compareHoldout({ baseline: [run(0.4), run(0.4), run(0.4)], candidate: [run(0.4), run(0.4), run(0.4)] }).reason, "no-strict-median-improvement");
  const regression = {
    baseline: [{ score: 0.5, hardSafetyPass: true, perCase: [{ id: "a", score: 0.5, hardSafetyPass: true }, { id: "b", score: 0.5, hardSafetyPass: true } ] },
      { score: 0.5, hardSafetyPass: true, perCase: [{ id: "a", score: 0.5, hardSafetyPass: true }, { id: "b", score: 0.5, hardSafetyPass: true } ] },
      { score: 0.5, hardSafetyPass: true, perCase: [{ id: "a", score: 0.5, hardSafetyPass: true }, { id: "b", score: 0.5, hardSafetyPass: true } ] }],
    candidate: [{ score: 0.6, hardSafetyPass: true, perCase: [{ id: "a", score: 0.8, hardSafetyPass: true }, { id: "b", score: 0.4, hardSafetyPass: true } ] },
      { score: 0.6, hardSafetyPass: true, perCase: [{ id: "a", score: 0.8, hardSafetyPass: true }, { id: "b", score: 0.4, hardSafetyPass: true } ] },
      { score: 0.6, hardSafetyPass: true, perCase: [{ id: "a", score: 0.8, hardSafetyPass: true }, { id: "b", score: 0.4, hardSafetyPass: true } ] }]
  };
  assert.equal(compareHoldout(regression).reason, "holdout-regression");
  const noisy = { baseline: [run(0.5), run(0.5), run(0.5)], candidate: [run(0.4), run(0.7), run(0.7)] };
  assert.equal(compareHoldout(noisy).reason, "noisy-candidate-run");
  assert.equal(compareHoldout({ baseline: [run(0.4), run(0.4), run(0.4)], candidate: [run(0.6), run(0.6), run(0.6)] }).accepted, true);
});

test("evaluation v2 separates invariant safety from strict relevant-class improvement", () => {
  const definition = {
    schemaVersion: 2,
    classes: [
      { id: "universal-safety", kind: "invariant" },
      { id: "docs", kind: "improvement" }
    ]
  };
  const score = (invariant, improvement, hardSafetyPass = true) => ({
    score: (invariant + improvement) / 2,
    hardSafetyPass,
    perCase: [
      { id: "safety", evaluationClass: "universal-safety", score: invariant, hardSafetyPass },
      { id: "quality", evaluationClass: "docs", score: improvement, hardSafetyPass }
    ]
  });
  const accepted = compareHoldout({
    baseline: [score(1, 0.5), score(1, 0.5), score(1, 0.5)],
    candidate: [score(1, 1), score(1, 1), score(1, 1)],
    suite: definition
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.baselineMedian, 0.5);
  assert.equal(accepted.candidateMedian, 1);
  const saturated = compareHoldout({
    baseline: [score(1, 1), score(1, 1), score(1, 1)],
    candidate: [score(1, 1), score(1, 1), score(1, 1)],
    suite: definition
  });
  assert.equal(saturated.reason, "suite-saturated");
  const safetyRegression = compareHoldout({
    baseline: [score(1, 0.5), score(1, 0.5), score(1, 0.5)],
    candidate: [score(0, 1, false), score(1, 1), score(1, 1)],
    suite: definition
  });
  assert.equal(safetyRegression.reason, "hard-safety-failure");
});

test("evaluator migration permits only host-replay safety non-regression semantics", () => {
  assert.equal(compareEvaluatorMigration({
    baseline: [run(1), run(1), run(1)],
    candidate: [run(1), run(1), run(1)]
  }).accepted, true);
  assert.equal(compareEvaluatorMigration({
    baseline: [run(1), run(1), run(1)],
    candidate: [run(0.5), run(1), run(1)]
  }).reason, "migration-noisy-candidate-run");
  assert.equal(compareEvaluatorMigration({
    baseline: [run(1), run(1), run(1)],
    candidate: [run(1, false), run(1), run(1)]
  }).reason, "hard-safety-failure");
});

test("evaluation prompt excludes hidden dispositions and hard-safety rubric", () => {
  const prompt = buildEvaluationPrompt({ suite, candidate: { digest: "candidate" }, materials: [] });
  assert.doesNotMatch(prompt, /expectedDisposition/);
  assert.doesNotMatch(prompt, /hardSafety/);
  assert.match(prompt, /Changed-path digest manifest/);
  const cases = suite.cases.filter((item) => item.split === "train");
  const response = { results: cases.map((item) => ({ id: item.id, disposition: item.expectedDisposition, passedAssertions: item.assertions.map((assertion) => assertion.id) })) };
  assert.equal(scoreEvaluation(response, cases).score, 1);
  assert.throws(() => scoreEvaluation({ results: [] }, cases), /incomplete/);
});

test("balanced sanitizer covers every changed material group under the 24-file and 96 KB caps", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sbw-balanced-material-"));
  try {
    const representatives = [
      "README.md",
      "plugins/better-workflows/scripts/lib/candidate.mjs",
      "plugins/better-workflows/scripts/tests/candidate.test.mjs",
      "plugins/better-workflows/config/candidate.json",
      "plugins/better-workflows/skills/self-improve/SKILL.md",
      "plugins/better-workflows/templates/self-improve-ops.json",
      "plugins/better-workflows/fixtures/candidate.json",
      "plugins/better-workflows/package.json"
    ];
    for (let index = 0; index < 23; index += 1) {
      representatives.push(`plugins/better-workflows/config/extra-${String(index).padStart(2, "0")}.json`);
    }
    const files = [];
    for (const [index, file] of representatives.entries()) {
      await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      const content = "x".repeat(12 * 1024);
      await writeFile(path.join(cwd, file), content);
      files.push({ path: file, state: "file", digest: String(index).padStart(64, "0"), size: content.length });
    }
    const material = await readSanitizedCandidateMaterial({ cwd, snapshot: { files }, maxFiles: 24, maxBytes: 96 * 1024 });
    assert.ok(material.length <= 24);
    assert.ok(material.reduce((sum, item) => sum + item.sampledBytes, 0) <= 96 * 1024);
    assert.deepEqual(
      [...new Set(material.map((item) => item.materialGroup))].sort(),
      ["config", "docs", "fixtures", "metadata", "runtime", "skills", "templates", "tests"]
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("evaluation v2 selects universal safety plus only applicable improvement classes", () => {
  const cases = selectEvaluationCases({
    suite: suiteV2,
    snapshot: { files: [{ path: "README.md", state: "file" }] },
    split: "holdout"
  });
  assert.deepEqual(
    [...new Set(cases.map((item) => item.evaluationClass))].sort(),
    ["documentation-information-architecture", "universal-safety"]
  );
  assert.throws(
    () => selectEvaluationCases({
      suite: suiteV2,
      snapshot: { files: [{ path: "plugins/better-workflows/templates/unclassified.json", state: "file" }] },
      split: "holdout"
    }),
    /no applicable improvement class/
  );
});

test("evaluator migration calibration binds v1, v2, balanced groups, and both splits", () => {
  const snapshot = {
    files: [
      { path: "plugins/better-workflows/scripts/lib/self-improve.mjs", state: "file" },
      { path: "plugins/better-workflows/scripts/tests/self-improve.test.mjs", state: "file" }
    ]
  };
  const calibration = calibrateEvaluatorMigration({
    source: suite,
    target: suiteV2,
    snapshot,
    materials: [
      { materialGroup: "runtime" },
      { materialGroup: "tests" }
    ],
    sourceDigest: "a".repeat(64),
    targetDigest: "b".repeat(64)
  });
  assert.deepEqual(calibration.materialGroups, ["runtime", "tests"]);
  assert.match(calibration.digest, /^[a-f0-9]{64}$/);
  assert.ok(calibration.trainClasses.includes("universal-safety"));
  assert.ok(calibration.holdoutClasses.includes("evaluation-engineering"));
});

test("candidate sanitizer admits declared public docs and checks all paths before sampling", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sbw-public-docs-"));
  try {
    const publicFiles = [
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "GOVERNANCE.md",
      "SECURITY.md",
      "SUPPORT.md",
      "docs/details/en.md",
      "docs/guide/security.md",
      "docs/assets/better-workflows-engineering-stack.svg"
    ];
    for (const file of publicFiles) {
      await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await writeFile(path.join(cwd, file), `public material for ${file}\n`);
    }
    const material = await readSanitizedCandidateMaterial({
      cwd,
      snapshot: {
        files: publicFiles.map((file) => ({ path: file, state: "file", digest: "a".repeat(64) }))
      },
      maxFiles: publicFiles.length
    });
    assert.deepEqual(material.map((item) => item.path).sort(), publicFiles.sort());

    const allowed = [];
    for (let index = 0; index < 24; index += 1) {
      const file = `plugins/better-workflows/config/safe-${String(index).padStart(2, "0")}.json`;
      await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await writeFile(path.join(cwd, file), "{}\n");
      allowed.push({ path: file, state: "file", digest: "b".repeat(64) });
    }
    await writeFile(path.join(cwd, "zz-private.txt"), "must remain outside the bundle\n");
    await assert.rejects(
      readSanitizedCandidateMaterial({
        cwd,
        snapshot: { files: [...allowed, { path: "zz-private.txt", state: "file", digest: "c".repeat(64) }] },
        maxFiles: 24
      }),
      /outside the sanitized allowlist/
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
