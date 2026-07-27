import path from "node:path";
import { digestObject } from "./core.mjs";

export const GRAPH_SCHEMA_VERSION = 1;

export const GRAPH_NODE_KINDS = new Set([
  "template",
  "run",
  "run-state",
  "acceptance",
  "evidence-kind",
  "evidence-record",
  "policy-gate",
  "action-kind",
  "action-attempt",
  "finding",
  "sentinel",
  "source-binding",
  "root-action"
]);

export const GRAPH_EDGE_KINDS = new Set([
  "instantiates",
  "declares",
  "requires",
  "satisfies",
  "gates",
  "records",
  "binds",
  "freshness-depends-on"
]);

const HARD_EDGE_KINDS = new Set(["requires", "gates"]);
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const ENDPOINTS = {
  instantiates: [["run"], ["template"]],
  declares: [
    ["template", "run"],
    [
      "run-state",
      "acceptance",
      "evidence-kind",
      "policy-gate",
      "action-kind",
      "root-action"
    ]
  ],
  requires: [
    ["template", "run", "action-kind", "evidence-kind", "policy-gate"],
    ["acceptance", "evidence-kind", "policy-gate", "action-kind"]
  ],
  satisfies: [["evidence-record"], ["acceptance"]],
  gates: [
    ["policy-gate", "action-kind", "evidence-kind"],
    ["action-kind", "evidence-kind", "policy-gate"]
  ],
  records: [
    ["run"],
    ["evidence-record", "action-attempt", "finding", "sentinel", "source-binding"]
  ],
  binds: [
    ["run", "action-attempt", "evidence-record"],
    ["template", "action-kind", "evidence-kind", "source-binding", "sentinel"]
  ],
  "freshness-depends-on": [["evidence-record"], ["source-binding"]]
};

function pointerSegment(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function scopedStableId(scope, stableId) {
  return `${scope}/${stableId}`;
}

export function graphNodeId(kind, stableId) {
  return `${kind}:${encodeURIComponent(String(stableId))}`;
}

export function graphEdgeId(kind, from, to) {
  return `${kind}:${from}->${to}`;
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("\\")) {
    return false;
  }
  return !value.split("/").some((part) => part === "..");
}

function safeSource(source) {
  return (
    source &&
    typeof source === "object" &&
    safeRelativePath(source.path) &&
    typeof source.pointer === "string" &&
    source.pointer.startsWith("#") &&
    HEX_DIGEST.test(source.digest)
  );
}

function diagnostic(code, severity, message, subjects = []) {
  return {
    code,
    severity,
    message,
    subjects: [...new Set(subjects)].sort()
  };
}

function compareId(left, right) {
  return left.id.localeCompare(right.id);
}

function dedupeDiagnostics(items) {
  const seen = new Set();
  return items
    .filter((item) => {
      const key = digestObject({
        code: item.code,
        severity: item.severity,
        subjects: item.subjects ?? [],
        message: item.message
      });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) =>
      `${left.severity}:${left.code}:${left.subjects?.join(",")}`.localeCompare(
        `${right.severity}:${right.code}:${right.subjects?.join(",")}`
      )
    );
}

function createAccumulator() {
  const nodes = [];
  const edges = [];
  const diagnostics = [];

  return {
    nodes,
    edges,
    diagnostics,
    node(kind, stableId, label, source) {
      const id = graphNodeId(kind, stableId);
      nodes.push({ id, kind, stableId: String(stableId), label: String(label), source });
      return id;
    },
    edge(kind, from, to, source) {
      const id = graphEdgeId(kind, from, to);
      edges.push({ id, kind, from, to, source });
      return id;
    },
    error(code, message, subjects = []) {
      diagnostics.push(diagnostic(code, "error", message, subjects));
    },
    warning(code, message, subjects = []) {
      diagnostics.push(diagnostic(code, "warning", message, subjects));
    }
  };
}

function source(pathname, pointer, value) {
  return {
    path: pathname,
    pointer,
    digest: digestObject(value)
  };
}

function manifestProjection(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    runId: manifest.runId,
    version: manifest.version,
    template: manifest.template,
    mode: manifest.mode,
    requestedMode: manifest.requestedMode,
    baselineRevision: manifest.baselineRevision ?? null,
    authority: {
      rootOnlyMutation: manifest.authority?.rootOnlyMutation === true,
      nativeSubagentsAreTrustedContract:
        manifest.authority?.nativeSubagentsAreTrustedContract === true
    }
  };
}

