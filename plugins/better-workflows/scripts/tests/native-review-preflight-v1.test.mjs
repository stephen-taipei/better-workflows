import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { digestObject } from "../lib/core.mjs";
import { parseNativeReviewCodexCliVersionV1, runNativeReview } from "../lib/native-review-runner.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exists = async (p) => access(p).then(() => true, () => false);
const runnerModule = new URL("../lib/native-review-runner.mjs", import.meta.url).href;

// These are local protocol fixtures, never actual Codex or qualification evidence.
async function fixture(t, behavior = "unsupported", sharded = false, mutation = null) {
  const root = await realpath(await mkdtemp("/private/tmp/bw-native-preflight-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"), runDir = path.join(root, "run");
  await mkdir(repo); await mkdir(path.join(runDir, "review-packages"), { recursive: true });
  const git = (...args) => execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "--initial-branch=dev"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(repo, "sample.txt"), "before\n"); git("add", "sample.txt"); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  await writeFile(path.join(repo, "sample.txt"), "after\n"); git("add", "sample.txt"); git("commit", "-qm", "head"); const head = git("rev-parse", "HEAD");
  const packageId = "fixture-package", runId = "fixture-run", manifest = { files: [{ status: "M", path: "sample.txt" }] };
  const instruction = "Read-only simulated review. No external model or authority.\n";
  const packageValue = { schemaVersion: 1, immutable: true, packageId, base, head, mergeBase: base, scope: ["."], scopeDigest: digestObject(["."]), diffManifest: manifest, diffManifestDigest: digestObject(manifest), contractDigest: "1".repeat(64), templateDigest: "2".repeat(64), sentinelDigest: "3".repeat(64), instructionDigest: sha(instruction) };
  const packagePath = path.join(runDir, "review-packages", packageId + ".json"), manifestPath = path.join(root, "manifest.json"), instructionPath = path.join(root, "instruction.md"), authorizationPath = path.join(root, "authorization.json"), resultPath = path.join(root, "result.json");
  await writeFile(packagePath, JSON.stringify(packageValue)); await writeFile(manifestPath, JSON.stringify(manifest)); await writeFile(instructionPath, instruction);
  const binding = { runId, repository: repo, base, head, packageId, packageSha256: sha(await readFile(packagePath)), manifestSha256: sha(await readFile(manifestPath)), instructionSha256: sha(instruction), reviewProtocol: "native-review-observed-content-v5", model: "gpt-5.6-luna", reasoningEffort: "max", reviewerId: "fixture-reviewer", executionId: "fixture-execution", resultPath };
  const authorization = { schemaVersion: 1, kind: "native-review-disclosure", authorized: true, authorizationId: "fixture-authorization", approvedAt: new Date().toISOString(), readOnly: true, ephemeral: true, remoteSideEffects: false, ...binding };
  await writeFile(authorizationPath, JSON.stringify(authorization));
  const marker = path.join(root, "invocations.txt"), childPid = path.join(root, "child.pid"), binary = path.join(root, "codex-fixture");
  await writeFile(binary, `#!${process.execPath}\n` + `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
let marker = ${JSON.stringify(marker)}, childPid = ${JSON.stringify(childPid)}, behavior = ${JSON.stringify(behavior)}, mutation = ${JSON.stringify(mutation)};
fs.appendFileSync(marker, (process.argv.includes("app-server") ? "app-server" : process.argv[2]) + "\\n");
if (process.argv[2] === "--version") {
  mutation = mutation || (fs.existsSync(marker + ".mutation") ? JSON.parse(fs.readFileSync(marker + ".mutation")) : null);
  if (mutation) {
    if (mutation.kind === "directory") fs.mkdirSync(mutation.path, { recursive: true });
    else if (mutation.kind === "replace-directory") { fs.renameSync(mutation.path, mutation.path + ".original"); fs.mkdirSync(mutation.path, { recursive: true }); }
    else if (mutation.kind === "modify") fs.appendFileSync(mutation.path, " ");
    else { fs.mkdirSync(require("node:path").dirname(mutation.path), { recursive: true }); fs.writeFileSync(mutation.path, "probe-artifact", { flag: "wx" }); }
  }
  if (behavior === "unsupported") process.stdout.write("codex-cli 0.160.1\\n");
  else if (behavior === "malformed") process.stdout.write("banner 0.153.4\\n");
  else if (behavior === "nonzero") { process.stderr.write("fixture-private-stderr\\n"); process.exit(7); }
  else if (behavior === "overflow") { process.stdout.write("x".repeat(4097)); process.stderr.write("y".repeat(4096)); }
  else if (behavior === "timeout") { const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); fs.writeFileSync(childPid, String(child.pid)); setInterval(()=>{},1000); }
  else if (behavior === "source-drift") { fs.appendFileSync("sample.txt", "preflight-drift\\n"); process.stdout.write("codex-cli 0.153.4\\n"); }
  else process.stdout.write("codex-cli 0.153.4\\n");
} else if (process.argv.includes("app-server")) {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", line => { const request = JSON.parse(line); if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: "fixture-codex/0.160.1" } }) + "\\n"); else fs.appendFileSync(marker, "rpc:" + request.method + "\\n"); });
}
`, { mode: 0o700 });
  const args = { runId, runDir, cwd: repo, base, head, packageId, packagePath, manifestPath, instructionPath, authorizationPath, model: binding.model, effort: "max", reviewerId: binding.reviewerId, executionId: binding.executionId, resultPath };
  if (sharded) {
    const shardPolicyPath = path.join(root, "policy.json");
    await writeFile(shardPolicyPath, JSON.stringify({ schemaVersion: 1, targetBytes: 65536, maxShardBytes: 131072, maxShards: 8, concurrency: 1, shardTimeoutMs: 15000, totalTimeoutMs: 30000, executionBudget: 9 }));
    args.shardPolicyPath = shardPolicyPath;
    const prepared = await runNativeReview({ ...args, prepareOnly: true });
    await writeFile(authorizationPath, JSON.stringify({ ...authorization, ...prepared.binding }));
  }
  return { root, args, binary, marker, childPid, attempt: path.join(runDir, "native-review-attempts", packageId + ".json") };
}

