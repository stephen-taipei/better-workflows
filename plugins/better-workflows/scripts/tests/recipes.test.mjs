import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  access,
  appendFile,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  addEvidence as addCoreEvidence,
  addFinding,
  currentActionEvidenceGateBinding,
  digestObject,
  inspectRun,
  loadDefaults,
  pluginRoot,
  reconcileAction,
  sha256
} from "../lib/core.mjs";
import { captureSentinel, captureSourceBinding } from "../lib/git.mjs";
import { transitionLedger } from "../lib/ledger.mjs";
import { recipeArtifactPromote, recipePromote } from "../lib/recipes.mjs";
import { createReviewPackage, markBroadReviewComplete, reviewStatus } from "../lib/review.mjs";

const execFileAsync = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sbw.mjs");
const RUNTIME = path.join(pluginRoot(), "scripts", "lib", "recipe-runtime.mjs");

function runRuntime(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNTIME], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(request));
  });
}

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function repository() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sbw-recipe-repo-"));
  await git(cwd, "init", "-q", "-b", "dev");
  await git(cwd, "config", "user.name", "Better Workflows Recipe Tests");
  await git(cwd, "config", "user.email", "recipes@example.invalid");
  await writeFile(path.join(cwd, "README.md"), "# fixture\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

async function cli(cwd, stateRoot, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, SBW_STATE_ROOT: stateRoot },
      maxBuffer: 16 * 1024 * 1024
    });
    return { code: 0, json: JSON.parse(result.stdout), stderr: result.stderr };
  } catch (error) {
    if (!allowFailure) throw error;
    return {
      code: error.code,
      json: error.stdout ? JSON.parse(error.stdout) : null,
      stderr: error.stderr ?? ""
    };
  }
}

async function addEvidence(cwd, stateRoot, runId, kind, acceptanceIds, payloadOverride = null) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-recipe-evidence-"));
  const target = path.join(directory, `${kind}.json`);
  const run = JSON.parse(await readFile(path.join(stateRoot, "runs", runId, "contract.json"), "utf8"));
  const payload = payloadOverride ?? (kind === "current-sentinel"
    ? { items: [] }
    : kind === "artifact-receipt"
      ? { artifact: { digest: "b".repeat(64) } }
      : kind === "promotion-decision"
        ? { outcome: "success" }
        : { command: "recipe-fixture", result: true });
  const receipt = {
    contractId: `evidence-contracts-v1:${kind}`,
    contractVersion: 1,
    runId,
    producer: { provider: "codex-root" },
    inputBinding: { runId, contractDigest: digestObject(run), remoteRevision: null },
    payload,
    payloadDigest: digestObject(payload),
    producedAt: new Date().toISOString()
  };
  await writeFile(
    target,
    `${JSON.stringify({
      schemaVersion: 2,
      id: `evidence-${kind}`,
      kind,
      summary: `${kind} complete`,
      status: "complete",
      acceptanceIds,
      dependencyInputs: { files: [] },
      sourceDigest: receipt.payloadDigest,
      receipt
    })}\n`
  );
  return cli(cwd, stateRoot, ["evidence", "add", runId, "--file", target]);
}

test("recipe runtime imports the verified source snapshot instead of a replaceable path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-recipe-source-snapshot-"));
  const entryPath = path.join(directory, "run.mjs");
  const safeSource = `export default async function run() {
  return { marker: "verified-snapshot" };
}
`;
  await writeFile(entryPath, `export default async function run() { return { marker: "tampered-path" }; }\n`);
  const result = await runRuntime({
    entryPath,
    scriptDigest: sha256(safeSource),
    sourceBase64: Buffer.from(safeSource).toString("base64"),
    input: {},
    workspacePath: directory,
    artifactStagingPath: directory,
    timeoutMs: 1_000
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    result: { marker: "verified-snapshot" },
    sourceBytes: Buffer.byteLength(safeSource)
  });
});

async function ledgerTransition(stateRoot, runId, eventId, type, taskId, evidenceKinds = []) {
  const file = path.join(stateRoot, "runs", runId, "ledger.json");
  const ledger = JSON.parse(await readFile(file, "utf8"));
  return transitionLedger(stateRoot, runId, {
    eventId,
    type,
    taskId,
    evidenceKinds,
    expectedLedgerDigest: digestObject(ledger)
  });
}

