import { constants as fsConstants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  realpath,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { canonicalSourceRoot, captureSourceBinding, hiddenIndexEntries, runSourceGit } from "./git.mjs";

const execFileAsync = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, options, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
      return;
    }
    resolve({ stdout, stderr });
  });
});

function sha256(value) {
  const hash = createHash("sha256");
  hash.update(Buffer.isBuffer(value) ? value : String(value));
  return hash.digest("hex");
}

function normalizeBundleMode(mode) {
  // Git tracks only the executable bit. `git archive` and tar extraction may
  // materialize the other permission bits differently from a checkout, so
  // compare the canonical Git modes rather than host-specific file modes.
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}

function digestObject(value) {
  return sha256(JSON.stringify(value));
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function repositoryRootForSource(root) {
  const resolvedSource = await realpath(path.resolve(root));
  const expectedRoot = await canonicalSourceRoot(resolvedSource);
  const reportedRoot = await realpath((await runSourceGit(resolvedSource, ["rev-parse", "--show-toplevel"])).stdout.trim());
  if (reportedRoot !== expectedRoot) {
    throw new Error("Git reported a worktree root different from the canonical source root");
  }
  return expectedRoot;
}

async function assertDirectoryNotSymlink(target) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Unsafe cache directory: ${target}`);
  }
}

async function captureCacheRootIdentity(target) {
  const lexicalPath = path.resolve(target);
  let resolved;
  try {
    resolved = await realpath(lexicalPath);
  } catch (error) {
    throw new Error(`Unsafe cache directory: ${lexicalPath} (${error.message})`);
  }
  const chain = [];
  let cursor = lexicalPath;
  while (true) {
    const info = await lstat(cursor);
    const isRoot = cursor === lexicalPath;
    if (isRoot && (!info.isDirectory() || info.isSymbolicLink())) {
      throw new Error(`Unsafe cache directory: ${cursor}`);
    }
    if (isRoot && (
      info.uid !== (process.getuid?.() ?? info.uid) ||
      ((info.mode & 0o777) & 0o022) !== 0
    )) {
      throw new Error(`Unsafe cache directory ownership or mode: ${cursor}`);
    }
    chain.push({
      path: cursor,
      device: Number.isSafeInteger(info.dev) ? info.dev : null,
      inode: Number.isSafeInteger(info.ino) ? info.ino : null,
      type: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : "other",
      resolvedPath: await realpath(cursor)
    });
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return {
    // Keep the caller's lexical spelling for all mutations and hook payloads;
    // the full lexical chain (including stable system symlink ancestors such
    // as macOS `/var`) is bound below so replacement cannot redirect it.
    path: lexicalPath,
    realpath: resolved,
    chain
  };
}

async function assertStableCacheRoot(target, expected = null) {
  let current;
  try {
    current = await captureCacheRootIdentity(target);
  } catch (error) {
    if (expected) {
      throw new Error(`Plugin cache root identity changed: ${error.message}`);
    }
    throw error;
  }
  if (expected && (
    current.path !== expected.path ||
    current.realpath !== expected.realpath ||
    JSON.stringify(current.chain) !== JSON.stringify(expected.chain)
  )) {
    throw new Error(`Plugin cache root identity changed: ${current.path}`);
  }
  return current;
}

const PINNED_DIRECTORY_ROOT = process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";

// macOS exposes a directory descriptor as `/dev/fd/N`, but does not permit
// pathname traversal below that pseudo-entry. Keep the same descriptor-bound
// openat/unlinkat/renameat semantics on both macOS and Linux through the
// system Python runtime, inheriting the already-open root directory as fd 3.
// The helper accepts only relative names derived by cacheEntryRelative below;
// it never receives a caller-controlled absolute path.
const PINNED_FS_PYTHON = String.raw`
import base64, ctypes, hashlib, io, json, os, stat, struct, sys, tarfile

fd = 3

def open_directory(parent, name):
    return os.open(name, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent)

def split_relative(path):
    if not isinstance(path, str) or path.startswith("/"):
        raise ValueError("pinned path must be relative")
    parts = [part for part in path.split("/") if part and part != "."]
    if any(part == ".." for part in parts):
        raise ValueError("pinned path escapes the cache root")
    return parts

def open_parent(path):
    parts = split_relative(path)
    if not parts:
        return os.dup(fd), "."
    current = os.dup(fd)
    try:
        for component in parts[:-1]:
            next_fd = open_directory(current, component)
            os.close(current)
            current = next_fd
        return current, parts[-1]
    except Exception:
        os.close(current)
        raise

def open_relative_directory(path):
    parts = split_relative(path)
    current = os.dup(fd)
    try:
        for component in parts:
            next_fd = open_directory(current, component)
            os.close(current)
            current = next_fd
        return current
    except Exception:
        os.close(current)
        raise

def mkdir_tree(path, mode, recursive):
    parts = split_relative(path)
    if not recursive:
        parent, name = open_parent(path)
        try:
            os.mkdir(name, mode=mode, dir_fd=parent)
        finally:
            os.close(parent)
        return
    current = fd
    try:
        for component in parts:
            try:
                os.mkdir(component, mode=mode, dir_fd=current)
            except FileExistsError:
                pass
            next_fd = open_directory(current, component)
            if current != fd:
                os.close(current)
            current = next_fd
    finally:
        if current != fd:
            os.close(current)

def remove_at(parent, name):
    info = os.lstat(name, dir_fd=parent)
    if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
        child = open_directory(parent, name)
        try:
            for nested in os.listdir(child):
                remove_at(child, nested)
        finally:
            os.close(child)
        os.rmdir(name, dir_fd=parent)
    else:
        os.unlink(name, dir_fd=parent)

def safe_member_name(name):
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or normalized == ".." or normalized.startswith("../") or "/../" in normalized:
        raise ValueError("archive member escapes the pinned root")
    return normalized.rstrip("/")

def extract_archive(destination, encoded):
    archive = tarfile.open(fileobj=io.BytesIO(base64.b64decode(encoded)), mode="r:")
    try:
        for member in archive:
            member_name = safe_member_name(member.name)
            if not member_name:
                continue
            name = safe_member_name(destination.rstrip("/") + "/" + member_name)
            if member.isdir():
                mkdir_tree(name, 0o700, True)
                continue
            if not member.isfile():
                raise ValueError("archive contains a non-regular member")
            parent = os.path.dirname(name)
            if parent:
                mkdir_tree(parent, 0o700, True)
            parent_fd, leaf = open_parent(name)
            handle = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=parent_fd)
            try:
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError("archive member has no file data")
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    offset = 0
                    while offset < len(chunk):
                        offset += os.write(handle, chunk[offset:])
                os.fchmod(handle, 0o755 if (member.mode & 0o111) else 0o644)
            finally:
                os.close(handle)
                os.close(parent_fd)
    finally:
        archive.close()

def linux_birthtime_ns(parent, leaf):
    if sys.platform != "linux":
        return None
    syscall_numbers = {
        "x86_64": 332,
        "aarch64": 291,
        "armv7l": 397,
        "ppc64": 383,
        "ppc64le": 383,
        "s390x": 379,
        "riscv64": 291,
    }
    syscall_number = syscall_numbers.get(os.uname().machine)
    if syscall_number is None:
        return None
    buffer = ctypes.create_string_buffer(256)
    result = ctypes.CDLL(None, use_errno=True).syscall(
        ctypes.c_long(syscall_number),
        ctypes.c_int(parent),
        ctypes.c_char_p(os.fsencode(leaf)),
        ctypes.c_int(0x100),
        ctypes.c_uint(0x800),
        ctypes.byref(buffer)
    )
    if result != 0:
        return None
    raw = buffer.raw
    if struct.unpack_from("<I", raw, 0)[0] & 0x800 == 0:
        return None
    seconds = struct.unpack_from("<q", raw, 80)[0]
    nanoseconds = struct.unpack_from("<I", raw, 88)[0]
    return seconds * 1_000_000_000 + nanoseconds

def birthtime_ns(parent, leaf, info):
    value = getattr(info, "st_birthtime_ns", None)
    if value is not None:
        return int(value)
    value = getattr(info, "st_birthtime", None)
    if value is not None:
        return int(round(value * 1_000_000_000))
    return linux_birthtime_ns(parent, leaf)

def stat_record(path):
    parent, leaf = open_parent(path)
    try:
        info = os.lstat(leaf, dir_fd=parent)
        birthtime = birthtime_ns(parent, leaf, info)
    finally:
        os.close(parent)
    kind = "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "symlink" if stat.S_ISLNK(info.st_mode) else "other"
    return {"type": kind, "mode": info.st_mode, "size": info.st_size, "nlink": info.st_nlink, "uid": info.st_uid, "gid": info.st_gid, "dev": info.st_dev, "ino": info.st_ino, "birthtime": birthtime}

def identity_matches(info, expected, allow_directory_metadata_change=False, current_birthtime=None):
    if not isinstance(expected, dict):
        return False
    kind = "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "symlink" if stat.S_ISLNK(info.st_mode) else "other"
    if (
        expected.get("type") != kind or
        str(expected.get("dev")) != str(info.st_dev) or
        str(expected.get("ino")) != str(info.st_ino)
    ):
        return False
    if allow_directory_metadata_change and kind == "directory":
        expected_birthtime = expected.get("birthtime")
        if expected_birthtime is not None:
            return current_birthtime is not None and abs(int(expected_birthtime) - int(current_birthtime)) <= 1_000
    return (
        str(expected.get("nlink")) == str(info.st_nlink) and
        str(expected.get("size")) == str(info.st_size)
    )

def guarded_failure(message):
    raise OSError(11, message)

def write_guarded(temporary, target, guard, expected, mode, encoded):
    temporary_parent, temporary_leaf = open_parent(temporary)
    target_parent, target_leaf = open_parent(target)
    guard_parent, guard_leaf = open_parent(guard)
    created = False
    renamed = False
    data_digest = None
    try:
        handle = os.open(temporary_leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), int(mode), dir_fd=temporary_parent)
        created = True
        try:
            data = base64.b64decode(encoded)
            data_digest = hashlib.sha256(data).hexdigest()
            offset = 0
            while offset < len(data):
                offset += os.write(handle, data[offset:])
            os.fsync(handle)
        finally:
            os.close(handle)
        guard_info = os.lstat(guard_leaf, dir_fd=guard_parent)
        if not identity_matches(guard_info, expected):
            guarded_failure("guard identity changed")
        os.rename(temporary_leaf, target_leaf, src_dir_fd=temporary_parent, dst_dir_fd=target_parent)
        renamed = True
        final_guard_info = os.lstat(guard_leaf, dir_fd=guard_parent)
        if not identity_matches(final_guard_info, expected):
            try:
                marker_handle = os.open(target_leaf, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=target_parent)
                try:
                    marker_data = b""
                    while True:
                        chunk = os.read(marker_handle, 1024 * 1024)
                        if not chunk:
                            break
                        marker_data += chunk
                finally:
                    os.close(marker_handle)
                if hashlib.sha256(marker_data).hexdigest() == data_digest:
                    os.unlink(target_leaf, dir_fd=target_parent)
            except FileNotFoundError:
                pass
            guarded_failure("guard identity changed after marker commit")
        return None
    finally:
        if created and not renamed:
            try:
                os.unlink(temporary_leaf, dir_fd=temporary_parent)
            except FileNotFoundError:
                pass
        os.close(temporary_parent)
        os.close(target_parent)
        os.close(guard_parent)

