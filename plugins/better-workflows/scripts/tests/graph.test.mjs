import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestObject, pluginRoot } from "../lib/core.mjs";
import {
  buildRunGraph,
  buildTemplateGraph,
  graphEdgeId,
  graphHasErrors,
  graphNodeId,
  renderGraphMermaid,
  validateGraph
} from "../lib/graph.mjs";
import { transitionLedger } from "../lib/ledger.mjs";
import { createReviewPackage, markBroadReviewComplete } from "../lib/review.mjs";

const execFileAsync = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sbw.mjs");
const DIGEST = "a".repeat(64);

function template(overrides = {}) {
  return {
    name: "graph-fixture",
    description: "Graph fixture",
    defaultMode: "verified",
    requiredEvidence: ["proof"],
    acceptance: [
      {
        id: "accepted",
        description: "Accepted",
        critical: true
      }
    ],
    policyGates: ["fail-closed"],
    actionGates: {
      "external.write": ["proof"]
    },
    domainSkills: [],
    rootOnlyActions: ["external write"],
    ...overrides
  };
}

function runFixture(overrides = {}) {
  const definition = overrides.template ?? template();
  const contract = {
    schemaVersion: 1,
    template: definition.name,
    templateDigest: digestObject(definition),
    goal: "Validate graph",
    scope: ["."],
    risk: {},
    sensitivity: "public",
    authority: { externalSideEffects: ["external.write"] },
    acceptance: structuredClone(definition.acceptance),
    requiredEvidence: [...definition.requiredEvidence],
    actionGates: structuredClone(definition.actionGates),
    agy: { allowed: false, sanitized: false, required: false },
    volatileExclusions: [],
    highRiskIgnored: [],
    remoteRevision: null,
    ...overrides.contract
  };
  const manifest = {
    schemaVersion: 1,
    runId: "sbw-20260727T100000Z-aaaaaaaaaaaa",
    version: "2.2.0",
    template: definition.name,
    mode: "verified",
    requestedMode: "verified",
    cwd: "/private/redacted",
    baselineRevision: "baseline",
    createdAt: "2026-07-27T10:00:00.000Z",
    contractDigest: digestObject(contract),
    authority: { rootOnlyMutation: true },
    ...overrides.manifest
  };
  const state = {
    schemaVersion: 1,
    runId: manifest.runId,
    status: "running",
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-27T10:00:01.000Z",
    lastSentinel: { label: "current", digest: DIGEST },
    lastSentinelVerified: true,
    lastSentinelComplete: true,
    sideEffects: [],
    ...overrides.state
  };
  return {
    template: definition,
    contract,
    manifest,
    state,
    evidence: overrides.evidence ?? [],
    findings: overrides.findings ?? [],
    actions: overrides.actions ?? []
  };
}

function source(pointer = "#") {
  return {
    path: "fixture.json",
    pointer,
    digest: DIGEST
  };
}

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function repository() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sbw-graph-repo-"));
  await git(cwd, "init", "-q", "-b", "dev");
  await git(cwd, "config", "user.name", "Graph View Tests");
  await git(cwd, "config", "user.email", "graph@example.invalid");
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "value.txt"), "one\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

async function cli(
  cwd,
  stateRoot,
  args,
  { allowFailure = false, executable = CLI } = {}
) {
  try {
    const result = await execFileAsync(process.execPath, [executable, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, SBW_STATE_ROOT: stateRoot },
      maxBuffer: 16 * 1024 * 1024
    });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      json: JSON.parse(result.stdout)
    };
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

async function copiedPlugin() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sbw-graph-plugin-"));
  const target = path.join(parent, "better-workflows");
  await cp(pluginRoot(), target, { recursive: true });
  return {
    root: target,
    cli: path.join(target, "scripts", "sbw.mjs")
  };
}

test("template graphs are canonical, byte-stable, and presentation-free", () => {
  const input = {
    template: template(),
    sourcePath: "templates/graph-fixture.json"
  };
  const first = buildTemplateGraph(input);
  const second = buildTemplateGraph(structuredClone(input));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.graphDigest, second.graphDigest);
  assert.equal(graphHasErrors(first), false);
  assert.equal("content" in first, false);
  assert.doesNotMatch(JSON.stringify(first), /2026-07-27|\/Users\//);
});

test("equivalent object key order and fresh processes produce identical graphs", async () => {
  const original = template();
  const reordered = Object.fromEntries(
    Object.entries(original).reverse().map(([key, value]) => [
      key,
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value
    ])
  );
  const first = buildTemplateGraph({
    template: original,
    sourcePath: "templates/graph-fixture.json"
  });
  const second = buildTemplateGraph({
    template: reordered,
    sourcePath: "templates/graph-fixture.json"
  });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(renderGraphMermaid(first), renderGraphMermaid(second));

  const script = [
    `import { buildTemplateGraph, renderGraphMermaid } from ${JSON.stringify(new URL("../lib/graph.mjs", import.meta.url).href)};`,
    `const template = ${JSON.stringify(original)};`,
    "const graph = buildTemplateGraph({ template, sourcePath: 'templates/graph-fixture.json' });",
    "process.stdout.write(JSON.stringify({ graph, mermaid: renderGraphMermaid(graph) }));"
  ].join("\n");
  const runs = await Promise.all([
    execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8"
    }),
    execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8"
    })
  ]);
  assert.equal(runs[0].stdout, runs[1].stdout);
  assert.equal(runs[0].stdout, JSON.stringify({ graph: first, mermaid: renderGraphMermaid(first) }));
});