function contractProjection(contract) {
  return {
    schemaVersion: contract.schemaVersion,
    template: contract.template,
    templateDigest: contract.templateDigest ?? null,
    acceptance: (contract.acceptance ?? []).map((item) => ({
      id: item.id,
      critical: item.critical === true
    })),
    requiredEvidence: [...(contract.requiredEvidence ?? [])],
    actionGates: structuredClone(contract.actionGates ?? {}),
    authority: {
      externalSideEffects: [
        ...(contract.authority?.externalSideEffects ?? [])
      ]
    },
    agy: {
      allowed: contract.agy?.allowed === true,
      sanitized: contract.agy?.sanitized === true,
      required: contract.agy?.required === true
    }
  };
}

function stateProjection(state) {
  return {
    schemaVersion: state.schemaVersion,
    runId: state.runId,
    status: state.status,
    mode: state.mode,
    lastSentinel: state.lastSentinel
      ? { label: state.lastSentinel.label ?? "current" }
      : null,
    lastSentinelVerified: state.lastSentinelVerified === true,
    lastSentinelComplete: state.lastSentinelComplete === true,
    migration: state.migration
      ? {
          kind: state.migration.kind,
          fromVersion: state.migration.fromVersion,
          toVersion: state.migration.toVersion
        }
      : null
  };
}

function dependencyProjection(dependency) {
  return {
    path: dependency.path,
    type: dependency.type ?? null,
    mode: dependency.mode ?? null,
    size: dependency.size ?? null
  };
}

function evidenceProjection(record) {
  return {
    schemaVersion: record.schemaVersion,
    id: record.id,
    kind: record.kind,
    status: record.status,
    stale: record.stale === true,
    acceptanceIds: [...(record.acceptanceIds ?? [])],
    workflowVersion: record.dependencies?.workflowVersion ?? null,
    dependencyFiles: Array.isArray(record.dependencies?.files)
      ? record.dependencies.files.map(dependencyProjection)
      : []
  };
}

function findingProjection(finding) {
  return {
    schemaVersion: finding.schemaVersion,
    id: finding.id,
    severity: finding.severity,
    status: finding.status,
    evidenceId: finding.evidenceId ?? null
  };
}

function actionProjection(action) {
  return {
    schemaVersion: action.schemaVersion,
    action: action.action,
    provider: action.provider ?? null,
    status: action.status,
    outcome: action.outcome ?? null,
    attemptId: action.attemptId ?? null
  };
}

function templateParts(accumulator, template, sourcePath) {
  const scope = template.name;
  const templateSource = source(sourcePath, "#", template);
  const templateNode = accumulator.node("template", scope, template.name, templateSource);
  const evidenceNodes = new Map();
  const acceptanceNodes = new Map();

  for (const [index, item] of (template.acceptance ?? []).entries()) {
    const stableId = scopedStableId(scope, item.id);
    const itemSource = source(sourcePath, `#/acceptance/${index}`, item);
    const node = accumulator.node("acceptance", stableId, item.id, itemSource);
    acceptanceNodes.set(item.id, node);
    accumulator.edge("declares", templateNode, node, itemSource);
  }

  for (const [index, kind] of (template.requiredEvidence ?? []).entries()) {
    const stableId = scopedStableId(scope, kind);
    const itemSource = source(sourcePath, `#/requiredEvidence/${index}`, kind);
    const node = accumulator.node("evidence-kind", stableId, kind, itemSource);
    evidenceNodes.set(kind, node);
    accumulator.edge("declares", templateNode, node, itemSource);
    accumulator.edge("requires", templateNode, node, itemSource);
  }

  for (const [index, gate] of (template.policyGates ?? []).entries()) {
    const stableId = scopedStableId(scope, gate);
    const itemSource = source(sourcePath, `#/policyGates/${index}`, gate);
    const node = accumulator.node("policy-gate", stableId, gate, itemSource);
    accumulator.edge("declares", templateNode, node, itemSource);
  }

  for (const [action, requirements] of Object.entries(template.actionGates ?? {}).sort()) {
    const actionSource = source(
      sourcePath,
      `#/actionGates/${pointerSegment(action)}`,
      requirements
    );
    const actionNode = accumulator.node(
      "action-kind",
      scopedStableId(scope, action),
      action,
      actionSource
    );
    accumulator.edge("declares", templateNode, actionNode, actionSource);
    for (const [index, kind] of requirements.entries()) {
      let evidenceNode = evidenceNodes.get(kind);
      const requirementSource = source(
        sourcePath,
        `#/actionGates/${pointerSegment(action)}/${index}`,
        kind
      );
      if (!evidenceNode) {
        evidenceNode = accumulator.node(
          "evidence-kind",
          scopedStableId(scope, kind),
          kind,
          requirementSource
        );
        evidenceNodes.set(kind, evidenceNode);
        accumulator.error(
          "action-prerequisite-undeclared",
          `Action ${action} requires evidence kind ${kind}, which is not in requiredEvidence`,
          [actionNode, evidenceNode]
        );
      }
      accumulator.edge("gates", actionNode, evidenceNode, requirementSource);
    }
  }

  for (const [index, action] of (template.rootOnlyActions ?? []).entries()) {
    const itemSource = source(sourcePath, `#/rootOnlyActions/${index}`, action);
    const node = accumulator.node(
      "root-action",
      scopedStableId(scope, action),
      action,
      itemSource
    );
    accumulator.edge("declares", templateNode, node, itemSource);
  }

  return { templateNode, evidenceNodes, acceptanceNodes, templateSource };
}

