import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectCodexBinaryPath } from "../lib/attestations.mjs";

const execFileAsync = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sbw.mjs");

test("attestation request defaults only to one host-approved Codex binary", () => {
  const approved = { path: "/private/var/db/better-workflows/bin/bw-host-codex.a", digest: "a".repeat(64) };
  assert.equal(selectCodexBinaryPath(null, [approved]), approved.path);
  assert.equal(selectCodexBinaryPath("/explicit/codex", [approved]), "/explicit/codex");
  assert.equal(selectCodexBinaryPath(null, []), null);
  assert.equal(selectCodexBinaryPath(null, [approved, { ...approved, path: `${approved.path}.second` }]), null);
});

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function revision(cwd, name = "HEAD") {
  return (await execFileAsync("git", ["rev-parse", "--verify", `${name}^{commit}`], {
    cwd,
    encoding: "utf8"
  })).stdout.trim();
}

async function repository() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-repo-"));
  await git(cwd, "init", "-q", "-b", "dev");
  await git(cwd, "config", "user.name", "Stephen Better Workflows Tests");
  await git(cwd, "config", "user.email", "sbw-tests@example.invalid");
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "value.txt"), "one\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

async function cli(cwd, stateRoot, args, { allowFailure = false, env = {} } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, SBW_STATE_ROOT: stateRoot, ...env },
      maxBuffer: 8 * 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr, json: JSON.parse(result.stdout) };
  } catch (error) {
    if (!allowFailure) throw error;
    return {
      code: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      json: error.stdout ? JSON.parse(error.stdout) : null
    };
  }
}

async function selfImproveRepository({ includeV22 = true, includeV23 = includeV22, includeV24 = includeV23 } = {}) {
  const cwd = await repository();
  await mkdir(path.join(cwd, "plugins", "better-workflows", "fixtures"), { recursive: true });
  await mkdir(path.join(cwd, "plugins", "better-workflows", "scripts"), { recursive: true });
  await mkdir(path.join(cwd, "plugins", "better-workflows", "config"), { recursive: true });
  const corpora = ["self-improve-ops-evals.json", "self-improve-ops-evals-v2.json", "self-improve-ops-evals-v2.1.json"];
  if (includeV22) corpora.push("self-improve-ops-evals-v2.2.json");
  if (includeV23) corpora.push("self-improve-ops-evals-v2.3.json");
  if (includeV24) corpora.push("self-improve-ops-evals-v2.4.json");
  for (const name of corpora) {
    const corpus = await readFile(path.resolve(path.dirname(CLI), "..", "fixtures", name), "utf8");
    await writeFile(path.join(cwd, "plugins", "better-workflows", "fixtures", name), corpus);
  }
  const standingConsentPolicy = await readFile(
    path.resolve(path.dirname(CLI), "..", "config", "self-improve-standing-consent-v1.json"),
    "utf8"
  );
  await writeFile(
    path.join(cwd, "plugins", "better-workflows", "config", "self-improve-standing-consent-v1.json"),
    standingConsentPolicy
  );
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "freeze corpus");
  return cwd;
}

async function fixtureResult(cwd, name = "self-improve-ops-evals.json", { baselineUnsatisfiedCaseIds = [] } = {}) {
  const suite = JSON.parse(await readFile(path.join(cwd, "plugins", "better-workflows", "fixtures", name), "utf8"));
  const baselineUnsatisfied = new Set(baselineUnsatisfiedCaseIds);
  const response = (all) => ({ results: suite.cases.map((item) => ({
    id: item.id, disposition: item.expectedDisposition,
    passedAssertions: item.assertions.map((assertion) => (all || assertion.hardSafety) && (all || !baselineUnsatisfied.has(item.id))
      ? assertion.id
      : `NOT_SATISFIED:${assertion.id}`)
  })) });
  const target = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-fixture-results-")), "results.json");
  await writeFile(target, `${JSON.stringify({ baseline: response(false), candidate: response(true) })}\n`);
  return target;
}