test("graph validation detects collisions, bad endpoints, and hard cycles", () => {
  const first = graphNodeId("evidence-kind", "a");
  const second = graphNodeId("evidence-kind", "b");
  const graph = {
    schemaVersion: 1,
    subject: { kind: "template", id: "fixture", sourceDigest: DIGEST },
    nodes: [
      { id: first, kind: "evidence-kind", stableId: "a", label: "a", source: source() },
      { id: first, kind: "evidence-kind", stableId: "a", label: "a", source: source() },
      { id: second, kind: "evidence-kind", stableId: "b", label: "b", source: source() }
    ],
    edges: [
      {
        id: graphEdgeId("requires", first, second),
        kind: "requires",
        from: first,
        to: second,
        source: source()
      },
      {
        id: graphEdgeId("requires", second, first),
        kind: "requires",
        from: second,
        to: first,
        source: source()
      },
      {
        id: "requires:duplicate",
        kind: "requires",
        from: first,
        to: "missing",
        source: source()
      },
      {
        id: "requires:duplicate",
        kind: "requires",
        from: first,
        to: "missing",
        source: source()
      }
    ]
  };
  const codes = new Set(validateGraph(graph).map((item) => item.code));
  assert.ok(codes.has("duplicate-node"));
  assert.ok(codes.has("duplicate-edge"));
  assert.ok(codes.has("dangling-edge"));
  assert.ok(codes.has("hard-dependency-cycle"));

  const incompatible = structuredClone(graph);
  incompatible.nodes = [
    {
      id: graphNodeId("run", "run"),
      kind: "run",
      stableId: "run",
      label: "run",
      source: source()
    },
    {
      id: graphNodeId("finding", "finding"),
      kind: "finding",
      stableId: "finding",
      label: "finding",
      source: source()
    }
  ];
  incompatible.edges = [
    {
      id: "satisfies:bad",
      kind: "satisfies",
      from: incompatible.nodes[0].id,
      to: incompatible.nodes[1].id,
      source: source()
    }
  ];
  assert.ok(
    validateGraph(incompatible).some((item) => item.code === "incompatible-endpoint")
  );

  incompatible.nodes[0].source.path = "/absolute/secret";
  assert.ok(
    validateGraph(incompatible).some((item) => item.code === "unsafe-provenance")
  );
});

test("template and run builders detect cross-record structural faults", () => {
  const invalidTemplate = template({
    actionGates: { "external.write": ["missing-proof"] }
  });
  const templateGraph = buildTemplateGraph({
    template: invalidTemplate,
    sourcePath: "templates/graph-fixture.json"
  });
  assert.ok(
    templateGraph.diagnostics.some(
      (item) => item.code === "action-prerequisite-undeclared"
    )
  );

  const fixture = runFixture({
    contract: {
      templateDigest: DIGEST,
      actionGates: { "external.write": ["other-proof"] },
      requiredEvidence: []
    },
    evidence: [
      {
        id: "evidence-1",
        kind: "proof",
        summary: "must never appear",
        status: "complete",
        stale: false,
        acceptanceIds: ["unknown"],
        sourceDigest: DIGEST,
        dependencies: { files: [] }
      }
    ],
    actions: [
      {
        action: "external.write",
        status: "spent",
        outcome: "success",
        attemptId: "attempt-1",
        tokenHash: "must-never-appear",
        receipt: "must-never-appear"
      }
    ]
  });
  fixture.contract.authority.externalSideEffects = [];
  fixture.manifest.contractDigest = digestObject(fixture.contract);
  const runGraph = buildRunGraph(fixture);
  const codes = new Set(runGraph.diagnostics.map((item) => item.code));
  assert.ok(codes.has("template-digest-drift"));
  assert.ok(codes.has("action-gate-drift"));
  assert.ok(codes.has("template-minimum-drift"));
  assert.ok(codes.has("unknown-acceptance-reference"));
  assert.ok(codes.has("unauthorized-action-path"));

  const provenanceFixture = runFixture({
    evidence: [
      {
        id: "unsafe-source",
        kind: "proof",
        summary: "unsafe",
        status: "complete",
        stale: false,
        acceptanceIds: ["accepted"],
        sourceDigest: "short",
        dependencies: {
          files: [{ path: "/absolute/secret", type: "file", digest: DIGEST }]
        }
      }
    ],
    actions: [
      {
        action: "unknown.action",
        status: "spent",
        outcome: "success",
        attemptId: "unknown-attempt"
      }
    ]
  });
  provenanceFixture.manifest.contractDigest = DIGEST;
  const provenanceGraph = buildRunGraph(provenanceFixture);
  const provenanceCodes = new Set(
    provenanceGraph.diagnostics.map((item) => item.code)
  );
  assert.ok(provenanceCodes.has("contract-digest-drift"));
  assert.ok(provenanceCodes.has("missing-source-binding"));
  assert.ok(provenanceCodes.has("unsafe-source-binding"));
  assert.ok(provenanceCodes.has("unknown-action-kind"));
});

