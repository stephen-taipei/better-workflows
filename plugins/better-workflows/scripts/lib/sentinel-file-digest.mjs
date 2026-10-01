import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { lstat as lstatDefault, open as openDefault, readlink as readlinkDefault } from "node:fs/promises";

const HASH_CHUNK_BYTES = 64 * 1024;
const LFS_POINTER_PREFIX_BYTES = 128;
const STABLE_STAT_FIELDS = ["dev", "ino", "mode", "nlink", "size", "mtimeMs", "ctimeMs"];
const DIRECTORY_IDENTITY_FIELDS = ["dev", "ino", "mode"];

function sameFileState(left, right) {
  return Boolean(left && right) && STABLE_STAT_FIELDS.every((field) =>
    Number.isFinite(left[field]) && left[field] === right[field]
  );
}

function sameDirectoryIdentity(left, right) {
  return Boolean(left && right) && DIRECTORY_IDENTITY_FIELDS.every((field) =>
    Number.isFinite(left[field]) && left[field] === right[field]
  );
}

function changedFileError() {
  const error = new Error("Sentinel file changed while it was being hashed");
  error.code = "ESENTINEL_DRIFT";
  return error;
}

function isPathRaceError(error) {
  return ["ENOENT", "ENOTDIR", "ELOOP", "EISDIR"].includes(error?.code);
}

async function parentDirectoryStates(target, rootDirectory, lstatImpl, expected = undefined) {
  if (rootDirectory === undefined || rootDirectory === null) return [];

  const root = path.resolve(rootDirectory);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(root, absoluteTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw changedFileError();
  }
  const parentRelative = path.dirname(relative);
  const components = parentRelative === "." ? [] : parentRelative.split(path.sep);
  const states = [];
  let current = root;
  let rootState;
  try {
    rootState = await lstatImpl(root);
  } catch (error) {
    if (error?.code === "ENOENT" && expected === undefined) return null;
    if (isPathRaceError(error)) throw changedFileError();
    throw error;
  }
  if (rootState.isSymbolicLink() || !rootState.isDirectory() ||
      (expected !== undefined && (!expected[0] || !sameDirectoryIdentity(expected[0], rootState)))) {
    throw changedFileError();
  }
  states.push(rootState);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let state;
    try {
      state = await lstatImpl(current);
    } catch (error) {
      if (error?.code === "ENOENT" && expected === undefined) return null;
      if (isPathRaceError(error)) throw changedFileError();
      throw error;
    }
    if (state.isSymbolicLink() || !state.isDirectory() ||
        (expected !== undefined && (!expected[index + 1] || !sameDirectoryIdentity(expected[index + 1], state)))) {
      throw changedFileError();
    }
    states.push(state);
  }
  if (expected !== undefined && expected.length !== states.length) throw changedFileError();
  return states;
}

export async function digestSentinelFile(target, maxBytes, {
  lstatImpl = lstatDefault,
  openImpl = openDefault,
  readlinkImpl = readlinkDefault,
  rootDirectory
} = {}) {
  const beforeParents = await parentDirectoryStates(target, rootDirectory, lstatImpl);
  if (beforeParents === null) return { type: "missing", bytesHashed: 0 };

  let beforePath;
  try {
    beforePath = await lstatImpl(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      await parentDirectoryStates(target, rootDirectory, lstatImpl, beforeParents);
      return { type: "missing", bytesHashed: 0 };
    }
    throw error;
  }

  if (beforePath.isSymbolicLink()) {
    let targetText;
    try {
      targetText = await readlinkImpl(target);
      const afterPath = await lstatImpl(target);
      await parentDirectoryStates(target, rootDirectory, lstatImpl, beforeParents);
      if (!afterPath.isSymbolicLink() || !sameFileState(beforePath, afterPath)) {
        throw changedFileError();
      }
    } catch (error) {
      if (isPathRaceError(error)) throw changedFileError();
      throw error;
    }
    return { type: "symlink", target: targetText, size: beforePath.size, bytesHashed: 0 };
  }
  if (!beforePath.isFile()) {
    await parentDirectoryStates(target, rootDirectory, lstatImpl, beforeParents);
    return { type: "other", size: beforePath.size, bytesHashed: 0 };
  }
  if (beforePath.size > maxBytes) {
    await parentDirectoryStates(target, rootDirectory, lstatImpl, beforeParents);
    return {
      type: "file",
      size: beforePath.size,
      mtimeMs: Math.trunc(beforePath.mtimeMs),
      skipped: "single-file-budget",
      bytesHashed: 0
    };
  }

  let handle;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    await parentDirectoryStates(target, rootDirectory, lstatImpl, beforeParents);
    handle = await openImpl(target, flags);
    const beforeHandle = await handle.stat();
    if (!beforeHandle.isFile() || !sameFileState(beforePath, beforeHandle)) {
      throw changedFileError();
    }

    const hash = createHash("sha256");
    const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
    const prefix = Buffer.alloc(LFS_POINTER_PREFIX_BYTES);
    let prefixBytes = 0;
    let bytesHashed = 0;
    while (true) {
      const remaining = beforePath.size - bytesHashed;
      const requested = remaining === 0 ? 1 : Math.min(buffer.length, remaining);
      const { bytesRead } = await handle.read(buffer, 0, requested, bytesHashed);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > requested) {
        throw changedFileError();
      }
      if (bytesRead === 0) {
        if (bytesHashed !== beforePath.size) throw changedFileError();
        break;
      }
      if (bytesHashed === beforePath.size) throw changedFileError();
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      const prefixLength = Math.min(prefix.length - prefixBytes, bytesRead);
      if (prefixLength > 0) {
        chunk.copy(prefix, prefixBytes, 0, prefixLength);
        prefixBytes += prefixLength;
      }
      bytesHashed += bytesRead;
    }

    const afterHandle = await handle.stat();
    let afterPath;
    try {
      afterPath = await lstatImpl(target);
    } catch (error) {
      if (isPathRaceError(error)) throw changedFileError();
      throw error;
    }
    await parentDirectoryStates(target, rootDirectory, lstatImpl, beforeParents);
    if (afterPath.isSymbolicLink() || !afterPath.isFile() ||
        !sameFileState(beforePath, afterPath) ||
        !sameFileState(beforeHandle, afterHandle)) {
      throw changedFileError();
    }

    return {
      type: "file",
      size: beforePath.size,
      digest: hash.digest("hex"),
      lfsPointer: prefix.subarray(0, prefixBytes)
        .toString("utf8")
        .startsWith("version https://git-lfs.github.com/spec/v1"),
      bytesHashed
    };
  } catch (error) {
    if (isPathRaceError(error)) throw changedFileError();
    throw error;
  } finally {
    await handle?.close();
  }
}
