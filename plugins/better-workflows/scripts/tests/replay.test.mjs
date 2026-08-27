import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { digestObject } from "../lib/core.mjs";
import {
  REPLAY_FILE_LIMIT_BYTES,
  ReplayError,
  buildReplaySnapshot,
  listReplayRuns
} from "../lib/replay.mjs";
import {
  REPLAY_HOST,
  REPLAY_PORT,
  ReplayServerError,
  platformOpenCommand,
  startReplayServer
} from "../lib/replay-server.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptDirectory = path.resolve(testDirectory, "..");
const defaultRunId = "sbw-20260826T070000Z-123456abcdef";
const createdAt = "2026-08-26T07:00:00.000Z";
const updatedAt = "2026-08-26T07:05:00.000Z";
const execFileAsync = promisify(execFile);
const canonicalTempRoot = await realpath(os.tmpdir());

function tempPrefix(name) {
  return path.join(canonicalTempRoot, name);
}

async function writeJson(target, value) {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function makeRun(options = {}) {
  const root = options.root ?? await mkdtemp(tempPrefix("sbw-replay-test-"));
  const runId = options.runId ?? defaultRunId;
  const runDir = path.join(root, "runs", runId);
  await mkdir(path.join(runDir, "evidence"), { recursive: true, mode: 0o700 });
  const contract = options.contract ?? {
    schemaVersion: options.schemaVersion ?? 2,
    goal: "Replay a bounded recorded run",
    remoteRevision: null,
    templateDigest: "2".repeat(64)
  };
  const contractDigest = digestObject(contract);
  const sourceBindingDigest = "1".repeat(64);
  const sentinelDigest = "3".repeat(64);
  const manifest = {
    runId,
    template: "pr-to-dev",
    mode: options.mode ?? "critical",
    createdAt,
    contractDigest,
    sourceBinding: {
      digest: sourceBindingDigest,
      headRevision: "a".repeat(40)
    }
  };
  const state = {
    runId,
    status: options.status ?? "completed",
    createdAt,
    updatedAt: options.updatedAt ?? updatedAt,
    lastSentinel: { label: "terminal", digest: sentinelDigest },
    lastSentinelVerified: true,
    lastSentinelComplete: true
  };
  await Promise.all([
    writeJson(path.join(runDir, "manifest.json"), manifest),
    writeJson(path.join(runDir, "contract.json"), contract),
    writeJson(path.join(runDir, "state.json"), state)
  ]);

  if (contract.schemaVersion === 2 && options.ledger !== false) {
    await writeJson(path.join(runDir, "ledger.json"), {
      schemaVersion: 1,
      runId,
      contractDigest,
      createdAt,
      tasks: [{
        id: "project",
        goal: "Project the recorded state",
        dependencies: [],
        requiredEvidence: [],
        attemptBudget: 3,
        kind: "regular"
      }],
      events: [
        { eventId: "event-1", type: "start", taskId: "project", actor: "root" },
        { eventId: "event-2", type: "complete", taskId: "project", actor: "root", evidenceKinds: [] }
      ]
    });
  }

  if (contract.schemaVersion === 2 && options.evidence !== false) {
    const payload = {
      items: [{ result: "TOP_SECRET_SHOULD_NOT_LEAVE_STATE", absolutePath: "/Users/operator/private" }]
    };
    const payloadDigest = digestObject(payload);
    await writeJson(path.join(runDir, "evidence", "environment.json"), {
      schemaVersion: 2,
      id: "environment",
      kind: "environment-state",
      status: "complete",
      summary: "TOP_SECRET_SUMMARY",
      sourceDigest: payloadDigest,
      stale: false,
      receipt: {
        contractId: "evidence-contracts-v1:environment-state",
        contractVersion: 1,
        runId,
        producer: { provider: "codex-root", credential: "TOP_SECRET_CREDENTIAL" },
        inputBinding: {
          runId,
          contractDigest,
          remoteRevision: null,
          sourceBindingDigest,
          sourceSentinelDigest: sentinelDigest
        },
        payload,
        payloadDigest,
        producedAt: updatedAt
      },
      typedAdmission: {
        contractId: "evidence-contracts-v1:environment-state",
        contractVersion: 1,
        admittedAt: updatedAt,
        producer: "codex-root"
      }
    });
  }
  return { root, runDir, runId, contract, manifest, state };
}

async function removeFixture(root) {
  await rm(root, { recursive: true, force: true });
}

function request(server, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Host: options.host ?? `localhost:${server.port}`,
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.origin ? { Origin: options.origin } : {})
    };
    const operation = http.request({
      hostname: "127.0.0.1",
      port: server.port,
      path: requestPath,
      method: options.method ?? "GET",
      headers
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    operation.once("error", reject);
    operation.end();
  });
}

