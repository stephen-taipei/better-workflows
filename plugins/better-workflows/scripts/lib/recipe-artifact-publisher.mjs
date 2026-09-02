import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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

async function syncNamedDirectory(name) {
  const handle = await open(name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || info.isSymbolicLink()) fail("quarantine is not a regular directory");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function testBoundary(name) {
  const root = process.env.SBW_RECIPE_PUBLISHER_TEST_ROOT;
  if (!root) return;
  if (!path.isAbsolute(root)) fail("test boundary root must be absolute");
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("test boundary root is unsafe");
  const ready = path.join(root, `${name}.ready`);
  const proceed = path.join(root, `${name}.continue`);
  const handle = await open(ready, "wx", 0o600);
  await handle.close();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const proceedInfo = await lstat(proceed);
      if (!proceedInfo.isFile() || proceedInfo.isSymbolicLink()) fail("test boundary continuation is unsafe");
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(5);
  }
  fail(`test boundary timed out: ${name}`);
}

async function createDiscardQuarantine() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const name = `.sbw-discard-quarantine-${randomBytes(24).toString("hex")}`;
    try {
      await mkdir(name, { mode: 0o700 });
      await syncDirectory();
      return { name, artifact: path.join(name, "artifact") };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  fail("could not allocate an exclusive discard quarantine");
}

function sameRecord(actual, expected) {
  return Boolean(
    actual && expected &&
    actual.identity === expected.identity &&
    actual.nlink === expected.nlink &&
    actual.size === expected.size &&
    actual.sha256 === expected.sha256
  );
}

async function quarantineBoundName(name, expected, boundary) {
  const quarantine = await createDiscardQuarantine();
  await testBoundary(`before-${boundary}-quarantine-rename`);
  await rename(name, quarantine.artifact);
  await syncDirectory();
  await syncNamedDirectory(quarantine.name);
  const quarantined = await readRecord(quarantine.artifact);
  if (!sameRecord(quarantined, expected)) {
    fail(`${boundary} identity changed at the quarantine boundary`);
  }
  return quarantine;
}

async function unlinkBoundQuarantine(quarantine, expected, boundary, beforeUnlink = null) {
  await testBoundary(`before-${boundary}-quarantine-unlink`);
  await beforeUnlink?.();
  const quarantined = await readRecord(quarantine.artifact);
  if (!sameRecord(quarantined, expected)) {
    fail(`${boundary} quarantine identity changed at the destructive boundary`);
  }
  await unlink(quarantine.artifact);
  await syncNamedDirectory(quarantine.name);
  if (await readRecord(quarantine.artifact)) {
    fail(`${boundary} quarantine did not reach a durable absence`);
  }
  await rmdir(quarantine.name);
  await syncDirectory();
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
      const quarantine = await quarantineBoundName(
        temporaryName,
        temporary,
        "orphaned-temporary"
      );
      await unlinkBoundQuarantine(quarantine, temporary, "orphaned-temporary", async () => {
        if (await readRecord(temporaryName)) {
          fail("orphaned temporary name was recreated during quarantine");
        }
      });
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
    const quarantine = await quarantineBoundName(
      temporaryName,
      temporary,
      "publication-finalize"
    );
    await unlinkBoundQuarantine(quarantine, temporary, "publication-finalize", async () => {
      const currentTarget = await readRecord(targetName);
      const currentTemporary = await readRecord(temporaryName);
      if (
        !currentTarget || currentTarget.identity !== expectedTargetIdentity ||
        currentTarget.sha256 !== expectedSha256 || currentTarget.size !== expectedBytes ||
        currentTarget.nlink !== 2 || currentTemporary !== null
      ) {
        fail("publication target changed at the temporary destructive boundary");
      }
    });
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
  const priorTarget = await readRecord(targetName);
  assertPriorTarget(
    priorTarget,
    expectedPriorIdentity,
    expectedPriorSha256,
    expectedPriorBytes
  );
  let priorQuarantine = null;
  if (priorTarget) {
    priorQuarantine = await quarantineBoundName(targetName, priorTarget, "replacement-prior-target");
    if (await readRecord(targetName)) {
      fail("replacement target name was recreated during prior-target quarantine");
    }
  } else if (await readRecord(targetName)) {
    fail("target appeared after the caller bound an absent destination");
  }
  await testBoundary("before-replacement-target-link");
  temporary = await readRecord(temporaryName);
  assertArtifact(temporary, expectedSha256, expectedBytes, "replacement temporary file");
  if (temporary.nlink !== 1) fail("replacement temporary file changed before target publication");
  if (await readRecord(targetName)) {
    fail("replacement target appeared at the no-overwrite publication boundary");
  }
  await link(temporaryName, targetName);
  await syncDirectory();
  let target = await readRecord(targetName);
  temporary = await readRecord(temporaryName);
  assertArtifact(target, expectedSha256, expectedBytes, "replacement target");
  if (
    !temporary || target.identity !== temporary.identity ||
    target.nlink !== 2 || temporary.nlink !== 2
  ) {
    fail("replacement publication did not produce one verified two-link inode");
  }
  const temporaryQuarantine = await quarantineBoundName(
    temporaryName,
    temporary,
    "replacement-temporary"
  );
  await unlinkBoundQuarantine(temporaryQuarantine, temporary, "replacement-temporary", async () => {
    const currentTarget = await readRecord(targetName);
    if (
      !currentTarget || currentTarget.identity !== target.identity || currentTarget.nlink !== 2 ||
      currentTarget.sha256 !== expectedSha256 || currentTarget.size !== expectedBytes ||
      await readRecord(temporaryName)
    ) {
      fail("replacement target changed at the temporary destructive boundary");
    }
  });
  target = await readRecord(targetName);
  assertArtifact(target, expectedSha256, expectedBytes, "replacement target");
  if (target.nlink !== 1) fail("replacement target has an unexpected link count");
  if (priorQuarantine) {
    await unlinkBoundQuarantine(
      priorQuarantine,
      priorTarget,
      "replacement-prior-target",
      async () => {
        const currentTarget = await readRecord(targetName);
        if (!sameRecord(currentTarget, target)) {
          fail("replacement target changed at the prior-target destructive boundary");
        }
      }
    );
  }
  return { state: "replaced", recovered: false, target, temporary: null };
}

