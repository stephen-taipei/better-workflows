#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  stat
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSION,
  addEvidence,
  addFinding,
  appendJournal,
  atomicWriteJson,
  assertActionIsNotDeferred,
  assertMutableRun,
  bindLegacyRunTemplate,
  buildContract,
  cleanupRuns,
  consumeActionToken,
  completeRun,
  createRun,
  currentProviderExecutableIdentity,
  digestObject,
  ensureStateRoot,
  evaluateCompletion,
  executeActionToken,
  getStateRoot,
  getCodexPluginCacheRoot,
  inspectRun,
  issueActionToken,
  listJsonRecords,
  loadDefaults,
  loadRun,
  nowIso,
  pluginRoot,
  readJson,
  reconcileAction,
  rebindSourceBinding,
  routeMode,
  registerOwnedResource,
  safeJoin,
  setRunStatus,
  sha256,
  updateState,
  validateContract,
  withRunLock
} from "./lib/core.mjs";
import { captureSentinel, captureSourceBinding, compareSentinels, runSourceGit } from "./lib/git.mjs";
import {
  doctorAgy,
  doctorCodex,
  runAgyCritic,
  runCodexCritic,
  runCodexEvaluation,
  verifyTrustedCodexExecutionEnvelope,
  verifyTrustedNativeCriticAttestation
} from "./lib/providers.mjs";
import {
  buildEvaluationPrompt,
  calibrateEvaluatorMigration,
  compareEvaluatorMigration,
  compareHoldout,
  compareQualityRemediation,
  compareSafetyRemediation,
  evaluationBindingDigest,
  loadFrozenEvaluationSuite,
  loadMigrationTargetSuite,
  loadPolicyBoundEvaluationPolicy,
  readSanitizedBaselineMaterial,
  readSanitizedCandidateMaterial,
  redactedScore,
  resolveStrictBaselineRevision,
  scoreEvaluation,
  selectQualityRemediationCases,
  selectSafetyRemediationCases,
  selectEvaluatorMigrationCases,
  selectEvaluationCases,
  isPolicyBoundEvaluationPurpose,
  snapshotBaselineForCandidate,
  snapshotCandidate
} from "./lib/self-improve.mjs";
import {
  arbitrateDeliberation,
  deliberate,
  loadDeliberationRoster,
  probeDeliberationRoster
} from "./lib/deliberation.mjs";
import { deliberateForRun } from "./lib/deliberation-receipt.mjs";
import { loadEvidenceContracts } from "./lib/evidence.mjs";
import { generateAttestationRequests } from "./lib/attestations.mjs";
import { prepareStandingConsentInstall, standingConsentRevokeCommand } from "./lib/standing-consent.mjs";
import { hostBundleFromStatus } from "./lib/host-bundle.mjs";
import {
  autonomyProfileDigest,
  buildAutonomyBinding,
  loadAutonomyProfile,
  validateAutonomyBinding,
  decideAutonomyAction
} from "./lib/autonomy.mjs";
import {
  captureAutonomyBindingContext,
  captureAutonomyReadinessSnapshotFromSource,
  probeAutonomyGithubCredential,
  readBoundHostStatus
} from "./lib/autonomy-preflight.mjs";
import { createSelfImproveDeliveryHandoff, validateSelfImproveDeliveryHandoff } from "./lib/self-improve-handoff.mjs";
import {
  loadHostExecutionRequestManifest as loadBoundHostExecutionRequestManifest,
  verifySelfImproveDeliveryEvidence
} from "./lib/self-improve-replay.mjs";
import { compileLedger, deriveLedgerStatus, ledgerStatus, transitionLedger } from "./lib/ledger.mjs";
import {
  addReviewFinding,
  createReviewPackage,
  markBroadReviewComplete,
  prepareFindingVerification,
  prepareReviewAxis,
  recordFindingVerification,
  recordRepairRound,
  recordReviewAxis,
  recordReviewCoverage,
  recordReviewSynthesis,
  reviewPackageDigest,
  reviewKernelStatus,
  reviewStatus
} from "./lib/review.mjs";
import { reviewKernelEnabled, reviewPackageBindingRequired } from "./lib/review-policy.mjs";
import {
  QUORUM_EVIDENCE_KIND,
  QUORUM_POLICY_ID,
  buildQuorumEvidencePayload,
  changedPathsFromDiffManifest,
  reduceQuorum
} from "./lib/quorum.mjs";
import { recordRefinement, refinementStatus } from "./lib/refinement.mjs";
import {
  recipeArtifactPromote,
  recipeInit,
  recipeList,
  recipePromote,
  recipePrune,
  recipeRun,
  recipeScaffold,
  recipeStatus,
  recipeUntrust,
  recipeValidate
} from "./lib/recipes.mjs";
import {
  capabilitySnapshot,
  claimRouteReceipt,
  installPersonalRoutingProfile,
  markRouteReceiptUsed,
  pluginBundleDigest,
  previewRoute,
  recordRouteReceipt,
  showRoutingProfiles,
  validateRouteReceipt,
  validateRoutingProfileFile
} from "./lib/routing.mjs";
import {
  applyDelegatedSelfImproveContract,
  buildRunGraph,
  buildTemplateCatalogGraph,
  buildTemplateGraph,
  graphHasErrors,
  renderGraphMermaid
} from "./lib/graph.mjs";
import { openReplayBrowserWithRecovery, replayStartedEvent, startReplayServer } from "./lib/replay-server.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(pluginRoot(), "templates");
const HOST_TRUST_TOOL = path.join(SCRIPT_DIR, "host-trust.mjs");
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_MODE_RANK = new Map(
  ["direct", "verified", "deep", "critical"].map((mode, index) => [mode, index])
);
const GRAPH_ENFORCEMENT_ENABLED = true;

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printEvent(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function fail(error, code = 1) {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )}\n`
  );
  process.exitCode = code;
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    let key;
    let value;
    if (equal > 2) {
      key = token.slice(2, equal);
      value = token.slice(equal + 1);
    } else {
      key = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    if (Object.hasOwn(options, key)) {
      options[key] = Array.isArray(options[key])
        ? [...options[key], value]
        : [options[key], value];
    } else {
      options[key] = value;
    }
  }
  return { positional, options };
}

function values(value, fallback = []) {
  if (value === undefined) return fallback;
  return Array.isArray(value) ? value : [value];
}

function assertKnownOptions(options, allowed) {
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}`);
}

async function parseWorkflowInputOptions(options) {
  const inputs = Object.create(null);
  if (options["input-file"] !== undefined) {
    const inputFile = String(options["input-file"]);
    const parsed = JSON.parse(await readFile(path.resolve(inputFile), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Workflow dispatch input file must contain an object");
    }
    for (const key of Object.keys(parsed)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error(`Workflow dispatch input key is invalid: ${key}`);
      }
    }
    Object.assign(inputs, parsed);
  }
  for (const raw of values(options.input)) {
    const text = String(raw);
    const separator = text.indexOf("=");
    if (separator <= 0) throw new Error("Workflow dispatch --input values must use key=value");
    const key = text.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) ||
        ["__proto__", "constructor", "prototype"].includes(key)) {
      throw new Error(`Workflow dispatch input key is invalid: ${key}`);
    }
    if (Object.hasOwn(inputs, key)) throw new Error(`Workflow dispatch input is duplicated: ${key}`);
    inputs[key] = text.slice(separator + 1);
  }
  return inputs;
}

function strongestRunMode(...modes) {
  for (const mode of modes) {
    if (mode && mode !== "auto" && !RUN_MODE_RANK.has(mode)) {
      throw new Error(`Unknown mode: ${mode}`);
    }
  }
  const concrete = modes.filter((mode) => RUN_MODE_RANK.has(mode));
  if (concrete.length === 0) return "auto";
  return concrete.sort((left, right) => RUN_MODE_RANK.get(right) - RUN_MODE_RANK.get(left))[0];
}

function contextualReasoningEffort(mode, requested = "auto") {
  if (["medium", "high"].includes(requested)) return requested;
  if (requested !== "auto") throw new Error("reasoning effort must be auto, medium, or high");
  return ["direct", "verified"].includes(mode) ? "medium" : "high";
}

async function agyEffortTransportForModel(model) {
  const roster = await loadDeliberationRoster();
  for (const provider of roster.providers) {
    if (provider.command !== "agy") continue;
    const configured = provider.models.find((candidate) => candidate.model === model);
    if (configured) return configured.effortTransport ?? provider.effortTransport ?? "native";
  }
  return "native";
}

function integer(value, fallback = 0) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected integer, received: ${value}`);
  return parsed;
}

async function loadTemplate(name) {
  if (!SAFE_LABEL.test(name)) throw new Error(`Invalid template name: ${name}`);
  const target = path.join(TEMPLATE_DIR, `${name}.json`);
  return JSON.parse(await readFile(target, "utf8"));
}

async function listTemplates() {
  const files = (await readdir(TEMPLATE_DIR)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(files.map((name) => loadTemplate(name.slice(0, -5))));
}

function graphEnvelope(graph, format = "json") {
  return {
    ok: !graphHasErrors(graph),
    format,
    ...graph,
    ...(format === "mermaid" ? { content: renderGraphMermaid(graph) } : {})
  };
}

async function templateGraph(name) {
  const template = await loadTemplate(name);
  return buildTemplateGraph({
    template,
    sourcePath: `templates/${template.name}.json`
  });
}

async function runGraph(root, runId) {
  const run = await inspectRun(root, runId);
  const template = await loadTemplate(run.manifest.template);
  let ledger = null;
  if (run.contract.schemaVersion === 2) {
    const rawLedger = await readJson(root, safeJoin(run.runDir, "ledger.json"));
    try {
      const derived = await deriveLedgerStatus(root, runId);
      ledger = { tasks: rawLedger.tasks, taskStates: derived.taskStates };
    } catch (error) {
      ledger = { tasks: rawLedger.tasks, taskStates: [], invalid: true, error: error.message };
    }
  }
  return buildRunGraph({
    template,
    manifest: run.manifest,
    contract: run.contract,
    state: run.state,
    evidence: run.evidence,
    findings: run.findings,
    actions: run.actions,
    ledger
  });
}

async function installedTemplateGraph() {
  return buildTemplateCatalogGraph(await listTemplates());
}

function graphStructuralFailure(graph, operation) {
  return {
    ...graphEnvelope(graph),
    status: "graph-invalid",
    operation
  };
}

async function commandGraph(root, subcommand, positionalTarget, options) {
  if (positionalTarget) {
    throw new Error("graph targets must use --template or --run");
  }
  if (!["validate", "inspect"].includes(subcommand)) {
    throw new Error("graph subcommand must be validate or inspect");
  }
  assertKnownOptions(
    options,
    subcommand === "inspect" ? ["template", "run", "format"] : ["template", "run"]
  );
  const template = options.template ? String(options.template) : null;
  const run = options.run ? String(options.run) : null;
  if (template && run) {
    throw new Error("graph accepts exactly one of --template or --run");
  }
  if (subcommand === "inspect" && !template && !run) {
    throw new Error("graph inspect requires exactly one of --template or --run");
  }
  const format = String(options.format ?? "json");
  if (!["json", "mermaid"].includes(format)) {
    throw new Error("graph format must be json or mermaid");
  }
  const graph = template
    ? await templateGraph(template)
    : run
      ? await runGraph(root, run)
      : await installedTemplateGraph();
  return graphEnvelope(graph, format);
}

async function writeSentinel(root, runId, label, sentinel, suffix = "") {
  if (!SAFE_LABEL.test(label)) throw new Error(`Invalid sentinel label: ${label}`);
  const { runDir } = await loadRun(root, runId);
  const name = suffix ? `${label}.${suffix}.json` : `${label}.json`;
  await atomicWriteJson(root, safeJoin(runDir, "sentinels", name), sentinel);
  return safeJoin(runDir, "sentinels", name);
}

async function captureForRun(root, runId) {
  const defaults = await loadDefaults();
  const run = await loadRun(root, runId);
  return captureSentinel(run.manifest.cwd, run.contract, defaults);
}

function summarizeSentinel(sentinel, manifest) {
  const skippedReasons = {};
  for (const item of sentinel.skipped ?? []) {
    const reason = item.reason ?? "unspecified";
    skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
  }
  return {
    digest: sentinel.digest,
    complete: sentinel.complete,
    manifest,
    checkedAt: sentinel.checkedAt,
    counts: {
      tracked: sentinel.scopeDigest?.records?.length ?? 0,
      untracked: sentinel.untracked?.records?.length ?? 0,
      submodules: Array.isArray(sentinel.submodules?.value)
        ? sentinel.submodules.value.length
        : 0,
      symlinks: sentinel.symlinks?.records?.length ?? 0,
      attributes: sentinel.attributes?.records?.length ?? 0,
      highRiskIgnored: sentinel.highRiskIgnored?.records?.length ?? 0,
      skipped: sentinel.skipped?.length ?? 0
    },
    skippedReasons,
    uncertainty: sentinel.complete ? null : "bounded-sentinel-incomplete"
  };
}

async function captureCommand(root, runId, label) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Sentinel capture");
    const sentinel = await captureSentinel(run.manifest.cwd, run.contract, await loadDefaults());
    const target = await writeSentinel(root, runId, label, sentinel);
    const stateTarget = safeJoin(runDir, "state.json");
    const current = await readJson(root, stateTarget);
    assertMutableRun({ state: current }, "Sentinel capture");
    const next = {
      ...current,
      lastSentinel: { label, digest: sentinel.digest, path: target },
      lastSentinelVerified: true,
      lastSentinelComplete: sentinel.complete,
      updatedAt: nowIso()
    };
    await atomicWriteJson(root, stateTarget, next);
    await appendJournal(root, runDir, "sentinel.captured", { from: current.status, to: current.status });
    return { ok: true, runId, label, target, sentinel };
  });
}

async function verifyCommand(root, runId, label) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Sentinel verification");
    const baseline = await readJson(root, safeJoin(runDir, "sentinels", `${label}.json`));
    const current = await captureSentinel(run.manifest.cwd, run.contract, await loadDefaults());
    const comparison = compareSentinels(baseline, current);
    const stateTarget = safeJoin(runDir, "state.json");
    const state = await readJson(root, stateTarget);
    assertMutableRun({ state }, "Sentinel verification");
    if (!comparison.same) {
      const suffix = `after-${Date.now()}`;
      const target = await writeSentinel(root, runId, label, current, suffix);
      const next = {
        ...state,
        status: "indeterminate",
        lastSentinelVerified: false,
        lastSentinelComplete: false,
        sentinelDrift: { label, changed: comparison.changed, currentPath: target },
        updatedAt: nowIso()
      };
      await atomicWriteJson(root, stateTarget, next);
      await appendJournal(root, runDir, "sentinel.drift", { from: state.status, to: next.status });
      return {
        ok: false,
        runId,
        label,
        changed: comparison.changed,
        current: summarizeSentinel(current, target)
      };
    }
    const next = {
      ...state,
      status: state.status === "indeterminate" ? "running" : state.status,
      lastSentinel: { label, digest: current.digest },
      lastSentinelVerified: true,
      lastSentinelComplete: current.complete,
      sentinelDrift: null,
      updatedAt: nowIso()
    };
    await atomicWriteJson(root, stateTarget, next);
    await appendJournal(root, runDir, "sentinel.verified", { from: state.status, to: next.status });
    return {
      ok: true,
      runId,
      label,
      digest: current.digest,
      sentinel: summarizeSentinel(current, safeJoin(runDir, "sentinels", `${label}.json`))
    };
  });
}

async function fingerprintPath(cwd, candidate) {
  const absolute = path.resolve(cwd, candidate);
  const relative = path.relative(cwd, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Evidence dependency escapes workspace: ${candidate}`);
  }
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      return {
        path: relative || ".",
        type: "symlink",
        target: await readlink(absolute),
        mode: info.mode
      };
    }
    if (!info.isFile()) {
      return {
        path: relative || ".",
        type: info.isDirectory() ? "directory" : "other",
        mode: info.mode,
        mtimeMs: Math.trunc(info.mtimeMs)
      };
    }
    const contents = await readFile(absolute);
    return {
      path: relative || ".",
      type: "file",
      mode: info.mode,
      size: info.size,
      digest: sha256(contents)
    };
  } catch (error) {
    if (error.code === "ENOENT") return { path: relative || ".", type: "missing" };
    throw error;
  }
}