def remove_if_match(path, release, expected, content_digest, allow_directory_metadata_change=False):
    path_parent, path_leaf = open_parent(path)
    release_parent, release_leaf = open_parent(release)
    try:
        info = os.lstat(path_leaf, dir_fd=path_parent)
        current_birthtime = birthtime_ns(path_parent, path_leaf, info) if allow_directory_metadata_change else None
        if not identity_matches(info, expected, allow_directory_metadata_change, current_birthtime):
            guarded_failure("tree identity changed")
        if stat.S_ISREG(info.st_mode) and content_digest:
            handle = os.open(path_leaf, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=path_parent)
            try:
                contents = b""
                while True:
                    chunk = os.read(handle, 1024 * 1024)
                    if not chunk:
                        break
                    contents += chunk
            finally:
                os.close(handle)
            if hashlib.sha256(contents).hexdigest() != content_digest:
                guarded_failure("file content identity changed")
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            if not stat.S_ISREG(info.st_mode):
                guarded_failure("guarded removal requires a regular directory or file")
        os.rename(path_leaf, release_leaf, src_dir_fd=path_parent, dst_dir_fd=release_parent)
        moved = os.lstat(release_leaf, dir_fd=release_parent)
        moved_birthtime = birthtime_ns(release_parent, release_leaf, moved) if allow_directory_metadata_change else None
        if not identity_matches(moved, expected, allow_directory_metadata_change, moved_birthtime):
            guarded_failure("moved identity changed")
        if stat.S_ISREG(moved.st_mode) and content_digest:
            handle = os.open(release_leaf, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=release_parent)
            try:
                contents = b""
                while True:
                    chunk = os.read(handle, 1024 * 1024)
                    if not chunk:
                        break
                    contents += chunk
            finally:
                os.close(handle)
            if hashlib.sha256(contents).hexdigest() != content_digest:
                guarded_failure("moved file content identity changed")
        remove_at(release_parent, release_leaf)
    finally:
        os.close(path_parent)
        os.close(release_parent)

def perform(command, arguments):
    if command == "stat":
        return stat_record(arguments[0])
    if command == "read":
        parent, leaf = open_parent(arguments[0])
        handle = os.open(leaf, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent)
        try:
            chunks = []
            while True:
                chunk = os.read(handle, 1024 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
        finally:
            os.close(handle)
            os.close(parent)
        return base64.b64encode(b"".join(chunks)).decode("ascii")
    if command == "list":
        handle = open_relative_directory(arguments[0])
        try:
            return sorted(os.listdir(handle))
        finally:
            os.close(handle)
    if command == "mkdir":
        mkdir_tree(arguments[0], int(arguments[1]), bool(arguments[2]))
        return None
    if command == "write":
        flags = os.O_WRONLY | os.O_CREAT
        if arguments[2] == "wx":
            flags |= os.O_EXCL
        else:
            flags |= os.O_TRUNC
        parent, leaf = open_parent(arguments[0])
        handle = os.open(leaf, flags | getattr(os, "O_NOFOLLOW", 0), int(arguments[1]), dir_fd=parent)
        try:
            data = base64.b64decode(arguments[3])
            offset = 0
            while offset < len(data):
                offset += os.write(handle, data[offset:])
            os.fsync(handle)
        finally:
            os.close(handle)
            os.close(parent)
        return None
    if command == "rename":
        source_parent, source_leaf = open_parent(arguments[0])
        target_parent, target_leaf = open_parent(arguments[1])
        try:
            os.rename(source_leaf, target_leaf, src_dir_fd=source_parent, dst_dir_fd=target_parent)
        finally:
            os.close(source_parent)
            os.close(target_parent)
        return None
    if command == "unlink":
        parent, leaf = open_parent(arguments[0])
        try:
            os.unlink(leaf, dir_fd=parent)
        finally:
            os.close(parent)
        return None
    if command == "remove":
        parent, leaf = open_parent(arguments[0])
        try:
            remove_at(parent, leaf)
        except FileNotFoundError:
            if not bool(arguments[1]):
                os.close(parent)
                raise
        os.close(parent)
        return None
    if command == "remove_if_match":
        remove_if_match(
            arguments[0],
            arguments[1],
            json.loads(arguments[2]),
            arguments[3],
            bool(arguments[4]) if len(arguments) > 4 else False
        )
        return None
    if command == "write_guarded":
        write_guarded(arguments[0], arguments[1], arguments[2], json.loads(arguments[3]), int(arguments[4]), arguments[5])
        return None
    if command == "extract":
        extract_archive(arguments[0], arguments[1])
        return None
    raise ValueError("unsupported pinned filesystem operation")

def error_payload(error):
    return {"ok": False, "errno": getattr(error, "errno", 1), "message": getattr(error, "strerror", str(error))}

if len(sys.argv) > 1 and sys.argv[1] == "--server":
    for line in sys.stdin:
        try:
            payload = json.loads(line)
            result = perform(payload["command"], payload["args"])
            print(json.dumps({"ok": True, "result": result}, separators=(",", ":")), flush=True)
        except Exception as error:
            print(json.dumps(error_payload(error), separators=(",", ":")), flush=True)
else:
    try:
        result = perform(sys.argv[1], json.loads(sys.argv[2]))
        if result is not None:
            print(result if isinstance(result, str) else json.dumps(result, separators=(",", ":")))
    except Exception as error:
        print(f"SBW_ERRNO:{getattr(error, 'errno', 1)}:{getattr(error, 'strerror', str(error))}", file=sys.stderr)
        raise SystemExit(1)
`;

function pinnedStatRecord(value) {
  return {
    ...value,
    isDirectory: () => value.type === "directory",
    isFile: () => value.type === "file",
    isSymbolicLink: () => value.type === "symlink"
  };
}

function pinnedError(stderr) {
  const match = String(stderr).match(/SBW_ERRNO:(\d+):/);
  const error = new Error(String(stderr).trim() || "Pinned filesystem operation failed");
  const codes = { 2: "ENOENT", 11: "EAGAIN", 13: "EACCES", 17: "EEXIST", 18: "EXDEV", 20: "ENOTDIR", 22: "EINVAL", 28: "ENOSPC", 39: "ENOTEMPTY", 40: "ELOOP" };
  if (match) error.code = codes[Number(match[1])] ?? `ERRNO_${match[1]}`;
  return error;
}

function createPinnedPythonRunner(fd) {
  const child = spawn("/usr/bin/python3", ["-c", PINNED_FS_PYTHON, "--server"], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    stdio: ["pipe", "pipe", "pipe", fd]
  });
  const pending = [];
  let output = "";
  let stderr = "";
  let terminalError = null;
  let closing = false;
  let closeResolve;
  const closed = new Promise((resolve) => { closeResolve = resolve; });
  const rejectPending = (error) => {
    while (pending.length > 0) pending.shift().reject(error);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    for (;;) {
      const newline = output.indexOf("\n");
      if (newline < 0) break;
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      if (!line) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (error) {
        terminalError = error;
        rejectPending(error);
        continue;
      }
      const task = pending.shift();
      if (!task) continue;
      if (!payload.ok) {
        const error = new Error(payload.message || "Pinned filesystem operation failed");
        const codes = { 2: "ENOENT", 11: "EAGAIN", 13: "EACCES", 17: "EEXIST", 18: "EXDEV", 20: "ENOTDIR", 22: "EINVAL", 28: "ENOSPC", 39: "ENOTEMPTY", 40: "ELOOP" };
        error.code = codes[payload.errno] ?? `ERRNO_${payload.errno}`;
        error.message = `${error.message} (pinned ${task.command}${task.command === "extract" ? "" : `:${String(task.args[0] ?? "")}`})`;
        task.reject(error);
      } else {
        task.resolve(payload.result);
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", (error) => {
    terminalError ||= error;
    rejectPending(terminalError);
  });
  child.once("error", (error) => {
    terminalError = error;
    rejectPending(error);
  });
  child.once("close", (code) => {
    if (code !== 0 && !terminalError) {
      terminalError = pinnedError(stderr || `Pinned filesystem helper exited with ${code}`);
    }
    if (terminalError) rejectPending(terminalError);
    closeResolve();
  });
  return {
    run(command, args) {
      if (terminalError) return Promise.reject(terminalError);
      if (closing || child.stdin.destroyed || !child.stdin.writable) {
        return Promise.reject(new Error("Pinned filesystem helper stdin is unavailable"));
      }
      return new Promise((resolve, reject) => {
        pending.push({ command, args, resolve, reject });
        try {
          child.stdin.write(`${JSON.stringify({ command, args })}\n`);
        } catch (error) {
          terminalError ||= error;
          rejectPending(terminalError);
        }
      });
    },
    async close() {
      if (closing) return closed;
      closing = true;
      try { child.stdin.end(); } catch (error) {
        terminalError ||= error;
        rejectPending(terminalError);
      }
      await closed;
    }
  };
}

function cacheEntryRelative(cacheRoot, target) {
  const relative = path.relative(cacheRoot, path.resolve(target));
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Cache operation escapes pinned root: ${target}`);
  }
  return relative || ".";
}

/**
 * Pin the cache directory itself for a security-sensitive operation. A later
 * replacement of the root or any ancestor cannot redirect paths rooted at the
 * descriptor-backed `/dev/fd/<fd>` (or `/proc/self/fd/<fd>`) namespace.
 */
async function withPinnedCacheRoot(cacheRoot, cacheRootIdentity, operation) {
  const stable = await assertStableCacheRoot(cacheRoot, cacheRootIdentity);
  const handle = await open(
    stable.path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0)
  );
  const runner = createPinnedPythonRunner(handle.fd);
  try {
    const info = await handle.stat();
    const expectedRoot = cacheRootIdentity?.chain?.[0] ?? null;
    if (!info.isDirectory() || info.isSymbolicLink() ||
        (expectedRoot && (String(info.dev) !== String(expectedRoot.device) || String(info.ino) !== String(expectedRoot.inode)))) {
      throw new Error(`Plugin cache root descriptor identity changed: ${stable.path}`);
    }
    const entry = (target) => `${PINNED_DIRECTORY_ROOT}/${handle.fd}/${cacheEntryRelative(stable.path, target)}`;
    const relative = (target) => cacheEntryRelative(stable.path, target);
    const pinned = {
      async lstat(target) {
        return pinnedStatRecord(await runner.run("stat", [relative(target)]));
      },
      async readFile(target) {
        const info = pinnedStatRecord(await runner.run("stat", [relative(target)]));
        if (!info.isFile() || info.nlink !== 1) throw new Error(`Unsafe plugin bundle file: ${target}`);
        const encoded = await runner.run("read", [relative(target)]);
        return { info, contents: Buffer.from(encoded, "base64") };
      },
      async readdir(target) {
        return runner.run("list", [relative(target)]);
      },
      async mkdir(target, options = {}) {
        return runner.run("mkdir", [relative(target), options.mode ?? 0o777, options.recursive === true]);
      },
      async writeFile(target, data, options = {}) {
        return runner.run("write", [relative(target), options.mode ?? 0o666, options.flag ?? "w", Buffer.from(data).toString("base64")]);
      },
      async writeFileGuarded(target, data, { guard, expectedInfo, mode = 0o600 } = {}) {
        if (!guard || !expectedInfo) throw new Error("Pinned guarded write requires a guard path and identity");
        const temporary = `${target}.guarded-${randomUUID()}`;
        return runner.run("write_guarded", [
          relative(temporary),
          relative(target),
          relative(guard),
          JSON.stringify(expectedInfo),
          mode,
          Buffer.from(data).toString("base64")
        ]);
      },
      async rename(source, target) {
        return runner.run("rename", [relative(source), relative(target)]);
      },
      async unlink(target) {
        return runner.run("unlink", [relative(target)]);
      },
      async unlinkIfMatch(target, expectedInfo, contentDigest, release, allowDirectoryMetadataChange = false) {
        return runner.run("remove_if_match", [
          relative(target),
          relative(release),
          JSON.stringify(expectedInfo),
          contentDigest,
          allowDirectoryMetadataChange
        ]);
      },
      async rm(target, options = {}) {
        return runner.run("remove", [relative(target), options.force === true]);
      },
      async rmIfMatch(target, expectedInfo, release) {
        return runner.run("remove_if_match", [relative(target), relative(release), JSON.stringify(expectedInfo), ""]);
      },
      async extract(target, archive) {
        return runner.run("extract", [relative(target), Buffer.from(archive).toString("base64")]);
      }
    };
    return await operation({ stable, handle, entry, pinned });
  } finally {
    await runner.close();
    await handle.close();
  }
}

