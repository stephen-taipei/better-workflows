import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_REPO_ROOT = path.resolve(PACKAGE_DIR, '../..');
const DEFAULT_PACKAGE_ROOT = 'packages/better-workflows-wire';
const DEFAULT_BUILD_RECEIPT_PATH = 'evidence/better-workflows-wire-build.json';
const DEFAULT_CLOSURE_RECEIPT_PATH = 'evidence/better-workflows-wire-closure.json';
const NPM_DISTRIBUTION_UNIVERSE = 'npm-distribution';
const GIT_SOURCE_TREE_UNIVERSE = 'git-source-tree';
const SOURCE_GIT_EXECUTABLE = '/usr/bin/git';
const SOURCE_GIT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const TRUSTED_DEVELOPER_DIRECTORY = '/Library/Developer/CommandLineTools';
const SOURCE_GIT_TIMEOUT_MS = 30_000;
const SOURCE_GIT_MAX_BUFFER = 16 * 1024 * 1024;
const SOURCE_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const SOURCE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const PACK_TIMEOUT_MS = 30_000;
const PROCESS_CLEANUP_GRACE_MS = 1_000;
const PROCESS_CLEANUP_POLL_MS = 25;
const PROCESS_MIN_CLEANUP_GRACE_MS = PROCESS_CLEANUP_POLL_MS;
const PROCESS_MIN_START_BUDGET_MS = 25;
const PROCESS_MAX_TIMER_MS = 2_147_483_647;
const PROCESS_CLEANUP_METHOD = 'owned-supervisor-ipc-process-group';
const SUPPORTED_PROCESS_PLATFORMS = new Set(['darwin', 'linux']);
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\u0000).+$/;
const RUNTIME_EXTENSIONS = new Set(['.cjs', '.js', '.mjs']);
const STATIC_MODULE_PHASES = new Set(['evaluation', 'source']);

// The supervisor is the persistent group leader. The parent never sends a
// signal to a bare, possibly stale PGID; it sends a nonce-bound request to
// this process, which can signal its own group while its ownership proof is
// still live. This is an ownership protocol, not an OS-level atomic PID
// guarantee.
const SUPERVISOR_SOURCE = String.raw`
import { spawn } from 'node:child_process';

const ownerNonce = process.env.BW_WIRE_OWNER_NONCE;
const startupDeadlineValue = Number(process.env.BW_WIRE_OPERATION_DEADLINE);
const startupCleanupGraceValue = Number(process.env.BW_WIRE_CLEANUP_GRACE_MS);
const startupCleanupGrace = Number.isSafeInteger(startupCleanupGraceValue) && startupCleanupGraceValue >= 0
  ? startupCleanupGraceValue
  : 0;
let target = null;
let startPending = false;
let cleanupStarted = false;
let cleanupTimer = null;
let autonomousCleanupTimer = null;
let cleanupRequestedSignals = [];
const operationDeadline = Number.isSafeInteger(startupDeadlineValue) ? startupDeadlineValue : null;

function send(message) {
  if (!process.send) return;
  try { process.send({ ...message, nonce: ownerNonce }); } catch {}
}

function validMessage(message) {
  return Boolean(message && typeof message === 'object' && message.nonce === ownerNonce);
}

function signalOwnedGroup(graceMs, deadline) {
  if (cleanupStarted) return null;
  const deadlineAt = Number.isSafeInteger(deadline) && deadline >= 0 ? deadline : operationDeadline;
  const remaining = Number.isSafeInteger(deadlineAt) ? deadlineAt - Date.now() : 0;
  if (remaining <= 0) {
    send({ type: 'cleanup-refused', reason: 'deadline' });
    return;
  }
  cleanupStarted = true;
  if (autonomousCleanupTimer) {
    clearTimeout(autonomousCleanupTimer);
    autonomousCleanupTimer = null;
  }
  try { process.kill(-process.pid, 'SIGTERM'); } catch {}
  const boundedGrace = Math.min(Math.max(0, graceMs), Math.max(0, remaining));
  cleanupRequestedSignals = ['SIGTERM', ...(boundedGrace > 0 ? ['SIGKILL'] : [])];
  cleanupTimer = setTimeout(() => {
    if (Number.isSafeInteger(deadlineAt) && Date.now() >= deadlineAt) return;
    send({ type: 'cleanup-kill-requested', requestedSignal: 'SIGKILL' });
    try { process.kill(-process.pid, 'SIGKILL'); } catch {}
  }, boundedGrace);
  return boundedGrace;
}

// The supervisor must remain alive after the target exits so the group owner
// cannot silently disappear before a cleanup request is handled.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.on('disconnect', () => signalOwnedGroup(0, operationDeadline));

process.on('message', (message) => {
  if (!validMessage(message)) return;
  if (message.type === 'start') {
    if (target || startPending || cleanupStarted) return;
    if (typeof message.command !== 'string'
      || !Array.isArray(message.args)
      || message.args.some((item) => typeof item !== 'string')
      || typeof message.cwd !== 'string'
      || !message.env
      || typeof message.env !== 'object'
      || Array.isArray(message.env)
      || (message.stdin !== undefined && typeof message.stdin !== 'string')) {
      send({ type: 'target-error', message: 'invalid supervisor start request' });
      return;
    }
    const requestedDeadline = Number.isSafeInteger(message.deadline) ? message.deadline : null;
    if (requestedDeadline === null
      || operationDeadline === null
      || requestedDeadline !== operationDeadline
      || Date.now() >= operationDeadline) {
      send({ type: 'start-refused', reason: 'deadline' });
      return;
    }
    startPending = true;
    const start = () => {
      startPending = false;
      if (cleanupStarted || Date.now() >= operationDeadline) {
        send({ type: 'start-refused', reason: 'deadline' });
        return;
      }
      try {
        target = spawn(message.command, message.args, {
          cwd: message.cwd,
          env: message.env,
          detached: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        target.stdin?.on('error', () => {});
        target.stdin?.end(message.stdin);
        target.stdout?.on('data', (chunk) => {
          try { process.stdout.write(chunk); } catch {}
        });
        target.stderr?.on('data', (chunk) => {
          try { process.stderr.write(chunk); } catch {}
        });
        target.once('error', (error) => {
          send({ type: 'target-error', message: error instanceof Error ? error.message : 'target process failed' });
        });
        target.once('close', (status, signal) => {
          send({ type: 'target-close', status, signal });
        });
      } catch (error) {
        send({ type: 'target-error', message: error instanceof Error ? error.message : 'target process spawn failed' });
      }
    };
    const delayMs = Number.isSafeInteger(message.startDelayMs)
      && message.startDelayMs > 0
      && message.startDelayMs <= 2_147_483_647
      ? message.startDelayMs
      : 0;
    if (delayMs > 0) setTimeout(start, delayMs);
    else start();
    return;
  }
  if (message.type === 'cleanup') {
    const graceMs = Number.isSafeInteger(message.graceMs) && message.graceMs >= 0 ? message.graceMs : 0;
    const boundedGrace = signalOwnedGroup(graceMs, message.deadline);
    send({
      type: cleanupStarted ? 'cleanup-started' : 'cleanup-refused',
      reason: cleanupStarted ? null : 'deadline',
      requestedSignals: cleanupStarted ? cleanupRequestedSignals : [],
      requestedSignal: cleanupStarted ? 'SIGTERM' : null,
    });
  }
});

function scheduleAutonomousCleanup() {
  if (operationDeadline === null) return;
  const cleanupLeadMs = startupCleanupGrace * 2;
  const cleanupDelay = Math.max(0, operationDeadline - Date.now() - cleanupLeadMs);
  autonomousCleanupTimer = setTimeout(() => {
    if (Date.now() < operationDeadline) signalOwnedGroup(startupCleanupGrace, operationDeadline);
  }, cleanupDelay);
  setTimeout(() => {
    if (cleanupTimer) clearTimeout(cleanupTimer);
    if (autonomousCleanupTimer) clearTimeout(autonomousCleanupTimer);
    process.exit(0);
  }, Math.max(0, operationDeadline - Date.now()));
}

if (operationDeadline !== null && Date.now() < operationDeadline) {
  scheduleAutonomousCleanup();
  send({ type: 'ready', nonce: ownerNonce });
} else {
  process.exit(0);
}
`;

