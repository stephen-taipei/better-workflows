import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pluginRoot } from "../lib/core.mjs";
import {
  buildEvaluationPrompt,
  calibrateEvaluatorMigration,
  compareEvaluatorMigration,
  compareHoldout,
  evaluationBindingDigest,
  readSanitizedCandidateMaterial,
  scoreEvaluation,
  selectEvaluationCases,
  validateEvaluationSuite,
  SELF_IMPROVE_MIGRATION_SOURCE_CORPORA,
  SELF_IMPROVE_ORDINARY_CORPORA
} from "../lib/self-improve.mjs";

const suite = JSON.parse(await readFile(path.join(pluginRoot(), "fixtures", "self-improve-ops-evals.json"), "utf8"));
const suiteV2 = JSON.parse(await readFile(path.join(pluginRoot(), "fixtures", "self-improve-ops-evals-v2.json"), "utf8"));
const suiteV21Bytes = await readFile(path.join(pluginRoot(), "fixtures", "self-improve-ops-evals-v2.1.json"));
const suiteV21 = JSON.parse(suiteV21Bytes.toString("utf8"));
const suiteV22 = JSON.parse(await readFile(path.join(pluginRoot(), "fixtures", "self-improve-ops-evals-v2.2.json"), "utf8"));

function run(score, hardSafetyPass = true) {
  return { score, hardSafetyPass, perCase: [{ id: "a", evaluationClass: null, score, hardSafetyPass }] };
}