async function enrichEvidence(root, runId, record) {
  const run = await loadRun(root, runId);
  const definition = await evidenceDefinition(record);
  const sourceBindingRequired = definition?.freshnessBinding?.includes("sourceBindingDigest") === true;
  const sourceSentinelRequired = definition?.freshnessBinding?.includes("sourceSentinelDigest") === true;
  const inputFiles = values(record.dependencyInputs?.files);
  const files = [];
  for (const candidate of inputFiles) files.push(await fingerprintPath(run.manifest.cwd, candidate));
  if (sourceBindingRequired && !run.manifest.sourceBinding?.digest) {
    throw new Error(`Evidence ${record.kind} requires a source binding at creation time`);
  }
  const sourceBindingDigest = sourceBindingRequired ? run.manifest.sourceBinding?.digest ?? null : null;
  const sourceSentinelDigest = sourceSentinelRequired ? run.state.lastSentinel?.digest ?? null : null;
  return {
    ...record,
    ...(record.receipt
      ? {
          receipt: {
            ...record.receipt,
            inputBinding: {
              ...(record.receipt.inputBinding ?? {}),
              ...(sourceBindingDigest ? { sourceBindingDigest } : {}),
              ...(sourceSentinelDigest ? { sourceSentinelDigest } : {})
            }
          }
        }
      : {}),
    dependencies: {
      contractDigest: run.manifest.contractDigest,
      workflowVersion: VERSION,
      files,
      sourceBindingDigest,
      sourceSentinelDigest,
      policyDigest: digestObject({
        authority: run.contract.authority,
        sensitivity: run.contract.sensitivity,
        volatileExclusions: run.contract.volatileExclusions,
        highRiskIgnored: run.contract.highRiskIgnored
      }),
      promptDigest: record.dependencies?.promptDigest ?? null,
      model: record.dependencies?.model ?? null,
      reviewBinding: record.dependencies?.reviewBinding ?? null,
      remoteRevision: record.dependencies?.remoteRevision ?? run.contract.remoteRevision ?? null
    }
  };
}

async function refreshEvidence(root, runId) {
  return withRunLock(root, runId, async ({ runDir }) => {
    const run = await loadRun(root, runId);
    assertMutableRun(run, "Evidence freshness");
    const evidence = await listJsonRecords(root, safeJoin(runDir, "evidence"));
    const sourceBinding = run.manifest.sourceBinding
      ? await captureSourceBinding(run.manifest.cwd, {
          baseRevision: run.manifest.sourceBinding.baseRevision,
          requireClean: run.manifest.template === "self-improve-ops"
        })
      : null;
    const stale = [];
    const fresh = [];
    for (const record of evidence) {
      const definition = await evidenceDefinition(record);
      const sourceBindingRequired = definition?.freshnessBinding?.includes("sourceBindingDigest") === true;
      const sourceSentinelRequired = definition?.freshnessBinding?.includes("sourceSentinelDigest") === true;
      let current = [];
      let isStale =
        record.dependencies?.contractDigest !== run.manifest.contractDigest ||
        record.dependencies?.workflowVersion !== VERSION ||
        (sourceBindingRequired && (!run.manifest.sourceBinding || record.dependencies?.sourceBindingDigest !== sourceBinding?.digest));
      if (sourceSentinelRequired && (!run.manifest.sourceBinding || record.dependencies?.sourceSentinelDigest !== run.state.lastSentinel?.digest)) {
        isStale = true;
      }
      if (!Array.isArray(record.dependencyInputs?.files)) isStale = true;
      else {
        for (const candidate of record.dependencyInputs.files) {
          current.push(await fingerprintPath(run.manifest.cwd, candidate));
        }
        if (digestObject(current) !== digestObject(record.dependencies?.files ?? [])) isStale = true;
      }
      const next = {
        ...record,
        stale: isStale,
        freshnessCheckedAt: nowIso(),
        currentDependencyFiles: current
      };
      await atomicWriteJson(root, safeJoin(runDir, "evidence", `${record.id}.json`), next);
      (isStale ? stale : fresh).push(record.id);
    }
    return { stale, fresh };
  });
}

async function evidenceDefinition(record) {
  const contracts = await loadEvidenceContracts();
  const sourceKind = record?.sourceKind ?? record?.kind;
  const kind = sourceKind === "independent-critic" || sourceKind === "evaluation-migration"
    ? (sourceKind === "independent-critic" ? "patch-review" : "evaluation-suite")
    : sourceKind;
  return contracts[kind] ?? null;
}

async function currentVerifiedDigest(root, runId) {
  const run = await loadRun(root, runId);
  if (!run.state.lastSentinelVerified || !run.state.lastSentinel?.label) {
    throw new Error("A verified sentinel is required");
  }
  const verification = await verifyCommand(root, runId, run.state.lastSentinel.label);
  if (!verification.ok) throw new Error("Current tree no longer matches the verified sentinel");
  return verification.digest;
}

async function verifiedNativeReviewExecution({ root, runId, run, input, reviewDigest, reviewerId, attestationPath }) {
  const review = await reviewStatus(root, runId);
  if (!review.package || review.package.schemaVersion !== 2) {
    throw new Error("Native review-kernel execution requires a current v2 review package");
  }
  if (
    input.reviewerId !== reviewerId || !input.model || !input.executionId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(input.executionId))
  ) throw new Error("Native review-kernel input must bind reviewer, model, and executionId");
  const sentinelDigest = await currentVerifiedDigest(root, runId);
  const binding = {
    base: review.package.base,
    head: review.package.head,
    instructionDigest: review.package.instructionDigest,
    model: String(input.model),
    packageId: review.package.packageId,
    promptDigest: input.inputDigest,
    reviewDigest,
    reviewerId,
    executionId: input.executionId,
    runId,
    sentinelDigest
  };
  const attestation = await verifyTrustedNativeCriticAttestation({
    attestationPath,
    workspaceRoot: run.manifest.cwd,
    binding
  });
  const identity = {
    provider: "codex-native-subagent",
    model: attestation.model,
    executionId: input.executionId,
    modelAssurance: "host-signed-attestation",
    trustAttested: true,
    promptDigest: binding.promptDigest,
    reviewDigest: binding.reviewDigest,
    attestationDigest: attestation.attestationDigest,
    transport: "native-subagent",
    sandbox: "read-only"
  };
  return { ...identity, executionDigest: digestObject(identity) };
}

async function addReviewKernelEvidence(root, runId, kind, kernel) {
  const run = await loadRun(root, runId);
  const payload = kind === "work-unit-accounting"
    ? {
        result: true,
        packageId: kernel.packageId,
        repairRound: kernel.repairRound,
        workUniverseDigest: kernel.workUniverseDigest,
        reviewLanesDigest: kernel.reviewLanesDigest,
        axisSetDigest: kernel.axisSetDigest,
        coverageDigest: kernel.coverageDigest,
        items: kernel.coverage
      }
    : {
        result: true,
        packageId: kernel.packageId,
        repairRound: kernel.repairRound,
        workUniverseDigest: kernel.workUniverseDigest,
        axisSetDigest: kernel.axisSetDigest,
        verificationSetDigest: kernel.verificationSetDigest,
        coverageDigest: kernel.coverageDigest,
        findingSetDigest: kernel.findingSetDigest,
        convergenceDigest: kernel.convergenceDigest,
        items: kernel.findings
      };
  const digest = kind === "work-unit-accounting" ? kernel.coverageDigest : kernel.convergenceDigest;
  const id = `${kind}-${digest.slice(0, 32)}`;
  const prior = (await listJsonRecords(root, safeJoin(run.runDir, "evidence"))).find((item) => item.id === id);
  if (prior) return prior;
  const record = {
    schemaVersion: 2,
    id,
    kind,
    status: "complete",
    summary: kind === "work-unit-accounting"
      ? "Deterministic review work-unit coverage is complete."
      : "Deterministic review-kernel synthesis converged.",
    acceptanceIds: [],
    dependencyInputs: { files: [] },
    receipt: {
      contractId: `evidence-contracts-v1:${kind}`,
      contractVersion: 1,
      runId,
      producer: { provider: "better-workflows-kernel" },
      inputBinding: {
        runId,
        contractDigest: digestObject(run.contract),
        remoteRevision: run.contract.remoteRevision ?? null
      },
      payload,
      payloadDigest: digestObject(payload),
      producedAt: nowIso()
    }
  };
  return addEvidence(root, runId, await enrichEvidence(root, runId, record));
}

async function providerEvidence(root, runId, result, prompt, acceptanceIds) {
  const run = await loadRun(root, runId);
  let reviewBinding = null;
  if (reviewPackageBindingRequired(run.contract.controlPlane?.reviewPolicy)) {
    const review = await reviewStatus(root, runId);
    if (!review.package) throw new Error("Independent critic requires an immutable review package");
    reviewBinding = {
      packageId: review.package.packageId,
      base: review.package.base,
      head: review.package.head,
      scopeDigest: review.package.scopeDigest,
      diffManifestDigest: review.package.diffManifestDigest,
      instructionDigest: review.package.instructionDigest,
      sentinelDigest: review.package.sentinelDigest
    };
  }
  const providerExecution = {
    provider: result.metadata.provider,
    model: result.metadata.requestedModel,
    modelAssurance: result.metadata.modelAssurance ?? "requested-not-attested",
    trustAttested: result.metadata.trustAttested === true,
    promptDigest: sha256(prompt),
    reviewDigest: digestObject(result.review),
    transport: result.metadata.transport ?? "provider",
    sandbox: result.metadata.sandbox ?? "read-only",
    executionDigest: digestObject({
      provider: result.metadata.provider,
      model: result.metadata.requestedModel,
      modelAssurance: result.metadata.modelAssurance ?? "requested-not-attested",
      trustAttested: result.metadata.trustAttested === true,
      promptDigest: sha256(prompt),
      reviewDigest: digestObject(result.review),
      transport: result.metadata.transport ?? "provider",
      sandbox: result.metadata.sandbox ?? "read-only"
    })
  };
  const id = `critic-${result.metadata.provider}-${Date.now()}`;
  const record = {
    id,
    kind: "independent-critic",
    summary: `${result.metadata.provider} ${result.review.verdict}: ${result.review.summary}`,
    status: "complete",
    acceptanceIds,
    sourceDigest: sha256(prompt),
    dependencyInputs: { files: [] },
    dependencies: {
      promptDigest: sha256(prompt),
      model: result.metadata.requestedModel,
      ...(reviewBinding ? { reviewBinding } : {})
    },
    providerExecution,
    producer: result.metadata,
    review: result.review
  };
  return addEvidence(root, runId, await typedEvidenceRecord(root, runId, await enrichEvidence(root, runId, record)));
}

async function typedEvidenceRecord(root, runId, record) {
  const run = await loadRun(root, runId);
  if (run.contract.schemaVersion !== 2) return record;
  const contracts = await loadEvidenceContracts();
  const sourceKind = record.kind;
  const kind = sourceKind === "independent-critic" || sourceKind === "evaluation-migration"
    ? (sourceKind === "independent-critic" ? "patch-review" : "evaluation-suite")
    : sourceKind;
  const definition = contracts[kind];
  if (!definition) throw new Error(`No typed evidence contract for self-improve evidence kind: ${sourceKind}`);
  const rawProducer = record.producer?.provider ?? record.producer?.type ?? record.evaluation?.backend ?? "codex-root";
  const producer = definition.producerAllowlist.includes(rawProducer)
    ? { ...(record.producer ?? {}), provider: rawProducer }
    : { provider: "codex-root", sourceProvider: rawProducer };
  const evaluation = record.evaluation ?? {};
  let payload;
  if (definition.payloadFamily === "artifact-package") {
    const artifactDigest = sourceKind === "evaluation-migration"
      ? evaluation.calibration?.digest ?? evaluation.suiteDigest
      : evaluation.candidate?.digest ?? evaluation.suiteDigest ?? digestObject({ kind: sourceKind, id: record.id });
    payload = {
      artifact: {
        digest: artifactDigest,
        kind: sourceKind,
        purpose: evaluation.purpose ?? "ordinary"
      }
    };
  } else if (definition.payloadFamily === "review-analysis") {
    payload = {
      verdict: record.review?.verdict ?? (record.status === "complete" ? "pass" : "fail"),
      findingCount: Array.isArray(record.review?.findings) ? record.review.findings.length : 0
    };
  } else {
    payload = {
      command: `self-improve:${sourceKind}`,
      result: "complete"
    };
  }
  const payloadDigest = digestObject(payload);
  const { sourceDigest: _sourceDigest, acceptanceIds: _acceptanceIds, producer: _recordProducer, kind: _kind, ...rest } = record;
  const typed = {
    ...rest,
    kind,
    sourceKind,
    schemaVersion: 2,
    producer,
    sourceDigest: payloadDigest,
    receipt: {
      contractId: definition.id,
      contractVersion: 1,
      runId,
      producer,
      inputBinding: {
        runId,
        contractDigest: digestObject(run.contract),
        remoteRevision: run.contract.remoteRevision ?? null,
        ...(definition.freshnessBinding.includes("sourceBindingDigest")
          ? { sourceBindingDigest: run.manifest.sourceBinding?.digest ?? null }
          : {}),
        ...(definition.freshnessBinding.includes("sourceSentinelDigest")
          ? { sourceSentinelDigest: run.state.lastSentinel?.digest ?? null }
          : {})
      },
      payload,
      payloadDigest,
      producedAt: nowIso()
    }
  };
  return typed;
}