test("recorded replay is deterministic, fail-closed, and excludes raw evidence", async (context) => {
  const fixture = await makeRun();
  context.after(() => removeFixture(fixture.root));
  const watched = ["manifest.json", "contract.json", "state.json", "ledger.json", "evidence/environment.json"];
  const before = await Promise.all(watched.map(async (name) => {
    const target = name.startsWith("evidence/")
      ? path.join(fixture.runDir, name)
      : path.join(fixture.runDir, name);
    const [contents, info] = await Promise.all([readFile(target), lstat(target)]);
    return { name, contents, mode: info.mode, mtimeMs: info.mtimeMs };
  }));

  const first = await buildReplaySnapshot(fixture.root, fixture.runId);
  const second = await buildReplaySnapshot(fixture.root, fixture.runId);
  assert.deepEqual(first, second);
  assert.equal(first.generatedAt, updatedAt);
  assert.equal(first.manifest.assurance.outcome, "RECORDED_COMPLETED");
  assert.equal(first.manifest.assurance.liveReverified, false);
  assert.equal(first.manifest.assurance.presentationOnly, true);
  assert.equal(first.manifest.scenes.length, 8);
  assert.equal(first.manifestDigest, digestObject(first.manifest));
  const projected = JSON.stringify(first);
  for (const secret of [
    "TOP_SECRET_SHOULD_NOT_LEAVE_STATE",
    "TOP_SECRET_SUMMARY",
    "TOP_SECRET_CREDENTIAL",
    "/Users/operator/private"
  ]) assert.doesNotMatch(projected, new RegExp(secret));
  const evidence = first.manifest.scenes.flatMap((scene) => scene.records)
    .find((record) => record.id === "environment");
  assert.deepEqual(Object.keys(evidence).sort(), [
    "category", "digest", "id", "kind", "producedAt", "producer", "severity", "stale", "status"
  ]);

  const after = await Promise.all(watched.map(async (name) => {
    const target = path.join(fixture.runDir, name);
    const [contents, info] = await Promise.all([readFile(target), lstat(target)]);
    return { name, contents, mode: info.mode, mtimeMs: info.mtimeMs };
  }));
  assert.deepEqual(after, before, "replay must not alter source bytes, modes, or mtimes");
});

test("recorded outcomes distinguish active, legacy, and inconsistent snapshots", async (context) => {
  const root = await mkdtemp(tempPrefix("sbw-replay-outcomes-"));
  context.after(() => removeFixture(root));
  const running = await makeRun({
    root,
    runId: "sbw-20260826T070100Z-123456abcdef",
    status: "running",
    updatedAt: "2026-08-26T07:06:00.000Z"
  });
  const legacy = await makeRun({
    root,
    runId: "sbw-20260826T070200Z-123456abcdef",
    schemaVersion: 1,
    evidence: false,
    updatedAt: "2026-08-26T07:07:00.000Z"
  });
  const inconsistent = await makeRun({
    root,
    runId: "sbw-20260826T070300Z-123456abcdef",
    updatedAt: "2026-08-26T07:08:00.000Z"
  });
  const manifest = JSON.parse(await readFile(path.join(inconsistent.runDir, "manifest.json"), "utf8"));
  manifest.contractDigest = "f".repeat(64);
  await writeJson(path.join(inconsistent.runDir, "manifest.json"), manifest);

  assert.equal((await buildReplaySnapshot(root, running.runId)).manifest.assurance.outcome, "UNSEALED");
  assert.equal((await buildReplaySnapshot(root, legacy.runId)).manifest.assurance.outcome, "LEGACY_RECORDED");
  const held = await buildReplaySnapshot(root, inconsistent.runId);
  assert.equal(held.manifest.assurance.outcome, "HOLD");
  assert.ok(held.manifest.assurance.blockers.includes("CONTRACT_DIGEST_MISMATCH"));
  const library = await listReplayRuns(root);
  assert.equal(library.totalRuns, 3);
  assert.equal(library.runs[0].runId, inconsistent.runId);
  assert.equal(library.generatedAt, "2026-08-26T07:08:00.000Z");
});