export const CLOSURE_SCAN_KIND = 'better-workflows-apache-closure-scan';
export const BUILD_RECEIPT_KIND = 'better-workflows-apache-independent-build';
export const CLOSURE_RECEIPT_KIND = 'better-workflows-apache-closure';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha1GitBlob(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function isolatedSourceGitEnvironment() {
  const environment = {
    PATH: SOURCE_GIT_PATH,
    HOME: '/var/empty',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: '/dev/null',
  };
  if (process.platform === 'darwin') {
    const components = ['/', '/Library', '/Library/Developer', TRUSTED_DEVELOPER_DIRECTORY];
    try {
      const trusted = components.every((component) => {
        const info = lstatSync(component);
        return info.isDirectory()
          && !info.isSymbolicLink()
          && info.uid === 0
          && (info.mode & 0o022) === 0
          && realpathSync(component) === component;
      });
      if (trusted) environment.DEVELOPER_DIR = TRUSTED_DEVELOPER_DIRECTORY;
    } catch {
      // Let the bounded Git probe fail closed if the developer directory is
      // absent, redirected, or not root-owned.
    }
  }
  return environment;
}

function isSafePath(value) {
  return typeof value === 'string' && SAFE_PATH.test(value);
}

function slashPath(value) {
  return value.split(path.sep).join('/');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function relativePath(root, candidate) {
  if (!isInside(root, candidate)) return null;
  const relative = slashPath(path.relative(root, candidate));
  return relative || null;
}

function issue(code, details = {}) {
  return { code, ...details };
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortRecords(items) {
  return items.slice().sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function exactSourceRevision(value) {
  const revision = String(value ?? '').trim().toLowerCase();
  if (!SHA1.test(revision)) throw new Error('Git source mode requires an exact lowercase commit SHA');
  return revision;
}

function sourceGitFailure(result, label) {
  const stderr = typeof result?.child?.stderr === 'string'
    ? result.child.stderr.trim()
    : Buffer.isBuffer(result?.child?.stderr)
      ? result.child.stderr.toString('utf8').trim()
      : '';
  const detail = result?.error || stderr || `status ${String(result?.child?.status ?? 'unknown')}`;
  return new Error(`${label} failed: ${detail}`);
}

async function runSourceGitCommand(repoRoot, args, {
  stdin = undefined,
  outputEncoding = 'utf8',
  timeoutMs = SOURCE_GIT_TIMEOUT_MS,
} = {}) {
  const result = await runBoundedProcess(SOURCE_GIT_EXECUTABLE, [
    '--no-replace-objects',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'credential.helper=',
    ...args,
  ], {
    cwd: repoRoot,
    env: isolatedSourceGitEnvironment(),
    stdin,
    outputEncoding,
    timeoutMs,
    maxBuffer: SOURCE_GIT_MAX_BUFFER,
    cleanupGraceMs: PROCESS_CLEANUP_GRACE_MS,
  });
  if (result.error || result.cleanup?.verified !== true || result.child?.status !== 0) {
    throw sourceGitFailure(result, `source Git ${args[0] ?? 'command'}`);
  }
  return result.child.stdout;
}

function parseGitSourceTree(output, packageRoot) {
  if (!Buffer.isBuffer(output)) throw new Error('Git source tree output must be bytes');
  const records = [];
  const seen = new Set();
  let totalBytes = 0;
  const prefix = `${packageRoot}/`;
  const pathDecoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0x00, offset);
    const chunk = end < 0 ? output.subarray(offset) : output.subarray(offset, end);
    offset = end < 0 ? output.length : end + 1;
    if (chunk.length === 0) continue;
    const separator = chunk.indexOf(0x09);
    if (separator < 0) throw new Error('Git source tree entry is malformed');
    const metadata = chunk.subarray(0, separator).toString('ascii').trim().split(/\s+/);
    let filePath;
    try {
      filePath = pathDecoder.decode(chunk.subarray(separator + 1));
    } catch (error) {
      throw new Error(`Git source tree path is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
    }
    const [mode, type, objectId, sizeText] = metadata;
    if (!/^100(?:644|755)$/.test(mode ?? '') || type !== 'blob') {
      throw new Error(`Git source tree contains a non-regular entry: ${filePath}`);
    }
    if (!SHA1.test(objectId ?? '') || !/^\d+$/.test(sizeText ?? '')) {
      throw new Error(`Git source tree entry metadata is malformed: ${filePath}`);
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > SOURCE_MAX_ENTRY_BYTES) {
      throw new Error(`Git source tree entry is too large: ${filePath}`);
    }
    if (!(filePath.startsWith(prefix) && isSafePath(filePath)) || seen.has(filePath)) {
      throw new Error(`Git source tree path is unsafe or duplicated: ${filePath}`);
    }
    totalBytes += size;
    if (totalBytes > SOURCE_MAX_TOTAL_BYTES) throw new Error('Git source tree exceeds the bounded byte budget');
    const packagePath = filePath.slice(prefix.length);
    if (!packagePath || !isSafePath(packagePath)) throw new Error(`Git source tree package path is unsafe: ${filePath}`);
    seen.add(filePath);
    records.push({
      packagePath,
      path: filePath,
      mode: Number.parseInt(mode.slice(-3), 8),
      modeText: mode,
      objectId,
      size,
    });
  }
  if (records.length === 0) throw new Error('Git source tree is empty');
  records.sort((left, right) => left.packagePath.localeCompare(right.packagePath));
  return { records, totalBytes };
}

async function readGitSourceBlobs(repoRoot, entries) {
  const request = `${entries.map((entry) => entry.objectId).join('\n')}\n`;
  const output = await runSourceGitCommand(repoRoot, ['cat-file', '--batch'], {
    stdin: request,
    outputEncoding: 'buffer',
  });
  const records = [];
  let offset = 0;
  for (const entry of entries) {
    const lineEnd = output.indexOf(0x0a, offset);
    if (lineEnd < 0) throw new Error(`Git source blob response is truncated: ${entry.path}`);
    const [objectId, type, sizeText] = output.subarray(offset, lineEnd).toString('ascii').trim().split(/\s+/);
    const size = Number(sizeText);
    const start = lineEnd + 1;
    const end = start + size;
    if (objectId !== entry.objectId || type !== 'blob' || !Number.isSafeInteger(size) || size !== entry.size || end >= output.length || output[end] !== 0x0a) {
      throw new Error(`Git source blob response does not match the exact tree: ${entry.path}`);
    }
    const bytes = Buffer.from(output.subarray(start, end));
    if (sha1GitBlob(bytes) !== entry.objectId) throw new Error(`Git source blob bytes do not match the exact tree: ${entry.path}`);
    records.push(Object.freeze({
      packagePath: entry.packagePath,
      path: entry.path,
      mode: entry.mode,
      modeText: entry.modeText,
      gitBlobSha1: entry.objectId,
      sha256: sha256(bytes),
      bytes,
    }));
    offset = end + 1;
  }
  return records;
}

function sourceFilesDigest(records) {
  return sha256(Buffer.from(JSON.stringify(records.map((record) => ({
    path: record.path,
    sha256: record.sha256,
    mode: record.mode,
    gitBlobSha1: record.gitBlobSha1,
  }))), 'utf8'));
}

function sourceTreeDigest(records) {
  return sha256(Buffer.from(JSON.stringify(records.map((record) => ({
    path: record.path,
    mode: record.mode,
    objectId: record.gitBlobSha1 ?? record.objectId,
    size: record.bytes?.length ?? record.size,
  }))), 'utf8'));
}

async function readGitSourceUniverse({ repoRoot, packageRoot, sourceRevision, result }) {
  const revision = exactSourceRevision(sourceRevision);
  const resolved = String(await runSourceGitCommand(repoRoot, ['rev-parse', '--verify', `${revision}^{commit}`])).trim().toLowerCase();
  if (resolved !== revision) throw new Error(`source Git revision drifted: expected ${revision}, got ${resolved}`);
  const treeOutput = await runSourceGitCommand(repoRoot, [
    '--literal-pathspecs', 'ls-tree', '-r', '-z', '-l', '--full-tree', revision, '--', packageRoot,
  ], { outputEncoding: 'buffer' });
  const tree = parseGitSourceTree(treeOutput, packageRoot);
  const records = await readGitSourceBlobs(repoRoot, tree.records);
  const sourceFiles = records.map((record) => ({
    path: record.path,
    sha256: record.sha256,
    mode: record.mode,
    gitBlobSha1: record.gitBlobSha1,
  }));
  const sourceTreeRecords = records.map((record) => ({
    path: record.path,
    mode: record.mode,
    objectId: record.gitBlobSha1,
    size: record.bytes.length,
  }));
  const filesSha256 = sourceFilesDigest(records);
  const treeSha256 = sourceTreeDigest(sourceTreeRecords);
  if (result.expectedSourceFilesSha256 !== null && result.expectedSourceFilesSha256 !== filesSha256) {
    throw new Error(`source files digest drifted: expected ${result.expectedSourceFilesSha256}, got ${filesSha256}`);
  }
  if (result.expectedSourceTreeSha256 !== null && result.expectedSourceTreeSha256 !== treeSha256) {
    throw new Error(`source tree digest drifted: expected ${result.expectedSourceTreeSha256}, got ${treeSha256}`);
  }
  result.sourceRevision = revision;
  result.sourceFiles = sourceFiles;
  result.sourceTreeRecords = sourceTreeRecords;
  result.sourceFilesSha256 = filesSha256;
  result.sourceTreeSha256 = treeSha256;
  return {
    records,
    byPackagePath: new Map(records.map((record) => [record.packagePath, record])),
  };
}

function identifierStart(code) {
  return code === 0x24 || code === 0x5f || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a) || code >= 0x80;
}

function identifierPart(code) {
  return identifierStart(code) || (code >= 0x30 && code <= 0x39);
}

function canStartRegex(previous) {
  if (!previous) return true;
  if (previous.kind === 'identifier') {
    return new Set(['case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'while', 'with', 'yield']).has(previous.value);
  }
  return ['!', '%', '&', '(', '*', '+', ',', '-', '.', '/', ':', ';', '<', '=', '?', '[', '^', '{', '|', '>', '~'].includes(previous.value);
}

function tokenize(source) {
  const tokens = [];
  const diagnostics = [];

  function skipString(index, quote) {
    let cursor = index + 1;
    while (cursor < source.length) {
      const code = source.charCodeAt(cursor);
      if (code === 0x5c) {
        cursor += 2;
        continue;
      }
      if (code === quote) return cursor + 1;
      if (code === 0x0a || code === 0x0d) {
        diagnostics.push({ code: 'LEX_UNTERMINATED_STRING', offset: index });
        return cursor;
      }
      cursor += 1;
    }
    diagnostics.push({ code: 'LEX_UNTERMINATED_STRING', offset: index });
    return cursor;
  }

  function skipRegex(index) {
    let cursor = index + 1;
    let inClass = false;
    while (cursor < source.length) {
      const code = source.charCodeAt(cursor);
      if (code === 0x5c) {
        cursor += 2;
        continue;
      }
      if (code === 0x5b) inClass = true;
      if (code === 0x5d) inClass = false;
      if (code === 0x2f && !inClass) {
        cursor += 1;
        while (identifierPart(source.charCodeAt(cursor))) cursor += 1;
        return cursor;
      }
      if (code === 0x0a || code === 0x0d) {
        diagnostics.push({ code: 'LEX_UNTERMINATED_REGEX', offset: index });
        return cursor;
      }
      cursor += 1;
    }
    diagnostics.push({ code: 'LEX_UNTERMINATED_REGEX', offset: index });
    return cursor;
  }

  function scanTemplate(index) {
    let cursor = index + 1;
    while (cursor < source.length) {
      const code = source.charCodeAt(cursor);
      if (code === 0x5c) {
        cursor += 2;
        continue;
      }
      if (code === 0x60) return cursor + 1;
      if (code === 0x24 && source.charCodeAt(cursor + 1) === 0x7b) {
        cursor = scan(cursor + 2, true);
        continue;
      }
      cursor += 1;
    }
    diagnostics.push({ code: 'LEX_UNTERMINATED_TEMPLATE', offset: index });
    return cursor;
  }

  function scan(index, stopAtBrace = false) {
    let cursor = index;
    let braceDepth = 0;
    let previous = null;
    while (cursor < source.length) {
      const code = source.charCodeAt(cursor);
      if (stopAtBrace && code === 0x7d && braceDepth === 0) return cursor + 1;
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0b || code === 0x0c) {
        cursor += 1;
        continue;
      }
      if (code === 0x2f && source.charCodeAt(cursor + 1) === 0x2f) {
        cursor += 2;
        while (cursor < source.length && source.charCodeAt(cursor) !== 0x0a && source.charCodeAt(cursor) !== 0x0d) cursor += 1;
        continue;
      }
      if (code === 0x2f && source.charCodeAt(cursor + 1) === 0x2a) {
        const end = source.indexOf('*/', cursor + 2);
        if (end === -1) {
          diagnostics.push({ code: 'LEX_UNTERMINATED_COMMENT', offset: cursor });
          return source.length;
        }
        cursor = end + 2;
        continue;
      }
      if (code === 0x27 || code === 0x22) {
        cursor = skipString(cursor, code);
        continue;
      }
      if (code === 0x60) {
        cursor = scanTemplate(cursor);
        continue;
      }
      if (code === 0x2f && canStartRegex(previous)) {
        cursor = skipRegex(cursor);
        continue;
      }
      if (identifierStart(code)) {
        const start = cursor;
        cursor += 1;
        while (cursor < source.length && identifierPart(source.charCodeAt(cursor))) cursor += 1;
        previous = { kind: 'identifier', value: source.slice(start, cursor), start };
        tokens.push(previous);
        continue;
      }
      if (code >= 0x30 && code <= 0x39) {
        const start = cursor;
        cursor += 1;
        while (cursor < source.length && /[0-9A-Za-z._]/.test(source[cursor])) cursor += 1;
        previous = { kind: 'number', value: source.slice(start, cursor), start };
        tokens.push(previous);
        continue;
      }
      const token = { kind: 'punctuation', value: source[cursor], start: cursor };
      tokens.push(token);
      previous = token;
      if (token.value === '{') braceDepth += 1;
      if (token.value === '}') braceDepth = Math.max(0, braceDepth - 1);
      cursor += 1;
    }
    if (stopAtBrace) diagnostics.push({ code: 'LEX_UNTERMINATED_TEMPLATE_EXPRESSION', offset: index });
    return cursor;
  }

  scan(0);
  return { tokens, diagnostics };
}

function dynamicDependencyFindings(source, filePath) {
  const { tokens, diagnostics } = tokenize(source);
  const findings = [];
  const at = (index) => ({ file: filePath, offset: tokens[index]?.start ?? null });
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    const nextNext = tokens[index + 2];
    if (current.kind !== 'identifier') continue;
    if (current.value === 'import' && next?.value === '(') findings.push({ ...at(index), kind: 'dynamic-import' });
    if (current.value === 'require') findings.push({ ...at(index), kind: next?.value === '(' ? 'require-call' : 'require-reference' });
    if (current.value === 'createRequire') findings.push({ ...at(index), kind: 'create-require' });
    if (current.value === 'module' && next?.value === '.' && nextNext?.value === 'require') findings.push({ ...at(index), kind: 'module-require' });
    if (current.value === 'import' && next?.value === '.' && nextNext?.value === 'meta') {
      findings.push({ ...at(index), kind: 'import-meta-resolution' });
    }
    if (current.value === 'eval' || current.value === 'Function') findings.push({ ...at(index), kind: 'dynamic-code' });
  }
  return { findings, diagnostics, tokens };
}

function dynamicImportWhitespace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
    || code === 0x0b || code === 0x0c || code === 0xa0 || code === 0xfeff;
}

function skipDynamicImportTrivia(source, start) {
  let cursor = start;
  while (cursor < source.length) {
    if (dynamicImportWhitespace(source.charCodeAt(cursor))) {
      cursor += 1;
      continue;
    }
    if (source.startsWith('//', cursor)) {
      const lineEnd = source.indexOf('\n', cursor + 2);
      cursor = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const commentEnd = source.indexOf('*/', cursor + 2);
      if (commentEnd === -1) return null;
      cursor = commentEnd + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function readLiteralDynamicImport(source, offset) {
  if (!Number.isSafeInteger(offset) || !source.startsWith('import', offset)) return null;
  let cursor = skipDynamicImportTrivia(source, offset + 'import'.length);
  if (cursor === null || source[cursor] !== '(') return null;
  cursor = skipDynamicImportTrivia(source, cursor + 1);
  if (cursor === null) return null;
  const quote = source[cursor];
  if (quote !== "'" && quote !== '"') return null;
  const valueStart = cursor + 1;
  cursor = valueStart;
  while (cursor < source.length) {
    const code = source.charCodeAt(cursor);
    if (code === 0x5c || code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) {
      // Escaped strings need a parser to recover their exact module specifier;
      // leave those dynamic until a future contract can prove that decoding.
      return null;
    }
    if (source[cursor] === quote) {
      const specifier = source.slice(valueStart, cursor);
      cursor = skipDynamicImportTrivia(source, cursor + 1);
      if (cursor === null || source[cursor] !== ')' || specifier.length === 0) return null;
      return specifier;
    }
    cursor += 1;
  }
  return null;
}

function literalDynamicImports(source, dynamicFindings) {
  const imports = [];
  for (const finding of dynamicFindings) {
    const specifier = readLiteralDynamicImport(source, finding.offset);
    if (specifier !== null) imports.push({ offset: finding.offset, specifier });
  }
  return imports;
}

function isCoreSpecifier(specifier) {
  return specifier === 'better-workflows'
    || specifier.startsWith('better-workflows/')
    || specifier === '@better-workflows/core'
    || specifier.startsWith('@better-workflows/core/')
    || specifier === 'plugins/better-workflows'
    || specifier.startsWith('plugins/better-workflows/');
}

function isCorePath(repoPath) {
  return repoPath === 'plugins/better-workflows' || repoPath.startsWith('plugins/better-workflows/');
}

function collectExportTargets(value, output, location = 'exports') {
  if (value === null) return;
  if (typeof value === 'string') {
    if (value.startsWith('./')) {
      output.targets.push(value.slice(2));
    } else {
      output.invalid.push({ kind: 'invalid-export-target', location, target: value });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectExportTargets(item, output, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    output.invalid.push({ kind: 'invalid-export-target', location, target: null, valueType: typeof value });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    collectExportTargets(item, output, `${location}.${key}`);
  }
}

function resolveExportValue(value, subpath) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = resolveExportValue(item, subpath);
      if (resolved) return resolved;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(value, subpath)) return resolveExportValue(value[subpath], subpath);
  for (const key of ['import', 'node', 'default', 'require', 'types']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const resolved = resolveExportValue(value[key], subpath);
      if (resolved) return resolved;
    }
  }
  return null;
}

function selfReferenceTarget(specifier, packageManifest, packagePaths) {
  const packageName = packageManifest?.name;
  if (typeof packageName !== 'string' || !specifier.startsWith(packageName)) return null;
  const suffix = specifier.slice(packageName.length);
  if (suffix !== '' && !suffix.startsWith('/')) return null;
  const subpath = suffix === '' ? '.' : `.${suffix}`;
  const target = resolveExportValue(packageManifest.exports, subpath);
  if (typeof target !== 'string' || !target.startsWith('./')) return null;
  const packagePath = slashPath(target.slice(2));
  return packagePaths.has(packagePath) ? packagePath : { missing: packagePath };
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    const [key, inline] = argument.split('=', 2);
    if (!['--repo-root', '--package-root', '--source-revision', '--source-files-sha256', '--source-tree-sha256', '--build-receipt-path', '--closure-receipt-path'].includes(key)) {
      throw new Error(`unknown option ${argument}`);
    }
    const value = inline ?? argv[++index];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--repo-root') options.repoRoot = path.resolve(value);
    if (key === '--package-root') options.packageRoot = value;
    if (key === '--source-revision') options.sourceRevision = value;
    if (key === '--source-files-sha256') options.sourceFilesSha256 = value;
    if (key === '--source-tree-sha256') options.sourceTreeSha256 = value;
    if (key === '--build-receipt-path') options.buildReceiptPath = value;
    if (key === '--closure-receipt-path') options.closureReceiptPath = value;
  }
  return options;
}

function helpText() {
  return [
    'Usage: node --experimental-vm-modules scripts/closure-check.mjs [options]',
    '',
    'Options:',
    '  --repo-root PATH             Repository root used for contract-relative paths.',
    '  --package-root PATH          Contract packageRoot (default packages/better-workflows-wire).',
    '  --source-revision SHA        Scan the exact Git source-tree universe instead of npm pack output.',
    '  --source-files-sha256 SHA    Expected source file-record digest; drift fails closed.',
    '  --source-tree-sha256 SHA     Expected source tree digest; drift fails closed.',
    '  --build-receipt-path PATH    External build receipt path.',
    '  --closure-receipt-path PATH  External closure receipt path.',
  ].join('\n');
}

function inspectRegularFile(candidate) {
  try {
    const canonicalPath = realpathSync(candidate);
    const info = statSync(canonicalPath);
    if (!info.isFile()) return null;
    return { path: canonicalPath, sha256: sha256(readFileSync(canonicalPath)) };
  } catch {
    return null;
  }
}

function nodeInstallationRoots(nodePath) {
  const roots = [];
  let current = path.dirname(nodePath);
  for (let depth = 0; depth < 8; depth += 1) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function resolveNpmTool() {
  const tool = {
    name: 'npm',
    source: SUPPORTED_PROCESS_PLATFORMS.has(process.platform) ? 'node-installation' : 'unsupported-platform',
    path: null,
    sha256: null,
    version: null,
    nodePath: null,
    nodeVersion: process.version,
    platform: process.platform,
    processGroup: SUPPORTED_PROCESS_PLATFORMS.has(process.platform) ? 'detached-posix-pgid' : null,
    cleanup: {
      versionProbe: null,
      packProbe: null,
      cache: null,
    },
  };
  if (!SUPPORTED_PROCESS_PLATFORMS.has(process.platform)) {
    return { tool, error: `unsupported process platform: ${process.platform}` };
  }

  let nodePath;
  try {
    nodePath = realpathSync(process.execPath);
    if (!statSync(nodePath).isFile()) throw new Error('Node executable is not a regular file');
  } catch (error) {
    return { tool, error: error instanceof Error ? `Node executable is not verifiable: ${error.message}` : 'Node executable is not verifiable' };
  }
  tool.nodePath = nodePath;
  const roots = nodeInstallationRoots(nodePath);
  const candidates = new Set();
  for (const root of roots) {
    candidates.add(path.join(root, 'npm'));
    candidates.add(path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.add(path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) {
    const inspected = inspectRegularFile(candidate);
    if (!inspected || !roots.some((root) => isInside(root, inspected.path))) continue;
    tool.path = inspected.path;
    tool.sha256 = inspected.sha256;
    return { tool, error: null };
  }
  return { tool, error: 'npm CLI is not verifiable from the current Node installation' };
}

function sameNpmTool(tool) {
  if (!tool?.path || !SHA256.test(tool.sha256 ?? '')) return false;
  const inspected = inspectRegularFile(tool.path);
  return Boolean(inspected && inspected.path === tool.path && inspected.sha256 === tool.sha256);
}

function waitForMilliseconds(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function processGroupState(pid) {
  if (!SUPPORTED_PROCESS_PLATFORMS.has(process.platform)) return 'unsupported-platform';
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return 'unknown';
  try {
    process.kill(-pid, 0);
    return 'live';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'absent' : 'unknown';
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = processGroupState(pid);
    if (state === 'absent') return true;
    if (state !== 'live' && state !== 'unknown') return false;
    const remaining = Math.max(1, Math.min(PROCESS_CLEANUP_POLL_MS, deadline - Date.now()));
    await waitForMilliseconds(remaining);
  }
  return processGroupState(pid) === 'absent';
}

const ownedSupervisors = new Map();

function cleanupDeadline(value, fallbackMs = PROCESS_CLEANUP_GRACE_MS * 2) {
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now() + fallbackMs;
}

function cleanupGrace(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : PROCESS_CLEANUP_GRACE_MS;
}

function cleanupResult({
  verified,
  state,
  requestedSignals = [],
  observedSignal = null,
}) {
  const requested = Array.isArray(requestedSignals)
    ? requestedSignals.filter((value) => typeof value === 'string')
    : [];
  const observed = typeof observedSignal === 'string' ? observedSignal : null;
  return {
    verified: verified === true,
    method: PROCESS_CLEANUP_METHOD,
    state,
    requestedSignals: requested,
    observedSignal: observed,
    // Keep the old field as an alias, but only expose an actual observed
    // target signal. Cleanup grace must never be used to infer SIGKILL.
    signal: observed,
  };
}

async function observeProcessGroupUntil(pid, deadline) {
  const remaining = Math.max(0, deadline - Date.now());
  return waitForProcessGroupExit(pid, remaining);
}

async function cleanupOwnedProcessGroup(pid, {
  graceMs = PROCESS_CLEANUP_GRACE_MS,
  deadline = Date.now() + (PROCESS_CLEANUP_GRACE_MS * 2),
  observedSignal = null,
} = {}) {
  if (!SUPPORTED_PROCESS_PLATFORMS.has(process.platform)) {
    return cleanupResult({ verified: false, state: 'unsupported-platform', observedSignal });
  }
  if (pid === undefined || pid === null) return cleanupResult({ verified: true, state: 'not-started', observedSignal });
  const operationDeadline = cleanupDeadline(deadline);
  const record = ownedSupervisors.get(pid);
  const actualObservedSignal = typeof observedSignal === 'string'
    ? observedSignal
    : (typeof record?.observedSignal === 'string' ? record.observedSignal : null);
  const requestedSignals = record?.requestedSignals ?? [];
  if (!record) {
    const absent = await observeProcessGroupUntil(pid, operationDeadline);
    return absent
      ? cleanupResult({ verified: true, state: 'absent', requestedSignals, observedSignal: actualObservedSignal })
      : cleanupResult({ verified: false, state: 'owner-proof-missing', requestedSignals, observedSignal: actualObservedSignal });
  }
  if (record.lifecycle === 'cleaned') {
    const absent = await observeProcessGroupUntil(pid, operationDeadline);
    return absent
      ? cleanupResult({ verified: true, state: 'absent', requestedSignals, observedSignal: actualObservedSignal })
      : cleanupResult({ verified: false, state: 'cleanup-unverified', requestedSignals, observedSignal: actualObservedSignal });
  }
  if (!record.child.connected) {
    record.ownerProof = false;
    if (record.lifecycle !== 'cleaned') record.lifecycle = 'proof-lost';
  }
  if (record.ownerProof !== true) {
    await observeProcessGroupUntil(pid, operationDeadline);
    return cleanupResult({ verified: false, state: 'owner-proof-lost', requestedSignals, observedSignal: actualObservedSignal });
  }
  const remaining = operationDeadline - Date.now();
  if (remaining <= 0) {
    return cleanupResult({ verified: false, state: 'cleanup-deadline-exceeded', requestedSignals, observedSignal: actualObservedSignal });
  }
  if (record.cleanupRequested) {
    const absent = await observeProcessGroupUntil(pid, operationDeadline);
    if (absent) {
      record.lifecycle = 'cleaned';
      record.ownerProof = false;
      return cleanupResult({ verified: true, state: 'terminated', requestedSignals, observedSignal: actualObservedSignal });
    }
    return cleanupResult({
      verified: false,
      state: record.ownerProof ? 'cleanup-deadline-exceeded' : 'owner-proof-lost',
      requestedSignals,
      observedSignal: actualObservedSignal,
    });
  }
  const requestedGrace = cleanupGrace(graceMs);
  const boundedGrace = Math.min(requestedGrace, Math.max(0, Math.floor(remaining / 2)));
  try {
    record.cleanupRequested = true;
    record.requestedSignals = ['SIGTERM', ...(boundedGrace > 0 ? ['SIGKILL'] : [])];
    record.child.send({ type: 'cleanup', nonce: record.nonce, graceMs: boundedGrace, deadline: operationDeadline });
  } catch {
    record.cleanupRequested = false;
    record.requestedSignals = [];
    return cleanupResult({ verified: false, state: 'owner-ipc-send-failed', requestedSignals, observedSignal: actualObservedSignal });
  }
  const absent = await observeProcessGroupUntil(pid, operationDeadline);
  if (absent) {
    record.lifecycle = 'cleaned';
    record.ownerProof = false;
    return cleanupResult({
      verified: true,
      state: 'terminated',
      requestedSignals: record.requestedSignals,
      observedSignal: actualObservedSignal,
    });
  }
  return cleanupResult({
    verified: false,
    state: record.ownerProof ? 'cleanup-deadline-exceeded' : 'owner-proof-lost',
    requestedSignals: record.requestedSignals,
    observedSignal: actualObservedSignal,
  });
}

function isolatedNpmEnvironment(cacheDir, userConfigPath, globalConfigPath) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toLowerCase();
    if (normalized === 'node_options'
      || normalized === 'node_path'
      || normalized === 'node_extra_ca_certs'
      || normalized === 'npm_execpath'
      || normalized.startsWith('npm_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_CACHE: cacheDir,
    NPM_CONFIG_USERCONFIG: userConfigPath,
    NPM_CONFIG_GLOBALCONFIG: globalConfigPath,
  };
}

function runBoundedProcess(command, args, {
  cwd,
  env,
  stdin = undefined,
  outputEncoding = 'utf8',
  timeoutMs = PACK_TIMEOUT_MS,
  maxBuffer = 8 * 1024 * 1024,
  cleanupGraceMs = PROCESS_CLEANUP_GRACE_MS,
  startDelayMs = 0,
  onOwnerProof = null,
} = {}) {
  if (!SUPPORTED_PROCESS_PLATFORMS.has(process.platform)) {
    return Promise.resolve({ child: null, cleanup: cleanupResult({ verified: false, state: 'unsupported-platform' }), error: `unsupported process platform: ${process.platform}` });
  }
  const totalTimeoutMs = timeoutMs;
  const requestedGraceMs = cleanupGraceMs;
  const validTimeout = Number.isSafeInteger(totalTimeoutMs)
    && totalTimeoutMs > 0
    && totalTimeoutMs <= PROCESS_MAX_TIMER_MS;
  const validGrace = Number.isSafeInteger(requestedGraceMs)
    && requestedGraceMs >= PROCESS_MIN_CLEANUP_GRACE_MS;
  const availableWorkBudgetMs = validTimeout && validGrace
    ? totalTimeoutMs - (requestedGraceMs * 2)
    : null;
  const operationDeadline = validTimeout ? Date.now() + totalTimeoutMs : null;
  const validDeadline = Number.isSafeInteger(operationDeadline);
  if (!validTimeout || !validGrace || !validDeadline || availableWorkBudgetMs < PROCESS_MIN_START_BUDGET_MS) {
    const state = !validTimeout || !validDeadline || !validGrace
      ? 'invalid-process-budget'
      : 'no-available-budget';
    return Promise.resolve({
      child: null,
      cleanup: cleanupResult({ verified: false, state }),
      error: `bounded process timeout/grace budget is invalid or too small: timeoutMs=${String(totalTimeoutMs)} cleanupGraceMs=${String(requestedGraceMs)}`,
    });
  }
  return new Promise((resolve) => {
    const requestedStartDelayMs = Number.isSafeInteger(startDelayMs)
      && startDelayMs > 0
      && startDelayMs <= PROCESS_MAX_TIMER_MS
      ? startDelayMs
      : 0;
    const workDeadline = Math.max(Date.now(), operationDeadline - (requestedGraceMs * 2));
    const nonce = randomBytes(32).toString('hex');
    const supervisorEnv = {
      PATH: process.env.PATH ?? '',
      BW_WIRE_OWNER_NONCE: nonce,
      BW_WIRE_OPERATION_DEADLINE: String(operationDeadline),
      BW_WIRE_CLEANUP_GRACE_MS: String(requestedGraceMs),
    };
    const targetEnv = env ?? process.env;
    let child;
    try {
      child = spawn(process.execPath, ['--input-type=module', '-e', SUPERVISOR_SOURCE], {
        cwd,
        env: supervisorEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (error) {
      resolve({
        child: null,
        cleanup: cleanupResult({ verified: true, state: 'not-started' }),
        error: error instanceof Error ? error.message : 'bounded process spawn failed',
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputOverflow = false;
    let settled = false;
    let workTimer = null;
    let deadlineTimer = null;
    let finishing = false;
    let targetStatus = null;
    let targetSignal = null;
    let targetError = null;
    const record = {
      child,
      nonce,
      ownerProof: false,
      lifecycle: 'starting',
      cleanupRequested: false,
      requestedSignals: [],
      observedSignal: null,
    };
    if (child.pid) ownedSupervisors.set(child.pid, record);

    const capture = (chunks, byteCount, chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (byteCount + bytes.length <= maxBuffer) chunks.push(bytes);
      return byteCount + bytes.length;
    };
    const outputValue = (chunks) => {
      const bytes = Buffer.concat(chunks);
      return outputEncoding === 'buffer' ? bytes : bytes.toString('utf8');
    };
    const childResult = (status = null, signal = null, error = null) => ({
      pid: child.pid ?? null,
      status: targetStatus,
      signal: targetSignal,
      stdout: outputValue(stdoutChunks),
      stderr: outputValue(stderrChunks),
      error,
    });
    let released = false;
    const releaseSupervisor = () => {
      if (released) return;
      released = true;
      if (child.connected) child.disconnect();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const finishWithCleanup = async (status, signal, detail) => {
      if (settled || finishing) return;
      finishing = true;
      if (workTimer) clearTimeout(workTimer);
      const cleanup = await cleanupOwnedProcessGroup(child.pid, {
        graceMs: requestedGraceMs,
        deadline: operationDeadline,
        observedSignal: targetSignal,
      });
      if (settled) return;
      settled = true;
      if (workTimer) clearTimeout(workTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      releaseSupervisor();
      let error = detail;
      if (outputOverflow && !error) error = `bounded process output exceeded ${maxBuffer} bytes`;
      if (!cleanup.verified && !error) error = 'process-group cleanup was not verified';
      if (!cleanup.verified && error && !error.includes('process-group cleanup was not verified')) {
        error = `${error}; process-group cleanup was not verified`;
      }
      resolve({ child: childResult(status, signal, error), cleanup, error });
    };

    const finishAtDeadline = () => {
      if (settled) return;
      if (!finishing) finishing = true;
      settled = true;
      if (workTimer) clearTimeout(workTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      const cleanup = {
        ...cleanupResult({
          verified: false,
          state: record.ownerProof ? 'cleanup-deadline-exceeded' : 'owner-proof-lost',
          requestedSignals: record.requestedSignals,
          observedSignal: targetSignal,
        }),
      };
      const error = `bounded process exceeded ${totalTimeoutMs}ms; process-group cleanup was not verified`;
      releaseSupervisor();
      resolve({ child: childResult(null, null, error), cleanup, error });
    };

    const sendSupervisor = (message) => {
      if (!record.ownerProof || !child.connected || Date.now() >= operationDeadline) return false;
      try {
        child.send({ ...message, nonce });
        return true;
      } catch {
        return false;
      }
    };

    child.on('message', (message) => {
      if (!message || typeof message !== 'object' || message.nonce !== nonce) return;
      if (message.type === 'ready') {
        if (settled || Date.now() >= operationDeadline) {
          record.ownerProof = false;
          record.lifecycle = 'deadline';
          if (child.connected) child.disconnect();
          return;
        }
        record.ownerProof = true;
        record.lifecycle = 'active';
        if (typeof onOwnerProof === 'function') {
          try { onOwnerProof(child.pid); } catch {}
        }
        if (!sendSupervisor({
          type: 'start',
          command,
          args,
          cwd: cwd ?? process.cwd(),
          env: targetEnv,
          stdin,
          deadline: operationDeadline,
          startDelayMs: requestedStartDelayMs,
        })) {
          void finishWithCleanup(null, null, 'owned supervisor start request failed');
        }
        return;
      }
      if (message.type === 'start-refused') {
        void finishWithCleanup(null, null, `owned supervisor refused target start: ${message.reason ?? 'unknown'}`);
        return;
      }
      if (message.type === 'target-error') {
        targetError = typeof message.message === 'string' ? message.message : 'target process failed';
        void finishWithCleanup(null, null, targetError);
        return;
      }
      if (message.type === 'target-close') {
        targetStatus = Number.isSafeInteger(message.status) ? message.status : null;
        targetSignal = typeof message.signal === 'string' ? message.signal : null;
        record.observedSignal = targetSignal;
        const detail = targetStatus === 0 && !targetSignal && !outputOverflow
          ? null
          : targetSignal
            ? `bounded process exited on ${targetSignal}`
            : `bounded process exited with status ${targetStatus}`;
        void finishWithCleanup(targetStatus, targetSignal, detail);
        return;
      }
      if (message.type === 'cleanup-started') {
        record.lifecycle = 'cleaning';
        if (Array.isArray(message.requestedSignals)) {
          record.requestedSignals = message.requestedSignals.filter((value) => typeof value === 'string');
        }
        return;
      }
      if (message.type === 'cleanup-kill-requested') {
        if (message.requestedSignal === 'SIGKILL' && !record.requestedSignals.includes('SIGKILL')) {
          record.requestedSignals = [...record.requestedSignals, 'SIGKILL'];
        }
      }
    });

    child.stdout.on('data', (chunk) => {
      stdoutBytes = capture(stdoutChunks, stdoutBytes, chunk);
      if (stdoutBytes > maxBuffer) outputOverflow = true;
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes = capture(stderrChunks, stderrBytes, chunk);
      if (stderrBytes > maxBuffer) outputOverflow = true;
    });
    child.once('disconnect', () => {
      record.ownerProof = false;
      if (record.lifecycle !== 'cleaned') record.lifecycle = 'proof-lost';
    });
    child.once('error', (error) => {
      record.ownerProof = false;
      if (record.lifecycle !== 'cleaned') record.lifecycle = 'proof-lost';
      void finishWithCleanup(null, null, error instanceof Error ? error.message : 'bounded process failed');
    });
    child.once('close', (status, signal) => {
      record.ownerProof = false;
      if (record.lifecycle !== 'cleaned') record.lifecycle = 'proof-lost';
      const detail = targetStatus !== null || targetSignal
        ? targetStatus === 0 && !targetSignal && !outputOverflow
          ? null
          : targetSignal
            ? `bounded process exited on ${targetSignal}`
            : `bounded process exited with status ${targetStatus}`
        : status === 0 && !signal && !outputOverflow
          ? null
          : signal
            ? `owned supervisor exited on ${signal}`
            : `owned supervisor exited with status ${status}`;
      void finishWithCleanup(targetStatus, targetSignal, detail);
    });
    workTimer = setTimeout(() => {
      void finishWithCleanup(null, null, `bounded process exceeded ${totalTimeoutMs}ms`);
    }, Math.max(0, workDeadline - Date.now()));
    deadlineTimer = setTimeout(finishAtDeadline, Math.max(0, operationDeadline - Date.now()));
  });
}

function cleanupCacheDir(cacheDir) {
  try {
    const info = lstatSync(cacheDir);
    if (!info.isDirectory() || info.isSymbolicLink()) return { verified: false, state: 'cache-entry-replaced' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { verified: true, state: 'absent' };
    return { verified: false, state: 'cache-stat-failed' };
  }
  try {
    rmSync(cacheDir, { recursive: true, force: false });
  } catch {
    return { verified: false, state: 'cache-remove-failed' };
  }
  try {
    lstatSync(cacheDir);
    return { verified: false, state: 'cache-remains' };
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { verified: true, state: 'removed' }
      : { verified: false, state: 'cache-final-stat-failed' };
  }
}

function cleanupReceipt(cleanup) {
  if (!cleanup) return null;
  const observedSignal = typeof cleanup.observedSignal === 'string' ? cleanup.observedSignal : null;
  const requestedSignals = Array.isArray(cleanup.requestedSignals)
    ? cleanup.requestedSignals.filter((value) => typeof value === 'string')
    : [];
  return {
    verified: cleanup.verified === true,
    method: cleanup.method ?? null,
    state: cleanup.state ?? null,
    requestedSignals,
    observedSignal,
    signal: observedSignal,
  };
}

export function runBoundedProcessForTest(command, args, options) {
  return runBoundedProcess(command, args, options);
}

export function cleanupOwnedProcessGroupForTest(pid, options) {
  return cleanupOwnedProcessGroup(pid, options);
}

export function loseOwnedSupervisorProofForTest(pid) {
  const record = ownedSupervisors.get(pid);
  if (!record || record.lifecycle === 'cleaned') return false;
  record.ownerProof = false;
  record.lifecycle = 'proof-lost';
  return true;
}

export function restoreOwnedSupervisorProofForTest(pid) {
  const record = ownedSupervisors.get(pid);
  if (!record || record.lifecycle === 'cleaned') return false;
  record.ownerProof = true;
  record.lifecycle = 'active';
  return true;
}

async function spawnPack(packageDir) {
  const result = {
    records: null,
    bundled: [],
    source: 'npm-pack-dry-run',
    tool: null,
    error: null,
  };
  const resolved = resolveNpmTool();
  result.tool = resolved.tool;
  if (resolved.error) {
    result.error = resolved.error;
    return result;
  }
  let cacheDir;
  try {
    cacheDir = mkdtempSync(path.join(os.tmpdir(), 'better-workflows-wire-pack-'));
  } catch (error) {
    result.error = error instanceof Error ? `npm cache setup failed: ${error.message}` : 'npm cache setup failed';
    return result;
  }
  const userConfigPath = path.join(cacheDir, 'userconfig');
  const globalConfigPath = path.join(cacheDir, 'globalconfig');
  const env = isolatedNpmEnvironment(cacheDir, userConfigPath, globalConfigPath);
  const commonArgs = [
    result.tool.path,
    '--cache', cacheDir,
    '--offline',
    '--loglevel=error',
    `--userconfig=${userConfigPath}`,
    `--globalconfig=${globalConfigPath}`,
  ];
  try {
    const versionProbe = await runBoundedProcess(process.execPath, [...commonArgs, '--version'], {
      cwd: packageDir,
      env,
      maxBuffer: 64 * 1024,
    });
    result.tool.cleanup.versionProbe = cleanupReceipt(versionProbe.cleanup);
    if (versionProbe.error) {
      result.error = `npm version probe failed: ${versionProbe.error}`;
      return result;
    }
    const npmVersion = String(versionProbe.child?.stdout ?? '').trim();
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(npmVersion)) {
      result.error = 'npm version probe returned an invalid version';
      return result;
    }
    if (!sameNpmTool(result.tool)) {
      result.error = 'npm CLI bytes changed after version probe';
      return result;
    }
    result.tool.version = npmVersion;
    const packProbe = await runBoundedProcess(process.execPath, [...commonArgs,
      'pack',
      '--dry-run',
      '--json',
      '--ignore-scripts',
    ], {
      cwd: packageDir,
      env,
    });
    result.tool.cleanup.packProbe = cleanupReceipt(packProbe.cleanup);
    if (packProbe.error) {
      result.error = `npm pack failed: ${packProbe.error}`;
      return result;
    }
    if (!sameNpmTool(result.tool)) {
      result.error = 'npm CLI bytes changed after pack';
      return result;
    }
    let parsed;
    try {
      parsed = JSON.parse(String(packProbe.child?.stdout ?? '').trim());
    } catch {
      result.error = 'npm pack returned invalid JSON';
      return result;
    }
    if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0]?.files)) {
      result.error = 'npm pack JSON did not contain exactly one files list';
      return result;
    }
    result.records = parsed[0].files;
    result.bundled = Array.isArray(parsed[0].bundled) ? parsed[0].bundled : [];
    return result;
  } finally {
    result.tool.cleanup.cache = cleanupReceipt(cleanupCacheDir(cacheDir));
    if (!result.tool.cleanup.cache.verified && !result.error) result.error = 'npm cache cleanup was not verified';
  }
}

function defaultResult(packageRoot, buildReceiptPath, closureReceiptPath) {
  return {
    schemaVersion: 1,
    kind: CLOSURE_SCAN_KIND,
    packageRoot,
    universeKind: null,
    sourceRevision: null,
    sourceFiles: [],
    sourceTreeRecords: [],
    sourceFilesSha256: null,
    sourceTreeSha256: null,
    expectedSourceFilesSha256: null,
    expectedSourceTreeSha256: null,
    packageManifest: null,
    packageFiles: [],
    packageFilesSha256: null,
    buildReceipt: null,
    closureReceipt: null,
    buildReceiptContent: null,
    closureReceiptContent: null,
    buildReceiptBytes: null,
    closureReceiptBytes: null,
    buildReceiptPath,
    closureReceiptPath,
    sourceReceipt: null,
    packSource: null,
    packTool: null,
    independent: false,
    verified: false,
    coreImports: [],
    indirectCoreImports: [],
    unresolvedDependencies: [],
    dynamicDependencies: [],
    sourceRuntimeFeatures: [],
    pathEscapes: [],
    syntaxErrors: [],
    scannerErrors: [],
    moduleGraph: [],
  };
}

async function readPackUniverse({ packageDir, repoRoot, rawRecords, result }) {
  if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
    result.scannerErrors.push(issue('PACK_UNIVERSE_MISSING'));
    return { records: [], byPackagePath: new Map() };
  }
  const records = [];
  const byPackagePath = new Map();
  for (const raw of rawRecords) {
    const packagePath = raw?.path;
    if (!isSafePath(packagePath)) {
      result.pathEscapes.push(issue('PACK_PATH_UNSAFE', { path: typeof packagePath === 'string' ? packagePath : null }));
      continue;
    }
    if (byPackagePath.has(packagePath)) {
      result.scannerErrors.push(issue('PACK_PATH_DUPLICATE', { path: packagePath }));
      continue;
    }
    const absolute = path.resolve(packageDir, packagePath);
    if (!isInside(packageDir, absolute)) {
      result.pathEscapes.push(issue('PACK_PATH_ESCAPE', { path: packagePath }));
      continue;
    }
    let fileInfo;
    try {
      fileInfo = await lstat(absolute);
    } catch {
      result.scannerErrors.push(issue('PACK_FILE_MISSING', { path: packagePath }));
      continue;
    }
    if (fileInfo.isSymbolicLink()) {
      result.pathEscapes.push(issue('PACK_SYMLINK_REJECTED', { path: packagePath }));
      continue;
    }
    if (!fileInfo.isFile()) {
      result.scannerErrors.push(issue('PACK_ENTRY_NOT_FILE', { path: packagePath }));
      continue;
    }
    let bytes;
    try {
      bytes = await readFile(absolute);
    } catch {
      result.scannerErrors.push(issue('PACK_FILE_UNREADABLE', { path: packagePath }));
      continue;
    }
    if (raw.size !== undefined && (!Number.isSafeInteger(raw.size) || raw.size !== bytes.byteLength)) {
      result.scannerErrors.push(issue('PACK_SIZE_DRIFT', { path: packagePath, expected: raw.size, actual: bytes.byteLength }));
    }
    const repoPath = relativePath(repoRoot, absolute);
    if (!repoPath || !isSafePath(repoPath)) {
      result.pathEscapes.push(issue('PACK_REPOSITORY_PATH_ESCAPE', { path: packagePath }));
      continue;
    }
    const record = Object.freeze({
      packagePath,
      path: repoPath,
      sha256: sha256(bytes),
      bytes,
      absolute,
    });
    byPackagePath.set(packagePath, record);
    records.push(record);
  }
  records.sort((left, right) => left.packagePath.localeCompare(right.packagePath));
  return { records, byPackagePath };
}

function parseSource(source, filePath, result, { sourceMode = false } = {}) {
  const dynamic = dynamicDependencyFindings(source, filePath);
  let findings = dynamic.findings;
  const dynamicSpecifiers = [];
  if (sourceMode) {
    result.sourceRuntimeFeatures.push(...findings.filter((item) => item.kind === 'import-meta-resolution'));
    const literalImports = literalDynamicImports(source, findings.filter((item) => item.kind === 'dynamic-import'));
    const literalOffsets = new Set(literalImports.map((item) => item.offset));
    findings = findings.filter((item) => item.kind !== 'import-meta-resolution'
      && (item.kind !== 'dynamic-import' || !literalOffsets.has(item.offset)));
    dynamicSpecifiers.push(...literalImports.map(({ specifier }) => ({ specifier, requestKind: 'dynamic' })));
  }
  result.dynamicDependencies.push(...findings);
  result.syntaxErrors.push(...dynamic.diagnostics.map((item) => ({ file: filePath, ...item })));
  if (!vm.SourceTextModule) {
    result.scannerErrors.push(issue('MODULE_PARSER_UNAVAILABLE', { file: filePath }));
    return [];
  }
  try {
    const module = new vm.SourceTextModule(source, { identifier: filePath });
    const requests = Array.isArray(module.moduleRequests)
      ? module.moduleRequests
      : Array.isArray(module.dependencySpecifiers)
        ? module.dependencySpecifiers.map((specifier) => ({ specifier, phase: 'evaluation' }))
        : null;
    if (!requests) {
      result.scannerErrors.push(issue('MODULE_REQUESTS_UNAVAILABLE', { file: filePath }));
      return [];
    }
    const specifiers = [];
    for (const request of requests) {
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || typeof request.specifier !== 'string' || request.specifier.length === 0) {
        result.unresolvedDependencies.push({ file: filePath, kind: 'module-request-specifier-missing' });
        continue;
      }
      // Node 22 exposes { specifier, attributes } without a phase. Only that
      // legacy shape implies evaluation; an explicit unknown phase stays blocked.
      const legacyRequest = !('phase' in request)
        && Object.hasOwn(request, 'specifier') && Object.hasOwn(request, 'attributes')
        && request.attributes !== null && typeof request.attributes === 'object'
        && !Array.isArray(request.attributes);
      const phase = legacyRequest ? 'evaluation' : request.phase;
      if (!STATIC_MODULE_PHASES.has(phase)) {
        result.unresolvedDependencies.push({
          file: filePath,
          kind: 'unknown-module-request-phase',
          phase: request.phase ?? null,
          specifier: typeof request.specifier === 'string' ? request.specifier : null,
        });
        continue;
      }
      specifiers.push({ specifier: request.specifier, requestKind: 'static' });
    }
    return [...specifiers, ...dynamicSpecifiers];
  } catch (error) {
    result.syntaxErrors.push({ file: filePath, code: 'MODULE_PARSE_FAILED', message: error instanceof Error ? error.message : 'module parse failed' });
    return [];
  }
}

function declarationSyntaxFindings(source, filePath, result) {
  const { tokens } = tokenize(source);
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    if (current?.kind !== 'identifier') continue;
    if (current.value === 'import' && next?.value !== '(' && next?.value !== '.') {
      result.unresolvedDependencies.push({ file: filePath, kind: 'unparsed-declaration-import' });
    }
    if (current.value === 'export' && (next?.value === '*' || next?.value === '{')) {
      result.unresolvedDependencies.push({ file: filePath, kind: 'unparsed-declaration-export' });
    }
  }
}

function requestTarget({ specifier, importer, packageDir, repoRoot, packageRoot, packageManifest, packagePaths, result }) {
  if (isBuiltin(specifier)) return { kind: 'builtin', target: null };
  if (isCoreSpecifier(specifier)) return { kind: 'core', target: null };
  const selfTarget = selfReferenceTarget(specifier, packageManifest, packagePaths);
  if (selfTarget) {
    if (typeof selfTarget === 'object') return { kind: 'unresolved', target: null, detail: { kind: 'self-reference-missing', specifier, expected: selfTarget.missing } };
    return { kind: 'internal', target: selfTarget };
  }
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    if (specifier.includes('\\') || specifier.includes('\u0000') || specifier.startsWith('/')) {
      result.pathEscapes.push({ importer, specifier, target: null, kind: 'path-escape' });
      return { kind: 'escape', target: null };
    }
    const importerAbsolute = path.resolve(repoRoot, importer);
    const packageAbsolute = packageDir;
    const candidate = path.resolve(path.dirname(importerAbsolute), specifier);
    const candidateRepoPath = relativePath(repoRoot, candidate);
    const candidatePackagePath = relativePath(packageAbsolute, candidate);
    if (!candidatePackagePath) {
      result.pathEscapes.push({ importer, specifier, target: candidateRepoPath, kind: 'path-escape' });
      if (candidateRepoPath && isCorePath(candidateRepoPath)) {
        result.coreImports.push({ importer, specifier, target: candidateRepoPath, kind: 'static' });
      }
      return { kind: 'escape', target: null };
    }
    if (!packagePaths.has(candidatePackagePath)) {
      return { kind: 'unresolved', target: null, detail: { kind: 'missing-in-pack', importer, specifier, expected: candidateRepoPath } };
    }
    return { kind: 'internal', target: candidatePackagePath };
  }
  return { kind: 'unresolved', target: null, detail: { kind: 'external-import', importer, specifier } };
}

function graphCoreReachability(graph, packageRoot, result) {
  const memo = new Map();
  const active = new Set();
  function visit(packagePath) {
    if (memo.has(packagePath)) return memo.get(packagePath);
    if (active.has(packagePath)) return [];
    active.add(packagePath);
    const reachable = [];
    for (const edge of graph.get(packagePath) ?? []) {
      if (edge.kind === 'core') {
        reachable.push({ origin: packagePath, specifier: edge.specifier });
      } else if (edge.kind === 'internal' && graph.has(edge.target)) {
        const downstream = visit(edge.target);
        for (const finding of downstream) {
          result.indirectCoreImports.push({
            importer: `${packageRoot}/${packagePath}`,
            via: `${packageRoot}/${edge.target}`,
            origin: `${packageRoot}/${finding.origin}`,
            specifier: finding.specifier,
            packageRoot,
          });
          reachable.push(finding);
        }
      }
    }
    active.delete(packagePath);
    const unique = dedupe(reachable);
    memo.set(packagePath, unique);
    return unique;
  }
  for (const packagePath of graph.keys()) visit(packagePath);
}

function normalizeResult(result) {
  for (const key of ['coreImports', 'indirectCoreImports', 'unresolvedDependencies', 'dynamicDependencies', 'sourceRuntimeFeatures', 'pathEscapes', 'syntaxErrors', 'scannerErrors', 'moduleGraph']) {
    result[key] = sortRecords(dedupe(result[key]));
  }
  result.independent = result.coreImports.length === 0
    && result.indirectCoreImports.length === 0
    && result.unresolvedDependencies.length === 0
    && result.dynamicDependencies.length === 0
    && result.pathEscapes.length === 0
    && result.syntaxErrors.length === 0
    && result.scannerErrors.length === 0;
  const universeVerified = result.universeKind === GIT_SOURCE_TREE_UNIVERSE
    ? result.sourceFiles.length > 0
      && SHA256.test(result.sourceFilesSha256 ?? '')
      && SHA256.test(result.sourceTreeSha256 ?? '')
      && SHA1.test(result.sourceRevision ?? '')
    : result.packageFiles.length > 0 && SHA256.test(result.packageFilesSha256 ?? '');
  result.verified = result.independent && Boolean(result.packageManifest) && universeVerified;
  return result;
}

export async function scanPackage({
  packageDir = PACKAGE_DIR,
  repoRoot = DEFAULT_REPO_ROOT,
  packageRoot = DEFAULT_PACKAGE_ROOT,
  packFiles = null,
  sourceMode = null,
  sourceRevision = null,
  sourceFilesSha256 = null,
  sourceTreeSha256 = null,
  buildReceiptPath = DEFAULT_BUILD_RECEIPT_PATH,
  closureReceiptPath = DEFAULT_CLOSURE_RECEIPT_PATH,
} = {}) {
  const result = defaultResult(packageRoot, buildReceiptPath, closureReceiptPath);
  const wantsSourceTree = sourceMode !== null || sourceRevision !== null;
  if (sourceMode !== null && sourceMode !== GIT_SOURCE_TREE_UNIVERSE) {
    result.scannerErrors.push(issue('SOURCE_MODE_UNSUPPORTED', { sourceMode }));
    return normalizeResult(result);
  }
  if (wantsSourceTree) {
    result.universeKind = GIT_SOURCE_TREE_UNIVERSE;
    result.expectedSourceFilesSha256 = sourceFilesSha256;
    result.expectedSourceTreeSha256 = sourceTreeSha256;
  } else {
    result.universeKind = NPM_DISTRIBUTION_UNIVERSE;
  }
  let packageAbsolute;
  let repoAbsolute;
  try {
    packageAbsolute = await realpath(packageDir);
    repoAbsolute = await realpath(repoRoot);
  } catch (error) {
    result.scannerErrors.push(issue('ROOT_UNREADABLE', { message: error instanceof Error ? error.message : 'root unreadable' }));
    return normalizeResult(result);
  }
  if (!isSafePath(packageRoot) || !isSafePath(buildReceiptPath) || !isSafePath(closureReceiptPath)) {
    result.scannerErrors.push(issue('CONTRACT_PATH_UNSAFE'));
    return normalizeResult(result);
  }
  if (!isInside(repoAbsolute, packageAbsolute) || relativePath(repoAbsolute, packageAbsolute) !== packageRoot) {
    result.scannerErrors.push(issue('PACKAGE_ROOT_BINDING_INVALID'));
    return normalizeResult(result);
  }
  if (wantsSourceTree && packFiles !== null) {
    result.scannerErrors.push(issue('SOURCE_PACK_UNIVERSE_CONFLICT'));
    return normalizeResult(result);
  }
  if (buildReceiptPath.startsWith(`${packageRoot}/`) || closureReceiptPath.startsWith(`${packageRoot}/`)) {
    result.scannerErrors.push(issue('RECEIPT_PATH_INSIDE_PACKAGE'));
  }
  const packageManifestRecordPath = `${packageRoot}/package.json`;
  let universe;
  if (wantsSourceTree) {
    try {
      universe = await readGitSourceUniverse({ repoRoot: repoAbsolute, packageRoot, sourceRevision, result });
    } catch (error) {
      result.scannerErrors.push(issue('SOURCE_GIT_READ_FAILED', { message: error instanceof Error ? error.message : String(error) }));
      universe = { records: [], byPackagePath: new Map() };
    }
  } else {
    const pack = packFiles === null
      ? await spawnPack(packageAbsolute)
      : { records: packFiles, bundled: [], source: 'injected-test-universe', tool: null, error: null };
    result.packSource = pack.source;
    result.packTool = pack.tool;
    if (pack.error) result.scannerErrors.push(issue('PACK_COMMAND_FAILED', { message: pack.error }));
    universe = await readPackUniverse({ packageDir: packageAbsolute, repoRoot: repoAbsolute, rawRecords: pack.records, result });
    result.packageFiles = universe.records.map((record) => ({ path: record.path, sha256: record.sha256 }));
    result.packageFilesSha256 = sha256(Buffer.from(JSON.stringify(result.packageFiles), 'utf8'));
    if (pack.bundled.length > 0) result.unresolvedDependencies.push({ kind: 'bundled-dependencies', packages: pack.bundled.slice().sort() });
  }
  const manifestRecord = universe.byPackagePath.get('package.json');
  let packageManifest = null;
  if (!manifestRecord) {
    result.scannerErrors.push(issue('PACKAGE_MANIFEST_MISSING'));
  } else {
    result.packageManifest = { path: manifestRecord.path, sha256: manifestRecord.sha256 };
    if (manifestRecord.path !== packageManifestRecordPath) result.scannerErrors.push(issue('PACKAGE_MANIFEST_PATH_MISMATCH', { path: manifestRecord.path }));
    try {
      packageManifest = JSON.parse(manifestRecord.bytes.toString('utf8'));
    } catch {
      result.scannerErrors.push(issue('PACKAGE_MANIFEST_INVALID_JSON'));
    }
    if (packageManifest?.license !== 'Apache-2.0') result.scannerErrors.push(issue('PACKAGE_LICENSE_MISMATCH', { license: packageManifest?.license ?? null }));
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
      const value = packageManifest?.[section];
      if (Array.isArray(value) && value.length > 0) result.unresolvedDependencies.push({ kind: 'package-manifest-dependency', section, packages: value.slice().sort() });
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) result.unresolvedDependencies.push({ kind: 'package-manifest-dependency', section, packages: Object.keys(value).sort() });
    }
    const exportTargets = { targets: [], invalid: [] };
    if (Object.prototype.hasOwnProperty.call(packageManifest ?? {}, 'exports')) {
      collectExportTargets(packageManifest.exports, exportTargets);
    }
    result.unresolvedDependencies.push(...exportTargets.invalid);
    for (const target of dedupe(exportTargets.targets)) {
      if (!universe.byPackagePath.has(target)) result.unresolvedDependencies.push({ kind: 'missing-export-target', target });
    }
  }
  const packagePaths = new Set(universe.byPackagePath.keys());
  const graph = new Map();
  for (const record of universe.records) {
    const extension = record.packagePath.endsWith('.d.ts') ? '.d.ts' : path.extname(record.packagePath).toLowerCase();
    if (extension === '.d.ts') {
      declarationSyntaxFindings(record.bytes.toString('utf8'), record.path, result);
      continue;
    }
    if (!RUNTIME_EXTENSIONS.has(extension)) continue;
    const source = record.bytes.toString('utf8');
    const specifiers = parseSource(source, record.path, result, {
      sourceMode: result.universeKind === GIT_SOURCE_TREE_UNIVERSE,
    });
    const edges = [];
    for (const request of specifiers) {
      const specifier = typeof request === 'string' ? request : request?.specifier;
      const requestKind = typeof request === 'object' && request?.requestKind === 'dynamic' ? 'dynamic' : 'static';
      if (typeof specifier !== 'string' || specifier.length === 0) {
        result.unresolvedDependencies.push({ file: record.path, kind: 'module-request-specifier-missing' });
        continue;
      }
      const target = requestTarget({
        specifier,
        importer: record.path,
        packageDir: packageAbsolute,
        repoRoot: repoAbsolute,
        packageRoot,
        packageManifest,
        packagePaths,
        result,
      });
      const edge = requestKind === 'dynamic'
        ? { importer: record.path, specifier, kind: target.kind, target: target.target, requestKind }
        : { importer: record.path, specifier, kind: target.kind, target: target.target };
      edges.push(edge);
      if (target.kind === 'core') result.coreImports.push({ importer: record.path, specifier, kind: requestKind });
      if (target.kind === 'unresolved') result.unresolvedDependencies.push(target.detail);
    }
    graph.set(record.packagePath, edges);
    result.moduleGraph.push({ file: record.path, imports: edges });
  }
  graphCoreReachability(graph, packageRoot, result);
  // The build receipt records the local pack tool observation. It is not an
  // independent signer or a claim that npm itself is a trusted attestor.
  const buildReceiptContent = {
    kind: BUILD_RECEIPT_KIND,
    packageRoot,
    universeKind: result.universeKind,
    sourceRevision: result.sourceRevision,
    sourceFilesSha256: result.sourceFilesSha256,
    sourceTreeSha256: result.sourceTreeSha256,
    sourceRuntimeFeatures: sortRecords(dedupe(result.sourceRuntimeFeatures)),
    independent: result.coreImports.length === 0 && result.indirectCoreImports.length === 0 && result.unresolvedDependencies.length === 0 && result.dynamicDependencies.length === 0 && result.pathEscapes.length === 0 && result.syntaxErrors.length === 0 && result.scannerErrors.length === 0,
    coreImports: sortRecords(dedupe(result.coreImports)),
    indirectCoreImports: sortRecords(dedupe(result.indirectCoreImports)),
    unresolvedDependencies: sortRecords(dedupe(result.unresolvedDependencies)),
    dynamicDependencies: sortRecords(dedupe(result.dynamicDependencies)),
    pathEscapes: sortRecords(dedupe(result.pathEscapes)),
    syntaxErrors: sortRecords(dedupe(result.syntaxErrors)),
    scannerErrors: sortRecords(dedupe(result.scannerErrors)),
    packTool: result.packTool,
    packageFilesSha256: result.packageFilesSha256,
    packageManifestSha256: result.packageManifest?.sha256 ?? null,
  };
  const buildReceiptBytes = jsonBytes(buildReceiptContent);
  const buildReceiptDigest = sha256(buildReceiptBytes);
  const closureReceiptContent = {
    kind: CLOSURE_RECEIPT_KIND,
    packageRoot,
    universeKind: result.universeKind,
    sourceRevision: result.sourceRevision,
    sourceFiles: result.sourceFiles,
    sourceTreeRecords: result.sourceTreeRecords,
    sourceFilesSha256: result.sourceFilesSha256,
    sourceTreeSha256: result.sourceTreeSha256,
    sourceRuntimeFeatures: sortRecords(dedupe(result.sourceRuntimeFeatures)),
    coreImports: sortRecords(dedupe(result.coreImports)),
    indirectCoreImports: sortRecords(dedupe(result.indirectCoreImports)),
    unresolvedDependencies: sortRecords(dedupe(result.unresolvedDependencies)),
    dynamicDependencies: sortRecords(dedupe(result.dynamicDependencies)),
    pathEscapes: sortRecords(dedupe(result.pathEscapes)),
    syntaxErrors: sortRecords(dedupe(result.syntaxErrors)),
    scannerErrors: sortRecords(dedupe(result.scannerErrors)),
    packTool: result.packTool,
    packageFiles: result.packageFiles,
    packageFilesSha256: result.packageFilesSha256,
    packageManifestSha256: result.packageManifest?.sha256 ?? null,
    buildReceiptSha256: buildReceiptDigest,
    moduleGraph: sortRecords(dedupe(result.moduleGraph)),
  };
  const closureReceiptBytes = jsonBytes(closureReceiptContent);
  const closureReceiptDigest = sha256(closureReceiptBytes);
  result.buildReceiptContent = buildReceiptContent;
  result.closureReceiptContent = closureReceiptContent;
  result.buildReceiptBytes = buildReceiptBytes.toString('utf8');
  result.closureReceiptBytes = closureReceiptBytes.toString('utf8');
  result.buildReceipt = { path: buildReceiptPath, sha256: buildReceiptDigest };
  result.closureReceipt = { path: closureReceiptPath, sha256: closureReceiptDigest };
  result.sourceReceipt = result.universeKind === GIT_SOURCE_TREE_UNIVERSE
    ? {
      path: closureReceiptPath,
      sha256: closureReceiptDigest,
      universeKind: result.universeKind,
      sourceRevision: result.sourceRevision,
      sourceFilesSha256: result.sourceFilesSha256,
      sourceTreeSha256: result.sourceTreeSha256,
    }
    : null;
  result.apacheEvidence = {
    packageRoot,
    universeKind: result.universeKind,
    sourceRevision: result.sourceRevision,
    sourceFilesSha256: result.sourceFilesSha256,
    sourceTreeSha256: result.sourceTreeSha256,
    packageManifest: result.packageManifest,
    buildReceipt: result.buildReceipt,
    closureReceipt: result.closureReceipt,
  };
  return normalizeResult(result);
}

export function apacheClosureVerifierFromScan(scan) {
  if (!scan || scan.verified !== true || !scan.apacheEvidence) return null;
  if (scan.universeKind === GIT_SOURCE_TREE_UNIVERSE) {
    if (scan.apacheEvidence.universeKind !== GIT_SOURCE_TREE_UNIVERSE
      || !SHA1.test(scan.sourceRevision ?? '')
      || !SHA256.test(scan.sourceFilesSha256 ?? '')
      || !SHA256.test(scan.sourceTreeSha256 ?? '')
      || !Array.isArray(scan.sourceFiles)
      || scan.sourceFiles.length === 0
      || sourceFilesDigest(scan.sourceFiles) !== scan.sourceFilesSha256
      || !Array.isArray(scan.sourceTreeRecords)
      || scan.sourceTreeRecords.length !== scan.sourceFiles.length
      || sourceTreeDigest(scan.sourceTreeRecords) !== scan.sourceTreeSha256
      || scan.sourceReceipt?.sourceRevision !== scan.sourceRevision
      || scan.sourceReceipt?.sourceFilesSha256 !== scan.sourceFilesSha256
      || scan.sourceReceipt?.sourceTreeSha256 !== scan.sourceTreeSha256
      || scan.closureReceiptContent?.universeKind !== GIT_SOURCE_TREE_UNIVERSE
      || scan.closureReceiptContent?.sourceRevision !== scan.sourceRevision
      || JSON.stringify(scan.closureReceiptContent?.sourceFiles) !== JSON.stringify(scan.sourceFiles)
      || JSON.stringify(scan.closureReceiptContent?.sourceTreeRecords) !== JSON.stringify(scan.sourceTreeRecords)
      || scan.closureReceiptContent?.sourceFilesSha256 !== scan.sourceFilesSha256
      || scan.closureReceiptContent?.sourceTreeSha256 !== scan.sourceTreeSha256) return null;
    return {
      verified: true,
      universeKind: GIT_SOURCE_TREE_UNIVERSE,
      sourceRevision: scan.sourceRevision,
      sourceFilesSha256: scan.sourceFilesSha256,
      sourceTreeSha256: scan.sourceTreeSha256,
      manifestSha256: scan.packageManifest?.sha256 ?? null,
      buildSha256: scan.buildReceipt?.sha256 ?? null,
      closureSha256: scan.closureReceipt?.sha256 ?? null,
    };
  }
  return {
    verified: true,
    packageFilesSha256: scan.packageFilesSha256,
    manifestSha256: scan.packageManifest?.sha256 ?? null,
    buildSha256: scan.buildReceipt?.sha256 ?? null,
    closureSha256: scan.closureReceipt?.sha256 ?? null,
  };
}

async function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'invalid arguments'}\n${helpText()}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const result = await scanPackage(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.verified ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
