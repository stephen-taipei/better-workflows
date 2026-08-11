import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildContract, canonicalJson, loadDefaults, sha256 } from "../lib/core.mjs";
import {
  buildEvaluatorInferenceInput,
  evaluatorToolPolicy,
  validateEvaluatorRegistryProbeRequest
} from "../host-trust.mjs";
import {
  binaryIdentity,
  doctorAgy,
  providerFinalOutput,
  providerFailureSummary,
  parseTrustedEvaluatorTranscript,
  runAgyCritic,
  runCodexEvaluation,
  spawnCapture,
  validateTrustedEvaluatorRegistryProof,
  validateTrustedEvaluatorToolPolicy,
  evaluatorForwardHeaderPolicy
} from "../lib/providers.mjs";
import {
  loadDeliberationRoster,
  probeDeliberationRoster,
  resolveReasoningEffort,
  selectArbiter,
  validateDeliberationRosterConfig,
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

test("provider timeout diagnostics are explicit, bounded, and redact stderr", async () => {
  const echoedMaterial = "sanitized-payload-that-must-not-be-echoed";
  const result = await spawnCapture(
    process.execPath,
    ["-e", `process.stderr.write(${JSON.stringify(echoedMaterial)}); setTimeout(() => {}, 10_000)`],
    { timeoutMs: 50 }
  );
  assert.equal(result.code, null);
  assert.equal(result.timedOut, true);
  const diagnostic = providerFailureSummary("Codex evaluation", result, 50);
  assert.match(diagnostic, /timed out after 50ms/);
  assert.match(diagnostic, /signal=SIGTERM/);
  assert.match(diagnostic, /stderrDigest=[a-f0-9]{64}/);
  assert.doesNotMatch(diagnostic, new RegExp(echoedMaterial));
});

test("provider final output prefers a private file and fails bounded when every transport is empty", () => {
  assert.deepEqual(
    providerFinalOutput('{"results":[]}\n', '{"results\":[\"stdout\"]}\n'),
    { output: '{"results":[]}\n', transport: "private-file" }
  );
  assert.deepEqual(
    providerFinalOutput("", '{"results":[]}\n'),
    { output: '{"results":[]}\n', transport: "stdout-fallback" }
  );
  assert.throws(
    () => providerFinalOutput("", ""),
    /fileBytes=0; fileDigest=[a-f0-9]{64}; stdoutBytes=0; stdoutDigest=[a-f0-9]{64}/
  );
});

test("trusted provider verifier independently rejects tool-bearing evaluator transcripts", () => {
  const events = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "message-1", type: "agent_message", text: '{"results":[]}' } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }
  ];
  const parsed = parseTrustedEvaluatorTranscript(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  assert.equal(parsed.responseText, '{"results":[]}');
  assert.equal(parsed.transcriptSummary.observedToolCalls, 0);
  events.splice(2, 0, { type: "item.completed", item: { id: "tool-1", type: "mcp_tool_call", server: "untrusted" } });
  assert.throws(
    () => parseTrustedEvaluatorTranscript(events.map((event) => JSON.stringify(event)).join("\n") + "\n"),
    /prohibited or unknown item/
  );
  const clean = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "warning-1", type: "error", message: "deprecated feature" } },
    { type: "item.completed", item: { id: "message-1", type: "agent_message", text: '{"results":[]}' } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  for (const [needle, replacement] of [
    [JSON.stringify({ type: "thread.started", thread_id: "thread-1" }), { type: "thread.started", thread_id: "thread-1", item: { type: "command_execution" } }],
    [JSON.stringify({ type: "turn.started" }), { type: "turn.started", item: { type: "command_execution" } }],
    [JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }), { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 }, item: { type: "command_execution" } }],
    [JSON.stringify({ type: "item.completed", item: { id: "warning-1", type: "error", message: "deprecated feature" } }), { type: "item.completed", item: { id: "warning-1", type: "error", message: "deprecated feature", tool_call: "unexpected" } }]
  ]) {
    assert.throws(() => parseTrustedEvaluatorTranscript(clean.replace(needle, JSON.stringify(replacement))), /schema is invalid|prohibited or unknown/);
  }
});

test("host and provider share the exact ordered evaluator capability policy", () => {
  const policy = evaluatorToolPolicy("gpt-5.6-terra");
  const digest = sha256(canonicalJson(policy));
  assert.deepEqual(validateTrustedEvaluatorToolPolicy(policy, digest), policy);
  const reordered = structuredClone(policy);
  reordered.disabledFeatures.reverse();
  assert.throws(
    () => validateTrustedEvaluatorToolPolicy(reordered, sha256(canonicalJson(reordered))),
    /exact tool-free capability policy/
  );
});