async function governedRun(cwd, stateRoot) {
  const template = JSON.parse(await readFile(path.join(pluginRoot(), "templates", "workspace-recipe.json"), "utf8"));
  const contractPath = path.join(await mkdtemp(path.join(os.tmpdir(), "sbw-recipe-contract-")), "contract.json");
  await writeFile(contractPath, `${JSON.stringify({
    schemaVersion: 2,
    goal: "Promote deterministic reference recipe",
    template: "workspace-recipe",
    templateDigest: digestObject(template),
    reviewProfile: structuredClone(template.reviewProfile),
    scope: { include: ["."], exclude: [] },
    acceptance: structuredClone(template.acceptance),
    requiredEvidence: [...template.requiredEvidence],
    controlPlane: structuredClone(template.controlPlane),
    executionStages: structuredClone(template.executionStages),
    actionStages: structuredClone(template.actionStages),
    authority: { rootOnlyMutation: true, externalSideEffects: ["recipe.promote", "artifact.promote"] },
    risk: { risk: 0, uncertainty: 0, blastRadius: 0, irreversibility: 0, evidenceGap: 0 },
    sensitivity: "internal",
    agy: { allowed: false, sanitized: false, required: false },
    volatileExclusions: [],
    highRiskIgnored: [],
    remoteRevision: null,
    actionGates: structuredClone(template.actionGates),
    acceptanceEvidence: Object.fromEntries(template.acceptance.map((item) => [item.id, [...template.requiredEvidence]]))
  }, null, 2)}\n`);
  const started = await cli(cwd, stateRoot, [
    "run",
    "--template",
    "workspace-recipe",
    "--contract",
    contractPath,
    "--mode",
    "verified",
    "--goal",
    "Promote deterministic reference recipe",
    "--scope",
    ".",
    "--authority",
    "recipe.promote",
    "--authority",
    "artifact.promote"
  ]);
  const acceptance = [
    "recipe-bounded",
    "candidate-repeatable",
    "trust-explicit",
    "artifact-governed"
  ];
  for (const kind of [
    "recipe-contract",
    "fixture-test",
    "candidate-dry-run",
    "digest-confirmation",
    "current-sentinel",
    "artifact-receipt",
    "promotion-decision"
  ]) {
    await addEvidence(cwd, stateRoot, started.json.runId, kind, acceptance);
  }
  const head = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
  const review = await createReviewPackage({
    root: stateRoot,
    runId: started.json.runId,
    base: head,
    head,
    scope: ["."],
    diffManifest: { files: [] },
    instructionDigest: "c".repeat(64),
    sentinelDigest: started.json.sentinel.digest
  });
  await addEvidence(cwd, stateRoot, started.json.runId, "diff-review", [], {
    verdict: "PASS",
    findingCount: 0,
    packageId: review.packageId,
    base: review.base,
    head,
    scopeDigest: review.scopeDigest,
    diffManifestDigest: review.diffManifestDigest,
    instructionDigest: review.instructionDigest
  });
  await markBroadReviewComplete(stateRoot, started.json.runId, review.packageId, head, started.json.sentinel.digest);
  await ledgerTransition(stateRoot, started.json.runId, "contract-start", "start", "contract");
  await ledgerTransition(stateRoot, started.json.runId, "contract-complete", "complete", "contract", ["recipe-contract"]);
  await ledgerTransition(stateRoot, started.json.runId, "fixture-start", "start", "fixture-dry-run");
  await ledgerTransition(stateRoot, started.json.runId, "fixture-complete", "complete", "fixture-dry-run", ["fixture-test", "candidate-dry-run"]);
  await ledgerTransition(stateRoot, started.json.runId, "trust-start", "start", "trust");
  return started.json.runId;
}

async function issueAndConsume(cwd, stateRoot, runId, action, resource) {
  const issued = await cli(cwd, stateRoot, [
    "action",
    "issue",
    runId,
    "--action",
    action,
    "--provider",
    "local-workspace",
    "--resource",
    resource,
    "--remote-revision",
    "local"
  ]);
  const consumed = await cli(cwd, stateRoot, [
    "action",
    "consume",
    runId,
    "--token",
    issued.json.action.token
  ]);
  return consumed.json.action.attemptId;
}

function testSentinelPathBinding(sentinel, relativePath) {
  const tracked = (sentinel.scopeDigest?.records ?? []).find((item) => item.path === relativePath);
  if (tracked) return { surface: "tracked", record: tracked };
  const untracked = (sentinel.untracked?.records ?? []).find((item) => item.path === relativePath);
  return untracked ? { surface: "untracked", record: untracked } : null;
}

test("recipe commands never initialize silently and strict validation rejects unknown fields", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-recipe-state-"));
  const before = await cli(cwd, stateRoot, ["recipe", "list"], { allowFailure: true });
  assert.notEqual(before.code, 0);
  assert.match(before.stderr, /not initialized/);
  await assert.rejects(access(path.join(cwd, ".codex", "better-workflows")));

  await cli(cwd, stateRoot, ["recipe", "init"]);
  await cli(cwd, stateRoot, ["recipe", "scaffold", "json-keyset-audit"]);
  const manifestPath = path.join(
    cwd,
    ".codex",
    "better-workflows",
    "recipes",
    "json-keyset-audit",
    "recipe.json"
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.unexpectedAuthority = true;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const invalid = await cli(
    cwd,
    stateRoot,
    ["recipe", "validate", "json-keyset-audit"],
    { allowFailure: true }
  );
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.stderr, /unknown fields: unexpectedAuthority/);
});