test("pre-repair fixtures reproduce all ten action prerequisite gaps", async () => {
  const fixtures = [
    {
      name: "dependabot-consolidation-pr-cleanup",
      gaps: ["eligibility-classified", "remote-authorization", "current-branch"]
    },
    {
      name: "monorepo-refactor",
      gaps: [
        "slice-validation",
        "diff-review",
        "rollback-plan",
        "remote-authorization",
        "current-branch"
      ]
    },
    {
      name: "pr-to-dev",
      gaps: ["remote-authorization", "current-branch"]
    }
  ];
  let detected = 0;
  for (const fixture of fixtures) {
    const definition = JSON.parse(
      await readFile(
        path.join(pluginRoot(), "templates", `${fixture.name}.json`),
        "utf8"
      )
    );
    definition.requiredEvidence = definition.requiredEvidence.filter(
      (kind) => !fixture.gaps.includes(kind)
    );
    const graph = buildTemplateGraph({
      template: definition,
      sourcePath: `templates/${fixture.name}.json`
    });
    detected += graph.diagnostics.filter(
      (item) => item.code === "action-prerequisite-undeclared"
    ).length;
  }
  assert.equal(detected, 10);
});

test("every installed template has zero hard Graph View diagnostics", async () => {
  const templates = (await readdir(path.join(pluginRoot(), "templates")))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.equal(templates.length, 13);
  for (const name of templates) {
    const definition = JSON.parse(
      await readFile(path.join(pluginRoot(), "templates", name), "utf8")
    );
    const graph = buildTemplateGraph({
      template: definition,
      sourcePath: `templates/${name}`
    });
    assert.equal(graphHasErrors(graph), false, `${name}: ${JSON.stringify(graph.diagnostics)}`);
  }
});

