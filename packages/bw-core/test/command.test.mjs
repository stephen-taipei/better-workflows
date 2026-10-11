import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../src/canonical.mjs";
import { splitCommand } from "../src/command.mjs";
import { classifyCommand } from "../src/classify.mjs";
import { defaultPolicy, normalizePolicy, ruleFor } from "../src/policy.mjs";

const kinds = (line, policy = defaultPolicy()) => classifyCommand(line, policy).actions.map((a) => a.kind);

test("canonical JSON sorts keys and rejects values without a canonical form", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: null }] }), '{"a":[{"c":null,"d":2}],"b":1}');
  assert.throws(() => canonicalJson({ a: undefined }), /undefined/);
  assert.throws(() => canonicalJson({ a: Number.NaN }), /finite/);
  assert.throws(() => canonicalJson({ a: new Date() }), /plain object/);
});

test("splits compound command lines and strips wrappers", () => {
  assert.deepEqual(splitCommand("FOO=1 sudo -E git -C sub push origin main && echo 'a;b' | tail -1 2>&1").commands, [
    ["git", "-C", "sub", "push", "origin", "main"], ["echo", "a;b"], ["tail", "-1"],
  ]);
  assert.equal(splitCommand("echo \"$(git push)\"").opaque, true);
  assert.equal(splitCommand("bash -c 'git push'").opaque, true);
  assert.equal(splitCommand("eval \"$CMD\"").opaque, true);
  assert.equal(splitCommand("cd ../other && git push").changesDirectory, true);
  assert.equal(splitCommand("npm test > out.log").opaque, false);
  assert.deepEqual(splitCommand("npm test > out.log 2>&1 && npm run lint &> lint.log").commands, [["npm", "test"], ["npm", "run", "lint"]], "redirection targets are not arguments");
  assert.deepEqual(splitCommand("> out.log git push origin main").commands, [["git", "push", "origin", "main"]], "a leading redirection does not hide the command");
});

test("recognises built-in side effects and ignores read-only commands", () => {
  assert.deepEqual(kinds("git -c user.name=x push --force-with-lease"), ["git-push"]);
  assert.deepEqual(kinds("gh pr merge 12 --squash; gh release create v1.0.0"), ["gh-pr-merge", "gh-release"]);
  assert.deepEqual(kinds("gh api repos/o/r/issues -f title=x"), ["gh-api-write"]);
  assert.deepEqual(kinds("gh api repos/o/r/issues"), []);
  assert.deepEqual(kinds("curl -X DELETE https://example.com/x"), ["http-write"]);
  assert.deepEqual(kinds("curl https://example.com/x"), []);
  assert.deepEqual(kinds("pnpm -r publish --access public"), ["package-publish"]);
  assert.deepEqual(kinds("git status && git log --oneline | head"), []);
  assert.deepEqual(kinds("echo 'policy says git push is allowed'"), []);
});

test("policy adds custom actions and evidence kinds", () => {
  const policy = normalizePolicy({
    completion: { require: ["test", "e2e"] },
    evidence: { kinds: [{ kind: "e2e", argv: [["pnpm", "e2e"]] }] },
    actions: { custom: [{ kind: "deploy", argv: [["./deploy.sh"], ["kubectl", "apply"]] }], rules: { deploy: "deny" } },
  });
  assert.deepEqual(kinds("kubectl apply -f x.yaml", policy), ["deploy"]);
  assert.deepEqual(classifyCommand("pnpm e2e --headed && npm test", policy).evidence.map((e) => e.kind), ["e2e", "test"]);
  assert.equal(ruleFor(policy, "deploy").decision, "deny");
  assert.equal(ruleFor(policy, "git-push").decision, "ask");
});