test("recipe validation denies traversal, symlink scope, network, child process, workers, and process access", async () => {
  const cases = [
    {
      name: "traversal",
      mutate(manifest) {
        manifest.readPaths = ["../outside"];
      },
      error: /traversal/
    },
    {
      name: "network",
      source: 'import http from "node:http";\nexport default async function run() { return http; }\n',
      error: /import is not allowed: node:http/
    },
    {
      name: "child",
      source: 'import cp from "node:child_process";\nexport default async function run() { return cp; }\n',
      error: /import is not allowed: node:child_process/
    },
    {
      name: "worker",
      source: 'export default async function run() { return new Worker("x"); }\n',
      error: /forbidden capability: worker/
    },
    {
      name: "process",
      source: "export default async function run() { return process.env; }\n",
      error: /forbidden capability: process/
    },
    {
      name: "hardlink-api",
      source: `import { link } from "node:fs/promises";
export default async function run() { return link; }
`,
      error: /forbidden capability: filesystem link/
    }
  ];
  for (const item of cases) {
    const cwd = await repository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), `sbw-recipe-${item.name}-`));
    await cli(cwd, stateRoot, ["recipe", "init"]);
    await cli(cwd, stateRoot, ["recipe", "scaffold", "blocked-recipe"]);
    const directory = path.join(cwd, ".codex", "better-workflows", "recipes", "blocked-recipe");
    if (item.source) await writeFile(path.join(directory, "run.mjs"), item.source);
    if (item.mutate) {
      const target = path.join(directory, "recipe.json");
      const manifest = JSON.parse(await readFile(target, "utf8"));
      item.mutate(manifest);
      await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const result = await cli(cwd, stateRoot, ["recipe", "validate", "blocked-recipe"], {
      allowFailure: true
    });
    assert.notEqual(result.code, 0, item.name);
    assert.match(result.stderr, item.error, item.name);
  }

  for (const item of [
    {
      name: "symlink",
      setup: (cwd, data) => symlink("/etc/hosts", path.join(data, "leak"))
    },
    {
      name: "hardlink",
      setup: (cwd, data) => link(path.join(cwd, "README.md"), path.join(data, "copy"))
    }
  ]) {
    const cwd = await repository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), `sbw-recipe-${item.name}-`));
    await cli(cwd, stateRoot, ["recipe", "init"]);
    await cli(cwd, stateRoot, ["recipe", "scaffold", "blocked-recipe"]);
    const data = path.join(cwd, "data");
    await mkdir(data);
    await item.setup(cwd, data);
    const target = path.join(
      cwd,
      ".codex",
      "better-workflows",
      "recipes",
      "blocked-recipe",
      "recipe.json"
    );
    const manifest = JSON.parse(await readFile(target, "utf8"));
    manifest.readPaths = ["data"];
    await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = await cli(cwd, stateRoot, ["recipe", "validate", "blocked-recipe"], {
      allowFailure: true
    });
    assert.notEqual(result.code, 0, item.name);
    assert.match(result.stderr, new RegExp(item.name), item.name);
  }
});