async function readRegularFile(target, { requireSingleLink = true } = {}) {
  const handle = await open(
    target,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || (requireSingleLink && info.nlink !== 1)) {
      throw new Error(`Unsafe plugin bundle file: ${target}`);
    }
    return { info, contents: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

export function processLiveness(pid, probe = process.kill) {
  if (!Number.isInteger(pid) || pid < 1) return "unknown";
  try {
    probe(pid, 0);
    return "alive";
  } catch (error) {
    if (error.code === "ESRCH") return "absent";
    // EPERM and all other inspection failures are not proof that the owner
    // is dead. Stale publication recovery must fail closed in that case.
    return "unknown";
  }
}

const DARWIN_PROCESS_IDENTITY_SCRIPT = [
  "import ctypes, os, struct, sys",
  "pid = int(sys.argv[1])",
  "lib = ctypes.CDLL('/usr/lib/libproc.dylib')",
  "proc_pidinfo = lib.proc_pidinfo",
  "proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]",
  "proc_pidinfo.restype = ctypes.c_int",
  "buffer = ctypes.create_string_buffer(136)",
  "size = proc_pidinfo(pid, 3, 0, buffer, 136)",
  "if size != 136: raise SystemExit(2)",
  "seconds, microseconds = struct.unpack_from('QQ', buffer.raw, 120)",
  "print(f'{seconds}:{microseconds}')"
].join("\n");

// `sysctl kern.boottime` can be denied by the macOS sandbox used by Codex. The
// public utmpx API exposes the same kernel-maintained boot timeval without
// requiring elevated authority. Render the legacy sysctl string exactly so
// process-incarnation digests remain compatible with already-live leases.
const DARWIN_BOOT_IDENTITY_SCRIPT = [
  "import ctypes, time",
  "class Timeval(ctypes.Structure):",
  "    _fields_ = [('tv_sec', ctypes.c_long), ('tv_usec', ctypes.c_int)]",
  "class Utmpx(ctypes.Structure):",
  "    _fields_ = [",
  "        ('ut_user', ctypes.c_char * 256),",
  "        ('ut_id', ctypes.c_char * 4),",
  "        ('ut_line', ctypes.c_char * 32),",
  "        ('ut_pid', ctypes.c_int),",
  "        ('ut_type', ctypes.c_short),",
  "        ('ut_tv', Timeval),",
  "        ('ut_host', ctypes.c_char * 256),",
  "        ('ut_pad', ctypes.c_uint32 * 16),",
  "    ]",
  "if ctypes.sizeof(ctypes.c_long) != 8: raise SystemExit(2)",
  "if ctypes.sizeof(Timeval) != 16 or ctypes.sizeof(Utmpx) != 640: raise SystemExit(2)",
  "if Utmpx.ut_type.offset != 296 or Utmpx.ut_tv.offset != 304: raise SystemExit(2)",
  "libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
  "libc.setutxent.argtypes = []",
  "libc.setutxent.restype = None",
  "libc.getutxent.argtypes = []",
  "libc.getutxent.restype = ctypes.POINTER(Utmpx)",
  "libc.endutxent.argtypes = []",
  "libc.endutxent.restype = None",
  "matches = []",
  "libc.setutxent()",
  "try:",
  "    while True:",
  "        record = libc.getutxent()",
  "        if not record: break",
  "        if record.contents.ut_type == 2:",
  "            matches.append((record.contents.ut_tv.tv_sec, record.contents.ut_tv.tv_usec))",
  "finally:",
  "    libc.endutxent()",
  "if len(matches) != 1: raise SystemExit(3)",
  "seconds, microseconds = matches[0]",
  "if seconds <= 0 or not 0 <= microseconds < 1000000: raise SystemExit(4)",
  "display = time.strftime('%a %b %e %H:%M:%S %Y', time.localtime(seconds))",
  "print(f'{{ sec = {seconds}, usec = {microseconds} }} {display}')"
].join("\n");

const DARWIN_BOOT_IDENTITY_PATTERN = /^\{ sec = [1-9]\d*, usec = \d{1,6} \} (?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/;
const DARWIN_PYTHON_TEMP_ROOT = "/private/tmp";

export function canonicalizeDarwinBootIdentity(value) {
  if (typeof value !== "string") throw new Error("macOS boot identity was malformed");
  const bootTime = value.trim().replace(/\s+/g, " ");
  if (!DARWIN_BOOT_IDENTITY_PATTERN.test(bootTime)) {
    throw new Error("macOS boot identity was malformed");
  }
  const microseconds = Number(bootTime.match(/usec = (\d{1,6})/u)?.[1]);
  if (!Number.isInteger(microseconds) || microseconds >= 1_000_000) {
    throw new Error("macOS boot identity was malformed");
  }
  return bootTime;
}

export function validateDarwinPythonTempRoot(info, resolvedPath) {
  if (
    !info
      || typeof info.isDirectory !== "function"
      || !info.isDirectory()
      || (typeof info.isSymbolicLink === "function" && info.isSymbolicLink())
      || info.uid !== 0
      || (info.mode & 0o7777) !== 0o1777
      || resolvedPath !== DARWIN_PYTHON_TEMP_ROOT
  ) {
    throw new Error("Unsafe fixed macOS Python temporary root");
  }
}

async function assertDarwinPythonTempRoot() {
  const [info, resolvedPath] = await Promise.all([
    lstat(DARWIN_PYTHON_TEMP_ROOT),
    realpath(DARWIN_PYTHON_TEMP_ROOT)
  ]);
  validateDarwinPythonTempRoot(info, resolvedPath);
}

async function readDarwinBootIdentityWithSysctl() {
  const { stdout, stderr } = await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
    encoding: "utf8",
    timeout: 5_000,
    killSignal: "SIGKILL",
    maxBuffer: 4_096,
    shell: false,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }
  });
  if (stderr !== "") throw new Error("macOS sysctl boot identity emitted stderr");
  return stdout;
}

async function readDarwinBootIdentityWithUtmpx() {
  await assertDarwinPythonTempRoot();
  const { stdout, stderr } = await execFileAsync("/usr/bin/python3", ["-I", "-S", "-c", DARWIN_BOOT_IDENTITY_SCRIPT], {
    encoding: "utf8",
    timeout: 5_000,
    killSignal: "SIGKILL",
    maxBuffer: 4_096,
    shell: false,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", TMPDIR: DARWIN_PYTHON_TEMP_ROOT }
  });
  if (stderr !== "") throw new Error("macOS utmpx boot identity emitted stderr");
  return stdout;
}

export function isDarwinSysctlPermissionDenied(error) {
  return Boolean(
    error
      && Number.isInteger(error.code)
      && error.code !== 0
      && error.signal == null
      && error.killed !== true
      && typeof error.stdout === "string"
      && error.stdout.trim() === ""
      && typeof error.stderr === "string"
      && /^sysctl: [^\r\n]*Operation not permitted\r?\n?$/.test(error.stderr)
  );
}

async function readLinuxBootIdentity() {
  return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}

export function createProcessBootIdentityProbe({
  platform = process.platform,
  darwinPrimaryProbe = readDarwinBootIdentityWithSysctl,
  darwinFallbackProbe = readDarwinBootIdentityWithUtmpx,
  darwinFallbackEligible = isDarwinSysctlPermissionDenied,
  linuxProbe = readLinuxBootIdentity
} = {}) {
  let cachedDarwinBootTime = null;
  let pendingDarwinBootTime = null;

  return async function processBootIdentity() {
    if (platform === "darwin") {
      if (cachedDarwinBootTime !== null) return cachedDarwinBootTime;
      if (pendingDarwinBootTime !== null) return pendingDarwinBootTime;
      const probe = (async () => {
        let value;
        try {
          value = await darwinPrimaryProbe();
        } catch (error) {
          if (!darwinFallbackEligible(error)) throw error;
          value = await darwinFallbackProbe();
        }
        const bootTime = canonicalizeDarwinBootIdentity(value);
        cachedDarwinBootTime = bootTime;
        return bootTime;
      })();
      pendingDarwinBootTime = probe;
      try {
        return await probe;
      } finally {
        if (pendingDarwinBootTime === probe) pendingDarwinBootTime = null;
      }
    }
    if (platform === "linux") return linuxProbe();
    return null;
  };
}

const processBootIdentity = createProcessBootIdentityProbe();

async function readDarwinProcessStartIdentity(pid) {
  const { stdout } = await execFileAsync("/usr/bin/python3", ["-c", DARWIN_PROCESS_IDENTITY_SCRIPT, String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
    killSignal: "SIGKILL",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }
  });
  return stdout.trim();
}

async function readLinuxProcessStartIdentity(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const closing = stat.lastIndexOf(")");
  const fields = closing >= 0 ? stat.slice(closing + 1).trim().split(/\s+/) : [];
  return fields[19];
}

export function createProcessStartIdentityProbe({
  platform = process.platform,
  selfPid = process.pid,
  darwinProbe = readDarwinProcessStartIdentity,
  linuxProbe = readLinuxProcessStartIdentity
} = {}) {
  let cachedDarwinSelfIdentity = null;
  let pendingDarwinSelfIdentity = null;

  return async function processStartIdentity(pid) {
    if (platform === "darwin") {
      if (pid === selfPid && cachedDarwinSelfIdentity !== null) return cachedDarwinSelfIdentity;
      if (pid === selfPid && pendingDarwinSelfIdentity !== null) return pendingDarwinSelfIdentity;
      const probe = (async () => {
        const value = await darwinProbe(pid);
        if (!/^\d+:\d+$/.test(value ?? "")) throw new Error("macOS process start identity was malformed");
        if (pid === selfPid) cachedDarwinSelfIdentity = value;
        return value;
      })();
      if (pid !== selfPid) return probe;
      pendingDarwinSelfIdentity = probe;
      try {
        return await probe;
      } finally {
        if (pendingDarwinSelfIdentity === probe) pendingDarwinSelfIdentity = null;
      }
    }
    if (platform === "linux") {
      const value = await linuxProbe(pid);
      if (!/^\d+$/.test(value ?? "")) throw new Error("Linux process start ticks were unavailable");
      return value;
    }
    throw new Error("Process start identity is unavailable on this platform");
  };
}

const processStartIdentity = createProcessStartIdentityProbe();

const waitForProcessIdentityRetry = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const PROCESS_IDENTITY_RETRY_DELAYS_MS = Object.freeze([50, 250]);