test("recorded completion fails closed on persisted findings, risk, actions, sentinel, and review blockers", async (context) => {
  const root = await mkdtemp(tempPrefix("sbw-replay-completion-blockers-"));
  context.after(() => removeFixture(root));
  const cases = [
    {
      runId: "sbw-20260826T071101Z-111111111111",
      expected: "OPEN_P1:open-p1",
      mutate: async (fixture) => {
        const directory = path.join(fixture.runDir, "findings");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeJson(path.join(directory, "open-p1.json"), {
          id: "open-p1",
          severity: "P1",
          status: "open",
          summary: "Persisted high-severity blocker"
        });
      }
    },
    {
      runId: "sbw-20260826T071102Z-222222222222",
      expected: "INVALID_ACCEPTED_RISK:expired-risk",
      mutate: async (fixture) => {
        const directory = path.join(fixture.runDir, "findings");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeJson(path.join(directory, "expired-risk.json"), {
          id: "expired-risk",
          severity: "P1",
          status: "accepted-risk",
          owner: "",
          reason: "Temporary exception",
          expiry: "2026-08-26T07:04:00.000Z",
          summary: "Expired and ownerless risk acceptance"
        });
      }
    },
    {
      runId: "sbw-20260826T071103Z-333333333333",
      expected: "SIDE_EFFECT_NOT_RECONCILED:pending-action",
      mutate: async (fixture) => {
        const directory = path.join(fixture.runDir, "actions");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeJson(path.join(directory, "pending-action.json"), {
          attemptId: "pending-action",
          action: "pr.merge",
          status: "issued",
          outcome: "pending"
        });
      }
    },
    {
      runId: "sbw-20260826T071104Z-444444444444",
      expected: "SIDE_EFFECT_NOT_RECONCILED:failed-action",
      mutate: async (fixture) => {
        const directory = path.join(fixture.runDir, "actions");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeJson(path.join(directory, "failed-action.json"), {
          attemptId: "failed-action",
          action: "pr.merge",
          status: "spent",
          outcome: "failure"
        });
      }
    },
    {
      runId: "sbw-20260826T071105Z-555555555555",
      expected: "CURRENT_SENTINEL_NOT_VERIFIED",
      mutate: async (fixture) => {
        await writeJson(path.join(fixture.runDir, "state.json"), {
          ...fixture.state,
          lastSentinelVerified: false,
          lastSentinelComplete: false
        });
      }
    },
    {
      runId: "sbw-20260826T071106Z-666666666666",
      contract: {
        schemaVersion: 2,
        goal: "Replay a bounded recorded run",
        remoteRevision: null,
        templateDigest: "2".repeat(64),
        controlPlane: { reviewPolicy: "code-v1" }
      },
      expected: "REVIEW_CURRENT_PACKAGE_REQUIRED",
      mutate: async () => {}
    }
  ];

  for (const item of cases) {
    const fixture = await makeRun({ root, runId: item.runId, contract: item.contract });
    await item.mutate(fixture);
    const snapshot = await buildReplaySnapshot(root, fixture.runId);
    assert.equal(snapshot.manifest.assurance.outcome, "HOLD", item.runId);
    assert.ok(snapshot.manifest.assurance.blockers.includes(item.expected), `${item.runId}: ${item.expected}`);
  }
});

