#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSION,
  addEvidence,
  addFinding,
  appendJournal,
  atomicWriteJson,
  assertNoSymlinkUnder,
  assertActionIsNotDeferred,
  assertMutableRun,
  bindLegacyRunTemplate,
  buildContract,
  cleanupRuns,
  consumeActionToken,
  completeRun,
  canonicalJson,
  createRun,
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
  refreshEvidence,
  rebindSourceBinding,
  routeMode,
  registerOwnedResource,
  safeJoin,
  setRunStatus,
  sha256,
  supersedeEvidence,
  supersedeReviewEvidence,
  updateState,
  validateContract,
  withRunLock
} from "./lib/core.mjs";
import {
  assertSourceGitAncestryAuthority,
  canonicalSourceRoot,
  captureSentinel,
  captureSourceBinding,
  compareSentinels,
  parseOptionalSourceSymbolicRef,
  resolveRemoteBranchRevision,
  runSourceGit,
  hiddenIndexEntries
} from "./lib/git.mjs";
import { isExactGitAbsence } from "./lib/git-observation-v1.mjs";
import {
  doctorAgy,
  doctorCodex,
  runAgyCritic,
  runCodexCritic,
  verifyTrustedCodexExecutionEnvelope,
  verifyTrustedNativeCriticAttestation
} from "./lib/providers.mjs";
import {
  arbitrateDeliberation,
  deliberate,
  loadDeliberationRoster,
  probeDeliberationRoster
} from "./lib/deliberation.mjs";
import { loadEvidenceContracts } from "./lib/evidence.mjs";
import {
  digestApprovalEnvelope,
  validateApprovalEnvelope
} from "./lib/execution-admission-v1.mjs";
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
  recordDiffReviewFromNative,
  reviewKernelStatus,
  reviewStatus
} from "./lib/review.mjs";
import {
  completedReviewRequiredForAction,
  reviewKernelEnabled,
  reviewPackageBindingRequired
} from "./lib/review-policy.mjs";
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
  buildWorkflowPlanV1,
  persistWorkflowPlanV1,
  readFreshWorkflowPlanV1,
  readWorkflowPlanV1,
  routeBindingFromPreview,
  validateTaskContractV3,
  validateTaskContractV3Draft
} from "./lib/workflow-plan-v1.mjs";
import { createNativeV3VerificationConsumer } from "./lib/native-v3-verification-consumer-v1.mjs";
import { explainVerificationCliV1, runVerificationCliV1 } from "./lib/verification-cli-v1.mjs";
import {
  createNativeV3TrustPolicyReader,
  readInstalledNativeV3TrustPolicy
} from "./lib/native-v3-trust-policy.mjs";
import {
  createNativeV3InteractiveCliSingleCommandPlanRun,
  createNativeV3InteractiveCliPlanRun,
  NATIVE_V3_CLI_INTERACTIVE_KIND,
  NATIVE_V3_CLI_PLAN_INTERACTIVE_KIND,
  NATIVE_V3_CLI_MAX_ARTIFACT_BYTES
} from "./lib/native-v3-cli-boundary.mjs";
import { assertNativeV3AutoCommandExecutionAllowed } from "./lib/native-v3-auto-execution-admission.mjs";
import {
  assertNativeCommandBindingMatchesApprovalEnvelope,
  bindNativeCommandToApprovalEnvelope,
  createNativeCommandBinding,
  readFreshNativeCommandBinding
} from "./lib/native-command-binding-v1.mjs";
import {
  collectCooperativeNativeV3OwnerDecision,
  createCooperativeNativeV3RecoveryController,
  NATIVE_V3_RECOVERY_STORAGE_ALLOCATION,
  NATIVE_V3_RECOVERY_STORAGE_BASE,
  nativeV3AllocationKeyFor,
  prepareCooperativeNativeV3Approval
} from "./lib/native-v3-cooperative-controller.mjs";
import {
  createNativeV3CommandRunner,
  isNativeV3CommandAllocationUnclaimed,
  NATIVE_V3_COMMAND_RUNNER_TRUST_MODE
} from "./lib/native-v3-command-runner.mjs";
import {
  createNativeV3PlanRunner,
  createNativeV3PlanTaskAdapterFromCommandRunners,
  readNativeV3PlanRunnerCheckpoint
} from "./lib/native-v3-plan-runner.mjs";
import { OFFLINE_TRY_MAX_MS, runOfflineSbwTry } from "./lib/offline-try-v1.mjs";
import { withCanaryNativeV3StartV1 } from "./lib/canary-native-v3-start-v1.mjs";
import {
  recordCanaryNativeV3PlanTerminalV1
} from "./lib/canary-native-v3-terminal-v1.mjs";
import { runIncidentCli } from "./lib/incident-cli-v1.mjs";
import {
  incidentRecoveryEffectBindingDigestV1,
  validateIncidentRecoveryPlanV1
} from "./lib/incident-recovery-v1.mjs";
import { runKnowledgeCli } from "./lib/knowledge-cli-v1.mjs";
import { runShareCli } from "./lib/share-cli-v1.mjs";
import {
  WORKFLOW_CONTROL_DEFAULT_WAIT_MS,
  WORKFLOW_CONTROL_MAX_WAIT_MS,
  WORKFLOW_CONTROL_WATCH_KIND,
  readWorkflowControlObservation,
  requestWorkflowControl,
  saveWorkflowControlSnapshot,
  startWorkflowControlWatcher
} from "./lib/workflow-control-cli-v1.mjs";
import {
  buildInteractionAuthorizationReceipt,
  buildInteractionRequest,
  decideInteractionAuthorization
} from "./lib/interaction-authorization.mjs";
import {
  hostConformance,
  hostDoctor,
  hostList,
  normalizeHostOs,
  releaseConformanceMatrix
} from "./lib/hosts.mjs";
import {
  productReleaseConformanceMatrix,
  productReleaseScope
} from "./lib/product-release-scope-v1.mjs";
import {
  workspaceBeginDirect,
  workspaceCleanup,
  workspaceCreate,
  workspaceDirectCompletionNotice,
  workspaceIntegrate,
  workspacePreflight,
  readWorkspaceLease,
  workspaceReconcileProtected,
  workspaceRegister,
  workspaceRebindTarget,
  workspaceStatus,
  workspaceValidate
} from "./lib/workspace.mjs";
import {
  buildRunGraph,
  buildTemplateCatalogGraph,
  buildTemplateGraph,
  graphHasErrors,
  renderGraphMermaid
} from "./lib/graph.mjs";
import { openReplayBrowserWithRecovery, REPLAY_PORT, replayStartedEvent, startReplayServer } from "./lib/replay-server.mjs";
import { createFormalSuiteEnvironment, fixedToolPath, isEligibleFormalSuite, runFormalEvaluator } from "./lib/formal-evaluator.mjs";
import { runFullFormalEvaluation } from "./lib/formal-supervisor.mjs";
import { parseEvalInvocation, runEvalCommand } from "./lib/formal-cli-options.mjs";
import { runFormalSuites } from "./lib/formal-suite-runner.mjs";
import { formalProtectedCaptureClientV2 } from "./lib/formal-protected-capture-client-v2.mjs";
import { runNativeReview } from "./lib/native-review-runner.mjs";
import {
  createNativeReviewV2Plan,
  collectNativeReviewV2OwnerDecision,
  getNativeReviewV2Aggregate,
  getNativeReviewV2Progress,
  prepareNativeReviewV2,
  readNativeReviewV2JsonFile,
  replayNativeReviewV2,
  resumeNativeReviewV2,
  runNativeReviewV2
} from "./lib/native-review-cli-v2.mjs";
import { listRunMetrics, readRunMetrics, summarizeRunMetrics } from "./lib/metrics.mjs";
import { compareShadowReplay } from "./lib/shadow-replay.mjs";
import { campaignStatus, prepareCampaignRenewal, renewCampaign } from "./lib/campaign.mjs";
import { protectedDeliveryTarget } from "./lib/protected-delivery.mjs";
import { autoPolicyBinding, autoPolicyDefinition } from "./lib/auto-policy-v1.mjs";
import {
  captureRunningBundle,
  checkForUpdates,
  configureUpdateMode,
  readUpdateStatus
} from "./lib/update-notice.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(pluginRoot(), "templates");
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_MODE_RANK = new Map(
  ["direct", "verified", "deep", "critical"].map((mode, index) => [mode, index])
);
const GRAPH_ENFORCEMENT_ENABLED = true;
const UPDATE_CI_ENVIRONMENT_KEYS = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "BUILD_NUMBER",
  "RUN_ID",
  "GITHUB_ACTIONS",
  "GITHUB_RUN_ID",
  "GITLAB_CI",
  "CI_SERVER",
  "JENKINS_URL",
  "BUILDKITE",
  "CIRCLECI",
  "TRAVIS",
  "APPVEYOR",
  "TF_BUILD",
  "TEAMCITY_VERSION",
  "CODEBUILD_BUILD_ID",
  "BITBUCKET_BUILD_NUMBER",
  "DRONE",
  "CI_NAME",
  "GO_PIPELINE_LABEL",
  "NETLIFY",
  "VERCEL"
];

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
        error: error instanceof Error ? error.message : String(error),
        ...(error?.code === "EWORKFLOW_PUBLIC_AUTO_REQUIRED" && error?.status === "HOLD"
          ? { code: error.code, status: error.status }
          : {}),
        ...(error?.formalSuites ? { formalSuites: error.formalSuites } : {})
      },
      null,
      2
    )}\n`
  );
  process.exitCode = code;
}

// A value passed to an option may legitimately begin with `--` (for example
// the randomly generated action token used by `action consume`).  Treating
// every such token as another option silently converted that value to the
// boolean `true`, producing a different token hash and an apparently missing
// action record.  Keep the small set of valueless switches explicit so all
// other options consume their following argument verbatim.
const BOOLEAN_OPTIONS = new Set([
  "help",
  "refresh",
  "allow-codex",
  "allow-external-providers",
  "sanitized",
  "allow-agy",
  "require-agy",
  "dry-run",
  "apply",
  "update",
  "strict",
  "capabilities",
  "agy",
  "write-receipt",
  "no-open",
  "formal",
  "formal-child",
  "formal-full",
  "acceptance-defined",
  "protected-target",
  "json",
  "record"
]);

function parseArgs(argv) {
  const positional = [];
  const options = Object.create(null);
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
      if (next !== undefined && (!next.startsWith("--") || !BOOLEAN_OPTIONS.has(key))) {
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

function nativeCliOptionText(value, label, { required = false } = {}) {
  if (value === undefined) {
    if (required) throw new Error(`Native V3 CLI requires ${label}`);
    return undefined;
  }
  if (Array.isArray(value) || typeof value !== "string" || value.length === 0 ||
      value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Native V3 CLI ${label} is invalid`);
  }
  return value;
}

function canonicalSbwRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `sbw-${stamp}-${randomBytes(6).toString("hex")}`;
}

function nativeCliExecutionIdentity() {
  const runId = canonicalSbwRunId();
  return {
    runId,
    executionId: `${runId}-execution-1`,
    attemptId: `${runId}-attempt-1`
  };
}

function canaryStartReceiptFromEvent(event) {
  return {
    ledgerId: event.ledgerId,
    sequence: event.sequence,
    eventDigest: event.eventDigest,
    headDigest: event.eventDigest,
    eventCount: event.sequence,
    canaryAcceptance: "HOLD",
    releaseAuthority: "NONE"
  };
}

function sameNativeCliFileState(left, right) {
  return left && right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

async function assertNativeCliNoSymlinkPath(target) {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const component of path.relative(parsed.root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      const error = new Error(`Native V3 command binding path contains a symlink: ${current}`);
      error.code = "ENATIVE_COMMAND_BINDING_FS";
      throw error;
    }
  }
}

async function readNativeCliCommandBindingInput(filePath, { allowBound = false } = {}) {
  const target = path.resolve(filePath);
  if (!fsConstants.O_NOFOLLOW) {
    const error = new Error("Native V3 command binding input cannot be read without no-follow support");
    error.code = "ENATIVE_COMMAND_BINDING_FS";
    throw error;
  }
  let file;
  try {
    await assertNativeCliNoSymlinkPath(target);
    file = await lstat(target);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (file.mode & 0o077) !== 0) {
      const error = new Error("Native V3 command binding input must be a private regular file");
      error.code = "ENATIVE_COMMAND_BINDING_FS";
      throw error;
    }
    if (!Number.isSafeInteger(file.size) || file.size > NATIVE_V3_CLI_MAX_ARTIFACT_BYTES) {
      const error = new Error("Native V3 command binding input exceeds the fixed size limit");
      error.code = "ENATIVE_COMMAND_BINDING_FS";
      throw error;
    }
  } catch (error) {
    if (error?.code === "ENATIVE_COMMAND_BINDING_FS") throw error;
    const wrapped = new Error(`Native V3 command binding input is unavailable or unsafe: ${error?.message ?? String(error)}`);
    wrapped.code = "ENATIVE_COMMAND_BINDING_FS";
    throw wrapped;
  }

  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (before.isSymbolicLink?.() || !before.isFile() || before.nlink !== 1 ||
        !sameNativeCliFileState(file, before)) {
      const error = new Error("Native V3 command binding input changed before read");
      error.code = "ENATIVE_COMMAND_BINDING_DRIFT";
      throw error;
    }
    const buffer = Buffer.alloc(NATIVE_V3_CLI_MAX_ARTIFACT_BYTES + 1);
    let length = 0;
    while (length <= NATIVE_V3_CLI_MAX_ARTIFACT_BYTES) {
      const chunk = await handle.read(
        buffer,
        length,
        Math.min(64 * 1024, buffer.length - length),
        length
      );
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
      if (length > NATIVE_V3_CLI_MAX_ARTIFACT_BYTES) {
        const error = new Error("Native V3 command binding input exceeds the fixed size limit");
        error.code = "ENATIVE_COMMAND_BINDING_FS";
        throw error;
      }
    }
    const parsed = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    const after = await handle.stat();
    const afterPath = await lstat(target).catch(() => null);
    if (!afterPath || afterPath.isSymbolicLink() || !afterPath.isFile() || afterPath.nlink !== 1 ||
        !sameNativeCliFileState(file, afterPath) || !sameNativeCliFileState(before, after)) {
      const error = new Error("Native V3 command binding input changed during read");
      error.code = "ENATIVE_COMMAND_BINDING_DRIFT";
      throw error;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const error = new Error("Native V3 command binding input must contain an object");
      error.code = "ENATIVE_COMMAND_BINDING";
      throw error;
    }
    if (!allowBound && Object.hasOwn(parsed, "approvalEnvelopeDigest")) {
      const error = new Error("Native V3 command binding input must not carry an approvalEnvelopeDigest");
      error.code = "ENATIVE_COMMAND_BINDING";
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENATIVE_COMMAND_BINDING" ||
        error?.code === "ENATIVE_COMMAND_BINDING_DRIFT" ||
        error?.code === "ENATIVE_COMMAND_BINDING_FS") {
      throw error;
    }
    const wrapped = new Error(`Native V3 command binding input is invalid: ${error?.message ?? String(error)}`);
    wrapped.code = "ENATIVE_COMMAND_BINDING_FS";
    throw wrapped;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readNativeCliCommandBindingManifestInput(filePath) {
  const target = path.resolve(filePath);
  const parsed = await readNativeCliCommandBindingInput(target);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join("\0") !== "bindings\0kind\0schemaVersion" ||
      parsed.schemaVersion !== 1 || parsed.kind !== "NativeV3CommandBindingManifestV1" ||
      !Array.isArray(parsed.bindings) || parsed.bindings.length === 0 || parsed.bindings.length > 4096) {
    const error = new Error("Native V3 command binding manifest has an invalid bounded shape");
    error.code = "ENATIVE_COMMAND_BINDING_MANIFEST";
    throw error;
  }
  const manifestDirectory = path.dirname(target);
  const bindings = [];
  for (const [index, entry] of parsed.bindings.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      const error = new Error(`Native V3 command binding manifest entry ${index} is invalid`);
      error.code = "ENATIVE_COMMAND_BINDING_MANIFEST";
      throw error;
    }
    const keys = Object.keys(entry).sort();
    if (!keys.includes("bindingFile") || keys.some((key) => !["bindingFile", "requestedModel", "expiresAt"].includes(key))) {
      const error = new Error(`Native V3 command binding manifest entry ${index} has an unexpected shape`);
      error.code = "ENATIVE_COMMAND_BINDING_MANIFEST";
      throw error;
    }
    const bindingFile = nativeCliOptionText(entry.bindingFile, `manifest bindingFile[${index}]`, { required: true });
    const bindingPath = path.isAbsolute(bindingFile)
      ? bindingFile
      : path.resolve(manifestDirectory, bindingFile);
    const commandBinding = await readNativeCliCommandBindingInput(bindingPath);
    bindings.push({
      commandBinding,
      ...(entry.requestedModel === undefined ? {} : { requestedModel: nativeCliOptionText(entry.requestedModel, `manifest requestedModel[${index}]`) }),
      ...(entry.expiresAt === undefined ? {} : { expiresAt: nativeCliOptionText(entry.expiresAt, `manifest expiresAt[${index}]`) })
    });
  }
  return bindings;
}

// Recovery is an embedded CLI path, so its context must be rebuilt from the
// durable native allocation.  The JSON files below are only candidate indexes;
// the cooperative recovery-controller factory re-reads and validates the
// allocation, plan, source, policy, and authority before it is handed to the
// recovery core.  No caller-supplied controller, callback, or approval fields
// enter this path.
const INCIDENT_RECOVERY_STATE_DIRECTORY = "native-v3-cooperative-controller-v1";
const INCIDENT_RECOVERY_RUNTIME_DIRECTORY = "execution-runtime-v1";
const INCIDENT_RECOVERY_ALLOCATION_DIRECTORY = "allocations";
const INCIDENT_RECOVERY_ALLOCATION_KEY = /^alloc-[a-f0-9]{64}$/u;
const INCIDENT_RECOVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const INCIDENT_RECOVERY_DIGEST = /^[a-f0-9]{64}$/u;
const INCIDENT_RECOVERY_MAX_CANDIDATES = 256;
// Every bounded source read is a complete Git/authority capture, and each one
// owns its allowance outright.  A read must never inherit a deadline shortened
// by however long the earlier reads happened to take: the command runner keeps
// the bound it was built with and reuses it while launching, so a collapsed
// bound turns a real effect into an unresolved UNKNOWN outcome instead of a
// clean HOLD.  Controller rehydration pays for a cold full capture; each later
// step only re-reads an incremental snapshot.
const INCIDENT_RECOVERY_BASELINE_RESOLVER_MS = 4_000;
const INCIDENT_RECOVERY_STEP_RESOLVER_MS = 2_000;
// Non-capture work inside one context: plan reads, digests, private artifact
// writes and the owner decision.
const INCIDENT_RECOVERY_CONTEXT_OVERHEAD_MS = 2_000;
// `prepare` and `verify` rehydrate the controller and stop there.  `resume`
// additionally re-reads the source for the fresh approval, for the command
// runner it builds, and for that runner's own admission reads.
const INCIDENT_RECOVERY_RESUME_STEP_READS = 4;
const INCIDENT_RECOVERY_MAX_CONTEXT_MS =
  INCIDENT_RECOVERY_BASELINE_RESOLVER_MS + INCIDENT_RECOVERY_CONTEXT_OVERHEAD_MS;
const INCIDENT_RECOVERY_MAX_RESUME_CONTEXT_MS =
  INCIDENT_RECOVERY_MAX_CONTEXT_MS +
  (INCIDENT_RECOVERY_RESUME_STEP_READS * INCIDENT_RECOVERY_STEP_RESOLVER_MS);

function incidentRecoveryRawPathHasTraversal(value) {
  return value.split(/[\\/]+/u).some((part) => part === "..");
}

