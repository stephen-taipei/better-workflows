import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
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

function assertPriorTarget(record, expectedIdentity, expectedSha256, expectedBytes) {
  if (expectedIdentity === null) {
    if (record !== null) fail("target appeared after the caller bound an absent destination");
    return;
  }
  if (!record || record.identity !== expectedIdentity || record.nlink !== 1) {
    fail("target identity changed before replacement");
  }
  if (record.sha256 !== expectedSha256 || record.size !== expectedBytes) {
    fail("target bytes changed before replacement");
  }
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

async function replacePublication({
  targetName,
  temporaryName,
  expectedSha256,
  expectedBytes,
  expectedPriorIdentity,
  expectedPriorSha256,
  expectedPriorBytes
}) {
  const bytes = await readInput(expectedBytes);
  if (digest(bytes) !== expectedSha256) fail("stdin digest does not match the immutable replacement binding");

  assertPriorTarget(
    await readRecord(targetName),
    expectedPriorIdentity,
    expectedPriorSha256,
    expectedPriorBytes
  );
  let temporary = await readRecord(temporaryName);
  if (temporary) {
    assertArtifact(temporary, expectedSha256, expectedBytes, "replacement temporary file");
    if (temporary.nlink !== 1) fail("replacement temporary file has an unexpected link count");
  } else {
    await createTemporary(temporaryName, bytes);
    temporary = await readRecord(temporaryName);
    assertArtifact(temporary, expectedSha256, expectedBytes, "replacement temporary file");
    if (temporary.nlink !== 1) fail("replacement temporary file has an unexpected link count");
  }
  assertPriorTarget(
    await readRecord(targetName),
    expectedPriorIdentity,
    expectedPriorSha256,
    expectedPriorBytes
  );
  await rename(temporaryName, targetName);
  await syncDirectory();
  const target = await readRecord(targetName);
  assertArtifact(target, expectedSha256, expectedBytes, "replacement target");
  if (target.nlink !== 1) fail("replacement target has an unexpected link count");
  return { state: "replaced", recovered: false, target, temporary: null };
}

async function createDirectory(name) {
  let created = false;
  try {
    await mkdir(name, { mode: 0o755 });
    created = true;
    await syncDirectory();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = await lstat(name);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("destination component is not a regular directory");
  }
  return {
    state: "directory-ready",
    recovered: !created,
    child: { identity: identity(info) }
  };
}

async function main() {
  const [
    mode,
    expectedParentIdentity,
    targetArg,
    temporaryArg,
    expectedSha256,
    bytesArg,
    identityArg = "-",
    priorSha256Arg = "-",
    priorBytesArg = "-"
  ] = process.argv.slice(2);
  if (!["link", "finalize", "replace", "mkdir"].includes(mode)) {
    fail("mode must be link, finalize, replace, or mkdir");
  }
  if (!/^\d+:\d+$/.test(expectedParentIdentity ?? "")) fail("parent identity is invalid");
  const targetName = safeName(targetArg, "target name");
  const parentInfo = await lstat(".");
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || identity(parentInfo) !== expectedParentIdentity) {
    fail("process cwd is not the immutable destination parent");
  }
  if (mode === "mkdir") {
    const result = await createDirectory(targetName);
    process.stdout.write(`${JSON.stringify({ ok: true, parentIdentity: expectedParentIdentity, ...result })}\n`);
    return;
  }
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
  let expectedPriorSha256 = null;
  let expectedPriorBytes = null;
  if (mode === "replace" && expectedTargetIdentity !== null) {
    if (!SHA256.test(priorSha256Arg)) fail("prior target digest is invalid");
    expectedPriorSha256 = priorSha256Arg;
    expectedPriorBytes = Number(priorBytesArg);
    if (!Number.isSafeInteger(expectedPriorBytes) || expectedPriorBytes < 0 || expectedPriorBytes > MAX_ARTIFACT_BYTES) {
      fail("prior target byte count is invalid");
    }
  } else if (mode === "replace" && (priorSha256Arg !== "-" || priorBytesArg !== "-")) {
    fail("absent replacement target must not declare prior bytes");
  }
  const result = mode === "link"
    ? await linkPublication({ targetName, temporaryName, expectedSha256, expectedBytes, expectedTargetIdentity })
    : mode === "finalize"
      ? await finalizePublication({ targetName, temporaryName, expectedSha256, expectedBytes, expectedTargetIdentity })
      : await replacePublication({
          targetName,
          temporaryName,
          expectedSha256,
          expectedBytes,
          expectedPriorIdentity: expectedTargetIdentity,
          expectedPriorSha256,
          expectedPriorBytes
        });
  process.stdout.write(`${JSON.stringify({ ok: true, parentIdentity: expectedParentIdentity, ...result })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