test("review-kernel-v2 records remain HOLD without authoritative axis and verification replay", async (context) => {
  const root = await mkdtemp(tempPrefix("sbw-replay-kernel-hold-"));
  context.after(() => removeFixture(root));
  const contract = {
    schemaVersion: 2,
    goal: "Replay a bounded recorded kernel run",
    remoteRevision: null,
    templateDigest: "2".repeat(64),
    controlPlane: { reviewPolicy: "code-v2-pilot" }
  };

  async function installKernelPackage(fixture) {
    const scope = ["src/example.mjs"];
    const diffManifest = { files: [{ status: "M", path: "src/example.mjs" }] };
    const reviewPackage = {
      schemaVersion: 2,
      immutable: true,
      packageId: "kernel-package",
      base: "b".repeat(40),
      head: fixture.manifest.sourceBinding.headRevision,
      mergeBase: "b".repeat(40),
      scope,
      scopeDigest: digestObject(scope),
      diffManifest,
      diffManifestDigest: digestObject(diffManifest),
      contractDigest: digestObject(fixture.contract),
      templateDigest: fixture.contract.templateDigest,
      sentinelDigest: fixture.state.lastSentinel.digest,
      instructionDigest: "4".repeat(64),
      repairRounds: 0,
      reviewLanes: [{ id: "security", role: "security", contextProfile: "full", required: true }],
      reviewLanesDigest: "5".repeat(64),
      workUniverseDigest: "6".repeat(64),
      broadReview: {
        complete: true,
        head: fixture.manifest.sourceBinding.headRevision,
        sentinelDigest: fixture.state.lastSentinel.digest,
        findingSetDigest: "7".repeat(64),
        axisSetDigest: "8".repeat(64),
        verificationSetDigest: "9".repeat(64),
        coverageDigest: "a".repeat(64),
        convergenceDigest: "b".repeat(64)
      }
    };
    const directory = path.join(fixture.runDir, "review-packages");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeJson(path.join(directory, "kernel-package.json"), reviewPackage);
    return reviewPackage;
  }

  const cases = [
    { runId: "sbw-20260826T071201Z-aaaaaaaaaaaa", mutate: async () => {} },
    {
      runId: "sbw-20260826T071202Z-bbbbbbbbbbbb",
      mutate: async (fixture) => {
        const directory = path.join(fixture.runDir, "review-verifications");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeJson(path.join(directory, "stale-verification.json"), {
          schemaVersion: 2,
          packageId: "kernel-package",
          repairRound: 1,
          findingId: "finding-v2-stale",
          verdict: "REFUTED"
        });
      }
    },
    {
      runId: "sbw-20260826T071203Z-cccccccccccc",
      mutate: async (fixture) => {
        const directory = path.join(fixture.runDir, "review-synthesis");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeJson(path.join(directory, "blocking-synthesis.json"), {
          schemaVersion: 2,
          packageId: "kernel-package",
          repairRound: 0,
          findings: [{ id: "finding-v2-blocking", blocking: true }],
          convergence: { blockingFindingIds: ["finding-v2-blocking"], complete: false }
        });
      }
    },
    {
      runId: "sbw-20260826T071204Z-dddddddddddd",
      mutate: async (fixture) => {
        for (const [directoryName, name, value] of [
          ["review-coverage", "forged-coverage.json", {
            schemaVersion: 2,
            packageId: "kernel-package",
            repairRound: 0,
            complete: true,
            axisSetDigest: "8".repeat(64),
            coverageDigest: "a".repeat(64)
          }],
          ["review-synthesis", "forged-synthesis.json", {
            schemaVersion: 2,
            packageId: "kernel-package",
            repairRound: 0,
            findingSetDigest: "7".repeat(64),
            axisSetDigest: "8".repeat(64),
            verificationSetDigest: "9".repeat(64),
            coverageDigest: "a".repeat(64),
            convergenceDigest: "b".repeat(64),
            findings: [],
            convergence: { complete: true }
          }]
        ]) {
          const directory = path.join(fixture.runDir, directoryName);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeJson(path.join(directory, name), value);
        }
      }
    }
  ];

  for (const item of cases) {
    const fixture = await makeRun({ root, runId: item.runId, contract, mode: "verified" });
    await installKernelPackage(fixture);
    await item.mutate(fixture);
    const snapshot = await buildReplaySnapshot(root, fixture.runId);
    assert.equal(snapshot.manifest.assurance.outcome, "HOLD", item.runId);
    assert.ok(snapshot.manifest.assurance.blockers.includes(
      "REVIEW_KERNEL_REPLAY_REQUIRES_REVERIFICATION:kernel-package"
    ), item.runId);
  }
});