async function withBinary(f, operation) {
  const old = process.env.CODEX_BINARY;
  process.env.CODEX_BINARY = f.binary;
  try { return await operation(); } finally { if (old === undefined) delete process.env.CODEX_BINARY; else process.env.CODEX_BINARY = old; }
}

test("version parser accepts only one standard CLI version line", () => {
  assert.equal(parseNativeReviewCodexCliVersionV1("codex-cli 0.153.4\n"), "0.153.4");
  assert.equal(parseNativeReviewCodexCliVersionV1("  codex-cli 0.156.1 \n"), "0.156.1");
  for (const value of ["banner 0.153.4", "codex-cli 0.153.4\nextra", "codex-cli 0.153.4 0.160.1", "codex-cli 0.153.4-preview", "", null]) assert.equal(parseNativeReviewCodexCliVersionV1(value), null);
});

async function assertNoExecutionArtifacts(f, sharded) {
  const content = path.join(f.args.runDir, "native-review-content", f.args.packageId);
  if (!sharded) assert.equal(await exists(content), false);
  assert.equal(await exists(path.join(content, "app-server-job.json")), false);
  assert.equal(await exists(path.join(content, "shards")), false);
  for (const name of ["package", "manifest", "instruction", "authorization", "policy"]) {
    assert.equal(await exists(path.join(content, `${name}.snapshot`)), false);
  }
}

for (const sharded of [false, true]) {
  for (const [behavior, code] of [["unsupported", "native-review-cli-version-unsupported"], ["malformed", "native-review-cli-version-format-invalid"], ["nonzero", "native-review-cli-version-unavailable"], ["overflow", "native-review-cli-version-unavailable"], ["timeout", "native-review-cli-version-unavailable"]]) {
    test(`${sharded ? "sharded" : "single"} ${behavior} rejects before consuming attempt`, async (t) => {
      const f = await fixture(t, behavior, sharded);
      await withBinary(f, async () => {
        await assert.rejects(runNativeReview(f.args), error => error.code === code && error.message === code && !JSON.stringify(error).includes("fixture-private-stderr"));
      });
      assert.equal(await exists(f.attempt), false);
      assert.equal(await readFile(f.marker, "utf8"), "--version\n");
      assert.equal(await exists(f.args.resultPath), false);
      await assertNoExecutionArtifacts(f, sharded);
      if (behavior === "timeout") {
        const pid = Number(await readFile(f.childPid, "utf8"));
        assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
      }
    });
  }
}

