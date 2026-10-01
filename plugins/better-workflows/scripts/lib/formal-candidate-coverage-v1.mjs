// SPDX-License-Identifier: AGPL-3.0-only
// Candidate-bound semantic coverage observations. No release authority.
// This is a separate read-only audit; it never calls eval, writes an attempt,
// changes qualification, signs evidence, or admits a release.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, digestObject } from './core.mjs';
import { canonicalGovernedGithubRepository } from './git-observation-v1.mjs';
import { createFormalSuiteEnvironment } from './formal-environment.mjs';
import { captureFormalSuiteManifest, isEligibleFormalSuite } from './formal-evaluator.mjs';
import { replayFullFormalCompletion } from './formal-commit.mjs';
import { FORMAL_FULL_PROFILE } from './formal-operation.mjs';
import { productReleaseScope } from './product-release-scope-v1.mjs';
import { resolveProductReleaseTargetV1 } from './product-release-channel-v1.mjs';
import { parseRuntimeProducerLsTreeV2, observeRuntimeSourceTreeV2 } from './runtime-qualification-v2.mjs';
import { formalCaptureSucceeded } from './formal-suite-runner.mjs';
import { spawnCapture } from './process-capture.mjs';
import { parseStrictJsonV1 } from './strict-json-v1.mjs';
import { copyBoundedBytesV1 } from './private-input-snapshot-v1.mjs';

const execFileAsync = promisify(execFile);
const MODULE = fileURLToPath(import.meta.url);
const PLUGIN = 'plugins/better-workflows/';
const CATALOG = `${PLUGIN}config/formal-atomic-requirements-v1.json`;
const SCRIPT = `${PLUGIN}scripts/sbw.mjs`;
const TESTS = `${PLUGIN}scripts/tests/`;
const BOUND_SOURCES = [CATALOG, `${PLUGIN}config/product-release-scope-v1.json`,
  `${PLUGIN}config/product-release-channel-v1.json`, `${PLUGIN}scripts/lib/product-release-channel-v1.mjs`,
  `${PLUGIN}config/version-manifest-v1.json`, `${PLUGIN}config/entrypoint-catalog.json`,
  `${PLUGIN}scripts/lib/formal-operation.mjs`, `${PLUGIN}scripts/lib/formal-evaluator.mjs`,
  `${PLUGIN}scripts/lib/formal-commit.mjs`, `${PLUGIN}scripts/lib/runtime-qualification-v2.mjs`,
  `${PLUGIN}scripts/lib/formal-candidate-coverage-v1.mjs`,
  `${PLUGIN}scripts/formal-candidate-coverage-v1.mjs`];
const PATH_VALUE = '/usr/bin:/bin:/usr/sbin:/sbin';
const AUDIT_MS = 30_000, CLEANUP_MS = 5_000, MAX_FILE = 4 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/, NONCE = /^[a-f0-9]{32}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
function decodeBoundedUtf8Bytes(value, maxBytes) {
  const bytes = copyBoundedBytesV1(value, { maxBytes });
  const sha256 = hash(bytes);
  const text = UTF8.decode(bytes);
  const roundtrip = Buffer.from(text, 'utf8');
  if (!sameBytes(bytes, roundtrip) || hash(roundtrip) !== sha256) {
    throw new Error('Bounded UTF-8 input did not round-trip');
  }
  return { bytes, sha256, text };
}
function parseBoundedJsonBytes(value, maxBytes) {
  const input = decodeBoundedUtf8Bytes(value, maxBytes);
  return parseStrictJsonV1(input.text, { maxBytes });
}
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const absolute = p => typeof p === 'string' && !p.includes('\0') && path.isAbsolute(p) && path.resolve(p) === p;
const relative = p => typeof p === 'string' && !p.includes('\0') && !p.includes('\\') &&
  p.length > 0 && !path.isAbsolute(p) && p.split('/').every(part => part && part !== '.' && part !== '..');
const meaning = row => ({ id: row.id, group: row.group ?? null, scope: row.scope, statement: row.statement });