test("run graphs redact raw records and keep warnings non-blocking", () => {
  const sensitiveFixture = "TOPSECRET-graph-987";
  const encodedSecrets = [
    sensitiveFixture,
    Buffer.from(sensitiveFixture).toString("base64"),
    Buffer.from(sensitiveFixture).toString("hex")
  ];
  const fixture = runFixture({
    evidence: [
      {
        id: "optional-1",
        kind: "optional-observation",
        summary: sensitiveFixture,
        status: "complete",
        stale: true,
        acceptanceIds: [],
        sourceDigest: DIGEST,
        dependencies: {
          files: [{ path: "src/value.txt", type: "file", digest: DIGEST }]
        },
        rawInput: { nested: [{ value: sensitiveFixture }] },
        conversation: { messages: [{ content: sensitiveFixture }] },
        credentials: { ["pass" + "word"]: sensitiveFixture },
        tokenHash: sensitiveFixture,
        providerReceipt: { body: sensitiveFixture }
      }
    ],
    findings: [
      {
        id: "finding-1",
        severity: "P2",
        status: "open",
        summary: sensitiveFixture,
        evidence: { nested: sensitiveFixture }
      }
    ],
    actions: [
      {
        action: "external.write",
        status: "spent",
        outcome: "success",
        attemptId: "attempt-privacy",
        tokenHash: sensitiveFixture,
        resource: sensitiveFixture,
        receipt: { nested: sensitiveFixture }
      }
    ]
  });
  const graph = buildRunGraph(fixture);
  const serialized = JSON.stringify(graph);
  const mermaid = renderGraphMermaid(graph);
  assert.equal(graphHasErrors(graph), false);
  assert.ok(graph.diagnostics.some((item) => item.code === "stale-evidence"));
  assert.ok(graph.diagnostics.some((item) => item.code === "optional-orphan-record"));
  for (const forbidden of encodedSecrets) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
    assert.equal(mermaid.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(serialized, /\/private\/redacted|tokenHash|providerReceipt/);

  const secretOnlyChange = structuredClone(fixture);
  secretOnlyChange.manifest.cwd = "/another/private/location";
  secretOnlyChange.manifest.createdAt = "2030-01-01T00:00:00.000Z";
  secretOnlyChange.contract.goal = "DIFFERENT-SECRET-GOAL";
  secretOnlyChange.contract.scope = ["private/DIFFERENT-SECRET-SCOPE"];
  secretOnlyChange.contract.sensitivity = "confidential";
  secretOnlyChange.manifest.contractDigest = digestObject(secretOnlyChange.contract);
  secretOnlyChange.state.updatedAt = "2030-01-01T00:00:01.000Z";
  secretOnlyChange.state.lastSentinel.digest = "b".repeat(64);
  secretOnlyChange.evidence[0].summary = "DIFFERENT-SECRET-SUMMARY";
  secretOnlyChange.evidence[0].rawInput = { nested: "DIFFERENT-SECRET-INPUT" };
  secretOnlyChange.evidence[0].conversation = "DIFFERENT-SECRET-CONVERSATION";
  secretOnlyChange.evidence[0].credentials = { ["pass" + "word"]: "DIFFERENT-SECRET-PASSWORD" };
  secretOnlyChange.evidence[0].tokenHash = "DIFFERENT-SECRET-TOKEN";
  secretOnlyChange.evidence[0].providerReceipt = "DIFFERENT-SECRET-RECEIPT";
  secretOnlyChange.evidence[0].sourceDigest = "b".repeat(64);
  secretOnlyChange.evidence[0].dependencies.files[0].digest = "b".repeat(64);
  secretOnlyChange.findings[0].summary = "DIFFERENT-SECRET-FINDING";
  secretOnlyChange.findings[0].evidence = "DIFFERENT-SECRET-FINDING-EVIDENCE";
  secretOnlyChange.actions[0].tokenHash = "DIFFERENT-SECRET-ACTION-TOKEN";
  secretOnlyChange.actions[0].resource = "DIFFERENT-SECRET-RESOURCE";
  secretOnlyChange.actions[0].receipt = "DIFFERENT-SECRET-ACTION-RECEIPT";
  const changedGraph = buildRunGraph(secretOnlyChange);
  assert.equal(JSON.stringify(graph), JSON.stringify(changedGraph));
  assert.equal(mermaid, renderGraphMermaid(changedGraph));
});

test("v2 run Graph View is a task/dependency/state projection", () => {
  const privateField = "priv" + "ate";
  const v2Template = template({
    controlPlane: {
      evidencePolicy: "typed-v1",
      ledgerPolicy: "ledger-v1",
      reviewPolicy: "none",
      designPacketPolicy: "none",
      refinementPolicy: "none",
      deliberationPolicy: "none"
    },
    executionStages: [{
      id: "proof-stage",
      goal: "proof-stage",
      dependsOn: [],
      requiredEvidence: ["proof"],
      attemptBudget: 3,
      kind: "regular"
    }]
  });
  const fixture = runFixture({
    template: v2Template,
    contract: {
      schemaVersion: 2,
      controlPlane: v2Template.controlPlane,
      executionStages: v2Template.executionStages,
      acceptanceEvidence: { accepted: ["proof"] }
    },
    evidence: [{
      id: "private-receipt",
      kind: "proof",
      summary: "must not be projected",
      status: "complete",
      stale: false,
      acceptanceIds: [],
      sourceDigest: DIGEST,
      receipt: { payload: { [privateField]: "must-never-appear" } }
    }],
    findings: [{ id: "finding-private", severity: "P1", status: "open" }],
    actions: [{ action: "external.write", status: "spent", outcome: "success", attemptId: "attempt-private" }]
  });
  fixture.ledger = {
      tasks: [{ id: "proof-stage", dependencies: [], requiredEvidence: ["proof"] }],
      taskStates: [{ id: "proof-stage", state: "pending" }]
  };
  const graph = buildRunGraph(fixture);
  const kinds = new Set(graph.nodes.map((node) => node.kind));
  assert.equal(kinds.has("task"), true);
  assert.equal(kinds.has("run-state"), true);
  assert.equal(kinds.has("evidence-record"), false);
  assert.equal(kinds.has("finding"), false);
  assert.equal(kinds.has("action-attempt"), false);
  assert.equal(JSON.stringify(graph).includes("must-never-appear"), false);
  const changed = structuredClone(fixture);
  changed.evidence[0].receipt.payload[privateField] = "different-private-receipt";
  changed.findings[0].status = "resolved";
  changed.actions[0].outcome = "failure";
  assert.equal(JSON.stringify(graph), JSON.stringify(buildRunGraph(changed)));
});

test("Mermaid rendering uses generated identifiers and escapes directive injection", () => {
  const graph = buildTemplateGraph({
    template: template({
      acceptance: [
        {
          id: "bad\"]\n%%{init: {'theme':'dark'}}%%",
          description: "malicious",
          critical: true
        }
      ]
    }),
    sourcePath: "templates/graph-fixture.json"
  });
  const content = renderGraphMermaid(graph);
  assert.match(content, /^flowchart LR\n/);
  assert.doesNotMatch(content, /\n%%/);
  assert.doesNotMatch(content, /bad"\]/);
  assert.match(content, /n0\["/);
});

test("graph CLI exposes deterministic validate and inspect shapes", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-graph-state-"));
  const all = await cli(cwd, stateRoot, ["graph", "validate"]);
  assert.equal(all.json.ok, true);
  assert.equal(all.json.subject.id, "installed-templates");
  assert.equal(all.json.diagnostics.length, 0);

  const selected = await cli(cwd, stateRoot, [
    "graph",
    "validate",
    "--template",
    "review-to-issues"
  ]);
  assert.equal(selected.json.subject.id, "review-to-issues");
  assert.equal(selected.json.format, "json");

  const mermaid = await cli(cwd, stateRoot, [
    "graph",
    "inspect",
    "--template",
    "review-to-issues",
    "--format",
    "mermaid"
  ]);
  assert.equal(mermaid.json.ok, true);
  assert.equal(mermaid.json.format, "mermaid");
  assert.match(mermaid.json.content, /^flowchart LR/);
  assert.ok(Array.isArray(mermaid.json.nodes));

  const started = await cli(cwd, stateRoot, [
    "run",
    "--template",
    "review-to-issues",
    "--mode",
    "verified",
    "--goal",
    "Review graph",
    "--scope",
    "src"
  ]);
  const run = await cli(cwd, stateRoot, [
    "graph",
    "inspect",
    "--run",
    started.json.runId
  ]);
  assert.equal(run.json.subject.kind, "run");
  assert.equal(run.json.subject.id, started.json.runId);
  assert.doesNotMatch(run.stdout, /tokenHash|conversation|providerReceipt/);

  const runValidation = await cli(cwd, stateRoot, [
    "graph",
    "validate",
    "--run",
    started.json.runId
  ]);
  assert.equal(runValidation.json.ok, true);
});

test("graph CLI rejects ambiguous targets, formats, positionals, and unknown options", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-graph-args-"));
  for (const args of [
    ["graph", "inspect"],
    [
      "graph",
      "inspect",
      "--template",
      "review-to-issues",
      "--run",
      "sbw-20260727T100000Z-aaaaaaaaaaaa"
    ],
    ["graph", "inspect", "--template", "review-to-issues", "--format", "dot"],
    ["graph", "validate", "--format", "mermaid"],
    ["graph", "validate", "review-to-issues"],
    ["graph", "validate", "--templat", "review-to-issues"]
  ]) {
    const result = await cli(cwd, stateRoot, args, { allowFailure: true });
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, /"ok": false/, args.join(" "));
  }
});

test("source-backed graph gates block eval and run creation for an invalid installed template", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-graph-template-gate-"));
  const copied = await copiedPlugin();
  const templatePath = path.join(
    copied.root,
    "templates",
    "review-to-issues.json"
  );
  const definition = JSON.parse(await readFile(templatePath, "utf8"));
  definition.actionGates["issue.create"].push("not-in-required-evidence");
  await writeFile(templatePath, `${JSON.stringify(definition, null, 2)}\n`);

  const validation = await cli(
    cwd,
    stateRoot,
    ["graph", "validate", "--template", "review-to-issues"],
    { allowFailure: true, executable: copied.cli }
  );
  assert.equal(validation.code, 2);
  assert.ok(
    validation.json.diagnostics.some(
      (item) => item.code === "action-prerequisite-undeclared"
    )
  );

  const evaluation = await cli(cwd, stateRoot, ["eval"], {
    allowFailure: true,
    executable: copied.cli
  });
  assert.equal(evaluation.code, 2);
  assert.equal(evaluation.json.operation, "eval");

  const started = await cli(
    cwd,
    stateRoot,
    [
      "run",
      "--template",
      "review-to-issues",
      "--mode",
      "verified",
      "--goal",
      "Must not start",
      "--scope",
      "src"
    ],
    { allowFailure: true, executable: copied.cli }
  );
  assert.equal(started.code, 2);
  assert.equal(started.json.operation, "run.create");
  assert.equal((await readdir(stateRoot)).includes("runs"), false);
});

