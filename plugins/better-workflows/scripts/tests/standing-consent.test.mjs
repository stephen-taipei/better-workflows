import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  STANDING_CONSENT_AUTHORITY_STATEMENT,
  STANDING_CONSENT_ALLOWED_PATH_PATTERNS,
  STANDING_CONSENT_DENIED_AUTHORITIES,
  consentDigest,
  loadStandingConsentPolicy,
  matchStandingConsent,
  resolveStandingConsentAuthorization,
  validateStandingConsentPolicy,
  validStandingAuthorization
} from "../lib/standing-consent.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(TEST_DIR, "../../../..");

function fixtureGrant(policy, overrides = {}) {
  const subject = {
    uid: 501,
    gid: 20,
    username: "maintainer",
    homePath: "/Users/maintainer",
    codexHomePath: "/Users/maintainer/.codex"
  };
  const grant = {
    grantId: "bw-standing-501-v1",
    authorityStatementDigest: consentDigest(STANDING_CONSENT_AUTHORITY_STATEMENT),
    repo: REPOSITORY,
    provider: "codex",
    operation: "self-improve-evaluator-replay",
    models: ["gpt-5.6-terra"],
    purposes: ["ordinary", "evaluator-migration", "safety-remediation-v1", "quality-remediation-v1"],
    maxRequests: 8,
    requestRoot: "/private/tmp/better-workflows-standing-consent-501",
    subject,
    policyDigest: policy.digest,
    readOnly: true,
    ephemeral: true,
    sanitized: true,
    deniedAuthorities: [...STANDING_CONSENT_DENIED_AUTHORITIES],
    expiresAt: null,
    revokedAt: null,
    ...overrides
  };
  return {
    grant,
    hostStatus: {
      standingConsent: {
        active: true,
        grant,
        grantDigest: "a".repeat(64),
        policyDigest: policy.digest
      }
    },
    subject
  };
}

test("standing evaluator consent is exact, bounded, and delivery-denying", async () => {
  const policy = await loadStandingConsentPolicy(REPOSITORY);
  const { hostStatus, subject } = fixtureGrant(policy);
  const matched = matchStandingConsent({
    hostStatus,
    policy,
    repo: REPOSITORY,
    model: "gpt-5.6-terra",
    purpose: "evaluator-migration",
    requestCount: 8,
    runAs: {
      uid: subject.uid,
      gid: subject.gid,
      homePath: subject.homePath,
      codexHomePath: subject.codexHomePath
    }
  });
  assert.equal(matched.matched, true);
  assert.equal(validStandingAuthorization(matched.authorization), true);
  assert.deepEqual(policy.value.deniedAuthorities, [...STANDING_CONSENT_DENIED_AUTHORITIES]);
  assert.equal(policy.value.execution.sandbox, "read-only");
  assert.equal(policy.value.execution.tools, false);
});

test("standing-consent path catalog keeps generated HTML outside standing consent", async () => {
  const policy = await loadStandingConsentPolicy(REPOSITORY);
  assert.deepEqual(policy.value.sanitization.allowedPathPatterns, [...STANDING_CONSENT_ALLOWED_PATH_PATTERNS]);
  assert.ok(STANDING_CONSENT_ALLOWED_PATH_PATTERNS.every((pattern) => !/docs\/html\/(?:index|preview)/.test(pattern)));
  assert.ok(STANDING_CONSENT_ALLOWED_PATH_PATTERNS.some((pattern) => pattern.includes("docs/html/use-cases/assets")));
});