let selfImproveEvidenceSequence = 0;

function evaluationEvidenceId(kind) {
  selfImproveEvidenceSequence += 1;
  return `self-improve-${kind}-${Date.now()}-${selfImproveEvidenceSequence}`;
}

function assertExplicitCodexEvaluationAuthority(options) {
  if (!optionEnabled(options["allow-codex"]) || !optionEnabled(options.sanitized)) {
    throw new Error("Codex evaluation requires explicit --allow-codex and --sanitized authority");
  }
  if (!options.model) throw new Error("Codex evaluation requires --model bound by the trusted attestation");
  if (!options["trusted-codex-execution"]) {
    throw new Error("Codex evaluation requires a host-owned execution witness for every replay");
  }
}

async function evaluationReplay({ backend, fixture, role, cases, prompt, options, cwd, hostExecutionPath, execution, expectedRequestDigest = null, expectedRunAs = null }) {
  if (backend === "fixture") {
    const response = fixture?.[role];
    if (!response) throw new Error(`Fixture result file is missing ${role} response`);
    const score = scoreEvaluation({ ...response, results: response.results?.filter((item) => cases.some((entry) => entry.id === item.id)) }, cases);
    return { response, score, metadata: { provider: "fixture", trustAttested: false, sandbox: "deterministic-test" } };
  }
  const result = await runCodexEvaluation({
    model: String(options.model),
    prompt,
    hostExecutionPath,
    evaluationRoot: cwd,
    execution,
    expectedRequestDigest,
    expectedRunAs
  });
  return { response: result.response, score: scoreEvaluation(result.response, cases), metadata: result.metadata };
}

async function addSelfImproveEvidence(root, runId, record) {
  const enriched = await enrichEvidence(root, runId, record);
  return addEvidence(root, runId, await typedEvidenceRecord(root, runId, enriched));
}

function structuredReplay(replay) {
  return { score: redactedScore(replay.score), provider: replay.metadata.provider, trustAttested: replay.metadata.trustAttested === true,
    attestationDigest: replay.metadata.attestationDigest ?? null, binaryPath: replay.metadata.binary?.path ?? null, binaryDigest: replay.metadata.binary?.digest ?? null,
    attestationPath: replay.metadata.attestationPath ?? null, trustRootDigest: replay.metadata.trustRootDigest ?? null,
    issuer: replay.metadata.issuer ?? null, keyId: replay.metadata.keyId ?? null, expiresAt: replay.metadata.expiresAt ?? null,
    execution: replay.metadata.execution ?? null, model: replay.metadata.requestedModel ?? replay.metadata.model ?? null, sandbox: replay.metadata.sandbox,
    requestDigest: replay.metadata.requestDigest ?? null, runAs: replay.metadata.runAs ?? null,
    promptDigest: replay.metadata.promptDigest ?? null, responseDigest: replay.metadata.responseDigest ?? null,
    resultReceiptDigest: replay.metadata.resultReceiptDigest ?? null, resultReceiptPath: replay.metadata.resultReceiptPath ?? null,
    ledgerDigest: replay.metadata.ledgerDigest ?? null,
    hostExecutionPath: replay.metadata.hostExecutionPath ?? null, ledgerPath: replay.metadata.ledgerPath ?? null,
    startedAt: replay.metadata.startedAt ?? null, finishedAt: replay.metadata.finishedAt ?? null, response: replay.response ?? null };
}

async function commandSelfImprove(root, subcommand, options, nestedCommand = null) {
  const readHostStatus = () => readBoundHostStatus(HOST_TRUST_TOOL, process.cwd());
  if (subcommand === "host") {
    if (nestedCommand !== "status") {
      throw new Error("self-improve host subcommand must be status");
    }
    assertKnownOptions(options, []);
    return readHostStatus();
  }
  if (subcommand === "consent") {
    if (!new Set(["status", "prepare", "revoke"]).has(nestedCommand)) {
      throw new Error("self-improve consent subcommand must be status, prepare, or revoke");
    }
    assertKnownOptions(options, []);
    const hostStatus = await readHostStatus();
    if (nestedCommand === "status") return { ok: true, standingConsent: hostStatus.standingConsent ?? null };
    if (nestedCommand === "prepare") return prepareStandingConsentInstall({ repo: process.cwd(), hostStatus });
    return { ok: true, grantId: hostStatus.standingConsent?.grant?.grantId ?? null, administratorCommand: standingConsentRevokeCommand(hostStatus) };
  }
  if (subcommand === "attestation") {
    if (nestedCommand !== "request") {
      throw new Error("self-improve attestation subcommand must be request");
    }
    assertKnownOptions(options, [
      "run",
      "baseline",
      "candidate-root",
      "model",
      "output",
      "binary",
      "cases",
      "purpose",
      "next-cases"
    ]);
    for (const required of ["run", "baseline", "candidate-root", "model", "output"]) {
      if (!options[required]) throw new Error(`attestation request requires --${required}`);
    }
    const run = await loadRun(root, String(options.run));
    if (run.manifest.template !== "self-improve-ops") {
      throw new Error("attestation request requires a self-improve-ops run");
    }
    if (
      run.manifest.baselineRevision !== String(options.baseline) ||
      run.manifest.cwd !== path.resolve(process.cwd())
    ) {
      throw new Error("attestation request baseline or workspace does not match the run");
    }
    const runPurpose = run.contract.selfImprovePurpose ?? run.manifest.evaluationPurpose ?? "ordinary";
    const purpose = options.purpose === undefined ? runPurpose : String(options.purpose);
    if (run.contract.selfImprovePurpose && run.contract.selfImprovePurpose !== purpose) {
      throw new Error("Attestation purpose must match the immutable run creation purpose");
    }
    if (isPolicyBoundEvaluationPurpose(purpose) && run.contract.selfImprovePurpose !== purpose) {
      throw new Error(`${purpose} attestation requires a run created with --evaluation-purpose ${purpose}`);
    }
    return generateAttestationRequests({
      repo: process.cwd(),
      runId: String(options.run),
      baselineRevision: String(options.baseline),
      candidateRoot: String(options["candidate-root"]),
      model: String(options.model),
      outputDirectory: String(options.output),
      binaryPath: options.binary ? String(options.binary) : null,
      casesFile: options.cases ? String(options.cases) : null,
      purpose,
      nextCasesFile: options["next-cases"] ? String(options["next-cases"]) : null
    });
  }
  if (subcommand === "handoff") {
    if (!nestedCommand) throw new Error("self-improve handoff requires the target pr-to-dev run id");
    assertKnownOptions(options, ["source-run"]);
    if (!options["source-run"]) throw new Error("self-improve handoff requires --source-run");
    const record = await createSelfImproveDeliveryHandoff(
      root,
      String(nestedCommand),
      String(options["source-run"])
    );
    return { ok: true, runId: String(nestedCommand), evidence: await addEvidence(root, String(nestedCommand), record) };
  }
  if (subcommand !== "evaluate") {
    throw new Error("self-improve subcommand must be evaluate, host, consent, attestation, or handoff");
  }
  assertKnownOptions(options, [
    "run", "cases", "baseline", "candidate-root", "backend", "split", "result-file", "model", "allow-codex", "sanitized",
    "trusted-codex-execution", "request-manifest", "request-manifest-digest", "purpose", "next-cases"
  ]);
  if (!options.run || !options.cases || !options.baseline || !options["candidate-root"] || !options.backend || !options.split) {
    throw new Error("self-improve evaluate requires --run, --cases, --baseline, --candidate-root, --backend, and --split");
  }
  const runId = String(options.run);
  const run = await loadRun(root, runId);
  if (run.manifest.template !== "self-improve-ops") throw new Error("self-improve evaluation requires a self-improve-ops run");
  if (typeof run.manifest.baselineRevision !== "string" || !run.manifest.baselineRevision) {
    throw new Error("self-improve evaluation requires a run-start baseline revision");
  }
  const backend = String(options.backend);
  const split = String(options.split);
  const runPurpose = run.contract.selfImprovePurpose ?? run.manifest.evaluationPurpose ?? "ordinary";
  const purpose = options.purpose === undefined ? runPurpose : String(options.purpose);
  if (!["codex", "fixture"].includes(backend) || !["train", "holdout"].includes(split)) throw new Error("Invalid self-improve backend or split");
  if (!["ordinary", "evaluator-migration", "safety-remediation-v1", "quality-remediation-v1"].includes(purpose)) throw new Error("Invalid self-improve evaluation purpose");
  if (run.contract.selfImprovePurpose && run.contract.selfImprovePurpose !== purpose) {
    throw new Error("Evaluation purpose must match the immutable run creation purpose");
  }
  if (isPolicyBoundEvaluationPurpose(purpose) && run.contract.selfImprovePurpose !== purpose) {
    throw new Error(`${purpose} evaluation requires a run created with --evaluation-purpose ${purpose}`);
  }
  if (purpose === "evaluator-migration" && !options["next-cases"]) throw new Error("Evaluator migration requires --next-cases");
  if (backend === "fixture" && process.env.SBW_TEST_FIXTURE_BACKEND !== "1") {
    throw new Error("Fixture evaluation backend is test-only and requires SBW_TEST_FIXTURE_BACKEND=1");
  }
  if (backend === "codex") assertExplicitCodexEvaluationAuthority(options);
  if (backend === "fixture" && !options["result-file"]) throw new Error("Fixture evaluation requires --result-file");
  const cwd = run.manifest.cwd;
  const policyBound = isPolicyBoundEvaluationPurpose(purpose);
  const policy = policyBound ? await loadPolicyBoundEvaluationPolicy({ cwd, purpose }) : null;
  const evaluationBaseline = await resolveStrictBaselineRevision(cwd, String(options.baseline));
  if (evaluationBaseline !== run.manifest.baselineRevision) {
    throw new Error("Evaluation baseline must equal the immutable run-start baseline revision");
  }
  const frozen = await loadFrozenEvaluationSuite({
    cwd,
    casesFile: path.resolve(cwd, String(options.cases)),
    baselineRevision: evaluationBaseline,
    canonical: backend === "codex",
    purpose
  });
  if (frozen.baselineRevision !== evaluationBaseline) throw new Error("Evaluation baseline must equal the immutable run-start baseline revision");
  if (policy && frozen.sourceDigest !== policy.sourceSuiteDigest) {
    throw new Error(`${purpose} source suite digest is not the policy-bound immutable corpus`);
  }
  const currentSourceBinding = await captureSourceBinding(cwd, { baseRevision: run.manifest.baselineRevision, requireClean: true });
  if (!currentSourceBinding || currentSourceBinding.digest !== run.manifest.sourceBinding?.digest || currentSourceBinding.headRevision !== run.manifest.sourceBinding?.headRevision) {
    throw new Error("Self-improve evaluation requires the exact run-bound source revision");
  }
  const evaluatedPluginBundleDigest = await pluginBundleDigest();
  const candidate = await snapshotCandidate({ cwd, baselineRevision: frozen.baselineRevision, candidateRoot: String(options["candidate-root"]) });
  const baseline = await snapshotBaselineForCandidate({ cwd, snapshot: candidate });
  const candidateMaterial = await readSanitizedCandidateMaterial({ cwd, snapshot: candidate });
  const baselineMaterial = await readSanitizedBaselineMaterial({ cwd, snapshot: baseline });
  const target = purpose === "evaluator-migration"
    ? await loadMigrationTargetSuite({ cwd, casesFile: path.resolve(cwd, String(options["next-cases"])) })
    : null;
  const suiteDigest = evaluationBindingDigest({
    purpose,
    sourceSuiteDigest: frozen.sourceDigest,
    targetSuiteDigest: target?.sourceDigest,
    policyDigest: policy?.digest
  });
  const cases = purpose === "safety-remediation-v1"
    ? selectSafetyRemediationCases({ suite: frozen.suite, snapshot: candidate, split, policy })
    : purpose === "quality-remediation-v1"
      ? selectQualityRemediationCases({ suite: frozen.suite, snapshot: candidate, split, policy })
      : purpose === "evaluator-migration"
        ? selectEvaluatorMigrationCases({ suite: target.suite, split })
        : selectEvaluationCases({ suite: frozen.suite, snapshot: candidate, split });
  const calibration = target
    ? calibrateEvaluatorMigration({
      source: frozen.suite,
      target: target.suite,
      snapshot: candidate,
      materials: candidateMaterial,
      sourceDigest: frozen.sourceDigest,
      targetDigest: target.sourceDigest
    })
    : null;
  const evaluationSuite = target?.suite ?? frozen.suite;
  const candidatePrompt = buildEvaluationPrompt({ suite: { ...evaluationSuite, cases }, candidate, materials: candidateMaterial });
  const baselinePrompt = buildEvaluationPrompt({ suite: { ...evaluationSuite, cases }, candidate: baseline, materials: baselineMaterial });
  const fixture = backend === "fixture" ? JSON.parse(await readFile(path.resolve(cwd, String(options["result-file"])), "utf8")) : null;
  const requestBindings = backend === "codex"
    ? await loadBoundHostExecutionRequestManifest({
      manifestPath: options["request-manifest"],
      manifestDigest: options["request-manifest-digest"],
      cwd,
      run,
      runId,
      candidate,
      frozen,
      suiteDigest,
      purpose,
      target,
      model: String(options.model)
    })
    : null;
  const hostExecutionPaths = values(options["trusted-codex-execution"]).map(String);
  const requiredExecutions = backend === "codex"
    ? (split === "train" ? (purpose === "evaluator-migration" ? 2 : 1) : 6)
    : 0;
  if (backend === "codex" && hostExecutionPaths.length !== requiredExecutions) {
    throw new Error(`Codex ${split} evaluation requires exactly ${requiredExecutions} distinct host execution witness file(s)`);
  }
  if (backend === "codex" && new Set(hostExecutionPaths).size !== hostExecutionPaths.length) {
    throw new Error("Codex evaluation host execution witnesses must be distinct for every replay");
  }
  const dependencyFiles = [...new Set([
    frozen.relativePath,
    target?.relativePath,
    policy?.path,
    ...candidate.files.map((item) => item.path)
  ].filter(Boolean))].sort();
  const common = {
    sourceDigest: digestObject({ suite: suiteDigest, baseline: frozen.baselineRevision, candidate: candidate.digest }),
    dependencyInputs: { files: dependencyFiles },
    evaluation: {
      backend,
      split,
      purpose,
      suiteDigest,
      suitePath: frozen.relativePath,
      sourceSuiteDigest: frozen.sourceDigest,
      targetSuitePath: target?.relativePath ?? null,
      targetSuiteDigest: target?.sourceDigest ?? null,
      policyPath: policy?.path ?? null,
      policyId: policy?.policyId ?? null,
      policyVersion: policy?.version ?? null,
      policyDigest: policy?.digest ?? null,
      baselineRevision: frozen.baselineRevision,
      headRevision: backend === "codex" ? requestBindings?.headRevision ?? currentSourceBinding.headRevision : currentSourceBinding.headRevision,
      sourceBindingDigest: backend === "codex" ? requestBindings?.sourceBindingDigest ?? currentSourceBinding.digest : currentSourceBinding.digest,
      pluginBundleDigest: backend === "codex" ? requestBindings?.pluginBundleDigest ?? evaluatedPluginBundleDigest : evaluatedPluginBundleDigest,
      authorization: backend === "codex" ? requestBindings?.authorization ?? null : null,
      candidate,
      baseline,
      ...(backend === "codex"
        ? {
          requestManifestPath: path.resolve(String(options["request-manifest"])),
          requestManifestDigest: String(options["request-manifest-digest"])
        }
        : {})
    }
  };
  const execution = (role, attempt) => ({
    id: `${runId}-${split}-${role}-${attempt}`,
    runId,
    suiteDigest,
    baselineRevision: frozen.baselineRevision,
    candidateDigest: candidate.digest,
    headRevision: backend === "codex" ? requestBindings?.headRevision ?? currentSourceBinding.headRevision : currentSourceBinding.headRevision,
    promptDigest: sha256(role.endsWith("baseline") ? baselinePrompt : candidatePrompt),
    role,
    sourceBindingDigest: backend === "codex" ? requestBindings?.sourceBindingDigest ?? currentSourceBinding.digest : currentSourceBinding.digest,
    attempt,
    ...(backend === "codex" && requestBindings?.authorization
      ? { authorization: requestBindings.authorization }
      : {}),
    ...(policyBound ? { purpose, policyDigest: policy.digest } : {})
  });
  const prior = await listJsonRecords(root, safeJoin(run.runDir, "evidence"));
  if (split === "holdout") {
    const training = prior.find((item) => item.kind === "training-replay" && !item.stale && item.evaluation?.suiteDigest === suiteDigest && item.evaluation?.candidate?.digest === candidate.digest && item.evaluation?.baselineRevision === frozen.baselineRevision);
    if (!training) throw new Error("Holdout evaluation requires a fresh training replay bound to the same suite, baseline, and candidate");
    if (purpose === "evaluator-migration" && training.evaluation?.migrationTrainingComparison?.accepted !== true) {
      throw new Error("Evaluator migration holdout requires accepted target-only training headroom evidence");
    }
  }
  if (split === "train") {
    const trainExecution = execution("train-candidate", 1);
    const trainBinding = requestBindings?.get(trainExecution.id);
    if (backend === "codex" && !trainBinding) throw new Error("Training replay is missing its canonical request manifest binding");
    const replay = await evaluationReplay({ backend, fixture, role: "candidate", cases, prompt: candidatePrompt, options, cwd,
      hostExecutionPath: hostExecutionPaths[0], execution: trainExecution,
      expectedRequestDigest: trainBinding?.requestDigest ?? null,
      expectedRunAs: trainBinding?.runAs ?? null });
    let baselineReplay = null;
    let migrationTrainingComparison = null;
    if (purpose === "evaluator-migration") {
      const baselineExecution = execution("train-baseline", 1);
      const baselineBinding = requestBindings?.get(baselineExecution.id);
      if (backend === "codex" && !baselineBinding) throw new Error("Evaluator migration training baseline is missing its canonical request manifest binding");
      baselineReplay = await evaluationReplay({ backend, fixture, role: "baseline", cases, prompt: baselinePrompt, options, cwd,
        hostExecutionPath: hostExecutionPaths[1], execution: baselineExecution,
        expectedRequestDigest: baselineBinding?.requestDigest ?? null,
        expectedRunAs: baselineBinding?.runAs ?? null });
      migrationTrainingComparison = compareEvaluatorMigration({
        baseline: [baselineReplay.score],
        candidate: [replay.score],
        sourceSuite: frozen.suite,
        targetSuite: target.suite,
        split: "train"
      });
      if (migrationTrainingComparison.accepted !== true) {
        throw new Error(`Evaluator migration training did not demonstrate target-only headroom: ${migrationTrainingComparison.reason}`);
      }
    }
    if (policyBound && replay.score.hardSafetyPass !== true) {
      throw new Error(`${purpose} training replay failed its hard-safety gate`);
    }
    const suiteEvidence = await addSelfImproveEvidence(root, runId, {
      id: evaluationEvidenceId("suite"), kind: "evaluation-suite", summary: "Frozen sanitized evaluation suite bound to the immutable baseline.", status: "complete",
      acceptanceIds: ["replay-bounded"], ...common
    });
    const staging = await addSelfImproveEvidence(root, runId, {
      id: evaluationEvidenceId("staging"), kind: "candidate-staging", summary: "Candidate snapshot is explicitly staged against the immutable baseline.", status: "complete",
      acceptanceIds: ["candidate-staged"], ...common
    });
    const training = await addSelfImproveEvidence(root, runId, {
      id: evaluationEvidenceId("training"), kind: "training-replay", summary: "One bounded training replay completed; it cannot authorize delivery.", status: "complete",
      acceptanceIds: ["outcome-explicit", "replay-bounded"], ...common,
      evaluation: {
        ...common.evaluation,
        replays: [replay, baselineReplay].filter(Boolean).map(structuredReplay),
        ...(migrationTrainingComparison ? { migrationTrainingComparison } : {})
      }
    });
    const evidenceIds = [suiteEvidence.id, staging.id, training.id];
    if (calibration) {
      const migration = await addSelfImproveEvidence(root, runId, {
        id: evaluationEvidenceId("migration"),
        kind: "evaluation-migration",
        summary: "Versioned evaluator migration has deterministic class, sampling, and saturation-policy calibration.",
        status: "complete",
        acceptanceIds: ["replay-bounded", "candidate-staged", "validated"],
        ...common,
        evaluation: { ...common.evaluation, calibration }
      });
      evidenceIds.push(migration.id);
    }
    return {
      ok: true,
      runId,
      split,
      backend,
      purpose,
      evidence: evidenceIds,
      calibration,
      score: redactedScore(replay.score),
      ...(migrationTrainingComparison ? { migrationTrainingComparison } : {})
    };
  }
  const candidateReplays = [];
  const baselineReplays = [];
  for (let index = 0; index < 3; index += 1) {
    const candidateExecution = execution("candidate", index + 1);
    const candidateBinding = requestBindings?.get(candidateExecution.id);
    if (backend === "codex" && !candidateBinding) throw new Error("Candidate replay is missing its canonical request manifest binding");
    candidateReplays.push(await evaluationReplay({ backend, fixture, role: "candidate", cases, prompt: candidatePrompt, options, cwd,
      hostExecutionPath: hostExecutionPaths[index], execution: candidateExecution,
      expectedRequestDigest: candidateBinding?.requestDigest ?? null,
      expectedRunAs: candidateBinding?.runAs ?? null }));
  }
  for (let index = 0; index < 3; index += 1) {
    const baselineExecution = execution("baseline", index + 1);
    const baselineBinding = requestBindings?.get(baselineExecution.id);
    if (backend === "codex" && !baselineBinding) throw new Error("Baseline replay is missing its canonical request manifest binding");
    baselineReplays.push(await evaluationReplay({ backend, fixture, role: "baseline", cases, prompt: baselinePrompt, options, cwd,
      hostExecutionPath: hostExecutionPaths[index + 3], execution: baselineExecution,
      expectedRequestDigest: baselineBinding?.requestDigest ?? null,
      expectedRunAs: baselineBinding?.runAs ?? null }));
  }
  const comparison = purpose === "evaluator-migration"
    ? compareEvaluatorMigration({
      baseline: baselineReplays.map((item) => item.score),
      candidate: candidateReplays.map((item) => item.score),
      sourceSuite: frozen.suite,
      targetSuite: target.suite,
      split: "holdout"
    })
    : purpose === "safety-remediation-v1"
      ? compareSafetyRemediation({ baseline: baselineReplays.map((item) => item.score), candidate: candidateReplays.map((item) => item.score), suite: frozen.suite, policy })
      : purpose === "quality-remediation-v1"
        ? compareQualityRemediation({ baseline: baselineReplays.map((item) => item.score), candidate: candidateReplays.map((item) => item.score), suite: frozen.suite, policy })
      : compareHoldout({ baseline: baselineReplays.map((item) => item.score), candidate: candidateReplays.map((item) => item.score), suite: frozen.suite });
  const trusted = backend === "codex" && [...candidateReplays, ...baselineReplays].every((item) => item.metadata.trustAttested === true && item.metadata.provider === "codex");
  const evidence = await addSelfImproveEvidence(root, runId, {
    id: evaluationEvidenceId("holdout"), kind: "holdout-comparison", status: "complete",
    summary: comparison.accepted && trusted
      ? (purpose === "evaluator-migration"
        ? "Trusted legacy held-out comparison passed evaluator-migration safety non-regression gates."
        : isPolicyBoundEvaluationPurpose(purpose)
          ? `Trusted held-out comparison passed the versioned ${purpose} policy.`
          : "Trusted held-out comparison passed strict relevant-class improvement and safety gates.")
      : `Held-out comparison did not authorize adoption: ${comparison.reason}.`,
    acceptanceIds: comparison.accepted && trusted ? ["heldout-gated", "outcome-explicit", "validated"] : ["outcome-explicit"], ...common,
    evaluation: { ...common.evaluation, comparison, candidateReplays: candidateReplays.map(structuredReplay), baselineReplays: baselineReplays.map(structuredReplay) }
  });
  return { ok: true, runId, split, backend, comparison, evidence: [evidence.id] };
}