test("self-improve corpus validates split isolation, uniqueness, and secret-shaped material", () => {
  assert.equal(validateEvaluationSuite(suite).cases.length, 6);
  assert.equal(validateEvaluationSuite(suiteV2).classes.length, 5);
  assert.equal(validateEvaluationSuite(suiteV21).classes.length, 5);
  assert.equal(validateEvaluationSuite(suiteV22).classes.length, 9);
  assert.equal(validateEvaluationSuite(suiteV22).cases.length, 18);
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

test("evaluation v2.2 uniquely covers every control-plane improvement class in train and holdout", () => {
  const expected = ["direct-work-cost", "evidence-integrity", "execution-ledger", "review-convergence"];
  const classes = suiteV22.classes.filter((item) => expected.includes(item.id));
  assert.deepEqual(classes.map((item) => item.id).sort(), expected);
  for (const classId of expected) {
    const cases = suiteV22.cases.filter((item) => item.evaluationClass === classId);
    assert.deepEqual(cases.map((item) => item.split).sort(), ["holdout", "train"]);
    assert.equal(new Set(cases.map((item) => item.id)).size, 2);
    assert.equal(cases.every((item) => item.assertions.some((assertion) => assertion.hardSafety)), true);
  }
  for (const legacyCase of suiteV21.cases) {
    assert.deepEqual(suiteV22.cases.find((item) => item.id === legacyCase.id), legacyCase);
  }
  assert.equal(createHash("sha256").update(suiteV21Bytes).digest("hex"), "42f61f3f416d0c28ccd419e6aa52aa07923889b944906b0de922f12b67c0401c");
  assert.deepEqual(SELF_IMPROVE_MIGRATION_SOURCE_CORPORA, [
    "plugins/better-workflows/fixtures/self-improve-ops-evals.json",
    "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.json",
    "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.1.json"
  ]);
});

test("evaluator migration binding changes with either immutable suite digest", () => {
  const base = evaluationBindingDigest({ purpose: "evaluator-migration", sourceSuiteDigest: "a".repeat(64), targetSuiteDigest: "b".repeat(64) });
  assert.notEqual(base, evaluationBindingDigest({ purpose: "evaluator-migration", sourceSuiteDigest: "c".repeat(64), targetSuiteDigest: "b".repeat(64) }));
  assert.notEqual(base, evaluationBindingDigest({ purpose: "evaluator-migration", sourceSuiteDigest: "a".repeat(64), targetSuiteDigest: "d".repeat(64) }));
});

test("ordinary evaluator readers prefer the newest corpus present in the immutable baseline", () => {
  assert.deepEqual(SELF_IMPROVE_ORDINARY_CORPORA, [
    "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.2.json",
    "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.1.json",
    "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.json",
    "plugins/better-workflows/fixtures/self-improve-ops-evals.json"
  ]);
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
  assert.match(prompt, /Each case is an independent case-specific decision/);
  assert.match(prompt, /never for the staged candidate as a whole/);
  assert.doesNotMatch(prompt, /staged candidate should be adopted/);
  assert.match(prompt, /only proposed evidence source is prohibited, sensitive, or cannot be sanitized/);
  assert.match(prompt, /do not substitute a different source or the staged candidate's existing safeguards/);
  assert.match(prompt, /existing safeguard may satisfy an assertion/);
  assert.match(prompt, /does not make an inadmissible case-specific proposal safe/);
  for (const disposition of ["IMPLEMENT", "NO_CHANGE", "BLOCKED", "REJECTED_WITH_EVIDENCE"]) {
    assert.match(prompt, new RegExp(disposition));
  }
  assert.match(prompt, /Assess every listed assertion independently/);
  assert.match(prompt, /do not omit a satisfied assertion/);
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

test("sanitizer redacts secret-shaped public test fixtures but still rejects non-test source", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sbw-test-fixture-redaction-"));
  try {
    const fixture = "plugins/better-workflows/scripts/tests/graph.test.mjs";
    await mkdir(path.dirname(path.join(cwd, fixture)), { recursive: true });
    await writeFile(path.join(cwd, fixture), 'const secret = "TOPSECRET-graph-987";\ncredentials: { password: secret };\n');
    const [material] = await readSanitizedCandidateMaterial({
      cwd,
      snapshot: { files: [{ path: fixture, state: "file", digest: "d".repeat(64) }] },
      maxFiles: 1
    });
    assert.equal(material.redacted, true);
    assert.doesNotMatch(material.content.toString("utf8"), /TOPSECRET|password\s*:\s*["'][^"']{4,}["']/i);
    assert.match(material.content.toString("utf8"), /redacted-test-fixture/);

    const source = "plugins/better-workflows/scripts/lib/providers.mjs";
    await mkdir(path.dirname(path.join(cwd, source)), { recursive: true });
    await writeFile(path.join(cwd, source), 'const token = "12345678";\n');
    await assert.rejects(
      readSanitizedCandidateMaterial({
        cwd,
        snapshot: { files: [{ path: source, state: "file", digest: "e".repeat(64) }] },
        maxFiles: 1
      }),
      /secret-shaped content/
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("balanced sanitizer prioritizes public entry and security documents within the docs group", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sbw-doc-priority-"));
  try {
    const files = [
      "README.md",
      "docs/README.zh-TW.md",
      "docs/README.zh-CN.md",
      "docs/README.ja.md",
      "docs/README.ko.md",
      "SECURITY.md",
      "docs/guide/security.md",
      "docs/guide/architecture.md",
      "docs/assets/better-workflows-engineering-stack.svg",
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "GOVERNANCE.md",
      "SUPPORT.md",
      "docs/details/en.md",
      "docs/details/ja.md",
      "docs/details/ko.md",
      "docs/details/zh-CN.md",
      "docs/details/zh-TW.md"
    ];
    for (const file of files) {
      await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await writeFile(path.join(cwd, file), `public material for ${file}\n`);
    }
    const material = await readSanitizedCandidateMaterial({
      cwd,
      snapshot: {
        files: files.map((file) => ({ path: file, state: "file", digest: "c".repeat(64) }))
      },
      maxFiles: 9
    });
    assert.deepEqual(material.map((item) => item.path), [
      "README.md",
      "docs/README.zh-TW.md",
      "docs/README.zh-CN.md",
      "docs/README.ja.md",
      "docs/README.ko.md",
      "SECURITY.md",
      "docs/guide/security.md",
      "docs/guide/architecture.md",
      "docs/assets/better-workflows-engineering-stack.svg"
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("evaluation v2 selects universal safety plus only applicable improvement classes", () => {
  const cases = selectEvaluationCases({
    suite: suiteV21,
    snapshot: {
      files: [
        { path: "README.md", state: "file" },
        { path: "plugins/better-workflows/package.json", state: "file" },
        { path: "plugins/better-workflows/.codex-plugin/plugin.json", state: "file" },
        { path: "plugins/better-workflows/scripts/tests/docs.test.mjs", state: "file" },
        { path: "plugins/better-workflows/scripts/tests/fixtures.test.mjs", state: "file" }
      ]
    },
    split: "holdout"
  });
  assert.deepEqual(
    [...new Set(cases.map((item) => item.evaluationClass))].sort(),
    [
      "deliberation-roster-terminology",
      "documentation-information-architecture",
      "universal-safety"
    ]
  );
  assert.equal(cases.some((item) => item.evaluationClass === "evaluation-engineering"), false);
  assert.throws(
    () => selectEvaluationCases({
      suite: suiteV21,
      snapshot: { files: [{ path: "plugins/better-workflows/templates/unclassified.json", state: "file" }] },
      split: "holdout"
    }),
    /no applicable improvement class/
  );
});

test("evaluator migration calibration binds v2.1, v2.2, balanced groups, and both splits", () => {
  const snapshot = {
    files: [
      { path: "plugins/better-workflows/config/evidence-contracts-v1.json", state: "file" },
      { path: "plugins/better-workflows/scripts/lib/core.mjs", state: "file" },
      { path: "plugins/better-workflows/scripts/lib/ledger.mjs", state: "file" },
      { path: "plugins/better-workflows/scripts/lib/review.mjs", state: "file" },
      { path: "plugins/better-workflows/scripts/lib/self-improve.mjs", state: "file" },
      { path: "plugins/better-workflows/scripts/tests/self-improve.test.mjs", state: "file" }
    ]
  };
  const calibration = calibrateEvaluatorMigration({
    source: suiteV21,
    target: suiteV22,
    snapshot,
    materials: [
      { materialGroup: "config" },
      { materialGroup: "runtime" },
      { materialGroup: "tests" }
    ],
    sourceDigest: "a".repeat(64),
    targetDigest: "b".repeat(64)
  });
  assert.deepEqual(calibration.materialGroups, ["config", "runtime", "tests"]);
  assert.match(calibration.digest, /^[a-f0-9]{64}$/);
  assert.ok(calibration.trainClasses.includes("universal-safety"));
  assert.ok(calibration.holdoutClasses.includes("evaluation-engineering"));
  for (const classId of ["direct-work-cost", "evidence-integrity", "execution-ledger", "review-convergence"]) {
    assert.ok(calibration.trainClasses.includes(classId));
    assert.ok(calibration.holdoutClasses.includes(classId));
  }
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
