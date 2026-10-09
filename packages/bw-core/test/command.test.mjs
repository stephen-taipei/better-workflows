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
