// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { readFile, lstat, readlink, realpath } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalJson, digestObject, sha256 } from "../lib/core.mjs";
import { RC_SOURCE_GIT_EXECUTABLE_V1, RC_SOURCE_GIT_EXEC_PATH_V1,
  assertInstalledRcSourceGitScopeV1 } from "../lib/git.mjs";
import { assertRootOwnedRuntimePathV2, observeRootOwnedRuntimeFileV2 } from "../lib/runtime-qualification-v2.mjs";
import { appendW5PublicationOperationEventV1 } from "../lib/w5-publication-operation-v1.mjs";

const D = "a".repeat(64), CHANGED = "b".repeat(64);
const HTTP = `${RC_SOURCE_GIT_EXEC_PATH_V1}/git-remote-http`;
const HTTPS = `${RC_SOURCE_GIT_EXEC_PATH_V1}/git-remote-https`;
const identity = () => ["1", "2", "3", "33261", "0", "1", "4", "5"];
const originalGit = await readFile(new URL("../lib/git.mjs", import.meta.url), "utf8");
function extract(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing bounded source section: ${startMarker}`);
  return source.slice(start, end).replace(/^export /gm, "");
}

// Synthetic installed observations exercise the actual routing/scope functions.
// No synthetic policy is written to the host or treated as installed authority.
function fixture() {
  const observations = new Map(), calls = [], reads = [], missing = new Set();
  let pinPath = RC_SOURCE_GIT_EXECUTABLE_V1, aliasTarget = "git-remote-http", afterCommand = null;
  let namespaceProtected = true, aliasAcl = false, aliasMode = "lrwxr-xr-x", aliasMetadata = {}, aliasResolved = HTTP;
  const observed = file => {
    if (missing.has(file)) throw Object.assign(new Error("missing protected file"), { code: "ENOENT" });
    if (!observations.has(file)) observations.set(file, { sha256: D, identity: identity() });
    const value = observations.get(file);
    return { sha256: value.sha256, identity: [...value.identity] };
  };
  const scopeCode = extract(originalGit, "export const RC_SOURCE_GIT_EXECUTABLE_V1", "// End installed RC Git scope.")
    .replace('await import("./rc-publication-installed-context-v1.mjs")', "await loadInstalledPolicyModule()");
  const commandCode = extract(originalGit, "async function git(cwd", "\nexport function parseBoundGitHubBranchRefRevision(");
  const api = runInNewContext(`(() => { ${scopeCode}\n${commandCode}\nreturn {
    withInstalledRcSourceGitV1, assertInstalledRcSourceGitScopeV1, assertCurrentRcSourceGitV1,
    assertCurrentRcSourceGitAfterInvocationV1, markInstalledRcSourceGitEffectStartedV1,
    rcSourceGitInvocationV1, runSourceGit, currentRcGitScope
  }; })()`, {
    AsyncLocalStorage, canonicalJson, Buffer,
    SOURCE_GIT_EXECUTABLE: "/usr/bin/git", SOURCE_GIT_PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SOURCE_GIT_TIMEOUT_MS: 30_000, SOURCE_GIT_MAX_BUFFER: 4 * 1024 * 1024,
    process: { env: { PATH: "/synthetic/shadow", DEVELOPER_DIR: "/synthetic/developer", GIT_EXEC_PATH: "/synthetic/helpers" } },
    loadInstalledPolicyModule: async () => ({ readInstalledRcPublicationGitPolicyV1: async request => {
      assert.equal(Object.keys(request).join(","), "operationId");
      reads.push(request.operationId);
      const file = `/private/etc/better-workflows/rc-publication-v1/${request.operationId}/policy.json`;
      return { operationId: request.operationId, pin: { path: pinPath, sha256: D },
        policyObservation: { file, maxBytes: 4 * 1024 * 1024, exactMode: 0o644, executable: false, ...observed(file) } };
    } }),
    observeRootOwnedRuntimeFileV2: async file => observed(file),
    assertRootOwnedRuntimePathV2: async file => { assert.equal(file, RC_SOURCE_GIT_EXEC_PATH_V1); if (!namespaceProtected) throw new Error("unprotected helper directory"); },
    lstat: async () => ({ isSymbolicLink: () => true, uid: 0n, gid: 0n, dev: 1n, ino: 2n, size: 15n,
      mode: 0o120755n, nlink: 1n, ctimeNs: 4n, mtimeNs: 5n, ...aliasMetadata }),
    readlink: async () => aliasTarget, realpath: async () => aliasResolved,
    promisify: value => value,
    execFile: async () => ({ stdout: aliasAcl ? "lrwxr-xr-x+ fixed alias\n 0: user allow delete\n" : `${aliasMode} fixed alias\n` }),
    findCanonicalWorktree: async cwd => cwd, validateConfiguredWorktree: async () => {},
    isolatedGitEnvironment: async () => ({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/var/empty" }),
    gitFailureDetail: error => error.message,
    execBoundGit: async (executable, args, options) => {
      calls.push({ executable, args: [...args], environment: { ...options.env } });
      afterCommand?.();
      return { stdout: "synthetic source\n", stderr: "" };
    }
  });
  return { api, observations, calls, reads, missing, observe: observed,
    setPinPath: value => { pinPath = value; }, setAlias: value => { aliasTarget = value; },
    setNamespaceProtected: value => { namespaceProtected = value; },
    setAliasAcl: value => { aliasAcl = value; },
    setAliasMode: value => { aliasMode = value; }, setAliasMetadata: value => { aliasMetadata = value; },
    setAliasResolved: value => { aliasResolved = value; },
    afterCommand: value => { afterCommand = value; },
    replace: (file, value) => observations.set(file, { sha256: D, identity: identity(), ...value }) };
}
const request = operationId => ({ operationId });
const pin = { path: RC_SOURCE_GIT_EXECUTABLE_V1, sha256: D };

test("RC Git scope is unavailable to caller-shaped authority outside the installed operation", () => {
  assert.throws(() => assertInstalledRcSourceGitScopeV1(pin, "synthetic"), { code: "ERC_GIT_SCOPE", status: "HOLD" });
});

test("installed scope uses only direct CLT Git and restores generic source Git afterward", async () => {
  const f = fixture();
  assert.equal(f.api.rcSourceGitInvocationV1(), null);
  await f.api.withInstalledRcSourceGitV1(request("one"), async () => {
    const scope = f.api.assertInstalledRcSourceGitScopeV1(pin, "one");
    assert.ok(Object.isFrozen(scope) && Object.isFrozen(scope.observations) && Object.isFrozen(scope.observations[0].identity));
    assert.equal(f.api.rcSourceGitInvocationV1().executable, RC_SOURCE_GIT_EXECUTABLE_V1);
    await Promise.resolve();
    await f.api.runSourceGit("/synthetic/public", ["rev-parse", "HEAD"]);
  });
  assert.equal(f.api.rcSourceGitInvocationV1(), null);
  await f.api.runSourceGit("/synthetic/public", ["rev-parse", "HEAD"]);
  assert.equal(f.calls[0].executable, RC_SOURCE_GIT_EXECUTABLE_V1);
  assert.equal(f.calls[1].executable, "/usr/bin/git");
  assert.equal(f.calls[0].environment.GIT_EXEC_PATH, RC_SOURCE_GIT_EXEC_PATH_V1);
  assert.equal(f.calls[0].environment.DEVELOPER_DIR, undefined);
  assert.equal(f.calls[0].environment.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.deepEqual(f.calls[0].args.slice(0, 1), ["--no-replace-objects"]);
});

test("parallel and nested RC operations keep exact policy scopes isolated across awaits", async () => {
  const f = fixture();
  let releaseOne, releaseTwo;
  const one = new Promise(resolve => { releaseOne = resolve; }), two = new Promise(resolve => { releaseTwo = resolve; });
  await Promise.all([
    f.api.withInstalledRcSourceGitV1(request("one"), async () => {
      releaseOne(); await two;
      assert.equal(f.api.assertInstalledRcSourceGitScopeV1(pin, "one").operationId, "one");
      assert.throws(() => f.api.assertInstalledRcSourceGitScopeV1(pin, "two"), { code: "ERC_GIT_SCOPE" });
      await f.api.withInstalledRcSourceGitV1(request("nested"), async () => {
        assert.equal(f.api.assertInstalledRcSourceGitScopeV1(pin, "nested").operationId, "nested");
      });
      assert.equal(f.api.assertInstalledRcSourceGitScopeV1(pin, "one").operationId, "one");
    }),
    f.api.withInstalledRcSourceGitV1(request("two"), async () => {
      releaseTwo(); await one;
      assert.equal(f.api.assertInstalledRcSourceGitScopeV1(pin, "two").operationId, "two");
      assert.throws(() => f.api.assertInstalledRcSourceGitScopeV1(pin, "one"), { code: "ERC_GIT_SCOPE" });
    })
  ]);
  assert.equal(f.api.rcSourceGitInvocationV1(), null);
});

test("async work escaped from a completed scope fails closed instead of inheriting Git authority", async () => {
  const f = fixture(); let release, escaped;
  const gate = new Promise(resolve => { release = resolve; });
  await f.api.withInstalledRcSourceGitV1(request("one"), async () => {
    escaped = gate.then(() => f.api.runSourceGit("/synthetic/public", ["rev-parse", "HEAD"]));
  });
  release();
  await assert.rejects(escaped, { code: "ERC_GIT_SCOPE_CLOSED", status: "HOLD" });
  assert.equal(f.calls.length, 0);
});

test("a failed installed continuation restores generic routing", async () => {
  const f = fixture();
  await assert.rejects(f.api.withInstalledRcSourceGitV1(request("one"), async () => { throw new Error("continuation failed"); }), /continuation failed/);
  assert.equal(f.api.rcSourceGitInvocationV1(), null);
});

test("shim, arbitrary executable and missing CLT/helper protection are rejected before any command", async () => {
  for (const selected of ["/usr/bin/git", "/synthetic/git"]) {
    const f = fixture(); f.setPinPath(selected);
    await assert.rejects(f.api.withInstalledRcSourceGitV1(request("one"), () => f.api.runSourceGit("/synthetic/public", ["status"])), { code: "ERC_GIT_PIN" });
    assert.equal(f.calls.length, 0);
  }
  for (const file of [RC_SOURCE_GIT_EXECUTABLE_V1, HTTP]) {
    const f = fixture(); f.missing.add(file);
    await assert.rejects(f.api.withInstalledRcSourceGitV1(request("one"), () => {}), { code: "ERC_GIT_PROTECTION", status: "HOLD" });
  }
  const f = fixture(); f.setNamespaceProtected(false);
  await assert.rejects(f.api.withInstalledRcSourceGitV1(request("one"), () => {}), { code: "ERC_GIT_PROTECTION" });
});

test("direct Git digest mismatch and changed HTTPS alias are rejected", async () => {
  const mismatch = fixture(); mismatch.replace(RC_SOURCE_GIT_EXECUTABLE_V1, { sha256: CHANGED });
  await assert.rejects(mismatch.api.withInstalledRcSourceGitV1(request("one"), () => {}), { code: "ERC_GIT_PIN" });
  const alias = fixture(); alias.setAlias("/synthetic/remote-https");
  await assert.rejects(alias.api.withInstalledRcSourceGitV1(request("one"), () => {}), { code: "ERC_GIT_HELPER" });
  const acl = fixture(); acl.setAliasAcl(true);
  await assert.rejects(acl.api.withInstalledRcSourceGitV1(request("one"), () => {}), { code: "ERC_GIT_HELPER" });
  for (const mutate of [f => f.setAliasMode("lrwxr-xr-x+"), f => f.setAliasMode("lxxxxxxxxx"),
    f => f.setAliasMetadata({ uid: 1n }), f => f.setAliasMetadata({ nlink: 2n }), f => f.setAliasResolved("/synthetic/helper")]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.api.withInstalledRcSourceGitV1(request("one"), () => {}), { code: "ERC_GIT_HELPER", status: "HOLD" });
  }
});

test("same-byte policy/Git identity drift and HTTP helper digest drift block the next invocation", async () => {
  for (const [file, drift] of [
    [RC_SOURCE_GIT_EXECUTABLE_V1, { identity: ["9", ...identity().slice(1)] }],
    ["/private/etc/better-workflows/rc-publication-v1/one/policy.json", { identity: ["9", ...identity().slice(1)] }],
    [HTTP, { sha256: CHANGED }]
  ]) {
    const f = fixture();
    await assert.rejects(f.api.withInstalledRcSourceGitV1(request("one"), async () => {
      f.replace(file, drift);
      await f.api.runSourceGit("/synthetic/public", ["rev-parse", "HEAD"], { allowFailure: true });
    }), { code: "ERC_GIT_DRIFT", status: "HOLD" });
    assert.equal(f.calls.length, 0, "allowFailure cannot mask installed trust drift");
  }
});

test("Git drift during command execution prevents accepting its output", async () => {
  const f = fixture(); f.afterCommand(() => f.replace(RC_SOURCE_GIT_EXECUTABLE_V1, { sha256: CHANGED }));
  await assert.rejects(f.api.withInstalledRcSourceGitV1(request("one"), () => f.api.runSourceGit("/synthetic/public", ["status"])), { code: "ERC_GIT_DRIFT" });
  assert.equal(f.calls.length, 1);
});

test("final scope drift preserves completed/reconciled operation results as UNKNOWN", async () => {
  for (const effectStarted of [false, true]) {
    const f = fixture(), result = Object.freeze({ status: "COMPLETE", w5HeadDigest: D, w5EventCount: 8 });
    await assert.rejects(f.api.withInstalledRcSourceGitV1(request("one"), () => {
      if (effectStarted) f.api.markInstalledRcSourceGitEffectStartedV1(pin, "one");
      f.replace(HTTP, { sha256: CHANGED });
      return result;
    }), error => error.code === "ERC_GIT_DRIFT" && error.status === "UNKNOWN" && error.operationResult === result && error.reconciliationRequired === true);
    assert.equal(f.api.rcSourceGitInvocationV1(), null);
  }
});

test("post-spawn Git/helper/policy drift is UNKNOWN while pre-spawn drift remains HOLD", async () => {
  const source = await readFile(new URL("../lib/rc-publication-installed-context-v1.mjs", import.meta.url), "utf8");
  const transport = extract(source, "async function executeInstalledRcCommandV1(", "\nfunction parseResponse(");
  // Substitute only the native keeper body. Scope checks, effect marker,
  // protected observations and pre/post dispatch status handling stay exact.
  const start = transport.indexOf("    const child = spawn("), end = transport.indexOf("  }); } catch (error)", start);
  assert.ok(start > 0 && end > start);
  const bounded = transport.slice(0, start) + "    syntheticTransport().then(resolve, reject);\n" + transport.slice(end);
  const command = (f, onSpawn) => {
    let spawns = 0, ledgerWrites = 0;
    const ctx = { operationId: "one", bindingDigest: D,
      cli: { git: pin, gh: { path: "/synthetic/gh", sha256: D }, node: { path: "/synthetic/node", sha256: D } },
      candidate: { publicRoot: "/synthetic/public" }, paths: { commandsRoot: "/synthetic/commands" } };
    const execute = runInNewContext(`(() => { ${bounded} return executeInstalledRcCommandV1; })()`, {
      Buffer, Date, path, canonicalJson, sha256, MAX_JSON: 4 * 1024 * 1024, IMAGE_ROOT: "/synthetic/image", RC_COMMAND_KEEPER_V1: "synthetic keeper",
      process: { pid: 100, ppid: 1, versions: { node: process.versions.node } }, randomUUID: () => "00000000-0000-4000-8000-000000000001",
      assertInstalledRcPublicationContextV1: context => assert.equal(context, ctx),
      assertInstalledRcSourceGitScopeV1: f.api.assertInstalledRcSourceGitScopeV1, assertCurrentRcSourceGitV1: f.api.assertCurrentRcSourceGitV1,
      markInstalledRcSourceGitEffectStartedV1: f.api.markInstalledRcSourceGitEffectStartedV1,
      observeRootOwnedRuntimeFileV2: async file => f.observe(file), same: (a, b) => canonicalJson(a) === canonicalJson(b),
      persistOwnedCommand: () => { ledgerWrites++; },
      syntheticTransport: async () => { spawns++; onSpawn?.(); return { code: 0, signal: null, stdout: "", stderr: "" }; },
      hold: (code, message, status = "HOLD") => { throw Object.assign(new Error(message), { code, status }); }
    });
    return { run: (commandId = "git", providerEffect = true) => execute(ctx, commandId, ["synthetic"], { providerEffect }), counts: () => ({ spawns, ledgerWrites }) };
  };
  for (const commandId of ["git", "gh"]) {
    for (const file of [RC_SOURCE_GIT_EXECUTABLE_V1, HTTP, "/private/etc/better-workflows/rc-publication-v1/one/policy.json"]) {
      const f = fixture(), cmd = command(f, () => f.replace(file, { sha256: CHANGED }));
      await assert.rejects(f.api.withInstalledRcSourceGitV1(request("one"), () => cmd.run(commandId)), error =>
        error.status === "UNKNOWN" && error.reconciliationRequired === true && error.commandResult?.code === 0);
      assert.deepEqual(cmd.counts(), { spawns: 1, ledgerWrites: 1 });
    }
  }
  const before = fixture(), cmd = command(before);
  await assert.rejects(before.api.withInstalledRcSourceGitV1(request("one"), () => {
    before.replace(HTTP, { sha256: CHANGED }); return cmd.run();
  }), { code: "ERC_GIT_DRIFT", status: "HOLD" });
  assert.deepEqual(cmd.counts(), { spawns: 0, ledgerWrites: 0 });
  const readOnly = fixture(), read = command(readOnly, () => readOnly.replace(HTTP, { sha256: CHANGED }));
  await assert.rejects(readOnly.api.withInstalledRcSourceGitV1(request("one"), () => read.run("gh", false)), { code: "ERC_GIT_DRIFT", status: "HOLD" });
});

test("failed post-effect journal append retains durable INTENT and original UNKNOWN for reconciliation", async () => {
  const source = await readFile(new URL("../lib/rc-publication-publisher-v1.mjs", import.meta.url), "utf8");
  const start = source.indexOf("      } catch (error) {", source.indexOf("let dispatchStarted"));
  const end = source.indexOf("\n      if (replay.operationStatus", start);
  assert.ok(start > 0 && end > start);
  let state = { events: [], expectedHeadDigest: "0".repeat(64), expectedEventCount: 0 };
  const append = (op, payload, eventId) => {
    const record = appendW5PublicationOperationEventV1({ ...state, request: { operationId: "one", eventId, op, payload } });
    state = { events: record.events, expectedHeadDigest: record.replay.headDigest, expectedEventCount: record.replay.eventCount };
    return record.replay;
  };
  const prepared = append("PREPARE", { candidate: { commitSha: "1".repeat(40), manifestDigest: D, snapshotDigest: D, exportDigest: D },
    target: { provider: "github", repositoryId: 2, repository: "example/public", workflowPath: ".github/workflows/ci.yml", sourceRef: "refs/heads/main", tagRef: "refs/tags/v5.0.0-rc.1", siteIdentityDigest: D }, grantDigest: D }, "prepare");
  const replay = append("EFFECT_INTENT", { step: "sourcepublished", attemptId: "attempt", bindingDigest: prepared.bindingDigest }, "intent");
  const ctx = { operationId: "one", bindingDigest: prepared.bindingDigest };
  const handle = runInNewContext(`(async error => { try { throw error; ${source.slice(start, end)} })`, {
    ctx, step: "sourcepublished", attemptId: "attempt", dispatchStarted: false,
    readReplay: async () => replay, boundReplay: value => value, persistRecord: async () => D,
    append: async (_ctx, current, op, payload) => {
      assert.equal(current.pending.status, "INTENT"); assert.equal(op, "EFFECT_RESULT"); assert.equal(payload.outcome, "UNKNOWN");
      throw Object.assign(new Error("protected Git drift forbids journal append"), { code: "ERC_GIT_DRIFT", status: "HOLD" });
    }
  });
  const original = Object.assign(new Error("post-spawn helper drift"), { code: "ERC_GIT_DRIFT", status: "UNKNOWN" });
  await assert.rejects(handle(original), error => error === original && error.status === "UNKNOWN" && error.journalRecordCode === "ERC_GIT_DRIFT" && error.reconciliationRequired === true);
  assert.equal(state.expectedEventCount, 2);
  assert.equal(replay.pending.status, "INTENT");
  assert.throws(() => append("EFFECT_INTENT", { step: "sourcepublished", attemptId: "retry", bindingDigest: ctx.bindingDigest }, "unsafe-retry"));
});

test("projection metadata cannot override PATH, developer, helper, loader or Git config selection", async () => {
  const f = fixture();
  await f.api.withInstalledRcSourceGitV1(request("one"), async () => {
    for (const key of ["PATH", "DEVELOPER_DIR", "GIT_EXEC_PATH", "NODE_OPTIONS", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL"]) {
      assert.throws(() => f.api.rcSourceGitInvocationV1({ [key]: "/synthetic/override" }), { code: "ERC_GIT_ENVIRONMENT" });
    }
    assert.equal(f.api.rcSourceGitInvocationV1({ GIT_INDEX_FILE: "/synthetic/index" }).environment.GIT_INDEX_FILE, "/synthetic/index");
  });
});

test("RC source push uses the installed operation Git pin", async () => {
  const f = fixture(), projected = [];
  const source = await readFile(new URL("../lib/rc-publication-installed-context-v1.mjs", import.meta.url), "utf8");
  const environment = extract(source, "function environment()", "\nfunction persistOwnedCommand(");
  const pushEnvironment = runInNewContext(`(() => { ${environment} return environment; })()`, {
    RC_SOURCE_GIT_EXEC_PATH_V1, process: { env: { DEVELOPER_DIR: "/synthetic/developer", GIT_EXEC_PATH: "/synthetic/helpers", HOME: "/synthetic/home" } }
  });
  const dispatch = extract(source, "export async function rcPublicationDispatchEffectV1(", "\nexport async function rcPublicationVerifyGithubAttestationV1(");
  const ctx = { operationId: "one", bindingDigest: D, cli: { git: pin, gh: { path: "/synthetic/gh" } }, grant: { effects: ["create-source-main"] },
    candidate: { publicRoot: "/synthetic/public", publicCandidateSha: "c".repeat(40) }, paths: { stateRoot: "/synthetic/state" },
    target: { repository: { name: "example/public", id: "2" }, sourceRef: "refs/heads/main" } };
  const push = runInNewContext(`(() => { ${environment}\n${dispatch}\nreturn rcPublicationDispatchEffectV1; })()`, {
    RC_SOURCE_GIT_EXEC_PATH_V1, process: { env: { DEVELOPER_DIR: "/synthetic/developer", GIT_EXEC_PATH: "/synthetic/helpers", HOME: "/synthetic/home" } },
    Buffer, digestObject, assertInstalledRcPublicationContextCurrentV1: async context => {
      f.api.assertInstalledRcSourceGitScopeV1(context.cli.git, context.operationId); await f.api.assertCurrentRcSourceGitV1();
    },
    readW5PublicationJournalV1: async () => ({ replay: { bindingDigest: D, pending: { status: "INTENT", step: "sourcepublished", attemptId: "attempt" } } }),
    executeInstalledRcCommandV1: async (context, commandId, args) => { assert.equal(commandId, "git"); projected.push({ executable: context.cli.git.path, args, environment: pushEnvironment() }); return { code: 0, signal: null }; },
    hold: (code, message) => { throw Object.assign(new Error(message), { code }); }
  });
  await f.api.withInstalledRcSourceGitV1(request("one"), async () => {
    await push(ctx, "attempt", "create-source-main");
    f.replace(HTTP, { sha256: CHANGED });
    await assert.rejects(push(ctx, "attempt", "create-source-main"), { code: "ERC_GIT_DRIFT", status: "HOLD" });
    f.replace(HTTP, { sha256: D });
  });
  assert.equal(projected.length, 1);
  for (const call of projected) {
    assert.equal(call.executable, RC_SOURCE_GIT_EXECUTABLE_V1);
    assert.equal(call.environment.GIT_EXEC_PATH, RC_SOURCE_GIT_EXEC_PATH_V1);
    assert.equal(call.environment.DEVELOPER_DIR, undefined);
    assert.equal(call.environment.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  }
  assert.ok(projected[0].args.includes("push"));
  f.replace(HTTP, { sha256: CHANGED });
  await assert.rejects(push(ctx, "attempt", "create-source-main"), { code: "ERC_GIT_SCOPE" });
  assert.equal(projected.length, 1);
});

test("generic root-file hardlink protection remains effective for the macOS Git shim", async () => {
  const runtime = await readFile(new URL("../lib/runtime-qualification-v2.mjs", import.meta.url), "utf8");
  const code = extract(runtime, "export async function assertRootOwnedRuntimePathV2(", "\nasync function assertNoRuntimeAclV2(");
  const check = runInNewContext(`(() => { ${code} return assertRootOwnedRuntimePathV2; })()`, {
    path, realpath: async file => file, assertNoRuntimeAclV2: async () => {},
    lstat: async file => ({ isDirectory: () => file !== "/usr/bin/git", isFile: () => file === "/usr/bin/git", isSymbolicLink: () => false,
      uid: 0n, mode: 0o755n, nlink: file === "/usr/bin/git" ? 78n : 1n })
  });
  await assert.rejects(check("/usr/bin/git"), /not protected/);
});

test("current macOS direct CLT binary satisfies unchanged physical root-file protection", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async () => {
  const info = await lstat(RC_SOURCE_GIT_EXECUTABLE_V1);
  assert.equal(info.nlink, 1);
  const observed = await observeRootOwnedRuntimeFileV2(RC_SOURCE_GIT_EXECUTABLE_V1, { maxBytes: 512 * 1024 * 1024, executable: true });
  assert.match(observed.sha256, /^[a-f0-9]{64}$/);
  assert.match((await observeRootOwnedRuntimeFileV2(HTTP, { maxBytes: 512 * 1024 * 1024, executable: true })).sha256, /^[a-f0-9]{64}$/);
  const observeAlias = runInNewContext(`(() => { ${extract(originalGit, "export const RC_SOURCE_GIT_EXECUTABLE_V1", "// End installed RC Git scope.")} return observeRcHttpsHelperV1; })()`, {
    AsyncLocalStorage, execFile, promisify, canonicalJson, assertRootOwnedRuntimePathV2, observeRootOwnedRuntimeFileV2, lstat, readlink, realpath
  });
  assert.equal((await observeAlias()).sha256, "fixed-alias:git-remote-http");
});
