import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  POSIX_BEFORE_LAUNCH_MAX_MS,
  POSIX_MAX_OUTPUT_BYTES,
  createPosixOwnedProcessAdapter
} from "../lib/posix-owned-process-adapter.mjs";

const POSIX = process.platform === "darwin" || process.platform === "linux";

function context(label = "fixture") {
  const token = `${label}-${randomUUID()}`;
  return {
    schemaVersion: 1,
    handleId: `handle-${token}`,
    intentId: `intent-${token}`,
    binding: {
      runId: `run-${token}`,
      ownedResourceId: `resource-${token}`
    },
    admission: {
      schemaVersion: 1,
      kind: "ExecutionAdmissionV1",
      admissionId: `admission-${token}`
    }
  };
}

function stopRequest(handle) {
  return {
    request: {
      ownedResourceId: handle.ownedResourceId,
      runId: handle.runId,
      handleId: handle.handleId
    },
    scope: {
      runId: handle.runId,
      handleId: handle.handleId
    }
  };
}

function stopRequestForContext(value) {
  return {
    request: {
      ownedResourceId: value.binding.ownedResourceId,
      runId: value.binding.runId,
      handleId: value.handleId
    },
    scope: {
      runId: value.binding.runId,
      handleId: value.handleId
    }
  };
}

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return Boolean(await predicate());
}

async function within(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function groupAlive(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid < 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function cleanupHandle(adapter, handle) {
  if (!handle) return;
  await Promise.race([
    adapter.stopOwned(stopRequest(handle)).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 12_000))
  ]);
  if (groupAlive(handle.processGroupId)) {
    try { process.kill(-handle.processGroupId, "SIGKILL"); } catch { /* task-owned group cleanup */ }
  }
  await waitFor(async () => !pidAlive(handle.leaderPid) && !groupAlive(handle.processGroupId), 2_000);
}

async function fixture(t, label = "posix-owned-process-") {
  const root = await mkdtemp(path.join(os.tmpdir(), label));
  const adapter = createPosixOwnedProcessAdapter({ root });
  const handles = [];
  t.after(async () => {
    for (const handle of handles) await cleanupHandle(adapter, handle);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    adapter,
    track(handle) {
      handles.push(handle);
      return handle;
    }
  };
}

async function fixtureWithOptions(t, label, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), label));
  const adapter = createPosixOwnedProcessAdapter({ root, ...options });
  const handles = [];
  t.after(async () => {
    for (const handle of handles) await cleanupHandle(adapter, handle);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    adapter,
    track(handle) {
      handles.push(handle);
      return handle;
    }
  };
}

async function removeFixtureRootIfVerified(root, cleanupVerified) {
  if (!cleanupVerified) return false;
  await rm(root, { recursive: true, force: true });
  return true;
}

async function guardedFixtureWithOptions(t, label, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), label));
  const adapter = createPosixOwnedProcessAdapter({ root, ...options });
  const handles = [];
  let cleanupVerified = false;
  const markCleanupVerified = () => {
    cleanupVerified = true;
  };
  t.after(async () => {
    let cleanupError = null;
    for (const handle of handles) {
      try {
        await cleanupHandle(adapter, handle);
      } catch (error) {
        cleanupError ||= error;
      }
    }
    if (cleanupError) throw cleanupError;
    // Failed tests deliberately retain this task-owned root for inspection;
    // removal is permitted only after the test proves adapter stop and PID/PGID absence.
    await removeFixtureRootIfVerified(root, cleanupVerified);
  });
  return {
    root,
    adapter,
    markCleanupVerified,
    track(handle) {
      handles.push(handle);
      return handle;
    }
  };
}