function validateOptions(value, mode = 'audit') {
  const keys = ['repositoryRoot', 'expectedHead', 'expectedBase', 'launchRoot', 'expectedCatalogRevision',
    'expectedCatalogSha256', 'expectedOperationNonce', 'expectedFormalAttemptId', 'expectedReceiptDigest', 'expectedLedgerDigest'];
  if (mode === 'replay') keys.push('reportPath');
  if (!value || Object.keys(value).sort().join(',') !== keys.slice().sort().join(',') ||
      ![value.repositoryRoot, value.launchRoot, ...(mode === 'replay' ? [value.reportPath] : [])].every(absolute) ||
      !/^\/private\/tmp\/bw-[A-Za-z0-9._-]+-formal-eval-[A-Za-z0-9._-]+$/.test(value.launchRoot) ||
      ![value.expectedHead, value.expectedBase].every(v => SHA.test(v ?? '')) ||
      ![value.expectedCatalogSha256, value.expectedReceiptDigest, value.expectedLedgerDigest].every(v => HASH.test(v ?? '')) ||
      !NONCE.test(value.expectedOperationNonce ?? '') ||
      !/^formal-[a-f0-9]{24}$/.test(value.expectedFormalAttemptId ?? '') ||
      typeof value.expectedCatalogRevision !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.expectedCatalogRevision)) {
    throw new Error('Coverage audit requires exact source, catalog revision/bytes, nonce, attempt and durable digests');
  }
  return structuredClone(value);
}

// Physical bounded reads only. Parent audit-worker supervision supplies the
// hard whole-inspection deadline even when filesystem I/O itself is stuck.
async function readPhysical(root, name, { privateFile = false } = {}) {
  if (!absolute(root) || !relative(name) || await realpath(root) !== root) throw new Error('Audit root/path is not physical');
  let target = root;
  for (const part of name.split('/').slice(0, -1)) {
    target = path.join(target, part);
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Audit path has an indirect ancestor');
  }
  target = path.join(root, name);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_FILE) ||
        (privateFile && (before.uid !== BigInt(process.getuid()) || (before.mode & 0o777n) !== 0o600n))) {
      throw new Error('Audit file is not a bounded physical owner file');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const live = await lstat(target, { bigint: true });
    const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'uid', 'mode'];
    if (!fields.every(key => before[key] === after[key] && after[key] === live[key]) ||
        live.isSymbolicLink() || BigInt(bytes.length) !== after.size) throw new Error('Audit file identity changed');
    return bytes;
  } finally { await handle.close(); }
}

async function gitReader(root, deadline) {
  const env = { ...createFormalSuiteEnvironment(PATH_VALUE, {}), GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
  return async (args) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error('Coverage audit inspection budget exhausted');
    // execFile keeps git in the audit-worker's owned process group. There are
    // no detached nested captures whose cleanup the outer timeout could miss.
    const result = await execFileAsync('/usr/bin/git', ['--no-replace-objects', '--literal-pathspecs',
      '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, timeout: Math.min(remaining, 10_000),
      maxBuffer: MAX_FILE, encoding: 'buffer', killSignal: 'SIGTERM' });
    if (result.stderr.length !== 0) throw new Error('Read-only Git audit emitted diagnostics');
    return result.stdout;
  };
}

async function repositoryIdentity(git, root) {
  const text = async args => (await git(args)).toString('utf8').trim();
  const remotes = (await text(['remote'])).split('\n').filter(Boolean);
  if (remotes.includes('origin')) {
    const origin = await text(['remote', 'get-url', 'origin']);
    const canonical = canonicalGovernedGithubRepository(origin);
    return canonical ? `github:${canonical}` : `origin-digest:${hash(origin)}`;
  }
  return `common:${await realpath(path.resolve(root, await text(['rev-parse', '--git-common-dir'])))}`;
}