test("reference recipe completes governed promotion, dry-run, atomic run, artifact promotion, drift rejection, and untrust", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-recipe-lifecycle-"));
  await cli(cwd, stateRoot, ["recipe", "init"]);
  await cli(cwd, stateRoot, ["recipe", "scaffold", "json-keyset-audit"]);
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "add governed recipe");

  const validation = await cli(cwd, stateRoot, ["recipe", "validate", "json-keyset-audit"]);
  const digest = validation.json.executionDigest;
  const denied = await cli(
    cwd,
    stateRoot,
    [
      "recipe",
      "run",
      "json-keyset-audit",
      "--input-file",
      ".codex/better-workflows/recipes/json-keyset-audit/fixtures/input.json"
    ],
    { allowFailure: true }
  );
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /workspace execution is disabled/);

  const runId = await governedRun(cwd, stateRoot);
  const attemptId = await issueAndConsume(
    cwd,
    stateRoot,
    runId,
    "recipe.promote",
    `recipe:json-keyset-audit:${digest}`
  );
  const stalePromotionState = await mkdtemp(path.join(os.tmpdir(), "sbw-recipe-stale-authority-"));
  await cp(stateRoot, stalePromotionState, { recursive: true });
  const priorPromotionStateRoot = process.env.SBW_STATE_ROOT;
  process.env.SBW_STATE_ROOT = stalePromotionState;
  try {
    await assert.rejects(
      recipePromote(cwd, "json-keyset-audit", {
        run: runId,
        attempt: attemptId,
        confirmDigest: digest,
        async onProviderBoundary(boundary) {
          if (boundary !== "before-authority-replay") return;
          await addFinding(stalePromotionState, runId, {
            id: "late-p1-before-recipe-provider-write",
            severity: "P1",
            status: "open",
            summary: "Late review finding must invalidate the spent action before local writes"
          });
        }
      }),
      /unresolved P0\/P1 finding|non-source action authority changed/
    );
    const unchangedConfig = JSON.parse(
      await readFile(path.join(cwd, ".codex", "better-workflows", "config.json"), "utf8")
    );
    assert.equal(unchangedConfig.enabled, false);
  } finally {
    if (priorPromotionStateRoot === undefined) delete process.env.SBW_STATE_ROOT;
    else process.env.SBW_STATE_ROOT = priorPromotionStateRoot;
  }
  const configRaceState = await mkdtemp(path.join(os.tmpdir(), "sbw-recipe-config-parent-race-"));
  await cp(stateRoot, configRaceState, { recursive: true });
  const workspaceConfigParent = path.join(cwd, ".codex", "better-workflows");
  const displacedConfigParent = path.join(cwd, ".codex", "better-workflows-displaced");
  const configAttackDirectory = path.join(cwd, ".git", "hooks");
  const configAttackTarget = path.join(configAttackDirectory, "config.json");
  const priorConfigRaceStateRoot = process.env.SBW_STATE_ROOT;
  process.env.SBW_STATE_ROOT = configRaceState;
  let configParentSwapped = false;
  try {
    await assert.rejects(access(configAttackTarget));
    await assert.rejects(
      recipePromote(cwd, "json-keyset-audit", {
        run: runId,
        attempt: attemptId,
        confirmDigest: digest,
        async onProviderBoundary(boundary) {
          if (boundary !== "config-before-pinned-write") return;
          await rename(workspaceConfigParent, displacedConfigParent);
          await symlink(configAttackDirectory, workspaceConfigParent);
          configParentSwapped = true;
        }
      }),
      /process cwd is not the immutable destination parent|destination ancestry changed at the write boundary/
    );
    assert.equal(configParentSwapped, true);
    await assert.rejects(access(configAttackTarget));
  } finally {
    if (configParentSwapped) {
      await unlink(workspaceConfigParent);
      await rename(displacedConfigParent, workspaceConfigParent);
    }
    if (priorConfigRaceStateRoot === undefined) delete process.env.SBW_STATE_ROOT;
    else process.env.SBW_STATE_ROOT = priorConfigRaceStateRoot;
  }
  const unchangedRaceConfig = JSON.parse(
    await readFile(path.join(workspaceConfigParent, "config.json"), "utf8")
  );
  assert.equal(unchangedRaceConfig.enabled, false);
  const priorConfigCrashStateRoot = process.env.SBW_STATE_ROOT;
  process.env.SBW_STATE_ROOT = stateRoot;
  let interruptedConfigIntent;
  try {
    await assert.rejects(
      recipePromote(cwd, "json-keyset-audit", {
        run: runId,
        attempt: attemptId,
        confirmDigest: digest,
        async onProviderBoundary(boundary, details) {
          if (boundary !== "config-intent-prepared") return;
          interruptedConfigIntent = details.intent;
          await writeFile(
            path.join(details.parent, details.intent.binding.temporaryName),
            details.artifactBytes,
            { flag: "wx", mode: 0o644 }
          );
          throw new Error("simulated crash after durable recipe config temporary creation");
        }
      }),
      /simulated crash after durable recipe config temporary creation/
    );
  } finally {
    if (priorConfigCrashStateRoot === undefined) delete process.env.SBW_STATE_ROOT;
    else process.env.SBW_STATE_ROOT = priorConfigCrashStateRoot;
  }
  assert.equal(interruptedConfigIntent.status, "prepared");
  const configIntentPath = path.join(
    stateRoot,
    "runs",
    runId,
    "local-provider-intents",
    `${attemptId}.json`
  );
  const persistedConfigIntent = JSON.parse(await readFile(configIntentPath, "utf8"));
  assert.equal(persistedConfigIntent.bindingDigest, interruptedConfigIntent.bindingDigest);
  const interruptedConfigTemporary = path.join(
    workspaceConfigParent,
    persistedConfigIntent.binding.temporaryName
  );
  assert.equal((await lstat(interruptedConfigTemporary)).nlink, 1);
  assert.equal(
    JSON.parse(await readFile(path.join(workspaceConfigParent, "config.json"), "utf8")).enabled,
    false
  );
  const promoted = await cli(cwd, stateRoot, [
    "recipe",
    "promote",
    "json-keyset-audit",
    "--run",
    runId,
    "--attempt",
    attemptId,
    "--confirm-digest",
    digest
  ]);
  assert.equal(promoted.json.trusted, true);
  const publishedConfigIntent = JSON.parse(await readFile(configIntentPath, "utf8"));
  assert.equal(publishedConfigIntent.status, "published");
  assert.match(publishedConfigIntent.targetIdentity, /^\d+:\d+$/);
  await assert.rejects(access(interruptedConfigTemporary));
  const promotedRun = await inspectRun(stateRoot, runId);
  const promotedAction = promotedRun.actions.find((item) => item.attemptId === attemptId);
  assert.equal(promotedAction.outcome, "success");
  assert.equal(promotedAction.sourceBindingTransition.kind, "provider-action");
  assert.equal(promotedAction.sourceBindingTransition.path, ".codex/better-workflows/config.json");
  assert.equal(
    promotedRun.manifest.sourceBinding.digest,
    promotedAction.sourceBindingTransition.to
  );
  assert.equal(
    promotedRun.state.lastSentinel.digest,
    promotedAction.sourceBindingTransition.sourceSentinelTo
  );
  await ledgerTransition(stateRoot, runId, "trust-complete", "complete", "trust", ["digest-confirmation", "promotion-decision"]);
  await ledgerTransition(stateRoot, runId, "artifact-start", "start", "artifact-promotion");
  const config = JSON.parse(
    await readFile(path.join(cwd, ".codex", "better-workflows", "config.json"), "utf8")
  );
  assert.equal(config.enabled, true);

  const input = ".codex/better-workflows/recipes/json-keyset-audit/fixtures/input.json";
  const dryRun = await cli(cwd, stateRoot, [
    "recipe",
    "run",
    "json-keyset-audit",
    "--input-file",
    input,
    "--dry-run"
  ]);
  assert.equal(dryRun.json.dryRun, true);
  assert.equal(dryRun.json.artifactDirectory, null);
  assert.equal(
    (await readdir(path.join(cwd, ".codex", "better-workflows", "artifacts"))).some(
      (name) => name.includes(dryRun.json.receiptId)
    ),
    false
  );

  const executed = await cli(cwd, stateRoot, [
    "recipe",
    "run",
    "json-keyset-audit",
    "--input-file",
    input
  ]);
  assert.equal(executed.json.dryRun, false);
  assert.equal(executed.json.artifacts.length, 2);
  assert.equal(
    await readFile(
      path.join(cwd, executed.json.artifactDirectory, "keyset-report.md"),
      "utf8"
    ).then((value) => value.startsWith("# JSON key-set audit")),
    true
  );
  const privateReceipt = JSON.parse(
    await readFile(
      path.join(
        stateRoot,
        "workspaces",
        validation.json.bindings.workspaceDigest,
        "recipes",
        "json-keyset-audit",
        "receipts",
        `${executed.json.receiptId}.json`
      ),
      "utf8"
    )
  );
  assert.equal(Object.hasOwn(privateReceipt, "summary"), false);
  assert.equal(Object.hasOwn(privateReceipt, "input"), false);
  assert.match(privateReceipt.summaryDigest, /^[a-f0-9]{64}$/);

  const clone = await repository();
  await mkdir(path.join(clone, ".codex"), { recursive: true });
  await cp(
    path.join(cwd, ".codex", "better-workflows"),
    path.join(clone, ".codex", "better-workflows"),
    { recursive: true }
  );
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "clone recipe files");
  const cloneRun = await cli(
    clone,
    stateRoot,
    [
      "recipe",
      "run",
      "json-keyset-audit",
      "--input-file",
      ".codex/better-workflows/recipes/json-keyset-audit/fixtures/input.json"
    ],
    { allowFailure: true }
  );
  assert.notEqual(cloneRun.code, 0);
  assert.match(cloneRun.stderr, /recipe is untrusted/);

  const artifactSentinel = await cli(cwd, stateRoot, ["sentinel", "capture", runId, "--label", "artifact-promotion"]);
  const artifactReview = await reviewStatus(stateRoot, runId);
  const artifactHead = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
  await markBroadReviewComplete(stateRoot, runId, artifactReview.package.packageId, artifactHead, artifactSentinel.json.sentinel.digest);
  const authorityAliasDestination = ".GIT/hooks/better-workflows-artifact-attack";
  await issueAndConsume(
    cwd,
    stateRoot,
    runId,
    "artifact.promote",
    `artifact:${executed.json.receiptId}:report-markdown:${authorityAliasDestination}`
  );
  const authorityAliasAttempt = await cli(cwd, stateRoot, [
    "recipe",
    "artifact",
    "promote",
    executed.json.receiptId,
    "--artifact",
    "report-markdown",
    "--to",
    authorityAliasDestination
  ], { allowFailure: true });
  assert.notEqual(authorityAliasAttempt.code, 0);
  assert.match(authorityAliasAttempt.stderr, /safe tracked repo-relative path outside Git authority/);
  await assert.rejects(access(path.join(cwd, ".git", "hooks", "better-workflows-artifact-attack")));
  const destination = "reports/nested-pinned-parent/keyset-report.md";
  const artifactAttemptId = await issueAndConsume(
    cwd,
    stateRoot,
    runId,
    "artifact.promote",
    `artifact:${executed.json.receiptId}:report-markdown:${destination}`
  );
  const destinationAncestor = path.join(cwd, "reports");
  const destinationParent = path.join(destinationAncestor, "nested-pinned-parent");
  const gitHooks = path.join(cwd, ".git", "hooks");
  const priorStateRoot = process.env.SBW_STATE_ROOT;
  process.env.SBW_STATE_ROOT = stateRoot;
  try {
    const staleArtifactState = await mkdtemp(path.join(os.tmpdir(), "sbw-artifact-stale-authority-"));
    await cp(stateRoot, staleArtifactState, { recursive: true });
    process.env.SBW_STATE_ROOT = staleArtifactState;
    try {
      await assert.rejects(
        recipeArtifactPromote(
          cwd,
          executed.json.receiptId,
          "report-markdown",
          destination,
          {
            async onDestinationBoundary(boundary) {
              if (boundary !== "before-authority-replay") return;
              await addFinding(staleArtifactState, runId, {
                id: "late-p1-before-artifact-provider-write",
                severity: "P1",
                status: "open",
                summary: "Late review finding must invalidate artifact publication authority"
              });
            }
          }
        ),
        /unresolved P0\/P1 finding|non-source action authority changed/
      );
      await assert.rejects(access(path.join(cwd, destination)));
      await assert.rejects(access(destinationAncestor));
    } finally {
      process.env.SBW_STATE_ROOT = stateRoot;
    }
    await mkdir(destinationAncestor, { mode: 0o755 });
    const displacedAncestor = path.join(cwd, "reports-parent-create-displaced");
    let ancestorSwapped = false;
    try {
      await assert.rejects(
        recipeArtifactPromote(
          cwd,
          executed.json.receiptId,
          "report-markdown",
          destination,
          {
            async onDestinationBoundary(boundary, details) {
              if (boundary !== "before-parent-create" || details.component !== "nested-pinned-parent") return;
              await rename(destinationAncestor, displacedAncestor);
              await symlink(gitHooks, destinationAncestor);
              ancestorSwapped = true;
            }
          }
        ),
        /process cwd is not the immutable destination parent|destination ancestry changed at the write boundary/
      );
      assert.equal(ancestorSwapped, true);
      await assert.rejects(access(path.join(gitHooks, "nested-pinned-parent")));
    } finally {
      if (ancestorSwapped) {
        await unlink(destinationAncestor);
        await rename(displacedAncestor, destinationAncestor);
      }
    }
    for (const boundary of ["before-copy", "before-link", "after-parent-check"]) {
      const displacedParent = path.join(cwd, `reports-${boundary}`);
      let swapped = false;
      try {
        await assert.rejects(
          recipeArtifactPromote(
            cwd,
            executed.json.receiptId,
            "report-markdown",
            destination,
            {
              async onDestinationBoundary(current) {
                if (current !== boundary) return;
                await rename(destinationParent, displacedParent);
                await symlink(gitHooks, destinationParent);
                swapped = true;
              }
            }
          ),
          /unsafe artifact destination parent|destination ancestry changed at the write boundary|process cwd is not the immutable destination parent/
        );
        assert.equal(swapped, true);
        await assert.rejects(access(path.join(gitHooks, path.basename(destination))));
      } finally {
        if (swapped) {
          await unlink(destinationParent);
          await rename(displacedParent, destinationParent);
          for (const name of await readdir(destinationParent)) {
            if (name.endsWith(".tmp")) await unlink(path.join(destinationParent, name));
          }
        }
      }
    }
  } finally {
    if (priorStateRoot === undefined) delete process.env.SBW_STATE_ROOT;
    else process.env.SBW_STATE_ROOT = priorStateRoot;
  }
  const priorCrashStateRoot = process.env.SBW_STATE_ROOT;
  process.env.SBW_STATE_ROOT = stateRoot;
  try {
    await assert.rejects(
      recipeArtifactPromote(
        cwd,
        executed.json.receiptId,
        "report-markdown",
        destination,
        {
          async onDestinationBoundary(boundary) {
            if (boundary === "after-artifact-link") {
              throw new Error("simulated crash after durable artifact link");
            }
          }
        }
      ),
      /simulated crash after durable artifact link/
    );
  } finally {
    if (priorCrashStateRoot === undefined) delete process.env.SBW_STATE_ROOT;
    else process.env.SBW_STATE_ROOT = priorCrashStateRoot;
  }
  const intentPath = path.join(
    stateRoot,
    "runs",
    runId,
    "local-provider-intents",
    `${artifactAttemptId}.json`
  );
  const interruptedIntent = JSON.parse(await readFile(intentPath, "utf8"));
  assert.equal(interruptedIntent.status, "prepared");
  const interruptedTarget = await lstat(path.join(cwd, destination));
  const interruptedTemporaryPath = path.join(destinationParent, interruptedIntent.binding.temporaryName);
  const interruptedTemporary = await lstat(interruptedTemporaryPath);
  assert.equal(interruptedTarget.ino, interruptedTemporary.ino);
  assert.equal(interruptedTarget.nlink, 2);
  assert.equal(interruptedTemporary.nlink, 2);
  const artifactPromotion = await cli(cwd, stateRoot, [
    "recipe",
    "artifact",
    "promote",
    executed.json.receiptId,
    "--artifact",
    "report-markdown",
    "--to",
    destination
  ]);
  assert.equal(artifactPromotion.json.destination, destination);
  const publishedIntent = JSON.parse(await readFile(intentPath, "utf8"));
  assert.equal(publishedIntent.status, "published");
  assert.equal((await lstat(path.join(cwd, destination))).nlink, 1);
  await assert.rejects(access(interruptedTemporaryPath));
  const artifactRun = await inspectRun(stateRoot, runId);
  const artifactAction = artifactRun.actions.find((item) => item.attemptId === artifactAttemptId);
  assert.equal(artifactAction.outcome, "success");
  assert.equal(artifactAction.sourceBindingTransition.kind, "provider-action");
  assert.equal(artifactAction.sourceBindingTransition.path, destination);
  assert.equal(artifactRun.manifest.sourceBinding.digest, artifactAction.sourceBindingTransition.to);
  assert.equal(
    artifactRun.manifest.sourceBindingHistory.filter((item) => item.kind === "provider-action").length,
    2
  );
  const tamperState = await mkdtemp(path.join(os.tmpdir(), "sbw-recipe-transition-tamper-"));
  await cp(stateRoot, tamperState, { recursive: true });
  const tamperManifestPath = path.join(tamperState, "runs", runId, "manifest.json");
  const tamperManifest = JSON.parse(await readFile(tamperManifestPath, "utf8"));
  tamperManifest.sourceBindingHistory.at(-1).sourceMutationDigest = "0".repeat(64);
  await writeFile(tamperManifestPath, `${JSON.stringify(tamperManifest)}\n`);
  const tamperedRun = await inspectRun(tamperState, runId);
  await assert.rejects(
    currentActionEvidenceGateBinding(
      tamperState,
      runId,
      tamperedRun,
      "artifact.promote"
    ),
    /provider action source transition is not replay-valid/
  );
  await ledgerTransition(stateRoot, runId, "artifact-complete", "complete", "artifact-promotion", ["artifact-receipt"]);
  assert.match(await readFile(path.join(cwd, destination), "utf8"), /JSON key-set audit/);

  const status = await cli(cwd, stateRoot, ["recipe", "status", "json-keyset-audit"]);
  assert.equal(status.json.trusted, true);
  assert.equal(status.json.receiptCount, 2);

  const entry = path.join(
    cwd,
    ".codex",
    "better-workflows",
    "recipes",
    "json-keyset-audit",
    "run.mjs"
  );
  await appendFile(entry, "\n// digest drift\n");
  const drifted = await cli(
    cwd,
    stateRoot,
    ["recipe", "run", "json-keyset-audit", "--input-file", input],
    { allowFailure: true }
  );
  assert.notEqual(drifted.code, 0);
  assert.match(drifted.stderr, /trust is stale/);

  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "drift recipe without version bump");
  await cli(cwd, stateRoot, ["sentinel", "capture", runId, "--label", "drift-repromotion"]);
  const driftValidation = await cli(cwd, stateRoot, ["recipe", "validate", "json-keyset-audit"]);
  const driftAction = await cli(cwd, stateRoot, [
    "action",
    "issue",
    runId,
    "--action",
    "recipe.promote",
    "--provider",
    "local-workspace",
    "--resource",
    `recipe:json-keyset-audit:${driftValidation.json.executionDigest}`,
    "--remote-revision",
    "local"
  ], { allowFailure: true });
  assert.notEqual(driftAction.code, 0);
  assert.match(driftAction.stderr, /scoped and final broad review are closed/);

  await cli(cwd, stateRoot, ["recipe", "untrust", "json-keyset-audit"]);
  const untrusted = await cli(cwd, stateRoot, ["recipe", "status", "json-keyset-audit"]);
  assert.equal(untrusted.json.trusted, false);
});