test("legacy resume migrates first and then blocks a structurally invalid template", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-graph-resume-gate-"));
  const copied = await copiedPlugin();
  const started = await cli(
    cwd,
    stateRoot,
    [
      "run",
      "--template",
      "review-to-issues",
      "--mode",
      "verified",
      "--goal",
      "Legacy graph migration",
      "--scope",
      "src"
    ],
    { executable: copied.cli }
  );
  const runDirectory = path.join(stateRoot, "runs", started.json.runId);
  const contractPath = path.join(runDirectory, "contract.json");
  const manifestPath = path.join(runDirectory, "manifest.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete contract.templateDigest;
  delete contract.actionGates;
  manifest.version = "2.1.0";
  manifest.contractDigest = digestObject(contract);
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const templatePath = path.join(
    copied.root,
    "templates",
    "review-to-issues.json"
  );
  const definition = JSON.parse(await readFile(templatePath, "utf8"));
  definition.actionGates["issue.create"].push("not-in-required-evidence");
  await writeFile(templatePath, `${JSON.stringify(definition, null, 2)}\n`);

  const resumed = await cli(
    cwd,
    stateRoot,
    ["resume", started.json.runId],
    { allowFailure: true, executable: copied.cli }
  );
  assert.equal(resumed.code, 2);
  assert.equal(resumed.json.operation, "run.resume");
  assert.equal(resumed.json.migration.migrated, true);
  const state = JSON.parse(
    await readFile(path.join(runDirectory, "state.json"), "utf8")
  );
  assert.equal(state.status, "stale");
  assert.equal(state.lastSentinelVerified, false);
});