async function discardReplacementTemporary({
  targetName,
  temporaryName,
  expectedTemporarySha256,
  expectedTemporaryBytes,
  expectedPriorIdentity,
  expectedPriorSha256,
  expectedPriorBytes
}) {
  assertPriorTarget(
    await readRecord(targetName),
    expectedPriorIdentity,
    expectedPriorSha256,
    expectedPriorBytes
  );
  const temporary = await readRecord(temporaryName);
  assertArtifact(
    temporary,
    expectedTemporarySha256,
    expectedTemporaryBytes,
    "replacement temporary file"
  );
  if (temporary.nlink !== 1) fail("replacement temporary file has an unexpected link count");
  const quarantine = await quarantineBoundName(temporaryName, temporary, "discard");
  let target = await readRecord(targetName);
  assertPriorTarget(target, expectedPriorIdentity, expectedPriorSha256, expectedPriorBytes);
  if (await readRecord(temporaryName)) fail("replacement temporary name was recreated during quarantine");
  await unlinkBoundQuarantine(quarantine, temporary, "discard", async () => {
    target = await readRecord(targetName);
    assertPriorTarget(target, expectedPriorIdentity, expectedPriorSha256, expectedPriorBytes);
    if (await readRecord(temporaryName)) {
      fail("replacement temporary name was recreated at the destructive boundary");
    }
  });
  target = await readRecord(targetName);
  assertPriorTarget(target, expectedPriorIdentity, expectedPriorSha256, expectedPriorBytes);
  if (await readRecord(temporaryName)) fail("replacement temporary cleanup did not reach a durable absence");
  return { state: "discarded", recovered: true, target, temporary: null };
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
    priorBytesArg = "-",
    publisherDigestArg
  ] = process.argv.slice(2);
  if (!["link", "finalize", "replace", "discard", "mkdir"].includes(mode)) {
    fail("mode must be link, finalize, replace, discard, or mkdir");
  }
  if (!/^\d+:\d+$/.test(expectedParentIdentity ?? "")) fail("parent identity is invalid");
  if (!SHA256.test(publisherDigestArg ?? "")) fail("publisher digest is invalid");
  const targetName = safeName(targetArg, "target name");
  const parentInfo = await lstat(".");
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || identity(parentInfo) !== expectedParentIdentity) {
    fail("process cwd is not the immutable destination parent");
  }
  if (mode === "mkdir") {
    const result = await createDirectory(targetName);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      parentIdentity: expectedParentIdentity,
      publisherDigest: publisherDigestArg,
      ...result
    })}\n`);
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
  if (mode === "discard" && expectedTargetIdentity === null) {
    fail("replacement temporary discard requires a prior target identity");
  }
  let expectedPriorSha256 = null;
  let expectedPriorBytes = null;
  if (["replace", "discard"].includes(mode) && expectedTargetIdentity !== null) {
    if (!SHA256.test(priorSha256Arg)) fail("prior target digest is invalid");
    expectedPriorSha256 = priorSha256Arg;
    expectedPriorBytes = Number(priorBytesArg);
    if (!Number.isSafeInteger(expectedPriorBytes) || expectedPriorBytes < 0 || expectedPriorBytes > MAX_ARTIFACT_BYTES) {
      fail("prior target byte count is invalid");
    }
  } else if (["replace", "discard"].includes(mode) && (priorSha256Arg !== "-" || priorBytesArg !== "-")) {
    fail("absent replacement target must not declare prior bytes");
  }
  const result = mode === "link"
    ? await linkPublication({ targetName, temporaryName, expectedSha256, expectedBytes, expectedTargetIdentity })
    : mode === "finalize"
      ? await finalizePublication({ targetName, temporaryName, expectedSha256, expectedBytes, expectedTargetIdentity })
      : mode === "discard"
        ? await discardReplacementTemporary({
            targetName,
            temporaryName,
            expectedTemporarySha256: expectedSha256,
            expectedTemporaryBytes: expectedBytes,
            expectedPriorIdentity: expectedTargetIdentity,
            expectedPriorSha256,
            expectedPriorBytes
          })
        : await replacePublication({
          targetName,
          temporaryName,
          expectedSha256,
          expectedBytes,
          expectedPriorIdentity: expectedTargetIdentity,
          expectedPriorSha256,
          expectedPriorBytes
        });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    parentIdentity: expectedParentIdentity,
    publisherDigest: publisherDigestArg,
    ...result
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