async function noSignalFixture(t, label = "posix-owned-no-signal-") {
  const root = await mkdtemp(path.join(os.tmpdir(), label));
  const adapter = createPosixOwnedProcessAdapter({ root });
  const handles = [];
  t.after(async () => {
    let cleanupVerified = true;
    for (const handle of handles) {
      let stop = null;
      try {
        stop = await within(adapter.stopOwned(stopRequest(handle)), 12_000, "no-signal fixture cleanup");
      } catch {
        cleanupVerified = false;
      }
      const gone = await waitFor(async () => !pidAlive(handle.leaderPid) && !groupAlive(handle.processGroupId), 2_000);
      if (stop?.localOutcome !== "stopped" || stop?.confirmedOwnedScope !== true || !gone) cleanupVerified = false;
    }
    // Never signal a group after leader proof is lost merely to remove a
    // failed fixture.  An unproven root remains available for diagnosis.
    if (cleanupVerified) await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    adapter,
    track(handle) {
      handles.push(handle);
      return handle;
    }
  };
}

async function markerReady(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function markerValue(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

const keepAlive = "setInterval(() => {}, 1000)";

test("Windows is explicitly unsupported and caller PID/flat context cannot authorize signals", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "posix-owned-unsupported-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(
    () => createPosixOwnedProcessAdapter({ root, platform: "win32" }),
    (error) => error.code === "EUNSUPPORTED_POSIX_PROCESS_ADAPTER"
  );
  if (!POSIX) return;
  const adapter = createPosixOwnedProcessAdapter({ root });
  const flat = { ...context("flat"), pid: process.pid };
  await assert.rejects(
    adapter.startOwned(flat, { command: process.execPath, args: ["-e", keepAlive], cwd: "/" }),
    (error) => error.code === "EOWNED_PROCESS_INPUT"
  );
  await assert.rejects(
    adapter.stopOwned({ request: { ...context("stop"), pid: process.pid } }),
    (error) => error.code === "EOWNED_PROCESS_INPUT"
  );
});

test("nested runtime context starts a real short child, keeps output/state private, and cleans the owned group", { skip: !POSIX }, async (t) => {
  const { root, adapter, track } = await fixture(t);
  const started = track(await adapter.startOwned(context("short"), {
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 100)"],
    cwd: "/",
    env: { POSIX_ADAPTER_FIXTURE: "short" },
    maxOutputBytes: 1024
  }));
  assert.equal(started.outcome, "success");
  assert.equal(Object.keys(started).includes("completion"), false);
  assert.equal(started.completion instanceof Promise, true);
  assert.equal(Number.isSafeInteger(started.leaderPid), true);
  const allocation = JSON.parse(await readFile(path.join(root, "posix-owned-process-v1", "allocations", `${started.allocationId}.json`), "utf8"));
  for (const forbidden of ["command", "args", "env", "stdout", "stderr", "output"]) assert.equal(Object.hasOwn(allocation, forbidden), false);
  const completion = await started.completion;
  assert.equal(completion.outcome, "stopped");
  assert.equal(completion.groupTerminated, true);
  assert.equal(await waitFor(async () => !pidAlive(started.leaderPid) && !groupAlive(started.processGroupId)), true);
  const stop = await adapter.stopOwned(stopRequest(started));
  assert.equal(stop.localOutcome, "stopped");
  assert.equal(stop.confirmedOwnedScope, true);
});

test("natural exit zero settles promptly with the target exit status and owned group cleanup", { skip: !POSIX }, async (t) => {
  const { adapter, track } = await fixture(t);
  const started = track(await adapter.startOwned(context("natural-zero"), {
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: "/"
  }));
  const completion = await within(started.completion, 5_000, "natural exit 0 completion");
  assert.equal(completion.outcome, "stopped");
  assert.equal(completion.code, 0);
  assert.equal(completion.signal, null);
  assert.equal(completion.groupTerminated, true);
  assert.equal(await waitFor(async () => !pidAlive(started.leaderPid) && !groupAlive(started.processGroupId)), true);
});

test("natural nonzero exit settles promptly and preserves the target exit status", { skip: !POSIX }, async (t) => {
  const { adapter, track } = await fixture(t);
  const started = track(await adapter.startOwned(context("natural-seven"), {
    command: process.execPath,
    args: ["-e", "process.exit(7)"],
    cwd: "/"
  }));
  const completion = await within(started.completion, 5_000, "natural exit 7 completion");
  assert.equal(completion.outcome, "stopped");
  assert.equal(completion.code, 7);
  assert.equal(completion.signal, null);
  assert.equal(completion.groupTerminated, true);
  assert.equal(await waitFor(async () => !pidAlive(started.leaderPid) && !groupAlive(started.processGroupId)), true);
});

test("output is capped and an over-limit task is stopped within its owned group", { skip: !POSIX }, async (t) => {
  const { adapter, track } = await fixture(t);
  const started = track(await adapter.startOwned(context("output"), {
    command: process.execPath,
    args: ["-e", `process.stdout.write("x".repeat(${POSIX_MAX_OUTPUT_BYTES * 2})); ${keepAlive}`],
    cwd: "/",
    maxOutputBytes: 1024
  }));
  const completion = await started.completion;
  assert.equal(completion.outcome, "stopped");
  assert.equal(completion.groupTerminated, true);
  assert.equal(completion.outputExceeded, true);
  assert.ok(Buffer.byteLength(completion.stdout) <= 1024);
});

test("TERM-resistant target and descendant require the adapter's KILL escalation and prove group absence", { skip: !POSIX }, async (t) => {
  const { root, adapter, track } = await fixture(t);
  const childPidFile = path.join(root, "descendant.pid");
  const target = [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
    "fs.writeFileSync(process.env.POSIX_DESCENDANT_PID_FILE,String(child.pid));",
    "process.on('SIGTERM',()=>{});",
    keepAlive
  ].join("");
  const started = track(await adapter.startOwned(context("term-resistant"), {
    command: process.execPath,
    args: ["-e", target],
    cwd: "/",
    env: { POSIX_DESCENDANT_PID_FILE: childPidFile }
  }));
  assert.equal(await waitFor(() => markerReady(childPidFile)), true);
  const descendantPid = Number(await readFile(childPidFile, "utf8"));
  assert.equal(pidAlive(descendantPid), true);
  const stop = await adapter.stopOwned(stopRequest(started));
  assert.equal(stop.localOutcome, "stopped");
  assert.equal(stop.confirmedOwnedScope, true);
  const completion = await started.completion;
  assert.equal(completion.groupTerminated, true);
  assert.equal(await waitFor(async () => !pidAlive(descendantPid) && !groupAlive(started.processGroupId)), true);
});

