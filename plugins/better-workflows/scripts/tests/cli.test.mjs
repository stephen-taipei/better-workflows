import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sbw.mjs");

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
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

async function selfImproveRepository() {
  const cwd = await repository();
  await mkdir(path.join(cwd, "plugins", "better-workflows", "fixtures"), { recursive: true });
  await mkdir(path.join(cwd, "plugins", "better-workflows", "scripts"), { recursive: true });
  for (const name of ["self-improve-ops-evals.json", "self-improve-ops-evals-v2.json"]) {
    const corpus = await readFile(path.resolve(path.dirname(CLI), "..", "fixtures", name), "utf8");
    await writeFile(path.join(cwd, "plugins", "better-workflows", "fixtures", name), corpus);
  }
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "freeze corpus");
  return cwd;
}

async function fixtureResult(cwd) {
  const suite = JSON.parse(await readFile(path.join(cwd, "plugins", "better-workflows", "fixtures", "self-improve-ops-evals.json"), "utf8"));
  const response = (all) => ({ results: suite.cases.map((item) => ({
    id: item.id, disposition: item.expectedDisposition,
    passedAssertions: all ? item.assertions.map((assertion) => assertion.id) : item.assertions.filter((assertion) => assertion.hardSafety).map((assertion) => assertion.id)
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
  assert.equal(result.json.templates.length, 13);
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

test("self-improve fixture evaluation is explicit, private, and never grants delivery", async () => {
  const cwd = await selfImproveRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-self-improve-state-"));
  await writeFile(path.join(cwd, "plugins", "better-workflows", "scripts", "candidate.mjs"), "export const candidate = 'safe';\n");
  const started = await cli(cwd, stateRoot, [
    "run", "--template", "self-improve-ops", "--mode", "critical", "--goal", "Improve validation", "--scope", ".", "--authority", "git.commit"
  ]);
  const fixture = await fixtureResult(cwd);
  const common = ["self-improve", "evaluate", "--run", started.json.runId, "--cases", "plugins/better-workflows/fixtures/self-improve-ops-evals.json", "--baseline", "HEAD", "--candidate-root", ".", "--backend", "fixture", "--result-file", fixture];
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
  assert.match(delivery.stderr, /trusted Codex held-out comparison/);
});

test("evaluator migration binds immutable v1, current v2, calibration, and a dedicated comparison policy", async () => {
  const cwd = await selfImproveRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-evaluator-migration-"));
  await writeFile(path.join(cwd, "plugins", "better-workflows", "scripts", "sbw.mjs"), "export const candidate = 'evaluation-v2';\n");
  const started = await cli(cwd, stateRoot, [
    "run", "--template", "self-improve-ops", "--mode", "critical", "--goal", "Migrate evaluator", "--scope", ".", "--authority", "git.commit"
  ]);
  const fixture = await fixtureResult(cwd);
  const common = [
    "self-improve", "evaluate",
    "--run", started.json.runId,
    "--cases", "plugins/better-workflows/fixtures/self-improve-ops-evals.json",
    "--next-cases", "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.json",
    "--purpose", "evaluator-migration",
    "--baseline", "HEAD",
    "--candidate-root", ".",
    "--backend", "fixture",
    "--result-file", fixture
  ];
  const train = await cli(cwd, stateRoot, [...common, "--split", "train"], { env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.equal(train.json.calibration.materialGroups.includes("runtime"), true);
  assert.equal(train.json.evidence.length, 4);
  const holdout = await cli(cwd, stateRoot, [...common, "--split", "holdout"], { env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.equal(holdout.json.comparison.accepted, true);
  assert.equal(holdout.json.comparison.policy, "evaluator-migration");
});

test("self-improve evaluation fails closed when its suite or staged candidate changes", async () => {
  const cwd = await selfImproveRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-cli-self-improve-drift-"));
  await writeFile(path.join(cwd, "plugins", "better-workflows", "scripts", "candidate.mjs"), "export const candidate = 'safe';\n");
  const started = await cli(cwd, stateRoot, ["run", "--template", "self-improve-ops", "--mode", "critical", "--goal", "Improve validation", "--scope", "."]);
  const fixture = await fixtureResult(cwd);
  const common = ["self-improve", "evaluate", "--run", started.json.runId, "--cases", "plugins/better-workflows/fixtures/self-improve-ops-evals.json", "--baseline", "HEAD", "--candidate-root", ".", "--backend", "fixture", "--result-file", fixture];
  await writeFile(path.join(cwd, "plugins", "better-workflows", "scripts", "later.mjs"), "export const later = true;\n");
  await git(cwd, "add", "plugins/better-workflows/scripts/later.mjs");
  await git(cwd, "commit", "-qm", "later baseline");
  const changedBaseline = await cli(cwd, stateRoot, [...common, "--split", "train"], { allowFailure: true, env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.match(changedBaseline.stderr, /run-start baseline/);
  const pinnedCommon = [...common];
  const baselineIndex = pinnedCommon.indexOf("--baseline") + 1;
  pinnedCommon[baselineIndex] = "HEAD~";
  await cli(cwd, stateRoot, [...pinnedCommon, "--split", "train"], { env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  await writeFile(path.join(cwd, "plugins", "better-workflows", "scripts", "candidate.mjs"), "export const candidate = 'changed';\n");
  const changedCandidate = await cli(cwd, stateRoot, [...pinnedCommon, "--split", "holdout"], { allowFailure: true, env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.match(changedCandidate.stderr, /fresh training replay/);
  await writeFile(path.join(cwd, "plugins", "better-workflows", "fixtures", "self-improve-ops-evals.json"), "{}\n");
  const changedSuite = await cli(cwd, stateRoot, [...pinnedCommon, "--split", "train"], { allowFailure: true, env: { SBW_TEST_FIXTURE_BACKEND: "1" } });
  assert.match(changedSuite.stderr, /drifted from the immutable baseline/);
});

test("self-improve attestation request freezes seven distinct requests outside the repository", async () => {
  const cwd = await selfImproveRepository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-attestation-state-"));
  const baseline = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8"
  })).stdout.trim();
  const started = await cli(cwd, stateRoot, [
    "run",
    "--template",
    "self-improve-ops",
    "--mode",
    "critical",
    "--goal",
    "Prepare signed evaluation requests",
    "--scope",
    "."
  ]);
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-attestation-output-"));
  const output = path.join(parent, "requests");
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
    process.execPath,
    "--output",
    output
  ]);
  assert.equal(requested.json.requests.length, 7);
  assert.equal(new Set(requested.json.requests.map((item) => item.executionId)).size, 7);
  assert.equal(requested.json.purpose, "ordinary");
  assert.equal(requested.json.suitePath, "plugins/better-workflows/fixtures/self-improve-ops-evals-v2.json");
  assert.equal(requested.json.targetSuiteDigest, null);
  assert.equal(requested.json.manifestPath, path.join(output, "attestation-requests.json"));
  assert.match(requested.json.manifestDigest, /^[a-f0-9]{64}$/);
  assert.equal(requested.json.signCommand.at(-1), requested.json.manifestDigest);
  for (const item of requested.json.requests) {
    assert.equal(path.dirname(item.request), output);
    assert.match(item.requestDigest, /^[a-f0-9]{64}$/);
  }
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
