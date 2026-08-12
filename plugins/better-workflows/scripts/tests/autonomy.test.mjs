import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertAutonomyAction,
  autonomyProfileDigest,
  buildAutonomyBinding,
  buildAutonomyDecisionReceipt,
  decideAutonomyAction,
  loadAutonomyProfile,
  validateAutonomyProfile
} from "../lib/autonomy.mjs";
import { buildContract, sha256 } from "../lib/core.mjs";
import {
  assertHostBundleMatchesStatus,
  hostBundleDigest,
  hostBundleFromStatus,
  validateHostBundleManifest
} from "../lib/host-bundle.mjs";
import {
  captureAutonomyBindingContext,
  captureAutonomyReadinessSnapshotFromSource,
  probeAutonomyGithubCredential,
  resolveAutonomyRepository,
  runAutonomyGitCommandForTest
} from "../lib/autonomy-preflight.mjs";
import { currentAutonomyBranchFromGit, readRawLocalConfigValues } from "../lib/autonomy-snapshot.mjs";

const execFileAsync = promisify(execFile);
const SYSTEM_GIT = "/usr/bin/git";

async function autonomyRepositoryFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sbw-autonomy-preflight-"));
  await execFileAsync(SYSTEM_GIT, ["init", "-q", "-b", "codex/preflight"], { cwd: root });
  await execFileAsync(SYSTEM_GIT, ["config", "user.email", "autonomy@example.invalid"], { cwd: root });
  await execFileAsync(SYSTEM_GIT, ["config", "user.name", "Autonomy Test"], { cwd: root });
  await execFileAsync(SYSTEM_GIT, ["remote", "add", "origin", "https://github.com/example/repository.git"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "autonomy preflight\n");
  await execFileAsync(SYSTEM_GIT, ["add", "README.md"], { cwd: root });
  await execFileAsync(SYSTEM_GIT, ["commit", "-qm", "baseline"], { cwd: root });
  return root;
}

async function assertProcessGone(pid) {
  try {
    process.kill(pid, 0);
    assert.fail(`process ${pid} survived the bounded preflight cleanup`);
  } catch (error) {
    assert.equal(error.code, "ESRCH");
  }
}

test("bounded-autopilot-v1 is canonical and digestable", async () => {
  const profile = await loadAutonomyProfile();
  assert.equal(profile.id, "bounded-autopilot-v1");
  assert.equal(profile.scope.pullRequestBase, "dev");
  assert.equal(profile.limits.maxPullRequests, 1);
  assert.match(autonomyProfileDigest(profile), /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => validateAutonomyProfile(profile));
});