test("spawn failure is reported without accepting a caller-selected PID", { skip: !POSIX }, async (t) => {
  const { adapter } = await fixture(t);
  const missing = path.join(os.tmpdir(), `missing-owned-command-${randomUUID()}`);
  await assert.rejects(
    adapter.startOwned(context("spawn-failure"), { command: missing, args: [], cwd: "/" }),
    (error) => error.code === "EOWNED_PROCESS_START"
  );
});

test("restart cannot recover a persisted PID and foreign process remains untouched", { skip: !POSIX }, async (t) => {
  const { root, adapter, track } = await fixture(t);
  const started = track(await adapter.startOwned(context("restart"), {
    command: process.execPath,
    args: ["-e", keepAlive],
    cwd: "/"
  }));
  const restarted = createPosixOwnedProcessAdapter({ root });
  const recovered = await restarted.stopOwned(stopRequest(started));
  assert.equal(recovered.localOutcome, "unknown");
  assert.equal(recovered.confirmedOwnedScope, false);
  assert.equal(pidAlive(started.leaderPid), true);

  const foreign = spawn(process.execPath, ["-e", keepAlive], { cwd: "/", stdio: "ignore" });
  t.after(() => { if (foreign.exitCode === null) foreign.kill("SIGKILL"); });
  await new Promise((resolve, reject) => {
    foreign.once("spawn", resolve);
    foreign.once("error", reject);
  });
  const foreignStop = await adapter.stopOwned({
    request: { ownedResourceId: `foreign-${randomUUID()}`, runId: "foreign-run", handleId: "foreign-handle" }
  });
  assert.equal(foreignStop.localOutcome, "unknown");
  assert.equal(pidAlive(foreign.pid), true);
});

test("restart cannot promote a persisted terminal group flag without a live adapter receipt", { skip: !POSIX }, async (t) => {
  const { root, adapter, track } = await fixture(t);
  const started = track(await adapter.startOwned(context("restart-terminal"), {
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 100)"],
    cwd: "/"
  }));
  const completion = await within(started.completion, 5_000, "terminal restart fixture completion");
  assert.equal(completion.outcome, "stopped");
  assert.equal(completion.groupTerminated, true);
  const record = JSON.parse(await readFile(path.join(root, "posix-owned-process-v1", "allocations", `${started.allocationId}.json`), "utf8"));
  assert.equal(record.phase, "terminal");
  assert.equal(record.groupTerminated, true);

  const restarted = createPosixOwnedProcessAdapter({ root });
  const recovered = await restarted.stopOwned(stopRequest(started));
  assert.equal(recovered.localOutcome, "unknown");
  assert.equal(recovered.confirmedOwnedScope, false);
});

test("leader death with a live descendant is indeterminate until independent group absence is proven", { skip: !POSIX }, async (t) => {
  const { root, adapter, track } = await fixture(t);
  const childPidFile = path.join(root, "leader-death-descendant.pid");
  const target = [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    "const child=spawn(process.execPath,['-e',\"setInterval(()=>{},1000)\"],{stdio:'ignore'});",
    "fs.writeFileSync(process.env.POSIX_LEADER_DEATH_PID_FILE,String(child.pid));",
    keepAlive
  ].join("");
  const started = track(await adapter.startOwned(context("leader-death"), {
    command: process.execPath,
    args: ["-e", target],
    cwd: "/",
    env: { POSIX_LEADER_DEATH_PID_FILE: childPidFile }
  }));
  assert.equal(await waitFor(() => markerReady(childPidFile)), true);
  const descendantPid = Number(await readFile(childPidFile, "utf8"));
  assert.equal(pidAlive(descendantPid), true);
  process.kill(started.leaderPid, "SIGKILL");
  assert.equal(await waitFor(() => !pidAlive(started.leaderPid)), true);
  assert.equal(pidAlive(descendantPid), true);
  const stop = await adapter.stopOwned(stopRequest(started));
  assert.equal(stop.localOutcome, "indeterminate");
  assert.equal(stop.confirmedOwnedScope, false);
  assert.equal(pidAlive(descendantPid), true);
  // The group is task-owned through the started handle; clean it explicitly
  // after asserting that the adapter did not mistake leader death for absence.
  if (groupAlive(started.processGroupId)) process.kill(-started.processGroupId, "SIGKILL");
  await waitFor(async () => !pidAlive(descendantPid) && !groupAlive(started.processGroupId), 3_000);
});