async function assertAcceptedSelfImproveHoldout(root, runId, action) {
  if (!["git.commit", "plugin.cache.publish", "git.push"].includes(action)) return;
  const run = await loadRun(root, runId);
  if (action === "plugin.cache.publish" && !run.contract.upstreamSelfImproveRunId) {
    throw new Error("Plugin cache publication requires a delegated self-improve delivery run");
  }
  if (run.manifest.template !== "self-improve-ops" && !run.contract.upstreamSelfImproveRunId) return;
  const sourceRunId = run.contract.upstreamSelfImproveRunId ?? runId;
  const sourceRun = sourceRunId === runId ? run : await loadRun(root, sourceRunId);
  const sourceEvidence = await listJsonRecords(root, safeJoin(sourceRun.runDir, "evidence"));
  await verifySelfImproveDeliveryEvidence({ root, runId: sourceRunId, run: sourceRun, evidence: sourceEvidence });
  if (run.contract.upstreamSelfImproveRunId) {
    const targetEvidence = await listJsonRecords(root, safeJoin(run.runDir, "evidence"));
    const handoff = targetEvidence.find((item) => item.kind === "self-improve-delivery-handoff" && item.status === "complete" && item.stale !== true);
    if (!handoff?.receipt?.payload) throw new Error("Delegated self-improve delivery action requires a fresh typed handoff receipt");
    await validateSelfImproveDeliveryHandoff(handoff.receipt.payload, { ...run, root });
  }
}

async function commandAutonomy(root, subcommand, runId, options) {
  if (!runId) throw new Error(`autonomy ${subcommand} requires <run-id>`);
  const run = await loadRun(root, runId);
  if (!run.contract.autonomyProfile) {
    throw new Error("Run does not have an explicitly selected autonomy profile");
  }
  validateAutonomyBinding(run.contract.autonomyProfile);
  const profile = await loadAutonomyProfile();
  const profileDigest = autonomyProfileDigest(profile);
  if (profileDigest !== run.contract.autonomyProfile.profileDigest) {
    throw new Error("Installed autonomy profile does not match the run binding");
  }
  if (subcommand === "preview") {
    assertKnownOptions(options, []);
  const examples = [
      { action: "git.commit" },
      { action: "plugin.cache.publish" },
      { action: "git.push", resource: "remote:origin:refs/heads/codex/example" },
      { action: "git.push", resource: "remote:origin:refs/heads/dev" },
      { action: "pr.create", scope: "dev" },
      { action: "pr.merge", resource: "pull/1" },
      { action: "worktree.cleanup", resource: "worktree:run-owned" },
      { action: "password.capture" },
      { action: "shell.unpinned" }
    ];
    return {
      ok: true,
      runId,
      profile: {
        id: profile.id,
        digest: profileDigest,
        expiresAt: run.contract.autonomyProfile.expiresAt,
        autoActions: profile.autoActions,
        humanActions: profile.humanActions,
        deniedActions: profile.deniedActions,
        limits: profile.limits
      },
      decisions: examples.map((item) => ({
        ...item,
        ...decideAutonomyAction(profile, item.action, item)
      }))
    };
  }
  if (subcommand === "revoke") {
    assertKnownOptions(options, []);
    return {
      ok: true,
      runId,
      state: await setRunStatus(root, runId, "blocked", {
        autonomy: {
          ...run.state.autonomy,
          profileId: profile.id,
          profileDigest,
          status: "revoked",
          snapshot: null,
          blockedReason: "autonomy-revoked",
          requiredAuthority: "autonomy.reauthorize",
          resumeFromStage: run.state.autonomy?.resumeFromStage ?? null
        }
      })
    };
  }
  if (subcommand !== "preflight") {
    throw new Error("autonomy subcommand must be preview, preflight, or revoke");
  }
  assertKnownOptions(options, []);
  const blocked = async (reason, requiredAuthority = "autonomy.preflight") => ({
    ok: false,
    runId,
    status: "blocked",
    blockedReason: reason,
    requiredAuthority,
    state: await setRunStatus(root, runId, "blocked", {
      autonomy: {
        ...run.state.autonomy,
        profileId: profile.id,
        profileDigest,
        status: "blocked",
        snapshot: null,
        blockedReason: reason,
        requiredAuthority,
        resumeFromStage: run.state.autonomy?.resumeFromStage ?? "preflight"
      }
    })
  });
  if (run.state.autonomy?.status === "revoked") return blocked("autonomy-revoked", "autonomy.reauthorize");
  if (Date.parse(run.contract.autonomyProfile.expiresAt) <= Date.now()) return blocked("autonomy-profile-expired", "autonomy.reauthorize");
  if (run.manifest.autonomyProfile?.sourceBindingDigest !== run.manifest.sourceBinding?.digest) return blocked("source-binding-drift", "source.rebind");
  if (!run.state.lastSentinelVerified || run.state.lastSentinelComplete !== true || !run.state.lastSentinel?.digest) {
    return blocked("sentinel-preflight-required", "sentinel.verify");
  }
  if (run.manifest.pluginCacheRoot !== getCodexPluginCacheRoot()) return blocked("cache-root-drift", "cache.rebind");
  let snapshot;
  try {
    snapshot = await captureAutonomyReadinessSnapshotFromSource(
      run.manifest.cwd,
      run.contract.autonomyProfile,
      run.manifest.autonomyProfile.sourceBindingDigest,
      { sentinelDigest: run.state.lastSentinel.digest }
    );
  } catch (error) {
    const reason = error.autonomyReason ?? "git-preflight-unavailable";
    const authority = ["branch-binding-drift", "repository-binding-drift"].includes(reason)
      ? "source.rebind"
      : reason === "git-preflight-unavailable"
        ? "git.authentication"
        : "autonomy.reauthorize";
    return blocked(reason, authority);
  }
  let hostStatus;
  try {
    hostStatus = await readBoundHostStatus(HOST_TRUST_TOOL, run.manifest.cwd);
  } catch {
    return blocked("host-status-unavailable", "host.bootstrap");
  }
  try {
    const hostBundle = hostBundleFromStatus(hostStatus);
    if (!hostStatus.ready || !hostStatus.signer?.supported || !hostStatus.runtime?.supported ||
        !hostStatus.readinessReceipt?.supported || hostStatus.readinessReceipt?.keyPairVerification?.verified !== true ||
        hostBundle.legacyCompatible === false || hostStatus.hostBundle?.supported === false) {
      return blocked("host-bundle-not-ready", "host.bootstrap");
    }
  } catch {
    return blocked("host-bundle-not-ready", "host.bootstrap");
  }
  let providerExecutable;
  try {
    providerExecutable = await currentProviderExecutableIdentity("gh");
    await probeAutonomyGithubCredential(run.manifest.cwd, providerExecutable.path);
  } catch {
    return blocked("provider-credential-unavailable", "github.authentication");
  }
  const state = await setRunStatus(root, runId, "running", {
    autonomy: {
      ...run.state.autonomy,
      profileId: profile.id,
      profileDigest,
      status: "ready",
      blockedReason: null,
      requiredAuthority: null,
      resumeFromStage: null,
      preflightAt: nowIso(),
      branch: snapshot.branch,
      repository: snapshot.repository,
      snapshot,
      providerExecutable
    }
  });
  return {
    ok: true,
    runId,
    status: "ready",
    profileId: profile.id,
    profileDigest,
    branch: snapshot.branch,
    snapshotDigest: snapshot.digest,
    hostBundle: {
      signerVersion: hostStatus.signer.version ?? null,
      signerDigest: hostStatus.signer.digest ?? null,
      runtimeDigest: hostStatus.runtime.digest ?? null
    },
    providerExecutable,
    state
  };
}

