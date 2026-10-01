// SPDX-License-Identifier: AGPL-3.0-only
// Fixed installed producer. Candidate data and caller PASS never supply trust.
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { canonicalJson } from "./core.mjs";
import { snapshotJsonDataV1 } from "./private-input-snapshot-v1.mjs";
import { parseStrictJsonV1 } from "./strict-json-v1.mjs";
import { formalEvaluatorState, evaluateFormalAttemptBudget, captureFormalSuiteManifest, fixedToolPath, stableBootIdentity } from "./formal-evaluator.mjs";
import { FORMAL_FULL_PROFILE, FORMAL_OPERATION_TIMEOUT_MS } from "./formal-operation.mjs";
import { formalCaptureObservation, formalSuiteCommand, FORMAL_SUITE_CONCURRENCY, FORMAL_SUITE_TIMEOUT_MS,
  FORMAL_SUITE_MAX_OUTPUT_BYTES } from "./formal-suite-runner.mjs";
import { createFormalSuiteEnvironment } from "./formal-environment.mjs";
import { parseSleepWakeCounters, parseSleepWakeUuid } from "./formal-host-power.mjs";
import { canonicalGovernedGithubRepository } from "./git-observation-v1.mjs";
import { FORMAL_PROTECTED_POLICY_PATH_V2, FORMAL_PROTECTED_ARTIFACT_ROOT_V2,
  FORMAL_PROTECTED_PURPOSE, FORMAL_PROTECTED_AUDIENCE, validateFormalProtectedPolicyV2,
  inspectFormalProtectedExecutionArtifactsV2, inspectFormalProtectedBundleV2,
  inspectInstalledFormalProtectedBundleV2 } from "./formal-protected-admission-v1.mjs";
import { FORMAL_PROTECTED_PRIVATE_KEY_ROOT_V2, prepareFormalProtectedObserverInstallV2 } from "./formal-protected-observer-preparation-v2.mjs";
import { assertRootOwnedRuntimePathV2, observeRootOwnedRuntimeFileV2, readBoundedRuntimeFileV2,
  readInstalledRuntimeQualificationTargetV2, assertRuntimeQualificationTargetCurrentV2,
  observeRuntimeSourceTreeV2 } from "./runtime-qualification-v2.mjs";
import { runtimeGithubReadV2 } from "./github-runtime-attestation-v2.mjs";
import { runFullFormalEvaluation } from "./formal-supervisor.mjs";
import { formalProtectedCaptureContextV2 } from "./formal-protected-capture-client-v2.mjs";

export const FORMAL_OBSERVER_INSTALLATION_PATH_V2 = "/private/etc/better-workflows/formal-observer-installation-v2.json";
const ENTRY = "plugins/better-workflows/scripts/formal-protected-observer-v2.mjs";
const INSTALL_ENTRY = "plugins/better-workflows/scripts/install-protected-formal-observer-v2.mjs";
const LIB_ENTRY = "plugins/better-workflows/scripts/lib/formal-protected-observer-v2.mjs";
const SUPERVISOR = "plugins/better-workflows/scripts/lib/formal-supervisor.mjs";
const SCRIPT = "plugins/better-workflows/scripts/sbw.mjs";
const ROLES = Object.freeze(["aggregate", "commit-intent", "completion", "ledger-export", "node22-observations",
  "node24-observations", "provisional", "release-intent", "release-record", "suite-manifest"]);
const SHA40 = /^[a-f0-9]{40}$/, SHA256 = /^[a-f0-9]{64}$/;
const MAX_RECORD = 2 * 1024 * 1024, MAX_REQUEST = 1024 * 1024, MAX_CAPTURE = 64 * 1024 * 1024;
const CLEAN_ENV = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C",
  HOME: "/var/root", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" });
const exec = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = value => Buffer.from(canonicalJson(value));
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const absolute = value => typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ownedBrokers = new WeakSet();

