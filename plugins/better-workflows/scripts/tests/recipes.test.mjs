import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

const execFileAsync = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sbw.mjs");

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

async function addEvidence(cwd, stateRoot, runId, kind, acceptanceIds) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-recipe-evidence-"));
  const target = path.join(directory, `${kind}.json`);
  await writeFile(
    target,
    `${JSON.stringify({
      id: `evidence-${kind}`,
      kind,
      summary: `${kind} complete`,
      status: "complete",
      acceptanceIds,
      sourceDigest: "a".repeat(64),
      dependencyInputs: { files: [] }
    })}\n`
  );
  return cli(cwd, stateRoot, ["evidence", "add", runId, "--file", target]);
}

async function governedRun(cwd, stateRoot) {
  const started = await cli(cwd, stateRoot, [
    "run",
    "--template",
    "workspace-recipe",
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

  await cli(cwd, stateRoot, ["sentinel", "capture", runId, "--label", "artifact-promotion"]);
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
  const driftAttempt = await issueAndConsume(
    cwd,
    stateRoot,
    runId,
    "recipe.promote",
    `recipe:json-keyset-audit:${driftValidation.json.executionDigest}`
  );
  const refusedRepromotion = await cli(
    cwd,
    stateRoot,
    [
      "recipe",
      "promote",
      "json-keyset-audit",
      "--run",
      runId,
      "--attempt",
      driftAttempt,
      "--confirm-digest",
      driftValidation.json.executionDigest
    ],
    { allowFailure: true }
  );
  assert.notEqual(refusedRepromotion.code, 0);
  assert.match(refusedRepromotion.stderr, /requires a version bump/);

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