test("leader death with a transiently live group waits for absence without signaling", { skip: !POSIX }, async (t) => {
  const { root, adapter, track } = await noSignalFixture(t, "posix-owned-leader-loss-transient-");
  const readyMarker = path.join(root, "ready.marker");
  const naturalExitMarker = path.join(root, "natural-exit.marker");
  const signalMarker = path.join(root, "signal.marker");
  const target = [
    "const fs=require('node:fs');",
    `process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(signalMarker)},'term'));`,
    `fs.writeFileSync(${JSON.stringify(readyMarker)},'ready');`,
    `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(naturalExitMarker)},'natural'); process.exit(0);},1500);`,
    keepAlive
  ].join("");
  const started = track(await adapter.startOwned(context("leader-loss-transient"), {
    command: process.execPath,
    args: ["-e", target],
    cwd: "/"
  }));
  assert.equal(await waitFor(async () => (await markerValue(readyMarker)) === "ready", 2_000), true);
  process.kill(started.leaderPid, "SIGKILL");
  assert.equal(await waitFor(() => !pidAlive(started.leaderPid), 2_000), true);
  assert.equal(groupAlive(started.processGroupId), true);

  const stop = await within(adapter.stopOwned(stopRequest(started)), 5_000, "leader-loss transient stop");
  assert.equal(stop.localOutcome, "stopped");
  assert.equal(stop.confirmedOwnedScope, true);
  assert.equal(await markerValue(naturalExitMarker), "natural");
  assert.equal(await markerValue(signalMarker), null);
  const completion = await within(started.completion, 5_000, "leader-loss transient completion");
  assert.equal(completion.outcome, "stopped");
  assert.equal(completion.groupTerminated, true);
  assert.equal(await waitFor(async () => !pidAlive(started.leaderPid) && !groupAlive(started.processGroupId), 2_000), true);
});

test("allocation persistence failure still settles stop and completion without false stopped", { skip: !POSIX }, async (t) => {
  const { root, adapter, track } = await fixture(t);
  const started = track(await adapter.startOwned(context("persist-failure"), {
    command: process.execPath,
    args: ["-e", keepAlive],
    cwd: "/"
  }));
  const allocationFile = path.join(root, "posix-owned-process-v1", "allocations", `${started.allocationId}.json`);
  const backupFile = `${allocationFile}.fault-backup`;
  // Replace only this task-owned allocation record with a directory. The
  // adapter's private writer must fail safely without admin/root privileges.
  await rename(allocationFile, backupFile);
  await mkdir(allocationFile, { mode: 0o700 });
  const stop = await within(adapter.stopOwned(stopRequest(started)), 5_000, "stop after allocation persistence fault");
  assert.notEqual(stop.localOutcome, "stopped");
  const completion = await within(started.completion, 5_000, "completion after allocation persistence fault");
  assert.notEqual(completion.outcome, "stopped");
});

