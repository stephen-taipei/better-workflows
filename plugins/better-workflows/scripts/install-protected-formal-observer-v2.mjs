#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Root must launch the exact reviewed packet through the visible native
// administrator dialog. This script never invokes sudo or reads a password.
import { constants, lstatSync, openSync, fstatSync, readSync, closeSync, realpathSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function protectedPath(file, directory = false) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || /[\0\r\n]/.test(file)) throw new Error("Installer staging path is not canonical");
  let current = "/";
  for (const part of ["", ...file.slice(1).split("/")]) {
    if (part) current = path.join(current, part);
    const info = lstatSync(current), leaf = current === file;
    if (info.uid !== 0 || info.isSymbolicLink() || (info.mode & 0o022) ||
        (leaf && !directory ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) throw new Error("Installer staging/source must be physical and independently root protected");
    const output = execFileSync("/bin/ls", ["-lde", current], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } }).trimEnd();
    if (output.split("\n").length !== 1 || !/^[d-][rwxStTs-]{9}@?$/.test(output.split(/\s+/)[0])) throw new Error("Installer staging/source has an ACL or unreadable protection");
  }
  if (realpathSync(file) !== file) throw new Error("Installer staging/source physical path changed");
}
function readProtected(file, limit) {
  protectedPath(file);
  const handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(handle, { bigint: true }), size = Number(before.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new Error("Installer reviewed file exceeds bounds");
    const bytes = Buffer.alloc(size); let position = 0;
    while (position < size) { const count = readSync(handle, bytes, position, size - position, position); if (count < 1) throw new Error("Installer source changed while reading"); position += count; }
    const after = fstatSync(handle, { bigint: true }), current = lstatSync(file, { bigint: true });
    for (const key of ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "ctimeNs", "mtimeNs"]) {
      if (before[key] !== after[key] || before[key] !== current[key]) throw new Error("Installer source changed during verification");
    }
    return bytes;
  } finally { closeSync(handle); }
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function verifyBootstrap(requestPath, expectedRequestSha256) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.getuid?.() !== 0 ||
      process.execArgv.length || Object.keys(process.env).some(key => /^(?:NODE_OPTIONS|NODE_PATH|DYLD_|LD_)/.test(key))) throw new Error("Installer requires the exact clean root macOS invocation");
  const bytes = readProtected(requestPath, 1024 * 1024);
  if (digest(bytes) !== expectedRequestSha256) throw new Error("Installer reviewed request raw digest differs before imports");
  const request = JSON.parse(bytes.toString("utf8"));
  if (canonical(request) !== bytes.toString("utf8") || !Array.isArray(request.sourceManifest) ||
      request.sourceManifest.length < 1 || request.sourceManifest.length > 10000) throw new Error("Installer reviewed source manifest is missing/noncanonical");
  const root = path.join(path.dirname(requestPath), "source"), actualRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  if (root !== actualRoot) throw new Error("Installer must run from its reviewed protected source packet");
  const files = new Set(), directories = new Set([""]);
  for (const file of request.sourceManifest) {
    if (typeof file.path !== "string" || path.posix.normalize(file.path) !== file.path || path.posix.isAbsolute(file.path) ||
        file.path.split("/").some(part => !part || ["..", "."].includes(part)) || files.has(file.path)) throw new Error("Installer source manifest path is unsafe");
    files.add(file.path); let parent = path.posix.dirname(file.path);
    while (parent !== ".") { directories.add(parent); parent = path.posix.dirname(parent); }
    if (digest(readProtected(path.join(root, file.path), 64 * 1024 * 1024)) !== file.sha256) throw new Error("Installer source byte differs before imports");
  }
  const stack = [""];
  while (stack.length) {
    const relative = stack.pop(), directory = path.join(root, relative); protectedPath(directory, true);
    for (const name of readdirSync(directory)) {
      const child = relative ? `${relative}/${name}` : name, info = lstatSync(path.join(root, child));
      if (info.isDirectory() && directories.has(child)) stack.push(child);
      else if (!info.isFile() || !files.delete(child)) throw new Error("Installer transitive source namespace contains an unreviewed entry");
    }
  }
  if (files.size) throw new Error("Installer transitive source closure is incomplete");
  if (!request.runtimeLanes?.[0] || process.execPath !== request.runtimeLanes[0].path || process.versions.node !== "22.23.3") throw new Error("Installer must execute with the reviewed pinned Node 22 binary");
  for (const runtime of request.runtimeLanes) if (digest(readProtected(runtime.path, 512 * 1024 * 1024)) !== runtime.executableSha256) throw new Error("Installer runtime byte differs before imports");
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--request" || args[2] !== "--expected-request-sha256" || args[4] !== "--expected-preparation-sha256") {
    throw new Error("Usage: install-protected-formal-observer-v2.mjs --request <reviewed request.json> --expected-request-sha256 <sha256> --expected-preparation-sha256 <sha256>");
  }
  if (!/^[a-f0-9]{64}$/.test(args[3]) || !/^[a-f0-9]{64}$/.test(args[5])) throw new Error("Installer needs exact reviewed digests");
  verifyBootstrap(args[1], args[3]);
  // Every transitively loadable local byte is pinned and root protected before
  // privileged imports. Root performs the reviewed protected staging action
  // as part of the visible native administrator authorization.
  const { installFormalProtectedObserverV2 } = await import("./lib/formal-protected-observer-v2.mjs");
  const result = await installFormalProtectedObserverV2({ requestPath: args[1], expectedRequestSha256: args[3], expectedPreparationSha256: args[5] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${JSON.stringify({ schemaVersion: 2, kind: "FormalProtectedObserverInstallHoldV2", status: "HOLD",
    code: error.code ?? "EFORMAL_OBSERVER_INSTALL_INCOMPLETE", message: error.message,
    installationStatus: "INSTALL_OUTCOME_UNCONFIRMED", authority: "none", releaseEligible: false })}\n`);
}