for (const sharded of [false, true]) {
  test(`${sharded ? "sharded" : "single"} unsupported preflight permits a supported same-package retry`, async (t) => {
    const f = await fixture(t, "unsupported", sharded);
    await withBinary(f, async () => {
      await assert.rejects(runNativeReview(f.args), error => error.code === "native-review-cli-version-unsupported");
      assert.equal(await exists(f.attempt), false);
      await assertNoExecutionArtifacts(f, sharded);
      const binary = await readFile(f.binary, "utf8");
      await writeFile(f.binary, binary.replace('behavior = "unsupported"', 'behavior = "supported"'));
      await assert.rejects(runNativeReview(f.args));
    });
    assert.equal(await exists(f.attempt), true);
    assert.equal(await readFile(f.marker, "utf8"), "--version\n--version\napp-server\n");
    const receiptPath = sharded
      ? path.join(f.args.runDir, "native-review-content", f.args.packageId, "shards", "shard-000", "result.json.receipt.json")
      : f.args.resultPath + ".receipt.json";
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.match(receipt.execution.stderr, /Unsupported Codex app-server version/);
    assert.equal(receipt.execution.groupTerminated, true);
  });
  test(`${sharded ? "sharded" : "single"} preflight source drift rejects before execution preparation`, async (t) => {
    const f = await fixture(t, "source-drift", sharded);
    await withBinary(f, async () => assert.rejects(runNativeReview(f.args), /Native review source changed/));
    assert.equal(await exists(f.attempt), false);
    await assertNoExecutionArtifacts(f, sharded);
    assert.equal(await exists(f.args.resultPath + ".receipt.json"), false);
    assert.equal(await readFile(f.marker, "utf8"), "--version\n");
  });
}

test("preparation never executes the selected binary", async (t) => {
  const f = await fixture(t, "unsupported", true);
  await withBinary(f, async () => { const result = await runNativeReview({ ...f.args, prepareOnly: true }); assert.equal(result.modelStarted, false); });
  assert.equal(await exists(f.marker), false); assert.equal(await exists(f.attempt), false);
});

for (const sharded of [false, true]) {
  test(`${sharded ? "sharded" : "single"} consumed attempt still rejects before preflight`, async (t) => {
    const f = await fixture(t, "supported", sharded);
    await mkdir(path.dirname(f.attempt), { recursive: true }); await writeFile(f.attempt, JSON.stringify({ status: "blocked", fixture: true }));
    await withBinary(f, async () => assert.rejects(runNativeReview(f.args), /already has a consumed model attempt/));
    assert.equal(await exists(f.marker), false);
  });
  test(`${sharded ? "sharded" : "single"} supported preflight preserves actual handshake rejection`, async (t) => {
    const f = await fixture(t, "supported", sharded);
    await withBinary(f, async () => assert.rejects(runNativeReview(f.args)));
    assert.equal(await exists(f.attempt), true);
    const invocations = await readFile(f.marker, "utf8");
    assert.equal(invocations.split("\n")[0], "--version");
    assert.ok(invocations.split("\n").includes("app-server"));
    assert.equal(invocations.includes("rpc:thread/start"), false);
    const receipt = sharded
      ? JSON.parse(await readFile(path.join(f.args.runDir, "native-review-content", f.args.packageId, "shards", "shard-000", "result.json.receipt.json"), "utf8"))
      : JSON.parse(await readFile(f.args.resultPath + ".receipt.json", "utf8"));
    assert.match(receipt.execution.stderr, /Unsupported Codex app-server version/);
    assert.equal(receipt.execution.groupTerminated, true);
  });
}