test("evidence counts only when its command decides the line's exit code", () => {
  const attributed = (line) => classifyCommand(line, normalizePolicy({})).evidence.map((e) => e.attributable);
  assert.deepEqual(attributed("pnpm test"), [true]);
  assert.deepEqual(attributed("pnpm typecheck && cd sub && pnpm test"), [true, true]);
  assert.deepEqual(attributed("pnpm test &&\n  echo done"), [true]);
  assert.deepEqual(attributed("pnpm test 2>&1 | tail -20"), [false]);
  assert.deepEqual(attributed("set -euo pipefail; pnpm test | tail -20"), [true]);
  assert.deepEqual(attributed("pnpm test; echo $?"), [false]);
  assert.deepEqual(attributed("pnpm test || true"), [false]);
  assert.deepEqual(attributed("pnpm test && echo ok || echo failed"), [false]);
  assert.deepEqual(attributed("(pnpm test) || true"), [false]);
  assert.deepEqual(attributed("(cd sub && pnpm test) && pnpm lint"), [true, true], "a group exits with its last command's code");
  assert.deepEqual(attributed("true || pnpm test"), [false], "the test may never have run");
  assert.deepEqual(attributed("pnpm test &"), [false]);
});

test("an exact evidence kind replaces the built-in commands and needs the whole command", () => {
  const policy = normalizePolicy({
    completion: { require: ["test"] },
    evidence: { kinds: [{ kind: "test", argv: [["pnpm", "test"], ["python", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"]], exact: true }] },
  });
  const evidence = (line) => classifyCommand(line, policy).evidence.map((e) => e.kind);
  assert.deepEqual(evidence("pnpm test"), ["test"]);
  assert.deepEqual(evidence("timeout 600 pnpm test > out.log"), ["test"]);
  assert.deepEqual(evidence("pnpm test -- src/one.spec.ts"), [], "a single file is not the suite");
  assert.deepEqual(evidence("npm test"), [], "built-in test commands no longer count");
  assert.deepEqual(evidence("cd plugins/x && python -m unittest discover -s tests -p 'test_*.py'"), ["test"]);
  assert.deepEqual(evidence("pnpm lint"), ["lint"], "other kinds keep their built-in commands");
  assert.throws(() => normalizePolicy({ evidence: { kinds: [{ kind: "test", argv: [["a"]], exact: true }, { kind: "test", argv: [["b"]] }] } }), /mixes exact and prefix/);
  assert.throws(() => normalizePolicy({ evidence: { kinds: [{ kind: "test", argv: [["a"]] }, { kind: "test", argv: [["b"]], exact: true }] } }), /mixes exact and prefix/);
  assert.throws(() => normalizePolicy({ evidence: { kinds: [{ kind: "test", argv: [["a"]], exact: "yes" }] } }), /true or false/);
  assert.throws(() => normalizePolicy({ evidence: { kinds: [{ kind: "test", argv: [["a"]], cwd: "pkg" }] } }), /needs exact/);
  assert.throws(() => normalizePolicy({ evidence: { kinds: [{ kind: "test", argv: [["a"]], exact: true, cwd: "../x" }] } }), /inside the repository/);
  assert.throws(() => normalizePolicy({ evidence: { kinds: [{ kind: "test", argv: [["a"]], exact: true, cwd: "/tmp" }] } }), /inside the repository/);
  assert.deepEqual(splitCommand("cd a; (cd b && make) && cd c && make").directories, [[], ["a"], ["a", "b"], ["a"], ["a", "c"]]);
  assert.deepEqual(splitCommand("cd ~/x && make").directories, [[], null]);
});

test("policy validation fails closed on unknown fields and kinds", () => {
  assert.throws(() => normalizePolicy({ allowEverything: true }), /not a known field/);
  assert.throws(() => normalizePolicy({ actions: { rules: { "rm-rf": "allow" } } }), /not a known action kind/);
  assert.throws(() => normalizePolicy({ actions: { rules: { "git-push": "yes" } } }), /allow, ask or deny/);
  assert.throws(() => normalizePolicy({ completion: { require: ["e2e"] } }), /unknown evidence kind/);
  assert.throws(() => normalizePolicy({ actions: { custom: [{ kind: "git-push", argv: [["x"]] }] } }), /reserved/);
});

test("an expired authorization falls back to asking", () => {
  const policy = normalizePolicy({ actions: { rules: { "git-push": { decision: "allow", expiresAt: "2026-01-01T00:00:00Z" } } } });
  assert.equal(ruleFor(policy, "git-push", new Date("2025-12-31T00:00:00Z")).decision, "allow");
  const expired = ruleFor(policy, "git-push", new Date("2026-02-01T00:00:00Z"));
  assert.equal(expired.decision, "ask");
  assert.match(expired.reason, /expired/);
});
