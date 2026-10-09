// SPDX-License-Identifier: AGPL-3.0-only
// Observed bytes are not installed-source, privileged execution or model attestations.
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdtemp, open, opendir, readlink, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { digestObject, execBoundProcess, nowIso, pluginRoot } from './core.mjs';
import { loadHostSupportRegistry } from './hosts.mjs';

const LIMITS = Object.freeze({ executableBytes: 256 * 1024 * 1024, fileBytes: 8 * 1024 * 1024,
  bundleBytes: 64 * 1024 * 1024, files: 4096, directories: 4096, entries: 8192, depth: 64, timeoutMs: 10_000, outputBytes: 65536 });
const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MANIFEST = '.claude-plugin/plugin.json';
const HELPER = 'scripts/sbw.mjs';
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}
function fail(code) { const error = new Error(code); error.bindingCode = code; throw error; }
function identity(info) {
  return ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].map(key => String(info[key])).join(':');
}
function safeMode(info, unsafe) {
  if ((Number(info.mode) & 0o7022) !== 0 ||
      (info.uid !== 0n && info.uid !== BigInt(process.getuid()))) fail(unsafe);
}
function directoryIdentity(info) {
  return ['dev','ino','mode','uid','gid'].map(key => String(info[key])).join(':');
}
async function parentChain(directory, unsafe) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) fail(unsafe);
  const parts = directory === '/' ? [] : directory.slice(1).split('/');
  if (parts.length > 64) fail(unsafe);
  const names = ['/'];
  for (const part of parts) names.push(path.join(names.at(-1), part));
  const records = [];
  for (let index = 0; index < names.length; index++) {
    const name = names[index], info = await lstat(name, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) fail(unsafe);
    if (name === '/private/tmp') {
      // Only this root-owned shared ancestor may be writable. Its next
      // component must be a private current-user directory, never the CLI.
      if (info.uid !== 0n || (Number(info.mode) & 0o7777) !== 0o1777 || index + 1 === names.length) fail(unsafe);
      const next = await lstat(names[index + 1], { bigint: true });
      if (!next.isDirectory() || next.isSymbolicLink() || next.uid !== BigInt(process.getuid()) ||
          (Number(next.mode) & 0o7777) !== 0o700) fail(unsafe);
    } else safeMode(info, unsafe);
    records.push({ path: name, identity: directoryIdentity(info) });
  }
  return records;
}
function directLinkTarget(candidate, text) {
  if (!text || Buffer.byteLength(text) > 4096) fail('host-binding-executable-unsafe');
  if (path.isAbsolute(text)) {
    if (path.normalize(text) !== text) fail('host-binding-executable-unsafe');
  } else {
    // Leading .. components refer only to the already checked candidate
    // ancestry. Do not normalize away a named, potentially symlinked parent.
    let named = false;
    const parts = text.split('/');
    if (parts.length > 64) fail('host-binding-executable-unsafe');
    for (const part of parts) {
      if (!part || part === '.' || (part === '..' && named)) fail('host-binding-executable-unsafe');
      if (part !== '..') named = true;
    }
  }
  return path.resolve(path.dirname(candidate), text);
}
async function captureCandidate(candidate) {
  const unsafe = 'host-binding-executable-unsafe';
  const candidateParents = await parentChain(path.dirname(candidate), unsafe);
  const leaf = await lstat(candidate, { bigint: true });
  let direct = candidate, text = null;
  if (leaf.isSymbolicLink()) {
    if (leaf.nlink !== 1n || leaf.size > 4096n || (Number(leaf.mode) & 0o7000) !== 0 ||
        (leaf.uid !== 0n && leaf.uid !== BigInt(process.getuid()))) fail(unsafe);
    text = await readlink(candidate);
    direct = directLinkTarget(candidate, text);
  } else {
    if (!leaf.isFile()) fail(unsafe);
    safeMode(leaf, unsafe);
  }
  // Check the direct target's parents and regular leaf before realpath;
  // canonicalization must not conceal an intermediate or second leaf link.
  const targetParents = await parentChain(path.dirname(direct), unsafe);
  const file = await regularBytes(direct, LIMITS.executableBytes, unsafe);
  const resolvedPath = await realpath(candidate);
  if (resolvedPath !== direct || identity(await lstat(candidate, { bigint: true })) !== identity(leaf)) fail('host-binding-source-drift');
  return { candidate, resolvedPath, ...file,
    leafBinding: { identity: identity(leaf), text }, candidateParents, targetParents };
}
async function revalidateCandidate(cli) {
  let current;
  try { current = await captureCandidate(cli.candidate); }
  catch (error) {
    if (error.bindingCode === 'host-binding-executable-unsafe') throw error;
    fail('host-binding-source-drift');
  }
  for (const key of ['resolvedPath','digest','identity','leafBinding','candidateParents','targetParents']) {
    if (JSON.stringify(current[key]) !== JSON.stringify(cli[key])) fail('host-binding-source-drift');
  }
}
async function revalidateBundle(root, before, parents) {
  let current;
  try {
    const currentParents = await parentChain(root, 'host-binding-bundle-unsafe');
    if (JSON.stringify(currentParents) !== JSON.stringify(parents)) fail('host-binding-source-drift');
    current = await inventory(root);
  } catch (error) {
    if (error.bindingCode === 'host-binding-bundle-unsafe') throw error;
    fail('host-binding-source-drift');
  }
  if (current.digest !== before.digest || JSON.stringify(current.directories) !== JSON.stringify(before.directories)) fail('host-binding-source-drift');
}
async function regularBytes(file, maxBytes, unsafe = 'host-binding-bundle-unsafe') {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) fail(unsafe);
  safeMode(before, unsafe);
  if (before.size > BigInt(maxBytes)) fail('host-binding-bundle-limit-exceeded');
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    if (identity(await handle.stat({ bigint: true })) !== identity(before)) fail('host-binding-source-drift');
    const hash = createHash('sha256'), chunks = [];
    let size = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) fail('host-binding-bundle-limit-exceeded');
      hash.update(buffer.subarray(0, bytesRead));
      if (maxBytes <= LIMITS.fileBytes) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (BigInt(size) !== before.size || identity(await handle.stat({ bigint: true })) !== identity(before) ||
        identity(await lstat(file, { bigint: true })) !== identity(before)) fail('host-binding-source-drift');
    return { digest: hash.digest('hex'), size, identity: identity(before), bytes: Buffer.concat(chunks) };
  } finally { await handle.close(); }
}
async function inventory(root) {
  const files = [], directories = [];
  let totalBytes = 0, directoryCount = 0, entryCount = 0;
  async function namesAt(target, accountEntries = false) {
    const names = [], directory = await opendir(target, { bufferSize: 32 });
    for await (const entry of directory) {
      if (names.length + 1 > LIMITS.entries || (accountEntries && ++entryCount > LIMITS.entries)) fail('host-binding-bundle-limit-exceeded');
      names.push(entry.name);
    }
    return names.sort();
  }
  async function walk(relative = '', depth = 0) {
    if (depth > LIMITS.depth) fail('host-binding-bundle-limit-exceeded');
    const target = path.join(root, relative), info = await lstat(target, { bigint: true });
    if (info.isSymbolicLink()) fail('host-binding-bundle-unsafe');
    if (info.isFile()) {
      const file = await regularBytes(target, LIMITS.fileBytes);
      totalBytes += file.size;
      if (files.length + 1 > LIMITS.files || totalBytes > LIMITS.bundleBytes) fail('host-binding-bundle-limit-exceeded');
      files.push({ path: relative.split(path.sep).join('/'), size: file.size, digest: file.digest });
      return;
    }
    if (!info.isDirectory()) fail('host-binding-bundle-unsafe');
    safeMode(info, 'host-binding-bundle-unsafe');
    if (++directoryCount > LIMITS.directories) fail('host-binding-bundle-limit-exceeded');
    const names = await namesAt(target, true);
    for (const name of names) await walk(path.join(relative, name), depth + 1);
    if (identity(await lstat(target, { bigint: true })) !== identity(info) ||
        JSON.stringify(await namesAt(target)) !== JSON.stringify(names)) fail('host-binding-source-drift');
    directories.push({ path: relative, identity: identity(info), names });
  }
  await walk();
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, directories, digest: digestObject(files), fileCount: files.length, totalBytes };
}
async function executable(env) {
  for (const directory of String(env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const selectedDirectory = directory === '/' ? '/' : directory.replace(/\/+$/, '');
    const candidate = `${selectedDirectory}${selectedDirectory === '/' ? '' : '/'}claude`;
    try { await access(candidate, fsConstants.X_OK); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') continue; throw error; }
    return captureCandidate(candidate);
  }
  fail('host-binding-executable-unavailable');
}
function emptyObservation(osId) {
  return { schemaVersion: 1, kind: 'ClaudeHostBindingObservationV1', checkedAt: nowIso(),
    host: { id: 'claude-code', osId, executablePath: null, executableDigest: null, reportedVersion: null,
      versionAssurance: 'observed-unpinned', executionAssurance: 'file-observed-not-attested',
      modelIdentity: 'not-observed' },
    source: { bindingMode: 'executing-plugin-bundle', installedSourceState: 'not-observed',
      manifestDigest: null, helperDigest: null, bundleDigest: null, bundleFileCount: 0, bundleBytes: 0 },
    registryDigest: null, execution: { attempted: false, command: ['--version'], groupTerminated: null },
    result: 'HOLD', blockers: [], authority: 'observation-only', releaseEligible: false, provenanceVerified: false };
}
export async function observeClaudeHostBindingV1(options = {}) {
  for (const key of Object.keys(options)) if (!['osId', 'env'].includes(key)) throw new Error('Claude binding options contain unsupported fields');
  const { osId = 'macos', env = process.env } = options;
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('Claude binding environment must be an object');
  const result = emptyObservation(osId);
  let home;
  try {
    if (osId !== 'macos' || process.platform !== 'darwin') fail('host-binding-platform-unavailable');
    const sourceRoot = pluginRoot();
    const bundleParents = await parentChain(sourceRoot, 'host-binding-bundle-unsafe');
    const root = await realpath(sourceRoot);
    if (root !== sourceRoot) fail('host-binding-bundle-unsafe');
    const before = await inventory(root);
    result.source.bundleDigest = before.digest;
    result.source.bundleFileCount = before.fileCount;
    result.source.bundleBytes = before.totalBytes;
    const records = new Map(before.files.map(file => [file.path, file]));
    result.source.helperDigest = records.get(HELPER)?.digest ?? null;
    if (!result.source.helperDigest) fail('host-binding-bundle-unsafe');
    let registry;
    try { registry = await regularBytes(path.join(root, 'config/host-support-v1.json'), LIMITS.fileBytes); await loadHostSupportRegistry(); }
    catch { fail('host-binding-registry-drift'); }
    result.registryDigest = registry.digest;
    result.source.manifestDigest = records.get(MANIFEST)?.digest ?? null;
    if (result.source.manifestDigest === null) result.blockers.push('host-binding-manifest-unavailable');
    else {
      let manifest, pkg;
      try {
        manifest = JSON.parse((await regularBytes(path.join(root, MANIFEST), LIMITS.fileBytes)).bytes.toString('utf8'));
        pkg = JSON.parse((await regularBytes(path.join(root, 'package.json'), LIMITS.fileBytes)).bytes.toString('utf8'));
      } catch { fail('host-binding-manifest-invalid'); }
      if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) ||
          pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) fail('host-binding-manifest-invalid');
      if (manifest.name !== 'better-workflows' || !VERSION.test(manifest.version ?? '') || manifest.version !== pkg.version) fail('host-binding-manifest-invalid');
    }
    const cli = await executable(env);
    result.host.executablePath = cli.resolvedPath;
    result.host.executableDigest = cli.digest;
    home = await mkdtemp(path.join(os.tmpdir(), 'bw-claude-binding-'));
    await revalidateBundle(root, before, bundleParents);
    await revalidateCandidate(cli);
    // This is a pre-run observation, not an atomic exec or ACL attestation.
    result.execution.attempted = true;
    let probe;
    try {
      probe = await execBoundProcess(cli.resolvedPath, ['--version'], { cwd: root,
        env: { PATH: [path.dirname(cli.resolvedPath), path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
          HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, timeoutMs: LIMITS.timeoutMs, maxBuffer: LIMITS.outputBytes,
        label: 'Claude host binding version probe' });
    } catch { fail('host-binding-version-probe-failed'); }
    if (probe.code !== 0 || probe.signal !== null || probe.groupTerminated !== true) fail('host-binding-version-probe-failed');
    result.execution.groupTerminated = true;
    const match = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?) \(Claude Code\)\r?\n?$/.exec(probe.stdout);
    if (!match) fail('host-binding-version-format-invalid');
    result.host.reportedVersion = match[1];
    await revalidateCandidate(cli);
    await revalidateBundle(root, before, bundleParents);
    result.result = result.blockers.length ? 'HOLD' : 'PASS';
  } catch (error) {
    result.result = 'HOLD';
    result.blockers.push(error.bindingCode ?? (error.code === 'ENOENT' ? 'host-binding-executable-unavailable' : 'host-binding-bundle-unsafe'));
  } finally {
    if (home) {
      try { await rm(home, { recursive: true, force: true }); }
      catch { result.result = 'HOLD'; result.blockers.push('host-binding-version-probe-failed'); }
    }
  }
  result.blockers = [...new Set(result.blockers)].sort();
  result.observationDigest = digestObject(result);
  validateClaudeHostBindingV1(result);
  return result;
}
export function validateClaudeHostBindingV1(observation, expected = {}) {
  exact(observation, ['schemaVersion','kind','checkedAt','host','source','registryDigest','execution','result','blockers','authority','releaseEligible','provenanceVerified','observationDigest'], 'Claude binding observation');
  exact(observation.host, ['id','osId','executablePath','executableDigest','reportedVersion','versionAssurance','executionAssurance','modelIdentity'], 'Claude binding host');
  exact(observation.source, ['bindingMode','installedSourceState','manifestDigest','helperDigest','bundleDigest','bundleFileCount','bundleBytes'], 'Claude binding source');
  exact(observation.execution, ['attempted','command','groupTerminated'], 'Claude binding execution');
  for (const key of Object.keys(expected)) if (!['observationDigest','bundleDigest','executableDigest','reportedVersion'].includes(key)) throw new Error('Claude binding expected fields invalid');
  if (observation.schemaVersion !== 1 || observation.kind !== 'ClaudeHostBindingObservationV1' ||
      observation.host.id !== 'claude-code' || typeof observation.host.osId !== 'string' ||
      observation.authority !== 'observation-only' || observation.releaseEligible !== false || observation.provenanceVerified !== false ||
      observation.host.versionAssurance !== 'observed-unpinned' || observation.host.executionAssurance !== 'file-observed-not-attested' ||
      observation.host.modelIdentity !== 'not-observed' || observation.source.bindingMode !== 'executing-plugin-bundle' ||
      observation.source.installedSourceState !== 'not-observed') throw new Error('Claude binding identity or authority invalid');
  if (!Number.isFinite(Date.parse(observation.checkedAt)) || !['PASS','HOLD'].includes(observation.result) ||
      !Array.isArray(observation.blockers) || new Set(observation.blockers).size !== observation.blockers.length ||
      observation.blockers.some(code => typeof code !== 'string' || !/^host-binding-[a-z-]+$/.test(code))) throw new Error('Claude binding outcome invalid');
  for (const value of [observation.registryDigest, observation.host.executableDigest,
    observation.source.manifestDigest, observation.source.helperDigest, observation.source.bundleDigest]) {
    if (value !== null && !SHA.test(value)) throw new Error('Claude binding byte digest invalid');
  }
  for (const value of [observation.source.bundleFileCount, observation.source.bundleBytes]) if (!Number.isSafeInteger(value) || value < 0) throw new Error('Claude binding inventory count invalid');
  if (observation.source.bundleFileCount > LIMITS.files || observation.source.bundleBytes > LIMITS.bundleBytes) throw new Error('Claude binding inventory bounds invalid');
  if (typeof observation.execution.attempted !== 'boolean' || JSON.stringify(observation.execution.command) !== JSON.stringify(['--version']) ||
      ![null,true].includes(observation.execution.groupTerminated)) throw new Error('Claude binding execution invalid');
  if (observation.host.reportedVersion !== null && !VERSION.test(observation.host.reportedVersion)) throw new Error('Claude binding reported version invalid');
  if (observation.host.executablePath !== null && (typeof observation.host.executablePath !== 'string' || !path.isAbsolute(observation.host.executablePath))) throw new Error('Claude binding executable path invalid');
  if (observation.result === 'PASS' && (observation.host.osId !== 'macos' || observation.blockers.length ||
      observation.execution.attempted !== true || observation.execution.groupTerminated !== true ||
      !observation.host.reportedVersion || !observation.host.executablePath ||
      [observation.registryDigest, observation.host.executableDigest, observation.source.manifestDigest, observation.source.helperDigest, observation.source.bundleDigest].some(value => !value) ||
      observation.source.bundleFileCount < 1 || observation.source.bundleBytes < 1)) throw new Error('Claude binding PASS lacks required observations');
  if (observation.result === 'HOLD' && observation.blockers.length === 0) throw new Error('Claude binding HOLD lacks blockers');
  const { observationDigest, ...body } = observation;
  if (!SHA.test(observationDigest) || digestObject(body) !== observationDigest) throw new Error('Claude binding observation digest mismatch');
  const actual = { observationDigest, bundleDigest: observation.source.bundleDigest, executableDigest: observation.host.executableDigest, reportedVersion: observation.host.reportedVersion };
  for (const [key,value] of Object.entries(expected)) if (value !== actual[key]) throw new Error(`Claude binding expected ${key} mismatch`);
  return { valid: true, authority: 'observation-only', releaseEligible: false, provenanceVerified: false };
}
