import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

import {
  apacheClosureVerifierFromScan,
  cleanupOwnedProcessGroupForTest,
  loseOwnedSupervisorProofForTest,
  restoreOwnedSupervisorProofForTest,
  runBoundedProcessForTest,
  scanPackage,
  BUILD_RECEIPT_KIND,
  CLOSURE_RECEIPT_KIND,
} from '../scripts/closure-check.mjs';

const PACKAGE_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = path.resolve(PACKAGE_DIR, '../..');
const PACKAGE_ROOT = 'packages/better-workflows-wire';

function manifest(name = '@fixture/wire', exportsTarget = './src/index.mjs') {
  return {
    name,
    version: '1.0.0',
    license: 'Apache-2.0',
    type: 'module',
    exports: {
      '.': {
        import: exportsTarget,
        default: exportsTarget,
      },
    },
  };
}

async function fixture(files, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'better-workflows-wire-closure-'));
  const packageDir = path.join(root, 'packages', 'wire');
  await mkdir(packageDir, { recursive: true });
  const contents = {
    'package.json': JSON.stringify(options.manifest ?? manifest(), null, 2) + '\n',
    ...files,
  };
  for (const [relative, content] of Object.entries(contents)) {
    const absolute = path.join(packageDir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  const packFiles = Object.entries(contents).map(([relative, content]) => ({
    path: relative,
    size: Buffer.byteLength(content),
    mode: 0o644,
  }));
  return { root, packageDir, packFiles, contents };
}

async function scanFixture(files, options = {}) {
  const value = await fixture(files, options);
  const scan = await scanPackage({
    packageDir: value.packageDir,
    repoRoot: value.root,
    packageRoot: 'packages/wire',
    packFiles: value.packFiles,
    buildReceiptPath: 'evidence/wire-build.json',
    closureReceiptPath: 'evidence/wire-closure.json',
  });
  return { ...value, scan };
}

function gitCommand(root, args, { encoding = 'utf8' } = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

function repositoryHead() {
  return gitCommand(REPO_ROOT, ['rev-parse', 'HEAD']).trim();
}

async function sourceFixture(files, options = {}) {
  const value = await fixture(files, options);
  gitCommand(value.root, ['init', '-q']);
  gitCommand(value.root, ['config', 'user.email', 'wire-closure-test@example.invalid']);
  gitCommand(value.root, ['config', 'user.name', 'wire-closure-test']);
  gitCommand(value.root, ['add', '.']);
  gitCommand(value.root, ['commit', '-qm', 'wire source fixture']);
  const sourceRevision = gitCommand(value.root, ['rev-parse', 'HEAD']).trim();
  return { ...value, sourceRevision };
}

async function scanSourceFixture(files, options = {}) {
  const value = await sourceFixture(files, options);
  const scan = await scanPackage({
    packageDir: value.packageDir,
    repoRoot: value.root,
    packageRoot: 'packages/wire',
    sourceRevision: value.sourceRevision,
    buildReceiptPath: 'evidence/wire-build.json',
    closureReceiptPath: 'evidence/wire-closure.json',
  });
  return { ...value, scan };
}

async function waitForFile(filePath, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function waitForProcessGroupAbsent(pid, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for process group ${pid} to disappear`);
}

test('scans the exact npm pack file universe and emits validator-bound receipts', async () => {
  const scan = await scanPackage({
    packageDir: PACKAGE_DIR,
    repoRoot: REPO_ROOT,
    packageRoot: PACKAGE_ROOT,
  });
  assert.equal(scan.packSource, 'npm-pack-dry-run');
  assert.equal(scan.packTool.name, 'npm');
  assert.match(scan.packTool.version, /^\d+\.\d+\.\d+/);
  assert.equal(scan.packTool.source, 'node-installation');
  assert.match(scan.packTool.path, /\/npm-cli\.js$/);
  assert.match(scan.packTool.sha256, /^[a-f0-9]{64}$/);
  assert.match(scan.packTool.nodePath, /\/node$/);
  assert.equal(scan.packTool.nodeVersion, process.version);
  assert.equal(scan.packTool.platform, process.platform);
  assert.equal(scan.packTool.processGroup, 'detached-posix-pgid');
  assert.equal(scan.packTool.cleanup.versionProbe.verified, true);
  assert.equal(scan.packTool.cleanup.packProbe.verified, true);
  assert.equal(scan.packTool.cleanup.cache.verified, true);
  assert.equal(scan.verified, true);
  assert.equal(scan.independent, true);
  assert.deepEqual(scan.packageFiles.map((entry) => entry.path), [
    `${PACKAGE_ROOT}/LICENSE`,
    `${PACKAGE_ROOT}/NOTICE`,
    `${PACKAGE_ROOT}/package.json`,
    `${PACKAGE_ROOT}/README.md`,
    `${PACKAGE_ROOT}/src/index.d.ts`,
    `${PACKAGE_ROOT}/src/index.mjs`,
  ]);
  assert.equal(scan.apacheEvidence.packageRoot, PACKAGE_ROOT);
  assert.equal(scan.buildReceiptContent.kind, BUILD_RECEIPT_KIND);
  assert.equal(scan.closureReceiptContent.kind, CLOSURE_RECEIPT_KIND);
  assert.equal(scan.buildReceiptContent.packageFilesSha256, scan.packageFilesSha256);
  assert.equal(scan.closureReceiptContent.packageFilesSha256, scan.packageFilesSha256);
  assert.equal(scan.closureReceiptContent.buildReceiptSha256, scan.buildReceipt.sha256);
  assert.deepEqual(apacheClosureVerifierFromScan(scan), {
    verified: true,
    packageFilesSha256: scan.packageFilesSha256,
    manifestSha256: scan.packageManifest.sha256,
    buildSha256: scan.buildReceipt.sha256,
    closureSha256: scan.closureReceipt.sha256,
  });
});

test('scans the exact Git source tree separately from the npm distribution universe', async () => {
  const sourceRevision = repositoryHead();
  const scan = await scanPackage({
    packageDir: PACKAGE_DIR,
    repoRoot: REPO_ROOT,
    packageRoot: PACKAGE_ROOT,
    sourceRevision,
  });
  assert.equal(scan.universeKind, 'git-source-tree');
  assert.equal(scan.sourceRevision, sourceRevision);
  assert.equal(scan.sourceFiles.length, 9);
  assert.equal(scan.packageFiles.length, 0);
  assert.equal(scan.independent, true);
  assert.equal(scan.verified, true);
  assert.deepEqual(scan.sourceFiles.map((entry) => entry.path), [
    `${PACKAGE_ROOT}/LICENSE`,
    `${PACKAGE_ROOT}/NOTICE`,
    `${PACKAGE_ROOT}/package.json`,
    `${PACKAGE_ROOT}/README.md`,
    `${PACKAGE_ROOT}/scripts/closure-check.mjs`,
    `${PACKAGE_ROOT}/src/index.d.ts`,
    `${PACKAGE_ROOT}/src/index.mjs`,
    `${PACKAGE_ROOT}/test/closure-check.test.mjs`,
    `${PACKAGE_ROOT}/test/wire.test.mjs`,
  ]);
  assert.match(scan.sourceFilesSha256, /^[a-f0-9]{64}$/);
  assert.match(scan.sourceTreeSha256, /^[a-f0-9]{64}$/);
  assert.equal(scan.buildReceiptContent.universeKind, 'git-source-tree');
  assert.equal(scan.buildReceiptContent.sourceRevision, sourceRevision);
  assert.equal(scan.closureReceiptContent.universeKind, 'git-source-tree');
  assert.equal(scan.closureReceiptContent.sourceRevision, sourceRevision);
  assert.equal(scan.closureReceiptContent.sourceFiles.length, 9);
  assert.equal(scan.sourceReceipt.universeKind, 'git-source-tree');
  assert.deepEqual(apacheClosureVerifierFromScan(scan), {
    verified: true,
    universeKind: 'git-source-tree',
    sourceRevision,
    sourceFilesSha256: scan.sourceFilesSha256,
    sourceTreeSha256: scan.sourceTreeSha256,
    manifestSha256: scan.packageManifest.sha256,
    buildSha256: scan.buildReceipt.sha256,
    closureSha256: scan.closureReceipt.sha256,
  });
});

test('rejects Git source digest drift before producing a verified receipt', async () => {
  const sourceRevision = repositoryHead();
  const scan = await scanPackage({
    packageDir: PACKAGE_DIR,
    repoRoot: REPO_ROOT,
    packageRoot: PACKAGE_ROOT,
    sourceRevision,
    sourceFilesSha256: '0'.repeat(64),
  });
  assert.equal(scan.universeKind, 'git-source-tree');
  assert.equal(scan.verified, false);
  assert.ok(scan.scannerErrors.some((entry) => entry.code === 'SOURCE_GIT_READ_FAILED' && /source files digest drifted/.test(entry.message)));
  assert.equal(apacheClosureVerifierFromScan(scan), null);
});

test('source tree closure rejects direct, transitive, and re-exported AGPL imports', async () => {
  const fixtures = [];
  const cases = [
    {
      name: 'direct',
      files: { 'src/index.mjs': 'import core from "better-workflows/core"; export default core;\n' },
      expected: (scan) => scan.coreImports.some((entry) => entry.specifier === 'better-workflows/core'),
    },
    {
      name: 'transitive',
      files: {
        'src/index.mjs': 'export * from "./bridge.mjs";\n',
        'src/bridge.mjs': 'export * from "better-workflows/core";\n',
      },
      expected: (scan) => scan.indirectCoreImports.some((entry) => entry.importer.endsWith('/src/index.mjs') && entry.via.endsWith('/src/bridge.mjs')),
    },
    {
      name: 're-export',
      files: { 'src/index.mjs': 'export * from "plugins/better-workflows/core.mjs";\n' },
      expected: (scan) => scan.coreImports.some((entry) => entry.specifier === 'plugins/better-workflows/core.mjs'),
    },
  ];
  try {
    for (const item of cases) {
      const value = await scanSourceFixture(item.files);
      fixtures.push(value);
      assert.equal(value.scan.universeKind, 'git-source-tree', item.name);
      assert.equal(value.scan.sourceFiles.length, Object.keys(value.contents).length, item.name);
      assert.equal(value.scan.independent, false, item.name);
      assert.equal(value.scan.verified, false, item.name);
      assert.equal(item.expected(value.scan), true, item.name);
    }
  } finally {
    for (const value of fixtures) await rm(value.root, { recursive: true, force: true });
  }
});

test('module requests accept the legacy shape without accepting invalid explicit phases', async (t) => {
  const core = 'better-workflows/core';
  const cases = [
    { name: 'legacy core', request: { specifier: core, attributes: {} }, core: true, source: true },
    { name: 'legacy builtin', request: { specifier: 'node:fs', attributes: {} }, verified: true, source: true },
    { name: 'evaluation phase', request: { specifier: core, attributes: {}, phase: 'evaluation' }, core: true },
    { name: 'source phase', request: { specifier: core, attributes: {}, phase: 'source' }, core: true },
    ...[undefined, null, 'future'].map((phase) => ({
      name: `explicit ${String(phase)} phase`, request: { specifier: 'node:fs', attributes: {}, phase },
      error: 'unknown-module-request-phase',
    })),
    { name: 'missing attributes', request: { specifier: core }, error: 'unknown-module-request-phase' },
    { name: 'null attributes', request: { specifier: core, attributes: null }, error: 'unknown-module-request-phase' },
    { name: 'array attributes', request: { specifier: core, attributes: [] }, error: 'unknown-module-request-phase' },
    { name: 'null request', request: null, error: 'module-request-specifier-missing' },
    { name: 'array request', request: [], error: 'module-request-specifier-missing' },
    { name: 'empty specifier', request: { specifier: '', attributes: {} }, error: 'module-request-specifier-missing' },
    { name: 'inherited unknown phase', request: Object.assign(Object.create({ phase: 'future' }), {
      specifier: core, attributes: {},
    }), error: 'unknown-module-request-phase' },
    { name: 'inherited attributes', request: Object.assign(Object.create({ attributes: {} }), {
      specifier: core,
    }), error: 'unknown-module-request-phase' },
  ];
  for (const item of cases) {
    for (const mode of item.source ? ['pack', 'source'] : ['pack']) {
      await t.test(`${mode}: ${item.name}`, async () => {
        const prototype = vm.SourceTextModule.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'moduleRequests');
        let value;
        let getterCalls = 0;
        try {
          Object.defineProperty(prototype, 'moduleRequests', {
            configurable: true,
            get: () => { getterCalls++; return Object.freeze([item.request]); },
          });
          const scan = mode === 'source' ? scanSourceFixture : scanFixture;
          const specifier = item.request?.specifier || core;
          value = await scan({ 'src/index.mjs': `import dependency from ${JSON.stringify(specifier)}; export default dependency;\n` });
          assert.ok(getterCalls > 0, 'the moduleRequests shadow getter must be exercised');
          assert.equal(value.scan.verified, item.verified === true);
          assert.equal(value.scan.independent, item.verified === true);
          assert.equal(value.scan.coreImports.some((entry) => entry.specifier === core), item.core === true);
          assert.deepEqual(value.scan.scannerErrors, []);
          assert.deepEqual(value.scan.syntaxErrors, []);
          if (item.error) assert.ok(value.scan.unresolvedDependencies.some((entry) => entry.kind === item.error));
          else assert.deepEqual(value.scan.unresolvedDependencies, []);
        } finally {
          if (descriptor) Object.defineProperty(prototype, 'moduleRequests', descriptor);
          else delete prototype.moduleRequests;
          if (value) await rm(value.root, { recursive: true, force: true });
        }
      });
    }
  }
});

test('native builtin classification recognizes prefix-only modules without admitting unknown imports', async (t) => {
  for (const mode of ['pack', 'source']) {
    for (const item of [
      { name: 'builtins', specifiers: ['node:test', 'node:test/reporters', 'node:fs', 'fs'], verified: true },
      { name: 'unknown imports', specifiers: ['node:sbw-unknown-builtin', 'test', 'test/reporters'], verified: false },
    ]) {
      await t.test(`${mode}: ${item.name}`, async () => {
        const scan = mode === 'source' ? scanSourceFixture : scanFixture;
        const source = item.specifiers.map((specifier) => `import ${JSON.stringify(specifier)};`).join('\n');
        const value = await scan({ 'src/index.mjs': source });
        try {
          assert.equal(value.scan.verified, item.verified);
          assert.equal(value.scan.independent, item.verified);
          for (const key of ['scannerErrors', 'syntaxErrors', 'coreImports', 'indirectCoreImports', 'dynamicDependencies', 'pathEscapes']) {
            assert.deepEqual(value.scan[key], [], key);
          }
          const edges = value.scan.moduleGraph.flatMap((entry) => entry.imports);
          assert.deepEqual(edges.map((edge) => edge.specifier).sort(), [...item.specifiers].sort());
          if (item.verified) {
            assert.ok(edges.every((edge) => edge.kind === 'builtin'));
            assert.deepEqual(value.scan.unresolvedDependencies, []);
          } else {
            assert.ok(edges.every((edge) => edge.kind === 'unresolved'));
            assert.deepEqual(value.scan.unresolvedDependencies.map((entry) => entry.specifier).sort(), [...item.specifiers].sort());
            assert.ok(value.scan.unresolvedDependencies.every((entry) => entry.kind === 'external-import'));
          }
        } finally {
          await rm(value.root, { recursive: true, force: true });
        }
      });
    }
  }
});

test('source mode binds literal dynamic imports to tokenizer tokens', async () => {
  const fixtures = [];
  const decoyCases = [
    {
      name: 'string-decoy',
      source: `const specifier = 'better-workflows/core';
const decoy = "import('./lazy.mjs')";
export async function load() { return import(specifier); }
`,
    },
    {
      name: 'comment-decoy',
      source: `const specifier = 'better-workflows/core';
/* import('./lazy.mjs') */
export async function load() { return import(specifier); }
`,
    },
    {
      name: 'template-decoy',
      source: `const specifier = 'better-workflows/core';
const decoy = \`import('./lazy.mjs')\`;
export async function load() { return import(specifier); }
`,
    },
  ];
  try {
    for (const item of decoyCases) {
      const value = await scanSourceFixture({
        'src/index.mjs': item.source,
        'src/lazy.mjs': 'export default null;\n',
      });
      fixtures.push(value);
      assert.equal(value.scan.universeKind, 'git-source-tree', item.name);
      assert.equal(value.scan.independent, false, item.name);
      assert.equal(value.scan.verified, false, item.name);
      assert.ok(value.scan.dynamicDependencies.some((entry) => entry.kind === 'dynamic-import' && entry.file.endsWith('/src/index.mjs')), item.name);
      assert.equal(value.scan.coreImports.length, 0, item.name);
    }

    const literalCore = await scanSourceFixture({
      'src/index.mjs': "export async function load() { return import('better-workflows/core'); }\n",
    });
    fixtures.push(literalCore);
    assert.equal(literalCore.scan.independent, false);
    assert.equal(literalCore.scan.verified, false);
    assert.ok(literalCore.scan.coreImports.some((entry) => entry.specifier === 'better-workflows/core' && entry.kind === 'dynamic'));
    assert.equal(literalCore.scan.dynamicDependencies.length, 0);

    const literalLocal = await scanSourceFixture({
      'src/index.mjs': "export async function load() { return import('./lazy.mjs'); }\n",
      'src/lazy.mjs': 'export default null;\n',
    });
    fixtures.push(literalLocal);
    assert.equal(literalLocal.scan.independent, true);
    assert.equal(literalLocal.scan.verified, true);
    assert.equal(literalLocal.scan.dynamicDependencies.length, 0);
    assert.ok(literalLocal.scan.moduleGraph.some((record) => record.imports.some((edge) => edge.specifier === './lazy.mjs' && edge.requestKind === 'dynamic' && edge.kind === 'internal')));
  } finally {
    for (const value of fixtures) await rm(value.root, { recursive: true, force: true });
  }
});