test("recipe promotion source transition rejects one undeclared extra path", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-recipe-source-transition-attack-"));
  await cli(cwd, stateRoot, ["recipe", "init"]);
  await cli(cwd, stateRoot, ["recipe", "scaffold", "json-keyset-audit"]);
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "add governed recipe");
  const validation = await cli(cwd, stateRoot, ["recipe", "validate", "json-keyset-audit"]);
  const runId = await governedRun(cwd, stateRoot);
  const attemptId = await issueAndConsume(
    cwd,
    stateRoot,
    runId,
    "recipe.promote",
    `recipe:json-keyset-audit:${validation.json.executionDigest}`
  );
  const run = await inspectRun(stateRoot, runId);
  const action = run.actions.find((item) => item.attemptId === attemptId);
  const configPath = path.join(cwd, ".codex", "better-workflows", "config.json");
  const beforeConfig = JSON.parse(await readFile(configPath, "utf8"));
  const afterConfig = { ...beforeConfig, enabled: true };
  await writeFile(configPath, `${JSON.stringify(afterConfig, null, 2)}\n`);
  await writeFile(path.join(cwd, "undeclared-provider-write.txt"), "must be rejected\n");
  const baselineSentinel = JSON.parse(await readFile(
    path.join(
      stateRoot,
      "runs",
      runId,
      "sentinels",
      `${action.sourceAuthorityAtIssue.sourceSentinel.label}.json`
    ),
    "utf8"
  ));
  const afterSentinel = await captureSentinel(cwd, run.contract, await loadDefaults());
  const afterSourceBinding = await captureSourceBinding(cwd, {
    baseRevision: action.sourceAuthorityAtIssue.sourceBinding.baseRevision,
    requireClean: false
  });
  const sourceMutation = {
    schemaVersion: 1,
    kind: "provider-action",
    actionAttemptId: action.attemptId,
    action: action.action,
    provider: action.provider,
    resource: action.resource,
    path: ".codex/better-workflows/config.json",
    sourceBinding: {
      from: action.sourceAuthorityAtIssue.sourceBinding.digest,
      to: afterSourceBinding.digest,
      headRevision: afterSourceBinding.headRevision
    },
    sentinel: { from: baselineSentinel.digest, to: afterSentinel.digest },
    pathTransition: {
      before: testSentinelPathBinding(baselineSentinel, ".codex/better-workflows/config.json"),
      after: testSentinelPathBinding(afterSentinel, ".codex/better-workflows/config.json")
    },
    recipeConfig: { before: beforeConfig, after: afterConfig }
  };
  const request = {
    action: action.action,
    provider: action.provider,
    resource: action.resource,
    remoteRevision: action.remoteRevision,
    idempotencyKey: action.idempotencyKey
  };
  const providerReceipt = {
    ...request,
    outcome: "success",
    runId,
    attemptId,
    executionId: `local-workspace:recipe.promote:${attemptId}`,
    proofKind: "local-workspace:recipe.promote",
    requestDigest: digestObject(request),
    responseDigest: digestObject({
      kind: "workspace-recipe",
      digest: "c".repeat(64),
      sourceMutationDigest: digestObject(sourceMutation)
    }),
    verifiedAt: action.spentAt,
    terminalState: "success",
    kind: "workspace-recipe",
    digest: "c".repeat(64),
    sourceMutation
  };
  const payload = {
    provider: action.provider,
    actionProof: {
      schemaVersion: 1,
      runId,
      actionAttemptId: attemptId,
      action: action.action,
      provider: action.provider,
      resource: action.resource,
      outcome: "success",
      idempotencyKey: action.idempotencyKey,
      remoteRevision: action.remoteRevision,
      providerExecutionId: providerReceipt.executionId,
      providerReceiptDigest: digestObject(providerReceipt)
    },
    receipt: providerReceipt
  };
  const providerEvidence = await addCoreEvidence(stateRoot, runId, {
    schemaVersion: 2,
    id: `action-proof-${attemptId}`,
    kind: "provider-reconciliation",
    status: "complete",
    summary: "Provider receipt for attacked recipe promotion",
    acceptanceIds: [],
    dependencyInputs: { files: [] },
    sourceDigest: digestObject(payload),
    receipt: {
      contractId: "evidence-contracts-v1:provider-reconciliation",
      contractVersion: 1,
      runId,
      producer: { provider: "codex-root" },
      inputBinding: {
        runId,
        contractDigest: digestObject(run.contract),
        remoteRevision: run.contract.remoteRevision ?? null
      },
      payload,
      payloadDigest: digestObject(payload),
      producedAt: action.spentAt
    }
  });
  await assert.rejects(
    reconcileAction(stateRoot, runId, attemptId, "success", {
      ...request,
      outcome: "success",
      runId,
      attemptId,
      providerReceipt,
      evidenceIds: [providerEvidence.id]
    }),
    (error) => error?.code === "SBW_ACTION_AUTHORITY_INDETERMINATE"
  );
  const persisted = (await inspectRun(stateRoot, runId)).actions.find((item) => item.attemptId === attemptId);
  assert.equal(persisted.outcome, "unknown");
  assert.equal(persisted.receipt, null);
});