function hardCycleDiagnostics(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (HARD_EDGE_KINDS.has(edge.kind) && adjacency.has(edge.from)) {
      adjacency.get(edge.from).push(edge.to);
    }
  }
  const active = new Set();
  const complete = new Set();
  const stack = [];
  const cycles = [];

  function visit(id) {
    if (complete.has(id)) return;
    if (active.has(id)) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    active.add(id);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    stack.pop();
    active.delete(id);
    complete.add(id);
  }

  for (const id of [...adjacency.keys()].sort()) visit(id);
  return cycles.map((cycle) =>
    diagnostic(
      "hard-dependency-cycle",
      "error",
      "A requires/gates dependency cycle was detected",
      cycle
    )
  );
}

export function validateGraph(graph) {
  const diagnostics = [];
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const nodeById = new Map();
  const edgeIds = new Set();

  if (
    graph?.schemaVersion !== GRAPH_SCHEMA_VERSION ||
    !graph?.subject ||
    !["template", "run"].includes(graph.subject.kind) ||
    typeof graph.subject.id !== "string" ||
    !HEX_DIGEST.test(graph.subject.sourceDigest ?? "")
  ) {
    diagnostics.push(
      diagnostic("invalid-graph-subject", "error", "Graph subject is missing or invalid")
    );
  }

  for (const node of nodes) {
    if (!GRAPH_NODE_KINDS.has(node.kind)) {
      diagnostics.push(
        diagnostic("unknown-node-kind", "error", `Unknown node kind: ${node.kind}`, [node.id])
      );
    }
    if (nodeById.has(node.id)) {
      diagnostics.push(
        diagnostic("duplicate-node", "error", `Duplicate node id: ${node.id}`, [node.id])
      );
    } else {
      nodeById.set(node.id, node);
    }
    if (!safeSource(node.source)) {
      diagnostics.push(
        diagnostic(
          "unsafe-provenance",
          "error",
          `Node provenance is missing or unsafe: ${node.id}`,
          [node.id]
        )
      );
    }
  }

  for (const edge of edges) {
    if (!GRAPH_EDGE_KINDS.has(edge.kind)) {
      diagnostics.push(
        diagnostic("unknown-edge-kind", "error", `Unknown edge kind: ${edge.kind}`, [edge.id])
      );
    }
    if (edgeIds.has(edge.id)) {
      diagnostics.push(
        diagnostic("duplicate-edge", "error", `Duplicate edge id: ${edge.id}`, [edge.id])
      );
    }
    edgeIds.add(edge.id);
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) {
      diagnostics.push(
        diagnostic(
          "dangling-edge",
          "error",
          `Edge ${edge.id} has a missing endpoint`,
          [edge.id, edge.from, edge.to]
        )
      );
    } else if (ENDPOINTS[edge.kind]) {
      const [fromKinds, toKinds] = ENDPOINTS[edge.kind];
      if (!fromKinds.includes(from.kind) || !toKinds.includes(to.kind)) {
        diagnostics.push(
          diagnostic(
            "incompatible-endpoint",
            "error",
            `Edge ${edge.id} connects incompatible node kinds`,
            [edge.id, edge.from, edge.to]
          )
        );
      }
    }
    if (!safeSource(edge.source)) {
      diagnostics.push(
        diagnostic(
          "unsafe-provenance",
          "error",
          `Edge provenance is missing or unsafe: ${edge.id}`,
          [edge.id]
        )
      );
    }
  }

  diagnostics.push(...hardCycleDiagnostics(nodes, edges));
  const subjectNode = nodes.find(
    (node) =>
      node.kind === graph?.subject?.kind &&
      (node.stableId === graph.subject.id || node.label === graph.subject.id)
  );
  if (subjectNode) {
    const adjacency = new Map(nodes.map((node) => [node.id, []]));
    for (const edge of edges) {
      if (adjacency.has(edge.from) && nodeById.has(edge.to)) {
        adjacency.get(edge.from).push(edge.to);
      }
    }
    const reachable = new Set();
    const pending = [subjectNode.id];
    while (pending.length > 0) {
      const current = pending.pop();
      if (reachable.has(current)) continue;
      reachable.add(current);
      pending.push(...(adjacency.get(current) ?? []));
    }
    for (const node of nodes) {
      if (
        ["policy-gate", "root-action"].includes(node.kind) &&
        !reachable.has(node.id)
      ) {
        diagnostics.push(
          diagnostic(
            "advisory-node-unreachable",
            "warning",
            `Advisory node is unreachable from the graph subject: ${node.id}`,
            [node.id]
          )
        );
      }
    }
  }
  return dedupeDiagnostics(diagnostics);
}