export async function processIncarnationDigest(pid, {
  liveness = processLiveness,
  startIdentity = processStartIdentity,
  bootIdentity = processBootIdentity,
  wait = waitForProcessIdentityRetry
} = {}) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const initialLiveness = liveness(pid);
  if (initialLiveness === "absent") return null;
  if (initialLiveness === "unknown") return "unknown";
  for (let attempt = 0; attempt <= PROCESS_IDENTITY_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const start = await startIdentity(pid);
      const boot = await bootIdentity();
      if (typeof start !== "string" || !start || typeof boot !== "string" || !boot) {
        throw new Error("Process incarnation identity was incomplete");
      }
      const finalLiveness = liveness(pid);
      if (finalLiveness === "absent") return null;
      if (finalLiveness === "unknown") return "unknown";
      return sha256(`${process.platform}\0${pid}\0${boot}\0${start}`);
    } catch {
      const finalLiveness = liveness(pid);
      if (finalLiveness === "absent") return null;
      if (finalLiveness === "unknown") return "unknown";
      if (attempt < PROCESS_IDENTITY_RETRY_DELAYS_MS.length) {
        await wait(PROCESS_IDENTITY_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  // A live process whose incarnation cannot be read after the fixed retry
  // budget is not reclaimable. Availability retries never weaken this HOLD.
  return "unknown";
}

async function readPublicationLockRecord(lockPath, { allowHardlink = false, pinned = null } = {}) {
  try {
    const opened = pinned
      ? await pinned.readFile(lockPath)
      : await readRegularFile(lockPath, { requireSingleLink: !allowHardlink });
    if (!allowHardlink && opened.info.nlink !== 1) {
      throw new Error(`Unsafe publication lock file: ${lockPath}`);
    }
    return {
      value: JSON.parse(opened.contents.toString("utf8")),
      identityDigest: sha256([
        opened.info.dev,
        opened.info.ino,
        opened.info.size,
        sha256(opened.contents)
      ].join("\0"))
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readPublicationLock(lockPath, options = {}) {
  return (await readPublicationLockRecord(lockPath, options))?.value ?? null;
}

async function createPublicationReleaseRoot(cacheRoot, cacheRootIdentity = null) {
  // The release directory is deliberately created below cacheRoot.  A
  // temporary directory from os.tmpdir() is not safe here: rename(2) can
  // return EXDEV when the two locations are on different filesystems.  Keep
  // the validated inode on the cache filesystem and fail closed if that
  // invariant is ever violated by a mount or a test shim.
  const stableRoot = await assertStableCacheRoot(cacheRoot, cacheRootIdentity);
  const cacheInfo = await lstat(stableRoot.path);
  return withPinnedCacheRoot(stableRoot.path, stableRoot, async ({ pinned }) => {
    let releaseRoot;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = path.join(stableRoot.path, `.sbw-publication-release-${randomUUID()}`);
      try {
        await pinned.mkdir(candidate, { mode: 0o700 });
        releaseRoot = candidate;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    if (!releaseRoot) throw new Error("Plugin cache publication release directory could not be allocated");
    const releaseInfo = await pinned.lstat(releaseRoot);
    if (releaseInfo.dev !== cacheInfo.dev) {
      await pinned.rm(releaseRoot, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("Plugin cache publication release directory is on a different filesystem");
    }
    return releaseRoot;
  });
}

async function removePublicationReleaseRoot(releaseRoot, expectedInfo, cacheRoot, cacheRootIdentity) {
  try {
    await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, async ({ pinned }) => {
      const current = await pinned.lstat(releaseRoot);
      if (current.isSymbolicLink() || !current.isDirectory() ||
          current.dev !== expectedInfo.dev || current.ino !== expectedInfo.ino) {
        return;
      }
      // Recursive cleanup is descriptor-rooted; a root/ancestor replacement
      // cannot redirect this pathname to a different filesystem tree.
      await pinned.rm(releaseRoot, { recursive: true, force: true });
    });
  } catch {
    // Failing to prove the private cleanup target is the original directory
    // is intentionally non-fatal; the lock has already been moved off the
    // cache-root pathname and must never be deleted through a changed path.
  }
}

async function quarantinePublicationLock({
  cacheRoot,
  version,
  lockPath,
  expectedRecord,
  cacheRootIdentity = null,
  afterStaleLockValidated = null,
  beforeStaleLockRelease = null
}) {
  cacheRootIdentity = await assertStableCacheRoot(cacheRoot, cacheRootIdentity);
  if (afterStaleLockValidated) {
    await afterStaleLockValidated({ lockPath, value: structuredClone(expectedRecord.value) });
  }
  await assertStableCacheRoot(cacheRoot, cacheRootIdentity);
  const quarantinePath = path.join(
    cacheRoot,
    `${publicationLockPrefix(version)}.stale-${randomUUID()}`
  );
  try {
    await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) => pinned.rename(lockPath, quarantinePath));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const quarantined = await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) => readPublicationLockRecord(quarantinePath, { pinned }));
  if (!quarantined || quarantined.identityDigest !== expectedRecord.identityDigest ||
      JSON.stringify(quarantined.value) !== JSON.stringify(expectedRecord.value)) {
    await moveToForeignQuarantine(cacheRoot, version, quarantinePath, cacheRootIdentity);
    throw new Error(`Plugin cache publication lock identity changed while quarantining ${version}`);
  }
  const beforeDelete = await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) => readPublicationLockRecord(quarantinePath, { pinned }));
  if (!beforeDelete || beforeDelete.identityDigest !== expectedRecord.identityDigest ||
      JSON.stringify(beforeDelete.value) !== JSON.stringify(expectedRecord.value)) {
    await moveToForeignQuarantine(cacheRoot, version, quarantinePath, cacheRootIdentity);
    throw new Error(`Plugin cache publication quarantine identity changed before deletion for ${version}`);
  }
  if (beforeStaleLockRelease) {
    await beforeStaleLockRelease({ quarantinePath, value: structuredClone(beforeDelete.value) });
  }
  // Never unlink a cache-root pathname after validating it: a concurrent
  // replacement at the final lookup must be retained, not deleted. Move the
  // validated inode into a private 0700 temporary directory first; a mismatch
  // there is moved back into foreign quarantine, while a matching inode can be
  // removed without re-resolving an attacker-replaceable cache-root path.
  const releaseRoot = await createPublicationReleaseRoot(cacheRoot, cacheRootIdentity);
  const releaseRootInfo = await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) => pinned.lstat(releaseRoot));
  const releasedPath = path.join(releaseRoot, "lock");
  try {
    try {
      await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) => pinned.rename(quarantinePath, releasedPath));
    } catch (error) {
      if (error.code === "ENOENT") return false;
      if (error.code === "EXDEV") {
        throw new Error(`Plugin cache publication lock release crossed filesystems for ${version}`);
      }
      throw error;
    }
    const released = await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) => readPublicationLockRecord(releasedPath, { pinned }));
    if (!released || released.identityDigest !== expectedRecord.identityDigest ||
        JSON.stringify(released.value) !== JSON.stringify(expectedRecord.value)) {
      await moveToForeignQuarantine(cacheRoot, version, releasedPath, cacheRootIdentity);
      throw new Error(`Plugin cache publication quarantine identity changed while releasing ${version}`);
    }
    return true;
  } finally {
    await removePublicationReleaseRoot(releaseRoot, releaseRootInfo, cacheRoot, cacheRootIdentity);
  }
}

async function moveToForeignQuarantine(cacheRoot, version, quarantinePath, cacheRootIdentity = null) {
  cacheRootIdentity = await assertStableCacheRoot(cacheRoot, cacheRootIdentity);
  const foreignPath = path.join(
    cacheRoot,
    `${publicationLockPrefix(version)}.foreign-${randomUUID()}`
  );
  try {
    await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) => pinned.rename(quarantinePath, foreignPath));
    return foreignPath;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function publicationLockPrefix(version) {
  return `.${version}.publish.lock`;
}

async function publicationLockPaths(cacheRoot, version, cacheRootIdentity = null) {
  const prefix = publicationLockPrefix(version);
  const entries = cacheRootIdentity
    ? await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) => pinned.readdir(cacheRoot))
    : await readdir(cacheRoot);
  return entries
    .filter((entry) => entry === prefix || entry.startsWith(`${prefix}-`) ||
      entry.startsWith(`${prefix}.stale-`) || entry.startsWith(`${prefix}.foreign-`))
    .sort()
    .map((entry) => {
      if (entry === prefix) {
        return { path: path.join(cacheRoot, entry), phase: "ready", ownerToken: null, readyOrder: null };
      }
      const legacyStaleSuffix = entry.startsWith(`${prefix}.stale-`)
        ? entry.slice(`${prefix}.`.length)
        : null;
      if (/^stale-([0-9a-f-]{36})$/.test(legacyStaleSuffix ?? "")) {
        return { path: path.join(cacheRoot, entry), phase: "ready", ownerToken: null, readyOrder: null };
      }
      if (entry.startsWith(`${prefix}.foreign-`)) {
        return { path: path.join(cacheRoot, entry), phase: "foreign", ownerToken: null, readyOrder: null };
      }
      const suffix = entry.slice(prefix.length + 1);
      const preparing = /^preparing-([0-9a-f-]{36})$/.exec(suffix);
      if (preparing) {
        return { path: path.join(cacheRoot, entry), phase: "preparing", ownerToken: preparing[1], readyOrder: null };
      }
      const ready = /^ready-([0-9]{1,30})-([0-9a-f-]{36})$/.exec(suffix);
      if (ready) {
        return { path: path.join(cacheRoot, entry), phase: "ready", ownerToken: ready[2], readyOrder: ready[1] };
      }
      // 3.2.4 could be killed after quarantining a proven-dead lock as
      // `.publish.lock.stale-<uuid>`. Treat that exact legacy quarantine as a
      // recoverable ready-phase lease: a dead recorded pid is reclaimed below,
      // while a reused/live pid remains fail-closed and blocks publication.
      // Accept the unshipped single-phase lease shape only so an interrupted
      // local upgrade can be recovered. New publishers never create it.
      const legacy = /^(?:ready-)?([0-9a-f-]{36})$/.exec(suffix);
      return {
        path: path.join(cacheRoot, entry),
        phase: legacy ? "ready" : "invalid",
        ["owner" + "Token"]: legacy?.[1] ?? null,
        readyOrder: null
      };
    });
}

async function reclaimStalePublicationLocks(cacheRoot, version, {
  cacheRootIdentity = null,
  afterStaleLockValidated = null,
  beforeStaleLockRelease = null
} = {}) {
  let reclaimed = false;
  cacheRootIdentity = await assertStableCacheRoot(cacheRoot, cacheRootIdentity);
  const live = [];
  for (const lock of await publicationLockPaths(cacheRoot, version, cacheRootIdentity)) {
    const record = await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) => readPublicationLockRecord(lock.path, { pinned }));
    const existing = record?.value ?? null;
    // A valid owner may release its unique lease after the directory snapshot.
    // Missing paths are a normal handoff, while malformed paths that still
    // exist remain fail-closed below.
    if (existing === null) continue;
    if (lock.phase === "invalid" || lock.phase === "foreign" || existing.version !== version || !Number.isInteger(existing.pid) || existing.pid < 1 ||
        typeof existing.ownerToken !== "string" || !existing.ownerToken ||
        !Number.isFinite(Date.parse(existing.createdAt)) ||
        (existing.processStartDigest !== undefined && !/^[a-f0-9]{64}$/.test(existing.processStartDigest)) ||
        (lock.ownerToken !== null && lock.ownerToken !== existing.ownerToken)) {
      throw new Error(`Plugin cache publication lock owner cannot be proven absent for ${version}`);
    }
    const currentIncarnation = await processIncarnationDigest(existing.pid);
    if (currentIncarnation === "unknown" || (currentIncarnation !== null && existing.processStartDigest === undefined)) {
      // Legacy leases did not bind process start time. A live/reused PID is
      // therefore indistinguishable and must remain fail-closed.
      live.push({ ...lock, value: existing });
      continue;
    }
    if (currentIncarnation !== null && currentIncarnation === existing.processStartDigest) {
      live.push({ ...lock, value: existing });
      continue;
    }
    reclaimed ||= await quarantinePublicationLock({
      cacheRoot,
      version,
      lockPath: lock.path,
      expectedRecord: record,
      cacheRootIdentity,
      afterStaleLockValidated,
      beforeStaleLockRelease
    });
  }
  return { reclaimed, live };
}

