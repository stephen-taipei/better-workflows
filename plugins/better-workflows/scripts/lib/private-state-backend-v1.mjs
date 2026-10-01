import path from "node:path";

const POSIX_PRIVATE_STATE_PLATFORMS = new Set([
  "aix",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos"
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = "HOLD";
  return error;
}

/**
 * Fail closed until the first-party Windows NTFS/DACL backend is installed.
 *
 * POSIX mode bits remain authoritative only on the existing POSIX platforms.
 * Windows must never inherit that interpretation: Node's `mode` projection is
 * not owner-only DACL, protected-inheritance, reparse, or file-identity proof.
 */
export function assertPrivateStateBackendAvailableV1() {
  const platform = process.platform;
  if (platform === "win32") {
    throw fail(
      "EWINDOWS_PRIVATE_STATE_BACKEND_UNAVAILABLE",
      "Windows private state requires the native NTFS/DACL backend"
    );
  }
  if (!POSIX_PRIVATE_STATE_PLATFORMS.has(platform)) {
    throw fail(
      "EPRIVATE_STATE_PLATFORM_UNSUPPORTED",
      `Private state is unsupported on platform ${platform}`
    );
  }
  return platform;
}

export function assertPrivateStatePathV1({
  root,
  target,
  info,
  label = "private state",
  kind = "file"
} = {}) {
  assertPrivateStateBackendAvailableV1();
  if (typeof root !== "string" || !path.isAbsolute(root) ||
      typeof target !== "string" || !path.isAbsolute(target)) {
    throw fail("EPRIVATE_STATE_PATH", `${label} root and target must be absolute paths`);
  }
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw fail("EPRIVATE_STATE_PATH", `${label} escapes its private-state root`);
  }
  if (!info || typeof info !== "object") {
    throw fail("EPRIVATE_STATE_METADATA", `${label} metadata is unavailable`);
  }
  if (kind === "file" && (!info.isFile?.() || info.nlink !== 1)) {
    throw fail("EPRIVATE_STATE_METADATA", `${label} must be a regular single-link file`);
  }
  if (kind === "directory" && !info.isDirectory?.()) {
    throw fail("EPRIVATE_STATE_METADATA", `${label} must be a directory`);
  }
  if (kind !== "file" && kind !== "directory") {
    throw fail("EPRIVATE_STATE_METADATA", `${label} has an unsupported path kind`);
  }
  if (!Number.isInteger(info.mode) || (info.mode & 0o077) !== 0) {
    throw fail("EPRIVATE_STATE_NOT_PRIVATE", `${label} must be owner-only`);
  }
  return true;
}