test("standing evaluator consent fails closed for scope, identity, authority, and policy drift", async () => {
  const policy = await loadStandingConsentPolicy(REPOSITORY);
  const { hostStatus, subject } = fixtureGrant(policy);
  const runAs = {
    uid: subject.uid,
    gid: subject.gid,
    homePath: subject.homePath,
    codexHomePath: subject.codexHomePath
  };
  const base = { hostStatus, policy, repo: REPOSITORY, model: "gpt-5.6-terra", purpose: "ordinary", requestCount: 7, runAs };
  assert.equal(matchStandingConsent({ ...base, model: "gpt-5.6-sol" }).matched, false);
  assert.equal(matchStandingConsent({ ...base, requestCount: 8 }).matched, false);
  assert.equal(matchStandingConsent({ ...base, runAs: { ...runAs, uid: 502 } }).matched, false);
  assert.equal(matchStandingConsent({ ...base, repo: "/private/tmp/other-repository" }).matched, false);

  const authorityDrift = fixtureGrant(policy, { authorityStatementDigest: "b".repeat(64) });
  assert.equal(matchStandingConsent({ ...base, hostStatus: authorityDrift.hostStatus }).matched, false);
  const deniedDrift = fixtureGrant(policy, { deniedAuthorities: ["git.commit"] });
  assert.equal(matchStandingConsent({ ...base, hostStatus: deniedDrift.hostStatus }).matched, false);
  const policyDrift = fixtureGrant(policy, { policyDigest: "c".repeat(64) });
  assert.equal(matchStandingConsent({ ...base, hostStatus: policyDrift.hostStatus }).matched, false);
  assert.throws(
    () => validateStandingConsentPolicy({
      ...policy.value,
      sanitization: { ...policy.value.sanitization, secretPattern: "a^" }
    }),
    /sanitization policy is invalid/
  );
  assert.throws(
    () => validateStandingConsentPolicy({
      ...policy.value,
      sanitization: { ...policy.value.sanitization, allowedPathPatterns: ["^.*$"] }
    }),
    /sanitization policy is invalid/
  );
});

test("an installed standing grant never silently falls back to a password prompt", async () => {
  const policy = await loadStandingConsentPolicy(REPOSITORY);
  const { hostStatus, subject } = fixtureGrant(policy);
  hostStatus.standingConsent.state = "active";
  const runAs = {
    uid: subject.uid,
    gid: subject.gid,
    homePath: subject.homePath,
    codexHomePath: subject.codexHomePath
  };
  const exact = matchStandingConsent({
    hostStatus,
    policy,
    repo: REPOSITORY,
    model: "gpt-5.6-terra",
    purpose: "ordinary",
    requestCount: 7,
    runAs
  });
  assert.deepEqual(resolveStandingConsentAuthorization(hostStatus, exact), exact.authorization);
  const mismatch = matchStandingConsent({
    hostStatus,
    policy,
    repo: REPOSITORY,
    model: "gpt-5.6-sol",
    purpose: "ordinary",
    requestCount: 7,
    runAs
  });
  assert.throws(() => resolveStandingConsentAuthorization(hostStatus, mismatch), /failed closed: model mismatch/);
  assert.throws(
    () => resolveStandingConsentAuthorization({ standingConsent: { active: false, state: "invalid", error: "tampered" } }, { matched: false, reasons: ["tampered"] }),
    /failed closed: tampered/
  );
  assert.equal(
    resolveStandingConsentAuthorization({ standingConsent: { active: false, state: "revoked" } }, { matched: false, reasons: ["revoked"] }),
    null
  );
});

test("host standing-consent implementation uses a digest-bound noninteractive command gate without a shell", async () => {
  const source = await readFile(path.resolve(TEST_DIR, "../host-trust.mjs"), "utf8");
  assert.match(source, /NOPASSWD:NOSETENV: sha256:/);
  assert.match(source, /execute-consented-batch/);
  assert.match(source, /standingConsentSudoers/);
  assert.match(source, /validateConsentedPrompt/);
  assert.match(source, /Consented manifest must use one safe direct child/);
  assert.doesNotMatch(source, /sudo \/bin\/sh -c/);
  assert.doesNotMatch(source, /exec\([^\n]*\/bin\/sh/);
  assert.match(source, /baselineSnapshotDigest/);
  assert.match(source, /policyBytes\.toString\("base64"\) !== request\.policySource/);
  const cli = await readFile(path.resolve(TEST_DIR, "../sbw.mjs"), "utf8");
  assert.match(cli, /self-improve consent status\|prepare\|revoke/);
  const skill = await readFile(path.join(REPOSITORY, "plugins/better-workflows/skills/self-improve/SKILL.md"), "utf8");
  assert.match(skill, /do not ask\s+the user to repeat a run-specific authorization sentence/);
  assert.match(skill, /never weaken\s+the rule or silently switch to a password prompt/);
});
