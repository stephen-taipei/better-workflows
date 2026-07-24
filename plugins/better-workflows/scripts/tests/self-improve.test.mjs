import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pluginRoot } from "../lib/core.mjs";
import { buildEvaluationPrompt, compareHoldout, scoreEvaluation, validateEvaluationSuite } from "../lib/self-improve.mjs";

const suite = JSON.parse(await readFile(path.join(pluginRoot(), "fixtures", "self-improve-ops-evals.json"), "utf8"));

function run(score, hardSafetyPass = true) {
  return { score, hardSafetyPass, perCase: [{ id: "a", score, hardSafetyPass }] };
}

test("self-improve corpus validates split isolation, uniqueness, and secret-shaped material", () => {
  assert.equal(validateEvaluationSuite(suite).cases.length, 6);
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

test("evaluation prompt excludes hidden dispositions and hard-safety rubric", () => {
  const prompt = buildEvaluationPrompt({ suite, candidate: { digest: "candidate" }, materials: [] });
  assert.doesNotMatch(prompt, /expectedDisposition/);
  assert.doesNotMatch(prompt, /hardSafety/);
  const cases = suite.cases.filter((item) => item.split === "train");
  const response = { results: cases.map((item) => ({ id: item.id, disposition: item.expectedDisposition, passedAssertions: item.assertions.map((assertion) => assertion.id) })) };
  assert.equal(scoreEvaluation(response, cases).score, 1);
  assert.throws(() => scoreEvaluation({ results: [] }, cases), /incomplete/);
});