test("an absent state root renders an empty library without creating state", async (context) => {
  const parent = await mkdtemp(tempPrefix("sbw-replay-absent-"));
  context.after(() => removeFixture(parent));
  const missing = path.join(parent, "not-created");
  const library = await listReplayRuns(missing);
  assert.deepEqual(library, {
    schemaVersion: 1,
    generatedAt: null,
    stateRootPresent: false,
    truncated: false,
    totalRuns: 0,
    runs: []
  });
  await assert.rejects(access(missing));
});

test("snapshot races, malformed input, symlinks, and oversized files fail closed", async (context) => {
  const race = await makeRun();
  context.after(() => removeFixture(race.root));
  let mutations = 0;
  await assert.rejects(
    buildReplaySnapshot(race.root, race.runId, {
      afterFirstRead: async ({ before }) => {
        mutations += 1;
        await writeJson(path.join(race.runDir, "state.json"), {
          ...before.state,
          updatedAt: `2026-08-26T07:05:0${mutations}.000Z`
        });
      }
    }),
    (error) => error instanceof ReplayError && error.code === "INDETERMINATE_SNAPSHOT_RACE"
  );
  assert.equal(mutations, 2);

  const malformed = await makeRun({ runId: "sbw-20260826T071000Z-123456abcdef" });
  context.after(() => removeFixture(malformed.root));
  await writeFile(path.join(malformed.runDir, "state.json"), "{not-json");
  await assert.rejects(
    buildReplaySnapshot(malformed.root, malformed.runId),
    (error) => error instanceof ReplayError && error.code === "REPLAY_INVALID_JSON"
  );

    const linked = await makeRun({ runId: "sbw-20260826T072000Z-123456abcdef" });
  context.after(() => removeFixture(linked.root));
  const statePath = path.join(linked.runDir, "state.json");
  await rename(statePath, `${statePath}.real`);
  await symlink(`${statePath}.real`, statePath);
  await assert.rejects(
    buildReplaySnapshot(linked.root, linked.runId),
    (error) => error instanceof ReplayError && error.code === "REPLAY_SYMLINK_REJECTED"
  );

  const hardlinked = await makeRun({ runId: "sbw-20260826T072500Z-123456abcdef" });
  context.after(() => removeFixture(hardlinked.root));
  await link(
    path.join(hardlinked.runDir, "state.json"),
    path.join(hardlinked.runDir, "state-copy.json")
  );
  await assert.rejects(
    buildReplaySnapshot(hardlinked.root, hardlinked.runId),
    (error) => error instanceof ReplayError && error.code === "REPLAY_UNSAFE_FILE"
  );

  const oversized = await makeRun({ runId: "sbw-20260826T073000Z-123456abcdef" });
  context.after(() => removeFixture(oversized.root));
  await writeFile(path.join(oversized.runDir, "state.json"), "x".repeat(REPLAY_FILE_LIMIT_BYTES + 1));
  await assert.rejects(
    buildReplaySnapshot(oversized.root, oversized.runId),
    (error) => error instanceof ReplayError && error.code === "REPLAY_FILE_TOO_LARGE"
  );
  await assert.rejects(
    buildReplaySnapshot(oversized.root, "../../etc/passwd"),
    (error) => error instanceof ReplayError && error.code === "REPLAY_INVALID_RUN_ID"
  );
});

