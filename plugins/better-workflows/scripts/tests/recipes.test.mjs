import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  access,
  appendFile,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { digestObject, pluginRoot, sha256 } from "../lib/core.mjs";
import { transitionLedger } from "../lib/ledger.mjs";
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
  const destination = "reports/keyset-report.md";
  await issueAndConsume(
    cwd,
    stateRoot,
    runId,
    "artifact.promote",
    `artifact:${executed.json.receiptId}:report-markdown:${destination}`
  );
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