test("graph derivation failures remain system errors and cannot create a run", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-graph-system-gate-"));
  const copied = await copiedPlugin();
  const templatePath = path.join(
    copied.root,
    "templates",
    "review-to-issues.json"
  );
  const definition = JSON.parse(await readFile(templatePath, "utf8"));
  definition.actionGates["issue.create"] = { malformed: true };
  await writeFile(templatePath, `${JSON.stringify(definition, null, 2)}\n`);
  const result = await cli(
    cwd,
    stateRoot,
    [
      "run",
      "--template",
      "review-to-issues",
      "--mode",
      "verified",
      "--goal",
      "Must fail closed",
      "--scope",
      "src"
    ],
    { allowFailure: true, executable: copied.cli }
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /"ok": false/);
  assert.equal((await readdir(stateRoot)).includes("runs"), false);
});

test("warning-only run graphs do not block resume, authorized action issue, or completion", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-graph-warning-gates-"));

  async function start(authority) {
    const templateDefinition = JSON.parse(
      await readFile(path.join(pluginRoot(), "templates", "review-to-issues.json"), "utf8")
    );
    const contractPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "sbw-graph-warning-contract-")),
      "contract.json"
    );
    await writeFile(
      contractPath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          goal: "Warning-only graph",
          template: "review-to-issues",
          templateDigest: digestObject(templateDefinition),
          scope: { include: ["src"], exclude: [] },
          acceptance: structuredClone(templateDefinition.acceptance),
          requiredEvidence: [
            ...templateDefinition.requiredEvidence,
            "diff-review",
            "provider-reconciliation"
          ],
          controlPlane: structuredClone(templateDefinition.controlPlane),
          executionStages: structuredClone(templateDefinition.executionStages),
          actionStages: structuredClone(templateDefinition.actionStages),
          authority: { rootOnlyMutation: true, externalSideEffects: authority ? ["issue.create"] : [] },
          risk: { risk: 0, uncertainty: 0, blastRadius: 0, irreversibility: 0, evidenceGap: 0 },
          sensitivity: "internal",
          agy: { allowed: false, sanitized: false, required: false },
          volatileExclusions: [],
          highRiskIgnored: [],
          remoteRevision: null,
          actionGates: structuredClone(templateDefinition.actionGates),
          acceptanceEvidence: Object.fromEntries(templateDefinition.acceptance.map((item) => [item.id, [...templateDefinition.requiredEvidence]]))
        },
        null,
        2
      )}\n`
    );
    const args = [
      "run",
      "--template",
      "review-to-issues",
      "--contract",
      contractPath,
      "--mode",
      "verified",
      "--goal",
      "Warning-only graph",
      "--scope",
      "src"
    ];
    if (authority) args.push("--authority", "issue.create");
    return cli(cwd, stateRoot, args);
  }

  async function seed(runId, prefix, packageId, head) {
    const records = [
      ["base-revision", ["scope-reviewed"]],
      ["review-findings", ["scope-reviewed"]],
      ["diff-review", []],
      ["duplicate-check", ["issues-deduplicated"]],
      ["current-revision", ["issues-deduplicated"]],
      ["run-result", []]
    ];
    const contract = JSON.parse(await readFile(path.join(stateRoot, "runs", runId, "contract.json"), "utf8"));
    for (const [kind, acceptanceIds] of records) {
      const target = path.join(
        await mkdtemp(path.join(os.tmpdir(), "sbw-graph-warning-evidence-")),
        `${kind}.json`
      );
      await writeFile(
        target,
        `${JSON.stringify(
          {
            schemaVersion: 2,
            id: `${prefix}-${kind}`,
            kind,
            summary: `Evidence for ${kind}`,
            status: "complete",
            acceptanceIds,
            sourceDigest: digestObject(kind === "base-revision" || kind === "current-revision"
              ? { revision: "a".repeat(40) }
              : kind === "review-findings"
                ? { verdict: "PASS" }
                : kind === "diff-review"
                  ? { verdict: "PASS", packageId, head }
                : kind === "run-result"
                  ? { items: [] }
                  : { command: "true", result: true }),
            dependencyInputs: { files: [] },
            receipt: {
              contractId: `evidence-contracts-v1:${kind}`,
              contractVersion: 1,
              runId,
              producer: { provider: "codex-root" },
              inputBinding: { runId, contractDigest: digestObject(contract), remoteRevision: null },
              payload: kind === "base-revision" || kind === "current-revision"
                ? { revision: "a".repeat(40) }
                : kind === "review-findings"
                  ? { verdict: "PASS" }
                  : kind === "diff-review"
                    ? { verdict: "PASS", packageId, head }
                  : kind === "run-result"
                    ? { items: [] }
                    : { command: "true", result: true },
              payloadDigest: digestObject(kind === "base-revision" || kind === "current-revision"
                ? { revision: "a".repeat(40) }
                : kind === "review-findings"
                  ? { verdict: "PASS" }
                  : kind === "diff-review"
                    ? { verdict: "PASS", packageId, head }
                  : kind === "run-result"
                    ? { items: [] }
                    : { command: "true", result: true }),
              producedAt: new Date().toISOString()
            }
          },
          null,
          2
        )}\n`
      );
      await cli(cwd, stateRoot, [
        "evidence",
        "add",
        runId,
        "--file",
        target
      ]);
    }
  }

  const authorized = await start(true);
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" })).stdout.trim();
  const review = await createReviewPackage({
    root: stateRoot,
    runId: authorized.json.runId,
    base: head,
    head,
    scope: ["src"],
    diffManifest: { files: [] },
    instructionDigest: DIGEST,
    sentinelDigest: authorized.json.sentinel.digest
  });
  await seed(authorized.json.runId, "authorized", review.packageId, head);
  await markBroadReviewComplete(stateRoot, authorized.json.runId, review.packageId, head, authorized.json.sentinel.digest);
  const ledgerPath = path.join(stateRoot, "runs", authorized.json.runId, "ledger.json");
  const transition = async (eventId, type, taskId, evidenceKinds = []) => {
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    await transitionLedger(stateRoot, authorized.json.runId, {
      eventId,
      type,
      taskId,
      evidenceKinds,
      expectedLedgerDigest: digestObject(ledger)
    });
  };
  await transition("package-start", "start", "package");
  await transition("package-complete", "complete", "package", ["base-revision", "review-findings"]);
  await transition("findings-start", "start", "findings");
  await transition("findings-complete", "complete", "findings", ["review-findings", "diff-review"]);
  await transition("dedupe-start", "start", "dedupe");
  await transition("dedupe-complete", "complete", "dedupe", ["duplicate-check"]);
  await transition("freshness-start", "start", "freshness");
  await transition("freshness-complete", "complete", "freshness", ["current-revision"]);
  const warningGraph = await cli(cwd, stateRoot, [
    "graph",
    "validate",
    "--run",
    authorized.json.runId
  ]);
  assert.equal(warningGraph.json.ok, true);
  assert.equal(
    warningGraph.json.diagnostics.some((item) => item.severity === "error"),
    false
  );

  const resumed = await cli(cwd, stateRoot, ["resume", authorized.json.runId]);
  assert.equal(resumed.json.ok, true);
  assert.equal(resumed.json.status, "running");

  const issued = await cli(cwd, stateRoot, [
    "action",
    "issue",
    authorized.json.runId,
    "--action",
    "issue.create",
    "--provider",
    "github",
    "--resource",
    "fixture",
    "--remote-revision",
    "none"
  ]);
  assert.equal(issued.json.ok, true);
  assert.equal(issued.json.action.status, "issued");

  const completed = await cli(cwd, stateRoot, [
    "complete",
    authorized.json.runId
  ], { allowFailure: true });
  assert.equal(completed.json.ok, false);
  assert.match(completed.json.blockers.join("\n"), /side-effect-not-reconciled|ledger:not-complete/);

  const unauthorized = await start(false);
  const unauthorizedHead = head;
  const unauthorizedReview = await createReviewPackage({
    root: stateRoot,
    runId: unauthorized.json.runId,
    base: unauthorizedHead,
    head: unauthorizedHead,
    scope: ["src"],
    diffManifest: { files: [] },
    instructionDigest: DIGEST,
    sentinelDigest: unauthorized.json.sentinel.digest
  });
  await seed(unauthorized.json.runId, "unauthorized", unauthorizedReview.packageId, unauthorizedHead);
  await markBroadReviewComplete(stateRoot, unauthorized.json.runId, unauthorizedReview.packageId, unauthorizedHead, unauthorized.json.sentinel.digest);
  const unauthorizedLedgerPath = path.join(stateRoot, "runs", unauthorized.json.runId, "ledger.json");
  const unauthorizedTransition = async (eventId, type, taskId, evidenceKinds = []) => {
    const ledger = JSON.parse(await readFile(unauthorizedLedgerPath, "utf8"));
    await transitionLedger(stateRoot, unauthorized.json.runId, {
      eventId,
      type,
      taskId,
      evidenceKinds,
      expectedLedgerDigest: digestObject(ledger)
    });
  };
  await unauthorizedTransition("package-start", "start", "package");
  await unauthorizedTransition("package-complete", "complete", "package", ["base-revision", "review-findings"]);
  await unauthorizedTransition("findings-start", "start", "findings");
  await unauthorizedTransition("findings-complete", "complete", "findings", ["review-findings", "diff-review"]);
  await unauthorizedTransition("dedupe-start", "start", "dedupe");
  await unauthorizedTransition("dedupe-complete", "complete", "dedupe", ["duplicate-check"]);
  await unauthorizedTransition("freshness-start", "start", "freshness");
  await unauthorizedTransition("freshness-complete", "complete", "freshness", ["current-revision"]);
  const denied = await cli(
    cwd,
    stateRoot,
    [
      "action",
      "issue",
      unauthorized.json.runId,
      "--action",
      "issue.create",
      "--provider",
      "github",
      "--resource",
      "fixture",
      "--remote-revision",
      "none"
    ],
    { allowFailure: true }
  );
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /Action not authorized by TaskContract/);
  assert.deepEqual(
    await readdir(
      path.join(stateRoot, "runs", unauthorized.json.runId, "actions")
    ),
    []
  );
});

test("live-run derivation exceptions cannot issue an action or mutate completion state", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-graph-live-system-"));
  const copied = await copiedPlugin();
  const started = await cli(
    cwd,
    stateRoot,
    [
      "run",
      "--template",
      "review-to-issues",
      "--mode",
      "verified",
      "--goal",
      "Live derivation failure",
      "--scope",
      "src",
      "--authority",
      "issue.create"
    ],
    { executable: copied.cli }
  );
  const runDirectory = path.join(stateRoot, "runs", started.json.runId);
  const templatePath = path.join(
    copied.root,
    "templates",
    "review-to-issues.json"
  );
  const definition = JSON.parse(await readFile(templatePath, "utf8"));
  definition.actionGates["issue.create"] = { malformed: true };
  await writeFile(templatePath, `${JSON.stringify(definition, null, 2)}\n`);
  const stateBefore = JSON.parse(
    await readFile(path.join(runDirectory, "state.json"), "utf8")
  );

  const action = await cli(
    cwd,
    stateRoot,
    [
      "action",
      "issue",
      started.json.runId,
      "--action",
      "issue.create",
      "--provider",
      "github",
      "--resource",
      "fixture",
      "--remote-revision",
      "none"
    ],
    { allowFailure: true, executable: copied.cli }
  );
  assert.equal(action.code, 1);
  assert.deepEqual(await readdir(path.join(runDirectory, "actions")), []);

  const completion = await cli(
    cwd,
    stateRoot,
    ["complete", started.json.runId],
    { allowFailure: true, executable: copied.cli }
  );
  assert.equal(completion.code, 1);
  const stateAfter = JSON.parse(
    await readFile(path.join(runDirectory, "state.json"), "utf8")
  );
  assert.deepEqual(stateAfter, stateBefore);
});

test("live-run structural drift exits 2 and blocks action issue and completion", async () => {
  const cwd = await repository();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "sbw-graph-drift-"));
  const started = await cli(cwd, stateRoot, [
    "run",
    "--template",
    "review-to-issues",
    "--mode",
    "verified",
    "--goal",
    "Review graph",
    "--scope",
    "src",
    "--authority",
    "issue.create"
  ]);
  const runDirectory = path.join(stateRoot, "runs", started.json.runId);
  const contractPath = path.join(runDirectory, "contract.json");
  const manifestPath = path.join(runDirectory, "manifest.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  contract.templateDigest = DIGEST;
  manifest.contractDigest = digestObject(contract);
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const validation = await cli(
    cwd,
    stateRoot,
    ["graph", "validate", "--run", started.json.runId],
    { allowFailure: true }
  );
  assert.equal(validation.code, 2);
  assert.ok(
    validation.json.diagnostics.some((item) => item.code === "template-digest-drift")
  );

  const action = await cli(
    cwd,
    stateRoot,
    [
      "action",
      "issue",
      started.json.runId,
      "--action",
      "issue.create",
      "--provider",
      "github",
      "--resource",
      "fixture",
      "--remote-revision",
      "none"
    ],
    { allowFailure: true }
  );
  assert.equal(action.code, 2);
  assert.equal(action.json.operation, "action.issue");
  assert.deepEqual(await readdir(path.join(runDirectory, "actions")), []);
  const stateBeforeCompletion = JSON.parse(
    await readFile(path.join(runDirectory, "state.json"), "utf8")
  );

  const completion = await cli(
    cwd,
    stateRoot,
    ["complete", started.json.runId],
    { allowFailure: true }
  );
  assert.equal(completion.code, 2);
  assert.equal(completion.json.operation, "run.complete");
  const stateAfterCompletion = JSON.parse(
    await readFile(path.join(runDirectory, "state.json"), "utf8")
  );
  assert.equal(stateBeforeCompletion.status, "running");
  assert.deepEqual(stateAfterCompletion, stateBeforeCompletion);
  assert.equal("graphDigest" in stateAfterCompletion, false);
});