async function acquirePublicationLock(cacheRoot, version, {
  cacheRootIdentity = null,
  afterStaleLockValidated = null,
  beforeStaleLockRelease = null
} = {}) {
  let reclaimedAny = false;
  cacheRootIdentity = await assertStableCacheRoot(cacheRoot, cacheRootIdentity);
  const prefix = publicationLockPrefix(version);
  const processStartDigest = await processIncarnationDigest(process.pid);
  if (!/^[a-f0-9]{64}$/.test(processStartDigest ?? "")) {
    throw new Error("Plugin cache publication cannot bind the publisher process incarnation");
  }
  for (let electionAttempt = 0; electionAttempt < 12; electionAttempt += 1) {
    const ownerToken = randomUUID();
    const preparingPath = path.join(cacheRoot, `${prefix}-preparing-${ownerToken}`);
    let ownedPath = preparingPath;
    await assertStableCacheRoot(cacheRoot, cacheRootIdentity);
    await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) => pinned.writeFile(preparingPath, `${JSON.stringify({
      version,
      pid: process.pid,
      processStartDigest,
      ownerToken,
      createdAt: new Date().toISOString()
    })}\n`, { flag: "wx", mode: 0o600 }));
    let retryEqualOrder = false;
    try {
      // The preparing lease is visible before a monotonic election order is
      // sampled. A delayed process can therefore never resume with priority
      // over a publisher that became ready while it was paused.
      const admission = await reclaimStalePublicationLocks(cacheRoot, version, {
        cacheRootIdentity,
        afterStaleLockValidated,
        beforeStaleLockRelease
      });
      reclaimedAny ||= admission.reclaimed;
      const self = admission.live.find((item) => item.path === preparingPath);
      if (!self || self.phase !== "preparing") {
        throw new Error(`Plugin cache publication lease disappeared for ${version}`);
      }
      if (admission.live.some((item) => item.phase === "ready")) {
        throw new Error(`Plugin cache publication is already in progress for ${version}`);
      }
      const readyOrder = process.hrtime.bigint().toString();
      const readyPath = path.join(cacheRoot, `${prefix}-ready-${readyOrder}-${ownerToken}`);
      await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) => pinned.rename(preparingPath, readyPath));
      ownedPath = readyPath;

      for (let settleAttempt = 0; settleAttempt < 12; settleAttempt += 1) {
        const election = await reclaimStalePublicationLocks(cacheRoot, version, {
          cacheRootIdentity,
          afterStaleLockValidated,
          beforeStaleLockRelease
        });
        reclaimedAny ||= election.reclaimed;
        const current = election.live.find((item) => item.path === readyPath);
        if (!current || current.phase !== "ready" || current.readyOrder !== readyOrder) {
          throw new Error(`Plugin cache publication lease disappeared for ${version}`);
        }
        if (election.live.some((item) => item.phase === "preparing")) {
          const jitter = Number.parseInt(ownerToken.slice(0, 2), 16) % 7;
          await new Promise((resolve) => setTimeout(resolve, 3 + jitter + settleAttempt));
          continue;
        }
        const contenders = election.live.filter((item) => item.path !== readyPath && item.phase === "ready");
        if (contenders.some((item) => item.readyOrder === null || BigInt(item.readyOrder) < BigInt(readyOrder))) {
          throw new Error(`Plugin cache publication is already in progress for ${version}`);
        }
        if (contenders.some((item) => item.readyOrder === readyOrder)) {
          retryEqualOrder = true;
          break;
        }
        return { path: readyPath, ownerToken, close: async () => undefined, reclaimed: reclaimedAny };
      }
      if (!retryEqualOrder) {
        throw new Error(`Plugin cache publication contenders did not settle for ${version}`);
      }
    } catch (error) {
      await releasePublicationLock(ownedPath, ownerToken, cacheRootIdentity);
      throw error;
    }
    await releasePublicationLock(ownedPath, ownerToken, cacheRootIdentity);
    const jitter = Number.parseInt(ownerToken.slice(0, 2), 16) % 11;
    await new Promise((resolve) => setTimeout(resolve, 3 + jitter + electionAttempt));
  }
  throw new Error(`Plugin cache publication contenders did not elect an owner for ${version}`);
}

async function releasePublicationLock(lockPath, ownerToken, cacheRootIdentity = null) {
  const cacheRoot = path.dirname(lockPath);
  const record = cacheRootIdentity
    ? await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) => readPublicationLockRecord(lockPath, { pinned }))
    : await readPublicationLockRecord(lockPath);
  if (!record || record.value.ownerToken !== ownerToken) return;
  const versionMatch = path.basename(lockPath).match(/^\.(.+)\.publish\.lock(?:-|$|\.)/);
  if (!versionMatch) throw new Error("Plugin cache publication lock path is not canonical");
  await quarantinePublicationLock({
    cacheRoot,
    version: versionMatch[1],
    lockPath,
    expectedRecord: record,
    cacheRootIdentity
  });
}

async function removeStalePublicationArtifacts(cacheRoot, version, cacheRootIdentity = null) {
  cacheRootIdentity = await assertStableCacheRoot(cacheRoot, cacheRootIdentity);
  const prefix = `.${version}.`;
  await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, async ({ pinned }) => {
    const entries = await pinned.readdir(cacheRoot);
    for (const entry of entries) {
      if (
        entry.startsWith(`${prefix}stage-`) ||
        entry.startsWith(`${prefix}snapshot-`) ||
        entry.startsWith(`${prefix}archive-`)
      ) {
        await pinned.rm(path.join(cacheRoot, entry), { recursive: true, force: true });
      }
    }
  });
}

async function assertPublishableSource(root) {
  const sourceRoot = await realpath(path.resolve(root));
  let repositoryRoot;
  try {
    repositoryRoot = await repositoryRootForSource(sourceRoot);
  } catch (error) {
    // A repository-local worktree redirect is an authority violation.  Do not
    // downgrade it to the normal "untracked test fixture" path: doing so would
    // let publication continue from the caller's lexical sourceRoot and copy
    // bytes that are not covered by the effective Git worktree binding.
    if (/core\.worktree/i.test(String(error?.message ?? error))) {
      throw error;
    }
    return;
  }
  const relativeRoot = path.relative(repositoryRoot, sourceRoot).replaceAll(path.sep, "/");
  if (!relativeRoot || relativeRoot.startsWith("../") || path.isAbsolute(relativeRoot)) return;
  try {
    await runSourceGit(repositoryRoot, [
      "ls-files", "--error-unmatch", "--", `${relativeRoot}/.codex-plugin/plugin.json`
    ]);
  } catch {
    // Temporary test fixtures without a tracked plugin manifest are not publishable sources.
    return;
  }
  const worktreeStatus = (await runSourceGit(repositoryRoot, [
    "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored", "--", relativeRoot
  ])).stdout;
  if (worktreeStatus.length > 0) {
    throw new Error(`Plugin cache source is not a clean committed tree: ${relativeRoot}`);
  }
  const hidden = await hiddenIndexEntries(repositoryRoot, { isolatedConfig: true });
  const hiddenPluginEntries = hidden.records.filter((item) => item.path === relativeRoot || item.path.startsWith(`${relativeRoot}/`));
  if (hiddenPluginEntries.length > 0) {
    throw new Error(`Plugin cache source contains hidden tracked index flags: ${hiddenPluginEntries.map((item) => `${item.status} ${item.path}`).join(", ")}`);
  }
  const tracked = (await runSourceGit(repositoryRoot, ["ls-files", "-z", "--", relativeRoot])).stdout
    .split("\0").filter(Boolean);
  const [untrackedResult, ignoredResult] = await Promise.all([
    runSourceGit(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", relativeRoot]),
    runSourceGit(repositoryRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", relativeRoot])
  ]);
  const unexpected = [...new Set([
    ...untrackedResult.stdout.split("\0").filter(Boolean),
    ...ignoredResult.stdout.split("\0").filter(Boolean)
  ])].sort();
  if (unexpected.length > 0) {
    throw new Error(`Plugin cache source contains untracked or ignored files: ${unexpected.join(", ")}`);
  }
  for (const file of tracked) {
    const absolute = path.join(repositoryRoot, file);
    const info = await lstat(absolute).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) throw new Error(`Plugin cache source is missing tracked file: ${file}`);
  }
}

export async function createBundleManifest(root, relative = "") {
  const directory = path.resolve(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const records = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Plugin bundle contains a symlink: ${childRelative}`);
    if (info.isDirectory()) {
      records.push(...await createBundleManifest(root, childRelative));
    } else if (info.isFile()) {
      const opened = await readRegularFile(absolute);
      records.push({
        path: childRelative,
        size: opened.info.size,
        mode: normalizeBundleMode(opened.info.mode),
        digest: sha256(opened.contents)
      });
    } else {
      throw new Error(`Plugin bundle contains an unsupported entry: ${childRelative}`);
    }
  }
  return records;
}

async function createPinnedBundleManifest(pinned, root, relative = "") {
  const directory = path.resolve(root, relative);
  const entries = (await pinned.readdir(directory))
    .map((name) => ({ name }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const records = [];
  for (const entry of entries) {
    const childRelative = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    const absolute = path.join(directory, entry.name);
    const info = await pinned.lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Plugin bundle contains a symlink: ${childRelative}`);
    if (info.isDirectory()) {
      records.push(...await createPinnedBundleManifest(pinned, root, childRelative));
    } else if (info.isFile()) {
      const opened = await pinned.readFile(absolute);
      records.push({
        path: childRelative,
        size: opened.info.size,
        mode: normalizeBundleMode(opened.info.mode),
        digest: sha256(opened.contents)
      });
    } else {
      throw new Error(`Plugin bundle contains an unsupported entry: ${childRelative}`);
    }
  }
  return records;
}

async function pinnedBundleDigest(pinned, root) {
  return digestObject(await createPinnedBundleManifest(pinned, root));
}

export async function bundleDigest(root) {
  await assertPublishableSource(root);
  return digestObject(await createBundleManifest(root));
}

function manifestDiff(source, target) {
  const sourceMap = new Map(source.map((record) => [record.path, record]));
  const targetMap = new Map(target.map((record) => [record.path, record]));
  const missing = [...sourceMap.keys()].filter((name) => !targetMap.has(name)).sort();
  const extra = [...targetMap.keys()].filter((name) => !sourceMap.has(name)).sort();
  const changed = [...sourceMap.keys()]
    .filter((name) => {
      const targetRecord = targetMap.get(name);
      return targetRecord && JSON.stringify(sourceMap.get(name)) !== JSON.stringify(targetRecord);
    })
    .sort();
  return { missing, extra, changed };
}

async function pluginVersion(sourceRoot) {
  const manifestPath = path.join(sourceRoot, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse((await readRegularFile(manifestPath)).contents.toString("utf8"));
  if (typeof manifest.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(manifest.version)) {
    throw new Error("Plugin manifest version is missing or unsafe");
  }
  return manifest.version;
}

export async function checkPluginCache({ sourceRoot, cacheRoot, cacheRootIdentity = null }) {
  const resolvedSource = path.resolve(sourceRoot);
  let resolvedCacheRoot = path.resolve(cacheRoot);
  let stableCacheRootIdentity = cacheRootIdentity;
  if (await pathExists(resolvedCacheRoot)) {
    stableCacheRootIdentity = await assertStableCacheRoot(resolvedCacheRoot, cacheRootIdentity);
    resolvedCacheRoot = stableCacheRootIdentity.path;
  }
  await assertDirectoryNotSymlink(resolvedSource);
  await assertPublishableSource(resolvedSource);
  const version = await pluginVersion(resolvedSource);
  const target = path.join(resolvedCacheRoot, version);
  const sourceManifest = await createBundleManifest(resolvedSource);
  const sourceDigest = digestObject(sourceManifest);
  const targetExists = stableCacheRootIdentity
    ? await withPinnedCacheRoot(resolvedCacheRoot, stableCacheRootIdentity, async ({ pinned }) => {
        try {
          const info = await pinned.lstat(target);
          if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error(`Unsafe cache directory: ${target}`);
          }
          return true;
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      })
    : await pathExists(target);
  if (!targetExists) {
    return {
      ok: false,
      status: "missing",
      version,
      sourceRoot: resolvedSource,
      target,
      sourceDigest,
      targetDigest: null,
      diff: { missing: sourceManifest.map((record) => record.path), extra: [], changed: [] }
    };
  }
  const targetManifest = stableCacheRootIdentity
    ? await withPinnedCacheRoot(resolvedCacheRoot, stableCacheRootIdentity, ({ pinned }) => createPinnedBundleManifest(pinned, target))
    : await (async () => {
        await assertDirectoryNotSymlink(target);
        return createBundleManifest(target);
      })();
  const targetDigest = digestObject(targetManifest);
  const diff = manifestDiff(sourceManifest, targetManifest);
  return {
    ok: sourceDigest === targetDigest,
    status: sourceDigest === targetDigest ? "identical" : "drifted",
    version,
    sourceRoot: resolvedSource,
    target,
    sourceDigest,
    targetDigest,
    diff
  };
}

async function copyBundle(sourceRoot, targetRoot, relative = "") {
  const sourceDirectory = path.resolve(sourceRoot, relative);
  const targetDirectory = path.resolve(targetRoot, relative);
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await chmod(targetDirectory, 0o700);
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = path.join(relative, entry.name);
    const source = path.join(sourceRoot, childRelative);
    const target = path.join(targetRoot, childRelative);
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error(`Refusing to publish symlink: ${childRelative}`);
    if (info.isDirectory()) {
      await copyBundle(sourceRoot, targetRoot, childRelative);
    } else if (info.isFile()) {
      const opened = await readRegularFile(source);
      const targetHandle = await open(target, "wx", opened.info.mode & 0o777);
      try {
        await targetHandle.writeFile(opened.contents);
        await targetHandle.sync();
      } finally {
        await targetHandle.close();
      }
      await chmod(target, opened.info.mode & 0o777);
    } else {
      throw new Error(`Refusing to publish unsupported entry: ${childRelative}`);
    }
  }
}