function finalizeGraph(subject, accumulator) {
  const nodes = [...accumulator.nodes].sort(compareId);
  const edges = [...accumulator.edges].sort(compareId);
  const structuralDiagnostics = validateGraph({
    schemaVersion: GRAPH_SCHEMA_VERSION,
    subject,
    nodes,
    edges
  });
  const diagnostics = dedupeDiagnostics([
    ...accumulator.diagnostics,
    ...structuralDiagnostics
  ]);
  const graphDigest = digestObject({
    schemaVersion: GRAPH_SCHEMA_VERSION,
    subject,
    nodes,
    edges
  });
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    subject,
    nodes,
    edges,
    diagnostics,
    graphDigest
  };
}

export function buildTemplateGraph({ template, sourcePath }) {
  const accumulator = createAccumulator();
  const templateSource = source(sourcePath, "#", template);
  templateParts(accumulator, template, sourcePath);
  return finalizeGraph(
    {
      kind: "template",
      id: template.name,
      sourceDigest: templateSource.digest
    },
    accumulator
  );
}

export function buildTemplateCatalogGraph(templates) {
  const accumulator = createAccumulator();
  const ordered = [...templates].sort((left, right) => left.name.localeCompare(right.name));
  for (const template of ordered) {
    templateParts(accumulator, template, `templates/${template.name}.json`);
  }
  return finalizeGraph(
    {
      kind: "template",
      id: "installed-templates",
      sourceDigest: digestObject(ordered)
    },
    accumulator
  );
}