test('ignores caller npm_execpath and records the canonical Node installation tool', async () => {
  const previousExecPath = process.env.npm_execpath;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  const envRoot = await mkdtemp(path.join(os.tmpdir(), 'better-workflows-wire-env-'));
  const loaderPath = path.join(envRoot, 'loader.cjs');
  const markerPath = path.join(envRoot, 'loaded');
  await writeFile(loaderPath, `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'loaded');\n`);
  process.env.npm_execpath = '/private/tmp/fake-npm-cli.js';
  process.env.NODE_OPTIONS = `--require=${loaderPath}`;
  try {
    const scan = await scanPackage({
      packageDir: PACKAGE_DIR,
      repoRoot: REPO_ROOT,
      packageRoot: PACKAGE_ROOT,
    });
    assert.equal(scan.verified, true);
    assert.equal(scan.packTool.source, 'node-installation');
    assert.notEqual(scan.packTool.path, process.env.npm_execpath);
    assert.equal(scan.packTool.cleanup.versionProbe.verified, true);
    assert.equal(scan.packTool.cleanup.packProbe.verified, true);
    assert.equal(scan.packTool.cleanup.cache.verified, true);
    await assert.rejects(readFile(markerPath));
  } finally {
    if (previousExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previousExecPath;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
    await rm(envRoot, { recursive: true, force: true });
  }
});

test('rejects zero and too-small budgets without spawning a supervisor', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) {
    t.skip(`owned POSIX process groups are unsupported on ${process.platform}`);
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'better-workflows-wire-no-budget-'));
  const cases = [
    { name: 'zero-timeout', timeoutMs: 0, cleanupGraceMs: 25, state: 'invalid-process-budget' },
    { name: 'zero-grace', timeoutMs: 200, cleanupGraceMs: 0, state: 'invalid-process-budget' },
    { name: 'negative-timeout', timeoutMs: -1, cleanupGraceMs: 25, state: 'invalid-process-budget' },
    { name: 'nan-timeout', timeoutMs: Number.NaN, cleanupGraceMs: 25, state: 'invalid-process-budget' },
    { name: 'negative-grace', timeoutMs: 200, cleanupGraceMs: -1, state: 'invalid-process-budget' },
    { name: 'nan-grace', timeoutMs: 200, cleanupGraceMs: Number.NaN, state: 'invalid-process-budget' },
    { name: 'too-small', timeoutMs: 50, cleanupGraceMs: 25, state: 'no-available-budget' },
    { name: 'too-large-grace', timeoutMs: 200, cleanupGraceMs: 100, state: 'no-available-budget' },
    { name: 'too-large-timeout', timeoutMs: Number.MAX_SAFE_INTEGER, cleanupGraceMs: 25, state: 'invalid-process-budget' },
  ];
  try {
    for (const item of cases) {
      const markerPath = path.join(root, `${item.name}-started`);
      let proofObserved = false;
      const probe = await runBoundedProcessForTest(process.execPath, [
        '--input-type=module',
        '-e',
        `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(markerPath)}, 'started');`,
      ], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: item.timeoutMs,
        cleanupGraceMs: item.cleanupGraceMs,
        onOwnerProof: () => { proofObserved = true; },
      });
      assert.equal(probe.child, null, item.name);
      assert.equal(probe.cleanup.verified, false, item.name);
      assert.equal(probe.cleanup.state, item.state, item.name);
      assert.match(probe.error, /timeout\/grace budget is invalid or too small/, item.name);
      assert.equal(proofObserved, false, item.name);
      await assert.rejects(readFile(markerPath, 'utf8'));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounds timeout and kills descendants in the owned process group', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) {
    t.skip(`owned POSIX process groups are unsupported on ${process.platform}`);
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'better-workflows-wire-process-'));
  const startedPath = path.join(root, 'started');
  const finishedPath = path.join(root, 'finished');
  const descendantSource = [
    "import { writeFile } from 'node:fs/promises';",
    `await writeFile(${JSON.stringify(startedPath)}, 'started');`,
    'await new Promise((resolve) => setTimeout(resolve, 700));',
    `await writeFile(${JSON.stringify(finishedPath)}, 'finished');`,
  ].join('\n');
  const leaderSource = [
    "import { spawn } from 'node:child_process';",
    `spawn(${JSON.stringify(process.execPath)}, ['--input-type=module', '-e', ${JSON.stringify(descendantSource)}], { detached: false, stdio: 'ignore' });`,
    "process.on('SIGTERM', () => {});",
    'await new Promise((resolve) => setTimeout(resolve, 10_000));',
  ].join('\n');
  let probe = null;
  const startedAt = Date.now();
  try {
    probe = await runBoundedProcessForTest(process.execPath, ['--input-type=module', '-e', leaderSource], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 700,
      cleanupGraceMs: 100,
      maxBuffer: 64 * 1024,
    });
    assert.match(probe.error, /bounded process exceeded 700ms/);
    assert.equal(probe.cleanup.verified, true);
    assert.deepEqual(probe.cleanup.requestedSignals, ['SIGTERM', 'SIGKILL']);
    assert.equal(probe.cleanup.observedSignal, null);
    assert.equal(probe.cleanup.signal, null);
    assert.equal(probe.child.signal, null);
    assert.equal(await readFile(startedPath, 'utf8'), 'started');
    assert.ok(Date.now() - startedAt < 1_000, `bounded operation exceeded total budget: ${Date.now() - startedAt}ms`);
    await assert.rejects(readFile(finishedPath, 'utf8'));
    await waitForProcessGroupAbsent(probe.child.pid);
  } finally {
    if (probe?.child?.pid) await cleanupOwnedProcessGroupForTest(probe.child.pid, { graceMs: 50, deadline: Date.now() + 100 });
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves an observed target signal in the cleanup receipt', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) {
    t.skip(`owned POSIX process groups are unsupported on ${process.platform}`);
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'better-workflows-wire-observed-signal-'));
  let probe = null;
  try {
    probe = await runBoundedProcessForTest(process.execPath, [
      '--input-type=module',
      '-e',
      "process.kill(process.pid, 'SIGTERM');",
    ], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 600,
      cleanupGraceMs: 50,
    });
    assert.equal(probe.cleanup.verified, true);
    assert.equal(probe.child.signal, 'SIGTERM');
    assert.equal(probe.cleanup.observedSignal, 'SIGTERM');
    assert.equal(probe.cleanup.signal, 'SIGTERM');
    assert.deepEqual(probe.cleanup.requestedSignals, ['SIGTERM', 'SIGKILL']);
    await waitForProcessGroupAbsent(probe.child.pid);
  } finally {
    if (probe?.child?.pid) await cleanupOwnedProcessGroupForTest(probe.child.pid, { graceMs: 25, deadline: Date.now() + 100 });
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a delayed target start after the operation deadline', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) {
    t.skip(`owned POSIX process groups are unsupported on ${process.platform}`);
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'better-workflows-wire-start-deadline-'));
  const markerPath = path.join(root, 'started');
  let probe = null;
  const startedAt = Date.now();
  try {
    probe = await runBoundedProcessForTest(process.execPath, [
      '--input-type=module',
      '-e',
      `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(markerPath)}, 'started');`,
    ], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 300,
      cleanupGraceMs: 50,
      startDelayMs: 500,
    });
    assert.match(probe.error, /bounded process exceeded 300ms|owned supervisor refused target start/);
    await assert.rejects(readFile(markerPath, 'utf8'));
    assert.deepEqual(probe.cleanup.requestedSignals, ['SIGTERM', 'SIGKILL']);
    assert.equal(probe.cleanup.observedSignal, null);
    assert.equal(probe.cleanup.signal, null);
    assert.equal(probe.cleanup.verified, true);
    assert.ok(Date.now() - startedAt < 500, `delayed start exceeded total budget: ${Date.now() - startedAt}ms`);
    await waitForProcessGroupAbsent(probe.child.pid);
  } finally {
    if (probe?.child?.pid) await cleanupOwnedProcessGroupForTest(probe.child.pid, { graceMs: 25, deadline: Date.now() + 100 });
    await rm(root, { recursive: true, force: true });
  }
});

