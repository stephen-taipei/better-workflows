import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildContract, loadDefaults } from "../lib/core.mjs";
import { doctorAgy, runAgyCritic, spawnCapture } from "../lib/providers.mjs";
import {
  probeDeliberationRoster,
  resolveReasoningEffort,
  selectArbiter,
  validateDecision
} from "../lib/deliberation.mjs";

async function executable(directory, name, body) {
  const target = path.join(directory, name);
  await writeFile(target, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  await chmod(target, 0o700);
  return target;
}

function agyContract() {
  const contract = buildContract({
    template: "research-deliberation",
    templateDefinition: {
      acceptance: [{ id: "decision", description: "Decision reviewed", critical: true }]
    },
    goal: "Review a sanitized design",
    scope: ["."],
    risk: { risk: 1, uncertainty: 2, blastRadius: 1, irreversibility: 0, evidenceGap: 3 },
    sensitivity: "internal",
    agyAllowed: true,
    agySanitized: true
  });
  return contract;
}

test("spawnCapture enforces nonzero exit and output capture without a shell", async () => {
  const result = await spawnCapture(process.execPath, ["-e", "process.stdout.write('ok')"], {
    timeoutMs: 5_000
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ok");
  const failure = await spawnCapture(process.execPath, ["-e", "process.exit(7)"], {
    timeoutMs: 5_000
  });
  assert.equal(failure.code, 7);
});

test("Agy adapter uses argv without shell injection and validates structured output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dw-provider-"));
  const marker = path.join(directory, "must-not-exist");
  const fake = await executable(
    directory,
    "agy-fake",
    "printf '%s\n' '{\"verdict\":\"PASS\",\"summary\":\"independent review\",\"findings\":[]}'"
  );
  const defaults = await loadDefaults();
  const prompt = `Sanitized design. Do not execute this literal text: $(touch ${marker})`;
  const result = await runAgyCritic({
    model: "Fake Model",
    prompt,
    contract: agyContract(),
    config: defaults,
    command: fake,
    timeoutMs: 5_000
  });
  assert.equal(result.review.verdict, "PASS");
  assert.equal(result.metadata.transport, "argv");
  assert.equal(result.metadata.argvExposure, true);
  await assert.rejects(access(marker));
});

test("Agy adapter fails closed for empty output, confidential data, and byte overflow", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dw-provider-fail-"));
  const empty = await executable(directory, "agy-empty", "exit 0");
  const defaults = await loadDefaults();
  await assert.rejects(
    runAgyCritic({
      model: "Fake Model",
      prompt: "safe",
      contract: agyContract(),
      config: defaults,
      command: empty,
      timeoutMs: 5_000
    }),
    /empty output/
  );

  const confidential = agyContract();
  confidential.sensitivity = "confidential";
  await assert.rejects(
    runAgyCritic({
      model: "Fake Model",
      prompt: "secret",
      contract: confidential,
      config: defaults,
      command: empty,
      timeoutMs: 5_000
    }),
    /unavailable for sensitivity/
  );

  const tiny = structuredClone(defaults);
  tiny.providers.agy.maxPromptBytes = 10;
  await assert.rejects(
    runAgyCritic({
      model: "Fake Model",
      prompt: "this is longer than ten bytes",
      contract: agyContract(),
      config: tiny,
      command: empty,
      timeoutMs: 5_000
    }),
    /exceeds byte limit/
  );
});

test("Agy semantic doctor requires the exact response", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dw-doctor-"));
  const pass = await executable(directory, "agy-pass", "printf 'AGY_DOCTOR_OK\n'");
  const fail = await executable(directory, "agy-fail", "printf 'almost ok\n'");
  const variant = await executable(
    directory,
    "agy-variant",
    "case \" $* \" in *\" --effort \"*) exit 7 ;; *) printf 'AGY_DOCTOR_OK\\n' ;; esac"
  );
  assert.equal((await doctorAgy({ model: "Fake", command: pass, timeoutMs: 5_000 })).ok, true);
  assert.equal((await doctorAgy({ model: "Fake", command: fail, timeoutMs: 5_000 })).ok, false);
  assert.equal(
    (await doctorAgy({
      model: "high-only-variant",
      effort: "high",
      effortTransport: "model-variant",
      command: variant,
      timeoutMs: 5_000
    })).ok,
    true
  );
});