test("CLI creates a verified run and returns nonzero on authority drift", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-state-"));
  const started = await cli(cwd, stateRoot, [
    "run",
    "--template",
    "review-to-issues",
    "--mode",
    "verified",
    "--goal",
    "Review src",
    "--scope",
    "src"
  ]);
  assert.equal(started.json.ok, true);
  assert.match(started.json.runId, /^sbw-/);
  assert.equal(started.json.mode, "verified");
  assert.equal(typeof started.json.sentinel.counts.tracked, "number");
  assert.equal(typeof started.json.sentinel.manifest, "string");
  assert.equal("skipped" in started.json.sentinel, false);
  const runId = started.json.runId;
  const contract = JSON.parse(
    await readFile(path.join(stateRoot, "runs", runId, "contract.json"), "utf8")
  );
  assert.equal(typeof contract.templateDigest, "string");
  assert.deepEqual(contract.actionGates, {
    "issue.create": ["base-revision", "review-findings", "duplicate-check", "current-revision"]
  });

  const status = await cli(cwd, stateRoot, ["status", runId]);
  assert.equal(status.json.status, "running");
  assert.equal(status.json.lastSentinelVerified, true);
  assert.equal(status.json.lastSentinelComplete, true);

  const captured = await cli(cwd, stateRoot, [
    "sentinel",
    "capture",
    runId,
    "--label",
    "wave-1"
  ]);
  assert.equal(typeof captured.json.sentinel.counts.skipped, "number");
  assert.equal("skipped" in captured.json.sentinel, false);
  await writeFile(path.join(cwd, "src", "value.txt"), "two\n");
  const verification = await cli(
    cwd,
    stateRoot,
    ["sentinel", "verify", runId, "--label", "wave-1"],
    { allowFailure: true }
  );
  assert.equal(verification.code, 2);
  assert.equal(verification.json.ok, false);
  assert.ok(verification.json.changed.includes("statusDigest"));
});

test("CLI template mode floor prevents an explicit direct downgrade", async () => {
  const cwd = await repository();
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-direct-"));
  const stateRoot = path.join(parent, "missing");
  const result = await cli(cwd, stateRoot, [
    "run",
    "--template",
    "ios-static-pbxproj",
    "--mode",
    "direct",
    "--goal",
    "Explain one line",
    "--scope",
    "src"
  ]);
  assert.equal(result.json.direct, false);
  assert.equal(result.json.mode, "verified");
  await access(stateRoot);
});

test("CLI rejects an unknown run mode instead of silently applying a lower floor", async () => {
  const cwd = await repository();
  const stateRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-cli-mode-")), "state");
  const result = await cli(
    cwd,
    stateRoot,
    [
      "run",
      "--template",
      "review-to-issues",
      "--mode",
      "critcal",
      "--goal",
      "Create issues",
      "--scope",
      "src"
    ],
    { allowFailure: true }
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown mode: critcal/);
  await assert.rejects(access(stateRoot));
});

test("CLI lists exactly the installed workflow templates", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-list-"));
  const result = await cli(cwd, stateRoot, ["templates"]);
  assert.equal(result.json.templates.length, 14);
});

test("CLI routes the self-improve selector to its critical template", async () => {
  const cwd = await repository();
  const stateRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-cli-self-improve-")), "missing");
  const result = await cli(cwd, stateRoot, [
    "route",
    "preview",
    "--goal",
    "Improve Better Workflows from recent evidence",
    "--scope",
    "src",
    "--entry",
    "self-improve"
  ]);
  assert.equal(result.json.source, "explicit-entry");
  assert.equal(result.json.primary.template, "self-improve-ops");
  assert.equal(result.json.effectiveMode, "critical");
  await assert.rejects(access(stateRoot));
});

test("self-improve runs require an explicit full baseline that strictly precedes HEAD", async () => {
  const cwd = await selfImproveRepository();
  const stateRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-cli-self-improve-baseline-")), "missing");
  const missing = await cli(cwd, stateRoot, [
    "run", "--template", "self-improve-ops", "--mode", "critical", "--goal", "Require baseline", "--scope", "."
  ], { allowFailure: true });
  assert.match(missing.stderr, /requires an explicit --baseline/);
  const head = await revision(cwd);
  const same = await cli(cwd, stateRoot, [
    "run", "--template", "self-improve-ops", "--mode", "critical", "--goal", "Reject same baseline", "--scope", ".", "--baseline", head
  ], { allowFailure: true });
  assert.match(same.stderr, /strict ancestor/);
});