function incidentRecoveryCandidateId(value, label) {
  if (typeof value !== "string" || !INCIDENT_RECOVERY_ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function incidentRecoveryCandidateDigest(value, label) {
  if (typeof value !== "string" || !INCIDENT_RECOVERY_DIGEST.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function incidentRecoveryCandidateSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.revision !== "string" || !INCIDENT_RECOVERY_ID.test(value.revision) ||
      typeof value.digest !== "string" || !INCIDENT_RECOVERY_DIGEST.test(value.digest)) {
    return null;
  }
  return { revision: value.revision, digest: value.digest };
}

function incidentRecoverySafePlanPath(raw, cwd) {
  if (typeof raw !== "string" || raw.length === 0 || raw === "-" || raw.includes("\0") || incidentRecoveryRawPathHasTraversal(raw)) {
    return null;
  }
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
  if (resolved === path.parse(resolved).root) return null;
  return resolved;
}

async function readIncidentRecoveryPlanCandidate(filePath) {
  try {
    return await readNativeCliCommandBindingInput(filePath, { allowBound: true });
  } catch {
    return null;
  }
}

async function assertIncidentRecoveryTraversalSafe(stateRoot, target) {
  try {
    await assertNoSymlinkUnder(stateRoot, target);
  } catch (error) {
    const wrapped = new Error("incident recovery state path is unavailable");
    wrapped.code = error?.code === "ENOENT" ? "EINCIDENT_RECOVERY_NOT_FOUND" : "EINCIDENT_RECOVERY_FS";
    wrapped.status = "HOLD";
    wrapped.cause = error;
    throw wrapped;
  }
}

async function readIncidentRecoveryControllerCandidates(stateRoot, runId, deadline) {
  const allocationsRoot = path.join(
    stateRoot,
    INCIDENT_RECOVERY_STATE_DIRECTORY,
    "runs",
    runId,
    INCIDENT_RECOVERY_ALLOCATION_DIRECTORY
  );
  // Check every existing ancestor before opening the directory.  A later
  // regular-file check is too late when an attacker can replace an ancestor
  // with a symlink between directory enumeration and candidate validation.
  await assertIncidentRecoveryTraversalSafe(stateRoot, path.dirname(allocationsRoot));
  let entries;
  try {
    const info = await lstat(allocationsRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      const error = new Error("incident recovery allocation root is unsafe");
      error.code = "EINCIDENT_RECOVERY_FS";
      error.status = "HOLD";
      throw error;
    }
    await assertIncidentRecoveryTraversalSafe(stateRoot, allocationsRoot);
    entries = await readdir(allocationsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") entries = [];
    else if (error?.code === "EINCIDENT_RECOVERY_FS") throw error;
    else throw error;
  }
  if (entries.length > INCIDENT_RECOVERY_MAX_CANDIDATES) {
    throw new Error("too many native recovery allocations to inspect safely");
  }
  const candidates = [];
  for (const entry of entries) {
    if (Date.now() >= deadline) throw new Error("incident recovery context inspection exceeded its bounded deadline");
    if (!entry.isDirectory() || entry.isSymbolicLink() || !INCIDENT_RECOVERY_ALLOCATION_KEY.test(entry.name)) continue;
    const target = path.join(allocationsRoot, entry.name, "controller.json");
    await assertIncidentRecoveryTraversalSafe(stateRoot, path.dirname(target));
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0) continue;
    let state;
    try {
      state = await readJson(stateRoot, target);
    } catch {
      continue;
    }
    if (!state || typeof state !== "object" || Array.isArray(state) || state.status !== "active" ||
        state.allocationKey !== entry.name) continue;
    const sourceBinding = incidentRecoveryCandidateSource(state.sourceBinding);
    if (!sourceBinding) continue;
    try {
      candidates.push(Object.freeze({
        path: target,
        allocationKey: entry.name,
        recoveryStorage: NATIVE_V3_RECOVERY_STORAGE_ALLOCATION,
        planId: incidentRecoveryCandidateId(state.planId, "controller planId"),
        taskId: incidentRecoveryCandidateId(state.taskId, "controller taskId"),
        unitId: incidentRecoveryCandidateId(state.unitId, "controller unitId"),
        executionId: incidentRecoveryCandidateId(state.executionId, "controller executionId"),
        attemptId: incidentRecoveryCandidateId(state.attemptId, "controller attemptId"),
        ownedResourceId: incidentRecoveryCandidateId(state.ownedResourceId, "controller ownedResourceId"),
        sourceBinding,
        policyDigest: incidentRecoveryCandidateDigest(state.policyDigest, "controller policyDigest")
      }));
    } catch {
      // The allocation is only an index.  Invalid candidates are ignored and
      // can never be upgraded into a trusted recovery context.
    }
  }
  // The single-task interactive runner historically persisted its controller
  // at the run root instead of under an allocation directory.  Keep that
  // candidate explicitly scoped as base-single-task; resume may consume it
  // only through the controller's durable exact-successor claim and a fresh
  // task allocation.
  if (Date.now() >= deadline) throw new Error("incident recovery context inspection exceeded its bounded deadline");
  const baseTarget = path.join(
    stateRoot,
    INCIDENT_RECOVERY_STATE_DIRECTORY,
    "runs",
    runId,
    "controller.json"
  );
  await assertIncidentRecoveryTraversalSafe(stateRoot, path.dirname(baseTarget));
  try {
    const info = await lstat(baseTarget);
    if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o077) === 0) {
      const state = await readJson(stateRoot, baseTarget);
      if (state && typeof state === "object" && !Array.isArray(state) &&
          state.status === "active" && state.allocationKey === undefined) {
        const sourceBinding = incidentRecoveryCandidateSource(state.sourceBinding);
        if (sourceBinding) {
          try {
            candidates.push(Object.freeze({
              path: baseTarget,
              allocationKey: undefined,
              recoveryStorage: NATIVE_V3_RECOVERY_STORAGE_BASE,
              planId: incidentRecoveryCandidateId(state.planId, "base controller planId"),
              taskId: incidentRecoveryCandidateId(state.taskId, "base controller taskId"),
              unitId: incidentRecoveryCandidateId(state.unitId, "base controller unitId"),
              executionId: incidentRecoveryCandidateId(state.executionId, "base controller executionId"),
              attemptId: incidentRecoveryCandidateId(state.attemptId, "base controller attemptId"),
              ownedResourceId: incidentRecoveryCandidateId(state.ownedResourceId, "base controller ownedResourceId"),
              sourceBinding,
              policyDigest: incidentRecoveryCandidateDigest(state.policyDigest, "base controller policyDigest")
            }));
          } catch {
            // A malformed base state is only an untrusted index candidate.
          }
        }
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return candidates;
}

async function readIncidentRecoveryHandleCandidate(stateRoot, runId, handleId) {
  const target = path.join(stateRoot, INCIDENT_RECOVERY_RUNTIME_DIRECTORY, "runs", runId, "registry.json");
  // Reject an unsafe ancestor before readJson opens anything.  The later
  // regular-file checks cannot make a parent symlink safe after traversal.
  await assertIncidentRecoveryTraversalSafe(stateRoot, path.dirname(target));
  let state;
  try {
    state = await readJson(stateRoot, target);
  } catch {
    return null;
  }
  const handle = state?.handles?.[handleId];
  if (!handle || typeof handle !== "object" || Array.isArray(handle)) return null;
  const sourceBinding = handle.sourceBindingDigest;
  if (typeof sourceBinding !== "string" || !INCIDENT_RECOVERY_DIGEST.test(sourceBinding) ||
      typeof handle.policyDigest !== "string" || !INCIDENT_RECOVERY_DIGEST.test(handle.policyDigest)) return null;
  return Object.freeze({
    executionId: handle.executionId,
    attemptId: handle.attemptId,
    unitId: handle.unitId,
    revision: handle.revision,
    sourceBindingDigest: sourceBinding,
    policyDigest: handle.policyDigest,
    ownedResourceId: handle.ownedResourceId
  });
}

function incidentRecoveryTaskArtifactPath(root, runId, taskId, attemptId, fileName) {
  const prefix = `${taskId}.attempt.`;
  if (typeof attemptId !== "string" || !attemptId.startsWith(prefix)) return null;
  const attemptNumber = attemptId.slice(prefix.length);
  if (!/^[1-9][0-9]{0,5}$/u.test(attemptNumber)) return null;
  const taskKey = `task-${digestObject({ schemaVersion: 1, kind: "NativeV3CliTaskArtifactKeyV1", taskId })}`;
  return safeJoin(root, "native-v3-cli", "runs", runId, "tasks", taskKey, `attempt-${attemptNumber}`, fileName);
}

async function readIncidentRecoveryArtifactPair({ root, runId, bindingPath, approvalPath, workflowPlan, candidate, repositoryRoot }) {
  await assertIncidentRecoveryTraversalSafe(root, path.dirname(bindingPath));
  const bindingInfo = await lstat(bindingPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const approvalInfo = await lstat(approvalPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (bindingInfo === null || approvalInfo === null) return null;
  if (bindingInfo.isSymbolicLink() || approvalInfo.isSymbolicLink() ||
      !bindingInfo.isFile() || !approvalInfo.isFile() || bindingInfo.nlink !== 1 || approvalInfo.nlink !== 1 ||
      (bindingInfo.mode & 0o077) !== 0 || (approvalInfo.mode & 0o077) !== 0) {
    const error = new Error("incident recovery native artifacts are unsafe");
    error.code = "EINCIDENT_RECOVERY_ARTIFACT_FS";
    error.status = "HOLD";
    throw error;
  }
  const rawBinding = await readNativeCliCommandBindingInput(bindingPath, { allowBound: true });
  const rawEnvelope = await readNativeCliCommandBindingInput(approvalPath);
  const envelope = validateApprovalEnvelope(rawEnvelope);
  if (digestApprovalEnvelope(envelope) !== envelope.digest) {
    const error = new Error("incident recovery ApprovalEnvelope digest is stale");
    error.code = "EINCIDENT_RECOVERY_ARTIFACT_DRIFT";
    error.status = "HOLD";
    throw error;
  }
  const task = workflowPlan.taskContract.graph.tasks.find((item) => item.id === candidate.taskId);
  if (!task) {
    const error = new Error("incident recovery task is absent from the trusted WorkflowPlan");
    error.code = "EINCIDENT_RECOVERY_BINDING";
    error.status = "HOLD";
    throw error;
  }
  const binding = await readFreshNativeCommandBinding({
    root,
    target: bindingPath,
    expectedDigest: rawBinding.commandDigest,
    workspaceRoot: repositoryRoot,
    requirePrivate: true
  });
  assertNativeCommandBindingMatchesApprovalEnvelope(binding, envelope, { workspaceRoot: repositoryRoot });
  const checks = [
    ["binding.planDigest", binding.planDigest, workflowPlan.planDigest],
    ["binding.contractDigest", binding.contractDigest, workflowPlan.contractDigest],
    ["binding.taskId", binding.taskId, candidate.taskId],
    ["binding.unitId", binding.unitId, candidate.unitId],
    ["binding.sourceBindingDigest", binding.sourceBindingDigest, candidate.sourceBinding.digest],
    ["binding.policyDigest", binding.policyDigest, candidate.policyDigest],
    ["binding.revision", binding.revision, candidate.sourceBinding.revision],
    ["envelope.runId", envelope.runId, runId],
    ["envelope.executionId", envelope.executionId, candidate.executionId],
    ["envelope.attemptId", envelope.attemptId, candidate.attemptId],
    ["envelope.taskId", envelope.taskId, candidate.taskId],
    ["envelope.unitId", envelope.unitId, candidate.unitId],
    ["envelope.sourceBindingDigest", envelope.sourceBindingDigest, candidate.sourceBinding.digest],
    ["envelope.policyDigest", envelope.policyDigest, candidate.policyDigest],
    ["envelope.revision", envelope.revision, candidate.sourceBinding.revision]
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) {
      const error = new Error("incident recovery native artifacts are not bound to the durable allocation");
      error.code = "EINCIDENT_RECOVERY_ARTIFACT_DRIFT";
      error.status = "HOLD";
      error.detail = label;
      throw error;
    }
  }
  return Object.freeze({ binding, envelope, bindingPath, approvalPath, task });
}

async function readIncidentRecoveryCommandArtifacts({ root, runId, candidate, workflowPlan, repositoryRoot }) {
  const pairs = [{
    bindingPath: safeJoin(root, "native-v3-cli", "runs", runId, "binding.json"),
    approvalPath: safeJoin(root, "native-v3-cli", "runs", runId, "approval.json")
  }];
  const taskBindingPath = incidentRecoveryTaskArtifactPath(root, runId, candidate.taskId, candidate.attemptId, "binding.json");
  const taskApprovalPath = incidentRecoveryTaskArtifactPath(root, runId, candidate.taskId, candidate.attemptId, "approval.json");
  if (taskBindingPath !== null && taskApprovalPath !== null) pairs.push({ bindingPath: taskBindingPath, approvalPath: taskApprovalPath });
  const matches = [];
  for (const pair of pairs) {
    const value = await readIncidentRecoveryArtifactPair({
      root,
      runId,
      ...pair,
      workflowPlan,
      candidate,
      repositoryRoot
    });
    if (value !== null) matches.push(value);
  }
  if (matches.length !== 1) {
    const error = new Error("incident recovery has no unique historical native command artifact");
    error.code = "EINCIDENT_RECOVERY_ARTIFACT_UNAVAILABLE";
    error.status = "HOLD";
    throw error;
  }
  return matches[0];
}

const INCIDENT_RECOVERY_MANAGED_MARKER = ".codex/better-workflows/artifacts/.gitignore";
const INCIDENT_RECOVERY_MANAGED_ROOT = ".codex/better-workflows/artifacts";
const INCIDENT_RECOVERY_MANAGED_MARKER_BYTES = "*\n!.gitignore\n";

function normalizeIncidentRecoveryStatus(stdout, managedSurfaces) {
  if (typeof stdout !== "string") throw new Error("incident recovery source status is not text");
  const parts = stdout.split("\0");
  if (parts.at(-1) === "") parts.pop();
  const managedRoots = new Set((managedSurfaces ?? []).map((surface) => surface.path));
  const retained = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (!record) throw new Error("incident recovery source status contains an empty record");
    if (record.startsWith("2 ")) {
      const original = parts[index + 1];
      if (original === undefined) throw new Error("incident recovery source status contains a malformed rename record");
      retained.push(record, original);
      index += 1;
      continue;
    }
    if (record.startsWith("! ")) {
      const relative = record.slice(2).replace(/\/$/u, "");
      if ([...managedRoots].some((root) => relative === root || relative.startsWith(`${root}/`))) continue;
    }
    retained.push(record);
  }
  return retained.length > 0 ? `${retained.join("\0")}\0` : "";
}

async function incidentRecoveryLocalConfigValues(repositoryRoot, key) {
  const result = await runSourceGit(repositoryRoot, [
    "config", "--null", "--local", "--no-includes", "--get-all", key
  ], { allowFailure: true });
  if (result?.ok !== true) {
    if (isExactGitAbsence(result)) return [];
    throw new Error("incident recovery local Git configuration is unavailable");
  }
  if (typeof result.stdout !== "string" || !result.stdout.endsWith("\0")) {
    throw new Error("incident recovery local Git configuration is malformed");
  }
  const values = result.stdout.slice(0, -1).split("\0");
  if (values.some((value) => /[\r\n]/u.test(value))) throw new Error("incident recovery local Git configuration is malformed");
  return values;
}

async function incidentRecoveryOptionalSymbolicRef(repositoryRoot, ref) {
  const result = await runSourceGit(repositoryRoot, ["symbolic-ref", "-q", ref], { allowFailure: true });
  if (result?.ok !== true) {
    if (isExactGitAbsence(result)) return null;
    throw new Error("incident recovery symbolic ref is unavailable");
  }
  return parseOptionalSourceSymbolicRef(result.stdout, "incident recovery symbolic ref");
}

async function incidentRecoveryManagedSurfaces(repositoryRoot, previous) {
  const tracked = await runSourceGit(repositoryRoot, [
    "ls-files", "--error-unmatch", "--", INCIDENT_RECOVERY_MANAGED_MARKER
  ], { allowFailure: true });
  let surfaces = [];
  if (tracked?.ok === true) {
    if (tracked.stdout !== `${INCIDENT_RECOVERY_MANAGED_MARKER}\n`) {
      throw new Error("incident recovery managed marker tracking is malformed");
    }
    const markerPath = path.join(repositoryRoot, ...INCIDENT_RECOVERY_MANAGED_MARKER.split("/"));
    const info = await lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error("incident recovery managed marker is unsafe");
    }
    const bytes = await readFile(markerPath, "utf8");
    if (bytes !== INCIDENT_RECOVERY_MANAGED_MARKER_BYTES) throw new Error("incident recovery managed marker policy changed");
    surfaces = [{
      path: INCIDENT_RECOVERY_MANAGED_ROOT,
      marker: INCIDENT_RECOVERY_MANAGED_MARKER,
      markerDigest: sha256(bytes),
      policy: "ignored-recipe-artifacts-v1"
    }];
  } else if (!isExactGitAbsence(tracked)) {
    throw new Error("incident recovery managed marker tracking is indeterminate");
  }
  if (canonicalJson(surfaces) !== canonicalJson(previous ?? [])) {
    throw new Error("incident recovery managed ignored surfaces changed");
  }
  return surfaces;
}

function incidentRecoveryDirectoryIdentity(target, info) {
  return {
    path: target,
    device: Number.isSafeInteger(info?.dev) ? info.dev : null,
    inode: Number.isSafeInteger(info?.ino) ? info.ino : null
  };
}

async function captureIncidentRecoverySourceWave(repositoryRoot, expectedManagedSurfaces) {
  const [authority, headResult, rootResult, statusResult, hiddenIndex, originUrls, originPushUrls, headRef, originHeadRef, managedSurfaces] = await Promise.all([
    assertSourceGitAncestryAuthority(repositoryRoot),
    runSourceGit(repositoryRoot, ["rev-parse", "HEAD"]),
    runSourceGit(repositoryRoot, ["rev-parse", "--show-toplevel"]),
    runSourceGit(repositoryRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored"]),
    hiddenIndexEntries(repositoryRoot, { isolatedConfig: true }),
    incidentRecoveryLocalConfigValues(repositoryRoot, "remote.origin.url"),
    incidentRecoveryLocalConfigValues(repositoryRoot, "remote.origin.pushurl"),
    incidentRecoveryOptionalSymbolicRef(repositoryRoot, "HEAD"),
    incidentRecoveryOptionalSymbolicRef(repositoryRoot, "refs/remotes/origin/HEAD"),
    incidentRecoveryManagedSurfaces(repositoryRoot, expectedManagedSurfaces)
  ]);
  const headRevision = headResult.stdout.trim();
  if (!/^[a-f0-9]{40}$/iu.test(headRevision)) throw new Error("incident recovery source HEAD is malformed");
  const repository = path.resolve(repositoryRoot);
  const canonicalRepositoryRoot = await realpath(rootResult.stdout.trim());
  if (canonicalRepositoryRoot !== repository) throw new Error("incident recovery source root changed");
  const [gitDirInfo, gitCommonDirInfo] = await Promise.all([
    lstat(authority.gitDir),
    lstat(authority.gitCommonDir)
  ]);
  const worktreeStatus = normalizeIncidentRecoveryStatus(statusResult.stdout, managedSurfaces);
  const originIdentity = {
    present: originUrls.length > 0,
    fetchUrls: originUrls,
    pushUrls: originPushUrls,
    digest: originUrls.length > 0 || originPushUrls.length > 0
      ? sha256(canonicalJson({ fetchUrls: originUrls, pushUrls: originPushUrls }))
      : null
  };
  const diffManifest = {
    schemaVersion: 2,
    baseRevision: null,
    headRevision,
    committedDiff: "",
    committedModeManifest: "",
    headRef,
    originHeadRef
  };
  const stable = {
    schemaVersion: 3,
    cwd: repository,
    repositoryRoot: canonicalRepositoryRoot,
    gitDir: incidentRecoveryDirectoryIdentity(authority.gitDir, gitDirInfo),
    gitCommonDir: incidentRecoveryDirectoryIdentity(authority.gitCommonDir, gitCommonDirInfo),
    originIdentity,
    symbolicRefs: { head: headRef, originHead: originHeadRef },
    baseRevision: null,
    headRevision,
    worktreeClean: worktreeStatus.length === 0 && hiddenIndex.records.length === 0,
    worktreeStatusDigest: sha256(worktreeStatus),
    hiddenIndexDigest: hiddenIndex.digest,
    hiddenIndexCount: hiddenIndex.records.length,
    diffManifestDigest: sha256(canonicalJson(diffManifest)),
    ...(managedSurfaces.length > 0 ? { managedIgnoredSurfaces: managedSurfaces } : {})
  };
  if (!stable.worktreeClean) throw new Error("incident recovery source worktree is not clean");
  return { ...stable, digest: sha256(canonicalJson(stable)) };
}

async function captureIncidentRecoverySourceSnapshot(repositoryRoot, expectedManagedSurfaces) {
  // Two complete waves preserve the source helper's stable-snapshot contract:
  // all fields contributing to the digest are observed twice and any change
  // between the waves is rejected before the binding is returned.
  const first = await captureIncidentRecoverySourceWave(repositoryRoot, expectedManagedSurfaces);
  const second = await captureIncidentRecoverySourceWave(repositoryRoot, expectedManagedSurfaces);
  if (canonicalJson(first) !== canonicalJson(second)) {
    const error = new Error("incident recovery source changed during stable snapshot capture");
    error.code = "ESOURCE_BINDING_DRIFT";
    error.status = "HOLD";
    throw error;
  }
  return second;
}

function incidentRecoverySourceReader({ repositoryRoot, expected, runId, planId }) {
  // Controller rehydration performs one source read and the recovery core may
  // ask for the same point-in-time observation through run-contract and
  // source reads concurrently.  Coalesce only an in-flight capture; completed
  // observations are never reused.  This keeps the reader a full trusted
  // capture while avoiding two identical Git snapshots racing the bounded
  // resolver deadline.
  let inFlight = null;
  let baseline = null;
  return async (request = {}) => {
    if (!request || typeof request !== "object" || Array.isArray(request) ||
        request.runId !== runId || request.planId !== planId ||
        (request.expected !== undefined &&
          (request.expected?.revision !== expected.revision || request.expected?.digest !== expected.digest))) {
      const error = new Error("incident recovery source request is not bound to the trusted allocation");
      error.code = "ESOURCE_BINDING_DRIFT";
      error.status = "HOLD";
      throw error;
    }
    if (inFlight === null) {
      inFlight = (async () => {
        try {
          if (baseline === null) {
            baseline = await captureSourceBinding(repositoryRoot, { requireClean: true });
            return baseline;
          }
          return await captureIncidentRecoverySourceSnapshot(repositoryRoot, baseline.managedIgnoredSurfaces ?? []);
        } catch (error) {
          const wrapped = new Error("current canonical source binding is unavailable");
          wrapped.code = error?.code ?? "ESOURCE_FRESHNESS_UNAVAILABLE";
          wrapped.status = "HOLD";
          wrapped.cause = error;
          throw wrapped;
        }
      })();
      inFlight.catch(() => {});
    }
    let captured;
    try {
      captured = await inFlight;
    } finally {
      // Clear only after all concurrent consumers have observed this capture;
      // a later operation therefore obtains a new full snapshot.
      const completed = inFlight;
      queueMicrotask(() => { if (inFlight === completed) inFlight = null; });
    }
    if (!captured || path.resolve(captured.repositoryRoot) !== path.resolve(repositoryRoot) ||
        captured.headRevision !== expected.revision || captured.digest !== expected.digest) {
      const error = new Error("current canonical source binding drifted during incident recovery");
      error.code = "ESOURCE_BINDING_DRIFT";
      error.status = "HOLD";
      throw error;
    }
    return { revision: captured.headRevision, digest: captured.digest };
  };
}

// Internal recovery bridge used by the `sbw incident recovery` route.  It is
// exported for the focused integration harness so the harness exercises the
// same durable-context reconstruction as the executable entry point; callers
// still receive no authority unless the official private allocation factory
// reconstructs it from the state root.
export async function createSbwIncidentRecoveryContext({ subcommand, options, cwd, env }) {
  const stateRootInput = options["state-root"] ?? getStateRoot(env);
  if (typeof stateRootInput !== "string" || !path.isAbsolute(stateRootInput) || incidentRecoveryRawPathHasTraversal(stateRootInput)) return null;
  const stateRoot = path.resolve(stateRootInput);
  if (stateRoot === path.parse(stateRoot).root) return null;
  const suppliedRunId = options["run-id"];
  let runId = typeof suppliedRunId === "string" && INCIDENT_RECOVERY_ID.test(suppliedRunId) ? suppliedRunId : null;
  let planCandidate = null;
  if (subcommand !== "prepare") {
    const planPath = incidentRecoverySafePlanPath(options.file, cwd);
    if (!planPath) return null;
    planCandidate = await readIncidentRecoveryPlanCandidate(planPath);
    try {
      planCandidate = validateIncidentRecoveryPlanV1(planCandidate);
    } catch {
      return null;
    }
    runId = planCandidate.runId;
  }
  if (runId === null) return null;
  // The context budget is the sum of the bounded steps this subcommand really
  // performs, not one shared window that every step has to carve a share from.
  // It decides whether another bounded step may start; it never shortens the
  // allowance of a step already under way.
  const maxContextMs = subcommand === "resume"
    ? INCIDENT_RECOVERY_MAX_RESUME_CONTEXT_MS
    : INCIDENT_RECOVERY_MAX_CONTEXT_MS;
  const deadlineValue = options["deadline-ms"] === undefined ? maxContextMs : Number(options["deadline-ms"]);
  if (!Number.isSafeInteger(deadlineValue) || deadlineValue <= 0) return null;
  const deadline = Date.now() + Math.min(deadlineValue, maxContextMs);
  const candidates = await readIncidentRecoveryControllerCandidates(stateRoot, runId, deadline);
  let handleCandidate = null;
  if (subcommand === "prepare") {
    if (typeof options["handle-id"] !== "string" || !INCIDENT_RECOVERY_ID.test(options["handle-id"])) return null;
    handleCandidate = await readIncidentRecoveryHandleCandidate(stateRoot, runId, options["handle-id"]);
    if (!handleCandidate) return null;
  }
  const matching = candidates.filter((candidate) => {
    if (subcommand === "prepare") {
      return candidate.executionId === handleCandidate.executionId &&
        candidate.attemptId === handleCandidate.attemptId &&
        candidate.unitId === handleCandidate.unitId &&
        candidate.sourceBinding.digest === handleCandidate.sourceBindingDigest &&
        candidate.policyDigest === handleCandidate.policyDigest &&
        candidate.sourceBinding.revision === handleCandidate.revision &&
        candidate.ownedResourceId === handleCandidate.ownedResourceId;
    }
    return candidate.executionId === planCandidate.executionId &&
      candidate.attemptId === planCandidate.priorAttemptId &&
      candidate.unitId === planCandidate.unitId &&
      candidate.sourceBinding.digest === planCandidate.sourceBindingDigest &&
      candidate.sourceBinding.revision === planCandidate.revision &&
      candidate.policyDigest === planCandidate.policyDigest &&
      candidate.ownedResourceId === planCandidate.ownedResourceId;
  });
  if (matching.length !== 1) return null;
  const candidate = matching[0];
  if (Date.now() >= deadline) return null;
  const repositoryRoot = await canonicalSourceRoot(cwd);
  const readFreshSourceBinding = incidentRecoverySourceReader({
    repositoryRoot,
    expected: candidate.sourceBinding,
    runId,
    planId: candidate.planId
  });
  const readTrustPolicy = createNativeV3TrustPolicyReader();
  let recovered;
  try {
    recovered = await createCooperativeNativeV3RecoveryController({
      stateRoot,
      runId,
      planId: candidate.planId,
      taskId: candidate.taskId,
      unitId: candidate.unitId,
      executionId: candidate.executionId,
      attemptId: candidate.attemptId,
      allocationKey: candidate.allocationKey,
      sourceBinding: candidate.sourceBinding,
      policyDigest: candidate.policyDigest,
      recoveryStorage: candidate.recoveryStorage,
      readFreshSourceBinding,
      readTrustPolicy,
      sourceCwd: repositoryRoot,
      trustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE,
      freshResolverTimeoutMs: INCIDENT_RECOVERY_BASELINE_RESOLVER_MS
    });
  } catch (error) {
    const wrapped = new Error("incident recovery trusted controller could not be reconstructed");
    wrapped.code = error?.code ?? "EINCIDENT_RECOVERY_CONTEXT_UNAVAILABLE";
    wrapped.status = error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD";
    wrapped.cause = error;
    throw wrapped;
  }
  const context = {
    controller: recovered.controller,
    resourceAdapter: null,
    cwd: repositoryRoot,
    env
  };
  if (subcommand !== "resume") return Object.freeze(context);

  // A resume consumes a fresh, exact command binding and a new owner
  // decision.  The historical controller above is observation-only; the
  // trusted command runner below performs the one-use runtime resume and
  // launch transaction.  Never reconstruct either authority from JSON.
  try {
    const workflowPlan = await readFreshWorkflowPlanV1({
      root: stateRoot,
      planId: candidate.planId,
      expected: {
        sourceRevision: candidate.sourceBinding.revision,
        sourceDigest: candidate.sourceBinding.digest,
        policyDigest: candidate.policyDigest
      }
    });
    assertPublicNativeV3AutoPlan(workflowPlan);
    assertNativeV3AutoCommandExecutionAllowed(workflowPlan);
    const task = workflowPlan.taskContract?.graph?.tasks?.find((item) => item.id === candidate.taskId);
    if (!task || workflowPlan.taskContract.graph.tasks.length !== 1 || task.dependencies.length !== 0) {
      const error = new Error("incident recovery resume requires one dependency-free WorkflowPlan task");
      error.code = "EINCIDENT_RECOVERY_GRAPH_UNSUPPORTED";
      error.status = "HOLD";
      throw error;
    }
    const historical = await readIncidentRecoveryCommandArtifacts({
      root: stateRoot,
      runId,
      candidate,
      workflowPlan,
      repositoryRoot
    });
    if (historical.envelope.ownedResourceId !== planCandidate.ownedResourceId ||
        digestObject(historical.envelope.budget) !== planCandidate.oldBudgetDigest) {
      const error = new Error("historical native approval is not bound to the incident recovery plan");
      error.code = "EINCIDENT_RECOVERY_BINDING";
      error.status = "HOLD";
      throw error;
    }
    const commandInput = { ...historical.binding };
    delete commandInput.commandDigest;
    delete commandInput.approvalEnvelopeDigest;
    const commandBinding = createNativeCommandBinding(commandInput, { workspaceRoot: repositoryRoot });
    if (commandBinding.commandDigest !== historical.binding.commandDigest) {
      const error = new Error("historical native command binding changed during recovery preparation");
      error.code = "EINCIDENT_RECOVERY_BINDING_DRIFT";
      error.status = "HOLD";
      throw error;
    }
    const effectBindingDigest = incidentRecoveryEffectBindingDigestV1({
      commandDigest: commandBinding.commandDigest,
      recoveryPlanDigest: planCandidate.planDigest
    });
    const allocationKey = nativeV3AllocationKeyFor({
      taskId: candidate.taskId,
      attemptId: planCandidate.newAttemptId
    });
    const prepared = await prepareCooperativeNativeV3Approval({
      stateRoot,
      planId: candidate.planId,
      runId,
      taskId: candidate.taskId,
      unitId: candidate.unitId,
      executionId: planCandidate.newExecutionId,
      attemptId: planCandidate.newAttemptId,
      allocationKey,
      priorAttemptId: candidate.attemptId,
      priorAllocationKey: candidate.allocationKey,
      priorRecoveryStorage: candidate.recoveryStorage,
      recipient: commandBinding.recipient,
      action: commandBinding.action,
      requestedModel: historical.envelope.requestedModel,
      sourceBinding: candidate.sourceBinding,
      policyDigest: candidate.policyDigest,
      trustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE,
      sourceCwd: repositoryRoot,
      readFreshSourceBinding,
      readTrustPolicy,
      effectBindingDigest,
      freshResolverTimeoutMs: INCIDENT_RECOVERY_STEP_RESOLVER_MS
    });
    const bound = bindNativeCommandToApprovalEnvelope(commandBinding, prepared.approvalEnvelope, {
      workspaceRoot: repositoryRoot
    });
    if (bound.commandDigest !== commandBinding.commandDigest ||
        prepared.approvalEnvelope.ownedResourceId !== planCandidate.ownedResourceId) {
      const error = new Error("fresh recovery approval is not bound to the exact prior allocation");
      error.code = "EINCIDENT_RECOVERY_BINDING";
      error.status = "HOLD";
      throw error;
    }
    if (Date.now() >= deadline) {
      const error = new Error("incident recovery resume exhausted its bounded context budget");
      error.code = "EINCIDENT_RECOVERY_CONTEXT_DEADLINE";
      error.status = "HOLD";
      throw error;
    }
    const resumeId = `incident-${planCandidate.recoveryId}`;
    const bindingPath = workflowResumeFreshArtifactPath(stateRoot, runId, resumeId, candidate.taskId, "binding.json");
    const approvalPath = workflowResumeFreshArtifactPath(stateRoot, runId, resumeId, candidate.taskId, "approval.json");
    await writeWorkflowResumeArtifact(stateRoot, bindingPath, bound, `${candidate.taskId} incident recovery binding`);
    await writeWorkflowResumeArtifact(stateRoot, approvalPath, prepared.approvalEnvelope, `${candidate.taskId} incident recovery ApprovalEnvelope`);
    const freshEnvelope = validateApprovalEnvelope(await readNativeCliCommandBindingInput(approvalPath));
    const freshBinding = await readFreshNativeCommandBinding({
      root: stateRoot,
      target: bindingPath,
      expectedDigest: bound.commandDigest,
      workspaceRoot: repositoryRoot,
      requirePrivate: true
    });
    assertNativeCommandBindingMatchesApprovalEnvelope(freshBinding, freshEnvelope, { workspaceRoot: repositoryRoot });
    // Owner approval and controller activation form one bounded hand-off.  Do
    // not begin it after the context deadline, and do not interrupt it after
    // the single-use decision has been persisted.
    if (Date.now() >= deadline) {
      const error = new Error("incident recovery resume exhausted its bounded context budget");
      error.code = "EINCIDENT_RECOVERY_CONTEXT_DEADLINE";
      error.status = "HOLD";
      throw error;
    }
    const ownerDecision = await collectCooperativeNativeV3OwnerDecision({
      stateRoot,
      runId,
      taskId: candidate.taskId,
      attemptId: planCandidate.newAttemptId,
      allocationKey,
      requestDigest: prepared.ownerApprovalRequest.requestDigest
    });
    const runner = await createNativeV3CommandRunner({
      stateRoot,
      root: stateRoot,
      workspaceRoot: repositoryRoot,
      planId: candidate.planId,
      runId,
      taskId: candidate.taskId,
      unitId: candidate.unitId,
      executionId: planCandidate.newExecutionId,
      attemptId: planCandidate.newAttemptId,
      allocationKey,
      bindingPath: path.relative(stateRoot, bindingPath),
      expectedCommandDigest: freshBinding.commandDigest,
      approvalEnvelope: freshEnvelope,
      effectBindingDigest,
      sourceBinding: candidate.sourceBinding,
      policyDigest: candidate.policyDigest,
      readFreshSourceBinding,
      readTrustPolicy,
      trustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE,
      sourceCwd: repositoryRoot,
      ownerDecision,
      resumeFromHandleId: planCandidate.handleId,
      resumeReason: planCandidate.reason,
      incidentRecoveryPlan: planCandidate,
      freshResolverTimeoutMs: INCIDENT_RECOVERY_STEP_RESOLVER_MS
    });
    return Object.freeze({ ...context, runner });
  } catch (error) {
    const wrapped = new Error("incident recovery resume context could not be prepared");
    wrapped.code = error?.code ?? "EINCIDENT_RECOVERY_RESUME_CONTEXT";
    wrapped.status = error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD";
    wrapped.cause = error;
    throw wrapped;
  }
}

function nativeCliModelPolicyRestricted(policy) {
  return policy.allow.length > 0 || policy.deny.length > 0 ||
    policy.requested !== null || policy.inherit === false;
}

function assertPublicNativeV3AutoTemplateId(templateId) {
  if (templateId === "auto") return;
  const error = new Error("Public V5 native V3 CLI plans and runs require the installed Auto template");
  error.code = "EWORKFLOW_PUBLIC_AUTO_REQUIRED";
  error.status = "HOLD";
  throw error;
}

function assertPublicNativeV3AutoPlan(plan) {
  assertPublicNativeV3AutoTemplateId(plan?.taskContract?.bindings?.template?.id);
}

function assertNativeCliModelSelection(plan, task, requestedModel) {
  if (!task) return;
  const parentPolicy = plan.taskContract.modelPolicy;
  const effectivePolicy = task.modelPolicy;
  const restricted = nativeCliModelPolicyRestricted(parentPolicy) ||
    nativeCliModelPolicyRestricted(effectivePolicy);
  if (requestedModel === undefined) {
    if (restricted) {
      const error = new Error("Native V3 CLI requires --requested-model under the task model policy");
      error.code = "ENATIVE_V3_MODEL_POLICY";
      throw error;
    }
    return;
  }
  const denies = new Set([...parentPolicy.deny, ...effectivePolicy.deny]);
  if (denies.has(requestedModel)) {
    const error = new Error("Native V3 CLI requested model is denied by the task model policy");
    error.code = "ENATIVE_V3_MODEL_POLICY";
    throw error;
  }
  for (const allow of [parentPolicy.allow, effectivePolicy.allow]) {
    if (allow.length > 0 && !allow.includes(requestedModel)) {
      const error = new Error("Native V3 CLI requested model is outside the task model policy allow set");
      error.code = "ENATIVE_V3_MODEL_POLICY";
      throw error;
    }
  }
  if (effectivePolicy.requested !== null && requestedModel !== effectivePolicy.requested) {
    const error = new Error("Native V3 CLI requested model does not match the effective task model policy");
    error.code = "ENATIVE_V3_MODEL_POLICY";
    throw error;
  }
  if (effectivePolicy.requested === null && parentPolicy.requested !== null &&
      requestedModel !== parentPolicy.requested) {
    const error = new Error("Native V3 CLI requested model does not match the parent model policy");
    error.code = "ENATIVE_V3_MODEL_POLICY";
    throw error;
  }
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
    const configured = provider.models?.find((candidate) => candidate.model === model);
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

async function loadTemplate(name, autoPolicyId = "read-only-v1") {
  if (!SAFE_LABEL.test(name)) throw new Error(`Invalid template name: ${name}`);
  if (name !== "auto") throw publicAutoOnlyError();
  return autoPolicyDefinition(autoPolicyId);
}

async function listTemplates() {
  const files = (await readdir(TEMPLATE_DIR)).filter((name) => name.endsWith(".json")).sort();
  if (JSON.stringify(files) !== '["auto.json"]') throw publicAutoOnlyError();
  return [await loadTemplate("auto")];
}

function publicAutoOnlyError() {
  const error = new Error("This command is unavailable in the V5.0 public Auto bundle");
  error.code = "EWORKFLOW_PUBLIC_AUTO_REQUIRED";
  error.status = "HOLD";
  return error;
}

const PUBLIC_AUTO_COMMANDS = new Set([
  "help", "version", "update", "try", "incident", "knowledge", "share",
  "templates", "run", "workflow", "verify",
  "graph", "route", "campaign", "interaction", "deliberation", "status",
  "inspect", "metrics", "cancel", "source", "resume", "sentinel", "evidence",
  "finding", "critic", "action", "resource", "ledger", "review", "complete",
  "doctor", "host", "workspace", "eval", "cleanup"
]);
const PUBLIC_AUTO_REVIEW_SUBCOMMANDS = new Set([
  "plan", "run", "progress", "resume", "aggregate", "replay",
  "plan-native-v2", "run-native-v2", "progress-native-v2", "resume-native-v2",
  "aggregate-native-v2", "replay-native-v2", "verify-native-shards",
  "launch-native", "prepare-native", "status", "package", "diff", "finding",
  "repair", "supersede", "broad"
]);

function assertPublicAutoCommand(command, subcommand) {
  if ((command && !PUBLIC_AUTO_COMMANDS.has(command)) ||
      (command === "review" && !PUBLIC_AUTO_REVIEW_SUBCOMMANDS.has(subcommand)) ||
      (command === "ledger" && !["status", "transition"].includes(subcommand)) ||
      (command === "host" && subcommand === "consent")) {
    throw publicAutoOnlyError();
  }
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
  const template = await loadTemplate(run.manifest.template, run.contract.autoPolicy?.id);
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
    assertMutableRun({ ...run, state: current }, "Sentinel capture");
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
    assertMutableRun({ ...run, state }, "Sentinel verification");
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

const VERIFICATION_CLI_ACTIONS = new Set(["run", "explain"]);
const VERIFICATION_CLI_MAX_JSON_BYTES = 512 * 1024;

function verificationCliPath(value, label, { required = false } = {}) {
  const raw = nativeCliOptionText(value, label, { required });
  if (raw === undefined) return undefined;
  if (!path.isAbsolute(raw) || path.resolve(raw) !== raw) {
    throw new Error(`Verification CLI ${label} must be an absolute normalized path`);
  }
  return raw;
}

function verificationCliEpoch(value) {
  if (value === undefined || value === true || value === false || Array.isArray(value)) {
    throw new Error("Verification CLI requires one non-negative --epoch");
  }
  const epoch = integer(value);
  if (epoch < 0) throw new Error("Verification CLI --epoch must be non-negative");
  return epoch;
}

async function readVerificationCliReceipt(root, value) {
  const raw = nativeCliOptionText(value, "--receipt", { required: true });
  const target = safeJoin(root, raw);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error("Verification CLI --receipt must be a regular state-root file");
  }
  if (info.size > VERIFICATION_CLI_MAX_JSON_BYTES) {
    throw new Error("Verification CLI --receipt exceeds its fixed size bound");
  }
  return JSON.parse(await readFile(target, "utf8"));
}

async function verificationCliContext(root, planId, repositoryOption) {
  const plan = await readFreshWorkflowPlanV1({ root, planId });
  const repositoryInput = verificationCliPath(repositoryOption, "--repository", { required: true });
  const repositoryRoot = await canonicalSourceRoot(repositoryInput);
  const source = await captureSourceBinding(repositoryRoot, { requireClean: true });
  if (!source) throw new Error("Verification CLI --repository is not a Git worktree");
  const expectedSource = plan.taskContract.bindings?.source;
  if (!expectedSource || source.headRevision !== expectedSource.revision || source.digest !== expectedSource.digest) {
    const error = new Error("Verification CLI source does not match the immutable WorkflowPlanV1 binding");
    error.code = "EVERIFICATION_CLI_SOURCE_DRIFT";
    error.status = "HOLD";
    throw error;
  }
  const policy = await readInstalledNativeV3TrustPolicy();
  if (plan.taskContract.bindings?.policy?.digest !== policy.policyDigest) {
    const error = new Error("Verification CLI installed trust policy does not match the immutable WorkflowPlanV1 binding");
    error.code = "EVERIFICATION_CLI_POLICY_DRIFT";
    error.status = "HOLD";
    throw error;
  }
  const consumer = await createNativeV3VerificationConsumer({
    plan,
    repositoryRoot: source.repositoryRoot,
    stateRoot: root
  });
  return { plan, source, consumer };
}

async function commandVerificationCli(root, subcommand, planId, options) {
  if (!VERIFICATION_CLI_ACTIONS.has(subcommand) || !planId) {
    throw new Error("verify requires run|explain <plan-id>");
  }
  if (subcommand === "run") {
    assertKnownOptions(options, ["repository", "task-id", "run-id", "epoch", "unrelated-head", "json"]);
    assertJsonOption(options);
    const taskId = nativeCliOptionText(options["task-id"], "--task-id", { required: true });
    const runId = nativeCliOptionText(options["run-id"], "--run-id", { required: true });
    const epoch = verificationCliEpoch(options.epoch);
    const context = await verificationCliContext(root, String(planId), options.repository);
    return runVerificationCliV1({
      consumer: context.consumer,
      plan: context.plan,
      taskId,
      runId,
      epoch,
      unrelatedHeadDigest: options["unrelated-head"] === undefined
        ? null
        : String(options["unrelated-head"])
    });
  }
  assertKnownOptions(options, ["repository", "task-id", "receipt", "json"]);
  assertJsonOption(options);
  const taskId = nativeCliOptionText(options["task-id"], "--task-id", { required: true });
  const context = await verificationCliContext(root, String(planId), options.repository);
  const receipt = options.receipt === undefined
    ? null
    : await readVerificationCliReceipt(root, options.receipt);
  return explainVerificationCliV1({
    consumer: context.consumer,
    plan: context.plan,
    taskId,
    receipt
  });
}

const NATIVE_REVIEW_V2_HOST_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  NODE_NO_WARNINGS: "1"
});
const NATIVE_REVIEW_V2_ACTIONS = new Set([
  "plan",
  "run",
  "progress",
  "resume",
  "aggregate",
  "replay",
  "plan-native-v2",
  "run-native-v2",
  "progress-native-v2",
  "resume-native-v2",
  "aggregate-native-v2",
  "replay-native-v2"
]);
const NATIVE_REVIEW_V2_ACTION_ALIASES = new Map([
  ["plan", "plan-native-v2"],
  ["run", "run-native-v2"],
  ["progress", "progress-native-v2"],
  ["resume", "resume-native-v2"],
  ["aggregate", "aggregate-native-v2"],
  ["replay", "replay-native-v2"]
]);
const NATIVE_REVIEW_V2_HOST_OPTIONS = [
  "command", "args-file", "epoch", "max-budget-file", "reservation-file", "timeout-ms", "initialization-timeout-ms"
];

function nativeReviewV2Epoch(value) {
  if (Array.isArray(value) || value === undefined || value === true || value === false) {
    throw new Error("V2 review requires one positive --epoch");
  }
  const epoch = integer(value);
  if (epoch < 1) throw new Error("V2 review --epoch must be positive");
  return epoch;
}

async function nativeReviewV2InputFile(optionValue, label) {
  if (optionValue === undefined || optionValue === true || optionValue === false || Array.isArray(optionValue)) {
    throw new Error(`V2 review ${label} requires one file path`);
  }
  return readNativeReviewV2JsonFile(path.resolve(String(optionValue)), `V2 review ${label}`);
}

async function currentNativeReviewV2Context(root, runId) {
  const run = await loadRun(root, runId);
  const status = await reviewStatus(root, runId);
  const reviewPackage = status.package;
  if (!reviewPackage || reviewPackage.schemaVersion !== 2) {
    throw new Error("V2 native review requires a current immutable schemaVersion 2 review package");
  }
  if (!Array.isArray(reviewPackage.reviewLanes) || reviewPackage.reviewLanes.length < 2) {
    throw new Error("V2 native review requires the package's complete review lane set");
  }
  const roles = reviewPackage.reviewLanes.map((lane) => ({ id: lane.id, required: lane.required }));
  return {
    run,
    reviewPackage,
    planOptions: {
      repository: run.manifest.cwd,
      base: reviewPackage.base,
      head: reviewPackage.head,
      roles,
      contextPaths: [],
      manifest: reviewPackage.diffManifest.files,
      planId: reviewPackage.packageId
    },
    stateDirectory: safeJoin(run.runDir, "review-v2")
  };
}

async function prepareCurrentNativeReviewV2(root, runId, options) {
  const context = await currentNativeReviewV2Context(root, runId);
  const epoch = nativeReviewV2Epoch(options.epoch);
  if (typeof options.command !== "string" || !options.command) {
    throw new Error("V2 native review requires an absolute --command host executable");
  }
  const args = options["args-file"] === undefined
    ? []
    : await nativeReviewV2InputFile(options["args-file"], "--args-file");
  const maxBudget = options["max-budget-file"] === undefined
    ? undefined
    : await nativeReviewV2InputFile(options["max-budget-file"], "--max-budget-file");
  const reservation = options["reservation-file"] === undefined
    ? undefined
    : await nativeReviewV2InputFile(options["reservation-file"], "--reservation-file");
  const prepared = await prepareNativeReviewV2({
    ...context.planOptions,
    stateDirectory: context.stateDirectory,
    runId,
    epoch,
    command: options.command,
    args,
    cwd: context.run.manifest.cwd,
    env: NATIVE_REVIEW_V2_HOST_ENV,
    ...(options["timeout-ms"] === undefined ? {} : { timeoutMs: integer(options["timeout-ms"]) }),
    ...(maxBudget === undefined ? {} : { maxBudget }),
    ...(reservation === undefined ? {} : { reservation })
  });
  return { ...context, prepared };
}

async function commandReviewNativeV2(root, runId, action, options) {
  action = NATIVE_REVIEW_V2_ACTION_ALIASES.get(action) ?? action;
  if (action === "plan-native-v2") {
    assertKnownOptions(options, []);
    const context = await currentNativeReviewV2Context(root, runId);
    const plan = await createNativeReviewV2Plan(context.planOptions);
    return {
      ok: true,
      review: {
        protocol: plan.protocol,
        planId: plan.planId,
        planDigest: plan.planDigest,
        sourceDigest: plan.source.sourceDigest,
        repository: plan.source.repository,
        base: plan.source.base,
        head: plan.source.head,
        roles: plan.roles,
        unitCount: plan.units.length,
        assignmentCount: plan.assignments.length,
        batchCount: plan.batches.length,
        budget: plan.budget,
        authority: "plan-only; no host execution or provider attestation",
        plan
      }
    };
  }
  assertKnownOptions(options, [...NATIVE_REVIEW_V2_HOST_OPTIONS, ...(action === "resume-native-v2" || action === "replay-native-v2" ? ["checkpoint", "receipt"] : [])]);
  const context = await prepareCurrentNativeReviewV2(root, runId, options);
  if (action === "run-native-v2") {
    const ownerDecision = await collectNativeReviewV2OwnerDecision({ prepared: context.prepared });
    const outcome = await runNativeReviewV2({
      prepared: context.prepared,
      ownerDecision,
      ...(options["initialization-timeout-ms"] === undefined ? {} : {
        initializationTimeoutMs: integer(options["initialization-timeout-ms"])
      })
    });
    return { ok: outcome.summary.status === "COMPLETE", review: outcome.summary };
  }
  if (action === "progress-native-v2") {
    return { ok: true, review: await getNativeReviewV2Progress({ prepared: context.prepared }) };
  }
  if (action === "resume-native-v2") {
    if (!options.checkpoint) throw new Error("V2 native review resume requires --checkpoint");
    const ownerDecision = await collectNativeReviewV2OwnerDecision({ prepared: context.prepared });
    const outcome = await resumeNativeReviewV2({
      prepared: context.prepared,
      checkpointPath: path.resolve(String(options.checkpoint)),
      ownerDecision,
      ...(options["initialization-timeout-ms"] === undefined ? {} : {
        initializationTimeoutMs: integer(options["initialization-timeout-ms"])
      })
    });
    return { ok: outcome.summary.status === "COMPLETE", review: outcome.summary };
  }
  if (action === "aggregate-native-v2") {
    const aggregate = await getNativeReviewV2Aggregate({ prepared: context.prepared });
    return {
      ok: aggregate !== null,
      review: {
        protocol: context.prepared.protocol,
        planDigest: context.prepared.plan.planDigest,
        aggregate,
        authoritative: aggregate?.authoritative ?? false,
        providerQuota: context.prepared.accounting.providerQuota
      }
    };
  }
  if (action === "replay-native-v2") {
    if (!options.checkpoint) throw new Error("V2 native review replay requires --checkpoint");
    const outcome = await replayNativeReviewV2({
      prepared: context.prepared,
      checkpointPath: path.resolve(String(options.checkpoint)),
      ...(options.receipt === undefined ? {} : { receiptPath: path.resolve(String(options.receipt)) })
    });
    return { ok: true, review: outcome.summary };
  }
  throw new Error("Unsupported V2 native review action");
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

async function assertPublicAutoActionBoundary(root, runId, action) {
  if (!["git.commit", "plugin.cache.publish", "git.push"].includes(action)) return;
  const run = await loadRun(root, runId);
  if (run.manifest.template !== "auto" || run.contract.upstreamSelfImproveRunId != null ||
      run.contract.selfImprovePurpose != null || action === "plugin.cache.publish") throw publicAutoOnlyError();
}

async function commandRunPlan(root, positional, options) {
  let planId;
  let bindingPath;
  let approvalPath;
  let identity = null;
  let runner = null;
  let planRunner = null;
  let planPrepared = null;
  let planModeRequested = false;
  let prepared = null;
  let singlePlanPrepared = null;
  let singlePlanExecutionPromise = null;
  let singlePlanStopPromise = null;
  let singlePlanCancellationReceipt = null;
  let singlePlanCancellationError = null;
  let preparedHandleCleanupReceipt = null;
  let requestedSignal = null;
  let stopPromise = null;
  let controlWatcher = null;
  let controlCleanup = null;
  let executionSettled = false;
  let handlersInstalled = false;
  let interactivePreparation = false;
  let canaryStartConfiguration = null;
  let canaryStartReceipt = null;
  let commandControlStop = null;
  const interactiveAbortController = new AbortController();

  const matchesCommandStop = (receipt) => receipt?.schemaVersion === 1 && receipt.kind === "StopReceiptV1" &&
    receipt.outcome === "STOPPED" && receipt.confirmedOwnedScope === true && receipt.localOutcome === "stopped" &&
    ["runId", "unitId", "executionId", "attemptId"].every((key) => receipt[key] === prepared?.[key]) &&
    receipt.handleId === runner?.handleId && receipt.ownedResourceId === prepared?.envelope?.ownedResourceId &&
    receipt.revision === prepared?.sourceBinding.revision && receipt.sourceBindingDigest === prepared?.sourceBinding.digest &&
    receipt.policyDigest === prepared?.policyDigest;
  const requestSinglePlanStop = () => {
    if (singlePlanStopPromise !== null) return singlePlanStopPromise;
    // Start the real scheduler cancellation synchronously. Its checkpoint
    // acknowledges the request; it is not itself a physical command stop.
    let cancellation;
    let preparedStop = null;
    try {
      cancellation = planRunner.cancel({ reason: "cancel" });
    } catch (error) {
      cancellation = Promise.reject(error);
    }
    // An unclaimed allocation is outside the scheduler's active set. Latch
    // its actual native stop in the same turn, before a later task can claim.
    if (isNativeV3CommandAllocationUnclaimed(runner)) {
      try {
        preparedStop = singlePlanPrepared.stopPreparedRunner();
      } catch (error) {
        preparedStop = Promise.reject(error);
      }
    }
    const cancellationObservation = Promise.resolve(cancellation);
    const preparedStopObservation = preparedStop === null ? null : Promise.resolve(preparedStop);
    cancellationObservation.catch(() => {});
    preparedStopObservation?.catch(() => {});
    singlePlanStopPromise = (async () => {
      const outcomes = await Promise.allSettled([
        cancellationObservation,
        ...(preparedStopObservation === null ? [] : [preparedStopObservation])
      ]);
      if (outcomes[0].status === "fulfilled") singlePlanCancellationReceipt = outcomes[0].value;
      else singlePlanCancellationError = outcomes[0].reason;
      if (preparedStopObservation !== null) {
        if (outcomes[1].status === "rejected") throw outcomes[1].reason;
        preparedHandleCleanupReceipt = outcomes[1].value;
        return preparedHandleCleanupReceipt;
      }
      // Active cancellation can acknowledge before the run settles. Read its
      // actual terminal checkpoint after the same run promise, never execute
      // the command again or fabricate a StopReceipt from CANCELLED.
      let result = null;
      let executionFailure = null;
      try {
        result = singlePlanExecutionPromise === null ? null : await singlePlanExecutionPromise;
      } catch (error) {
        executionFailure = error;
      }
      if (executionFailure !== null) {
        // The scheduler stops owned handles before rejecting its run promise.
        // Read that separate observation even if cancel's checkpoint failed.
        const cleanup = planRunner.readFailureCleanup();
        const matching = cleanup?.schemaVersion === 1 && cleanup.kind === "NativeV3PlanFailureCleanupObservationV1" &&
          ["runId", "planId", "planDigest", "contractDigest"].every((key) => cleanup[key] === prepared[key]);
        const task = matching ? cleanup.tasks.find((entry) => entry.taskId === prepared.taskId &&
          entry.attemptId === prepared.attemptId && entry.handleId === runner.handleId) : null;
        if (task?.callbackSettled === true && task.stopOutcome === "stopped" && matchesCommandStop(task.stopReceipt)) {
          return task.stopReceipt;
        }
      }
      const receipt = result?.checkpoint?.tasks?.[prepared.taskId]?.stopReceipt;
      if (!matchesCommandStop(receipt)) {
        const error = new Error("Scheduler cancellation did not yield a matching settled command stop receipt");
        error.code = "ENATIVE_V3_STOP_UNPROVEN";
        error.status = "UNKNOWN";
        throw error;
      }
      return receipt;
    })();
    singlePlanStopPromise.catch(() => {});
    return singlePlanStopPromise;
  };
  const requestOwnedStop = () => {
    if (!runner || stopPromise !== null) return stopPromise;
    let result;
    try {
      // runner.stop() sets its sticky pre-effect latch and starts the bounded
      // local emergency stop synchronously.  Do not defer that call to a
      // microtask: a released startup gate must observe cancellation first.
      result = singlePlanPrepared === null
        ? runner.stop({ reason: "cancel", requestedBy: "sbw-cli-signal" })
        : requestSinglePlanStop();
      stopPromise = Promise.resolve(result);
    } catch (error) {
      stopPromise = Promise.reject(error);
    }
    stopPromise.catch(() => {});
    return stopPromise;
  };
  const requestPlanStop = () => {
    if (!planRunner || stopPromise !== null) return stopPromise;
    let result;
    try {
      result = planRunner.cancel({ reason: "cancel" });
      stopPromise = Promise.resolve(result);
    } catch (error) {
      stopPromise = Promise.reject(error);
    }
    stopPromise.catch(() => {});
    return stopPromise;
  };
  const requestInteractiveAbort = () => {
    // The boundary owns the cooperative owner collector.  Pass an explicit
    // same-process abort signal so cancellation is observed before and after
    // its TTY listeners attach, without fabricating stream lifecycle events.
    interactiveAbortController.abort();
  };
  const handleSignal = (signal) => {
    if (requestedSignal === null) requestedSignal = signal;
    if (executionSettled) return;
    if (runner) requestOwnedStop();
    else if (planRunner) requestPlanStop();
    else if (interactivePreparation) requestInteractiveAbort();
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  const removeSignalHandlers = () => {
    if (!handlersInstalled) return;
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    handlersInstalled = false;
  };
  const closeControlWatcher = async () => {
    if (controlWatcher === null) return controlCleanup;
    const watcher = controlWatcher;
    controlWatcher = null;
    try {
      controlCleanup = await watcher.close();
    } catch (error) {
      controlCleanup = {
        closed: true,
        completed: false,
        error: {
          code: error?.code ?? "EWORKFLOW_CONTROL_CLOSE_UNKNOWN",
          message: error?.message ?? String(error),
          status: error?.status === "HOLD" ? "HOLD" : "UNKNOWN"
        }
      };
    }
    return controlCleanup;
  };

  try {
    // Install the same-process signal handlers before any asynchronous plan,
    // binding, or controller preparation work.  An early signal must be
    // remembered and fail closed; otherwise the default SIGINT/SIGTERM action
    // can race the boundary before it has a chance to establish its owner
    // interaction listeners.
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    handlersInstalled = true;
    interactivePreparation = true;

    assertKnownOptions(options, ["plan", "command-binding-file", "command-binding-manifest", "requested-model", "expires-at", "parallelism", "canary-start-file"]);
    if (positional.length !== 1 || positional[0] !== "run") {
      throw new Error("sbw run --plan does not accept positional arguments");
    }
    planId = nativeCliOptionText(options.plan, "--plan", { required: true });
    const canaryStartFile = nativeCliOptionText(options["canary-start-file"], "--canary-start-file");
    if (canaryStartFile !== undefined) {
      canaryStartConfiguration = await readNativeCliCommandBindingInput(canaryStartFile);
    }
    const commandBindingManifest = nativeCliOptionText(options["command-binding-manifest"], "--command-binding-manifest");
    const commandBindingFileOption = nativeCliOptionText(options["command-binding-file"], "--command-binding-file");
    if (commandBindingManifest !== undefined && commandBindingFileOption !== undefined) {
      throw new Error("sbw run --plan accepts either --command-binding-file or --command-binding-manifest, not both");
    }
    if (commandBindingManifest !== undefined) {
      planModeRequested = true;
      if (options["requested-model"] !== undefined || options["expires-at"] !== undefined) {
        throw new Error("--requested-model and --expires-at must be supplied per entry in a command binding manifest");
      }
      const rawParallelism = nativeCliOptionText(options.parallelism, "--parallelism");
      const parallelism = rawParallelism === undefined ? undefined : Number(rawParallelism);
      if (parallelism !== undefined && (!Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 64)) {
        throw new Error("Native V3 CLI --parallelism must be an integer from 1 through 64");
      }
      assertPublicNativeV3AutoPlan(await readFreshWorkflowPlanV1({ root, planId }));
      identity = nativeCliExecutionIdentity();
      if (requestedSignal !== null) {
        const error = new Error("Native V3 interactive plan preparation was cancelled before owner approval");
        error.code = "EOWNER_INTERACTION_CANCELLED";
        error.status = "HOLD";
        throw error;
      }
      const commandBindings = await readNativeCliCommandBindingManifestInput(commandBindingManifest);
      planPrepared = await createNativeV3InteractiveCliPlanRun({
        root,
        planId,
        runId: identity.runId,
        commandBindings,
        ...(parallelism === undefined ? {} : { parallelism }),
        ownerAbortSignal: interactiveAbortController.signal
      });
      interactivePreparation = false;
      planRunner = planPrepared.planRunner;
      controlWatcher = await startWorkflowControlWatcher({
        root,
        runId: planPrepared.runId,
        planId: planPrepared.planId,
        planDigest: planPrepared.planDigest,
        contractDigest: planPrepared.contractDigest,
        getRunner: () => planRunner,
        isOwnerActive: () => !executionSettled,
        stopRunner: ({ runner: activeRunner }) => activeRunner.cancel({ reason: "cancel" })
      });
      if (requestedSignal !== null) requestPlanStop();
      let execution = null;
      let executionError = null;
      let canaryDispatchEntered = false;
      try {
        if (canaryStartConfiguration === null) {
          execution = await planRunner.run();
        } else {
          const started = await withCanaryNativeV3StartV1({
            configuration: canaryStartConfiguration,
            prepared: {
              planId: planPrepared.planId,
              runId: planPrepared.runId,
              sourceBinding: planPrepared.sourceBinding
            },
            dispatch: ({ event }) => {
              canaryStartReceipt = canaryStartReceiptFromEvent(event);
              canaryDispatchEntered = true;
              return planRunner.run();
            }
          });
          execution = started.dispatchResult;
        }
      } catch (error) {
        executionError = error;
        if (canaryStartConfiguration !== null && !canaryDispatchEntered) {
          requestPlanStop();
          let failures;
          try {
            failures = await planPrepared.stopPreparedRunners();
          } catch (stopError) {
            failures = [stopError];
          }
          if (failures.length > 0) {
            executionError = new Error("Canary start was blocked and a prepared task handle could not be proven stopped", { cause: error });
            executionError.code = "ECANARY_NATIVE_V3_CLEANUP_UNKNOWN";
            executionError.status = "UNKNOWN";
          }
        }
      } finally {
        executionSettled = true;
        await closeControlWatcher();
      }
      let stopReceipt = null;
      let stopError = null;
      if (stopPromise !== null) {
        try {
          stopReceipt = await stopPromise;
        } catch (error) {
          stopError = error;
        }
      }
      const status = execution?.status ?? (executionError?.status === "UNKNOWN" ? "unknown" : "hold");
      const normalizedStatus = status === "succeeded"
        ? "SUCCESS"
        : status === "failed"
          ? "FAILURE"
          : status === "cancelled"
            ? "CANCELLED"
            : status === "unknown"
              ? "UNKNOWN"
              : "HOLD";
      const cleanupComplete = controlCleanup?.closed === true && controlCleanup?.completed === true;
      const receipt = {
        schemaVersion: 1,
        kind: "NativeV3InteractiveCliPlanRunV1",
        ok: executionError === null && status === "succeeded" && stopError === null && cleanupComplete,
        status: stopError === null && cleanupComplete ? normalizedStatus : "UNKNOWN",
        outcome: cleanupComplete ? status : "unknown",
        executionOutcome: status,
        planId: planPrepared.planId,
        planDigest: planPrepared.planDigest,
        contractDigest: planPrepared.contractDigest,
        runId: planPrepared.runId,
        sourceBinding: planPrepared.sourceBinding,
        policyDigest: planPrepared.policyDigest,
        workspaceRoot: planPrepared.workspaceRoot,
        parallelism: planPrepared.parallelism,
        tasks: planPrepared.tasks,
        dispatchBlocked: execution?.dispatchBlocked ?? null,
        reconcileRequired: execution?.reconcileRequired ?? null,
        failure: execution?.failure ?? (executionError === null ? null : {
          code: executionError?.code ?? "ENATIVE_V3_PLAN_UNKNOWN",
          message: executionError?.message ?? String(executionError),
          status: executionError?.status ?? "HOLD"
        }),
        checkpoint: execution?.checkpoint ?? null,
        ...(controlCleanup === null ? {} : { controlCleanup }),
        ...(requestedSignal === null ? {} : { requestedSignal }),
        ...(stopReceipt === null ? {} : { stopReceipt }),
        ...(canaryStartReceipt === null ? {} : { canaryStartReceipt }),
        ...(stopError === null ? {} : {
          stopError: { code: stopError?.code ?? "ENATIVE_V3_STOP_UNKNOWN", message: stopError?.message ?? String(stopError) }
        })
      };
      if (canaryStartReceipt === null) return receipt;
      const canaryTerminalReceipt = await recordCanaryNativeV3PlanTerminalV1({
        configuration: canaryStartConfiguration,
        prepared: {
          planId: planPrepared.planId, runId: planPrepared.runId,
          planDigest: planPrepared.planDigest, contractDigest: planPrepared.contractDigest,
          sourceBinding: planPrepared.sourceBinding
        },
        startReceipt: canaryStartReceipt, execution,
        executionErrorObserved: executionError !== null,
        executionReceipt: receipt
      });
      return { ...receipt, canaryOutcome: canaryTerminalReceipt.canaryOutcome, canaryTerminalReceipt };
    }
    const commandBindingFile = nativeCliOptionText(
      commandBindingFileOption,
      "--command-binding-file",
      { required: true }
    );
    const requestedModel = nativeCliOptionText(options["requested-model"], "--requested-model");
    const expiresAt = nativeCliOptionText(options["expires-at"], "--expires-at");
    const plan = await readFreshWorkflowPlanV1({ root, planId });
    assertPublicNativeV3AutoPlan(plan);
    const commandBinding = await readNativeCliCommandBindingInput(commandBindingFile);
    const task = typeof commandBinding.taskId === "string"
      ? plan.taskContract.graph.tasks.find((candidate) => candidate.id === commandBinding.taskId)
      : null;
    assertNativeCliModelSelection(plan, task, requestedModel);

    identity = nativeCliExecutionIdentity();
    if (task) identity.attemptId = `${task.id}.attempt.1`;
    bindingPath = path.join("native-v3-cli", "runs", identity.runId, "binding.json");
    approvalPath = path.join("native-v3-cli", "runs", identity.runId, "approval.json");
    if (requestedSignal !== null) {
      const error = new Error("Native V3 interactive preparation was cancelled before owner approval");
      error.code = "EOWNER_INTERACTION_CANCELLED";
      error.status = "HOLD";
      throw error;
    }
    singlePlanPrepared = await createNativeV3InteractiveCliSingleCommandPlanRun({
      root,
      planId,
      runId: identity.runId,
      executionId: identity.executionId,
      attemptId: identity.attemptId,
      bindingPath,
      approvalPath,
      commandBinding,
      ownerAbortSignal: interactiveAbortController.signal,
      ...(requestedModel === undefined ? {} : { requestedModel }),
      ...(expiresAt === undefined ? {} : { expiresAt })
    });
    prepared = singlePlanPrepared.prepared;
    interactivePreparation = false;
    runner = prepared.runner;
    planRunner = singlePlanPrepared.planRunner;
    controlWatcher = await startWorkflowControlWatcher({
      root,
      runId: prepared.runId,
      planId: prepared.planId,
      planDigest: prepared.planDigest,
      contractDigest: prepared.contractDigest,
      getRunner: () => planRunner,
      isOwnerActive: () => !executionSettled,
      stopRunner: ({ runner: activeRunner }) => {
        // A bounded watcher timeout does not cancel the underlying stop. Keep
        // its first promise so a later poll cannot issue the same stop again.
        if (commandControlStop !== null) return commandControlStop.promise;
        const observation = { settled: false, receipt: null, error: null, promise: null };
        commandControlStop = observation;
        let operation;
        try {
          if (activeRunner !== planRunner) throw new Error("Workflow control runner is not the prepared singleton plan runner");
          operation = requestSinglePlanStop();
        } catch (error) {
          operation = Promise.reject(error);
        }
        observation.promise = Promise.resolve(operation).then(
          (value) => { observation.receipt = value; observation.settled = true; return value; },
          (error) => { observation.error = error; observation.settled = true; throw error; }
        );
        observation.promise.catch(() => {});
        return observation.promise;
      }
    });
    if (requestedSignal !== null) requestOwnedStop();

    let execution = null;
    let executionError = null;
    let planExecution = null;
    let planExecutionError = null;
    let preparedCleanupError = null;
    let canaryDispatchEntered = false;
    const dispatchSinglePlan = () => {
      if (singlePlanExecutionPromise === null) singlePlanExecutionPromise = singlePlanPrepared.run();
      return singlePlanExecutionPromise;
    };
    try {
      if (canaryStartConfiguration === null) {
        planExecution = await dispatchSinglePlan();
      } else {
        const started = await withCanaryNativeV3StartV1({
          configuration: canaryStartConfiguration,
          prepared: {
            planId: prepared.planId,
            runId: prepared.runId,
            sourceBinding: prepared.sourceBinding
          },
          dispatch: ({ event }) => {
            canaryStartReceipt = canaryStartReceiptFromEvent(event);
            canaryDispatchEntered = true;
            return dispatchSinglePlan();
          }
        });
        planExecution = started.dispatchResult;
      }
    } catch (error) {
      planExecutionError = error;
      requestOwnedStop();
    } finally {
      // A terminal/paused/throwing scheduler can return without claiming its
      // precreated handle. Revoke that exact allocation; claimed cleanup is
      // still owned by the actual scheduler, not inferred from UNSTARTED.
      if (isNativeV3CommandAllocationUnclaimed(runner)) {
        try {
          preparedHandleCleanupReceipt = await singlePlanPrepared.stopPreparedRunner();
        } catch (error) {
          preparedCleanupError = error;
        }
      }
      executionSettled = true;
      await closeControlWatcher();
    }

    const commandSettlement = singlePlanPrepared.readCommandSettlement();
    const commandObservation = commandSettlement.observation;
    const binding = commandObservation?.binding;
    const observationMatches = commandObservation?.schemaVersion === 1 &&
      commandObservation.kind === "NativeV3CommandSettlementObservationV1" &&
      ["runId", "planId", "planDigest", "contractDigest", "taskId", "unitId", "executionId", "attemptId", "effectBindingDigest"]
        .every((key) => binding?.[key] === prepared[key]) &&
      binding?.handleId === runner.handleId && binding.revision === prepared.sourceBinding.revision &&
      binding.sourceBindingDigest === prepared.sourceBinding.digest && binding.policyDigest === prepared.policyDigest;
    const observationAvailable = observationMatches && commandObservation.availability === "AVAILABLE";
    const observedEffectNotSent = observationAvailable && commandSettlement.effectNotSent === true;
    if (observationAvailable && commandObservation.settlement === "fulfilled") execution = commandObservation.value;
    if (observationAvailable && commandObservation.settlement === "rejected") executionError = commandObservation.error;
    if (executionError === null && planExecutionError !== null) executionError = planExecutionError;
    if (execution === null && executionError === null) {
      executionError = {
        code: planExecution?.failure?.code ?? "ENATIVE_V3_COMMAND_OBSERVATION_UNAVAILABLE",
        message: planExecution?.failure?.message ?? "No matching settled original command DTO is available",
        status: commandObservation?.availability === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      };
    }

    let stopReceipt = null;
    let stopError = null;
    if (stopPromise !== null) {
      try {
        // Signal and control cancellation share one owned operation. A signal
        // must not make a still-pending control hook wait again after bounded
        // watcher close; preserve UNKNOWN instead of issuing another stop.
        if (commandControlStop !== null && stopPromise === singlePlanStopPromise && !commandControlStop.settled) {
          const error = new Error("The shared control/signal stop is still pending after watcher cleanup");
          error.code = "EWORKFLOW_CONTROL_STOP_UNPROVEN";
          error.status = "UNKNOWN";
          throw error;
        }
        stopReceipt = await stopPromise;
      } catch (error) {
        stopError = error;
      }
    }
    let runnerStatus = null;
    try {
      runnerStatus = await runner.status();
    } catch (error) {
      runnerStatus = {
        status: "UNKNOWN",
        error: { code: error?.code ?? "ENATIVE_V3_STATUS_UNKNOWN", message: error?.message ?? String(error) }
      };
    }
    // Snapshot only after bounded watcher close. Do not await a still-pending
    // control stop again here: its late settlement cannot change this receipt.
    const workflowControlStop = commandControlStop === null ? null : {
      settled: commandControlStop.settled,
      receipt: commandControlStop.receipt ?? null,
      error: commandControlStop.error === null ? null : {
        code: commandControlStop.error?.code ?? "EWORKFLOW_CONTROL_STOP_UNKNOWN",
        message: commandControlStop.error?.message ?? String(commandControlStop.error)
      }
    };
    const controlStopKnown = workflowControlStop === null ||
      (workflowControlStop.settled === true && workflowControlStop.error === null &&
        matchesCommandStop(workflowControlStop.receipt));
    const planFailureCleanup = planRunner.readFailureCleanup();
    const cleanupError = stopError ?? preparedCleanupError ?? singlePlanCancellationError ?? (!controlStopKnown ? {
      code: workflowControlStop?.error?.code ?? "EWORKFLOW_CONTROL_STOP_UNPROVEN",
      message: workflowControlStop?.error?.message ?? "The workflow control stop has no matching settled physical scope receipt"
    } : null);
    const planStatus = planExecution?.status ?? "unknown";
    // This projection describes the actual plan execution, just as the
    // manifest CLI does. It does not rename the outer command CLI receipt or
    // convert its command DTO into a plan result.
    const planExecutionReceipt = {
      schemaVersion: 1,
      kind: NATIVE_V3_CLI_PLAN_INTERACTIVE_KIND,
      ok: planExecutionError === null && planStatus === "succeeded" && execution?.outcome === "success" &&
        cleanupError === null && controlCleanup?.closed === true && controlCleanup?.completed === true,
      planId: prepared.planId,
      planDigest: prepared.planDigest,
      contractDigest: prepared.contractDigest,
      runId: prepared.runId,
      sourceBinding: prepared.sourceBinding,
      policyDigest: prepared.policyDigest,
      executionOutcome: planStatus,
      checkpoint: planExecution?.checkpoint ?? null,
      controlCleanup,
      ...(canaryStartReceipt === null ? {} : { canaryStartReceipt }),
      ...(cleanupError === null ? {} : { stopError: { code: cleanupError.code, message: cleanupError.message } })
    };
    const receipt = {
      schemaVersion: 1,
      kind: NATIVE_V3_CLI_INTERACTIVE_KIND,
      planId: prepared.planId,
      planDigest: prepared.planDigest,
      contractDigest: prepared.contractDigest,
      runId: prepared.runId,
      taskId: prepared.taskId,
      unitId: prepared.unitId,
      executionId: prepared.executionId,
      attemptId: prepared.attemptId,
      sourceBinding: prepared.sourceBinding,
      policyDigest: prepared.policyDigest,
      ...(canaryStartReceipt === null ? {} : { canaryStartReceipt }),
      workspaceRoot: prepared.workspaceRoot,
      bindingPath: prepared.bindingPath,
      approvalPath: prepared.approvalPath,
      effectBindingDigest: prepared.effectBindingDigest,
      handleId: runner.handleId,
      runnerStatus,
      planExecutionReceipt,
      commandSettlement: {
        settlement: commandObservation?.settlement ?? "unavailable",
        availability: observationMatches ? commandObservation.availability : "UNKNOWN"
      },
      ...(preparedHandleCleanupReceipt === null ? {} : { preparedHandleCleanupReceipt }),
      ...(singlePlanCancellationReceipt === null ? {} : { cancellationRequestReceipt: singlePlanCancellationReceipt }),
      ...(singlePlanCancellationError === null ? {} : { cancellationRequestError: {
        code: singlePlanCancellationError?.code ?? "ENATIVE_V3_CANCEL_REQUEST_UNKNOWN",
        message: singlePlanCancellationError?.message ?? "Plan cancellation checkpoint could not be observed"
      } }),
      ...(planFailureCleanup === null ? {} : { planFailureCleanup }),
      ...(executionError === null ? {} : { executionFailure: {
        code: executionError?.code ?? "ENATIVE_V3_EXECUTION_UNKNOWN", message: executionError?.message ?? String(executionError)
      } }),
      ...(workflowControlStop === null ? {} : { workflowControlStop }),
      ...(controlCleanup === null ? {} : { controlCleanup }),
      ...(requestedSignal === null ? {} : { requestedSignal }),
      ...(stopReceipt === null ? {} : { stopReceipt }),
      ...(stopError === null ? {} : {
        stopError: { code: stopError?.code ?? "ENATIVE_V3_STOP_UNKNOWN", message: stopError?.message ?? String(stopError) }
      })
    };
    const finishReceipt = async (executionReceipt) => {
      if (canaryStartReceipt === null) return executionReceipt;
      const canaryTerminalReceipt = await recordCanaryNativeV3PlanTerminalV1({
        configuration: canaryStartConfiguration,
        prepared: {
          planId: prepared.planId, runId: prepared.runId,
          planDigest: prepared.planDigest, contractDigest: prepared.contractDigest,
          sourceBinding: prepared.sourceBinding,
          taskId: prepared.taskId, unitId: prepared.unitId,
          executionId: prepared.executionId, attemptId: prepared.attemptId,
          handleId: receipt.handleId, effectBindingDigest: prepared.effectBindingDigest
        },
        startReceipt: canaryStartReceipt, execution: planExecution,
        executionErrorObserved: planExecutionError !== null,
        executionReceipt: planExecutionReceipt
      });
      return { ...executionReceipt, canaryOutcome: canaryTerminalReceipt.canaryOutcome, canaryTerminalReceipt };
    };
    if (executionError !== null) {
      const effectNotSent = observedEffectNotSent;
      const canaryDispatchBlocked = canaryStartConfiguration !== null && !canaryDispatchEntered;
      const cleanupUnknown = cleanupError !== null || (canaryDispatchBlocked && (!matchesCommandStop(stopReceipt) ||
        controlCleanup?.closed !== true || controlCleanup?.completed !== true));
      return await finishReceipt({
        ...receipt,
        ok: false,
        status: cleanupUnknown || !controlStopKnown ? "UNKNOWN" : effectNotSent ? (executionError.status ?? "HOLD")
          : canaryDispatchBlocked && executionError.status !== "UNKNOWN" ? "HOLD" : "UNKNOWN",
        outcome: cleanupUnknown || !controlStopKnown ? "unknown" : effectNotSent || canaryDispatchBlocked ? "not-sent" : "unknown",
        error: {
          code: cleanupUnknown ? (canaryDispatchBlocked ? "ECANARY_NATIVE_V3_CLEANUP_UNKNOWN" : "ENATIVE_V3_CLI_CLEANUP_UNKNOWN")
            : effectNotSent ? "EFFECT_NOT_SENT" : (executionError?.code ?? "ENATIVE_V3_EXECUTION_UNKNOWN"),
          message: cleanupUnknown ? (canaryDispatchBlocked
            ? "Canary start was blocked and owned runner cleanup could not be proven"
            : "Owned singleton plan cleanup could not be proven")
            : executionError?.message ?? String(executionError)
        },
        ...(effectNotSent && executionError.effectNotSent
          ? { effectNotSent: structuredClone(executionError.effectNotSent) }
          : {})
      });
    }
    if (cleanupError !== null) {
      return await finishReceipt({
        ...receipt,
        ok: false,
        status: "UNKNOWN",
        outcome: "unknown",
        error: {
          code: cleanupError?.code ?? "ENATIVE_V3_STOP_UNKNOWN",
          message: cleanupError?.message ?? String(cleanupError)
        }
      });
    }
    if (controlCleanup?.closed !== true || controlCleanup?.completed !== true) {
      return await finishReceipt({
        ...receipt,
        ok: false,
        status: "UNKNOWN",
        outcome: "unknown",
        executionOutcome: execution?.outcome ?? "unknown",
        error: {
          code: controlCleanup?.error?.code ?? "EWORKFLOW_CONTROL_CLOSE_UNKNOWN",
          message: controlCleanup?.error?.message ?? "The workflow control watcher did not prove cleanup completion"
        }
      });
    }
    return await finishReceipt({
      ...receipt,
      ok: planExecutionReceipt.ok === true,
      status: planStatus === "succeeded" && execution?.outcome === "success" ? "SUCCESS"
        : planStatus === "failed" ? "FAILURE"
          : planStatus === "cancelled" ? "CANCELLED"
            : planStatus === "hold" || planStatus === "paused" ? "HOLD" : "UNKNOWN",
      outcome: execution?.outcome ?? "unknown",
      execution: execution ?? null
    });
  } catch (error) {
    // The watcher or a final pre-dispatch boundary can fail after approval.
    // Cancel this same prepared plan and revoke its unclaimed handle before
    // returning, without dispatching it to obtain a synthetic terminal.
    if (singlePlanPrepared !== null && singlePlanExecutionPromise === null && !executionSettled) {
      try {
        requestOwnedStop();
        await stopPromise;
      } catch (cleanupError) {
        const unknown = new Error("Prepared singleton plan cleanup could not be confirmed", { cause: error });
        unknown.code = "ENATIVE_V3_CLI_CLEANUP_UNKNOWN";
        unknown.status = "UNKNOWN";
        unknown.cleanupError = cleanupError;
        error = unknown;
      }
    }
    const planMode = planModeRequested || planPrepared !== null;
    return {
      schemaVersion: 1,
      kind: planMode ? NATIVE_V3_CLI_PLAN_INTERACTIVE_KIND : NATIVE_V3_CLI_INTERACTIVE_KIND,
      ok: false,
      status: error?.status ?? "HOLD",
      ...(planId === undefined ? {} : { planId }),
      ...(identity === null ? {} : identity),
      ...(planPrepared === null ? {} : {
        planDigest: planPrepared.planDigest,
        contractDigest: planPrepared.contractDigest,
        sourceBinding: planPrepared.sourceBinding,
        policyDigest: planPrepared.policyDigest,
        workspaceRoot: planPrepared.workspaceRoot,
        parallelism: planPrepared.parallelism,
        tasks: planPrepared.tasks
      }),
      ...(bindingPath === undefined ? {} : { bindingPath: path.resolve(root, bindingPath) }),
      ...(approvalPath === undefined ? {} : { approvalPath: path.resolve(root, approvalPath) }),
      ...(requestedSignal === null ? {} : { requestedSignal }),
      error: {
        code: error?.code ?? "ENATIVE_V3_CLI_ERROR",
        message: error?.message ?? String(error)
      }
    };
  } finally {
    interactivePreparation = false;
    await closeControlWatcher();
    removeSignalHandlers();
  }
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
    "route-receipt",
    "interaction-mode",
    "strict",
    "workspace-task-id",
    "workspace-repository-id"
  ]);
  const defaults = await loadDefaults();
  const configuredInteractionMode = defaults.interaction.defaultMode;
  let receiptBinding = null;
  if (options["route-receipt"]) {
    for (const conflicting of [
      "template", "entry", "goal", "scope", "mode",
      "interaction-mode", "strict", "risk", "uncertainty",
      "blast-radius", "irreversibility", "evidence-gap"
    ]) {
      if (options[conflicting] !== undefined) {
        throw new Error(`--route-receipt cannot be combined with --${conflicting}`);
      }
    }
    const hasWorkspaceTask = Boolean(options["workspace-task-id"]);
    const hasWorkspaceRepository = Boolean(options["workspace-repository-id"]);
    if (hasWorkspaceTask !== hasWorkspaceRepository) {
      throw new Error("Auto fast-path Git mutation requires both --workspace-task-id and --workspace-repository-id");
    }
    const pendingWorkspaceLease = hasWorkspaceTask
      ? await readWorkspaceLease({
          stateRoot: root,
          repositoryId: String(options["workspace-repository-id"]),
          taskId: String(options["workspace-task-id"])
        })
      : null;
    const expectedClaimant = pendingWorkspaceLease
      ? {
          kind: "direct-workspace-v1",
          ownershipNonce: pendingWorkspaceLease.ownershipNonce,
          repositoryId: String(options["workspace-repository-id"]),
          taskId: String(options["workspace-task-id"])
        }
      : null;
    receiptBinding = await validateRouteReceipt({
      stateRoot: root,
      cwd: process.cwd(),
      receiptId: String(options["route-receipt"]),
      expectedClaimant
    });
    if (receiptBinding.preview.primary.template && pendingWorkspaceLease) {
      throw new Error("Workspace lease options are only valid for an Auto fast-path Git mutation route");
    }
    if (!receiptBinding.preview.primary.template) {
      const assessment = receiptBinding.preview.autoRiskAssessment;
      if (assessment?.decision !== "direct-fast-path") {
        throw new Error("Route receipt does not resolve a concrete template");
      }
      let workspaceLease = null;
      if (assessment.workspaceLifecycle === "isolated-worktree") {
        if (!options["workspace-task-id"] || !options["workspace-repository-id"]) {
          throw new Error("Auto fast-path Git mutation requires --workspace-task-id and --workspace-repository-id");
        }
        const claimant = expectedClaimant;
        const receiptWorkspace = await realpath(receiptBinding.receipt.cwd);
        const pendingLeaseWorkspace = await realpath(pendingWorkspaceLease.sourceCheckout);
        if (pendingLeaseWorkspace !== receiptWorkspace) {
          throw new Error("Auto fast-path Git mutation workspace lease does not match the route receipt");
        }
        await claimRouteReceipt({
          stateRoot: root,
          receiptId: receiptBinding.receipt.receiptId,
          claimant
        });
        const startedWorkspace = await workspaceBeginDirect({
          stateRoot: root,
          repositoryId: String(options["workspace-repository-id"]),
          taskId: String(options["workspace-task-id"]),
          routeReceiptId: receiptBinding.receipt.receiptId,
          assessmentDigest: assessment.assessmentDigest,
          sourceRevision: assessment.sourceRevision,
          integrationTarget: assessment.integrationTarget,
          integrationTargetRevision: assessment.integrationTargetRevision,
          basicCheckPlan: assessment.basicCheckPlan
        });
        workspaceLease = startedWorkspace.lease;
        const startedLeaseWorkspace = await realpath(workspaceLease.sourceCheckout);
        if (startedLeaseWorkspace !== receiptWorkspace) {
          throw new Error("Auto fast-path Git mutation workspace lease does not match the route receipt");
        }
      } else if (options["workspace-task-id"] || options["workspace-repository-id"]) {
        throw new Error("Workspace lease options are only valid for an Auto fast-path Git mutation route");
      }
      if (assessment.workspaceLifecycle !== "isolated-worktree") {
        await claimRouteReceipt({
          stateRoot: root,
          receiptId: receiptBinding.receipt.receiptId
        });
      }
      await markRouteReceiptUsed({
        stateRoot: root,
        receiptId: receiptBinding.receipt.receiptId,
        runId: null
      });
      return {
        ok: true,
        direct: true,
        runId: null,
        mode: "direct",
        routeReceipt: receiptBinding.receipt.receiptId,
        autoRiskAssessment: assessment,
        workspaceLease: workspaceLease
          ? {
              taskId: workspaceLease.taskId,
              repositoryId: workspaceLease.repository.repositoryId,
              taskBranch: workspaceLease.taskBranch,
              taskWorktree: workspaceLease.taskWorktree,
              integrationTarget: workspaceLease.integrationTarget,
              lifecycleState: workspaceLease.lifecycleState
            }
          : null,
        instruction: workspaceLease
          ? "Auto fast path: make, test, and commit Git changes only inside the task-owned worktree."
          : "Auto fast path: perform only the bounded work and targeted local checks recorded in the assessment."
      };
    }
  }
  const templateName = receiptBinding
    ? receiptBinding.preview.primary.template
    : String(options.template ?? "");
  if (receiptBinding?.preview?.autonomyProfile) throw publicAutoOnlyError();
  const interactionMode = optionEnabled(options.strict)
    ? "strict"
    : options["interaction-mode"] !== undefined
      ? String(options["interaction-mode"])
      : configuredInteractionMode;
  if (!["auto", "strict"].includes(interactionMode)) {
    throw new Error("--interaction-mode must be auto or strict");
  }
  const suppliedContract = options.contract
    ? JSON.parse(await readFile(path.resolve(String(options.contract)), "utf8"))
    : null;
  if (suppliedContract?.autonomyProfile) throw publicAutoOnlyError();
  const selectedAutoPolicyId = receiptBinding?.preview?.bindings?.autoPolicy?.id ??
    suppliedContract?.autoPolicy?.id ?? "read-only-v1";
  const template = await loadTemplate(templateName, selectedAutoPolicyId);
  if (GRAPH_ENFORCEMENT_ENABLED) {
    const graph = buildTemplateGraph({
      template,
      sourcePath: `templates/${template.name}.json`
    });
    if (graphHasErrors(graph)) return graphStructuralFailure(graph, "run.create");
  }
  let contract;
  let expectedOriginIdentityDigest = null;
  let protectedRemoteObservation = null;
  if (options.contract) {
    contract = validateContract(suppliedContract);
    if ((contract.selfImprovePurpose && contract.selfImprovePurpose !== "ordinary") ||
        contract.upstreamSelfImproveRunId || contract.autonomyProfile) {
      throw publicAutoOnlyError();
    }
    if (contract.autoPolicy.id !== selectedAutoPolicyId) {
      throw new Error("Supplied Auto policy differs from the route receipt");
    }
    if (receiptBinding) {
      const assessment = receiptBinding.preview.autoRiskAssessment;
      const risk = Object.fromEntries(["risk", "uncertainty", "blastRadius", "irreversibility", "evidenceGap"]
        .map((key) => [key, assessment[key]]));
      if (contract.goal !== receiptBinding.preview.input.goal ||
          digestObject(contract.scope.include) !== digestObject(receiptBinding.preview.input.scope) ||
          digestObject(contract.risk) !== digestObject(risk)) {
        throw new Error("Supplied Auto contract goal, scope, or risk differs from the route receipt");
      }
    }
    if (contract.template !== templateName) throw new Error("Contract template does not match --template");
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
      throw new Error("Public Auto requires a v2 contract");
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
    let remoteRevision = options["remote-revision"] ? String(options["remote-revision"]) : null;
    const deliveryTarget = protectedDeliveryTarget({
      template: "auto",
      autoPolicy: receiptBinding?.preview?.bindings?.autoPolicy ??
        autoPolicyBinding(selectedAutoPolicyId)
    });
    if (deliveryTarget && remoteRevision === null) {
      protectedRemoteObservation = await resolveRemoteBranchRevision(process.cwd(), {
        remote: "origin",
        branch: deliveryTarget
      });
      remoteRevision = protectedRemoteObservation.revision;
      expectedOriginIdentityDigest = protectedRemoteObservation.remoteBindingDigest ?? null;
    }
    contract = buildContract({
      template: templateName,
      templateDefinition: template,
      goal: receiptBinding
        ? receiptBinding.preview.input.goal
        : String(options.goal ?? `${templateName} workflow`),
      scope: receiptBinding
        ? receiptBinding.preview.input.scope
        : values(options.scope, ["."]).map(String),
      risk: receiptBinding
        ? Object.fromEntries(["risk", "uncertainty", "blastRadius", "irreversibility", "evidenceGap"]
          .map((key) => [key, receiptBinding.preview.autoRiskAssessment[key]]))
        : {
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
      remoteRevision,
      interactionMode
    });
    if (options["require-agy"] === true || options["require-agy"] === "true") {
      contract.agy.required = true;
    }
  }
  const deliveryTarget = protectedDeliveryTarget({ template: "auto", autoPolicy: contract.autoPolicy });
  if (deliveryTarget) {
    protectedRemoteObservation ??= await resolveRemoteBranchRevision(process.cwd(), {
      remote: "origin",
      branch: deliveryTarget
    });
    if (contract.remoteRevision !== protectedRemoteObservation.revision) {
      throw new Error("Auto protected delivery requires the exact live remote branch revision");
    }
    if (!protectedRemoteObservation.remoteBindingDigest) {
      throw new Error("Auto protected delivery requires a bound origin identity");
    }
    expectedOriginIdentityDigest = protectedRemoteObservation.remoteBindingDigest;
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
  const result = await createRun({
    root,
    contract,
    requestedMode,
    cwd: process.cwd(),
    baselineRevision: null,
    expectedOriginIdentityDigest
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
      instruction: "Auto fast path: continue in the root without helper state or subagents."
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

function workflowPlanResult(fields) {
  return {
    planningOnly: true,
    authorityGrantIssued: false,
    effectAllowed: false,
    externalNetworkUsed: false,
    ...fields
  };
}

function workflowPolicyObservationDigest(defaults) {
  return digestObject(defaults);
}

function workflowPlanScopeOverride(options, contract) {
  if (options.scope === undefined) return;
  const supplied = values(options.scope).map(String).sort();
  const expected = [...contract.scope.include].sort();
  if (JSON.stringify(supplied) !== JSON.stringify(expected)) {
    throw new Error("Workflow plan --scope must exactly match the native TaskContractV3 scope");
  }
}

function assertWorkflowPlanOverrides(options, contract) {
  if (options.goal !== undefined && String(options.goal).trim() !== contract.goal) {
    throw new Error("Workflow plan --goal must exactly match the native TaskContractV3 goal");
  }
  if (options.template !== undefined && String(options.template) !== contract.bindings.template.id) {
    throw new Error("Workflow plan --template must exactly match the native TaskContractV3 template binding");
  }
  workflowPlanScopeOverride(options, contract);
}

function assertWorkflowPlanDraftOverrides(options, draft) {
  if (options.goal !== undefined && String(options.goal).trim() !== draft.goal) {
    throw new Error("Workflow plan --goal must exactly match the native TaskContractV3 draft goal");
  }
  workflowPlanScopeOverride(options, draft);
  const templateId = options.template === undefined ? "" : String(options.template).trim();
  if (!templateId) throw new Error("Workflow plan draft requires --template auto");
  return templateId;
}

async function observeWorkflowPlanBindings(root, contract, templateId = contract.bindings?.template?.id) {
  const blockers = [];
  let source = null;
  let template = null;
  let defaults = null;
  let nativePolicy = null;
  let preview = null;
  try {
    source = await captureSourceBinding(process.cwd(), { requireClean: false });
  } catch (error) {
    blockers.push("source-observation-failed:" + error.message);
  }
  if (!source) blockers.push("source-observation-unavailable");
  try {
    template = await loadTemplate(templateId);
  } catch (error) {
    blockers.push("template-observation-failed:" + error.message);
  }
  try {
    defaults = await loadDefaults();
  } catch (error) {
    blockers.push("policy-observation-failed:" + error.message);
  }
  if (contract.schemaVersion === 3) {
    try {
      nativePolicy = await readInstalledNativeV3TrustPolicy();
    } catch (error) {
      blockers.push("native-policy-observation-failed:" + error.message);
    }
  }
  if (template && defaults) {
    try {
      if (templateId === "auto" && contract.bindings?.template?.digest === digestObject(autoPolicyDefinition("dev-publish-v1"))) {
        blockers.push("auto-v3-dev-publish-unavailable:integration target is not bound in TaskContractV3");
      }
      const declaredMutationIntent = templateId === "auto"
        ? (contract.graph.tasks.some((task) => task.writeOwner.paths.length > 0) ? "modify" : "read-only")
        : "unknown";
      preview = await previewRoute({
        cwd: process.cwd(),
        stateRoot: root,
        goal: contract.goal,
        scope: contract.scope.include,
        template: templateId,
        mode: "auto",
        acceptanceDefined: true,
        mutationIntent: declaredMutationIntent,
        interactionMode: "strict"
      });
      if (templateId === "auto" && preview.autoTemplateSelection) {
        template = autoPolicyDefinition(preview.autoTemplateSelection);
      }
      if (preview.ok === false) {
        blockers.push(...(preview.blockers ?? []).map((item) => "route-observation-blocked:" + item));
      }
    } catch (error) {
      blockers.push("route-observation-failed:" + error.message);
    }
  }
  const policy = contract.schemaVersion === 3
    ? (nativePolicy ? { digest: nativePolicy.policyDigest } : null)
    : (defaults ? { digest: workflowPolicyObservationDigest(defaults) } : null);
  if (source && template && defaults && preview && policy) {
    return {
      ok: blockers.length === 0,
      blockers,
      bindings: {
        source: { revision: source.headRevision, digest: source.digest },
        policy,
        template: { id: template.name, digest: digestObject(template) },
        route: routeBindingFromPreview(preview)
      },
      preview
    };
  }
  return { ok: false, blockers, bindings: null, preview };
}

function workflowBindingDrift(contract, observed) {
  const blockers = [];
  if (!observed?.bindings) return ["fresh-binding-observation-unavailable"];
  const expected = contract.bindings;
  const actual = observed.bindings;
  const comparisons = [
    ["source revision", expected.source.revision, actual.source.revision],
    ["source digest", expected.source.digest, actual.source.digest],
    ["policy digest", expected.policy.digest, actual.policy.digest],
    ["template id", expected.template.id, actual.template.id],
    ["template digest", expected.template.digest, actual.template.digest],
    ["route digest", expected.route.digest, actual.route.digest],
    ["route receipt id", expected.route.receiptId, actual.route.receiptId]
  ];
  for (const [label, expectedValue, actualValue] of comparisons) {
    if (expectedValue !== actualValue) blockers.push("binding-drift:" + label);
  }
  return blockers;
}

function workflowControlTarget(runId, action) {
  if (typeof runId !== "string" || runId.length === 0 || runId.startsWith("--")) {
    throw new Error(`workflow ${action} requires exactly one <run-id>`);
  }
  return runId;
}

function workflowControlWait(value) {
  if (value === undefined) return WORKFLOW_CONTROL_DEFAULT_WAIT_MS;
  if (Array.isArray(value) || value === true || value === false) {
    throw new Error(`workflow control --wait-ms requires exactly one integer from 0 through ${WORKFLOW_CONTROL_MAX_WAIT_MS}`);
  }
  const parsed = integer(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > WORKFLOW_CONTROL_MAX_WAIT_MS) {
    throw new Error(`workflow control --wait-ms must be an integer from 0 through ${WORKFLOW_CONTROL_MAX_WAIT_MS}`);
  }
  return parsed;
}

function workflowControlFailure(operation, error) {
  return {
    schemaVersion: 1,
    kind: "WorkflowControlResultV1",
    ok: false,
    status: error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD",
    operation,
    error: {
      code: error?.code ?? "EWORKFLOW_CONTROL",
      message: error?.message ?? String(error),
      status: error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
    },
    authority: {
      authorityGrantIssued: false,
      effectAllowed: false,
      newEpochIssued: false,
      newAdmissionCreated: false
    }
  };
}

const WORKFLOW_RESUME_OWNER_PROBE_MS = 250;
const WORKFLOW_RESUME_MAX_PENDING_TASKS = 4096;
const WORKFLOW_RESUME_MAX_ATTEMPT = 1_000_000;

function workflowResumeError(code, message, status = "HOLD") {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function workflowResumeSame(left, right) {
  return digestObject(left) === digestObject(right);
}

function workflowResumeResultFromState({
  state,
  status,
  error = null,
  requestId = null,
  request = null,
  response = null,
  requestCreated = false,
  requestPath = null,
  responsePath = null,
  freshAttempt = null
}) {
  const confirmed = status === "RESUMED" && error === null;
  return {
    schemaVersion: 1,
    kind: "WorkflowControlResultV1",
    ok: confirmed,
    status,
    operation: "workflow.resume",
    runId: state.runId,
    planId: state.plan.planId,
    planDigest: state.plan.planDigest,
    contractDigest: state.plan.contractDigest,
    ...(requestId === null ? {} : { requestId }),
    requestCreated,
    ...(request === null ? {} : { request }),
    response,
    checkpoint: state.checkpoint,
    ...(requestPath === null ? {} : { requestPath }),
    ...(responsePath === null ? {} : { responsePath }),
    ...(freshAttempt === null ? {} : { freshAttempt }),
    authority: {
      // The CLI result reports the durable transition and its fresh-attempt
      // evidence separately.  These fields remain false because the JSON
      // boundary cannot itself mint or export an authority capability.
      authorityGrantIssued: false,
      effectAllowed: false,
      newEpochIssued: false,
      newAdmissionCreated: false,
      oldAuthorizationReused: false
    },
    ...(error === null ? {} : {
      error: {
        code: error.code ?? "EWORKFLOW_RESUME",
        message: error.message ?? String(error),
        status: error.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
      }
    })
  };
}

function workflowResumeStateView(checkpoint, plan) {
  return {
    runId: checkpoint.runId,
    checkpoint,
    plan
  };
}

async function readWorkflowResumeState(root, runId) {
  const checkpoint = await readNativeV3PlanRunnerCheckpoint({ root, runId });
  const plan = await readFreshWorkflowPlanV1({
    root,
    planId: checkpoint.planId,
    expected: {
      planDigest: checkpoint.planDigest,
      contractDigest: checkpoint.contractDigest
    }
  });
  if (plan.planId !== checkpoint.planId || plan.planDigest !== checkpoint.planDigest ||
      plan.contractDigest !== checkpoint.contractDigest) {
    throw workflowResumeError("EWORKFLOW_RESUME_PLAN_DRIFT", "WorkflowPlan is not bound to the native runner checkpoint", "HOLD");
  }
  return workflowResumeStateView(checkpoint, plan);
}

function workflowResumeAssertRequest(request, { runId, planId, planDigest, contractDigest, expected }) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw workflowResumeError("EWORKFLOW_RESUME_INPUT", "fresh source request is invalid");
  }
  const allowed = new Set(["runId", "planId", "expected", "observedAt"]);
  const unknown = Object.keys(request).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw workflowResumeError("EWORKFLOW_RESUME_INPUT", "fresh source request contains unknown fields");
  if (request.runId !== runId || request.planId !== planId) {
    throw workflowResumeError("ESOURCE_BINDING_DRIFT", "fresh source request is bound to a different workflow", "HOLD");
  }
  if (request.expected !== undefined) {
    if (!request.expected || typeof request.expected !== "object" || Array.isArray(request.expected) ||
        request.expected.revision !== expected.revision || request.expected.digest !== expected.digest) {
      throw workflowResumeError("ESOURCE_BINDING_DRIFT", "fresh source request expected binding changed", "HOLD");
    }
  }
  return true;
}

async function captureWorkflowResumeSource(expected) {
  let captured;
  try {
    captured = await captureSourceBinding(process.cwd(), {
      requireClean: true
    });
  } catch (error) {
    const wrapped = workflowResumeError(
      error?.code ?? "ESOURCE_FRESHNESS_UNAVAILABLE",
      `Current canonical source binding is unavailable: ${error?.message ?? String(error)}`,
      "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  if (!captured || typeof captured.repositoryRoot !== "string" || !path.isAbsolute(captured.repositoryRoot) ||
      captured.headRevision !== expected.revision || captured.digest !== expected.digest) {
    throw workflowResumeError("ESOURCE_BINDING_DRIFT", "Current canonical source binding does not match the paused WorkflowPlan", "HOLD");
  }
  return {
    repositoryRoot: path.resolve(captured.repositoryRoot),
    sourceBinding: { revision: captured.headRevision, digest: captured.digest }
  };
}

function workflowResumeFreshSourceReader({ repositoryRoot, expected, runId, planId }) {
  return async (request = {}) => {
    workflowResumeAssertRequest(request, { runId, planId, expected });
    let captured;
    try {
      captured = await captureSourceBinding(repositoryRoot, {
        requireClean: true
      });
    } catch (error) {
      const wrapped = workflowResumeError(
        error?.code ?? "ESOURCE_FRESHNESS_UNAVAILABLE",
        `Current canonical source binding is unavailable: ${error?.message ?? String(error)}`,
        "HOLD"
      );
      wrapped.cause = error;
      throw wrapped;
    }
    if (!captured || path.resolve(captured.repositoryRoot) !== repositoryRoot ||
        captured.headRevision !== expected.revision || captured.digest !== expected.digest) {
      throw workflowResumeError("ESOURCE_BINDING_DRIFT", "Current canonical source binding drifted during resume", "HOLD");
    }
    return { revision: captured.headRevision, digest: captured.digest };
  };
}

function workflowResumeTaskArtifactPath(root, runId, taskId, attemptNumber, fileName) {
  const taskKey = `task-${digestObject({ schemaVersion: 1, kind: "NativeV3CliTaskArtifactKeyV1", taskId })}`;
  return safeJoin(root, "native-v3-cli", "runs", runId, "tasks", taskKey, `attempt-${attemptNumber}`, fileName);
}

function workflowResumeFreshArtifactPath(root, runId, resumeId, taskId, fileName) {
  const taskKey = `task-${digestObject({ schemaVersion: 1, kind: "NativeV3CliTaskArtifactKeyV1", taskId })}`;
  return safeJoin(root, "native-v3-cli", "runs", runId, "resumes", resumeId, taskKey, fileName);
}

/**
 * Locate the paused attempt's runtime handle without treating the registry
 * JSON as an authority.  The registry is only a candidate index here; the
 * command runner's `resumeExecution` path replays the journal and performs
 * the fresh controller/admission CAS before any effect can be sent.
 */
async function readWorkflowResumePriorHandleId({
  root,
  runId,
  prior,
  sourceBinding,
  policyDigest,
  ownedResourceId
}) {
  const registryPath = safeJoin(root, "execution-runtime-v1", "runs", runId, "registry.json");
  let registry;
  try {
    registry = await readJson(root, registryPath);
  } catch (error) {
    const wrapped = workflowResumeError(
      error?.code ?? "EWORKFLOW_RESUME_RUNTIME_BINDING",
      `task ${prior.binding.taskId} prior execution registry is unavailable: ${error?.message ?? String(error)}`,
      error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  if (!registry || registry.schemaVersion !== 1 || registry.kind !== "ExecutionRegistryV1" ||
      registry.runId !== runId || !registry.handles || typeof registry.handles !== "object" ||
      Array.isArray(registry.handles)) {
    throw workflowResumeError(
      "EWORKFLOW_RESUME_RUNTIME_BINDING",
      `task ${prior.binding.taskId} prior execution registry is not a valid candidate index`,
      "HOLD"
    );
  }
  const matches = Object.values(registry.handles).filter((handle) =>
    handle && typeof handle === "object" &&
    handle.runId === runId &&
    handle.executionId === prior.envelope.executionId &&
    handle.attemptId === prior.priorAttemptId &&
    handle.unitId === prior.binding.unitId &&
    handle.sourceBindingDigest === sourceBinding.digest &&
    handle.policyDigest === policyDigest &&
    handle.revision === sourceBinding.revision &&
    handle.ownedResourceId === ownedResourceId &&
    ["ready", "stopped", "revoked", "failed", "indeterminate"].includes(handle.status) &&
    typeof handle.handleId === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(handle.handleId)
  );
  if (matches.length !== 1) {
    throw workflowResumeError(
      "EWORKFLOW_RESUME_RUNTIME_BINDING",
      `task ${prior.binding.taskId} does not have exactly one candidate handle for the paused attempt`,
      "HOLD"
    );
  }
  return matches[0].handleId;
}

async function syncWorkflowResumeDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}

async function reuseExactWorkflowResumeArtifact(root, target, value, label) {
  try {
    await assertNoSymlinkUnder(root, target);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
      throw workflowResumeError("EWORKFLOW_RESUME_ARTIFACT_EXISTS", `${label} already exists`, "HOLD");
    }
    const existing = await readJson(root, target);
    if (!workflowResumeSame(existing, value)) {
      throw workflowResumeError("EWORKFLOW_RESUME_ARTIFACT_EXISTS", `${label} already exists`, "HOLD");
    }
  } catch (error) {
    if (error?.code === "EWORKFLOW_RESUME_ARTIFACT_EXISTS") throw error;
    const wrapped = workflowResumeError("EWORKFLOW_RESUME_ARTIFACT_EXISTS", `${label} already exists but cannot be reused safely`, "HOLD");
    wrapped.cause = error;
    throw wrapped;
  }
}

/**
 * Publish resume artifacts create-only.  `atomicWriteJson` gives us a fully
 * synced private temporary file; link(2) makes the final name immutable even
 * when another local process races this resume request.  A retry may reuse an
 * already-published artifact only when its private-file boundary and complete
 * canonical value still match the exact artifact being published.
 */
async function writeWorkflowResumeArtifact(root, target, value, label) {
  const parent = path.dirname(target);
  await assertNoSymlinkUnder(root, parent);
  const existing = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    await reuseExactWorkflowResumeArtifact(root, target, value, label);
    return;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await atomicWriteJson(root, temporary, value);
    try {
      await link(temporary, target);
    } catch (error) {
      if (error?.code === "EEXIST") {
        await reuseExactWorkflowResumeArtifact(root, target, value, label);
        await unlink(temporary);
        await syncWorkflowResumeDirectory(parent);
        return;
      }
      throw error;
    }
    await unlink(temporary);
    await syncWorkflowResumeDirectory(parent);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (error?.code === "EWORKFLOW_RESUME_ARTIFACT_EXISTS") throw error;
    const wrapped = workflowResumeError(
      error?.code ?? "EWORKFLOW_RESUME_ARTIFACT_WRITE",
      `${label} could not be published safely: ${error?.message ?? String(error)}`,
      "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

// Test-only seam for the immutable resume-artifact retry boundary. Production
// callers publish through the incident/workflow resume paths above.
export async function __testWriteWorkflowResumeArtifact({ root, target, value, label = "test resume artifact" }) {
  return writeWorkflowResumeArtifact(root, target, value, label);
}

function workflowResumeTaskAttemptNumber(checkpoint, taskId) {
  const taskState = checkpoint.tasks?.[taskId];
  const used = taskState?.attempts;
  if (!Number.isSafeInteger(used) || used < 0 || used >= WORKFLOW_RESUME_MAX_ATTEMPT) {
    throw workflowResumeError("EWORKFLOW_RESUME_STATE_INVALID", `task ${taskId} attempt accounting is invalid`, "HOLD");
  }
  const freshAttempt = checkpoint.events?.some((event) =>
    event?.type === "run.paused" && Array.isArray(event.detail?.freshAttemptTaskIds) &&
    event.detail.freshAttemptTaskIds.includes(taskId)
  );
  const attemptNumber = used + 1 + (used === 0 && freshAttempt ? 1 : 0);
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > WORKFLOW_RESUME_MAX_ATTEMPT) {
    throw workflowResumeError("EWORKFLOW_RESUME_STATE_INVALID", `task ${taskId} next attempt is outside the bounded range`, "HOLD");
  }
  return attemptNumber;
}

function workflowResumePriorAttemptNumber(checkpoint, taskId) {
  const taskState = checkpoint.tasks?.[taskId];
  const used = taskState?.attempts;
  if (!Number.isSafeInteger(used) || used < 0 || used >= WORKFLOW_RESUME_MAX_ATTEMPT) {
    throw workflowResumeError("EWORKFLOW_RESUME_STATE_INVALID", `task ${taskId} attempt accounting is invalid`, "HOLD");
  }
  return Math.max(1, used);
}

function workflowResumeAssertBinding({ binding, envelope, plan, task, sourceBinding, policyDigest, runId, priorAttemptId }) {
  const checks = [
    ["planDigest", binding.planDigest, plan.planDigest],
    ["contractDigest", binding.contractDigest, plan.contractDigest],
    ["taskId", binding.taskId, task.id],
    ["sourceBindingDigest", binding.sourceBindingDigest, sourceBinding.digest],
    ["policyDigest", binding.policyDigest, policyDigest],
    ["revision", binding.revision, sourceBinding.revision],
    ["envelope runId", envelope.runId, runId],
    ["envelope planDigest", envelope.planDigest, plan.planDigest],
    ["envelope contractDigest", envelope.contractDigest, plan.contractDigest],
    ["envelope taskId", envelope.taskId, task.id],
    ["envelope sourceBindingDigest", envelope.sourceBindingDigest, sourceBinding.digest],
    ["envelope policyDigest", envelope.policyDigest, policyDigest],
    ["envelope revision", envelope.revision, sourceBinding.revision],
    ["envelope attemptId", envelope.attemptId, priorAttemptId]
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) throw workflowResumeError("EWORKFLOW_RESUME_BINDING_DRIFT", `${label} is not bound to the paused plan`, "HOLD");
  }
  if (!workflowResumeSame(binding.scope, plan.taskContract.scope) ||
      !workflowResumeSame(envelope.scope, plan.taskContract.scope) ||
      !workflowResumeSame(envelope.budget, task.budget) ||
      envelope.unitId !== binding.unitId || envelope.recipient !== binding.recipient || envelope.action !== binding.action) {
    throw workflowResumeError("EWORKFLOW_RESUME_BINDING_DRIFT", "historical native artifact is not bound to the exact paused task", "HOLD");
  }
}

async function readWorkflowResumePriorArtifacts({ root, runId, task, checkpoint, plan, sourceBinding, policyDigest, workspaceRoot }) {
  const priorAttemptNumber = workflowResumePriorAttemptNumber(checkpoint, task.id);
  const bindingPath = workflowResumeTaskArtifactPath(root, runId, task.id, priorAttemptNumber, "binding.json");
  const approvalPath = workflowResumeTaskArtifactPath(root, runId, task.id, priorAttemptNumber, "approval.json");
  let rawBinding;
  let rawEnvelope;
  try {
    rawBinding = await readNativeCliCommandBindingInput(bindingPath, { allowBound: true });
    rawEnvelope = await readNativeCliCommandBindingInput(approvalPath);
  } catch (error) {
    const wrapped = workflowResumeError(
      error?.code ?? "EWORKFLOW_RESUME_BINDING_MISSING",
      `task ${task.id} historical native artifacts are unavailable: ${error?.message ?? String(error)}`,
      "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  let envelope;
  try {
    envelope = validateApprovalEnvelope(rawEnvelope);
    if (digestApprovalEnvelope(envelope) !== envelope.digest) {
      throw workflowResumeError("EWORKFLOW_RESUME_APPROVAL_INVALID", "historical ApprovalEnvelope digest is invalid", "HOLD");
    }
  } catch (error) {
    const wrapped = workflowResumeError("EWORKFLOW_RESUME_APPROVAL_INVALID", `task ${task.id} historical ApprovalEnvelope is invalid`, "HOLD");
    wrapped.cause = error;
    throw wrapped;
  }
  if (typeof rawBinding.commandDigest !== "string" || !/^[a-f0-9]{64}$/.test(rawBinding.commandDigest)) {
    throw workflowResumeError("EWORKFLOW_RESUME_BINDING_INVALID", `task ${task.id} historical command binding digest is invalid`, "HOLD");
  }
  let binding;
  try {
    binding = await readFreshNativeCommandBinding({
      root,
      target: bindingPath,
      expectedDigest: rawBinding.commandDigest,
      workspaceRoot,
      requirePrivate: true
    });
    assertNativeCommandBindingMatchesApprovalEnvelope(binding, envelope, { workspaceRoot });
    workflowResumeAssertBinding({
      binding,
      envelope,
      plan,
      task,
      sourceBinding,
      policyDigest,
      runId,
      priorAttemptId: `${task.id}.attempt.${priorAttemptNumber}`
    });
  } catch (error) {
    const wrapped = workflowResumeError(
      error?.code ?? "EWORKFLOW_RESUME_BINDING_INVALID",
      `task ${task.id} historical native artifacts are not bound to the current plan: ${error?.message ?? String(error)}`,
      error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
    );
    wrapped.cause = error;
    throw wrapped;
  }
  return {
    priorAttemptNumber,
    priorAttemptId: `${task.id}.attempt.${priorAttemptNumber}`,
    priorAllocationKey: nativeV3AllocationKeyFor({ taskId: task.id, attemptId: `${task.id}.attempt.${priorAttemptNumber}` }),
    binding,
    envelope,
    bindingPath,
    approvalPath
  };
}

async function stopWorkflowResumeRunners(runners) {
  const failures = [];
  for (const runner of runners) {
    try {
      await runner.stop({ reason: "cancel", requestedBy: "sbw-workflow-resume" });
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function prepareWorkflowResumeAttempt({ root, state, source, pendingTasks, abortSignal, resumeId }) {
  const readTrustPolicy = createNativeV3TrustPolicyReader();
  const policyDigest = state.plan.taskContract.bindings.policy.digest;
  await readTrustPolicy({
    runId: state.runId,
    planId: state.plan.planId,
    policyDigest,
    requestedTrustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE
  });
  const runners = [];
  const preparedTasks = [];
  try {
    for (const task of pendingTasks) {
      if (abortSignal?.aborted) throw workflowResumeError("EOWNER_INTERACTION_CANCELLED", "workflow resume was cancelled before owner approval", "HOLD");
      const nextAttemptNumber = workflowResumeTaskAttemptNumber(state.checkpoint, task.id);
      const prior = await readWorkflowResumePriorArtifacts({
        root,
        runId: state.runId,
        task,
        checkpoint: state.checkpoint,
        plan: state.plan,
        sourceBinding: source.sourceBinding,
        policyDigest,
        workspaceRoot: source.repositoryRoot
      });
      const attemptId = `${task.id}.attempt.${nextAttemptNumber}`;
      const executionId = `execution-${digestObject({
        schemaVersion: 1,
        kind: "NativeV3CliWorkflowResumeExecutionIdentityV1",
        runId: state.runId,
        planId: state.plan.planId,
        taskId: task.id,
        attemptId,
        resumeId
      }).slice(0, 48)}`;
      const allocationKey = nativeV3AllocationKeyFor({ taskId: task.id, attemptId });
      const commandInput = { ...prior.binding };
      delete commandInput.commandDigest;
      delete commandInput.approvalEnvelopeDigest;
      const commandBinding = createNativeCommandBinding(commandInput, { workspaceRoot: source.repositoryRoot });
      if (commandBinding.commandDigest !== prior.binding.commandDigest) {
        throw workflowResumeError("EWORKFLOW_RESUME_BINDING_DRIFT", `task ${task.id} command binding changed while preparing resume`, "HOLD");
      }
      let prepared;
      try {
        prepared = await prepareCooperativeNativeV3Approval({
          stateRoot: root,
          planId: state.plan.planId,
          runId: state.runId,
          taskId: task.id,
          unitId: commandBinding.unitId,
          executionId,
          attemptId,
          allocationKey,
          priorAttemptId: prior.priorAttemptId,
          priorAllocationKey: prior.priorAllocationKey,
          recipient: commandBinding.recipient,
          action: commandBinding.action,
          requestedModel: prior.envelope.requestedModel,
          sourceBinding: source.sourceBinding,
          policyDigest,
          trustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE,
          sourceCwd: source.repositoryRoot,
          readFreshSourceBinding: workflowResumeFreshSourceReader({
            repositoryRoot: source.repositoryRoot,
            expected: source.sourceBinding,
            runId: state.runId,
            planId: state.plan.planId
          }),
          readTrustPolicy,
          effectBindingDigest: commandBinding.commandDigest,
          freshResolverTimeoutMs: 4_000
        });
      } catch (error) {
        const wrapped = workflowResumeError(
          error?.code ?? "EWORKFLOW_RESUME_PREPARE_HOLD",
          `task ${task.id} fresh owner allocation could not be prepared: ${error?.message ?? String(error)}`,
          error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD"
        );
        wrapped.cause = error;
        throw wrapped;
      }
      if (abortSignal?.aborted) throw workflowResumeError("EOWNER_INTERACTION_CANCELLED", "workflow resume was cancelled before owner approval", "HOLD");
      const bound = bindNativeCommandToApprovalEnvelope(commandBinding, prepared.approvalEnvelope, {
        workspaceRoot: source.repositoryRoot
      });
      if (bound.commandDigest !== commandBinding.commandDigest) {
        throw workflowResumeError("EWORKFLOW_RESUME_BINDING_DRIFT", `task ${task.id} fresh binding digest changed`, "HOLD");
      }
      const bindingPath = workflowResumeFreshArtifactPath(root, state.runId, resumeId, task.id, "binding.json");
      const approvalPath = workflowResumeFreshArtifactPath(root, state.runId, resumeId, task.id, "approval.json");
      await writeWorkflowResumeArtifact(root, bindingPath, bound, `${task.id} resume binding`);
      await writeWorkflowResumeArtifact(root, approvalPath, prepared.approvalEnvelope, `${task.id} resume ApprovalEnvelope`);
      const freshEnvelope = validateApprovalEnvelope(await readNativeCliCommandBindingInput(approvalPath));
      const freshBinding = await readFreshNativeCommandBinding({
        root,
        target: bindingPath,
        expectedDigest: bound.commandDigest,
        workspaceRoot: source.repositoryRoot,
        requirePrivate: true
      });
      assertNativeCommandBindingMatchesApprovalEnvelope(freshBinding, freshEnvelope, { workspaceRoot: source.repositoryRoot });
      const ownerDecision = await collectCooperativeNativeV3OwnerDecision({
        stateRoot: root,
        runId: state.runId,
        taskId: task.id,
        attemptId,
        allocationKey,
        requestDigest: prepared.ownerApprovalRequest.requestDigest,
        abortSignal
      });
      if (abortSignal?.aborted) throw workflowResumeError("EOWNER_INTERACTION_CANCELLED", "workflow resume was cancelled after owner approval", "HOLD");
      // The durable registry is only a candidate index.  Do not activate a
      // second controller here: the owner decision is single-use, and the
      // command runner must consume it exactly once while `resumeExecution`
      // replays the prior journal and performs the fresh admission CAS.
      const priorHandleId = await readWorkflowResumePriorHandleId({
        root,
        runId: state.runId,
        prior,
        sourceBinding: source.sourceBinding,
        policyDigest,
        ownedResourceId: prepared.allocation.ownedResourceId
      });
      const readFreshSourceBinding = workflowResumeFreshSourceReader({
        repositoryRoot: source.repositoryRoot,
        expected: source.sourceBinding,
        runId: state.runId,
        planId: state.plan.planId
      });
      const runnerOptions = {
        stateRoot: root,
        root,
        workspaceRoot: source.repositoryRoot,
        planId: state.plan.planId,
        runId: state.runId,
        taskId: task.id,
        unitId: freshBinding.unitId,
        executionId: freshEnvelope.executionId,
        attemptId: freshEnvelope.attemptId,
        allocationKey,
        planTaskMode: "trusted-plan-task",
        bindingPath: path.relative(root, bindingPath),
        expectedCommandDigest: freshBinding.commandDigest,
        approvalEnvelope: freshEnvelope,
        sourceBinding: source.sourceBinding,
        policyDigest,
        readFreshSourceBinding,
        readTrustPolicy,
        trustMode: NATIVE_V3_COMMAND_RUNNER_TRUST_MODE,
        sourceCwd: source.repositoryRoot,
        freshResolverTimeoutMs: 4_000,
        resumeFromHandleId: priorHandleId,
        resumeReason: "workflow-pause",
        ownerDecision,
        effectBindingDigest: freshBinding.commandDigest
      };
      if (freshEnvelope.requestedModel !== undefined) runnerOptions.requestedModel = freshEnvelope.requestedModel;
      const runner = await createNativeV3CommandRunner(runnerOptions);
      runners.push(runner);
      preparedTasks.push(Object.freeze({
        taskId: task.id,
        attemptId,
        executionId,
        allocationKey,
        commandDigest: freshBinding.commandDigest,
        approvalEnvelopeDigest: freshEnvelope.digest,
        bindingPath: path.relative(root, bindingPath),
        approvalPath: path.relative(root, approvalPath),
        priorAttemptId: prior.priorAttemptId,
        priorAllocationKey: prior.priorAllocationKey,
        priorHandleId,
        handleId: runner.handleId
      }));
    }
    return { runners, preparedTasks };
  } catch (error) {
    const stopFailures = await stopWorkflowResumeRunners(runners);
    if (stopFailures.length > 0) {
      const cleanupError = workflowResumeError(
        "EWORKFLOW_RESUME_CLEANUP_UNKNOWN",
        "fresh resume preparation failed and an approved task could not be proven stopped",
        "UNKNOWN"
      );
      cleanupError.cause = error;
      cleanupError.stopFailures = stopFailures.map((item) => ({ code: item?.code ?? "UNKNOWN", message: item?.message ?? String(item) }));
      throw cleanupError;
    }
    throw error;
  }
}

async function workflowResumeFreshAttempt({ root, runId, waitMs }) {
  let state;
  try {
    state = await readWorkflowResumeState(root, runId);
  } catch (error) {
    throw error;
  }
  if (state.checkpoint.status === "unknown" || state.checkpoint.reconcileRequired === true ||
      state.checkpoint.tasks && Object.values(state.checkpoint.tasks).some((task) => task.status === "unknown")) {
    return workflowResumeResultFromState({
      state,
      status: "UNKNOWN",
      error: workflowResumeError("EWORKFLOW_RESUME_RECONCILIATION_REQUIRED", "the workflow is UNKNOWN and requires trusted effect reconciliation before a fresh resume attempt", "UNKNOWN")
    });
  }
  if (state.checkpoint.status !== "paused") {
    return workflowResumeResultFromState({
      state,
      status: "HOLD",
      error: workflowResumeError("EWORKFLOW_RESUME_REQUIRES_PAUSED", "Workflow resume requires a durably paused checkpoint", "HOLD")
    });
  }
  assertPublicNativeV3AutoPlan(state.plan);
  assertNativeV3AutoCommandExecutionAllowed(state.plan);
  const pendingTasks = state.plan.taskContract.graph.tasks.filter((task) => state.checkpoint.tasks[task.id]?.status === "pending");
  if (pendingTasks.length === 0 || pendingTasks.length > WORKFLOW_RESUME_MAX_PENDING_TASKS) {
    return workflowResumeResultFromState({
      state,
      status: "HOLD",
      error: workflowResumeError("EWORKFLOW_RESUME_NO_PENDING_TASKS", "paused workflow has no bounded set of pending tasks to resume", "HOLD")
    });
  }
  const remainingAttempts = state.checkpoint.budget.attempts - state.checkpoint.budget.attemptsUsed;
  if (!Number.isSafeInteger(remainingAttempts) || remainingAttempts < pendingTasks.length) {
    return workflowResumeResultFromState({
      state,
      status: "HOLD",
      error: workflowResumeError("EWORKFLOW_RESUME_BUDGET_EXHAUSTED", "fresh resume would exceed the durable workflow attempt budget", "HOLD")
    });
  }
  const requestId = randomUUID();
  // First give a still-live owner a bounded opportunity to answer.  This
  // preserves an active owner's immutable HOLD/UNKNOWN response and avoids
  // racing two owners.  With no owner the same request is later consumed by
  // the newly prepared fresh-attempt owner.
  let probe;
  try {
    probe = await requestWorkflowControl({
      root,
      runId: state.runId,
      action: "resume",
      requestId,
      waitMs: Math.max(WORKFLOW_RESUME_OWNER_PROBE_MS, Math.min(WORKFLOW_CONTROL_MAX_WAIT_MS, waitMs))
    });
  } catch (error) {
    throw error;
  }
  if (probe.response !== null) return probe;
  let source;
  try {
    source = await captureWorkflowResumeSource(state.plan.taskContract.bindings.source);
    const currentState = await readWorkflowResumeState(root, state.runId);
    if (!workflowResumeSame(currentState.checkpoint, state.checkpoint) ||
        currentState.plan.planDigest !== state.plan.planDigest ||
        currentState.checkpoint.status !== "paused") {
      throw workflowResumeError("EWORKFLOW_RESUME_STATE_DRIFT", "paused checkpoint changed before fresh resume preparation", "HOLD");
    }
    state = currentState;
    assertPublicNativeV3AutoPlan(state.plan);
    assertNativeV3AutoCommandExecutionAllowed(state.plan);
  } catch (error) {
    return workflowResumeResultFromState({
      state,
      status: error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD",
      requestId: probe.requestId ?? requestId,
      request: probe.request ?? null,
      requestCreated: probe.requestCreated === true,
      response: probe.response ?? null,
      requestPath: probe.requestPath ?? null,
      responsePath: probe.responsePath ?? null,
      error
    });
  }
  const resumeId = randomUUID();
  const abortController = new AbortController();
  const onSignal = () => abortController.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let prepared = null;
  let planRunner = null;
  let watcher = null;
  let ownerActive = true;
  let finalResult = null;
  try {
    prepared = await prepareWorkflowResumeAttempt({
      root,
      state,
      source,
      pendingTasks,
      abortSignal: abortController.signal,
      resumeId
    });
    const taskAdapter = createNativeV3PlanTaskAdapterFromCommandRunners({ runners: prepared.runners });
    planRunner = await createNativeV3PlanRunner({
      stateRoot: root,
      root,
      plan: state.plan,
      planId: state.plan.planId,
      runId: state.runId,
      parallelism: state.checkpoint.parallelism,
      taskAdapter,
      abortSignal: abortController.signal
    });
    watcher = await startWorkflowControlWatcher({
      root,
      runId: state.runId,
      planId: state.plan.planId,
      planDigest: state.plan.planDigest,
      contractDigest: state.plan.contractDigest,
      getRunner: () => planRunner,
      isOwnerActive: () => ownerActive,
      stopRunner: ({ runner }) => runner.cancel({ reason: "cancel" }),
      pollMs: 25,
      stopTimeoutMs: Math.min(WORKFLOW_CONTROL_MAX_WAIT_MS, Math.max(1, waitMs)),
      closeTimeoutMs: Math.min(WORKFLOW_CONTROL_MAX_WAIT_MS, Math.max(1, waitMs))
    });
    const resumed = await requestWorkflowControl({
      root,
      runId: state.runId,
      action: "resume",
      requestId,
      waitMs
    });
    const freshAttempt = Object.freeze({
      resumeId,
      prepared: prepared.preparedTasks.map((task) => ({ ...task })),
      budgetBefore: state.checkpoint.budget,
      budgetReset: false
    });
    if (resumed.status !== "RESUMED" || resumed.ok !== true) {
      finalResult = { ...resumed, freshAttempt };
      return finalResult;
    }
    const execution = await planRunner.run();
    const executionStatus = execution?.status ?? (await planRunner.inspect()).status;
    const executionCheckpoint = execution?.checkpoint ?? await planRunner.inspect();
    if (executionStatus === "succeeded") {
      finalResult = {
        ...resumed,
        ok: true,
        status: "RESUMED",
        checkpoint: executionCheckpoint,
        freshAttempt,
        execution: { status: executionStatus, checkpoint: executionCheckpoint }
      };
    } else {
      const error = workflowResumeError(
        executionStatus === "unknown" ? "EWORKFLOW_RESUME_EXECUTION_UNKNOWN" : "EWORKFLOW_RESUME_EXECUTION_FAILED",
        `fresh resume execution ended in ${executionStatus}`,
        executionStatus === "unknown" ? "UNKNOWN" : "HOLD"
      );
      finalResult = {
        ...resumed,
        ok: false,
        status: executionStatus === "unknown" ? "UNKNOWN" : "HOLD",
        checkpoint: executionCheckpoint,
        freshAttempt,
        execution: { status: executionStatus, checkpoint: executionCheckpoint },
        error: { code: error.code, message: error.message, status: error.status }
      };
    }
    return finalResult;
  } catch (error) {
    const current = await readWorkflowResumeState(root, state.runId).catch(() => state);
    const freshAttempt = prepared === null ? null : Object.freeze({
      resumeId,
      prepared: prepared.preparedTasks.map((task) => ({ ...task })),
      budgetBefore: state.checkpoint.budget,
      budgetReset: false
    });
    finalResult = workflowResumeResultFromState({
      state: current,
      status: error?.status === "UNKNOWN" ? "UNKNOWN" : "HOLD",
      requestId: probe.requestId ?? requestId,
      request: probe.request ?? null,
      requestCreated: probe.requestCreated === true,
      response: probe.response ?? null,
      requestPath: probe.requestPath ?? null,
      responsePath: probe.responsePath ?? null,
      freshAttempt,
      error
    });
    return finalResult;
  } finally {
    ownerActive = false;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    const closeResult = watcher ? await watcher.close().catch((error) => ({
      closed: true,
      completed: false,
      error: {
        code: error?.code ?? "EWORKFLOW_CONTROL_CLOSE_UNKNOWN",
        message: error?.message ?? String(error),
        status: "UNKNOWN"
      }
    })) : { closed: true, completed: true };
    if (finalResult && closeResult?.completed !== true) {
      finalResult.ok = false;
      finalResult.status = "UNKNOWN";
      finalResult.error = closeResult.error ?? {
        code: "EWORKFLOW_CONTROL_CLOSE_UNKNOWN",
        message: "fresh resume owner cleanup did not settle before its bounded deadline",
        status: "UNKNOWN"
      };
    }
    if (planRunner && finalResult?.status !== "RESUMED") {
      await planRunner.cancel({ reason: "cancel" }).catch(() => {});
    }
    if (prepared && finalResult?.status !== "RESUMED") {
      await stopWorkflowResumeRunners(prepared.runners).catch(() => {});
    }
  }
}

async function commandWorkflowControl(root, action, runId, options) {
  const target = workflowControlTarget(runId, action);
  if (action === "watch") {
    assertKnownOptions(options, ["json"]);
    assertJsonOption(options);
    try {
      const observation = await readWorkflowControlObservation({ root, runId: target });
      return {
        schemaVersion: 1,
        kind: WORKFLOW_CONTROL_WATCH_KIND,
        ok: true,
        status: "OBSERVED",
        operation: "workflow.watch",
        runId: observation.runId,
        planId: observation.plan.planId,
        planDigest: observation.plan.planDigest,
        contractDigest: observation.plan.contractDigest,
        runStatus: observation.checkpoint.status,
        checkpoint: observation.checkpoint,
        pending: observation.pending.map((request) => ({
          requestId: request.requestId,
          action: request.action,
          requestedAt: request.requestedAt,
          requestDigest: request.requestDigest,
          checkpointDigest: request.checkpointDigest
        })),
        responses: observation.responses.map((response) => ({
          requestId: response.requestId,
          action: response.action,
          status: response.status,
          physicalStopProven: response.physicalStopProven,
          respondedAt: response.respondedAt,
          responseDigest: response.responseDigest,
          error: response.error,
          claimed: response.claimed,
          confirmed: response.confirmed
        })),
        authority: {
          authorityGrantIssued: false,
          effectAllowed: false
        }
      };
    } catch (error) {
      return workflowControlFailure("workflow.watch", error);
    }
  }
  if (action === "pause" || action === "stop") {
    assertKnownOptions(options, ["json", "request-id", "wait-ms"]);
    assertJsonOption(options);
    const requestId = options["request-id"] === undefined
      ? undefined
      : nativeCliOptionText(options["request-id"], "--request-id", { required: true });
    const waitMs = workflowControlWait(options["wait-ms"]);
    try {
      return await requestWorkflowControl({ root, runId: target, action, requestId, waitMs });
    } catch (error) {
      return workflowControlFailure(`workflow.${action}`, error);
    }
  }
  if (action === "resume") {
    assertKnownOptions(options, ["json", "wait-ms"]);
    assertJsonOption(options);
    const waitMs = workflowControlWait(options["wait-ms"]);
    try {
      return await workflowResumeFreshAttempt({ root, runId: target, waitMs });
    } catch (error) {
      return workflowControlFailure("workflow.resume", error);
    }
  }
  if (action === "save") {
    assertKnownOptions(options, ["json", "save-id", "file"]);
    assertJsonOption(options);
    const saveId = options["save-id"] === undefined
      ? undefined
      : nativeCliOptionText(options["save-id"], "--save-id", { required: true });
    const file = options.file === undefined
      ? undefined
      : nativeCliOptionText(options.file, "--file", { required: true });
    try {
      return await saveWorkflowControlSnapshot({ root, runId: target, saveId, file });
    } catch (error) {
      return workflowControlFailure("workflow.save", error);
    }
  }
  throw new Error("workflow subcommand must be plan, watch, pause, resume, stop, or save");
}

async function commandWorkflowPlan(root, subcommand, runId, options, positional = []) {
  if (subcommand !== "plan") {
    if (positional.length !== 3 || positional[0] !== "workflow" || positional[1] !== subcommand || !runId) {
      throw new Error(`workflow ${subcommand} requires exactly one <run-id>`);
    }
    return commandWorkflowControl(root, subcommand, runId, options);
  }
  assertKnownOptions(options, ["contract", "plan-id", "goal", "scope", "template"]);
  if (!options.contract) throw new Error("workflow plan requires --contract <native-v3.json>");
  const contractFile = path.resolve(String(options.contract));
  const raw = JSON.parse(await readFile(contractFile, "utf8"));
  if (raw?.schemaVersion === 2) {
    throw new Error("workflow plan requires native TaskContractV3; legacy v2 is not admitted");
  }
  const draft = raw?.schemaVersion === 3 && !Object.hasOwn(raw, "bindings");
  let contract = draft ? validateTaskContractV3Draft(raw) : validateTaskContractV3(raw);
  const templateId = draft
    ? assertWorkflowPlanDraftOverrides(options, contract)
    : (assertWorkflowPlanOverrides(options, contract), contract.bindings.template.id);
  assertPublicNativeV3AutoTemplateId(templateId);
  const observed = await observeWorkflowPlanBindings(root, contract, templateId);
  const drift = draft || !observed.bindings ? [] : workflowBindingDrift(contract, observed);
  if (!observed.ok || drift.length > 0) {
    return workflowPlanResult({
      ok: false,
      status: "HOLD",
      blockers: [...observed.blockers, ...drift],
      contractId: contract.contractId,
      currentBindings: observed.bindings,
      routePreviewDigest: observed.preview?.routeDigest ?? null
    });
  }
  if (draft) {
    // The draft file remains unchanged; only the private persisted plan receives
    // fresh bindings, then the complete native V3 validator runs before save.
    contract = validateTaskContractV3({ ...contract, bindings: observed.bindings });
  }
  const plan = buildWorkflowPlanV1({
    taskContract: contract,
    planId: options["plan-id"] === undefined ? null : String(options["plan-id"])
  });
  const persisted = await persistWorkflowPlanV1({ root, plan });
  return workflowPlanResult({
    ok: true,
    status: "PLANNED",
    planId: persisted.plan.planId,
    planDigest: persisted.plan.planDigest,
    contractDigest: persisted.plan.contractDigest,
    path: persisted.path,
    created: persisted.created,
    currentBindings: observed.bindings,
    routePreviewDigest: observed.preview.routeDigest
  });
}

async function commandVerifyPlan(root, planId, options) {
  assertKnownOptions(options, ["goal", "scope", "template"]);
  if (!planId) throw new Error("verify plan requires <plan-id>");
  const plan = await readWorkflowPlanV1({ root, planId: String(planId) });
  assertWorkflowPlanOverrides(options, plan.taskContract);
  const observed = await observeWorkflowPlanBindings(root, plan.taskContract);
  const drift = workflowBindingDrift(plan.taskContract, observed);
  if (!observed.ok || drift.length > 0) {
    return workflowPlanResult({
      ok: false,
      status: "HOLD",
      blockers: [...observed.blockers, ...drift],
      planId: plan.planId,
      planDigest: plan.planDigest,
      contractDigest: plan.contractDigest,
      currentBindings: observed.bindings
    });
  }
  await readFreshWorkflowPlanV1({
    root,
    planId: plan.planId,
    expected: {
      sourceRevision: observed.bindings.source.revision,
      sourceDigest: observed.bindings.source.digest,
      policyDigest: observed.bindings.policy.digest,
      templateDigest: observed.bindings.template.digest,
      routeDigest: observed.bindings.route.digest,
      routeReceiptId: observed.bindings.route.receiptId
    }
  });
  return workflowPlanResult({
    ok: true,
    status: "FRESH",
    planId: plan.planId,
    planDigest: plan.planDigest,
    contractDigest: plan.contractDigest,
    currentBindings: observed.bindings
  });
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
    if (!options.model) throw new Error("sbw doctor --agy requires --model <current-discovered-model-id>");
    agy = await doctorAgy({
      model: String(options.model)
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

function productQualificationScope(product, hostId, osId) {
  const scope = product.scope;
  const hostIncluded = scope ? scope.hostIds.includes(hostId) : null;
  const osIncluded = scope ? scope.hostOsIds.includes(osId) : null;
  return {
    productVersion: product.version,
    scopeId: scope?.id ?? null,
    scopeDigest: product.scopeDigest,
    hostId,
    osId,
    status: scope ? (hostIncluded && osIncluded ? "in-scope" : "deferred") : "legacy-registry",
    hostIncluded,
    osIncluded,
    deferredUntil: scope && !(hostIncluded && osIncluded) ? scope.deferredUntil : null,
    authority: "none"
  };
}

async function commandHost(root, subcommand, hostId, options) {
  if (subcommand === "binding") {
    assertKnownOptions(options, ["os"]);
    if (hostId !== "claude-code") throw new Error("host binding requires claude-code");
    const { observeClaudeHostBindingV1 } = await import("./lib/claude-host-binding-v1.mjs");
    return observeClaudeHostBindingV1({ osId: String(options.os ?? normalizeHostOs()) });
  }

  if (subcommand === "list") {
    assertKnownOptions(options, []);
    const [hosts, historicalMatrix, product, productMatrix] = await Promise.all([
      hostList(), releaseConformanceMatrix(), productReleaseScope(), productReleaseConformanceMatrix()
    ]);
    return {
      ok: true,
      ...hosts,
      releaseConformanceMatrix: historicalMatrix,
      currentProductScope: product,
      currentProductConformanceMatrix: productMatrix
    };
  }
  if (subcommand === "doctor") {
    assertKnownOptions(options, ["os"]);
    const requestedHost = String(hostId ?? "codex");
    const requestedOs = String(options.os ?? normalizeHostOs());
    const [doctor, product] = await Promise.all([
      hostDoctor({ hostId: requestedHost, osId: requestedOs }), productReleaseScope()
    ]);
    return { ...doctor, currentProductQualification: productQualificationScope(product, requestedHost, requestedOs) };
  }
  if (subcommand === "conformance") {
    assertKnownOptions(options, ["os", "write-receipt"]);
    const requestedHost = String(hostId ?? "codex");
    const requestedOs = String(options.os ?? normalizeHostOs());
    // Resolve product scope before a requested conformance receipt can be written.
    const currentProductQualification = productQualificationScope(
      await productReleaseScope(), requestedHost, requestedOs
    );
    if (currentProductQualification.status === "deferred") {
      return {
        schemaVersion: 1,
        kind: "HostConformanceDeferredV1",
        result: "HOLD",
        reason: "host-capability-unavailable:product-scope-deferred",
        hostId: requestedHost,
        osId: requestedOs,
        receiptPath: null,
        currentProductQualification
      };
    }
    const result = await hostConformance({
      hostId: requestedHost,
      osId: requestedOs,
      stateRoot: root,
      writeReceipt: optionEnabled(options["write-receipt"])
    });
    // This CLI annotation does not enter the conformance receipt or grant release authority.
    return {
      ...result,
      currentProductQualification
    };
  }
  throw new Error("host subcommand must be list, doctor, conformance, or binding");
}

async function commandWorkspace(root, subcommand, options) {
  if (subcommand === "preflight") {
    assertKnownOptions(options, ["intent", "task-id", "integration-target", "profile-target"]);
    return workspacePreflight({
      cwd: process.cwd(),
      stateRoot: root,
      intent: String(options.intent ?? "read-only"),
      taskId: options["task-id"] ? String(options["task-id"]) : null,
      integrationTarget: options["integration-target"] ? String(options["integration-target"]) : null,
      profileTarget: options["profile-target"] ? String(options["profile-target"]) : null
    });
  }
  if (subcommand === "create") {
    assertKnownOptions(options, ["goal", "task-id", "integration-target", "profile-target"]);
    if (!options.goal) throw new Error("workspace create requires --goal");
    return workspaceCreate({
      cwd: process.cwd(),
      stateRoot: root,
      goal: String(options.goal),
      taskId: options["task-id"] ? String(options["task-id"]) : null,
      integrationTarget: options["integration-target"] ? String(options["integration-target"]) : null,
      profileTarget: options["profile-target"] ? String(options["profile-target"]) : null
    });
  }
  if (subcommand === "register") {
    assertKnownOptions(options, ["task-id", "base-revision", "integration-target", "source-checkout", "source-branch"]);
    for (const required of ["task-id", "base-revision", "integration-target"]) {
      if (!options[required]) throw new Error(`workspace register requires --${required}`);
    }
    return workspaceRegister({
      cwd: process.cwd(),
      stateRoot: root,
      taskId: String(options["task-id"]),
      baseRevision: String(options["base-revision"]),
      integrationTarget: String(options["integration-target"]),
      sourceCheckout: options["source-checkout"] ? String(options["source-checkout"]) : null,
      sourceBranch: options["source-branch"] ? String(options["source-branch"]) : null
    });
  }
  if (subcommand === "validate") {
    assertKnownOptions(options, ["repository-id", "task-id", "check-file"]);
    for (const required of ["repository-id", "task-id", "check-file"]) {
      if (!options[required]) throw new Error(`workspace validate requires --${required}`);
    }
    const checks = JSON.parse(await readFile(path.resolve(String(options["check-file"])), "utf8"));
    return workspaceValidate({
      stateRoot: root,
      repositoryId: String(options["repository-id"]),
      taskId: String(options["task-id"]),
      checks
    });
  }
  if (subcommand === "integrate") {
    assertKnownOptions(options, ["repository-id", "task-id"]);
    if (!options["repository-id"] || !options["task-id"]) {
      throw new Error("workspace integrate requires --repository-id and --task-id");
    }
    return workspaceIntegrate({
      stateRoot: root,
      repositoryId: String(options["repository-id"]),
      taskId: String(options["task-id"])
    });
  }
  if (subcommand === "reconcile") {
    assertKnownOptions(options, ["repository-id", "task-id", "run-id"]);
    for (const required of ["repository-id", "task-id", "run-id"]) {
      if (!options[required]) throw new Error(`workspace reconcile requires --${required}`);
    }
    return workspaceReconcileProtected({
      stateRoot: root,
      repositoryId: String(options["repository-id"]),
      taskId: String(options["task-id"]),
      runId: String(options["run-id"])
    });
  }
  if (subcommand === "rebind") {
    assertKnownOptions(options, ["repository-id", "task-id", "integration-target"]);
    if (!options["repository-id"] || !options["task-id"] || !options["integration-target"]) {
      throw new Error("workspace rebind requires --repository-id, --task-id, and --integration-target");
    }
    return workspaceRebindTarget({
      stateRoot: root,
      repositoryId: String(options["repository-id"]),
      taskId: String(options["task-id"]),
      integrationTarget: String(options["integration-target"])
    });
  }
  if (subcommand === "cleanup") {
    assertKnownOptions(options, ["repository-id", "task-id"]);
    if (!options["repository-id"] || !options["task-id"]) {
      throw new Error("workspace cleanup requires --repository-id and --task-id");
    }
    return workspaceCleanup({
      stateRoot: root,
      repositoryId: String(options["repository-id"]),
      taskId: String(options["task-id"])
    });
  }
  if (subcommand === "status") {
    assertKnownOptions(options, ["repository-id", "task-id"]);
    if (!options["repository-id"] || !options["task-id"]) {
      throw new Error("workspace status requires --repository-id and --task-id");
    }
    return workspaceStatus({
      stateRoot: root,
      repositoryId: String(options["repository-id"]),
      taskId: String(options["task-id"])
    });
  }
  if (subcommand === "completion-notice") {
    assertKnownOptions(options, ["repository-id", "task-id"]);
    if (!options["repository-id"] || !options["task-id"]) {
      throw new Error("workspace completion-notice requires --repository-id and --task-id");
    }
    return workspaceDirectCompletionNotice({
      stateRoot: root,
      repositoryId: String(options["repository-id"]),
      taskId: String(options["task-id"])
    });
  }
  throw new Error("workspace subcommand must be preflight, create, register, validate, integrate, reconcile, rebind, cleanup, status, or completion-notice");
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
      "risk",
      "uncertainty",
      "blast-radius",
      "irreversibility",
      "evidence-gap",
      "hard-exclusion",
      "basic-check",
      "mutation",
      "acceptance-defined",
      "integration-target",
      "protected-target",
      "interaction-mode",
      "strict"
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
      autonomyProfile: null,
      risk: {
        risk: integer(options.risk, null),
        uncertainty: integer(options.uncertainty, null),
        blastRadius: integer(options["blast-radius"], null),
        irreversibility: integer(options.irreversibility, null),
        evidenceGap: integer(options["evidence-gap"], null)
      },
      hardExclusions: values(options["hard-exclusion"]).map(String),
      basicCheckPlan: values(options["basic-check"]).map(String),
      mutationIntent: String(options.mutation ?? "unknown"),
      acceptanceDefined: optionEnabled(options["acceptance-defined"]),
      integrationTarget: options["integration-target"] ? String(options["integration-target"]) : null,
      protectedTarget: optionEnabled(options["protected-target"]),
      interactionMode: optionEnabled(options.strict)
        ? "strict"
        : options["interaction-mode"] !== undefined
          ? String(options["interaction-mode"])
          : null
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

async function commandOfflineTry(positional, options) {
  assertKnownOptions(options, ["json", "timeout-ms"]);
  assertJsonOption(options);
  if (positional.length !== 1) {
    throw new Error("try does not accept positional arguments");
  }
  const rawTimeout = options["timeout-ms"];
  if (Array.isArray(rawTimeout) || rawTimeout === true || rawTimeout === false) {
    throw new Error("try --timeout-ms requires exactly one positive integer");
  }
  const timeoutMs = rawTimeout === undefined ? OFFLINE_TRY_MAX_MS : integer(rawTimeout);
  return runOfflineSbwTry({ timeoutMs });
}

function assertJsonOption(options) {
  if (options.json !== undefined && !optionEnabled(options.json)) {
    throw new Error("--json must be used as a flag");
  }
}

async function commandVersion(positional, options) {
  assertKnownOptions(options, ["json"]);
  assertJsonOption(options);
  if (positional.length !== 1) {
    throw new Error("version does not accept positional arguments");
  }
  const running = await captureRunningBundle();
  return { ok: true, running };
}

async function commandUpdate(root, subcommand, positional, options) {
  if (!subcommand || positional.length !== 2) {
    throw new Error("update requires exactly one subcommand: status, configure, or check");
  }
  if (subcommand === "status") {
    assertKnownOptions(options, ["json"]);
    assertJsonOption(options);
    const running = await captureRunningBundle();
    return { ok: true, ...(await readUpdateStatus({ root, running })) };
  }
  if (subcommand === "configure") {
    assertKnownOptions(options, ["mode", "json"]);
    assertJsonOption(options);
    if (options.mode === undefined || Array.isArray(options.mode)) {
      throw new Error("update configure requires exactly one --mode off|manual|automatic");
    }
    const mode = String(options.mode);
    if (!["off", "manual", "automatic"].includes(mode)) {
      throw new Error("update configure --mode must be off, manual, or automatic");
    }
    return { ok: true, ...(await configureUpdateMode(mode, { root })) };
  }
  if (subcommand === "check") {
    assertKnownOptions(options, ["json"]);
    assertJsonOption(options);
    const running = await captureRunningBundle();
    return {
      ok: true,
      ...(await checkForUpdates({ root, running, automatic: false }))
    };
  }
  throw new Error("update subcommand must be status, configure, or check");
}

function updateCiEnvironment(env = process.env) {
  return UPDATE_CI_ENVIRONMENT_KEYS.some((key) => {
    const value = env[key];
    return value !== undefined && value !== "";
  });
}

function emergencyUpdateCommand(positional = []) {
  const emergency = new Set(["stop", "pause", "resume", "recover", "cancel", "abort", "kill", "revoke"]);
  return positional.some((token) => emergency.has(token));
}

function automaticUpdateEligible({ command, options, positional = [], env = process.env } = {}) {
  if (!process.stdout.isTTY || !process.stderr.isTTY) return false;
  if (updateCiEnvironment(env)) return false;
  if (optionEnabled(options?.json)) return false;
  if (options?.help) return false;
  if (!command || command === "help" || command === "version" || command === "update") return false;
  if (!PUBLIC_AUTO_COMMANDS.has(command) || command === "try") return false;
  // Private host consent commands never enter update preparation.
  if (command === "host" && ["consent", "binding"].includes(positional[1])) return false;
  if (command === "eval") return false;
  if (command === "doctor" && optionEnabled(options?.capabilities)) return false;
  if (emergencyUpdateCommand(positional)) return false;
  return true;
}

function automaticUpdateDue(status, now = Date.now()) {
  if (!status || status.mode !== "automatic") return false;
  if (status.due === false) return false;
  if (status.nextCheckAt !== undefined && status.nextCheckAt !== null) {
    const next = typeof status.nextCheckAt === "number"
      ? status.nextCheckAt
      : Date.parse(String(status.nextCheckAt));
    if (Number.isFinite(next) && next > now) return false;
  }
  const last = typeof status.lastCheckedAt === "number"
    ? status.lastCheckedAt
    : Date.parse(String(status.lastCheckedAt ?? ""));
  if (Number.isFinite(last) && now - last < 24 * 60 * 60 * 1_000 && status.due !== true) return false;
  if (status.status === "disabled") return false;
  if (status.status === "skipped" && /not[-_ ]?due|recent|throttl|cooldown/i.test(String(status.reason ?? ""))) {
    return false;
  }
  return true;
}

async function prepareAutomaticUpdate(root, parsed) {
  const { positional, options } = parsed;
  const [command] = positional;
  if (!automaticUpdateEligible({ command, options, positional })) return null;
  try {
    const status = await readUpdateStatus({ root, running: null });
    if (!automaticUpdateDue(status)) return null;
    // Capture exactly once before main executes. The loaded bundle may be
    // changed by a long-running command, but the notice must describe the
    // bundle that started this invocation.
    return { running: await captureRunningBundle() };
  } catch {
    // Update notices are opportunistic. A status or digest failure must never
    // change the command's normal result or exit status.
    return null;
  }
}

async function finishAutomaticUpdate(root, context) {
  if (!context?.running) return;
  try {
    const result = await checkForUpdates({
      root,
      running: context.running,
      automatic: true
    });
    if (result?.status !== "available") return;
    const version = String(result.availableVersion ?? "new version").replace(/[\r\n]+/g, " ");
    const releaseUrl = result.releaseUrl
      ? ` ${String(result.releaseUrl).replace(/[\r\n]+/g, " ")}`
      : "";
    process.stderr.write(`sbw update available: ${version}${releaseUrl}\n`);
  } catch {
    // Explicit update commands expose the core result. The automatic hook is
    // intentionally quiet on auth, redirect, network, or persistence errors.
  }
}

async function commandEvidenceReplay(root, runId, options) {
  assertKnownOptions(options, ["no-open", "port"]);
  const noOpen = optionEnabled(options["no-open"]);
  const rawPort = options.port;
  if (rawPort !== undefined && (Array.isArray(rawPort) || typeof rawPort !== "string" || !/^(0|[1-9][0-9]{0,4})$/.test(rawPort))) {
    throw new Error("evidence replay --port requires an integer from 0 to 65535");
  }
  const port = rawPort === undefined ? REPLAY_PORT : Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("evidence replay --port requires an integer from 0 to 65535");
  }
  const replay = await startReplayServer({ stateRoot: root, runId, port });
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

async function commandDeliberation(subcommand, options) {
  const sharedOptions = ["provider", "allow-external-providers", "sanitized", "refresh", "reasoning-effort", "mode", "timeout-seconds"];
  assertKnownOptions(options, subcommand === "roster" ? sharedOptions : [...sharedOptions, "prompt-file"]);
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
    return deliberate({ ...common, prompt });
  }
  throw new Error("deliberation subcommand must be roster, deliberate, or arbitrate");
}

async function commandEvalSuites() {
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
    .filter(isEligibleFormalSuite)
    .sort()
    .map((name) => path.join(SCRIPT_DIR, "tests", name));
  if (tests.length === 0) throw new Error("No tests found");
  // Test fixtures use mkdtemp() beneath TMPDIR. Launchers are allowed to
  // provide a fresh, task-scoped TMPDIR that does not exist yet, so establish
  // and validate that root before spawning any child suite. This prevents one
  // missing parent from turning every fixture into an unrelated ENOENT burst.
  const suiteTempRoot = process.env.TMPDIR;
  if (suiteTempRoot) {
    if (!path.isAbsolute(suiteTempRoot) || path.resolve(suiteTempRoot) !== suiteTempRoot) {
      throw new Error("Evaluator TMPDIR must be an absolute path");
    }
    await mkdir(suiteTempRoot, { recursive: true, mode: 0o700 });
    const tempInfo = await lstat(suiteTempRoot);
    if (!tempInfo.isDirectory() || tempInfo.isSymbolicLink()) {
      throw new Error("Evaluator TMPDIR must be a physical directory");
    }
  }
  // Keep local and formal suite children on the same allowlisted tool PATH.
  // This prevents a host shell's partial PATH from turning every fixture that
  // spawns git/gh into an avoidable ENOENT cascade.
  const toolPath = await fixedToolPath();
  const suiteEnv = createFormalSuiteEnvironment(toolPath, process.env);
  // Keep at most three suites active while each suite remains a single-file
  // Node test process with --test-concurrency=1. The formal POSIX path uses
  // owned capture groups and waits for descendant cleanup before returning;
  // Windows formal evaluation remains outside the caffeinate host contract.
  return runFormalSuites({
    testPaths: tests,
    cwd: process.cwd(),
    repositoryRoot: path.resolve(SCRIPT_DIR, "../../.."),
    env: suiteEnv,
    nodePath: process.execPath,
    ...(formalProtectedCaptureClientV2() ? { capture: formalProtectedCaptureClientV2() } : {})
  });
}

async function commandEval(positional, options = {}) {
  return runEvalCommand(positional, options,
    { cwd: process.cwd(), scriptPath: fileURLToPath(import.meta.url), nodePath: process.execPath },
    { suites: commandEvalSuites, legacy: runFormalEvaluator, full: runFullFormalEvaluation });
}

function help() {
  return {
    usage: [
      "sbw version [--json]",
      "sbw update status [--json]",
      "sbw update configure --mode off|manual|automatic [--json]",
      "sbw update check [--json]",
      "sbw try [--timeout-ms <1..90000>] [--json]",
      "sbw incident help|create|report|read|show|list|revise|review|prepare-publication|verify-preparation|recovery prepare|recovery verify|recovery resume|revoke|delete ... (see sbw incident help)",
      "sbw knowledge help|validate|save|read|list|export|import|revoke|delete ... (see sbw knowledge help)",
      "sbw share help|validate|create|revise|read|list|export|revoke|expire ... (see sbw share help)",
      "sbw run --template auto --mode auto --interaction-mode <auto|strict> --goal <text> [--scope <path>]",
      "sbw run --route-receipt <route-receipt-id>",
      "sbw run --plan <plan-id> --command-binding-file <private-json> [--requested-model <model>] [--expires-at <ISO-8601>] [--canary-start-file <private-json>]",
      "sbw run --plan <plan-id> --command-binding-manifest <private-json> [--parallelism <1..64>] [--canary-start-file <private-json>]",
      "sbw workflow plan --contract <native-v3.json|v3-draft.json> [--plan-id <id>] [--goal <exact>] [--scope <exact-path>] [--template auto; required for draft]",
      "sbw workflow watch <run-id> [--json]",
      "sbw workflow pause <run-id> [--request-id <id>] [--wait-ms <0..10000>] [--json]",
      "sbw workflow resume <run-id> [--wait-ms <0..10000>] [--json]",
      "sbw workflow stop <run-id> [--request-id <id>] [--wait-ms <0..10000>] [--json]",
      "sbw workflow save <run-id> [--save-id <id>] [--file <state-root-relative-json>] [--json]",
      "sbw verify plan <plan-id> [--goal <exact>] [--scope <exact-path>] [--template auto]",
      "sbw verify run <plan-id> --repository </absolute/path-or-subdirectory> --task-id <id> --run-id <id> --epoch <n> [--unrelated-head <sha256>] [--json]",
      "sbw verify explain <plan-id> --repository </absolute/path-or-subdirectory> --task-id <id> [--receipt <state-root-relative-json>] [--json]",
      "sbw route preview --goal <text> [--scope <path>] [--entry auto|--template auto] [--mutation unknown|read-only|modify] [--acceptance-defined] [--risk 0..3 --uncertainty 0..3 --blast-radius 0..3 --irreversibility 0..3 --evidence-gap 0..3] [--hard-exclusion <code>] [--basic-check <label>] [--integration-target <branch> --protected-target] [--record]",
      "sbw route profile validate|install --file <profile.json>",
      "sbw route profile show",
      "sbw interaction preview --scope-file <scope.json> [--standing-file <standing.json>] [--interaction-mode auto|strict] [--stale-reason freshness|time|receipt-refresh|nonce-refresh|exact-binding-refresh]",
      "sbw status <run-id>",
      "sbw inspect <run-id>",
      "sbw metrics <run-id> | sbw metrics list|summary [--limit <1..500>]",
      "sbw metrics shadow --baseline-file <sanitized.json> --candidate-file <sanitized.json> --binding-file <binding.json>",
      "sbw resume <run-id>",
      "sbw cancel <run-id> [--reason <text>]",
      "sbw campaign status <run-id>",
      "sbw campaign renewal-request <run-id> --additional-repairs <1|2> --reason <text>",
      "sbw campaign renew <run-id> --file <host-signed-renewal-approval.json>",
      "sbw source rebind <run-id> --reason <text>",
      "sbw sentinel capture|verify <run-id> --label <label>",
      "sbw evidence add|supersede <run-id> --file <json>",
      "sbw evidence replay [<run-id>] [--no-open] [--port <0..65535>]",
      "sbw finding add|update <run-id> --file <json>",
      "sbw critic codex|agy <run-id> --model <model> --prompt-file <file> [--effort <auto|medium|high>] [--effort-transport <native|model-variant>]",
      "sbw critic native <run-id> --file <json> --reviewer-id <native-agent-id> --attestation <host-file>",
      "sbw critic native-sharded <run-id> --file <verified-input-json> --reviewer-id <id> --attestation <host-file>",
      "sbw deliberation roster [--reasoning-effort <auto|medium|high>] [--refresh] [--provider <id>] [--allow-external-providers --sanitized]",
      "sbw deliberation deliberate --prompt-file <sanitized-file> [--reasoning-effort <auto|medium|high>] [--refresh] [--allow-external-providers --sanitized]",
      "sbw deliberation arbitrate --prompt-file <sanitized-file> [--reasoning-effort <auto|medium|high>] [--allow-external-providers --sanitized]",
      "sbw graph validate [--template auto|--run <run-id>]",
      "sbw graph inspect (--template auto|--run <run-id>) [--format json|mermaid]",
      "sbw action issue <run-id> --action <kind> --provider <provider> --resource <id> --remote-revision <sha> [--scope <ref> --merge-method <merge|squash> --workflow-file <.github/workflows/file.yml> --input <key=value> ... --input-file <json>]",
      "sbw action consume|execute|reconcile <run-id> ...",
      "sbw resource register <run-id> --resource <id> --receipt <creation-receipt.json>",
      "sbw ledger status <run-id>",
      "sbw ledger transition <run-id> --file <event.json>",
      "sbw review package|diff|finding|status|repair|supersede|broad <run-id> ...",
      "sbw review diff <run-id> --package <package-id> [--native-evidence <evidence-id>]",
      "sbw review launch-native <run-id> --base <sha> --head <sha> --package <id> --package-file <json> --diff-manifest <json> --instruction <md> --authorization <json> --model <id> [--effort <effort>] --reviewer-id <id> --execution-id <id> --result <absent-json> [--shard-policy <json>]",
      "sbw review prepare-native <run-id> <same exact inputs except authorization> --shard-policy <json> (freeze plan only; no model execution)",
      "sbw review verify-native-shards <run-id> --receipt <aggregate-receipt-json> (replay proof; prepare input and signer binding without signing)",
      "sbw review plan <run-id> (native-review-sharded-v2; current schemaVersion 2 package; exact Git source plan only)",
      "sbw review run <run-id> --command </absolute/host> [--args-file <json>] --epoch <n> [--max-budget-file <json>] [--reservation-file <json>]",
      "sbw review progress <run-id> --command </absolute/host> [--args-file <json>] --epoch <n>",
      "sbw review resume <run-id> --command </absolute/host> [--args-file <json>] --epoch <new-n> --checkpoint <state/checkpoint.json> [--max-budget-file <json>] [--reservation-file <json>]",
      "sbw review aggregate <run-id> --command </absolute/host> [--args-file <json>] --epoch <n>",
      "sbw review replay <run-id> --command </absolute/host> [--args-file <json>] --epoch <n> --checkpoint <state/checkpoint.json> [--receipt <state/receipt.json>]",
      "sbw review plan-native-v2 <run-id> (current schemaVersion 2 package; exact Git source plan only)",
      "sbw review run-native-v2 <run-id> --command </absolute/host> [--args-file <json>] --epoch <n> [--max-budget-file <json>] [--reservation-file <json>]",
      "sbw review progress-native-v2 <run-id> --command </absolute/host> [--args-file <json>] --epoch <n>",
      "sbw review resume-native-v2 <run-id> --command </absolute/host> [--args-file <json>] --epoch <new-n> --checkpoint <state/checkpoint.json> [--max-budget-file <json>] [--reservation-file <json>]",
      "sbw review aggregate-native-v2 <run-id> --command </absolute/host> [--args-file <json>] --epoch <n>",
      "sbw review replay-native-v2 <run-id> --command </absolute/host> [--args-file <json>] --epoch <n> --checkpoint <state/checkpoint.json> [--receipt <state/receipt.json>]",
      "sbw complete <run-id>",
      "sbw doctor [--agy --model <model>]",
      "sbw doctor --capabilities",
      "sbw host list",
      "sbw host doctor [host-id] [--os macos|linux|windows]",
      "sbw host binding claude-code [--os macos]",
      "sbw host conformance [host-id] [--os macos|linux|windows] [--write-receipt]",
      "sbw workspace preflight [--intent read-only|modify] [--task-id <id>] [--integration-target <local-branch>] [--profile-target <local-branch>]",
      "sbw workspace create --goal <text> [--task-id <id>] [--integration-target <local-branch>] [--profile-target <local-branch>]",
      "sbw workspace register --task-id <id> --base-revision <sha> --integration-target <local-branch> [--source-checkout <path>] [--source-branch <local-branch>]",
      "sbw workspace validate --repository-id <id> --task-id <id> --check-file <checks.json>",
      "sbw workspace rebind --repository-id <id> --task-id <id> --integration-target <local-branch>",
      "sbw workspace integrate|cleanup|status|completion-notice --repository-id <id> --task-id <id>",
      "sbw workspace reconcile --repository-id <id> --task-id <id> --run-id <governed-run-id>",
      "sbw eval",
      "sbw eval --formal --expected-head <sha> --expected-base <sha> --launch-root </private/tmp/bw-*-formal-eval-*> [--replacement-reason host-sleep|sandbox-host-capability|launch-environment|command-interruption]",
      "sbw eval --formal-full --expected-head <sha> --expected-base <sha> --launch-root </private/tmp/bw-*-formal-eval-*> --node22 <absolute-node22> --node24 <absolute-node24> [--replacement-reason host-sleep --predecessor-completion <prior-launch-root/completion.json>]",
      "sbw cleanup [--older-than-days 30] [--apply]"
    ]
  };
}

async function main(parsed = parseArgs(process.argv.slice(2))) {
  const { positional, options } = parsed;
  const [command, subcommand, runId] = positional;
  const root = getStateRoot();
  // These commands belong to the owner-only snapshot. The public Auto
  // executable must reject them before dispatching any mutable handler.
  assertPublicAutoCommand(command, subcommand);
  if (!command || command === "help" || options.help) return help();
  if (command === "version") return commandVersion(positional, options);
  if (command === "update") return commandUpdate(root, subcommand, positional, options);
  if (command === "try") return commandOfflineTry(positional, options);
  if (command === "templates") return { ok: true, templates: await listTemplates() };
  if (command === "run") {
    if (options.plan !== undefined) {
      return commandRunPlan(root, positional, options);
    }
    return commandRun(root, options);
  }
  if (command === "workflow") return commandWorkflowPlan(root, subcommand, runId, options, positional);
  if (command === "verify" && subcommand === "plan") return commandVerifyPlan(root, runId, options);
  if (command === "verify" && VERIFICATION_CLI_ACTIONS.has(subcommand)) {
    return commandVerificationCli(root, subcommand, runId, options);
  }
  if (command === "graph") return commandGraph(root, subcommand, runId, options);
  if (command === "route") return commandRoute(root, subcommand, runId, options);
  if (command === "campaign") {
    if (!["status", "renewal-request", "renew"].includes(subcommand) || !runId) {
      throw new Error("campaign requires status, renewal-request, or renew and an exact run ID");
    }
    assertKnownOptions(options, subcommand === "status" ? [] : subcommand === "renewal-request"
      ? ["additional-repairs", "reason"] : ["file"]);
    const run = await loadRun(root, runId);
    if (subcommand === "status") return { ok: true, campaign: await campaignStatus(run) };
    if (subcommand === "renewal-request") {
      if (!/^[12]$/.test(String(options["additional-repairs"] ?? "")) || !options.reason) {
        throw new Error("campaign renewal-request requires --additional-repairs 1|2 and --reason");
      }
      return { ok: true, ...await prepareCampaignRenewal(run, {
        additionalRepairs: Number(options["additional-repairs"]), reason: String(options.reason)
      }), signerInvoked: false, grantsActionAuthority: false };
    }
    if (!options.file) throw new Error("campaign renew requires --file <host-signed-renewal-approval.json>");
    const file = path.resolve(String(options.file));
    const approval = await readJson(path.dirname(file), file);
    if (!approval || Object.keys(approval).sort().join("\0") !== "attestation\0request") {
      throw new Error("Campaign renewal approval must contain exactly request and attestation");
    }
    return { ok: true, ...await renewCampaign(run, approval), signerInvoked: false };
  }
  if (command === "interaction") {
    if (subcommand !== "preview") {
      throw new Error("interaction subcommand must be preview");
    }
    assertKnownOptions(options, ["scope-file", "standing-file", "interaction-mode", "strict", "stale-reason"]);
    if (!options["scope-file"]) {
      throw new Error("interaction preview requires --scope-file <scope.json>");
    }
    const scopeInput = JSON.parse(await readFile(path.resolve(String(options["scope-file"])), "utf8"));
    const scope = scopeInput?.scope && !Array.isArray(scopeInput.scope) ? scopeInput.scope : scopeInput;
    const mode = optionEnabled(options.strict)
      ? "strict"
      : String(options["interaction-mode"] ?? "auto");
    const request = buildInteractionRequest({ scope, mode });
    const standing = options["standing-file"]
      ? JSON.parse(await readFile(path.resolve(String(options["standing-file"])), "utf8"))
      : null;
    const decision = decideInteractionAuthorization({
      request,
      standingAuthorization: standing,
      staleReason: options["stale-reason"] ? String(options["stale-reason"]) : null
    });
    return {
      ok: decision.ok,
      request,
      decision,
      receipt: buildInteractionAuthorizationReceipt({ request, decision })
    };
  }
  if (command === "deliberation") return commandDeliberation(subcommand, options);
  if (command === "status") {
    const run = await loadRun(root, subcommand);
    if (run.manifest.template !== "auto" || run.contract.autonomyProfile != null ||
        run.manifest.autonomyProfile != null || run.state.autonomy != null) {
      throw publicAutoOnlyError();
    }
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
  if (command === "inspect") {
    const run = await loadRun(root, subcommand);
    if (run.manifest.template !== "auto" || run.contract.autonomyProfile != null ||
        run.manifest.autonomyProfile != null || run.state.autonomy != null) {
      throw publicAutoOnlyError();
    }
    return { ok: true, ...(await inspectRun(root, subcommand)) };
  }
  if (command === "metrics") {
    assertKnownOptions(options, ["limit", "baseline-file", "candidate-file", "binding-file"]);
    if (subcommand === "list") {
      return { ok: true, schemaVersion: 1, metrics: await listRunMetrics(root, { limit: options.limit ?? 50 }) };
    }
    if (subcommand === "summary") {
      const metrics = await listRunMetrics(root, { limit: options.limit ?? 500 });
      return { ok: true, summary: summarizeRunMetrics(metrics) };
    }
    if (subcommand === "shadow") {
      for (const option of ["baseline-file", "candidate-file", "binding-file"]) {
        if (!options[option]) throw new Error(`metrics shadow requires --${option}`);
      }
      const readInput = async (option, label) => {
        const file = path.resolve(String(options[option]));
        try {
          return JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
          throw new Error(`metrics shadow could not read ${label}: ${error.message}`);
        }
      };
      const [baseline, candidate, binding] = await Promise.all([
        readInput("baseline-file", "baseline metrics"),
        readInput("candidate-file", "candidate metrics"),
        readInput("binding-file", "comparison binding")
      ]);
      return { ok: true, shadow: compareShadowReplay({ baseline, candidate, binding }) };
    }
    if (!subcommand) throw new Error("metrics requires <run-id> or list");
    return { ok: true, metrics: await readRunMetrics(root, subcommand) };
  }
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
    if (run.manifest.template !== "auto") throw publicAutoOnlyError();
    if (run.contract.autonomyProfile != null || run.manifest.autonomyProfile != null ||
        run.state.autonomy != null) throw publicAutoOnlyError();
    assertMutableRun(run, "Run resume");
    let migration = { migrated: false };
    const template = await loadTemplate(run.manifest.template, run.contract.autoPolicy?.id);
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
    if (!["add", "supersede"].includes(subcommand) || !runId || !options.file) {
      throw new Error("evidence usage: sbw evidence add|supersede <run-id> --file <json> | sbw evidence replay [<run-id>] [--no-open] [--port <0..65535>]");
    }
    const record = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
    if (subcommand === "supersede") {
      return { ok: true, supersession: await supersedeEvidence(root, runId, record) };
    }
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
    if (["native", "native-sharded"].includes(subcommand)) {
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
      const sharded = subcommand === "native-sharded";
      if (!sharded && (input.review.reviewProtocol || input.review.shardProof)) {
        throw new Error("Sharded review evidence must use critic native-sharded; legacy admission cannot strip protocol proof");
      }
      if (sharded) {
        const { assertShardedReviewShape } = await import("./lib/native-review-shards.mjs");
        const { validateShardedReviewReceipt } = await import("./lib/native-review-runner.mjs");
        const proof = assertShardedReviewShape(input.review);
        const verified = await validateShardedReviewReceipt(proof.aggregateReceiptPath, {
          binding: { runId, repository: run.manifest.cwd, base: review.package.base, head: review.package.head,
            packageId: review.package.packageId, instructionSha256: review.package.instructionDigest,
            model: String(input.model), reviewerId: input.reviewerId, executionId: input.executionId }, reviewPackage: review.package
        });
        if (digestObject(verified.nativeInput) !== digestObject(input)) throw new Error("Native sharded input differs from replay-verified evidence");
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
        sentinelDigest,
        ...(sharded ? { executionId: input.executionId } : {})
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
        ...(sharded ? { executionId: input.executionId } : {}),
        executionDigest: digestObject({
          provider: "codex-native-subagent",
          model: attestation.model,
          modelAssurance: "host-signed-attestation",
          trustAttested: true,
          promptDigest: binding.promptDigest,
          reviewDigest: binding.reviewDigest,
          transport: "native-subagent",
          sandbox: "read-only",
          ...(sharded ? { executionId: input.executionId } : {})
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
        nativeReviewer: { id: binding.reviewerId, attestationDigest: attestation.attestationDigest,
          ...(sharded ? { executionId: input.executionId, attestationPath: attestation.attestationPath,
            attestationFileDigest: attestation.fileDigest } : {}) },
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
    if (subcommand === "agy" && !options.model) {
      throw new Error("Agy critic requires --model <current-discovered-model-id>");
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
              const model = String(options.model);
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
        "workflow-file", "input", "input-file", "merge-method"
      ]);
      const run = await loadRun(root, runId);
      const template = await loadTemplate(run.manifest.template, run.contract.autoPolicy?.id);
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
      if (action !== "pr.merge" && options["merge-method"] !== undefined) {
        throw new Error("--merge-method is only valid for pr.merge");
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
      const freshness = await refreshEvidence(root, runId);
      if (freshness.immutableStale.length > 0) {
        throw new Error(`Action token denied by stale immutable supersession evidence: ${freshness.immutableStale.join(", ")}`);
      }
      if (run.contract.templateDigest !== digestObject(template)) {
        throw new Error("Workflow template drifted after run creation");
      }
      await assertPublicAutoActionBoundary(root, runId, action);
      let digest;
      if (
        run.contract.schemaVersion === 2 &&
        run.contract.controlPlane?.reviewPolicy !== "none" &&
        completedReviewRequiredForAction(action)
      ) {
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
            mergeMethod: options["merge-method"] ? String(options["merge-method"]) : undefined,
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
    throw new Error("ledger subcommand must be status or transition");
  }
  if (command === "review") {
    if (!runId) throw new Error("review requires run id");
    if (NATIVE_REVIEW_V2_ACTIONS.has(subcommand)) {
      return commandReviewNativeV2(root, runId, subcommand, options);
    }
    if (subcommand === "verify-native-shards") {
      assertKnownOptions(options, ["receipt"]);
      if (!options.receipt) throw new Error("review verify-native-shards requires --receipt");
      const run = await loadRun(root, runId), status = await reviewStatus(root, runId);
      if (!status.package) throw new Error("Sharded verification requires a current immutable package");
      const { validateShardedReviewReceipt } = await import("./lib/native-review-runner.mjs");
      const verified = await validateShardedReviewReceipt(path.resolve(String(options.receipt)), {
        binding: { runId, repository: run.manifest.cwd, base: status.package.base, head: status.package.head,
          packageId: status.package.packageId, instructionSha256: status.package.instructionDigest }, reviewPackage: status.package
      });
      return { ok: true, receiptSha256: verified.receiptSha256, nativeInput: verified.nativeInput, signerBinding: verified.signerBinding };
    }
    if (["launch-native", "prepare-native"].includes(subcommand)) {
      assertKnownOptions(options, [
        "base", "head", "package", "package-file", "diff-manifest", "instruction",
        "authorization", "model", "effort", "reviewer-id", "execution-id", "result", "shard-policy"
      ]);
      for (const required of [
        "base", "head", "package", "package-file", "diff-manifest", "instruction",
        ...(subcommand === "launch-native" ? ["authorization"] : ["shard-policy"]),
        "model", "reviewer-id", "execution-id", "result"
      ]) {
        if (!options[required]) throw new Error(`review launch-native requires --${required}`);
      }
      const run = await loadRun(root, runId);
      return runNativeReview({
        runId,
        runDir: run.runDir,
        cwd: run.manifest.cwd,
        base: String(options.base),
        head: String(options.head),
        packageId: String(options.package),
        packagePath: String(options["package-file"]),
        manifestPath: String(options["diff-manifest"]),
        instructionPath: String(options.instruction),
        authorizationPath: options.authorization === undefined ? null : String(options.authorization),
        shardPolicyPath: options["shard-policy"] === undefined ? null : String(options["shard-policy"]),
        prepareOnly: subcommand === "prepare-native",
        model: String(options.model),
        effort: options.effort === undefined ? "max" : String(options.effort),
        reviewerId: String(options["reviewer-id"]),
        executionId: String(options["execution-id"]),
        resultPath: String(options.result)
      });
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
          campaign: review.campaign,
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
      assertKnownOptions(options, ["base", "head", "diff-manifest", "instruction", "instruction-digest", "sentinel-digest", "scope"]);
      if (!options.base || !options.head || !options["diff-manifest"] || !options.instruction || !options["instruction-digest"] || !options["sentinel-digest"]) {
        throw new Error("review package requires --base, --head, --diff-manifest, --instruction, --instruction-digest, and --sentinel-digest");
      }
      const diffManifest = JSON.parse(await readFile(path.resolve(String(options["diff-manifest"])), "utf8"));
      const reviewPackage = await createReviewPackage({
        root,
        runId,
        base: String(options.base),
        head: String(options.head),
        scope: values(options.scope, ["."]).map(String),
        instructionPath: path.resolve(String(options.instruction)),
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
    if (subcommand === "diff") {
      assertKnownOptions(options, ["package", "native-evidence"]);
      if (!options.package) throw new Error("review diff requires --package <package-id>");
      return {
        ok: true,
        evidence: await recordDiffReviewFromNative(
          root,
          runId,
          String(options.package),
          options["native-evidence"] ? String(options["native-evidence"]) : null
        )
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
    if (subcommand === "supersede") {
      assertKnownOptions(options, ["file"]);
      if (!options.file) throw new Error("review supersede requires --file <supersession.json>");
      const record = JSON.parse(await readFile(path.resolve(String(options.file)), "utf8"));
      return {
        ok: true,
        supersession: await supersedeReviewEvidence(root, runId, record)
      };
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
    throw new Error("review subcommand must be plan, run, progress, resume, aggregate, replay, package, diff, finding, prepare-native, launch-native, verify-native-shards, status, repair, supersede, or broad");
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
  if (command === "host") return commandHost(root, subcommand, runId, options);
  if (command === "workspace") return commandWorkspace(root, subcommand, options);
  if (command === "eval") return commandEval(positional, options);
  if (command === "cleanup") {
    const defaults = await loadDefaults();
    return cleanupRuns(root, {
      olderThanDays: integer(options["older-than-days"], defaults.retentionDays),
      apply: options.apply === true || options.apply === "true"
    });
  }
  throw new Error(`Unknown command: ${command}`);
}

async function launch() {
  const rawArgv = process.argv.slice(2);
  if (rawArgv[0] === "incident") {
    const result = await runIncidentCli(rawArgv.slice(1), {
      env: process.env,
      cwd: process.cwd(),
      recoveryContextFactory: (request) => createSbwIncidentRecoveryContext(request)
    });
    print(result.value);
    process.exitCode = result.exitCode;
    return;
  }
  if (rawArgv[0] === "knowledge") {
    const result = await runKnowledgeCli(rawArgv.slice(1), {
      env: process.env,
      cwd: process.cwd()
    });
    print(result.value);
    process.exitCode = result.exitCode;
    return;
  }
  if (rawArgv[0] === "share") {
    const result = await runShareCli(rawArgv.slice(1), {
      env: process.env,
      cwd: process.cwd()
    });
    print(result.value);
    process.exitCode = result.exitCode;
    return;
  }
  const parsed = parseArgs(rawArgv);
  assertPublicAutoCommand(parsed.positional[0], parsed.positional[1]);
  if (parsed.positional[0] === "eval") {
    const evalHelp = parsed.options.help === true || parsed.options.help === "true";
    if (Object.hasOwn(parsed.options, "help") && !evalHelp) throw new Error("eval --help must be one true flag");
    if (!evalHelp) parseEvalInvocation(parsed.positional, parsed.options);
  }
  const updateRoot = getStateRoot();
  const automaticUpdate = await prepareAutomaticUpdate(updateRoot, parsed);
  try {
    const result = await main(parsed);
    if (result !== undefined) print(result);
    if (result?.ok === false || (result?.kind === "ClaudeHostBindingObservationV1" && result.result === "HOLD")) process.exitCode = 2;
    if (result?.ok !== false) await finishAutomaticUpdate(updateRoot, automaticUpdate);
  } catch (error) {
    fail(error, error?.exitCode ?? 1);
  }
}

launch().catch((error) => fail(error, error?.exitCode ?? 1));