test('supervisor enforces its deadline while the parent event loop is blocked', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) {
    t.skip(`owned POSIX process groups are unsupported on ${process.platform}`);
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'better-workflows-wire-parent-delay-'));
  const startedPath = path.join(root, 'started');
  const finishedPath = path.join(root, 'finished');
  const targetSource = [
    "import { writeFile } from 'node:fs/promises';",
    `await writeFile(${JSON.stringify(startedPath)}, 'started');`,
    "process.on('SIGTERM', () => {});",
    'await new Promise((resolve) => setTimeout(resolve, 5_000));',
    `await writeFile(${JSON.stringify(finishedPath)}, 'finished');`,
  ].join('\n');
  let probe = null;
  const running = runBoundedProcessForTest(process.execPath, ['--input-type=module', '-e', targetSource], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 450,
    cleanupGraceMs: 50,
    startDelayMs: 50,
    onOwnerProof: () => {
      setTimeout(() => {
        const blockedUntil = Date.now() + 500;
        while (Date.now() < blockedUntil) {}
      }, 100);
    },
  });
  try {
    probe = await running;
    assert.equal(probe.cleanup.verified, false);
    assert.ok(['owner-proof-lost', 'cleanup-deadline-exceeded'].includes(probe.cleanup.state));
    assert.equal(await readFile(startedPath, 'utf8'), 'started');
    await assert.rejects(readFile(finishedPath, 'utf8'));
    await waitForProcessGroupAbsent(probe.child.pid);
  } finally {
    if (!probe) await running;
    if (probe?.child?.pid) await waitForProcessGroupAbsent(probe.child.pid);
    await rm(root, { recursive: true, force: true });
  }
});