test("localhost server uses one-shot session bootstrap and strict allowlisted routes", async (context) => {
  const fixture = await makeRun();
  context.after(() => removeFixture(fixture.root));
  const server = await startReplayServer({ stateRoot: fixture.root, runId: fixture.runId, port: 0 });
  context.after(() => server.close());
  assert.equal(server.host, REPLAY_HOST);
  assert.equal(REPLAY_PORT, 9300);
  assert.equal(server.cleanUrl, `http://localhost:${server.port}/runs/${fixture.runId}`);
  assert.doesNotMatch(server.cleanUrl, /bootstrap/);

  const unauthenticated = await request(server, "/");
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(JSON.parse(unauthenticated.body), { ok: false, error: "REPLAY_SESSION_REQUIRED" });

  const bootstrapPath = new URL(server.bootstrapUrl).pathname;
  const bootstrap = await request(server, bootstrapPath);
  assert.equal(bootstrap.status, 303);
  assert.equal(bootstrap.headers.location, `/runs/${fixture.runId}`);
  assert.match(bootstrap.headers["set-cookie"][0], /HttpOnly; SameSite=Strict; Path=\//);
  const cookie = bootstrap.headers["set-cookie"][0].split(";", 1)[0];
  assert.equal((await request(server, bootstrapPath)).status, 401, "bootstrap token must be single-use");

  const api = await request(server, `/api/v1/runs/${fixture.runId}/replay`, { cookie });
  assert.equal(api.status, 200);
  assert.equal(JSON.parse(api.body).manifest.run.runId, fixture.runId);
  assert.match(api.headers["content-security-policy"], /default-src 'none'/);
  assert.equal(api.headers["cache-control"], "no-store");

  const html = await request(server, `/runs/${fixture.runId}`, { cookie });
  assert.equal(html.status, 200);
  assert.match(html.body.toString("utf8"), /data-replay-mode="runtime"/);
  assert.equal((await request(server, "/assets/cast-lineup.webp", { cookie })).status, 200);
  assert.equal((await request(server, "/api/v1/runs?leak=true", { cookie })).status, 400);
  assert.equal((await request(server, "http://evil.example/", { cookie })).status, 400);
  assert.equal((await request(server, "/", { cookie, method: "POST" })).status, 405);
  assert.equal((await request(server, "/", { cookie, host: `evil.example:${server.port}` })).status, 421);
  assert.equal((await request(server, "/", {
    cookie,
    origin: "http://evil.example"
  })).status, 403);
});

test("expired bootstrap URLs cannot create a replay session", async (context) => {
  const fixture = await makeRun();
  context.after(() => removeFixture(fixture.root));
  const server = await startReplayServer({ stateRoot: fixture.root, port: 0, bootstrapTtlMs: -1 });
  context.after(() => server.close());
  assert.equal((await request(server, new URL(server.bootstrapUrl).pathname)).status, 401);
});

test("server rejects non-loopback binding and reports port conflicts deterministically", async (context) => {
  const fixture = await makeRun();
  context.after(() => removeFixture(fixture.root));
  await assert.rejects(
    startReplayServer({ stateRoot: fixture.root, host: "0.0.0.0", port: 0 }),
    (error) => error instanceof ReplayServerError && error.code === "REPLAY_HOST_INVALID"
  );
  const first = await startReplayServer({ stateRoot: fixture.root, port: 0 });
  context.after(() => first.close());
  await assert.rejects(
    startReplayServer({ stateRoot: fixture.root, port: first.port }),
    (error) => error instanceof ReplayServerError && error.code === "REPLAY_PORT_IN_USE" && error.exitCode === 2
  );
});

test("browser opener is fixed-argv and replay modules contain no privileged review path", async () => {
  assert.deepEqual(platformOpenCommand("http://localhost:9300/bootstrap/token", "darwin"), {
    executable: "/usr/bin/open",
    args: ["http://localhost:9300/bootstrap/token"]
  });
  assert.deepEqual(platformOpenCommand("http://localhost:9300/bootstrap/token", "linux"), {
    executable: "/usr/bin/xdg-open",
    args: ["http://localhost:9300/bootstrap/token"]
  });
  const [serverSource, replaySource] = await Promise.all([
    readFile(path.join(scriptDirectory, "lib", "replay-server.mjs"), "utf8"),
    readFile(path.join(scriptDirectory, "lib", "replay.mjs"), "utf8")
  ]);
  assert.doesNotMatch(`${serverSource}\n${replaySource}`, /\bsudo\b|host-trust|runCodexCritic|runAgyCritic/);
  assert.match(serverSource, /shell: false/);
});

test("CLI help exposes the built-in evidence replay entrypoint", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [path.join(scriptDirectory, "sbw.mjs"), "help"],
    { timeout: 10_000, maxBuffer: 1024 * 1024 }
  );
  assert.equal(stderr, "");
  assert.match(stdout, /sbw evidence replay \[<run-id>\] \[--no-open\]/);
});