export class FormalProtectedObserverHoldV2 extends Error {
  constructor(code, message) { super(message); this.name = "FormalProtectedObserverHoldV2"; this.code = code;
    this.status = "HOLD"; this.authority = "none"; this.releaseEligible = false; }
}
function hold(code, message) { throw new FormalProtectedObserverHoldV2(code, message); }
function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) hold("EFORMAL_OBSERVER_INPUT", `${label} has missing or unexpected fields`);
}
function snapshot(value, maxBytes = MAX_REQUEST) {
  return parseStrictJsonV1(JSON.stringify(snapshotJsonDataV1(value, { maxBytes })), { maxBytes });
}
function parse(bytes, maxBytes = MAX_RECORD, canonical = false) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = parseStrictJsonV1(text, { maxBytes });
  if (!Buffer.from(text).equals(Buffer.from(bytes)) || (canonical && !jsonBytes(value).equals(Buffer.from(bytes)))) {
    hold("EFORMAL_OBSERVER_JSON", "Protected JSON bytes are not lossless/canonical");
  }
  return value;
}
function checkRoot() {
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) {
    hold("EFORMAL_OBSERVER_ROOT", "Installed formal observer requires root macOS ARM64 execution");
  }
  if (process.execArgv.length !== 0 || Object.keys(process.env).some(key => /^(?:NODE_OPTIONS|NODE_PATH|DYLD_|LD_)/.test(key))) {
    hold("EFORMAL_OBSERVER_ENVIRONMENT", "Privileged invocation requires the reviewed clean Node environment");
  }
}
export function inspectFormalObserverRequestV2(request) {
  const value = snapshot(request, 4096);
  exact(value, ["expectedHead", "expectedBase"], "installed observer request");
  if (!SHA40.test(value.expectedHead) || !SHA40.test(value.expectedBase)) hold("EFORMAL_OBSERVER_INPUT", "Observer requires exact HEAD and base");
  return Object.freeze(value);
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function exclusiveFile(file, bytes, mode = 0o600) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}
async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function protectedDirectory(directory, mode = 0o700) {
  await assertRootOwnedRuntimePathV2(directory, { directory: true });
  if (((await lstat(directory)).mode & 0o777) !== mode) hold("EFORMAL_OBSERVER_FILESYSTEM", "Protected directory has unexpected mode");
}
async function protectedBytes(file, maxBytes = MAX_RECORD, mode = 0o600) {
  return (await observeRootOwnedRuntimeFileV2(file, { maxBytes, exactMode: mode, includeBytes: true })).bytes;
}
async function protectedStreamBytes(file, maxBytes) {
  await assertRootOwnedRuntimePathV2(file);
  if (((await lstat(file)).mode & 0o777) !== 0o600) hold("EFORMAL_OBSERVER_FILESYSTEM", "Actual root stream has unexpected mode");
  // Empty stdout/stderr are valid actual capture data. The generic policy
  // reader intentionally disallows empty receipts; streams use its bounded,
  // single-link physical reader and retain root checks on both sides.
  const bytes = await readBoundedRuntimeFileV2(file, maxBytes);
  await assertRootOwnedRuntimePathV2(file);
  return bytes;
}
async function ensureProtectedDirectory(directory, mode) {
  if (!absolute(directory) || directory === "/") hold("EFORMAL_OBSERVER_FILESYSTEM", "Installation directory is invalid");
  if (await exists(directory)) return protectedDirectory(directory, mode);
  const parent = path.dirname(directory);
  if (!(await exists(parent))) await ensureProtectedDirectory(parent, 0o755);
  await assertRootOwnedRuntimePathV2(parent, { directory: true });
  await mkdir(directory, { mode }); await chmod(directory, mode); await syncDirectory(parent);
  await protectedDirectory(directory, mode);
}
async function verifyManifestFiles(root, manifest) {
  await assertRootOwnedRuntimePathV2(root, { directory: true });
  for (const file of manifest) {
    const absoluteFile = path.join(root, file.path);
    await assertRootOwnedRuntimePathV2(absoluteFile);
    const bytes = await readBoundedRuntimeFileV2(absoluteFile, 64 * 1024 * 1024);
    if (hash(bytes) !== file.sha256) hold("EFORMAL_OBSERVER_IMAGE", "Installed transitive image byte differs from its reviewed manifest");
  }
}
async function verifyManifest(root, manifest) {
  await verifyManifestFiles(root, manifest);
  // No additional module/configuration can be introduced beside pinned code.
  const expected = new Set(manifest.map(file => file.path));
  const expectedDirectories = new Set([""]);
  for (const file of manifest) { let parent = path.posix.dirname(file.path);
    while (parent !== ".") { expectedDirectories.add(parent); parent = path.posix.dirname(parent); } }
  const stack = [""];
  while (stack.length) {
    const relative = stack.pop(), directory = path.join(root, relative);
    await assertRootOwnedRuntimePathV2(directory, { directory: true });
    for (const name of await readdir(directory)) {
      const child = relative ? `${relative}/${name}` : name, file = path.join(root, child), info = await lstat(file);
      if (info.isDirectory() && !info.isSymbolicLink() && expectedDirectories.has(child)) stack.push(child);
      else if (!info.isFile() || info.isSymbolicLink() || !expected.delete(child)) hold("EFORMAL_OBSERVER_IMAGE", "Installed image contains an unmanifested or nonphysical entry");
    }
  }
  if (expected.size) hold("EFORMAL_OBSERVER_IMAGE", "Installed image manifest is incomplete");
}
async function loadInstalled(role = "installed-image") {
  const receiptBytes = await protectedBytes(FORMAL_OBSERVER_INSTALLATION_PATH_V2, MAX_REQUEST * 2, 0o644);
  const installation = parse(receiptBytes, MAX_REQUEST * 2, true);
  exact(installation, ["schemaVersion", "kind", "request", "requestSha256", "preparationSha256", "policySha256", "publicKey", "keySha256"], "installation receipt");
  const prepared = prepareFormalProtectedObserverInstallV2(installation.request), request = installation.request;
  const imageRoot = request.controllerImage.root;
  if (!["installed-image", "public-worker"].includes(role) || installation.schemaVersion !== 2 || installation.kind !== "FormalProtectedObserverInstallationV2" ||
      installation.requestSha256 !== prepared.requestSha256 || installation.preparationSha256 !== prepared.preparationSha256 ||
      sourceRoot !== (role === "public-worker" ? request.executionSourceRoot : imageRoot) ||
      request.controllerImage.entrypoint !== path.join(imageRoot, ENTRY)) {
    hold("EFORMAL_OBSERVER_IMAGE", "Observer is not executing its fixed installed image or public worker role");
  }
  // The image remains a separate, complete installation in both roles. The
  // public worker additionally proves its actual literal-import source bytes.
  await verifyManifest(imageRoot, request.sourceManifest);
  if (role === "public-worker") await verifyManifestFiles(sourceRoot, request.sourceManifest);
  for (const runtime of request.runtimeLanes) {
    const observed = await observeRootOwnedRuntimeFileV2(runtime.path, { maxBytes: 512 * 1024 * 1024, executable: true });
    if (observed.sha256 !== runtime.executableSha256) hold("EFORMAL_OBSERVER_RUNTIME", "Runtime differs from the installed pin");
  }
  if (process.execPath !== request.runtimeLanes[0].path || process.versions.node !== request.runtimeLanes[0].nodeVersion) {
    hold("EFORMAL_OBSERVER_RUNTIME", "Observer must execute with the installed Node 22 lane binary");
  }
  const policyBytes = await protectedBytes(FORMAL_PROTECTED_POLICY_PATH_V2, 64 * 1024, 0o644), policy = parse(policyBytes, 64 * 1024, true);
  validateFormalProtectedPolicyV2(policy);
  if (hash(policyBytes) !== installation.policySha256 || policy.observerImageSha256 !== request.controllerImage.manifestSha256 ||
      policy.issuer !== request.issuer || policy.ledgerEpoch !== request.ledgerEpoch || !same(policy.publicTarget, request.publicTarget) ||
      policy.expectedBase !== request.expectedBase || policy.executionSourceRoot !== request.executionSourceRoot ||
      !same(policy.suiteIdentity, request.suiteIdentity) || !same(policy.runtimePaths, Object.fromEntries(request.runtimeLanes.map(r => [r.id, r.path]))) ||
      !same(policy.runtimeLanes, request.runtimeLanes.map(({ path: _path, ...r }) => r))) hold("EFORMAL_OBSERVER_POLICY", "Installed policy differs from its exact installation receipt");
  const key = policy.keys.find(entry => entry.keyId === request.keyId);
  if (!key || key.status !== "active" || key.publicKey !== installation.publicKey) hold("EFORMAL_OBSERVER_REVOKED", "Dedicated formal observer key is absent, altered or revoked");
  return { installation, request, prepared, policy, policyBytes, receiptBytes };
}
async function currentInstalled(original) {
  const current = await loadInstalled();
  if (!current.policyBytes.equals(original.policyBytes) || !current.receiptBytes.equals(original.receiptBytes)) {
    hold("EFORMAL_OBSERVER_REVOKED", "Installation, image or revocation changed across capture/sign/persist");
  }
}
async function suiteProcesses(uid) {
  const { stdout } = await exec("/bin/ps", ["-axo", "uid=,pid=,ppid=,pgid="], { env: CLEAN_ENV, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").filter(line => line.trim()).map(line => {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/.exec(line);
    if (!match) hold("EFORMAL_OBSERVER_CLEANUP", "Suite identity process observation is unreadable");
    return { uid: Number(match[1]), pid: Number(match[2]), ppid: Number(match[3]), pgid: Number(match[4]) };
  }).filter(row => row.uid === uid);
}
async function assertSuiteIdle(policy) {
  const processes = await suiteProcesses(policy.suiteIdentity.uid);
  if (processes.length) {
    const error = new FormalProtectedObserverHoldV2("EFORMAL_OBSERVER_CLEANUP", "Dedicated suite identity has live processes; no cleanup/sign/retry admission");
    error.ownedResourceCandidates = processes; throw error;
  }
}
async function observePublicSource(installed) {
  const snapshot = await readInstalledRuntimeQualificationTargetV2(), target = snapshot.targetPolicy, policy = installed.policy;
  if (!same({ repository: target.repository, sourceRevision: target.sourceRevision, sourceRef: target.sourceRef }, policy.publicTarget)) {
    hold("EFORMAL_OBSERVER_TARGET", "Installed runtime target and formal public projection differ");
  }
  const read = async endpoint => parse(Buffer.from(await runtimeGithubReadV2(["api", endpoint], { targetPolicy: target })), 4 * 1024 * 1024);
  const endpoint = `repos/${target.repository.name}`, repository = await read(endpoint), branch = await read(`${endpoint}/git/ref/heads/main`);
  if (String(repository.id) !== target.repository.id || repository.full_name !== target.repository.name || repository.private !== false ||
      repository.archived !== false || repository.disabled !== false || branch.ref !== target.sourceRef ||
      branch.object?.type !== "commit" || branch.object.sha !== policy.publicTarget.sourceRevision) hold("EFORMAL_OBSERVER_TARGET", "Live numeric/public repository or main commit differs");
  const commit = await read(`${endpoint}/git/commits/${target.sourceRevision}`);
  if (commit.sha !== target.sourceRevision || !SHA40.test(commit.tree?.sha ?? "")) hold("EFORMAL_OBSERVER_TARGET", "Public commit/tree binding is invalid");
  const tree = await read(`${endpoint}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.sha !== commit.tree.sha || tree.truncated !== false || !Array.isArray(tree.tree)) hold("EFORMAL_OBSERVER_TARGET", "Public tree is incomplete");
  const observation = await observeRuntimeSourceTreeV2({ sourceRoot: policy.executionSourceRoot, treeRecords: tree.tree });
  const image = new Map(installed.request.sourceManifest.map(file => [file.path, file.sha256]));
  for (const file of observation.files) {
    await assertRootOwnedRuntimePathV2(path.join(policy.executionSourceRoot, file.path));
    // Every actual control module/configuration under the plugin is covered.
    // Public workload/docs outside it are independently bound by live commit
    // and the complete raw Git tree; private image provenance is not used as
    // evidence that those public bytes were published.
    if ((file.path.startsWith("plugins/better-workflows/") || ["package.json", "package-lock.json"].includes(file.path)) &&
        image.get(file.path) !== file.sha256) hold("EFORMAL_OBSERVER_IMAGE", "Actual public control bytes are not covered by the installed transitive image closure");
  }
  // Git metadata can affect the actual fixed wrapper even when every public
  // worktree byte is pinned. A protected .git parent does not protect a
  // caller-owned config/ref/object leaf; reject that before any workload.
  const metadata = [path.join(policy.executionSourceRoot, ".git")];
  let metadataCount = 0;
  while (metadata.length) {
    if (++metadataCount > 100_000) hold("EFORMAL_OBSERVER_TARGET", "Public Git metadata exceeds its fixed inspection bound");
    const entry = metadata.pop(), info = await lstat(entry);
    await assertRootOwnedRuntimePathV2(entry, { directory: info.isDirectory() });
    if (info.isDirectory()) for (const name of await readdir(entry)) metadata.push(path.join(entry, name));
  }
  const { stdout: head } = await exec("/usr/bin/git", ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "rev-parse", "--verify", "HEAD^{commit}"],
    { cwd: policy.executionSourceRoot, env: CLEAN_ENV, timeout: 10_000, maxBuffer: 4096 });
  if (head.trim() !== target.sourceRevision) hold("EFORMAL_OBSERVER_TARGET", "Actual public execution checkout HEAD differs");
  await assertRuntimeQualificationTargetCurrentV2(snapshot);
  return { snapshot, sourceInventoryDigest: observation.sourceInventoryDigest, sourceSnapshotDigest: observation.sourceSnapshotDigest };
}

// This source disposition is image-bound. A caller JSON/environment value
// cannot resolve the required architecture checkpoint or enable signing.
export const FORMAL_OBSERVER_CAPTURE_BOUNDARY_V2 = "root-individual-suite-capture-v2";

export function inspectFormalObserverAttemptSelectionV2({ policy, ledger, predecessorObservation, predecessorLedger }) {
  validateFormalProtectedPolicyV2(policy);
  if (ledger === null) {
    if (predecessorObservation !== null || predecessorLedger !== null) hold("EFORMAL_OBSERVER_HISTORY", "Primary cannot import predecessor data");
    return Object.freeze({ terminalSequence: 1, replacementReason: null, predecessorBundleSha256: null });
  }
  exact(ledger, ["schemaVersion", "kind", "repository", "expectedHead", "expectedBase", "ledgerEpoch", "attempts"], "protected attempt ledger");
  if (ledger.schemaVersion !== 2 || ledger.kind !== "FormalProtectedAttemptLedgerV2" ||
      !same(ledger.repository, policy.publicTarget.repository) || ledger.expectedHead !== policy.publicTarget.sourceRevision ||
      ledger.expectedBase !== policy.expectedBase || ledger.ledgerEpoch !== policy.ledgerEpoch || !Array.isArray(ledger.attempts) ||
      ledger.attempts.length !== 1) hold("EFORMAL_OBSERVER_HISTORY", "Exact repository/HEAD budget cannot be reset or extended");
  const prior = ledger.attempts[0];
  exact(prior, ["terminalSequence", "reservationSha256", "bundleSha256", "status"], "protected first attempt");
  if (prior.status !== "terminal" || prior.terminalSequence !== 1 || !SHA256.test(prior.bundleSha256) || !SHA256.test(prior.reservationSha256)) {
    hold("EFORMAL_OBSERVER_RESERVED", "Unknown/reserved first attempt remains consumed; reconcile without relaunch");
  }
  const classification = predecessorObservation?.failureClassification;
  if (predecessorObservation?.qualificationStatus !== "blocked" || classification?.failureClass !== "INFRASTRUCTURE" ||
      typeof classification.eligibleReplacementReason !== "string" || !predecessorLedger?.attempts ||
      predecessorLedger.attempts.length !== 1 || predecessorObservation.bundleSha256 !== prior.bundleSha256) {
    hold("EFORMAL_OBSERVER_BUDGET", "Protected predecessor does not authorize an infrastructure replacement");
  }
  const reason = classification.eligibleReplacementReason;
  evaluateFormalAttemptBudget(predecessorLedger.attempts, reason);
  return Object.freeze({ terminalSequence: 2, replacementReason: reason, predecessorBundleSha256: prior.bundleSha256 });
}
async function readClosure(namespace, head, sequence) {
  const directory = path.join(namespace, `attempt-${sequence}`);
  await protectedDirectory(directory);
  const bundle = parse(await protectedBytes(path.join(directory, "bundle.json")), MAX_RECORD, true);
  const artifactBytes = {};
  for (const role of ROLES) artifactBytes[role] = await protectedBytes(path.join(directory, `${head}-attempt-${sequence}-${role}.json`));
  return { bundle, artifactBytes, reservationBytes: await protectedBytes(path.join(directory, "reservation.json"), 256 * 1024) };
}
async function writeLedger(namespace, ledger, expectedBytes) {
  const file = path.join(namespace, "attempt-ledger.json"), bytes = jsonBytes(ledger);
  if (expectedBytes === null) return exclusiveFile(file, bytes);
  if (!(await protectedBytes(file, 256 * 1024)).equals(expectedBytes)) hold("EFORMAL_OBSERVER_HISTORY", "Protected attempt prefix changed before ledger transition");
  const temporary = path.join(namespace, `.ledger-${randomBytes(16).toString("hex")}.tmp`);
  await exclusiveFile(temporary, bytes); await rename(temporary, file); await syncDirectory(namespace);
  if (!(await protectedBytes(file, 256 * 1024)).equals(bytes)) hold("EFORMAL_OBSERVER_HISTORY", "Protected ledger terminal transition is unknown");
}

// Root keeper is the stable PGID owner and the actual target's parent. It
// clears supplementary groups while still root, then drops UID/GID only in
// the target spawn. Workload stdio has no inherited control descriptor.
const ROOT_KEEPER = `/* BW_FIXED_ROOT_FORMAL_KEEPER_V2 */
const {spawn}=require('node:child_process');
const options=JSON.parse(process.argv[1]);
if(process.getuid()!==0)throw new Error('Root keeper requires root');
process.setgroups([]);if(process.getgroups().some(group=>group!==process.getgid()))throw new Error('Groups were not cleared');
for(const stream of [process.stdout,process.stderr])stream._handle.setBlocking(true);
const parent=process.ppid;
let child;
const force=()=>{try{process.kill(0,'SIGKILL');}catch{}};
for(const signal of ['SIGTERM','SIGINT','SIGHUP','SIGQUIT'])process.on(signal,()=>setTimeout(force,100));
setInterval(()=>{if(process.ppid!==parent)force();},25).unref();
child=spawn(options.command,options.args,{cwd:options.cwd,env:options.env,
 uid:options.uid,gid:options.gid,detached:false,
 stdio:['pipe','inherit','inherit',options.control?'ipc':'ignore']});
process.send({kind:'RootTargetStartedV2',targetPid:child.pid});
process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{});
child.on('message',body=>process.send({kind:'RootControlMessageV2',body}));
process.on('message',message=>{if(message.kind==='RootControlReplyV2'&&child.connected)child.send(message.body);});
child.on('error',()=>process.send({kind:'RootTargetTerminalV2',targetPid:child.pid,code:126,signal:null}));
child.on('close',(code,signal)=>process.send({kind:'RootTargetTerminalV2',targetPid:child.pid,code,signal}));
setInterval(()=>{},1000);
`;
const NODE_PROBE = "process.stdout.write(JSON.stringify({nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,executable:require('node:fs').realpathSync(process.execPath)}))";

async function kernelPeerInKeeper(peerPid, keeperPid, uid) {
  const { stdout } = await exec("/bin/ps", ["-axo", "uid=,pid=,ppid="], { env: CLEAN_ENV, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  const table = new Map(stdout.trim().split("\n").map(line => {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/.exec(line);
    if (!match) hold("EFORMAL_OBSERVER_CAPTURE", "Kernel launch ancestry is unreadable");
    return [Number(match[2]), { uid: Number(match[1]), ppid: Number(match[3]) }];
  }));
  if (table.get(peerPid)?.uid !== uid) hold("EFORMAL_OBSERVER_CAPTURE", "Control peer UID does not match its root-owned launch");
  const seen = new Set(); let pid = peerPid;
  while (pid && !seen.has(pid)) {
    if (pid === keeperPid && table.get(pid)?.uid === 0) return;
    seen.add(pid); pid = table.get(pid)?.ppid;
  }
  hold("EFORMAL_OBSERVER_CAPTURE", "Control peer is not a live descendant of the actual root keeper handle");
}
function groupExists(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
async function waitGroupExit(pid, milliseconds) {
  const until = performance.now() + milliseconds;
  while (groupExists(pid) && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
  return !groupExists(pid);
}
async function createRootCaptureBroker(installed, job, directory, started) {
  const { policy } = installed, captures = [], active = new Map();
  const toolPath = await fixedToolPath();
  const minimal = createFormalSuiteEnvironment(toolPath, {}), manifest = await captureFormalSuiteManifest({ repositoryRoot: policy.executionSourceRoot, scriptPath: path.join(policy.executionSourceRoot, SCRIPT) });
  const phaseMinimal = createFormalSuiteEnvironment("/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin", {});
  const captureDirectory = path.join(directory, "captures");
  await mkdir(captureDirectory, { mode: 0o700 }); await syncDirectory(directory);
  let stopped = null, totalBytes = 0, supervisorTargetPid = null, coordinatorTargetPid = null, laneCount = 0;
  const cutoff = FORMAL_OPERATION_TIMEOUT_MS - 30_000;
  const elapsed = () => performance.now() - started;
  const checkpoint = () => { if (stopped || elapsed() >= cutoff) hold("EFORMAL_OBSERVER_DEADLINE", "Root-owned whole operation stopped or reached its work cutoff"); };
  const context = { uid: policy.suiteIdentity.uid, gid: policy.suiteIdentity.gid, expectedHead: job.expectedHead, expectedBase: job.expectedBase,
    executionSourceRoot: policy.executionSourceRoot, ownerHome: policy.suiteIdentity.home, launchRoot: job.launchRoot, nodePaths: policy.runtimePaths };
  const stopAll = cause => { stopped ??= cause; for (const item of active.values()) item.stop(); };
  const interrupt = () => stopAll("SIGINT"), terminate = () => stopAll("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  const deadline = setTimeout(() => stopAll("deadline"), Math.max(1, cutoff - elapsed()));
  const sameArgs = (left, right) => same(left, right);
  const gitAllowed = args => {
    if (!sameArgs(args.slice(0, 2), ["-c", `safe.directory=${policy.executionSourceRoot}`])) return false;
    const rest = args.slice(2);
    return [["rev-parse", "--show-toplevel"], ["rev-parse", "--verify", "HEAD^{commit}"],
      ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], ["merge-base", "--is-ancestor", job.expectedBase, job.expectedHead],
      ["remote"], ["remote", "get-url", "origin"], ["rev-parse", "--git-common-dir"]].some(allowed => sameArgs(rest, allowed));
  };
  function admit(parent, value) {
    exact(value, ["command", "args", "cwd", "env", "input", "timeoutMs", "maxOutputBytes", "cleanupGraceMs", "captureId"], "fixed capture request");
    if (value.cwd !== policy.executionSourceRoot || !Array.isArray(value.args) || !SHA256.test(hash(jsonBytes(value.env))) ||
        !/^[a-f0-9]{32}$/.test(value.captureId) || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 ||
        !Number.isSafeInteger(value.maxOutputBytes) || value.maxOutputBytes < 1 || value.cleanupGraceMs !== 5000) hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Capture cwd, bounds or internal ID differs");
    let role = "probe", lane = parent.lane ?? null, suite = null, limit = 10_000, output = MAX_RECORD, expectedEnv = minimal;
    if (parent.role === "supervisor") {
      expectedEnv = phaseMinimal;
      if (value.command !== policy.runtimePaths.node22 || value.args.length !== 1 ||
          !["formal-coordinator-worker.mjs", "formal-commit-worker.mjs"].some(name => value.args[0] === path.join(policy.executionSourceRoot, "plugins/better-workflows/scripts", name))) hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Supervisor can only request its fixed phase workers");
      const phase = value.input === null ? null : parse(Buffer.from(value.input, "base64"), 64 * 1024);
      const binding = phase?.options ?? phase?.context;
      if (binding?.expectedHead !== job.expectedHead || binding.expectedBase !== job.expectedBase || binding.launchRoot !== job.launchRoot ||
          binding.outerOwnerPid !== supervisorTargetPid || binding.ownerHome !== policy.suiteIdentity.home) hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Phase input changed actual supervisor/source/context binding");
      if (phase.kind === "FullFormalCoordinatorRequestV1" && value.args[0].endsWith("/formal-coordinator-worker.mjs")) {
        if (captures.some(item => item.role === "coordinator")) hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Coordinator cannot be rerun");
        role = "coordinator"; limit = cutoff; output = 64 * 1024; expectedEnv = { ...phaseMinimal, HOME: policy.suiteIdentity.home };
      } else if (["FullFormalCommitRequestV1", "FullFormalReleaseRequestV1"].includes(phase.kind) && value.args[0].endsWith("/formal-commit-worker.mjs") &&
          ["commit", "release", "reconcile"].includes(phase.action)) {
        role = phase.action === "reconcile" ? "readback" : phase.action;
        if (role !== "readback" && captures.some(item => item.role === role)) hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Mutating phase cannot be rerun");
        if (!captures.some(item => item.role === "coordinator" && item.result?.code === 0 && item.result.groupTerminated)) hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Commit/release lacks actual settled coordinator");
        if (role === "release" && !captures.some(item => item.role === "commit" && item.result?.code === 0 && item.result.groupTerminated)) hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Release lacks actual settled commit");
        output = 64 * 1024;
      } else hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Phase route is not fixed commit/release/readback");
    } else if (parent.role === "coordinator") {
      if (value.input !== null) hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Coordinator cannot supply probe stdin");
      if (value.command === "/usr/bin/caffeinate") {
        lane = FORMAL_FULL_PROFILE.lanes[laneCount]?.id;
        if (!lane) hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Formal lane cannot repeat or extend the two fixed lanes");
        expectedEnv = createFormalSuiteEnvironment(toolPath, { SBW_STATE_ROOT: path.join(job.launchRoot, lane, "state"),
          NPM_CONFIG_CACHE: path.join(job.launchRoot, lane, "npm-cache"), TMPDIR: path.join(job.launchRoot, lane, "tmp") });
        const args = ["-dimsu", "/usr/bin/env", `PATH=${toolPath}`, `SBW_STATE_ROOT=${expectedEnv.SBW_STATE_ROOT}`,
          `NPM_CONFIG_CACHE=${expectedEnv.NPM_CONFIG_CACHE}`, `TMPDIR=${expectedEnv.TMPDIR}`, "GIT_OPTIONAL_LOCKS=0", policy.runtimePaths[lane], path.join(policy.executionSourceRoot, SCRIPT), "eval", "--formal-child"];
        if (!sameArgs(value.args, args)) hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Lane command differs from the fixed installed recipe");
        laneCount += 1; role = "lane"; limit = 45 * 60 * 1000; output = 32 * 1024 * 1024;
      } else {
        const allowed = value.command === "/usr/bin/git" ? gitAllowed(value.args) :
          Object.values(policy.runtimePaths).includes(value.command) ? sameArgs(value.args, ["--input-type=commonjs", "-e", NODE_PROBE]) :
          [["/usr/sbin/sysctl", ["-n", "kern.boottime"]], ["/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]],
            ["/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-k", "IOPMUserIsActive"]],
            ["/usr/sbin/ioreg", ["-rd1", "-c", "IOPMrootDomain"]], ["/usr/bin/pmset", ["-g", "stats"]],
            ["/bin/ps", ["-axo", "pid=,ppid=,command="]]].some(([command, args]) => value.command === command && sameArgs(value.args, args));
        if (!allowed) hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Probe command is outside the fixed formal recipe");
        output = 8 * 1024 * 1024;
      }
    } else if (parent.role === "lane") {
      expectedEnv = parent.env;
      const file = manifest.files.find(item => sameArgs([value.command, ...value.args], formalSuiteCommand(policy.runtimePaths[parent.lane], path.join(policy.executionSourceRoot, item.path))));
      if (!file || value.input !== null || parent.suites.has(file.path) || parent.runningSuites >= FORMAL_SUITE_CONCURRENCY) hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Suite is duplicated, unmanifested or exceeds existing concurrency");
      parent.suites.add(file.path); parent.runningSuites += 1; role = "suite"; suite = file.path;
      limit = FORMAL_SUITE_TIMEOUT_MS; output = FORMAL_SUITE_MAX_OUTPUT_BYTES;
    } else hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Workload has no control capture authority");
    if (!same(value.env, expectedEnv) || value.maxOutputBytes > output || value.timeoutMs > limit) hold("EFORMAL_OBSERVER_CAPTURE_POLICY", "Capture environment or limits exceed the fixed recipe");
    return { role, lane, suite, env: expectedEnv, timeoutMs: Math.min(value.timeoutMs, Math.floor(cutoff - elapsed())), maxOutputBytes: value.maxOutputBytes };
  }
  async function capture(parent, value, initial = false) {
    checkpoint();
    const admitted = initial ? { role: "supervisor", lane: null, suite: null, env: value.env, timeoutMs: Math.floor(cutoff - elapsed()), maxOutputBytes: 32 * 1024 * 1024 } : admit(parent, value);
    if (admitted.timeoutMs < 1) checkpoint();
    const id = captures.length + 1, record = { id, parentId: parent?.id ?? null, role: admitted.role, lane: admitted.lane, suite: admitted.suite,
      command: [value.command, ...value.args], cwd: value.cwd, env: admitted.env, startedElapsedMs: elapsed(), finishedElapsedMs: null,
      keeperPid: null, targetPid: null, peerPid: null, result: null, terminal: null, suites: new Set(), runningSuites: 0 };
    captures.push(record);
    const control = ["supervisor", "coordinator", "commit", "release", "readback", "lane"].includes(record.role);
    const spec = { command: value.command, args: value.args, cwd: value.cwd, env: admitted.env, control,
      uid: policy.suiteIdentity.uid, gid: policy.suiteIdentity.gid };
    const child = spawn(policy.runtimePaths.node22, ["-e", ROOT_KEEPER, canonicalJson(spec)], { cwd: "/", env: CLEAN_ENV,
      detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    record.keeperPid = child.pid;
    let stopping = false, timedOut = false, outputExceeded = false, terminal = null, protocolError = null, size = 0, cleanupPromise = null;
    const stdout = [], stderr = [];
    const cleanup = () => cleanupPromise ??= (async () => {
      // Original root keeper stays live until this group signal, avoiding
      // numeric PGID signalling after an unobserved/recycled leader exit.
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(child.pid, 0); process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      if (await waitGroupExit(child.pid, 5000)) return true;
      if (child.exitCode === null && child.signalCode === null) { try { process.kill(child.pid, 0); process.kill(-child.pid, "SIGKILL"); } catch {} }
      return waitGroupExit(child.pid, 5000);
    })();
    const stop = () => { if (stopping) return; stopping = true; void cleanup().catch(error => { protocolError ??= error; }); };
    let settle;
    const settled = new Promise(resolve => { settle = resolve; });
    active.set(`${parent?.id ?? 0}:${value.captureId ?? "initial"}`, { stop, id, settled });
    const timer = setTimeout(() => { timedOut = true; stop(); }, admitted.timeoutMs);
    const collect = chunks => bytes => {
      size += bytes.length; totalBytes += bytes.length;
      if (size > admitted.maxOutputBytes || totalBytes > 256 * 1024 * 1024) { outputExceeded = true; stop(); return; }
      chunks.push(Buffer.from(bytes));
    };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    const send = body => { if (child.connected) child.send({ kind: "RootControlReplyV2", body }); };
    child.on("message", message => { void (async () => {
      if (message?.kind === "RootTargetStartedV2") {
        if (!Number.isSafeInteger(message.targetPid) || message.targetPid < 1 || record.targetPid !== null) throw new Error("Actual root target handle is invalid");
        record.targetPid = message.targetPid;
        if (record.role === "supervisor") supervisorTargetPid = record.targetPid;
        if (record.role === "coordinator") coordinatorTargetPid = record.targetPid;
      } else if (message?.kind === "RootTargetTerminalV2") {
        if (terminal || message.targetPid !== record.targetPid) throw new Error("Actual target terminal handle changed");
        terminal = message; stop();
      } else if (message?.kind === "RootControlMessageV2" && control) {
        const body = message.body;
        if (body?.kind === "FormalBrokerHelloV2") {
          if (record.peerPid !== null || body.keeperPid !== child.pid) throw new Error("Control peer repeated its initialization");
          await kernelPeerInKeeper(body.pid, child.pid, policy.suiteIdentity.uid); record.peerPid = body.pid;
          send({ kind: "FormalBrokerInitV2", keeperPid: child.pid, peerPid: body.pid, context });
        } else if (body?.kind === "FormalBrokerRequestV2" && record.peerPid !== null && /^[a-f0-9]{32}$/.test(body.id)) {
          try {
            let result;
            if (body.operation === "assert-outer-owner") {
              if (record.role !== "coordinator" || body.value?.outerOwnerPid !== supervisorTargetPid || !active.has("0:initial")) throw new Error("Broker-owned launch ancestry does not bind the actual supervisor handle");
              result = { keeperPid: child.pid, outerOwnerPid: supervisorTargetPid };
            } else if (body.operation === "capture") {
              const observed = await capture(record, snapshot(body.value, 128 * 1024));
              result = { ...observed, stdout: observed.stdout.toString("base64"), stderr: observed.stderr.toString("base64") };
            } else throw new Error("Control operation is not fixed capture/ancestry");
            send({ kind: "FormalBrokerReplyV2", id: body.id, value: result });
          } catch (error) { send({ kind: "FormalBrokerReplyV2", id: body.id, error: String(error.message).slice(0, 256) }); }
        } else if (body?.kind === "FormalBrokerCancelV2") {
          active.get(`${record.id}:${body.captureId}`)?.stop();
        } else throw new Error("Unexpected control pipe message");
      } else throw new Error("Unexpected keeper message");
    })().catch(error => { protocolError ??= error; stopAll("capture-protocol"); }); });
    child.stdin.on("error", error => { if (!["EPIPE", "ERR_STREAM_DESTROYED"].includes(error.code)) { protocolError ??= error; stop(); } });
    child.stdin.end(value.input === null ? undefined : Buffer.from(value.input, "base64"));
    let closed;
    try {
      closed = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
      const groupTerminated = await cleanup();
      const result = { pid: child.pid, code: terminal?.code ?? null, signal: terminal?.signal ?? null,
        timedOut, outputExceeded, groupTerminated, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      record.result = { code: result.code, signal: result.signal, groupTerminated }; record.terminal = formalCaptureObservation(result); record.finishedElapsedMs = elapsed();
      const prefix = path.join(captureDirectory, `capture-${String(id).padStart(5, "0")}`);
      await exclusiveFile(`${prefix}.stdout`, result.stdout); await exclusiveFile(`${prefix}.stderr`, result.stderr);
      if (!terminal || protocolError || !groupTerminated || closed === undefined && !child.signalCode) hold("EFORMAL_OBSERVER_CAPTURE", "Root-owned actual terminal or group cleanup is incomplete");
      return result;
    } finally {
      clearTimeout(timer); active.delete(`${parent?.id ?? 0}:${value.captureId ?? "initial"}`); settle();
      if (record.role === "suite") parent.runningSuites -= 1;
    }
  }
  const broker = { manifest, captures, checkpoint,
    async run() {
      const result = await capture(null, { command: policy.runtimePaths.node22, args: [path.join(policy.executionSourceRoot, ENTRY), "--internal-suite-worker-v2"],
        cwd: policy.executionSourceRoot, env: { ...CLEAN_ENV, HOME: policy.suiteIdentity.home }, input: jsonBytes(job).toString("base64") }, true);
      await assertSuiteIdle(policy);
      if (result.code !== 0 || result.signal !== null || result.timedOut || result.outputExceeded || result.stderr.length) hold("EFORMAL_OBSERVER_CAPTURE", "Actual supervisor did not return a complete closure");
      const value = parse(result.stdout, 32 * 1024 * 1024); exact(value, ["schemaVersion", "kind", "artifactBytes"], "owned supervisor closure");
      exact(value.artifactBytes, ROLES, "owned ten roles");
      if (value.schemaVersion !== 2 || value.kind !== "FormalObserverCapturedClosureV2") hold("EFORMAL_OBSERVER_CAPTURE", "Actual supervisor returned the wrong closure");
      const artifactBytes = {};
      for (const role of ROLES) { const bytes = Buffer.from(value.artifactBytes[role], "base64");
        if (bytes.length < 1 || bytes.length > MAX_RECORD || bytes.toString("base64") !== value.artifactBytes[role]) hold("EFORMAL_OBSERVER_CAPTURE", "Actual supervisor role raw bytes are invalid");
        artifactBytes[role] = bytes; }
      const completion = parse(artifactBytes.completion);
      if (completion.context?.outerOwnerPid !== supervisorTargetPid || captures.find(item => item.role === "coordinator")?.targetPid !== coordinatorTargetPid) hold("EFORMAL_OBSERVER_CAPTURE", "Raw closure changed actual root-owned supervisor/coordinator handles");
      return { artifactBytes };
    },
    async dispose() {
      clearTimeout(deadline); process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
      if (active.size) { const running = [...active.values()]; stopAll("dispose-incomplete"); await Promise.allSettled(running.map(item => item.settled)); }
      if (active.size) hold("EFORMAL_OBSERVER_CLEANUP", "Root broker still owns active process groups");
      await assertSuiteIdle(policy);
    }
  };
  ownedBrokers.add(broker); return broker;
}

const TERMINAL_KEYS = ["pid", "exitStatusObserved", "exitCode", "signal", "timedOut", "outputExceeded", "groupTerminated", "stdoutSha256", "stderrSha256"];
function requireCapturedTerminal(observed, actual) {
  if (!actual || !observed || !TERMINAL_KEYS.every(key => observed[key] === actual[key]) ||
      actual.exitStatusObserved !== true || actual.groupTerminated !== true || actual.signal !== null ||
      actual.timedOut !== false || actual.outputExceeded !== false) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Ten-role closure terminal differs from an actual root capture");
}
/** Pure negative/consistency checker for fixtures. This return value is never
 * a capture authenticator or signer capability; the producer additionally
 * requires the module-private broker created by actual root execution.
 */
export function inspectFormalObserverCaptureTranscriptV2({ artifactBytes, captures, manifest }) {
  const completion = parse(artifactBytes.completion), provisional = parse(artifactBytes.provisional), localLedger = parse(artifactBytes["ledger-export"]);
  const supervisor = captures.find(item => item.role === "supervisor"), coordinator = captures.find(item => item.role === "coordinator");
  if (!supervisor || !coordinator || completion.context.outerOwnerPid !== supervisor.targetPid ||
      localLedger.attempts.at(-1)?.coordinatorPid !== coordinator.targetPid || !same(provisional.suiteManifest, manifest)) {
    hold("EFORMAL_OBSERVER_TRANSCRIPT", "Actual supervisor/coordinator handles or suite manifest differ");
  }
  const matchOperation = (operation, parentId) => {
    const actual = captures.filter(item => item.parentId === parentId);
    if (operation.captures.length !== actual.length) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Actual phase/probe capture count differs from closure");
    operation.captures.forEach((observed, index) => {
      const record = actual[index];
      if (!same(observed.command, record.command) || !Number.isFinite(record.startedElapsedMs) || !Number.isFinite(record.finishedElapsedMs) ||
          observed.finishedElapsedMs - observed.startedElapsedMs + 5 < record.finishedElapsedMs - record.startedElapsedMs) {
        hold("EFORMAL_OBSERVER_TRANSCRIPT", "Actual command or monotonic duration differs from closure");
      }
      requireCapturedTerminal(observed.terminal, record.terminal);
    });
  };
  matchOperation(completion.operation, supervisor.id); matchOperation(provisional.operation, coordinator.id);
  for (const lane of provisional.lanes) {
    const actualLane = captures.find(item => item.parentId === coordinator.id && item.role === "lane" && item.lane === lane.id);
    if (lane.status === "NOT_RUN") {
      if (actualLane) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Actual lane was concealed as NOT_RUN");
      continue;
    }
    if (!actualLane) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Claimed lane has no actual root launch");
    requireCapturedTerminal(lane.terminal, actualLane.terminal);
    const report = lane.terminal.result?.formalSuites, suites = captures.filter(item => item.parentId === actualLane.id && item.role === "suite");
    if (!report || !same(report.expectedSuites, manifest.files.map(file => file.path)) || report.observations.length !== manifest.files.length) {
      hold("EFORMAL_OBSERVER_TRANSCRIPT", "Lane report altered actual suite coverage");
    }
    const used = new Set();
    for (const observed of report.observations) {
      const actual = suites.find(item => item.suite === observed.path);
      if (observed.status === "NOT_RUN") { if (actual) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Actual suite was concealed as NOT_RUN"); continue; }
      if (!actual || used.has(actual.id) || !same(observed.command, actual.command) || observed.cwd !== actual.cwd ||
          !Number.isFinite(observed.elapsedMs) || observed.elapsedMs + 5 < actual.finishedElapsedMs - actual.startedElapsedMs) {
        hold("EFORMAL_OBSERVER_TRANSCRIPT", "Claimed suite lacks its exact root-owned command/timing");
      }
      used.add(actual.id); requireCapturedTerminal(observed.terminal, actual.terminal);
      if (observed.status !== (actual.terminal.exitCode === 0 ? "PASSED" : "FAILED")) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Suite status differs from its actual exit");
    }
    if (used.size !== suites.length || (lane.status === "passed" && used.size !== manifest.files.length)) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Actual complete suite transcript is missing or substituted");
  }
  if (captures.some(item => !item.terminal || item.terminal.groupTerminated !== true || !Number.isFinite(item.finishedElapsedMs))) {
    hold("EFORMAL_OBSERVER_TRANSCRIPT", "Root capture transcript has an unsettled target");
  }
  return Object.freeze({ matches: true, authority: "none", captureAuthenticated: false, signingEligible: false });
}
async function authenticatedCaptureReport(broker, artifactBytes, directory) {
  if (!ownedBrokers.has(broker)) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Signing requires the actual module-owned root broker");
  inspectFormalObserverCaptureTranscriptV2({ artifactBytes, captures: broker.captures, manifest: broker.manifest }); broker.checkpoint();
  const rows = broker.captures.map(({ suites, runningSuites, ...record }) => record);
  for (const row of rows) {
    const prefix = path.join(directory, "captures", `capture-${String(row.id).padStart(5, "0")}`);
    // Authentic retained streams stay separate from the bounded ten-role
    // portable schema. Their original bytes and digests remain reviewable.
    const stdout = await protectedStreamBytes(`${prefix}.stdout`, 32 * 1024 * 1024), stderr = await protectedStreamBytes(`${prefix}.stderr`, 32 * 1024 * 1024);
    if (hash(stdout) !== row.terminal.stdoutSha256 || hash(stderr) !== row.terminal.stderrSha256) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Protected actual root stream readback differs");
  }
  await matchActualRootProbeFacts(broker, artifactBytes, directory);
  const transcript = { schemaVersion: 2, kind: "FormalRootCaptureTranscriptV2", captureBoundary: FORMAL_OBSERVER_CAPTURE_BOUNDARY_V2,
    manifest: broker.manifest, captures: rows, authority: "none", releaseEligible: false };
  const bytes = jsonBytes(transcript);
  await exclusiveFile(path.join(directory, "capture-transcript.json"), bytes);
  if (!(await protectedBytes(path.join(directory, "capture-transcript.json"), 8 * 1024 * 1024)).equals(bytes)) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Root-owned transcript persistence is unknown");
  return { schemaVersion: 2, kind: "FormalObserverRootCaptureV2", captureBoundary: FORMAL_OBSERVER_CAPTURE_BOUNDARY_V2,
    supervisorTargetPid: rows[0].targetPid, supervisorKeeperPid: rows[0].keeperPid, captureCount: rows.length,
    actualSuiteCaptures: rows.filter(row => row.role === "suite").length, captureTranscriptSha256: hash(bytes), cleanupConfirmed: true };
}

async function matchActualRootProbeFacts(broker, artifactBytes, directory) {
  const provisional = parse(artifactBytes.provisional), coordinator = broker.captures.find(row => row.role === "coordinator");
  const direct = broker.captures.filter(row => row.parentId === coordinator.id), text = new Map();
  for (const row of direct) {
    if (row.role !== "probe") continue;
    const bytes = await protectedStreamBytes(path.join(directory, "captures", `capture-${String(row.id).padStart(5, "0")}.stdout`), 8 * 1024 * 1024);
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(value).equals(bytes)) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Actual probe output is not lossless UTF-8");
    text.set(row.id, value);
  }
  const hosts = [];
  for (let index = 0; index < direct.length; index += 1) {
    const row = direct[index], command = row.command;
    if (same(command, ["/usr/sbin/sysctl", "-n", "kern.boottime"])) {
      const samples = direct.slice(index, index + 5), expected = [["/usr/sbin/sysctl", "-n", "kern.boottime"],
        ["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], ["/usr/sbin/ioreg", "-r", "-k", "AppleClamshellState", "-k", "IOPMUserIsActive"],
        ["/usr/sbin/ioreg", "-rd1", "-c", "IOPMrootDomain"], ["/usr/bin/pmset", "-g", "stats"]];
      if (samples.length !== 5 || samples.some((sample, offset) => !same(sample.command, expected[offset]) || sample.terminal.exitCode !== 0)) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Host claim lacks its full actual root probe sequence");
      const [bootTime, bootUuid, session, power, stats] = samples.map(sample => text.get(sample.id));
      if (!session.includes('"AppleClamshellState" = No') || !session.includes('"IOPMUserIsActive" = Yes')) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Actual root host probe does not prove an open active session");
      hosts.push({ platform: "darwin", bootTime: bootTime.trim(), bootIdentity: stableBootIdentity(bootUuid), sleepWakeUuid: parseSleepWakeUuid(power),
        sleepWakeCounters: parseSleepWakeCounters(stats), clamshell: "open", userActive: true });
    }
    if (Object.values(provisional.runtimeIdentities ? Object.fromEntries(provisional.runtimeIdentities.map(runtime => [runtime.laneId, runtime.path])) : {}).includes(command[0])) {
      const actual = parse(Buffer.from(text.get(row.id)), 4096), expected = provisional.runtimeIdentities.find(runtime => runtime.path === command[0]);
      if (!expected || actual.nodeVersion !== expected.nodeVersion || actual.platform !== expected.platform || actual.arch !== expected.arch ||
          actual.executable !== expected.path) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Runtime identity differs from its actual root-owned executable probe");
    }
    if (command[0] === "/usr/bin/git") {
      const args = command.slice(3), actual = text.get(row.id)?.trim();
      if (same(args, ["rev-parse", "--verify", "HEAD^{commit}"]) && actual !== provisional.expectedHead) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Actual root Git HEAD differs from closure");
      if (same(args, ["rev-parse", "--show-toplevel"]) && actual !== provisional.repositoryRoot) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Actual root Git source directory differs from closure");
      if (same(args, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"]) && actual !== "") hold("EFORMAL_OBSERVER_TRANSCRIPT", "Actual root Git source was not clean");
      if (same(args, ["remote", "get-url", "origin"]) && `github:${canonicalGovernedGithubRepository(actual)}` !== provisional.repositoryIdentity) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Actual root Git repository identity differs from closure");
    }
  }
  const claimed = [provisional.host, ...provisional.lanes.filter(lane => lane.postflight?.host).map(lane => lane.postflight.host)];
  if (!same(hosts, claimed)) hold("EFORMAL_OBSERVER_TRANSCRIPT", "Host/replacement power facts differ from actual root-captured bytes");
}

/** Internal unsigned worker. It cannot read the root key, write protected
 * attempts or sign. The installed root broker invokes this actual public
 * entrypoint over an owned pipe; literal imports stay on the public source.
 */
export async function runFormalObserverSuiteWorkerV2(jobInput) {
  const job = snapshot(jobInput, 16 * 1024);
  exact(job, ["schemaVersion", "kind", "expectedHead", "expectedBase", "terminalSequence", "launchRoot", "replacementReason", "predecessorCompletionPath"], "internal suite job");
  const installed = await loadInstalled("public-worker"), { policy } = installed;
  const context = formalProtectedCaptureContextV2();
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.getuid?.() !== policy.suiteIdentity.uid ||
      process.geteuid?.() !== policy.suiteIdentity.uid || process.getgid?.() !== policy.suiteIdentity.gid ||
      process.getegid?.() !== policy.suiteIdentity.gid || process.getgroups().some(group => group !== policy.suiteIdentity.gid) ||
      process.env.HOME !== policy.suiteIdentity.home || !process.channel || typeof process.send !== "function" ||
      !context || context.uid !== policy.suiteIdentity.uid || context.gid !== policy.suiteIdentity.gid ||
      context.executionSourceRoot !== policy.executionSourceRoot || context.ownerHome !== policy.suiteIdentity.home ||
      context.expectedHead !== job.expectedHead || context.expectedBase !== job.expectedBase ||
      context.launchRoot !== job.launchRoot || !same(context.nodePaths, policy.runtimePaths) ||
      job.schemaVersion !== 2 || job.kind !== "FormalObserverSuiteJobV2" || job.expectedHead !== policy.publicTarget.sourceRevision ||
      job.expectedBase !== policy.expectedBase || ![1, 2].includes(job.terminalSequence) ||
      !/^\/private\/tmp\/bw-[A-Za-z0-9._-]+-formal-eval-[A-Za-z0-9._-]+$/.test(job.launchRoot) ||
      (job.terminalSequence === 1 && (job.replacementReason !== null || job.predecessorCompletionPath !== null)) ||
      (job.terminalSequence === 2 && (!absolute(job.predecessorCompletionPath) || !job.replacementReason))) {
    hold("EFORMAL_OBSERVER_IDENTITY", "Suite worker is not the exact installed nonroot invocation");
  }
  const options = { cwd: policy.executionSourceRoot, scriptPath: path.join(policy.executionSourceRoot, SCRIPT),
    expectedHead: job.expectedHead, expectedBase: job.expectedBase, launchRoot: job.launchRoot,
    nodePaths: policy.runtimePaths, replacementReason: job.replacementReason };
  if (job.predecessorCompletionPath !== null) options.predecessorCompletionPath = job.predecessorCompletionPath;
  const completion = await runFullFormalEvaluation(options);
  if (completion.kind !== "FullFormalCompletionV1" || completion.operationCompletion !== "OBSERVED" ||
      completion.context?.outerOwnerPid !== process.pid || completion.context?.launchRoot !== job.launchRoot) {
    hold("EFORMAL_OBSERVER_CAPTURE", "Actual full supervisor is incomplete; no captured closure");
  }
  const artifactBytes = {}, names = { aggregate: "receipt.json", "commit-intent": "commit-intent.json", provisional: "provisional.json",
    "release-intent": "release-intent.json", "release-record": "slot-release.json" };
  for (const [role, name] of Object.entries(names)) artifactBytes[role] = await readBoundedRuntimeFileV2(path.join(job.launchRoot, name), MAX_RECORD);
  artifactBytes["ledger-export"] = await readBoundedRuntimeFileV2(completion.context.ledgerPath, MAX_RECORD);
  // Preserve the local protocol's serializedReceipt bytes and key order.
  artifactBytes.completion = Buffer.from(formalEvaluatorState.serializedReceipt(completion));
  await exclusiveFile(path.join(job.launchRoot, "completion.json"), artifactBytes.completion);
  const provisional = parse(artifactBytes.provisional);
  artifactBytes["node22-observations"] = Buffer.from(formalEvaluatorState.serializedReceipt(provisional.lanes[0]));
  artifactBytes["node24-observations"] = Buffer.from(formalEvaluatorState.serializedReceipt(provisional.lanes[1]));
  artifactBytes["suite-manifest"] = Buffer.from(formalEvaluatorState.serializedReceipt(provisional.suiteManifest));
  inspectFormalProtectedExecutionArtifactsV2({ policy, artifactBytes, expectedHead: job.expectedHead,
    expectedBase: job.expectedBase, terminalSequence: job.terminalSequence, launchRoot: job.launchRoot });
  return { schemaVersion: 2, kind: "FormalObserverCapturedClosureV2",
    artifactBytes: Object.fromEntries(ROLES.map(role => [role, artifactBytes[role].toString("base64")])) };
}

async function freezeRetainedLocalClosure(installed, reservation, artifactBytes) {
  const root = reservation.launchRoot, names = { aggregate: "receipt.json", "commit-intent": "commit-intent.json", completion: "completion.json",
    provisional: "provisional.json", "release-intent": "release-intent.json", "release-record": "slot-release.json" };
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== installed.policy.suiteIdentity.uid || await realpath(root) !== root) {
    hold("EFORMAL_OBSERVER_RETENTION", "Owned launch directory changed before immutable predecessor retention");
  }
  await chown(root, 0, 0); await chmod(root, 0o755);
  for (const [role, name] of Object.entries(names)) {
    const file = path.join(root, name), current = await readBoundedRuntimeFileV2(file, MAX_RECORD), before = await lstat(file);
    if (before.uid !== installed.policy.suiteIdentity.uid || !current.equals(artifactBytes[role])) hold("EFORMAL_OBSERVER_RETENTION", "Retained local role differs from invocation pipe bytes");
    await chown(file, 0, 0); await chmod(file, 0o444);
    if (!(await readBoundedRuntimeFileV2(file, MAX_RECORD)).equals(artifactBytes[role])) hold("EFORMAL_OBSERVER_RETENTION", "Local predecessor retention drifted");
  }
  await syncDirectory(root);
}

/** Root-only production API: fixed installed policy/image/key/target paths.
 * The only caller inputs are exact head/base. No standalone signer exists.
 */
export async function runInstalledFormalProtectedObserverV2(requestInput) {
  const started = performance.now();
  const input = inspectFormalObserverRequestV2(requestInput); checkRoot();
  const installed = await loadInstalled(), { policy } = installed;
  if (input.expectedHead !== policy.publicTarget.sourceRevision || input.expectedBase !== policy.expectedBase) hold("EFORMAL_OBSERVER_TARGET", "Caller HEAD/base differ from the installed public candidate");
  const sourceBefore = await observePublicSource(installed); await assertSuiteIdle(policy);
  const namespace = path.join(FORMAL_PROTECTED_ARTIFACT_ROOT_V2, policy.publicTarget.repository.id, input.expectedHead);
  await ensureProtectedDirectory(namespace, 0o700);
  const lock = path.join(namespace, "controller.lock");
  const lockBytes = jsonBytes({ schemaVersion: 2, kind: "FormalObserverControllerLockV2", pid: process.pid, nonce: randomBytes(16).toString("hex") });
  await exclusiveFile(lock, lockBytes);
  let reserved = false, completed = false, broker = null;
  try {
    const ledgerPath = path.join(namespace, "attempt-ledger.json");
    const previousBytes = await exists(ledgerPath) ? await protectedBytes(ledgerPath, 256 * 1024) : null;
    const previousLedger = previousBytes === null ? null : parse(previousBytes, 256 * 1024, true);
    let predecessor = null, predecessorObservation = null, predecessorLedger = null;
    if (previousLedger !== null) {
      predecessorObservation = await inspectInstalledFormalProtectedBundleV2(input);
      predecessor = await readClosure(namespace, input.expectedHead, 1);
      predecessorLedger = parse(predecessor.artifactBytes["ledger-export"]);
    }
    const selection = inspectFormalObserverAttemptSelectionV2({ policy, ledger: previousLedger, predecessorObservation, predecessorLedger });
    const sequence = selection.terminalSequence, directory = path.join(namespace, `attempt-${sequence}`);
    // Exclusive attempt directory spends the budget even if a later write fails.
    await mkdir(directory, { mode: 0o700 }); reserved = true; await syncDirectory(namespace);
    const launchRoot = `/private/tmp/bw-protected-${input.expectedHead.slice(0, 12)}-formal-eval-${randomBytes(16).toString("hex")}`;
    const reservation = { schemaVersion: 2, kind: "FormalProtectedAttemptReservationV2", repository: policy.publicTarget.repository,
      expectedHead: input.expectedHead, expectedBase: input.expectedBase, ledgerEpoch: policy.ledgerEpoch, ...selection, launchRoot };
    const reservationBytes = jsonBytes(reservation), reservationSha256 = hash(reservationBytes);
    await exclusiveFile(path.join(directory, "reservation.json"), reservationBytes);
    const ledger = previousLedger === null ? { schemaVersion: 2, kind: "FormalProtectedAttemptLedgerV2", repository: policy.publicTarget.repository,
      expectedHead: input.expectedHead, expectedBase: input.expectedBase, ledgerEpoch: policy.ledgerEpoch, attempts: [] } : structuredClone(previousLedger);
    ledger.attempts.push({ terminalSequence: sequence, reservationSha256, bundleSha256: null, status: "reserved" });
    await writeLedger(namespace, ledger, previousBytes);
    const reservedBytes = jsonBytes(ledger);
    let predecessorCompletionPath = null;
    if (predecessor !== null) {
      const priorReservation = parse(predecessor.reservationBytes);
      predecessorCompletionPath = path.join(priorReservation.launchRoot, "completion.json");
      if (!(await readBoundedRuntimeFileV2(predecessorCompletionPath, MAX_RECORD)).equals(predecessor.artifactBytes.completion)) hold("EFORMAL_OBSERVER_RETENTION", "Original local predecessor completion no longer matches protected raw bytes");
      const priorCompletion = parse(predecessor.artifactBytes.completion);
      if (!(await readBoundedRuntimeFileV2(priorCompletion.context.ledgerPath, MAX_RECORD)).equals(predecessor.artifactBytes["ledger-export"])) hold("EFORMAL_OBSERVER_HISTORY", "Local first-attempt prefix differs from protected predecessor");
    } else {
      const localLedger = path.join(policy.suiteIdentity.home, ".better-workflows/formal-evaluations", hash(policy.repositoryIdentity), `${input.expectedHead}.json`);
      if (await exists(localLedger)) hold("EFORMAL_OBSERVER_HISTORY", "Protected primary cannot ignore existing local exact-HEAD attempt history");
    }
    await currentInstalled(installed);
    const job = { schemaVersion: 2, kind: "FormalObserverSuiteJobV2", ...input, terminalSequence: sequence, launchRoot,
      replacementReason: selection.replacementReason, predecessorCompletionPath };
    broker = await createRootCaptureBroker(installed, job, directory, started);
    const { artifactBytes } = await broker.run();
    const replay = inspectFormalProtectedExecutionArtifactsV2({ policy, artifactBytes, ...input, terminalSequence: sequence, launchRoot });
    const capture = await authenticatedCaptureReport(broker, artifactBytes, directory);
    await freezeRetainedLocalClosure(installed, reservation, artifactBytes);
    const sourceAfter = await observePublicSource(installed);
    if (sourceBefore.sourceInventoryDigest !== sourceAfter.sourceInventoryDigest || sourceBefore.sourceSnapshotDigest !== sourceAfter.sourceSnapshotDigest) hold("EFORMAL_OBSERVER_TARGET", "Public source bytes or physical identity changed across execution");
    await assertRuntimeQualificationTargetCurrentV2(sourceBefore.snapshot); await currentInstalled(installed);
    broker.checkpoint();
    const artifacts = ROLES.map(role => ({ role, file: `${input.expectedHead}-attempt-${sequence}-${role}.json`, sha256: hash(artifactBytes[role]), byteLength: artifactBytes[role].length }));
    const payload = { schemaVersion: 2, kind: "FormalExecutionAttestationPayloadV2", issuer: policy.issuer, keyId: installed.request.keyId,
      purpose: FORMAL_PROTECTED_PURPOSE, audience: FORMAL_PROTECTED_AUDIENCE, repositoryIdentity: policy.repositoryIdentity,
      ...input, profileId: policy.profileId, observerImageSha256: policy.observerImageSha256, ledgerEpoch: policy.ledgerEpoch,
      terminalSequence: sequence, suiteManifestSha256: hash(artifactBytes["suite-manifest"]), runtimeLanes: policy.runtimeLanes,
      artifactManifestSha256: hash(jsonBytes(artifacts)), qualificationStatus: replay.qualificationStatus,
      operationCompletion: replay.operationCompletion, cleanupConfirmed: true, publicTarget: policy.publicTarget,
      predecessorBundleSha256: selection.predecessorBundleSha256, replacementReason: selection.replacementReason, reservationSha256 };
    const keyPath = path.join(FORMAL_PROTECTED_PRIVATE_KEY_ROOT_V2, `${installed.request.keyId}.pkcs8`);
    const keyBytes = await protectedBytes(keyPath, 16 * 1024), privateKey = createPrivateKey({ key: keyBytes, format: "der", type: "pkcs8" });
    if (hash(keyBytes) !== installed.installation.keySha256 || privateKey.asymmetricKeyType !== "ed25519" ||
        createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64") !== installed.installation.publicKey) hold("EFORMAL_OBSERVER_KEY", "Dedicated installed formal key differs or has wrong purpose identity");
    // Only this invocation-owned/replayed payload reaches the private signer.
    const bundle = { schemaVersion: 2, kind: "FormalExecutionBundleV2", payload, signature: sign(null, jsonBytes(payload), privateKey).toString("base64"), artifacts };
    keyBytes.fill(0);
    const bundleBytes = jsonBytes(bundle), bundleSha256 = hash(bundleBytes);
    ledger.attempts[sequence - 1] = { terminalSequence: sequence, reservationSha256, bundleSha256, status: "terminal" };
    inspectFormalProtectedBundleV2({ policy, bundle, artifactBytes, ...input, ledgerBytes: jsonBytes(ledger), reservationBytes, predecessor });
    for (const item of artifacts) await exclusiveFile(path.join(directory, item.file), artifactBytes[item.role]);
    await exclusiveFile(path.join(directory, "capture.json"), jsonBytes(capture));
    await exclusiveFile(path.join(directory, "bundle.json"), bundleBytes);
    for (const item of artifacts) if (!(await protectedBytes(path.join(directory, item.file))).equals(artifactBytes[item.role])) hold("EFORMAL_OBSERVER_PERSIST", "Protected raw role readback differs");
    if (!(await protectedBytes(path.join(directory, "bundle.json"))).equals(bundleBytes)) hold("EFORMAL_OBSERVER_PERSIST", "Protected signed bundle readback differs");
    await currentInstalled(installed); await assertSuiteIdle(policy); broker.checkpoint();
    if (!(await protectedBytes(lock, 4096)).equals(lockBytes)) hold("EFORMAL_OBSERVER_HISTORY", "Exclusive controller incarnation changed");
    await writeLedger(namespace, ledger, reservedBytes); // Terminal ledger is last.
    const observed = await inspectInstalledFormalProtectedBundleV2(input);
    completed = true;
    return Object.freeze({ ...observed, producerStatus: "OBSERVED", captureBoundary: capture.captureBoundary,
      authority: "none", releaseEligible: false, admission: "HOLD", attemptDirectory: directory });
  } finally {
    if (broker !== null) await broker.dispose();
    // UNKNOWN keeps the lock/reservation. No stale lock reclaim or retry API.
    if (!reserved || completed) {
      if (!(await protectedBytes(lock, 4096)).equals(lockBytes)) hold("EFORMAL_OBSERVER_HISTORY", "Controller lock changed during release");
      await unlink(lock); await syncDirectory(namespace);
    }
  }
}

async function verifySuiteAccount(identity) {
  const { stdout } = await exec("/usr/bin/dscl", [".", "-search", "/Users", "UniqueID", String(identity.uid)], { env: CLEAN_ENV, timeout: 10_000, maxBuffer: 64 * 1024 });
  const lines = stdout.trim().split("\n"), match = lines.length === 1 && /^([A-Za-z0-9._-]+)\s+([0-9]+)$/.exec(lines[0]);
  if (!match || Number(match[2]) !== identity.uid) hold("EFORMAL_OBSERVER_IDENTITY", "Dedicated suite account must already exist uniquely");
  const { stdout: attributes } = await exec("/usr/bin/dscl", [".", "-read", `/Users/${match[1]}`, "PrimaryGroupID", "NFSHomeDirectory"], { env: CLEAN_ENV, timeout: 10_000, maxBuffer: 4096 });
  const values = Object.fromEntries(attributes.trim().split("\n").map(line => {
    const found = /^(PrimaryGroupID|NFSHomeDirectory): (.+)$/.exec(line);
    if (!found) hold("EFORMAL_OBSERVER_IDENTITY", "Suite account attributes are unreadable");
    return [found[1], found[2]];
  }));
  const home = await lstat(identity.home);
  if (values.PrimaryGroupID !== String(identity.gid) || values.NFSHomeDirectory !== identity.home ||
      !home.isDirectory() || home.isSymbolicLink() || home.uid !== identity.uid || home.gid !== identity.gid ||
      (home.mode & 0o077) !== 0 || await realpath(identity.home) !== identity.home) hold("EFORMAL_OBSERVER_IDENTITY", "Dedicated UID/GID/home differs from the owner request");
  await assertSuiteIdle({ suiteIdentity: identity });
}

/** Effectful installer invoked by Root through a visible native administrator
 * action. Root privilege is required; no JSON flag is accepted as approval,
 * and this function neither prompts for nor reads a password.
 *
 * Review packet layout (fixed relative to requestPath): preparation.json,
 * owner-contract-receipt.json, public-projection-receipt.json, and source/.
 * The exact request digest binds the two receipts and every source/binary.
 */
export async function installFormalProtectedObserverV2(inputRequest) {
  const input = snapshot(inputRequest, 4096);
  exact(input, ["requestPath", "expectedRequestSha256", "expectedPreparationSha256"], "installer invocation");
  if (!absolute(input.requestPath) || !SHA256.test(input.expectedRequestSha256) || !SHA256.test(input.expectedPreparationSha256)) hold("EFORMAL_OBSERVER_INPUT", "Installer requires the exact reviewed request/preparation digests");
  checkRoot();
  const packetRoot = path.dirname(input.requestPath), stagedSource = path.join(packetRoot, "source");
  const requestBytes = await protectedBytes(input.requestPath, MAX_REQUEST, 0o644), request = parse(requestBytes, MAX_REQUEST, true);
  const prepared = prepareFormalProtectedObserverInstallV2(request);
  if (hash(requestBytes) !== input.expectedRequestSha256 || prepared.requestSha256 !== input.expectedRequestSha256 ||
      prepared.preparationSha256 !== input.expectedPreparationSha256) hold("EFORMAL_OBSERVER_REVIEW", "Reviewed installer request/preparation digest differs");
  const preparationBytes = await protectedBytes(path.join(packetRoot, "preparation.json"), MAX_REQUEST * 2, 0o644);
  if (!same(parse(preparationBytes, MAX_REQUEST * 2, true), prepared)) hold("EFORMAL_OBSERVER_REVIEW", "Actual reviewed preparation is not the exact recomputed action plan");
  for (const [file, expected] of [["owner-contract-receipt.json", request.ownerContractReceiptSha256], ["public-projection-receipt.json", request.publicProjectionReceiptSha256]]) {
    if (hash(await protectedBytes(path.join(packetRoot, file), MAX_REQUEST, 0o644)) !== expected) hold("EFORMAL_OBSERVER_REVIEW", "Actual owner/public projection receipt bytes differ");
  }
  const image = request.controllerImage;
  if (image.entrypoint !== path.join(image.root, ENTRY) || sourceRoot !== stagedSource ||
      ![ENTRY, INSTALL_ENTRY, LIB_ENTRY, SUPERVISOR, SCRIPT,
        "plugins/better-workflows/scripts/lib/formal-protected-admission-v1.mjs",
        "plugins/better-workflows/scripts/lib/formal-protected-observer-preparation-v2.mjs"].every(relative => request.sourceManifest.some(file => file.path === relative))) {
    hold("EFORMAL_OBSERVER_IMAGE", "Installer must execute from the reviewed source packet and include actual control entrypoints");
  }
  await verifyManifest(stagedSource, request.sourceManifest);
  // Read and pin all source bytes before any persistent installation effect.
  const capturedSource = [];
  let total = 0;
  for (const file of request.sourceManifest) {
    const bytes = await readBoundedRuntimeFileV2(path.join(stagedSource, file.path), 64 * 1024 * 1024);
    total += bytes.length;
    if (total > 256 * 1024 * 1024 || hash(bytes) !== file.sha256) hold("EFORMAL_OBSERVER_IMAGE", "Reviewed source manifest byte or aggregate bound differs");
    capturedSource.push({ ...file, bytes });
  }
  for (const runtime of request.runtimeLanes) {
    const observed = await observeRootOwnedRuntimeFileV2(runtime.path, { maxBytes: 512 * 1024 * 1024, executable: true });
    if (observed.sha256 !== runtime.executableSha256) hold("EFORMAL_OBSERVER_RUNTIME", "Actual installer runtime binary differs from review");
    // Installer probes only the reviewed/pinned binaries as its existing
    // root identity. All nonroot suite execution uses ROOT_KEEPER, which
    // clears supplementary groups before the dedicated UID/GID spawn.
    const { stdout, stderr } = await exec(runtime.path, ["--version"], { env: CLEAN_ENV,
      cwd: "/", timeout: 10_000, maxBuffer: 4096 });
    if (stdout !== `v${runtime.nodeVersion}\n` || stderr !== "") hold("EFORMAL_OBSERVER_RUNTIME", "Actual runtime version differs from review");
  }
  if (process.execPath !== request.runtimeLanes[0].path || process.versions.node !== request.runtimeLanes[0].nodeVersion) hold("EFORMAL_OBSERVER_RUNTIME", "Installer must use the reviewed Node 22 binary");
  await verifySuiteAccount(request.suiteIdentity);
  await assertRootOwnedRuntimePathV2(request.executionSourceRoot, { directory: true });
  const runtimeTarget = await readInstalledRuntimeQualificationTargetV2();
  if (!same({ repository: runtimeTarget.targetPolicy.repository, sourceRevision: runtimeTarget.targetPolicy.sourceRevision,
    sourceRef: runtimeTarget.targetPolicy.sourceRef }, request.publicTarget)) hold("EFORMAL_OBSERVER_TARGET", "Public bootstrap/runtime target must be installed exactly before formal observer provisioning");
  await observePublicSource({ request, policy: { publicTarget: request.publicTarget,
    executionSourceRoot: request.executionSourceRoot, expectedBase: request.expectedBase } });
  const keyPath = prepared.privateKeyPath;
  for (const file of [image.root, keyPath, FORMAL_PROTECTED_POLICY_PATH_V2, FORMAL_OBSERVER_INSTALLATION_PATH_V2]) {
    if (await exists(file)) hold("EFORMAL_OBSERVER_INSTALL_CONFLICT", "Existing image, key or installation must be reconciled; no overwrite/rekey");
  }
  const namespace = path.join(FORMAL_PROTECTED_ARTIFACT_ROOT_V2, request.publicTarget.repository.id, request.publicTarget.sourceRevision);
  if (await exists(namespace) && (await readdir(namespace)).length !== 0) hold("EFORMAL_OBSERVER_INSTALL_CONFLICT", "Existing exact-repository/HEAD history cannot be replaced or reset");
  // Install intention is exclusive and survives every uncertain/partial effect.
  await ensureProtectedDirectory(path.dirname(FORMAL_OBSERVER_INSTALLATION_PATH_V2), 0o755);
  const intentionPath = path.join(path.dirname(FORMAL_OBSERVER_INSTALLATION_PATH_V2), "formal-observer-install-intent-v2.json");
  await exclusiveFile(intentionPath, jsonBytes({ schemaVersion: 2, kind: "FormalObserverInstallIntentV2",
    requestSha256: prepared.requestSha256, preparationSha256: prepared.preparationSha256, ownerContractReceiptSha256: request.ownerContractReceiptSha256,
    publicProjectionReceiptSha256: request.publicProjectionReceiptSha256, administratorMethod: "external-visible-native-macos-dialog-required",
    pid: process.pid, installationStatus: "INSTALL_OUTCOME_PENDING" }), 0o644);
  await ensureProtectedDirectory(path.dirname(image.root), 0o755);
  await mkdir(image.root, { mode: 0o755 }); await syncDirectory(path.dirname(image.root));
  for (const file of capturedSource) {
    await ensureProtectedDirectory(path.dirname(path.join(image.root, file.path)), 0o755);
    await exclusiveFile(path.join(image.root, file.path), file.bytes, 0o644);
  }
  await verifyManifest(image.root, request.sourceManifest);
  await ensureProtectedDirectory(FORMAL_PROTECTED_PRIVATE_KEY_ROOT_V2, 0o700);
  const generated = generateKeyPairSync("ed25519"), privateBytes = generated.privateKey.export({ format: "der", type: "pkcs8" });
  const publicKey = generated.publicKey.export({ format: "der", type: "spki" }).toString("base64"), keySha256 = hash(privateBytes);
  try { await exclusiveFile(keyPath, privateBytes, 0o600); } finally { privateBytes.fill(0); }
  const policy = { schemaVersion: 2, kind: "FormalExecutionTrustPolicyV2", issuer: request.issuer,
    purpose: FORMAL_PROTECTED_PURPOSE, audience: FORMAL_PROTECTED_AUDIENCE,
    repositoryIdentity: `github:github.com/${request.publicTarget.repository.name}`, profileId: FORMAL_FULL_PROFILE.id,
    observerImageSha256: image.manifestSha256, ledgerEpoch: request.ledgerEpoch,
    keys: [{ keyId: request.keyId, algorithm: "ed25519", purpose: FORMAL_PROTECTED_PURPOSE, publicKey, status: "active" }],
    runtimeLanes: request.runtimeLanes.map(({ path: _path, ...lane }) => lane), publicTarget: request.publicTarget,
    expectedBase: request.expectedBase, executionSourceRoot: request.executionSourceRoot, suiteIdentity: request.suiteIdentity,
    runtimePaths: Object.fromEntries(request.runtimeLanes.map(runtime => [runtime.id, runtime.path])) };
  validateFormalProtectedPolicyV2(policy);
  await ensureProtectedDirectory(FORMAL_PROTECTED_ARTIFACT_ROOT_V2, 0o700);
  await ensureProtectedDirectory(path.dirname(namespace), 0o700); await ensureProtectedDirectory(namespace, 0o700);
  await assertRuntimeQualificationTargetCurrentV2(runtimeTarget);
  await exclusiveFile(FORMAL_PROTECTED_POLICY_PATH_V2, jsonBytes(policy), 0o644);
  const installation = { schemaVersion: 2, kind: "FormalProtectedObserverInstallationV2", request,
    requestSha256: prepared.requestSha256, preparationSha256: prepared.preparationSha256,
    policySha256: hash(jsonBytes(policy)), publicKey, keySha256 };
  await exclusiveFile(FORMAL_OBSERVER_INSTALLATION_PATH_V2, jsonBytes(installation), 0o644);
  for (const [file, bytes] of [[FORMAL_PROTECTED_POLICY_PATH_V2, jsonBytes(policy)], [FORMAL_OBSERVER_INSTALLATION_PATH_V2, jsonBytes(installation)]]) {
    if (!(await protectedBytes(file, MAX_REQUEST * 2, 0o644)).equals(bytes)) hold("EFORMAL_OBSERVER_INSTALL_UNKNOWN", "Final installation readback differs; do not repeat installation");
  }
  if (hash(await protectedBytes(keyPath, 16 * 1024)) !== keySha256) hold("EFORMAL_OBSERVER_INSTALL_UNKNOWN", "Dedicated key readback differs");
  await verifyManifest(image.root, request.sourceManifest);
  return Object.freeze({ schemaVersion: 2, kind: "FormalProtectedObserverInstallObservationV2", authority: "none", releaseEligible: false,
    installationStatus: "OBSERVED", requestSha256: prepared.requestSha256, preparationSha256: prepared.preparationSha256,
    policySha256: installation.policySha256, observerImageSha256: image.manifestSha256, publicTarget: request.publicTarget,
    captureBoundary: FORMAL_OBSERVER_CAPTURE_BOUNDARY_V2, formalQualification: "NOT_RUN", admission: "HOLD" });
}
