import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

function fail(message) {
  throw new Error(`Pinned artifact publisher: ${message}`);
}

function safeName(value, label) {
  if (
    typeof value !== "string" || !value || value === "." || value === ".." ||
    value !== path.basename(value) || /[\0/\\\r\n\t]/.test(value) ||
    Buffer.byteLength(value) > 255
  ) {
    fail(`${label} is not a safe single path component`);
  }
  return value;
}

function identity(info) {
  return `${String(info.dev)}:${String(info.ino)}`;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readInput(expectedBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > expectedBytes || total > MAX_ARTIFACT_BYTES) {
      fail("stdin exceeds the bound artifact size");
    }
    chunks.push(chunk);
  }
  if (total !== expectedBytes) fail("stdin byte count does not match the bound artifact size");
  return Buffer.concat(chunks, total);
}

async function readRecord(name) {
  let handle;
  try {
    handle = await open(name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink()) fail(`${name} is not a regular file`);
    const bytes = await handle.readFile();
    return {
      identity: identity(info),
      nlink: info.nlink,
      size: info.size,
      sha256: digest(bytes)
    };
  } finally {
    await handle.close();
  }
}

async function syncDirectory() {
  const handle = await open(".", fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createTemporary(name, bytes) {
  const handle = await open(
    name,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o644);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory();
}

function assertArtifact(record, expectedSha256, expectedBytes, label) {
  if (!record) fail(`${label} is missing`);
  if (record.sha256 !== expectedSha256 || record.size !== expectedBytes) {
    fail(`${label} bytes do not match the immutable artifact binding`);
  }
}

async function linkPublication({ targetName, temporaryName, expectedSha256, expectedBytes, expectedTargetIdentity }) {
  const bytes = await readInput(expectedBytes);
  if (digest(bytes) !== expectedSha256) fail("stdin digest does not match the immutable artifact binding");

  let target = await readRecord(targetName);
  let temporary = await readRecord(temporaryName);
  if (target) {
    assertArtifact(target, expectedSha256, expectedBytes, "target");
    if (temporary) {
      assertArtifact(temporary, expectedSha256, expectedBytes, "temporary file");
      if (target.identity !== temporary.identity || target.nlink !== 2 || temporary.nlink !== 2) {
        fail("target and temporary file are not the same two-link publication inode");
      }
    } else if (!expectedTargetIdentity || target.identity !== expectedTargetIdentity || target.nlink !== 1) {
      fail("target exists without a replay-valid publication identity");
    }
    return { state: "linked", recovered: true, target, temporary };
  }

  if (temporary) {
    if (temporary.nlink !== 1) fail("orphaned temporary publication has an unexpected link count");
    if (temporary.sha256 !== expectedSha256 || temporary.size !== expectedBytes) {
      await unlink(temporaryName);
      await syncDirectory();
      temporary = null;
    }
  }
  if (!temporary) {
    await createTemporary(temporaryName, bytes);
    temporary = await readRecord(temporaryName);
    assertArtifact(temporary, expectedSha256, expectedBytes, "temporary file");
    if (temporary.nlink !== 1) fail("new temporary publication has an unexpected link count");
  }

  await link(temporaryName, targetName);
  await syncDirectory();
  target = await readRecord(targetName);
  temporary = await readRecord(temporaryName);
  assertArtifact(target, expectedSha256, expectedBytes, "target");
  assertArtifact(temporary, expectedSha256, expectedBytes, "temporary file");
  if (target.identity !== temporary.identity || target.nlink !== 2 || temporary.nlink !== 2) {
    fail("publication link did not produce one verified two-link inode");
  }
  return { state: "linked", recovered: false, target, temporary };
}

async function finalizePublication({ targetName, temporaryName, expectedSha256, expectedBytes, expectedTargetIdentity }) {
  let target = await readRecord(targetName);
  let temporary = await readRecord(temporaryName);
  assertArtifact(target, expectedSha256, expectedBytes, "target");
  if (!expectedTargetIdentity || target.identity !== expectedTargetIdentity) {
    fail("target identity changed before publication finalization");
  }
  if (temporary) {
    assertArtifact(temporary, expectedSha256, expectedBytes, "temporary file");
    if (temporary.identity !== target.identity || temporary.nlink !== 2 || target.nlink !== 2) {
      fail("temporary cleanup is not bound to the published target inode");
    }
    await unlink(temporaryName);
    await syncDirectory();
  } else if (target.nlink !== 1) {
    fail("finalized target has an unexpected link count");
  }
  target = await readRecord(targetName);
  temporary = await readRecord(temporaryName);
  assertArtifact(target, expectedSha256, expectedBytes, "target");
  if (target.identity !== expectedTargetIdentity || target.nlink !== 1 || temporary !== null) {
    fail("publication did not reach one durable target name");
  }
  return { state: "published", recovered: true, target, temporary: null };
}

async function main() {
  const [mode, expectedParentIdentity, targetArg, temporaryArg, expectedSha256, bytesArg, identityArg = "-"] = process.argv.slice(2);
  if (!['link', 'finalize'].includes(mode)) fail("mode must be link or finalize");
  if (!/^\d+:\d+$/.test(expectedParentIdentity ?? "")) fail("parent identity is invalid");
  const targetName = safeName(targetArg, "target name");
  const temporaryName = safeName(temporaryArg, "temporary name");
  if (targetName === temporaryName) fail("target and temporary names must differ");
  if (!SHA256.test(expectedSha256 ?? "")) fail("artifact digest is invalid");
  const expectedBytes = Number(bytesArg);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_ARTIFACT_BYTES) {
    fail("artifact byte count is invalid");
  }
  const expectedTargetIdentity = identityArg === "-" ? null : identityArg;
  if (expectedTargetIdentity !== null && !/^\d+:\d+$/.test(expectedTargetIdentity)) {
    fail("target identity is invalid");
  }
  const parentInfo = await lstat(".");
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || identity(parentInfo) !== expectedParentIdentity) {
    fail("process cwd is not the immutable destination parent");
  }
  const result = mode === "link"
    ? await linkPublication({ targetName, temporaryName, expectedSha256, expectedBytes, expectedTargetIdentity })
    : await finalizePublication({ targetName, temporaryName, expectedSha256, expectedBytes, expectedTargetIdentity });
  process.stdout.write(`${JSON.stringify({ ok: true, parentIdentity: expectedParentIdentity, ...result })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