function parseCatalog(bytes, options) {
  if (hash(bytes) !== options.expectedCatalogSha256) throw new Error('Selected catalog bytes changed');
  const catalog = parseBoundedJsonBytes(bytes, MAX_FILE);
  if (catalog.schemaVersion !== 1 || catalog.kind !== 'FormalAcceptanceCatalogV1' ||
      catalog.revision !== options.expectedCatalogRevision || !Array.isArray(catalog.requirements) || catalog.requirements.length < 1 || catalog.requirements.length > 4096 ||
      catalog.authority !== 'none' || catalog.releaseEligible !== false) {
    throw new Error('Catalog requires a Root-reviewed checked-in revision and explicit atomic rows');
  }
  const ids = new Set();
  for (const row of catalog.requirements) {
    if (!row || !/^[A-Za-z0-9._-]+$/.test(row.id ?? '') || ids.has(row.id) ||
        typeof row.statement !== 'string' || !row.statement.trim() || typeof row.scope !== 'string' || !row.scope ||
        !Object.hasOwn(catalog.scopeValues ?? {}, row.scope)) throw new Error('Catalog has a missing, duplicate or malformed atomic row');
    ids.add(row.id);
  }
  // Deliberately no hardcoded 101/W0 claim: draft counts are not owner freeze.
  // Every selected row, including every excluded/deferred row, is retained.
  return catalog;
}