test("startup stop reservation prevents a late target dispatch", { skip: !POSIX }, async (t) => {
  const { root, adapter, track } = await fixture(t, "posix-owned-start-stop-race-");
  const marker = path.join(root, "late-target.marker");
  const value = context("startup-cancel");
  const startPromise = adapter.startOwned(value, {
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); ${keepAlive}`],
    cwd: "/"
  });
  // startOwned reserves the resource before its first filesystem await.  The
  // immediate stop must therefore cancel the same reservation, even though
  // no durable allocation or supervisor exists yet.
  const stopPromise = adapter.stopOwned(stopRequestForContext(value));
  const [startState, stop] = await Promise.all([
    startPromise.then((result) => {
      if (result) track(result);
      return { result };
    }, (error) => ({ error })),
    within(stopPromise, 5_000, "startup cancellation stop")
  ]);
  assert.equal(Boolean(startState.error), true);
  assert.equal(stop.localOutcome, "stopped");
  assert.equal(stop.confirmedOwnedScope, true);
  assert.equal(await waitFor(() => markerReady(marker), 250), false);
});

test("same owned resource is synchronously single-use while the first start is pending", { skip: !POSIX }, async (t) => {
  const { adapter, track } = await fixture(t, "posix-owned-duplicate-resource-");
  const value = context("duplicate-resource");
  const options = {
    command: process.execPath,
    args: ["-e", keepAlive],
    cwd: "/"
  };
  const firstPromise = adapter.startOwned(value, options);
  const duplicatePromise = adapter.startOwned(value, options);
  const [firstState, duplicateState] = await Promise.all([
    firstPromise.then((result) => {
      if (result) track(result);
      return { result };
    }, (error) => ({ error })),
    duplicatePromise.then((result) => {
      if (result) track(result);
      return { result };
    }, (error) => ({ error }))
  ]);
  assert.equal(Boolean(firstState.result), true);
  const first = firstState.result;
  assert.equal(Boolean(duplicateState.error), true);
  assert.equal(duplicateState.error.code, "EOWNED_PROCESS_DUPLICATE");
  const stop = await within(adapter.stopOwned(stopRequest(first)), 5_000, "duplicate-resource cleanup");
  assert.equal(stop.localOutcome, "stopped");
  assert.equal(stop.confirmedOwnedScope, true);
  const completion = await within(first.completion, 5_000, "duplicate-resource completion");
  assert.equal(completion.groupTerminated, true);
});

test("cancellation after supervisor spawn but before target readiness cannot dispatch the target", { skip: !POSIX }, async (t) => {
  let supervisor = null;
  let releaseInput = () => {};
  let resolveSpawned;
  const spawned = new Promise((resolve) => { resolveSpawned = resolve; });
  const spawnImpl = (...args) => {
    const child = spawn(...args);
    supervisor = child;
    const input = child.stdin;
    if (input) {
      const write = input.write.bind(input);
      const end = input.end.bind(input);
      const pending = [];
      let released = false;
      const flush = () => {
        if (released) return;
        released = true;
        while (pending.length) {
          try { pending.shift()(); } catch { /* task-owned supervisor may already be gone */ }
        }
      };
      releaseInput = flush;
      input.write = (...writeArgs) => {
        if (released) return write(...writeArgs);
        pending.push(() => write(...writeArgs));
        return true;
      };
      input.end = (...endArgs) => {
        if (released) return end(...endArgs);
        pending.push(() => end(...endArgs));
        return input;
      };
    }
    resolveSpawned(child);
    return child;
  };
  const { root, adapter, track } = await fixtureWithOptions(t, "posix-owned-ready-cancel-", { spawnImpl });
  t.after(async () => {
    releaseInput();
    if (supervisor && supervisor.exitCode === null && Number.isSafeInteger(supervisor.pid)) {
      try { process.kill(-supervisor.pid, "SIGKILL"); } catch { /* task-owned supervisor cleanup */ }
    }
    if (supervisor) assert.equal(await waitFor(() => !pidAlive(supervisor.pid) && !groupAlive(supervisor.pid), 2_000), true);
  });
  const marker = path.join(root, "ready-cancel-target.marker");
  const value = context("ready-cancel");
  const startPromise = adapter.startOwned(value, {
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); ${keepAlive}`],
    cwd: "/"
  }).then((result) => {
    if (result) track(result);
    return { result };
  }, (error) => ({ error }));
  await within(spawned, 2_000, "supervisor spawn");
  const stopPromise = adapter.stopOwned(stopRequestForContext(value));
  // Let the repaired two-phase protocol observe the sticky cancellation.  If
  // the supervisor was already killed, these writes are harmlessly ignored.
  releaseInput();
  const [startState, stop] = await Promise.all([
    startPromise,
    within(stopPromise, 5_000, "ready-before-target cancellation")
  ]);
  assert.equal(Boolean(startState.error), true);
  assert.equal(stop.localOutcome, "stopped");
  assert.equal(stop.confirmedOwnedScope, true);
  assert.equal(await waitFor(() => markerReady(marker), 250), false);
});

test("different resources reserve concurrently on a fresh adapter root", { skip: !POSIX }, async (t) => {
  const { adapter, track } = await fixture(t, "posix-owned-fresh-root-race-");
  const firstValue = context("fresh-one");
  const secondValue = context("fresh-two");
  const options = (label) => ({
    command: process.execPath,
    args: ["-e", `setTimeout(() => { process.stdout.write(${JSON.stringify(label)}); }, 20); ${keepAlive}`],
    cwd: "/"
  });
  const [firstState, secondState] = await Promise.all([
    adapter.startOwned(firstValue, options("one")).then((result) => {
      if (result) track(result);
      return { result };
    }, (error) => ({ error })),
    adapter.startOwned(secondValue, options("two")).then((result) => {
      if (result) track(result);
      return { result };
    }, (error) => ({ error }))
  ]);
  assert.equal(Boolean(firstState.result), true);
  assert.equal(Boolean(secondState.result), true);
  const first = firstState.result;
  const second = secondState.result;
  assert.notEqual(first.ownedResourceId, second.ownedResourceId);
  const [firstStop, secondStop] = await Promise.all([
    within(adapter.stopOwned(stopRequest(first)), 5_000, "fresh-root first cleanup"),
    within(adapter.stopOwned(stopRequest(second)), 5_000, "fresh-root second cleanup")
  ]);
  assert.equal(firstStop.localOutcome, "stopped");
  assert.equal(secondStop.localOutcome, "stopped");
  assert.equal(firstStop.confirmedOwnedScope, true);
  assert.equal(secondStop.confirmedOwnedScope, true);
});

