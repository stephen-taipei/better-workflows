import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCommand } from "../src/actions.mjs";
import { classifyCommand } from "../src/classify.mjs";
import { normalizePolicy } from "../src/policy.mjs";

// From the 2026-11-13 review: each of these lines was allowed with no action
// and no question, because the word in front was read as the program.

const policy = normalizePolicy({ completion: { require: ["test"] } });
const evaluate = (command) => evaluateCommand({ command, policyInfo: { policy, error: null }, state: { actions: new Map(), newerLedger: null }, head: "h" });

for (const [command, kind] of [
  ["if git diff --quiet; then git push origin main; fi", "git-push"],
  ["if git push origin main; then echo pushed; fi", "git-push"],
  ["for n in 41 42; do gh pr merge $n --squash; done", "gh-pr-merge"],
  ["while ! npm publish; do sleep 5; done", "package-publish"],
  ["test -f ok && { git push origin main; }", "git-push"],
  ["! git push origin main", "git-push"],
  ["if true; then echo no; else gh release create v1; fi", "gh-release"],
  ["gh pr -R owner/other merge 5", "gh-pr-merge"],
  ["gh pr --repo owner/other create --fill", "gh-pr-create"],
]) {
  test(`a side effect behind a reserved word or a gh option is still gated: ${command}`, () => {
    const result = evaluate(command);
    assert.deepEqual(result.actions.map((action) => action.kind), [kind]);
    assert.equal(result.decision, "ask");
  });
}

test("gh options between the words keep their meaning", () => {
  const [merge] = classifyCommand("gh pr -R owner/other merge 5", policy).actions;
  assert.deepEqual(merge.target, { pr: "5" });
  assert.deepEqual(merge.where, { repo: "owner/other" });
  assert.equal(merge.argv.join(" "), "gh pr -R owner/other merge 5", "the recorded argv is the one that ran");
  assert.deepEqual(classifyCommand("gh pr -R owner/other view 5", policy).actions, []);
});

for (const command of ["sudo -u deploy git push origin main", "env -C /elsewhere git push", "env -u TOKEN gh pr merge 5", "timeout -s KILL 60 git push", "$GIT push origin main", "${DEPLOY} now"]) {
  test(`a program that cannot be read makes the line opaque: ${command}`, () => {
    const result = evaluate(command);
    assert.equal(result.opaque, true);
    assert.equal(result.decision, "ask");
  });
}

test("wrappers without options and plain loops stay readable", () => {
  for (const command of ["timeout 60 git status", "time npm test", "nohup node server.js", "for f in *.md; do wc -l $f; done", "if test -f a; then echo yes; fi", "echo $HOME"]) {
    const result = evaluate(command);
    assert.equal(result.opaque, false, command);
    assert.equal(result.decision, "allow", command);
  }
  assert.deepEqual(evaluate("timeout 60 git push").actions.map((a) => a.kind), ["git-push"]);
});

test("a check behind a reserved word is recorded but never a pass", () => {
  for (const command of ["! npm test", "if npm test; then echo ok; fi", "while ! npm test; do sleep 1; done", "if true; then npm test; fi", "{ npm test; }"]) {
    assert.deepEqual(classifyCommand(command, policy).evidence.map((e) => e.attributable), [false], command);
  }
  assert.deepEqual(classifyCommand("npm test && echo ok", policy).evidence.map((e) => e.attributable), [true]);
});