async function captureCandidate(root, git, options) {
  const text = async args => UTF8.decode(await git(args)).trim();
  if (MODULE !== path.join(root, `${PLUGIN}scripts/lib/formal-candidate-coverage-v1.mjs`)) {
    throw new Error('Coverage engine must execute from the selected candidate tree');
  }
  if (await realpath(root) !== root || await text(['rev-parse', '--show-toplevel']) !== root ||
      await text(['rev-parse', '--verify', 'HEAD^{commit}']) !== options.expectedHead ||
      await text(['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('Audit requires the exact clean candidate root');
  await git(['merge-base', '--is-ancestor', options.expectedBase, options.expectedHead]);
  const tree = await text(['rev-parse', '--verify', `${options.expectedHead}^{tree}`]);
  if (!SHA.test(tree)) throw new Error('Candidate tree is missing');
  // Git status is diagnostic only: assume-unchanged, skip-worktree and clean
  // filters cannot hide a different materialized file from these raw reads.
  // Keep missing-object fetch disabled in this audit's own fixed Git reader.
  const treeRecords = parseRuntimeProducerLsTreeV2(await git([
    'ls-tree', '-r', '-t', '-z', '--full-tree', options.expectedHead
  ]));
  const actualSource = await observeRuntimeSourceTreeV2({ sourceRoot: root, treeRecords });
  const materializedFiles = new Map(actualSource.files.map(file => [file.path, file]));
  const sources = [];
  let catalog;
  for (const name of BOUND_SOURCES) {
    const actual = await readPhysical(root, name);
    if (materializedFiles.get(name)?.sha256 !== hash(actual)) throw new Error(`Candidate source bytes differ: ${name}`);
    sources.push({ path: name, sha256: hash(actual) });
    if (name === CATALOG) catalog = parseCatalog(actual, options);
  }
  const scope = await productReleaseScope();
  // Stable and controlled RC share the existing full evaluator and exact
  // source/suite denominator. Channel selection does not accept draft rows or
  // convert missing protected producers/coverage into PASS.
  const releaseTarget = resolveProductReleaseTargetV1(scope.version);
  if (releaseTarget.productVersion !== '5.0.0' || !scope.scope || !HASH.test(scope.scopeDigest ?? '') ||
      !same(scope.releaseTarget, releaseTarget)) throw new Error('Audit lacks current product scope or exact release channel');
  const suiteManifest = await captureFormalSuiteManifest({ repositoryRoot: root, scriptPath: path.join(root, SCRIPT) });
  const expected = [...materializedFiles.keys()].filter(name => path.posix.dirname(name) === TESTS.slice(0, -1) &&
    isEligibleFormalSuite(path.posix.basename(name))).sort();
  if (!same(expected, suiteManifest.files.map(file => file.path))) throw new Error('Discovered evaluator denominator differs from candidate test tree');
  for (const file of suiteManifest.files) {
    if (materializedFiles.get(file.path)?.sha256 !== file.sha256) throw new Error('Candidate suite blob/content changed');
  }
  return { catalog, suiteManifest, binding: { repositoryRoot: root, repositoryIdentity: await repositoryIdentity(git, root),
    candidateHead: options.expectedHead, candidateBase: options.expectedBase, candidateTree: tree,
    productScopeDigest: scope.scopeDigest, releaseTargetDigest: releaseTarget.releaseTargetDigest,
    releaseChannelContractDigest: releaseTarget.channelContractDigest,
    profileId: FORMAL_FULL_PROFILE.id, profileDigest: digestObject(FORMAL_FULL_PROFILE),
    semanticCatalogRevision: catalog.revision, semanticCatalogSha256: options.expectedCatalogSha256,
    semanticRequirementMeaningDigest: digestObject(catalog.requirements.map(meaning)),
    sourceObservationKind: actualSource.kind, sourceFileCount: actualSource.fileCount,
    sourceInventoryDigest: actualSource.sourceInventoryDigest, sourceSnapshotDigest: actualSource.sourceSnapshotDigest,
    expectedSourceFilesDigest: actualSource.expectedFilesDigest,
    entrypointCatalogSha256: sources.find(file => file.path === `${PLUGIN}config/entrypoint-catalog.json`).sha256,
    evaluatorSuiteManifestDigest: suiteManifest.digest, sourceFiles: sources } };
}

function mappedSuites(row, catalog) {
  const names = [];
  for (const pointer of row.current?.test ?? []) {
    const name = catalog.pointerRegistry?.[pointer]?.path;
    if (typeof name === 'string') names.push(name);
  }
  for (const name of row.evidencePointers?.suites ?? []) names.push(name);
  if (!names.every(relative)) throw new Error('A catalog source pointer is not a relative source path');
  return [...new Set(names)].sort();
}

function executionObservation(name, lane, manifest) {
  if (!manifest.files.some(file => file.path === name)) return { suite: name, lane: lane.id, status: 'MISSING',
    reason: 'Mapped pointer is outside the unchanged candidate evaluator manifest' };
  const record = lane.terminal?.result?.formalSuites?.observations?.find(item => item.path === name);
  if (lane.status === 'NOT_RUN' || record?.status === 'NOT_RUN') return { suite: name, lane: lane.id, status: 'NOT_RUN' };
  if (!record) return { suite: name, lane: lane.id, status: 'MISSING', reason: 'No suite terminal observation' };
  return { suite: name, lane: lane.id, status: record.terminal?.exitStatusObserved ? 'OBSERVED' : 'NOT_OBSERVED',
    suiteStatus: record.status, terminal: record.terminal ?? null };
}

// Fixed actual-run observers reconciled to three rows of the checked-in draft.
// These anchors establish neither owner freeze nor completeness of the catalog.
// Changing a row's meaning makes its old observer MISSING.
const ATOMIC_CASES = Object.freeze({
  fe55ed83bd0ae08f590f77694e0ebb1dfa2eee3f2c5722f185023b1d7bb8b6aa: {
    id: 'formal.actual-reserved-profile-v1', evaluate(p) {
      return { status: 'OBSERVED', disposition: same(p.runtimeIdentities.map(r => ({ id: r.laneId, nodeVersion: r.nodeVersion,
        platform: r.platform, arch: r.arch })), FORMAL_FULL_PROFILE.lanes.map(l => ({ id: l.id, nodeVersion: l.nodeVersion,
        platform: FORMAL_FULL_PROFILE.platform, arch: FORMAL_FULL_PROFILE.arch }))) ? 'SATISFIED' : 'FAILED' };
    }
  },
  d93eb32ae01ecd206dffef223c035437b73f1fde153011f4a921375794854a2f: {
    id: 'formal.actual-runtime-before-after-v1', evaluate(p) {
      if (p.lanes.some(l => l.status === 'NOT_RUN')) return { status: 'NOT_RUN', disposition: 'UNSATISFIED' };
      if (p.lanes.some(l => !l.runtimeBefore || !l.runtimeAfter)) return { status: 'MISSING', disposition: 'UNSATISFIED' };
      return { status: 'OBSERVED', disposition: p.lanes.every((l, i) =>
        same(l.runtimeBefore, p.runtimeIdentities[i]) && same(l.runtimeAfter, p.runtimeIdentities[i])) ? 'SATISFIED' : 'FAILED' };
    }
  },
  '090e73a0a6a4e4da1494feebb3e63212c78d86398e325c817bae1050891031a6': {
    id: 'formal.actual-dual-lane-complete-manifest-v1', evaluate(p, selected) {
      if (p.lanes.some(l => l.status === 'NOT_RUN')) return { status: 'NOT_RUN', disposition: 'UNSATISFIED' };
      const expected = selected.suiteManifest.files.map(f => f.path);
      const complete = p.lanes.every(l => {
        const report = l.terminal?.result?.formalSuites;
        return same(l.postflight?.suiteManifest, selected.suiteManifest) && same(report?.expectedSuites, expected) &&
          same(report?.observations?.map(o => o.path), expected) && report.observations.every(o => o.terminal?.exitStatusObserved === true);
      });
      return { status: 'OBSERVED', disposition: complete ? 'SATISFIED' : 'FAILED' };
    }
  }
});

async function inspectWorker(options, mode) {
  options = validateOptions(options, mode);
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.getuid() === 0) throw new Error('This audit consumes the macOS arm64 nonroot full profile');
  const deadline = performance.now() + AUDIT_MS;
  const git = await gitReader(options.repositoryRoot, deadline);
  const selected = await captureCandidate(options.repositoryRoot, git, options);
  const completionBytes = await readPhysical(options.launchRoot, 'completion.json', { privateFile: true });
  const completion = parseBoundedJsonBytes(completionBytes, MAX_FILE);
  const context = completion?.context;
  if (context?.operationNonce !== options.expectedOperationNonce || context.launchRoot !== options.launchRoot ||
      context.expectedHead !== options.expectedHead || context.expectedBase !== options.expectedBase ||
      context.ownerHome !== os.homedir() || context.repositoryIdentity !== selected.binding.repositoryIdentity) {
    throw new Error('Completion nonce/source/owner/repository does not match the selected actual attempt');
  }
  // No caller-provided replay result is accepted. This reopens actual durable
  // aggregate, intent, ledger and release records via the existing engine.
  const replay = await replayFullFormalCompletion(completion, { expectedHead: options.expectedHead,
    expectedBase: options.expectedBase, ownerHome: os.homedir(), repositoryIdentity: selected.binding.repositoryIdentity,
    ledgerPath: context.ledgerPath });
  if (replay.formalAttemptId !== options.expectedFormalAttemptId || replay.receiptDigest !== options.expectedReceiptDigest ||
      replay.ledgerDigest !== options.expectedLedgerDigest || replay.releaseEligible !== false || replay.authority !== 'none') {
    throw new Error('Durable replay attempt/receipt/ledger differs from the selected inspection');
  }
  const aggregateBytes = await readPhysical(options.launchRoot, 'receipt.json', { privateFile: true });
  if (hash(aggregateBytes) !== replay.receiptDigest) throw new Error('Aggregate bytes changed after replay');
  const aggregate = parseBoundedJsonBytes(aggregateBytes, MAX_FILE);
  const p = aggregate.provisional;
  if (aggregate.operationNonce !== options.expectedOperationNonce || aggregate.formalAttemptId !== replay.formalAttemptId ||
      p?.repositoryRoot !== options.repositoryRoot || p.expectedHead !== options.expectedHead ||
      p.profileId !== selected.binding.profileId || !same(p.suiteManifest, selected.suiteManifest)) {
    throw new Error('Replayed formal result is not this candidate/source/manifest');
  }
  const rows = selected.catalog.requirements.map(row => {
    const required = row.scope === 'V5.0_REQUIRED';
    const cases = ATOMIC_CASES[digestObject(meaning(row))];
    const suites = mappedSuites(row, selected.catalog);
    const execution = suites.flatMap(name => p.lanes.map(lane => executionObservation(name, lane, selected.suiteManifest)));
    let semantic = required ? { status: 'MISSING', disposition: 'UNSATISFIED',
      reason: 'No reconciled complete atomic case/typed observer; suite PASS and source pointers cannot satisfy this row' }
      : { status: 'NOT_RUN', disposition: 'OUTSIDE_SELECTED_REQUIRED_SCOPE', reason: 'Retained catalog scope classification; exclusion is never PASS' };
    if (required && cases) semantic = { ...cases.evaluate(p, selected), caseId: cases.id,
      caseKind: 'ACTUAL_LOCAL_FORMAL_OBSERVATION', evidenceBindingDigest: digestObject(replay) };
    return { id: row.id, group: row.group ?? null, scope: row.scope, required,
      meaningDigest: digestObject(meaning(row)), semantic, suiteExecution: execution,
      suiteMappingStatus: suites.length ? 'SOURCE_POINTERS_ONLY' : 'MISSING' };
  });
  const required = rows.filter(row => row.required);
  const semanticComplete = required.length > 0 && required.every(row => row.semantic.status === 'OBSERVED' && row.semantic.disposition === 'SATISFIED');
  const payload = { schemaVersion: 1, kind: 'FormalSemanticCoverageAuditV1', auditOperation: 'SEPARATE_READ_ONLY_INSPECTION',
    authority: 'none', authentication: 'unsigned-local-observation', releaseEligible: false,
    subject: selected.binding, subjectDigest: digestObject(selected.binding),
    formalObservation: { operationNonce: options.expectedOperationNonce, ...replay, completionSha256: hash(completionBytes),
      startedAt: aggregate.startedAt, finishedAt: aggregate.finishedAt,
      meaning: 'REPLAY_OF_SELECTED_EXISTING_ATTEMPT_NO_NEW_EXECUTION' },
    catalogObservation: { status: selected.catalog.catalogStatus ?? 'UNATTESTED_LOCAL_CATALOG',
      ownerFreeze: 'NOT_AUTHENTICATED_BY_THIS_AUDIT', claimScope: 'ALL_ROWS_OF_SELECTED_CATALOG_ONLY',
      fullW0Completeness: 'NOT_ESTABLISHED', selectedRowCount: rows.length, requiredRowCount: required.length },
    semanticObservationComplete: semanticComplete, semanticDisposition: semanticComplete ? 'OBSERVED_SELECTED_CRITERIA' : 'INCOMPLETE',
    counts: Object.fromEntries(['OBSERVED', 'NOT_OBSERVED', 'NOT_RUN', 'MISSING'].map(status =>
      [status, required.filter(row => row.semantic.status === status).length])), rows };
  // Re-observe source and replay after deriving rows. No stale source or ledger
  // can survive by relying only on its old self-digest.
  const after = await captureCandidate(options.repositoryRoot, git, options);
  const replayAfter = await replayFullFormalCompletion(completion, { expectedHead: options.expectedHead,
    expectedBase: options.expectedBase, ownerHome: os.homedir(), repositoryIdentity: selected.binding.repositoryIdentity,
    ledgerPath: context.ledgerPath });
  if (performance.now() >= deadline || !same(after.binding, selected.binding) || !same(after.suiteManifest, selected.suiteManifest) ||
      !same(replayAfter, replay) || !(await readPhysical(options.launchRoot, 'completion.json', { privateFile: true })).equals(completionBytes)) {
    throw new Error('Inspection budget/source/completion/durable replay drifted');
  }
  const result = { ...payload, reportDigest: digestObject(payload) };
  if (mode === 'replay') {
    const previousBytes = await readPhysical(path.dirname(options.reportPath), path.basename(options.reportPath), { privateFile: true });
    const previous = parseBoundedJsonBytes(previousBytes, MAX_FILE);
    if (!same(previous, result)) throw new Error('Coverage replay differs from recomputed candidate-bound observations');
  }
  return result;
}

// The 30s worker budget and observed cleanup (up to two 5s phases) do not touch
// the original formal 95min budget, exactly3 captures, ledger or status.
export async function runFormalSemanticCoverageAuditV1(options, { mode = 'audit' } = {}) {
  if (!['audit', 'replay'].includes(mode)) throw new Error('Unsupported coverage inspection mode');
  options = validateOptions(options, mode);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Coverage inspection cancelled'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await spawnCapture(process.execPath, [MODULE, '--coverage-worker'], { cwd: options.repositoryRoot,
      // This observer must reopen the owner's actual formal ledger. Suite
      // children use /var/empty; the audit worker consumes owner-bound records.
      env: { ...createFormalSuiteEnvironment(PATH_VALUE, {}), HOME: os.homedir() },
      timeoutMs: AUDIT_MS, cleanupGraceMs: CLEANUP_MS,
      maxOutputBytes: MAX_FILE, abortSignal: controller.signal, encoding: null, input: JSON.stringify({ mode, options }) });
    if (controller.signal.aborted || !formalCaptureSucceeded(result)) throw new Error('Coverage inspection terminal/bounds/group cleanup did not pass');
    const stdout = decodeBoundedUtf8Bytes(result.stdout, MAX_FILE);
    const stderr = decodeBoundedUtf8Bytes(result.stderr, MAX_FILE);
    if (stderr.text !== '') throw new Error('Coverage inspection terminal/bounds/group cleanup did not pass');
    const report = parseStrictJsonV1(stdout.text, { maxBytes: MAX_FILE });
    const { reportDigest, ...payload } = report;
    if (report.kind !== 'FormalSemanticCoverageAuditV1' || report.authority !== 'none' || report.releaseEligible !== false ||
        reportDigest !== digestObject(payload)) throw new Error('Coverage worker returned an invalid observation report');
    return report;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

function cliOptions(args) {
  const [mode, ...tokens] = args;
  const flags = { 'repository-root': 'repositoryRoot', 'expected-head': 'expectedHead', 'expected-base': 'expectedBase',
    'launch-root': 'launchRoot', 'expected-catalog-revision': 'expectedCatalogRevision',
    'expected-catalog-sha256': 'expectedCatalogSha256', 'expected-operation-nonce': 'expectedOperationNonce',
    'expected-attempt-id': 'expectedFormalAttemptId', 'expected-receipt-digest': 'expectedReceiptDigest',
    'expected-ledger-digest': 'expectedLedgerDigest', ...(mode === 'replay' ? { 'report-path': 'reportPath' } : {}) };
  if (!['audit', 'replay'].includes(mode) || tokens.length % 2) throw new Error('Use audit or replay with exact named bindings');
  const options = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const key = flags[tokens[i].slice(2)];
    if (!tokens[i].startsWith('--') || !key || Object.hasOwn(options, key) || !tokens[i + 1] || tokens[i + 1].startsWith('--')) {
      throw new Error('Unknown, duplicate or missing audit option');
    }
    options[key] = tokens[i + 1];
  }
  return { mode, options: validateOptions(options, mode) };
}