test("bounded-autopilot-v1 policy has a strict immutable JSON schema", async () => {
  const schema = JSON.parse(await readFile(new URL("../../config/autonomy/bounded-autopilot-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "https://github.com/stephen-taipei/better-workflows/schema/bounded-autopilot-v1.json");
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "id",
    "description",
    "autoActions",
    "humanActions",
    "deniedActions",
    "scope",
    "limits"
  ]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.autoActions.items.enum, [
    "read",
    "test",
    "evaluator.replay",
    "git.commit",
    "plugin.cache.publish",
    "git.push.codex",
    "pr.create.dev"
  ]);
  assert.deepEqual(schema.properties.humanActions.items.enum, [
    "host.bootstrap",
    "host.upgrade",
    "host.revoke",
    "pr.merge",
    "deploy",
    "git.push.dev",
    "git.push.main",
    "worktree.cleanup"
  ]);
  assert.deepEqual(schema.properties.deniedActions.items.enum, [
    "password.capture",
    "sudo.unbounded",
    "admin.bypass",
    "shell.unpinned"
  ]);
});

test("autonomy action matrix keeps codex push and dev PR automatic", async () => {
  const profile = await loadAutonomyProfile();
  assert.equal(decideAutonomyAction(profile, "git.commit").decision, "auto-approved");
  assert.equal(
    decideAutonomyAction(profile, "git.push", { resource: "remote:origin:refs/heads/codex/feature" }).decision,
    "auto-approved"
  );
  assert.equal(decideAutonomyAction(profile, "pr.create", { scope: "dev" }).decision, "auto-approved");
  assert.equal(
    decideAutonomyAction(profile, "git.push", { resource: "remote:origin:refs/heads/dev" }).decision,
    "requires-human"
  );
  assert.equal(decideAutonomyAction(profile, "pr.merge", { resource: "pull/1" }).decision, "requires-human");
  assert.throws(() => assertAutonomyAction(profile, "pr.merge", { resource: "pull/1" }), /human approval/);
});

test("autonomy binding is run-scoped and expires", async () => {
  const profile = await loadAutonomyProfile();
  const binding = buildAutonomyBinding(profile);
  assert.equal(binding.id, profile.id);
  assert.equal(binding.profileDigest, autonomyProfileDigest(profile));
  assert.ok(Date.parse(binding.expiresAt) > Date.now());
  assert.throws(
    () => buildAutonomyBinding(profile, { expiresAt: new Date(Date.now() - 1000).toISOString() }),
    /expiry must be in the future/
  );
});

test("autonomy decisions are typed, run-bound, and token-bound receipts", async () => {
  const profile = await loadAutonomyProfile();
  const binding = buildAutonomyBinding(profile, {
    repository: "github.com/stephen-taipei/better-workflows",
    branch: "codex/feature",
    pathScope: ["plugins"]
  });
  const decision = decideAutonomyAction(profile, "git.commit");
  const receipt = buildAutonomyDecisionReceipt({
    runId: "sbw-test-run",
    binding,
    sourceBindingDigest: "a".repeat(64),
    request: { action: "git.commit", resource: "git:commit", scope: "plugins" },
    decision,
    tokenHash: "b".repeat(64)
  });
  assert.equal(receipt.kind, "autonomy-decision");
  assert.equal(receipt.decision, "auto-approved");
  assert.match(receipt.decisionId, /^[a-f0-9]{64}$/);
  assert.equal(receipt.profileDigest, binding.profileDigest);
  assert.equal(receipt.sourceBindingDigest, "a".repeat(64));
});

test("autonomy profile cannot be broadened by local edits", async () => {
  const profile = await loadAutonomyProfile();
  const broadened = structuredClone(profile);
  broadened.autoActions = [...broadened.autoActions, "pr.merge"];
  assert.throws(() => validateAutonomyProfile(broadened), /overlaps|canonical/);
});

test("autonomy profile is delivery-only and rejects non-codex PR or merge authority", async () => {
  const profile = await loadAutonomyProfile();
  assert.equal(decideAutonomyAction(profile, "pr.create", { scope: "main" }).decision, "requires-human");
  assert.equal(decideAutonomyAction(profile, "git.push", { resource: "remote:origin:refs/heads/feature" }).decision, "requires-human");
  assert.equal(decideAutonomyAction(profile, "git.push", { resource: "remote:origin:refs/heads/codex/feature" }).decision, "auto-approved");
  assert.equal(decideAutonomyAction(profile, "deploy").decision, "requires-human");
});

test("TaskContract cannot attach bounded autonomy to another template or protected authority", async () => {
  const profile = await loadAutonomyProfile();
  const binding = buildAutonomyBinding(profile, {
    repository: "github.com/stephen-taipei/better-workflows",
    branch: "codex/feature",
    pathScope: ["plugins"]
  });
  const templateDefinition = {
    name: "pr-to-dev",
    defaultMode: "critical",
    requiredEvidence: ["current-revision"],
    acceptance: [{ id: "complete", description: "Complete", critical: true }],
    actionGates: {}
  };
  assert.doesNotThrow(() => buildContract({
    template: "pr-to-dev",
    templateDefinition,
    goal: "bounded delivery",
    scope: ["plugins"],
    autonomyProfile: binding
  }));
  assert.throws(() => buildContract({
    template: "review-to-issues",
    templateDefinition: { ...templateDefinition, name: "review-to-issues" },
    goal: "invalid autonomy",
    scope: ["plugins"],
    autonomyProfile: binding
  }), /only valid for pr-to-dev/);
  assert.throws(() => buildContract({
    template: "pr-to-dev",
    templateDefinition,
    goal: "protected merge",
    scope: ["plugins"],
    authority: ["pr.merge"],
    autonomyProfile: binding
  }), /outside bounded-autopilot-v1/);
});

test("autonomy denies passwords, unpinned shells, protected pushes, merge, deploy, and cleanup", async () => {
  const profile = await loadAutonomyProfile();
  for (const action of ["password.capture", "sudo.unbounded", "admin.bypass", "shell.unpinned"]) {
    assert.equal(decideAutonomyAction(profile, action).decision, "denied");
  }
  for (const action of ["git.push", "pr.merge", "deploy", "worktree.cleanup"]) {
    const context = action === "git.push" ? { resource: "remote:origin:refs/heads/main" } : {};
    assert.equal(decideAutonomyAction(profile, action, context).decision, "requires-human");
  }
});

test("autonomy binding rejects invalid repository, branch, path, expiry, and limits", async () => {
  const profile = await loadAutonomyProfile();
  assert.throws(() => buildAutonomyBinding(profile, { repository: "evil.example/repo" }), /repository identity/);
  assert.throws(() => buildAutonomyBinding(profile, { branch: "dev" }), /codex scope/);
  assert.throws(() => buildAutonomyBinding(profile, { pathScope: ["../outside"] }), /path scope/);
  const binding = buildAutonomyBinding(profile, { repository: "github.com/stephen-taipei/better-workflows", branch: "codex/feature", pathScope: ["plugins"] });
  assert.throws(() => validateAutonomyProfile({ ...profile, limits: { ...profile.limits, maxFiles: 81 } }), /canonical/);
  assert.throws(() => validateAutonomyProfile({ ...profile, autoActions: [...profile.autoActions, "pr.merge"] }), /canonical|overlaps/);
  assert.equal(binding.repository, "github.com/stephen-taipei/better-workflows");
});

test("root-owned host bundle binding uses protocol artifacts, not repository source bytes", () => {
  const status = {
    signer: { path: "/private/var/db/better-workflows/bin/bw-host-trust.mjs", version: "2.4.0", digest: "a".repeat(64) },
    runtime: { path: "/private/var/db/better-workflows/bin/bw-host-node." + "b".repeat(64), digest: "b".repeat(64) },
    launcher: { path: "/private/var/db/better-workflows/bin/bw-host-exec-launcher", digest: "c".repeat(64) },
    readinessReceipt: {
      digest: "d".repeat(64),
      bindingDigest: "e".repeat(64),
      binding: {
        signer: { version: "2.4.0", digest: "a".repeat(64) },
        runtime: { digest: "b".repeat(64) },
        launcher: { digest: "c".repeat(64) }
      }
    }
  };
  const bundle = hostBundleFromStatus(status);
  assert.equal(bundle.runtimeDigest, status.runtime.digest);
  assert.match(hostBundleDigest(bundle), /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => assertHostBundleMatchesStatus(bundle, status));
  assert.throws(
    () => assertHostBundleMatchesStatus({ ...bundle, runtimeDigest: "f".repeat(64) }, status),
    /protocol binding is invalid|binding changed/
  );
});

test("formal host bundle manifests are independently shaped and cannot be broadened", () => {
  const manifest = {
    schemaVersion: 1,
    kind: "better-workflows-host-bundle",
    protocolVersion: 1,
    bundleVersion: "2.4.0",
    signerPath: "/private/var/db/better-workflows/bin/bw-host-trust.mjs",
    signerDigest: "a".repeat(64),
    launcherPath: "/private/var/db/better-workflows/bin/bw-host-exec-launcher",
    launcherDigest: "b".repeat(64),
    runtimePath: "/private/var/db/better-workflows/bin/bw-host-node." + "c".repeat(64),
    runtimeDigest: "c".repeat(64),
    supportedConsentSchemas: [4],
    issuer: "better-workflows-local-host",
    keyId: "codex-ed25519-2026-07",
    issuedAt: "2026-08-12T00:00:00.000Z",
    signature: "signed-host-bundle-payload"
  };
  assert.deepEqual(validateHostBundleManifest(manifest), manifest);
  assert.throws(
    () => validateHostBundleManifest({ ...manifest, supportedConsentSchemas: [4, 5] }),
    /binding is invalid/
  );
  assert.throws(
    () => validateHostBundleManifest({ ...manifest, unbounded: true }),
    /fields are invalid/
  );
});

test("attestation runtime no longer couples ordinary source edits to signer digest", async () => {
  const source = await readFile(new URL("../lib/attestations.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /SOURCE_HOST_TRUST_TOOL/);
  assert.doesNotMatch(source, /signer\.digest !== sourceSignerDigest/);
  assert.match(source, /hostBundle/);
});

test("autonomy binding pins Git, ignores insteadOf rewrites, and rejects divergent raw pushurl", async () => {
  const root = await autonomyRepositoryFixture();
  const shimDirectory = path.join(root, "hostile-bin");
  const shimMarker = path.join(root, "hostile-git-ran");
  await mkdir(shimDirectory);
  await writeFile(
    path.join(shimDirectory, "git"),
    `#!/bin/sh\nprintf hostile > ${JSON.stringify(shimMarker)}\nexit 97\n`,
    { mode: 0o755 }
  );
  await execFileAsync(SYSTEM_GIT, ["config", "url.https://rewritten.invalid/.insteadOf", "https://github.com/"], { cwd: root });
  const rewritten = (await execFileAsync(SYSTEM_GIT, ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" })).stdout.trim();
  assert.equal(rewritten, "https://rewritten.invalid/example/repository.git");
  const priorPath = process.env.PATH;
  process.env.PATH = `${shimDirectory}${path.delimiter}${priorPath ?? ""}`;
  try {
    assert.deepEqual(await captureAutonomyBindingContext(root, ["."]), {
      repository: "github.com/example/repository",
      branch: "codex/preflight",
      pathScope: ["."]
    });
    await assert.rejects(lstat(shimMarker), (error) => error.code === "ENOENT");
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
  await execFileAsync(SYSTEM_GIT, ["config", "remote.origin.pushurl", "https://github.com/other/repository.git"], { cwd: root });
  await assert.rejects(resolveAutonomyRepository(root), /matching credential-free HTTPS GitHub fetch and push repositories/);
  await rm(root, { recursive: true, force: true });
});

test("autonomy Git and GitHub preflight wrappers terminate forking children", async () => {
  const root = await autonomyRepositoryFixture();
  const helper = path.join(root, "forking-preflight.mjs");
  const gitPidFile = path.join(root, "git-child.pid");
  await writeFile(helper, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const pidFile = process.argv[2];',
    'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });',
    'writeFileSync(pidFile, String(child.pid));',
    'process.on("SIGTERM", () => {});',
    'setInterval(() => {}, 1000);'
  ].join("\n"));
  const alias = `alias.autonomy-hang=!${JSON.stringify(process.execPath)} ${JSON.stringify(helper)} ${JSON.stringify(gitPidFile)}`;
  await assert.rejects(
    runAutonomyGitCommandForTest(root, ["-c", alias, "autonomy-hang"], { timeoutMs: 200 }),
    /timed out/
  );
  await assertProcessGone(Number(await readFile(gitPidFile, "utf8")));

  const githubPidFile = path.join(root, "github-child.pid");
  const githubShim = path.join(root, "bounded-gh.mjs");
  await writeFile(
    githubShim,
    `#!${process.execPath}\nimport { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });\nwriteFileSync(${JSON.stringify(githubPidFile)}, String(child.pid));\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o755 }
  );
  await assert.rejects(
    probeAutonomyGithubCredential(root, githubShim, { timeoutMs: 1_000 }),
    /timed out/
  );
  await assertProcessGone(Number(await readFile(githubPidFile, "utf8")));
  await rm(root, { recursive: true, force: true });
});

test("autonomy remote binding fails closed on indeterminate pushurl reads and oversized output", async () => {
  const timeoutRunner = async (args) => {
    const key = args.at(-1);
    if (key === "remote.origin.url") {
      return { ok: true, stdout: "https://github.com/example/repository.git\0", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "timed out", code: "ETIMEDOUT", signal: "SIGKILL" };
  };
  await assert.rejects(
    resolveAutonomyRepository("/unused", { runGit: timeoutRunner }),
    /could not read raw local remote\.origin\.pushurl: timed out/
  );
  await assert.rejects(
    readRawLocalConfigValues(async () => ({
      ok: false,
      stdout: "",
      stderr: "output exceeded 1048576 bytes",
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      signal: null
    }), "remote.origin.pushurl"),
    /output exceeded/
  );
  for (const failure of [
    { code: 1, signal: null, timedOut: true, outputExceeded: false, stderr: "timed out" },
    { code: 1, signal: null, timedOut: false, outputExceeded: true, stderr: "output exceeded" },
    { code: 1, signal: "SIGTERM", timedOut: false, outputExceeded: false, stderr: "terminated" },
    { code: 128, signal: null, timedOut: false, outputExceeded: false, stderr: "fatal" }
  ]) {
    await assert.rejects(
      readRawLocalConfigValues(async () => ({ ok: false, stdout: "", ...failure }), "remote.origin.pushurl"),
      /could not read raw local remote\.origin\.pushurl/
    );
  }
  assert.deepEqual(await readRawLocalConfigValues(async () => ({
    ok: false,
    stdout: "",
    stderr: "",
    code: 1,
    signal: null,
    timedOut: false,
    outputExceeded: false
  }), "remote.origin.pushurl"), []);
  await assert.rejects(
    readRawLocalConfigValues(async () => ({ ok: true, stdout: "value\n", stderr: "" }), "remote.origin.url"),
    /unterminated raw local/
  );
  await assert.rejects(
    readRawLocalConfigValues(async () => ({ ok: true, stdout: "line1\nline2\0", stderr: "" }), "remote.origin.url"),
    /invalid raw local/
  );

  const root = await autonomyRepositoryFixture();
  const configPath = path.join(root, ".git", "config");
  const config = await readFile(configPath, "utf8");
  await writeFile(configPath, `${config}\n[remote "origin"]\n\tpushurl = https://github.com/example/${"a".repeat(1_100_000)}.git\n`);
  await assert.rejects(resolveAutonomyRepository(root), /output exceeded/);
  await rm(root, { recursive: true, force: true });
});

test("autonomy branch lookup accepts only exact detached-HEAD absence and well-formed success", async () => {
  const absent = {
    ok: false,
    stdout: "",
    stderr: "",
    code: 1,
    signal: null,
    timedOut: false,
    outputExceeded: false
  };
  assert.equal(await currentAutonomyBranchFromGit(async () => absent), null);
  assert.equal(await currentAutonomyBranchFromGit(async () => ({
    ok: true,
    stdout: "codex/exact-branch\n",
    stderr: ""
  })), "codex/exact-branch");
  for (const failure of [
    { ...absent, timedOut: true },
    { ...absent, outputExceeded: true },
    { ...absent, signal: "SIGKILL" },
    { ...absent, code: 128 }
  ]) {
    await assert.rejects(
      currentAutonomyBranchFromGit(async () => failure),
      /Autonomy branch lookup failed/
    );
  }
  for (const stdout of ["", "codex/no-newline", "codex/one\ncodex/two\n", "codex/nul\0branch\n"]) {
    await assert.rejects(
      currentAutonomyBranchFromGit(async () => ({ ok: true, stdout, stderr: "" })),
      /malformed success output/
    );
  }
});

test("autonomy and governed push share one credential-safe HTTPS GitHub remote boundary", async () => {
  const root = await autonomyRepositoryFixture();
  const invalid = [
    "git@github.com:example/repository.git",
    "https://user@github.com/example/repository.git",
    "https://github.com/example/repository/extra",
    "https://github.com/example/repository.git?transport=other",
    "https://github.com/example/repository.git#fragment",
    "https://github.com/example",
    "https://gitlab.com/example/repository.git"
  ];
  for (const remote of invalid) {
    await execFileAsync(SYSTEM_GIT, ["remote", "set-url", "origin", remote], { cwd: root });
    await assert.rejects(resolveAutonomyRepository(root), /credential-free HTTPS GitHub/);
  }
  await execFileAsync(SYSTEM_GIT, ["remote", "set-url", "origin", "https://github.com/example/repository.git"], { cwd: root });
  assert.equal(await resolveAutonomyRepository(root), "github.com/example/repository");
  await rm(root, { recursive: true, force: true });
});

test("autonomy readiness snapshot binds same-SHA branch, path scope, and diff limits", async () => {
  const root = await autonomyRepositoryFixture();
  const profile = await loadAutonomyProfile();
  const binding = buildAutonomyBinding(profile, {
    repository: "github.com/example/repository",
    branch: "codex/preflight",
    pathScope: ["README.md"]
  });
  const sourceBindingDigest = "a".repeat(64);
  const sentinelDigest = "b".repeat(64);
  const initial = await captureAutonomyReadinessSnapshotFromSource(root, binding, sourceBindingDigest, { sentinelDigest });
  assert.equal(initial.branch, "codex/preflight");
  assert.equal(initial.repository, "github.com/example/repository");
  assert.equal(initial.changedFiles, 0);
  assert.equal(initial.sentinelDigest, sentinelDigest);

  await execFileAsync(SYSTEM_GIT, ["config", "diff.external", "/bin/echo"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "external diff must not replace authority bytes\n");
  const hardened = await captureAutonomyReadinessSnapshotFromSource(root, binding, sourceBindingDigest, { sentinelDigest });
  const expectedDiff = (await execFileAsync(SYSTEM_GIT, [
    "diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"
  ], { cwd: root, encoding: "buffer" })).stdout;
  assert.equal(hardened.trackedDiffBytes, expectedDiff.byteLength);
  assert.equal(hardened.trackedDiffDigest, sha256(expectedDiff));
  await execFileAsync(SYSTEM_GIT, ["config", "--unset", "diff.external"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "autonomy preflight\n");

  await assert.rejects(
    captureAutonomyReadinessSnapshotFromSource(root, binding, sourceBindingDigest, {
      sentinelDigest,
      beforeFinalCheck: () => writeFile(path.join(root, "README.md"), "changed during capture\n")
    }),
    (error) => error.autonomyReason === "autonomy-snapshot-drift"
  );
  await writeFile(path.join(root, "README.md"), "autonomy preflight\n");

  await execFileAsync(SYSTEM_GIT, ["switch", "-qc", "dev"], { cwd: root });
  await assert.rejects(
    captureAutonomyReadinessSnapshotFromSource(root, binding, sourceBindingDigest, { sentinelDigest }),
    (error) => error.autonomyReason === "branch-outside-autonomy-scope"
  );
  await execFileAsync(SYSTEM_GIT, ["switch", "-q", "codex/preflight"], { cwd: root });

  await writeFile(path.join(root, "outside.txt"), "outside\n");
  await assert.rejects(
    captureAutonomyReadinessSnapshotFromSource(root, binding, sourceBindingDigest, { sentinelDigest }),
    (error) => error.autonomyReason === "path-outside-autonomy-scope"
  );
  await rm(path.join(root, "outside.txt"));

  await writeFile(path.join(root, "README.md"), "x".repeat(profile.limits.maxDiffBytes + 4096));
  await assert.rejects(
    captureAutonomyReadinessSnapshotFromSource(root, binding, sourceBindingDigest, { sentinelDigest }),
    (error) => error.autonomyReason === "diff-byte-limit"
  );
  await rm(root, { recursive: true, force: true });
});
