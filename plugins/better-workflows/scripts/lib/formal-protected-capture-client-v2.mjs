// SPDX-License-Identifier: AGPL-3.0-only
// Internal inherited control pipe only. No socket/path/environment endpoint.
// Ordinary local evaluation has no port and retains spawnCapture semantics.
// This client is not an authenticator: only the root broker's actual handles
// and complete capture transcript can make a protected signing decision.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseStrictJsonV1 } from "./strict-json-v1.mjs";
import { snapshotJsonDataV1 } from "./private-input-snapshot-v1.mjs";
let installedPort = null;
// The installed image and actual public control modules are separate ESM
// identities in one nonroot process. Share their single inherited pipe after
// kernel selection, so loading the public supervisor cannot re-handshake it.
// This cache is never evidence for root signing; the broker owns that proof.
const SHARED_PORT = Symbol.for("better-workflows.fixed-formal-capture-port-v2");
const pending = new Map();
// A workload has no IPC descriptor. Ordinary inherited IPC is not selected
// unless its actual kernel ancestry contains our fixed root keeper.
if (typeof process.send === "function" && process.channel) {
  const raw = execFileSync("/bin/ps", ["-axo", "uid=,pid=,ppid=,command="], {
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
  const table = new Map(raw.trim().split("\n").map(line => {
    const found = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+(.+)$/.exec(line);
    return found ? [Number(found[2]), { uid: Number(found[1]), ppid: Number(found[3]), command: found[4] }] : [0, null];
  }));
  let cursor = process.ppid, selectedKeeper = null;
  const visited = new Set();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor); const row = table.get(cursor);
    if (!row) break;
    if (row.uid === 0 && row.command.includes("BW_FIXED_ROOT_FORMAL_KEEPER_V2")) {
      // A Node test runner can create its own IPC below a workload. Its
      // closest keeper explicitly has control:false and never grants a port.
      if (row.command.includes('"control":true')) selectedKeeper = cursor;
      break;
    }
    cursor = row.ppid;
  }
  if (selectedKeeper !== null) {
    const existing = globalThis[SHARED_PORT];
    if (existing !== undefined) {
      if (existing.peerPid !== process.pid || existing.keeperPid !== selectedKeeper ||
          typeof existing.port?.capture !== "function") throw new Error("Inherited capture pipe cache changed identity");
      installedPort = existing.port;
    } else {
      const init = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Protected capture initialization was not observed")), 10_000);
        const onInit = message => {
          if (message?.kind !== "FormalBrokerInitV2") return;
          clearTimeout(timer); process.off("message", onInit); resolve(message);
        };
        process.on("message", onInit);
        process.send({ kind: "FormalBrokerHelloV2", pid: process.pid, keeperPid: selectedKeeper });
      });
      const context = Object.freeze(parseStrictJsonV1(JSON.stringify(init.context), { maxBytes: 16 * 1024 }));
      if (init.keeperPid !== selectedKeeper || init.peerPid !== process.pid || context.uid !== process.getuid() || context.gid !== process.getgid() ||
          process.getgroups().some(group => group !== context.gid)) {
        throw new Error("Root keeper initialization changed actual peer identity");
      }
      process.on("message", message => {
        if (message?.kind !== "FormalBrokerReplyV2" || !pending.has(message.id)) return;
        const entry = pending.get(message.id); pending.delete(message.id);
        if (pending.size === 0) process.channel?.unref();
        if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.value);
      });
      process.on("disconnect", () => { for (const entry of pending.values()) entry.reject(new Error("Root capture channel disconnected")); pending.clear(); });
      process.channel.unref();
      const request = (operation, value) => new Promise((resolve, reject) => {
        const id = randomBytes(16).toString("hex"); pending.set(id, { resolve, reject }); process.channel?.ref();
        process.send({ kind: "FormalBrokerRequestV2", id, operation, value }, error => {
          if (!error) return; pending.delete(id); if (pending.size === 0) process.channel?.unref(); reject(error);
        });
      });
      installedPort = Object.freeze({ context,
        assertOuterOwner: pid => request("assert-outer-owner", { outerOwnerPid: pid }),
        async capture(command, args, options = {}) {
          const { abortSignal, onSpawn, encoding = "utf8", ...data } = options;
          if (onSpawn != null) throw new Error("Protected capture has no caller launch hook");
          const copied = snapshotJsonDataV1({ command, args, ...data, input: data.input === undefined ? null :
            Buffer.from(data.input).toString("base64") }, { maxBytes: 128 * 1024 });
          const captureId = randomBytes(16).toString("hex"); copied.captureId = captureId;
          const abort = () => process.send({ kind: "FormalBrokerCancelV2", captureId });
          if (abortSignal?.aborted) throw new Error("Protected capture cancelled before dispatch");
          abortSignal?.addEventListener("abort", abort, { once: true });
          try {
            const result = await request("capture", copied);
            const stdout = Buffer.from(result.stdout, "base64"), stderr = Buffer.from(result.stderr, "base64");
            if (stdout.toString("base64") !== result.stdout || stderr.toString("base64") !== result.stderr) throw new Error("Root capture raw bytes are invalid");
            return { ...result, stdout: encoding === null ? stdout : stdout.toString(encoding), stderr: encoding === null ? stderr : stderr.toString(encoding) };
          } finally { abortSignal?.removeEventListener("abort", abort); }
        }
      });
      Object.defineProperty(globalThis, SHARED_PORT, { value: Object.freeze({ peerPid: process.pid,
        keeperPid: selectedKeeper, port: installedPort }), writable: false, configurable: false, enumerable: false });
    }
  }
}
function port() { return installedPort; }
export function formalProtectedCaptureClientV2() {
  const selected = port();
  return selected ? selected.capture : null;
}
export function formalProtectedCaptureContextV2() {
  return port()?.context ?? null;
}
export async function assertFormalProtectedOuterOwnerV2(outerOwnerPid) {
  const selected = port();
  if (!selected) return false;
  await selected.assertOuterOwner(outerOwnerPid);
  return true;
}
export function formalProtectedGitArgumentsV2(args, cwd) {
  const selected = port();
  if (!selected) return args;
  if (cwd !== selected.context.executionSourceRoot) throw new Error("Protected Git wrapper only admits the independently installed execution root");
  return ["-c", `safe.directory=${selected.context.executionSourceRoot}`, ...args];
}
export function formalProtectedGitExecutableV2(ordinaryPath) {
  return port() ? "/usr/bin/git" : ordinaryPath;
}
export function assertFormalProtectedInvocationV2(request) {
  const context = formalProtectedCaptureContextV2();
  if (!context) return;
  if (request.expectedHead !== context.expectedHead || request.expectedBase !== context.expectedBase ||
      request.cwd !== context.executionSourceRoot || request.launchRoot !== context.launchRoot ||
      request.ownerHome !== undefined && request.ownerHome !== context.ownerHome ||
      JSON.stringify(request.nodePaths) !== JSON.stringify(context.nodePaths)) throw new Error("Formal invocation differs from the root-owned capture job");
}