test("beforeLaunch timeout input accepts only positive safe milliseconds within the fixed maximum", { skip: !POSIX }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "posix-owned-before-launch-timeout-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalidValues = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    POSIX_BEFORE_LAUNCH_MAX_MS + 1,
    "2000",
    null
  ];
  for (const value of invalidValues) {
    assert.throws(
      () => createPosixOwnedProcessAdapter({ root, beforeLaunchTimeoutMs: value }),
      (error) => error?.code === "EOWNED_PROCESS_INPUT"
    );
  }
  assert.doesNotThrow(() => createPosixOwnedProcessAdapter({ root, beforeLaunchTimeoutMs: 1 }));
  assert.doesNotThrow(() => createPosixOwnedProcessAdapter({ root, beforeLaunchTimeoutMs: POSIX_BEFORE_LAUNCH_MAX_MS }));

  const guardRoot = await mkdtemp(path.join(os.tmpdir(), "posix-owned-before-launch-cleanup-guard-"));
  let guardRemoved = false;
  t.after(async () => {
    if (!guardRemoved) await removeFixtureRootIfVerified(guardRoot, false);
  });
  assert.equal(await removeFixtureRootIfVerified(guardRoot, false), false);
  await access(guardRoot);
  assert.equal(await removeFixtureRootIfVerified(guardRoot, true), true);
  guardRemoved = true;
  await assert.rejects(access(guardRoot), (error) => error?.code === "ENOENT");
});

test("beforeLaunch hook may exceed the default two seconds when its bounded timeout allows it", { skip: !POSIX }, async (t) => {
  const hookDelayMs = 2_150;
  let hookStartedAt = null;
  const beforeLaunch = async () => {
    hookStartedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, hookDelayMs));
  };
  const { root, adapter, track } = await fixtureWithOptions(t, "posix-owned-before-launch-extended-", {
    beforeLaunch,
    beforeLaunchTimeoutMs: 3_500
  });
  const marker = path.join(root, "before-launch-extended.marker");
  const started = track(await within(adapter.startOwned(context("before-launch-extended"), {
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "target-ok"); setTimeout(() => process.exit(0), 250)`],
    cwd: "/"
  }), 8_000, "extended beforeLaunch start"));
  assert.equal(typeof hookStartedAt, "number");
  assert.ok(Date.now() - hookStartedAt >= 2_000);
  assert.equal(await waitFor(async () => (await markerValue(marker)) === "target-ok", 2_000), true);
  const completion = await within(started.completion, 5_000, "extended beforeLaunch completion");
  assert.equal(completion.outcome, "stopped");
  assert.equal(completion.code, 0);
  assert.equal(completion.groupTerminated, true);
  assert.equal(await waitFor(async () => !pidAlive(started.leaderPid) && !groupAlive(started.processGroupId), 2_000), true);
});

test("short beforeLaunch timeout rejects and cannot dispatch after the hook settles", { skip: !POSIX }, async (t) => {
  let supervisor = null;
  let releaseHook;
  let resolveObserved;
  const observed = new Promise((resolve) => { resolveObserved = resolve; });
  const held = new Promise((resolve) => { releaseHook = resolve; });
  const beforeLaunch = () => {
    resolveObserved();
    return held;
  };
  const spawnImpl = (...args) => {
    supervisor = spawn(...args);
    return supervisor;
  };
  const { root, adapter, markCleanupVerified, track } = await guardedFixtureWithOptions(t, "posix-owned-before-launch-timeout-", {
    beforeLaunch,
    beforeLaunchTimeoutMs: 100,
    spawnImpl
  });
  const marker = path.join(root, "before-launch-timeout.marker");
  const value = context("before-launch-timeout");
  let startPromise;
  let startSettlement;
  try {
    startPromise = adapter.startOwned(value, {
      command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "target-ok"); ${keepAlive}`],
      cwd: "/"
    });
    startSettlement = startPromise.then(
      (result) => {
        if (result) track(result);
        return { result };
      },
      (error) => ({ error })
    );
    await within(observed, 2_000, "short beforeLaunch timeout hook");
    await assert.rejects(
      startPromise,
      (error) => error?.code === "EOWNED_PROCESS_START" && error?.message === "beforeLaunch timed out"
    );
    assert.equal(await markerValue(marker), null);
    if (supervisor) assert.equal(await waitFor(() => !pidAlive(supervisor.pid) && !groupAlive(supervisor.pid), 2_000), true);
    releaseHook();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await markerValue(marker), null);
  } finally {
    const stop = await within(adapter.stopOwned(stopRequestForContext(value)), 12_000, "short beforeLaunch timeout final cleanup");
    assert.equal(Boolean(supervisor), true);
    assert.equal(stop.localOutcome, "stopped");
    assert.equal(stop.confirmedOwnedScope, true);
    releaseHook?.();
    if (startSettlement) await startSettlement;
    assert.equal(await waitFor(() => !pidAlive(supervisor.pid) && !groupAlive(supervisor.pid), 2_000), true);
    markCleanupVerified();
  }
});