async function commandRun(root, options) {
  assertKnownOptions(options, [
    "template",
    "mode",
    "goal",
    "scope",
    "contract",
    "risk",
    "uncertainty",
    "blast-radius",
    "irreversibility",
    "evidence-gap",
    "sensitivity",
    "authority",
    "allow-agy",
    "sanitized",
    "require-agy",
    "volatile-exclusion",
    "high-risk-ignored",
    "remote-revision",
    "baseline",
    "evaluation-purpose",
    "self-improve-run",
    "route-receipt",
    "autonomy-profile"
  ]);
  let receiptBinding = null;
  if (options["route-receipt"]) {
    for (const conflicting of ["template", "entry", "goal", "scope", "mode", "self-improve-run", "autonomy-profile"]) {
      if (options[conflicting] !== undefined) {
        throw new Error(`--route-receipt cannot be combined with --${conflicting}`);
      }
    }
    receiptBinding = await validateRouteReceipt({
      stateRoot: root,
      cwd: process.cwd(),
      receiptId: String(options["route-receipt"])
    });
    if (!receiptBinding.preview.primary.template) {
      throw new Error("Route receipt does not resolve a concrete template");
    }
  }
  const templateName = receiptBinding
    ? receiptBinding.preview.primary.template
    : String(options.template ?? "");
  const template = await loadTemplate(templateName);
  const purposeProvided = options["evaluation-purpose"] !== undefined;
  const requestedEvaluationPurpose = purposeProvided ? String(options["evaluation-purpose"]) : null;
  if (requestedEvaluationPurpose !== null && !["ordinary", "evaluator-migration", "safety-remediation-v1", "quality-remediation-v1"].includes(requestedEvaluationPurpose)) {
    throw new Error("Invalid self-improve evaluation purpose");
  }
  if (templateName !== "self-improve-ops" && requestedEvaluationPurpose !== null && requestedEvaluationPurpose !== "ordinary") {
    throw new Error("--evaluation-purpose is only valid for self-improve-ops");
  }
  if (options.baseline !== undefined && templateName !== "self-improve-ops") {
    throw new Error("--baseline is only valid for a self-improve-ops run");
  }
  if (templateName === "self-improve-ops" && options.baseline === undefined) {
    throw new Error("self-improve-ops requires an explicit --baseline <full-commit-sha>");
  }
  let upstreamSelfImproveRun = null;
  if (options["self-improve-run"] !== undefined) {
    if (templateName !== "pr-to-dev") {
      throw new Error("--self-improve-run is only valid for a delegated pr-to-dev run");
    }
    upstreamSelfImproveRun = await loadRun(root, String(options["self-improve-run"]));
    if (upstreamSelfImproveRun.manifest.template !== "self-improve-ops") {
      throw new Error("--self-improve-run must identify a self-improve-ops run");
    }
    if (!upstreamSelfImproveRun.manifest.baselineRevision) {
      throw new Error("Delegated pr-to-dev requires a source self-improve baseline revision");
    }
  }
  if (GRAPH_ENFORCEMENT_ENABLED) {
    const graph = buildTemplateGraph({
      template,
      sourcePath: `templates/${template.name}.json`
    });
    if (graphHasErrors(graph)) return graphStructuralFailure(graph, "run.create");
  }
  let contract;
  let autonomyBinding = null;
  const selectedAutonomyProfile = options["autonomy-profile"] ?? receiptBinding?.preview?.autonomyProfile?.id ?? null;
  if (selectedAutonomyProfile !== null) {
    if (String(selectedAutonomyProfile) !== "bounded-autopilot-v1") {
      throw new Error("Only bounded-autopilot-v1 is currently supported");
    }
    if (options.contract) throw new Error("--autonomy-profile cannot be combined with --contract");
    const profile = await loadAutonomyProfile();
    const pathScope = receiptBinding
      ? receiptBinding.preview.input.scope
      : values(options.scope, ["."]).map(String);
    autonomyBinding = buildAutonomyBinding(profile, await captureAutonomyBindingContext(process.cwd(), pathScope));
    if (receiptBinding && receiptBinding.preview?.autonomyProfile?.digest !== autonomyBinding.profileDigest) {
      throw new Error("Route receipt autonomy profile digest does not match the installed immutable profile");
    }
    if (templateName !== "pr-to-dev") {
      throw new Error("bounded-autopilot-v1 is only valid for a delegated pr-to-dev delivery run");
    }
  }
  if (options.contract) {
    contract = validateContract(JSON.parse(await readFile(path.resolve(String(options.contract)), "utf8")));
    if (contract.autonomyProfile) {
      const profile = await loadAutonomyProfile();
      if (autonomyProfileDigest(profile) !== contract.autonomyProfile.profileDigest) {
        throw new Error("Supplied TaskContract autonomy profile is not the installed immutable profile");
      }
    }
    if (contract.template !== templateName) throw new Error("Contract template does not match --template");
    const contractPurpose = contract.selfImprovePurpose ?? "ordinary";
    if (purposeProvided && contractPurpose !== requestedEvaluationPurpose) {
      throw new Error("--evaluation-purpose must match the purpose already bound in the supplied contract");
    }
    const customEvidence = new Set(contract.requiredEvidence);
    const missingMinimums = (template.requiredEvidence ?? []).filter(
      (kind) => !customEvidence.has(kind)
    );
    if (missingMinimums.length > 0) {
      throw new Error(
        `TaskContract cannot remove template required evidence: ${missingMinimums.join(", ")}`
      );
    }
    if (template.controlPlane && Array.isArray(template.executionStages) && contract.schemaVersion !== 2) {
      throw new Error("v2 templates require a schemaVersion 2 TaskContract");
    }
    if (contract.schemaVersion === 2) {
      if (digestObject(contract.controlPlane) !== digestObject(template.controlPlane)) {
        throw new Error("TaskContract v2 cannot weaken template control-plane policy; it must preserve the complete installed identity");
      }
      const stageIdentity = (stages) => (stages ?? []).map((stage) => ({
        id: stage.id,
        dependsOn: [...(stage.dependsOn ?? [])],
        requiredEvidence: [...(stage.requiredEvidence ?? [])],
        attemptBudget: stage.attemptBudget,
        kind: stage.kind
      }));
      if (digestObject(stageIdentity(contract.executionStages)) !== digestObject(stageIdentity(template.executionStages))) {
        throw new Error("TaskContract v2 execution stages must preserve the installed template identity");
      }
      if (digestObject(contract.actionStages ?? {}) !== digestObject(template.actionStages ?? {})) {
        throw new Error("TaskContract v2 action stages must preserve the installed template identity");
      }
      const stageEvidence = new Set((template.executionStages ?? []).flatMap((stage) => stage.requiredEvidence ?? []));
      const missingStageEvidence = [...stageEvidence].filter((kind) => !customEvidence.has(kind));
      if (missingStageEvidence.length > 0) {
        throw new Error(`TaskContract cannot remove execution-stage evidence: ${missingStageEvidence.join(", ")}`);
      }
    }
  } else {
    contract = buildContract({
      template: templateName,
      templateDefinition: template,
      goal: receiptBinding
        ? receiptBinding.preview.input.goal
        : String(options.goal ?? `${templateName} workflow`),
      scope: receiptBinding
        ? receiptBinding.preview.input.scope
        : values(options.scope, ["."]).map(String),
      risk: {
        risk: integer(options.risk),
        uncertainty: integer(options.uncertainty),
        blastRadius: integer(options["blast-radius"]),
        irreversibility: integer(options.irreversibility),
        evidenceGap: integer(options["evidence-gap"])
      },
      sensitivity: String(options.sensitivity ?? "internal"),
      authority: values(options.authority).map(String),
      agyAllowed: options["allow-agy"] === true || options["allow-agy"] === "true",
      agySanitized: options.sanitized === true || options.sanitized === "true",
      volatileExclusions: values(options["volatile-exclusion"]).map(String),
      highRiskIgnored: values(options["high-risk-ignored"]).map(String),
      remoteRevision: options["remote-revision"] ? String(options["remote-revision"]) : null,
      selfImprovePurpose: templateName === "self-improve-ops" && purposeProvided ? requestedEvaluationPurpose : null,
      autonomyProfile: autonomyBinding
    });
    if (options["require-agy"] === true || options["require-agy"] === "true") {
      contract.agy.required = true;
    }
  }
  const currentTemplateDigest = digestObject(template);
  if (contract.templateDigest && contract.templateDigest !== currentTemplateDigest) {
    throw new Error("TaskContract template digest does not match the installed template");
  }
  contract.templateDigest = currentTemplateDigest;
  contract.actionGates = structuredClone(template.actionGates ?? {});
  if (template.actionStages) contract.actionStages = structuredClone(template.actionStages);
  else delete contract.actionStages;
  if (template.deferredActions) contract.deferredActions = structuredClone(template.deferredActions);
  else delete contract.deferredActions;
  if (upstreamSelfImproveRun && !contract.upstreamSelfImproveRunId) {
    contract = applyDelegatedSelfImproveContract(
      template,
      contract,
      String(options["self-improve-run"])
    );
  }
  const riskMode = routeMode(contract, "auto");
  const requestedMode = receiptBinding
    ? receiptBinding.preview.effectiveMode
    : strongestRunMode(
        template.defaultMode,
        riskMode,
        String(options.mode ?? "auto")
      );
  if (receiptBinding) {
    if (await pluginBundleDigest() !== receiptBinding.receipt.bindings.bundleDigest) {
      throw new Error("Plugin bundle drifted after route receipt validation");
    }
    await claimRouteReceipt({
      stateRoot: root,
      receiptId: receiptBinding.receipt.receiptId
    });
  }
  const baselineRevision = templateName === "self-improve-ops"
    ? await resolveStrictBaselineRevision(process.cwd(), String(options.baseline ?? ""))
    : upstreamSelfImproveRun?.manifest.baselineRevision ?? null;
  const result = await createRun({
    root,
    contract,
    requestedMode,
    cwd: process.cwd(),
    baselineRevision
  });
  if (receiptBinding) {
    await markRouteReceiptUsed({
      stateRoot: root,
      receiptId: receiptBinding.receipt.receiptId,
      runId: result.runId
    });
  }
  if (result.direct) {
    return {
      ok: true,
      ...result,
      routeReceipt: receiptBinding?.receipt.receiptId ?? null,
      instruction: "Direct mode: continue in the root without helper state or subagents."
    };
  }
  const initial = await captureCommand(root, result.runId, "initial");
  return {
    ok: true,
    ...result,
    routeReceipt: receiptBinding?.receipt.receiptId ?? null,
    sentinel: summarizeSentinel(initial.sentinel, initial.target)
  };
}

async function commandDoctor(root, options) {
  if (optionEnabled(options.capabilities)) {
    const snapshot = await capabilitySnapshot({
      cwd: process.cwd(),
      stateRoot: root,
      includeInventory: true
    });
    return {
      ok: snapshot.blockers.length === 0,
      version: VERSION,
      providerProbeStarted: false,
      ...snapshot
    };
  }
  await ensureStateRoot(root);
  const info = await stat(root);
  const defaults = await loadDefaults();
  const codex = await doctorCodex().catch((error) => ({ ok: false, error: error.message }));
  let agy = { ok: null, skipped: true };
  if (options.agy === true || options.agy === "true") {
    agy = await doctorAgy({
      model: String(options.model ?? defaults.providers.agy.primaryModel)
    }).catch((error) => ({ ok: false, error: error.message }));
  }
  return {
    ok: codex.ok && (agy.ok !== false),
    version: VERSION,
    stateRoot: root,
    stateMode: (info.mode & 0o777).toString(8),
    codex,
    agy,
    agyPolicy: {
      transport: defaults.providers.agy.transport,
      confidentialAllowed: false,
      maxPromptBytes: defaults.providers.agy.maxPromptBytes
    }
  };
}