test('does not signal after the owned supervisor proof is lost', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) {
    t.skip(`owned POSIX process groups are unsupported on ${process.platform}`);
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'better-workflows-wire-proof-'));
  let pid = null;
  let proofResolve;
  const proofReady = new Promise((resolve) => { proofResolve = resolve; });
  const running = runBoundedProcessForTest(process.execPath, [
    '--input-type=module',
    '-e',
    'process.on(\'SIGTERM\', () => {}); await new Promise(() => {});',
  ], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 5_000,
    cleanupGraceMs: 100,
    onOwnerProof: (value) => {
      pid = value;
      proofResolve();
    },
  });
  try {
    await proofReady;
    assert.equal(loseOwnedSupervisorProofForTest(pid), true);
    const noSignal = await cleanupOwnedProcessGroupForTest(pid, { graceMs: 25, deadline: Date.now() + 75 });
    assert.deepEqual(noSignal, {
      verified: false,
      method: 'owned-supervisor-ipc-process-group',
      state: 'owner-proof-lost',
      requestedSignals: [],
      observedSignal: null,
      signal: null,
    });
    assert.equal(restoreOwnedSupervisorProofForTest(pid), true);
    const cleaned = await cleanupOwnedProcessGroupForTest(pid, { graceMs: 50, deadline: Date.now() + 500 });
    assert.equal(cleaned.verified, true);
    await waitForProcessGroupAbsent(pid);
    await running;
  } finally {
    if (pid && restoreOwnedSupervisorProofForTest(pid)) {
      await cleanupOwnedProcessGroupForTest(pid, { graceMs: 25, deadline: Date.now() + 100 });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('reports supervisor death as proof loss while a natural descendant exits', async (t) => {
  if (!['darwin', 'linux'].includes(process.platform)) {
    t.skip(`owned POSIX process groups are unsupported on ${process.platform}`);
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'better-workflows-wire-supervisor-death-'));
  const startedPath = path.join(root, 'started');
  const finishedPath = path.join(root, 'finished');
  const descendantSource = 'await new Promise((resolve) => setTimeout(resolve, 150));';
  const targetSource = [
    "import { spawn } from 'node:child_process';",
    "import { writeFile } from 'node:fs/promises';",
    `spawn(${JSON.stringify(process.execPath)}, ['--input-type=module', '-e', ${JSON.stringify(descendantSource)}], { detached: false, stdio: 'ignore' });`,
    `await writeFile(${JSON.stringify(startedPath)}, 'started');`,
    'await new Promise((resolve) => setTimeout(resolve, 350));',
    `await writeFile(${JSON.stringify(finishedPath)}, 'finished');`,
  ].join('\n');
  let pid = null;
  let proofResolve;
  let result = null;
  const proofReady = new Promise((resolve) => { proofResolve = resolve; });
  const running = runBoundedProcessForTest(process.execPath, ['--input-type=module', '-e', targetSource], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 1_200,
    cleanupGraceMs: 100,
    onOwnerProof: (value) => {
      pid = value;
      proofResolve();
    },
  });
  try {
    await proofReady;
    assert.equal(await waitForFile(startedPath), 'started');
    process.kill(pid, 'SIGKILL');
    result = await running;
    assert.equal(result.cleanup.verified, false);
    assert.equal(result.cleanup.state, 'owner-proof-lost');
    assert.deepEqual(result.cleanup.requestedSignals, []);
    assert.equal(result.cleanup.observedSignal, null);
    assert.equal(result.cleanup.signal, null);
    assert.equal(await readFile(finishedPath, 'utf8'), 'finished');
  } finally {
    if (!result) await running;
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects direct AGPL imports and reexports', async () => {
  const direct = await scanFixture({
    'src/index.mjs': 'import core from "better-workflows/core"; export default core;\n',
  });
  let reexport = null;
  try {
    assert.equal(direct.scan.verified, false);
    assert.ok(direct.scan.coreImports.some((entry) => entry.specifier === 'better-workflows/core'));
    assert.equal(direct.scan.indirectCoreImports.length, 0);

    reexport = await scanFixture({
      'src/index.mjs': 'export * from "plugins/better-workflows/core.mjs";\n',
    });
    assert.equal(reexport.scan.verified, false);
    assert.ok(reexport.scan.coreImports.some((entry) => entry.specifier === 'plugins/better-workflows/core.mjs'));
  } finally {
    await rm(direct.root, { recursive: true, force: true });
    await rm(reexport.root, { recursive: true, force: true });
  }
});

test('reports indirect AGPL reachability through a reexporting module', async () => {
  const value = await scanFixture({
    'src/index.mjs': 'export * from "./bridge.mjs";\n',
    'src/bridge.mjs': 'export * from "better-workflows/core";\n',
  });
  try {
    assert.equal(value.scan.verified, false);
    assert.ok(value.scan.coreImports.some((entry) => entry.importer.endsWith('/src/bridge.mjs')));
    assert.ok(value.scan.indirectCoreImports.some((entry) => entry.importer.endsWith('/src/index.mjs') && entry.via.endsWith('/src/bridge.mjs')));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('fails closed for dynamic imports and unresolved external dependencies', async () => {
  const dynamic = await scanFixture({
    'src/index.mjs': 'export async function load() { return import("./lazy.mjs"); }\n',
  });
  try {
    assert.equal(dynamic.scan.verified, false);
    assert.ok(dynamic.scan.dynamicDependencies.some((entry) => entry.kind === 'dynamic-import'));

    const external = await scanFixture({
      'src/index.mjs': 'import dependency from "unresolved-dependency"; export default dependency;\n',
    });
    assert.equal(external.scan.verified, false);
    assert.ok(external.scan.unresolvedDependencies.some((entry) => entry.kind === 'external-import' && entry.specifier === 'unresolved-dependency'));
    await rm(external.root, { recursive: true, force: true });
  } finally {
    await rm(dynamic.root, { recursive: true, force: true });
  }
});

test('fails closed for invalid targets in every export condition and fallback branch', async () => {
  const cases = [
    {
      name: 'direct-invalid-target',
      manifest: manifest('@fixture/wire', '../outside.mjs'),
    },
    {
      name: 'conditional-invalid-target',
      manifest: manifest('@fixture/wire'),
      mutate(value) {
        value.exports['.'].browser = '../outside.mjs';
      },
    },
    {
      name: 'array-invalid-target',
      manifest: manifest('@fixture/wire'),
      mutate(value) {
        value.exports['.'].import = ['./src/index.mjs', '../outside.mjs'];
      },
    },
    {
      name: 'conditional-invalid-type',
      manifest: manifest('@fixture/wire'),
      mutate(value) {
        value.exports['.'].browser = false;
      },
    },
  ];
  const fixtures = [];
  try {
    for (const item of cases) {
      const packageManifest = structuredClone(item.manifest);
      item.mutate?.(packageManifest);
      const value = await scanFixture({
        'src/index.mjs': 'export const ok = true;\n',
      }, { manifest: packageManifest });
      fixtures.push(value);
      assert.equal(value.scan.verified, false, item.name);
      assert.ok(value.scan.unresolvedDependencies.some((entry) => entry.kind === 'invalid-export-target'), item.name);
    }
  } finally {
    for (const value of fixtures) await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects package path escapes without reading outside content', async () => {
  const value = await scanFixture({
    'src/index.mjs': 'export * from "../../outside.mjs";\n',
  });
  const outsidePath = path.join(value.root, 'packages', 'outside.mjs');
  await writeFile(outsidePath, 'export const outside = true;\n');
  try {
    assert.equal(value.scan.verified, false);
    assert.ok(value.scan.pathEscapes.some((entry) => entry.specifier === '../../outside.mjs'));
    assert.equal(value.scan.packageFiles.some((entry) => entry.path.endsWith('/outside.mjs')), false);
    assert.equal(await readFile(outsidePath, 'utf8'), 'export const outside = true;\n');

    const packEscape = await scanPackage({
      packageDir: value.packageDir,
      repoRoot: value.root,
      packageRoot: 'packages/wire',
      packFiles: [...value.packFiles, { path: '../outside.mjs', size: 1, mode: 0o644 }],
      buildReceiptPath: 'evidence/wire-build.json',
      closureReceiptPath: 'evidence/wire-closure.json',
    });
    assert.equal(packEscape.verified, false);
    assert.ok(packEscape.pathEscapes.some((entry) => entry.code === 'PACK_PATH_UNSAFE'));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
