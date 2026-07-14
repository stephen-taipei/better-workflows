import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildContract, loadDefaults } from "../lib/core.mjs";
import { doctorAgy, runAgyCritic, spawnCapture } from "../lib/providers.mjs";

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
  assert.equal((await doctorAgy({ model: "Fake", command: pass, timeoutMs: 5_000 })).ok, true);
  assert.equal((await doctorAgy({ model: "Fake", command: fail, timeoutMs: 5_000 })).ok, false);
});