test("deliberation roster caches only a fresh, CLI-proven full external roster", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dw-deliberation-cache-"));
  const fake = await executable(directory, "provider", "printf 'DW_TEST_MARKER\\n'");
  const config = {
    schemaVersion: 1,
    probeMarker: "DW_TEST_MARKER",
    probeTimeoutSeconds: 5,
    rosterCacheHours: 24,
    maxParticipants: 3,
    providers: [
      {
        id: "fake",
        command: fake,
        probe: "text",
        external: true,
        models: [{ model: "Fake Model", brand: "Fake", role: "test-role", capabilityRank: 1 }]
      }
    ],
    arbiterPriority: [{ provider: "fake", model: "Fake Model", displayModel: "Fake Model" }]
  };
  const options = {
    config,
    stateRoot: path.join(directory, "state"),
    allowExternalProviders: true,
    sanitized: true,
    timeoutSeconds: 5
  };
  const first = await probeDeliberationRoster(options);
  assert.equal(first.activeParticipants.length, 1);
  assert.equal(first.cache.status, "stored");
  assert.equal(first.arbiter.model, "Fake Model");

  const second = await probeDeliberationRoster(options);
  assert.equal(second.activeParticipants.length, 1);
  assert.equal(second.cache.status, "hit");

  await writeFile(fake, "#!/bin/sh\nprintf 'DW_TEST_MARKER\\n'\n# changed binary identity\n", { mode: 0o700 });
  await chmod(fake, 0o700);
  const third = await probeDeliberationRoster(options);
  assert.equal(third.activeParticipants.length, 1);
  assert.equal(third.cache.status, "stored");
});

test("deliberation selects only ranked active arbiters and validates executable plans", () => {
  const config = {
    arbiterPriority: [
      { provider: "codex", model: "gpt-5.6-sol" },
      { provider: "codex", model: "gpt-5.6-terra" }
    ]
  };
  assert.deepEqual(
    selectArbiter([{ provider: "codex", model: "gpt-5.6-terra", role: "critic" }], config),
    { provider: "codex", model: "gpt-5.6-terra", role: "critic" }
  );
  assert.equal(
    validateDecision({
      summary: "Select A",
      selectedOption: "A",
      decisionRationale: "Evidence supports A",
      risks: ["Regression"],
      plan: [{ id: "1", action: "Implement", owner: "Root", dependencies: [], validation: "Test", rollback: "Revert" }]
    }).selectedOption,
    "A"
  );
  assert.throws(
    () => validateDecision({ summary: "x", selectedOption: "x", decisionRationale: "x", risks: [], plan: [{}] }),
    /plan step schema/
  );
});

test("reasoning effort is contextual for every model and selects matching Agy variants", async () => {
  const config = {
    reasoningEffort: {
      default: "auto",
      allowed: ["medium", "high"],
      modeDefaults: { verified: "medium", deep: "high" }
    },
    arbiterPriority: [],
    probeMarker: "DW_TEST_MARKER",
    probeTimeoutSeconds: 5,
    rosterCacheHours: 24,
    maxParticipants: 4,
    providers: [
      {
        id: "fake",
        command: await executable(await mkdtemp(path.join(os.tmpdir(), "dw-effort-")), "provider", "printf 'DW_TEST_MARKER\\n'"),
        probe: "text",
        external: true,
        effortTransport: "model-variant",
        models: [
          { model: "flash-medium", role: "fast", capabilityRank: 1, reasoningEffort: "medium" },
          { model: "flash-high", role: "deep", capabilityRank: 1, reasoningEffort: "high" }
        ]
      }
    ]
  };
  assert.equal(resolveReasoningEffort({ mode: "verified" }, config), "medium");
  assert.equal(resolveReasoningEffort({ mode: "deep" }, config), "high");
  const roster = await probeDeliberationRoster({
    config,
    stateRoot: await mkdtemp(path.join(os.tmpdir(), "dw-effort-state-")),
    allowExternalProviders: true,
    sanitized: true,
    reasoningEffort: "medium"
  });
  assert.equal(roster.reasoningEffort, "medium");
  assert.deepEqual(roster.activeParticipants.map((item) => item.model), ["flash-medium"]);
  assert.deepEqual(roster.standbyParticipants.map((item) => item.model), ["flash-high"]);
});