test("safety-remediation purpose is fixed at self-improve run creation", async () => {
  const cwd = await selfImproveRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-safety-remediation-purpose-"));
  const baseline = await revision(cwd);
  await writeFile(path.join(cwd, "plugins", "better-workflows", "scripts", "candidate.mjs"), "export const candidate = true;\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "stage remediation candidate");
  const started = await cli(cwd, stateRoot, [
    "run", "--template", "self-improve-ops", "--mode", "critical", "--goal", "Repair safety defects", "--scope", ".",
    "--baseline", baseline, "--evaluation-purpose", "safety-remediation-v1"
  ]);
  const contract = JSON.parse(await readFile(path.join(stateRoot, "runs", started.json.runId, "contract.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(stateRoot, "runs", started.json.runId, "manifest.json"), "utf8"));
  assert.equal(contract.selfImprovePurpose, "safety-remediation-v1");
  assert.equal(manifest.evaluationPurpose, "safety-remediation-v1");
  const switched = await cli(cwd, stateRoot, [
    "self-improve", "evaluate", "--run", started.json.runId, "--cases", "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.2.json",
    "--purpose", "ordinary", "--baseline", baseline, "--candidate-root", ".", "--backend", "fixture", "--result-file", "/nonexistent", "--split", "train"
  ], { allowFailure: true, env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.match(switched.stderr, /immutable run creation purpose/);
});

test("quality-remediation purpose is fixed at self-improve run creation", async () => {
  const cwd = await selfImproveRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-quality-remediation-purpose-"));
  const baseline = await revision(cwd);
  await writeFile(path.join(cwd, "plugins", "better-workflows", "scripts", "candidate.mjs"), "export const candidate = true;\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "stage quality remediation candidate");
  const started = await cli(cwd, stateRoot, [
    "run", "--template", "self-improve-ops", "--mode", "critical", "--goal", "Repair quality gaps", "--scope", ".",
    "--baseline", baseline, "--evaluation-purpose", "quality-remediation-v1"
  ]);
  const contract = JSON.parse(await readFile(path.join(stateRoot, "runs", started.json.runId, "contract.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(stateRoot, "runs", started.json.runId, "manifest.json"), "utf8"));
  assert.equal(contract.selfImprovePurpose, "quality-remediation-v1");
  assert.equal(manifest.evaluationPurpose, "quality-remediation-v1");
});

test("self-improve fixture evaluation is explicit, private, and never grants delivery", async () => {
  const cwd = await selfImproveRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-self-improve-state-"));
  await writeFile(path.join(cwd, "plugins", "better-workflows", "scripts", "candidate.mjs"), "export const candidate = 'safe';\n");
  await git(cwd, "add", "plugins/better-workflows/scripts/candidate.mjs");
  await git(cwd, "commit", "-qm", "stage candidate");
  const baseline = await revision(cwd, "HEAD~");
  const started = await cli(cwd, stateRoot, [
    "run", "--template", "self-improve-ops", "--mode", "critical", "--goal", "Improve validation", "--scope", ".", "--baseline", baseline, "--authority", "git.commit"
  ]);
  const fixture = await fixtureResult(cwd);
  const common = ["self-improve", "evaluate", "--run", started.json.runId, "--cases", "plugins/better-workflows/fixtures/self-improve-ops-evals.json", "--baseline", baseline, "--candidate-root", ".", "--backend", "fixture", "--result-file", fixture];
  const missingFlag = await cli(cwd, stateRoot, [...common, "--split", "train"], { allowFailure: true });
  assert.match(missingFlag.stderr, /test-only/);
  const train = await cli(cwd, stateRoot, [...common, "--split", "train"], { env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.equal(train.json.ok, true);
  const holdout = await cli(cwd, stateRoot, [...common, "--split", "holdout"], { env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.equal(holdout.json.comparison.accepted, true);
  const evidenceDir = path.join(stateRoot, "runs", started.json.runId, "evidence");
  const evidence = await Promise.all((await readdir(evidenceDir)).map(async (name) => readFile(path.join(evidenceDir, name), "utf8")));
  assert.doesNotMatch(evidence.join("\n"), /sensitive operational material/);
  const delivery = await cli(cwd, stateRoot, ["action", "issue", started.json.runId, "--action", "git.commit", "--provider", "git", "--resource", "fixture", "--remote-revision", "none"], { allowFailure: true, env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.match(delivery.stderr, /Governed action is deferred/);
});

test("delegated pr-to-dev runs require the typed self-improve handoff gate", async () => {
  const cwd = await selfImproveRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-self-improve-handoff-"));
  const baseline = await revision(cwd, "HEAD~");
  const source = await cli(cwd, stateRoot, [
    "run", "--template", "self-improve-ops", "--mode", "critical", "--goal", "Prepare delivery", "--scope", ".", "--baseline", baseline
  ]);
  const target = await cli(cwd, stateRoot, [
    "run", "--template", "pr-to-dev", "--mode", "critical", "--goal", "Deliver accepted improvement", "--scope", ".", "--self-improve-run", source.json.runId
  ]);
  const contract = JSON.parse(await readFile(path.join(stateRoot, "runs", target.json.runId, "contract.json"), "utf8"));
  assert.equal(contract.upstreamSelfImproveRunId, source.json.runId);
  assert.ok(contract.requiredEvidence.includes("self-improve-delivery-handoff"));
  assert.ok(contract.requiredEvidence.includes("cache-publication"));
  for (const requirements of Object.values(contract.acceptanceEvidence)) {
    assert.ok(requirements.includes("self-improve-delivery-handoff"));
    assert.ok(requirements.includes("cache-publication"));
  }
  for (const action of ["git.commit", "plugin.cache.publish", "git.push", "pr.create", "pr.merge", "remote.sync", "worktree.cleanup"]) {
    assert.ok(contract.actionGates[action].includes("self-improve-delivery-handoff"), action);
  }
  const commitsStageEvidence = contract.executionStages.find((stage) => stage.id === "commits").requiredEvidence;
  assert.ok(commitsStageEvidence.includes("self-improve-delivery-handoff"));
  assert.ok(commitsStageEvidence.includes("cache-publication"));
});

test("evaluator migration requires accepted training before holdout and binds immutable source and target suites", async () => {
  const cwd = await selfImproveRepository({ includeV24: false });
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-evaluator-migration-"));
  await writeFile(
    path.join(cwd, "plugins", "better-workflows", "fixtures", "self-improve-ops-evals-v2.4.json"),
    await readFile(path.resolve(path.dirname(CLI), "..", "fixtures", "self-improve-ops-evals-v2.4.json"))
  );
  await writeFile(path.join(cwd, "plugins", "better-workflows", "scripts", "sbw.mjs"), "export const candidate = 'evaluation-v2';\n");
  await git(cwd, "add", "plugins/better-workflows/scripts/sbw.mjs", "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.4.json");
  await git(cwd, "commit", "-qm", "stage evaluator candidate");
  const baseline = await revision(cwd, "HEAD~");
  const started = await cli(cwd, stateRoot, [
    "run", "--template", "self-improve-ops", "--mode", "critical", "--goal", "Migrate evaluator", "--scope", ".", "--baseline", baseline, "--authority", "git.commit"
  ]);
  const fixture = await fixtureResult(cwd, "self-improve-ops-evals-v2.4.json", {
    baselineUnsatisfiedCaseIds: ["review-kernel-total-accounting", "review-kernel-independent-synthesis"]
  });
  const common = [
    "self-improve", "evaluate",
    "--run", started.json.runId,
    "--cases", "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.3.json",
    "--next-cases", "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.4.json",
    "--purpose", "evaluator-migration",
    "--baseline", baseline,
    "--candidate-root", ".",
    "--backend", "fixture",
    "--result-file", fixture
  ];
  const prematureHoldout = await cli(cwd, stateRoot, [...common, "--split", "holdout"], {
    allowFailure: true,
    env: { SBW_TEST_FIXTURE_BACKEND: "1" }
  });
  assert.match(prematureHoldout.stderr, /requires a fresh training replay/);
  const train = await cli(cwd, stateRoot, [...common, "--split", "train"], { env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.equal(train.json.calibration.materialGroups.includes("runtime"), true);
  assert.equal(train.json.migrationTrainingComparison.accepted, true);
  assert.deepEqual(
    train.json.calibration.targetOnlyCaseIds.train,
    ["review-kernel-total-accounting"]
  );
  assert.equal(train.json.evidence.length, 4);
  const holdout = await cli(cwd, stateRoot, [...common, "--split", "holdout"], { env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.equal(holdout.json.comparison.accepted, true);
  assert.equal(holdout.json.comparison.policy, "evaluator-migration");
});

test("ordinary evaluator resume pins legacy runs while new runs require the new canonical corpus", async () => {
  const legacyCwd = await selfImproveRepository({ includeV22: false });
  const legacyStateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-evaluator-reader-legacy-"));
  await writeFile(path.join(legacyCwd, "plugins", "better-workflows", "scripts", "sbw.mjs"), "export const candidate = 'legacy-reader';\n");
  await git(legacyCwd, "add", "plugins/better-workflows/scripts/sbw.mjs");
  await git(legacyCwd, "commit", "-qm", "stage legacy candidate");
  const legacyBaseline = await revision(legacyCwd, "HEAD~");
  const legacy = await cli(legacyCwd, legacyStateRoot, [
    "run", "--template", "self-improve-ops", "--mode", "critical", "--goal", "Resume v2.1 evaluation", "--scope", ".", "--baseline", legacyBaseline
  ]);
  const legacyAdmission = await cli(legacyCwd, legacyStateRoot, [
    "self-improve", "evaluate",
    "--run", legacy.json.runId,
    "--cases", "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.1.json",
    "--baseline", legacyBaseline,
    "--candidate-root", ".",
    "--backend", "codex",
    "--model", "gpt-5.6-sol",
    "--allow-codex",
    "--sanitized",
    "--trusted-codex-execution", "/nonexistent",
    "--split", "train"
  ], { allowFailure: true });
  assert.match(legacyAdmission.stderr, /request-manifest.*request-manifest-digest/);
  assert.doesNotMatch(legacyAdmission.stderr, /self-improve-ops-evals-v2\.2\.json/);

  const currentCwd = await selfImproveRepository();
  const currentStateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-evaluator-reader-current-"));
  await writeFile(path.join(currentCwd, "plugins", "better-workflows", "scripts", "sbw.mjs"), "export const candidate = 'current-reader';\n");
  await git(currentCwd, "add", "plugins/better-workflows/scripts/sbw.mjs");
  await git(currentCwd, "commit", "-qm", "stage current candidate");
  const currentBaseline = await revision(currentCwd, "HEAD~");
  const current = await cli(currentCwd, currentStateRoot, [
    "run", "--template", "self-improve-ops", "--mode", "critical", "--goal", "Require v2.4 evaluation", "--scope", ".", "--baseline", currentBaseline
  ]);
  const rejected = await cli(currentCwd, currentStateRoot, [
    "self-improve", "evaluate",
    "--run", current.json.runId,
    "--cases", "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.1.json",
    "--baseline", currentBaseline,
    "--candidate-root", ".",
    "--backend", "codex",
    "--model", "gpt-5.6-sol",
    "--allow-codex",
    "--sanitized",
    "--trusted-codex-execution", "/nonexistent",
    "--split", "train"
  ], { allowFailure: true });
  assert.match(rejected.stderr, /self-improve-ops-evals-v2\.4\.json/);
});

test("self-improve evaluation fails closed when its suite or staged candidate changes", async () => {
  const cwd = await selfImproveRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-self-improve-drift-"));
  await writeFile(path.join(cwd, "plugins", "better-workflows", "scripts", "candidate.mjs"), "export const candidate = 'safe';\n");
  await git(cwd, "add", "plugins/better-workflows/scripts/candidate.mjs");
  await git(cwd, "commit", "-qm", "stage drift candidate");
  const baseline = await revision(cwd, "HEAD~");
  const started = await cli(cwd, stateRoot, ["run", "--template", "self-improve-ops", "--mode", "critical", "--goal", "Improve validation", "--scope", ".", "--baseline", baseline]);
  const fixture = await fixtureResult(cwd);
  const common = ["self-improve", "evaluate", "--run", started.json.runId, "--cases", "plugins/better-workflows/fixtures/self-improve-ops-evals.json", "--baseline", baseline, "--candidate-root", ".", "--backend", "fixture", "--result-file", fixture];
  await writeFile(path.join(cwd, "plugins", "better-workflows", "scripts", "later.mjs"), "export const later = true;\n");
  await git(cwd, "add", "plugins/better-workflows/scripts/later.mjs");
  await git(cwd, "commit", "-qm", "later baseline");
  const changedBaseline = await cli(cwd, stateRoot, [...common, "--split", "train"], { allowFailure: true, env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.match(changedBaseline.stderr, /run-bound source revision|run-start baseline/);
  await cli(cwd, stateRoot, ["source", "rebind", started.json.runId, "--reason", "test commit stage completed"]);
  const pinnedCommon = [...common];
  const baselineIndex = pinnedCommon.indexOf("--baseline") + 1;
  pinnedCommon[baselineIndex] = baseline;
  await cli(cwd, stateRoot, [...pinnedCommon, "--split", "train"], { env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  await writeFile(path.join(cwd, "plugins", "better-workflows", "scripts", "candidate.mjs"), "export const candidate = 'changed';\n");
  const changedCandidate = await cli(cwd, stateRoot, [...pinnedCommon, "--split", "holdout"], { allowFailure: true, env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.match(changedCandidate.stderr, /fresh training replay|clean index, tracked worktree/);
  await writeFile(path.join(cwd, "plugins", "better-workflows", "fixtures", "self-improve-ops-evals.json"), "{}\n");
  const changedSuite = await cli(cwd, stateRoot, [...pinnedCommon, "--split", "train"], { allowFailure: true, env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.match(changedSuite.stderr, /drifted from the immutable baseline/);
});

test("evaluator migration attestation binds eight distinct migration witnesses, train baseline, every target-only case, and rejects unsafe drift", async () => {
  const cwd = await selfImproveRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-attestation-state-"));
  await writeFile(path.join(cwd, "plugins", "better-workflows", "scripts", "sbw.mjs"), "export const candidate = true;\n");
  await git(cwd, "add", "plugins/better-workflows/scripts/sbw.mjs");
  await git(cwd, "commit", "-qm", "stage attestation candidate");
  const baseline = await revision(cwd, "HEAD~");
  const started = await cli(cwd, stateRoot, [
    "run",
    "--template",
    "self-improve-ops",
    "--mode",
    "critical",
    "--goal",
    "Prepare signed evaluation requests",
    "--scope",
    ".",
    "--baseline",
    baseline
  ]);
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-attestation-output-"));
  const output = path.join(parent, "requests");
  const hostStatus = await cli(cwd, stateRoot, ["self-improve", "host", "status"], { allowFailure: true });
  const hostBundle = hostStatus.json?.hostBundle ?? {
    runtimeDigest: hostStatus.json?.runtime?.digest ?? null,
    signerDigest: hostStatus.json?.signer?.digest ?? null
  };
  const hostRuntimeReady = hostStatus.code === 0 && hostStatus.json?.ready === true &&
    hostBundle.runtimeDigest === hostStatus.json?.runtime?.digest &&
    hostBundle.signerDigest === hostStatus.json?.signer?.digest;
  const standingGrant = hostStatus.json?.standingConsent?.active === true
    ? hostStatus.json.standingConsent.grant
    : null;
  const standingConsentBlocksFixture = Boolean(hostRuntimeReady && (
    hostStatus.json?.standingConsent?.active !== true ||
    !standingGrant ||
    standingGrant.repo !== cwd ||
    !standingGrant.models?.includes("gpt-5.6-sol")
  ));
  const hostReady = hostRuntimeReady && !standingConsentBlocksFixture;
  const approvedBinary = hostStatus.json?.codexBinary?.validEntries?.[0]?.path ?? process.execPath;
  if (hostStatus.code !== 0) {
    assert.match(hostStatus.stderr, /Administrator host status is unavailable|ENOENT: no such file or directory, lstat .*better-workflows.*codex-trust-root/);
  }
  const requested = await cli(cwd, stateRoot, [
    "self-improve",
    "attestation",
    "request",
    "--run",
    started.json.runId,
    "--baseline",
    baseline,
    "--candidate-root",
    ".",
    "--model",
    "gpt-5.6-sol",
    "--binary",
    approvedBinary,
    "--output",
    output
  ], { allowFailure: !hostReady });
  if (!hostReady) {
    if (standingConsentBlocksFixture) {
      assert.match(requested.stderr, /Standing evaluator consent failed closed/);
      if (standingGrant) {
        assert.match(requested.stderr, /repository mismatch/);
        assert.match(requested.stderr, /model mismatch/);
      } else {
        assert.match(requested.stderr, /sanitization policy mismatch|consent is not active/);
      }
      return;
    }
    assert.match(requested.stderr, /Administrator host runtime(?: or signed host bundle)? is not ready|host-trust upgrade first/);
    return;
  }
  assert.equal(requested.json.requests.length, 7);
  assert.equal(new Set(requested.json.requests.map((item) => item.executionId)).size, 7);
  assert.equal(requested.json.purpose, "ordinary");
  assert.equal(requested.json.suitePath, "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.4.json");
  assert.equal(requested.json.targetSuiteDigest, null);
  assert.equal(requested.json.manifestPath, path.join(output, "attestation-requests.json"));
  assert.match(requested.json.manifestDigest, /^[a-f0-9]{64}$/);
  assert.equal(requested.json.executeCommand.at(-1), requested.json.manifestDigest);
  assert.deepEqual(requested.json.executeCommand, [
    "/usr/bin/sudo",
    requested.json.runtimePath,
    "/private/var/db/better-workflows/bin/bw-host-trust.mjs",
    "execute-batch",
    "--manifest",
    requested.json.manifestPath,
    "--confirm-digest",
    requested.json.manifestDigest
  ]);
  assert.equal(requested.json.executeCommand.includes("/bin/sh"), false);
  assert.equal(requested.json.executeCommand.includes("-c"), false);
  assert.match(requested.json.runtimeDigest, /^[a-f0-9]{64}$/);
  assert.equal(requested.json.hostBundle.runtimeDigest, requested.json.runtimeDigest);
  assert.match(requested.json.hostBundleDigest, /^[a-f0-9]{64}$/);
  assert.equal(requested.json.schemaVersion, 2);
  assert.equal(requested.json.runAs.uid, process.getuid());
  assert.equal(requested.json.runAs.gid, process.getgid());
  assert.equal(requested.json.runAs.homePath, path.resolve(process.env.HOME));
  assert.ok(requested.json.runAs.codexHomePath === null || path.isAbsolute(requested.json.runAs.codexHomePath));
  for (const item of requested.json.requests) {
    assert.equal(path.dirname(item.request), output);
    assert.match(item.promptDigest, /^[a-f0-9]{64}$/);
    assert.match(item.requestDigest, /^[a-f0-9]{64}$/);
    const request = JSON.parse(await readFile(item.request, "utf8"));
    assert.match(request.binaryDigest, /^[a-f0-9]{64}$/);
  }

  const migrationOutput = path.join(parent, "migration-requests");
  const migration = await cli(cwd, stateRoot, [
    "self-improve",
    "attestation",
    "request",
    "--run",
    started.json.runId,
    "--baseline",
    baseline,
    "--candidate-root",
    ".",
    "--model",
    "gpt-5.6-sol",
    "--binary",
    approvedBinary,
    "--output",
    migrationOutput,
    "--purpose",
    "evaluator-migration",
    "--cases",
    "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.3.json",
    "--next-cases",
    "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.4.json"
  ]);
  assert.equal(migration.json.requests.length, 8);
  assert.deepEqual(
    migration.json.requests.filter((item) => item.role.startsWith("train-")).map((item) => item.role).sort(),
    ["train-baseline", "train-candidate"]
  );
  assert.equal(migration.json.suitePath, "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.3.json");
  assert.equal(migration.json.targetSuitePath, "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.4.json");
  assert.match(migration.json.sourceSuiteDigest, /^[a-f0-9]{64}$/);
  assert.match(migration.json.targetSuiteDigest, /^[a-f0-9]{64}$/);
  const migrationPrompts = [];
  for (const item of migration.json.requests) {
    const request = JSON.parse(await readFile(item.request, "utf8"));
    assert.equal(request.execution.suiteDigest, migration.json.suiteDigest);
    migrationPrompts.push(await readFile(request.promptPath, "utf8"));
  }
  const targetSuite = JSON.parse(await readFile(path.join(
    cwd,
    "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.4.json"
  ), "utf8"));
  const signedPromptCorpus = migrationPrompts.join("\n");
  for (const evaluationCase of targetSuite.cases) {
    assert.match(signedPromptCorpus, new RegExp(evaluationCase.id));
  }
  for (const id of [
    "review-kernel-total-accounting",
    "review-kernel-independent-synthesis"
  ]) {
    assert.match(signedPromptCorpus, new RegExp(id));
  }

  await mkdir(path.join(cwd, "plugins", "better-workflows", "scripts", "lib"), { recursive: true });
  await writeFile(
    path.join(cwd, "plugins", "better-workflows", "scripts", "lib", "providers.mjs"),
    "export const token = \"12345678\";\n"
  );
  const rejectedOutput = path.join(parent, "rejected-requests");
  const rejected = await cli(cwd, stateRoot, [
    "self-improve",
    "attestation",
    "request",
    "--run",
    started.json.runId,
    "--baseline",
    baseline,
    "--candidate-root",
    ".",
    "--model",
    "gpt-5.6-sol",
    "--binary",
    approvedBinary,
    "--output",
    rejectedOutput
  ], { allowFailure: true });
  assert.match(rejected.stderr, /secret-shaped content|clean index, tracked worktree, untracked surface, and ignored surface/);
  await assert.rejects(access(rejectedOutput), { code: "ENOENT" });
});

test("CLI previews, records, and consumes a fail-closed route receipt", async () => {
  const cwd = await repository();
  const stateRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-cli-route-")), "state");
  const preview = await cli(cwd, stateRoot, [
    "route",
    "preview",
    "--goal",
    "Review src and create issues",
    "--scope",
    "src",
    "--entry",
    "review-issues",
    "--record"
  ]);
  assert.equal(preview.json.ok, true);
  assert.equal(preview.json.primary.template, "review-to-issues");
  assert.equal(typeof preview.json.receipt.id, "string");

  const run = await cli(cwd, stateRoot, [
    "run",
    "--route-receipt",
    preview.json.receipt.id
  ]);
  assert.equal(run.json.mode, "verified");
  assert.equal(run.json.routeReceipt, preview.json.receipt.id);

  const replay = await cli(
    cwd,
    stateRoot,
    ["run", "--route-receipt", preview.json.receipt.id],
    { allowFailure: true }
  );
  assert.notEqual(replay.code, 0);
  assert.match(replay.stderr, /already claimed/);
});

test("CLI read-only routing commands neither create state nor accept misspelled options", async () => {
  const cwd = await repository();
  const stateRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-cli-readonly-")), "missing");
  const snapshot = await cli(cwd, stateRoot, ["doctor", "--capabilities"]);
  assert.equal(snapshot.json.providerProbeStarted, false);
  await assert.rejects(access(stateRoot));

  const typo = await cli(
    cwd,
    stateRoot,
    ["route", "preview", "--goal", "Review src", "--templat", "review-to-issues"],
    { allowFailure: true }
  );
  assert.notEqual(typo.code, 0);
  assert.match(typo.stderr, /Unknown option/);
  await assert.rejects(access(stateRoot));
});

test("CLI built-in auto receipt remains reviewable but cannot start without a concrete template", async () => {
  const cwd = await repository();
  const stateRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-cli-auto-route-")), "state");
  const preview = await cli(cwd, stateRoot, [
    "route",
    "preview",
    "--goal",
    "Do the right workflow",
    "--scope",
    "src",
    "--record"
  ]);
  assert.equal(preview.json.needsSelection, true);
  assert.equal(preview.json.primary.template, null);
  const run = await cli(
    cwd,
    stateRoot,
    ["run", "--route-receipt", preview.json.receipt.id],
    { allowFailure: true }
  );
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /does not resolve a concrete template/);
});

test("CLI custom contracts cannot remove template required evidence minimums", async () => {
  const cwd = await repository();
  const stateRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-cli-contract-minimum-")), "state");
  const contractPath = path.join(cwd, "custom-contract.json");
  await writeFile(contractPath, `${JSON.stringify({
    schemaVersion: 1,
    goal: "Review with a custom contract",
    template: "review-to-issues",
    scope: { include: ["src"], exclude: [] },
    acceptance: [{ id: "custom-review", description: "Custom review is complete.", critical: true }],
    requiredEvidence: [],
    authority: { rootOnlyMutation: true, externalSideEffects: [] },
    risk: { risk: 1, uncertainty: 1, blastRadius: 1, irreversibility: 0, evidenceGap: 1 },
    sensitivity: "internal",
    agy: { allowed: false, sanitized: false },
    volatileExclusions: [],
    highRiskIgnored: [],
    remoteRevision: null
  }, null, 2)}\n`);

  const result = await cli(
    cwd,
    stateRoot,
    ["run", "--template", "review-to-issues", "--contract", contractPath],
    { allowFailure: true }
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /cannot remove template required evidence/);
  await assert.rejects(access(stateRoot));
});

test("CLI rejects a v1 contract supplied for a v2 template", async () => {
  const cwd = await repository();
  const stateRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-cli-v2-downgrade-")), "state");
  const contractPath = path.join(cwd, "v1-cross-platform-contract.json");
  const template = JSON.parse(await readFile(path.resolve(path.dirname(CLI), "..", "templates", "cross-platform-contract.json"), "utf8"));
  await writeFile(contractPath, `${JSON.stringify({
    schemaVersion: 1,
    goal: "Attempt a legacy contract downgrade",
    template: "cross-platform-contract",
    scope: { include: ["src"], exclude: [] },
    acceptance: [{ id: "legacy", description: "Legacy contract is complete.", critical: true }],
    requiredEvidence: template.requiredEvidence,
    authority: { rootOnlyMutation: true, externalSideEffects: [] },
    risk: { risk: 1, uncertainty: 1, blastRadius: 1, irreversibility: 0, evidenceGap: 1 },
    sensitivity: "internal",
    agy: { allowed: false, sanitized: false },
    volatileExclusions: [],
    highRiskIgnored: [],
    remoteRevision: null
  }, null, 2)}\n`);

  const result = await cli(
    cwd,
    stateRoot,
    ["run", "--template", "cross-platform-contract", "--contract", contractPath],
    { allowFailure: true }
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /v2 templates require a schemaVersion 2/);
  await assert.rejects(access(stateRoot));
});

test("CLI custom v2 contracts cannot weaken the installed control-plane policy", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-v2-policy-"));
  const started = await cli(cwd, stateRoot, [
    "run",
    "--template",
    "cross-platform-contract",
    "--mode",
    "verified",
    "--goal",
    "Check contract",
    "--scope",
    "src"
  ]);
  const contract = JSON.parse(await readFile(path.join(stateRoot, "runs", started.json.runId, "contract.json"), "utf8"));
  contract.controlPlane.reviewPolicy = "none";
  const contractPath = path.join(cwd, "weakened-contract.json");
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  const result = await cli(cwd, stateRoot, [
    "run",
    "--template",
    "cross-platform-contract",
    "--contract",
    contractPath
  ], { allowFailure: true });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /cannot weaken template control-plane policy/);
});

test("CLI resume migrates a legacy 1.0 run to template-bound action gates", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-legacy-"));
  const started = await cli(cwd, stateRoot, [
    "run",
    "--template",
    "review-to-issues",
    "--mode",
    "verified",
    "--goal",
    "Review legacy run",
    "--scope",
    "src"
  ]);
  const runDir = path.join(stateRoot, "runs", started.json.runId);
  const contractPath = path.join(runDir, "contract.json");
  const manifestPath = path.join(runDir, "manifest.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  delete contract.templateDigest;
  delete contract.actionGates;
  delete contract.requiredEvidence;
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = "1.0.0";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const resumed = await cli(
    cwd,
    stateRoot,
    ["resume", started.json.runId],
    { allowFailure: true }
  );
  assert.notEqual(resumed.code, 0);
  assert.equal(resumed.json.migration.migrated, true);
  assert.equal(resumed.json.ok, false);
  assert.equal(resumed.json.status, "stale");
  const migrated = JSON.parse(await readFile(contractPath, "utf8"));
  assert.equal(typeof migrated.templateDigest, "string");
  assert.deepEqual(migrated.requiredEvidence, [
    "base-revision",
    "review-findings",
    "duplicate-check",
    "current-revision"
  ]);
  assert.deepEqual(migrated.actionGates, {
    "issue.create": ["base-revision", "review-findings", "duplicate-check", "current-revision"]
  });
  const resumedAgain = await cli(cwd, stateRoot, ["resume", started.json.runId]);
  assert.equal(resumedAgain.json.migration.migrated, false);
  assert.equal(resumedAgain.json.ok, true);
  assert.equal(resumedAgain.json.status, "running");
});