function quorumExpectedBindings(run, reviewPackage = null) {
  const expected = {
    runId: run.manifest.runId,
    sourceBindingDigest: run.manifest.sourceBinding?.digest,
    sourceSentinelDigest: run.state.lastSentinel?.digest,
    contractDigest: digestObject(run.contract),
    templateDigest: run.contract.templateDigest
  };
  if (reviewPackage) {
    Object.assign(expected, {
      reviewPackageId: reviewPackage.packageId,
      reviewPackageDigest: reviewPackageDigest(reviewPackage),
      instructionDigest: reviewPackage.instructionDigest,
      base: reviewPackage.base,
      head: reviewPackage.head,
      mergeBase: reviewPackage.mergeBase,
      changedPaths: changedPathsFromDiffManifest(reviewPackage.diffManifest)
    });
  }
  return expected;
}

async function commandReviewQuorum(root, action, runId, options) {
  if (!runId) throw new Error("review quorum requires a run id");
  assertKnownOptions(options, ["file"]);
  const run = await loadRun(root, runId);
  if (action === "status") {
    const records = (await listJsonRecords(root, safeJoin(run.runDir, "evidence")))
      .filter((record) => record.kind === QUORUM_EVIDENCE_KIND)
      .map((record) => ({
        id: record.id,
        stale: record.stale === true,
        manifestDigest: record.receipt?.payload?.manifestDigest ?? null,
        verdict: record.receipt?.payload?.decision?.verdict ?? null,
        routing: record.receipt?.payload?.routing ?? null,
        blockers: record.receipt?.payload?.blockers ?? []
      }));
    return { ok: true, runId, policy: QUORUM_POLICY_ID, records };
  }
  if (!["run", "verify"].includes(action) || !options.file) {
    throw new Error("review quorum usage: sbw review quorum run|verify|status <run-id> [--file <manifest.json>]");
  }
  if (!run.state.lastSentinelVerified || !run.state.lastSentinelComplete) {
    throw new Error("Quorum verification requires a verified complete current sentinel");
  }
  const manifest = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
  const review = await reviewStatus(root, runId);
  if (!review.package) throw new Error("Quorum verification requires an immutable current review package");
  const result = reduceQuorum(manifest, {
    registryCwd: run.manifest.cwd,
    expected: quorumExpectedBindings(run, review.package)
  });
  const report = {
    schemaVersion: 1,
    policyId: QUORUM_POLICY_ID,
    runId,
    manifestDigest: result.manifestDigest,
    verdict: result.verdict,
    routing: result.routing,
    roleStatuses: result.roleStatuses,
    blockers: result.blockers,
    dissent: result.dissent,
    hostSignerInvoked: false
  };
  if (action === "verify" || !result.ok) {
    return { ok: result.ok, runId, policy: QUORUM_POLICY_ID, result, report };
  }
  const payload = buildQuorumEvidencePayload(manifest, result);
  const id = `agent-review-quorum-${result.manifestDigest.slice(0, 32)}`;
  const record = {
    schemaVersion: 2,
    id,
    kind: QUORUM_EVIDENCE_KIND,
    status: "complete",
    summary: "Five-role agent review quorum passed for the exact ordinary-PR review package.",
    acceptanceIds: run.contract.acceptance.map((item) => item.id),
    dependencyInputs: { files: [] },
    receipt: {
      contractId: `evidence-contracts-v1:${QUORUM_EVIDENCE_KIND}`,
      contractVersion: 1,
      runId,
      producer: { provider: "quorum-verifier", policyId: QUORUM_POLICY_ID },
      inputBinding: {
        runId,
        contractDigest: digestObject(run.contract),
        remoteRevision: run.contract.remoteRevision ?? null,
        sourceBindingDigest: run.manifest.sourceBinding?.digest ?? null,
        sourceSentinelDigest: run.state.lastSentinel?.digest ?? null
      },
      payload,
      payloadDigest: digestObject(payload),
      producedAt: nowIso()
    }
  };
  return {
    ok: true,
    runId,
    policy: QUORUM_POLICY_ID,
    result,
    report,
    evidence: await addEvidence(root, runId, await enrichEvidence(root, runId, record))
  };
}

async function commandRoute(root, subcommand, action, options) {
  if (subcommand === "preview") {
    assertKnownOptions(options, [
      "goal",
      "scope",
      "entry",
      "template",
      "mode",
      "domain",
      "tag",
      "record",
      "autonomy-profile"
    ]);
    const preview = await previewRoute({
      cwd: process.cwd(),
      stateRoot: root,
      goal: String(options.goal ?? ""),
      scope: values(options.scope, ["."]).map(String),
      entry: options.entry ? String(options.entry) : null,
      template: options.template ? String(options.template) : null,
      mode: String(options.mode ?? "auto"),
      domains: values(options.domain).map(String),
      tags: values(options.tag).map(String),
      autonomyProfile: options["autonomy-profile"] ? String(options["autonomy-profile"]) : null
    });
    if (optionEnabled(options.record)) {
      const receipt = await recordRouteReceipt({
        stateRoot: root,
        cwd: process.cwd(),
        preview
      });
      return { ...preview, receipt: { id: receipt.receiptId, path: receipt.path } };
    }
    return preview;
  }
  if (subcommand === "profile") {
    if (action === "show") {
      assertKnownOptions(options, []);
      return { ok: true, ...(await showRoutingProfiles({ cwd: process.cwd(), stateRoot: root })) };
    }
    if (action === "validate") {
      assertKnownOptions(options, ["file"]);
      return {
        ok: true,
        ...(await validateRoutingProfileFile({
          cwd: process.cwd(),
          file: String(options.file ?? "")
        }))
      };
    }
    if (action === "install") {
      assertKnownOptions(options, ["file"]);
      return {
        ok: true,
        ...(await installPersonalRoutingProfile({
          cwd: process.cwd(),
          stateRoot: root,
          file: String(options.file ?? "")
        }))
      };
    }
    throw new Error("route profile subcommand must be validate, show, or install");
  }
  throw new Error("route subcommand must be preview or profile");
}

function optionEnabled(value) {
  return value === true || value === "true";
}

async function commandEvidenceReplay(root, runId, options) {
  assertKnownOptions(options, ["no-open"]);
  const noOpen = optionEnabled(options["no-open"]);
  const replay = await startReplayServer({ stateRoot: root, runId });
  let opened = false;
  if (!noOpen) {
    try {
      await openReplayBrowserWithRecovery(replay);
      opened = true;
    } catch (error) {
      printEvent({
        ok: false,
        event: "replay.browser-open-warning",
        error: ["REPLAY_BROWSER_OPEN_FAILED", "REPLAY_BROWSER_OPEN_TIMEOUT"].includes(error?.code)
          ? error.code
          : "REPLAY_BROWSER_OPEN_FAILED"
      }, process.stderr);
    }
  }
  printEvent(replayStartedEvent(replay, { opened, noOpen }));
  let onSigint;
  let onSigterm;
  try {
    await new Promise((resolve) => {
      onSigint = () => resolve();
      onSigterm = () => resolve();
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
    });
  } finally {
    if (onSigint) process.off("SIGINT", onSigint);
    if (onSigterm) process.off("SIGTERM", onSigterm);
    await replay.close();
  }
  printEvent({ ok: true, event: "replay.stopped", url: replay.cleanUrl });
}

async function commandDeliberation(root, subcommand, options) {
  const sharedOptions = ["provider", "allow-external-providers", "sanitized", "refresh", "reasoning-effort", "mode", "timeout-seconds"];
  assertKnownOptions(options, subcommand === "roster" ? sharedOptions : [...sharedOptions, "prompt-file", ...(subcommand === "deliberate" ? ["run"] : [])]);
  const providers = values(options.provider).map(String);
  const timeoutSeconds = options["timeout-seconds"] === undefined
    ? undefined
    : integer(options["timeout-seconds"]);
  const common = {
    providers,
    allowExternalProviders: optionEnabled(options["allow-external-providers"]),
    sanitized: optionEnabled(options.sanitized),
    refresh: optionEnabled(options.refresh),
    reasoningEffort: String(options["reasoning-effort"] ?? "auto"),
    mode: String(options.mode ?? "deep"),
    timeoutSeconds
  };
  if (subcommand === "roster") return probeDeliberationRoster(common);
  if (subcommand === "arbitrate") {
    if (!options["prompt-file"]) {
      throw new Error("deliberation arbitrate requires --prompt-file <sanitized-file>");
    }
    const prompt = await readFile(path.resolve(String(options["prompt-file"])), "utf8");
    const roster = await probeDeliberationRoster(common);
    const arbitration = await arbitrateDeliberation({
      ...common,
      prompt,
      activeParticipants: roster.activeParticipants
    });
    return { ...arbitration, roster };
  }
  if (subcommand === "deliberate") {
    if (!options["prompt-file"]) {
      throw new Error("deliberation deliberate requires --prompt-file <sanitized-file>");
    }
    const prompt = await readFile(path.resolve(String(options["prompt-file"])), "utf8");
    if (options.run) {
      return deliberateForRun({
        root,
        runId: String(options.run),
        prompt,
        allowExternalProviders: common.allowExternalProviders,
        sanitized: common.sanitized,
        refresh: common.refresh,
        reasoningEffort: common.reasoningEffort,
        mode: common.mode,
        timeoutSeconds: common.timeoutSeconds,
        providers: common.providers
      });
    }
    return deliberate({ ...common, prompt });
  }
  throw new Error("deliberation subcommand must be roster, deliberate, or arbitrate");
}

async function commandEval() {
  if (GRAPH_ENFORCEMENT_ENABLED) {
    const graph = await installedTemplateGraph();
    if (graphHasErrors(graph)) return graphStructuralFailure(graph, "eval");
  }
  const contracts = await loadEvidenceContracts({ refresh: true });
  const unknown = [];
  for (const template of await listTemplates()) {
    const kinds = [
      ...(template.requiredEvidence ?? []),
      ...(template.executionStages ?? []).flatMap((stage) => stage.requiredEvidence ?? []),
      ...Object.values(template.actionGates ?? {}).flat()
    ];
    for (const kind of kinds) if (!contracts[kind]) unknown.push(`${template.name}:${kind}`);
  }
  if (unknown.length > 0) throw new Error(`Installed template evidence mapping is incomplete: ${unknown.join(", ")}`);
  const tests = (await readdir(path.join(SCRIPT_DIR, "tests")))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => path.join(SCRIPT_DIR, "tests", name));
  if (tests.length === 0) throw new Error("No tests found");
  for (const testPath of tests) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--test", "--test-concurrency=1", testPath], {
        cwd: process.cwd(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else {
          const diagnostics = Buffer.concat([...stderr, ...stdout]).toString("utf8").trim();
          reject(new Error(`Test suite failed for ${path.basename(testPath)} with exit ${code}${diagnostics ? `: ${diagnostics}` : ""}`));
        }
      });
    });
  }
  return { ok: true, tests: tests.length };
}