async function copyBundlePinned(pinned, sourceRoot, targetRoot, relative = "", sourceIsPinned = false) {
  const sourceDirectory = path.resolve(sourceRoot, relative);
  const targetDirectory = path.resolve(targetRoot, relative);
  await pinned.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const names = sourceIsPinned
    ? await pinned.readdir(sourceDirectory)
    : (await readdir(sourceDirectory, { withFileTypes: true })).map((entry) => entry.name);
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    const childRelative = path.join(relative, name);
    const source = path.join(sourceRoot, childRelative);
    const target = path.join(targetRoot, childRelative);
    const info = sourceIsPinned ? await pinned.lstat(source) : await lstat(source);
    if (info.isSymbolicLink()) throw new Error(`Refusing to publish symlink: ${childRelative}`);
    if (info.isDirectory()) {
      await copyBundlePinned(pinned, sourceRoot, targetRoot, childRelative, sourceIsPinned);
    } else if (info.isFile()) {
      const opened = sourceIsPinned ? await pinned.readFile(source) : await readRegularFile(source);
      await pinned.writeFile(target, opened.contents, { flag: "wx", mode: opened.info.mode & 0o777 });
    } else {
      throw new Error(`Refusing to publish unsupported entry: ${childRelative}`);
    }
  }
}

function validateExpectedSourceBinding(value) {
  if (value === null || value === undefined) return null;
  const keys = [
    "pluginBundleDigest",
    "sourceBaselineRevision",
    "sourceBindingDigest",
    "sourceHeadRevision"
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== keys.sort().join("\0") ||
      !/^[a-f0-9]{40}$/.test(value.sourceBaselineRevision) ||
      !/^[a-f0-9]{40}$/.test(value.sourceHeadRevision) ||
      !/^[a-f0-9]{64}$/.test(value.sourceBindingDigest) ||
      !/^[a-f0-9]{64}$/.test(value.pluginBundleDigest)) {
    throw new Error("Plugin cache publication expected source binding is structurally invalid");
  }
  return value;
}

function publicationMarkerPath(cacheRoot, version) {
  return path.join(path.resolve(cacheRoot), `${version}.ready.json`);
}