test("candidate runner rejects source writes, undeclared reads, timeouts, and oversized output", async () => {
  const cases = [
    {
      name: "source-write",
      source: `import { writeFile } from "node:fs/promises";
import path from "node:path";
export default async function run(context) {
  await writeFile(path.join(context.workspacePath, "forbidden.txt"), "no");
  return { summary: "bad", evidenceCandidates: [], artifacts: [], proposals: [] };
}
`,
      error: /execution failed|restricted|permission/i,
      absent: "forbidden.txt"
    },
    {
      name: "undeclared-read",
      source: `import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export default async function run(context) {
  const value = await readFile("/etc/hosts", "utf8");
  await writeFile(path.join(context.artifactStagingPath, "report.json"), JSON.stringify({ value }));
  return { summary: "bad", evidenceCandidates: [], artifacts: [{ id: "report" }], proposals: [] };
}
`,
      error: /execution failed|restricted|permission/i
    },
    {
      name: "timeout",
      source: `export default async function run() {
  await new Promise(() => {});
  return { summary: "never", evidenceCandidates: [], artifacts: [], proposals: [] };
}
`,
      manifest(manifest) {
        manifest.timeoutSeconds = 1;
      },
      error: /timed out/
    },
    {
      name: "oversized-output",
      source: `export default async function run(context) {
  context.stderr("x".repeat(4096));
  return { summary: "bad", evidenceCandidates: [], artifacts: [], proposals: [] };
}
`,
      manifest(manifest) {
        manifest.maxStdoutBytes = 1024;
      },
      error: /exceeded maxStdoutBytes/
    }
  ];
  for (const item of cases) {
    const cwd = await repository();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), `sbw-recipe-runtime-${item.name}-`));
    await cli(cwd, stateRoot, ["recipe", "init"]);
    await cli(cwd, stateRoot, ["recipe", "scaffold", "blocked-recipe"]);
    const directory = path.join(cwd, ".codex", "better-workflows", "recipes", "blocked-recipe");
    await writeFile(path.join(directory, "run.mjs"), item.source);
    if (item.manifest) {
      const target = path.join(directory, "recipe.json");
      const manifest = JSON.parse(await readFile(target, "utf8"));
      item.manifest(manifest);
      await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-qm", `add ${item.name} candidate`);
    const validation = await cli(cwd, stateRoot, ["recipe", "validate", "blocked-recipe"]);
    const runId = await governedRun(cwd, stateRoot);
    const attemptId = await issueAndConsume(
      cwd,
      stateRoot,
      runId,
      "recipe.promote",
      `recipe:blocked-recipe:${validation.json.executionDigest}`
    );
    const result = await cli(
      cwd,
      stateRoot,
      [
        "recipe",
        "promote",
        "blocked-recipe",
        "--run",
        runId,
        "--attempt",
        attemptId,
        "--confirm-digest",
        validation.json.executionDigest
      ],
      { allowFailure: true }
    );
    assert.notEqual(result.code, 0, item.name);
    assert.match(result.stderr, item.error, item.name);
    if (item.absent) await assert.rejects(access(path.join(cwd, item.absent)));
  }
});