function help() {
  return {
    usage: [
      "sbw run --template <name> --mode <auto|direct|verified|deep|critical> --goal <text> [--scope <path>] [--autonomy-profile bounded-autopilot-v1] [--baseline <git-revision> for self-improve] [--evaluation-purpose ordinary|evaluator-migration|safety-remediation-v1|quality-remediation-v1] [--self-improve-run <run-id> for delegated pr-to-dev]",
      "sbw run --route-receipt <route-receipt-id>",
      "sbw route preview --goal <text> [--scope <path>] [--entry <id>|--template <name>] [--mode <mode>] [--domain <name>] [--tag <name>] [--record]",
      "sbw route profile validate|install --file <profile.json>",
      "sbw route profile show",
      "sbw status <run-id>",
      "sbw inspect <run-id>",
      "sbw resume <run-id>",
      "sbw autonomy preview|preflight|revoke <run-id>",
      "sbw cancel <run-id> [--reason <text>]",
      "sbw source rebind <run-id> --reason <text>",
      "sbw sentinel capture|verify <run-id> --label <label>",
      "sbw evidence add <run-id> --file <json>",
      "sbw evidence replay [<run-id>] [--no-open]",
      "sbw self-improve evaluate --run <run-id> --cases <file> --baseline <git-revision> --candidate-root <path> --backend <codex|fixture> --split <train|holdout> [--trusted-codex-execution <host-file>] [--request-manifest <host-file> --request-manifest-digest <sha256>] [--purpose ordinary|evaluator-migration|safety-remediation-v1|quality-remediation-v1] [--next-cases <v2-file>]",
      "sbw self-improve host status",
      "sbw self-improve consent status|prepare|revoke",
    "sbw self-improve attestation request --run <run-id> --baseline <sha> --candidate-root <path> --model <model> --output <outside-repo-directory> [--binary <approved-native-codex>] [--cases <file>] [--purpose ordinary|evaluator-migration|safety-remediation-v1|quality-remediation-v1] [--next-cases <v2-file>]",
      "sbw self-improve handoff <pr-to-dev-run-id> --source-run <self-improve-run-id>",
      "sbw finding add|update <run-id> --file <json>",
      "sbw critic codex|agy <run-id> --model <model> --prompt-file <file> [--effort <auto|medium|high>] [--effort-transport <native|model-variant>]",
      "sbw critic native <run-id> --file <json> --reviewer-id <native-agent-id> --attestation <host-file>",
      "sbw deliberation roster [--mode <auto|direct|verified|deep|critical>] [--reasoning-effort <auto|medium|high>] [--refresh] [--provider <id>] [--allow-external-providers --sanitized]",
      "sbw deliberation deliberate --prompt-file <sanitized-file> [--run <run-id>] [--mode <auto|direct|verified|deep|critical>] [--reasoning-effort <auto|medium|high>] [--refresh] [--allow-external-providers --sanitized]",
      "sbw deliberation arbitrate --prompt-file <sanitized-file> [--mode <auto|direct|verified|deep|critical>] [--reasoning-effort <auto|medium|high>] [--allow-external-providers --sanitized]",
      "sbw graph validate [--template <name>|--run <run-id>]",
      "sbw graph inspect (--template <name>|--run <run-id>) [--format json|mermaid]",
      "sbw action issue <run-id> --action <kind> --provider <provider> --resource <id> --remote-revision <sha> [--scope <ref> --workflow-file <.github/workflows/file.yml> --input <key=value> ... --input-file <json>]",
      "sbw action consume|execute|reconcile <run-id> ...",
      "sbw resource register <run-id> --resource <id> --receipt <creation-receipt.json>",
      "sbw ledger status <run-id>",
      "sbw ledger transition <run-id> --file <event.json>",
      "sbw ledger compile <run-id> --design-packet <packet.json>",
      "sbw refinement status|apply <run-id> [--file <receipt.json>]",
      "sbw review package|finding|axis-digest|axis|verify-digest|verify|coverage|synthesize|status|repair|broad <run-id> ...",
      "sbw review quorum run|verify|status <run-id> [--file <manifest.json>]",
      "sbw recipe init",
      "sbw recipe scaffold <id>",
      "sbw recipe list",
      "sbw recipe validate <id>",
      "sbw recipe promote <id> --run <run-id> --attempt <attempt-id> --confirm-digest <sha256>",
      "sbw recipe run <id> --input-file <json> [--dry-run]",
      "sbw recipe status|untrust <id>",
      "sbw recipe artifact promote <receipt-id> --artifact <id> --to <relative-path>",
      "sbw recipe prune [--apply]",
      "sbw complete <run-id>",
      "sbw doctor [--agy --model <model>]",
      "sbw doctor --capabilities",
      "sbw eval",
      "sbw cleanup [--older-than-days 30] [--apply]",
      "sbw templates"
    ]
  };
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [command, subcommand, runId, fourth] = positional;
  const root = getStateRoot();
  if (!command || command === "help" || options.help) return help();
  if (command === "templates") return { ok: true, templates: await listTemplates() };
  if (command === "run") return commandRun(root, options);
  if (command === "autonomy") return commandAutonomy(root, subcommand, runId, options);
  if (command === "graph") return commandGraph(root, subcommand, runId, options);
  if (command === "self-improve") return commandSelfImprove(root, subcommand, options, runId);
  if (command === "route") return commandRoute(root, subcommand, runId, options);
  if (command === "deliberation") return commandDeliberation(root, subcommand, options);
  if (command === "recipe") {
    if (subcommand === "init") {
      assertKnownOptions(options, []);
      return recipeInit(process.cwd());
    }
    if (subcommand === "scaffold") {
      assertKnownOptions(options, []);
      if (!runId) throw new Error("recipe scaffold requires <id>");
      return recipeScaffold(process.cwd(), runId);
    }
    if (subcommand === "list") {
      assertKnownOptions(options, []);
      return recipeList(process.cwd());
    }
    if (subcommand === "validate") {
      assertKnownOptions(options, []);
      if (!runId) throw new Error("recipe validate requires <id>");
      return recipeValidate(process.cwd(), runId);
    }
    if (subcommand === "promote") {
      assertKnownOptions(options, ["run", "attempt", "confirm-digest"]);
      if (!runId) throw new Error("recipe promote requires <id>");
      return recipePromote(process.cwd(), runId, {
        run: options.run ? String(options.run) : null,
        attempt: options.attempt ? String(options.attempt) : null,
        confirmDigest: options["confirm-digest"] ? String(options["confirm-digest"]) : null
      });
    }
    if (subcommand === "run") {
      assertKnownOptions(options, ["input-file", "dry-run"]);
      if (!runId) throw new Error("recipe run requires <id>");
      return recipeRun(
        process.cwd(),
        runId,
        options["input-file"] ? String(options["input-file"]) : null,
        { dryRun: optionEnabled(options["dry-run"]) }
      );
    }
    if (subcommand === "status") {
      assertKnownOptions(options, []);
      if (!runId) throw new Error("recipe status requires <id>");
      return recipeStatus(process.cwd(), runId);
    }
    if (subcommand === "untrust") {
      assertKnownOptions(options, []);
      if (!runId) throw new Error("recipe untrust requires <id>");
      return recipeUntrust(process.cwd(), runId);
    }
    if (subcommand === "artifact" && runId === "promote") {
      assertKnownOptions(options, ["artifact", "to"]);
      if (!fourth) throw new Error("recipe artifact promote requires <receipt-id>");
      return recipeArtifactPromote(
        process.cwd(),
        fourth,
        options.artifact ? String(options.artifact) : null,
        options.to ? String(options.to) : null
      );
    }
    if (subcommand === "prune") {
      assertKnownOptions(options, ["apply"]);
      return recipePrune(process.cwd(), { apply: optionEnabled(options.apply) });
    }
    throw new Error(
      "recipe subcommand must be init, scaffold, list, validate, promote, run, status, untrust, artifact, or prune"
    );
  }
  if (command === "status") {
    const run = await loadRun(root, subcommand);
    return {
      ok: true,
      runId: subcommand,
      template: run.manifest.template,
      mode: run.manifest.mode,
      status: run.state.status,
      updatedAt: run.state.updatedAt,
      lastSentinelVerified: run.state.lastSentinelVerified,
      lastSentinelComplete: run.state.lastSentinelComplete === true
    };
  }
  if (command === "inspect") return { ok: true, ...(await inspectRun(root, subcommand)) };
  if (command === "cancel") {
    return {
      ok: true,
      state: await setRunStatus(root, subcommand, "cancelled_superseded", {
        cancellationReason: String(options.reason ?? "cancelled by root")
      })
    };
  }
  if (command === "source") {
    if (subcommand !== "rebind" || !runId || !options.reason) {
      throw new Error("source usage: sbw source rebind <run-id> --reason <text>");
    }
    return rebindSourceBinding(root, runId, String(options.reason));
  }
  if (command === "resume") {
    let run = await loadRun(root, subcommand);
    assertMutableRun(run, "Run resume");
    if (run.contract.autonomyProfile && run.state.autonomy?.status !== "ready") {
      const autonomy = await commandAutonomy(root, "preflight", subcommand, {});
      if (!autonomy.ok) return autonomy;
      run = await loadRun(root, subcommand);
    }
    let migration = { migrated: false };
    const template = await loadTemplate(run.manifest.template);
    const templateEvidence = template.requiredEvidence ?? [];
    const boundEvidence = new Set(run.contract.requiredEvidence ?? []);
    const reviewPolicy = run.contract.schemaVersion === 2
      ? run.contract.controlPlane?.reviewPolicy
      : "none";
    const reviewEnabled = run.contract.schemaVersion === 2 && reviewPolicy !== "none";
    const reviewProfileDrift = reviewEnabled
      ? !template.reviewProfile || !run.contract.reviewProfile ||
        digestObject(run.contract.reviewProfile) !== digestObject(template.reviewProfile)
      : run.contract.reviewProfile !== undefined;
    if (
      !run.contract.templateDigest ||
      !run.contract.actionGates ||
      run.contract.templateDigest !== digestObject(template) ||
      templateEvidence.some((kind) => !boundEvidence.has(kind)) ||
      reviewProfileDrift
    ) {
      migration = await bindLegacyRunTemplate(root, subcommand, {
        templateDigest: digestObject(template),
        actionGates: template.actionGates ?? {},
        requiredEvidence: templateEvidence,
        reviewProfile: template.reviewProfile
      });
      run = await loadRun(root, subcommand);
    }
    const freshness = await refreshEvidence(root, subcommand);
    if (GRAPH_ENFORCEMENT_ENABLED) {
      const graph = await runGraph(root, subcommand);
      if (graphHasErrors(graph)) {
        await setRunStatus(root, subcommand, "stale", {
          lastSentinelVerified: false,
          lastSentinelComplete: false,
          resumeFreshness: freshness
        });
        return {
          ...graphStructuralFailure(graph, "run.resume"),
          runId: subcommand,
          migration,
          freshness
        };
      }
    }
    const sentinel = await captureForRun(root, subcommand);
    const same = run.state.lastSentinel?.digest === sentinel.digest;
    const status = !migration.migrated && same && freshness.stale.length === 0
      ? "running"
      : "stale";
    await setRunStatus(root, subcommand, status, {
      lastSentinelVerified: !migration.migrated && same,
      lastSentinelComplete: !migration.migrated && same && sentinel.complete,
      resumeFreshness: freshness
    });
    return {
      ok: !migration.migrated && same && freshness.stale.length === 0,
      runId: subcommand,
      status,
      freshness,
      migration,
      currentDigest: sentinel.digest
    };
  }
  if (command === "sentinel") {
    if (!runId || !options.label) throw new Error("sentinel requires run id and --label");
    if (subcommand === "capture") {
      const captured = await captureCommand(root, runId, String(options.label));
      return {
        ok: true,
        runId: captured.runId,
        label: captured.label,
        sentinel: summarizeSentinel(captured.sentinel, captured.target)
      };
    }
    if (subcommand === "verify") return verifyCommand(root, runId, String(options.label));
    throw new Error("sentinel subcommand must be capture or verify");
  }
  if (command === "evidence") {
    if (subcommand === "replay") {
      return commandEvidenceReplay(root, runId, options);
    }
    if (subcommand !== "add" || !runId || !options.file) {
      throw new Error("evidence usage: sbw evidence add <run-id> --file <json> | sbw evidence replay [<run-id>] [--no-open]");
    }
    const record = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
    if (record.sourceKind === "independent-critic") {
      throw new Error("Independent critic evidence must be emitted by a provider boundary, not sbw evidence add");
    }
    return { ok: true, evidence: await addEvidence(root, runId, await enrichEvidence(root, runId, record)) };
  }
  if (command === "finding") {
    if (!["add", "update"].includes(subcommand) || !runId || !options.file) {
      throw new Error("finding usage: sbw finding add|update <run-id> --file <json>");
    }
    const record = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
    return {
      ok: true,
      finding: await addFinding(root, runId, record, { update: subcommand === "update" })
    };
  }
  if (command === "critic") {
    if (subcommand === "native") {
      if (!runId || !options.file || !options["reviewer-id"] || !options.attestation) {
        throw new Error("critic usage: sbw critic native <run-id> --file <json> --reviewer-id <native-agent-id> --attestation <host-file>");
      }
      const input = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
      const run = await loadRun(root, runId);
      if (reviewKernelEnabled(run.contract.controlPlane?.reviewPolicy)) {
        throw new Error("code-v2-pilot critics must use review axis or review verify with host-signed native attestation");
      }
      const review = await reviewStatus(root, runId);
      if (!review.package) throw new Error("Native critic requires an immutable review package");
      if (input.reviewerId !== String(options["reviewer-id"]) || !input.model || !input.review) {
        throw new Error("Native critic input must identify the reviewer, model, and review");
      }
      const sentinelDigest = await currentVerifiedDigest(root, runId);
      const binding = {
        base: review.package.base,
        head: review.package.head,
        instructionDigest: review.package.instructionDigest,
        model: String(input.model),
        packageId: review.package.packageId,
        promptDigest: review.package.instructionDigest,
        reviewDigest: digestObject(input.review),
        reviewerId: String(options["reviewer-id"]),
        runId,
        sentinelDigest
      };
      const attestation = await verifyTrustedNativeCriticAttestation({
        attestationPath: String(options.attestation),
        workspaceRoot: run.manifest.cwd,
        binding
      });
      const providerExecution = {
        provider: "codex-native-subagent",
        model: attestation.model,
        modelAssurance: "host-signed-attestation",
        trustAttested: true,
        promptDigest: binding.promptDigest,
        reviewDigest: binding.reviewDigest,
        transport: "native-subagent",
        sandbox: "read-only",
        executionDigest: digestObject({
          provider: "codex-native-subagent",
          model: attestation.model,
          modelAssurance: "host-signed-attestation",
          trustAttested: true,
          promptDigest: binding.promptDigest,
          reviewDigest: binding.reviewDigest,
          transport: "native-subagent",
          sandbox: "read-only"
        })
      };
      const payload = { verdict: input.review.verdict, findingCount: input.review.findings?.length ?? 0 };
      const record = {
        schemaVersion: 2,
        id: `critic-codex-native-subagent-${Date.now()}`,
        kind: "patch-review",
        sourceKind: "independent-critic",
        status: "complete",
        summary: `codex-native-subagent ${input.review.verdict}: ${input.review.summary}`,
        acceptanceIds: values(options.acceptance, run.contract.acceptance.map((item) => item.id)).map(String),
        dependencyInputs: { files: [] },
        dependencies: {
          promptDigest: binding.promptDigest,
          model: attestation.model,
          reviewBinding: {
            packageId: review.package.packageId,
            base: review.package.base,
            head: review.package.head,
            scopeDigest: review.package.scopeDigest,
            diffManifestDigest: review.package.diffManifestDigest,
            instructionDigest: review.package.instructionDigest,
            sentinelDigest
          },
          remoteRevision: run.contract.remoteRevision ?? null
        },
        providerExecution,
        nativeReviewer: { id: binding.reviewerId, attestationDigest: attestation.attestationDigest },
        review: input.review,
        receipt: {
          contractId: "evidence-contracts-v1:patch-review",
          contractVersion: 1,
          runId,
          producer: { provider: "codex-native-subagent", model: attestation.model, attestationDigest: attestation.attestationDigest },
          inputBinding: { runId, contractDigest: digestObject(run.contract), remoteRevision: run.contract.remoteRevision ?? null },
          payload,
          payloadDigest: digestObject(payload),
          producedAt: nowIso()
        }
      };
      return {
        ok: true,
        evidence: await addEvidence(root, runId, await enrichEvidence(root, runId, record))
      };
    }
    if (!["codex", "agy"].includes(subcommand) || !runId || !options["prompt-file"]) {
      throw new Error("critic usage: sbw critic codex|agy <run-id> --model <model> --prompt-file <file>");
    }
    const run = await loadRun(root, runId);
    if (reviewKernelEnabled(run.contract.controlPlane?.reviewPolicy)) {
      throw new Error("code-v2-pilot rejects unattested critic providers; use host-signed review axis or review verify");
    }
    const prompt = await readFile(path.resolve(String(options["prompt-file"])), "utf8");
    const acceptanceIds = values(options.acceptance, run.contract.acceptance.map((item) => item.id)).map(String);
    const defaults = await loadDefaults();
    const effort = contextualReasoningEffort(run.manifest.mode, String(options.effort ?? "auto"));
    try {
      if (subcommand === "codex" && !options.model) {
        throw new Error("Codex critic requires --model");
      }
      const result =
        subcommand === "codex"
          ? await runCodexCritic({
              model: String(options.model),
              effort,
              prompt
            })
          : await (async () => {
              const model = String(options.model ?? defaults.providers.agy.primaryModel);
              const effortTransport = String(
                options["effort-transport"] ?? await agyEffortTransportForModel(model)
              );
              return runAgyCritic({
                model,
                effort,
                effortTransport,
                prompt,
                contract: run.contract,
                config: defaults
              });
            })();
      const evidence = await providerEvidence(root, runId, result, prompt, acceptanceIds);
      return { ok: true, evidence, review: result.review, metadata: result.metadata };
    } catch (error) {
      if (subcommand === "agy" && run.manifest.mode === "critical") {
        await setRunStatus(root, runId, "blocked_external_reviewer", {
          externalReviewerError: error.message
        });
      }
      throw error;
    }
  }
  if (command === "action") {
    if (!runId) throw new Error("action requires run id");
    if (subcommand === "issue") {
      assertKnownOptions(options, [
        "action", "provider", "resource", "scope", "remote-revision", "ttl",
        "workflow-file", "input", "input-file"
      ]);
      const run = await loadRun(root, runId);
      const template = await loadTemplate(run.manifest.template);
      const boundEvidence = new Set(run.contract.requiredEvidence ?? []);
      if (
        !run.contract.templateDigest ||
        !run.contract.actionGates ||
        (template.requiredEvidence ?? []).some((kind) => !boundEvidence.has(kind))
      ) {
        throw new Error(`Legacy run is unbound; run sbw resume ${runId} before issuing actions`);
      }
      const action = String(options.action ?? "");
      const workflowOptionKeys = ["workflow-file", "input", "input-file"];
      if (action !== "actions.dispatch" && workflowOptionKeys.some((key) => options[key] !== undefined)) {
        throw new Error("Workflow dispatch options --workflow-file, --input, and --input-file are only valid for actions.dispatch");
      }
      assertActionIsNotDeferred(run.contract, action);
      const requiredEvidence = run.contract.actionGates?.[action];
      if (!Array.isArray(requiredEvidence) || requiredEvidence.length === 0) {
        throw new Error(`No pre-action evidence gate is defined for: ${action}`);
      }
      if (GRAPH_ENFORCEMENT_ENABLED) {
        const graph = await runGraph(root, runId);
        if (graphHasErrors(graph)) return graphStructuralFailure(graph, "action.issue");
      }
      await refreshEvidence(root, runId);
      if (run.contract.templateDigest !== digestObject(template)) {
        throw new Error("Workflow template drifted after run creation");
      }
      await assertAcceptedSelfImproveHoldout(root, runId, action);
      let digest;
      if (run.contract.schemaVersion === 2 && run.contract.controlPlane?.reviewPolicy !== "none") {
        digest = await currentVerifiedDigest(root, runId);
        const review = await reviewStatus(root, runId);
        const currentHead = (await runSourceGit(run.manifest.cwd, [
          "rev-parse", "--verify", "HEAD^{commit}"
        ])).stdout.trim();
        if (
          !review.complete ||
          review.package?.head !== currentHead ||
          review.package?.broadReview?.sentinelDigest !== digest
        ) {
          throw new Error("Action token denied until scoped and final broad review are closed");
        }
      } else {
        digest = await currentVerifiedDigest(root, runId);
      }
      const defaults = await loadDefaults();
      const dispatchInputs = action === "actions.dispatch"
        ? await parseWorkflowInputOptions(options)
        : undefined;
      return {
        ok: true,
        action: await issueActionToken(
          root,
          runId,
          {
            action,
            provider: String(options.provider ?? ""),
            resource: String(options.resource ?? ""),
            scope: options.scope ? String(options.scope) : undefined,
            remoteRevision: String(options["remote-revision"] ?? ""),
            ttlSeconds: options.ttl ? integer(options.ttl) : undefined,
            workflowFile: options["workflow-file"] ? String(options["workflow-file"]) : undefined,
            dispatchInputs,
            requiredEvidence
          },
          digest,
          defaults
        )
      };
    }
    if (subcommand === "consume") {
      if (!options.token) throw new Error("action consume requires --token");
      const digest = await currentVerifiedDigest(root, runId);
      return {
        ok: true,
        action: await consumeActionToken(root, runId, String(options.token), digest)
      };
    }
    if (subcommand === "execute") {
      if (!options.token) throw new Error("action execute requires --token");
      const digest = await currentVerifiedDigest(root, runId);
      return {
        ok: true,
        action: await executeActionToken(root, runId, String(options.token), digest)
      };
    }
    if (subcommand === "reconcile") {
      if (!options.attempt || !options.outcome) {
        throw new Error("action reconcile requires --attempt and --outcome");
      }
      return {
        ok: true,
        action: await reconcileAction(
          root,
          runId,
          String(options.attempt),
          String(options.outcome),
          options.receipt
            ? JSON.parse(await readFile(path.resolve(String(options.receipt)), "utf8"))
            : null
        )
      };
    }
    throw new Error("action subcommand must be issue, consume, execute, or reconcile");
  }
  if (command === "resource") {
    if (subcommand !== "register" || !runId) {
      throw new Error("resource usage: sbw resource register <run-id> --resource <id> --receipt <creation-receipt.json>");
    }
    assertKnownOptions(options, ["resource", "receipt"]);
    if (!options.resource || !options.receipt) {
      throw new Error("resource register requires --resource and --receipt");
    }
    const creationReceipt = JSON.parse(await readFile(path.resolve(String(options.receipt)), "utf8"));
    return {
      ok: true,
      resource: await registerOwnedResource(root, runId, {
        resource: String(options.resource),
        creationReceipt
      })
    };
  }
  if (command === "ledger") {
    if (!runId) throw new Error("ledger requires run id");
    if (subcommand === "status") return { ok: true, ledger: await ledgerStatus(root, runId) };
    if (subcommand === "transition") {
      if (!options.file) throw new Error("ledger transition requires --file <event.json>");
      const event = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
      return { ok: true, ledger: await transitionLedger(root, runId, event) };
    }
    if (subcommand === "compile") {
      if (!options["design-packet"]) throw new Error("ledger compile requires --design-packet <packet.json>");
      const packet = JSON.parse(await readFile(path.resolve(String(options["design-packet"])), "utf8"));
      return { ok: true, ledger: await compileLedger(root, runId, packet) };
    }
    throw new Error("ledger subcommand must be status, transition, or compile");
  }
  if (command === "review" && subcommand === "quorum") {
    return commandReviewQuorum(root, runId, fourth, options);
  }
  if (command === "review") {
    if (!runId) throw new Error("review requires run id");
    if (["axis-digest", "verify-digest"].includes(subcommand)) {
      assertKnownOptions(options, ["file"]);
      if (!options.file) throw new Error(`review ${subcommand} requires --file <receipt.json>`);
      const input = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
      const prepared = subcommand === "axis-digest"
        ? await prepareReviewAxis(root, runId, input)
        : await prepareFindingVerification(root, runId, input);
      return { ok: true, prepared };
    }
    if (["axis", "verify"].includes(subcommand)) {
      assertKnownOptions(options, ["file", "reviewer-id", "attestation"]);
      if (!options.file || !options["reviewer-id"] || !options.attestation) {
        throw new Error(`review ${subcommand} requires --file, --reviewer-id, and --attestation`);
      }
      const input = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
      const run = await loadRun(root, runId);
      const prepared = subcommand === "axis"
        ? await prepareReviewAxis(root, runId, input)
        : await prepareFindingVerification(root, runId, input);
      const providerExecution = await verifiedNativeReviewExecution({
        root,
        runId,
        run,
        input,
        reviewDigest: prepared.reviewDigest,
        reviewerId: String(options["reviewer-id"]),
        attestationPath: String(options.attestation)
      });
      const record = subcommand === "axis"
        ? await recordReviewAxis(root, runId, { ...input, providerExecution })
        : await recordFindingVerification(root, runId, { ...input, providerExecution });
      return { ok: true, [subcommand]: record };
    }
    if (subcommand === "coverage") {
      assertKnownOptions(options, []);
      const coverage = await recordReviewCoverage(root, runId);
      const kernel = await reviewKernelStatus(root, runId);
      const evidence = coverage.complete
        ? await addReviewKernelEvidence(root, runId, "work-unit-accounting", kernel)
        : null;
      return { ok: coverage.complete, coverage, evidence };
    }
    if (subcommand === "synthesize") {
      assertKnownOptions(options, []);
      const synthesis = await recordReviewSynthesis(root, runId);
      const kernel = await reviewKernelStatus(root, runId);
      const evidence = synthesis.convergence.complete
        ? await addReviewKernelEvidence(root, runId, "review-kernel-summary", kernel)
        : null;
      return { ok: synthesis.convergence.complete, synthesis, evidence };
    }
    if (subcommand === "status") {
      const review = await reviewStatus(root, runId);
      return {
        ok: true,
        review: {
          package: review.package
            ? {
                packageId: review.package.packageId,
                base: review.package.base,
                head: review.package.head,
                repairRounds: review.package.repairRounds,
                broadReview: review.package.broadReview
              }
            : null,
          findings: review.findings.map((item) => ({
            id: item.id,
            packageId: item.packageId ?? review.package?.packageId,
            severity: item.severity,
            status: item.status ?? (item.blocking ? "open" : "rejected-with-evidence"),
            path: item.path,
            location: item.location ?? item.anchor?.resolvedLine ?? item.anchor?.reportedLine ?? null,
            rule: item.rule,
            verificationVerdict: item.verificationVerdict ?? null,
            blocking: item.blocking ?? item.status === "open"
          })),
          openHigh: review.openHigh.map((item) => item.id),
          repairBudgetExhausted: review.repairBudgetExhausted,
          scopedClosed: review.scopedClosed,
          kernel: review.kernel ? {
            workUniverseDigest: review.kernel.workUniverseDigest,
            axisSetDigest: review.kernel.axisSetDigest,
            verificationSetDigest: review.kernel.verificationSetDigest,
            coverageDigest: review.kernel.coverageDigest,
            findingSetDigest: review.kernel.findingSetDigest,
            convergence: review.kernel.convergence,
            convergenceDigest: review.kernel.convergenceDigest
          } : null,
          broadReviewComplete: review.broadReviewComplete,
          complete: review.complete
        }
      };
    }
    if (subcommand === "package") {
      if (!options.base || !options.head || !options["diff-manifest"] || !options["instruction-digest"] || !options["sentinel-digest"]) {
        throw new Error("review package requires --base, --head, --diff-manifest, --instruction-digest, and --sentinel-digest");
      }
      const diffManifest = JSON.parse(await readFile(path.resolve(String(options["diff-manifest"])), "utf8"));
      const reviewPackage = await createReviewPackage({
        root,
        runId,
        base: String(options.base),
        head: String(options.head),
        scope: values(options.scope, ["."]).map(String),
        diffManifest,
        instructionDigest: String(options["instruction-digest"]),
        sentinelDigest: String(options["sentinel-digest"])
      });
      return {
        ok: true,
        reviewPackage: {
          packageId: reviewPackage.packageId,
          base: reviewPackage.base,
          head: reviewPackage.head,
          scopeDigest: reviewPackage.scopeDigest,
          diffManifestDigest: reviewPackage.diffManifestDigest,
          ...(reviewPackage.schemaVersion === 2 ? {
            workUnitPolicy: reviewPackage.workUnitPolicy,
            workUniverse: reviewPackage.workUniverse,
            workUniverseDigest: reviewPackage.workUniverseDigest,
            reviewLanes: reviewPackage.reviewLanes,
            reviewLanesDigest: reviewPackage.reviewLanesDigest
          } : {}),
          repairRounds: reviewPackage.repairRounds,
          broadReview: reviewPackage.broadReview
        }
      };
    }
    if (subcommand === "finding") {
      assertKnownOptions(options, ["file", "update"]);
      if (!options.file) throw new Error("review finding requires --file <finding.json>");
      const finding = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
      return { ok: true, finding: await addReviewFinding(root, runId, finding, { update: optionEnabled(options.update) }) };
    }
    if (subcommand === "repair") {
      if (!options.package || !options.file) throw new Error("review repair requires --package and --file");
      const result = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
      return { ok: true, reviewPackage: await recordRepairRound(root, runId, String(options.package), result) };
    }
    if (subcommand === "broad") {
      if (!options.package || !options.head || !options["sentinel-digest"]) {
        throw new Error("review broad requires --package, --head, and --sentinel-digest");
      }
      return {
        ok: true,
        reviewPackage: await markBroadReviewComplete(
          root,
          runId,
          String(options.package),
          String(options.head),
          String(options["sentinel-digest"])
        )
      };
    }
    throw new Error("review subcommand must be package, finding, axis-digest, axis, verify-digest, verify, coverage, synthesize, status, repair, or broad");
  }
  if (command === "refinement") {
    if (!runId) throw new Error("refinement requires run id");
    if (subcommand === "status") {
      assertKnownOptions(options, []);
      return { ok: true, refinement: await refinementStatus(root, runId) };
    }
    if (subcommand === "apply") {
      assertKnownOptions(options, ["file"]);
      if (!options.file) throw new Error("refinement apply requires --file <receipt.json>");
      const input = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
      return { ok: true, refinement: await recordRefinement(root, runId, input) };
    }
    throw new Error("refinement subcommand must be status or apply");
  }
  if (command === "complete") {
    const run = await loadRun(root, subcommand);
    if (GRAPH_ENFORCEMENT_ENABLED) {
      const graph = await runGraph(root, subcommand);
      if (graphHasErrors(graph)) {
        return graphStructuralFailure(graph, "run.complete");
      }
    }
    if (!run.state.lastSentinel?.label) throw new Error("No sentinel is available for completion");
    const current = await verifyCommand(root, subcommand, run.state.lastSentinel.label);
    if (!current.ok) return { ok: false, status: "indeterminate", changed: current.changed };
    const result = await evaluateCompletion(root, subcommand);
    if (!result.ok) {
      await setRunStatus(root, subcommand, "inconclusive", { completionBlockers: result.blockers });
      return { ok: false, status: "inconclusive", blockers: result.blockers };
    }
    const completionDecision = {
      schemaVersion: 1,
      evaluatedAt: nowIso(),
      evidenceDigest: digestObject(result.evidence.map((item) => ({ id: item.id, kind: item.kind, sourceDigest: item.sourceDigest, stale: item.stale === true }))),
      ledgerDigest: run.contract.schemaVersion === 2
        ? digestObject(await readJson(root, safeJoin(run.runDir, "ledger.json")))
        : null,
      reviewDigest: run.contract.schemaVersion === 2 && run.contract.controlPlane?.reviewPolicy !== "none"
        ? digestObject(await reviewStatus(root, subcommand))
        : null,
      sentinelDigest: run.state.lastSentinel?.digest ?? null
    };
    return completeRun(root, subcommand, completionDecision);
  }
  if (command === "doctor") return commandDoctor(root, options);
  if (command === "eval") return commandEval();
  if (command === "cleanup") {
    const defaults = await loadDefaults();
    return cleanupRuns(root, {
      olderThanDays: integer(options["older-than-days"], defaults.retentionDays),
      apply: options.apply === true || options.apply === "true"
    });
  }
  throw new Error(`Unknown command: ${command}`);
}

main()
  .then((result) => {
    if (result !== undefined) print(result);
    if (result?.ok === false) process.exitCode = 2;
  })
  .catch((error) => fail(error, error?.exitCode ?? 1));