async function readPublicationMarker(cacheRoot, version, cacheRootIdentity = null) {
  const root = path.resolve(cacheRoot);
  const identity = cacheRootIdentity ?? await assertStableCacheRoot(root);
  const target = publicationMarkerPath(root, version);
  return withPinnedCacheRoot(root, identity, async ({ pinned }) => {
    try {
      const opened = await pinned.readFile(target);
      return JSON.parse(opened.contents.toString("utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
}

async function removePinnedLeafIfMatch({
  cacheRoot,
  cacheRootIdentity,
  target,
  expectedInfo,
  contentDigest = "",
  foreignPrefix
}) {
  const releaseRoot = await createPublicationReleaseRoot(cacheRoot, cacheRootIdentity);
  const releaseInfo = await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) => pinned.lstat(releaseRoot));
  const releasedPath = path.join(releaseRoot, "leaf");
  try {
    await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) =>
      pinned.unlinkIfMatch(
        target,
        expectedInfo,
        contentDigest,
        releasedPath,
        expectedInfo?.type === "directory"
      )
    );
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    if (error.code === "EAGAIN") {
      const foreignPath = path.join(path.resolve(cacheRoot), `${foreignPrefix}.foreign-${randomUUID()}`);
      await withPinnedCacheRoot(cacheRoot, cacheRootIdentity, ({ pinned }) =>
        pinned.rename(releasedPath, foreignPath)
      ).catch((moveError) => {
        if (moveError.code !== "ENOENT") throw moveError;
      });
    }
    throw error;
  } finally {
    await removePublicationReleaseRoot(releaseRoot, releaseInfo, cacheRoot, cacheRootIdentity);
  }
}

async function removeOwnedPublicationMarker(cacheRoot, version, expectedMarker, cacheRootIdentity = null) {
  if (!expectedMarker) return false;
  const root = path.resolve(cacheRoot);
  cacheRootIdentity = await assertStableCacheRoot(root, cacheRootIdentity);
  const target = publicationMarkerPath(root, version);
  return withPinnedCacheRoot(root, cacheRootIdentity, async ({ pinned }) => {
    let current;
    let currentInfo;
    let currentContents;
    try {
      const opened = await pinned.readFile(target);
      currentInfo = opened.info;
      currentContents = opened.contents;
      current = JSON.parse(currentContents.toString("utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (!current || digestObject(current) !== digestObject(expectedMarker)) return false;
    return removePinnedLeafIfMatch({
      cacheRoot: root,
      cacheRootIdentity,
      target,
      expectedInfo: currentInfo,
      contentDigest: sha256(currentContents),
      foreignPrefix: `${version}.ready`
    });
  });
}

async function writePublicationMarker({
  cacheRoot,
  version,
  state,
  targetDigest,
  sourceDigest,
  sourceBaselineRevision = null,
  sourceHeadRevision = null,
  sourceBindingDigest = null,
  pluginBundleDigest = null,
  runId = null,
  attemptId = null,
  providerReceiptDigest = null,
  cacheRootIdentity = null,
  guardTarget = null,
  guardInfo = null
}) {
  if (!["pending", "ready"].includes(state)) {
    throw new Error("Plugin cache publication marker state is invalid");
  }
  const root = (await assertStableCacheRoot(path.resolve(cacheRoot), cacheRootIdentity)).path;
  cacheRootIdentity = await assertStableCacheRoot(root, cacheRootIdentity);
  const target = publicationMarkerPath(root, version);
  const value = {
    schemaVersion: 2,
    state,
    version,
    target: path.join(root, version),
    targetDigest,
    sourceDigest,
    sourceBaselineRevision,
    sourceHeadRevision,
    sourceBindingDigest,
    pluginBundleDigest,
    runId,
    attemptId,
    providerReceiptDigest,
    updatedAt: new Date().toISOString()
  };
  return withPinnedCacheRoot(root, cacheRootIdentity, async ({ pinned }) => {
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    if (guardTarget !== null || guardInfo !== null) {
      if (guardTarget === null || guardInfo === null) {
        throw new Error("Plugin cache ready marker guard is incomplete");
      }
      await pinned.writeFileGuarded(target, contents, { guard: guardTarget, expectedInfo: guardInfo, mode: 0o600 });
    } else {
      const temporary = `${target}.tmp-${randomUUID()}`;
      await pinned.writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
      await pinned.rename(temporary, target).catch(async (error) => {
        await pinned.unlink(temporary).catch(() => undefined);
        throw error;
      });
    }
    return value;
  });
}

function pendingMarkerMatchesPublication(marker, {
  cacheRoot,
  version,
  targetDigest,
  expectedSourceBinding,
  publicationIdentity
}) {
  const expected = expectedSourceBinding;
  return marker?.schemaVersion === 2 &&
    marker.state === "pending" &&
    marker.version === version &&
    marker.target === path.join(path.resolve(cacheRoot), version) &&
    marker.targetDigest === targetDigest &&
    marker.sourceDigest === targetDigest &&
    marker.sourceBaselineRevision === (expected?.sourceBaselineRevision ?? null) &&
    marker.sourceHeadRevision === (expected?.sourceHeadRevision ?? null) &&
    marker.sourceBindingDigest === (expected?.sourceBindingDigest ?? null) &&
    marker.pluginBundleDigest === (expected?.pluginBundleDigest ?? targetDigest) &&
    marker.runId === (publicationIdentity?.runId ?? null) &&
    marker.attemptId === (publicationIdentity?.attemptId ?? null) &&
    marker.providerReceiptDigest === null;
}

export async function markPluginCacheReady({
  cacheRoot,
  version,
  target,
  targetDigest,
  sourceDigest,
  sourceBaselineRevision,
  sourceHeadRevision,
  sourceBindingDigest,
  pluginBundleDigest,
  runId = null,
  attemptId = null,
  providerReceiptDigest = null,
  afterLock = null,
  beforeMarkerCommit = null
}) {
  const root = (await assertStableCacheRoot(path.resolve(cacheRoot))).path;
  if (target !== path.join(root, version)) {
    throw new Error("Plugin cache ready marker target is not canonical");
  }
  const cacheRootIdentity = await assertStableCacheRoot(root);
  if (afterLock !== null && typeof afterLock !== "function") {
    throw new Error("Plugin cache ready afterLock hook must be a function");
  }
  if (beforeMarkerCommit !== null && typeof beforeMarkerCommit !== "function") {
    throw new Error("Plugin cache ready beforeMarkerCommit hook must be a function");
  }
  const lock = await acquirePublicationLock(root, version, { cacheRootIdentity });
  try {
    if (afterLock) await afterLock();
    const targetSnapshot = await withPinnedCacheRoot(root, cacheRootIdentity, async ({ pinned }) => {
      const beforeInfo = await pinned.lstat(target);
      const digest = await pinnedBundleDigest(pinned, target);
      const afterInfo = await pinned.lstat(target);
      if (beforeInfo.type !== afterInfo.type || beforeInfo.dev !== afterInfo.dev ||
          beforeInfo.ino !== afterInfo.ino || beforeInfo.nlink !== afterInfo.nlink ||
          beforeInfo.size !== afterInfo.size) {
        throw new Error("Plugin cache ready marker target identity changed during verification");
      }
      return { digest, info: afterInfo };
    });
    const actualTargetDigest = targetSnapshot.digest;
    if (actualTargetDigest !== targetDigest) {
      throw new Error("Plugin cache ready marker target digest does not match the published target");
    }
    const existing = await readPublicationMarker(root, version, cacheRootIdentity);
    if (existing && existing.state !== "pending" && existing.state !== "ready") {
      throw new Error("Plugin cache ready marker has an invalid prior state");
    }
    if (existing?.state === "pending" && existing.targetDigest !== targetDigest) {
      throw new Error("Plugin cache ready marker is bound to a different target digest");
    }
    for (const [field, expected] of [
      ["sourceDigest", sourceDigest],
      ["sourceBaselineRevision", sourceBaselineRevision],
      ["sourceHeadRevision", sourceHeadRevision],
      ["sourceBindingDigest", sourceBindingDigest],
      ["pluginBundleDigest", pluginBundleDigest],
      ["runId", runId],
      ["attemptId", attemptId],
      ["providerReceiptDigest", providerReceiptDigest]
    ]) {
      if (
        existing?.[field] !== null &&
        existing?.[field] !== undefined &&
        expected !== null &&
        expected !== undefined &&
        existing[field] !== expected
      ) {
        throw new Error(`Plugin cache ready marker ${field} binding changed`);
      }
    }
    if (beforeMarkerCommit) await beforeMarkerCommit({ target, targetDigest });
    const written = await writePublicationMarker({
      cacheRoot: root,
      cacheRootIdentity,
      version,
      state: "ready",
      targetDigest,
      sourceDigest,
      sourceBaselineRevision,
      sourceHeadRevision,
      sourceBindingDigest,
      pluginBundleDigest,
      runId,
      attemptId,
      providerReceiptDigest,
      guardTarget: target,
      guardInfo: targetSnapshot.info
    });
    const postCommitDigest = await withPinnedCacheRoot(root, cacheRootIdentity, ({ pinned }) => pinnedBundleDigest(pinned, target));
    if (postCommitDigest !== targetDigest) {
      await removeOwnedPublicationMarker(root, version, written, cacheRootIdentity).catch(() => false);
      throw new Error("Plugin cache ready marker target changed after guarded commit");
    }
    return written;
  } finally {
    await lock.close().catch(() => undefined);
    await releasePublicationLock(lock.path, lock.ownerToken, cacheRootIdentity);
  }
}

export async function removeUnreadyPluginCachePublication({
  cacheRoot,
  version,
  target,
  targetDigest,
  runId,
  attemptId,
  beforeMarkerRemove = null,
  beforeTargetRemove = null
}) {
  const root = (await assertStableCacheRoot(path.resolve(cacheRoot))).path;
  if (target !== path.join(root, version)) {
    throw new Error("Plugin cache cleanup target is not canonical");
  }
  const cacheRootIdentity = await assertStableCacheRoot(root);
  if (typeof runId !== "string" || !runId || typeof attemptId !== "string" || !attemptId) {
    throw new Error("Plugin cache cleanup requires an exact run and action attempt");
  }
  if (beforeMarkerRemove !== null && typeof beforeMarkerRemove !== "function") {
    throw new Error("Plugin cache cleanup beforeMarkerRemove hook must be a function");
  }
  if (beforeTargetRemove !== null && typeof beforeTargetRemove !== "function") {
    throw new Error("Plugin cache cleanup beforeTargetRemove hook must be a function");
  }
  const lock = await acquirePublicationLock(root, version, { cacheRootIdentity });
  let removedMarker = null;
  try {
    const marker = await readPublicationMarker(root, version, cacheRootIdentity);
    if (
      !marker ||
      marker.state !== "pending" ||
      marker.targetDigest !== targetDigest ||
      marker.runId !== runId ||
      marker.attemptId !== attemptId
    ) {
      throw new Error("Refusing to remove a cache target without its exact owned pending publication marker");
    }
    const targetInfo = await withPinnedCacheRoot(root, cacheRootIdentity, ({ pinned }) => pinned.lstat(target));
    const actualTargetDigest = await withPinnedCacheRoot(root, cacheRootIdentity, ({ pinned }) => pinnedBundleDigest(pinned, target));
    if (actualTargetDigest !== targetDigest) {
      throw new Error("Refusing to remove a cache target whose digest changed");
    }
    if (beforeMarkerRemove) await beforeMarkerRemove({ marker, target, targetDigest });
    if (!await removeOwnedPublicationMarker(root, version, marker, cacheRootIdentity)) {
      throw new Error("Refusing to remove a cache target after publication marker ownership changed");
    }
    removedMarker = marker;
    await assertStableCacheRoot(root, cacheRootIdentity);
    if (beforeTargetRemove) await beforeTargetRemove({ marker, target, targetDigest });
    if (!await removePinnedLeafIfMatch({
      cacheRoot: root,
      cacheRootIdentity,
      target,
      expectedInfo: targetInfo,
      foreignPrefix: version
    })) {
      throw new Error("Refusing to remove a cache target that disappeared during guarded cleanup");
    }
    return { removed: true, target, marker: publicationMarkerPath(root, version) };
  } catch (error) {
    if (removedMarker && !await readPublicationMarker(root, version, cacheRootIdentity)) {
      await assertStableCacheRoot(root, cacheRootIdentity)
        .then(() => writePublicationMarker({ cacheRoot: root, cacheRootIdentity, ...removedMarker }))
        .catch(() => undefined);
    }
    throw error;
  } finally {
    await lock.close().catch(() => undefined);
    await releasePublicationLock(lock.path, lock.ownerToken, cacheRootIdentity);
  }
}

export async function verifyPluginCacheReady({
  cacheRoot,
  version,
  target,
  targetDigest,
  sourceDigest = null,
  sourceBaselineRevision = null,
  sourceHeadRevision = null,
  sourceBindingDigest = null,
  pluginBundleDigest = null,
  runId = null,
  attemptId = null,
  providerReceiptDigest = null
}) {
  const root = (await assertStableCacheRoot(path.resolve(cacheRoot))).path;
  if (target !== path.join(root, version)) {
    throw new Error("Plugin cache readiness target is not canonical");
  }
  const cacheRootIdentity = await assertStableCacheRoot(root);
  const marker = await readPublicationMarker(root, version, cacheRootIdentity);
  if (!marker || marker.state !== "ready" || marker.target !== target || marker.targetDigest !== targetDigest) {
    throw new Error("Plugin cache readiness marker is absent or stale");
  }
  for (const [field, expected] of [
    ["sourceDigest", sourceDigest],
    ["sourceBaselineRevision", sourceBaselineRevision],
    ["sourceHeadRevision", sourceHeadRevision],
    ["sourceBindingDigest", sourceBindingDigest],
    ["pluginBundleDigest", pluginBundleDigest],
    ["runId", runId],
    ["attemptId", attemptId],
    ["providerReceiptDigest", providerReceiptDigest]
  ]) {
    if (expected !== null && marker[field] !== expected) {
      throw new Error(`Plugin cache readiness marker ${field} binding changed`);
    }
  }
  await assertStableCacheRoot(root, cacheRootIdentity);
  const actualTargetDigest = await withPinnedCacheRoot(root, cacheRootIdentity, ({ pinned }) => pinnedBundleDigest(pinned, target));
  if (actualTargetDigest !== targetDigest) {
    throw new Error("Plugin cache readiness target digest changed");
  }
  return { ok: true, marker, targetDigest: actualTargetDigest };
}

async function assertExpectedSourceBinding(sourceRoot, expected, bundle = null) {
  if (!expected) return { sourceBinding: null, bundleDigest: bundle ?? await bundleDigest(sourceRoot) };
  // Source bindings are repository-level records. Publishing is invoked with the
  // plugin subtree, but capturing that subtree would bind the digest to a
  // different cwd and reject a valid handoff.
  const sourceBinding = await captureSourceBinding(await repositoryRootForSource(sourceRoot), {
    baseRevision: expected.sourceBaselineRevision,
    requireClean: true
  });
  if (!sourceBinding || sourceBinding.headRevision !== expected.sourceHeadRevision || sourceBinding.digest !== expected.sourceBindingDigest) {
    throw new Error("Plugin cache publication source binding changed after self-improve handoff");
  }
  const resolvedBundle = bundle ?? await bundleDigest(sourceRoot);
  if (resolvedBundle !== expected.pluginBundleDigest) {
    throw new Error("Plugin cache publication plugin bundle changed after self-improve handoff");
  }
  return { sourceBinding, bundleDigest: resolvedBundle };
}

async function createCommittedSourceSnapshot(sourceRoot, expected, cacheRoot, version, cacheRootIdentity = null) {
  const repositoryRoot = await repositoryRootForSource(sourceRoot);
  const resolvedSource = await realpath(path.resolve(sourceRoot));
  const relativeRoot = path.relative(repositoryRoot, resolvedSource).replaceAll(path.sep, "/");
  if (!relativeRoot || relativeRoot.startsWith("../") || path.isAbsolute(relativeRoot)) {
    throw new Error("Plugin cache source is not a repository-relative tree");
  }
  const snapshotRoot = path.join(cacheRoot, `.${version}.snapshot-${randomUUID()}`);
  return withPinnedCacheRoot(cacheRoot, cacheRootIdentity, async ({ pinned }) => {
    await pinned.mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
    try {
      const archived = await runSourceGit(repositoryRoot, [
        "archive",
        "--format=tar",
        expected.sourceHeadRevision,
        "--",
        relativeRoot
      ], { encoding: null });
      if (!Buffer.isBuffer(archived.stdout) || archived.stdout.length < 1) {
        throw new Error("Committed plugin cache snapshot archive was empty");
      }
      await pinned.extract(snapshotRoot, archived.stdout);
      const snapshotSource = path.join(snapshotRoot, relativeRoot);
      const snapshotInfo = await pinned.lstat(snapshotSource);
      if (!snapshotInfo.isDirectory() || snapshotInfo.isSymbolicLink()) {
        throw new Error(`Unsafe committed plugin cache snapshot source: ${snapshotSource}`);
      }
      const snapshotDigest = await pinnedBundleDigest(pinned, snapshotSource);
      if (snapshotDigest !== expected.pluginBundleDigest) {
        throw new Error("Committed plugin cache snapshot does not match self-improve handoff");
      }
      return { snapshotRoot, snapshotSource };
    } catch (error) {
      await pinned.rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export async function publishPluginCache({
  sourceRoot,
  cacheRoot,
  expectedSourceBinding = null,
  beforeRename = null,
  afterPublish = null,
  afterStaleLockValidated = null,
  beforeStaleLockRelease = null,
  publicationIdentity = null
}) {
  const expected = validateExpectedSourceBinding(expectedSourceBinding);
  if (beforeRename !== null && typeof beforeRename !== "function") {
    throw new Error("Plugin cache publication beforeRename hook must be a function");
  }
  if (afterPublish !== null && typeof afterPublish !== "function") {
    throw new Error("Plugin cache publication afterPublish hook must be a function");
  }
  if (afterStaleLockValidated !== null && typeof afterStaleLockValidated !== "function") {
    throw new Error("Plugin cache publication stale-lock validation hook must be a function");
  }
  if (beforeStaleLockRelease !== null && typeof beforeStaleLockRelease !== "function") {
    throw new Error("Plugin cache publication stale-lock release hook must be a function");
  }
  if (publicationIdentity !== null && (
    !publicationIdentity ||
    typeof publicationIdentity.runId !== "string" ||
    !publicationIdentity.runId ||
    typeof publicationIdentity.attemptId !== "string" ||
    !publicationIdentity.attemptId
  )) {
    throw new Error("Plugin cache publication identity must bind a run and action attempt");
  }
  await assertExpectedSourceBinding(sourceRoot, expected);
  const initialCacheRootPath = path.resolve(cacheRoot);
  const initialCacheRootIdentity = await pathExists(initialCacheRootPath)
    ? await assertStableCacheRoot(initialCacheRootPath)
    : null;
  const before = await checkPluginCache({ sourceRoot, cacheRoot, cacheRootIdentity: initialCacheRootIdentity });
  if (before.ok) {
    if (expected) {
      const marker = await readPublicationMarker(cacheRoot, before.version, initialCacheRootIdentity);
      if (marker?.state === "pending") {
        throw new Error("Plugin cache version has an incomplete pending publication");
      }
    }
    await assertExpectedSourceBinding(sourceRoot, expected);
    return { ...before, applied: false, noOp: true };
  }
  if (before.status === "drifted") {
    throw new Error(
      `Refusing to overwrite immutable cache version ${before.version}; bump the plugin build version`
    );
  }
  let resolvedCacheRoot = path.resolve(cacheRoot);
  await mkdir(resolvedCacheRoot, { recursive: true, mode: 0o700 });
  resolvedCacheRoot = (await assertStableCacheRoot(resolvedCacheRoot)).path;
  const cacheRootIdentity = await assertStableCacheRoot(resolvedCacheRoot);
  await assertStableCacheRoot(resolvedCacheRoot, cacheRootIdentity);
  const lockState = await acquirePublicationLock(resolvedCacheRoot, before.version, {
    cacheRootIdentity,
    afterStaleLockValidated,
    beforeStaleLockRelease
  });
  const lock = lockState;
  if (lockState.reclaimed) await removeStalePublicationArtifacts(resolvedCacheRoot, before.version, cacheRootIdentity);
  const stage = path.join(resolvedCacheRoot, `.${before.version}.stage-${randomUUID()}`);
  let snapshotRoot = null;
  let publishedTarget = false;
  let publishedPath = null;
  let publishedTargetInfo = null;
  let ownedPublicationMarker = null;
  try {
    await assertStableCacheRoot(resolvedCacheRoot, cacheRootIdentity);
    const lockedBefore = await checkPluginCache({ sourceRoot, cacheRoot: resolvedCacheRoot, cacheRootIdentity });
    // `checkPluginCache` may run before a missing cache root exists and thus
    // return the caller's lexical `/var/...` spelling.  After mkdir the root
    // is canonicalized (for example to `/private/var/...` on macOS).  Compare
    // the immutable version and canonical target derived from the locked root,
    // rather than treating an equivalent alias spelling as a source mutation.
    if (
      lockedBefore.version !== before.version ||
      lockedBefore.target !== path.join(resolvedCacheRoot, before.version)
    ) {
      throw new Error(
        `Plugin source version changed while acquiring publication lock: ${before.version} -> ${lockedBefore.version}`
      );
    }
    await assertExpectedSourceBinding(sourceRoot, expected, lockedBefore.sourceDigest);
    if (lockedBefore.ok) {
      if (expected) {
        const marker = await readPublicationMarker(resolvedCacheRoot, lockedBefore.version, cacheRootIdentity);
        if (marker?.state === "pending") {
          throw new Error("Plugin cache version has an incomplete pending publication");
        }
      }
      await assertExpectedSourceBinding(sourceRoot, expected);
      return { ...lockedBefore, applied: false, noOp: true };
    }
    if (lockedBefore.status !== "missing") {
      throw new Error(
        `Refusing to overwrite immutable cache version ${lockedBefore.version}; bump the plugin build version`
      );
    }
    const expectedBundleDigest = expected?.pluginBundleDigest ?? lockedBefore.sourceDigest;
    const existingMarker = await readPublicationMarker(resolvedCacheRoot, lockedBefore.version, cacheRootIdentity);
    if (existingMarker && !pendingMarkerMatchesPublication(existingMarker, {
      cacheRoot: resolvedCacheRoot,
      version: lockedBefore.version,
      targetDigest: expectedBundleDigest,
      expectedSourceBinding: expected,
      publicationIdentity
    })) {
      throw new Error("Plugin cache existing pending publication marker is not bound to this action attempt");
    }
    const snapshot = expected
      ? await createCommittedSourceSnapshot(sourceRoot, expected, resolvedCacheRoot, before.version, cacheRootIdentity)
      : null;
    snapshotRoot = snapshot?.snapshotRoot ?? null;
    let stagedDigest;
    await withPinnedCacheRoot(resolvedCacheRoot, cacheRootIdentity, async ({ pinned }) => {
      await pinned.mkdir(stage, { mode: 0o700 });
      const source = snapshot ? snapshot.snapshotSource : path.resolve(sourceRoot);
      await copyBundlePinned(pinned, source, stage, "", Boolean(snapshot));
      const stagedManifest = await createPinnedBundleManifest(pinned, stage);
      stagedDigest = digestObject(stagedManifest);
    });
    if (stagedDigest !== expectedBundleDigest) {
      throw new Error("Staged plugin cache digest does not match source");
    }
    const stagedSource = expected ? await assertExpectedSourceBinding(sourceRoot, expected) : null;
    if (stagedSource && stagedSource.bundleDigest !== expectedBundleDigest) {
      throw new Error("Plugin source changed during cache staging");
    }
    const targetExists = await withPinnedCacheRoot(resolvedCacheRoot, cacheRootIdentity, async ({ pinned }) => {
      try {
        await pinned.lstat(lockedBefore.target);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    });
    if (targetExists) {
      throw new Error(`Plugin cache target appeared during publication: ${lockedBefore.target}`);
    }
    await assertExpectedSourceBinding(sourceRoot, expected, expectedBundleDigest);
    ownedPublicationMarker = await writePublicationMarker({
      cacheRoot: resolvedCacheRoot,
      cacheRootIdentity,
      version: lockedBefore.version,
      state: "pending",
      targetDigest: expectedBundleDigest,
      sourceDigest: expectedBundleDigest,
      sourceBaselineRevision: expected?.sourceBaselineRevision ?? null,
      sourceHeadRevision: expected?.sourceHeadRevision ?? null,
      sourceBindingDigest: expected?.sourceBindingDigest ?? null,
      pluginBundleDigest: expected?.pluginBundleDigest ?? expectedBundleDigest,
      runId: publicationIdentity?.runId ?? null,
      attemptId: publicationIdentity?.attemptId ?? null
    });
    if (beforeRename) await beforeRename({ target: lockedBefore.target, stage, cacheRoot: resolvedCacheRoot, sourceBinding: expected });
    const stagedInfo = await withPinnedCacheRoot(resolvedCacheRoot, cacheRootIdentity, ({ pinned }) => pinned.lstat(stage));
    await withPinnedCacheRoot(resolvedCacheRoot, cacheRootIdentity, ({ pinned }) => pinned.rename(stage, lockedBefore.target));
    publishedTarget = true;
    publishedPath = lockedBefore.target;
    publishedTargetInfo = stagedInfo;
    const targetDigest = await withPinnedCacheRoot(resolvedCacheRoot, cacheRootIdentity, ({ pinned }) => pinnedBundleDigest(pinned, lockedBefore.target));
    if (targetDigest !== expectedBundleDigest) {
      throw new Error("Published plugin cache failed exact target verification");
    }
    if (afterPublish) await afterPublish({ target: lockedBefore.target, targetDigest, targetInfo: stagedInfo });
    await assertExpectedSourceBinding(sourceRoot, expected, targetDigest);
    // An expected handoff is an immutable commit snapshot. The source checkout
    // may advance after the last pre-rename check; that cannot change the bytes
    // already staged from the reviewed commit. Provider reconciliation performs
    // the live source-binding check before declaring the action successful.
    const after = expected
      ? {
          ...lockedBefore,
          ok: true,
          status: "identical",
          sourceDigest: expectedBundleDigest,
          targetDigest,
          diff: { missing: [], extra: [], changed: [] }
        }
      : await checkPluginCache({ sourceRoot, cacheRoot: resolvedCacheRoot, cacheRootIdentity });
    if (!after.ok) throw new Error("Published plugin cache failed exact verification");
    return { ...after, applied: true, noOp: false };
  } catch (error) {
    let rollbackError = null;
    if (publishedTarget) {
      try {
        if (!publishedTargetInfo || !await removePinnedLeafIfMatch({
          cacheRoot: resolvedCacheRoot,
          cacheRootIdentity,
          target: publishedPath,
          expectedInfo: publishedTargetInfo,
          foreignPrefix: `${before.version}.rollback`
        })) {
          throw new Error(`Plugin cache publication target disappeared during guarded rollback: ${publishedPath}`);
        }
      } catch (candidate) {
        rollbackError = candidate;
      }
    }
    await removeOwnedPublicationMarker(
      resolvedCacheRoot,
      before.version,
      ownedPublicationMarker,
      cacheRootIdentity
    ).catch(() => undefined);
    await withPinnedCacheRoot(resolvedCacheRoot, cacheRootIdentity, ({ pinned }) => pinned.rm(stage, { recursive: true, force: true })).catch(() => undefined);
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Plugin cache publication failed and target rollback also failed: ${publishedPath}`
      );
    }
    throw error;
  } finally {
    if (snapshotRoot) await withPinnedCacheRoot(resolvedCacheRoot, cacheRootIdentity, ({ pinned }) => pinned.rm(snapshotRoot, { recursive: true, force: true })).catch(() => undefined);
    await lock.close().catch(() => undefined);
    await releasePublicationLock(lock.path, lock.ownerToken, cacheRootIdentity);
  }
}

export async function recoverPendingPluginCachePublication({
  sourceRoot,
  cacheRoot,
  expectedSourceBinding,
  runId,
  attemptId,
  beforeLock = null,
  afterLock = null
}) {
  const expected = validateExpectedSourceBinding(expectedSourceBinding);
  if (!expected || typeof runId !== "string" || !runId || typeof attemptId !== "string" || !attemptId) {
    throw new Error("Pending plugin cache recovery requires an exact source binding, run, and action attempt");
  }
  if (beforeLock !== null && typeof beforeLock !== "function") {
    throw new Error("Pending plugin cache recovery beforeLock hook must be a function");
  }
  if (afterLock !== null && typeof afterLock !== "function") {
    throw new Error("Pending plugin cache recovery afterLock hook must be a function");
  }
  const resolvedCacheRoot = path.resolve(cacheRoot);
  // Recovery is an authority path too: bind the cache-root and every ancestor
  // before the first marker/target read and carry that exact identity through
  // the lease, reconciliation, and release.  A replacement tree must never
  // become the new recovery target merely because it appeared mid-flight.
  const cacheRootIdentity = await assertStableCacheRoot(resolvedCacheRoot);
  await assertExpectedSourceBinding(sourceRoot, expected);
  const current = await checkPluginCache({ sourceRoot, cacheRoot: resolvedCacheRoot, cacheRootIdentity });
  if (!current.ok || current.status !== "identical") {
    throw new Error("Pending plugin cache recovery requires an exact published target");
  }
  const marker = await readPublicationMarker(resolvedCacheRoot, current.version, cacheRootIdentity);
  if (
    !marker ||
    marker.state !== "pending" ||
    marker.target !== current.target ||
    marker.targetDigest !== current.targetDigest ||
    marker.sourceDigest !== expected.pluginBundleDigest ||
    marker.sourceBaselineRevision !== expected.sourceBaselineRevision ||
    marker.sourceHeadRevision !== expected.sourceHeadRevision ||
    marker.sourceBindingDigest !== expected.sourceBindingDigest ||
    marker.pluginBundleDigest !== expected.pluginBundleDigest ||
    marker.runId !== runId ||
    marker.attemptId !== attemptId
  ) {
    throw new Error("Pending plugin cache publication marker is not bound to this action attempt");
  }
  if (beforeLock !== null) {
    await beforeLock({ marker, current });
  }
  const lock = await acquirePublicationLock(resolvedCacheRoot, current.version, { cacheRootIdentity });
  try {
    if (afterLock) await afterLock({ lock, marker, current, cacheRootIdentity });
    await assertStableCacheRoot(resolvedCacheRoot, cacheRootIdentity);
    if (lock.reclaimed) await removeStalePublicationArtifacts(resolvedCacheRoot, current.version, cacheRootIdentity);
    await assertExpectedSourceBinding(sourceRoot, expected);
    const lockedCurrent = await checkPluginCache({ sourceRoot, cacheRoot: resolvedCacheRoot, cacheRootIdentity });
    if (!lockedCurrent.ok || lockedCurrent.status !== "identical" ||
        lockedCurrent.version !== current.version || lockedCurrent.target !== current.target) {
      throw new Error("Pending plugin cache recovery state changed while acquiring its publication lease");
    }
    const lockedMarker = await readPublicationMarker(resolvedCacheRoot, lockedCurrent.version, cacheRootIdentity);
    if (
      !lockedMarker ||
      lockedMarker.state !== "pending" ||
      lockedMarker.target !== lockedCurrent.target ||
      lockedMarker.targetDigest !== lockedCurrent.targetDigest ||
      lockedMarker.sourceDigest !== expected.pluginBundleDigest ||
      lockedMarker.sourceBaselineRevision !== expected.sourceBaselineRevision ||
      lockedMarker.sourceHeadRevision !== expected.sourceHeadRevision ||
      lockedMarker.sourceBindingDigest !== expected.sourceBindingDigest ||
      lockedMarker.pluginBundleDigest !== expected.pluginBundleDigest ||
      lockedMarker.runId !== runId ||
      lockedMarker.attemptId !== attemptId
    ) {
      throw new Error("Pending plugin cache publication marker changed while acquiring its publication lease");
    }
    return { ...lockedCurrent, applied: true, noOp: false, recovered: true, status: "identical" };
  } finally {
    await lock.close().catch(() => undefined);
    await releasePublicationLock(lock.path, lock.ownerToken, cacheRootIdentity);
  }
}