function emitReport(report) {
  const output = canonicalJson(report);
  if (Buffer.byteLength(output) > MAX_FILE) throw new Error('Coverage report exceeds its output bound');
  process.stdout.write(`${output}\n`);
}

function emitIncomplete(error) {
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, kind: 'FormalSemanticCoverageAuditIncompleteV1',
    authority: 'none', releaseEligible: false, semanticObservationComplete: false,
    error: String(error.message).slice(0, 500) })}\n`);
  process.exitCode = 1;
}

export async function runFormalCandidateCoverageCliV1(args) {
  try {
    const request = cliOptions(args);
    const report = await runFormalSemanticCoverageAuditV1(request.options, { mode: request.mode });
    emitReport(report);
    // A completed inspection can still expose missing semantic observations.
    // Exit zero never grants authority, even when all selected rows are observed.
    if (!report.semanticObservationComplete) process.exitCode = 2;
    return report;
  } catch (error) {
    emitIncomplete(error);
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE) {
  if (process.argv[2] === '--coverage-worker' && process.argv.length === 3) {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length; if (size > 32 * 1024) throw new Error('Coverage request exceeds its input bound');
        chunks.push(chunk);
      }
      const request = parseBoundedJsonBytes(Buffer.concat(chunks), 32 * 1024);
      if (Object.keys(request).sort().join(',') !== 'mode,options' || !['audit', 'replay'].includes(request.mode)) {
        throw new Error('Coverage worker request is invalid');
      }
      emitReport(await inspectWorker(request.options, request.mode));
    } catch (error) { emitIncomplete(error); }
  } else {
    await runFormalCandidateCoverageCliV1(process.argv.slice(2));
  }
}