test("provider accepts only one host-shaped challenge-bound forwarding proof", () => {
  const challenge = "c".repeat(64);
  const input = buildEvaluatorInferenceInput(Buffer.from("provider registry proof\n"), challenge).toString("utf8");
  const outputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: { results: { type: "array", items: { type: "string" } } }
  };
  const request = validateEvaluatorRegistryProbeRequest({
    model: "gpt-5.6-terra",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }],
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    reasoning: { effort: "high", context: "all_turns" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    text: {
      format: {
        type: "json_schema",
        strict: true,
        schema: outputSchema,
        name: "codex_output_schema"
      }
    }
  }, "gpt-5.6-terra", challenge, input, outputSchema);
  const boundRequest = {
    ...request,
    capturedRequestDigest: "4".repeat(64),
    requestDigest: "1".repeat(64),
    forwardedBodyDigest: "1".repeat(64)
  };
  const unsigned = {
    schemaVersion: 3,
    transport: "openai-responses-http-canonical-gate-v3",
    model: "gpt-5.6-terra",
    requestCount: 1,
    requests: [boundRequest],
    challengeDigest: request.challengeDigest,
    inferenceInputDigest: request.inferenceInputDigest,
    headerPolicyDigest: request.headerPolicyDigest,
    requestPolicyDigest: request.requestPolicyDigest,
    gateNonceDigest: "2".repeat(64),
    upstreamBaseUrlDigest: sha256("https://chatgpt.com/backend-api/codex/"),
    forwarded: true
  };
  const proof = { ...unsigned, digest: sha256(canonicalJson(unsigned)) };
  assert.deepEqual(validateTrustedEvaluatorRegistryProof(proof, proof.digest, "gpt-5.6-terra"), proof);
  const nonCanonicalUnsigned = {
    ...unsigned,
    upstreamBaseUrlDigest: sha256("https://chatgpt.com:444/backend-api/codex/")
  };
  const nonCanonical = { ...nonCanonicalUnsigned, digest: sha256(canonicalJson(nonCanonicalUnsigned)) };
  assert.throws(
    () => validateTrustedEvaluatorRegistryProof(nonCanonical, nonCanonical.digest, "gpt-5.6-terra"),
    /registry proof identity or digest is invalid/
  );
  const extraUnsigned = { ...unsigned, requestCount: 2, requests: [boundRequest, boundRequest] };
  const extra = { ...extraUnsigned, digest: sha256(canonicalJson(extraUnsigned)) };
  assert.throws(
    () => validateTrustedEvaluatorRegistryProof(extra, extra.digest, "gpt-5.6-terra"),
    /registry proof identity or digest is invalid/
  );
  const omittedToolsRequest = { ...boundRequest, toolsPresent: false };
  const omittedUnsigned = { ...unsigned, requests: [omittedToolsRequest] };
  const omitted = { ...omittedUnsigned, digest: sha256(canonicalJson(omittedUnsigned)) };
  assert.throws(
    () => validateTrustedEvaluatorRegistryProof(omitted, omitted.digest, "gpt-5.6-terra"),
    /invalid or tool-capable request/
  );
});

test("provider binary identity resolves symlink commands to a canonical regular file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-provider-identity-"));
  const target = await executable(directory, "provider-target", "exit 0");
  const linked = path.join(directory, "provider-linked");
  await symlink(target, linked);
  const identity = await binaryIdentity(linked);
  assert.equal(identity.path, await realpath(target));
  assert.match(identity.digest, /^[a-f0-9]{64}$/);
});

test("Codex evaluation rejects a caller attestation without valid host anchoring", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-attested-codex-"));
  const evaluationRoot = path.join(directory, "evaluation");
  await mkdir(evaluationRoot);
  await assert.rejects(
    runCodexEvaluation({ model: "attested-test-model", prompt: "safe", evaluationRoot, hostExecutionPath: path.join(directory, "execution.json"),
      execution: { id: "test-execution-1", runId: "run", suiteDigest: "suite", baselineRevision: "baseline", candidateDigest: "candidate", headRevision: "a".repeat(40), promptDigest: sha256("safe"), role: "candidate", sourceBindingDigest: "b".repeat(64), attempt: 1 } }),
    /ENOENT|host execution witness/
  );
});