test("short beforeLaunch timeout remains cancellable without a late dispatch", { skip: !POSIX }, async (t) => {
  let supervisor = null;
  let releaseHook;
  let resolveObserved;
  let hookSettled = false;
  const observed = new Promise((resolve) => { resolveObserved = resolve; });
  const held = new Promise((resolve) => {
    releaseHook = () => {
      hookSettled = true;
      resolve();
    };
  });
  const beforeLaunch = () => {
    resolveObserved();
    return held;
  };
  const spawnImpl = (...args) => {
    supervisor = spawn(...args);
    return supervisor;
  };
  const { root, adapter, markCleanupVerified, track } = await guardedFixtureWithOptions(t, "posix-owned-before-launch-short-cancel-", {
    beforeLaunch,
    beforeLaunchTimeoutMs: 500,
    spawnImpl
  });
  const marker = path.join(root, "before-launch-short-cancel.marker");
  const value = context("before-launch-short-cancel");
  let startPromise;
  let startSettlement;
  try {
    startPromise = adapter.startOwned(value, {
      command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "target-ok"); ${keepAlive}`],
      cwd: "/"
    });
    startSettlement = startPromise.then(
      (result) => {
        if (result) track(result);
        return { result };
      },
      (error) => ({ error })
    );
    await within(observed, 2_000, "short beforeLaunch cancel hook");
    const stop = await within(adapter.stopOwned(stopRequestForContext(value)), 5_000, "short beforeLaunch cancel stop");
    assert.equal(hookSettled, false);
    assert.equal(stop.localOutcome, "stopped");
    assert.equal(stop.confirmedOwnedScope, true);
    await assert.rejects(startPromise, (error) => error?.code === "EOWNED_PROCESS_START_CANCELLED");
    releaseHook();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await markerValue(marker), null);
    if (supervisor) assert.equal(await waitFor(() => !pidAlive(supervisor.pid) && !groupAlive(supervisor.pid), 2_000), true);
  } finally {
    const finalStop = await within(adapter.stopOwned(stopRequestForContext(value)), 12_000, "short beforeLaunch cancel final cleanup");
    assert.equal(Boolean(supervisor), true);
    assert.equal(finalStop.localOutcome, "stopped");
    assert.equal(finalStop.confirmedOwnedScope, true);
    releaseHook?.();
    if (startSettlement) await startSettlement;
    assert.equal(await waitFor(() => !pidAlive(supervisor.pid) && !groupAlive(supervisor.pid), 2_000), true);
    markCleanupVerified();
  }
});

test("beforeLaunch can hold a target and receives an immutable full execution context", { skip: !POSIX }, async (t) => {
  let releaseHook;
  let resolveObserved;
  const observed = new Promise((resolve) => { resolveObserved = resolve; });
  const held = new Promise((resolve) => { releaseHook = resolve; });
  const beforeLaunch = (executionContext) => {
    resolveObserved(executionContext);
    return held;
  };
  const { root, adapter, track } = await fixtureWithOptions(t, "posix-owned-before-launch-held-", { beforeLaunch });
  const marker = path.join(root, "before-launch-held.marker");
  const value = context("before-launch-held");
  value.epoch = { sequence: 7, token: `epoch-${value.handleId}` };
  value.fence = { generation: 3, token: `fence-${value.handleId}` };
  const expected = structuredClone(value);
  const startPromise = adapter.startOwned(value, {
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "target-ok"); ${keepAlive}`],
    cwd: "/"
  }).then((result) => {
    if (result) track(result);
    return result;
  });
  const startSettlement = startPromise.then(
    (result) => ({ result }),
    (error) => ({ error })
  );
  try {
    const received = await within(observed, 2_000, "beforeLaunch context");
    assert.notEqual(received, value);
    assert.deepEqual(received, expected);
    assert.equal(Object.isFrozen(received), true);
    assert.equal(Object.isFrozen(received.binding), true);
    assert.equal(Object.isFrozen(received.epoch), true);
    assert.equal(Object.isFrozen(received.fence), true);
    assert.equal(Reflect.set(received.binding, "runId", "mutated"), false);
    assert.equal(received.binding.runId, value.binding.runId);
    assert.equal(await markerValue(marker), null);
    releaseHook();
    const handle = await within(startPromise, 5_000, "beforeLaunch release");
    assert.equal(await waitFor(async () => (await markerValue(marker)) === "target-ok", 2_000), true);
    const stop = await within(adapter.stopOwned(stopRequest(handle)), 5_000, "beforeLaunch held cleanup");
    assert.equal(stop.localOutcome, "stopped");
    assert.equal(stop.confirmedOwnedScope, true);
  } finally {
    releaseHook?.();
    await startSettlement;
  }
});