test("unverifiable cleanup rejects without consuming an attempt", async (t) => {
  const f = await fixture(t, "supported", false);
  const harness = path.join(f.root, "cleanup-harness.mjs");
  await writeFile(harness, `import { runNativeReview } from ${JSON.stringify(runnerModule)};
const original = process.kill.bind(process);
process.kill = (pid, signal) => { if (pid < 0 && signal === 0) throw Object.assign(new Error("fixture denied observation"), { code: "EPERM" }); return original(pid, signal); };
try { await runNativeReview(${JSON.stringify(f.args)}); process.exitCode = 2; }
catch(error) { process.stdout.write(error.code || error.message); }
finally { process.kill = original; }
`);
  const result = await withBinary(f, async () => execFileSync(process.execPath, [harness], { encoding: "utf8", timeout: 20000 }));
  assert.equal(result, "native-review-cli-preflight-cleanup-incomplete");
  assert.equal(await exists(f.attempt), false);
});

for (const sharded of [false, true]) {
  const targets = sharded ? ["attempt", "result", "snapshot", "shards"] : ["attempt", "result", "content", "trace"];
  for (const target of targets) test(`${sharded ? "sharded" : "single"} version probe artifact ${target} blocks before launch`, async t => {
    const f = await fixture(t, "supported", sharded);
    const content = path.join(f.args.runDir, "native-review-content", f.args.packageId);
    const artifact = ({ attempt: f.attempt, result: f.args.resultPath, snapshot: path.join(content, "package.snapshot"),
      shards: path.join(content, "shards"), content, trace: f.args.resultPath + ".events.jsonl" })[target];
    await writeFile(f.marker + ".mutation", JSON.stringify({ path: artifact, kind: ["content", "shards"].includes(target) ? "directory" : "file" }));
    await withBinary(f, () => assert.rejects(runNativeReview(f.args), error => error.code === "native-review-cli-preflight-cleanup-incomplete"));
    assert.equal(await readFile(f.marker, "utf8"), "--version\n");
    assert.equal(await exists(artifact), true);
    if (target !== "attempt") assert.equal(await exists(f.attempt), false);
  });
  test(`${sharded ? "sharded" : "single"} unsupported probe artifact mutation takes cleanup precedence`, async t => {
    const f = await fixture(t, "unsupported", sharded);
    await writeFile(f.marker + ".mutation", JSON.stringify({ path: f.args.resultPath, kind: "file" }));
    await withBinary(f, () => assert.rejects(runNativeReview(f.args), error => error.code === "native-review-cli-preflight-cleanup-incomplete"));
    assert.equal(await readFile(f.marker, "utf8"), "--version\n");
    assert.equal(await readFile(f.args.resultPath, "utf8"), "probe-artifact");
    assert.equal(await exists(f.attempt), false);
  });
  test(`${sharded ? "sharded" : "single"} preexisting execution artifact rejects before CLI invocation`, async t => {
    const f = await fixture(t, "supported", sharded);
    const content = path.join(f.args.runDir, "native-review-content", f.args.packageId);
    const artifact = sharded ? path.join(content, "package.snapshot") : content;
    if (sharded) await writeFile(artifact, "existing"); else await mkdir(artifact, { recursive: true });
    await withBinary(f, () => assert.rejects(runNativeReview(f.args), error => error.code === "native-review-cli-preflight-cleanup-incomplete"));
    assert.equal(await exists(f.marker), false); assert.equal(await exists(artifact), true);
    assert.equal(await exists(f.attempt), false);
  });
}
for (const target of ["index.json", "shard-plan.json", "shard-preparation.json", "directory"]) {
  test(`sharded probe prepared ${target} drift blocks before launch`, async t => {
    const f = await fixture(t, "supported", true);
    const content = path.join(f.args.runDir, "native-review-content", f.args.packageId);
    const artifact = target === "directory" ? content : path.join(content, target);
    await writeFile(f.marker + ".mutation", JSON.stringify({ path: artifact, kind: target === "directory" ? "replace-directory" : "modify" }));
    await withBinary(f, () => assert.rejects(runNativeReview(f.args), error => error.code === "native-review-cli-preflight-cleanup-incomplete"));
    assert.equal(await readFile(f.marker, "utf8"), "--version\n"); assert.equal(await exists(f.attempt), false);
    assert.equal(await exists(artifact), true);
  });
}