test("Codex evaluation rejects prompt substitution before invoking a provider", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-attested-prompt-"));
  const evaluationRoot = path.join(directory, "evaluation");
  await mkdir(evaluationRoot);
  await assert.rejects(
    runCodexEvaluation({
      model: "attested-test-model",
      prompt: "actual prompt",
      evaluationRoot,
      hostExecutionPath: path.join(directory, "execution.json"),
      execution: {
        id: "test-execution-1",
        runId: "run",
        suiteDigest: "suite",
        baselineRevision: "baseline",
        candidateDigest: "candidate",
        headRevision: "a".repeat(40),
        promptDigest: sha256("different prompt"),
        role: "candidate",
        sourceBindingDigest: "b".repeat(64),
        attempt: 1
      }
    }),
    /prompt does not match the signed execution binding/
  );
});

test("Agy adapter uses argv without shell injection and validates structured output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-provider-"));
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-provider-fail-"));
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-doctor-"));
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "sbw-deliberation-cache-"));
  const fake = await executable(directory, "provider", "printf 'SBW_TEST_MARKER\\n'");
  const config = {
    schemaVersion: 3,
    terminology: {
      modelBrands: ["Fake"],
      transportCommand: fake,
      transportModelBrands: ["Fake"],
      transportIsModelBrand: false
    },
    probeMarker: "SBW_TEST_MARKER",
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

  await writeFile(fake, "#!/bin/sh\nprintf 'SBW_TEST_MARKER\\n'\n# changed binary identity\n", { mode: 0o700 });
  await chmod(fake, 0o700);
  const third = await probeDeliberationRoster(options);
  assert.equal(third.activeParticipants.length, 1);
  assert.equal(third.cache.status, "stored");
});

test("deliberation roster rejects model-brand and transport terminology drift", async () => {
  const canonical = await loadDeliberationRoster();
  assert.equal(validateDeliberationRosterConfig(canonical), canonical);

  const brandDrift = structuredClone(canonical);
  brandDrift.terminology.modelBrands = brandDrift.terminology.modelBrands.filter((brand) => brand !== "Kiro");
  assert.throws(
    () => validateDeliberationRosterConfig(brandDrift),
    /model brands do not match canonical terminology/
  );

  const transportDrift = structuredClone(canonical);
  transportDrift.terminology.transportModelBrands = ["Gemini", "Claude"];
  assert.throws(
    () => validateDeliberationRosterConfig(transportDrift),
    /transport brands do not match canonical terminology/
  );

  const falseBrand = structuredClone(canonical);
  falseBrand.terminology.transportIsModelBrand = true;
  assert.throws(() => validateDeliberationRosterConfig(falseBrand), /terminology is invalid/);
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
  const effortCommand = await executable(
    await mkdtemp(path.join(os.tmpdir(), "sbw-effort-")),
    "provider",
    "printf 'SBW_TEST_MARKER\\n'"
  );
  const config = {
    schemaVersion: 3,
    terminology: {
      modelBrands: ["Fake"],
      transportCommand: effortCommand,
      transportModelBrands: ["Fake"],
      transportIsModelBrand: false
    },
    reasoningEffort: {
      default: "auto",
      allowed: ["medium", "high"],
      modeDefaults: { verified: "medium", deep: "high" }
    },
    arbiterPriority: [],
    probeMarker: "SBW_TEST_MARKER",
    probeTimeoutSeconds: 5,
    rosterCacheHours: 24,
    maxParticipants: 4,
    providers: [
      {
        id: "fake",
        command: effortCommand,
        probe: "text",
        external: true,
        effortTransport: "model-variant",
        models: [
          { model: "flash-medium", brand: "Fake", role: "fast", capabilityRank: 1, reasoningEffort: "medium" },
          { model: "flash-high", brand: "Fake", role: "deep", capabilityRank: 1, reasoningEffort: "high" }
        ]
      }
    ]
  };
  assert.equal(resolveReasoningEffort({ mode: "verified" }, config), "medium");
  assert.equal(resolveReasoningEffort({ mode: "deep" }, config), "high");
  const roster = await probeDeliberationRoster({
    config,
    stateRoot: await mkdtemp(path.join(os.tmpdir(), "sbw-effort-state-")),
    allowExternalProviders: true,
    sanitized: true,
    reasoningEffort: "medium"
  });
  assert.equal(roster.reasoningEffort, "medium");
  assert.deepEqual(roster.activeParticipants.map((item) => item.model), ["flash-medium"]);
  assert.deepEqual(roster.standbyParticipants.map((item) => item.model), ["flash-high"]);
});