test("beforeLaunch rejection never dispatches the target and cleans its supervisor", { skip: !POSIX }, async (t) => {
  let supervisor = null;
  const spawnImpl = (...args) => {
    supervisor = spawn(...args);
    return supervisor;
  };
  const beforeLaunch = async () => {
    throw new Error("trusted beforeLaunch rejected");
  };
  const { root, adapter } = await fixtureWithOptions(t, "posix-owned-before-launch-reject-", { beforeLaunch, spawnImpl });
  const marker = path.join(root, "before-launch-reject.marker");
  const value = context("before-launch-reject");
  try {
    await assert.rejects(
      adapter.startOwned(value, {
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "target-ok"); ${keepAlive}`],
        cwd: "/"
      }),
      (error) => error?.message === "trusted beforeLaunch rejected"
    );
    assert.equal(await markerValue(marker), null);
    if (supervisor) assert.equal(await waitFor(() => !pidAlive(supervisor.pid) && !groupAlive(supervisor.pid), 2_000), true);
  } finally {
    if (supervisor && supervisor.exitCode === null && Number.isSafeInteger(supervisor.pid)) {
      try { process.kill(-supervisor.pid, "SIGKILL"); } catch { /* task-owned supervisor cleanup */ }
    }
    if (supervisor) await waitFor(() => !pidAlive(supervisor.pid) && !groupAlive(supervisor.pid), 2_000);
  }
});

test("pending beforeLaunch is cancelled by stop without allowing a late dispatch", { skip: !POSIX }, async (t) => {
  let supervisor = null;
  let releaseHook;
  let resolveObserved;
  let hookSettled = false;
  const observed = new Promise((resolve) => { resolveObserved = resolve; });
  const held = new Promise((resolve) => {
    releaseHook = () => {
      hookSettled = true;
      resolve();
    };
  });
  const beforeLaunch = (executionContext) => {
    assert.equal(Object.isFrozen(executionContext), true);
    resolveObserved();
    return held;
  };
  const spawnImpl = (...args) => {
    supervisor = spawn(...args);
    return supervisor;
  };
  const { root, adapter } = await fixtureWithOptions(t, "posix-owned-before-launch-cancel-", { beforeLaunch, spawnImpl });
  const marker = path.join(root, "before-launch-cancel.marker");
  const value = context("before-launch-cancel");
  let startPromise;
  let startSettlement;
  try {
    startPromise = adapter.startOwned(value, {
      command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "target-ok"); ${keepAlive}`],
      cwd: "/"
    });
    startSettlement = startPromise.then(
      (result) => ({ result }),
      (error) => ({ error })
    );
    await within(observed, 2_000, "pending beforeLaunch hook");
    const stop = await within(adapter.stopOwned(stopRequestForContext(value)), 5_000, "pending beforeLaunch stop");
    assert.equal(hookSettled, false);
    assert.equal(stop.localOutcome, "stopped");
    assert.equal(stop.confirmedOwnedScope, true);
    await assert.rejects(startPromise, (error) => error?.code === "EOWNED_PROCESS_START_CANCELLED");
    releaseHook();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await markerValue(marker), null);
    if (supervisor) assert.equal(await waitFor(() => !pidAlive(supervisor.pid) && !groupAlive(supervisor.pid), 2_000), true);
  } finally {
    releaseHook?.();
    if (startSettlement) await startSettlement;
    if (supervisor && supervisor.exitCode === null && Number.isSafeInteger(supervisor.pid)) {
      try { process.kill(-supervisor.pid, "SIGKILL"); } catch { /* task-owned supervisor cleanup */ }
    }
    if (supervisor) await waitFor(() => !pidAlive(supervisor.pid) && !groupAlive(supervisor.pid), 2_000);
  }
});

test("target environment contains only explicit entries", { skip: !POSIX }, async (t) => {
  const { root, adapter, track } = await fixture(t, "posix-owned-explicit-env-");
  const key = `BW_TEST_PARENT_ENV_${randomUUID().replaceAll("-", "")}`;
  const previous = process.env[key];
  process.env[key] = `ambient-${randomUUID()}`;
  const readEnv = (marker) => `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.env[${JSON.stringify(key)}] ?? "missing"); ${keepAlive}`;
  try {
    const absentMarker = path.join(root, "env-absent.marker");
    const absent = track(await adapter.startOwned(context("explicit-env-absent"), {
      command: process.execPath,
      args: ["-e", readEnv(absentMarker)],
      cwd: "/"
    }));
    assert.equal(await waitFor(async () => (await markerValue(absentMarker)) === "missing", 2_000), true);
    assert.equal((await adapter.stopOwned(stopRequest(absent))).localOutcome, "stopped");
    const explicitMarker = path.join(root, "env-explicit.marker");
    const explicit = track(await adapter.startOwned(context("explicit-env-visible"), {
      command: process.execPath,
      args: ["-e", readEnv(explicitMarker)],
      cwd: "/",
      env: { [key]: "explicit-value" }
    }));
    assert.equal(await waitFor(async () => (await markerValue(explicitMarker)) === "explicit-value", 2_000), true);
    assert.equal((await adapter.stopOwned(stopRequest(explicit))).localOutcome, "stopped");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});