export function buildRunGraph({
  template,
  manifest,
  contract,
  state,
  evidence = [],
  findings = [],
  actions = []
}) {
  const accumulator = createAccumulator();
  const parts = templateParts(
    accumulator,
    template,
    `templates/${template.name}.json`
  );
  const runId = manifest.runId;
  const manifestSource = source("manifest.json", "#", manifestProjection(manifest));
  const contractSource = source("contract.json", "#", contractProjection(contract));
  const stateSource = source("state.json", "#", stateProjection(state));
  const runNode = accumulator.node("run", runId, runId, manifestSource);
  const stateNode = accumulator.node(
    "run-state",
    scopedStableId(runId, state.status),
    state.status,
    stateSource
  );
  accumulator.edge("instantiates", runNode, parts.templateNode, manifestSource);
  accumulator.edge("declares", runNode, stateNode, stateSource);

  const expectedTemplateDigest = digestObject(template);
  if (manifest.template !== template.name || contract.template !== template.name) {
    accumulator.error(
      "run-template-mismatch",
      "Run manifest or TaskContract references a different template",
      [runNode, parts.templateNode]
    );
  }
  if (contract.templateDigest !== expectedTemplateDigest) {
    accumulator.error(
      "template-digest-drift",
      "Run TaskContract template digest differs from the installed template",
      [runNode, parts.templateNode]
    );
  }
  if (manifest.contractDigest !== digestObject(contract)) {
    accumulator.error(
      "contract-digest-drift",
      "Run manifest contract digest differs from contract.json",
      [runNode]
    );
  }
  if (digestObject(contract.actionGates ?? {}) !== digestObject(template.actionGates ?? {})) {
    accumulator.error(
      "action-gate-drift",
      "Run action gates differ from the installed template",
      [runNode]
    );
  }

  const contractEvidence = new Set(contract.requiredEvidence ?? []);
  for (const kind of template.requiredEvidence ?? []) {
    if (!contractEvidence.has(kind)) {
      accumulator.error(
        "template-minimum-drift",
        `TaskContract is missing template evidence minimum: ${kind}`,
        [runNode, parts.evidenceNodes.get(kind)].filter(Boolean)
      );
    }
  }
  for (const [action, requirements] of Object.entries(contract.actionGates ?? {})) {
    for (const kind of requirements) {
      if (!contractEvidence.has(kind)) {
        accumulator.error(
          "action-prerequisite-undeclared",
          `Run action ${action} requires undeclared evidence kind ${kind}`,
          [runNode]
        );
      }
    }
  }

  const contractAcceptance = new Map(
    (contract.acceptance ?? []).map((item) => [item.id, item])
  );
  const runAcceptanceNodes = new Map();
  for (const [index, item] of (contract.acceptance ?? []).entries()) {
    const existing = parts.acceptanceNodes.get(item.id);
    if (existing) {
      runAcceptanceNodes.set(item.id, existing);
      continue;
    }
    const itemSource = source("contract.json", `#/acceptance/${index}`, item);
    const node = accumulator.node(
      "acceptance",
      scopedStableId(runId, item.id),
      item.id,
      itemSource
    );
    accumulator.edge("declares", runNode, node, itemSource);
    runAcceptanceNodes.set(item.id, node);
  }

  const runEvidenceNodes = new Map();
  const runEvidenceKindNodes = new Map(parts.evidenceNodes);
  const sourceBindingNodes = new Map();
  for (const [index, record] of evidence.entries()) {
    const recordSource = source(
      `evidence/record-${index + 1}.json`,
      "#",
      evidenceProjection(record)
    );
    const recordNode = accumulator.node(
      "evidence-record",
      scopedStableId(runId, record.id),
      `${record.kind}:${record.id}`,
      recordSource
    );
    runEvidenceNodes.set(record.id, recordNode);
    accumulator.edge("records", runNode, recordNode, recordSource);
    let evidenceKindNode = runEvidenceKindNodes.get(record.kind);
    if (!evidenceKindNode) {
      evidenceKindNode = accumulator.node(
        "evidence-kind",
        scopedStableId(runId, record.kind),
        record.kind,
        recordSource
      );
      runEvidenceKindNodes.set(record.kind, evidenceKindNode);
    }
    accumulator.edge("binds", recordNode, evidenceKindNode, recordSource);
    for (const acceptanceId of record.acceptanceIds ?? []) {
      const acceptanceNode =
        runAcceptanceNodes.get(acceptanceId) ?? parts.acceptanceNodes.get(acceptanceId);
      if (!contractAcceptance.has(acceptanceId) || !acceptanceNode) {
        accumulator.error(
          "unknown-acceptance-reference",
          `Evidence ${record.id} references unknown acceptance ${acceptanceId}`,
          [recordNode]
        );
        continue;
      }
      accumulator.edge("satisfies", recordNode, acceptanceNode, recordSource);
    }
    if (record.stale === true) {
      accumulator.warning(
        "stale-evidence",
        `Evidence ${record.id} is stale`,
        [recordNode]
      );
    }
    if (!contractEvidence.has(record.kind)) {
      accumulator.warning(
        "observed-relation-undetermined",
        `Evidence ${record.id} uses a kind outside the TaskContract minimum`,
        [recordNode]
      );
    }
    if (!HEX_DIGEST.test(record.sourceDigest ?? "")) {
      accumulator.error(
        "missing-source-binding",
        `Evidence ${record.id} lacks a safe source digest`,
        [recordNode]
      );
    }
    const dependencyFiles = Array.isArray(record.dependencies?.files)
      ? record.dependencies.files
      : [];
    for (const [dependencyIndex, dependency] of dependencyFiles.entries()) {
      const pathname = dependency.path;
      if (!safeRelativePath(pathname)) {
        accumulator.error(
          "unsafe-source-binding",
          `Evidence ${record.id} has an unsafe dependency path`,
          [recordNode]
        );
        continue;
      }
      const dependencySource = source(
        `evidence/record-${index + 1}.json`,
        `#/dependencies/files/${dependencyIndex}`,
        dependencyProjection(dependency)
      );
      const bindingKey = `${pathname}:${digestObject(dependencyProjection(dependency))}`;
      let bindingNode = sourceBindingNodes.get(bindingKey);
      if (!bindingNode) {
        bindingNode = accumulator.node(
          "source-binding",
          scopedStableId(runId, bindingKey),
          pathname,
          dependencySource
        );
        sourceBindingNodes.set(bindingKey, bindingNode);
        accumulator.edge("records", runNode, bindingNode, dependencySource);
      }
      accumulator.edge(
        "freshness-depends-on",
        recordNode,
        bindingNode,
        dependencySource
      );
    }
  }

  for (const [index, finding] of findings.entries()) {
    const findingSource = source(
      `findings/record-${index + 1}.json`,
      "#",
      findingProjection(finding)
    );
    const findingNode = accumulator.node(
      "finding",
      scopedStableId(runId, finding.id),
      `${finding.severity}:${finding.status}:${finding.id}`,
      findingSource
    );
    accumulator.edge("records", runNode, findingNode, findingSource);
  }

  const authorities = new Set(contract.authority?.externalSideEffects ?? []);
  for (const [index, action] of actions.entries()) {
    const actionSource = source(
      `actions/record-${index + 1}.json`,
      "#",
      actionProjection(action)
    );
    const attemptStableId = scopedStableId(
      runId,
      `${action.action}/${action.attemptId ?? `record-${index + 1}`}`
    );
    const attemptNode = accumulator.node(
      "action-attempt",
      attemptStableId,
      `${action.action}:${action.status}:${action.outcome ?? "none"}`,
      actionSource
    );
    accumulator.edge("records", runNode, attemptNode, actionSource);
    const actionKindNode = graphNodeId(
      "action-kind",
      scopedStableId(template.name, action.action)
    );
    if (!accumulator.nodes.some((node) => node.id === actionKindNode)) {
      accumulator.error(
        "unknown-action-kind",
        `Action attempt references an action absent from the template: ${action.action}`,
        [attemptNode]
      );
    } else {
      accumulator.edge("binds", attemptNode, actionKindNode, actionSource);
    }
    if (!authorities.has(action.action) && !authorities.has("*")) {
      accumulator.error(
        "unauthorized-action-path",
        `Action attempt is not authorized by the TaskContract: ${action.action}`,
        [attemptNode]
      );
    }
  }

  if (state.lastSentinel) {
    const sentinelSource = source("state.json", "#/lastSentinel", {
      label: state.lastSentinel.label ?? "current"
    });
    const sentinelNode = accumulator.node(
      "sentinel",
      scopedStableId(runId, state.lastSentinel.label ?? "current"),
      state.lastSentinel.label ?? "current",
      sentinelSource
    );
    accumulator.edge("records", runNode, sentinelNode, sentinelSource);
    accumulator.edge("binds", runNode, sentinelNode, sentinelSource);
  }

  for (const record of evidence) {
    if (
      runEvidenceNodes.has(record.id) &&
      (!Array.isArray(record.acceptanceIds) || record.acceptanceIds.length === 0) &&
      !contractEvidence.has(record.kind)
    ) {
      accumulator.warning(
        "optional-orphan-record",
        `Optional evidence ${record.id} does not satisfy an acceptance`,
        [runEvidenceNodes.get(record.id)]
      );
    }
  }

  return finalizeGraph(
    {
      kind: "run",
      id: runId,
      sourceDigest: digestObject({
        template: expectedTemplateDigest,
        manifest: manifestSource.digest,
        contract: contractSource.digest,
        state: stateSource.digest,
        evidence: evidence.map((item) => digestObject(evidenceProjection(item))).sort(),
        findings: findings.map((item) => digestObject(findingProjection(item))).sort(),
        actions: actions.map((item) => digestObject(actionProjection(item))).sort()
      })
    },
    accumulator
  );
}

function mermaidLabel(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("%", "&#37;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
    .replaceAll("`", "&#96;")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

export function renderGraphMermaid(graph) {
  const index = new Map(graph.nodes.map((node, position) => [node.id, `n${position}`]));
  const lines = ["flowchart LR"];
  for (const node of graph.nodes) {
    lines.push(
      `  ${index.get(node.id)}["${mermaidLabel(`${node.kind}: ${node.label}`)}"]`
    );
  }
  for (const edge of graph.edges) {
    if (!index.has(edge.from) || !index.has(edge.to)) continue;
    lines.push(
      `  ${index.get(edge.from)} -->|${mermaidLabel(edge.kind)}| ${index.get(edge.to)}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function graphHasErrors(graph) {
  return graph.diagnostics.some((item) => item.severity === "error");
}
